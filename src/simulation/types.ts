import type { FurnitureKind, Tier, Rot, PresetId, ArrangementId } from '../config/furniture';
import type { StaffIdentity, Hospitality, StaffSpecialty } from './StaffProfiles';
export type RoomType = 'standard' | 'deluxe' | 'suite';
export type FacilityType = 'gym' | 'restaurant' | 'pool' | 'shop';
export type TileType = RoomType | FacilityType;
export type GuestTrait = 'normal' | 'light_sleeper' | 'big_spender' | 'party_guest';

/** Who a booking is for: one person (on holiday or on business), a couple, friends, or a family. */
export type PartyKind = 'solo' | 'business' | 'couple' | 'friends' | 'family';
/** The people in one booking. A family's members beyond the first two are children. */
export interface Party {
  kind: PartyKind;
  size: number;
}
/** Why a booking is here: on business, to see the sights, or to get away (see Purpose.ts). */
export type Purpose = 'business' | 'sightseeing' | 'getaway' | 'event';

/** A guest's daily rhythm: up early, regular, or up late (see Profile.ts). */
export type Chronotype = 'early' | 'regular' | 'night';
/** How fast a guest walks. */
export type Mobility = 'brisk' | 'normal' | 'limited';
/** How much night noise bothers a guest. */
export type SleepSensitivity = 'heavy' | 'normal' | 'light';
/** How much noise a guest makes. */
export type Rowdiness = 'quiet' | 'normal' | 'rowdy';
/** How long a guest will wait in line at the front desk (see DeskQueue.ts). */
export type Patience = 'patient' | 'normal' | 'impatient';
/** How a guest complains: they speak up, they complain when it's bad, or they keep it to themselves (see Complaints.ts). */
export type Voice = 'vocal' | 'typical' | 'stoic';
/** When a guest wants their room cleaned: only while they're out (do not disturb), as the hotel does it, or every day (see CleaningPreference.ts). */
export type HousekeepingPreference = 'dnd' | 'standard' | 'makeup';
/** Who a guest is, beyond their trip: rolled once when they arrive and kept (see Profile.ts). */
export interface GuestProfile {
  chronotype: Chronotype;
  mobility: Mobility;
  sleep: SleepSensitivity;
  rowdiness: Rowdiness;
  checkoutHour: number; // when they'd like to leave on their last morning (an early bird's 07-10; 11 otherwise; a night owl asks for late checkout on top)
  favorite?: FacilityType | 'none'; // the facility they seek out (absent on 1a-era profiles: no preference either way)
  housekeeping?: HousekeepingPreference; // when they want their room cleaned (absent on older profiles: standard)
  patience?: Patience; // how long they'll wait in line (absent on older profiles: normal)
  voice?: Voice; // how they complain (absent on older profiles: typical)
  spending?: SpendingStyle; // how they spend (absent on older profiles: a big spender splurges, anyone else standard)
}
/** How a guest spends (see Spending.ts). */
export type SpendingStyle = 'thrifty' | 'standard' | 'splurger';
/** How a guest feels right now, from their satisfaction (see Mood.ts). */
export type Mood = 'delighted' | 'content' | 'irritated' | 'angry';
/** A guest's history with the hotel (see Loyalty.ts): the same person across stays. */
export interface GuestLoyalty {
  personId: string; // the id of their first booking: the same person, stay after stay
  stays: number; // this stay included: 1 first visit, 2 returning, 3-4 regular, 5+ VIP
  lastRoomId?: string; // the room they had last time (a regular asks for it again)
  lastRoomType?: RoomType;
  lastReview?: number;
  oldRoom?: boolean; // they got their old room back this stay
}
/** What the front desk does when a neighbour complains about a guest's visitors: ask them to leave, or let them stay. */
export type VisitorPolicy = 'ask' | 'allow';
/** Who a spotlight guest is: a travel writer or a celebrity (see Spotlight.ts). */
export type SpotlightKind = 'writer' | 'celebrity';
/** Whether the hotel holds a suite for an announced spotlight guest: yes, or not. */
export type SpotlightHold = 'hold' | 'none';
/** Whether a night owl may stay till the late checkout: no, yes, or yes for a fee. */
export type LateCheckoutPolicy = 'deny' | 'free' | 'fee';
export type RoomStatus = 'vacant' | 'occupied' | 'cleaning' | 'renovating';
export type CleaningQuality = 'quick' | 'standard' | 'thorough';
export type DailyCleaningCadence = 'daily' | 'every_other_day' | 'none';
export type AmenityTier = 'basic' | 'premium' | 'luxury';

