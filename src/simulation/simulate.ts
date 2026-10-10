import type { SimulationSummary } from './types.js';
import { PRNG } from './prng.js';
import { createHotelState, addRoom } from './HotelState.js';
import { tickSimulation } from './tick.js';
import { calculateValuation } from './ObjectivesManager.js';
import { ECONOMY } from '../config/balance.js';
import { STRATEGIES, idleStrategy } from './strategies.js';
import type { Strategy } from './strategies.js';

/**
 * Run a headless simulation for N days and return a summary.
 * Used for balance testing without any rendering.
 */
export function simulate(
  days: number,
  seed: number = 42,
  setupFn?: (state: ReturnType<typeof createHotelState>, prng: PRNG) => ReturnType<typeof createHotelState>,
  strategy: Strategy = idleStrategy
): SimulationSummary {
  const prng = new PRNG(seed);
  let state = createHotelState();

  // Default setup: build a small starter hotel
  if (setupFn) {
    state = setupFn(state, prng);
  } else {
    // 8 standard rooms in a row -- the "Open for Business" objective, and
    // the only room type unlocked at 1 star
    for (let x = 0; x < 8; x++) {
      const result = addRoom(state, 'standard', x, 1); // row 0 stays clear for elevator shafts
      if (result) state = result;
    }
  }

  const reviewScoreHistory: number[] = [];
  let wentBankrupt = false;
  const totalHours = days * 24;

  for (let tick = 0; tick < totalHours; tick++) {
    state = strategy(state);
    const { state: newState } = tickSimulation(state, prng);
    state = newState;

    if (state.hour === 0) {
      reviewScoreHistory.push(state.reviewScore);
    }

    if (state.cash <= ECONOMY.bankruptcyThreshold) {
      wentBankrupt = true;
      break;
    }
  }

  const scores = state.bookings.map(b => b.reviewScore);
  const avgReviewScore = scores.length > 0
    ? scores.reduce((s, r) => s + r, 0) / scores.length
    : 0;

  const occupiedRooms = state.rooms.filter(r => r.status === 'occupied').length;
  const avgOccupancy = state.rooms.length > 0 ? occupiedRooms / state.rooms.length : 0;

  return {
    days,
    finalCash: state.cash,
    avgReviewScore,
    avgOccupancy,
    totalRevenue: state.totalRevenue,
    totalTurnedAway: state.totalTurnedAway,
    wentBankrupt,
    reviewScoreHistory,
    finalStarRating: state.starRating,
    finalRoomCount: state.rooms.length,
    objectivesCompleted: state.objectives.outcomes.filter(o => o === 'completed').length,
    objectivesFailed: state.objectives.outcomes.filter(o => o === 'failed').length,
    loanBalance: state.loan.balance,
    bankruptDay: wentBankrupt ? state.day : null,
    finalValuation: calculateValuation(state),
  };
}

// CLI runner: run when executed directly.
// Usage: npm run simulate -- [days=120] [runs=100] [strategy=all]
const isMainModule = typeof process !== 'undefined'
  && process.argv[1]
  && (process.argv[1].endsWith('simulate.ts') || process.argv[1].endsWith('simulate.js'));

if (isMainModule) {
  const days = Number(process.argv[2] ?? 120);
  const runs = Number(process.argv[3] ?? 100);
  const only = process.argv[4];
  const names = only ? [only] : Object.keys(STRATEGIES);

  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const pct = (n: number) => `${Math.round((n / runs) * 100)}%`;
  const quantile = (xs: number[], q: number) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

  console.log(`Balance report: ${runs} runs x ${days} days per strategy
`);

  for (const name of names) {
    const strategy = STRATEGIES[name];
    if (!strategy) {
      console.error(`Unknown strategy "${name}" (have: ${Object.keys(STRATEGIES).join(', ')})`);
      process.exit(1);
    }
    const results = Array.from({ length: runs }, (_, i) => simulate(days, i, undefined, strategy));

    const bankrupt = results.filter(r => r.wentBankrupt);
    const survivors = results.filter(r => !r.wentBankrupt);
    const starCounts = [1, 2, 3, 4, 5].map(s => results.filter(r => r.finalStarRating === s).length);
    const cash = survivors.map(r => r.finalCash);

    console.log(`=== ${name} ===`);
    console.log(`  Bankrupt:        ${pct(bankrupt.length)}${bankrupt.length ? ` (median day ${quantile(bankrupt.map(r => r.bankruptDay ?? 0), 0.5)})` : ''}`);
    if (survivors.length) {
      console.log(`  Final cash:      p10 ${money(quantile(cash, 0.1))} / median ${money(quantile(cash, 0.5))} / p90 ${money(quantile(cash, 0.9))}`);
    }
    console.log(`  Revenue:         ${money(avg(results.map(r => r.totalRevenue)))} avg`);
    console.log(`  Review score:    ${avg(results.map(r => r.avgReviewScore)).toFixed(2)} avg`);
    console.log(`  Rooms:           ${avg(results.map(r => r.finalRoomCount)).toFixed(1)} avg`);
    console.log(`  Stars:           ${starCounts.map((c, i) => `${i + 1}*:${pct(c)}`).join('  ')}`);
    console.log(`  Goals done:      ${avg(results.map(r => r.objectivesCompleted)).toFixed(1)} avg, ${avg(results.map(r => r.objectivesFailed)).toFixed(1)} missed`);
    console.log(`  Valuation:       p10 ${money(quantile(results.map(r => r.finalValuation), 0.1))} / median ${money(quantile(results.map(r => r.finalValuation), 0.5))} / p90 ${money(quantile(results.map(r => r.finalValuation), 0.9))}`);
    console.log(`  Loan left:       ${money(avg(results.map(r => r.loanBalance)))} avg, paid off in ${pct(results.filter(r => r.loanBalance <= 0).length)}`);
    console.log();
  }
}
