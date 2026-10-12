import { describe, it, expect } from 'vitest';
import { PRNG } from '../src/simulation/prng.js';
import {
  createHotelState, createStarterHotel, addRoom, addFacility, buildFloor, getNextFloorCost, getFloorsBuildCost, addElevator, demolishElevator,
  isTileOccupied, getAvailableRooms, getElevatorLoad, isRoomReachable, getElevatorWaitPenalty, formatRoomLabel,
} from '../src/simulation/HotelState.js';
import { calculateRoomNoise } from '../src/simulation/NoiseManager.js';
import { calculateGuestReviewBreakdown } from '../src/simulation/GuestManager.js';
import { processDailyCosts } from '../src/simulation/EconomyManager.js';
import { getExpectedPrice } from '../src/simulation/StarRatingManager.js';
import { calculateValuation } from '../src/simulation/ObjectivesManager.js';
import { packIntoLayout, openFloorPlan, addEntranceAndFacilityDoors } from '../src/simulation/SaveManager.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { FLOORS, ELEVATOR, GRID, NOISE, ROOM_CONFIG, STARTER_LAYOUT, TRAVEL, FACILITY_VISITS } from '../src/config/balance.js';
import { findRoute } from '../src/simulation/Layout.js';
import type { Guest, HotelState } from '../src/simulation/types.js';

function richState(): HotelState {
  return { ...createHotelState(), peakStarRating: 5, cash: 1_000_000 };
}

function withFloors(state: HotelState, count: number): HotelState {
  let s = state;
  while (s.floorCount < count) s = buildFloor(s)!.state;
  return s;
}

const guest = (id: string, trait: Guest['trait'] = 'normal'): Guest => ({
  id, name: 'Sam', budget: 500, stayLength: 2, trait, satisfaction: 50, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
});

function occupy(state: HotelState, roomId: string, guestId: string): HotelState {
  return {
    ...state,
    guests: [...state.guests, guest(guestId)],
    rooms: state.rooms.map(r => r.id === roomId ? { ...r, status: 'occupied' as const, guestId } : r),
    noiseSources: [],
  };
}

describe('Floors', () => {
  it('a new hotel has only the ground floor', () => {
    const state = createHotelState();
    expect(state.floorCount).toBe(1);
    expect(addRoom(state, 'standard', 0, 0, 1)).toBeNull();
  });

  it('each floor costs more than the last, up to the height limit', () => {
    let state = richState();
    expect(getNextFloorCost(state)).toBe(FLOORS.baseCost);
    const result = buildFloor(state)!;
    expect(result.state.floorCount).toBe(2);
    expect(result.state.cash).toBe(state.cash - FLOORS.baseCost);
    expect(result.events[0].type).toBe('floor_built');
    expect(getNextFloorCost(result.state)).toBe(Math.round(FLOORS.baseCost * FLOORS.costGrowth));

    state = withFloors(state, FLOORS.max);
    expect(getNextFloorCost(state)).toBeNull();
    expect(buildFloor(state)).toBeNull();
    expect(getFloorsBuildCost(FLOORS.max)).toBeCloseTo(1_000_000 - state.cash, 5);
  });

  it('building a floor needs the cash', () => {
    expect(buildFloor({ ...createHotelState(), cash: 100 })).toBeNull();
  });

  it('rooms and facilities on different floors can share a tile position', () => {
    let state = withFloors(richState(), 2);
    state = addRoom(state, 'standard', 3, 2, 0)!;
    state = addRoom(state, 'standard', 3, 2, 1)!;
    expect(state.rooms.map(r => r.floor)).toEqual([0, 1]);
    expect(new Set(state.rooms.map(r => r.id)).size).toBe(2);
    expect(addFacility(state, 'gym', 3, 2, 1)).toBeNull();
    expect(addFacility(state, 'gym', 4, 2, 1)!.facilities[0].floor).toBe(1);
  });

  it('room numbers lead with the floor', () => {
    expect(formatRoomLabel(0, 0, 0)).toBe('101');
    expect(formatRoomLabel(2, 1, 2)).toBe(`3${String(GRID.width + 3).padStart(2, '0')}`);
  });

  it('higher floors carry a view premium on the fair price', () => {
    expect(getExpectedPrice('suite', 1, 0)).toBe(ROOM_CONFIG.suite.expectedPrice);
    expect(getExpectedPrice('suite', 1, 3)).toBe(Math.round(ROOM_CONFIG.suite.expectedPrice * (1 + 3 * FLOORS.viewPremiumPerFloor)));
    const state = addRoom(withFloors(richState(), 3), 'standard', 0, 0, 2)!;
    expect(state.rooms[0].pricePerNight).toBe(getExpectedPrice('standard', 1, 2));
  });

  it('guests upstairs can use a facility downstairs if the ride is short enough', () => {
    let state = withFloors({ ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 }, 2);
    state = addElevator(state, 0, 0)!;
    state = addFacility(state, 'gym', 3, 0, 0, 'down')!;
    const route = findRoute(state, { gridX: 2, gridY: 2, floor: 1, door: 'up' }, { gridX: 3, gridY: 0, floor: 0, door: 'down' }, TRAVEL.guestHoursPerTile)!;
    expect(route.path.some((p, i) => i > 0 && p.floor !== route.path[i - 1].floor)).toBe(true);
    expect(route.hours).toBeLessThanOrEqual(FACILITY_VISITS.maxWalkHours);
  });
});

