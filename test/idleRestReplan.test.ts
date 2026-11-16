// Spare-time recovery against a paused edit (StaffManager.replanStaff / planHour): an idle rest gives way to new work at
// once, and with nothing new keeps its spot and seat; a compulsory break keeps its fixed end (design: "Ordinary idle
// recovery can be interrupted by new work; a compulsory break keeps its fixed end across hour boundaries, paused edits
// and reloads").
import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, addFixture, demolishFixture, demolishRoom } from '../src/simulation/HotelState.js';
import { getStaffPlan, replanStaff, rosterAfter } from '../src/simulation/StaffManager.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { dismissStaff, hireCandidate, hiringCandidates } from '../src/simulation/StaffHiring.js';
import { hourStart, positionAt, makeWalk, makeStay, sameTile } from '../src/simulation/Movement.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { routeToStreet, routeFromStreet, doorTile, isHallway } from '../src/simulation/Layout.js';
import { physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { fatigueAt, projectFatigue, breakRoomOccupancy, keepRestSpot } from '../src/simulation/StaffFatigue.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { saveGame, loadGame } from '../src/simulation/SaveManager.js';
import { TRAVEL, BREAK_ROOM } from '../src/config/balance.js';
import { STAFF_FATIGUE } from '../src/config/staff.js';
import type { Guest, HotelState, Leg, Room, SpotlightPlan, StaffMember, StayLeg, TilePos } from '../src/simulation/types.js';

const SPEEDS = {
  slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
  mid: { experience: 'skilled', style: 'standard', workHours: 100 },
  fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
} as const;

/** A housekeeper standing at `at` (a room: in it), `fatigue` as of the hour's start. */
function keeper(id: string, at: Room | TilePos, abs: number, o: { speed?: keyof typeof SPEEDS; fatigue?: number; keeps?: boolean; stamina?: 'low' | 'normal' | 'high' } = {}): StaffMember {
  const p = SPEEDS[o.speed ?? 'mid'];
  const room = 'id' in at ? at as Room : undefined;
  return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: room ? roomTile(room) : at, ...(o.keeps && room ? { roomId: room.id } : {}),
    profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: o.stamina ?? 'normal', specialty: 'turnover_runner' },
    stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: o.fatigue ?? 0, fatigueAt: abs } } as StaffMember;
}

/** The starter hotel on `day` at `hour`: a break room at (5, 0) if asked (its front at (5, 1)), suites then standard rooms on row 2 from x = 3, the hour planned. */
function hotel(o: { day?: number; hour?: number; breakRoom?: boolean; suites?: number; rooms: number; dirty?: Record<number, number>; crew: (rooms: Room[], abs: number) => StaffMember[] }): HotelState {
  const day = o.day ?? 2, hour = o.hour ?? 12;
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
  if (o.breakRoom) s = addFixture(s, 'breakroom', 5, 0, 0)!;
  for (let x = 0; x < (o.suites ?? 0); x++) s = addRoom(s, 'suite', 3 + x, 2, 0, 'up')!;
  for (let i = 0; i < o.rooms; i++) s = addRoom(s, 'standard', 3 + (o.suites ?? 0) + i, 2, 0, 'up')!;
  const abs = (day - 1) * 24 + hour;
  const crew = o.crew(s.rooms, abs);
  s = { ...s, day, hour, guests: [], noiseSources: [], staffPlan: null,
    rooms: s.rooms.map((r, i) => (o.dirty?.[i] !== undefined ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: o.dirty[i] } : r)),
    staff: { ...s.staff, housekeepers: crew.filter(m => m.role === 'housekeeper').length, maintenanceWorkers: crew.filter(m => m.role === 'maintenance').length }, staffRoster: crew };
  return { ...s, staffPlan: getStaffPlan(s) };
}

const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)!.legs;
const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
/** Where someone is at x and doing what (rest rate and seat included). */
const where = (s: HotelState, id: string, x: number) => {
  const p = positionAt(legsOf(s, id), x)!;
  return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
};
const committed = (s: HotelState, id: string) => rosterAfter(s, getStaffPlan(s)).find(m => m.id === id)!.stats!.fatigue!;
const dirty = (s: HotelState, index: number, hours: number): HotelState =>
  ({ ...s, rooms: s.rooms.map((r, i) => (i === index ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: hours } : r)) });

describe('Idle recovery gives way to new work at a paused edit', () => {
  it('the review case: the housekeeper the held suite was kept for let go at 12:06, the idle one takes it at once and the writer checks in on time', () => {
    // 12:00, writer due 15:00; S 2.5h, X 1.5h. The plan keeps S for hk-fast, hk-slow takes X, hk-mid steps out and rests till 13:00
    let s0: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s0 = addRoom(s0, 'suite', 3, 2, 0, 'up')!;
    for (let x = 4; x < 6; x++) s0 = addRoom(s0, 'standard', x, 2, 0, 'up')!;
    const abs = 8 * 24 + 12;
    const crew = [keeper('hk-fast', s0.rooms[2], abs, { speed: 'fast', stamina: 'high' }), keeper('hk-slow', s0.rooms[2], abs, { speed: 'slow', stamina: 'high' }), keeper('hk-mid', s0.rooms[2], abs, { stamina: 'high' })];
    s0 = { ...s0, day: 9, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s0.staff, housekeepers: 3 },
      staffRoster: [...crew, ...(s0.staffRoster ?? []).filter(m => m.role !== 'housekeeper')],
      rooms: s0.rooms.map((r, i) => (i < 2 ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: [2.5, 1.5][i] } : r)) };
    const S = s0.rooms[0];
    const spotlight: SpotlightPlan = { kind: 'writer', week: 1, salt: '', announceDay: 9, arrivalDay: 9, arrivalHour: 15, status: 'announced', chainId: 'spotlight-10', roomId: S.id };
    const held = { ...s0, spotlight };
    const s = { ...held, staffPlan: getStaffPlan(held) };
    expect(s.staffPlan.rush).toEqual({ roomId: S.id, staffId: 'hk-fast' });
    expect(restsOf(s, 'hk-mid')).toMatchObject([{ idle: true, end: hourStart(s) + 1 }]);
    const t = hourStart(s) + 0.1;
    const re = settleChanges(s, dismissStaff(s, 'hk-fast', t)!, t);
    const onS = jobsOf(re, 'hk-mid').find(l => l.placeId === S.id)!;
    expect(onS.start).toBeLessThan(t + 0.15); // walks straight there
    let st = re, at: number | undefined;
    for (let h = 0; h < 6 && at === undefined; h++) {
      const r = tickSimulation(st, new PRNG(7 + h));
      st = r.state;
      if (r.events.some(e => e.type === 'spotlight_arrived')) at = st.hour;
    }
    expect(at).toBe(15);
  });

  it('a tired idle worker (80 at the hour\'s start) still gives way: a room dirtied at +0.3 is hers at once', () => {
    const s = hotel({ breakRoom: true, rooms: 4, dirty: { 0: 3 },
      crew: (r, abs) => [keeper('busy', r[0], abs, { fatigue: 10, keeps: true }), keeper('idle', { gridX: 5, gridY: 1, floor: 0 }, abs, { fatigue: 80 })] });
    const T = hourStart(s);
    expect(restsOf(s, 'idle')).toMatchObject([{ idle: true, placeId: expect.any(String), restRate: STAFF_FATIGUE.roomRecovery }]);
    const re = settleChanges(s, dirty(s, 1, 0.2), T + 0.3);
    expect(jobsOf(re, 'idle')[0]).toMatchObject({ placeId: s.rooms[1].id });
    expect(jobsOf(re, 'idle')[0].start).toBeLessThan(T + 0.45);
    // the merged hour commits fatigue once, from the legs actually planned
    const m = s.staffRoster!.find(x => x.id === 'idle')!;
    expect(committed(re, 'idle')).toBeCloseTo(projectFatigue(m, legsOf(re, 'idle'), T, T + 1), 9);
    expect(tickSimulation(re, new PRNG(5)).state.staffRoster!.find(x => x.id === 'idle')!.stats!.fatigue).toBeCloseTo(committed(re, 'idle'), 9);
  });

  it('with nothing new to do, she stays where she was resting: her seat in the break room, or the hallway outside a room', () => {
    for (const breakRoom of [true, false]) {
      const s = hotel({ breakRoom, rooms: 4, dirty: { 0: 3 },
        crew: (r, abs) => [keeper('busy', r[0], abs, { fatigue: 10, keeps: true }), keeper('idle', breakRoom ? { gridX: 5, gridY: 1, floor: 0 } : r[2], abs, { fatigue: 30 })] });
      const T = hourStart(s);
      expect(restsOf(s, 'idle')).toMatchObject([{ idle: true, restRate: breakRoom ? STAFF_FATIGUE.roomRecovery : STAFF_FATIGUE.fallbackRecovery }]);
      // a paused replan, a room built far away, and a hire: none gives her work
      const offer = hiringCandidates(s, 'housekeeper')[0];
      for (const re of [replanStaff(s, T + 0.3), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, T + 0.3),
        settleChanges(s, hireCandidate(s, 'housekeeper', offer.id, undefined, T + 0.3)!, T + 0.3)]) {
        for (const x of [0.31, 0.5, 0.75, 0.99]) expect(where(re, 'idle', T + x)).toBe(where(s, 'idle', T + x));
        expect(committed(re, 'idle')).toBeCloseTo(committed(s, 'idle'), 9);
        // still spare time: the next edit can still interrupt it
        expect(restsOf(re, 'idle').at(-1)).toMatchObject({ idle: true, end: T + 1 });
      }
    }
  });

  it('walking to her rest when the edit comes: with nothing new she carries on to the same seat; with work she turns back for it', () => {
    const s = hotel({ breakRoom: true, rooms: 4, dirty: { 0: 3 },
      crew: (r, abs) => [keeper('busy', r[0], abs, { fatigue: 10, keeps: true }), keeper('idle', r[3], abs, { fatigue: 30 })] });
    const T = hourStart(s);
    const walk = legsOf(s, 'idle').find(l => l.kind === 'walk')!;
    const t = (walk.start + walk.end) / 2;
    const same = replanStaff(s, t);
    for (const x of [(t + walk.end) / 2, walk.end - 0.005, walk.end + 0.01, 0.5 + T, 0.99 + T]) expect(where(same, 'idle', x)).toBe(where(s, 'idle', x));
    expect(committed(same, 'idle')).toBeCloseTo(committed(s, 'idle'), 9);
    const busy = settleChanges(s, dirty(s, 1, 0.5), t);
    expect(jobsOf(busy, 'idle')[0]).toMatchObject({ placeId: s.rooms[1].id });
    expect(jobsOf(busy, 'idle')[0].start).toBeLessThan(T + 0.4);
  });

  it('a seated idle worker\'s seat is hers through any number of edits, even with the room full', () => {
    const idle = (abs: number) => Array.from({ length: 7 }, (_, i) => keeper(`idle-${i}`, { gridX: 5, gridY: 1, floor: 0 }, abs, { fatigue: 30 }));
    const s = hotel({ breakRoom: true, rooms: 4, dirty: { 0: 3 }, crew: (r, abs) => [keeper('busy', r[0], abs, { fatigue: 10, keeps: true }), ...idle(abs)] });
    const T = hourStart(s);
    let st = s;
    for (const x of [0.3, 0.35, 0.4]) st = replanStaff(st, T + x);
    for (let i = 0; i < 7; i++) for (const x of [0.45, 0.99]) expect(where(st, `idle-${i}`, T + x)).toBe(where(s, `idle-${i}`, T + x));
  });
});

