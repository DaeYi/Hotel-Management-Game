import type { HotelState, StaffConfig, VisitorPolicy, SpotlightHold } from '../../simulation/types';
import { spotlightOn, holdPolicy, holdLetGo } from '../../simulation/Spotlight';
import { STAFF, HOSTED_NIGHTS, GUEST_PROFILE, DESK, BREAK_ROOM } from '../../config/balance';
import { visitorPolicy } from '../../simulation/Visitors';
import { getMaintenanceStatus, getStaffDailyCost } from '../../simulation/MaintenanceManager';
import { getUpkeepMultiplier } from '../../simulation/StarRatingManager';
import { getHousekeepingStatus, clerksFreeToClean } from '../../simulation/HousekeepingManager';
import { getAccessibleDesks, getAccessibleBreakRooms, getMannedDeskStaff, getCheckInCapacity, getStaffTravelHours } from '../../simulation/Layout';
import { useController, useLiveClock } from '../context';
import { queueOn, deskToday, waitingInLine } from '../../simulation/DeskQueue';
import { formatMoney, formatWalk } from '../format';
import { PanelCard } from './PanelCard';
import { StaffPeople, staffActivity } from '../StaffPeople';
import { namedFrontDesk, receptionTrained, cleaningTrained } from '../../simulation/StaffProfiles';
import { deskCoverage } from '../../simulation/FrontDesk';
import { FRONT_DESK_STAFF, STAFF_FATIGUE } from '../../config/staff';
import { fatigueOn, breakRoomOccupancy } from '../../simulation/StaffFatigue';

const LONG_WALK_HOURS = 0.33; // 20 minutes: worth a closet

function StaffRow({ label, staffKey, status }: { label: string; staffKey: keyof StaffConfig; status: string }) {
  const c = useController();
  const count = c.state.staff[staffKey];
  const set = (n: number) => c.setStaff({ ...c.state.staff, [staffKey]: Math.max(0, n) });
  return (
    <div class="stack">
      <div class="body small">{label}</div>
      <div class="row">
        <button class="danger" onClick={() => set(count - 1)} aria-label={`Fewer ${label}`}>{' - '}</button>
        <span style={{ fontSize: '18px', width: '36px', textAlign: 'center' }}>{count}</span>
        <button class="good" onClick={() => set(count + 1)} aria-label={`More ${label}`}>{' + '}</button>
      </div>
      <div class="dim tiny">{status}</div>
    </div>
  );
}

/** An upper floor whose rooms average a long walk and that has no closet yet, or null. */
function farthestFloorWithoutCloset(state: HotelState): number | null {
  let worst: { floor: number; hours: number } | null = null;
  for (let floor = 1; floor < state.floorCount; floor++) {
    if (state.fixtures.some(f => f.type === 'closet' && f.floor === floor)) continue;
    const walks = state.rooms.filter(r => r.floor === floor).map(r => getStaffTravelHours(state, r)).filter(Number.isFinite);
    if (walks.length === 0) continue;
    const hours = walks.reduce((a, b) => a + b, 0) / walks.length;
    if (hours > LONG_WALK_HOURS && (!worst || hours > worst.hours)) worst = { floor, hours };
  }
  return worst?.floor ?? null;
}

const VISITOR_POLICIES: Array<{ key: VisitorPolicy; label: string }> = [
  { key: 'ask', label: 'Ask them to leave' },
  { key: 'allow', label: 'Let them stay' },
];
const HOLD_POLICIES: Array<{ key: SpotlightHold; label: string }> = [
  { key: 'hold', label: 'Hold a suite' },
  { key: 'none', label: "Don't hold one" },
];

/** The front desk today: the line now, how check-ins went, who gave up, complaints heard -- and what to do about a line. */
function DeskToday() {
  const c = useController();
  useLiveClock();
  const { state } = c;
  const today = deskToday(state);
  const inLine = waitingInLine(state, c.gameTime);
  const parts = [
    `In line now: ${inLine}`,
    today.checkedIn > 0 ? `${today.checkedIn} checked in today (average wait ${Math.round(today.waitHours / today.checkedIn * 60)} min)` : '',
    today.gaveUp > 0 ? `${today.gaveUp} gave up in line` : '',
    today.complaints > 0 ? `${today.complaints} complaint${today.complaints === 1 ? '' : 's'} at the desk` : '',
  ].filter(Boolean);
  const seats = getAccessibleDesks(state).length * DESK.staffPerDesk;
  const advice = today.gaveUp === 0 ? null
    : (namedFrontDesk(state) ? deskCoverage(state, c.gameTime).length : state.staff.frontDesk) < seats ? 'Guests are giving up in line: another clerk would serve them (a desk seats two).'
    : 'Guests are giving up in line, and every desk seat is taken: build another desk for another clerk.';
  return (
    <div class="tiny" aria-label="Front desk today">
      <div class="dim">{parts.join(' \u00b7 ')}</div>
      {advice && <div class="warn-text">{advice}</div>}
    </div>
  );
}

