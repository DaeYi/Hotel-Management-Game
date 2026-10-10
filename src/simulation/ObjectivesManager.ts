import type { HotelState, GameEvent, DailyStat } from './types.js';
import { OBJECTIVES, DAILY_STATS_MAX_DAYS } from '../config/balance.js';
import type { ObjectiveConfig } from '../config/balance.js';
import { getOccupancyRate } from './HotelState.js';

export interface ObjectiveStatus {
  current: number; // the measured value, in the objective's own units
  target: number;
  fraction: number; // 0-1 progress toward target, for progress bars
  complete: boolean;
}

/** The objective the player is currently working on, or null once all are resolved. */
export function getCurrentObjective(state: HotelState): ObjectiveConfig | null {
  return OBJECTIVES[state.objectives.currentIndex] ?? null;
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
      // Progress is the share of the original loan repaid
      current = state.loan.balance;
      target = 0;
      complete = state.loan.balance <= 0;
      return { current, target, fraction: complete ? 1 : 0, complete };
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
  if (!objective) return { state, events: [] };

  const status = evaluateObjective(state, objective);
  const failed = !status.complete && state.day > objective.deadlineDay;
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
        message: `Goal complete: ${objective.title} (+$${objective.reward.toLocaleString()})`,
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

/** Append an end-of-day snapshot. Call once per day, after the day's last tick of activity. */
export function recordDailyStat(state: HotelState): HotelState {
  const stat: DailyStat = {
    day: state.day,
    occupancy: getOccupancyRate(state),
    totalRevenue: state.totalRevenue,
  };
  return { ...state, dailyStats: [...state.dailyStats, stat].slice(-DAILY_STATS_MAX_DAYS) };
}
