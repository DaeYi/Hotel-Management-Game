import { describe, it, expect, beforeEach } from 'vitest';
import { PRNG } from '../src/simulation/prng.js';
import {
  createHotelState, addRoom, addFacility, renovateRoom, renovateFacility, upgradeFacility,
  getRenovationCost, getFacilityUpgradeCost,
} from '../src/simulation/HotelState.js';
import { decayDecor, processRenovationTick, getDecorStarPenalty, getDecorReviewPenalty, getAverageDecor } from '../src/simulation/DecorManager.js';
import { startCampaign, getCampaignCost, getCampaignDemandMultiplier, tickCampaign } from '../src/simulation/MarketingManager.js';
import { processDailyCosts } from '../src/simulation/EconomyManager.js';
import { getStaffDailyCost } from '../src/simulation/MaintenanceManager.js';
import { getExpectedArrivalsPerDay, calculateGuestReviewBreakdown } from '../src/simulation/GuestManager.js';
import { calculateStarPoints } from '../src/simulation/StarRatingManager.js';
import {
  calculateValuation, getCurrentObjective, getLegacyObjective, isLegacyPhase, evaluateObjective,
  processObjectives, recordDailyStat,
} from '../src/simulation/ObjectivesManager.js';
import { loadGame } from '../src/simulation/SaveManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { DECOR, RENOVATION, ROOM_CONFIG, FACILITY_CONFIG, MARKETING, OBJECTIVES, LEGACY, STAR_RATING, ECONOMY } from '../src/config/balance.js';
import type { Guest } from '../src/simulation/types.js';

function unlockedState() {
  return { ...createHotelState(), peakStarRating: 5, cash: 500000 };
}

describe('Prestige upkeep', () => {
  it('room operating costs and staff wages scale with star rating', () => {
    let state = createHotelState();
    for (let i = 0; i < 4; i++) state = addRoom(state, 'standard', i, 0)!;
    const oneStar = { ...state, cash: 0 };
    const fiveStar = { ...oneStar, starRating: 5 };

    const roomCost = (s: typeof state) => -processDailyCosts(s).cashDelta;
    const amenities = 4 * 5; // basic tier, unscaled
    expect(roomCost(oneStar) - amenities).toBeCloseTo(4 * ECONOMY.dailyOperatingCostPerRoom, 5);
    expect(roomCost(fiveStar) - amenities).toBeCloseTo(4 * ECONOMY.dailyOperatingCostPerRoom * STAR_RATING.upkeepMultiplier[5], 5);
    expect(getStaffDailyCost(fiveStar)).toBeCloseTo(getStaffDailyCost(oneStar) * STAR_RATING.upkeepMultiplier[5], 5);
  });
});

