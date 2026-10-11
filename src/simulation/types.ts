export type RoomType = 'standard' | 'deluxe' | 'suite';
export type FacilityType = 'gym' | 'restaurant' | 'pool' | 'shop';
export type TileType = RoomType | FacilityType;
export type GuestTrait = 'normal' | 'light_sleeper' | 'big_spender' | 'party_guest';
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
  lastDailyCleanDay: number; // last day daily housekeeping ran
  decor: number; // 0-100, how fresh the furnishings are; fades daily, restored by renovation
  renovationHoursRemaining: number; // hours left while status is 'renovating'
  dailyCleanHoursRemaining: number; // a queued daily clean (housekeeper-hours incl. walk), 0 = none
}

export interface HousekeepingConfig {
  turnoverQuality: CleaningQuality; // how thoroughly to clean between guests
  dailyCadence: DailyCleaningCadence; // how often to clean during a stay
}

export interface StaffConfig {
  maintenanceWorkers: number; // 0 = manual repair only
  housekeepers: number; // 0 = no cleaning happens
  frontDesk: number; // staff at check-in desks (each desk seats DESK.staffPerDesk)
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
}

export interface Booking {
  id: string;
  roomId: string;
  guestId: string;
  nightRate: number;
  reviewScore: number; // 0-10 guest review score
  satisfactionAtCheckout: number; // 0-100, feeds the word-of-mouth rolling window
}

/** A guest profile remembered after a satisfied checkout, for the return-guest mechanic. */
export interface ReturningGuestProfile {
  name: string;
  trait: GuestTrait;
  roomType: RoomType; // cosmetic/log-flavor only -- does not influence matchGuestToRoom
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
}

/** A temporary arrival-multiplier penalty from a Review Goes Semi-Viral incident. */
export interface ReputationPenalty {
  multiplier: number; // < 1.0, applied to arrivalsPerDay while active
  hoursRemaining: number;
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
}

export interface TickResult {
  state: HotelState;
  events: GameEvent[];
}

export interface GameEvent {
  type: 'guest_arrived' | 'guest_returned' | 'guest_departed' | 'guest_walked_out' | 'guest_turned_away' | 'guest_impatient' | 'review_score_changed' | 'star_rating_changed' | 'season_changed' | 'bankrupt' | 'room_broken' | 'construction_noise' | 'room_cleaned' | 'daily_cleaning' | 'maintenance_repair' | 'noise_complaint_filed' | 'noise_complaint_escalated' | 'mid_stay_breakdown_resolved' | 'loan_payment' | 'loan_paid_off' | 'objective_completed' | 'objective_failed' | 'build_unlocked' | 'renovation_complete' | 'campaign_ended' | 'floor_built';
  message: string;
  data?: Record<string, unknown>;
}
