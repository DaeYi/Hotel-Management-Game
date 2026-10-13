import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, addFixture, getElevatorWaitPenalty } from '../src/simulation/HotelState.js';
import { partyOf } from '../src/simulation/Party.js';
import { processArrivals, calculateGuestReviewBreakdown } from '../src/simulation/GuestManager.js';
import { planArrivalTrips, checkInLanes, roomTile, routeVia, walkLegs, CHECK_IN_HOURS } from '../src/simulation/GuestMovement.js';
import { rollProfile } from '../src/simulation/Profile.js';
import {
  firstFree, quoteLane, laneBookings, lanesOf, deskArrivalTimes, patienceHours, creditCheckIns, recordGiveUps, reseatLanes, describeWait, waitingInLine, laneKey,
} from '../src/simulation/DeskQueue.js';
import { routeFromStreet, isEntranceTile } from '../src/simulation/Layout.js';
import { makeWalk, makeStay, legsEnd, hourStart, positionAt } from '../src/simulation/Movement.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { guestFigures } from '../src/render/figures.js';
import { ECONOMY, PATIENCE, GUEST_PROFILE, ELEVATOR } from '../src/config/balance.js';
import type { Guest, GuestProfile, HotelState, Leg, StayLeg, Walker } from '../src/simulation/types.js';

const PROFILE: GuestProfile = { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11 };
const with_ = (extra: Partial<GuestProfile>): GuestProfile => ({ ...PROFILE, ...extra });

function guest(id: string, extra: Partial<Guest> = {}): Guest {
  return {
    id, name: id, budget: 1000, stayLength: 3, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
    profile: PROFILE, ...extra,
  };
}

/** The starter hotel with `n` vacant standard rooms on row 2, `clerks` at the desk, at 15:00 on day 6. */
function hotel(n: number, clerks: number, extra: Partial<HotelState> = {}): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
  for (let x = 0; x < n; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
  return { ...s, day: 6, hour: 15, staff: { ...s.staff, frontDesk: clerks }, ...extra };
}

/** Run with lots of guests turning up (the market multiplied), restoring it after. */
function busy<T>(fn: () => T, arrivalsPerDay = 80): T {
  const was = ECONOMY.baseArrivalsPerDay;
  ECONOMY.baseArrivalsPerDay = arrivalsPerDay;
  try { return fn(); } finally { ECONOMY.baseArrivalsPerDay = was; }
}

function withSwitch<T>(sw: { enabled: boolean }, on: boolean, fn: () => T): T {
  const was = sw.enabled;
  sw.enabled = on;
  try { return fn(); } finally { sw.enabled = was; }
}

