import type { StaffMember, StaffRole } from './types.js';
import { STAFF, GUEST_NAMES, SURNAMES, HOUSEKEEPING } from '../config/balance.js';
import { STAFF_PERSONALITIES as RULES } from '../config/staff.js';
import { hash01 } from './Movement.js';
import { pick } from './Party.js';

export type Experience = 'rookie' | 'skilled' | 'veteran';
export type WorkStyle = 'speedy' | 'standard' | 'meticulous';
export type Reliability = 'dependable' | 'normal' | 'flaky';

export interface StaffProfile {
  experience: Experience; // the grade at hire; current grade follows workHours
  style: WorkStyle;
  reliability: Reliability;
  legacy?: boolean; // existing staff keep their original performance and wage
}

export interface StaffStats {
  workHours: number;
  lateDays: number;
  absentDays: number;
  attendanceDay?: number;
}

export interface StaffIdentity {
  serial?: number;
  name?: string;
  hiredDay?: number;
  dailyWage?: number;
  profile?: StaffProfile;
  stats?: StaffStats;
  candidateId?: string;
}

type Worker = StaffMember & StaffIdentity;
export interface StaffCandidate {
  id: string;
  role: StaffRole;
  name: string;
  profile: StaffProfile;
  dailyWage: number;
  workHours: number;
}

export const roleLabel = (role: StaffRole) => role === 'housekeeper' ? 'Housekeeper' : 'Maintenance';
export const baseWage = (role: StaffRole) => (role === 'housekeeper' ? STAFF.housekeeping : STAFF.maintenance).dailyWage;
export const shiftFor = (role: StaffRole) => role === 'housekeeper' ? STAFF.housekeeping : STAFF.maintenance;
const money = (n: number) => Math.round(n * 100) / 100;

export function experienceOf(member: StaffIdentity): Experience {
  const hours = member.stats?.workHours;
  return hours === undefined ? member.profile?.experience ?? 'skilled'
    : hours >= RULES.experienceHours.veteran ? 'veteran' : hours >= RULES.experienceHours.skilled ? 'skilled' : 'rookie';
}

/** Work units per real hour in the room. Walks never get this multiplier. */
export function staffRate(member: StaffIdentity): number {
  return !RULES.enabled || !member.profile || member.profile.legacy ? 1
    : RULES.experienceRate[experienceOf(member)] / RULES.styleTime[member.profile.style];
}

export function staffWage(member: Worker): number {
  return !RULES.enabled ? baseWage(member.role) : member.dailyWage ?? baseWage(member.role);
}

export function cleanlinessDelta(member: StaffIdentity | undefined): number {
  return !RULES.enabled || !member?.profile || member.profile.legacy ? 0 : RULES.cleanlinessDelta[member.profile.style];
}

export function repairTarget(member: StaffIdentity | undefined): number | null {
  return !RULES.enabled || !member?.profile || member.profile.legacy ? null : RULES.repairTarget[member.profile.style];
}

export function attendance(member: Worker, day: number): { absent: boolean; lateHours: number } {
  const reliability = member.profile?.reliability;
  if (!RULES.enabled || !reliability || member.profile?.legacy) return { absent: false, lateHours: 0 };
  const key = `${member.id}|${day}`;
  const absent = hash01(`${key}|absent`) < RULES.absentChance[reliability];
  const late = !absent && hash01(`${key}|late`) < RULES.lateChance[reliability];
  const lateHours = !late ? 0 : reliability === 'flaky' ? 0.5 + 1.5 * hash01(`${key}|minutes`) : hash01(`${key}|minutes`);
  return { absent, lateHours };
}

/** One person's next on-duty moment, accounting for their daily attendance. */
export function nextStaffWork(member: Worker, t: number): number {
  const shift = shiftFor(member.role);
  let day = Math.floor(t / 24) + 1;
  for (let tries = 0; tries < 366; tries++, day++) {
    const a = attendance(member, day);
    if (a.absent) continue;
    const start = (day - 1) * 24 + shift.workStartHour + a.lateHours;
    const end = (day - 1) * 24 + shift.workEndHour;
    if (t < end) return Math.max(t, start);
  }
  return Infinity;
}

