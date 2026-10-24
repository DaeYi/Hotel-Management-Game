import { afterEach, expect, it } from 'vitest';
import { ActorLayer, ACTOR_COLORS } from '../src/render/ActorLayer.js';
import { STAFF_CROSS_TRAINING } from '../src/config/staff.js';
import { createStarterHotel } from '../src/simulation/HotelState.js';
import { physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { hourStart, makeStay } from '../src/simulation/Movement.js';
import type { HotelState, StaffMember } from '../src/simulation/types.js';

afterEach(() => { STAFF_CROSS_TRAINING.enabled = true; });

it('draws trained housekeepers in both role colours during cleaning and reception, with the same clickable identity', () => {
  const base = { ...createStarterHotel(), day: 2, hour: 14 }, T = hourStart(base), lane = physicalDeskLanes(base)[0];
  const member: StaffMember = { id: 'housekeeper-trained', name: 'Dana Nguyen', role: 'housekeeper', at: lane.front,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', receptionTrained: true },
    stats: { workHours: 80, lateDays: 0, absentDays: 0 } };
  let color = 0;
  const rectangles: Array<{ color: number; width: number; height: number }> = [];
  const graphics: unknown = new Proxy({}, { get: (_target, name) => (...args: number[]) => {
    if (name === 'fillStyle') color = args[0];
    if (name === 'fillRect') rectangles.push({ color, width: args[2], height: args[3] });
    return graphics;
  } });
  const actors = new ActorLayer({ add: { graphics: () => graphics } } as never);
  const draw = (activity: 'clean' | 'desk') => {
    rectangles.length = 0;
    const state: HotelState = { ...base, frontDeskRosterReady: true, staff: { frontDesk: 0, housekeepers: 1, maintenanceWorkers: 0 }, staffRoster: [member],
      staffPlan: { start: T, itineraries: [{ staffId: member.id, legs: [makeStay(lane.front, T, T + 1, activity,
        activity === 'desk' ? { lane: lane.key, placeId: lane.desk.id } : { job: 'turnover', placeId: 'room-test' })], end: { at: lane.front } }] } };
    actors.update(state, 0, T + 0.5);
    const drawn = (actors as unknown as { staffDrawn: Array<{ id: string; x: number; y: number }> }).staffDrawn;
    expect(drawn).toHaveLength(1);
    expect(actors.staffAt(drawn[0].x, drawn[0].y)).toBe(member.id);
    return [...rectangles];
  };
  for (const activity of ['clean', 'desk'] as const) {
    const shapes = draw(activity);
    expect(shapes).toContainEqual({ color: ACTOR_COLORS.housekeeper, width: 10, height: 10 });
    expect(shapes).toContainEqual({ color: ACTOR_COLORS.frontDesk, width: 5, height: 10 });
  }
  STAFF_CROSS_TRAINING.enabled = false;
  expect(draw('clean')).toEqual([{ color: ACTOR_COLORS.housekeeper, width: 10, height: 10 }]);
});
