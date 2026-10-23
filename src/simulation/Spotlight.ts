import type { FacilityType, GameEvent, Guest, GuestProfile, GuestTrait, HotelState, Party, Purpose, Room, SpotlightHold, SpotlightKind, SpotlightPlan, StaffMember } from './types.js';
import { staffRate, attendance, nextStaffWork, staffDutyAt } from './StaffProfiles.js';
import { SPOTLIGHT, GUEST_PROFILE, GUEST_PURPOSES, GUEST_NAMES, ECONOMY, SATISFACTION, FACILITY_CONFIG, STAR_RATING, AMENITIES, REVIEW, STORY, STAFF, HOUSEKEEPING, TRAVEL } from '../config/balance.js';
import { STAFF_FATIGUE, STAFF_PERSONALITIES } from '../config/staff.js';
import { fatigueOn, fatigueAt, fatigueGain, projectFatigue, planStaffRest, restReservations, type RestReservation } from './StaffFatigue.js';
import { hash01, hourEnd, makeStay, finalTile, sameTile } from './Movement.js';
import { roomTile } from './GuestMovement.js';
import { getDayOfWeek } from './SeasonManager.js';
import { appendStoryLogEntry } from './StoryGenerator.js';
import { profileRoom, fitsParty, isBookable } from './RoomProfile.js';
import { isRoomReachable, formatRoomLabel } from './HotelState.js';
import { rollProfile, checkoutHour } from './Profile.js';
import { isCheckoutDay } from './GuestManager.js';
import { baseWalkHours } from './HousekeepingManager.js';
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

/**
 * Whether a suite will be free for the spotlight guest by the time they come:
 * a reachable suite their party fits, in working order, vacant now, being
 * cleaned (with a day to spare, or a clean short enough), renovating but done
 * by then (a refit doesn't mend a broken room), or with a guest who leaves
 * before the day.
 */
export function freeBy(state: HotelState, room: Room, plan: Pick<SpotlightPlan, 'kind' | 'arrivalDay' | 'arrivalHour'>, between = false): boolean {
  if (!isSuite(room) || !isBookable(room) || !fitsParty(profileRoom(room), PARTY[plan.kind]) || !isRoomReachable(state, room)) return false;
  if (room.status === 'renovating') return (!room.refitting || room.condition > ECONOMY.roomBreakdownThreshold) && hourEnd(state) + room.renovationHoursRemaining <= arrivalTime(plan);
  if (room.condition <= ECONOMY.roomBreakdownThreshold) return false;
  if (room.status === 'vacant') return true;
  if (room.status === 'cleaning') return cleanedAt(state, room, between) <= arrivalTime(plan);
  // Its guest leaves before the day, and the turnover after them is done in time
  const guest = state.guests.find(g => g.id === room.guestId);
  return !!guest && guest.checkInDay + guest.stayLength < plan.arrivalDay && cleanedAt(state, room, between) <= arrivalTime(plan);
}

/** The next moment from t the housekeepers are at work (absolute hours). */
function atWork(t: number, member?: StaffMember): number {
  if (member) return nextStaffWork(member, t);
  const start = Math.floor(t / 24) * 24 + STAFF.housekeeping.workStartHour;
  const end = Math.floor(t / 24) * 24 + STAFF.housekeeping.workEndHour;
  return t < start ? start : t >= end ? start + 24 : t;
}

/** Time t plus hours of housekeeping, counted in the housekeepers' shift hours (absolute hours). */
function inShift(t: number, hours: number, member?: StaffMember): number {
  let at = t;
  let work = hours;
  for (let days = 0; days < 60 && work > 1e-9; days++) {
    const a = member ? attendance(member, Math.floor(at / 24) + 1) : { absent: false, lateHours: 0 };
    if (a.absent) { at = Math.floor(at / 24) * 24 + 24; continue; }
    const start = Math.floor(at / 24) * 24 + STAFF.housekeeping.workStartHour + a.lateHours;
    const end = Math.floor(at / 24) * 24 + STAFF.housekeeping.workEndHour;
    if (at < start) at = start;
    if (at >= end) { at = Math.floor(at / 24) * 24 + 24; continue; }
    const step = Math.min(work, end - at);
    at += step;
    work -= step;
  }
  return work > 1e-9 ? Infinity : at;
}

