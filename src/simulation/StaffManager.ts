import type { HotelState, Room, StaffMember, StaffPlan, StaffItinerary, StaffRole, FrontDeskShift, Leg, WalkLeg, TilePos, ReceptionSupport } from './types.js';
import { STAFF, TRAVEL, GUEST_PROFILE, GUEST_HOUSEKEEPING } from '../config/balance.js';
import { findRoute, routeFromStreet, routeToStreet, getStaffBases, getAccessibleBreakRooms, isEntranceTile, stepHours, doorTile, isHallway } from './Layout.js';
import { isRoomReachable } from './HotelState.js';
import { isGuestAway } from './GuestMovement.js';
import { hourStart, makeWalk, makeStay, truncateLegs, sameTile, finalTile, positionAt, walkProgress, stepStillOpen, legsEnd } from './Movement.js';
import { guestsById } from './Party.js';
import { housekeepingPrefOf, dndOpening, dndCleanStart, dndSetOff, partyOutOfRoom } from './CleaningPreference.js';
import { isSleepHour } from './Profile.js';
import { STAFF_PERSONALITIES, STAFF_SPECIALTIES, STAFF_FATIGUE, STAFF_CROSS_TRAINING } from '../config/staff.js';
import { reconcileStaff, initializeFrontDesk } from './StaffHiring.js';
import { staffRate, attendance, afterWork, repairTarget, nextStaffWork, staffDutyAt, shiftFor, specialtyOf, hospitalityOf, receptionTrained, checkInHours } from './StaffProfiles.js';
import { planDeskClerk, scheduledDeskLanes, physicalDeskLanes } from './FrontDesk.js';
import { fatigueOn, fatigueAt, projectFatigue, planStaffRest, restReservations, fatigueGain } from './StaffFatigue.js';
import { receptionSupports } from './CrossTraining.js';

// Housekeepers and maintenance workers are people with a place in the
// building. Each hour boundary, every one of them gets an itinerary for the
// hour: walk to a job, work it, walk to the next, then rest in a break room --
// or commute in before their shift and out after it. Walks are timed from
// where they actually are, at TRAVEL pace, and the tick credits exactly the
// work in the plan (processCleaningTick / processMaintenanceTick). The
// renderer draws the same itineraries, so a room is only cleaned or repaired
// while someone is in it.

const ROLES: StaffRole[] = ['housekeeper', 'maintenance'];

function shiftOf(role: StaffRole) {
  return role === 'housekeeper' ? STAFF.housekeeping : STAFF.maintenance;
}

/** Whether a role works during an hour of the day. */
export function isOnShift(role: StaffRole, hour: number, frontShift?: FrontDeskShift): boolean {
  const shift = shiftFor(role, frontShift);
  return shift.workEndHour > 24 ? hour >= shift.workStartHour || hour < shift.workEndHour - 24 : hour >= shift.workStartHour && hour < shift.workEndHour;
}

function headcount(state: HotelState, role: StaffRole): number {
  return role === 'housekeeper' ? state.staff.housekeepers : state.staff.maintenanceWorkers;
}

/**
 * Where idle staff wait on a floor: a break room there (they sit inside), else
 * a staff base there (the lobby or a closet), else a break room or base on
 * any floor. Null if there's nowhere connected.
 */
export function restingPlace(state: HotelState, floor: number): { at: TilePos; breakRoomId?: string } | null {
  const breakRooms = getAccessibleBreakRooms(state);
  // With real seats, entry and pre-shift waiting use a base. Only the rest
  // planner may claim a seat inside a break room.
  const bases = getStaffBases(state).filter(b => !fatigueOn() || !breakRooms.some(r => sameTile(r, b)));
  if (fatigueOn()) {
    const base = bases.find(b => b.floor === floor) ?? bases[0];
    return base ? { at: base } : null;
  }
  const room = breakRooms.find(b => b.floor === floor);
  if (room) return { at: { gridX: room.gridX, gridY: room.gridY, floor: room.floor }, breakRoomId: room.id };
  const base = bases.find(b => b.floor === floor);
  if (base) return { at: base };
  if (breakRooms[0]) return { at: { gridX: breakRooms[0].gridX, gridY: breakRooms[0].gridY, floor: breakRooms[0].floor }, breakRoomId: breakRooms[0].id };
  return bases[0] ? { at: bases[0] } : null;
}

/**
 * The roster as it stands. A state without one yet (a new game, an older save,
 * a test that just sets headcounts) gets one member per head, already at their
 * resting place if they're on shift, off site if not.
 */
export function getRoster(state: HotelState): StaffMember[] {
  if (state.staffRoster) return state.staffRoster;
  const roster: StaffMember[] = [];
  for (const role of ROLES) {
    const rest = isOnShift(role, state.hour) ? restingPlace(state, 0)?.at ?? null : null;
    for (let i = 0; i < headcount(state, role); i++) roster.push({ id: `${role}-${i}`, role, at: rest });
  }
  return roster;
}

/**
 * At an hour boundary, match the roster to the headcounts the player set: new
 * hires join off site (they walk in from the street), and the newest extra
 * staff are let go (they walk out next hour). Anyone who's left is dropped.
 */
function syncLegacyRoster(state: HotelState): StaffMember[] {
  let roster = getRoster(state).filter(m => !(m.leaving && m.at === null && !m.carry));
  for (const role of ROLES) {
    const wanted = headcount(state, role);
    let staying = roster.filter(m => m.role === role && !m.leaving);
    // Rehire anyone on their way out first
    for (const m of roster.filter(m => m.role === role && m.leaving)) {
      if (staying.length >= wanted) break;
      roster = roster.map(r => (r === m ? { ...r, leaving: false } : r));
      staying = roster.filter(r => r.role === role && !r.leaving);
    }
    const used = new Set(roster.map(m => m.id));
    let n = 0;
    while (staying.length < wanted) {
      while (used.has(`${role}-${n}`)) n++;
      const hire: StaffMember = { id: `${role}-${n}`, role, at: null };
      used.add(hire.id);
      roster = [...roster, hire];
      staying = [...staying, hire];
    }
    const extra = new Set(staying.slice(wanted).map(m => m.id));
    if (extra.size > 0) roster = roster.map(m => (extra.has(m.id) ? { ...m, leaving: true, roomId: undefined } : m));
  }
  return roster;
}

