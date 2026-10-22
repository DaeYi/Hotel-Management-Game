import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_HOSPITALITY, STAFF_PERSONALITIES, STAFF_SPECIALTIES } from '../src/config/staff.js';
import { HOSTED_NIGHTS, STORY, TRAVEL, VOICE } from '../src/config/balance.js';
import { addRoom, createStarterHotel } from '../src/simulation/HotelState.js';
import { assignStaffSpecialty, hireCandidate, hiringCandidates } from '../src/simulation/StaffHiring.js';
import { candidatesFor, checkInHours, hospitalityOf, specialtiesFor, type Hospitality } from '../src/simulation/StaffProfiles.js';
import { hospitalityReview, isMoodKnown, recordHospitality, recordNoiseHospitality, serviceSnapshot } from '../src/simulation/StaffHospitality.js';
import { physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { creditCheckIns, reseatLanes } from '../src/simulation/DeskQueue.js';
import { hearComplaints } from '../src/simulation/Complaints.js';
import { finalTile, hash01, hourStart, legsEnd, makeStay, makeWalk, positionAt } from '../src/simulation/Movement.js';
import { roomTile, routeVia, walkLegs } from '../src/simulation/GuestMovement.js';
import { guestPace } from '../src/simulation/Profile.js';
import { routeFromStreet } from '../src/simulation/Layout.js';
import { advanceIncidents, recordStaffReviews, selectNewIncident } from '../src/simulation/StoryGenerator.js';
import { fileVisitorComplaints } from '../src/simulation/HostedNights.js';
import { offerUpsell } from '../src/simulation/StaffSpecialties.js';
import { calculateGuestReviewBreakdown, processDepartures } from '../src/simulation/GuestManager.js';
import { processRevenue } from '../src/simulation/EconomyManager.js';
import { getPartyFairPrice } from '../src/simulation/StarRatingManager.js';
import { saveGame, loadGame } from '../src/simulation/SaveManager.js';
import { PRNG } from '../src/simulation/prng.js';
import type { Guest, GuestProfile, HotelState, StaffMember, StaffRole } from '../src/simulation/types.js';

const PROFILE: GuestProfile = { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11 };
const guest = (extra: Partial<Guest> = {}): Guest => ({ id: 'g', name: 'Sam', budget: 1000, stayLength: 30,
  trait: 'normal', satisfaction: 60, checkInDay: 1, isReturning: false, hadNoiseComplaint: false, profile: PROFILE, ...extra });
function clerk(hospitality: Hospitality = 'warm', extra: Partial<StaffMember> = {}): StaffMember {
  return { id: 'c1', name: 'Morgan Reed', serial: 1, role: 'front_desk', shift: 'late', at: null, dailyWage: 42,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', specialty: 'greeter', hospitality },
    stats: { workHours: 80, lateDays: 0, absentDays: 0 }, ...extra };
}
function hotel(member = clerk(), extra: Partial<HotelState> = {}): HotelState {
  const state = createStarterHotel();
  const lane = physicalDeskLanes(state)[0];
  return { ...state, day: 2, hour: 15, frontDeskRosterReady: true,
    staff: { frontDesk: 1, housekeepers: 0, maintenanceWorkers: 0 },
    staffRoster: [{ ...member, at: lane.front, deskLane: lane.key }], staffPlan: null, ...extra };
}

afterEach(() => {
  STAFF_HOSPITALITY.enabled = true;
  STAFF_SPECIALTIES.enabled = true;
  STAFF_PERSONALITIES.enabled = true;
  localStorage.clear();
});

describe('Specialties and hospitality survive hiring and saving', () => {
  it('rolls a stable, role-appropriate shortlist and persists the hired person and consumed card', () => {
    for (const role of ['front_desk', 'housekeeper', 'maintenance'] as StaffRole[]) {
      let state = hotel();
      const candidates = hiringCandidates(state, role);
      expect(candidates).toEqual(hiringCandidates(state, role));
      for (const person of candidates) {
        expect(specialtiesFor(role)).toContain(person.profile.specialty);
        expect(['warm', 'polite', 'curt']).toContain(person.profile.hospitality);
        if (role === 'maintenance') expect(person.profile.hospitality).toBe('polite');
      }
      const selected = candidates[0];
      state = hireCandidate(state, role, selected.id)!;
      const hired = state.staffRoster!.find(m => m.candidateId === selected.id)!;
      expect(hired.profile).toEqual(selected.profile);
      expect(hired.dailyWage).toBe(selected.dailyWage);
      expect(saveGame(state, new PRNG(9))).toBe(true);
      const restored = loadGame()!.state;
      expect(restored.staffRoster!.find(m => m.id === hired.id)).toEqual(hired);
      expect(hiringCandidates(restored, role).some(c => c.id === selected.id)).toBe(false);
    }
  });

  it('offers each hospitality and specialty across deterministic daily shortlists', () => {
    const people = Array.from({ length: 40 }, (_, day) => candidatesFor(day + 1, 'front_desk')).flat();
    expect(new Set(people.map(c => c.profile.hospitality))).toEqual(new Set(['warm', 'polite', 'curt']));
    expect(new Set(people.map(c => c.profile.specialty))).toEqual(new Set(['greeter', 'upseller', 'concierge']));
  });

  it('lets each role change specialty without rewriting the old performance contract or wage', () => {
    for (const role of ['front_desk', 'housekeeper', 'maintenance'] as StaffRole[]) {
      const options = specialtiesFor(role);
      const member = clerk('polite', { role, profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', legacy: true } });
      const state = hotel(member);
      const updated = assignStaffSpecialty(state, member.id, options[1])!;
      const changed = updated.staffRoster![0];
      expect(changed.profile).toEqual({ ...member.profile, specialty: options[1] });
      expect(changed.dailyWage).toBe(member.dailyWage);
      expect(changed.stats).toEqual(member.stats);
      expect(state.staffRoster![0].profile!.specialty).toBeUndefined();
      expect(saveGame(updated, new PRNG(1))).toBe(true);
      expect(loadGame()!.state.staffRoster![0].profile).toEqual(changed.profile);
    }
  });

  it('rejects specialties for the wrong role and former or missing employees', () => {
    const state = hotel();
    expect(assignStaffSpecialty(state, 'c1', 'preventive')).toBeNull();
    expect(assignStaffSpecialty(state, 'missing', 'concierge')).toBeNull();
    expect(assignStaffSpecialty(hotel(clerk('warm', { leaving: true })), 'c1', 'concierge')).toBeNull();
    STAFF_SPECIALTIES.enabled = false;
    expect(assignStaffSpecialty(state, 'c1', 'concierge')).toBeNull();
  });
});

describe('Hospitality belongs to actual encounters', () => {
  it('multiplies the clerk’s experience-based check-in time and leaves old profiles neutral', () => {
    for (const [hours, minutes] of [[0, 25], [80, 20], [400, 16]]) for (const [hospitality, mult] of [['warm', 0.75], ['polite', 1], ['curt', 1.2]] as const) {
      expect(checkInHours(clerk(hospitality, { stats: { workHours: hours, lateDays: 0, absentDays: 0 } })) * 60).toBeCloseTo(minutes * mult);
    }
    const older = clerk('polite', { profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', legacy: true } });
    expect(hospitalityOf(older)).toBe('polite');
    expect(checkInHours(older) * 60).toBeCloseTo(20);
    STAFF_HOSPITALITY.enabled = false;
    expect(checkInHours(clerk('warm')) * 60).toBeCloseTo(20);
  });

  it('records one check-in and one complaint per stay, and one daily-clean encounter per day', () => {
    let current = recordHospitality(guest(), clerk(), 'check_in', 39);
    expect(current.satisfaction).toBe(64);
    expect(recordHospitality(current, clerk(), 'check_in', 40)).toBe(current);
    current = recordHospitality(current, clerk(), 'complaint', 41);
    expect(current.satisfaction).toBe(69); // the complaint system separately grants its ordinary +5
    expect(recordHospitality(current, clerk(), 'complaint', 65)).toBe(current);
    const cleaner = clerk('warm', { id: 'h1', name: 'Avery Park', role: 'housekeeper' });
    current = recordHospitality(current, cleaner, 'daily_clean', 42);
    expect(current.satisfaction).toBe(71);
    expect(recordHospitality(current, cleaner, 'daily_clean', 43)).toBe(current);
    current = recordHospitality(current, cleaner, 'daily_clean', 66);
    expect(current.satisfaction).toBe(73);
    expect(current.service!.contacts.map(c => c.kind)).toEqual(['check_in', 'complaint', 'daily_clean', 'daily_clean']);
  });

  it('keeps polite service neutral and bounds satisfaction at both ends', () => {
    const original = guest();
    expect(recordHospitality(original, clerk('polite'), 'check_in', 39)).toBe(original);
    expect(recordHospitality(original, clerk('polite'), 'daily_clean', 40)).toBe(original);
    expect(recordHospitality(guest({ satisfaction: 99 }), clerk(), 'check_in', 39).satisfaction).toBe(100);
    expect(recordHospitality(guest({ satisfaction: 1 }), clerk('curt'), 'check_in', 39).satisfaction).toBe(0);
    const curt = recordHospitality(guest(), clerk('curt'), 'check_in', 39);
    expect(curt.satisfaction).toBe(57);
    expect(curt.service!.hospitalityMood).toBe(-3);
  });

  it('caps encounter history while preserving cumulative review effects and the stay-wide check-in guard', () => {
    let current = recordHospitality(guest(), clerk(), 'check_in', 15);
    const cleaner = clerk('warm', { id: 'h1', role: 'housekeeper' });
    for (let day = 1; day <= 20; day++) current = recordHospitality(current, cleaner, 'daily_clean', day * 24 + 15);
    expect(current.service!.contacts).toHaveLength(12);
    expect(current.satisfaction).toBeLessThanOrEqual(100);
    expect(hospitalityReview(current).score).toBe(0.6);
    expect(recordHospitality(current, clerk(), 'check_in', 600)).toBe(current);
  });

  it('caps positive and negative review effects and attributes the employee by name', () => {
    const warm = recordHospitality(guest(), clerk(), 'check_in', 39);
    expect(hospitalityReview(warm)).toMatchObject({ score: 0.2, praise: expect.stringContaining('Morgan Reed') });
    let curt = recordHospitality(guest(), clerk('curt'), 'check_in', 39);
    const cleaner = clerk('curt', { id: 'h1', name: 'Avery Park', role: 'housekeeper' });
    for (let day = 1; day <= 10; day++) curt = recordHospitality(curt, cleaner, 'daily_clean', day * 24 + 15);
    expect(hospitalityReview(curt)).toMatchObject({ score: -0.6, criticism: expect.stringContaining('Avery Park') });
    STAFF_HOSPITALITY.enabled = false;
    expect(hospitalityReview(warm).score).toBe(0);
    expect(recordHospitality(guest(), clerk(), 'check_in', 39).service).toBeUndefined();
  });

  it('carries the encounter’s named contribution into the checkout review without consuming extra randomness', () => {
    const state = addRoom(hotel(), 'standard', 3, 2, 0, 'up')!;
    const room = { ...state.rooms[0], cleanliness: 50, condition: 50, decor: 80, pricePerNight: 100 };
    const neutralRandom = new PRNG(12), servedRandom = new PRNG(12);
    const neutral = calculateGuestReviewBreakdown(room, state, guest(), neutralRandom);
    const served = calculateGuestReviewBreakdown(room, state, recordHospitality(guest(), clerk(), 'check_in', 39), servedRandom);
    expect(served.hospitality).toBe(0.2);
    expect(served.hospitalityPraise).toContain('Morgan Reed');
    expect(served.finalScore - neutral.finalScore).toBeCloseTo(0.2);
    expect(servedRandom.next()).toBe(neutralRandom.next());
  });

  it('writes at most one staff review a day using the strongest actual checkout contribution and its named attribution', () => {
    const warm = recordHospitality(guest({ id: 'good', name: 'Robin', checkInDay: 2, stayLength: 3 }), clerk(), 'check_in', 39);
    let curt = recordHospitality(guest({ id: 'bad', name: 'Taylor', checkInDay: 2, stayLength: 3 }), clerk('curt'), 'check_in', 39);
    curt = recordHospitality(curt, clerk('curt', { id: 'h1', name: 'Avery Park', role: 'housekeeper' }), 'daily_clean', 63);
    let state = addRoom(hotel(), 'standard', 3, 2, 0, 'up')!;
    state = addRoom(state, 'standard', 4, 2, 0, 'up')!;
    const guests = [warm, curt];
    state = { ...state, day: 5, hour: 11, guests,
      rooms: state.rooms.map((room, i) => ({ ...room, status: 'occupied', guestId: guests[i].id })) };
    const departures = processDepartures(state, new PRNG(6)).departed.map(d => ({ ...d, guestName: d.guest.name }));
    expect(departures).toHaveLength(2);
    expect(departures[0].breakdown.hospitality).toBe(0.2);
    expect(departures[1].breakdown.hospitality).toBe(-0.25);
    const written = recordStaffReviews(state, departures);
    const entries = written.storyLog.filter(entry => entry.type === 'staff_review');
    expect(entries).toHaveLength(1);
    expect(entries[0].guestName).toBe('Taylor');
    expect(entries[0].message).toContain(departures[1].breakdown.hospitalityCriticism);
    expect(entries[0].message).toContain('-0.25/10 for hospitality');
    expect(entries[0].message).toContain('Avery Park');
    expect(recordStaffReviews(written, departures)).toBe(written);
    expect(recordStaffReviews({ ...written, day: 6 }, departures).storyLog.filter(entry => entry.type === 'staff_review')).toHaveLength(2);
  });

  it('a concierge learns a stoic guest’s mood only through check-in or a desk complaint, including polite service', () => {
    const stoic = guest({ profile: { ...PROFILE, voice: 'stoic' } });
    const concierge = clerk('polite', { profile: { ...clerk('polite').profile!, specialty: 'concierge' } });
    expect(isMoodKnown(stoic)).toBe(false);
    expect(isMoodKnown(recordHospitality(stoic, clerk('polite'), 'check_in', 39))).toBe(false);
    expect(isMoodKnown(recordHospitality(stoic, concierge, 'daily_clean', 39))).toBe(false);
    for (const kind of ['check_in', 'complaint'] as const) {
      const served = recordHospitality(stoic, concierge, kind, 39);
      expect(served.satisfaction).toBe(stoic.satisfaction);
      expect(served.service!.concierge).toMatchObject({ staffId: 'c1', name: 'Morgan Reed', at: 39 });
      expect(isMoodKnown(served)).toBe(true);
    }
    STAFF_SPECIALTIES.enabled = false;
    expect(isMoodKnown(recordHospitality(stoic, concierge, 'check_in', 39))).toBe(false);
  });
});

function upsellBooking() {
  const member = clerk('polite', { profile: { ...clerk('polite').profile!, specialty: 'upseller' } });
  let state = hotel(member, { cash: 1_000_000, starRating: 3, peakStarRating: 5 });
  state = addRoom(state, 'standard', 3, 2, 0, 'up')!;
  state = addRoom(state, 'deluxe', 4, 2, 0, 'up')!;
  let serial = 0;
  while (hash01(`upsell-${serial}|upsell`) >= 0.25) serial++;
  const lane = physicalDeskLanes(state)[0], T = hourStart(state);
  const stay = makeStay(lane.front, T + 0.1, T + 0.4, 'check_in', { lane: lane.key, ...serviceSnapshot(member) });
  const booked = guest({ id: `upsell-${serial}`, checkInDay: 2, stayLength: 3,
    profile: { ...PROFILE, spending: 'splurger' }, tripKind: 'arrival', trip: [stay], budget: 200 });
  state = { ...state, guests: [booked], rooms: state.rooms.map((room, index) => index === 0
    ? { ...room, status: 'occupied', guestId: booked.id, pricePerNight: 80 }
    : { ...room, pricePerNight: 100 }) };
  return { state, member, stay, booked };
}

describe('Upsellers offer suitable rooms at the actual check-in', () => {
  it('upgrades an eligible splurger once, reroutes from the counter, and charges only the upgraded nightly rate', () => {
    const { state, member, stay, booked } = upsellBooking();
    expect(creditCheckIns(state, stay.start).rooms[1].status).toBe('vacant');
    expect(creditCheckIns(state, stay.start + 0.01).rooms[1].guestId).toBe(booked.id);
    const upgraded = offerUpsell(state, booked.id, member, stay);
    const current = upgraded.guests[0], original = upgraded.rooms[0], room = upgraded.rooms[1];
    expect(original.status).toBe('vacant');
    expect(original.guestId).toBeFalsy();
    expect(room.status).toBe('occupied');
    expect(room.guestId).toBe(booked.id);
    expect(current.service!.upsell).toMatchObject({ staffId: 'c1', name: 'Morgan Reed', fromRoomId: original.id,
      fromType: 'standard', toType: 'deluxe', extraPerNight: 20, at: stay.start });
    expect(finalTile(current.trip!)).toMatchObject({ gridX: room.gridX, gridY: room.gridY, floor: room.floor });
    expect(current.trip![1].start).toBeCloseTo(stay.end);
    expect(offerUpsell(upgraded, booked.id, member, stay)).toBe(upgraded);
    const checkout = { ...upgraded, day: 5, hour: 11 };
    const departed = processDepartures(checkout, new PRNG(4));
    expect(departed.departed).toHaveLength(1);
    expect(processRevenue(checkout, departed).cashDelta).toBe(300);
  });

  it('respects spending style, budget, party capacity and prior room promises', () => {
    const { state, member, stay, booked } = upsellBooking();
    for (const change of [
      { profile: { ...PROFILE, spending: 'standard' as const } },
      { profile: { ...PROFILE, spending: 'thrifty' as const } },
      { budget: 99 },
      { party: { kind: 'family' as const, size: 5 } },
      { spotlight: { kind: 'writer' as const } },
      { loyalty: { personId: 'regular', stays: 4, oldRoom: true } },
    ]) {
      const restricted = { ...state, guests: [{ ...booked, ...change }] };
      expect(offerUpsell(restricted, booked.id, member, stay)).toBe(restricted);
    }
    const greeter = clerk('polite');
    expect(offerUpsell(state, booked.id, greeter, stay)).toBe(state);
    STAFF_SPECIALTIES.enabled = false;
    expect(offerUpsell(state, booked.id, member, stay)).toBe(state);
  });

  it('never offers an occupied, unreachable or overpriced upgrade', () => {
    const { state, member, stay, booked } = upsellBooking();
    const room = state.rooms[1];
    for (const change of [
      { status: 'occupied' as const, guestId: 'someone-else' },
      { gridX: 100, gridY: 100 },
      { pricePerNight: getPartyFairPrice(room, { kind: 'solo', size: 1 }, state.starRating) * 1.01 },
    ]) {
      const restricted = { ...state, guests: [{ ...booked, budget: 10000 }], rooms: [state.rooms[0], { ...room, ...change }] };
      expect(offerUpsell(restricted, booked.id, member, stay)).toBe(restricted);
    }
  });

  it('preserves a suite promised to an announced spotlight guest whose stay overlaps the booking', () => {
    const { state, member, stay, booked } = upsellBooking();
    let reserved = addRoom(state, 'suite', 5, 2, 0, 'up')!;
    const suite = reserved.rooms.find(r => r.type === 'suite')!;
    reserved = { ...reserved, rooms: reserved.rooms.filter(r => r.type !== 'deluxe').map(r => r.id === suite.id ? { ...r, pricePerNight: 150 } : r),
      spotlight: { kind: 'writer', week: 1, salt: 'test', announceDay: 2, arrivalDay: 3, arrivalHour: 15,
        status: 'announced', roomId: suite.id, chainId: 'spotlight-test' } };
    expect(offerUpsell({ ...reserved, spotlight: undefined }, booked.id, member, stay).rooms.find(r => r.id === suite.id)!.status).toBe('occupied');
    expect(offerUpsell(reserved, booked.id, member, stay)).toBe(reserved);
  });

  it('preserves the walk already taken and reroutes from the tile actually reached when check-in finished earlier in the hour', () => {
    const { state, member, stay, booked } = upsellBooking();
    const route = routeVia(state, stay.at, roomTile(state.rooms[0]), guestPace(booked))!;
    const trip = [stay, ...walkLegs(route, stay.end, guestPace(booked))];
    const current = { ...state, guests: [{ ...booked, trip }] };
    const now = stay.end + 0.15;
    expect(now).toBeLessThan(legsEnd(trip));
    const upgraded = offerUpsell(current, booked.id, member, stay, now);
    const next = upgraded.guests[0].trip!;
    expect(next[0]).toEqual(stay);
    // The current step finishes before the guest turns: no visible jump or rewritten past.
    for (const t of [stay.start + 0.1, stay.end + 0.06, now]) {
      const before = positionAt(trip, t)!, after = positionAt(next, t)!;
      expect([after.x, after.y, after.floor, after.moving]).toEqual([before.x, before.y, before.floor, before.moving]);
    }
    const reroute = next[2];
    expect(reroute.kind).toBe('walk');
    expect(reroute.kind === 'walk' && reroute.path[0]).toEqual(finalTile(next.slice(0, 2)));
    expect(reroute.start).toBeGreaterThanOrEqual(now);
    expect(finalTile(next)).toMatchObject(roomTile(upgraded.rooms[1]));
    expect(upgraded.rooms[0].status).toBe('vacant');
  });

  it('schedules turnover cleaning if the guest had already reached the original room before the upgrade was credited', () => {
    const { state, member, stay, booked } = upsellBooking();
    const route = routeVia(state, stay.at, roomTile(state.rooms[0]), guestPace(booked))!;
    const trip = [stay, ...walkLegs(route, stay.end, guestPace(booked))];
    const current = { ...state, guests: [{ ...booked, trip }] }, now = legsEnd(trip) + 0.1;
    const upgraded = offerUpsell(current, booked.id, member, stay, now);
    const next = upgraded.guests[0].trip!;
    expect(next.slice(0, trip.length)).toEqual(trip);
    const resting = next[trip.length];
    expect(resting).toMatchObject({ kind: 'stay', activity: 'in_room', at: roomTile(state.rooms[0]),
      placeId: state.rooms[0].id, start: legsEnd(trip), end: now });
    const moving = next[trip.length + 1];
    expect(moving.kind === 'walk' && moving.path[0]).toEqual(roomTile(state.rooms[0]));
    expect(moving.start).toBe(now);
    for (let index = 1; index < next.length; index++) expect(next[index].start).toBeCloseTo(next[index - 1].end);
    expect(upgraded.rooms[0].status).toBe('cleaning');
    expect(upgraded.rooms[0].guestId).toBeUndefined();
    expect(upgraded.rooms[0].cleaningHoursRemaining).toBeGreaterThan(0);
    expect(upgraded.rooms[1].guestId).toBe(booked.id);
  });

  it('does not fill a vacant room whose repair is already being carried out in the current staff plan', () => {
    const { state, member, stay, booked } = upsellBooking();
    const room = state.rooms[1], T = hourStart(state);
    const repairing: HotelState = { ...state, staffPlan: { start: T, itineraries: [{ staffId: 'maintenance-2',
      legs: [makeStay(roomTile(room), T, T + 1, 'repair', { job: 'repair', placeId: room.id })], end: { at: roomTile(room) } }] } };
    expect(offerUpsell(repairing, booked.id, member, stay, T + 0.5)).toBe(repairing);
    expect(offerUpsell({ ...repairing, staffPlan: null }, booked.id, member, stay, T + 0.5).rooms[1].guestId).toBe(booked.id);
  });
});

describe('Named hospitality reaches guests through real service', () => {
  it('refreshes a future specialty snapshot even when its lane, clerk and service time are unchanged', () => {
    const state = hotel(clerk('polite')), lane = physicalDeskLanes(state)[0], T = hourStart(state);
    const service = makeStay(lane.front, T + 0.25, T + 0.25 + 1 / 3, 'check_in', {
      placeId: lane.desk.id, lane: lane.key, ...serviceSnapshot(state.staffRoster![0]),
    });
    const booked = { ...state, guests: [guest({ tripKind: 'arrival', trip: [service] })] };
    const changed = assignStaffSpecialty(booked, 'c1', 'concierge')!;
    const reseated = reseatLanes(changed, T);
    expect(reseated.guests[0].trip![0]).toMatchObject({ start: service.start, end: service.end, lane: lane.key,
      serviceStaffId: 'c1', serviceSpecialty: 'concierge' });
    // The same roster edit cannot rewrite an encounter that has already begun.
    const underway = reseatLanes(changed, service.start + 0.05);
    expect(underway.guests[0].trip![0]).toEqual(service);
  });

  it('credits the clerk who serves the check-in once, preserving a service snapshot after profile changes', () => {
    const state = hotel(), lane = physicalDeskLanes(state)[0], T = hourStart(state);
    const service = makeStay(lane.front, T + 0.1, T + 0.35, 'check_in', { lane: lane.key, ...serviceSnapshot(clerk()) });
    const arriving = guest({ tripKind: 'arrival', trip: [service] });
    const booked = { ...state, guests: [arriving] };
    expect(creditCheckIns(booked, T + 0.1).guests[0].service).toBeUndefined();
    const changedProfile = { ...booked, staffRoster: [clerk('curt')] };
    const credited = creditCheckIns(changedProfile, T + 0.2);
    expect(credited.guests[0].satisfaction).toBe(64);
    expect(credited.guests[0].service!.contacts).toEqual([expect.objectContaining({ staffId: 'c1', name: 'Morgan Reed', kind: 'check_in', hospitality: 'warm' })]);
    expect(creditCheckIns(credited, T + 1).guests[0]).toBe(credited.guests[0]);
    expect(credited.deskToday!.checkedIn).toBe(1);
  });

  it('adds warm hospitality to the ordinary complaint benefit once, and keeps anonymous service neutral', () => {
    for (const hospitality of ['warm', 'polite', 'curt', undefined] as const) {
      const member = clerk(hospitality ?? 'polite'), state = hotel(member), lane = physicalDeskLanes(state)[0], T = hourStart(state);
      const service = makeStay(lane.front, T + 0.1, T + 0.35, 'complain', { lane: lane.key, ...(hospitality ? serviceSnapshot(member) : {}) });
      const complainant = guest({ satisfaction: 30, tripKind: 'complaint', trip: [service], complaint: { about: 'the room', via: 'desk' } });
      const booked = { ...state, guests: [complainant] };
      expect(hearComplaints(booked, T + 0.1).events).toEqual([]);
      const heard = hearComplaints(booked, T + 0.2);
      expect(heard.state.guests[0].satisfaction).toBe(30 + (hospitality === 'warm' ? 10 : VOICE.heardMood));
      expect(heard.events).toHaveLength(1);
      expect(hearComplaints(heard.state, T + 1).events).toEqual([]);
      expect(hearComplaints(heard.state, T + 1).state.guests[0]).toBe(heard.state.guests[0]);
    }
  });

  it('keeps anonymous check-ins at the old mood and does not apply a roster-wide hospitality bonus', () => {
    const state = hotel(), lane = physicalDeskLanes(state)[0], T = hourStart(state);
    const anonymous = guest({ tripKind: 'arrival', trip: [makeStay(lane.front, T, T + 1 / 3, 'check_in', { lane: lane.key })] });
    const current = creditCheckIns({ ...state, guests: [anonymous, guest({ id: 'other', satisfaction: 40 })] }, T + 0.2);
    expect(current.guests[0].satisfaction).toBe(60);
    expect(current.guests[0].service).toBeUndefined();
    expect(current.guests[1].satisfaction).toBe(40);
    expect(current.guests[1].service).toBeUndefined();
  });

  it('gives phone grace only from a warm clerk physically staffing the desk at that moment', () => {
    const member = clerk(), state = hotel(member), lane = physicalDeskLanes(state)[0], T = hourStart(state), caller = guest();
    const plan = (from: number, to: number, activity: 'desk' | 'wait' = 'desk'): HotelState => ({ ...state,
      staffPlan: { start: T, itineraries: [{ staffId: member.id,
        legs: [makeStay(lane.front, from, to, activity, { lane: lane.key })], end: { at: lane.front } }] } });
    expect(recordNoiseHospitality(state, caller, T + 0.5)).toEqual({ guest: caller, grace: 0 });
    expect(recordNoiseHospitality(plan(T + 0.75, T + 1), caller, T + 0.5).grace).toBe(0);
    expect(recordNoiseHospitality(plan(T, T + 0.5), caller, T + 0.5).grace).toBe(0);
    expect(recordNoiseHospitality(plan(T, T + 1, 'wait'), caller, T + 0.5).grace).toBe(0);
    const answered = recordNoiseHospitality(plan(T, T + 1), caller, T + 0.5);
    expect(answered.grace).toBe(3);
    expect(answered.clerk!.id).toBe('c1');
    expect(answered.guest).toBe(caller);
    expect(answered.guest.service).toBeUndefined();
    for (const hospitality of ['polite', 'curt'] as const) {
      expect(recordNoiseHospitality({ ...plan(T, T + 1), staffRoster: [clerk(hospitality)] }, caller, T + 0.5).grace).toBe(0);
    }
    STAFF_HOSPITALITY.enabled = false;
    expect(recordNoiseHospitality(plan(T, T + 1), caller, T + 0.5).grace).toBe(0);
  });
});

describe('A warm clerk gives one static extension to a real phone incident', () => {
  function nightHotel(): HotelState {
    let state = hotel(clerk('warm', { shift: 'night' }), { day: 2, hour: 23 });
    state = addRoom(state, 'standard', 3, 2, 0, 'up')!;
    state = addRoom(state, 'standard', 4, 2, 0, 'up')!;
    const guests = [guest({ id: 's', satisfaction: 46, profile: { ...PROFILE, voice: 'vocal' } }),
      guest({ id: 'o', profile: { ...PROFILE, chronotype: 'night', rowdiness: 'rowdy' }, party: { kind: 'friends', size: 4 } })];
    const lane = physicalDeskLanes(state)[0], T = hourStart(state);
    return { ...state, guests, rooms: state.rooms.map((r, i) => ({ ...r, status: 'occupied', guestId: guests[i].id })),
      staffPlan: { start: T, itineraries: [{ staffId: 'c1', legs: [makeStay(lane.front, T, T + 1, 'desk', { lane: lane.key })], end: { at: lane.front } }] } };
  }

  it('extends a noise call once and counts down normally while the warm clerk remains at the desk', () => {
    const state = nightHotel(), filed = selectNewIncident(state, new PRNG(1)).state;
    expect(filed.activeIncidents).toHaveLength(1);
    expect(filed.activeIncidents[0].hoursRemaining).toBe(STORY.noiseComplaintGraceHours + 3);
    expect(filed.storyLog.some(entry => entry.message.includes('Morgan Reed reassured them'))).toBe(true);
    expect(filed.guests[0].service?.concierge).toBeUndefined();
    const lane = physicalDeskLanes(state)[0];
    const next: HotelState = { ...filed, day: 3, hour: 0, staffPlan: { start: 48, itineraries: [{ staffId: 'c1',
      legs: [makeStay(lane.front, 48, 49, 'desk', { lane: lane.key })], end: { at: lane.front } }] } };
    const advanced = advanceIncidents(next, new PRNG(2)).state;
    expect(advanced.activeIncidents[0].hoursRemaining).toBe(STORY.noiseComplaintGraceHours + 2);
    expect(selectNewIncident(advanced, new PRNG(3)).state.activeIncidents).toEqual(advanced.activeIncidents);
    const neutral = selectNewIncident({ ...state, staffPlan: null }, new PRNG(1)).state;
    expect(neutral.activeIncidents[0].hoursRemaining).toBe(STORY.noiseComplaintGraceHours);
  });

  it('also gives a visitor-noise call one extension without adding it again on later checks', () => {
    const state = nightHotel();
    let serial = 0;
    while (hash01(`visitor-neighbor-${serial}|h|2|complain`) >= HOSTED_NIGHTS.complaintChance.light * VOICE.visitorComplaintMult.vocal) serial++;
    const host = guest({ id: 'h', profile: { ...PROFILE, chronotype: 'night', rowdiness: 'rowdy' }, hostedNight: { day: 2, visitors: 2 } });
    const neighbor = guest({ id: `visitor-neighbor-${serial}`, profile: { ...PROFILE, sleep: 'light', voice: 'vocal' } });
    const tile = roomTile(state.rooms[0]), route = routeFromStreet(state, tile, TRAVEL.guestHoursPerTile)!;
    const incoming = makeWalk(route.path, 46, TRAVEL.guestHoursPerTile);
    const current: HotelState = { ...state, visitorPolicy: 'allow', guests: [host, neighbor],
      rooms: state.rooms.map((r, i) => ({ ...r, guestId: i === 0 ? host.id : neighbor.id })),
      walkers: [{ id: 'vis', trait: 'normal', isReturning: false, reason: 'visitor', hostId: host.id,
        party: { kind: 'friends', size: 2 }, trip: [incoming, makeStay(tile, incoming.end, 50, 'in_room', { placeId: state.rooms[0].id })] }] };
    const filed = fileVisitorComplaints(current, 48).state;
    expect(filed.activeIncidents).toHaveLength(1);
    expect(filed.activeIncidents[0]).toMatchObject({ about: 'visitors', hoursRemaining: HOSTED_NIGHTS.complaintGraceHours + 3 });
    expect(fileVisitorComplaints(filed, 48).state.activeIncidents).toEqual(filed.activeIncidents);
    const neutral = fileVisitorComplaints({ ...current, staffPlan: null }, 48).state;
    expect(neutral.activeIncidents[0].hoursRemaining).toBe(HOSTED_NIGHTS.complaintGraceHours);
  });
});
