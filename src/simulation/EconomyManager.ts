import type { HotelState, GameEvent, RoomType } from './types.js';
import { ECONOMY, REVIEW, AMENITIES, FACILITY_CONFIG } from '../config/balance.js';
import type { DepartureResult } from './GuestManager.js';

export interface EconomyResult {
  cashDelta: number;
  events: GameEvent[];
}

export function processRevenue(
  state: HotelState,
  departures: DepartureResult
): EconomyResult {
  const result: EconomyResult = { cashDelta: 0, events: [] };

  // Revenue from checkouts
  for (const dep of departures.departed) {
    const payment = dep.booking.nightRate * dep.guest.stayLength;
    result.cashDelta += payment;
  }

  return result;
}

export function processDailyCosts(state: HotelState): EconomyResult {
  const result: EconomyResult = { cashDelta: 0, events: [] };

  // Operating costs per room
  const operatingCosts = state.rooms.length * ECONOMY.dailyOperatingCostPerRoom;
  result.cashDelta -= operatingCosts;

  // In-room amenity costs per room (based on tier per room type)
  for (const room of state.rooms) {
    const tier = state.amenities[room.type];
    const tierConfig = AMENITIES.tiers[tier];
    if (tierConfig) {
      result.cashDelta -= tierConfig.dailyCostPerRoom;
    }
  }

  // Facility operating costs and revenue
  for (const facility of state.facilities) {
    const fConfig = FACILITY_CONFIG[facility.type];
    if (fConfig) {
      result.cashDelta -= fConfig.dailyOperatingCost;
      // Shops generate revenue per guest
      if (fConfig.dailyRevenue > 0) {
        const guestCount = state.guests.length;
        result.cashDelta += fConfig.dailyRevenue * guestCount;
      }
    }
  }

  // Debt interest
  if (state.cash < 0) {
    const interest = Math.abs(state.cash) * ECONOMY.debtInterestRate;
    result.cashDelta -= interest;
  }

  return result;
}

/**
 * Calculate the hotel's review score (0-10) from recent guest reviews.
 * This is experiential, not structural.
 */
export function updateReviewScore(state: HotelState): number {
  if (state.bookings.length === 0) {
    return ECONOMY.initialReviewScore;
  }

  // Rolling window
  const recentBookings = state.bookings.slice(-REVIEW.reviewWindowBookingCount);
  if (recentBookings.length === 0) return ECONOMY.initialReviewScore;

  const avg = recentBookings.reduce((sum, b) => sum + b.reviewScore, 0) / recentBookings.length;
  return Math.max(REVIEW.minScore, Math.min(REVIEW.maxScore, avg));
}

export interface EarlyDepartureSettlement {
  revenue: number;
  comp: number;
  cashDelta: number;
}

/**
 * Early Departure & Refund Mechanic: revenue for nights actually stayed, minus
 * a comp on the remaining nights -- new logic parallel to (not a modification
 * of) the normal full-stay lump sum in processRevenue.
 */
export function calculateEarlyDepartureSettlement(
  nightRate: number,
  daysStayed: number,
  nightsRemaining: number
): EarlyDepartureSettlement {
  const revenue = nightRate * daysStayed;
  const comp = ECONOMY.earlyDepartureRefundRate * nightRate * nightsRemaining;
  return { revenue, comp, cashDelta: revenue - comp };
}

export function checkBankruptcy(state: HotelState): boolean {
  return state.cash <= ECONOMY.bankruptcyThreshold;
}

export function degradeRoomConditions(state: HotelState): HotelState {
  const updatedRooms = state.rooms.map(room => {
    if (room.status !== 'occupied') return room;
    const newCondition = Math.max(0, room.condition - ECONOMY.roomConditionDecayPerDay / 24);
    return { ...room, condition: newCondition };
  });

  return { ...state, rooms: updatedRooms };
}
