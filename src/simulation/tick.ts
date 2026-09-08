import type { HotelState, TickResult, GameEvent, Booking } from './types.js';
import type { PRNG } from './prng.js';
import { processArrivals, processDepartures } from './GuestManager.js';
import { processRevenue, processDailyCosts, updateReviewScore, checkBankruptcy, degradeRoomConditions } from './EconomyManager.js';
import { tickNoiseSources } from './NoiseManager.js';
import { processCleaningTick, processDailyHousekeeping, degradeCleanliness, startTurnoverCleaning } from './HousekeepingManager.js';
import { calculateStarRating } from './StarRatingManager.js';
import { checkSeasonChange } from './SeasonManager.js';
import { processMaintenanceTick, getStaffDailyCost } from './MaintenanceManager.js';
import { ECONOMY, REVIEW, HOUSEKEEPING, STAFF } from '../config/balance.js';

export function tickSimulation(state: HotelState, prng: PRNG): TickResult {
  const events: GameEvent[] = [];
  let current = { ...state };

  // 1. Process guest arrivals
  const arrivals = processArrivals(current, current.hour, prng);
  events.push(...arrivals.events);

  const newGuests = [...current.guests];
  const updatedRooms = [...current.rooms];

  for (const { guest, roomId } of arrivals.checkedIn) {
    newGuests.push(guest);
    const roomIdx = updatedRooms.findIndex(r => r.id === roomId);
    if (roomIdx >= 0) {
      updatedRooms[roomIdx] = { ...updatedRooms[roomIdx], status: 'occupied', guestId: guest.id };
    }
  }

  current = {
    ...current,
    guests: newGuests,
    rooms: updatedRooms,
    totalTurnedAway: current.totalTurnedAway + arrivals.turnedAway,
  };

  // 2. Process guest departures
  const departures = processDepartures(current, prng);
  events.push(...departures.events);

  const departedGuestIds = new Set(departures.departed.map(d => d.guest.id));
  const newBookings: Booking[] = departures.departed.map(d => d.booking);
  let revenueThisTick = 0;

  // Rooms enter cleaning state after checkout
  // If no front desk staff, checkout paperwork adds delay to cleaning
  const checkoutDelay = current.staff.frontDesk > 0 ? 0 : STAFF.frontDesk.checkoutDelayWithoutStaff;

  const roomsAfterDeparture = current.rooms.map(room => {
    if (room.guestId && departedGuestIds.has(room.guestId)) {
      const cleaned = startTurnoverCleaning(room, current.housekeeping.turnoverQuality);
      return { ...cleaned, cleaningHoursRemaining: cleaned.cleaningHoursRemaining + checkoutDelay };
    }
    return room;
  });

  const revenueResult = processRevenue(current, departures);
  revenueThisTick += revenueResult.cashDelta;

  // Turnover cleaning costs
  const roomsStartingCleaning = departures.departed.length;
  const turnoverCostPerRoom = HOUSEKEEPING.turnoverCost[current.housekeeping.turnoverQuality] ?? 30;
  const turnoverCost = roomsStartingCleaning * turnoverCostPerRoom;

  current = {
    ...current,
    rooms: roomsAfterDeparture,
    guests: current.guests.filter(g => !departedGuestIds.has(g.id)),
    bookings: [...current.bookings, ...newBookings].slice(-REVIEW.reviewWindowBookingCount),
    cash: current.cash + revenueThisTick - turnoverCost,
    totalRevenue: current.totalRevenue + Math.max(0, revenueThisTick),
  };

  // 3. Process cleaning tick
  const cleaningResult = processCleaningTick(current);
  current = cleaningResult.state;
  events.push(...cleaningResult.events);

  // 3.5. Daily housekeeping for occupied rooms
  const dailyResult = processDailyHousekeeping(current);
  current = dailyResult.state;
  events.push(...dailyResult.events);

  // 4. Hourly room condition degradation
  current = degradeRoomConditions(current);

  // 4.5. Maintenance workers repair rooms
  const maintenanceResult = processMaintenanceTick(current);
  current = maintenanceResult.state;
  events.push(...maintenanceResult.events);

  // 4.6. Tick down construction noise
  current = { ...current, noiseSources: tickNoiseSources(current.noiseSources) };

  // Check for broken rooms
  for (const room of current.rooms) {
    if (room.condition <= ECONOMY.roomBreakdownThreshold && room.status === 'occupied') {
      events.push({
        type: 'room_broken',
        message: `Room at (${room.gridX}, ${room.gridY}) is out of order!`,
        data: { roomId: room.id },
      });
    }
  }

  // 5. Daily costs + cleanliness degradation + staff wages (at hour 0)
  if (current.hour === 0 && current.day > 1) {
    const costs = processDailyCosts(current);
    const staffCost = getStaffDailyCost(current);
    current = { ...current, cash: current.cash + costs.cashDelta - staffCost };
    current = degradeCleanliness(current);
  }

  // 6. Update review score
  const prevReviewScore = current.reviewScore;
  current = { ...current, reviewScore: updateReviewScore(current) };

  if (Math.abs(current.reviewScore - prevReviewScore) >= 0.3) {
    const direction = current.reviewScore > prevReviewScore ? 'up' : 'down';
    events.push({
      type: 'review_score_changed',
      message: `Review score ${direction} to ${current.reviewScore.toFixed(1)}/10`,
    });
  }

  // 7. Update star rating
  const prevStarRating = current.starRating;
  current = { ...current, starRating: calculateStarRating(current) };

  if (current.starRating !== prevStarRating) {
    const direction = current.starRating > prevStarRating ? 'upgraded' : 'downgraded';
    events.push({
      type: 'star_rating_changed',
      message: `Hotel ${direction} to ${current.starRating}-star!`,
    });
  }

  // 8. Check bankruptcy
  if (checkBankruptcy(current)) {
    events.push({
      type: 'bankrupt',
      message: 'Hotel has gone bankrupt!',
    });
  }

  // 9. Advance clock
  const nextHour = (current.hour + 1) % 24;
  const nextDay = nextHour === 0 ? current.day + 1 : current.day;

  // 10. Check for season change
  if (nextDay !== current.day) {
    const seasonEvent = checkSeasonChange(current.day, nextDay);
    if (seasonEvent) events.push(seasonEvent);
  }

  current = { ...current, hour: nextHour, day: nextDay };

  return { state: current, events };
}
