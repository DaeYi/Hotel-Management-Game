# Design: Stakes & Progression

Date: 2026-10-10
Status: SHIPPED
Repo: DaeYi/Hotel-Management-Game

## Problem

A balance pass before this milestone found the game had no way to lose and nothing to aim for:

- **Demand ignored hotel size.** ~12 guests/day arrived whether you had 9 rooms or 90. Small hotels turned most guests away; growing past ~25 rooms was pointless.
- **Stars only hurt.** A higher star rating made guests pickier (`expectationMultiplier`) but didn't raise what they'd pay or how many came. Default housekeeping alone put any hotel at 2 stars.
- **No pressure.** The $50k start was free money. A 9-room hotel with no management went bankrupt 0% of the time and always ended at 3 stars.
- **Overpricing was free.** Price only affected reviews a little; demand didn't respond to it at all.
- **Margins were inverted.** Per-guest cleaning costs ($20 daily clean + $30 turnover) meant a full $80 standard room lost money every night.

## Decisions (chosen with the founder)

| Question | Choice |
|---|---|
| Progression structure | Milestone goals in one continuous run |
| Source of pressure | Opening bank loan with weekly payments |
| Unlocks | Gated by peak star rating |
| Difficulty | Forgiving: sensible play shouldn't go bankrupt; neglect and wild overpricing should |

## What changed

**Stars pay off.** Explicit `STAR_RATING.pointThresholds` `[0, 2, 4.5, 7, 9]` replace `floor(points) + 1`. Each star level raises the fair price and guest budgets (`priceMultiplier`, 1.0 to 1.9x) and arrivals (`demandMultiplier`, 1.0 to 2.0x).

**Demand.** `arrivals/day = (2 + 0.3 x rooms) x starDemand x review/5 x season x word-of-mouth x reputation` (`getExpectedArrivalsPerDay`). Bigger hotels draw more guests, but well-run hotels are full and badly run ones aren't.

**Price sensitivity.** Each arriving guest draws a tolerance in [1.0, 1.8] and won't book a room priced above `fair x tolerance`. The fair price is always accepted. Raising prices pays when you're full and loses guests when you're not.

**Opening loan.** `LOAN`: $50k principal, 1%/week interest, $1,000/week, due every 7 days. Payments come out even without the cash, which pushes the hotel into debt at the existing 5%/day debt interest. Early repayment comes from the Goals panel.

**Unlocks.** `requiredStars` per room/facility: standard + shop at 1, deluxe + gym at 2, suite + restaurant at 3, pool at 4. `addRoom`/`addFacility` enforce it using `peakStarRating`, so a downgrade never re-locks anything.

**Objectives.** Nine owner goals in `OBJECTIVES`, each with an absolute deadline day and a cash reward: 8 rooms, 70% weekly occupancy, 7.0 reviews, 2 stars, $25k in 30 days, 3 stars, loan paid off, 4 stars, 5 stars. Missing a deadline fails that goal and moves on. Progress uses end-of-day `dailyStats` snapshots.

**Economy rebalance.** Daily clean $20 to $5, turnover $15/$30/$50 to $8/$15/$25, operating cost $20 to $10 per room, wages cut ~20%, room wear 2 to 3 condition/day.

**UI.** Always-on goal tracker in the top-right (click opens the Goals panel with all goals and the loan), locked build options show their unlock star, room prices follow the star level, loan status in the bottom bar, and a fourth tutorial step.

**Saves.** v10 to v11. Older saves get no loan (rather than a surprise $50k debt), fresh objectives, and a recomputed star rating as their peak.

## Balance results

`npm run simulate -- 400 40` with scripted strategies (`src/simulation/strategies.ts`):

| Strategy | Bankrupt | Outcome |
|---|---|---|
| idle (8 rooms, never touched) | 100%, median day ~198 | rooms break down ~day 70, then a slow bleed |
| balanced (fair prices, sensible staff, expands when busy, upgrades rooms) | 0% | 3★ ~day 83, 4★ ~day 148, 5★ ~day 177; loan paid; all 9 goals |
| greedy (balanced at 1.6x price) | 95%, median day ~316 | stuck at 2★, misses most goals |

## Known gaps (tracked in TODOS.md)

- **Late game has no money sink.** Balanced play holds ~$1.1M by day 400.
- **Neglect fails slowly.** It takes ~200 days, not the ~90 originally targeted, because broken rooms just go quiet rather than actively hurting.
