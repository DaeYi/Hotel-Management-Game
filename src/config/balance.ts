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
  // (baseArrivalsPerDay + arrivalsPerSqrtRoom * sqrt(rooms)) * STAR_RATING.demandMultiplier[stars].
  // A bigger hotel is more visible, but the city only has so many travellers:
  // the square root means each extra room adds less demand than the last, so
  // a well-run hotel tops out where new rooms stop filling.
  baseArrivalsPerDay: 0.5,
  arrivalsPerSqrtRoom: 1.65,
  checkInStartHour: 14,
  checkInEndHour: 22,
  checkOutHour: 11, // guests whose last night is over check out at 11:00
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
  reviewSemiViralStacks: true, // a second bad review spreading while one already is: deepens the dip (true) or restarts it (false)
};

// Small hardcoded first-name pool (Satisfaction System Design, point 3). Known,
// accepted limitation: with enough simultaneous guests, two can share a name.
export const GUEST_NAMES = [
  'Sam', 'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie',
  'Avery', 'Quinn', 'Priya', 'Malik', 'Elena', 'Kenji', 'Zara', 'Omar',
  'Nadia', 'Leo', 'Ingrid', 'Deshawn',
];

/** Family names, for parties: "the Okafor family". Picked by guest id, never from the shared random stream. */
export const SURNAMES = [
  'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Haddad', 'Novak', 'Ferreira', 'Kowalski',
  'Mensah', 'Rossi', 'Nguyen', 'Brennan', 'Castillo', 'Ivanova', 'Sato', 'Adeyemi',
  'Larsen', 'Patel', 'Duarte', 'Whitfield',
];

/**
 * Parties (docs/designs/rooms-rethink.md, "Party size and capacity"). One
 * booking is a party: one or two people, as every guest was before, or a
 * group of friends or a family. Who books shifts with the week and the
 * season. Everything a party changes scales only with people beyond two, so
 * bookings of one or two are exactly what they always were.
 */
export const PARTIES = {
  enabled: true,
  // The mix of who books, Monday-Friday and at the weekend
  weekday: { solo: 0.35, business: 0.20, couple: 0.30, friends: 0.05, family: 0.10 },
  weekend: { solo: 0.15, business: 0.05, couple: 0.40, friends: 0.15, family: 0.25 },
  summerShift: 0.10, // in summer this much of the mix moves from solo travellers to families
  // How big friends and families come (a one-tile room sleeps four at most, so no fives yet)
  friendsSizes: [[2, 0.5], [3, 0.3], [4, 0.2]] as Array<[number, number]>,
  familySizes: [[3, 0.45], [4, 0.55]] as Array<[number, number]>,
  budgetMult: { 3: 1.35, 4: 1.6, 5: 1.8 } as Record<number, number>, // a bigger party has more to spend on a room
  perPersonScale: 0.3, // noise, wear, mess, consumables and spending: +30% per person beyond two
  // When no free room fits a party, most of them book as one or two (the parents
  // take a double; one friend comes alone); the rest are turned away
  rerollChance: 0.9,
};

/**
 * Why guests come (docs/designs/guest-preferences.md). A booking's purpose
 * follows from its party -- a business party is on business, families never
 * are -- so who books is unchanged: the purpose mix moves with the week and
 * the season through the party mix (weekdays about 45% business, weekends
 * about half sightseeing). It changes what guests do (when they go out, for
 * how long, which facilities they use) and what they like in a room.
 */