function StaffBreaks() {
  const c = useController();
  if (!fatigueOn()) return null;
  const rooms = c.state.fixtures.filter(f => f.type === 'breakroom').sort((a, b) => a.floor - b.floor || a.gridY - b.gridY || a.gridX - b.gridX);
  const reachable = new Set(getAccessibleBreakRooms(c.state).map(room => room.id));
  const occupied = rooms.reduce((sum, room) => sum + breakRoomOccupancy(c.state, room.id, c.gameTime), 0);
  return <section class="staff-breaks tiny" aria-label="Staff breaks">
    <div class="body small">Break rooms · {occupied}/{reachable.size * BREAK_ROOM.seats} seats in use</div>
    {rooms.length === 0 ? <div class="dim">No break rooms yet. Build one near busy floors for faster recovery.</div>
      : <ul>{rooms.map((room, index) => {
        const used = breakRoomOccupancy(c.state, room.id, c.gameTime);
        const accessible = reachable.has(room.id);
        return <li key={room.id} class={!accessible || used >= BREAK_ROOM.seats ? 'warn-text' : 'dim'}>
          <button class="link" onClick={() => c.setFloor(room.floor)} aria-label={`Show floor ${room.floor + 1} for break room ${index + 1}`}>Break room {index + 1} · floor {room.floor + 1}</button>: {accessible ? `${used}/${BREAK_ROOM.seats} seats${used >= BREAK_ROOM.seats ? ' (full)' : ''}` : 'Blocked access'}
        </li>;
      })}</ul>}
    <div class="dim">Rest restores {STAFF_FATIGUE.roomRecovery} energy/hour in a break room, {STAFF_FATIGUE.fallbackRecovery} elsewhere. Walking and lift rides use energy.</div>
    <div class="dim">At {100 - STAFF_FATIGUE.tiredAt}% energy, work slows to {Math.round(STAFF_FATIGUE.tiredRate * 100)}% speed. At {100 - STAFF_FATIGUE.breakAt}%, staff need a {Math.round(STAFF_FATIGUE.breakHours * 60)}-minute break.</div>
  </section>;
}

