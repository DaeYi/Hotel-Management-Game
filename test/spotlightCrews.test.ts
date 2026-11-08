// The suite held for a spotlight guest, with crews built by hand: whether its turnover jumps the queue and for whom
// (planStaff, Spotlight.rushFor), the estimate's shift arithmetic (Spotlight.readyAt), and what the card and the story
// say while they'd wait for it. (The rest of the held suite is in spotlight.test.ts.)
import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, formatRoomLabel, refitRoom } from '../src/simulation/HotelState.js';
import { readyAt, holdFor, holdSuite, releaseHold, planSpotlight, rushedSuite } from '../src/simulation/Spotlight.js';
import { getStaffPlan, getRoster, replanStaff } from '../src/simulation/StaffManager.js';
import { baseWalkHours } from '../src/simulation/HousekeepingManager.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { hourStart } from '../src/simulation/Movement.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { dismissStaff } from '../src/simulation/StaffHiring.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { furnishingOf } from '../src/simulation/RoomProfile.js';
import { STAFF_FATIGUE } from '../src/config/staff.js';
import { ECONOMY } from '../src/config/balance.js';
import type { Guest, HotelState, Room, SpotlightPlan, StaffMember } from '../src/simulation/types.js';

/** A writer due on day 10 at 15:00, announced. */
const plan = (extra: Partial<SpotlightPlan> = {}): SpotlightPlan => ({
  kind: 'writer', week: 1, salt: '', announceDay: 9, arrivalDay: 10, arrivalHour: 15, status: 'announced', chainId: 'spotlight-10', ...extra,
});

const SPEEDS = {
  slow: { experience: 'rookie', style: 'meticulous', workHours: 0 },
  mid: { experience: 'skilled', style: 'standard', workHours: 100 },
  fast: { experience: 'veteran', style: 'speedy', workHours: 500 },
} as const;

/** A housekeeper standing in `at` (in it, on its turnover, with `keeps`): a slow rookie, a skilled one or a fast veteran. */
function keeper(id: string, speed: keyof typeof SPEEDS, at: Room, abs: number, keeps = false): StaffMember {
  const p = SPEEDS[speed];
  return { id, serial: id.length, name: id, role: 'housekeeper', dailyWage: 70, at: roomTile(at), ...(keeps ? { roomId: at.id } : {}),
    profile: { experience: p.experience, style: p.style, reliability: 'dependable', stamina: 'high', specialty: 'turnover_runner' },
    stats: { workHours: p.workHours, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: abs } } as StaffMember;
}

/**
 * The starter hotel at 3 stars on `day` at `hour`: the suites on row 2 from x = 3, then standard rooms; `dirty`: turnover
 * hours left by room index; `crew`: the housekeepers in the roster's order (none: the starter's unnamed ones).
 */
function build(o: { day: number; hour: number; suites: number; standards: number; dirty: Record<number, number>; crew?: (rooms: Room[], abs: number) => StaffMember[] }) {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
  for (let x = 0; x < o.suites; x++) s = addRoom(s, 'suite', x + 3, 2, 0, 'up')!;
  for (let x = 0; x < o.standards; x++) s = addRoom(s, 'standard', x + 3 + o.suites, 2, 0, 'up')!;
  const abs = (o.day - 1) * 24 + o.hour;
  const crew = o.crew?.(s.rooms, abs);
  s = { ...s, day: o.day, hour: o.hour, guests: [], noiseSources: [], staffPlan: null,
    rooms: s.rooms.map((r, i) => (o.dirty[i] !== undefined ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: o.dirty[i] } : r)) };
  return crew ? { ...s, staff: { ...s.staff, housekeepers: crew.length }, staffRoster: [...crew, ...(s.staffRoster ?? []).filter(m => m.role !== 'housekeeper')] } : s;
}

/** The desk's clerks at their lanes, early shift; the first (helper) trained to help with turnovers if `trained`. */
function withClerks(s: HotelState, trained = true): HotelState {
  const people = physicalDeskLanes(s).map((lane, index) => ({
    id: index === 0 ? 'helper' : `cover-${index}`, serial: 100 + index, name: index === 0 ? 'Avery Park' : `Robin Lee ${index}`,
    role: 'front_desk', shift: 'early', at: lane.front, deskLane: lane.key, dailyWage: 40,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', ...(index === 0 && trained ? { cleaningTrained: true } : {}) },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: hourStart(s) },
  } as StaffMember));
  return { ...s, frontDeskRosterReady: true, staffRoster: [...(s.staffRoster ?? []).filter(m => m.role === 'housekeeper'), ...people], staff: { ...s.staff, frontDesk: people.length } };
}

/** Who works a room's turnover in this hour's plan (a housekeeper, or a clerk helping). */
const workersIn = (s: HotelState, roomId: string) =>
  getStaffPlan(s).itineraries.filter(it => it.legs.some(l => l.kind === 'stay' && (l.job === 'turnover' || l.activity === 'clean') && l.placeId === roomId)).map(it => it.staffId);

/** Ticks till the spotlight guest checks in (or `hours`): the room, the hour after the tick they did, the hour the suite came free, who worked it. */
function tickTillIn(start: HotelState, suiteId: string, hours = 16) {
  let st = start;
  let into: string | undefined;
  let at: number | undefined;
  let vacantAt: number | undefined;
  const by = new Set<string>();
  for (let h = 0; h < hours && !into; h++) {
    for (const it of getStaffPlan(st).itineraries) if (it.legs.some(l => l.kind === 'stay' && l.job === 'turnover' && l.placeId === suiteId)) by.add(it.staffId);
    const r = tickSimulation(st, new PRNG(7 + h));
    st = r.state;
    if (vacantAt === undefined && st.rooms.find(x => x.id === suiteId)!.status !== 'cleaning') vacantAt = st.hour;
    const e = r.events.find(x => x.type === 'spotlight_arrived');
    if (e) { into = e.data?.roomId as string | undefined; at = st.hour; }
  }
  return { into, at, vacantAt, by: [...by], state: st };
}

function withFatigue<T>(on: boolean, fn: () => T): T {
  const was = STAFF_FATIGUE.enabled;
  STAFF_FATIGUE.enabled = on;
  try { return fn(); } finally { STAFF_FATIGUE.enabled = was; }
}

const roomName = (r: Room) => `Room ${formatRoomLabel(r.gridX, r.gridY, r.floor)}`;