export const GUEST_PURPOSES = {
  enabled: true,
  // The purpose by party: [purpose, weight]
  byParty: {
    solo: [['business', 0.7], ['sightseeing', 0.2], ['getaway', 0.1]],
    business: [['business', 1]],
    couple: [['sightseeing', 0.5], ['getaway', 0.5]],
    friends: [['sightseeing', 0.7], ['getaway', 0.3]],
    family: [['sightseeing', 0.7], ['getaway', 0.3]],
  } as Record<PartyKindName, Array<[PurposeName, number]>>,
  // Going out for the day: the chance (x GUEST_OUTINGS.leaveChance) and how long.
  // Business guests are out at meetings till the evening, sightseers most of the
  // day; a getaway is spent mostly in the hotel. About as many outings as before.
  outing: {
    business: { chanceMult: 1.3, minHours: 6, maxHours: 10 },
    sightseeing: { chanceMult: 1.15, minHours: 3, maxHours: 8 },
    getaway: { chanceMult: 0.4, minHours: 2, maxHours: 4 },
  } as Record<PurposeName, { chanceMult: number; minHours: number; maxHours: number }>,
  // Facilities: the visit chance by purpose (x FACILITY_CONFIG[type].visitChance)
  facility: {
    business: { gym: 1.6, restaurant: 1.3, pool: 0.3, shop: 0.6 },
    sightseeing: { gym: 0.6, restaurant: 0.9, pool: 0.8, shop: 1.4 },
    getaway: { gym: 1.0, restaurant: 1.2, pool: 1.8, shop: 1.0 },
  } as Record<PurposeName, Record<'gym' | 'restaurant' | 'pool' | 'shop', number>>,
};
/**
 * Who guests are, beyond their trip (docs/designs/guest-staff-personalities.md,
 * Body and Temperament; Profile.ts). Rolled from the booking's id when they
 * arrive, never from the shared random stream. With profiles off nobody has
 * one, and the hotel runs exactly as before: noise judged at checkout,
 * everyone out at 11:00, one walking pace.
 */
export const GUEST_PROFILE = {
  enabled: true,
  // Chronotype: up early (business travellers and families lean that way), regular, or up late (friends)
  chronotype: {
    base: [['early', 0.25], ['regular', 0.55], ['night', 0.2]],
    business: [['early', 0.4], ['regular', 0.5], ['night', 0.1]],
    family: [['early', 0.4], ['regular', 0.5], ['night', 0.1]],
    friends: [['early', 0.15], ['regular', 0.45], ['night', 0.4]],
  } as Record<string, Array<[ChronotypeName, number]>>,
  activityOffset: { early: -2, regular: 0, night: 2 } as Record<ChronotypeName, number>, // facility and outing hours move by this
  sleepHours: { early: [21, 5], regular: [23, 7], night: [1, 9] } as Record<ChronotypeName, [number, number]>,
  earlyCheckoutHours: [7, 10] as [number, number], // an early bird leaves at one of these hours (inclusive)
  lateCheckoutHour: 13, // what a night owl asks for
  lateCheckoutFee: 0.3, // of the room's nightly rate, with the fee policy
  lateCheckoutRefused: 5, // satisfaction a night owl loses when refused
  // Mobility: brisk (business), normal, or slow (families lean that way). The paces are a fixed table:
  // routes are cached per pace, so never compute one
  mobility: {
    base: [['brisk', 0.15], ['normal', 0.75], ['limited', 0.1]],
    business: [['brisk', 0.3], ['normal', 0.65], ['limited', 0.05]],
    family: [['brisk', 0.05], ['normal', 0.7], ['limited', 0.25]],
  } as Record<string, Array<[MobilityName, number]>>,
  pace: { brisk: 0.045, normal: 0.06, limited: 0.09 } as Record<MobilityName, number>, // hours per tile (normal = TRAVEL.guestHoursPerTile)
  limitedLiftMult: 1.5, // a slow walker minds a wait for the lift more
  // Sleep sensitivity and rowdiness: the legacy trait sets light sleepers (20%) and rowdy
  // guests (15%); the rest are rolled, so the overall mix is heavy 20 / normal 60 / light 20
  // and quiet 20 / normal 65 / rowdy 15
  heavySleeperChance: 0.25, // of guests who aren't light sleepers
  quietChance: 0.235, // of guests who aren't rowdy
  sensitivity: { heavy: 0.5, normal: 1, light: 2 } as Record<SleepName, number>,
  output: { quiet: 0.8, normal: 1, rowdy: 2.5 } as Record<RowdinessName, number>,
  rowdyLateHours: [22, 2] as [number, number], // rowdy guests are louder still late at night
  rowdyLateMult: 1.5,
  // A night's noise: a guest's review loses this much per unit of noise over the
  // threshold, summed over their sleep hours, averaged over the nights they stayed
  // (calibrated so the mean noise penalty is about what it was when noise was judged at checkout)
  nightPenaltyPerUnit: 1.25,
  // How much an hour of night noise sours a guest's mood while it lasts, as a multiple of what it costs their review
  nightDriftWeight: 8,
  maxNightNoisePenalty: Infinity, // the most a stay's night noise can take off a review
};
/**
 * Favourite facilities (docs/designs/guest-staff-personalities.md, Tastes #10;
 * FacilityManager.ts). About half of guests have one, leaning by who they are:
 * business travellers the gym and breakfast, families and getaways the pool.
 * A fan is three times as likely to go, up to twice a day, and it counts for
 * more in their review; everyone else a little less likely, so visits overall
 * stay about where they were. A visit lifts a guest's mood; a favourite that
 * isn't there (once the hotel's stars allow it) or is full lets them down.
 */
