// Waits that are part of the way to a rest, through paused edits (StaffManager.replanStaff): with a named front desk,
// Settle re-plans twice after every build or demolish, and a later edit re-plans again. A seat she reaches early and
// waits at, or a compulsory break a clerk reaches before the hour's end and waits for (design: "a compulsory break keeps
// its fixed end across hour boundaries, paused edits and reloads"), is kept through them. See also
// idleRestReplan.test.ts and compulsoryBreakReplan.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { createStarterHotel, addRoom, addFixture, demolishRoom, demolishFixture } from '../src/simulation/HotelState.js';
import { getStaffPlan, replanStaff, rosterAfter } from '../src/simulation/StaffManager.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { initializeFrontDesk, dismissStaff } from '../src/simulation/StaffHiring.js';
import { namedFrontDesk } from '../src/simulation/StaffProfiles.js';
import { hourStart, positionAt, sameTile, makeWalk, makeStay } from '../src/simulation/Movement.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { breakRoomOccupancy, fatigueAt } from '../src/simulation/StaffFatigue.js';
import { BREAK_ROOM, TRAVEL } from '../src/config/balance.js';
import { STAFF_FATIGUE } from '../src/config/staff.js';
import { physicalDeskLanes, deskCoverage } from '../src/simulation/FrontDesk.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { isEntranceTile, routeToStreet, routeFromStreet } from '../src/simulation/Layout.js';
import { saveGame, loadGame } from '../src/simulation/SaveManager.js';
import type { HotelState, Leg, Room, StaffMember, StayLeg, TilePos, WalkLeg, Guest, FatigueBreak } from '../src/simulation/types.js';

// A kept seat she gets to early by a new way (walk, wait at the seat, then her rest there) survives the next re-plan.
{
  const BR = 'breakroom-0-5-0';
  const SEAT = { gridX: 5, gridY: 0, floor: 0 };

  /** A housekeeper standing at `at` (a room: in it), `fatigue` as of the hour's start. */
  function keeper(id: string, at: Room | TilePos, abs: number, fatigue: number): StaffMember {
    const room = 'id' in at ? at as Room : undefined;
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: room ? roomTile(room) : at,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', specialty: 'turnover_runner' },
      stats: { workHours: 100, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)!.legs;
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Whether two plans put someone in the same place doing the same thing from t to the hour's end (sampled every 0.005 h): true, or where they first differ. */
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  const committed = (s: HotelState, id: string) => rosterAfter(s, getStaffPlan(s)).find(m => m.id === id)!.stats!.fatigue!;
  const neverOverfull = (s: HotelState, from: number, to: number) => {
    for (let x = from; x < to; x += 0.005) expect(breakRoomOccupancy(s, BR, x)).toBeLessThanOrEqual(BREAK_ROOM.seats);
  };
  const IN_HER_SEAT = `5.000,0.000,0 rest@${STAFF_FATIGUE.roomRecovery}/${BR}`;

  /**
   * 12:00 on day 2: a wall of rooms across row 3 (x 3..9, doors down onto row 4), the break room at (5, 0). Six housekeepers
   * fill its seats on compulsory breaks from 11:48 till 12:18, each with a wall room to turn over after; 'idle' (30) has
   * nothing to do and walks the long way round the wall from (9, 4), to rest in a seat they've freed from 12:25. With
   * `desk`, the hotel has its named front desk set up as in a real game (so Settle re-plans twice for a layout change).
   * Demolishing the wall room at (7, 3) at 12:03 opens a shortcut: she's there at 12:14, all six seats still taken.
   */
  function walled(desk: boolean) {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = addFixture(s, 'breakroom', 5, 0, 0)!;
    for (let x = 3; x < 10; x++) s = addRoom(s, 'standard', x, 3, 0, 'down')!;
    const gap = s.rooms[4], abs = 36;
    const crew: StaffMember[] = Array.from({ length: BREAK_ROOM.seats }, (_, i) => ({ ...keeper(`w${i}`, SEAT, abs, 70),
      fatigueBreak: { at: SEAT, placeId: BR, start: abs - 0.2, end: abs + 0.3 } }));
    crew.push(keeper('idle', { gridX: 9, gridY: 4, floor: 0 }, abs, 30));
    const jobs = s.rooms.filter(r => r !== gap).slice(0, BREAK_ROOM.seats);
    s = { ...s, day: 2, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: crew.length, maintenanceWorkers: 0 }, staffRoster: crew,
      rooms: s.rooms.map(r => (jobs.includes(r) ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.5 } : r)) };
    if (desk) s = initializeFrontDesk(s);
    s = { ...s, staffPlan: getStaffPlan(s) };
    const T = hourStart(s), t = T + 0.05;
    expect(namedFrontDesk(s)).toBe(desk);
    // the long way round: in her seat from 12:25
    const seat = restsOf(s, 'idle');
    expect(seat).toMatchObject([{ placeId: BR, restRate: STAFF_FATIGUE.roomRecovery, end: T + 1 }]);
    expect(seat[0].start).toBeGreaterThan(T + 0.35);
    const demolished = demolishRoom(s, gap.id)!;
    return { s, T, t, seatFrom: seat[0].start, once: replanStaff(demolished, t), re: settleChanges(s, demolished, t) };
  }

  describe('A kept seat she gets to early by a new way survives the next re-plan', () => {
    it('demolishing the wall in a hotel with a named front desk has her wait at her seat and rest there, as one re-plan would, not rest in the hallway', () => {
      const { T, t, seatFrom, once, re } = walled(true);
      // the new way: at the break room by 12:14, while all six seats are taken till 12:18
      const lastWalk = legsOf(re, 'idle').filter(l => l.kind === 'walk').at(-1)!;
      expect(sameTile(lastWalk.path.at(-1)!, SEAT)).toBe(true);
      expect(lastWalk.end).toBeLessThan(T + 0.3);
      // she waits there till 12:25, then rests in her seat at the break room's rate till 13:00
      expect(legsOf(re, 'idle').filter(l => l.start >= lastWalk.end - 1e-9).map(l => [l.kind === 'stay' ? l.activity : 'walk', l.start, l.end]))
        .toEqual([['wait', lastWalk.end, seatFrom], ['rest', seatFrom, T + 1]]);
      expect(where(re, 'idle', T + 0.5)).toBe(IN_HER_SEAT);
      // the same as a single re-plan (a hotel's second re-plan at the same instant changes nothing), and no seventh in the room
      expect(samePlan(re, once, 'idle', t)).toBe(true);
      expect(committed(re, 'idle')).toBeCloseTo(committed(once, 'idle'), 9);
      neverOverfull(re, t, T + 1);
    });

    it('a later edit that brings her nothing, made as she walks the new way or as she waits while her seat is still taken, leaves her plan as it was', () => {
      for (const desk of [false, true]) {
        const { T, re } = walled(desk);
        // 12:09 on the way; 12:16 waiting at the break room (its seats full till 12:18). A room built far off brings nobody work
        for (const t2 of [T + 0.15, T + 0.27]) {
          const later = settleChanges(re, addRoom(re, 'standard', 7, 5, 0, 'up')!, t2);
          expect(samePlan(later, re, 'idle', t2)).toBe(true);
          expect(where(later, 'idle', T + 0.5)).toBe(IN_HER_SEAT);
          expect(committed(later, 'idle')).toBeCloseTo(committed(re, 'idle'), 9);
          neverOverfull(later, t2, T + 1);
        }
      }
    });

    it('control: an edit that brings her work while she waits for her seat sends her off to it, rather than on waiting', () => {
      const { T, re } = walled(true);
      // 12:16, waiting at the break room: a room built at (7, 5) with a turnover to do (half an hour)
      const t2 = T + 0.27;
      const built = addRoom(re, 'standard', 7, 5, 0, 'up')!;
      const room = built.rooms.at(-1)!;
      const later = settleChanges(re, { ...built, rooms: built.rooms.map(r => (r === room ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.5 } : r)) }, t2);
      const job = jobsOf(later, 'idle').find(l => l.placeId === room.id);
      expect(job).toBeDefined();
      // she sets off from the break room at once (no waiting on there for the seat), and cleans it this hour
      expect(legsOf(later, 'idle').find(l => l.end > t2 + 1e-9)).toMatchObject({ kind: 'walk', start: t2 });
      expect(job!.end).toBeLessThanOrEqual(T + 1 + 1e-9);
      expect(restsOf(later, 'idle').some(l => l.placeId === BR && l.end > t2 + 1e-9 && l.start < job!.start)).toBe(false);
    });
  });
}

