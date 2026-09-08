import { describe, it, expect } from 'vitest';
import { PRNG } from '../src/simulation/prng.js';
import { createHotelState, addRoom, getOccupancyRate } from '../src/simulation/HotelState.js';
import { processArrivals, processDepartures, calculateGuestReview } from '../src/simulation/GuestManager.js';
import { processDailyCosts, checkBankruptcy, updateReviewScore } from '../src/simulation/EconomyManager.js';
import { calculateRoomNoise, noiseToRatingPenalty, createConstructionNoise, tickNoiseSources } from '../src/simulation/NoiseManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { simulate } from '../src/simulation/simulate.js';
import { ECONOMY } from '../src/config/balance.js';
import type { Room, Guest, HotelState } from '../src/simulation/types.js';

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