/** Which side of its tile a room's door is on. */
export type Direction = 'up' | 'right' | 'down' | 'left';

export interface Room {
  id: string;
  type: RoomType;
  gridX: number;
  gridY: number;
  floor: number; // 0 = ground floor
  door: Direction; // must open onto a hallway connected to the street for the room to be usable
  pricePerNight: number;
  condition: number; // 0-100, physical wear
  cleanliness: number; // 0-100, how clean the room is
  status: RoomStatus;
  guestId?: string;
  cleaningHoursRemaining: number; // hours left in turnover cleaning
  cleaningHoursTotal?: number; // the whole turnover's hours, for showing how far along it is (absent on older saves)
  cleanedBy?: { id: string; name: string; style: string; day: number };
  damageReportedBy?: string;
  lastDailyCleanDay: number; // last day daily housekeeping ran
  decor: number; // 0-100, how fresh the furnishings are; fades daily, restored by renovation
  renovationHoursRemaining: number; // hours left while status is 'renovating'
  dailyCleanHoursRemaining: number; // a queued daily clean (housekeeper-hours incl. walk), 0 = none
  // What's in the room: its layout and furniture. Its category (type) is worked
  // out from this (RoomProfile.ts). Absent on rooms from before furniture: they
  // get their type's preset.
  furnishing?: Furnishing;
  pendingRefit?: Furnishing; // a refit booked for after the guest leaves
  refitting?: { decorAfter: number }; // set while the room is closed for a refit (status 'renovating')
}

/**
 * A piece of furniture in a room: what it is, how nice (tier 1 basic, 2
 * premium), and where -- the door-local cell of its top-left, turned `rot`
 * quarter turns (a wall piece: which edge of its cell it hangs on).
 */
export interface FurnitureItem {
  id: string; // stable within the room: 'bed', 'bed-2', 'bath', 'tv'
  kind: FurnitureKind;
  tier: Tier;
  x: number;
  y: number;
  rot: Rot;
  length?: number; // its length when it comes in more than one (the long bathroom), unturned
}

/** How a room is laid out and furnished. */
export interface Furnishing {
  preset: PresetId; // what it was laid out from
  arrangement: ArrangementId; // where the preset put the bathroom
  mirrored: boolean;
  custom?: boolean; // pieces moved, added or removed by hand: no longer the preset's layout
  items: FurnitureItem[];
}

export interface HousekeepingConfig {
  turnoverQuality: CleaningQuality; // how thoroughly to clean between guests
  dailyCadence: DailyCleaningCadence; // how often to clean during a stay
}

export interface StaffConfig {
  maintenanceWorkers: number; // 0 = manual repair only
  housekeepers: number; // 0 = no cleaning happens
  frontDesk: number; // total clerks employed; named clerks cover their own shift (each desk seats DESK.staffPerDesk)
}

