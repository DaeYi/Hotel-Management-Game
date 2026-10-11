import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom } from '../src/simulation/HotelState.js';
import {
  processCleaningTick, processDailyHousekeeping, startTurnoverCleaning, estimateHousekeepingHours,
  housekeepersNeeded, housekeepingHoursAvailable, getHousekeepingStatus, PLANNING_OCCUPANCY,
  planHousekeeping, currentJob,
} from '../src/simulation/HousekeepingManager.js';
import { planMaintenance, processMaintenanceTick } from '../src/simulation/MaintenanceManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { processDailyCosts } from '../src/simulation/EconomyManager.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { HOUSEKEEPING, STAFF, AMENITIES } from '../src/config/balance.js';
import type { HotelState } from '../src/simulation/types.js';

/** Starter lobby with `n` standard rooms on row 2, all occupied and due a clean. */
function hotel(n: number, housekeepers: number): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000 };
  for (let x = 0; x < n; x++) s = addRoom(s, 'standard', x, 2)!;
  return {
    ...s, day: 4, hour: HOUSEKEEPING.dailyCleaningHour,
    staff: { ...s.staff, housekeepers },
    rooms: s.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: `g-${r.id}`, cleanliness: 50 })),
  };
}

describe('Daily cleans share the housekeeping pool', () => {
  it('are queued at the cleaning hour with the walk included, then worked off hour by hour', () => {
    const queued = processDailyHousekeeping(hotel(2, 1)).state;
    expect(queued.rooms.every(r => r.dailyCleanHoursRemaining > 1 / STAFF.housekeeping.dailyCleanRoomsPerHour)).toBe(true);
    expect(queued.rooms.every(r => r.cleanliness === 50)).toBe(true); // nothing done yet

    let s = queued;
    for (let h = 0; h < 3; h++) s = processCleaningTick({ ...s, hour: s.hour + h }).state;
    expect(s.rooms.every(r => r.lastDailyCleanDay === 4 && r.dailyCleanHoursRemaining === 0)).toBe(true);
    expect(s.rooms.every(r => r.cleanliness === 50 + HOUSEKEEPING.dailyCleaningBoost)).toBe(true);
    expect(s.cash).toBe(queued.cash - 2 * HOUSEKEEPING.dailyCleaningCost);
  });

  it('turnovers come first: they block bookings', () => {
    let s = processDailyHousekeeping(hotel(2, 1)).state;
    // The first room checks out and needs a turnover; one housekeeper-hour is all there is
    s = { ...s, rooms: s.rooms.map((r, i) => i === 0 ? startTurnoverCleaning(r, 'standard', 0) : r) };
    const after = processCleaningTick(s).state;
    expect(after.rooms[0].cleaningHoursRemaining).toBeCloseTo(HOUSEKEEPING.turnoverDuration.standard - 1, 6);
    expect(after.rooms[1].dailyCleanHoursRemaining).toBe(s.rooms[1].dailyCleanHoursRemaining); // untouched
  });

  it('a checkout cancels a pending daily clean', () => {
    const s = processDailyHousekeeping(hotel(1, 1)).state;
    expect(startTurnoverCleaning(s.rooms[0], 'standard', 0).dailyCleanHoursRemaining).toBe(0);
  });

  it('daily cleans still pending when the shift ends are skipped', () => {
    let s = processDailyHousekeeping(hotel(9, 1)).state;
    s = { ...s, hour: STAFF.housekeeping.workEndHour - 1 };
    const result = processCleaningTick(s);
    expect(result.state.rooms.every(r => r.dailyCleanHoursRemaining === 0)).toBe(true);
    expect(result.events.some(e => e.type === 'daily_cleaning' && (e.data as any)?.roomsSkipped > 0)).toBe(true);
  });
});

describe('Housekeeping workload', () => {
  it('scales with rooms, occupancy, and turnover quality', () => {
    const small = hotel(4, 1);
    const big = hotel(9, 1);
    expect(estimateHousekeepingHours(big, 0.8)).toBeGreaterThan(estimateHousekeepingHours(small, 0.8));
    expect(estimateHousekeepingHours(big, 0.9)).toBeGreaterThan(estimateHousekeepingHours(big, 0.5));
    const thorough = { ...big, housekeeping: { ...big.housekeeping, turnoverQuality: 'thorough' as const } };
    expect(estimateHousekeepingHours(thorough, 0.8)).toBeGreaterThan(estimateHousekeepingHours(big, 0.8));
  });

  it('housekeepersNeeded covers the estimated hours', () => {
    const s = hotel(9, 1);
    const needed = housekeepersNeeded(s, PLANNING_OCCUPANCY);
    expect(housekeepingHoursAvailable(needed)).toBeGreaterThanOrEqual(estimateHousekeepingHours(s, PLANNING_OCCUPANCY));
    expect(housekeepingHoursAvailable(needed - 1)).toBeLessThan(estimateHousekeepingHours(s, PLANNING_OCCUPANCY));
  });

  it('the staff panel status warns when a busy day would outrun the team', () => {
    const s = hotel(9, 1);
    const status = getHousekeepingStatus(s);
    expect(status.hoursNeeded).toBeGreaterThan(status.hoursAvailable);
    expect(status.recommendation).toContain(`${housekeepersNeeded(s, PLANNING_OCCUPANCY)} housekeepers`);
    expect(getHousekeepingStatus({ ...s, staff: { ...s.staff, housekeepers: 20 } }).recommendation).toBeNull();
  });
});

