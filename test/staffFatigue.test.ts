import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_FATIGUE, STAFF_PERSONALITIES } from '../src/config/staff.js';
import { BREAK_ROOM, TRAVEL } from '../src/config/balance.js';
import { addElevator, addFixture, addRoom, buildFloor, createStarterHotel } from '../src/simulation/HotelState.js';
import { fatigueAt, fatigueGain, fatigueOf, fatigueOn, fatigueRate, planStaffRest, projectFatigue, restReservations, staminaOf, type RestReservation } from '../src/simulation/StaffFatigue.js';
import { afterWork, candidatesFor, checkInHours, staffRate } from '../src/simulation/StaffProfiles.js';
import { getStaffPlan, replanStaff, rosterAfter } from '../src/simulation/StaffManager.js';
import { hourStart, makeStay, makeWalk } from '../src/simulation/Movement.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { doorTile, findRoute } from '../src/simulation/Layout.js';
import { saveGame, loadGame } from '../src/simulation/SaveManager.js';
import { freeBy } from '../src/simulation/Spotlight.js';
import { baseWalkHours } from '../src/simulation/HousekeepingManager.js';
import { PRNG } from '../src/simulation/prng.js';
import type { HotelState, Leg, StaffMember, StaffPlan } from '../src/simulation/types.js';

function worker(extra: Partial<StaffMember> = {}): StaffMember {
  return { id: 'h1', serial: 1, name: 'Avery Park', role: 'housekeeper', dailyWage: 70,
    at: { gridX: 5, gridY: 2, floor: 0, door: 'up' },
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal' },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 40 }, ...extra };
}
function hotel(member = worker()): HotelState {
  const state = addRoom({ ...createStarterHotel(), cash: 1_000_000, day: 2, hour: 12 }, 'standard', 5, 2, 0, 'up')!;
  return { ...state, frontDeskRosterReady: true, staff: { frontDesk: 0, housekeepers: 1, maintenanceWorkers: 0 },
    staffRoster: [member], staffPlan: null };
}
function withPlan(state: HotelState, legs: Leg[]): HotelState {
  const member = state.staffRoster![0];
  const plan: StaffPlan = { start: hourStart(state), itineraries: [{ staffId: member.id, legs,
    end: { at: member.at } }] };
  return { ...state, staffPlan: plan };
}

afterEach(() => {
  STAFF_FATIGUE.enabled = true;
  STAFF_PERSONALITIES.enabled = true;
  localStorage.clear();
});

describe('Stamina and tired performance', () => {
  it('keeps older people fresh with normal stamina and bounds persisted fatigue', () => {
    const old = worker({ profile: undefined, stats: undefined });
    expect(staminaOf(old)).toBe('normal');
    expect(fatigueOf(old)).toBe(0);
    expect(fatigueOf(worker({ stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: -5 } }))).toBe(0);
    expect(fatigueOf(worker({ stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 110 } }))).toBe(100);
  });

  it('slows actual room work at 60 while keeping walks and baseline future check-in quotes unchanged', () => {
    const fresh = worker({ stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 59.99 } });
    const tired = worker({ stats: { ...fresh.stats!, fatigue: 60 } });
    expect(fatigueRate(fresh)).toBe(1);
    expect(fatigueRate(tired)).toBe(0.85);
    expect(staffRate(tired)).toBeCloseTo(staffRate(fresh) * 0.85);
    const freshClerk: StaffMember = { ...fresh, role: 'front_desk' }, tiredClerk: StaffMember = { ...tired, role: 'front_desk' };
    expect(checkInHours(tiredClerk)).toBe(checkInHours(freshClerk));
    const route = [roomTile(hotel().rooms[0]), { gridX: 5, gridY: 1, floor: 0 }];
    expect(makeWalk(route, 36, TRAVEL.hoursPerTile).end).toBeCloseTo(36 + TRAVEL.hoursPerTile);
  });

  it('disabling either staff personalities or fatigue restores baseline throughput', () => {
    const tired = worker({ stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 90 } });
    STAFF_FATIGUE.enabled = false;
    expect(fatigueOn()).toBe(false);
    expect(fatigueRate(tired)).toBe(1);
    expect(staffRate(tired)).toBe(1);
    const clerk: StaffMember = { ...tired, role: 'front_desk' };
    expect(checkInHours(clerk) * 60).toBeCloseTo(20);
    STAFF_FATIGUE.enabled = true;
    STAFF_PERSONALITIES.enabled = false;
    expect(fatigueOn()).toBe(false);
    expect(fatigueRate(tired)).toBe(1);
  });

  it('rolls stable stamina at hire without changing the older identity and agreed wage fields', () => {
    const offers = Array.from({ length: 40 }, (_, day) => candidatesFor(day + 1, 'housekeeper')).flat();
    expect(new Set(offers.map(candidate => candidate.profile.stamina))).toEqual(new Set(['low', 'normal', 'high']));
    expect(candidatesFor(7, 'housekeeper')).toEqual(candidatesFor(7, 'housekeeper'));
    const person = worker({ stats: { workHours: 399.9, lateDays: 1, absentDays: 2, fatigue: 72, fatigueAt: 35 } });
    const promoted = afterWork(person, 0.2, 2);
    expect(promoted.stats!.fatigue).toBe(72);
    expect(promoted.stats!.fatigueAt).toBe(35);
    expect(promoted.profile!.stamina).toBe('normal');
    expect(promoted.name).toBe(person.name);
  });
});

