// A housekeeper resting at home till a do-not-disturb party goes out, through a paused edit (StaffManager.planHour's
// home claim): the room she rests for stays hers against colleagues re-planned with her, and keeps its place in her
// queue; work a let-go hands her is new work (design: "Ordinary idle recovery can be interrupted by new work"), and an
// edit that brings nobody anything new leaves her plan as it was. See also idleRestReplan.test.ts.
import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, addFixture, demolishRoom } from '../src/simulation/HotelState.js';
import { getStaffPlan, replanStaff, syncStaff, planStaff } from '../src/simulation/StaffManager.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { dismissStaff, assignStaffSpecialty, hireCandidate, hiringCandidates } from '../src/simulation/StaffHiring.js';
import { hourStart, positionAt, makeWalk, makeStay, sameTile } from '../src/simulation/Movement.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { routeToStreet, routeFromStreet, findRoute } from '../src/simulation/Layout.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { TRAVEL, GUEST_HOUSEKEEPING } from '../src/config/balance.js';
import { awayStretches } from '../src/simulation/CleaningPreference.js';
import { namedFrontDesk, staffRate } from '../src/simulation/StaffProfiles.js';
import { FRONT_DESK_STAFF, STAFF_FATIGUE, STAFF_SPECIALTIES } from '../src/config/staff.js';
import { fatigueAt } from '../src/simulation/StaffFatigue.js';
import { reseatLanes, lanesOf } from '../src/simulation/DeskQueue.js';
import type { Guest, HotelState, Leg, Room, StaffMember, StayLeg, TilePos, WalkLeg } from '../src/simulation/types.js';

// A do-not-disturb room a let-go hands her is new work.
{
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A housekeeper (high stamina, fresh) standing in `room`. */
  function keeper(id: string, room: Room, abs: number, speed: keyof typeof SPEEDS): StaffMember {
    const p = SPEEDS[speed];
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: roomTile(room),
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: abs } } as StaffMember;
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
   * 12:33-13:03; 0.1h of daily cleaning each. hk-c (slow, first on the roster) rests at the base till 12:26 and cleans
   * D2 at 12:38-12:48; hk-b (fast) rests at the base till 12:40 and cleans D1 at 12:50-12:54.
   */
  function scene(): { s: HotelState; T: number; D1: Room; D2: Room } {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
    const abs = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2 },
      staffRoster: [keeper('hk-c', s.rooms[2], abs, 'slow'), keeper('hk-b', s.rooms[2], abs, 'fast')] };
    const T = hourStart(s), [D1, D2] = s.rooms;
    s = { ...s, guests: [goingOut(s, D1, T + 0.75, T + 1, 'g1'), goingOut(s, D2, T + 0.55, T + 1.05, 'g2')],
      rooms: s.rooms.map(r => (r.id === D1.id ? { ...r, status: 'occupied' as const, guestId: 'g1', dailyCleanHoursRemaining: 0.1 }
        : r.id === D2.id ? { ...r, status: 'occupied' as const, guestId: 'g2', dailyCleanHoursRemaining: 0.1 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, D1, D2 };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** The day each room was last given its daily clean, after playing on two hours. */
  const cleanedDay = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };

  describe('A do-not-disturb room handed over by a let-go is new work for the one resting at home for hers', () => {
    it('hk-c let go between 12:12 and 12:24: hk-b gives up her rest for D2, its party going out at 12:33, and still cleans D1', () => {
      const { s, T, D1, D2 } = scene();
      expect(jobsOf(s, 'hk-c').map(l => l.placeId)).toEqual([D2.id]);
      expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D1.id]);
      const [home] = restsOf(s, 'hk-b');
      expect(home).toMatchObject({ idle: true, at: BASE });
      expect(home.end).toBeCloseTo(T + 0.66, 3); // she sets off for D1 at 12:40
      for (const dt of [0.2, 0.25, 0.3, 0.333, 0.36, 0.4]) {
        const t = T + dt;
        const re = settleChanges(s, dismissStaff(s, 'hk-c', t)!, t);
        // D2 as its party goes out (12:33-13:03), then D1 as hers does (12:45-13:00)
        const [onD2, onD1] = jobsOf(re, 'hk-b');
        expect([onD2?.placeId, onD1?.placeId]).toEqual([D2.id, D1.id]);
        expect(onD2.start).toBeGreaterThanOrEqual(T + 0.55);
        expect(onD2.start).toBeLessThan(T + 0.75); // not after her rest till 12:40 and D1 first
        expect(onD1.start).toBeGreaterThanOrEqual(T + 0.75);
        // by 12:37 she's at D2, not still resting at the base for D1
        expect(where(re, 'hk-b', T + 0.62)).not.toMatch(/rest/);
        expect(cleanedDay(re, [D1, D2])).toEqual([3, 3]);
      }
    });

    it('control: an edit at 12:20 that hands her nothing (a paused edit, or a room built far away) leaves her resting at home till 12:40, and both rooms are cleaned as planned', () => {
      const { s, T, D1, D2 } = scene();
      const t = T + 0.333;
      for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t)]) {
        for (const id of ['hk-b', 'hk-c']) for (const x of [0.34, 0.5, 0.62, 0.7, 0.85, 0.95]) expect(where(re, id, T + x)).toBe(where(s, id, T + x));
        expect(jobsOf(re, 'hk-b').map(l => l.placeId)).toEqual([D1.id]);
        expect(jobsOf(re, 'hk-c').map(l => l.placeId)).toEqual([D2.id]);
        expect(cleanedDay(re, [D1, D2])).toEqual([3, 3]);
      }
    });
  });
}

// Her own room keeps its place in her queue: one that closes sooner still comes first, so a handed room doesn't cost it its daily clean.
{
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A housekeeper (high stamina, fresh) standing at `at`. */
  function keeper(id: string, at: TilePos, abs: number, speed: keyof typeof SPEEDS, specialty: 'room_attendant' | 'turnover_runner'): StaffMember {
    const p = SPEEDS[speed];
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
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
   * 12:00 on day 3, three standard rooms on row 2 from x = 3: D1 (3, 2) and D2 (4, 2), each a do-not-disturb party
   * going out (`d1`, `d2`: leave and back, hours after 12:00) and 0.1h of daily cleaning. hk-c (slow room attendant,
   * first on the roster) starts at (7, 1); hk-b (fast turnover runner) at the base (1, 4).
   */
  function scene(d1: [number, number], d2: [number, number]): { s: HotelState; T: number; D1: Room; D2: Room } {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
    const abs = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2 },
      staffRoster: [keeper('hk-c', { gridX: 7, gridY: 1, floor: 0 }, abs, 'slow', 'room_attendant'), keeper('hk-b', BASE, abs, 'fast', 'turnover_runner')] };
    const T = hourStart(s), [D1, D2] = s.rooms;
    s = { ...s, guests: [goingOut(s, D1, T + d1[0], T + d1[1], 'g1'), goingOut(s, D2, T + d2[0], T + d2[1], 'g2')],
      rooms: s.rooms.map(r => (r.id === D1.id ? { ...r, status: 'occupied' as const, guestId: 'g1', dailyCleanHoursRemaining: 0.1 }
        : r.id === D2.id ? { ...r, status: 'occupied' as const, guestId: 'g2', dailyCleanHoursRemaining: 0.1 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, D1, D2 };
  }

  /**
   * The review's scene. D1's party is out 12:37-12:44, D2's 12:28-13:08. hk-c cleans D2 at 12:29-12:39; hk-b rests at
   * the base till 12:28 and cleans D1 at 12:38-12:42. On her own she fits both only D1 first (12:38-12:42, then D2
   * 12:48-12:52): D2 first, she'd be at D1 after its party is back.
   */
  const review = () => scene([0.55, 0.8], [0.4, 1.2]);

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** The day each room was last given its daily clean, after playing on two hours. */
  const cleanedDay = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** The player lets hk-c go at t, as the game does it. */
  const letGo = (s: HotelState, t: number) => settleChanges(s, dismissStaff(s, 'hk-c', t)!, t);

  describe('Resting at home for her own do-not-disturb room, handed another by a let-go: hers, closing sooner, is not lost to it', () => {
    it('hk-c let go between 12:13 and 12:27: hk-b rests on at home till 12:28 and cleans D1 just as planned, then D2, and both rooms are cleaned', () => {
      const { s, T, D1, D2 } = review();
      expect(awayStretches(s.guests[0], D1).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.61, 0.74]]);
      expect(awayStretches(s.guests[1], D2).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.46, 1.14]]);
      expect(jobsOf(s, 'hk-c').map(l => l.placeId)).toEqual([D2.id]);
      expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D1.id]);
      expect(restsOf(s, 'hk-b')[0]).toMatchObject({ at: BASE, start: T });
      expect(restsOf(s, 'hk-b')[0].end).toBeCloseTo(T + 0.46, 3);
      expect(cleanedDay(s, [D1, D2])).toEqual([3, 3]);
      for (const dt of [0.21, 0.25, 0.3, 0.35, 0.4, 0.45]) {
        const re = letGo(s, T + dt);
        // D1 as its party goes out (12:37-12:44), then D2 (out till 13:08)
        expect(jobsOf(re, 'hk-b').map(l => l.placeId)).toEqual([D1.id, D2.id]);
        // through D1 her plan is as it was: at home till 12:28, not off to stand at D2's door
        for (const x of [dt + 0.01, 0.45, 0.55, 0.62, 0.68]) expect(where(re, 'hk-b', T + x)).toBe(where(s, 'hk-b', T + x));
        expect(cleanedDay(re, [D1, D2])).toEqual([3, 3]);
      }
    });

    it('control: the handed room closing before hers (D2 out 12:28-12:41, D1 out 12:43-12:53) still gets her up at once, and both rooms are cleaned', () => {
      // hk-c cleans D2 at 12:29-12:39; hk-b rests at the base till 12:34 and cleans D1 at 12:44-12:48
      const { s, T, D1, D2 } = scene([0.65, 0.95], [0.4, 0.75]);
      expect(jobsOf(s, 'hk-c').map(l => l.placeId)).toEqual([D2.id]);
      expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D1.id]);
      expect(restsOf(s, 'hk-b')[0].end).toBeCloseTo(T + 0.56, 3);
      for (const dt of [0.1, 0.2, 0.3]) {
        const re = letGo(s, T + dt);
        // D2 as its party goes out, before her old set-off at 12:34; then D1 as hers does
        const [onD2, onD1] = jobsOf(re, 'hk-b');
        expect([onD2?.placeId, onD1?.placeId]).toEqual([D2.id, D1.id]);
        expect(onD2.start).toBeLessThan(T + 0.56);
        expect(where(re, 'hk-b', T + 0.45)).not.toMatch(/rest/);
        expect(onD1.start).toBeGreaterThanOrEqual(T + 0.71);
        expect(cleanedDay(re, [D1, D2])).toEqual([3, 3]);
      }
    });
  });
}

// The same against a handed room that isn't do-not-disturb.
{
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  type Specialty = 'room_attendant' | 'turnover_runner';

  /** A housekeeper (high stamina, fresh) standing at `at`. */
  function keeper(id: string, at: TilePos, abs: number, speed: keyof typeof SPEEDS, specialty: Specialty): StaffMember {
    const p = SPEEDS[speed];
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: abs } } as StaffMember;
  }

  const guest = (id: string, housekeeping: 'dnd' | 'standard') => ({ id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55,
    checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
    profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping } });

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { ...guest(id, 'dnd'), tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /**
   * 12:00 on day 3, three standard rooms on row 2 from x = 3. R (3, 2): a do-not-disturb party going out 12:30-12:45,
   * 0.08h of daily cleaning. X (4, 2): 0.3h of work, either the daily clean of a standard guest staying in or a turnover.
   * hk-c (slow turnover runner, first on the roster) starts at (7, 1) and cleans X at 12:07-12:35; hk-b (fast, `b`)
   * rests at the base (1, 4) till 12:25 and cleans R at 12:35-12:39.
   */
  function scene(x: 'daily' | 'turnover', b: Specialty): { s: HotelState; T: number; R: Room; X: Room } {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
    const abs = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2 },
      staffRoster: [keeper('hk-c', { gridX: 7, gridY: 1, floor: 0 }, abs, 'slow', 'turnover_runner'), keeper('hk-b', BASE, abs, 'fast', b)] };
    const T = hourStart(s), [R, X] = s.rooms;
    s = { ...s, guests: [goingOut(s, R, T + 0.5, T + 0.75, 'g-r'), ...(x === 'daily' ? [{ ...guest('g-x', 'standard'), trip: null } as unknown as Guest] : [])],
      rooms: s.rooms.map(r => (r.id === R.id ? { ...r, status: 'occupied' as const, guestId: 'g-r', dailyCleanHoursRemaining: 0.08 }
        : r.id !== X.id ? r : x === 'daily' ? { ...r, status: 'occupied' as const, guestId: 'g-x', dailyCleanHoursRemaining: 0.3 }
          : { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.3 })) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, R, X };
  }

  /** The two ways a handed room comes after hers in her queue: a standard daily for a turnover runner (do-not-disturb dailies first), a turnover for a room attendant (dailies first). */
  const AFTER_HERS = [['daily', 'turnover_runner'], ['turnover', 'room_attendant']] as const;

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** After playing on two hours: the day R last had its daily clean, and X done (its daily clean today, or turned round). */
  const outcome = (s: HotelState, R: Room, X: Room, x: 'daily' | 'turnover') => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    const r = st.rooms.find(q => q.id === R.id)!, xr = st.rooms.find(q => q.id === X.id)!;
    return { R: r.lastDailyCleanDay ?? 0, X: x === 'daily' ? xr.lastDailyCleanDay === st.day : xr.status === 'vacant' };
  };
  /** The player lets hk-c go at t, as the game does it. */
  const letGo = (s: HotelState, t: number) => settleChanges(s, dismissStaff(s, 'hk-c', t)!, t);

  describe('Resting at home for her own do-not-disturb room, handed a room that isn\'t: one after hers in her queue waits till hers is done', () => {
    it('hk-c let go between 12:10 and 12:24: hk-b rests on at home till 12:25 and cleans R as planned, then X, and both rooms are done', () => {
      for (const [x, b] of AFTER_HERS) {
        const { s, T, R, X } = scene(x, b);
        expect(awayStretches(s.guests[0], R).map(([a, c]) => [+(a - T).toFixed(2), +(c - T).toFixed(2)])).toEqual([[0.56, 0.69]]);
        expect(jobsOf(s, 'hk-c').map(l => l.placeId)).toEqual([X.id]);
        expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([R.id]);
        expect(restsOf(s, 'hk-b')[0]).toMatchObject({ idle: true, at: BASE, start: T });
        expect(restsOf(s, 'hk-b')[0].end).toBeCloseTo(T + 0.41, 3); // she sets off for R at 12:25
        expect(outcome(s, R, X, x)).toEqual({ R: 3, X: true });
        for (const dt of [0.17, 0.2, 0.25, 0.3, 0.35, 0.4]) {
          const re = letGo(s, T + dt);
          // R as its party goes out (12:35-12:39), then X (from 12:44)
          expect(jobsOf(re, 'hk-b').map(l => [l.placeId, l.job])).toEqual([[R.id, 'daily'], [X.id, x]]);
          // through R her plan is as it was: at home till 12:25, not off to X
          for (const at of [dt + 0.01, 0.4, 0.5, 0.6, 0.63]) expect(where(re, 'hk-b', T + at)).toBe(where(s, 'hk-b', T + at));
          expect(outcome(re, R, X, x)).toEqual({ R: 3, X: true });
        }
      }
    });

    it('control: an edit at 12:15 that hands her nothing (a paused edit, or a room built far away) leaves both plans as they were', () => {
      for (const [x, b] of AFTER_HERS) {
        const { s, T, R, X } = scene(x, b);
        const t = T + 0.25;
        for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t)]) {
          for (const id of ['hk-b', 'hk-c']) for (const at of [0.26, 0.4, 0.5, 0.6, 0.7, 0.9]) expect(where(re, id, T + at)).toBe(where(s, id, T + at));
          expect(jobsOf(re, 'hk-b').map(l => l.placeId)).toEqual([R.id]);
          expect(outcome(re, R, X, x)).toEqual({ R: 3, X: true });
        }
      }
    });

    it('control: a handed turnover, ahead of her room in a turnover runner\'s queue, still gets her up at once and turned round', () => {
      const { s, T, X } = scene('turnover', 'turnover_runner');
      expect(restsOf(s, 'hk-b')[0].end).toBeCloseTo(T + 0.41, 3);
      for (const dt of [0.17, 0.25, 0.3, 0.4]) {
        const t = T + dt;
        const re = letGo(s, t);
        // off to X at once, not resting at home till 12:25
        const next = legsOf(re, 'hk-b').find(l => l.end > t + 1e-9)!;
        expect(next).toMatchObject({ kind: 'walk', start: t });
        expect(jobsOf(re, 'hk-b')[0]).toMatchObject({ placeId: X.id, job: 'turnover' });
        expect(where(re, 'hk-b', t + 0.02)).not.toMatch(/rest/);
        let st = re;
        for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
        expect(st.rooms.find(r => r.id === X.id)!.status).toBe('vacant');
      }
    });
  });
}

// The room she rests for is kept for her only while she can still get to it.
{
  const PACE = TRAVEL.guestHoursPerTile;

  /** A housekeeper standing at `at`, keeping `roomId` if given, at 10 fatigue as of the hour's start. */
  function keeper(id: string, at: TilePos, abs: number, roomId?: string): StaffMember {
    return { id, serial: id.charCodeAt(0), name: id, role: 'housekeeper', dailyWage: 70, at, ...(roomId ? { roomId } : {}),
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: 100, lateDays: 0, absentDays: 0, fatigue: 10, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb party walking out of `room` at `leave` and back in at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id: 'd', name: 'd', budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)!.legs;
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Whether someone's plan from t to the hour's end is the same in two states (sampled every 0.005h). */
  const sameFrom = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };

  /**
   * 12:00 on day 3: a row of rooms on row 2 from x 0 to 8 (R at x 3, its door down onto the bottom corridor; A at x 7, its
   * door up onto the top one), so the hallway at (9, 2)/(9, 3) is the only way between the two corridors. X, at the base
   * (1, 4), keeps A (a 2h turnover); m, at (9, 1) with nothing else, walks down to the base by 12:20 and rests there till she
   * sets off for R, whose party goes out at `leave` (back at `back`). `order`: who is first on the roster; `named`: a named
   * front desk too (so Settle re-plans twice at the edit).
   */
  function scene(order: 'X-first' | 'm-first', leave: number, back: number, named: boolean) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 0; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, x === 3 ? 'down' : 'up')!;
    const R = s.rooms.find(r => r.gridX === 3)!, A = s.rooms.find(r => r.gridX === 7)!;
    const abs = 2 * 24 + 12;
    const X = keeper('X', { gridX: 1, gridY: 4, floor: 0 }, abs, A.id), m = keeper('m', { gridX: 9, gridY: 1, floor: 0 }, abs);
    s = { ...s, day: 3, hour: 12, noiseSources: [], guests: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2, maintenanceWorkers: 0 },
      staffRoster: order === 'X-first' ? [X, m] : [m, X],
      rooms: s.rooms.map(r => (r.id === A.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 2 } : r)) };
    if (named) s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, R, T + leave, T + back)],
      rooms: s.rooms.map(r => (r.id === R.id ? { ...r, status: 'occupied' as const, guestId: 'd', dailyCleanHoursRemaining: 0.15 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan({ ...s, staffPlan: null }) }, R, A, T };
  }
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  /** The party out 12:45 to 13:12 (she cleans R 12:50 to 12:59), or 12:48 to 16:00 (12:53 on into the next hour). */
  const WINDOWS = [[0.75, 1.2], [0.8, 4]] as const;

  describe('Resting at home for a do-not-disturb room: the room is kept for her only while she can still get to it', () => {
    it('a room built at 12:01 across the only way to it: the colleague who can still get there cleans it as the party goes out, whoever is first on the roster', () => {
      for (const named of [false, true]) for (const order of ['X-first', 'm-first'] as const) for (const [leave, back] of WINDOWS) {
        const { s, R, A, T } = scene(order, leave, back, named);
        // as planned: X on A all hour; m rests at the base, then cleans R as the party goes out
        expect(jobsOf(s, 'X').map(l => l.placeId)).toEqual([A.id]);
        expect(jobsOf(s, 'm').map(l => l.placeId)).toEqual([R.id]);
        expect(legsOf(s, 'm').find(l => l.kind === 'stay' && l.activity === 'rest')).toMatchObject({ at: BASE });
        // 12:01: a room built at (9, 2) closes the way between the corridors. m (still up top) can't get to R any more, and X
        // can't get to A, but X can still get to R
        const t = T + 1 / 60;
        const re = settleChanges(s, addRoom(s, 'standard', 9, 2, 0, 'down')!, t);
        expect(jobsOf(re, 'm').filter(l => l.end > t)).toEqual([]);
        const onR = jobsOf(re, 'X').filter(l => l.end > t);
        expect(onR.map(l => l.placeId)).toEqual([R.id]);
        expect(onR[0].start).toBeGreaterThanOrEqual(T + leave);
        expect(onR[0].start).toBeLessThan(T + 1);
        // by 13:00 R's daily clean is under way, and with the party back at 13:12 it's done before they're in
        const st = tickSimulation(re, new PRNG(5)).state;
        const room = st.rooms.find(r => r.id === R.id)!;
        expect(room.dailyCleanHoursRemaining).toBeLessThan(0.15 - 0.1);
        if (back < 1.25) {
          expect(room.lastDailyCleanDay).toBe(3);
          expect(st.guests.find(g => g.id === 'd')!.cleans).toMatchObject({ done: 1, missed: 0 });
        }
      }
    });

    it('control: with her way to it still open (the room built at 12:01 on A\'s doorway instead), it stays hers: she rests at the base and cleans it as planned, and X, cut off from A, doesn\'t take it', () => {
      for (const order of ['X-first', 'm-first'] as const) for (const [leave, back] of WINDOWS) {
        const { s, R, A, T } = scene(order, leave, back, false);
        const t = T + 1 / 60;
        const re = settleChanges(s, addRoom(s, 'standard', 7, 1, 0, 'left')!, t);
        expect(jobsOf(re, 'X').filter(l => l.end > t)).toEqual([]);
        expect(sameFrom(re, s, 'm', t)).toBe(true);
        expect(jobsOf(re, 'm').filter(l => l.end > t).map(l => l.placeId)).toEqual([R.id]);
        const st = tickSimulation(re, new PRNG(5)).state;
        expect(st.rooms.find(r => r.id === R.id)!.dailyCleanHoursRemaining).toBeLessThan(0.15 - 0.1);
        expect(st.rooms.find(r => r.id === A.id)!.cleaningHoursRemaining).toBe(2);
      }
    });
  });
}

// Once new work has got her up, the room she was resting for is just another room in her queue; a room a let-go was on her way to at the hour's end is new work; an edit with nothing new leaves her plan as it was, even with a room her plan had after hers already open.
{
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A turnover runner (high stamina, fresh) standing at `at`. */
  function keeper(id: string, at: TilePos, abs: number, speed: keyof typeof SPEEDS): StaffMember {
    const p = SPEEDS[speed];
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back in at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** A do-not-disturb party now in `room` (out `leave` to `back`, hours after the hour's start), with `hours` of daily cleaning. */
  function dndRoom(s: HotelState, room: Room, leave: number, back: number, hours: number, id: string): HotelState {
    const T = hourStart(s);
    return { ...s, guests: [...s.guests, goingOut(s, room, T + leave, T + back, id)],
      rooms: s.rooms.map(r => (r.id === room.id ? { ...r, status: 'occupied' as const, guestId: id, dailyCleanHoursRemaining: hours } : r)) };
  }

  const itineraryOf = (s: HotelState, id: string) => getStaffPlan(s).itineraries.find(it => it.staffId === id)!;
  const legsOf = (s: HotelState, id: string): Leg[] => itineraryOf(s, id).legs;
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what (rest rate and seat included). */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}@${p.leg.restRate ?? ''}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Whether someone's plan from t to the hour's end is the same in two states (sampled every 0.005h). */
  const sameFrom = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  /** After playing on two hours: each room's status and the day it last had its daily clean. */
  const outcome = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => { const q = st.rooms.find(x => x.id === r.id)!; return { status: q.status, cleaned: q.lastDailyCleanDay ?? 0 }; });
  };
  /** The player lets someone go at t, as the game does it. */
  const letGo = (s: HotelState, id: string, t: number) => settleChanges(s, dismissStaff(s, id, t)!, t);

  // Got up for new work, the room she was resting for is just another room in her queue.
  {
    /**
     * 12:00 on day 3, the front desk named (so a let-go re-plans once). Three standard rooms on row 2 from x = 3, doors
     * up: X (3, 2), 0.7h of work, either a turnover or the daily clean of a do-not-disturb party out all hour; K (4, 2), a
     * do-not-disturb party out 12:48-12:57, 0.05h; D1 (5, 2), a party out 12:30-13:32, 0.4h. hk-c (slow, first on the
     * roster) starts in X and is on it all hour. hk-b (fast) rests at the base (1, 4) till 12:17, cleans D1 12:32-12:48,
     * then K 12:53-12:55: K closes first, so it's ahead of D1 in her queue, but its party isn't out yet when she sets off.
     */
    function scene(x: 'turnover' | 'dnd'): { s: HotelState; T: number; X: Room; K: Room; D1: Room } {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
      const abs = 2 * 24 + 12, [X, K, D1] = s.rooms;
      s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2 },
        staffRoster: [keeper('hk-c', roomTile(X), abs, 'slow'), keeper('hk-b', BASE, abs, 'fast')] };
      s = syncStaff(s);
      s = x === 'dnd' ? dndRoom(s, X, -0.2, 1.5, 0.7, 'gX')
        : { ...s, rooms: s.rooms.map(r => (r.id === X.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.7 } : r)) };
      s = dndRoom(dndRoom(s, K, 0.74, 1.01, 0.05, 'gK'), D1, 0.44, 1.6, 0.4, 'gD');
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T: hourStart(s), X, K, D1 };
    }
    const away = (s: HotelState, T: number, g: string) => awayStretches(s.guests.find(q => q.id === g)!, s.rooms.find(r => r.guestId === g)!)
      .map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)]);

    describe('Got up for new work by a let-go, she\'s no longer resting at home for her do-not-disturb room: the rest of her hour goes in her queue\'s order', () => {
      for (const x of ['turnover', 'dnd'] as const) {
        it(`hk-c let go between 12:03 and 12:15 with X ${x === 'turnover' ? 'a turnover' : 'a do-not-disturb clean'} under way: hk-b takes over X, then K as its party goes out (it closes first), then D1, and all three are done`, () => {
          const { s, T, X, K, D1 } = scene(x);
          expect(away(s, T, 'gK')).toEqual([[0.8, 0.95]]);
          expect(away(s, T, 'gD')).toEqual([[0.5, 1.54]]);
          // as planned: hk-c on X all hour; hk-b rests at the base till 12:17, then D1, then K
          expect(jobsOf(s, 'hk-c').map(l => l.placeId)).toEqual([X.id]);
          expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D1.id, K.id]);
          expect(restsOf(s, 'hk-b')[0]).toMatchObject({ idle: true, at: BASE, start: T });
          expect(restsOf(s, 'hk-b')[0].end).toBeCloseTo(T + 0.29, 3);
          for (const dt of [0.05, 0.1, 0.15, 0.2, 0.25]) {
            const t = T + dt;
            const re = letGo(s, 'hk-c', t);
            // X (done by 12:47), K as its party goes out (12:48), then D1 (out till 13:32; on into the next hour): not D1
            // first, as if still resting for it
            const jobs = jobsOf(re, 'hk-b').filter(l => l.end > t);
            expect([...new Set([...jobs.map(l => l.placeId), itineraryOf(re, 'hk-b').end.roomId])]).toEqual([X.id, K.id, D1.id]);
            const onK = jobs.find(l => l.placeId === K.id)!;
            expect(onK.start).toBeGreaterThanOrEqual(T + 0.8);
            expect(onK.start).toBeLessThan(T + 0.9);
            // K's party is out only till 12:57: done now, or not at all; D1 runs on into the next hour
            const [rx, rk, rd] = outcome(re, [X, K, D1]);
            expect(x === 'turnover' ? rx.status : rx.cleaned).toBe(x === 'turnover' ? 'vacant' : 3);
            expect([rk.cleaned, rd.cleaned]).toEqual([3, 3]);
          }
        });
      }

      it('control: a paused edit at 12:10, nobody let go, leaves both plans as they were, and all three rooms are done', () => {
        for (const x of ['turnover', 'dnd'] as const) {
          const { s, T, X, K, D1 } = scene(x);
          const t = T + 1 / 6;
          const re = replanStaff(s, t);
          for (const id of ['hk-b', 'hk-c']) expect(sameFrom(re, s, id, t)).toBe(true);
          const [rx, rk, rd] = outcome(re, [X, K, D1]);
          expect(x === 'turnover' ? rx.status : rx.cleaned).toBe(x === 'turnover' ? 'vacant' : 3); // (hk-c on X into the next hour)
          expect([rk.cleaned, rd.cleaned]).toEqual([3, 3]);
        }
      });
    });
  }

  // A room a let-go was on her way to at the hour's end (no clean of it yet this hour) is new work too.
  {
    /**
     * 12:00 on day 3, the front desk named. Two standard rooms on row 2 from x = 3, doors up: R (3, 2), a do-not-disturb
     * party out 12:59-13:07, 0.05h of daily cleaning; D1 (4, 2), a party out 12:51-13:27, 0.4h. hk-c (slow, first on the
     * roster) can't fit D1 in its party's time out; she rests at the base (1, 4) till 12:50 and walks to R's door, there
     * as its party goes out, stepping in as the hour ends: R is only where she's headed at 13:00. hk-b (fast) rests at
     * the base till 12:40 and cleans D1 from 12:53.
     */
    function scene(): { s: HotelState; T: number; R: Room; D1: Room } {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
      for (let i = 0; i < 2; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
      const abs = 2 * 24 + 12, [R, D1] = s.rooms;
      s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2 },
        staffRoster: [keeper('hk-c', BASE, abs, 'slow'), keeper('hk-b', BASE, abs, 'fast')] };
      s = dndRoom(dndRoom(syncStaff(s), R, 0.92, 1.18, 0.05, 'gR'), D1, 0.79, 1.51, 0.4, 'gD');
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T: hourStart(s), R, D1 };
    }

    describe('Resting at home for her do-not-disturb room, handed one a let-go was on her way to at the hour\'s end: it\'s new work', () => {
      it('hk-c let go between 12:35 and 12:40: hk-b gives up her rest and is at R\'s door as its party goes out, and R and D1 are both cleaned', () => {
        const { s, T, R, D1 } = scene();
        expect(awayStretches(s.guests[0], R).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.98, 1.12]]);
        // as planned: hk-c cleans nothing this hour, on her way into R as it ends; hk-b rests at the base, then D1
        expect(jobsOf(s, 'hk-c')).toEqual([]);
        expect(itineraryOf(s, 'hk-c').end.roomId).toBe(R.id);
        expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D1.id]);
        expect(restsOf(s, 'hk-b')[0]).toMatchObject({ idle: true, at: BASE, start: T });
        expect(restsOf(s, 'hk-b')[0].end).toBeCloseTo(T + 0.67, 3);
        expect(outcome(s, [R, D1]).map(r => r.cleaned)).toEqual([3, 3]);
        for (const dt of [0.58, 0.6, 0.63, 0.66]) {
          const re = letGo(s, 'hk-c', T + dt);
          // off at once to R's door (3, 1), there by 12:49 for its party going out at 12:59, not resting at the base for D1
          expect(where(re, 'hk-b', T + dt + 0.005)).toMatch(/walk/);
          expect(where(re, 'hk-b', T + 0.9)).toBe('3.000,1.000,0 wait@/');
          expect(itineraryOf(re, 'hk-b').end.roomId).toBe(R.id);
          // R as its party goes out (it's out only till 13:07), then D1 (out till 13:27)
          expect(outcome(re, [R, D1]).map(r => r.cleaned)).toEqual([3, 3]);
        }
      });
    });
  }

  // An edit that brings her nothing new leaves her plan as it was, though a room her plan had after hers is already open.
  {
    /**
     * 12:00 on day 3, the front desk named: a row of rooms on row 2 from x 0 to 8, so the hallway at (9, 2)/(9, 3) is the
     * only way between the top corridor and the bottom one. D1 at x 2, its door down onto the bottom corridor beside the
     * base (1, 4): a do-not-disturb party out 12:49-13:12; K at x 3, its door up onto the top corridor: a party out
     * 12:51-14:00; 0.08h of daily cleaning each (D1, closing first, is first in her queue). m (fast), alone, starts up
     * top at (4, 1), right by K's door: with neither party going out for a while, she walks down round to the base by
     * 12:29 to be by D1 as its party goes out first, rests there till 12:45, cleans D1 12:50-12:54, and heads round to
     * K for the next hour.
     */
    function scene(): { s: HotelState; T: number; D1: Room; K: Room } {
      let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
      for (let x = 0; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, x === 2 ? 'down' : 'up')!;
      const D1 = s.rooms.find(r => r.gridX === 2)!, K = s.rooms.find(r => r.gridX === 3)!;
      const abs = 2 * 24 + 12;
      s = { ...s, day: 3, hour: 12, noiseSources: [], guests: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
        staffRoster: [keeper('m', { gridX: 4, gridY: 1, floor: 0 }, abs, 'fast')] };
      s = dndRoom(dndRoom(syncStaff(s), D1, 0.75, 1.26, 0.08, 'gD'), K, 0.79, 2.06, 0.08, 'gK');
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T: hourStart(s), D1, K };
    }

    describe('Heading home (or resting there) for her do-not-disturb room, with the room her plan had next already open: an edit with nothing new leaves her plan as it was', () => {
      it('a paused edit, or a room built far away, between 12:18 and 12:30 (on her way home, or there): she still rests at the base till 12:45, cleans D1, and heads on to K, and both rooms are cleaned', () => {
        const { s, T, D1, K } = scene();
        expect(awayStretches(s.guests[0], D1).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.81, 1.2]]);
        expect(awayStretches(s.guests[1], K).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.85, 2]]);
        const [home] = restsOf(s, 'm');
        expect(home).toMatchObject({ idle: true, at: BASE });
        expect(home.start).toBeCloseTo(T + 0.48, 3);
        expect(home.end).toBeCloseTo(T + 0.75, 3);
        expect(jobsOf(s, 'm').map(l => l.placeId)).toEqual([D1.id]);
        expect(itineraryOf(s, 'm').end.roomId).toBe(K.id);
        expect(outcome(s, [D1, K]).map(r => r.cleaned)).toEqual([3, 3]);
        // (12:18-12:28 she's on her way home, 12:29-12:30 at the base: D1's party isn't out for another 20 minutes or more,
        // while K's is out by the time she could get round to it, and from where she is on her way, its set-off comes first)
        for (const dt of [0.3, 0.34, 0.38, 0.41, 0.44, 0.46, 0.49]) {
          const t = T + dt;
          for (const re of [replanStaff(s, t), settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t)]) {
            // (still walking, the way home re-planned can be another as short: the rest there is the same)
            if (dt >= 0.41) expect(sameFrom(re, s, 'm', t)).toBe(true);
            const rest = restsOf(re, 'm').find(l => l.end > t)!;
            expect(rest).toMatchObject({ idle: true, at: BASE });
            expect(rest.end).toBeCloseTo(home.end, 9);
            expect(jobsOf(re, 'm').filter(l => l.end > t).map(l => l.placeId)).toEqual([D1.id]);
            expect(itineraryOf(re, 'm').end.roomId).toBe(K.id);
            expect(outcome(re, [D1, K]).map(r => r.cleaned)).toEqual([3, 3]);
          }
        }
      });
    });
  }
}

