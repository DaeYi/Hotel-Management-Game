import type { RoomType } from '../simulation/types.js';

export const ROOM_CONFIG: Record<RoomType, {
  buildCost: number;
  expectedPrice: number;
  defaultPrice: number;
  minPrice: number;
  maxPrice: number;
  requiredStars: number; // unlocks once the hotel's peak star rating reaches this
}> = {
  standard: {
    buildCost: 2000,
    expectedPrice: 80,
    defaultPrice: 80,
    minPrice: 30,
    maxPrice: 200,
    requiredStars: 1,
  },
  deluxe: {
    buildCost: 5000,
    expectedPrice: 150,
    defaultPrice: 150,
    minPrice: 80,
    maxPrice: 350,
    requiredStars: 2,
  },
  suite: {
    buildCost: 10000,
    expectedPrice: 250,
    defaultPrice: 250,
    minPrice: 150,
    maxPrice: 500,
    requiredStars: 3,
  },
};

export const ECONOMY = {
  startingCash: 50000,
  // Arrivals per day at a 5/10 review score, before season/weekday multipliers:
  // (baseArrivalsPerDay + arrivalsPerRoom * rooms) * STAR_RATING.demandMultiplier[stars].
  // The per-room term is the hotel's visibility -- bigger hotels draw more walk-ins,
  // but sub-linearly enough that overbuilding leaves rooms empty.
  baseArrivalsPerDay: 2,
  arrivalsPerRoom: 0.3,
  checkInStartHour: 14,
  checkInEndHour: 22,
  guestMinBudget: 60,
  guestMaxBudget: 300,
  // Each arriving guest will pay up to (fair price x tolerance), with tolerance drawn
  // uniformly from 1 to 1 + this spread. Fair price is always accepted; overpricing
  // loses a growing share of guests, so raising prices only pays when you're full.
  priceToleranceSpread: 0.8,
  guestMinStay: 1,
  guestMaxStay: 3,
  dailyOperatingCostPerRoom: 10,
  debtInterestRate: 0.05, // 5% per game-day (intentionally punishing)
  bankruptcyThreshold: -10000,
  roomRepairCost: 500,
  roomConditionDecayPerDay: 3, // condition points lost per day when occupied
  roomBreakdownThreshold: 0, // condition at which room goes out of order
  initialReviewScore: 5.0, // cold start: 5/10 (neutral)
  demolishRefundRate: 0.25, // fraction of build cost refunded on demolish (rooms and facilities)
  // Fraction of remaining-night revenue refunded as a comp when a guest departs early
  // (Noise Complaint escalation, Mid-Stay Breakdown with no room to move to). Same
  // named-constant pattern as demolishRefundRate -- not an ad hoc number.
  earlyDepartureRefundRate: 0.5,
};

export const SATISFACTION = {
  initial: 50, // matches Guest.satisfaction's starting value
  // Below this, a guest becomes eligible for escalation-type incidents (the "powder keg").
  incidentFuelThreshold: 35,
  // At or above this at checkout, a guest is added to returningGuestPool.
  returnEligibleThreshold: 65,
  // Ambient drift (ST-D3): fraction of the gap to a stay-quality-derived target closed per tick.
  ambientDriftWeight: 0.03,
  noiseComplaintPenalty: 15, // satisfaction drop when a complaint is filed
  noiseComplaintResolvedBonus: 10, // satisfaction gain when a complaint resolves on its own
  midStayBreakdownMoveBonus: 12, // satisfaction gain from a successful room-move resolution
  regularReturnBonus: 8, // small satisfaction lift on a recognized return-guest arrival
};

