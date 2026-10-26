import { afterEach, expect, it } from 'vitest';
import { FRONT_DESK_STAFF, STAFF_CLEANING_SUPPORT, STAFF_PERSONALITIES } from '../src/config/staff.js';
import { createStarterHotel } from '../src/simulation/HotelState.js';
import { candidatesFor, afterWork, cleaningTrained, cleaningRate, staffRate, staffWage } from '../src/simulation/StaffProfiles.js';
import { assignDeskShift, hireCandidate, hiringCandidates } from '../src/simulation/StaffHiring.js';
import { syncStaff } from '../src/simulation/StaffManager.js';
import type { StaffMember } from '../src/simulation/types.js';

const candidateChance = STAFF_CLEANING_SUPPORT.candidateChance;
afterEach(() => {
  STAFF_CLEANING_SUPPORT.enabled = true;
  STAFF_CLEANING_SUPPORT.candidateChance = candidateChance;
  STAFF_PERSONALITIES.enabled = true;
  FRONT_DESK_STAFF.enabled = true;
});

it('adds early-shift offers without changing existing traits, other roles or late/night offers', () => {
  const trained = Array.from({ length: 40 }, (_, day) => candidatesFor(day + 1, 'front_desk', [], 'early')).flat();
  expect(trained.some(cleaningTrained)).toBe(true);
  expect(trained.some(member => !cleaningTrained(member))).toBe(true);
  expect(trained).toEqual(Array.from({ length: 40 }, (_, day) => candidatesFor(day + 1, 'front_desk', [], 'early')).flat());
  const others = [candidatesFor(7, 'housekeeper'), candidatesFor(7, 'maintenance'), candidatesFor(7, 'front_desk', [], 'late'), candidatesFor(7, 'front_desk', [], 'night')];
  expect(others.flat().some(cleaningTrained)).toBe(false);
  STAFF_CLEANING_SUPPORT.enabled = false;
  const originals = Array.from({ length: 40 }, (_, day) => candidatesFor(day + 1, 'front_desk', [], 'early')).flat();
  trained.forEach((offer, i) => {
    const { cleaningTrained: capability, ...profile } = offer.profile;
    expect({ ...offer, profile, dailyWage: originals[i].dailyWage }).toEqual(originals[i]);
    expect(offer.dailyWage).toBe(capability ? Math.round(originals[i].dailyWage * 1.15 * 100) / 100 : originals[i].dailyWage);
  });
  expect([candidatesFor(7, 'housekeeper'), candidatesFor(7, 'maintenance'), candidatesFor(7, 'front_desk', [], 'late'), candidatesFor(7, 'front_desk', [], 'night')]).toEqual(others);
});

it('keeps a hired slot consumed across shifts and stores the premium once through promotions and shift changes', () => {
  STAFF_CLEANING_SUPPORT.candidateChance = 1;
  const state = syncStaff(createStarterHotel());
  const candidate = candidatesFor(state.day, 'front_desk', [], 'early').find(offer => offer.profile.experience === 'rookie')!;
  expect(candidate).toBeDefined();
  const hired = hireCandidate(state, 'front_desk', candidate.id, 'early')!;
  const member = hired.staffRoster!.find(person => person.candidateId === candidate.id)!;
  for (const shift of ['early', 'late', 'night'] as const) expect(hiringCandidates(hired, 'front_desk', shift).some(c => c.id === candidate.id)).toBe(false);
  expect(member.dailyWage).toBe(candidate.dailyWage);
  expect(staffWage(afterWork(member, 0, state.day))).toBe(candidate.dailyWage);
  const promoted = afterWork(member, 80, state.day);
  expect(promoted.dailyWage).toBe(Math.round(candidate.dailyWage / STAFF_PERSONALITIES.experienceWage.rookie * 100) / 100);
  expect(cleaningTrained(promoted)).toBe(true);
  const changed = assignDeskShift(hired, member.id, 'late', 15)!;
  const moved = changed.staffRoster!.find(person => person.id === member.id)!;
  expect(moved.dailyWage).toBe(candidate.dailyWage);
  expect(cleaningTrained(moved)).toBe(true);
  STAFF_CLEANING_SUPPORT.enabled = false;
  expect(staffWage(moved)).toBe(candidate.dailyWage);
});

it('requires the capability, primary clerk role and enabled parent features', () => {
  const member: StaffMember = { id: 'clerk', role: 'front_desk', at: null, profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', cleaningTrained: true } };
  expect(cleaningTrained(member)).toBe(true);
  expect(cleaningTrained({ ...member, role: 'housekeeper' })).toBe(false);
  expect(cleaningTrained({ ...member, role: 'maintenance' })).toBe(false);
  expect(cleaningTrained({ ...member, profile: { ...member.profile!, cleaningTrained: undefined } })).toBe(false);
  for (const config of [STAFF_PERSONALITIES, FRONT_DESK_STAFF, STAFF_CLEANING_SUPPORT]) {
    config.enabled = false;
    expect(cleaningTrained(member)).toBe(false);
    config.enabled = true;
  }
  expect(syncStaff(createStarterHotel()).staffRoster!.some(cleaningTrained)).toBe(false);
});

it('cleans by room-work experience, style and fatigue without borrowing reception hospitality speed', () => {
  const clerk: StaffMember = { id: 'clerk', role: 'front_desk', at: null,
    profile: { experience: 'veteran', style: 'meticulous', reliability: 'dependable', hospitality: 'warm', cleaningTrained: true },
    stats: { workHours: 400, lateDays: 0, absentDays: 0, fatigue: 0 } };
  const curt = { ...clerk, profile: { ...clerk.profile!, hospitality: 'curt' as const } };
  expect(staffRate(clerk)).not.toBe(staffRate(curt));
  expect(cleaningRate(clerk)).toBeCloseTo(1.2 / 1.25);
  expect(cleaningRate(curt)).toBe(cleaningRate(clerk));
  expect(cleaningRate({ ...clerk, stats: { ...clerk.stats!, fatigue: 60 } })).toBeCloseTo(1.2 / 1.25 * 0.85);
  expect(cleaningRate({ ...clerk, profile: { ...clerk.profile!, legacy: true } })).toBe(1);
});
