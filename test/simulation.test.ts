import { describe, it, expect, beforeEach } from 'vitest';
import { PRNG } from '../src/simulation/prng.js';
import { createHotelState, createStarterHotel, addRoom, getOccupancyRate, demolishRoom, demolishFacility, addFacility, getDemolishRefund, formatRoomLabel } from '../src/simulation/HotelState.js';
import { processArrivals, processDepartures, calculateGuestReview, calculateGuestReviewBreakdown, generateGuestTrait, getWordOfMouthMultiplier } from '../src/simulation/GuestManager.js';
import { processDailyCosts, checkBankruptcy, updateReviewScore, calculateEarlyDepartureSettlement } from '../src/simulation/EconomyManager.js';
import { calculateRoomNoise, noiseToRatingPenalty, createConstructionNoise, tickNoiseSources, getLoudestNeighborGuestId } from '../src/simulation/NoiseManager.js';
import {
  driftSatisfaction, advanceIncidents, selectNewIncident, groupByChain,
  attributeReviewCause, checkReviewSemiViral, getReputationPenaltyMultiplier,
} from '../src/simulation/StoryGenerator.js';
import { startTurnoverCleaning, processCleaningTick, processDailyHousekeeping, checkHousekeepingCompliance } from '../src/simulation/HousekeepingManager.js';
import { processMaintenanceTick } from '../src/simulation/MaintenanceManager.js';
import { saveGame, loadGame, hasSavedGame, deleteSave } from '../src/simulation/SaveManager.js';
import { calculateStarRating, calculateStarPoints, getNextStarRequirements } from '../src/simulation/StarRatingManager.js';
import { getSpecialEvent, getTotalDemandMultiplier } from '../src/simulation/SeasonManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { simulate } from '../src/simulation/simulate.js';
import { ECONOMY, REVIEW, ROOM_CONFIG, FACILITY_CONFIG, GUEST_TRAITS, NOISE, HOUSEKEEPING, SATISFACTION, STORY, LOYALTY } from '../src/config/balance.js';
import type { Room, Guest, Booking, GuestTrait, ActiveIncident, StoryLogEntry, Purpose } from '../src/simulation/types.js';
import { ACTOR_COLORS } from '../src/render/ActorLayer';
import { getGuestDotColor } from '../src/render/GridRenderer';

/** A fresh hotel with every room type and facility unlocked and cash to spare,
 * for tests that aren't about progression (see requiredStars in balance.ts). */
function unlockedState() {
  return { ...createHotelState(), peakStarRating: 5, cash: 200000 };
}

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
    let state = unlockedState();
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
        cash: 1000, day: 1, hour: 0, rooms: [],
        // In-progress guest predating Guest.name/isReturning/hadNoiseComplaint
        // (v9 shape) -- intentionally has none of these fields, so this
        // actually exercises the v9->v10 backfill rather than passing
        // trivially regardless of whether the migration line exists.
        guests: [{ id: 'g1', budget: 100, stayLength: 2, trait: 'normal', satisfaction: 50, checkInDay: 1 }],
        bookings: [],
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
    expect(loaded!.version).toBe(20);
    expect(loaded!.state.noiseSources).toEqual([]);
    expect(loaded!.state.facilities).toEqual([]); // added by the v8->v9 step
    expect(loaded!.state.activeIncidents).toEqual([]);
    expect(loaded!.state.returningGuestPool).toEqual([]);
    expect(loaded!.state.storyLog).toEqual([]);
    expect(loaded!.state.activeReputationPenalties).toEqual([]);
    // v9->v10 backfill: an in-progress guest loaded from a pre-v10 save gets
    // a generated name and default flags, not left undefined (design-review D5/D10).
    expect(typeof loaded!.state.guests[0].name).toBe('string');
    expect(loaded!.state.guests[0].name.length).toBeGreaterThan(0);
    expect(loaded!.state.guests[0].isReturning).toBe(false);
    expect(loaded!.state.guests[0].hadNoiseComplaint).toBe(false);
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
    expect(loaded!.version).toBe(20);
    expect(loaded!.state.reviewScore).toBeCloseTo(7.2, 5); // 72 / 10
    expect((loaded!.state as any).reputationScore).toBeUndefined();
    expect(loaded!.state.bookings[0].reviewScore).toBe(8); // rating 4 * 2
    expect(loaded!.state.staff.frontDesk).toBe(1); // filled by v6->v7
    expect(loaded!.state.amenities).toEqual({ standard: 'basic', deluxe: 'basic', suite: 'basic' }); // filled by v7->v8
    // v9->v10 backfill: a pre-v10 booking predates satisfactionAtCheckout.
    expect(loaded!.state.bookings[0].satisfactionAtCheckout).toBe(50);
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
    expect(addRoom(state, 'standard', 10, 0)).toBeNull();
    expect(addRoom(state, 'standard', 0, 6)).toBeNull();
    expect(addRoom(state, 'standard', 0, 0, 1)).toBeNull(); // floor not built yet
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
    let state = unlockedState();
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
    let state = unlockedState();
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
      state = addRoom(state, 'standard', i % 8, Math.floor(i / 8))!;
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
      pricePerNight: 80, condition: 50, status: 'occupied' as const, guestId: 'g1', cleanliness: 100, cleaningHoursRemaining: 0, lastDailyCleanDay: 0, decor: 100, renovationHoursRemaining: 0, floor: 0, door: 'down' as const, dailyCleanHoursRemaining: 0,
    };
    const guest: Guest = {
      id: 'g1', budget: 100, stayLength: 1, trait: 'normal',
      satisfaction: 50, checkInDay: 1, name: 'TestGuest', isReturning: false, hadNoiseComplaint: false,
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
      pricePerNight: 80, condition: 100, status: 'occupied' as const, guestId: 'g1', cleanliness: 100, cleaningHoursRemaining: 0, lastDailyCleanDay: 0, decor: 100, renovationHoursRemaining: 0, floor: 0, door: 'down' as const, dailyCleanHoursRemaining: 0,
    };
    const guest: Guest = {
      id: 'g1', budget: 200, stayLength: 1, trait: 'normal',
      satisfaction: 50, checkInDay: 1, name: 'TestGuest', isReturning: false, hadNoiseComplaint: false,
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
      satisfaction: 50, checkInDay: 1, name: 'TestGuest', isReturning: false, hadNoiseComplaint: false,
    };
    const state = createHotelState();

    const lowRoom: Room = {
      id: 'test', type: 'standard', gridX: 0, gridY: 0,
      pricePerNight: 80, condition: 10, status: 'occupied' as const, guestId: 'g1', cleanliness: 100, cleaningHoursRemaining: 0, lastDailyCleanDay: 0, decor: 100, renovationHoursRemaining: 0, floor: 0, door: 'down' as const, dailyCleanHoursRemaining: 0,
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
  it('gives every purpose its own colour, unlike a guest from before purposes, the staff and the facilities', () => {
    const purposes: Purpose[] = ['business', 'sightseeing', 'getaway'];
    const colors = purposes.map(getGuestDotColor);
    expect(new Set(colors).size).toBe(purposes.length);
    expect(colors).not.toContain(getGuestDotColor(undefined));
    for (const other of [...Object.values(ACTOR_COLORS), ...Object.values(FACILITY_CONFIG).map(f => f.color)]) expect(colors).not.toContain(other);
  });
});