export const STORY = {
  // Noise Complaint chain timing (design-review D10): grace period must reliably
  // fit inside a 1-3 night (24-72h) stay -- pinned before implementation.
  noiseComplaintGraceHours: 10,
  // Pacing budget: max NEW incidents (chain origins) selected per day. Existing
  // in-progress chains advancing doesn't count against this.
  incidentDailyBudget: 2,
  // "Quiet too long" pacing bias: once this many hours pass with zero new
  // incidents, eligible candidates become near-certain to fire.
  quietBiasHours: 14,
  quietBiasMinChance: 0.15, // chance to fire immediately after a fresh incident
  returningGuestPoolMaxSize: 15,
  returningGuestPullChance: 0.12, // chance an arrival slot pulls from the pool instead of generating fresh
  storyLogMaxChains: 12, // capped like returningGuestPool -- retains this many most-recent chains
  // Word-of-mouth arrival multiplier (design-review D11): floor/ceiling so this
  // doesn't compound unboundedly with reviewScore's own arrival penalty.
  wordOfMouthFloorMultiplier: 0.85,
  wordOfMouthCeilingMultiplier: 1.15,
  // Mid-Stay Breakdown: shorter grace than Noise Complaint -- an operational
  // failure should resolve/escalate faster than a social complaint.
  midStayBreakdownGraceHours: 6,
  // Review Goes Semi-Viral: a checkout below this reviewScore (0-10) may trigger it.
  reviewSemiViralScoreThreshold: 3.0,
  reviewSemiViralPenaltyMultiplier: 0.7, // 30% arrival reduction while active
  reviewSemiViralPenaltyHours: 48, // 2 game-days
};

// Small hardcoded first-name pool (Satisfaction System Design, point 3). Known,
// accepted limitation: with enough simultaneous guests, two can share a name.
export const GUEST_NAMES = [
  'Sam', 'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie',
  'Avery', 'Quinn', 'Priya', 'Malik', 'Elena', 'Kenji', 'Zara', 'Omar',
  'Nadia', 'Leo', 'Ingrid', 'Deshawn',
];

export const GUEST_TRAITS = {
  lightSleeperChance: 0.2,
  bigSpenderChance: 0.2,
  // Drawn from the "normal" pool (0.6 -> 0.45), light_sleeper/big_spender unchanged.
  partyGuestChance: 0.15,
  lightSleeperNoiseMult: 1.5,
  bigSpenderBudgetMult: 1.5,
};

const REVIEW_WINDOW_DAYS = 30;

export const REVIEW = {
  basePriceFairnessWeight: 2.0, // scaled for 0-10
  conditionMidpoint: 50,
  conditionScale: 100,
  conditionWeight: 1.5, // scaled for 0-10
  varianceRange: 1.0, // +/- this on 0-10 scale
  baseScore: 5.0, // neutral starting point on 0-10 scale
  minScore: 0,
  maxScore: 10,
  reviewWindowDays: REVIEW_WINDOW_DAYS,
  // Single source of truth for the rolling review window: EconomyManager averages
  // over this many recent bookings, and tick.ts retains at least this many —
  // previously these were two independently-tuned multipliers (*10 vs *20) that
  // could silently desync.
  reviewWindowBookingCount: REVIEW_WINDOW_DAYS * 10,
  // Arrival rate uses reviewScore: arrivals = base * (reviewScore / 5)
  // So a 5/10 hotel gets base arrivals, 10/10 gets 2x, 0/10 gets 0
  arrivalScoreDivisor: 5.0,
  // Subtracted from calculateGuestReview's real score for an early-departure
  // walkout Booking (eng-review D4) -- not a flat fixed low value.
  walkoutIncidentPenalty: 2.0,
};

export const HOUSEKEEPING = {
  // Turnover cleaning: happens after guest checks out
  turnoverDuration: {
    quick: 2,      // 2 game-hours
    standard: 4,   // 4 game-hours
    thorough: 6,   // 6 game-hours
  } as Record<string, number>,

  turnoverCleanlinessResult: {
    quick: 60,     // restores cleanliness to 60
    standard: 85,  // restores to 85
    thorough: 100, // restores to 100
  } as Record<string, number>,

  turnoverCost: {
    quick: 8,      // cost per room cleaning
    standard: 15,
    thorough: 25,
  } as Record<string, number>,

  // Daily cleaning: happens during guest stay
  dailyCleaningHour: 10, // housekeeping comes at 10 AM
  dailyCleaningBoost: 15, // cleanliness points restored per daily clean
  dailyCleaningCost: 5, // cost per room per daily cleaning

  // Cleanliness degradation
  cleanlinessDecayPerDay: 8, // how much cleanliness drops per day while occupied
  initialCleanliness: 100,

  // Rating impact
  cleanlinessWeight: 0.8, // how much cleanliness affects rating (same scale as condition)
  cleanlinessMidpoint: 50,
  cleanlinessScale: 100,

  // Star rating requirements for housekeeping cadence
  // Hotels at or above this star target MUST use at least this cadence
  starRequirements: [
    { minStars: 4, requiredCadence: 'daily' },
    { minStars: 3, requiredCadence: 'every_other_day' },
  ] as Array<{ minStars: number; requiredCadence: string }>,
};

