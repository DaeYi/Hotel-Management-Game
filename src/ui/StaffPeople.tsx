import { useState } from 'preact/hooks';
import type { StaffRole, StaffMember, HotelState, FrontDeskShift, Leg } from '../simulation/types';
import { hiringCandidates } from '../simulation/StaffHiring';
import { attendance, experienceOf, roleLabel, shiftFor, staffRate, staffWage, repairTarget, staffDutyAt, checkInHours, frontDeskOn, hospitalityOf, specialtyOf, specialtiesFor, specialtyLabel, receptionTrained, cleaningTrained, cleaningRate, type StaffCandidate } from '../simulation/StaffProfiles';
import { getStaffPlan } from '../simulation/StaffManager';
import { positionAt } from '../simulation/Movement';
import { STAFF_PERSONALITIES, FRONT_DESK_STAFF, STAFF_HOSPITALITY, STAFF_SPECIALTIES, STAFF_FATIGUE, STAFF_CROSS_TRAINING, STAFF_CLEANING_SUPPORT } from '../config/staff';
import { fatigueOn, fatigueAt, staminaOf } from '../simulation/StaffFatigue';
import { getUpkeepMultiplier } from '../simulation/StarRatingManager';
import { useController, useLiveClock } from './context';
import { capitalize } from './format';

