import type { HotelState, Room, GameEvent } from './types.js';
import { HOUSEKEEPING, STAFF, ECONOMY } from '../config/balance.js';
import { formatRoomLabel, isRoomReachable } from './HotelState.js';
import { getStaffTravelHours } from './Layout.js';
import { getStaffPlan, plannedWork, isOnShift } from './StaffManager.js';
import { isCheckoutDay } from './GuestManager.js';
import { occupantFactor, guestsById } from './Party.js';

/**
 * Start turnover cleaning on a room after guest checkout. The housekeepers'
 * walks are planned separately (StaffManager.ts), from wherever they are.
 * Room transitions: occupied → cleaning
 */
export function startTurnoverCleaning(room: Room, quality: string): Room {
  const duration = HOUSEKEEPING.turnoverDuration[quality] ?? HOUSEKEEPING.turnoverDuration.standard;
  return {
    ...room,
    status: 'cleaning',
    guestId: undefined,
    cleaningHoursRemaining: duration,
    cleaningHoursTotal: duration,
    dailyCleanHoursRemaining: 0, // a pending daily clean is moot once the guest leaves
  };
}

/**
 * One hour of housekeeping: credit each room exactly the cleaning the staff
 * plan has a housekeeper doing in it this hour (getStaffPlan -- the plan the
 * walking staff on screen follow). Daily cleans still pending when the shift
 * ends are skipped. No housekeepers = rooms stay in 'cleaning' indefinitely.
 */
export function processCleaningTick(state: HotelState): { state: HotelState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  const quality = state.housekeeping.turnoverQuality;
  const targetCleanliness = HOUSEKEEPING.turnoverCleanlinessResult[quality] ?? 85;

  // Outside work hours = no cleaning
  if (!isOnShift('housekeeper', state.hour)) return { state, events };

  // Hours of work each room gets this hour, per the plan
  const plan = getStaffPlan(state);
  const turnoverWork = plannedWork(plan, 'turnover');
  const dailyWork = plannedWork(plan, 'daily');
  const cleaningRooms = state.rooms.filter(r => r.status === 'cleaning');

  const lastShiftHour = state.hour === STAFF.housekeeping.workEndHour - 1;
  let dailyDone = 0;
  let dailySkipped = 0;
  let dailyCost = 0;

  const updatedRooms = state.rooms.map(room => {
    const turnover = turnoverWork.get(room.id);
    if (turnover !== undefined && room.status === 'cleaning') {
      const remaining = room.cleaningHoursRemaining - turnover;
      if (remaining <= 1e-9) {
        events.push({
          type: 'room_cleaned',
          message: `Room ${formatRoomLabel(room.gridX, room.gridY, room.floor)} cleaned (${quality})`,
          data: { roomId: room.id, quality },
        });
        return { ...room, status: 'vacant' as const, cleanliness: Math.max(room.cleanliness, targetCleanliness), cleaningHoursRemaining: 0, cleaningHoursTotal: undefined };
      }
      return { ...room, cleaningHoursRemaining: remaining };
    }

    if (room.dailyCleanHoursRemaining > 0 && room.status === 'occupied') {
      const remaining = room.dailyCleanHoursRemaining - (dailyWork.get(room.id) ?? 0);
      if (remaining <= 1e-9) {
        dailyDone++;
        dailyCost += HOUSEKEEPING.dailyCleaningCost;
        return {
          ...room,
          cleanliness: Math.min(100, room.cleanliness + HOUSEKEEPING.dailyCleaningBoost),
          lastDailyCleanDay: state.day,
          dailyCleanHoursRemaining: 0,
        };
      }
      if (lastShiftHour) {
        dailySkipped++;
        return { ...room, dailyCleanHoursRemaining: 0 };
      }
      return { ...room, dailyCleanHoursRemaining: remaining };
    }
    return room;
  });

  // Warn if rooms are stuck waiting for housekeepers
  const waitingRooms = cleaningRooms.length - turnoverWork.size;
  if (waitingRooms > 0) {
    events.push({
      type: 'daily_cleaning',
      message: `${waitingRooms} room${waitingRooms > 1 ? 's' : ''} waiting for housekeepers`,
      data: { waitingRooms },
    });
  }
  if (dailySkipped > 0) {
    events.push({
      type: 'daily_cleaning',
      message: `${dailySkipped} daily clean${dailySkipped > 1 ? 's' : ''} skipped -- need more housekeepers`,
      data: { roomsSkipped: dailySkipped },
    });
  }

  return {
    state: { ...state, rooms: updatedRooms, cash: state.cash - dailyCost },
    events: dailyDone > 0
      ? [...events, { type: 'daily_cleaning', message: `Daily housekeeping: ${dailyDone} room${dailyDone > 1 ? 's' : ''} cleaned ($${dailyCost})`, data: { roomsCleaned: dailyDone, cost: dailyCost } }]
      : events,
  };
}

/**
 * At HOUSEKEEPING.dailyCleaningHour, queue a daily clean for every occupied
 * room due one (per the cadence) that staff can get to. Housekeepers work
 * through them alongside turnovers, walking from room to room.
 */