export const NOISE = {
  // Base noise emitted by an occupied neighboring room
  baseOccupiedNoise: 0.3,

  // Guest trait modifiers for noise OUTPUT (how loud they are)
  traitNoiseOutput: {
    normal: 1.0,
    light_sleeper: 0.8,   // quiet guests
    big_spender: 1.0,
    party_guest: 2.5,     // future trait: very loud
  } as Record<string, number>,

  // Guest trait modifiers for noise SENSITIVITY (how much it bothers them)
  traitNoiseSensitivity: {
    normal: 1.0,
    light_sleeper: 2.0,   // bothered easily
    big_spender: 1.2,     // slightly pickier
    party_guest: 0.3,     // doesn't care about noise
  } as Record<string, number>,

  // Noise below this threshold causes no rating penalty
  penaltyThreshold: 0.5,

  // Rating penalty per unit of noise above the threshold
  penaltyPerUnit: 1.2,

  // Construction noise intensity by type
  constructionIntensity: {
    build: 1.5,
    demolish: 2.0,
    renovate: 1.0,
  } as Record<string, number>,

  // Construction noise duration in game-hours
  constructionDuration: {
    build: 8,      // 8 hours of noise when building
    demolish: 4,   // 4 hours for demolition
    renovate: 6,   // 6 hours for renovation
  } as Record<string, number>,
};

export const STAFF = {
  maintenance: {
    dailyWage: 80, // per worker per day
    repairPerHour: 8, // condition points restored per hour of work
    conditionThreshold: 70, // auto-repair rooms below this condition
    maxRoomsPerWorker: 8, // one worker can maintain up to 8 rooms effectively
    workStartHour: 6, // maintenance shift starts
    workEndHour: 22, // maintenance shift ends
  },
  housekeeping: {
    dailyWage: 60, // per housekeeper per day
    turnoverRoomsPerHour: 1, // rooms a housekeeper can turn over per hour
    dailyCleanRoomsPerHour: 2, // rooms a housekeeper can daily-clean per hour
    workStartHour: 6,
    workEndHour: 22,
  },
  frontDesk: {
    dailyWage: 70, // per front desk worker per day
    checkInsPerHour: 3, // guests a worker can check in per hour
    selfServiceCapacity: 1, // check-ins per hour with 0 staff (kiosk)
    checkoutDelayWithoutStaff: 2, // extra hours added to cleaning if no front desk
    // Front desk works 24/7 (someone must always be at the desk)
  },
};

export const STAR_RATING = {
  // Points from room type mix (pct of deluxe+suite or suite-only)
  deluxeRatioPoints: 2.0,  // 100% deluxe/suite = 2 points
  suiteRatioPoints: 2.0,   // 100% suite = 2 more points

  // Points from housekeeping quality
  housekeepingPoints: {
    quick: 0,
    standard: 0.5,
    thorough: 1.0,
  } as Record<string, number>,

  // Points from daily cleaning cadence
  cadencePoints: {
    none: 0,
    every_other_day: 0.3,
    daily: 0.7,
  } as Record<string, number>,

  // Room count thresholds for bonus points
  roomCountThresholds: {
    medium: 10,  // +0.5 star points at 10+ rooms
    large: 20,   // +0.5 more at 20+ rooms
  },

  // Minimum star points for each star level (index 0 = 1 star). Spread out so a
  // fresh hotel with default housekeeping starts at 1 star and each star is a real
  // step: 2 stars is reachable with standard rooms only, which matters because
  // deluxe rooms themselves unlock at 2 stars.
  pointThresholds: [0, 2, 4.5, 7, 9],

  // What guests expect to pay (price fairness) and can afford (budget) scales with
  // stars -- the payoff for climbing, on top of demandMultiplier below.
  priceMultiplier: {
    1: 1.0,
    2: 1.15,
    3: 1.35,
    4: 1.6,
    5: 1.9,
  } as Record<number, number>,

  // Arrival multiplier per star level: a better-rated hotel reaches a bigger market.
  demandMultiplier: {
    1: 1.0,
    2: 1.2,
    3: 1.45,
    4: 1.7,
    5: 2.0,
  } as Record<number, number>,

  // Prestige upkeep: running a fancier hotel costs more. Multiplies per-room
  // operating cost, staff wages, and facility operating costs. Without this,
  // prices nearly double by 5 stars while costs stay flat.
  upkeepMultiplier: {
    1: 1.0,
    2: 1.2,
    3: 1.45,
    4: 1.8,
    5: 2.2,
  } as Record<number, number>,

  // Expectation multiplier per star level
  // Higher star = guests expect more = penalties hit harder
  expectationMultiplier: {
    1: 0.6,   // budget guests are forgiving
    2: 0.8,
    3: 1.0,   // baseline expectations
    4: 1.3,   // high expectations
    5: 1.6,   // very demanding guests
  } as Record<number, number>,
};

