import type { HotelState, TickResult, GameEvent, Booking } from './types.js';
import { partyLabel, PartyLabel } from './Party.js';
import type { PRNG } from './prng.js';
import { processArrivals, processDepartures, calculateGuestReviewBreakdown, isCheckoutDue } from './GuestManager.js';
import { processRevenue, processDailyCosts, updateReviewScore, checkBankruptcy, degradeRoomConditions, calculateEarlyDepartureSettlement, isLoanPaymentDay, processLoanPayment } from './EconomyManager.js';
import { processObjectives, recordDailyStat } from './ObjectivesManager.js';
import { decayDecor, processRenovationTick } from './DecorManager.js';
import { tickCampaign } from './MarketingManager.js';
import { formatRoomLabel, startPendingRefits } from './HotelState.js';
import { getStaffPlan, rosterAfter, syncRoster, planStaff } from './StaffManager.js';
import { planArrivalTrips, departureWalker, tidyMovement } from './GuestMovement.js';
import { planFacilityVisits, creditFacilityVisits } from './FacilityManager.js';
import { planOutings, planDinnersOut, creditDinnersOut } from './OutingManager.js';
import { planVisitors, fileVisitorComplaints, sendOrphanedVisitorsHome } from './HostedNights.js';
import { creditCheckIns, recordGiveUps, reseatLanes } from './DeskQueue.js';
import { planDeskComplaints, hearComplaints } from './Complaints.js';
import { voiceOf } from './Voice.js';
import { spotlightOn, planSpotlight, spotlightCheckedIn, recordSpotlightOutcome, spotlightNightRate, spotlightSettlement } from './Spotlight.js';
import { hourEnd } from './Movement.js';
import { tickNoiseSources, accrueNightNoise } from './NoiseManager.js';
import { processCleaningTick, processDailyHousekeeping, degradeCleanliness, startTurnoverCleaning } from './HousekeepingManager.js';
import { calculateStarRating } from './StarRatingManager.js';
import { checkSeasonChange } from './SeasonManager.js';
import { processMaintenanceTick, getStaffDailyCost } from './MaintenanceManager.js';
import { ECONOMY, REVIEW, HOUSEKEEPING, STAFF, ROOM_CONFIG, FACILITY_CONFIG, LOYALTY } from '../config/balance.js';
import {
  driftSatisfaction, advanceIncidents, dropIncidentsForGuests, selectNewIncident,
  recordReturnGuestEntries, recordPartyTurnAways, checkReviewSemiViral, tickReputationPenalties, recordRoomDislikes, recordBigTabs, recordLostRegulars,
} from './StoryGenerator.js';
import type { DepartedGuestReview } from './StoryGenerator.js';
import { bookingWeightFor, staysOf, ordinal, personIdOf } from './Loyalty.js';

