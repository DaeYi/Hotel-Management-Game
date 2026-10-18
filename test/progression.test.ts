import { describe, it, expect, beforeEach } from 'vitest';
import { PRNG } from '../src/simulation/prng.js';
import { createHotelState, createStarterHotel, addRoom, addFacility, addFixture, isUnlocked } from '../src/simulation/HotelState.js';
import { processLoanPayment, repayLoan, isLoanPaymentDay, getNextLoanPaymentDay } from '../src/simulation/EconomyManager.js';
import { processArrivals } from '../src/simulation/GuestManager.js';
import { evaluateObjective, processObjectives, recordDailyStat, getRecentRevenue, getAverageOccupancy } from '../src/simulation/ObjectivesManager.js';
import { getExpectedPrice, starsForPoints } from '../src/simulation/StarRatingManager.js';
import { saveGame, loadGame } from '../src/simulation/SaveManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { LOAN, OBJECTIVES, ROOM_CONFIG, ECONOMY } from '../src/config/balance.js';
import type { HotelState } from '../src/simulation/types.js';

describe('Opening loan', () => {
  it('starts with the full principal owed', () => {
    const state = createHotelState();
    expect(state.loan.balance).toBe(LOAN.principal);
    expect(state.loan.weeklyPayment).toBe(LOAN.weeklyPayment);
  });

  it('is due every 7 days, never on day 1', () => {
    expect(isLoanPaymentDay(1)).toBe(false);
    expect(isLoanPaymentDay(8)).toBe(true);
    expect(isLoanPaymentDay(15)).toBe(true);
    expect(isLoanPaymentDay(9)).toBe(false);
    expect(getNextLoanPaymentDay(1)).toBe(8);
    expect(getNextLoanPaymentDay(8)).toBe(15);
    expect(getNextLoanPaymentDay(10)).toBe(15);
  });

  it('a payment covers interest first, then principal', () => {
    const state = createHotelState();
    const { state: after, events } = processLoanPayment(state);
    const interest = LOAN.principal * LOAN.weeklyInterestRate;
    expect(after.cash).toBe(state.cash - LOAN.weeklyPayment);
    expect(after.loan.balance).toBeCloseTo(LOAN.principal + interest - LOAN.weeklyPayment, 5);
    expect(events[0].type).toBe('loan_payment');
  });

  it('a payment comes out even without the cash, and counts as missed', () => {
    const state = { ...createHotelState(), cash: 200 };
    const { state: after, events } = processLoanPayment(state);
    expect(after.cash).toBe(200 - LOAN.weeklyPayment);
    expect(after.loan.missedPayments).toBe(1);
    expect(events[0].data?.missed).toBe(true);
  });

  it('the final payment only charges what is owed and announces payoff', () => {
    const state = { ...createHotelState(), loan: { balance: 100, weeklyPayment: LOAN.weeklyPayment, missedPayments: 0 } };
    const { state: after, events } = processLoanPayment(state);
    expect(after.loan.balance).toBe(0);
    expect(after.cash).toBeCloseTo(state.cash - 100 * (1 + LOAN.weeklyInterestRate), 5);
    expect(events.map(e => e.type)).toContain('loan_paid_off');
  });

  it('a paid-off loan takes no more payments', () => {
    const state = { ...createHotelState(), loan: { balance: 0, weeklyPayment: LOAN.weeklyPayment, missedPayments: 0 } };
    const { state: after, events } = processLoanPayment(state);
    expect(after).toBe(state);
    expect(events).toHaveLength(0);
  });

  it('early repayment is capped by the balance and by available cash', () => {
    const state = createHotelState();
    const paid = repayLoan(state, 5000)!;
    expect(paid.cash).toBe(state.cash - 5000);
    expect(paid.loan.balance).toBe(LOAN.principal - 5000);

    const broke = repayLoan({ ...state, cash: 1200 }, 5000)!;
    expect(broke.cash).toBe(0);
    expect(broke.loan.balance).toBe(LOAN.principal - 1200);

    expect(repayLoan({ ...state, cash: -50 }, 5000)).toBeNull();
    expect(repayLoan({ ...state, loan: { ...state.loan, balance: 0 } }, 5000)).toBeNull();
  });

  it('the tick takes the payment at the start of a payment day', () => {
    const prng = new PRNG(1);
    let state: HotelState = { ...createHotelState(), day: 7, hour: 23 };
    state = tickSimulation(state, prng).state; // rolls over to day 8, hour 0
    expect(state.day).toBe(8);
    const result = tickSimulation(state, prng); // hour-0 tick of day 8 processes daily costs + loan
    expect(result.events.map(e => e.type)).toContain('loan_payment');
    expect(result.state.loan.balance).toBeLessThan(LOAN.principal);
  });
});