describe('Amenities are charged per occupied room', () => {
  it('empty rooms cost no amenities', () => {
    const occupied = hotel(4, 1);
    const empty = { ...occupied, rooms: occupied.rooms.map(r => ({ ...r, status: 'vacant' as const, guestId: undefined })) };
    const perRoom = AMENITIES.tiers[occupied.amenities.standard].dailyCostPerRoom;
    expect(processDailyCosts(empty).cashDelta - processDailyCosts(occupied).cashDelta).toBeCloseTo(4 * perRoom, 6);
  });
});

describe('Balance: there is a right amount of housekeeping', () => {
  it('staffing to the workload beats both under- and over-staffing', () => {
    const runs = 6;
    const median = (name: string) => {
      const vals = Array.from({ length: runs }, (_, i) => simulate(400, i, undefined, STRATEGIES[name]).finalValuation).sort((a, b) => a - b);
      return (vals[2] + vals[3]) / 2;
    };
    const right = median('balanced');
    expect(right).toBeGreaterThan(median('understaffed'));
    expect(right).toBeGreaterThan(median('overstaffed'));
  }, 240000);
});

describe('The work plan the animation shows is the work the simulation does', () => {
  /** Two checkouts being turned over plus queued daily cleans, two housekeepers. */
  function busyHotel(): HotelState {
    let s = processDailyHousekeeping(hotel(6, 2)).state;
    s = { ...s, hour: 12, rooms: s.rooms.map((r, i) => i < 2 ? startTurnoverCleaning(r, 'standard', 0.3 + i) : r) };
    return s;
  }

  it('gives each housekeeper at most an hour, and each room at most an hour', () => {
    const plan = planHousekeeping(busyHotel());
    expect(plan).toHaveLength(2);
    for (const jobs of plan) expect(jobs.reduce((sum, j) => sum + j.hours, 0)).toBeLessThanOrEqual(1 + 1e-9);
    const perRoom = new Map<string, number>();
    for (const job of plan.flat()) perRoom.set(job.roomId, (perRoom.get(job.roomId) ?? 0) + job.hours);
    for (const hours of perRoom.values()) expect(hours).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('the cleaning tick moves each room on by exactly its planned hours', () => {
    const before = busyHotel();
    const planned = new Map<string, number>();
    for (const job of planHousekeeping(before).flat()) planned.set(job.roomId, (planned.get(job.roomId) ?? 0) + job.hours);
    const after = processCleaningTick(before).state;

    for (const room of before.rooms) {
      const next = after.rooms.find(r => r.id === room.id)!;
      const worked = room.status === 'cleaning'
        ? room.cleaningHoursRemaining - next.cleaningHoursRemaining
        : room.dailyCleanHoursRemaining - next.dailyCleanHoursRemaining;
      expect(worked).toBeCloseTo(planned.get(room.id) ?? 0, 6);
    }
  });

  it('within the hour, a housekeeper moves from job to job as each share of the hour is used up', () => {
    const jobs = [
      { roomId: 'a', hours: 0.25, kind: 'turnover' as const },
      { roomId: 'b', hours: 0.5, kind: 'daily' as const },
    ];
    expect(currentJob(jobs, 0)?.roomId).toBe('a');
    expect(currentJob(jobs, 0.3)?.roomId).toBe('b');
    expect(currentJob(jobs, 0.8)).toBeNull(); // done for the hour
    expect(currentJob([], 0.5)).toBeNull();
  });

  it('maintenance repairs exactly the planned rooms', () => {
    let s = hotel(4, 1);
    s = { ...s, hour: 12, staff: { ...s.staff, maintenanceWorkers: 2 },
      rooms: s.rooms.map((r, i) => ({ ...r, status: 'vacant' as const, guestId: undefined, condition: 20 + i * 10 })) };
    const plan = planMaintenance(s);
    expect(plan).toEqual([s.rooms[0].id, s.rooms[1].id]); // worst two
    const after = processMaintenanceTick(s).state;
    const repaired = after.rooms.filter((r, i) => r.condition > s.rooms[i].condition).map(r => r.id);
    expect(repaired).toEqual(plan);
  });

  it('a full simulation tick applies the plan made from the state at the start of the hour', () => {
    const before = busyHotel();
    const planned = new Set(planHousekeeping(before).flat().filter(j => j.kind === 'turnover').map(j => j.roomId));
    const after = tickSimulation(before, new PRNG(1)).state;
    for (const room of before.rooms.filter(r => r.status === 'cleaning')) {
      const next = after.rooms.find(r => r.id === room.id)!;
      const progressed = next.status !== 'cleaning' || next.cleaningHoursRemaining < room.cleaningHoursRemaining;
      expect(progressed).toBe(planned.has(room.id));
    }
  });
});