// A room a let-go left half-cleaned is new work only at the edit that lets her colleague go: by the next, it's a room her plan has later.
{
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A turnover runner (high stamina, fresh) standing at `at`. */
  function keeper(id: string, at: TilePos, abs: number, speed: keyof typeof SPEEDS): StaffMember {
    const p = SPEEDS[speed];
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back in at `back`. */
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
   * 12:00 on day 3, three standard rooms on row 2 from x = 3. D1 (3, 2): a do-not-disturb party out 12:37-12:50, 0.1h of
   * daily cleaning. R (4, 2): a do-not-disturb party out 12:04-13:08, 0.37h of it. hk-c (slow, first on the roster) starts
   * at (7, 1) and cleans R at 12:07-12:42; hk-b (fast) rests at the base (1, 4) till 12:28 and cleans D1 at 12:38-12:42.
   * `named`: a named front desk too (so Settle re-plans twice when the desk's lanes change).
   */
  function scene(named: boolean): { s: HotelState; T: number; D1: Room; R: Room } {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
    const abs = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2 },
      staffRoster: [keeper('hk-c', { gridX: 7, gridY: 1, floor: 0 }, abs, 'slow'), keeper('hk-b', BASE, abs, 'fast')] };
    if (named) s = syncStaff(s);
    const T = hourStart(s), [D1, R] = s.rooms;
    s = { ...s, guests: [goingOut(s, D1, T + 0.55, T + 0.9, 'g1'), goingOut(s, R, T, T + 1.2, 'g2')],
      rooms: s.rooms.map(r => (r.id === D1.id ? { ...r, status: 'occupied' as const, guestId: 'g1', dailyCleanHoursRemaining: 0.1 }
        : r.id === R.id ? { ...r, status: 'occupied' as const, guestId: 'g2', dailyCleanHoursRemaining: 0.37 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan({ ...s, staffPlan: null }) }, T, D1, R };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** The day each room was last given its daily clean, after playing on two hours. */
  const cleanedDay = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** The player lets hk-c go at t, as the game does it. */
  const letGo = (s: HotelState, t: number) => settleChanges(s, dismissStaff(s, 'hk-c', t)!, t);
  /** The player makes hk-b a room attendant at t, as the game does it. */
  const makeAttendant = (s: HotelState, t: number) => settleChanges(s, assignStaffSpecialty(s, 'hk-b', 'room_attendant')!, t);

  describe('A room a let-go left half-cleaned, handed to the one resting at home for hers: new work only at the let-go', () => {
    it('hk-c let go mid-clean at 12:15-12:24, then hk-b made a room attendant before her set-off: she still rests at home, cleans D1, then R, and both rooms are cleaned', () => {
      for (const named of [false, true]) {
        const { s, T, D1, R } = scene(named);
        expect(awayStretches(s.guests[0], D1).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.61, 0.84]]);
        expect(awayStretches(s.guests[1], R).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.06, 1.14]]);
        expect(jobsOf(s, 'hk-c').map(l => l.placeId)).toEqual([R.id]);
        expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([D1.id]);
        expect(restsOf(s, 'hk-b')[0]).toMatchObject({ idle: true, at: BASE, start: T });
        expect(restsOf(s, 'hk-b')[0].end).toBeCloseTo(T + 0.46, 3);
        for (const dt of [0.25, 0.3, 0.4]) {
          const t1 = T + dt;
          const re = letGo(s, t1);
          // hk-c was mid-way through R: it's handed to hk-b, after D1 (whose party is back sooner) as her queue has it
          const cut = jobsOf(re, 'hk-c');
          expect(cut.map(l => l.placeId)).toEqual([R.id]);
          expect(cut[0].end).toBeCloseTo(t1, 9);
          expect(jobsOf(re, 'hk-b').filter(l => l.end > t1).map(l => l.placeId)).toEqual([D1.id, R.id]);
          for (const x of [dt + 0.01, 0.45]) expect(where(re, 'hk-b', T + x)).toBe(where(s, 'hk-b', T + x));
          expect(cleanedDay(re, [D1, R])).toEqual([3, 3]);
          for (const dt2 of [dt + 0.02, 0.45]) {
            const t2 = T + dt2;
            // As a room attendant R (its party out at the half hour) is ahead of D1 in her queue, but it's no new work
            // now: it was already hers, after D1. So she still rests at home till 12:28 and cleans D1 then R, as planned.
            const again = makeAttendant(re, t2);
            expect(jobsOf(again, 'hk-b').filter(l => l.end > t2).map(l => l.placeId)).toEqual([D1.id, R.id]);
            for (const x of [dt2 + 0.005, 0.455, 0.5, 0.6, 0.65, 0.7, 0.8, 0.9]) expect(where(again, 'hk-b', T + x)).toBe(where(re, 'hk-b', T + x));
            // (off to R first she'd be at D1 only after its party is back: D1 would go uncleaned)
            expect(cleanedDay(again, [D1, R])).toEqual([3, 3]);
          }
        }
      }
    });
  });
}

// She rests on at the spot she was resting at, till the set-off already planned, only with nothing new, only while she can still get to the room from there, and only if she'd be back there in time to rest at all.
{
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
    mid: { experience: 'skilled', style: 'standard', workHours: 100 },
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;

  /** A housekeeper (high stamina, a turnover runner) standing at `at`, at `fatigue` as of the hour's start. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number, speed: keyof typeof SPEEDS, extra: Partial<StaffMember> = {}): StaffMember {
    const p = SPEEDS[speed];
    return { id, serial: id.charCodeAt(0) + id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs }, ...extra } as StaffMember;
  }

  /** A do-not-disturb party walking out of `room` to the street at `leave`, back in at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  /** Run a scene with front desk staff on or off, and its roster set up as the game does (syncStaff). */
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Whether any of someone's legs after t goes to, or is spent at, a tile. */
  const goesTo = (s: HotelState, id: string, t: number, tile: TilePos) => legsOf(s, id).filter(l => l.end > t + 1e-9)
    .some(l => sameTile(l.kind === 'stay' ? l.at : l.path.at(-1), tile));
  /** After playing on two hours: the day a room last had its daily clean, and its status. */
  const playOn = (s: HotelState, room: Room) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    const r = st.rooms.find(q => q.id === room.id)!;
    return { day: r.lastDailyCleanDay ?? 0, status: r.status };
  };

  // New work done, the rest of her hour is planned as any other: no resting on for the set-off she had.
  {
    /**
     * 12:00 on day 3: rooms R (3, 2), (4, 2), (5, 2) with doors up onto row 1, and X (2, 5) with its door up beside the base
     * (1, 4). R: a do-not-disturb party out 12:34-12:50, 0.08h of daily cleaning; X: a 0.2h turnover. hk-c (slow, first on
     * the roster) starts at (7, 1) and turns X round from 12:16; hk-b (fast) rests at the base till 12:25 and cleans R at
     * 12:35.
     */
    function scene(desk: Desk) {
      let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
      for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
      s = addRoom(s, 'standard', 2, 5, 0, 'up')!;
      const R = s.rooms[0], X = s.rooms[3];
      const abs = 2 * 24 + 12;
      s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2, maintenanceWorkers: 0 },
        staffRoster: [keeper('hk-c', { gridX: 7, gridY: 1, floor: 0 }, abs, 0, 'slow'), keeper('hk-b', BASE, abs, 0, 'fast')] };
      s = syncStaff(s);
      const T = hourStart(s);
      s = { ...s, guests: [goingOut(s, R, T + 0.5, T + 0.9, 'g')],
        rooms: s.rooms.map(r => (r.id === R.id ? { ...r, status: 'occupied' as const, guestId: 'g', dailyCleanHoursRemaining: 0.08 }
          : r.id === X.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.2 } : r)) };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T, R, X };
    }

    describe('Resting at home for her do-not-disturb room, handed work by a let-go: once she has done it, the rest of her hour is planned afresh', () => {
      it('hk-c let go at 12:03-12:08: hk-b turns X round, then goes straight on to R\'s door and waits there for the party, not back to the base to rest out her old set-off (12:25)', () => {
        for (const desk of DESKS) withDesk(desk, () => {
          const { s, T, R, X } = scene(desk);
          expect(namedFrontDesk(s)).toBe(desk === 'named');
          expect(awayStretches(s.guests[0], R).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.56, 0.84]]);
          // as planned: hk-c on X, hk-b resting at the base till 12:25 for R
          expect(jobsOf(s, 'hk-c').map(l => l.placeId)).toEqual([X.id]);
          expect(jobsOf(s, 'hk-b').map(l => l.placeId)).toEqual([R.id]);
          expect(restsOf(s, 'hk-b')[0]).toMatchObject({ idle: true, at: BASE, start: T });
          expect(restsOf(s, 'hk-b')[0].end).toBeCloseTo(T + 0.41, 3);
          for (const dt of [0.05, 0.1, 0.14]) {
            const t = T + dt;
            const re = settleChanges(s, dismissStaff(s, 'hk-c', t)!, t);
            // X first (a turnover, ahead of R in a turnover runner's queue), done by 12:20; then R as its party goes out
            const [onX, onR] = jobsOf(re, 'hk-b');
            expect([onX?.placeId, onX?.job, onR?.placeId]).toEqual([X.id, 'turnover', R.id]);
            expect(onX.end).toBeLessThan(T + 0.34);
            expect(onR.start).toBeGreaterThanOrEqual(T + 0.56);
            // from X on to R's door (3, 1), and waiting there by 12:30 -- no rest between, at the base or anywhere
            const between = legsOf(re, 'hk-b').filter(l => l.start >= onX.end - 1e-9 && l.end <= onR.start + 1e-9);
            expect(between.filter(l => l.kind === 'stay' && l.activity === 'rest')).toEqual([]);
            expect(goesTo(re, 'hk-b', onX.end, BASE)).toBe(false);
            expect(where(re, 'hk-b', T + 0.5)).toBe('3.000,1.000,0 wait/');
            expect(playOn(re, R).day).toBe(3);
            expect(playOn(re, X).status).toBe('vacant');
          }
        });
      });
    });
  }

  // From where she can't get to the room, she doesn't rest on: she goes on to it from where she is.
  {
    const BR = 'breakroom-0-3-4';
    const SEAT = { gridX: 3, gridY: 4, floor: 0 };

    /**
     * 12:00 on day 3: a break room at (3, 4), rooms at (0, 3) and (4, 5) walling the base's corner (0..3, 4..5) off from the
     * rest of the floor but for (2, 4) -- and from inside the break room, whose sides open onto both. A street entrance at
     * (9, 3) too; A (6, 2), its door down onto (6, 3), has a do-not-disturb party out 12:49-13:14 and 0.1h of daily
     * cleaning. m (83 fatigue) is on a compulsory break in the break room till 12:26; she walks out by (2, 4) to the base,
     * rests there 12:29-12:38, and cleans A as the party goes out.
     */
    function scene(desk: Desk) {
      let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
      s = addRoom(s, 'standard', 0, 3, 0, 'up')!;
      s = addRoom(s, 'standard', 4, 5, 0, 'up')!;
      s = addFixture(s, 'breakroom', 3, 4, 0)!;
      s = addFixture(s, 'entrance', 9, 3, 0)!;
      s = addRoom(s, 'standard', 6, 2, 0, 'down')!;
      const A = s.rooms.find(r => r.gridX === 6 && r.gridY === 2)!;
      const abs = 2 * 24 + 12;
      const m = keeper('m', SEAT, abs, 83, 'mid', { fatigueBreak: { at: SEAT, placeId: BR, start: abs - 0.07, end: abs + 0.43 } });
      s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 }, staffRoster: [m] };
      s = syncStaff(s);
      const T = hourStart(s);
      s = { ...s, guests: [goingOut(s, A, T + 0.75, T + 1.3, 'g')],
        rooms: s.rooms.map(r => (r.id === A.id ? { ...r, status: 'occupied' as const, guestId: 'g', dailyCleanHoursRemaining: 0.1 } : r)) };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T, A };
    }

    describe('Resting at home for a do-not-disturb room she can no longer get to from home: she goes on to it from where she is', () => {
      it('a room built at 12:27 on her step out of the break room to the base cuts the base off from A: she leaves by the break room\'s other side for A\'s door, not on round to the base, and A is cleaned as the party goes out', () => {
        for (const desk of DESKS) withDesk(desk, () => {
          const { s, T, A } = scene(desk);
          expect(namedFrontDesk(s)).toBe(desk === 'named');
          expect(awayStretches(s.guests[0], A).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.81, 1.24]]);
          // as planned: the break till 12:26, out by (2, 4) to the base, resting there till 12:38, A cleaned from 12:50
          const legs = legsOf(s, 'm');
          expect(legs[0]).toMatchObject({ kind: 'stay', activity: 'rest', placeId: BR, start: T });
          expect(legs[0].end).toBeCloseTo(T + 0.43, 6);
          expect(legs[1]).toMatchObject({ kind: 'walk', path: [SEAT, { gridX: 2, gridY: 4, floor: 0 }, BASE] });
          const home = restsOf(s, 'm').find(l => sameTile(l.at, BASE))!;
          expect(home).toMatchObject({ idle: true });
          expect(home.end).toBeCloseTo(T + 0.63, 3);
          expect(jobsOf(s, 'm').map(l => l.placeId)).toEqual([A.id]);
          expect(playOn(s, A).day).toBe(3);
          for (const dt of [0.012, 0.018, 0.024, 0.028]) {
            const t = T + 0.43 + dt;
            // 12:26-12:28: a room built on (2, 4) as she steps onto it -- she's still in the break room
            const re = settleChanges(s, addRoom(s, 'standard', 2, 4, 0, 'up')!, t);
            // out the other side to A's door (6, 3), waiting there for the party by 12:36, and A cleaned as they go out
            expect(goesTo(re, 'm', t, BASE)).toBe(false);
            expect(where(re, 'm', T + 0.7)).toBe('6.000,3.000,0 wait/');
            const onA = jobsOf(re, 'm').filter(l => l.end > t);
            expect(onA.map(l => l.placeId)).toEqual([A.id]);
            expect(onA[0].start).toBeCloseTo(T + 0.84, 6);
            expect(playOn(re, A).day).toBe(3);
          }
        });
      });
    });
  }

  // Not back home in time to rest there at all: she goes on to the room now.
  {
    /**
     * 12:00 on day 3: a row of rooms on row 2 from x 1 to 8, doors up onto row 1, so (0, 2) and (9, 2) are the only ways
     * between the corridors. R (2, 2): a do-not-disturb party out 12:49-13:14 (by a street entrance at (0, 1)), 0.1h of
     * daily cleaning. m, at (9, 1) with nothing else, walks round by (9, 2) and row 3 to the base by 12:20, rests there till
     * 12:38, then goes up by (0, 2) to clean R from 12:50.
     */
    function scene(desk: Desk) {
      let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
      for (let x = 1; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
      s = addFixture(s, 'entrance', 0, 1, 0)!;
      const R = s.rooms.find(r => r.gridX === 2)!;
      const abs = 2 * 24 + 12;
      s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
        staffRoster: [keeper('m', { gridX: 9, gridY: 1, floor: 0 }, abs, 10, 'mid')] };
      s = syncStaff(s);
      const T = hourStart(s);
      s = { ...s, guests: [goingOut(s, R, T + 0.75, T + 1.3, 'g')],
        rooms: s.rooms.map(r => (r.id === R.id ? { ...r, status: 'occupied' as const, guestId: 'g', dailyCleanHoursRemaining: 0.1 } : r)) };
      return { s: { ...s, staffPlan: getStaffPlan(s) }, T, R };
    }

    describe('On her way home to rest for a do-not-disturb room, her way from home made too long to rest there at all: she turns round at once', () => {
      it('a room built at (0, 3) at 12:10-12:13 leaves only the long way from the base to R: due to set off from it by 12:16, before she\'d be there (12:20), she goes back round to R\'s door from where she is and cleans R as the party goes out', () => {
        for (const desk of DESKS) withDesk(desk, () => {
          const { s, T, R } = scene(desk);
          expect(namedFrontDesk(s)).toBe(desk === 'named');
          expect(awayStretches(s.guests[0], R).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.81, 1.24]]);
          // as planned: at the base by 12:20, resting there till 12:38, then up by (0, 2) to R's door (2, 1)
          const home = restsOf(s, 'm')[0];
          expect(home).toMatchObject({ idle: true, at: BASE });
          expect(home.start).toBeCloseTo(T + 0.33, 6);
          expect(home.end).toBeCloseTo(T + 0.63, 3);
          expect(jobsOf(s, 'm')[0]).toMatchObject({ placeId: R.id });
          expect(jobsOf(s, 'm')[0].start).toBeCloseTo(T + 0.84, 6);
          for (const dt of [0.17, 0.2, 0.22]) {
            const t = T + dt;
            // on row 3, between (6, 3) and (3, 3), as (0, 3) is built on
            const re = settleChanges(s, addRoom(s, 'standard', 0, 3, 0, 'up')!, t);
            expect(awayStretches(re.guests[0], R).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.81, 1.24]]);
            // straight back round by (9, 2) to R's door, there before the party goes out, and R cleaned from 12:50 -- not on
            // to the base first, which would have her there at 12:52 and cleaning from 12:54
            expect(goesTo(re, 'm', t, BASE)).toBe(false);
            expect(where(re, 'm', T + 0.75)).toBe('2.000,1.000,0 wait/');
            const onR = jobsOf(re, 'm').filter(l => l.end > t);
            expect(onR.map(l => l.placeId)).toEqual([R.id]);
            expect(onR[0].start).toBeCloseTo(T + 0.84, 6);
            expect(playOn(re, R).day).toBe(3);
          }
        });
      });
    });
  }
}

// The rooms her plan had after the one she rests for are left out of a fresh set-off only at the moment she takes that room up: once it's done, or once new work has got her up, she rests at home for the next party as ever.
{
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A housekeeper (high stamina) standing at `at`: fast (a veteran), or slow (a rookie). */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number, speed: 'fast' | 'slow', roomId?: string): StaffMember {
    const fast = speed === 'fast';
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at, ...(roomId ? { roomId } : {}),
      profile: { experience: fast ? 'veteran' : 'rookie', style: fast ? 'speedy' : 'meticulous', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: fast ? 500 : 0, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: four standard rooms on row 5 from x = 3, their doors up onto the base's row 4. A (3, 5): a
   * do-not-disturb party setting off at 12:18 (out of the room from 12:22) till 15:00, 0.15h of daily cleaning; B (5, 5):
   * one setting off at 12:48 (out from 12:52) till 15:00, 0.1h. hk (fast, 20) at the base, first on the roster. From
   * A's door B's is a few minutes away, but its party is out more than a quarter hour after she'd get there: she goes
   * back to the base to rest till her set-off. `turnover`: X (4, 5) needs a 0.15h turnover, and hk-x (slow) stands in it
   * and keeps at it.
   */
  function scene(desk: Desk, turnover = false) {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    const abs = 2 * 24 + 12, [A, X, B] = s.rooms;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: turnover ? 2 : 1, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', BASE, abs, 20, 'fast'), ...(turnover ? [keeper('hk-x', roomTile(X), abs, 0, 'slow', X.id)] : [])] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, A, T + 0.3, T + 3, 'ga'), goingOut(s, B, T + 0.8, T + 3, 'gb')],
      rooms: s.rooms.map(r => (r.id === A.id ? { ...r, status: 'occupied' as const, guestId: 'ga', dailyCleanHoursRemaining: 0.15 }
        : r.id === B.id ? { ...r, status: 'occupied' as const, guestId: 'gb', dailyCleanHoursRemaining: 0.1 }
        : turnover && r.id === X.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.15 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, A, B, X };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  /** The day a room was last given its daily clean, once the hour is played. */
  const cleanedBy13 = (s: HotelState, room: Room) => tickSimulation(s, new PRNG(17)).state.rooms.find(r => r.id === room.id)!.lastDailyCleanDay ?? 0;
  const farRoom = (s: HotelState, t: number) => settleChanges(s, addRoom(s, 'standard', 8, 2, 0, 'up')!, t);
  const hire = (s: HotelState, t: number) => settleChanges(s, hireCandidate(s, 'housekeeper', hiringCandidates(s, 'housekeeper')[0].id, undefined, t)!, t);

  describe('Re-planned at home for one do-not-disturb party, with another\'s room after it in her plan: once hers is done, the other is timed as ever', () => {
    it('a paused edit, a room built far away, or a hire at 12:05-12:15: she rests at the base till 12:18, cleans A, rests at the base again till 12:44 and cleans B as its party goes out, just as planned', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B } = scene(desk);
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        // as planned: home till 12:18, A at 12:23-12:29, home again 12:35-12:44, B at 12:53-12:57
        expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([A.id, B.id]);
        const [first, second] = restsOf(s, 'hk');
        expect(first).toMatchObject({ idle: true, at: BASE, start: T });
        expect(first.end).toBeCloseTo(T + 0.3, 3);
        expect(second).toMatchObject({ idle: true, at: BASE });
        expect(second.start).toBeGreaterThan(jobsOf(s, 'hk')[0].end);
        expect(second.end).toBeCloseTo(T + 0.74, 3);
        expect(jobsOf(s, 'hk')[1].start).toBeGreaterThanOrEqual(T + 0.86 - 1e-9);
        expect(cleanedBy13(s, B)).toBe(3);
        for (const dt of [0.08, 0.15, 0.25]) {
          const t = T + dt;
          for (const re of [replanStaff(s, t), farRoom(s, t), hire(s, t)]) {
            expect(samePlan(re, s, 'hk', t)).toBe(true);
            expect(jobsOf(re, 'hk').map(l => l.placeId)).toEqual([A.id, B.id]);
            // A done at 12:29, B (a room her plan had after A) is timed from the base like any other: at 12:40 she's
            // resting there for it, not done for the hour at A's door
            expect(where(re, 'hk', T + 0.67)).toBe(where(s, 'hk', T + 0.67));
            expect(where(re, 'hk', T + 0.67)).toMatch(/^1\.000,4\.000,0 rest/);
            expect(cleanedBy13(re, B)).toBe(3);
          }
        }
      });
    });
  });

  describe('Got up from her rest at home by a let-go\'s turnover: after it, every do-not-disturb room is timed as ever', () => {
    it('hk-x let go at 12:03-12:08: hk turns X round, cleans A as its party goes out, rests at the base again and cleans B as its party does', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B, X } = scene(desk, true);
        // as planned: hk-x on X till 12:14; hk home till 12:18, A, home again, B
        expect(jobsOf(s, 'hk-x').map(l => l.placeId)).toEqual([X.id]);
        expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([A.id, B.id]);
        expect(restsOf(s, 'hk')[0]).toMatchObject({ idle: true, at: BASE, start: T });
        for (const dt of [0.05, 0.1, 0.13]) {
          const t = T + dt;
          const re = settleChanges(s, dismissStaff(s, 'hk-x', t)!, t);
          const [onX, onA, onB] = jobsOf(re, 'hk');
          expect([onX?.placeId, onX?.job, onA?.placeId, onB?.placeId]).toEqual([X.id, 'turnover', A.id, B.id]);
          expect(onA.start).toBeGreaterThanOrEqual(T + 0.36 - 1e-9);
          expect(onB.start).toBeGreaterThanOrEqual(T + 0.86 - 1e-9);
          // between A and B: back to the base to rest, not done for the hour at A's door
          const between = legsOf(re, 'hk').filter(l => l.start >= onA.end - 1e-9 && l.end <= onB.start + 1e-9);
          expect(between.some(l => l.kind === 'stay' && l.activity === 'rest' && l.idle && l.at.gridX === BASE.gridX && l.at.gridY === BASE.gridY)).toBe(true);
          expect(where(re, 'hk', T + 0.67)).toMatch(/^1\.000,4\.000,0 rest/);
          expect(cleanedBy13(re, B)).toBe(3);
        }
      });
    });
  });
}

// Her own room can no longer be done this hour: the rooms her plan had after it are timed as ever.
{
  // Her own room can no longer be done this hour: the rooms her plan had after it are timed as ever.
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A housekeeper (skilled, high stamina, a turnover runner) standing at `at`, at `fatigue` as of the hour's start. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number): StaffMember {
    return { id, serial: id.charCodeAt(0) + id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: 100, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb party walking out of `room` to the street at `leave`, back in at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  /** Run a scene with front desk staff on or off, and its roster set up as the game does (syncStaff). */
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: a row of rooms on row 2 from x 1 to 8, doors up onto row 1, so (0, 2) and (9, 2) are the only ways
   * between the corridors; a street entrance at (0, 1). R1 (2, 2): a do-not-disturb party out 12:30-12:37; R2 (3, 2): one
   * out 12:51-12:59; 0.05h of daily cleaning each. m, alone at the base (1, 4), rests there till 12:19, goes up by (0, 2)
   * to clean R1 from 12:32, then waits at R2's door and cleans it from 12:53. `edited`: the hotel planned from 12:00 with
   * a room already at (0, 3), as a fresh plan would have it.
   */
  function scene(edited = false) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 1; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
    s = addFixture(s, 'entrance', 0, 1, 0)!;
    const R1 = s.rooms.find(r => r.gridX === 2)!, R2 = s.rooms.find(r => r.gridX === 3)!;
    const abs = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper('m', BASE, abs, 10)] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, R1, T + 0.44, T + 0.68, 'g1'), goingOut(s, R2, T + 0.79, T + 1.04, 'g2')],
      rooms: s.rooms.map(r => (r.id === R1.id ? { ...r, status: 'occupied' as const, guestId: 'g1', dailyCleanHoursRemaining: 0.05 }
        : r.id === R2.id ? { ...r, status: 'occupied' as const, guestId: 'g2', dailyCleanHoursRemaining: 0.05 } : r)) };
    if (edited) s = addRoom(s, 'standard', 0, 3, 0, 'up')!;
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, R1, R2 };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Whether someone's plan from t to the hour's end is the same in two states (sampled every 0.005h). */
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  /** The day each room was last given its daily clean, after playing on two hours. */
  const cleanedDay = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };

  describe('Resting at home for a do-not-disturb room an edit puts out of her reach this hour: the rooms her plan had after it are timed as ever', () => {
    it('a room built at (0, 3) at 12:03-12:15 leaves only the long way round by (9, 2): R1 is lost, but she rests at the base till 12:20, walks round to R2 and cleans it as its party goes out, as a fresh plan has it', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, R1, R2 } = scene();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(awayStretches(s.guests[0], R1).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.5, 0.62]]);
        expect(awayStretches(s.guests[1], R2).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.85, 0.98]]);
        // as planned: at the base till 12:19, up by (0, 2) to R1, then R2; both rooms cleaned
        const home = restsOf(s, 'm')[0];
        expect(home).toMatchObject({ idle: true, at: BASE, start: T });
        expect(home.end).toBeCloseTo(T + 0.32, 3);
        expect(jobsOf(s, 'm').map(l => l.placeId)).toEqual([R1.id, R2.id]);
        expect(cleanedDay(s, [R1, R2])).toEqual([3, 3]);
        // planned afresh with the room at (0, 3): R1 can't be reached in its party's time out by the long way, so she rests
        // at the base till 12:20 and goes round for R2
        const fresh = scene(true).s;
        expect(jobsOf(fresh, 'm').map(l => l.placeId)).toEqual([R2.id]);
        expect(restsOf(fresh, 'm')[0]).toMatchObject({ idle: true, at: BASE, start: T });
        expect(restsOf(fresh, 'm')[0].end).toBeCloseTo(T + 0.34, 3);
        expect(cleanedDay(fresh, [R1, R2])).toEqual([0, 3]);
        for (const dt of [0.05, 0.1, 0.15, 0.2, 0.25]) {
          const t = T + dt;
          const re = settleChanges(s, addRoom(s, 'standard', 0, 3, 0, 'up')!, t);
          // R2 is still hers, and cleaned on the day (R1 lost, as in a fresh plan)
          expect(jobsOf(re, 'm').filter(l => l.end > t).map(l => l.placeId), `${desk} ${dt}`).toEqual([R2.id]);
          expect(cleanedDay(re, [R1, R2]), `${desk} ${dt}`).toEqual([0, 3]);
          // resting at the base till 12:20, R2's set-off -- not resting out the hour, nor sent off at once to wait at its door
          const rest = restsOf(re, 'm').find(l => l.end > t)!;
          expect(rest, `${desk} ${dt}`).toMatchObject({ idle: true, at: BASE });
          expect(rest.end, `${desk} ${dt}`).toBeCloseTo(T + 0.34, 3);
          expect(where(re, 'm', T + 0.3), `${desk} ${dt}`).toBe('1.000,4.000,0 rest/');
          expect(legsOf(re, 'm').filter(l => l.end > t && l.kind === 'stay' && l.activity === 'wait'), `${desk} ${dt}`).toEqual([]);
          expect(samePlan(re, fresh, 'm', t), `${desk} ${dt}`).toBe(true);
        }
      });
    });

    it('control: a room built far away at 12:03-12:15, her way to R1 still short, leaves her plan as it was, and both rooms are cleaned', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, R1, R2 } = scene();
        for (const dt of [0.05, 0.15, 0.25]) {
          const t = T + dt;
          const re = settleChanges(s, addRoom(s, 'standard', 7, 5, 0, 'up')!, t);
          expect(samePlan(re, s, 'm', t), `${desk} ${dt}`).toBe(true);
          expect(jobsOf(re, 'm').filter(l => l.end > t).map(l => l.placeId), `${desk} ${dt}`).toEqual([R1.id, R2.id]);
          expect(cleanedDay(re, [R1, R2]), `${desk} ${dt}`).toEqual([3, 3]);
        }
      });
    });
  });
}

// When the set-off already planned was timed by a room her plan has after her own, that room still times it: an edit with nothing new leaves her resting at the base till then and waiting at her own room's door, as planned.
{
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A fast housekeeper (a veteran, high stamina, a turnover runner) standing at `at`, at `fatigue` as of the hour's start. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number): StaffMember {
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: 'veteran', style: 'speedy', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: 500, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb party walking out of `room` to the street at `leave`, back in at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: four standard rooms on row 5 from x = 3, their doors up onto the base's row 4. Y (3, 5): a
   * do-not-disturb party out of the room 12:36.6-12:47.4; X (5, 5): one out 12:30.6-13:08.4; 0.1h of daily cleaning
   * each. hk (fast, 10) at the base, the only housekeeper. From the base Y's door is two tiles away and X's four, so X's
   * party, out first, times her set-off (12:23.4, at X's door as its party goes out); but Y, its party in for less time,
   * comes first in her queue: she walks to Y's door, waits there till its party is out, cleans Y, then X.
   */
  function scene() {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    const [Y, , X] = s.rooms;
    const abs = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', BASE, abs, 10)] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, Y, T + 0.55, T + 0.85, 'gy'), goingOut(s, X, T + 0.45, T + 1.2, 'gx')],
      rooms: s.rooms.map(r => (r.id === Y.id ? { ...r, status: 'occupied' as const, guestId: 'gy', dailyCleanHoursRemaining: 0.1 }
        : r.id === X.id ? { ...r, status: 'occupied' as const, guestId: 'gx', dailyCleanHoursRemaining: 0.1 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, Y, X };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  /** The day a room was last given its daily clean, once the hour is played. */
  const cleanedBy13 = (s: HotelState, room: Room) => tickSimulation(s, new PRNG(17)).state.rooms.find(r => r.id === room.id)!.lastDailyCleanDay ?? 0;
  const farRoom = (s: HotelState, t: number) => settleChanges(s, addRoom(s, 'standard', 8, 2, 0, 'up')!, t);
  /** The rest she's in (or next takes) after t. */
  const restAfter = (s: HotelState, id: string, t: number) => restsOf(s, id).find(l => l.end > t + 1e-9);

  describe('Re-planned at home for her own do-not-disturb room, with a room her plan has after it timing the set-off already planned: that set-off stands', () => {
    it('a paused edit, or a room built far away, at 12:03-12:21: she rests at the base till 12:23.4 (X\'s set-off), not on till 12:33 (Y\'s own), waits at Y\'s door from 12:27, and cleans Y, then X, just as planned', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, Y, X } = scene();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        const [[yOut, yIn]] = awayStretches(s.guests[0], Y), [[xOut, xIn]] = awayStretches(s.guests[1], X);
        expect([yOut - T, yIn - T, xOut - T, xIn - T].map(x => +x.toFixed(2))).toEqual([0.61, 0.79, 0.51, 1.14]);
        // as planned: at the base till 12:23.4, timed by X (four tiles to its door, there as its party goes out at
        // 12:30.6; Y's own set-off, two tiles from its door, would be 12:33); at Y's door 12:27-12:36.6; Y, then X
        const home = restsOf(s, 'hk')[0];
        expect(home).toMatchObject({ idle: true, at: BASE, start: T });
        expect(home.end).toBeCloseTo(T + 0.39, 6);
        expect(home.end + 4 * STEP).toBeCloseTo(xOut, 6);
        expect(yOut - 2 * STEP).toBeCloseTo(T + 0.55, 6);
        const [wait] = waitsOf(s, 'hk');
        expect(sameTile(wait.at, { gridX: 3, gridY: 4, floor: 0 })).toBe(true);
        expect(wait.start).toBeCloseTo(T + 0.45, 6);
        expect(wait.end).toBeCloseTo(yOut, 6);
        expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([Y.id, X.id]);
        expect(where(s, 'hk', T + 0.5)).toMatch(/^3\.000,4\.000,0 wait/);
        expect([cleanedBy13(s, Y), cleanedBy13(s, X)]).toEqual([3, 3]);
        for (const dt of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35]) {
          const t = T + dt;
          for (const re of [replanStaff(s, t), farRoom(s, t)]) {
            // nothing new: her plan for the rest of the hour is the one she had
            expect(samePlan(re, s, 'hk', t)).toBe(true);
            const rest = restAfter(re, 'hk', t)!;
            expect(rest).toMatchObject({ idle: true, at: BASE });
            expect(rest.end).toBeCloseTo(T + 0.39, 6);
            // at 12:30 she's waiting at Y's door, not still resting at the base
            expect(where(re, 'hk', T + 0.5)).toMatch(/^3\.000,4\.000,0 wait/);
            expect(waitsOf(re, 'hk').filter(l => l.end > t).map(l => [+(l.start - T).toFixed(4), +(l.end - T).toFixed(4), l.at.gridX, l.at.gridY]))
              .toEqual([[0.45, 0.61, 3, 4]]);
            expect(jobsOf(re, 'hk').map(l => l.placeId)).toEqual([Y.id, X.id]);
            expect([cleanedBy13(re, Y), cleanedBy13(re, X)]).toEqual([3, 3]);
          }
        }
      });
    });
  });
}