// A clerk who gets to her break room early by a shortcut, the break starting after the hour: the second re-plan takes that wait as her way into the break.
{
  /**
   * 15:00 on day 2, a break room at (5, 0) and a named front desk with one late clerk at `fatigue`, planned. Rows 2 and 3
   * are built over but for (5, 3), so her way from the desk front (1, 4) to the break room goes round by x = 9 (16 tiles)
   * until the room at (5, 2) is demolished (7 tiles).
   */
  function hotel(fatigue: number): HotelState {
    const hour = 15;
    let s: HotelState = { ...createStarterHotel(), day: 2, hour, cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = addFixture(s, 'breakroom', 5, 0, 0)!;
    for (let x = 0; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up') ?? s;
    for (let x = 0; x <= 8; x++) if (x !== 5 && x !== 1) s = addRoom(s, 'standard', x, 3, 0, 'down') ?? s;
    const lane = physicalDeskLanes(s)[0];
    const clerk = { id: 'clerk', serial: 9, name: 'Clerk', role: 'front_desk', shift: 'late', at: lane.front, deskLane: lane.key, dailyWage: 40,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite' },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: 24 + hour } } as StaffMember;
    s = { ...s, guests: [], frontDeskRosterReady: true, staffRoster: [clerk], staffPlan: null, staff: { frontDesk: 1, housekeepers: 0, maintenanceWorkers: 0 } };
    return { ...s, staffPlan: getStaffPlan(s) };
  }

  const itinerary = (s: HotelState) => getStaffPlan(s).itineraries.find(it => it.staffId === 'clerk')!;
  const fixedBreak = (s: HotelState) => itinerary(s).end.fatigueBreak;
  const shortcut = (s: HotelState) => demolishRoom(s, s.rooms.find(r => r.gridX === 5 && r.gridY === 2)!.id)!;
  /** The tiles she walks from t on, in order (a turn back shows as a tile walked twice). */
  const tilesFrom = (s: HotelState, t: number) => {
    const tiles: string[] = [];
    for (const l of itinerary(s).legs) if (l.kind === 'walk' && l.end > t + 1e-9) for (const p of l.path) {
      const k = `${p.gridX},${p.gridY}`;
      if (tiles.at(-1) !== k) tiles.push(k);
    }
    return tiles;
  };
  /** Where she is at x and doing what. */
  const where = (s: HotelState, x: number) => {
    const p = positionAt(itinerary(s).legs, x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)} ${p.leg.kind === 'stay' ? p.leg.activity : 'walk'}`;
  };
  const isRest = (l: Leg): l is StayLeg => l.kind === 'stay' && l.activity === 'rest';

  describe('A shortcut that gets a clerk to her break room before the hour\'s end, the break starting after it', () => {
    it('she walks on by the shortcut and waits there for her break, not back to her desk first, and takes it at its fixed time next hour', () => {
      // At 82: at the desk till 15:36, then the long way round, at the break room 16:05; the break 16:05 to 16:35.
      // At 81.5 the same 6 minutes later (break 16:11 to 16:41). The room at (5, 2) demolished 2.4 minutes into the walk
      for (const fatigue of [82, 81.5]) {
        const s = hotel(fatigue);
        const T = hourStart(s);
        const brk = fixedBreak(s)!;
        const walk = itinerary(s).legs.find(l => l.kind === 'walk')!;
        expect(walk.end).toBeCloseTo(brk.start, 9);
        expect(brk.start).toBeGreaterThan(T + 1);
        const t = walk.start + 0.04;
        const re = settleChanges(s, shortcut(s), t);
        // the same break, from the same start to the same end
        expect(fixedBreak(re)).toMatchObject({ start: brk.start, end: brk.end, placeId: brk.placeId });
        // on by the shortcut from where she is: no tile twice, never back at the desk
        const tiles = tilesFrom(re, t);
        expect(tiles.at(-1)).toBe(`${brk.at.gridX},${brk.at.gridY}`);
        expect(tiles).not.toContain('1,4');
        expect(new Set(tiles).size).toBe(tiles.length);
        expect(tiles.length).toBeLessThanOrEqual(8);
        // there before the hour's end, waiting (not resting early) till it ends
        expect(where(re, T + 0.95)).toBe(`${brk.at.gridX.toFixed(3)},${brk.at.gridY.toFixed(3)} wait`);
        expect(where(re, T + 0.999)).toBe(`${brk.at.gridX.toFixed(3)},${brk.at.gridY.toFixed(3)} wait`);
        expect(itinerary(re).legs.some(l => isRest(l) && l.end > t)).toBe(false);
        // next hour: the half-hour break from its fixed start to its fixed end, in the break room
        const next = tickSimulation(re, new PRNG(9)).state;
        expect(itinerary(next).legs.filter(isRest)[0]).toMatchObject({ start: brk.start, end: brk.end, placeId: brk.placeId });
      }
    });

    it('a later paused edit on the shorter way there (a room going dirty, a room built far off) keeps her walking on to the same break', () => {
      // At 82: the shortcut at 15:38, at the break room at 15:50 to wait for the break at 16:05. A second edit at 15:45
      const s = hotel(82);
      const T = hourStart(s);
      const brk = fixedBreak(s)!;
      const t = itinerary(s).legs.find(l => l.kind === 'walk')!.start + 0.04;
      const s1 = settleChanges(s, shortcut(s), t);
      const t2 = T + 0.75;
      const dirtied: HotelState = { ...s1, rooms: s1.rooms.map(r => (r.gridX === 0 && r.gridY === 2 ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 1, cleaningHoursTotal: 1 } : r)) };
      for (const after of [dirtied, addRoom(s1, 'standard', 7, 5, 0, 'up')!]) {
        const s2 = settleChanges(s1, after, t2);
        expect(fixedBreak(s2)).toMatchObject({ start: brk.start, end: brk.end, placeId: brk.placeId });
        const tiles = tilesFrom(s2, t2);
        expect(new Set(tiles).size).toBe(tiles.length);
        expect(tiles).not.toContain('1,4');
        for (const x of [t2 + 0.01, T + 0.85, T + 0.999]) expect(where(s2, x)).toBe(where(s1, x));
        expect(itinerary(tickSimulation(s2, new PRNG(9)).state).legs.filter(isRest)[0]).toMatchObject({ start: brk.start, end: brk.end });
      }
    });

    it('control, the break due before the hour\'s end: by the same shortcut she waits there for its start and takes it then', () => {
      // At 83: at the desk till 15:24, the long way round to the break room at 15:53, the break 15:53 to 16:23
      const s = hotel(83);
      const T = hourStart(s);
      const brk = fixedBreak(s)!;
      expect(brk.start).toBeLessThan(T + 1);
      const t = itinerary(s).legs.find(l => l.kind === 'walk')!.start + 0.04;
      const re = settleChanges(s, shortcut(s), t);
      expect(fixedBreak(re)).toMatchObject({ start: brk.start, end: brk.end, placeId: brk.placeId });
      const tiles = tilesFrom(re, t);
      expect(new Set(tiles).size).toBe(tiles.length);
      expect(where(re, brk.start - 0.01)).toMatch(/ wait$/);
      expect(itinerary(re).legs.filter(isRest).filter(l => l.end > t)).toMatchObject([{ start: brk.start, end: T + 1, placeId: brk.placeId }]);
      expect(itinerary(tickSimulation(re, new PRNG(9)).state).legs[0]).toMatchObject({ activity: 'rest', end: brk.end });
    });
  });
}

// A later paused edit while she waits there leaves her waiting for the same break.
{
  /**
   * 15:00 on day 2, a break room at (5, 0) and a named front desk with one late clerk at `fatigue`, planned. Rows 2 and 3
   * are built over but for (5, 3), so her way from the desk front (1, 4) to the break room goes round by x = 9 (16 tiles)
   * until the room at (5, 2) is demolished (7 tiles).
   */
  function hotel(fatigue: number): HotelState {
    const hour = 15;
    let s: HotelState = { ...createStarterHotel(), day: 2, hour, cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = addFixture(s, 'breakroom', 5, 0, 0)!;
    for (let x = 0; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up') ?? s;
    for (let x = 0; x <= 8; x++) if (x !== 5 && x !== 1) s = addRoom(s, 'standard', x, 3, 0, 'down') ?? s;
    const lane = physicalDeskLanes(s)[0];
    const clerk = { id: 'clerk', serial: 9, name: 'Clerk', role: 'front_desk', shift: 'late', at: lane.front, deskLane: lane.key, dailyWage: 40,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite' },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: 24 + hour } } as StaffMember;
    s = { ...s, guests: [], frontDeskRosterReady: true, staffRoster: [clerk], staffPlan: null, staff: { frontDesk: 1, housekeepers: 0, maintenanceWorkers: 0 } };
    return { ...s, staffPlan: getStaffPlan(s) };
  }

  const itinerary = (s: HotelState) => getStaffPlan(s).itineraries.find(it => it.staffId === 'clerk')!;
  const fixedBreak = (s: HotelState) => itinerary(s).end.fatigueBreak;
  const roomAt = (s: HotelState, x: number, y: number) => s.rooms.find(r => r.gridX === x && r.gridY === y)!;
  const isRest = (l: Leg): l is StayLeg => l.kind === 'stay' && l.activity === 'rest';
  /** Where she is at x and doing what. */
  const where = (s: HotelState, x: number) => {
    const p = positionAt(itinerary(s).legs, x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)} ${p.leg.kind === 'stay' ? p.leg.activity : 'walk'}`;
  };
  const BREAK_ROOM = '5.000,0.000';
  /** Her fatigue as the hour closes. */
  const fatigueAfter = (s: HotelState) => tickSimulation(s, new PRNG(9)).state.staffRoster!.find(m => m.id === 'clerk')!.stats!.fatigue!;

  /** The shortcut opened just after she sets off, and the state when she is halfway through her wait at the break room. */
  function waitingThere(fatigue: number) {
    const s = hotel(fatigue);
    const T = hourStart(s);
    const brk = fixedBreak(s)!;
    const t = itinerary(s).legs.find(l => l.kind === 'walk')!.start + 0.04;
    const s1 = settleChanges(s, demolishRoom(s, roomAt(s, 5, 2).id)!, t);
    const wait = itinerary(s1).legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.start > t)!;
    expect(wait.at).toMatchObject({ gridX: 5, gridY: 0 });
    return { T, brk, s1, t2: (wait.start + wait.end) / 2 };
  }

  /** Edits at t2 that bring the clerk nothing: a room built far off, a room demolished on the other side, a plain re-plan. */
  const unrelatedEdits = (s1: HotelState, t2: number): Record<string, HotelState> => ({
    'a room built at (8, 5)': settleChanges(s1, addRoom(s1, 'standard', 8, 5, 0, 'up')!, t2),
    'the room at (0, 2) demolished': settleChanges(s1, demolishRoom(s1, roomAt(s1, 0, 2).id)!, t2),
    'a re-plan': replanStaff(s1, t2),
  });

  describe('A paused edit while a clerk waits in the break room for her compulsory break', () => {
    it('an edit that has nothing to do with her leaves her waiting there, and next hour she takes the same break at its fixed time', () => {
      // At 82: at the desk till 15:36, the shortcut at 15:38, in the break room at 15:50 to wait for the break at
      // 16:05 to 16:35; the edit at 15:55. At 81.5: in the break room at 15:56, the edit at 15:58, the break 16:11 to 16:41
      for (const fatigue of [82, 81.5]) {
        const { T, brk, s1, t2 } = waitingThere(fatigue);
        expect(brk.start).toBeGreaterThan(T + 1);
        for (const [edit, s2] of Object.entries(unrelatedEdits(s1, t2))) {
          const label = `${fatigue}, ${edit}`;
          // still waiting in the break room to the hour's end: no walk back to the desk
          for (const x of [t2 + 0.01, T + 0.999]) expect(where(s2, x), label).toBe(`${BREAK_ROOM} wait`);
          expect(itinerary(s2).legs.filter(l => l.kind === 'walk' && l.end > t2 + 1e-9), label).toEqual([]);
          // the same break, from the same start to the same end
          expect(fixedBreak(s2), label).toMatchObject({ start: brk.start, end: brk.end, placeId: brk.placeId });
          // next hour: there already, the half-hour break from its fixed start to its fixed end, no more tired than without the edit
          const next = itinerary(tickSimulation(s2, new PRNG(9)).state).legs;
          expect(next.filter(isRest)[0], label).toMatchObject({ start: brk.start, end: brk.end, placeId: brk.placeId });
          expect(next.filter(l => l.kind === 'walk' && l.start < brk.start), label).toEqual([]);
          expect(fatigueAfter(s2), label).toBeCloseTo(fatigueAfter(s1), 6);
        }
      }
    });

    it('the same for a break due before the hour\'s end: she waits on for its start and rests from then to its fixed end', () => {
      // At 83: at the desk till 15:24, the shortcut at 15:26, in the break room at 15:38 to wait for the break at
      // 15:53 to 16:23; the edit at 15:46
      const { T, brk, s1, t2 } = waitingThere(83);
      expect(brk.start).toBeLessThan(T + 1);
      for (const [edit, s2] of Object.entries(unrelatedEdits(s1, t2))) {
        expect(where(s2, brk.start - 0.01), edit).toBe(`${BREAK_ROOM} wait`);
        expect(itinerary(s2).legs.filter(l => l.kind === 'walk' && l.end > t2 + 1e-9), edit).toEqual([]);
        expect(fixedBreak(s2), edit).toMatchObject({ start: brk.start, end: brk.end, placeId: brk.placeId });
        expect(itinerary(s2).legs.filter(isRest).filter(l => l.end > t2), edit).toMatchObject([{ start: brk.start, end: T + 1, placeId: brk.placeId }]);
        expect(itinerary(tickSimulation(s2, new PRNG(9)).state).legs[0], edit).toMatchObject({ activity: 'rest', end: brk.end, placeId: brk.placeId });
        expect(fatigueAfter(s2), edit).toBeCloseTo(fatigueAfter(s1), 6);
      }
    });

    it('control: with the break room itself demolished while she waits there, she doesn\'t wait on for a break in a room that\'s gone', () => {
      // At 82, as above: the break room demolished at 15:55
      const { T, brk, s1, t2 } = waitingThere(82);
      const s2 = settleChanges(s1, demolishFixture(s1, s1.fixtures.find(f => f.type === 'breakroom')!.id)!, t2);
      expect(where(s2, T + 0.999)).not.toBe(`${BREAK_ROOM} wait`);
      const next = itinerary(tickSimulation(s2, new PRNG(9)).state).legs;
      expect([...itinerary(s2).legs, ...next].filter(l => l.kind === 'stay' && l.end > t2 && l.placeId === brk.placeId)).toEqual([]);
      // (she still gets her rest, somewhere else)
      expect(next.some(isRest)).toBe(true);
    });
  });
}

// A break she gets to early by a new way, waiting there for it, survives the next re-plan too.
{
  // A wait at the break room for a break she reaches early by a new way is part of the way to it, as for a spare-time seat:
  // the next re-plan (Settle's second, with a named front desk, or a later paused edit) keeps her break where it was.
  {
    /**
     * 12:00 on day 2: rooms along row 3 from x = 3 to 9, doors down (a wall), the break room at (5, 0), a named front desk.
     * 'k' at (9, 4) with nothing to do, `fatigue` at the hour's start: the long way round to the break room, there at 12:25.
     */
    function hotel(fatigue: number): HotelState {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      s = addFixture(s, 'breakroom', 5, 0, 0)!;
      for (let x = 3; x < 10; x++) s = addRoom(s, 'standard', x, 3, 0, 'down')!;
      const k = { id: 'k', serial: 1, name: 'k', role: 'housekeeper', dailyWage: 70, at: { gridX: 9, gridY: 4, floor: 0 },
        profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', specialty: 'turnover_runner' },
        stats: { workHours: 100, lateDays: 0, absentDays: 0, fatigue, fatigueAt: 36 } } as StaffMember;
      s = { ...s, day: 2, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 }, staffRoster: [k] };
      s = initializeFrontDesk(s);
      return { ...s, staffPlan: getStaffPlan(s) };
    }
    const legsOf = (s: HotelState) => getStaffPlan(s).itineraries.find(it => it.staffId === 'k')!.legs;
    const stays = (s: HotelState, activity: string) => legsOf(s).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === activity);

    describe('A break she gets to early by a new way, waiting there for it', () => {
      it('reached at 85 or more (84.9 at 12:00), or a compulsory break due in the hour (85.5): the room in the wall demolished at 12:03 has her wait at the break room for it, and Settle\'s second re-plan and a later edit keep it', () => {
        for (const fatigue of [84.9, 85.5]) {
          const s = hotel(fatigue);
          expect(namedFrontDesk(s)).toBe(true);
          const T = hourStart(s);
          const rests = (st: HotelState, from: number) => stays(st, 'rest').filter(l => l.end > from).map(l => [+l.start.toFixed(9), +l.end.toFixed(9), l.placeId]);
          const [brk] = stays(s, 'rest');
          expect(brk.idle).toBeUndefined(); // a break, not spare time
          expect(brk.start).toBeCloseTo(T + 0.42, 2);
          const walk = legsOf(s).find((l): l is WalkLeg => l.kind === 'walk' && l.path.at(-1)!.gridY === 0)!;
          const t = walk.start + 0.05;
          const demolished = demolishRoom(s, s.rooms[2].id)!; // (5, 3): a shortcut
          const once = replanStaff(demolished, t);
          // one re-plan: the shortcut, then a wait at the break room till the break's start, the break (and any rest after it) as it was
          const [wait] = stays(once, 'wait').filter(l => l.end > t);
          expect(wait, `${fatigue}`).toBeDefined();
          expect(wait.end).toBeCloseTo(brk.start, 9);
          expect(rests(once, t), `${fatigue}`).toEqual(rests(s, t));
          // Settle's two re-plans, a second re-plan at the same moment, and a paused edit later in the wait: the same
          const later = wait.start + (wait.end - wait.start) / 2;
          for (const [label, re, from] of [['settle', settleChanges(s, demolished, t), t], ['twice', replanStaff(once, t), t],
            ['later edit', replanStaff(once, later), later]] as [string, HotelState, number][]) {
            expect(rests(re, from), `${fatigue} ${label}`).toEqual(rests(s, from));
            const waits = stays(re, 'wait').filter(l => l.end > from);
            expect(waits.length, `${fatigue} ${label}`).toBeGreaterThan(0);
            expect(waits.at(-1)!.end).toBeCloseTo(brk.start, 9);
          }
        }
      });
    });
  }
}

