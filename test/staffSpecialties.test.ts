import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_HOSPITALITY, STAFF_SPECIALTIES } from '../src/config/staff.js';
import { TRAVEL } from '../src/config/balance.js';
import { addRoom, createStarterHotel } from '../src/simulation/HotelState.js';
import { getStaffPlan, plannedWork, replanStaff, rosterAfter, staffWorkKey } from '../src/simulation/StaffManager.js';
import { processMaintenanceTick } from '../src/simulation/MaintenanceManager.js';
import { processCleaningTick, startTurnoverCleaning } from '../src/simulation/HousekeepingManager.js';
import { partyOutOfRoom } from '../src/simulation/CleaningPreference.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { hourStart, makeStay, makeWalk } from '../src/simulation/Movement.js';
import type { Hospitality, StaffSpecialty } from '../src/simulation/StaffProfiles.js';
import type { Guest, HotelState, StaffMember, StaffPlan, StayLeg } from '../src/simulation/types.js';

afterEach(() => { STAFF_SPECIALTIES.enabled = true; STAFF_HOSPITALITY.enabled = true; });

function worker(specialty: StaffSpecialty, hospitality: Hospitality = 'polite'): StaffMember {
  return { id: specialty, name: specialty, role: specialty === 'responder' || specialty === 'preventive' ? 'maintenance' : 'housekeeper',
    at: { gridX: 5, gridY: 1, floor: 0 }, profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', specialty, hospitality },
    stats: { workHours: 80, lateDays: 0, absentDays: 0 }, dailyWage: 70 };
}

