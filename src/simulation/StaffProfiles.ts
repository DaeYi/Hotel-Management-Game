import type { StaffMember, StaffRole, FrontDeskShift, HotelState } from './types.js';
import { STAFF, GUEST_NAMES, SURNAMES, HOUSEKEEPING } from '../config/balance.js';
import { STAFF_PERSONALITIES as RULES, FRONT_DESK_STAFF, STAFF_SPECIALTIES, STAFF_HOSPITALITY, STAFF_FATIGUE } from '../config/staff.js';
import { fatigueRate } from './StaffFatigue.js';
import { hash01 } from './Movement.js';
import { pick } from './Party.js';

export type Experience = 'rookie' | 'skilled' | 'veteran';
export type WorkStyle = 'speedy' | 'standard' | 'meticulous';
export type Reliability = 'dependable' | 'normal' | 'flaky';
export type Hospitality = 'warm' | 'polite' | 'curt';
export type Stamina = 'low' | 'normal' | 'high';
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
  stamina?: Stamina; // absent on older saves: normal, with fresh energy
  legacy?: boolean; // existing staff keep their original performance and wage
}

export interface StaffStats {
  workHours: number;
  lateDays: number;
  absentDays: number;
  attendanceDay?: number;
  fatigue?: number;
  fatigueAt?: number; // absolute hour at which fatigue was last committed
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
  const base = !RULES.enabled || !member.profile || member.profile.legacy ? 1
    : RULES.experienceRate[experienceOf(member)] / RULES.styleTime[member.profile.style];
  return base * fatigueRate(member);
}

export function checkInHours(member: StaffIdentity): number {
  const hours = !frontDeskOn() || member.profile?.legacy ? 1 / STAFF.frontDesk.checkInsPerHour : FRONT_DESK_STAFF.checkInMinutes[experienceOf(member)] / 60;
  return hours * STAFF_HOSPITALITY.checkInTime[hospitalityOf(member)];
}

interface StaffDuty {
  day: number;
  start: number;
  end: number;
  absent: boolean;
  lateHours: number;
  available: number;
}
interface CachedDuties {
  id: string;
  role: StaffRole;
  shift?: FrontDeskShift;
  startHour: number;
  endHour: number;
  hiredAt?: number;
  restUntil?: number;
  enabled: boolean;
  reliability?: Reliability;
  legacy?: boolean;
  absentChance: number;
  lateChance: number;
  days: Map<number, StaffDuty>;
}
// A person is immutable during ordinary play. Checking the scheduling inputs
// also keeps paused edits, migrations and mutable balance settings correct.
const dutyCache = new WeakMap<Worker, CachedDuties>();

/** A shift is keyed by its starting day; the night shift keeps that day's attendance after midnight. */
export function staffDuty(member: Worker, day: number): StaffDuty {
  const shift = member.role === 'front_desk' ? FRONT_DESK_STAFF.shifts[member.shift ?? 'late'] : undefined;
  const roomShift = member.role === 'housekeeper' ? STAFF.housekeeping : STAFF.maintenance;
  const startHour = shift?.start ?? roomShift.workStartHour, endHour = shift?.end ?? roomShift.workEndHour;
  const reliability = member.profile?.reliability, legacy = member.profile?.legacy;
  const absentChance = reliability ? RULES.absentChance[reliability] : 0;
  const lateChance = reliability ? RULES.lateChance[reliability] : 0;
  let cached = dutyCache.get(member);
  if (!cached || cached.id !== member.id || cached.role !== member.role || cached.shift !== member.shift
    || cached.startHour !== startHour || cached.endHour !== endHour || cached.hiredAt !== member.hiredAt
    || cached.restUntil !== member.restUntil || cached.enabled !== RULES.enabled || cached.legacy !== legacy
    || cached.reliability !== reliability || cached.absentChance !== absentChance || cached.lateChance !== lateChance) {
    cached = { id: member.id, role: member.role, shift: member.shift, startHour, endHour, hiredAt: member.hiredAt,
      restUntil: member.restUntil, enabled: RULES.enabled, reliability, legacy, absentChance, lateChance, days: new Map() };
    dutyCache.set(member, cached);
  }
  const previous = cached.days.get(day);
  if (previous) return previous;
  const start = (day - 1) * 24 + startHour, end = (day - 1) * 24 + endHour;
  const a = attendance(member, day);
  const duty = Object.freeze({ day, start, end, absent: a.absent, lateHours: a.lateHours,
    available: Math.max(start + a.lateHours, member.hiredAt ?? -Infinity, member.restUntil ?? -Infinity) });
  if (cached.days.size >= 8) cached.days.delete(cached.days.keys().next().value!);
  cached.days.set(day, duty);
  return duty;
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

const neutralAttendance = Object.freeze({ absent: false, lateHours: 0 });
const attendanceCache = new Map<string, { absent: boolean; lateHours: number }>();
const MAX_ATTENDANCE_CACHE = 4096;

export function attendance(member: Worker, day: number): { absent: boolean; lateHours: number } {
  const reliability = member.profile?.reliability;
  if (!RULES.enabled || !reliability || member.profile?.legacy) return neutralAttendance;
  const absentChance = RULES.absentChance[reliability], lateChance = RULES.lateChance[reliability];
  if (absentChance <= 0 && lateChance <= 0) return neutralAttendance;
  const cacheKey = `${member.id}|${day}|${reliability}|${absentChance}|${lateChance}`;
  const previous = attendanceCache.get(cacheKey);
  if (previous) return previous;
  const key = `${member.id}|${day}`;
  const absent = absentChance > 0 && hash01(`${key}|absent`) < absentChance;
  const late = !absent && lateChance > 0 && hash01(`${key}|late`) < lateChance;
  const lateHours = !late ? 0 : reliability === 'flaky' ? 0.5 + 1.5 * hash01(`${key}|minutes`) : hash01(`${key}|minutes`);
  const result = Object.freeze({ absent, lateHours });
  if (attendanceCache.size >= MAX_ATTENDANCE_CACHE) attendanceCache.delete(attendanceCache.keys().next().value!);
  attendanceCache.set(cacheKey, result);
  return result;
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
      ...(STAFF_FATIGUE.enabled ? { stamina: pick<Stamina>([['low', 0.25], ['normal', 0.5], ['high', 0.25]], hash01(`${id}|stamina`)) } : {}),
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
      ...stats,
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
