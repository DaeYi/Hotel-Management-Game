import type { HotelState, GameEvent, RoomType } from './types.js';
import { ECONOMY, REVIEW, AMENITIES, FACILITY_CONFIG, LOAN } from '../config/balance.js';
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

/** Whether a weekly loan payment falls due at the start of `day`. */
export function isLoanPaymentDay(day: number): boolean {
  return day > 1 && (day - 1) % LOAN.paymentIntervalDays === 0;
}

/** Day the next loan payment is due, counting from `day` (exclusive). */
export function getNextLoanPaymentDay(day: number): number {
  return day + LOAN.paymentIntervalDays - ((day - 1) % LOAN.paymentIntervalDays);
}

/**
 * Take the weekly loan payment: interest on the balance first, the rest
 * toward principal. The payment comes out even if cash can't cover it -- the
 * shortfall becomes debt that accrues ECONOMY.debtInterestRate daily.
 */
export function processLoanPayment(state: HotelState): { state: HotelState; events: GameEvent[] } {
  const { loan } = state;
  if (loan.balance <= 0) return { state, events: [] };

  const interest = loan.balance * LOAN.weeklyInterestRate;
  const payment = Math.min(loan.weeklyPayment, loan.balance + interest);
  const balance = Math.max(0, loan.balance + interest - payment);
  const missed = state.cash - payment < 0;

  const events: GameEvent[] = [{
    type: 'loan_payment',
    message: missed
      ? `Loan payment of $${payment.toFixed(0)} put you in debt!`
      : `Loan payment: $${payment.toFixed(0)} ($${balance.toFixed(0)} left)`,
    data: { payment, interest, balance, missed },
  }];
  if (balance === 0) {
    events.push({ type: 'loan_paid_off', message: 'Bank loan paid off!' });
  }

  return {
    state: {
      ...state,
      cash: state.cash - payment,
      loan: { ...loan, balance, missedPayments: loan.missedPayments + (missed ? 1 : 0) },
    },
    events,
  };
}

/** Pay down the loan early from cash. Returns null if there's nothing to pay or no cash for it. */
export function repayLoan(state: HotelState, amount: number): HotelState | null {
  const payment = Math.min(amount, state.loan.balance, Math.floor(state.cash));
  if (payment <= 0) return null;
  return {
    ...state,
    cash: state.cash - payment,
    loan: { ...state.loan, balance: state.loan.balance - payment },
  };
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