describe('Elevators', () => {
  it('a shaft takes the same tile on every floor, including floors built later', () => {
    let state = withFloors(richState(), 2);
    state = addElevator(state, 0, 0)!;
    expect(state.cash).toBe(richState().cash - FLOORS.baseCost - ELEVATOR.buildCost);
    expect(isTileOccupied(state, 0, 0, 0)).toBe(true);
    expect(isTileOccupied(state, 0, 0, 1)).toBe(true);
    state = buildFloor(state)!.state;
    expect(addRoom(state, 'standard', 0, 0, 2)).toBeNull();
  });

  it('needs the tile free on every floor', () => {
    let state = withFloors(richState(), 2);
    state = addRoom(state, 'standard', 1, 1, 1)!;
    expect(addElevator(state, 1, 1)).toBeNull();
    expect(addElevator({ ...state, cash: 0 }, 2, 2)).toBeNull();
  });

  it('upper-floor rooms cannot be booked without an elevator', () => {
    let state = withFloors({ ...createStarterHotel(), cash: 1_000_000 }, 2);
    state = addRoom(state, 'standard', 5, 2, 0)!;
    state = addRoom(state, 'standard', 5, 2, 1)!;
    expect(getAvailableRooms(state).map(r => r.floor)).toEqual([0]);
    state = addElevator(state, 0, 0)!; // the shaft connects the floors
    expect(getAvailableRooms(state)).toHaveLength(2);
  });

  it('too many upper-floor rooms per elevator means wait penalties for upper-floor guests', () => {
    let state = withFloors(richState(), 3);
    state = addElevator(state, 0, 0)!;
    // Fill floors 1 and 2 (39 free tiles each) for 2x+ the comfortable load
    for (const floor of [1, 2]) {
      for (let i = 1; i < GRID.width * GRID.height; i++) {
        state = addRoom(state, 'standard', i % GRID.width, Math.floor(i / GRID.width), floor) ?? state;
      }
    }
    const upper = state.rooms.length;
    expect(getElevatorLoad(state)).toBeCloseTo(upper / ELEVATOR.roomsServed, 5);

    const upperRoom = state.rooms[0];
    expect(getElevatorWaitPenalty(state, upperRoom)).toBe(ELEVATOR.maxWaitPenalty);
    const breakdown = calculateGuestReviewBreakdown(upperRoom, state, guest('g'), new PRNG(1));
    expect(breakdown.elevatorPenalty).toBe(ELEVATOR.maxWaitPenalty);

    // Ground-floor guests never wait
    state = addRoom(state, 'standard', 4, 4, 0)!;
    expect(getElevatorWaitPenalty(state, state.rooms[state.rooms.length - 1])).toBe(0);

    // Enough elevators clears the penalty (count set directly: the floors are full)
    const shafts = Math.ceil(upper / ELEVATOR.roomsServed);
    state = { ...state, elevators: Array.from({ length: shafts }, (_, i) => ({ id: `e${i}`, gridX: 0, gridY: 0 })) };
    expect(getElevatorLoad(state)).toBeLessThanOrEqual(1);
    expect(getElevatorWaitPenalty(state, upperRoom)).toBe(0);
  });

  it('elevators cost upkeep and add to valuation; demolishing refunds a share', () => {
    const base = richState();
    const withLift = addElevator(base, 0, 0)!;
    expect(processDailyCosts(withLift).cashDelta).toBeCloseTo(processDailyCosts(base).cashDelta - ELEVATOR.dailyOperatingCost, 5);
    expect(calculateValuation(withLift)).toBeCloseTo(calculateValuation(base), 5); // cash became shaft
    const gone = demolishElevator(withLift, withLift.elevators[0].id)!;
    expect(gone.elevators).toHaveLength(0);
    expect(gone.cash).toBeGreaterThan(withLift.cash);
  });
});

