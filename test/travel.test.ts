import { describe, it, expect } from 'vitest';
import {
  createHotelState, createStarterHotel, addRoom, addFixture, addElevator, buildFloor,
} from '../src/simulation/HotelState.js';
import { getStaffTravelHours, getStaffBases, getAccessibleBreakRooms, getEntranceTiles } from '../src/simulation/Layout.js';
import { startTurnoverCleaning, processCleaningTick, processDailyHousekeeping } from '../src/simulation/HousekeepingManager.js';
import { findRoute } from '../src/simulation/Layout.js';
import { processMaintenanceTick } from '../src/simulation/MaintenanceManager.js';
import { TRAVEL, HOUSEKEEPING, STAFF, CLOSET, BREAK_ROOM, STARTER_LAYOUT } from '../src/config/balance.js';
import type { HotelState, Room } from '../src/simulation/types.js';

const rich = (s: HotelState): HotelState => ({ ...s, cash: 1_000_000, peakStarRating: 5 });

/** Starter lobby plus a second floor and an elevator. */
function twoFloors(): HotelState {
  const s = buildFloor(rich(createStarterHotel()))!.state;
  return addElevator(s, 0, 0)!;
}

/** The starter lobby with a room at (5,3) whose door is blocked by the room at (5,2). */
function blockedRoom(): HotelState {
  let s = addRoom(rich(createStarterHotel()), 'standard', 5, 3, 0, 'up')!;
  s = addRoom(s, 'standard', 5, 2, 0, 'up')!;
  return { ...s, rooms: [roomAt(s, 5, 3), roomAt(s, 5, 2)] };
}

const roomAt = (s: HotelState, x: number, y: number, floor = 0): Room =>
  s.rooms.find(r => r.gridX === x && r.gridY === y && r.floor === floor)!;

describe('Staff travel time', () => {
  it('staff start from the lobby, in front of the desk (just inside the street entrance)', () => {
    const [deskX, deskY] = STARTER_LAYOUT.deskTiles[0];
    expect(getStaffBases(createStarterHotel())).toEqual([{ gridX: deskX, gridY: deskY + 1, floor: 0 }]);
  });

  it('is the hallway walk from the nearest base to the door', () => {
    let s = rich(createStarterHotel());
    s = addRoom(s, 'standard', 2, 5, 0, 'up')!; // just across from the lobby
    s = addRoom(s, 'standard', 8, 2, 0, 'up')!; // across the floor
    const near = getStaffTravelHours(s, roomAt(s, 2, 5));
    const far = getStaffTravelHours(s, roomAt(s, 8, 2));
    // Base is (1,4): (2,5) is one step along the hall plus the step in
    expect(near).toBeCloseTo(2 * TRAVEL.hoursPerTile, 6);
    expect(far).toBeCloseTo(11 * TRAVEL.hoursPerTile, 6);
  });

  it('includes the elevator ride for upper floors, and a closet up there cuts it', () => {
    let s = twoFloors();
    s = addRoom(s, 'standard', 6, 2, 1)!;
    const viaLobby = getStaffTravelHours(s, roomAt(s, 6, 2, 1));
    expect(viaLobby).toBeGreaterThan(TRAVEL.hoursPerFloor);

    const withCloset = addFixture(s, 'closet', 5, 0, 1)!;
    expect(withCloset.cash).toBe(s.cash - CLOSET.buildCost);
    expect(getStaffTravelHours(withCloset, roomAt(withCloset, 6, 2, 1))).toBeCloseTo(2 * TRAVEL.hoursPerTile, 6);
  });

  it('a break room can go on any floor, and walks start from it like a closet', () => {
    let s = twoFloors();
    s = addRoom(s, 'standard', 6, 2, 1)!;
    const withBreakRoom = addFixture(s, 'breakroom', 5, 0, 1)!;
    expect(withBreakRoom.cash).toBe(s.cash - BREAK_ROOM.buildCost);
    expect(getAccessibleBreakRooms(withBreakRoom).map(f => f.id)).toEqual(['breakroom-1-5-0']);
    expect(getStaffBases(withBreakRoom)).toContainEqual({ gridX: 5, gridY: 1, floor: 1 });
    expect(getStaffTravelHours(withBreakRoom, roomAt(withBreakRoom, 6, 2, 1))).toBeCloseTo(2 * TRAVEL.hoursPerTile, 6);
  });

  it('a break room off the hallways is no use to anyone', () => {
    let s = addFixture(rich(createStarterHotel()), 'breakroom', 5, 5, 0)!;
    for (const [x, y] of [[4, 5], [6, 5], [5, 4]]) s = addRoom(s, 'standard', x, y, 0, 'up')!; // hemmed in
    expect(getAccessibleBreakRooms(s)).toEqual([]);
  });

  it('is Infinity when staff cannot get there', () => {
    const s = blockedRoom();
    expect(getStaffTravelHours(s, roomAt(s, 5, 3))).toBe(Infinity);
  });

  it('falls back to the street entrance when there is no desk or closet', () => {
    const s = rich(createHotelState());
    expect(getStaffBases(s)).toEqual(getEntranceTiles(s));
  });
});