export const GUEST_FAVORITES = {
  enabled: true,
  byLean: {
    base: [['none', 0.55], ['gym', 0.1], ['restaurant', 0.15], ['pool', 0.1], ['shop', 0.1]],
    business: [['none', 0.45], ['gym', 0.3], ['restaurant', 0.2], ['pool', 0], ['shop', 0.05]],
    family: [['none', 0.45], ['gym', 0.05], ['restaurant', 0.15], ['pool', 0.3], ['shop', 0.05]],
    getaway: [['none', 0.45], ['gym', 0.05], ['restaurant', 0.2], ['pool', 0.25], ['shop', 0.05]],
  } as Record<string, Array<[FacilityName | 'none', number]>>,
  fanChanceMult: 3,
  nonFanChanceMult: { gym: 0.6, restaurant: 1, pool: 0.9, shop: 0.85 } as Record<FacilityName, number>, // tuned so visits overall stay about where they were
  fanVisitsPerDay: 2,
  fanRevisitGapHours: 4, // not straight back for a second breakfast
  fanReviewMult: 1.5,
  visitMood: 3, // satisfaction a visit to any facility adds
  favoriteVisitMood: 6, // ... to their favourite
  missMood: 4, // satisfaction lost when their favourite lets them down (once a day)
  missReview: 0.3, // review lost per such day
  maxMissesPerStay: 2,
  fallbackOutingHours: [2, 4] as [number, number], // no pool or restaurant: off to the beach, or out to dinner, instead
};
type FacilityName = 'gym' | 'restaurant' | 'pool' | 'shop';

/**
 * Loyalty (Status #12; Loyalty.ts). A guest who enjoyed their stay may want to
 * come back: the happier, the likelier (a delighted guest more so), after a
 * few days to a month. The same person returns -- the same chronotype, pace,
 * sleep, favourite -- and keeps count: returning (2nd stay), regular (3rd-4th),
 * VIP (5th+). Regulars ask for their old room; the loyal forgive more, and
 * their reviews count double. A regular who leaves unhappier than last time
 * is lost. Off: the old rule (back if satisfaction reached 65).
 */
export const LOYALTY = {
  enabled: true,
  entryFrom: 52, // satisfaction at checkout from which a guest might want to come back...
  entryFull: 68, // ...and at which they certainly do
  delightedMult: 1.5,
  returnAfterDays: [5, 30] as [number, number],
  poolMaxSize: 40,
  regularFrom: 3, // stays
  vipFrom: 5,
  expectationMult: { returning: 0.9, regular: 0.85, vip: 0.75 } as Record<'returning' | 'regular' | 'vip', number>, // how much their high expectations amplify what's wrong
  bookingWeight: 2, // a regular's or VIP's review and mood count this many times over
  oldRoomMood: 4, // satisfaction from getting their old room back
  lostBelowLastReview: 1, // a regular whose review falls this far below their last won't be back
  vipPullWeight: 2,
};

/**
 * Mood (Status #14; Mood.ts): how a guest feels right now, from their
 * satisfaction. The bands sit where guests really are (most are content): an
 * irritated or angry guest shows a face, so it means something to fix.
 */
export const MOOD = {
  enabled: true,
  delighted: 62, // satisfaction at or above
  irritated: 47, // below
  angry: 42, // below
  delightedShopMult: 1.5, // a delighted guest spends more at the shop
};

type ChronotypeName = 'early' | 'regular' | 'night';
type MobilityName = 'brisk' | 'normal' | 'limited';
type SleepName = 'heavy' | 'normal' | 'light';
type RowdinessName = 'quiet' | 'normal' | 'rowdy';
type PartyKindName = 'solo' | 'business' | 'couple' | 'friends' | 'family';
type PurposeName = 'business' | 'sightseeing' | 'getaway';

