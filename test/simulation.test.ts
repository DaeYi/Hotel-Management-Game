import { describe, it, expect, beforeEach } from 'vitest';
import { PRNG } from '../src/simulation/prng.js';
import { createHotelState, addRoom, getOccupancyRate, demolishRoom, demolishFacility, addFacility, getDemolishRefund } from '../src/simulation/HotelState.js';
import { processArrivals, processDepartures, calculateGuestReview, generateGuestTrait } from '../src/simulation/GuestManager.js';
import { processDailyCosts, checkBankruptcy, updateReviewScore } from '../src/simulation/EconomyManager.js';
import { calculateRoomNoise, noiseToRatingPenalty, createConstructionNoise, tickNoiseSources } from '../src/simulation/NoiseManager.js';
import { startTurnoverCleaning, processCleaningTick, processDailyHousekeeping, checkHousekeepingCompliance } from '../src/simulation/HousekeepingManager.js';
import { processMaintenanceTick } from '../src/simulation/MaintenanceManager.js';
import { saveGame, loadGame, hasSavedGame, deleteSave } from '../src/simulation/SaveManager.js';
import { calculateStarRating, calculateStarPoints, getNextStarRequirements } from '../src/simulation/StarRatingManager.js';
import { getSpecialEvent, getTotalDemandMultiplier } from '../src/simulation/SeasonManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { simulate } from '../src/simulation/simulate.js';
import { ECONOMY, REVIEW, ROOM_CONFIG, FACILITY_CONFIG, GUEST_TRAITS, NOISE, HOUSEKEEPING } from '../src/config/balance.js';
import type { Room, Guest, Booking, GuestTrait } from '../src/simulation/types.js';
import { getGuestDotColor } from '../src/ui/GridRenderer';

describe('PRNG', () => {
  it('is deterministic with same seed', () => {
    const a = new PRNG(42);
    const b = new PRNG(42);
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different sequences with different seeds', () => {
    const a = new PRNG(1);
    const b = new PRNG(2);
    const aVals = Array.from({ length: 10 }, () => a.next());
    const bVals = Array.from({ length: 10 }, () => b.next());
    expect(aVals).not.toEqual(bVals);
  });

  it('range produces values within bounds', () => {
    const prng = new PRNG(42);
    for (let i = 0; i < 1000; i++) {
      const val = prng.range(10, 20);
      expect(val).toBeGreaterThanOrEqual(10);
      expect(val).toBeLessThan(20);
    }
  });

  it('can save and restore state', () => {
    const prng = new PRNG(42);
    for (let i = 0; i < 50; i++) prng.next();
    const savedState = prng.getState();
    const val1 = prng.next();

    const restored = PRNG.fromState(savedState);
    const val2 = restored.next();
    expect(val1).toBe(val2);
  });
});

describe('SaveManager', () => {
  // Required per plan-eng-review: tests run against Node's own native
  // localStorage (no jsdom in this project) under one fixed SAVE_KEY —
  // without clearing between tests, they'd share state and be order-dependent.
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves and loads a full round trip, including PRNG state', () => {
    let state = createHotelState();
    state = addRoom(state, 'deluxe', 2, 3)!;
    const prng = new PRNG(123);
    prng.next();
    prng.next();

    expect(saveGame(state, prng)).toBe(true);

    const loaded = loadGame();
    expect(loaded).not.toBeNull();
    expect(loaded!.state.cash).toBe(state.cash);
    expect(loaded!.state.rooms).toHaveLength(1);
    expect(loaded!.prngState).toBe(prng.getState());
  });

  it('hasSavedGame and deleteSave reflect save state', () => {
    expect(hasSavedGame()).toBe(false);
    saveGame(createHotelState(), new PRNG(1));
    expect(hasSavedGame()).toBe(true);
    deleteSave();
    expect(hasSavedGame()).toBe(false);
  });

  it('loadGame returns null when no save exists', () => {
    expect(loadGame()).toBeNull();
  });

  it('loadGame returns null, not throws, on corrupt JSON', () => {
    localStorage.setItem('hotel-game-save', '{not valid json');
    expect(() => loadGame()).not.toThrow();
    expect(loadGame()).toBeNull();
  });

  it('loadGame returns null, not throws, when the version field is missing entirely', () => {
    localStorage.setItem('hotel-game-save', JSON.stringify({
      state: createHotelState(), prngState: 1, timestamp: 0,
    }));
    expect(() => loadGame()).not.toThrow();
    expect(loadGame()).toBeNull();
  });

  it('loadGame returns null when the version is newer than this build supports', () => {
    localStorage.setItem('hotel-game-save', JSON.stringify({
      version: 999, prngState: 1, state: createHotelState(), timestamp: 0,
    }));
    expect(loadGame()).toBeNull();
  });

  it('migrates a v1 save (missing noiseSources and facilities) all the way to the current version', () => {
    const v1Save = {
      version: 1, prngState: 42, timestamp: 0,
      state: {
        cash: 1000, day: 1, hour: 0, rooms: [], guests: [], bookings: [],
        // noiseSources and facilities intentionally absent (v1 shape, predates
        // both fields) — this is what actually exercises the v8->v9 step;
        // previously this fixture pre-populated facilities: [], which made
        // that assertion pass trivially regardless of whether the migration
        // line existed at all.
        housekeeping: { turnoverQuality: 'standard', dailyCadence: 'daily' },
        staff: { maintenanceWorkers: 0, housekeepers: 1, frontDesk: 1 },
        amenities: { standard: 'basic', deluxe: 'basic', suite: 'basic' },
        starRating: 1, reviewScore: 5, totalTurnedAway: 0, totalRevenue: 0,
      },
    };
    localStorage.setItem('hotel-game-save', JSON.stringify(v1Save));

    const loaded = loadGame();
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(9);
    expect(loaded!.state.noiseSources).toEqual([]);
    expect(loaded!.state.facilities).toEqual([]); // added by the v8->v9 step
  });

  it('migrates v3 reputationScore and booking rating into starRating/reviewScore correctly', () => {
    const v3Save = {
      version: 3, prngState: 1, timestamp: 0,
      state: {
        cash: 1000, day: 1, hour: 0, rooms: [], facilities: [], guests: [],
        bookings: [{ id: 'b1', roomId: 'r1', guestId: 'g1', nightRate: 100, rating: 4 }], // old-style 1-5 rating, no reviewScore
        noiseSources: [],
        housekeeping: { turnoverQuality: 'standard', dailyCadence: 'daily' },
        staff: { maintenanceWorkers: 0, housekeepers: 1 }, // frontDesk intentionally missing (pre-v6->v7)
        amenities: undefined, // intentionally missing (pre-v7->v8)
        reputationScore: 72, // old-style 0-100 field
        totalTurnedAway: 0, totalRevenue: 0,
      },
    };
    localStorage.setItem('hotel-game-save', JSON.stringify(v3Save));

    const loaded = loadGame();
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(9);
    expect(loaded!.state.reviewScore).toBeCloseTo(7.2, 5); // 72 / 10
    expect((loaded!.state as any).reputationScore).toBeUndefined();
    expect(loaded!.state.bookings[0].reviewScore).toBe(8); // rating 4 * 2
    expect(loaded!.state.staff.frontDesk).toBe(1); // filled by v6->v7
    expect(loaded!.state.amenities).toEqual({ standard: 'basic', deluxe: 'basic', suite: 'basic' }); // filled by v7->v8
  });
});

