import type { HotelState, Room, RoomType, Facility, FacilityType, TileType, Elevator, GameEvent, Fixture, FixtureType, Direction, Furnishing, Guest } from './types.js';
import { PRESET_FOR_TYPE, ROOM_PRESETS, type PresetId } from '../config/furniture.js';
import { defaultFurnishing, furnishingOf, quoteRefit, validateFurnishing, profileFurnishing, profileRoom, isBookable, classPriceFactor } from './RoomProfile.js';
import { ECONOMY, ROOM_CONFIG, GRID, HOUSEKEEPING, FACILITY_CONFIG, LOAN, RENOVATION, FACILITY_LEVELS, FLOORS, ELEVATOR, DESK, CLOSET, BREAK_ROOM, ENTRANCE, STARTER_LAYOUT, GUEST_PROFILE, PATIENCE } from '../config/balance.js';
import { isTileAccessible, findOpenDoor, isEdgeTile, isFacilityOpen, getOpenFacilities } from './Layout.js';
import { createConstructionNoise } from './NoiseManager.js';
import { getExpectedPrice, getRoomExpectedPrice, getPriceMultiplier } from './StarRatingManager.js';

/** The free street entrance every hotel starts with. */
function starterEntrance(): Fixture {
  const [x, y] = STARTER_LAYOUT.entranceTile;
  return { id: `entrance-0-${x}-${y}`, type: 'entrance', gridX: x, gridY: y, floor: 0 };
}

/** An empty lot: all open hallway, with the free street entrance. */
export function createHotelState(): HotelState {
  return {
    cash: ECONOMY.startingCash,
    day: 1,
    hour: 0,
    rooms: [],
    facilities: [],
    guests: [],
    bookings: [],
    noiseSources: [],
    housekeeping: {
      turnoverQuality: 'standard',
      dailyCadence: 'daily',
    },
    staff: {
      maintenanceWorkers: 0,
      housekeepers: 1,
      frontDesk: 1,
    },
    amenities: {
      standard: 'basic',
      deluxe: 'basic',
      suite: 'basic',
    },
    starRating: 1,
    reviewScore: ECONOMY.initialReviewScore,
    totalTurnedAway: 0,
    totalRevenue: 0,
    activeIncidents: [],
    returningGuestPool: [],
    storyLog: [],
    activeReputationPenalties: [],
    peakStarRating: 1,
    loan: {
      balance: LOAN.principal,
      weeklyPayment: LOAN.weeklyPayment,
      missedPayments: 0,
    },
    objectives: { currentIndex: 0, outcomes: [] },
    dailyStats: [],
    activeCampaign: null,
    daysAtFiveStars: 0,
    floorCount: 1,
    elevators: [],
    fixtures: [starterEntrance()],
  };
}

/** A new game: the empty hotel (all open hallway, one street entrance) plus a free check-in desk. */
export function createStarterHotel(): HotelState {
  const [deskX, deskY] = STARTER_LAYOUT.deskTiles[0];
  const desk: Fixture = { id: `desk-0-${deskX}-${deskY}`, type: 'desk', gridX: deskX, gridY: deskY, floor: 0 };
  const state = createHotelState();
  return { ...state, fixtures: [...state.fixtures, desk] };
}

/** Star rating a room or facility type unlocks at. */
export function getRequiredStars(type: TileType): number {
  if (type in ROOM_CONFIG) return ROOM_CONFIG[type as RoomType].requiredStars;
  return FACILITY_CONFIG[type]?.requiredStars ?? 1;
}

/** Whether a room or facility type can be built yet. Uses the peak star rating,
 * so a temporary star downgrade never re-locks something already unlocked. */
export function isUnlocked(state: HotelState, type: TileType): boolean {
  return state.peakStarRating >= getRequiredStars(type);
}

/** Whether (gridX, gridY) is inside the floor plan on a floor that has been built. */
export function isValidTile(state: HotelState, gridX: number, gridY: number, floor: number): boolean {
  return gridX >= 0 && gridX < GRID.width && gridY >= 0 && gridY < GRID.height
    && floor >= 0 && floor < state.floorCount;
}

/**
 * The prices a room can be set to: its category's range, scaled like its fair
 * price for who it fits (a family room's runs higher). Exactly the category's
 * range for every room furnished like an original type.
 */