/**
 * What guests like (and dislike) in a room (Preferences.ts): each rule is who
 * -- a purpose, a party kind or a trait -- a room feature, and how much it
 * adds to their review (and their mood during the stay). Mostly likes, so a
 * plain room is fine and a well-furnished one is better; the one dislike is a
 * couple given separate beds. A guest's total is capped at +/- maxFit.
 */
export const ROOM_PREFERENCES = {
  enabled: true,
  rules: [
    { who: 'business', feature: 'desk', weight: 0.4 },
    { who: 'couple', feature: 'kingBed', weight: 0.3 },
    { who: 'couple', feature: 'separateBeds', weight: -0.6 },
    { who: 'family', feature: 'tub', weight: 0.3 },
    { who: 'family', feature: 'sofaBed', weight: 0.2 },
    { who: 'friends', feature: 'lounge', weight: 0.3 },
    { who: 'getaway', feature: 'tub', weight: 0.3 },
    { who: 'getaway', feature: 'kingBed', weight: 0.2 },
    { who: 'getaway', feature: 'art', weight: 0.2 },
    { who: 'big_spender', feature: 'deluxe', weight: 0.3 },
  ] as Array<{ who: string; feature: string; weight: number }>,
  maxFit: 1,
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
  // Subtracted from calculateGuestReview's real score for an early-departure
  // walkout Booking (eng-review D4) -- not a flat fixed low value.
  walkoutIncidentPenalty: 2.0,
};

