import type { Fixture, GameEvent, Guest, HotelState, Leg, Patience, StayLeg, TilePos, Walker } from './types.js';
import { partyOf, PartyLabel } from './Party.js';
import { GUEST_PROFILE, PATIENCE, TRAVEL, VOICE } from '../config/balance.js';
import { checkInLanes } from './GuestMovement.js';
import { routeFromStreet } from './Layout.js';
import { hash01, makeStay, sameTile } from './Movement.js';
import { scheduledDeskLanes, type DeskDuty } from './FrontDesk.js';
import { namedFrontDesk } from './StaffProfiles.js';
import { serviceSnapshot, serviceMember, recordHospitality } from './StaffHospitality.js';
import { offerUpsell } from './StaffSpecialties.js';

// The front desk queue (docs/designs/guest-staff-personalities.md, Patience):
// each seated clerk is a lane, and what a lane is doing is read from people's
// legs -- every check-in and complaint at the counter is a stay that names its
// lane ("deskId:seat") -- so lane time carries across hours, through saves and
// reroutes, with nothing else to keep in step. The hour's arrivals reach the
// desk spread over the hour in the order they booked and are served first
// come, first served by the first free clerk. A guest whose wait would outlast
// their patience stands in line that long and walks out (judged as they join
// the line: one slowed after, by a clerk let go, keeps who's in it). Check-ins
// come first: a guest come down to complain is heard when a clerk is free of
// them (complaints in the order they got there), so a complaint never makes
// anyone checking in wait longer than they would have.

export interface Lane { desk: Fixture; seat: number; front: TilePos; key: string; duties?: DeskDuty[] }

/** A lane's key: the desk and the seat. */
export const laneKey = (deskId: string, seat: number) => `${deskId}:${seat}`;

/** The seat a lane key names. */
export const seatOf = (key: string) => Number(key.slice(key.lastIndexOf(':') + 1));

/** Whether the desk queue is on (it needs guest profiles: patience lives there). */
export function queueOn(state?: HotelState): boolean {
  return PATIENCE.enabled && GUEST_PROFILE.enabled || !!state && namedFrontDesk(state);
}

/** The check-in lanes, keyed. */
export function lanesOf(state: HotelState): Lane[] {
  if (namedFrontDesk(state)) return scheduledDeskLanes(state);
  return checkInLanes(state).map(l => ({ ...l, key: laneKey(l.desk.id, l.seat) }));
}

/** How long a guest waits in line (normal without a roll, or with the switch off). */
export function patienceOf(guest: { profile?: { patience?: Patience } }): Patience {
  return PATIENCE.enabled ? guest.profile?.patience ?? 'normal' : 'normal';
}

/** The longest a guest will wait in line, in hours. */
export function patienceHours(guest: { profile?: { patience?: Patience } }): number {
  return PATIENCE.hours[patienceOf(guest)];
}

/** Whether a stay takes a clerk's time: a check-in or a complaint, at a lane. */
export const isLaneService = (l: Leg): l is StayLeg & { lane: string } =>
  l.kind === 'stay' && (l.activity === 'check_in' || l.activity === 'complain') && l.lane !== undefined;

/**
 * Every lane's time already promised after t: the check-ins and complaints on
 * guests' trips, sorted. For check-ins (`checkIns`), complaints not yet under
 * way are left out: they'll be fitted in after (reseatLanes).
 */
export function laneBookings(state: Pick<HotelState, 'guests'>, t: number, skip?: ReadonlySet<string>, checkIns = false): Map<string, Array<[number, number]>> {
  const busy = new Map<string, Array<[number, number]>>();
  for (const g of state.guests) {
    if (skip?.has(g.id)) continue;
    for (const l of g.trip ?? []) {
      if (!isLaneService(l) || l.end <= t) continue;
      if (checkIns && l.activity === 'complain' && l.start > t) continue;
      busy.set(l.lane, [...(busy.get(l.lane) ?? []), [l.start, l.end]]);
    }
  }
  for (const list of busy.values()) list.sort((a, b) => a[0] - b[0]);
  return busy;
}

