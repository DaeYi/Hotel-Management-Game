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

## Known gaps

- **Walking takes no time:** a far-away room isn't slower to clean or reach. Making staff travel time real would give layout real consequences.
- **No lobby or entrance tile:** the street entrance is implicit (any edge hallway).
- **Crowd cap:** guests beyond 40 simultaneous walkers skip the walk animation.
