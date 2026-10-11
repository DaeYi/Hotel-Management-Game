import type { HotelState, Room, StaffMember, StaffPlan, StaffItinerary, StaffRole, Leg, WalkLeg, TilePos } from './types.js';
import { STAFF, TRAVEL } from '../config/balance.js';
import { findRoute, routeFromStreet, routeToStreet, getStaffBases, getAccessibleBreakRooms, isEntranceTile } from './Layout.js';
import { isRoomReachable } from './HotelState.js';
import { hourStart, makeWalk, makeStay, truncateLegs, sameTile, finalTile, positionAt, walkProgress, stepStillOpen } from './Movement.js';

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
export function isOnShift(role: StaffRole, hour: number): boolean {
  const shift = shiftOf(role);
  return hour >= shift.workStartHour && hour < shift.workEndHour;
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
  const bases = getStaffBases(state);
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
export function syncRoster(state: HotelState): StaffMember[] {
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

interface Job {
  room: Room;
  kind: 'turnover' | 'daily' | 'repair';
  hours: number; // work it still needs (Infinity: as long as there's time)
}

/**
 * Work waiting for each role, most urgent first. `done` is cleaning already
 * done earlier this hour (when re-planning mid-hour), which the rooms' hours
 * don't show until the tick.
 */
function jobQueues(state: HotelState, done: { turnover: Map<string, number>; daily: Map<string, number> } = { turnover: new Map(), daily: new Map() }): Record<StaffRole, Job[]> {
  const reachable = (r: Room) => isRoomReachable(state, r);
  const left = (r: Room, kind: 'turnover' | 'daily') =>
    (kind === 'turnover' ? r.cleaningHoursRemaining : r.dailyCleanHoursRemaining) - (done[kind].get(r.id) ?? 0);
  const housekeeping: Job[] = [
    // Turnovers first (they block bookings), soonest-finished first
    ...state.rooms.filter(r => r.status === 'cleaning' && left(r, 'turnover') > 1e-9 && reachable(r))
      .sort((a, b) => left(a, 'turnover') - left(b, 'turnover'))
      .map(room => ({ room, kind: 'turnover' as const, hours: left(room, 'turnover') })),
    // Then the daily cleans queued at HOUSEKEEPING.dailyCleaningHour, dirtiest first
    ...state.rooms.filter(r => r.status === 'occupied' && left(r, 'daily') > 1e-9 && reachable(r))
      .sort((a, b) => a.cleanliness - b.cleanliness)
      .map(room => ({ room, kind: 'daily' as const, hours: left(room, 'daily') })),
  ];
  const maintenance: Job[] = state.rooms
    .filter(r => r.status === 'vacant' && r.condition < STAFF.maintenance.conditionThreshold && reachable(r))
    .sort((a, b) => a.condition - b.condition) // worst condition first
    .map(room => ({ room, kind: 'repair' as const, hours: Infinity }));
  return { housekeeper: housekeeping, maintenance };
}

const roomTile = (room: Room): TilePos => ({ gridX: room.gridX, gridY: room.gridY, floor: room.floor, door: room.door });

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
  done?: { turnover: Map<string, number>; daily: Map<string, number> },
): StaffPlan {
  const T = hourStart(state);
  const end = T + 1;
  const pace = TRAVEL.hoursPerTile;
  const queues = jobQueues(state, done);
  const claimed = new Set<string>();

  // Each worker's own room comes first: reserve those before anyone picks
  const sticky = new Map<string, Job>();
  for (const m of roster) {
    if (!m.roomId || m.leaving || !isOnShift(m.role, state.hour)) continue;
    const job = queues[m.role].find(j => j.room.id === m.roomId && !claimed.has(j.room.id));
    if (job) {
      sticky.set(m.id, job);
      claimed.add(job.room.id);
    }
  }

  const itineraries: StaffItinerary[] = roster.map(m => {
    const legs: Leg[] = [];
    let t = from;
    let pos: TilePos | null = m.at;
    let roomId: string | undefined;

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
      const last = legs[legs.length - 1];
      const carry = last && last.kind === 'walk' && last.end > end ? last : undefined;
      let at = pos;
      if (at && isEntranceTile(state, at) && (m.leaving || !isOnShift(m.role, state.hour)) && !carry && t <= end) {
        const commutingIn = !m.leaving && state.hour === shiftOf(m.role).workStartHour - 1;
        if (!commutingIn) at = null; // walked out the door
      }
      return { staffId: m.id, legs, end: { at, roomId, carry } };
    };

    // Let go, or off shift: head out (or, the hour before the shift, come in)
    if (m.leaving || !isOnShift(m.role, state.hour)) {
      const commuteHour = !m.leaving && state.hour === shiftOf(m.role).workStartHour - 1;
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

    // Work through jobs until the hour is up. A job is only taken once there's
    // a way to it from here, so a worker who's cut off doesn't hog the queue.
    const queue = queues[m.role];
    const unreachable = new Set<string>();
    let job: Job | undefined = sticky.get(m.id);
    while (t < end - 1e-9) {
      if (!job) {
        job = queue.find(j => !claimed.has(j.room.id) && !unreachable.has(j.room.id));
        if (!job) break;
      }
      const target = roomTile(job.room);
      if (!sameTile(pos, target)) {
        const route = findRoute(state, pos!, target, pace);
        if (!route) {
          unreachable.add(job.room.id);
          claimed.delete(job.room.id); // let someone who can get there have it
          job = undefined;
          continue;
        }
        claimed.add(job.room.id);
        walk(route);
        if (t >= end) {
          roomId = job.room.id; // still on the way: keep at it next hour
          break;
        }
      }
      claimed.add(job.room.id);
      const work = Math.min(job.hours, end - t);
      legs.push(makeStay(target, t, t + work, job.kind === 'repair' ? 'repair' : 'clean', { placeId: job.room.id, job: job.kind }));
      t += work;
      if (job.kind === 'repair' || t >= end - 1e-9) {
        roomId = job.room.id;
        if (job.kind !== 'repair' && job.hours - work <= 1e-9) roomId = undefined; // finished right at the bell
        break;
      }
      job = undefined;
    }

    // Done for now: rest -- in the break room if they can get there, else where they are
    if (t < end - 1e-9 && pos) {
      const rest = restingPlace(state, pos.floor);
      if (rest && !sameTile(pos, rest.at)) walk(findRoute(state, pos, rest.at, pace));
      if (t < end) {
        const there = !!rest && sameTile(pos, rest.at);
        legs.push(makeStay(pos, t, end, 'rest', there ? { placeId: rest!.breakRoomId } : {}));
      }
    }
    return result();
  });

  return { start: T, itineraries };
}

/** This hour's staff plan: the one made at the hour boundary, or (for a state without one) planned now. */
export function getStaffPlan(state: HotelState): StaffPlan {
  if (state.staffPlan && state.staffPlan.start === hourStart(state)) return state.staffPlan;
  return planStaff(state);
}

/** Hours of each kind of work the plan does in each room. */
export function plannedWork(plan: StaffPlan, kind: 'turnover' | 'daily' | 'repair'): Map<string, number> {
  const work = new Map<string, number>();
  for (const it of plan.itineraries) {
    for (const leg of it.legs) {
      if (leg.kind !== 'stay' || leg.job !== kind || !leg.placeId) continue;
      const hours = Math.min(leg.end, plan.start + 1) - Math.max(leg.start, plan.start);
      if (hours > 0) work.set(leg.placeId, (work.get(leg.placeId) ?? 0) + hours);
    }
  }
  return work;
}

/** The roster as the plan leaves it at the end of the hour. */
export function rosterAfter(state: HotelState, plan: StaffPlan): StaffMember[] {
  const ends = new Map(plan.itineraries.map(it => [it.staffId, it.end]));
  return getRoster(state).map(m => {
    const e = ends.get(m.id);
    return e ? { id: m.id, role: m.role, at: e.at, roomId: e.roomId, carry: e.carry, ...(m.leaving ? { leaving: true } : {}) } : m;
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
    const it = plan.itineraries.find(i => i.staffId === m.id);
    if (!it || it.legs.length === 0 || it.legs[0].start >= t) return m;
    const current = positionAt(it.legs, t)?.leg;
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
    done.set(m.id, cut.legs);
    return { ...m, at: cut.at ?? finalTile(it.legs), carry: undefined, roomId };
  });
  const sofar: StaffPlan = { start: plan.start, itineraries: [...done].map(([staffId, legs]) => ({ staffId, legs, end: { at: null } })) };
  const fresh = planStaff(state, now, t, { turnover: plannedWork(sofar, 'turnover'), daily: plannedWork(sofar, 'daily') });
  const itineraries = fresh.itineraries.map(it => ({ ...it, legs: [...(done.get(it.staffId) ?? []), ...it.legs] }));
  return { ...state, staffPlan: { start: plan.start, itineraries } };
}

/** The legs before a given one. */
function legsBefore(legs: Leg[], leg: Leg): Leg[] {
  return legs.slice(0, legs.indexOf(leg));
}

/** What there is for staff to do: which rooms need cleaning or repair. When it changes mid-hour, re-plan (replanStaff). */
export function staffWorkKey(state: HotelState): string {
  return state.rooms.map(r => `${r.id}:${r.status}:${r.condition < STAFF.maintenance.conditionThreshold ? 1 : 0}`).join(',');
}
