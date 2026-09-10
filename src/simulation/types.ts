export type RoomType = 'standard' | 'deluxe' | 'suite';
export type FacilityType = 'gym' | 'restaurant' | 'pool' | 'shop';
export type TileType = RoomType | FacilityType;
export type GuestTrait = 'normal' | 'light_sleeper' | 'big_spender' | 'party_guest';
export type RoomStatus = 'vacant' | 'occupied' | 'cleaning';
export type CleaningQuality = 'quick' | 'standard' | 'thorough';
export type DailyCleaningCadence = 'daily' | 'every_other_day' | 'none';
export type AmenityTier = 'basic' | 'premium' | 'luxury';

export interface Room {
  id: string;
  type: RoomType;
  gridX: number;
  gridY: number;
  pricePerNight: number;
  condition: number; // 0-100, physical wear
  cleanliness: number; // 0-100, how clean the room is
  status: RoomStatus;
  guestId?: string;
  cleaningHoursRemaining: number; // hours left in turnover cleaning
  lastDailyCleanDay: number; // last day daily housekeeping ran
}

export interface HousekeepingConfig {
  turnoverQuality: CleaningQuality; // how thoroughly to clean between guests
  dailyCadence: DailyCleaningCadence; // how often to clean during a stay
}

export interface StaffConfig {
  maintenanceWorkers: number; // 0 = manual repair only
  housekeepers: number; // 0 = no cleaning happens
  frontDesk: number; // 0 = self-service kiosk (very slow check-in)
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
  condition: number; // 0-100
}

export interface NoiseSource {
  gridX: number;
  gridY: number;
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
}

export interface TickResult {
  state: HotelState;
  events: GameEvent[];
}

export interface GameEvent {
  type: 'guest_arrived' | 'guest_returned' | 'guest_departed' | 'guest_walked_out' | 'guest_turned_away' | 'guest_impatient' | 'review_score_changed' | 'star_rating_changed' | 'season_changed' | 'bankrupt' | 'room_broken' | 'construction_noise' | 'room_cleaned' | 'daily_cleaning' | 'maintenance_repair' | 'noise_complaint_filed' | 'noise_complaint_escalated' | 'mid_stay_breakdown_resolved';
  message: string;
  data?: Record<string, unknown>;
}