export function getRoomPriceRange(room: Pick<Room, 'type' | 'furnishing'>): { min: number; max: number } {
  const profile = profileRoom(room);
  const config = ROOM_CONFIG[profile.type];
  const factor = classPriceFactor(profile);
  return factor === 1 ? { min: config.minPrice, max: config.maxPrice } : { min: Math.round(config.minPrice * factor), max: Math.round(config.maxPrice * factor) };
}

/** A price kept within a room's range. */
function clampPrice(room: Pick<Room, 'type' | 'furnishing'>, price: number): number {
  const { min, max } = getRoomPriceRange(room);
  return Math.max(min, Math.min(max, price));
}

/** The layout a room is built from: a preset by name, or an original room type (its preset). */
export function presetFor(kind: RoomType | PresetId): PresetId {
  return kind in ROOM_PRESETS ? kind as PresetId : PRESET_FOR_TYPE[kind as RoomType];
}

/** What a room of a type or preset costs to build: its shell and furniture (exactly the original price for the original types). */
export function getRoomBuildCost(kind: RoomType | PresetId): number {
  return profileFurnishing(defaultFurnishing(presetFor(kind))).furnishingCost;
}

/** What a room has cost: what it's built with now (a refit changes it). Its refund, renovation and value follow from this. */
export function getRoomInvestedCost(room: Pick<Room, 'type' | 'furnishing'>): number {
  return profileRoom(room).furnishingCost;
}

/**
 * Build a room on an open hallway tile: an original type (standard, deluxe,
 * suite) or a preset by name (twin, bunk_family), with its preset's
 * furniture. `door` is the side its door is on; left out, it faces the first
 * side that opens onto a connected hallway. A room whose door faces a wall
 * still gets built -- it just can't be used until the player opens a path to it.
 */
export function addRoom(
  state: HotelState,
  kind: RoomType | PresetId,
  gridX: number,
  gridY: number,
  floor = 0,
  door?: Direction,
): HotelState | null {
  const furnishing = defaultFurnishing(presetFor(kind));
  const profile = profileFurnishing(furnishing);
  const type = profile.type;
  const config = ROOM_CONFIG[type];
  const buildCost = profile.furnishingCost;

  if (!isValidTile(state, gridX, gridY, floor)) return null;

  // Check for duplicate position (rooms, facilities, elevator shafts)
  if (isTileOccupied(state, gridX, gridY, floor)) {
    return null;
  }

  // Check affordability and unlock
  if (state.cash < buildCost) {
    return null;
  }
  if (!isUnlocked(state, type)) {
    return null;
  }

  // New rooms start at the fair price for the hotel's star level, their floor, and who they fit
  const startingPrice = clampPrice({ type, furnishing }, getRoomExpectedPrice({ type, furnishing, floor }, state.starRating));

  const room: Room = {
    id: `room-${floor}-${gridX}-${gridY}`,
    type,
    gridX,
    gridY,
    floor,
    door: door ?? findOpenDoor(state, { gridX, gridY, floor }) ?? 'down',
    pricePerNight: startingPrice,
    condition: 100,
    cleanliness: HOUSEKEEPING.initialCleanliness,
    status: 'vacant',
    cleaningHoursRemaining: 0,
    lastDailyCleanDay: 0,
    decor: 100,
    renovationHoursRemaining: 0,
    dailyCleanHoursRemaining: 0,
    furnishing,
  };

  return {
    ...state,
    cash: state.cash - buildCost,
    rooms: [...state.rooms, room],
    noiseSources: [...state.noiseSources, createConstructionNoise(gridX, gridY, 'build', floor)],
  };
}

export function setRoomPrice(
  state: HotelState,
  roomId: string,
  price: number
): HotelState {
  const config = state.rooms.find(r => r.id === roomId);
  if (!config) return state;

  const clampedPrice = clampPrice(config, price);

  return {
    ...state,
    rooms: state.rooms.map(r =>
      r.id === roomId ? { ...r, pricePerNight: clampedPrice } : r
    ),
  };
}

/** Refund amount when demolishing a room or facility: a fixed fraction of build cost. */
export function getDemolishRefund(buildCost: number): number {
  return Math.floor(buildCost * ECONOMY.demolishRefundRate);
}

/**
 * Refit a room: change its furniture or layout (what it's furnished with
 * decides what kind of room it is -- RoomProfile.ts). 'now' needs the room
 * empty and the cash: it closes for the fitting (status 'renovating') and the
 * new furniture goes straight in. 'checkout' does that if it can, and
 * otherwise books it for when the room is next empty and the cash is there
 * (startPendingRefits); it's paid for then. Null if it isn't allowed, or
 * changes nothing (or, 'now', can't happen now).
 */
