import type { HotelState, GameEvent } from './types.js';
import { STAFF_PERSONALITIES, FRONT_DESK_STAFF } from '../config/staff.js';
import { staffWage, attendance, repairTarget, namedFrontDesk, deskPaidHours, baseWage } from './StaffProfiles.js';
import { hourStart } from './Movement.js';
import { STAFF } from '../config/balance.js';
import { getUpkeepMultiplier } from './StarRatingManager.js';
import { getStaffPlan, plannedWork, isOnShift } from './StaffManager.js';

/**
 * One hour of maintenance: each room gets STAFF.maintenance.repairPerHour for
 * every hour the staff plan has a worker repairing it this hour (getStaffPlan --
 * the plan the walking staff on screen follow). The walk there comes out of
 * that time.
 */
export function processMaintenanceTick(state: HotelState): { state: HotelState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  if (!isOnShift('maintenance', state.hour)) return { state, events };
  const work = plannedWork(getStaffPlan(state), 'repair');
  if (work.size === 0) return { state, events };

  const repairAmount = STAFF.maintenance.repairPerHour;
  let repaired = 0;
  const updatedRooms = state.rooms.map(room => {
    const hours = work.get(room.id);
    if (hours === undefined || room.status !== 'vacant') return room;
    repaired++;
    let finisher: string | undefined;
    let end = -Infinity;
    for (const it of getStaffPlan(state).itineraries) for (const leg of it.legs) {
      if (leg.kind === 'stay' && leg.job === 'repair' && leg.placeId === room.id && leg.end > end) { end = leg.end; finisher = it.staffId; }
    }
    const member = state.staffRoster?.find(m => m.id === finisher);
    const target = repairTarget(member);
    const condition = Math.min(target ?? 100, room.condition + repairAmount * hours);
    return { ...room, condition, ...(condition >= (target ?? STAFF.maintenance.conditionThreshold) ? { damageReportedBy: undefined } : {}) };
  });

  if (repaired > 0) {
    // Only emit event once per tick, batched
    events.push({
      type: 'maintenance_repair',
      message: `Maintenance: ${repaired} room${repaired > 1 ? 's' : ''} repaired`,
      data: { roomsRepaired: repaired, repairAmount },
    });
  }

  return { state: { ...state, rooms: updatedRooms }, events };
}

/**
 * Calculate daily staff costs (all staff types). Wages scale with prestige
 * upkeep -- a 5-star hotel pays more for the same headcount.
 */
export function getStaffDailyCost(state: HotelState): number {
  if (STAFF_PERSONALITIES.enabled && state.staffRoster) {
    const start = (state.day - 1) * 24;
    const wages = state.staffRoster.reduce((sum, m) => sum + (m.role === 'front_desk' ? deskPaidHours(m, start, start + 24) * staffWage(m) / 8
      : !m.leaving && !attendance(m, state.day).absent ? staffWage(m) : 0), 0);
    return (wages + (namedFrontDesk(state) ? 0 : state.staff.frontDesk * STAFF.frontDesk.dailyWage)) * getUpkeepMultiplier(state.starRating);
  }
  const maintenanceCost = state.staff.maintenanceWorkers * STAFF.maintenance.dailyWage;
  const housekeepingCost = state.staff.housekeepers * STAFF.housekeeping.dailyWage;
  const frontDeskCost = state.staff.frontDesk * STAFF.frontDesk.dailyWage;
  return (maintenanceCost + housekeepingCost + frontDeskCost) * getUpkeepMultiplier(state.starRating);
}