/** A deterministic shortlist. Hired slots are replaced, and stay consumed through reloads. */
export function candidatesFor(day: number, role: StaffRole, used: readonly string[] = []): StaffCandidate[] {
  const result: StaffCandidate[] = [];
  const taken = new Set(used);
  for (let slot = 0; result.length < 3; slot++) {
    const id = `${role}|${day}|${slot}`;
    if (taken.has(id)) continue;
    const experience = pick<Experience>([['rookie', 0.6], ['skilled', 0.3], ['veteran', 0.1]], hash01(`${id}|experience`));
    const style = pick<WorkStyle>([['speedy', 0.25], ['standard', 0.5], ['meticulous', 0.25]], hash01(`${id}|style`));
    const reliability = pick<Reliability>([['dependable', 0.25], ['normal', 0.5], ['flaky', 0.25]], hash01(`${id}|reliability`));
    const profile = { experience, style, reliability };
    const dailyWage = money(baseWage(role) * RULES.experienceWage[experience] * RULES.reliabilityWage[reliability]);
    const workHours = experience === 'rookie' ? 0 : RULES.experienceHours[experience];
    result.push({ id, role, name: staffName(id), profile, dailyWage, workHours });
  }
  return result;
}

export function staffName(key: string): string {
  return `${GUEST_NAMES[Math.floor(hash01(`${key}|name`) * GUEST_NAMES.length)]} ${SURNAMES[Math.floor(hash01(`${key}|surname`) * SURNAMES.length)]}`;
}

/** Quality, throughput, attendance and wages all count in the quick-hire shortcut. */
export function staffValue(member: Worker, turnoverTarget = 85): number {
  const profile = member.profile;
  const reliability = profile?.reliability ?? 'dependable';
  const attendanceShare = 1 - RULES.absentChance[reliability] - RULES.lateChance[reliability] * (reliability === 'flaky' ? 1.25 : 0.5) / 14;
  const quality = member.role === 'housekeeper'
    ? Math.max(1, Math.min(100, turnoverTarget + cleanlinessDelta(member))) / turnoverTarget
      * (HOUSEKEEPING.dailyCleaningBoost + cleanlinessDelta(member)) / HOUSEKEEPING.dailyCleaningBoost
    : (repairTarget(member) ?? 90) / 90;
  return staffRate(member) * quality * attendanceShare / staffWage(member);
}

/** Expected attendance across a full housekeeping shift, for staffing estimates. */
export function attendanceShare(member: Worker): number {
  if (!RULES.enabled || !member.profile || member.profile.legacy) return 1;
  const r = member.profile.reliability;
  const shift = shiftFor(member.role);
  return 1 - RULES.absentChance[r] - RULES.lateChance[r] * (r === 'flaky' ? 1.25 : 0.5) / (shift.workEndHour - shift.workStartHour);
}

/** Only time actually spent cleaning or repairing grows experience. Promotions adjust the agreed wage. */
export function afterWork(member: Worker, hours: number, day: number): Worker {
  if (!RULES.enabled || !member.profile) return member;
  const stats = member.stats ?? { workHours: RULES.experienceHours.skilled, lateDays: 0, absentDays: 0 };
  const a = attendance(member, day);
  const next = {
    ...member,
    stats: {
      workHours: stats.workHours + hours,
      lateDays: stats.lateDays + (stats.attendanceDay !== day && a.lateHours > 0 ? 1 : 0),
      absentDays: stats.absentDays + (stats.attendanceDay !== day && a.absent ? 1 : 0),
      attendanceDay: day,
    },
  };
  const before = experienceOf(member), after = experienceOf(next);
  if (before !== after) {
    next.dailyWage = money(staffWage(member) * RULES.experienceWage[after] / RULES.experienceWage[before]);
    next.profile = { ...member.profile, legacy: undefined };
  }
  return next;
}
