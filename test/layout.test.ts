import { describe, it, expect } from 'vitest';
import { PRNG } from '../src/simulation/prng.js';
import {
  createHotelState, createStarterHotel, addRoom, addFixture, addElevator, buildFloor, demolishRoom, setRoomDoor,
  isRoomReachable, getAvailableRooms, addFacility, setFacilityDoor, demolishFixture, getAdjacentFacilities,
} from '../src/simulation/HotelState.js';
import { calculateStarPoints } from '../src/simulation/StarRatingManager.js';
import {
  getCheckInCapacity, getMannedDeskStaff, getAccessibleDesks, getEntranceTiles, findPath, isHallway, findOpenDoor,
} from '../src/simulation/Layout.js';
import { processArrivals } from '../src/simulation/GuestManager.js';
import { calculateRoomNoise } from '../src/simulation/NoiseManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { DESK, STAFF, GRID, ECONOMY, ENTRANCE, STARTER_LAYOUT } from '../src/config/balance.js';
import type { HotelState } from '../src/simulation/types.js';

const rich = (s: HotelState): HotelState => ({ ...s, cash: 1_000_000, peakStarRating: 5 });

describe('Open floor plan and doors', () => {
  it('every tile starts as hallway, on new floors too, with one street entrance', () => {
    const state = buildFloor(rich(createHotelState()))!.state;
    for (const floor of [0, 1]) {
      for (let y = 0; y < GRID.height; y++) for (let x = 0; x < GRID.width; x++) expect(isHallway(state, x, y, floor)).toBe(true);
    }
    const [x, y] = STARTER_LAYOUT.entranceTile;
    expect(getEntranceTiles(state)).toEqual([{ gridX: x, gridY: y, floor: 0 }]);
  });

  it('a room takes its tile out of the hallway; demolishing it gives the tile back', () => {
    let state = addRoom(rich(createHotelState()), 'standard', 4, 2, 0, 'up')!;
    expect(isHallway(state, 4, 2, 0)).toBe(false);
    expect(addRoom(state, 'standard', 4, 2)).toBeNull();
    state = demolishRoom(state, state.rooms[0].id)!;
    expect(isHallway(state, 4, 2, 0)).toBe(true);
  });

  it('a room is usable only when its door opens onto hallway connected to the street', () => {
    let state = addRoom(rich(createHotelState()), 'standard', 4, 2, 0, 'up')!;
    expect(isRoomReachable(state, state.rooms[0])).toBe(true);
    // Another room built right outside the door blocks it
    state = addRoom(state, 'standard', 4, 1, 0, 'up')!;
    expect(isRoomReachable(state, state.rooms[0])).toBe(false);
    expect(getAvailableRooms(state).map(r => r.id)).toEqual([state.rooms[1].id]);
    // Turning the door to an open side fixes it, for free
    const cash = state.cash;
    state = setRoomDoor(state, state.rooms[0].id, 'down')!;
    expect(isRoomReachable(state, state.rooms[0])).toBe(true);
    expect(state.cash).toBe(cash);
  });

  it('a door facing the outside wall goes nowhere', () => {
    const state = addRoom(rich(createHotelState()), 'standard', 4, 0, 0, 'up')!;
    expect(isRoomReachable(state, state.rooms[0])).toBe(false);
  });

  it('a pocket of hallway walled in by rooms is cut off from the street', () => {
    let state = rich(createHotelState());
    // Wall in the tile (4,2) on all four sides; the room at (4,1) has its door into the pocket
    state = addRoom(state, 'standard', 4, 1, 0, 'down')!;
    state = addRoom(state, 'standard', 3, 2, 0, 'left')!;
    state = addRoom(state, 'standard', 5, 2, 0, 'right')!;
    state = addRoom(state, 'standard', 4, 3, 0, 'down')!;
    expect(isHallway(state, 4, 2, 0)).toBe(true);
    expect(isRoomReachable(state, state.rooms[0])).toBe(false);
    expect(state.rooms.slice(1).every(r => isRoomReachable(state, r))).toBe(true);
  });

  it('without a door given, a room faces the first open side', () => {
    let state = addRoom(rich(createHotelState()), 'standard', 4, 0)!; // up is the outside wall
    expect(state.rooms[0].door).toBe('down');
    state = addRoom(state, 'standard', 4, 1)!; // right outside it: up is that room
    expect(state.rooms[1].door).toBe('down');
    expect(findOpenDoor(state, { gridX: 4, gridY: 0, floor: 0 })).toBe('right');
  });

  it('upper floors connect through an elevator', () => {
    let state = buildFloor(rich(createStarterHotel()))!.state;
    state = addRoom(state, 'standard', 5, 2, 1, 'up')!;
    expect(isRoomReachable(state, state.rooms[0])).toBe(false); // no way up yet
    state = addElevator(state, 0, 0)!;
    expect(isRoomReachable(state, state.rooms[0])).toBe(true);
  });

  it('hallways buffer noise: rooms across a corridor do not hear each other', () => {
    let state = rich(createStarterHotel());
    state = addRoom(state, 'standard', 5, 0, 0, 'down')!; // above the row-1 hallway
    state = addRoom(state, 'standard', 5, 2, 0, 'up')!; // below it
    state = {
      ...state,
      noiseSources: [],
      guests: [{ id: 'g', name: 'Sam', budget: 200, stayLength: 1, trait: 'party_guest', satisfaction: 50, checkInDay: 1, isReturning: false, hadNoiseComplaint: false }],
      rooms: state.rooms.map((r, i) => i === 1 ? { ...r, status: 'occupied' as const, guestId: 'g' } : r),
    };
    expect(calculateRoomNoise(state.rooms[0], state)).toBe(0);
  });
});