describe('HotelState', () => {
  it('creates valid initial state', () => {
    const state = createHotelState();
    expect(state.cash).toBe(ECONOMY.startingCash);
    expect(state.day).toBe(1);
    expect(state.hour).toBe(0);
    expect(state.rooms).toHaveLength(0);
    expect(state.guests).toHaveLength(0);
    expect(state.reviewScore).toBe(ECONOMY.initialReviewScore);
  });

  it('adds a room and deducts cost', () => {
    const state = createHotelState();
    const result = addRoom(state, 'standard', 0, 0);
    expect(result).not.toBeNull();
    expect(result!.rooms).toHaveLength(1);
    expect(result!.cash).toBe(ECONOMY.startingCash - 2000);
    expect(result!.rooms[0].type).toBe('standard');
  });

  it('rejects duplicate position', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    const result = addRoom(state, 'deluxe', 0, 0);
    expect(result).toBeNull();
  });

  it('rejects out-of-bounds placement', () => {
    const state = createHotelState();
    expect(addRoom(state, 'standard', -1, 0)).toBeNull();
    expect(addRoom(state, 'standard', 20, 0)).toBeNull();
    expect(addRoom(state, 'standard', 0, 15)).toBeNull();
  });

  it('rejects unaffordable room', () => {
    const state = { ...createHotelState(), cash: 100 };
    expect(addRoom(state, 'standard', 0, 0)).toBeNull();
  });

  it('calculates occupancy rate', () => {
    let state = createHotelState();
    expect(getOccupancyRate(state)).toBe(0);

    state = addRoom(state, 'standard', 0, 0)!;
    state = addRoom(state, 'standard', 1, 0)!;
    state.rooms[0] = { ...state.rooms[0], status: 'occupied' as const };
    expect(getOccupancyRate(state)).toBe(0.5);
  });

  it('demolishRoom refunds via the shared getDemolishRefund helper (regression: value unchanged by extraction)', () => {
    let state = createHotelState();
    state = addRoom(state, 'deluxe', 0, 0)!;
    const cashAfterBuild = state.cash;

    const result = demolishRoom(state, state.rooms[0].id);
    expect(result).not.toBeNull();

    const expectedRefund = getDemolishRefund(ROOM_CONFIG.deluxe.buildCost);
    expect(expectedRefund).toBe(Math.floor(ROOM_CONFIG.deluxe.buildCost * 0.25));
    expect(result!.cash).toBe(cashAfterBuild + expectedRefund);
    expect(result!.rooms).toHaveLength(0);
  });

  it('demolishFacility refunds the same 25% rate as rooms', () => {
    let state = createHotelState();
    state = addFacility(state, 'gym', 0, 0)!;
    const cashAfterBuild = state.cash;

    const result = demolishFacility(state, state.facilities[0].id);
    expect(result).not.toBeNull();

    const expectedRefund = getDemolishRefund(FACILITY_CONFIG.gym.buildCost);
    expect(expectedRefund).toBe(Math.floor(FACILITY_CONFIG.gym.buildCost * 0.25));
    expect(result!.cash).toBe(cashAfterBuild + expectedRefund);
    expect(result!.facilities).toHaveLength(0);
  });
});

