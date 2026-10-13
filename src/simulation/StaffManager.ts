import type { HotelState, Room, StaffMember, StaffPlan, StaffItinerary, StaffRole, Leg, WalkLeg, TilePos } from './types.js';
import { STAFF, TRAVEL, GUEST_PROFILE, GUEST_HOUSEKEEPING } from '../config/balance.js';
import { findRoute, routeFromStreet, routeToStreet, getStaffBases, getAccessibleBreakRooms, isEntranceTile, stepHours, doorTile } from './Layout.js';
import { isRoomReachable } from './HotelState.js';
import { isGuestAway } from './GuestMovement.js';
import { hourStart, makeWalk, makeStay, truncateLegs, sameTile, finalTile, positionAt, walkProgress, stepStillOpen, legsEnd } from './Movement.js';
import { guestsById } from './Party.js';
import { housekeepingPrefOf, dndOpening, dndCleanStart, dndSetOff } from './CleaningPreference.js';
import { isSleepHour } from './Profile.js';

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
  const maintenance: Job[] = state.rooms
    .filter(r => r.status === 'vacant' && r.condition < STAFF.maintenance.conditionThreshold && reachable(r))
    .sort((a, b) => a.condition - b.condition) // worst condition first
    .map(room => ({ room, kind: 'repair' as const, hours: Infinity }));
  return { housekeeper: housekeeping, maintenance };
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
  for (const legs of [...state.guests.map(g => g.trip ?? []), ...(state.walkers ?? []).map(w => w.trip)]) {
    const first = legs[0];
    if (!first || first.kind !== 'walk' || first.path.length < 2 || first.start < T - 1e-9 || !sameTile(first.path[0], tile)) continue;
    clear = Math.max(clear, first.start + stepHours(first.path[0], first.path[1], first.hoursPerTile));
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
        const fromHere = dndSetOff(guest, j.room, waitFrom, here.approach, j.hours + here.step + pace, end);
        if (fromHere === null) continue;
        let option: { at: number; home: boolean; rest?: { path: TilePos[] }; restPlaceId?: string } = { at: fromHere, home: false, ...(stepOut ? { rest: stepOut } : {}) };
        if (home && (toRest || sameTile(pos, home.at))) {
          const fromHome = approachTo(home.at, j);
          const arrive = t + (toRest ? toRest.hours : 0);
          const setOff = fromHome ? dndSetOff(guest, j.room, arrive, fromHome.approach, j.hours + fromHome.step + pace, end) : null;
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
      if (!job) {
        job = queue.find(j => !claimed.has(j.room.id) && !unreachable.has(j.room.id) && notNow.get(j.room.id) !== t);
        if (!job) {
          // Nothing to do now, but a do-not-disturb party going out later this hour: be at their door as they go
          const later = nextDndSetOff();
          if (later === null) break;
          // (resting, if they can get to the resting place in time; else waiting where they are)
          if (later.rest) walk(later.rest);
          legs.push(later.home ? makeStay(pos!, t, later.at, 'rest', later.restPlaceId ? { placeId: later.restPlaceId } : {}) : makeStay(pos!, t, later.at, 'wait'));
          t = later.at;
          continue;
        }
      }
      const target = roomTile(job.room);
      const way = approachTo(pos!, job);
      if (!way) {
        unreachable.add(job.room.id);
        claimed.delete(job.room.id); // let someone who can get there have it
        job = undefined;
        continue;
      }
      if (isDnd(job)) {
        // Do not disturb: wait outside the door, step in only once the whole party is out,
        // and only if they'll stay out till it's done
        const guest = dndGuestOf(job)!;
        if (!guest || dndCleanStart(guest, job.room, t + way.approach, job.hours + way.step + pace) === null) {
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
        const enter = dndCleanStart(guest, job.room, t, job.hours + way.step + pace);
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
        if (way.route) {
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
    // Stood where they'd got to since: say so, so the hour has no holes
    const reached = cut.legs.length > 0 ? legsEnd(cut.legs) : it.legs[0].start;
    done.set(m.id, cut.at && t > reached + 1e-12 ? [...cut.legs, makeStay(cut.at, reached, t, 'wait')] : cut.legs);
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