export function syncStaff(state: HotelState, t = hourStart(state)): HotelState {
  if (!STAFF_PERSONALITIES.enabled) return { ...state, staffRoster: syncLegacyRoster(state) };
  const ready = initializeFrontDesk({ ...state, staffRoster: getRoster(state) });
  return reconcileStaff(ready, ready.staffRoster!, t);
}

export function syncRoster(state: HotelState): StaffMember[] {
  return syncStaff(state).staffRoster!;
}

interface Job {
  room: Room;
  kind: 'turnover' | 'daily' | 'repair';
  hours: number; // work it still needs (Infinity: as long as there's time)
  preventive?: boolean;
}

/**
 * Work waiting for each role, most urgent first. `done` is cleaning already
 * done earlier this hour (when re-planning mid-hour), which the rooms' hours
 * don't show until the tick.
 */
function jobQueues(state: HotelState, done: { turnover: Map<string, number>; daily: Map<string, number>; repair?: Map<string, number> } = { turnover: new Map(), daily: new Map() }): Record<StaffRole, Job[]> {
  const reachable = (r: Room) => isRoomReachable(state, r);
  const T = hourStart(state);
  const guestOut = (r: Room) => state.guests.some(g => g.id === r.guestId && isGuestAway(g, T));
  const left = (r: Room, kind: 'turnover' | 'daily') =>
    (kind === 'turnover' ? r.cleaningHoursRemaining : r.dailyCleanHoursRemaining) - (done[kind].get(r.id) ?? 0);
  const dailyRooms = state.rooms.filter(r => r.status === 'occupied' && left(r, 'daily') > 1e-9 && reachable(r) && !guestsAsleepIn(state, r));
  const housekeeping: Job[] = [
    // Turnovers first (they block bookings), soonest-finished first
    ...state.rooms.filter(r => r.status === 'cleaning' && left(r, 'turnover') > 1e-9 && reachable(r))
      .sort((a, b) => left(a, 'turnover') - left(b, 'turnover'))
      .map(room => ({ room, kind: 'turnover' as const, hours: left(room, 'turnover') })),
    // Then the daily cleans queued at HOUSEKEEPING.dailyCleaningHour (none
    // whose guests are asleep in them): rooms whose guest is out first
    // (nobody to disturb), then dirtiest first
    ...(GUEST_HOUSEKEEPING.enabled ? dailyByPreference(state, dailyRooms, r => left(r, 'daily')) : dailyRooms
      .sort((a, b) => Number(!guestOut(a)) - Number(!guestOut(b)) || a.cleanliness - b.cleanliness))
      .map(room => ({ room, kind: 'daily' as const, hours: left(room, 'daily') })),
  ];
  const continuingRepairs = new Map(getRoster(state).filter(m => m.role === 'maintenance' && m.roomId && !m.leaving)
    .map(m => [m.roomId!, repairTarget(m) ?? STAFF.maintenance.conditionThreshold]));
  const maintenance: Job[] = state.rooms
    .filter(r => r.status === 'vacant' && reachable(r) && (r.condition < STAFF.maintenance.conditionThreshold
      || r.condition < (continuingRepairs.get(r.id) ?? 0)))
    .sort((a, b) => Number(!!b.damageReportedBy) - Number(!!a.damageReportedBy) || a.condition - b.condition)
    .map(room => ({ room, kind: 'repair' as const, hours: Infinity }));
  return { housekeeper: housekeeping, maintenance, front_desk: [] };
}

/**
 * Whether a room's guests are in it and asleep this hour (with profiles on, by
 * their sleep hours): housekeepers don't wake anyone for a daily clean. Since
 * the round starts at 08:00, that's night owls till 09:00.
 */
export function guestsAsleepIn(state: HotelState, room: Room): boolean {
  if (!GUEST_PROFILE.enabled || !room.guestId) return false;
  const guest = state.guests.find(g => g.id === room.guestId);
  return !!guest && isSleepHour(guest, state.hour) && !isGuestAway(guest, hourStart(state));
}

/**
 * The daily cleans in order, with housekeeping preferences on: do-not-disturb
 * rooms whose guests are out (or going out) this hour first, the soonest back
 * first -- the chance passes; then the rooms whose guests want them made up
 * daily; then the rest. Among those, rooms whose guests are out halfway
 * through the hour first (about when a housekeeper gets there), then the
 * dirtiest. A do-not-disturb room with nobody going out this hour isn't on
 * the list.
 */
function dailyByPreference(state: HotelState, rooms: Room[], hours: (r: Room) => number): Room[] {
  const T = hourStart(state);
  const guests = guestsById(state);
  const ranked = rooms.map(room => {
    const guest = guests.get(room.guestId ?? '');
    const pref = housekeepingPrefOf(guest);
    const closes = pref === 'dnd' && guest ? dndOpening(guest, room, T, T + 1, hours(room) + TRAVEL.hoursPerTile) : null; // (stepping out; the planner checks exactly)
    const rank = pref === 'dnd' ? (closes === null ? -1 : 0) : pref === 'makeup' ? 1 : 2;
    const out = !!guest && isGuestAway(guest, T + 0.5);
    return { room, rank, closes: closes ?? Infinity, out };
  }).filter(r => r.rank >= 0);
  ranked.sort((a, b) => a.rank - b.rank || a.closes - b.closes || Number(!a.out) - Number(!b.out) || a.room.cleanliness - b.room.cleanliness);
  return ranked.map(r => r.room);
}

const roomTile = (room: Room): TilePos => ({ gridX: room.gridX, gridY: room.gridY, floor: room.floor, door: room.door });

/**
 * When the last of whoever is walking out of a room (a guest who checked
 * out, one moving rooms) has stepped out of it: the end of their first step
 * (the others in a party are ahead of the first). The start of the hour if
 * nobody is.
 */
function roomClearAt(state: HotelState, room: Room): number {
  const T = hourStart(state);
  let clear = T;
  const tile = roomTile(room);
  const movingRooms = STAFF_PERSONALITIES.enabled && STAFF_SPECIALTIES.enabled;
  for (const legs of [...state.guests.map(g => g.trip ?? []), ...(state.walkers ?? []).map(w => w.trip)]) {
    for (const leg of movingRooms ? legs : legs.slice(0, 1)) {
      if (leg.kind !== 'walk' || leg.path.length < 2 || !sameTile(leg.path[0], tile)) continue;
      const left = leg.start + stepHours(leg.path[0], leg.path[1], leg.hoursPerTile);
      // A preserved arrival history may precede a room move. Only a
      // departure crossing this hour matters, including a step begun before
      // its boundary; an old completed walk cannot hold the room up.
      if (movingRooms ? leg.start < T + 1 && left > T : leg.start >= T - 1e-9) clear = Math.max(clear, left);
    }
  }
  return clear;
}

