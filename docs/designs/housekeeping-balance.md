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