// Too tired for her own room as she walks home for it but rested enough by her set-off: an edit with nothing new keeps the set-off planned, and she cleans both rooms as before.
{
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A fast housekeeper (a speedy veteran, high stamina, turnover runner) standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number): StaffMember {
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: 'veteran', style: 'speedy', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: 500, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: four standard rooms on row 5 from x = 3, their doors up onto the base's row 4. A (3, 5): a
   * do-not-disturb party out of the room 12:33.6-12:41.4, 0.1h of daily cleaning; B (5, 5): one out 12:51.6-13:02.4,
   * 0.1h. hk (fast, at 59.6 at 12:00) at (8, 1): she walks home to the base by 12:18 (crossing 60 at about 12:08 on the
   * way), rests there till 12:30 (back under 60 by then), cleans A, then waits at B's door and cleans B. A's party is
   * out just long enough for her clean at her rested rate, not at her tired one.
   */
  function scene() {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    const abs = 2 * 24 + 12, [A, , B] = s.rooms;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', { gridX: 8, gridY: 1, floor: 0 }, abs, 59.6)] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, A, T + 0.5, T + 0.75, 'ga'), goingOut(s, B, T + 0.8, T + 1.1, 'gb')],
      rooms: s.rooms.map(r => (r.id === A.id ? { ...r, status: 'occupied' as const, guestId: 'ga', dailyCleanHoursRemaining: 0.1 }
        : r.id === B.id ? { ...r, status: 'occupied' as const, guestId: 'gb', dailyCleanHoursRemaining: 0.1 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, A, B };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  const energyAt = (s: HotelState, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === 'hk')!, x);
  /** The day each room was last given its daily clean, once the hour is played. */
  const cleanedBy13 = (s: HotelState, rooms: Room[]) => {
    const st = tickSimulation(s, new PRNG(17)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** The edits that bring her nothing new: a paused edit, a maintenance hire, a room built off her way. */
  const edits = (s: HotelState, t: number) => [
    replanStaff(s, t),
    settleChanges(s, hireCandidate(s, 'maintenance', hiringCandidates(s, 'maintenance')[0].id, undefined, t)!, t),
    settleChanges(s, addRoom(s, 'standard', 8, 2, 0, 'up')!, t),
  ];
  /** Her plan after an edit at t, against the hour's: the same from when she's home (the way home re-planned mid-walk can be another as short). */
  const expectAsPlanned = (re: HotelState, s: HotelState, T: number, t: number, A: Room, B: Room) => {
    expect(samePlan(re, s, 'hk', Math.max(t, T + 0.3))).toBe(true);
    // home at 12:18, resting there till 12:30, not for the rest of the hour
    const rest = restsOf(re, 'hk').find(l => l.end > t)!;
    expect(rest).toMatchObject({ idle: true, at: BASE });
    expect(rest.start).toBeCloseTo(T + 0.3, 9);
    expect(rest.end).toBeCloseTo(T + 0.5, 9);
    expect(jobsOf(re, 'hk').filter(l => l.end > t).map(l => l.placeId)).toEqual([A.id, B.id]);
    expect(cleanedBy13(re, [A, B])).toEqual([3, 3]);
  };

  describe('On her way home to rest for her do-not-disturb room, just past the tired mark: an edit with nothing new leaves her plan as it was', () => {
    it('as planned: she walks home to the base by 12:18, rests there till 12:30, cleans A as its party goes out, then B as theirs does, and both rooms are cleaned', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B } = scene();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(awayStretches(s.guests[0], A).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.56, 0.69]]);
        expect(awayStretches(s.guests[1], B).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.86, 1.04]]);
        const [home] = restsOf(s, 'hk');
        expect(home).toMatchObject({ idle: true, at: BASE });
        expect(home.start).toBeCloseTo(T + 0.3, 9);
        expect(home.end).toBeCloseTo(T + 0.5, 9);
        const [onA, onB] = jobsOf(s, 'hk');
        expect([onA?.placeId, onB?.placeId]).toEqual([A.id, B.id]);
        expect(onA.start).toBeGreaterThanOrEqual(T + 0.56 - 1e-9);
        expect(onB.start).toBeGreaterThanOrEqual(T + 0.86 - 1e-9);
        // tired from about 12:08 on her way home, back under the mark by her set-off at 12:30
        expect(energyAt(s, T + 0.1)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.15)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.3)).toBeGreaterThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.5)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(cleanedBy13(s, [A, B])).toEqual([3, 3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a paused edit, a hire or a room built off her way at 12:09-12:17, her energy 60 or more: she still rests at the base till 12:30, cleans A, then B, and both rooms are cleaned`, () => withDesk(desk, () => {
        const { s, T, A, B } = scene();
        for (const dt of [0.15, 0.2, 0.25, 0.283]) {
          const t = T + dt;
          expect(energyAt(s, t)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
          for (const re of edits(s, t)) expectAsPlanned(re, s, T, t, A, B);
        }
      }));
    }

    it('control: the same edits at 12:06, her energy still under 60, leave her plan as it was too', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B } = scene();
        const t = T + 0.1;
        expect(energyAt(s, t)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        for (const re of edits(s, t)) expectAsPlanned(re, s, T, t, A, B);
      });
    });
  });
}

// On her way home to rest for her do-not-disturb room, just past the tired mark, a room demolished that only shortens her way to its door keeps the set-off already planned: she rests at the base till then, takes the shorter way, waits at the door and cleans the room, just as she does when she isn't tired.
{
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A housekeeper (high stamina) standing at `at`, at `fatigue` as of the hour's start. */
  function keeper(at: TilePos, abs: number, fatigue: number, speed: keyof typeof SPEEDS): StaffMember {
    const p = SPEEDS[speed];
    return { id: 'hk', serial: 1, name: 'hk', role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb party walking out of `room` to the street at `leave`, back in at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a demolition). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /** A hotel at 12:00 on day 3, and what the hour's plan and the demolition mean for her (times in hours after 12:00). */
  type Scene = {
    s: HotelState; T: number; room: Room; wall: Room;
    /** home at the base; the set-off planned; at the door by the new way; the party's time out of the room (she's planned at the door as it starts) */
    home: number; setOff: number; there: number; out: number; outTill: number;
    door: [number, number]; newWay: [number, number][]; plannedTiles: number;
    /** the moments of the demolition: on her last steps home, or just home (Y) */
    edits: number[];
  };

  /**
   * A: four standard rooms on row 5 from x = 3, their doors up onto the base's row 4, and a room at (4, 4) across row 4,
   * so her way from the base to row 5's doors goes round by row 3. A (6, 5): a do-not-disturb party out of the room
   * 12:40.8-12:58.8, 0.15h of daily cleaning. hk (slow: a meticulous rookie, high stamina) at (8, 1): she walks home to
   * the base by 12:18 (just over 60 from about 12:16), rests there till 12:28.2 (back under 60), and goes round by row 3 to A's
   * door, there as its party goes out; she cleans A 12:42.6-12:56.7. Demolishing the room at (4, 4) opens row 4: from
   * the base to A's door is five tiles now, not seven.
   */
  function sceneA(f0: number): Scene {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 3; x <= 6; x++) s = addRoom(s, 'standard', x, 5, 0, 'up')!;
    s = addRoom(s, 'standard', 4, 4, 0, 'up')!;
    const room = s.rooms.find(r => r.gridX === 6 && r.gridY === 5)!, wall = s.rooms.find(r => r.gridX === 4 && r.gridY === 4)!;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper({ gridX: 8, gridY: 1, floor: 0 }, 2 * 24 + 12, f0, 'slow')] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, room, T + 0.62, T + 1.04, 'ga')],
      rooms: s.rooms.map(r => (r.id === room.id ? { ...r, status: 'occupied' as const, guestId: 'ga', dailyCleanHoursRemaining: 0.15 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, room, wall, home: 0.3, setOff: 0.47, there: 0.62, out: 0.68, outTill: 0.98,
      door: [6, 4], newWay: [[1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4]], plannedTiles: 7, edits: [0.25, 0.27, 0.28, 0.3] };
  }

  /**
   * Y: a standard room at (3, 5), its door up onto (3, 4), and one at (2, 4) walling the base off from (3, 4), so her way
   * from the base to Y's door goes round by column 0 and row 2. Y: a do-not-disturb party out of the room 12:48-12:56,
   * 0.1h of daily cleaning. hk (fast: a speedy veteran, high stamina) at (8, 1): she walks home by 12:21.6 (just over 60
   * from about 12:16 to 12:23), rests there till 12:33.6, takes the eight tiles round to Y's door, there as its party
   * goes out, and cleans Y 12:49.8-12:53.8. Demolishing the room at (2, 4) leaves Y's door two tiles from the base.
   */
  function sceneY(f0: number): Scene {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    s = addRoom(s, 'standard', 3, 5, 0, 'up')!;
    s = addRoom(s, 'standard', 2, 4, 0, 'up')!;
    const room = s.rooms.find(r => r.gridX === 3 && r.gridY === 5)!, wall = s.rooms.find(r => r.gridX === 2 && r.gridY === 4)!;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper({ gridX: 8, gridY: 1, floor: 0 }, 2 * 24 + 12, f0, 'fast')] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, room, T + 0.74, T + 0.994, 'gy')],
      rooms: s.rooms.map(r => (r.id === room.id ? { ...r, status: 'occupied' as const, guestId: 'gy', dailyCleanHoursRemaining: 0.1 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, room, wall, home: 0.36, setOff: 0.56, there: 0.62, out: 0.8, outTill: 0.934,
      door: [3, 4], newWay: [[1, 4], [2, 4], [3, 4]], plannedTiles: 8, edits: [0.25, 0.3, 0.33, 0.36, 0.38] };
  }
  const SCENES = { A: sceneA, Y: sceneY } as const;

  const legsOf = (s: HotelState): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === 'hk')?.legs ?? [];
  const restsOf = (s: HotelState) => legsOf(s).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState) => legsOf(s).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState) => legsOf(s).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where she is at x and doing what. */
  const where = (s: HotelState, x: number) => {
    const p = positionAt(legsOf(s), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** The two plans have her in the same place doing the same thing from `from` to `to`. */
  const sameBetween = (a: HotelState, b: HotelState, from: number, to: number) => {
    for (let x = from + 0.001; x < to; x += 0.005) if (where(a, x) !== where(b, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, x)} vs ${where(b, x)}`;
    return true;
  };
  const energyAt = (s: HotelState, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === 'hk')!, x);
  /** The party's time out of the room, in hours after 12:00. */
  const outOf = (s: HotelState, room: Room) => awayStretches(s.guests[0], room).map(([a, b]) => [+(a - hourStart(s)).toFixed(4), +(b - hourStart(s)).toFixed(4)]);
  /** The day the room was last given its daily clean, once the hour is played. */
  const cleanedBy13 = (s: HotelState, room: Room) => tickSimulation(s, new PRNG(17)).state.rooms.find(r => r.id === room.id)!.lastDailyCleanDay ?? 0;
  const demolished = (sc: Scene, t: number) => settleChanges(sc.s, demolishRoom(sc.s, sc.wall.id)!, t);

  /**
   * Her plan after the demolition at t: resting at the base from when she's home till the set-off already planned, the
   * new, shorter way to the door, a wait there till the party's out, and from then on the hour's plan (the clean at her
   * rested rate, as planned).
   */
  const expectPlannedSetOff = (re: HotelState, sc: Scene, t: number) => {
    const { s, T, room, wall } = sc;
    expect(re.rooms.some(r => r.id === wall.id)).toBe(false);
    expect(outOf(re, room)).toEqual(outOf(s, room));
    // she still cleans the room as its party goes out
    expect(jobsOf(re).filter(l => l.end > t).map(l => l.placeId)).toEqual([room.id]);
    // at the base till the set-off already planned, just as planned (not on to the hour's end, nor to a later set-off)
    const rest = restsOf(re).find(l => l.end > t + 1e-9)!;
    expect(rest).toMatchObject({ idle: true, at: BASE });
    expect(+(rest.end - T).toFixed(4)).toBe(sc.setOff);
    expect(sameBetween(re, s, Math.max(t, T + sc.home), T + sc.setOff)).toBe(true);
    // then the shorter way to the door, and a wait there till the party's out
    const walk = legsOf(re).find((l): l is WalkLeg => l.kind === 'walk' && Math.abs(l.start - rest.end) < 1e-9)!;
    expect(walk.path.map(p => [p.gridX, p.gridY])).toEqual(sc.newWay);
    expect(+(walk.end - T).toFixed(4)).toBe(sc.there);
    expect(waitsOf(re).filter(l => l.end > t).map(l => [+(l.start - T).toFixed(4), +(l.end - T).toFixed(4), l.at.gridX, l.at.gridY]))
      .toEqual([[sc.there, sc.out, ...sc.door]]);
    expect(where(re, T + (sc.there + sc.out) / 2)).toMatch(new RegExp(`^${sc.door[0]}\\.000,${sc.door[1]}\\.000,0 wait`));
    // from the moment the party's out: in, the clean, out, just as the hour's plan had it
    expect(sameBetween(re, s, T + sc.out, T + 1)).toBe(true);
    expect(cleanedBy13(re, room)).toBe(3);
  };

  describe('On her way home to rest for her do-not-disturb room, just past the tired mark: an edit that only shortens her way to its door keeps the set-off already planned', () => {
    it('as planned: home at the base just over 60, resting there till her set-off (back under 60 by then), the long way round to the door, there as the party goes out, and the room cleaned -- the clean fits their time out only at her rested rate', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        for (const build of Object.values(SCENES)) {
          const sc = build(59.2);
          const { s, T, room } = sc;
          expect(namedFrontDesk(s)).toBe(desk === 'named');
          expect(outOf(s, room)).toEqual([[sc.out, sc.outTill]]);
          const [home] = restsOf(s);
          expect(home).toMatchObject({ idle: true, at: BASE });
          expect(+(home.start - T).toFixed(4)).toBe(sc.home);
          expect(+(home.end - T).toFixed(4)).toBe(sc.setOff);
          const way = legsOf(s).find((l): l is WalkLeg => l.kind === 'walk' && Math.abs(l.start - home.end) < 1e-9)!;
          expect(way.path.length - 1).toBe(sc.plannedTiles);
          expect(way.end).toBeCloseTo(T + sc.out, 9);
          expect(waitsOf(s)).toEqual([]);
          // tired (60 or more) when she gets home, rested (under 60) by her set-off
          expect(energyAt(s, T + sc.home)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
          expect(energyAt(s, T + sc.setOff)).toBeLessThan(STAFF_FATIGUE.tiredAt);
          // her clean at her rested rate, with her step in and out, fits the party's time out; at her tired rate it wouldn't
          const [clean] = jobsOf(s);
          expect(clean.placeId).toBe(room.id);
          expect(clean.end - clean.start + 2 * STEP).toBeLessThanOrEqual(sc.outTill - sc.out + 1e-9);
          expect((clean.end - clean.start) / STAFF_FATIGUE.tiredRate + 2 * STEP).toBeGreaterThan(sc.outTill - sc.out);
          expect(cleanedBy13(s, room)).toBe(3);
        }
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: A -- the room across row 4 demolished at 12:15-12:18, her energy 60 or more when she gets home: she rests at the base till 12:28.2 as planned, walks the new way along row 4, waits at A's door 12:37.2-12:40.8 and cleans A`, () => withDesk(desk, () => {
        const sc = sceneA(59.2);
        for (const dt of sc.edits) {
          const t = sc.T + dt;
          expect(energyAt(sc.s, Math.max(t, sc.T + sc.home))).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
          expectPlannedSetOff(demolished(sc, t), sc, t);
        }
      }));

      it(`desk ${desk}: Y -- the room walling the base off demolished at 12:15-12:22.8 (on her last steps home, or just home and resting), her energy 60 or more when she's home: she rests at the base till 12:33.6 as planned, walks the two tiles to Y's door, waits there 12:37.2-12:48 and cleans Y`, () => withDesk(desk, () => {
        const sc = sceneY(59.2);
        for (const dt of sc.edits) {
          const t = sc.T + dt;
          expect(energyAt(sc.s, Math.max(t, sc.T + sc.home))).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
          expectPlannedSetOff(demolished(sc, t), sc, t);
        }
      }));
    }

    it('control: the same demolitions with her at 58.8 (under 60 all the way) give her the same plan as at 59.2, and a paused edit with nothing changed leaves the hour\'s plan as it was', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        for (const build of Object.values(SCENES)) {
          const tired = build(59.2), fresh = build(58.8);
          const { T } = fresh;
          // the same hour's plan either way; only her energy differs
          expect(sameBetween(fresh.s, tired.s, T, T + 1)).toBe(true);
          expect(energyAt(fresh.s, T + fresh.home)).toBeLessThan(STAFF_FATIGUE.tiredAt);
          for (const dt of fresh.edits) {
            const t = T + dt;
            expect(energyAt(fresh.s, t)).toBeLessThan(STAFF_FATIGUE.tiredAt);
            const re = demolished(fresh, t);
            expect(sameBetween(re, demolished(tired, t), t, T + 1)).toBe(true);
            expectPlannedSetOff(re, fresh, t);
            // nothing changed at all: her plan for the rest of the hour is the one she had
            expect(sameBetween(replanStaff(tired.s, t), tired.s, t, T + 1)).toBe(true);
          }
        }
      });
    });
  });
}

// Just over 60 on her way home to rest for her own do-not-disturb room, with the planned set-off timed by another of her rooms that her own room comes before in her queue: an edit that brings nothing new keeps that set-off, and she still cleans her own room.
{
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A fast housekeeper (a speedy veteran, high stamina, turnover runner) standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number): StaffMember {
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: 'veteran', style: 'speedy', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: 500, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build or a hire). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: four standard rooms on row 5 from x = 3, their doors up onto the base's row 4. Y (3, 5): a
   * do-not-disturb party out of the room 12:36.6-12:44.6; X (5, 5): one out 12:38.4-12:46.4 (or none, `withX` false);
   * 0.1h of daily cleaning each. hk (fast, at 59.6 at 12:00) at (8, 1), the only housekeeper: she walks home to the base
   * by 12:18 (crossing 60 at about 12:08 on the way) and rests there till 12:31.2, back under 60 by then. X's door, four
   * tiles from the base, times that set-off (Y's own, two tiles from its door, would be 12:33); but Y, its party back
   * sooner, comes first in her queue: she waits at Y's door, cleans Y, and is too late for X.
   */
  function scene(withX = true) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    const abs = 2 * 24 + 12, [Y, , X] = s.rooms;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', { gridX: 8, gridY: 1, floor: 0 }, abs, 59.6)] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, Y, T + 0.55, T + 0.804, 'gy'), ...(withX ? [goingOut(s, X, T + 0.58, T + 0.834, 'gx')] : [])],
      rooms: s.rooms.map(r => (r.id === Y.id ? { ...r, status: 'occupied' as const, guestId: 'gy', dailyCleanHoursRemaining: 0.1 }
        : r.id === X.id && withX ? { ...r, status: 'occupied' as const, guestId: 'gx', dailyCleanHoursRemaining: 0.1 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, Y, X };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  const energyAt = (s: HotelState, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === 'hk')!, x);
  /** When the step she's on at x ends: the tile she's walking onto (a re-plan mid-walk finishes it), or x itself at rest. */
  const stepEnd = (s: HotelState, x: number) => {
    const { leg } = positionAt(legsOf(s, 'hk'), x)!;
    return leg.kind === 'walk' ? leg.start + Math.ceil((x - leg.start) / STEP - 1e-9) * STEP : x;
  };
  const away = (s: HotelState, g: number, room: Room, T: number) => awayStretches(s.guests[g], room).map(([a, b]) => [+(a - T).toFixed(3), +(b - T).toFixed(3)]);
  /** The day each room was last given its daily clean, once the hour is played. */
  const cleanedBy13 = (s: HotelState, rooms: Room[]) => {
    const st = tickSimulation(s, new PRNG(17)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** The edits that bring her nothing new: a paused edit, a maintenance hire, a room built off her way. */
  const edits = (s: HotelState, t: number) => ({
    paused: replanStaff(s, t),
    hire: settleChanges(s, hireCandidate(s, 'maintenance', hiringCandidates(s, 'maintenance')[0].id, undefined, t)!, t),
    built: settleChanges(s, addRoom(s, 'standard', 8, 3, 0, 'up')!, t),
  });

  describe('On her way home to rest for her do-not-disturb room, just past the tired mark, the set-off already planned timed by another room of hers: an edit with nothing new leaves her plan as it was', () => {
    it('as planned: home to the base by 12:18, resting there till 12:31.2 (timed by X, not 12:33 as Y alone would), waiting at Y\'s door from 12:34.8, Y cleaned, X missed', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, Y, X } = scene();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, 0, Y, T)).toEqual([[0.61, 0.744]]);
        expect(away(s, 1, X, T)).toEqual([[0.64, 0.774]]);
        const [home] = restsOf(s, 'hk');
        expect(home).toMatchObject({ idle: true, at: BASE });
        expect(home.start).toBeCloseTo(T + 0.3, 9);
        expect(home.end).toBeCloseTo(T + 0.52, 9);
        // the set-off is X's: four tiles to its door, there as its party goes out; Y's own, two tiles off, would be 12:33
        expect(home.end + 4 * STEP).toBeCloseTo(T + 0.64, 9);
        expect(T + 0.61 - 2 * STEP).toBeCloseTo(T + 0.55, 9);
        // but Y comes first: at Y's door 12:34.8-12:36.6, Y cleaned from 12:38.4
        const [wait] = waitsOf(s, 'hk');
        expect(sameTile(wait.at, { gridX: 3, gridY: 4, floor: 0 })).toBe(true);
        expect([wait.start - T, wait.end - T].map(x => +x.toFixed(6))).toEqual([0.58, 0.61]);
        expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([Y.id]);
        expect(jobsOf(s, 'hk')[0].start).toBeCloseTo(T + 0.64, 9);
        // tired from about 12:08 on her way home, back under the mark by her set-off at 12:31.2
        expect(energyAt(s, T + 0.13)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.15)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.3)).toBeGreaterThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.52)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(cleanedBy13(s, [Y, X])).toEqual([3, 0]);
      });
    });

    it('control: with no party in X, Y times her set-off itself, at 12:33', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, Y } = scene(false);
        const [home] = restsOf(s, 'hk');
        expect(home).toMatchObject({ idle: true, at: BASE });
        expect(home.end).toBeCloseTo(T + 0.55, 9);
        expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([Y.id]);
        expect(cleanedBy13(s, [Y])).toEqual([3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a paused edit, a maintenance hire or a room built off her way at 12:07.8-12:19.8, her energy 60 or more by the end of her step: she still rests at the base till 12:31.2, waits at Y's door, and Y is cleaned`, () => withDesk(desk, () => {
        const { s, T, Y, X } = scene();
        for (const dt of [0.13, 0.15, 0.2, 0.25, 0.31, 0.33]) {
          const t = T + dt;
          // too tired for Y from where she is: 60 or more by the end of the step she's on (on her way, or resting at the base)
          expect(energyAt(s, stepEnd(s, t))).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
          for (const [kind, re] of Object.entries(edits(s, t))) {
            const at = `${kind} at 12:${(dt * 60).toFixed(1)}`;
            // nothing new: her plan for the rest of the hour is the one she had
            expect(samePlan(re, s, 'hk', t), at).toBe(true);
            // resting at the base till the set-off already planned, 12:31.2, not on till 13:00
            const rest = restsOf(re, 'hk').find(l => l.end > t + 1e-9)!;
            expect(rest, at).toMatchObject({ idle: true, at: BASE });
            expect(rest.start, at).toBeCloseTo(Math.max(t, T + 0.3), 9);
            expect(rest.end, at).toBeCloseTo(T + 0.52, 9);
            // at 12:36 she's waiting at Y's door, not still resting at the base
            expect(where(re, 'hk', T + 0.6), at).toMatch(/^3\.000,4\.000,0 wait/);
            expect(waitsOf(re, 'hk').filter(l => l.end > t).map(l => [+(l.start - T).toFixed(6), +(l.end - T).toFixed(6), l.at.gridX, l.at.gridY]), at)
              .toEqual([[0.58, 0.61, 3, 4]]);
            expect(jobsOf(re, 'hk').filter(l => l.end > t).map(l => l.placeId), at).toEqual([Y.id]);
            expect(cleanedBy13(re, [Y, X]), at).toEqual([3, 0]);
          }
        }
      }));
    }
  });
}

// Not tired, on her way home to rest for her do-not-disturb room, a room demolished early in her walk opens a shorter way to its door: she still rests at the base till the set-off already planned, then walks the shorter way, waits at the door and cleans the room.
{
  // Not tired, on her way home to rest for her do-not-disturb room, a shorter way to its door opened early in her walk: she rests on till the set-off already planned and waits at the door.
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  /** The hallway tile at A's door. */
  const DOOR_A = { gridX: 6, gridY: 4, floor: 0 };

  /** A slow housekeeper (a meticulous rookie, high stamina, a turnover runner) standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number): StaffMember {
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: 'rookie', style: 'meticulous', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: 0, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb party walking out of `room` to the street at `leave`, back in at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a demolish). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: four standard rooms on row 5 from x = 3, their doors up onto the base's row 4, and (`wall`) a vacant
   * room at (4, 4) standing across row 4. A (6, 5): a do-not-disturb party out of the room 12:40.8-12:58.8, 0.15h of
   * daily cleaning. hk (slow, at 40 at 12:00, so nowhere near tired) at (8, 1), the only housekeeper: she walks home to
   * the base by 12:18, rests there till 12:28.2 and goes the long way round the wall room by row 3 (seven tiles, 12.6
   * minutes) to A's door, there as its party goes out at 12:40.8, and cleans A. With no wall room the way along row 4
   * is five tiles, 9 minutes.
   */
  function scene(wall = true) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    if (wall) s = addRoom(s, 'standard', 4, 4, 0, 'up')!;
    const A = s.rooms.find(r => r.gridX === 6 && r.gridY === 5)!;
    const abs = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', { gridX: 8, gridY: 1, floor: 0 }, abs, 40)] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, A, T + 0.62, T + 1.04, 'ga')],
      rooms: s.rooms.map(r => (r.id === A.id ? { ...r, status: 'occupied' as const, guestId: 'ga', dailyCleanHoursRemaining: 0.15 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, A, wall: s.rooms.find(r => r.gridX === 4 && r.gridY === 4) };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Her rest at the base that she sets off from. */
  const homeRest = (s: HotelState) => restsOf(s, 'hk').filter(l => sameTile(l.at, BASE)).at(-1);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  const energyAt = (s: HotelState, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === 'hk')!, x);
  /** The day a room was last given its daily clean, once the hour is played. */
  const cleanedBy13 = (s: HotelState, room: Room) => tickSimulation(s, new PRNG(17)).state.rooms.find(r => r.id === room.id)!.lastDailyCleanDay ?? 0;
  /** The edits early in her walk home: 12:03, 12:06, 12:09, 12:12. */
  const EARLY = [0.05, 0.1, 0.15, 0.2];

  describe('Not tired, on her way home to rest for her do-not-disturb room, a shorter way to its door opened early in her walk: she rests on till the set-off already planned and waits at the door', () => {
    it('as planned: home by 12:18, resting there till 12:28.2, the long way to A\'s door by 12:40.8 with no wait, and A cleaned; with the shorter way there from the start she\'d rest till 12:31.8', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, wall } = scene();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(wall!.guestId ?? null).toBeNull();
        expect(awayStretches(s.guests[0], A).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)])).toEqual([[0.68, 0.98]]);
        const home = homeRest(s)!;
        expect(home).toMatchObject({ idle: true, at: BASE });
        expect(home.start).toBeCloseTo(T + 0.3, 9);
        expect(home.end).toBeCloseTo(T + 0.47, 9);
        // the long way round, seven tiles, at A's door just as its party goes out
        expect(home.end + 7 * STEP).toBeCloseTo(T + 0.68, 9);
        expect(waitsOf(s, 'hk')).toEqual([]);
        const [onA] = jobsOf(s, 'hk');
        expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([A.id]);
        expect(onA.start).toBeCloseTo(T + 0.71, 9);
        expect(cleanedBy13(s, A)).toBe(3);
        // nowhere near tired all the while
        for (const x of [T, T + 0.2, T + 0.47, T + 0.7]) expect(energyAt(s, x)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        // the shorter way there from 12:00: she'd set off at 12:31.8 (five tiles along row 4), so the edit's timing is a later one
        const fresh = scene(false);
        const freshHome = homeRest(fresh.s)!;
        expect(freshHome.end).toBeCloseTo(fresh.T + 0.53, 9);
        expect(freshHome.end + 5 * STEP).toBeCloseTo(fresh.T + 0.68, 9);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: the wall room demolished at 12:03-12:12 as she walks home: she still rests at the base till 12:28.2, walks the shorter way to A's door by 12:37.2, waits there till its party goes out at 12:40.8, and cleans A`, () => withDesk(desk, () => {
        const { s, T, A, wall } = scene();
        for (const dt of EARLY) {
          const t = T + dt;
          // under 60, and still on her way home
          expect(energyAt(s, t)).toBeLessThan(STAFF_FATIGUE.tiredAt);
          expect(where(s, 'hk', t)).toMatch(/ walk$/);
          const re = settleChanges(s, demolishRoom(s, wall!.id)!, t);
          expect(re.rooms.some(r => r.id === wall!.id)).toBe(false);
          // home by 12:18 as before, resting there in spare time till the set-off already planned, not on till 12:31.8
          const rest = homeRest(re)!;
          expect(rest).toMatchObject({ idle: true, at: BASE });
          expect(rest.start).toBeCloseTo(T + 0.3, 9);
          expect(rest.end).toBeCloseTo(T + 0.47, 9);
          expect(where(re, 'hk', T + 0.5)).toMatch(/ walk$/);
          // the shorter way, five tiles along row 4 through where the wall room stood, then a wait at A's door
          const way = legsOf(re, 'hk').find((l): l is WalkLeg => l.kind === 'walk' && Math.abs(l.start - (T + 0.47)) < 1e-9)!;
          expect(way.path.some(p => p.gridX === 4 && p.gridY === 4)).toBe(true);
          expect(sameTile(way.path.at(-1)!, DOOR_A)).toBe(true);
          expect(way.end).toBeCloseTo(T + 0.62, 9);
          expect(waitsOf(re, 'hk').map(l => [+(l.start - T).toFixed(4), +(l.end - T).toFixed(4), l.at.gridX, l.at.gridY])).toEqual([[0.62, 0.68, 6, 4]]);
          expect(where(re, 'hk', T + 0.65)).toMatch(/^6\.000,4\.000,0 wait/);
          // and A as planned, cleaned by 13:00
          const [onA] = jobsOf(re, 'hk');
          expect(jobsOf(re, 'hk').map(l => l.placeId)).toEqual([A.id]);
          expect(onA.start).toBeCloseTo(T + 0.71, 9);
          expect(cleanedBy13(re, A)).toBe(3);
          // just as the same edit leaves her once she's home (12:19.2)
          const later = settleChanges(s, demolishRoom(s, wall!.id)!, T + 0.32);
          expect(samePlan(re, later, 'hk', T + 0.32)).toBe(true);
        }
      }));
    }

    it('control: with her way unchanged, a paused edit at 12:03-12:12 leaves her plan as it was', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A } = scene();
        for (const dt of EARLY) {
          const t = T + dt;
          const re = replanStaff(s, t);
          expect(samePlan(re, s, 'hk', Math.max(t, T + 0.3))).toBe(true);
          expect(homeRest(re)!.end).toBeCloseTo(T + 0.47, 9);
          expect(waitsOf(re, 'hk')).toEqual([]);
          expect(cleanedBy13(re, A)).toBe(3);
        }
      });
    });
  });
}

// A room demolished that cuts her way to her do-not-disturb room's door by more than a quarter hour keeps the room hers: she rests once at the base till its own later set-off, walks the short way and cleans it, a colleague doesn't take it at the edit or at later edits that bring nothing, and a plan with her turned down at her set-off and resting on there is still a rest at home for it.
{
  // Resting at home for her do-not-disturb room, a big shortcut to its door: she rests once, till the room's own later set-off, and the room stays hers against a colleague, at the edit and at later edits that bring nothing.
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  /** The hallway tile at Y's door. */
  const DOOR_Y = { gridX: 3, gridY: 1, floor: 0 };
  /** From the base to Y's door once the room at (0, 3) is gone: up column 0 through where it stood, and along row 1. */
  const SHORT_WAY = [[1, 4], [0, 4], [0, 3], [0, 2], [0, 1], [1, 1], [2, 1], [3, 1]];

  /** A housekeeper (skilled, high stamina, a turnover runner) at the base, at `fatigue` at `abs`. */
  function keeper(id: string, fatigue: number, abs: number): StaffMember {
    return { id, serial: id.charCodeAt(0) + id.length, name: id, role: 'housekeeper', dailyWage: 70, at: BASE,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: 100, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb party walking out of `room` to the street at `leave`, back in at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build or a demolish). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: eight standard rooms on row 2 from x = 1, their doors up onto the row-1 hallway, the street entrance
   * at (0, 1), and (`wall`) a vacant room at (0, 3) that shuts the short way up from the base by (0, 2), so from the base
   * to row 1 is 17 tiles round by (9, 2). Y (3, 2): a do-not-disturb party out of the room 12:51-12:58.8, 0.05h of daily
   * cleaning. C, first on the roster at 86, is on a compulsory break at the base till 12:30: the long way round would
   * have her at Y's door only at 13:00.6, too late, so she then rests in spare time. hk (at 10, nowhere near tired) rests
   * at the base till 12:20.4, takes the 17 tiles round to Y's door, there as its party goes out at 12:51, and cleans Y.
   * With the room at (0, 3) gone, the way from the base to Y's door is 7 tiles (12.6 minutes): Y's own set-off from the
   * base is 12:38.4, and from the set-off planned she'd be at the door at 12:33, 18 minutes early, more than she waits.
   * C, free from 12:30, could then be at Y's door by 12:42.6 and wait there till 12:51.
   */
  function scene() {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 1; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
    s = addFixture(s, 'entrance', 0, 1, 0)!;
    s = addRoom(s, 'standard', 0, 3, 0, 'up')!;
    const Y = s.rooms.find(r => r.gridX === 3 && r.gridY === 2)!, wall = s.rooms.find(r => r.gridX === 0 && r.gridY === 3)!;
    const abs = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2, maintenanceWorkers: 0 },
      staffRoster: [keeper('c', 86, abs), keeper('hk', 10, abs)] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, Y, T + 0.79, T + 1.04, 'gy')],
      rooms: s.rooms.map(r => (r.id === Y.id ? { ...r, status: 'occupied' as const, guestId: 'gy', dailyCleanHoursRemaining: 0.05 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, Y, wall };
  }
  type Scene = ReturnType<typeof scene>;

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Walks of more than a step (the step into or out of a room left out). */
  const walksOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is WalkLeg => l.kind === 'walk' && l.path.length > 2);
  /** Who has the room's clean in the plan. */
  const cleanerOf = (s: HotelState, room: Room) => ['c', 'hk'].filter(id => jobsOf(s, id).some(l => l.placeId === room.id));
  /** Her rests at the base running past t, as [from, to] in hours after 12:00. */
  const baseRests = (s: HotelState, id: string, T: number, t: number) =>
    restsOf(s, id).filter(l => l.end > t + 1e-9 && sameTile(l.at, BASE)).map(l => [+(l.start - T).toFixed(4), +(l.end - T).toFixed(4)]);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  const energyAt = (s: HotelState, id: string, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === id)!, x);
  /** The day Y was last given its daily clean, once the hour is played. */
  const cleanedBy13 = (s: HotelState, room: Room) => tickSimulation(s, new PRNG(17)).state.rooms.find(r => r.id === room.id)!.lastDailyCleanDay ?? 0;
  const demolished = (sc: Scene, t: number) => settleChanges(sc.s, demolishRoom(sc.s, sc.wall.id)!, t);
  /** The edits that bring nobody anything new: a paused re-plan, and a room built on row 5 (at x), off everyone's way. */
  const EDITS = {
    paused: (s: HotelState, t: number) => replanStaff(s, t),
    built: (s: HotelState, t: number, x = 6) => settleChanges(s, addRoom(s, 'standard', x, 5, 0, 'up')!, t),
  };
  const nothingNew = (s: HotelState, t: number) => Object.entries(EDITS).map(([kind, edit]) => [kind, edit(s, t)] as const);
  /** The clock time of t, for messages: 12:05 etc. */
  const clock = (T: number, t: number) => `12:${((t - T) * 60).toFixed(1).padStart(4, '0')}`;

  /**
   * After the shortcut, from t: hk rests at the base once, in spare time, till Y's own set-off 12:38.4 (not till the
   * 12:20.4 planned, and not twice), walks the 7 tiles of the short way to Y's door by 12:51 with no wait there, cleans Y
   * from 12:52.8 and rests at its door after; C keeps her break at the base till 12:30 and rests on there, with no room.
   */
  const expectHersByTheShortWay = (re: HotelState, sc: Scene, t: number, at: string) => {
    const { T, Y } = sc;
    expect(cleanerOf(re, Y), at).toEqual(['hk']);
    // one rest at the base from t, till Y's own set-off
    expect(baseRests(re, 'hk', T, t), at).toEqual([[+(t - T).toFixed(4), 0.64]]);
    expect(restsOf(re, 'hk').find(l => l.end > t + 1e-9 && sameTile(l.at, BASE)), at).toMatchObject({ idle: true });
    expect(where(re, 'hk', T + 0.6), at).toMatch(/^1\.000,4\.000,0 rest\/$/);
    // then the short way, at Y's door as its party goes out
    const way = walksOf(re, 'hk').filter(l => l.end > t);
    expect(way.map(l => [+(l.start - T).toFixed(4), +(l.end - T).toFixed(4)]), at).toEqual([[0.64, 0.85]]);
    expect(way[0].path.map(p => [p.gridX, p.gridY]), at).toEqual(SHORT_WAY);
    expect(waitsOf(re, 'hk').filter(l => l.end > t), at).toEqual([]);
    const clean = jobsOf(re, 'hk').filter(l => l.end > t);
    expect(clean.map(l => l.placeId), at).toEqual([Y.id]);
    expect(clean[0].start, at).toBeCloseTo(T + 0.88, 9);
    expect(restsOf(re, 'hk').filter(l => l.start > t + 1e-9 && !sameTile(l.at, BASE)).map(l => [l.at.gridX, l.at.gridY, +(l.start - T).toFixed(4)]), at)
      .toEqual([[DOOR_Y.gridX, DOOR_Y.gridY, 0.96]]);
    // C: her break at the base till 12:30, then spare time there; no room, no walk, no wait
    expect(jobsOf(re, 'c'), at).toEqual([]);
    expect(walksOf(re, 'c'), at).toEqual([]);
    expect(waitsOf(re, 'c'), at).toEqual([]);
    expect(restsOf(re, 'c').every(l => sameTile(l.at, BASE)), at).toBe(true);
    expect(restsOf(re, 'c').find(l => l.start < T + 0.49 && l.end > T + 0.49)!.idle ?? false, at).toBe(false);
    expect(restsOf(re, 'c').at(-1), at).toMatchObject({ idle: true });
    expect(restsOf(re, 'c').at(-1)!.start, at).toBeCloseTo(T + 0.5, 9);
  };

  /**
   * Her plan as if she'd been turned down at her set-off at 12:20.4 and rested on at the base till 12:38.4: her one rest
   * at the base split there into two spare-time rests back to back (the plan an edit made when it held her to the set-off
   * planned after a much shorter way). Left as it is if her rests there already break at 12:20.4.
   */
  const turnedDownAt = (s: HotelState, x: number): HotelState => {
    const plan = getStaffPlan(s);
    return { ...s, staffPlan: { ...plan, itineraries: plan.itineraries.map(it => (it.staffId !== 'hk' ? it : { ...it,
      legs: it.legs.flatMap(l => (l.kind === 'stay' && l.activity === 'rest' && l.idle && sameTile(l.at, BASE) && l.start < x - 1e-9 && l.end > x + 1e-9
        ? [{ ...l, end: x }, { ...l, start: x }] : [l])) })) } };
  };

  describe('Resting at home for her do-not-disturb room, a big shortcut to its door: she rests once, till its own later set-off, and the room stays hers', () => {
    it('as planned: hk rests at the base till 12:20.4, takes the 17 tiles round to Y\'s door by 12:51 and cleans Y; C breaks till 12:30, too far from Y to get there in time, then rests; the short way would be 7 tiles, 18 minutes too early at the door from 12:20.4', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const sc = scene();
        const { s, T, Y } = sc;
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(awayStretches(s.guests[0], Y).map(([a, b]) => [+(a - T).toFixed(4), +(b - T).toFixed(4)])).toEqual([[0.85, 0.98]]);
        expect(cleanerOf(s, Y)).toEqual(['hk']);
        expect(baseRests(s, 'hk', T, T)).toEqual([[0, 0.34]]);
        expect(restsOf(s, 'hk')[0]).toMatchObject({ idle: true, at: BASE });
        const [round] = walksOf(s, 'hk');
        expect(round.path.length - 1).toBe(17);
        expect(round.path.some(p => p.gridX === 0 && p.gridY === 3)).toBe(false);
        expect([round.start - T, round.end - T].map(x => +x.toFixed(4))).toEqual([0.34, 0.85]);
        expect(waitsOf(s, 'hk')).toEqual([]);
        expect(jobsOf(s, 'hk')[0].start).toBeCloseTo(T + 0.88, 9);
        // C: her compulsory break till 12:30, then spare time; 12:30 and 17 tiles would be 13:00.6, after the party's back
        expect(jobsOf(s, 'c')).toEqual([]);
        expect(restsOf(s, 'c').map(l => [+(l.start - T).toFixed(4), +(l.end - T).toFixed(4), l.idle ?? false])).toEqual([[0, 0.5, false], [0.5, 1, true]]);
        expect(0.5 + 17 * STEP).toBeGreaterThan(0.98);
        // nowhere near tired; C past the break mark
        for (const x of [T, T + 0.34, T + 0.64, T + 0.9]) expect(energyAt(s, 'hk', x)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, 'c', T)).toBeGreaterThanOrEqual(STAFF_FATIGUE.breakAt);
        // the short way: 7 tiles; set off at 12:20.4 she'd be at the door 0.3h before the party's out, more than she waits
        expect(SHORT_WAY.length - 1).toBe(7);
        expect(0.85 - (0.34 + 7 * STEP)).toBeGreaterThan(GUEST_HOUSEKEEPING.dndMaxWait);
        expect(0.34 + 17 * STEP).toBeCloseTo(0.85, 9);
        expect(0.64 + 7 * STEP).toBeCloseTo(0.85, 9);
        expect(cleanedBy13(s, Y)).toBe(3);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: the room at (0, 3) demolished at 12:03-12:18 as she rests: she rests on at the base once, till 12:38.4, walks the 7 tiles up column 0 to Y's door by 12:51 and cleans Y; C keeps her break and rests, with no room`, () => withDesk(desk, () => {
        const sc = scene();
        const { T, Y, wall } = sc;
        for (const dt of [0.05, 5 / 60, 0.15, 0.25, 0.3]) {
          const t = T + dt, at = `demolished at ${clock(T, t)}`;
          expect(where(sc.s, 'hk', t), at).toMatch(/^1\.000,4\.000,0 rest\/$/);
          const re = demolished(sc, t);
          expect(re.rooms.some(r => r.id === wall.id), at).toBe(false);
          expectHersByTheShortWay(re, sc, t, at);
          expect(cleanedBy13(re, Y), at).toBe(3);
        }
      }));
    }

    for (const desk of DESKS) {
      it(`desk ${desk}: demolished at 12:05, then an edit that brings nobody anything (a paused re-plan, or a room built off everyone's way) at 12:09-12:33: both plans stay as they were, and Y stays hk's`, () => withDesk(desk, () => {
        const sc = scene();
        const { T, Y } = sc;
        const re = demolished(sc, T + 5 / 60);
        expect(cleanerOf(re, Y), 'at the demolition').toEqual(['hk']);
        for (const dt of [0.15, 0.25, 0.3, 0.4, 0.55]) {
          const t = T + dt;
          for (const [kind, after] of nothingNew(re, t)) {
            const at = `${kind} at ${clock(T, t)}`;
            // not handed to C, who'd walk the short way at 12:30 and wait at Y's door 12:42.6-12:51
            expect(cleanerOf(after, Y), at).toEqual(['hk']);
            expect(waitsOf(after, 'c'), at).toEqual([]);
            if (t < T + 0.5) expectHersByTheShortWay(after, sc, t, at);
            expect(samePlan(after, re, 'hk', t), at).toBe(true);
            expect(samePlan(after, re, 'c', t), at).toBe(true);
          }
        }
        // one after another: a room built at 12:09, a paused re-plan at 12:15, another room built at 12:18, a paused re-plan at 12:24
        let s = re;
        for (const [dt, kind, x] of [[0.15, 'built', 6], [0.25, 'paused', 6], [0.3, 'built', 8], [0.4, 'paused', 8]] as const) {
          s = EDITS[kind](s, T + dt, x);
          expect(cleanerOf(s, Y), `${kind} at ${clock(T, T + dt)}, after the others`).toEqual(['hk']);
        }
        expect(samePlan(s, re, 'hk', T + 0.4)).toBe(true);
        expect(samePlan(s, re, 'c', T + 0.4)).toBe(true);
        expect(cleanedBy13(s, Y)).toBe(3);
      }));
    }

    for (const desk of DESKS) {
      it(`desk ${desk}: turned down at her set-off and resting on at the base -- two spare-time rests back to back, 12:05-12:20.4 and 12:20.4-12:38.4 -- an edit with nothing new during the first is still a rest at home for Y: she rests on till 12:38.4 and Y stays hers`, () => withDesk(desk, () => {
        const sc = scene();
        const { T, Y } = sc;
        // (the demolition re-planned once: with a named desk, Settle's second re-plan at the same moment is itself an edit with nothing new)
        const twice = turnedDownAt(replanStaff(demolishRoom(sc.s, sc.wall.id)!, T + 5 / 60, sc.s), T + 0.34);
        expect(cleanerOf(twice, Y)).toEqual(['hk']);
        expect(baseRests(twice, 'hk', T, T + 5 / 60)).toEqual([[0.0833, 0.34], [0.34, 0.64]]);
        expect(restsOf(twice, 'hk').filter(l => sameTile(l.at, BASE)).every(l => l.idle)).toBe(true);
        expect(walksOf(twice, 'hk').map(l => +(l.start - T).toFixed(4))).toEqual([0.64]);
        expect(jobsOf(twice, 'c')).toEqual([]);
        for (const dt of [0.15, 0.25, 0.3]) {
          const t = T + dt;
          for (const [kind, after] of nothingNew(twice, t)) {
            const at = `${kind} at ${clock(T, t)}`;
            expectHersByTheShortWay(after, sc, t, at);
            expect(samePlan(after, twice, 'hk', t), at).toBe(true);
            expect(samePlan(after, twice, 'c', t), at).toBe(true);
          }
        }
        expect(cleanedBy13(EDITS.built(twice, T + 0.25), Y)).toBe(3);
      }));
    }
  });
}