describe('Street entrances', () => {
  it('go on the ground floor\'s outer edge only, and cost money', () => {
    const state = buildFloor(rich(createHotelState()))!.state;
    expect(addFixture(state, 'entrance', 5, 2, 0)).toBeNull(); // interior
    expect(addFixture(state, 'entrance', 5, 0, 1)).toBeNull(); // upstairs
    const built = addFixture(state, 'entrance', 9, 3, 0)!;
    expect(built.cash).toBe(state.cash - ENTRANCE.buildCost);
    expect(getEntranceTiles(built)).toHaveLength(2);
    expect(isHallway(built, 9, 3, 0)).toBe(true); // people walk through it
    expect(addRoom(built, 'standard', 9, 3)).toBeNull(); // but nothing gets built on it
  });

  it('are the only way in: without one, nothing is reachable', () => {
    let state = addRoom(rich(createHotelState()), 'standard', 5, 2, 0, 'up')!;
    expect(isRoomReachable(state, state.rooms[0])).toBe(true);
    state = demolishFixture(state, state.fixtures.find(f => f.type === 'entrance')!.id)!;
    expect(getEntranceTiles(state)).toEqual([]);
    expect(isRoomReachable(state, state.rooms[0])).toBe(false);
  });

  it('walling off the entrance cuts the hotel off; a second entrance opens another way in', () => {
    let state = addRoom(rich(createHotelState()), 'standard', 5, 2, 0, 'up')!;
    const [ex, ey] = STARTER_LAYOUT.entranceTile; // (0,4)
    state = addRoom(state, 'standard', ex + 1, ey, 0, 'up')!;
    state = addRoom(state, 'standard', ex, ey - 1, 0, 'up')!;
    state = addRoom(state, 'standard', ex, ey + 1, 0, 'right')!;
    expect(isRoomReachable(state, state.rooms[0])).toBe(false);
    state = addFixture(state, 'entrance', 9, 0, 0)!;
    expect(isRoomReachable(state, state.rooms[0])).toBe(true);
  });
});

describe('Facility doors', () => {
  it('a facility with a blocked door earns no stars and gives nearby rooms no bonus', () => {
    let state = addFacility(rich(createHotelState()), 'gym', 5, 2, 0, 'up')!;
    state = addRoom(state, 'standard', 6, 2, 0, 'up')!;
    const open = calculateStarPoints(state);
    expect(getAdjacentFacilities(state, 6, 2, 0)).toHaveLength(1);

    state = addRoom(state, 'standard', 5, 1, 0, 'up')!; // right outside the gym's door
    expect(getAdjacentFacilities(state, 6, 2, 0)).toHaveLength(0);
    expect(calculateStarPoints(state)).toBeLessThan(open);

    state = setFacilityDoor(state, state.facilities[0].id, 'down')!; // turn it to an open side
    expect(getAdjacentFacilities(state, 6, 2, 0)).toHaveLength(1);
  });
});

describe('Check-in desks', () => {
  it('without a desk, nobody can check in', () => {
    let state = rich(createHotelState());
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
    expect(getAccessibleDesks(state)).toHaveLength(1);
    // Hemmed in by rooms (the bottom edge is the outside wall)
    for (const [x, y] of [[4, 5], [6, 5], [5, 4]]) state = addRoom(state, 'standard', x, y, 0, 'up')!;
    expect(getAccessibleDesks(state)).toHaveLength(0);
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
    state = addRoom(state, 'standard', 6, 2, 0, 'left')!;
    const [entrance] = getEntranceTiles(state);
    const path = findPath(state, entrance, state.rooms[0])!;
    expect(path[0]).toEqual(entrance);
    expect(path[path.length - 1]).toEqual({ gridX: 6, gridY: 2, floor: 0 });
    expect(path[path.length - 2]).toEqual({ gridX: 5, gridY: 2, floor: 0 }); // in through the door
    for (const step of path.slice(1, -1)) expect(isHallway(state, step.gridX, step.gridY, step.floor)).toBe(true);
    // Consecutive steps are adjacent
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      expect(Math.abs(a.gridX - b.gridX) + Math.abs(a.gridY - b.gridY) + Math.abs(a.floor - b.floor)).toBe(1);
    }
  });

  it('rides the elevator to reach an upper floor, and starts from a non-walkable tile like the desk', () => {
    let state = buildFloor(rich(createStarterHotel()))!.state;
    state = addElevator(state, 0, 0)!;
    state = addRoom(state, 'standard', 7, 3, 1, 'down')!;
    const desk = state.fixtures.find(f => f.type === 'desk')!;
    const path = findPath(state, desk, { gridX: 7, gridY: 3, floor: 1 })!;
    expect(path[0]).toEqual({ gridX: desk.gridX, gridY: desk.gridY, floor: 0 });
    expect(path.some(p => p.gridX === 0 && p.gridY === 0 && p.floor === 0)).toBe(true); // into the shaft
    expect(path.some(p => p.gridX === 0 && p.gridY === 0 && p.floor === 1)).toBe(true); // out upstairs
  });

  it('returns null when there is no route', () => {
    // A room whose door faces another room
    let state = addRoom(rich(createHotelState()), 'standard', 6, 2, 0, 'left')!;
    state = addRoom(state, 'standard', 5, 2, 0, 'up')!;
    expect(findPath(state, { gridX: 0, gridY: 0, floor: 0 }, state.rooms[0])).toBeNull();
    expect(findPath(state, { gridX: 0, gridY: 0, floor: 0 }, state.rooms[1])).not.toBeNull();
  });
});