/** A guest in since day 8 for `stay` nights, leaving at `checkoutHour` (a night owl: wanting a late checkout). */
const leaver = (id: string, checkoutHour: number, night = false, stay = 2): Guest => ({
  id, name: id, budget: 1000, stayLength: stay, trait: 'normal', satisfaction: 55, checkInDay: 8, isReturning: false, hadNoiseComplaint: false,
  profile: { chronotype: night ? 'night' : 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour, favorite: 'none' },
} as Guest);

/** With no guests arriving (bookings). */
function quiet<T>(fn: () => T): T {
  const a = ECONOMY.baseArrivalsPerDay;
  const b = ECONOMY.arrivalsPerSqrtRoom;
  ECONOMY.baseArrivalsPerDay = 0;
  ECONOMY.arrivalsPerSqrtRoom = 0;
  try { return fn(); } finally { ECONOMY.baseArrivalsPerDay = a; ECONOMY.arrivalsPerSqrtRoom = b; }
}

/** Ticks `hours` from `start`: the spotlight story's lines said in each. */
function storyByTick(start: HotelState, hours: number): { said: string[][]; state: HotelState } {
  let st = start;
  const said: string[][] = [];
  for (let h = 0; h < hours; h++) {
    const next = tickSimulation(st, new PRNG(3 + h)).state;
    said.push(spoken(st, next));
    st = next;
  }
  return { said, state: st };
}
/** The spotlight story's lines said since `before`. */
const spoken = (before: HotelState, after: HotelState) => after.storyLog.filter(e => e.chainId === 'spotlight-10' && !before.storyLog.some(b => b.id === e.id)).map(e => e.message);