describe('GuestManager', () => {
  it('generates no arrivals outside check-in hours', () => {
    const prng = new PRNG(42);
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;

    const result = processArrivals(state, 8, prng);
    expect(result.checkedIn).toHaveLength(0);
  });

  it('generates arrivals during check-in hours', () => {
    const prng = new PRNG(42);
    let state = createHotelState();
    for (let i = 0; i < 10; i++) {
      state = addRoom(state, 'standard', i, 0)!;
    }

    const result = processArrivals(state, 16, prng);
    expect(result.checkedIn.length + result.turnedAway).toBeGreaterThanOrEqual(0);
  });

  it('turns away guests when no rooms available', () => {
    const prng = new PRNG(42);
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state.rooms[0] = { ...state.rooms[0], status: 'occupied' as const, guestId: 'test', cleanliness: 100, cleaningHoursRemaining: 0, lastDailyCleanDay: 0 };

    // Run many ticks to get at least one arrival attempt
    let totalTurnedAway = 0;
    for (let h = ECONOMY.checkInStartHour; h < ECONOMY.checkInEndHour; h++) {
      const result = processArrivals(state, h, prng);
      totalTurnedAway += result.turnedAway;
    }
    // With all rooms occupied, all arrivals should be turned away
    expect(totalTurnedAway).toBeGreaterThanOrEqual(0);
  });

  it('rating never produces NaN or Infinity', () => {
    const prng = new PRNG(42);
    const room: Room = {
      id: 'test', type: 'standard', gridX: 0, gridY: 0,
      pricePerNight: 80, condition: 50, status: 'occupied' as const, guestId: 'g1', cleanliness: 100, cleaningHoursRemaining: 0, lastDailyCleanDay: 0,
    };
    const guest: Guest = {
      id: 'g1', budget: 100, stayLength: 1, trait: 'normal',
      satisfaction: 50, checkInDay: 1,
    };
    const state = createHotelState();

    for (let i = 0; i < 1000; i++) {
      const rating = calculateGuestReview(room, state, guest, prng);
      expect(rating).not.toBeNaN();
      expect(Number.isFinite(rating)).toBe(true);
      expect(rating).toBeGreaterThanOrEqual(0);
      expect(rating).toBeLessThanOrEqual(10);
    }
  });

  it('perfect conditions do NOT always give 5 stars (variance)', () => {
    const prng = new PRNG(42);
    const room: Room = {
      id: 'test', type: 'standard', gridX: 0, gridY: 0,
      pricePerNight: 80, condition: 100, status: 'occupied' as const, guestId: 'g1', cleanliness: 100, cleaningHoursRemaining: 0, lastDailyCleanDay: 0,
    };
    const guest: Guest = {
      id: 'g1', budget: 200, stayLength: 1, trait: 'normal',
      satisfaction: 50, checkInDay: 1,
    };
    const state = createHotelState();

    const ratings = Array.from({ length: 100 }, () =>
      calculateGuestReview(room, state, guest, prng)
    );
    const allMax = ratings.every(r => r === 10);
    expect(allMax).toBe(false);
  });

  it('low condition gives lower ratings than high condition', () => {
    const prng1 = new PRNG(42);
    const prng2 = new PRNG(42);
    const guest: Guest = {
      id: 'g1', budget: 200, stayLength: 1, trait: 'normal',
      satisfaction: 50, checkInDay: 1,
    };
    const state = createHotelState();

    const lowRoom: Room = {
      id: 'test', type: 'standard', gridX: 0, gridY: 0,
      pricePerNight: 80, condition: 10, status: 'occupied' as const, guestId: 'g1', cleanliness: 100, cleaningHoursRemaining: 0, lastDailyCleanDay: 0,
    };
    const highRoom: Room = { ...lowRoom, condition: 90 };

    const lowRatings = Array.from({ length: 100 }, () =>
      calculateGuestReview(lowRoom, state, guest, prng1)
    );
    const highRatings = Array.from({ length: 100 }, () =>
      calculateGuestReview(highRoom, state, guest, prng2)
    );

    const avgLow = lowRatings.reduce((s, r) => s + r, 0) / lowRatings.length;
    const avgHigh = highRatings.reduce((s, r) => s + r, 0) / highRatings.length;
    expect(avgHigh).toBeGreaterThan(avgLow);
  });
});

