import { afterEach, describe, expect, it } from 'vitest';
import { FRONT_DESK_STAFF, STAFF_CROSS_TRAINING, STAFF_FATIGUE, STAFF_HOSPITALITY, STAFF_PERSONALITIES, STAFF_SPECIALTIES } from '../src/config/staff.js';
import { STAFF, TRAVEL, VOICE } from '../src/config/balance.js';
import { addElevator, addRoom, buildFloor, createStarterHotel, demolishFixture } from '../src/simulation/HotelState.js';
import { receptionSupports } from '../src/simulation/CrossTraining.js';
import { deskCoverage, physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { creditCheckIns, lanesOf, quoteLane, reseatLanes } from '../src/simulation/DeskQueue.js';
import { attendance, receptionTrained } from '../src/simulation/StaffProfiles.js';
import { getStaffPlan, prepareReceptionSupport, replanStaff, rosterAfter } from '../src/simulation/StaffManager.js';
import { fatigueAt, projectFatigue } from '../src/simulation/StaffFatigue.js';
import { serviceSnapshot } from '../src/simulation/StaffHospitality.js';
import { hearComplaints } from '../src/simulation/Complaints.js';
import { dismissStaff } from '../src/simulation/StaffHiring.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { findRoute } from '../src/simulation/Layout.js';
import { hourStart, makeStay, makeWalk } from '../src/simulation/Movement.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { loadGame, saveGame } from '../src/simulation/SaveManager.js';
import { PRNG } from '../src/simulation/prng.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import type { Guest, HotelState, StaffMember, StaffPlan, StayLeg } from '../src/simulation/types.js';

const switches = [STAFF_CROSS_TRAINING, STAFF_PERSONALITIES, FRONT_DESK_STAFF, STAFF_FATIGUE, STAFF_HOSPITALITY, STAFF_SPECIALTIES];
const originalSwitches = switches.map(setting => setting.enabled);
const originalPace = TRAVEL.hoursPerTile;
afterEach(() => { switches.forEach((setting, index) => { setting.enabled = originalSwitches[index]; }); TRAVEL.hoursPerTile = originalPace; localStorage.clear(); });

function keeper(id = 'keeper', extra: Partial<StaffMember> = {}): StaffMember {
  return { id, name: 'Avery Park', serial: 1, role: 'housekeeper', dailyWage: 80.5,
    at: { gridX: 5, gridY: 1, floor: 0 },
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', receptionTrained: true },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: 38 }, ...extra };
}
function hotel(people = [keeper()], hour = 14): HotelState {
  const state = addRoom({ ...createStarterHotel(), day: 2, hour, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
  return { ...state, frontDeskRosterReady: true, staffRoster: people, staffPlan: null,
    staff: { frontDesk: people.filter(member => member.role === 'front_desk' && !member.leaving).length,
      housekeepers: people.filter(member => member.role === 'housekeeper' && !member.leaving).length,
      maintenanceWorkers: people.filter(member => member.role === 'maintenance' && !member.leaving).length } };
}
function planned(state: HotelState): HotelState { return { ...state, staffPlan: getStaffPlan(state) }; }
function desks(state: HotelState, id = 'keeper'): StayLeg[] {
  return getStaffPlan(state).itineraries.find(itinerary => itinerary.staffId === id)!.legs
    .filter((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'desk');
}
function guest(id: string, trip: Guest['trip'] = null): Guest {
  return { id, name: id, budget: 200, stayLength: 3, trait: 'normal', satisfaction: 50,
    checkInDay: 2, isReturning: false, hadNoiseComplaint: false, trip, tripKind: 'arrival' };
}
function clerk(state: HotelState, id: string, seat: number, extra: Partial<StaffMember> = {}): StaffMember {
  const lane = physicalDeskLanes(state)[seat];
  return { ...keeper(id), role: 'front_desk', shift: 'late', at: lane.front, deskLane: lane.key,
    dailyWage: 40, profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal' }, ...extra };
}
function cleaning(state: HotelState, hours = 10): HotelState {
  return { ...state, rooms: state.rooms.map(room => ({ ...room, status: 'cleaning', cleaningHoursRemaining: hours })) };
}
function advance(state: HotelState): HotelState {
  const plan = getStaffPlan(state);
  return { ...state, hour: state.hour + 1, staffRoster: rosterAfter(state, plan), staffPlan: null };
}

describe('Reception support follows the housekeeper’s actual itinerary', () => {
  it('uses a real afternoon walk and a bounded counter block after home work is caught up', () => {
    expect(desks(hotel([keeper()], 13))).toHaveLength(0);
    const state = planned(hotel()), T = hourStart(state), itinerary = state.staffPlan!.itineraries[0];
    const counter = desks(state)[0], support = receptionSupports(state)[0].support;
    const lane = physicalDeskLanes(state).find(lane => lane.key === support.lane)!;
    expect(itinerary.legs[0].kind).toBe('walk');
    expect(counter.start).toBeCloseTo(T + findRoute(state, keeper().at!, lane.front)!.hours, 10);
    expect(counter.end - counter.start).toBeCloseTo(1, 10);
    expect(counter).toMatchObject({ lane: lane.key, placeId: lane.desk.id, at: lane.front });
    expect(support).toMatchObject({ lane: lane.key, from: counter.start, to: counter.end });
    expect(counter.start).toBeGreaterThan(T);
  });

  it('gives eligible cleaning priority and permits support only after that real work finishes', () => {
    const busy = cleaning(hotel());
    expect(desks(busy)).toHaveLength(0);
    const state = planned(cleaning(hotel(), 0.2)), itinerary = state.staffPlan!.itineraries[0];
    const clean = itinerary.legs.find((leg): leg is StayLeg => leg.kind === 'stay' && leg.job === 'turnover')!;
    expect(clean).toBeDefined();
    expect(desks(state)[0].start).toBeGreaterThan(clean.end);
  });

  it('waits for a same-hour DND opening, but can support reception when that party will stay home', () => {
    const state = hotel(), room = state.rooms[0], at = roomTile(room), hall = { ...at, gridY: 1 }, T = hourStart(state);
    const person = { ...guest('dnd'), profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', favorite: 'none', housekeeping: 'dnd' } as Guest['profile'] };
    const occupied: HotelState = { ...state, guests: [person], rooms: [{ ...room, status: 'occupied', guestId: person.id, dailyCleanHoursRemaining: 0.2 }] };
    expect(desks(occupied)).toHaveLength(1);
    const goingOut: HotelState = { ...occupied, guests: [{ ...person, tripKind: 'outing', trip: [
      makeStay(at, T - 1, T + 0.2, 'in_room'), makeWalk([at, hall], T + 0.2, TRAVEL.guestHoursPerTile),
      makeStay(hall, T + 0.2 + TRAVEL.guestHoursPerTile, T + 2, 'away'),
    ] }] };
    const plan = getStaffPlan(goingOut), clean = plan.itineraries[0].legs.find((leg): leg is StayLeg => leg.kind === 'stay' && leg.job === 'daily')!;
    expect(clean).toBeDefined();
    expect(clean.start).toBeGreaterThan(T + 0.2);
    expect(desks({ ...goingOut, staffPlan: plan }).every(leg => leg.start >= clean.end)).toBe(true);
  });

  it('keeps primary seats reserved and never assigns two helpers to the same simultaneous seat', () => {
    const base = hotel(), native = hotel([keeper(), clerk(base, 'first', 0), clerk(base, 'second', 1)]);
    expect(desks(native)).toHaveLength(0);
    const helpers = planned(hotel([keeper('a'), keeper('b'), keeper('c')]));
    const support = receptionSupports(helpers);
    expect(support).toHaveLength(2);
    expect(new Set(support.map(({ support }) => support.lane)).size).toBe(2);
    const all = helpers.staffPlan!.itineraries.flatMap(itinerary => itinerary.legs.filter((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'desk'));
    for (const leg of all) expect(all.filter(other => other !== leg && other.lane === leg.lane && other.start < leg.end && other.end > leg.start)).toHaveLength(0);
  });

  it('keeps both native clerks before a future helper uses only one clerk’s break window', () => {
    const base = hotel(), T = hourStart(base), room = base.rooms[0];
    const first = clerk(base, 'first', 0, { stats: { ...keeper().stats!, fatigue: 82.5, fatigueAt: T } });
    let state = cleaning(hotel([keeper('keeper', { at: roomTile(room) }), first, clerk(base, 'second', 1)]), 0.26);
    state = planned(state);
    const support = receptionSupports(state).find(({ member }) => member.id === 'keeper')!.support;
    expect(support.from).toBeCloseTo(T + 0.5, 10);
    expect(support.to).toBeCloseTo(T + 1, 10);
    expect(deskCoverage(state, T + 0.1).map(duty => duty.staffId).sort()).toEqual(['first', 'second']);
    expect(deskCoverage(state, T + 0.55).map(duty => duty.staffId).sort()).toEqual(['keeper', 'second']);
  });

  it('does not offer a short seat gap before a primary clerk returns', () => {
    const base = hotel(), T = hourStart(base);
    const state = hotel([keeper(), clerk(base, 'returning', 0, { restUntil: T + 0.6 }), clerk(base, 'present', 1)]);
    expect(desks(state)).toHaveLength(0);
  });

  it('recalls support for new cleaning after its fixed block without restarting the block on replans', () => {
    let state = planned(hotel()), support = receptionSupports(state)[0].support;
    const changedAt = support.from + 0.1;
    state = settleChanges(state, cleaning(state, 2), changedAt);
    expect(receptionSupports(state)[0].support.to).toBeCloseTo(support.to, 10);
    state = replanStaff(state, changedAt + 0.1);
    expect(receptionSupports(state)[0].support.to).toBeCloseTo(support.to, 10);
    state = planned(advance(state));
    const legs = state.staffPlan!.itineraries[0].legs;
    const counter = legs.find((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'desk')!;
    const clean = legs.find((leg): leg is StayLeg => leg.kind === 'stay' && leg.job === 'turnover')!;
    expect(counter.end).toBeCloseTo(support.to, 10);
    expect(clean.start).toBeGreaterThan(counter.end);
  });

  it('keeps the first support block, intervening cleaning and a second support block through a paused replan', () => {
    const base = hotel([], 15), T = hourStart(base), lane = physicalDeskLanes(base)[0];
    let state = planned(cleaning(hotel([keeper('keeper', { at: lane.front,
      stats: { ...keeper().stats!, fatigue: 20, fatigueAt: T },
      receptionSupport: { lane: lane.key, from: T - 0.9, to: T + 0.1 } })], 15), 0.1));
    const original = desks(state), clean = state.staffPlan!.itineraries[0].legs.find((leg): leg is StayLeg => leg.kind === 'stay' && leg.job === 'turnover')!;
    expect(original).toHaveLength(2);
    expect(clean).toBeDefined();
    state = replanStaff(state, T + 0.05);
    const revised = desks(state), repeatedClean = state.staffPlan!.itineraries[0].legs.find((leg): leg is StayLeg => leg.kind === 'stay' && leg.job === 'turnover')!;
    expect(deskCoverage(state, T + 0.075).some(duty => duty.staffId === 'keeper')).toBe(true);
    expect(repeatedClean.start).toBeCloseTo(clean.start, 10);
    expect(repeatedClean.end).toBeCloseTo(clean.end, 10);
    expect(revised.at(-1)!.start).toBeCloseTo(original[1].start, 10);
    expect(revised.at(-1)!.end).toBeCloseTo(original[1].end, 10);
  });

  it('keeps real rest, duty bounds, absence and leaving ahead of optional support', () => {
    const state = hotel(), T = hourStart(state), lane = physicalDeskLanes(state)[0];
    const nearBreak = keeper('tired', { at: lane.front, stats: { ...keeper().stats!, fatigue: 83, fatigueAt: T } });
    expect(desks(hotel([nearBreak]), 'tired')).toHaveLength(0);
    expect(desks(hotel([keeper()], STAFF.housekeeping.workEndHour))).toHaveLength(0);
    expect(desks(hotel([keeper('leaving', { leaving: true })]), 'leaving')).toHaveLength(0);
    expect(desks(hotel([keeper('resting', { restUntil: T + 1 })]), 'resting')).toHaveLength(0);
    const flaky = keeper('absent', { profile: { ...keeper().profile!, reliability: 'flaky' } });
    let day = 2;
    while (!attendance(flaky, day).absent) day++;
    expect(desks({ ...hotel([flaky]), day }, 'absent')).toHaveLength(0);
    const resting = keeper('break', { at: lane.front, fatigueBreak: { at: lane.front, start: T - 0.1, end: T + 0.8 } });
    const resumed = planned(hotel([resting]));
    expect(desks(resumed, 'break').every(leg => leg.start >= T + 0.8)).toBe(true);
  });

  it('leaves old profiles and other roles neutral and respects each parent feature switch', () => {
    for (const member of [keeper('untrained', { profile: { ...keeper().profile!, receptionTrained: undefined } }),
      keeper('old', { profile: undefined }), keeper('maintenance', { role: 'maintenance' })]) {
      expect(receptionTrained(member)).toBe(false);
      expect(desks(hotel([member]), member.id)).toHaveLength(0);
    }
    for (const setting of [STAFF_CROSS_TRAINING, STAFF_PERSONALITIES, FRONT_DESK_STAFF]) {
      setting.enabled = false;
      expect(receptionTrained(keeper())).toBe(false);
      expect(getStaffPlan(hotel()).itineraries.flatMap(itinerary => itinerary.legs).some(leg => leg.kind === 'stay' && leg.activity === 'desk')).toBe(false);
      setting.enabled = true;
    }
  });
});

describe('Support serves real guests and survives the hourly boundary', () => {
  it('keeps a short support block visible after a mid-hour replan even when no commitment crosses the boundary', () => {
    const base = hotel(), T = hourStart(base), lane = physicalDeskLanes(base)[0];
    let state = planned(hotel([keeper('keeper', { at: lane.front, stats: { ...keeper().stats!, fatigue: 82, fatigueAt: T } })]));
    expect(desks(state)[0].end).toBeCloseTo(T + 0.6, 10);
    state = replanStaff(state, T + 0.1);
    expect(deskCoverage(state, T + 0.2).some(duty => duty.staffId === 'keeper')).toBe(true);
    expect(deskCoverage(state, T + 0.55).some(duty => duty.staffId === 'keeper')).toBe(true);
    expect(deskCoverage(state, T + 0.65).some(duty => duty.staffId === 'keeper')).toBe(false);
  });

  it('opens named service only after physical arrival and never promises a hypothetical next-day helper', () => {
    const state = planned(hotel()), support = receptionSupports(state)[0].support;
    expect(deskCoverage(state, hourStart(state))).toHaveLength(0);
    const slot = quoteLane(lanesOf(state), new Map(), () => hourStart(state), 1 / 3, undefined, true)!;
    expect(slot.staffId).toBe('keeper');
    expect(slot.start).toBeCloseTo(support.from, 10);
    expect(deskCoverage(state, slot.start + 1e-6).some(duty => duty.staffId === 'keeper')).toBe(true);
    expect(quoteLane(lanesOf(state), new Map(), () => hourStart(state) + 24, 1 / 3, undefined, true)).toBeNull();
    const counter = desks(state).find(leg => leg.start <= slot.start && leg.end >= slot.start + slot.hours)!;
    expect(counter).toBeDefined();
  });

  it('credits the helper’s actual hospitality once for a check-in', () => {
    let state = planned(hotel([keeper('keeper', { profile: { ...keeper().profile!, hospitality: 'warm' } })]));
    const slot = quoteLane(lanesOf(state), new Map(), () => hourStart(state), 1 / 3, undefined, true)!;
    const stay = makeStay(slot.lane.front, slot.start, slot.start + slot.hours, 'check_in', { lane: slot.lane.key, ...serviceSnapshot(state.staffRoster![0]) });
    state = { ...state, guests: [guest('arriving', [stay])] };
    const served = creditCheckIns(state, slot.start + 0.01);
    expect(served.guests[0].satisfaction).toBe(54);
    expect(served.guests[0].service!.contacts).toEqual([expect.objectContaining({ staffId: 'keeper', name: 'Avery Park', kind: 'check_in' })]);
    expect(creditCheckIns(served, stay.end + 0.1).guests[0]).toBe(served.guests[0]);
  });

  it('hears a real complaint through the helper and applies warm hospitality once', () => {
    let state = planned(hotel([keeper('keeper', { profile: { ...keeper().profile!, hospitality: 'warm' } })]));
    const slot = quoteLane(lanesOf(state), new Map(), () => hourStart(state), VOICE.complainHours)!;
    const stay = makeStay(slot.lane.front, slot.start, slot.start + slot.hours, 'complain', { lane: slot.lane.key, ...serviceSnapshot(state.staffRoster![0]) });
    state = { ...state, guests: [{ ...guest('complaining', [stay]), tripKind: 'complaint', complaint: { about: 'their stay', via: 'desk' } }] };
    const heard = hearComplaints(state, slot.start + 0.01);
    expect(heard.state.guests[0].satisfaction).toBe(60);
    expect(heard.state.guests[0].service!.contacts).toEqual([expect.objectContaining({ staffId: 'keeper', kind: 'complaint' })]);
    expect(heard.events).toHaveLength(1);
    expect(hearComplaints(heard.state, stay.end + 0.1).events).toHaveLength(0);
  });

  it('credits room work and actual service once, with no experience for idle counter time', () => {
    let state = hotel(), T = hourStart(state), member = state.staffRoster![0], room = state.rooms[0], lane = physicalDeskLanes(state)[0];
    const route = findRoute(state, roomTile(room), lane.front)!;
    const walk = makeWalk(route.path, T + 0.25, TRAVEL.hoursPerTile), start = walk.end;
    const plan: StaffPlan = { start: T, itineraries: [{ staffId: member.id, legs: [
      makeStay(roomTile(room), T, T + 0.25, 'clean', { job: 'turnover', placeId: room.id }), walk,
      makeStay(lane.front, start, T + 1, 'desk', { lane: lane.key, placeId: lane.desk.id }),
    ], end: { at: lane.front } }] };
    expect(start + 0.2).toBeLessThan(T + 1);
    state = { ...state, staffPlan: plan, guests: [guest('service', [
      makeStay(lane.front, start, start + 0.1, 'check_in', { lane: lane.key, serviceStaffId: member.id }),
      makeStay(lane.front, start + 0.1, start + 0.2, 'complain', { lane: lane.key, serviceStaffId: member.id }),
    ])] };
    const after = rosterAfter(state, plan)[0];
    expect(after.stats!.workHours).toBeCloseTo(80.45, 10);
    expect(after.stats!.fatigue).toBeCloseTo(5, 10);
    expect(rosterAfter({ ...state, guests: [] }, plan)[0].stats!.workHours).toBeCloseTo(80.25, 10);
  });

  it('preserves a saved support commitment and elapsed fatigue through a paused replan', () => {
    let state = planned(hotel()), support = receptionSupports(state)[0].support;
    const before = projectFatigue(state.staffRoster![0], state.staffPlan!.itineraries[0].legs, hourStart(state), hourStart(state) + 1);
    expect(saveGame(state, new PRNG(9))).toBe(true);
    state = loadGame()!.state;
    expect(receptionSupports(state)[0].support).toEqual(support);
    expect(state.staffRoster![0].profile!.receptionTrained).toBe(true);
    state = replanStaff(state, support.from + 0.05);
    expect(receptionSupports(state)[0].support.to).toBeCloseTo(support.to, 10);
    expect(fatigueAt(state, state.staffRoster![0], hourStart(state) + 1)).toBeCloseTo(before, 10);
    state = planned(advance(state));
    expect(desks(state)[0].end).toBeCloseTo(support.to, 10);
  });

  it('saves and reloads a short counter block followed by a real cross-hour break without losing either', () => {
    const base = hotel(), T = hourStart(base), lane = physicalDeskLanes(base)[0];
    let state = planned(hotel([keeper('keeper', { at: lane.front, stats: { ...keeper().stats!, fatigue: 82, fatigueAt: T } })]));
    state = replanStaff(state, T + 0.1);
    expect(saveGame(state, new PRNG(13))).toBe(true);
    state = loadGame()!.state;
    state = replanStaff(state, T + 0.2);
    expect(deskCoverage(state, T + 0.55).some(duty => duty.staffId === 'keeper')).toBe(true);
    expect(deskCoverage(state, T + 0.65).some(duty => duty.staffId === 'keeper')).toBe(false);
    expect(fatigueAt(state, state.staffRoster![0], T + 1)).toBeCloseTo(81, 10);
    expect(rosterAfter(state, getStaffPlan(state))[0].stats!.workHours).toBe(80);
    state = planned(advance(state));
    expect(deskCoverage(state, T + 1.05).some(duty => duty.staffId === 'keeper')).toBe(false);
  });

  it('preserves an upstairs approach carried across the hour and through saving before coverage opens', () => {
    // Stretch the same physical route so its carried part crosses a boundary.
    TRAVEL.hoursPerTile = 0.15;
    let state = hotel([keeper('keeper', { at: { gridX: 5, gridY: 1, floor: 1 } })]);
    state = addElevator(buildFloor(state)!.state, 0, 0)!;
    state = planned(state);
    const original = receptionSupports(state)[0].support, T = hourStart(state);
    expect(original.from).toBeGreaterThan(T + 1);
    state = advance(state);
    const carry = state.staffRoster![0].carry;
    expect(carry).toBeDefined();
    expect(saveGame(state, new PRNG(15))).toBe(true);
    state = loadGame()!.state;
    expect(state.staffRoster![0].carry).toEqual(carry);
    expect(deskCoverage(state, T + 1.01).some(duty => duty.staffId === 'keeper')).toBe(false);
    state = planned(state);
    expect(desks(state)[0].start).toBeCloseTo(original.from, 10);
    expect(desks(state)[0].end).toBeCloseTo(original.to, 10);
    expect(deskCoverage(state, original.from + 1e-6).some(duty => duty.staffId === 'keeper')).toBe(true);
  });

  it('reassigns a waiting party when its promised helper is dismissed before service begins', () => {
    let state = planned(hotel([keeper('a'), keeper('b')])), T = hourStart(state);
    const slot = quoteLane(lanesOf(state), new Map(), () => T + 0.4, 1 / 3, undefined, true)!;
    expect(slot.staffId).toBe('a');
    state = { ...state, guests: [guest('waiting', [makeStay(slot.lane.front, T, slot.start, 'wait', { lane: slot.lane.key, placeId: slot.lane.desk.id }),
      makeStay(slot.lane.front, slot.start, slot.start + slot.hours, 'check_in', { lane: slot.lane.key, placeId: slot.lane.desk.id, ...serviceSnapshot(state.staffRoster![0]) })])] };
    state = settleChanges(state, dismissStaff(state, 'a', T + 0.1)!, T + 0.1);
    const service = state.guests[0].trip!.find((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'check_in')!;
    expect(service.serviceStaffId).toBe('b');
    expect(desks(state, 'b').some(leg => leg.lane === service.lane && leg.start <= service.start && leg.end >= service.end)).toBe(true);
  });

  it('finishes an encounter already underway before its helper leaves the counter to rest', () => {
    const base = hotel(), T = hourStart(base), lane = physicalDeskLanes(base)[0];
    let state = planned(hotel([keeper('keeper', { at: lane.front, stats: { ...keeper().stats!, fatigue: 82, fatigueAt: T } })]));
    const service = makeStay(lane.front, T + 0.4, T + 0.75, 'check_in', { lane: lane.key, placeId: lane.desk.id, ...serviceSnapshot(state.staffRoster![0]) });
    state = { ...state, guests: [guest('already-served', [service])] };
    state = reseatLanes(replanStaff(state, T + 0.5), T + 0.5);
    expect(state.guests[0].trip![0]).toEqual(service);
    const leg = desks(state).find(leg => leg.start <= T + 0.5 && leg.end >= service.end);
    expect(leg).toBeDefined();
    const rests = state.staffPlan!.itineraries[0].legs.filter((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'rest');
    expect(rests.every(leg => leg.start >= service.end)).toBe(true);
  });

  it('demolishing a support desk removes future promises while preserving its elapsed approach', () => {
    let state = planned(hotel()), support = receptionSupports(state)[0].support;
    const lane = physicalDeskLanes(state).find(lane => lane.key === support.lane)!, T = hourStart(state), at = T + (support.from - T) / 2;
    const before = state.staffPlan!.itineraries[0].legs[0];
    state = settleChanges(state, demolishFixture(state, lane.desk.id)!, at);
    expect(receptionSupports(state)).toHaveLength(0);
    expect(lanesOf(state)).toHaveLength(0);
    expect(state.staffPlan!.itineraries[0].legs[0].start).toBe(before.start);
    expect(desks(state)).toHaveLength(0);
  });

  it('does not promote virtual cleaning or experience while preparing the next reception block', () => {
    const state = planned(hotel([keeper()], 13)), T = hourStart(state), originalPlan = state.staffPlan!;
    const prepared = prepareReceptionSupport(state, T + 1);
    expect(prepared.staffRoster![0].stats).toEqual(state.staffRoster![0].stats);
    expect(prepared.staffRoster![0].at).toEqual(state.staffRoster![0].at);
    expect(prepared.staffPlan!.start).toBe(originalPlan.start);
    expect(prepared.staffPlan!.itineraries[0].legs).toEqual(originalPlan.itineraries[0].legs);
    expect(prepared.staffRoster![0].receptionSupport).toBeDefined();
  });

  it('does not skip home work discovered by the pre-arrival virtual plan to honor a premature support promise', () => {
    const previous = planned(hotel([keeper()], 13)), T = hourStart(previous);
    const state = cleaning(previous, 0.2), prepared = prepareReceptionSupport(state, T + 1);
    expect(prepared.staffRoster![0].receptionSupport).toBeUndefined();
    expect(prepared.staffPlan!.itineraries[0].legs).toEqual(previous.staffPlan!.itineraries[0].legs);
    const actual = planned({ ...prepared, hour: 14, staffPlan: null });
    const clean = actual.staffPlan!.itineraries[0].legs.find((leg): leg is StayLeg => leg.kind === 'stay' && leg.job === 'turnover')!;
    expect(clean).toBeDefined();
    expect(desks(actual).every(leg => leg.start >= clean.end)).toBe(true);
  });
});

it('with cross-training disabled preserves the full pre-training game’s pinned 60-day balance', () => {
  for (const setting of switches) setting.enabled = true;
  STAFF_CROSS_TRAINING.enabled = false;
  // Measured against main 3a551876, including fatigue and all other named
  // staff features. The separate paired harness also compares the full summary.
  const result = simulate(60, 9, undefined, STRATEGIES.balanced);
  expect(result.finalCash).toBeCloseTo(22237.87009981351, 8);
  expect(result.totalRevenue).toBe(114053);
  expect(result.totalTurnedAway).toBe(496);
  expect(result.avgReviewScore).toBeCloseTo(7.693498107166288, 10);
  expect(result.finalRoomCount).toBe(21);
  expect(result.finalStarRating).toBe(3);
  expect(result.wentBankrupt).toBe(false);
  expect(result.objectivesCompleted).toBe(6);
  expect(result.objectivesFailed).toBe(0);
  expect(result.loanBalance).toBeCloseTo(45857.16471859599, 8);
  expect(result.finalValuation).toBeCloseTo(501786.00538121763, 8);
}, 120000);