export function refitRoom(state: HotelState, roomId: string, to: Furnishing, when: 'now' | 'checkout' = 'now'): HotelState | null {
  const room = state.rooms.find(r => r.id === roomId);
  if (!room || validateFurnishing(to, state.peakStarRating)) return null;
  const quote = quoteRefit(furnishingOf(room), to);
  if (quote.changed.length === 0 && !quote.moved) return null;
  if (when === 'checkout') {
    return refitRoom(state, roomId, to, 'now')
      ?? { ...state, rooms: state.rooms.map(r => (r.id === roomId ? { ...r, pendingRefit: to } : r)) };
  }
  if (room.status !== 'vacant' || state.cash < quote.cost) return null;
  const type = quote.after.type;
  // The refit freshens the room as far as the money would have gone on a
  // renovation: a refit is no cheaper a way to buy decor (swapping pieces for
  // cheaper ones, which the old ones' resale pays for, freshens it little).
  const share = Math.min(1, quote.cost / Math.max(1, getRenovationCost(quote.after.furnishingCost, state.starRating)));
  // A room that's become something else (another category, or for other people) starts at its new fair price
  const sameKind = type === room.type && quote.after.layoutClass === quote.before.layoutClass;
  const pricePerNight = sameKind ? room.pricePerNight
    : clampPrice({ type, furnishing: to }, getRoomExpectedPrice({ type, furnishing: to, floor: room.floor }, state.starRating));
  const refitted: Room = {
    ...room,
    furnishing: to,
    type,
    pricePerNight,
    pendingRefit: undefined,
    status: 'renovating',
    renovationHoursRemaining: Math.max(1, quote.installHours),
    refitting: { decorAfter: room.decor + (100 - room.decor) * share },
  };
  return {
    ...state,
    cash: state.cash - quote.cost,
    rooms: state.rooms.map(r => (r.id === roomId ? refitted : r)),
    noiseSources: [...state.noiseSources, createConstructionNoise(room.gridX, room.gridY, 'renovate', room.floor)],
  };
}

/** Drop a refit booked for after checkout. */
export function cancelPendingRefit(state: HotelState, roomId: string): HotelState {
  return { ...state, rooms: state.rooms.map(r => (r.id === roomId && r.pendingRefit ? { ...r, pendingRefit: undefined } : r)) };
}

/** Start refits booked for after checkout in rooms that are now empty (and affordable: otherwise they wait). */
export function startPendingRefits(state: HotelState): HotelState {
  let current = state;
  for (const room of state.rooms) {
    if (!room.pendingRefit || room.status !== 'vacant') continue;
    current = refitRoom(current, room.id, room.pendingRefit, 'now') ?? current;
  }
  return current;
}

/** The other rooms with a layout that a refit of every room "like" it would change (not counting ones already booked for it). */
export function roomsToRefitLike(state: HotelState, to: Furnishing, like: PresetId, exceptRoomId?: string): Room[] {
  const differs = (from: Furnishing) => {
    const quote = quoteRefit(from, to);
    return quote.changed.length > 0 || quote.moved;
  };
  return state.rooms.filter(room =>
    room.id !== exceptRoomId && furnishingOf(room).preset === like
    && differs(furnishingOf(room)) && (!room.pendingRefit || differs(room.pendingRefit)));
}

/**
 * Furnish every other room with the layout `like` this way: empty rooms now
 * (as far as the cash goes), the rest booked for when they're empty and it's
 * affordable. Rooms already furnished (or booked) like this are left alone.
 * Returns null if nothing would change.
 */
export function refitAllLike(state: HotelState, to: Furnishing, like: PresetId, exceptRoomId?: string): HotelState | null {
  let current = state;
  let changed = false;
  for (const room of roomsToRefitLike(state, to, like, exceptRoomId)) {
    const next = refitRoom(current, room.id, to, 'checkout');
    if (next) {
      current = next;
      changed = true;
    }
  }
  return changed ? current : null;
}

/** Move a facility's door to another side (free). */
export function setFacilityDoor(state: HotelState, facilityId: string, door: Direction): HotelState | null {
  if (!state.facilities.some(f => f.id === facilityId)) return null;
  return { ...state, facilities: state.facilities.map(f => f.id === facilityId ? { ...f, door } : f) };
}