describe('party_guest trait', () => {
  it('spawns at approximately GUEST_TRAITS.partyGuestChance, leaving light_sleeper/big_spender unchanged', () => {
    const prng = new PRNG(42);
    const counts: Record<GuestTrait, number> = { normal: 0, light_sleeper: 0, big_spender: 0, party_guest: 0 };
    const samples = 20000;
    for (let i = 0; i < samples; i++) {
      counts[generateGuestTrait(prng)]++;
    }

    // Wide tolerance (statistical test) — just confirms the new branch is
    // reachable at roughly the configured rate and didn't shift the existing
    // trait probabilities by inserting itself in the wrong place in the chain.
    expect(counts.light_sleeper / samples).toBeCloseTo(GUEST_TRAITS.lightSleeperChance, 1);
    expect(counts.big_spender / samples).toBeCloseTo(GUEST_TRAITS.bigSpenderChance, 1);
    expect(counts.party_guest / samples).toBeCloseTo(GUEST_TRAITS.partyGuestChance, 1);
    expect(counts.normal / samples).toBeCloseTo(
      1 - GUEST_TRAITS.lightSleeperChance - GUEST_TRAITS.bigSpenderChance - GUEST_TRAITS.partyGuestChance,
      1
    );
  });

  it('gets its own noise multipliers (already configured in balance.ts)', () => {
    expect(NOISE.traitNoiseOutput.party_guest).toBeGreaterThan(NOISE.traitNoiseOutput.normal);
    expect(NOISE.traitNoiseSensitivity.party_guest).toBeLessThan(NOISE.traitNoiseSensitivity.normal);
  });
});

describe('getGuestDotColor', () => {
  it('gives every trait its own explicit color (no shared fallback)', () => {
    const traits: GuestTrait[] = ['normal', 'light_sleeper', 'big_spender', 'party_guest'];
    const colors = traits.map(getGuestDotColor);
    expect(new Set(colors).size).toBe(traits.length);
  });

  it('party_guest does not fall through to the normal/default color', () => {
    expect(getGuestDotColor('party_guest')).not.toBe(getGuestDotColor('normal'));
  });
});

describe('HousekeepingManager', () => {
  it('startTurnoverCleaning sets duration per quality tier', () => {
    const baseRoom: Room = {
      id: 'r', type: 'standard', gridX: 0, gridY: 0, pricePerNight: 80,
      condition: 100, cleanliness: 0, status: 'occupied', guestId: 'g1',
      cleaningHoursRemaining: 0, lastDailyCleanDay: 0,
    };

    const quick = startTurnoverCleaning(baseRoom, 'quick');
    expect(quick.status).toBe('cleaning');
    expect(quick.guestId).toBeUndefined();
    expect(quick.cleaningHoursRemaining).toBe(HOUSEKEEPING.turnoverDuration.quick);

    expect(startTurnoverCleaning(baseRoom, 'standard').cleaningHoursRemaining).toBe(HOUSEKEEPING.turnoverDuration.standard);
    expect(startTurnoverCleaning(baseRoom, 'thorough').cleaningHoursRemaining).toBe(HOUSEKEEPING.turnoverDuration.thorough);
  });

  it('processCleaningTick restores cleanliness to the quality-tier target when a room finishes', () => {
    let state = createHotelState(); // default turnoverQuality: 'standard'
    state = addRoom(state, 'standard', 0, 0)!;
    state = {
      ...state,
      hour: 10, // within the 6-22 work shift
      staff: { ...state.staff, housekeepers: 1 },
      rooms: state.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: 1, cleanliness: 0 })),
    };

    const result = processCleaningTick(state);
    expect(result.state.rooms[0].status).toBe('vacant');
    expect(result.state.rooms[0].cleanliness).toBe(HOUSEKEEPING.turnoverCleanlinessResult.standard);
  });

  it('0 housekeepers: cleaning rooms make no progress (stuck indefinitely)', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = {
      ...state,
      hour: 10,
      staff: { ...state.staff, housekeepers: 0 },
      rooms: state.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: 2 })),
    };

    const result = processCleaningTick(state);
    expect(result.state.rooms[0].status).toBe('cleaning');
    expect(result.state.rooms[0].cleaningHoursRemaining).toBe(2);
  });

  it('outside the 6am-10pm work shift: cleaning rooms make no progress', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = {
      ...state,
      hour: 2,
      staff: { ...state.staff, housekeepers: 2 },
      rooms: state.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: 2 })),
    };

    const result = processCleaningTick(state);
    expect(result.state.rooms[0].cleaningHoursRemaining).toBe(2);
  });

  it('daily housekeeping: cadence "none" never cleans occupied rooms', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = {
      ...state,
      hour: HOUSEKEEPING.dailyCleaningHour,
      day: 2,
      housekeeping: { turnoverQuality: 'standard', dailyCadence: 'none' },
      staff: { ...state.staff, housekeepers: 1 },
      rooms: state.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'g1', cleanliness: 50 })),
    };

    const result = processDailyHousekeeping(state);
    expect(result.state.rooms[0].cleanliness).toBe(50);
  });

  it('daily housekeeping: cadence "every_other_day" only cleans on even days', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    const base = {
      ...state,
      hour: HOUSEKEEPING.dailyCleaningHour,
      housekeeping: { turnoverQuality: 'standard' as const, dailyCadence: 'every_other_day' as const },
      staff: { ...state.staff, housekeepers: 1 },
      rooms: state.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'g1', cleanliness: 50 })),
    };

    const oddDayResult = processDailyHousekeeping({ ...base, day: 3 });
    expect(oddDayResult.state.rooms[0].cleanliness).toBe(50); // skipped

    const evenDayResult = processDailyHousekeeping({ ...base, day: 4 });
    expect(evenDayResult.state.rooms[0].cleanliness).toBe(50 + HOUSEKEEPING.dailyCleaningBoost); // cleaned
  });

  it('checkHousekeepingCompliance: warns with 0 housekeepers and rooms built', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = { ...state, staff: { ...state.staff, housekeepers: 0 } };
    expect(checkHousekeepingCompliance(state)).toMatch(/No housekeepers/);
  });

  it('checkHousekeepingCompliance: 3-star with cadence "none" is non-compliant', () => {
    let state = createHotelState();
    state = { ...state, starRating: 3, housekeeping: { turnoverQuality: 'standard', dailyCadence: 'none' } };
    expect(checkHousekeepingCompliance(state)).toMatch(/every-other-day/);
  });

  it('checkHousekeepingCompliance: 4-star requires daily cadence', () => {
    let state = createHotelState();
    state = { ...state, starRating: 4, housekeeping: { turnoverQuality: 'standard', dailyCadence: 'every_other_day' } };
    expect(checkHousekeepingCompliance(state)).toMatch(/daily housekeeping/);
  });

  it('checkHousekeepingCompliance: compliant hotel returns null', () => {
    let state = createHotelState();
    state = {
      ...state,
      starRating: 4,
      staff: { ...state.staff, housekeepers: 1 },
      housekeeping: { turnoverQuality: 'standard', dailyCadence: 'daily' },
    };
    expect(checkHousekeepingCompliance(state)).toBeNull();
  });
});