/** The earliest start at or after `from` with `hours` free between a lane's bookings. */
export function firstFree(busy: Array<[number, number]> | undefined, from: number, hours: number): number {
  let s = from;
  for (const [a, b] of busy ?? []) {
    if (b <= s + 1e-9) continue;
    if (a >= s + hours - 1e-9) break;
    s = b;
  }
  return s;
}

/** Book a stretch of a lane's time. */
export function book(busy: Map<string, Array<[number, number]>>, key: string, start: number, end: number): void {
  busy.set(key, [...(busy.get(key) ?? []), [start, end] as [number, number]].sort((a, b) => a[0] - b[0]));
}

/**
 * The lane that serves soonest someone who gets to its front at `arriveAt(lane)`
 * (null: can't get there) for `hours`: among the lanes `prefer` picks if any
 * does, else all; ties to the earlier lane.
 */
export function quoteLane(
  lanes: Lane[], busy: Map<string, Array<[number, number]>>, arriveAt: (lane: Lane) => number | null, hours: number, prefer?: (lane: Lane) => boolean, checkIn = false,
): { lane: Lane; arriveAt: number; start: number; hours: number; staffId?: string } | null {
  const pool = prefer && lanes.some(prefer) ? lanes.filter(prefer) : lanes;
  let best: { lane: Lane; arriveAt: number; start: number; hours: number; staffId?: string } | null = null;
  for (const lane of pool) {
    const a = arriveAt(lane);
    if (a === null) continue;
    const duties = lane.duties ?? [{ from: -Infinity, to: Infinity, checkInHours: hours, staffId: undefined }];
    for (const duty of duties) {
      const length = checkIn ? duty.checkInHours : hours / (('serviceRate' in duty ? duty.serviceRate : undefined) ?? 1);
      const start = firstFree(busy.get(lane.key), Math.max(a, duty.from), length);
      if ('startUntil' in duty && duty.startUntil !== undefined && start >= duty.startUntil - 1e-9) continue;
      if (start + length > duty.to + 1e-9) continue;
      if (!best || start < best.start - 1e-9 || Math.abs(start - best.start) < 1e-9 && length < best.hours - 1e-9) best = { lane, arriveAt: a, start, hours: length, staffId: duty.staffId };
      break;
    }
  }
  return best;
}

/** When someone reaches the desk for the service at `index` on their trip: the end of their last walk before it. */
export function readyAt(trip: Leg[], index: number): number {
  let ready = trip[0].start;
  for (let k = 0; k < index; k++) if (trip[k].kind === 'walk') ready = trip[k].end;
  return ready;
}

/**
 * When the hour's arrivals reach the desk: after the slowest walk in from the
 * street to the farthest lane (so nobody's walk starts before the hour they
 * were decided at), and never before the last hour's last arrival (so one
 * hour's arrivals never get in ahead of the last hour's, even with a desk
 * nearer the street now), then spread over the hour in the order they booked,
 * guest i of n at a hashed moment in their own slice.
 */
export function deskArrivalTimes(state: HotelState, lanes: Lane[], T: number): (id: string, i: number, n: number) => number {
  const slowest = GUEST_PROFILE.enabled ? GUEST_PROFILE.pace.limited : TRAVEL.guestHoursPerTile;
  const D = Math.max(0, ...lanes.map(l => routeFromStreet(state, l.front, slowest)?.hours ?? 0));
  let from = T + D;
  for (const g of state.guests) {
    const k = g.trip?.findIndex(l => l.kind === 'stay' && l.activity === 'check_in' && l.lane !== undefined && l.start >= T) ?? -1;
    if (k >= 0) from = Math.max(from, readyAt(g.trip!, k));
  }
  return (id, i, n) => from + PATIENCE.arrivalSpread * (i + hash01(`${id}#arrive`)) / Math.max(1, n);
}