export interface Guest {
  id: string;
  name: string;
  budget: number;
  stayLength: number; // nights
  trait: GuestTrait;
  satisfaction: number; // 0-100
  checkInDay: number;
  isReturning: boolean; // true if this arrival was pulled from returningGuestPool
  hadNoiseComplaint: boolean; // cooldown: one Noise Complaint arc per guest per stay
  // Who the booking is for (see Party.ts; absent on older saves: one person).
  // One Guest is one booking: one room, one trip, one review, the whole party together.
  party?: Party;
  // Why they're here (see Purpose.ts; absent on older saves, or with purposes
  // off: no purpose, and nothing about them changes with it)
  purpose?: Purpose;
  eventStay?: { name: string; endDay: number }; // leaves on the morning after this event's last day
  // Who they are, beyond the trip (see Profile.ts; absent on older saves, or with
  // profiles off: they do what every guest did before)
  profile?: GuestProfile;
  // The night noise they've slept through (or not) this stay: the sum of the
  // noise over the threshold in their sleep hours, how many nights it woke
  // them, and the last of those nights (see NoiseManager.accrueNightNoise)
  nightNoise?: { exposure: number; woken: number; lastWokenNight: number; lastNight?: number }; // lastNight: the noise over their threshold the last night it woke them
  // Who they are to the hotel: absent for a first stay (see Loyalty.ts)
  loyalty?: GuestLoyalty;
  // Days their favourite facility let them down (missing, or full): the last such day and how many
  favoriteMisses?: { day: number; count: number };
  // Outings in place of their missing favourite (the beach, a meal out): today's count and the hour of the last, so a fan goes at most twice a day, a few hours apart
  favoriteOutings?: { day: number; today: number; lastAt: number };
  // Where the guest is going (walking in from the street, out to a facility and
  // back, to a new room): absolute game-hour legs. Once the last leg ends -- or
  // with no trip -- the guest is in their room. See Movement.ts.
  trip?: Leg[] | null;
  tripKind?: 'arrival' | 'visit' | 'move' | 'outing' | 'complaint'; // what the trip is for (an arriving guest isn't in the building before it starts)
  // Facilities this guest actually used this stay (best level used, and the
  // day of the last visit): the facility part of their review. See FacilityManager.ts.
  facilitiesUsed?: Partial<Record<FacilityType, { level: number; day: number; today?: number; visits?: number; lastAt?: number }>>; // (today/visits/lastAt: their favourite only)
  // Daily cleans this stay: done, and missed (still waiting when the housekeepers went home). See CleaningPreference.ts.
  cleans?: { done: number; missed: number };
  // The night they have friends round (see Visitors.ts): the day it began, how many came, and when the front desk asked them to leave
  hostedNight?: { day: number; visitors: number; keptDownAt?: number; complainedBy?: string };
  // How long they stood in line to check in (hours; see DeskQueue.ts)
  checkInWait?: number;
  checkInPriceTolerance?: number; // agreed at booking; an upseller still respects it
  service?: {
    contacts: Array<{ staffId: string; name: string; kind: 'check_in' | 'complaint' | 'daily_clean'; at: number; hospitality: Hospitality; mood: number }>;
    hospitalityMood: number;
    checkedIn?: boolean;
    complained?: boolean;
    lastDailyCleanDay?: number;
    concierge?: { staffId: string; name: string; at: number };
    upsell?: { staffId: string; name: string; fromRoomId: string; fromType: RoomType; toType: RoomType; extraPerNight: number; at: number };
  };
  // Their complaint this stay (see Complaints.ts): what about, in person or by phone, and when it was heard (absent: on their way)
  complaint?: { about: string; cause?: string; via: 'desk' | 'phone'; at?: number };
  spent?: { shop: number; restaurant: number }; // what they've spent on site this stay (see Spending.ts)
  dinnersOut?: { day: number; count: number }; // a thrifty guest's dinners in town this stay (once a day)
  spotlight?: { kind: SpotlightKind; rate?: number; until?: number }; // a spotlight guest, what they pay over the room's price, and (moved off the top floor) the day it stopped (see Spotlight.ts)
}

/** A tile in the building: (gridX, gridY) on a floor. A `door` means the tile is entered through that side only (a room or facility). */
export interface TilePos {
  gridX: number;
  gridY: number;
  floor: number;
  door?: Direction;
}

/**
 * One stretch of someone's time, in absolute game hours ((day - 1) * 24 + hour,
 * plus the fraction of the hour). People are drawn wherever their legs put them
 * at the current time, and the simulation acts on the same legs -- so what is
 * shown is what happens.
 */