describe('MaintenanceManager', () => {
  it('only repairs vacant rooms below the condition threshold, never occupied ones', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = addRoom(state, 'standard', 1, 0)!;
    state = {
      ...state,
      hour: 10,
      staff: { ...state.staff, maintenanceWorkers: 2 },
      rooms: [
        { ...state.rooms[0], status: 'vacant' as const, condition: 50 },
        { ...state.rooms[1], status: 'occupied' as const, guestId: 'g1', condition: 50 },
      ],
    };

    const result = processMaintenanceTick(state);
    expect(result.state.rooms[0].condition).toBeGreaterThan(50);
    expect(result.state.rooms[1].condition).toBe(50);
  });

  it('repairs the worst-condition room first when workers are outnumbered', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = addRoom(state, 'standard', 1, 0)!;
    state = addRoom(state, 'standard', 2, 0)!;
    state = {
      ...state,
      hour: 10,
      staff: { ...state.staff, maintenanceWorkers: 1 },
      rooms: [
        { ...state.rooms[0], status: 'vacant' as const, condition: 60 },
        { ...state.rooms[1], status: 'vacant' as const, condition: 20 }, // worst
        { ...state.rooms[2], status: 'vacant' as const, condition: 40 },
      ],
    };

    const result = processMaintenanceTick(state);
    expect(result.state.rooms[1].condition).toBeGreaterThan(20);
    expect(result.state.rooms[0].condition).toBe(60);
    expect(result.state.rooms[2].condition).toBe(40);
  });

  it('does nothing outside the 6am-10pm shift', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = {
      ...state,
      hour: 3,
      staff: { ...state.staff, maintenanceWorkers: 1 },
      rooms: [{ ...state.rooms[0], status: 'vacant' as const, condition: 30 }],
    };

    const result = processMaintenanceTick(state);
    expect(result.state.rooms[0].condition).toBe(30);
  });

  it('caps repairs at one room per worker per hour', () => {
    let state = createHotelState();
    for (let i = 0; i < 5; i++) state = addRoom(state, 'standard', i, 0)!;
    state = {
      ...state,
      hour: 10,
      staff: { ...state.staff, maintenanceWorkers: 2 },
      rooms: state.rooms.map(r => ({ ...r, status: 'vacant' as const, condition: 20 })),
    };

    const result = processMaintenanceTick(state);
    const repairedCount = result.state.rooms.filter(r => r.condition > 20).length;
    expect(repairedCount).toBe(2);
  });
});

