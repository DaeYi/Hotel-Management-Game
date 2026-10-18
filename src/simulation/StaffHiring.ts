import type { HotelState, StaffMember, StaffRole } from './types.js';
import { STAFF_PERSONALITIES } from '../config/staff.js';
import { HOUSEKEEPING } from '../config/balance.js';
import { candidatesFor, staffName, staffValue, baseWage, type StaffCandidate } from './StaffProfiles.js';
import { hourStart } from './Movement.js';

export const staffKey = (role: StaffRole) => role === 'housekeeper' ? 'housekeepers' : 'maintenanceWorkers';

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

export function hiringCandidates(state: HotelState, role: StaffRole): StaffCandidate[] {
  const used = state.staffCandidatesUsed?.day === state.day ? state.staffCandidatesUsed.ids : [];
  return candidatesFor(state.day, role, used);
}

/** Hire only a currently offered candidate; consuming the card is part of the saved state. */
export function hireCandidate(state: HotelState, role: StaffRole, candidateId: string): HotelState | null {
  if (!STAFF_PERSONALITIES.enabled) return null;
  const candidate = hiringCandidates(state, role).find(c => c.id === candidateId);
  if (!candidate) return null;
  if (!state.staffRoster) return null; // initialize an older/count-only roster before offering hires
  let serial = Math.max(state.nextStaffSerial ?? 1, ...state.staffRoster.map(m => (m.serial ?? 0) + 1));
  while (state.staffRoster.some(m => m.id === `${role}-${serial}`)) serial++;
  const member: StaffMember = {
    id: `${role}-${serial}`, serial, role, name: candidate.name, hiredDay: state.day,
    profile: { ...candidate.profile }, dailyWage: candidate.dailyWage, at: null,
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
export function dismissStaff(state: HotelState, staffId: string): HotelState | null {
  const member = state.staffRoster?.find(m => m.id === staffId && !m.leaving);
  if (!member) return null;
  const key = staffKey(member.role);
  return {
    ...state, staff: { ...state.staff, [key]: Math.max(0, state.staff[key] - 1) },
    staffRoster: state.staffRoster!.map(m => m.id === staffId ? { ...m, leaving: true, roomId: undefined } : m),
  };
}

/** Reconcile count shortcuts and bots through the same candidate and layoff rules as the UI. */
export function reconcileStaff(state: HotelState, roster: StaffMember[]): HotelState {
  const onTheirWay = (id: string) => state.staffPlan?.start === hourStart(state) && state.staffPlan.itineraries.some(it => it.staffId === id && it.legs.length > 0);
  let current = identifyStaff(state, roster.filter(m => !(m.leaving && m.at === null && !m.carry && !onTheirWay(m.id))));
  const target = state.staff;
  const quality = HOUSEKEEPING.turnoverCleanlinessResult[state.housekeeping.turnoverQuality] ?? 85;
  for (const role of ['housekeeper', 'maintenance'] as StaffRole[]) {
    const key = staffKey(role), wanted = Math.max(0, Math.floor(target[key]));
    let staying = current.staffRoster!.filter(m => m.role === role && !m.leaving);
    // hireCandidate/dismissStaff update the count along with the roster.
    current = { ...current, staff: { ...current.staff, [key]: staying.length } };
    while (staying.length < wanted) {
      const options = hiringCandidates(current, role);
      const best = options.reduce((a, b) => {
        const asMember = (c: StaffCandidate): StaffMember => ({ ...c, at: null, stats: { workHours: c.workHours, lateDays: 0, absentDays: 0 } });
        return staffValue(asMember(b), quality) > staffValue(asMember(a), quality) ? b : a;
      });
      current = hireCandidate(current, role, best.id)!;
      staying = current.staffRoster!.filter(m => m.role === role && !m.leaving);
    }
    while (staying.length > wanted) {
      const worst = [...staying].sort((a, b) => staffValue(a, quality) - staffValue(b, quality) || (b.serial ?? 0) - (a.serial ?? 0))[0];
      current = dismissStaff(current, worst.id)!;
      staying = current.staffRoster!.filter(m => m.role === role && !m.leaving);
    }
  }
  return current;
}
