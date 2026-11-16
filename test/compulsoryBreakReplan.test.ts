// A compulsory break keeps its fixed end through mid-hour re-plans, and spare time gives way to work at the counter
// (docs/designs/guest-staff-personalities.md, "Stamina, fatigue and break rooms implementation"); see also idleRestReplan.test.ts.
// (docs/designs/guest-staff-personalities.md, "Stamina, fatigue and break rooms implementation").
import { afterEach, describe, expect, it } from 'vitest';
import { addFixture, addRoom, createStarterHotel, demolishFixture } from '../src/simulation/HotelState.js';
import { getStaffPlan, planStaff, replanStaff } from '../src/simulation/StaffManager.js';
import { hourStart, makeStay, makeWalk, positionAt } from '../src/simulation/Movement.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { dismissStaff } from '../src/simulation/StaffHiring.js';
import { physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { fatigueAt } from '../src/simulation/StaffFatigue.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { routeFromStreet, routeToStreet } from '../src/simulation/Layout.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { STAFF_FATIGUE } from '../src/config/staff.js';
import { TRAVEL } from '../src/config/balance.js';
import type { Guest, GuestProfile, HotelState, Leg, Room, SpotlightPlan, StaffMember, StayLeg, TilePos } from '../src/simulation/types.js';

afterEach(() => { STAFF_FATIGUE.enabled = true; });

const SPEEDS = {
  slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
  mid: { experience: 'skilled', style: 'standard', workHours: 100 },
  fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
} as const;

/** A housekeeper at `at` (in a room, on its turnover with `keeps`), with `fatigue` and `stamina` (high by default). */
function keeper(id: string, speed: keyof typeof SPEEDS, at: Room | TilePos, abs: number, o: { keeps?: boolean; fatigue?: number; stamina?: 'low' | 'normal' | 'high'; receptionTrained?: boolean } = {}): StaffMember {
  const p = SPEEDS[speed];
  const room = 'id' in at ? at as Room : undefined;
  return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: room ? roomTile(room) : at as TilePos, ...(o.keeps && room ? { roomId: room.id } : {}),
    profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: o.stamina ?? 'high', specialty: 'turnover_runner',
      ...(o.receptionTrained ? { receptionTrained: true, hospitality: 'polite' } : {}) },
    stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: o.fatigue ?? 0, fatigueAt: abs } } as StaffMember;
}

/** The starter hotel on day 2 at `hour`: break rooms on row 0, `rooms` standard rooms on row 2 from x = 3 (`dirty`: turnover hours by index); planned. */
function hotel(o: { hour?: number; breakRooms?: Array<[number, number]>; rooms: number; dirty?: Record<number, number>; crew: (rooms: Room[], abs: number) => StaffMember[] }): HotelState {
  const hour = o.hour ?? 12;
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
  for (const [x, y] of o.breakRooms ?? []) s = addFixture(s, 'breakroom', x, y, 0)!;
  for (let i = 0; i < o.rooms; i++) s = addRoom(s, 'standard', 3 + i, 2, 0, 'up')!;
  const crew = o.crew(s.rooms, 24 + hour);
  s = { ...s, day: 2, hour, guests: [], noiseSources: [], staffPlan: null,
    rooms: s.rooms.map((r, i) => (o.dirty?.[i] !== undefined ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: o.dirty[i], cleaningHoursTotal: o.dirty[i] } : r)),
    staff: { ...s.staff, housekeepers: crew.filter(m => m.role === 'housekeeper').length, maintenanceWorkers: 0 }, staffRoster: crew };
  return { ...s, staffPlan: getStaffPlan(s) };
}

/** Late-shift clerks at every lane (the first at `fatigue`); planned. */
function withLateClerks(s: HotelState, fatigue = 0): HotelState {
  const people = physicalDeskLanes(s).map((lane, index) => ({
    id: index === 0 ? 'clerk-a' : `clerk-b`, serial: 100 + index, name: `Clerk ${index}`, role: 'front_desk', shift: 'late', at: lane.front, deskLane: lane.key, dailyWage: 40,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite' },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: index === 0 ? fatigue : 0, fatigueAt: hourStart(s) },
  } as StaffMember));
  const next = { ...s, frontDeskRosterReady: true, staffPlan: null, staffRoster: [...(s.staffRoster ?? []).filter(m => m.role !== 'front_desk'), ...people], staff: { ...s.staff, frontDesk: people.length } };
  return { ...next, staffPlan: getStaffPlan(next) };
}