describe('Spotlight guests: the held suite\'s turnover, crews by hand', () => {
  it('rushed only if the plan made with it gets the suite ready sooner: done within the hour either way, it waits its turn (the other room isn\'t held back)', () => {
    // 14:00 on their day (due 14:00), one skilled housekeeper: X 0.1h then S 0.3h, both done by 15:00. S first would be
    // done sooner within the hour, but they check in on the hour all the same
    const s = build({ day: 9, hour: 14, suites: 1, standards: 2, dirty: { 0: 0.3, 1: 0.1 }, crew: (r, abs) => [keeper('hk', 'mid', r[2], abs)] });
    const [S, X] = s.rooms;
    const held = { ...s, spotlight: plan({ arrivalDay: 9, arrivalHour: 14, roomId: S.id }) };
    expect(getStaffPlan(held).rush).toBeUndefined();
    const legs = getStaffPlan(held).itineraries[0].legs.filter(l => l.kind === 'stay' && l.job === 'turnover');
    expect(legs.map(l => (l.kind === 'stay' ? l.placeId : ''))).toEqual([X.id, S.id]);
    // S 0.45h, X 0.35h: X done at 14:26, S at 14:59 in its turn; rushed, X would run past 15:00: not rushed, both free
    const close = { ...held, rooms: held.rooms.map(r => (r.id === S.id ? { ...r, cleaningHoursRemaining: 0.45 } : r.id === X.id ? { ...r, cleaningHoursRemaining: 0.35 } : r)) };
    expect(getStaffPlan(close).rush).toBeUndefined();
    const after = tickSimulation(close, new PRNG(11)).state;
    expect(after.rooms.find(r => r.id === X.id)!.status).toBe('vacant');
    expect(after.rooms.find(r => r.id === S.id)!.guestId).toBe(after.guests.find(g => g.spotlight)?.id);
    // ... S 0.8h (in its turn past 15:00; first, within the hour): rushed
    const longer = { ...held, rooms: held.rooms.map(r => (r.id === S.id ? { ...r, cleaningHoursRemaining: 0.8 } : r)) };
    expect(getStaffPlan(longer).rush).toEqual({ roomId: S.id, staffId: 'hk' });
  });

  it('kept for whoever would finish it first counting every shift: neither finishes it tonight, the fast one does tomorrow (not the slow one who stops first, at 21:00)', () => {
    // 19:00, due tomorrow at 09:00: S 4h, Y 4h; the slow one free (first in the roster), the fast one finishing X (0.5h)
    const s = build({ day: 9, hour: 19, suites: 1, standards: 3, dirty: { 0: 4, 1: 0.5, 2: 4 },
      crew: (r, abs) => [keeper('hk-slow', 'slow', r[3], abs), keeper('hk-fast', 'fast', r[1], abs, true)] });
    const S = s.rooms[0];
    const held = { ...s, spotlight: plan({ arrivalDay: 10, arrivalHour: 9, roomId: S.id }) };
    expect(getStaffPlan(held).rush).toEqual({ roomId: S.id, staffId: 'hk-fast' });
    expect(tickTillIn(held, S.id, 15)).toMatchObject({ vacantAt: 9, by: ['hk-fast'] });
    // ... with no tiredness (the plain shift arithmetic), the same
    expect(withFatigue(false, () => getStaffPlan(held).rush)).toEqual({ roomId: S.id, staffId: 'hk-fast' });
  });

  it('a clerk helping with turnovers leaves the suite kept for a housekeeper alone (as do the other housekeepers)', () => {
    // 11:00 on day 2 (the clerks' cleaning hours), due 15:00: the fast one busy in X all hour (2h), the slow one free;
    // S 3h. Kept for the fast one: nobody is in it this hour, clerk or housekeeper
    const s = withClerks(build({ day: 2, hour: 11, suites: 1, standards: 2, dirty: { 0: 3, 1: 2 },
      crew: (r, abs) => [keeper('hk-fast', 'fast', r[1], abs, true), keeper('hk-slow', 'slow', r[2], abs)] }));
    const S = s.rooms[0];
    const held = { ...s, spotlight: plan({ announceDay: 2, arrivalDay: 2, arrivalHour: 15, roomId: S.id }) };
    expect(getStaffPlan(held).rush).toEqual({ roomId: S.id, staffId: 'hk-fast' });
    expect(workersIn(held, S.id)).toEqual([]);
    expect(workersIn({ ...s, spotlight: undefined }, S.id)).toEqual(['hk-slow']); // (no hold: the slow one takes it)
  });

  it('the rush is judged from where the hour\'s plan leaves things: late from the hour\'s start alone, in time as planned, it waits its turn', () => {
    // 11:00 on day 9: S (3.3h) and X (0.5h), one housekeeper standing in Z next door; due 15:00. From the hour's start
    // with base walks (X, then S) it would be late; the hour's plan has her through X and in S before 12:00 (short
    // walks next door): in time in its turn, X free at noon
    const s = build({ day: 9, hour: 11, suites: 1, standards: 2, dirty: { 0: 3.3, 1: 0.5 }, crew: (r, abs) => [keeper('hk', 'mid', r[2], abs)] });
    const [S, X] = s.rooms;
    const w = baseWalkHours(s);
    expect(11 + w + 0.5 + w + 3.3).toBeGreaterThan(15);
    const held = { ...s, spotlight: plan({ arrivalDay: 9, arrivalHour: 15, roomId: S.id }) };
    expect(getStaffPlan(held).rush).toBeUndefined();
    expect(tickSimulation(held, new PRNG(7)).state.rooms.find(r => r.id === X.id)!.status).toBe('vacant');
    expect(tickTillIn(held, S.id)).toMatchObject({ into: S.id, at: 15, by: ['hk'] });
    // ... due at 14:00 it would be late even so: rushed, for her
    expect(getStaffPlan({ ...held, spotlight: { ...held.spotlight!, arrivalHour: 14 } }).rush).toEqual({ roomId: S.id, staffId: 'hk' });
    // A clerk helping this hour: from the hour's start alone (X, then S) late, but the plan has the clerk on S and the
    // housekeeper on X: in time in its turn
    const c = withClerks(build({ day: 2, hour: 11, suites: 1, standards: 2, dirty: { 0: 3, 1: 1 }, crew: (r, abs) => [keeper('hk', 'mid', r[2], abs)] }));
    expect(11 + w + 1 + w + 3).toBeGreaterThan(15);
    const helped = { ...c, spotlight: plan({ announceDay: 2, arrivalDay: 2, arrivalHour: 15, roomId: c.rooms[0].id }) };
    expect(getStaffPlan(helped).rush).toBeUndefined();
    expect(workersIn(helped, c.rooms[0].id)).toEqual(['helper']);
    expect(tickTillIn(helped, c.rooms[0].id).at).toBe(15);
  });

  it('the housekeeper it\'s kept for let go in the hour: decided again among those still working, not shut away for the rest of the hour; the hold let go, no rush', () => {
    // 12:00, due 15:00: the fast one and a skilled one free, the slow one in X (2h left); S 3h, Y and Z 1h each
    const s0 = withClerks(build({ day: 9, hour: 12, suites: 1, standards: 4, dirty: { 0: 3, 1: 2, 2: 1, 3: 1 },
      crew: (r, abs) => [keeper('hk-fast', 'fast', r[4], abs), keeper('hk-mid', 'mid', r[4], abs), keeper('hk-slow', 'slow', r[1], abs, true)] }), false);
    const S = s0.rooms[0];
    const held = { ...s0, spotlight: plan({ arrivalDay: 9, arrivalHour: 15, roomId: S.id }) };
    const s = { ...held, staffPlan: getStaffPlan(held) };
    expect(s.staffPlan.rush).toEqual({ roomId: S.id, staffId: 'hk-fast' });
    const t = hourStart(s);
    const re = settleChanges(s, dismissStaff(s, 'hk-fast', t)!, t);
    expect(re.staffPlan!.rush).toEqual({ roomId: S.id, staffId: 'hk-mid' });
    expect(rushedSuite(re)).toBe(S.id);
    expect(workersIn(re, S.id)).toEqual(['hk-mid']);
    expect(tickTillIn(re, S.id)).toMatchObject({ into: S.id, at: 16 });
    // (planned afresh without her: the same)
    const afresh = { ...re, staffPlan: null };
    expect(getStaffPlan(afresh).rush).toEqual({ roomId: S.id, staffId: 'hk-mid' });
    // The hold let go in the hour: a replan has no rush
    const gone = replanStaff(releaseHold(s)!, t + 0.25);
    expect(gone.staffPlan!.rush).toBeUndefined();
  });

  it('the housekeeper it\'s kept for let go in the hour, a slow one first on the roster: not handed to her (two hours later than not rushing at all)', () => {
    // 12:00, due 15:00: the fast one and a slow one free, a skilled one in X (0.2h left, she keeps at it); S 3.5h, Y 1h
    const s0 = build({ day: 9, hour: 12, suites: 1, standards: 3, dirty: { 0: 3.5, 1: 0.2, 2: 1 },
      crew: (r, abs) => [keeper('hk-fast', 'fast', r[3], abs), keeper('hk-slow', 'slow', r[3], abs), keeper('hk-mid', 'mid', r[1], abs, true)] });
    const S = s0.rooms[0];
    const held = { ...s0, spotlight: plan({ arrivalDay: 9, arrivalHour: 15, roomId: S.id }) };
    const s = { ...held, staffPlan: getStaffPlan(held) };
    expect(s.staffPlan.rush).toEqual({ roomId: S.id, staffId: 'hk-fast' });
    const t = hourStart(s);
    const re = settleChanges(s, dismissStaff(s, 'hk-fast', t)!, t);
    expect(workersIn(re, S.id)).not.toContain('hk-slow');
    expect(tickTillIn(re, S.id)).toMatchObject({ into: S.id, at: 16 });
  });
});

describe('Spotlight guests: the estimate across the night', () => {
  it('a turnover stopped at 21:00 waits for the morning: a housekeeper free that evening doesn\'t pick it up (as the planner has it)', () => {
    // 19:00 (judged from 20:00), two housekeepers: the first takes X (0.5h) then the suite (3h), a few minutes in before
    // 21:00; the second, planning after her, finds both taken. From 07:00 the first finishes the suite
    const base = build({ day: 9, hour: 19, suites: 1, standards: 2, dirty: { 0: 3, 1: 0.5 } });
    const [suite, x] = base.rooms;
    const s = { ...base, staff: { ...base.staff, housekeepers: 2 }, spotlight: plan({ arrivalDay: 10, arrivalHour: 10 }) };
    const w = baseWalkHours(s);
    const tonight = 21 - (20 + w + 0.5 + w);
    expect(tonight).toBeGreaterThan(0);
    expect(readyAt(s, s.rooms[0], s.spotlight!)).toBeCloseTo(9 * 24 + 7 + w + (3 - tonight), 6);
    const cleans = getStaffPlan({ ...s, hour: 20, spotlight: undefined }).itineraries.filter(it => getRoster(s).some(m => m.id === it.staffId && m.role === 'housekeeper'))
      .map(it => it.legs.filter(l => l.kind === 'stay' && l.job === 'turnover').map(l => (l.kind === 'stay' ? l.placeId : '')).filter((id, i, all) => all.indexOf(id) === i));
    expect(cleans).toEqual([[x.id, suite.id], []]);
  });

  it('a walk that runs past 21:00 stops there: in the morning the suite is handed out afresh, one whole walk (not the rest of the evening\'s, then another)', () => {
    // 19:00 (judged from 20:00): the one housekeeper in X with 0.9h left (done 20:54), then the held suite (3h); due
    // tomorrow at 15:00 (in time: not rushed)
    const s0 = build({ day: 9, hour: 19, suites: 1, standards: 2, dirty: { 0: 3, 1: 0.9 }, crew: (r, abs) => [keeper('hk', 'mid', r[1], abs, true)] });
    const S = s0.rooms[0];
    const s = { ...s0, spotlight: plan({ arrivalDay: 10, arrivalHour: 15, roomId: S.id }) };
    expect(rushedSuite(s)).toBeUndefined();
    const w = baseWalkHours(s);
    expect(20.9 + w).toBeGreaterThan(21);
    expect(readyAt(s, S, s.spotlight!)).toBeCloseTo(9 * 24 + 7 + w + 3, 6);
  });
});

