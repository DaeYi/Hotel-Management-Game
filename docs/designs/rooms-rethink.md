# Design: Rethinking Rooms (Exploration)

Date: 2026-10-11
Status: PHASE 1 SHIPPED (furnished rooms, 2026-10-11). Later phases are planned, not scheduled. Open owner questions are listed at the end.
Repo: DaeYi/Hotel-Management-Game
Follows: aligned-movement.md, open-floor-plan.md, late-game-economy.md
Depends on: the 11:00 checkout rebalance and guest outings, both in flight and uncommitted (`ECONOMY.checkOutHour: 11`, `GUEST_OUTINGS`, `OutingManager.ts`)

## Request

> I'd like to start thinking of ways to rethink rooms for customization and recategorization. Things like furniture (bed, TV, chair, wardrobe, etc) and bathroom and closet placement within a room. Deluxe rooms are maybe larger or have nicer amenities. Some rooms can support multiple people with multiple beds. Some rooms are suites with separate bedrooms within the rooms, etc.

Three approaches were written up independently and scored by three judges. This document combines them into one direction. It does not schedule any work.

## Owner decisions (2026-10-11)

1. **Bathroom, closet and furniture placement: both preset layouts and free placement.** Players can pick a ready-made arrangement or place items themselves. The free editor is now part of the plan (phase 2), not an optional last phase. The classifier therefore needs the hardening listed under risk 5: crowding penalties, a sleeps cap per tile, and property tests.
2. **Per-tile earnings: bigger rooms generally earn more per tile, depending on amenities, but it isn't guaranteed.** A big room that is well furnished out-earns small rooms per tile. A big room that is bare or cramped can earn less. Pricing is re-curved so that area pays only through what fills it (see Pricing). Legacy 1x1 rooms keep their exact numbers.
3. **Parties on screen: several people walking together.** A party is N figures on one itinerary: a leader with followers half a tile behind, and kids drawn smaller.
4. **Staff hiring: picking specific people** (see guest-staff-personalities.md). This is recorded here because parties and staff identity ship on the same roster and figure plumbing.

The open questions at the end are updated to match.

## Goals

1. **Furniture is real.** Beds, the bathroom, storage, seating, the TV and the desk are things in the room. They are drawn where they are, and they change what the simulation does: price, capacity, cleaning time and noise.
2. **Placement matters.** Where the bathroom and the closet go inside a room has a consequence the player can see. The main one is noise through shared walls.
3. **"Deluxe" can mean larger or nicer.** Both a bigger footprint and better furniture move a room up.
4. **Multi-bed rooms have demand.** Guests arrive as parties (solo, couple, friends, family, business), so twin and family rooms fill a real need and aren't just decoration.
5. **Suites have separate bedrooms.** A suite is a walled bedroom plus a living area, which needs more than one tile.
6. **Recategorize without demolishing.** A room changes category by refitting it in place, and the player sees a preview of the change first.
7. **Shown = simulated.** Every position inside a room comes from a leg the simulation planned and credited, as aligned-movement.md requires.
8. **Ready for 3D.** The same data in meters drives Phaser now and a 3D renderer later.
9. **Works on a phone.** Nothing requires precise dragging on a 36px tile.
10. **No accidental balance moves.** Each step is measured with `npm run simulate -- 400 24`. Migrated saves keep their numbers exactly.

Not goals for now: Sims-style free placement as the main way to play, L-shaped rooms, and resizing the 10x6 grid (that one is an open question).

## Where things stand (verified in the code)

- **Rooms.** A room is one tile with `type: RoomType` (`standard | deluxe | suite`) and a `door`. `ROOM_CONFIG` sets a build cost of $2k/$5k/$10k and a fair price of $80/$150/$250, unlocked at 1, 2 and 3 stars. The amenity tiers are per type, hotel-wide: `state.amenities: Record<RoomType, AmenityTier>`.
- **Space.** An upper floor in the bot template has 34 room tiles:
  - row 0: 6 tiles beside the elevators and the closet;
  - row 5: 10 tiles;
  - rows 2-3: a band two tiles deep and 9 wide.
- **Demand and budgets.**
  - Arrivals are (0.5 + 1.65 × √rooms) × the star demand multiplier.
  - A budget is uniform between $60 and $300, times the star price multiplier, and ×1.5 for big spenders.
- **Matching.**
  - `getAvailableRooms` sorts by price, cheapest first.
  - `matchGuestToRoom` takes the first room within budget and within fair price × tolerance.
  - In `processArrivals` (GuestManager.ts:149-182), `availableIdx = roomIdx + 1` means a later guest can never take a cheaper room that an earlier guest skipped.
- **Housekeeping.**
  - Turnover takes 2, 4 or 6 h by quality, and a daily clean takes 0.5 h. The shift runs 6:00-22:00. Checkout is moving to 11:00, and check-in runs 14:00-22:00.
  - `jobQueues` (StaffManager.ts) sorts turnovers soonest-finished first. The outing work already sorts daily cleans so rooms whose guest is out go first.
  - `estimateHousekeepingHours` (HousekeepingManager.ts:144) uses one turnover duration for every room.
- **Noise.**
  - Each room hears its 8 same-floor neighbors at full weight, plus the rooms directly above and below at 0.25.
  - Neighbors are found with `state.rooms.find(r => … r.gridX === nx …)` (NoiseManager.ts:23, :80).
  - `GridRenderer.renderNoise` recomputes this for every room on every frame.
- **Star points.** The deluxe-or-suite share is worth ×2 and the suite share another ×2. A hotel gets +0.5 at 10 rooms and +0.5 more at 20.
- **What multi-tile rooms would touch.** This was measured, and it is smaller than Approach A's estimate of 88 references:
  - five room position-equality lookups in four files: NoiseManager twice, `HotelState.isTileOccupied`, `GameController.tileDown`, and `doorOk` in `Movement.stepStillOpen`;
  - two copies of `roomTile`: GuestMovement.ts:24, which FacilityManager and OutingManager also import, and StaffManager.ts:130;
  - 23 uses of `rooms.length` and 21 of `room.type`;
  - three exact-anchor assertions in `test/alignment.test.ts` (lines 60, 115 and 146);
  - GridRenderer.
- **Tests.** There are about 288 tests, and the headless simulator calls `addRoom(state, type, …)`.

## The three approaches

- **A: multi-tile footprints, a sub-grid interior, and parties.**
  - Footprints are 1x1, 2x1, 1x2 or 2x2. Each tile has a 4x4 sub-grid of 1 m cells for furniture and interior walls.
  - The building graph sees a multi-tile room only as the footprint tile that carries its door, so routing stays the same.
  - Guests become parties in phase 1. Category is derived on two axes, tier and bed configuration.
  - It ships presets first, then a free editor.
- **B: one tile per room, with a free 4x4 interior.**
  - Interiors are stored in door-local coordinates, so turning a door rotates the interior with it. Wall items (TV, art, mirror) take no floor cell.
  - `classifyRoom` is the single source of truth, and `room.type` stays as a derived compatibility field. Legacy templates are calibrated so migration changes no numbers.
  - Parties wait until phase 3, and multi-tile rooms and real suites until phase 4.
