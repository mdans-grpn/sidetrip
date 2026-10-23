import { checkOffer } from "./checks.js";

const API = "https://api-core.livingsocial.com/ls_agent_api";
const MCP_URL = "https://api-core.livingsocial.com/mcp_customers/mcp";
const MAX_INTERESTS = 5;
const SEARCH_LIMIT = 12; // per interest
const FULL_READS_PER_INTEREST = 5; // candidates we read in full
const READ_CONCURRENCY = 6; // the API allows 600 offer reads a minute per client
const CACHE_TTL_MS = 30 * 60 * 1000;
const FX_FALLBACK = 84; // INR per USD if the rate lookup fails
const MAX_DAYS_SHOWN = 10;

const $ = (s) => document.querySelector(s);
const form = $("#plan-form");
const statusEl = $("#status");
const summaryEl = $("#summary");
const planEl = $("#plan");
const benchEl = $("#bench");
const benchList = $("#bench-list");
const tpl = $("#offer-card");

let fxRate = FX_FALLBACK;
let current = null; // { trip, plan, picks } of the plan on screen

// ---------- API ----------
async function api(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "" && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (res.status === 429) {
    let wait = 5;
    try { wait = (await res.json()).details?.retryAfterSeconds || wait; } catch {}
    setStatus(`LivingSocial asked us to slow down. Waiting ${wait}s…`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return api(path, params);
  }
  if (!res.ok) throw new Error(`${res.status} on ${path}`);
  return res.json();
}

const search = (q, city, maxPrice) => api("/offers/search", { q, city, maxPrice, limit: SEARCH_LIMIT });

async function fullOffer(permalink, city) {
  const key = `sidetrip:offer:${permalink}`;
  try {
    const hit = JSON.parse(sessionStorage.getItem(key) || "null");
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.offer;
  } catch {}
  const { offer } = await api(`/offers/${encodeURIComponent(permalink)}`, { city });
  try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), offer })); } catch {}
  return offer;
}

// Run tasks with limited concurrency, keeping result order.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function loadFx() {
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    if (j?.rates?.INR) fxRate = j.rates.INR;
  } catch (e) {
    console.warn("FX lookup failed, using fallback rate", e);
  }
}

// ---------- helpers ----------
function setStatus(t) { statusEl.textContent = t; }
const usd = (n) => `$${n.toFixed(2)}`;
const inr = (n) => `₹${Math.round(n * fxRate).toLocaleString("en-IN")}`;
const money = (m) => (m ? m.amountMinor / Math.pow(10, m.currencyExponent ?? 2) : null);
const fmtDay = (d) => d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function ageText(iso) {
  if (!iso) return "";
  const h = (Date.now() - new Date(iso)) / 36e5;
  if (h < 1) return "price seen under an hour ago";
  if (h < 48) return `price seen ${Math.round(h)}h ago`;
  return `price seen ${Math.round(h / 24)} days ago`;
}

function haversineMiles(a, b) {
  const R = 3958.8, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const coords = (c) => { const l = c.offer.locations?.find((x) => x.lat && x.lng); return l ? { lat: l.lat, lng: l.lng } : null; };

function readForm() {
  const f = new FormData(form);
  const start = parseDate(f.get("start"));
  const end = parseDate(f.get("end"));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const budget = Number(f.get("budget"));
  const currency = f.get("currency");
  return {
    city: f.get("city").trim(),
    start, end, today,
    group: Number(f.get("group")),
    pace: Number(f.get("pace")),
    budgetUsd: currency === "INR" ? budget / fxRate : budget,
    currency, budget,
    interests: f.get("interests").split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_INTERESTS),
  };
}

function fillForm(s) {
  if (s.city) form.city.value = s.city;
  if (s.start) form.start.value = s.start;
  if (s.end) form.end.value = s.end;
  if (s.group) form.group.value = s.group;
  if (s.budget) form.budget.value = s.budget;
  if (s.currency) form.currency.value = s.currency;
  if (s.pace) form.pace.value = s.pace;
  if (s.interests) form.interests.value = Array.isArray(s.interests) ? s.interests.join(", ") : s.interests;
}