describe('A compulsory break keeps its fixed end at a paused edit', () => {
  it('started this hour at 85: a room dirtied mid-break waits for its end', () => {
    const s = hotel({ breakRoom: true, rooms: 4, dirty: { 0: 3 }, crew: (r, abs) => [keeper('hk', r[0], abs, { fatigue: 84, keeps: true })] });
    const [rest] = restsOf(s, 'hk');
    expect(rest.idle).toBeUndefined();
    expect(fatigueAt(s, s.staffRoster![0], rest.start)).toBeGreaterThanOrEqual(STAFF_FATIGUE.breakAt - 1e-9);
    let st = settleChanges(s, dirty(s, 1, 0.5), rest.start + 0.1);
    st = replanStaff(st, rest.start + 0.2);
    expect(Math.max(...restsOf(st, 'hk').filter(l => l.start >= rest.start - 1e-9).map(l => l.end))).toBeCloseTo(rest.end, 9);
    expect(jobsOf(st, 'hk').some(l => l.start > rest.start && l.start < rest.end - 1e-9)).toBe(false);
  });

  it('a counter block that ends at the break threshold leaves a break, not spare time: kept through new work', () => {
    // 14:00, no clerks: a reception-trained housekeeper at 82 covers the lane till 85, then rests
    const base = addRoom({ ...createStarterHotel(), day: 2, hour: 14, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
    const lane = physicalDeskLanes(base)[0], T = hourStart(base);
    const k = { ...keeper('keeper', lane.front, T, { fatigue: 82 }), profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', receptionTrained: true } } as StaffMember;
    const s0: HotelState = { ...base, guests: [], frontDeskRosterReady: true, staffRoster: [k], staffPlan: null, staff: { frontDesk: 0, housekeepers: 1, maintenanceWorkers: 0 } };
    const s = { ...s0, staffPlan: getStaffPlan(s0) };
    const [rest] = restsOf(s, 'keeper');
    expect(legsOf(s, 'keeper').some(l => l.kind === 'stay' && l.activity === 'desk' && Math.abs(l.end - rest.start) < 1e-9)).toBe(true);
    expect(rest.idle).toBeUndefined();
    const re = settleChanges(s, dirty(s, 0, 0.5), rest.start + 0.1);
    expect(jobsOf(re, 'keeper')).toEqual([]);
    expect(restsOf(re, 'keeper').at(-1)!.end).toBeCloseTo(rest.end, 9);
  });
});

const PACE = TRAVEL.guestHoursPerTile;
/** A do-not-disturb guest in `room` going out at `leave`, back at `back`. */
function goingOut(s: HotelState, room: Room, leave: number, back: number): Guest {
  const tile = roomTile(room);
  const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
  const walkOut = makeWalk(out.path, leave, PACE);
  const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
  return { id: 'd', name: 'd', budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
    profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
    tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
}

describe('Resting at home for a do-not-disturb party to go out', () => {
  // 12:00 on day 3: D's party goes out at 12:36; hk-a turns over X; hk-b has nothing else, so rests at the lobby till she sets off for D
  const setup = () => {
    let s = hotel({ day: 3, rooms: 3, dirty: { 1: 1.5 }, crew: (r, abs) => [keeper('hk-a', r[1], abs, { keeps: true, stamina: 'high' }), keeper('hk-b', r[2], abs, { stamina: 'high' })] });
    const T = hourStart(s), D = s.rooms[0];
    s = { ...s, staffPlan: null, guests: [goingOut(s, D, T + 0.6, T + 4)], rooms: s.rooms.map(r => (r.id === D.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.5 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, D, X: s.rooms[1] };
  };

  it('is spare time: let go of the one on X and she takes X at once', () => {
    const { s, T, X } = setup();
    expect(restsOf(s, 'hk-b')).toMatchObject([{ idle: true, restRate: STAFF_FATIGUE.fallbackRecovery }]);
    const re = settleChanges(s, dismissStaff(s, 'hk-a', T + 0.1)!, T + 0.1);
    expect(jobsOf(re, 'hk-b')[0]).toMatchObject({ placeId: X.id });
    expect(jobsOf(re, 'hk-b')[0].start).toBeLessThan(T + 0.25);
  });

  it('with nothing new, she rests on till the set-off already planned (not off early to wait at the door)', () => {
    for (const dt of [0.1, 0.3, 0.45]) {
      const { s, T, D } = setup();
      const offer = hiringCandidates(s, 'housekeeper')[0];
      const re = settleChanges(s, hireCandidate(s, 'housekeeper', offer.id, undefined, T + dt)!, T + dt);
      for (const x of [dt + 0.01, 0.55, 0.7, 0.99]) expect(where(re, 'hk-b', T + x)).toBe(where(s, 'hk-b', T + x));
      expect(jobsOf(re, 'hk-b').map(l => l.placeId)).toEqual([D.id]);
    }
  });
});

describe('Saves', () => {
  it('the idle marker survives a save, so an edit after loading still interrupts the rest; a plan saved without it keeps the rest for that hour', () => {
    const s = hotel({ rooms: 4, dirty: { 0: 3 }, crew: (r, abs) => [keeper('busy', r[0], abs, { fatigue: 10, keeps: true }), keeper('idle', r[2], abs)] });
    const T = hourStart(s), t = T + 0.3;
    expect(saveGame(s, new PRNG(4))).toBe(true);
    const loaded = loadGame()!.state;
    expect(restsOf(loaded, 'idle')).toMatchObject([{ idle: true }]);
    expect(jobsOf(settleChanges(loaded, dismissStaff(loaded, 'busy', t)!, t), 'idle')[0]).toMatchObject({ placeId: s.rooms[0].id });
    // An older save's legs carry no marker: the rest is kept as a fixed one, as before, only to the hour's end
    const old = { ...s, staffPlan: { ...s.staffPlan!, itineraries: s.staffPlan!.itineraries.map(it => ({ ...it,
      legs: it.legs.map(l => { if (l.kind !== 'stay') return l; const { idle: _idle, ...rest } = l; return rest; }) })) } };
    const re = settleChanges(old, dismissStaff(old, 'busy', t)!, t);
    expect(jobsOf(re, 'idle')).toEqual([]);
    const next = tickSimulation(re, new PRNG(5)).state;
    expect(jobsOf(next, 'idle')[0]).toMatchObject({ placeId: s.rooms[0].id });
  });
});

describe('Settle re-plans twice at one instant', () => {
  it('a worker released to new work that ends in a break across the hour keeps the work at the second re-plan', () => {
    // 12:00 on day 9: hk-slow on S (2.5h), hk-fast on X (1.5h), hk-mid (84) with nothing to do rests till 13:00
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 0; x < 3; x++) s = addRoom(s, x === 0 ? 'suite' : 'standard', x + 3, 2, 0, 'up')!;
    const abs = 8 * 24 + 12;
    const crew = [keeper('hk-fast', s.rooms[2], abs, { speed: 'fast', stamina: 'high' }), keeper('hk-slow', s.rooms[2], abs, { speed: 'slow', stamina: 'high' }),
      keeper('hk-mid', s.rooms[2], abs, { fatigue: 84, stamina: 'high' })];
    s = { ...s, day: 9, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 3 },
      staffRoster: [...crew, ...(s.staffRoster ?? []).filter(m => m.role !== 'housekeeper')],
      rooms: s.rooms.map((r, i) => (i < 2 ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: [2.5, 1.5][i] } : r)) };
    s = { ...s, staffPlan: getStaffPlan(s) };
    const T = hourStart(s), t = T + 0.1, X = s.rooms[1].id;
    expect(jobsOf(s, 'hk-mid')).toEqual([]);
    // settleChanges re-plans twice at t: this roster has no named clerks yet, and Settle naming them changes the desk's lanes
    const re = settleChanges(s, dismissStaff(s, 'hk-fast', t)!, t);
    expect(jobsOf(re, 'hk-mid').filter(l => l.end > t).map(l => l.placeId)).toContain(X);
    expect(positionAt(legsOf(re, 'hk-mid'), t + 0.2)?.leg).toMatchObject({ activity: 'clean', placeId: X });
    // ... then the half-hour break at 85, carried past the hour, not a wait for it in place of the work
    expect(getStaffPlan(re).itineraries.find(it => it.staffId === 'hk-mid')!.end.fatigueBreak!.end).toBeGreaterThan(T + 1);
    expect(legsOf(re, 'hk-mid').some(l => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 0.1)).toBe(false);
  });
});

describe('Resting again after the work an edit brought (mutation check)', () => {
  it('after a short job the edit brought, she rests in the hall just outside the room she cleaned, not back at the spot she was resting at', () => {
    // 12:00, no break room: "idle" (30) rests in the hall outside the end room; at +0.3 a room two doors along needs 0.2h
    const s = hotel({ rooms: 4, dirty: { 0: 3 }, crew: (r, abs) => [keeper('busy', r[0], abs, { fatigue: 10, keeps: true }), keeper('idle', r[3], abs, { fatigue: 30 })] });
    const T = hourStart(s), X = s.rooms[1], last = s.rooms[3];
    expect(restsOf(s, 'idle')).toMatchObject([{ idle: true, at: doorTile(last, last.door), end: T + 1 }]);
    const re = settleChanges(s, dirty(s, 1, 0.2), T + 0.3);
    const [job] = jobsOf(re, 'idle');
    expect(job).toMatchObject({ placeId: X.id });
    // done well before the hour is up: a fresh rest from there, just the step out of the room (no walk back along the hall)
    const after = restsOf(re, 'idle').at(-1)!;
    expect(after).toMatchObject({ idle: true, at: doorTile(X, X.door), restRate: STAFF_FATIGUE.fallbackRecovery, end: T + 1 });
    expect(after.start).toBeCloseTo(job.end + TRAVEL.hoursPerTile, 9);
  });

  it('a job finished late in the hour: she rests in the hall outside it for the few minutes left, rather than walking back to her break-room seat', () => {
    // as above with the break room: she was resting in its seat; the room dirtied at +0.3 needs 0.5h, so it's done near 12:55
    const s = hotel({ breakRoom: true, rooms: 4, dirty: { 0: 3 }, crew: (r, abs) => [keeper('busy', r[0], abs, { fatigue: 10, keeps: true }), keeper('idle', r[3], abs, { fatigue: 30 })] });
    const T = hourStart(s), X = s.rooms[1];
    expect(restsOf(s, 'idle')).toMatchObject([{ idle: true, placeId: expect.any(String), restRate: STAFF_FATIGUE.roomRecovery }]);
    const re = settleChanges(s, dirty(s, 1, 0.5), T + 0.3);
    const [job] = jobsOf(re, 'idle');
    expect(job).toMatchObject({ placeId: X.id });
    expect(job.end).toBeGreaterThan(T + 0.85);
    // the walk back would eat nearly all that's left of the hour: resting just outside recovers more by 13:00
    const after = restsOf(re, 'idle').at(-1)!;
    expect(after).toMatchObject({ idle: true, at: doorTile(X, X.door), restRate: STAFF_FATIGUE.fallbackRecovery, end: T + 1 });
    expect(after.placeId).toBeUndefined();
    expect(after.start).toBeCloseTo(job.end + TRAVEL.hoursPerTile, 9);
  });
});

describe('Resting at home for a do-not-disturb party: the planned set-off (mutation check)', () => {
  // 12:00 on day 3: D's party goes out at `leave`; hk-a turns over X (1.5h); hk-b, with nothing else, rests at the staff base by the desk till she sets off for D
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  const setup = (leave: number, at?: TilePos) => {
    let s = hotel({ day: 3, rooms: 3, dirty: { 1: 1.5 }, crew: (r, abs) => [keeper('hk-a', r[1], abs, { keeps: true, stamina: 'high' }), keeper('hk-b', at ?? r[2], abs, { stamina: 'high' })] });
    const T = hourStart(s), D = s.rooms[0];
    s = { ...s, staffPlan: null, guests: [goingOut(s, D, T + leave, T + 4)], rooms: s.rooms.map(r => (r.id === D.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.5 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, D, X: s.rooms[1] };
  };

  it('let go of the one cleaning another do-not-disturb room whose party is out: she takes that room at once, not after the set-off she was resting for', () => {
    // D1's party goes out at 12:45, D2's at 12:06; hk-c waits at D2's door and cleans it, hk-b rests at the base till she sets off for D1
    let s = hotel({ day: 3, rooms: 3, crew: (r, abs) => [keeper('hk-c', r[2], abs, { stamina: 'high' }), keeper('hk-b', r[2], abs, { stamina: 'high' })] });
    const T = hourStart(s), [D1, D2] = s.rooms;
    s = { ...s, staffPlan: null, guests: [goingOut(s, D1, T + 0.75, T + 4), { ...goingOut(s, D2, T + 0.1, T + 4), id: 'd2', name: 'd2' }],
      rooms: s.rooms.map(r => (r.id === D1.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.5 }
        : r.id === D2.id ? { ...r, status: 'occupied' as const, guestId: 'd2', dailyCleanHoursRemaining: 0.9 } : r)) };
    s = { ...s, staffPlan: getStaffPlan(s) };
    expect(jobsOf(s, 'hk-c').map(l => l.placeId)).toEqual([D2.id]);
    expect(restsOf(s, 'hk-b')).toMatchObject([{ idle: true, at: BASE }]);
    expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D1.id]);
    const t = T + 0.3;
    const re = settleChanges(s, dismissStaff(s, 'hk-c', t)!, t);
    const next = jobsOf(re, 'hk-b').find(l => l.end > t)!;
    expect(next.placeId).toBe(D2.id);
    expect(next.start).toBeLessThan(t + 0.25); // straight there: 12:31, not after resting on till 12:40 (12:52)
  });

  it('two paused edits: the rest kept at home through the first is still spare time, so the second, letting go of the one on X, gets her onto X at once', () => {
    const { s, T, X } = setup(0.6);
    const t1 = T + 0.3, t2 = T + 0.33;
    // a room built far away: nothing new, she rests on at the base till the set-off
    const s1 = settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t1);
    for (const x of [0.31, 0.45]) expect(where(s1, 'hk-b', T + x)).toBe(where(s, 'hk-b', T + x));
    const s2 = settleChanges(s1, dismissStaff(s1, 'hk-a', t2)!, t2);
    const onX = jobsOf(s2, 'hk-b').find(l => l.placeId === X.id)!;
    expect(onX.start).toBeLessThan(t2 + 0.25); // 12:32, not after the set-off at 12:31 (12:43)
  });

  it('re-planned on her way to rest at the base, with nothing new: she never stops to rest in the corridor, and is at the door as the party goes out', () => {
    // She walks from her room to the base (12:00 to 12:14), rests there, and sets off for D at 12:19
    const { s, T, D } = setup(0.4);
    const [walk] = legsOf(s, 'hk-b');
    expect(walk).toMatchObject({ kind: 'walk', start: T });
    expect(restsOf(s, 'hk-b')).toMatchObject([{ idle: true, at: BASE }]);
    const onD = jobsOf(s, 'hk-b')[0];
    expect(onD.placeId).toBe(D.id);
    for (const x of [0.13, 0.16, 0.19]) {
      const t = T + x;
      expect(t).toBeLessThan(walk.end);
      for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t)]) {
        for (const rest of restsOf(re, 'hk-b').filter(l => l.end > t + 1e-9)) expect(rest.at).toMatchObject(BASE);
        expect(jobsOf(re, 'hk-b')[0]).toMatchObject({ placeId: D.id });
        expect(jobsOf(re, 'hk-b')[0].start).toBeCloseTo(onD.start, 9);
      }
    }
  });

  it('a room built across her way to the door while she rests at the base: she sets off sooner, and is still there as the party goes out', () => {
    // At the base from 12:00; D's party goes out at 12:36: the plan sets off at 12:31 by the corridor beside the desk
    const { s, T, D } = setup(0.6, BASE);
    const onD = jobsOf(s, 'hk-b')[0];
    expect(onD.placeId).toBe(D.id);
    expect(restsOf(s, 'hk-b')).toMatchObject([{ idle: true, at: BASE, start: T }]);
    // 12:06: a room on (2, 2) closes that corridor; the way round, by the street door, is two tiles longer
    const t = T + 0.1;
    const re = settleChanges(s, addRoom(s, 'standard', 2, 2, 0, 'left')!, t);
    expect(where(re, 'hk-b', T + 0.48)).toMatch(/walk$/); // set off by 12:27, not resting on till 12:31
    expect(jobsOf(re, 'hk-b')[0]).toMatchObject({ placeId: D.id });
    expect(jobsOf(re, 'hk-b')[0].start).toBeCloseTo(onD.start, 9);
  });
});

