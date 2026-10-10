# Design: Multiple Floors

Date: 2026-10-10
Status: SHIPPED
Repo: DaeYi/Hotel-Management-Game
Follows: late-game-economy.md
Leads to: an HTML UI layer, then a 3D renderer (see "Toward 3D" below)

## Decisions (chosen with the founder)

- **Stacked floor plans:** each floor is its own top-down grid, as in Two Point Hotel or The Sims, not a SimTower side cross-section. Picked because it maps directly to 3D: floors are stacked plates you can cut away.
- **Simulation first:** this milestone makes floors real in the simulation and adds a floor switcher to the existing 2D view. Moving the UI to HTML and building a 3D renderer come later.

## What changed

**Floor plan.** `GRID` shrank from 20×15 (300 tiles) to 8×5 (40 tiles), so a growing hotel has to build upward. Tiles grew from 32px to 64px, so the grid keeps its old on-screen width. Rooms, facilities, and construction noise all carry a `floor` (0 = ground).

**Building upward.** `buildFloor` adds a floor on top. The first floor above ground costs $15k, each further floor costs 1.35× the last, and the limit is 8 floors (`FLOORS`). Higher rooms get a +4%-per-floor view premium on their fair price, through `getExpectedPrice(type, stars, floor)`.

**Elevators.** An elevator is a shaft occupying the same tile on every floor, including floors built later (`state.elevators`, `addElevator`):
- **Placement:** the tile has to be free on every built floor.
- **Access:** upper-floor rooms can't be booked until there is at least one elevator. They render dimmed and the inspector says "No elevator!".
- **Capacity:** each elevator comfortably serves 16 upper-floor rooms. Past that, upper-floor guests take a review penalty of up to 2.0 at double the load. The story log can blame "elevator waits".
- **Costs:** $10k to build plus $25/day upkeep, scaled by prestige upkeep. Elevators count toward valuation along with floors.

**Noise.** A room hears its 8 same-floor neighbors as before, plus the rooms directly above and below at 25% strength. Packing rooms densely on 8×5 floors roughly doubled the average noise penalty. To compensate, the noise penalty threshold went from 0.5 to 0.8. Facility bonuses only reach rooms on the same floor.

**Room numbers.** The floor number comes first, followed by a two-digit unit counted across the floor plan. "101" is the first ground-floor tile, and "305" is the fifth tile on the third floor.

**UI.**
- **Floor stack:** a panel right of the build panel, ground floor at the bottom, with a room count per floor. Click a floor (or press PageUp/PageDown) to view and build on it. It has a "+ Floor N ($)" button on top and an elevator status line.
- **Build panel:** gains a SERVICE section with Elevator.
- **Hover check:** the placement preview now dry-runs the real build action (`tryBuild`), so the preview and the actual placement can never disagree.

**Saves.** v12 → v13 (`migrateToFloors`). The old 20×15 layout can't map onto 8×5 floors, so rooms and then facilities are re-packed in their old row-major order across as many floors as needed. A hotel needing more than one floor keeps tile (0,0) clear on every floor and gets a free elevator there, so upper rooms stay bookable. Ids are kept, so checked-in guests stay put.

## Balance

The bots now keep elevator tiles (0..2, 0) clear, build upward when the ground floor is full and they're still busy, and add elevators as upper floors fill. They also keep about 10 days of running costs in reserve. Before that change, one in 24 balanced runs went bankrupt in a winter cash crunch: demand drops to 0.6× while 4★ running costs stay flat.

`npm run simulate -- 400 24`:

| Strategy | Bankrupt | Stars at day 400 | Median valuation |
|---|---|---|---|
| balanced | 0% | 58% 5★, 42% 4★ | $1.66M |
| hoarder (never renovates) | 8% | 96% 4★ | $1.34M |
| upgradeOnly (never renovates) | 13% | 92% 4★ | $1.32M |
| marketOnly | 0% | 92% 4★ | $1.70M |
| greedy / idle | 100% | | |

Floors and elevators cost real money, so balanced play climbs more slowly than before. 5★ first arrives around day 397 (p90 day 452), versus about day 325 before. The 5★ owner-goal deadline moved from 420 to 480. Every balanced hotel settles at 2 floors (about 42 rooms) by day 500, because demand, not space, caps its size.

## Toward 3D

The simulation now has full 3D coordinates `(gridX, gridY, floor)`. A 3D renderer can draw stacked floor plates, with elevator shafts as vertical columns and upper floors cut away, without any simulation changes. The recommended next step is still moving the Phaser-drawn panels to HTML, so the renderer can be swapped without rewriting the UI.

## Known gaps

- **No elevator inspector:** clicking an elevator does nothing, so it can't be demolished from the UI yet. `demolishElevator` exists in the simulation.
- **No floor demolition:** you can't demolish or downsize floors.
- **Small debts are fatal:** bankruptcy is still a flat -$10k, harsh for a hotel worth over $1M that hits a slow winter. See TODOS.md.
- **Floor placement doesn't matter yet:** a ground-floor restaurant or a rooftop pool give no special bonus.
