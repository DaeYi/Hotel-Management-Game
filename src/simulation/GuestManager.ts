import type { Guest, GuestTrait, Room, HotelState, Booking, GameEvent, ReturningGuestProfile } from './types.js';
import type { PRNG } from './prng.js';
import { ECONOMY, GUEST_TRAITS, REVIEW, HOUSEKEEPING, STAFF, AMENITIES, FACILITY_CONFIG, FACILITY_LEVELS, GUEST_NAMES, SATISFACTION, STORY } from '../config/balance.js';
import { getDecorReviewPenalty } from './DecorManager.js';
import { getCampaignDemandMultiplier } from './MarketingManager.js';
import { getAvailableRooms, getAdjacentFacilities, getElevatorWaitPenalty } from './HotelState.js';
import { calculateRoomNoise, noiseToRatingPenalty } from './NoiseManager.js';
import { getExpectationMultiplier, getExpectedPrice, getPriceMultiplier, getStarDemandMultiplier } from './StarRatingManager.js';
import { getTotalDemandMultiplier, getCurrentSeason } from './SeasonManager.js';
import { getReputationPenaltyMultiplier } from './StoryGenerator.js';

export function generateGuestTrait(prng: PRNG): GuestTrait {
  const roll = prng.next();
  if (roll < GUEST_TRAITS.lightSleeperChance) return 'light_sleeper';
  if (roll < GUEST_TRAITS.lightSleeperChance + GUEST_TRAITS.bigSpenderChance) return 'big_spender';
  if (roll < GUEST_TRAITS.lightSleeperChance + GUEST_TRAITS.bigSpenderChance + GUEST_TRAITS.partyGuestChance) return 'party_guest';
  return 'normal';
}

function generateGuestName(prng: PRNG): string {
  return GUEST_NAMES[Math.floor(prng.next() * GUEST_NAMES.length)];
}

/** A guest's nightly budget: a higher-star hotel attracts wealthier guests. */
function generateBudget(prng: PRNG, starRating: number): number {
  return prng.range(ECONOMY.guestMinBudget, ECONOMY.guestMaxBudget) * getPriceMultiplier(starRating);
}

function generateFreshGuest(prng: PRNG, day: number, starRating: number): Guest {
  const trait = generateGuestTrait(prng);
  let budget = generateBudget(prng, starRating);
  if (trait === 'big_spender') {
    budget *= GUEST_TRAITS.bigSpenderBudgetMult;
  }

  return {
    id: `guest-${day}-${Math.floor(prng.next() * 100000)}`,
    name: generateGuestName(prng),
    budget,
    stayLength: prng.int(ECONOMY.guestMinStay, ECONOMY.guestMaxStay),
    trait,
    satisfaction: SATISFACTION.initial,
    checkInDay: day,
    isReturning: false,
    hadNoiseComplaint: false,
  };
}

/** A guest pulled from returningGuestPool: same name/trait as their prior stay (design-review D7). */
function generateReturningGuest(profile: ReturningGuestProfile, prng: PRNG, day: number, starRating: number): Guest {
  let budget = generateBudget(prng, starRating);
  if (profile.trait === 'big_spender') {
    budget *= GUEST_TRAITS.bigSpenderBudgetMult;
  }

  return {
    id: `guest-${day}-${Math.floor(prng.next() * 100000)}`,
    name: profile.name,
    budget,
    stayLength: prng.int(ECONOMY.guestMinStay, ECONOMY.guestMaxStay),
    trait: profile.trait,
    satisfaction: SATISFACTION.initial,
    checkInDay: day,
    isReturning: true,
    hadNoiseComplaint: false,
  };
}

/**
 * Rolling word-of-mouth arrival multiplier, driven by satisfaction at checkout
 * (Satisfaction System Design, point 4). Mirrors updateReviewScore's window and
 * cold-start handling; floor/ceiling per eng-review D11 so this doesn't compound
 * unboundedly with reviewScore's own arrival penalty on the same walkouts.
 */