const isRest = (l: Leg): l is StayLeg => l.kind === 'stay' && l.activity === 'rest';
const itinerary = (s: HotelState, id: string) => getStaffPlan(s).itineraries.find(it => it.staffId === id)!;
/** Room work (and counter time) planned for someone from t on. */
const workFrom = (s: HotelState, id: string, t: number) => itinerary(s, id).legs.filter((l): l is StayLeg => l.kind === 'stay' && l.end > t + 1e-9 && (!!l.job || l.activity === 'desk'));
/** A room needing `hours` of turnover from t: a paused edit that brings new work. */
const dirtied = (s: HotelState, index: number, hours: number, t: number) => settleChanges(s,
  { ...s, rooms: s.rooms.map((r, i) => (i === index ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: hours, cleaningHoursTotal: hours } : r)) }, t);
/** The latest end of the rests someone begins before `by`. */
const restUntil = (s: HotelState, id: string, by: number) => Math.max(...itinerary(s, id).legs.filter(isRest).filter(l => l.start < by - 1e-9).map(l => l.end));

describe('Spare time at the counter', () => {
  it('a reception-trained housekeeper resting idle covers the lane a mid-hour let-go frees', () => {
    const base = hotel({ breakRooms: [[5, 0]], rooms: 4, dirty: { 0: 3 }, hour: 15,
      crew: (r, abs) => [keeper('busy', 'mid', r[0], abs, { keeps: true, fatigue: 10, stamina: 'normal' }),
        keeper('rt', 'mid', { gridX: 5, gridY: 1, floor: 0 }, abs, { fatigue: 30, stamina: 'normal', receptionTrained: true })] });
    const s0 = withLateClerks(base);
    const t = hourStart(s0) + 0.3;
    expect(workFrom(s0, 'rt', t)).toEqual([]);
    const s1 = settleChanges(s0, dismissStaff(s0, 'clerk-b', t)!, t);
    expect(workFrom(s1, 'rt', t)).toEqual([expect.objectContaining({ activity: 'desk' })]);
  });
});

