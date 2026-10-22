import type { StaffMember, StaffRole, FrontDeskShift, HotelState } from './types.js';
import { STAFF, GUEST_NAMES, SURNAMES, HOUSEKEEPING } from '../config/balance.js';
import { STAFF_PERSONALITIES as RULES, FRONT_DESK_STAFF, STAFF_SPECIALTIES, STAFF_HOSPITALITY } from '../config/staff.js';
import { hash01 } from './Movement.js';
import { pick } from './Party.js';

export type Experience = 'rookie' | 'skilled' | 'veteran';
export type WorkStyle = 'speedy' | 'standard' | 'meticulous';
export type Reliability = 'dependable' | 'normal' | 'flaky';
export type Hospitality = 'warm' | 'polite' | 'curt';
export type StaffSpecialty = 'turnover_runner' | 'room_attendant' | 'responder' | 'preventive' | 'greeter' | 'upseller' | 'concierge';

const SPECIALTIES: Record<StaffRole, StaffSpecialty[]> = {
  housekeeper: ['turnover_runner', 'room_attendant'],
  maintenance: ['responder', 'preventive'],
  front_desk: ['greeter', 'upseller', 'concierge'],
};
const SPECIALTY_LABELS: Record<StaffSpecialty, string> = {
  turnover_runner: 'Turnover runner', room_attendant: 'Room attendant', responder: 'Responder',
  preventive: 'Preventive', greeter: 'Greeter', upseller: 'Upseller', concierge: 'Concierge',
};
export const specialtiesFor = (role: StaffRole): StaffSpecialty[] => SPECIALTIES[role];
export const specialtyLabel = (specialty: StaffSpecialty): string => SPECIALTY_LABELS[specialty];
export function specialtyOf(member: StaffMember): StaffSpecialty {
  const options = specialtiesFor(member.role);
  return RULES.enabled && STAFF_SPECIALTIES.enabled && options.includes(member.profile?.specialty as StaffSpecialty)
    ? member.profile!.specialty! : options[0];
}
export function hospitalityOf(member: StaffIdentity): Hospitality {
  const value = member.profile?.hospitality;
  return RULES.enabled && STAFF_HOSPITALITY.enabled && (value === 'warm' || value === 'curt') ? value : 'polite';
}

export interface StaffProfile {
  experience: Experience; // the grade at hire; current grade follows workHours
  style: WorkStyle;
  reliability: Reliability;
  specialty?: StaffSpecialty; // absent on older saves: the role's original priority
  hospitality?: Hospitality; // absent on older saves: polite (neutral)
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
  nightPremium?: boolean; // whether the agreed front desk wage already includes the night premium
}

type Worker = StaffMember & StaffIdentity;
export interface StaffCandidate {
  id: string;
  role: StaffRole;
  name: string;
  profile: StaffProfile;
  dailyWage: number;
  workHours: number;
  shift?: FrontDeskShift;
}

export const frontDeskOn = () => RULES.enabled && FRONT_DESK_STAFF.enabled;
export const namedFrontDesk = (state: HotelState) => frontDeskOn() && !!state.frontDeskRosterReady;
export const roleLabel = (role: StaffRole) => role === 'housekeeper' ? 'Housekeeper' : role === 'front_desk' ? 'Front desk' : 'Maintenance';
export const baseWage = (role: StaffRole) => role === 'front_desk' ? STAFF.frontDesk.dailyWage * FRONT_DESK_STAFF.shiftWage : (role === 'housekeeper' ? STAFF.housekeeping : STAFF.maintenance).dailyWage;
export const shiftFor = (role: StaffRole, shift: FrontDeskShift = 'late') => role === 'front_desk'
  ? { workStartHour: FRONT_DESK_STAFF.shifts[shift].start, workEndHour: FRONT_DESK_STAFF.shifts[shift].end }
  : role === 'housekeeper' ? STAFF.housekeeping : STAFF.maintenance;
const money = (n: number) => Math.round(n * 100) / 100;

export function experienceOf(member: StaffIdentity): Experience {
  const hours = member.stats?.workHours;
  return hours === undefined ? member.profile?.experience ?? 'skilled'
    : hours >= RULES.experienceHours.veteran ? 'veteran' : hours >= RULES.experienceHours.skilled ? 'skilled' : 'rookie';
}

/** Work units per real hour in the room. Walks never get this multiplier. */
export function staffRate(member: StaffIdentity): number {
  if ((member as StaffMember).role === 'front_desk') return 1 / (3 * checkInHours(member));
  return !RULES.enabled || !member.profile || member.profile.legacy ? 1
    : RULES.experienceRate[experienceOf(member)] / RULES.styleTime[member.profile.style];
}

export function checkInHours(member: StaffIdentity): number {
  const hours = !frontDeskOn() || member.profile?.legacy ? 1 / STAFF.frontDesk.checkInsPerHour : FRONT_DESK_STAFF.checkInMinutes[experienceOf(member)] / 60;
  return hours * STAFF_HOSPITALITY.checkInTime[hospitalityOf(member)];
}

