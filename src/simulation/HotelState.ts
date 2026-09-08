import type { HotelState, Room, RoomType, Facility, FacilityType } from './types.js';
import { ECONOMY, ROOM_CONFIG, GRID, HOUSEKEEPING, FACILITY_CONFIG } from '../config/balance.js';
import { createConstructionNoise } from './NoiseManager.js';

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
  };
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

  // Check affordability
  if (state.cash < config.buildCost) {
    return null;
  }

  const room: Room = {
    id: `room-${gridX}-${gridY}`,
    type,
    gridX,
    gridY,
    pricePerNight: config.defaultPrice,
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

export function demolishRoom(state: HotelState, roomId: string): HotelState | null {
  const room = state.rooms.find(r => r.id === roomId);
  if (!room) return null;
  if (room.status === 'occupied') return null; // can't demolish while occupied

  // Refund 25% of build cost
  const refund = Math.floor(ROOM_CONFIG[room.type].buildCost * 0.25);

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
  const refund = Math.floor((config?.buildCost ?? 0) * 0.25);

  return {
    ...state,
    cash: state.cash + refund,
    facilities: state.facilities.filter(f => f.id !== facilityId),
    noiseSources: [...state.noiseSources, createConstructionNoise(facility.gridX, facility.gridY, 'demolish')],
  };
}

/** Get facilities adjacent to a room (within 1 tile, all 8 directions) */
export function getAdjacentFacilities(state: HotelState, gridX: number, gridY: number): Facility[] {
  return state.facilities.filter(f =>
    Math.abs(f.gridX - gridX) <= 1 && Math.abs(f.gridY - gridY) <= 1
    && !(f.gridX === gridX && f.gridY === gridY)
  );
}