- **C: modular rooms.**
  - Authored templates have fixed bays. Each bay holds a module with a variant and a tier from 1 to 3.
  - Players swap variants and step tiers in place, and see a before/after preview first. "House standards" apply a spec to every room of a template.
  - Price is continuous in quality, and party kind is rolled with `hash01`. Furniture is never placed freely: the player picks from 2-3 authored arrangements.

### Judges' scores

There were three judges. J1 weighted fun, J2 weighted engineering fit and risk, and J3 weighted 3D and phone use. Cells show J1 / J2 / J3, with the average in brackets. For Scope, higher means smaller and safer.

| Approach | Fun | Fit | Future 3D | Phone UX | Scope | Sum of averages |
|---|---|---|---|---|---|---|
| A: footprints + sub-grid + parties | 9 / 8 / 8 (8.3) | 7 / 7 / 6 (6.7) | 9 / 8 / 8 (8.3) | 6 / 6 / 6 (6.0) | 3 / 4 / 3 (3.3) | 32.7 |
| B: one tile, free interior, multi-tile last | 5 / 7 / 5 (5.7) | 8 / 7 / 6 (7.0) | 8 / 7 / 5 (6.7) | 6 / 7 / 7 (6.7) | 6 / 6 / 6 (6.0) | 32.0 |
| C: authored bays + tiered modules | 7 / 6 / 6 (6.3) | 8 / 8 / 8 (8.0) | 8 / 7 / 7 (7.3) | 8 / 8 / 8 (8.0) | 6 / 7 / 7 (6.7) | 36.3 |

**All three judges agreed on these points:**
- Don't adopt any approach whole.
- A's invisible "phase 0" footprint plumbing goes first, proven by a byte-identical golden run.
- Multi-tile rooms are needed to deliver the request, so B's "single tile until phase 4" order is out.
- C has the best fit, migration discipline and phone UX.
- Legacy rooms should be calibrated exactly (B/C), not given price pins (A).
- Parties are rolled with `hash01`, unservable party types produce only a soft trickle of turn-aways, and matching uses a taken set.
- `jobQueues` must stop starving big rooms after an 11:00 checkout.

**They disagreed on these:**
- **Ordering.**
  - J1: parties first, then footprints.
  - J2: furnished 1x1 rooms with no balance change, then footprints and parties behind flags.
  - J3: footprints, parties and C's remodeling all in phase 1.
- **Positions inside a room.** J1 accepts B's `inRoomSpot()`, a pure function of time. J2 and J3 require planned legs.
- **The legacy 1x1 suite.** It could stay buildable as C's "Executive Studio", or not.

## Recommended direction

**In one line: C's player verbs, on A's spatial spine, using B's coordinate frame and migration discipline.**

1. **One representation from day one.** A room's interior is a list of furniture items on a door-local 1 m sub-grid, 4x4 cells per tile (A/B).
   - A preset is an authored item list with named **slots** (C).
   - Players act on slots: swap a variant, step a tier, pick an arrangement.
   - A free editor, if it ever ships, edits the same items, so it needs no migration and 3D gets a single source.
2. **A's phase 0 first, and invisible.** Add the footprint fields, a `roomAt` tile index, `roomEntry()`, `keyCount()` and the `layoutKey` extension. Gate it on byte-identical seeded runs.
3. **Category is always derived, on two axes:** layout class (who it fits) and grade (how nice).
   - Fair price is continuous in furniture quality (C), so a grade change is a label, not a price cliff.
   - The only manual control is a downward "list as" (A).
4. **Exact legacy calibration (B/C).** A migrated room keeps its fair price, star points, turnover hours, build cost and valuation, all enforced by a test.
   - The legacy suite becomes C's Executive Studio, which classifies honestly as a junior suite. No pin flag is needed.
5. **Parties behind `PARTIES.enabled`,** rolled with `hash01` (A+C).
   - Every per-person scaling is normalized so that solo and couple bookings reproduce today's numbers.
   - A "guest" today is really a 1-2 person booking, so only parties of 3 or more scale anything up.
6. **Every position inside a room is a planned leg** (A's `TilePos.sub`, C's `StayLeg.slot`). Time-only choreography is rejected for anything shown moving. That honors J2 and J3, and it is what 3D will need anyway.
7. **Presets and free placement, both (owner decision).** Presets ship first (phase 1). The free editor follows in phase 2, editing the same item list, with the classifier hardened for it. Bigger rooms (footprints) arrive in phase 3.
8. **Bulk tools ship with the first per-room choice.** House standards with "Apply to all N rooms" come in phase 1, not later.

Each phase changes one balance-relevant thing, behind a flag where it can be. That is J2's rule, and it is why parties (phase 2) and footprints (phase 3) don't land together, which was A's bundling problem.

### The per-tile economics problem (decided: area pays through amenities)

Today a 1x1 tile earns $80, $150 or $250 a night as standard, deluxe or suite. Budgets cap absolute prices: at 3 stars a guest's budget is $81-$405, or up to $607 for a big spender.

So a 2x2 suite cannot charge four times a 1x1 suite. With the curve below, multi-tile rooms earn about $75-$130 per tile at fair price, against $150 for a legacy 1x1 deluxe and $250 for a 1x1 Executive Studio. Price alone won't make big rooms worth building. They have to win through:
- **Segments 1x1 rooms can't serve:** families and friends, with larger budgets for parties of 3 or more.
- **Area-weighted star points.**
- **Lower running costs per tile:** one key's operating cost, consumables, check-in slot and elevator load spread over more area.
- **Reviews:** space per person and room fit.

There are two consequences:
- The Executive Studio must leave the build menu when real suites ship. Existing ones keep their exact numbers. Otherwise it beats every multi-tile suite per tile forever.
- **Decided by the owner:** bigger rooms should generally earn more per tile, depending on their amenities, without a guarantee. So area is priced through what fills it. In the Pricing section's formula, the area term is multiplied by the room's furnishing quality. A well-furnished 2x1 or 2x2 room earns more per tile than a 1x1. A bare or cramped one earns less. Legacy 1x1 rooms keep their exact numbers, so existing hotels don't change overnight.

## Data model sketch

