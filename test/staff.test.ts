import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_PERSONALITIES } from '../src/config/staff.js';
import { STAFF, EVENT_GUESTS } from '../src/config/balance.js';
import { GameController, TICK_INTERVAL_MS } from '../src/game/GameController.js';
import { createStarterHotel, addRoom } from '../src/simulation/HotelState.js';
import { getStaffPlan, plannedWork, rosterAfter, syncStaff, replanStaff } from '../src/simulation/StaffManager.js';
import { candidatesFor, attendance, staffRate, staffWage, afterWork, experienceOf, type WorkStyle, type Reliability, type Experience } from '../src/simulation/StaffProfiles.js';
import { hiringCandidates, hireCandidate, dismissStaff } from '../src/simulation/StaffHiring.js';
import { processCleaningTick, startTurnoverCleaning, estimateHousekeepingHours } from '../src/simulation/HousekeepingManager.js';
import { processMaintenanceTick, recordStaffPayroll, getStaffDailyCost, getStaffPaydayCost, getProjectedStaffDailyCost } from '../src/simulation/MaintenanceManager.js';
import { roomCleaningAt } from '../src/simulation/CleaningStatus.js';
import { hourStart, makeStay, makeWalk, positionAt } from '../src/simulation/Movement.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { loadGame, saveGame } from '../src/simulation/SaveManager.js';
import { PRNG } from '../src/simulation/prng.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import type { HotelState, StaffMember, StaffRole, StaffPlan } from '../src/simulation/types.js';

afterEach(() => { STAFF_PERSONALITIES.enabled = true; EVENT_GUESTS.enabled = true; localStorage.clear(); });

function worker(id: string, role: StaffRole = 'housekeeper', style: WorkStyle = 'standard', experience: Experience = 'skilled', reliability: Reliability = 'dependable'): StaffMember {
  return {
    id, serial: 10, role, name: `Worker ${id}`, hiredDay: 1, dailyWage: role === 'housekeeper' ? 70 : 80,
    profile: { experience, style, reliability },
    stats: { workHours: experience === 'rookie' ? 0 : experience === 'skilled' ? 80 : 400, lateDays: 0, absentDays: 0 },
    at: { gridX: 5, gridY: 2, floor: 0, door: 'up' },
  };
}

function hotel(m: StaffMember): HotelState {
  const s = addRoom({ ...createStarterHotel(), cash: 1_000_000, day: 5, hour: 12 }, 'standard', 5, 2, 0, 'up')!;
  return { ...s, staff: { housekeepers: m.role === 'housekeeper' ? 1 : 0, maintenanceWorkers: m.role === 'maintenance' ? 1 : 0, frontDesk: 0 }, staffRoster: [m], staffPlan: null };
}