describe('Star-gated unlocks', () => {
  it('a fresh hotel can only build standard rooms and a shop', () => {
    const state = createHotelState();
    expect(isUnlocked(state, 'standard')).toBe(true);
    expect(isUnlocked(state, 'shop')).toBe(true);
    expect(isUnlocked(state, 'deluxe')).toBe(false);
    expect(isUnlocked(state, 'gym')).toBe(false);
    expect(isUnlocked(state, 'suite')).toBe(false);
    expect(isUnlocked(state, 'pool')).toBe(false);
    expect(addRoom(state, 'deluxe', 0, 0)).toBeNull();
    expect(addFacility(state, 'gym', 0, 0)).toBeNull();
  });

  it('unlocks follow the peak star rating, not the current one', () => {
    const state = { ...createHotelState(), starRating: 1, peakStarRating: 3 };
    expect(addRoom(state, 'suite', 0, 0)).not.toBeNull();
    expect(addFacility(state, 'restaurant', 1, 0)).not.toBeNull();
    expect(addFacility(state, 'pool', 2, 0)).toBeNull();
  });

  it('reaching a new star rating raises the peak and announces what unlocked', () => {
    const prng = new PRNG(1);
    let state = createHotelState();
    for (let i = 0; i < 10; i++) state = addRoom(state, 'standard', i % 8, Math.floor(i / 8))!;
    state = addFacility(state, 'shop', 0, 3)!;
    // 10 rooms (0.5) + standard/daily housekeeping (1.2) + shop (0.3) = 2.0 points = 2 stars
    const result = tickSimulation(state, prng);
    expect(result.state.starRating).toBe(2);
    expect(result.state.peakStarRating).toBe(2);
    const unlock = result.events.find(e => e.type === 'build_unlocked');
    expect(unlock?.message).toContain('deluxe room');
    expect(unlock?.message).toContain('gym');
  });

  it('a later star downgrade keeps the peak', () => {
    const prng = new PRNG(1);
    const state = { ...createHotelState(), starRating: 3, peakStarRating: 3 };
    const after = tickSimulation(state, prng).state;
    expect(after.starRating).toBe(1);
    expect(after.peakStarRating).toBe(3);
  });

  it('star thresholds start a default hotel at 1 star', () => {
    expect(starsForPoints(0)).toBe(1);
    expect(starsForPoints(1.2)).toBe(1); // default housekeeping alone
    expect(starsForPoints(2)).toBe(2);
    expect(starsForPoints(4.5)).toBe(3);
    expect(starsForPoints(7)).toBe(4);
    expect(starsForPoints(9)).toBe(5);
    expect(starsForPoints(12)).toBe(5);
  });
});