// Another party's chance that came round only as she rested (her energy dropping under 60, so a room the hour's plan judged at her tired rate now fits) doesn't send her off early on an edit with nothing new, but a room a let-go leaves still does.
{
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  const FAR = { gridX: 8, gridY: 1, floor: 0 };
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', stamina: 'high', workHours: 0 },
    mid: { experience: 'skilled', style: 'standard', stamina: 'normal', workHours: 100 },
  } as const;

  /** A housekeeper (a turnover runner) standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number, speed: keyof typeof SPEEDS): StaffMember {
    const p = SPEEDS[speed];
    return { id, serial: id.length + 1, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: p.stamina, specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build or a hire). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: four standard rooms on row 5 from x = 3, their doors up onto the base's row 4. A (6, 5): a
   * do-not-disturb party out of the room 12:40.8-12:58.8, 0.15h of daily cleaning; B (3, 5): one out 12:49.8-13:07.8,
   * 0.1h. hk (slow: a rookie, meticulous, high stamina) at `energy` at 12:00, the only housekeeper unless `mate`, at
   * the base or at (8, 1). Just over 60 at 12:00, she's on her tired rate as the hour is planned, and A's party isn't out
   * long enough for her at it: she rests at the base (from 12:18, if she walks home from (8, 1)) till 12:46.2, walks to
   * B's door as its party goes out and cleans B from 12:51.6 into the next hour. Resting, she's under 60 by 12:01.8 (from
   * the base) or about 12:25 (home from (8, 1)), and from then A fits her rate from home: a set-off at 12:31.8. `mate`: hk2
   * (skilled, fresh) at the base too, who cleans A.
   */
  function scene(start: 'base' | 'far', energy = 60.3, mate = false) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    const abs = 2 * 24 + 12, [B, , , A] = s.rooms;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null,
      staff: { ...s.staff, housekeepers: mate ? 2 : 1, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', start === 'base' ? BASE : FAR, abs, energy, 'slow'), ...(mate ? [keeper('hk2', BASE, abs, 20, 'mid')] : [])] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, A, T + 0.62, T + 1.04, 'ga'), goingOut(s, B, T + 0.77, T + 1.19, 'gb')],
      rooms: s.rooms.map(r => (r.id === A.id ? { ...r, status: 'occupied' as const, guestId: 'ga', dailyCleanHoursRemaining: 0.15 }
        : r.id === B.id ? { ...r, status: 'occupied' as const, guestId: 'gb', dailyCleanHoursRemaining: 0.1 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, A, B };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** When she next sets off from where she is at t: the start of her first walk from then. */
  const setOff = (s: HotelState, id: string, t: number) => legsOf(s, id).find(l => l.kind === 'walk' && l.start >= t - 1e-9)?.start;
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  const energyAt = (s: HotelState, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === 'hk')!, x);
  const away = (s: HotelState, g: number, room: Room, T: number) => awayStretches(s.guests[g], room).map(([a, b]) => [+(a - T).toFixed(3), +(b - T).toFixed(3)]);
  /** The day each room was last given its daily clean, after playing on two hours (B's clean runs into 13:00). */
  const cleanedDay = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** The edits that bring her nothing new: a paused edit, a maintenance hire, a room built off her way at (8, 2). */
  const edits = (s: HotelState, t: number) => ({
    paused: replanStaff(s, t),
    hire: settleChanges(s, hireCandidate(s, 'maintenance', hiringCandidates(s, 'maintenance')[0].id, undefined, t)!, t),
    built: settleChanges(s, addRoom(s, 'standard', 8, 2, 0, 'up')!, t),
  });
  /** Her plan after an edit at t, against the hour's: resting at the base till 12:46.2, no wait at a door, B hers and cleaned, A not. */
  const expectAsPlanned = (re: HotelState, s: HotelState, T: number, t: number, A: Room, B: Room, at: string) => {
    // resting at the base till the set-off already planned, 12:46.2, not off at 12:31.8 for A
    const rest = restsOf(re, 'hk').find(l => l.end > t + 1e-9)!;
    expect(rest, at).toMatchObject({ idle: true, at: BASE });
    expect(setOff(re, 'hk', t)! - T, at).toBeCloseTo(0.77, 9);
    // at 12:36 she's still resting at the base, not walking to A or waiting at a door
    expect(where(re, 'hk', T + 0.6), at).toMatch(/^1\.000,4\.000,0 rest/);
    expect(waitsOf(re, 'hk').filter(l => l.end > t + 1e-9), at).toEqual([]);
    expect(jobsOf(re, 'hk').filter(l => l.end > t + 1e-9).map(l => l.placeId), at).toEqual([B.id]);
    expect(cleanedDay(re, [A, B]), at).toEqual([0, 3]);
    // nothing new: her plan for the rest of the hour is the one she had
    expect(samePlan(re, s, 'hk', t), at).toBe(true);
  };
  const clock = (dt: number) => `12:${(dt * 60).toFixed(1).padStart(4, '0')}`;

  describe('Resting at home for her own do-not-disturb room, another party\'s chance comes round only as she rests: an edit with nothing new doesn\'t send her off early for it', () => {
    it('as planned: just over 60 at 12:00, she rests at the base till 12:46.2 and cleans B, A\'s party out too short for her tired rate; under 60 from 12:01.8 (about 12:25 home from (8, 1)), and a keeper under 60 at 12:00 takes A', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        for (const start of ['base', 'far'] as const) {
          const { s, T, A, B } = scene(start);
          expect(namedFrontDesk(s)).toBe(desk === 'named');
          expect(away(s, 0, A, T)).toEqual([[0.68, 0.98]]);
          expect(away(s, 1, B, T)).toEqual([[0.83, 1.13]]);
          const [home] = restsOf(s, 'hk');
          expect(home).toMatchObject({ idle: true, at: BASE });
          expect(home.start - T).toBeCloseTo(start === 'base' ? 0 : 0.3, 9);
          expect(home.end - T).toBeCloseTo(0.77, 9);
          expect(waitsOf(s, 'hk')).toEqual([]);
          expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([B.id]);
          expect(jobsOf(s, 'hk')[0].start - T).toBeCloseTo(0.86, 9);
          expect(cleanedDay(s, [A, B])).toEqual([0, 3]);
          // tired as the hour's planned; under the mark as she rests: from the base at 12:01.8, home from (8, 1) at about 12:25
          expect(energyAt(s, T)).toBeGreaterThan(STAFF_FATIGUE.tiredAt);
          const [over, under] = start === 'base' ? [0.02, 0.03] : [0.41, 0.43];
          expect(energyAt(s, T + over)).toBeGreaterThan(STAFF_FATIGUE.tiredAt);
          expect(energyAt(s, T + under)).toBeLessThanOrEqual(STAFF_FATIGUE.tiredAt + 1e-9);
          // the chance is real once she's under the mark: started at 59.5, she cleans A
          const fresh = scene(start, 59.5);
          expect(jobsOf(fresh.s, 'hk').map(l => l.placeId)).toContain(A.id);
        }
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: resting at the base from 12:00, a paused edit, a maintenance hire or a room built off her way at 12:01.8-12:30, her energy under 60: she rests on till 12:46.2 and cleans B, not A (B kept its daily clean)`, () => withDesk(desk, () => {
        const { s, T, A, B } = scene('base');
        for (const dt of [0.03, 0.1, 0.2, 0.3, 0.4, 0.45, 0.5]) {
          const t = T + dt;
          expect(energyAt(s, t)).toBeLessThanOrEqual(STAFF_FATIGUE.tiredAt + 1e-9);
          for (const [kind, re] of Object.entries(edits(s, t))) expectAsPlanned(re, s, T, t, A, B, `${kind} at ${clock(dt)}`);
        }
      }));

      it(`desk ${desk}: home from (8, 1) by 12:18, a paused edit, a maintenance hire or a room built off her way at 12:26.4-12:30, her energy under 60: she rests on till 12:46.2, with no wait at B's door, and cleans B`, () => withDesk(desk, () => {
        const { s, T, A, B } = scene('far');
        for (const dt of [0.44, 0.45, 0.47, 0.5]) {
          const t = T + dt;
          expect(energyAt(s, t)).toBeLessThan(STAFF_FATIGUE.tiredAt);
          for (const [kind, re] of Object.entries(edits(s, t))) expectAsPlanned(re, s, T, t, A, B, `${kind} at ${clock(dt)}`);
        }
      }));
    }

    it('control: hk2, who was to clean A, let go at 12:06-12:30: A is new work for her, and she leaves the base for it before 12:46.2 and cleans it', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B } = scene('base', 60.3, true);
        // as planned: hk rests at the base till 12:46.2 for B, hk2 cleans A
        expect(restsOf(s, 'hk')[0]).toMatchObject({ idle: true, at: BASE });
        expect(setOff(s, 'hk', T)! - T).toBeCloseTo(0.77, 9);
        expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([B.id]);
        expect(jobsOf(s, 'hk2').map(l => l.placeId)).toEqual([A.id]);
        expect(cleanedDay(s, [A, B])).toEqual([3, 3]);
        for (const dt of [0.1, 0.2, 0.3, 0.45, 0.5]) {
          const t = T + dt, at = `let go at ${clock(dt)}`;
          const re = settleChanges(s, dismissStaff(s, 'hk2', t)!, t);
          expect(setOff(re, 'hk', t)!, at).toBeLessThan(T + 0.77 - 1e-9);
          expect(where(re, 'hk', T + 0.6), at).not.toMatch(/rest/);
          expect(jobsOf(re, 'hk').filter(l => l.end > t + 1e-9)[0]?.placeId, at).toBe(A.id);
          expect(cleanedDay(re, [A])[0], at).toBe(3);
        }
      });
    });
  });
}

// A room a colleague re-planned before her gives up for the edit's new work (a room dirtied, or a let-go's room) is new work for a housekeeper resting at home for her own do-not-disturb room: she sets off for it at its own set-off and both rooms are cleaned, while an edit with nothing new leaves every plan as it was.
{
  // Resting at home for her own do-not-disturb room, a room a colleague re-planned before her gives up for the edit's new work (a room dirtied, or a let-go's room) is new work: she sets off for it at its own set-off, and both rooms are cleaned.
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  const SPEEDS = {
    mid: { experience: 'skilled', style: 'standard', workHours: 100 },
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;

  /** A housekeeper (a turnover runner, high stamina, fresh) standing in `room`. */
  function keeper(id: string, room: Room, abs: number, speed: keyof typeof SPEEDS): StaffMember {
    const p = SPEEDS[speed];
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: roomTile(room),
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: three standard rooms on row 2 from x = 3, their doors up; the base at (1, 4). Two do-not-disturb
   * rooms: D2 (4, 2), its party out of the room 12:36.6-12:48.0, 0.1h of daily cleaning; D1 (3, 2), out 12:48.6-13:01.2,
   * 0.17h. X (5, 2) is empty. Everyone starts in X, fresh, and walks home to the base by 12:14.4. hk-b (skilled) rests
   * there till 12:25.8 and cleans D2 12:38.4-12:44.4 (D1 after it wouldn't fit her); hk-a (a veteran, speedy), after
   * her on the roster, rests there till 12:39.6 and cleans D1 12:50.4-12:57.2.
   * `letGo`: X is L, a third do-not-disturb room (its party out 12:21.6-12:44.4, 0.3h), and hk-c (skilled), first on
   * the roster, waits at its door and cleans it 12:23.4-12:41.4.
   */
  function scene(letGo: boolean) {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 3; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
    const abs = 2 * 24 + 12, [D1, D2, X] = s.rooms;
    const roster = [...(letGo ? [keeper('hk-c', X, abs, 'mid')] : []), keeper('hk-b', X, abs, 'mid'), keeper('hk-a', X, abs, 'fast')];
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null,
      staff: { ...s.staff, housekeepers: roster.length, maintenanceWorkers: 0 }, staffRoster: roster };
    s = syncStaff(s);
    const T = hourStart(s);
    const daily = new Map<string, [string, number]>([[D1.id, ['g1', 0.17]], [D2.id, ['g2', 0.1]], ...(letGo ? [[X.id, ['g3', 0.3]] as [string, [string, number]]] : [])]);
    s = { ...s, guests: [goingOut(s, D1, T + 0.75, T + 1.08, 'g1'), goingOut(s, D2, T + 0.55, T + 0.86, 'g2'), ...(letGo ? [goingOut(s, X, T + 0.3, T + 0.8, 'g3')] : [])],
      rooms: s.rooms.map(r => (daily.has(r.id) ? { ...r, status: 'occupied' as const, guestId: daily.get(r.id)![0], dailyCleanHoursRemaining: daily.get(r.id)![1] } : r)) };
    const names: Record<string, string> = { [D1.id]: 'D1', [D2.id]: 'D2', [X.id]: letGo ? 'L' : 'X' };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, D1, D2, X, names };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const clock = (T: number, x: number) => `12:${((x - T) * 60).toFixed(1).padStart(4, '0')}`;
  /** Her cleans still to come after t, by room and time: 'D2 12:38.4-12:42.4'. */
  const jobsAfter = (s: HotelState, id: string, t: number, names: Record<string, string>) => legsOf(s, id)
    .filter((l): l is StayLeg => l.kind === 'stay' && !!l.job && l.end > t + 1e-9)
    .map(l => `${names[l.placeId!] ?? l.placeId} ${clock(hourStart(s), l.start)}-${clock(hourStart(s), l.end)}`);
  /** When she leaves the base: the end of her last rest there. */
  const leavesBase = (s: HotelState, id: string) => {
    const rest = legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest' && l.at.gridX === BASE.gridX && l.at.gridY === BASE.gridY).at(-1);
    return rest ? clock(hourStart(s), rest.end) : 'never';
  };
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const doing = (s: HotelState, id: string, x: number) => where(s, id, x).split(' ')[1].split('/')[0];
  /** The same whereabouts from t to the hour's end, or the first moment they differ. */
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${clock(hourStart(a), x)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  /** The day each room was last given its daily clean, and how it stands, after playing on two hours. */
  const after = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => { const x = st.rooms.find(y => y.id === r.id)!; return `${x.lastDailyCleanDay ?? 0} ${x.status}`; });
  };
  const dirty = (s: HotelState, room: Room, hours: number): HotelState =>
    ({ ...s, rooms: s.rooms.map(r => (r.id === room.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: hours } : r)) });

  describe('Resting at home for her own do-not-disturb room, a colleague re-planned before her gives up another for the edit\'s new work: it\'s new work for her', () => {
    it('as planned: hk-b rests at the base till 12:25.8 and cleans D2 12:38.4-12:44.4; hk-a rests there till 12:39.6 and cleans D1 12:50.4-12:57.2; in the let-go scene hk-c cleans L 12:23.4-12:41.4; every room cleaned', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        for (const letGo of [false, true]) {
          const { s, T, D1, D2, X, names } = scene(letGo);
          expect(namedFrontDesk(s)).toBe(desk === 'named');
          // planned in roster order: hk-b before hk-a (hk-c first of all)
          expect(s.staffRoster!.filter(m => m.role === 'housekeeper').map(m => m.id)).toEqual([...(letGo ? ['hk-c'] : []), 'hk-b', 'hk-a']);
          expect(leavesBase(s, 'hk-b')).toBe('12:25.8');
          expect(jobsAfter(s, 'hk-b', T, names)).toEqual(['D2 12:38.4-12:44.4']);
          expect(leavesBase(s, 'hk-a')).toBe('12:39.6');
          expect(jobsAfter(s, 'hk-a', T, names)).toEqual(['D1 12:50.4-12:57.2']);
          // her rest at the base is a rest at home for D1's party: spare time
          expect(legsOf(s, 'hk-a').find(l => l.kind === 'stay' && l.activity === 'rest')).toMatchObject({ idle: true, at: BASE });
          if (letGo) {
            expect(jobsAfter(s, 'hk-c', T, names)).toEqual(['L 12:23.4-12:41.4']);
            expect(after(s, [D1, D2, X])).toEqual(['3 occupied', '3 occupied', '3 occupied']);
          } else expect(after(s, [D1, D2])).toEqual(['3 occupied', '3 occupied']);
        }
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: X dirtied (0.5h of turnover) at 12:03-12:21, as hk-a walks home or rests at the base: hk-b takes X and gives up D2; hk-a sets off for D2 at its own set-off, 12:25.8, not at 12:39.6, cleans it, then D1 as planned: both cleaned`, () => withDesk(desk, () => {
        const { s, T, D1, D2, X, names } = scene(false);
        for (const dt of [0.05, 0.1, 0.2, 0.25, 0.35]) {
          const t = T + dt, at = `X dirtied at ${clock(T, t)}`;
          const re = settleChanges(s, dirty(s, X, 0.5), t);
          // hk-b, planned first, takes the turnover and gives up D2
          const bJobs = jobsAfter(re, 'hk-b', t, names);
          expect(bJobs.map(j => j.split(' ')[0]), at).toEqual(['X']);
          // D2 is new work for hk-a: off from the base at its own set-off (hk-b's in the hour's plan), at 12:30 on her
          // way, D2 cleaned as its party is out, and D1 cleaned as planned
          expect({ at, leaves: leavesBase(re, 'hk-a'), at1230: doing(re, 'hk-a', T + 0.5), jobs: jobsAfter(re, 'hk-a', t, names) })
            .toEqual({ at, leaves: leavesBase(s, 'hk-b'), at1230: 'walk', jobs: ['D2 12:38.4-12:42.4', 'D1 12:50.4-12:57.2'] });
          expect(after(re, [D1, D2, X]), at).toEqual(['3 occupied', '3 occupied', '0 vacant']);
        }
      }));

      it(`desk ${desk}: hk-c let go at 12:03-12:09, as hk-a walks home: hk-b takes L (the let-go's room) and gives up D2; hk-a sets off for D2 at its own set-off, 12:25.8, not at 12:39.6, cleans it, then D1 as planned: all three cleaned`, () => withDesk(desk, () => {
        const { s, T, D1, D2, X: L, names } = scene(true);
        for (const dt of [0.05, 0.1, 0.15]) {
          const t = T + dt, at = `hk-c let go at ${clock(T, t)}`;
          const re = settleChanges(s, dismissStaff(s, 'hk-c', t)!, t);
          // hk-b, planned first, takes L and gives up D2
          expect(jobsAfter(re, 'hk-b', t, names), at).toEqual(['L 12:23.4-12:41.4']);
          // D2 is new work for hk-a, though it wasn't the let-go's
          expect({ at, leaves: leavesBase(re, 'hk-a'), at1230: doing(re, 'hk-a', T + 0.5), jobs: jobsAfter(re, 'hk-a', t, names) })
            .toEqual({ at, leaves: leavesBase(s, 'hk-b'), at1230: 'walk', jobs: ['D2 12:38.4-12:42.4', 'D1 12:50.4-12:57.2'] });
          expect(after(re, [D1, D2, L]), at).toEqual(['3 occupied', '3 occupied', '3 occupied']);
        }
      }));
    }

    it('control: a room built off everyone\'s way at (8, 2), or a paused edit, at 12:03-12:21 brings nobody anything new: every plan as it was, hk-a resting at the base till 12:39.6 for D1 and hk-b cleaning D2', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        for (const letGo of [false, true]) {
          const { s, T, D1, D2, X, names } = scene(letGo);
          for (const dt of [0.05, 0.1, 0.2, 0.25, 0.35]) {
            const t = T + dt;
            for (const [kind, re] of [['built', settleChanges(s, addRoom(s, 'standard', 8, 2, 0, 'up')!, t)], ['paused', replanStaff(s, t)]] as const) {
              const at = `${letGo ? 'let-go scene' : 'dirtied scene'}, ${kind} at ${clock(T, t)}`;
              for (const id of [...(letGo ? ['hk-c'] : []), 'hk-b', 'hk-a']) expect(samePlan(re, s, id, t), `${at}: ${id}`).toBe(true);
              expect({ at, leaves: leavesBase(re, 'hk-a'), jobs: jobsAfter(re, 'hk-a', t, names), b: jobsAfter(re, 'hk-b', t, names) })
                .toEqual({ at, leaves: '12:39.6', jobs: ['D1 12:50.4-12:57.2'], b: ['D2 12:38.4-12:44.4'] });
              if (kind === 'built') expect(after(re, [D1, D2]), at).toEqual(['3 occupied', '3 occupied']);
            }
          }
        }
      });
    });
  });
}

