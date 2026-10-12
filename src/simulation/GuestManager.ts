import type { Guest, GuestTrait, Room, HotelState, Booking, GameEvent, ReturningGuestProfile } from './types.js';
import type { PRNG } from './prng.js';
import { ECONOMY, GUEST_TRAITS, REVIEW, HOUSEKEEPING, STAFF, AMENITIES, GUEST_NAMES, SATISFACTION, STORY, PARTIES } from '../config/balance.js';
import { getDecorReviewPenalty } from './DecorManager.js';
import { getCampaignDemandMultiplier } from './MarketingManager.js';
import { getCheckInCapacity } from './Layout.js';
import { getAvailableRooms, getElevatorWaitPenalty } from './HotelState.js';
import { facilityReviewBonus } from './FacilityManager.js';
import { calculateRoomNoise, noiseToRatingPenalty } from './NoiseManager.js';
import { getExpectationMultiplier, getPartyFairPrice, getPriceMultiplier, getStarDemandMultiplier } from './StarRatingManager.js';
import { profileRoom, fitsParty } from './RoomProfile.js';
import { partyOf, rollParty, withParty, smallerParty, partyLabel, PartyLabel, describeParty, numberWord, sharesBeds } from './Party.js';
import { hash01 } from './Movement.js';
import { rollPurpose } from './Purpose.js';
import { roomFit, type RoomFeature } from './Preferences.js';
import { getTotalDemandMultiplier } from './SeasonManager.js';
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
  const market = ECONOMY.baseArrivalsPerDay + ECONOMY.arrivalsPerSqrtRoom * Math.sqrt(state.rooms.length);
  return market
    * getStarDemandMultiplier(state.starRating)
    * (state.reviewScore / REVIEW.arrivalScoreDivisor)
    * getTotalDemandMultiplier(state.day)
    * getWordOfMouthMultiplier(state)
    * getReputationPenaltyMultiplier(state)
    * getCampaignDemandMultiplier(state);
}

/**
 * Cheapest available room that fits the guest's party (fitsParty), that they
 * can afford, and that they consider worth the price: no more than
 * `priceTolerance` x what the room is worth to them at the hotel's current
 * star level (getPartyFairPrice -- a family room is only a double to a couple).
 */
export function matchGuestToRoom(guest: Guest, availableRooms: Room[], priceTolerance: number, starRating: number): Room | null {
  const party = partyOf(guest);
  for (const room of availableRooms) {
    if (!fitsParty(profileRoom(room), party)) continue;
    const fairPrice = getPartyFairPrice(room, party, starRating);
    if (room.pricePerNight <= guest.budget && room.pricePerNight <= fairPrice * priceTolerance) {
      return room;
    }
  }
  return null;
}

/** Whether any of these rooms would take this party at all (whatever it costs). */
function anyFits(rooms: Room[], guest: Guest): boolean {
  const party = partyOf(guest);
  return rooms.some(room => fitsParty(profileRoom(room), party));
}

export interface ArrivalResult {
  checkedIn: Array<{ guest: Guest; roomId: string }>;
  turnedAway: number;
  events: GameEvent[];
  returningGuestPool: ReturningGuestProfile[]; // after any pulls this hour
  walkIns: Array<{ guest: Guest; outcome: 'impatient' | 'turned_away' }>; // came in but didn't stay
}

