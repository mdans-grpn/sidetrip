// Fine-print and fit checks. Pure functions: offer document in, findings out.
// Everything here is heuristic. The UI says so and links to the offer page.

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:[a-z]*)";
const DAY_NC = "(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:[a-z]*)";
const SEP = "\\s*(?:-|–|—|through|thru|to)\\s*";
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

function dayIndex(word) {
  const w = word.toLowerCase().slice(0, 3);
  return DAY_NAMES.findIndex((d) => d.startsWith(w));
}

function rangeDays(a, b) {
  const out = [];
  let i = a;
  for (let n = 0; n < 7; n++) {
    out.push(i);
    if (i === b) break;
    i = (i + 1) % 7;
  }
  return out;
}

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const words = (s) => (s || "").toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight)\b/g, (w) => WORD_NUM[w]);

// Day-of-week rules from fine print and, when given, the option title
// ("MON–THURS Admission", "Valid Tuesday–Sunday", "SAT & HOLIDAYS").
// Returns { validDays: Set|null, excludedDays: Map<dow, {note, timed}>, notes: [] }
export function parseDayRules(finePrint, optionTitle = "") {
  // "6 p.m." would otherwise end a sentence for the "not valid …" scanner.
  const fp = (finePrint || "").toLowerCase().replace(/\b([ap])\.m\./g, "$1m").replace(/\b([ap])\.m\b/g, "$1m");
  const title = (optionTitle || "").toLowerCase();
  const res = { validDays: null, excludedDays: new Map(), notes: [] };
  const setValid = (days, note) => { res.validDays = new Set(days); res.notes.push(note); };
  let m;

  if (/valid (seven|7) days a week|available daily|valid any day|any day of the week/.test(fp + " " + title)) {
    res.notes.push("Valid any day of the week.");
  }

  // "Valid only Mon-Thu", "(Valid Mon -Thu Only)". Not preceded by "not".
  const rangeRe = new RegExp(`(?<!not\\s)valid\\s+(?:only\\s+)?(?:on\\s+)?${DAY}s?${SEP}${DAY}s?`, "g");
  for (const text of [fp, title]) {
    while ((m = rangeRe.exec(text))) {
      const a = dayIndex(m[1]), b = dayIndex(m[2]);
      if (a >= 0 && b >= 0) setValid(rangeDays(a, b), `Valid ${DAY_NAMES[a]} to ${DAY_NAMES[b]} only.`);
    }
  }
  // Option titles state ranges without "valid": "MON–THURS Admission", "Tuesday–Sunday".
  if (!res.validDays && title) {
    const bareRange = new RegExp(`\\b${DAY}s?${SEP}${DAY}s?\\b`);
    if ((m = bareRange.exec(title))) {
      const a = dayIndex(m[1]), b = dayIndex(m[2]);
      if (a >= 0 && b >= 0 && a !== b) setValid(rangeDays(a, b), `Valid ${DAY_NAMES[a]} to ${DAY_NAMES[b]} only (from the option name).`);
    }
  }
  // "Valid Saturdays and Sundays only", title "FRI & SUN", "SAT & HOLIDAYS".
  if (!res.validDays) {
    const pairRe = new RegExp(`(?<!not\\s)(?:valid\\s+(?:only\\s+)?(?:on\\s+)?)?\\b${DAY}s?\\s*(?:,|&|and|or)\\s*${DAY}s?(?:\\s+only)?\\b`, "g");
    for (const [text, needValid] of [[fp, true], [title, false]]) {
      while ((m = pairRe.exec(text))) {
        if (needValid && !/^valid/.test(m[0])) continue;
        if (!needValid && !/only|admission|ticket|entry|pass|valid/.test(title)) continue;
        const a = dayIndex(m[1]), b = dayIndex(m[2]);
        if (a >= 0 && b >= 0 && a !== b) { setValid([a, b], `Valid ${DAY_NAMES[a]}s and ${DAY_NAMES[b]}s only.`); break; }
      }
      if (res.validDays) break;
    }
  }
  // Title "SAT & HOLIDAYS Admission"
  if (!res.validDays && title) {
    const hol = new RegExp(`\\b${DAY}s?\\s*(?:&|and)\\s*holidays?\\b`).exec(title);
    if (hol) { const a = dayIndex(hol[1]); if (a >= 0) setValid([a], `Valid ${DAY_NAMES[a]}s and holidays only (from the option name).`); }
  }
  if (!res.validDays && /weekdays only|monday (through|-|–) friday only/.test(fp)) setValid([1, 2, 3, 4, 5], "Weekdays only.");
  if (!res.validDays && /weekends only/.test(fp)) setValid([0, 6], "Weekends only.");

  // "Not valid Saturdays after 6 p.m.", "Not valid Fridays or Saturdays", "not valid on weekends",
  // "Not valid Friday through Sunday", "Not valid on holidays".
  const notRe = /not valid\s+(?:on\s+)?([^.;]{0,80})/g;
  while ((m = notRe.exec(fp))) {
    const seg = m[1];
    if (/^until\b/.test(seg)) continue; // "not valid until 24 hours after purchase" is lead time
    const time = seg.match(/\b(after|before)\s+([0-9]{1,2}(?::[0-9]{2})?\s*[ap]\.?m\.?)/);
    const timeNote = time ? ` ${time[1]} ${time[2].trim()}` : "";
    const timed = Boolean(time);
    const put = (d, note) => { if (!res.excludedDays.has(d)) res.excludedDays.set(d, { note, timed }); };
    if (/^weekends?/.test(seg)) { put(0, `Not valid on weekends${timeNote}.`); put(6, `Not valid on weekends${timeNote}.`); continue; }
    if (/^holidays?/.test(seg)) { res.notes.push("Not valid on holidays."); continue; }
    const range = new RegExp(`^${DAY}s?${SEP}${DAY}s?`).exec(seg);
    if (range) {
      const a = dayIndex(range[1]), b = dayIndex(range[2]);
      if (a >= 0 && b >= 0) { for (const d of rangeDays(a, b)) put(d, `Not valid ${DAY_NAMES[a]} to ${DAY_NAMES[b]}${timeNote}.`); continue; }
    }
    const head = time ? seg.slice(0, time.index) : seg.split(/\b(?:after|before|from|between)\b/)[0];
    const dayRe = new RegExp(`\\b${DAY}s?\\b`, "g");
    let dm;
    while ((dm = dayRe.exec(head))) {
      const d = dayIndex(dm[1]);
      if (d >= 0) put(d, `Not valid ${DAY_NAMES[d]}s${timeNote}.`);
    }
  }
  return res;
}