/** A shift is keyed by its starting day; the night shift keeps that day's attendance after midnight. */
export function staffDuty(member: Worker, day: number) {
  const shift = shiftFor(member.role, member.shift);
  const start = (day - 1) * 24 + shift.workStartHour;
  const end = (day - 1) * 24 + shift.workEndHour;
  const a = attendance(member, day);
  return { day, start, end, ...a, available: Math.max(start + a.lateHours, member.hiredAt ?? -Infinity, member.restUntil ?? -Infinity) };
}

export function staffDutyAt(member: Worker, t: number) {
  const shift = shiftFor(member.role, member.shift);
  return staffDuty(member, Math.floor((t - shift.workStartHour) / 24) + 1);
}

/** Paid shift hours in an interval, including night shifts crossing a day boundary. */
export function deskPaidHours(member: Worker, from: number, to: number): number {
  let hours = 0;
  for (let day = Math.floor(from / 24); day <= Math.floor(to / 24) + 1; day++) {
    const duty = staffDuty(member, day);
    if (!duty.absent) hours += Math.max(0, Math.min(to, duty.end, member.dismissedAt ?? Infinity) - Math.max(from, duty.available));
  }
  return hours;
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
  let day = staffDutyAt(member, t).day;
  for (let tries = 0; tries < 366; tries++, day++) {
    const duty = staffDuty(member, day);
    if (!duty.absent && Math.max(t, duty.available) < duty.end) return Math.max(t, duty.available);
  }
  return Infinity;
}

/** A deterministic shortlist. Hired slots are replaced, and stay consumed through reloads. */
export function candidatesFor(day: number, role: StaffRole, used: readonly string[] = [], shift: FrontDeskShift = 'late'): StaffCandidate[] {
  const result: StaffCandidate[] = [];
  const taken = new Set(used);
  for (let slot = 0; result.length < 3; slot++) {
    const id = `${role}|${day}|${slot}`;
    if (taken.has(id)) continue;
    const experience = pick<Experience>([['rookie', 0.6], ['skilled', 0.3], ['veteran', 0.1]], hash01(`${id}|experience`));
    const style = role === 'front_desk' ? 'standard' : pick<WorkStyle>([['speedy', 0.25], ['standard', 0.5], ['meticulous', 0.25]], hash01(`${id}|style`));
    const reliability = pick<Reliability>([['dependable', 0.25], ['normal', 0.5], ['flaky', 0.25]], hash01(`${id}|reliability`));
    const options = specialtiesFor(role);
    const specialty = options[Math.floor(hash01(`${id}|specialty`) * options.length)];
    const hospitality = role === 'maintenance' ? 'polite' : pick<Hospitality>([['warm', 0.25], ['polite', 0.5], ['curt', 0.25]], hash01(`${id}|hospitality`));
    const profile: StaffProfile = { experience, style, reliability,
      ...(STAFF_SPECIALTIES.enabled ? { specialty } : {}), ...(STAFF_HOSPITALITY.enabled ? { hospitality } : {}) };
    const dailyWage = money(baseWage(role) * RULES.experienceWage[experience] * RULES.reliabilityWage[reliability]
      * (STAFF_HOSPITALITY.enabled ? STAFF_HOSPITALITY.wage[hospitality] : 1)
      * (role === 'front_desk' && shift === 'night' ? FRONT_DESK_STAFF.nightPremium : 1));
    const workHours = experience === 'rookie' ? 0 : RULES.experienceHours[experience];
    result.push({ id, role, name: staffName(id), profile, dailyWage, workHours, ...(role === 'front_desk' ? { shift } : {}) });
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
    : member.role === 'front_desk' ? 1 : (repairTarget(member) ?? 90) / 90;
  return staffRate(member) * quality * attendanceShare / staffWage(member);
}

/** Expected attendance across a full housekeeping shift, for staffing estimates. */
export function attendanceShare(member: Worker): number {
  if (!RULES.enabled || !member.profile || member.profile.legacy) return 1;
  const r = member.profile.reliability;
  const shift = shiftFor(member.role, member.shift);
  return 1 - RULES.absentChance[r] - RULES.lateChance[r] * (r === 'flaky' ? 1.25 : 0.5) / (shift.workEndHour - shift.workStartHour);
}

/** Actual cleaning, repairs and desk service grow experience. Promotions adjust the agreed wage. */
export function afterWork(member: Worker, hours: number, day: number, recordAttendance = true): Worker {
  if (!RULES.enabled || !member.profile) return member;
  const stats = member.stats ?? { workHours: RULES.experienceHours.skilled, lateDays: 0, absentDays: 0 };
  const a = attendance(member, day);
  const next = {
    ...member,
    stats: {
      workHours: stats.workHours + hours,
      lateDays: stats.lateDays + (recordAttendance && stats.attendanceDay !== day && a.lateHours > 0 ? 1 : 0),
      absentDays: stats.absentDays + (recordAttendance && stats.attendanceDay !== day && a.absent ? 1 : 0),
      attendanceDay: recordAttendance ? day : stats.attendanceDay,
    },
  };
  const before = experienceOf(member), after = experienceOf(next);
  if (before !== after) {
    next.dailyWage = money(staffWage(member) * RULES.experienceWage[after] / RULES.experienceWage[before]);
    next.profile = { ...member.profile, legacy: undefined };
  }
  return next;
}