export function processArrivals(
  state: HotelState,
  hour: number,
  prng: PRNG
): ArrivalResult {
  const result: ArrivalResult = { checkedIn: [], turnedAway: 0, events: [], returningGuestPool: state.returningGuestPool, walkIns: [] };

  if (hour < ECONOMY.checkInStartHour || hour >= ECONOMY.checkInEndHour) {
    return result;
  }

  const hoursInWindow = ECONOMY.checkInEndHour - ECONOMY.checkInStartHour;
  const arrivalsThisHour = getExpectedArrivalsPerDay(state) / hoursInWindow;

  const guaranteed = Math.floor(arrivalsThisHour);
  const extra = prng.chance(arrivalsThisHour - guaranteed) ? 1 : 0;
  const totalArrivals = guaranteed + extra;

  // Check-ins happen at a reachable desk, at the pace of the front desk staff seated there
  const checkInCapacity = getCheckInCapacity(state);

  const available = getAvailableRooms(state);
  // Rooms booked this hour (any free room is open to the next guest, cheaper or not)
  const booked = new Set<string>();
  let checkedInThisHour = 0;
  let pool = [...state.returningGuestPool];
  // Guest ids come from a random draw, so two can clash: give a clash a suffix
  // (no extra draw, so the random stream stays the same) -- everything that
  // follows a guest around (their trip, their room) is keyed by id
  const taken = new Set(state.guests.map(g => g.id));

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
    if (taken.has(guest.id)) {
      let n = 2;
      while (taken.has(`${guest.id}-${n}`)) n++;
      guest = { ...guest, id: `${guest.id}-${n}` };
    }
    taken.add(guest.id);
    // Who the booking's for, and why they're here, from its id (so nothing
    // else's randomness moves). The purpose stays if they book smaller below.
    guest = withParty(guest, rollParty(guest.id, state.day));
    const purpose = rollPurpose(guest.id, partyOf(guest));
    if (purpose) guest = { ...guest, purpose };

    // Front desk at capacity: guest leaves impatiently
    if (checkedInThisHour >= checkInCapacity) {
      result.turnedAway++;
      result.walkIns.push({ guest, outcome: 'impatient' });
      result.events.push({
        type: 'guest_impatient',
        message: `${partyOf(guest).size > 2 ? PartyLabel(guest) : 'Guest'} left (${checkInCapacity === 0 ? 'no staffed check-in desk' : 'front desk too busy'})`,
        data: { reason: checkInCapacity === 0 ? 'no_desk' : 'front_desk_capacity', guestId: guest.id, partyKind: partyOf(guest).kind, size: partyOf(guest).size },
      });
      continue;
    }

    const remainingRooms = available.filter(r => !booked.has(r.id));
    const priceTolerance = 1 + prng.next() * ECONOMY.priceToleranceSpread;

    // No free room takes a party this big, but one would take one or two of
    // them: most book smaller, the rest go elsewhere
    const party = partyOf(guest);
    let wanted: string | undefined; // the party they were, if they book smaller
    if (!anyFits(remainingRooms, guest)) {
      const smaller = withParty(guest, smallerParty(party, guest.id));
      const fallback = anyFits(remainingRooms, smaller) ? smaller
        : smaller.party!.size > 1 ? withParty(guest, { kind: 'solo', size: 1 }) : smaller;
      if (fallback.party!.size < party.size && anyFits(remainingRooms, fallback)) {
        if (hash01(`${guest.id}#party-reroll`) < PARTIES.rerollChance) {
          guest = fallback;
          wanted = party.kind;
        } else {
          result.turnedAway++;
          result.walkIns.push({ guest, outcome: 'turned_away' });
          const need = sharesBeds(party) ? `no room for ${numberWord(party.size)}` : `no room with ${numberWord(party.size)} beds`;
          result.events.push({
            type: 'party_turned_away',
            message: `${PartyLabel(guest)} was turned away: ${need}`,
            data: { guestId: guest.id, partyKind: party.kind, size: party.size, reason: 'no_fit' },
          });
          continue;
        }
      }
    }

    const room = matchGuestToRoom(guest, remainingRooms, priceTolerance, state.starRating);
    const who = partyOf(guest);
    if (room) {
      booked.add(room.id);
      checkedInThisHour++;
      result.checkedIn.push({ guest, roomId: room.id });
      result.events.push({
        type: 'guest_arrived',
        message: who.size > 2 ? `${PartyLabel(guest)} arriving for a ${profileRoom(room).label}` : `Guest arriving for a ${room.type} room`,
        data: { guestId: guest.id, roomId: room.id, trait: guest.trait, partyKind: who.kind, size: who.size, ...(wanted ? { wanted } : {}) },
      });
      if (guest.isReturning) {
        result.events.push({
          type: 'guest_returned',
          // The guest who stayed before, by name: who they bring this time is new
          message: `${guest.name} is back for another stay${who.size > 2 ? (who.kind === 'family' ? ', with the family' : ', with friends') : ''}!`,
          data: { guestId: guest.id, roomId: room.id },
        });
      }
    } else {
      result.turnedAway++;
      result.walkIns.push({ guest, outcome: 'turned_away' });
      result.events.push({
        type: 'guest_turned_away',
        message: who.size > 2 ? `${PartyLabel(guest)} turned away (no room at a price they would pay)` : 'Guest turned away (no room at a price they would pay)',
        data: { guestId: guest.id, partyKind: who.kind, size: who.size, reason: 'price', ...(wanted ? { wanted } : {}) },
      });
    }
  }

  result.returningGuestPool = pool;
  return result;
}