describe('Fatigue follows actual elapsed itinerary time', () => {
  it('uses 7, 5 and 3 fatigue per actual work-hour, clipped at the query boundaries', () => {
    const member = worker(), at = member.at!;
    const work = makeStay(at, 35, 38, 'clean', { job: 'turnover', placeId: 'room', workRate: 0.85 });
    for (const [stamina, gain] of [['low', 7], ['normal', 5], ['high', 3]] as const) {
      const person = { ...member, profile: { ...member.profile!, stamina } };
      expect(fatigueGain(person)).toBe(gain);
      expect(projectFatigue(person, [work], 36, 37, 40)).toBeCloseTo(40 + gain);
      expect(projectFatigue(person, [work], 36.25, 36.75, 40)).toBeCloseTo(40 + gain / 2);
    }
  });

  it('charges carried walks and elevator rides only for the part of the current hour they occupy', () => {
    const person = worker(), path = [{ gridX: 5, gridY: 1, floor: 0 }, { gridX: 5, gridY: 1, floor: 1 }];
    const carry = makeWalk(path, 35.9, TRAVEL.hoursPerTile);
    const from = 36, to = Math.min(37, carry.end);
    expect(carry.end).toBeGreaterThan(from);
    expect(projectFatigue(person, [carry], from, to, 40)).toBeCloseTo(40 + 5 * (to - from));
    expect(projectFatigue(person, [makeStay(person.at!, 35, 38, 'desk')], 36, 36.5, 40)).toBeCloseTo(42.5);
  });

  it('uses real rest snapshots rather than applying the tired work multiplier to recovery', () => {
    const person = worker({ stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 90 } });
    for (const [restRate, expected] of [[25, 77.5], [10, 85]]) {
      const rest = makeStay(person.at!, 36, 37, 'rest', { restRate });
      expect(projectFatigue(person, [rest], 36, 36.5, 90)).toBeCloseTo(expected);
    }
    expect(projectFatigue(person, [makeStay(person.at!, 36, 37, 'rest', { restRate: 25 })], 36, 37, 5)).toBe(0);
    expect(projectFatigue(person, [makeStay(person.at!, 36, 37, 'clean', { job: 'daily' })], 36, 37, 99)).toBe(100);
    // A saved stay from before capacity reservations must not claim a fast seat retroactively.
    expect(projectFatigue(person, [makeStay(person.at!, 36, 37, 'rest', { placeId: 'old-breakroom' })], 36, 36.5, 90)).toBe(85);
  });

  it('projects from the saved fatigue timestamp and actual partial-hour plan without mutating the worker', () => {
    const member = worker({ stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 40, fatigueAt: 36 } });
    const state = withPlan(hotel(member), [makeStay(member.at!, 36, 37, 'clean', { job: 'turnover', placeId: 'room' })]);
    expect(fatigueAt(state, member, 36)).toBe(40);
    expect(fatigueAt(state, member, 36.5)).toBeCloseTo(42.5);
    expect(fatigueAt(state, member, 37)).toBe(45);
    expect(member.stats!.fatigue).toBe(40);
    expect(fatigueAt(state, member, 36.5)).toBeCloseTo(42.5);
  });

  it('recovers off duty across midnight instead of resetting at the date change', () => {
    let member = worker({ at: null, stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 80, fatigueAt: 47 } });
    let state = { ...hotel(member), hour: 23, staffPlan: { start: 47, itineraries: [] } };
    expect(fatigueAt(state, member, 48)).toBe(55);
    member = rosterAfter(state, state.staffPlan)[0];
    expect(member.stats!.fatigue).toBe(55);
    expect(member.stats!.fatigueAt).toBe(48);
    state = { ...state, day: 3, hour: 0, staffRoster: [member], staffPlan: { start: 48, itineraries: [] } };
    expect(fatigueAt(state, member, 49)).toBe(30);
    expect(rosterAfter(state, state.staffPlan)[0].stats!.fatigue).toBe(30);
  });

  it('repeated mid-hour replanning preserves the elapsed work and credits fatigue only once', () => {
    const member = worker({ stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 40, fatigueAt: 36 } });
    let state = hotel(member);
    const room = state.rooms[0];
    state = { ...state, rooms: [{ ...room, status: 'cleaning', cleaningHoursRemaining: 10 }],
      staffRoster: [{ ...member, roomId: room.id }] };
    state = withPlan(state, [makeStay(roomTile(room), 36, 37, 'clean', { job: 'turnover', placeId: room.id })]);
    state = replanStaff(state, 36.25);
    state = replanStaff(state, 36.6);
    const plan = getStaffPlan(state);
    expect(fatigueAt(state, state.staffRoster![0], 37)).toBeCloseTo(45);
    const end = rosterAfter(state, plan)[0];
    expect(end.stats!.fatigue).toBeCloseTo(45);
    expect(end.stats!.fatigueAt).toBe(37);
    expect(end.stats!.workHours).toBeCloseTo(81);
  });

  it('preserves tired fatigue, its timestamp and an unfinished carried walk through saving', () => {
    const carry = makeWalk([{ gridX: 5, gridY: 1, floor: 0 }, { gridX: 5, gridY: 1, floor: 1 }], 35.95, TRAVEL.hoursPerTile);
    const member = worker({ carry, stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 72, fatigueAt: 36 } });
    const state = withPlan(hotel(member), [carry]);
    const before = fatigueAt(state, member, Math.min(37, carry.end));
    expect(saveGame(state, new PRNG(17))).toBe(true);
    const loaded = loadGame()!;
    const restored = loaded.state.staffRoster!.find(m => m.id === member.id)!;
    expect(restored.stats).toEqual(member.stats);
    expect(restored.carry).toEqual(carry);
    expect(fatigueRate(restored)).toBe(0.85);
    expect(fatigueAt(loaded.state, restored, Math.min(37, carry.end))).toBeCloseTo(before);
  });
});