describe('Patience: who waits how long', () => {
  it('is rolled with the profile: patient 25 / normal 55 / impatient 20; business travellers are less patient', () => {
    const share = (party: { kind: 'couple' | 'business'; size: number }, purpose: 'business' | 'sightseeing', value: string) => {
      let k = 0;
      for (let i = 0; i < 8000; i++) if (rollProfile(`p${i}`, party, purpose, 'normal')!.patience === value) k++;
      return k / 8000;
    };
    expect(Math.abs(share({ kind: 'couple', size: 2 }, 'sightseeing', 'patient') - 0.25)).toBeLessThan(0.02);
    expect(Math.abs(share({ kind: 'couple', size: 2 }, 'sightseeing', 'impatient') - 0.2)).toBeLessThan(0.02);
    expect(Math.abs(share({ kind: 'business', size: 1 }, 'business', 'impatient') - 0.35)).toBeLessThan(0.02);
    withSwitch(PATIENCE, false, () => expect(rollProfile('x', { kind: 'solo', size: 1 }, 'sightseeing', 'normal')!.patience).toBeUndefined());
    expect(patienceHours(guest('a', { profile: with_({ patience: 'patient' }) }))).toBe(1);
    expect(patienceHours(guest('a', { profile: with_({ patience: 'impatient' }) }))).toBe(0.15);
    expect(patienceHours(guest('a'))).toBe(0.3); // none rolled: normal
    withSwitch(PATIENCE, false, () => expect(patienceHours(guest('a', { profile: with_({ patience: 'patient' }) }))).toBe(0.3));
  });

  it('an impatient guest minds a wait for the lift more, a patient one less', () => {
    const s0 = hotel(1, 1);
    // 24 rooms upstairs on one lift: half as busy again as it handles comfortably
    const upstairs = Array.from({ length: 24 }, (_, i) => ({ ...s0.rooms[0], id: `up${i}`, floor: 1 }));
    const s = { ...s0, floorCount: 2, rooms: upstairs, elevators: [{ id: 'e', gridX: 0, gridY: 0 }] };
    const base = getElevatorWaitPenalty(s, upstairs[0], guest('n'));
    expect(base).toBeCloseTo(0.5 * ELEVATOR.maxWaitPenalty, 9);
    const ratio = (patience: 'patient' | 'impatient') => getElevatorWaitPenalty(s, upstairs[0], guest(patience, { profile: with_({ patience }) })) / base;
    expect(ratio('impatient')).toBeCloseTo(PATIENCE.liftMult.impatient, 9);
    expect(ratio('patient')).toBeCloseTo(PATIENCE.liftMult.patient, 9);
    expect(PATIENCE.liftMult.normal).toBe(1);
    withSwitch(PATIENCE, false, () => expect(ratio('impatient')).toBe(1));
  });
});

