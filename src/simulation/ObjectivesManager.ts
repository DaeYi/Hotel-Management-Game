import type { HotelState, GameEvent, DailyStat } from './types.js';
import { OBJECTIVES, DAILY_STATS_MAX_DAYS, LEGACY, ROOM_CONFIG, FACILITY_CONFIG, FACILITY_LEVELS, VALUATION, ELEVATOR } from '../config/balance.js';
import type { ObjectiveConfig } from '../config/balance.js';
import { getOccupancyRate, getFloorsBuildCost } from './HotelState.js';

export interface ObjectiveStatus {
  current: number; // the measured value, in the objective's own units
  target: number;
  fraction: number; // 0-1 progress toward target, for progress bars
  complete: boolean;
}

/** The objective the player is currently working on: an owner goal, then endless legacy goals. */
export function getCurrentObjective(state: HotelState): ObjectiveConfig {
  const index = state.objectives.currentIndex;
  return OBJECTIVES[index] ?? getLegacyObjective(index - OBJECTIVES.length);
}

/** Whether the player has moved past the fixed owner goals into legacy goals. */
export function isLegacyPhase(state: HotelState): boolean {
  return state.objectives.currentIndex >= OBJECTIVES.length;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * The nth legacy goal (0-based). Cycles valuation -> five-star streak ->
 * occupancy -> reviews, each cycle (tier) asking for more. No deadline, no reward.
 */
export function getLegacyObjective(n: number): ObjectiveConfig {
  const tier = Math.floor(n / 4);
  const tierLabel = ROMAN[tier] ?? String(tier + 1);
  const base = { id: `legacy_${n}`, deadlineDay: null, reward: 0 };

  switch (n % 4) {
    case 0: {
      const target = LEGACY.valuationBase * 2 ** tier;
      return { ...base, title: `Legacy ${tierLabel}: Empire`, description: `Reach a $${(target / 1_000_000).toLocaleString()}M valuation`, kind: 'valuation', target };
    }
    case 1: {
      const target = LEGACY.fiveStarDaysBase * (tier + 1);
      return { ...base, title: `Legacy ${tierLabel}: Consistency`, description: `Hold 5 stars for ${target} days straight`, kind: 'five_star_days', target };
    }
    case 2: {
      const target = Math.min(LEGACY.occupancyCap, LEGACY.occupancyBase + 0.05 * tier);
      return { ...base, title: `Legacy ${tierLabel}: Booked Solid`, description: `Average ${Math.round(target * 100)}% occupancy over 30 days`, kind: 'occupancy_30d', target };
    }
    default: {
      const target = Math.min(LEGACY.reviewCap, LEGACY.reviewBase + 0.3 * tier);
      return { ...base, title: `Legacy ${tierLabel}: Acclaim`, description: `Reach a ${target.toFixed(1)} review score`, kind: 'review_score', target };
    }
  }
}

/**
 * Hotel valuation: property at build cost (plus facility upgrade spend),
 * discounted for stale decor, plus a multiple of the last 30 days' revenue,
 * plus cash net of the loan. Reinvesting raises it; hoarding only holds it.
 */
export function calculateValuation(state: HotelState): number {
  const decorFactor = (decor: number) => VALUATION.minDecorFactor + (1 - VALUATION.minDecorFactor) * decor / 100;

  let property = 0;
  for (const room of state.rooms) {
    property += ROOM_CONFIG[room.type].buildCost * decorFactor(room.decor);
  }
  for (const facility of state.facilities) {
    const buildCost = FACILITY_CONFIG[facility.type].buildCost;
    const upgradeSpend = FACILITY_LEVELS.slice(1, facility.level).reduce((sum, l) => sum + l.upgradeCostRate, 0);
    property += buildCost * (1 + upgradeSpend) * decorFactor(facility.decor);
  }

  // The structure itself: floors above ground and elevator shafts, at build cost
  property += getFloorsBuildCost(state.floorCount) + state.elevators.length * ELEVATOR.buildCost;

  const business = getRecentRevenue(state, 30) * VALUATION.revenueMultiple;
  return property + business + state.cash - state.loan.balance;
}

/** Average overnight occupancy over the last `days` recorded days (fewer if not enough history yet). */
export function getAverageOccupancy(state: HotelState, days: number): number {
  const window = state.dailyStats.slice(-days);
  if (window.length === 0) return 0;
  return window.reduce((sum, s) => sum + s.occupancy, 0) / window.length;
}

/** Revenue earned over the last `days` days, from the cumulative totalRevenue snapshots. */
export function getRecentRevenue(state: HotelState, days: number): number {
  const stats = state.dailyStats;
  if (stats.length === 0) return 0;
  // Baseline is the snapshot just before the window; with less history, count from zero.
  const baseline = stats.length > days ? stats[stats.length - days - 1].totalRevenue : 0;
  return state.totalRevenue - baseline;
}

export function evaluateObjective(state: HotelState, objective: ObjectiveConfig): ObjectiveStatus {
  let current: number;
  let target = objective.target;
  let complete: boolean;

  switch (objective.kind) {
    case 'room_count':
      current = state.rooms.length;
      complete = current >= target;
      break;
    case 'occupancy_7d':
      // Needs a full week of history so a single busy night can't satisfy it
      current = getAverageOccupancy(state, 7);
      complete = state.dailyStats.length >= 7 && current >= target;
      break;
    case 'review_score':
      current = state.reviewScore;
      complete = state.bookings.length > 0 && current >= target;
      break;
    case 'star_rating':
      current = state.starRating;
      complete = current >= target;
      break;
    case 'revenue_30d':
      current = getRecentRevenue(state, 30);
      complete = current >= target;
      break;
    case 'loan_paid_off':
      current = state.loan.balance;
      target = 0;
      complete = state.loan.balance <= 0;
      return { current, target, fraction: complete ? 1 : 0, complete };
    case 'valuation':
      current = calculateValuation(state);
      complete = current >= target;
      break;
    case 'five_star_days':
      current = state.daysAtFiveStars;
      complete = current >= target;
      break;
    case 'occupancy_30d':
      // Needs a full 30 days of history, like occupancy_7d needs a week
      current = getAverageOccupancy(state, 30);
      complete = state.dailyStats.length >= 30 && current >= target;
      break;
  }

  const fraction = target > 0 ? Math.max(0, Math.min(1, current / target)) : 1;
  return { current, target, fraction, complete };
}

/**
 * Resolve the current objective: complete it (paying the reward) if its
 * condition holds, or fail it once its deadline day has passed. Resolves at
 * most one objective per call, so each gets its own event and the next
 * objective is checked fresh on the following tick.
 */
export function processObjectives(state: HotelState): { state: HotelState; events: GameEvent[] } {
  const objective = getCurrentObjective(state);
  const status = evaluateObjective(state, objective);
  const failed = !status.complete && objective.deadlineDay !== null && state.day > objective.deadlineDay;
  if (!status.complete && !failed) return { state, events: [] };

  const objectives = {
    currentIndex: state.objectives.currentIndex + 1,
    outcomes: [...state.objectives.outcomes, status.complete ? 'completed' as const : 'failed' as const],
  };

  if (status.complete) {
    return {
      state: { ...state, cash: state.cash + objective.reward, objectives },
      events: [{
        type: 'objective_completed',
        message: objective.reward > 0
          ? `Goal complete: ${objective.title} (+$${objective.reward.toLocaleString()})`
          : `Goal complete: ${objective.title}`,
        data: { objectiveId: objective.id, reward: objective.reward },
      }],
    };
  }

  return {
    state: { ...state, objectives },
    events: [{
      type: 'objective_failed',
      message: `Goal missed: ${objective.title}`,
      data: { objectiveId: objective.id },
    }],
  };
}

/** Append an end-of-day snapshot and update the five-star streak. Call once per day, after the day's last tick of activity. */
export function recordDailyStat(state: HotelState): HotelState {
  const stat: DailyStat = {
    day: state.day,
    occupancy: getOccupancyRate(state),
    totalRevenue: state.totalRevenue,
    valuation: calculateValuation(state),
  };
  return {
    ...state,
    dailyStats: [...state.dailyStats, stat].slice(-DAILY_STATS_MAX_DAYS),
    daysAtFiveStars: state.starRating >= 5 ? state.daysAtFiveStars + 1 : 0,
  };
}
