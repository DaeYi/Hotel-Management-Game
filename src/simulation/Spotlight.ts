import type { FacilityType, GameEvent, Guest, GuestProfile, GuestTrait, HotelState, Party, Purpose, Room, SpotlightHold, SpotlightKind, SpotlightPlan, StaffMember, StaffPlan, StaffRush } from './types.js';
import { staffRate, attendance, nextStaffWork, staffDutyAt, specialtyOf } from './StaffProfiles.js';
import { SPOTLIGHT, GUEST_PROFILE, GUEST_PURPOSES, GUEST_NAMES, ECONOMY, SATISFACTION, FACILITY_CONFIG, STAR_RATING, AMENITIES, REVIEW, STORY, STAFF, HOUSEKEEPING, TRAVEL } from '../config/balance.js';
import { STAFF_FATIGUE, STAFF_PERSONALITIES } from '../config/staff.js';
import { fatigueOn, fatigueAt, fatigueGain, projectFatigue, planStaffRest, restReservations, type RestReservation } from './StaffFatigue.js';
import { hash01, hourEnd, makeStay, finalTile, sameTile } from './Movement.js';
import { roomTile } from './GuestMovement.js';
import { getDayOfWeek } from './SeasonManager.js';
import { appendStoryLogEntry } from './StoryGenerator.js';
import { profileRoom, fitsParty, isBookable } from './RoomProfile.js';
import { isRoomReachable, formatRoomLabel, refitRoom } from './HotelState.js';
import { rollProfile, checkoutHour } from './Profile.js';
import { isCheckoutDay } from './GuestManager.js';
import { baseWalkHours } from './HousekeepingManager.js';
import { getStaffPlan, getRoster, plannedWork, rosterAfter } from './StaffManager.js';
import { surnameOf } from './Party.js';
import { FEATURE_LABELS } from './Preferences.js';
import { getOpenFacilities, findRoute, getAccessibleBreakRooms, isHallway } from './Layout.js';
import { housekeepingPrefOf } from './CleaningPreference.js';
import type { GuestReviewBreakdown } from './GuestManager.js';

// Spotlight guests (docs/designs/guest-staff-personalities.md, Status #13): a
// travel writer or a celebrity, at most one a week once the hotel has three
// stars. Rolled on Monday morning from a hash of the week (and the latest
// booking, so every game differs) -- never the shared random stream -- and
// announced a day or two ahead, with a suite held for them (a standing policy).
// They come on the day at a set hour, first in line, and take the held suite.
// The writer tries every facility the hotel has, judges it as a hotel one star
// up, and their review counts five times over: a glowing one brings more
// bookings for a while, a bad one always spreads. The celebrity wants the top
// floor, pays double there, keeps the door shut, and draws a few more walk-ins
// the day they come.

