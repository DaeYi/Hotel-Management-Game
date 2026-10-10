import type { HotelState, Room, GameEvent } from './types.js';
import { HOUSEKEEPING, STAFF } from '../config/balance.js';
import { formatRoomLabel } from './HotelState.js';

/**
 * Start turnover cleaning on a room after guest checkout.
 * Room transitions: occupied → cleaning
 */
export function startTurnoverCleaning(room: Room, quality: string): Room {
  const duration = HOUSEKEEPING.turnoverDuration[quality] ?? HOUSEKEEPING.turnoverDuration.standard;
  return {
    ...room,
    status: 'cleaning',
    guestId: undefined,
    cleaningHoursRemaining: duration,
  };
}

/**
 * Process cleaning ticks. Rooms in 'cleaning' status count down,
 * but ONLY if housekeepers are available to work on them.
 * No housekeepers = rooms stay in 'cleaning' state indefinitely.
 */
export function processCleaningTick(state: HotelState): { state: HotelState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  const quality = state.housekeeping.turnoverQuality;
  const targetCleanliness = HOUSEKEEPING.turnoverCleanlinessResult[quality] ?? 85;
  const housekeepers = state.staff.housekeepers;

  // No housekeepers = no cleaning progress
  if (housekeepers <= 0) return { state, events };

  // Outside work hours = no cleaning
  if (state.hour < STAFF.housekeeping.workStartHour || state.hour >= STAFF.housekeeping.workEndHour) {
    return { state, events };
  }

  // How many rooms can be actively cleaned this hour?
  const turnoverCapacity = housekeepers * STAFF.housekeeping.turnoverRoomsPerHour;

  // Get rooms being cleaned, sorted by least remaining time (finish soonest first)
  const cleaningRooms = state.rooms
    .filter(r => r.status === 'cleaning')
    .sort((a, b) => a.cleaningHoursRemaining - b.cleaningHoursRemaining);

  // Only the first N rooms (by capacity) get progress this hour
  const activeRoomIds = new Set(
    cleaningRooms.slice(0, turnoverCapacity).map(r => r.id)
  );

  const updatedRooms = state.rooms.map(room => {
    if (room.status !== 'cleaning') return room;

    // Room is cleaning but no housekeeper available for it
    if (!activeRoomIds.has(room.id)) return room;

    const remaining = room.cleaningHoursRemaining - 1;
    if (remaining <= 0) {
      events.push({
        type: 'room_cleaned',
        message: `Room ${formatRoomLabel(room.gridX, room.gridY, room.floor)} cleaned (${quality})`,
        data: { roomId: room.id, quality },
      });
      return {
        ...room,
        status: 'vacant' as const,
        cleanliness: Math.max(room.cleanliness, targetCleanliness),
        cleaningHoursRemaining: 0,
      };
    }

    return { ...room, cleaningHoursRemaining: remaining };
  });

  // Warn if rooms are stuck waiting for housekeepers
  const waitingRooms = cleaningRooms.length - activeRoomIds.size;
  if (waitingRooms > 0) {
    events.push({
      type: 'daily_cleaning',
      message: `${waitingRooms} room${waitingRooms > 1 ? 's' : ''} waiting for housekeepers`,
      data: { waitingRooms },
    });
  }

  return { state: { ...state, rooms: updatedRooms }, events };
}

/**
 * Process daily housekeeping for occupied rooms.
 * Requires housekeepers to be available. Capacity limits how many rooms
 * can be cleaned per hour.
 */
