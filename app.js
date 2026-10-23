import { checkOffer } from "./checks.js";

const API = "https://api-core.livingsocial.com/ls_agent_api";
const MAX_INTERESTS = 5;
const SEARCH_LIMIT = 12; // per interest
const FULL_READS_PER_INTEREST = 4; // candidates we read in full
const FX_FALLBACK = 84; // INR per USD if the rate lookup fails

const $ = (s) => document.querySelector(s);
const form = $("#plan-form");
const statusEl = $("#status");
const summaryEl = $("#summary");
const planEl = $("#plan");
const benchEl = $("#bench");
const benchList = $("#bench-list");
const tpl = $("#offer-card");

let fxRate = null;

// ---------- API ----------
async function api(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "" && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 429) {
    let wait = 5;
    try { wait = (await res.json()).details?.retryAfterSeconds || wait; } catch {}
    setStatus(`Rate limited by LivingSocial. Waiting ${wait}s…`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return api(path, params);
  }
  if (!res.ok) throw new Error(`${res.status} on ${path}`);
  return res.json();
}

const search = (q, city, maxPrice) => api("/offers/search", { q, city, maxPrice, limit: SEARCH_LIMIT });
const fullOffer = async (permalink, city) => (await api(`/offers/${encodeURIComponent(permalink)}`, { city })).offer;

