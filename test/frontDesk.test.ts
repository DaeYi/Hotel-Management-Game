import { afterEach, describe, expect, it } from 'vitest';
import { FRONT_DESK_STAFF } from '../src/config/staff.js';
import { ECONOMY } from '../src/config/balance.js';
import { createStarterHotel, addRoom } from '../src/simulation/HotelState.js';
import { GameController, TICK_INTERVAL_MS } from '../src/game/GameController.js';
import { syncStaff, getStaffPlan, rosterAfter } from '../src/simulation/StaffManager.js';
import { assignDeskShift, hireCandidate, hiringCandidates, dismissStaff } from '../src/simulation/StaffHiring.js';
import { attendance, candidatesFor, checkInHours, deskPaidHours, staffDutyAt, experienceOf } from '../src/simulation/StaffProfiles.js';
import { scheduledDeskLanes, deskCoverage, physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { lanesOf, quoteLane, reseatLanes } from '../src/simulation/DeskQueue.js';
import { getMannedDeskStaff, routeFromStreet } from '../src/simulation/Layout.js';
import { hourStart, makeStay } from '../src/simulation/Movement.js';
import { recordStaffPayroll, getStaffPaydayCost, getStaffDailyCost } from '../src/simulation/MaintenanceManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { loadGame, saveGame } from '../src/simulation/SaveManager.js';
import { PRNG } from '../src/simulation/prng.js';
import type { FrontDeskShift, Guest, HotelState, StaffMember, StayLeg } from '../src/simulation/types.js';

afterEach(() => { FRONT_DESK_STAFF.enabled = true; localStorage.clear(); });

function clerk(id: string, shift: FrontDeskShift = 'late', hours = 80): StaffMember {
  return { id, role: 'front_desk', serial: Number(id.replace(/\D/g, '')) || 1, name: id, shift,
    at: null, hiredDay: 1, dailyWage: 40, profile: { experience: 'skilled', style: 'standard', reliability: 'dependable' },
    stats: { workHours: hours, lateDays: 0, absentDays: 0 } };
}
function hotel(people: StaffMember[], hour = 15, day = 2): HotelState {
  const s = createStarterHotel();
  return { ...s, hour, day, frontDeskRosterReady: true, staffRoster: people, staffPlan: null,
    staff: { frontDesk: people.filter(m => !m.leaving).length, housekeepers: 0, maintenanceWorkers: 0 } };
}
function atDesk(s: HotelState): HotelState {
  const lane = physicalDeskLanes(s)[0];
  return { ...s, staffRoster: s.staffRoster!.map(m => ({ ...m, at: lane.front, deskLane: lane.key })) };
}
function guest(trip: Guest['trip']): Guest {
  return { id: 'g', name: 'Guest', budget: 100, stayLength: 3, trait: 'normal', satisfaction: 60,
    checkInDay: 1, isReturning: false, hadNoiseComplaint: false, trip, tripKind: 'arrival' };
}

describe('Named front desk shifts', () => {
  it('starts with three different named clerks, one per shift; only the scheduled clerk serves', () => {
    const s = syncStaff(createStarterHotel());
    const team = s.staffRoster!.filter(m => m.role === 'front_desk');
    expect(s.staff.frontDesk).toBe(3);
    expect(new Set(team.map(m => m.id)).size).toBe(3);
    expect(team.map(m => m.shift)).toEqual(['early', 'late', 'night']);
    for (const hour of [0, 5, 6, 13, 14, 21, 22, 23]) {
      const now = atDesk({ ...s, day: 2, hour, staffPlan: null });
      expect(getMannedDeskStaff(now)).toBe(1);
    }
  });

  it('one clerk cannot cover the other shifts; arrivals can wait for the next staffed window', () => {
    const s = atDesk(hotel([clerk('c1', 'early')], 15));
    expect(getMannedDeskStaff(s)).toBe(0);
    const slot = quoteLane(lanesOf(s), new Map(), () => hourStart(s), 1 / 3, undefined, true)!;
    expect(slot.start).toBe(54); // next day at 06:00
    expect(slot.staffId).toBe('c1');
  });

  it('commutes in before the shift and walks out after it, without serving while walking', () => {
    let s = hotel([clerk('c1', 'early')], 5);
    const plan = getStaffPlan(s), it = plan.itineraries[0];
    const walk = it.legs.find(l => l.kind === 'walk')!;
    expect(walk.end).toBeCloseTo(30, 10);
    expect(walk.start).toBeGreaterThan(hourStart(s));
    s = { ...s, hour: 6, staffRoster: rosterAfter(s, plan), staffPlan: null };
    expect(getMannedDeskStaff(s)).toBe(1);
    expect(getStaffPlan(s).itineraries[0].legs.some(l => l.kind === 'stay' && l.activity === 'desk')).toBe(true);
    s = { ...s, hour: 14, staffPlan: null };
    const out = getStaffPlan(s).itineraries[0];
    expect(out.legs[0].kind).toBe('walk');
    expect(out.end.at).toBeNull();
    expect(getMannedDeskStaff(s)).toBe(0);
  });

  it('only admits service that can finish before the handover; the next clerk owns the reservation', () => {
    const s = atDesk(hotel([clerk('c1', 'early', 0), clerk('c2', 'late')], 13));
    const slot = quoteLane(lanesOf(s), new Map(), () => 37.9, 1 / 3, undefined, true)!;
    expect(slot.start).toBe(38);
    expect(slot.staffId).toBe('c2');
    expect(slot.hours).toBeCloseTo(1 / 3);
  });

  it('uses 25, 20 and 16 minutes according to experience, and keeps booked service lengths stable', () => {
    for (const [hours, minutes] of [[0, 25], [80, 20], [400, 16]]) {
      const s = atDesk(hotel([clerk('c1', 'late', hours)]));
      const slot = quoteLane(lanesOf(s), new Map(), () => 39.1, 1 / 3, undefined, true)!;
      expect(slot.hours * 60).toBeCloseTo(minutes);
      expect(checkInHours(s.staffRoster![0]) * 60).toBeCloseTo(minutes);
    }
  });

  it('keeps a night shift’s attendance after midnight and gives absent clerks no coverage or pay', () => {
    const m = { ...clerk('night'), shift: 'night' as const, profile: { ...clerk('night').profile!, reliability: 'flaky' as const } };
    let day = 2;
    while (!attendance(m, day).absent || attendance(m, day + 1).absent) day++;
    const t = day * 24 + 1;
    expect(staffDutyAt(m, t).day).toBe(day);
    expect(staffDutyAt(m, t).absent).toBe(true);
    const s = hotel([m], 1, day + 1);
    expect(getMannedDeskStaff(s)).toBe(0);
    expect(deskPaidHours(m, (day - 1) * 24 + 22, day * 24 + 6)).toBe(0);
  });

  it('late clerks open their lane only after the real walk in; a spare on the same shift can cover', () => {
    const m = { ...clerk('late'), profile: { ...clerk('late').profile!, reliability: 'flaky' as const } };
    let day = 2;
    while (attendance(m, day).lateHours === 0) day++;
    const s = hotel([m], 14, day), due = (day - 1) * 24 + 14 + attendance(m, day).lateHours;
    const lane = scheduledDeskLanes(s)[0];
    expect(lane.duties!.find(d => d.staffId === m.id && d.to === (day - 1) * 24 + 22)!.from)
      .toBeCloseTo(due + routeFromStreet(s, lane.front)!.hours);
    expect(getMannedDeskStaff(s)).toBe(0);
    const covered = atDesk(hotel([m, clerk('spare2')], 14, day));
    expect(deskCoverage(covered).some(d => d.staffId === 'spare2')).toBe(true);
  });

  it('offers stable named candidates for a chosen shift, includes night pay, and consumes the person across shifts', () => {
    let s = syncStaff(createStarterHotel());
    const day = candidatesFor(s.day, 'front_desk', [], 'early')[0], night = candidatesFor(s.day, 'front_desk', [], 'night')[0];
    expect(night.name).toBe(day.name);
    expect(night.dailyWage).toBeCloseTo(Math.round(day.dailyWage * 1.25 * 100) / 100, 1);
    s = hireCandidate(s, 'front_desk', night.id, 'night', 0.5)!;
    const m = s.staffRoster!.find(m => m.candidateId === night.id)!;
    expect(m.shift).toBe('night'); expect(m.hiredAt).toBe(0.5);
    expect(hiringCandidates(s, 'front_desk', 'early').some(c => c.id === night.id)).toBe(false);
  });

  it('does not record an absence for a shift before the clerk was hired', () => {
    let m = { ...clerk('not-hired', 'night'), hiredAt: 39, profile: { ...clerk('x').profile!, reliability: 'flaky' as const } };
    while (!attendance(m, 1).absent) m = { ...m, id: `${m.id}x` };
    const s = hotel([m], 15, 2);
    expect(rosterAfter(s, getStaffPlan(s))[0].stats!.absentDays).toBe(0);
  });

  it('backs every real check-in and complaint with the named clerk’s visible counter time through three days of handovers', () => {
    let s = syncStaff({ ...createStarterHotel(), day: 3, hour: 4, cash: 1_000_000 });
    for (let x = 3; x < 10; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
    const prng = new PRNG(9), arrivals = ECONOMY.baseArrivalsPerDay;
    let services = 0;
    ECONOMY.baseArrivalsPerDay = 80;
    try {
      for (let h = 0; h < 72; h++) {
        s = tickSimulation(s, prng).state;
        const T = hourStart(s), plan = getStaffPlan(s);
        for (const g of s.guests) for (const leg of g.trip ?? []) {
          if (leg.kind !== 'stay' || !['check_in', 'complain'].includes(leg.activity) || leg.start >= T + 1 || leg.end <= T) continue;
          services++;
          const atCounter = plan.itineraries.find(it => it.staffId === leg.serviceStaffId)?.legs.find(l => l.kind === 'stay' && l.activity === 'desk' && l.lane === leg.lane && l.start <= Math.max(T, leg.start) + 1e-9 && l.end >= Math.min(T + 1, leg.end) - 1e-9);
          expect(atCounter, `${leg.serviceStaffId} at ${T}: ${leg.start}–${leg.end}`).toBeDefined();
        }
      }
    } finally { ECONOMY.baseArrivalsPerDay = arrivals; }
    expect(services).toBeGreaterThan(5);
  });

  it('permits off-duty shift changes, applies night pay and prevents one person working successive shifts', () => {
    let s = atDesk(hotel([clerk('c1', 'early')], 13));
    expect(assignDeskShift(s, 'c1', 'late')).toBeNull();
    s = { ...s, hour: 14 };
    s = assignDeskShift(s, 'c1', 'night')!;
    const m = s.staffRoster![0];
    expect(m.dailyWage).toBe(50);
    expect(m.restUntil).toBe(54);
    expect(deskPaidHours(m, 38, 54)).toBe(0);
    // Repeated edits cannot erase rest already owed.
    s = assignDeskShift(s, 'c1', 'late')!;
    expect(s.staffRoster![0].restUntil).toBeGreaterThanOrEqual(54);
    expect(deskPaidHours(s.staffRoster![0], 38, 54)).toBe(0);
    const partial = hotel([{ ...clerk('part-shift'), hiredAt: 39.5 }], 22);
    const next = assignDeskShift(partial, 'part-shift', 'night')!;
    expect(next.staffRoster![0].restUntil).toBe(63.5);
    expect(deskPaidHours(next.staffRoster![0], 46, 54)).toBe(0);
  });
});

describe('Front desk experience, wages and saves', () => {
  it('credits check-ins and complaints to their actual clerk, with no experience for idle desk time', () => {
    let s = atDesk(hotel([clerk('c1', 'late', 399.8)], 21));
    const lane = physicalDeskLanes(s)[0], T = hourStart(s);
    s = { ...s, guests: [guest([
      makeStay(lane.front, T, T + 0.1, 'wait', { serviceStaffId: 'c1' }),
      makeStay(lane.front, T + 0.1, T + 0.4, 'check_in', { lane: lane.key, serviceStaffId: 'c1' }),
      makeStay(lane.front, T + 0.5, T + 0.7, 'complain', { lane: lane.key, serviceStaffId: 'c1' }),
    ])] };
    const m = rosterAfter(s, getStaffPlan(s))[0];
    expect(m.stats!.workHours).toBeCloseTo(400.3);
    expect(experienceOf(m)).toBe('veteran'); expect(m.dailyWage).toBe(52);
    expect(rosterAfter({ ...s, guests: [] }, getStaffPlan(s))[0].stats!.workHours).toBe(399.8);
  });

  it('pays night shifts across midnight once, retains earned pay after a dismissal, and prorates a mid-hour hire', () => {
    let s = hotel([clerk('c1', 'night')], 22);
    for (let i = 0; i < 8; i++) {
      s = recordStaffPayroll(s);
      const again = recordStaffPayroll(s);
      expect(again.staffPayroll).toEqual(s.staffPayroll);
      s = { ...s, hour: (s.hour + 1) % 24, day: s.day + (s.hour === 23 ? 1 : 0) };
    }
    expect(s.staffPayroll!['2'].c1).toBeCloseTo(10);
    expect(s.staffPayroll!['3'].c1).toBeCloseTo(30);
    expect(getStaffPaydayCost({ ...s, day: 4 })).toBeCloseTo(30);
    let hired = hotel([{ ...clerk('new1'), hiredAt: 39.5 }]);
    hired = dismissStaff(hired, 'new1', 39.75)!;
    hired = recordStaffPayroll(hired);
    expect(hired.staffPayroll!['2'].new1).toBeCloseTo(1.25);
  });

  it('reassigns waiting guests after a hire; dismissing all clerks never sends them upstairs without service', () => {
    let s = atDesk(hotel([clerk('c1')], 15));
    const lane = physicalDeskLanes(s)[0], T = hourStart(s);
    s = { ...s, guests: [guest([makeStay(lane.front, T, T + 1, 'wait', { placeId: lane.desk.id, lane: lane.key }),
      makeStay(lane.front, T + 1, T + 4 / 3, 'check_in', { placeId: lane.desk.id, lane: lane.key, serviceStaffId: 'c1' })])] };
    s = reseatLanes(dismissStaff(s, 'c1', T + 0.1)!, T + 0.1);
    expect(s.guests[0].trip!.some(l => l.kind === 'stay' && l.activity === 'check_in')).toBe(true);
    const booked = s.guests[0].trip!.find(l => l.kind === 'stay' && l.activity === 'check_in') as StayLeg;
    expect(booked.start).toBeGreaterThan(T + 0.1);
    const newClerk = { ...clerk('c2'), hiredAt: T + 0.2 };
    s = reseatLanes({ ...s, staff: { ...s.staff, frontDesk: 1 }, staffRoster: [...s.staffRoster!, newClerk] }, T + 0.2);
    const served = s.guests[0].trip!.find(l => l.kind === 'stay' && l.activity === 'check_in') as StayLeg;
    expect(served.serviceStaffId).toBe('c2');
    expect(served.start).toBeLessThan(T + 0.3);
    expect(served.start).toBeGreaterThan(T + 0.2);
  });

  it('upgrades v21 coverage into three shifts per position without changing the wage budget, clock or old plans', () => {
    const old = { ...createStarterHotel(), day: 4, hour: 15, staff: { frontDesk: 2, housekeepers: 0, maintenanceWorkers: 0 },
      staffRoster: [], staffPlan: { start: 87, itineraries: [] } };
    const clock = { hourProgress: 0.4, speed: 2, paused: true };
    localStorage.setItem('hotel-game-save', JSON.stringify({ version: 21, prngState: 7, state: old, clock }));
    const loaded = loadGame()!;
    expect(loaded.version).toBe(22); expect(loaded.clock).toEqual(clock);
    expect(loaded.state.staff.frontDesk).toBe(6);
    expect(loaded.state.staffPlan).toEqual(old.staffPlan);
    expect(getStaffDailyCost(loaded.state)).toBeCloseTo(140);
    expect(getMannedDeskStaff(loaded.state)).toBe(2);
    expect(loaded.state.staffPayroll!['4']).toBeDefined();
    saveGame(loaded.state, new PRNG(7), undefined, clock);
    const again = loadGame()!;
    expect(again.state.staffRoster).toEqual(loaded.state.staffRoster);
    expect(again.state.staff.frontDesk).toBe(6);
    const night = again.state.staffRoster!.find(m => m.shift === 'night')!;
    const moved = assignDeskShift({ ...again.state, hour: 7 }, night.id, 'early')!;
    expect(moved.staffRoster!.find(m => m.id === night.id)!.dailyWage).toBe(night.dailyWage); // no premium to remove from an old contract
  });

  it('saves a paused partial commute, selected shift and consumed candidate without changing their future work', () => {
    localStorage.setItem('hotel-game-tutorial-seen', '1');
    const c = new GameController();
    c.state = { ...c.state, hour: 15, day: 2, staffPlan: null };
    c.update(TICK_INTERVAL_MS * 0.25); c.togglePause();
    const option = hiringCandidates(c.state, 'front_desk', 'late')[0];
    c.hireStaff('front_desk', option.id, 'late');
    const fresh = new GameController();
    expect(fresh.state.staffRoster).toEqual(c.state.staffRoster);
    expect(fresh.state.staffPlan).toEqual(c.state.staffPlan);
    expect(fresh.gameTime).toBe(c.gameTime);
    expect(hiringCandidates(fresh.state, 'front_desk', 'night').some(m => m.id === option.id)).toBe(false);
  });

  it('uses the exact current time for hiring and layoffs through the count shortcuts', () => {
    localStorage.setItem('hotel-game-tutorial-seen', '1');
    const c = new GameController();
    c.state = { ...c.state, day: 2, hour: 15, staffPlan: null,
      staff: { ...c.state.staff, frontDesk: 4 }, staffRoster: [...c.state.staffRoster!, { ...clerk('extra-early', 'early'), hiredAt: 0 }] };
    c.update(TICK_INTERVAL_MS * 0.25);
    c.setStaff({ ...c.state.staff, frontDesk: 5 });
    const added = c.state.staffRoster!.find(m => m.candidateId && m.role === 'front_desk')!;
    expect(added.shift).toBe('late'); expect(added.hiredAt).toBe(c.gameTime);
    c.setStaff({ ...c.state.staff, frontDesk: 4 });
    expect(c.state.staffRoster!.filter(m => m.leaving).every(m => m.dismissedAt === c.gameTime)).toBe(true);
  });
});