// ---------- choosing and scheduling ----------
// Best-fitting option: fewest problems first, then the merchant's own ordering
// (the headline option is listed first). Add-ons like drinks and candy lose to
// real options so a movie offer doesn't become "one large candy".
const ADDON_RE = /\b(candy|drink|soda|popcorn|snack|add-?on|upgrade|extra|gift card)\b/i;
function bestOption(offer, trip) {
  let best = null;
  const options = (offer.options || []).filter((o) => o.buyUrl && o.price);
  const hasMain = options.some((o) => !ADDON_RE.test(o.title || ""));
  options.forEach((option, i) => {
    const result = checkOffer(offer, option, trip);
    if (!result.price) return;
    const addon = hasMain && ADDON_RE.test(option.title || "") ? 1 : 0;
    const bad = result.status === "bad" ? 2 : result.status === "warn" ? 1 : 0;
    const rank = bad * 1000 + addon * 100 + i;
    if (!best || rank < best.rank) best = { option, result, rank };
  });
  return best;
}

function tripDays(trip) {
  const days = [];
  for (let d = new Date(trip.start); d <= trip.end; d.setDate(d.getDate() + 1)) days.push({ date: new Date(d), picks: [] });
  return days;
}

// Lay candidates over the days: one interest at a time, only on days the fine
// print allows, within budget, with a soft per-day share so one pricey deal
// doesn't leave the last day empty. Then order each day's stops by distance.
function schedule(cands, trip) {
  const all = tripDays(trip);
  const shown = all.slice(0, MAX_DAYS_SHOWN);
  let spent = 0;
  const used = new Set();
  const interests = [...new Set(cands.map((c) => c.interest))];
  const dayShare = trip.budgetUsd / Math.max(shown.length, 1);
  let rr = 0;

  const dayOk = (c, date, strict) => {
    const r = c.result.dayRules, dow = date.getDay();
    if (r.validDays && !r.validDays.has(dow)) return false;
    if (strict && r.excludedDays.has(dow)) return false;
    return true;
  };
  const usable = (c, day, strict) => !used.has(c.offer.id) && c.result.status !== "bad" && dayOk(c, day.date, strict) && spent + c.result.price.total <= trip.budgetUsd;
  const take = (c, day) => { day.picks.push(c); used.add(c.offer.id); spent += c.result.price.total; };

  for (const day of shown) {
    for (let k = 0; k < interests.length && day.picks.length < trip.pace; k++) {
      const interest = interests[(rr + k) % interests.length];
      const today = day.picks.reduce((n, x) => n + x.result.price.total, 0);
      const c = cands.find((x) => x.interest === interest && usable(x, day, true) && today + x.result.price.total <= dayShare * 1.25)
        || cands.find((x) => x.interest === interest && usable(x, day, true));
      if (c) take(c, day);
    }
    rr++;
    for (const c of cands) { if (day.picks.length >= trip.pace) break; if (usable(c, day, false)) take(c, day); }
  }

  // Order stops within a day by nearest neighbour and note the walking spread.
  for (const day of shown) {
    const withPos = day.picks.filter(coords);
    if (withPos.length >= 2) {
      const ordered = [withPos.shift()];
      while (withPos.length) {
        const last = coords(ordered[ordered.length - 1]);
        withPos.sort((a, b) => haversineMiles(last, coords(a)) - haversineMiles(last, coords(b)));
        ordered.push(withPos.shift());
      }
      const rest = day.picks.filter((c) => !coords(c));
      day.picks = [...ordered, ...rest];
      let miles = 0;
      for (let i = 1; i < ordered.length; i++) miles += haversineMiles(coords(ordered[i - 1]), coords(ordered[i]));
      day.miles = miles;
    }
  }

  const bench = cands.filter((c) => !used.has(c.offer.id));
  return { days: shown, hiddenDays: all.length - shown.length, spent, bench };
}

// Why a candidate was set aside, for grouping the bench.
function benchReason(c, trip) {
  const f = c.result.findings;
  const bad = f.find((x) => x.level === "bad");
  if (bad) {
    if (/None of your trip days/.test(bad.text)) return "Not valid on your days";
    if (/notice/.test(bad.text)) return "Needs more notice than you have";
    if (/expires|Sale has ended/.test(bad.text)) return "Expires before or during your trip";
    if (/left/.test(bad.text)) return "Not enough stock";
    return "Doesn't fit";
  }
  if (c.result.price.total > trip.budgetUsd) return "Over your whole budget";
  return "Didn't fit the budget or the day";
}

