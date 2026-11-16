// Reception-trained housekeepers resting in spare time through a paused edit (StaffManager.replanStaff / planHour's
// spare-time counter offer). New counter work interrupts the rest (design: "Ordinary idle recovery can be interrupted by
// new work"): a lane is new if the front desk before the edit wouldn't have had it for her at that moment, from where she
// is, with her energy now. An edit that brings nobody anything new leaves her resting. See also idleRestReplan.test.ts.
import { describe, it, expect } from 'vitest';
import { addRoom, createStarterHotel, addFixture, demolishFixture, demolishRoom, addElevator, buildFloor, demolishElevator } from '../src/simulation/HotelState.js';
import { getStaffPlan, replanStaff, rosterAfter } from '../src/simulation/StaffManager.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { dismissStaff, hireCandidate, hiringCandidates } from '../src/simulation/StaffHiring.js';
import { physicalDeskLanes, deskCoverage, scheduledDeskLanes } from '../src/simulation/FrontDesk.js';
import { hourStart, positionAt, makeWalk, makeStay } from '../src/simulation/Movement.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { routeToStreet, routeFromStreet } from '../src/simulation/Layout.js';
import { TRAVEL } from '../src/config/balance.js';
import type { HotelState, Leg, StaffMember, StayLeg, TilePos, Room, Guest, Walker, SpotlightPlan } from '../src/simulation/types.js';

// A lane the hour's plan already had freeing mid-hour isn't new work; a lane a let-go opens is.
{
  /** A reception-trained housekeeper at `at`, `fatigue` as of the hour's start `T`. */
  function hk(id: string, at: TilePos, fatigue: number, T: number, extra: Partial<StaffMember> = {}): StaffMember {
    return { id, name: id, serial: id.length + 10, role: 'housekeeper', dailyWage: 80.5, at,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', receptionTrained: true },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T }, ...extra } as StaffMember;
  }

  /**
   * 15:00 on day 2, a named front desk with no clerks, one desk with two lanes (both served from (1, 4)), the hour planned:
   * c0 (81) covers lane 0 till 15:30, c1 (15) lane 1 till 16:30, and spare (50) has nothing to do.
   */
  function scene() {
    const base = addRoom({ ...createStarterHotel(), day: 2, hour: 15, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
    const T = hourStart(base);
    const lanes = physicalDeskLanes(base);
    const crew = [
      hk('c0', lanes[0].front, 81, T, { receptionSupport: { lane: lanes[0].key, from: T - 0.5, to: T + 0.5 } }),
      hk('c1', lanes[1].front, 15, T, { receptionSupport: { lane: lanes[1].key, from: T - 0.5, to: T + 1.5 } }),
      hk('spare', { gridX: 6, gridY: 1, floor: 0 }, 50, T),
    ];
    const s: HotelState = { ...base, frontDeskRosterReady: true, staffRoster: crew, staffPlan: null, guests: [],
      staff: { ...base.staff, frontDesk: 0, housekeepers: 3, maintenanceWorkers: 0 } };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, lanes };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)!.legs;
  const lastRest = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest').at(-1);
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Who is serving at the counter at x. */
  const atCounter = (s: HotelState, x: number) => deskCoverage(s, x).map(d => d.staffId).sort();
  /** Times from just after t to the hour's end. */
  const after = (t: number, T: number) => [t + 0.01, t + 0.05, (t + T + 1) / 2, T + 0.99];

  /** Edits at t that bring nobody anything new: a pause and re-plan, a room built far away (new and clean), a maintenance hire. */
  function nothingNew(s: HotelState, t: number): Array<[string, HotelState]> {
    const built = addRoom(s, 'standard', 7, 5, 0, 'up') ?? addRoom(s, 'standard', 9, 5, 0, 'up');
    const offer = hiringCandidates(s, 'maintenance')[0];
    const hired = hireCandidate(s, 'maintenance', offer.id, undefined, t);
    expect(built).toBeTruthy();
    expect(hired).toBeTruthy();
    return [['paused re-plan', replanStaff(s, t)], ['far room built', settleChanges(s, built!, t)], ['maintenance hire', settleChanges(s, hired!, t)]];
  }

  describe('Resting in spare time at the counter: a lane freeing mid-hour is not new work at a paused edit', () => {
    it('a lane the hour\'s plan already had freeing at 15:30: an edit at 15:33 that brings nothing leaves her resting till 16:00, not off to the counter, and so does a second at 15:36', () => {
      // 15:00: spare walks to the counter by 15:14 and, both lanes taken then, rests there till 16:00; c0 comes off lane 0 at 15:30
      const { s, T } = scene();
      expect(lastRest(s, 'spare')).toMatchObject({ idle: true, end: T + 1 });
      expect(atCounter(s, T + 0.56)).toEqual(['c1']);
      for (const [what, first] of nothingNew(s, T + 0.55)) {
        for (const [then, re] of [['', first] as [string, HotelState], ...nothingNew(first, T + 0.6).map(([w, st]) => [` then ${w} at 15:36`, st] as [string, HotelState])]) {
          const t = then ? T + 0.6 : T + 0.55;
          for (const x of after(t, T)) {
            expect(where(re, 'spare', x), `${what}${then}: spare at +${(x - T).toFixed(2)}`).toBe(where(s, 'spare', x));
            expect(atCounter(re, x), `${what}${then}: counter at +${(x - T).toFixed(2)}`).toEqual(['c1']);
          }
          // still spare time: an edit that does bring work can still interrupt it
          expect(lastRest(re, 'spare'), `${what}${then}`).toMatchObject({ idle: true, end: T + 1 });
        }
      }
    });

    it('the colleague who came off that lane at 15:30 too tired for another block, rested enough by 15:36: an edit then, at 15:42 or at 15:51 leaves her resting, not back at the counter', () => {
      // c0 is at about 83.5 at 15:30 (no half-hour block before 85), so rests at the counter till 16:00; by 15:36 she's at about 82.5
      const { s, T } = scene();
      expect(legsOf(s, 'c0')).toMatchObject([{ kind: 'stay', activity: 'desk', end: T + 0.5 }, { kind: 'stay', activity: 'rest', idle: true, end: T + 1 }]);
      for (const e of [0.6, 0.7, 0.85]) {
        for (const [what, re] of nothingNew(s, T + e)) {
          for (const x of after(T + e, T)) {
            expect(where(re, 'c0', x), `${what} at +${e}: c0 at +${(x - T).toFixed(2)}`).toBe(where(s, 'c0', x));
            expect(atCounter(re, x), `${what} at +${e}: counter at +${(x - T).toFixed(2)}`).toEqual(['c1']);
          }
          expect(lastRest(re, 'c0'), `${what} at +${e}`).toMatchObject({ idle: true, end: T + 1 });
        }
      }
    });

    it('control: a lane a let-go opens is new work: c1 let go at 15:33, the resting housekeeper takes over the counter at once, and the tired colleague rests on', () => {
      const { s, T } = scene();
      const t = T + 0.55;
      const re = settleChanges(s, dismissStaff(s, 'c1', t)!, t);
      // spare is already at the counter: she serves from 15:33 on, past the hour
      const desk = legsOf(re, 'spare').find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk' && l.end > t)!;
      expect(desk).toBeDefined();
      expect(desk.start).toBeCloseTo(t, 6);
      expect(desk.end).toBeGreaterThan(T + 1);
      for (const x of after(t + 0.04, T)) expect(atCounter(re, x), `counter at +${(x - T).toFixed(2)}`).toEqual(['spare']);
      for (const x of after(t, T)) expect(where(re, 'c0', x), `c0 at +${(x - T).toFixed(2)}`).toBe(where(s, 'c0', x));
    });
  });
}

// Turned down for the counter at the hour's start as too tired, she has rested since: still not new work. A seat a let-go opens is.
{
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
    mid: { experience: 'skilled', style: 'standard', workHours: 100 },
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;

  /** A reception-trained housekeeper standing at `at` (a room: in it), `fatigue` as of the hour's start. */
  function keeper(id: string, at: Room | TilePos, abs: number, o: { speed?: keyof typeof SPEEDS; fatigue?: number; stamina?: 'low' | 'normal' | 'high' } = {}): StaffMember {
    const p = SPEEDS[o.speed ?? 'mid'];
    const room = 'id' in at ? at as Room : undefined;
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: room ? roomTile(room) : at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: o.stamina ?? 'normal', specialty: 'turnover_runner', hospitality: 'polite', receptionTrained: true },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: o.fatigue ?? 0, fatigueAt: abs } } as StaffMember;
  }

  /**
   * The starter hotel on day 2 at `hour`, with a named front desk: a break room at (5, 0) if asked (its front at (5, 1)),
   * standard rooms on row 2 from x = 3, a late clerk on each of the desk's seats listed in `clerks`, the hour planned.
   */
  function hotel(o: { hour: number; breakRoom?: boolean; rooms: number; dirty?: Record<number, number>; clerks?: number[]; crew: (rooms: Room[], abs: number) => StaffMember[] }): HotelState {
    const day = 2, hour = o.hour;
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    if (o.breakRoom) s = addFixture(s, 'breakroom', 5, 0, 0)!;
    for (let i = 0; i < o.rooms; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
    const abs = (day - 1) * 24 + hour;
    const crew = o.crew(s.rooms, abs);
    const lanes = physicalDeskLanes(s);
    const clerks = (o.clerks ?? []).map(seat => ({
      id: `clerk${seat}`, serial: 100 + seat, name: `Clerk ${seat}`, role: 'front_desk', shift: 'late', at: lanes[seat].front, deskLane: lanes[seat].key, dailyWage: 40,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite' },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: abs },
    } as StaffMember));
    s = { ...s, day, hour, guests: [], noiseSources: [], staffPlan: null, frontDeskRosterReady: true,
      rooms: s.rooms.map((r, i) => (o.dirty?.[i] !== undefined ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: o.dirty[i] } : r)),
      staff: { ...s.staff, housekeepers: crew.length, maintenanceWorkers: 0, frontDesk: clerks.length }, staffRoster: [...crew, ...clerks] };
    return { ...s, staffPlan: getStaffPlan(s) };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)!.legs;
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const counterOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk');
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const committed = (s: HotelState, id: string) => rosterAfter(s, getStaffPlan(s)).find(m => m.id === id)!.stats!.fatigue!;
  const farRoom = (s: HotelState, t: number) => settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t);

  describe('A paused edit that brings nothing leaves a desk-trained housekeeper resting, not off to the counter', () => {
    it('too tired at 15:00 for a counter block, rested since: a room built far away at 15:24 leaves her resting in the break room till 16:00', () => {
      // 15:00, nothing to clean, at 83: a block at the counter would reach 85 before half an hour, so she rests in the
      // break room from 15:02 till 16:00 (recovered to about 75 by 15:24); the desk with no clerk, or one on its first seat
      for (const clerks of [[], [0]]) {
        const s = hotel({ hour: 15, breakRoom: true, rooms: 1, clerks, crew: (r, abs) => [keeper('keeper', { gridX: 5, gridY: 1, floor: 0 }, abs, { fatigue: 83 })] });
        const T = hourStart(s), t = T + 0.4;
        expect(counterOf(s, 'keeper')).toEqual([]);
        expect(restsOf(s, 'keeper')).toMatchObject([{ idle: true, placeId: expect.any(String), end: T + 1 }]);
        for (const re of [farRoom(s, t), replanStaff(s, t)]) {
          for (const x of [0.41, 0.5, 0.64, 0.8, 0.99]) expect(where(re, 'keeper', T + x)).toBe(where(s, 'keeper', T + x));
          expect(counterOf(re, 'keeper')).toEqual([]);
          expect(committed(re, 'keeper')).toBeCloseTo(committed(s, 'keeper'), 9);
          // still spare time: an edit that does bring work can still interrupt it
          expect(restsOf(re, 'keeper').at(-1)).toMatchObject({ idle: true, end: T + 1 });
        }
      }
    });

    it('her counter block cut short at 15:44 by a colleague due on her seat, the other seat free all hour: a paused edit at 15:45 leaves her resting till 16:00, not off to the other seat', () => {
      // 15:00, no clerks. A cleans two rooms and comes to the counter's first seat at 15:44 for an hour. B, with nothing to
      // clean, is at that seat from 15:13 till A gets there, then rests at the counter front till 16:00 (one block an hour)
      const s = hotel({ hour: 15, rooms: 3, dirty: { 0: 0.1, 2: 0.26 }, crew: (r, abs) => [
        keeper('A', r[1], abs, { speed: 'fast', stamina: 'high', fatigue: 73 }), keeper('B', r[1], abs, { speed: 'slow', fatigue: 47 })] });
      const T = hourStart(s), t = T + 0.75;
      const lanes = physicalDeskLanes(s).map(l => l.key);
      const [block] = counterOf(s, 'B');
      expect(counterOf(s, 'B')).toHaveLength(1);
      expect(block).toMatchObject({ lane: lanes[0] });
      expect(counterOf(s, 'A')).toMatchObject([{ lane: lanes[0] }]);
      expect(counterOf(s, 'A')[0].start).toBeCloseTo(block.end, 9);
      expect(block.end).toBeLessThan(t);
      const rest = restsOf(s, 'B').at(-1)!;
      expect(rest).toMatchObject({ idle: true, end: T + 1 });
      expect(rest.start).toBeCloseTo(block.end, 9);
      for (const re of [replanStaff(s, t), farRoom(s, t)]) {
        for (const x of [0.751, 0.8, 0.9, 0.99]) {
          expect(where(re, 'B', T + x)).toBe(where(s, 'B', T + x));
          expect(where(re, 'A', T + x)).toBe(where(s, 'A', T + x));
        }
        expect(counterOf(re, 'B').filter(l => l.end > t)).toEqual([]);
        expect(committed(re, 'B')).toBeCloseTo(committed(s, 'B'), 9);
      }
    });

    it('control: both seats taken when she sat down, a clerk let go at 15:24 opens one, and she goes to cover it', () => {
      // 15:00, a clerk on each seat; at 60 with nothing to clean she rests in the break room from 15:02 till 16:00.
      // Letting the second seat's clerk go at 15:24 is new work: she is at that seat by about 15:39, on past 16:00
      const s = hotel({ hour: 15, breakRoom: true, rooms: 1, clerks: [0, 1], crew: (r, abs) => [keeper('keeper', { gridX: 5, gridY: 1, floor: 0 }, abs, { fatigue: 60 })] });
      const T = hourStart(s), t = T + 0.4;
      const lanes = physicalDeskLanes(s).map(l => l.key);
      expect(counterOf(s, 'keeper')).toEqual([]);
      expect(restsOf(s, 'keeper')).toMatchObject([{ idle: true, placeId: expect.any(String), end: T + 1 }]);
      const re = settleChanges(s, dismissStaff(s, 'clerk1', t)!, t);
      const [desk] = counterOf(re, 'keeper');
      expect(desk).toMatchObject({ lane: lanes[1] });
      expect(desk.start).toBeLessThan(T + 0.7);
      expect(desk.end).toBeGreaterThan(T + 1);
    });
  });
}

