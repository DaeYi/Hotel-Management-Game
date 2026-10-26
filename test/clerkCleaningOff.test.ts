import { afterEach, expect, it } from 'vitest';
import { FRONT_DESK_STAFF, STAFF_CLEANING_SUPPORT, STAFF_CROSS_TRAINING, STAFF_FATIGUE, STAFF_HOSPITALITY, STAFF_PERSONALITIES, STAFF_SPECIALTIES } from '../src/config/staff.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { hourStart } from '../src/simulation/Movement.js';
import type { HotelState, SimulationSummary } from '../src/simulation/types.js';

const switches = [STAFF_CLEANING_SUPPORT, STAFF_CROSS_TRAINING, STAFF_PERSONALITIES, FRONT_DESK_STAFF, STAFF_FATIGUE, STAFF_HOSPITALITY, STAFF_SPECIALTIES];
const original = switches.map(setting => setting.enabled);
afterEach(() => { switches.forEach((setting, index) => { setting.enabled = original[index]; }); });

/** A seeded run, with the hours trained housekeepers spent at reception and clerks spent in rooms. */
function run(strategy: string, days: number, seed: number) {
  let receptionHelp = 0, clerkCleaning = 0;
  const result = simulate(days, seed, undefined, (state: HotelState) => {
    const T = hourStart(state), plan = state.staffPlan;
    if (plan?.start === T) for (const itinerary of plan.itineraries) {
      const role = state.staffRoster?.find(member => member.id === itinerary.staffId)?.role;
      for (const leg of itinerary.legs) {
        const hours = leg.kind === 'stay' ? Math.max(0, Math.min(T + 1, leg.end) - Math.max(T, leg.start)) : 0;
        if (role === 'housekeeper' && leg.kind === 'stay' && leg.activity === 'desk') receptionHelp += hours;
        if (role === 'front_desk' && leg.kind === 'stay' && leg.activity === 'clean') clerkCleaning += hours;
      }
    }
    return STRATEGIES[strategy](state);
  });
  return { result, receptionHelp, clerkCleaning };
}

function expectMain(result: SimulationSummary, main: Partial<SimulationSummary>): void {
  expect(result.finalValuation).toBeCloseTo(main.finalValuation!, 8);
  expect(result.finalCash).toBeCloseTo(main.finalCash!, 8);
  expect(result.totalRevenue).toBe(main.totalRevenue);
  expect(result.avgReviewScore).toBeCloseTo(main.avgReviewScore!, 10);
  expect(result.finalRoomCount).toBe(main.finalRoomCount);
  expect(result.finalStarRating).toBe(main.finalStarRating);
  expect(result.objectivesCompleted).toBe(main.objectivesCompleted);
  expect(result.objectivesFailed).toBe(0);
  expect(result.totalTurnedAway).toBe(main.totalTurnedAway);
  expect(result.wentBankrupt).toBe(false);
  expect(result.loanBalance).toBeCloseTo(main.loanBalance!, 8);
}

// Golden summaries measured on main a9f3a36 with its default switches:
// reception-trained housekeepers, fatigue and every other named-staff feature
// on. Only the clerk cleaning slice is off here, so the game must match.

it('with only clerk cleaning disabled reproduces main where the slice would act', () => {
  for (const setting of switches) setting.enabled = true;
  // With the slice on, this run's trained clerks clean rooms and change the result.
  const on = run('balanced', 120, 12);
  expect(on.clerkCleaning).toBeGreaterThan(0);
  expect(on.result.finalValuation).not.toBe(1029794.8836756976);
  STAFF_CLEANING_SUPPORT.enabled = false;
  const off = run('balanced', 120, 12);
  expect(off.clerkCleaning).toBe(0);
  expectMain(off.result, { finalValuation: 1029794.8836756976, finalCash: 28506.162107050543, totalRevenue: 350356,
    avgReviewScore: 7.878246818893517, finalRoomCount: 30, finalStarRating: 3, objectivesCompleted: 6,
    totalTurnedAway: 1412, loanBalance: 25583.77843135322 });
}, 120000); // Two 120-day simulations take about four seconds locally; the CI runner is roughly twice as slow.

it('with only clerk cleaning disabled reproduces main’s reception-trained housekeepers', () => {
  for (const setting of switches) setting.enabled = true;
  STAFF_CLEANING_SUPPORT.enabled = false;
  const off = run('overstaffed', 220, 3);
  // Trained housekeepers cover reception on several afternoons of this run.
  expect(off.receptionHelp).toBeGreaterThan(0);
  expectMain(off.result, { finalValuation: 1473838.182279008, finalCash: 38178.28227900766, totalRevenue: 870298,
    avgReviewScore: 7.910384763151293, finalRoomCount: 42, finalStarRating: 3, objectivesCompleted: 7,
    totalTurnedAway: 2896, loanBalance: 0 });
}, 120000); // A 220-day simulation takes about four seconds locally; the CI runner is roughly twice as slow.
