import { describe, it, expect } from 'vitest';
import { PRNG } from '../src/simulation/prng.js';
import {
  createHotelState, createStarterHotel, starterHallways, addRoom, addFixture, demolishFixture, addElevator, buildFloor,
  isRoomReachable, getAvailableRooms, getDemolishRefund,
} from '../src/simulation/HotelState.js';
import { getCheckInCapacity, getMannedDeskStaff, getAccessibleDesks, getEntranceTiles, findPath } from '../src/simulation/Layout.js';
import { processArrivals } from '../src/simulation/GuestManager.js';
import { calculateRoomNoise } from '../src/simulation/NoiseManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { HALLWAY, DESK, STAFF, GRID, ECONOMY } from '../src/config/balance.js';
import type { HotelState } from '../src/simulation/types.js';

const rich = (s: HotelState): HotelState => ({ ...s, cash: 1_000_000, peakStarRating: 5 });

/** Hallway tiles from (x0, y) to (x1, y) on a floor. */
function hallway(state: HotelState, y: number, x0: number, x1: number, floor = 0): HotelState {
  let s = state;
  for (let x = x0; x <= x1; x++) s = addFixture(s, 'hallway', x, y, floor)!;
  return s;
}

describe('Hallways and access', () => {
  it('a room with no hallway is not bookable', () => {
    const state = addRoom(rich(createHotelState()), 'standard', 4, 2)!;
    expect(isRoomReachable(state, state.rooms[0])).toBe(false);
  });

  it('a room is bookable once its door opens onto a hallway connected to the street', () => {
    let state = addRoom(rich(createHotelState()), 'standard', 4, 2)!;
    state = hallway(state, 3, 4, 9); // reaches the right edge: an entrance
    expect(getEntranceTiles(state)).toEqual([{ gridX: 9, gridY: 3, floor: 0 }]);
    expect(isRoomReachable(state, state.rooms[0])).toBe(true);
  });

  it('a hallway that never reaches the edge of the ground floor leads nowhere', () => {
    let state = addRoom(rich(createHotelState()), 'standard', 4, 2)!;
    state = hallway(state, 3, 3, 5); // interior stub
    expect(getEntranceTiles(state)).toEqual([]);
    expect(isRoomReachable(state, state.rooms[0])).toBe(false);
  });

  it('diagonal contact is not a door', () => {
    let state = addRoom(rich(createHotelState()), 'standard', 4, 2)!;
    state = hallway(state, 3, 5, 9); // touches (4,2) only at the corner
    expect(isRoomReachable(state, state.rooms[0])).toBe(false);
  });

  it('hallways cost money, take a tile, and refund a share when removed', () => {
    const state = rich(createHotelState());
    const built = addFixture(state, 'hallway', 0, 0, 0)!;
    expect(built.cash).toBe(state.cash - HALLWAY.buildCost);
    expect(addFixture(built, 'hallway', 0, 0, 0)).toBeNull();
    expect(addRoom(built, 'standard', 0, 0)).toBeNull();
    const removed = demolishFixture(built, built.fixtures[0].id)!;
    expect(removed.fixtures).toHaveLength(0);
    expect(removed.cash).toBe(built.cash + getDemolishRefund(HALLWAY.buildCost));
  });

  it('upper floors connect through an elevator that opens onto hallways on both floors', () => {
    let state = buildFloor(rich(createStarterHotel()))!.state;
    state = addRoom(state, 'standard', 5, 2, 1)!;
    state = addElevator(state, 0, 0)!; // opens onto the ground-floor row-1 hallway
    expect(isRoomReachable(state, state.rooms[0])).toBe(false); // no hallway upstairs yet
    state = { ...state, fixtures: [...state.fixtures, ...starterHallways(1)] };
    expect(isRoomReachable(state, state.rooms[0])).toBe(true);
  });

  it('hallways buffer noise: rooms across a corridor do not hear each other', () => {
    let state = rich(createStarterHotel());
    state = addRoom(state, 'standard', 5, 0)!; // above the row-1 hallway
    state = addRoom(state, 'standard', 5, 2)!; // below it
    state = {
      ...state,
      noiseSources: [],
      guests: [{ id: 'g', name: 'Sam', budget: 200, stayLength: 1, trait: 'party_guest', satisfaction: 50, checkInDay: 1, isReturning: false, hadNoiseComplaint: false }],
      rooms: state.rooms.map((r, i) => i === 1 ? { ...r, status: 'occupied' as const, guestId: 'g' } : r),
    };
    expect(calculateRoomNoise(state.rooms[0], state)).toBe(0);
  });
});