export function StaffPanel() {
  const c = useController();
  useLiveClock();
  const { state } = c;
  const namedDesk = namedFrontDesk(state);

  const desks = getAccessibleDesks(state).length;
  const seated = namedDesk ? deskCoverage(state, c.gameTime).length : getMannedDeskStaff(state);
  const deskWarning = desks === 0 ? ' (no desk!)'
    : namedDesk && seated === 0 ? ' (desk unattended)'
    : !namedDesk && seated < state.staff.frontDesk ? ` (${state.staff.frontDesk - seated} idle: need desks)`
    : state.staff.frontDesk === 0 && seated === 0 ? ' (unstaffed!)' : '';

  const hk = getHousekeepingStatus(state, c.gameTime);
  const maint = getMaintenanceStatus(state);
  const trained = (state.staffRoster ?? []).filter(m => !m.leaving && receptionTrained(m));
  const supporting = trained.filter(m => staffActivity(m, state, c.gameTime) === 'Supporting reception').length;
  const turnoverTrained = (state.staffRoster ?? []).filter(m => !m.leaving && cleaningTrained(m));
  const cleaningSupport = turnoverTrained.filter(m => staffActivity(m, state, c.gameTime) === 'Helping with a turnover').length;
  // Why none of them ever leaves the desk: another early-shift clerk has to stay at reception
  const cantClean = turnoverTrained.length > 0 && clerksFreeToClean(state).length === 0
    ? turnoverTrained.some(m => m.shift === 'early')
      ? "Can't leave the desk to clean: another early-shift clerk must stay at reception for the whole trip."
      : "Can't help: turnover help is only on the early shift."
    : null;

  const upkeep = getUpkeepMultiplier(state.starRating);
  const walks = state.rooms.map(r => getStaffTravelHours(state, r)).filter(Number.isFinite);
  const avgWalk = walks.length > 0 ? walks.reduce((a, b) => a + b, 0) / walks.length : 0;

  const recommendations: string[] = [];
  if (state.staff.frontDesk === 0 && state.rooms.length > 0) recommendations.push(supporting > 0
    ? 'Housekeepers are helping at reception; hire clerks for regular shift coverage.' : 'No front desk staff! Nobody can check in.');
  if (hk.recommendation) recommendations.push(hk.recommendation);
  if (maint.recommendation) recommendations.push(maint.recommendation);
  const farFloor = farthestFloorWithoutCloset(state);
  if (farFloor !== null) recommendations.push(`Long walks on floor ${farFloor + 1}: add a staff closet there.`);

  return (
    <PanelCard title="STAFF">
      <StaffRow label={namedDesk ? 'Front Desk' : `Front Desk (${formatMoney(STAFF.frontDesk.dailyWage)}/day)`} staffKey="frontDesk"
        status={namedDesk ? `${seated} on duty at ${desks} desk${desks === 1 ? '' : 's'} · ${state.staff.frontDesk} clerks hired${deskWarning}` : `Check-in: ${getCheckInCapacity(state)}/hr at ${desks} desk${desks === 1 ? '' : 's'}${deskWarning}`} />
      {namedDesk && <div class="tiny" aria-label="Front desk shift coverage">
        {Object.entries(FRONT_DESK_STAFF.shifts).map(([key, shift]) => {
          const count = (state.staffRoster ?? []).filter(m => m.role === 'front_desk' && !m.leaving && m.shift === key).length;
          return <div key={key} class={count === 0 ? 'warn-text' : 'dim'}>{shift.label}: {count === 0 ? 'No clerk assigned' : `${count} clerk${count === 1 ? '' : 's'}`}{count > desks * DESK.staffPerDesk ? ' (needs more desk seats)' : ''}</div>;
        })}
        <div class="dim">24-hour coverage needs a clerk on each shift. Night shifts pay 25% more. + fills the least-covered shift.</div>
      </div>}
      {queueOn(state) && <DeskToday />}
      {turnoverTrained.length > 0 && <div class="dim tiny" aria-label="Turnover support">Turnover support: {turnoverTrained.length} trained clerk{turnoverTrained.length === 1 ? '' : 's'} · {cleaningSupport} cleaning now.{cantClean && <span class="warn-text"> {cantClean}</span>}</div>}
      <hr class="divider" />
      <StaffRow label={`Housekeepers (base ${formatMoney(STAFF.housekeeping.dailyWage)}/day)`} staffKey="housekeepers"
        status={`Cleaning: ${hk.roomsBeingCleaned}${hk.roomsWaiting > 0 ? ` (${hk.roomsWaiting} waiting!)` : ''}  |  Busy day: ${Math.round(hk.hoursNeeded)}h of ${Math.round(hk.hoursAvailable * 10) / 10}h`} />
      {trained.length > 0 && <div class="dim tiny" aria-label="Reception support">Reception support: {trained.length} trained housekeeper{trained.length === 1 ? '' : 's'} · {supporting} supporting now.</div>}
      <hr class="divider" />
      <StaffRow label={`Maintenance (base ${formatMoney(STAFF.maintenance.dailyWage)}/day)`} staffKey="maintenanceWorkers"
        status={`Needs repair: ${maint.roomsNeedingRepair}  |  Cap: ${maint.effectiveCapacity} rooms`} />
      <hr class="divider" />
      <div class="gold small">
        Total staff: {formatMoney(getStaffDailyCost(state))}/day{upkeep > 1 ? ` (${state.starRating}★ wages x${upkeep})` : ''}
      </div>
      <div class="gold small">Avg walk to rooms: {formatWalk(avgWalk)}</div>
      {recommendations.length > 0 && <div class="gold tiny" style={{ marginTop: '8px' }}>{'ℹ'} {recommendations[0]}</div>}
      <StaffBreaks />
      <StaffPeople />
      <hr class="divider" />
      {HOSTED_NIGHTS.enabled && GUEST_PROFILE.enabled && (
        <div class="stack" style={{ marginTop: '6px' }}>
          <div class="body small">When a neighbour complains about a guest's visitors at night:</div>
          <div class="row" role="group" aria-label="Visitors">
            {VISITOR_POLICIES.map(p => (
              <button key={p.key} class={visitorPolicy(state) === p.key ? 'chosen' : ''} aria-pressed={visitorPolicy(state) === p.key}
                onClick={() => c.setVisitorPolicy(p.key)}>{p.label}</button>
            ))}
          </div>
          <div class="dim tiny">
            Ask: the front desk sends them home, and the host minds ({HOSTED_NIGHTS.hostPenalty} points of mood). Let them stay: they go
            by {String(HOSTED_NIGHTS.leaveHours[1]).padStart(2, '0')}:00, but a neighbour still kept awake {HOSTED_NIGHTS.complaintGraceHours} hours on checks out early.
            You can also ask from the room's card at any time.
          </div>
        </div>
      )}
      {spotlightOn() && (
        <div class="stack" style={{ marginTop: '6px' }}>
          <div class="body small">When a travel writer or a celebrity is coming:</div>
          <div class="row" role="group" aria-label="Spotlight guests">
            {HOLD_POLICIES.map(p => (
              <button key={p.key} class={holdPolicy(state) === p.key ? 'chosen' : ''} aria-pressed={holdPolicy(state) === p.key}
                onClick={() => c.setSpotlightHold(p.key)}>{p.label}</button>
            ))}
          </div>
          {holdLetGo(state) && <div class="small warn-text">The hold was let go for the guest coming now: Hold a suite to hold one again, or pick one on its card.</div>}
          <div class="dim tiny">
            Hold one: the best suite free by then is kept for them (nobody who'd still be in it can book it), and they check in to it
            first in line. Don't: they take the best suite free when they come, or any room. Either way you can hold or let go a suite
            from its card.
          </div>
        </div>
      )}
    </PanelCard>
  );
}