/** Move a room's door to another side (free). */
export function setRoomDoor(state: HotelState, roomId: string, door: Direction): HotelState | null {
  if (!state.rooms.some(r => r.id === roomId)) return null;
  return { ...state, rooms: state.rooms.map(r => r.id === roomId ? { ...r, door } : r) };
}

export function demolishRoom(state: HotelState, roomId: string): HotelState | null {
  const room = state.rooms.find(r => r.id === roomId);
  if (!room) return null;
  if (room.status === 'occupied') return null; // can't demolish while occupied

  const refund = getDemolishRefund(getRoomInvestedCost(room));

  return {
    ...state,
    cash: state.cash + refund,
    rooms: state.rooms.filter(r => r.id !== roomId),
    noiseSources: [...state.noiseSources, createConstructionNoise(room.gridX, room.gridY, 'demolish', room.floor)],
  };
}

export function repairRoom(state: HotelState, roomId: string): HotelState | null {
  const room = state.rooms.find(r => r.id === roomId);
  if (!room) return null;
  if (room.status !== 'vacant') return null; // can't repair while occupied or cleaning
  if (room.condition >= 100) return null; // already perfect
  if (state.cash < ECONOMY.roomRepairCost) return null;

  return {
    ...state,
    cash: state.cash - ECONOMY.roomRepairCost,
    rooms: state.rooms.map(r =>
      r.id === roomId ? { ...r, condition: 100 } : r
    ),
  };
}

/** Renovation cost: a share of build cost, scaled up at higher star levels. */
export function getRenovationCost(buildCost: number, starRating: number): number {
  return Math.round(buildCost * RENOVATION.costRate * getPriceMultiplier(starRating));
}

/**
 * Start renovating a vacant room: it goes offline for RENOVATION.durationHours,
 * then comes back with fresh decor, full condition and cleanliness (see
 * processRenovationTick). Makes construction noise for the neighbors.
 */
export function renovateRoom(state: HotelState, roomId: string): HotelState | null {
  const room = state.rooms.find(r => r.id === roomId);
  if (!room || room.status !== 'vacant') return null;
  const cost = getRenovationCost(getRoomInvestedCost(room), state.starRating);
  if (state.cash < cost) return null;

  return {
    ...state,
    cash: state.cash - cost,
    rooms: state.rooms.map(r =>
      r.id === roomId ? { ...r, status: 'renovating' as const, renovationHoursRemaining: RENOVATION.durationHours } : r
    ),
    noiseSources: [...state.noiseSources, createConstructionNoise(room.gridX, room.gridY, 'renovate', room.floor)],
  };
}

/** Renovate a facility: instant (facilities stay open), restores decor to 100. */
export function renovateFacility(state: HotelState, facilityId: string): HotelState | null {
  const facility = state.facilities.find(f => f.id === facilityId);
  if (!facility || facility.decor >= 100) return null;
  const cost = getRenovationCost(FACILITY_CONFIG[facility.type].buildCost, state.starRating);
  if (state.cash < cost) return null;

  return {
    ...state,
    cash: state.cash - cost,
    facilities: state.facilities.map(f => f.id === facilityId ? { ...f, decor: 100 } : f),
    noiseSources: [...state.noiseSources, createConstructionNoise(facility.gridX, facility.gridY, 'renovate', facility.floor)],
  };
}

/** Cost to take a facility to its next level, or null if it's already maxed. */
export function getFacilityUpgradeCost(facility: Facility): number | null {
  const next = FACILITY_LEVELS[facility.level];
  if (!next) return null;
  return Math.round(FACILITY_CONFIG[facility.type].buildCost * next.upgradeCostRate);
}

/** Upgrade a facility one level. Needs the level's star rating (peak) and the cash. Comes with fresh decor. */
export function upgradeFacility(state: HotelState, facilityId: string): HotelState | null {
  const facility = state.facilities.find(f => f.id === facilityId);
  if (!facility) return null;
  const cost = getFacilityUpgradeCost(facility);
  if (cost === null || state.cash < cost) return null;
  if (state.peakStarRating < FACILITY_LEVELS[facility.level].requiredStars) return null;

  return {
    ...state,
    cash: state.cash - cost,
    facilities: state.facilities.map(f => f.id === facilityId ? { ...f, level: f.level + 1, decor: 100 } : f),
    noiseSources: [...state.noiseSources, createConstructionNoise(facility.gridX, facility.gridY, 'renovate', facility.floor)],
  };
}