function hotel(member: StaffMember, twoRooms = false): HotelState {
  let s = addRoom({ ...createStarterHotel(), day: 1, hour: 12, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
  if (twoRooms) s = addRoom(s, 'standard', 6, 2, 0, 'up')!;
  return { ...s, staffRoster: [member], staffPlan: null, staff: { frontDesk: 0, housekeepers: member.role === 'housekeeper' ? 1 : 0, maintenanceWorkers: member.role === 'maintenance' ? 1 : 0 } };
}

function guest(): Guest {
  return { id: 'guest', name: 'Guest', budget: 200, stayLength: 3, trait: 'normal', satisfaction: 50,
    checkInDay: 1, isReturning: false, hadNoiseComplaint: false, party: { kind: 'couple', size: 2 } };
}

function occupied(s: HotelState, returnAfter = 8, dnd = false): HotelState {
  const room = s.rooms[0], at = roomTile(room), hall = { ...at, gridY: 1 }, T = hourStart(s);
  const g = { ...guest(), ...(dnd ? { profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', favorite: 'none', housekeeping: 'dnd' } as Guest['profile'] } : {}),
    tripKind: 'outing' as const, trip: [makeWalk([at, hall], T - 0.2, 0.06), makeStay(hall, T - 0.14, T + returnAfter, 'away'), makeWalk([hall, at], T + returnAfter, 0.06)] };
  return { ...s, rooms: s.rooms.map((r, i) => i === 0 ? { ...r, status: 'occupied', guestId: g.id, condition: 39, dailyCleanHoursRemaining: 0.2, cleanliness: 30 } : r), guests: [g] };
}

function repairLegs(plan: StaffPlan): StayLeg[] {
  return plan.itineraries.flatMap(it => it.legs.filter((l): l is StayLeg => l.kind === 'stay' && l.job === 'repair'));
}

describe('Each employee chooses their specialty without sharing a room', () => {
  it('waits outside for a room move after preserved arrival history, ignoring completed historical departures', () => {
    let s = hotel(worker('turnover_runner'));
    const room = s.rooms[0], at = roomTile(room), hall = { ...at, gridY: 1 }, T = hourStart(s);
    const history = [makeWalk([hall, at], T - 3, 0.06), makeStay(at, T - 2.94, T - 2, 'in_room'),
      makeWalk([at, hall], T - 2, 0.3), makeWalk([hall, at], T - 1.7, 0.06), makeStay(at, T - 1.64, T + 0.2, 'in_room')];
    s = { ...s, rooms: [startTurnoverCleaning(room, 'standard')], guests: [{ ...guest(), tripKind: 'move', trip: [...history, makeWalk([at, hall], T + 0.2, 0.3)] }] };
    const plan = getStaffPlan(s), legs = plan.itineraries[0].legs;
    const entry = legs.find(l => l.kind === 'walk' && l.path.some(p => p.gridY === at.gridY && p.gridX === at.gridX));
    const clean = legs.find((l): l is StayLeg => l.kind === 'stay' && l.job === 'turnover');
    expect(entry?.start).toBeCloseTo(T + 0.5, 10); // the party's last member is out
    expect(clean!.start).toBeGreaterThanOrEqual(T + 0.5 + TRAVEL.hoursPerTile - 1e-9);
    const oldOnly = { ...s, guests: [{ ...guest(), tripKind: 'move' as const, trip: history.slice(0, 3) }] };
    expect(getStaffPlan(oldOnly).itineraries[0].legs.find((l): l is StayLeg => l.kind === 'stay' && !!l.job)?.start).toBeCloseTo(T + TRAVEL.hoursPerTile, 10);
    const crossingBoundary = { ...s, guests: [{ ...guest(), tripKind: 'move' as const, trip: [...history.slice(0, 3), makeWalk([at, hall], T - 0.1, 0.3)] }] };
    expect(getStaffPlan(crossingBoundary).itineraries[0].legs.find((l): l is StayLeg => l.kind === 'stay' && !!l.job)?.start).toBeCloseTo(T + 0.2 + TRAVEL.hoursPerTile, 10);
  });

  it('room attendants take daily cleans before turnovers; runners keep the original priority', () => {
    const s = occupied(hotel(worker('room_attendant'), true));
    s.rooms[1] = startTurnoverCleaning(s.rooms[1], 'standard');
    expect(getStaffPlan(s).itineraries[0].legs.find((l): l is StayLeg => l.kind === 'stay' && !!l.job)?.placeId).toBe(s.rooms[0].id);
    const runner = { ...s.staffRoster![0], profile: { ...s.staffRoster![0].profile!, specialty: 'turnover_runner' as const } };
    expect(getStaffPlan({ ...s, staffRoster: [runner] }).itineraries[0].legs.find((l): l is StayLeg => l.kind === 'stay' && !!l.job)?.placeId).toBe(s.rooms[1].id);
    STAFF_SPECIALTIES.enabled = false;
    expect(getStaffPlan(s)).toEqual(getStaffPlan({ ...s, staffRoster: [runner] }));
  });

  it('room attendants prefer a room whose whole party is out and keep one worker per job', () => {
    let s = occupied(hotel(worker('room_attendant'), true));
    const home = { ...guest(), id: 'home', name: 'Home' };
    s = { ...s, guests: [...s.guests, home], rooms: s.rooms.map((r, i) => i === 1 ? { ...r, status: 'occupied', guestId: home.id, dailyCleanHoursRemaining: 0.2, cleanliness: 0 } : r) };
    const first = getStaffPlan(s).itineraries[0].legs.find((l): l is StayLeg => l.kind === 'stay' && !!l.job);
    expect(first?.placeId).toBe(s.rooms[0].id);
    const colleague = { ...worker('turnover_runner'), id: 'colleague' };
    const plan = getStaffPlan({ ...s, staffRoster: [...s.staffRoster!, colleague] });
    for (const room of s.rooms) {
      const jobs = plan.itineraries.flatMap(it => it.legs.filter((l): l is StayLeg => l.kind === 'stay' && l.placeId === room.id && !!l.job));
      expect(jobs.every((a, i) => jobs.every((b, k) => i === k || a.end <= b.start || b.end <= a.start))).toBe(true);
    }
  });

  it('specialty and hospitality changes invalidate the staff plan', () => {
    const s = hotel(worker('turnover_runner'));
    const changed = (specialty: StaffSpecialty, hospitality: Hospitality): HotelState => ({ ...s, staffRoster: [{ ...s.staffRoster![0], profile: { ...s.staffRoster![0].profile!, specialty, hospitality } }] });
    expect(staffWorkKey(s)).not.toBe(staffWorkKey(changed('room_attendant', 'polite')));
    expect(staffWorkKey(s)).not.toBe(staffWorkKey(changed('turnover_runner', 'warm')));
  });
});

describe('Preventive repairs use the same occupied-room itinerary they credit', () => {
  it('only preventive workers enter occupied rooms, with every repair inside the whole-party away interval', () => {
    const s = occupied(hotel(worker('preventive'))), plan = getStaffPlan(s);
    const repairs = repairLegs(plan);
    expect(repairs.length).toBeGreaterThan(0);
    expect(repairs.every(l => l.preventive && l.repairTarget === 85 && partyOutOfRoom(s.guests[0], s.rooms[0], l.start, l.end))).toBe(true);
    const after = processMaintenanceTick({ ...s, staffPlan: plan }).state;
    expect(after.rooms[0].status).toBe('occupied');
    expect(after.rooms[0].guestId).toBe(s.guests[0].id);
    expect(after.rooms[0].condition).toBeGreaterThan(39);
    const responder = worker('responder');
    expect(repairLegs(getStaffPlan({ ...s, staffRoster: [responder] }))).toHaveLength(0);
    STAFF_SPECIALTIES.enabled = false;
    expect(repairLegs(getStaffPlan(s))).toHaveLength(0);
  });

  it('rejects short away windows, DND, present guests, rooms at the threshold, and shifts ending too soon', () => {
    const s = occupied(hotel(worker('preventive')));
    expect(repairLegs(getStaffPlan(occupied(hotel(worker('preventive')), 5.75)))).toHaveLength(0);
    expect(repairLegs(getStaffPlan(occupied(hotel(worker('preventive')), 8, true)))).toHaveLength(0);
    expect(repairLegs(getStaffPlan({ ...s, guests: [{ ...s.guests[0], trip: null }] }))).toHaveLength(0);
    expect(repairLegs(getStaffPlan({ ...s, rooms: [{ ...s.rooms[0], condition: 40 }] }))).toHaveLength(0);
    expect(repairLegs(getStaffPlan(occupied({ ...hotel(worker('preventive')), hour: 18 }, 8)))).toHaveLength(0);
  });

  it('continues past 40 to its fixed 85 goal, then steps out before the party returns', () => {
    let s = occupied(hotel(worker('preventive')));
    const guest = s.guests[0], room = s.rooms[0];
    let completed = false;
    for (let i = 0; i < 7; i++) {
      const plan = getStaffPlan(s);
      for (const leg of repairLegs(plan)) expect(partyOutOfRoom(guest, room, leg.start, leg.end)).toBe(true);
      const result = processMaintenanceTick({ ...s, staffPlan: plan });
      const next = result.state;
      if (next.rooms[0].condition >= 85 - 1e-9) {
        expect(next.rooms[0].condition).toBeCloseTo(85, 10);
        const repair = repairLegs(plan).at(-1)!;
        const leave = plan.itineraries[0].legs.find(l => l.kind === 'walk' && l.start >= repair.end - 1e-9);
        expect(leave?.kind).toBe('walk');
        expect(leave!.end).toBeLessThan(hourStart(occupied(hotel(worker('preventive')))) + 8);
        expect(result.events.some(e => e.type === 'staff_notice')).toBe(true);
        completed = true; break;
      }
      s = { ...next, staffRoster: rosterAfter(next, plan), staffPlan: plan, hour: s.hour + 1 };
    }
    expect(completed).toBe(true);
  });

  it('specialty changes preserve completed work and stop further occupied-room service', () => {
    let s = occupied(hotel(worker('preventive')));
    const plan = getStaffPlan(s), at = hourStart(s) + 0.4;
    s = { ...s, staffPlan: plan, staffRoster: [{ ...s.staffRoster![0], profile: { ...s.staffRoster![0].profile!, specialty: 'responder' } }] };
    const next = replanStaff(s, at);
    const repairs = repairLegs(next.staffPlan!);
    expect(repairs.length).toBeGreaterThan(0);
    expect(repairs.every(l => l.end <= at + 1e-9 && l.preventive)).toBe(true);
    expect(processMaintenanceTick(next).state.rooms[0].condition).toBeGreaterThan(39);
    expect(plannedWork(next.staffPlan!, 'repair').get(s.rooms[0].id)).toBeLessThan(plannedWork(plan, 'repair').get(s.rooms[0].id)!);
  });

  it('replanning twice preserves work exactly, including a preventive repair finished earlier in the hour', () => {
    const s = occupied(hotel(worker('preventive'))), T = hourStart(s), plan = getStaffPlan(s);
    const once = replanStaff({ ...s, staffPlan: plan }, T + 0.4);
    const twice = replanStaff(replanStaff(once, T + 0.4), T + 0.7);
    expect(plannedWork(twice.staffPlan!, 'repair').get(s.rooms[0].id)).toBeCloseTo(plannedWork(plan, 'repair').get(s.rooms[0].id)!, 10);
    expect(processMaintenanceTick(twice).state.rooms[0].condition).toBeCloseTo(processMaintenanceTick({ ...s, staffPlan: plan }).state.rooms[0].condition, 10);
    const finishing: HotelState = { ...s, rooms: [{ ...s.rooms[0], condition: 84.8 }], staffRoster: [{ ...s.staffRoster![0], at: roomTile(s.rooms[0]), roomId: s.rooms[0].id }], staffPlan: plan };
    const finishPlan = { ...finishing, staffPlan: null };
    // A prior preventive leg proves this is a continuation above the 40-point entry threshold.
    const planned = { ...finishing, staffPlan: { ...plan, start: T - 1 } };
    const freshPlan = getStaffPlan(planned);
    const finished = replanStaff({ ...finishPlan, staffPlan: freshPlan }, T + 0.2);
    expect(plannedWork(finished.staffPlan!, 'repair').get(s.rooms[0].id)).toBeCloseTo(0.025, 10);
    expect(processMaintenanceTick(finished).state.rooms[0].condition).toBeCloseTo(85, 10);
  });

  it('credits each leg’s original goal without reducing condition or crediting occupied work without an away window', () => {
    const s = hotel(worker('responder')), T = hourStart(s), room = s.rooms[0], at = roomTile(room);
    const plan: StaffPlan = { start: T, itineraries: [{ staffId: 'responder', end: { at }, legs: [
      makeStay(at, T, T + 0.5, 'repair', { job: 'repair', placeId: room.id, repairTarget: 95 }),
      makeStay(at, T + 0.5, T + 1, 'repair', { job: 'repair', placeId: room.id, repairTarget: 85 }),
    ] }] };
    expect(processMaintenanceTick({ ...s, rooms: [{ ...room, condition: 92 }], staffPlan: plan }).state.rooms[0].condition).toBe(95);
    const occupiedState = occupied(hotel(worker('preventive')));
    const illegal = { ...plan, itineraries: [{ ...plan.itineraries[0], legs: [makeStay(at, T, T + 1, 'repair', { job: 'repair', placeId: room.id, preventive: true, repairTarget: 85 })] }] };
    expect(processMaintenanceTick({ ...occupiedState, guests: [{ ...occupiedState.guests[0], trip: null }], staffPlan: illegal }).state.rooms[0].condition).toBe(39);
  });
});

describe('Daily-clean hospitality requires meeting the guest', () => {
  it('records a warm finisher only when the guest is present at completion; not for away guests, DND or turnovers', () => {
    const member = worker('room_attendant', 'warm');
    const s = occupied(hotel(member)), T = hourStart(s), room = s.rooms[0], at = roomTile(room);
    const plan: StaffPlan = { start: T, itineraries: [{ staffId: member.id, legs: [makeStay(at, T, T + 0.2, 'clean', { placeId: room.id, job: 'daily' })], end: { at } }] };
    const home = { ...s, guests: [{ ...s.guests[0], trip: null }], staffPlan: plan };
    const greeted = processCleaningTick(home).state;
    expect(greeted.guests[0].satisfaction).toBe(52);
    expect(greeted.guests[0].service?.contacts).toEqual([expect.objectContaining({ staffId: member.id, kind: 'daily_clean', at: T + 0.2, hospitality: 'warm' })]);
    expect(processCleaningTick({ ...s, staffPlan: plan }).state.guests[0].satisfaction).toBe(50);
    const dnd = occupied(hotel(member), 8, true);
    expect(processCleaningTick({ ...dnd, guests: [{ ...dnd.guests[0], trip: null }], staffPlan: plan }).state.guests[0].satisfaction).toBe(50);
    const turnover = { ...home, rooms: [{ ...startTurnoverCleaning(room, 'standard'), cleaningHoursRemaining: 0.2 }], staffPlan: { ...plan, itineraries: [{ ...plan.itineraries[0], legs: [makeStay(at, T, T + 0.2, 'clean', { placeId: room.id, job: 'turnover' })] }] } };
    expect(processCleaningTick(turnover).state.guests[0].service).toBeUndefined();
  });
});