export const HOUSEKEEPING = {
  // Turnover cleaning: happens after guest checks out. Checkouts all land at
  // 11:00 and check-in opens at 14:00, so a standard turnover fits in between.
  turnoverDuration: {
    quick: 1,      // game-hours of a housekeeper's time in the room
    standard: 2,
    thorough: 3,
  } as Record<string, number>,

  turnoverCleanlinessResult: {
    quick: 60,     // restores cleanliness to 60
    standard: 85,  // restores to 85
    thorough: 100, // restores to 100
  } as Record<string, number>,

  turnoverCost: {
    quick: 12,     // supplies and laundry per room turnover
    standard: 22,
    thorough: 36,
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

  // Noise from the room directly above or below, as a fraction of a same-floor neighbor
  verticalAttenuation: 0.25,

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
  penaltyThreshold: 0.8,

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
    dailyCleanRoomsPerHour: 2, // rooms a housekeeper can daily-clean per hour
    workStartHour: 7, // nothing checks out before 11:00, so the day starts a little later...
    workEndHour: 21, // ...and ends before the night
  },
  frontDesk: {
    dailyWage: 70, // per front desk worker per day
    checkInsPerHour: 3, // guests a worker can check in per hour (needs a check-in desk to work at)
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
  visitReviewBonus: number; // review bonus for a guest who used this facility during their stay
  noiseOutput: number; // noise generated (uses proximity system)
  starPoints: number; // contribution to star rating
  spendPerVisit: number; // what a visiting guest spends (shop sales)
  capacity: number; // guests inside at once, at level 1
  visitHours: number; // how long a visit lasts
  visitChance: Array<[number, number, number]>; // [fromHour, toHour (exclusive), chance per guest per hour]
  requiredStars: number; // unlocks once the hotel's peak star rating reaches this
  seasonalMultiplier?: string; // if set, visits and their bonus go up in this season (FACILITY_VISITS)
  label: string;
  description: string;
  color: number; // tile color for rendering
}> = {
  gym: {
    buildCost: 8000,
    dailyOperatingCost: 30,
    visitReviewBonus: 0.3,
    noiseOutput: 0.3,
    starPoints: 0.5,
    spendPerVisit: 0,
    capacity: 4,
    visitHours: 1,
    visitChance: [[6, 9, 0.10], [9, 17, 0.03], [17, 22, 0.08]],
    requiredStars: 2,
    label: 'Gym',
    description: 'Fitness center. Guests work out mornings and evenings, and those who do review higher.',
    color: 0x27ae60,
  },
  restaurant: {
    buildCost: 15000,
    dailyOperatingCost: 50,
    visitReviewBonus: 0.45,
    noiseOutput: 0.5,
    starPoints: 1.0,
    spendPerVisit: 0,
    capacity: 8,
    visitHours: 1,
    visitChance: [[7, 10, 0.30], [12, 14, 0.15], [18, 22, 0.30]],
    requiredStars: 3,
    label: 'Restaurant',
    description: 'Breakfast, lunch and dinner. Diners review higher, but it is noisy next door.',
    color: 0xe67e22,
  },
  pool: {
    buildCost: 20000,
    dailyOperatingCost: 40,
    visitReviewBonus: 0.5,
    noiseOutput: 0.2,
    starPoints: 1.0,
    spendPerVisit: 0,
    capacity: 6,
    visitHours: 1.5,
    visitChance: [[9, 20, 0.06]],
    seasonalMultiplier: 'summer',
    requiredStars: 4,
    label: 'Pool',
    description: 'Open in the daytime. Swimmers review higher, especially in summer.',
    color: 0x3498db,
  },
  shop: {
    buildCost: 6000,
    dailyOperatingCost: 20,
    visitReviewBonus: 0.15,
    noiseOutput: 0.1,
    starPoints: 0.3,
    spendPerVisit: 26,
    capacity: 4,
    visitHours: 0.5,
    visitChance: [[9, 17, 0.03], [17, 22, 0.08]],
    requiredStars: 1,
    label: 'Shop',
    description: 'Gift shop. Guests who stop by spend money and review a little higher.',
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
  { id: 'five_stars', title: 'Five-Star Legend', description: 'Reach 5 stars', kind: 'star_rating', target: 5, deadlineDay: 480, reward: 25000 },
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
// review bonus a visit earns, star points, shop spending, operating cost, and
// how many guests fit at once.
export const FACILITY_LEVELS = [
  { requiredStars: 0, upgradeCostRate: 0, reviewMult: 1.0, starMult: 1.0, revenueMult: 1.0, operatingMult: 1.0, capacityMult: 1.0 },
  { requiredStars: 4, upgradeCostRate: 1.0, reviewMult: 1.5, starMult: 1.3, revenueMult: 1.5, operatingMult: 1.8, capacityMult: 1.5 },
  { requiredStars: 5, upgradeCostRate: 1.75, reviewMult: 2.0, starMult: 1.6, revenueMult: 2.0, operatingMult: 2.8, capacityMult: 2.0 },
];

// Guests visit facilities on a schedule. Each hour, each guest in their room
// may head out to a facility type that's open, by a chance that depends on the
// hour (FACILITY_CONFIG[type].visitChance), if one is a short enough walk away
// and has room. A guest uses each type at most once a day; the types they used
// add to their review (visitReviewBonus), and shop visits are sales.
// Guests go out for the day: sightseeing, meetings, the beach. Each hour a
// guest in their room may head out by these chances (per hour of day, scaled
// by trait), for a few hours, coming back by the evening -- through the street
// entrance and up to their room, like everyone else. Not on their last
// morning: they're packing to leave at checkout.
export const GUEST_OUTINGS = {
  leaveChance: [[8, 12, 0.14], [12, 16, 0.05]] as Array<[number, number, number]>, // [fromHour, toHour (exclusive), chance per hour]
  minHours: 2, // time out of the building
  maxHours: 7,
  latestReturnHour: 21, // back by 21:00
  traitMult: { normal: 1.0, light_sleeper: 1.0, big_spender: 0.7, party_guest: 1.3 } as Record<string, number>,
};

export const FACILITY_VISITS = {
  maxWalkHours: 0.75, // one way: guests won't walk further than this to a facility
  seasonalBonusMult: 1.5, // a facility's review bonus in its season (the pool in summer)
  seasonalChanceMult: { spring: 1.0, summer: 2.0, autumn: 0.7, winter: 0.3 } as Record<string, number>, // for seasonal facilities
  maxBonusPerStay: 1.2, // facility review bonus cap per guest
};

// Hotel valuation: property (build spend, discounted by stale decor) plus a
// multiple of recent revenue (the business as a going concern) plus net cash.
export const VALUATION = {
  revenueMultiple: 6, // x last-30-day revenue
  minDecorFactor: 0.5, // property value at 0 decor, as a fraction of build cost
};

export const DAILY_STATS_MAX_DAYS = 60; // covers the longest objective window (30 days) with room to spare

// One floor plan. Small enough that a growing hotel has to build upward, wide
// enough for two hallway rows with rooms on both sides (see STARTER_LAYOUT).
export const GRID = {
  width: 10,
  height: 6,
};

// Every floor starts as open hallway; building on a tile takes it out of the
// hallway. Hallways connect rooms and facilities to the street entrances and to
// elevators. A room's or facility's door must open onto a connected hallway
// for it to be usable -- keeping a path open is up to the player.

// Guests (and staff) come in off the street only through a street entrance, a
// walkable tile on the ground floor's outer edge. Every hotel starts with one.
export const ENTRANCE = {
  buildCost: 5000,
};

// Everyone walks at these paces, in the simulation and on screen alike. Staff
// walk from wherever they are to each job (StaffManager.ts), and that walk
// comes out of their hour: far-flung rooms and long elevator rides mean less
// cleaning and repair done. Guests stroll in from the street, to facilities,
// and out again (GuestMovement.ts, FacilityManager.ts).
export const TRAVEL = {
  hoursPerTile: 0.03, // staff: ~2 minutes per hallway tile
  guestHoursPerTile: 0.06, // guests stroll: ~4 minutes per tile
  hoursPerFloor: 0.15, // ~9 minutes per floor of elevator ride, for everyone
};

// A staff closet is an extra staff base on its floor: housekeeping and
// maintenance start (and wait) there, cutting walks to nearby rooms.
export const CLOSET = {
  buildCost: 2500,
};

// A staff break room is where on-shift staff wait between jobs: idle
// housekeepers and maintenance workers head there instead of standing in the
// hallway, and front desk staff without a seat at a desk wait there too. Like
// a closet, it's also a staff base (the lobby-to-room walk estimates use it).
// Off shift, staff go home through the street entrance.
export const BREAK_ROOM = {
  buildCost: 3500,
  seats: 6, // staff drawn inside the tile; more than this still fit, just overlapping
};

// Guests check in at a desk on the ground floor; each desk seats a limited
// number of front desk staff. No reachable desk, no check-ins.
export const DESK = {
  buildCost: 4000,
  staffPerDesk: 2,
};

// The template floor layout the bots (and old-save migration) follow: two
// full-width hallway rows kept clear, with rooms above and below each (rooms
// on rows 0, 2, 3, 5, doors facing the hallway), joined by a short spine at
// the right end so both rows connect to the elevator on every floor. Players
// can build any layout they like.
const STARTER_HALLWAY_ROWS = [1, 4];
export const STARTER_LAYOUT = {
  hallwayTiles: [
    ...STARTER_HALLWAY_ROWS.flatMap(y => Array.from({ length: GRID.width }, (_, x): [number, number] => [x, y])),
    [GRID.width - 1, 2], [GRID.width - 1, 3],
  ] as Array<[number, number]>,
  entranceTile: [0, 4] as [number, number], // ground floor, the free street entrance: the end of the second corridor
  deskTiles: [[1, 3], [2, 3]] as Array<[number, number]>, // ground floor, just inside the street entrance (staff stand at (1,4)/(2,4)); the first comes free
  closetTile: [3, 0] as [number, number], // upper floors, beside the elevator shafts
  elevatorTiles: [[0, 0], [1, 0], [2, 0]] as Array<[number, number]>, // kept clear for shafts
};

// Floors stack on the ground floor (floor 0). Each new floor costs more than the
// last; rooms on higher floors command a view premium on their fair price.
export const FLOORS = {
  max: 8,
  baseCost: 15000, // cost of the first floor above ground
  costGrowth: 1.35, // each further floor costs this much more than the previous one
  viewPremiumPerFloor: 0.04, // +4% fair price per floor above ground
};

// Elevators are shafts: one tile, the same tile on every floor. Upper-floor rooms
// can't be booked without one; too few for the upper-floor rooms they serve and
// guests up there start complaining about the wait.
export const ELEVATOR = {
  buildCost: 10000,
  dailyOperatingCost: 25, // scaled by prestige upkeep like other facilities
  roomsServed: 16, // upper-floor rooms one elevator handles comfortably
  maxWaitPenalty: 2.0, // review penalty (0-10 scale) at double the comfortable load or worse
};