describe('Functional break rooms reserve actual seats', () => {
  function breakRoomHotel() {
    let state = addFixture(hotel(), 'breakroom', 5, 0, 0)!;
    state = addFixture(state, 'breakroom', 8, 0, 0)!;
    const near = state.fixtures.find(fixture => fixture.type === 'breakroom' && fixture.gridX === 5)!;
    const far = state.fixtures.find(fixture => fixture.type === 'breakroom' && fixture.gridX === 8)!;
    const at = { gridX: 5, gridY: 1, floor: 0 }, from = hourStart(state);
    const arrival = from + findRoute(state, at, near, TRAVEL.hoursPerTile)!.hours;
    return { state, near, far, at, from, arrival };
  }

  it('walks to the nearest available seat and reserves a full half-hour with faster recovery', () => {
    const { state, near, at, from } = breakRoomHotel();
    const reservations: RestReservation[] = [];
    const result = planStaffRest(state, state.staffRoster![0], at, from, reservations);
    const rest = result.legs.at(-1)!;
    expect(result.legs[0].kind).toBe('walk');
    expect(rest).toMatchObject({ kind: 'stay', activity: 'rest', placeId: near.id, restRate: 25 });
    expect(rest.end - rest.start).toBeCloseTo(0.5);
    expect(result.until).toBe(rest.end);
    expect(result.reservation).toMatchObject({ placeId: near.id, start: rest.start, end: rest.end });
    expect(reservations).toContainEqual({ staffId: 'h1', placeId: near.id, start: rest.start, end: rest.end });
  });

  it('uses another reachable break room when all seats in the nearest one are occupied', () => {
    const { state, near, far, at, from, arrival } = breakRoomHotel();
    const reservations: RestReservation[] = Array.from({ length: BREAK_ROOM.seats }, (_, i) => ({
      staffId: `busy-${i}`, placeId: near.id, start: arrival - 1, end: arrival + 1,
    }));
    const result = planStaffRest(state, state.staffRoster![0], at, from, reservations);
    expect(result.reservation.placeId).toBe(far.id);
    expect(result.legs.at(-1)).toMatchObject({ kind: 'stay', activity: 'rest', placeId: far.id, restRate: 25 });
  });

  it('counts simultaneous occupants rather than every reservation that touches the rest interval', () => {
    const { state, near, at, from, arrival } = breakRoomHotel();
    const reservations: RestReservation[] = Array.from({ length: BREAK_ROOM.seats }, (_, i) => ({
      staffId: `busy-${i}`, placeId: near.id,
      start: arrival + (i < BREAK_ROOM.seats / 2 ? 0 : 0.25),
      end: arrival + (i < BREAK_ROOM.seats / 2 ? 0.25 : 0.5),
    }));
    expect(planStaffRest(state, state.staffRoster![0], at, from, reservations).reservation.placeId).toBe(near.id);
    const ending = Array.from({ length: BREAK_ROOM.seats }, (_, i) => ({ staffId: `left-${i}`, placeId: near.id, start: arrival - 1, end: arrival }));
    expect(planStaffRest(state, state.staffRoster![0], at, from, ending).reservation.placeId).toBe(near.id);
  });

  it('steps out of a guest room to rest elsewhere when no break-room seat is available', () => {
    const { state, near, far, from } = breakRoomHotel();
    const reservations: RestReservation[] = [near, far].flatMap(room => Array.from({ length: BREAK_ROOM.seats }, (_, i) => ({
      staffId: `${room.id}-busy-${i}`, placeId: room.id, start: from, end: from + 5,
    })));
    const room = state.rooms[0];
    const result = planStaffRest(state, state.staffRoster![0], roomTile(room), from, reservations);
    expect(result.reservation.placeId).toBeUndefined();
    expect(result.at).toMatchObject(doorTile(room, room.door));
    expect(result.legs.at(-1)).toMatchObject({ kind: 'stay', activity: 'rest', restRate: 10 });
    expect(result.until - result.legs.at(-1)!.start).toBeCloseTo(0.5);
  });

  it('keeps an unfinished reservation through saving and avoids reserving the same member’s seat twice', () => {
    const { state, near, from } = breakRoomHotel();
    const active = worker({ fatigueBreak: { at: { gridX: near.gridX, gridY: near.gridY, floor: near.floor },
      placeId: near.id, start: from - 0.2, end: from + 0.3 } });
    const resting = withPlan({ ...state, staffRoster: [active] }, [makeStay(active.fatigueBreak!.at, from - 0.2, from + 0.3, 'rest', { placeId: near.id, restRate: 25 })]);
    expect(saveGame(resting, new PRNG(8))).toBe(true);
    const restored = loadGame()!.state;
    expect(restored.staffRoster![0].fatigueBreak).toEqual(active.fatigueBreak);
    expect(restReservations(restored, restored.staffRoster, from)).toEqual([{ staffId: 'h1', placeId: near.id, start: from - 0.2, end: from + 0.3 }]);
    expect(restReservations(restored, restored.staffRoster, from + 0.4)).toEqual([]);
  });

  it('does not count a saved seat and its resumed itinerary as two different occupants', () => {
    const { state, near, at, from, arrival } = breakRoomHotel();
    const resting = Array.from({ length: BREAK_ROOM.seats - 1 }, (_, i) => worker({ id: `resting-${i}`,
      fatigueBreak: { at: near, placeId: near.id, start: from - 0.3, end: from + 1 } }));
    const current = { ...state, staffRoster: [state.staffRoster![0], ...resting], staffPlan: { start: from,
      itineraries: resting.map(member => ({ staffId: member.id, legs: [makeStay(near, from, from + 1, 'rest', { placeId: near.id, restRate: 25 })], end: { at: near } })) } };
    const reservations = restReservations(current, current.staffRoster, from + 0.01);
    expect(reservations).toHaveLength(BREAK_ROOM.seats - 1);
    const result = planStaffRest(current, current.staffRoster[0], at, from, reservations);
    expect(result.reservation.placeId).toBe(near.id);
    expect(result.reservation.start).toBeCloseTo(arrival);
  });

  it('keeps a fully fresh idle worker near the next job instead of making a needless trip to another floor’s break room', () => {
    const member = worker({ at: { gridX: 5, gridY: 1, floor: 1 },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: 36 } });
    let state = buildFloor(hotel(member))!.state;
    state = addElevator(state, 0, 0)!;
    state = addFixture(state, 'closet', 5, 0, 1)!;
    state = addFixture(state, 'breakroom', 4, 0, 0)!;
    const itinerary = getStaffPlan(state).itineraries.find(plan => plan.staffId === member.id)!;
    expect(itinerary.end.at).toMatchObject({ gridX: 5, gridY: 1, floor: 1 });
    expect(itinerary.end.carry).toBeUndefined();
    expect(itinerary.legs.some(leg => leg.kind === 'walk')).toBe(false);
    expect(itinerary.legs).toContainEqual(expect.objectContaining({ kind: 'stay', activity: 'rest', start: 36, end: 37 }));
  });
});