// With the set-off planned timed by a colleague's room and her own room one she'd reach from home only once its party is out (next hour, or later this hour but in time to clean it), an edit with nothing new keeps that set-off: she walks on home, rests there till it and walks on, rather than standing in the hallway.
{
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A slow housekeeper (a meticulous rookie, high stamina, turnover runner) standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, serial: number, at: TilePos, abs: number, fatigue: number): StaffMember {
    return { id, serial, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: 'rookie', style: 'meticulous', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: 0, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build or a hire). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: eight standard rooms on row 2 (x 1..8, doors up onto row 1), an entrance at (0, 1), and a room at
   * (0, 3) closing the short way from the base: from the north side the way home is the long way round by (9, 2), and
   * from the base to R2's door (2, 1) is 18 tiles, 32.4 min (to R6's door (6, 1), 14 tiles, 25.2 min). Three slow
   * rookies, in roster order c (75, tired), a (60.6) at (8, 3) and b (30) at the base. Two do-not-disturb rooms, 0.05h of
   * daily cleaning each:
   * - 'nextHour': c at (5, 0); R2 (2, 2) out of the room 12:55.9-13:12.5, R6 (6, 2) out 12:55.8-13:20. The hour's plan:
   *   c walks home the long way (there 12:28.8), rests there till 12:30.6 -- R6's set-off from the base, though R6 is
   *   a's -- then walks to R2's door, there at 13:03 (from home she'd be at its door only once its party is out, and only
   *   next hour). a walks home, rests there till 12:30.6 too and cleans R6; b rests at the base all hour.
   * - 'thisHour': c at (9, 1); R2 out 12:48-13:10.2, R6 out 12:46.8-13:20. The hour's plan: c walks home (there
   *   12:19.8), rests there till 12:21.6 (R6's set-off from the base) and walks to R2's door, there at 12:54, six minutes
   *   after its party is out, and cleans it from 12:55.8. a cleans R6 from 12:48.6.
   */
  function scene(kind: 'nextHour' | 'thisHour') {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 1; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
    s = addFixture(s, 'entrance', 0, 1, 0)!;
    s = addRoom(s, 'standard', 0, 3, 0, 'up')!; // closes the short way from the base
    const abs = 2 * 24 + 12;
    const cAt = kind === 'nextHour' ? { gridX: 5, gridY: 0, floor: 0 } : { gridX: 9, gridY: 1, floor: 0 };
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 3, maintenanceWorkers: 0 },
      staffRoster: [keeper('c', 1, cAt, abs, 75), keeper('a', 2, { gridX: 8, gridY: 3, floor: 0 }, abs, 60.6), keeper('b', 3, BASE, abs, 30)] };
    s = syncStaff(s);
    const T = hourStart(s);
    const R2 = s.rooms.find(r => r.gridX === 2 && r.gridY === 2)!, R6 = s.rooms.find(r => r.gridX === 6 && r.gridY === 2)!;
    const [l2, b2, l6, b6] = kind === 'nextHour' ? [0.871, 1.268, 0.87, 1.394] : [0.74, 1.23, 0.72, 1.394];
    s = { ...s, guests: [goingOut(s, R2, T + l2, T + b2, 'g2'), goingOut(s, R6, T + l6, T + b6, 'g6')],
      rooms: s.rooms.map(r => (r.id === R2.id ? { ...r, status: 'occupied' as const, guestId: 'g2', dailyCleanHoursRemaining: 0.05 }
        : r.id === R6.id ? { ...r, status: 'occupied' as const, guestId: 'g6', dailyCleanHoursRemaining: 0.05 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, R2, R6 };
  }

  const itineraryOf = (s: HotelState, id: string) => getStaffPlan(s).itineraries.find(it => it.staffId === id)!;
  const legsOf = (s: HotelState, id: string): Leg[] => itineraryOf(s, id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  const walksOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is WalkLeg => l.kind === 'walk');
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** What someone stops to do from t on: each stay's activity, spot and times (walks between them can take another way as long). */
  const staysFrom = (s: HotelState, id: string, t: number) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.end > t + 1e-9)
    .map(l => `${l.activity}${l.idle ? ' (spare)' : ''}${l.job ? ` ${l.placeId}` : ''} at ${l.at.gridX},${l.at.gridY} ${(l.start - hourStart(s)).toFixed(4)}-${(l.end - hourStart(s)).toFixed(4)}`);
  const away = (s: HotelState, g: string, room: Room, T: number) =>
    awayStretches(s.guests.find(x => x.id === g)!, room).map(([a, b]) => [+(a - T).toFixed(3), +(b - T).toFixed(3)]);
  /** The day each room was last given its daily clean, once two hours are played (the cleans run past 13:00). */
  const cleanedBy14 = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** The edits that bring c nothing new: a paused edit, a maintenance hire, a room built far off at (6, 5). */
  const edits = (s: HotelState, t: number) => ({
    paused: replanStaff(s, t),
    hire: settleChanges(s, hireCandidate(s, 'maintenance', hiringCandidates(s, 'maintenance')[0].id, undefined, t)!, t),
    built: settleChanges(s, addRoom(s, 'standard', 6, 5, 0, 'up')!, t),
  });
  const clock = (dt: number) => `12:${(dt * 60).toFixed(1).padStart(4, '0')}`;
  /** The edit times: 12:01.2 to 12:05.4, c still a long way from home. */
  const TIMES = [0.02, 0.035, 0.05, 0.07, 0.09];
  /** The hour's plan for c, by scene: home at, resting there till (the set-off planned), at R2's door at, and (this hour) cleaning R2 from. */
  const PLANNED = { nextHour: { home: 0.48, setOff: 0.51, door: 1.05, clean: null }, thisHour: { home: 0.33, setOff: 0.36, door: 0.9, clean: 0.93 } } as const;

  /** c's plan after an edit at t, against the hour's: on home, resting at the base till the set-off planned, never standing in the hallway, then on to R2. */
  const expectAsPlanned = (re: HotelState, s: HotelState, kind: keyof typeof PLANNED, T: number, t: number, R2: Room, R6: Room, at: string) => {
    const p = PLANNED[kind];
    // she doesn't stop on her way to stand in the hallway
    expect(waitsOf(re, 'c').filter(l => l.end > t + 1e-9).map(l => `${l.at.gridX},${l.at.gridY}`), at).toEqual([]);
    // she walks on home and rests there (spare time) till the set-off already planned
    const rest = restsOf(re, 'c').find(l => l.end > t + 1e-9);
    expect(rest, at).toMatchObject({ idle: true, at: BASE });
    expect(rest!.start - T, at).toBeCloseTo(p.home, 9);
    expect(rest!.end - T, at).toBeCloseTo(p.setOff, 9);
    // a minute after she's home she's resting at the base
    expect(where(re, 'c', T + p.home + 0.01), at).toMatch(/^1\.000,4\.000,0 rest/);
    // from the base she sets off at the time planned, and is at R2's door when planned
    const toR2 = walksOf(re, 'c').find(l => l.start >= p.setOff + T - 1e-9)!;
    expect(toR2.start - T, at).toBeCloseTo(p.setOff, 9);
    expect(toR2.path.at(-1), at).toMatchObject({ gridX: 2, gridY: 1 });
    expect(toR2.end - T, at).toBeCloseTo(p.door, 9);
    if (p.clean === null) {
      // still on her way to R2 at the hour's end
      expect(jobsOf(re, 'c'), at).toEqual([]);
      expect(itineraryOf(re, 'c').end.roomId, at).toBe(R2.id);
    } else {
      expect(jobsOf(re, 'c').map(l => l.placeId), at).toEqual([R2.id]);
      expect(jobsOf(re, 'c')[0].start - T, at).toBeCloseTo(p.clean, 9);
    }
    // nothing new: what she and a stop to do for the rest of the hour is as planned, and both rooms get their clean
    expect(staysFrom(re, 'c', t), at).toEqual(staysFrom(s, 'c', t));
    expect(staysFrom(re, 'a', t), at).toEqual(staysFrom(s, 'a', t));
    expect(cleanedBy14(re, [R2, R6]), at).toEqual([3, 3]);
  };

  describe('On her way home to rest for her do-not-disturb room, which from home she\'d reach only once its party is out: an edit with nothing new keeps the set-off planned, and she rests at home till it rather than stand in the hallway', () => {
    it('as planned (R2 next hour): c walks home the long way by 12:28.8, rests at the base till 12:30.6 (R6\'s set-off from there, R6 a\'s), and is on her way to R2 at the hour\'s end, at its door at 13:03, after its party is out', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, R2, R6 } = scene('nextHour');
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, 'g2', R2, T)).toEqual([[0.931, 1.208]]);
        expect(away(s, 'g6', R6, T)).toEqual([[0.93, 1.334]]);
        const [home, toR2] = walksOf(s, 'c');
        expect([home.start - T, home.end - T].map(x => +x.toFixed(6))).toEqual([0, 0.48]);
        expect(home.path).toContainEqual({ gridX: 9, gridY: 2, floor: 0 }); // the long way round
        expect(restsOf(s, 'c')).toHaveLength(1);
        expect(restsOf(s, 'c')[0]).toMatchObject({ idle: true, at: BASE });
        expect([restsOf(s, 'c')[0].start - T, restsOf(s, 'c')[0].end - T].map(x => +x.toFixed(6))).toEqual([0.48, 0.51]);
        // 18 tiles from the base to R2's door: there at 13:03, its party out since 12:55.9; from home she could be there as
        // they go out only by leaving at 12:23.5, before she's home
        expect(toR2.path.length - 1).toBe(18);
        expect(toR2.end - T).toBeCloseTo(0.51 + 18 * STEP, 9);
        expect(0.931 - 18 * STEP).toBeLessThan(0.48);
        expect(waitsOf(s, 'c')).toEqual([]);
        expect(jobsOf(s, 'c')).toEqual([]);
        expect(itineraryOf(s, 'c').end.roomId).toBe(R2.id);
        // R6's set-off from the base is 12:30.6 (14 tiles before its party's out at 12:55.8): a rests there till then and cleans it
        expect(0.93 - 14 * STEP).toBeCloseTo(0.51, 9);
        expect(restsOf(s, 'a')[0]).toMatchObject({ idle: true, at: BASE });
        expect(restsOf(s, 'a')[0].end - T).toBeCloseTo(0.51, 9);
        expect(jobsOf(s, 'a').map(l => l.placeId)).toEqual([R6.id, R6.id]);
        expect(cleanedBy14(s, [R2, R6])).toEqual([3, 3]);
      });
    });

    it('as planned (R2 this hour): c walks home by 12:19.8, rests at the base till 12:21.6 (R6\'s set-off from there), and is at R2\'s door at 12:54, six minutes after its party is out, cleaning it from 12:55.8', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, R2, R6 } = scene('thisHour');
        expect(away(s, 'g2', R2, T)).toEqual([[0.8, 1.17]]);
        expect(away(s, 'g6', R6, T)).toEqual([[0.78, 1.334]]);
        const [home, toR2] = walksOf(s, 'c');
        expect([home.start - T, home.end - T].map(x => +x.toFixed(6))).toEqual([0, 0.33]);
        expect(restsOf(s, 'c')).toHaveLength(1);
        expect(restsOf(s, 'c')[0]).toMatchObject({ idle: true, at: BASE });
        expect([restsOf(s, 'c')[0].start - T, restsOf(s, 'c')[0].end - T].map(x => +x.toFixed(6))).toEqual([0.33, 0.36]);
        expect(0.78 - 14 * STEP).toBeCloseTo(0.36, 9);
        // from home she could be at R2's door as its party goes out only by leaving at 12:15.6, before she's home
        expect(toR2.end - T).toBeCloseTo(0.36 + 18 * STEP, 9);
        expect(0.8 - 18 * STEP).toBeLessThan(0.33);
        expect(waitsOf(s, 'c')).toEqual([]);
        expect(jobsOf(s, 'c').map(l => l.placeId)).toEqual([R2.id]);
        expect(jobsOf(s, 'c')[0].start - T).toBeCloseTo(0.93, 9);
        expect(jobsOf(s, 'a').map(l => l.placeId)).toContain(R6.id);
        expect(cleanedBy14(s, [R2, R6])).toEqual([3, 3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a paused edit, a maintenance hire or a room built at (6, 5) at 12:01.2-12:05.4: she walks on home, rests at the base till 12:30.6 and walks on to R2, not standing in the hallway till about 12:47`, () => withDesk(desk, () => {
        const { s, T, R2, R6 } = scene('nextHour');
        for (const dt of TIMES) {
          const t = T + dt;
          for (const [kind, re] of Object.entries(edits(s, t))) expectAsPlanned(re, s, 'nextHour', T, t, R2, R6, `${kind} at ${clock(dt)}`);
        }
      }));

      it(`desk ${desk}: from the set-off planned she'd be at R2's door after its party is out but in time to clean it this hour: an edit at 12:01.2-12:05.4 with nothing new has her rest at the base till 12:21.6 and clean R2 from 12:55.8, not stand in the hallway`, () => withDesk(desk, () => {
        const { s, T, R2, R6 } = scene('thisHour');
        for (const dt of TIMES) {
          const t = T + dt;
          for (const [kind, re] of Object.entries(edits(s, t))) expectAsPlanned(re, s, 'thisHour', T, t, R2, R6, `${kind} at ${clock(dt)}`);
        }
      }));
    }
  });
}

// On her way home to rest for her do-not-disturb room, a room built across her way from home to it: with her way longer now the set-off planned doesn't stand, so she waits on her way and cleans the room as planned, and a later edit with nothing new leaves that plan as it is.
{
  // On her way home to rest for her do-not-disturb room, a room built across her way from home to it: with her way longer now the set-off planned doesn't stand, so she waits on her way and cleans the room as planned, and a later edit with nothing new leaves that plan as it is.
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  const KINDS = {
    rookie: { experience: 'rookie', style: 'meticulous', workHours: 0 },
    skilled: { experience: 'skilled', style: 'standard', workHours: 100 },
    veteran: { experience: 'veteran', style: 'speedy', workHours: 500 },
  } as const;
  type Kind = keyof typeof KINDS;

  /** A housekeeper (high stamina, turnover runner) of the given kind standing at `at`, at `fatigue` at `abs`. */
  function keeper(kind: Kind, at: TilePos, abs: number, fatigue: number): StaffMember {
    const p = KINDS[kind];
    return { id: 'hk', serial: 1, name: 'hk', role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build or a hire). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: eight standard rooms on row 2 (x 1..8, doors up onto row 1) and an entrance at (0, 1); the base at
   * (1, 4), reached from the rooms' hallway by (0, 3) -- free at first -- or the long way round by (9, 2) and row 3.
   * One housekeeper, hk, with do-not-disturb rooms to clean (0.1 h of daily cleaning each, unless given):
   * - 'rookie': a slow rookie (fatigue 30) at (5, 0). R2 (2, 2): its party walks out at 12:44.9, back at 13:17.8 (out
   *   of the room 12:48.5-13:14.2); R3 (3, 2): out at 12:49.6, back at 13:26.4 (out of the room 12:53.2-13:22.8).
   * - 'skilled': a skilled housekeeper (fatigue 10) at (9, 1). R2: out at 12:45, back at 13:18 (out of the room
   *   12:48.6-13:14.4); R8 (8, 2): out at 12:55.8, back at 13:36 (out of the room 12:59.4-13:32.4).
   * - 'veteran': a speedy veteran (fatigue 59.8) at (5, 0). R2, 0.2 h of cleaning: out at 12:39.8, back at 13:09.3 (out
   *   of the room 12:43.4-13:05.7).
   * In each, the hour's plan has her walk home, rest there (spare time) till she must set off to be at R2's door as its
   * party goes out, and clean it.
   */
  const SCENES = {
    rookie: { kind: 'rookie', at: { gridX: 5, gridY: 0, floor: 0 }, fatigue: 30, parties: [[2, 0.748, 1.297, 0.1], [3, 0.826, 1.44, 0.1]] },
    skilled: { kind: 'skilled', at: { gridX: 9, gridY: 1, floor: 0 }, fatigue: 10, parties: [[2, 0.75, 1.3, 0.1], [8, 0.93, 1.6, 0.1]] },
    veteran: { kind: 'veteran', at: { gridX: 5, gridY: 0, floor: 0 }, fatigue: 59.8, parties: [[2, 0.664, 1.155, 0.2]] },
  } as const;
  type SceneName = keyof typeof SCENES;
  function scene(name: SceneName) {
    const sc = SCENES[name];
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 1; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
    s = addFixture(s, 'entrance', 0, 1, 0)!;
    const abs = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper(sc.kind, sc.at, abs, sc.fatigue)] };
    s = syncStaff(s);
    const T = hourStart(s);
    const rooms = sc.parties.map(([x]) => s.rooms.find(r => r.gridX === x && r.gridY === 2)!);
    s = { ...s, guests: sc.parties.map(([x, leave, back], i) => goingOut(s, rooms[i], T + leave, T + back, `g${x}`)),
      rooms: s.rooms.map(r => {
        const i = rooms.findIndex(q => q.id === r.id);
        return i < 0 ? r : { ...r, status: 'occupied' as const, guestId: `g${sc.parties[i][0]}`, dailyCleanHoursRemaining: sc.parties[i][3] };
      }) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, rooms: rooms.map(r => s.rooms.find(q => q.id === r.id)!) };
  }

  const itineraryOf = (s: HotelState) => getStaffPlan(s).itineraries.find(it => it.staffId === 'hk')!;
  const legsOf = (s: HotelState): Leg[] => itineraryOf(s)?.legs ?? [];
  const restsOf = (s: HotelState) => legsOf(s).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState) => legsOf(s).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState) => legsOf(s).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  const walksOf = (s: HotelState) => legsOf(s).filter((l): l is WalkLeg => l.kind === 'walk');
  const tile = (p: TilePos) => `${p.gridX},${p.gridY}`;
  /** Each leg in brief, times from 12:00 in hours: a walk's way and times, a stay's activity, spot and times. */
  const brief = (s: HotelState, legs: Leg[]) => legs.map(l => (l.kind === 'walk'
    ? `walk ${l.path.map(tile).join('>')} ${(l.start - hourStart(s)).toFixed(6)}-${(l.end - hourStart(s)).toFixed(6)}`
    : `${l.activity}${l.idle ? ' (spare)' : ''}${l.job ? ` ${l.placeId}` : ''} at ${tile(l.at)} ${(l.start - hourStart(s)).toFixed(6)}-${(l.end - hourStart(s)).toFixed(6)}`));
  /** Where she is at x and doing what. */
  const where = (s: HotelState, x: number) => {
    const p = positionAt(legsOf(s), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const clock = (dt: number) => `${12 + Math.floor(dt + 1e-9)}:${(((dt % 1) + 1) % 1 * 60).toFixed(1).padStart(4, '0')}`;
  /** The first moment from `from` to the hour's end at which she is somewhere else, or doing something else, in b than in a (null if none). */
  const firstDifference = (a: HotelState, b: HotelState, from: number) => {
    const T = hourStart(a);
    for (let x = from + 0.001; x < T + 1; x += 0.0025) if (where(a, x) !== where(b, x)) return `${clock(x - T)}: ${where(a, x)} vs ${where(b, x)}`;
    return null;
  };
  const away = (s: HotelState, room: Room, T: number) =>
    awayStretches(s.guests.find(g => g.id === room.guestId)!, room).map(([a, b]) => [+(a - T).toFixed(4), +(b - T).toFixed(4)]);
  /** The day each room was last given its daily clean, once two hours are played (the cleans run past 13:00). */
  const cleanedBy14 = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** The edit: a room built at (0, 3), doors up, at t -- it brings nobody new work, but closes the short way from the base to the rooms' hallway. */
  const built = (s: HotelState, t: number) => settleChanges(s, addRoom(s, 'standard', 0, 3, 0, 'up')!, t);
  /** Later edits that bring her nothing new: a paused re-plan, a maintenance hire. */
  const noOps = (s: HotelState, t: number) => ({
    paused: replanStaff(s, t),
    hire: settleChanges(s, hireCandidate(s, 'maintenance', hiringCandidates(s, 'maintenance')[0].id, undefined, t)!, t),
  });
  /** The edit times: 12:00.6 to 12:03, early in her walk home (each between two tiles). */
  const TIMES = [0.01, 0.02, 0.04, 0.05];
  const WHO = { rookie: 'the rookie', skilled: 'the skilled one', veteran: 'the veteran' } as const;
  /** The door of a room on row 2 (doors up onto row 1). */
  const doorOf = (room: Room) => ({ gridX: room.gridX, gridY: 1, floor: 0 });

  /**
   * Her plan after the edit at t: she doesn't walk on home to rest, but stops at the next tile of her way and waits
   * there; then sets off to be at R2's door when planned, as its party goes out. Returns her legs after that walk, and
   * the hour's plan's after its walk to the door.
   */
  const expectWaitsOnHerWay = (re: HotelState, s: HotelState, T: number, t: number, at: string) => {
    // she doesn't go on home to rest at the base
    expect(restsOf(re).filter(l => l.end > t + 1e-9 && sameTile(l.at, BASE)).map(l => brief(re, [l])[0]), at).toEqual([]);
    // she stops at the next tile on her way home and waits there
    const home = walksOf(s)[0];
    const next = home.path[Math.ceil((t - home.start) / STEP - 1e-9)];
    const waits = waitsOf(re).filter(l => l.end > t + 1e-9);
    expect(waits.map(l => tile(l.at)), at).toEqual([tile(next)]);
    // then straight to R2's door, there when planned, as its party goes out
    const legs = legsOf(re), planned = legsOf(s);
    const toDoor = legs[legs.indexOf(waits[0]) + 1] as WalkLeg, plannedToDoor = walksOf(s)[1];
    expect(toDoor.kind, at).toBe('walk');
    expect(toDoor.start, at).toBeCloseTo(waits[0].end, 9);
    expect(toDoor.path.length - 1, at).toBe(findRoute(re, next, toDoor.path.at(-1)!)!.path.length - 1);
    expect(tile(toDoor.path.at(-1)!), at).toBe(tile(plannedToDoor.path.at(-1)!));
    expect(toDoor.end, at).toBeCloseTo(plannedToDoor.end, 9);
    return { after: legs.slice(legs.indexOf(toDoor) + 1), plannedAfter: planned.slice(planned.indexOf(plannedToDoor) + 1) };
  };

  describe('On her way home to rest for her do-not-disturb room, a room built across her way from home to it: with her way longer now she doesn\'t keep the set-off planned, but is timed as ever -- she waits on her way and cleans the room', () => {
    it('as planned (the rookie): she walks home the short way by (0, 3), there by 12:18, rests at the base till 12:37.7, is at R2\'s door at 12:48.5 as its party goes out and cleans it 12:50.3-12:59.7, then walks on to R3\'s door', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, rooms: [R2, R3] } = scene('rookie');
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R2, T)).toEqual([[0.808, 1.237]]);
        expect(away(s, R3, T)).toEqual([[0.886, 1.38]]);
        expect(brief(s, legsOf(s))).toEqual([
          'walk 5,0>4,0>3,0>2,0>1,0>0,0>0,1>0,2>0,3>0,4>1,4 0.000000-0.300000',
          'rest (spare) at 1,4 0.300000-0.628000',
          'walk 1,4>0,4>0,3>0,2>0,1>1,1>2,1 0.628000-0.808000',
          'walk 2,1>2,2 0.808000-0.838000',
          `clean ${R2.id} at 2,2 0.838000-0.994250`,
          'walk 2,2>2,1>3,1 0.994250-1.054250',
        ]);
        expect(itineraryOf(s).end.roomId).toBe(R3.id);
        expect(cleanedBy14(s, [R2, R3])).toEqual([3, 3]);
        // with a room at (0, 3), her way home from row 0, and from the base to R2's door, is the long way round by (9, 2):
        // R2's door is 18 tiles from the base, not 6, so from the set-off planned she'd be there at 13:10.1 -- after the
        // hour's end, and 21.6 minutes later than planned. From row 0 it's as near as ever.
        const closed = addRoom(s, 'standard', 0, 3, 0, 'up')!;
        expect(findRoute(closed, { gridX: 4, gridY: 0, floor: 0 }, BASE)!.path).toContainEqual({ gridX: 9, gridY: 2, floor: 0 });
        expect(findRoute(s, BASE, doorOf(R2))!.path.length - 1).toBe(6);
        expect(findRoute(closed, BASE, doorOf(R2))!.path.length - 1).toBe(18);
        expect(0.628 + 18 * STEP).toBeCloseTo(1.168, 9);
        expect(findRoute(closed, { gridX: 4, gridY: 0, floor: 0 }, doorOf(R2))!.path.length - 1).toBe(3);
      });
    });

    it('as planned (the skilled one): she walks home round by (9, 2) and row 3, there by 12:19.8, rests at the base till 12:37.8, is at R2\'s door at 12:48.6 as its party goes out and cleans it 12:50.4-12:56.4, then walks on to R8\'s door, there at 13:09', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, rooms: [R2, R8] } = scene('skilled');
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R2, T)).toEqual([[0.81, 1.24]]);
        expect(away(s, R8, T)).toEqual([[0.99, 1.54]]);
        expect(brief(s, legsOf(s))).toEqual([
          'walk 9,1>9,2>9,3>8,3>7,3>6,3>5,3>4,3>3,3>2,3>2,4>1,4 0.000000-0.330000',
          'rest (spare) at 1,4 0.330000-0.630000',
          'walk 1,4>0,4>0,3>0,2>0,1>1,1>2,1 0.630000-0.810000',
          'walk 2,1>2,2 0.810000-0.840000',
          `clean ${R2.id} at 2,2 0.840000-0.940000`,
          'walk 2,2>2,1>3,1>4,1>5,1>6,1>7,1>8,1 0.940000-1.150000',
        ]);
        expect(itineraryOf(s).end.roomId).toBe(R8.id);
        expect(cleanedBy14(s, [R2, R8])).toEqual([3, 3]);
        // with a room at (0, 3), her way home is as long as before, but R2's door is 18 tiles from the base, not 6: from
        // the set-off planned she'd be there at 13:10.2 -- after the hour's end, 21.6 minutes later than planned, and too
        // late to step in, clean it and step out before its party is back in the room at 13:14.4
        const closed = addRoom(s, 'standard', 0, 3, 0, 'up')!;
        expect(findRoute(closed, SCENES.skilled.at, BASE)!.path.length - 1).toBe(11);
        expect(findRoute(s, BASE, doorOf(R2))!.path.length - 1).toBe(6);
        expect(findRoute(closed, BASE, doorOf(R2))!.path.length - 1).toBe(18);
        expect(0.63 + 18 * STEP).toBeCloseTo(1.17, 9);
        expect(1.17 + STEP + 0.1 + STEP).toBeGreaterThan(1.24);
      });
    });

    it('as planned (the veteran): she walks home the short way by 12:18, rests at the base till 12:32.6, is at R2\'s door at 12:43.4 as its party goes out and cleans it 12:45.2-12:53.2, then rests in the hallway', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, rooms: [R2] } = scene('veteran');
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R2, T)).toEqual([[0.724, 1.095]]);
        expect(brief(s, legsOf(s))).toEqual([
          'walk 5,0>4,0>3,0>2,0>1,0>0,0>0,1>0,2>0,3>0,4>1,4 0.000000-0.300000',
          'rest (spare) at 1,4 0.300000-0.544000',
          'walk 1,4>0,4>0,3>0,2>0,1>1,1>2,1 0.544000-0.724000',
          'walk 2,1>2,2 0.724000-0.754000',
          `clean ${R2.id} at 2,2 0.754000-0.887333`,
          'walk 2,2>2,1 0.887333-0.917333',
          'rest (spare) at 2,1 0.917333-1.000000',
        ]);
        expect(cleanedBy14(s, [R2])).toEqual([3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: the rookie, a room built at (0, 3) at 12:00.6-12:03: she doesn't take the long way home to rest till 12:37.7, which loses R2, but waits on her way and is at R2's door at 12:48.5 as its party goes out, cleaning it 12:50.3-12:59.7 as planned`, () => withDesk(desk, () => {
        const { s, T, rooms } = scene('rookie');
        for (const dt of TIMES) {
          const t = T + dt, at = `built at ${clock(dt)}`;
          const re = built(s, t);
          const { after, plannedAfter } = expectWaitsOnHerWay(re, s, T, t, at);
          // the rest of her hour as planned: in, R2's clean, out and on to R3's door
          expect(brief(re, after), at).toEqual(brief(s, plannedAfter));
          expect(itineraryOf(re).end.roomId, at).toBe(rooms[1].id);
          expect(cleanedBy14(re, rooms), at).toEqual([3, 3]);
        }
      }));

      it(`desk ${desk}: the skilled one, a room built at (0, 3) at 12:00.6-12:03: she doesn't walk on home to rest till 12:37.8, when R2 would be turned down and lose its clean, but waits on her way, cleans R2 12:50.4-12:56.4 and walks on to R8's door as planned`, () => withDesk(desk, () => {
        const { s, T, rooms } = scene('skilled');
        for (const dt of TIMES) {
          const t = T + dt, at = `built at ${clock(dt)}`;
          const re = built(s, t);
          const { after, plannedAfter } = expectWaitsOnHerWay(re, s, T, t, at);
          // the rest of her hour as planned: in, R2's clean, out and on to R8's door
          expect(brief(re, after), at).toEqual(brief(s, plannedAfter));
          expect(itineraryOf(re).end.roomId, at).toBe(rooms[1].id);
          expect(cleanedBy14(re, rooms), at).toEqual([3, 3]);
        }
      }));

      it(`desk ${desk}: the veteran, a room built at (0, 3) at 12:00.6-12:03: she doesn't take the long way home to rest, which loses R2, but waits on her way and is at R2's door at 12:43.4 as its party goes out, cleaning it from 12:45.2`, () => withDesk(desk, () => {
        const { s, T, rooms } = scene('veteran');
        for (const dt of TIMES) {
          const t = T + dt, at = `built at ${clock(dt)}`;
          const re = built(s, t);
          const { after, plannedAfter } = expectWaitsOnHerWay(re, s, T, t, at);
          // in and cleaning R2 when planned (not rested at the base first, she cleans it a little slower)
          expect(brief(re, after.slice(0, 1)), at).toEqual(brief(s, plannedAfter.slice(0, 1)));
          expect(jobsOf(re).map(l => l.placeId), at).toEqual([rooms[0].id]);
          expect(jobsOf(re)[0].start - T, at).toBeCloseTo(0.754, 9);
          expect(cleanedBy14(re, rooms), at).toEqual([3]);
        }
      }));

      for (const name of ['rookie', 'skilled', 'veteran'] as const) {
        it(`desk ${desk}: ${WHO[name]}, a room built at (0, 3) at 12:00.6-12:03: a paused re-plan or a maintenance hire 2.4 minutes later or at 12:12, with nothing new, leaves her plan as the build left it, and her rooms are cleaned`, () => withDesk(desk, () => {
          const { s, T, rooms } = scene(name);
          for (const dt of TIMES) {
            const t = T + dt;
            const re = built(s, t);
            for (const t2 of [t + 0.04, T + 0.2]) {
              for (const [kind, later] of Object.entries(noOps(re, t2))) {
                const at = `built at ${clock(dt)}, ${kind} at ${clock(t2 - T)}`;
                // where she is and what she's doing from then to the hour's end, the rooms she cleans and when, and
                // where she's headed at 13:00: all as the build left them
                expect(firstDifference(re, later, t2), at).toBeNull();
                expect(brief(later, jobsOf(later)), at).toEqual(brief(re, jobsOf(re)));
                expect(itineraryOf(later).end.roomId, at).toBe(itineraryOf(re).end.roomId);
                expect(cleanedBy14(later, rooms), at).toEqual(rooms.map(() => 3));
              }
            }
          }
        }));
      }
    }
  });
}

// If a build makes her own room impossible this hour, the next room of her plan is timed as ever and cleaned; if a build only makes her way to it longer, she rests at home and sets off sooner so as to be at its door as planned, rather than stand in the hallway.
{
  // Re-planned at home for her own do-not-disturb room with nothing new: if a build makes that room impossible this hour, the next room of her plan is timed as ever and cleaned; if a build only makes her way to it longer, she rests at home and sets off sooner so as to be at its door as planned, rather than stand in the hallway.
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  const KINDS = {
    rookie: { experience: 'rookie', style: 'meticulous', workHours: 0, stamina: 'high' },
    skilled: { experience: 'skilled', style: 'standard', workHours: 100, stamina: 'normal' },
  } as const;
  type Kind = keyof typeof KINDS;

  /** A housekeeper (a turnover runner) of the given kind standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, serial: number, kind: Kind, at: TilePos, abs: number, fatigue: number): StaffMember {
    const p = KINDS[kind];
    return { id, serial, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: p.stamina, specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: eight standard rooms on row 2 (x 1..8, doors up onto row 1) and an entrance at (0, 1); the base at
   * (1, 4), reached from the rooms' hallway by (0, 3) or the long way round by (9, 2) and row 3. `extra`: rooms built
   * before the hour's plan is made. Each party is [its room's x, y, walks out at, back at, daily cleaning hours] (hours
   * from 12:00); `staff`, the roster in order.
   */
  function hotel(extra: [number, number][], staff: (abs: number) => StaffMember[], parties: [number, number, number, number, number][]) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 1; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
    s = addFixture(s, 'entrance', 0, 1, 0)!;
    for (const [x, y] of extra) s = addRoom(s, 'standard', x, y, 0, 'up')!;
    const abs = 2 * 24 + 12;
    const roster = staff(abs);
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null,
      staff: { ...s.staff, housekeepers: roster.length, maintenanceWorkers: 0 }, staffRoster: roster };
    s = syncStaff(s);
    const T = hourStart(s);
    const rooms = parties.map(([x, y]) => s.rooms.find(r => r.gridX === x && r.gridY === y)!);
    s = { ...s, guests: parties.map(([, , leave, back], i) => goingOut(s, rooms[i], T + leave, T + back, `g${i}`)),
      rooms: s.rooms.map(r => {
        const i = rooms.findIndex(q => q.id === r.id);
        return i < 0 ? r : { ...r, status: 'occupied' as const, guestId: `g${i}`, dailyCleanHoursRemaining: parties[i][4] };
      }) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, rooms: rooms.map(r => s.rooms.find(q => q.id === r.id)!) };
  }

  /**
   * Her own room lost (the sweep's hotel s1_16636): one slow rookie, a (fatigue 30), at (5, 0). R2 (2, 2): its party
   * walks out at 12:44.9, back at 13:17.8 (out of the room 12:48.5-13:14.2); R3 (3, 2): out at 12:49.6, back at 13:26.4
   * (out of the room 12:53.2-13:22.8); 0.1 h of daily cleaning each. The hour's plan: she walks home the short way by
   * (0, 3), rests there (spare time) till 12:37.7, is at R2's door at 12:48.5 as its party goes out, cleans it
   * 12:50.3-12:59.7, and walks on to R3's door.
   */
  const ownLost = () => hotel([], abs => [keeper('a', 1, 'rookie', { gridX: 5, gridY: 0, floor: 0 }, abs, 30)],
    [[2, 2, 0.748, 1.297, 0.1], [3, 2, 0.826, 1.44, 0.1]]);

  /**
   * Her way longer (the round-10 hallway stand): a room at (0, 3) closes the short way from the base, and S at (3, 5)
   * has its door up onto (3, 4), two tiles from the base. c (skilled, fatigue 30, first on the roster) at (5, 0) walks
   * home the long way round by (9, 2) and row 3, there at 12:28.8, rests there (spare time) till S's set-off from the base
   * and walks the long way to R2's door (18 tiles), there next hour, after R2's party is out. a (skilled, fatigue 30)
   * rests at the base for S and cleans it. R2's party is out of the room from `from2`, back about 13:26; S's from
   * `fromS`; 0.05 h of daily cleaning each. By default (the probe's scene): R2's out from 12:51, S's from 12:44.4, so c
   * rests at the base till 12:40.8 and is at R2's door at 13:13.2.
   */
  const longerWay = (from2 = 0.85, fromS = 0.74) => hotel([[0, 3], [3, 5]], abs => [
    keeper('c', 1, 'skilled', { gridX: 5, gridY: 0, floor: 0 }, abs, 30),
    keeper('a', 2, 'skilled', BASE, abs, 30),
  ], [[2, 2, from2 - PACE, 1.5, 0.05], [3, 5, fromS - PACE, 1.9, 0.05]]);
  /** [R2's party out from, S's party out from], hours from 12:00: the probe's scene and three like it. */
  const PARTIES = [[0.85, 0.74], [0.8, 0.73], [0.9, 0.78], [0.85, 0.7]] as const;

  const itineraryOf = (s: HotelState, id: string) => getStaffPlan(s).itineraries.find(it => it.staffId === id)!;
  const legsOf = (s: HotelState, id: string): Leg[] => itineraryOf(s, id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  const walksOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is WalkLeg => l.kind === 'walk');
  const tile = (p: TilePos) => `${p.gridX},${p.gridY}`;
  /** Each leg in brief, times from 12:00 in hours: a walk's way and times, a stay's activity, spot and times. */
  const brief = (s: HotelState, legs: Leg[]) => legs.map(l => (l.kind === 'walk'
    ? `walk ${l.path.map(tile).join('>')} ${(l.start - hourStart(s)).toFixed(6)}-${(l.end - hourStart(s)).toFixed(6)}`
    : `${l.activity}${l.idle ? ' (spare)' : ''}${l.job ? ` ${l.placeId}` : ''} at ${tile(l.at)} ${(l.start - hourStart(s)).toFixed(6)}-${(l.end - hourStart(s)).toFixed(6)}`));
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const clock = (dt: number) => `${12 + Math.floor(dt + 1e-9)}:${(((dt % 1) + 1) % 1 * 60).toFixed(1).padStart(4, '0')}`;
  /**
   * What someone does from t on: each stop (activity, spot, times, a stay split in two taken as one) and, for each run of
   * walks, where it takes her and when she's there -- the tiles a walk passes through can differ between ways of the
   * same length, and a re-plan can split a walk or a stay where it was under way.
   */
  const stopsFrom = (s: HotelState, id: string, t: number) => {
    const T = hourStart(s), legs = legsOf(s, id).filter(l => l.end > t + 1e-9), out: { key: string; start: number | null; end: number }[] = [];
    legs.forEach((l, i) => {
      if (l.kind === 'walk') {
        if (legs[i + 1]?.kind !== 'walk') out.push({ key: `walk to ${tile(l.path.at(-1)!)}`, start: null, end: l.end });
        return;
      }
      const key = `${l.activity}${l.idle ? ' (spare)' : ''}${l.job ? ` ${l.placeId}` : ''} at ${tile(l.at)}`, last = out.at(-1);
      if (last && last.key === key && Math.abs(last.end - l.start) < 1e-9) last.end = l.end;
      else out.push({ key, start: Math.max(l.start, t), end: l.end });
    });
    return out.map(o => (o.start === null ? `${o.key}, there at ${(o.end - T).toFixed(6)}` : `${o.key} ${(o.start - T).toFixed(6)}-${(o.end - T).toFixed(6)}`));
  };
  const away = (s: HotelState, room: Room, T: number) =>
    awayStretches(s.guests.find(g => g.id === room.guestId)!, room).map(([a, b]) => [+(a - T).toFixed(4), +(b - T).toFixed(4)]);
  /** The day each room was last given its daily clean, once two hours are played (the cleans run past 13:00). */
  const cleanedBy14 = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** The door of a room on row 2 (doors up onto row 1). */
  const doorOf = (room: Room) => ({ gridX: room.gridX, gridY: 1, floor: 0 });
  const tiles = (s: HotelState, a: TilePos, b: TilePos) => findRoute(s, a, b)!.path.length - 1;
  /** A room built at (x, y), doors up, at t. */
  const build = (s: HotelState, x: number, y: number, t: number) => settleChanges(s, addRoom(s, 'standard', x, y, 0, 'up')!, t);

  describe('Resting at home for her do-not-disturb room, an edit makes it impossible this hour: the next room of her plan, startable on arrival, is done, not turned down', () => {
    it('as planned: she walks home by (0, 3), rests at the base till 12:37.7, cleans R2 12:50.3-12:59.7 and walks on to R3\'s door; with a room at (0, 3), the base is 18 tiles from R2\'s door and 17 from R3\'s', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, rooms: [R2, R3] } = ownLost();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R2, T)).toEqual([[0.808, 1.237]]);
        expect(away(s, R3, T)).toEqual([[0.886, 1.38]]);
        expect(brief(s, legsOf(s, 'a'))).toEqual([
          'walk 5,0>4,0>3,0>2,0>1,0>0,0>0,1>0,2>0,3>0,4>1,4 0.000000-0.300000',
          'rest (spare) at 1,4 0.300000-0.628000',
          'walk 1,4>0,4>0,3>0,2>0,1>1,1>2,1 0.628000-0.808000',
          'walk 2,1>2,2 0.808000-0.838000',
          `clean ${R2.id} at 2,2 0.838000-0.994250`,
          'walk 2,2>2,1>3,1 0.994250-1.054250',
        ]);
        expect(itineraryOf(s, 'a').end.roomId).toBe(R3.id);
        expect(cleanedBy14(s, [R2, R3])).toEqual([3, 3]);
        const closed = addRoom(s, 'standard', 0, 3, 0, 'up')!;
        expect(tiles(s, BASE, doorOf(R2))).toBe(6);
        expect(tiles(closed, BASE, doorOf(R2))).toBe(18);
        expect(tiles(closed, BASE, doorOf(R3))).toBe(17);
        // leaving the base at 12:31.2 she'd be at R2's door at 13:03.6: in, its clean (0.15625 h at her rate) and out
        // again end after its party is back in the room at 13:14.2 -- R2 can't be done
        expect(0.52 + 18 * STEP + STEP + 0.15625 + STEP).toBeGreaterThan(1.237);
        // at R3's door at 13:01.8, its party out (12:53.2-13:22.8): she can start on it on arrival and be out by 13:14.8
        expect(0.52 + 17 * STEP).toBeGreaterThan(0.886);
        expect(0.58 + 17 * STEP + STEP + 0.15625 + STEP).toBeLessThan(1.38);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a room built at (0, 3) at 12:31.2 or 12:34.8, as she rests at the base for R2: R2 is lost, but she sets off at once the long way for R3's door, there as its party is out, and cleans it -- not resting out the hour`, () => withDesk(desk, () => {
        const { s, T, rooms: [R2, R3] } = ownLost();
        for (const dt of [0.52, 0.58]) {
          const t = T + dt, at = `built at ${clock(dt)}`;
          const re = build(s, 0, 3, t);
          // no more rest at the base, and no wait anywhere, for the rest of the hour
          expect(restsOf(re, 'a').filter(l => l.end > t + 1e-9).map(l => brief(re, [l])[0]), at).toEqual([]);
          expect(waitsOf(re, 'a').filter(l => l.end > t + 1e-9).map(l => brief(re, [l])[0]), at).toEqual([]);
          // she walks from the base at once, straight to R3's door (17 tiles), there at t + 0.51
          const walks = walksOf(re, 'a').filter(l => l.end > t + 1e-9);
          expect(walks.length, at).toBeGreaterThan(0);
          expect(walks[0].start, at).toBeCloseTo(t, 9);
          expect(tile(walks[0].path[0]), at).toBe(tile(BASE));
          expect(tile(walks.at(-1)!.path.at(-1)!), at).toBe(tile(doorOf(R3)));
          expect(walks.at(-1)!.end - T, at).toBeCloseTo(dt + 17 * STEP, 9);
          expect(walks.reduce((n, l) => n + l.path.length - 1, 0), at).toBe(17);
          expect(where(re, 'a', T + 0.62), at).toMatch(/ walk$/);
          // she's headed for R3 at 13:00, and R3 gets its daily clean (R2, out of anyone's reach now, doesn't)
          expect(jobsOf(re, 'a').filter(l => l.end > t).map(l => l.placeId), at).not.toContain(R2.id);
          expect(itineraryOf(re, 'a').end.roomId, at).toBe(R3.id);
          expect(cleanedBy14(re, [R2, R3]), at).toEqual([0, 3]);
        }
      }));

      it(`desk ${desk}: a room built at (0, 3) at 12:31.2 or 12:34.8, then a paused re-plan 2.4 minutes later with nothing new: she walks on to R3's door as the build left her, and cleans it`, () => withDesk(desk, () => {
        const { s, T, rooms: [R2, R3] } = ownLost();
        for (const dt of [0.52, 0.58]) {
          const t = T + dt, at = `built at ${clock(dt)}`;
          const re = build(s, 0, 3, t);
          const later = replanStaff(re, t + 0.04);
          expect(stopsFrom(later, 'a', t + 0.04), at).toEqual(stopsFrom(re, 'a', t + 0.04));
          expect(itineraryOf(later, 'a').end.roomId, at).toBe(R3.id);
          expect(cleanedBy14(later, [R2, R3]), at).toEqual([0, 3]);
        }
      }));

      it(`desk ${desk}: control -- a room built far off at (6, 5) at 12:31.2 or 12:34.8, R2 still within reach: she rests on at the base till 12:37.7 and cleans R2 and then R3, as planned`, () => withDesk(desk, () => {
        const { s, T, rooms: [R2, R3] } = ownLost();
        for (const dt of [0.52, 0.58]) {
          const t = T + dt, at = `built at ${clock(dt)}`;
          const re = build(s, 6, 5, t);
          expect(stopsFrom(re, 'a', t), at).toEqual(stopsFrom(s, 'a', t));
          expect(brief(re, jobsOf(re, 'a')), at).toEqual(brief(s, jobsOf(s, 'a')));
          expect(itineraryOf(re, 'a').end.roomId, at).toBe(R3.id);
          expect(cleanedBy14(re, [R2, R3]), at).toEqual([3, 3]);
        }
      }));
    }
  });

  describe('On her way home to rest for her do-not-disturb room, which from home she\'d reach only once its party is out, a build makes her way from home to its door longer: she rests at home and sets off sooner, so as to be at the door as planned -- no hallway stand', () => {
    /** The edit times: 12:01.2 to 12:07.8, early in her walk home. */
    const TIMES = [0.02, 0.05, 0.09, 0.13];

    it('as planned: c walks home by 12:28.8, rests at the base till S\'s set-off (12:40.8 in the probe\'s scene) and is at R2\'s door next hour, after its party is out (13:13.2); a room at (8, 1) makes her way from the base to that door 20 tiles, not 18, and leaves her way home and from row 0 to the door as they were', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        for (const [from2, fromS] of PARTIES) {
          const { s, T, rooms: [R2, S] } = longerWay(from2, fromS), at = `parties out from ${clock(from2)} / ${clock(fromS)}`;
          expect(namedFrontDesk(s), at).toBe(desk === 'named');
          expect(away(s, R2, T)[0][0], at).toBeCloseTo(from2, 6);
          expect(away(s, R2, T)[0][1], at).toBeCloseTo(1.44, 6);
          expect(away(s, S, T)[0][0], at).toBeCloseTo(fromS, 6);
          const legs = legsOf(s, 'c');
          const home = walksOf(s, 'c')[0], rest = restsOf(s, 'c')[0], toDoor = walksOf(s, 'c')[1];
          expect(legs.slice(0, 3), at).toEqual([home, rest, toDoor]);
          expect(tile(home.path.at(-1)!), at).toBe(tile(BASE));
          expect(home.end - T, at).toBeCloseTo(0.48, 9);
          expect(rest, at).toMatchObject({ idle: true, at: BASE });
          expect(rest.end - T, at).toBeCloseTo(fromS - 2 * STEP, 9);
          expect(tile(toDoor.path.at(-1)!), at).toBe(tile(doorOf(R2)));
          expect(toDoor.path.length - 1, at).toBe(18);
          expect(toDoor.end - T, at).toBeGreaterThan(1);
          expect(toDoor.end - T, at).toBeGreaterThan(from2);
          // the sooner set-off: at the door when planned by the longer way means leaving the base 2 tiles' walk sooner,
          // still after she's home
          expect(toDoor.end - T - 20 * STEP, at).toBeGreaterThan(0.48);
          expect(jobsOf(s, 'a').map(l => l.placeId), at).toEqual([S.id]);
          expect(cleanedBy14(s, [R2, S]), at).toEqual([3, 3]);
          const longer = addRoom(s, 'standard', 8, 1, 0, 'up')!;
          expect(tiles(s, BASE, doorOf(R2)), at).toBe(18);
          expect(tiles(longer, BASE, doorOf(R2)), at).toBe(20);
          for (const x of [5, 6, 7, 8, 9]) {
            const p = { gridX: x, gridY: 0, floor: 0 };
            expect(tiles(longer, p, BASE), at).toBe(tiles(s, p, BASE));
            expect(tiles(longer, p, doorOf(R2)), at).toBe(tiles(s, p, doorOf(R2)));
          }
        }
        // the probe's scene: rests till 12:40.8, at R2's door at 13:13.2, the sooner set-off 12:37.2
        const { s, T } = longerWay();
        expect(restsOf(s, 'c')[0].end - T).toBeCloseTo(0.68, 9);
        expect(walksOf(s, 'c')[1].end - T).toBeCloseTo(1.22, 9);
        expect(1.22 - 20 * STEP).toBeCloseTo(0.62, 9);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a room built at (8, 1) at 12:01.2-12:07.8: she walks on home, rests at the base till 2 tiles' walk before the set-off planned (12:37.2 in the probe's scene) and walks the longer way to R2's door, there when planned -- not stopping in the hallway`, () => withDesk(desk, () => {
        for (const [from2, fromS] of PARTIES) {
          const { s, T, rooms } = longerWay(from2, fromS);
          const [R2] = rooms, planned = walksOf(s, 'c')[1];
          for (const dt of TIMES) {
            const t = T + dt, at = `parties out from ${clock(from2)} / ${clock(fromS)}, built at ${clock(dt)}`;
            const re = build(s, 8, 1, t);
            // no wait in the hallway (nor anywhere) for the rest of the hour
            expect(waitsOf(re, 'c').filter(l => l.end > t + 1e-9).map(l => brief(re, [l])[0]), at).toEqual([]);
            // walking all the way home, there at 12:28.8 as planned
            const legs = legsOf(re, 'c').filter(l => l.end > t + 1e-9);
            const rest = legs.find((l): l is StayLeg => l.kind === 'stay')!;
            expect(rest, at).toMatchObject({ activity: 'rest', idle: true, at: BASE });
            expect(rest.start - T, at).toBeCloseTo(0.48, 9);
            expect(legs.filter(l => l.end <= rest.start + 1e-9).every(l => l.kind === 'walk'), at).toBe(true);
            // rests there till 2 tiles' walk before the set-off planned, then straight to R2's door by the longer way,
            // there when planned
            expect(rest.end - T, at).toBeCloseTo(planned.end - T - 20 * STEP, 9);
            expect(rest.end, at).toBeLessThan(planned.start - 1e-9);
            const toDoor = legs[legs.indexOf(rest) + 1] as WalkLeg;
            expect(toDoor.kind, at).toBe('walk');
            expect(toDoor.start, at).toBeCloseTo(rest.end, 9);
            expect(tile(toDoor.path[0]), at).toBe(tile(BASE));
            expect(tile(toDoor.path.at(-1)!), at).toBe(tile(doorOf(R2)));
            expect(toDoor.path.length - 1, at).toBe(20);
            expect(toDoor.end, at).toBeCloseTo(planned.end, 9);
            // nothing cleaned by her this hour; a's plan as it was; both rooms cleaned
            expect(jobsOf(re, 'c').filter(l => l.start < T + 1), at).toEqual([]);
            expect(stopsFrom(re, 'a', t), at).toEqual(stopsFrom(s, 'a', t));
            expect(cleanedBy14(re, rooms), at).toEqual([3, 3]);
          }
        }
      }));

      it(`desk ${desk}: a room built at (8, 1) at 12:01.2-12:07.8, then a paused re-plan 2.4 minutes later with nothing new: every plan is as the build left it`, () => withDesk(desk, () => {
        for (const [from2, fromS] of PARTIES) {
          const { s, T, rooms } = longerWay(from2, fromS);
          for (const dt of TIMES) {
            const t = T + dt, at = `parties out from ${clock(from2)} / ${clock(fromS)}, built at ${clock(dt)}`;
            const re = build(s, 8, 1, t);
            const later = replanStaff(re, t + 0.04);
            for (const id of ['c', 'a']) expect(stopsFrom(later, id, t + 0.04), `${at} ${id}`).toEqual(stopsFrom(re, id, t + 0.04));
            expect(waitsOf(later, 'c').filter(l => l.end > t + 1e-9).map(l => brief(later, [l])[0]), at).toEqual([]);
            expect(cleanedBy14(later, rooms), at).toEqual([3, 3]);
          }
        }
      }));

      it(`desk ${desk}: control -- a room built far off at (6, 5) at 12:01.2-12:07.8, her way as it was: she rests at the base till the set-off planned, and every plan is as it was`, () => withDesk(desk, () => {
        for (const [from2, fromS] of PARTIES) {
          const { s, T, rooms } = longerWay(from2, fromS);
          for (const dt of TIMES) {
            const t = T + dt, at = `parties out from ${clock(from2)} / ${clock(fromS)}, built at ${clock(dt)}`;
            const re = build(s, 6, 5, t);
            for (const id of ['c', 'a']) expect(stopsFrom(re, id, t), `${at} ${id}`).toEqual(stopsFrom(s, id, t));
            expect(restsOf(re, 'c').find(l => sameTile(l.at, BASE) && l.end > t)!.end, at).toBeCloseTo(walksOf(s, 'c')[1].start, 9);
            expect(cleanedBy14(re, rooms), at).toEqual([3, 3]);
          }
        }
      }));
    }
  });
}

