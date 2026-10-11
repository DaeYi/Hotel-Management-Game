import type { HotelState, Room, StaffPlan } from './types.js';
import { HOUSEKEEPING, STAFF } from '../config/balance.js';
import { isRoomReachable } from './HotelState.js';
import { getStaffPlan, getRoster, isOnShift } from './StaffManager.js';
import { hourStart } from './Movement.js';

// Where each room's cleaning stands at a moment in the hour, for the cleaning
// overlay, the housekeeping panel and the room inspector. It reads the same
// staff plan the housekeepers on screen walk (and the tick credits), so a room
// shown "being cleaned" has a housekeeper standing in it, and the work left
// counts down exactly as the tick will credit it.

export type CleaningJob = 'turnover' | 'daily';
/** In the room now; walking there (or due there later this hour); or nobody's on it this hour. */
export type CleaningPhase = 'cleaning' | 'on_the_way' | 'waiting';
/** Why a room is waiting: nobody to do it, nobody can get there, the shift's over, the new hires aren't in yet, or everyone's busy. */
export type CleaningWait = 'no_housekeepers' | 'unreachable' | 'off_shift' | 'arriving' | 'busy';

export interface RoomCleaning {
  job: CleaningJob; // a turnover between guests, or a daily clean during a stay
  phase: CleaningPhase;
  wait?: CleaningWait; // set while waiting
  hoursLeft: number; // housekeeper-hours of work still to do, as of the moment asked about
  progress: number; // 0-1: how much of the job is done
  staffId?: string; // the housekeeper on it (cleaning, or on the way)
}

/** Below this cleanliness a room hurts its guest's review. */
export const GRUBBY_BELOW = HOUSEKEEPING.cleanlinessMidpoint;

/**
 * Every room with cleaning to do -- a turnover, or a queued daily clean -- and
 * where it stands at time t (absolute game hours, within the state's hour).
 * Rooms with nothing to do, or whose work is done by t (the hour's tick will
 * mark them clean), aren't in the map. Pass the hour's plan if you have it.
 */
export function roomCleaningAt(state: HotelState, t: number, plan: StaffPlan = getStaffPlan(state)): Map<string, RoomCleaning> {
  const T = hourStart(state);
  const now = Math.min(Math.max(t, T), T + 1);
  const roster = getRoster(state);
  const roles = new Map(roster.map(m => [m.id, m.role]));
  // Hired housekeepers who are on the books this hour (new hires join at the next hour)
  const staffed = roster.some(m => m.role === 'housekeeper' && !m.leaving);
  const isHousekeeper = (staffId: string) => (roles.get(staffId) ?? (staffId.startsWith('housekeeper') ? 'housekeeper' : 'maintenance')) === 'housekeeper';

  // Every housekeeper's cleaning stays this hour, by room; and who ends the hour still walking to one
  const stays = new Map<string, Array<{ staffId: string; job: CleaningJob; start: number; end: number }>>();
  const heading = new Map<string, string>();
  for (const it of plan.itineraries) {
    if (!isHousekeeper(it.staffId)) continue;
    for (const leg of it.legs) {
      if (leg.kind !== 'stay' || !leg.placeId || (leg.job !== 'turnover' && leg.job !== 'daily')) continue;
      const list = stays.get(leg.placeId) ?? [];
      list.push({ staffId: it.staffId, job: leg.job, start: leg.start, end: leg.end });
      stays.set(leg.placeId, list);
    }
    const target = it.end.roomId;
    if (target && !it.legs.some(l => l.kind === 'stay' && l.placeId === target)) heading.set(target, it.staffId);
  }

  const result = new Map<string, RoomCleaning>();
  for (const room of state.rooms) {
    const job: CleaningJob | null = room.status === 'cleaning' ? 'turnover'
      : room.status === 'occupied' && room.dailyCleanHoursRemaining > 1e-9 ? 'daily'
      : null;
    if (!job) continue;
    const owed = job === 'turnover' ? room.cleaningHoursRemaining : room.dailyCleanHoursRemaining;
    const mine = (stays.get(room.id) ?? []).filter(s => s.job === job);
    // Work done so far this hour: the part of each stay (within the hour) before now
    const worked = mine.reduce((sum, s) => sum + Math.max(0, Math.min(s.end, now, T + 1) - Math.max(s.start, T)), 0);
    const hoursLeft = Math.max(0, owed - worked);
    if (hoursLeft <= 1e-9) continue;
    // Against the job's own size: the turnover as it was set at checkout (a quality change later doesn't resize it)
    const full = job === 'turnover'
      ? room.cleaningHoursTotal ?? HOUSEKEEPING.turnoverDuration[state.housekeeping.turnoverQuality] ?? HOUSEKEEPING.turnoverDuration.standard
      : 1 / STAFF.housekeeping.dailyCleanRoomsPerHour;
    const progress = Math.min(1, Math.max(0, 1 - hoursLeft / Math.max(full, owed)));

    const inRoom = mine.find(s => s.start <= now && now < s.end);
    const later = mine.find(s => s.start > now);
    if (inRoom) {
      result.set(room.id, { job, phase: 'cleaning', hoursLeft, progress, staffId: inRoom.staffId });
    } else if (later || heading.has(room.id)) {
      result.set(room.id, { job, phase: 'on_the_way', hoursLeft, progress, staffId: later?.staffId ?? heading.get(room.id) });
    } else {
      result.set(room.id, { job, phase: 'waiting', wait: waitReason(state, room, staffed), hoursLeft, progress });
    }
  }
  return result;
}