describe('Decor and renovation', () => {
  it('new rooms and facilities start fresh and fade daily', () => {
    let state = unlockedState();
    state = addRoom(state, 'standard', 0, 0)!;
    state = addFacility(state, 'gym', 1, 0)!;
    expect(state.rooms[0].decor).toBe(100);
    expect(state.facilities[0].decor).toBe(100);

    const faded = decayDecor(state);
    expect(faded.rooms[0].decor).toBeCloseTo(100 - DECOR.decayPerDay, 5);
    expect(faded.facilities[0].decor).toBeCloseTo(100 - DECOR.decayPerDay, 5);
  });

  it('decor fades once per day in the tick', () => {
    let state = addRoom(createHotelState(), 'standard', 0, 0)!;
    const prng = new PRNG(1);
    for (let h = 0; h < 24 * 3; h++) state = tickSimulation(state, prng).state;
    // Daily costs (and decor fade) run at hour 0 from day 2: days 2 and 3 so far
    expect(state.rooms[0].decor).toBeCloseTo(100 - 2 * DECOR.decayPerDay, 5);
  });

  it('fresh decor has no penalty; stale decor costs star points and reviews', () => {
    let state = unlockedState();
    state = addRoom(state, 'standard', 0, 0)!;
    expect(getDecorStarPenalty(state)).toBe(0);
    expect(getDecorReviewPenalty(100)).toBe(0);
    expect(getDecorReviewPenalty(DECOR.freshThreshold)).toBe(0);

    const stale = { ...state, rooms: state.rooms.map(r => ({ ...r, decor: 0 })) };
    expect(getDecorStarPenalty(stale)).toBeCloseTo(DECOR.maxStarPenalty, 5);
    expect(getDecorReviewPenalty(0)).toBeCloseTo(DECOR.reviewWeight, 5);
    expect(calculateStarPoints(stale)).toBeCloseTo(calculateStarPoints(state) - DECOR.maxStarPenalty, 5);
  });

  it('stale decor lowers a guest review', () => {
    let state = unlockedState();
    state = addRoom(state, 'standard', 0, 0)!;
    const guest: Guest = { id: 'g', name: 'Sam', budget: 200, stayLength: 1, trait: 'normal', satisfaction: 50, checkInDay: 1, isReturning: false, hadNoiseComplaint: false };
    const fresh = calculateGuestReviewBreakdown(state.rooms[0], state, guest, new PRNG(5));
    const staleRoom = { ...state.rooms[0], decor: 10 };
    const stale = calculateGuestReviewBreakdown(staleRoom, state, guest, new PRNG(5));
    expect(stale.decorPenalty).toBeGreaterThan(0);
    expect(stale.finalScore).toBeLessThan(fresh.finalScore);
  });

  it('renovating a room costs a share of build cost, scaled by stars, and takes it offline', () => {
    let state = { ...unlockedState(), starRating: 3 };
    state = addRoom(state, 'suite', 0, 0)!;
    state = { ...state, rooms: state.rooms.map(r => ({ ...r, decor: 20, condition: 40 })) };

    const cost = getRenovationCost(ROOM_CONFIG.suite.buildCost, 3);
    expect(cost).toBe(Math.round(ROOM_CONFIG.suite.buildCost * RENOVATION.costRate * STAR_RATING.priceMultiplier[3]));

    const after = renovateRoom(state, state.rooms[0].id)!;
    expect(after.cash).toBe(state.cash - cost);
    expect(after.rooms[0].status).toBe('renovating');
    expect(after.noiseSources.some(n => n.type === 'renovate')).toBe(true);
  });

  it('only vacant rooms can be renovated, and only with the cash', () => {
    let state = addRoom(unlockedState(), 'standard', 0, 0)!;
    const occupied = { ...state, rooms: state.rooms.map(r => ({ ...r, status: 'occupied' as const })) };
    expect(renovateRoom(occupied, state.rooms[0].id)).toBeNull();
    expect(renovateRoom({ ...state, cash: 10 }, state.rooms[0].id)).toBeNull();
  });

  it('a renovated room reopens after the duration, good as new', () => {
    let state = addRoom(unlockedState(), 'standard', 0, 0)!;
    state = { ...state, rooms: state.rooms.map(r => ({ ...r, decor: 5, condition: 30, cleanliness: 40 })) };
    state = renovateRoom(state, state.rooms[0].id)!;

    for (let h = 0; h < RENOVATION.durationHours - 1; h++) {
      state = processRenovationTick(state).state;
    }
    expect(state.rooms[0].status).toBe('renovating');

    const result = processRenovationTick(state);
    const room = result.state.rooms[0];
    expect(room.status).toBe('vacant');
    expect([room.decor, room.condition, room.cleanliness]).toEqual([100, 100, 100]);
    expect(result.events[0].type).toBe('renovation_complete');
  });

  it('renovating rooms are never booked', () => {
    let state = addRoom(unlockedState(), 'standard', 0, 0)!;
    state = renovateRoom(state, state.rooms[0].id)!;
    const prng = new PRNG(2);
    state = { ...state, hour: 14, day: 6 };
    for (let h = 0; h < 8; h++) {
      state = tickSimulation(state, prng).state;
      expect(state.guests).toHaveLength(0);
    }
  });

  it('renovating a facility is instant and restores its decor', () => {
    let state = addFacility(unlockedState(), 'restaurant', 0, 0)!;
    state = { ...state, facilities: state.facilities.map(f => ({ ...f, decor: 30 })) };
    const after = renovateFacility(state, state.facilities[0].id)!;
    expect(after.facilities[0].decor).toBe(100);
    expect(after.cash).toBe(state.cash - getRenovationCost(FACILITY_CONFIG.restaurant.buildCost, state.starRating));
    expect(renovateFacility(after, after.facilities[0].id)).toBeNull(); // already fresh
  });
});