// Which other rooms may time her set-off while she rests at home for her own room (mutation check): once a build puts her own room out of reach, the next room of her plan is timed as ever even when its set-off comes before the one planned; after a big shortcut, another party whose set-off comes at the planned one or after it sends her off then; and once a turnover has got her up, a room whose chance came round only as she rested is timed as ever.
{
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  const KINDS = {
    skilled: { experience: 'skilled', style: 'standard', workHours: 100 },
    rookie: { experience: 'rookie', style: 'meticulous', workHours: 0 },
  } as const;

  /** A housekeeper (high stamina, a turnover runner) of the given kind standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, kind: keyof typeof KINDS, at: TilePos, abs: number, fatigue: number): StaffMember {
    const p = KINDS[kind];
    return { id, serial: id.charCodeAt(0) + id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb party walking out of `room` to the street at `leave`, back in at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build or a demolish). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /** The hotel at 12:00 on day 3, its roster set up as the game does, each party given its room, and the hour planned. */
  function plan(s: HotelState, roster: (abs: number) => StaffMember[], parties: [Room, number, number, number][]) {
    const abs = 2 * 24 + 12, staff = roster(abs);
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null,
      staff: { ...s.staff, housekeepers: staff.length, maintenanceWorkers: 0 }, staffRoster: staff };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: parties.map(([room, leave, back], i) => goingOut(s, room, T + leave, T + back, `g${i}`)),
      rooms: s.rooms.map(r => {
        const i = parties.findIndex(([room]) => room.id === r.id);
        return i < 0 ? r : { ...r, status: 'occupied' as const, guestId: `g${i}`, dailyCleanHoursRemaining: parties[i][3] };
      }) };
    return { ...s, staffPlan: getStaffPlan(s) };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  const walksOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is WalkLeg => l.kind === 'walk' && l.path.length > 2);
  /** Her spare-time rest at the base running past t (the rest of it, from t). */
  const baseRest = (s: HotelState, id: string, t: number) => restsOf(s, id).find(l => l.end > t + 1e-9 && sameTile(l.at, BASE));
  /** When she next sets off from where she is at t: the start of her first walk from then. */
  const setOff = (s: HotelState, id: string, t: number) => legsOf(s, id).find(l => l.kind === 'walk' && l.start >= t - 1e-9)?.start;
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** Whether someone's plan from t to the hour's end is the same in two states (sampled every 0.005h). */
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  const away = (s: HotelState, room: Room, T: number) =>
    awayStretches(s.guests.find(g => g.id === s.rooms.find(r => r.id === room.id)!.guestId)!, room).map(([a, b]) => [+(a - T).toFixed(4), +(b - T).toFixed(4)]);
  /** The day each room was last given its daily clean, once two hours are played (a clean can run past 13:00). */
  const cleanedDay = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  const energyAt = (s: HotelState, id: string, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === id)!, x);
  const clock = (dt: number) => `12:${(dt * 60).toFixed(1).padStart(4, '0')}`;

  // ---------------------------------------------------------------------------------------------------------------
  // Her own room put out of reach this hour by a build: the next room of her plan, whose set-off from home by the long
  // way now comes before the set-off planned, is timed as ever -- she rests at home till then and cleans it.
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * 12:00 on day 3: a row of rooms on row 2 from x 1 to 8, doors up onto row 1, so (0, 2) and (9, 2) are the only ways
   * between the corridors; a street entrance at (0, 1). R1 (2, 2): a do-not-disturb party out of the room 12:30-12:37.2;
   * R2 (3, 2): one out 12:48-12:58.8; 0.05h of daily cleaning each. m (skilled, at 10), alone at the base (1, 4), rests
   * there till 12:19.2, goes up by (0, 2) to clean R1 from 12:31.8, then waits at R2's door from 12:38.4 and cleans it
   * from 12:49.8. `edited`: the hotel planned from 12:00 with a room already at (0, 3), as a fresh plan would have it.
   */
  function outOfReach(edited = false) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 1; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
    s = addFixture(s, 'entrance', 0, 1, 0)!;
    const R1 = s.rooms.find(r => r.gridX === 2)!, R2 = s.rooms.find(r => r.gridX === 3)!;
    s = plan(s, abs => [keeper('m', 'skilled', BASE, abs, 10)], [[R1, 0.44, 0.68, 0.05], [R2, 0.74, 1.04, 0.05]]);
    if (edited) {
      s = { ...addRoom(s, 'standard', 0, 3, 0, 'up')!, staffPlan: null };
      s = { ...s, staffPlan: getStaffPlan(s) };
    }
    return { s, T: hourStart(s), R1, R2 };
  }
  /** A room built at (0, 3) at t: the short way up from the base by (0, 2) is shut, and only the long way round by (9, 2) is left. */
  const wallBuilt = (s: HotelState, t: number) => settleChanges(s, addRoom(s, 'standard', 0, 3, 0, 'up')!, t);

  describe('Resting at home for a do-not-disturb room a build puts out of her reach this hour: the next room of her plan is timed as ever, even when its new set-off comes before the one planned', () => {
    it('as planned: she rests at the base till 12:19.2 and cleans R1 and R2; with a room at (0, 3) R1 can\'t be done this hour, and by the long way round R2\'s set-off from the base is 12:17.4, before 12:19.2', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, R1, R2 } = outOfReach();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R1, T)).toEqual([[0.5, 0.62]]);
        expect(away(s, R2, T)).toEqual([[0.8, 0.98]]);
        const home = baseRest(s, 'm', T)!;
        expect(home).toMatchObject({ idle: true, start: T });
        expect(home.end - T).toBeCloseTo(0.32, 9);
        expect(jobsOf(s, 'm').map(l => l.placeId)).toEqual([R1.id, R2.id]);
        expect(cleanedDay(s, [R1, R2])).toEqual([3, 3]);
        // planned afresh with the room at (0, 3): R1 lost, and she rests at the base only till 12:17.4 -- R2's own set-off
        // by the 17 tiles round -- then walks round to R2 and cleans it
        const fresh = outOfReach(true).s;
        expect(jobsOf(fresh, 'm').map(l => l.placeId)).toEqual([R2.id]);
        expect(baseRest(fresh, 'm', T)!.end - T).toBeCloseTo(0.29, 9);
        expect(0.8 - 17 * STEP).toBeCloseTo(0.29, 9);
        expect(cleanedDay(fresh, [R1, R2])).toEqual([0, 3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a room built at (0, 3) at 12:03-12:15 as she rests: R1 is lost, but she rests on at the base till 12:17.4, walks round to R2 and cleans it as its party goes out -- not resting out the hour, nor standing at R2's door`, () => withDesk(desk, () => {
        const { s, T, R1, R2 } = outOfReach();
        const fresh = outOfReach(true).s;
        for (const dt of [0.05, 0.1, 0.15, 0.2, 0.25]) {
          const t = T + dt, at = `built at ${clock(dt)}`;
          expect(where(s, 'm', t), at).toMatch(/^1\.000,4\.000,0 rest\/$/);
          const re = wallBuilt(s, t);
          // R2 still hers, and cleaned on the day (R1 lost, as in a fresh plan)
          expect(jobsOf(re, 'm').filter(l => l.end > t).map(l => l.placeId), at).toEqual([R2.id]);
          expect(cleanedDay(re, [R1, R2]), at).toEqual([0, 3]);
          // resting at the base till 12:17.4, R2's own set-off, which comes before the 12:19.2 planned
          const rest = baseRest(re, 'm', t)!;
          expect(rest, at).toMatchObject({ idle: true });
          expect(rest.end - T, at).toBeCloseTo(0.29, 9);
          expect(setOff(re, 'm', t)! - T, at).toBeCloseTo(0.29, 9);
          expect(where(re, 'm', T + 0.27), at).toBe('1.000,4.000,0 rest/');
          // then the 17 tiles round, at R2's door as its party goes out: no stand in the hallway
          expect(walksOf(re, 'm').filter(l => l.end > t).map(l => [+(l.start - T).toFixed(4), +(l.end - T).toFixed(4), l.path.length - 1]), at).toEqual([[0.29, 0.8, 17]]);
          expect(waitsOf(re, 'm').filter(l => l.end > t), at).toEqual([]);
          expect(samePlan(re, fresh, 'm', t), at).toBe(true);
        }
      }));
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // A big shortcut to her own room's door moves its set-off later; another party whose set-off comes at the set-off
  // planned, or after it, is timed as ever -- she sets off for it and cleans both rooms.
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * 12:00 on day 3: eight standard rooms on row 2 from x = 1, their doors up onto the row-1 hallway, the street entrance
   * at (0, 1), O (3, 5) with its door up onto the base's row 4, two tiles from the base, and (unless `open`) a vacant
   * room at (0, 3) that shuts the short way up from the base by (0, 2), so from the base to row 1 is 17 tiles round by
   * (9, 2). Y (3, 2): a do-not-disturb party out of the room 12:51-12:58.8, 0.05h of daily cleaning; O: one out of the
   * room from `oOut` (hours after 12:00) till 13:00, 0.05h. hk (skilled, at 10) alone at the base. The hour's plan: she
   * rests at the base till 12:20.4, Y's set-off by the long way, then walks the 17 tiles round to Y's door and cleans Y;
   * at 12:20.4 Y comes first in her queue (its party back sooner), and after Y, O's party is back before she could get
   * there, so O isn't done. With the room at (0, 3) gone, the way to Y's door is 7 tiles: Y's own set-off from the base
   * is 12:38.4, and from 12:20.4 she'd be at its door 18 minutes early, more than she waits. O's set-off from the base is
   * `oOut` less two tiles: 12:20.4 itself for O out from 12:24, 12:21.6 for O out from 12:25.2.
   */
  function shortcut(oOut: number, open = false) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let x = 1; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
    s = addFixture(s, 'entrance', 0, 1, 0)!;
    s = addRoom(s, 'standard', 3, 5, 0, 'up')!;
    if (!open) s = addRoom(s, 'standard', 0, 3, 0, 'up')!;
    const Y = s.rooms.find(r => r.gridX === 3 && r.gridY === 2)!, O = s.rooms.find(r => r.gridX === 3 && r.gridY === 5)!;
    const wall = s.rooms.find(r => r.gridX === 0 && r.gridY === 3);
    s = plan(s, abs => [keeper('hk', 'skilled', BASE, abs, 10)], [[Y, 0.79, 1.04, 0.05], [O, oOut - PACE, 1.06, 0.05]]);
    return { s, T: hourStart(s), Y, O, wall };
  }
  /** O's party out of the room from 12:24 (its set-off from the base the set-off planned, 12:20.4), or from 12:25.2 (12:21.6). */
  const O_OUT = [0.4, 0.42] as const;
  const demolished = (s: HotelState, wall: Room, t: number) => settleChanges(s, demolishRoom(s, wall.id)!, t);

  describe('Resting at home for her do-not-disturb room, a big shortcut moves its set-off later: another party whose set-off comes at the set-off planned, or after it, sends her off then, and both rooms are cleaned', () => {
    it('as planned: she rests at the base till 12:20.4, walks the 17 tiles round to Y and cleans it; O isn\'t done; its set-off from the base is 12:20.4 itself (O out from 12:24) or 12:21.6 (from 12:25.2)', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        for (const oOut of O_OUT) {
          const { s, T, Y, O } = shortcut(oOut);
          expect(namedFrontDesk(s)).toBe(desk === 'named');
          expect(away(s, Y, T)).toEqual([[0.85, 0.98]]);
          expect(away(s, O, T)).toEqual([[oOut, 1]]);
          const home = baseRest(s, 'hk', T)!;
          expect(home).toMatchObject({ idle: true, start: T });
          expect(home.end - T).toBeCloseTo(0.34, 9);
          expect(walksOf(s, 'hk').map(l => [+(l.start - T).toFixed(4), +(l.end - T).toFixed(4), l.path.length - 1])).toEqual([[0.34, 0.85, 17]]);
          expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([Y.id]);
          expect(cleanedDay(s, [Y, O])).toEqual([3, 0]);
          // O's set-off from the base, two tiles from its door: the set-off planned itself, or a little after it
          if (oOut === 0.4) expect(awayStretches(s.guests[1], O)[0][0] - 2 * STEP).toBeCloseTo(home.end, 12);
          else expect(awayStretches(s.guests[1], O)[0][0] - 2 * STEP - home.end).toBeCloseTo(0.02, 9);
          // planned afresh without the room at (0, 3): O first, at its set-off, then Y by the short way
          const fresh = shortcut(oOut, true).s;
          expect(jobsOf(fresh, 'hk').map(l => l.placeId)).toEqual([O.id, Y.id]);
          expect(baseRest(fresh, 'hk', T)!.end - T).toBeCloseTo(oOut - 2 * STEP, 9);
          expect(cleanedDay(fresh, [Y, O])).toEqual([3, 3]);
        }
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: the room at (0, 3) demolished at 12:03-12:18 as she rests: she rests on at the base only till O's set-off (12:20.4 or 12:21.6), not till Y's own 12:38.4, cleans O as its party goes out, then goes up column 0 to Y and cleans it`, () => withDesk(desk, () => {
        for (const oOut of O_OUT) {
          const { s, T, Y, O, wall } = shortcut(oOut);
          const fresh = shortcut(oOut, true).s;
          for (const dt of [0.05, 0.15, 0.25, 0.3]) {
            const t = T + dt, at = `O out from ${clock(oOut)}, demolished at ${clock(dt)}`;
            expect(where(s, 'hk', t), at).toMatch(/^1\.000,4\.000,0 rest\/$/);
            const re = demolished(s, wall!, t);
            expect(re.rooms.some(r => r.id === wall!.id), at).toBe(false);
            // at the base, in spare time, till O's set-off -- the set-off planned, or just after it
            const rest = baseRest(re, 'hk', t)!;
            expect(rest, at).toMatchObject({ idle: true });
            expect(rest.end - T, at).toBeCloseTo(oOut - 2 * STEP, 9);
            expect(setOff(re, 'hk', t)! - T, at).toBeCloseTo(oOut - 2 * STEP, 9);
            expect(where(re, 'hk', T + 0.5), at).not.toMatch(/rest/);
            // O as its party goes out, then Y: both cleaned on the day
            expect(jobsOf(re, 'hk').filter(l => l.end > t).map(l => l.placeId), at).toEqual([O.id, Y.id]);
            expect(jobsOf(re, 'hk').find(l => l.placeId === O.id)!.start - T, at).toBeCloseTo(oOut + STEP, 9);
            expect(cleanedDay(re, [Y, O]), at).toEqual([3, 3]);
            expect(samePlan(re, fresh, 'hk', t), at).toBe(true);
          }
        }
      }));
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Got up from her rest at home by a room needing a turnover: after it she's planned afresh, so another party's room,
  // whose chance came round only as she rested, is timed as ever even though its set-off comes before the one planned.
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * 12:00 on day 3: four standard rooms on row 5 from x = 2, their doors up onto the base's row 4. X (2, 5), one tile
   * from the base, vacant and clean; B (3, 5): a do-not-disturb party out of the room 12:49.8-13:18, 0.1h of daily
   * cleaning; A (5, 5), four tiles from the base: one out 12:40.8-12:58.8, 0.15h. hk (slow: a rookie, meticulous, high
   * stamina) alone at the base at `energy` at 12:00. Just over 60, she's on her tired rate as the hour is planned, and
   * A's party isn't out long enough for her at it: she rests at the base till 12:46.2 and cleans B from 12:51.6.
   * Resting, she's under 60 by 12:01.8, and from then A fits her rate from the base: a set-off at 12:33.6.
   */
  function rested(energy = 60.3) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 2 + i, 5, 0, 'up')!;
    const [X, B, , A] = s.rooms;
    s = plan(s, abs => [keeper('hk', 'rookie', BASE, abs, energy)], [[A, 0.62, 1.04, 0.15], [B, 0.77, 1.36, 0.1]]);
    return { s, T: hourStart(s), A, B, X };
  }
  /** A guest checks out of X at t, as the game does it: X needs a 0.03h turnover. */
  const checkedOut = (s: HotelState, X: Room, t: number) =>
    settleChanges(s, { ...s, rooms: s.rooms.map(r => (r.id === X.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.03 } : r)) }, t);

  describe('Resting at home for her do-not-disturb room, got up by a turnover: after it, a room whose chance came round only as she rested is timed as ever', () => {
    it('as planned: just over 60 at 12:00, she rests at the base till 12:46.2 and cleans B; under 60 from 12:01.8, and a keeper under 60 at 12:00 rests at the base only till 12:33.6, cleans A and goes on to B', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B } = rested();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, A, T)).toEqual([[0.68, 0.98]]);
        expect(away(s, B, T)).toEqual([[0.83, 1.3]]);
        const home = baseRest(s, 'hk', T)!;
        expect(home).toMatchObject({ idle: true, start: T });
        expect(home.end - T).toBeCloseTo(0.77, 9);
        expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([B.id]);
        expect(jobsOf(s, 'hk')[0].start - T).toBeCloseTo(0.86, 9);
        expect(cleanedDay(s, [A, B])).toEqual([0, 3]);
        // tired as the hour's planned; under the mark as she rests
        expect(energyAt(s, 'hk', T)).toBeGreaterThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, 'hk', T + 0.03)).toBeLessThanOrEqual(STAFF_FATIGUE.tiredAt + 1e-9);
        // the chance is real once she's under the mark: at 59.5 she sets off at 12:33.6 for A, then B, and both are cleaned
        const fresh = rested(59.5).s;
        expect(setOff(fresh, 'hk', T)! - T).toBeCloseTo(0.56, 9);
        expect(jobsOf(fresh, 'hk')[0].placeId).toBe(A.id);
        expect(cleanedDay(fresh, [A, B])).toEqual([3, 3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a guest checks out of X at 12:04.8-12:10.8: she turns X round at once, back at the base rests only till 12:33.6, cleans A as its party goes out and goes on to B, and both rooms are cleaned`, () => withDesk(desk, () => {
        const { s, T, A, B, X } = rested();
        for (const dt of [0.08, 0.1, 0.12, 0.15, 0.18]) {
          const t = T + dt, at = `checked out at ${clock(dt)}`;
          expect(where(s, 'hk', t), at).toMatch(/^1\.000,4\.000,0 rest\/$/);
          const re = checkedOut(s, X, t);
          // new work first: off at once to X's turnover
          expect(setOff(re, 'hk', t)! - t, at).toBeCloseTo(0, 9);
          const jobs = jobsOf(re, 'hk').filter(l => l.end > t);
          expect(jobs[0], at).toMatchObject({ placeId: X.id, job: 'turnover' });
          const done = jobs.filter(l => l.placeId === X.id).at(-1)!.end, back = done + 2 * STEP;
          // under 60 as she finishes X (rested since 12:00), and again by A's set-off
          expect(energyAt(re, 'hk', done), at).toBeLessThan(STAFF_FATIGUE.tiredAt);
          expect(energyAt(re, 'hk', T + 0.56), at).toBeLessThan(STAFF_FATIGUE.tiredAt);
          // then planned afresh: at the base, in spare time, till A's set-off at 12:33.6, before the 12:46.2 planned for B
          const rest = baseRest(re, 'hk', back)!;
          expect(rest, at).toMatchObject({ idle: true });
          expect(rest.start - back, at).toBeCloseTo(0, 9);
          expect(rest.end - T, at).toBeCloseTo(0.56, 9);
          // A as its party goes out, then on to B (cleaned as the next hour starts): both cleaned on the day
          expect(jobs.filter(l => l.job === 'daily').map(l => l.placeId), at).toEqual([A.id]);
          expect(where(re, 'hk', T + 0.8), at).toBe(`5.000,5.000,0 clean/${A.id}`);
          expect(cleanedDay(re, [A, B]), at).toEqual([3, 3]);
          expect(re.rooms.find(r => r.id === X.id)!.status, at).toBe('cleaning');
          expect(tickSimulation(re, new PRNG(31)).state.rooms.find(r => r.id === X.id)!.status, at).toBe('vacant');
        }
      }));

      it(`desk ${desk}: control -- a paused edit at 12:04.8-12:10.8 that brings her nothing leaves her resting at the base till 12:46.2 for B, and A's chance, come round only as she rested, doesn't send her off sooner`, () => withDesk(desk, () => {
        const { s, T, A, B } = rested();
        for (const dt of [0.08, 0.12, 0.18]) {
          const t = T + dt, at = `paused at ${clock(dt)}`;
          const re = replanStaff(s, t);
          expect(samePlan(re, s, 'hk', t), at).toBe(true);
          expect(setOff(re, 'hk', t)! - T, at).toBeCloseTo(0.77, 9);
          expect(cleanedDay(re, [A, B]), at).toEqual([0, 3]);
        }
      }));
    }
  });
}

