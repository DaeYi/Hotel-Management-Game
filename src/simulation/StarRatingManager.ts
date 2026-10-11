import type { HotelState, RoomType, Room, Party } from './types.js';
import { profileRoom, classPriceFactor, partyPriceFactor } from './RoomProfile.js';
import { STAR_RATING, AMENITIES, FACILITY_CONFIG, ROOM_CONFIG, FACILITY_LEVELS, FLOORS } from '../config/balance.js';
import { getDecorStarPenalty } from './DecorManager.js';
import { getOpenFacilities } from './Layout.js';

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

  // Building facilities (gym, restaurant, pool, shop): each type counts once,
  // at its best-upgraded instance that guests can get into
  const bestLevel = new Map<string, number>();
  for (const facility of getOpenFacilities(state)) {
    bestLevel.set(facility.type, Math.max(bestLevel.get(facility.type) ?? 0, facility.level));
  }
  for (const [type, level] of bestLevel) {
    const fConfig = FACILITY_CONFIG[type];
    if (fConfig) {
      points += fConfig.starPoints * FACILITY_LEVELS[level - 1].starMult;
    }
  }

  // Stale decor costs points (renovate to recover them)
  points -= getDecorStarPenalty(state);

  return points;
}

/**
 * Calculate the hotel's star classification (1-5 stars).
 * Based on what the hotel HAS: room types, services, amenities.
 * This is structural, not experiential. A dirty 5-star hotel is still 5 stars.
 */
export function calculateStarRating(state: HotelState): number {
  return starsForPoints(calculateStarPoints(state));
}

/** Convert raw star points to a 1-5 star level using STAR_RATING.pointThresholds. */
export function starsForPoints(points: number): number {
  let stars = 1;
  STAR_RATING.pointThresholds.forEach((threshold, i) => {
    if (points >= threshold) stars = i + 1;
  });
  return stars;
}

/** Star points needed to reach a given star level (1-5). */
export function pointsForStars(stars: number): number {
  return STAR_RATING.pointThresholds[Math.max(1, Math.min(5, stars)) - 1];
}

/**
 * What guests consider a fair nightly price for a particular room: its
 * category's (getExpectedPrice), adjusted for who it fits -- a twin or a
 * family room is worth more than a double, a single less. Exactly the
 * category's price for every room furnished like an original type.
 */
export function getRoomExpectedPrice(room: Pick<Room, 'type' | 'furnishing' | 'floor'>, starRating: number): number {
  const profile = profileRoom(room);
  const base = getExpectedPrice(profile.type, starRating, room.floor);
  const factor = classPriceFactor(profile);
  return factor === 1 ? base : Math.round(base * factor);
}

/**
 * What a room is worth a night to a particular party (partyPriceFactor): its
 * fair price, but no more than for the kind of room they need. Exactly
 * getRoomExpectedPrice for a party the room is sized for.
 */
export function getPartyFairPrice(room: Pick<Room, 'type' | 'furnishing' | 'floor'>, party: Party, starRating: number): number {
  const profile = profileRoom(room);
  const base = getExpectedPrice(profile.type, starRating, room.floor);
  const factor = partyPriceFactor(profile, party);
  return factor === 1 ? base : Math.round(base * factor);
}

/** What guests consider a fair nightly price for a room type at a given star level, with a view premium for higher floors. */
export function getExpectedPrice(type: RoomType, starRating: number, floor = 0): number {
  const viewPremium = 1 + FLOORS.viewPremiumPerFloor * floor;
  return Math.round(ROOM_CONFIG[type].expectedPrice * getPriceMultiplier(starRating) * viewPremium);
}

export function getPriceMultiplier(starRating: number): number {
  return STAR_RATING.priceMultiplier[starRating] ?? 1.0;
}

export function getUpkeepMultiplier(starRating: number): number {
  return STAR_RATING.upkeepMultiplier[starRating] ?? 1.0;
}

export function getStarDemandMultiplier(starRating: number): number {
  return STAR_RATING.demandMultiplier[starRating] ?? 1.0;
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
    const requiredPoints = pointsForStars(target);
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
        // Suites unlock at 3 stars, so only suggest them when aiming past that.
        if (target >= 4 && neededSuitePct > suitePct && neededSuitePct <= 1) {
          hints.push(`Add more suites (need ${Math.round(neededSuitePct * 100)}%+)`);
        }
        // else: room mix alone can't reach this star even at 100% suites —
        // fall through silently, the other hint types below still apply.
      }
    }
  }
  if (getDecorStarPenalty(state) > 0) {
    hints.push('Renovate stale rooms and facilities');
  }

  // Hints only point at things that are already unlocked on the way to `target`
  // (see requiredStars in balance.ts), so a 1-star hotel is never told to build a pool.
  if (target >= 2 && state.housekeeping.turnoverQuality !== 'thorough') {
    hints.push('Upgrade turnover cleaning to thorough');
  }
  if (target >= 2 && state.housekeeping.dailyCadence !== 'daily') {
    hints.push('Switch to daily housekeeping');
  }
  if (target >= 2 && total < STAR_RATING.roomCountThresholds.medium) {
    hints.push(`Build at least ${STAR_RATING.roomCountThresholds.medium} rooms`);
  } else if (target >= 4 && total < STAR_RATING.roomCountThresholds.large) {
    hints.push(`Build at least ${STAR_RATING.roomCountThresholds.large} rooms`);
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

  // Facility suggestions, each only once it's unlocked (one star below target)
  const facilityTypes = new Set<string>(state.facilities.map(f => f.type));
  for (const [type, fConfig] of Object.entries(FACILITY_CONFIG)) {
    if (target > fConfig.requiredStars && !facilityTypes.has(type)) {
      hints.push(`Build a ${fConfig.label.toLowerCase()}`);
    }
  }

  return hints.length > 0 ? hints.join('; ') : 'Maximize all room and service quality';
}
