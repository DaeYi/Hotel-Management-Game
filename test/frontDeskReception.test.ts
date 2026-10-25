import { describe, expect, it } from 'vitest';
import { addRoom, createStarterHotel } from '../src/simulation/HotelState.js';
import { deskCoverage, physicalDeskLanes, planDeskClerk, scheduledDeskLanes } from '../src/simulation/FrontDesk.js';
import { planStaff } from '../src/simulation/StaffManager.js';
import { hourStart, makeStay } from '../src/simulation/Movement.js';
import type { HotelState, StaffMember, StayLeg } from '../src/simulation/types.js';

function breakGapHotel(): HotelState {
  let state = addRoom({ ...createStarterHotel(), day: 2, hour: 14, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
  const lanes = physicalDeskLanes(state), T = hourStart(state);
  const profile = { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal' } as const;
  const stats = { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: T };
  const clerks: StaffMember[] = lanes.map((lane, i) => ({ id: `native-${i}`, serial: i + 1, role: 'front_desk', shift: 'late',
    at: lane.front, deskLane: lane.key, profile, stats: { ...stats, fatigue: i === 0 ? 82.5 : 0 } }));
  const room = state.rooms[0];
  const helper: StaffMember = { id: 'helper', serial: 3, role: 'housekeeper', at: { ...room }, roomId: room.id,
    profile: { ...profile, receptionTrained: true }, stats };
  state = { ...state, staff: { frontDesk: 2, housekeepers: 1, maintenanceWorkers: 0 }, frontDeskRosterReady: true,
    staffRoster: [...clerks, helper], staffPlan: null, rooms: [{ ...room, status: 'cleaning', cleaningHoursRemaining: 0.26 }] };
  return { ...state, staffPlan: planStaff(state) };
}

describe('Committed helpers preserve native reception seats', () => {
  it('fills a native break gap without moving that clerk or hiding the other seated clerk', () => {
    const state = breakGapHotel(), T = hourStart(state), lanes = physicalDeskLanes(state);
    const helper = state.staffPlan!.itineraries.find(it => it.staffId === 'helper')!;
    const support = helper.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk')!;
    expect(support.lane).toBe(lanes[0].key);
    expect(support.start).toBeCloseTo(T + 0.5, 9);
    expect(support.end).toBeCloseTo(T + 1, 9);
    expect(deskCoverage(state, T + 0.1).map(d => d.staffId).sort()).toEqual(['native-0', 'native-1']);
    expect(deskCoverage(state, T + 0.55).map(d => d.staffId).sort()).toEqual(['helper', 'native-1']);
    const native = state.staffRoster!.find(m => m.id === 'native-0')!;
    const replayed = planDeskClerk(state, native, T);
    const desk = replayed.legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk')!;
    expect(desk.lane).toBe(lanes[0].key);
    expect(desk.start).toBe(T);
    expect(desk.end).toBeCloseTo(T + 0.5, 9);
    const quoted = scheduledDeskLanes(state);
    for (const time of [T + 0.1, T + 0.55, T + 0.99]) for (const lane of quoted) {
      const active = lane.duties!.filter(d => d.from <= time && (d.startUntil ?? d.to) > time);
      expect(new Set(active.map(d => d.staffId)).size).toBeLessThanOrEqual(1);
    }
  });

  it('reserves a planned native seat before an older unplanned clerk chooses a lane', () => {
    const original = breakGapHotel(), T = hourStart(original), lanes = physicalDeskLanes(original);
    const unplanned: StaffMember = { ...original.staffRoster![0], at: null, deskLane: undefined,
      stats: { ...original.staffRoster![0].stats!, fatigue: 0 } };
    const seated: StaffMember = { ...original.staffRoster![1], deskLane: undefined };
    const support = { lane: lanes[0].key, from: T, to: T + 1 };
    const helper: StaffMember = { ...original.staffRoster![2], at: lanes[0].front, receptionSupport: support };
    const state: HotelState = { ...original, staffRoster: [unplanned, seated, helper], staffPlan: { start: T, itineraries: [
      { staffId: seated.id, legs: [makeStay(lanes[1].front, T, T + 1, 'desk', { lane: lanes[1].key, placeId: lanes[1].desk.id })], end: { at: lanes[1].front, deskLane: lanes[1].key } },
      { staffId: helper.id, legs: [makeStay(lanes[0].front, T, T + 1, 'desk', { lane: lanes[0].key, placeId: lanes[0].desk.id })], end: { at: lanes[0].front, receptionSupport: support } },
    ] } };
    expect(deskCoverage(state, T + 0.2).map(d => d.staffId).sort()).toEqual(['helper', seated.id]);
    const kept = planDeskClerk(state, seated, T).legs.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk')!;
    expect(kept.lane).toBe(lanes[1].key);
    expect(kept.start).toBe(T);
    expect(kept.end).toBe(T + 1);
    const arriving = planDeskClerk(state, unplanned, T).legs.filter((l): l is StayLeg => l.kind === 'stay' && l.activity === 'desk');
    expect(arriving.every(l => l.start >= support.to)).toBe(true);
  });
});