// Just past the tired mark on her way home and tired again by the hour's end, she's timed as she'll be at the set-off planned, and an edit with nothing new leaves her plan as it was (mutation check).
{
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A fast housekeeper (a speedy veteran, normal stamina, turnover runner) standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number): StaffMember {
    return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: 'veteran', style: 'speedy', reliability: 'dependable', stamina: 'normal', specialty: 'turnover_runner' },
      stats: { workHours: 500, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: four standard rooms on row 5 from x = 3, their doors up onto the base's row 4. A (3, 5): a
   * do-not-disturb party out of the room 12:33.6-12:41.4, 0.1h of daily cleaning; B (5, 5): one out 12:45.6-13:26.4,
   * 0.2h. hk (fast, normal stamina, at 59.4 at 12:00) at (8, 1): she walks home to the base by 12:18 (crossing 60 at
   * 12:07.2 on the way), rests there till 12:30 (58.9 by then), cleans A 12:35.4-12:39.4 at her rested rate, then waits
   * at B's door and cleans B 12:47.4-12:56.8 -- crossing 60 again on her way to B, so she ends the hour at about 61. A's
   * party is out just long enough for her clean at her rested rate, not at her tired one.
   */
  function scene() {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    const abs = 2 * 24 + 12, [A, , B] = s.rooms;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', { gridX: 8, gridY: 1, floor: 0 }, abs, 59.4)] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, A, T + 0.5, T + 0.75, 'ga'), goingOut(s, B, T + 0.7, T + 1.5, 'gb')],
      rooms: s.rooms.map(r => (r.id === A.id ? { ...r, status: 'occupied' as const, guestId: 'ga', dailyCleanHoursRemaining: 0.1 }
        : r.id === B.id ? { ...r, status: 'occupied' as const, guestId: 'gb', dailyCleanHoursRemaining: 0.2 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, A, B };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  const energyAt = (s: HotelState, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === 'hk')!, x);
  const away = (s: HotelState, g: string, room: Room, T: number) =>
    awayStretches(s.guests.find(x => x.id === g)!, room).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)]);
  /** The day each room was last given its daily clean, once the hour is played. */
  const cleanedBy13 = (s: HotelState, rooms: Room[]) => {
    const st = tickSimulation(s, new PRNG(17)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** The edits that bring her nothing new: a paused edit, a maintenance hire, a room built off her way. */
  const edits = (s: HotelState, t: number) => ({
    paused: replanStaff(s, t),
    hire: settleChanges(s, hireCandidate(s, 'maintenance', hiringCandidates(s, 'maintenance')[0].id, undefined, t)!, t),
    built: settleChanges(s, addRoom(s, 'standard', 8, 2, 0, 'up')!, t),
  });
  const clock = (dt: number) => `12:${(dt * 60).toFixed(1).padStart(4, '0')}`;
  /** Her plan after an edit at t, against the hour's: the same from when she's home (the way home re-planned mid-walk can be another as short). */
  const expectAsPlanned = (re: HotelState, s: HotelState, T: number, t: number, A: Room, B: Room, at: string) => {
    expect(samePlan(re, s, 'hk', Math.max(t, T + 0.3)), at).toBe(true);
    // home at 12:18, resting there (spare time) till 12:30, the set-off planned, not till B's party goes out
    const rest = restsOf(re, 'hk').find(l => l.end > t)!;
    expect(rest, at).toMatchObject({ idle: true, at: BASE });
    expect(rest.start - T, at).toBeCloseTo(0.3, 9);
    expect(rest.end - T, at).toBeCloseTo(0.5, 9);
    // A at 12:35.4 at her rested rate, as its party goes out, then B
    const [onA, onB] = jobsOf(re, 'hk').filter(l => l.end > t);
    expect([onA?.placeId, onB?.placeId], at).toEqual([A.id, B.id]);
    expect(onA.start - T, at).toBeCloseTo(0.59, 9);
    expect(onA.workRate, at).toBeCloseTo(1.5, 9);
    expect(cleanedBy13(re, [A, B]), at).toEqual([3, 3]);
  };

  describe('On her way home to rest for her do-not-disturb room, just past the tired mark and tired again by the hour\'s end: she\'s timed as she\'ll be at the set-off planned, and an edit with nothing new leaves her plan as it was', () => {
    it('as planned: she walks home to the base by 12:18, rests there till 12:30, cleans A at her rested rate as its party goes out, then B, ending the hour tired again, and both rooms are cleaned', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B } = scene();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, 'ga', A, T)).toEqual([[0.56, 0.69]]);
        expect(away(s, 'gb', B, T)).toEqual([[0.76, 1.44]]);
        const [home] = restsOf(s, 'hk');
        expect(home).toMatchObject({ idle: true, at: BASE });
        expect(home.start - T).toBeCloseTo(0.3, 9);
        expect(home.end - T).toBeCloseTo(0.5, 9);
        const [onA, onB] = jobsOf(s, 'hk');
        expect([onA?.placeId, onB?.placeId]).toEqual([A.id, B.id]);
        expect(onA.start - T).toBeCloseTo(0.59, 9);
        expect(onA.workRate).toBeCloseTo(1.5, 9); // rested: a speedy veteran's full rate
        // at her tired rate A's clean and the step out wouldn't be done before its party is back at 12:41.4
        expect(0.59 + 0.1 / (1.5 * STAFF_FATIGUE.tiredRate) + TRAVEL.hoursPerTile).toBeGreaterThan(0.69);
        expect(onB.start - T).toBeGreaterThanOrEqual(0.76 - 1e-9);
        // under 60 at 12:06, tired from 12:07.2 on her way home, back under the mark by her set-off at 12:30, tired again
        // by 13:00 after B
        expect(energyAt(s, T + 0.1)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.15)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.5)).toBeLessThan(STAFF_FATIGUE.tiredAt - 1);
        expect(energyAt(s, T + 1)).toBeGreaterThan(STAFF_FATIGUE.tiredAt + 0.5);
        expect(cleanedBy13(s, [A, B])).toEqual([3, 3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a paused edit, a maintenance hire or a room built off her way at 12:09-12:17, her energy 60 or more: she still rests at the base till 12:30 and cleans A at her rested rate, then B, and both rooms are cleaned -- she isn't judged as she'll be once tired again after B`, () => withDesk(desk, () => {
        const { s, T, A, B } = scene();
        for (const dt of [0.15, 0.2, 0.25, 0.283]) {
          const t = T + dt;
          expect(energyAt(s, t)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
          for (const [kind, re] of Object.entries(edits(s, t))) expectAsPlanned(re, s, T, t, A, B, `${kind} at ${clock(dt)}`);
        }
      }));
    }

    it('control: the same edits at 12:03, her energy still under 60 when she next steps onto a tile, leave her plan as it was too', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B } = scene();
        const t = T + 0.05;
        expect(energyAt(s, T + 0.06)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        for (const [kind, re] of Object.entries(edits(s, t))) expectAsPlanned(re, s, T, t, A, B, `${kind} at ${clock(0.05)}`);
      });
    });
  });
}

// Which rooms count as new work while she rests at home for her own room (mutation check): not one a colleague later on the roster is still due to clean, but one a colleague re-planned before her gives up for the edit's new work, even the one that colleague was on her way to at the hour's end.
{
  // A colleague's do-not-disturb room isn't new work for the one resting at home for hers until that colleague has been re-planned and given it up.
  const PACE = TRAVEL.guestHoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  const SPEEDS = {
    slow: { experience: 'rookie', style: 'meticulous', stamina: 'high', workHours: 0 },
    mid: { experience: 'skilled', style: 'standard', stamina: 'normal', workHours: 100 },
    skilled: { experience: 'skilled', style: 'standard', stamina: 'high', workHours: 100 },
    fast: { experience: 'veteran', style: 'speedy', stamina: 'high', workHours: 500 },
  } as const;

  /** A housekeeper (a turnover runner) standing at `at`, at `fatigue` at `abs`; `own`: the room she was on at the hour's end, hers first this hour. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number, speed: keyof typeof SPEEDS, own?: Room): StaffMember {
    const p = SPEEDS[speed];
    return { id, serial: id.length + 1, name: id, role: 'housekeeper', dailyWage: 70, at, ...(own ? { roomId: own.id } : {}),
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: p.stamina, specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const itineraryOf = (s: HotelState, id: string) => getStaffPlan(s).itineraries.find(it => it.staffId === id)!;
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const clock = (T: number, x: number) => `${12 + Math.floor(x - T + 1e-9)}:${((((x - T) % 1) + 1) % 1 * 60).toFixed(1).padStart(4, '0')}`;
  /** Her cleans still to come after t, by room and time: 'B 12:51.6-13:00.0'. */
  const jobsAfter = (s: HotelState, id: string, t: number, names: Record<string, string>) => legsOf(s, id)
    .filter((l): l is StayLeg => l.kind === 'stay' && !!l.job && l.end > t + 1e-9)
    .map(l => `${names[l.placeId!] ?? l.placeId} ${clock(hourStart(s), l.start)}-${clock(hourStart(s), l.end)}`);
  /** When she leaves the base: the end of her last rest there. */
  const leavesBase = (s: HotelState, id: string) => {
    const rest = restsOf(s, id).filter(l => l.at.gridX === BASE.gridX && l.at.gridY === BASE.gridY).at(-1);
    return rest ? clock(hourStart(s), rest.end) : 'never';
  };
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /** The same whereabouts from t to the hour's end, or the first moment they differ. */
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${clock(hourStart(a), x)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  /** The day each room was last given its daily clean, after playing on `hours` hours. */
  const cleanedAfter = (s: HotelState, rooms: Room[], hours: number) => {
    let st = s;
    for (let h = 0; h < hours; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };

  /**
   * 12:00 on day 3: four standard rooms on row 5 from x = 3, their doors up onto the base's row 4. B (3, 5): a
   * do-not-disturb party out of the room 12:49.8-13:07.8, 0.1h of daily cleaning; X (4, 5): a 0.2h turnover; A (6, 5): a
   * do-not-disturb party out 12:40.8-12:58.8, 0.15h. hk (slow: a rookie, meticulous, high stamina), first on the roster,
   * rests at the base from 12:00 at just over 60, on her tired rate as the hour is planned: A's party isn't out long
   * enough for her, so she rests at the base till 12:46.2 and cleans B. She's under 60 from 12:01.8, and from then A would
   * fit her from the base too, with a set-off at 12:31.8. hk2 (skilled, fresh), after her on the roster, was on X at the
   * hour's end: she turns it round by 12:12, walks home, rests at the base till 12:31.8 and cleans A.
   */
  function sceneTaken() {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    const abs = 2 * 24 + 12, [B, X, , A] = s.rooms;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null,
      staff: { ...s.staff, housekeepers: 2, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', BASE, abs, 60.3, 'slow'), keeper('hk2', roomTile(X), abs, 20, 'mid', X)] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, A, T + 0.62, T + 1.04, 'ga'), goingOut(s, B, T + 0.77, T + 1.19, 'gb')],
      rooms: s.rooms.map(r => (r.id === A.id ? { ...r, status: 'occupied' as const, guestId: 'ga', dailyCleanHoursRemaining: 0.15 }
        : r.id === B.id ? { ...r, status: 'occupied' as const, guestId: 'gb', dailyCleanHoursRemaining: 0.1 }
          : r.id === X.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.2 } : r)) };
    const names: Record<string, string> = { [A.id]: 'A', [B.id]: 'B', [X.id]: 'X' };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, A, B, X, names };
  }
  /** The edits that bring nobody anything new: a paused edit, a maintenance hire, a room built off everyone's way at (8, 2). */
  const noOps = (s: HotelState, t: number) => ({
    paused: replanStaff(s, t),
    hire: settleChanges(s, hireCandidate(s, 'maintenance', hiringCandidates(s, 'maintenance')[0].id, undefined, t)!, t),
    built: settleChanges(s, addRoom(s, 'standard', 8, 2, 0, 'up')!, t),
  });

  describe('Resting at home for her own do-not-disturb room, with a colleague after her on the roster still due to clean another whose party goes out sooner: an edit with nothing new doesn\'t hand it to her', () => {
    it('as planned: hk rests at the base till 12:46.2 and cleans B from 12:51.6; hk2 turns X round, rests at the base till 12:31.8 and cleans A 12:42.6-12:51.6; under 60 from 12:01.8, A would fit hk from the base too', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B, names } = sceneTaken();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        // planned in roster order: hk before hk2
        expect(s.staffRoster!.filter(m => m.role === 'housekeeper').map(m => m.id)).toEqual(['hk', 'hk2']);
        expect(restsOf(s, 'hk')[0]).toMatchObject({ idle: true, at: BASE });
        expect(leavesBase(s, 'hk')).toBe('12:46.2');
        expect(jobsAfter(s, 'hk', T, names)).toEqual(['B 12:51.6-13:00.0']);
        expect(itineraryOf(s, 'hk').end.roomId).toBe(B.id);
        expect(jobsAfter(s, 'hk2', T, names)).toEqual(['X 12:00.0-12:12.0', 'A 12:42.6-12:51.6']);
        expect(leavesBase(s, 'hk2')).toBe('12:31.8');
        // tired as the hour's planned, under the tired mark as she rests from 12:01.8
        const hk = s.staffRoster!.find(m => m.id === 'hk')!;
        expect(fatigueAt(s, hk, T)).toBeGreaterThan(STAFF_FATIGUE.tiredAt);
        expect(fatigueAt(s, hk, T + 0.03)).toBeLessThanOrEqual(STAFF_FATIGUE.tiredAt + 1e-9);
        expect(cleanedAfter(s, [A, B], 2)).toEqual([3, 3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a paused edit, a maintenance hire or a room built off everyone's way at 12:02.1-12:11.4, as hk2 turns X round and hk rests under 60: A stays hk2's, and hk still rests at the base till 12:46.2 and cleans B, not off at 12:31.8 for A`, () => withDesk(desk, () => {
        const { s, T, A, B, names } = sceneTaken();
        for (const dt of [0.035, 0.05, 0.1, 0.15, 0.19]) {
          const t = T + dt;
          expect(fatigueAt(s, s.staffRoster!.find(m => m.id === 'hk')!, t)).toBeLessThanOrEqual(STAFF_FATIGUE.tiredAt + 1e-9);
          for (const [kind, re] of Object.entries(noOps(s, t))) {
            const at = `${kind} at ${clock(T, t)}`;
            // hk2 hasn't been re-planned when hk is: A, still to come in her plan, is hers, not new work for hk
            expect({ at, leaves: leavesBase(re, 'hk'), jobs: jobsAfter(re, 'hk', t, names), hk2: jobsAfter(re, 'hk2', t, names).at(-1) })
              .toEqual({ at, leaves: '12:46.2', jobs: ['B 12:51.6-13:00.0'], hk2: 'A 12:42.6-12:51.6' });
            // at 12:36 hk is still resting at the base, not on her way to A
            expect(where(re, 'hk', T + 0.6), at).toMatch(/^1\.000,4\.000,0 rest/);
            // nothing new: both plans for the rest of the hour are the ones they had
            expect(samePlan(re, s, 'hk', t), at).toBe(true);
            expect(samePlan(re, s, 'hk2', t), at).toBe(true);
            if (kind === 'paused') expect(cleanedAfter(re, [A, B], 2), at).toEqual([3, 3]);
          }
        }
      }));
    }
  });

  /**
   * 12:00 on day 3: four standard rooms on row 2 from x = 3, their doors up onto row 1; the base at (1, 4). D1 (3, 2): a
   * do-not-disturb party out of the room 12:51.0-13:26.4, 0.1h of daily cleaning; D2 (4, 2): one out 12:40.8-13:14.4,
   * 0.1h; X (5, 2) empty; Y (6, 2) a 0.93h turnover. hk-b (skilled, high stamina), first on the roster, was on Y at the
   * hour's end: she turns it round by 12:55.8 and walks on to D2's door, still on her way at 13:00 (D2 is hers into the
   * next hour; nothing of it is cleaned this hour). hk-a (a veteran, speedy), after her on the roster, rests at the base
   * till 12:42 and cleans D1 12:52.8-12:56.8. From the base, D2's own set-off is 12:30.
   */
  function sceneOnHerWay() {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
    const abs = 2 * 24 + 12, [D1, D2, X, Y] = s.rooms;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null,
      staff: { ...s.staff, housekeepers: 2, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk-b', roomTile(Y), abs, 0, 'skilled', Y), keeper('hk-a', BASE, abs, 0, 'fast')] };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: [goingOut(s, D1, T + 0.79, T + 1.5, 'g1'), goingOut(s, D2, T + 0.62, T + 1.3, 'g2')],
      rooms: s.rooms.map(r => (r.id === D1.id ? { ...r, status: 'occupied' as const, guestId: 'g1', dailyCleanHoursRemaining: 0.1 }
        : r.id === D2.id ? { ...r, status: 'occupied' as const, guestId: 'g2', dailyCleanHoursRemaining: 0.1 }
          : r.id === Y.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.93 } : r)) };
    const names: Record<string, string> = { [D1.id]: 'D1', [D2.id]: 'D2', [X.id]: 'X', [Y.id]: 'Y' };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, D1, D2, X, Y, names };
  }
  const dirty = (s: HotelState, room: Room, hours: number): HotelState =>
    ({ ...s, rooms: s.rooms.map(r => (r.id === room.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: hours } : r)) });

  describe('Resting at home for her own do-not-disturb room, a colleague re-planned before her gives up the one she was on her way to at the hour\'s end for the edit\'s new work: it\'s new work for her', () => {
    it('as planned: hk-b turns Y round till 12:55.8 and is on her way to D2 at 13:00, no clean of it this hour; hk-a rests at the base till 12:42 and cleans D1 12:52.8-12:56.8', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, D1, D2, names } = sceneOnHerWay();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(s.staffRoster!.filter(m => m.role === 'housekeeper').map(m => m.id)).toEqual(['hk-b', 'hk-a']);
        expect(jobsAfter(s, 'hk-b', T, names)).toEqual(['Y 12:00.0-12:55.8']);
        expect(itineraryOf(s, 'hk-b').end.roomId).toBe(D2.id);
        expect(where(s, 'hk-b', T + 0.99)).toMatch(/ walk$/);
        expect(restsOf(s, 'hk-a')[0]).toMatchObject({ idle: true, at: BASE });
        expect(leavesBase(s, 'hk-a')).toBe('12:42.0');
        expect(jobsAfter(s, 'hk-a', T, names)).toEqual(['D1 12:52.8-12:56.8']);
        // by 13:00 D1 has its daily clean; D2 gets hers next hour
        expect(cleanedAfter(s, [D1, D2], 1)).toEqual([3, 0]);
        expect(cleanedAfter(s, [D1, D2], 2)).toEqual([3, 3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: X dirtied (0.5h of turnover) at 12:03-12:24, as hk-a rests at the base: hk-b takes X after Y and gives up D2; hk-a sets off for D2 at its own set-off, 12:30, not at 12:42, cleans it 12:42.6-12:46.6, then D1 as planned, and both are cleaned by 13:00`, () => withDesk(desk, () => {
        const { s, T, D1, D2, X, names } = sceneOnHerWay();
        for (const dt of [0.05, 0.1, 0.2, 0.3, 0.4]) {
          const t = T + dt, at = `X dirtied at ${clock(T, t)}`;
          const re = settleChanges(s, dirty(s, X, 0.5), t);
          // hk-b, planned first, turns Y round, then X to the hour's end: D2 is no longer hers
          expect({ at, b: jobsAfter(re, 'hk-b', t, names).map(j => j.split(' ')[0]), end: names[itineraryOf(re, 'hk-b').end.roomId ?? ''] })
            .toEqual({ at, b: ['Y'], end: 'X' });
          // D2 is new work for hk-a: off from the base at its own set-off, at 12:36 on her way or at its door, D2 cleaned
          // as its party is out, then D1 as planned
          expect({ at, leaves: leavesBase(re, 'hk-a'), at1236: where(re, 'hk-a', T + 0.6).split(' ')[1], jobs: jobsAfter(re, 'hk-a', t, names) })
            .toEqual({ at, leaves: '12:30.0', at1236: 'walk', jobs: ['D2 12:42.6-12:46.6', 'D1 12:52.8-12:56.8'] });
          expect(cleanedAfter(re, [D1, D2], 1), at).toEqual([3, 3]);
        }
      }));
    }

    it('control: a paused edit, or a room built off everyone\'s way at (8, 5), at 12:03-12:24 brings nobody anything new: hk-b still heads on to D2 after Y, and hk-a rests at the base till 12:42 for D1', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, D2, names } = sceneOnHerWay();
        for (const dt of [0.05, 0.1, 0.2, 0.3, 0.4]) {
          const t = T + dt;
          for (const [kind, re] of [['paused', replanStaff(s, t)], ['built', settleChanges(s, addRoom(s, 'standard', 8, 5, 0, 'up')!, t)]] as const) {
            const at = `${kind} at ${clock(T, t)}`;
            expect(itineraryOf(re, 'hk-b').end.roomId, at).toBe(D2.id);
            expect({ at, leaves: leavesBase(re, 'hk-a'), jobs: jobsAfter(re, 'hk-a', t, names) }).toEqual({ at, leaves: '12:42.0', jobs: ['D1 12:52.8-12:56.8'] });
            for (const id of ['hk-b', 'hk-a']) expect(samePlan(re, s, id, t), `${at}: ${id}`).toBe(true);
          }
        }
      });
    });
  });
}

// Her own room's set-off from home, kept or moved (mutation check): with her way a little shorter she still leaves at the set-off planned; a room a let-go hands her is timed as ever, not by her own room's set-off; with her own room made impossible she sets off at once for the next room of her plan; and a little too tired just now but rested by the set-off planned, a room she'd reach only next hour keeps that set-off.
{
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  /** Where the far housekeepers start the hour: the hallway at (8, 1). */
  const FAR = { gridX: 8, gridY: 1, floor: 0 };
  const KINDS = {
    fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
    slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
  } as const;
  type Kind = keyof typeof KINDS;

  /** A housekeeper (high stamina, a turnover runner) of the given kind standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, serial: number, kind: Kind, at: TilePos, abs: number, fatigue: number): StaffMember {
    const p = KINDS[kind];
    return { id, serial, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build, a demolish or a hire). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /** A party: [its room's x, y, walks out at, back at, daily cleaning hours] (hours from 12:00). */
  type Party = [number, number, number, number, number];
  /**
   * 12:00 on day 3. 'row5': six standard rooms on row 5 (x 3..8, doors up onto the base's row 4) and an entrance at (9, 4).
   * 'row2': eight standard rooms on row 2 (x 1..8, doors up onto row 1) and an entrance at (0, 1). `extra`: rooms built
   * before the hour's plan is made; `staff`, the roster in order; `walkingIn`: who's on her way home from (8, 1) since
   * 11:52.8, carried into the hour.
   */
  function hotel(layout: 'row2' | 'row5', extra: [number, number][], staff: (abs: number) => StaffMember[], parties: Party[], walkingIn: string[] = []) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    if (layout === 'row5') {
      for (let x = 3; x <= 8; x++) s = addRoom(s, 'standard', x, 5, 0, 'up')!;
      s = addFixture(s, 'entrance', 9, 4, 0)!;
    } else {
      for (let x = 1; x <= 8; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
      s = addFixture(s, 'entrance', 0, 1, 0)!;
    }
    for (const [x, y] of extra) s = addRoom(s, 'standard', x, y, 0, 'up')!;
    const abs = 2 * 24 + 12;
    const roster = staff(abs);
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null,
      staff: { ...s.staff, housekeepers: roster.length, maintenanceWorkers: 0 }, staffRoster: roster };
    s = syncStaff(s);
    const home = findRoute(s, FAR, BASE, STEP)!;
    s = { ...s, staffRoster: s.staffRoster!.map(m => (walkingIn.includes(m.id) ? { ...m, at: BASE, carry: makeWalk(home.path, abs - 0.12, STEP) } : m)) };
    const T = hourStart(s);
    const rooms = parties.map(([x, y]) => s.rooms.find(r => r.gridX === x && r.gridY === y)!);
    s = { ...s, guests: parties.map(([, , leave, back], i) => goingOut(s, rooms[i], T + leave, T + back, `g${i}`)),
      rooms: s.rooms.map(r => {
        const i = rooms.findIndex(q => q.id === r.id);
        return i < 0 ? r : { ...r, status: 'occupied' as const, guestId: `g${i}`, dailyCleanHoursRemaining: parties[i][4] };
      }) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, rooms: rooms.map(r => s.rooms.find(q => q.id === r.id)!) };
  }

  const itineraryOf = (s: HotelState, id: string) => getStaffPlan(s).itineraries.find(it => it.staffId === id)!;
  const legsOf = (s: HotelState, id: string): Leg[] => itineraryOf(s, id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  const walksOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is WalkLeg => l.kind === 'walk');
  const tile = (p: TilePos) => `${p.gridX},${p.gridY}`;
  /** Each leg in brief, times from 12:00 in hours. */
  const brief = (s: HotelState, legs: Leg[]) => legs.map(l => (l.kind === 'walk'
    ? `walk ${l.path.map(tile).join('>')} ${(l.start - hourStart(s)).toFixed(6)}-${(l.end - hourStart(s)).toFixed(6)}`
    : `${l.activity}${l.idle ? ' (spare)' : ''}${l.job ? ` ${l.placeId}` : ''} at ${tile(l.at)} ${(l.start - hourStart(s)).toFixed(6)}-${(l.end - hourStart(s)).toFixed(6)}`));
  /**
   * What someone does from t on: each stop (activity, spot, times, a stay split in two taken as one) and, for each run of
   * walks, where it takes her and when she's there -- the tiles a walk passes through can differ between ways of the same
   * length, and a re-plan can split a walk or a stay where it was under way.
   */
  const stopsFrom = (s: HotelState, id: string, t: number) => {
    const T = hourStart(s), legs = legsOf(s, id).filter(l => l.end > t + 1e-9), out: { key: string; start: number | null; end: number }[] = [];
    legs.forEach((l, i) => {
      if (l.kind === 'walk') {
        if (legs[i + 1]?.kind !== 'walk') out.push({ key: `walk to ${tile(l.path.at(-1)!)}`, start: null, end: l.end });
        return;
      }
      const key = `${l.activity}${l.idle ? ' (spare)' : ''}${l.job ? ` ${l.placeId}` : ''} at ${tile(l.at)}`, last = out.at(-1);
      if (last && last.key === key && Math.abs(last.end - l.start) < 1e-9) last.end = l.end;
      else out.push({ key, start: Math.max(l.start, t), end: l.end });
    });
    return out.map(o => (o.start === null ? `${o.key}, there at ${(o.end - T).toFixed(6)}` : `${o.key} ${(o.start - T).toFixed(6)}-${(o.end - T).toFixed(6)}`));
  };
  const away = (s: HotelState, room: Room, T: number) =>
    awayStretches(s.guests.find(g => g.id === room.guestId)!, room).map(([a, b]) => [+(a - T).toFixed(4), +(b - T).toFixed(4)]);
  /** The day each room was last given its daily clean, once two hours are played (some cleans run past 13:00). */
  const cleanedBy14 = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  const clock = (dt: number) => `${12 + Math.floor(dt + 1e-9)}:${(((dt % 1) + 1) % 1 * 60).toFixed(1).padStart(4, '0')}`;
  const energyAt = (s: HotelState, id: string, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === id)!, x);

  // ---- 1. A shorter way to her door: she still sets off at the set-off planned, is there sooner, and has time for the next room

  /**
   * 'row5' with a room at (4, 4) blocking the base's hallway, so the way from the base to the doors east of it is round by
   * row 3. One fast housekeeper, a (fatigue 54), at (8, 1). R7 (7, 5): its party walks out at 12:24.2, back 12:58.9 (out of
   * the room 12:27.8-12:55.3), 0.05 h of daily cleaning; R6 (6, 5): out at 12:27.6, back 13:00.8 (out of the room
   * 12:31.2-12:57.2), 0.4 h. The hour's plan: she walks home by 12:18, too late to set off from there for R7's door as its
   * party goes out (8 tiles round), rests at the base (spare time) till 12:18.6 -- R6's set-off from there -- and walks
   * round to R7's door, there at 12:33, after its party is out, and cleans R7 12:34.8-12:36.8. After that R6 doesn't fit
   * before its party's back, so she rests out the hour.
   */
  const shorterWay = () => hotel('row5', [[4, 4]], abs => [keeper('a', 1, 'fast', FAR, abs, 54)],
    [[7, 5, 0.404, 0.981, 0.05], [6, 5, 0.46, 1.014, 0.4]]);
  /** The room at (4, 4) demolished at t, as the game does it: the base's hallway is open again. */
  const opened = (s: HotelState, t: number) => settleChanges(s, demolishRoom(s, s.rooms.find(r => r.gridX === 4 && r.gridY === 4)!.id)!, t);

  describe('On her way home to rest for her do-not-disturb room, a room demolished that makes her way to its door a little shorter: she still rests at home till the set-off planned, is at the door sooner, and has time for the next room too', () => {
    it('as planned: home by 12:18, resting at the base till 12:18.6, at R7\'s door at 12:33 (8 tiles round by row 3) and cleaning it 12:34.8-12:36.8; R6 left uncleaned', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, rooms: [R7, R6] } = shorterWay();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R7, T)).toEqual([[0.464, 0.921]]);
        expect(away(s, R6, T)).toEqual([[0.52, 0.954]]);
        const [home, toR7] = walksOf(s, 'a');
        expect(tile(home.path.at(-1)!)).toBe(tile(BASE));
        expect(home.end - T).toBeCloseTo(0.3, 9);
        const [rest] = restsOf(s, 'a');
        expect(rest).toMatchObject({ idle: true, at: BASE });
        expect([rest.start - T, rest.end - T].map(x => +x.toFixed(6))).toEqual([0.3, 0.31]);
        // from home she'd have to leave at 12:13.4 to be at R7's door as its party goes out: before she's home
        expect(toR7.path.length - 1).toBe(8);
        expect(0.464 - 8 * STEP).toBeLessThan(0.3);
        // R6's set-off from the base: 7 tiles round before its party is out
        expect(0.52 - 7 * STEP).toBeCloseTo(0.31, 9);
        expect(toR7.end - T).toBeCloseTo(0.55, 9);
        expect(brief(s, jobsOf(s, 'a'))).toEqual([`clean ${R7.id} at 7,5 0.580000-0.613333`]);
        expect(cleanedBy14(s, [R7, R6])).toEqual([3, 0]);
        // with (4, 4) open, the base is 6 tiles from R7's door: still too far to make it from home as R7's party goes out
        const open = demolishRoom(s, s.rooms.find(r => r.gridX === 4 && r.gridY === 4)!.id)!;
        expect(findRoute(open, BASE, { gridX: 7, gridY: 4, floor: 0 })!.path.length - 1).toBe(6);
        expect(0.464 - 6 * STEP).toBeLessThan(0.3);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: the room at (4, 4) demolished at 12:01.2 or 12:03: she still rests at the base till 12:18.6, the set-off planned (not later, to be at R7's door only when planned), is at R7's door at 12:29.4, cleans it 12:31.2-12:33.2, and then R6 12:38.6-12:54.6`, () => withDesk(desk, () => {
        const { s, T, rooms: [R7, R6] } = shorterWay();
        for (const dt of [0.02, 0.05]) {
          const t = T + dt, at = `demolished at ${clock(dt)}`;
          const re = opened(s, t);
          // still home by 12:18, resting there till the set-off planned
          const rest = restsOf(re, 'a').find(l => l.end > t + 1e-9)!;
          expect(rest, at).toMatchObject({ idle: true, at: BASE });
          expect(rest.start - T, at).toBeCloseTo(0.3, 9);
          expect(rest.end - T, at).toBeCloseTo(0.31, 9);
          // then the shorter way to R7's door, there sooner than planned
          const toR7 = walksOf(re, 'a').find(l => l.start >= rest.end - 1e-9)!;
          expect(toR7.start, at).toBeCloseTo(rest.end, 9);
          expect(tile(toR7.path.at(-1)!), at).toBe('7,4');
          expect(toR7.path.length - 1, at).toBe(6);
          expect(toR7.end - T, at).toBeCloseTo(0.49, 9);
          // R7 cleaned four minutes sooner, which leaves time for R6 before its party's back
          expect(brief(re, jobsOf(re, 'a')), at).toEqual([`clean ${R7.id} at 7,5 0.520000-0.553333`, `clean ${R6.id} at 6,5 0.643333-0.910000`]);
          expect(waitsOf(re, 'a').filter(l => l.end > t + 1e-9).map(l => brief(re, [l])[0]), at).toEqual([]);
          expect(cleanedBy14(re, [R7, R6]), at).toEqual([3, 3]);
        }
      }));
    }
  });

  // ---- 2. A room a let-go hands her is timed as ever, not by her own room's set-off

  /**
   * 'row5' with the base's hallway open. b (a slow rookie, fatigue 59.5, first on the roster) is on her way home from
   * (8, 1), there at 12:10.8, and walks on to R7's door, waits there for its party and cleans R7 12:26.9-12:38. a (fast,
   * fatigue 30) at (8, 1): she walks home by 12:18, rests at the base (spare time) till 12:31.9 and cleans R6 as its party
   * goes out, 12:42.7-12:46.7. R7 (7, 5): its party walks out at 12:21.5, back 12:54.3 (out of the room 12:25.1-12:50.7);
   * R6 (6, 5): out at 12:37.3, back 12:56 (out of the room 12:40.9-12:52.4); 0.1 h of daily cleaning each.
   */
  const handed = () => hotel('row5', [], abs => [keeper('b', 1, 'slow', BASE, abs, 59.5), keeper('a', 2, 'fast', FAR, abs, 30)],
    [[7, 5, 0.359, 0.905, 0.1], [6, 5, 0.621, 0.933, 0.1]], ['b']);
  /** The player lets b go at t, as the game does it. */
  const letGo = (s: HotelState, t: number) => settleChanges(s, dismissStaff(s, 'b', t)!, t);

  describe('On her way home to rest for her do-not-disturb room, handed another by a let-go: the handed room is timed as ever, not by her own room\'s set-off, and both rooms are cleaned', () => {
    it('as planned: b cleans R7 12:26.9-12:38; a walks home by 12:18, rests at the base till 12:31.9 and cleans R6 12:42.7-12:46.7; from home a couldn\'t be at R7\'s door as its party goes out', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, rooms: [R7, R6] } = handed();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R7, T)).toEqual([[0.419, 0.845]]);
        expect(away(s, R6, T)).toEqual([[0.681, 0.873]]);
        expect(brief(s, jobsOf(s, 'b'))).toEqual([`clean ${R7.id} at 7,5 0.449000-0.632824`]);
        const [rest] = restsOf(s, 'a');
        expect(rest).toMatchObject({ idle: true, at: BASE });
        expect([rest.start - T, rest.end - T].map(x => +x.toFixed(6))).toEqual([0.3, 0.531]);
        expect(brief(s, jobsOf(s, 'a'))).toEqual([`clean ${R6.id} at 6,5 0.711000-0.777667`]);
        // the base is 6 tiles from R7's door: from home she'd have to leave at 12:14.3, before she's home
        expect(findRoute(s, BASE, { gridX: 7, gridY: 4, floor: 0 })!.path.length - 1).toBe(6);
        expect(0.419 - 6 * STEP).toBeLessThan(0.3);
        expect(cleanedBy14(s, [R7, R6])).toEqual([3, 3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: b let go at 12:00.6 or 12:01.2: a takes R7 as a fresh plan would -- at its door as its party goes out at 12:25.1, cleaning it from 12:26.9 -- and still cleans R6 from 12:42.7, as planned; not resting at home till 12:30 and getting to R7 only when R6 was due`, () => withDesk(desk, () => {
        const { s, T, rooms: [R7, R6] } = handed();
        for (const dt of [0.01, 0.02]) {
          const t = T + dt, at = `let go at ${clock(dt)}`;
          const re = letGo(s, t);
          expect(jobsOf(re, 'b').filter(l => l.end > t), at).toEqual([]);
          // at R7's door as its party goes out, and on to R6 for its clean as planned
          const toR7 = walksOf(re, 'a').find(l => tile(l.path.at(-1)!) === '7,4')!;
          expect(toR7.end - T, at).toBeCloseTo(0.419, 9);
          expect(brief(re, jobsOf(re, 'a')), at).toEqual([`clean ${R7.id} at 7,5 0.449000-0.515667`, `clean ${R6.id} at 6,5 0.711000-0.777667`]);
          // no rest at the base: she doesn't go home for R6 any more
          expect(restsOf(re, 'a').filter(l => l.end > t + 1e-9 && l.start < T + 0.7).map(l => brief(re, [l])[0]), at).toEqual([]);
          expect(cleanedBy14(re, [R7, R6]), at).toEqual([3, 3]);
        }
      }));
    }
  });

  // ---- 3. Her own room impossible this hour: the next room of her plan is done, whatever other party is still to go out

  /**
   * 'row2' with a room S at (3, 5), its door up onto (3, 4), two tiles from the base. One slow rookie, a (fatigue 30), at
   * (5, 0). R2 (2, 2): its party walks out at 12:44.9, back 13:17.8 (out of the room 12:48.5-13:14.2); R3 (3, 2): out at
   * 12:49.6, back 13:26.4 (out of the room 12:53.2-13:22.8); 0.1 h of daily cleaning each. S: out of the room 12:48-13:50.4,
   * 0.05 h. The hour's plan: she walks home the short way by (0, 3), rests at the base (spare time) till 12:37.7, cleans R2
   * 12:50.3-12:59.7 and walks on to R3's door; S waits for the next hour.
   */
  const ownLost = () => hotel('row2', [[3, 5]], abs => [keeper('a', 1, 'slow', { gridX: 5, gridY: 0, floor: 0 }, abs, 30)],
    [[2, 2, 0.748, 1.297, 0.1], [3, 2, 0.826, 1.44, 0.1], [3, 5, 0.8 - PACE, 1.9, 0.05]]);
  /** A room built at (0, 3) at t, closing the short way from the base to the rooms' hallway. */
  const closed = (s: HotelState, t: number) => settleChanges(s, addRoom(s, 'standard', 0, 3, 0, 'up')!, t);

  describe('Resting at home for her do-not-disturb room, an edit makes it impossible this hour: the next room of her plan, startable on arrival, is done -- not put off for another party\'s room that goes out later this hour', () => {
    it('as planned: she rests at the base till 12:37.7, cleans R2 12:50.3-12:59.7 and walks on to R3\'s door; S\'s party is out from 12:48, its set-off from the base 12:44.4; with a room at (0, 3), the base is 18 tiles from R2\'s door and 17 from R3\'s', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, rooms: [R2, R3, S] } = ownLost();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R2, T)).toEqual([[0.808, 1.237]]);
        expect(away(s, R3, T)).toEqual([[0.886, 1.38]]);
        expect(away(s, S, T)).toEqual([[0.8, 1.84]]);
        expect(brief(s, legsOf(s, 'a'))).toEqual([
          'walk 5,0>4,0>3,0>2,0>1,0>0,0>0,1>0,2>0,3>0,4>1,4 0.000000-0.300000',
          'rest (spare) at 1,4 0.300000-0.628000',
          'walk 1,4>0,4>0,3>0,2>0,1>1,1>2,1 0.628000-0.808000',
          'walk 2,1>2,2 0.808000-0.838000',
          `clean ${R2.id} at 2,2 0.838000-0.994250`,
          'walk 2,2>2,1>3,1 0.994250-1.054250',
        ]);
        expect(itineraryOf(s, 'a').end.roomId).toBe(R3.id);
        expect(findRoute(s, BASE, { gridX: 3, gridY: 4, floor: 0 })!.path.length - 1).toBe(2);
        expect(cleanedBy14(s, [R2, R3, S])).toEqual([3, 3, 3]);
        const shut = addRoom(s, 'standard', 0, 3, 0, 'up')!;
        expect(findRoute(shut, BASE, { gridX: 2, gridY: 1, floor: 0 })!.path.length - 1).toBe(18);
        expect(findRoute(shut, BASE, { gridX: 3, gridY: 1, floor: 0 })!.path.length - 1).toBe(17);
        // leaving the base at 12:30 she'd be at R2's door at 13:02.4: in, its clean and out again end after its party is
        // back at 13:14.2 -- R2 can't be done; at R3's door at 13:00.6, its party out, she can start on it on arrival
        expect(0.5 + 18 * STEP + STEP + 0.15625 + STEP).toBeGreaterThan(1.237);
        expect(0.5 + 17 * STEP).toBeGreaterThan(0.886);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a room built at (0, 3) at 12:30 or 12:31.2, as she rests at the base for R2: R2 is lost, but she sets off at once the long way for R3's door and cleans R3 -- not resting at the base till S's set-off at 12:44.4 and cleaning S instead, R3 then lost too -- and S is still cleaned`, () => withDesk(desk, () => {
        const { s, T, rooms: [R2, R3, S] } = ownLost();
        for (const dt of [0.5, 0.52]) {
          const t = T + dt, at = `built at ${clock(dt)}`;
          const re = closed(s, t);
          // no more rest at the base, and no wait anywhere, for the rest of the hour
          expect(restsOf(re, 'a').filter(l => l.end > t + 1e-9).map(l => brief(re, [l])[0]), at).toEqual([]);
          expect(waitsOf(re, 'a').filter(l => l.end > t + 1e-9).map(l => brief(re, [l])[0]), at).toEqual([]);
          // she walks from the base at once, the 17 tiles to R3's door, there at t + 0.51
          const walks = walksOf(re, 'a').filter(l => l.end > t + 1e-9);
          expect(walks[0].start, at).toBeCloseTo(t, 9);
          expect(tile(walks[0].path[0]), at).toBe(tile(BASE));
          expect(tile(walks.at(-1)!.path.at(-1)!), at).toBe('3,1');
          expect(walks.at(-1)!.end - T, at).toBeCloseTo(dt + 17 * STEP, 9);
          expect(walks.reduce((n, l) => n + l.path.length - 1, 0), at).toBe(17);
          // nothing cleaned by her this hour (not S); headed for R3 at 13:00, and R3 and S get their daily clean
          expect(jobsOf(re, 'a').filter(l => l.end > t).map(l => l.placeId), at).toEqual([]);
          expect(itineraryOf(re, 'a').end.roomId, at).toBe(R3.id);
          expect(cleanedBy14(re, [R2, R3, S]), at).toEqual([0, 3, 3]);
        }
      }));
    }
  });

  // ---- 4. A little too tired just now, rested by the set-off planned, her room reached from home only next hour: the set-off stands

  /**
   * 'row2' with a room at (0, 3) closing the short way from the base, and S at (3, 5) (its door up onto (3, 4), two tiles
   * from the base). c (fast, fatigue 59.92, first on the roster) at (5, 0): she walks home the long way round by (9, 2) and
   * row 3 (16 tiles), crossing 60 at about 12:01.6, there at 12:28.8, rests at the base (spare time) till 12:50.4 -- S's
   * set-off from there, though S is a's -- back under 58 by then, and walks the 18 tiles to R2's door, there at 13:22.8,
   * next hour. a (fast, fatigue 30) rests at the base for S and cleans it. R2 (2, 2): its party is out of the room
   * 12:57.9-13:30.8, 0.1 h of daily cleaning: from 13:22.8 the step in, the clean and the step out take 7.6 minutes at her
   * rested rate (as she'll be) but 8.3 at her tired one (as she is on her way home) -- too long. S: out 12:54-13:50.4, 0.05 h.
   */
  const tiredNow = () => hotel('row2', [[0, 3], [3, 5]], abs => [
    keeper('c', 1, 'fast', { gridX: 5, gridY: 0, floor: 0 }, abs, 59.92),
    keeper('a', 2, 'fast', BASE, abs, 30),
  ], [[2, 2, 0.965 - PACE, 1.574, 0.1], [3, 5, 0.9 - PACE, 1.9, 0.05]]);
  /** The edits that bring c nothing new: a paused edit, a maintenance hire, a room built far off at (6, 5). */
  const edits = (s: HotelState, t: number) => ({
    paused: replanStaff(s, t),
    hire: settleChanges(s, hireCandidate(s, 'maintenance', hiringCandidates(s, 'maintenance')[0].id, undefined, t)!, t),
    built: settleChanges(s, addRoom(s, 'standard', 6, 5, 0, 'up')!, t),
  });

  describe('On her way home to rest for her do-not-disturb room, a little too tired for it just now but rested by the set-off planned, the room one she\'d reach from home only next hour: an edit with nothing new keeps that set-off -- she rests at home till it, not standing in the hallway', () => {
    it('as planned: c walks home by 12:28.8, tired from about 12:01.6, rests at the base till 12:50.4, back under 58, and is on her way to R2 at the hour\'s end, at its door at 13:22.8; R2 and S both get their daily clean', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, rooms: [R2, S] } = tiredNow();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R2, T)).toEqual([[0.965, 1.514]]);
        expect(away(s, S, T)).toEqual([[0.9, 1.84]]);
        const [home, toR2] = walksOf(s, 'c');
        expect([home.start - T, home.end - T].map(x => +x.toFixed(6))).toEqual([0, 0.48]);
        expect(home.path).toContainEqual({ gridX: 9, gridY: 2, floor: 0 }); // the long way round
        expect(restsOf(s, 'c')).toHaveLength(1);
        expect(restsOf(s, 'c')[0]).toMatchObject({ idle: true, at: BASE });
        expect([restsOf(s, 'c')[0].start - T, restsOf(s, 'c')[0].end - T].map(x => +x.toFixed(6))).toEqual([0.48, 0.84]);
        expect(toR2.path.length - 1).toBe(18);
        expect(toR2.end - T).toBeCloseTo(1.38, 9);
        expect(waitsOf(s, 'c')).toEqual([]);
        expect(jobsOf(s, 'c')).toEqual([]);
        expect(itineraryOf(s, 'c').end.roomId).toBe(R2.id);
        // from home she could be at R2's door as its party goes out only by leaving at 12:25.5, before she's home
        expect(0.965 - 18 * STEP).toBeLessThan(0.48);
        // tired on her way home; well rested by the set-off, so the walk and the clean won't tire her again
        expect(energyAt(s, 'c', T + 0.02)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, 'c', T + 0.03)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, 'c', T + 0.48)).toBeGreaterThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, 'c', T + 0.84)).toBeLessThan(58);
        // a rests at the base till 12:50.4 too and cleans S
        expect(restsOf(s, 'a')[0]).toMatchObject({ idle: true, at: BASE });
        expect(restsOf(s, 'a')[0].end - T).toBeCloseTo(0.84, 9);
        expect(jobsOf(s, 'a').map(l => l.placeId)).toContain(S.id);
        expect(cleanedBy14(s, [R2, S])).toEqual([3, 3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a paused edit, a maintenance hire or a room built at (6, 5) at 12:01.8-12:18, her energy 60 or more: she walks on home, rests at the base till 12:50.4 and walks on to R2's door, there at 13:22.8 -- not standing in the hallway till R2's party goes out -- and both rooms are cleaned`, () => withDesk(desk, () => {
        const { s, T, rooms } = tiredNow();
        for (const dt of [0.03, 0.06, 0.1, 0.2, 0.3]) {
          const t = T + dt;
          expect(energyAt(s, 'c', t)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
          for (const [kind, re] of Object.entries(edits(s, t))) {
            const at = `${kind} at ${clock(dt)}`;
            // she doesn't stop on her way to stand in the hallway
            expect(waitsOf(re, 'c').filter(l => l.end > t + 1e-9).map(l => brief(re, [l])[0]), at).toEqual([]);
            // she walks on home and rests there (spare time) till the set-off planned
            const rest = restsOf(re, 'c').find(l => l.end > t + 1e-9);
            expect(rest, at).toMatchObject({ idle: true, at: BASE });
            expect(rest!.start - T, at).toBeCloseTo(0.48, 9);
            expect(rest!.end - T, at).toBeCloseTo(0.84, 9);
            // nothing new: what she and a stop to do for the rest of the hour is as planned, and both rooms get their clean
            expect(stopsFrom(re, 'c', t), at).toEqual(stopsFrom(s, 'c', t));
            expect(stopsFrom(re, 'a', t), at).toEqual(stopsFrom(s, 'a', t));
            expect(itineraryOf(re, 'c').end.roomId, at).toBe(rooms[0].id);
            expect(cleanedBy14(re, rooms), at).toEqual([3, 3]);
          }
        }
      }));
    }
  });
}

// Just past the tired mark on her way home, still able to time her own room from where she is at her tired rate, she's timed from home at her rested rate by the set-off planned, so an edit with nothing new leaves her resting at the base till then rather than standing in the hallway (mutation check).
{
  // Just past the tired mark on her way home, still able to time her do-not-disturb room from where she is at her tired rate, she's timed from home at her rested rate by the set-off planned, so an edit with nothing new leaves her resting at the base till then rather than standing in the hallway (mutation check).
  const PACE = TRAVEL.guestHoursPerTile;
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A fast housekeeper (a speedy veteran, high stamina, turnover runner) standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, serial: number, at: TilePos, abs: number, fatigue: number): StaffMember {
    return { id, serial, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: 'veteran', style: 'speedy', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: 500, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: two standard rooms on row 5, their doors up onto the base's row 4. R2 (8, 5): a do-not-disturb
   * party out of the room 12:22.8-12:42.1, 0.1h of daily cleaning; R6 (3, 5): one out 12:25.2-13:20.4, 0.05h. hk
   * (fast, high stamina, at 59.9 at 12:00, first on the roster) at R2's door (8, 4); a colleague (at 30) at the base.
   * hk walks home to the base by 12:12.6 (crossing 60 at 12:02 on the way), rests there till 12:21.6 (back under 60 by
   * then), walks back and cleans R2 12:36-12:40 at her rested rate, then R6 from 12:52.6 at her tired rate (60 again by
   * then), and rests at R6's door; the colleague rests at the base all hour. R2's party is out just long enough for her
   * clean at her rested rate, not at her tired one.
   */
  function scene() {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    s = addRoom(s, 'standard', 8, 5, 0, 'up')!;
    s = addRoom(s, 'standard', 3, 5, 0, 'up')!;
    const abs = 2 * 24 + 12;
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 2, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', 1, { gridX: 8, gridY: 4, floor: 0 }, abs, 59.9), keeper('mate', 2, BASE, abs, 30)] };
    s = syncStaff(s);
    const T = hourStart(s), [R2, R6] = s.rooms;
    s = { ...s, guests: [goingOut(s, R2, T + 0.32, T + 0.7617, 'g2'), goingOut(s, R6, T + 0.36, T + 1.4, 'g6')],
      rooms: s.rooms.map(r => (r.id === R2.id ? { ...r, status: 'occupied' as const, guestId: 'g2', dailyCleanHoursRemaining: 0.1 }
        : r.id === R6.id ? { ...r, status: 'occupied' as const, guestId: 'g6', dailyCleanHoursRemaining: 0.05 } : r)) };
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, R2, R6 };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const staysOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay');
  const restsOf = (s: HotelState, id: string) => staysOf(s, id).filter(l => l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => staysOf(s, id).filter(l => !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  const energyAt = (s: HotelState, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === 'hk')!, x);
  const away = (s: HotelState, g: string, room: Room, T: number) =>
    awayStretches(s.guests.find(x => x.id === g)!, room).map(([a, b]) => [+(a - T).toFixed(2), +(b - T).toFixed(2)]);
  /** The day each room was last given its daily clean, once the hour is played. */
  const cleanedBy13 = (s: HotelState, rooms: Room[]) => {
    const st = tickSimulation(s, new PRNG(17)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** The edits that bring her nothing new: a paused edit, a maintenance hire, a room built off her way (at (7, 0)). */
  const edits = (s: HotelState, t: number) => ({
    paused: replanStaff(s, t),
    hire: settleChanges(s, hireCandidate(s, 'maintenance', hiringCandidates(s, 'maintenance')[0].id, undefined, t)!, t),
    built: settleChanges(s, addRoom(s, 'standard', 7, 0, 0, 'down')!, t),
  });
  const clock = (dt: number) => `12:${(dt * 60).toFixed(1).padStart(4, '0')}`;
  /** Her plan and her colleague's after an edit at t, against the hour's: exactly as they were. */
  const expectAsPlanned = (re: HotelState, s: HotelState, T: number, t: number, R2: Room, R6: Room, at: string) => {
    expect(samePlan(re, s, 'hk', t), at).toBe(true);
    expect(samePlan(re, s, 'mate', t), at).toBe(true);
    // no stand in the hallway (or anywhere else) to be at R2's door as its party goes out
    expect(staysOf(re, 'hk').filter(l => l.end > t && l.activity === 'wait').map(l => `${l.at.gridX},${l.at.gridY} ${(l.start - T).toFixed(3)}-${(l.end - T).toFixed(3)}`), at).toEqual([]);
    // home at 12:12.6, resting there (spare time) till 12:21.6, the set-off planned
    const rest = restsOf(re, 'hk').find(l => l.end > t)!;
    expect(rest, at).toMatchObject({ idle: true, at: BASE });
    expect(rest.start - T, at).toBeCloseTo(0.21, 9);
    expect(rest.end - T, at).toBeCloseTo(0.36, 9);
    // R2 at 12:36 at her rested rate, then R6 as planned
    const [onR2, onR6] = jobsOf(re, 'hk').filter(l => l.end > t);
    expect([onR2?.placeId, onR6?.placeId], at).toEqual([R2.id, R6.id]);
    expect(onR2.start - T, at).toBeCloseTo(0.6, 9);
    expect(onR2.workRate, at).toBeCloseTo(1.5, 9);
    expect(onR6.start - T, at).toBeCloseTo(0.6 + 0.1 / 1.5 + 7 * STEP, 9);
    expect(cleanedBy13(re, [R2, R6]), at).toEqual([3, 3]);
  };

  describe('On her way home to rest for her do-not-disturb room, just past the tired mark and still able to time it from where she is at her tired rate: an edit with nothing new leaves her plan as it was', () => {
    it('as planned: she walks home to the base by 12:12.6, rests there till 12:21.6, cleans R2 at her rested rate as its party is out, then R6, and both rooms are cleaned', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, R2, R6 } = scene();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, 'g2', R2, T)).toEqual([[0.38, 0.7]]);
        expect(away(s, 'g6', R6, T)).toEqual([[0.42, 1.34]]);
        const [home] = restsOf(s, 'hk');
        expect(home).toMatchObject({ idle: true, at: BASE });
        expect(home.start - T).toBeCloseTo(0.21, 9);
        expect(home.end - T).toBeCloseTo(0.36, 9);
        const [onR2, onR6] = jobsOf(s, 'hk');
        expect([onR2?.placeId, onR6?.placeId]).toEqual([R2.id, R6.id]);
        expect(onR2.start - T).toBeCloseTo(0.6, 9);
        expect(onR2.workRate).toBeCloseTo(1.5, 9); // rested: a speedy veteran's full rate
        expect(onR6.start - T).toBeCloseTo(0.6 + 0.1 / 1.5 + 7 * STEP, 9);
        expect(onR6.workRate).toBeCloseTo(1.5 * STAFF_FATIGUE.tiredRate, 9);
        expect(staysOf(s, 'hk').filter(l => l.activity === 'wait')).toEqual([]);
        expect(staysOf(s, 'mate').map(l => [l.activity, l.idle, l.at, l.start - T, l.end - T])).toEqual([['rest', true, BASE, 0, 1]]);
        // R2's clean and the steps in and out fit its party's time out from her planned arrival at the door (12:34.2) at
        // her rested rate, not at her tired one; from home she'd be at the door only once they're out (12:25.2, not
        // 12:22.8); from (6, 4), where she is at 12:03.6, she could still be there as they go out and clean it tired
        expect(0.57 + STEP + 0.1 / 1.5 + STEP).toBeLessThan(0.7017);
        expect(0.57 + STEP + 0.1 / (1.5 * STAFF_FATIGUE.tiredRate) + STEP).toBeGreaterThan(0.7017);
        expect(0.21 + 7 * STEP).toBeGreaterThan(0.38);
        expect(0.06 + 2 * STEP).toBeLessThan(0.38);
        expect(0.38 + STEP + 0.1 / (1.5 * STAFF_FATIGUE.tiredRate) + STEP).toBeLessThan(0.7017);
        // under 60 at her first tile (12:01.8), 60 or more from 12:02 on her way home (60.5 when home), back under the
        // mark by her set-off at 12:21.6 and still at it as she cleans R2, tired again by R6
        expect(energyAt(s, T + 0.03)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.035)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.21)).toBeGreaterThan(STAFF_FATIGUE.tiredAt + 0.5);
        expect(energyAt(s, T + 0.36)).toBeLessThan(STAFF_FATIGUE.tiredAt - 0.5);
        expect(energyAt(s, T + 0.6)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, onR6.start)).toBeGreaterThan(STAFF_FATIGUE.tiredAt);
        expect(cleanedBy13(s, [R2, R6])).toEqual([3, 3]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: a paused edit, a maintenance hire or a room built off her way at 12:02.1-12:03, her energy 60 or more on her step to (6, 4): she still walks home, rests at the base till 12:21.6 and cleans R2 at her rested rate, then R6 -- she doesn't stand in the hallway till 12:19.2 to be at R2's door as its party goes out`, () => withDesk(desk, () => {
        const { s, T, R2, R6 } = scene();
        for (const dt of [0.035, 0.04, 0.045, 0.05]) {
          const t = T + dt;
          expect(energyAt(s, t)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
          for (const [kind, re] of Object.entries(edits(s, t))) expectAsPlanned(re, s, T, t, R2, R6, `${kind} at ${clock(dt)}`);
        }
      }));
    }

    it('control: the same edits at 12:00.6 and 12:01.2, her energy still under 60 when she next steps onto a tile, leave her plan as it was too', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, R2, R6 } = scene();
        expect(energyAt(s, T + 0.03)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        for (const dt of [0.01, 0.02]) {
          const t = T + dt;
          for (const [kind, re] of Object.entries(edits(s, t))) expectAsPlanned(re, s, T, t, R2, R6, `${kind} at ${clock(dt)}`);
        }
      });
    });
  });
}