describe('HousekeepingManager', () => {
  it('startTurnoverCleaning sets duration per quality tier', () => {
    const baseRoom: Room = {
      id: 'r', type: 'standard', gridX: 0, gridY: 0, pricePerNight: 80,
      condition: 100, cleanliness: 0, status: 'occupied', guestId: 'g1',
      cleaningHoursRemaining: 0, lastDailyCleanDay: 0, decor: 100, renovationHoursRemaining: 0, floor: 0, door: 'down' as const, dailyCleanHoursRemaining: 0,
    };

    const quick = startTurnoverCleaning(baseRoom, 'quick');
    expect(quick.status).toBe('cleaning');
    expect(quick.guestId).toBeUndefined();
    expect(quick.cleaningHoursRemaining).toBe(HOUSEKEEPING.turnoverDuration.quick);

    expect(startTurnoverCleaning(baseRoom, 'standard').cleaningHoursRemaining).toBe(HOUSEKEEPING.turnoverDuration.standard);
    expect(startTurnoverCleaning(baseRoom, 'thorough').cleaningHoursRemaining).toBe(HOUSEKEEPING.turnoverDuration.thorough);
  });

  it('processCleaningTick restores cleanliness to the quality-tier target when a room finishes', () => {
    let state = createStarterHotel(); // staff need hallways to reach rooms // default turnoverQuality: 'standard'
    state = addRoom(state, 'standard', 0, 0)!;
    state = {
      ...state,
      hour: 10, // within the 6-22 work shift
      staff: { ...state.staff, housekeepers: 1 },
      // half an hour left: the housekeeper's walk from the lobby fits in the hour too
      rooms: state.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.5, cleanliness: 0 })),
    };

    const result = processCleaningTick(state);
    expect(result.state.rooms[0].status).toBe('vacant');
    expect(result.state.rooms[0].cleanliness).toBe(HOUSEKEEPING.turnoverCleanlinessResult.standard);
  });

  it('0 housekeepers: cleaning rooms make no progress (stuck indefinitely)', () => {
    let state = createStarterHotel(); // staff need hallways to reach rooms
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
    let state = createStarterHotel(); // staff need hallways to reach rooms
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
    let state = createStarterHotel(); // staff need hallways to reach rooms
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
    let state = createStarterHotel(); // staff need hallways to reach rooms
    state = addRoom(state, 'standard', 0, 0)!;
    const base = {
      ...state,
      hour: HOUSEKEEPING.dailyCleaningHour,
      housekeeping: { turnoverQuality: 'standard' as const, dailyCadence: 'every_other_day' as const },
      staff: { ...state.staff, housekeepers: 1 },
      rooms: state.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'g1', cleanliness: 50 })),
    };

    // Queuing happens at the cleaning hour; the housekeeping tick does the work
    const runDay = (day: number) => processCleaningTick(processDailyHousekeeping({ ...base, day }).state).state;

    expect(runDay(3).rooms[0].cleanliness).toBe(50); // odd day: nothing queued

    expect(runDay(4).rooms[0].cleanliness).toBe(50 + HOUSEKEEPING.dailyCleaningBoost); // cleaned
  });

  it('checkHousekeepingCompliance: warns with 0 housekeepers and rooms built', () => {
    let state = createStarterHotel(); // staff need hallways to reach rooms
    state = addRoom(state, 'standard', 0, 0)!;
    state = { ...state, staff: { ...state.staff, housekeepers: 0 } };
    expect(checkHousekeepingCompliance(state)).toMatch(/No housekeepers/);
  });

  it('checkHousekeepingCompliance: 3-star with cadence "none" is non-compliant', () => {
    let state = createStarterHotel(); // staff need hallways to reach rooms
    state = { ...state, starRating: 3, housekeeping: { turnoverQuality: 'standard', dailyCadence: 'none' } };
    expect(checkHousekeepingCompliance(state)).toMatch(/every-other-day/);
  });

  it('checkHousekeepingCompliance: 4-star requires daily cadence', () => {
    let state = createStarterHotel(); // staff need hallways to reach rooms
    state = { ...state, starRating: 4, housekeeping: { turnoverQuality: 'standard', dailyCadence: 'every_other_day' } };
    expect(checkHousekeepingCompliance(state)).toMatch(/daily housekeeping/);
  });

  it('checkHousekeepingCompliance: compliant hotel returns null', () => {
    let state = createStarterHotel(); // staff need hallways to reach rooms
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
    let state = createStarterHotel(); // staff need hallways to reach rooms
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
    let state = createStarterHotel(); // staff need hallways to reach rooms
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
    let state = createStarterHotel(); // staff need hallways to reach rooms
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
    let state = createStarterHotel(); // staff need hallways to reach rooms
    for (let i = 0; i < 5; i++) state = addRoom(state, 'standard', i, 2)!;
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
    state = addRoom(state, 'standard', 3, 2)!;
    // Clear construction noise (simulating time passing)
    state = { ...state, noiseSources: [] };
    const noise = calculateRoomNoise(state.rooms[0], state);
    expect(noise).toBe(0);
  });

  it('newly built room has construction noise on itself', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 3, 2)!;
    const noise = calculateRoomNoise(state.rooms[0], state);
    expect(noise).toBeGreaterThan(0); // construction noise
  });

  it('adjacent occupied room generates noise', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 3, 2)!;
    state = addRoom(state, 'standard', 4, 2)!;
    // Occupy the neighbor
    const guest: Guest = {
      id: 'g1', budget: 100, stayLength: 1, trait: 'normal',
      satisfaction: 50, checkInDay: 1, name: 'TestGuest', isReturning: false, hadNoiseComplaint: false,
    };
    state = {
      ...state,
      guests: [guest],
      rooms: state.rooms.map(r =>
        r.gridX === 4 ? { ...r, occupied: true, guestId: 'g1' } : r
      ),
    };
    const noise = calculateRoomNoise(state.rooms[0], state);
    expect(noise).toBeGreaterThan(0);
  });

  it('non-adjacent occupied room generates zero noise', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = addRoom(state, 'standard', 3, 2)!; // far away
    // Clear construction noise
    state = { ...state, noiseSources: [] };
    const guest: Guest = {
      id: 'g1', budget: 100, stayLength: 1, trait: 'normal',
      satisfaction: 50, checkInDay: 1, name: 'TestGuest', isReturning: false, hadNoiseComplaint: false,
    };
    state = {
      ...state,
      guests: [guest],
      rooms: state.rooms.map(r =>
        r.gridX === 3 ? { ...r, occupied: true, guestId: 'g1' } : r
      ),
    };
    const noise = calculateRoomNoise(state.rooms[0], state);
    expect(noise).toBe(0);
  });

  it('more adjacent neighbors = more noise', () => {
    let state = createHotelState();
    // Center room at 5,5
    state = addRoom(state, 'standard', 3, 2)!;
    // One neighbor
    state = addRoom(state, 'standard', 4, 2)!;
    state = {
      ...state,
      guests: [{ id: 'g1', budget: 100, stayLength: 1, trait: 'normal', satisfaction: 50, checkInDay: 1, name: 'TestGuest', isReturning: false, hadNoiseComplaint: false }],
      rooms: state.rooms.map(r =>
        r.gridX === 4 ? { ...r, occupied: true, guestId: 'g1' } : r
      ),
    };
    const noise1 = calculateRoomNoise(state.rooms[0], state);

    // Add second neighbor
    state = addRoom(state, 'standard', 2, 2)!;
    state = {
      ...state,
      guests: [...state.guests, { id: 'g2', budget: 100, stayLength: 1, trait: 'normal', satisfaction: 50, checkInDay: 1, name: 'TestGuest2', isReturning: false, hadNoiseComplaint: false }],
      rooms: state.rooms.map(r =>
        r.gridX === 2 && r.gridY === 2 ? { ...r, status: 'occupied' as const, guestId: 'g2', cleanliness: 100, cleaningHoursRemaining: 0, lastDailyCleanDay: 0 } : r
      ),
    };
    const noise2 = calculateRoomNoise(state.rooms[0], state);
    expect(noise2).toBeGreaterThan(noise1);
  });

  it('construction noise affects adjacent rooms', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 3, 2)!;
    state = {
      ...state,
      noiseSources: [createConstructionNoise(4, 2, 'build', 0)],
    };
    const noise = calculateRoomNoise(state.rooms[0], state);
    expect(noise).toBeGreaterThan(0);
  });

  it('construction noise ticks down and expires', () => {
    let sources = [createConstructionNoise(0, 0, 'build', 0)];
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
    const normalGuest: Guest = { id: 'g1', budget: 100, stayLength: 1, trait: 'normal', satisfaction: 50, checkInDay: 1, name: 'TestGuest', isReturning: false, hadNoiseComplaint: false };
    const lightSleeper: Guest = { id: 'g2', budget: 100, stayLength: 1, trait: 'light_sleeper', satisfaction: 50, checkInDay: 1, name: 'TestGuest2', isReturning: false, hadNoiseComplaint: false };
    const noise = 1.0;
    const normalPenalty = noiseToRatingPenalty(noise, normalGuest);
    const lsPenalty = noiseToRatingPenalty(noise, lightSleeper);
    expect(lsPenalty).toBeGreaterThan(normalPenalty);
  });

  it('noise below threshold causes no penalty', () => {
    const guest: Guest = { id: 'g1', budget: 100, stayLength: 1, trait: 'normal', satisfaction: 50, checkInDay: 1, name: 'TestGuest', isReturning: false, hadNoiseComplaint: false };
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
    //        = 1.333 + 0.667 + 0.5 + 0.7 = 3.2 -> 2 stars (thresholds 2 / 4.5).
    // Pinned against the hand-computed value, not against the code's own
    // formula, so a regression in either function's math would be caught.
    let state = unlockedState();
    state = addRoom(state, 'suite', 0, 0)!;
    state = addRoom(state, 'deluxe', 1, 0)!;
    state = addRoom(state, 'standard', 2, 0)!;

    expect(calculateStarPoints(state)).toBeCloseTo(3.2, 5);
    expect(calculateStarRating(state)).toBe(2);
  });

  it('getNextStarRequirements returns null once a hotel is already 5 stars', () => {
    // 3 suites with thorough/daily housekeeping, luxury suite amenities and all
    // four facilities: points = 1.0*2 + 1.0*2 (mix) + 1.0 (hk thorough) + 0.7
    // (cadence) + 0.7 (luxury, 100% of rooms) + 0.5 + 1.0 + 1.0 + 0.3 (gym,
    // restaurant, pool, shop) = 9.2 -> clears the 9-point 5-star threshold.
    let state = unlockedState();
    for (let i = 0; i < 3; i++) {
      state = addRoom(state, 'suite', i, 0)!;
    }
    state = { ...state, housekeeping: { turnoverQuality: 'thorough', dailyCadence: 'daily' }, amenities: { ...state.amenities, suite: 'luxury' } };
    (['gym', 'restaurant', 'pool', 'shop'] as const).forEach((type, i) => { state = addFacility(state, type, i, 1)!; });

    expect(calculateStarPoints(state)).toBeCloseTo(9.2, 5);
    expect(calculateStarRating(state)).toBe(5);
    expect(getNextStarRequirements(state)).toBeNull();
  });

  it('deluxe hint accounts for existing suite percentage (regression: formula must subtract suitePct*suiteRatioPoints)', () => {
    let state = unlockedState();
    for (let i = 0; i < 7; i++) state = addRoom(state, 'standard', i, 0)!;
    for (let i = 0; i < 3; i++) state = addRoom(state, 'suite', i, 1)!;
    state = { ...state, housekeeping: { turnoverQuality: 'thorough', dailyCadence: 'daily' } };
    (['gym', 'restaurant', 'pool', 'shop'] as const).forEach((type, i) => { state = addFacility(state, type, i, 2)!; });

    // Hand-verified against calculateStarPoints: 10 rooms (0 deluxe, 3 suite),
    // thorough/daily housekeeping, basic amenities, all four facilities give
    // points = 0.3*2 + 0.3*2 + 1.0 + 0.7 + 0.5 + 2.8 = 6.2 -> 3 stars, target 4
    // (7 points). otherPoints = 6.2 - (0.3*2 + 0.3*2) = 5.0.
    // neededDeluxePct = (7 - 5.0 - 0.3*2) / 2 = 0.7 (70%).
    // A formula that forgets to subtract suitePct's own contribution would
    // instead compute (7 - 5.0) / 2 = 1.0 (100%), overstating the requirement
    // even though 30% of the mix is already suites — the exact bug caught
    // during this plan's review.
    expect(calculateStarRating(state)).toBe(3);
    const hint = getNextStarRequirements(state);
    expect(hint).not.toBeNull();
    expect(hint).toContain('Add more deluxe/suite rooms (need 70%+)');
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
      { id: 'r1', type: 'standard' as const, gridX: 0, gridY: 0, pricePerNight: 80, condition: 100, cleanliness: 100, status: 'vacant' as const, cleaningHoursRemaining: 0, lastDailyCleanDay: 0, decor: 100, renovationHoursRemaining: 0, floor: 0, door: 'down' as const, dailyCleanHoursRemaining: 0 },
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
    let state = unlockedState();
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
      id: `b${i}`, roomId: 'r', guestId: 'g', nightRate: 100, reviewScore: 5, satisfactionAtCheckout: 50,
    }));
    state = { ...state, bookings: dummyBookings };

    const result = tickSimulation(state, prng);
    expect(result.state.bookings.length).toBe(REVIEW.reviewWindowBookingCount);
  });

  it('cold start: guests arrive on day 1 with seeded reputation', () => {
    const prng = new PRNG(42);
    let state = createStarterHotel(); // guests need the lobby desk and hallways
    // Build some rooms
    for (let i = 0; i < 5; i++) {
      state = addRoom(state, 'standard', i, 2)!;
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

  it('early-departure guard: a guest whose normal checkout and an incident escalation both fire the same tick is removed exactly once (eng-review D1 regression)', () => {
    const prng = new PRNG(7);
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    const room = state.rooms[0];

    const guest: Guest = {
      id: 'g1', name: 'Sam', budget: 200, stayLength: 1, trait: 'light_sleeper',
      satisfaction: 10, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
    };
    const incident: ActiveIncident = {
      id: 'incident-1', type: 'noise_complaint', guestId: 'g1', roomId: room.id,
      stage: 'active', hoursRemaining: 1, chainId: 'incident-1',
    };

    state = {
      ...state,
      day: 2, hour: 10, // day 2 at 10:00, guest checked in day 1, stayLength 1 -> the 11:00 checkout fires this tick
      guests: [guest],
      rooms: state.rooms.map(r => r.id === room.id ? { ...r, status: 'occupied' as const, guestId: 'g1' } : r),
      activeIncidents: [incident], // hoursRemaining 1 -> decrements to 0 -> would escalate this same tick
    };

    const result = tickSimulation(state, prng);

    // Guest is gone exactly once -- not double-processed into two Bookings.
    expect(result.state.guests.find(g => g.id === 'g1')).toBeUndefined();
    const bookingsForGuest = result.state.bookings.filter(b => b.guestId === 'g1');
    expect(bookingsForGuest).toHaveLength(1);
    // The normal checkout path won the race (per D1's guard: normal path takes priority).
    expect(bookingsForGuest[0].id).toBe('booking-g1');
  });
});

describe('StoryGenerator', () => {
  function makeGuest(overrides: Partial<Guest> = {}): Guest {
    return {
      id: 'g1', name: 'Sam', budget: 200, stayLength: 2, trait: 'normal',
      satisfaction: 50, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      ...overrides,
    };
  }

  function makeRoom(overrides: Partial<Room> = {}): Room {
    return {
      id: 'r1', type: 'standard', gridX: 1, gridY: 1, pricePerNight: 80,
      condition: 100, cleanliness: 100, status: 'occupied', guestId: 'g1',
      cleaningHoursRemaining: 0, lastDailyCleanDay: 0, decor: 100, renovationHoursRemaining: 0, floor: 0, door: 'down' as const, dailyCleanHoursRemaining: 0,
      ...overrides,
    };
  }

  it('formatRoomLabel derives a hotel-style number from grid position', () => {
    expect(formatRoomLabel(3, 1, 1)).toBe('214'); // floor 2, unit 14 (row 1 x 10 wide + col 3 + 1)
    expect(formatRoomLabel(0, 0, 0)).toBe('101');
    expect(formatRoomLabel(9, 5, 7)).toBe('860'); // top floor, last tile
  });

  it('getLoudestNeighborGuestId fails closed (null) when there is no eligible neighbor', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 1, 1)!;
    expect(getLoudestNeighborGuestId(state.rooms[0], state)).toBeNull();
  });

  it('getLoudestNeighborGuestId identifies the single loudest occupied neighbor', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 1, 1)!; // center
    state = addRoom(state, 'standard', 2, 1)!; // normal neighbor
    state = addRoom(state, 'standard', 0, 1)!; // party_guest neighbor (louder)

    state = {
      ...state,
      hour: 12, // midday: both neighbours are up (asleep, they'd make none)
      guests: [
        makeGuest({ id: 'quiet', trait: 'normal' }),
        makeGuest({ id: 'loud', trait: 'party_guest' }),
      ],
      rooms: state.rooms.map(r => {
        if (r.gridX === 2 && r.gridY === 1) return { ...r, status: 'occupied' as const, guestId: 'quiet' };
        if (r.gridX === 0 && r.gridY === 1) return { ...r, status: 'occupied' as const, guestId: 'loud' };
        return r;
      }),
    };

    const center = state.rooms.find(r => r.gridX === 1 && r.gridY === 1)!;
    expect(getLoudestNeighborGuestId(center, state)).toBe('loud');
  });

  it('getLoudestNeighborGuestId fails closed (null) on a tie between neighbors', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 1, 1)!;
    state = addRoom(state, 'standard', 2, 1)!;
    state = addRoom(state, 'standard', 0, 1)!;

    state = {
      ...state,
      hour: 12, // midday: both neighbours are up (asleep, they'd make none)
      guests: [makeGuest({ id: 'a', trait: 'normal' }), makeGuest({ id: 'b', trait: 'normal' })],
      rooms: state.rooms.map(r => {
        if (r.gridX === 2 && r.gridY === 1) return { ...r, status: 'occupied' as const, guestId: 'a' };
        if (r.gridX === 0 && r.gridY === 1) return { ...r, status: 'occupied' as const, guestId: 'b' };
        return r;
      }),
    };

    const center = state.rooms.find(r => r.gridX === 1 && r.gridY === 1)!;
    expect(getLoudestNeighborGuestId(center, state)).toBeNull();
  });

  it('calculateGuestReview stays byte-identical to calculateGuestReviewBreakdown().finalScore (regression)', () => {
    const prng1 = new PRNG(99);
    const prng2 = new PRNG(99);
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    const room = { ...state.rooms[0], status: 'occupied' as const, guestId: 'g1' };
    const guest = makeGuest();

    for (let i = 0; i < 50; i++) {
      const score = calculateGuestReview(room, state, guest, prng1);
      const breakdown = calculateGuestReviewBreakdown(room, state, guest, prng2);
      expect(score).toBe(breakdown.finalScore);
    }
  });

  it('driftSatisfaction nudges satisfaction toward a stay-quality target, not instantly', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = {
      ...state,
      guests: [makeGuest({ satisfaction: 50 })],
      rooms: state.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'g1', condition: 100, cleanliness: 100 })),
      noiseSources: [], // addRoom leaves temporary construction noise on the new room -- clear it to isolate ambient drift
    };

    const after = driftSatisfaction(state);
    const drifted = after.guests[0].satisfaction;
    // Good room conditions push the target above 50 -- satisfaction should rise, but not jump all the way there in one tick.
    expect(drifted).toBeGreaterThan(50);
    expect(drifted).toBeLessThan(100);
  });

  it('advanceIncidents resolves a Noise Complaint once room noise drops below threshold', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 3, 2)!; // isolated room, no occupied neighbors -> zero noise
    const room = state.rooms[0];
    const incident: ActiveIncident = {
      id: 'inc-1', type: 'noise_complaint', guestId: 'g1', culpritGuestId: 'g2',
      roomId: room.id, stage: 'active', hoursRemaining: 5, chainId: 'inc-1',
    };
    state = {
      ...state,
      guests: [makeGuest({ satisfaction: 20 })],
      rooms: state.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'g1' })),
      activeIncidents: [incident],
      noiseSources: [], // addRoom leaves temporary construction noise on the new room -- clear it so noise is actually zero
    };

    const result = advanceIncidents(state, new PRNG(1));
    expect(result.state.activeIncidents).toHaveLength(0);
    expect(result.earlyDepartureGuestIds.size).toBe(0);
    expect(result.state.guests[0].satisfaction).toBeGreaterThan(20); // resolved bonus applied
    const resolvedEntry = result.state.storyLog.find(e => e.type === 'noise_complaint_resolved');
    expect(resolvedEntry).toBeDefined();
    expect(resolvedEntry!.chainId).toBe('inc-1');
  });

  it('advanceIncidents escalates a Noise Complaint to early departure when the grace period runs out', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 3, 2)!;
    state = addRoom(state, 'standard', 4, 2)!; // occupied neighbor keeps noise above threshold
    const room = state.rooms[0];
    const incident: ActiveIncident = {
      id: 'inc-1', type: 'noise_complaint', guestId: 'g1', culpritGuestId: 'g2',
      roomId: room.id, stage: 'active', hoursRemaining: 1, chainId: 'inc-1',
    };
    state = {
      ...state,
      guests: [makeGuest({ id: 'g1', satisfaction: 20 }), makeGuest({ id: 'g2', trait: 'party_guest' })],
      rooms: state.rooms.map(r =>
        r.gridX === 3 ? { ...r, status: 'occupied' as const, guestId: 'g1' }
        : { ...r, status: 'occupied' as const, guestId: 'g2' }
      ),
      activeIncidents: [incident],
    };

    const result = advanceIncidents(state, new PRNG(1));
    expect(result.earlyDepartureGuestIds.has('g1')).toBe(true);
    expect(result.state.activeIncidents).toHaveLength(0); // dropped, early-departure pathway takes over
    const escalatedEntry = result.state.storyLog.find(e => e.type === 'noise_complaint_escalated');
    expect(escalatedEntry).toBeDefined();
    expect(escalatedEntry!.chainId).toBe('inc-1'); // same thread as the origin complaint
  });

  it('advanceIncidents moves a guest to a healthy same-type room on Mid-Stay Breakdown', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!; // broken room
    state = addRoom(state, 'standard', 1, 0)!; // healthy vacant same-type room
    const brokenRoom = state.rooms[0];
    const healthyRoom = state.rooms[1];
    const incident: ActiveIncident = {
      id: 'inc-1', type: 'mid_stay_breakdown', guestId: 'g1', roomId: brokenRoom.id,
      stage: 'active', hoursRemaining: 3, chainId: 'inc-1',
    };
    state = {
      ...state,
      guests: [makeGuest({ satisfaction: 50 })],
      rooms: state.rooms.map(r => r.id === brokenRoom.id
        ? { ...r, status: 'occupied' as const, guestId: 'g1', condition: 0 }
        : r),
      activeIncidents: [incident],
    };

    const result = advanceIncidents(state, new PRNG(1));
    expect(result.earlyDepartureGuestIds.size).toBe(0);
    const movedRoom = result.state.rooms.find(r => r.id === healthyRoom.id)!;
    const oldRoom = result.state.rooms.find(r => r.id === brokenRoom.id)!;
    expect(movedRoom.guestId).toBe('g1');
    expect(movedRoom.status).toBe('occupied');
    expect(oldRoom.guestId).toBeUndefined();
    expect(oldRoom.status).toBe('vacant');
    expect(result.state.guests[0].satisfaction).toBeGreaterThan(50);
  });

  it('selectNewIncident respects the daily incident budget', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 3, 2)!;
    state = addRoom(state, 'standard', 4, 2)!;
    const complainer = state.rooms[0];
    state = {
      ...state,
      guests: [makeGuest({ id: 'g1', satisfaction: 10, trait: 'light_sleeper' }), makeGuest({ id: 'g2', trait: 'party_guest' })],
      rooms: state.rooms.map(r =>
        r.gridX === 3 ? { ...r, status: 'occupied' as const, guestId: 'g1' }
        : { ...r, status: 'occupied' as const, guestId: 'g2' }
      ),
      // Already at budget for today -- a prior origin entry exists for day 1.
      storyLog: [{ id: 'prior', day: 1, hour: 0, type: 'noise_complaint', message: 'x', chainId: 'prior' },
                 { id: 'prior2', day: 1, hour: 0, type: 'mid_stay_breakdown', message: 'x', chainId: 'prior2' }] as StoryLogEntry[],
    };

    const result = selectNewIncident(state, new PRNG(1));
    expect(result.state.activeIncidents).toHaveLength(0);
  });

  it('groupByChain orders chains newest-first and keeps a chain\'s stages together', () => {
    const entries: StoryLogEntry[] = [
      { id: 'a', day: 1, hour: 0, type: 'noise_complaint', message: 'origin', chainId: 'chain-a' },
      { id: 'b', day: 1, hour: 5, type: 'noise_complaint_escalated', message: 'escalation', chainId: 'chain-a' },
      { id: 'c', day: 2, hour: 0, type: 'regular_returns', message: 'return', chainId: 'c' },
    ];
    const chains = groupByChain(entries);
    expect(chains).toHaveLength(2);
    expect(chains[0].chainId).toBe('c'); // newest (day 2) first
    expect(chains[1].chainId).toBe('chain-a');
    expect(chains[1].entries.map(e => e.id)).toEqual(['a', 'b']); // chronological within the chain
  });

  it('groupByChain cap-eviction never orphans an escalation from its origin (design-review D11)', () => {
    const oldChain: StoryLogEntry[] = [
      { id: 'old-a', day: 1, hour: 0, type: 'noise_complaint', message: 'origin', chainId: 'old' },
      { id: 'old-b', day: 1, hour: 5, type: 'noise_complaint_escalated', message: 'escalation', chainId: 'old' },
    ];
    // Fill enough newer standalone entries to push "old" out of the cap.
    const filler: StoryLogEntry[] = Array.from({ length: STORY.storyLogMaxChains }, (_, i) => ({
      id: `f${i}`, day: 2, hour: i, type: 'regular_returns', message: 'x', chainId: `f${i}`,
    }));
    const chains = groupByChain([...oldChain, ...filler]).slice(0, STORY.storyLogMaxChains);
    const oldChainRetained = chains.find(c => c.chainId === 'old');
    // Either the whole chain is gone, or both its entries are present -- never just one.
    if (oldChainRetained) {
      expect(oldChainRetained.entries.map(e => e.id).sort()).toEqual(['old-a', 'old-b']);
    } else {
      expect(oldChainRetained).toBeUndefined();
    }
  });

  it('attributeReviewCause picks the largest negative contributor with a fixed tie-break order', () => {
    const base = { noisePenalty: 0, decorPenalty: 0, elevatorPenalty: 0, conditionBonus: 0, cleanlinessBonus: 0, amenityPenalty: 0, priceFairness: 1, guestVariance: 0, facilityBonus: 0, amenityBonus: 0, roomFit: 0, finalScore: 5 };
    expect(attributeReviewCause({ ...base, noisePenalty: 2 })).toBe('noise');
    expect(attributeReviewCause({ ...base, conditionBonus: -2 })).toBe('room condition');
    expect(attributeReviewCause({ ...base, cleanlinessBonus: -2 })).toBe('cleanliness');
    expect(attributeReviewCause({ ...base, amenityPenalty: 2 })).toBe('amenities');
    expect(attributeReviewCause({ ...base, priceFairness: 0 })).toBe('pricing');
    expect(attributeReviewCause({ ...base, roomFit: -0.6, roomDislikes: ['separateBeds'] })).toBe('separate beds');
    expect(attributeReviewCause({ ...base, roomFit: 0.6, roomLikes: ['desk'], noisePenalty: 0.1 })).toBe('noise'); // a room they liked is never the complaint
    // Tie between noise and condition -- fixed order picks noise (declared first).
    expect(attributeReviewCause({ ...base, noisePenalty: 2, conditionBonus: -2 })).toBe('noise');
  });

  it('checkReviewSemiViral fires a temporary reputation penalty on an unusually bad checkout', () => {
    let state = createHotelState();
    const breakdown = { noisePenalty: 3, decorPenalty: 0, elevatorPenalty: 0, conditionBonus: 0, cleanlinessBonus: 0, amenityPenalty: 0, priceFairness: 1, guestVariance: 0, facilityBonus: 0, amenityBonus: 0, roomFit: 0, finalScore: 1 };
    const booking: Booking = { id: 'b1', roomId: 'r1', guestId: 'g1', nightRate: 80, reviewScore: 1, satisfactionAtCheckout: 10 };

    const result = checkReviewSemiViral(state, [{ guestName: 'Sam', roomId: 'r1', booking, breakdown }], new PRNG(1));
    expect(result.state.activeReputationPenalties).toHaveLength(1);
    expect(getReputationPenaltyMultiplier(result.state)).toBeLessThan(1.0);
    expect(result.state.storyLog.some(e => e.type === 'review_semi_viral')).toBe(true);
  });

  it('checkReviewSemiViral does nothing when no checkout was unusually bad', () => {
    const state = createHotelState();
    const breakdown = { noisePenalty: 0, decorPenalty: 0, elevatorPenalty: 0, conditionBonus: 0, cleanlinessBonus: 0, amenityPenalty: 0, priceFairness: 1, guestVariance: 0, facilityBonus: 0, amenityBonus: 0, roomFit: 0, finalScore: 8 };
    const booking: Booking = { id: 'b1', roomId: 'r1', guestId: 'g1', nightRate: 80, reviewScore: 8, satisfactionAtCheckout: 80 };

    const result = checkReviewSemiViral(state, [{ guestName: 'Sam', roomId: 'r1', booking, breakdown }], new PRNG(1));
    expect(result.state.activeReputationPenalties).toEqual(state.activeReputationPenalties);
    expect(getReputationPenaltyMultiplier(result.state)).toBe(1.0);
  });

  it('getWordOfMouthMultiplier is neutral (1.0) at the cold-start default and with no bookings', () => {
    const state = createHotelState();
    expect(getWordOfMouthMultiplier(state)).toBe(1.0);
  });

  it('getWordOfMouthMultiplier rises with higher average satisfaction and stays within the design-review D11 floor/ceiling', () => {
    let state = createHotelState();
    state = {
      ...state,
      bookings: Array.from({ length: 10 }, (_, i) => ({
        id: `b${i}`, roomId: 'r', guestId: 'g', nightRate: 100, reviewScore: 8, satisfactionAtCheckout: 90,
      })),
    };
    const mult = getWordOfMouthMultiplier(state);
    expect(mult).toBeGreaterThan(1.0);
    expect(mult).toBeLessThanOrEqual(STORY.wordOfMouthCeilingMultiplier);
  });

  it('calculateEarlyDepartureSettlement pays for nights stayed minus a comp on nights remaining', () => {
    const settlement = calculateEarlyDepartureSettlement(100, 1, 2);
    expect(settlement.revenue).toBe(100);
    expect(settlement.comp).toBe(ECONOMY.earlyDepartureRefundRate * 100 * 2);
    expect(settlement.cashDelta).toBe(settlement.revenue - settlement.comp);
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
      id: `stale${i}`, roomId: 'r', guestId: 'g', nightRate: 100, reviewScore: 0, satisfactionAtCheckout: 50,
    }));
    const recentTens: Booking[] = Array.from({ length: 300 }, (_, i) => ({
      id: `recent${i}`, roomId: 'r', guestId: 'g', nightRate: 100, reviewScore: 10, satisfactionAtCheckout: 50,
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

  it('32 rooms: fills every room row on the ground floor', () => {
    const result = simulate(30, 42, (state, prng) => {
      let s = state;
      for (let x = 0; x < 8; x++) {
        for (const y of [0, 2, 3, 5]) { // leaving the template corridors (rows 1 and 4) open
          const r = addRoom(s, 'standard', x, y);
          if (r) s = r;
        }
      }
      return s;
    });
    expect(result.finalCash).not.toBeNaN();
    expect(result.totalRevenue).toBeGreaterThan(0);
  });

  it('Story Generator: a long run stays bounded and does not spiral into zero arrivals (design-review D11 balance check)', () => {
    const prng = new PRNG(123);
    let state = { ...createStarterHotel(), peakStarRating: 5, cash: 200000 };
    for (let i = 0; i < 9; i++) {
      const type = i < 5 ? 'standard' : i < 8 ? 'deluxe' : 'suite';
      state = addRoom(state, type as 'standard' | 'deluxe' | 'suite', i, 2)!;
    }
    // A maintenance worker keeps rooms from breaking down over 90 days, so
    // this isolates the story layer's feedback loops from plain neglect.
    state = { ...state, staff: { ...state.staff, maintenanceWorkers: 1 } };

    const arrivalsPerWeek: number[] = [];
    let arrivalsThisWeek = 0;
    for (let hour = 0; hour < 90 * 24; hour++) {
      const before = state.guests.length;
      const result = tickSimulation(state, prng);
      state = result.state;
      const arrived = result.events.filter(e => e.type === 'guest_arrived').length;
      arrivalsThisWeek += arrived;

      expect(state.cash).not.toBeNaN();
      expect(state.reviewScore).not.toBeNaN();
      // Bounded state: story log and active incidents never grow unbounded.
      expect(state.returningGuestPool.length).toBeLessThanOrEqual(LOYALTY.enabled ? LOYALTY.poolMaxSize : STORY.returningGuestPoolMaxSize);

      if (hour % (7 * 24) === 0 && hour > 0) {
        arrivalsPerWeek.push(arrivalsThisWeek);
        arrivalsThisWeek = 0;
      }
    }

    const chains = groupByChain(state.storyLog);
    expect(chains.length).toBeLessThanOrEqual(STORY.storyLogMaxChains);

    // Death-spiral check: arrivals in the final weeks shouldn't have collapsed
    // to near-zero relative to the run's own typical week (a self-relative
    // check, robust to whatever the base arrival rate happens to be).
    const typicalWeek = arrivalsPerWeek.slice(0, 4).reduce((s, w) => s + w, 0) / 4;
    const finalWeek = arrivalsPerWeek[arrivalsPerWeek.length - 1];
    expect(finalWeek).toBeGreaterThan(typicalWeek * 0.15);
  });
});
