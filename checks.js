// Fine-print and fit checks. Pure functions: offer document in, findings out.
// Everything here is heuristic. The UI says so and links to the offer page.

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_RE = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*";
const DAY_RE_NC = "(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*";

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

// Returns { validDays: Set<number>|null, excludedDays: Map<number,string>, notes: [] }
export function parseDayRules(text) {
  const t = text.toLowerCase();
  const res = { validDays: null, excludedDays: new Map(), notes: [] };

  if (/valid (seven|7) days a week|available daily|valid any day/.test(t)) {
    res.notes.push("Valid any day of the week.");
  }

  // "Valid only Mon-Thu", "valid monday through friday only", "(Valid Mon -Thu Only)"
  const rangeRe = new RegExp(`valid\\s+(?:only\\s+)?(?:on\\s+)?${DAY_RE}\\s*(?:-|–|—|through|thru|to)\\s*${DAY_RE}`, "g");
  let m;
  while ((m = rangeRe.exec(t))) {
    const a = dayIndex(m[1]);
    const b = dayIndex(m[2]);
    if (a >= 0 && b >= 0) {
      res.validDays = new Set(rangeDays(a, b));
      res.notes.push(`Valid ${DAY_NAMES[a]} to ${DAY_NAMES[b]} only.`);
    }
  }
  // "weekdays only", "weekends only"
  if (/weekdays only|monday (through|-) friday only/.test(t) && !res.validDays) {
    res.validDays = new Set([1, 2, 3, 4, 5]);
    res.notes.push("Weekdays only.");
  }
  if (/weekends only/.test(t) && !res.validDays) {
    res.validDays = new Set([0, 6]);
    res.notes.push("Weekends only.");
  }

  // "Not valid Saturdays after 6 p.m.", "not valid on weekends", "not valid on holidays"
  const notRe = new RegExp(`not valid\\s+(?:on\\s+)?(weekends?|holidays?|${DAY_RE_NC}s?)(?:\\s+(after|before)\\s+([0-9]{1,2}(?::[0-9]{2})?\\s*[ap]\\.?m\\.?))?`, "g");
  while ((m = notRe.exec(t))) {
    const word = m[1];
    const timeNote = m[2] ? ` ${m[2]} ${m[3].replace(/\s+/g, "").replace(/\.$/, "")}` : "";
    if (word.startsWith("weekend")) {
      res.excludedDays.set(0, `Not valid on weekends${timeNote}.`);
      res.excludedDays.set(6, `Not valid on weekends${timeNote}.`);
    } else if (word.startsWith("holiday")) {
      res.notes.push("Not valid on holidays.");
    } else {
      const d = dayIndex(word);
      if (d >= 0) res.excludedDays.set(d, `Not valid ${DAY_NAMES[d]}s${timeNote}.`);
    }
  }
  return res;
}

