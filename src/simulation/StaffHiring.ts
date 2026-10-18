import type { HotelState, StaffMember, StaffRole, FrontDeskShift } from './types.js';
import { STAFF_PERSONALITIES, FRONT_DESK_STAFF } from '../config/staff.js';
import { HOUSEKEEPING, STAFF } from '../config/balance.js';
import { candidatesFor, staffName, staffValue, baseWage, frontDeskOn, namedFrontDesk, staffDutyAt, deskPaidHours, type StaffCandidate } from './StaffProfiles.js';
import { hourStart } from './Movement.js';
import { physicalDeskLanes } from './FrontDesk.js';

export const staffKey = (role: StaffRole) => role === 'housekeeper' ? 'housekeepers' : role === 'front_desk' ? 'frontDesk' : 'maintenanceWorkers';

/** Older 24-hour positions become three named shifts, preserving coverage and the agreed total wage. */
export function initializeFrontDesk(state: HotelState, legacy = false): HotelState {
  if (!frontDeskOn() || state.frontDeskRosterReady) return state;
  if (state.staffRoster?.some(m => m.role === 'front_desk')) return { ...state, frontDeskRosterReady: true };
  const current = identifyStaff(state, state.staffRoster ?? []);
  const lanes = physicalDeskLanes(current);
  const count = legacy ? state.staff.frontDesk * 3 : state.staff.frontDesk;
  const roster = [...current.staffRoster!];
  const legacyWage = Math.round(STAFF.frontDesk.dailyWage * 100 / 3) / 100;
  let serial = current.nextStaffSerial!;
  for (let i = 0; i < count; i++) {
    const shift = (['early', 'late', 'night'] as const)[i % 3];
    const id = `front_desk-${serial}`;
    const onDuty = shift === 'night' ? state.hour >= 22 || state.hour < 6 : shift === 'early' ? state.hour >= 6 && state.hour < 14 : state.hour >= 14 && state.hour < 22;
    const lane = lanes[Math.floor(i / 3)];
    roster.push({ id, serial: serial++, role: 'front_desk', shift, name: staffName(id), hiredDay: state.day, hiredAt: legacy ? undefined : 0, nightPremium: !legacy && shift === 'night',
      dailyWage: legacy ? Math.round((shift === 'night' ? STAFF.frontDesk.dailyWage - legacyWage * 2 : legacyWage) * 100) / 100
        : Math.round(baseWage('front_desk') * (shift === 'night' ? FRONT_DESK_STAFF.nightPremium : 1) * 100) / 100,
      profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', ...(legacy ? { legacy: true } : {}) },
      stats: { workHours: 80, lateDays: 0, absentDays: 0 }, at: onDuty && lane ? lane.front : null, deskLane: onDuty ? lane?.key : undefined });
  }
  const earned = { ...(current.staffPayroll?.[String(state.day)] ?? {}) };
  const through = { ...current.staffPayrollThrough };
  if (legacy) for (const m of roster.filter(m => m.role === 'front_desk')) {
    earned[m.id] = deskPaidHours(m, (state.day - 1) * 24, hourStart(state)) * (m.dailyWage ?? 0) / 8;
    through[m.id] = hourStart(state);
  }
  return { ...current, staff: { ...current.staff, frontDesk: count }, staffRoster: roster, nextStaffSerial: serial, frontDeskRosterReady: true,
    ...(legacy ? { staffPayroll: { ...current.staffPayroll, [String(state.day)]: earned }, staffPayrollThrough: through } : {}) };
}

/** Give existing workers a stable identity and neutral skills; never replace their IDs or positions. */
export function identifyStaff(state: HotelState, roster: StaffMember[]): HotelState {
  let serial = Math.max(state.nextStaffSerial ?? 1, ...roster.map(m => (m.serial ?? 0) + 1));
  const staffRoster = roster.map(m => {
    if (m.serial !== undefined && m.name && m.profile && m.stats && m.dailyWage !== undefined) return m;
    const id = m.serial ?? serial++;
    return {
      ...m, serial: id, name: m.name ?? staffName(m.id), hiredDay: m.hiredDay ?? 1,
      dailyWage: m.dailyWage ?? baseWage(m.role),
      profile: m.profile ?? { experience: 'skilled' as const, style: 'standard' as const, reliability: 'dependable' as const, legacy: true },
      stats: m.stats ?? { workHours: 80, lateDays: 0, absentDays: 0 },
    };
  });
  return { ...state, staffRoster, nextStaffSerial: serial };
}

export function hiringCandidates(state: HotelState, role: StaffRole, shift: FrontDeskShift = 'late'): StaffCandidate[] {
  const used = state.staffCandidatesUsed?.day === state.day ? state.staffCandidatesUsed.ids : [];
  return candidatesFor(state.day, role, used, shift);
}