// A lane a let-go opens is new work even if someone else held it when her rest began, and so is a lane of a desk rebuilt mid-hour.
{
  /** A reception-trained housekeeper at `at`, `fatigue` as of the hour's start `T`. */
  function hk(id: string, at: TilePos, fatigue: number, T: number, extra: Partial<StaffMember> = {}): StaffMember {
    return { id, name: id, serial: id.length + 10, role: 'housekeeper', dailyWage: 80.5, at,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', receptionTrained: true },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T }, ...extra } as StaffMember;
  }

  /**
   * 15:00 on day 2, a named front desk with no clerks, one desk with two lanes (both served from (1, 4)), the hour planned:
   * c0 (82) covers lane 0 till 15:30 and is then too tired for another block; c1 (10) covers lane 1 till 16:30; if `c2`,
   * c2 cleans the room at (5, 2) till 15:18 and walks over to take lane 0 from about 15:32. `idle` (30) has nothing to do:
   * standing at the counter (`near`) or walking in from (8, 1), she finds both lanes taken and rests there till 16:00.
   */
  function scene(o: { c2: boolean; idleAt: 'near' | 'far' }) {
    const base = addRoom({ ...createStarterHotel(), day: 2, hour: 15, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
    const T = hourStart(base);
    const lanes = physicalDeskLanes(base);
    const room = base.rooms[0];
    const crew = [
      hk('c0', lanes[0].front, 82, T, { receptionSupport: { lane: lanes[0].key, from: T - 0.5, to: T + 0.5 } }),
      hk('c1', lanes[1].front, 10, T, { receptionSupport: { lane: lanes[1].key, from: T - 0.5, to: T + 1.5 } }),
      ...(o.c2 ? [hk('c2', roomTile(room), 20, T)] : []),
      hk('idle', o.idleAt === 'near' ? lanes[0].front : { gridX: 8, gridY: 1, floor: 0 }, 30, T),
    ];
    const s: HotelState = { ...base, frontDeskRosterReady: true, staffRoster: crew, staffPlan: null, guests: [],
      rooms: base.rooms.map(r => (o.c2 ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.3, cleaningHoursTotal: 0.3 } : r)),
      staff: { ...base.staff, frontDesk: 0, housekeepers: crew.length, maintenanceWorkers: 0 } };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, lanes };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const lastRest = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest').at(-1);
  const counterFrom = (s: HotelState, id: string, t: number) => legsOf(s, id).find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk' && l.end > t);
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Who is serving at the counter at x. */
  const atCounter = (s: HotelState, x: number) => deskCoverage(s, x).map(d => d.staffId).sort();
  /** Times from just after t to the hour's end. */
  const after = (t: number, T: number) => [t + 0.01, t + 0.05, (t + T + 1) / 2, T + 0.99];
  /** A room built far from everyone: new and clean, so it brings nobody anything. */
  const farRoom = (s: HotelState) => addRoom(s, 'standard', 7, 5, 0, 'up')!;

  describe('Resting in spare time at the counter: a lane a let-go or a rebuilt desk opens is new work', () => {
    it('c2, due on lane 0 from 15:32, let go at 15:36, 15:42 or 15:48: the housekeeper resting at the counter since before then serves lane 0 at once, and both lanes are covered to the hour\'s end', () => {
      for (const idleAt of ['near', 'far'] as const) {
        // 15:00: idle rests at the counter from 15:00 (near) or 15:18 (far) till 16:00; c0 off lane 0 at 15:30, c2 on it from 15:32
        const { s, T } = scene({ c2: true, idleAt });
        expect(lastRest(s, 'idle'), idleAt).toMatchObject({ idle: true, end: T + 1 });
        expect(counterFrom(s, 'c2', T)!.start, idleAt).toBeLessThan(T + 0.6);
        expect(atCounter(s, T + 0.59), idleAt).toEqual(['c1', 'c2']);
        for (const e of [0.6, 0.7, 0.8]) {
          const t = T + e;
          // the let-go alone, and after an edit at 15:33 that brought nothing (so her rest was already split there once)
          for (const [what, from] of [['', s], [' after a far room built at 15:33', settleChanges(s, farRoom(s), T + 0.55)]] as const) {
            const re = settleChanges(from, dismissStaff(from, 'c2', t)!, t);
            for (const x of after(t, T)) expect(atCounter(re, x), `${idleAt}${what}, let go at +${e}: counter at +${(x - T).toFixed(2)}`).toEqual(['c1', 'idle']);
            expect(counterFrom(re, 'idle', t)?.start, `${idleAt}${what}, let go at +${e}: idle at the counter at once`).toBeCloseTo(t, 6);
          }
        }
      }
    });

    it('the desk demolished at 15:18 and rebuilt at 15:21 on the same tile (the same lanes) or one tile down: both lanes are covered again, the resting housekeeper on one of them', () => {
      for (const tile of ['same', 'other'] as const) {
        // 15:00: idle rests at the counter till 16:00; 15:18 the desk goes, c0 and c1 step out to rest; 15:21 it is back
        const { s, T, lanes } = scene({ c2: false, idleAt: 'near' });
        const desk = lanes[0].desk;
        const gone = settleChanges(s, demolishFixture(s, desk.id)!, T + 0.3);
        expect(atCounter(gone, T + 0.32), tile).toEqual([]);
        const built = addFixture(gone, 'desk', desk.gridX, desk.gridY + (tile === 'same' ? 0 : 2), 0);
        expect(built, tile).toBeTruthy();
        const back = settleChanges(gone, built!, T + 0.35);
        expect(physicalDeskLanes(back).map(l => l.key).includes(lanes[1].key), tile).toBe(tile === 'same');
        for (const x of [T + 0.4, T + 0.6, T + 0.9]) {
          const serving = atCounter(back, x);
          expect(serving, `${tile}: counter at +${(x - T).toFixed(2)}`).toHaveLength(2);
          expect(serving, `${tile}: counter at +${(x - T).toFixed(2)}`).toContain('idle');
        }
        expect(counterFrom(back, 'idle', T + 0.35)?.start, `${tile}: idle at the counter at once`).toBeCloseTo(T + 0.35, 6);
      }
    });

    it('control: an edit at 15:36 that brings nobody anything new (a far room built) leaves her resting at the counter till 16:00, and lane 0 to c2', () => {
      for (const idleAt of ['near', 'far'] as const) {
        const { s, T } = scene({ c2: true, idleAt });
        const t = T + 0.6;
        const re = settleChanges(s, farRoom(s), t);
        for (const x of after(t, T)) {
          expect(where(re, 'idle', x), `${idleAt}: idle at +${(x - T).toFixed(2)}`).toBe(where(s, 'idle', x));
          expect(atCounter(re, x), `${idleAt}: counter at +${(x - T).toFixed(2)}`).toEqual(['c1', 'c2']);
        }
        expect(lastRest(re, 'idle'), idleAt).toMatchObject({ idle: true, end: T + 1 });
      }
    });
  });
}

// Walked to the break room to rest: a lane the hour's plan already had freeing isn't new work, though from there she'd now get to it after it frees.
{
  /** A reception-trained housekeeper at `at`, `fatigue` as of the hour's start `T`. */
  function hk(id: string, at: TilePos, fatigue: number, T: number, extra: Partial<StaffMember> = {}): StaffMember {
    return { id, name: id, serial: id.length + 20, role: 'housekeeper', dailyWage: 80.5, at,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', receptionTrained: true },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T }, ...extra } as StaffMember;
  }

  /**
   * 15:00 on day 2, a named front desk with no clerks, one desk with two lanes (both served from (1, 4)), a break room at
   * (5, 0), a standard room at (3, 2), the hour planned: c0 (82) covers lane 0 till 15:00 + `c0Off` hours, c1 (10) lane 1
   * till 16:30. `from`: where the third, maid (reception-trained, at 30), becomes free -- 'room': she is cleaning (3, 2)
   * till 15:15; 'counter': she starts the hour at the desk front with nothing to do.
   */
  function scene(from: 'room' | 'counter', c0Off: number) {
    let base = addFixture({ ...createStarterHotel(), day: 2, hour: 15, cash: 1_000_000 }, 'breakroom', 5, 0, 0)!;
    base = addRoom(base, 'standard', 3, 2, 0, 'up')!;
    const T = hourStart(base);
    const lanes = physicalDeskLanes(base);
    const room = base.rooms[0];
    const crew = [
      hk('c0', lanes[0].front, 82, T, { receptionSupport: { lane: lanes[0].key, from: T - 0.5, to: T + c0Off } }),
      hk('c1', lanes[1].front, 10, T, { receptionSupport: { lane: lanes[1].key, from: T - 0.5, to: T + 1.5 } }),
      from === 'room' ? hk('maid', roomTile(room), 30, T, { roomId: room.id }) : hk('maid', lanes[0].front, 30, T),
    ];
    const s: HotelState = { ...base, frontDeskRosterReady: true, staffRoster: crew, staffPlan: null, guests: [],
      rooms: base.rooms.map(r => (from === 'room' && r.id === room.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.25, cleaningHoursTotal: 0.25 } : r)),
      staff: { ...base.staff, frontDesk: 0, housekeepers: 3, maintenanceWorkers: 0 } };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)!.legs;
  const lastRest = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest').at(-1);
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Who is serving at the counter at x. */
  const atCounter = (s: HotelState, x: number) => deskCoverage(s, x).map(d => d.staffId).sort();
  /** Her fatigue as the hour ends, as the tick will commit it. */
  const fatigueAtHourEnd = (s: HotelState, id: string) => rosterAfter(s, getStaffPlan(s)).find(m => m.id === id)!.stats!.fatigue ?? 0;
  /** Times from just after t to the hour's end. */
  const after = (t: number, T: number) => [t + 0.01, t + 0.05, (t + T + 1) / 2, T + 0.99];
  const clock = (x: number, T: number) => `15:${String(Math.round((x - T) * 60)).padStart(2, '0')}`;

  /** Edits at t that bring nobody anything new: a pause and re-plan, a room built far away (new and clean). */
  function nothingNew(s: HotelState, t: number): Array<[string, HotelState]> {
    const built = addRoom(s, 'standard', 7, 5, 0, 'up') ?? addRoom(s, 'standard', 9, 5, 0, 'up');
    expect(built).toBeTruthy();
    return [['paused re-plan', replanStaff(s, t)], ['far room built', settleChanges(s, built!, t)]];
  }

  /** Every edit (and a second one 6 minutes on) leaves maid resting in the break room as unedited, the counter as unedited. */
  function expectUnchanged(s: HotelState, T: number, edits: number[]) {
    for (const e of edits) {
      for (const [what, first] of nothingNew(s, T + e)) {
        const chain: Array<[string, HotelState, number]> = [[`${what} at ${clock(T + e, T)}`, first, T + e],
          ...nothingNew(first, T + e + 0.1).map(([w, st]) => [`${what} at ${clock(T + e, T)} then ${w} at ${clock(T + e + 0.1, T)}`, st, T + e + 0.1] as [string, HotelState, number])];
        for (const [label, re, t] of chain) {
          if (t >= T + 1) continue;
          for (const x of after(t, T)) {
            expect(where(re, 'maid', x), `${label}: maid at ${clock(x, T)}`).toBe(where(s, 'maid', x));
            expect(atCounter(re, x), `${label}: counter at ${clock(x, T)}`).toEqual(atCounter(s, x));
          }
          expect(fatigueAtHourEnd(re, 'maid'), `${label}: maid's fatigue at 16:00`).toBeCloseTo(fatigueAtHourEnd(s, 'maid'), 6);
          // still spare time: an edit that does bring work can still interrupt it
          expect(lastRest(re, 'maid'), label).toMatchObject({ idle: true, end: T + 1 });
        }
      }
    }
  }

  describe('Resting in spare time after a walk to the break room: a lane the hour\'s plan had freeing mid-hour is not new work at a paused edit', () => {
    it('she finishes a room at 15:15 with both lanes taken and walks to the break room: a no-op edit at 15:36, 15:42 or 15:48, after lane 0 freed at 15:30, leaves her resting there till 16:00, not off to the counter', () => {
      // 15:00: c0 on lane 0 till 15:30, c1 on lane 1 till 16:30; maid cleans (3, 2) till 15:15 (both lanes taken were she
      // to go then), walks to the break room by about 15:22 and rests there in spare time till 16:00
      const { s, T } = scene('room', 0.5);
      expect(lastRest(s, 'maid')).toMatchObject({ idle: true, end: T + 1, placeId: expect.stringContaining('breakroom') });
      expect(legsOf(s, 'maid').some(l => l.kind === 'stay' && l.activity === 'desk')).toBe(false);
      expect(atCounter(s, T + 0.95)).toEqual(['c1']);
      expectUnchanged(s, T, [0.6, 0.7, 0.8]);
    });

    it('she starts the hour at the desk front with both lanes taken and walks to the break room (resting from 15:14): lane 0 freeing at 15:18 or 15:24, a no-op edit from 15:27 to 15:45 leaves her resting there', () => {
      for (const c0Off of [0.3, 0.4]) {
        const { s, T } = scene('counter', c0Off);
        expect(lastRest(s, 'maid')).toMatchObject({ idle: true, end: T + 1, placeId: expect.stringContaining('breakroom') });
        expect(atCounter(s, T + 0.95)).toEqual(['c1']);
        expectUnchanged(s, T, [0.45, 0.55, 0.65, 0.75]);
      }
    });

    it('control: a lane a let-go opens is new work: c1 let go at 15:36, she leaves the break room for the counter at once and serves there through 16:00', () => {
      const { s, T } = scene('room', 0.5);
      const t = T + 0.6;
      const re = settleChanges(s, dismissStaff(s, 'c1', t)!, t);
      // up from her seat at 15:36, at the counter in about 14 minutes, serving past the hour
      expect(where(re, 'maid', t + 0.01)).toMatch(/ walk$/);
      const desk = legsOf(re, 'maid').find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk' && l.end > t)!;
      expect(desk).toBeDefined();
      expect(desk.start).toBeLessThan(T + 0.9);
      expect(desk.end).toBeGreaterThan(T + 1);
      expect(atCounter(re, T + 0.95)).toContain('maid');
    });
  });
}

// A clerk let go whose next stint at the desk lies past the hour's end (back from a break, or still at the desk when the helper would get there): her lane is new work.
{
  const profile = { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite' } as const;

  /** A reception-trained housekeeper at `at`, `fatigue` as of the hour's start `T`. */
  function hk(id: string, at: TilePos, fatigue: number, T: number, extra: Partial<StaffMember> = {}): StaffMember {
    return { id, name: id, serial: id.length + 30, role: 'housekeeper', dailyWage: 80.5, at, profile: { ...profile, receptionTrained: true },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T }, ...extra } as StaffMember;
  }

  /** A late-shift front desk clerk seated on `lane`, `fatigue` as of the hour's start `T`. */
  function clerk(id: string, at: TilePos, lane: string, fatigue: number, T: number): StaffMember {
    return { id, name: id, serial: 9, role: 'front_desk', shift: 'late', at, deskLane: lane, dailyWage: 40, profile,
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T } } as StaffMember;
  }

  /**
   * 15:00 on day 2, a named front desk, one desk with two lanes (both served from (1, 4)), the hour planned. K, a late-shift
   * clerk at `kFatigue`, holds lane 0; c1 (10), a reception-trained housekeeper, covers lane 1 till 16:30. `idle` (30) has
   * nothing to do and finds both lanes taken at 15:00: she rests at the counter till 16:00 or, with the break room at (5, 0),
   * walks there and rests from 15:14 till 16:00.
   */
  function scene(kFatigue: number, breakRoom: boolean) {
    let base: HotelState = { ...createStarterHotel(), day: 2, hour: 15, cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    if (breakRoom) base = addFixture(base, 'breakroom', 5, 0, 0)!;
    const T = hourStart(base);
    const lanes = physicalDeskLanes(base);
    const crew = [
      clerk('K', lanes[0].front, lanes[0].key, kFatigue, T),
      hk('c1', lanes[1].front, 10, T, { receptionSupport: { lane: lanes[1].key, from: T - 0.5, to: T + 1.5 } }),
      hk('idle', lanes[0].front, 30, T),
    ];
    const s: HotelState = { ...base, guests: [], frontDeskRosterReady: true, staffRoster: crew, staffPlan: null,
      staff: { ...base.staff, frontDesk: 1, housekeepers: 2, maintenanceWorkers: 0 } };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, lanes };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const lastRest = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest').at(-1);
  const counterFrom = (s: HotelState, id: string, t: number) => legsOf(s, id).find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk' && l.end > t);
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Who is serving at the counter at x, by seat ('0:K' -- K on lane 0). */
  const atCounter = (s: HotelState, x: number) => scheduledDeskLanes(s).flatMap(l => (l.duties ?? [])
    .filter(d => d.from <= x + 1e-9 && (d.startUntil ?? d.to) > x + 1e-9).map(d => `${l.seat}:${d.staffId}`)).sort();
  /** Times from just after t to the hour's end. */
  const after = (t: number, T: number) => [t + 0.01, t + 0.05, (t + T + 1) / 2, T + 0.99].filter(x => x < T + 1);
  const clock = (x: number, T: number) => `${15 + Math.floor(x - T + 1e-9)}:${String(Math.round(((x - T) % 1) * 60)).padStart(2, '0')}`;
  /** A room built far from everyone: new and clean, so it brings nobody anything. */
  const farRoom = (s: HotelState) => addRoom(s, 'standard', 7, 5, 0, 'up')!;

  describe('Resting in spare time: a lane a let-go opens is new work even when the clerk is away from it past the hour\'s end', () => {
    it('K on a compulsory break at the counter from 15:36 to 16:06, let go at 15:37, 15:42, 15:48 or 15:54: the housekeeper resting there serves lane 0 at once, to the hour\'s end', () => {
      // 15:00: K serves lane 0 till 15:36, then rests at (1, 4) on a break that runs to 16:06; idle rests at the counter till
      // 16:00 (back at 16:06, K would have left her under half an hour); lane 0 empty from 15:36
      const { s, T, lanes } = scene(82, false);
      const kEnd = getStaffPlan(s).itineraries.find(it => it.staffId === 'K')!.end;
      expect(kEnd.fatigueBreak).toMatchObject({ start: expect.closeTo(T + 0.6, 6), end: expect.closeTo(T + 1.1, 6) });
      expect(lastRest(s, 'idle')).toMatchObject({ idle: true, end: T + 1 });
      expect(atCounter(s, T + 0.65)).toEqual(['1:c1']);
      for (const e of [0.62, 0.7, 0.8, 0.9]) {
        const t = T + e;
        const re = settleChanges(s, dismissStaff(s, 'K', t)!, t);
        expect(counterFrom(re, 'idle', t), `let go at ${clock(t, T)}: idle at the counter`).toMatchObject({ lane: lanes[0].key, start: expect.closeTo(t, 6) });
        for (const x of after(t, T)) expect(atCounter(re, x), `let go at ${clock(t, T)}: counter at ${clock(x, T)}`).toEqual(['0:idle', '1:c1']);
      }
    });

    it('K at her desk all hour, let go at 15:47, 15:51 or 15:54 while the housekeeper rests in the break room: she leaves at once and serves lane 0 from just after 16:00', () => {
      // 15:00: K on lane 0 all shift; idle walks to the break room and rests there from 15:14 till 16:00. Let go, K's lane
      // is empty from then; from the break room idle gets there at 16:01 to 16:08, after the hour's plan ends
      const { s, T, lanes } = scene(20, true);
      expect(lastRest(s, 'idle')).toMatchObject({ idle: true, placeId: 'breakroom-0-5-0', end: T + 1 });
      for (const e of [0.78, 0.85, 0.9]) {
        const t = T + e;
        const re = settleChanges(s, dismissStaff(s, 'K', t)!, t);
        // this hour: she is on her way by 15:59, not resting in the break room
        expect(where(re, 'idle', t + 0.01), `let go at ${clock(t, T)}: idle just after`).toMatch(/ walk$/);
        expect(where(re, 'idle', T + 0.99), `let go at ${clock(t, T)}: idle at 15:59`).toMatch(/ walk$/);
        expect(legsOf(re, 'idle').filter(l => l.kind === 'stay' && l.activity === 'rest' && l.end > t + 1e-6), `let go at ${clock(t, T)}: rest after`).toEqual([]);
        // next hour: at the counter on lane 0 by 16:09
        const next = tickSimulation(re, new PRNG(5)).state;
        expect(next.hour, `let go at ${clock(t, T)}`).toBe(16);
        expect(counterFrom(next, 'idle', T + 1)?.lane, `let go at ${clock(t, T)}: idle's lane next hour`).toBe(lanes[0].key);
        expect(counterFrom(next, 'idle', T + 1)!.start, `let go at ${clock(t, T)}: idle at the counter from`).toBeLessThan(T + 1.15);
        expect(atCounter(next, T + 1.15), `let go at ${clock(t, T)}: counter at 16:09`).toEqual(['0:idle', '1:c1']);
      }
    });

    it('control: an edit at the same times that brings nobody anything new (a far room built) leaves her resting where she was till 16:00', () => {
      for (const [kFatigue, breakRoom, edits] of [[82, false, [0.62, 0.7, 0.8, 0.9]], [20, true, [0.78, 0.85, 0.9]]] as const) {
        const { s, T } = scene(kFatigue, breakRoom);
        for (const e of edits) {
          const t = T + e;
          const re = settleChanges(s, farRoom(s), t);
          const label = `${breakRoom ? 'break room' : 'at the counter'}, edit at ${clock(t, T)}`;
          for (const x of after(t, T)) {
            expect(where(re, 'idle', x), `${label}: idle at ${clock(x, T)}`).toBe(where(s, 'idle', x));
            expect(atCounter(re, x), `${label}: counter at ${clock(x, T)}`).toEqual(atCounter(s, x));
          }
          expect(lastRest(re, 'idle'), label).toMatchObject({ idle: true, end: T + 1 });
          expect(counterFrom(re, 'idle', t), label).toBeUndefined();
        }
      }
    });
  });
}

// Settle re-plans twice at one instant with a named front desk: the second judges what's new against the desk before the edit, not the first re-plan's plan.
{
  /** A housekeeper at `at`, `fatigue` as of the hour's start `T`, reception-trained unless `trained` is false. */
  function hk(id: string, at: TilePos, fatigue: number, T: number, extra: Partial<StaffMember> = {}, trained = true): StaffMember {
    return { id, name: id, serial: id.length + 10, role: 'housekeeper', dailyWage: 80.5, at,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', receptionTrained: trained },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T }, ...extra } as StaffMember;
  }

  /**
   * 15:00 on day 2, a named front desk with no clerks, one desk with two lanes (both served from (1, 4)), rooms A at (5, 2)
   * and B at (7, 2) being turned over, a break room at (5, 0) if asked, the hour planned:
   * c1 (10) covers lane 1 till 16:30; c2 (20) cleans A till 15:12, walks over and covers lane 0 from 15:26 to 16:26;
   * c3 (20, not reception-trained) cleans B till 15:51. `idle` (30) finds lane 0 free for only 26 minutes, so she rests in
   * spare time till 16:00: at the counter, or in the break room from 15:14 after walking there.
   */
  function scene(o: { breakRoom: boolean }) {
    let base: HotelState = { ...createStarterHotel(), day: 2, hour: 15, cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    base = addRoom(base, 'standard', 5, 2, 0, 'up')!;
    base = addRoom(base, 'standard', 7, 2, 0, 'up')!;
    if (o.breakRoom) base = addFixture(base, 'breakroom', 5, 0, 0)!;
    const T = hourStart(base);
    const lanes = physicalDeskLanes(base);
    const [A, B] = base.rooms;
    const crew = [
      hk('c1', lanes[1].front, 10, T, { receptionSupport: { lane: lanes[1].key, from: T - 0.5, to: T + 1.5 } }),
      hk('c2', roomTile(A), 20, T, { roomId: A.id }),
      hk('c3', roomTile(B), 20, T, { roomId: B.id }, false),
      hk('idle', lanes[0].front, 30, T),
    ];
    const s: HotelState = { ...base, frontDeskRosterReady: true, staffRoster: crew, staffPlan: null, guests: [],
      rooms: base.rooms.map((r, i) => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: i === 0 ? 0.2 : 0.85, cleaningHoursTotal: 1 })),
      staff: { ...base.staff, frontDesk: 0, housekeepers: crew.length, maintenanceWorkers: 0 } };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, A, B };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const lastRest = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest').at(-1);
  const counterFrom = (s: HotelState, id: string, t: number) => legsOf(s, id).find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk' && l.end > t);
  const cleans = (s: HotelState, id: string, t: number) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job && l.end > t).map(l => l.placeId);
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Who is serving at the counter at x. */
  const atCounter = (s: HotelState, x: number) => deskCoverage(s, x).map(d => d.staffId).sort();
  /** A room built far from everyone: new and clean, so it brings nobody anything. */
  const farRoom = (s: HotelState) => addRoom(s, 'standard', 7, 5, 0, 'up')!;
  /** The let-go (or the far room) at 15:03, 15:06 or 15:09. */
  const EDITS = [0.05, 0.1, 0.15];

  describe('Resting in spare time with a named front desk: a lane freed when a let-go moves a colleague off it is new work', () => {
    it('c3 let go at 15:03, 15:06 or 15:09, so c2 cleans B after A and never reaches lane 0: the housekeeper resting at the counter serves lane 0 at once, and both lanes are covered to the hour\'s end', () => {
      // 15:00: idle rests at the counter till 16:00; lane 0 has nobody till c2 arrives at 15:26
      const { s, T, A, B } = scene({ breakRoom: false });
      expect(lastRest(s, 'idle')).toMatchObject({ idle: true, start: T, end: T + 1 });
      expect(atCounter(s, T + 0.3)).toEqual(['c1']);
      expect(atCounter(s, T + 0.6)).toEqual(['c1', 'c2']);
      for (const e of EDITS) {
        const t = T + e;
        const re = settleChanges(s, dismissStaff(s, 'c3', t)!, t);
        expect(cleans(re, 'c2', t), `let go at +${e}: c2 cleans A then B`).toEqual([A.id, B.id]);
        expect(counterFrom(re, 'c2', t), `let go at +${e}: c2 never at the counter`).toBeUndefined();
        expect(counterFrom(re, 'idle', t)?.start, `let go at +${e}: idle at the counter at once`).toBeCloseTo(t, 6);
        for (const x of [t + 0.01, T + 0.3, T + 0.6, T + 0.99]) {
          expect(atCounter(re, x), `let go at +${e}: counter at +${(x - T).toFixed(2)}`).toEqual(['c1', 'idle']);
        }
      }
    });

    it('the same with her on her way to, or resting in, the break room: she comes back and serves lane 0 within ten minutes of the let-go, to the hour\'s end', () => {
      // 15:00: idle walks to the break room (15:00-15:14) and rests there till 16:00; lane 0 has nobody till c2 at 15:26
      const { s, T } = scene({ breakRoom: true });
      expect(lastRest(s, 'idle')).toMatchObject({ idle: true, placeId: expect.any(String), end: T + 1 });
      for (const e of EDITS) {
        const t = T + e;
        const re = settleChanges(s, dismissStaff(s, 'c3', t)!, t);
        const at = counterFrom(re, 'idle', t);
        expect(at, `let go at +${e}: idle back at the counter`).toBeDefined();
        expect(at!.start, `let go at +${e}: idle back at the counter`).toBeLessThan(t + 1 / 6 + 1e-6);
        expect(lastRest(re, 'idle')?.end ?? -Infinity, `let go at +${e}: no rest after the let-go`).toBeLessThanOrEqual(t + 1e-6);
        for (const x of [at!.start + 0.01, T + 0.35, T + 0.6, T + 0.99]) {
          expect(atCounter(re, x), `let go at +${e}: counter at +${(x - T).toFixed(2)}`).toEqual(['c1', 'idle']);
        }
      }
    });

    it('control: a far room built at 15:03, 15:06 or 15:09 brings nobody anything new: she keeps resting where she was till 16:00, and lane 0 is still c2\'s from 15:26', () => {
      for (const breakRoom of [false, true]) {
        const { s, T } = scene({ breakRoom });
        for (const e of EDITS) {
          const t = T + e;
          const re = settleChanges(s, farRoom(s), t);
          for (const x of [t + 0.01, T + 0.3, T + 0.6, T + 0.99]) {
            expect(where(re, 'idle', x), `${breakRoom ? 'break room' : 'counter'}, room at +${e}: idle at +${(x - T).toFixed(2)}`).toBe(where(s, 'idle', x));
            expect(atCounter(re, x), `${breakRoom ? 'break room' : 'counter'}, room at +${e}: counter at +${(x - T).toFixed(2)}`).toEqual(atCounter(s, x));
          }
          expect(lastRest(re, 'idle'), `${breakRoom ? 'break room' : 'counter'}, room at +${e}`).toMatchObject({ idle: true, end: T + 1 });
          expect(counterFrom(re, 'c2', t)?.start, `${breakRoom ? 'break room' : 'counter'}, room at +${e}: c2 on lane 0`).toBeCloseTo(counterFrom(s, 'c2', T)!.start, 6);
        }
      }
    });
  });
}

// The before-the-edit check is only for someone resting in spare time with nothing new: once an edit brings her work, or takes away the do-not-disturb room she was resting for, a free lane is hers. Before the edit means the hotel as it was then, ways included, and who the replaced plan had at each seat.
{
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
    mid: { experience: 'skilled', style: 'standard', workHours: 100 },
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;

  /** A housekeeper standing at `at` (a room: in it, and hers to finish if `keeps`), `fatigue` as of the hour's start; reception-trained unless `trained` is false. */
  function keeper(id: string, at: Room | TilePos, abs: number, o: { speed?: keyof typeof SPEEDS; fatigue?: number; stamina?: 'low' | 'normal' | 'high'; trained?: boolean; keeps?: boolean } = {}): StaffMember {
    const p = SPEEDS[o.speed ?? 'mid'];
    const room = 'id' in at ? at as Room : undefined;
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: room ? roomTile(room) : at, ...(o.keeps && room ? { roomId: room.id } : {}),
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: o.stamina ?? 'normal', specialty: 'turnover_runner', hospitality: 'polite', receptionTrained: o.trained ?? true },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: o.fatigue ?? 0, fatigueAt: abs } } as StaffMember;
  }

  /** The starter hotel at `hour` on `day`, a named front desk with no clerks (its desk at (1, 3), both lanes served from (1, 4)). */
  function frontDesk(s: HotelState, day: number, hour: number, crew: StaffMember[]): HotelState {
    return { ...s, day, hour, guests: [], noiseSources: [], staffPlan: null, frontDeskRosterReady: true,
      staff: { ...s.staff, housekeepers: crew.length, maintenanceWorkers: 0, frontDesk: 0 }, staffRoster: crew };
  }

  const PACE = TRAVEL.guestHoursPerTile;
  /** A do-not-disturb guest in `room` going out at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id = 'd'): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  const counterFrom = (s: HotelState, id: string, t: number) => legsOf(s, id).find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk' && l.end > t);
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Who is serving at the counter at x. */
  const atCounter = (s: HotelState, x: number) => deskCoverage(s, x).map(d => d.staffId).sort();
  const clock = (x: number, T: number) => `15:${String(Math.round((x - T) * 60)).padStart(2, '0')}`;

  describe('Resting in spare time, then handed work by an edit: after the work, a free lane is hers to cover', () => {
    /**
     * 15:00 on day 2, a break room at (5, 0), one standard room R at (3, 2) being turned over (0.55h left), no clerks.
     * W (not reception-trained) turns R over till 15:33; K (reception-trained, at 83) is too tired at 15:00 for a half
     * hour at the counter before 85, so she rests in the break room from 15:02 till 16:00 (about 74 by 15:24).
     */
    function scene() {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      s = addFixture(s, 'breakroom', 5, 0, 0)!;
      s = addRoom(s, 'standard', 3, 2, 0, 'up')!;
      const R = s.rooms[0];
      s = frontDesk(s, 2, 15, [keeper('W', R, 24 + 15, { trained: false, keeps: true }), keeper('K', { gridX: 5, gridY: 1, floor: 0 }, 24 + 15, { fatigue: 83 })]);
      s = { ...s, rooms: s.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.55, cleaningHoursTotal: 1 })) };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T: hourStart(s), R };
    }

    it('W let go at 15:21, 15:24 or 15:27: K gets up to finish R, then (rested enough) covers the counter, both lanes free, from before 16:00 on past it', () => {
      const { s, T, R } = scene();
      expect(counterFrom(s, 'K', T)).toBeUndefined();
      expect(restsOf(s, 'K')).toMatchObject([{ idle: true, placeId: 'breakroom-0-5-0', end: T + 1 }]);
      for (const e of [0.35, 0.4, 0.45]) {
        const t = T + e;
        const re = settleChanges(s, dismissStaff(s, 'W', t)!, t);
        const label = `let go at ${clock(t, T)}`;
        // the rest of R is hers, at once
        const [clean] = jobsOf(re, 'K').filter(l => l.end > t);
        expect(clean, label).toMatchObject({ placeId: R.id });
        expect(clean.start, label).toBeLessThan(t + 0.15);
        // then the counter: a lane nobody has, now that her hour is planned afresh
        const desk = counterFrom(re, 'K', t);
        expect(desk, `${label}: K at the counter after R`).toBeDefined();
        expect(desk!.start, label).toBeGreaterThan(clean.end);
        expect(desk!.start, label).toBeLessThan(T + 0.95);
        expect(desk!.end, label).toBeGreaterThan(T + 1);
        expect(atCounter(re, T + 0.97), `${label}: counter at 15:58`).toEqual(['K']);
        expect(restsOf(re, 'K').filter(l => l.end > clean.end + 1e-9), `${label}: no rest after R`).toEqual([]);
      }
    });

    it('control: a paused edit at the same times, bringing nothing, leaves her resting in the break room till 16:00, the counter empty', () => {
      const { s, T } = scene();
      for (const e of [0.35, 0.4, 0.45]) {
        const t = T + e;
        const re = replanStaff(s, t);
        for (const x of [t + 0.01, T + 0.7, T + 0.97]) {
          expect(where(re, 'K', x), `edit at ${clock(t, T)}: K at ${clock(x, T)}`).toBe(where(s, 'K', x));
          expect(atCounter(re, x), `edit at ${clock(t, T)}: counter at ${clock(x, T)}`).toEqual([]);
        }
        expect(counterFrom(re, 'K', t)).toBeUndefined();
      }
    });
  });

  describe('Resting at home for a do-not-disturb party when an edit cuts her room off: a free lane is hers at once', () => {
    /**
     * 15:00 on day 3, a break room at (5, 0), standard rooms D (3, 2), X (4, 2) and (5, 2), no clerks. hk-a (not
     * reception-trained) turns X over all hour; D's party (do-not-disturb) goes out at 15:36 for the afternoon. hk-b
     * (reception-trained, at 40) walks to the base at the counter front by 15:14, rests there till 15:31 and cleans D from
     * 15:41.
     */
    function scene() {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      s = addFixture(s, 'breakroom', 5, 0, 0)!;
      for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
      const abs = 2 * 24 + 15;
      const [D, X] = s.rooms;
      s = frontDesk(s, 3, 15, [keeper('hk-a', X, abs, { keeps: true, stamina: 'high', trained: false }), keeper('hk-b', s.rooms[2], abs, { stamina: 'high', fatigue: 40 })]);
      const T = hourStart(s);
      s = { ...s, guests: [goingOut(s, D, T + 0.6, T + 4)],
        rooms: s.rooms.map(r => (r.id === X.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 1.5 }
          : r.id === D.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.5 } : r)) };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T, D };
    }
    const BASE = { gridX: 1, gridY: 4, floor: 0 };

    it('a room built at 15:18, 15:21 or 15:24 on the hallway tile at D\'s door: she covers the counter from then, on past 16:00, rather than resting on', () => {
      const { s, T, D } = scene();
      const [home] = restsOf(s, 'hk-b');
      expect(home).toMatchObject({ idle: true, at: BASE });
      expect(home.end).toBeLessThan(T + 0.6);
      expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D.id]);
      expect(counterFrom(s, 'hk-b', T)).toBeUndefined();
      expect(physicalDeskLanes(s).map(l => l.front)).toEqual([BASE, BASE]);
      for (const e of [0.3, 0.35, 0.4]) {
        const t = T + e;
        const re = settleChanges(s, addRoom(s, 'standard', 3, 1, 0, 'left')!, t);
        const label = `room built at ${clock(t, T)}`;
        expect(jobsOf(re, 'hk-b').filter(l => l.end > t), label).toEqual([]);
        // already at the counter front: serving at once
        expect(counterFrom(re, 'hk-b', t)?.start, label).toBeCloseTo(t, 6);
        expect(counterFrom(re, 'hk-b', t)!.end, label).toBeGreaterThan(T + 1);
        for (const x of [t + 0.01, T + 0.6, T + 0.95]) expect(atCounter(re, x), `${label}: counter at ${clock(x, T)}`).toEqual(['hk-b']);
        expect(restsOf(re, 'hk-b').filter(l => l.end > t + 1e-9), label).toEqual([]);
      }
    });

    it('control: a paused edit at the same times leaves her resting at home till her set-off, and D cleaned as planned', () => {
      const { s, T, D } = scene();
      for (const e of [0.3, 0.35, 0.4]) {
        const t = T + e;
        const re = replanStaff(s, t);
        for (let x = t + 0.001; x < T + 1; x += 0.01) expect(where(re, 'hk-b', x), `edit at ${clock(t, T)}: hk-b at ${clock(x, T)}`).toBe(where(s, 'hk-b', x));
        expect(jobsOf(re, 'hk-b').map(l => l.placeId)).toEqual([D.id]);
        expect(counterFrom(re, 'hk-b', t)).toBeUndefined();
      }
    });
  });

  describe('Resting in spare time, cut off from the counter: a way opened to it by an edit makes a free lane new work', () => {
    /**
     * 15:00 on day 2, no clerks. Rooms at (7, 0) and (7, 1) (doors left) and (8, 2) and (9, 2) (doors down) wall off the
     * top-right corner, where H (reception-trained, at 30) stands at (9, 0) with nothing to do and no way out: she rests
     * there, in the hallway, till 16:00. Demolishing the room at (7, 1) opens the way to the counter (about 20 minutes).
     */
    function scene() {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      for (const [x, y, door] of [[7, 0, 'left'], [7, 1, 'left'], [8, 2, 'down'], [9, 2, 'down']] as const) s = addRoom(s, 'standard', x, y, 0, door)!;
      s = frontDesk(s, 2, 15, [keeper('H', { gridX: 9, gridY: 0, floor: 0 }, 24 + 15, { fatigue: 30 })]);
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T: hourStart(s), gap: s.rooms.find(r => r.gridX === 7 && r.gridY === 1)! };
    }

    it('the wall room at (7, 1) demolished at 15:06, 15:12 or 15:18: she leaves the corner at once and covers the counter from before 15:45, on past 16:00', () => {
      const { s, T, gap } = scene();
      expect(restsOf(s, 'H')).toMatchObject([{ idle: true, at: { gridX: 9, gridY: 0, floor: 0 }, start: T, end: T + 1 }]);
      expect(counterFrom(s, 'H', T)).toBeUndefined();
      for (const e of [0.1, 0.2, 0.3]) {
        const t = T + e;
        const re = settleChanges(s, demolishRoom(s, gap.id)!, t);
        const label = `demolished at ${clock(t, T)}`;
        expect(where(re, 'H', t + 0.01), label).toMatch(/ walk$/);
        const desk = counterFrom(re, 'H', t);
        expect(desk, `${label}: H at the counter`).toBeDefined();
        expect(desk!.start, label).toBeLessThan(t + 0.45);
        expect(desk!.end, label).toBeGreaterThan(T + 1);
        expect(atCounter(re, T + 0.9), `${label}: counter at 15:54`).toEqual(['H']);
      }
    });

    it('control: a paused edit at the same times, the corner still walled off, leaves her resting there till 16:00', () => {
      const { s, T } = scene();
      for (const e of [0.1, 0.2, 0.3]) {
        const re = replanStaff(s, T + e);
        for (const x of [T + e + 0.01, T + 0.6, T + 0.95]) expect(where(re, 'H', x)).toBe(where(s, 'H', x));
        expect(counterFrom(re, 'H', T + e)).toBeUndefined();
      }
    });
  });

  // Late clerks just in for their shift take the seats they're given; let one go and the other moves over to her seat. The
  // counter stays of the plan being replaced count as the desk before the edit: letting the second go too opens the seat
  // she had moved to, even where the desk's schedule still has her on the seat she left.
  {
    const profile = { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite' } as const;
    /** A reception-trained housekeeper at `at`, `fatigue` as of the hour's start `T`. */
    function hk(id: string, at: TilePos, fatigue: number, T: number, extra: Partial<StaffMember> = {}): StaffMember {
      return { id, name: id, serial: 30 + id.length, role: 'housekeeper', dailyWage: 80.5, at, profile: { ...profile, receptionTrained: true },
        stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T }, ...extra } as StaffMember;
    }
    /** A late-shift front desk clerk at the counter front, just in for her shift (no seat of her own yet). */
    function clerk(id: string, serial: number, at: TilePos, T: number): StaffMember {
      return { id, name: id, serial, role: 'front_desk', shift: 'late', at, dailyWage: 40, profile,
        stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 20, fatigueAt: T } } as StaffMember;
    }

    /**
     * 14:00 on day 2, a named front desk (one desk, both lanes served from (1, 4)), a break room at (5, 0), a standard room R
     * at (3, 2) being turned over (0.08 hours left), the hour planned. A and B, late clerks just in for their shift, take lanes
     * 0 and 1 all hour; H (reception-trained) turns R over till 14:05, then rests in the break room; K (reception-trained) walks
     * there and rests from 14:02 till 15:00.
     */
    function scene() {
      let s: HotelState = { ...createStarterHotel(), day: 2, hour: 14, cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      s = addFixture(s, 'breakroom', 5, 0, 0)!;
      s = addRoom(s, 'standard', 3, 2, 0, 'up')!;
      const R = s.rooms[0];
      const T = hourStart(s);
      const lanes = physicalDeskLanes(s);
      const crew = [clerk('A', 9, lanes[0].front, T), clerk('B', 10, lanes[1].front, T),
        hk('H', roomTile(R), 20, T, { roomId: R.id }), hk('K', { gridX: 5, gridY: 1, floor: 0 }, 20, T)];
      s = { ...s, guests: [], noiseSources: [], frontDeskRosterReady: true, staffRoster: crew, staffPlan: null,
        rooms: s.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.08, cleaningHoursTotal: 1 })),
        staff: { ...s.staff, frontDesk: 2, housekeepers: 2, maintenanceWorkers: 0 } };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T, lanes };
    }
    /** Who is serving at the counter at x, by seat ('0:K' -- K on lane 0). */
    const atSeat = (s: HotelState, x: number) => scheduledDeskLanes(s).flatMap(l => (l.duties ?? [])
      .filter(d => d.from <= x + 1e-9 && (d.startUntil ?? d.to) > x + 1e-9).map(d => `${l.seat}:${d.staffId}`)).sort();
    const clock14 = (x: number, T: number) => `14:${String(Math.round((x - T) * 60)).padStart(2, '0')}`;
    /** The second edit at 14:08, 14:10 or 14:12 (H on her way from R to the counter). */
    const SECOND = [8 / 60, 10 / 60, 12 / 60];

    describe('Resting in spare time: letting go the clerk who moved over to a seat mid-hour opens that seat, and it is new work', () => {
      it('A let go at 14:03, so B moves over to lane 0 and H takes lane 1 after R; B let go at 14:08, 14:10 or 14:12: K leaves the break room at once and serves lane 0 from before 14:30, on past 15:00', () => {
        const { s, T, lanes } = scene();
        expect(counterFrom(s, 'A', T)).toMatchObject({ lane: lanes[0].key, end: T + 1 });
        expect(counterFrom(s, 'B', T)).toMatchObject({ lane: lanes[1].key, end: T + 1 });
        expect(restsOf(s, 'K')).toMatchObject([{ idle: true, placeId: 'breakroom-0-5-0', end: T + 1 }]);
        const t1 = T + 0.05;
        const s1 = settleChanges(s, dismissStaff(s, 'A', t1)!, t1);
        // 14:03: B on lane 0 from now, H on lane 1 from about 14:16, K resting on
        expect(counterFrom(s1, 'B', t1)).toMatchObject({ lane: lanes[0].key, start: expect.closeTo(t1, 6), end: T + 1 });
        expect(counterFrom(s1, 'H', t1)).toMatchObject({ lane: lanes[1].key });
        expect(counterFrom(s1, 'H', t1)!.start).toBeGreaterThan(T + 0.2);
        expect(counterFrom(s1, 'K', t1)).toBeUndefined();
        for (const x of [t1 + 0.01, T + 0.3, T + 0.9]) expect(where(s1, 'K', x), `K at ${clock14(x, T)}`).toBe(where(s, 'K', x));
        for (const e of SECOND) {
          const t2 = T + e;
          const label = `B let go at ${clock14(t2, T)}`;
          const s2 = settleChanges(s1, dismissStaff(s1, 'B', t2)!, t2);
          expect(where(s2, 'K', t2 + 0.01), label).toMatch(/ walk$/);
          const desk = counterFrom(s2, 'K', t2);
          expect(desk, `${label}: K at the counter`).toMatchObject({ lane: lanes[0].key });
          expect(desk!.start, label).toBeLessThan(T + 0.5);
          expect(desk!.end, label).toBeGreaterThan(T + 1);
          expect(restsOf(s2, 'K').filter(l => l.end > t2 + 1e-6), `${label}: K resting after`).toEqual([]);
          expect(atSeat(s2, T + 0.6), `${label}: counter at 14:36`).toEqual(['0:K', '1:H']);
        }
      });

      it('control: after A\'s let-go, a far room built at 14:08, 14:10 or 14:12 brings nobody anything: K rests in the break room till 15:00, and B stays on lane 0', () => {
        const { s, T, lanes } = scene();
        const t1 = T + 0.05;
        const s1 = settleChanges(s, dismissStaff(s, 'A', t1)!, t1);
        for (const e of SECOND) {
          const t2 = T + e;
          const label = `far room at ${clock14(t2, T)}`;
          const s2 = settleChanges(s1, addRoom(s1, 'standard', 7, 5, 0, 'up')!, t2);
          for (const x of [t2 + 0.01, T + 0.5, T + 0.95]) expect(where(s2, 'K', x), `${label}: K at ${clock14(x, T)}`).toBe(where(s1, 'K', x));
          expect(counterFrom(s2, 'K', t2), label).toBeUndefined();
          expect(legsOf(s2, 'B').at(-1), `${label}: B`).toMatchObject({ kind: 'stay', activity: 'desk', lane: lanes[0].key, end: T + 1 });
        }
      });
    });
  }
}