```ts
// ---- src/config/rooms.ts: plain data, no Phaser. Read by the simulation, Phaser,
//      the Preact inspector's SVG plan, and later the 3D renderer. ----
export const ROOM_GRID = { sub: 4, tileMeters: 4 } as const; // 4x4 cells per tile, 1 m each.
// Power of two: moving to 8x8 later is a lossless coordinate doubling.

export type Tier = 1 | 2 | 3;                    // finish: basic / premium / luxury (a material set in 3D)
export type FurnitureKind =
  | 'bed_single' | 'bed_queen' | 'bed_king' | 'bunk' | 'sofa_bed' | 'crib'
  | 'bath_shower' | 'bath_tub' | 'bath_spa'      // enclosed blocks with their own door edge
  | 'rail' | 'wardrobe' | 'walk_in'              // walk_in is enclosed
  | 'armchair' | 'sofa' | 'desk' | 'minibar' | 'kitchenette'
  | 'tv' | 'art' | 'mirror';                     // wall-mounted: take no floor cell (B)

export interface FurnitureSpec {
  label: string;
  group: 'sleep' | 'bath' | 'storage' | 'living' | 'work' | 'decor';
  size: [w: number, h: number];                  // cells at rot 0 (queen/king 2x2, bath 2x2, single 1x2, sofa 2x1)
  mount: 'floor' | 'wall';
  enclosed?: boolean;                            // walls + inner door; forms a zone
  sleeps?: number; sharedBed?: boolean;          // a queen sleeps 2 only for couples and families
  seats?: number;
  gradeWeight: number;                           // bed 3, bath 3, living 2, storage / work / decor 1
  buffer?: number;                               // 0-1 (phase 4): noise absorbed through a wall it lines
  cleanHours: number; dailyCleanHours: number;   // at tier 1, standard quality
  cost: [number, number, number];                // per tier
  installHours: number;                          // refit downtime (bath 8, bed 2, tv 0.5)
  requiredStars: [number, number, number];       // tier 2 at 2 stars, tier 3 at 4; living pieces at 3
  useCell: [dx: number, dy: number]; facing: Direction;     // where a person uses it; rotates with the item
  pose: 'sleep' | 'sit' | 'stand' | 'wash';
  glyph: GlyphPrim[];                            // 2D drawing as data in cell units: Phaser and SVG draw the same thing
  model: string;                                 // 3D mesh id; tiers are material swaps
}
export const FURNITURE: Record<FurnitureKind, FurnitureSpec>;

export interface SlotSpec {                      // where furniture may go while a room follows its preset
  id: string;                                    // 'bed' | 'bed2' | 'bath' | 'storage' | 'furnish' | 'living'
  rect: { x: number; y: number; w: number; h: number };     // door-local cells
  accepts: FurnitureKind[];
  required: boolean;                             // every room has a bed and a bath
  zone?: 'bedroom' | 'living' | 'bath';
}
export interface RoomPreset {
  id: PresetId;      // P1: classic_queen, compact_deluxe, exec_studio (legacy)
                     // P2: twin, bunk_family
                     // P3: wide_king (2x1), family_two_queens (2x1), junior_suite (2x1), suite_1br (2x2), family_suite (2x2)
  label: string;
  footprint: { w: 1 | 2; h: 1 | 2 };             // tiles, door-local: the door is on the local bottom edge
  doorSlots: number[];                           // bottom-edge tiles allowed to carry the door (C): the door can't wander
  arrangements: Array<{ id: string; label: string; slots: SlotSpec[]; walls: SubEdge[] }>;
                                                 // 'bath by the door' / 'bath at the back'; suites get pre-drawn bedroom walls
  defaults: FurnitureItem[];
  shell: { cost: number; cleanHours: number };
  requiredStars: number;
  buildable: boolean;                            // exec_studio: false once real suites ship (open question)
}

// ---- src/simulation/types.ts ----
export interface FurnitureItem {
  id: string;                                    // stable within the room: 'bed', 'bath', 'tv-0'
  kind: FurnitureKind; tier: Tier;
  x: number; y: number; rot: 0 | 1 | 2 | 3;      // door-local cells
  slot?: string;                                 // set while the room follows its preset; the free editor (P5) clears it
}
export interface SubEdge { x: number; y: number; dir: 'h' | 'v' }   // a wall on the top (h) or left (v) edge of a cell

export interface Room {
  id: string;                                    // unchanged `room-{floor}-{x}-{y}`; anchor = top-left world tile
  gridX: number; gridY: number; floor: number;
  door: Direction;                               // existing field; now also the rotation (local bottom faces this way)
  preset: PresetId; arrangement: string; mirrored: boolean; doorSlot: number;
  w: number; h: number;                          // world footprint (preset rotated by door); stored so the tile index needs no profile
  items: FurnitureItem[];
  walls: SubEdge[];                              // from the arrangement; editable only in P5
  type: RoomType;                                // DERIVED compatibility bucket, rewritten by profileRoom; readers migrate off it
  listedAs?: RoomType;                           // optional, downward only
  pendingRefit?: { preset?: PresetId; arrangement?: string; mirrored?: boolean;
                   items: FurnitureItem[]; cost: number; installHours: number };   // runs when next vacant
  // unchanged: pricePerNight, condition, cleanliness, status, guestId, cleaningHoursRemaining,
  // lastDailyCleanDay, decor, renovationHoursRemaining (a refit reuses status 'renovating'), dailyCleanHoursRemaining
}

// ---- src/simulation/RoomProfile.ts: derived, never saved; memoized per
//      (preset, arrangement, mirrored, door, doorSlot, items signature), like Layout's signature cache ----
export type LayoutClass = 'single' | 'double' | 'twin' | 'family' | 'junior_suite' | 'suite';
export type Grade = 'standard' | 'deluxe' | 'luxury';
export interface RoomProfile {
  tiles: Pos[]; entry: TilePos;                  // entry = the footprint tile carrying the door, plus its side
  layoutClass: LayoutClass; grade: Grade; label: string;   // "Deluxe Twin", "One-Bedroom Suite"
  quality: number;                               // weighted tier average, 1-3 (excludes size)
  gradeScore: number;                            // quality + size bonus - crowding penalty
  sleeps: number; sleepSpots: Array<SubPos & { shared: boolean }>;
  bathrooms: number; enclosedBedrooms: number; hasLiving: boolean; hasDesk: boolean; hasTV: boolean;
  freeFraction: number;
  fairBase: number;                              // before the star multiplier and view premium
  turnoverHours: Record<CleaningQuality, number>; dailyCleanHours: number;
  cleanPlan: Array<{ slot: string; hours: number }>;        // order a housekeeper works: bath, beds, the rest
  zones: Array<{ kind: 'bedroom' | 'living' | 'bath' | 'open'; cells: SubPos[] }>;
  wallBuffer: Record<Direction, number>;         // world frame, after rotation and mirror (P4)
  anchors: { entry: SubPos; sleep: SubPos[]; sit: SubPos[]; wash: SubPos[]; work: SubPos[] };
  anchorGraph: Array<[from: string, to: string, hours: number]>; // tiny per-preset walk graph (C), not an in-room A*
  starPoints: number; investedCost: number;
  issues: Array<{ code: 'no_bed' | 'no_bath' | 'landing_blocked' | 'unreachable' | 'overlap' | 'cramped'; itemId?: string }>;
  legacyType: RoomType;
}
export function profileRoom(room: Room): RoomProfile;
export function toWorld(room: Room, cell: SubPos): { x: number; y: number }; // continuous tile coordinates:
// one transform for the simulation, Phaser, SVG and 3D (B's toWorldCell, C's bayWorldRect)

// ---- Layout.ts (phase 0) ----
function footprintTiles(room: Room): Pos[];
function roomAt(state: HotelState, x: number, y: number, floor: number): Room | undefined; // tile index, cached per layoutKey
function roomEntry(room: Room): TilePos;         // replaces both roomTile copies; equals roomTile for every 1x1 room
function keyCount(state: HotelState): number;    // rooms.length where it means "keys"
// layoutKey() adds w, h, doorSlot

// ---- parties (phase 2) ----
export type PartyKind = 'solo' | 'business' | 'couple' | 'friends' | 'family';
interface Guest { /* … */ party: { kind: PartyKind; size: number } }   // one Guest = one booking; rolled with hash01(id + 'party')
interface Walker { /* … */ partySize: number }
interface ReturningGuestProfile { /* … */ partyKind?: PartyKind; roomLabel?: string }

// ---- movement (phase 1b / 4) ----
interface TilePos { /* … */ sub?: SubPos }       // where in the room, planned by the simulation and saved in the leg
interface StayLeg { /* … */ slot?: string }      // which slot a housekeeper is cleaning (checked by the alignment test)

// ---- HotelState ----
roomStandards?: Partial<Record<PresetId, { arrangement: string; items: FurnitureItem[] }>>; // house standards
```

