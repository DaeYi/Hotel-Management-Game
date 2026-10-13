# Design: Housekeeping Balance

Date: 2026-10-10
Status: SHIPPED
Repo: DaeYi/Hotel-Management-Game
Follows: hallways-and-people.md (where the problem was found)

## Problem

While measuring staff travel time, we found that turnover cleaning, not guest demand, had been capping occupancy. The balance bots hired one housekeeper per 10 rooms and always had 15-20 rooms stuck waiting for cleaning. Hiring one per 7 rooms more than doubled a balanced hotel's day-400 valuation ($2.5M to $5.8M), so "hire lots of housekeepers" was a dominant strategy. Every earlier balance pass had been tuned against that understaffed bot.

Hiring to meet demand is good play, not the bug. The bugs were that the rest of the economy only worked while hotels were understaffed, and that nothing else limited growth. Fixing it uncovered three more problems, each hidden behind the one before.

## Changes

**1. One pool of housekeeping hours.** The morning daily-clean round used to get exactly one hour of each housekeeper's day at 10am, so cleaning every room daily needed about one housekeeper per two rooms. Staffing was impossible to reason about.
- **Queued cleans:** daily cleans are now jobs (`Room.dailyCleanHoursRemaining`), queued at the cleaning hour as half an hour plus the walk.
- **Shared pool:** housekeepers work them from the same hourly pool as turnovers, turnovers first since they block bookings, dirtiest rooms first.
- **Skipping:** a clean still pending when the shift ends is skipped, and a checkout cancels a pending clean.
- **Workload estimate:** `estimateHousekeepingHours(state, occupancy)` adds turnovers for the day's checkouts plus the daily round, walks included, and `housekeepersNeeded` turns that into a headcount.
- **Staff panel:** shows "Busy day: Xh of Yh" and how many housekeepers a busy (85%) day needs.

**2. Demand with diminishing returns on size.** With cleaning no longer the cap, nothing stopped expansion. Demand grew linearly with room count, so busy hotels built more rooms and drew more demand: the balanced bot reached 116 rooms by day 300, overloaded its elevators, and sank in winter. The market is now `0.5 + 1.65 × √rooms` (was `2 + 0.3 × rooms`). A 10-room hotel still fills, and a well-run 5★ hotel tops out around 60-65 rooms.

**3. Amenities charged per occupied room.** In-room amenities were charged per room per day, occupied or not: $35 × 60 rooms at luxury is about $2,100/day for empty winter rooms. Toiletries and linens are used by guests, so they're now per occupied room-night. That one change took first-winter bankruptcies for well-run hotels from 13% to 0%.

**4. 5★ threshold.** Briefly tried at 9.25 and 9.5 points to slow the 4★ to 5★ jump. Both made 5★ erratic and added bankruptcies, so it stays at 9.

## Bot changes (`strategies.ts`)

The balanced bot now behaves like a sensible manager:
- **Housekeeping staffing:** sized with `housekeepersNeeded` against the occupancy current demand would fill, plus 10% headroom. That's demand, not recent occupancy, because a cleaning backlog lowers occupancy and would otherwise trigger a cut-staff spiral.
- **Expansion:** only when normal-season demand, with the seasonal multiplier divided out, would keep the rooms 90% full. Summer demand is 1.5× and winter 0.6×, so expanding on raw occupancy builds rooms that sit empty all winter.
- **Thorough cleaning from 2★:** its 1.0 star point is what gets a hotel to 3★. The old bot waited until 3★, which held 3★ back to about day 290.
- **New `understaffed` (0.6×) and `overstaffed` (1.6×) strategies** for checking that there's a right amount of housekeeping.

## Results

`npm run simulate -- 400 24`, plus staffing variants at 16 runs:

| Strategy | Bankrupt | Stars at day 400 | Median valuation | Median cash |
|---|---|---|---|---|
| balanced | 0% | 100% 5★ | $3.74M | $180k |
| understaffed (0.6×) | 0% | 100% 5★ | $3.11M | $69k |
| overstaffed (1.6×) | 0% | 100% 5★ | $2.05M | $51k |
| hoarder | 0% | 75% 3★ | $1.32M | $424k |
| greedy / idle | 100% | | | |

Right-sized staffing now beats both under- and over-staffing; a test (`test/housekeeping.test.ts`) locks that in. Understaffed hotels earn less but get better reviews, because emptier hotels are quieter.

**Pacing for balanced play:** 3★ around day 50, 4★ around day 190, 5★ around day 200. That's faster at the top than before, but within every owner-goal deadline, and the legacy goals carry the late game.

## Known gaps

- **Fast 4★ to 5★ jump:** pool access plus level-2 facility upgrades push a 4★ hotel past 9 points within a few weeks.
- **Planning occupancy is fixed:** staffing advice assumes 85%, which can overstate needs in a slow season.
- **Bankruptcy is still a flat -$10k** with 5%/day debt interest (TODOS.md, P2).

## Follow-up: staffing to the estimate is the optimum (2026-10-12)