describe('Star-scaled pricing and demand', () => {
  it('fair price rises with stars, and new rooms start at it', () => {
    expect(getExpectedPrice('standard', 1)).toBe(ROOM_CONFIG.standard.expectedPrice);
    expect(getExpectedPrice('standard', 3)).toBeGreaterThan(getExpectedPrice('standard', 2));
    const state = { ...createHotelState(), starRating: 3, peakStarRating: 3 };
    expect(addRoom(state, 'standard', 0, 0)!.rooms[0].pricePerNight).toBe(getExpectedPrice('standard', 3));
  });

  function checkInsOverDays(price: number, days: number): number {
    // Starter lobby plus extra desks so check-in capacity never limits the comparison
    let state = { ...createStarterHotel(), cash: 200000 };
    for (const x of [4, 5, 6, 7]) state = addFixture(state, 'desk', x, 0, 0)!;
    for (const y of [2, 3, 5]) for (let x = 0; x < 9; x++) state = addRoom(state, 'standard', x, y) ?? state; // (1,3) is the lobby desk; x = 9 is left open as a hallway
    state = { ...state, staff: { ...state.staff, frontDesk: 10 }, rooms: state.rooms.map(r => ({ ...r, pricePerNight: price })) };
    const prng = new PRNG(7);
    let checkedIn = 0;
    for (let d = 0; d < days; d++) {
      for (let h = ECONOMY.checkInStartHour; h < ECONOMY.checkInEndHour; h++) {
        checkedIn += processArrivals({ ...state, day: 10 + d }, h, prng).checkedIn.length;
      }
    }
    return checkedIn;
  }

  it('overpricing loses guests even when there are plenty of rooms', () => {
    const fair = checkInsOverDays(80, 20);
    const high = checkInsOverDays(120, 20); // 1.5x fair
    const extreme = checkInsOverDays(180, 20); // past every guest's tolerance (a big spender's goes to 2.2x)
    expect(high).toBeLessThan(fair * 0.6);
    expect(extreme).toBe(0);
  });
});

describe('Owner objectives', () => {
  it('start at the first objective', () => {
    const state = createHotelState();
    expect(state.objectives.currentIndex).toBe(0);
    expect(OBJECTIVES[0].kind).toBe('room_count');
  });

  it('completing an objective pays its reward and advances', () => {
    let state = createHotelState();
    for (let i = 0; i < OBJECTIVES[0].target; i++) state = addRoom(state, 'standard', i, 0)!;
    const { state: after, events } = processObjectives(state);
    expect(after.cash).toBe(state.cash + OBJECTIVES[0].reward);
    expect(after.objectives.currentIndex).toBe(1);
    expect(after.objectives.outcomes).toEqual(['completed']);
    expect(events[0].type).toBe('objective_completed');
  });

  it('an objective fails the day after its deadline, with no reward', () => {
    const state = { ...createHotelState(), day: OBJECTIVES[0].deadlineDay! };
    expect(processObjectives(state).state.objectives.currentIndex).toBe(0); // still on time

    const late = { ...state, day: OBJECTIVES[0].deadlineDay! + 1 };
    const { state: after, events } = processObjectives(late);
    expect(after.cash).toBe(late.cash);
    expect(after.objectives.outcomes).toEqual(['failed']);
    expect(events[0].type).toBe('objective_failed');
  });

  it('resolves at most one objective per call', () => {
    let state = { ...createHotelState(), day: 999 }; // every deadline has passed
    state = processObjectives(state).state;
    expect(state.objectives.currentIndex).toBe(1);
  });

  it('the occupancy objective needs a full week of history', () => {
    const objective = OBJECTIVES.find(o => o.kind === 'occupancy_7d')!;
    let state = createHotelState();
    for (let i = 0; i < 6; i++) state = { ...state, dailyStats: [...state.dailyStats, { day: i + 1, occupancy: 1, totalRevenue: 0, valuation: 0 }] };
    expect(evaluateObjective(state, objective).complete).toBe(false);
    state = { ...state, dailyStats: [...state.dailyStats, { day: 7, occupancy: 1, totalRevenue: 0, valuation: 0 }] };
    expect(evaluateObjective(state, objective).complete).toBe(true);
    expect(getAverageOccupancy(state, 7)).toBe(1);
  });

  it('the revenue objective counts only the last 30 days', () => {
    let state = createHotelState();
    // 40 days at $1,000/day
    for (let d = 1; d <= 40; d++) {
      state = recordDailyStat({ ...state, day: d, totalRevenue: d * 1000 });
    }
    expect(getRecentRevenue(state, 30)).toBe(30000);
    // Less history than the window: count from zero
    const young = recordDailyStat({ ...createHotelState(), totalRevenue: 5000 });
    expect(getRecentRevenue(young, 30)).toBe(5000);
  });

  it('the loan objective completes once the balance hits zero', () => {
    const objective = OBJECTIVES.find(o => o.kind === 'loan_paid_off')!;
    const state = createHotelState();
    expect(evaluateObjective(state, objective).complete).toBe(false);
    expect(evaluateObjective({ ...state, loan: { ...state.loan, balance: 0 } }, objective).complete).toBe(true);
  });

  it('every objective deadline is later than the one before it', () => {
    for (let i = 1; i < OBJECTIVES.length; i++) {
      expect(OBJECTIVES[i].deadlineDay!).toBeGreaterThan(OBJECTIVES[i - 1].deadlineDay!);
    }
  });
});

