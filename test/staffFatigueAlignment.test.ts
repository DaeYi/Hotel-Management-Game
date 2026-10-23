import { afterEach, expect, it } from 'vitest';
import { STAFF_FATIGUE } from '../src/config/staff.js';
import { addFixture, addRoom, createStarterHotel, demolishFixture } from '../src/simulation/HotelState.js';
import { physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { getStaffPlan, rosterAfter } from '../src/simulation/StaffManager.js';
import { assignStaffSpecialty } from '../src/simulation/StaffHiring.js';
import { fatigueAt } from '../src/simulation/StaffFatigue.js';
import { loadGame, saveGame } from '../src/simulation/SaveManager.js';
import { PRNG } from '../src/simulation/prng.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { hourStart, positionAt, sameTile } from '../src/simulation/Movement.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import type { HotelState, StaffMember, StayLeg } from '../src/simulation/types.js';

afterEach(() => localStorage.clear());

function housekeeperHotel(fatigue: number, breakX = 8): HotelState {
  let state = addRoom({ ...createStarterHotel(), day: 2, hour: 12, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
  state = addFixture(state, 'breakroom', breakX, 0, 0)!;
  const room = state.rooms[0], T = hourStart(state);
  const member: StaffMember = { id: 'housekeeper-break', name: 'Cleaner on break', role: 'housekeeper', at: roomTile(room), roomId: room.id,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', specialty: 'turnover_runner' },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue, fatigueAt: T } };
  state = { ...state, rooms: [{ ...room, status: 'cleaning', cleaningHoursRemaining: 10 }],
    staffRoster: [member], staff: { frontDesk: 0, housekeepers: 1, maintenanceWorkers: 0 }, frontDeskRosterReady: true, staffPlan: null };
  return { ...state, staffPlan: getStaffPlan(state) };
}

it('a desk clerk keeps past recovery but cannot keep fast future recovery after their break room is demolished', () => {
  let state: HotelState = { ...createStarterHotel(), day: 2, hour: 15, cash: 1_000_000 };
  const lane = physicalDeskLanes(state)[0], T = hourStart(state);
  const member: StaffMember = { id: 'clerk-break', name: 'Clerk on break', role: 'front_desk', shift: 'late', at: lane.front, deskLane: lane.key,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal' },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 85, fatigueAt: T } };
  state = { ...state, staffRoster: [member], frontDeskRosterReady: true, staff: { frontDesk: 1, housekeepers: 0, maintenanceWorkers: 0 }, staffPlan: null };
  state = addFixture(state, 'breakroom', 5, 0, 0)!;
  const room = state.fixtures.find(f => f.type === 'breakroom')!;
  const plan = getStaffPlan(state);
  const rest = plan.itineraries[0].legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!;
  expect(rest.restRate).toBe(STAFF_FATIGUE.roomRecovery);
  state = { ...state, staffPlan: plan };
  const t = rest.start + 0.1;
  const demolished = demolishFixture(state, room.id)!;
  const after = settleChanges(state, demolished, t);
  const stays = getStaffPlan(after).itineraries[0].legs.filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest');
  expect(stays.some(l => l.end <= t + 1e-9 && l.restRate === STAFF_FATIGUE.roomRecovery)).toBe(true);
  for (const future of stays.filter(l => l.end > t + 1e-9 && l.restRate === STAFF_FATIGUE.roomRecovery)) {
    expect(after.fixtures.some(f => f.id === future.placeId && f.type === 'breakroom' && sameTile(f, future.at))).toBe(true);
  }
});

it('a housekeeper carries the real outbound walk through a paused specialty edit, reload and hour boundary before earning any rest', () => {
  // Start the compulsory break at :57 so its real walk crosses the boundary,
  // regardless of the stamina gain selected in balance tuning.
  const initial = STAFF_FATIGUE.breakAt - STAFF_FATIGUE.gain.normal * 0.95;
  let state = housekeeperHotel(initial);
  const member = state.staffRoster![0], T = hourStart(state), original = state.staffPlan!.itineraries[0];
  const rest = original.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!;
  const walk = original.legs.find(l => l.kind === 'walk' && l.start < T + 1 && l.end > T + 1)!;
  expect(walk.kind).toBe('walk');
  expect(rest.start).toBeGreaterThan(T + 1);
  expect(rest.end - rest.start).toBeCloseTo(STAFF_FATIGUE.breakHours, 10);
  const editedAt = T + 0.99;
  const shown = positionAt(original.legs, editedAt)!;
  const expectedFatigue = fatigueAt(state, member, editedAt);
  state = settleChanges(state, assignStaffSpecialty(state, member.id, 'room_attendant')!, editedAt);
  const edited = state.staffPlan!.itineraries[0];
  const actual = positionAt(edited.legs, editedAt)!;
  expect(actual.x).toBeCloseTo(shown.x, 8);
  expect(actual.y).toBeCloseTo(shown.y, 8);
  expect(actual.floor).toBe(shown.floor);
  expect(edited.end.fatigueBreak!.end).toBeCloseTo(rest.end, 10);
  expect(fatigueAt(state, state.staffRoster![0], editedAt)).toBeCloseTo(expectedFatigue, 10);
  expect(saveGame(state, new PRNG(31), undefined, { hourProgress: 0.99, paused: true, speed: 1 })).toBe(true);
  const loaded = loadGame()!;
  expect(loaded.clock).toMatchObject({ hourProgress: 0.99, paused: true });
  expect(loaded.state.staffPlan).toEqual(state.staffPlan);
  const plan = getStaffPlan(loaded.state);
  const atBoundary = positionAt(plan.itineraries[0].legs, T + 1)!;
  const people = rosterAfter(loaded.state, plan);
  expect(people[0].carry).toBeDefined();
  expect(people[0].carry!.start).toBeLessThan(T + 1);
  expect(people[0].carry!.end).toBeGreaterThan(T + 1);
  expect(people[0].stats!.fatigue).toBeCloseTo(initial + STAFF_FATIGUE.gain.normal, 8);
  expect(people[0].fatigueBreak!.end).toBeCloseTo(rest.end, 10);
  const advanced = { ...loaded.state, hour: loaded.state.hour + 1, staffRoster: people };
  const next: HotelState = { ...advanced, staffPlan: getStaffPlan(advanced) };
  const nextPlan = next.staffPlan!.itineraries[0], startsAtBoundary = positionAt(nextPlan.legs, T + 1)!;
  expect(startsAtBoundary.x).toBeCloseTo(atBoundary.x, 8);
  expect(startsAtBoundary.y).toBeCloseTo(atBoundary.y, 8);
  expect(startsAtBoundary.floor).toBe(atBoundary.floor);
  const resumed = nextPlan.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!;
  expect(resumed.start).toBeCloseTo(rest.start, 10);
  expect(resumed.end).toBeCloseTo(rest.end, 10);
  const beforeArrival = rest.start - 0.001;
  expect(fatigueAt(next, people[0], beforeArrival)).toBeCloseTo(initial + STAFF_FATIGUE.gain.normal * (beforeArrival - T), 8);
  expect(fatigueAt(next, people[0], rest.start + 0.25)).toBeCloseTo(initial + STAFF_FATIGUE.gain.normal * (rest.start - T) - STAFF_FATIGUE.roomRecovery * 0.25, 8);
});

it('a housekeeper whose break room is demolished preserves past fast recovery and completes the remaining break with slower fallback', () => {
  let state = housekeeperHotel(85, 5);
  const T = hourStart(state), member = state.staffRoster![0], original = state.staffPlan!.itineraries[0];
  const rest = original.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest')!;
  const editedAt = rest.start + 0.1;
  const before = fatigueAt(state, member, editedAt);
  state = settleChanges(state, demolishFixture(state, rest.placeId!)!, editedAt);
  const revised = state.staffPlan!.itineraries[0];
  const preserved = revised.legs.filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest' && l.restRate === STAFF_FATIGUE.roomRecovery && l.end <= editedAt + 1e-9);
  expect(preserved.reduce((sum, l) => sum + l.end - l.start, 0)).toBeCloseTo(0.1, 10);
  expect(fatigueAt(state, member, editedAt)).toBeCloseTo(before, 10);
  const remaining = revised.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'rest' && l.end > editedAt && l.start < rest.end)!;
  expect(remaining).toBeDefined();
  expect(remaining.placeId).toBeUndefined();
  expect(remaining.restRate).toBe(STAFF_FATIGUE.fallbackRecovery);
  expect(remaining.start).toBeGreaterThanOrEqual(editedAt);
  expect(remaining.end).toBeCloseTo(rest.end, 10);
  expect(revised.legs.some(l => l.kind === 'stay' && l.job && l.start >= editedAt && l.start < rest.end - 1e-9)).toBe(false);
  const snapshot = JSON.stringify(state);
  expect(saveGame(state, new PRNG(32), undefined, { hourProgress: editedAt - T, paused: true, speed: 1 })).toBe(true);
  const restored = loadGame()!.state;
  expect(JSON.stringify(restored)).toBe(snapshot);
  expect(fatigueAt(restored, restored.staffRoster![0], remaining.end)).toBeCloseTo(fatigueAt(state, member, remaining.end), 10);
});