/** A held suite must allow for the same tired rates, recovery and real breaks as its cleaning crew. */
function finishTurnover(state: HotelState, member: StaffMember | undefined, room: Room, from: number, units: number, walk: number, reservations: RestReservation[]): { done: number; member?: StaffMember } {
  if (!Number.isFinite(from)) return { done: Infinity, member };
  if (!member || !fatigueOn()) return { done: inShift(from, units / (member ? staffRate(member) : 1) + walk, member), member };
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
    if (!back) return { done: Infinity, member };
    walk = Math.max(walk, back.hours);
  }
  // Keep the existing conservative base-to-room transfer estimate. Fatigue
  // follows its elapsed walking time, while overnight gaps recover normally.
  for (let guard = 0; walk > 1e-9 && guard < 120; guard++) {
    advance(atWork(at, member));
    const step = Math.min(walk, staffDutyAt(member, at).end - at);
    active(step); walk -= step;
  }
  if (walk > 1e-9) return { done: Infinity, member };
  const baseRate = staffRate({ ...member, stats: { ...member.stats!, fatigue: 0 } });
  for (let guard = 0; units > 1e-9 && guard < 2000; guard++) {
    if (at - from > 60 * 24) return { done: Infinity, member };
    advance(atWork(at, member));
    if (energy >= STAFF_FATIGUE.breakAt - 1e-9) {
      const rest = planStaffRest(state, member, pos, at, reservations);
      energy = projectFatigue(member, rest.legs, at, rest.until, energy);
      at = rest.until;
      const back = findRoute(state, rest.at, pos, TRAVEL.hoursPerTile);
      if (!back) return { done: Infinity, member };
      active(back.hours);
      continue;
    }
    const rate = baseRate * (energy >= STAFF_FATIGUE.tiredAt - 1e-9 ? STAFF_FATIGUE.tiredRate : 1);
    const threshold = energy < STAFF_FATIGUE.tiredAt - 1e-9 ? STAFF_FATIGUE.tiredAt : STAFF_FATIGUE.breakAt;
    const step = Math.min(units / rate, staffDutyAt(member, at).end - at, (threshold - energy) / fatigueGain(member));
    active(step); units -= step * rate;
  }
  if (units > 1e-9) return { done: Infinity, member };
  const hours = member.profile?.experience === 'rookie' ? 0 : STAFF_PERSONALITIES.experienceHours[member.profile?.experience ?? 'skilled'];
  return { done: at, member: { ...member, at: pos, fatigueBreak: undefined,
    stats: { workHours: member.stats?.workHours ?? hours, lateDays: 0, absentDays: 0, ...member.stats, fatigue: energy, fatigueAt: at } } };
}

/**
 * When a room being cleaned (or its guest's leaving, then cleaned) will be
 * done (absolute hours), as the housekeepers work it out hour by hour
 * (StaffManager.planStaff): each keeps at the room they're in; one who comes
 * free, at work, takes the best turnover waiting then (the fewest hours left,
 * ties to the earlier room; rooms they can't reach left out), walking to it
 * (a walk from base: they mostly go from one room to the next), and keeps at
 * it; a checkout's room joins when its guest leaves (up to tomorrow's, or this
 * room's guest's day); all in their shift hours, from the next hour (or this
 * one, between hours: before this hour's work is done). Never, with no
 * housekeepers.
 */
