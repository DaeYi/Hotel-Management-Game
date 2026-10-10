import type { HotelState, TickResult, GameEvent, Booking } from './types.js';
import type { PRNG } from './prng.js';
import { processArrivals, processDepartures, calculateGuestReviewBreakdown } from './GuestManager.js';
import { processRevenue, processDailyCosts, updateReviewScore, checkBankruptcy, degradeRoomConditions, calculateEarlyDepartureSettlement, isLoanPaymentDay, processLoanPayment } from './EconomyManager.js';
import { processObjectives, recordDailyStat } from './ObjectivesManager.js';
import { decayDecor, processRenovationTick } from './DecorManager.js';
import { tickCampaign } from './MarketingManager.js';
import { formatRoomLabel } from './HotelState.js';
import { tickNoiseSources } from './NoiseManager.js';
import { processCleaningTick, processDailyHousekeeping, degradeCleanliness, startTurnoverCleaning } from './HousekeepingManager.js';
import { calculateStarRating } from './StarRatingManager.js';
import { checkSeasonChange } from './SeasonManager.js';
import { processMaintenanceTick, getStaffDailyCost } from './MaintenanceManager.js';
import { ECONOMY, REVIEW, HOUSEKEEPING, STAFF, ROOM_CONFIG, FACILITY_CONFIG } from '../config/balance.js';
import {
  driftSatisfaction, advanceIncidents, dropIncidentsForGuests, selectNewIncident,
  recordReturnGuestEntries, checkReviewSemiViral, tickReputationPenalties,
} from './StoryGenerator.js';
import type { DepartedGuestReview } from './StoryGenerator.js';

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
    returningGuestPool: arrivals.returningGuestPool,
    totalTurnedAway: current.totalTurnedAway + arrivals.turnedAway,
  };

  // "A Regular Returns" -- converts this tick's guest_returned arrivals into log entries
  current = recordReturnGuestEntries(current, arrivals.events);

  // 1.5 Ambient satisfaction drift (Satisfaction System Design point 1 / design-review D3)
  current = driftSatisfaction(current);

  // 1.6 Advance in-progress incidents (resolve / escalate / room-move), then
  // select a new one if the pacing budget allows.
  const advance = advanceIncidents(current, prng);
  current = advance.state;
  events.push(...advance.events);

  const incidentSelection = selectNewIncident(current, prng);
  current = incidentSelection.state;
  events.push(...incidentSelection.events);

  // 2. Early departures (eng-review D1/D7): runs immediately before the normal
  // departure check below, folded into the SAME accumulation (departedGuestIds/
  // newBookings/roomsAfterDeparture), never a parallel pipeline. Guarded against
  // double-processing a guest whose normal checkout also fires this tick --
  // the normal path takes priority, the guest is simply excluded here.
  const normalCheckoutGuestIds = new Set(
    current.guests
      .filter(g => current.day - g.checkInDay >= g.stayLength)
      .map(g => g.id)
  );
  const earlyDepartureGuestIds = new Set(
    [...advance.earlyDepartureGuestIds].filter(id => !normalCheckoutGuestIds.has(id))
  );

  const walkoutBookings: Booking[] = [];
  const walkoutReviews: DepartedGuestReview[] = [];
  let walkoutCashDelta = 0;

  for (const guestId of earlyDepartureGuestIds) {
    const guest = current.guests.find(g => g.id === guestId);
    const room = current.rooms.find(r => r.status === 'occupied' && r.guestId === guestId);
    if (!guest || !room) continue;

    const daysStayed = Math.max(1, current.day - guest.checkInDay);
    const nightsRemaining = Math.max(0, guest.stayLength - daysStayed);
    const settlement = calculateEarlyDepartureSettlement(room.pricePerNight, daysStayed, nightsRemaining);
    walkoutCashDelta += settlement.cashDelta;

    // Real breakdown, computed once (eng-review D2/D4) -- reused for both the
    // walkout Booking's score and Review Semi-Viral's attribution below.
    const breakdown = calculateGuestReviewBreakdown(room, current, guest, prng);
    const score = Math.max(REVIEW.minScore, breakdown.finalScore - REVIEW.walkoutIncidentPenalty);

    const booking: Booking = {
      id: `booking-walkout-${guest.id}`,
      roomId: room.id,
      guestId: guest.id,
      nightRate: room.pricePerNight,
      reviewScore: score,
      satisfactionAtCheckout: guest.satisfaction,
    };
    walkoutBookings.push(booking);
    walkoutReviews.push({ guestName: guest.name, roomId: room.id, booking, breakdown });

    events.push({
      type: 'guest_walked_out',
      message: `${guest.name} checked out early ($${settlement.cashDelta.toFixed(0)})`,
      data: { guestId: guest.id, roomId: room.id, reviewScore: score, cashDelta: settlement.cashDelta },
    });
  }

  // 2b. Normal departures
  const departures = processDepartures(current, prng);
  events.push(...departures.events);
  current = { ...current, returningGuestPool: departures.returningGuestPool };

  const departedGuestIds = new Set<string>([
    ...departures.departed.map(d => d.guest.id),
    ...earlyDepartureGuestIds,
  ]);
  const newBookings: Booking[] = [...departures.departed.map(d => d.booking), ...walkoutBookings];
  let revenueThisTick = 0;

  // Teardown rule: drop any incident tied to a guest who departed this tick
  // (normal or walkout) -- an already-departed guest can't escalate further.
  current = { ...current, activeIncidents: dropIncidentsForGuests(current.activeIncidents, departedGuestIds) };

  // Rooms enter cleaning state after checkout -- normal and walkout departures
  // share this same accumulation (eng-review D7), not a separate pipeline.
  const checkoutDelay = current.staff.frontDesk > 0 ? 0 : STAFF.frontDesk.checkoutDelayWithoutStaff;

  const roomsAfterDeparture = current.rooms.map(room => {
    if (room.guestId && departedGuestIds.has(room.guestId)) {
      const cleaned = startTurnoverCleaning(room, current.housekeeping.turnoverQuality);
      return { ...cleaned, cleaningHoursRemaining: cleaned.cleaningHoursRemaining + checkoutDelay };
    }
    return room;
  });

  const revenueResult = processRevenue(current, departures);
  revenueThisTick += revenueResult.cashDelta + walkoutCashDelta;

  // Turnover cleaning costs (normal + walkout rooms both enter cleaning)
  const roomsStartingCleaning = departures.departed.length + earlyDepartureGuestIds.size;
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

  // Review Goes Semi-Viral: check this tick's departures (normal + walkout)
  // for an unusually bad checkout, budget-gated same as other new incidents.
  const departureReviews: DepartedGuestReview[] = [
    ...departures.departed.map(d => ({ guestName: d.guest.name, roomId: d.roomId, booking: d.booking, breakdown: d.breakdown })),
    ...walkoutReviews,
  ];
  const semiViral = checkReviewSemiViral(current, departureReviews, prng);
  current = semiViral.state;
  events.push(...semiViral.events);

  // Tick down any active reputation penalty from a prior Review Semi-Viral incident
  current = tickReputationPenalties(current);

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

  // 4.7. Renovating rooms count down and reopen; marketing campaign counts down
  const renovationResult = processRenovationTick(current);
  current = renovationResult.state;
  events.push(...renovationResult.events);

  const campaignResult = tickCampaign(current);
  current = campaignResult.state;
  events.push(...campaignResult.events);

  // Check for broken rooms
  for (const room of current.rooms) {
    if (room.condition <= ECONOMY.roomBreakdownThreshold && room.status === 'occupied') {
      events.push({
        type: 'room_broken',
        message: `Room ${formatRoomLabel(room.gridX, room.gridY, room.floor)} is out of order!`,
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
    current = decayDecor(current);

    if (isLoanPaymentDay(current.day)) {
      const loanResult = processLoanPayment(current);
      current = loanResult.state;
      events.push(...loanResult.events);
    }
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

  // 7.5 New peak star rating unlocks room types and facilities (never re-locks)
  if (current.starRating > current.peakStarRating) {
    const prevPeak = current.peakStarRating;
    current = { ...current, peakStarRating: current.starRating };
    const unlocked = [
      ...Object.entries(ROOM_CONFIG).map(([type, c]) => ({ label: `${type} room`, stars: c.requiredStars })),
      ...Object.values(FACILITY_CONFIG).map(c => ({ label: c.label.toLowerCase(), stars: c.requiredStars })),
    ].filter(u => u.stars > prevPeak && u.stars <= current.starRating);
    if (unlocked.length > 0) {
      events.push({
        type: 'build_unlocked',
        message: `Unlocked: ${unlocked.map(u => u.label).join(', ')}`,
      });
    }
  }

  // 7.6 End-of-day snapshot (hour 23 = overnight occupancy), then owner objectives
  if (current.hour === 23) {
    current = recordDailyStat(current);
  }
  const objectiveResult = processObjectives(current);
  current = objectiveResult.state;
  events.push(...objectiveResult.events);

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