/**
 * Plan every housekeeper's and maintenance worker's coming hour from the
 * state at its start. Each worker keeps at the room they were on (if it still
 * needs them), then takes the most urgent unclaimed job; one worker per room.
 * A walk that doesn't finish by the end of the hour carries over.
 */
export function planStaff(
  state: HotelState,
  roster: StaffMember[] = getRoster(state),
  from = hourStart(state),
  done?: { turnover: Map<string, number>; daily: Map<string, number>; repair?: Map<string, number> },
): StaffPlan {
  const T = hourStart(state);
  const end = T + 1;
  const pace = TRAVEL.hoursPerTile;
  const queues = jobQueues(state, done);
  const personalQueues = new Map(roster.map(m => {
    let queue = queues[m.role];
    const specialty = specialtyOf(m);
    if (specialty === 'room_attendant') {
      const out = (j: Job) => {
        const guest = state.guests.find(g => g.id === j.room.guestId);
        return !!guest && partyOutOfRoom(guest, j.room, T + 0.5, T + 0.5);
      };
      queue = [...queue.filter(j => j.kind === 'daily').sort((a, b) => Number(out(b)) - Number(out(a))), ...queue.filter(j => j.kind !== 'daily')];
    } else if (specialty === 'preventive') {
      const previous = state.staffPlan?.itineraries.find(it => it.staffId === m.id);
      const preventive = state.rooms.filter(room => room.status === 'occupied' && isRoomReachable(state, room)
        && (room.condition < STAFF_SPECIALTIES.preventiveBelow || room.id === m.roomId && room.condition < STAFF_SPECIALTIES.preventiveTarget
          && previous?.legs.some(l => l.kind === 'stay' && l.placeId === room.id && l.preventive))
        && housekeepingPrefOf(state.guests.find(g => g.id === room.guestId)) !== 'dnd')
        .sort((a, b) => a.condition - b.condition)
        .map(room => ({ room, kind: 'repair' as const, hours: Infinity, preventive: true }));
      // Vacant rooms retain priority; preventive work uses otherwise spare time.
      queue = [...queue, ...preventive];
    }
    return [m.id, queue] as const;
  }));
  const claimed = new Set<string>();
  const reservations = restReservations(state, roster, from);
  const deskState = roster === state.staffRoster ? state : { ...state, staffRoster: roster };
  const supporting = roster === state.staffRoster ? receptionSupports(state)
    : receptionSupports({ ...deskState, staffPlan: null });
  const commitments = new Map(supporting.map(({ member, support }) => [member.id, support]));
  // Whole intervals, rather than headcounts: an imminent clerk return also
  // owns its seat. Keep new reservations local until the complete plan exists.
  const supportLanes = roster.some(receptionTrained) ? scheduledDeskLanes(deskState) : [];
  // Plan reception first so the same six seats serve both counter and room staff.
  const deskPlans = new Map(roster.filter(m => m.role === 'front_desk').map(m => [m.id,
    planDeskClerk(deskState, m, from, reservations)]));

  // Each worker's own room comes first: reserve those before anyone picks
  const sticky = new Map<string, Job>();
  for (const m of roster) {
    if (!m.roomId || m.leaving || !isOnShift(m.role, state.hour) || nextStaffWork(m, from) >= end
      || fatigueOn() && (fatigueAt(state, m, from) >= STAFF_FATIGUE.breakAt || (m.fatigueBreak?.end ?? 0) > from)) continue;
    const job = personalQueues.get(m.id)!.find(j => j.room.id === m.roomId && !claimed.has(j.room.id));
    if (job) {
      sticky.set(m.id, job);
      claimed.add(job.room.id);
    }
  }

  const itineraries: StaffItinerary[] = roster.map(m => {
    if (m.role === 'front_desk') return deskPlans.get(m.id)!;
    let rate = staffRate(m);
    const worked = new Map<string, number>();
    const targetCondition = repairTarget(m);
    const goal = (j: Job) => j.preventive ? STAFF_SPECIALTIES.preventiveTarget : targetCondition;
    const needed = (j: Job) => j.kind === 'repair' && goal(j) !== null
      ? Math.max(0, (goal(j)! - j.room.condition) / STAFF.maintenance.repairPerHour - (done?.repair?.get(j.room.id) ?? 0) - (worked.get(j.room.id) ?? 0))
      : Math.max(0, j.hours - (worked.get(j.room.id) ?? 0));
    const a = attendance(m, state.day);
    const dutyFrom = (state.day - 1) * 24 + shiftOf(m.role).workStartHour + a.lateHours;
    const onDuty = !a.absent && isOnShift(m.role, state.hour) && dutyFrom < end;
    const legs: Leg[] = [];
    let t = from;
    let pos: TilePos | null = m.at;
    let roomId: string | undefined;
    let fatigueBreak = fatigueOn() ? m.fatigueBreak : undefined;
    let receptionSupport = commitments.get(m.id);
    const initialFatigue = fatigueAt(state, m, from);
    const energy = () => projectFatigue(m, legs, from, t, initialFatigue);
    const updateRate = () => { rate = staffRate({ ...m, stats: { ...m.stats!, fatigue: energy() } }); };

    // A walk under way at the boundary carries on
    if (m.carry && m.carry.end > from) {
      legs.push(m.carry);
      t = m.carry.end;
      pos = m.carry.path[m.carry.path.length - 1];
    }

    const walk = (route: { path: TilePos[] } | null): WalkLeg | null => {
      if (!route || route.path.length < 2) return null;
      const leg = makeWalk(route.path, t, pace);
      legs.push(leg);
      t = leg.end;
      pos = route.path[route.path.length - 1];
      return leg;
    };
    const result = (): StaffItinerary => {
      const last = [...legs].reverse().find(l => l.start < end);
      const carry = last && last.kind === 'walk' && last.end > end ? last : undefined;
      let at = pos;
      if (at && isEntranceTile(state, at) && (m.leaving || !onDuty) && !carry && t <= end) {
        const commutingIn = !m.leaving && !a.absent && a.lateHours === 0 && state.hour === shiftOf(m.role).workStartHour - 1;
        if (!commutingIn) at = null; // walked out the door
      }
      return { staffId: m.id, legs, end: { at, roomId, carry,
        ...(receptionSupport ? { deskLane: receptionSupport.lane, receptionSupport } : {}),
        ...(fatigueBreak && fatigueBreak.end > end ? { fatigueBreak } : {}) } };
    };

    // Let go, or off shift: head out (or, the hour before the shift, come in)
    if (m.leaving || !onDuty) {
      receptionSupport = undefined;
      const commuteHour = !m.leaving && !a.absent && a.lateHours === 0 && state.hour === shiftOf(m.role).workStartHour - 1;
      const rest = commuteHour ? restingPlace(state, 0) : null;
      if (pos && rest) {
        // Already on the way in (re-planned mid-commute): keep heading to the resting place
        if (!sameTile(pos, rest.at)) walk(findRoute(state, pos, rest.at, pace));
        if (t < end && sameTile(pos, rest.at)) legs.push(makeStay(rest.at, t, end, 'rest', { placeId: rest.breakRoomId }));
      } else if (pos) {
        if (!isEntranceTile(state, pos) || legs.length > 0) walk(routeToStreet(state, pos, pace));
      } else if (commuteHour) {
        // Arrive at the resting place right as the shift starts
        const route = rest ? routeFromStreet(state, rest.at, pace) : null;
        if (route) {
          t = Math.max(from, end - route.hours);
          walk(route);
        }
      }
      return result();
    }

    // On shift, just hired: come in off the street
    if (!pos) {
      const rest = restingPlace(state, 0);
      const route = rest ? routeFromStreet(state, rest.at, pace) : null;
      if (!route) return result();
      pos = route.path[0];
    }
    if (t < dutyFrom) {
      // A late employee remains off site until they actually arrive.
      if (m.at) legs.push(makeStay(pos!, t, dutyFrom, 'wait'));
      t = dutyFrom;
    }

    // A fixed break can include a walk from the previous hour. Never restart
    // its half hour at every boundary or after a paused edit.
    if (fatigueBreak && fatigueBreak.end > t) {
      const valid = fatigueBreak.placeId ? getAccessibleBreakRooms(state).some(r => r.id === fatigueBreak!.placeId && sameTile(r, fatigueBreak!.at))
        : isHallway(state, fatigueBreak.at.gridX, fatigueBreak.at.gridY, fatigueBreak.at.floor);
      const route = valid ? findRoute(state, pos!, fatigueBreak.at, pace) : null;
      if (!route) {
        const rest = planStaffRest(state, m, pos!, t, reservations, Math.max(0, fatigueBreak.end - Math.max(t, fatigueBreak.start)), fatigueBreak.end);
        legs.push(...rest.legs); t = rest.until; pos = rest.at; fatigueBreak = rest.reservation;
      } else if (!sameTile(pos!, fatigueBreak.at)) walk(route);
      if (sameTile(pos!, fatigueBreak.at) && t < fatigueBreak.end) {
        if (t < fatigueBreak.start) {
          legs.push(makeStay(pos!, t, fatigueBreak.start, 'wait'));
          t = fatigueBreak.start;
        }
        legs.push(makeStay(pos!, t, fatigueBreak.end, 'rest', { restRate: fatigueBreak.placeId ? STAFF_FATIGUE.roomRecovery : STAFF_FATIGUE.fallbackRecovery, placeId: fatigueBreak.placeId }));
        t = fatigueBreak.end;
      }
    }
    if (t >= end - 1e-9) { roomId = sticky.get(m.id)?.room.id; return result(); }
    fatigueBreak = undefined;

    const coverReception = (support: ReceptionSupport): boolean => {
      const lane = physicalDeskLanes(state).find(l => l.key === support.lane);
      const route = lane && pos ? findRoute(state, pos, lane.front, pace) : null;
      if (!lane || !route) return false;
      const arrival = t + route.hours;
      if (arrival >= support.to - 1e-9) return false;
      if (route.path.length > 1) walk(route);
      const start = Math.max(t, support.from);
      if (start > t) { legs.push(makeStay(pos!, t, start, 'wait')); t = start; }
      const gain = fatigueGain(m);
      const tiredFrom = !fatigueOn() ? undefined : energy() >= STAFF_FATIGUE.tiredAt - 1e-8 ? t
        : t + (STAFF_FATIGUE.tiredAt - energy()) / gain;
      // A started encounter keeps its quote through a paused replan. New
      // service starts use the newly projected tired threshold.
      let to = Math.min(support.to, staffDutyAt(m, t).end);
      const busyUntil = state.guests.flatMap(g => g.trip ?? []).reduce((last, l) => l.kind === 'stay'
        && (l.activity === 'check_in' || l.activity === 'complain')
        && l.serviceStaffId === m.id && l.start < from && l.end > from ? Math.max(last, l.end) : last, to);
      to = Math.max(to, busyUntil);
      receptionSupport = { ...support, from: Math.max(support.from, arrival), to,
        ...(tiredFrom !== undefined && tiredFrom < to ? { tiredFrom } : { tiredFrom: undefined }) };
      if (tiredFrom !== undefined && tiredFrom > t + 1e-9 && tiredFrom < to - 1e-9) {
        legs.push(makeStay(pos!, t, tiredFrom, 'desk', { lane: lane.key, placeId: lane.desk.id, workRate: 1 }));
        t = tiredFrom;
      }
      if (t < to) legs.push(makeStay(pos!, t, to, 'desk', { lane: lane.key, placeId: lane.desk.id,
        workRate: tiredFrom !== undefined && tiredFrom <= t + 1e-9 ? STAFF_FATIGUE.tiredRate : 1 }));
      t = to;
      commitments.set(m.id, receptionSupport);
      roomId = undefined;
      return true;
    };
    // A promise already made to arriving guests lasts to its short deadline;
    // new cleaning work is picked up immediately afterwards.
    if (receptionSupport && receptionSupport.to > t && coverReception(receptionSupport)) {
      if (t >= end - 1e-9) return result();
    }
    receptionSupport = undefined;
    commitments.delete(m.id);

    // Work through jobs until the hour is up. A job is only taken once there's
    // a way to it from here, so a worker who's cut off doesn't hog the queue.
    const queue = personalQueues.get(m.id)!;
    const unreachable = new Set<string>();
    // Do-not-disturb rooms turned down at a moment (their guests not out yet, or back too soon): tried again once time moves on
    const notNow = new Map<string, number>();
    const turnDown = (id: string) => {
      notNow.set(id, t);
      claimed.delete(id);
    };
    const dndGuestOf = (j: Job) => (j.kind === 'daily' && GUEST_HOUSEKEEPING.enabled ? state.guests.find(g => g.id === j.room.guestId) : undefined);
    const isDnd = (j: Job) => j.kind === 'daily' && GUEST_HOUSEKEEPING.enabled && housekeepingPrefOf(dndGuestOf(j)) === 'dnd';
    /** The way to a room: up to the hallway tile at its door, and the step in (none when already there). A do-not-disturb clean also allows for the step back out (out: the room to themselves till then). */
    const approachTo = (from: TilePos, j: Job) => {
      const target = roomTile(j.room);
      if (sameTile(from, target)) return { route: null, approach: 0, step: 0 };
      const route = findRoute(state, from, target, pace);
      if (!route) return null;
      const step = stepHours(route.path[route.path.length - 2], target, pace);
      return { route, approach: route.hours - step, step };
    };
    /**
     * The soonest do-not-disturb room whose party goes out (for long enough)
     * later this hour: when to set off to be at its door as they go. From the
     * resting place if there's time to get there and wait, else from here.
     */
    const nextDndSetOff = (): { at: number; home: boolean; rest?: { path: TilePos[] }; restPlaceId?: string } | null => {
      if (!pos || !GUEST_HOUSEKEEPING.enabled) return null;
      const home = restingPlace(state, pos.floor);
      const toRest = home && !sameTile(pos, home.at) ? findRoute(state, pos, home.at, pace) : null;
      let best: { at: number; home: boolean; rest?: { path: TilePos[] }; restPlaceId?: string } | null = null;
      // In a room (one just cleaned): never wait in it -- step out into the hallway first
      const inRoom = state.rooms.find(r => sameTile(r, pos));
      const outside = inRoom ? { ...doorTile(inRoom, inRoom.door) } : null;
      const stepOut = outside ? { path: [pos, outside] } : null;
      const waitAt = outside ?? pos;
      const waitFrom = t + (stepOut ? stepHours(pos, outside!, pace) : 0);
      for (const j of queue) {
        if (claimed.has(j.room.id) || unreachable.has(j.room.id) || !isDnd(j)) continue;
        const guest = dndGuestOf(j)!;
        const here = approachTo(waitAt, j);
        if (!here) continue;
        const fromHere = dndSetOff(guest, j.room, waitFrom, here.approach, needed(j) / rate + here.step + pace, end);
        if (fromHere === null) continue;
        let option: { at: number; home: boolean; rest?: { path: TilePos[] }; restPlaceId?: string } = { at: fromHere, home: false, ...(stepOut ? { rest: stepOut } : {}) };
        if (home && (toRest || sameTile(pos, home.at))) {
          const fromHome = approachTo(home.at, j);
          const arrive = t + (toRest ? toRest.hours : 0);
          const setOff = fromHome ? dndSetOff(guest, j.room, arrive, fromHome.approach, needed(j) / rate + fromHome.step + pace, end) : null;
          if (setOff !== null) option = { at: setOff, home: true, ...(toRest ? { rest: toRest } : {}), ...(home.breakRoomId ? { restPlaceId: home.breakRoomId } : {}) };
        }
        if (!best || option.at < best.at) best = option;
      }
      return best;
    };
    let job: Job | undefined = sticky.get(m.id);
    // Still walking to it all hour (a long way up): it stays theirs into the next hour
    if (job && t >= end - 1e-9) roomId = job.room.id;
    while (t < end - 1e-9) {
      if (fatigueOn() && energy() >= STAFF_FATIGUE.breakAt
        && !(job && worked.has(job.room.id) && (job.preventive || isDnd(job)))) {
        const resume = job && worked.has(job.room.id) ? job : undefined;
        if (job && !worked.has(job.room.id)) claimed.delete(job.room.id);
        job = undefined;
        const rest = planStaffRest(state, m, pos!, t, reservations);
        legs.push(...rest.legs); t = rest.until; pos = rest.at; fatigueBreak = rest.reservation;
        if (t >= end - 1e-9) break;
        fatigueBreak = undefined;
        job = resume;
      }
      updateRate();
      if (!job) {
        job = queue.find(j => !claimed.has(j.room.id) && !unreachable.has(j.room.id) && notNow.get(j.room.id) !== t);
        if (!job) {
          // Nothing to do now, but a do-not-disturb party going out later this hour: be at their door as they go
          const later = nextDndSetOff();
          if (later === null) break;
          // (resting, if they can get to the resting place in time; else waiting where they are)
          if (later.rest) walk(later.rest);
          legs.push(later.home ? makeStay(pos!, t, later.at, 'rest', { ...(later.restPlaceId ? { placeId: later.restPlaceId } : {}), ...(fatigueOn() ? { restRate: STAFF_FATIGUE.fallbackRecovery } : {}) }) : makeStay(pos!, t, later.at, 'wait'));
          t = later.at;
          continue;
        }
      }
      if (needed(job) <= 1e-9) {
        unreachable.add(job.room.id); claimed.delete(job.room.id); job = undefined; continue;
      }
      const target = roomTile(job.room);
      const way = approachTo(pos!, job);
      if (!way) {
        unreachable.add(job.room.id);
        claimed.delete(job.room.id); // let someone who can get there have it
        job = undefined;
        continue;
      }
      if (job.preventive) {
        const guest = state.guests.find(g => g.id === job!.room.guestId);
        const exit = stepHours(target, doorTile(job.room, job.room.door), pace);
        const reachesTired = energy() < STAFF_FATIGUE.tiredAt && energy() + STAFF_FATIGUE.gain[m.profile?.stamina ?? 'normal'] * (way.approach + way.step + needed(job) / rate) >= STAFF_FATIGUE.tiredAt;
        const safeRate = fatigueOn() && reachesTired ? rate * STAFF_FATIGUE.tiredRate : rate;
        const work = needed(job) / safeRate;
        const arrive = t + way.approach;
        const enter = guest ? dndCleanStart(guest, job.room, arrive, way.step + work + exit) : null;
        const shiftEnd = (state.day - 1) * 24 + shiftOf(m.role).workEndHour;
        if (enter === null || enter + way.step + work + exit > shiftEnd + 1e-9) {
          turnDown(job.room.id);
          job = undefined;
          continue;
        }
        claimed.add(job.room.id);
        if (way.route) walk({ path: way.route.path.slice(0, -1) });
        if (t >= end - 1e-9) { roomId = job.room.id; break; }
        if (enter > t + 1e-9) {
          legs.push(makeStay(pos!, t, Math.min(enter, end), 'wait'));
          t = Math.min(enter, end);
          if (t >= end - 1e-9) { roomId = job.room.id; break; }
        }
        if (way.route) {
          walk({ path: [pos!, target] });
          if (t >= end - 1e-9) { roomId = job.room.id; break; }
        }
      } else
      if (isDnd(job)) {
        // Do not disturb: wait outside the door, step in only once the whole party is out,
        // and only if they'll stay out till it's done
        const guest = dndGuestOf(job)!;
        const reachesTired = energy() < STAFF_FATIGUE.tiredAt && energy() + STAFF_FATIGUE.gain[m.profile?.stamina ?? 'normal'] * (way.approach + way.step + needed(job) / rate) >= STAFF_FATIGUE.tiredAt;
        const safeRate = fatigueOn() && reachesTired ? rate * STAFF_FATIGUE.tiredRate : rate;
        if (!guest || dndCleanStart(guest, job.room, t + way.approach, needed(job) / safeRate + way.step + pace) === null) {
          turnDown(job.room.id);
          job = undefined;
          continue;
        }
        claimed.add(job.room.id);
        if (way.route) walk({ path: way.route.path.slice(0, -1) });
        if (t >= end - 1e-9) {
          roomId = job.room.id; // still on the way: keep at it next hour
          break;
        }
        // (timed from when they're actually at the door)
        const enter = dndCleanStart(guest, job.room, t, needed(job) / safeRate + way.step + pace);
        if (enter === null) {
          turnDown(job.room.id);
          job = undefined;
          continue;
        }
        if (enter > t + 1e-9) {
          const until = Math.min(enter, end);
          legs.push(makeStay(pos!, t, until, 'wait'));
          t = until;
          if (t >= end - 1e-9) {
            roomId = job.room.id;
            break;
          }
        }
        if (way.route) {
          walk({ path: [pos!, target] });
          if (t >= end - 1e-9) {
            roomId = job.room.id;
            break;
          }
        }
      } else {
        const clear = job.kind !== 'daily' && GUEST_PROFILE.enabled ? roomClearAt(state, job.room) : T;
        if (way.route && STAFF_PERSONALITIES.enabled && STAFF_SPECIALTIES.enabled && clear > t + way.approach + 1e-9) {
          claimed.add(job.room.id);
          // Wait in the hall, before the step into the room: a party's last
          // member must have left even when its move follows older trip legs.
          walk({ path: way.route.path.slice(0, -1) });
          if (t >= end - 1e-9) { roomId = job.room.id; break; }
          if (clear > t) {
            legs.push(makeStay(pos!, t, Math.min(clear, end), 'wait'));
            t = Math.min(clear, end);
            if (t >= end - 1e-9) { roomId = job.room.id; break; }
          }
          walk({ path: [pos!, target] });
          if (t >= end) { roomId = job.room.id; break; }
        } else if (way.route) {
          claimed.add(job.room.id);
          walk(way.route);
          if (t >= end) {
            roomId = job.room.id; // still on the way: keep at it next hour
            break;
          }
        }
        claimed.add(job.room.id);
        // Whoever's leaving the room (checked out, moved) gets out of the way first
        if (job.kind !== 'daily' && GUEST_PROFILE.enabled) {
          const clear = roomClearAt(state, job.room);
          if (clear > t + 1e-9) {
            const until = Math.min(clear, end);
            legs.push(makeStay(target, t, until, 'wait'));
            t = until;
            if (t >= end - 1e-9) {
              roomId = job.room.id;
              break;
            }
          }
        }
      }
      if (fatigueOn() && energy() >= STAFF_FATIGUE.breakAt && !job.preventive && !isDnd(job)) continue;
      updateRate(); // travel can cross the tired threshold; this leg keeps its chosen rate
      const required = needed(job);
      const nextThreshold = energy() < STAFF_FATIGUE.tiredAt - 1e-8 ? STAFF_FATIGUE.tiredAt : STAFF_FATIGUE.breakAt;
      // A protected occupied-room visit must finish and exit in its agreed
      // away window. Ordinary jobs may pause safely at an energy threshold.
      const toThreshold = fatigueOn() && (nextThreshold === STAFF_FATIGUE.tiredAt || !job.preventive && !isDnd(job))
        ? Math.max(1e-8, (nextThreshold - energy()) / STAFF_FATIGUE.gain[m.profile?.stamina ?? 'normal']) : Infinity;
      const work = Math.min(required / rate, end - t, toThreshold);
      legs.push(makeStay(target, t, t + work, job.kind === 'repair' ? 'repair' : 'clean', { placeId: job.room.id, job: job.kind, ...(rate !== 1 ? { workRate: rate } : {}),
        ...(job.kind === 'repair' && STAFF_SPECIALTIES.enabled ? { repairTarget: goal(job) ?? 100, ...(job.preventive ? { preventive: true } : {}) } : {}) }));
      t += work;
      worked.set(job.room.id, (worked.get(job.room.id) ?? 0) + work * rate);
      if (work >= toThreshold - 1e-9 && required - work * rate > 1e-9 && t < end - 1e-9) continue;
      if (job.preventive && required - work * rate <= 1e-9) {
        // Finishing at the hour boundary still schedules the step out: the
        // guest's return must never find a worker left resting in their room.
        walk({ path: [target, doorTile(job.room, job.room.door)] });
        job = undefined;
        continue;
      }
      if ((job.kind === 'repair' && targetCondition === null) || t >= end - 1e-9) {
        roomId = job.room.id;
        if (required - work * rate <= 1e-9) roomId = undefined;
        break;
      }
      job = undefined;
    }

    // Home work has priority. Only spare afternoon time may be committed to
    // reception, and travel/energy/shift limits must leave a useful block.
    if (t < end - 1e-9 && pos && receptionTrained(m) && t % 24 >= STAFF_CROSS_TRAINING.startHour
      && (m.restUntil ?? -Infinity) <= t && (!fatigueOn() || energy() < STAFF_FATIGUE.breakAt)) {
      const duty = staffDutyAt(m, t);
      const options = supportLanes.flatMap(lane => {
        const route = findRoute(state, pos!, lane.front, pace);
        if (!route) return [];
        const arrival = t + route.hours;
        const fatigue = projectFatigue(m, route.path.length > 1 ? [makeWalk(route.path, t, pace)] : [], t, arrival, energy());
        const busy = [...(lane.duties ?? []).filter(d => d.staffId !== m.id).map(d => ({ from: d.from, to: d.to })),
          ...[...commitments].filter(([id, s]) => id !== m.id && s.lane === lane.key).map(([, s]) => s)];
        if (busy.some(b => b.from <= arrival + 1e-9 && b.to > arrival + 1e-9)) return [];
        const next = Math.min(Infinity, ...busy.filter(b => b.from > arrival).map(b => b.from));
        const toBreak = fatigueOn() ? (STAFF_FATIGUE.breakAt - fatigue) / fatigueGain(m) : Infinity;
        const to = Math.min(arrival + STAFF_CROSS_TRAINING.supportHours, duty.end, next, arrival + toBreak);
        const service = checkInHours(m) / (fatigueOn() && fatigue >= STAFF_FATIGUE.tiredAt ? STAFF_FATIGUE.tiredRate : 1);
        if (to - arrival < Math.max(STAFF_CROSS_TRAINING.minSupportHours, service) - 1e-9) return [];
        return [{ lane, from: arrival, to }];
      }).sort((a, b) => a.from - b.from || a.lane.key.localeCompare(b.lane.key));
      if (options[0]) coverReception({ lane: options[0].lane.key, from: options[0].from, to: options[0].to });
    }

    // Done for now: rest -- in the break room if they can get there, else where they are
    if (t < end - 1e-9 && pos) {
      if (fatigueOn()) {
        // Idle recovery can be interrupted by work arriving next hour; only
        // a compulsory break retains a fixed end beyond this plan.
        const rest = planStaffRest(state, { ...m, stats: { ...m.stats!, fatigue: energy(), fatigueAt: t } }, pos, t, reservations, end - t, end, true);
        legs.push(...rest.legs); t = rest.until; pos = rest.at;
      } else {
        const rest = restingPlace(state, pos.floor);
        if (rest && !sameTile(pos, rest.at)) walk(findRoute(state, pos, rest.at, pace));
        if (t < end) {
          const there = !!rest && sameTile(pos, rest.at);
          legs.push(makeStay(pos, t, end, 'rest', there ? { placeId: rest!.breakRoomId } : {}));
        }
      }
    }
    return result();
  });

  return { start: T, itineraries };
}