describe('Only a walk straight to a carried break keeps it (mutation check)', () => {
  it('a reception-trained housekeeper walking to cover the counter when a room is built still covers it till her break at 85 there, not standing at it waiting for the break', () => {
    // 14:00, no clerks, no break room: at 80.5 she walks from her room to the lane, covers it till 85, then rests right there (the nearest staff base)
    const base = addRoom({ ...createStarterHotel(), day: 2, hour: 14, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
    const lane = physicalDeskLanes(base)[0], T = hourStart(base);
    const k = { ...keeper('keeper', base.rooms[0], T, { fatigue: 80.5 }), profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', receptionTrained: true } } as StaffMember;
    const s0: HotelState = { ...base, guests: [], frontDeskRosterReady: true, staffRoster: [k], staffPlan: null, staff: { frontDesk: 0, housekeepers: 1, maintenanceWorkers: 0 } };
    const s = { ...s0, staffPlan: getStaffPlan(s0) };
    const walk = legsOf(s, 'keeper')[0];
    const desk = legsOf(s, 'keeper').find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk')!;
    expect(walk).toMatchObject({ kind: 'walk', path: expect.arrayContaining([lane.front]) });
    expect(desk.start).toBeCloseTo(walk.end, 9);
    expect(desk.end).toBeGreaterThan(T + 0.5);
    // a room built at 14:06 while she's on her way, and another at 14:12: the counter is hers from her arrival till 85 all the same
    const re1 = settleChanges(s, addRoom(s, 'standard', 9, 2, 0, 'up')!, T + 0.1);
    const re2 = settleChanges(re1, addRoom(re1, 'standard', 7, 2, 0, 'up')!, T + 0.2);
    for (const re of [re1, re2]) {
      for (const x of [desk.start + 0.01, T + 0.5, desk.end - 0.01]) expect(where(re, 'keeper', x)).toBe(where(s, 'keeper', x));
      // ... and then her break, at the counter, carried on past the hour
      const brk = getStaffPlan(re).itineraries.find(it => it.staffId === 'keeper')!.end.fatigueBreak!;
      expect(brk.start).toBeCloseTo(desk.end, 9);
      expect(brk.at).toEqual(lane.front);
      expect(legsOf(re, 'keeper').some(l => l.kind === 'stay' && l.activity === 'wait')).toBe(false);
    }
  });

  it('on her way to a do-not-disturb door to wait for the party to go out, a paused edit leaves her the clean, not off to the break room to wait for the break due after it', () => {
    // 12:00 on day 3: D's party goes out at 12:12; at 82 she walks from the break room's front to D's door, waits, cleans, then
    // (at 85) takes a half-hour break in the break room across the hour
    let s = hotel({ day: 3, breakRoom: true, rooms: 3, crew: (r, abs) => [keeper('hk', { gridX: 5, gridY: 1, floor: 0 }, abs, { fatigue: 82 })] });
    const T = hourStart(s), D = s.rooms[0];
    s = { ...s, staffPlan: null, guests: [goingOut(s, D, T + 0.2, T + 4)], rooms: s.rooms.map(r => (r.id === D.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.5 } : r)) };
    s = { ...s, staffPlan: getStaffPlan(s) };
    const [walk, wait] = legsOf(s, 'hk');
    expect(walk.kind).toBe('walk');
    expect(wait).toMatchObject({ kind: 'stay', activity: 'wait' });
    const [clean] = jobsOf(s, 'hk');
    expect(clean).toMatchObject({ placeId: D.id });
    const brk = getStaffPlan(s).itineraries.find(it => it.staffId === 'hk')!.end.fatigueBreak!;
    expect(brk).toMatchObject({ placeId: expect.any(String) });
    expect(brk.start).toBeGreaterThan(clean.end);
    expect(brk.end).toBeGreaterThan(T + 1);
    const t = (walk.start + walk.end) / 2;
    for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t)]) {
      expect(jobsOf(re, 'hk').filter(l => l.end > t).map(l => l.placeId)).toEqual([D.id]);
      for (const x of [wait.start + 0.01, clean.start + 0.01, clean.end - 0.01, brk.start + 0.01]) expect(where(re, 'hk', x)).toBe(where(s, 'hk', x));
    }
  });

  it('turned for her break early by one edit, so waiting in the break room for its start, a second edit on the way there keeps the break\'s fixed start and end', () => {
    // 12:00, low stamina at 80: she finishes her room by 12:35, walks to the far one and reaches 85 as she gets there, so goes
    // straight on to the break room for a half-hour break across the hour
    const s = hotel({ breakRoom: true, rooms: 6, dirty: { 0: 0.5, 5: 1 }, crew: (r, abs) => [keeper('hk', r[0], abs, { fatigue: 80, stamina: 'low', keeps: true })] });
    const T = hourStart(s), far = roomTile(s.rooms[5]);
    const brk = getStaffPlan(s).itineraries.find(it => it.staffId === 'hk')!.end.fatigueBreak!;
    expect(brk).toMatchObject({ placeId: expect.any(String) });
    expect(brk.end).toBeGreaterThan(T + 1);
    const there = legsOf(s, 'hk').find(l => l.kind === 'walk' && l.path.at(-1)!.gridX === far.gridX && l.path.at(-1)!.gridY === far.gridY)!;
    expect(there.end).toBeLessThan(brk.start);
    // A room built far off as she walks to it: she turns for the break room, gets there early and waits for the break's start
    const t1 = (there.start + there.end) / 2;
    const s1 = settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t1);
    const fixed = (st: HotelState) => getStaffPlan(st).itineraries.find(it => it.staffId === 'hk')!.end.fatigueBreak;
    expect(fixed(s1)).toMatchObject({ start: brk.start, end: brk.end });
    const early = legsOf(s1, 'hk').find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end > t1)!;
    expect(early).toMatchObject({ at: brk.at, end: brk.start });
    // Another room built before she gets there: the same break, from the same start to the same end
    const t2 = (t1 + early.start) / 2;
    const s2 = settleChanges(s1, addRoom(s1, 'standard', 6, 5, 0, 'up')!, t2);
    expect(fixed(s2)).toMatchObject({ start: brk.start, end: brk.end });
    expect(restsOf(s2, 'hk').filter(l => l.end > t2).map(l => [l.start, l.end])).toEqual([[brk.start, brk.end]]);
    for (const x of [early.start + 0.01, brk.start + 0.01, T + 0.99]) expect(where(s2, 'hk', x)).toBe(where(s1, 'hk', x));
  });
});

