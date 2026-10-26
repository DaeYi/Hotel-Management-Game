import { expect, it } from 'vitest';
import { FRONT_DESK_STAFF, STAFF_FATIGUE, STAFF_HOSPITALITY, STAFF_PERSONALITIES, STAFF_SPECIALTIES, STAFF_CROSS_TRAINING, STAFF_CLEANING_SUPPORT } from '../src/config/staff.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { attendance, staffDuty } from '../src/simulation/StaffProfiles.js';
import type { StaffMember } from '../src/simulation/types.js';

it('with fatigue disabled preserves the named-staff game’s pinned 60-day balance', () => {
  const switches = [STAFF_PERSONALITIES, FRONT_DESK_STAFF, STAFF_SPECIALTIES, STAFF_HOSPITALITY, STAFF_FATIGUE, STAFF_CROSS_TRAINING, STAFF_CLEANING_SUPPORT];
  const original = switches.map(setting => setting.enabled);
  try {
    for (const setting of switches) setting.enabled = true;
    STAFF_FATIGUE.enabled = false;
    STAFF_CROSS_TRAINING.enabled = false;
    STAFF_CLEANING_SUPPORT.enabled = false;
    // Measured against the full pre-fatigue game at 8e1131d, with all the
    // existing named-staff features enabled, rather than its anonymous fallback.
    const result = simulate(60, 9, undefined, STRATEGIES.balanced);
    expect(result.finalCash).toBeCloseTo(19356.74175, 6);
    expect(result.totalRevenue).toBe(108498);
    expect(result.totalTurnedAway).toBe(473);
    expect(result.avgReviewScore).toBeCloseTo(7.626849345037274, 10);
    expect(result.finalRoomCount).toBe(21);
    expect(result.finalStarRating).toBe(3);
    expect(result.wentBankrupt).toBe(false);
    expect(result.objectivesCompleted).toBe(6);
    expect(result.objectivesFailed).toBe(0);
  } finally {
    switches.forEach((setting, index) => { setting.enabled = original[index]; });
  }
}, 120000);

it('attendance and duty quotes follow live profile, identity and scheduling edits', () => {
  const member: StaffMember = { id: 'edited-clerk', role: 'front_desk', shift: 'early', at: null,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable' } };
  expect(staffDuty(member, 2)).toMatchObject({ start: 30, end: 38, available: 30, absent: false, lateHours: 0 });
  member.hiredAt = 31;
  member.restUntil = 32;
  expect(staffDuty(member, 2).available).toBe(32);
  member.shift = 'night';
  expect(staffDuty(member, 2)).toMatchObject({ start: 46, end: 54, available: 46 });
  member.profile!.reliability = 'flaky';
  let absentDay = 1;
  while (!attendance(member, absentDay).absent) absentDay++;
  expect(staffDuty(member, absentDay).absent).toBe(true);
  member.profile!.legacy = true;
  expect(staffDuty(member, absentDay)).toMatchObject({ absent: false, lateHours: 0 });
  member.profile!.legacy = false;
  member.id = 'replacement-clerk';
  expect(staffDuty(member, absentDay).absent).toBe(attendance({ ...member }, absentDay).absent);
  const enabled = STAFF_PERSONALITIES.enabled;
  try {
    STAFF_PERSONALITIES.enabled = false;
    expect(staffDuty(member, absentDay)).toMatchObject({ absent: false, lateHours: 0 });
  } finally { STAFF_PERSONALITIES.enabled = enabled; }
});

it('balance-setting edits invalidate attendance and shift quotes without stale cached results', () => {
  const member: StaffMember = { id: 'retuned-clerk', role: 'front_desk', shift: 'early', at: null,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable' } };
  const absent = STAFF_PERSONALITIES.absentChance.dependable, late = STAFF_PERSONALITIES.lateChance.dependable;
  const start = FRONT_DESK_STAFF.shifts.early.start, end = FRONT_DESK_STAFF.shifts.early.end;
  try {
    expect(attendance(member, 2)).toEqual({ absent: false, lateHours: 0 });
    expect(staffDuty(member, 2)).toMatchObject({ start: 30, end: 38 });
    STAFF_PERSONALITIES.absentChance.dependable = 1;
    expect(attendance(member, 2).absent).toBe(true);
    expect(staffDuty(member, 2).absent).toBe(true);
    STAFF_PERSONALITIES.absentChance.dependable = 0;
    STAFF_PERSONALITIES.lateChance.dependable = 1;
    expect(attendance(member, 2).lateHours).toBeGreaterThan(0);
    expect(staffDuty(member, 2).available).toBeGreaterThan(30);
    FRONT_DESK_STAFF.shifts.early.start = 8;
    FRONT_DESK_STAFF.shifts.early.end = 16;
    expect(staffDuty(member, 2)).toMatchObject({ start: 32, end: 40 });
  } finally {
    STAFF_PERSONALITIES.absentChance.dependable = absent;
    STAFF_PERSONALITIES.lateChance.dependable = late;
    FRONT_DESK_STAFF.shifts.early.start = start;
    FRONT_DESK_STAFF.shifts.early.end = end;
  }
  expect(attendance(member, 2)).toEqual({ absent: false, lateHours: 0 });
  expect(staffDuty(member, 2)).toMatchObject({ start: 30, end: 38 });
});
