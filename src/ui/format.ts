import type { HotelState } from '../simulation/types';
import type { ObjectiveConfig } from '../config/balance';
import { evaluateObjective } from '../simulation/ObjectivesManager';

/** Whole dollars with separators: $12,345. */
export function formatMoney(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

/** Compact money for tight spaces: $950k, $1.25M. */
export function formatMoneyShort(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `$${Math.round(n / 1000)}k`;
  return formatMoney(n);
}

/** Staff walking time: "12 min", or a warning when there's no route. */
export function formatWalk(hours: number): string {
  return Number.isFinite(hours) ? `${Math.round(hours * 60)} min` : "can't reach!";
}

/** Filled and empty stars for a 1-5 rating. */
export function formatStars(stars: number): string {
  return '★'.repeat(stars) + '☆'.repeat(5 - stars);
}

/** A 10-segment bar for a 0-100 value. */
export function formatBar(value: number): string {
  const filled = Math.round(value / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Human-readable "current / target" for an objective. */
export function formatObjectiveProgress(state: HotelState, objective: ObjectiveConfig): string {
  const { current, target } = evaluateObjective(state, objective);
  switch (objective.kind) {
    case 'room_count': return `${current} / ${target} rooms`;
    case 'occupancy_7d': return `${Math.round(current * 100)}% / ${Math.round(target * 100)}% (7-day)`;
    case 'review_score': return `${current.toFixed(1)} / ${target.toFixed(1)} review`;
    case 'star_rating': return `${current}★ / ${target}★`;
    case 'revenue_30d': return `${formatMoney(current)} / ${formatMoney(target)}`;
    case 'loan_paid_off': return `${formatMoney(current)} owed`;
    case 'valuation': return `${formatMoneyShort(current)} / ${formatMoneyShort(target)} value`;
    case 'five_star_days': return `${current} / ${target} days at 5★`;
    case 'occupancy_30d': return `${Math.round(current * 100)}% / ${Math.round(target * 100)}% (30-day)`;
  }
}
