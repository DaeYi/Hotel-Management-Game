import type { SimulationSummary } from './types.js';
import { PRNG } from './prng.js';
import { createHotelState, addRoom } from './HotelState.js';
import { tickSimulation } from './tick.js';
import { ECONOMY } from '../config/balance.js';

/**
 * Run a headless simulation for N days and return a summary.
 * Used for balance testing without any rendering.
 */
export function simulate(
  days: number,
  seed: number = 42,
  setupFn?: (state: ReturnType<typeof createHotelState>, prng: PRNG) => ReturnType<typeof createHotelState>
): SimulationSummary {
  const prng = new PRNG(seed);
  let state = createHotelState();

  // Default setup: build a small starter hotel
  if (setupFn) {
    state = setupFn(state, prng);
  } else {
    // Place 5 standard rooms, 3 deluxe, 1 suite
    const placements: Array<[string, number, number]> = [
      ['standard', 0, 0], ['standard', 1, 0], ['standard', 2, 0],
      ['standard', 3, 0], ['standard', 4, 0],
      ['deluxe', 0, 1], ['deluxe', 1, 1], ['deluxe', 2, 1],
      ['suite', 0, 2],
    ];
    for (const [type, x, y] of placements) {
      const result = addRoom(state, type as 'standard' | 'deluxe' | 'suite', x, y);
      if (result) state = result;
    }
  }

  const reviewScoreHistory: number[] = [];
  let wentBankrupt = false;
  const totalHours = days * 24;

  for (let tick = 0; tick < totalHours; tick++) {
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
  };
}

// CLI runner: run when executed directly
const isMainModule = typeof process !== 'undefined'
  && process.argv[1]
  && (process.argv[1].endsWith('simulate.ts') || process.argv[1].endsWith('simulate.js'));

if (isMainModule) {
  console.log('Running 100 simulations (30 days each)...\n');

  const results: SimulationSummary[] = [];
  for (let i = 0; i < 100; i++) {
    results.push(simulate(30, i));
  }

  const bankruptcies = results.filter(r => r.wentBankrupt).length;
  const avgCash = results.reduce((s, r) => s + r.finalCash, 0) / results.length;
  const avgReview = results.reduce((s, r) => s + r.avgReviewScore, 0) / results.length;
  const avgRevenue = results.reduce((s, r) => s + r.totalRevenue, 0) / results.length;
  const avgTurnedAway = results.reduce((s, r) => s + r.totalTurnedAway, 0) / results.length;

  // Star rating distribution
  const starCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of results) starCounts[r.finalStarRating]++;

  console.log('=== Balance Report (100 runs x 30 days) ===');
  console.log(`Bankruptcies:     ${bankruptcies}/100 (${bankruptcies}%)`);
  console.log(`Avg final cash:   $${avgCash.toFixed(0)}`);
  console.log(`Avg review score: ${avgReview.toFixed(2)} / 10`);
  console.log(`Avg revenue:      $${avgRevenue.toFixed(0)}`);
  console.log(`Avg turned away:  ${avgTurnedAway.toFixed(1)} guests`);
  console.log();

  console.log('Star rating distribution:');
  for (let s = 1; s <= 5; s++) {
    console.log(`  ${s}-star: ${starCounts[s]}%`);
  }

  // Cash distribution
  const cashBuckets = { negative: 0, low: 0, mid: 0, high: 0 };
  for (const r of results) {
    if (r.finalCash < 0) cashBuckets.negative++;
    else if (r.finalCash < 50000) cashBuckets.low++;
    else if (r.finalCash < 100000) cashBuckets.mid++;
    else cashBuckets.high++;
  }
  console.log('\nCash distribution:');
  console.log(`  Negative: ${cashBuckets.negative}%`);
  console.log(`  $0-50k:   ${cashBuckets.low}%`);
  console.log(`  $50k-100k: ${cashBuckets.mid}%`);
  console.log(`  $100k+:   ${cashBuckets.high}%`);

  // Review score distribution (0-10 scale)
  const reviewBuckets = { terrible: 0, poor: 0, average: 0, good: 0, excellent: 0 };
  for (const r of results) {
    if (r.avgReviewScore < 3) reviewBuckets.terrible++;
    else if (r.avgReviewScore < 5) reviewBuckets.poor++;
    else if (r.avgReviewScore < 7) reviewBuckets.average++;
    else if (r.avgReviewScore < 8.5) reviewBuckets.good++;
    else reviewBuckets.excellent++;
  }
  console.log('\nReview score distribution:');
  console.log(`  < 3.0:     ${reviewBuckets.terrible}%`);
  console.log(`  3.0-5.0:   ${reviewBuckets.poor}%`);
  console.log(`  5.0-7.0:   ${reviewBuckets.average}%`);
  console.log(`  7.0-8.5:   ${reviewBuckets.good}%`);
  console.log(`  8.5+:      ${reviewBuckets.excellent}%`);
}