export interface WalkLeg {
  kind: 'walk';
  start: number;
  end: number;
  path: TilePos[]; // tile by tile; consecutive tiles on different floors are an elevator ride
  hoursPerTile: number; // walking pace (a ride costs TRAVEL.hoursPerFloor per floor)
}

export type StayActivity = 'clean' | 'repair' | 'rest' | 'wait' | 'check_in' | 'inquire' | 'visit' | 'in_room' | 'away' | 'complain' | 'desk';

export interface StayLeg {
  kind: 'stay';
  start: number;
  end: number;
  at: TilePos;
  activity: StayActivity;
  placeId?: string; // the room, facility, desk, or break room being stayed in
  job?: 'turnover' | 'daily' | 'repair'; // what the stay works on, for staff
  workRate?: number; // work units per hour, fixed when this leg was planned
  credited?: boolean; // a facility visit whose bonus and sale have been counted (once the guest got there)
  out?: 'beach' | 'breakfast' | 'lunch' | 'dinner'; // an outing instead of a facility the hotel doesn't have
  lane?: string; // the front desk clerk ("deskId:seat") a check-in or complaint takes, and whose line a wait is in (see DeskQueue.ts)
  serviceStaffId?: string; // the employee who actually supplies this service
  serviceName?: string;
  serviceHospitality?: Hospitality;
  serviceSpecialty?: StaffSpecialty;
  repairTarget?: number; // condition goal agreed when this repair was planned
  preventive?: boolean; // occupied-room work, confined to the party's away window
}

export type Leg = WalkLeg | StayLeg;

/** Someone in the building who isn't (or is no longer) a checked-in guest: walking out after checking out, or turned away at the desk. */
export interface Walker {
  id: string;
  trait: GuestTrait;
  isReturning: boolean;
  reason: 'checked_out' | 'walked_out' | 'turned_away' | 'impatient' | 'visitor'; // visitor: a hosted night's friends (see Visitors.ts)
  trip: Leg[];
  party?: Party; // the whole party walks it (absent: one person)
  purpose?: Purpose; // why they came (for their colour)
  profile?: GuestProfile; // who they are (their pace, their quirk icon)
  guestId?: string; // the booking they were (someone checking out, not someone turned away)
  name?: string;
  stays?: number; // their stays with the hotel (the ring's colour)
  mood?: Mood; // how they left
  hostId?: string; // a visitor: the guest they've come to see
  waited?: number; // gave up in line at the front desk: how long they waited (hours)
  wanted?: PartyKind; // gave up in line: the party they came as, if they'd booked a room for fewer
  spent?: number; // checked out: what they spent on site this stay
  spotlight?: { kind: SpotlightKind }; // a spotlight guest checked out (their mark stays on them)
}

export type FrontDeskShift = 'early' | 'late' | 'night';
export type StaffRole = 'housekeeper' | 'maintenance' | 'front_desk';

/** A housekeeper or maintenance worker, as of the last hour boundary. */
export interface StaffMember extends StaffIdentity {
  id: string;
  role: StaffRole;
  at: TilePos | null; // where they are; null = off site
  roomId?: string; // the room they were working on when the hour ended (they keep at it)
  carry?: WalkLeg; // a walk still under way when the hour ended
  leaving?: boolean; // let go: walks out through the street entrance next hour
  shift?: FrontDeskShift;
  deskLane?: string;
  hiredAt?: number;
  dismissedAt?: number;
  restUntil?: number;
}

/** Every housekeeper's and maintenance worker's hour, planned at its start; the tick credits exactly the work in it. */
export interface StaffPlan {
  start: number; // absolute game hour the plan covers ([start, start + 1))
  itineraries: StaffItinerary[];
}

export interface StaffItinerary {
  staffId: string;
  legs: Leg[];
  end: Pick<StaffMember, 'at' | 'roomId' | 'carry' | 'deskLane'>;
}

