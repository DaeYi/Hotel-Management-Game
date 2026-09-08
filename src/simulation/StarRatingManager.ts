import type { HotelState, RoomType } from './types.js';
import { STAR_RATING, AMENITIES, FACILITY_CONFIG } from '../config/balance.js';

/**
 * Calculate the hotel's star classification (1-5 stars).
 * Based on what the hotel HAS: room types, services, amenities.
 * This is structural, not experiential. A dirty 5-star hotel is still 5 stars.
 */
export function calculateStarRating(state: HotelState): number {
  if (state.rooms.length === 0) return 1;

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

  // Convert points to 1-5 star scale
  const rawStars = Math.max(1, Math.min(5, Math.floor(points) + 1));
  return rawStars;
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

  if (target >= 3 && deluxePct < 0.3) {
    hints.push('Add more deluxe/suite rooms (need 30%+)');
  }
  if (target >= 4 && suitePct < 0.15) {
    hints.push('Add more suites (need 15%+)');
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