// Lead time in days before first use, parsed from fine print.
export function parseLeadDays(text) {
  const t = text.toLowerCase();
  let m = t.match(/(\d+)[\s-]*(hour|day|week)s?['’]?\s*(?:advance\s+)?notice/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    return { days: unit === "week" ? n * 7 : unit === "day" ? n : Math.ceil(n / 24), text: m[0] };
  }
  m = t.match(/not valid until (\d+) (hour|day)s? after purchase/);
  if (m) return { days: m[2] === "day" ? Number(m[1]) : Math.ceil(Number(m[1]) / 24), text: m[0] };
  m = t.match(/(?:book|reserve|reservation)[^.]{0,40}(\d+)\s*(day|week)s?\s+in advance/);
  if (m) return { days: m[2] === "week" ? Number(m[1]) * 7 : Number(m[1]), text: m[0] };
  return null;
}

// Party size for an option: structured field first, option title second.
export function inferPartySize(option) {
  const ps = option.partySize;
  if (ps && ps.people) return { people: ps.people, bound: ps.bound || "exactly", source: "api" };
  const t = (option.title || "").toLowerCase();
  let m = t.match(/\bfor\s+(?:up\s+to\s+)?(\d+)\b/) || t.match(/\b(\d+)\s+(?:guests?|people|persons?|adults?)\b/);
  if (m) return { people: Number(m[1]), bound: /up to/.test(t) ? "upTo" : "exactly", source: "title" };
  if (/couples?|for two|two people/.test(t)) return { people: 2, bound: "exactly", source: "title" };
  if (/for one|single|one person|1 person/.test(t)) return { people: 1, bound: "exactly", source: "title" };
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
  const perPerson = money(option.pricePerPerson);
  let units;
  if (option.unitBasis === "person" || (!party && perPerson != null && Math.abs(perPerson - unit) < 0.005)) {
    units = group;
  } else if (party) {
    units = party.bound === "upTo" ? Math.ceil(group / party.people) : Math.ceil(group / party.people);
  } else {
    units = 1;
  }
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

  // Party size
  if (price?.party) {
    const p = price.party;
    const fits = p.bound === "upTo" ? true : trip.group % p.people === 0;
    const label = p.source === "api" ? "" : " (read from the option name)";
    if (p.people === trip.group || (p.bound === "upTo" && p.people >= trip.group)) {
      add("ok", `Sized for ${p.people === 1 ? "1 person" : p.people + " people"}${label}.`);
    } else if (fits) {
      add("ok", `Buy ${price.units} × "${option.title}" for ${trip.group} people${label}.`);
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
  if (!option.unlimitedStock && rem != null && price && rem < price.units) {
    add("bad", `Only ${rem} left; you need ${price.units}.`);
  } else if (!option.unlimitedStock && rem != null && rem <= 10) {
    add("warn", `Only ${rem} left.`);
  }

  // Sale end and voucher expiry vs trip
  if (offer.expires && new Date(offer.expires) < trip.today) add("bad", "Sale has ended.");
  const vexp = option.voucherExpires ? new Date(option.voucherExpires) : null;
  if (vexp) {
    if (vexp < trip.start) add("bad", `Voucher expires ${vexp.toISOString().slice(0, 10)}, before your trip.`);
    else if (vexp < trip.end) add("warn", `Voucher expires ${vexp.toISOString().slice(0, 10)}, during your trip. Use it early.`);
    else add("ok", `Voucher valid through ${vexp.toISOString().slice(0, 10)}.`);
  } else if (option.voucherNoFixedExpiry) {
    add("ok", "Voucher has no fixed expiry.");
  }

  // Time-slot offers
  if (offer.bookable) add("warn", "Needs a booked date and time. Pick the slot on Groupon's page; the agent route can't book slots yet.");

  // Day-of-week rules
  const dayRules = parseDayRules(fp);
  const tripDays = [];
  for (let d = new Date(trip.start); d <= trip.end; d.setDate(d.getDate() + 1)) tripDays.push(d.getDay());
  if (dayRules.validDays) {
    const usable = tripDays.filter((d) => dayRules.validDays.has(d));
    if (usable.length === 0) add("bad", `${dayRules.notes.join(" ")} None of your trip days qualify.`);
    else add("warn", `${dayRules.notes.join(" ")} Planned on a qualifying day.`);
  }
  for (const [d, note] of dayRules.excludedDays) {
    if (tripDays.includes(d)) add("warn", note);
  }
  if (!dayRules.validDays && dayRules.notes.some((n) => n.startsWith("Valid any"))) add("ok", "Valid any day of the week.");

  // Lead time
  const lead = parseLeadDays(fp);
  if (lead) {
    const available = daysBetween(trip.today, trip.start);
    if (lead.days > available) add("bad", `Needs ${lead.days} day${lead.days === 1 ? "" : "s"} notice ("${lead.text}"); your trip starts in ${Math.max(available, 0)}.`);
    else add("info", `Needs notice: "${lead.text}". Book right after buying.`);
  } else if (/appointment required|call (to|in) (book|schedule|advance)|reservation required/i.test(fp)) {
    add("info", "Appointment or reservation required. Book right after buying.");
  }

  // Other common clauses
  const lim = fp.match(/limit (\d+) per person/i);
  if (lim && price && price.units > Number(lim[1])) add("warn", `Limit ${lim[1]} per person; you need ${price.units}. Split across buyers.`);
  if (/new (customers|clients) only|first[- ]time (customers|clients)/i.test(fp)) add("warn", "New customers only.");
  const age = fp.match(/\b(18|21)\+|ages? (18|21) (and|or) (up|older)|must be (18|21)/i);
  if (age) add("info", `Age restricted (${age[1] || age[2] || age[5]}+).`);
  if (/same person/i.test(fp) && trip.group > 1 && option.unitBasis !== "person") add("info", "All services on one voucher must be used by the same person.");
  if ((offer.unknown || []).length) add("info", `Not stated by the merchant: ${offer.unknown.join(", ")}.`);

  const worst = findings.some((f) => f.level === "bad") ? "bad" : findings.some((f) => f.level === "warn") ? "warn" : "ok";
  return { findings, status: worst, price, dayRules };
}