export const wageLabel = (wage: number) => `$${wage.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const rateLabel = (m: StaffMember) => `${Math.round(staffRate(m) * 100) / 100}×`;

function specialtyDescription(member: StaffMember): string {
  switch (specialtyOf(member)) {
    case 'turnover_runner': return 'Turnovers first, then daily cleans.';
    case 'room_attendant': return 'Daily cleans first; rooms with guests out first.';
    case 'responder': return 'Repairs the worst vacant room first.';
    case 'preventive': return 'Vacant repairs first; also services occupied rooms below 40% to 85% while guests are out. Respects Do not disturb and finishes before they return.';
    case 'greeter': return 'Handles check-ins and complaints.';
    case 'upseller': return 'Offers big spenders a higher room class at its price; 25% accept if a suitable room is free and within budget.';
    case 'concierge': return 'Learns a stoic guest’s mood after serving their check-in or desk complaint.';
  }
}

function HospitalityDetails({ member }: { member: StaffMember }) {
  const hospitality = hospitalityOf(member);
  const effect = member.role === 'front_desk'
    ? hospitality === 'warm' ? '25% shorter check-ins; +4 mood at check-in. Desk complaints: +10 mood; phone noise complaints gain 3h grace.'
      : hospitality === 'curt' ? '20% longer check-ins; −3 mood at check-in.' : 'No change to check-in time or guest mood.'
    : member.role === 'housekeeper'
      ? hospitality === 'warm' ? `Daily clean with the guest present: +2 mood.${receptionTrained(member) ? ' Reception check-ins: +4 mood.' : ''}`
        : hospitality === 'curt' ? `Daily clean with the guest present: −2 mood.${receptionTrained(member) ? ' Reception check-ins: −3 mood.' : ''}` : 'No extra mood change during daily cleans.'
      : 'No hospitality mood change during repairs.';
  return <div class="dim tiny">Hospitality: {capitalize(hospitality)} · {effect}</div>;
}

function SpecialtyPicker({ member }: { member: StaffMember }) {
  const c = useController();
  return <div class="stack">
    <label class="tiny">Specialty <select aria-label={`Specialty for ${member.name}`} value={specialtyOf(member)} disabled={member.leaving}
      onChange={e => c.setStaffSpecialty(member.id, e.currentTarget.value as ReturnType<typeof specialtiesFor>[number])}>
      {specialtiesFor(member.role).map(specialty => <option key={specialty} value={specialty}>{specialtyLabel(specialty)}</option>)}
    </select></label>
    <div class="dim tiny">{specialtyDescription(member)}</div>
  </div>;
}

function activeStaffLeg(member: StaffMember, state: HotelState, t: number): Leg | undefined {
  const itinerary = getStaffPlan(state).itineraries.find(i => i.staffId === member.id);
  const leg = itinerary ? positionAt(itinerary.legs, t)?.leg : undefined;
  return leg && leg.start <= t && t < leg.end ? leg : undefined;
}

function restLabel(member: StaffMember, state: HotelState, t: number): string | null {
  const leg = activeStaffLeg(member, state, t);
  if (leg?.kind !== 'stay' || leg.activity !== 'rest') return null;
  const room = state.fixtures.find(f => f.type === 'breakroom' && f.id === leg.placeId);
  const takingBreak = member.fatigueBreak && member.fatigueBreak.start <= t && t < member.fatigueBreak.end;
  return room ? takingBreak ? 'Taking a break in the break room' : 'Resting in the break room'
    : takingBreak ? 'Taking a break nearby' : 'Resting nearby';
}

function StaminaDetails({ member }: { member: StaffMember }) {
  if (!fatigueOn()) return null;
  const stamina = staminaOf(member);
  return <div class="dim tiny" title={`Stamina is fixed at hire. ${capitalize(stamina)} stamina adds ${STAFF_FATIGUE.gain[stamina]} fatigue per active hour, including walks and lift rides. Stamina does not change wages.`}>
    Stamina: {capitalize(stamina)} · {STAFF_FATIGUE.gain[stamina]} fatigue/active hour
  </div>;
}

function ReceptionDetails({ member }: { member: StaffMember }) {
  if (!receptionTrained(member)) return null;
  const premium = Math.round((STAFF_CROSS_TRAINING.wagePremium - 1) * 100);
  return <div class="staff-reception-training tiny" aria-label={`Reception training for ${member.name}`}>
    <div><span class="staff-training-badge">Reception trained</span> · Base reception check-in: {Math.round(checkInHours(member) * 60)} min</div>
    <div class="dim">{premium}% training premium included in the agreed wage.</div>
    <div class="dim">Can help at reception from {String(STAFF_CROSS_TRAINING.startHour).padStart(2, '0')}:00 when cleaning is caught up, in short blocks up to {STAFF_CROSS_TRAINING.supportHours}h, subject to shift, seats and energy.</div>
  </div>;
}

function CleaningDetails({ member }: { member: StaffMember }) {
  if (!cleaningTrained(member)) return null;
  const premium = Math.round((STAFF_CLEANING_SUPPORT.wagePremium - 1) * 100);
  const window = `${String(STAFF_CLEANING_SUPPORT.startHour).padStart(2, '0')}:00–${String(STAFF_CLEANING_SUPPORT.endHour).padStart(2, '0')}:00`;
  return <div class="staff-cleaning-training tiny" aria-label={`Turnover training for ${member.name}`}>
    <div><span class="staff-training-badge">Turnover trained</span> · Cleaning {Math.round(cleaningRate(member) * 100) / 100}×</div>
    <div class="dim">{premium}% training premium included in the agreed wage.</div>
    <div class="dim">Can help with vacant-room turnovers {window} when reception has spare coverage. Fixed trips last up to {STAFF_CLEANING_SUPPORT.supportHours}h, including walks back to the desk.</div>
    {member.shift !== 'early' && <div class="dim">This shift is outside the turnover support window.</div>}
  </div>;
}

export function StaffEnergy({ member }: { member: StaffMember }) {
  const c = useController();
  if (!fatigueOn()) return null;
  const fatigue = fatigueAt(c.state, member, c.gameTime);
  const energy = Math.round(100 - fatigue);
  const resting = restLabel(member, c.state, c.gameTime);
  const leg = activeStaffLeg(member, c.state, c.gameTime);
  const recovery = leg?.kind === 'stay' && leg.activity === 'rest' ? leg.restRate ?? STAFF_FATIGUE.fallbackRecovery : null;
  const status = resting ?? (fatigue >= STAFF_FATIGUE.breakAt ? 'Needs a break' : fatigue >= STAFF_FATIGUE.tiredAt ? 'Tired' : 'Ready');
  const level = resting ? 'recovering' : fatigue >= STAFF_FATIGUE.breakAt ? 'exhausted' : fatigue >= STAFF_FATIGUE.tiredAt ? 'tired' : 'ready';
  return <div class={`staff-energy ${level}`}>
    <div class="tiny">Energy: {energy}% · {status}</div>
    <progress class="staff-energy-meter" value={energy} max={100} aria-label={`Energy for ${member.name ?? 'staff member'}`} aria-valuetext={`${energy}% energy; ${status}`} />
    {resting && recovery !== null && <div class="dim tiny">Recovering {recovery} energy/hour.</div>}
    {!resting && fatigue >= STAFF_FATIGUE.tiredAt && <div class="dim tiny">{leg?.kind === 'stay' && leg.activity === 'desk' ? 'New service' : 'Work'} is {Math.round((1 - STAFF_FATIGUE.tiredRate) * 100)}% slower while tired.</div>}
  </div>;
}

/** Current work, from the very same itinerary the world draws. */
export function staffActivity(member: StaffMember, state: HotelState, t: number): string {
  if (member.leaving) return 'Leaving the hotel';
  const resting = fatigueOn() ? restLabel(member, state, t) : null;
  if (resting) return resting;
  if (member.role === 'front_desk') {
    const duty = staffDutyAt(member, t);
    if (t >= duty.end) return 'Off duty';
    if (duty.absent) return 'Absent this shift (unpaid)';
    if (duty.available > t) return member.restUntil && member.restUntil > t ? 'Resting before the next shift' : `Late this shift: ${Math.round(duty.lateHours * 60)} minutes`;
    const leg = activeStaffLeg(member, state, t);
    if (leg?.kind === 'stay' && leg.activity === 'clean' && leg.job === 'turnover') return 'Helping with a turnover';
    return leg?.kind === 'walk' ? 'Walking' : leg?.kind === 'stay' && leg.activity === 'desk' ? 'At the front desk' : member.at ? 'Waiting for a desk seat' : 'Off site';
  }
  const a = attendance(member, state.day);
  if (a.absent) return 'Absent today (unpaid)';
  const shift = shiftFor(member.role, member.shift);
  const due = shift.workStartHour + a.lateHours;
  const hour = t - (state.day - 1) * 24;
  const dueMinutes = Math.round(due * 60);
  if (a.lateHours > 0 && hour < due) return `Late today: due ${String(Math.floor(dueMinutes / 60)).padStart(2, '0')}:${String(dueMinutes % 60).padStart(2, '0')}`;
  const it = getStaffPlan(state).itineraries.find(i => i.staffId === member.id);
  const leg = it ? positionAt(it.legs, t)?.leg : undefined;
  if (leg?.kind === 'walk') return 'Walking';
  if (leg?.kind === 'stay' && leg.job) return leg.job === 'repair' ? leg.preventive ? 'Preventive repairs while the guest is out' : 'Repairing a room' : leg.job === 'turnover' ? 'Turning over a room' : 'Making up a room';
  if (leg?.kind === 'stay' && leg.activity === 'rest') return 'Resting';
  if (leg?.kind === 'stay' && leg.activity === 'desk') return receptionTrained(member) ? 'Supporting reception' : 'At the front desk';
  return member.at ? 'Waiting for work' : 'Off site';
}

export function StaffDetails({ member }: { member: StaffMember }) {
  const c = useController();
  const profile = member.profile;
  const wage = staffWage(member), upkeep = getUpkeepMultiplier(c.state.starRating);
  const target = repairTarget(member);
  const desk = member.role === 'front_desk';
  const live = fatigueOn() ? { ...member, stats: { ...member.stats!, fatigue: fatigueAt(c.state, member, c.gameTime) } } : member;
  return <>
    <div class="body small">{capitalize(experienceOf(member))} · {!desk && `${profile?.style ?? 'standard'} · `}{profile?.reliability ?? 'dependable'}</div>
    <div class="dim tiny">{desk ? `Base check-in: ${Math.round(checkInHours(member) * 60)} min` : `${member.role === 'housekeeper' ? 'Cleaning' : 'Repairs'} ${rateLabel(live)}`} · {wageLabel(wage * upkeep)}/{desk ? '8h shift' : 'day'}{upkeep !== 1 ? ` (${wageLabel(wage)} base)` : ''}</div>
    <div class="dim tiny">{Math.floor(member.stats?.workHours ?? 80)} work hours · hired day {member.hiredDay ?? 1}</div>
    {profile && !profile.legacy && !desk && <div class="dim tiny">{member.role === 'housekeeper'
      ? profile.style === 'speedy' ? 'Finishes 10 cleanliness points below the target' : profile.style === 'meticulous' ? 'Adds 10 cleanliness points; reports damage' : 'Cleans to the hotel’s target'
      : `${specialtyOf(member) === 'preventive' ? 'Vacant-room repairs' : 'Repairs'} to ${target}% condition`}</div>}
    <div class="dim tiny">Attendance: {member.stats?.lateDays ?? 0} late days · {member.stats?.absentDays ?? 0} absent days</div>
    <StaminaDetails member={member} />
    <ReceptionDetails member={member} />
    <CleaningDetails member={live} />
    <StaffEnergy member={member} />
    {STAFF_HOSPITALITY.enabled && <HospitalityDetails member={member} />}
    {STAFF_SPECIALTIES.enabled && <SpecialtyPicker member={member} />}
    {desk && <DeskShiftPicker member={member} />}
  </>;
}

export function DeskShiftPicker({ member }: { member: StaffMember }) {
  const c = useController();
  const onDuty = c.gameTime < staffDutyAt(member, c.gameTime).end;
  return <div class="stack">
    <label class="tiny">Shift <select aria-label={`Shift for ${member.name}`} value={member.shift ?? 'late'} disabled={onDuty || member.leaving}
      onChange={e => c.setDeskShift(member.id, e.currentTarget.value as FrontDeskShift)}>
      {Object.entries(FRONT_DESK_STAFF.shifts).map(([key, shift]) => <option key={key} value={key}>{shift.label}</option>)}
    </select></label>
    <div class="dim tiny">{onDuty ? 'Change shifts while this clerk is off duty.' : 'Shift changes allow rest before the next shift.'}{member.profile?.legacy ? ' Original base wage retained on save upgrade.' : ''}{member.shift === 'night' && (member.nightPremium ?? !member.profile?.legacy) ? ' Night pay includes a 25% premium.' : ''}</div>
    {member.restUntil !== undefined && member.restUntil > c.gameTime && <div class="dim tiny">Resting until the next eligible shift.</div>}
  </div>;
}

function CandidateCard({ candidate }: { candidate: StaffCandidate }) {
  const c = useController();
  const member: StaffMember = { ...candidate, at: null, stats: { workHours: candidate.workHours, lateDays: 0, absentDays: 0 } };
  const wage = staffWage(member) * getUpkeepMultiplier(c.state.starRating);
  const desk = candidate.role === 'front_desk';
  return <li class="staff-candidate">
    <div class="body small">{candidate.name}</div>
    <div class="dim tiny">{capitalize(candidate.profile.experience)} · {!desk && `${candidate.profile.style} · `}{candidate.profile.reliability}</div>
    <div class="small">{wageLabel(wage)}/{desk ? '8h shift' : 'day'} · {desk ? `${Math.round(checkInHours(member) * 60)} min/check-in` : `${candidate.role === 'housekeeper' ? 'cleans' : 'repairs'} ${rateLabel(member)}`}</div>
    <div class="dim tiny">{candidate.profile.reliability === 'dependable' ? 'Always on time' : candidate.profile.reliability === 'flaky' ? '20% late days; 4% absent (unpaid)' : '5% late days, up to an hour'}</div>
    {!desk && <div class="dim tiny">{candidate.role === 'housekeeper'
      ? candidate.profile.style === 'speedy' ? '10 points less clean' : candidate.profile.style === 'meticulous' ? '10 points cleaner; reports damage' : 'Standard thoroughness'
      : `${specialtyOf(member) === 'preventive' ? 'Vacant-room repairs' : 'Repairs'} to ${repairTarget(member)}% condition`}</div>}
    {STAFF_SPECIALTIES.enabled && <div class="dim tiny">Specialty: {specialtyLabel(specialtyOf(member))} · {specialtyDescription(member)}</div>}
    {STAFF_HOSPITALITY.enabled && <HospitalityDetails member={member} />}
    <StaminaDetails member={member} />
    <ReceptionDetails member={member} />
    <CleaningDetails member={member} />
    <button class="good" onClick={() => c.hireStaff(candidate.role, candidate.id, candidate.shift)} aria-label={`Hire ${candidate.name}`}>Hire</button>
  </li>;
}

export function StaffPeople() {
  const c = useController();
  useLiveClock();
  const [role, setRole] = useState<StaffRole>('housekeeper');
  const [shift, setShift] = useState<FrontDeskShift>('late');
  if (!STAFF_PERSONALITIES.enabled) return null;
  const team = (c.state.staffRoster ?? []).filter(m => m.role === role && !m.leaving);
  return <section class="staff-people" aria-label="Individual staff">
    <div class="row" role="group" aria-label="Hiring role">
      {((frontDeskOn() ? ['housekeeper', 'maintenance', 'front_desk'] : ['housekeeper', 'maintenance']) as StaffRole[]).map(r => <button key={r} class={r === role ? 'chosen' : ''} aria-pressed={r === role} onClick={() => setRole(r)}>{roleLabel(r)}</button>)}
    </div>
    <h3>Your team</h3>
    {team.length === 0 && <div class="dim tiny">Nobody hired for this role.</div>}
    <ul class="staff-team">{team.map(m => <li key={m.id}>
      <div class="row"><button class="link" onClick={() => c.selectStaff(m.id)}>{m.name}</button><span class="spacer" /><button class="danger" onClick={() => c.dismissStaff(m.id)} aria-label={`Let ${m.name} go`}>Let go</button></div>
      <StaffDetails member={m} />
      <div class="tiny" style={{ color: '#aaaacc' }}>{staffActivity(m, c.state, c.gameTime)}</div>
    </li>)}</ul>
    <h3>Available to hire</h3>
    {role === 'front_desk' && <label class="small">Hire for <select aria-label="Shift for new clerk" value={shift} onChange={e => setShift(e.currentTarget.value as FrontDeskShift)}>
      {Object.entries(FRONT_DESK_STAFF.shifts).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
    </select></label>}
    <ul class="staff-candidates">{hiringCandidates(c.state, role, shift).map(candidate => <CandidateCard key={candidate.id} candidate={candidate} />)}</ul>
    <div class="dim tiny">Candidates refresh each day and after a hire. The + button hires the best value; − lets the lowest value employee go. Reassign specialties for the work you need; hospitality is fixed at hire. Experience grows through work; promotions raise speed and wages automatically. Absent days are unpaid.</div>
  </section>;
}
