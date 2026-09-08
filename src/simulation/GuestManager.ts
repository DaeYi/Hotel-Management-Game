import type { Guest, GuestTrait, Room, HotelState, Booking, GameEvent } from './types.js';
import type { PRNG } from './prng.js';
import { ECONOMY, GUEST_TRAITS, REVIEW, ROOM_CONFIG, HOUSEKEEPING, STAFF, AMENITIES, FACILITY_CONFIG } from '../config/balance.js';
import { getAvailableRooms, getAdjacentFacilities } from './HotelState.js';
import { calculateRoomNoise, noiseToRatingPenalty } from './NoiseManager.js';
import { getExpectationMultiplier } from './StarRatingManager.js';
import { getTotalDemandMultiplier, getCurrentSeason } from './SeasonManager.js';

function generateGuestTrait(prng: PRNG): GuestTrait {
  const roll = prng.next();
  if (roll < GUEST_TRAITS.lightSleeperChance) return 'light_sleeper';
  if (roll < GUEST_TRAITS.lightSleeperChance + GUEST_TRAITS.bigSpenderChance) return 'big_spender';
  return 'normal';
}

function generateGuest(prng: PRNG, day: number): Guest {
  const trait = generateGuestTrait(prng);
  let budget = prng.range(ECONOMY.guestMinBudget, ECONOMY.guestMaxBudget);
  if (trait === 'big_spender') {
    budget *= GUEST_TRAITS.bigSpenderBudgetMult;
  }

  return {
    id: `guest-${day}-${Math.floor(prng.next() * 100000)}`,
    budget,
    stayLength: prng.int(ECONOMY.guestMinStay, ECONOMY.guestMaxStay),
    trait,
    satisfaction: 50,
    checkInDay: day,
  };
}

function matchGuestToRoom(guest: Guest, availableRooms: Room[]): Room | null {
  for (const room of availableRooms) {
    if (room.pricePerNight <= guest.budget) {
      return room;
    }
  }
  return null;
}

export interface ArrivalResult {
  checkedIn: Array<{ guest: Guest; roomId: string }>;
  turnedAway: number;
  events: GameEvent[];
}

export function processArrivals(
  state: HotelState,
  hour: number,
  prng: PRNG
): ArrivalResult {
  const result: ArrivalResult = { checkedIn: [], turnedAway: 0, events: [] };

  if (hour < ECONOMY.checkInStartHour || hour >= ECONOMY.checkInEndHour) {
    return result;
  }

  const hoursInWindow = ECONOMY.checkInEndHour - ECONOMY.checkInStartHour;
  // Arrival rate: base * reviewScore factor * seasonal demand
  const demandMult = getTotalDemandMultiplier(state.day);
  const arrivalsPerDay = ECONOMY.baseArrivalsPerDay * (state.reviewScore / REVIEW.arrivalScoreDivisor) * demandMult;
  const arrivalsThisHour = arrivalsPerDay / hoursInWindow;

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

  for (let i = 0; i < totalArrivals; i++) {
    const guest = generateGuest(prng, state.day);

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
    const room = matchGuestToRoom(guest, remainingRooms);

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
    } else {
      result.turnedAway++;
      result.events.push({
        type: 'guest_turned_away',
        message: 'Guest turned away (no affordable room available)',
      });
    }
  }

  return result;
}

export interface DepartureResult {
  departed: Array<{ guest: Guest; roomId: string; booking: Booking }>;
  events: GameEvent[];
}

export function processDepartures(
  state: HotelState,
  prng: PRNG
): DepartureResult {
  const result: DepartureResult = { departed: [], events: [] };

  for (const guest of state.guests) {
    const daysStayed = state.day - guest.checkInDay;
    if (daysStayed >= guest.stayLength) {
      const room = state.rooms.find(r => r.status === 'occupied' && r.guestId === guest.id);
      if (!room) continue;

      const score = calculateGuestReview(room, state, guest, prng);
      const totalPaid = room.pricePerNight * guest.stayLength;

      const booking: Booking = {
        id: `booking-${guest.id}`,
        roomId: room.id,
        guestId: guest.id,
        nightRate: room.pricePerNight,
        reviewScore: score,
      };

      result.departed.push({ guest, roomId: room.id, booking });
      result.events.push({
        type: 'guest_departed',
        message: `Guest checked out (${score.toFixed(1)}/10, $${totalPaid})`,
        data: { guestId: guest.id, roomId: room.id, reviewScore: score, totalPaid },
      });
    }
  }

  return result;
}

/**
 * Calculate a guest's review score (0-10).
 * Higher star hotels have higher expectations, so the same service
 * produces lower scores at a 5-star vs a 2-star hotel.
 */
export function calculateGuestReview(
  room: Room,
  state: HotelState,
  guest: Guest,
  prng: PRNG
): number {
  const expectedPrice = ROOM_CONFIG[room.type].expectedPrice;
  const priceFairness = 1 - Math.abs(room.pricePerNight - expectedPrice) / expectedPrice;

  // Proximity-based noise
  const roomNoise = calculateRoomNoise(room, state);
  const noisePenalty = noiseToRatingPenalty(roomNoise, guest);

  // Condition and cleanliness
  const conditionBonus = (room.condition - REVIEW.conditionMidpoint) / REVIEW.conditionScale * REVIEW.conditionWeight;
  const cleanlinessBonus = (room.cleanliness - HOUSEKEEPING.cleanlinessMidpoint) / HOUSEKEEPING.cleanlinessScale * HOUSEKEEPING.cleanlinessWeight;

  // Building facility bonus (gym, restaurant, pool, shop adjacent to this room)
  let facilityBonus = 0;
  const adjacentFacilities = getAdjacentFacilities(state, room.gridX, room.gridY);
  const seenTypes = new Set<string>(); // don't double-count same type
  for (const facility of adjacentFacilities) {
    if (seenTypes.has(facility.type)) continue;
    seenTypes.add(facility.type);
    const fConfig = FACILITY_CONFIG[facility.type];
    if (fConfig) {
      let bonus = fConfig.adjacentReviewBonus;
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
    + conditionBonus
    + cleanlinessBonus
    + amenityBonus
    + facilityBonus
    - amenityPenalty
    + guestVariance;

  // Apply star expectation multiplier to penalties
  // Higher star = penalties are amplified, bonuses stay the same
  const expectation = getExpectationMultiplier(state.starRating);
  const penalties = noisePenalty + Math.max(0, -conditionBonus) + Math.max(0, -cleanlinessBonus) + amenityPenalty;
  const expectationAdjustment = penalties * (expectation - 1);

  const finalScore = rawScore - expectationAdjustment;

  return Math.max(REVIEW.minScore, Math.min(REVIEW.maxScore, finalScore));
}