async function loadFx() {
  fxRate = FX_FALLBACK;
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
const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

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

// Pick the best-fitting option: fewest problems first, then the merchant's own
// ordering (the headline option is listed first). Add-ons like drinks and candy
// lose to real options so a movie offer doesn't become "one large candy".
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

// Distribute picks over trip days, honouring day-of-week rules and budget.
function schedule(cands, trip) {
  const days = [];
  for (let d = new Date(trip.start); d <= trip.end; d.setDate(d.getDate() + 1)) days.push({ date: new Date(d), picks: [] });
  const shown = days.slice(0, 10);
  let spent = 0;
  const used = new Set();
  const interests = [...new Set(cands.map((c) => c.interest))];
  let rr = 0; // round-robin pointer so each day starts on a different interest

  const fitsDay = (c, date) => {
    const r = c.result.dayRules;
    return !(r.validDays && !r.validDays.has(date.getDay()));
  };
  const usable = (c, day) => !used.has(c.offer.id) && c.result.status !== "bad" && fitsDay(c, day.date) && spent + c.result.price.total <= trip.budgetUsd;
  const take = (c, day) => { day.picks.push(c); used.add(c.offer.id); spent += c.result.price.total; };

  for (const day of shown) {
    // Pass 1: one pick per interest, rotating the starting interest each day.
    for (let k = 0; k < interests.length && day.picks.length < trip.pace; k++) {
      const interest = interests[(rr + k) % interests.length];
      const c = cands.find((x) => x.interest === interest && usable(x, day));
      if (c) take(c, day);
    }
    rr++;
    // Pass 2: fill remaining slots with whatever fits.
    for (const c of cands) {
      if (day.picks.length >= trip.pace) break;
      if (usable(c, day)) take(c, day);
    }
  }
  const bench = cands.filter((c) => !used.has(c.offer.id));
  return { days: shown, hiddenDays: days.length - shown.length, spent, bench };
}

// ---------- rendering ----------
function renderCard(c, trip) {
  const node = tpl.content.cloneNode(true);
  const { offer, option, result } = c;
  const img = node.querySelector(".thumb");
  img.src = offer.primaryImageUrl || offer.imageUrls?.[0] || "";
  if (!img.src) img.remove();
  const badge = node.querySelector(".badge");
  badge.className = `badge ${result.status}`;
  badge.textContent = result.status === "ok" ? "Fits your trip" : result.status === "warn" ? "Check before buying" : "Doesn't fit";
  node.querySelector(".cat").textContent = (offer.categories || []).slice(0, 2).join(" · ");
  node.querySelector(".title").textContent = offer.experienceTitle || offer.title;
  node.querySelector(".merchant").textContent = [offer.merchant, offer.locations?.[0]?.city].filter(Boolean).join(" · ");
  node.querySelector(".option").textContent = `Option: ${option.title}`;
  const p = result.price;
  const orig = money(option.originalPrice);
  let priceText = `${usd(p.total)} <span class="inr">(${inr(p.total)})</span> for ${trip.group}`;
  if (p.units > 1) priceText += ` — ${p.units} × ${usd(p.unit)}`;
  if (orig && orig > p.unit) priceText += ` <span class="inr">· was ${usd(orig)} each</span>`;
  const promo = money(option.promoPrice);
  if (option.promoCode && promo != null) priceText += `<span class="promo">Possibly ${usd(promo)} each with code ${option.promoCode} — Groupon decides at checkout.</span>`;
  node.querySelector(".price").innerHTML = priceText;
  const ul = node.querySelector(".checks");
  for (const f of result.findings) {
    const li = document.createElement("li");
    li.className = f.level;
    li.textContent = f.text;
    ul.appendChild(li);
  }
  const buy = node.querySelector(".buy");
  buy.href = option.buyUrl;
  buy.textContent = p.units > 1 ? `Buy on Groupon (set quantity to ${p.units})` : "Buy on Groupon";
  node.querySelector(".page").href = offer.offerUrl;
  return node;
}

function renderPlan(plan, trip, picks) {
  planEl.innerHTML = "";
  for (const day of plan.days) {
    const sec = document.createElement("section");
    sec.className = "day";
    sec.innerHTML = `<h2>${fmtDay(day.date)}</h2><p class="sub">${day.picks.length ? day.picks.map((c) => c.interest).join(" · ") : ""}</p>`;
    if (!day.picks.length) sec.insertAdjacentHTML("beforeend", `<p class="empty">Nothing fit this day within budget and the fine print. Try more interests or a bigger budget.</p>`);
    for (const c of day.picks) sec.appendChild(renderCard(c, trip));
    planEl.appendChild(sec);
  }
  if (plan.hiddenDays > 0) planEl.insertAdjacentHTML("beforeend", `<p class="muted">Showing the first 10 days of a ${plan.days.length + plan.hiddenDays}-day trip.</p>`);

  const total = plan.spent;
  const count = plan.days.reduce((n, d) => n + d.picks.length, 0);
  const warns = plan.days.reduce((n, d) => n + d.picks.filter((c) => c.result.status === "warn").length, 0);
  const left = trip.budgetUsd - total;
  summaryEl.classList.remove("hidden");
  summaryEl.innerHTML = `
    <div class="stat">Deals in plan<b>${count}</b></div>
    <div class="stat">Total on Groupon<b>${usd(total)}</b>${inr(total)}</div>
    <div class="stat">Budget left<b>${trip.currency === "INR" ? inr(left) : usd(left)}</b>of ${trip.currency === "INR" ? inr(trip.budgetUsd) : usd(trip.budgetUsd)}</div>
    <div class="stat">Needs a look<b>${warns}</b>fine-print warnings</div>
    <div class="share">
      <span>Share this plan with whoever pays:</span>
      <input type="text" readonly value="${shareUrl(trip, picks)}" />
      <button type="button" class="secondary" id="copy">Copy link</button>
    </div>`;
  $("#copy").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText($(".share input").value);
    e.target.textContent = "Copied";
  });

  benchList.innerHTML = "";
  if (plan.bench.length) {
    benchEl.classList.remove("hidden");
    for (const c of plan.bench.slice(0, 12)) benchList.appendChild(renderCard(c, trip));
  } else benchEl.classList.add("hidden");
}

// Plan state travels in the URL hash so a US friend can open the same plan and pay.
function shareUrl(trip, picks) {
  const state = {
    v: 1,
    city: trip.city,
    start: trip.start.toISOString().slice(0, 10),
    end: trip.end.toISOString().slice(0, 10),
    group: trip.group,
    budget: trip.budget,
    currency: trip.currency,
    pace: trip.pace,
    interests: trip.interests,
    picks: picks.map((c) => ({ p: c.offer.permalink, o: c.option.id, i: c.interest, d: c.dayIndex })),
  };
  const u = new URL(location.href);
  u.hash = "plan=" + btoa(unescape(encodeURIComponent(JSON.stringify(state))));
  return u.toString();
}