/** This hour's staff plan: the one made at the hour boundary, or (for a state without one) planned now. */
export function getStaffPlan(state: HotelState): StaffPlan {
  if (state.staffPlan && state.staffPlan.start === hourStart(state)) {
    const ids = new Set(state.staffPlan.itineraries.map(it => it.staffId));
    const missing = (state.staffRoster ?? []).filter(m => m.role === 'front_desk' && !ids.has(m.id));
    if (missing.length) return { ...state.staffPlan, itineraries: [...state.staffPlan.itineraries, ...missing.map(m => planDeskClerk(state, m, hourStart(state)))] };
    return state.staffPlan;
  }
  return planStaff(state);
}

/** Commit the next hour's available helpers before admission quotes the line.
 * Tick still holds the old clock here; only promote counter promises, never
 * virtual work, travel, fatigue, or experience from this planning pass. */
export function prepareReceptionSupport(state: HotelState, t: number): HotelState {
  if (t % 24 < STAFF_CROSS_TRAINING.startHour || t % 24 >= STAFF.housekeeping.workEndHour
    || !(state.staffRoster ?? []).some(receptionTrained)) return state;
  const virtual = { ...state, day: Math.floor(t / 24) + 1, hour: t % 24, staffPlan: null };
  const plan = planStaff(virtual);
  const supports = new Map<string, ReceptionSupport>();
  for (const { member, support } of receptionSupports({ ...virtual, staffPlan: plan })) {
    const it = plan.itineraries.find(it => it.staffId === member.id)!;
    // A virtual clean is not completed work. Only already-free employees
    // can make an admission promise before the real next-hour plan runs.
    if (!supports.has(member.id) && support.to > t && !it.legs.some(l => l.kind === 'stay' && l.job && l.start < support.from)) supports.set(member.id, support);
  }
  const staffRoster = state.staffRoster!.map(m => ({ ...m, receptionSupport: supports.get(m.id) }));
  const staffPlan = state.staffPlan ? { ...state.staffPlan, itineraries: state.staffPlan.itineraries.map(it => ({ ...it,
    end: { ...it.end, receptionSupport: supports.get(it.staffId) } })) } : state.staffPlan;
  return { ...state, staffRoster, staffPlan };
}