describe('Noise across floors', () => {
  it('an occupied room directly above is heard at reduced strength', () => {
    let state = withFloors(richState(), 2);
    state = addElevator(state, 0, 0)!;
    state = addRoom(state, 'standard', 3, 2, 0)!;
    state = addRoom(state, 'standard', 4, 2, 0)!; // same-floor neighbor
    state = addRoom(state, 'standard', 3, 2, 1)!; // directly above
    state = { ...state, noiseSources: [], hour: 12 }; // midday: the neighbours are up (asleep, they'd make none)
    const [below, beside, above] = state.rooms;

    const fromBeside = calculateRoomNoise(below, occupy(state, beside.id, 'g1'));
    const fromAbove = calculateRoomNoise(below, occupy(state, above.id, 'g2'));
    expect(fromBeside).toBeCloseTo(NOISE.baseOccupiedNoise, 5);
    expect(fromAbove).toBeCloseTo(NOISE.baseOccupiedNoise * NOISE.verticalAttenuation, 5);
  });

  it('rooms two floors apart do not hear each other', () => {
    let state = withFloors(richState(), 3);
    state = addRoom(state, 'standard', 3, 2, 0)!;
    state = addRoom(state, 'standard', 3, 2, 2)!;
    state = occupy({ ...state, noiseSources: [] }, state.rooms[1].id, 'g1');
    expect(calculateRoomNoise(state.rooms[0], state)).toBe(0);
  });
});