describe('People, candidates, shortcuts and saves', () => {
  it('has three deterministic candidates per role, with profiles and different daily lists', () => {
    const a = candidatesFor(12, 'housekeeper');
    expect(a).toHaveLength(3);
    expect(a).toEqual(candidatesFor(12, 'housekeeper'));
    expect(new Set(a.map(c => c.id)).size).toBe(3);
    expect(candidatesFor(13, 'housekeeper')).not.toEqual(a);
    expect(candidatesFor(12, 'maintenance').every(c => c.role === 'maintenance')).toBe(true);
    expect(a.every(c => c.name && c.dailyWage > 0 && c.profile.style && c.profile.reliability)).toBe(true);
  });

  it('hiring copies the selected candidate, consumes the card through reloads, and never reuses a fired identity', () => {
    let s = syncStaff(createStarterHotel());
    const candidate = hiringCandidates(s, 'housekeeper')[1];
    s = hireCandidate(s, 'housekeeper', candidate.id)!;
    const hired = s.staffRoster!.find(m => m.candidateId === candidate.id)!;
    expect(hired.profile).toEqual(candidate.profile);
    expect(hired.dailyWage).toBe(candidate.dailyWage);
    expect(hired.name).toBe(candidate.name);
    expect(hireCandidate(s, 'housekeeper', candidate.id)).toBeNull();
    saveGame(s, new PRNG(1));
    const loaded = loadGame()!;
    expect(loaded.version).toBe(21);
    expect(hiringCandidates(loaded.state, 'housekeeper').some(c => c.id === candidate.id)).toBe(false);
    s = syncStaff(dismissStaff(loaded.state, hired.id)!);
    const next = hiringCandidates(s, 'housekeeper')[0];
    s = hireCandidate(s, 'housekeeper', next.id)!;
    const replacement = s.staffRoster!.find(m => m.candidateId === next.id)!;
    expect(replacement.id).not.toBe(hired.id);
    expect(replacement.serial).toBeGreaterThan(hired.serial!);
  });

  it('count shortcuts retain identities, add real candidates, and permit choosing a specific layoff', () => {
    localStorage.setItem('hotel-game-tutorial-seen', '1');
    const c = new GameController();
    const original = c.state.staffRoster![0];
    const offered = hiringCandidates(c.state, 'housekeeper');
    c.setStaff({ ...c.state.staff, housekeepers: 2 });
    expect(c.state.staffRoster!.find(m => m.id === original.id)?.name).toBe(original.name);
    const hired = c.state.staffRoster!.find(m => m.id !== original.id)!;
    expect(offered.some(o => o.id === hired.candidateId)).toBe(true);
    c.dismissStaff(original.id);
    expect(c.state.staff.housekeepers).toBe(1);
    expect(c.state.staffRoster!.some(m => m.id === original.id && !m.leaving)).toBe(false);
    expect(c.state.staffRoster!.some(m => m.id === hired.id && !m.leaving)).toBe(true);
    expect(new GameController().state.staffRoster).toEqual(c.state.staffRoster);
  });

  it('migrates old staff in place with neutral performance and a persistent serial counter', () => {
    const m = { id: 'housekeeper-2', role: 'housekeeper' as const, at: { gridX: 5, gridY: 2, floor: 0 } };
    const s = { ...createStarterHotel(), staffRoster: [m], hour: 12 };
    localStorage.setItem('hotel-game-save', JSON.stringify({ version: 20, prngState: 10, state: s }));
    const migrated = loadGame()!;
    const person = migrated.state.staffRoster![0];
    expect(migrated.version).toBe(21);
    expect(person.id).toBe(m.id); expect(person.at).toEqual(m.at);
    expect(person.name).toBeTruthy(); expect(staffRate(person)).toBe(1); expect(staffWage(person)).toBe(70);
    const hired = hireCandidate(migrated.state, 'housekeeper', hiringCandidates(migrated.state, 'housekeeper')[0].id)!;
    expect(new Set(hired.staffRoster!.map(m => m.id)).size).toBe(hired.staffRoster!.length);
  });

  it('inspects the worker where they are now, while a future walk ends on another floor', () => {
    localStorage.setItem('hotel-game-tutorial-seen', '1');
    const c = new GameController();
    const m = { ...worker('housekeeper-travelling'), at: { gridX: 5, gridY: 2, floor: 1 } };
    const here = { gridX: 4, gridY: 2, floor: 0 };
    c.state = { ...c.state, hour: 12, floorCount: 2, staffRoster: [m], staffPlan: { start: 12, itineraries: [{ staffId: m.id, legs: [makeStay(here, 12, 13, 'rest')], end: { at: m.at } }] } };
    c.selectStaff(m.id, here);
    expect(c.currentFloor).toBe(0);
    c.setFloor(1);
    c.selectStaff(m.id);
    expect(c.currentFloor).toBe(0);
    expect(c.selection).toEqual({ kind: 'staff', id: m.id, anchor: here });
  });

  it('letting a new worker go mid-commute preserves their walk and earned pay', () => {
    localStorage.setItem('hotel-game-tutorial-seen', '1');
    const c = new GameController();
    c.state = { ...c.state, day: 4, hour: 12, staffPlan: null };
    const candidate = hiringCandidates(c.state, 'housekeeper')[0];
    c.hireStaff('housekeeper', candidate.id);
    const person = c.state.staffRoster!.find(m => m.candidateId === candidate.id)!;
    c.update(TICK_INTERVAL_MS * 0.02);
    const t = c.gameTime;
    const before = c.state.staffPlan!.itineraries.find(it => it.staffId === person.id)!;
    expect(positionAt(before.legs, t)).toBeTruthy();
    c.dismissStaff(person.id);
    const after = c.state.staffPlan!.itineraries.find(it => it.staffId === person.id)!;
    expect(positionAt(after.legs, t - 0.001)?.x).toBeCloseTo(positionAt(before.legs, t - 0.001)!.x, 10);
    expect(c.state.staffRoster!.find(m => m.id === person.id)?.leaving).toBe(true);
    c.update(TICK_INTERVAL_MS * 0.98);
    expect(c.state.staffPayroll![String(c.state.day)][person.id]).toBeGreaterThan(0);
  });
});