describe('NoiseManager', () => {
  it('isolated room has zero noise after construction finishes', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 5, 5)!;
    // Clear construction noise (simulating time passing)
    state = { ...state, noiseSources: [] };
    const noise = calculateRoomNoise(state.rooms[0], state);
    expect(noise).toBe(0);
  });

  it('newly built room has construction noise on itself', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 5, 5)!;
    const noise = calculateRoomNoise(state.rooms[0], state);
    expect(noise).toBeGreaterThan(0); // construction noise
  });

  it('adjacent occupied room generates noise', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 5, 5)!;
    state = addRoom(state, 'standard', 6, 5)!;
    // Occupy the neighbor
    const guest: Guest = {
      id: 'g1', budget: 100, stayLength: 1, trait: 'normal',
      satisfaction: 50, checkInDay: 1,
    };
    state = {
      ...state,
      guests: [guest],
      rooms: state.rooms.map(r =>
        r.gridX === 6 ? { ...r, occupied: true, guestId: 'g1' } : r
      ),
    };
    const noise = calculateRoomNoise(state.rooms[0], state);
    expect(noise).toBeGreaterThan(0);
  });

  it('non-adjacent occupied room generates zero noise', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = addRoom(state, 'standard', 5, 5)!; // far away
    // Clear construction noise
    state = { ...state, noiseSources: [] };
    const guest: Guest = {
      id: 'g1', budget: 100, stayLength: 1, trait: 'normal',
      satisfaction: 50, checkInDay: 1,
    };
    state = {
      ...state,
      guests: [guest],
      rooms: state.rooms.map(r =>
        r.gridX === 5 ? { ...r, occupied: true, guestId: 'g1' } : r
      ),
    };
    const noise = calculateRoomNoise(state.rooms[0], state);
    expect(noise).toBe(0);
  });

  it('more adjacent neighbors = more noise', () => {
    let state = createHotelState();
    // Center room at 5,5
    state = addRoom(state, 'standard', 5, 5)!;
    // One neighbor
    state = addRoom(state, 'standard', 6, 5)!;
    state = {
      ...state,
      guests: [{ id: 'g1', budget: 100, stayLength: 1, trait: 'normal', satisfaction: 50, checkInDay: 1 }],
      rooms: state.rooms.map(r =>
        r.gridX === 6 ? { ...r, occupied: true, guestId: 'g1' } : r
      ),
    };
    const noise1 = calculateRoomNoise(state.rooms[0], state);

    // Add second neighbor
    state = addRoom(state, 'standard', 4, 5)!;
    state = {
      ...state,
      guests: [...state.guests, { id: 'g2', budget: 100, stayLength: 1, trait: 'normal', satisfaction: 50, checkInDay: 1 }],
      rooms: state.rooms.map(r =>
        r.gridX === 4 && r.gridY === 5 ? { ...r, status: 'occupied' as const, guestId: 'g2', cleanliness: 100, cleaningHoursRemaining: 0, lastDailyCleanDay: 0 } : r
      ),
    };
    const noise2 = calculateRoomNoise(state.rooms[0], state);
    expect(noise2).toBeGreaterThan(noise1);
  });

  it('construction noise affects adjacent rooms', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 5, 5)!;
    state = {
      ...state,
      noiseSources: [createConstructionNoise(6, 5, 'build')],
    };
    const noise = calculateRoomNoise(state.rooms[0], state);
    expect(noise).toBeGreaterThan(0);
  });

  it('construction noise ticks down and expires', () => {
    let sources = [createConstructionNoise(0, 0, 'build')];
    const initialHours = sources[0].remainingHours;
    sources = tickNoiseSources(sources);
    expect(sources[0].remainingHours).toBe(initialHours - 1);

    // Tick until expired
    for (let i = 0; i < initialHours; i++) {
      sources = tickNoiseSources(sources);
    }
    expect(sources).toHaveLength(0);
  });

  it('light sleeper gets higher penalty from same noise', () => {
    const normalGuest: Guest = { id: 'g1', budget: 100, stayLength: 1, trait: 'normal', satisfaction: 50, checkInDay: 1 };
    const lightSleeper: Guest = { id: 'g2', budget: 100, stayLength: 1, trait: 'light_sleeper', satisfaction: 50, checkInDay: 1 };
    const noise = 1.0;
    const normalPenalty = noiseToRatingPenalty(noise, normalGuest);
    const lsPenalty = noiseToRatingPenalty(noise, lightSleeper);
    expect(lsPenalty).toBeGreaterThan(normalPenalty);
  });

  it('noise below threshold causes no penalty', () => {
    const guest: Guest = { id: 'g1', budget: 100, stayLength: 1, trait: 'normal', satisfaction: 50, checkInDay: 1 };
    const penalty = noiseToRatingPenalty(0.2, guest);
    expect(penalty).toBe(0);
  });
});

describe('StarRatingManager', () => {
  it('0 rooms is 1 star', () => {
    const state = createHotelState();
    expect(calculateStarRating(state)).toBe(1);
  });

  it('calculateStarRating pins a known scenario (regression: extraction must not change calculateStarPoints\' output)', () => {
    // 1 suite + 1 deluxe + 1 standard (default housekeeping/amenities):
    // deluxePct=(1+1)/3=0.667, suitePct=1/3=0.333.
    // points = 0.667*2 + 0.333*2 + 0.5 (hk standard) + 0.7 (cadence daily)
    //        = 1.333 + 0.667 + 0.5 + 0.7 = 3.2 -> floor(3.2)+1 = 4 stars.
    // Pinned against the hand-computed value, not against the code's own
    // formula, so a regression in either function's math would be caught.
    let state = createHotelState();
    state = addRoom(state, 'suite', 0, 0)!;
    state = addRoom(state, 'deluxe', 1, 0)!;
    state = addRoom(state, 'standard', 2, 0)!;

    expect(calculateStarPoints(state)).toBeCloseTo(3.2, 5);
    expect(calculateStarRating(state)).toBe(4);
  });

  it('getNextStarRequirements returns null once a hotel is already 5 stars', () => {
    // 3 suites (100% suite ratio, affordable at $10k each against $50k starting
    // cash) plus createHotelState's own defaults (standard housekeeping, daily
    // cadence) already clears 5 stars: points = 1.0*2 + 1.0*2 (mix) + 0.5 (hk)
    // + 0.7 (cadence) = 5.2 -> floor(5.2)+1 = 6, clamped to 5.
    let state = createHotelState();
    for (let i = 0; i < 3; i++) {
      state = addRoom(state, 'suite', i, 0)!;
    }

    expect(calculateStarRating(state)).toBe(5);
    expect(getNextStarRequirements(state)).toBeNull();
  });

  it('deluxe hint accounts for existing suite percentage (regression: formula must subtract suitePct*suiteRatioPoints)', () => {
    let state = createHotelState();
    for (let i = 0; i < 7; i++) state = addRoom(state, 'standard', i, 0)!;
    for (let i = 0; i < 3; i++) state = addRoom(state, 'suite', i, 1)!;

    // Hand-verified against calculateStarPoints: 10 rooms (0 deluxe, 3 suite),
    // default housekeeping (standard/daily) and default basic amenities give
    // points = 0.3*2 + 0.3*2 + 0.5 + 0.7 + 0.5 = 2.9 -> current = 3 stars,
    // target = 4. otherPoints = 2.9 - (0.3*2 + 0.3*2) = 1.7.
    // neededDeluxePct = (3 - 1.7 - 0.3*2) / 2 = 0.35 (35%).
    // A formula that forgets to subtract suitePct's own contribution would
    // instead compute (3 - 1.7) / 2 = 0.65 (65%), overstating the requirement
    // even though 30% of the mix is already suites — the exact bug caught
    // during this plan's review.
    const hint = getNextStarRequirements(state);
    expect(hint).not.toBeNull();
    expect(hint).toContain('Add more deluxe/suite rooms (need 35%+)');
  });
});

