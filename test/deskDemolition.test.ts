import { afterEach, describe, expect, it } from 'vitest';
import { FRONT_DESK_STAFF, STAFF_CLEANING_SUPPORT, STAFF_CROSS_TRAINING, STAFF_FATIGUE, STAFF_PERSONALITIES } from '../src/config/staff.js';
import { addRoom, createStarterHotel, demolishFixture } from '../src/simulation/HotelState.js';
import { deskCoverage, physicalDeskLanes, scheduledDeskLanes } from '../src/simulation/FrontDesk.js';
import { receptionSupports } from '../src/simulation/CrossTraining.js';
import { getStaffPlan } from '../src/simulation/StaffManager.js';
import { serviceSnapshot } from '../src/simulation/StaffHospitality.js';
import { hourStart, makeStay } from '../src/simulation/Movement.js';
import { settleChanges } from '../src/simulation/Settle.js';
import type { Guest, HotelState, StaffMember, StayLeg } from '../src/simulation/types.js';

const switches = [STAFF_CLEANING_SUPPORT, STAFF_CROSS_TRAINING, STAFF_FATIGUE, STAFF_PERSONALITIES, FRONT_DESK_STAFF];
const enabled = switches.map(setting => setting.enabled);
afterEach(() => { switches.forEach((setting, index) => { setting.enabled = enabled[index]; }); });

/** Clerks at the starter desk (two unless asked), an empty second desk across
 * the lobby and, if asked, a reception-trained housekeeper who takes a seat there. */
