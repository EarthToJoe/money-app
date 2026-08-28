# Flight price tracker — IAD ⇄ PUJ, exact flights, standard Economy, 2 travelers

**Itinerary being tracked (exact flights only):**
- Outbound: **UA 1661**, IAD → PUJ, **Dec 16, 2026**, departs 8:20 AM, arrives 1:08 PM
- Return: **UA 1614**, PUJ → IAD, **Dec 20, 2026**, departs 12:56 PM, arrives 3:55 PM
- **2 adults**, **standard Economy** (Basic Economy is explicitly NOT acceptable)

**Booking / price-check URL (exact itinerary, 2 pax):**
https://www.google.com/travel/flights/booking?tfs=CBwQAhpGEgoyMDI2LTEyLTE2IiAKA0lBRBIKMjAyNi0xMi0xNhoDUFVKKgJVQTIEMTY2MSgAMgJVQWoHCAESA0lBRHIHCAESA1BVShpGEgoyMDI2LTEyLTIwIiAKA1BVShIKMjAyNi0xMi0yMBoDSUFEKgJVQTIEMTYxNCgAMgJVQWoHCAESA1BVSnIHCAESA0lBREABQAFIAWoEEAEYAHABggELCP___________wGYAQE

## Baseline (Aug 24, 2026) — full fare ladder, 2 passengers, booking with United

| Fare | Total (2 pax) | Per person | Carry-on | Seat selection | Changes |
|---|---|---|---|---|---|
| Basic Economy | $1,520 | $760 | ❌ none | fee, at check-in only | fee |
| **Economy ← tracked** | **$1,770** | **$885** | ✅ 1 free each | ✅ free | free (+ fare diff) |
| Economy Fully Refundable | $2,020 | $1,010 | ✅ | ✅ | free, full refunds |
| Economy Plus | $2,482 | $1,241 | ✅ | ✅ extra legroom | free (+ fare diff) |
| First | $2,630 | $1,315 | ✅ + 2 checked bags | ✅ | free (+ fare diff) |

First checked bag is $100/passenger on every economy fare.

Google's price insight: **"$1,770 is typical for Economy"** — comparable trips to
Punta Cana run roughly **$1,050–$2,550** total for two. So the current price is
mid-band, NOT a deal.

## Why the fare class matters here
The MCP `search_flights` tool only ever returns the lowest fare bucket (Basic
Economy), and its `filter_basic_economy` parameter does not work. Every price
logged before **2026-08-24T09:40** was Basic Economy for ONE traveler and is
kept only as legacy history — exclude those rows from all statistics.

## Alert rule ("sweet deal" definition)

Market context: December is peak season for this route. Route data says fares
rise sharply inside ~43 days of departure (after ~Nov 3), and holiday fares
rarely dip late. Booking-day-of-week effects are noise (~1.9%), so timing the
purchase to a particular weekday is not worth doing.

Tiers (all figures are the **2-passenger standard Economy total**):
1. **BUY ALERT — total ≤ $1,600** (~$800/person). About 10% below the $1,770
   baseline and well into the lower half of the comparable-trip band. Push
   notification + headline in the run summary.
2. **ADAPTIVE DIP** — once ≥ 36 standard-Economy observations exist, also alert
   if total ≤ (rolling 7-day mean − 1.5 × rolling 7-day std dev) AND it is a new
   all-time low, even if above $1,600.
3. **WATCH NOTE** — any new all-time low below $1,750 gets a quiet mention.
4. **DEADLINE LOGIC** — if no Tier-1/2 alert has fired by **Oct 15, 2026**, flag
   that dip odds are shrinking. After **Nov 3, 2026** (43 days out), recommend
   buying at any price at or below the trailing 14-day minimum.

If the exact itinerary stops appearing (sold out / schedule change), log `NA`
and alert immediately — availability risk outweighs price at that point.

## Log format
`price-log.csv`, one row per check (every 2 hours while the Claude app is open):
`timestamp, standard_econ_2pax_total_usd, standard_econ_per_person_usd, basic_econ_per_person_usd, fare_tracked, notes`

Legacy Basic-Economy/1-traveler history is preserved in
`price-log.basic-econ-1pax.bak.csv`.