describe('The same work on screen, in the overlay and in the tick', () => {
  it('skill changes real stay lengths, and progress counts work units rather than clock hours', () => {
    const m = worker('fast', 'housekeeper', 'standard', 'veteran');
    let s = hotel(m);
    s = { ...s, rooms: s.rooms.map(r => ({ ...startTurnoverCleaning(r, 'standard'), cleanliness: 20, cleaningHoursRemaining: 1, cleaningHoursTotal: 1 })) };
    s = { ...s, staffPlan: getStaffPlan(s) };
    const T = hourStart(s), leg = s.staffPlan!.itineraries[0].legs.find(l => l.kind === 'stay' && l.job === 'turnover')!;
    expect(leg.end - leg.start).toBeCloseTo(1 / 1.2, 10);
    expect(plannedWork(s.staffPlan!, 'turnover').get(s.rooms[0].id)).toBeCloseTo(1, 10);
    expect(roomCleaningAt(s, T + 0.5).get(s.rooms[0].id)?.hoursLeft).toBeCloseTo(0.4, 10);
    expect(processCleaningTick(s).state.rooms[0]).toMatchObject({ status: 'vacant', cleanliness: 85 });
    expect(rosterAfter(s, s.staffPlan!)[0].stats!.workHours).toBeCloseTo(400 + 1 / 1.2, 10);
  });

  it('the finisher sets cleanliness, and meticulous staff report damage once', () => {
    const a = worker('speed', 'housekeeper', 'speedy'), b = worker('care', 'housekeeper', 'meticulous');
    let s = hotel(a); const T = hourStart(s), id = s.rooms[0].id, at = roomTile(s.rooms[0]);
    const split = T + 0.3 / staffRate(a);
    const plan: StaffPlan = { start: T, itineraries: [
      { staffId: a.id, legs: [makeStay(at, T, split, 'clean', { job: 'turnover', placeId: id, workRate: staffRate(a) })], end: { at } },
      { staffId: b.id, legs: [makeStay(at, split, split + 0.5 / staffRate(b), 'clean', { job: 'turnover', placeId: id, workRate: staffRate(b) })], end: { at } },
    ] };
    s = { ...s, staff: { ...s.staff, housekeepers: 2 }, staffRoster: [a, b], staffPlan: plan, rooms: s.rooms.map(r => ({ ...startTurnoverCleaning(r, 'standard'), condition: 50, cleanliness: 10, cleaningHoursRemaining: 0.8 })) };
    const cleaned = processCleaningTick(s);
    expect(cleaned.state.rooms[0].cleanliness).toBe(95);
    expect(cleaned.state.rooms[0].cleanedBy?.id).toBe(b.id);
    expect(cleaned.state.rooms[0].damageReportedBy).toBe(b.name);
    expect(cleaned.events.filter(e => e.type === 'staff_notice')).toHaveLength(1);
  });

  it('maintenance stops at the employee’s target, and can complete a job within the hour', () => {
    for (const [style, target] of [['speedy', 85], ['meticulous', 95]] as const) {
      const m = worker(style, 'maintenance', style);
      let s = hotel(m);
      s = { ...s, rooms: s.rooms.map(r => ({ ...r, condition: target - 1 })), staffRoster: [{ ...m, roomId: s.rooms[0].id }] };
      s = { ...s, staffPlan: getStaffPlan(s) };
      const leg = s.staffPlan!.itineraries[0].legs.find(l => l.kind === 'stay' && l.job === 'repair')!;
      expect(leg.end - leg.start).toBeLessThan(0.3);
      expect(processMaintenanceTick(s).state.rooms[0].condition).toBeCloseTo(target, 10);
    }
  });

  it('replanning partway through a faster clean preserves past work and positions', () => {
    const m = worker('f', 'housekeeper', 'speedy', 'veteran');
    let s = hotel(m);
    s = { ...s, rooms: s.rooms.map(r => ({ ...startTurnoverCleaning(r, 'standard'), cleaningHoursRemaining: 3 })) };
    s = { ...s, staffPlan: getStaffPlan(s) };
    const t = hourStart(s) + 0.4;
    const next = replanStaff(s, t);
    expect(plannedWork(next.staffPlan!, 'turnover').get(s.rooms[0].id)).toBeCloseTo(plannedWork(s.staffPlan!, 'turnover').get(s.rooms[0].id)!, 10);
    expect(positionAt(next.staffPlan!.itineraries[0].legs, t)?.x).toBe(positionAt(s.staffPlan!.itineraries[0].legs, t)?.x);
  });

  it('experience grows only from work, with a promotion and its wage increase', () => {
    const m = { ...worker('rookie', 'housekeeper', 'standard', 'rookie'), dailyWage: 63, stats: { workHours: 79.8, lateDays: 0, absentDays: 0 } };
    const s = hotel(m), T = hourStart(s), at = roomTile(s.rooms[0]);
    const plan: StaffPlan = { start: T, itineraries: [{ staffId: m.id, end: { at }, legs: [
      makeWalk([{ ...at, gridX: 4 }, at], T, 0.2),
      makeStay(at, T + 0.2, T + 0.5, 'clean', { placeId: s.rooms[0].id, job: 'turnover', workRate: 0.8 }),
      makeStay(at, T + 0.5, T + 1, 'rest'),
    ] }] };
    const after = rosterAfter(s, plan)[0];
    expect(after.stats!.workHours).toBeCloseTo(80.1, 10);
    expect(experienceOf(after)).toBe('skilled');
    expect(staffWage(after)).toBe(70);
    expect(staffRate(after)).toBe(1);
    expect(plannedWork(plan, 'turnover').get(s.rooms[0].id)).toBeCloseTo(0.24, 10); // the promotion never changes work already planned
  });

  it('staffing estimates distinguish slower and faster teams without shortening walks', () => {
    const slow = hotel(worker('slow', 'housekeeper', 'meticulous', 'rookie'));
    const fast = hotel(worker('fast', 'housekeeper', 'speedy', 'veteran'));
    expect(estimateHousekeepingHours(slow, 1)).toBeGreaterThan(estimateHousekeepingHours(fast, 1));
  });
});