describe('The room she is headed to, through a compulsory break (mutation check)', () => {
  it('a preventive repair she goes back to after her break is still hers after a paused edit during the break', () => {
    // 12:00: mx (preventive, 82) repairs P (39) while its guest is out till 20:00, working on past 85. By 13:00 P is
    // past 40, kept on her list only as the room she's on: she takes her half-hour break first, then goes back to it
    let s = hotel({ breakRoom: true, rooms: 2, crew: (r, abs) => [{ ...keeper('mx', r[0], abs, { fatigue: 82 }), role: 'maintenance', dailyWage: 80,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', specialty: 'preventive' } } as StaffMember] });
    const P = s.rooms[0];
    const out = goingOut(s, P, hourStart(s) - 0.3, hourStart(s) + 8);
    const guest = { ...out, profile: { ...out.profile!, housekeeping: 'standard' } } as Guest;
    s = { ...s, staffPlan: null, staff: { ...s.staff, housekeepers: 0, maintenanceWorkers: 1 }, guests: [guest],
      rooms: s.rooms.map(r => (r.id === P.id ? { ...r, status: 'occupied' as const, guestId: guest.id, condition: 39, dailyCleanHoursRemaining: 0 } : r)) };
    s = tickSimulation({ ...s, staffPlan: getStaffPlan(s) }, new PRNG(3)).state;
    const T = hourStart(s);
    expect(s.rooms.find(r => r.id === P.id)!.condition).toBeGreaterThan(40);
    const [brk] = restsOf(s, 'mx');
    expect(brk).toMatchObject({ start: expect.any(Number), restRate: STAFF_FATIGUE.roomRecovery });
    expect(brk.idle).toBeUndefined();
    const [repair] = jobsOf(s, 'mx');
    expect(repair).toMatchObject({ placeId: P.id, preventive: true });
    expect(repair.start).toBeGreaterThan(brk.end);
    // a paused replan, a room built far away, and a hire, all mid-break: none changes her repair
    const t = brk.start + 0.1;
    const offer = hiringCandidates(s, 'housekeeper')[0];
    for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t),
      settleChanges(s, hireCandidate(s, 'housekeeper', offer.id, undefined, t)!, t)]) {
      const after = jobsOf(re, 'mx').filter(l => l.end > t);
      expect(after.map(l => [l.placeId, l.preventive])).toEqual([[P.id, true]]);
      expect(after[0].start).toBeCloseTo(repair.start, 9);
      for (const x of [0.6, 0.8, 0.99]) expect(where(re, 'mx', T + x)).toBe(where(s, 'mx', T + x));
      // ... and still on it at the hour's end, to carry on next hour
      expect(getStaffPlan(re).itineraries.find(it => it.staffId === 'mx')!.end.roomId).toBe(P.id);
    }
  });
});

describe('Idle rests in the rushed plan after a let-go (mutation check)', () => {
  /** The writer due at 15:00 on day 9, the suite S held for them, the hour planned with that. */
  const writerDue = (s: HotelState, S: Room): HotelState => {
    const spotlight: SpotlightPlan = { kind: 'writer', week: 1, salt: '', announceDay: 9, arrivalDay: 9, arrivalHour: 15, status: 'announced', chainId: 'spotlight-10', roomId: S.id };
    const held = { ...s, staffPlan: null, spotlight };
    return { ...held, staffPlan: getStaffPlan(held) };
  };

  it('the held suite rushed again for another idle housekeeper: the one it isn\'t kept for rests on in the hallway where she was, not off to the lobby', () => {
    // 12:00 on day 9: S 2.5h is kept for hk-fast, hk-slow turns over X; hk-a (slow) and hk-b step out of their rooms and rest
    const s0 = hotel({ day: 9, suites: 1, rooms: 3, dirty: { 0: 2.5, 1: 1.5 }, crew: (r, abs) => [keeper('hk-fast', r[2], abs, { speed: 'fast', stamina: 'high' }),
      keeper('hk-slow', r[2], abs, { speed: 'slow', stamina: 'high' }), keeper('hk-a', r[3], abs, { speed: 'slow', stamina: 'high' }), keeper('hk-b', r[2], abs, { stamina: 'high' })] });
    const S = s0.rooms[0], s = writerDue(s0, S), T = hourStart(s);
    expect(s.staffPlan!.rush).toEqual({ roomId: S.id, staffId: 'hk-fast' });
    expect(restsOf(s, 'hk-a')).toMatchObject([{ idle: true, restRate: STAFF_FATIGUE.fallbackRecovery, end: T + 1 }]);
    for (const dt of [0.1, 0.3]) {
      const t = T + dt;
      // hk-fast let go: the rush is decided again, for hk-b (she'd finish S before hk-a), and S is out of hk-a's queue
      const re = settleChanges(s, dismissStaff(s, 'hk-fast', t)!, t);
      expect(getStaffPlan(re).rush).toEqual({ roomId: S.id, staffId: 'hk-b' });
      expect(jobsOf(re, 'hk-b').find(l => l.placeId === S.id)!.start).toBeLessThan(t + 0.15);
      expect(jobsOf(re, 'hk-a')).toEqual([]);
      // hk-a has nothing new: she stays outside her room, resting as before, not walked off to the lobby
      for (const x of [dt + 0.01, 0.5, 0.75, 0.99]) expect(where(re, 'hk-a', T + x)).toBe(where(s, 'hk-a', T + x));
      expect(committed(re, 'hk-a')).toBeCloseTo(committed(s, 'hk-a'), 9);
      expect(restsOf(re, 'hk-a').at(-1)).toMatchObject({ idle: true, end: T + 1 });
    }
  });

  it('the held suite rushed again for another idle housekeeper: the one resting at home for a do-not-disturb party rests on till her planned set-off, not off early to wait at the door', () => {
    // 12:00 on day 9: S 2.5h kept for hk-fast, hk-x on X; D's party goes out at 12:36, so hk-b (slow) rests in the lobby
    // till she sets off for D; hk-c steps out of E and rests
    let s0 = hotel({ day: 9, suites: 1, rooms: 3, dirty: { 0: 2.5, 2: 1.5 }, crew: (r, abs) => [keeper('hk-b', r[3], abs, { speed: 'slow', stamina: 'high' }),
      keeper('hk-fast', r[3], abs, { speed: 'fast', stamina: 'high' }), keeper('hk-x', r[2], abs, { keeps: true, stamina: 'high' }), keeper('hk-c', r[3], abs, { stamina: 'high' })] });
    const [S, D] = s0.rooms, T = hourStart(s0);
    s0 = { ...s0, guests: [{ ...goingOut(s0, D, T + 0.6, T + 4), checkInDay: 8 }],
      rooms: s0.rooms.map(r => (r.id === D.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.5 } : r)) };
    const s = writerDue(s0, S);
    expect(s.staffPlan!.rush).toEqual({ roomId: S.id, staffId: 'hk-fast' });
    const [home] = restsOf(s, 'hk-b');
    expect(home).toMatchObject({ idle: true, restRate: STAFF_FATIGUE.fallbackRecovery });
    expect(home.end).toBeLessThan(T + 0.6);
    expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D.id]);
    for (const dt of [0.3, 0.45]) {
      const t = T + dt;
      const re = settleChanges(s, dismissStaff(s, 'hk-fast', t)!, t);
      expect(getStaffPlan(re).rush).toEqual({ roomId: S.id, staffId: 'hk-c' });
      expect(jobsOf(re, 'hk-c').find(l => l.placeId === S.id)!.start).toBeLessThan(t + 0.15);
      for (const x of [dt + 0.01, home.end - T - 0.01, 0.55, 0.7, 0.99]) expect(where(re, 'hk-b', T + x)).toBe(where(s, 'hk-b', T + x));
      expect(jobsOf(re, 'hk-b').map(l => l.placeId)).toEqual([D.id]);
      expect(legsOf(re, 'hk-b').some(l => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6)).toBe(false);
      expect(committed(re, 'hk-b')).toBeCloseTo(committed(s, 'hk-b'), 9);
    }
  });
});