// ---------- rendering ----------
const FP_HIGHLIGHT = /(valid (?:only )?(?:on )?[a-z]+(?:day)?s?\s*(?:-|–|through|thru|to)\s*[a-z]+(?:day)?s?(?: only)?|not valid[^.;]*|\d+[\s-]*(?:hour|day|week)s?['’]?\s*(?:advance\s+)?notice|limit \d+ per person|appointment(?:\/reservation)? required|reservation required|new (?:customers|clients) only|\b(?:18|21)\+|must be used by the same person|not valid until[^.;]*|weekends? only|weekdays only)/gi;

function renderFinePrint(offer) {
  const parts = [...(offer.finePrint || []), ...(offer.fees || [])];
  if (!parts.length) return `<p class="none">The merchant published no fine print for this offer. "Unknown" is not the same as "no conditions".</p>`;
  return parts.map((p) => `<p>${esc(p).replace(FP_HIGHLIGHT, (m) => `<mark>${m}</mark>`)}</p>`).join("");
}

function renderCard(c, trip) {
  const node = tpl.content.cloneNode(true);
  const { offer, option, result } = c;
  const img = node.querySelector(".thumb");
  const src = offer.primaryImageUrl || offer.imageUrls?.[0] || "";
  if (src) img.src = src; else img.remove();
  const badge = node.querySelector(".badge");
  badge.className = `badge ${result.status}`;
  badge.textContent = result.status === "ok" ? "Fits your trip" : result.status === "warn" ? "Check before buying" : "Doesn't fit";
  node.querySelector(".cat").textContent = (offer.categories || []).slice(0, 2).join(" · ");
  node.querySelector(".age").textContent = ageText(offer.observedAt);
  node.querySelector(".title").textContent = offer.experienceTitle || offer.title;
  node.querySelector(".merchant").textContent = [offer.merchant, offer.locations?.[0]?.name !== offer.merchant ? offer.locations?.[0]?.name : null, offer.locations?.[0]?.city].filter(Boolean).join(" · ");
  node.querySelector(".option").textContent = `Option: ${option.title}`;
  const p = result.price;
  const orig = money(option.originalPrice);
  const covers = p.party || option.unitBasis === "person" ? `for ${trip.group}` : `per voucher`;
  let priceText = `${usd(p.total)} <span class="inr">(${inr(p.total)})</span> <span class="inr">${covers}</span>`;
  if (p.units > 1) priceText += ` <span class="inr">— ${p.units} × ${usd(p.unit)}</span>`;
  if (orig && orig > p.unit) priceText += ` <span class="inr">· was ${usd(orig)} each</span>`;
  const promo = money(option.promoPrice);
  if (option.promoCode && promo != null) {
    const ends = option.promoEndsAt ? ` until ${new Date(option.promoEndsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";
    priceText += `<span class="promo">Possibly ${usd(promo)} each with code ${esc(option.promoCode)}${ends} — Groupon decides at checkout.</span>`;
  }
  node.querySelector(".price").innerHTML = priceText;
  const ul = node.querySelector(".checks");
  for (const f of result.findings) {
    const li = document.createElement("li");
    li.className = f.level;
    li.textContent = f.text;
    ul.appendChild(li);
  }
  node.querySelector(".fp-body").innerHTML = renderFinePrint(offer);
  const buy = node.querySelector(".buy");
  buy.href = option.buyUrl;
  buy.textContent = p.units > 1 ? `Buy on Groupon (set quantity to ${p.units})` : "Buy on Groupon";
  node.querySelector(".page").href = offer.offerUrl;
  return node;
}

function renderPlan(plan, trip, picks) {
  current = { trip, plan, picks };
  planEl.innerHTML = "";
  for (const day of plan.days) {
    const sec = document.createElement("section");
    sec.className = "day";
    const spread = day.miles != null ? `<span>≈${day.miles.toFixed(1)} mi between stops</span>` : "";
    const cost = day.picks.length ? `<span>${usd(day.picks.reduce((n, c) => n + c.result.price.total, 0))} today</span>` : "";
    sec.innerHTML = `<h2>${fmtDay(day.date)}</h2><p class="sub"><span>${day.picks.map((c) => esc(c.interest)).join(" · ")}</span>${cost}${spread}</p>`;
    if (!day.picks.length) sec.insertAdjacentHTML("beforeend", `<p class="empty">Nothing fit this day within budget and the fine print. Try more interests or a bigger budget.</p>`);
    for (const c of day.picks) sec.appendChild(renderCard(c, trip));
    planEl.appendChild(sec);
  }
  if (plan.hiddenDays > 0) planEl.insertAdjacentHTML("beforeend", `<p class="muted">Showing the first ${MAX_DAYS_SHOWN} days of a ${plan.days.length + plan.hiddenDays}-day trip.</p>`);

  const total = plan.spent;
  const count = picks.length;
  const warns = picks.filter((c) => c.result.status === "warn").length;
  const clauses = picks.reduce((n, c) => n + c.result.findings.length, 0);
  const left = trip.budgetUsd - total;
  const fmtBudget = (n) => (trip.currency === "INR" ? inr(n) : usd(n));
  summaryEl.classList.remove("hidden");
  summaryEl.innerHTML = `
    <div class="stat">Deals in plan<b>${count}</b>${clauses} checks run</div>
    <div class="stat">Total on Groupon<b>${usd(total)}</b>${inr(total)}</div>
    <div class="stat">Budget left<b>${fmtBudget(left)}</b>of ${fmtBudget(trip.budgetUsd)}</div>
    <div class="stat">Needs a look<b>${warns}</b>fine-print warnings</div>
    <div class="tools">
      <input type="text" readonly value="${esc(shareUrl(trip, picks))}" aria-label="Share link" />
      <button type="button" class="secondary" id="copy">Copy plan link</button>
      <button type="button" class="secondary" id="ics">Add to calendar</button>
      <button type="button" class="secondary" id="agent">Copy prompt for your AI</button>
    </div>
    <p class="note">Share the link with whoever pays: they see the same plan with prices re-checked live. The calendar file carries each deal's fine print and buy link. The AI prompt hands this plan to any assistant connected to LivingSocial's MCP server, which can build one cart for all of it.</p>`;
  $("#copy").addEventListener("click", (e) => copyText($(".tools input").value, e.target, "Copied"));
  $("#ics").addEventListener("click", () => downloadIcs(trip, plan));
  $("#agent").addEventListener("click", (e) => copyText(agentPrompt(trip, picks), e.target, "Prompt copied"));

  benchList.innerHTML = "";
  if (plan.bench.length) {
    benchEl.classList.remove("hidden");
    const groups = new Map();
    for (const c of plan.bench) { const r = benchReason(c, trip); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); }
    for (const [reason, list] of groups) {
      const g = document.createElement("div");
      g.className = "reason-group";
      g.innerHTML = `<h3>${esc(reason)} · ${list.length}</h3>`;
      for (const c of list.slice(0, 6)) g.appendChild(renderCard(c, trip));
      benchList.appendChild(g);
    }
  } else benchEl.classList.add("hidden");
}

async function copyText(text, btn, done) {
  try { await navigator.clipboard.writeText(text); btn.textContent = done; }
  catch { window.prompt("Copy this:", text); }
}

// ---------- share, calendar, agent handoff ----------
// Plan state travels in the URL hash so a US friend can open the same plan and pay.
function shareUrl(trip, picks) {
  const state = {
    v: 1, city: trip.city, start: isoDay(trip.start), end: isoDay(trip.end), group: trip.group,
    budget: trip.budget, currency: trip.currency, pace: trip.pace, interests: trip.interests,
    picks: picks.map((c) => ({ p: c.offer.permalink, o: c.option.id, i: c.interest, d: c.dayIndex })),
  };
  const u = new URL(location.href);
  u.search = "";
  u.hash = "plan=" + btoa(unescape(encodeURIComponent(JSON.stringify(state))));
  return u.toString();
}

function readShared() {
  const m = location.hash.match(/^#plan=(.+)$/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(m[1])))); } catch { return null; }
}

function downloadIcs(trip, plan) {
  const fold = (s) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => "\\" + c);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SideTrip//LivingSocial plan//EN", "CALSCALE:GREGORIAN"];
  plan.days.forEach((day) => {
    const d0 = isoDay(day.date).replace(/-/g, "");
    const next = new Date(day.date); next.setDate(next.getDate() + 1);
    const d1 = isoDay(next).replace(/-/g, "");
    day.picks.forEach((c, i) => {
      const loc = c.offer.locations?.[0];
      const fp = [...(c.offer.finePrint || [])].join(" ");
      const desc = [`Option: ${c.option.title}`, `${usd(c.result.price.total)} for ${trip.group}${c.result.price.units > 1 ? ` (${c.result.price.units} vouchers)` : ""}`,
        ...c.result.findings.map((f) => `${f.level === "ok" ? "✓" : f.level === "warn" ? "!" : f.level === "bad" ? "✕" : "i"} ${f.text}`),
        fp ? `Fine print: ${fp}` : "", `Buy: ${c.option.buyUrl}`, `Offer: ${c.offer.offerUrl}`, "A purchase does not reserve a date or time."].filter(Boolean).join("\n");
      lines.push("BEGIN:VEVENT", `UID:sidetrip-${c.offer.id}-${d0}-${i}@sidetrip`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d0}`, `DTEND;VALUE=DATE:${d1}`,
        `SUMMARY:${fold(c.offer.experienceTitle || c.offer.title)}`, `DESCRIPTION:${fold(desc)}`,
        loc ? `LOCATION:${fold([loc.name, loc.street, loc.city, loc.state].filter(Boolean).join(", "))}` : "", `URL:${c.offer.offerUrl}`, "END:VEVENT");
    });
  });
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.filter(Boolean).join("\r\n")], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sidetrip-${trip.city.toLowerCase().replace(/[^a-z]+/g, "-")}-${isoDay(trip.start)}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// A prompt that hands the plan to an assistant connected to LivingSocial's MCP
// server. The assistant can put every item in one cart, which a browser can't.
function agentPrompt(trip, picks) {
  const items = picks.map((c, i) => `${i + 1}. ${c.offer.experienceTitle || c.offer.title} — option "${c.option.title}" — offerId ${c.offer.id}, optionId ${c.option.id}, quantity ${c.result.price.units}`);
  return [
    `I planned a trip to ${trip.city} for ${trip.group} people, ${isoDay(trip.start)} to ${isoDay(trip.end)}, with SideTrip (${shareUrl(trip, picks)}).`,
    `Use LivingSocial's MCP server (${MCP_URL}, no sign-in; the first search_offers or get_offer call returns a journey token that you must pass on every later call).`,
    `Put these in ONE cart with add_to_cart, read it back with get_cart, and give me the cartUrl. Do not prepare a checkout and do not pay; I'll review and pay on Groupon myself.`,
    ``, ...items, ``,
    `Before adding each one, re-read it with get_offer and tell me if the price, stock or fine print changed from what I list here. A purchase does not reserve a date or time.`,
  ].join("\n");
}