export function getWordOfMouthMultiplier(state: HotelState): number {
  if (state.bookings.length === 0) return 1.0;
  const recent = state.bookings.slice(-REVIEW.reviewWindowBookingCount);
  if (recent.length === 0) return 1.0;

  const avgSatisfaction = recent.reduce((sum, b) => sum + b.satisfactionAtCheckout, 0) / recent.length;
  const normalized = (avgSatisfaction - SATISFACTION.initial) / SATISFACTION.initial; // roughly -1..+1
  const raw = 1.0 + normalized * (STORY.wordOfMouthCeilingMultiplier - 1.0);
  return Math.max(STORY.wordOfMouthFloorMultiplier, Math.min(STORY.wordOfMouthCeilingMultiplier, raw));
}

/**
 * Expected guest arrivals for the current day: a base market plus hotel
 * visibility (room count), scaled by star rating, review score, season/weekday
 * demand, word-of-mouth, and any active reputation penalty.
 */
export function getExpectedArrivalsPerDay(state: HotelState): number {
  const market = ECONOMY.baseArrivalsPerDay + ECONOMY.arrivalsPerRoom * state.rooms.length;
  return market
    * getStarDemandMultiplier(state.starRating)
    * (state.reviewScore / REVIEW.arrivalScoreDivisor)
    * getTotalDemandMultiplier(state.day)
    * getWordOfMouthMultiplier(state)
    * getReputationPenaltyMultiplier(state)
    * getCampaignDemandMultiplier(state);
}

/**
 * Cheapest available room the guest can afford and considers worth the price:
 * within their budget, and no more than `priceTolerance` x the fair price for
 * that room type at the hotel's current star level.
 */
function matchGuestToRoom(guest: Guest, availableRooms: Room[], priceTolerance: number, starRating: number): Room | null {
  for (const room of availableRooms) {
    const fairPrice = getExpectedPrice(room.type, starRating, room.floor);
    if (room.pricePerNight <= guest.budget && room.pricePerNight <= fairPrice * priceTolerance) {
      return room;
    }
  }
  return null;
}

export interface ArrivalResult {
  checkedIn: Array<{ guest: Guest; roomId: string }>;
  turnedAway: number;
  events: GameEvent[];
  returningGuestPool: ReturningGuestProfile[]; // after any pulls this hour
}

export function processArrivals(
  state: HotelState,
  hour: number,
  prng: PRNG
): ArrivalResult {
  const result: ArrivalResult = { checkedIn: [], turnedAway: 0, events: [], returningGuestPool: state.returningGuestPool };

  if (hour < ECONOMY.checkInStartHour || hour >= ECONOMY.checkInEndHour) {
    return result;
  }

  const hoursInWindow = ECONOMY.checkInEndHour - ECONOMY.checkInStartHour;
  const arrivalsThisHour = getExpectedArrivalsPerDay(state) / hoursInWindow;

  const guaranteed = Math.floor(arrivalsThisHour);
  const extra = prng.chance(arrivalsThisHour - guaranteed) ? 1 : 0;
  const totalArrivals = guaranteed + extra;

  // Front desk capacity limits how many guests can actually check in this hour
  const frontDeskWorkers = state.staff.frontDesk;
  const checkInCapacity = frontDeskWorkers > 0
    ? frontDeskWorkers * STAFF.frontDesk.checkInsPerHour
    : STAFF.frontDesk.selfServiceCapacity; // kiosk fallback

  const available = getAvailableRooms(state);
  let availableIdx = 0;
  let checkedInThisHour = 0;
  let pool = [...state.returningGuestPool];

  for (let i = 0; i < totalArrivals; i++) {
    let guest: Guest;
    if (pool.length > 0 && prng.chance(STORY.returningGuestPullChance)) {
      const idx = Math.floor(prng.next() * pool.length);
      const profile = pool[idx];
      pool = [...pool.slice(0, idx), ...pool.slice(idx + 1)];
      guest = generateReturningGuest(profile, prng, state.day, state.starRating);
    } else {
      guest = generateFreshGuest(prng, state.day, state.starRating);
    }

    // Front desk at capacity: guest leaves impatiently
    if (checkedInThisHour >= checkInCapacity) {
      result.turnedAway++;
      result.events.push({
        type: 'guest_impatient',
        message: 'Guest left (front desk too busy)',
        data: { reason: 'front_desk_capacity' },
      });
      continue;
    }

    const remainingRooms = available.slice(availableIdx);
    const priceTolerance = 1 + prng.next() * ECONOMY.priceToleranceSpread;
    const room = matchGuestToRoom(guest, remainingRooms, priceTolerance, state.starRating);

    if (room) {
      const roomIdx = available.indexOf(room);
      availableIdx = roomIdx + 1;
      checkedInThisHour++;
      result.checkedIn.push({ guest, roomId: room.id });
      result.events.push({
        type: 'guest_arrived',
        message: `Guest checked into ${room.type} room`,
        data: { guestId: guest.id, roomId: room.id, trait: guest.trait },
      });
      if (guest.isReturning) {
        result.events.push({
          type: 'guest_returned',
          message: `${guest.name} is back for another stay!`,
          data: { guestId: guest.id, roomId: room.id },
        });
      }
    } else {
      result.turnedAway++;
      result.events.push({
        type: 'guest_turned_away',
        message: 'Guest turned away (no room at a price they would pay)',
      });
    }
  }

  result.returningGuestPool = pool;
  return result;
}