describe('Compulsory breaks preserve actual work and elapsed rest', () => {
  it('pauses ordinary turnover work exactly at fatigue 85, then takes a full half-hour break', () => {
    const member = worker({ stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 84, fatigueAt: 36 } });
    let state = addFixture(hotel(member), 'breakroom', 5, 0, 0)!;
    const room = state.rooms[0];
    state = { ...state, rooms: [{ ...room, status: 'cleaning', cleaningHoursRemaining: 10 }],
      staffRoster: [{ ...member, roomId: room.id }] };
    const plan = getStaffPlan(state), legs = plan.itineraries[0].legs;
    const work = legs.find(leg => leg.kind === 'stay' && leg.job === 'turnover')!;
    const rest = legs.find(leg => leg.kind === 'stay' && leg.activity === 'rest')!;
    expect(work.start).toBe(36);
    expect(work.end).toBeCloseTo(36 + 1 / 5);
    expect(work.kind === 'stay' && work.workRate).toBe(0.85);
    expect(rest.start).toBeGreaterThan(work.end);
    expect(rest.end - rest.start).toBeCloseTo(0.5);
    expect(rest.kind === 'stay' && rest.restRate).toBe(25);
    expect(rest.kind === 'stay' && rest.placeId).toBe('breakroom-0-5-0');
    const actual = rosterAfter({ ...state, staffPlan: plan }, plan)[0];
    let replanned = replanStaff({ ...state, staffPlan: plan }, rest.start + 0.1);
    replanned = replanStaff(replanned, rest.start + 0.2);
    const updated = getStaffPlan(replanned);
    const resumed = updated.itineraries[0].legs.filter(leg => leg.kind === 'stay' && leg.activity === 'rest' && leg.start < rest.end);
    expect(Math.max(...resumed.map(leg => leg.end))).toBeCloseTo(rest.end);
    expect(rosterAfter(replanned, updated)[0].stats!.fatigue).toBeCloseTo(actual.stats!.fatigue!);
  });

  it('splits at the tired threshold and stores the slower rate on the following work leg', () => {
    const member = worker({ stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 59, fatigueAt: 36 } });
    let state = hotel(member);
    state = { ...state, rooms: [{ ...state.rooms[0], status: 'cleaning', cleaningHoursRemaining: 10 }] };
    const plan = getStaffPlan(state);
    const work = plan.itineraries[0].legs.filter(leg => leg.kind === 'stay' && leg.job === 'turnover');
    expect(work).toHaveLength(2);
    expect(work[0].end).toBeCloseTo(36 + 1 / 5);
    expect(work[1].start).toBeCloseTo(work[0].end);
    expect(work[1].kind === 'stay' && work[1].workRate).toBe(0.85);
    const credited = (work[0].end - work[0].start) + (work[1].end - work[1].start) * 0.85;
    expect(credited).toBeCloseTo(0.2 + 0.8 * 0.85);
    STAFF_FATIGUE.enabled = false;
    const baseline = getStaffPlan({ ...state, staffPlan: null }).itineraries[0].legs;
    expect(baseline.filter(leg => leg.kind === 'stay' && leg.job === 'turnover')).toHaveLength(1);
    expect(baseline.some(leg => leg.kind === 'stay' && leg.activity === 'rest')).toBe(false);
  });
});