// A build that sends her own room's party a shorter way, so they're out too short for her clean when she'd get there: the set-off planned still stands, she rests at home, and is judged as she is when she gets there -- not standing in the hallway to meet them (mutation check).
{
  // Resting at home for her own do-not-disturb room (or on her way there), a build sends its party a shorter way out and back -- their way was planned round a room since demolished -- so they're out of the room for less time than the plan being replaced had them, and her clean no longer fits it from the set-off planned (mutation check): the set-off planned stands -- when she gets there she's judged as she is -- and she rests at home till it rather than stand in the hallway; whether she's to reach the room only next hour, or would be past the tired mark by the set-off planned though she's under it now.
  const PACE = TRAVEL.guestHoursPerTile;
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };
  const KINDS = {
    fast: { experience: 'veteran', style: 'speedy', stamina: 'high', workHours: 500 },
    mid: { experience: 'skilled', style: 'standard', stamina: 'normal', workHours: 100 },
  } as const;

  /** A housekeeper (a turnover runner) of the given kind standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, serial: number, kind: keyof typeof KINDS, at: TilePos, abs: number, fatigue: number): StaffMember {
    const p = KINDS[kind];
    return { id, serial, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: p.stamina, specialty: 'turnover_runner' },
      stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`, by the ways there are in `s`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game settles an edit: front desk staff off (Settle re-plans once), or a named front desk (twice after a build). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: `rooms` built, then the do-not-disturb parties (`parties`: room, walks out at, back at, daily
   * cleaning hours) planned their way out and back, then the room at `gone` demolished -- their ways are still round
   * it -- then the staff `roster` and the hour's plan.
   */
  function hotel(rooms: [number, number][], entrances: [number, number][], gone: [number, number], roster: (abs: number) => StaffMember[], parties: [Room['id'], number, number, number][]) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (const [x, y] of rooms) s = addRoom(s, 'standard', x, y, 0, 'up')!;
    for (const [x, y] of entrances) s = addFixture(s, 'entrance', x, y, 0)!;
    const abs = 2 * 24 + 12;
    const staff = roster(abs);
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: staff.length, maintenanceWorkers: 0 }, staffRoster: staff };
    s = syncStaff(s);
    const T = hourStart(s);
    s = { ...s, guests: parties.map(([id, leave, back], i) => goingOut(s, s.rooms.find(r => r.id === id)!, T + leave, T + back, `g${i}`)),
      rooms: s.rooms.map(r => {
        const i = parties.findIndex(([id]) => id === r.id);
        return i < 0 ? r : { ...r, status: 'occupied' as const, guestId: `g${i}`, dailyCleanHoursRemaining: parties[i][3] };
      }) };
    s = demolishRoom(s, s.rooms.find(r => r.gridX === gone[0] && r.gridY === gone[1])!.id)!;
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, rooms: parties.map(([id]) => s.rooms.find(r => r.id === id)!) };
  }
  /** A room built at (x, y) at t, as the game does it. */
  const built = (s: HotelState, x: number, y: number, door: 'up' | 'down', t: number) => settleChanges(s, addRoom(s, 'standard', x, y, 0, door)!, t);

  const itineraryOf = (s: HotelState, id: string) => getStaffPlan(s).itineraries.find(it => it.staffId === id)!;
  const legsOf = (s: HotelState, id: string): Leg[] => itineraryOf(s, id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const waitsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'wait' && l.end - l.start > 1e-6);
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  const walksOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is WalkLeg => l.kind === 'walk');
  const tile = (p: TilePos) => `${p.gridX},${p.gridY}`;
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  /**
   * What someone does from t on: each stop (activity, spot, times, a stay split in two taken as one) and, for each run of
   * walks, where it takes her and when she's there -- the tiles a walk passes through can differ between ways of the same
   * length, and a re-plan can split a walk or a stay where it was under way.
   */
  const stopsFrom = (s: HotelState, id: string, t: number) => {
    const T = hourStart(s), legs = legsOf(s, id).filter(l => l.end > t + 1e-9), out: { key: string; start: number | null; end: number }[] = [];
    legs.forEach((l, i) => {
      if (l.kind === 'walk') {
        if (legs[i + 1]?.kind !== 'walk') out.push({ key: `walk to ${tile(l.path.at(-1)!)}`, start: null, end: l.end });
        return;
      }
      const key = `${l.activity}${l.idle ? ' (spare)' : ''}${l.job ? ` ${l.placeId}` : ''} at ${tile(l.at)}`, last = out.at(-1);
      if (last && last.key === key && Math.abs(last.end - l.start) < 1e-9) last.end = l.end;
      else out.push({ key, start: Math.max(l.start, t), end: l.end });
    });
    return out.map(o => (o.start === null ? `${o.key}, there at ${(o.end - T).toFixed(6)}` : `${o.key} ${(o.start - T).toFixed(6)}-${(o.end - T).toFixed(6)}`));
  };
  /** The waits she stands after t: where, and when (hours from 12:00). */
  const standsAfter = (s: HotelState, id: string, t: number, T: number) => waitsOf(s, id).filter(l => l.end > t + 1e-9).map(l => `${tile(l.at)} ${(Math.max(l.start, t) - T).toFixed(3)}-${(l.end - T).toFixed(3)}`);
  const energyAt = (s: HotelState, id: string, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === id)!, x);
  const away = (s: HotelState, room: Room, T: number) =>
    awayStretches(s.guests.find(g => g.id === room.guestId)!, room).map(([a, b]) => [+(a - T).toFixed(4), +(b - T).toFixed(4)]);
  const tripOf = (s: HotelState, room: Room) => s.guests.find(g => g.id === room.guestId)!.trip!;
  /** The day each room was last given its daily clean, once two hours are played (some cleans run past 13:00). */
  const cleanedBy14 = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  const clock = (dt: number) => `${12 + Math.floor(dt + 1e-9)}:${(((dt % 1) + 1) % 1 * 60).toFixed(1).padStart(4, '0')}`;

  // ---- 1. Her room reached from home only next hour, as planned: the set-off planned stands

  /**
   * Eight standard rooms on row 2 (x 1..8, doors up onto row 1), an entrance at (0, 1), a room at (0, 3) closing the
   * short way from the base up to row 1 (the base is 18 tiles from R's door, round by (9, 2)), and S at (3, 5), its
   * door up onto (3, 4), two tiles from the base. R (2, 2): its party walks out at 12:54.3, out of the room 12:57.9-
   * 13:30.8, 0.1 h of daily cleaning; they planned their way out and back while a room stood at (1, 1), so they go round
   * by row 0 (five steps each way, not three by (1, 1)). S: out 12:54-13:50.4, 0.05 h. c (fast, high stamina, 59.92 at
   * 12:00, first on the roster) at (5, 0): she walks home the long way by 12:28.8, rests at the base (spare time) till
   * 12:50.4 -- S's set-off from there, though S is a's -- and walks the 18 tiles to R's door, there at 13:22.8, next
   * hour. a (fast, at 30) rests at the base for S and cleans it.
   */
  const nextHour = () => hotel([1, 2, 3, 4, 5, 6, 7, 8].map(x => [x, 2] as [number, number]).concat([[0, 3], [3, 5], [1, 1]]), [[0, 1]], [1, 1],
    abs => [keeper('c', 1, 'fast', { gridX: 5, gridY: 0, floor: 0 }, abs, 59.92), keeper('a', 2, 'fast', BASE, abs, 30)],
    [['room-0-2-2', 0.965 - PACE, 1.574, 0.1], ['room-0-3-5', 0.9 - PACE, 1.9, 0.05]]);

  describe('Resting at home for her do-not-disturb room, reached from home only next hour, a build sends its party a shorter way, out of the room too short for her clean from 13:22.8: the set-off planned stands, and she rests at home till it -- not 18-47 minutes in the hallway to be at its door as they go out', () => {
    it('as planned: c home by 12:28.8, resting at the base till 12:50.4, at R\'s door at 13:22.8; a cleans S; R\'s party goes round by row 0; a room at (1, 0) sends them the short way by (1, 1), out of the room only till 13:16.4', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, rooms: [R, S] } = nextHour();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R, T)).toEqual([[0.965, 1.514]]);
        expect(away(s, S, T)).toEqual([[0.9, 1.84]]);
        expect((tripOf(s, R)[0] as WalkLeg).path.map(tile)).toEqual(['2,2', '2,1', '2,0', '1,0', '0,0', '0,1']);
        const [home, toR] = walksOf(s, 'c');
        expect(home.end - T).toBeCloseTo(0.48, 9);
        const [rest] = restsOf(s, 'c');
        expect(rest).toMatchObject({ idle: true, at: BASE });
        expect([rest.start - T, rest.end - T].map(x => +x.toFixed(6))).toEqual([0.48, 0.84]);
        expect(toR.path.length - 1).toBe(18);
        expect(toR.end - T).toBeCloseTo(1.38, 9);
        expect(itineraryOf(s, 'c').end.roomId).toBe(R.id);
        expect(jobsOf(s, 'a').map(l => l.placeId)).toEqual([S.id]);
        expect(cleanedBy14(s, [R, S])).toEqual([3, 3]);
        // from home she'd have to leave at 12:25.5 to be at R's door as its party goes out: before she's home
        expect(0.965 - 18 * STEP).toBeLessThan(0.48);
        // the room at (1, 0): R's party goes by (1, 1) and is back in sooner, out of the room only till 13:16.4 -- from
        // 13:22.8 there's no time for R's clean, at any rate of hers
        const re = built(s, 1, 0, 'down', T + 0.1);
        expect(away(re, R, T)).toEqual([[0.965, 1.274]]);
        expect(1.38 + 0.1 / staffRate(s.staffRoster![0]) + 2 * STEP).toBeGreaterThan(1.274);
      });
    });

    it('control: a paused edit at 12:01.2-12:18 leaves both plans as they were', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T } = nextHour();
        for (const dt of [0.02, 0.1, 0.3]) for (const id of ['c', 'a']) expect(stopsFrom(replanStaff(s, T + dt), id, T + dt), `${id} at ${clock(dt)}`).toEqual(stopsFrom(s, id, T + dt));
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: the room at (1, 0) built at 12:01.2-12:18: c walks on home and rests at the base to the hour's end, through the set-off planned, with no stand in the hallway; R, which she's given up, is a's, and both rooms are cleaned`, () => withDesk(desk, () => {
        const { s, T, rooms: [R, S] } = nextHour();
        for (const dt of [0.02, 0.05, 0.1, 0.2, 0.3]) {
          const t = T + dt, at = `built at ${clock(dt)}`;
          const re = built(s, 1, 0, 'down', t);
          expect(away(re, R, T), at).toEqual([[0.965, 1.274]]);
          // no stand anywhere: she walks on home, there by 12:28.8 as planned
          expect(standsAfter(re, 'c', t, T), at).toEqual([]);
          const rest = restsOf(re, 'c').find(l => l.end > t + 1e-9)!;
          expect(rest, at).toMatchObject({ idle: true, at: BASE });
          expect(rest.start - T, at).toBeCloseTo(0.48, 9);
          // resting at the base through the set-off planned (12:50.4) and on to the hour's end
          for (let x = 0.49; x < 1; x += 0.02) expect(where(re, 'c', T + x), `${at}, ${clock(x)}`).toBe('1.000,4.000,0 rest/');
          expect(jobsOf(re, 'c').filter(l => l.end > t + 1e-9), at).toEqual([]);
          // R is new work for a, who sets off for it from the base at 12:25.5; both rooms are cleaned
          expect(jobsOf(re, 'a').map(l => l.placeId), at).toContain(R.id);
          expect(cleanedBy14(re, [R, S]), at).toEqual([3, 3]);
        }
      }));
    }
  });

  // ---- 2. Under the tired mark now, past it by the set-off planned: the set-off planned stands

  /**
   * The starter hall (its entrance at (0, 4)) with an entrance at (9, 4) and R at (7, 5), its door up onto (7, 4), six
   * tiles from the base. R: its party walks out at 12:26.4, out of the room 12:30-13:07.2, 0.3 h of daily cleaning; they
   * planned their way out and back while a room stood at (8, 4), so they go round by (8, 3) (five steps each way, not
   * three by (8, 4)). hk (skilled, normal stamina, 59.8 at 12:00) at (5, 0): she walks home by 12:14.4 (60 from 12:02.4,
   * 61 when home), rests at the base (spare time) till 12:19.2, R's set-off from there, still over 60, and cleans R
   * 12:31.8-12:53 at her tired rate.
   */
  const tiredBySetOff = () => hotel([[7, 5], [8, 4]], [[9, 4]], [8, 4], abs => [keeper('hk', 1, 'mid', { gridX: 5, gridY: 0, floor: 0 }, abs, 59.8)],
    [['room-0-7-5', 0.5 - PACE, 1.18, 0.3]]);

  describe('On her way home to rest for her do-not-disturb room, under 60 now but over it by the set-off planned, a build sends its party a shorter way, out of the room too short for her clean at her tired rate: the set-off planned stands -- she walks on home and rests there, and is judged as she is when she gets to it -- not 19 minutes in the hallway to be turned down just the same', () => {
    it('as planned: home by 12:14.4, resting at the base till 12:19.2 and cleaning R at her tired rate from 12:31.8; a room at (8, 3) sends R\'s party the short way by (8, 4), out of the room 12:30-12:52.8: long enough for R\'s clean at her rate now, not at her tired one', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, rooms: [R] } = tiredBySetOff();
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, R, T)).toEqual([[0.5, 1.12]]);
        expect((tripOf(s, R)[0] as WalkLeg).path.map(tile)).toEqual(['7,5', '7,4', '7,3', '8,3', '9,3', '9,4']);
        const [home] = walksOf(s, 'hk');
        expect(home.end - T).toBeCloseTo(0.24, 9);
        const [rest] = restsOf(s, 'hk');
        expect(rest).toMatchObject({ idle: true, at: BASE });
        expect([rest.start - T, rest.end - T].map(x => +x.toFixed(6))).toEqual([0.24, 0.32]);
        const [onR] = jobsOf(s, 'hk');
        expect(onR.placeId).toBe(R.id);
        expect(onR.start - T).toBeCloseTo(0.53, 9);
        expect(onR.workRate).toBeCloseTo(STAFF_FATIGUE.tiredRate, 9);
        expect(cleanedBy14(s, [R])).toEqual([3]);
        // under 60 as her first step ends (12:01.8), 60 from 12:02.4, 61 when home, still over 60 at the set-off
        expect(energyAt(s, 'hk', T + 0.03)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, 'hk', T + 0.24)).toBeCloseTo(61, 9);
        expect(energyAt(s, 'hk', T + 0.32)).toBeGreaterThan(STAFF_FATIGUE.tiredAt);
        expect(findRoute(s, BASE, { gridX: 7, gridY: 4, floor: 0 })!.path.length - 1).toBe(6);
        // the room at (8, 3): out of the room till 12:52.8 -- R's clean and the steps in and out take 21.6 minutes at her
        // rate now, 24.8 at her tired one, from 12:30
        const re = built(s, 8, 3, 'up', T + 0.02);
        expect(away(re, R, T)).toEqual([[0.5, 0.88]]);
        const rate = staffRate(s.staffRoster![0]);
        expect(0.5 + 0.3 / rate + 2 * STEP).toBeLessThanOrEqual(0.88 + 1e-9);
        expect(0.5 + 0.3 / (rate * STAFF_FATIGUE.tiredRate) + 2 * STEP).toBeGreaterThan(0.88);
      });
    });

    it('control: a paused edit at 12:00.6-12:01.8 leaves her plan as it was', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T } = tiredBySetOff();
        for (const dt of [0.01, 0.02, 0.03]) expect(stopsFrom(replanStaff(s, T + dt), 'hk', T + dt), clock(dt)).toEqual(stopsFrom(s, 'hk', T + dt));
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: the room at (8, 3) built at 12:00.6-12:01.8, her energy under 60: she walks on home, rests at the base from 12:14.4 to the hour's end -- too tired for R at the set-off planned -- with no stand in the hallway`, () => withDesk(desk, () => {
        const { s, T, rooms: [R] } = tiredBySetOff();
        for (const dt of [0.01, 0.02, 0.03]) {
          const t = T + dt, at = `built at ${clock(dt)}`;
          expect(energyAt(s, 'hk', T + 0.03), at).toBeLessThan(STAFF_FATIGUE.tiredAt);
          const re = built(s, 8, 3, 'up', t);
          expect(away(re, R, T), at).toEqual([[0.5, 0.88]]);
          // no stand anywhere: she walks on home, there by 12:14.4 as planned
          expect(standsAfter(re, 'hk', t, T), at).toEqual([]);
          expect(tile(walksOf(re, 'hk').filter(l => l.end > t + 1e-9).at(-1)!.path.at(-1)!), at).toBe(tile(BASE));
          const rest = restsOf(re, 'hk').find(l => l.end > t + 1e-9)!;
          expect(rest, at).toMatchObject({ idle: true, at: BASE });
          expect(rest.start - T, at).toBeCloseTo(0.24, 9);
          // resting at the base through the set-off planned (12:19.2) and on to the hour's end: over 60 then, she's too
          // tired for R in the time its party is out
          for (let x = 0.25; x < 1; x += 0.02) expect(where(re, 'hk', T + x), `${at}, ${clock(x)}`).toBe('1.000,4.000,0 rest/');
          expect(energyAt(re, 'hk', T + 0.32), at).toBeGreaterThan(STAFF_FATIGUE.tiredAt);
          expect(jobsOf(re, 'hk').filter(l => l.end > t + 1e-9), at).toEqual([]);
        }
      }));
    }
  });
}

// The game's own re-plan at the hour's start (after the front desk's queue is reseated) leaves a housekeeper walking home into the hour for her do-not-disturb room the hour's plan: she rests at the base for it and cleans it, not sent off sooner for another party's room that fits only because she's not yet tired.
{
  const PACE = TRAVEL.guestHoursPerTile;
  /** A housekeeper's walk along a hallway tile. */
  const STEP = TRAVEL.hoursPerTile;
  const BASE = { gridX: 1, gridY: 4, floor: 0 };

  /** A slow housekeeper (a meticulous rookie, high stamina, turnover runner) standing at `at`, at `fatigue` at `abs`. */
  function keeper(id: string, at: TilePos, abs: number, fatigue: number): StaffMember {
    return { id, serial: 7, name: id, role: 'housekeeper', dailyWage: 70, at,
      profile: { experience: 'rookie', style: 'meticulous', reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
      stats: { workHours: 0, lateDays: 0, absentDays: 0, fatigue, fatigueAt: abs } } as StaffMember;
  }

  /** A do-not-disturb guest in `room` walking out to the street at `leave`, back at `back`. */
  function goingOut(s: HotelState, room: Room, leave: number, back: number, id: string): Guest {
    const tile = roomTile(room);
    const out = routeToStreet(s, tile, PACE)!, inn = routeFromStreet(s, tile, PACE)!;
    const walkOut = makeWalk(out.path, leave, PACE);
    const walkBack = makeWalk(inn.path, back - makeWalk(inn.path, 0, PACE).end, PACE);
    return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' },
      tripKind: 'outing', trip: [walkOut, makeStay(out.path.at(-1)!, walkOut.end, walkBack.start, 'away'), walkBack] } as Guest;
  }

  /** The two ways the game runs its front desk: front desk staff off, or a named front desk (clerks on the desk's lanes). */
  const DESKS = ['off', 'named'] as const;
  type Desk = (typeof DESKS)[number];
  function withDesk<T>(desk: Desk, f: () => T): T {
    const was = FRONT_DESK_STAFF.enabled;
    FRONT_DESK_STAFF.enabled = desk === 'named';
    try { return f(); } finally { FRONT_DESK_STAFF.enabled = was; }
  }

  /**
   * 12:00 on day 3: four standard rooms on row 5 from x = 3, their doors up onto the base's row 4. A (6, 5): a
   * do-not-disturb party out of the room 12:40.8-12:58.8, 0.15h of daily cleaning; B (3, 5): one out 12:49.8-13:07.8,
   * 0.1h. hk (slow, the only housekeeper) carries her walk home into the hour: from (8, 1) at 11:51, ten tiles to the
   * base by 12:09, at (4, 2) at 12:00. Walking she tires 3 an hour, so from `energy` 59.6 at 12:00 she's still under 60
   * on her next step and just over it (60.05) when home at 12:09. The hour's plan judges her there, tired: A doesn't fit
   * her tired rate, so she rests at the base till 12:46.2 and cleans B. At 59.5 (59.95 at 12:09) she isn't tired when
   * home, and the hour's plan sets her off at 12:31.8 for A instead: A fits her rested rate.
   * With `walkIn`, a guest walks in at 11:58.8 to check in, quoted for 12:06 on a lane at the desk that's free when she
   * reaches it at 12:02.4: reseating the desk queue at 12:00 moves her up, so the state changes and the game re-plans
   * the staff at the hour's start.
   */
  function scene(energy: number, walkIn = false) {
    let s: HotelState = { ...createStarterHotel(), cash: 10_000_000, peakStarRating: 5, starRating: 3 };
    for (let i = 0; i < 4; i++) s = addRoom(s, 'standard', 3 + i, 5, 0, 'up')!;
    const abs = 2 * 24 + 12;
    const home = findRoute(s, { gridX: 8, gridY: 1, floor: 0 }, BASE, STEP)!;
    const carry = makeWalk(home.path, abs - 0.15, STEP); // 11:51 -> 12:09
    s = { ...s, day: 3, hour: 12, guests: [], noiseSources: [], staffPlan: null, staff: { ...s.staff, housekeepers: 1, maintenanceWorkers: 0 },
      staffRoster: [keeper('hk', BASE, abs, energy)] };
    s = syncStaff(s);
    // the hour before ended with her on her way home: bound for the base, the walk carried into this hour
    s = { ...s, staffRoster: s.staffRoster!.map(m => (m.id === 'hk' ? { ...m, at: BASE, carry } : m)) };
    const T = hourStart(s);
    const A = s.rooms.find(r => r.gridX === 6 && r.gridY === 5)!, B = s.rooms.find(r => r.gridX === 3 && r.gridY === 5)!;
    s = { ...s, guests: [goingOut(s, A, T + 0.62, T + 1.04, 'ga'), goingOut(s, B, T + 0.77, T + 1.19, 'gb')],
      rooms: s.rooms.map(r => (r.id === A.id ? { ...r, status: 'occupied' as const, guestId: 'ga', dailyCleanHoursRemaining: 0.15 }
        : r.id === B.id ? { ...r, status: 'occupied' as const, guestId: 'gb', dailyCleanHoursRemaining: 0.1 } : r)) };
    if (walkIn) {
      const desk = s.fixtures.find(f => f.type === 'desk')!;
      const lane = lanesOf({ ...s, staffPlan: planStaff(s) }).find(l => l.desk.id === desk.id)!;
      const inWalk = makeWalk([{ gridX: 0, gridY: 4, floor: 0 }, lane.front], T - 0.02, 0.06);
      const walker = { id: 'gc', name: 'gc', budget: 1000, stayLength: 2, trait: 'normal', satisfaction: 55, checkInDay: 3, isReturning: false, hadNoiseComplaint: false,
        profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'standard' },
        tripKind: 'arrival', trip: [inWalk, makeStay(lane.front, inWalk.end, T + 0.1, 'wait', { placeId: desk.id, lane: lane.key }),
          makeStay(lane.front, T + 0.1, T + 0.15, 'check_in', { placeId: desk.id, lane: lane.key })] } as unknown as Guest;
      s = { ...s, guests: [...s.guests, walker] };
    }
    return { s: { ...s, staffPlan: getStaffPlan(s) }, T, A, B };
  }

  const legsOf = (s: HotelState, id: string): Leg[] => getStaffPlan(s).itineraries.find(it => it.staffId === id)?.legs ?? [];
  const restsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  const jobsOf = (s: HotelState, id: string) => legsOf(s, id).filter((l): l is StayLeg => l.kind === 'stay' && !!l.job);
  /** Where someone is at x and doing what. */
  const where = (s: HotelState, id: string, x: number) => {
    const p = positionAt(legsOf(s, id), x)!;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.floor} ${p.leg.kind === 'stay' ? `${p.leg.activity}/${p.leg.placeId ?? ''}` : 'walk'}`;
  };
  const samePlan = (a: HotelState, b: HotelState, id: string, t: number) => {
    for (let x = t + 0.001; x < hourStart(a) + 1; x += 0.005) if (where(a, id, x) !== where(b, id, x)) return `${(x - hourStart(a)).toFixed(3)}: ${where(a, id, x)} vs ${where(b, id, x)}`;
    return true;
  };
  const energyAt = (s: HotelState, x: number) => fatigueAt(s, s.staffRoster!.find(m => m.id === 'hk')!, x);
  const away = (s: HotelState, g: string, room: Room, T: number) =>
    awayStretches(s.guests.find(x => x.id === g)!, room).map(([a, b]) => [+(a - T).toFixed(3), +(b - T).toFixed(3)]);
  /** The day each room was last given its daily clean, once two hours are played (B's clean runs a little past 13:00). */
  const cleanedBy14 = (s: HotelState, rooms: Room[]) => {
    let st = s;
    for (let h = 0; h < 2; h++) st = tickSimulation(st, new PRNG(31 + h)).state;
    return rooms.map(r => st.rooms.find(x => x.id === r.id)!.lastDailyCleanDay ?? 0);
  };
  /** Her plan from 12:00, against the hour's: resting at the base 12:09-12:46.2 for B, cleaning B, A left alone. */
  const expectRestsForB = (re: HotelState, hour: HotelState, T: number, A: Room, B: Room, at: string) => {
    // nothing new: her plan for the hour is the one she had
    expect(samePlan(re, hour, 'hk', T), at).toBe(true);
    // home at 12:09 and resting at the base till 12:46.2, not off at 12:31.8 for A
    const rest = restsOf(re, 'hk').find(l => l.end > T + 1e-9)!;
    expect(rest, at).toMatchObject({ idle: true, at: BASE });
    expect(rest.start, at).toBeCloseTo(T + 0.15, 9);
    expect(rest.end, at).toBeCloseTo(T + 0.77, 9);
    // at 12:36 she's still resting at the base, not on her way to A's door
    expect(where(re, 'hk', T + 0.6), at).toMatch(/^1\.000,4\.000,0 rest/);
    expect(jobsOf(re, 'hk').map(l => l.placeId), at).toEqual([B.id]);
    expect(jobsOf(re, 'hk')[0].start, at).toBeCloseTo(T + 0.86, 9);
    // B is cleaned, A isn't
    expect(cleanedBy14(re, [A, B]), at).toEqual([0, 3]);
  };

  describe('Walking home into the hour to rest for her do-not-disturb room, under 60 at 12:00 and over it once home: the game\'s own re-plan at the hour\'s start leaves her plan as it was', () => {
    it('as planned: home to the base by 12:09, just over 60 there, she rests at the base till 12:46.2 and cleans B as its party goes out; A, which doesn\'t fit her tired rate, isn\'t cleaned', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B } = scene(59.6);
        expect(namedFrontDesk(s)).toBe(desk === 'named');
        expect(away(s, 'ga', A, T)).toEqual([[0.68, 0.98]]);
        expect(away(s, 'gb', B, T)).toEqual([[0.83, 1.13]]);
        // the walk home she carried into the hour: 11:51 to 12:09, at (4, 2) at 12:00
        const [walk] = legsOf(s, 'hk');
        expect(walk.kind).toBe('walk');
        expect([walk.start - T, walk.end - T].map(x => +x.toFixed(6))).toEqual([-0.15, 0.15]);
        expect(where(s, 'hk', T)).toBe('4.000,2.000,0 walk');
        // under 60 at 12:00 and on the step after, just over it when home at 12:09
        expect(energyAt(s, T)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + STEP)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        expect(energyAt(s, T + 0.15)).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
        const [home] = restsOf(s, 'hk');
        expect(home).toMatchObject({ idle: true, at: BASE });
        expect(home.start).toBeCloseTo(T + 0.15, 9);
        expect(home.end).toBeCloseTo(T + 0.77, 9);
        // two tiles to B's door by 12:49.8 as its party goes out, then in and cleaning from 12:51.6
        expect(home.end + 2 * STEP).toBeCloseTo(T + 0.83, 9);
        expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([B.id]);
        expect(jobsOf(s, 'hk')[0].start).toBeCloseTo(T + 0.86, 9);
        expect(cleanedBy14(s, [A, B])).toEqual([0, 3]);
      });
    });

    it('control: at 59.5 she isn\'t tired when home, and the hour\'s plan sets her off at 12:31.8 for A and cleans it (A fits her rested rate); the re-plan at 12:00 keeps that too', () => {
      for (const desk of DESKS) withDesk(desk, () => {
        const { s, T, A, B } = scene(59.5);
        expect(energyAt(s, T + 0.15)).toBeLessThan(STAFF_FATIGUE.tiredAt);
        const [home] = restsOf(s, 'hk');
        expect(home).toMatchObject({ idle: true, at: BASE });
        expect(home.end).toBeCloseTo(T + 0.53, 9);
        expect(jobsOf(s, 'hk').map(l => l.placeId)).toEqual([A.id]);
        expect(cleanedBy14(s, [A, B])).toEqual([3, 0]);
        const re = replanStaff(s, T);
        expect(samePlan(re, s, 'hk', T)).toBe(true);
        expect(jobsOf(re, 'hk').map(l => l.placeId)).toEqual([A.id]);
        expect(cleanedBy14(re, [A, B])).toEqual([3, 0]);
      });
    });

    for (const desk of DESKS) {
      it(`desk ${desk}: re-planned right at 12:00, under 60 then and on the step she's on: she still rests at the base till 12:46.2 and cleans B, not off at 12:31.8 for A`, () => withDesk(desk, () => {
        for (const energy of [59.6, 59.7, 59.8]) {
          const { s, T, A, B } = scene(energy);
          const at = `at ${energy}`;
          expect(energyAt(s, T + STEP), at).toBeLessThan(STAFF_FATIGUE.tiredAt);
          expect(energyAt(s, T + 0.15), at).toBeGreaterThanOrEqual(STAFF_FATIGUE.tiredAt);
          expectRestsForB(replanStaff(s, T), s, T, A, B, at);
        }
      }));

      it(`desk ${desk}: through the game's own hour-start re-plan (the hour planned, the desk queue reseated by a guest walking in, the staff re-planned at 12:00): she still rests at the base till 12:46.2 and cleans B`, () => withDesk(desk, () => {
        const { s, T, A, B } = scene(59.6, true);
        // as tick.ts ends the hour's start
        const planned = { ...s, staffPlan: planStaff(s) };
        const seated = reseatLanes(planned, T);
        expect(seated).not.toBe(planned);
        expect(STAFF_SPECIALTIES.enabled).toBe(true);
        const re = seated !== planned && STAFF_SPECIALTIES.enabled ? replanStaff(seated, T) : seated;
        // the guest walking in is moved up: she checks in sooner than quoted
        const checkIn = (st: HotelState) => st.guests.find(g => g.id === 'gc')!.trip!.find(l => l.kind === 'stay' && l.activity === 'check_in')!;
        expect(checkIn(seated).start).toBeLessThan(checkIn(planned).start - 1e-9);
        // the hour's plan for her is the one without the guest walking in
        expect(samePlan(planned, scene(59.6).s, 'hk', T)).toBe(true);
        expectRestsForB(re, planned, T, A, B, `desk ${desk}`);
      }));
    }
  });
}