// Settle's second re-plan finds her a step into her walk to the break room: the free seat is no newer than at the first. Nor does the block she herself had there before the edit make it new.
{
  /** A reception-trained housekeeper at `at`, `fatigue` as of the hour's start `abs`. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number, extra: Partial<StaffMember> = {}): StaffMember {
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', specialty: 'turnover_runner', hospitality: 'polite', receptionTrained: true },
      stats: { workHours: 100, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs }, ...extra } as StaffMember;
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const counterOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk');
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Who is serving at the counter at x. */
  const atCounter = (s: HotelState, x: number) => deskCoverage(s, x).map(d => d.staffId).sort();
  const clock = (x: number, T: number) => `15:${(Math.round((x - T) * 600) / 10).toFixed(1).padStart(4, '0')}`;

  describe('Her room taken away by an edit, the counter taken when she\'d get there: she rests, and Settle\'s second re-plan keeps her resting', () => {
    /**
     * 15:00 on day 2, a named front desk with no clerks (its desk at (1, 3), both lanes served from (1, 4)), a break room
     * at (5, 0), one standard room R at (3, 2) (door up, onto (3, 1)) to turn over, 0.05h of work, its guest stepping out
     * at 15:24. H (reception-trained, at 20) waits in the hall at R's door till then, turns R over by 15:28.8 and takes
     * the counter's first seat from 15:39.6 for an hour. G (at 81) has that seat till 15:28.8, then (too tired for
     * another half hour before 85) rests in the break room; K has the second seat all hour.
     */
    function scene() {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      s = addFixture(s, 'breakroom', 5, 0, 0)!;
      s = addRoom(s, 'standard', 3, 2, 0, 'up')!;
      const R = s.rooms[0];
      const abs = 24 + 15;
      const lanes = physicalDeskLanes(s);
      const crew = [
        keeper('H', { gridX: 3, gridY: 1, floor: 0 }, abs, 20),
        keeper('G', lanes[0].front, abs, 81, { receptionSupport: { lane: lanes[0].key, from: abs - 0.5, to: abs + 0.48 } }),
        keeper('K', lanes[1].front, abs, 15, { receptionSupport: { lane: lanes[1].key, from: abs - 0.5, to: abs + 1.5 } }),
      ];
      // R's guest, checked out, steps out of it at 15:24
      const pace = TRAVEL.guestHoursPerTile;
      const out = routeToStreet(s, roomTile(R), pace)!;
      const step = makeWalk(out.path.slice(0, 2), 0, pace).end;
      const walker: Walker = { id: 'w', trait: 'normal', isReturning: false, reason: 'checked_out', trip: [makeWalk(out.path, abs + 0.4 - step, pace)] };
      s = { ...s, day: 2, hour: 15, guests: [], walkers: [walker], noiseSources: [], staffPlan: null, frontDeskRosterReady: true,
        staff: { ...s.staff, housekeepers: crew.length, maintenanceWorkers: 0, frontDesk: 0 }, staffRoster: crew,
        rooms: s.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.05, cleaningHoursTotal: 1 })) };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T: hourStart(s), R, lanes: lanes.map(l => l.key) };
    }

    it('R demolished at 15:16.8, 15:18 or 15:19.2: she goes to rest in the break room till 16:00, as the first re-plan alone has it, not to the seat that frees at 15:28.8', () => {
      const { s, T, R, lanes } = scene();
      // the hour as planned: H at the counter's first seat from 15:39.6, G there till 15:28.8, K on the second seat
      const [desk] = counterOf(s, 'H');
      expect(counterOf(s, 'H')).toHaveLength(1);
      expect(desk).toMatchObject({ lane: lanes[0] });
      expect(desk.start).toBeCloseTo(T + 0.66, 6);
      expect(counterOf(s, 'G')).toMatchObject([{ lane: lanes[0], end: T + 0.48 }]);
      expect(counterOf(s, 'K')).toMatchObject([{ lane: lanes[1] }]);
      expect(atCounter(s, T + 0.7)).toEqual(['H', 'K']);
      for (const e of [0.28, 0.3, 0.32]) {
        const t = T + e;
        const label = `R demolished at ${clock(t, T)}`;
        const after = demolishRoom(s, R.id)!;
        const re = settleChanges(s, after, t);
        // From her spot at R's door (5 tiles from the counter) she'd be there by 15:27.6 at the latest, G still on the first
        // seat, K on the second: the first re-plan sends her to rest in the break room, three tiles off the other way
        const first = replanStaff(after, t, s);
        expect(counterOf(first, 'H').filter(l => l.end > t), label).toEqual([]);
        expect(restsOf(first, 'H').at(-1), label).toMatchObject({ idle: true, placeId: 'breakroom-0-5-0', end: T + 1 });
        // Settle re-plans again once the guests have new ways (the lanes changed with the layout); by then she's a step
        // into that walk, six tiles from the counter, and would get there after G has gone
        const [stepped] = legsOf(re, 'H').filter(l => l.kind === 'walk' && l.start >= t - 1e-9);
        expect(stepped.kind === 'walk' && stepped.path.length, label).toBe(2);
        expect(stepped.end, label).toBeCloseTo(t + TRAVEL.hoursPerTile, 9);
        // ... and still rests on: the same plan as the first re-plan's, the first seat empty after G
        expect(counterOf(re, 'H').filter(l => l.end > t), label).toEqual([]);
        expect(restsOf(re, 'H').at(-1), label).toMatchObject({ idle: true, placeId: 'breakroom-0-5-0', end: T + 1 });
        for (const x of [t + 0.04, T + 0.5, T + 0.66, T + 0.8, T + 0.99]) {
          expect(where(re, 'H', x), `${label}: H at ${clock(x, T)}`).toBe(where(first, 'H', x));
          expect(atCounter(re, x), `${label}: counter at ${clock(x, T)}`).toEqual(x < T + 0.48 ? ['G', 'K'] : ['K']);
        }
      }
    });
  });
}

