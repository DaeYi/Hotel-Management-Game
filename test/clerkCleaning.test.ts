import { afterEach, describe, expect, it } from 'vitest';
import { FRONT_DESK_STAFF, STAFF_CLEANING_SUPPORT, STAFF_FATIGUE, STAFF_PERSONALITIES } from '../src/config/staff.js';
import { TRAVEL } from '../src/config/balance.js';
import { addRoom, createStarterHotel, demolishFixture, demolishRoom } from '../src/simulation/HotelState.js';
import { deskCoverage, physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { getStaffPlan, plannedWork, replanStaff, rosterAfter } from '../src/simulation/StaffManager.js';
import { cleaningSupports } from '../src/simulation/ClerkCleaning.js';
import { cleaningRate } from '../src/simulation/StaffProfiles.js';
import { processCleaningTick } from '../src/simulation/HousekeepingManager.js';
import { fatigueAt } from '../src/simulation/StaffFatigue.js';
import { dismissStaff } from '../src/simulation/StaffHiring.js';
import { hourStart, makeStay, sameTile } from '../src/simulation/Movement.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { loadGame, saveGame } from '../src/simulation/SaveManager.js';
import { PRNG } from '../src/simulation/prng.js';
import type { Guest, HotelState, StaffMember, StayLeg } from '../src/simulation/types.js';

const switches = [STAFF_CLEANING_SUPPORT, STAFF_FATIGUE, STAFF_PERSONALITIES, FRONT_DESK_STAFF];
const enabled = switches.map(setting => setting.enabled), pace = TRAVEL.hoursPerTile;
afterEach(() => {
  switches.forEach((setting, index) => { setting.enabled = enabled[index]; });
  TRAVEL.hoursPerTile = pace;
  localStorage.clear();
});

function hotel(hour = 11, remaining = 10): HotelState {
  const base = addRoom({ ...createStarterHotel(), day: 2, hour, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
  const people: StaffMember[] = physicalDeskLanes(base).map((lane, index) => ({
    id: index === 0 ? 'helper' : 'cover', serial: index + 1, name: index === 0 ? 'Avery Park' : 'Robin Lee',
    role: 'front_desk', shift: 'early', at: lane.front, deskLane: lane.key, dailyWage: index === 0 ? 46 : 40,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal',
      hospitality: 'polite', ...(index === 0 ? { cleaningTrained: true } : {}) },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: hourStart(base) },
  }));
  return { ...base, frontDeskRosterReady: true, staffRoster: people, staffPlan: null,
    staff: { frontDesk: people.length, housekeepers: 0, maintenanceWorkers: 0 },
    rooms: base.rooms.map(room => ({ ...room, status: 'cleaning', cleaningHoursRemaining: remaining,
      cleaningHoursTotal: remaining, dailyCleanHoursRemaining: 0 })) };
}

function changeMember(state: HotelState, id: string, change: (member: StaffMember) => StaffMember): HotelState {
  return { ...state, staffPlan: null, staffRoster: state.staffRoster!.map(member => member.id === id ? change(member) : member) };
}
function planned(state: HotelState): HotelState { return { ...state, staffPlan: getStaffPlan(state) }; }
function legs(state: HotelState, id = 'helper') { return getStaffPlan(state).itineraries.find(itinerary => itinerary.staffId === id)!.legs; }
function cleans(state: HotelState, id = 'helper'): StayLeg[] {
  return legs(state, id).filter((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'clean');
}
function actualWork(state: HotelState, id = 'helper'): number {
  const T = hourStart(state);
  return cleans(state, id).reduce((total, leg) => total + Math.max(0, Math.min(T + 1, leg.end) - Math.max(T, leg.start)), 0);
}
function expectPhysicalCoverage(state: HotelState, from: number, to = hourStart(state) + 1): void {
  for (let t = from + 0.001; t < to; t += 0.025) {
    const physical = getStaffPlan(state).itineraries.filter(itinerary => itinerary.legs.some(leg =>
      leg.kind === 'stay' && leg.activity === 'desk' && leg.start <= t && leg.end > t)).map(itinerary => itinerary.staffId).sort();
    expect([...new Set(deskCoverage(state, t).map(duty => duty.staffId))].sort(), `coverage at ${t}`).toEqual(physical);
  }
}

describe('A trained clerk helps only while reception stays covered', () => {
  it('walks to a vacant turnover, does real partial work, and returns to the desk within the hour', () => {
    const state = planned(hotel()), T = hourStart(state), plan = legs(state), clean = cleans(state)[0];
    expect(clean).toBeDefined();
    expect(clean.job).toBe('turnover');
    expect(clean.placeId).toBe(state.rooms[0].id);
    expect(clean.start).toBeGreaterThan(T);
    expect(actualWork(state)).toBeGreaterThanOrEqual(STAFF_CLEANING_SUPPORT.minWorkHours - 1e-9);
    expect(plan[0].kind).toBe('walk');
    const returnWalk = plan.find(leg => leg.kind === 'walk' && leg.start >= cleans(state).at(-1)!.end);
    expect(returnWalk).toBeDefined();
    expect(returnWalk!.end).toBeLessThanOrEqual(T + 1 + 1e-9);
    expect(returnWalk!.kind === 'walk' && sameTile(returnWalk!.path.at(-1), physicalDeskLanes(state)[0].front)).toBe(true);
    const remaining = processCleaningTick(state).state.rooms[0].cleaningHoursRemaining;
    expect(remaining).toBeLessThan(10);
    expect(remaining).toBeGreaterThan(0);
  });

  for (const fatigue of [true, false]) it(`advertises the helper only during actual counter stays with fatigue ${fatigue ? 'on' : 'off'}`, () => {
    STAFF_FATIGUE.enabled = fatigue;
    const state = planned(hotel()), T = hourStart(state);
    expect(cleans(state).length).toBeGreaterThan(0);
    for (let offset = 0.01; offset < 1; offset += 0.025) {
      const t = T + offset;
      const physical = state.staffPlan!.itineraries.filter(itinerary => itinerary.legs.some(leg =>
        leg.kind === 'stay' && leg.activity === 'desk' && leg.start <= t && leg.end > t)).map(itinerary => itinerary.staffId).sort();
      const promised = [...new Set(deskCoverage(state, t).map(duty => duty.staffId))].sort();
      expect(promised, `coverage at ${offset.toFixed(3)} hours`).toEqual(physical);
      expect(promised).toContain('cover');
    }
  });

  it('keeps the sole native clerk at reception and cannot use a housekeeper as the required native cover', () => {
    const state = hotel(), helper = state.staffRoster![0];
    const alone = { ...state, staff: { ...state.staff, frontDesk: 1 }, staffRoster: [helper] };
    expect(cleans(alone)).toHaveLength(0);
    const keeper: StaffMember = { ...state.staffRoster![1], role: 'housekeeper', profile: { ...helper.profile!, receptionTrained: true } };
    expect(cleans({ ...alone, staff: { ...alone.staff, housekeepers: 1 }, staffRoster: [helper, keeper] })).toHaveLength(0);
  });

  it('does not send both trained clerks away at the same time', () => {
    let state = hotel();
    state = addRoom(state, 'standard', 6, 2, 0, 'up')!;
    state = { ...state, rooms: state.rooms.map(room => ({ ...room, status: 'cleaning', cleaningHoursRemaining: 10 })) };
    state = planned(changeMember(state, 'cover', member => ({ ...member, profile: { ...member.profile!, cleaningTrained: true } })));
    const T = hourStart(state);
    expect(state.staffPlan!.itineraries.flatMap(itinerary => itinerary.legs).some(leg => leg.kind === 'stay' && leg.job === 'turnover')).toBe(true);
    for (let offset = 0.01; offset < 1; offset += 0.025) expect(deskCoverage(state, T + offset).length).toBeGreaterThanOrEqual(1);
  });

  it('requires cover through the return trip, including the covering clerk’s compulsory break', () => {
    const state = changeMember(hotel(), 'cover', member => ({ ...member, stats: { ...member.stats!, fatigue: 84 } }));
    expect(cleans(state)).toHaveLength(0);
  });

  it('shortens a useful cleaning visit so the helper returns before the covering clerk takes a break', () => {
    const state = planned(changeMember(hotel(), 'cover', member => ({ ...member, stats: { ...member.stats!, fatigue: 81 } })));
    const T = hourStart(state), support = cleaningSupports(state).find(({ member }) => member.id === 'helper')!.support;
    expect(actualWork(state)).toBeGreaterThanOrEqual(STAFF_CLEANING_SUPPORT.minWorkHours);
    expect(support.to).toBeCloseTo(T + 0.8, 10);
    expect(deskCoverage(state, T + 0.81).map(duty => duty.staffId)).toEqual(['helper']);
    expectPhysicalCoverage(state, T);
  });

  it('does not start a trip with too little energy for useful work and the walk back', () => {
    const state = changeMember(hotel(), 'helper', member => ({ ...member, stats: { ...member.stats!, fatigue: 84 } }));
    expect(cleans(state)).toHaveLength(0);
  });

  it('stays in the 07:00–14:00 window and returns before the early shift ends', () => {
    expect(cleans(hotel(6))).toHaveLength(0);
    // Early clerks are off duty at 14:00. Trained clerks moved to the late
    // shift are at reception then, so only the window keeps them there.
    const late = hotel(14);
    expect(cleans({ ...late, staffRoster: late.staffRoster!.map(member => ({ ...member, shift: 'late' as const })) })).toHaveLength(0);
    const state = planned(hotel(13)), T = hourStart(state);
    expect(cleans(state).length).toBeGreaterThan(0);
    expect(legs(state).every(leg => leg.end <= T + 1 + 1e-9)).toBe(true);
    expect(cleans(state).every(leg => leg.end < T + 1)).toBe(true);
  });

  it('leaves daily cleans, repairs, untrained profiles, and overly distant rooms alone', () => {
    const state = hotel();
    // The same room is close enough for a trip while it awaits a turnover.
    expect(cleans({ ...state }).map(leg => leg.placeId)).toContain(state.rooms[0].id);
    const daily: HotelState = { ...state, rooms: state.rooms.map(room => ({ ...room, status: 'occupied', dailyCleanHoursRemaining: 2, cleaningHoursRemaining: 0 })) };
    const repair: HotelState = { ...state, rooms: state.rooms.map(room => ({ ...room, status: 'vacant', condition: 5, cleaningHoursRemaining: 0 })) };
    // That work is real: a housekeeper or maintenance worker would take it.
    const worker = (other: HotelState, role: 'housekeeper' | 'maintenance'): HotelState => ({ ...other,
      staff: { ...other.staff, [role === 'housekeeper' ? 'housekeepers' : 'maintenanceWorkers']: 1 },
      staffRoster: [...other.staffRoster!, { ...other.staffRoster![1], id: 'worker', role }] });
    expect(legs(worker(daily, 'housekeeper'), 'worker').some(leg => leg.kind === 'stay' && leg.job === 'daily')).toBe(true);
    expect(legs(worker(repair, 'maintenance'), 'worker').some(leg => leg.kind === 'stay' && leg.job === 'repair')).toBe(true);
    // Without those workers, the clerk spends the whole hour at reception.
    for (const other of [daily, repair]) expect(legs(other).every(leg => leg.kind === 'stay' && leg.activity === 'desk')).toBe(true);
    expect(cleans(changeMember(state, 'helper', member => ({ ...member, profile: { ...member.profile!, cleaningTrained: undefined } })))).toHaveLength(0);
    TRAVEL.hoursPerTile = 0.5;
    expect(cleans(state)).toHaveLength(0);
  });

  it('preserves a check-in already underway before considering cleaning', () => {
    let state = hotel(), T = hourStart(state), lane = physicalDeskLanes(state)[0];
    const service = makeStay(lane.front, T - 0.1, T + 0.4, 'check_in', { lane: lane.key, placeId: lane.desk.id, serviceStaffId: 'helper' });
    const guest: Guest = { id: 'arriving', name: 'Arriving', budget: 200, stayLength: 3, trait: 'normal', satisfaction: 50,
      checkInDay: 2, isReturning: false, hadNoiseComplaint: false, trip: [service], tripKind: 'arrival' };
    state = planned({ ...state, guests: [guest] });
    expect(cleans(state).every(leg => leg.start >= service.end)).toBe(true);
    for (const t of [T + 0.01, T + 0.2, T + 0.39]) expect(deskCoverage(state, t).some(duty => duty.staffId === 'helper')).toBe(true);
  });
});

describe('Clerk room work preserves progress, identity, and elapsed time', () => {
  it('respects a housekeeper’s existing room claim', () => {
    const state = hotel(), room = state.rooms[0];
    const keeper: StaffMember = { ...state.staffRoster![1], id: 'keeper', role: 'housekeeper', at: { ...room }, roomId: room.id };
    const shared = planned({ ...state, staff: { ...state.staff, housekeepers: 1 }, staffRoster: [...state.staffRoster!, keeper] });
    expect(cleans(shared, 'keeper').length).toBeGreaterThan(0);
    expect(cleans(shared)).toHaveLength(0);
  });

  it('uses cleaning skill independently of hospitality, credits actual work once, and preserves role and wage', () => {
    const base = hotel();
    const warm = planned(changeMember(base, 'helper', member => ({ ...member, profile: { ...member.profile!, hospitality: 'warm' } })));
    const curt = planned(changeMember(base, 'helper', member => ({ ...member, profile: { ...member.profile!, hospitality: 'curt' } })));
    expect(cleaningRate(warm.staffRoster![0])).toBe(cleaningRate(curt.staffRoster![0]));
    expect(cleans(warm)).toEqual(cleans(curt));
    const work = actualWork(warm), after = rosterAfter(warm, warm.staffPlan!).find(member => member.id === 'helper')!;
    expect(work).toBeGreaterThan(0);
    expect(after.stats!.workHours).toBeCloseTo(80 + work, 10);
    expect(after.role).toBe('front_desk');
    expect(after.dailyWage).toBe(warm.staffRoster![0].dailyWage);
    expect(after.stats!.fatigue).toBeCloseTo(fatigueAt(warm, warm.staffRoster![0], hourStart(warm) + 1), 10);
    const credited = plannedWork(warm.staffPlan!, 'turnover').get(warm.rooms[0].id)!;
    expect(processCleaningTick(warm).state.rooms[0].cleaningHoursRemaining).toBeCloseTo(10 - credited, 10);
  });

  it('attributes a finished turnover to the actual clerk', () => {
    const state = planned(hotel(11, 0.3));
    expect(cleans(state).length).toBeGreaterThan(0);
    const room = processCleaningTick(state).state.rooms[0];
    expect(room.status).toBe('vacant');
    expect(room.cleanedBy).toMatchObject({ id: 'helper', name: 'Avery Park' });
  });

  it('resumes ordinary reception after the completed trip at the next hour boundary', () => {
    const state = planned(hotel(11, 0.3)), plan = state.staffPlan!, T = hourStart(state);
    const next = planned({ ...processCleaningTick(state).state, hour: state.hour + 1,
      staffRoster: rosterAfter(state, plan), staffPlan: null });
    expect(cleans(next)).toHaveLength(0);
    expect(next.staffRoster!.find(member => member.id === 'helper')!.role).toBe('front_desk');
    expect(deskCoverage(next, T + 1.01).map(duty => duty.staffId).sort()).toEqual(['cover', 'helper']);
  });

  it('clears the completed commitment at the next hour and permits a fresh trip for remaining work', () => {
    const state = planned(hotel()), T = hourStart(state), first = cleaningSupports(state)[0].support;
    const roster = rosterAfter(state, state.staffPlan!);
    expect(roster.find(member => member.id === 'helper')!.cleaningSupport).toBeUndefined();
    let next: HotelState = { ...processCleaningTick(state).state, hour: state.hour + 1,
      staffRoster: roster, staffPlan: null };
    expect(cleaningSupports(next)).toHaveLength(0);
    next = planned(next);
    const second = cleaningSupports(next).find(({ member }) => member.id === 'helper')!.support;
    expect(second.from).toBeCloseTo(T + 1, 10);
    expect(second.from).toBeGreaterThanOrEqual(first.to - 1e-9);
    expect(second.to).toBeGreaterThan(first.to);
    expect(actualWork(next)).toBeGreaterThan(0);
    expect(processCleaningTick(next).state.rooms[0].cleaningHoursRemaining).toBeLessThan(next.rooms[0].cleaningHoursRemaining);
  });

  it('keeps the original deadline and work through repeated paused replans and reload', () => {
    let state = planned(hotel()), original = cleaningSupports(state).find(({ member }) => member.id === 'helper')!.support;
    const clean = cleans(state)[0], T = hourStart(state), work = plannedWork(state.staffPlan!, 'turnover').get(state.rooms[0].id)!;
    const fatigue = fatigueAt(state, state.staffRoster![0], T + 1);
    state = replanStaff(state, clean.start + 0.025);
    expect(saveGame(state, new PRNG(31))).toBe(true);
    state = loadGame()!.state;
    state = replanStaff(state, clean.start + 0.05);
    const kept = cleaningSupports(state).find(({ member }) => member.id === 'helper')!.support;
    expect(kept.to).toBeCloseTo(original.to, 10);
    expect(kept.workUntil).toBeCloseTo(original.workUntil, 10);
    expect(plannedWork(state.staffPlan!, 'turnover').get(state.rooms[0].id)).toBeCloseTo(work, 10);
    expect(fatigueAt(state, state.staffRoster![0], T + 1)).toBeCloseTo(fatigue, 10);
  });

  it('preserves an approach already begun when saving and replanning', () => {
    let state = planned(hotel()), original = legs(state)[0], T = hourStart(state);
    expect(original.kind).toBe('walk');
    const at = (original.start + original.end) / 2;
    state = replanStaff(state, at);
    expect(saveGame(state, new PRNG(37))).toBe(true);
    state = replanStaff(loadGame()!.state, at + 0.001);
    expect(legs(state)[0].start).toBe(T);
    expect(cleans(state)[0].start).toBeCloseTo(original.end, 10);
    expect(deskCoverage(state, at).some(duty => duty.staffId === 'helper')).toBe(false);
    expect(actualWork(state)).toBeGreaterThan(0);
  });

  it('does not mistake a future compulsory break for the current cleaning approach during a paused replan', () => {
    let state = planned(changeMember(hotel(), 'helper', member => ({ ...member, stats: { ...member.stats!, fatigue: 81 } })));
    const T = hourStart(state), before = cleans(state), support = cleaningSupports(state)[0].support;
    const work = plannedWork(state.staffPlan!, 'turnover').get(state.rooms[0].id)!;
    const fatigue = fatigueAt(state, state.staffRoster![0], T + 1);
    expect(before.length).toBeGreaterThan(0);
    expect(legs(state).some(leg => leg.kind === 'stay' && leg.activity === 'rest' && leg.start >= support.to - 1e-9)).toBe(true);
    state = replanStaff(state, T + 0.01);
    const after = cleans(state), kept = cleaningSupports(state).find(({ member }) => member.id === 'helper')!.support;
    expect(after).toHaveLength(before.length);
    after.forEach((leg, index) => {
      expect(leg.start).toBeCloseTo(before[index].start, 10);
      expect(leg.end).toBeCloseTo(before[index].end, 10);
    });
    expect(kept.to).toBeCloseTo(support.to, 10);
    expect(kept.workUntil).toBeCloseTo(support.workUntil, 10);
    expect(plannedWork(state.staffPlan!, 'turnover').get(state.rooms[0].id)).toBeCloseTo(work, 10);
    expect(fatigueAt(state, state.staffRoster![0], T + 1)).toBeCloseTo(fatigue, 10);
  });

  it('preserves the fixed break after a short completed room through return, counter, and rest replans', () => {
    let state = planned(changeMember(hotel(11, 0.05), 'helper', member => ({ ...member, stats: { ...member.stats!, fatigue: 81 } })));
    const T = hourStart(state), work = plannedWork(state.staffPlan!, 'turnover').get(state.rooms[0].id)!;
    const fatigue = fatigueAt(state, state.staffRoster![0], T + 1);
    const breakEnd = state.staffPlan!.itineraries.find(itinerary => itinerary.staffId === 'helper')!.end.fatigueBreak!.end;
    expect(work).toBeCloseTo(0.05, 10);
    expect(breakEnd).toBeCloseTo(T + 1.3, 10);
    for (const offset of [0.4, 0.55, 0.8, 0.95]) {
      state = replanStaff(state, T + offset);
      expect(plannedWork(state.staffPlan!, 'turnover').get(state.rooms[0].id)).toBeCloseTo(work, 10);
      expect(fatigueAt(state, state.staffRoster![0], T + 1)).toBeCloseTo(fatigue, 10);
      expect(state.staffPlan!.itineraries.find(itinerary => itinerary.staffId === 'helper')!.end.fatigueBreak!.end).toBeCloseTo(breakEnd, 10);
    }
    const roster = rosterAfter(state, state.staffPlan!);
    expect(roster.find(member => member.id === 'helper')!.fatigueBreak!.end).toBeCloseTo(breakEnd, 10);
    const next = planned({ ...processCleaningTick(state).state, hour: state.hour + 1, staffRoster: roster, staffPlan: null });
    expect(deskCoverage(next, T + 1.1).some(duty => duty.staffId === 'helper')).toBe(false);
    expect(deskCoverage(next, breakEnd + 0.001).some(duty => duty.staffId === 'helper')).toBe(true);
  });

  it('keeps the tired-threshold rate and credited cleaning through a paused edit', () => {
    let state = planned(changeMember(hotel(), 'helper', member => ({ ...member, stats: { ...member.stats!, fatigue: 58 } })));
    const T = hourStart(state), before = cleans(state), work = plannedWork(state.staffPlan!, 'turnover').get(state.rooms[0].id)!;
    expect(before.some(leg => leg.workRate === 1)).toBe(true);
    expect(before.some(leg => leg.workRate === STAFF_FATIGUE.tiredRate)).toBe(true);
    const tired = before.find(leg => leg.workRate === STAFF_FATIGUE.tiredRate)!;
    expect(tired.start).toBeCloseTo(T + (STAFF_FATIGUE.tiredAt - 58) / STAFF_FATIGUE.gain.normal, 10);
    state = replanStaff(state, tired.start + 0.01);
    expect(plannedWork(state.staffPlan!, 'turnover').get(state.rooms[0].id)).toBeCloseTo(work, 10);
    expect(cleans(state).filter(leg => leg.start >= tired.start).every(leg => leg.workRate === STAFF_FATIGUE.tiredRate)).toBe(true);
  });

  it('keeps the returning clerk’s seat reserved when an unplanned clerk is hired mid-trip', () => {
    let state = planned(hotel()), support = cleaningSupports(state)[0].support, at = cleans(state)[0].start + 0.05;
    state = { ...state, staffRoster: state.staffRoster!.map(member => member.id === 'helper' ? { ...member, deskLane: undefined } : member) };
    const hire: StaffMember = { ...state.staffRoster![1], id: 'new-clerk', serial: 0, name: 'New Clerk', at: null,
      deskLane: undefined, hiredAt: at, stats: { ...state.staffRoster![1].stats!, fatigueAt: at } };
    state = settleChanges(state, { ...state, staff: { ...state.staff, frontDesk: 3 }, staffRoster: [...state.staffRoster!, hire] }, at);
    const kept = cleaningSupports(state).find(({ member }) => member.id === 'helper')!.support;
    expect(kept.lane).toBe(support.lane);
    expect(kept.to).toBeCloseTo(support.to, 10);
    const native = state.staffPlan!.itineraries.flatMap(itinerary => itinerary.legs.filter((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'desk'));
    for (const desk of native) expect(native.filter(other => other !== desk && other.lane === desk.lane && other.start < desk.end - 1e-9 && other.end > desk.start + 1e-9)).toHaveLength(0);
    expect(legs(state, 'new-clerk').filter(leg => leg.kind === 'stay' && leg.activity === 'desk' && leg.lane === support.lane && leg.start < support.to)).toHaveLength(0);
  });

  it('stops future cleaning on dismissal while retaining elapsed work', () => {
    let state = planned(hotel()), clean = cleans(state)[0], at = clean.start + 0.05;
    state = settleChanges(state, dismissStaff(state, 'helper', at)!, at);
    expect(cleans(state).length).toBeGreaterThan(0);
    expect(cleans(state).every(leg => leg.end <= at + 1e-9)).toBe(true);
    expect(actualWork(state)).toBeCloseTo(0.05, 10);
    expect(deskCoverage(state, at + 0.1).some(duty => duty.staffId === 'helper')).toBe(false);
  });

  it('recalls a helper when the covering clerk leaves, with no desk promise before the physical return', () => {
    let state = planned(hotel()), clean = cleans(state)[0], at = clean.start + 0.05;
    state = settleChanges(state, dismissStaff(state, 'cover', at)!, at);
    expect(cleans(state).every(leg => leg.end <= at + 1e-9)).toBe(true);
    expect(actualWork(state)).toBeCloseTo(0.05, 10);
    const returned = legs(state).find((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'desk' && leg.start >= at)!;
    expect(returned).toBeDefined();
    expect(returned.start).toBeGreaterThan(at);
    expect(deskCoverage(state, at + (returned.start - at) / 2).some(duty => duty.staffId === 'helper')).toBe(false);
    expect(deskCoverage(state, returned.start + 0.001).map(duty => duty.staffId)).toEqual(['helper']);
  });

  it('removes a demolished room from future work without erasing the elapsed approach', () => {
    let state = planned(hotel()), first = legs(state)[0], at = (first.start + first.end) / 2;
    state = settleChanges(state, demolishRoom(state, state.rooms[0].id)!, at);
    expect(cleans(state)).toHaveLength(0);
    expect(legs(state)[0].start).toBe(first.start);
  });

  it('does not advertise a return to a demolished reception desk', () => {
    let state = planned(hotel()), clean = cleans(state)[0], lane = physicalDeskLanes(state)[0], at = clean.start + 0.05;
    state = settleChanges(state, demolishFixture(state, lane.desk.id)!, at);
    expect(deskCoverage(state, at + 0.1)).toHaveLength(0);
    expect(legs(state).some(leg => leg.kind === 'stay' && leg.activity === 'desk' && leg.end > at)).toBe(false);
  });

  for (const fatigue of [true, false]) it(`routes clerks to another desk after demolition without phantom coverage with fatigue ${fatigue ? 'on' : 'off'}`, () => {
    STAFF_FATIGUE.enabled = fatigue;
    let state = hotel();
    state = planned({ ...state, fixtures: [...state.fixtures, { id: 'desk-alternate', type: 'desk', gridX: 7, gridY: 0, floor: 0 }] });
    const clean = cleans(state)[0], at = clean.start + 0.05, removedDesk = physicalDeskLanes(state)[0].desk.id;
    state = settleChanges(state, demolishFixture(state, removedDesk)!, at);
    const returned = legs(state).find((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'desk' && leg.start >= at)!;
    expect(returned).toBeDefined();
    expect(returned.placeId).toBe('desk-alternate');
    expect(returned.start).toBeGreaterThan(at);
    expect(deskCoverage(state, returned.start + 0.001).some(duty => duty.staffId === 'helper')).toBe(true);
    expectPhysicalCoverage(state, at);
  });

  for (const fatigue of [true, false]) it(`keeps a clerk with a blocked return route out of reception coverage with fatigue ${fatigue ? 'on' : 'off'}`, () => {
    STAFF_FATIGUE.enabled = fatigue;
    let state = planned(hotel()), clean = cleans(state)[0], at = clean.start + 0.05;
    const changed = addRoom(state, 'standard', 5, 1, 0, 'up');
    expect(changed).not.toBeNull();
    state = settleChanges(state, changed!, at);
    expect(cleans(state).every(leg => leg.end <= at + 1e-9)).toBe(true);
    expect(legs(state).some(leg => leg.kind === 'stay' && leg.activity === 'desk' && leg.end > at)).toBe(false);
    expect(deskCoverage(state, hourStart(state) + 0.99).some(duty => duty.staffId === 'helper')).toBe(false);
    expectPhysicalCoverage(state, at);
  });

  it('turning off the new slice keeps a trained clerk on an untrained clerk’s reception plan', () => {
    const state = hotel(), T = hourStart(state);
    // With the slice on, this hotel sends the trained clerk to the turnover.
    expect(cleans({ ...state }).length).toBeGreaterThan(0);
    STAFF_CLEANING_SUPPORT.enabled = false;
    const off = planned({ ...state });
    expect(off.staffPlan).toEqual(getStaffPlan(changeMember(state, 'helper', member => ({ ...member, profile: { ...member.profile!, cleaningTrained: undefined } }))));
    expect(legs(off).every(leg => leg.kind === 'stay' && leg.activity === 'desk')).toBe(true);
    expect(cleaningSupports(off)).toHaveLength(0);
    expect(processCleaningTick(off).state.rooms[0].cleaningHoursRemaining).toBe(10);
    expectPhysicalCoverage(off, T);
  });

  for (const fatigue of [true, false]) it(`turning off the new slice during a trip keeps elapsed work and never promises the desk before the clerk is back with fatigue ${fatigue ? 'on' : 'off'}`, () => {
    STAFF_FATIGUE.enabled = fatigue;
    const trip = planned(hotel()), at = cleans(trip)[0].start + 0.05;
    STAFF_CLEANING_SUPPORT.enabled = false;
    // A paused replan sends the clerk straight back to reception.
    const state = replanStaff(trip, at);
    expect(cleans(state).every(leg => leg.end <= at + 1e-9)).toBe(true);
    expect(actualWork(state)).toBeCloseTo(0.05, 10);
    const returned = legs(state).find((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'desk' && leg.start >= at)!;
    expect(returned).toBeDefined();
    expect(returned.start).toBeGreaterThan(at);
    expect(deskCoverage(state, (at + returned.start) / 2).some(duty => duty.staffId === 'helper')).toBe(false);
    expect(deskCoverage(state, returned.start + 0.001).some(duty => duty.staffId === 'helper')).toBe(true);
    expectPhysicalCoverage(state, at);
    const next = planned({ ...processCleaningTick(state).state, hour: state.hour + 1,
      staffRoster: rosterAfter(state, state.staffPlan!), staffPlan: null });
    expect(cleans(next)).toHaveLength(0);
    expect(cleaningSupports(next)).toHaveLength(0);
    // With the way back blocked, the clerk stays out of reception coverage.
    const blocked = settleChanges(trip, addRoom(trip, 'standard', 5, 1, 0, 'up')!, at);
    expect(cleans(blocked).every(leg => leg.end <= at + 1e-9)).toBe(true);
    expect(actualWork(blocked)).toBeCloseTo(0.05, 10);
    expect(legs(blocked).some(leg => leg.kind === 'stay' && leg.activity === 'desk' && leg.end > at)).toBe(false);
    expectPhysicalCoverage(blocked, at);
  });
});
