import { describe, it, expect } from 'vitest';
import {
  createHotelState, createStarterHotel, starterHallways, addRoom, addFixture, addElevator, buildFloor,
} from '../src/simulation/HotelState.js';
import { getStaffTravelHours, getStaffBases, getAccessibleBreakRooms } from '../src/simulation/Layout.js';
import { startTurnoverCleaning, processCleaningTick, processDailyHousekeeping } from '../src/simulation/HousekeepingManager.js';
import { processMaintenanceTick } from '../src/simulation/MaintenanceManager.js';
import { TRAVEL, HOUSEKEEPING, STAFF, CLOSET, BREAK_ROOM, STARTER_LAYOUT } from '../src/config/balance.js';
import type { HotelState, Room } from '../src/simulation/types.js';

const rich = (s: HotelState): HotelState => ({ ...s, cash: 1_000_000, peakStarRating: 5 });

/** Starter lobby plus a second floor with hallways and an elevator. */
function twoFloors(): HotelState {
  let s = buildFloor(rich(createStarterHotel()))!.state;
  s = { ...s, fixtures: [...s.fixtures, ...starterHallways(1)] };
  return addElevator(s, 0, 0)!;
}

/** A lobby with only the top hallway row, so rows 3+ have no hallway access. */
function oneHallway(): HotelState {
  let s = rich(createHotelState());
  for (let x = 0; x < 10; x++) s = addFixture(s, 'hallway', x, 1, 0)!;
  return addFixture(s, 'desk', 3, 0, 0)!;
}

const roomAt = (s: HotelState, x: number, y: number, floor = 0): Room =>
  s.rooms.find(r => r.gridX === x && r.gridY === y && r.floor === floor)!;

describe('Staff travel time', () => {
  it('staff start from the lobby, in front of the desk', () => {
    const [deskX] = STARTER_LAYOUT.deskTiles[0];
    expect(getStaffBases(createStarterHotel())).toEqual([{ gridX: deskX, gridY: 1, floor: 0 }]);
  });

  it('is the hallway walk from the nearest base to the door', () => {
    let s = rich(createStarterHotel());
    s = addRoom(s, 'standard', 4, 0)!; // right beside the desk
    s = addRoom(s, 'standard', 8, 2)!; // further down the hall
    const near = getStaffTravelHours(s, roomAt(s, 4, 0));
    const far = getStaffTravelHours(s, roomAt(s, 8, 2));
    // Base is (3,1): (4,0) is one step along the hall plus the step in
    expect(near).toBeCloseTo(2 * TRAVEL.hoursPerTile, 6);
    expect(far).toBeCloseTo(6 * TRAVEL.hoursPerTile, 6);
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
    const s = addFixture(oneHallway(), 'breakroom', 5, 3, 0)!; // touches no hallway
    expect(getAccessibleBreakRooms(s)).toEqual([]);
  });

  it('is Infinity when staff cannot get there', () => {
    const s = addRoom(oneHallway(), 'standard', 5, 3)!; // touches no hallway
    expect(getStaffTravelHours(s, roomAt(s, 5, 3))).toBe(Infinity);
  });

  it('falls back to the street entrance when there is no desk or closet', () => {
    let s = rich(createHotelState());
    for (let x = 0; x < 10; x++) s = addFixture(s, 'hallway', x, 1, 0)!;
    expect(getStaffBases(s)).toEqual([{ gridX: 0, gridY: 1, floor: 0 }, { gridX: 9, gridY: 1, floor: 0 }]);
  });
});

describe('Travel in housekeeping', () => {
  it('a turnover clean includes the walk there', () => {
    const s = addRoom(rich(createStarterHotel()), 'standard', 8, 2)!;
    const room = roomAt(s, 8, 2);
    const travel = getStaffTravelHours(s, room);
    expect(startTurnoverCleaning(room, 'standard', travel).cleaningHoursRemaining)
      .toBeCloseTo(HOUSEKEEPING.turnoverDuration.standard + travel, 6);
    expect(startTurnoverCleaning(room, 'standard', Infinity).cleaningHoursRemaining)
      .toBe(HOUSEKEEPING.turnoverDuration.standard); // never store Infinity in state
  });

  it('pooled hours: finishing a room early frees the rest of the hour for the next one', () => {
    let s = rich(createStarterHotel());
    s = addRoom(s, 'standard', 5, 2)!;
    s = addRoom(s, 'standard', 6, 2)!;
    s = {
      ...s, hour: 12, staff: { ...s.staff, housekeepers: 1 },
      rooms: s.rooms.map((r, i) => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: i === 0 ? 0.25 : 2 })),
    };
    const after = processCleaningTick(s).state;
    expect(after.rooms[0].status).toBe('vacant');
    expect(after.rooms[1].cleaningHoursRemaining).toBeCloseTo(1.25, 6);
  });

  it('rooms staff cannot reach make no cleaning progress', () => {
    let s = addRoom(oneHallway(), 'standard', 5, 3)!;
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
    near = addRoom(near, 'standard', 2, 0)!;
    near = addRoom(near, 'standard', 4, 0)!;
    let far = rich(createStarterHotel());
    far = addRoom(far, 'standard', 7, 0)!;
    far = addRoom(far, 'standard', 8, 0)!;

    const queued = (s: HotelState) => processDailyHousekeeping(occupy(s)).state;
    const queuedHours = (s: HotelState) => queued(s).rooms.reduce((sum, r) => sum + r.dailyCleanHoursRemaining, 0);
    expect(queuedHours(far)).toBeGreaterThan(queuedHours(near));
    expect(queuedHours(near)).toBeCloseTo(2 / STAFF.housekeeping.dailyCleanRoomsPerHour + near.rooms.reduce((sum, r) => sum + getStaffTravelHours(near, r), 0), 6);

    // One housekeeper-hour: finishes both near rooms only if the walks fit
    const cleanedAfterAnHour = (s: HotelState) => processCleaningTick(queued(s)).state.rooms.filter(r => r.lastDailyCleanDay === 4).length;
    expect(cleanedAfterAnHour(far)).toBeLessThanOrEqual(cleanedAfterAnHour(near));
  });
});

describe('Travel in maintenance', () => {
  it('a far-off repair gets less done in the hour than a nearby one', () => {
    let s = twoFloors();
    s = addRoom(s, 'standard', 4, 0, 0)!; // by the lobby
    s = addRoom(s, 'standard', 8, 5, 1)!; // far corner upstairs
    s = { ...s, hour: 12, staff: { ...s.staff, maintenanceWorkers: 2 }, rooms: s.rooms.map(r => ({ ...r, condition: 30 })) };
    const after = processMaintenanceTick(s).state;
    const nearGain = after.rooms[0].condition - 30;
    const farGain = after.rooms[1].condition - 30;
    expect(nearGain).toBeGreaterThan(farGain);
    expect(farGain).toBeGreaterThanOrEqual(STAFF.maintenance.repairPerHour * TRAVEL.minRepairEfficiency);
    expect(nearGain).toBeCloseTo(STAFF.maintenance.repairPerHour * (1 - getStaffTravelHours(s, s.rooms[0])), 6);
  });

  it('rooms staff cannot reach are not repaired', () => {
    let s = addRoom(oneHallway(), 'standard', 5, 3)!;
    s = { ...s, hour: 12, staff: { ...s.staff, maintenanceWorkers: 1 }, rooms: s.rooms.map(r => ({ ...r, condition: 30 })) };
    expect(processMaintenanceTick(s).state.rooms[0].condition).toBe(30);
  });
});