export function processDailyHousekeeping(state: HotelState): { state: HotelState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  const cadence = state.housekeeping.dailyCadence;
  const housekeepers = state.staff.housekeepers;

  if (cadence === 'none' || housekeepers <= 0) return { state, events };
  if (state.hour !== HOUSEKEEPING.dailyCleaningHour) return { state, events };

  // How many occupied rooms can be daily-cleaned this hour?
  // (Daily cleaning is faster than turnover since it's a lighter clean)
  const dailyCapacity = housekeepers * STAFF.housekeeping.dailyCleanRoomsPerHour;

  // Find rooms eligible for daily cleaning
  const eligibleRooms = state.rooms.filter(room => {
    if (room.status !== 'occupied') return false;
    if (cadence === 'every_other_day' && state.day % 2 !== 0) return false;
    if (room.lastDailyCleanDay >= state.day) return false;
    return true;
  });

  // Clean up to capacity, prioritizing dirtiest rooms
  const roomsToClean = [...eligibleRooms]
    .sort((a, b) => a.cleanliness - b.cleanliness)
    .slice(0, dailyCapacity);

  const cleanedIds = new Set(roomsToClean.map(r => r.id));
  let totalCost = 0;

  const updatedRooms = state.rooms.map(room => {
    if (!cleanedIds.has(room.id)) return room;
    totalCost += HOUSEKEEPING.dailyCleaningCost;
    return {
      ...room,
      cleanliness: Math.min(100, room.cleanliness + HOUSEKEEPING.dailyCleaningBoost),
      lastDailyCleanDay: state.day,
    };
  });

  const roomsCleaned = roomsToClean.length;
  const roomsSkipped = eligibleRooms.length - roomsCleaned;

  if (roomsCleaned > 0) {
    events.push({
      type: 'daily_cleaning',
      message: `Daily housekeeping: ${roomsCleaned} rooms ($${totalCost})${roomsSkipped > 0 ? ` (${roomsSkipped} skipped, need more housekeepers)` : ''}`,
      data: { roomsCleaned, roomsSkipped, cost: totalCost },
    });
  } else if (eligibleRooms.length > 0) {
    events.push({
      type: 'daily_cleaning',
      message: `No housekeepers available! ${eligibleRooms.length} rooms not cleaned`,
      data: { roomsSkipped: eligibleRooms.length },
    });
  }

  return {
    state: { ...state, rooms: updatedRooms, cash: state.cash - totalCost },
    events,
  };
}

/**
 * Degrade cleanliness of occupied rooms. Called once per day.
 */
export function degradeCleanliness(state: HotelState): HotelState {
  const updatedRooms = state.rooms.map(room => {
    if (room.status !== 'occupied') return room;
    return {
      ...room,
      cleanliness: Math.max(0, room.cleanliness - HOUSEKEEPING.cleanlinessDecayPerDay),
    };
  });
  return { ...state, rooms: updatedRooms };
}

/**
 * Check if current housekeeping cadence meets star rating requirements.
 */
export function checkHousekeepingCompliance(state: HotelState): string | null {
  const currentStars = state.starRating;
  const cadence = state.housekeeping.dailyCadence;

  // Check if there are enough housekeepers
  if (state.staff.housekeepers <= 0 && state.rooms.length > 0) {
    return 'No housekeepers hired! Rooms will not be cleaned';
  }

  for (const req of HOUSEKEEPING.starRequirements) {
    if (currentStars >= req.minStars) {
      if (req.requiredCadence === 'daily' && cadence !== 'daily') {
        return `${req.minStars}+ star hotels require daily housekeeping`;
      }
      if (req.requiredCadence === 'every_other_day' && cadence === 'none') {
        return `${req.minStars}+ star hotels require at least every-other-day housekeeping`;
      }
      break;
    }
  }

  return null;
}

/**
 * Get housekeeping staffing info for the UI.
 */
export function getHousekeepingStatus(state: HotelState): {
  housekeepers: number;
  roomsBeingCleaned: number;
  roomsWaiting: number;
  dailyCapacity: number;
  turnoverCapacity: number;
  recommendation: string | null;
} {
  const housekeepers = state.staff.housekeepers;
  const roomsBeingCleaned = state.rooms.filter(r => r.status === 'cleaning').length;
  const turnoverCapacity = housekeepers * STAFF.housekeeping.turnoverRoomsPerHour;
  const dailyCapacity = housekeepers * STAFF.housekeeping.dailyCleanRoomsPerHour;
  const roomsWaiting = Math.max(0, roomsBeingCleaned - turnoverCapacity);

  let recommendation: string | null = null;
  if (housekeepers === 0 && state.rooms.length > 0) {
    recommendation = 'Hire housekeepers or rooms will never be cleaned!';
  } else if (roomsWaiting > 0) {
    recommendation = `${roomsWaiting} rooms waiting. Hire more housekeepers.`;
  } else if (housekeepers > 0 && state.rooms.length > dailyCapacity && state.housekeeping.dailyCadence !== 'none') {
    recommendation = `Need ${Math.ceil(state.rooms.length / STAFF.housekeeping.dailyCleanRoomsPerHour)} housekeepers for daily cleaning of ${state.rooms.length} rooms`;
  }

  return {
    housekeepers,
    roomsBeingCleaned,
    roomsWaiting,
    dailyCapacity,
    turnoverCapacity,
    recommendation,
  };
}