describe('Check-in desks', () => {
  it('without a desk, nobody can check in', () => {
    let state = rich(createHotelState());
    state = hallway(state, 1, 0, 9);
    state = addRoom(state, 'standard', 5, 2)!;
    expect(getCheckInCapacity(state)).toBe(0);
    const result = processArrivals({ ...state, day: 6 }, 16, new PRNG(1));
    expect(result.checkedIn).toHaveLength(0);
  });

  it('desks go on the ground floor only and must open onto a connected hallway', () => {
    let state = buildFloor(rich(createHotelState()))!.state;
    expect(addFixture(state, 'desk', 5, 5, 1)).toBeNull();
    state = addFixture(state, 'desk', 5, 5, 0)!;
    expect(state.cash).toBe(1_000_000 - 15000 - DESK.buildCost);
    expect(getAccessibleDesks(state)).toHaveLength(0);
    state = hallway(state, 4, 0, 9);
    expect(getAccessibleDesks(state)).toHaveLength(1);
  });

  it('each desk seats a limited number of front desk staff', () => {
    let state = rich(createStarterHotel());
    state = { ...state, staff: { ...state.staff, frontDesk: 5 } };
    expect(getMannedDeskStaff(state)).toBe(DESK.staffPerDesk);
    expect(getCheckInCapacity(state)).toBe(DESK.staffPerDesk * STAFF.frontDesk.checkInsPerHour);
    state = addFixture(state, 'desk', 4, 0, 0)!;
    expect(getMannedDeskStaff(state)).toBe(Math.min(5, 2 * DESK.staffPerDesk));
    expect(getCheckInCapacity({ ...state, staff: { ...state.staff, frontDesk: 0 } })).toBe(0);
  });

  it('the starter hotel checks guests in from day one', () => {
    let state = createStarterHotel();
    for (let x = 0; x < 6; x++) state = addRoom(state, 'standard', x, 2)!;
    state = { ...state, hour: 14 };
    const prng = new PRNG(3);
    for (let h = 0; h < 8; h++) state = tickSimulation(state, prng).state;
    expect(state.guests.length).toBeGreaterThan(0);
    expect(getAvailableRooms(state).length).toBeLessThan(6);
    expect(ECONOMY.startingCash - state.cash).toBe(6 * 2000); // the lobby was free
  });
});

describe('Pathfinding', () => {
  it('walks from the street to a room along hallways only', () => {
    let state = createStarterHotel();
    state = addRoom(state, 'standard', 6, 2)!;
    const [entrance] = getEntranceTiles(state);
    const path = findPath(state, entrance, { gridX: 6, gridY: 2, floor: 0 })!;
    expect(path[0]).toEqual(entrance);
    expect(path[path.length - 1]).toEqual({ gridX: 6, gridY: 2, floor: 0 });
    for (const step of path.slice(1, -1)) {
      expect(state.fixtures.some(f => f.type === 'hallway' && f.gridX === step.gridX && f.gridY === step.gridY && f.floor === step.floor)).toBe(true);
    }
    // Consecutive steps are adjacent
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      expect(Math.abs(a.gridX - b.gridX) + Math.abs(a.gridY - b.gridY) + Math.abs(a.floor - b.floor)).toBe(1);
    }
  });

  it('rides the elevator to reach an upper floor, and starts from a non-walkable tile like the desk', () => {
    let state = buildFloor(rich(createStarterHotel()))!.state;
    state = { ...state, fixtures: [...state.fixtures, ...starterHallways(1)] };
    state = addElevator(state, 0, 0)!;
    state = addRoom(state, 'standard', 7, 3, 1)!; // off the second hallway row, reached via the right-hand spine
    const desk = state.fixtures.find(f => f.type === 'desk')!;
    const path = findPath(state, desk, { gridX: 7, gridY: 3, floor: 1 })!;
    expect(path[0]).toEqual({ gridX: desk.gridX, gridY: desk.gridY, floor: 0 });
    expect(path.some(p => p.gridX === 0 && p.gridY === 0 && p.floor === 0)).toBe(true); // into the shaft
    expect(path.some(p => p.gridX === 0 && p.gridY === 0 && p.floor === 1)).toBe(true); // out upstairs
  });

  it('returns null when there is no route', () => {
    // Two rooms with no hallways anywhere
    let state = addRoom(rich(createHotelState()), 'standard', 6, 2)!;
    state = addRoom(state, 'standard', 2, 5)!;
    expect(findPath(state, { gridX: 6, gridY: 2, floor: 0 }, { gridX: 2, gridY: 5, floor: 0 })).toBeNull();
  });
});