describe('Facility upgrades', () => {
  it('upgrade needs the level star rating and cash, and caps at level 3', () => {
    let state = addFacility(unlockedState(), 'gym', 0, 0)!;
    const id = state.facilities[0].id;
    expect(upgradeFacility({ ...state, peakStarRating: 3 }, id)).toBeNull();

    const cost = getFacilityUpgradeCost(state.facilities[0])!;
    state = upgradeFacility(state, id)!;
    expect(state.facilities[0].level).toBe(2);
    state = upgradeFacility(state, id)!;
    expect(state.facilities[0].level).toBe(3);
    expect(getFacilityUpgradeCost(state.facilities[0])).toBeNull();
    expect(upgradeFacility(state, id)).toBeNull();
    expect(cost).toBe(FACILITY_CONFIG.gym.buildCost);
  });

  it('upgrades add star points and raise operating cost', () => {
    let state = addFacility(unlockedState(), 'pool', 0, 0)!;
    state = addRoom(state, 'standard', 1, 0)!;
    const before = calculateStarPoints(state);
    const costBefore = processDailyCosts(state).cashDelta;
    const upgraded = upgradeFacility(state, state.facilities[0].id)!;
    expect(calculateStarPoints(upgraded)).toBeGreaterThan(before);
    expect(processDailyCosts(upgraded).cashDelta).toBeLessThan(costBefore);
  });
});

describe('Marketing campaigns', () => {
  it('cost scales with hotel size', () => {
    let state = createHotelState();
    const small = getCampaignCost(state, 'local');
    for (let i = 0; i < 5; i++) state = addRoom(state, 'standard', i, 0)!;
    expect(getCampaignCost(state, 'local')).toBe(small + 5 * MARKETING.campaigns.local.perRoomCost);
  });

  it('a campaign boosts arrivals while it runs, one at a time', () => {
    let state = createHotelState();
    for (let i = 0; i < 5; i++) state = addRoom(state, 'standard', i, 0)!;
    const base = getExpectedArrivalsPerDay(state);

    const running = startCampaign(state, 'online')!;
    expect(running.cash).toBe(state.cash - getCampaignCost(state, 'online'));
    expect(getCampaignDemandMultiplier(running)).toBe(MARKETING.campaigns.online.demandBoost);
    expect(getExpectedArrivalsPerDay(running)).toBeCloseTo(base * MARKETING.campaigns.online.demandBoost, 5);
    expect(startCampaign(running, 'local')).toBeNull();
    expect(startCampaign({ ...state, cash: 0 }, 'local')).toBeNull();
  });

  it('a campaign ends after its duration', () => {
    let state = startCampaign(createHotelState(), 'local')!;
    const hours = MARKETING.campaigns.local.durationDays * 24;
    for (let h = 0; h < hours - 1; h++) state = tickCampaign(state).state;
    expect(state.activeCampaign).not.toBeNull();
    const result = tickCampaign(state);
    expect(result.state.activeCampaign).toBeNull();
    expect(result.events[0].type).toBe('campaign_ended');
  });
});

describe('Valuation', () => {
  it('counts property at build cost, net cash, and recent revenue', () => {
    let state = createHotelState();
    state = addRoom(state, 'standard', 0, 0)!;
    // No revenue yet: property + cash - loan
    expect(calculateValuation(state)).toBeCloseTo(ROOM_CONFIG.standard.buildCost + state.cash - state.loan.balance, 5);

    const earning = recordDailyStat({ ...state, totalRevenue: 1000 });
    expect(calculateValuation(earning)).toBeCloseTo(calculateValuation(state) + 1000 * 6, 5);
  });

  it('stale decor discounts property value', () => {
    const state = addRoom({ ...createHotelState(), peakStarRating: 3 }, 'suite', 0, 0)!;
    const stale = { ...state, rooms: state.rooms.map(r => ({ ...r, decor: 0 })) };
    expect(calculateValuation(state) - calculateValuation(stale)).toBeCloseTo(ROOM_CONFIG.suite.buildCost * 0.5, 5);
  });
});