describe('The front desk queue', () => {
  it('first fit: the first gap long enough at or after a time', () => {
    expect(firstFree(undefined, 1, 0.3)).toBe(1);
    expect(firstFree([[1, 1.3]], 1, 0.3)).toBeCloseTo(1.3, 12);
    expect(firstFree([[1.5, 1.8]], 1, 0.3)).toBe(1); // fits before
    expect(firstFree([[1.2, 1.5]], 1, 0.3)).toBe(1.5); // doesn't: after
    expect(firstFree([[1, 1.3], [1.4, 1.7]], 1, 0.3)).toBeCloseTo(1.7, 12); // the gap's too short
  });

  it('a lane is busy for exactly the check-ins and complaints on guests’ trips (across the hour)', () => {
    const s = hotel(2, 2);
    const [a, b] = lanesOf(s);
    const g = guest('g', { trip: [makeStay(a.front, 10.8, 11.13, 'check_in', { placeId: a.desk.id, lane: a.key })] });
    const busy = laneBookings({ guests: [g] }, 11);
    expect(busy.get(a.key)).toEqual([[10.8, 11.13]]);
    expect(busy.get(b.key)).toBeUndefined();
    expect(laneBookings({ guests: [g] }, 11.2).size).toBe(0); // over
    // The next hour's first arrival at 11.0 waits for lane a, or takes b
    expect(quoteLane([a], busy, () => 11, CHECK_IN_HOURS)!.start).toBeCloseTo(11.13, 12);
    expect(quoteLane([a, b], busy, () => 11, CHECK_IN_HOURS)!.lane.key).toBe(b.key);
    // A lane that reaches the room is preferred
    expect(quoteLane([a, b], new Map(), () => 11, CHECK_IN_HOURS, l => l.key === b.key)!.lane.key).toBe(b.key);
  });

  it('the hour’s arrivals reach the desk after the slowest walk in, spread over the hour in the order they booked', () => {
    const s = hotel(4, 1);
    const lanes = lanesOf(s);
    const T = 100;
    const at = deskArrivalTimes(s, lanes, T);
    const D = Math.max(...lanes.map(l => routeFromStreet(s, l.front, GUEST_PROFILE.pace.limited)!.hours));
    const times = Array.from({ length: 5 }, (_, i) => at(`g${i}`, i, 5));
    for (let i = 0; i < 5; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(T + D + i / 5 - 1e-9);
      expect(times[i]).toBeLessThan(T + D + (i + 1) / 5);
    }
    // Never ahead of the last hour's last arrival (say the desk's nearer the street now): in order across hours
    const [lane] = lanes;
    const late = guest('late', { tripKind: 'arrival', trip: [makeStay(lane.front, T + D + 0.5, T + D + 0.5 + CHECK_IN_HOURS, 'check_in', { placeId: lane.desk.id, lane: lane.key })] });
    expect(deskArrivalTimes({ ...s, guests: [late] }, lanes, T)('g0', 0, 5)).toBeGreaterThan(T + D + 0.5);
  });

  it('at a busy desk: first come first served, nobody waits past their patience, and someone who would gives up -- the room the next guest’s', () => {
    let found = false;
    for (let seed = 1; seed <= 40 && !found; seed++) {
      const s = hotel(6, 1);
      const r = busy(() => processArrivals(s, 15, new PRNG(seed)));
      const gaveUp = r.walkIns.filter(w => w.outcome === 'impatient');
      if (gaveUp.length === 0 || r.checkedIn.length < 2) continue;
      found = true;
      // Served in the order they got there, waits within patience
      const served = r.checkedIn.map(c => c.desk!);
      for (let i = 1; i < served.length; i++) expect(served[i].start).toBeGreaterThanOrEqual(served[i - 1].start - 1e-9);
      for (const c of r.checkedIn) expect(c.desk!.start - c.desk!.arriveAt).toBeLessThanOrEqual(patienceHours(c.guest) + 1e-9);
      for (const w of gaveUp) {
        expect(w.desk!.leaveAt! - w.desk!.arriveAt).toBeCloseTo(patienceHours(w.guest), 12);
        expect(w.desk!.lane).toBeTruthy();
      }
      // Nobody has a room twice, and give-ups hold none
      const rooms = r.checkedIn.map(c => c.roomId);
      expect(new Set(rooms).size).toBe(rooms.length);
      expect(r.turnedAway).toBe(r.walkIns.length);
      // No give-up event yet: it comes as they walk out
      expect(r.events.some(e => e.type === 'guest_impatient')).toBe(false);
    }
    expect(found).toBe(true);
  });

  it('who arrives doesn’t depend on the desk: one clerk or four, the same guests come', () => {
    const s = hotel(6, 1);
    const ids = (clerks: number) => {
      const prng = new PRNG(7);
      const r = busy(() => processArrivals({ ...s, staff: { ...s.staff, frontDesk: clerks } }, 15, prng));
      return { guests: [...r.checkedIn.map(c => c.guest.id), ...r.walkIns.map(w => w.guest.id)].sort(), next: prng.next() };
    };
    const one = ids(1);
    const four = ids(4);
    expect(one.guests).toEqual(four.guests);
    expect(one.next).toBe(four.next);
  });

  it('the trips: in off the street to reach the desk on time, the wait, the check-in with the clerk, up to the room; a give-up waits exactly their patience and walks out', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = hotel(6, 1);
      const r = busy(() => processArrivals(s, 15, new PRNG(seed)));
      if (!r.walkIns.some(w => w.outcome === 'impatient')) continue;
      const T = hourStart(s) + 1;
      const after = { ...s, guests: r.checkedIn.map(c => c.guest), rooms: s.rooms.map(rm => ({ ...rm, ...(r.checkedIn.find(c => c.roomId === rm.id) ? { status: 'occupied' as const, guestId: r.checkedIn.find(c => c.roomId === rm.id)!.guest.id } : {}) })) };
      const trips = planArrivalTrips(after, r.checkedIn, r.walkIns, T);
      for (const c of r.checkedIn) {
        const legs = trips.trips.get(c.guest.id)!;
        expect(legs[0].start).toBeGreaterThanOrEqual(T - 1e-9);
        const ci = legs.find(l => l.kind === 'stay' && l.activity === 'check_in') as StayLeg;
        expect([ci.lane, ci.start]).toEqual([c.desk!.lane, expect.any(Number)]);
        expect(ci.start).toBeCloseTo(c.desk!.start, 9);
        const before = legs[legs.indexOf(ci) - 1];
        if (c.desk!.start > c.desk!.arriveAt + 1e-9) expect(before).toMatchObject({ kind: 'stay', activity: 'wait', lane: c.desk!.lane });
        const end = positionAt(legs, legsEnd(legs))!;
        const room = after.rooms.find(rm => rm.id === c.roomId)!;
        expect([end.x, end.y]).toEqual([room.gridX, room.gridY]);
        for (let i = 1; i < legs.length; i++) expect(legs[i].start).toBeCloseTo(legs[i - 1].end, 9);
      }
      // A give-up who'd booked smaller keeps the party they came as (for the turn-away counts)
      const smaller = r.walkIns.find(x => x.outcome === 'impatient')!;
      const kept = planArrivalTrips(after, [], [{ ...smaller, desk: { ...smaller.desk!, wanted: 'family' } }], T).walkers[0];
      expect(kept.wanted).toBe('family');
      for (const w of trips.walkers.filter(x => x.reason === 'impatient')) {
        const line = w.trip.find(l => l.kind === 'stay' && l.activity === 'wait') as StayLeg;
        expect(line.lane).toBeTruthy();
        expect(line.end - line.start).toBeCloseTo(patienceHours(w), 9);
        expect(w.waited).toBeCloseTo(patienceHours(w), 9);
        expect(w.name).toBeTruthy();
        const last = w.trip[w.trip.length - 1];
        expect(last.kind === 'walk' && isEntranceTile(after, last.path[last.path.length - 1])).toBe(true);
      }
      for (const w of trips.walkers.filter(x => x.reason === 'turned_away')) {
        expect(w.trip.some(l => l.kind === 'stay' && l.lane !== undefined)).toBe(false); // asking takes no clerk's time
      }
      return;
    }
    throw new Error('no seed with a give-up');
  });

  it('the toast comes as they walk out ("gave up after 18 minutes in line"), counted for the day; a wait at the counter is credited once, a long one minds a little', () => {
    const s = hotel(2, 1);
    const [lane] = lanesOf(s);
    const T = hourStart(s) + 1;
    const walker: Walker = {
      id: 'w', trait: 'normal', isReturning: false, reason: 'impatient', name: 'Omar', profile: with_({ patience: 'normal' }),
      trip: [makeStay(lane.front, T - 0.6, T - 0.3, 'wait', { placeId: lane.desk.id, lane: lane.key }), makeWalk(routeFromStreet(s, lane.front, 0.06)!.path.slice().reverse(), T - 0.3, 0.06)],
    };
    const r = recordGiveUps({ ...s, walkers: [walker] }, T);
    expect(r.events.map(e => e.message)).toEqual(['Omar gave up after 18 minutes in line']);
    // A family who'd booked a room for two, then gave up: counted as the family they are
    expect(recordGiveUps({ ...s, walkers: [{ ...walker, wanted: 'family' }] }, T).events[0].data).toMatchObject({ wanted: 'family' });
    expect(r.events[0].data!.wanted).toBeUndefined();
    expect(r.state.deskToday).toMatchObject({ day: 6, gaveUp: 1 });
    expect(recordGiveUps({ ...s, walkers: [walker] }, T + 1).events).toEqual([]); // the hour after: already told
    expect(describeWait(1)).toBe('an hour');
    // A guest who waited 0.25h of their 0.3h patience: most of the mood a full wait costs
    const g = guest('g', {
      tripKind: 'arrival', profile: with_({ patience: 'normal' }),
      trip: [makeStay(lane.front, T - 0.6, T - 0.35, 'wait', { placeId: lane.desk.id, lane: lane.key }), makeStay(lane.front, T - 0.35, T - 0.02, 'check_in', { placeId: lane.desk.id, lane: lane.key })],
    });
    const credited = creditCheckIns({ ...s, guests: [g] }, T);
    const after = credited.guests[0];
    expect(after.checkInWait).toBeCloseTo(0.25, 9);
    expect(after.satisfaction).toBeCloseTo(55 - PATIENCE.waitMood * (0.25 - PATIENCE.waitGrace) / 0.3, 9);
    expect(credited.deskToday).toMatchObject({ checkedIn: 1, longestWait: 0.25 });
    expect(creditCheckIns(credited, T + 1)).toBe(credited); // once
    withSwitch(PATIENCE, false, () => expect(creditCheckIns({ ...s, guests: [g] }, T).guests[0].satisfaction).toBe(55));
    // A patient guest minds the same wait less: it's less of their patience
    const patient = { ...g, profile: with_({ patience: 'patient' }) };
    expect(creditCheckIns({ ...s, guests: [patient] }, T).guests[0].satisfaction).toBeCloseTo(55 - PATIENCE.waitMood * (0.25 - PATIENCE.waitGrace) / 1, 9);
    // One check-in a stay, even split in two
    const [wait, ci] = g.trip! as StayLeg[];
    const split = { ...g, trip: [wait, { ...ci, end: T - 0.2 }, { ...ci, start: T - 0.2 }] };
    const twice = creditCheckIns(creditCheckIns({ ...s, guests: [split] }, T), T + 1);
    expect(twice.deskToday!.checkedIn).toBe(1);
  });

  it('a clerk hired mid-hour takes the head of the line at once; one let go, their line joins the others (nobody double-booked)', () => {
    const s0 = hotel(4, 1);
    const [a] = lanesOf(s0);
    const T = hourStart(s0);
    const g = (id: string, ready: number, start: number) => guest(id, {
      tripKind: 'arrival',
      trip: [
        ...(start > ready ? [makeStay(a.front, ready, start, 'wait', { placeId: a.desk.id, lane: a.key })] : []),
        makeStay(a.front, start, start + CHECK_IN_HOURS, 'check_in', { placeId: a.desk.id, lane: a.key }),
      ],
    });
    // One clerk: served at T+0.1, the next waits from T+0.15 to T+0.433
    let s = { ...s0, guests: [g('x', T + 0.1, T + 0.1), g('y', T + 0.15, T + 0.1 + CHECK_IN_HOURS)] };
    const hired = settleChanges(s, { ...s, staff: { ...s.staff, frontDesk: 2 } }, T + 0.12);
    const y = hired.guests.find(q => q.id === 'y')!.trip!;
    const ci = y.find(l => l.kind === 'stay' && l.activity === 'check_in') as StayLeg;
    expect(ci.start).toBeCloseTo(T + 0.15, 9); // the new clerk, straight away
    expect(ci.lane).toBe(laneKey(a.desk.id, 1));
    // Let one go again (two booked on lane 1 and lane 0): no clerk serves two at once
    const fired = settleChanges(hired, { ...hired, staff: { ...hired.staff, frontDesk: 1 } }, T + 0.13);
    const stays = fired.guests.flatMap(q => q.trip!.filter(l => l.kind === 'stay' && l.activity === 'check_in') as StayLeg[]);
    for (const p of stays) for (const q of stays) if (p !== q && p.lane === q.lane) expect(p.end <= q.start + 1e-9 || q.end <= p.start + 1e-9).toBe(true);
    expect(stays.every(p => p.start < T + 0.13 || p.lane === a.key)).toBe(true);
    // Nobody at the desk at all: on they go without
    const none = reseatLanes({ ...s, staff: { ...s.staff, frontDesk: 0 } }, T + 0.12);
    expect(none.guests.find(q => q.id === 'y')!.trip!.some(l => l.kind === 'stay' && l.activity === 'check_in')).toBe(false);
    // Hired once y's been in line a while: served from now, never in the past, and the time in line so far stays a wait
    const later = settleChanges(s, { ...s, staff: { ...s.staff, frontDesk: 2 } }, T + 0.3);
    const yl = later.guests.find(q => q.id === 'y')!.trip!;
    const yci = yl.find(l => l.kind === 'stay' && l.activity === 'check_in') as StayLeg;
    expect(yci.start).toBeCloseTo(T + 0.3, 9);
    expect(yl[yl.indexOf(yci) - 1]).toMatchObject({ kind: 'stay', activity: 'wait', lane: yci.lane });
    expect(yl[yl.indexOf(yci) - 1].start).toBeCloseTo(T + 0.15, 9);
    expect(creditCheckIns(later, T + 1).guests.find(q => q.id === 'y')!.checkInWait).toBeCloseTo(0.15, 9);
    // Everyone gone mid-line: they stood there till now, then go on
    const gone = reseatLanes({ ...s, staff: { ...s.staff, frontDesk: 0 } }, T + 0.3).guests.find(q => q.id === 'y')!.trip!;
    expect(gone[0]).toMatchObject({ kind: 'stay', activity: 'wait' });
    expect(gone[0].end).toBeCloseTo(T + 0.3, 9);
  });

  it('checking in comes first: a complaint booked but not yet at the counter holds nobody up', () => {
    const s = hotel(6, 1);
    const [a] = lanesOf(s);
    const T = hourStart(s) + 1;
    // Someone booked to complain at the only clerk for the whole next hour, not there yet
    const c = guest('c', { tripKind: 'complaint', complaint: { about: 'x', via: 'desk' }, trip: [makeStay(a.front, T + 0.01, T + 2, 'complain', { placeId: a.desk.id, lane: a.key })] });
    for (const seed of [1, 2, 3]) {
      const plain = busy(() => processArrivals(s, 15, new PRNG(seed)));
      const withC = busy(() => processArrivals({ ...s, guests: [c] }, 15, new PRNG(seed)));
      expect(plain.checkedIn.length).toBeGreaterThan(0);
      expect(withC.checkedIn.map(x => x.desk)).toEqual(plain.checkedIn.map(x => x.desk));
      expect(withC.walkIns.length).toBe(plain.walkIns.length);
    }
  });

  it('two desks facing one spot: someone in one desk\u2019s line is seated again only on that desk\u2019s clerks', () => {
    const s0 = addFixture(hotel(2, 4), 'desk', 1, 5, 0)!;
    const lanes = lanesOf(s0);
    const starter = createStarterHotel().fixtures.find(f => f.type === 'desk')!.id;
    const A = lanes.filter(l => l.desk.id === starter);
    const B = lanes.filter(l => l.desk.id !== starter);
    expect([A.length, B.length]).toEqual([2, 2]);
    expect(A[0].front).toEqual(B[0].front); // the same spot
    const T = hourStart(s0);
    const g = (id: string, lane: typeof A[0], ready: number, start: number) => guest(id, {
      tripKind: 'arrival',
      trip: [
        ...(start > ready ? [makeStay(lane.front, ready, start, 'wait', { placeId: lane.desk.id, lane: lane.key })] : []),
        makeStay(lane.front, start, start + CHECK_IN_HOURS, 'check_in', { placeId: lane.desk.id, lane: lane.key }),
      ],
    });
    // B's clerks both busy, A's free: z, in B's line, stays in B's line
    const s = { ...s0, guests: [g('x', B[0], T, T), g('y', B[1], T, T), g('z', B[0], T + 0.05, T + CHECK_IN_HOURS)] };
    const z = reseatLanes(s, T + 0.1).guests.find(q => q.id === 'z')!.trip!.find(l => l.kind === 'stay' && l.activity === 'check_in') as StayLeg;
    expect(B.map(l => l.key)).toContain(z.lane);
    expect(z.placeId).toBe(B[0].desk.id);
  });

  it('a family who booked a room for two, then gave up in line, counts as the family they are', () => {
    let found = 0;
    for (let seed = 1; seed <= 300 && found < 2; seed++) {
      const r = busy(() => processArrivals(hotel(6, 1), 15, new PRNG(seed)));
      for (const w of r.walkIns) {
        if (w.outcome !== 'impatient' || !w.desk?.wanted) continue;
        found++;
        expect(w.desk.wanted).not.toBe(partyOf(w.guest).kind);
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('a clerk let go mid-service: their guest is done there and walks on now; nobody else is booked on that seat', () => {
    const s0 = hotel(4, 2);
    const [a, b] = lanesOf(s0);
    const T = hourStart(s0);
    const pace = 0.06;
    const up = routeVia(s0, b.front, roomTile(s0.rooms[0]), pace)!;
    const service = (id: string, lane: typeof a, ready: number, start: number, extra: Leg[] = []) => guest(id, {
      tripKind: 'arrival',
      trip: [
        ...(start > ready ? [makeStay(lane.front, ready, start, 'wait', { placeId: lane.desk.id, lane: lane.key })] : []),
        makeStay(lane.front, start, start + CHECK_IN_HOURS, 'check_in', { placeId: lane.desk.id, lane: lane.key }),
        ...extra,
      ],
    });
    const x = service('x', b, T + 0.1, T + 0.1, walkLegs(up, T + 0.1 + CHECK_IN_HOURS, pace)); // at seat 1
    const u = service('u', a, T, T); // at seat 0
    const w = service('w', a, T + 0.2, T + CHECK_IN_HOURS); // in seat 0's line
    const s = { ...s0, guests: [x, u, w] };
    expect(b.key).toBe(laneKey(a.desk.id, 1));
    const fired = settleChanges(s, { ...s, staff: { ...s.staff, frontDesk: 1 } }, T + 0.2);
    const xl = fired.guests.find(q => q.id === 'x')!.trip!;
    const ci = xl.find(l => l.kind === 'stay' && l.activity === 'check_in') as StayLeg;
    expect(ci.start).toBeCloseTo(T + 0.1, 9);
    expect(ci.end).toBeCloseTo(T + 0.2, 9);
    expect(xl[xl.indexOf(ci) + 1].start).toBeCloseTo(T + 0.2, 9); // on up to the room now
    expect(fired.guests.flatMap(q => q.trip!).some(l => l.kind === 'stay' && l.lane === b.key && l.end > T + 0.2 + 1e-9)).toBe(false);
  });

  it('a guest at the counter when the building changes carries on there: one check-in, credited once', () => {
    const s0 = hotel(2, 1);
    const [a] = lanesOf(s0);
    const T = hourStart(s0);
    const room = s0.rooms[1];
    const pace = 0.06;
    const up = routeVia(s0, a.front, roomTile(room), pace)!;
    const x = guest('x', { tripKind: 'arrival', trip: [makeStay(a.front, T + 0.8, T + 0.8 + CHECK_IN_HOURS, 'check_in', { placeId: a.desk.id, lane: a.key }), ...walkLegs(up, T + 0.8 + CHECK_IN_HOURS, pace)] });
    const s = { ...s0, guests: [x], rooms: s0.rooms.map(r => (r.id === room.id ? { ...r, status: 'occupied' as const, guestId: 'x' } : r)) };
    // A room built across their way up (a tile on it that isn't the desk's front or their door)
    const across = up.path.slice(1, -1).map(p => addRoom(s, 'standard', p.gridX, p.gridY, p.floor, 'up')).find(Boolean)!;
    expect(across).toBeTruthy();
    const built = settleChanges(s, across, T + 0.85);
    const legs = built.guests[0].trip!;
    const counter = legs.filter(l => l.kind === 'stay' && l.activity === 'check_in') as StayLeg[];
    expect(counter).toHaveLength(1);
    expect([counter[0].start, counter[0].end]).toEqual([T + 0.8, T + 0.8 + CHECK_IN_HOURS]);
    const once = creditCheckIns(built, T + 1);
    expect(once.deskToday!.checkedIn).toBe(1);
    expect(creditCheckIns(once, T + 2)).toBe(once);
  });

  it('on screen, each clerk\u2019s line is in the order they\u2019ll be served: whoever\u2019s at the counter, then by their turn', () => {
    const s0 = hotel(3, 1);
    const [a] = lanesOf(s0);
    const T = hourStart(s0);
    const g = (id: string, ready: number, start: number) => guest(id, {
      tripKind: 'arrival',
      trip: [
        ...(start > ready ? [makeStay(a.front, ready, start, 'wait', { placeId: a.desk.id, lane: a.key })] : []),
        makeStay(a.front, start, start + CHECK_IN_HOURS, 'check_in', { placeId: a.desk.id, lane: a.key }),
      ],
    });
    // (z got there before y but is served after: the drawing follows who's next, not who came first)
    const s = { ...s0, guests: [g('x', T, T), g('y', T + 0.1, T + CHECK_IN_HOURS), g('z', T + 0.05, T + 2 * CHECK_IN_HOURS)] };
    const line = (st: HotelState, id: string) => guestFigures(st, T + 0.2).figures.find(f => f.id === id)!.line!;
    expect(line(s, 'x')).toMatchObject({ serving: true, turn: T });
    expect(line(s, 'y').turn).toBeCloseTo(T + CHECK_IN_HOURS, 9);
    expect(line(s, 'z').turn).toBeCloseTo(T + 2 * CHECK_IN_HOURS, 9);
    // Someone who'll give up: their turn would come after they've gone
    const w: Walker = { id: 'w', trait: 'normal', isReturning: false, reason: 'impatient', trip: [makeStay(a.front, T + 0.1, T + 0.4, 'wait', { placeId: a.desk.id, lane: a.key })] };
    expect(line({ ...s, walkers: [w] }, 'w').turn).toBeCloseTo(T + 0.4, 9);
    // A clock over someone who's used half their patience in line (z: 0.2h of 0.3h), none at the counter
    const fig = (id: string) => guestFigures(s, T + 0.25).figures.find(f => f.id === id)!;
    expect(fig('z').clock).toBeCloseTo(0.2 / 0.3, 9);
    expect(fig('x').clock).toBeUndefined();
  });

  it('the line now: how many stand in it (a party counts by heads)', () => {
    const s = hotel(2, 1);
    const [a] = lanesOf(s);
    const g = guest('g', { party: { kind: 'couple', size: 2 }, trip: [makeStay(a.front, 10, 10.5, 'wait', { placeId: a.desk.id, lane: a.key })] });
    expect(waitingInLine({ ...s, guests: [g] }, 10.2)).toBe(2);
    expect(waitingInLine({ ...s, guests: [g] }, 10.6)).toBe(0);
  });

  it('a whole day in the tick with one clerk on a busy afternoon: some wait, some give up, the toasts come as they leave', () => {
    let s = hotel(6, 1, { hour: 13 });
    const prng = new PRNG(3);
    const types: string[] = [];
    busy(() => {
      for (let h = 0; h < 12; h++) {
        const r = tickSimulation(s, prng);
        types.push(...r.events.map(e => `${e.type}:${e.data?.reason ?? ''}`));
        s = r.state;
      }
    });
    expect(types).toContain('guest_impatient:queue');
    expect(s.deskToday!.gaveUp).toBeGreaterThan(0);
    expect(s.deskToday!.checkedIn).toBeGreaterThan(0);
  });
});
