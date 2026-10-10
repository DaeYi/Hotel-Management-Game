# Design: Hallways, Check-in Desks, and People

Date: 2026-10-10
Status: SHIPPED
Repo: DaeYi/Hotel-Management-Game
Follows: floors.md

## Request

The founder asked for:
- Hallways on the grid.
- Staff visibly walking to rooms for cleaning and repairs.
- Guests visibly checking in and walking to their rooms.
- A purchasable check-in desk that guests need in order to check in, staffed by the Front Desk team.

## Decisions

- **Hallways are load-bearing.** Hallways connect rooms to the street, so they're required rather than cosmetic. A room is bookable only when one of its four sides is a hallway tile connected to an entrance. An entrance is any hallway tile on the ground floor's outer edge. Upper floors connect through elevator shafts, which need a hallway beside them on each floor. Diagonal contact doesn't count as a door.
- **Desks gate check-in.** Desks go on the ground floor only and must open onto a connected hallway. Each seats `DESK.staffPerDesk` (2) Front Desk staff, so check-ins per hour are `min(staff, desks × 2) × 3`. With no reachable, staffed desk, nobody checks in. The old self-service kiosk fallback is gone.
- **Walking is cosmetic.** The simulation still runs one tick per game hour, and `ActorLayer` acts out what it decided. This keeps the balance bots and tests deterministic, and it means walking distance has no gameplay cost (yet).
- **Hallways buffer noise.** Noise only comes from rooms and facilities, so rooms across a corridor are two tiles apart and don't hear each other. That lifted average reviews noticeably.
- **New games start with a free lobby.** The starter layout (hallways plus one desk) is free, so new players can place rooms immediately. `createHotelState()` stays empty for low-level tests; `createStarterHotel()` is the real game start.

## Layout

`GRID` grew from 8×5 to 10×6 (52px tiles), so a floor fits two hallway rows with rooms on both sides. `STARTER_LAYOUT` is the default template, used by new games, migrated saves, and the bots:
- **Hallways:** full-width hallway rows on rows 1 and 4, joined by a two-tile connector at the right end (`(9,2)`, `(9,3)`). Without that connector, an upper floor's second hallway row had no route to the elevator. The first version shipped that bug, and the pathfinding tests caught it.
- **Rooms:** rooms sit on rows 0, 2, 3, and 5. That's 33 room tiles on the ground floor (after desks and elevator tiles) and 35 on upper floors.
- **Reserved tiles:** `(0..2, 0)` are kept for elevator shafts, and `(3,0)`/`(4,0)` on the ground floor for desks.

## Simulation

- **`Layout.ts`:**
  - **Reachability:** a breadth-first search from the entrances through hallways and elevator shafts. It's cached per layout (fixtures/elevators/floorCount), since it's asked for every room every tick.
  - **Pathfinding:** `findPath` returns tile-by-tile routes, riding shafts between floors, and can start or end on a non-walkable tile such as a room or desk.
  - **Check-in capacity:** helpers for counting reachable, staffed desks.
- **`Fixture`:** a new type (`hallway` | `desk`) in `state.fixtures`. Hallways cost $300 per tile; desks cost $4,000. Both count toward valuation and refund 25% when removed.
- **`isRoomReachable`:** now means hallway-connected, which covers the old "needs an elevator" rule.
- **Saves:** v13 → v14 (`packIntoLayout`). Old layouts have no hallways, so every room and facility is re-packed into the template's room tiles across as many floors as needed, with hallways on every floor, the free desk, and at least one elevator if there are upper floors. Ids are kept.

## UI

- **Grid:** hallways are a carpet runner; desks are a counter with Front Desk staff (blue squares) seated behind them.
- **Walkers:**
  - **Guests:** they come in from an entrance, pause at a desk to check in, then walk the hallways (riding the elevator if needed) to their room. Their room dot appears when they arrive. Departing guests (grey) walk back out.
  - **Housekeepers (teal):** they go to rooms being turned over, and to occupied rooms during the morning daily clean.
  - **Maintenance (orange):** they go to vacant rooms below the repair threshold during their shift.
  - **Idle staff:** they wait in the hallway in front of the first desk.
- **Build panel:** compacted, with a new SERVICE section: Hallway (click or drag to lay; fast drags fill every tile between pointer events), Check-in Desk, Elevator, and Bulldoze (removes hallways, desks, and elevators, which also closes the "no way to remove an elevator" gap).
- **Legend:** a key under the grid for guests and each staff role.
- **Staff panel:** shows check-in capacity per desk and flags idle Front Desk staff when there aren't enough desks.

## Balance

`npm run simulate -- 400 24`: balanced 0% bankrupt, 96% at 5★, $2.17M median valuation (floors-only was 58% / $1.66M). Hallways cost a little, but buffering noise lifts reviews. The never-renovate strategies still fail occasionally (upgradeOnly 8%) via the winter crunch noted in floors.md.

## Follow-up: staff travel time (shipped)

Walking now costs simulation time. `Layout.getStaffTravelHours` measures the walk from the nearest **staff base** to a room's door: about 2 minutes per hallway tile (`TRAVEL.hoursPerTile` 0.03) and 9 minutes per floor of elevator ride (`hoursPerFloor` 0.15). It's cached per layout like reachability.

**Staff bases** are the hallway tile in front of each reachable desk (the lobby) and each reachable **Staff Closet**, a new $2,500 fixture placeable on any floor. With neither, staff come in from the street. Rooms with no route get no service.

What the walk costs:
- **Turnover cleans:** the walk is added to `cleaningHoursRemaining` when the job starts. Housekeeping hours are pooled, so a housekeeper who finishes partway through an hour moves on, and a 20-minute walk costs 20 minutes rather than a whole hourly tick.
- **The morning daily-clean round:** one hour per housekeeper. Each room costs 0.5h plus its walk, dirtiest first, so distant rooms mean fewer get done.
- **Repairs:** each hour's repair is scaled by `1 - walk`, never below `TRAVEL.minRepairEfficiency` (25%).

**UI:**
- **Room inspector:** shows "Staff walk: N min".
- **Staff panel:** shows the average walk, and suggests a closet for any upper floor averaging over 20 minutes.
- **Walkers:** idle staff wait at a base on their own floor.

**Bots** build a closet on each upper floor once it has 6 rooms (reserved tile (3,0) upstairs). In a typical two-floor bot hotel, ground-floor rooms average a 17-minute walk; upstairs it's 28 minutes without a closet and 7 with one.

**Measured effect** (balanced bot, 12 runs × 400 days): average review 7.21 → 7.08, with more daily cleans skipped. The effect is modest because turnovers take 4-6 hours, so a 20-minute walk adds only about 6%. The daily round and upper floors without closets feel it most.

**Finding while measuring:** turnover cleaning, not demand, has been capping occupancy all along. See "Housekeeping is the hidden occupancy cap" in TODOS.md.

## Known gaps

- **No lobby or entrance tile:** the street entrance is implicit (any edge hallway).
- **Crowd cap:** guests beyond 40 simultaneous walkers skip the walk animation.