function cleanedAt(state: HotelState, room: Room, between: boolean): number {
  const staff = state.staff.housekeepers;
  if (staff <= 0) return Infinity;
  const t = between ? hourEnd(state) - 1 : hourEnd(state);
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
  if (!jobs.some(j => j.id === room.id)) return Infinity;
  const taken = new Set<string>();
  const free: number[] = [];
  const workers: Array<StaffMember | undefined> = [];
  const reservations = fatigueOn() ? restReservations(state) : [];
  // Each keeps at the room they're in (no walk to it)
  for (const m of (state.staffRoster ?? []).filter(x => x.role === 'housekeeper' && !x.leaving).slice(0, staff)) {
    const job = m.roomId ? jobs.find(j => j.id === m.roomId && !taken.has(j.id) && j.from <= t + 1e-9) : undefined; // (a turnover under way: not a daily clean)
    if (!job || attendance(m, Math.floor(t / 24) + 1).absent) { free.push(t); workers.push(m); continue; }
    taken.add(job.id);
    const result = finishTurnover(state, m, state.rooms.find(r => r.id === job.id) ?? room, t, job.hours, 0, reservations);
    if (job.id === room.id) return result.done;
    free.push(result.done);
    workers.push(result.member);
  }
  while (free.length < staff) { free.push(t); workers.push(undefined); }
  for (let guard = 0; guard < 2000; guard++) {
    for (let k = 0; k < free.length; k++) free[k] = atWork(free[k], workers[k]);
    const i = free.reduce((best, x, k) => (x < free[best] ? k : best), 0);
    const waiting = jobs.filter(j => !taken.has(j.id) && j.from <= free[i] + 1e-9);
    if (waiting.length === 0) {
      // Nothing yet: till the next guest leaves (this room's among them)
      free[i] = Math.min(...jobs.filter(j => !taken.has(j.id)).map(j => j.from));
      continue;
    }
    const job = waiting.reduce((best, j) => (j.hours < best.hours || (j.hours === best.hours && j.order < best.order) ? j : best));
    taken.add(job.id);
    const result = finishTurnover(state, workers[i], state.rooms.find(r => r.id === job.id) ?? room, free[i], job.hours, walk, reservations);
    if (job.id === room.id) return result.done;
    free[i] = result.done;
    workers[i] = result.member;
  }
  return Infinity;
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
 * the hold from a suite that's ready), else (if the hotel holds one) the best
 * that will be free; none once let go by hand.
 */
function pickHold(state: HotelState, plan: SpotlightPlan): string | undefined {
  if (plan.released) return undefined;
  const held = plan.roomId ? state.rooms.find(r => r.id === plan.roomId) : undefined;
  // Kept while it'll be ready for them by the last check-in (they wait for it); a celebrity's (not picked by hand)
  // moves up to a suite higher up that's ready: the top floor is the point
  if (held && freeBy(state, held, lastCheckIn(plan)) && (plan.chosen || holdPolicy(state) === 'hold')) {
    const higher = plan.kind === 'celebrity' && !plan.chosen ? bestOf(state.rooms.filter(r => r.floor > held.floor && r.status === 'vacant' && freeBy(state, r, plan)), rankFor(plan)) : null; // (ready now: never giving up a ready suite for one that might not be)
    return (higher ?? held).id;
  }
  if (holdPolicy(state) === 'none') return undefined;
  return bestOf(state.rooms.filter(r => freeBy(state, r, plan)), rankFor(plan))?.id;
}

/** The plan as if they came at the last check-in (what's ready for them by then). */
const lastCheckIn = <P extends Pick<SpotlightPlan, 'arrivalHour'>>(plan: P): P => ({ ...plan, arrivalHour: ECONOMY.checkInEndHour });

/** For a suite's card while a spotlight guest is announced: whether it's held for them, or could be (null: neither). */
export function holdFor(state: HotelState, room: Room): { held: boolean; who: string; when: string } | null {
  const plan = spotlightOn() ? state.spotlight : undefined;
  if (!plan || plan.status !== 'announced') return null;
  const held = plan.roomId === room.id;
  if (!held && !freeBy(state, room, plan, true)) return null;
  return { held, who: WHO[plan.kind], when: shortWhen(plan) };
}

/** Hold a suite for the announced spotlight guest by hand (null: it isn't a suite that will be free by then). */
export function holdSuite(state: HotelState, roomId: string): HotelState | null {
  const plan = spotlightOn() ? state.spotlight : undefined;
  const room = state.rooms.find(r => r.id === roomId);
  if (!plan || plan.status !== 'announced' || !room || !freeBy(state, room, plan, true)) return null;
  return { ...state, spotlight: { ...plan, roomId, chosen: true, released: false } };
}

/** Let the held suite go: it can be booked, and the spotlight guest takes the best suite free when they come. */
export function releaseHold(state: HotelState): HotelState | null {
  const plan = spotlightOn() ? state.spotlight : undefined;
  if (!plan || plan.status !== 'announced' || !plan.roomId) return null;
  const { roomId: _held, ...rest } = plan;
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

/** The suite held for the spotlight guest that a booking of this many nights may not take (they'd still be in it when the guest comes). */
export function heldFrom(state: HotelState, nights: number): string | null {
  const plan = spotlightOn() ? state.spotlight : undefined;
  if (!plan || plan.status !== 'announced' || !plan.roomId) return null;
  return state.day + nights >= plan.arrivalDay ? plan.roomId : null;
}

/** Whether a room is the suite held for an announced spotlight guest (a refit booked on it waits till they've been). */
export function heldNow(state: HotelState, roomId: string): boolean {
  const plan = spotlightOn() ? state.spotlight : undefined;
  return !!plan && plan.status === 'announced' && plan.roomId === roomId;
}

/** Whether renovating a room now would run past the spotlight guest's arrival in the suite held for them. */
export function holdBlocksRenovation(state: HotelState, roomId: string, hours: number): boolean {
  const plan = spotlightOn() ? state.spotlight : undefined;
  return !!plan && plan.status === 'announced' && plan.roomId === roomId && hourEnd(state) + hours > arrivalTime(plan);
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
    const roomId = pickHold(current, plan);
    plan = { ...plan, ...(roomId ? { roomId } : {}) };
    current = { ...current, spotlight: plan };
    const room = current.rooms.find(r => r.id === roomId);
    const wants = plan.kind === 'celebrity' ? 'wants a top-floor suite' : 'wants a suite';
    const held = room ? ` ${roomName(room)} is held for them.` : holdPolicy(current) === 'hold' ? ' Every suite is taken until after they come.' : '';
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
    if (roomId !== plan.roomId) {
      const wasId = plan.roomId;
      const was = current.rooms.find(r => r.id === wasId);
      const moved = current.rooms.find(r => r.id === roomId);
      const { roomId: _was, ...rest } = plan;
      plan = { ...rest, ...(roomId ? { roomId } : {}), chosen: false };
      current = { ...current, spotlight: plan };
      if (moved) current = log(current, plan, 'spotlight_hold', `The suite held for the ${WHO[plan.kind]} is now ${roomName(moved)}.`, moved.id);
      else if (holdPolicy(current) === 'hold') {
        const late = was && hourEnd(current) > arrivalTime(plan); // (they're here, waiting for it)
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
