import type { RoomType } from '../simulation/types.js';

export const ROOM_CONFIG: Record<RoomType, {
  buildCost: number;
  expectedPrice: number;
  defaultPrice: number;
  minPrice: number;
  maxPrice: number;
}> = {
  standard: {
    buildCost: 2000,
    expectedPrice: 80,
    defaultPrice: 80,
    minPrice: 30,
    maxPrice: 200,
  },
  deluxe: {
    buildCost: 5000,
    expectedPrice: 150,
    defaultPrice: 150,
    minPrice: 80,
    maxPrice: 350,
  },
  suite: {
    buildCost: 10000,
    expectedPrice: 250,
    defaultPrice: 250,
    minPrice: 150,
    maxPrice: 500,
  },
};

export const ECONOMY = {
  startingCash: 50000,
  baseArrivalsPerDay: 12,
  checkInStartHour: 14,
  checkInEndHour: 22,
  guestMinBudget: 60,
  guestMaxBudget: 300,
  guestMinStay: 1,
  guestMaxStay: 3,
  dailyOperatingCostPerRoom: 20,
  debtInterestRate: 0.05, // 5% per game-day (intentionally punishing)
  bankruptcyThreshold: -10000,
  roomRepairCost: 500,
  roomConditionDecayPerDay: 2, // condition points lost per day when occupied
  roomBreakdownThreshold: 0, // condition at which room goes out of order
  initialReviewScore: 5.0, // cold start: 5/10 (neutral)
  demolishRefundRate: 0.25, // fraction of build cost refunded on demolish (rooms and facilities)
};

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
    quick: 15,     // cost per room cleaning
    standard: 30,
    thorough: 50,
  } as Record<string, number>,

  // Daily cleaning: happens during guest stay
  dailyCleaningHour: 10, // housekeeping comes at 10 AM
  dailyCleaningBoost: 15, // cleanliness points restored per daily clean
  dailyCleaningCost: 20, // cost per room per daily cleaning

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
    dailyWage: 100, // per worker per day
    repairPerHour: 8, // condition points restored per hour of work
    conditionThreshold: 70, // auto-repair rooms below this condition
    maxRoomsPerWorker: 8, // one worker can maintain up to 8 rooms effectively
    workStartHour: 6, // maintenance shift starts
    workEndHour: 22, // maintenance shift ends
  },
  housekeeping: {
    dailyWage: 80, // per housekeeper per day
    turnoverRoomsPerHour: 1, // rooms a housekeeper can turn over per hour
    dailyCleanRoomsPerHour: 2, // rooms a housekeeper can daily-clean per hour
    workStartHour: 6,
    workEndHour: 22,
  },
  frontDesk: {
    dailyWage: 90, // per front desk worker per day
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

export const GRID = {
  width: 20,
  height: 15,
};