**Problem.** By phase 2a the staffing curve was flat. Scaling the balanced bot's housekeepers from `housekeepersNeeded` (12 seeds x 400 days, all switches on), everything from 0.8x to 1.6x landed within 2.5% of 1.0x; only 0.6x fell off (-64%). So the test that 1.0x beats 1.6x had been loosened to "within 5%". Measuring where the hours went explained it:
- **A daily clean was worth almost nothing.** A room lost 8 points a night against a review midpoint of 50, so a missed clean cost the guest about 0.06 of a review point. At 0.8x the bot skipped 79% of daily cleans and lost nothing.
- **The morning was idle.** The round was queued at 10:00 and so worked from 11:00, with the checkouts. In a 94-room hotel at 1.0x, 25 of 127 housekeeper-hours a day were idle, most of them before 11:00, while the round got 6.5 of the 11.6 hours it needed (46% skipped).
- **Walks were underestimated.** Housekeepers take jobs by urgency, not distance, so each walk is from the last room (often on another floor), not from a staff base: 2.1 to 2.7 times what the estimate counted.
- **Overstaffing was cheap.** Extra housekeepers got turnovers done sooner (fewer guests turned away) for about their wages.

**Changes**
- **The round starts with the shift.** `HOUSEKEEPING.dailyCleaningHour` 10 → 7 (queued at 7, worked from 8). Nobody is woken for it: a room whose guests are asleep in it waits (`guestsAsleepIn`, in practice night owls till 09:00), and its card says "the guests are asleep".
- **The estimate.** Walks at 2.5 base walks a job (`WALKS_PER_JOB`), and hours counted from the daily cleaning hour (now the whole shift).
- **A daily clean is worth something.** A night's use takes 30 points (was 8), a clean puts back 45 (was 15), and cleanliness weighs 2.0 (was 0.8). A make-up guest's reference is 70 (was 92: still a thorough turnover a night on). A room made up daily reviews about as before (+0.4 at checkout); a missed clean costs about 0.6, and more at high stars, where it's below the midpoint.
- **Housekeepers cost $70 a day** (was $60), like the front desk.

**Tried and dropped**
- **An estimate that counts only 10:00-21:00:** honest, but then 0.6x keeps up with turnovers (the morning catches up) and loses only about 15%. And 1.6x loses more than that, so overstaffed falls below understaffed.
- **A 10:00-21:00 shift:** rooms left over from the night sit in "cleaning" all morning, maintenance can't get at them, and rooms broke 7 times as often. The breakdowns then crowded bad reviews out of the day's incident budget (`checkReviewSemiViral`), so these hotels looked 20% richer. That quirk deserves a fix of its own.
- **$75 or more a day:** the bots keep 10 days of running costs in reserve, so higher wages stall building even at 1.0x.

**Results** (400 days, mean valuation; differences paired by seed against 1.0x; all switches on):

| Housekeepers | Before (12 seeds) | After (12 seeds) | After (24 seeds) |
|---|---|---|---|
| 0.6x | -64.4% | -39.9% | -38.6% |
| 0.8x | +2.2% | -14.2% | -11.7% |
| 0.9x | | | -4.0% |
| 1.0x | $4.36M | $4.42M | $4.41M |
| 1.1x | | | -0.7% |
| 1.2x | +2.0% | +0.1% | -1.1% |
| 1.4x | +2.3% | -13.9% | -12.7% |
| 1.6x | +1.7% | -28.8% | -30.5% |

- **The top is 1.0x-1.2x.** Over 48 seeds, 1.2x against 1.0x is -0.4% ±1.9. The extra wages there are worth about 1.5% of the valuation, too little to see, so the estimate sits at the left edge of a flat top. Raising it about 10% to centre that top would lift 0.6x towards the turnover cliff and put 1.6x below it.
- **Bot order (12 seeds):** balanced $4.42M > overstaffed $3.14M > understaffed $2.65M > hoarder $1.39M. Before: $4.36M, $4.42M, $1.55M, $1.54M.
- **With phase 2a off (12 seeds):** 0.6x -33.9%, 0.8x -2.7%, 1.2x +0.7%, 1.4x +4.2% (±3.3), 1.6x -16.3%. The same cliffs, but a wider top (0.8x-1.4x): without make-up guests and rowdy mess, missed cleans cost less, and the richer hotels feel wages later. Before, with 2a off: -64.5%, +2.3%, +3.6%, +3.2%, +2.0%.
- **At 1.0x:**
  - Mean review 7.35 (was 7.37), checkout cleanliness 61 (was 87), daily cleans skipped 11% (was 46%).
  - Breakdowns, walkouts and complaints slightly down; returning guests down 14%.
- **The test** (`test/housekeeping.test.ts`) asserts that balanced beats understaffed by 1.5x and overstaffed by 1.15x (6-seed medians). In four windows of six seeds, the margins were at least 1.58x and 1.31x.
- **The pinned runs** in `test/preferences.test.ts` moved with the base game and were re-recorded. ec57afc with the same rebalance gives exactly the same numbers, so the switches still turn their features off cleanly.

**Known gaps**
- **The penalty above 1.2x is mostly the bots' cash reserve holding back building.** So it depends on how profitable the game is: richer hotels feel extra wages later (as with 2a off).
- **Families.** A family of four makes 1.6 times the mess, 48 points a night, so their room is near the midpoint by checkout even when made up daily. That's about +0.04 on their review, against +0.3 before.
- **Valuation counts 6 times the last 30 days' revenue but costs only once** (in cash), so staff that bring in a little revenue look cheap.