describe('A compulsory break keeps its fixed end through mid-hour re-plans', () => {
  it('begun this hour: three paused edits that bring new work leave its end alone, and work resumes right after it', () => {
    // 84.5, normal stamina: 85 within minutes, a half-hour break inside the hour
    const s0 = hotel({ breakRooms: [[5, 0]], rooms: 5, dirty: { 0: 3 },
      crew: (r, abs) => [keeper('tired', 'mid', r[0], abs, { keeps: true, fatigue: 84.5, stamina: 'normal' })] });
    const brk = itinerary(s0, 'tired').legs.find(isRest)!;
    expect(brk.end - brk.start).toBeCloseTo(STAFF_FATIGUE.breakHours);
    expect(brk.end).toBeLessThan(hourStart(s0) + 1);
    let s = s0;
    for (const [index, dt] of [[1, 0.05], [2, 0.15], [3, 0.25]]) {
      const t = brk.start + dt;
      s = dirtied(s, index, 0.3, t);
      expect(restUntil(s, 'tired', brk.end)).toBeCloseTo(brk.end, 9);
      const work = workFrom(s, 'tired', t);
      expect(work.length).toBeGreaterThan(0);
      expect(work.every(l => l.start >= brk.end - 1e-9)).toBe(true);
      expect(work[0].start).toBeLessThan(brk.end + 0.1); // straight back to work from the break, not later in the hour
    }
    // (by the last edit she's below 80: no fatigue threshold tells this from idle recovery)
    expect(fatigueAt(s, s.staffRoster![0], brk.start + 0.25)).toBeLessThan(80);
    const t = brk.end + 0.02;
    const after = workFrom(dirtied(s, 4, 0.3, t), 'tired', t);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].start).toBeLessThan(t + 0.1);
  });

  it('a break, then idle recovery in the same seat: work found waits for the break\'s end, not the hour\'s', () => {
    // At 86 with nothing to do: the half-hour break at once, then idle recovery in the same seat to the hour's end
    const s0 = hotel({ breakRooms: [[5, 0]], rooms: 4, dirty: { 0: 3 },
      crew: (r, abs) => [keeper('busy', 'mid', r[0], abs, { keeps: true, fatigue: 10, stamina: 'normal' }), keeper('tired', 'mid', { gridX: 5, gridY: 1, floor: 0 }, abs, { fatigue: 86, stamina: 'normal' })] });
    const T = hourStart(s0);
    const [brk, idle] = itinerary(s0, 'tired').legs.filter(isRest);
    expect(idle).toMatchObject({ at: brk.at, placeId: brk.placeId, start: brk.end, end: T + 1 });
    const during = dirtied(s0, 1, 0.3, brk.start + 0.2);
    expect(workFrom(during, 'tired', brk.start + 0.2)[0].start).toBeGreaterThan(brk.end);
    // Two paused edits in the break first: the split legs make no difference
    const split = replanStaff(replanStaff(s0, brk.start + 0.2), brk.start + 0.4);
    for (const state of [s0, split]) {
      const t = brk.end + 0.1;
      const work = workFrom(dirtied(state, 1, 0.3, t), 'tired', t);
      expect(work.map(l => l.placeId)).toEqual([s0.rooms[1].id]);
      expect(work[0].start).toBeLessThan(t + 0.15);
    }
  });

  it('its break room demolished mid-break: the rest finished elsewhere keeps the end through a later edit with new work', () => {
    const s0 = hotel({ breakRooms: [[5, 0]], rooms: 5, dirty: { 0: 3 },
      crew: (r, abs) => [keeper('tired', 'mid', r[0], abs, { keeps: true, fatigue: 84.5, stamina: 'normal' })] });
    const brk = itinerary(s0, 'tired').legs.find(isRest)!;
    const s1 = settleChanges(s0, demolishFixture(s0, brk.placeId!)!, brk.start + 0.1);
    const elsewhere = itinerary(s1, 'tired').legs.filter(isRest).at(-1)!;
    expect(elsewhere).toMatchObject({ restRate: STAFF_FATIGUE.fallbackRecovery, end: brk.end });
    const t = elsewhere.start + 0.05;
    const s2 = dirtied(s1, 1, 0.3, t);
    expect(restUntil(s2, 'tired', brk.end)).toBeCloseTo(brk.end, 9);
    expect(workFrom(s2, 'tired', t).every(l => l.start >= brk.end - 1e-9)).toBe(true);
  });

  it('a clerk\'s break across the hour, edited mid-break: the rest of it is still taken next hour', () => {
    const base = hotel({ breakRooms: [[5, 0]], rooms: 4, dirty: { 0: 3 }, hour: 15,
      crew: (r, abs) => [keeper('busy', 'mid', r[0], abs, { keeps: true, fatigue: 10, stamina: 'normal' })] });
    const s0 = withLateClerks(base, 83);
    const T = hourStart(s0);
    const fixed = itinerary(s0, 'clerk-a').end.fatigueBreak!;
    expect(fixed.end).toBeGreaterThan(T + 1);
    for (const t of [fixed.start - 0.01, fixed.start + 0.05]) {
      const edited = replanStaff(s0, t);
      expect(itinerary(edited, 'clerk-a').end.fatigueBreak).toMatchObject({ start: fixed.start, end: fixed.end });
      const next = tickSimulation(edited, new PRNG(9)).state;
      expect(next.staffRoster!.find(m => m.id === 'clerk-a')!.fatigueBreak).toMatchObject({ end: fixed.end });
      expect(itinerary(next, 'clerk-a').legs[0]).toMatchObject({ activity: 'rest', end: fixed.end });
    }
  });
});