export const FACILITY_CONFIG: Record<string, {
  buildCost: number;
  dailyOperatingCost: number;
  adjacentReviewBonus: number; // review bonus for rooms adjacent to this facility
  noiseOutput: number; // noise generated (uses proximity system)
  starPoints: number; // contribution to star rating
  dailyRevenue: number; // direct revenue per day (shops sell to guests)
  requiredStars: number; // unlocks once the hotel's peak star rating reaches this
  seasonalMultiplier?: string; // if set, bonus is multiplied by this season's demand
  label: string;
  description: string;
  color: number; // tile color for rendering
}> = {
  gym: {
    buildCost: 8000,
    dailyOperatingCost: 30,
    adjacentReviewBonus: 0.4,
    noiseOutput: 0.3,
    starPoints: 0.5,
    dailyRevenue: 0,
    requiredStars: 2,
    label: 'Gym',
    description: 'Fitness center. Boosts satisfaction for nearby rooms.',
    color: 0x27ae60,
  },
  restaurant: {
    buildCost: 15000,
    dailyOperatingCost: 50,
    adjacentReviewBonus: 0.7,
    noiseOutput: 0.5,
    starPoints: 1.0,
    dailyRevenue: 0,
    requiredStars: 3,
    label: 'Restaurant',
    description: 'On-site dining. Big satisfaction boost but generates noise.',
    color: 0xe67e22,
  },
  pool: {
    buildCost: 20000,
    dailyOperatingCost: 40,
    adjacentReviewBonus: 0.8,
    noiseOutput: 0.2,
    starPoints: 1.0,
    dailyRevenue: 0,
    seasonalMultiplier: 'summer',
    requiredStars: 4,
    label: 'Pool',
    description: 'Swimming pool. Huge satisfaction boost, especially in summer.',
    color: 0x3498db,
  },
  shop: {
    buildCost: 6000,
    dailyOperatingCost: 20,
    adjacentReviewBonus: 0.2,
    noiseOutput: 0.1,
    starPoints: 0.3,
    dailyRevenue: 15, // $15/day per guest in the hotel from shop sales
    requiredStars: 1,
    label: 'Shop',
    description: 'Gift shop and sundries. Small bonus, earns revenue from guests.',
    color: 0x9b59b6,
  },
};

export const AMENITIES = {
  tiers: {
    basic: {
      label: 'Basic',
      description: 'Standard toiletries, basic linens, instant coffee',
      dailyCostPerRoom: 5,
      reviewBonus: 0,       // no bonus, this is the baseline
      starPoints: 0,
    },
    premium: {
      label: 'Premium',
      description: 'Brand-name bath products, quality linens, drip coffee',
      dailyCostPerRoom: 15,
      reviewBonus: 0.6,     // +0.6 on the 0-10 review scale
      starPoints: 0.3,
    },
    luxury: {
      label: 'Luxury',
      description: 'Designer products, Egyptian cotton, espresso machine',
      dailyCostPerRoom: 35,
      reviewBonus: 1.2,     // +1.2 on the 0-10 review scale
      starPoints: 0.7,
    },
  } as Record<string, {
    label: string;
    description: string;
    dailyCostPerRoom: number;
    reviewBonus: number;
    starPoints: number;
  }>,

  // Higher star hotels penalize low amenity tiers
  // A 4-star hotel with basic amenities gets a review penalty
  starExpectations: [
    { minStars: 4, minimumTier: 'premium', penaltyIfBelow: 1.0 },
    { minStars: 5, minimumTier: 'luxury', penaltyIfBelow: 1.5 },
  ] as Array<{ minStars: number; minimumTier: string; penaltyIfBelow: number }>,
};