// A walk to the break's tile, or a wait there that runs into it, keeps a compulsory break; a walk out of the hotel, or a break with no time left in it, doesn't.
{
  const BR = 'breakroom-0-5-0';
  const SEAT = { gridX: 5, gridY: 0, floor: 0 };

  /** A housekeeper (or maintenance worker) standing at `at` (a room: in it, and keeping at it), `fatigue` as of the hour's start. */
  function worker(id: string, at: Room | TilePos, abs: number, fatigue: number, role: 'housekeeper' | 'maintenance' = 'housekeeper'): StaffMember {
    const room = 'id' in at ? at as Room : undefined;
    return { id, serial: id.length, name: id, role, dailyWage: 70, at: room ? roomTile(room) : at, ...(room ? { roomId: room.id } : {}),
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', specialty: 'turnover_runner' },
      stats: { workHours: 100, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  const itinerary = (s: HotelState, id: string) => getStaffPlan(s).itineraries.find(it => it.staffId === id)!;
  const legsOf = (s: HotelState, id: string): Leg[] => itinerary(s, id).legs;
  const staysOf = (s: HotelState, id: string, activity: StayLeg['activity']) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === activity);

  // A break room demolished late in someone's break there, her nearest spot so far off that she'd get there after the break's
  // fixed end: what's left is a "break" with no time in it. Planned from where she stands, it has her walk there for nothing;
  // once she can be there before it, it isn't a break to wait for, and the next re-plan sends her back to work.
  {
    /**
     * 12:00 on day 2: rooms along row 2 from x = 0 to 8, doors up (a wall: the only way between the break room's side, rows 0
     * and 1, and the desk's side, rows 3 to 5, is round by x = 9), the break room at (5, 0), the desk front at (1, 4).
     * 'H' (86, due a break) starts at (5, 4); the room at (8, 2) wants a 5-minute turnover. With `desk`, a named front desk
     * as in a real game (Settle re-plans twice after a build or demolish).
     */
    function hotel(desk: boolean): HotelState {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      s = addFixture(s, 'breakroom', 5, 0, 0)!;
      for (let x = 0; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
      const abs = 36;
      s = { ...s, day: 2, hour: 12, guests: [], noiseSources: [], staffPlan: null, staffRoster: [worker('H', { gridX: 5, gridY: 4, floor: 0 }, abs, 86)],
        staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
        rooms: s.rooms.map(r => (r.gridX === 8 ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.08, cleaningHoursTotal: 1 } : r)) };
      if (desk) s = initializeFrontDesk(s);
      return { ...s, staffPlan: getStaffPlan(s) };
    }
    const DESK_FRONT = { gridX: 1, gridY: 4, floor: 0 };
    const roomAt = (s: HotelState, x: number, y: number) => s.rooms.find(r => r.gridX === x && r.gridY === y)!;

    describe('A compulsory break cut short by its break room going, with no time left by the time she\'d get to a spot nearby', () => {
      it('she isn\'t kept going to it, nor waiting at the desk front for it once a shortcut gets her there before it: she goes back to the turnover', () => {
        for (const desk of [true, false]) {
          const s = hotel(desk);
          const T = hourStart(s);
          expect(namedFrontDesk(s), `desk ${desk}`).toBe(desk);
          // the long way round to the break room, her break there 12:21.6 to 12:51.6
          const brk = staysOf(s, 'H', 'rest')[0];
          expect(brk).toMatchObject({ placeId: BR, restRate: STAFF_FATIGUE.roomRecovery });
          expect(brk.start).toBeCloseTo(T + 0.36, 9);
          expect(brk.end).toBeCloseTo(T + 0.86, 9);
          // 12:37.2: the break room demolished. The desk front is 16 tiles off the long way: there at 13:06, after the break's
          // fixed end, so the break she's left with starts and ends then
          const t1 = T + 0.62;
          const s1 = settleChanges(s, demolishFixture(s, s.fixtures.find(f => f.type === 'breakroom')!.id)!, t1);
          const left = itinerary(s1, 'H').end.fatigueBreak;
          if (desk) {
            // (with a named desk, Settle's second re-plan of the demolition finds her on her way to it: no break to go to)
            expect(left, `desk ${desk}`).toBeUndefined();
          } else {
            expect(sameTile(left!.at, DESK_FRONT), `desk ${desk}`).toBe(true);
            expect(left!.start).toBeGreaterThan(T + 1);
            expect(left!.end).toBeCloseTo(left!.start, 9);
          }
          // 12:40.2: the room at (4, 2) demolished opens a shortcut through the wall (at the desk front by 12:59, before that
          // break); 12:43.2: a room built far off
          const t2 = T + 0.67, t3 = T + 0.72;
          const s2 = settleChanges(s1, demolishRoom(s1, roomAt(s1, 4, 2).id)!, t2);
          const s3 = settleChanges(s2, addRoom(s2, 'standard', 7, 5, 0, 'up')!, t3);
          // (the next re-plan once she's on her way to it has her back at work: with a named desk, Settle's second re-plan of
          // the demolition)
          for (const [label, after, from] of [...(desk ? [['the demolition', s1, t1]] : []), ['the shortcut', s2, t2], ['the later edit', s3, t3]] as [string, HotelState, number][]) {
            const tag = `desk ${desk}, after ${label}`;
            // no waiting at the desk front: the turnover at (8, 2) done this hour, and no break held
            expect(staysOf(after, 'H', 'wait').filter(l => l.end > from + 1e-9 && sameTile(l.at, DESK_FRONT)), tag).toEqual([]);
            const clean = staysOf(after, 'H', 'clean').find(l => l.placeId === roomAt(after, 8, 2).id && l.start > t1);
            expect(clean, tag).toBeDefined();
            expect(clean!.end, tag).toBeLessThanOrEqual(T + 1 + 1e-9);
            expect(itinerary(after, 'H').end.fatigueBreak, tag).toBeUndefined();
          }
        }
      });
    });
  }

  // A housekeeper let go during her break in a full break room: walking out, she holds no seat there.
  {
    /**
     * 12:00 on day 2, the break room at (5, 0) (six seats) and rooms at (3..6, 2), doors up. Five maintenance workers (30,
     * nothing to do) rest in its seats all hour. 'L' (82) turns over (3, 2) till 12:36, then takes her compulsory break in the
     * last seat, 12:43 to 13:13; 'C' (80.5) turns over (4, 2) till 12:54, the room full: her break is in the hallway at (4, 1).
     */
    function hotel(desk: boolean): HotelState {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      s = addFixture(s, 'breakroom', 5, 0, 0)!;
      for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
      const abs = 36;
      const crew = [...Array.from({ length: BREAK_ROOM.seats - 1 }, (_, i) => worker(`mx${i}`, SEAT, abs, 30, 'maintenance')),
        worker('L', s.rooms[0], abs, 82), worker('C', s.rooms[1], abs, 80.5)];
      s = { ...s, day: 2, hour: 12, guests: [], noiseSources: [], staffPlan: null, staffRoster: crew,
        staff: { ...s.staff, housekeepers: 2, maintenanceWorkers: BREAK_ROOM.seats - 1 },
        rooms: s.rooms.map((r, i) => (i < 2 ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 3 } : r)) };
      if (desk) s = initializeFrontDesk(s);
      return { ...s, staffPlan: getStaffPlan(s) };
    }

    describe('A housekeeper let go during her compulsory break, the break room otherwise full', () => {
      it('once she\'s walking out, a later edit holds no seat for her: a colleague due a break gets it, not the hallway', () => {
        for (const desk of [true, false]) {
          const s = hotel(desk);
          const T = hourStart(s);
          // the scene: L in the last seat from 12:43, C's break in the hallway from 12:56
          const lBreak = staysOf(s, 'L', 'rest')[0];
          expect(lBreak).toMatchObject({ placeId: BR });
          expect(lBreak.end).toBeGreaterThan(T + 1);
          const cBreak = staysOf(s, 'C', 'rest')[0];
          expect(cBreak.placeId, `desk ${desk}`).toBeUndefined();
          expect(cBreak.start).toBeLessThan(T + 1);
          // 12:45: L let go, from her seat; 12:49.8, L on her way out: a room built far off
          const t0 = T + 0.75, t1 = T + 0.83;
          const s1 = settleChanges(s, dismissStaff(s, 'L', t0)!, t0);
          const s2 = settleChanges(s1, addRoom(s1, 'standard', 8, 5, 0, 'up')!, t1);
          const tag = `desk ${desk}`;
          // (this checks the edit after the let-go, made as she walks out)
          // C: her break in the seat L left, at the break room's rate, and never more than six in the room
          const rest = staysOf(s2, 'C', 'rest').find(l => l.end > t1 + 1e-9)!;
          expect(rest, tag).toMatchObject({ placeId: BR, restRate: STAFF_FATIGUE.roomRecovery });
          expect(sameTile(rest.at, SEAT), tag).toBe(true);
          for (let x = t1; x < T + 1; x += 0.005) expect(breakRoomOccupancy(s2, BR, x), `${tag} at ${x}`).toBeLessThanOrEqual(BREAK_ROOM.seats);
          // L: walking on out to the street, no break on her plan
          const out = legsOf(s2, 'L').filter(l => l.end > t1 + 1e-9);
          expect(out.length, tag).toBeGreaterThan(0);
          expect(out.every(l => l.kind === 'walk'), tag).toBe(true);
          const last = out.at(-1)!;
          expect(last.kind === 'walk' && isEntranceTile(s2, last.path.at(-1)!), tag).toBe(true);
          expect(itinerary(s2, 'L').end.fatigueBreak, tag).toBeUndefined();
        }
      });
    });
  }
}

// Only a rest planned because there's nothing to do is marked, and only with fatigue on: a wait for her seat isn't; with fatigue off a re-plan keeps each housekeeper at the room her plan had next.
{
  afterEach(() => { STAFF_FATIGUE.enabled = true; });

  // A seat she gets to early by a new way: the wait there for it isn't spare-time rest, only the rest after it is.
  {
    const BR = 'breakroom-0-5-0';
    const SEAT = { gridX: 5, gridY: 0, floor: 0 };

    /** A housekeeper standing at `at` (a room: in it), `fatigue` as of the hour's start. */
    function keeper(id: string, at: Room | TilePos, abs: number, fatigue: number): StaffMember {
      const room = 'id' in at ? at as Room : undefined;
      return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: room ? roomTile(room) : at,
        profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', specialty: 'turnover_runner' },
        stats: { workHours: 100, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
    }

    const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)!.legs;
    /** Her stays at the break room from the hour's start on: what each is, when, and whether it's marked as spare time. */
    const atSeat = (s: HotelState, id: string) => legsOf(s, id)
      .filter((l): l is StayLeg => l.kind === 'stay' && sameTile(l.at, SEAT) && l.end > hourStart(s) + 1e-9)
      .map(l => ({ activity: l.activity, start: l.start, end: l.end, idle: !!l.idle }));

    /**
     * 12:00 on day 2: a wall of rooms across row 3 (x 3..9, doors down onto row 4), the break room at (5, 0). Six housekeepers
     * fill its seats on compulsory breaks from 11:48 till 12:18, each with a wall room to turn over after; 'idle' (30) has
     * nothing to do and walks the long way round the wall from (9, 4), to rest in a seat they've freed from 12:25. With
     * `desk`, a named front desk (Settle re-plans twice). Demolishing the wall room at (7, 3) at 12:03 opens a shortcut:
     * she's there at 12:14, all six seats still taken, and waits for hers.
     */
    function walled(desk: boolean) {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      s = addFixture(s, 'breakroom', 5, 0, 0)!;
      for (let x = 3; x < 10; x++) s = addRoom(s, 'standard', x, 3, 0, 'down')!;
      const gap = s.rooms[4], abs = 36;
      const crew: StaffMember[] = Array.from({ length: BREAK_ROOM.seats }, (_, i) => ({ ...keeper(`w${i}`, SEAT, abs, 70),
        fatigueBreak: { at: SEAT, placeId: BR, start: abs - 0.2, end: abs + 0.3 } }));
      crew.push(keeper('idle', { gridX: 9, gridY: 4, floor: 0 }, abs, 30));
      const jobs = s.rooms.filter(r => r !== gap).slice(0, BREAK_ROOM.seats);
      s = { ...s, day: 2, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: crew.length, maintenanceWorkers: 0 }, staffRoster: crew,
        rooms: s.rooms.map(r => (jobs.includes(r) ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.5 } : r)) };
      if (desk) s = initializeFrontDesk(s);
      s = { ...s, staffPlan: getStaffPlan(s) };
      const T = hourStart(s), t = T + 0.05;
      const demolished = demolishRoom(s, gap.id)!;
      return { s, T, t, once: replanStaff(demolished, t), re: settleChanges(s, demolished, t) };
    }

    describe('The wait for her seat, there early by a new way, is not marked as spare time; only her rest in it is', () => {
      it('the wall demolished at 12:03 (one re-plan, or Settle\'s two with a named desk): the wait from 12:14 to 12:25 is unmarked, the rest from 12:25 to 13:00 marked', () => {
        for (const desk of [false, true]) {
          const { s, T, once, re } = walled(desk);
          // the hour's plan: her rest in the seat from 12:25, marked as spare time
          const [planned] = atSeat(s, 'idle');
          expect(planned).toMatchObject({ activity: 'rest', idle: true, end: T + 1 });
          for (const after of [once, re]) {
            const stays = atSeat(after, 'idle');
            expect(stays.map(l => l.activity)).toEqual(['wait', 'rest']);
            const [wait, rest] = stays;
            expect(wait.start).toBeLessThan(T + 0.3); // 12:14, the seats full till 12:18
            expect(wait.end).toBeCloseTo(planned.start, 9);
            expect(rest).toMatchObject({ start: wait.end, end: T + 1, idle: true });
            expect(wait.idle).toBe(false);
          }
        }
      });

      it('a later edit that brings her nothing, made as she walks the new way (12:09) or waits at the break room (12:16), keeps the marks so: wait unmarked, rest marked', () => {
        for (const desk of [false, true]) {
          const { T, re } = walled(desk);
          for (const t2 of [T + 0.15, T + 0.27]) {
            const later = settleChanges(re, addRoom(re, 'standard', 7, 5, 0, 'up')!, t2);
            const stays = atSeat(later, 'idle').filter(l => l.end > t2 + 1e-9);
            expect(stays.map(l => [l.activity, l.idle])).toEqual([['wait', false], ['rest', true]]);
          }
        }
      });
    });
  }

  // With fatigue off, a paused edit that brings nothing new leaves each housekeeper resting at home for a do-not-disturb
  // party the room her plan had next: her own room comes first, against a colleague re-planned with her.
  {
    const PACE = TRAVEL.guestHoursPerTile;
    const BASE = { gridX: 1, gridY: 4, floor: 0 };

    /** A fast housekeeper (high stamina, fresh) standing in `room`. */
    function keeper(id: string, room: Room, abs: number): StaffMember {
      return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: roomTile(room),
        profile: { experience: 'veteran', style: 'speedy', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
        stats: { workHours: 500, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: abs } } as StaffMember;
    }

    /** A do-not-disturb guest in `room` going out at `leave`, back at `back`. */
    function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
      const tile = roomTile(room);
      const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
      const walkOut = makeWalk(out.path, leave, PACE);
      const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
      return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
        profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
        tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
    }

    /**
     * 12:00 on day 3, three standard rooms on row 2 from x = 3. D1 (3, 2): party out 12:45-13:00; D2 (4, 2): party out
     * 12:33-13:03; 0.1h of daily cleaning each, D1 first in the queue (its party back sooner). hk-c and hk-b (both fast,
     * hk-c first on the roster) walk from (5, 2) to the base and rest there till 12:26: hk-c then waits at D1's door from
     * 12:35 and cleans it at 12:50-12:54; hk-b cleans D2 at 12:38-12:42.
     */
    function scene(): { s: HotelState; T: number; D1: Room; D2: Room } {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
      const abs = 2 * 24 + 12;
      s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2 },
        staffRoster: [keeper('hk-c', s.rooms[2], abs), keeper('hk-b', s.rooms[2], abs)] };
      const T = hourStart(s), [D1, D2] = s.rooms;
      s = { ...s, guests: [goingOut(s, D1, T + 0.75, T + 1, 'g1'), goingOut(s, D2, T + 0.55, T + 1.05, 'g2')],
        rooms: s.rooms.map(r => (r.id === D1.id ? { ...r, status: 'occupied' as const, guestId: 'g1', dailyCleanHoursRemaining: 0.1 }
          : r.id === D2.id ? { ...r, status: 'occupied' as const, guestId: 'g2', dailyCleanHoursRemaining: 0.1 } : r)) };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T, D1, D2 };
    }

    const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
    const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
    const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
    /** The day each room was last given its daily clean, after playing on two hours. */
    const cleanedDay = (s: HotelState, rooms: Room[]) => {
      let st = s;
      for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
      return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
    };

    describe('With fatigue off, an edit that brings nothing new leaves each housekeeper resting at home for a do-not-disturb party the room her plan had next', () => {
      it('fatigue off: their rests at home till 12:26 are not marked as spare time (no recovery to give up)', () => {
        STAFF_FATIGUE.enabled = false;
        const { s, T } = scene();
        for (const id of ['hk-c', 'hk-b']) {
          const [home] = restsOf(s, id);
          expect(home).toMatchObject({ at: BASE });
          expect(home.end).toBeCloseTo(T + 0.43, 3);
          expect(home.idle).toBeUndefined();
        }
      });

      it('fatigue off: a paused edit, or a room built far off, between 12:12 and 12:21 keeps D1 hk-c\'s and D2 hk-b\'s, and both are cleaned', () => {
        STAFF_FATIGUE.enabled = false;
        const { s, T, D1, D2 } = scene();
        expect(jobsOf(s, 'hk-c').map(l => l.placeId)).toEqual([D1.id]);
        expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D2.id]);
        for (const dt of [0.2, 0.25, 0.3, 0.35]) {
          const t = T + dt;
          for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t)]) {
            // hk-c (first on the roster) doesn't take D2 from hk-b, who'd then be left with nothing all hour
            expect(jobsOf(re, 'hk-c').map(l => l.placeId)).toEqual([D1.id]);
            expect(jobsOf(re, 'hk-b').map(l => l.placeId)).toEqual([D2.id]);
            expect(cleanedDay(re, [D1, D2])).toEqual([3, 3]);
          }
        }
      });

      it('control, fatigue on: the same edits leave the same rooms to each (the room she rests at home for stays hers)', () => {
        const { s, T, D1, D2 } = scene();
        expect(jobsOf(s, 'hk-c').map(l => l.placeId)).toEqual([D1.id]);
        expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D2.id]);
        for (const dt of [0.2, 0.25, 0.3, 0.35]) {
          const t = T + dt;
          for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t)]) {
            expect(jobsOf(re, 'hk-c').map(l => l.placeId)).toEqual([D1.id]);
            expect(jobsOf(re, 'hk-b').map(l => l.placeId)).toEqual([D2.id]);
          }
        }
      });
    });
  }
}

