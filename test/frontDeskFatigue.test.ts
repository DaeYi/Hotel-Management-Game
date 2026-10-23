import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_FATIGUE } from '../src/config/staff.js';
import { BREAK_ROOM, VOICE, TRAVEL } from '../src/config/balance.js';
import { addFixture, addRoom, createStarterHotel, demolishFixture } from '../src/simulation/HotelState.js';
import { deskCoverage, physicalDeskLanes, planDeskClerk, scheduledDeskBreaks, scheduledDeskLanes } from '../src/simulation/FrontDesk.js';
import { lanesOf, quoteLane, reseatLanes } from '../src/simulation/DeskQueue.js';
import { fatigueOf, projectFatigue, restReservations } from '../src/simulation/StaffFatigue.js';
import { rosterAfter, replanStaff, getStaffPlan } from '../src/simulation/StaffManager.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { routeFromStreet, findRoute, doorTile } from '../src/simulation/Layout.js';
import { hourStart, makeStay, makeWalk } from '../src/simulation/Movement.js';
import type { Guest, HotelState, StaffMember, StayLeg } from '../src/simulation/types.js';

const seats = BREAK_ROOM.seats;
afterEach(() => { STAFF_FATIGUE.enabled = true; BREAK_ROOM.seats = seats; });

function hotel(fatigue = 0, count = 1): HotelState {
  const s = { ...createStarterHotel(), day: 2, hour: 15, cash: 1_000_000 };
  const lane = physicalDeskLanes(s)[0];
  const people: StaffMember[] = Array.from({ length: count }, (_, i) => ({ id: `clerk-${i}`, serial: i + 1, name: `Clerk ${i}`, role: 'front_desk', shift: 'late',
    at: lane.front, deskLane: `${lane.desk.id}:${i}`, dailyWage: 40,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal' },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: hourStart(s) } }));
  return { ...s, staffRoster: people, staffPlan: null, frontDeskRosterReady: true, staff: { frontDesk: count, housekeepers: 0, maintenanceWorkers: 0 } };
}
function guest(id: string, trip: Guest['trip'], complaint = false): Guest {
  return { id, name: id, trait: 'normal', budget: 100, satisfaction: 50, stayLength: 2, checkInDay: 1,
    isReturning: false, hadNoiseComplaint: false, trip, tripKind: complaint ? 'complaint' : 'arrival',
    ...(complaint ? { complaint: { about: 'their stay', via: 'desk' as const } } : {}) };
}

describe('The front desk uses the fatigue of the clerk actually serving', () => {
  it('quotes slower current service but recovers before tomorrow’s shift', () => {
    const s = hotel(65), T = hourStart(s);
    const current = quoteLane(lanesOf(s), new Map(), () => T, 1 / 3, undefined, true)!;
    expect(current.start).toBe(T);
    expect(current.hours).toBeCloseTo((1 / 3) / 0.85, 10);
    const tomorrow = quoteLane(lanesOf(s), new Map(), () => 62, 1 / 3, undefined, true)!;
    expect(tomorrow.start).toBe(62);
    expect(tomorrow.hours).toBeCloseTo(1 / 3, 10);
  });

  it('keeps exact future low-stamina speed windows after off-duty recovery, including commute fatigue', () => {
    const originalGain = STAFF_FATIGUE.gain.low;
    // Stress the future rate split: a production eight-hour shift normally stays below 60.
    STAFF_FATIGUE.gain.low = 9;
    try {
      const original = hotel(85);
      const s = { ...original, staffRoster: original.staffRoster!.map(m => ({ ...m, profile: { ...m.profile!, stamina: 'low' as const } })) };
      const lane = physicalDeskLanes(s)[0], commute = routeFromStreet(s, lane.front)!.hours;
      const crosses = 62 + (60 - commute * STAFF_FATIGUE.gain.low) / STAFF_FATIGUE.gain.low;
      const future = scheduledDeskLanes(s)[0].duties!.filter(d => d.from >= 62 && d.from < 70);
      expect(future[0].startUntil).toBeCloseTo(crosses, 10);
      expect(future[1].from).toBeCloseTo(crosses, 10);
      const before = quoteLane(lanesOf(s), new Map(), () => crosses - 0.01, 1 / 3, undefined, true)!;
      const after = quoteLane(lanesOf(s), new Map(), () => crosses + 0.01, 1 / 3, undefined, true)!;
      expect(before.hours).toBeCloseTo(1 / 3, 10);
      expect(before.start + before.hours).toBeGreaterThan(crosses);
      expect(after.hours).toBeCloseTo((1 / 3) / 0.85, 10);
    } finally {
      STAFF_FATIGUE.gain.low = originalGain;
    }
  });

  it('lets a service begin before tiredness and finish at its snapshotted speed', () => {
    const s = hotel(59.5), T = hourStart(s);
    const slot = quoteLane(lanesOf(s), new Map(), () => T, 1 / 3, undefined, true)!;
    expect(slot.start).toBe(T);
    expect(slot.hours).toBeCloseTo(1 / 3, 10);
    const late = quoteLane(lanesOf(s), new Map(), () => T + 0.2, 1 / 3, undefined, true)!;
    expect(late.hours).toBeCloseTo((1 / 3) / 0.85, 10);
    expect(deskCoverage(s, T + 0.2)).toHaveLength(1); // overlapping rate windows are one physical clerk
  });

  it('closes coverage for the physical break and both walks, then reopens at the desk', () => {
    const s = addFixture(hotel(85), 'breakroom', 5, 0, 0)!, T = hourStart(s), member = s.staffRoster![0];
    const plan = planDeskClerk(s, member, T), rest = plan.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!;
    expect(rest.placeId).toBe(s.fixtures.find(f => f.type === 'breakroom')!.id);
    expect(deskCoverage(s, T + 0.01)).toHaveLength(0);
    expect(deskCoverage(s, (rest.start + rest.end) / 2)).toHaveLength(0);
    const slot = quoteLane(lanesOf(s), new Map(), () => T + 0.01, 1 / 3, undefined, true)!;
    expect(slot.start).toBeGreaterThan(rest.end);
    expect(deskCoverage(s, slot.start + 1e-6)).toHaveLength(1);
    expect(scheduledDeskBreaks(s).some(r => r.staffId === member.id && r.placeId === rest.placeId)).toBe(true);
  });

  it('finishes underway service unchanged before resting and rebooks the waiting guest', () => {
    let s = addFixture(hotel(85), 'breakroom', 5, 0, 0)!;
    const lane = physicalDeskLanes(s)[0], T = hourStart(s), clerk = s.staffRoster![0];
    s = { ...s, guests: [guest('served', [makeStay(lane.front, T - 0.1, T + 0.3, 'check_in', { lane: lane.key, placeId: lane.desk.id, serviceStaffId: clerk.id })]),
      guest('waiting', [makeStay(lane.front, T - 0.1, T + 0.3, 'wait', { lane: lane.key, placeId: lane.desk.id }),
        makeStay(lane.front, T + 0.3, T + 0.3 + 1 / 3, 'check_in', { lane: lane.key, placeId: lane.desk.id, serviceStaffId: clerk.id })])] };
    const plan = planDeskClerk(s, clerk, T);
    const rest = plan.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!;
    expect(plan.legs[0]).toMatchObject({ kind: 'stay', activity: 'desk', start: T, end: T + 0.3 });
    expect(rest.start).toBeGreaterThanOrEqual(T + 0.3);
    const reseated = reseatLanes(s, T + 0.1);
    const first = reseated.guests[0].trip!.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'check_in')!;
    const next = reseated.guests[1].trip!.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'check_in')!;
    expect(first.start).toBe(T - 0.1); expect(first.end).toBe(T + 0.3);
    expect(next.start).toBeGreaterThan(rest.end);
  });

  it('reserves each break-room seat once and gives the other clerk slower fallback rest', () => {
    BREAK_ROOM.seats = 1;
    const s = addFixture(hotel(85, 2), 'breakroom', 5, 0, 0)!, T = hourStart(s);
    const rests = s.staffRoster!.map(m => planDeskClerk(s, m, T).legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!);
    expect(rests.filter(l => !!l.placeId)).toHaveLength(1);
    expect(rests.map(l => l.restRate).sort((a, b) => a! - b!)).toEqual([10, 25]);
    expect(deskCoverage(s, T + 0.01)).toHaveLength(0);
  });

  it('shares the same capacity with room staff and keeps the resting clerk unavailable', () => {
    BREAK_ROOM.seats = 1;
    let s = addFixture(hotel(85), 'breakroom', 5, 0, 0)!;
    const cleaner: StaffMember = { ...s.staffRoster![0], id: 'cleaner', role: 'housekeeper', shift: undefined, deskLane: undefined,
      at: { gridX: 5, gridY: 1, floor: 0 } };
    s = { ...s, staffRoster: [...s.staffRoster!, cleaner], staff: { ...s.staff, housekeepers: 1 } };
    const plan = getStaffPlan(s), T = hourStart(s);
    const rests = plan.itineraries.flatMap(it => it.legs.filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest'));
    expect(rests.some(l => l.restRate === 25)).toBe(true);
    expect(rests.some(l => l.restRate === 10 && !l.placeId)).toBe(true);
    for (const at of rests.flatMap(l => [l.start + 1e-6, Math.min(l.end - 1e-6, T + 0.999)])) {
      expect(rests.filter(l => l.placeId && l.start <= at && at < l.end).length).toBeLessThanOrEqual(1);
    }
    const clerkRest = plan.itineraries.find(it => it.staffId === s.staffRoster![0].id)!.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!;
    expect(deskCoverage({ ...s, staffPlan: plan }, (clerkRest.start + clerkRest.end) / 2)).toHaveLength(0);
  });

  it('reserves an already planned later housekeeping rest before projecting a delayed desk break', () => {
    BREAK_ROOM.seats = 1;
    let s = addRoom(addFixture(hotel(85), 'breakroom', 5, 0, 0)!, 'standard', 5, 2, 0, 'up')!;
    const T = hourStart(s), lane = physicalDeskLanes(s)[0], room = s.rooms[0], breakRoom = s.fixtures.find(f => f.type === 'breakroom')!;
    const at = { gridX: room.gridX, gridY: room.gridY, floor: room.floor, door: room.door };
    const cleaner: StaffMember = { ...s.staffRoster![0], id: 'cleaner-later', role: 'housekeeper', shift: undefined, deskLane: undefined, at,
      profile: { ...s.staffRoster![0].profile!, stamina: 'low' }, stats: { ...s.staffRoster![0].stats!, fatigue: 80 } };
    const route = findRoute(s, at, breakRoom)!, setOff = T + 5 / STAFF_FATIGUE.gain.low;
    const travel = makeWalk(route.path, setOff, TRAVEL.hoursPerTile), starts = travel.end, ends = starts + 0.5;
    const plannedBreak = { at: { gridX: breakRoom.gridX, gridY: breakRoom.gridY, floor: breakRoom.floor }, placeId: breakRoom.id, start: starts, end: ends };
    s = { ...s, staffRoster: [...s.staffRoster!, cleaner], staff: { ...s.staff, housekeepers: 1 },
      guests: [guest('underway', [makeStay(lane.front, T - 0.1, T + 0.4, 'check_in', { lane: lane.key, placeId: lane.desk.id, serviceStaffId: s.staffRoster![0].id })])],
      staffPlan: { start: T, itineraries: [{ staffId: cleaner.id, legs: [
        makeStay(at, T, setOff, 'clean', { placeId: room.id, job: 'turnover', workRate: 0.85 }), travel,
        makeStay(plannedBreak.at, starts, ends, 'rest', { placeId: breakRoom.id, restRate: 25 }),
      ], end: { at: plannedBreak.at, fatigueBreak: plannedBreak } }] } };
    expect(cleaner.fatigueBreak).toBeUndefined(); // the new break is not a boundary-state field yet
    const desk = planDeskClerk(s, s.staffRoster![0], T);
    const rests = desk.legs.filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
    for (const rest of rests.filter(l => l.placeId === breakRoom.id))
      expect(rest.end <= starts || rest.start >= ends).toBe(true);
    expect(restReservations(s).some(r => r.staffId === cleaner.id && r.start === starts && r.end === ends)).toBe(true);
    expect(rests.some(l => l.restRate === 10 && !l.placeId)).toBe(true);
  });

  it('continues a fixed cross-hour break without restarting its duration', () => {
    let s = addFixture(hotel(85), 'breakroom', 8, 0, 0)!;
    const T = hourStart(s), lane = physicalDeskLanes(s)[0];
    s = { ...s, guests: [guest('served', [makeStay(lane.front, T - 0.1, T + 0.4, 'check_in', { lane: lane.key, placeId: lane.desk.id, serviceStaffId: s.staffRoster![0].id })])] };
    const plan = planDeskClerk(s, s.staffRoster![0], T);
    expect(plan.end.fatigueBreak).toBeDefined();
    const fixedEnd = plan.end.fatigueBreak!.end;
    const staffPlan = { start: T, itineraries: [plan] };
    s = { ...s, hour: 16, staffRoster: rosterAfter({ ...s, staffPlan }, staffPlan), staffPlan: null };
    const next = planDeskClerk(s, s.staffRoster![0], T + 1);
    expect(next.legs.find(l => l.kind === 'stay' && l.activity === 'rest')!.end).toBeCloseTo(fixedEnd, 10);
    expect(fixedEnd).toBeLessThan(T + 1.5);
  });

  it('does not compound tired complaint durations when a waiting party is reseated repeatedly', () => {
    let s = hotel(65), T = hourStart(s), lane = physicalDeskLanes(s)[0];
    const slot = quoteLane(lanesOf(s), new Map(), () => T + 0.4, VOICE.complainHours)!;
    s = { ...s, guests: [guest('complaint', [makeStay(lane.front, T, slot.start, 'wait', { lane: lane.key, placeId: lane.desk.id }),
      makeStay(lane.front, slot.start, slot.start + slot.hours, 'complain', { lane: lane.key, placeId: lane.desk.id, serviceStaffId: s.staffRoster![0].id })], true)] };
    s = reseatLanes(reseatLanes(s, T + 0.1), T + 0.2);
    const service = s.guests[0].trip!.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'complain')!;
    expect(service.end - service.start).toBeCloseTo(VOICE.complainHours / 0.85, 10);
  });

  it('paused mid-break replanning preserves its fixed end, fatigue and closed lane', () => {
    const s = addFixture(hotel(85), 'breakroom', 5, 0, 0)!, T = hourStart(s), member = s.staffRoster![0];
    const original = planDeskClerk(s, member, T);
    const rest = original.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!;
    const next = replanStaff({ ...s, staffPlan: { start: T, itineraries: [original] } }, rest.start + 0.1);
    const revised = next.staffPlan!.itineraries[0];
    const rests = revised.legs.filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
    expect(Math.max(...rests.map(l => l.end))).toBeCloseTo(rest.end, 10);
    expect(rests.reduce((sum, l) => sum + l.end - l.start, 0)).toBeCloseTo(rest.end - rest.start, 10);
    expect(projectFatigue(member, revised.legs, T, T + 1)).toBeCloseTo(projectFatigue(member, original.legs, T, T + 1), 10);
    expect(deskCoverage(next, rest.start + 0.2)).toHaveLength(0);
  });

  it('loses fast future recovery when a break room is demolished, keeping only earned recovery', () => {
    let s = addFixture(hotel(85), 'breakroom', 5, 0, 0)!, T = hourStart(s);
    const member = s.staffRoster![0], original = planDeskClerk(s, member, T);
    const rest = original.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!;
    s = { ...s, staffPlan: { start: T, itineraries: [original] } };
    const at = rest.start + 0.1;
    const next = settleChanges(s, demolishFixture(s, rest.placeId!)!, at);
    const rests = next.staffPlan!.itineraries[0].legs.filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
    expect(rests.some(l => l.end <= at + 1e-9 && l.restRate === 25)).toBe(true);
    expect(rests.filter(l => l.end > at + 1e-9).every(l => l.restRate === 10 && !l.placeId)).toBe(true);
    expect(scheduledDeskBreaks(next).every(r => r.placeId !== rest.placeId)).toBe(true);
  });

  it('leaves a room built over its fallback rest through the actual door without extending the break', () => {
    let s = hotel(85), T = hourStart(s);
    const original = planDeskClerk(s, s.staffRoster![0], T);
    const rest = original.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!;
    expect(rest.placeId).toBeUndefined();
    s = { ...s, staffPlan: { start: T, itineraries: [original] } };
    const at = rest.start + 0.1;
    const built = addRoom(s, 'standard', rest.at.gridX, rest.at.gridY, rest.at.floor, 'down')!;
    const room = built.rooms.find(r => r.gridX === rest.at.gridX && r.gridY === rest.at.gridY && r.floor === rest.at.floor)!;
    const next = settleChanges(s, built, at), legs = next.staffPlan!.itineraries[0].legs;
    const exit = legs.find(l => l.kind === 'walk' && l.start >= at - 1e-9)!;
    expect(exit.kind).toBe('walk');
    if (exit.kind === 'walk') {
      expect(exit.start).toBeCloseTo(at, 10);
      expect(exit.path[0]).toMatchObject(rest.at);
      expect(exit.path[1]).toMatchObject(doorTile(room, room.door));
    }
    const rests = legs.filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
    expect(rests.filter(l => l.end <= at + 1e-9).reduce((sum, l) => sum + l.end - l.start, 0)).toBeCloseTo(0.1, 10);
    const remaining = rests.find(l => l.end > at + 1e-9)!;
    expect(remaining.at).toMatchObject(doorTile(room, room.door));
    expect(remaining.restRate).toBe(STAFF_FATIGUE.fallbackRecovery);
    expect(remaining.end).toBeCloseTo(rest.end, 10);
    expect(deskCoverage(next, (remaining.start + remaining.end) / 2)).toHaveLength(0);
  });

  it('counts idle counter duty as fatigue without giving service experience or resetting at midnight', () => {
    let s = hotel(40);
    let member: StaffMember = { ...s.staffRoster![0], shift: 'night' };
    s = { ...s, hour: 23, staffRoster: [{ ...member, stats: { ...member.stats!, fatigueAt: 47 } }] };
    member = s.staffRoster![0];
    const plan = planDeskClerk(s, member, 47), staffPlan = { start: 47, itineraries: [plan] };
    const next = rosterAfter({ ...s, staffPlan }, staffPlan)[0];
    expect(fatigueOf(next)).toBeCloseTo(40 + STAFF_FATIGUE.gain.normal, 10);
    expect(next.stats!.workHours).toBe(80);
    expect(projectFatigue(member, plan.legs, 47, 48)).toBeCloseTo(40 + STAFF_FATIGUE.gain.normal, 10);
  });

  it('restores the original service and uninterrupted lane when fatigue is disabled', () => {
    STAFF_FATIGUE.enabled = false;
    const s = hotel(99), T = hourStart(s);
    expect(planDeskClerk(s, s.staffRoster![0], T).legs.some(l => l.kind === 'stay' && l.activity === 'rest')).toBe(false);
    expect(quoteLane(scheduledDeskLanes(s), new Map(), () => T, 1 / 3, undefined, true)!.hours).toBeCloseTo(1 / 3, 10);
  });
});