export interface DepartureResult {
  departed: Array<{ guest: Guest; roomId: string; booking: Booking; breakdown: GuestReviewBreakdown }>;
  events: GameEvent[];
  returningGuestPool: ReturningGuestProfile[];
}

export function processDepartures(
  state: HotelState,
  prng: PRNG
): DepartureResult {
  const result: DepartureResult = { departed: [], events: [], returningGuestPool: state.returningGuestPool };
  let pool = [...state.returningGuestPool];

  for (const guest of state.guests) {
    const daysStayed = state.day - guest.checkInDay;
    if (daysStayed >= guest.stayLength) {
      const room = state.rooms.find(r => r.status === 'occupied' && r.guestId === guest.id);
      if (!room) continue;

      const breakdown = calculateGuestReviewBreakdown(room, state, guest, prng);
      const score = breakdown.finalScore;
      const totalPaid = room.pricePerNight * guest.stayLength;

      const booking: Booking = {
        id: `booking-${guest.id}`,
        roomId: room.id,
        guestId: guest.id,
        nightRate: room.pricePerNight,
        reviewScore: score,
        satisfactionAtCheckout: guest.satisfaction,
      };

      result.departed.push({ guest, roomId: room.id, booking, breakdown });
      result.events.push({
        type: 'guest_departed',
        message: `Guest checked out (${score.toFixed(1)}/10, $${totalPaid})`,
        data: { guestId: guest.id, roomId: room.id, reviewScore: score, totalPaid },
      });

      // Satisfied guests become eligible to return later (Satisfaction System Design, point 3)
      if (guest.satisfaction >= SATISFACTION.returnEligibleThreshold) {
        const profile: ReturningGuestProfile = { name: guest.name, trait: guest.trait, roomType: room.type };
        pool = [...pool, profile].slice(-STORY.returningGuestPoolMaxSize);
      }
    }
  }

  result.returningGuestPool = pool;
  return result;
}

export interface GuestReviewBreakdown {
  noisePenalty: number;
  decorPenalty: number;
  elevatorPenalty: number;
  conditionBonus: number;
  cleanlinessBonus: number;
  amenityPenalty: number;
  priceFairness: number; // raw fairness ratio (1 = perfect match, lower = worse in either direction)
  guestVariance: number;
  facilityBonus: number;
  amenityBonus: number;
  finalScore: number;
}

/**
 * Calculate a guest's review score (0-10), and the components that produced
 * it (design-review-required refactor, eng-review D4: attribution rule for
 * Review Goes Semi-Viral, and walkout Bookings need the real breakdown, not
 * just the final score). Higher star hotels have higher expectations, so the
 * same service produces lower scores at a 5-star vs a 2-star hotel.
 */