describe('Held suites allow for the cleaning crew’s fatigue', () => {
  function suiteHotel(fatigue: number) {
    const member = worker({ stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: 36 } });
    let state = addRoom({ ...hotel(member), peakStarRating: 5 }, 'suite', 6, 2, 0, 'up')!;
    state = addFixture(state, 'breakroom', 5, 0, 0)!;
    const suite = state.rooms.find(room => room.type === 'suite')!;
    state = { ...state, rooms: state.rooms.map(room => room.id === suite.id ? { ...room, status: 'cleaning', cleaningHoursRemaining: 0.5 } : room),
      staffRoster: [{ ...member, at: roomTile(suite), roomId: suite.id }] };
    return { state, suite: state.rooms.find(room => room.id === suite.id)! };
  }

  it('does not promise a near-deadline suite while its assigned cleaner needs a mandatory break', () => {
    const { state, suite } = suiteHotel(85);
    expect(freeBy(state, suite, { kind: 'writer', arrivalDay: 2, arrivalHour: 13 }, true)).toBe(false);
    STAFF_FATIGUE.enabled = false;
    expect(freeBy(state, suite, { kind: 'writer', arrivalDay: 2, arrivalHour: 13 }, true)).toBe(true);
  });

  it('includes a persisted break in the readiness quote and allows overnight recovery before tomorrow’s work', () => {
    const { state, suite } = suiteHotel(40);
    const room = state.fixtures.find(fixture => fixture.type === 'breakroom')!;
    const pending: HotelState = { ...state, staffRoster: [{ ...state.staffRoster![0], at: room,
      fatigueBreak: { at: room, placeId: room.id, start: 35.9, end: 36.5 } }] };
    expect(freeBy(pending, suite, { kind: 'writer', arrivalDay: 2, arrivalHour: 13 }, true)).toBe(false);
    const tired = { ...state.staffRoster![0], stats: { ...state.staffRoster![0].stats!, fatigue: 85, fatigueAt: 47 } };
    const overnight: HotelState = { ...state, hour: 23, staffRoster: [tired],
      rooms: state.rooms.map(room => room.id === suite.id ? { ...room, cleaningHoursRemaining: 2 } : room) };
    expect(freeBy(overnight, overnight.rooms.find(room => room.id === suite.id)!, { kind: 'writer', arrivalDay: 3, arrivalHour: 9.1 }, true)).toBe(true);
  });

  it('carries growing fatigue from queued turnovers into the suite’s estimate', () => {
    const { state, suite } = suiteHotel(55);
    const first = state.rooms.find(room => room.id !== suite.id)!;
    const busy: HotelState = { ...state, rooms: state.rooms.map(room => ({ ...room, status: 'cleaning', cleaningHoursRemaining: 1 })),
      staffRoster: [{ ...state.staffRoster![0], at: roomTile(first), roomId: first.id }] };
    const deadline = 12 + 2 + baseWalkHours(busy) + 0.02;
    expect(freeBy(busy, busy.rooms.find(room => room.id === suite.id)!, { kind: 'writer', arrivalDay: 2, arrivalHour: deadline }, true)).toBe(false);
    STAFF_FATIGUE.enabled = false;
    expect(freeBy(busy, busy.rooms.find(room => room.id === suite.id)!, { kind: 'writer', arrivalDay: 2, arrivalHour: deadline }, true)).toBe(true);
  });
});