## How categories are derived

The player never picks a category. They pick a preset and furniture, and `profileRoom` says what the room is. The rules live as data in balance.ts and are checked in order.

**1. Bookable.** A room needs all of the following. Otherwise it is built but unbookable, shown dimmed with a checklist, the same way a blocked door is shown today.
- at least one bed;
- a reachable bath block (a room of 2 or more tiles may have two);
- the door landing cell kept free;
- every item's use cell reachable from the landing.

Presets always pass these checks, and a unit test enumerates every preset × arrangement × variant. The rules matter for players only once the free editor exists, which then inherits a classifier that has already been tested.

**2. Layout class (who it fits).** This answers the request's "family" and "multi-bed".
- **suite:** an enclosed bedroom (walls plus an inner door), and a living area outside it with a sofa or two seats plus a TV. In practice this needs 2x2.
- **junior_suite:** a living area but no enclosed bedroom. This covers the 2x1 Junior Suite and the legacy 1x1 Executive Studio.
- **family:** sleeps 3 or more (two queens, queen plus sofa bed, bunk plus queen).
- **twin:** two or more separate beds, sleeping 2.
- **double:** one queen or king bed. **single:** one single bed.

**3. Grade (how nice).**
- `quality` = Σ(tier × gradeWeight) / Σ gradeWeight over the slotted items.
- `gradeScore` = quality + size bonus (+0.75 at 2 tiles, +1.0 at 4 tiles), minus crowding (any room with less than 25% free floor is capped at standard).
- The thresholds are standard below 1.75, deluxe from 1.75 to 2.6, and luxury at 2.6 and above.
- That gives both meanings of deluxe:
  - **Larger:** a tier-1 room of 2x1 scores 1.75.
  - **Nicer:** a 1x1 room with its bed and bath at tier 2 scores (3·2 + 3·2 + 1 + 1)/8 = 1.75.

**4. Label.** The label is grade + class + bed: "Standard Queen", "Deluxe King", "Deluxe Twin", "Family Room (sleeps 4)", "Junior Suite", "One-Bedroom Suite", "Luxury Family Suite". Players can rename a room; the name is cosmetic.

**5. Compatibility bucket.** `room.type` is derived as follows:
- suite or junior_suite → `suite`;
- grade deluxe or better → `deluxe`;
- otherwise → `standard`.

Amenity tiers, the legend, stories and returning guests keep reading it until they are ported.

**6. List as.** Downward only, for example selling a suite as deluxe in winter. It takes the lower bucket's fair price and star contribution. Listing upward is never possible, so stars can't be faked.

**7. Unlocks move to furniture.** Tier 2 and the king bed unlock at 2 stars, and living pieces at 3, matching today's deluxe and suite gates. Tier 3 unlocks at 4 stars (new: luxury). Multi-tile presets unlock at 2 stars, and suite presets at 3.

**8. How a room changes category.** There is one staged flow:
- the player swaps a variant (queen → twin beds makes a Twin; adding a sofa bed makes a Family Room), steps a tier, changes the arrangement on the same footprint, or applies a house standard;
- a sticky preview shows before → after for label, fair price, star share, sleeps, turnover hours, cost and downtime;
- the change applies now if the room is vacant (status `renovating` for Σ installHours, with construction noise), or it is queued as `pendingRefit` to run after the next checkout.

Changing a footprint means demolishing and rebuilding. A later "combine two 1x1 rooms" remodel is possible.

## Simulation effects

Every number below is illustrative, to be tuned against the current balanced, understaffed, overstaffed and hoarder baselines once the 11:00 checkout rebalance has landed.

### Party size and capacity (phase 2, behind `PARTIES.enabled`)

- **Rolling parties.** One `Guest` is one booking, with `party: { kind, size }` rolled with `hash01(guest.id + 'party')` (C). The shared PRNG sequence doesn't move, so before/after runs stay comparable.
- **The mix (illustrative):**
  - Weekdays: solo 35%, business 20%, couple 30%, friends 5%, family 10%.
  - Weekends: couple 40%, family 25%, friends 15%, solo 15%, business 5%.
  - Summer moves about 10 points from solo to family.
- **Matching.**
  - Hard filter: `sleeps ≥ size`, and a bed arrangement the party accepts. Friends and business never share a bed; couples and families can; cribs are free for families.
  - Then cheapest-first, as today, with a **taken set** instead of the `availableIdx` scan (B).
  - A party won't pay more than 1.25× the fair price of the cheapest class that fits it (C), so solo guests don't pay family-room rates.
- **Unservable segments.** If no room in the hotel could ever fit a party kind, 75% of those arrivals are re-rolled as solo or couple bookings with `hash01`, and 25% become named turn-aways ("The Okafor family was turned away: no rooms for four"), with a GameEvent and a story beat (C).
  - Total demand doesn't fall, so a hotel with only 1x1 rooms isn't punished the day parties ship.
  - The reward for family rooms is serving those families at their larger budgets.