export function calculateGuestReviewBreakdown(
  room: Room,
  state: HotelState,
  guest: Guest,
  prng: PRNG
): GuestReviewBreakdown {
  const expectedPrice = getExpectedPrice(room.type, state.starRating, room.floor);
  const priceFairness = 1 - Math.abs(room.pricePerNight - expectedPrice) / expectedPrice;

  // Proximity-based noise
  const roomNoise = calculateRoomNoise(room, state);
  const noisePenalty = noiseToRatingPenalty(roomNoise, guest);

  // Condition and cleanliness
  const conditionBonus = (room.condition - REVIEW.conditionMidpoint) / REVIEW.conditionScale * REVIEW.conditionWeight;
  const cleanlinessBonus = (room.cleanliness - HOUSEKEEPING.cleanlinessMidpoint) / HOUSEKEEPING.cleanlinessScale * HOUSEKEEPING.cleanlinessWeight;
  const decorPenalty = getDecorReviewPenalty(room.decor);
  const elevatorPenalty = getElevatorWaitPenalty(state, room);

  // Building facility bonus (gym, restaurant, pool, shop adjacent to this room)
  let facilityBonus = 0;
  const adjacentFacilities = getAdjacentFacilities(state, room.gridX, room.gridY, room.floor);
  const seenTypes = new Set<string>(); // don't double-count same type
  for (const facility of adjacentFacilities) {
    if (seenTypes.has(facility.type)) continue;
    seenTypes.add(facility.type);
    const fConfig = FACILITY_CONFIG[facility.type];
    if (fConfig) {
      let bonus = fConfig.adjacentReviewBonus * FACILITY_LEVELS[facility.level - 1].reviewMult;
      // Seasonal multiplier (pool is more valuable in summer)
      if (fConfig.seasonalMultiplier) {
        const season = getCurrentSeason(state.day);
        if (season === fConfig.seasonalMultiplier) bonus *= 1.5;
      }
      facilityBonus += bonus;
    }
  }

  // In-room amenities bonus
  const amenityTier = state.amenities[room.type];
  const amenityConfig = AMENITIES.tiers[amenityTier];
  const amenityBonus = amenityConfig?.reviewBonus ?? 0;

  // Amenity expectation penalty: high-star hotels with low amenities get penalized
  let amenityPenalty = 0;
  for (const req of AMENITIES.starExpectations) {
    if (state.starRating >= req.minStars) {
      const tierOrder = ['basic', 'premium', 'luxury'];
      const currentIdx = tierOrder.indexOf(amenityTier);
      const requiredIdx = tierOrder.indexOf(req.minimumTier);
      if (currentIdx < requiredIdx) {
        amenityPenalty = req.penaltyIfBelow;
      }
      break;
    }
  }

  // Random variance
  const guestVariance = prng.range(-REVIEW.varianceRange, REVIEW.varianceRange);

  // Raw score before expectation adjustment
  const rawScore = REVIEW.baseScore
    + priceFairness * REVIEW.basePriceFairnessWeight
    - noisePenalty
    - decorPenalty
    - elevatorPenalty
    + conditionBonus
    + cleanlinessBonus
    + amenityBonus
    + facilityBonus
    - amenityPenalty
    + guestVariance;

  // Apply star expectation multiplier to penalties
  // Higher star = penalties are amplified, bonuses stay the same
  const expectation = getExpectationMultiplier(state.starRating);
  const penalties = noisePenalty + decorPenalty + elevatorPenalty + Math.max(0, -conditionBonus) + Math.max(0, -cleanlinessBonus) + amenityPenalty;
  const expectationAdjustment = penalties * (expectation - 1);

  const finalScore = rawScore - expectationAdjustment;
  const clampedScore = Math.max(REVIEW.minScore, Math.min(REVIEW.maxScore, finalScore));

  return {
    noisePenalty,
    decorPenalty,
    elevatorPenalty,
    conditionBonus,
    cleanlinessBonus,
    amenityPenalty,
    priceFairness,
    guestVariance,
    facilityBonus,
    amenityBonus,
    finalScore: clampedScore,
  };
}

/**
 * Calculate a guest's review score (0-10). Byte-identical to the pre-refactor
 * implementation -- callers that only need the final number don't need to
 * change; use calculateGuestReviewBreakdown when the components matter.
 */
export function calculateGuestReview(
  room: Room,
  state: HotelState,
  guest: Guest,
  prng: PRNG
): number {
  return calculateGuestReviewBreakdown(room, state, guest, prng).finalScore;
}