/**
 * Whether a guest's stay is up by the end of the current hour: their last
 * night is over and it's checkout time (ECONOMY.checkOutHour). The tick at
 * the end of hour 10 happens at 11:00, so that's when 11:00 checkouts leave.
 */
export function isCheckoutDue(guest: Guest, state: Pick<HotelState, 'day' | 'hour'>): boolean {
  return state.day - guest.checkInDay >= guest.stayLength && state.hour + 1 >= ECONOMY.checkOutHour;
}

/** Whether a guest leaves today (their checkout time may not have come yet). */
export function isCheckoutDay(guest: Guest, day: number): boolean {
  return day - guest.checkInDay >= guest.stayLength;
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
    if (isCheckoutDue(guest, state)) {
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
        message: `${partyOf(guest).size > 2 ? PartyLabel(guest) : 'Guest'} checked out (${score.toFixed(1)}/10, $${totalPaid})`,
        data: {
          guestId: guest.id, roomId: room.id, reviewScore: score, totalPaid, partyKind: partyOf(guest).kind, size: partyOf(guest).size,
          roomFit: breakdown.roomFit, liked: !!breakdown.roomLikes, disliked: !!breakdown.roomDislikes,
        },
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
  roomFit: number; // how well the room suited them (Preferences.ts): what they liked, less what they didn't
  roomLikes?: RoomFeature[];
  roomDislikes?: RoomFeature[];
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
  const expectedPrice = getPartyFairPrice(room, partyOf(guest), state.starRating);
  const priceFairness = 1 - Math.abs(room.pricePerNight - expectedPrice) / expectedPrice;

  // Proximity-based noise
  const roomNoise = calculateRoomNoise(room, state);
  const noisePenalty = noiseToRatingPenalty(roomNoise, guest);

  // Condition and cleanliness
  const conditionBonus = (room.condition - REVIEW.conditionMidpoint) / REVIEW.conditionScale * REVIEW.conditionWeight;
  const cleanlinessBonus = (room.cleanliness - HOUSEKEEPING.cleanlinessMidpoint) / HOUSEKEEPING.cleanlinessScale * HOUSEKEEPING.cleanlinessWeight;
  const decorPenalty = getDecorReviewPenalty(room.decor);
  const elevatorPenalty = getElevatorWaitPenalty(state, room);

  // Facilities the guest actually used this stay (gym, restaurant, pool, shop)
  const facilityBonus = facilityReviewBonus(guest, state.day);

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

  // What they liked (or didn't) in the room: their purpose, party and trait against its furniture
  const fit = roomFit(profileRoom(room), guest);

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
    + fit.score
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
    roomFit: fit.score,
    ...(fit.likes.length > 0 ? { roomLikes: fit.likes } : {}),
    ...(fit.dislikes.length > 0 ? { roomDislikes: fit.dislikes } : {}),
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