/** Where someone in line or at the counter is in it at time t: their lane, and whether they're being served. */
export function laneStayAt(legs: Leg[], t: number): (StayLeg & { lane: string }) | null {
  for (const l of legs) {
    if (l.kind === 'stay' && l.lane !== undefined && l.start <= t && t < l.end) return l as StayLeg & { lane: string };
  }
  return null;
}

/** How far through their patience someone standing in line is at time t (0-1; null if they're not in a line). */
export function patienceUsed(who: Pick<Guest, 'profile'> | Pick<Walker, 'profile'>, legs: Leg[], t: number): number | null {
  const stay = laneStayAt(legs, t);
  if (!stay || stay.activity !== 'wait') return null;
  return Math.min(1, (t - stay.start) / patienceHours(who));
}

/** Today's front desk counters (a fresh set on a new day). */
export function deskToday(state: Pick<HotelState, 'day' | 'deskToday'>): NonNullable<HotelState['deskToday']> {
  return state.deskToday?.day === state.day ? state.deskToday : { day: state.day, checkedIn: 0, waitHours: 0, longestWait: 0, gaveUp: 0, complaints: 0 };
}

/** "12 minutes", "an hour". */
export function describeWait(hours: number): string {
  const minutes = Math.max(1, Math.round(hours * 60));
  return minutes >= 60 && minutes % 60 === 0 ? (minutes === 60 ? 'an hour' : `${minutes / 60} hours`) : `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * The hour's give-ups, as they walk out of the line (call in the tick, T the
 * end of the hour): a toast for each ("Omar gave up after 18 minutes in
 * line"), counted for the Staff panel. They were decided, and counted as
 * turned away, when they came in.
 */
export function recordGiveUps(state: HotelState, T: number): { state: HotelState; events: GameEvent[] } {
  if (!queueOn(state)) return { state, events: [] };
  const events: GameEvent[] = [];
  for (const w of state.walkers ?? []) {
    if (w.reason !== 'impatient') continue;
    const line = w.trip.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.lane !== undefined);
    if (!line || line.end <= T - 1 + 1e-9 || line.end > T + 1e-9) continue;
    const party = partyOf(w);
    const who = party.size > 2 ? PartyLabel({ id: w.id, name: w.name ?? 'A guest', party }) : w.name ?? 'A guest';
    events.push({
      type: 'guest_impatient',
      message: `${who} gave up after ${describeWait(line.end - line.start)} in line`,
      data: { reason: 'queue', partyKind: party.kind, size: party.size, waited: line.end - line.start, ...(w.wanted ? { wanted: w.wanted } : {}) },
    });
  }
  if (events.length === 0) return { state, events };
  const today = deskToday(state);
  return { state: { ...state, deskToday: { ...today, gaveUp: today.gaveUp + events.length } }, events };
}

/**
 * The hour's check-ins, as they reach the counter (call in the tick, T the end
 * of the hour): how long they stood in line, a little off their mood for a
 * long wait (in proportion to their patience), and the day's counts.
 */
export function creditCheckIns(state: HotelState, T: number): HotelState {
  if (!queueOn(state)) return state;
  let today = deskToday(state);
  let changed = false;
  const encounters: Array<{ guestId: string; stay: StayLeg }> = [];
  const guests = state.guests.map(g => {
    if (g.tripKind !== 'arrival' || !g.trip || g.checkInWait !== undefined) return g; // (one check-in a stay)
    const i = g.trip.findIndex(l => l.kind === 'stay' && l.activity === 'check_in' && l.lane !== undefined && !l.credited && l.start < T);
    if (i < 0) return g;
    const stay = g.trip[i] as StayLeg;
    const before = g.trip[i - 1];
    const joined = before && before.kind === 'stay' && before.activity === 'wait' && before.lane === stay.lane ? before.start : stay.start;
    const waited = stay.start - joined;
    const minded = Math.max(0, waited - PATIENCE.waitGrace);
    const loss = PATIENCE.enabled && GUEST_PROFILE.enabled ? PATIENCE.waitMood * Math.min(1, minded / patienceHours(g)) : 0;
    today = { ...today, checkedIn: today.checkedIn + 1, waitHours: today.waitHours + waited, longestWait: Math.max(today.longestWait, waited) };
    changed = true;
    const trip = g.trip.map((l, k) => (k === i ? { ...l, credited: true } : l));
    const next = { ...g, trip, checkInWait: waited, satisfaction: Math.max(0, g.satisfaction - loss) };
    const member = serviceMember(state, stay);
    encounters.push({ guestId: g.id, stay });
    return member ? recordHospitality(next, member, 'check_in', stay.start) : next;
  });
  let current = changed ? { ...state, guests, deskToday: today } : state;
  for (const { guestId, stay } of encounters) {
    const member = serviceMember(current, stay);
    if (member) current = offerUpsell(current, guestId, member, stay, T);
  }
  return current;
}

/** Legs moved later (or earlier) by `delta` hours: walks keep their paths. */
function shiftLegs(legs: Leg[], delta: number): Leg[] {
  if (Math.abs(delta) < 1e-12) return legs;
  return legs.map(l => (l.kind === 'walk' ? { ...l, start: l.start + delta, end: l.end + delta } : { ...l, start: l.start + delta, end: l.end + delta }));
}

/**
 * Everyone not yet at the counter seated again on the clerks there now, from
 * time t: after the front desk or the building changes mid-hour (a clerk hired
 * or let go, a desk built, a guest's way in rerouted), and whenever check-ins
 * or complaints are booked. Check-ins first, in the order they reach the desk,
 * then complaints, in theirs: a new clerk takes the head of the line at once,
 * a fired one's line joins the others' at that desk, nobody checking in is
 * served before someone who got there first, and nobody is served before t
 * (time already spent in line stays a wait). Someone whose clerk went
 * mid-service is done (they walk on); someone whose desk has no clerk left
 * goes on without (as before the queue).
 */
export function reseatLanes(state: HotelState, t: number): HotelState {
  if (!queueOn(state)) return state;
  const lanes = lanesOf(state);
  const live = new Set(lanes.map(l => l.key));
  const busy = new Map<string, Array<[number, number]>>();
  type Seat = { guestId: string; index: number; ready: number; complaint: boolean };
  const movable: Seat[] = [];
  let guests = state.guests;
  let changed = false;
  guests = guests.map(g => {
    const trip = g.trip;
    if (!trip) return g;
    const index = trip.findIndex(l => isLaneService(l) && l.end > t);
    if (index < 0) return g;
    const stay = trip[index] as StayLeg & { lane: string };
    if (stay.start < t - 1e-9) {
      const lane = lanes.find(l => l.key === stay.lane);
      const duty = lane?.duties?.find(d => (stay.serviceStaffId === undefined || d.staffId === stay.serviceStaffId) && d.from <= t + 1e-9 && d.to >= stay.end - 1e-9);
      const available = !lane?.duties || !!duty;
      if (live.has(stay.lane) && available) {
        book(busy, stay.lane, stay.start, stay.end); // being served: carries on
        if (!stay.serviceStaffId && duty) {
          changed = true;
          return { ...g, trip: trip.map((l, i) => i === index ? { ...stay, ...serviceSnapshot(state.staffRoster?.find(m => m.id === duty.staffId)) } : l) };
        }
        return g;
      }
      // Their clerk went mid-service: that'll do; they walk on now
      changed = true;
      return { ...g, trip: [...trip.slice(0, index), { ...stay, end: t }, ...shiftLegs(trip.slice(index + 1), t - stay.end)] };
    }
    // Not at the counter yet: when they reach the desk (the end of their walk there)
    movable.push({ guestId: g.id, index, ready: readyAt(trip, index), complaint: stay.activity === 'complain' });
    return g;
  });
  if (movable.length === 0) return changed ? { ...state, guests } : state;
  const byId = new Map(guests.map(g => [g.id, g]));
  movable.sort((a, b) => Number(a.complaint) - Number(b.complaint) || a.ready - b.ready || (a.guestId < b.guestId ? -1 : a.guestId > b.guestId ? 1 : 0));
  for (const m of movable) {
    const g = byId.get(m.guestId)!;
    const trip = g.trip!;
    const stay = trip[m.index] as StayLeg & { lane: string };
    const hours = stay.end - stay.start;
    // The clerks at the desk they're at (or making for)
    const here = lanes.filter(l => l.desk.id === stay.placeId && sameTile(l.front, stay.at));
    const head = trip.slice(0, m.index).filter(l => !(l.kind === 'stay' && l.start >= m.ready - 1e-9 && sameTile(l.at, stay.at)));
    const tail = trip.slice(m.index + 1);
    const from = Math.max(m.ready, t);
    if (here.length === 0) {
      // No clerk left at this desk: on they go without (from now; any time in line so far stays)
      const stood = from > m.ready + 1e-12 ? [makeStay(stay.at, m.ready, from, 'wait', { placeId: stay.placeId })] : [];
      byId.set(g.id, { ...g, trip: [...head, ...stood, ...shiftLegs(tail, from - stay.end)] });
      changed = true;
      continue;
    }
    const slot = quoteLane(here, busy, () => from, m.complaint ? VOICE.complainHours : hours, undefined, !m.complaint);
    if (!slot) {
      // Keep an already admitted guest at the counter until coverage returns. Revisited on every tick/hire.
      if (namedFrontDesk(state)) {
        const start = Math.max(from + 24, stay.start);
        const wait = [makeStay(stay.at, m.ready, start, 'wait', { placeId: stay.placeId, lane: stay.lane })];
        byId.set(g.id, { ...g, trip: [...head, ...wait, { ...stay, start, end: start + hours, ...serviceSnapshot(undefined) }, ...shiftLegs(tail, start + hours - stay.end)] });
        changed = true;
      }
      continue;
    }
    book(busy, slot.lane.key, slot.start, slot.start + slot.hours);
    const wait = slot.start > m.ready + 1e-12 ? [makeStay(stay.at, m.ready, slot.start, 'wait', { placeId: stay.placeId, lane: slot.lane.key })] : [];
    const next: Leg[] = [...head, ...wait, { ...stay, start: slot.start, end: slot.start + slot.hours, lane: slot.lane.key, serviceStaffId: slot.staffId,
      ...serviceSnapshot(state.staffRoster?.find(m => m.id === slot.staffId)) }, ...shiftLegs(tail, slot.start + slot.hours - stay.end)];
    const same = next.length === trip.length && next.every((l, k) => l.start === trip[k].start && l.end === trip[k].end && (l.kind !== 'stay' || l.lane === (trip[k] as StayLeg).lane && l.serviceStaffId === (trip[k] as StayLeg).serviceStaffId
      && l.serviceHospitality === (trip[k] as StayLeg).serviceHospitality && l.serviceSpecialty === (trip[k] as StayLeg).serviceSpecialty && l.serviceName === (trip[k] as StayLeg).serviceName));
    if (!same) {
      byId.set(g.id, { ...g, trip: next });
      changed = true;
    }
  }
  return changed ? { ...state, guests: guests.map(g => byId.get(g.id) ?? g) } : state;
}

/** How many people are standing in line at the front desk at time t (not yet at the counter). */
export function waitingInLine(state: HotelState, t: number): number {
  let n = 0;
  const count = (legs: Leg[], size: number) => {
    const stay = laneStayAt(legs, t);
    if (stay && stay.activity === 'wait') n += size;
  };
  for (const g of state.guests) if (g.trip) count(g.trip, partyOf(g).size);
  for (const w of state.walkers ?? []) count(w.trip, partyOf(w).size);
  return n;
}