describe('Travel in housekeeping', () => {
  it('the walk to a turnover comes out of the housekeeper\'s hour, not the job', () => {
    let s = addRoom(rich(createStarterHotel()), 'standard', 8, 2, 0, 'up')!;
    const room = roomAt(s, 8, 2);
    expect(startTurnoverCleaning(room, 'standard').cleaningHoursRemaining).toBe(HOUSEKEEPING.turnoverDuration.standard);
    s = { ...s, hour: 12, rooms: [startTurnoverCleaning(room, 'standard')] };
    const walk = getStaffTravelHours(s, room); // from the lobby, where the housekeeper waits
    expect(processCleaningTick(s).state.rooms[0].cleaningHoursRemaining).toBeCloseTo(HOUSEKEEPING.turnoverDuration.standard - (1 - walk), 6);
  });

  it('finishing a room partway through the hour, a housekeeper walks to the next and works the rest of the hour there', () => {
    let s = rich(createStarterHotel());
    s = addRoom(s, 'standard', 5, 2, 0, 'up')!;
    s = addRoom(s, 'standard', 6, 2, 0, 'up')!;
    s = {
      ...s, hour: 12, staff: { ...s.staff, housekeepers: 1 },
      rooms: s.rooms.map((r, i) => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: i === 0 ? 0.25 : 2 })),
    };
    const first = getStaffTravelHours(s, s.rooms[0]);
    const between = findRoute(s, { ...s.rooms[0] }, { ...s.rooms[1] })!.hours; // out one door, along the hall, in the next
    const after = processCleaningTick(s).state;
    expect(after.rooms[0].status).toBe('vacant');
    expect(after.rooms[1].cleaningHoursRemaining).toBeCloseTo(2 - (1 - first - 0.25 - between), 6);
  });

  it('rooms staff cannot reach make no cleaning progress', () => {
    let s = blockedRoom();
    s = { ...s, hour: 12, rooms: s.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: 2 })) };
    expect(processCleaningTick(s).state.rooms[0].cleaningHoursRemaining).toBe(2);
  });

  it('daily cleans for distant rooms take longer, so one housekeeper gets through fewer in an hour', () => {
    const occupy = (s: HotelState): HotelState => ({
      ...s, hour: HOUSEKEEPING.dailyCleaningHour, day: 4, staff: { ...s.staff, housekeepers: 1 },
      rooms: s.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: `g-${r.id}`, cleanliness: 50 })),
    });
    // The same two-room job, near the lobby vs at the far end of the hall
    let near = rich(createStarterHotel());
    near = addRoom(near, 'standard', 2, 5, 0, 'up')!;
    near = addRoom(near, 'standard', 3, 5, 0, 'up')!;
    let far = rich(createStarterHotel());
    far = addRoom(far, 'standard', 8, 0, 0, 'down')!;
    far = addRoom(far, 'standard', 9, 0, 0, 'down')!;

    // The clean itself is the same job anywhere; the walks are what differ
    const queued = (s: HotelState) => processDailyHousekeeping(occupy(s)).state;
    expect(queued(near).rooms.every(r => r.dailyCleanHoursRemaining === 1 / STAFF.housekeeping.dailyCleanRoomsPerHour)).toBe(true);
    const remaining = (s: HotelState) => processCleaningTick(queued(s)).state.rooms.reduce((sum, r) => sum + r.dailyCleanHoursRemaining, 0);
    expect(remaining(far)).toBeGreaterThan(remaining(near));
    const cleanedAfterAnHour = (s: HotelState) => processCleaningTick(queued(s)).state.rooms.filter(r => r.lastDailyCleanDay === 4).length;
    expect(cleanedAfterAnHour(far)).toBeLessThanOrEqual(cleanedAfterAnHour(near));
  });
});

describe('Travel in maintenance', () => {
  it('a far-off repair gets less done in the hour than a nearby one', () => {
    let s = twoFloors();
    s = addRoom(s, 'standard', 2, 5, 0, 'up')!; // by the lobby
    s = addRoom(s, 'standard', 8, 5, 1, 'up')!; // far corner upstairs
    s = { ...s, hour: 12, staff: { ...s.staff, maintenanceWorkers: 2 }, rooms: s.rooms.map(r => ({ ...r, condition: 30 })) };
    const after = processMaintenanceTick(s).state;
    const nearGain = after.rooms[0].condition - 30;
    const farGain = after.rooms[1].condition - 30;
    expect(nearGain).toBeGreaterThan(farGain);
    expect(nearGain).toBeCloseTo(STAFF.maintenance.repairPerHour * (1 - getStaffTravelHours(s, s.rooms[0])), 6);
    expect(farGain).toBeCloseTo(STAFF.maintenance.repairPerHour * (1 - getStaffTravelHours(s, s.rooms[1])), 6);
  });

  it('rooms staff cannot reach are not repaired', () => {
    let s = blockedRoom();
    s = { ...s, hour: 12, staff: { ...s.staff, maintenanceWorkers: 1 }, rooms: s.rooms.map(r => ({ ...r, condition: 30 })) };
    expect(processMaintenanceTick(s).state.rooms[0].condition).toBe(30);
  });
});