- **Normalization rule.** Today's guest is a 1-2 person booking. Budgets, consumables, noise, wear, elevator load and facility load are scaled so solo and couple bookings reproduce today's values. Only parties of 3 or more scale up:
  - **budget** ×1.35 / ×1.6 / ×1.8 for 3 / 4 / 5+;
  - **consumables, cleanliness and condition decay, noise output** × (1 + 0.3 × max(0, size − 2));
  - **facility visits** sum people (`overlappingVisits`), with facility capacities rescaled by the average party size so existing hotels aren't suddenly over capacity;
  - **elevator load** counts upper-floor people against a rescaled `roomsServed` (about 30 people for today's 16 rooms).
- **Check-in** stays one slot per party, so desk lanes and the alignment test don't change.
- **One review per booking,** as today.
- **Outings:** the whole party leaves and returns together, as one trip.
- **Room moves:** `findHealthySameTypeRoom` becomes "vacant, fits the party, same class or better".

### Pricing

- `getExpectedPrice(room, stars)` reads `profile.fairBase` × the star multiplier × the view premium. The price slider becomes 0.4×–2.5× fairBase instead of `ROOM_CONFIG` min/max.
- `fairBase = CLASS_BASE[class] × (1 + 0.875 × (quality − 1)) + AREA_RATE × (tiles − 1) × amenityFactor`
  - CLASS_BASE: single 60, double 80, twin 85, family 100, junior_suite 133, suite 160.
  - AREA_RATE: about 110, so a well-furnished big room clears a 1x1 per tile.
  - `amenityFactor` scales with how well the extra area is furnished: `0.4 + 0.6 × (quality − 1) / 2`, with a further ×0.6 for a cramped room (under 25% free floor) or a sparse one (under 1 item per tile of living or comfort furniture).
  - Grade is a label; only quality, class and area move the price, so there are no cliffs.
  - **Target (owner decision):** a tier-2 or tier-3 big room earns more per tile than a 1x1 deluxe. A tier-1 or sparse big room earns about the same or less. Tune the constants in the phase 3 harness against this, not against the illustrative table below.

| Preset (phase) | Footprint | Sleeps | Tier | Derived label | Fair base | Per tile |
|---|---|---|---|---|---|---|
| Classic Queen (P1, legacy standard) | 1x1 | 2 | 1 | Standard Queen | $80 | $80 |
| Compact Deluxe King (P1, legacy deluxe) | 1x1 | 2 | 2 | Deluxe King | $150 | $150 |
| Executive Studio (P1, legacy suite) | 1x1 | 2 | 2 | Deluxe Junior Suite | $250 | $250 |
| Twin (P2) | 1x1 | 2 | 1 | Standard Twin | $85 | $85 |
| Bunk Family (P2) | 1x1 | 4 | 1 | Standard Family | $100 | $100 |
| Wide King (P3) | 2x1 | 2 | 1 → 2 | Deluxe King (by size) | $150 → $220 | $75 → $110 |
| Family Two Queens (P3) | 2x1 | 4 | 1 | Deluxe Family | $170 | $85 |
| Junior Suite (P3) | 2x1 | 2+1 | 1 | Deluxe Junior Suite | $203 | $101 |
| One-Bedroom Suite (P3) | 2x2 | 2+1 | 1 → 2 | One-Bedroom Suite | $370 → $510 | $92 → $128 |
| Family Suite (P3) | 2x2 | 5 | 1 | Family Suite | $385 | $96 |

The per-tile column is the problem described in "The per-tile economics problem". Calibrating legacy rooms exactly keeps 1x1 rooms on top per tile.

### Build and running costs

- **Build cost and invested cost:** the shell plus the items' tier costs. Calibrated legacy presets total exactly $2k, $5k and $10k. Valuation, renovation (25% × invested × star multiplier) and the demolish refund all read `investedCost`.
- **Operating cost:** `dailyOperatingCostPerRoom × tiles^0.85`.
- **Refit cost:** the cost of the new items, minus 50% resale of removed items, × an **install premium** (about 1.25), plus offline install hours.
  - Without the premium, upgrading in place ($3k) is cheaper than today's rebuild ($5k minus a $500 refund). Bots and players would then reach the 5-star deadline (day 420) sooner (C/J2).

### Cleaning time (sized for the 11:00 checkout)

- **Turnover** = (shell + Σ item cleanHours) × quality factor (0.5 / 1 / 1.5). Legacy 1x1 rooms reproduce today's 1 / 2 / 3 h exactly (after the 11:00 checkout rebalance); the nook's clean hours on the Executive Studio are set to 0 for parity.
- **Daily clean** = Σ dailyCleanHours, which is 0.5 h for every legacy room.
- **Bigger rooms** take about 3 h (2x1 family) and 4 h (2x2 suite) at standard quality, on today's scale.
  - A suite checked out at 11:00 and started at once is ready around 15:00-16:00, so it misses the first arrivals but catches most of the afternoon.
  - That is a real but moderate cost, until crew cleaning ships in phase 4.
- **Fixes made urgent by the checkout move:**
  - Done in the checkout rebalance: `estimateHousekeepingHours` no longer books daily cleans for guests leaving that day.
  - Still to do, with this feature: `jobQueues` sorts turnovers soonest-finished first, which starves big rooms. Prioritize rooms needed for today's arrivals, then value per hour remaining. `estimateHousekeepingHours` must also sum per-room profiles, or the bots and staffing advice will under-hire once rooms vary.
- **Visible per-slot cleaning (phase 1b).** The housekeeper's stay is split into sub-stays following `cleanPlan` (bath → beds → rest), derived from hours already done, so no new progress is saved. `StayLeg.slot` lets the renderer draw them there and lets the alignment test check it.
- **Crew cleaning (phase 4).** Up to one housekeeper per zone. The `claimed` set becomes zone-scoped, and the alignment test's "one worker per room" becomes "one per zone". Drawn as a visible team.

### Noise

- **Phase 3 (footprints).**
  - Neighbors are every tile around the footprint minus its own, plus the tiles above and below, found through `roomAt`. They are aggregated per neighboring place at its maximum weight, so a 2x2 neighbor counts once.
  - Multi-tile rooms hear noise only at their sleep tiles, so bigger rooms aren't louder just for having more perimeter.
- **Phase 4: heard at the bed (A).**
  - Each contact is attenuated by 1 / (1 + 0.25 × the cell distance from the shared wall to the nearest sleeping spot), and by × (1 − buffer) where a bath, closet or wardrobe lines that wall. Illustrative buffers: closet 0.3, bath 0.25, wardrobe 0.2.
  - A suite bedroom away from the corridor is quiet. A twin with its beds against a party guest's wall is not.
  - The guest is drawn in that bed at night, so the place where noise is measured is the place the player sees.
- **Consistency.** `getLoudestNeighborGuestId` uses the same weights, so the culprit stays consistent. `renderNoise` reads memoized profiles.
- **The phase-1 arrangement choice** (bath by the door or at the back) is cosmetic until phase 4. The inspector must not imply otherwise.

### Star points

- **Phase 1:** the formula is unchanged and reads the compatibility bucket.
- **Phase 3:** star points become per room and are averaged, **weighted by tiles**, then capped at 4 as today:
  - grade points: standard 0, deluxe 2, luxury 2.5;
  - class points: family 0.25, junior_suite 2, suite 2.5.
  - With only 1x1 rooms this reproduces today exactly: standard 0, deluxe 2, Executive Studio 4.
  - Area weighting is what keeps big rooms from being traps.
- **Keys:** the room-count thresholds (10 and 20) and the "Build 8 rooms" goal use `keyCount`.
- **Hints:** `getNextStarRequirements` hints become things like "Upgrade beds and baths in 6 rooms (→ Deluxe)".

### Guest preferences (hooks for the parallel personality list)

- **Interface.** A guest carries `prefs: Partial<Record<RoomFeature, number>>`, built from the trait list plus party kind.
  - `RoomFeature` is read straight off the profile: desk, tub, kingBed, twinBeds, enclosedBedroom, living, kitchenette, quietBed, spacePerPerson.
  - `roomFit = clamp(Σ weight × feature, −1, +1)` is a new review term. It also feeds StoryGenerator's satisfaction target, so mood drift agrees with the review.
- **Examples:**
  - business wants a desk (+0.3; −0.3 without one);
  - couples dislike twins (−0.4);
  - families like a sofa bed or tub (+0.3);
  - big spenders expect deluxe or better at 3 stars and above;
  - party guests like a living area;
  - light sleepers like an enclosed or quiet bed (phase 4).
- **Phase 2:** preferences are review-only. Whether they also steer matching or reject rooms at the desk is an open question.

### Later depth (phase 6)

- **Per-item wear.** A broken TV lowers appeal and becomes a short maintenance job and a story beat ("the TV in 304 died during the match"). Only a broken bed or bath puts the room out of order.
- **Minibar** sales are credited while the guest is in the room.
- **Kitchenettes** cut restaurant visits and please families and long stays.
- **Connecting rooms.**

## Building and customizing UX

### Desktop

- **Build panel (phase 1).**
  - ROOMS lists preset cards instead of three types.
  - Each card shows an SVG thumbnail drawn from glyph data, footprint, "sleeps N", the starting label, cost, fair $/night, and a star lock.
  - Placing a 1x1 room works as today; the door picker and R rotate the whole preset.
- **Room inspector (phase 1).**
  - A "Room" section with an SVG plan whose slots can be clicked.
  - One row per slot ("Bed: King, tier 2 of 3"), with a Change ▾ (variants that fit the slot) and a tier stepper.
  - An arrangement picker (bath by the door / at the back, Mirror).
  - A sticky before → after summary.
  - The buttons "Refit now ($X, Yh offline)" or "After checkout", "List as ▾" (downward only), and "Apply to all N Classic Queens ($total)".
- **House standards (phase 1).**
  - The Amenities panel becomes "Rooms & Amenities". Per preset, the player edits a standard spec and applies it to every room of that preset.
  - Vacant rooms start now, and occupied rooms queue until after checkout.
  - Per-room changes are for exceptions, such as the quiet corner room.
  - This is required at 40-80 rooms. With it, most hotels will look uniform unless per-room choices have stakes: family demand, quiet walls, stars.
- **Multi-tile placement (phase 3).**
  - The ghost covers the whole footprint with ghosted furniture and the door.
  - The door is white when it opens onto a connected hallway and red otherwise, and any blocked tile gets a red X.
  - The pointer anchors to the footprint's center.
  - R rotates, F mirrors, and [ / ] move the door between authored `doorSlots`.
  - The preview keeps dry-running the real `tryBuild`, so preview and result can't disagree.
- **Free editor (phase 5, optional).**
  - Preact/SVG, not Phaser: accessible, testable with happy-dom, and it survives the 3D swap.
  - Built on the same items.
  - Uses B's details: door-local cells, wall items, live label and issues, a crowding meter, staged edits with undo, and "Apply refit" showing the tier and price change.
  - "Save as design" and "Apply to matching rooms" are mandatory parts of it.

### Phone (≤760px, about 36px per tile, about 9px per cell)

- **Map.** Level of detail: below about 10px per cell, draw only the class color, grade pips and the sleeps number. All detail lives in the HTML inspector plan.
- **Inspector.** A full-width bottom sheet instead of the TileCard beside the tile, which can't fit a 2x2 room. Slot rows are 44px tap targets with steppers and a variant sheet. The before → after summary is pinned above Confirm.
- **Multi-tile placement (phase 3): ghost then confirm.**
  - Tap a preset, then tap a tile to drop a ghost. Nothing is built yet.
  - A bar offers Rotate, Mirror, Door ←/→, Build $X and Cancel.
  - Dragging moves the ghost.
- **Free editor (phase 5).** A full-screen sheet with select-then-tap and no drag. A 1x1 room fills the width at about 80px cells; a 2x1 room is shown portrait (4x8); cells are aria-labelled buttons.
- **Main path.** Presets, steppers and house standards are the main path on a phone. Free editing is secondary.

### Controller API

Every action goes through `apply()`/`settle()`, so trips re-route as today. Bots and tests use the same calls:
- `placeRoom({ preset, anchor, door, doorSlot, mirrored, arrangement })`
- `stageRefit(roomId, change)`
- `commitRefit(roomId, 'now' | 'checkout')`
- `setListedAs(roomId, type)`
- `setRoomStandard(preset, spec)`
- `applyRoomStandard(preset)`

`addRoom(state, type, x, y, floor, door)` stays as a wrapper that maps to the legacy presets.

## Rendering: 2D now, and the 3D path

### 2D (Phaser, `src/render`)

- **`renderRooms`.**
  - Draws a footprint as one rectangle, with no inner grid lines.
  - Class shows as a floor tint and grade as the outline or pips, replacing today's solid type fill, so furniture stays readable.
  - The door bar sits on the door-slot tile's edge, and interior walls are 2px lines.
  - Status (cleaning, renovating, out of order), the condition bar, the stale-decor strip and construction move from per tile to per footprint.
  - The room label stays on the anchor, so room numbers never change.
- **Furniture glyphs** are drawn from `FurnitureSpec.glyph`, the same data the inspector SVG uses.
  - Today `renderRooms` clears and redraws everything every frame. Each interior should be cached in a RenderTexture keyed by profile signature, with only the status tint and bars drawn per frame. That cache is required, not optional.
- **`ActorLayer`.**
  - Party members are N figures on one itinerary, offset with the existing SEATS/`hash01` logic.
  - In phases 1-3, guests in their room are drawn at the room's single in-room anchor. That is honest: the simulation says "in room".
  - In phase 1b, housekeepers are drawn at their `StayLeg.slot`.
  - In phase 4, guests' in-room legs carry `TilePos.sub`, and `positionAt` maps it to continuous coordinates through `toWorld`. They are drawn in the bed at night, at the sink in the morning, and on the sofa in the evening. Short walk legs between anchors follow the preset's anchor graph.
  - The renderer never chooses a spot itself.

### 3D (later)

- **Units:** a tile is 4 m, a cell 1 m, a floor about 3 m. A 1x1 room is 16 m², a realistic compact double. Furniture scale is stylized: a 2x2 m queen is generous.
- **Walls:** exterior walls are the footprint perimeter extruded, minus the door gap. Enclosed items and `walls` sub-edges become interior walls, and inner doors are gaps with door-leaf models.
- **Furniture:** one mesh per kind, placed at the item's rotated cell rectangle via `toWorld`. Tiers are material sets, which bounds the art at about 19 meshes × 3 material sets. Wall items attach to wall faces.
- **Characters:** the stay activity plus the item's `pose`, `useCell` and `facing` give exact poses. Walking inside a room exists only as planned legs. That is why phase 4 must land before any in-room walking is animated in 3D.
- **Camera:** stacked floor plates with a cutaway, as floors.md planned. Rectangles-only footprints keep wall meshing and the cutaway simple. An in-world editor can later raycast to tile and cell and call the same controller API.
- **Blockiness:** 1 m snapping looks blocky in 3D. Mitigations:
  - per-model visual offsets that never move a `useCell`;
  - a later 4 → 8 lossless doubling.

## Migration

### Saves

There is one version bump per phase that changes saved shape, numbered after whatever the checkout and outing work takes. `SAVE_VERSION` is 18 today.

- **Phase 0: `addRoomFootprints`.** Sets `w = h = 1`, `doorSlot = 0` and `mirrored = false`. Nothing else changes, and `roomEntry` equals today's `roomTile` for every room, so saved trips, walkers, `staffRoster.roomId` and plans stay valid. Plans are rebuilt on load anyway (`withPlans`).
- **Phase 1: `furnishRooms`.**
  - Each room gets a preset from its type: standard → `classic_queen`, deluxe → `compact_deluxe`, suite → `exec_studio`.
  - It also gets arrangement "bath by the door", the preset's default items and walls, and a re-derived `type` that equals the old one.
  - Status, guest, timers, decor and `pricePerNight` are kept. No refit is triggered, and `roomStandards` starts empty.
- **Phase 2: `addParties`.** Guests already checked in get `{ kind: 'solo', size: 1 }`. Returning-guest profiles roll a fresh party on return.
- **Amenities:** `state.amenities` stays keyed by `RoomType` through phase 3, read through the compatibility bucket. Re-keying it is an open question.

### Invariant test (phase 1 gate)

The test runs over fixture saves at each star level and over 100 states sampled from the balanced bot. For every migrated room it requires that fair price, star points, turnover and daily-clean hours, invested cost, renovation cost, demolish refund and valuation all equal the pre-migration values to the dollar or hour.

### Code

- `room.type` stays as a derived field, so its 21 readers keep working. They move to `profileRoom` one at a time.
- `addRoom(state, type, …)` stays as a wrapper, so the 288 tests, the headless simulator and the bots run unchanged.
- **Phase 0 replaces:**
  - the five position-equality lookups, with `roomAt`;
  - both `roomTile` copies, plus the FacilityManager and OutingManager imports, with `roomEntry`;
  - `rooms.length`, with `keyCount` where it means keys: arrivals, star thresholds, objectives, occupancy and the bots' demand estimate;
  - the three exact-anchor assertions in the alignment test, with footprint-membership checks.
- **The phase 0 gate:** seeded 400-day golden runs must be byte-identical before and after.
- **The phase 2 gate:** with `PARTIES.enabled` off, the golden runs must still be identical. That isolates the balance change to one switch.

### Bots (`strategies.ts`)

- **Phase 1:** `nextRoomType` becomes `nextRefit`, so the demolish-and-rebuild climb becomes an in-place refit with the install premium. This is measured as its own step: the balanced-bot median must stay within ±5% before the switch, and is re-measured after.
- **Phase 2:** build a few twins and family rooms before summer weekends.
- **Phase 3:** `findFreeTile` and `templateDoor` generalize to `findFreeFootprint(w, h)`, which fits the template well:
  - 2x1 rooms go in rows 0 and 5, with doors toward rows 1 and 4;
  - 2x2 suites and 1x2 rooms go in the rows 2-3 band, with the door on the top tile facing up or the bottom tile facing down.
  - The mix policy: families early, deluxe at 2 stars, suites at 3. Without it, every balance table is meaningless.

## Phased plan

Each phase changes one balance-relevant thing and can ship on its own. Sizes are relative.

**Step 0: prerequisite, not this feature.** Land the 11:00 checkout rebalance and outings. Fold into that pass:
- the `jobQueues` turnover priority fix;
- the taken-set matcher, a small and measured behavior change;
- per-room `estimateHousekeepingHours`, which is a no-op while all rooms are equal.

This gives a measured baseline, so two balance passes don't confound each other.

**Phase 0: footprint plumbing (S, invisible).** Footprint fields, `roomAt`, `roomEntry`, `keyCount`, the `layoutKey` extension, and the alignment-test footprint checks. Gate: byte-identical golden runs.

**Phase 1: "Furnished rooms" (M, small on purpose).**
- **Content:** the furniture catalog (about 12 kinds at tiers 1-2) and the three legacy presets × two arrangements, plus mirror.
- **Model and classification:** `profileRoom` (memoized) and the derived `room.type`.
- **UI:** the inspector's slot rows with before → after, refit now or at checkout, and house standards with apply-to-all.
- **Rendering:** cached furniture glyphs with level of detail, and the SVG plan.
- **Saves and bots:** the migration with its invariant test, and the bots refitting with the install premium.
- **What players get:** visible furniture, "deluxe = nicer" by upgrading in place, recategorizing without demolishing, and a chosen bath placement.
- **Not in phase 1:** parties, twins and families, multi-tile rooms, noise changes, tier 3, and the free editor.
- **Phase 1b (stretch):** `StayLeg.slot`, so housekeepers visibly clean bath → bed → rest, checked by the alignment test.

**Phase 1 as shipped (2026-10-11).** Save version 19.
- **Content** (`src/config/furniture.ts`): 11 kinds at tiers 1-2 (queen/king bed, shower room/bathroom with tub, rail/wardrobe, armchair/desk, sofa, TV, art), each with a cost per tier, install hours and a star unlock. Three presets on a 4x4 door-local grid, each with two bath arrangements and a mirror: Standard Queen, Deluxe King and Executive Studio. Their default furniture costs exactly the old standard/deluxe/suite build cost ($1,200 shell + furniture).
  - Layouts: the bed's head is on the back wall. "Bath by the door" is a long (2x3) bathroom down one side, entered just inside the door; "at the back" is a 2x2 bathroom in the back corner with the front of the room open. The studio's sofa stands against the side wall facing a TV. With a 2x2 bathroom beside the door there is always a shut-off nook behind it, which is why that bathroom is long. Every piece in every layout, mirrored or not, can be walked up to from the doorway with no floor shut off, and wall pieces hang on a wall; the tests check all of this.
- **Classification** (`src/simulation/RoomProfile.ts`): quality is the grade-weighted tier average (bed and bath 3, lounge 2, the rest 1). At 1.75 or more a room is deluxe; deluxe with a sofa and TV is a Junior Suite. `room.type` holds the derived category, so prices, stars and amenities read it unchanged, and every room built from a preset is exactly its old type.
- **Refits:** new pieces, less 50% back on the old ones, times 1.4 for fitting in place. Moving the bathroom (arrangement or mirror; every preset puts it in the same place for an arrangement) re-plumbs it: half its price again plus its install hours. Refits never pay out. An empty room closes for the install hours with construction noise. An occupied room, or an empty one the hotel can't afford yet, is booked and paid when it starts. A changed category resets the price to the new fair price. On reopening, the room's decor freshens as far as the refit's cost would have gone on a renovation, so swapping pieces for cheaper ones (which the old ones' resale pays for) is no cheap way around renovating.
  - Upgrading in place costs about what building new does: Standard Queen to the cheapest deluxe is $2,870 (total $4,870 against $5,000 for a Deluxe King), and to the cheapest Junior Suite $7,140 (total $9,140 against $10,000).