describe('Her rest spot is kept only while it is still there, she can get to it, and her seat is free (mutation check)', () => {
  const BR = 'breakroom-0-5-0';
  /** Her rests after t: each in a break room that's still there (on its tile) at its rate, or on open hallway at the slower one. */
  const restsInRealPlaces = (s: HotelState, id: string, t: number) => restsOf(s, id).filter(l => l.end > t + 1e-9).every(l => (l.placeId
    ? s.fixtures.some(f => f.type === 'breakroom' && f.id === l.placeId && sameTile(f, l.at)) && l.restRate === STAFF_FATIGUE.roomRecovery
    : isHallway(s, l.at.gridX, l.at.gridY, l.at.floor) && l.restRate === STAFF_FATIGUE.fallbackRecovery));

  it('her break room demolished under her (or rebuilt down the hall): she gets up and rests where there is a place, not on in the old room at its rate', () => {
    for (const rebuild of [false, true]) {
      const s = hotel({ breakRoom: true, rooms: 4, dirty: { 0: 3 },
        crew: (r, abs) => [keeper('busy', r[0], abs, { fatigue: 10, keeps: true }), keeper('idle', { gridX: 5, gridY: 1, floor: 0 }, abs, { fatigue: 30 })] });
      const T = hourStart(s), t = T + 0.3;
      expect(restsOf(s, 'idle')).toMatchObject([{ idle: true, placeId: BR, restRate: STAFF_FATIGUE.roomRecovery, end: T + 1 }]);
      const gone = demolishFixture(s, BR)!;
      const re = settleChanges(s, rebuild ? addFixture(gone, 'breakroom', 7, 0, 0)! : gone, t);
      expect(restsOf(re, 'idle').filter(l => l.end > t + 1e-9).some(l => l.placeId === BR)).toBe(false);
      expect(restsInRealPlaces(re, 'idle', t)).toBe(true);
      expect(where(re, 'idle', T + 0.99)).not.toMatch(/^5\.000,0\.000,0 /);
    }
  });

  it('a room built over the hallway tile she\'s resting on: she steps out of it to rest on, not inside the new room', () => {
    const s = hotel({ rooms: 4, dirty: { 0: 3 }, crew: (r, abs) => [keeper('busy', r[0], abs, { fatigue: 10, keeps: true }), keeper('idle', r[2], abs, { fatigue: 30 })] });
    const T = hourStart(s), t = T + 0.3;
    expect(restsOf(s, 'idle')).toMatchObject([{ idle: true, at: { gridX: 5, gridY: 1, floor: 0 }, restRate: STAFF_FATIGUE.fallbackRecovery, end: T + 1 }]);
    const re = settleChanges(s, addRoom(s, 'standard', 5, 1, 0, 'up')!, t);
    expect(restsInRealPlaces(re, 'idle', t)).toBe(true);
    expect(where(re, 'idle', T + 0.99)).not.toMatch(/^5\.000,1\.000,0 /);
    expect(restsOf(re, 'idle').at(-1)).toMatchObject({ idle: true, end: T + 1 });
  });

  it('shut in her room by a room built at its door as she steps out to rest: she rests in there, not turning up in the break room she can\'t reach', () => {
    const s = hotel({ breakRoom: true, rooms: 4, dirty: { 0: 3 },
      crew: (r, abs) => [keeper('busy', r[0], abs, { fatigue: 10, keeps: true }), keeper('idle', r[3], abs, { fatigue: 30 })] });
    const T = hourStart(s), home = roomTile(s.rooms[3]);
    const walk = legsOf(s, 'idle')[0];
    expect(walk.kind === 'walk' && walk.path.slice(0, 2).map(p => [p.gridX, p.gridY])).toEqual([[home.gridX, home.gridY], [home.gridX, 1]]);
    expect(restsOf(s, 'idle')).toMatchObject([{ idle: true, placeId: BR }]);
    const t = walk.start + TRAVEL.hoursPerTile / 2; // half-way out of her door
    const re = settleChanges(s, addRoom(s, 'standard', home.gridX, 1, 0, 'up')!, t);
    // nobody gets from one tile to another without walking it
    const legs = legsOf(re, 'idle');
    const startOf = (l: Leg) => (l.kind === 'walk' ? l.path[0] : l.at), endOf = (l: Leg) => (l.kind === 'walk' ? l.path.at(-1)! : l.at);
    expect(legs.slice(1).every((l, i) => sameTile(startOf(l), endOf(legs[i])))).toBe(true);
    expect(restsOf(re, 'idle').filter(l => l.end > t + 1e-9).some(l => l.placeId === BR)).toBe(false);
    expect(where(re, 'idle', T + 0.5)).toBe(`${home.gridX}.000,${home.gridY}.000,0 rest@${STAFF_FATIGUE.fallbackRecovery}/`);
  });

  /**
   * 12:00 on day 2: a wall of rooms across row 3 (x 3..9, doors down onto row 4), the break room at (5, 0). `seated`
   * housekeepers are on compulsory breaks there from 11:48 till 12:18 (carried over the hour), each with a room in the wall to turn
   * over after; 'idle' (30) has nothing to do and walks the long way round the wall from (9, 4) to a seat they've freed;
   * with `cleaner`, 'c' is turning over the wall room at (7, 3) all hour. Demolishing that room at 12:03 opens a shortcut.
   */
  const walled = (seated: number, cleaner: boolean) => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = addFixture(s, 'breakroom', 5, 0, 0)!;
    for (let x = 3; x < 10; x++) s = addRoom(s, 'standard', x, 3, 0, 'down')!;
    const gap = s.rooms[4], seat = { gridX: 5, gridY: 0, floor: 0 }, abs = 36;
    const crew: StaffMember[] = Array.from({ length: seated }, (_, i) => ({ ...keeper(`w${i}`, seat, abs, { fatigue: 70 }),
      fatigueBreak: { at: seat, placeId: BR, start: abs - 0.2, end: abs + 0.3 } }));
    crew.push(keeper('idle', { gridX: 9, gridY: 4, floor: 0 }, abs, { fatigue: 30 }));
    if (cleaner) crew.push(keeper('c', gap, abs, { fatigue: 30, keeps: true }));
    const jobs = s.rooms.filter(r => r !== gap).slice(0, seated);
    s = { ...s, day: 2, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: crew.length, maintenanceWorkers: 0 }, staffRoster: crew,
      rooms: s.rooms.map(r => (jobs.includes(r) ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.5 }
        : cleaner && r === gap ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 3 } : r)) };
    s = { ...s, staffPlan: getStaffPlan(s) };
    const T = hourStart(s), t = T + 0.05;
    expect(restsOf(s, 'idle')).toMatchObject([{ idle: true, placeId: BR }]);
    expect(restsOf(s, 'idle')[0].start).toBeGreaterThan(T + 0.35); // (the long way round)
    return { s, T, t, gap, re: settleChanges(s, demolishRoom(s, gap.id)!, t) };
  };
  const neverOverfull = (s: HotelState, from: number, to: number) => {
    for (let x = from; x < to; x += 0.005) expect(breakRoomOccupancy(s, BR, x)).toBeLessThanOrEqual(BREAK_ROOM.seats);
  };

  it('a shortcut opened as she walks would get her to the break room while all six seats are still taken: she doesn\'t squeeze in as a seventh', () => {
    const { T, t, re } = walled(6, false);
    // the new way gets her there before 12:18
    expect(legsOf(re, 'idle').filter(l => l.kind === 'walk').at(-1)!.end).toBeLessThan(T + 0.3);
    neverOverfull(re, t, T + 1);
    expect(restsOf(re, 'idle').at(-1)).toMatchObject({ idle: true, end: T + 1 });
  });

  it('the seat she keeps is hers from her earlier arrival: a colleague freed by the same demolition doesn\'t take it as a seventh', () => {
    const { s, T, t, gap, re } = walled(5, true);
    expect(jobsOf(s, 'c')).toMatchObject([{ placeId: gap.id }]);
    expect(jobsOf(re, 'c').filter(l => l.end > t + 1e-9)).toEqual([]);
    // in her seat by 12:15 the new way (five on breaks there till 12:18, so one's free)
    expect(where(re, 'idle', T + 0.25)).toBe(`5.000,0.000,0 rest@${STAFF_FATIGUE.roomRecovery}/${BR}`);
    neverOverfull(re, t, T + 1);
  });
});

/** A checked-out guest leaving `room`, first step at `leave`. */
function departing(s: HotelState, room: Room, leave: number): Guest {
  const out = routeToStreet(s, roomTile(room), PACE)!;
  return { id: 'g', name: 'g', budget: 1000, stayLength: 1, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
    profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11 }, tripKind: 'departure',
    trip: [makeWalk(out.path, leave, PACE)] } as unknown as Guest;
}
/** Whether two plans put someone in the same place doing the same thing from t to the hour's end (sampled every 0.005 h): true, or where they first differ. */
const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
  for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
  return true;
};
const farRoom = (s: HotelState, t: number) => settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t);
const hire = (s: HotelState, t: number) => settleChanges(s, hireCandidate(s, 'housekeeper', hiringCandidates(s, 'housekeeper')[0].id, undefined, t)!, t);

describe('Spare time is decided where the rest starts: one she only gets to at 85 or more is a break', () => {
  it('a turnover finished at 84.9 and the step out of the room crossing 85: the rest outside is held like a break, unchanged by a paused edit', () => {
    // 12:00, no break room: low stamina at 80, she turns over her room till 12:42, steps out (85 on the way) and rests at the door
    const s = hotel({ rooms: 6, dirty: { 5: 0.6 }, crew: (r, abs) => [keeper('k', r[5], abs, { fatigue: 80, stamina: 'low', keeps: true })] });
    const k = s.staffRoster![0];
    const [rest] = restsOf(s, 'k');
    const step = legsOf(s, 'k').find(l => l.kind === 'walk')!;
    expect(fatigueAt(s, k, step.start)).toBeLessThan(STAFF_FATIGUE.breakAt);
    expect(fatigueAt(s, k, rest.start)).toBeGreaterThanOrEqual(STAFF_FATIGUE.breakAt);
    expect(rest.idle).toBeUndefined();
    // a paused replan or a room built far away, on the step out or once she's at 85 there: no fresh half-hour break past the hour
    for (const t of [(step.start + step.end) / 2, rest.start + 0.005, rest.start + 0.015]) {
      for (const re of [replanStaff(s, t), farRoom(s, t)]) {
        expect(samePlan(re, s, 'k', t)).toBe(true);
        expect(getStaffPlan(re).itineraries.find(it => it.staffId === 'k')!.end.fatigueBreak).toBeUndefined();
        expect(committed(re, 'k')).toBeCloseTo(committed(s, 'k'), 9);
      }
    }
  });

  it('the walk home for a do-not-disturb party crossing 85: the rest there is held like a break, and the room is still cleaned as the party goes out', () => {
    // 12:00 on day 3, no break room: D's party is out 12:36 to 13:36; hk-a turns over X; hk-b (low stamina, 83.5) walks to the base, 85 on the way
    let s = hotel({ day: 3, rooms: 3, dirty: { 1: 1.5 }, crew: (r, abs) => [keeper('hk-a', r[1], abs, { keeps: true, stamina: 'high' }), keeper('hk-b', r[2], abs, { fatigue: 83.5, stamina: 'low' })] });
    const T = hourStart(s), D = s.rooms[0];
    s = { ...s, staffPlan: null, guests: [goingOut(s, D, T + 0.6, T + 1.6)], rooms: s.rooms.map(r => (r.id === D.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.5 } : r)) };
    s = { ...s, staffPlan: getStaffPlan(s) };
    const [home] = restsOf(s, 'hk-b');
    expect(fatigueAt(s, s.staffRoster![1], home.start)).toBeGreaterThanOrEqual(STAFF_FATIGUE.breakAt);
    expect(home.idle).toBeUndefined();
    const [clean] = jobsOf(s, 'hk-b');
    expect(clean.placeId).toBe(D.id);
    for (const t of [home.start + 0.005, home.start + 0.01, home.start + 0.015]) {
      for (const re of [replanStaff(s, t), farRoom(s, t)]) {
        expect(samePlan(re, s, 'hk-b', t)).toBe(true);
        expect(jobsOf(re, 'hk-b')[0].start).toBeCloseTo(clean.start, 9);
      }
    }
  });
});

describe('A walk to a door, to wait there before a room, is not the walk to a break due at that door after it', () => {
  it('released at 82 by a let-go to a turnover whose guest is still walking out: Settle\'s second re-plan at that instant leaves her the clean', () => {
    // 12:00 on day 9, no break room: S 2.5h, X 1.5h (its checked-out guest steps out at 12:09); hk-mid (82) rests idle.
    // Let go of hk-fast at 12:03: hk-mid takes X, waits at its door, cleans it, then breaks at that door across the hour
    let s = hotel({ day: 9, suites: 1, rooms: 2, dirty: { 0: 2.5, 1: 1.5 }, crew: (r, abs) => [keeper('hk-fast', r[2], abs, { speed: 'fast', stamina: 'high' }),
      keeper('hk-slow', r[2], abs, { speed: 'slow', stamina: 'high' }), keeper('hk-mid', r[2], abs, { fatigue: 82 })] });
    const T = hourStart(s), X = s.rooms[1], t = T + 0.05;
    s = { ...s, staffPlan: null, guests: [departing(s, X, T + 0.15)] };
    s = { ...s, staffPlan: getStaffPlan(s) };
    expect(restsOf(s, 'hk-mid')).toMatchObject([{ idle: true }]);
    const after = dismissStaff(s, 'hk-fast', t)!;
    const once = replanStaff(after, t);
    expect(new Set(jobsOf(once, 'hk-mid').map(l => l.placeId))).toEqual(new Set([X.id]));
    expect(getStaffPlan(once).itineraries.find(it => it.staffId === 'hk-mid')!.end.fatigueBreak).toMatchObject({ at: doorTile(X, X.door) });
    for (const re of [replanStaff(once, t), settleChanges(s, after, t)]) {
      expect(samePlan(re, once, 'hk-mid', t)).toBe(true);
      expect(new Set(jobsOf(re, 'hk-mid').map(l => l.placeId))).toEqual(new Set([X.id]));
    }
  });

  it('a paused edit on her way to wait at a do-not-disturb door leaves her the clean, not a wait there for the break due after it', () => {
    // 12:00 on day 3, no break room: at 82 she walks to D's door, waits for the party to go out at 12:06, cleans, then breaks at the door across the hour
    let s = hotel({ day: 3, rooms: 4, crew: (r, abs) => [keeper('hk', r[3], abs, { fatigue: 82 })] });
    const T = hourStart(s), D = s.rooms[0];
    s = { ...s, staffPlan: null, guests: [goingOut(s, D, T + 0.1, T + 4)], rooms: s.rooms.map(r => (r.id === D.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.5 } : r)) };
    s = { ...s, staffPlan: getStaffPlan(s) };
    const [walk, wait] = legsOf(s, 'hk');
    expect(walk.kind).toBe('walk');
    expect(wait).toMatchObject({ activity: 'wait', at: doorTile(D, D.door) });
    expect(getStaffPlan(s).itineraries[0].end.fatigueBreak).toMatchObject({ at: doorTile(D, D.door) });
    const [clean] = jobsOf(s, 'hk');
    for (const t of [T + 0.03, T + 0.06]) {
      expect(t).toBeLessThan(walk.end);
      for (const re of [replanStaff(s, t), farRoom(s, t)]) {
        expect(samePlan(re, s, 'hk', t)).toBe(true);
        expect(jobsOf(re, 'hk').filter(l => l.end > t).map(l => [l.placeId, l.start])).toEqual([[D.id, clean.start]]);
      }
    }
  });
});