// A game saved by an older version with a housekeeper waiting at the desk front for a compulsory break with no time left in it: the next paused edit carries no such break, on her way there or while she waits, and she turns the room at hand over this hour (mutation check).
{
  // A break with no time left in it, waited for at the desk front in a game saved before this change: a paused edit sends her back to work.
  const DESK_FRONT = { gridX: 1, gridY: 4, floor: 0 };

  /**
   * 12:00 on day 2: rooms along row 2 from x = 0 to 8, doors up (a wall: the only way between the break room's side, rows
   * 0 and 1, and the desk's side, rows 3 to 5, is round by x = 9), the break room at (1, 0), the desk front at (1, 4) (the
   * only spot left to rest at once the break room's gone), and the room at (1, 5), its door on the desk front, wanting a
   * 5-minute turnover. 'H' (86, due a break) stands at (2, 1), next to the break room. With `desk`, a named front desk as
   * in a real game (Settle re-plans twice after a build or demolish).
   */
  function hotel(desk: boolean): HotelState {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = addFixture(s, 'breakroom', 1, 0, 0)!;
    for (let x = 0; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
    s = addRoom(s, 'standard', 1, 5, 0, 'up')!;
    const H = { id: 'H', serial: 1, name: 'H', role: 'housekeeper', dailyWage: 70, at: { gridX: 2, gridY: 1, floor: 0 },
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', specialty: 'turnover_runner' },
      stats: { workHours: 100, lateDays: 0, absentDays: 0, fatigue: 86, fatigueAt: 36 } } as StaffMember;
    s = { ...s, day: 2, hour: 12, guests: [], noiseSources: [], staffPlan: null, staffRoster: [H],
      staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      rooms: s.rooms.map(r => (r.gridX === 1 && r.gridY === 5 ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.08, cleaningHoursTotal: 1 } : r)) };
    if (desk) s = initializeFrontDesk(s);
    return { ...s, staffPlan: getStaffPlan(s) };
  }

  const itinerary = (s: HotelState) => getStaffPlan(s).itineraries.find(it => it.staffId === 'H')!;
  const staysOf = (s: HotelState, activity: StayLeg['activity']) => itinerary(s).legs.filter((l): l is StayLeg => l.kind === 'stay' && l.activity === activity);
  const roomAt = (s: HotelState, x: number, y: number) => s.rooms.find(r => r.gridX === x && r.gridY === y)!;
  /** Her waits at the desk front running past t. */
  const waitsAtDeskFront = (s: HotelState, t: number) => staysOf(s, 'wait').filter(l => sameTile(l.at, DESK_FRONT) && l.end > t + 1e-9);
  /** Her turnover of the room at (1, 5) after t, if it's done this hour. */
  const turnover = (s: HotelState, t: number) => staysOf(s, 'clean').find(l => l.placeId === roomAt(s, 1, 5).id && l.start >= t - 1e-9 && l.end <= hourStart(s) + 1 + 1e-9);
  /** What she's doing at x. */
  const doing = (s: HotelState, x: number) => { const leg = positionAt(itinerary(s).legs, x)!.leg as Leg; return leg.kind === 'stay' ? leg.activity : 'walk'; };

  /**
   * The game as the version before this change saved it. 12:03.6: in the break room, her break till 12:33.6. 12:27: the
   * break room demolished; the desk front is 20 tiles off the long way round, there at 13:03, after the break's fixed end,
   * so the break she's left with starts and ends then. 12:27.6: the room at (2, 2) demolished, a shortcut through the
   * wall. That version kept any break on a walk under way, so its re-plan of the shortcut had her go on to the desk front
   * by it, there at 12:37.8, to wait to 13:03 for that "break" (a rest with no time in it at the end). Her own entry holds
   * no break: this one began this hour. (Made here as that version made it: the shortcut re-planned with the break hers.)
   * Then saved, and loaded in this version.
   */
  function oldSave(desk: boolean) {
    const s = hotel(desk);
    const T = hourStart(s);
    expect(namedFrontDesk(s), `desk ${desk}`).toBe(desk);
    // the scene: her break in the break room, 12:03.6 to 12:33.6, then the long way round to the turnover
    const [brk] = staysOf(s, 'rest');
    expect(brk).toMatchObject({ placeId: s.fixtures.find(f => f.type === 'breakroom')!.id, restRate: STAFF_FATIGUE.roomRecovery });
    expect(brk.idle).toBeUndefined(); // a break, not spare time
    expect(brk.start).toBeCloseTo(T + 0.06, 9);
    expect(brk.end).toBeCloseTo(T + 0.56, 9);
    const s1 = replanStaff(demolishFixture(s, s.fixtures.find(f => f.type === 'breakroom')!.id)!, T + 0.45, s);
    const left = itinerary(s1).end.fatigueBreak!;
    expect(sameTile(left.at, DESK_FRONT), `desk ${desk}`).toBe(true);
    expect(left.start).toBeCloseTo(T + 1.05, 9);
    expect(left.end).toBeCloseTo(left.start, 9);
    const hers = (st: HotelState, b: FatigueBreak | undefined) => ({ ...st, staffRoster: st.staffRoster!.map(m => (m.id === 'H' ? { ...m, fatigueBreak: b } : m)) });
    const then = hers(s1, left);
    const s2 = hers(settleChanges(then, demolishRoom(then, roomAt(then, 2, 2).id)!, T + 0.46), undefined);
    expect(saveGame(s2, new PRNG(5))).toBe(true);
    const saved = loadGame()!.state;
    // the plan as saved: by the shortcut to the desk front, there at 12:37.8, waiting there to 13:03, then the rest with no
    // time in it; the break carried at its end; the turnover not done this hour
    const legs = itinerary(saved).legs, last = legs.at(-1)!, wait = legs.at(-2)!, walk = legs.at(-3)!;
    expect(walk.kind === 'walk' && sameTile(walk.path.at(-1), DESK_FRONT), `desk ${desk}`).toBe(true);
    expect(walk.end).toBeCloseTo(T + 0.63, 9);
    expect(wait).toMatchObject({ kind: 'stay', activity: 'wait', at: DESK_FRONT });
    expect(wait.start).toBeCloseTo(T + 0.63, 9);
    expect(wait.end).toBeCloseTo(left.start, 9);
    expect(last).toMatchObject({ kind: 'stay', activity: 'rest', at: DESK_FRONT, restRate: STAFF_FATIGUE.fallbackRecovery });
    expect(last.start).toBeCloseTo(left.start, 9);
    expect(last.end).toBeCloseTo(left.start, 9);
    expect(itinerary(saved).end.fatigueBreak).toMatchObject({ at: DESK_FRONT, start: left.start, end: left.end });
    expect(saved.staffRoster!.find(m => m.id === 'H')!.fatigueBreak).toBeUndefined();
    expect(turnover(saved, T)).toBeUndefined();
    return { T, saved };
  }

  /** From the saved game, a room built far off at t (it brings nobody anything): through Settle, and one re-plan. */
  function edited(saved: HotelState, t: number): [string, HotelState][] {
    const built = addRoom(saved, 'standard', 7, 5, 0, 'up')!;
    return [['Settle', settleChanges(saved, built, t)], ['one re-plan', replanStaff(built, t, saved)]];
  }

  /** Back at work from t: the turnover done this hour, no waiting at the desk front, no break held; next hour no wait there first. */
  function backToWork(after: HotelState, t: number, tag: string) {
    const T = hourStart(after);
    expect(waitsAtDeskFront(after, t), tag).toEqual([]);
    const clean = turnover(after, t);
    expect(clean, tag).toBeDefined();
    expect(doing(after, (clean!.start + clean!.end) / 2), tag).toBe('clean');
    expect(itinerary(after).end.fatigueBreak, tag).toBeUndefined();
    const next = tickSimulation(after, new PRNG(9)).state;
    expect(hourStart(next), tag).toBe(T + 1);
    expect(waitsAtDeskFront(next, T + 1), `${tag}, next hour`).toEqual([]);
  }

  describe('A game saved with a housekeeper waiting at the desk front for a break with no time left in it (mutation check)', () => {
    it('a paused edit while she waits there (12:45, a room built far off): she turns over the room at its door this hour, not waiting on to 13:03', () => {
      for (const desk of [true, false]) {
        const { T, saved } = oldSave(desk);
        const t = T + 0.75;
        expect(doing(saved, t), `desk ${desk}`).toBe('wait');
        for (const [label, after] of edited(saved, t)) backToWork(after, t, `desk ${desk}, ${label}`);
      }
    });

    it('a paused edit on her way there by the shortcut (12:33, a room built far off): the same, the turnover done this hour', () => {
      for (const desk of [true, false]) {
        const { T, saved } = oldSave(desk);
        const t = T + 0.55;
        expect(doing(saved, t), `desk ${desk}`).toBe('walk');
        for (const [label, after] of edited(saved, t)) backToWork(after, t, `desk ${desk}, ${label}`);
      }
    });
  });
}

