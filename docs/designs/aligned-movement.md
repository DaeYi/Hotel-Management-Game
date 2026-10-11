# Design: Everyone Does What They're Shown Doing

Date: 2026-10-11
Status: SHIPPED
Repo: DaeYi/Hotel-Management-Game
Follows: open-floor-plan.md, hallways-and-people.md (replaces their walking model)

## Request

> Move the default free check-in desk, and make sure that all staff, guests, and other pathfinding entities have their actions and animations aligned (guests occupying their room or the gym or other facilities, for instance).

The founder also decided:
- **Facility bonus from use:** guests visit facilities on a schedule, with a capacity per facility. A guest's facility review bonus comes from the facilities they actually used, replacing the old bonus for rooms next to a facility. Shop revenue comes from actual shop visits.
- **Desk move for new games only:** the free desk moves next to the free street entrance in new games. Existing saves keep their desk where it is.

## What was wrong (audit)

Six parallel readers mapped every simulated action against its animation. The main mismatches:

- **Guests were decorative walkers.**
  - **A lag of 1-5 hours:** check-ins applied at a tick were animated during the following hour, at a pace 5.6x slower than the simulation's walking pace.
  - **No queue:** everyone checked in at once, with no wait at the desk.
  - **Empty desks:** guests were sent round-robin to desks, including unstaffed ones.
  - **Double drawing:** from the desk onward, a guest was drawn twice (walker and room dot).
  - **Never at facilities:** guests never visited them.
  - **Teleporting room moves:** a guest moved after a breakdown jumped to the new room.
- **Walk charges didn't match the walks shown.** Staff were sent to the right rooms, but:
  - **Where walks start:** the simulation charged every walk from the nearest staff base, while the animation walked from wherever the person was.
  - **Elevator time:** rides took the same time on screen however many floors they crossed, but were charged per floor.
  - **Routes:** the drawn route came from a plain step-count search, while the charge came from a time-weighted one.
  - **Handoffs:** housekeepers handed rooms to each other between hours.
  - **Off-shift staff:** they sat in the break room at 3am.
  - **Two clocks:** walkers moved by Phaser's frame delta, which drifted away from the game clock.

## Design

**One model for everyone: itineraries.** A person's time is a list of legs, each a *walk* along a path at a pace or a *stay* at a tile. Legs are timed in absolute game hours (`(day-1)*24 + hour + fraction`).
- **Decided by the simulation:** it plans these legs when it decides something, acts on the same legs, and stores them in the save.
- **Drawn as-is:** the renderer only asks where the legs put each person at the current game time. It does no stepping and keeps no state of its own, so speed changes, pausing, several ticks in one frame, and reloads all agree.
- **Code:** `src/simulation/Movement.ts`, with `positionAt`, `truncateLegs`, `makeWalk`, and `makeStay`.

**One pathfinder.** `findRoute` (`Layout.ts`) is a Dijkstra search by time:
- **Steps:** a hallway step costs the walker's pace; an elevator ride costs `TRAVEL.hoursPerFloor` per floor for everyone.
- **Doors:** rooms and facilities are entered and left only through their door.
- **Speed:** route trees are cached per layout and pace.
- **Paces:** staff walk at `TRAVEL.hoursPerTile` (0.03 h per tile) and guests at `TRAVEL.guestHoursPerTile` (0.06 h per tile).
- **Elevator rides on screen:** the person stays in the shaft, on the floor they left for the first half of the ride and on the destination floor for the second half.

### Staff (`StaffManager.ts`)

- **Roster:** `state.staffRoster` records each housekeeper and maintenance worker as of the last hour boundary:
  - where they are (`null` means off site);
  - the room they're working on (they stay on it, so there are no handoffs);
  - any walk still under way at the boundary;
  - whether they've been let go.
- **Hourly plan:** at each hour boundary `planStaff` gives every member an itinerary for the coming hour, stored in `state.staffPlan`:
  - walk from where they are to the most urgent unclaimed job (turnovers first, then daily cleans or repairs), with one worker per room;
  - work it, then move on to the next job;
  - rest in a break room on their floor, or else a staff base.
- **What the tick credits:** `processCleaningTick` and `processMaintenanceTick` credit exactly the time each plan spends in each room (`plannedWork`). Walks come out of the worker's hour; they are no longer folded into the job. `rosterAfter` then moves everyone to where the plan left them.
- **Shifts:** at shift end, staff walk out through the nearest street entrance. In the hour before the shift, they walk in, timed to reach their resting place at 6:00.
- **Hiring and letting go:** takes effect at the next hour boundary. New hires walk in off the street, and staff who are let go walk out.
- **Building mid-hour:** when the player changes the layout during the hour, `replanStaff` keeps what everyone has already done and re-plans the rest of the hour from where they are.

### Guests (`GuestMovement.ts`)

Every guest trip starts at the tick boundary at which the simulation made the decision behind it.

- **Arrival:** at check-in, the room is booked and the guest's trip runs entrance → the front tile of a *staffed* desk → wait → check in → their room.
  - **Lanes:** there is one check-in lane per seated front-desk worker.
  - **Service time:** each check-in takes `1/checkInsPerHour` (20 minutes), one guest at a time per worker. That is exactly the capacity the simulation allows.
  - **Room dot:** it appears only when the guest walks in.
- **Turned away or impatient:** these guests walk in, ask or wait, and walk out (`state.walkers`).
- **Departures and walkouts:** the guest walks to the nearest street entrance from wherever they are, which may be the gym.
- **Room moves:** after a breakdown, the guest walks to the new room.
- **Layout changes:** `rerouteTrips` re-routes anyone whose remaining trip now runs through a wall.