describe('Resting at home for a do-not-disturb party: with nothing new, a re-plan keeps her plan', () => {
  /** 12:00 on day 3 (`breakRoom`: one at (5, 0)): D's party goes out at `leave`; hk-a turns over X; hk-b, with nothing else, rests at the base till she sets off for D. */
  const setup = (leave: number, o: { breakRoom?: boolean; fatigue?: number } = {}) => {
    let s = hotel({ day: 3, breakRoom: o.breakRoom, rooms: 3, dirty: { 1: 1.5 }, crew: (r, abs) => [keeper('hk-a', r[1], abs, { keeps: true, stamina: 'high' }),
      keeper('hk-b', r[2], abs, { stamina: 'high', fatigue: o.fatigue ?? 0 })] });
    const T = hourStart(s), D = s.rooms[0];
    s = { ...s, staffPlan: null, guests: [goingOut(s, D, T + leave, T + 4)], rooms: s.rooms.map(r => (r.id === D.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.5 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, D };
  };
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  it('the clean falling next hour: she rests on till her set-off, not off at once to wait at the door', () => {
    // D's party goes out at 12:55: she rests at the base till about 12:49, and steps into D at 13:00
    for (const fatigue of [0, 50]) {
      const { s, D } = setup(0.91, { fatigue });
      const [home] = restsOf(s, 'hk-b');
      expect(home).toMatchObject({ idle: true, at: BASE });
      expect(jobsOf(s, 'hk-b')).toEqual([]);
      expect(getStaffPlan(s).itineraries.find(it => it.staffId === 'hk-b')!.end.roomId).toBe(D.id);
      for (const back of [0.05, 0.1, 0.2]) {
        const t = home.end - back;
        for (const re of [replanStaff(s, t), hire(s, t)]) {
          expect(samePlan(re, s, 'hk-b', t)).toBe(true);
          expect(committed(re, 'hk-b')).toBeCloseTo(committed(s, 'hk-b'), 9);
          expect(getStaffPlan(re).itineraries.find(it => it.staffId === 'hk-b')!.end.roomId).toBe(D.id);
        }
      }
    }
  });

  it('re-planned on her way to the base with the party going out soon: she walks on there and rests, not turning back to wait at the door', () => {
    // D's party goes out at 12:24: she walks to the base by 12:14, rests till 12:19 and sets off. A hire at 12:10, on her way: from
    // there she'd get to D's door within the quarter hour she'd wait at one for a party to go out
    const { s, T, D } = setup(0.4);
    const [walk] = legsOf(s, 'hk-b');
    expect(walk).toMatchObject({ kind: 'walk', path: expect.arrayContaining([BASE]) });
    const t = T + 0.167;
    expect(t).toBeLessThan(walk.end);
    for (const re of [hire(s, t), replanStaff(s, t)]) {
      expect(samePlan(re, s, 'hk-b', t)).toBe(true);
      expect(legsOf(re, 'hk-b').some(l => l.kind === 'stay' && l.activity === 'wait' && l.end > t)).toBe(false);
      expect(jobsOf(re, 'hk-b').map(l => l.placeId)).toEqual([D.id]);
    }
  });

  it('two do-not-disturb rooms: the other one\'s party going out within a quarter hour of her getting there doesn\'t send her off early to wait at its door', () => {
    // 12:00 on day 3, break room: D1's party goes out at 12:46, D2's at 12:43. A (first on the roster) turns over X1 and X2; B (75) rests
    // at the base till she sets off for D1 at 12:34. Edits from 12:15: D2's door is 13 minutes from the base
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = addFixture(s, 'breakroom', 5, 0, 0)!;
    for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
    for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    const [D1, X1, D2, X2] = s.rooms, T = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2, maintenanceWorkers: 0 },
      staffRoster: [keeper('A', s.rooms[5], T, { speed: 'fast', stamina: 'low', fatigue: 46 }), keeper('B', D2, T, { speed: 'fast', stamina: 'low', fatigue: 75, keeps: true })],
      guests: [{ ...goingOut(s, D1, T + 0.767, T + 1.734), id: 'g1', name: 'g1' }, { ...goingOut(s, D2, T + 0.714, T + 3.149), id: 'g2', name: 'g2' }],
      rooms: s.rooms.map(r => (r.id === D1.id ? { ...r, status: 'occupied' as const, guestId: 'g1', dailyCleanHoursRemaining: 0.576 }
        : r.id === D2.id ? { ...r, status: 'occupied' as const, guestId: 'g2', dailyCleanHoursRemaining: 0.411 }
        : r.id === X1.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.423 }
        : r.id === X2.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 1.509 } : r)) };
    s = { ...s, staffPlan: getStaffPlan(s) };
    const [home] = restsOf(s, 'B');
    expect(home).toMatchObject({ idle: true, at: BASE });
    expect(jobsOf(s, 'B').map(l => l.placeId)).toEqual([D1.id]);
    for (let x = 0.25; x < home.end - T; x += 0.02) {
      for (const re of [replanStaff(s, T + x), hire(s, T + x)]) {
        expect(samePlan(re, s, 'B', T + x)).toBe(true);
        expect(jobsOf(re, 'B').map(l => l.placeId)).toEqual([D1.id]);
      }
    }
  });

  it('her room stays hers: a colleague first on the roster, resting idle, isn\'t sent to it by a re-plan with nothing new', () => {
    // 12:00 on day 3, break room: A (first) turns over X, then rests in the break room; B stands in D (hers) and rests at the base till she sets off for it
    for (const leave of [0.5, 0.6, 0.7]) {
      let s = hotel({ day: 3, breakRoom: true, rooms: 2, dirty: { 1: 0.15 }, crew: (r, abs) => [keeper('A', r[1], abs, { keeps: true, fatigue: 20 }), keeper('B', r[0], abs, { keeps: true, fatigue: 20 })] });
      const T = hourStart(s), D = s.rooms[0];
      s = { ...s, staffPlan: null, guests: [goingOut(s, D, T + leave, T + 3)], rooms: s.rooms.map(r => (r.id === D.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.3 } : r)) };
      s = { ...s, staffPlan: getStaffPlan(s) };
      const [home] = restsOf(s, 'B'), [aRest] = restsOf(s, 'A');
      expect(home).toMatchObject({ idle: true, at: BASE });
      expect(aRest).toMatchObject({ idle: true, placeId: 'breakroom-0-5-0' });
      for (let t = Math.max(home.start, aRest.start) + 0.005; t < home.end; t += 0.02) {
        for (const re of [replanStaff(s, t), hire(s, t)]) {
          expect(jobsOf(re, 'B').filter(l => l.end > t).map(l => l.placeId)).toEqual([D.id]);
          expect(jobsOf(re, 'A').filter(l => l.end > t)).toEqual([]);
          for (const id of ['A', 'B']) expect(samePlan(re, s, id, t)).toBe(true);
        }
      }
    }
  });

  it('two do-not-disturb rooms one after the other in her plan: the second one\'s party being out by the time she\'d get there doesn\'t send her there first', () => {
    // 12:00 on day 3: R's party goes out at 12:25, J's at 12:23. From (5, 1) she walks to the base, rests till 12:18, cleans R, then sets off for J
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
    const abs = 2 * 24 + 12, [, R, , J] = s.rooms;
    s = { ...s, day: 3, hour: 12, noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', { gridX: 5, gridY: 1, floor: 0 }, abs, { speed: 'fast', stamina: 'low', fatigue: 32 })],
      guests: [{ ...goingOut(s, R, abs + 0.416, abs + 1.948), id: 'g1', name: 'g1' }, { ...goingOut(s, J, abs + 0.377, abs + 3.294), id: 'g3', name: 'g3' }],
      rooms: s.rooms.map(r => (r.id === R.id ? { ...r, status: 'occupied' as const, guestId: 'g1', dailyCleanHoursRemaining: 0.59 }
        : r.id === J.id ? { ...r, status: 'occupied' as const, guestId: 'g3', dailyCleanHoursRemaining: 0.44 } : r)) };
    s = { ...s, staffPlan: getStaffPlan(s) };
    const [home] = restsOf(s, 'hk');
    expect(home).toMatchObject({ idle: true, at: BASE });
    expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([R.id]);
    expect(getStaffPlan(s).itineraries[0].end.roomId).toBe(J.id);
    for (const x of [0.25, 0.27, 0.29]) {
      const re = replanStaff(s, abs + x);
      expect(samePlan(re, s, 'hk', abs + x)).toBe(true);
      expect(jobsOf(re, 'hk').map(l => l.placeId)).toEqual([R.id]);
    }
  });

  it('her room cut off while she rests at home for it: she rests where she recovers best (a break-room seat), not on at the base', () => {
    const { s, T } = setup(0.6, { breakRoom: true, fatigue: 40 });
    expect(restsOf(s, 'hk-b')).toMatchObject([{ idle: true, at: BASE }]);
    // a room built at 12:18 on the hallway tile at D's door
    const t = T + 0.3;
    const re = settleChanges(s, addRoom(s, 'standard', 3, 1, 0, 'left')!, t);
    expect(jobsOf(re, 'hk-b').filter(l => l.end > t)).toEqual([]);
    expect(restsOf(re, 'hk-b').at(-1)).toMatchObject({ idle: true, placeId: 'breakroom-0-5-0', restRate: STAFF_FATIGUE.roomRecovery, end: T + 1 });
    // (better than resting on at the base till 13:00)
    const [walk] = legsOf(s, 'hk-b');
    const stayed = [walk, makeStay(BASE, walk.end, T + 1, 'rest', { restRate: STAFF_FATIGUE.fallbackRecovery })];
    expect(committed(re, 'hk-b')).toBeLessThan(projectFatigue(s.staffRoster![1], stayed, T, T + 1) - 1);
  });
});

// ---- More review findings on the first fix: edits that bring work to someone else, a seat reached early, the spotlight rush ----

/** A do-not-disturb room: `room`, its party (`id`) going out at `leave` and back at `back`, needing `hours` of daily cleaning. */
const withParty = (s: HotelState, room: Room, leave: number, back: number, hours: number, id = 'd'): HotelState => ({ ...s, staffPlan: null,
  guests: [...s.guests, { ...goingOut(s, room, leave, back), id, name: id }],
  rooms: s.rooms.map(r => (r.id === room.id ? { ...r, status: 'occupied' as const, guestId: id, dailyCleanHoursRemaining: hours } : r)) });
const planned = (s: HotelState): HotelState => ({ ...s, staffPlan: getStaffPlan({ ...s, staffPlan: null }) });
/**
 * A vacant room at (8, 2), and a maintenance worker first on the roster standing in it with nothing to repair (so
 * resting in spare time, outside it): `breaks` is a paused edit that gives her work there (the room falls below the
 * repair threshold): work for her alone, so everyone else must still keep their plans.
 */
