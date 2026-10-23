# SideTrip

Plan a US trip, or a gift for a friend in the US, from live LivingSocial deals.
Every deal is checked against your dates, your group size and its fine print
before you pay on Groupon.

Built for the LivingSocial Side Quest (October 2026), from India, where you can
browse the US catalog but can't easily use it. The two things the organisers
suggested for non-US entrants were "plan a trip" and "help a US friend". SideTrip
does both.

## What it does

1. You give a US city, trip dates, how many people, interests, a budget (INR or
   USD) and how many deals a day you want.
2. It searches the LivingSocial agent API for each interest, reads the top
   matches in full, and picks the option that fits your group.
3. For each offer it checks:
   - party size vs your group (from `partySize`, or the option name when the
     API marks it unknown), and how many units you'd need;
   - voucher expiry and sale end vs your trip dates;
   - remaining stock vs units needed;
   - weekday rules in the fine print ("Valid Mon-Thu only", "Not valid
     Saturdays after 6 p.m.");
   - lead time ("2-week advance notice", "Not valid until 24 hours after
     purchase") vs how far away the trip is;
   - purchase limits, new-customer-only clauses, age limits, time-slot offers
     and anything the merchant left unstated (`unknown`).
4. It lays the deals out day by day, only on days the fine print allows,
   within budget, and totals them in USD and INR.
5. "Share this plan" puts the whole plan in the URL. A friend in the US opens
   it, sees live prices re-checked at that moment, and pays on Groupon. The
   planner never touches payment.

## How to try it

Open the site, leave the defaults (New York, 2 people, three weeks out) and
press **Build my plan**. Then try:

- a trip that falls on a weekend only: spa deals with "Valid Mon-Thu only" drop
  out, and the plan says why under "Didn't make the plan";
- a trip starting tomorrow: offers needing two weeks' notice are set aside;
- 4 people: options sized "for 2" are doubled, options sized "for 3" are
  flagged;
- copy the share link into a private window: the same plan reloads with live
  prices.

## How it's built

Static HTML, CSS and JavaScript. No build step, no backend, no API key, no
tracking. The browser calls the public LivingSocial agent API directly:

- `GET /ls_agent_api/offers/search` per interest
- `GET /ls_agent_api/offers/{permalink}` for the fine print and options

`checks.js` holds the fine-print parser and the fit checks as pure functions.
`app.js` does the searching, scheduling and rendering. The INR rate comes from
open.er-api.com with a fixed fallback.

## Honest limits

- Fine-print parsing is heuristic. It catches the common phrasings in the
  catalog and will miss others. Every card links to the offer page.
- Buy links are fixed at quantity 1 (the API says to pass them on unchanged),
  so a group is told to set the quantity on Groupon. Building a multi-item
  cart needs the session-token cart API, which a browser can't use without a
  server.
- Prices shown are what the API last observed, often hours old. Groupon's
  checkout decides the real price and whether a promo code applies.
- A purchase does not reserve a date or time, and time-slot offers must be
  booked on Groupon's page.
- US offers only.

## Run locally

Any static server works:

```
python3 -m http.server 8765
```

then open http://127.0.0.1:8765/.