export function getOccupancyRate(state: HotelState): number {
  if (state.rooms.length === 0) return 0;
  const occupied = state.rooms.filter(r => r.status === 'occupied').length;
  return occupied / state.rooms.length;
}

/**
 * Guests can only book a room whose door opens onto a hallway connected to the
 * street -- for upper floors, through an elevator (see Layout.ts).
 */
export function isRoomReachable(state: HotelState, room: Room): boolean {
  return isTileAccessible(state, room.gridX, room.gridY, room.floor, room.door);
}

export function getAvailableRooms(state: HotelState): Room[] {
  return state.rooms
    .filter(r => r.status === 'vacant' && r.condition > ECONOMY.roomBreakdownThreshold && isRoomReachable(state, r) && isBookable(r))
    .sort((a, b) => a.pricePerNight - b.pricePerNight); // ascending price
}

/** Check if a tile on a floor has something built on it: a room, facility, fixture, or an elevator shaft (which spans every floor). Free tiles are hallway. */
export function isTileOccupied(state: HotelState, gridX: number, gridY: number, floor: number): boolean {
  return state.rooms.some(r => r.floor === floor && r.gridX === gridX && r.gridY === gridY)
    || state.facilities.some(f => f.floor === floor && f.gridX === gridX && f.gridY === gridY)
    || state.fixtures.some(f => f.floor === floor && f.gridX === gridX && f.gridY === gridY)
    || state.elevators.some(e => e.gridX === gridX && e.gridY === gridY);
}

export const FIXTURE_COST: Record<FixtureType, number> = {
  entrance: ENTRANCE.buildCost,
  desk: DESK.buildCost,
  closet: CLOSET.buildCost,
  breakroom: BREAK_ROOM.buildCost,
};

/** Build a street entrance (ground floor edge only), check-in desk (ground floor only), staff closet, or staff break room on an open hallway tile. */
export function addFixture(state: HotelState, type: FixtureType, gridX: number, gridY: number, floor: number): HotelState | null {
  if (!isValidTile(state, gridX, gridY, floor)) return null;
  if (isTileOccupied(state, gridX, gridY, floor)) return null;
  if (type === 'desk' && floor !== 0) return null;
  if (type === 'entrance' && (floor !== 0 || !isEdgeTile(gridX, gridY))) return null;
  const cost = FIXTURE_COST[type];
  if (state.cash < cost) return null;

  const fixture: Fixture = { id: `${type}-${floor}-${gridX}-${gridY}`, type, gridX, gridY, floor };
  return { ...state, cash: state.cash - cost, fixtures: [...state.fixtures, fixture] };
}

export function demolishFixture(state: HotelState, fixtureId: string): HotelState | null {
  const fixture = state.fixtures.find(f => f.id === fixtureId);
  if (!fixture) return null;
  return {
    ...state,
    cash: state.cash + getDemolishRefund(FIXTURE_COST[fixture.type]),
    fixtures: state.fixtures.filter(f => f.id !== fixtureId),
  };
}

/** Cost to build the next floor up, or null at the height limit. */
export function getNextFloorCost(state: HotelState): number | null {
  if (state.floorCount >= FLOORS.max) return null;
  return Math.round(FLOORS.baseCost * FLOORS.costGrowth ** (state.floorCount - 1));
}

/** Total spent on floors above ground so far (for valuation). */
export function getFloorsBuildCost(floorCount: number): number {
  let total = 0;
  for (let n = 1; n < floorCount; n++) total += Math.round(FLOORS.baseCost * FLOORS.costGrowth ** (n - 1));
  return total;
}

/** Add a floor on top of the building. */
export function buildFloor(state: HotelState): { state: HotelState; events: GameEvent[] } | null {
  const cost = getNextFloorCost(state);
  if (cost === null || state.cash < cost) return null;
  const floorCount = state.floorCount + 1;
  return {
    state: { ...state, cash: state.cash - cost, floorCount },
    events: [{ type: 'floor_built', message: `Floor ${floorCount} built` }],
  };
}

/** Place an elevator shaft. The tile must be free on every built floor. */
export function addElevator(state: HotelState, gridX: number, gridY: number): HotelState | null {
  if (!isValidTile(state, gridX, gridY, 0)) return null;
  for (let floor = 0; floor < state.floorCount; floor++) {
    if (isTileOccupied(state, gridX, gridY, floor)) return null;
  }
  if (state.cash < ELEVATOR.buildCost) return null;

  const elevator: Elevator = { id: `elevator-${gridX}-${gridY}`, gridX, gridY };
  return { ...state, cash: state.cash - ELEVATOR.buildCost, elevators: [...state.elevators, elevator] };
}

