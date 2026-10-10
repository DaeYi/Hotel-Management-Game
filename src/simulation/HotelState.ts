import type { HotelState, Room, RoomType, Facility, FacilityType, TileType } from './types.js';
import { ECONOMY, ROOM_CONFIG, GRID, HOUSEKEEPING, FACILITY_CONFIG, LOAN } from '../config/balance.js';
import { createConstructionNoise } from './NoiseManager.js';
import { getExpectedPrice } from './StarRatingManager.js';

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
  };
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

export function addRoom(
  state: HotelState,
  type: RoomType,
  gridX: number,
  gridY: number
): HotelState | null {
  const config = ROOM_CONFIG[type];

  // Validate position
  if (gridX < 0 || gridX >= GRID.width || gridY < 0 || gridY >= GRID.height) {
    return null;
  }

  // Check for duplicate position (rooms or facilities)
  if (isTileOccupied(state, gridX, gridY)) {
    return null;
  }

  // Check affordability and unlock
  if (state.cash < config.buildCost) {
    return null;
  }
  if (!isUnlocked(state, type)) {
    return null;
  }

  // New rooms start at the fair price for the hotel's current star level
  const startingPrice = Math.max(config.minPrice, Math.min(config.maxPrice, getExpectedPrice(type, state.starRating)));

  const room: Room = {
    id: `room-${gridX}-${gridY}`,
    type,
    gridX,
    gridY,
    pricePerNight: startingPrice,
    condition: 100,
    cleanliness: HOUSEKEEPING.initialCleanliness,
    status: 'vacant',
    cleaningHoursRemaining: 0,
    lastDailyCleanDay: 0,
  };

  return {
    ...state,
    cash: state.cash - config.buildCost,
    rooms: [...state.rooms, room],
    noiseSources: [...state.noiseSources, createConstructionNoise(gridX, gridY, 'build')],
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
    noiseSources: [...state.noiseSources, createConstructionNoise(room.gridX, room.gridY, 'demolish')],
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

export function getOccupancyRate(state: HotelState): number {
  if (state.rooms.length === 0) return 0;
  const occupied = state.rooms.filter(r => r.status === 'occupied').length;
  return occupied / state.rooms.length;
}

export function getAvailableRooms(state: HotelState): Room[] {
  return state.rooms
    .filter(r => r.status === 'vacant' && r.condition > ECONOMY.roomBreakdownThreshold)
    .sort((a, b) => a.pricePerNight - b.pricePerNight); // ascending price
}

/** Check if a grid position is occupied by a room or facility */
export function isTileOccupied(state: HotelState, gridX: number, gridY: number): boolean {
  return state.rooms.some(r => r.gridX === gridX && r.gridY === gridY)
    || state.facilities.some(f => f.gridX === gridX && f.gridY === gridY);
}

export function addFacility(
  state: HotelState,
  type: FacilityType,
  gridX: number,
  gridY: number
): HotelState | null {
  const config = FACILITY_CONFIG[type];
  if (!config) return null;

  if (gridX < 0 || gridX >= GRID.width || gridY < 0 || gridY >= GRID.height) return null;
  if (isTileOccupied(state, gridX, gridY)) return null;
  if (state.cash < config.buildCost) return null;
  if (!isUnlocked(state, type)) return null;

  const facility: Facility = {
    id: `facility-${gridX}-${gridY}`,
    type,
    gridX,
    gridY,
    condition: 100,
  };

  return {
    ...state,
    cash: state.cash - config.buildCost,
    facilities: [...state.facilities, facility],
    noiseSources: [...state.noiseSources, createConstructionNoise(gridX, gridY, 'build')],
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
    noiseSources: [...state.noiseSources, createConstructionNoise(facility.gridX, facility.gridY, 'demolish')],
  };
}

/**
 * Derive a hotel-style room number from grid position (floor = row, unit = column),
 * e.g. row 2, column 4 -> "204". Pure formatting, no stored data (design-review D9) --
 * used in RoomInspector's title, a grid tile label, and Story Log/toast message text.
 */
export function formatRoomLabel(gridX: number, gridY: number): string {
  const floor = gridY + 1;
  const unit = String(gridX + 1).padStart(2, '0');
  return `${floor}${unit}`;
}

/** Get facilities adjacent to a room (within 1 tile, all 8 directions) */
export function getAdjacentFacilities(state: HotelState, gridX: number, gridY: number): Facility[] {
  return state.facilities.filter(f =>
    Math.abs(f.gridX - gridX) <= 1 && Math.abs(f.gridY - gridY) <= 1
    && !(f.gridX === gridX && f.gridY === gridY)
  );
}