// ---------- flows ----------
function showSkeletons(n) {
  planEl.innerHTML = Array.from({ length: n }, () => `<div class="skel"></div>`).join("");
}

async function buildPlan() {
  const trip = readForm();
  if (trip.end < trip.start) { setStatus("The end date is before the start date."); return; }
  if (!trip.interests.length) { setStatus("Add at least one interest."); return; }
  $("#go").disabled = true;
  history.replaceState(null, "", location.pathname);
  summaryEl.classList.add("hidden"); benchEl.classList.add("hidden");
  showSkeletons(Math.min(trip.pace * Math.min(tripDays(trip).length, 3), 6));
  const t0 = performance.now();
  try {
    setStatus(`Searching ${trip.city} for ${trip.interests.map((i) => `"${i}"`).join(", ")}…`);
    const searches = await pool(trip.interests, 3, (q) => search(q, trip.city, Math.ceil(trip.budgetUsd)).catch((e) => { console.warn("search failed", q, e); return { offers: [] }; }));
    const seen = new Set();
    const todo = [];
    searches.forEach((res, i) => {
      for (const s of res.offers.filter((o) => o.buyable && !seen.has(o.id)).slice(0, FULL_READS_PER_INTEREST)) { seen.add(s.id); todo.push({ s, interest: trip.interests[i] }); }
    });
    if (!todo.length) { planEl.innerHTML = ""; setStatus(`No buyable offers found in ${trip.city} for those interests.`); return; }
    let done = 0;
    setStatus(`Reading the fine print on ${todo.length} offers…`);
    const results = await pool(todo, READ_CONCURRENCY, async ({ s, interest }) => {
      try {
        const offer = await fullOffer(s.permalink, trip.city);
        const best = bestOption(offer, trip);
        return best ? { offer, option: best.option, result: best.result, interest } : null;
      } catch (e) { console.warn("offer read failed", s.permalink, e); return null; }
      finally { done++; setStatus(`Reading the fine print… ${done}/${todo.length}`); }
    });
    const cands = results.filter(Boolean);
    if (!cands.length) { planEl.innerHTML = ""; setStatus("Offers were found but none could be read. Try again in a minute."); return; }
    const rank = (c) => (c.result.status === "bad" ? 2 : c.result.status === "warn" ? 1 : 0);
    cands.sort((a, b) => rank(a) - rank(b));
    const plan = schedule(cands, trip);
    const picks = [];
    plan.days.forEach((d, i) => d.picks.forEach((c) => { c.dayIndex = i; picks.push(c); }));
    renderPlan(plan, trip, picks);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`Checked ${cands.length} offers in ${secs}s, as of ${new Date().toLocaleTimeString()}.`);
    summaryEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    console.error(e);
    planEl.innerHTML = "";
    setStatus(`Something failed: ${e.message}. LivingSocial may be busy; try again in a minute.`);
  } finally {
    $("#go").disabled = false;
  }
}