// Lead time in days before first use, parsed from fine print. Cancellation
// notice periods are skipped.
export function parseLeadDays(text) {
  const t = words(text);
  const toDays = (n, unit) => (unit.startsWith("week") ? n * 7 : unit.startsWith("day") ? n : Math.ceil(n / 24));
  const sentences = t.split(/(?<=[.;])\s+/);
  for (const s of sentences) {
    if (/cancel/.test(s)) continue;
    let m = s.match(/(\d+)[\s-]*(hour|day|week)s?['’]?\s*(?:advanced?\s+)?notice/) || s.match(/(\d+)[\s-]*(hour|day|week)s?\s+in advance/);
    if (m) return { days: toDays(Number(m[1]), m[2]), text: m[0] };
    m = s.match(/not valid until (\d+) (hour|day)s? after purchase/);
    if (m) return { days: toDays(Number(m[1]), m[2]), text: m[0] };
  }
  return null;
}

// Relative voucher expiry: "Expires 60 days after purchase", "Valid for 30 days".
// The API turns these into an absolute date counted from today, which is
// meaningless for a trip weeks away.
export function parseRelativeExpiry(text) {
  const t = words(text);
  const m = t.match(/(\d+)\s*(day|week|month)s?\s+(?:after|from)\s+(?:the\s+)?(?:date of\s+)?purchase/) || t.match(/valid for (\d+)\s*(day|week|month)s?\b/) || t.match(/expires? (?:in )?(\d+)\s*(day|week|month)s?\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return { days: m[2].startsWith("month") ? n * 30 : m[2].startsWith("week") ? n * 7 : n, text: m[0] };
}

// Party size for an option: structured field first, option title second.
// bound: "exactly" | "upTo" | "atLeast"
export function inferPartySize(option) {
  const ps = option.partySize;
  if (ps && ps.people) {
    const bound = String(ps.bound || "exactly").replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return { people: ps.people, bound, source: "api" };
  }
  const t = words(option.title);
  const NOT_PEOPLE = /^\s*-?\s*(?:minutes?|mins?|hours?|hrs?|classes|visits?|sessions?|days?|weeks?|months?|rounds?|laps|holes|games?|items?|pounds?|lbs|oz|credits?)\b/;
  let m = t.match(/\bfor\s+(\d+)\s+(?:adults?|people|persons?|guests?)\s+(?:and|\+|&)\s+(?:up\s+to\s+)?(\d+)\s+(?:kids?|children|child)/);
  if (m) return { people: Number(m[1]) + Number(m[2]), bound: /up to/.test(t) ? "upTo" : "exactly", source: "title" };
  m = t.match(/\bfor\s+(?:up\s+to\s+)?(\d+)\b(.{0,24})/);
  if (m && !NOT_PEOPLE.test(m[2])) {
    const tail = m[2];
    const bound = /or more|and up|\+/.test(tail) ? "atLeast" : /up to/.test(m[0]) ? "upTo" : "exactly";
    return { people: Number(m[1]), bound, source: "title" };
  }
  m = t.match(/\b(\d+)\s+(?:guests?|people|persons?|adults?|admission tickets?|tickets?|general admissions?|entries|seats?)\b(.{0,12})/);
  if (m) return { people: Number(m[1]), bound: /or more|and up/.test(m[2]) ? "atLeast" : "exactly", source: "title" };
  if (/couples?\b|\bfor two\b/.test(t)) return { people: 2, bound: "exactly", source: "title" };
  if (/\bsingle\b|\bone person\b|\b1 person\b|\bsolo\b/.test(t)) return { people: 1, bound: "exactly", source: "title" };
  return null;
}

function money(m) {
  return m ? m.amountMinor / Math.pow(10, m.currencyExponent ?? 2) : null;
}

// How many units of this option a group needs, and what it costs.
export function priceForGroup(option, group) {
  const unit = money(option.price);
  if (unit == null) return null;
  const party = inferPartySize(option);
  let units;
  if (option.unitBasis === "person") units = group;
  else if (party) units = party.bound === "atLeast" ? 1 : Math.ceil(group / party.people);
  else units = 1;
  return { units, unit, total: unit * units, party };
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

// Main entry. Returns findings for one offer against the trip.
// trip: { start: Date, end: Date, group: number, today: Date }
export function checkOffer(offer, option, trip) {
  const findings = [];
  const add = (level, text) => findings.push({ level, text });
  const fp = [...(offer.finePrint || []), ...(offer.fees || [])].join(" ");
  const price = priceForGroup(option, trip.group);
  const startIso = isoDate(trip.start), endIso = isoDate(trip.end);
  const tripLen = daysBetween(trip.start, trip.end) + 1;

  // Who the option is for
  const title = option.title || "";
  const audience = title.match(/\b(child|children|kid|kids|senior|seniors|student|students|resident|residents|military|veteran|veterans)\b/i);
  if (audience) {
    const who = { child: "children", kid: "kids", senior: "seniors", student: "students", resident: "residents", military: "military", veteran: "veterans" }[audience[1].toLowerCase().replace(/s$/, "").replace(/^childre$/, "child")] || audience[1].toLowerCase();
    add("warn", `This option is for ${who} only (from the option name). Check the other options.`);
  }

  // Party size
  if (price?.party) {
    const p = price.party;
    const label = p.source === "api" ? "" : " (read from the option name)";
    if (p.bound === "atLeast") {
      if (trip.group >= p.people) add("ok", `One voucher covers ${p.people} or more${label}.`);
      else add("warn", `Meant for ${p.people} or more; you are ${trip.group}${label}.`);
    } else if (p.bound === "upTo") {
      if (p.people >= trip.group) add("ok", `Covers up to ${p.people} people${label}.`);
      else add("ok", `Buy ${price.units} × "${title}" to cover ${trip.group} people${label}.`);
    } else if (p.people === trip.group) {
      add("ok", `Sized for ${p.people === 1 ? "1 person" : p.people + " people"}${label}.`);
    } else if (trip.group % p.people === 0) {
      add("ok", `Buy ${price.units} × "${title}" for ${trip.group} people${label}.`);
    } else {
      add("warn", `Option covers ${p.people}; your group of ${trip.group} doesn't divide evenly${label}.`);
    }
  } else if (option.unitBasis === "person") {
    add("ok", `Priced per person: ${trip.group} needed.`);
  } else {
    add("info", "Party size not stated. Check how many people one voucher covers.");
  }

  // Stock
  const rem = option.remaining ?? offer.remaining;
  if (!option.unlimitedStock && rem != null && price && rem < price.units) add("bad", `Only ${rem} left; you need ${price.units}.`);
  else if (!option.unlimitedStock && rem != null && rem <= 10) add("warn", `Only ${rem} left.`);

  // Sale end and voucher expiry vs trip (compare dates as dates, not instants)
  if (offer.expires && offer.expires.slice(0, 10) < isoDate(trip.today)) add("bad", "Sale has ended.");
  const rel = parseRelativeExpiry(fp);
  const vd = option.voucherExpires ? option.voucherExpires.slice(0, 10) : null;
  if (rel) {
    if (rel.days >= daysBetween(trip.today, trip.end) + 1) add("ok", `Voucher lasts ${rel.days} days from purchase; buying now still covers your trip.`);
    else {
      const earliest = new Date(trip.end); earliest.setDate(earliest.getDate() - rel.days + 1);
      add("info", `Voucher lasts ${rel.days} days from purchase ("${rel.text}"). Buy on or after ${isoDate(earliest)}.`);
    }
  } else if (vd) {
    if (vd < startIso) add("bad", `Voucher expires ${vd}, before your trip.`);
    else if (vd < endIso) add("warn", `Voucher expires ${vd}, during your trip. Use it early.`);
    else add("ok", `Voucher valid through ${vd}.`);
  } else if (option.voucherNoFixedExpiry) {
    add("ok", "Voucher has no fixed expiry.");
  }

  // Time-slot offers
  if (offer.bookable) add("warn", "Needs a booked date and time. Pick the slot on Groupon's page; the agent route can't book slots yet.");

  // Day-of-week rules
  const dayRules = parseDayRules(fp, title);
  const tripDows = [];
  for (let i = 0; i < tripLen; i++) tripDows.push((trip.start.getDay() + i) % 7);
  if (dayRules.validDays) {
    const usable = tripDows.filter((d) => dayRules.validDays.has(d));
    const note = dayRules.notes.filter((n) => n.startsWith("Valid") && !n.startsWith("Valid any")).join(" ");
    if (usable.length === 0) add("bad", `${note} None of your trip days qualify.`);
    else add("warn", `${note} Your trip includes a qualifying day.`);
  }
  for (const [d, ex] of dayRules.excludedDays) {
    if (tripDows.includes(d)) add(ex.timed ? "warn" : (tripDows.every((x) => dayRules.excludedDays.has(x)) ? "bad" : "warn"), ex.note);
  }
  if (!dayRules.validDays && dayRules.notes.some((n) => n.startsWith("Valid any"))) add("ok", "Valid any day of the week.");
  if (dayRules.notes.includes("Not valid on holidays.")) add("info", "Not valid on holidays.");

  // Lead time
  const lead = parseLeadDays(fp);
  if (lead) {
    const available = daysBetween(trip.today, trip.start);
    if (lead.days > available) add("bad", `Needs ${lead.days} day${lead.days === 1 ? "" : "s"} notice ("${lead.text}"); your trip starts in ${Math.max(available, 0)}.`);
    else add("info", `Needs notice: "${lead.text}". Book right after buying.`);
  } else if (/appointment required|appointment\/reservation required|call (to|in) (book|schedule|advance)|reservation required|reservations? (are )?required/i.test(fp)) {
    add("info", "Appointment or reservation required. Book right after buying.");
  }

  // Purchase limits
  const lim = fp.match(/limit (\d+) per person/i);
  const gift = fp.match(/may buy (\d+) additional/i);
  if (lim && price) {
    const cap = Number(lim[1]) + (gift ? Number(gift[1]) : 0);
    if (price.units > cap) add("warn", `Limit ${cap} per buyer; you need ${price.units}. Split across buyers.`);
  }
  const visit = fp.match(/limit (\d+) per (visit|table|booking|reservation)/i);
  if (visit && price && price.units > Number(visit[1])) add("warn", `Limit ${visit[1]} per ${visit[2]}; ${price.units} vouchers means ${Math.ceil(price.units / Number(visit[1]))} separate ${visit[2]}s.`);
  if (/new (customers|clients) only|first[- ]time (customers|clients)/i.test(fp)) add("warn", "New customers only.");
  const age = fp.match(/(?<![$\d.])\b(18|21)\+|ages? (18|21) (and|or) (up|older)|must be (18|21)/i);
  if (age) add("info", `Age restricted (${age[1] || age[2] || age[5]}+).`);
  if (/same person/i.test(fp) && trip.group > 1 && option.unitBasis !== "person") add("info", "All services on one voucher must be used by the same person.");
  const unknown = (offer.unknown || []).filter((u) => u !== "partySize"); // party size already reported above
  if (unknown.length) add("info", `Not stated by the merchant: ${unknown.join(", ")}.`);

  const worst = findings.some((f) => f.level === "bad") ? "bad" : findings.some((f) => f.level === "warn") ? "warn" : "ok";
  return { findings, status: worst, price, dayRules };
}