describe('Spotlight guests: what the card and the story say while they\'d wait', () => {
  it('another suite between hours is judged as the next hour\'s plan will have it: after a hold by hand, behind the held one if that\'ll be rushed', () => {
    // 09:00, due 15:00, one housekeeper in X (1h left); A 3h, B 2h, Y1 and Y2 1.5h; the hour planned with no hold. A
    // held by hand: in its turn (after Y1, Y2 and B) it'd be late, so the next hour rushes it, and B waits behind it
    const s0 = { ...build({ day: 9, hour: 9, suites: 2, standards: 3, dirty: { 0: 3, 1: 2, 2: 1, 3: 1.5, 4: 1.5 }, crew: (r, abs) => [keeper('hk', 'mid', r[2], abs, true)] }), spotlightHold: 'none' as const };
    const [A] = s0.rooms;
    const p = plan({ arrivalDay: 9, arrivalHour: 15 });
    const none = { ...s0, spotlight: p };
    const planned = { ...none, staffPlan: getStaffPlan(none) };
    expect(planned.staffPlan.rush).toBeUndefined();
    const hand = holdSuite(planned, A.id)!;
    const w = baseWalkHours(hand);
    const behind = 8 * 24 + 10 + 4 * w + 3 + 1.5 + 1.5 + 2;
    expect(readyAt(hand, hand.rooms[1], p, true)).toBeCloseTo(behind, 6);
    const atHour = { ...hand, staffPlan: getStaffPlan({ ...hand, staffPlan: null }) };
    expect(atHour.staffPlan!.rush).toEqual({ roomId: A.id, staffId: 'hk' });
    expect(readyAt(atHour, atHour.rooms[1], p, true)).toBeCloseTo(behind, 6);
    // (the hour's rush is A's: B held by hand instead, nothing held now is rushed this hour)
    expect(rushedSuite(atHour)).toBe(A.id);
    expect(rushedSuite(holdSuite(atHour, atHour.rooms[1].id)!)).toBeUndefined();
  });

  it('a suite held by hand that will be rushed: no suite promised that the rush will hold back (the card offered, and held)', () => {
    // 09:00, due 15:00, hold policy none, one housekeeper in X (1h left); A 6h, B 2h, as good. Held, A would be rushed
    // at 10:00 and B (in its turn by 13:00 now) not ready till evening: no rival on A's card
    const s0 = { ...build({ day: 9, hour: 9, suites: 2, standards: 1, dirty: { 0: 6, 1: 2, 2: 1 }, crew: (r, abs) => [keeper('hk', 'mid', r[2], abs, true)] }), spotlightHold: 'none' as const };
    const [A, B] = s0.rooms;
    const s1 = { ...s0, rooms: s0.rooms.map(r => ({ ...r, decor: 60 })), spotlight: plan({ arrivalDay: 9, arrivalHour: 15 }) };
    const s = { ...s1, staffPlan: getStaffPlan(s1) };
    expect(s.staffPlan.rush).toBeUndefined();
    const offered = holdFor(s, s.rooms[0])!;
    expect(offered).toMatchObject({ held: false, readyBy: '17:00' });
    expect(offered.rival).toBeUndefined();
    const hand = holdSuite(s, A.id)!;
    expect(holdFor(hand, hand.rooms[0])).toMatchObject({ held: true, readyBy: '17:00' });
    expect(holdFor(hand, hand.rooms[0])!.rival).toBeUndefined();
    // ... and so it goes: rushed at 10:00, B still being cleaned at their hour, they wait for A
    let st = tickSimulation(hand, new PRNG(3)).state;
    expect(getStaffPlan(st).rush).toEqual({ roomId: A.id, staffId: 'hk' });
    for (let h = 0; h < 5; h++) st = tickSimulation(st, new PRNG(4 + h)).state;
    expect(st.hour).toBe(15);
    expect(st.rooms.find(r => r.id === B.id)!.status).toBe('cleaning');
  });

  it('held, ready only after their hour, with one as good coming free sooner (after their hour too): the card and the story name it and its hour, and they take it', () => {
    // 12:00, due 15:00, two housekeepers: A 6h held by hand, B 4h, as good: B free by about 17:00, A by about 19:00
    const s0 = build({ day: 9, hour: 12, suites: 2, standards: 0, dirty: { 0: 6, 1: 4 } });
    const [A, B] = s0.rooms;
    const s = { ...s0, staff: { ...s0.staff, housekeepers: 2 }, spotlightHold: 'none' as const, rooms: s0.rooms.map(r => ({ ...r, decor: 60 })), spotlight: plan({ arrivalDay: 9, arrivalHour: 15 }) };
    const hand = holdSuite({ ...s, staffPlan: getStaffPlan(s) }, A.id)!;
    const card = holdFor(hand, hand.rooms[0])!;
    expect(card).toMatchObject({ held: true, readyBy: '19:00', rival: roomName(B), rivalBy: '17:00' });
    // (the story, in the tick, as the card has it)
    const told = tickSimulation(hand, new PRNG(5)).state;
    expect(spoken(hand, told)).toEqual([`${roomName(A)}, held for the travel writer, won't be ready when they come. It'll be ready by about 19:00: they'll take ${roomName(B)} (free by about 17:00) if it's still free, else wait for it.`]);
    const out = tickTillIn(hand, A.id);
    expect(out.into).toBe(B.id);
    expect(out.at).toBeLessThanOrEqual(18);
    // One as good free only in the same hour as the held one: they'd take the held one then (no rival)
    const same = holdSuite({ ...s, staffPlan: null, rooms: s.rooms.map(r => (r.id === B.id ? { ...r, cleaningHoursRemaining: 5.9 } : r)) }, A.id)!;
    const sameCard = holdFor(same, same.rooms[0])!;
    expect(Math.ceil(readyAt(same, same.rooms[1], same.spotlight!, true) - 1e-9)).toBe(Math.ceil(readyAt(same, same.rooms[0], same.spotlight!, true) - 1e-9));
    expect(sameCard).toMatchObject({ held: true, readyBy: '19:00' });
    expect(sameCard.rival).toBeUndefined();
    // Not held by hand, two as good: the one ready sooner is held (they wait for it)
    const picked = planSpotlight({ ...s, spotlightHold: 'hold' }).state;
    expect(picked.spotlight!.roomId).toBe(B.id);
  });

  it('held by hand with one as good free now: the story says they\'d take that; held after they\'ve come, it says they\'re waiting', () => {
    // 09:00, due 15:00, one housekeeper: A 8h held by hand, B vacant and as good
    const s0 = build({ day: 9, hour: 9, suites: 2, standards: 0, dirty: { 0: 8 } });
    const [A, B] = s0.rooms;
    const s = { ...s0, staff: { ...s0.staff, housekeepers: 1 }, rooms: s0.rooms.map(r => ({ ...r, decor: 60 })), spotlight: plan({ arrivalDay: 9, arrivalHour: 15 }) };
    const hand = holdSuite(s, A.id)!;
    const card = holdFor(hand, hand.rooms[0])!;
    expect(card).toMatchObject({ held: true, readyBy: '18:00', rival: roomName(B) });
    expect(card.rivalBy).toBeUndefined(); // (free now)
    const told = tickSimulation(hand, new PRNG(5)).state;
    expect(spoken(hand, told)).toEqual([`${roomName(A)}, held for the travel writer, won't be ready when they come. It'll be ready by about 18:00: they'll take ${roomName(B)} if it's still free, else wait for it.`]);
    // 16:00, waiting since 15:00 for A: B (3h left) held by hand instead
    const late0 = build({ day: 9, hour: 16, suites: 2, standards: 0, dirty: { 0: 6, 1: 3 } });
    const late = { ...late0, staff: { ...late0.staff, housekeepers: 2 }, rooms: late0.rooms.map(r => ({ ...r, decor: 60 })), spotlight: plan({ arrivalDay: 9, arrivalHour: 15, roomId: late0.rooms[0].id, waitNoted: true }) };
    const other = holdSuite(late, late.rooms[1].id)!;
    const said = spoken(other, planSpotlight(other).state);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(new RegExp(`^${roomName(late.rooms[1])}, held for the travel writer, isn't ready yet\\. It'll be ready by about \\d\\d:00: they're waiting for it\\.$`));
  });

  it('the story says a hold has slipped only once it\'s clearly late: minutes past their hour, nothing; more than half an hour, once', () => {
    // 10:00 (judged from 11:00), due 15:00, one housekeeper, the held suite the only room to clean
    const s0 = build({ day: 9, hour: 10, suites: 1, standards: 0, dirty: { 0: 1 } });
    const s = { ...s0, staff: { ...s0.staff, housekeepers: 1 } };
    const w = baseWalkHours(s);
    const heldWith = (hours: number) => ({ ...s, rooms: s.rooms.map(r => ({ ...r, cleaningHoursRemaining: hours })), spotlight: plan({ arrivalDay: 9, arrivalHour: 15, roomId: s.rooms[0].id }) });
    const minutes = heldWith(15.25 - 11 - w);
    expect(readyAt(minutes, minutes.rooms[0], minutes.spotlight!)).toBeCloseTo(15.25 + 8 * 24, 6);
    const quiet = planSpotlight(minutes).state;
    expect(spoken(minutes, quiet)).toEqual([]);
    expect(quiet.spotlight!.waitNoted).toBeUndefined();
    const hour = heldWith(15.75 - 11 - w);
    const said = planSpotlight(hour).state;
    expect(spoken(hour, said)).toEqual([`${roomName(s.rooms[0])}, held for the travel writer, won't be ready when they come. It'll be ready by about 16:00: they'll wait for it.`]);
    expect(said.spotlight!.waitNoted).toBe(true);
  });
});