describe('Legacy goals', () => {
  it('follow the owner goals, with no deadline or reward', () => {
    const state = { ...createHotelState(), objectives: { currentIndex: OBJECTIVES.length, outcomes: [] } };
    expect(isLegacyPhase(state)).toBe(true);
    const goal = getCurrentObjective(state);
    expect(goal.kind).toBe('valuation');
    expect(goal.deadlineDay).toBeNull();
    expect(goal.reward).toBe(0);
  });

  it('cycle through four kinds and escalate each tier', () => {
    expect([0, 1, 2, 3].map(n => getLegacyObjective(n).kind)).toEqual(['valuation', 'five_star_days', 'occupancy_30d', 'review_score']);
    expect(getLegacyObjective(4).target).toBe(LEGACY.valuationBase * 2);
    expect(getLegacyObjective(5).target).toBe(LEGACY.fiveStarDaysBase * 2);
    expect(getLegacyObjective(6).target).toBeGreaterThan(getLegacyObjective(2).target);
    expect(getLegacyObjective(402).target).toBeLessThanOrEqual(LEGACY.occupancyCap); // occupancy, capped
  });

  it('never fail, no matter how late', () => {
    const state = { ...createHotelState(), day: 9999, objectives: { currentIndex: OBJECTIVES.length, outcomes: [] } };
    const result = processObjectives(state);
    expect(result.state.objectives.currentIndex).toBe(OBJECTIVES.length);
    expect(result.events).toHaveLength(0);
  });

  it('the five-star streak counts consecutive end-of-day 5-star snapshots', () => {
    let state = { ...createHotelState(), starRating: 5 };
    state = recordDailyStat(state);
    state = recordDailyStat(state);
    expect(state.daysAtFiveStars).toBe(2);
    state = recordDailyStat({ ...state, starRating: 4 });
    expect(state.daysAtFiveStars).toBe(0);

    const goal = getLegacyObjective(1);
    expect(evaluateObjective({ ...state, daysAtFiveStars: goal.target }, goal).complete).toBe(true);
  });
});

describe('SaveManager v11 -> v12', () => {
  beforeEach(() => localStorage.clear());

  it('backfills fresh decor, level 1 facilities, and no campaign', () => {
    let state = addRoom(createHotelState(), 'standard', 0, 0)!;
    state = addFacility(state, 'shop', 1, 0)!;
    const legacy: any = {
      ...state,
      rooms: state.rooms.map(({ decor, renovationHoursRemaining, ...r }) => r),
      facilities: state.facilities.map(({ decor, level, ...f }) => f),
      dailyStats: [{ day: 1, occupancy: 0.5, totalRevenue: 100 }],
    };
    delete legacy.activeCampaign;
    delete legacy.daysAtFiveStars;
    localStorage.setItem('hotel-game-save', JSON.stringify({ version: 11, prngState: 1, state: legacy, timestamp: 0 }));

    const loaded = loadGame()!;
    expect(loaded.version).toBe(12);
    expect(loaded.state.rooms[0]).toMatchObject({ decor: 100, renovationHoursRemaining: 0 });
    expect(loaded.state.facilities[0]).toMatchObject({ decor: 100, level: 1 });
    expect(loaded.state.activeCampaign).toBeNull();
    expect(loaded.state.daysAtFiveStars).toBe(0);
    expect(loaded.state.dailyStats[0].valuation).toBe(0);
    expect(getAverageDecor(loaded.state)).toBe(100);
  });
});

describe('Balance: reinvesting beats hoarding', () => {
  it('over 400 days, reinvesting ends with a higher valuation and more stars than banking the cash', () => {
    const runs = 6;
    const balanced = Array.from({ length: runs }, (_, i) => simulate(400, i, undefined, STRATEGIES.balanced));
    const hoarder = Array.from({ length: runs }, (_, i) => simulate(400, i, undefined, STRATEGIES.hoarder));
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

    expect(balanced.every(r => !r.wentBankrupt)).toBe(true);
    expect(avg(balanced.map(r => r.finalValuation))).toBeGreaterThan(avg(hoarder.map(r => r.finalValuation)));
    expect(avg(balanced.map(r => r.finalStarRating))).toBeGreaterThan(avg(hoarder.map(r => r.finalStarRating)));
    // The cash pile no longer runs away: balanced keeps spending
    expect(avg(balanced.map(r => r.finalCash))).toBeLessThan(avg(hoarder.map(r => r.finalCash)));
  }, 120000);
});