/** Whether spotlight guests are on (they need guest profiles: who they are lives there). */
export function spotlightOn(): boolean {
  return SPOTLIGHT.enabled && GUEST_PROFILE.enabled;
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WHO: Record<SpotlightKind, string> = { writer: 'travel writer', celebrity: 'celebrity' };
const PARTY: Record<SpotlightKind, Party> = { writer: { kind: 'solo', size: 1 }, celebrity: { kind: 'couple', size: 2 } };
const TYPE_RANK: Record<string, number> = { standard: 0, deluxe: 1, suite: 2 };

/** When the spotlight guest walks in (absolute hours): their room is decided at the hour boundary before. */
export const arrivalTime = (plan: Pick<SpotlightPlan, 'arrivalDay' | 'arrivalHour'>) => (plan.arrivalDay - 1) * 24 + plan.arrivalHour;

/** "Fri ~15:00". */
export function shortWhen(plan: Pick<SpotlightPlan, 'arrivalDay' | 'arrivalHour'>): string {
  return `${DAYS[getDayOfWeek(plan.arrivalDay)].slice(0, 3)} ~${String(plan.arrivalHour).padStart(2, '0')}:00`;
}

/** "Friday at about 15:00". */
export function whenDue(plan: Pick<SpotlightPlan, 'arrivalDay' | 'arrivalHour'>): string {
  return `${DAYS[getDayOfWeek(plan.arrivalDay)]} at about ${String(plan.arrivalHour).padStart(2, '0')}:00`;
}

/** Whether the hotel holds a suite for an announced spotlight guest (the standing policy; held unless told not to). */
export function holdPolicy(state: Pick<HotelState, 'spotlightHold'>): 'hold' | 'none' {
  return state.spotlightHold ?? 'hold';
}

/** The top floor: the highest floor with rooms. */
export function topFloor(state: Pick<HotelState, 'rooms'>): number {
  return Math.max(0, ...state.rooms.map(r => r.floor));
}

const isSuite = (room: Room) => profileRoom(room).type === 'suite';
const quality = (room: Room) => (room.status !== 'renovating' ? (room.decor + room.condition) / 2 : room.refitting ? (room.refitting.decorAfter + room.condition) / 2 : 100);

/** When the spotlight guest comes, for judging a suite: their hour, or (byLast) the last check-in that day. */
type Judged = Pick<SpotlightPlan, 'kind' | 'arrivalDay' | 'arrivalHour'> & { byLast?: boolean };

/**
 * Whether a suite will be free for the spotlight guest by the time they come:
 * a reachable suite their party fits, in working order, vacant now, being
 * cleaned (with a day to spare, or a clean short enough), renovating but done
 * by then (a refit doesn't mend a broken room), or with a guest who leaves
 * before the day (judged by the last check-in, on the day too). `asHeld`:
 * judged as the suite held for them (as a hold is picked), whose turnover
 * jumps the queue if it wouldn't be ready in its turn; otherwise as things
 * stand.
 */
export function freeBy(state: HotelState, room: Room, plan: Judged, between = false, asHeld = false): boolean {
  return readyAt(state, room, plan, between, asHeld) <= arrivalTime(plan);
}

/**
 * When a suite will be free for the spotlight guest (absolute hours;
 * -Infinity: now; Infinity: not for them by their day), as freeBy judges it.
 * `rushed`: the held suite if it's rushed (rushedFrom), for many suites judged
 * on one state (worked out once).
 */
export function readyAt(state: HotelState, room: Room, plan: Judged, between = false, asHeld = false, rushed?: () => string | undefined): number {
  if (!isSuite(room) || !isBookable(room) || !fitsParty(profileRoom(room), PARTY[plan.kind]) || !isRoomReachable(state, room)) return Infinity;
  if (room.status === 'renovating') return !room.refitting || room.condition > ECONOMY.roomBreakdownThreshold ? hourEnd(state) + room.renovationHoursRemaining : Infinity;
  if (room.condition <= ECONOMY.roomBreakdownThreshold) return Infinity;
  if (room.status === 'vacant') return -Infinity;
  if (room.status === 'occupied') {
    // Its guest leaves before the day (or, by the last check-in, that morning), then the turnover after them
    const guest = state.guests.find(g => g.id === room.guestId);
    const leaves = guest ? guest.checkInDay + guest.stayLength : Infinity;
    if (!(leaves < plan.arrivalDay || (plan.byLast && leaves === plan.arrivalDay))) return Infinity;
  }
  const from: From = between ? 'plan' : 'end';
  // Held (or as if held): in its turn, or (if that's too late for their hour) rushed, if that's sooner: kept for
  // whoever would finish it first, as the planner has it (rushFor); any other suite behind the held one while that's
  // rushed
  if (asHeld || heldId(state) === room.id) {
    const inTurn = cleanedAt(state, room, from, undefined, room.id);
    return inTurn <= dueAt(state, plan) ? inTurn : Math.min(inTurn, cleanedAt(state, room, from, room.id, room.id));
  }
  return cleanedAt(state, room, from, rushed ? rushed() : rushedFrom(state, from), heldId(state));
}

/**
 * The suite held for the spotlight guest if it's rushed, judged as readyAt
 * judges it: if in its turn it wouldn't be ready by their hour, and rushed it
 * would be sooner (between hours, from where this hour's plan leaves things,
 * as the next hour's plan will decide it: this hour's own rush may be for a
 * hold since moved, or for none).
 */
function rushedFrom(state: HotelState, from: From): string | undefined {
  const id = heldId(state);
  const room = id ? state.rooms.find(r => r.id === id) : undefined;
  if (!id || !room || room.status !== 'cleaning') return undefined;
  const inTurn = cleanedAt(state, room, from, undefined, id);
  return inTurn > arrivalTime(state.spotlight!) && cleanedAt(state, room, from, id, id) < inTurn - 1e-9 ? id : undefined;
}

/**
 * When the spotlight guest is due, for judging a suite held: their hour, from
 * the plan announced (every caller in the game has it announced, the
 * announcement's own pick too: a suite late in its turn is judged by the
 * sooner of that and rushed, even when asked about the last check-in), or
 * (none announced: a direct call) the one asked about.
 */
const dueAt = (state: HotelState, plan: Judged) => (state.spotlight?.status === 'announced' ? arrivalTime(state.spotlight) : arrivalTime(plan));

/** The suite held for the spotlight guest if this hour's plan rushes it (rushFor). */
export function rushedSuite(state: HotelState): string | undefined {
  const id = heldId(state);
  return id && getStaffPlan(state).rush?.roomId === id ? id : undefined;
}

/**
 * Whether this hour's plan should rush the suite held for the spotlight guest
 * (its turnover jumping the housekeepers' queue), and for whom: when, from
 * where the hour's plan made without it leaves things, it wouldn't be ready
 * for them by their hour in its turn, and rushed it would be sooner. Kept for
 * the housekeeper who'd finish it first, from when she's next free (the
 * estimate's `by`; one not on the roster: first in the queue, for whoever's
 * free). Never with no housekeepers (the estimate doesn't count clerks
 * helping with turnovers: it has the suite never ready, so it isn't held).
 * `helps`: whether the plan made with it does get the suite ready sooner than
 * that one.
 */
export function rushFor(state: HotelState, plain: StaffPlan): { rush: StaffRush; helps: (rushed: StaffPlan) => boolean } | undefined {
  const id = heldId(state);
  const room = id ? state.rooms.find(r => r.id === id) : undefined;
  if (!id || !room || room.status !== 'cleaning' || !isRoomReachable(state, room)) return undefined;
  const inTurn = cleanedAfter(state, plain, room, undefined, id);
  if (inTurn <= arrivalTime(state.spotlight!)) return undefined;
  const best = simulate(state, room, 'start', id, id);
  const staffId = best.by !== undefined ? housekeepersOf(getRoster(state), state.staff.housekeepers)[best.by]?.id : undefined;
  if (!(best.done < inTurn - 1e-9)) return undefined;
  return { rush: staffId ? { roomId: id, staffId } : { roomId: id }, helps: rushed => cleanedAfter(state, rushed, room, id, id) < inTurn - 1e-9 };
}

/** The housekeepers who work this hour, in the roster's order (as the planner and the estimate have them). */
const housekeepersOf = (roster: StaffMember[], staff: number) => roster.filter(m => m.role === 'housekeeper' && !m.leaving).slice(0, staff);

/** "19:00": the hour by which a suite will be ready (the next whole hour). */
const readyClock = (t: number) => `${String(Math.ceil(t - 1e-9) % 24).padStart(2, '0')}:00`;

/** The suite held for the announced spotlight guest, if any. */
const heldId = (state: HotelState) => (spotlightOn() && state.spotlight?.status === 'announced' ? state.spotlight.roomId : undefined);

/** The next moment from t the housekeepers are at work (absolute hours). */
function atWork(t: number, member?: StaffMember): number {
  if (member) return nextStaffWork(member, t);
  const start = Math.floor(t / 24) * 24 + STAFF.housekeeping.workStartHour;
  const end = Math.floor(t / 24) * 24 + STAFF.housekeeping.workEndHour;
  return t < start ? start : t >= end ? start + 24 : t;
}

/** The end of the shift that a moment at work falls in (absolute hours). */
const shiftEndAt = (t: number, member?: StaffMember) => (member ? staffDutyAt(member, t).end : Math.floor(t / 24) * 24 + STAFF.housekeeping.workEndHour);

/**
 * How far a housekeeper gets with a turnover from `from` (a walk to it, then
 * the work): done, or (`left`, the units still to do) stopped at the end of
 * the shift she does it in, and how she'd be then. She's walked out at the end
 * of her shift, and the planner hands the room out afresh in the morning. A
 * held suite must allow for the same tired rates, recovery and real breaks as
 * its cleaning crew.
 */
function finishTurnover(state: HotelState, member: StaffMember | undefined, room: Room, from: number, units: number, walk: number, reservations: RestReservation[]): { done: number; member?: StaffMember; left: number } {
  if (!Number.isFinite(from)) return { done: Infinity, member, left: 0 };
  if (!member || !fatigueOn()) {
    const rate = member ? staffRate(member) : 1;
    const start = atWork(from, member);
    if (!Number.isFinite(start)) return { done: Infinity, member, left: 0 };
    const end = shiftEndAt(start, member);
    if (start + walk + units / rate <= end + 1e-9) return { done: start + walk + units / rate, member, left: 0 };
    return { done: end, member, left: units - Math.max(0, end - start - walk) * rate };
  }
  let at = from, energy = fatigueAt(state, member, from), pos = roomTile(room);
  const advance = (until: number) => { energy = projectFatigue(member, [], at, until, energy); at = until; };
  const active = (hours: number) => {
    energy = projectFatigue(member, [makeStay(pos, at, at + hours, 'clean')], at, at + hours, energy);
    at += hours;
  };
  // A saved break is a commitment, including the walk already underway. Its
  // remaining rest cannot disappear from a readiness quote after reloading.
  const pending = member.fatigueBreak;
  if (pending && pending.end > at) {
    let restedAt = pending.at;
    const validBreak = pending.placeId ? getAccessibleBreakRooms(state).some(r => r.id === pending.placeId && sameTile(r, pending.at))
      : isHallway(state, pending.at.gridX, pending.at.gridY, pending.at.floor);
    if (validBreak) {
      active(Math.max(0, pending.start - at));
      energy = projectFatigue(member, [makeStay(pending.at, at, pending.end, 'rest', {
        restRate: pending.placeId ? STAFF_FATIGUE.roomRecovery : STAFF_FATIGUE.fallbackRecovery,
      })], at, pending.end, energy);
      at = pending.end;
    } else {
      // A paused demolition can leave the boundary member pointing at the old
      // room while its physical itinerary already holds the revised break.
      // Preserve past recovery and use the new walk, seat and recovery rate.
      const physical = state.staffPlan?.itineraries.find(it => it.staffId === member.id)?.legs
        .filter(leg => leg.end > at && leg.start < pending.end) ?? [];
      if (physical.some(leg => leg.kind === 'stay' && leg.activity === 'rest' && leg.restRate !== undefined)) {
        const until = Math.max(pending.end, physical.at(-1)!.end);
        energy = projectFatigue(member, physical, at, until, energy);
        at = until;
        restedAt = finalTile(physical) ?? pending.at;
      } else {
        const rest = planStaffRest(state, member, member.at ?? pos, at, reservations,
          Math.max(0, pending.end - Math.max(at, pending.start)), pending.end);
        energy = projectFatigue(member, rest.legs, at, rest.until, energy);
        at = rest.until;
        restedAt = rest.at;
      }
    }
    const back = findRoute(state, restedAt, pos, TRAVEL.hoursPerTile);
    if (!back) return { done: Infinity, member, left: 0 };
    walk = Math.max(walk, back.hours);
  }
  const stop = shiftEndAt(atWork(at, member), member);
  const after = (left: number) => {
    const hours = member.profile?.experience === 'rookie' ? 0 : STAFF_PERSONALITIES.experienceHours[member.profile?.experience ?? 'skilled'];
    return { done: at, left, member: { ...member, at: pos, fatigueBreak: undefined,
      stats: { workHours: member.stats?.workHours ?? hours, lateDays: 0, absentDays: 0, ...member.stats, fatigue: energy, fatigueAt: at } } };
  };
  // Keep the existing conservative base-to-room transfer estimate. Fatigue
  // follows its elapsed walking time, while overnight gaps recover normally.
  for (let guard = 0; walk > 1e-9 && guard < 120; guard++) {
    if (atWork(at, member) >= stop - 1e-9) return after(units);
    advance(atWork(at, member));
    const step = Math.min(walk, staffDutyAt(member, at).end - at);
    active(step); walk -= step;
  }
  if (walk > 1e-9) return { done: Infinity, member, left: 0 };
  const baseRate = staffRate({ ...member, stats: { ...member.stats!, fatigue: 0 } });
  for (let guard = 0; units > 1e-9 && guard < 2000; guard++) {
    if (at - from > 60 * 24) return { done: Infinity, member, left: 0 };
    if (atWork(at, member) >= stop - 1e-9) return after(units);
    advance(atWork(at, member));
    if (energy >= STAFF_FATIGUE.breakAt - 1e-9) {
      const rest = planStaffRest(state, member, pos, at, reservations);
      energy = projectFatigue(member, rest.legs, at, rest.until, energy);
      at = rest.until;
      const back = findRoute(state, rest.at, pos, TRAVEL.hoursPerTile);
      if (!back) return { done: Infinity, member, left: 0 };
      active(back.hours);
      continue;
    }
    const rate = baseRate * (energy >= STAFF_FATIGUE.tiredAt - 1e-9 ? STAFF_FATIGUE.tiredRate : 1);
    const threshold = energy < STAFF_FATIGUE.tiredAt - 1e-9 ? STAFF_FATIGUE.tiredAt : STAFF_FATIGUE.breakAt;
    const step = Math.min(units / rate, staffDutyAt(member, at).end - at, (threshold - energy) / fatigueGain(member));
    active(step); units -= step * rate;
  }
  if (units > 1e-9) return { done: Infinity, member, left: 0 };
  return after(0);
}

/** Where an estimate starts: the end of this hour, as the tick has it; its start, before anyone's planned (the planner); or between hours, where this hour's plan leaves things. */
type From = 'end' | 'start' | 'plan';

/**
 * When a room being cleaned (or its guest's leaving, then cleaned) will be
 * done (absolute hours), as the housekeepers work it out hour by hour
 * (StaffManager.planStaff): each keeps at the room she's in; then whoever
 * comes free in the earliest hour (the roster's order within an hour, as the
 * planner plans it) takes the best turnover waiting then: the suite `held`
 * for a spotlight guest if she's a room attendant (they do it before their
 * dailies), else the fewest hours left, ties to the earlier room (rooms they
 * can't reach left out), walking to it (a walk from base: they mostly go from
 * one room to the next), and keeps at it till the end of her shift (what's
 * left goes back in the queue for the morning: she's walked out). The suite
 * `first` (rushed: jumping the queue) goes to whoever would finish it first,
 * from when she's next free. A checkout's room joins when its guest leaves
 * (up to tomorrow's, or this room's guest's day: two days ahead, the arrival
 * day's checkouts aren't counted yet); all in their shift hours, from the
 * next hour (`from` 'start': this one, before anyone's planned). Between hours
 * ('plan': a card), from where this hour's plan leaves things. Never, with no
 * housekeepers. (A room attendant's dailies aren't counted: she's taken for a
 * turnover runner otherwise. The tick judges before the hour's check-ins:
 * their checkouts join from the next hour.)
 */
function cleanedAt(state: HotelState, room: Room, from: From, first: string | undefined, held: string | undefined): number {
  return from === 'plan' ? cleanedAfter(state, getStaffPlan(state), room, first, held) : simulate(state, room, from, first, held).done;
}

/** As cleanedAt, from where an hour's plan leaves things: its work done, everyone where it leaves them (the hour's housekeepers are already sent). */
function cleanedAfter(state: HotelState, hour: StaffPlan, room: Room, first: string | undefined, held: string | undefined): number {
  if (state.staff.housekeepers <= 0) return Infinity;
  const worked = plannedWork(hour, 'turnover');
  const left = (r: Room): Room => (r.status === 'cleaning' && worked.has(r.id) ? { ...r, cleaningHoursRemaining: r.cleaningHoursRemaining - worked.get(r.id)! } : r);
  const self = left(room);
  if (self.status === 'cleaning' && self.cleaningHoursRemaining <= 1e-9) return hourEnd(state); // (done this hour)
  const rooms = state.rooms.map(r => {
    const after = left(r);
    return after.status === 'cleaning' && after.cleaningHoursRemaining <= 1e-9 ? { ...after, status: 'vacant' as const, cleaningHoursRemaining: 0 } : after;
  });
  return simulate({ ...state, rooms, staffRoster: rosterAfter(state, hour) }, self, 'end', first, held).done;
}

/** The estimate itself (cleanedAt), from this hour's end or start; `by`: which of the hour's housekeepers (housekeepersOf) does the room. */
function simulate(state: HotelState, room: Room, from: 'end' | 'start', first: string | undefined, held: string | undefined): { done: number; by?: number } {
  const staff = state.staff.housekeepers;
  if (staff <= 0) return { done: Infinity };
  const t = from === 'start' ? hourEnd(state) - 1 : hourEnd(state);
  const walk = baseWalkHours(state);
  const turnover = HOUSEKEEPING.turnoverDuration[state.housekeeping.turnoverQuality] ?? HOUSEKEEPING.turnoverDuration.standard;
  const leavesOn = (r: Room) => {
    const g = state.guests.find(x => x.id === r.guestId);
    return g ? { g, day: g.checkInDay + g.stayLength } : null;
  };
  const own = room.status === 'occupied' ? leavesOn(room) : null;
  const horizon = Math.max(state.day + 1, own?.day ?? 0);
  type Job = { id: string; hours: number; from: number; order: number };
  const jobs: Job[] = [];
  state.rooms.forEach((stored, order) => {
    const r = stored.id === room.id ? room : stored;
    if (r.id !== room.id && !isRoomReachable(state, r)) return;
    if (r.status === 'cleaning') jobs.push({ id: r.id, hours: r.cleaningHoursRemaining, from: t, order });
    else if (r.status === 'occupied') {
      const leaving = leavesOn(r);
      if (leaving && leaving.day <= horizon) jobs.push({ id: r.id, hours: turnover, from: Math.max(t, (Math.max(leaving.day, state.day) - 1) * 24 + checkoutHour(leaving.g, state)), order });
    }
  });
  if (!jobs.some(j => j.id === room.id)) return { done: Infinity };
  const taken = new Set<string>();
  const free: number[] = [];
  const workers: Array<StaffMember | undefined> = [];
  const attendant: boolean[] = [];
  const reservations = fatigueOn() ? restReservations(state) : [];
  const roomOf = (id: string) => state.rooms.find(r => r.id === id) ?? room;
  /** Housekeeper k does a job from `at`: when she's done (undefined: not this shift; what's left goes back in the queue). */
  const work = (k: number, job: Job, at: number, walkHours: number): number | undefined => {
    const result = finishTurnover(state, workers[k], roomOf(job.id), at, job.hours, walkHours, reservations);
    free[k] = result.done;
    workers[k] = result.member;
    if (result.left <= 1e-9) return result.done;
    taken.delete(job.id);
    job.hours = result.left;
    job.from = result.done;
    return undefined;
  };
  /** When housekeeper k would finish a job taken from `at`, shift by shift (a walk to it each time). */
  const finishOf = (k: number, job: Job, at: number) => {
    let from = at, units = job.hours, member = workers[k];
    for (let shifts = 0; shifts < 60; shifts++) {
      const result = finishTurnover(state, member, roomOf(job.id), from, units, walk, reservations);
      if (result.left <= 1e-9 || !Number.isFinite(result.done)) return result.done;
      ({ done: from, left: units, member } = result);
    }
    return Infinity;
  };
  // Each keeps at the room she's in (no walk to it)
  for (const m of housekeepersOf(state.staffRoster ?? [], staff)) {
    const k = free.length;
    free.push(t); workers.push(m); attendant.push(specialtyOf(m) === 'room_attendant');
    const job = m.roomId ? jobs.find(j => j.id === m.roomId && !taken.has(j.id) && j.from <= t + 1e-9) : undefined; // (a turnover under way: not a daily clean)
    if (!job || attendance(m, Math.floor(t / 24) + 1).absent || atWork(t, m) > t + 1e-9) continue; // (off shift: walked out)
    taken.add(job.id);
    const done = work(k, job, t, 0);
    if (job.id === room.id && done !== undefined) return { done, by: k };
  }
  while (free.length < staff) { free.push(t); workers.push(undefined); attendant.push(false); }
  const hourOf = (k: number) => Math.floor(free[k] + 1e-9);
  for (let guard = 0; guard < 4000; guard++) {
    for (let k = 0; k < free.length; k++) free[k] = atWork(free[k], workers[k]);
    // Whoever's free in the earliest hour; within it, the roster's order (each plans her hour in turn)
    const i = free.reduce((best, _x, k) => (hourOf(k) < hourOf(best) ? k : best), 0);
    if (!Number.isFinite(free[i])) return { done: Infinity };
    const waiting = jobs.filter(j => !taken.has(j.id) && j.from <= free[i] + 1e-9);
    if (waiting.length === 0) {
      // Nothing yet: till the next guest leaves (this room's among them)
      free[i] = Math.min(...jobs.filter(j => !taken.has(j.id)).map(j => j.from));
      continue;
    }
    const rushed = first !== undefined ? waiting.find(j => j.id === first) : undefined;
    if (rushed) {
      // Kept for whoever would finish it first, from when she's next free
      let k = 0;
      let soonest = Infinity;
      free.forEach((x, n) => {
        const done = finishOf(n, rushed, Math.max(x, rushed.from));
        if (done < soonest - 1e-9) { soonest = done; k = n; }
      });
      taken.add(rushed.id);
      const done = work(k, rushed, Math.max(free[k], rushed.from), walk);
      if (rushed.id === room.id && done !== undefined) return { done, by: k };
      continue;
    }
    const job = (attendant[i] && held !== undefined ? waiting.find(j => j.id === held) : undefined)
      ?? waiting.reduce((best, j) => (j.hours < best.hours || (j.hours === best.hours && j.order < best.order) ? j : best));
    taken.add(job.id);
    const done = work(i, job, free[i], walk);
    if (job.id === room.id && done !== undefined) return { done, by: i };
  }
  return { done: Infinity };
}

const above = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

/** The best of some rooms by a ranking (ties to the lower id, so it never depends on the list's order). */
function bestOf(rooms: Room[], rank: (r: Room) => number[]): Room | null {
  let best: Room | null = null;
  let bestRank: number[] = [];
  for (const r of [...rooms].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const k = rank(r);
    if (!best || above(k, bestRank)) { best = r; bestRank = k; }
  }
  return best;
}

/** How the spotlight guest ranks suites: the writer the freshest, then the higher; the celebrity the highest, then the freshest. */
const rankFor = (plan: Pick<SpotlightPlan, 'kind'>) => (room: Room) => (plan.kind === 'celebrity' ? [room.floor, quality(room)] : [quality(room), room.floor]);

/**
 * The suite to hold: the one held now while it'll still do (picked by hand,
 * or the best when it was picked: a better one coming free later doesn't take
 * the hold from a suite that's ready; one that won't be ready by their hour
 * gives way to one that will and suits them as well), else (if the hotel holds one) the best that
 * will be free by their hour, or failing that by the last check-in (they wait
 * for it); none once let go by hand.
 */
function pickHold(state: HotelState, plan: SpotlightPlan): string | undefined {
  if (plan.released) return undefined;
  const held = plan.roomId ? state.rooms.find(r => r.id === plan.roomId) : undefined;
  // Kept while it'll be ready for them by the last check-in (they wait for it); a celebrity's (not picked by hand)
  // moves up to a suite higher up that's ready: the top floor is the point
  if (held && freeBy(state, held, lastCheckIn(plan), false, true) && (plan.chosen || holdPolicy(state) === 'hold')) {
    // A hold that won't be ready by their hour (a second choice, or one that's slipped), not picked by hand, gives
    // way to a suite that will be and suits them as well (as they'd take one free when they come)
    if (!plan.chosen && !freeBy(state, held, plan, false, true)) {
      const ready = bestOf(state.rooms.filter(r => r.id !== held.id && freeBy(state, r, plan, false, true) && !above(rankFor(plan)(held), rankFor(plan)(r))), rankFor(plan));
      if (ready) return ready.id;
    }
    const higher = plan.kind === 'celebrity' && !plan.chosen ? bestOf(state.rooms.filter(r => r.floor > held.floor && r.status === 'vacant' && freeBy(state, r, plan, false, true)), rankFor(plan)) : null; // (ready now: never giving up a ready suite for one that might not be)
    return (higher ?? held).id;
  }
  if (holdPolicy(state) === 'none') return undefined;
  // Each judged as if held (its turnover first in the queue): the best ready by their hour, else the best ready by
  // the last check-in (they wait for it; of two as good, the one ready sooner)
  const sooner = (r: Room) => [...rankFor(plan)(r), -readyAt(state, r, lastCheckIn(plan), false, true)];
  return (bestOf(state.rooms.filter(r => freeBy(state, r, plan, false, true)), rankFor(plan))
    ?? bestOf(state.rooms.filter(r => freeBy(state, r, lastCheckIn(plan), false, true)), sooner))?.id;
}

/** The plan as if they came at the last check-in (what's ready for them by then, a guest leaving that morning's suite too). */
const lastCheckIn = <P extends Judged>(plan: P): P & { byLast: true } => ({ ...plan, arrivalHour: ECONOMY.checkInEndHour, byLast: true });

/**
 * For a suite's card while a spotlight guest is announced: whether it's held
 * for them, or could be (null: neither): a suite that would be ready for them,
 * held, by the last check-in; `readyBy` if only after their hour (they'd wait
 * for it, or take the `rival`: free sooner, by `rivalBy` if after their hour);
 * `here`: they've come.
 */
export function holdFor(state: HotelState, room: Room): { held: boolean; who: string; when: string; readyBy?: string; rival?: string; rivalBy?: string; here?: boolean } | null {
  const plan = spotlightOn() ? state.spotlight : undefined;
  if (!plan || plan.status !== 'announced') return null;
  const held = plan.roomId === room.id;
  const at = readyAt(state, room, lastCheckIn(plan), true, true);
  if (!held && at > arrivalTime(lastCheckIn(plan))) return null;
  const late = at > arrivalTime(plan) && Number.isFinite(at) && at <= arrivalTime(lastCheckIn(plan));
  const rival = late ? rivalOf(state, plan, room, at, true) : null;
  return {
    held, who: WHO[plan.kind], when: shortWhen(plan), ...(late ? { readyBy: readyClock(at) } : {}),
    ...(rival ? { rival: roomName(rival.room), ...(rival.at > arrivalTime(plan) ? { rivalBy: readyClock(rival.at) } : {}) } : {}),
    ...(hourEnd(state) > arrivalTime(plan) ? { here: true } : {}),
  };
}

/**
 * Of a suite held for the spotlight guest that won't be ready till `at`,
 * after their hour: the one they'd take instead, as things stand with this
 * one held (spotlightArrival takes one that suits them as well once it's
 * free): at least as good, and free in an earlier hour than this one (the
 * soonest; of those, the best); `at`: the hour they'd take it. One with a
 * refit booked is judged as that leaves it (refitBooked).
 */
function rivalOf(state: HotelState, plan: SpotlightPlan, room: Room, at: number, between: boolean): { room: Room; at: number } | null {
  const as = state.spotlight?.roomId === room.id ? state : { ...state, spotlight: { ...plan, roomId: room.id } };
  const rank = rankFor(plan);
  const due = arrivalTime(plan);
  const mine = Math.ceil(at - 1e-9);
  let first: { id: string | undefined } | undefined;
  const rushed = () => (first ??= { id: rushedFrom(as, between ? 'plan' : 'end') }).id;
  const timed = state.rooms.filter(r => r.id !== room.id).flatMap(r => {
    const free = readyAt(as, r, lastCheckIn(plan), between, false, rushed);
    const refit = r.pendingRefit && free < Infinity ? refitBooked(as, plan, r, free, between) : null;
    if (refit === undefined || above(rank(room), rank(refit?.room ?? r))) return [];
    return [{ r, at: Math.max(due, Math.ceil((refit?.at ?? free) - 1e-9)) }];
  }).filter(x => x.at < mine);
  if (timed.length === 0) return null;
  const soonest = Math.min(...timed.map(x => x.at));
  return { room: bestOf(timed.filter(x => x.at === soonest).map(x => x.r), rank)!, at: soonest };
}

/**
 * A suite with a refit booked, free at `free`, for the spotlight guest who'd
 * take it (not held): the refit starts once it's empty, in that hour, if
 * there's the money (as things stand) and it changes anything (null: it
 * won't, and the suite's as it is); then it's the suite refitted, free once
 * that's done (undefined: not a suite for them, refitted).
 */
function refitBooked(state: HotelState, plan: SpotlightPlan, room: Room, free: number, between: boolean): { room: Room; at: number } | null | undefined {
  const empty: Room = { ...room, status: 'vacant', cleaningHoursRemaining: 0, guestId: undefined };
  const refitted = refitRoom({ ...state, rooms: state.rooms.map(r => (r.id === room.id ? empty : r)) }, room.id, room.pendingRefit!, 'now');
  const after = refitted?.rooms.find(r => r.id === room.id);
  if (!refitted || !after || after.status !== 'renovating') return null;
  if (!(readyAt(refitted, after, lastCheckIn(plan), between) < Infinity)) return undefined;
  return { room: after, at: Math.max(hourEnd(state), Math.ceil(free - 1e-9)) + after.renovationHoursRemaining };
}

/** Hold a suite for the announced spotlight guest by hand (null: it isn't a suite that would be ready for them, held, by the last check-in). */
export function holdSuite(state: HotelState, roomId: string): HotelState | null {
  const plan = spotlightOn() ? state.spotlight : undefined;
  const room = state.rooms.find(r => r.id === roomId);
  if (!plan || plan.status !== 'announced' || !room || !freeBy(state, room, lastCheckIn(plan), true, true)) return null;
  const { waitNoted: _noted, ...rest } = plan;
  return { ...state, spotlight: { ...rest, roomId, chosen: true, released: false } };
}

/** Let the held suite go: it can be booked, and the spotlight guest takes the best suite free when they come (here already, as soon as one's free). */
export function releaseHold(state: HotelState): HotelState | null {
  const plan = spotlightOn() ? state.spotlight : undefined;
  if (!plan || plan.status !== 'announced' || !plan.roomId) return null;
  const { roomId: _held, waitNoted: _noted, ...rest } = plan;
  return { ...state, spotlight: { ...rest, chosen: false, released: true } };
}

/** Set the standing hold policy; choosing to hold also takes back a hold let go by hand for the guest announced now. */
export function setHoldPolicy(state: HotelState, policy: SpotlightHold): HotelState {
  const plan = state.spotlight;
  return { ...state, spotlightHold: policy, ...(policy === 'hold' && plan?.released ? { spotlight: { ...plan, released: false } } : {}) };
}

/** Whether the hold for the guest announced now was let go by hand (for the Staff panel). */
export function holdLetGo(state: HotelState): boolean {
  return spotlightOn() && state.spotlight?.status === 'announced' && !!state.spotlight.released;
}

/**
 * Whether a room is the suite held for an announced spotlight guest: nobody
 * else is booked or moved into it till they come, however short their stay,
 * its turnover jumps the housekeepers' queue if it wouldn't be ready for them
 * in its turn (rushFor), room attendants do it before their dailies, and a
 * refit booked on it waits till they've been.
 */
export function heldNow(state: HotelState, roomId: string): boolean {
  return heldId(state) === roomId;
}

/** Whether renovating a room now would run past the spotlight guest's arrival in the suite held for them. */
export function holdBlocksRenovation(state: HotelState, roomId: string, hours: number): boolean {
  const plan = spotlightOn() ? state.spotlight : undefined;
  return !!plan && plan.status === 'announced' && plan.roomId === roomId && hourEnd(state) + hours > arrivalTime(plan);
}

/**
 * How far past their hour a suite's estimate must be for the story to say
 * they'll wait for it: a day or two ahead, more than SPOTLIGHT.slipMargin (a
 * few minutes either way is finer than the estimate can judge); from the hour
 * before they come (their room's decided at its end), any (it's certain).
 */
const waitMargin = (state: HotelState, plan: SpotlightPlan) => (hourEnd(state) >= arrivalTime(plan) ? 0 : SPOTLIGHT.slipMargin);

/**
 * For the story, of a suite held: when it'll be ready, if only after their
 * hour (by more than `margin`): they'll wait for it (`here`: they've come, and
 * are waiting), or take one as good free sooner (as the card has it).
 */
function waitFor(state: HotelState, plan: SpotlightPlan, room: Room, here = false, margin = 0): string {
  const at = readyAt(state, room, lastCheckIn(plan), false, true);
  if (!(at > arrivalTime(plan) + margin && Number.isFinite(at))) return '';
  const rival = rivalOf(state, plan, room, at, false);
  const then = rival
    ? `they'll take ${roomName(rival.room)}${rival.at > arrivalTime(plan) ? ` (free by about ${readyClock(rival.at)})` : ''} if it's still free, else wait for it`
    : here ? "they're waiting for it" : "they'll wait for it";
  return ` It'll be ready by about ${readyClock(at)}: ${then}.`;
}

function log(state: HotelState, plan: SpotlightPlan, type: string, message: string, roomId?: string): HotelState {
  return appendStoryLogEntry(state, { type, message, chainId: plan.chainId, ...(roomId ? { roomId } : {}) }).state;
}

const roomName = (room: Room) => `Room ${formatRoomLabel(room.gridX, room.gridY, room.floor)}`;

/**
 * The week's spotlight guest, at each hour boundary (call in the tick before
 * arrivals): rolled on Monday at 09:00 (from 3 stars, with a suite to put
 * them in; one at a time), announced at 09:00 a day or two ahead with a suite
 * held, reminded the day before, and the hold kept on a suite that will be
 * free by then. Not an incident: none of the day's story budget.
 */
export function planSpotlight(state: HotelState): { state: HotelState; events: GameEvent[] } {
  if (!spotlightOn()) return { state, events: [] };
  const events: GameEvent[] = [];
  let current = state;
  let plan = current.spotlight;
  const at = SPOTLIGHT.rollHour;
  const hasSuite = current.rooms.some(isSuite);
  // Monday morning: this week's
  if (current.hour === at && getDayOfWeek(current.day) === 0 && (!plan || plan.status === 'done') && current.starRating >= SPOTLIGHT.fromStars && hasSuite) {
    const week = Math.floor((current.day - 1) / 7);
    const salt = current.bookings[current.bookings.length - 1]?.id ?? '';
    const key = `spotlight|${week}|${salt}`;
    if (hash01(key) < (SPOTLIGHT.weeklyChance[Math.min(5, current.starRating)] ?? 0)) {
      const [d0, d1] = SPOTLIGHT.arrivalDays;
      const [l0, l1] = SPOTLIGHT.leadDays;
      const [h0, h1] = SPOTLIGHT.arrivalHours;
      const arrivalDay = current.day + d0 + Math.floor(hash01(`${key}|day`) * (d1 - d0 + 1));
      const lead = l0 + Math.floor(hash01(`${key}|lead`) * (l1 - l0 + 1));
      plan = {
        kind: hash01(`${key}|kind`) < SPOTLIGHT.writerShare ? 'writer' : 'celebrity', week, salt,
        announceDay: Math.max(current.day, arrivalDay - lead), arrivalDay, arrivalHour: h0 + Math.floor(hash01(`${key}|hour`) * (h1 - h0 + 1)),
        status: 'planned', chainId: `spotlight-${arrivalDay}`,
      };
      current = { ...current, spotlight: plan };
    }
  }
  if (!plan) return { state: current, events };
  // Announced (unless the hotel has slipped below the stars, or has no suite now: then quietly not)
  if (plan.status === 'planned' && current.day >= plan.announceDay && current.hour === at) {
    if (current.starRating < SPOTLIGHT.fromStars || !hasSuite) return { state: { ...current, spotlight: { ...plan, status: 'done' } }, events };
    plan = { ...plan, status: 'announced' };
    const roomId = pickHold({ ...current, spotlight: plan }, plan); // (judged as announced: rushed if held, as it will be)
    plan = { ...plan, ...(roomId ? { roomId } : {}) };
    current = { ...current, spotlight: plan };
    const room = current.rooms.find(r => r.id === roomId);
    const note = room ? waitFor(current, plan, room, false, waitMargin(current, plan)) : '';
    if (note) current = { ...current, spotlight: plan = { ...plan, waitNoted: true } };
    const wants = plan.kind === 'celebrity' ? 'wants a top-floor suite' : 'wants a suite';
    const held = room ? ` ${roomName(room)} is held for them.${note}` : holdPolicy(current) === 'hold' ? ' Every suite is taken until after they come.' : '';
    const message = `A ${WHO[plan.kind]} arrives ${whenDue(plan)} and ${wants}.${held}`;
    current = log(current, plan, 'spotlight_announced', message, roomId);
    events.push({ type: 'spotlight_announced', message, data: { kind: plan.kind, roomId } });
  } else if (plan.status === 'announced' && current.hour === at && current.day === plan.arrivalDay - 1) { // (not on the day it was announced: that was the if)
    current = log(current, plan, 'spotlight_reminder', `The ${WHO[plan.kind]} arrives tomorrow at about ${String(plan.arrivalHour).padStart(2, '0')}:00.`, plan.roomId);
  }
  // The hold stays on a suite that will be free by then (another if this one won't be)
  if (plan.status === 'announced') {
    if (current.day > plan.arrivalDay) return { state: { ...current, spotlight: { ...plan, status: 'done' } }, events }; // (they never came)
    const roomId = pickHold(current, plan);
    const kept = roomId === plan.roomId ? current.rooms.find(r => r.id === roomId) : undefined;
    const here = hourEnd(current) > arrivalTime(plan); // (they've come: waiting for it)
    if (kept && !plan.waitNoted && kept.status !== 'occupied') {
      // The hold's slipped past their hour: said once (the estimate can swing back and forth), once its guest's gone
      // (while they're still in it, the estimate swings by more than the margin), and only once it's clearly past it
      // (waitMargin)
      const note = waitFor(current, plan, kept, here, waitMargin(current, plan));
      if (note) {
        plan = { ...plan, waitNoted: true };
        current = log({ ...current, spotlight: plan }, plan, 'spotlight_hold', `${roomName(kept)}, held for the ${WHO[plan.kind]}, ${here ? "isn't ready yet" : "won't be ready when they come"}.${note}`, kept.id);
      }
    }
    if (roomId !== plan.roomId) {
      const wasId = plan.roomId;
      const was = current.rooms.find(r => r.id === wasId);
      const moved = current.rooms.find(r => r.id === roomId);
      const { roomId: _was, waitNoted: _noted, ...rest } = plan;
      plan = { ...rest, ...(roomId ? { roomId } : {}), chosen: false };
      current = { ...current, spotlight: plan };
      const note = moved ? waitFor(current, plan, moved, here, waitMargin(current, plan)) : '';
      if (note) current = { ...current, spotlight: plan = { ...plan, waitNoted: true } };
      if (moved) current = log(current, plan, 'spotlight_hold', `${was ? `The suite held for the ${WHO[plan.kind]} is now ${roomName(moved)}` : `${roomName(moved)} is now held for the ${WHO[plan.kind]}`}.${note}`, moved.id);
      else if (holdPolicy(current) === 'hold') {
        const late = was && here; // (they're here, waiting for it)
        current = log(current, plan, 'spotlight_hold', late
          ? `${roomName(was)} won't be ready for the ${WHO[plan.kind]} today after all: they'll take the best room free.`
          : `No suite will be free for the ${WHO[plan.kind]} by then: they'll take the best suite free when they come, or the best room.`);
      }
    }
  }
  return { state: current, events };
}

/** Who the spotlight guest is: from the plan, by hashes (a fixed temperament: the writer even-handed and vocal, the celebrity a big spender who keeps the door shut). */
export function spotlightGuest(plan: SpotlightPlan, day: number): Guest {
  const id = plan.salt ? `spotlight-${plan.arrivalDay}-${Math.floor(hash01(plan.salt) * 46656).toString(36)}` : `spotlight-${plan.arrivalDay}`;
  const writer = plan.kind === 'writer';
  const party = PARTY[plan.kind];
  const purpose: Purpose = writer ? 'getaway' : 'sightseeing';
  const trait: GuestTrait = writer ? 'normal' : 'big_spender';
  const base = rollProfile(id, party, GUEST_PURPOSES.enabled ? purpose : undefined, trait)!;
  const keep = <K extends keyof GuestProfile>(key: K, value: NonNullable<GuestProfile[K]>) => (base[key] !== undefined ? { [key]: value } : {});
  const profile: GuestProfile = writer
    ? {
      ...base, chronotype: 'regular', checkoutHour: ECONOMY.checkOutHour, sleep: 'normal', rowdiness: 'normal',
      ...keep('favorite', 'none'), ...keep('housekeeping', 'standard'), ...keep('patience', 'normal'), ...keep('voice', 'vocal'), ...keep('spending', 'standard'),
    }
    : {
      ...base, sleep: 'normal', rowdiness: 'normal',
      ...keep('favorite', 'none'), ...keep('housekeeping', 'dnd'), ...keep('patience', 'patient'), ...keep('voice', 'typical'), ...keep('spending', 'splurger'),
    };
  return {
    id, name: `${GUEST_NAMES[Math.floor(hash01(`${id}#name`) * GUEST_NAMES.length)]} ${surnameOf(id)}`,
    budget: Number.MAX_SAFE_INTEGER, stayLength: SPOTLIGHT.nights, trait,
    satisfaction: SATISFACTION.initial, checkInDay: day, isReturning: false, hadNoiseComplaint: false,
    party, ...(GUEST_PURPOSES.enabled ? { purpose } : {}), profile, spotlight: { kind: plan.kind },
  };
}

/**
 * The spotlight guest arriving this hour (decided at the boundary before the
 * hour they walk in), and the room they take: the held suite; if it's still
 * being got ready (in time for the last check-in), they wait for it, unless
 * another suite free now suits them as well; with no hold, the best suite free.
 * With no suite free, they wait (hour by hour) while one will be ready by the
 * last check-in, and at the last check-in hour take the best room free, or
 * none (they go elsewhere). Null: not this hour.
 */
export function spotlightArrival(state: HotelState, hour: number, available: Room[]): { guest: Guest; room: Room | null; noDesk?: boolean } | null {
  const plan = spotlightOn() ? state.spotlight : undefined;
  if (!plan || plan.status !== 'announced' || state.day !== plan.arrivalDay || hour + 1 < plan.arrivalHour) return null;
  const guest = spotlightGuest(plan, state.day);
  const usable = available.filter(r => fitsParty(profileRoom(r), guest.party!));
  const last = hour >= ECONOMY.checkInEndHour - 1;
  const byLast = lastCheckIn(plan); // (ready for the last check-in)
  const best = bestOf(usable.filter(isSuite), rankFor(plan));
  let suite = usable.find(r => r.id === plan.roomId) ?? null;
  if (!suite) {
    const held = state.rooms.find(r => r.id === plan.roomId);
    const asGood = best && held && !above(rankFor(plan)(held), rankFor(plan)(best));
    if (held && !last && !asGood && freeBy(state, held, byLast)) return null; // (the held suite's nearly ready: they wait)
    suite = best;
  }
  // No suite free: worth waiting for one being got ready (if it will be by the last check-in; not one with a refit
  // booked and not held: it starts once the suite's empty)
  if (!suite && !last && state.rooms.some(r => !usable.includes(r) && !(r.pendingRefit && !heldNow(state, r.id)) && freeBy(state, r, byLast))) return null;
  const room = suite ?? bestOf(usable, r => [TYPE_RANK[profileRoom(r).type] ?? 0, r.floor, quality(r)]);
  if (!room && !last) return null; // nothing free yet: they wait
  const rate = plan.kind === 'celebrity' && room && isSuite(room) && room.floor === topFloor(state) ? SPOTLIGHT.celebrity.rateMult : undefined;
  return { guest: { ...guest, spotlight: { kind: plan.kind, ...(rate ? { rate } : {}) } }, room };
}

/** The plan once the spotlight guest has checked in (or found nothing and gone elsewhere). */
export function spotlightCheckedIn(state: HotelState, guest: Guest, room: Room | null, noDesk = false): { state: HotelState; events: GameEvent[] } {
  const plan = state.spotlight!;
  if (!room) {
    const message = `The ${WHO[plan.kind]}, ${guest.name}, ${noDesk ? 'found nobody at the front desk' : 'found no room free'} and went elsewhere.`;
    return { state: { ...log(state, plan, 'spotlight_no_room', message), spotlight: { ...plan, status: 'done' } }, events: [{ type: 'spotlight_arrived', message, data: { kind: plan.kind } }] };
  }
  const type = profileRoom(room).type;
  const held = plan.roomId && plan.roomId !== room.id ? state.rooms.find(r => r.id === plan.roomId) : undefined;
  const instead = held ? ` (${roomName(held)}, held for them, wasn't ready)` : '';
  const message = `${guest.name}, the ${WHO[plan.kind]}, checked in to ${roomName(room)}${type === 'suite' ? '' : ` (a ${type} room: no suite was free)`}${instead}${guest.spotlight?.rate ? ': the top floor, paying double' : ''}.`;
  return {
    state: { ...log(state, plan, 'spotlight_arrived', message, room.id), spotlight: { ...plan, status: 'staying', guestId: guest.id, roomId: room.id } },
    events: [{ type: 'spotlight_arrived', message, data: { kind: plan.kind, guestId: guest.id, roomId: room.id } }],
  };
}

/** The stars a guest judges the hotel at: a travel writer one more than it has. */
export function judgedStars(guest: Pick<Guest, 'spotlight'>, stars: number): number {
  return spotlightOn() && guest.spotlight?.kind === 'writer' ? stars + 1 : stars;
}

/** How hard a guest judging at these stars minds what's wrong (above five stars, the writer's own standard). */
export function expectationAt(stars: number): number {
  return stars > 5 ? SPOTLIGHT.writer.expectationAbove5 : STAR_RATING.expectationMultiplier[stars] ?? 1.0;
}

/** The amenities a hotel of these stars must have (the highest rule that applies). */
export function amenityRuleAt(stars: number): { minStars: number; minimumTier: string; penaltyIfBelow: number } | null {
  return [...AMENITIES.starExpectations].reverse().find(r => Math.min(5, stars) >= r.minStars) ?? null;
}

const FAULTS = { noise: 'noisy nights', decor: 'tired decor', lifts: 'slow lifts', condition: 'a room in need of repair', cleanliness: 'a grubby room', amenities: 'basic amenities', price: 'the prices' };

/** What a review praised and faulted most, in words, from its breakdown (null: nothing stood out, or nothing to fault). Price is never praise. */
export function nameReview(b: GuestReviewBreakdown, guest: Pick<Guest, 'facilitiesUsed'>): { best: string | null; worst: string | null } {
  const felt = b.expectation ?? 1; // (what's wrong with the room, weighed as hard as they mind it; the price and the fit as they are)
  const faults: Array<[string, number]> = [
    [FAULTS.noise, b.noisePenalty * felt], [FAULTS.decor, b.decorPenalty * felt], [FAULTS.lifts, b.elevatorPenalty * felt],
    [FAULTS.condition, Math.max(0, -b.conditionBonus) * felt], [FAULTS.cleanliness, Math.max(0, -b.cleanlinessBonus) * felt],
    [FAULTS.amenities, b.amenityPenalty * felt], [FAULTS.price, (1 - b.priceFairness) * REVIEW.basePriceFairnessWeight],
    [b.roomDislikes?.[0] ? FEATURE_LABELS[b.roomDislikes[0]] : 'the room', Math.max(0, -b.roomFit)],
    [b.favoriteMissLabel ?? 'the facilities', b.favoriteMiss ?? 0],
  ];
  const used = (Object.keys(guest.facilitiesUsed ?? {}) as FacilityType[]).filter(t => FACILITY_CONFIG[t]);
  const favourite = used.sort((x, y) => FACILITY_CONFIG[y].visitReviewBonus - FACILITY_CONFIG[x].visitReviewBonus || (x < y ? -1 : 1))[0];
  const praise: Array<[string, number]> = [
    ['the amenities', b.amenityBonus], [favourite ? `the ${FACILITY_CONFIG[favourite].label.toLowerCase()}` : 'the facilities', b.facilityBonus],
    ['a room in perfect repair', Math.max(0, b.conditionBonus)], ['a spotless room', Math.max(0, b.cleanlinessBonus)],
    [b.roomLikes?.[0] ? FEATURE_LABELS[b.roomLikes[0]] : 'the room', Math.max(0, b.roomFit)],
  ];
  const top = (xs: Array<[string, number]>, floor: number) => {
    const w = xs.reduce((a, x) => (x[1] > a[1] ? x : a), ['', -Infinity] as [string, number]);
    return w[1] >= floor ? w[0] : null;
  };
  return { best: top(praise, SPOTLIGHT.praiseFloor), worst: top(faults, SPOTLIGHT.faultFloor) };
}

/** What a departing guest paid: as the tick says (the bill and any late-checkout fee, or a walkout's settlement), else the room's rate for the stay. */
const paidBy = (d: { guest?: Guest; booking: { nightRate: number }; paid?: number }) => d.paid ?? d.booking.nightRate * (d.guest?.stayLength ?? 0);

/** " (double, for the top floor)", " (double for 1 night on the top floor)", or nothing. */
function doubled(guest: Pick<Guest, 'spotlight' | 'checkInDay' | 'stayLength'>): string {
  const n = doubleNights(guest);
  return n === 0 ? '' : n === guest.stayLength ? ' (double, for the top floor)' : ` (double for ${n} night${n === 1 ? '' : 's'} on the top floor)`;
}

/** "two days", "a day". */
const forHours = (hours: number) => (hours === 24 ? 'a day' : hours % 24 === 0 ? `${hours / 24 === 2 ? 'two' : hours / 24} days` : `${hours} hours`);

/**
 * The spotlight guest checking out (call in the tick with the hour's
 * departures, before the day's bad review is looked for): the writer's review
 * is out -- 8.5 or more, a glowing write-up and more bookings for a while; 4
 * or less, it spreads as a bad review always does; either way naming what they
 * loved and minded -- or the celebrity has gone (and what they paid).
 */
export function recordSpotlightOutcome(state: HotelState, departures: Array<{ guest?: Guest; booking: { id: string; reviewScore: number; nightRate: number }; breakdown: GuestReviewBreakdown; roomId: string; paid?: number }>): { state: HotelState; events: GameEvent[] } {
  const plan = spotlightOn() ? state.spotlight : undefined;
  if (!plan || plan.status !== 'staying') return { state, events: [] };
  const d = departures.find(x => x.guest?.id === plan.guestId);
  if (!d) {
    // Gone without a review (it shouldn't happen): the plan's over
    return state.guests.some(g => g.id === plan.guestId) ? { state, events: [] } : { state: { ...state, spotlight: { ...plan, status: 'done' } }, events: [] };
  }
  const guest = d.guest!;
  const score = d.booking.reviewScore;
  const walkedOut = d.booking.id.startsWith('booking-walkout-'); // (an incident: they left early)
  const { best, worst } = nameReview(d.breakdown, guest);
  const what = `${best ? `loved ${best}` : 'nothing stood out'}; ${worst ? `minded ${worst}` : 'nothing to fault'}`;
  let current = state;
  let message: string;
  let outcome: SpotlightPlan['outcome'];
  if (plan.kind === 'writer') {
    const { writeUpAt, panAt, writeUpMult, writeUpHours } = SPOTLIGHT.writer;
    if (score >= writeUpAt) {
      outcome = 'write_up';
      message = `${guest.name}'s write-up is out (${score.toFixed(1)}/10): ${what}. Bookings up ${Math.round((writeUpMult - 1) * 100)}% for ${forHours(writeUpHours)}.`;
      current = { ...current, activeReputationPenalties: [...current.activeReputationPenalties, { multiplier: writeUpMult, hoursRemaining: writeUpHours, kind: 'write_up' }] };
      current = log(current, plan, 'write_up', message, d.roomId);
    } else if (score <= panAt) {
      // A bad review from a writer always spreads (whatever the day's stories so far), and is the day's one: on a
      // day one already has, it keeps that one going (as long again), no deeper
      outcome = 'pan';
      const pct = Math.round((1 - STORY.reviewSemiViralPenaltyMultiplier) * 100);
      const spreading = current.storyLog.some(e => (e.type === 'review_semi_viral' || e.type === 'spotlight_pan') && e.day === current.day);
      const last = current.activeReputationPenalties.map(p => p.kind).lastIndexOf(undefined);
      if (spreading && last >= 0) {
        message = `${guest.name}'s review is out (${score.toFixed(1)}/10): ${what}. With today's other bad review, bookings stay down ${pct}% for ${forHours(STORY.reviewSemiViralPenaltyHours)}.`;
        current = { ...current, activeReputationPenalties: current.activeReputationPenalties.map((p, i) => (i === last ? { ...p, hoursRemaining: Math.max(p.hoursRemaining, STORY.reviewSemiViralPenaltyHours) } : p)) };
      } else {
        message = `${guest.name}'s review is out (${score.toFixed(1)}/10): ${what}. It's spreading: bookings down ${pct}% for ${forHours(STORY.reviewSemiViralPenaltyHours)}.`;
        const kept = STORY.reviewSemiViralStacks ? current.activeReputationPenalties : current.activeReputationPenalties.filter(p => p.kind === 'write_up');
        current = { ...current, activeReputationPenalties: [...kept, { multiplier: STORY.reviewSemiViralPenaltyMultiplier, hoursRemaining: STORY.reviewSemiViralPenaltyHours }] };
      }
      current = log(current, plan, 'spotlight_pan', message, d.roomId);
    } else {
      outcome = 'review';
      message = `${guest.name}'s review is out (${score.toFixed(1)}/10): ${what}.`;
      current = log(current, plan, 'spotlight_review', message, d.roomId);
    }
  } else {
    outcome = 'review';
    const paid = Math.round(paidBy(d));
    message = walkedOut
      ? `${guest.name}, the celebrity, checked out early ($${paid.toLocaleString('en-US')}), with a ${score.toFixed(1)}/10 review.`
      : `${guest.name}, the celebrity, checked out: $${paid.toLocaleString('en-US')}${doubled(guest)}, and a ${score.toFixed(1)}/10 review.`;
    current = log(current, plan, 'spotlight_review', message, d.roomId);
  }
  return {
    state: { ...current, spotlight: { ...plan, status: 'done', outcome } },
    events: [{ type: 'spotlight_review', message, data: { kind: plan.kind, score, outcome, roomId: d.roomId, paid: paidBy(d) } }],
  };
}

/** For a spotlight guest's card: who they are, and what their stay means for the hotel. */
export function describeSpotlight(guest: Guest, state: HotelState): string[] {
  if (!spotlightOn() || !guest.spotlight) return [];
  if (guest.spotlight.kind === 'writer') {
    const judged = judgedStars(guest, state.starRating);
    const open = getOpenFacilities(state);
    const left = TOUR_TYPES.filter(t => open.some(f => f.type === t) && !guest.facilitiesUsed?.[t]);
    const tried = left.length === 0 ? 'has tried everything here' : `yet to try: ${left.map(t => `the ${FACILITY_CONFIG[t].label.toLowerCase()}`).join(', ')}`;
    const { writeUpAt, panAt, writeUpMult, writeUpHours, bookingWeight } = SPOTLIGHT.writer;
    return [
      `Travel writer: judges the hotel as a ${Math.min(judged, 6)}-star one${SPOTLIGHT.writer.parAmenities ? ' (and takes its amenities for granted)' : ''}; their review counts ${bookingWeight} times over`,
      `${writeUpAt}+ and bookings rise ${Math.round((writeUpMult - 1) * 100)}% for ${forHours(writeUpHours)}; ${panAt} or less and it spreads${open.length > 0 ? `; ${tried}` : ''}`,
    ];
  }
  const dnd = housekeepingPrefOf(guest) === 'dnd';
  return [
    `Celebrity: ${celebrityPays(guest)}`,
    `${dnd ? 'Keeps the door shut; d' : 'D'}raws ${Math.round((SPOTLIGHT.celebrity.walkInMult - 1) * 100)}% more walk-ins the day they come`,
  ];
}

const TOUR_TYPES: FacilityType[] = ['restaurant', 'pool', 'gym', 'shop'];

/** "paying double for a top-floor suite", "paying double for 1 night on the top floor (moved since)", "paying the usual price (moved off the top floor)". */
function celebrityPays(guest: Guest): string {
  const rate = guest.spotlight?.rate;
  if (!rate) return 'paying the usual price';
  const times = rate === 2 ? 'double' : `x${rate}`;
  if (guest.spotlight!.until === undefined) return `paying ${times} for a top-floor suite`;
  const n = doubleNights(guest);
  return n === 0 ? 'paying the usual price (moved off the top floor)' : `paying ${times} for ${n} night${n === 1 ? '' : 's'} on the top floor (moved since)`;
}

/** A celebrity's nights at double: all of them, or those before they were moved off the top floor (none without the rate). */
export function doubleNights(guest: Pick<Guest, 'spotlight' | 'checkInDay' | 'stayLength'>): number {
  if (!guest.spotlight?.rate) return 0;
  return guest.spotlight.until === undefined ? guest.stayLength : Math.max(0, Math.min(guest.stayLength, guest.spotlight.until - guest.checkInDay));
}

/** What a spotlight guest walking out pays for the nights stayed, and gets back on the rest: each night at its own rate. */
export function spotlightSettlement(guest: Pick<Guest, 'spotlight' | 'checkInDay' | 'stayLength'>, price: number, daysStayed: number, nightsRemaining: number): { revenue: number; comp: number; cashDelta: number } {
  const rate = guest.spotlight?.rate ?? 1;
  const double = doubleNights(guest);
  const revenue = price * (daysStayed + (rate - 1) * Math.min(daysStayed, double));
  const comp = ECONOMY.earlyDepartureRefundRate * price * (nightsRemaining + (rate - 1) * Math.max(0, Math.min(nightsRemaining, double - daysStayed)));
  return { revenue, comp, cashDelta: revenue - comp };
}

/**
 * What a guest pays a night, averaged over their stay: the room's price, or
 * for a celebrity in a top-floor suite double it (for the nights before they
 * were moved off the top floor, if they were).
 */
export function spotlightNightRate(guest: Pick<Guest, 'spotlight' | 'checkInDay' | 'stayLength'>, price: number): number {
  const rate = spotlightOn() ? guest.spotlight?.rate : undefined;
  if (!rate) return price;
  return price * (1 + (rate - 1) * doubleNights(guest) / guest.stayLength);
}

/** A celebrity in the hotel on the day they came: a few more walk-ins (1 otherwise). */
export function celebrityPull(state: HotelState): number {
  const plan = spotlightOn() ? state.spotlight : undefined;
  if (!plan || plan.kind !== 'celebrity' || plan.status !== 'staying' || state.day !== plan.arrivalDay) return 1;
  return state.guests.some(g => g.id === plan.guestId) ? SPOTLIGHT.celebrity.walkInMult : 1;
}

/** The write-ups' boost to arrivals now (1: none). */
export function writeUpMultiplier(state: Pick<HotelState, 'activeReputationPenalties'>): number {
  if (!spotlightOn()) return 1;
  return state.activeReputationPenalties.reduce((m, p) => (p.kind === 'write_up' ? m * p.multiplier : m), 1);
}

/** For the top bar: the spotlight guest due ("Travel writer due Friday ~15:00, in 1 day 6 hours") or staying, and what's moving arrivals now. */
export function spotlightBanner(state: HotelState, t: number): string[] {
  if (!spotlightOn()) return [];
  const out: string[] = [];
  const plan = state.spotlight;
  const who = plan ? (plan.kind === 'writer' ? '✎ Travel writer' : '★ Celebrity') : '';
  if (plan?.status === 'announced') {
    const left = Math.max(0, arrivalTime(plan) - t);
    const days = Math.floor(left / 24);
    const hours = Math.floor(left % 24);
    const due = left <= 0 ? 'now' : left < 1 ? 'in under an hour' : `in ${days > 0 ? `${days}d ` : ''}${hours}h`;
    out.push(`${who} due ${shortWhen(plan)} (${due})`);
  } else if (plan?.status === 'staying') {
    const room = state.rooms.find(r => r.guestId === plan.guestId && r.status === 'occupied'); // (where they are now: moved, if a room broke)
    out.push(`${who} staying${room ? ` in ${formatRoomLabel(room.gridX, room.gridY, room.floor)}` : ''}`);
  }
  for (const p of state.activeReputationPenalties) {
    const pct = Math.round(Math.abs(p.multiplier - 1) * 100);
    out.push(p.kind === 'write_up' ? `Write-up: bookings +${pct}% (${p.hoursRemaining}h)` : `Bad review spreading: bookings −${pct}% (${p.hoursRemaining}h)`);
  }
  if (celebrityPull(state) !== 1) out.push(`Celebrity in: walk-ins +${Math.round((SPOTLIGHT.celebrity.walkInMult - 1) * 100)}% today`);
  return out;
}