/** Hours of each kind of work the plan does in each room. */
export function plannedWork(plan: StaffPlan, kind: 'turnover' | 'daily' | 'repair'): Map<string, number> {
  const work = new Map<string, number>();
  for (const it of plan.itineraries) {
    for (const leg of it.legs) {
      if (leg.kind !== 'stay' || leg.job !== kind || !leg.placeId) continue;
      const hours = Math.min(leg.end, plan.start + 1) - Math.max(leg.start, plan.start);
      if (hours > 0) work.set(leg.placeId, (work.get(leg.placeId) ?? 0) + hours * (leg.workRate ?? 1));
    }
  }
  return work;
}

/** The roster as the plan leaves it at the end of the hour. */
export function rosterAfter(state: HotelState, plan: StaffPlan): StaffMember[] {
  const ends = new Map(plan.itineraries.map(it => [it.staffId, it.end]));
  const roster = getRoster(state);
  const members = new Map(roster.map(m => [m.id, m]));
  const serviceHours = new Map<string, number>();
  for (const guest of state.guests) for (const leg of guest.trip ?? []) {
    if (leg.kind !== 'stay' || !leg.serviceStaffId || (leg.activity !== 'check_in' && leg.activity !== 'complain')) continue;
    const to = Math.min(leg.end, plan.start + 1, members.get(leg.serviceStaffId)?.dismissedAt ?? Infinity);
    const hours = Math.max(0, to - Math.max(leg.start, plan.start));
    if (hours > 0) serviceHours.set(leg.serviceStaffId, (serviceHours.get(leg.serviceStaffId) ?? 0) + hours);
  }
  return roster.map(m => {
    const e = ends.get(m.id);
    const workHours = (serviceHours.get(m.id) ?? 0) + (m.role === 'front_desk' ? 0 : (plan.itineraries.find(it => it.staffId === m.id)?.legs ?? [])
      .reduce((hours, leg) => hours + (leg.kind === 'stay' && leg.job ? Math.max(0, Math.min(leg.end, plan.start + 1) - Math.max(leg.start, plan.start)) : 0), 0));
    const duty = m.role === 'front_desk' ? staffDutyAt(m, plan.start) : undefined;
    const recordAttendance = !duty || (m.hiredAt ?? -Infinity) < duty.end && (m.dismissedAt ?? Infinity) > duty.start;
    const after = afterWork(e ? { ...m, at: e.at, roomId: e.roomId, carry: e.carry, deskLane: e.deskLane, fatigueBreak: e.fatigueBreak,
      receptionSupport: e.receptionSupport && e.receptionSupport.to > plan.start + 1 ? e.receptionSupport : undefined } : m, workHours, duty?.day ?? state.day, recordAttendance);
    return fatigueOn() && after.stats ? { ...after, stats: { ...after.stats,
      fatigue: fatigueAt({ ...state, staffPlan: plan }, m, plan.start + 1), fatigueAt: plan.start + 1 } } : after;
  });
}

