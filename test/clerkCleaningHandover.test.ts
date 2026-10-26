import { afterEach, describe, expect, it } from 'vitest';
import { FRONT_DESK_STAFF, STAFF_CLEANING_SUPPORT, STAFF_CROSS_TRAINING, STAFF_FATIGUE, STAFF_PERSONALITIES } from '../src/config/staff.js';
import { addRoom, createStarterHotel } from '../src/simulation/HotelState.js';
import { deskCoverage, physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { getStaffPlan, plannedWork, replanStaff } from '../src/simulation/StaffManager.js';
import { cleaningSupports } from '../src/simulation/ClerkCleaning.js';
import { receptionSupports } from '../src/simulation/CrossTraining.js';
import { staffDutyAt } from '../src/simulation/StaffProfiles.js';
import { serviceSnapshot } from '../src/simulation/StaffHospitality.js';
import { dismissStaff, hireCandidate, hiringCandidates } from '../src/simulation/StaffHiring.js';
import { isEntranceTile } from '../src/simulation/Layout.js';
import { hash01, hourStart, makeStay, sameTile } from '../src/simulation/Movement.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { loadGame, saveGame } from '../src/simulation/SaveManager.js';
import { PRNG } from '../src/simulation/prng.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import type { CleaningSupport, Guest, HotelState, Leg, StaffMember, StayLeg } from '../src/simulation/types.js';

const switches = [STAFF_CLEANING_SUPPORT, STAFF_CROSS_TRAINING, STAFF_FATIGUE, STAFF_PERSONALITIES, FRONT_DESK_STAFF];
const enabled = switches.map(setting => setting.enabled), chance = STAFF_CLEANING_SUPPORT.candidateChance;
afterEach(() => {
  switches.forEach((setting, index) => { setting.enabled = enabled[index]; });
  STAFF_CLEANING_SUPPORT.candidateChance = chance;
  localStorage.clear();
});

const names: Record<string, string> = { 'late-a': 'Jordan Hale', 'late-b': 'Casey Moore', helper: 'Avery Park', cover: 'Robin Lee' };
function clerk(state: HotelState, id: string, shift: 'early' | 'late', seat?: number, trained = false): StaffMember {
  const lane = seat === undefined ? undefined : physicalDeskLanes(state)[seat];
  return { id, serial: 0, name: names[id], role: 'front_desk', shift, at: lane?.front ?? null, deskLane: lane?.key, dailyWage: trained ? 46 : 40,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal',
      hospitality: 'polite', ...(trained ? { cleaningTrained: true } : {}) },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: hourStart(state) } };
}