async function openShared(state) {
  fillForm(state);
  const trip = readForm();
  setStatus("Opening a shared plan and re-checking prices…");
  showSkeletons(Math.min(state.picks.length, 6));
  const days = tripDays(trip);
  const results = await pool(state.picks, READ_CONCURRENCY, async (p) => {
    try {
      const offer = await fullOffer(p.p, trip.city);
      const option = (offer.options || []).find((o) => o.id === p.o) || offer.options?.[0];
      if (!option) return null;
      return { offer, option, result: checkOffer(offer, option, trip), interest: p.i, dayIndex: p.d };
    } catch (e) { console.warn("shared offer missing", p.p, e); return null; }
  });
  const picks = results.filter(Boolean);
  let spent = 0;
  for (const c of picks) { if (days[c.dayIndex]) days[c.dayIndex].picks.push(c); spent += c.result.price?.total || 0; }
  renderPlan({ days: days.slice(0, MAX_DAYS_SHOWN), hiddenDays: Math.max(days.length - MAX_DAYS_SHOWN, 0), spent, bench: [] }, trip, picks);
  const missing = state.picks.length - picks.length;
  setStatus(`Shared plan re-checked at ${new Date().toLocaleTimeString()}. Prices are live, not the ones the planner saw.${missing ? ` ${missing} offer${missing > 1 ? "s are" : " is"} no longer available.` : ""}`);
}

