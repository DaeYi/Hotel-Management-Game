import type { HotelState, Room, GameEvent } from './types.js';
import { STAFF, TRAVEL } from '../config/balance.js';
import { getStaffTravelHours } from './Layout.js';
import { getUpkeepMultiplier } from './StarRatingManager.js';

/**
 * Process maintenance workers repairing rooms.
 * Workers automatically repair vacant rooms below the condition threshold.
 * Runs each game-hour during the work shift.
 */
export function processMaintenanceTick(state: HotelState): { state: HotelState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  const workers = state.staff.maintenanceWorkers;

  if (workers <= 0) return { state, events };

  // Only work during shift hours
  if (state.hour < STAFF.maintenance.workStartHour || state.hour >= STAFF.maintenance.workEndHour) {
    return { state, events };
  }

  // Find rooms that need repair: vacant, below threshold, and somewhere staff can walk to
  const roomsNeedingRepair = state.rooms
    .filter(r => r.status === 'vacant' && r.condition < STAFF.maintenance.conditionThreshold)
    .filter(r => Number.isFinite(getStaffTravelHours(state, r)))
    .sort((a, b) => a.condition - b.condition); // worst condition first

  if (roomsNeedingRepair.length === 0) return { state, events };

  // Each worker can service one room per hour
  const roomsToRepair = roomsNeedingRepair.slice(0, workers);
  const repairAmount = STAFF.maintenance.repairPerHour;

  const repairedIds = new Set(roomsToRepair.map(r => r.id));

  const updatedRooms = state.rooms.map(room => {
    if (!repairedIds.has(room.id)) return room;

    // The walk there comes out of the hour's work
    const efficiency = Math.max(TRAVEL.minRepairEfficiency, 1 - getStaffTravelHours(state, room));
    const newCondition = Math.min(100, room.condition + repairAmount * efficiency);
    return { ...room, condition: newCondition };
  });

  const roomsActuallyRepaired = roomsToRepair.length;
  if (roomsActuallyRepaired > 0) {
    // Only emit event once per tick, batched
    events.push({
      type: 'maintenance_repair',
      message: `Maintenance: ${roomsActuallyRepaired} room${roomsActuallyRepaired > 1 ? 's' : ''} repaired (+${repairAmount} condition)`,
      data: { roomsRepaired: roomsActuallyRepaired, repairAmount },
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
