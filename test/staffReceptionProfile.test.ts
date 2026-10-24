import { afterEach, expect, it } from 'vitest';
import { FRONT_DESK_STAFF, STAFF_CROSS_TRAINING, STAFF_PERSONALITIES } from '../src/config/staff.js';
import { createStarterHotel } from '../src/simulation/HotelState.js';
import { hash01 } from '../src/simulation/Movement.js';
import { candidatesFor, afterWork, receptionTrained, staffRate, staffWage } from '../src/simulation/StaffProfiles.js';
import { hireCandidate } from '../src/simulation/StaffHiring.js';
import { syncStaff } from '../src/simulation/StaffManager.js';
import type { StaffMember } from '../src/simulation/types.js';

const candidateChance = STAFF_CROSS_TRAINING.candidateChance;

afterEach(() => {
  STAFF_CROSS_TRAINING.enabled = true;
  STAFF_CROSS_TRAINING.candidateChance = candidateChance;
  STAFF_PERSONALITIES.enabled = true;
  FRONT_DESK_STAFF.enabled = true;
});

it('adds deterministic reception training only to housekeeper offers while preserving all other offer fields', () => {
  const trainedOffers = Array.from({ length: 20 }, (_, day) => candidatesFor(day + 1, 'housekeeper')).flat();
  expect(trainedOffers.some(receptionTrained)).toBe(true);
  expect(trainedOffers.some(member => !receptionTrained(member))).toBe(true);
  for (const offer of trainedOffers) expect(receptionTrained(offer)).toBe(hash01(`${offer.id}|reception-training`) < candidateChance);
  const otherRoles = ['maintenance', 'front_desk'] as const;
  const otherOffers = otherRoles.map(role => candidatesFor(7, role));
  STAFF_CROSS_TRAINING.enabled = false;
  const originalOffers = Array.from({ length: 20 }, (_, day) => candidatesFor(day + 1, 'housekeeper')).flat();
  trainedOffers.forEach((offer, index) => {
    const { receptionTrained: trained, ...originalProfile } = offer.profile;
    expect({ ...offer, profile: originalProfile, dailyWage: originalOffers[index].dailyWage }).toEqual(originalOffers[index]);
    expect(offer.dailyWage).toBe(trained ? Math.round(originalOffers[index].dailyWage * 1.15 * 100) / 100 : originalOffers[index].dailyWage);
  });
  otherRoles.forEach((role, index) => expect(candidatesFor(7, role)).toEqual(otherOffers[index]));
});

it('requires the capability, both parent features, and a housekeeper when a role is supplied', () => {
  const profile = { experience: 'skilled', style: 'standard', reliability: 'dependable', receptionTrained: true } as const;
  expect(receptionTrained({ profile })).toBe(true);
  expect(receptionTrained({ profile, role: 'housekeeper' })).toBe(true);
  expect(receptionTrained({ profile: { ...profile, receptionTrained: undefined }, role: 'housekeeper' })).toBe(false);
  expect(receptionTrained({ profile, role: 'maintenance' })).toBe(false);
  expect(receptionTrained({ profile, role: 'front_desk' })).toBe(false);
  FRONT_DESK_STAFF.enabled = false;
  expect(receptionTrained({ profile, role: 'housekeeper' })).toBe(false);
  FRONT_DESK_STAFF.enabled = true;
  STAFF_PERSONALITIES.enabled = false;
  expect(receptionTrained({ profile, role: 'housekeeper' })).toBe(false);
  STAFF_PERSONALITIES.enabled = true;
  STAFF_CROSS_TRAINING.enabled = false;
  expect(receptionTrained({ profile, role: 'housekeeper' })).toBe(false);
});

it('stores the premium once at hire and keeps normal cleaning, wages, and promotion ratios', () => {
  STAFF_CROSS_TRAINING.candidateChance = 1;
  const state = syncStaff(createStarterHotel());
  const candidate = candidatesFor(state.day, 'housekeeper').find(offer => offer.profile.experience === 'rookie')!;
  expect(candidate).toBeDefined();
  const hired = hireCandidate(state, 'housekeeper', candidate.id)!;
  const member = hired.staffRoster!.find(person => person.candidateId === candidate.id)!;
  expect(member.dailyWage).toBe(candidate.dailyWage);
  expect(receptionTrained(member)).toBe(true);
  expect(staffRate(member)).toBe(staffRate({ ...member, profile: { ...member.profile!, receptionTrained: undefined } }));
  expect(staffWage(afterWork(member, 0, state.day))).toBe(candidate.dailyWage);
  const promoted = afterWork(member, 80, state.day);
  expect(promoted.dailyWage).toBe(Math.round(candidate.dailyWage / STAFF_PERSONALITIES.experienceWage.rookie * 100) / 100);
  expect(promoted.profile?.receptionTrained).toBe(true);
  STAFF_CROSS_TRAINING.enabled = false;
  expect(staffWage(member)).toBe(candidate.dailyWage);
  const older: StaffMember = { ...member, profile: { ...member.profile!, receptionTrained: undefined }, dailyWage: 70 };
  expect(staffWage(afterWork(older, 0, state.day))).toBe(70);
  expect(receptionTrained(older)).toBe(false);
});