export const SEASON = {
  yearLength: 360, // days per year
  seasonLength: 90, // days per season

  // Seasonal demand multipliers (on base arrivals)
  seasonDemand: {
    spring: 1.0,   // baseline
    summer: 1.5,   // peak tourist season
    autumn: 0.9,   // slight dip
    winter: 0.6,   // slow season
  } as Record<string, number>,

  // Day-of-week demand multipliers
  weekdayDemand: 0.8,    // Mon-Thu
  fridayDemand: 1.2,     // Friday (early arrivals for weekend)
  weekendDemand: 1.5,    // Sat-Sun

  // Special events (holidays, conferences, etc.)
  specialEvents: [
    { name: 'New Year', startDay: 355, duration: 10, demandMultiplier: 2.0 },
    { name: 'Spring Festival', startDay: 45, duration: 7, demandMultiplier: 1.6 },
    { name: 'Summer Peak', startDay: 135, duration: 14, demandMultiplier: 1.4 },
    { name: 'Harvest Fair', startDay: 250, duration: 5, demandMultiplier: 1.3 },
  ] as Array<{ name: string; startDay: number; duration: number; demandMultiplier: number }>,
};

// The opening bank loan. Starting cash is borrowed money: a fixed weekly payment
// covers interest on the remaining balance first, then principal. Payments still
// come out when cash is short, so they push you into debt (ECONOMY.debtInterestRate).
export const LOAN = {
  principal: 50000, // equals ECONOMY.startingCash -- the whole opening budget is borrowed
  weeklyInterestRate: 0.01,
  weeklyPayment: 1000,
  paymentIntervalDays: 7,
  earlyRepaymentStep: 5000, // the "pay extra" button repays in chunks of this size
};

export type ObjectiveKind =
  | 'room_count'      // own at least `target` rooms
  | 'occupancy_7d'    // average overnight occupancy over the last 7 days >= target (0-1)
  | 'review_score'    // review score >= target (0-10)
  | 'star_rating'     // star rating >= target
  | 'revenue_30d'     // revenue earned over the last 30 days >= target
  | 'loan_paid_off'   // loan balance is zero
  | 'valuation'       // hotel valuation >= target
  | 'five_star_days'  // held 5 stars for `target` consecutive days
  | 'occupancy_30d';  // average overnight occupancy over the last 30 days >= target (0-1)

export interface ObjectiveConfig {
  id: string;
  title: string;
  description: string;
  kind: ObjectiveKind;
  target: number;
  deadlineDay: number | null; // absolute game day; missing it fails the objective. null = no deadline
  reward: number; // cash paid on completion
}

// Owner objectives, worked through in order. Deadlines are absolute days so a
// slow start eats into later goals' time rather than resetting the clock.
export const OBJECTIVES: ObjectiveConfig[] = [
  { id: 'open', title: 'Open for Business', description: 'Build 8 rooms', kind: 'room_count', target: 8, deadlineDay: 10, reward: 2000 },
  { id: 'full_house', title: 'Full House', description: 'Average 70% occupancy over 7 days', kind: 'occupancy_7d', target: 0.7, deadlineDay: 40, reward: 3000 },
  { id: 'good_word', title: 'Good Word', description: 'Reach a 7.0 review score', kind: 'review_score', target: 7.0, deadlineDay: 50, reward: 3000 },
  { id: 'two_stars', title: 'Moving Up', description: 'Reach 2 stars', kind: 'star_rating', target: 2, deadlineDay: 70, reward: 5000 },
  { id: 'good_month', title: 'A Good Month', description: 'Earn $25,000 in 30 days', kind: 'revenue_30d', target: 25000, deadlineDay: 120, reward: 6000 },
  { id: 'three_stars', title: 'Three-Star Hotel', description: 'Reach 3 stars', kind: 'star_rating', target: 3, deadlineDay: 160, reward: 10000 },
  { id: 'debt_free', title: 'Debt Free', description: 'Pay off the bank loan', kind: 'loan_paid_off', target: 0, deadlineDay: 240, reward: 10000 },
  { id: 'four_stars', title: 'Four-Star Hotel', description: 'Reach 4 stars', kind: 'star_rating', target: 4, deadlineDay: 260, reward: 15000 },
  { id: 'five_stars', title: 'Five-Star Legend', description: 'Reach 5 stars', kind: 'star_rating', target: 5, deadlineDay: 420, reward: 25000 },
];