/** Hire only a currently offered candidate; consuming the card is part of the saved state. */
export function hireCandidate(state: HotelState, role: StaffRole, candidateId: string, shift: FrontDeskShift = 'late', t = hourStart(state)): HotelState | null {
  if (!STAFF_PERSONALITIES.enabled) return null;
  if (role === 'front_desk' && !namedFrontDesk(state)) return null;
  const candidate = hiringCandidates(state, role, shift).find(c => c.id === candidateId);
  if (!candidate) return null;
  if (!state.staffRoster) return null; // initialize an older/count-only roster before offering hires
  let serial = Math.max(state.nextStaffSerial ?? 1, ...state.staffRoster.map(m => (m.serial ?? 0) + 1));
  while (state.staffRoster.some(m => m.id === `${role}-${serial}`)) serial++;
  const member: StaffMember = {
    id: `${role}-${serial}`, serial, role, name: candidate.name, hiredDay: state.day,
    profile: { ...candidate.profile }, dailyWage: candidate.dailyWage, at: null,
    ...(role === 'front_desk' ? { shift, hiredAt: t, nightPremium: shift === 'night' } : {}),
    stats: { workHours: candidate.workHours, lateDays: 0, absentDays: 0 }, candidateId,
  };
  const used = state.staffCandidatesUsed?.day === state.day ? state.staffCandidatesUsed.ids : [];
  const key = staffKey(role);
  return {
    ...state, staff: { ...state.staff, [key]: state.staff[key] + 1 },
    staffRoster: [...(state.staffRoster ?? []), member], nextStaffSerial: serial + 1,
    staffCandidatesUsed: { day: state.day, ids: [...used, candidateId] },
  };
}

/** The selected employee walks out; their identity is never transferred to a replacement. */
export function dismissStaff(state: HotelState, staffId: string, t = hourStart(state)): HotelState | null {
  const member = state.staffRoster?.find(m => m.id === staffId && !m.leaving);
  if (!member) return null;
  const key = staffKey(member.role);
  return {
    ...state, staff: { ...state.staff, [key]: Math.max(0, state.staff[key] - 1) },
    staffRoster: state.staffRoster!.map(m => m.id === staffId ? { ...m, leaving: true, roomId: undefined, dismissedAt: t } : m),
  };
}

/** Reconcile count shortcuts and bots through the same candidate and layoff rules as the UI. */
export function reconcileStaff(state: HotelState, roster: StaffMember[], t = hourStart(state)): HotelState {
  const onTheirWay = (id: string) => state.staffPlan?.start === hourStart(state) && state.staffPlan.itineraries.some(it => it.staffId === id && it.legs.length > 0);
  let current = identifyStaff(state, roster.filter(m => !(m.leaving && m.at === null && !m.carry && !onTheirWay(m.id))));
  const target = state.staff;
  const quality = HOUSEKEEPING.turnoverCleanlinessResult[state.housekeeping.turnoverQuality] ?? 85;
  for (const role of (namedFrontDesk(current) ? ['housekeeper', 'maintenance', 'front_desk'] : ['housekeeper', 'maintenance']) as StaffRole[]) {
    const key = staffKey(role), wanted = Math.max(0, Math.floor(target[key]));
    let staying = current.staffRoster!.filter(m => m.role === role && !m.leaving);
    // hireCandidate/dismissStaff update the count along with the roster.
    current = { ...current, staff: { ...current.staff, [key]: staying.length } };
    while (staying.length < wanted) {
      const shift = (['early', 'late', 'night'] as const).reduce((best, s) => staying.filter(m => m.shift === s).length < staying.filter(m => m.shift === best).length ? s : best, 'early' as FrontDeskShift);
      const options = hiringCandidates(current, role, shift);
      const best = options.reduce((a, b) => {
        const asMember = (c: StaffCandidate): StaffMember => ({ ...c, at: null, stats: { workHours: c.workHours, lateDays: 0, absentDays: 0 } });
        return staffValue(asMember(b), quality) > staffValue(asMember(a), quality) ? b : a;
      });
      current = hireCandidate(current, role, best.id, shift, t)!;
      staying = current.staffRoster!.filter(m => m.role === role && !m.leaving);
    }
    while (staying.length > wanted) {
      const coverage = (m: StaffMember) => role === 'front_desk' ? staying.filter(p => p.shift === m.shift).length : 0;
      const worst = [...staying].sort((a, b) => coverage(b) - coverage(a) || staffValue(a, quality) - staffValue(b, quality) || (b.serial ?? 0) - (a.serial ?? 0))[0];
      current = dismissStaff(current, worst.id, t)!;
      staying = current.staffRoster!.filter(m => m.role === role && !m.leaving);
    }
  }
  return current;
}

/** Change an off-duty clerk's next shift, with at most one shift in a rolling 24 hours. */
export function assignDeskShift(state: HotelState, id: string, shift: FrontDeskShift, t = hourStart(state)): HotelState | null {
  const member = state.staffRoster?.find(m => m.id === id && m.role === 'front_desk' && !m.leaving);
  if (!member || member.shift === shift || !(shift in FRONT_DESK_STAFF.shifts)) return null;
  const duty = staffDutyAt(member, t);
  if (t < duty.end) return null;
  const previousPremium = member.nightPremium ?? (member.shift === 'night' && !member.profile?.legacy);
  const wage = Math.round((member.dailyWage ?? baseWage(member.role)) / (previousPremium ? FRONT_DESK_STAFF.nightPremium : 1)
    * (shift === 'night' ? FRONT_DESK_STAFF.nightPremium : 1) * 100) / 100;
  const lastStart = Math.max(duty.start, member.hiredAt ?? -Infinity);
  const restUntil = lastStart < duty.end ? lastStart + 24 : t;
  return { ...state, staffRoster: state.staffRoster!.map(m => m.id === id ? { ...m, shift, restUntil: Math.max(m.restUntil ?? 0, restUntil), dailyWage: wage, nightPremium: shift === 'night' } : m) };
}
