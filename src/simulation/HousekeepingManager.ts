import type { HotelState, Room, GameEvent, Guest } from './types.js';
import { HOUSEKEEPING, STAFF, ECONOMY, GUEST_HOUSEKEEPING } from '../config/balance.js';
import { formatRoomLabel, isRoomReachable } from './HotelState.js';
import { getStaffTravelHours } from './Layout.js';
import { getStaffPlan, plannedWork, isOnShift } from './StaffManager.js';
import { isCheckoutDay } from './GuestManager.js';
import { occupantFactor, guestsById } from './Party.js';
import { housekeepingPrefOf } from './CleaningPreference.js';
import { cleanlinessDelta, staffRate, attendanceShare, attendance, cleaningTrained } from './StaffProfiles.js';
import { recordHospitality } from './StaffHospitality.js';
import { guestTileAt } from './GuestMovement.js';
import { sameTile } from './Movement.js';
import { fatigueCapacityShare, fatigueOn } from './StaffFatigue.js';

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
 * plan has a worker doing in it this hour (getStaffPlan -- the plan the
 * walking staff on screen follow). Daily cleans still pending when the shift
 * ends are skipped. Trained clerks can contribute real morning turnover work.
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
  const finisher = (id: string, kind: 'turnover' | 'daily') => {
    let last: { id: string; end: number } | undefined;
    for (const it of plan.itineraries) for (const leg of it.legs) {
      if (leg.kind === 'stay' && leg.placeId === id && leg.job === kind && (!last || leg.end > last.end)) last = { id: it.staffId, end: leg.end };
    }
    return last ? state.staffRoster?.find(m => m.id === last.id) : undefined;
  };
  const cleanRecord = (room: Room, kind: 'turnover' | 'daily') => {
    const member = finisher(room.id, kind);
    const report = member?.profile?.style === 'meticulous' && room.condition < 60 && !room.damageReportedBy;
    if (report) events.push({ type: 'staff_notice', message: `${member.name} reported damage in Room ${formatRoomLabel(room.gridX, room.gridY, room.floor)}; maintenance will attend when it is empty.`, data: { staffId: member.id, roomId: room.id } });
    return {
      delta: cleanlinessDelta(member),
      fields: member?.name ? { cleanedBy: { id: member.id, name: member.name, style: member.profile?.style ?? 'standard', day: state.day }, ...(report ? { damageReportedBy: member.name } : {}) } : {},
    };
  };
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
  const hospitality = new Map<string, { member: NonNullable<ReturnType<typeof finisher>>; at: number }>();

  const updatedRooms = state.rooms.map(room => {
    const turnover = turnoverWork.get(room.id);
    if (turnover !== undefined && room.status === 'cleaning') {
      const remaining = room.cleaningHoursRemaining - turnover;
      if (remaining <= 1e-9) {
        const by = cleanRecord(room, 'turnover');
        events.push({
          type: 'room_cleaned',
          message: `Room ${formatRoomLabel(room.gridX, room.gridY, room.floor)} cleaned (${quality})`,
          data: { roomId: room.id, quality },
        });
        return { ...room, ...by.fields, status: 'vacant' as const, cleanliness: Math.max(room.cleanliness, Math.min(100, targetCleanliness + by.delta)), cleaningHoursRemaining: 0, cleaningHoursTotal: undefined };
      }
      return { ...room, cleaningHoursRemaining: remaining };
    }

    if (room.dailyCleanHoursRemaining > 0 && room.status === 'occupied') {
      const remaining = room.dailyCleanHoursRemaining - (dailyWork.get(room.id) ?? 0);
      if (remaining <= 1e-9) {
        const by = cleanRecord(room, 'daily');
        const member = finisher(room.id, 'daily');
        const guest = state.guests.find(g => g.id === room.guestId);
        const at = Math.max(...plan.itineraries.flatMap(it => it.legs.flatMap(leg =>
          leg.kind === 'stay' && leg.job === 'daily' && leg.placeId === room.id ? [leg.end] : [])));
        const tile = guest && guestTileAt(state, guest, at);
        if (member && guest && housekeepingPrefOf(guest) !== 'dnd' && tile && sameTile(tile, room)) hospitality.set(guest.id, { member, at });
        dailyDone++;
        dailyCost += HOUSEKEEPING.dailyCleaningCost;
        if (prefs && room.guestId) tally.set(room.guestId, 'done');
        return {
          ...room, ...by.fields,
          cleanliness: Math.min(100, room.cleanliness + HOUSEKEEPING.dailyCleaningBoost + by.delta),
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
  const guestsAfter = tally.size === 0 && hospitality.size === 0 ? state.guests : state.guests.map(g => {
    const how = tally.get(g.id);
    const contact = hospitality.get(g.id);
    let guest = g;
    if (how) {
      const cleans = g.cleans ?? { done: 0, missed: 0 };
      guest = { ...g, cleans: { ...cleans, [how]: cleans[how] + 1 } };
    }
    return contact ? recordHospitality(guest, contact.member, 'daily_clean', contact.at) : guest;
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

/**
 * Average work transfer, calibrated from desks and supply closets. Recovery
 * rooms help breaks, but do not reset each trip between cleaning jobs.
 */
export function baseWalkHours(state: HotelState): number {
  const walks = state.rooms.map(r => getStaffTravelHours(state, r, !fatigueOn())).filter(Number.isFinite);
  return walks.length > 0 ? walks.reduce((a, b) => a + b, 0) / walks.length : 0;
}

/**
 * Housekeeper-hours a day of work needs at a given occupancy (0-1): turnovers
 * for the day's checkouts plus the daily-clean round, each with a walk there
 * (WALKS_PER_JOB average walks from a staff base).
 */
export function estimateHousekeepingHours(state: HotelState, occupancy: number): number {
  const avgWalk = baseWalkHours(state) * WALKS_PER_JOB;
  const occupied = state.rooms.length * occupancy;
  const crew = (state.staffRoster ?? []).filter(m => m.role === 'housekeeper' && !m.leaving);
  const rate = crew.length ? crew.reduce((sum, m) => sum + staffRate(m), 0) / crew.length : 1;
  let checkouts = occupied / AVERAGE_STAY_NIGHTS;
  // Event visitors stay through the event instead of turning over every two
  // nights. Count their known checkout rush (today or tomorrow) when planning
  // a busy day, rather than hiring a permanent turnover crew for empty work.
  const eventStays = state.guests.filter(g => g.eventStay);
  if (eventStays.length > 0) {
    const share = eventStays.length / state.guests.length;
    const dueSoon = eventStays.filter(g => g.checkInDay + g.stayLength <= state.day + 1).length / eventStays.length;
    checkouts = occupied * ((1 - share) / AVERAGE_STAY_NIGHTS + share * dueSoon);
  }
  const turnover = HOUSEKEEPING.turnoverDuration[state.housekeeping.turnoverQuality] ?? HOUSEKEEPING.turnoverDuration.standard;
  // Every other day: half the rooms a day, and (with preferences on) the make-up rooms on the off days too
  const makeupShare = GUEST_HOUSEKEEPING.enabled ? expectedShare('makeup') : 0;
  const cadence = state.housekeeping.dailyCadence === 'daily' ? 1 : state.housekeeping.dailyCadence === 'every_other_day' ? 0.5 + 0.5 * makeupShare : 0;
  const stayovers = occupied - checkouts; // guests leaving today get the turnover, not a daily clean (processDailyHousekeeping skips them)
  const dailyRound = stayovers * cadence * (1 / STAFF.housekeeping.dailyCleanRoomsPerHour / rate + avgWalk);
  return checkouts * (turnover / rate + avgWalk) + dailyRound;
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
  const crew = (state.staffRoster ?? []).filter(m => m.role === 'housekeeper' && !m.leaving);
  const available = crew.length ? crew.reduce((sum, m) => sum + attendanceShare(m), 0) / crew.length : 1;
  return Math.ceil(estimateHousekeepingHours(state, occupancy) / (housekeepingHoursAvailable(1) * available * fatigueCapacityShare(state)));
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
    if ((state.staffRoster ?? []).some(m => !m.leaving && m.shift === 'early' && cleaningTrained(m)))
      return 'No dedicated housekeepers. Trained clerks only help with morning turnovers; daily cleans still need housekeepers.';
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
  const crew = (state.staffRoster ?? []).filter(m => m.role === 'housekeeper' && !m.leaving).slice(0, housekeepers);
  const hoursAvailable = crew.reduce((hours, m) => {
    const a = attendance(m, state.day);
    return hours + (a.absent ? 0 : Math.max(0, STAFF.housekeeping.workEndHour - Math.max(HOUSEKEEPING.dailyCleaningHour, STAFF.housekeeping.workStartHour + a.lateHours)));
  }, housekeepingHoursAvailable(Math.max(0, housekeepers - crew.length))) * fatigueCapacityShare(state);

  let recommendation: string | null = null;
  if (housekeepers === 0 && state.rooms.length > 0) {
    recommendation = (state.staffRoster ?? []).some(m => !m.leaving && m.shift === 'early' && cleaningTrained(m))
      ? 'Hire housekeepers for daily cleans and reliable turnover coverage. Clerk help depends on spare morning reception coverage.'
      : 'Hire housekeepers or rooms will never be cleaned!';
  } else if (hoursNeeded > hoursAvailable * 1.05) {
    recommendation = `A busy day needs ${housekeepersNeeded(state, PLANNING_OCCUPANCY)} housekeepers.`;
  } else if (roomsWaiting > 0) {
    recommendation = `${roomsWaiting} rooms waiting to be cleaned.`;
  }

  return { housekeepers, roomsBeingCleaned, roomsWaiting, hoursNeeded, hoursAvailable, recommendation };
}

/** Occupancy the staffing advice plans for: a busy but not sold-out day. */
export const PLANNING_OCCUPANCY = 0.85;