describe('Spotlight guests: when the story says they\'ll wait, and for which suite', () => {
  it('in the hour before they come, any slip is said (it\'s certain then): minutes past their hour, said then, not before', () => {
    // 12:00, due 15:00: one housekeeper already in the held suite, 3.3h left (done about 15:18)
    const s0 = build({ day: 9, hour: 12, suites: 1, standards: 0, dirty: { 0: 3.3 }, crew: (r, abs) => [keeper('hk', 'mid', r[0], abs, true)] });
    const S = s0.rooms[0];
    const { said, state } = storyByTick({ ...s0, spotlight: plan({ arrivalDay: 9, arrivalHour: 15, roomId: S.id }) }, 3);
    expect(said).toEqual([[], [], [`${roomName(S)}, held for the travel writer, won't be ready when they come. It'll be ready by about 16:00: they'll wait for it.`]]);
    expect(tickTillIn(state, S.id)).toMatchObject({ into: S.id, at: 16 });
  });

  it('a slip is said only once the held suite\'s turnover has started (while its guest\'s still in it, the estimate swings too far)', () => {
    // 08:00 on their day, due 15:00, one housekeeper: A held by hand, its guest leaving at 13:00; thorough turnovers (3h)
    const s0 = build({ day: 10, hour: 8, suites: 1, standards: 0, dirty: {}, crew: (r, abs) => [keeper('hk', 'mid', r[0], abs)] });
    const A = s0.rooms[0];
    const g = leaver('g-a', 13);
    const s = { ...s0, guests: [g], housekeeping: { ...s0.housekeeping, turnoverQuality: 'thorough' as const }, spotlight: plan(),
      rooms: s0.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: g.id })) };
    const hand = holdSuite(s, A.id)!;
    expect(holdFor(hand, hand.rooms[0])).toMatchObject({ held: true, readyBy: '17:00' }); // (clearly late, as it stands)
    const { said, state } = storyByTick(hand, 6);
    // (its guest leaves in the 12:00 tick; the turnover's under way by the next)
    expect(said).toEqual([[], [], [], [], [], [`${roomName(A)}, held for the travel writer, won't be ready when they come. It'll be ready by about 17:00: they'll wait for it.`]]);
    expect(tickTillIn(state, A.id)).toMatchObject({ into: A.id, at: 17 });
  });

  it('the announcement and a moved hold say a wait only once it\'s clearly past their hour too: minutes past, said in the hour before they come', () => {
    // 09:00, the writer announced now for 15:00 today, one housekeeper: the one suite done about 15:15 (or 15:45)
    const announced = (done: number) => {
      const t0 = build({ day: 9, hour: 9, suites: 1, standards: 0, dirty: { 0: 1 } });
      const t1 = { ...t0, staff: { ...t0.staff, housekeepers: 1 } };
      return { ...t1, rooms: t1.rooms.map(r => ({ ...r, cleaningHoursRemaining: done - 9 - baseWalkHours(t1) })), spotlight: plan({ announceDay: 9, arrivalDay: 9, arrivalHour: 15, status: 'planned' }) };
    };
    const minutes = announced(15.25);
    const S = minutes.rooms[0];
    const quietly = storyByTick(minutes, 6);
    expect(quietly.said).toEqual([[`A travel writer arrives Tuesday at about 15:00 and wants a suite. ${roomName(S)} is held for them.`], [], [], [], [],
      [`${roomName(S)}, held for the travel writer, won't be ready when they come. It'll be ready by about 16:00: they'll wait for it.`]]);
    expect(storyByTick(announced(15.75), 1).said).toEqual([[`A travel writer arrives Tuesday at about 15:00 and wants a suite. ${roomName(S)} is held for them. It'll be ready by about 16:00: they'll wait for it.`]]);
    // 09:00, due 15:00: A held by the game, its guest staying on (not free by their day): the hold moves to B
    const moved = (done: number) => {
      const t0 = build({ day: 9, hour: 9, suites: 2, standards: 0, dirty: { 1: 1 } });
      const t1 = { ...t0, staff: { ...t0.staff, housekeepers: 1 } };
      const stay = leaver('g-stay', 11, false, 5);
      return { ...t1, guests: [stay], spotlight: plan({ announceDay: 8, arrivalDay: 9, arrivalHour: 15, roomId: t1.rooms[0].id }),
        rooms: t1.rooms.map((r, i) => (i === 0 ? { ...r, decor: 60, status: 'occupied' as const, guestId: stay.id } : { ...r, decor: 60, cleaningHoursRemaining: done - 9 - baseWalkHours(t1) })) };
    };
    const later = moved(15.25);
    const B = later.rooms[1];
    const told = storyByTick(later, 6);
    expect(told.state.spotlight!.roomId).toBe(B.id);
    expect(told.said).toEqual([[`The suite held for the travel writer is now ${roomName(B)}.`], [], [], [], [],
      [`${roomName(B)}, held for the travel writer, won't be ready when they come. It'll be ready by about 16:00: they'll wait for it.`]]);
    expect(storyByTick(moved(15.75), 1).said).toEqual([[`The suite held for the travel writer is now ${roomName(B)}. It'll be ready by about 16:00: they'll wait for it.`]]);
  });

  it('a hold moved after they\'ve come: the note says they\'re waiting', () => {
    // 15:00, the writer here since 15:00: A held by the game (7h, hk-a in it: not done by 21:00), B 3h (hk-b free), as good
    const t0 = build({ day: 9, hour: 15, suites: 2, standards: 0, dirty: { 0: 7, 1: 3 },
      crew: (r, abs) => [keeper('hk-a', 'mid', r[0], abs, true), keeper('hk-b', 'mid', r[1], abs)] });
    const [A, B] = t0.rooms;
    const s = { ...t0, rooms: t0.rooms.map(r => ({ ...r, decor: 60 })), spotlight: plan({ arrivalDay: 9, arrivalHour: 15, roomId: A.id, waitNoted: true }) };
    const after = tickSimulation(s, new PRNG(3)).state;
    expect(after.spotlight!.roomId).toBe(B.id);
    expect(spoken(s, after)).toEqual([`The suite held for the travel writer is now ${roomName(B)}. It'll be ready by about 18:00: they're waiting for it.`]);
    expect(tickTillIn(after, B.id)).toMatchObject({ into: B.id, at: 18 });
  });

  it('of suites as good they\'d take instead: the one free first (not a better one free later), of two in the same hour the better, and of two free by their hour the better', () => {
    // 12:00, due 15:00, three housekeepers: A 6.5h held by hand, B 3.5h (decor 60, as A), C 4.5h (decor 70)
    const s0 = build({ day: 9, hour: 12, suites: 3, standards: 0, dirty: { 0: 6.5, 1: 3.5, 2: 4.5 } });
    const [A, B, C] = s0.rooms;
    const s = { ...s0, staff: { ...s0.staff, housekeepers: 3 }, spotlightHold: 'none' as const, rooms: s0.rooms.map(r => ({ ...r, decor: r.id === C.id ? 70 : 60 })), spotlight: plan({ arrivalDay: 9, arrivalHour: 15 }) };
    const hand = holdSuite(s, A.id)!;
    expect(holdFor(hand, hand.rooms[0])).toMatchObject({ readyBy: '19:00', rival: roomName(B), rivalBy: '16:00' });
    expect(tickTillIn(hand, A.id)).toMatchObject({ into: B.id, at: 16 });
    // ... two coming free in the same hour: the better one
    const tie = holdSuite({ ...s, rooms: s.rooms.map(r => (r.id === C.id ? { ...r, cleaningHoursRemaining: 3.5 } : r)) }, A.id)!;
    expect(holdFor(tie, tie.rooms[0])).toMatchObject({ rival: roomName(C), rivalBy: '16:00' });
    expect(tickTillIn(tie, A.id).into).toBe(C.id);
    // ... two free by their hour (one now, one by 14:00): the better one, at their hour
    const clamp = holdSuite({ ...s, rooms: s.rooms.map(r => (r.id === B.id ? { ...r, status: 'vacant' as const, cleaningHoursRemaining: 0 } : r.id === C.id ? { ...r, cleaningHoursRemaining: 1 } : { ...r, cleaningHoursRemaining: 8 })) }, A.id)!;
    const card = holdFor(clamp, clamp.rooms[0])!;
    expect(card).toMatchObject({ rival: roomName(C) });
    expect(card.rivalBy).toBeUndefined();
    expect(tickTillIn(clamp, A.id).into).toBe(C.id);
  });

  it('one as good whose guest leaves the morning they come, free by their hour, is the one they\'d take (judged by the last check-in)', () => {
    // 08:00 on their day (due 15:00), two housekeepers: A 8h held by hand; B, better (a stay wears it a little), its guest leaving at 11:00
    const s0 = build({ day: 10, hour: 8, suites: 2, standards: 0, dirty: { 0: 8 } });
    const [A, B] = s0.rooms;
    const g = leaver('g-b', 11);
    const s = { ...s0, staff: { ...s0.staff, housekeepers: 2 }, guests: [g], spotlight: plan(),
      rooms: s0.rooms.map(r => ({ ...r, decor: r.id === B.id ? 70 : 60, ...(r.id === B.id ? { status: 'occupied' as const, guestId: g.id } : {}) })) };
    const hand = holdSuite(s, A.id)!;
    const card = holdFor(hand, hand.rooms[0])!;
    expect(card).toMatchObject({ held: true, rival: roomName(B) });
    expect(card.rivalBy).toBeUndefined();
    expect(tickTillIn(hand, A.id)).toMatchObject({ into: B.id, at: 15 });
  });

  it('one as good with a refit booked is judged as the refit leaves it: closed for it once it\'s empty, if there\'s the money (a long one: they wait for the held one)', () => {
    // As 'held, ready only after their hour, with one as good coming free sooner': A 6h held by hand, B 4h (free about
    // 17:00), B with a refit booked
    const s0 = build({ day: 9, hour: 12, suites: 2, standards: 0, dirty: { 0: 6, 1: 4 } });
    const [A, B] = s0.rooms;
    const studio = furnishingOf(B);
    const flip = (x: (typeof studio.items)[number]) => ({ ...x, tier: (x.tier === 1 ? 2 : 1) as typeof x.tier });
    const swapped = { ...studio, items: studio.items.map(flip) }; // (every piece: a long refit)
    const tv = studio.items.findIndex(x => x.kind === 'tv');
    const lesser = { ...studio, items: studio.items.map((x, i) => (i === tv ? flip(x) : x)) }; // (one piece: an hour's refit)
    const held = (furnishing: typeof studio, refit: typeof studio, cash = 1_000_000) => {
      const s = { ...s0, cash, staff: { ...s0.staff, housekeepers: 2 }, spotlightHold: 'none' as const, spotlight: plan({ arrivalDay: 9, arrivalHour: 15 }),
        rooms: s0.rooms.map(r => ({ ...r, decor: 60, ...(r.id === B.id ? { furnishing, pendingRefit: refit } : {}) })) };
      return holdSuite({ ...s, staffPlan: getStaffPlan(s) }, A.id)!;
    };
    // A long refit: B's shut till after A's ready
    const long = held(studio, swapped);
    const card = holdFor(long, long.rooms[0])!;
    expect(card).toMatchObject({ held: true, readyBy: '19:00' });
    expect(card.rival).toBeUndefined();
    expect(spoken(long, tickSimulation(long, new PRNG(5)).state)).toEqual([`${roomName(A)}, held for the travel writer, won't be ready when they come. It'll be ready by about 19:00: they'll wait for it.`]);
    expect(tickTillIn(long, A.id)).toMatchObject({ into: A.id, at: 19 });
    // An hour's refit (its TV put back up a tier): B's theirs once that's done
    const short = held(lesser, studio);
    expect(holdFor(short, short.rooms[0])).toMatchObject({ readyBy: '19:00', rival: roomName(B), rivalBy: '18:00' });
    expect(spoken(short, tickSimulation(short, new PRNG(5)).state)).toEqual([`${roomName(A)}, held for the travel writer, won't be ready when they come. It'll be ready by about 19:00: they'll take ${roomName(B)} (free by about 18:00) if it's still free, else wait for it.`]);
    expect(tickTillIn(short, A.id)).toMatchObject({ into: B.id, at: 18 });
    // ... with no money for it: it doesn't start, and B's theirs as it is
    const broke = held(lesser, studio, 0);
    expect(holdFor(broke, broke.rooms[0])).toMatchObject({ rival: roomName(B), rivalBy: '17:00' });
    expect(tickTillIn(broke, A.id)).toMatchObject({ into: B.id, at: 17 });
    // ... B a little plainer than A, the refit freshening it: as good once it's done, so theirs then
    const plainer = (() => {
      const h = held(lesser, studio);
      return { ...h, rooms: h.rooms.map(r => (r.id === B.id ? { ...r, decor: 59 } : r)) };
    })();
    expect(holdFor(plainer, plainer.rooms[0])).toMatchObject({ rival: roomName(B), rivalBy: '18:00' });
    expect(tickTillIn(plainer, A.id)).toMatchObject({ into: B.id, at: 18 });
    // ... a refit taking out B's sofa: no longer a suite (no lounge), so not theirs (they wait for A)
    const noSofa = { ...studio, items: studio.items.filter(x => x.kind !== 'sofa') };
    const lounge = held(studio, noSofa);
    const loungeCard = holdFor(lounge, lounge.rooms[0])!;
    expect(loungeCard).toMatchObject({ readyBy: '19:00' });
    expect(loungeCard.rival).toBeUndefined();
    expect(tickTillIn(lounge, A.id)).toMatchObject({ into: A.id, at: 19 });
    // ... B empty now, the refit waiting for the money (booked, as the Furnish panel does): theirs at their hour
    const waiting0 = { ...s0, cash: 100, staff: { ...s0.staff, housekeepers: 2 }, spotlightHold: 'none' as const, spotlight: plan({ arrivalDay: 9, arrivalHour: 15 }),
      rooms: s0.rooms.map(r => ({ ...r, decor: 60, ...(r.id === B.id ? { furnishing: lesser, status: 'vacant' as const, cleaningHoursRemaining: 0 } : {}) })) };
    const waiting1 = refitRoom(waiting0, B.id, studio, 'checkout')!;
    expect(waiting1.rooms.find(r => r.id === B.id)!.pendingRefit).toBeDefined();
    const waiting = holdSuite({ ...waiting1, staffPlan: getStaffPlan(waiting1) }, A.id)!;
    const now = holdFor(waiting, waiting.rooms[0])!;
    expect(now).toMatchObject({ rival: roomName(B) });
    expect(now.rivalBy).toBeUndefined();
    expect(tickTillIn(waiting, A.id)).toMatchObject({ into: B.id, at: 15 });
  });

  it('a hold moved in the hour before they come, minutes past their hour: the move\'s note says they\'ll wait (it\'s certain then)', () => {
    // 14:00, due 15:00, one housekeeper: A held by the game, its guest staying on; B done about 15:15
    const t0 = build({ day: 9, hour: 14, suites: 2, standards: 0, dirty: { 1: 1 } });
    const t1 = { ...t0, staff: { ...t0.staff, housekeepers: 1 } };
    const stay = leaver('g-stay', 11, false, 5);
    const s = { ...t1, guests: [stay], spotlight: plan({ announceDay: 8, arrivalDay: 9, arrivalHour: 15, roomId: t1.rooms[0].id }),
      rooms: t1.rooms.map((r, i) => (i === 0 ? { ...r, decor: 60, status: 'occupied' as const, guestId: stay.id } : { ...r, decor: 60, cleaningHoursRemaining: 15.25 - 14 - baseWalkHours(t1) })) };
    const B = s.rooms[1];
    const told = storyByTick(s, 2);
    expect(told.said[0]).toEqual([`The suite held for the travel writer is now ${roomName(B)}. It'll be ready by about 16:00: they'll wait for it.`]);
    expect(told.said[1]).toEqual([expect.stringMatching(/checked in to /)]);
    expect(tickTillIn(s, B.id)).toMatchObject({ into: B.id, at: 16 });
  });

  it('a slip is said of a held suite being renovated too (its guest\'s gone, though no turnover\'s under way): held by hand, done after their hour', () => {
    // 12:00, due 15:00: A vacant, held by the game; B renovating, 4h left, held by hand
    const s0 = build({ day: 9, hour: 12, suites: 2, standards: 0, dirty: {} });
    const [A, B] = s0.rooms;
    const s1 = { ...s0, rooms: s0.rooms.map(r => (r.id === B.id ? { ...r, decor: 60, status: 'renovating' as const, renovationHoursRemaining: 4 } : { ...r, decor: 60 })),
      spotlight: plan({ arrivalDay: 9, arrivalHour: 15, roomId: A.id }) };
    const hand = holdSuite(s1, B.id)!;
    expect(holdFor(hand, hand.rooms[1])).toMatchObject({ held: true, readyBy: '17:00' });
    expect(storyByTick(hand, 1).said).toEqual([[`${roomName(B)}, held for the travel writer, won't be ready when they come. It'll be ready by about 17:00: they'll wait for it.`]]);
    expect(tickTillIn(hand, B.id)).toMatchObject({ into: B.id, at: 17 });
  });

  it('another suite\'s card, judged with it held instead, from the hour\'s plan (as every state between ticks has it): no rival when the one held now would lose its rush', () => {
    // 09:00, due 15:00, one housekeeper in X (1h left, she keeps at it): ta 3h held, tb 6h, three standards 1.5h. With tb
    // held instead, ta waits its turn behind the three (late) and tb's rushed (with ta held, ta's rushed, in time)
    const t0 = build({ day: 9, hour: 9, suites: 2, standards: 4, dirty: { 0: 3, 1: 6, 2: 1, 3: 1.5, 4: 1.5, 5: 1.5 }, crew: (r, abs) => [keeper('hk', 'mid', r[2], abs, true)] });
    const [ta, tb] = t0.rooms;
    const t1 = { ...t0, rooms: t0.rooms.map(r => ({ ...r, decor: 60 })), spotlight: plan({ arrivalDay: 9, arrivalHour: 15, roomId: ta.id }) };
    const t = { ...t1, staffPlan: getStaffPlan(t1) };
    expect(t.staffPlan.rush?.roomId).toBe(ta.id);
    const offered = holdFor(t, t.rooms[1])!;
    expect(offered).toMatchObject({ held: false, readyBy: '17:00' });
    expect(offered.rival).toBeUndefined();
    expect(tickTillIn(holdSuite(t, tb.id)!, tb.id)).toMatchObject({ into: tb.id, at: 17 });
  });

  it('at the announcement, of two as good ready only by the last check-in, the one ready sooner as it\'ll be cleaned held (rushed) is held', () => {
    // Day 9, 09:00, the writer announced for day 10 at 15:00, one housekeeper. Suites A and B as good; B (first in the
    // rooms) has a night owl leaving at 13:00 (late checkout), A a guest leaving at 11:00, as does standard X. In turn
    // B's sooner (X, then B, then A); held, A goes first at 11:00 and is ready by 13:00, in time; B, held, about 16:00
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = addRoom(s, 'suite', 3, 2, 0, 'up')!;
    s = addRoom(s, 'suite', 4, 2, 0, 'up')!;
    s = addRoom(s, 'standard', 5, 2, 0, 'up')!;
    const [A, B, X] = s.rooms;
    s = { ...s, day: 9, hour: 9, noiseSources: [], staffPlan: null, lateCheckout: 'free', staff: { ...s.staff, housekeepers: 1 },
      staffRoster: [keeper('hk', 'mid', X, 8 * 24 + 9), ...(s.staffRoster ?? []).filter(m => m.role !== 'housekeeper')],
      guests: [leaver('gA', 11), leaver('gB', 11, true), leaver('gX', 11)],
      rooms: [B, X, A].map(r => ({ ...r, decor: 60, condition: 90, status: 'occupied' as const, guestId: r.id === A.id ? 'gA' : r.id === B.id ? 'gB' : 'gX' })),
      spotlight: plan({ status: 'planned' }) };
    const ann = { ...s.spotlight!, status: 'announced' as const };
    const last = { ...ann, arrivalHour: ECONOMY.checkInEndHour, byLast: true };
    const room = (id: string) => s.rooms.find(r => r.id === id)!;
    expect(readyAt(s, room(B.id), last, false, true)).toBeLessThan(readyAt(s, room(A.id), last, false, true));
    expect(readyAt({ ...s, spotlight: { ...ann, roomId: A.id } }, room(A.id), last, false, true)).toBeLessThan(9 * 24 + 15);
    expect(readyAt({ ...s, spotlight: { ...ann, roomId: B.id } }, room(B.id), last, false, true)).toBeGreaterThan(9 * 24 + 15);
    const told = planSpotlight(s).state;
    expect(told.spotlight!.roomId).toBe(A.id);
    expect(spoken(s, told)).toEqual([`A travel writer arrives Wednesday at about 15:00 and wants a suite. ${roomName(A)} is held for them.`]);
    expect(quiet(() => tickTillIn(told, A.id, 40))).toMatchObject({ into: A.id, at: 15 });
  });
});