function withMechanic(s: HotelState): HotelState {
  const built = addRoom({ ...s, staffPlan: null }, 'standard', 8, 2, 0, 'up')!;
  const mx = { ...keeper('mx', built.rooms.find(r => r.gridX === 8 && r.gridY === 2)!, hourStart(s), { fatigue: 10, stamina: 'high' }), role: 'maintenance', dailyWage: 80 } as StaffMember;
  return planned({ ...built, staffRoster: [mx, ...built.staffRoster!], staff: { ...built.staff, maintenanceWorkers: 1 } });
}
const breaks = (s: HotelState, t: number) => settleChanges(s, { ...s, rooms: s.rooms.map(r => (r.gridX === 8 && r.gridY === 2 && r.floor === 0 ? { ...r, condition: 40 } : r)) }, t);
const repairs = (s: HotelState, t: number) => jobsOf(s, 'mx').some(l => l.job === 'repair' && l.end > t + 1e-9);
/** Whether someone's plan from t to the hour's end is the same in two states (sampled every 0.005h; rest rate and seat included). */
const sameFrom = (a: HotelState, b: HotelState, id: string, t: number) => {
  for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return false;
  return true;
};
const BASE = { gridX: 1, gridY: 4, floor: 0 };

describe('A rest she only gets to at the break threshold is a break, not spare time (review 1)', () => {
  it('walking to the break room after her last room takes her past 85: a paused edit keeps her rest there as planned, not a fresh half hour on past the hour', () => {
    // 12:00, low stamina at 80: the far room's turnover done at 12:38.8 (84.5), nine minutes to the break room, there at 85.6
    const s = hotel({ breakRoom: true, rooms: 6, dirty: { 5: 0.55 }, crew: (r, abs) => [keeper('k', r[5], abs, { fatigue: 80, stamina: 'low', keeps: true })] });
    const T = hourStart(s), m = s.staffRoster![0], legs = legsOf(s, 'k');
    const [rest] = restsOf(s, 'k'), walk = legs[legs.indexOf(rest) - 1];
    expect(walk.kind).toBe('walk');
    expect(fatigueAt(s, m, walk.start)).toBeLessThan(STAFF_FATIGUE.breakAt);
    expect(fatigueAt(s, m, rest.start)).toBeGreaterThan(STAFF_FATIGUE.breakAt);
    expect(rest).toMatchObject({ placeId: expect.any(String), end: T + 1 });
    expect(rest.idle).toBeUndefined();
    for (const t of [(walk.start + walk.end) / 2, rest.start + 0.02]) {
      expect(fatigueAt(s, m, t)).toBeGreaterThanOrEqual(STAFF_FATIGUE.breakAt);
      for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t)]) {
        for (const x of [rest.start + 0.01, 0.9 + T, 0.99 + T]) expect(where(re, 'k', x)).toBe(where(s, 'k', x));
        expect(getStaffPlan(re).itineraries.find(it => it.staffId === 'k')!.end.fatigueBreak).toBeUndefined();
        expect(committed(re, 'k')).toBeCloseTo(committed(s, 'k'), 9);
      }
    }
  });

  it('walking home for a do-not-disturb party takes her past 85: her rest at home is kept as planned through a paused edit, and she cleans the room as the party goes out', () => {
    // 12:00 on day 3, no break room: hk-b (low stamina, 83.5) walks home 12:00-12:14 and gets there at 85.2; D's party goes out at 12:36
    const s0 = hotel({ day: 3, rooms: 3, dirty: { 1: 1.5 }, crew: (r, abs) => [keeper('hk-a', r[1], abs, { keeps: true, stamina: 'high' }), keeper('hk-b', r[2], abs, { fatigue: 83.5, stamina: 'low' })] });
    const T = hourStart(s0), D = s0.rooms[0];
    const s = planned(withParty(s0, D, T + 0.6, T + 1.6, 0.5));
    const m = s.staffRoster!.find(x => x.id === 'hk-b')!;
    const [home] = restsOf(s, 'hk-b');
    expect(home).toMatchObject({ at: BASE });
    expect(fatigueAt(s, m, home.start)).toBeGreaterThan(STAFF_FATIGUE.breakAt);
    expect(home.idle).toBeUndefined();
    const [clean] = jobsOf(s, 'hk-b');
    expect(clean.placeId).toBe(D.id);
    const t = home.start + 0.005;
    expect(fatigueAt(s, m, t)).toBeGreaterThanOrEqual(STAFF_FATIGUE.breakAt);
    for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t)]) {
      expect(sameFrom(re, s, 'hk-b', t)).toBe(true);
      expect(jobsOf(re, 'hk-b').filter(l => l.end > t)[0]).toMatchObject({ placeId: D.id, start: clean.start });
    }
  });
});

describe('Only a walk straight to a carried break keeps it, not one to a door to wait at first (review 5, 12)', () => {
  it('on her way to wait at a do-not-disturb door with no break room (the break due after the clean falling outside that same door): a paused edit leaves her the clean', () => {
    // 12:00 on day 3: at 82 she walks from the end room to D's door by 12:07, waits for the party to go out, cleans D till
    // 12:47, steps out and (at 85) takes her half-hour break there, across the hour
    const s0 = hotel({ day: 3, rooms: 4, crew: (r, abs) => [keeper('hk', r[3], abs, { fatigue: 82 })] });
    const T = hourStart(s0), D = s0.rooms[0], door = doorTile(D, D.door);
    const s = planned(withParty(s0, D, T + 0.1, T + 4, 0.5));
    const [walk, wait] = legsOf(s, 'hk');
    expect(wait).toMatchObject({ kind: 'stay', activity: 'wait', at: { gridX: door.gridX, gridY: door.gridY } });
    const [clean] = jobsOf(s, 'hk');
    expect(clean).toMatchObject({ placeId: D.id });
    const brk = getStaffPlan(s).itineraries.find(it => it.staffId === 'hk')!.end.fatigueBreak!;
    expect(brk).toMatchObject({ at: { gridX: door.gridX, gridY: door.gridY } });
    expect(brk.placeId).toBeUndefined();
    expect(brk.start).toBeGreaterThan(clean.end);
    expect(brk.end).toBeGreaterThan(T + 1);
    for (const t of [walk.start + 0.03, (walk.start + walk.end) / 2]) {
      for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t)]) {
        expect(jobsOf(re, 'hk').filter(l => l.end > t).map(l => l.placeId)).toEqual([D.id]);
        for (const x of [wait.start + 0.01, clean.start + 0.01, clean.end - 0.01, brk.start + 0.01]) expect(where(re, 'hk', x)).toBe(where(s, 'hk', x));
      }
    }
  });

  it('let go of a colleague, the one given the turnover waits at its door for the guest walking out: Settle\'s second re-plan at the same instant keeps her the work, not a wait for the break after it', () => {
    // 12:00 on day 9, no break room: hk-slow on S (2.5h), hk-fast on X (1.5h), whose checked-out guest steps out at 12:09;
    // hk-mid (82) rests outside the clean room. hk-fast let go at 12:03: hk-mid takes X, waiting at its door for the guest,
    // and after it (at 85) takes her half-hour break at that door, across the hour
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 0; x < 3; x++) s = addRoom(s, x === 0 ? 'suite' : 'standard', x + 3, 2, 0, 'up')!;
    const abs = 8 * 24 + 12, X = s.rooms[1];
    const crew = [keeper('hk-fast', s.rooms[2], abs, { speed: 'fast', stamina: 'high' }), keeper('hk-slow', s.rooms[2], abs, { speed: 'slow', stamina: 'high' }),
      keeper('hk-mid', s.rooms[2], abs, { fatigue: 82 })];
    s = planned({ ...s, day: 9, hour: 12, guests: [departing(s, X, abs + 0.15)], noiseSources: [], staff: { ...s.staff, housekeepers: 3 },
      staffRoster: [...crew, ...(s.staffRoster ?? []).filter(m => m.role !== 'housekeeper')],
      rooms: s.rooms.map((r, i) => (i < 2 ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: [2.5, 1.5][i] } : r)) });
    const T = hourStart(s), t = T + 0.05, door = doorTile(X, X.door);
    expect(jobsOf(s, 'hk-mid')).toEqual([]);
    const once = replanStaff(dismissStaff(s, 'hk-fast', t)!, t);
    const onX = jobsOf(once, 'hk-mid').find(l => l.placeId === X.id)!;
    expect(legsOf(once, 'hk-mid').find(l => l.kind === 'stay' && l.activity === 'wait' && l.end <= onX.start)).toMatchObject({ at: { gridX: door.gridX, gridY: door.gridY } });
    expect(getStaffPlan(once).itineraries.find(it => it.staffId === 'hk-mid')!.end.fatigueBreak).toMatchObject({ at: { gridX: door.gridX, gridY: door.gridY } });
    // settleChanges re-plans twice at t (this roster has no named clerks yet: Settle naming them changes the desk's lanes):
    // the second keeps X
    const re = settleChanges(s, dismissStaff(s, 'hk-fast', t)!, t);
    expect(jobsOf(re, 'hk-mid').filter(l => l.end > t)[0]).toMatchObject({ placeId: X.id, start: onX.start });
    expect(legsOf(re, 'hk-mid').filter(l => l.kind === 'stay' && l.activity === 'wait').every(l => l.end <= onX.start)).toBe(true);
    expect(tickSimulation(re, new PRNG(3)).state.rooms.find(r => r.id === X.id)!.cleaningHoursRemaining).toBeLessThan(1.5 - 0.3);
  });
});

