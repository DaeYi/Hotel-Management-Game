import type { HotelState, StaffConfig } from '../../simulation/types';
import { STAFF } from '../../config/balance';
import { getMaintenanceStatus, getStaffDailyCost } from '../../simulation/MaintenanceManager';
import { getUpkeepMultiplier } from '../../simulation/StarRatingManager';
import { getHousekeepingStatus } from '../../simulation/HousekeepingManager';
import { getAccessibleDesks, getMannedDeskStaff, getCheckInCapacity, getStaffTravelHours } from '../../simulation/Layout';
import { useController } from '../context';
import { formatMoney, formatWalk } from '../format';
import { PanelCard } from './PanelCard';

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

export function StaffPanel() {
  const { state } = useController();

  const desks = getAccessibleDesks(state).length;
  const seated = getMannedDeskStaff(state);
  const deskWarning = desks === 0 ? ' (no desk!)'
    : seated < state.staff.frontDesk ? ` (${state.staff.frontDesk - seated} idle: need desks)`
    : state.staff.frontDesk === 0 ? ' (unstaffed!)' : '';

  const hk = getHousekeepingStatus(state);
  const maint = getMaintenanceStatus(state);

  const upkeep = getUpkeepMultiplier(state.starRating);
  const walks = state.rooms.map(r => getStaffTravelHours(state, r)).filter(Number.isFinite);
  const avgWalk = walks.length > 0 ? walks.reduce((a, b) => a + b, 0) / walks.length : 0;

  const recommendations: string[] = [];
  if (state.staff.frontDesk === 0 && state.rooms.length > 0) recommendations.push('No front desk staff! Nobody can check in.');
  if (hk.recommendation) recommendations.push(hk.recommendation);
  if (maint.recommendation) recommendations.push(maint.recommendation);
  const farFloor = farthestFloorWithoutCloset(state);
  if (farFloor !== null) recommendations.push(`Long walks on floor ${farFloor + 1}: add a staff closet there.`);

  return (
    <PanelCard title="STAFF">
      <StaffRow label={`Front Desk (${formatMoney(STAFF.frontDesk.dailyWage)}/day)`} staffKey="frontDesk"
        status={`Check-in: ${getCheckInCapacity(state)}/hr at ${desks} desk${desks === 1 ? '' : 's'}${deskWarning}`} />
      <hr class="divider" />
      <StaffRow label={`Housekeepers (${formatMoney(STAFF.housekeeping.dailyWage)}/day)`} staffKey="housekeepers"
        status={`Cleaning: ${hk.roomsBeingCleaned}${hk.roomsWaiting > 0 ? ` (${hk.roomsWaiting} waiting!)` : ''}  |  Busy day: ${Math.round(hk.hoursNeeded)}h of ${hk.hoursAvailable}h`} />
      <hr class="divider" />
      <StaffRow label={`Maintenance (${formatMoney(STAFF.maintenance.dailyWage)}/day)`} staffKey="maintenanceWorkers"
        status={`Needs repair: ${maint.roomsNeedingRepair}  |  Cap: ${maint.effectiveCapacity} rooms`} />
      <hr class="divider" />
      <div class="gold small">
        Total staff: {formatMoney(getStaffDailyCost(state))}/day{upkeep > 1 ? ` (${state.starRating}★ wages x${upkeep})` : ''}
      </div>
      <div class="gold small">Avg walk to rooms: {formatWalk(avgWalk)}</div>
      {recommendations.length > 0 && <div class="gold tiny" style={{ marginTop: '8px' }}>{'ℹ'} {recommendations[0]}</div>}
    </PanelCard>
  );
}