export interface Booking {
  id: string;
  roomId: string;
  guestId: string;
  nightRate: number;
  reviewScore: number; // 0-10 guest review score
  satisfactionAtCheckout: number; // 0-100, feeds the word-of-mouth rolling window
  weight?: number; // how much this booking counts in the review and word-of-mouth windows (a regular's or a VIP's: 2)
}

/** A guest profile remembered after a satisfied checkout, for the return-guest mechanic. */
export interface ReturningGuestProfile {
  name: string;
  trait: GuestTrait;
  roomType: RoomType; // cosmetic/log-flavor only -- does not influence matchGuestToRoom
  // With loyalty on (Loyalty.ts): the same person, who they are, and what they had last time
  personId?: string;
  stays?: number; // stays so far
  profile?: GuestProfile;
  lastRoomId?: string;
  lastReview?: number;
  dueDay?: number; // not back before this day
}

export type IncidentType = 'noise_complaint' | 'mid_stay_breakdown';
export type IncidentStage = 'active' | 'escalated' | 'resolved';

export interface ActiveIncident {
  id: string;
  type: IncidentType;
  guestId: string; // the affected/complaining guest
  culpritGuestId?: string; // noise_complaint only (D9) -- the loudest contributing neighbor
  roomId: string;
  stage: IncidentStage;
  hoursRemaining: number; // grace period countdown before escalation
  chainId: string; // links this incident's stages to their StoryLogEntry thread
  about?: 'visitors'; // a noise complaint about a hosted night's visitors (see Visitors.ts)
}

export interface StoryLogEntry {
  id: string;
  day: number;
  hour: number;
  type: string; // e.g. 'noise_complaint', 'noise_complaint_escalated', 'regular_returns'
  guestName?: string;
  roomId?: string;
  message: string; // player-facing text, already includes any room reference
  chainId?: string; // shared across an incident's stages so the UI renders one thread
}

export interface Facility {
  id: string;
  type: FacilityType;
  gridX: number;
  gridY: number;
  floor: number; // 0 = ground floor
  door: Direction; // like a room's: must open onto a connected hallway for the facility to count
  condition: number; // 0-100
  decor: number; // 0-100, same meaning as Room.decor
  level: number; // 1-3, raised by upgradeFacility
}

export type FixtureType = 'entrance' | 'desk' | 'closet' | 'breakroom';

/** Single-tile fixtures: street entrances (ground floor edge, walkable), check-in desks (ground floor only), staff closets, and staff break rooms. */
export interface Fixture {
  id: string;
  type: FixtureType;
  gridX: number;
  gridY: number;
  floor: number;
}

/** An elevator shaft: occupies (gridX, gridY) on every floor. */
export interface Elevator {
  id: string;
  gridX: number;
  gridY: number;
}

export interface NoiseSource {
  gridX: number;
  gridY: number;
  floor: number;
  intensity: number;
  remainingHours: number;
  type: 'build' | 'demolish' | 'renovate';
}

