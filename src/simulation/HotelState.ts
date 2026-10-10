import type { HotelState, Room, RoomType, Facility, FacilityType, TileType, Elevator, GameEvent, Fixture, FixtureType } from './types.js';
import { ECONOMY, ROOM_CONFIG, GRID, HOUSEKEEPING, FACILITY_CONFIG, LOAN, RENOVATION, FACILITY_LEVELS, FLOORS, ELEVATOR, HALLWAY, DESK, CLOSET, STARTER_LAYOUT } from '../config/balance.js';
import { isTileAccessible } from './Layout.js';
import { createConstructionNoise } from './NoiseManager.js';
import { getExpectedPrice, getPriceMultiplier } from './StarRatingManager.js';

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
    fixtures: [],
  };
}

/** The STARTER_LAYOUT hallways on one floor (positions only, no cost). */
export function starterHallways(floor: number): Fixture[] {
  return STARTER_LAYOUT.hallwayTiles.map(([x, y]): Fixture => ({ id: `hallway-${floor}-${x}-${y}`, type: 'hallway', gridX: x, gridY: y, floor }));
}

/** A new game: the empty hotel plus a free lobby -- ground-floor hallways and one check-in desk. */
export function createStarterHotel(): HotelState {
  const [deskX, deskY] = STARTER_LAYOUT.deskTiles[0];
  const desk: Fixture = { id: `desk-0-${deskX}-${deskY}`, type: 'desk', gridX: deskX, gridY: deskY, floor: 0 };
  return { ...createHotelState(), fixtures: [...starterHallways(0), desk] };
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

export function addRoom(
  state: HotelState,
  type: RoomType,
  gridX: number,
  gridY: number,
  floor = 0
): HotelState | null {
  const config = ROOM_CONFIG[type];

  if (!isValidTile(state, gridX, gridY, floor)) return null;

  // Check for duplicate position (rooms, facilities, elevator shafts)
  if (isTileOccupied(state, gridX, gridY, floor)) {
    return null;
  }

  // Check affordability and unlock
  if (state.cash < config.buildCost) {
    return null;
  }
  if (!isUnlocked(state, type)) {
    return null;
  }

  // New rooms start at the fair price for the hotel's star level and their floor
  const startingPrice = Math.max(config.minPrice, Math.min(config.maxPrice, getExpectedPrice(type, state.starRating, floor)));

  const room: Room = {
    id: `room-${floor}-${gridX}-${gridY}`,
    type,
    gridX,
    gridY,
    floor,
    pricePerNight: startingPrice,
    condition: 100,
    cleanliness: HOUSEKEEPING.initialCleanliness,
    status: 'vacant',
    cleaningHoursRemaining: 0,
    lastDailyCleanDay: 0,
    decor: 100,
    renovationHoursRemaining: 0,
  };

  return {
    ...state,
    cash: state.cash - config.buildCost,
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

  const roomConfig = ROOM_CONFIG[config.type];
  const clampedPrice = Math.max(roomConfig.minPrice, Math.min(roomConfig.maxPrice, price));

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

export function demolishRoom(state: HotelState, roomId: string): HotelState | null {
  const room = state.rooms.find(r => r.id === roomId);
  if (!room) return null;
  if (room.status === 'occupied') return null; // can't demolish while occupied

  const refund = getDemolishRefund(ROOM_CONFIG[room.type].buildCost);

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
  const cost = getRenovationCost(ROOM_CONFIG[room.type].buildCost, state.starRating);
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
  return isTileAccessible(state, room.gridX, room.gridY, room.floor);
}

export function getAvailableRooms(state: HotelState): Room[] {
  return state.rooms
    .filter(r => r.status === 'vacant' && r.condition > ECONOMY.roomBreakdownThreshold && isRoomReachable(state, r))
    .sort((a, b) => a.pricePerNight - b.pricePerNight); // ascending price
}

/** Check if a tile on a floor is taken by a room, facility, hallway, desk, or an elevator shaft (which spans every floor). */
export function isTileOccupied(state: HotelState, gridX: number, gridY: number, floor: number): boolean {
  return state.rooms.some(r => r.floor === floor && r.gridX === gridX && r.gridY === gridY)
    || state.facilities.some(f => f.floor === floor && f.gridX === gridX && f.gridY === gridY)
    || state.fixtures.some(f => f.floor === floor && f.gridX === gridX && f.gridY === gridY)
    || state.elevators.some(e => e.gridX === gridX && e.gridY === gridY);
}

export const FIXTURE_COST: Record<FixtureType, number> = {
  hallway: HALLWAY.buildCost,
  desk: DESK.buildCost,
  closet: CLOSET.buildCost,
};

/** Build a hallway tile, check-in desk (ground floor only), or staff closet. */
export function addFixture(state: HotelState, type: FixtureType, gridX: number, gridY: number, floor: number): HotelState | null {
  if (!isValidTile(state, gridX, gridY, floor)) return null;
  if (isTileOccupied(state, gridX, gridY, floor)) return null;
  if (type === 'desk' && floor !== 0) return null;
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
export function getElevatorLoad(state: HotelState): number {
  const upperRooms = state.rooms.filter(r => r.floor > 0).length;
  if (upperRooms === 0) return 0;
  if (state.elevators.length === 0) return Infinity;
  return upperRooms / (state.elevators.length * ELEVATOR.roomsServed);
}

/** Review penalty (0-10 scale) for a guest staying on an upper floor of an overloaded hotel. */
export function getElevatorWaitPenalty(state: HotelState, room: Room): number {
  if (room.floor === 0) return 0;
  const overload = Math.max(0, Math.min(1, getElevatorLoad(state) - 1));
  return overload * ELEVATOR.maxWaitPenalty;
}

export function addFacility(
  state: HotelState,
  type: FacilityType,
  gridX: number,
  gridY: number,
  floor = 0
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

/** Get facilities adjacent to a room on the same floor (within 1 tile, all 8 directions) */
export function getAdjacentFacilities(state: HotelState, gridX: number, gridY: number, floor: number): Facility[] {
  return state.facilities.filter(f =>
    f.floor === floor && Math.abs(f.gridX - gridX) <= 1 && Math.abs(f.gridY - gridY) <= 1
    && !(f.gridX === gridX && f.gridY === gridY)
  );
}