// What a re-plan is told of the hotel before the edit, and passes on: her way to the counter then, the desk before it in each of Settle's re-plans, and the spare-time rests it found, in every plan it makes.
{
  // Cut off upstairs by a lift demolished mid-hour, then reconnected: the lane free since 15:30 is new work for her.
  {
    /** A reception-trained housekeeper at `at`, `fatigue` as of the hour's start `T`. */
    function hk(id: string, at: TilePos, fatigue: number, T: number, extra: Partial<StaffMember> = {}): StaffMember {
      return { id, name: id, serial: id.length + 10, role: 'housekeeper', dailyWage: 80.5, at,
        profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', receptionTrained: true },
        stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T }, ...extra } as StaffMember;
    }

    /**
     * 15:00 on day 2, two floors joined by a lift at (0, 0), a break room upstairs at (5, 0), a named front desk with no
     * clerks, one desk with two lanes (both served from (1, 4)), the hour planned: c0 (81) covers lane 0 till 15:30 and is
     * then too tired for another block, c1 (15) covers lane 1 till 16:30. `up` (30) starts the hour upstairs at (5, 1) with
     * nothing to do: both lanes taken, she steps into the break room and rests there in spare time till 16:00.
     */
    function scene() {
      let base: HotelState = { ...createStarterHotel(), day: 2, hour: 15, cash: 1_000_000 };
      base = buildFloor(base)!.state;
      base = addElevator(base, 0, 0)!;
      base = addFixture(base, 'breakroom', 5, 0, 1)!;
      const T = hourStart(base);
      const lanes = physicalDeskLanes(base);
      const crew = [
        hk('c0', lanes[0].front, 81, T, { receptionSupport: { lane: lanes[0].key, from: T - 0.5, to: T + 0.5 } }),
        hk('c1', lanes[1].front, 15, T, { receptionSupport: { lane: lanes[1].key, from: T - 0.5, to: T + 1.5 } }),
        hk('up', { gridX: 5, gridY: 1, floor: 1 }, 30, T),
      ];
      const s: HotelState = { ...base, frontDeskRosterReady: true, staffRoster: crew, staffPlan: null, guests: [],
        staff: { ...base.staff, frontDesk: 0, housekeepers: 3, maintenanceWorkers: 0 } };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T, lanes };
    }

    const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)!.legs;
    const lastRest = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest').at(-1);
    const counterFrom = (s: HotelState, id: string, t: number) => legsOf(s, id).find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk' && l.end > t);
    /** Where someone is at x and doing what (rest rate and seat included). */
    const where = (s: HotelState, id: string, x: number) => {
      const p = positionAt(legsOf(s, id), x)!;
      return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
    };
    /** A room built far from everyone: new and clean, so it brings nobody anything. */
    const farRoom = (s: HotelState) => addRoom(s, 'standard', 7, 5, 0, 'up')!;

    describe('Resting upstairs in spare time: a lane she had no way to before the edit is new work', () => {
      it('the lift demolished at 15:33 and built again at 15:36: she leaves the break room at once and covers lane 0 (free since 15:30) from about 16:03, past the hour', () => {
        const { s, T, lanes } = scene();
        expect(lastRest(s, 'up')).toMatchObject({ idle: true, placeId: expect.stringContaining('breakroom'), end: T + 1 });
        expect(counterFrom(s, 'up', T)).toBeUndefined();
        // 15:33: no way down -- she rests on upstairs, nothing at the counter for her
        const gone = settleChanges(s, demolishElevator(s, 'elevator-0-0')!, T + 0.55);
        expect(counterFrom(gone, 'up', T + 0.55)).toBeUndefined();
        expect(lastRest(gone, 'up')).toMatchObject({ idle: true, end: T + 1 });
        // 15:36: the lift is back -- before this edit the counter was out of her reach, so lane 0 is new work
        const t = T + 0.6;
        const back = settleChanges(gone, addElevator(gone, 0, 0)!, t);
        expect(where(back, 'up', t + 0.01)).toMatch(/ walk$/);
        expect(where(back, 'up', T + 0.99)).toMatch(/ walk$/);
        expect(legsOf(back, 'up').filter(l => l.kind === 'stay' && l.activity === 'rest' && l.end > t + 1e-6)).toEqual([]);
        const desk = counterFrom(back, 'up', t)!;
        expect(desk).toMatchObject({ lane: lanes[0].key });
        expect(desk.start).toBeLessThan(T + 1.1);
        expect(desk.end).toBeGreaterThan(T + 1.5);
      });

      it('control: never cut off, an edit at 15:36 that brings nothing (a far room built) leaves her resting in the break room till 16:00', () => {
        const { s, T } = scene();
        const t = T + 0.6;
        const re = settleChanges(s, farRoom(s), t);
        for (const x of [t + 0.01, t + 0.05, T + 0.8, T + 0.99]) expect(where(re, 'up', x), `up at +${(x - T).toFixed(2)}`).toBe(where(s, 'up', x));
        expect(counterFrom(re, 'up', t)).toBeUndefined();
        expect(lastRest(re, 'up')).toMatchObject({ idle: true, placeId: expect.stringContaining('breakroom'), end: T + 1 });
      });
    });
  }

  // The held suite's housekeeper let go mid-hour: the rush decided again, and not needed. The plan made without it keeps
  // the spare-time rests it found: one resting at the counter is not sent to a lane the hour's plan already had freeing.
  {
    /** A writer due on day 9 at 18:00, announced. */
    const writer = (roomId: string): SpotlightPlan => ({
      kind: 'writer', week: 1, salt: '', announceDay: 9, arrivalDay: 9, arrivalHour: 18, status: 'announced', chainId: 'spotlight-10', roomId,
    });

    const SPEEDS = {
      slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
      mid: { experience: 'skilled', style: 'standard', workHours: 100 },
      fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
    } as const;

    /** A housekeeper standing at `at` (a room: in it): a slow rookie, a skilled one or a fast veteran; reception-trained if `trained`. */
    function keeper(id: string, speed: keyof typeof SPEEDS, at: Room | TilePos, abs: number,
      o: { fatigue?: number; trained?: boolean; stamina?: 'low' | 'normal' | 'high'; extra?: Partial<StaffMember> } = {}): StaffMember {
      const p = SPEEDS[speed];
      return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: 'id' in at ? roomTile(at as Room) : at,
        profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: o.stamina ?? 'high', specialty: 'turnover_runner', hospitality: 'polite',
          ...(o.trained ? { receptionTrained: true } : {}) },
        stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: o.fatigue ?? 0, fatigueAt: abs }, ...o.extra } as StaffMember;
    }

    /**
     * 15:00 on day 9 at 3 stars, a named front desk with no clerks, one desk with two lanes (both served from (1, 4)): the
     * suite S at (3, 2) (2.5 hours of turnover left) held for a writer due at 18:00, X at (4, 2) (1.5 hours), and a clean
     * room at (5, 2) where fast, slow and mid stand. The hour planned: S rushed for fast, slow on X, mid with nothing to do
     * rests; H (reception-trained, 30) at the counter finds both lanes taken and rests there till 16:00; c0 (81) covers
     * lane 0 till 15:30 and is then too tired for another block; c1 (15) covers lane 1 till 16:30.
     */
    function scene() {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      s = addRoom(s, 'suite', 3, 2, 0, 'up')!;
      s = addRoom(s, 'standard', 4, 2, 0, 'up')!;
      s = addRoom(s, 'standard', 5, 2, 0, 'up')!;
      const day = 9, hour = 15, abs = (day - 1) * 24 + hour;
      const lanes = physicalDeskLanes(s);
      const [S, , clean] = s.rooms;
      const crew = [
        keeper('fast', 'fast', clean, abs), keeper('slow', 'slow', clean, abs), keeper('mid', 'mid', clean, abs),
        keeper('H', 'mid', lanes[0].front, abs, { trained: true, fatigue: 30 }),
        keeper('c0', 'mid', lanes[0].front, abs, { trained: true, fatigue: 81, stamina: 'normal', extra: { receptionSupport: { lane: lanes[0].key, from: abs - 0.5, to: abs + 0.5 } } }),
        keeper('c1', 'mid', lanes[1].front, abs, { trained: true, fatigue: 15, stamina: 'normal', extra: { receptionSupport: { lane: lanes[1].key, from: abs - 0.5, to: abs + 1.5 } } }),
      ];
      s = { ...s, day, hour, guests: [], noiseSources: [], staffPlan: null, frontDeskRosterReady: true, spotlight: writer(S.id),
        rooms: s.rooms.map((r, i) => (i < 2 ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: i === 0 ? 2.5 : 1.5 } : r)),
        staff: { ...s.staff, housekeepers: crew.length, frontDesk: 0, maintenanceWorkers: 0 }, staffRoster: crew };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T: hourStart(s), S, lanes };
    }

    const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
    const lastRest = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest').at(-1);
    const counterFrom = (s: HotelState, id: string, t: number) => legsOf(s, id).find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk' && l.end > t);
    /** Who works a room's turnover from t in this hour's plan. */
    const cleaning = (s: HotelState, roomId: string, t: number) => getStaffPlan(s).itineraries
      .filter(it => it.legs.some(l => l.kind === 'stay' && l.job === 'turnover' && l.placeId === roomId && l.end > t)).map(it => it.staffId);
    /** Where someone is at x and doing what (rest rate and seat included). */
    const where = (s: HotelState, id: string, x: number) => {
      const p = positionAt(legsOf(s, id), x)!;
      return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
    };

    describe('The held suite\'s housekeeper let go mid-hour, the rush decided again and not needed: spare-time rests are kept as for any re-plan', () => {
      it('fast let go at 15:33 or 15:36: mid takes over the suite (no rush now: done in time), and H rests on at the counter till 16:00, not off to lane 0 (free since 15:30)', () => {
        const { s, T, S } = scene();
        expect(s.staffPlan.rush).toEqual({ roomId: S.id, staffId: 'fast' });
        expect(cleaning(s, S.id, T)).toEqual(['fast']);
        expect(lastRest(s, 'H')).toMatchObject({ idle: true, end: T + 1 });
        expect(counterFrom(s, 'H', T)).toBeUndefined();
        expect(legsOf(s, 'c0')).toMatchObject([{ kind: 'stay', activity: 'desk', end: T + 0.5 }, { kind: 'stay', activity: 'rest', idle: true, end: T + 1 }]);
        for (const e of [0.55, 0.6]) {
          const t = T + e;
          const re = settleChanges(s, dismissStaff(s, 'fast', t)!, t);
          expect(re.staffPlan!.rush, `let go at +${e}`).toBeUndefined();
          expect(cleaning(re, S.id, t), `let go at +${e}: the suite`).toEqual(['mid']);
          // the let-go brings H nothing new: lane 0 was free for her since 15:30 in the hour's plan too
          expect(counterFrom(re, 'H', t), `let go at +${e}: H at the counter`).toBeUndefined();
          for (const x of [t + 0.01, t + 0.05, T + 0.8, T + 0.99]) expect(where(re, 'H', x), `let go at +${e}: H at +${(x - T).toFixed(2)}`).toBe(where(s, 'H', x));
          expect(lastRest(re, 'H'), `let go at +${e}`).toMatchObject({ idle: true, end: T + 1 });
        }
      });
    });
  }

  // Settle re-plans twice with a named front desk: the first must already judge what's new against the desk before the
  // edit, or a colleague the first plans after her takes the lane, and the second can't give it back.
  {
    const profile = { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite' } as const;

    /** A reception-trained housekeeper at `at`, `fatigue` as of the hour's start `T`. */
    function hk(id: string, at: TilePos, fatigue: number, T: number, extra: Partial<StaffMember> = {}): StaffMember {
      return { id, name: id, serial: id.length + 30, role: 'housekeeper', dailyWage: 80.5, at, profile: { ...profile, receptionTrained: true },
        stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T }, ...extra } as StaffMember;
    }

    /** A late-shift front desk clerk seated on `lane`, `fatigue` as of the hour's start `T`. */
    function clerk(id: string, at: TilePos, lane: string, fatigue: number, T: number): StaffMember {
      return { id, name: id, serial: 9, role: 'front_desk', shift: 'late', at, deskLane: lane, dailyWage: 40, profile,
        stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T } } as StaffMember;
    }

    /**
     * 15:00 on day 2, a named front desk, one desk with two lanes (both served from (1, 4)), a standard room at (3, 3) being
     * turned over (its door onto the corridor at (3, 4)), the hour planned. K, a late-shift clerk at 82, serves lane 0 till
     * 15:36, then rests at the counter on a compulsory break till 16:06; c1 (10), a reception-trained housekeeper, covers
     * lane 1 till 16:30. `idle` (30) has nothing to do and finds both lanes taken at 15:00: she rests at the counter till
     * 16:00. Y (20, reception-trained) cleans the room till 15:45; lane 0 would be hers from about 15:50 only till 16:06, so
     * she rests just outside it till 16:00.
     */
    function scene() {
      let base: HotelState = { ...createStarterHotel(), day: 2, hour: 15, cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      base = addRoom(base, 'standard', 3, 3, 0, 'down')!;
      const T = hourStart(base);
      const lanes = physicalDeskLanes(base);
      const room = base.rooms[0];
      const crew = [
        clerk('K', lanes[0].front, lanes[0].key, 82, T),
        hk('c1', lanes[1].front, 10, T, { receptionSupport: { lane: lanes[1].key, from: T - 0.5, to: T + 1.5 } }),
        hk('idle', lanes[0].front, 30, T),
        hk('Y', roomTile(room), 20, T, { roomId: room.id }),
      ];
      const s: HotelState = { ...base, guests: [], frontDeskRosterReady: true, staffRoster: crew, staffPlan: null,
        rooms: base.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.75, cleaningHoursTotal: 1 })),
        staff: { ...base.staff, frontDesk: 1, housekeepers: 3, maintenanceWorkers: 0 } };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T, lanes, room };
    }

    const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
    const lastRest = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest').at(-1);
    const counterFrom = (s: HotelState, id: string, t: number) => legsOf(s, id).find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk' && l.end > t);
    /** Where someone is at x and doing what (rest rate and seat included). */
    const where = (s: HotelState, id: string, x: number) => {
      const p = positionAt(legsOf(s, id), x)!;
      return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
    };
    /** Who is serving at the counter at x, by seat ('0:K' -- K on lane 0). */
    const atCounter = (s: HotelState, x: number) => scheduledDeskLanes(s).flatMap(l => (l.duties ?? [])
      .filter(d => d.from <= x + 1e-9 && (d.startUntil ?? d.to) > x + 1e-9).map(d => `${l.seat}:${d.staffId}`)).sort();
    const clock = (x: number, T: number) => `15:${String(Math.round((x - T) * 60)).padStart(2, '0')}`;
    /** A room built far from everyone: new and clean, so it brings nobody anything. */
    const farRoom = (s: HotelState) => addRoom(s, 'standard', 7, 5, 0, 'up')!;
    /** Edits at 15:37, 15:39 and 15:42: K on her break, Y still in the room. */
    const EDITS = [0.62, 0.65, 0.7];

    describe('Settle\'s first re-plan judges what\'s new against the desk before the edit too: a let-go\'s lane goes to the one resting, not to a colleague still at work', () => {
      it('K let go on her break at 15:37, 15:39 or 15:42: the housekeeper resting at the counter serves lane 0 at once, and Y, out of the room at 15:45, rests (lane 0 is taken)', () => {
        const { s, T, lanes, room } = scene();
        expect(getStaffPlan(s).itineraries.find(it => it.staffId === 'K')!.end.fatigueBreak).toMatchObject({ start: expect.closeTo(T + 0.6, 6), end: expect.closeTo(T + 1.1, 6) });
        expect(lastRest(s, 'idle')).toMatchObject({ idle: true, end: T + 1 });
        expect(legsOf(s, 'Y').find(l => l.kind === 'stay' && l.job)).toMatchObject({ placeId: room.id, end: expect.closeTo(T + 0.75, 6) });
        expect(lastRest(s, 'Y')).toMatchObject({ idle: true, end: T + 1 });
        expect(counterFrom(s, 'Y', T)).toBeUndefined();
        for (const e of EDITS) {
          const t = T + e;
          const re = settleChanges(s, dismissStaff(s, 'K', t)!, t);
          expect(counterFrom(re, 'idle', t), `let go at ${clock(t, T)}: idle at the counter`).toMatchObject({ lane: lanes[0].key, start: expect.closeTo(t, 6) });
          expect(counterFrom(re, 'Y', t), `let go at ${clock(t, T)}: Y at the counter`).toBeUndefined();
          expect(lastRest(re, 'Y'), `let go at ${clock(t, T)}: Y after the room`).toMatchObject({ idle: true, end: T + 1 });
          for (const x of [t + 0.01, T + 0.76, T + 0.9, T + 0.99]) expect(atCounter(re, x), `let go at ${clock(t, T)}: counter at ${clock(x, T)}`).toEqual(['0:idle', '1:c1']);
        }
      });

      it('control: a far room built at the same times brings nobody anything: idle rests at the counter, Y rests after the room, and the counter is as planned', () => {
        const { s, T } = scene();
        for (const e of EDITS) {
          const t = T + e;
          const re = settleChanges(s, farRoom(s), t);
          for (const x of [t + 0.01, T + 0.76, T + 0.9, T + 0.99]) {
            expect(where(re, 'idle', x), `room at ${clock(t, T)}: idle at ${clock(x, T)}`).toBe(where(s, 'idle', x));
            expect(where(re, 'Y', x), `room at ${clock(t, T)}: Y at ${clock(x, T)}`).toBe(where(s, 'Y', x));
            expect(atCounter(re, x), `room at ${clock(t, T)}: counter at ${clock(x, T)}`).toEqual(atCounter(s, x));
          }
          expect(counterFrom(re, 'idle', t), `room at ${clock(t, T)}`).toBeUndefined();
          expect(counterFrom(re, 'Y', t), `room at ${clock(t, T)}`).toBeUndefined();
        }
      });
    });
  }
}