export interface HotelState {
  nextStaffSerial?: number;
  staffCandidatesUsed?: { day: number; ids: string[] };
  staffPayroll?: Record<string, Record<string, number>>; // earned base wages, retained until the next midnight
  eventGuestsAnnouncedDay?: number;
  lateCheckout?: LateCheckoutPolicy; // absent: deny (see Profile.lateCheckoutPolicy)
  // Today at the front desk so far (for the Staff panel): checked in, hours waited, the longest wait, gave up in line, complaints heard
  deskToday?: { day: number; checkedIn: number; waitHours: number; longestWait: number; gaveUp: number; complaints: number };
  visitorPolicy?: VisitorPolicy; // absent: ask (see Visitors.visitorPolicy)
  spotlightHold?: SpotlightHold; // absent: hold (see Spotlight.holdPolicy)
  spotlight?: SpotlightPlan; // this week's spotlight guest, from the Monday roll until they've gone
  // Today's let-downs at facilities, so far (recorded in dailyStats at the end of the day)
  facilityDemand?: { day: number; wanted: Partial<Record<FacilityType, number>>; full: Partial<Record<FacilityType, number>>; tooFar: Partial<Record<FacilityType, number>>; fullAt?: Record<string, number> };
  cash: number;
  day: number;
  hour: number; // 0-23
  rooms: Room[];
  facilities: Facility[]; // building amenities (gym, restaurant, pool, shop)
  guests: Guest[]; // currently checked-in guests
  bookings: Booking[]; // completed bookings (for rating history)
  noiseSources: NoiseSource[]; // temporary construction noise
  housekeeping: HousekeepingConfig;
  staff: StaffConfig;
  amenities: Record<RoomType, AmenityTier>;
  starRating: number; // 1-5, hotel classification (what you have)
  reviewScore: number; // 0-10, guest satisfaction (how you perform)
  totalTurnedAway: number;
  totalRevenue: number;
  activeIncidents: ActiveIncident[];
  returningGuestPool: ReturningGuestProfile[]; // capped, oldest dropped first
  storyLog: StoryLogEntry[]; // capped by chain (see StoryGenerator.ts)
  activeReputationPenalties: ReputationPenalty[]; // Review Goes Semi-Viral's temporary arrival penalty
  peakStarRating: number; // highest star rating ever reached -- drives build unlocks, never decreases
  loan: Loan;
  objectives: ObjectiveProgress;
  dailyStats: DailyStat[]; // one entry per finished day, capped at DAILY_STATS_MAX_DAYS
  activeCampaign: ActiveCampaign | null; // at most one marketing campaign runs at a time
  floorCount: number; // built floors, including the ground floor (>= 1)
  elevators: Elevator[];
  fixtures: Fixture[]; // street entrances, desks, closets, break rooms (every tile with nothing built on it is hallway)
  daysAtFiveStars: number; // consecutive end-of-day snapshots at 5 stars (legacy goals)
  staffRoster?: StaffMember[];
  frontDeskRosterReady?: boolean;
  staffPayrollThrough?: Record<string, number>;
  staffPlan?: StaffPlan | null; // this hour's plan for them, made at the last hour boundary
  walkers?: Walker[]; // people walking out who are no longer guests
  onSite?: OnSiteTakings; // shop and restaurant takings so far (spending styles on)
}

export interface ActiveCampaign {
  id: string; // key into MARKETING.campaigns
  hoursRemaining: number;
}

/** The opening bank loan: a fixed weekly payment covers interest first, then principal. */
export interface Loan {
  balance: number; // principal still owed
  weeklyPayment: number;
  missedPayments: number; // payments made while cash went (or already was) negative
}

export type ObjectiveOutcome = 'completed' | 'failed';

/** Owner objectives are a fixed sequence (OBJECTIVES in balance.ts); this tracks where the player is. */
export interface ObjectiveProgress {
  currentIndex: number; // index into OBJECTIVES; === OBJECTIVES.length once all are resolved
  outcomes: ObjectiveOutcome[]; // one per resolved objective, in order
}

/** End-of-day snapshot, used by objectives that look back over a window of days. */
export interface DailyStat {
  day: number;
  occupancy: number; // 0-1, rooms occupied overnight
  totalRevenue: number; // HotelState.totalRevenue at end of day (cumulative)
  valuation: number; // hotel valuation at end of day (see ValuationManager)
  reviewScore?: number; // review score at end of day (absent in saves from before it was recorded)
  // Guests let down by a facility that day (favourite facilities): it isn't built (wanted), it was full, or too far to walk
  wanted?: Partial<Record<FacilityType, number>>;
  full?: Partial<Record<FacilityType, number>>;
  tooFar?: Partial<Record<FacilityType, number>>;
  onSite?: OnSiteTakings; // HotelState.onSite at end of day (cumulative; absent before spending styles)
}