### Facility visits (`FacilityManager.ts`)

- **When guests go:** at each hour boundary, guests in their rooms may head out. The chance depends on the facility type and hour (`visitChance`), and the pool's chance rises in summer.
- **Breakfast and dinner:** 30% an hour at the restaurant.
- **Gym:** 10% an hour in the morning and 8% in the evening.
- **No PRNG:** the choice is a deterministic hash of guest, day, hour, and facility type, so it never shifts other random rolls.
- **Conditions for a visit:**
  - an open facility of that type is within `FACILITY_VISITS.maxWalkHours` (0.75 h);
  - it has room (`capacity × capacityMult[level]`);
  - the guest hasn't used that type today.
- **Effects of a visit:**
  - it's a trip (walk, stay inside, walk back);
  - it's recorded in `guest.facilitiesUsed`;
  - a shop visit is a sale of `spendPerVisit × revenueMult`.
- **Review bonus:** at checkout the guest gets `visitReviewBonus × reviewMult` for each type they used, ×1.5 in its season, capped at 1.2 per stay. The old adjacency bonus (`getAdjacentFacilities`) and the per-guest daily shop income are gone.
- **Unchanged:** star points (still from open facilities), operating costs, and facility noise.
- **Inspector:** shows opening hours, how many guests are inside now and its capacity, and how many current guests have used one. The room inspector says where an absent guest is ("arriving", "at the Gym", "back from the Pool").

### Desk move

The free desk is now `STARTER_LAYOUT.deskTiles[0]` = (1,3), just inside the free street entrance at (0,4).
- **Staff and guests:** the lobby staff base and the guests' check-in spot are both (1,4).
- **Bots:** they reserve (1,3) and (2,3) for desks.
- **Saved games:** they keep their desk.
- **Toasts:** they moved to the bottom right so they don't cover the lobby.

### Checkout time

`ECONOMY.checkOutHour` exists but stays 0: guests still leave at midnight, as before. A realistic 11:00 checkout was measured. It costs the balanced bot about 20% of its valuation (longer stays lower satisfaction, and the bots build less), so it was left for a separate balancing pass.

## Saves

v17 → v18:
- **Guests:** they start in their rooms (`trip: null`) with no facilities used this stay.
- **Walkers:** none.
- **Staff:** the roster and this hour's plan are rebuilt on load (`withPlans` in `GameController`), with everyone at work if they're on shift.

## Review

An adversarial review ran five reviewers, one per area, and gave each finding an independent skeptic. It confirmed 34 findings, which reduce to about 15 distinct problems. All are fixed:

- **A cut-off worker hogged the job queue.** A worker who couldn't reach any job claimed all of them. Jobs are now claimed only once there is a route to them, and a stuck worker rests where they are.
- **Mid-hour re-plans repeated work.** Work done earlier in the hour is now subtracted, so finished rooms are not cleaned again. A step already under way is finished, not undone. Commuters keep heading in.
- **Visits were credited too early.** They are now credited when the guest arrives at the facility (`creditFacilityVisits`), so a visit cut short earns nothing.
- **Guests vanished before setting out.** Trips now carry their purpose (`tripKind`). A guest about to set out keeps their room dot, while an arriving guest is shown outside until they come in.
- **Rerouting is now one rebuild of the rest of the trip** (`continueTrip`). It:
  - re-routes only on steps still ahead;
  - checks doors, elevators, entrances, and staffed check-in lanes;
  - keeps stops that are still valid;
  - rebuilds trips that haven't begun from where they would have started.
  It runs whenever the building, the work, or the front desk changes (`settleChanges`). The game calls it after player actions, and the simulator after each bot action.
- **Arrivals and room moves between disconnected wings** now go out to the street and back in, instead of teleporting.
- **Rendering fixes:**
  - staff who have gone home are no longer drawn;
  - seats are stable and hash-chosen;
  - inspectors refresh live.
- **Memory:** route trees are kept only for the layout in use.
- **Tests:**
  - the alignment test checks repairs and daily cleans in both directions, using where people actually are;
  - new tests cover re-planning, cut-off workers, credit on arrival, the walking limit, sales by level, and controller-level mid-hour changes.

## Verification

- **`test/alignment.test.ts`:** runs the balanced bot for 2 × 200 days and checks every hour that:
  - the work credited matches the plan exactly;
  - staff don't jump at hour boundaries;
  - one worker at a time per room;
  - no more check-ins at once than desk seats;
  - facilities are never over capacity;
  - leavers exit by an entrance;
  - nobody is in a room while it's turned over or repaired.
- **`test/movement.test.ts`:** covers the movement engine, check-in lanes, departures, facility visits (capacity, blocked doors, once a day, sales, bonus only for visitors), rerouting, upper floors, and the save migration.
- **`test/housekeeping.test.ts` and `travel.test.ts`:** rewritten around itineraries.

### Balance

12 runs × 400 days, medians, measured with the same harness on the previous commit:

| Strategy | Before | After |
|---|---|---|
| Balanced | $3.76M | $4.56M |
| Understaffed | $3.11M | $2.00M |
| Overstaffed | $1.92M (4/12 bankrupt) | $3.57M (0/12 bankrupt) |
| Hoarder | $1.39M | $1.34M |

- **Ordering:** the intended ordering holds. Staffing to the workload beats both under- and over-staffing, and reinvesting beats hoarding.
- **Desk move:** most of the gain is the bots' lobby moving next to the entrance. An audit run measured $5.0M from the desk move alone.
- **Walking job to job:** this is cheaper than being charged a walk from base for every job, and adds about 10%.
- **Visit bonus:** this adds the rest.