describe('Attendance and wages', () => {
  it('late and absent days are deterministic, move the actual commute, and never happen to dependable workers', () => {
    const m = { ...worker('flaky', 'housekeeper', 'standard', 'skilled', 'flaky'), at: null };
    let absentDay = 0, lateDay = 0;
    for (let day = 1; day < 1000; day++) {
      const a = attendance(m, day);
      expect(attendance(m, day)).toEqual(a);
      expect(attendance(worker('dep'), day)).toEqual({ absent: false, lateHours: 0 });
      if (a.absent) absentDay ||= day;
      if (a.lateHours > 0) lateDay ||= day;
    }
    expect(absentDay).toBeGreaterThan(0); expect(lateDay).toBeGreaterThan(0);
    const due = 7 + attendance(m, lateDay).lateHours;
    let s = { ...hotel(m), day: lateDay, hour: Math.floor(due) };
    s = { ...s, rooms: s.rooms.map(r => startTurnoverCleaning(r, 'standard')) };
    const plan = getStaffPlan(s);
    expect(plan.itineraries[0].legs[0].start).toBeGreaterThanOrEqual((lateDay - 1) * 24 + due);
    const absent = { ...s, day: absentDay, hour: 12 };
    expect(getStaffPlan(absent).itineraries[0].legs).toHaveLength(0);
    expect(getStaffDailyCost(absent)).toBe(0);
    expect(getProjectedStaffDailyCost(absent)).toBe(70);
    expect(getProjectedStaffDailyCost({ ...absent, staff: { ...absent.staff, housekeepers: 2 } })).toBe(140);
    expect(Object.values(recordStaffPayroll(absent).staffPayroll![String(absentDay)])).toHaveLength(0);
    const counted = afterWork(afterWork(m, 0, absentDay), 0, absentDay);
    expect(counted.stats!.absentDays).toBe(1);
  });

  it('pays the individual wage, keeps earned wages after a layoff, and settles them the next day', () => {
    const m = { ...worker('paid'), dailyWage: 91 };
    const earned = recordStaffPayroll(hotel(m));
    expect(getStaffDailyCost(earned)).toBe(91);
    const fired = dismissStaff(earned, m.id)!;
    expect(getStaffDailyCost(fired)).toBe(0);
    expect(getStaffPaydayCost({ ...fired, day: fired.day + 1, hour: 0 })).toBe(91);
  });

  it('with staff personalities off the original balance run is unchanged', () => {
    STAFF_PERSONALITIES.enabled = false; EVENT_GUESTS.enabled = false;
    const r = simulate(60, 9, undefined, STRATEGIES.balanced);
    expect(r.finalCash).toBeCloseTo(18185.5, 6);
    expect(r.totalRevenue).toBe(110823);
    expect(r.totalTurnedAway).toBe(508);
  }, 120000);
});