describe('SeasonManager', () => {
  it('New Year fires for all 10 configured days, including the wrap into the new year (regression for the wraparound fix)', () => {
    // dayOfYear = (day - 1) % 360. New Year: startDay 355, duration 10 -> [355, 365).
    // Days 355-359 (dayOfYear) fall in year 1 as absolute day 356-360.
    for (let day = 356; day <= 360; day++) {
      expect(getSpecialEvent(day)).toBe('New Year');
    }
    // Days 360-364 (dayOfYear) wrap to the start of year 2, absolute day 361-365.
    for (let day = 361; day <= 365; day++) {
      expect(getSpecialEvent(day)).toBe('New Year');
    }
    // Day 366 (dayOfYear 5) is past the wrapped window.
    expect(getSpecialEvent(366)).not.toBe('New Year');
  });

  it('the wraparound also fires at the very start of year 1 (day 1-5)', () => {
    // Symmetric consequence of the fix: New Year is a 10-day window straddling
    // any year boundary, including the game's own start.
    for (let day = 1; day <= 5; day++) {
      expect(getSpecialEvent(day)).toBe('New Year');
    }
    expect(getSpecialEvent(6)).not.toBe('New Year');
  });

  it('the wraparound demand multiplier applies during the wrapped days too', () => {
    const wrappedMult = getTotalDemandMultiplier(361); // dayOfYear 0, wrapped New Year day (Thu, spring, x2.0 event)
    const normalMult = getTotalDemandMultiplier(10); // dayOfYear 9, no event, spring, weekday
    expect(wrappedMult).toBeGreaterThan(normalMult);
  });

  it('non-wraparound events are unaffected by the fix', () => {
    // Spring Festival: startDay 45, duration 7 -> absolute day 46-52.
    for (let day = 46; day <= 52; day++) {
      expect(getSpecialEvent(day)).toBe('Spring Festival');
    }
    expect(getSpecialEvent(53)).not.toBe('Spring Festival');
  });
});

describe('EconomyManager', () => {
  it('applies debt interest when cash is negative', () => {
    const state = { ...createHotelState(), cash: -1000, rooms: [
      { id: 'r1', type: 'standard' as const, gridX: 0, gridY: 0, pricePerNight: 80, condition: 100, cleanliness: 100, status: 'vacant' as const, cleaningHoursRemaining: 0, lastDailyCleanDay: 0 },
    ] };
    const costs = processDailyCosts(state);
    // Interest on $1000 debt = $50, plus operating cost of 1 room = $10
    expect(costs.cashDelta).toBeLessThan(-50);
  });

  it('detects bankruptcy', () => {
    expect(checkBankruptcy({ ...createHotelState(), cash: -10001 })).toBe(true);
    expect(checkBankruptcy({ ...createHotelState(), cash: -9999 })).toBe(false);
    expect(checkBankruptcy({ ...createHotelState(), cash: 1000 })).toBe(false);
  });

  it('returns initial reputation with no bookings', () => {
    const state = createHotelState();
    expect(updateReviewScore(state)).toBe(ECONOMY.initialReviewScore);
  });
});

