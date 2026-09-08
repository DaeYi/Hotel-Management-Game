import type { HotelState, RoomType } from './types.js';
import { STAR_RATING, AMENITIES, FACILITY_CONFIG } from '../config/balance.js';

/**
 * Accumulate the hotel's raw star points from everything it has: room type
 * mix, housekeeping quality, room count, amenity tiers, and facilities.
 * Shared by calculateStarRating (converts to 1-5 stars) and
 * getNextStarRequirements (derives hint thresholds from the same numbers) so
 * the two can never independently drift out of sync with each other.
 */
export function calculateStarPoints(state: HotelState): number {
  if (state.rooms.length === 0) return 0;

  let points = 0;

  // Room type mix: suites and deluxe rooms push star rating up
  const roomCounts = { standard: 0, deluxe: 0, suite: 0 };
  for (const room of state.rooms) {
    roomCounts[room.type]++;
  }
  const total = state.rooms.length;

  const deluxePct = (roomCounts.deluxe + roomCounts.suite) / total;
  const suitePct = roomCounts.suite / total;

  points += deluxePct * STAR_RATING.deluxeRatioPoints;  // up to 2 points
  points += suitePct * STAR_RATING.suiteRatioPoints;    // up to 2 points

  // Housekeeping quality
  const hkPoints = STAR_RATING.housekeepingPoints[state.housekeeping.turnoverQuality] ?? 0;
  points += hkPoints;

  const cadencePoints = STAR_RATING.cadencePoints[state.housekeeping.dailyCadence] ?? 0;
  points += cadencePoints;

  // Room count bonus: larger hotels get a small boost
  if (total >= STAR_RATING.roomCountThresholds.medium) points += 0.5;
  if (total >= STAR_RATING.roomCountThresholds.large) points += 0.5;

  // In-room amenity quality contributes to star rating
  // Weighted by room count: more rooms at a tier = more impact
  for (const [roomType, tier] of Object.entries(state.amenities)) {
    const count = roomCounts[roomType as keyof typeof roomCounts] ?? 0;
    if (count === 0) continue;
    const tierConfig = AMENITIES.tiers[tier];
    if (tierConfig) {
      points += tierConfig.starPoints * (count / total);
    }
  }

  // Building facilities (gym, restaurant, pool, shop)
  const seenFacilityTypes = new Set<string>();
  for (const facility of state.facilities) {
    if (seenFacilityTypes.has(facility.type)) continue; // only count each type once
    seenFacilityTypes.add(facility.type);
    const fConfig = FACILITY_CONFIG[facility.type];
    if (fConfig) {
      points += fConfig.starPoints;
    }
  }

  return points;
}

/**
 * Calculate the hotel's star classification (1-5 stars).
 * Based on what the hotel HAS: room types, services, amenities.
 * This is structural, not experiential. A dirty 5-star hotel is still 5 stars.
 */
export function calculateStarRating(state: HotelState): number {
  const points = calculateStarPoints(state);
  return Math.max(1, Math.min(5, Math.floor(points) + 1));
}

/**
 * Get the expectation multiplier for a given star rating.
 * Higher star hotels have higher guest expectations, meaning the same
 * service quality produces lower review scores at a 5-star vs a 2-star.
 */
export function getExpectationMultiplier(starRating: number): number {
  return STAR_RATING.expectationMultiplier[starRating] ?? 1.0;
}

/**
 * Get a description of what's needed to reach the next star level.
 */
export function getNextStarRequirements(state: HotelState): string | null {
  const current = calculateStarRating(state);
  if (current >= 5) return null;

  const target = current + 1;
  const hints: string[] = [];

  const roomCounts = { standard: 0, deluxe: 0, suite: 0 };
  for (const room of state.rooms) {
    roomCounts[room.type]++;
  }
  const total = state.rooms.length || 1;
  const deluxePct = (roomCounts.deluxe + roomCounts.suite) / total;
  const suitePct = roomCounts.suite / total;

  // Derive the deluxe/suite mix needed for the next star from the same points
  // calculateStarRating uses, instead of hardcoded percentages that could
  // silently drift out of sync with the real formula.
  //
  // Approximation: this holds every other point contributor constant while
  // solving for deluxePct/suitePct. That's not exactly right when amenity
  // tiers differ per room type (the amenity term is itself weighted by
  // room-type count, which shifts as the mix shifts) — accepted as good
  // enough for a hint string; see TODOS.md "exact numeric-search star-rating
  // hint" for the fully-precise alternative.
  if (target >= 3) {
    const requiredPoints = target - 1;
    const otherPoints = calculateStarPoints(state)
      - (deluxePct * STAR_RATING.deluxeRatioPoints + suitePct * STAR_RATING.suiteRatioPoints);
    const neededDeluxePct = (requiredPoints - otherPoints - suitePct * STAR_RATING.suiteRatioPoints)
      / STAR_RATING.deluxeRatioPoints;

    if (neededDeluxePct > deluxePct) {
      if (neededDeluxePct <= 1) {
        hints.push(`Add more deluxe/suite rooms (need ${Math.round(neededDeluxePct * 100)}%+)`);
      } else {
        const neededSuitePct = (requiredPoints - otherPoints - deluxePct * STAR_RATING.deluxeRatioPoints)
          / STAR_RATING.suiteRatioPoints;
        if (neededSuitePct > suitePct && neededSuitePct <= 1) {
          hints.push(`Add more suites (need ${Math.round(neededSuitePct * 100)}%+)`);
        }
        // else: room mix alone can't reach this star even at 100% suites —
        // fall through silently, the other hint types below still apply.
      }
    }
  }
  if (target >= 3 && state.housekeeping.turnoverQuality === 'quick') {
    hints.push('Upgrade turnover cleaning to standard or thorough');
  }
  if (target >= 4 && state.housekeeping.dailyCadence !== 'daily') {
    hints.push('Switch to daily housekeeping');
  }
  if (target >= 3 && total < STAR_RATING.roomCountThresholds.medium) {
    hints.push(`Build at least ${STAR_RATING.roomCountThresholds.medium} rooms`);
  }

  // Amenity tier upgrades
  const tierOrder = ['basic', 'premium', 'luxury'];
  for (const [roomType, tier] of Object.entries(state.amenities)) {
    const tierIdx = tierOrder.indexOf(tier);
    if (target >= 4 && tierIdx < 1) {
      hints.push(`Upgrade ${roomType} amenities to premium+`);
    }
    if (target >= 5 && tierIdx < 2) {
      hints.push(`Upgrade ${roomType} amenities to luxury`);
    }
  }

  // Facility suggestions
  const facilityTypes = new Set(state.facilities.map(f => f.type));
  if (target >= 3 && !facilityTypes.has('restaurant')) {
    hints.push('Build a restaurant');
  }
  if (target >= 4 && !facilityTypes.has('pool')) {
    hints.push('Build a pool');
  }
  if (target >= 3 && !facilityTypes.has('gym')) {
    hints.push('Build a gym');
  }

  return hints.length > 0 ? hints.join('; ') : 'Maximize all room and service quality';
}