/**
 * Re-plan the rest of the hour from time t after the player changes the
 * building (a room built across someone's path, a room demolished while it's
 * being cleaned) or the work (a room renovated mid-repair): everyone keeps
 * what they've done so far -- finishing the step they're on, if it's still
 * clear -- and carries on from there. Cleaning already done this hour counts,
 * so nobody re-cleans a room. The tick credits the merged plan.
 */
export function replanStaff(state: HotelState, t: number): HotelState {
  const plan = getStaffPlan(state);
  const done = new Map<string, Leg[]>();
  const now = getRoster(state).map(m => {
    // These are planning-only snapshots. The returned state retains its
    // boundary stats and the merged plan commits fatigue exactly once.
    if (fatigueOn() && m.stats) m = { ...m, stats: { ...m.stats, fatigue: fatigueAt(state, m, t), fatigueAt: t } };
    const it = plan.itineraries.find(i => i.staffId === m.id);
    if (it) m = { ...m, receptionSupport: it.end.receptionSupport };
    if (!it || it.legs.length === 0 || it.legs[0].start >= t) return m;
    const current = positionAt(it.legs, t)?.leg;
    const resting = current?.kind === 'stay' && current.activity === 'rest' ? current
      : current?.kind === 'walk' ? it.legs.slice(it.legs.indexOf(current) + 1).find(l => l.kind === 'stay') : undefined;
    if (fatigueOn() && resting?.kind === 'stay' && resting.activity === 'rest' && resting.restRate !== undefined && resting.end > t) {
      m = { ...m, fatigueBreak: { at: resting.at, placeId: resting.placeId, start: resting.start, end: resting.end } };
    } else if (fatigueOn() && current?.kind === 'walk' && it.end.fatigueBreak) {
      m = { ...m, fatigueBreak: it.end.fatigueBreak };
    }
    const next = it.legs.find(l => l.kind === 'stay' && l.end > t && l.job);
    const roomId = (current?.kind === 'stay' && current.job ? current.placeId : undefined)
      ?? (next?.kind === 'stay' ? next.placeId : undefined);
    // Mid-step on a walk: finish the step if the tile ahead is still there to step onto
    if (current?.kind === 'walk' && t < current.end) {
      const { index } = walkProgress(current, t);
      const kept = legsBefore(it.legs, current);
      const a = current.path[index];
      const b = current.path[index + 1];
      if (b && stepStillOpen(state, a, b)) {
        const walked = makeWalk(current.path.slice(0, index + 1), current.start, current.hoursPerTile);
        const step = makeWalk([a, b], walked.end, current.hoursPerTile);
        done.set(m.id, walked.path.length > 1 ? [...kept, walked] : kept);
        return { ...m, at: b, carry: step, roomId };
      }
    }
    const cut = truncateLegs(it.legs, t);
    // Stood where they'd got to since: say so, so the hour has no holes
    const reached = cut.legs.length > 0 ? legsEnd(cut.legs) : it.legs[0].start;
    done.set(m.id, cut.at && t > reached + 1e-12 ? [...cut.legs, makeStay(cut.at, reached, t, 'wait')] : cut.legs);
    return { ...m, at: cut.at ?? finalTile(it.legs), carry: undefined, roomId };
  });
  const sofar: StaffPlan = { start: plan.start, itineraries: [...done].map(([staffId, legs]) => ({ staffId, legs, end: { at: null } })) };
  const fresh = planStaff(state, now, t, { turnover: plannedWork(sofar, 'turnover'), daily: plannedWork(sofar, 'daily'), repair: plannedWork(sofar, 'repair') });
  const itineraries = fresh.itineraries.map(it => ({ ...it, legs: [...(done.get(it.staffId) ?? []), ...it.legs] }));
  return { ...state, staffPlan: { start: plan.start, itineraries } };
}

/** The legs before a given one. */
function legsBefore(legs: Leg[], leg: Leg): Leg[] {
  return legs.slice(0, legs.indexOf(leg));
}

/** What there is for staff to do: which rooms need cleaning or repair. When it changes mid-hour, re-plan (replanStaff). */
export function staffWorkKey(state: HotelState): string {
  const people = STAFF_PERSONALITIES.enabled ? (state.staffRoster ?? []).map(m => `${m.id}:${!!m.leaving}:${staffRate(m)}:${m.shift}:${m.restUntil}:${specialtyOf(m)}:${hospitalityOf(m)}:${receptionTrained(m)}:${JSON.stringify(m.receptionSupport)}`).join(',') : '';
  return state.rooms.map(r => `${r.id}:${r.status}:${r.condition < STAFF.maintenance.conditionThreshold ? 1 : 0}`).join(',') + people;
}