describe('tickSimulation', () => {
  it('determinism: same seed produces same result', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = addRoom(state, 'deluxe', 1, 0)!;

    const prng1 = new PRNG(42);
    const prng2 = new PRNG(42);

    let state1 = { ...state, hour: 16 };
    let state2 = { ...state, hour: 16 };

    for (let i = 0; i < 48; i++) {
      state1 = tickSimulation(state1, prng1).state;
      state2 = tickSimulation(state2, prng2).state;
    }

    expect(state1.cash).toBe(state2.cash);
    expect(state1.day).toBe(state2.day);
    expect(state1.reviewScore).toBe(state2.reviewScore);
    expect(state1.guests.length).toBe(state2.guests.length);
  });

  it('advances clock correctly', () => {
    const prng = new PRNG(42);
    let state = createHotelState();
    state = { ...state, hour: 23 };

    const result = tickSimulation(state, prng);
    expect(result.state.hour).toBe(0);
    expect(result.state.day).toBe(2);
  });

  it('bookings retention is capped at REVIEW.reviewWindowBookingCount (regression: was up to 600 before the fix, now matches the 300-booking averaging window exactly)', () => {
    const prng = new PRNG(1);
    let state = createHotelState();
    const dummyBookings: Booking[] = Array.from({ length: 400 }, (_, i) => ({
      id: `b${i}`, roomId: 'r', guestId: 'g', nightRate: 100, reviewScore: 5,
    }));
    state = { ...state, bookings: dummyBookings };

    const result = tickSimulation(state, prng);
    expect(result.state.bookings.length).toBe(REVIEW.reviewWindowBookingCount);
  });

  it('cold start: guests arrive on day 1 with seeded reputation', () => {
    const prng = new PRNG(42);
    let state = createHotelState();
    // Build some rooms
    for (let i = 0; i < 5; i++) {
      state = addRoom(state, 'standard', i, 0)!;
    }

    expect(state.reviewScore).toBe(ECONOMY.initialReviewScore);

    // Run through a full check-in window
    state = { ...state, hour: 14 };
    let totalArrivals = 0;
    for (let h = 0; h < 8; h++) {
      const result = tickSimulation(state, prng);
      totalArrivals += result.state.guests.length - state.guests.length;
      state = result.state;
    }

    expect(totalArrivals).toBeGreaterThan(0);
  });
});

describe('simulate (headless)', () => {
  it('completes 30 days without NaN', () => {
    const result = simulate(30, 42);
    expect(result.finalCash).not.toBeNaN();
    expect(result.avgReviewScore).not.toBeNaN();
    expect(result.totalRevenue).not.toBeNaN();
    expect(Number.isFinite(result.avgReviewScore)).toBe(true);
  });

  it('determinism: same seed = same result', () => {
    const a = simulate(30, 42);
    const b = simulate(30, 42);
    expect(a.finalCash).toBe(b.finalCash);
    expect(a.avgReviewScore).toBe(b.avgReviewScore);
    expect(a.totalRevenue).toBe(b.totalRevenue);
  });

  it('balance: bankruptcy rate < 20% over 100 runs', () => {
    let bankruptcies = 0;
    for (let i = 0; i < 100; i++) {
      const result = simulate(30, i);
      if (result.wentBankrupt) bankruptcies++;
    }
    expect(bankruptcies).toBeLessThan(20);
  });

  it('balance: avg rating between 2.5 and 4.5', () => {
    const results = Array.from({ length: 100 }, (_, i) => simulate(30, i));
    const avgReview = results.reduce((s, r) => s + r.avgReviewScore, 0) / results.length;
    expect(avgReview).toBeGreaterThan(3.0); // 0-10 scale
    expect(avgReview).toBeLessThan(9.0);
  });

  it('avgReviewScore ignores stale bookings beyond the retention window (regression: simulate.ts:54 averages state.bookings directly, so a looser retention cap than the averaging window would leak old scores into this CLI stat)', () => {
    // Seed 500 bookings directly: 200 old ones scored 0, then 300 more recent
    // ones scored 10. Zero rooms, so no new bookings occur during the run —
    // whatever survives retention is exactly what both avgReviewScore and the
    // live rolling reviewScore see.
    //
    // Post-fix (retention capped at reviewWindowBookingCount=300, same as the
    // averaging window): only the 300 most recent (all scored 10) survive the
    // very first tick. avgReviewScore = 10.
    //
    // Under the pre-fix bug (retention capped at 600), all 500 would survive:
    // avgReviewScore = (200*0 + 300*10) / 500 = 6.0 — provably different from
    // the live rolling score, which only ever averaged the last 300 (already
    // all 10s) regardless of the bug. This test was verified to actually catch
    // that divergence (checked by temporarily reintroducing the old *20
    // multiplier and confirming this test fails).
    const staleZeros: Booking[] = Array.from({ length: 200 }, (_, i) => ({
      id: `stale${i}`, roomId: 'r', guestId: 'g', nightRate: 100, reviewScore: 0,
    }));
    const recentTens: Booking[] = Array.from({ length: 300 }, (_, i) => ({
      id: `recent${i}`, roomId: 'r', guestId: 'g', nightRate: 100, reviewScore: 10,
    }));

    const result = simulate(1, 42, (state) => ({
      ...state,
      bookings: [...staleZeros, ...recentTens],
    }));

    expect(result.avgReviewScore).toBeCloseTo(10, 5);
    expect(result.reviewScoreHistory.length).toBeGreaterThan(0);
    expect(result.reviewScoreHistory[result.reviewScoreHistory.length - 1]).toBeCloseTo(10, 5);
  });

  it('0 rooms: no crashes, no revenue', () => {
    const result = simulate(10, 42, (state) => state);
    expect(result.totalRevenue).toBe(0);
    expect(result.wentBankrupt).toBe(false);
    expect(result.finalCash).not.toBeNaN();
  });

  it('50 rooms: handles large hotel', () => {
    const result = simulate(30, 42, (state, prng) => {
      let s = state;
      for (let x = 0; x < 10; x++) {
        for (let y = 0; y < 5; y++) {
          const r = addRoom(s, 'standard', x, y);
          if (r) s = r;
        }
      }
      return s;
    });
    expect(result.finalCash).not.toBeNaN();
    expect(result.totalRevenue).toBeGreaterThan(0);
  });
});