// A clerk left with a compulsory break with no time in it (her break room demolished near its end, her own desk front reached only after that end) is neither walked to it nor kept waiting at the desk front for it: once a shortcut gets her there before the hour's end, she's at the counter from when she arrives.
{
  // A clerk left with a compulsory break with no time in it isn't kept off the counter for it: not walked to it, nor kept
  // waiting at her own desk front for it, lane closed, once a shortcut gets her there before the hour's end.
  const DESK_FRONT = { gridX: 1, gridY: 4, floor: 0 };
  const AT_HER_DESK = '1.000,4.000 desk';

  /**
   * 15:00 on day 2, a break room at (5, 0) and a named front desk with one late clerk. Rows 2 and 3 are built over but for
   * (5, 3) (and the desk's (1, 3)), so the way between the break room and the desk front (1, 4) goes round by x = 9
   * (16 tiles, 0.48 h) until the room at (5, 2) is demolished (7 tiles). `given`: she's in the break room at `fatigue` with
   * her break fixed 15:03 to 15:33 (a saved plan's); otherwise she stands at `at`, no break yet. (A clerk works only at a
   * named desk, so Settle always re-plans twice for a build or demolish here; one re-plan of each edit is as with the desk off.)
   */
  function hotel(fatigue: number, at: TilePos, given: boolean): HotelState {
    const hour = 15;
    let s: HotelState = { ...createStarterHotel(), day: 2, hour, cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = addFixture(s, 'breakroom', 5, 0, 0)!;
    for (let x = 0; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up') ?? s;
    for (let x = 0; x <= 8; x++) if (x !== 5 && x !== 1) s = addRoom(s, 'standard', x, 3, 0, 'down') ?? s;
    const lane = physicalDeskLanes(s)[0];
    const T = 24 + hour;
    const room = s.fixtures.find(f => f.type === 'breakroom')!;
    const clerk = { id: 'clerk', serial: 9, name: 'Clerk', role: 'front_desk', shift: 'late', at, deskLane: lane.key, dailyWage: 40,
      ...(given ? { fatigueBreak: { at: { gridX: 5, gridY: 0, floor: 0 }, placeId: room.id, start: T + 0.05, end: T + 0.55 } } : {}),
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite' },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T } } as StaffMember;
    s = { ...s, guests: [], frontDeskRosterReady: true, staffRoster: [clerk], staffPlan: null, staff: { frontDesk: 1, housekeepers: 0, maintenanceWorkers: 0 } };
    return { ...s, staffPlan: getStaffPlan(s) };
  }

  const itinerary = (s: HotelState) => getStaffPlan(s).itineraries.find(it => it.staffId === 'clerk')!;
  const fixedBreak = (s: HotelState) => itinerary(s).end.fatigueBreak;
  const isRest = (l: Leg): l is StayLeg => l.kind === 'stay' && l.activity === 'rest';
  const roomAt = (s: HotelState, x: number, y: number) => s.rooms.find(r => r.gridX === x && r.gridY === y)!;
  /** Where she is at x and doing what. */
  const where = (s: HotelState, x: number) => {
    const p = positionAt(itinerary(s).legs, x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)} ${p.leg.kind === 'stay' ? p.leg.activity : 'walk'}`;
  };
  /** Whether two plans put her in the same place doing the same thing from t to the hour's end (sampled every 0.005 h): true, or where they first differ. */
  const samePlan = (a: HotelState, b: HotelState, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, x) !== where(b, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, x)} vs ${where(b, x)}`;
    return true;
  };
  /** Who's at the counter at x. */
  const counter = (s: HotelState, x: number) => deskCoverage(s, x).map(d => d.staffId);
  /** Any wait at her desk front after t (for a break there). */
  const waitsAtDeskFront = (s: HotelState, t: number) => itinerary(s).legs.filter(l => l.kind === 'stay' && l.activity === 'wait' && sameTile(l.at, DESK_FRONT) && l.end > t + 1e-9);
  /** The same plan with no break carried at its end: what she'd do with no break left at all. */
  const noBreak = (s: HotelState): HotelState => ({ ...s, staffPlan: { ...getStaffPlan(s), itineraries: getStaffPlan(s).itineraries.map(it => ({ ...it, end: { ...it.end, fatigueBreak: undefined } })) } });

  /**
   * From `s`: the break room demolished at d, the room at (5, 2) at k (the shortcut), a room built far off at (7, 5) at n
   * (it brings nobody anything). `settle`: each through Settle (a named desk: two re-plans for a build or demolish), else
   * one re-plan each.
   */
  function edits(s: HotelState, d: number, k: number, n: number, settle: boolean) {
    const T = hourStart(s), t1 = T + d, t2 = T + k, t3 = T + n;
    const edit = (from: HotelState, to: HotelState, t: number) => (settle ? settleChanges(from, to, t) : replanStaff(to, t, from));
    const gone = demolishFixture(s, s.fixtures.find(f => f.type === 'breakroom')!.id)!;
    const s1 = edit(s, gone, t1);
    const cut = demolishRoom(s1, roomAt(s1, 5, 2).id)!;
    const s2 = edit(s1, cut, t2);
    const fresh = replanStaff(noBreak(cut), t2, s1);
    const s3 = edit(s2, addRoom(s2, 'standard', 7, 5, 0, 'up')!, t3);
    return { T, t1, t2, t3, s1, s2, s3, fresh };
  }

  /** At her desk from when she gets there by the shortcut, through the later edit and into the next hour; no break with nothing in it held. */
  function backAtTheCounter(s: HotelState, d: number, k: number, n: number) {
    for (const settle of [true, false]) {
      const label = settle ? "Settle's two re-plans" : 'one re-plan';
      const { T, t1, t2, t3, s1, s2, s3, fresh } = edits(s, d, k, n, settle);
      // The demolition: the long way to her desk front, there only after the break's fixed end
      const toDesk = itinerary(s1).legs.filter(l => l.kind === 'walk' && l.end > t1 + 1e-9).at(-1)!;
      expect(sameTile(toDesk.kind === 'walk' ? toDesk.path.at(-1) : null, DESK_FRONT), label).toBe(true);
      expect(toDesk.end, label).toBeGreaterThan(T + 1);
      if (settle) {
        // (Settle's second re-plan finds her on her way to a break with no time in it: none to go to)
        expect(fixedBreak(s1), label).toBeUndefined();
      } else {
        // (one re-plan leaves her the break there, starting and ending when she'd get there)
        const left = fixedBreak(s1)!;
        expect(sameTile(left.at, DESK_FRONT), label).toBe(true);
        expect(left.start, label).toBeCloseTo(toDesk.end, 9);
        expect(left.end, label).toBeCloseTo(left.start, 9);
      }
      // The shortcut: at her desk front well before the hour's end, rested
      const arrive = itinerary(s2).legs.filter(l => l.kind === 'walk' && l.end > t2 + 1e-9).at(-1)!;
      expect(sameTile(arrive.kind === 'walk' ? arrive.path.at(-1) : null, DESK_FRONT), label).toBe(true);
      expect(arrive.end, label).toBeLessThan(T + 0.95);
      expect(fatigueAt(s2, s2.staffRoster![0], arrive.end), label).toBeLessThan(STAFF_FATIGUE.breakAt);
      // ... and at the desk from then to the hour's end, the lane hers: no waiting at the desk front, no break held
      for (const x of [arrive.end + 0.005, (arrive.end + T + 1) / 2, T + 0.999]) {
        expect(where(s2, x), `${label}, ${(x - T).toFixed(3)}`).toBe(AT_HER_DESK);
        expect(counter(s2, x), `${label}, ${(x - T).toFixed(3)}`).toEqual(['clerk']);
      }
      expect(waitsAtDeskFront(s2, t2), label).toEqual([]);
      expect(fixedBreak(s2), label).toBeUndefined();
      // (as a plan with no break left at all would have her)
      expect(samePlan(s2, fresh, t2), label).toBe(true);
      // The later edit brings her nothing: her plan as it was, at the desk to the hour's end
      expect(samePlan(s3, s2, t3), label).toBe(true);
      for (const x of [t3 + 0.005, T + 0.999]) {
        expect(where(s3, x), `${label}, later edit, ${(x - T).toFixed(3)}`).toBe(AT_HER_DESK);
        expect(counter(s3, x), `${label}, later edit, ${(x - T).toFixed(3)}`).toEqual(['clerk']);
      }
      expect(waitsAtDeskFront(s3, t3), label).toEqual([]);
      expect(fixedBreak(s3), label).toBeUndefined();
      // Next hour: at the desk from its start, no waiting at the desk front first
      const next = tickSimulation(s3, new PRNG(9)).state;
      const N = hourStart(next);
      expect(where(next, N + 0.001), `${label}, next hour`).toBe(AT_HER_DESK);
      expect(counter(next, N + 0.003), `${label}, next hour`).toEqual(['clerk']);
      expect(waitsAtDeskFront(next, N), `${label}, next hour`).toEqual([]);
    }
  }

  describe('A clerk left with a compulsory break with no time in it, her break room demolished near its end', () => {
    it('her break fixed 15:03 to 15:33, the break room demolished at 15:31.8, the shortcut at 15:33, a room built far off at 15:55.2: at the desk from 15:49.8', () => {
      const s = hotel(86, { gridX: 5, gridY: 0, floor: 0 }, true);
      const T = hourStart(s);
      expect(namedFrontDesk(s)).toBe(true);
      // the scene: in the break room, the break 15:03 to 15:33, then the long way round to her desk
      expect(itinerary(s).legs.filter(isRest)).toMatchObject([{ start: T + 0.05, end: T + 0.55 }]);
      // 15:31.8: she'd be at the desk front at 16:00.6 the long way; 15:33: by the shortcut there at 15:49.8
      backAtTheCounter(s, 0.53, 0.55, 0.92);
    });

    it('a break her plans gave her: at 82 at her desk at 15:00, the long way to the break room, the break 16:05 to 16:35; demolished at 16:33.6, the shortcut at 16:36, a room built far off at 16:57', () => {
      const s0 = hotel(82, DESK_FRONT, false);
      const s = tickSimulation(s0, new PRNG(9)).state;
      expect(s.hour).toBe(16);
      const T = hourStart(s);
      // the break, 16:04.8 to 16:34.8, in the break room
      const [brk] = itinerary(s).legs.filter(isRest);
      expect(brk.start).toBeCloseTo(T + 0.08, 9);
      expect(brk.end).toBeCloseTo(T + 0.58, 9);
      expect(brk.placeId).toBe(s.fixtures.find(f => f.type === 'breakroom')!.id);
      expect(brk.idle).toBeUndefined(); // a break, not spare time
      // 1.2 minutes before the break's end: she'd be at the desk front at 17:02.4 the long way; 1.2 minutes after it the
      // shortcut: there at 16:55.2
      backAtTheCounter(s, brk.end - T - 0.02, brk.end - T + 0.02, 0.95);
    });

    it('a game saved with her already waiting at her desk front for such a break, to the hour\'s end (as an older save can have it): a paused edit puts her at the desk', () => {
      const s = hotel(86, { gridX: 5, gridY: 0, floor: 0 }, true);
      const { T, t2, s2 } = edits(s, 0.53, 0.55, 0.92, true);
      // the plan as saved: there by the shortcut at 15:49.8, waiting at the desk front to 16:00 for a break 16:00.6 to 16:00.6
      const arrive = itinerary(s2).legs.filter(l => l.kind === 'walk' && l.end > t2 + 1e-9).at(-1)!.end;
      const plan = getStaffPlan(s2);
      const saved: HotelState = { ...s2, staffPlan: { ...plan, itineraries: plan.itineraries.map(it => (it.staffId !== 'clerk' ? it : { ...it,
        legs: it.legs.map(l => (l.kind === 'stay' && l.activity === 'desk' && l.start >= arrive - 1e-9 ? makeStay(l.at, l.start, l.end, 'wait') : l)),
        end: { ...it.end, deskLane: undefined, fatigueBreak: { at: DESK_FRONT, start: T + 1.01, end: T + 1.01 } } })) } };
      expect(where(saved, T + 0.9)).toBe('1.000,4.000 wait');
      expect(counter(saved, T + 0.9)).toEqual([]);
      // 15:55.2, a room built far off (Settle's two re-plans, or one): at the desk from then to the hour's end, no break held
      const t3 = T + 0.92;
      const built = addRoom(saved, 'standard', 7, 5, 0, 'up')!;
      for (const [label, later] of [["Settle's two re-plans", settleChanges(saved, built, t3)], ['one re-plan', replanStaff(built, t3, saved)]] as [string, HotelState][]) {
        for (const x of [t3 + 0.005, T + 0.999]) {
          expect(where(later, x), `${label}, ${(x - T).toFixed(3)}`).toBe(AT_HER_DESK);
          expect(counter(later, x), `${label}, ${(x - T).toFixed(3)}`).toEqual(['clerk']);
        }
        expect(waitsAtDeskFront(later, t3), label).toEqual([]);
        expect(fixedBreak(later), label).toBeUndefined();
      }
    });
  });
}