export function processDailyHousekeeping(state: HotelState): { state: HotelState; events: GameEvent[] } {
  const cadence = state.housekeeping.dailyCadence;
  if (cadence === 'none') return { state, events: [] };
  if (state.hour !== HOUSEKEEPING.dailyCleaningHour) return { state, events: [] };
  if (cadence === 'every_other_day' && state.day % 2 !== 0) return { state, events: [] };

  const cleanHours = 1 / STAFF.housekeeping.dailyCleanRoomsPerHour;
  let queued = 0;
  const rooms = state.rooms.map(room => {
    if (room.status !== 'occupied' || room.lastDailyCleanDay >= state.day) return room;
    if (!isRoomReachable(state, room)) return room;
    const guest = state.guests.find(g => g.id === room.guestId);
    if (guest && isCheckoutDay(guest, state.day)) return room; // leaving today: the turnover will do
    queued++;
    return { ...room, dailyCleanHoursRemaining: cleanHours };
  });

  if (queued === 0) return { state, events: [] };
  return { state: { ...state, rooms }, events: [] };
}

/** Average stay in nights, for workload planning. */
const AVERAGE_STAY_NIGHTS = (ECONOMY.guestMinStay + ECONOMY.guestMaxStay) / 2;

/**
 * Housekeeper-hours a day of work needs at a given occupancy (0-1): turnovers
 * for the day's checkouts plus the daily-clean round, each with a walk there
 * (estimated as the average walk from a staff base).
 */
export function estimateHousekeepingHours(state: HotelState, occupancy: number): number {
  const walks = state.rooms.map(r => getStaffTravelHours(state, r)).filter(Number.isFinite);
  const avgWalk = walks.length > 0 ? walks.reduce((a, b) => a + b, 0) / walks.length : 0;
  const occupied = state.rooms.length * occupancy;
  const checkouts = occupied / AVERAGE_STAY_NIGHTS;
  const turnover = HOUSEKEEPING.turnoverDuration[state.housekeeping.turnoverQuality] ?? HOUSEKEEPING.turnoverDuration.standard;
  const cadence = state.housekeeping.dailyCadence === 'daily' ? 1 : state.housekeeping.dailyCadence === 'every_other_day' ? 0.5 : 0;
  const stayovers = occupied - checkouts; // guests leaving today get the turnover, not a daily clean (processDailyHousekeeping skips them)
  const dailyRound = stayovers * cadence * (1 / STAFF.housekeeping.dailyCleanRoomsPerHour + avgWalk);
  return checkouts * (turnover + avgWalk) + dailyRound;
}

/** Housekeeper-hours available in a day: one per housekeeper per shift hour. */
export function housekeepingHoursAvailable(housekeepers: number): number {
  return housekeepers * (STAFF.housekeeping.workEndHour - STAFF.housekeeping.workStartHour);
}

/** Housekeepers needed to keep up at a given occupancy. */
export function housekeepersNeeded(state: HotelState, occupancy: number): number {
  return Math.ceil(estimateHousekeepingHours(state, occupancy) / housekeepingHoursAvailable(1));
}

/**
 * Degrade cleanliness of occupied rooms. Called once per day.
 */
export function degradeCleanliness(state: HotelState): HotelState {
  const guests = guestsById(state);
  const updatedRooms = state.rooms.map(room => {
    if (room.status !== 'occupied') return room;
    // A bigger party makes more mess
    return {
      ...room,
      cleanliness: Math.max(0, room.cleanliness - HOUSEKEEPING.cleanlinessDecayPerDay * occupantFactor(state, room, guests)),
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
 * Get housekeeping staffing info for the UI: what's waiting now, and whether
 * the team can keep up with a full hotel's workload.
 */
export function getHousekeepingStatus(state: HotelState): {
  housekeepers: number;
  roomsBeingCleaned: number;
  roomsWaiting: number;
  hoursNeeded: number;
  hoursAvailable: number;
  recommendation: string | null;
} {
  const housekeepers = state.staff.housekeepers;
  const roomsBeingCleaned = state.rooms.filter(r => r.status === 'cleaning').length;
  const roomsWaiting = Math.max(0, roomsBeingCleaned - housekeepers);
  const hoursNeeded = estimateHousekeepingHours(state, PLANNING_OCCUPANCY);
  const hoursAvailable = housekeepingHoursAvailable(housekeepers);

  let recommendation: string | null = null;
  if (housekeepers === 0 && state.rooms.length > 0) {
    recommendation = 'Hire housekeepers or rooms will never be cleaned!';
  } else if (hoursNeeded > hoursAvailable * 1.05) {
    recommendation = `A busy day needs ${housekeepersNeeded(state, PLANNING_OCCUPANCY)} housekeepers.`;
  } else if (roomsWaiting > 0) {
    recommendation = `${roomsWaiting} rooms waiting to be cleaned.`;
  }

  return { housekeepers, roomsBeingCleaned, roomsWaiting, hoursNeeded, hoursAvailable, recommendation };
}

/** Occupancy the staffing advice plans for: a busy but not sold-out day. */
export const PLANNING_OCCUPANCY = 0.85;