function reception(hour: number, roster: (base: HotelState) => StaffMember[]): HotelState {
  const base = addRoom({ ...createStarterHotel(), day: 2, hour, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
  const people = roster(base).map((member, index) => ({ ...member, serial: index + 1 }));
  return { ...base, frontDeskRosterReady: true, staffRoster: people, staffPlan: null,
    staff: { frontDesk: people.length, housekeepers: 0, maintenanceWorkers: 0 },
    rooms: base.rooms.map(room => ({ ...room, status: 'cleaning', cleaningHoursRemaining: 10,
      cleaningHoursTotal: 10, dailyCleanHoursRemaining: 0 })) };
}
/** 13:00: the trained early clerk can use the shift's last hour; two late clerks start at 14:00. */
function handover(): HotelState {
  return reception(13, base => [clerk(base, 'late-a', 'late'), clerk(base, 'late-b', 'late'),
    clerk(base, 'helper', 'early', 0, true), clerk(base, 'cover', 'early', 1)]);
}

function planned(state: HotelState): HotelState { return { ...state, staffPlan: getStaffPlan(state) }; }
function legs(state: HotelState, id = 'helper'): Leg[] { return getStaffPlan(state).itineraries.find(itinerary => itinerary.staffId === id)!.legs; }
function desks(state: HotelState, id: string): StayLeg[] {
  return legs(state, id).filter((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'desk');
}
function returnWalk(state: HotelState): Leg { return legs(state).filter(leg => leg.kind === 'walk').at(-1)!; }
function expectPhysicalCoverage(state: HotelState, from: number, to = hourStart(state) + 1): void {
  for (let t = from + 0.001; t < to; t += 0.025) {
    const physical = getStaffPlan(state).itineraries.filter(itinerary => itinerary.legs.some(leg =>
      leg.kind === 'stay' && leg.activity === 'desk' && leg.start <= t && leg.end > t)).map(itinerary => itinerary.staffId).sort();
    expect([...new Set(deskCoverage(state, t).map(duty => duty.staffId))].sort(), `coverage at ${t}`).toEqual(physical);
  }
}
function expectSeatedAllHour(state: HotelState, id: string, from: number): void {
  const T = hourStart(state), seated = desks(state, id).filter(leg => leg.end > from + 1e-9);
  expect(new Set(seated.map(leg => leg.lane)).size, `${id} keeps one seat`).toBe(1);
  for (let t = from + 0.001; t < T + 1; t += 0.025) expect(seated.some(leg => leg.start <= t && leg.end > t), `${id} seated at ${t}`).toBe(true);
}
/** The paused edit during the 13:xx walk back, then the 14:00 boundary. */
function editedReturn(): HotelState {
  let state = planned(handover());
  const back = returnWalk(state);
  state = replanStaff(state, (back.start + back.end) / 2);
  return tickSimulation(state, new PRNG(5)).state;
}

describe('A trained clerk’s last morning trip hands reception back at 14:00', () => {
  for (const fatigue of [true, false]) it(`finishes the walk back to the clerk’s own seat through a paused edit, within the hour and the shift with fatigue ${fatigue ? 'on' : 'off'}`, () => {
    STAFF_FATIGUE.enabled = fatigue;
    let state = planned(handover());
    const T = hourStart(state), seat = physicalDeskLanes(state)[0], original = legs(state), back = returnWalk(state);
    expect(back.end).toBeCloseTo(T + 1, 9); // the visit uses the whole last hour of the shift
    const work = plannedWork(state.staffPlan!, 'turnover').get(state.rooms[0].id)!;
    state = replanStaff(state, (back.start + back.end) / 2);
    const after = legs(state), last = after.at(-1)!;
    expect(last.kind === 'walk' && sameTile(last.path.at(-1), seat.front)).toBe(true);
    expect(last.end).toBeCloseTo(back.end, 9);
    expect(after.filter(leg => leg.end <= back.start + 1e-9)).toEqual(original.filter(leg => leg.end <= back.start + 1e-9));
    expect(plannedWork(state.staffPlan!, 'turnover').get(state.rooms[0].id)).toBeCloseTo(work, 10);
    const { member, support } = cleaningSupports(state).find(({ member }) => member.id === 'helper')!;
    expect(support.to).toBeLessThanOrEqual(T + 1);
    expect(support.to).toBeLessThanOrEqual(staffDutyAt(member, support.from).end);

    state = tickSimulation(state, new PRNG(5)).state;
    const helper = state.staffRoster!.find(member => member.id === 'helper')!;
    expect(helper.cleaningSupport).toBeUndefined();
    expect(helper.at && sameTile(helper.at, seat.front)).toBe(true);
    expect(cleaningSupports(state)).toHaveLength(0);
  });

  for (const fatigue of [true, false]) it(`keeps the late clerk who takes over the helper’s seat in the queue all hour, through a paused edit with fatigue ${fatigue ? 'on' : 'off'}`, () => {
    STAFF_FATIGUE.enabled = fatigue;
    let state = editedReturn();
    const T = hourStart(state), seat = physicalDeskLanes(state)[0];
    const owner = ['late-a', 'late-b'].find(id => desks(state, id).some(leg => leg.lane === seat.key))!;
    expect(owner).toBeDefined();
    for (const id of ['late-a', 'late-b']) expectSeatedAllHour(state, id, T);
    expectPhysicalCoverage(state, T);
    state = replanStaff(state, T + 0.33);
    for (const id of ['late-a', 'late-b']) expectSeatedAllHour(state, id, T + 0.33);
    expect(desks(state, owner).filter(leg => leg.end > T + 0.34).every(leg => leg.lane === seat.key)).toBe(true);
    expectPhysicalCoverage(state, T + 0.33);
  });

  it('never lets an off-duty clerk’s leftover visit from an older save hold a seat at 14:00', () => {
    let state = planned(handover());
    const T13 = hourStart(state), seat = physicalDeskLanes(state)[0], room = state.rooms[0].id;
    state = tickSimulation(state, new PRNG(5)).state;
    const T = hourStart(state);
    // Earlier versions could carry a recalled visit past the shift and this hour.
    const stale: CleaningSupport = { roomId: room, lane: seat.key, from: T13, to: T + 1.25, workUntil: T13 + 0.75 };
    state = { ...state, staffRoster: state.staffRoster!.map(member => member.id === 'helper' ? { ...member, cleaningSupport: stale } : member),
      staffPlan: { ...state.staffPlan!, itineraries: state.staffPlan!.itineraries.map(itinerary => itinerary.staffId === 'helper'
        ? { ...itinerary, end: { ...itinerary.end, cleaningSupport: stale } } : itinerary) } };
    expect(saveGame(state, new PRNG(41))).toBe(true);
    const loaded = loadGame()!.state;
    for (const id of ['late-a', 'late-b']) expectSeatedAllHour(loaded, id, T);
    expectPhysicalCoverage(loaded, T);
    const edited = replanStaff(loaded, T + 0.33);
    for (const id of ['late-a', 'late-b']) expectSeatedAllHour(edited, id, T + 0.33);
    expectPhysicalCoverage(edited, T + 0.33);
    expect(cleaningSupports(edited)).toHaveLength(0);
    const next = tickSimulation(loaded, new PRNG(6)).state;
    expect(next.staffRoster!.find(member => member.id === 'helper')!.cleaningSupport).toBeUndefined();
    expect(cleaningSupports(next)).toHaveLength(0);
  });

  it('keeps every late clerk seated when an idle reception-trained housekeeper is hired at 14:02', () => {
    let state = editedReturn();
    const T = hourStart(state), at = T + 0.02;
    const keeper: StaffMember = { id: 'keeper', serial: 9, name: 'Sam Rivera', role: 'housekeeper', at: null, dailyWage: 92, hiredAt: at,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', receptionTrained: true },
      stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: at } };
    // Nothing is left to clean, so the new housekeeper looks for a free seat.
    state = settleChanges(state, { ...state, staff: { ...state.staff, housekeepers: 1 }, staffRoster: [...state.staffRoster!, keeper],
      rooms: state.rooms.map(room => ({ ...room, status: 'vacant', cleaningHoursRemaining: 0, cleaningHoursTotal: undefined, dailyCleanHoursRemaining: 0 })) }, at);
    expect(state.staffRoster!.some(member => member.id === 'keeper')).toBe(true);
    const lateSeats = new Set(['late-a', 'late-b'].map(id => desks(state, id).at(-1)!.lane));
    for (const id of ['late-a', 'late-b']) expectSeatedAllHour(state, id, at);
    expect(lateSeats.size).toBe(2);
    expect(receptionSupports(state).some(({ support }) => lateSeats.has(support.lane))).toBe(false);
    const counter = getStaffPlan(state).itineraries.flatMap(itinerary => itinerary.legs.filter((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'desk'));
    for (const leg of counter) expect(counter.filter(other => other !== leg && other.lane === leg.lane
      && other.start < leg.end - 1e-9 && other.end > leg.start + 1e-9)).toHaveLength(0);
    expectPhysicalCoverage(state, at);
  });
});

describe('Switching clerk cleaning off keeps the earlier reception rules', () => {
  it('leaves a queued guest’s clerk and seat alone when maintenance is hired mid-hour', () => {
    STAFF_CLEANING_SUPPORT.enabled = false;
    let state = planned(reception(15, base => [clerk(base, 'late-a', 'late', 0), clerk(base, 'late-b', 'late', 1)]));
    const T = hourStart(state), lane = physicalDeskLanes(state)[1], server = state.staffRoster!.find(member => member.id === 'late-b')!;
    const queued: Guest = { id: 'queued', name: 'Morgan Diaz', budget: 200, stayLength: 3, trait: 'normal', satisfaction: 50,
      checkInDay: 2, isReturning: false, hadNoiseComplaint: false, tripKind: 'arrival', trip: [
        makeStay(lane.front, T, T + 0.5, 'wait', { lane: lane.key, placeId: lane.desk.id }),
        makeStay(lane.front, T + 0.5, T + 0.6, 'check_in', { lane: lane.key, placeId: lane.desk.id, ...serviceSnapshot(server) })] };
    state = { ...state, guests: [queued] };
    const after = settleChanges(state, { ...state, staff: { ...state.staff, maintenanceWorkers: 1 } }, T + 0.2);
    expect(after.staffRoster!.some(member => member.role === 'maintenance')).toBe(true);
    expect(after.guests.find(guest => guest.id === 'queued')!.trip).toEqual(queued.trip);
  });
});

describe('Seeded paused edits around trained clerks’ trips', () => {
  it('never leaves an on-shift clerk seated but unadvertised, advertised while away, or walking out', () => {
    STAFF_CLEANING_SUPPORT.candidateChance = 1;
    const problems: string[] = [];
    const seatedAt = (s: HotelState, id: string, t: number) => s.staffPlan!.itineraries.find(itinerary => itinerary.staffId === id)?.legs
      .some(leg => leg.kind === 'stay' && leg.activity === 'desk' && leg.start <= t + 1e-9 && leg.end > t + 1e-9) ?? false;
    const check = (s: HotelState, from: number, label: string) => {
      const T = hourStart(s);
      for (const { member, support } of cleaningSupports(s)) {
        if (support.to > T + 1 + 1e-9) problems.push(`${label}: ${member.id}'s visit runs past the hour`);
        if (support.to > staffDutyAt(member, support.from).end + 1e-9) problems.push(`${label}: ${member.id}'s visit runs past the shift`);
      }
      for (let t = from + 0.001; t < T + 1; t += 0.02) {
        const advertised = new Set(deskCoverage(s, t).map(duty => duty.staffId));
        for (const member of s.staffRoster ?? []) {
          if (member.role !== 'front_desk' || member.leaving) continue;
          const seated = seatedAt(s, member.id, t);
          if (seated !== advertised.has(member.id)) problems.push(`${label} +${(t - T).toFixed(3)}: ${member.id} ${seated ? 'seated but not in the queue' : 'in the queue while away'}`);
        }
      }
    };
    const walkouts = (s: HotelState, at: number, label: string) => {
      for (const member of s.staffRoster ?? []) {
        if (member.role !== 'front_desk' || member.leaving) continue;
        const duty = staffDutyAt(member, at);
        if (duty.absent || duty.available > at || duty.end <= hourStart(s) + 1 + 1e-9) continue;
        const out = s.staffPlan!.itineraries.find(itinerary => itinerary.staffId === member.id)!.legs.some(leg =>
          leg.kind === 'walk' && leg.end > at + 1e-9 && isEntranceTile(s, leg.path.at(-1)!));
        if (out) problems.push(`${label}: on-shift ${member.id} walks out`);
      }
    };
    let trips = 0, returning = 0;
    for (const seed of [3, 1]) {
      const prng = new PRNG(seed), strategy = STRATEGIES.balanced;
      let state = createStarterHotel();
      for (let x = 0; x < 8; x++) state = addRoom(state, 'standard', x, 2) ?? state;
      for (let tick = 0; tick < 20 * 24; tick++) {
        const next = strategy(state);
        state = planned(settleChanges(state, state.day >= 2 && next.staff.frontDesk < 6 ? { ...next, staff: { ...next.staff, frontDesk: 6 } } : next, hourStart(state)));
        const T = hourStart(state), label = `seed ${seed} day ${state.day} ${state.hour}:00`;
        check(state, T, label);
        if (state.hour === 14) {
          const edited = planned(replanStaff(state, T + 0.3));
          walkouts(edited, T + 0.3, `${label} edit at +0.30`); check(edited, T + 0.3, `${label} edit at +0.30`);
        }
        const away = cleaningSupports(state).find(({ support }) => support.to > T + 1e-9);
        if (away) {
          trips++;
          const back = state.staffPlan!.itineraries.find(itinerary => itinerary.staffId === away.member.id)!.legs.filter(leg => leg.kind === 'walk').at(-1);
          // In the last hour of the morning, edit while the helper walks back (about 13:50).
          const late = state.hour === 13 && !!back && back.start > T;
          const at = late ? back!.start + (back!.end - back!.start) * (0.2 + 0.6 * hash01(`${seed}|${tick}|back`)) : T + 0.05 + 0.9 * hash01(`${seed}|${tick}|at`);
          if (late) returning++;
          const roll = hash01(`${seed}|${tick}|edit`);
          const cover = (state.staffRoster ?? []).find(member => member.role === 'front_desk' && member.shift === 'early'
            && member.id !== away.member.id && !member.leaving && seatedAt(state, member.id, at));
          const candidate = roll >= 0.25 && roll < 0.5 ? hiringCandidates(state, 'front_desk', 'early')[0] : undefined;
          const changed = roll < 0.25 && cover ? dismissStaff(state, cover.id, at) : candidate ? hireCandidate(state, 'front_desk', candidate.id, 'early', at) : null;
          state = planned(changed ? settleChanges(state, changed, at) : replanStaff(state, at));
          walkouts(state, at, `${label} edit at +${(at - T).toFixed(2)}`); check(state, at, `${label} edit at +${(at - T).toFixed(2)}`);
          const again = Math.min(T + 0.999, at + 0.03);
          state = planned(replanStaff(state, again));
          walkouts(state, again, `${label} second edit`); check(state, again, `${label} second edit`);
        }
        state = tickSimulation(state, prng).state;
      }
    }
    expect(trips).toBeGreaterThan(20);
    expect(returning).toBeGreaterThan(3);
    expect(problems.slice(0, 10)).toEqual([]);
  }, 60000); // Forty seeded days with paused edits take over a second locally; leave room for the slower CI runner.
});
