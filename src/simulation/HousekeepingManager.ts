import type { HotelState, Room, GameEvent, Guest } from './types.js';
import { HOUSEKEEPING, STAFF, ECONOMY, GUEST_HOUSEKEEPING } from '../config/balance.js';
import { formatRoomLabel, isRoomReachable } from './HotelState.js';
import { getStaffTravelHours } from './Layout.js';
import { getStaffPlan, plannedWork, isOnShift } from './StaffManager.js';
import { isCheckoutDay } from './GuestManager.js';
import { occupantFactor, guestsById } from './Party.js';
import { housekeepingPrefOf } from './CleaningPreference.js';

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
  let dndLeft = 0; // do-not-disturb rooms whose guests weren't out long enough while a housekeeper was free
  let dailyCost = 0;
  // With housekeeping preferences on: each guest's cleans this stay, done and missed
  const prefs = GUEST_HOUSEKEEPING.enabled;
  const guests = prefs ? guestsById(state) : new Map<string, Guest>();
  const tally = new Map<string, 'done' | 'missed'>();

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
        if (prefs && room.guestId) tally.set(room.guestId, 'done');
        return {
          ...room,
          cleanliness: Math.min(100, room.cleanliness + HOUSEKEEPING.dailyCleaningBoost),
          lastDailyCleanDay: state.day,
          dailyCleanHoursRemaining: 0,
        };
      }
      if (lastShiftHour) {
        if (prefs && housekeepingPrefOf(guests.get(room.guestId ?? '')) === 'dnd') dndLeft++;
        else dailySkipped++;
        if (prefs && room.guestId) tally.set(room.guestId, 'missed');
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
  if (dndLeft > 0) {
    events.push({
      type: 'dnd_rooms_left',
      message: `${dndLeft} do-not-disturb room${dndLeft > 1 ? 's' : ''} not cleaned today (the guests weren't out while a housekeeper was free)`,
      data: { roomsLeft: dndLeft },
    });
  }
  const guestsAfter = tally.size === 0 ? state.guests : state.guests.map(g => {
    const how = tally.get(g.id);
    if (!how) return g;
    const cleans = g.cleans ?? { done: 0, missed: 0 };
    return { ...g, cleans: { ...cleans, [how]: cleans[how] + 1 } };
  });

  return {
    state: { ...state, rooms: updatedRooms, guests: guestsAfter, cash: state.cash - dailyCost },
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
  // Every other day: on the off days, only guests who want their room made up daily get a clean
  const offDay = cadence === 'every_other_day' && state.day % 2 !== 0;
  if (offDay && !GUEST_HOUSEKEEPING.enabled) return { state, events: [] };

  const cleanHours = 1 / STAFF.housekeeping.dailyCleanRoomsPerHour;
  let queued = 0;
  const rooms = state.rooms.map(room => {
    if (room.status !== 'occupied' || room.lastDailyCleanDay >= state.day) return room;
    if (!isRoomReachable(state, room)) return room;
    const guest = state.guests.find(g => g.id === room.guestId);
    if (guest && isCheckoutDay(guest, state.day)) return room; // leaving today: the turnover will do
    if (offDay && housekeepingPrefOf(guest) !== 'makeup') return room;
    queued++;
    return { ...room, dailyCleanHoursRemaining: cleanHours };
  });

  if (queued === 0) return { state, events: [] };
  return { state: { ...state, rooms }, events: [] };
}

/** Average stay in nights, for workload planning. */
const AVERAGE_STAY_NIGHTS = (ECONOMY.guestMinStay + ECONOMY.guestMaxStay) / 2;

/**
 * A housekeeper's walk to each job, in walks from a staff base. They take jobs
 * by urgency, not by distance, so they walk from the last room (often on
 * another floor), not from the closet: in bot hotels, 2.1 to 2.7 times the
 * walk from a base, more as the hotel grows.
 */
const WALKS_PER_JOB = 2.5;

/** The walk from a staff base to a room, on average (one turnover to the next is about one such walk). */
export function baseWalkHours(state: HotelState): number {
  const walks = state.rooms.map(r => getStaffTravelHours(state, r)).filter(Number.isFinite);
  return walks.length > 0 ? walks.reduce((a, b) => a + b, 0) / walks.length : 0;
}

/**
 * Housekeeper-hours a day of work needs at a given occupancy (0-1): turnovers
 * for the day's checkouts plus the daily-clean round, each with a walk there
 * (WALKS_PER_JOB average walks from a staff base).
 */
export function estimateHousekeepingHours(state: HotelState, occupancy: number): number {
  const walks = state.rooms.map(r => getStaffTravelHours(state, r)).filter(Number.isFinite);
  const avgWalk = (walks.length > 0 ? walks.reduce((a, b) => a + b, 0) / walks.length : 0) * WALKS_PER_JOB;
  const occupied = state.rooms.length * occupancy;
  const checkouts = occupied / AVERAGE_STAY_NIGHTS;
  const turnover = HOUSEKEEPING.turnoverDuration[state.housekeeping.turnoverQuality] ?? HOUSEKEEPING.turnoverDuration.standard;
  // Every other day: half the rooms a day, and (with preferences on) the make-up rooms on the off days too
  const makeupShare = GUEST_HOUSEKEEPING.enabled ? expectedShare('makeup') : 0;
  const cadence = state.housekeeping.dailyCadence === 'daily' ? 1 : state.housekeeping.dailyCadence === 'every_other_day' ? 0.5 + 0.5 * makeupShare : 0;
  const stayovers = occupied - checkouts; // guests leaving today get the turnover, not a daily clean (processDailyHousekeeping skips them)
  const dailyRound = stayovers * cadence * (1 / STAFF.housekeeping.dailyCleanRoomsPerHour + avgWalk);
  return checkouts * (turnover + avgWalk) + dailyRound;
}

/** The share of guests who want a kind of housekeeping (by the usual weights). */
function expectedShare(pref: 'dnd' | 'standard' | 'makeup'): number {
  const weights = GUEST_HOUSEKEEPING.byLean.base;
  return (weights.find(([p]) => p === pref)?.[1] ?? 0) / weights.reduce((sum, [, w]) => sum + w, 0);
}

/**
 * Housekeeper-hours available in a day: one per housekeeper per shift hour,
 * from when the day's work is there (shift hours before the daily round is
 * queued have only yesterday's leftovers to do).
 */
export function housekeepingHoursAvailable(housekeepers: number): number {
  return housekeepers * (STAFF.housekeeping.workEndHour - Math.max(STAFF.housekeeping.workStartHour, HOUSEKEEPING.dailyCleaningHour));
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
    // A bigger party makes more mess, and (with preferences on) a rowdy one more still
    const rowdy = GUEST_HOUSEKEEPING.enabled && guests.get(room.guestId ?? '')?.profile?.rowdiness === 'rowdy' ? GUEST_HOUSEKEEPING.rowdyMessMult : 1;
    return {
      ...room,
      cleanliness: Math.max(0, room.cleanliness - HOUSEKEEPING.cleanlinessDecayPerDay * occupantFactor(state, room, guests) * rowdy),
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