/** Takings on site, cumulative: at the shop, at the restaurant, and how much of it from big spenders. */
export interface OnSiteTakings { shop: number; restaurant: number; splurgers: number }

/** A temporary arrival-multiplier penalty from a Review Goes Semi-Viral incident (or a boost, from a travel writer's write-up). */
export interface ReputationPenalty {
  multiplier: number; // < 1.0, applied to arrivalsPerDay while active (> 1.0 for a write-up)
  hoursRemaining: number;
  kind?: 'write_up'; // a travel writer's glowing write-up (absent: a bad review spreading)
}

/** A spotlight guest, planned on a Monday (see Spotlight.ts). */
export interface SpotlightPlan {
  kind: SpotlightKind;
  week: number;
  salt: string; // the latest booking at the roll (so every game's weeks differ)
  announceDay: number;
  arrivalDay: number;
  arrivalHour: number;
  status: 'planned' | 'announced' | 'staying' | 'done';
  roomId?: string; // the suite held for them (announced), or theirs (staying)
  chosen?: boolean; // the held suite was picked by hand
  released?: boolean; // the hold was let go by hand (for this one)
  guestId?: string;
  chainId: string; // their story chain
  outcome?: 'write_up' | 'pan' | 'review';
}

export interface SimulationSummary {
  days: number;
  finalCash: number;
  avgReviewScore: number;
  avgOccupancy: number;
  totalRevenue: number;
  totalTurnedAway: number;
  wentBankrupt: boolean;
  reviewScoreHistory: number[];
  finalStarRating: number;
  finalRoomCount: number;
  objectivesCompleted: number;
  objectivesFailed: number;
  loanBalance: number;
  finalValuation: number;
  bankruptDay: number | null;
  // Who booked, by the party they were (a family that took a double counts as a family)
  partyArrivals: Record<PartyKind, number>;
  partyTurnedAway: Record<PartyKind, number>; // turned away for any reason
  partiesBookedSmaller: number; // booked as one or two because nothing free fit them
  familyTurnAwayRate: number; // families not given a room for the family: turned away, or booked smaller
  // How well rooms suited the guests who stayed (Preferences.ts): the mean room
  // fit over checkouts, and the share who liked or disliked something
  avgRoomFit: number;
  likedShare: number;
  dislikedShare: number;
  returningArrivals: number; // guests who came back for another stay
  avgNoisePenalty: number; // the mean noise part of a checkout's review
  regularArrivals: number; // returning guests on their third stay or more
  vipArrivals: number; // ... their fifth or more
  favoriteMisses: number; // days guests' favourite facility let them down
  moodShares: Record<Mood, number>; // how guests left
  // Spotlight guests (Spotlight.ts): travel writers (their reviews summed, write-ups, bad ones spreading), celebrities (and what they paid), and those who found no room
  spotlights: { writers: number; writeUps: number; pans: number; writerScore: number; celebrities: number; celebrityPaid: number; noRoom: number };
}

export interface TickResult {
  state: HotelState;
  events: GameEvent[];
}

export interface GameEvent {
  type: 'staff_notice' | 'guest_arrived' | 'guest_returned' | 'guest_departed' | 'guest_walked_out' | 'guest_turned_away' | 'party_turned_away' | 'guest_impatient' | 'review_score_changed' | 'star_rating_changed' | 'season_changed' | 'bankrupt' | 'room_broken' | 'construction_noise' | 'room_cleaned' | 'daily_cleaning' | 'maintenance_repair' | 'noise_complaint_filed' | 'noise_complaint_escalated' | 'mid_stay_breakdown_resolved' | 'loan_payment' | 'loan_paid_off' | 'objective_completed' | 'objective_failed' | 'build_unlocked' | 'renovation_complete' | 'campaign_ended' | 'floor_built' | 'regular_lost' | 'visitors_asked_to_leave' | 'dnd_rooms_left' | 'guest_complained' | 'spotlight_announced' | 'spotlight_arrived' | 'spotlight_review';
  message: string;
  data?: Record<string, unknown>;
}