function waitReason(state: HotelState, room: Room, staffed: boolean): CleaningWait {
  if (state.staff.housekeepers <= 0) return 'no_housekeepers';
  if (!isRoomReachable(state, room)) return 'unreachable';
  if (!isOnShift('housekeeper', state.hour)) return 'off_shift';
  if (!staffed) return 'arriving';
  return 'busy';
}

/** What a waiting room is waiting for, in words. */
export function describeWait(wait: CleaningWait): string {
  switch (wait) {
    case 'no_housekeepers': return 'no housekeepers hired';
    case 'unreachable': return "housekeepers can't get to it";
    case 'off_shift': return `housekeepers start at ${STAFF.housekeeping.workStartHour}:00`;
    case 'arriving': return 'new housekeepers start next hour';
    case 'busy': return 'all housekeepers busy';
  }
}

export interface CleaningSummary {
  turnovers: { cleaning: number; onTheWay: number; waiting: number };
  waits: Partial<Record<CleaningWait, number>>; // waiting turnovers, by reason
  daily: { cleaning: number; due: number }; // daily cleans being done now, and ones not started (a housekeeper may be on the way)
  grubby: number; // rooms (in use or ready to sell) clean enough to hurt a review
  waitingByFloor: Map<number, number>; // waiting turnovers on each floor
}

/** Counts across the hotel, for the housekeeping panel. */
export function summarizeCleaning(state: HotelState, t: number, plan?: StaffPlan): CleaningSummary {
  const status = roomCleaningAt(state, t, plan);
  const summary: CleaningSummary = {
    turnovers: { cleaning: 0, onTheWay: 0, waiting: 0 },
    waits: {},
    daily: { cleaning: 0, due: 0 },
    grubby: 0,
    waitingByFloor: new Map(),
  };
  for (const room of state.rooms) {
    const s = status.get(room.id);
    if (s?.job === 'turnover') {
      if (s.phase === 'cleaning') summary.turnovers.cleaning++;
      else if (s.phase === 'on_the_way') summary.turnovers.onTheWay++;
      else {
        summary.turnovers.waiting++;
        summary.waits[s.wait!] = (summary.waits[s.wait!] ?? 0) + 1;
        summary.waitingByFloor.set(room.floor, (summary.waitingByFloor.get(room.floor) ?? 0) + 1);
      }
      continue;
    }
    if (s?.job === 'daily') {
      if (s.phase === 'cleaning') summary.daily.cleaning++;
      else summary.daily.due++;
    }
    if ((room.status === 'occupied' || room.status === 'vacant') && room.cleanliness < GRUBBY_BELOW) summary.grubby++;
  }
  return summary;
}