/** A reserve must cover the team returning tomorrow, including anyone absent today. */
export function getProjectedStaffDailyCost(state: HotelState): number {
  if (!STAFF_PERSONALITIES.enabled || !state.staffRoster) return getStaffDailyCost(state);
  const active = state.staffRoster.filter(m => !m.leaving);
  const wages = active.reduce((sum, m) => sum + staffWage(m), 0);
  const pendingHousekeepers = Math.max(0, state.staff.housekeepers - active.filter(m => m.role === 'housekeeper').length);
  const pendingMaintenance = Math.max(0, state.staff.maintenanceWorkers - active.filter(m => m.role === 'maintenance').length);
  const pendingFrontDesk = namedFrontDesk(state) ? Math.max(0, state.staff.frontDesk - active.filter(m => m.role === 'front_desk').length) * baseWage('front_desk') * (2 + FRONT_DESK_STAFF.nightPremium) / 3 : state.staff.frontDesk * STAFF.frontDesk.dailyWage;
  return (wages + pendingHousekeepers * STAFF.housekeeping.dailyWage + pendingMaintenance * STAFF.maintenance.dailyWage
    + pendingFrontDesk) * getUpkeepMultiplier(state.starRating);
}

/** Earned pay survives a dismissal; an absent worker earns no wage. */
export function recordStaffPayroll(state: HotelState): HotelState {
  if (!STAFF_PERSONALITIES.enabled) return state;
  const key = String(state.day);
  const earned = { ...(state.staffPayroll?.[key] ?? {}) };
  const through = { ...state.staffPayrollThrough };
  const T = hourStart(state);
  for (const m of state.staffRoster ?? []) {
    if (m.role === 'front_desk') {
      const from = Math.max(T, through[m.id] ?? T);
      earned[m.id] = (earned[m.id] ?? 0) + deskPaidHours(m, from, T + 1) * staffWage(m) / 8;
      through[m.id] = Math.max(through[m.id] ?? T, T + 1);
      continue;
    }
    const shift = m.role === 'housekeeper' ? STAFF.housekeeping : STAFF.maintenance;
    const a = attendance(m, state.day);
    const workedBeforeLeaving = m.leaving && state.staffPlan?.itineraries.some(it => it.staffId === m.id && it.legs.length > 0);
    if ((!m.leaving || workedBeforeLeaving) && !a.absent && state.hour + 1 > shift.workStartHour + a.lateHours && state.hour < shift.workEndHour) earned[m.id] = Math.max(earned[m.id] ?? 0, staffWage(m));
  }
  return { ...state, staffPayroll: { ...state.staffPayroll, [key]: earned }, staffPayrollThrough: through };
}

export function getStaffPaydayCost(state: HotelState): number {
  const earned = STAFF_PERSONALITIES.enabled ? state.staffPayroll?.[String(state.day - 1)] : undefined;
  return earned ? (Object.values(earned).reduce((sum, wage) => sum + wage, 0) + (namedFrontDesk(state) ? 0 : state.staff.frontDesk * STAFF.frontDesk.dailyWage)) * getUpkeepMultiplier(state.starRating) : getStaffDailyCost(state);
}

/**
 * Get maintenance coverage info for the UI.
 */
export function getMaintenanceStatus(state: HotelState): {
  workers: number;
  roomsNeedingRepair: number;
  coverageRatio: number; // workers vs rooms that need it
  effectiveCapacity: number; // max rooms this crew can maintain
  recommendation: string | null;
} {
  const workers = state.staff.maintenanceWorkers;
  const needRepair = state.rooms.filter(
    r => r.status === 'vacant' && r.condition < STAFF.maintenance.conditionThreshold
  ).length;
  const totalRooms = state.rooms.length;
  const effectiveCapacity = workers * STAFF.maintenance.maxRoomsPerWorker;

  let recommendation: string | null = null;
  if (workers === 0 && totalRooms > 0) {
    recommendation = 'Hire a maintenance worker to keep rooms in good condition';
  } else if (totalRooms > effectiveCapacity) {
    recommendation = `Need ${Math.ceil(totalRooms / STAFF.maintenance.maxRoomsPerWorker)} workers for ${totalRooms} rooms`;
  } else if (workers > 0 && needRepair === 0 && totalRooms <= effectiveCapacity / 2) {
    recommendation = 'You could reduce maintenance staff (low workload)';
  }

  return {
    workers,
    roomsNeedingRepair: needRepair,
    coverageRatio: needRepair > 0 ? Math.min(1, workers / needRepair) : 1,
    effectiveCapacity,
    recommendation,
  };
}