describe('Save migration into the open floor plan', () => {
  it('v16 saves get a free street entrance by the template spot, and facilities get doors', () => {
    const state: any = { ...createHotelState(), cash: 0, fixtures: [{ id: 'desk-0-3-0', type: 'desk', gridX: 3, gridY: 0, floor: 0 }] };
    state.facilities = [{ id: 'facility-0-5-2', type: 'gym', gridX: 5, gridY: 2, floor: 0, condition: 100, decor: 100, level: 1 }];
    addEntranceAndFacilityDoors(state);
    expect(state.fixtures.map((f: any) => f.id)).toEqual(['desk-0-3-0', 'entrance-0-0-4']);
    expect(state.facilities[0].door).toBe('up');
    // Already has one: left alone
    addEntranceAndFacilityDoors(state);
    expect(state.fixtures).toHaveLength(2);
  });

  it('drops the old hallway tiles and points each door at a side that was hallway', () => {
    const state: any = { ...createHotelState(), cash: 0 };
    state.rooms = [
      { id: 'a', type: 'standard', gridX: 4, gridY: 2, floor: 0 },
      { id: 'b', type: 'standard', gridX: 4, gridY: 0, floor: 0 },
    ];
    state.fixtures = [
      ...Array.from({ length: 10 }, (_, x) => ({ id: `hallway-0-${x}-1`, type: 'hallway', gridX: x, gridY: 1, floor: 0 })),
      { id: 'desk-0-3-0', type: 'desk', gridX: 3, gridY: 0, floor: 0 },
    ];
    openFloorPlan(state);
    expect(state.fixtures.map((f: any) => f.id)).toEqual(['desk-0-3-0', 'entrance-0-0-4']); // and a street entrance
    // Room a (row 2) had the hallway above it, room b (row 0) below it -- even
    // though the old empty tiles beside them are hallway now too
    expect(state.rooms.map((r: any) => r.door)).toEqual(['up', 'down']);
    expect(state.rooms.every((r: any) => isRoomReachable(state, r))).toBe(true);
  });

  it('re-packs an old layout into STARTER_LAYOUT room tiles across floors, with hallways, a desk, and an elevator', () => {
    const state: any = { ...createHotelState(), cash: 0 };
    state.rooms = Array.from({ length: 50 }, (_, i) => ({ id: `room-${i}`, type: 'standard', gridX: i % 20, gridY: Math.floor(i / 20) }));
    state.facilities = [{ id: 'facility-a', type: 'gym', gridX: 15, gridY: 10 }];
    delete state.floorCount;
    delete state.elevators;
    delete state.fixtures;

    packIntoLayout(state);
    openFloorPlan(state); // the next migration step

    expect(state.floorCount).toBe(2); // 51 items; 33 ground-floor slots + 35 upper
    expect(state.elevators).toEqual([{ id: 'elevator-0-0', gridX: 0, gridY: 0 }]);
    expect(state.fixtures.filter((f: any) => f.type === 'desk')).toHaveLength(1);
    expect(state.fixtures.filter((f: any) => f.type === 'hallway')).toHaveLength(0);
    for (let floor = 0; floor < 2; floor++) {
      const built = [...state.rooms, ...state.facilities];
      expect(STARTER_LAYOUT.hallwayTiles.every(([x, y]) => !built.some((t: any) => t.floor === floor && t.gridX === x && t.gridY === y))).toBe(true);
    }

    const items = [...state.rooms, ...state.facilities];
    expect(items.map((r: any) => r.id)).toContain('room-0'); // ids kept
    const positions = new Set([...items, ...state.fixtures].map((r: any) => `${r.floor},${r.gridX},${r.gridY}`));
    expect(positions.size).toBe(items.length + state.fixtures.length); // no overlaps
    // Every room is bookable in the migrated layout
    expect(state.rooms.every((r: any) => isRoomReachable(state, r))).toBe(true);
  });

  it('a small old hotel fits on the ground floor without an elevator', () => {
    const state: any = { ...createHotelState() };
    state.rooms = Array.from({ length: 6 }, (_, i) => ({ id: `room-${i}`, type: 'standard', gridX: i * 3, gridY: 7 }));
    state.facilities = [];
    packIntoLayout(state);
    openFloorPlan(state);
    expect(state.floorCount).toBe(1);
    expect(state.elevators).toEqual([]);
    expect(state.rooms.every((r: any) => r.floor === 0)).toBe(true);
    expect(state.rooms.every((r: any) => isRoomReachable(state, r))).toBe(true);
  });
});

describe('Balance: building upward', () => {
  it('a balanced hotel outgrows the ground floor, adds an elevator, and stays solvent', () => {
    const results = Array.from({ length: 4 }, (_, i) => simulate(200, i, undefined, STRATEGIES.balanced));
    expect(results.every(r => !r.wentBankrupt)).toBe(true);
    // More rooms than fit on the ground floor's room rows
    expect(results.every(r => r.finalRoomCount > 35)).toBe(true);
  }, 120000);
});