describe('SaveManager v10 -> current', () => {
  beforeEach(() => localStorage.clear());

  it('gives older saves no loan, fresh objectives, and a recomputed star peak', () => {
    let state = createHotelState();
    for (let i = 0; i < 3; i++) state = addRoom(state, 'standard', i, 0)!;
    const legacy: any = { ...state, starRating: 4 };
    delete legacy.loan;
    delete legacy.objectives;
    delete legacy.dailyStats;
    delete legacy.peakStarRating;
    localStorage.setItem('hotel-game-save', JSON.stringify({ version: 10, prngState: 1, state: legacy, timestamp: 0 }));

    const loaded = loadGame()!;
    expect(loaded.version).toBe(21);
    expect(loaded.state.loan.balance).toBe(0);
    expect(loaded.state.objectives).toEqual({ currentIndex: 0, outcomes: [] });
    expect(loaded.state.dailyStats).toEqual([]);
    expect(loaded.state.starRating).toBe(1); // old thresholds said 4; new ones say 1
    expect(loaded.state.peakStarRating).toBe(1);
  });

  it('round-trips the new fields', () => {
    const state = { ...createHotelState(), peakStarRating: 3, objectives: { currentIndex: 2, outcomes: ['completed' as const, 'failed' as const] } };
    saveGame(state, new PRNG(1));
    const loaded = loadGame()!;
    expect(loaded.state.peakStarRating).toBe(3);
    expect(loaded.state.objectives.outcomes).toEqual(['completed', 'failed']);
    expect(loaded.state.loan.balance).toBe(LOAN.principal);
  });
});

describe('Balance (headless strategies)', () => {
  const run = (name: string, days: number, runs: number) =>
    Array.from({ length: runs }, (_, i) => simulate(days, i, undefined, STRATEGIES[name]));

  it('balanced play survives a year, pays off the loan, and climbs to at least 4 stars', () => {
    const results = run('balanced', 365, 8);
    expect(results.every(r => !r.wentBankrupt)).toBe(true);
    expect(results.every(r => r.loanBalance === 0)).toBe(true);
    expect(results.every(r => r.finalStarRating >= 4)).toBe(true);
  }, 60000);

  it('a hands-off hotel eventually goes bankrupt', () => {
    const results = run('idle', 250, 8);
    expect(results.every(r => r.wentBankrupt)).toBe(true);
  }, 60000);

  it('heavy overpricing earns less than fair pricing', () => {
    const balanced = run('balanced', 120, 8);
    const greedy = run('greedy', 120, 8);
    const avgRevenue = (rs: typeof balanced) => rs.reduce((s, r) => s + r.totalRevenue, 0) / rs.length;
    expect(avgRevenue(greedy)).toBeLessThan(avgRevenue(balanced));
  }, 60000);
});