// Presets: one click to a full plan. Dates are relative to today.
function presets() {
  const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return isoDay(x); };
  return {
    parents: { city: "New York", start: d(21), end: d(24), group: 2, budget: 40000, currency: "INR", pace: 2, interests: "sightseeing tour, dinner, massage, museum" },
    gift: { city: "Chicago", start: d(14), end: d(15), group: 1, budget: 150, currency: "USD", pace: 2, interests: "massage, facial, brunch" },
    vegas: { city: "Las Vegas", start: d(28), end: d(30), group: 4, budget: 600, currency: "USD", pace: 2, interests: "show tickets, dinner, things to do" },
  };
}

// ---------- init ----------
(function init() {
  const today = new Date();
  const start = new Date(today); start.setDate(start.getDate() + 21);
  const end = new Date(start); end.setDate(end.getDate() + 2);
  form.start.value = isoDay(start);
  form.end.value = isoDay(end);
  form.city.value = "New York";
  form.addEventListener("submit", (e) => { e.preventDefault(); buildPlan(); });
  document.querySelectorAll(".chip[data-preset]").forEach((b) => b.addEventListener("click", () => { fillForm(presets()[b.dataset.preset]); buildPlan(); }));

  // Agents and deep links: every input is a query parameter; run=1 builds at once.
  const q = new URLSearchParams(location.search);
  if ([...q.keys()].length) fillForm(Object.fromEntries(q));

  loadFx().then(() => {
    const shared = readShared();
    if (shared) openShared(shared);
    else if (q.get("run") === "1") buildPlan();
  });
})();