// Legacy goals: generated endlessly once OBJECTIVES are all resolved, cycling
// through these kinds with targets that escalate each full cycle (tier).
// No deadlines and no cash rewards -- cash is no longer the point by then.
export const LEGACY = {
  valuationBase: 1_000_000, // tier 0 target; doubles each tier
  fiveStarDaysBase: 30, // tier 0 target; +30 each tier
  occupancyBase: 0.75, // tier 0 target; +0.05 each tier, capped
  occupancyCap: 0.95,
  reviewBase: 8.5, // tier 0 target; +0.3 each tier, capped
  reviewCap: 9.7,
};

// Room and facility decor fades every day. Below freshThreshold it costs star
// points (up to maxStarPenalty at 0 decor) and drags guest reviews -- harder at
// higher star levels via the existing expectation multiplier.
export const DECOR = {
  decayPerDay: 0.35, // 100 -> 70 (stale) in ~86 days
  freshThreshold: 70,
  maxStarPenalty: 3.0, // star points lost when average decor hits 0
  reviewWeight: 2.5, // on the 0-10 scale: (decor - 70) / 70 * weight, penalty only
};

// Renovation restores a room's or facility's decor (and a room's condition and
// cleanliness) to 100. Rooms go offline for durationHours; cost is a share of
// build cost, scaled by the star price multiplier (luxury fit-outs cost more).
export const RENOVATION = {
  costRate: 0.25,
  durationHours: 24,
};

// Marketing campaigns: pay up front for a temporary arrivals boost. One at a
// time. Cost = baseCost + perRoomCost x rooms, so it scales with the hotel.
export const MARKETING = {
  campaigns: {
    local: { label: 'Local Ads', baseCost: 1000, perRoomCost: 60, demandBoost: 1.2, durationDays: 14 },
    online: { label: 'Travel Sites', baseCost: 4000, perRoomCost: 180, demandBoost: 1.4, durationDays: 14 },
    national: { label: 'National Campaign', baseCost: 12000, perRoomCost: 450, demandBoost: 1.7, durationDays: 21 },
  } as Record<string, { label: string; baseCost: number; perRoomCost: number; demandBoost: number; durationDays: number }>,
};

// Facility upgrades: index 0 is level 1 (as built). Each level multiplies the
// facility's adjacent review bonus, star points, shop revenue, and operating cost.
export const FACILITY_LEVELS = [
  { requiredStars: 0, upgradeCostRate: 0, reviewMult: 1.0, starMult: 1.0, revenueMult: 1.0, operatingMult: 1.0 },
  { requiredStars: 4, upgradeCostRate: 1.0, reviewMult: 1.5, starMult: 1.3, revenueMult: 1.5, operatingMult: 1.8 },
  { requiredStars: 5, upgradeCostRate: 1.75, reviewMult: 2.0, starMult: 1.6, revenueMult: 2.0, operatingMult: 2.8 },
];

// Hotel valuation: property (build spend, discounted by stale decor) plus a
// multiple of recent revenue (the business as a going concern) plus net cash.
export const VALUATION = {
  revenueMultiple: 6, // x last-30-day revenue
  minDecorFactor: 0.5, // property value at 0 decor, as a fraction of build cost
};

export const DAILY_STATS_MAX_DAYS = 60; // covers the longest objective window (30 days) with room to spare

export const GRID = {
  width: 20,
  height: 15,
};