function lobby(hour: number, helper = false, guests: Guest[] = [], clerks = 2): HotelState {
  let base = addRoom({ ...createStarterHotel(), day: 2, hour, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
  base = { ...base, fixtures: [...base.fixtures, { id: 'desk-alternate', type: 'desk', gridX: 7, gridY: 0, floor: 0 }] };
  const lanes = physicalDeskLanes(base), T = hourStart(base);
  const profile = { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite' } as const;
  const stats = { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 30, fatigueAt: T };
  const people: StaffMember[] = [0, 1].slice(0, clerks).map(seat => ({ id: `clerk-${seat}`, serial: seat + 1, name: ['Jordan Hale', 'Casey Moore'][seat],
    role: 'front_desk', shift: hour >= 14 ? 'late' : 'early', at: lanes[seat].front, deskLane: lanes[seat].key, dailyWage: 40, profile, stats }));
  if (helper) people.push({ id: 'helper', serial: 3, name: 'Avery Park', role: 'housekeeper', dailyWage: 80.5, at: { gridX: 5, gridY: 1, floor: 0 },
    profile: { ...profile, receptionTrained: true }, stats: { ...stats, fatigue: 0 } });
  const state: HotelState = { ...base, frontDeskRosterReady: true, staffRoster: people, staffPlan: null, guests,
    staff: { frontDesk: clerks, housekeepers: helper ? 1 : 0, maintenanceWorkers: 0 } };
  return { ...state, staffPlan: getStaffPlan(state) };
}

function guest(id: string, trip: Guest['trip']): Guest {
  return { id, name: id, budget: 200, stayLength: 3, trait: 'normal', satisfaction: 50,
    checkInDay: 2, isReturning: false, hadNoiseComplaint: false, trip, tripKind: 'arrival' };
}

function seatedAt(state: HotelState, id: string, lane: string, t: number): boolean {
  return getStaffPlan(state).itineraries.find(itinerary => itinerary.staffId === id)!.legs.some(leg =>
    leg.kind === 'stay' && leg.activity === 'desk' && leg.lane === lane && leg.start <= t + 1e-9 && leg.end > t + 1e-9);
}

/** Every clerk carries on to the end of the hour, and the queue offers exactly
 * the people really sitting at a counter. */
function expectHonestDesk(state: HotelState, from: number): void {
  const T = hourStart(state), plan = getStaffPlan(state);
  for (const itinerary of plan.itineraries.filter(it => it.staffId.startsWith('clerk-')))
    expect(Math.max(...itinerary.legs.map(leg => leg.end)), `${itinerary.staffId} stops partway through the hour`).toBeGreaterThan(T + 1 - 1e-9);
  for (let t = from + 0.001; t < T + 1; t += 0.01) {
    const seated = plan.itineraries.filter(it => it.legs.some(leg => leg.kind === 'stay' && leg.activity === 'desk'
      && leg.start <= t && leg.end > t)).map(it => it.staffId).sort();
    expect([...new Set(deskCoverage(state, t).map(duty => duty.staffId))].sort(), `queue at +${(t - T).toFixed(3)}`).toEqual(seated);
  }
}

describe('Demolishing a desk partway through an hour', () => {
  for (const cleaning of [false, true]) for (const fatigue of [true, false]) {
    const switched = `clerk cleaning ${cleaning ? 'on' : 'off'}, fatigue ${fatigue ? 'on' : 'off'}`;

    it(`offers its clerks at the other desk only once they get there (${switched})`, () => {
      STAFF_CLEANING_SUPPORT.enabled = cleaning;
      STAFF_FATIGUE.enabled = fatigue;
      let state = lobby(11);
      const T = hourStart(state), at = T + 0.8, removed = physicalDeskLanes(state)[0].desk.id;
      state = settleChanges(state, demolishFixture(state, removed)!, at);
      // Both clerks set off now and reach the second desk just after the hour.
      const walks = getStaffPlan(state).itineraries.map(itinerary => itinerary.legs.at(-1)!);
      for (const walk of walks) {
        expect(walk.kind).toBe('walk');
        expect(walk.end).toBeGreaterThan(T + 1);
      }
      expectHonestDesk(state, at);
      for (const [index, walk] of walks.entries()) {
        const opens = scheduledDeskLanes(state).flatMap(lane => lane.duties!).filter(duty => duty.staffId === `clerk-${index}`);
        expect(Math.min(...opens.map(duty => duty.from))).toBeCloseTo(walk.end, 9);
      }
    });

    it(`seats a clerk beside a reception-trained housekeeper and serves the line (${switched})`, () => {
      STAFF_CLEANING_SUPPORT.enabled = cleaning;
      STAFF_FATIGUE.enabled = fatigue;
      const empty = lobby(15, true), T = hourStart(empty), lanes = physicalDeskLanes(empty), at = T + 0.3;
      expect(receptionSupports(empty)[0].support.lane).toBe(lanes[2].key);
      // Four guests in line at the second desk, all booked with the housekeeper.
      const helper = empty.staffRoster!.find(member => member.id === 'helper')!;
      const line = [0, 1, 2, 3].map(i => guest(`guest-${i}`, [
        makeStay(lanes[2].front, at - 0.05, T + 0.4 + 0.1 * i, 'wait', { lane: lanes[2].key, placeId: lanes[2].desk.id }),
        makeStay(lanes[2].front, T + 0.4 + 0.1 * i, T + 0.5 + 0.1 * i, 'check_in', { lane: lanes[2].key, placeId: lanes[2].desk.id, ...serviceSnapshot(helper) })]));
      let state = lobby(15, true, line);
      state = settleChanges(state, demolishFixture(state, lanes[0].desk.id)!, at);
      expectHonestDesk(state, at);
      // A clerk walks over to the free seat and the queue uses them.
      expect(getStaffPlan(state).itineraries.some(itinerary => itinerary.staffId.startsWith('clerk-')
        && seatedAt(state, itinerary.staffId, lanes[3].key, T + 0.9))).toBe(true);
      for (const queued of state.guests) {
        const service = queued.trip!.find((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'check_in')!;
        expect(service.start, `${queued.id} is put off`).toBeLessThan(T + 1);
        expect(seatedAt(state, service.serviceStaffId!, service.lane!, service.start), `${queued.id}'s clerk is away`).toBe(true);
      }
    });

    it(`keeps a clerk whose check-in it cut short in the queue at the other desk (${switched})`, () => {
      STAFF_CLEANING_SUPPORT.enabled = cleaning;
      STAFF_FATIGUE.enabled = fatigue;
      const empty = lobby(15, true, [], 1), T = hourStart(empty), lanes = physicalDeskLanes(empty), at = T + 0.1;
      // A check-in begun just before the hour, still underway at the demolition.
      const server = empty.staffRoster!.find(member => member.id === 'clerk-0')!;
      const service = makeStay(lanes[0].front, T - 0.05, T + 0.2, 'check_in', { lane: lanes[0].key, placeId: lanes[0].desk.id, ...serviceSnapshot(server) });
      let state = lobby(15, true, [guest('guest-served', [service])], 1);
      state = settleChanges(state, demolishFixture(state, lanes[0].desk.id)!, at);
      expect(state.guests[0].trip![0].end).toBe(at);
      expectHonestDesk(state, at);
      expect(seatedAt(state, 'clerk-0', lanes[3].key, T + 0.9)).toBe(true);
    });
  }
});