export function tickSimulation(state: HotelState, prng: PRNG): TickResult {
  const events: GameEvent[] = [];
  let current = { ...state };

  // The tick happens at the end of the hour: everything decided now plays
  // out on screen from this moment (trips starting at T).
  const T = hourEnd(state);

  // 0. Staff did the hour's work exactly as planned at its start (the plan the
  // walking staff on screen follow), and end the hour where it left them.
  // Rooms vacated later in this tick join the plan for the next hour.
  const staffPlan = getStaffPlan(current);
  current = { ...current, staffPlan }; // one plan for crediting and for where everyone ends up
  current = creditFacilityVisits(current, T); // guests who got to a facility this hour used it
  current = creditDinnersOut(current, T); // thrifty guests who got out to dinner (for their card)
  current = creditCheckIns(current, T); // guests who reached the front desk counter this hour (and how long they waited)
  const giveUps = recordGiveUps(current, T); // guests who gave up in line and walked out this hour
  current = giveUps.state;
  events.push(...giveUps.events);
  const heard = hearComplaints(current, T); // guests who got to the desk to complain this hour
  current = heard.state;
  events.push(...heard.events);
  const cleaningResult = processCleaningTick(current);
  current = cleaningResult.state;
  events.push(...cleaningResult.events);

  const maintenanceResult = processMaintenanceTick(current);
  current = maintenanceResult.state;
  events.push(...maintenanceResult.events);
  current = { ...current, staffRoster: rosterAfter(current, staffPlan) };
  current = startPendingRefits(current); // rooms booked for a refit, now empty, close for it

  // 1. Process guest arrivals: rooms are booked now, and the guests walk in,
  // check in at a staffed desk, and go up to their rooms over the next hour.
  // First the week's spotlight guest (rolled on Monday, announced, a suite held)
  const spotlight = planSpotlight(current);
  current = spotlight.state;
  events.push(...spotlight.events);
  if (spotlightOn()) current = startPendingRefits(current); // (a suite the hold just left, with a refit booked, closes for it before arrivals)
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
  if (arrivals.spotlight) {
    // The spotlight guest checked in (or went elsewhere)
    const checkedIn = spotlightCheckedIn(current, arrivals.spotlight.guest, arrivals.spotlight.room, arrivals.spotlight.noDesk);
    current = checkedIn.state;
    events.push(...checkedIn.events);
  }
  const arrivalTrips = planArrivalTrips(current, arrivals.checkedIn, arrivals.walkIns, T);
  current = {
    ...current,
    guests: current.guests.map(g => (arrivalTrips.trips.has(g.id) ? { ...g, trip: arrivalTrips.trips.get(g.id)!, tripKind: 'arrival' as const } : g)),
    walkers: [...(current.walkers ?? []), ...arrivalTrips.walkers],
  };
  current = reseatLanes(current, T); // (complaints not yet at the counter wait for the new check-ins)

  // "A Regular Returns" -- converts this tick's guest_returned arrivals into log entries
  current = recordReturnGuestEntries(current, arrivals.events);
  current = recordPartyTurnAways(current, arrivals.events);

  // 1.5 Ambient satisfaction drift (Satisfaction System Design point 1 / design-review D3),
  // and the night noise each sleeping guest is putting up with (for their review)
  current = driftSatisfaction(current);
  current = accrueNightNoise(current);

  // 1.6 Advance in-progress incidents (resolve / escalate / room-move), then
  // select a new one if the pacing budget allows.
  const advance = advanceIncidents(current, prng, T);
  current = advance.state;
  events.push(...advance.events);

  const incidentSelection = selectNewIncident(current, prng);
  current = incidentSelection.state;
  events.push(...incidentSelection.events);

  // 1.7 Neighbours kept awake by a guest's visitors complain (and the desk may ask them to leave)
  const leavingNow = new Set([...advance.earlyDepartureGuestIds, ...current.guests.filter(g => isCheckoutDue(g, current)).map(g => g.id)]);
  const visitorComplaints = fileVisitorComplaints(current, T, leavingNow);
  current = visitorComplaints.state;
  events.push(...visitorComplaints.events);

  // 2. Early departures (eng-review D1/D7): runs immediately before the normal
  // departure check below, folded into the SAME accumulation (departedGuestIds/
  // newBookings/roomsAfterDeparture), never a parallel pipeline. Guarded against
  // double-processing a guest whose normal checkout also fires this tick --
  // the normal path takes priority, the guest is simply excluded here.
  const normalCheckoutGuestIds = new Set(
    current.guests
      .filter(g => isCheckoutDue(g, current))
      .map(g => g.id)
  );
  const earlyDepartureGuestIds = new Set(
    [...advance.earlyDepartureGuestIds].filter(id => !normalCheckoutGuestIds.has(id))
  );

  const walkoutBookings: Booking[] = [];
  const walkoutLost: GameEvent[] = [];
  const walkoutReviews: DepartedGuestReview[] = [];
  let walkoutCashDelta = 0;

  for (const guestId of earlyDepartureGuestIds) {
    const guest = current.guests.find(g => g.id === guestId);
    const room = current.rooms.find(r => r.status === 'occupied' && r.guestId === guestId);
    if (!guest || !room) continue;

    const daysStayed = Math.max(1, current.day - guest.checkInDay);
    const nightsRemaining = Math.max(0, guest.stayLength - daysStayed);
    const rate = spotlightOn() && guest.spotlight?.rate ? spotlightNightRate(guest, room.pricePerNight) : room.pricePerNight; // (a celebrity on the top floor pays double)
    const settlement = spotlightOn() && guest.spotlight?.rate ? spotlightSettlement(guest, room.pricePerNight, daysStayed, nightsRemaining) : calculateEarlyDepartureSettlement(room.pricePerNight, daysStayed, nightsRemaining);
    walkoutCashDelta += settlement.cashDelta;

    // Real breakdown, computed once (eng-review D2/D4) -- reused for both the
    // walkout Booking's score and Review Semi-Viral's attribution below.
    const breakdown = calculateGuestReviewBreakdown(room, current, guest, prng);
    const score = Math.max(REVIEW.minScore, breakdown.finalScore - REVIEW.walkoutIncidentPenalty);

    const weight = bookingWeightFor(guest);
    const booking: Booking = {
      id: `booking-walkout-${guest.id}`,
      roomId: room.id,
      guestId: guest.id,
      nightRate: rate,
      reviewScore: score,
      satisfactionAtCheckout: guest.satisfaction,
      ...(weight ? { weight } : {}),
    };
    walkoutBookings.push(booking);
    // A regular or VIP who walks out won't be back
    if (LOYALTY.enabled && guest.loyalty && staysOf(guest) >= LOYALTY.regularFrom) {
      walkoutLost.push({
        type: 'regular_lost',
        message: `${guest.name} won't be back: they walked out of their ${ordinal(staysOf(guest))} stay`,
        data: { guestId: guest.id, personId: personIdOf(guest), roomId: room.id, stays: staysOf(guest) },
      });
    }
    walkoutReviews.push({ guestName: partyLabel(guest), roomId: room.id, booking, breakdown, voice: voiceOf(guest), guest, ...(guest.spent?.restaurant ? { tab: guest.spent.restaurant } : {}), ...(guest.spotlight ? { paid: settlement.cashDelta } : {}) });

    events.push({
      type: 'guest_walked_out',
      message: `${PartyLabel(guest)} checked out early ($${settlement.cashDelta.toFixed(0)})`,
      data: { guestId: guest.id, roomId: room.id, reviewScore: score, cashDelta: settlement.cashDelta, roomFit: breakdown.roomFit, liked: !!breakdown.roomLikes, disliked: !!breakdown.roomDislikes, noisePenalty: breakdown.noisePenalty },
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
      return {
        ...cleaned,
        cleaningHoursRemaining: cleaned.cleaningHoursRemaining + checkoutDelay,
        cleaningHoursTotal: (cleaned.cleaningHoursTotal ?? cleaned.cleaningHoursRemaining) + checkoutDelay,
      };
    }
    return room;
  });

  // Departing guests walk out from wherever they are, starting now
  // (as they left: a night owl refused a late checkout is that much less happy walking out)
  const leftAs = new Map(departures.departed.map(d => [d.guest.id, d.guest]));
  const leaving = current.guests
    .filter(g => departedGuestIds.has(g.id))
    .map(g => departureWalker(current, leftAs.get(g.id) ?? g, T, earlyDepartureGuestIds.has(g.id) ? 'walked_out' : 'checked_out'))
    .filter((w): w is NonNullable<typeof w> => w !== null);

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
    walkers: [...(current.walkers ?? []), ...leaving],
    bookings: [...current.bookings, ...newBookings].slice(-REVIEW.reviewWindowBookingCount),
    cash: current.cash + revenueThisTick - turnoverCost,
    totalRevenue: current.totalRevenue + Math.max(0, revenueThisTick),
  };

  // Review Goes Semi-Viral: check this tick's departures (normal + walkout)
  // for an unusually bad checkout, budget-gated same as other new incidents.
  const departureReviews: DepartedGuestReview[] = [
    ...departures.departed.map(d => ({
      guestName: partyLabel(d.guest), roomId: d.roomId, booking: d.booking, breakdown: d.breakdown, voice: voiceOf(d.guest), guest: d.guest,
      ...(d.guest.spent?.restaurant ? { tab: d.guest.spent.restaurant } : {}), ...(d.guest.spotlight ? { paid: d.booking.nightRate * d.guest.stayLength + (d.lateFee ?? 0) } : {}),
    })),
    ...walkoutReviews,
  ];
  // The spotlight guest's review (a travel writer's write-up, or a bad one spreading: the day's one)
  const spotlightOut = recordSpotlightOutcome(current, departureReviews);
  current = spotlightOut.state;
  events.push(...spotlightOut.events);
  const semiViral = checkReviewSemiViral(current, departureReviews, prng);
  current = semiViral.state;
  events.push(...semiViral.events);
  // Something in the room a guest didn't like (separate beds for a couple): a story, once a day
  current = recordRoomDislikes(current, departureReviews);
  current = recordBigTabs(current, departureReviews); // a big restaurant tab: a story, once a day
  // A regular who won't be back (unhappier than last time, or walked out)
  events.push(...walkoutLost);
  current = recordLostRegulars(current, [...departures.events, ...walkoutLost]);

  // Tick down any active reputation penalty from a prior Review Semi-Viral incident
  current = tickReputationPenalties(current);

  // 3.5. Daily housekeeping for occupied rooms
  const dailyResult = processDailyHousekeeping(current);
  current = dailyResult.state;
  events.push(...dailyResult.events);

  // 4. Hourly room condition degradation
  current = degradeRoomConditions(current);

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

  // 11. Plan the coming hour: staff hired or let go join or leave, finished
  // trips end, guests head out to facilities or out for the day (or have
  // friends round), and the staff get their hour.
  current = { ...current, staffRoster: syncRoster(current) };
  current = tidyMovement(current, T);
  current = sendOrphanedVisitorsHome(current, T); // their host checked out early, or moved rooms
  current = planDeskComplaints(current); // someone fed up walks down to complain
  current = planFacilityVisits(current);
  current = planDinnersOut(current); // thrifty guests head out to eat
  current = planOutings(current);
  current = planVisitors(current); // a rowdy guest's friends round, at 22:00
  current = { ...current, staffPlan: planStaff(current) };

  return { state: current, events };
}