- **UI:** the inspector shows the room's plan, its label ("Deluxe Queen 104") and a Furnish… button. The Furnish panel has "Start from" (a preset's layout and furniture, keeping the bathroom where it is), bath placement and mirror, a row per slot (piece and Basic/Premium), the before → after label and fair price, the cost and hours closed, Refit now / after checkout / "Book it" (when it can't be afforded yet), and "Same for all N other <layout> rooms": house standards as a one-time stamp over every room currently with this room's layout and not already furnished or booked that way. Locked pieces and layouts are disabled with their star requirement.
- **Rendering:** furniture is drawn in every room on the floor plan, turned with the door; premium pieces have a gold edge, and the guest in a room is drawn at the bed.
- **Not done from the phase 1 list:** "List as" (downward), the separate "Rooms & Amenities" standards panel (the copy-to-all button covers it), bots that refit (they still build by type, so balance is unchanged by construction), map level-of-detail and RenderTexture caching (drawing every frame is fine at one floor's ~60 tiles), and phase 1b.
- **Tests:** `test/furnishing.test.ts` covers classification and exact legacy costs, layout fit and reachability (every rotation and mirror), refit pricing and re-plumbing, decor gained per dollar against renovation, unlocks, refit now / after checkout / booking until affordable / copy-to-all, the v18 → v19 migration, and refits in a running hotel (nobody is put in a room being refitted). `test/ui.test.tsx` drives the Furnish panel, including booking and demolishing a room with the panel open.
- **Review:** an adversarial review (3 reviewers, each finding independently verified) confirmed 8 problems, all fixed above: the decor exploit, re-plumbing charged when the bathroom didn't move, pieces (storage, the studio sofa, one bathroom) that could only be reached over the bed in every layout, copy-to-all skipping (and keeping an older booking on) empty rooms it couldn't afford, a "Same for all" that did nothing, the panel reappearing for a room rebuilt on a demolished room's tile, and a wrong "when it reopens" note on an empty room waiting for cash.

**Phase 2: "Make it yours" and "Who's staying" (L).**
- **Free placement (owner decision).** A Preact/SVG room editor on the same item list: drag or tap items onto the room's sub-grid, rotate, delete, start from any preset, and see the live classification as you go (label, sleeps, fair price, issues). It is hardened against min-maxing with crowding penalties, a sleeps cap per tile, and property tests over random layouts. On phones it uses tap-to-place with a fixed palette. Bots keep using presets.
- Parties behind the flag: the `hash01` mix, fit matching, the pay cap, the soft trickle of named turn-aways, normalized per-person scaling, and N figures on one itinerary.
- New 1x1 presets: Twin and Bunk Family.
- Preferences v1 (review only), wired to the personality list.
- Exit: strategy ordering holds; the alignment test counts people, so figures drawn = party size and facility load is in people; and the summary reports the family turn-away rate.

**Phase 3: "Bigger rooms" (L).** First decide keys vs area and the grid size (open questions).
- 2x1, 1x2 and 2x2 presets with `doorSlots`, including suites with pre-drawn bedroom walls.
- Ghost-then-confirm placement.
- Noise and turnover for footprints.
- Area-weighted star points, tier 3 and the luxury grade.
- The Executive Studio leaves the build menu, if that is decided.
- Bot footprint placement.
- Exit (A's criteria): the balanced median valuation stays within ±10% of the pre-phase baseline, and balanced > understaffed and overstaffed > hoarder still holds. Measure revenue per tile per preset and report it.

**Phase 4: "Rooms that live" (L).**
- In-room planned legs (`TilePos.sub`, anchor graphs).
- Noise heard at the bed plus wall buffers, behind a flag.
- Crew cleaning by zone, with the alignment test rewritten around zones.

**Phase 5:** folded into phase 2 by the owner's decision (free placement alongside presets).

**Phase 6: depth and 3D.** Per-item wear and targeted breakdowns, minibar and kitchenette trade-offs, connecting rooms, then the 3D renderer.

## Costs and risks

1. **Per-tile economics.** With exact legacy prices and budget caps, multi-tile rooms earn less per tile than 1x1 deluxes and Executive Studios.
   - If party budgets, area-weighted stars and lower per-tile running costs don't compensate, big rooms become traps.
   - If those levers overshoot, big rooms become must-haves.
   - Arrivals scale with √keys, so a suite-heavy hotel also loses visibility.
   - Only the harness can settle this, and the 5-star deadline (day 420) may need to move again.
2. **Turnover against the 11:00 checkout.** A standard 4 h turnover already misses the first check-ins, and 7-8 h suites miss most of them. Crew cleaning fixes this, but it breaks the "one worker per room" invariant and needs an alignment-test rewrite.
3. **Parties touch everything.** Matching, budgets, elevator, facilities, consumables, noise, wear, rendering, room moves, returning guests and stories all change. Missing one shows up as drawn-versus-simulated drift. The normalization rule and a people-counting alignment test are the guards.
4. **Refits change pacing.** In-place upgrades are cheaper than rebuilds. Without an install premium and downtime, stars come sooner.
5. **"Placement" is a menu until phase 5.** Authored arrangements answer "bathroom and closet placement" with a choice of 2-3. If the owner wants Sims-style placement early, phase 5 moves up, and it brings a min-max-prone classifier that needs crowding penalties, a sleeps cap per tile, property tests, and balance the bots can't measure.
6. **Sameness against micromanagement.** House standards make 80 rooms manageable but push hotels toward uniformity. Per-room choices need stakes (family demand, quiet walls, stars) to justify the UI.
7. **Alignment raises the cost of every visual feature.** N party figures, per-slot cleaning, in-room legs and crew teams each need planned legs and new alignment checks. Each roughly doubles that feature's work.
8. **Performance.** The per-frame `renderRooms`/`renderNoise` redraw and the per-neighbor `rooms.find` get worse with glyphs and footprints. The `roomAt` index, memoized profiles and RenderTexture caching are required.
9. **Determinism.** Party rolls, in-room anchors and seat picks must use `hash01` or pure functions and be saved in legs. Otherwise reloads and speed changes desync what is shown, the exact failure aligned-movement.md fixed.
10. **Commitments made now:** the 1 m grid, the door-local frame, rectangles only, a maximum of 2x2, and bath as an enclosed block rather than separate fixtures. Changing any of them later means re-authoring presets and, eventually, 3D content.
11. **Space.** An upper floor has 34 room tiles, and a 2x2 suite takes four of them. Floors stay the space sink, which helps the late-game economy but slows progression.
12. **Parallel work.** Checkout, outings and personalities edit the same files right now (balance.ts, types.ts, GuestManager, StaffManager). Merge order and save-version numbering need coordinating.
13. **Art and tests.** About 19 kinds need 2D glyphs now and meshes later. Each phase adds unit, property and migration-invariant tests. The 18-step save chain has no automated very-old-save test.
14. **Legacy anomaly.** Existing Executive Studios stay at $250 per tile forever, above the new curve. That is honest, because the normal rules classify them, but it is visible.

## Open questions for the owner

1. ~~Bathroom and closet placement~~ **Decided:** both presets and free placement (free editor in phase 2).
2. ~~Per-tile economics~~ **Decided:** bigger rooms generally earn more per tile, depending on amenities. Area is priced through furnishing quality, and legacy 1x1 rooms keep their numbers.
3. **Keys or area:** do demand and the room-count goals count keys, with the star tier mix weighted by area? *Recommended: yes to both.*
4. **Grid size:** keep 10x6 per floor, so scarcity is the fun and floors are the space sink, or grow to 12x8 or 14x8? *Recommended: keep it.*
5. **Footprints:** rectangles up to 2x2, with 3x2 later? No L-shapes? May a suite have two hallway doors?
6. **The Executive Studio:** legacy-only once real suites ship (recommended), or buildable forever?
7. ~~Parties on screen~~ **Decided:** several people walking together (N figures on one itinerary).
8. **Paying for parties:** one rate per room with larger budgets for 3+ (recommended), or per-person surcharges for sofa beds and cribs?
9. **Unservable segments:** a soft 25% trickle of named turn-aways (recommended), full turn-aways, or simply no arrivals?
10. **Crew cleaning:** may several housekeepers clean one big room (phase 4), or do suites carry a built-in vacancy risk?
11. **Refits:** offline for install hours with construction noise and queued while occupied (recommended), or instant? And how big should the install premium be? *Phase 1 shipped the recommendation with a 1.4x premium; easy to retune.*
12. **Consumable amenity tiers:** keep them hotel-wide, keyed by the compatibility bucket (recommended for now), re-key them by grade or class, or fold them into furniture tiers?
13. **Category:** always derived, with only a downward "list as" (recommended), or does the player declare a target category and the game validate it?
14. **Personality preferences:** review-only at first (recommended), or can they steer matching or reject a room at the desk?
15. **Sub-grid:** 4x4 at 1 m (recommended), or 8x8 at 0.5 m for finer furniture, at the cost of phone editing and save size?
16. **House standards:** live-linked, so editing one flags rooms for refit, or one-time stamps? *Phase 1 shipped one-time stamps ("Same for all N other rooms").*
17. **Phone map:** may it drop furniture detail at phone scale (recommended), or is pinch-zoom on the world wanted?
18. **Later depth:** are connecting rooms, kitchenettes, minibars and exterior-window appeal wanted, and if so, in which phase?
