import { useState } from 'preact/hooks';
import type { StaffRole, StaffMember, HotelState } from '../simulation/types';
import { hiringCandidates } from '../simulation/StaffHiring';
import { attendance, experienceOf, roleLabel, shiftFor, staffRate, staffWage, repairTarget, type StaffCandidate } from '../simulation/StaffProfiles';
import { getStaffPlan } from '../simulation/StaffManager';
import { positionAt } from '../simulation/Movement';
import { STAFF_PERSONALITIES } from '../config/staff';
import { getUpkeepMultiplier } from '../simulation/StarRatingManager';
import { useController, useLiveClock } from './context';
import { capitalize } from './format';

export const wageLabel = (wage: number) => `$${wage.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const rateLabel = (m: StaffMember) => `${Math.round(staffRate(m) * 100) / 100}×`;

/** Current work, from the very same itinerary the world draws. */
export function staffActivity(member: StaffMember, state: HotelState, t: number): string {
  if (member.leaving) return 'Leaving the hotel';
  const a = attendance(member, state.day);
  if (a.absent) return 'Absent today (unpaid)';
  const shift = shiftFor(member.role);
  const due = shift.workStartHour + a.lateHours;
  const hour = t - (state.day - 1) * 24;
  const dueMinutes = Math.round(due * 60);
  if (a.lateHours > 0 && hour < due) return `Late today: due ${String(Math.floor(dueMinutes / 60)).padStart(2, '0')}:${String(dueMinutes % 60).padStart(2, '0')}`;
  const it = getStaffPlan(state).itineraries.find(i => i.staffId === member.id);
  const leg = it ? positionAt(it.legs, t)?.leg : undefined;
  if (leg?.kind === 'walk') return 'Walking';
  if (leg?.kind === 'stay' && leg.job) return leg.job === 'repair' ? 'Repairing a room' : leg.job === 'turnover' ? 'Turning over a room' : 'Making up a room';
  if (leg?.kind === 'stay' && leg.activity === 'rest') return 'Resting';
  return member.at ? 'Waiting for work' : 'Off site';
}

export function StaffDetails({ member }: { member: StaffMember }) {
  const c = useController();
  const profile = member.profile;
  const wage = staffWage(member), upkeep = getUpkeepMultiplier(c.state.starRating);
  const target = repairTarget(member);
  return <>
    <div class="body small">{capitalize(experienceOf(member))} · {profile?.style ?? 'standard'} · {profile?.reliability ?? 'dependable'}</div>
    <div class="dim tiny">{member.role === 'housekeeper' ? 'Cleaning' : 'Repairs'} {rateLabel(member)} · {wageLabel(wage * upkeep)}/day{upkeep !== 1 ? ` (${wageLabel(wage)} base)` : ''}</div>
    <div class="dim tiny">{Math.floor(member.stats?.workHours ?? 80)} work hours · hired day {member.hiredDay ?? 1}</div>
    {profile && !profile.legacy && <div class="dim tiny">{member.role === 'housekeeper'
      ? profile.style === 'speedy' ? 'Finishes 10 cleanliness points below the target' : profile.style === 'meticulous' ? 'Adds 10 cleanliness points; reports damage' : 'Cleans to the hotel’s target'
      : `Repairs to ${target}% condition`}</div>}
    <div class="dim tiny">Attendance: {member.stats?.lateDays ?? 0} late days · {member.stats?.absentDays ?? 0} absent days</div>
  </>;
}

function CandidateCard({ candidate }: { candidate: StaffCandidate }) {
  const c = useController();
  const member: StaffMember = { ...candidate, at: null, stats: { workHours: candidate.workHours, lateDays: 0, absentDays: 0 } };
  const wage = staffWage(member) * getUpkeepMultiplier(c.state.starRating);
  return <li class="staff-candidate">
    <div class="body small">{candidate.name}</div>
    <div class="dim tiny">{capitalize(candidate.profile.experience)} · {candidate.profile.style} · {candidate.profile.reliability}</div>
    <div class="small">{wageLabel(wage)}/day · {candidate.role === 'housekeeper' ? 'cleans' : 'repairs'} {rateLabel(member)}</div>
    <div class="dim tiny">{candidate.profile.reliability === 'dependable' ? 'Always on time' : candidate.profile.reliability === 'flaky' ? '20% late days; 4% absent (unpaid)' : '5% late days, up to an hour'}</div>
    <div class="dim tiny">{candidate.role === 'housekeeper'
      ? candidate.profile.style === 'speedy' ? '10 points less clean' : candidate.profile.style === 'meticulous' ? '10 points cleaner; reports damage' : 'Standard thoroughness'
      : `Repairs to ${repairTarget(member)}% condition`}</div>
    <button class="good" onClick={() => c.hireStaff(candidate.role, candidate.id)} aria-label={`Hire ${candidate.name}`}>Hire</button>
  </li>;
}

export function StaffPeople() {
  const c = useController();
  useLiveClock();
  const [role, setRole] = useState<StaffRole>('housekeeper');
  if (!STAFF_PERSONALITIES.enabled) return null;
  const team = (c.state.staffRoster ?? []).filter(m => m.role === role && !m.leaving);
  return <section class="staff-people" aria-label="Individual staff">
    <div class="row" role="group" aria-label="Hiring role">
      {(['housekeeper', 'maintenance'] as StaffRole[]).map(r => <button key={r} class={r === role ? 'chosen' : ''} aria-pressed={r === role} onClick={() => setRole(r)}>{roleLabel(r)}</button>)}
    </div>
    <h3>Your team</h3>
    {team.length === 0 && <div class="dim tiny">Nobody hired for this role.</div>}
    <ul class="staff-team">{team.map(m => <li key={m.id}>
      <div class="row"><button class="link" onClick={() => c.selectStaff(m.id)}>{m.name}</button><span class="spacer" /><button class="danger" onClick={() => c.dismissStaff(m.id)} aria-label={`Let ${m.name} go`}>Let go</button></div>
      <StaffDetails member={m} />
      <div class="tiny" style={{ color: '#aaaacc' }}>{staffActivity(m, c.state, c.gameTime)}</div>
    </li>)}</ul>
    <h3>Available to hire</h3>
    <ul class="staff-candidates">{hiringCandidates(c.state, role).map(candidate => <CandidateCard key={candidate.id} candidate={candidate} />)}</ul>
    <div class="dim tiny">Candidates refresh each day and after a hire. The + button hires the best value; − lets the lowest value employee go. Experience grows through work; promotions raise speed and wages automatically. Absent days are unpaid.</div>
  </section>;
}