export function demolishElevator(state: HotelState, elevatorId: string): HotelState | null {
  if (!state.elevators.some(e => e.id === elevatorId)) return null;
  return {
    ...state,
    cash: state.cash + getDemolishRefund(ELEVATOR.buildCost),
    elevators: state.elevators.filter(e => e.id !== elevatorId),
  };
}

/** Upper-floor rooms per comfortable elevator capacity: 1 is full, 2+ is the worst wait. */
/**
 * Upper-floor rooms as lift traffic: counted by the people they sleep, two to
 * a room (a family room is two rooms' worth, a double one).
 */
export function getUpperRoomLoad(state: HotelState): number {
  return state.rooms.filter(r => r.floor > 0).reduce((sum, r) => sum + Math.max(1, profileRoom(r).sleeps / 2), 0);
}

export function getElevatorLoad(state: HotelState): number {
  const upperRooms = getUpperRoomLoad(state);
  if (upperRooms === 0) return 0;
  if (state.elevators.length === 0) return Infinity;
  return upperRooms / (state.elevators.length * ELEVATOR.roomsServed);
}

/** Review penalty (0-10 scale) for a guest staying on an upper floor of an overloaded hotel. */
export function getElevatorWaitPenalty(state: HotelState, room: Room, guest?: Pick<Guest, 'profile'>): number {
  if (room.floor === 0) return 0;
  const overload = Math.max(0, Math.min(1, getElevatorLoad(state) - 1));
  // A slow walker minds the wait more, and (with patience on) an impatient one too
  const mind = guest?.profile?.mobility === 'limited' ? GUEST_PROFILE.limitedLiftMult : 1;
  const patience = PATIENCE.enabled ? PATIENCE.liftMult[guest?.profile?.patience ?? 'normal'] : 1;
  return overload * ELEVATOR.maxWaitPenalty * mind * patience;
}

/** Build a facility on an open hallway tile, with its door on `door` (or, left out, the first open side -- see addRoom). */
export function addFacility(
  state: HotelState,
  type: FacilityType,
  gridX: number,
  gridY: number,
  floor = 0,
  door?: Direction,
): HotelState | null {
  const config = FACILITY_CONFIG[type];
  if (!config) return null;

  if (!isValidTile(state, gridX, gridY, floor)) return null;
  if (isTileOccupied(state, gridX, gridY, floor)) return null;
  if (state.cash < config.buildCost) return null;
  if (!isUnlocked(state, type)) return null;

  const facility: Facility = {
    id: `facility-${floor}-${gridX}-${gridY}`,
    type,
    gridX,
    gridY,
    floor,
    door: door ?? findOpenDoor(state, { gridX, gridY, floor }) ?? 'down',
    condition: 100,
    decor: 100,
    level: 1,
  };

  return {
    ...state,
    cash: state.cash - config.buildCost,
    facilities: [...state.facilities, facility],
    noiseSources: [...state.noiseSources, createConstructionNoise(gridX, gridY, 'build', floor)],
  };
}

export function demolishFacility(state: HotelState, facilityId: string): HotelState | null {
  const facility = state.facilities.find(f => f.id === facilityId);
  if (!facility) return null;

  const config = FACILITY_CONFIG[facility.type];
  const refund = getDemolishRefund(config?.buildCost ?? 0);

  return {
    ...state,
    cash: state.cash + refund,
    facilities: state.facilities.filter(f => f.id !== facilityId),
    noiseSources: [...state.noiseSources, createConstructionNoise(facility.gridX, facility.gridY, 'demolish', facility.floor)],
  };
}

/**
 * Derive a hotel-style room number: floor number (1 = ground) then a two-digit
 * unit counted across the floor plan, e.g. ground floor, row 1, column 3 -> "112".
 * Pure formatting, no stored data (design-review D9) -- used in RoomInspector's
 * title, a grid tile label, and Story Log/toast message text.
 */
export function formatRoomLabel(gridX: number, gridY: number, floor: number): string {
  const unit = String(gridY * GRID.width + gridX + 1).padStart(2, '0');
  return `${floor + 1}${unit}`;
}

export { isFacilityOpen, getOpenFacilities };

