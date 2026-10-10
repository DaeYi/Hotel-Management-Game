# Design: Late-Game Economy

Date: 2026-10-10
Status: SHIPPED
Repo: DaeYi/Hotel-Management-Game
Follows: stakes-and-progression.md

## Problem

After the stakes & progression milestone, a well-run 5★ hotel earned ~$8,400/day against ~$2,300/day in costs and sat on ~$1.1M by day 400. Prices nearly doubled by 5 stars (`priceMultiplier` 1.9) while running costs stayed flat. With every facility built and demand capping occupancy at ~60%, there was nothing worth buying, and nothing to aim for after the last owner goal.

## Decisions (chosen with the founder)

All four proposed sinks: **prestige upkeep, renovations, marketing campaigns, facility upgrades**. Plus a **valuation score and endless legacy goals** for after the 9 owner goals.

## What changed

**Prestige upkeep.** `STAR_RATING.upkeepMultiplier` (1.0 / 1.2 / 1.45 / 1.8 / 2.2) scales per-room operating cost, staff wages, and facility operating costs. A first pass (up to 2.7x) created a 4-star death trap: costs about equal to revenue for a hotel with middling reviews, no cash left to renovate, and a slow spiral. 6% of balanced runs went bankrupt. Flattened to roughly track the price multiplier.

**Decor and renovation.** Every room and facility has `decor` (0-100) fading 0.35/day. Below 70 it costs star points (up to 3.0 at 0 average decor) and reviews (up to 2.5 on the 0-10 scale, amplified at high stars by the existing expectation multiplier). Story-log review attribution can now blame "tired decor".

Renovating costs 25% of build cost × the star price multiplier:
- **Rooms** go offline for 24h (new `'renovating'` status, construction noise), then reopen at 100 decor, condition, and cleanliness.
- **Facilities** renovate instantly.

**Facility upgrades.** Levels 2 (4★, 1.0× build cost) and 3 (5★, 1.75×). Each level raises review bonus, star points, shop revenue, and operating cost (`FACILITY_LEVELS`).

**Marketing.** Three campaigns (`MARKETING.campaigns`): Local Ads +20%, Travel Sites +40%, National +70% arrivals. They run 14-21 days, one at a time. Cost is a base plus a per-room amount, so it scales with the hotel. Managed from a new 📣 Ads toolbar panel.

**Valuation.** Calculated as:
- **Property:** build cost plus facility upgrade spend, discounted to 50% at zero decor.
- **Business:** 6× the last 30 days' revenue.
- **Net cash:** cash minus the loan balance.

Shown in the top bar and the Goals panel.

**Legacy goals.** After the 9 owner goals, `getLegacyObjective(n)` generates goals forever. They cycle through valuation ($1M, doubling), holding 5★ for N days (30, +30), 30-day occupancy (75%, +5%, cap 95%), and reviews (8.5, +0.3, cap 9.7). No deadlines or rewards.

**Saves.** v11 to v12. Existing rooms and facilities start with fresh decor at level 1, and there's no campaign running.

## Balance

New strategies in `src/simulation/strategies.ts`:
- **hoarder:** balanced play that never uses the new sinks.
- **renovateOnly / upgradeOnly / marketOnly:** one sink each, for measuring.

The reinvesting bot treats renovation as upkeep and only spends on upgrades and marketing from real surplus.

`npm run simulate -- 400 24`:

| Strategy | Bankrupt | Stars at day 400 | Median valuation | Median cash |
|---|---|---|---|---|
| balanced (all sinks) | 0% | 88% 5★ | $1.88M | $51k |
| hoarder (no sinks) | 0% | 100% 4★ | $1.49M | $178k |
| marketOnly | 0% | 100% 4★ | $1.94M | $251k |
| renovateOnly | 0% | 67% 5★ | $1.75M | $104k |
| upgradeOnly | 4% | 25% 5★ | $1.44M | $69k |

At 600 days the gap widens. Balanced reaches $2.24M with 100% at 5★. The hoarder's decor collapses: it slides to 3★ and $1.50M while sitting on $634k of idle cash.

Balanced first reaches 3★ around day 94, 4★ around day 219, and 5★ around day 325 (p90 day 402). The 5★ owner-goal deadline moved from 360 to 420 to match.

What each sink is worth, measured on its own:
- **Marketing:** pays for itself.
- **Upgrades:** raise the star ceiling.
- **Renovation:** a cost you pay to keep what you have.
- **Upgrading without renovating:** the riskiest partial strategy.

## Known gaps

- **Cash still slowly piles up:** balanced holds ~$250k by day 600. Far below the old runaway, but not zero. Legacy goals give it a purpose; another sink (e.g. a second property) could come later.
- **No way to downgrade on purpose:** a struggling 4★ hotel can't choose to drop a star to cut upkeep, except by indirect means like cheaper housekeeping.
