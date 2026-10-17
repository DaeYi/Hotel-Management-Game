import type { HotelState, GameEvent } from './types.js';
import { SEASON } from '../config/balance.js';

/**
 * Get the current season name based on game day.
 * Year = 360 days. Spring starts day 1.
 */
export function getCurrentSeason(day: number): string {
  const dayOfYear = ((day - 1) % SEASON.yearLength);
  if (dayOfYear < SEASON.seasonLength) return 'spring';
  if (dayOfYear < SEASON.seasonLength * 2) return 'summer';
  if (dayOfYear < SEASON.seasonLength * 3) return 'autumn';
  return 'winter';
}

/**
 * Get the day of the week (0-6, where 0=Monday, 5=Saturday, 6=Sunday).
 */
export function getDayOfWeek(day: number): number {
  return (day - 1) % 7;
}

/**
 * Get the display name for the day of week.
 */
export function getDayOfWeekName(day: number): string {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return names[getDayOfWeek(day)];
}

/**
 * Get the demand multiplier for the current day.
 * Combines seasonal variation + day-of-week variation.
 * Returns a multiplier on base arrival rate (1.0 = normal).
 */
export function getDemandMultiplier(day: number): number {
  const season = getCurrentSeason(day);
  const seasonMult = SEASON.seasonDemand[season] ?? 1.0;

  const dow = getDayOfWeek(day);
  const isWeekend = dow >= 5; // Saturday or Sunday
  const isFriday = dow === 4;
  const dowMult = isWeekend ? SEASON.weekendDemand
    : isFriday ? SEASON.fridayDemand
    : SEASON.weekdayDemand;

  return seasonMult * dowMult;
}

/**
 * Check if a special event/holiday is happening.
 * Returns event name or null.
 */
export function getSpecialEvent(day: number): string | null {
  return getActiveEvent(day)?.name ?? null;
}

/** The active event and its absolute checkout day, including windows across New Year. */
export function getActiveEvent(day: number): { name: string; endDay: number } | null {
  for (const event of SEASON.specialEvents) {
    const elapsed = ((day - 1 - event.startDay) % SEASON.yearLength + SEASON.yearLength) % SEASON.yearLength;
    if (elapsed < event.duration) return { name: event.name, endDay: day + event.duration - elapsed };
  }
  return null;
}

/**
 * Get the demand multiplier including special events.
 */
export function getTotalDemandMultiplier(day: number): number {
  let mult = getDemandMultiplier(day);

  const event = getSpecialEvent(day);
  if (event) {
    const eventConfig = SEASON.specialEvents.find(e => e.name === event);
    if (eventConfig) {
      mult *= eventConfig.demandMultiplier;
    }
  }

  return mult;
}

/**
 * Check for season change events.
 */
export function checkSeasonChange(prevDay: number, currentDay: number): GameEvent | null {
  if (prevDay === currentDay) return null;

  const prevSeason = getCurrentSeason(prevDay);
  const currentSeason = getCurrentSeason(currentDay);

  if (prevSeason !== currentSeason) {
    const seasonName = currentSeason.charAt(0).toUpperCase() + currentSeason.slice(1);
    const mult = SEASON.seasonDemand[currentSeason] ?? 1.0;
    const trend = mult > 1 ? 'Demand increasing' : mult < 1 ? 'Demand decreasing' : 'Demand stable';
    return {
      type: 'season_changed',
      message: `${seasonName} has arrived! ${trend}.`,
      data: { season: currentSeason, demandMultiplier: mult },
    };
  }

  return null;
}

/**
 * Get season info for the UI.
 */
export function getSeasonInfo(day: number): {
  season: string;
  dayOfWeek: string;
  demandMultiplier: number;
  demandLabel: string;
  specialEvent: string | null;
  dayOfYear: number;
  yearNumber: number;
} {
  const season = getCurrentSeason(day);
  const dayOfWeek = getDayOfWeekName(day);
  const mult = getTotalDemandMultiplier(day);
  const specialEvent = getSpecialEvent(day);

  let demandLabel: string;
  if (mult >= 1.8) demandLabel = 'Very High';
  else if (mult >= 1.3) demandLabel = 'High';
  else if (mult >= 0.9) demandLabel = 'Normal';
  else if (mult >= 0.6) demandLabel = 'Low';
  else demandLabel = 'Very Low';

  return {
    season,
    dayOfWeek,
    demandMultiplier: mult,
    demandLabel,
    specialEvent,
    dayOfYear: ((day - 1) % SEASON.yearLength) + 1,
    yearNumber: Math.floor((day - 1) / SEASON.yearLength) + 1,
  };
}
