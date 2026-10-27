# LivingSocial Side Quest — final submission text (paste into the form; submit once per track)

## Page 1 (same for both)
Name: M Danish Siddiqui
Work email: mdans@groupon.com
Country: India
Short entry title: SideTrip — deals that fit your dates
AI tool used: Claude Code (Claude Fable 5.1), plus LivingSocial's MCP server for the Try It journey

---

## Track: Build It

### What you built / problem solved
SideTrip plans a US trip, or a gift for a friend in the US, from live LivingSocial deals, and checks every deal against your dates, your group and its fine print before you pay on Groupon. I'm in India, so I can browse the catalog but can't easily use it; the challenge suggested "plan a trip" and "help a US friend", and SideTrip does both.

You give a city, dates, group size, interests and a budget in INR or USD. It searches the agent API per interest, reads each offer in full, and checks: party size vs your group (from partySize, or the option name when the API marks it unknown); voucher expiry and sale end vs your dates; stock vs units needed; weekday rules from fine print and option titles ("Valid Mon-Thu only", "MON–THURS Admission", "Not valid Saturdays after 6 p.m."); notice periods ("2-week advance notice") vs how far away the trip is; purchase limits, new-customer and age clauses; and relative-expiry vouchers ("valid for 30 days"), where it tells you the earliest day to buy instead of rejecting the deal. It lays the picks out day by day, only on days the fine print allows, within budget, orders each day's stops by distance, and totals in both currencies. Each card shows when LivingSocial last saw the price and opens the merchant's real fine print with the matched clauses highlighted.

Three handoffs: "Copy plan link" puts the whole plan in the URL so a friend in the US opens it, sees each offer re-read from LivingSocial, and pays on Groupon; "Add to calendar" exports an .ics with each deal's checks, fine print and buy link; "Copy prompt for your AI" hands the plan to any assistant connected to LivingSocial's MCP server, which can put every pick in one cart (a browser can't hold a shopping session). SideTrip plans, the LivingSocial agent buys, the person pays. It is also usable by agents directly: every input is a URL parameter (for-agents.md, plus a Claude skill in the repo).

### Working demo link
https://mdans-grpn.github.io/sidetrip/
Source: https://github.com/mdans-grpn/sidetrip

### How to try it
Click a preset ("Parents visiting New York", "Gift a spa day in Chicago", "Vegas weekend for 4"); a plan appears in about six seconds. Then: open "Read the fine print" on any card to see what the checker read; move the dates to a Saturday-Sunday with "massage" in Chicago and watch Mon-Thu spa deals drop into "Didn't make the plan" with the reason; set the start date to tomorrow and offers needing two weeks' notice are set aside; set 4 people and "for 2" options double while child/senior options are flagged; copy the plan link into a private window and it reloads re-read from LivingSocial. Static site, no login, no key, nothing stored. Agents: https://mdans-grpn.github.io/sidetrip/?city=Chicago&start=2026-11-14&end=2026-11-15&group=4&budget=500&currency=USD&interests=couples%20massage,dinner&run=1

### Outcome
Working and deployed; built in four days with Claude Code, including an independent AI review pass that found real defects (a Mon-Thu children's ticket being scheduled on a Sunday, relative-expiry vouchers wrongly rejected, a US-timezone off-by-one on expiry) which are fixed. Fine-print parsing is heuristic and every card links to the offer page. Gaps I hit on the API: partySize is null on many options while the title says "For 2"; weekday rules live only in titles and fine print; voucherExpires for "N days after purchase" deals is computed from the read date, so agents must read the fine print to know it is relative; observedAt was 10-24 hours old on every read; open-API buy links are fixed to qty=1 and route through the LivingSocial cart, so a group is told to set quantity on Groupon (the Partner API would fix both, at the cost of a server).

### Real orders to verify?
No.

---

## Track: Try It

### Prompt used
"I'm in India, planning a long weekend in Chicago for two on 13-15 Nov 2026. Find a couples massage under $60 a person that we can actually use on those dates, add two to the cart and prepare the checkout so my friend in Chicago can pay."
(Run against LivingSocial's MCP server, https://api-core.livingsocial.com/mcp_customers/mcp, from India with no account.)

### Highest stage reached
Prepared checkout

### Screenshot or safe internal evidence link
(attach sidetrip-demo.gif and the "Review your order" handoff-page screenshot, or leave blank)

### One thing that worked or broke
Worked: the whole journey ran from India with no sign-up. The first search_offers call issued the session; get_offer, add_to_cart (qty 2, $81.98), prepare_checkout and get_purchase_status all answered as documented, the handoff page showed "Review your order" with "Continue to Groupon to pay", and buy links came back with a via=<journey> parameter, so the session is attributed.

Broke or surprised, each reproducible: (1) get_offer called without the search's token silently opened a second journey, so an agent that drops the token splits its own cart; a journey_required error would be kinder. (2) voucherExpires on "valid for 30 days after purchase" deals is computed from the read date, so a trip six weeks out looks expired unless the agent reads the fine print. (3) observedAt was 10-24 hours old on every offer I read; the "latest price at cart" promise holds, but agents quoting prices should know. (4) partySize is null on many options whose title says "For 2" or "MON–THURS Admission", and partySize.bound is "up_to" (snake_case) while the docs read as camelCase. (5) offers/search?q=show tickets&city=Las Vegas returns total: 5 with an empty offers array. (6) The Guides endpoint has no listing and every slug I tried 404s; the Agent Board is empty; language=es returns English. (7) Default User-Agents get a plain-text 403 "error code: 1010" before reaching the API, which will trip up many first-time agents. (8) From a browser, CORS allows reads but a session can't be carried, so static sites can't build multi-item carts; that pushed me to hand the plan to an MCP-connected assistant instead.

---

## Last page
May we showcase your entry internally? Yes
