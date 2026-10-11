import type { HotelState, GameEvent } from './types.js';
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
    return { ...room, condition: Math.min(100, room.condition + repairAmount * hours) };
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
  const maintenanceCost = state.staff.maintenanceWorkers * STAFF.maintenance.dailyWage;
  const housekeepingCost = state.staff.housekeepers * STAFF.housekeeping.dailyWage;
  const frontDeskCost = state.staff.frontDesk * STAFF.frontDesk.dailyWage;
  return (maintenanceCost + housekeepingCost + frontDeskCost) * getUpkeepMultiplier(state.starRating);
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
