# Design: Open Floor Plan and Room Doors

Date: 2026-10-10
Status: SHIPPED
Repo: DaeYi/Hotel-Management-Game
Follows: hallways-and-people.md (replaces its "hallways are built" rules)

## Request

The whole hotel should start as hallway, with rooms built on top of it. Keeping every room reachable through a door onto a hallway is the player's job.

## Decisions

- **Every free tile is hallway.** Nothing is built to make a hallway. Any tile on a built floor that has no room, facility, desk, closet, or break room on it is walkable hallway. Elevator shafts stay walkable too. Building takes a tile out of the hallway, and demolishing gives it back. New floors arrive as open hallway. The Hallway build option and its $300-per-tile cost are gone, and Bulldoze now clears desks, closets, break rooms, and elevator shafts.
- **Rooms have a door, and the player picks the side.** `Room.door` (`up` | `right` | `down` | `left`) is the only side a room can be entered from. A room is bookable, cleanable, and repairable only when the tile outside its door is hallway connected to the street. Rooms, desks, closets, and break rooms can't be walked through.
  - **While placing:** the build panel shows a door picker under the selected room type, and R rotates the door clockwise. The placement preview draws the door, in white when it opens onto a connected hallway and in red when it doesn't.
  - **Existing rooms:** the room inspector has a free "Door ↓ Turn" button that rotates the door.
  - **On the floor plan:** doors are drawn as a light bar on the room's edge, or a red bar when blocked. Rooms without access are also dimmed, and the inspector says "Door blocked: no hallway access!".
- **Blocked doors are allowed.** Building is never refused because of a door. Players can wall off rooms, or enclose a pocket of hallway with no route to the street, and the game shows the result instead of preventing it.
- **Facilities have doors too.** A gym, restaurant, pool, or shop gets a door when it's placed, chosen with the same picker and R key. It can be turned from its inspector. A facility with a blocked door is dimmed and its inspector says so. It earns no stars and gives nearby rooms no review bonus, but it still costs its upkeep.
- **Street entrances are the only way in.** An entrance is a buildable tile ($5,000) that has to go on the ground floor's outer edge. People walk through it, but nothing can be built on it. Every hotel starts with one free entrance at the left end of the second corridor, `(0,4)`. With no entrance, or with the entrance walled off, nothing in the hotel can be reached. Building more entrances gives more ways in, and guests use the one nearest a check-in desk. Bulldoze removes entrances.
- **Desks, closets, and break rooms still open on any side.** Staff stand at the tile in front of them (below first), which is their base for travel time.
- **Automatic doors are only for code paths with no choice to make.** When `addRoom` gets no door (tests, the headless simulator), it picks the first side, in the order up, down, right, left, that opens onto a connected hallway. The bots pass the template door explicitly: facing the template corridor.

## Saves

v15 → v16 (`openFloorPlan`):
- **Hallway tiles:** the old hallway fixtures are dropped, so every empty tile becomes hallway.
- **Doors:** each room's door faces a side that was hallway in the old save and connects to the street. If no side qualifies, it faces any open side, and failing that, down.
- **Rooms that used to work keep working,** with their doors on the corridor they used.

v16 → v17 (`addEntranceAndFacilityDoors`):
- **Entrance:** a free street entrance is added on the template tile if it's open. Otherwise it goes on the open edge tile nearest the desk.
- **Facility doors:** each facility's door faces the first side that opens onto a connected hallway.

## Implementation

- **`Layout.ts`:**
  - **Cache:** walkability, reachability, and travel times are cached per layout signature: floors, plus the positions of rooms (with doors), facilities, fixtures, and shafts. Rooms change status every tick, so caching by array identity no longer worked.
  - **Doors:** `findPath` and `getStaffTravelHours` enter and leave rooms only through the door.
- **Bots:** they no longer buy hallways, and they keep the template corridor rows clear, as before.

## Balance

Measured over 12 runs × 400 days:

| Strategy | Before | After |
|---|---|---|
| Balanced | $3.33M | $3.78M |
| Understaffed | $3.06M | $3.18M |
| Overstaffed | $1.95M, 8% bankrupt | $1.98M, 33% bankrupt |
| Hoarder | $1.38M | $1.38M |

Hallways are free now, so a well-run hotel ends richer. The strategies still rank in the same order.