describe('Resting at home for a do-not-disturb party, through an edit that brings work to someone else (review 3, 6, 7, 8, 10)', () => {
  /** 12:00 on day 3: D1 (3, 2) and D2 (5, 2) do-not-disturb; A turns over the rooms on row 5; B (fast, low stamina, 75) keeps D2 and rests at the base, setting off for D1 at 12:34. */
  const twoRooms = () => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = addFixture(s, 'breakroom', 5, 0, 0)!;
    for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
    for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    const T = 2 * 24 + 12, [D1, X1, D2, X2] = s.rooms;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staff: { ...s.staff, housekeepers: 2, maintenanceWorkers: 0 },
      staffRoster: [keeper('A', s.rooms[5], T, { speed: 'fast', stamina: 'low', fatigue: 46 }), keeper('B', D2, T, { speed: 'fast', stamina: 'low', fatigue: 75, keeps: true })],
      rooms: s.rooms.map(r => (r.id === X1.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.423 } : r.id === X2.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 1.509 } : r)) };
    s = withParty(withParty(s, D1, T + 0.767, T + 1.734, 0.576, 'g1'), D2, T + 0.714, T + 3.149, 0.411, 'g2');
    return { s: withMechanic(s), T, D1, D2 };
  };

  it('two do-not-disturb rooms: whatever opens first when the edit comes, she rests on till her set-off and takes the room she was to', () => {
    const { s, T, D1 } = twoRooms();
    const [home] = restsOf(s, 'B');
    expect(home).toMatchObject({ idle: true, at: BASE });
    expect(home.end).toBeCloseTo(T + 0.564, 3);
    expect(jobsOf(s, 'B').map(l => l.placeId)).toEqual([D1.id]);
    // 12:19 to 12:33: D2 opens within the wait allowed at its door before D1 does (the edit at 12:23 sent her to it)
    for (const dt of [0.32, 0.36, 0.385, 0.42, 0.5]) {
      const t = T + dt;
      for (const [re, works] of [[replanStaff(s, t), false], [breaks(s, t), true]] as const) {
        expect(repairs(re, t)).toBe(works);
        for (const id of ['A', 'B']) expect(sameFrom(re, s, id, t)).toBe(true);
        expect(committed(re, 'B')).toBeCloseTo(committed(s, 'B'), 9);
      }
    }
  });

  it('her room is not taken by a colleague given up her own spare time by the same edit', () => {
    // 12:00 on day 3: A (first on the roster) turns over X and then rests in the break room; B keeps D, whose party goes
    // out at 12:30, and rests at the base till she sets off
    let s = hotel({ day: 3, breakRoom: true, rooms: 2, dirty: { 1: 0.15 }, crew: (r, abs) => [keeper('A', r[1], abs, { keeps: true, fatigue: 20 }), keeper('B', r[0], abs, { keeps: true, fatigue: 20 })] });
    const T = hourStart(s), D = s.rooms[0];
    s = withMechanic(withParty(s, D, T + 0.5, T + 3, 0.3));
    expect(restsOf(s, 'A').at(-1)).toMatchObject({ idle: true, placeId: expect.any(String) });
    const [home] = restsOf(s, 'B');
    expect(home).toMatchObject({ idle: true, at: BASE });
    expect(jobsOf(s, 'B').map(l => l.placeId)).toEqual([D.id]);
    for (let t = Math.max(home.start, restsOf(s, 'A').at(-1)!.start) + 0.01; t < home.end; t += 0.04) {
      const re = breaks(s, t);
      expect(repairs(re, t)).toBe(true);
      expect(jobsOf(re, 'A').filter(l => l.end > t)).toEqual([]);
      for (const id of ['A', 'B']) expect(sameFrom(re, s, id, t)).toBe(true);
    }
  });

  it('the set-off this hour, her clean in the next: she rests on at home till then, not off to wait at the door', () => {
    // As in 'Resting at home for a do-not-disturb party', the party going out at 12:55: she sets off at 12:49, in at 13:00
    for (const leave of [0.91, 0.93]) {
      let s = hotel({ day: 3, rooms: 3, dirty: { 1: 1.5 }, crew: (r, abs) => [keeper('hk-a', r[1], abs, { keeps: true, stamina: 'high' }), keeper('hk-b', r[2], abs, { stamina: 'high', fatigue: 40 })] });
      const T = hourStart(s), D = s.rooms[0];
      s = withMechanic(withParty(s, D, T + leave, T + 4, 0.5));
      const [home] = restsOf(s, 'hk-b');
      expect(home).toMatchObject({ idle: true, at: BASE });
      expect(jobsOf(s, 'hk-b')).toEqual([]);
      expect(getStaffPlan(s).itineraries.find(it => it.staffId === 'hk-b')!.end).toMatchObject({ roomId: D.id });
      for (const before of [0.2, 0.1, 0.05]) {
        const t = home.end - before;
        for (const re of [replanStaff(s, t), breaks(s, t)]) {
          expect(sameFrom(re, s, 'hk-b', t)).toBe(true);
          expect(committed(re, 'hk-b')).toBeCloseTo(committed(s, 'hk-b'), 9);
        }
        expect(repairs(breaks(s, t), t)).toBe(true);
      }
    }
  });

  it('on her way home to rest for the party: she walks on there and rests till her set-off, not turned round to wait at the door', () => {
    // As in 're-planned on her way to rest at the base': she walks from her room to the base (12:00 to 12:14), rests, and sets off for D at 12:19
    let s = hotel({ day: 3, rooms: 3, dirty: { 1: 1.5 }, crew: (r, abs) => [keeper('hk-a', r[1], abs, { keeps: true, stamina: 'high' }), keeper('hk-b', r[2], abs, { stamina: 'high' })] });
    const T = hourStart(s), D = s.rooms[0];
    s = withMechanic(withParty(s, D, T + 0.4, T + 4, 0.5));
    const [walk] = legsOf(s, 'hk-b');
    expect(restsOf(s, 'hk-b')).toMatchObject([{ idle: true, at: BASE }]);
    const onD = jobsOf(s, 'hk-b')[0];
    for (const x of [0.1, 0.13, 0.16, 0.19]) {
      const t = T + x;
      expect(t).toBeLessThan(walk.end);
      const re = breaks(s, t);
      expect(repairs(re, t)).toBe(true);
      expect(sameFrom(re, s, 'hk-b', t)).toBe(true);
      expect(jobsOf(re, 'hk-b')[0]).toMatchObject({ placeId: D.id });
      expect(jobsOf(re, 'hk-b')[0].start).toBeCloseTo(onD.start, 9);
    }
  });

  it('her party\'s room going to a colleague (hers demolished): she rests at home only till her old set-off, then in the break room, not at the base the rest of the hour', () => {
    // 12:00 on day 3, break room at (5, 0): hk-a keeps X; D's party goes out at 12:36, so hk-b rests at the base till 12:31
    let s = hotel({ day: 3, breakRoom: true, rooms: 3, dirty: { 1: 1.5 }, crew: (r, abs) => [keeper('hk-a', r[1], abs, { keeps: true, stamina: 'high' }), keeper('hk-b', r[2], abs, { stamina: 'high', fatigue: 30 })] });
    const T = hourStart(s), [D, X] = s.rooms;
    s = planned(withParty(s, D, T + 0.6, T + 4, 0.5));
    const [home] = restsOf(s, 'hk-b');
    expect(home).toMatchObject({ idle: true, at: BASE });
    expect(home.end).toBeLessThan(T + 0.6);
    const clean = jobsOf(s, 'hk-b')[0];
    for (const dt of [0.2, 0.3, 0.4]) {
      // X demolished under hk-a: she's free, and first on the roster
      const re = settleChanges(s, demolishRoom(s, X.id)!, T + dt);
      const onD = [...jobsOf(re, 'hk-a'), ...jobsOf(re, 'hk-b')].filter(l => l.placeId === D.id && l.end > T + dt);
      expect(onD[0].start).toBeCloseTo(clean.start, 9);
      if (!jobsOf(re, 'hk-b').some(l => l.placeId === D.id)) {
        expect(restsOf(re, 'hk-b').filter(l => l.start > home.end - 1e-9)).toMatchObject([{ placeId: expect.any(String), restRate: STAFF_FATIGUE.roomRecovery, end: T + 1 }]);
        expect(restsOf(re, 'hk-b').filter(l => l.end > T + dt && !l.placeId).every(l => l.end <= home.end + 1e-9)).toBe(true);
      }
    }
  });

  it('a room built across her way to the door, even within the wait allowed at it: she sets off sooner, and is there as the party goes out', () => {
    // At the base from 12:00; D's party goes out at 12:36: the plan sets off at 12:31; a room on (2, 2) makes her way two tiles longer
    let s = hotel({ day: 3, rooms: 3, dirty: { 1: 1.5 }, crew: (r, abs) => [keeper('hk-a', r[1], abs, { keeps: true, stamina: 'high' }), keeper('hk-b', BASE, abs, { stamina: 'high' })] });
    const T = hourStart(s), D = s.rooms[0];
    s = planned(withParty(s, D, T + 0.6, T + 4, 0.5));
    const onD = jobsOf(s, 'hk-b')[0];
    expect(restsOf(s, 'hk-b')).toMatchObject([{ idle: true, at: BASE, start: T }]);
    for (const dt of [0.1, 0.4, 0.44]) {
      const re = settleChanges(s, addRoom(s, 'standard', 2, 2, 0, 'left')!, T + dt);
      expect(where(re, 'hk-b', T + 0.48)).toMatch(/walk$/); // off by 12:27, not resting on till 12:31
      expect(jobsOf(re, 'hk-b')[0]).toMatchObject({ placeId: D.id });
      expect(jobsOf(re, 'hk-b')[0].start).toBeCloseTo(onD.start, 9);
    }
  });
});

describe('A kept seat she gets to early by a new way (mutation check)', () => {
  it('her seat still taken when she gets there: she waits there for when it was to be hers, rather than resting elsewhere at the slower rate', () => {
    // keepRestSpot: six on the break room's seats till 12:18; her rest there was to start at 12:21; a new way gets her there at 12:12
    const s = hotel({ breakRoom: true, rooms: 2, crew: (r, abs) => [keeper('k', r[1], abs)] });
    const T = hourStart(s), seat = { gridX: 5, gridY: 0, floor: 0 }, placeId = 'breakroom-0-5-0';
    const full = Array.from({ length: BREAK_ROOM.seats }, (_, i) => ({ staffId: `w${i}`, placeId, start: T - 0.2, end: T + 0.3 }));
    const from = { gridX: 5, gridY: 1, floor: 0 }, arrive = T + 0.2 - TRAVEL.hoursPerTile;
    const kept = keepRestSpot(s, s.staffRoster![0], { at: seat, placeId }, from, arrive, T + 1, [...full], T + 0.35)!;
    expect(kept.legs.map(l => [l.kind === 'stay' ? l.activity : 'walk', +(l.start - T).toFixed(3), +(l.end - T).toFixed(3)])).toEqual([['walk', 0.17, 0.2], ['wait', 0.2, 0.35], ['rest', 0.35, 1]]);
    expect(kept.legs.at(-1)).toMatchObject({ placeId, restRate: STAFF_FATIGUE.roomRecovery });
    // a seat free by then: from her arrival; never one taken for all her rest
    expect(keepRestSpot(s, s.staffRoster![0], { at: seat, placeId }, from, arrive, T + 1, full.slice(1), T + 0.35)!.legs.at(-1)).toMatchObject({ start: T + 0.2 });
    expect(keepRestSpot(s, s.staffRoster![0], { at: seat, placeId }, from, arrive, T + 1, full.map(r => ({ ...r, end: T + 1 })), T + 0.35)).toBeNull();
  });
});

describe('The spotlight rush through later edits', () => {
  it('a later edit that brings nothing keeps the rush the let-go re-plan settled, and the one it is kept for on the suite', () => {
    // As 'the held suite rushed again for another idle housekeeper': hk-fast let go at 12:06, S rushed again for hk-b
    const s0 = hotel({ day: 9, suites: 1, rooms: 3, dirty: { 0: 2.5, 1: 1.5 }, crew: (r, abs) => [keeper('hk-fast', r[2], abs, { speed: 'fast', stamina: 'high' }),
      keeper('hk-slow', r[2], abs, { speed: 'slow', stamina: 'high' }), keeper('hk-a', r[3], abs, { speed: 'slow', stamina: 'high' }), keeper('hk-b', r[2], abs, { stamina: 'high' })] });
    const S = s0.rooms[0];
    const spotlight: SpotlightPlan = { kind: 'writer', week: 1, salt: '', announceDay: 9, arrivalDay: 9, arrivalHour: 15, status: 'announced', chainId: 'spotlight-10', roomId: S.id };
    const s = planned({ ...s0, spotlight });
    const T = hourStart(s), t = T + 0.1;
    const re = settleChanges(s, dismissStaff(s, 'hk-fast', t)!, t);
    expect(getStaffPlan(re).rush).toEqual({ roomId: S.id, staffId: 'hk-b' });
    for (const t2 of [t + 0.05, T + 0.4]) {
      const later = settleChanges(re, addRoom(re, 'standard', 7, 5, 0, 'up')!, t2);
      expect(getStaffPlan(later).rush).toEqual({ roomId: S.id, staffId: 'hk-b' });
      for (const id of ['hk-slow', 'hk-a', 'hk-b']) expect(sameFrom(later, re, id, t2)).toBe(true);
    }
  });
});