function readShared() {
  const m = location.hash.match(/^#plan=(.+)$/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(m[1])))); } catch { return null; }
}

// ---------- flows ----------
async function buildPlan() {
  const trip = readForm();
  if (trip.end < trip.start) { setStatus("The end date is before the start date."); return; }
  if (!trip.interests.length) { setStatus("Add at least one interest."); return; }
  $("#go").disabled = true;
  history.replaceState(null, "", location.pathname);
  try {
    const cands = [];
    const seen = new Set();
    for (const interest of trip.interests) {
      setStatus(`Searching ${trip.city} for "${interest}"…`);
      const res = await search(interest, trip.city, Math.ceil(trip.budgetUsd));
      const picks = res.offers.filter((o) => o.buyable && !seen.has(o.id)).slice(0, FULL_READS_PER_INTEREST);
      for (const s of picks) {
        seen.add(s.id);
        setStatus(`Reading the fine print: ${s.title.slice(0, 60)}…`);
        try {
          const offer = await fullOffer(s.permalink, trip.city);
          const best = bestOption(offer, trip);
          if (best) cands.push({ offer, option: best.option, result: best.result, interest });
        } catch (e) {
          console.warn("offer read failed", s.permalink, e);
        }
      }
    }
    if (!cands.length) { setStatus(`No buyable offers found in ${trip.city} for those interests.`); return; }
    // Keep Groupon's own ranking within each interest; problems sort to the back.
    const rank = (c) => (c.result.status === "bad" ? 2 : c.result.status === "warn" ? 1 : 0);
    cands.sort((a, b) => rank(a) - rank(b));
    const plan = schedule(cands, trip);
    const picks = [];
    plan.days.forEach((d, i) => d.picks.forEach((c) => { c.dayIndex = i; picks.push(c); }));
    renderPlan(plan, trip, picks);
    setStatus(`Checked ${cands.length} offers as of ${new Date().toLocaleTimeString()}.`);
    summaryEl.scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    console.error(e);
    setStatus(`Something failed: ${e.message}. LivingSocial may be busy; try again in a minute.`);
  } finally {
    $("#go").disabled = false;
  }
}

async function openShared(state) {
  form.city.value = state.city; form.start.value = state.start; form.end.value = state.end;
  form.group.value = state.group; form.budget.value = state.budget; form.currency.value = state.currency;
  form.pace.value = state.pace; form.interests.value = state.interests.join(", ");
  const trip = readForm();
  setStatus("Opening a shared plan and re-checking prices…");
  const days = [];
  for (let d = new Date(trip.start); d <= trip.end; d.setDate(d.getDate() + 1)) days.push({ date: new Date(d), picks: [] });
  const picks = [];
  let spent = 0;
  for (const p of state.picks) {
    try {
      const offer = await fullOffer(p.p, trip.city);
      const option = (offer.options || []).find((o) => o.id === p.o) || offer.options?.[0];
      if (!option) continue;
      const result = checkOffer(offer, option, trip);
      const c = { offer, option, result, interest: p.i, dayIndex: p.d };
      if (days[p.d]) days[p.d].picks.push(c);
      picks.push(c);
      spent += result.price?.total || 0;
    } catch (e) { console.warn("shared offer missing", p.p, e); }
  }
  renderPlan({ days: days.slice(0, 10), hiddenDays: Math.max(days.length - 10, 0), spent, bench: [] }, trip, picks);
  setStatus(`Shared plan re-checked at ${new Date().toLocaleTimeString()}. Prices are live, not the ones the planner saw.`);
}

// ---------- init ----------
(async function init() {
  const today = new Date();
  const start = new Date(today); start.setDate(start.getDate() + 21);
  const end = new Date(start); end.setDate(end.getDate() + 2);
  form.start.value = start.toISOString().slice(0, 10);
  form.end.value = end.toISOString().slice(0, 10);
  form.city.value = "New York";
  form.addEventListener("submit", (e) => { e.preventDefault(); buildPlan(); });
  await loadFx();
  const shared = readShared();
  if (shared) openShared(shared);
})();
