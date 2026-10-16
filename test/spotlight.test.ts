import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, addFacility, addElevator, buildFloor, renovateRoom, refitRoom, getAvailableRooms, isRoomReachable, startPendingRefits } from '../src/simulation/HotelState.js';
import { getCheckInCapacity } from '../src/simulation/Layout.js';
import { calculateEarlyDepartureSettlement } from '../src/simulation/EconomyManager.js';
import {
  planSpotlight, freeBy, heldFrom, holdBlocksRenovation, spotlightGuest, spotlightArrival, spotlightCheckedIn, judgedStars, expectationAt,
  amenityRuleAt, nameReview, recordSpotlightOutcome, celebrityPull, writeUpMultiplier, spotlightBanner, holdFor, holdSuite, releaseHold,
  describeSpotlight, topFloor, arrivalTime, setHoldPolicy, holdLetGo, spotlightNightRate, spotlightSettlement, doubleNights,
} from '../src/simulation/Spotlight.js';
import { processArrivals, processDepartures, calculateGuestReviewBreakdown, getExpectedArrivalsPerDay } from '../src/simulation/GuestManager.js';
import { planFacilityVisits } from '../src/simulation/FacilityManager.js';
import { checkReviewSemiViral, getReputationPenaltyMultiplier, tickReputationPenalties, advanceIncidents, appendStoryLogEntry, type DepartedGuestReview } from '../src/simulation/StoryGenerator.js';
import { demandOccupancy } from '../src/simulation/strategies.js';
import { bookingWeightFor } from '../src/simulation/Loyalty.js';
import { quirkOf, guestTags } from '../src/simulation/Profile.js';
import { getDayOfWeek } from '../src/simulation/SeasonManager.js';
import { profileRoom, furnishingOf } from '../src/simulation/RoomProfile.js';
import { guestFigures } from '../src/render/figures.js';
import { PRNG } from '../src/simulation/prng.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { SPOTLIGHT, GUEST_PROFILE, STORY, ECONOMY, AMENITIES, STAR_RATING, RENOVATION, PATIENCE, REVIEW, FACILITY_VISITS, HOUSEKEEPING } from '../src/config/balance.js';
import { baseWalkHours } from '../src/simulation/HousekeepingManager.js';
import { getRoster } from '../src/simulation/StaffManager.js';
import type { Booking, GameEvent, Guest, GuestProfile, HotelState, Leg, Room, SpotlightPlan, Walker } from '../src/simulation/types.js';
import type { GuestReviewBreakdown } from '../src/simulation/GuestManager.js';

const PROFILE: GuestProfile = { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, favorite: 'none' };

function guest(id: string, extra: Partial<Guest> = {}): Guest {
  return { id, name: id, budget: 1000, stayLength: 2, trait: 'normal', satisfaction: 55, checkInDay: 8, isReturning: false, hadNoiseComplaint: false, profile: PROFILE, ...extra };
}

/** The starter hotel at 3 stars on Monday of week 2 (day 8), 09:00: suites on row 2 from x = 3 (doors up), then standard rooms. */
function hotel(suites = 2, standards = 1, extra: Partial<HotelState> = {}): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
  for (let x = 0; x < suites; x++) s = addRoom(s, 'suite', x + 3, 2, 0, 'up')!;
  for (let x = 0; x < standards; x++) s = addRoom(s, 'standard', x + 3 + suites, 2, 0, 'up')!;
  return { ...s, day: 8, hour: 9, noiseSources: [], guests: [], ...extra };
}

/** A writer due on Wednesday (day 10) at 15:00, announced on Tuesday. */
const plan = (extra: Partial<SpotlightPlan> = {}): SpotlightPlan => ({
  kind: 'writer', week: 1, salt: '', announceDay: 9, arrivalDay: 10, arrivalHour: 15, status: 'announced', chainId: 'spotlight-10', ...extra,
});

function occupy(s: HotelState, room: Room, g: Guest): HotelState {
  return { ...s, guests: [...s.guests, g], rooms: s.rooms.map(r => (r.id === room.id ? { ...r, status: 'occupied' as const, guestId: g.id } : r)) };
}

function withSwitch<T>(sw: { enabled: boolean }, on: boolean, fn: () => T): T {
  const was = sw.enabled;
  sw.enabled = on;
  try { return fn(); } finally { sw.enabled = was; }
}

/** With lots of guests turning up (the market multiplied), restoring it after. */
function busy<T>(fn: () => T, arrivalsPerDay = 160): T {
  const was = ECONOMY.baseArrivalsPerDay;
  ECONOMY.baseArrivalsPerDay = arrivalsPerDay;
  try { return fn(); } finally { ECONOMY.baseArrivalsPerDay = was; }
}

const BD = (extra: Partial<GuestReviewBreakdown> = {}): GuestReviewBreakdown => ({
  noisePenalty: 0, decorPenalty: 0, elevatorPenalty: 0, conditionBonus: 0, cleanlinessBonus: 0, amenityPenalty: 0, priceFairness: 1,
  guestVariance: 0, facilityBonus: 0, amenityBonus: 0, roomFit: 0, finalScore: 7, ...extra,
});

const booking = (g: Guest, roomId: string, reviewScore: number, extra: Partial<Booking> = {}): Booking => ({
  id: `booking-${g.id}`, roomId, guestId: g.id, nightRate: 300, reviewScore, satisfactionAtCheckout: 60, ...extra,
});

/** The first Monday (from day 8) whose roll comes up, on this hotel. */
function rollingMonday(s: HotelState): number {
  for (let day = 8; day < 8 + 7 * 300; day += 7) if (planSpotlight({ ...s, day }).state.spotlight) return day;
  throw new Error('no week rolled');
}

describe('Spotlight guests: the week\'s plan', () => {
  it('rolled on Monday at 09:00, a week in three at 5 stars (fewer below): a writer or a celebrity, walking in Wednesday to Friday at 15-17:00, announced a day or two ahead', () => {
    let rolled = 0;
    let writers = 0;
    const days = new Set<number>();
    const leads = new Set<number>();
    const hours = new Set<number>();
    for (let w = 0; w < 300; w++) {
      const day = 1 + 7 * w;
      const p = planSpotlight(hotel(1, 0, { day, starRating: 5 })).state.spotlight;
      if (!p) continue;
      rolled++;
      if (p.kind === 'writer') writers++;
      expect(p.arrivalDay - day).toBeGreaterThanOrEqual(2);
      expect(p.arrivalDay - day).toBeLessThanOrEqual(4);
      expect([2, 3, 4]).toContain(getDayOfWeek(p.arrivalDay));
      expect([1, 2]).toContain(p.arrivalDay - p.announceDay);
      expect([15, 16, 17]).toContain(p.arrivalHour);
      expect(p.chainId).toBe(`spotlight-${p.arrivalDay}`);
      expect(p.week).toBe(w);
      expect(p.status).toBe(p.announceDay === day ? 'announced' : 'planned');
      days.add(getDayOfWeek(p.arrivalDay));
      if (p.announceDay > day) leads.add(p.arrivalDay - p.announceDay);
      hours.add(p.arrivalHour);
    }
    expect([...days].sort()).toEqual([2, 3, 4]);
    expect([...leads].sort()).toEqual([1, 2]);
    expect([...hours].sort()).toEqual([15, 16, 17]);
    expect(Math.abs(rolled / 300 - SPOTLIGHT.weeklyChance[5])).toBeLessThan(0.08);
    expect(Math.abs(writers / rolled - SPOTLIGHT.writerShare)).toBeLessThan(0.15);
    // Fewer at 4 stars, fewer still at 3
    for (const stars of [3, 4]) {
      let n = 0;
      for (let w = 0; w < 1000; w++) if (planSpotlight(hotel(1, 0, { day: 1 + 7 * w, starRating: stars })).state.spotlight) n++;
      expect(Math.abs(n / 1000 - SPOTLIGHT.weeklyChance[stars])).toBeLessThan(0.03);
    }
  });

  it('only on Monday at 09:00, from 3 stars, with a suite, one at a time; the roll keyed by the latest booking too; with the switch off (or no profiles), never', () => {
    const s = hotel(2, 1, { starRating: 5 }); // (the likeliest: a week in three)
    const day = rollingMonday(s);
    const at = { ...s, day };
    expect(planSpotlight({ ...at, hour: 10 }).state.spotlight).toBeUndefined();
    expect(planSpotlight({ ...at, day: day + 1 }).state.spotlight).toBeUndefined();
    expect(planSpotlight({ ...at, starRating: 2 }).state.spotlight).toBeUndefined();
    const chance = SPOTLIGHT.weeklyChance;
    SPOTLIGHT.weeklyChance = { ...chance, 2: 1 };
    try {
      expect(planSpotlight({ ...at, starRating: 2 }).state.spotlight).toBeUndefined(); // (from 3 stars, whatever the chance)
    } finally {
      SPOTLIGHT.weeklyChance = chance;
    }
    expect(planSpotlight({ ...hotel(0, 2, { starRating: 5 }), day }).state.spotlight).toBeUndefined();
    // One at a time: a plan not done yet stays; a finished one makes way
    const pending = plan({ status: 'planned', announceDay: day + 3, arrivalDay: day + 4 });
    expect(planSpotlight({ ...at, spotlight: pending }).state.spotlight).toBe(pending);
    expect(planSpotlight({ ...at, spotlight: { ...pending, status: 'done' } }).state.spotlight?.week).toBe(Math.floor((day - 1) / 7));
    withSwitch(SPOTLIGHT, false, () => expect(planSpotlight(at).state).toBe(at));
    withSwitch(GUEST_PROFILE, false, () => expect(planSpotlight(at).state).toBe(at));
    // The latest booking salts it: some weeks change
    const salted = { ...s, bookings: [booking(guest('x'), 'r', 7)] };
    let differ = 0;
    for (let w = 1; w < 60; w++) {
      const a = planSpotlight({ ...s, day: 1 + 7 * w }).state.spotlight;
      const b = planSpotlight({ ...salted, day: 1 + 7 * w }).state.spotlight;
      if (!!a !== !!b || a?.arrivalDay !== b?.arrivalDay || a?.kind !== b?.kind) differ++;
      if (b) expect(b.salt).toBe('booking-x');
    }
    expect(differ).toBeGreaterThan(5);
  });

  it('announced at 09:00 on the day, the best suite held, in its own story (not an incident); reminded the day before; dropped quietly below 3 stars', () => {
    let s = hotel(2, 1, { day: 9 });
    s = { ...s, rooms: s.rooms.map((r, i) => (i === 0 ? { ...r, condition: 70, decor: 70 } : r)) };
    const p0 = plan({ status: 'planned', announceDay: 9, arrivalDay: 11, chainId: 'spotlight-11' });
    expect(planSpotlight({ ...s, hour: 8, spotlight: p0 }).state.spotlight).toBe(p0); // (not before 09:00)
    const out = planSpotlight({ ...s, spotlight: p0 });
    const p = out.state.spotlight!;
    expect(p.status).toBe('announced');
    expect(p.roomId).toBe(s.rooms[1].id); // the fresher suite
    expect(out.events).toHaveLength(1);
    expect(out.events[0].type).toBe('spotlight_announced');
    expect(out.events[0].message).toMatch(/travel writer arrives Thursday at about 15:00 and wants a suite\. Room \S+ is held for them\./);
    const entry = out.state.storyLog[out.state.storyLog.length - 1];
    expect(entry.chainId).toBe('spotlight-11');
    expect(entry.id).not.toBe('spotlight-11'); // (no new chain origin: not one of the day's incidents)
    // The day before: a reminder (none when announced that same day)
    const eve = planSpotlight({ ...out.state, day: 10 }).state;
    expect(eve.storyLog[eve.storyLog.length - 1].type).toBe('spotlight_reminder');
    expect(planSpotlight({ ...eve, hour: 10 }).state.storyLog.filter(e => e.type === 'spotlight_reminder')).toHaveLength(1); // (once)
    const short = planSpotlight({ ...s, day: 10, spotlight: { ...p0, announceDay: 10 } }).state;
    expect(short.storyLog.filter(e => e.type === 'spotlight_reminder')).toHaveLength(0);
    // Below 3 stars (or no suite) by then: never announced
    const dropped = planSpotlight({ ...s, starRating: 2, spotlight: p0 });
    expect(dropped.state.spotlight!.status).toBe('done');
    expect(dropped.events).toHaveLength(0);
    expect(planSpotlight({ ...hotel(0, 2, { day: 9 }), spotlight: p0 }).state.spotlight!.status).toBe('done');
    // Announced, but never came (the day's over): done
    const gone = { ...s, day: 12, hour: 0, spotlight: { ...p0, status: 'announced' as const } };
    expect(planSpotlight(gone).state.spotlight!.status).toBe('done');
    expect(planSpotlight({ ...gone, day: 11 }).state.spotlight!.status).toBe('announced');
  });

  it('the celebrity wants the top floor: the highest suite held, before a fresher one lower down', () => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = buildFloor(s)!.state;
    s = addElevator(s, 0, 0)!;
    s = addRoom(s, 'suite', 3, 2, 0, 'up')!;
    s = addRoom(s, 'suite', 4, 2, 1, 'up')!;
    s = { ...s, day: 9, hour: 9, noiseSources: [], guests: [], rooms: s.rooms.map(r => (r.floor === 1 ? { ...r, decor: 60 } : r)) };
    const up = s.rooms.find(r => r.floor === 1)!;
    const down = s.rooms.find(r => r.floor === 0)!;
    expect(topFloor(s)).toBe(1);
    const p0 = plan({ status: 'planned', announceDay: 9, arrivalDay: 11 });
    expect(planSpotlight({ ...s, spotlight: { ...p0, kind: 'celebrity' } }).state.spotlight!.roomId).toBe(up.id);
    expect(planSpotlight({ ...s, spotlight: p0 }).state.spotlight!.roomId).toBe(down.id); // (a writer: the fresher)
    // A higher suite coming free moves a celebrity's hold up (not one picked by hand; not a writer's)
    const held = { ...s, spotlight: { ...p0, kind: 'celebrity' as const, status: 'announced' as const, roomId: down.id }, hour: 10 };
    expect(planSpotlight(held).state.spotlight!.roomId).toBe(up.id);
    expect(planSpotlight({ ...held, spotlight: { ...held.spotlight, chosen: true } }).state.spotlight!.roomId).toBe(down.id);
    expect(planSpotlight({ ...held, spotlight: { ...held.spotlight, kind: 'writer' as const } }).state.spotlight!.roomId).toBe(down.id);
    // ... but not to one still being cleaned (though in time): a ready suite isn't given up for one that might not be
    const dirtyUp = { ...held, rooms: held.rooms.map(r => (r.id === up.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 1 } : r)) };
    expect(planSpotlight(dirtyUp).state.spotlight!.roomId).toBe(down.id);
    // The message says what they want
    expect(planSpotlight({ ...s, spotlight: { ...p0, kind: 'celebrity' } }).events[0].message).toMatch(/A celebrity arrives .* and wants a top-floor suite/);
  });
});

describe('Spotlight guests: the suite held', () => {
  it('a suite free by then: vacant, being cleaned, renovating but done in time, or its guest leaving before the day; not a broken one, nor a room that is no suite', () => {
    const s = hotel(2, 1, { day: 9, hour: 12 });
    const [a, b, std] = s.rooms;
    const p = plan({ arrivalDay: 11 });
    expect(freeBy(s, a, p)).toBe(true);
    expect(freeBy(s, std, p)).toBe(false);
    expect(freeBy(s, { ...a, status: 'cleaning', cleaningHoursRemaining: 29 }, p)).toBe(true); // (most of two days' shifts to spare)
    expect(freeBy(s, { ...a, condition: ECONOMY.roomBreakdownThreshold }, p)).toBe(false);
    // On the day itself, being cleaned counts only if it'll be done in time (a walk to it, then the work)
    const w = baseWalkHours(s);
    const today = { ...s, day: 11, hour: 12 }; // (walk-in 15:00 is hour 255; this hour ends at 253)
    expect(freeBy(today, { ...a, status: 'cleaning', cleaningHoursRemaining: 2 - w }, p)).toBe(true);
    expect(freeBy(today, { ...a, status: 'cleaning', cleaningHoursRemaining: 2 - w + 0.5 }, p)).toBe(false);
    // A suite nobody can get to: no
    expect(freeBy({ ...s, rooms: s.rooms.map(r => (r.id === a.id ? { ...r, door: 'down' as const } : r)) }, { ...a, door: 'down' }, p)).toBe(isRoomReachable({ ...s, rooms: s.rooms.map(r => (r.id === a.id ? { ...r, door: 'down' as const } : r)) }, { ...a, door: 'down' }));
    const walled = addRoom(s, 'standard', 3, 1, 0, 'up');
    if (walled) expect(freeBy(walled, a, p)).toBe(isRoomReachable(walled, a));
    // The turnovers ahead in the queue (the soonest done first), one housekeeper to a room; none with nobody to clean
    const queued = { ...s, day: 11, hour: 9, staff: { ...s.staff, housekeepers: 1 }, rooms: s.rooms.map(r => (r.id === b.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 1.5 } : r)) };
    const behind = { ...a, status: 'cleaning' as const, cleaningHoursRemaining: 2 }; // (b's 1.5h first: 10:00 + 1.5 + 2, and two walks)
    const one = { ...queued, rooms: queued.rooms.map(r => (r.id === a.id ? behind : r)) };
    const at = (h: number) => ({ ...p, arrivalHour: h });
    expect(freeBy(one, behind, at(Math.ceil(13.5 + 2 * w)))).toBe(true);
    expect(freeBy(one, behind, at(Math.ceil(13.5 + 2 * w) - 1))).toBe(false);
    // Two housekeepers: one each, at once (10:00 + 2 and a walk)
    const two = { ...one, staff: { ...one.staff, housekeepers: 2 } };
    expect(freeBy(two, behind, at(Math.ceil(12 + w)))).toBe(true);
    expect(freeBy(two, behind, at(Math.ceil(12 + w) - 1))).toBe(false);
    // Today's checkouts join the queue when their guests leave (11:00): one free sooner starts the suite waiting now
    const slow = { ...a, status: 'cleaning' as const, cleaningHoursRemaining: 3 };
    const out = guest('out', { checkInDay: 9, stayLength: 2 });
    const free10 = occupy({ ...one, rooms: one.rooms.map(r => (r.id === a.id ? slow : r.id === b.id ? { ...r, status: 'vacant' as const, cleaningHoursRemaining: 0 } : r)) }, std, out);
    const turnover = HOUSEKEEPING.turnoverDuration[free10.housekeeping.turnoverQuality];
    expect(turnover).toBeLessThan(3);
    expect(freeBy(free10, slow, at(Math.ceil(13 + w)))).toBe(true); // (10:00 + 3 and a walk: the checkout comes after)
    // ... but a housekeeper busy till after 11:00 takes the shorter checkout first (b's 1.5h, then the 2h, then the suite)
    const busyOut = occupy({ ...one, rooms: one.rooms.map(r => (r.id === a.id ? slow : r)) }, std, out);
    const noOut = { ...busyOut, guests: [], rooms: busyOut.rooms.map(r => (r.id === std.id ? { ...r, status: 'vacant' as const, guestId: undefined } : r)) };
    expect(freeBy(noOut, slow, at(Math.ceil(14.5 + 2 * w)))).toBe(true);
    expect(freeBy(busyOut, slow, at(Math.ceil(16.5 + 3 * w)))).toBe(true);
    expect(freeBy(busyOut, slow, at(Math.ceil(16.5 + 3 * w) - 1))).toBe(false);
    // ... tomorrow's checkouts too, the night before (no jump at midnight)
    // (22:00 the night before: from 07:00, b's 2.5h; by then an early bird has left at 08:00, and their shorter turnover goes before the suite)
    const early = { ...out, profile: { ...PROFILE, chronotype: 'early' as const, checkoutHour: 8 } };
    const eve = { ...busyOut, day: 10, hour: 22, guests: [early], rooms: busyOut.rooms.map(r => (r.id === b.id ? { ...r, cleaningHoursRemaining: 2.5 } : r)) };
    const done = 7 + 2.5 + turnover + 3 + 3 * w;
    expect(freeBy(eve, slow, at(Math.ceil(done)))).toBe(true);
    expect(freeBy(eve, slow, at(Math.ceil(done) - 1))).toBe(false);
    // Off shift, nobody starts anything till the morning, when the morning's checkouts are in the queue too
    const owl = { ...out, profile: { ...PROFILE, chronotype: 'early' as const, checkoutHour: 7 } };
    const offShift = { ...one, day: 10, hour: 22, guests: [owl], rooms: one.rooms.map(r => (r.id === a.id ? slow : r.id === b.id ? { ...r, status: 'vacant' as const, cleaningHoursRemaining: 0 } : r.id === std.id ? { ...r, status: 'occupied' as const, guestId: owl.id } : r)) };
    const morning = 7 + turnover + 3 + 2 * w; // (07:00: the early bird's room first, the shorter, then the suite)
    expect(freeBy(offShift, slow, at(Math.ceil(morning)))).toBe(true);
    expect(freeBy(offShift, slow, at(Math.ceil(morning) - 1))).toBe(false);
    // An occupied suite: its guest leaves before the day, and the turnover after them done in time
    const stayer = guest('stayer', { checkInDay: 8, stayLength: 2 }); // (leaves day 10 at 11:00)
    const occ = occupy({ ...s, day: 9, hour: 12, staff: { ...s.staff, housekeepers: 1 } }, a, stayer);
    expect(freeBy(occ, occ.rooms[0], p)).toBe(true);
    expect(freeBy({ ...occ, staff: { ...occ.staff, housekeepers: 0 } }, occ.rooms[0], p)).toBe(false); // (nobody to turn it over)
    // A refit booked on a suite is no bar to holding it (held, the refit waits)
    const refitBooked = { ...s, rooms: s.rooms.map(r => (r.id === a.id ? { ...r, pendingRefit: furnishingOf(r) } : r)) };
    expect(freeBy(refitBooked, refitBooked.rooms[0], p)).toBe(true);
    // A housekeeper doing a daily clean in an occupied suite isn't turning it over (that waits for the guest to leave):
    // she's free for the suite being cleaned next door (09:00, a walk and 2h)
    const bDirty = { ...b, status: 'cleaning' as const, cleaningHoursRemaining: 2 };
    const daily = occupy({ ...s, day: 10, hour: 8, staff: { ...s.staff, housekeepers: 1 }, rooms: s.rooms.map(r => (r.id === b.id ? bDirty : r)) }, a, guest('leaver', { checkInDay: 8, stayLength: 2 }));
    const cleaningIt = { ...daily, staffRoster: [{ ...(getRoster(daily).find(m => m.role === 'housekeeper')!), roomId: a.id }] };
    const nextDoor = { ...p, arrivalDay: 10 };
    expect(freeBy(cleaningIt, bDirty, { ...nextDoor, arrivalHour: Math.ceil(11 + w) })).toBe(true);
    // A housekeeper already in a room keeps at it (no walk to it)
    const inIt = { ...one, staffRoster: [{ ...(getRoster(one).find(m => m.role === 'housekeeper')!), roomId: a.id }] };
    expect(freeBy(inIt, behind, at(Math.ceil(12)))).toBe(true); // (10:00 + 2: hers already, before b's 1.5h)
    // ... from the start of her shift, if it's night now (07:00 + 2)
    expect(freeBy({ ...inIt, hour: 2 }, behind, at(9))).toBe(true);
    expect(freeBy({ ...inIt, hour: 2 }, behind, at(8))).toBe(false);
    // In queue order: three turnovers ahead, two housekeepers (the shortest two first, then the 1.8h to whoever's free first)
    let three = addRoom(one, 'standard', 7, 2, 0, 'up')!;
    three = addRoom(three, 'standard', 8, 2, 0, 'up')!;
    const lens = [0.5, 1, 1.8];
    const queue3 = { ...three, staff: { ...three.staff, housekeepers: 2 }, rooms: three.rooms.map((r, i) => (i >= 2 ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: lens[i - 2] } : r.id === b.id ? { ...r, status: 'vacant' as const } : r)) };
    // (10:00: one takes the 0.5h, the other the 1h; the 1.8h goes to the first free; the suite starts at 11:00 + a walk, done 13:00 + two walks)
    expect(freeBy(queue3, behind, at(Math.ceil(13 + 2 * w)))).toBe(true);
    expect(freeBy(queue3, behind, at(Math.ceil(13 + 2 * w) - 1))).toBe(false);
    expect(freeBy({ ...two, staff: { ...two.staff, housekeepers: 0 } }, behind, { ...p, arrivalDay: 20 })).toBe(false); // (nobody to clean it)
    const alone = { ...s, staff: { ...s.staff, housekeepers: 0 }, rooms: s.rooms.map(r => (r.id === a.id ? behind : r)) };
    expect(freeBy(alone, behind, { ...p, arrivalDay: 20 })).toBe(false); // (nobody to clean it, nothing ahead of it)
    // Between hours (a card), this hour's work is still to come: as the next hour boundary will count it
    expect(freeBy({ ...s, day: 11, hour: 12 }, { ...a, status: 'cleaning', cleaningHoursRemaining: 3 - w }, p, true)).toBe(true); // (12:00 + 3)
    expect(freeBy({ ...s, day: 11, hour: 12 }, { ...a, status: 'cleaning', cleaningHoursRemaining: 3 - w }, p)).toBe(false); // (13:00 + 3, at the boundary)
    // Cleaned in the housekeepers' hours only: none before their shift, none after it
    const late = { ...plan({ arrivalDay: 11, arrivalHour: ECONOMY.checkInEndHour }) }; // (as for the last check-in, 22:00)
    const evening = { ...s, day: 11, hour: 17 }; // (this hour ends at 18:00; the shift ends at 21:00)
    expect(freeBy(evening, { ...a, status: 'cleaning', cleaningHoursRemaining: 3 - w }, late)).toBe(true);
    expect(freeBy(evening, { ...a, status: 'cleaning', cleaningHoursRemaining: 3 - w + 0.5 }, late)).toBe(false);
    const night = { ...s, day: 11, hour: 2 }; // (nothing's cleaned till 07:00)
    expect(freeBy(night, { ...a, status: 'cleaning', cleaningHoursRemaining: 8 - w }, p)).toBe(true); // (07:00 + 8 = 15:00)
    expect(freeBy(night, { ...a, status: 'cleaning', cleaningHoursRemaining: 8 - w + 0.5 }, p)).toBe(false);
    // A room the housekeepers can't reach isn't in their queue (its door against another room)
    const blocker = addRoom({ ...one }, 'standard', b.gridX, b.gridY + 1, 0, 'down')!;
    const cutOff = { ...blocker, rooms: blocker.rooms.map(r => (r.id === b.id ? { ...r, door: 'down' as const } : r)) };
    expect(isRoomReachable(cutOff, cutOff.rooms.find(r => r.id === b.id)!)).toBe(false);
    expect(freeBy(cutOff, behind, at(Math.ceil(12 + w)))).toBe(true); // (as if nothing were ahead of it)
    // The party must fit: a suite with one single bed, for the writer but not the celebrity (a couple)
    const single = { ...a, furnishing: { ...furnishingOf(a), items: furnishingOf(a).items.map(x => (x.id === 'bed' ? { ...x, kind: 'bed_single' as const } : x)) } };
    expect(profileRoom(single).type).toBe('suite');
    expect(freeBy(s, single, p)).toBe(true);
    expect(freeBy(s, single, { ...p, kind: 'celebrity' })).toBe(false);
    // A refit doesn't mend a broken room (a renovation does)
    const T0 = arrivalTime(p) - ((s.day - 1) * 24 + s.hour + 1);
    expect(freeBy(s, { ...a, status: 'renovating', renovationHoursRemaining: 2, condition: 0, refitting: { decorAfter: 90 } }, p)).toBe(false);
    expect(freeBy(s, { ...a, status: 'renovating', renovationHoursRemaining: 2, condition: 0 }, p)).toBe(true);
    expect(T0).toBeGreaterThan(2);
    // Renovating: done by 15:00 on day 11 (hour 255) or not
    const T = arrivalTime(p) - ((s.day - 1) * 24 + s.hour + 1);
    expect(freeBy(s, { ...a, status: 'renovating', renovationHoursRemaining: T }, p)).toBe(true);
    expect(freeBy(s, { ...a, status: 'renovating', renovationHoursRemaining: T + 1 }, p)).toBe(false);
    // A guest leaving the day before, or on the day
    const s2 = occupy(occupy(s, a, guest('early', { checkInDay: 8, stayLength: 2 })), b, guest('late', { checkInDay: 8, stayLength: 3 }));
    expect(freeBy(s2, s2.rooms[0], p)).toBe(true);
    expect(freeBy(s2, s2.rooms[1], p)).toBe(false);
  });

  it('nobody books the held suite who would still be in it when the guest comes; anyone leaving before may', () => {
    const s = hotel(1, 0, { day: 9, hour: 9, spotlight: plan({ arrivalDay: 11 }) });
    const held = { ...s, spotlight: { ...s.spotlight!, roomId: s.rooms[0].id } };
    expect(heldFrom(held, 2)).toBe(s.rooms[0].id); // in till day 11
    expect(heldFrom(held, 1)).toBeNull(); // gone on day 10
    expect(heldFrom(s, 2)).toBeNull(); // (none held)
    expect(heldFrom({ ...held, spotlight: { ...held.spotlight!, status: 'staying' } }, 5)).toBeNull();
    withSwitch(SPOTLIGHT, false, () => expect(heldFrom(held, 2)).toBeNull());
    // At the desk: a stream of guests, and the only room never taken
    const hour = 15;
    let taken = 0;
    for (let seed = 0; seed < 40; seed++) {
      for (const queue of [true, false]) {
        const r = withSwitch(PATIENCE, queue, () => processArrivals({ ...held, hour, reviewScore: 9, starRating: 5 }, hour, new PRNG(seed)));
        taken += r.checkedIn.filter(c => c.roomId === s.rooms[0].id && c.guest.stayLength >= 2).length;
      }
    }
    expect(taken).toBe(0);
  });

  it('a refit booked on the held suite waits till the guest has been (the room left as it is)', () => {
    const s = hotel(2, 0, { day: 10, hour: 9 });
    const [a, b] = s.rooms;
    const studio = furnishingOf(a);
    const swapped = { ...studio, items: studio.items.map(x => (x.id === 'art' ? { ...x, tier: 1 as const } : x)) };
    const booked = { ...s, rooms: s.rooms.map(r => ({ ...r, pendingRefit: swapped })), spotlight: plan({ arrivalDay: 11, roomId: a.id }) };
    const after = startPendingRefits(booked);
    expect(after.rooms.find(r => r.id === a.id)).toMatchObject({ status: 'vacant', pendingRefit: swapped }); // (held: it waits)
    expect(after.rooms.find(r => r.id === b.id)!.status).toBe('renovating'); // (not held: it starts)
    expect(startPendingRefits({ ...booked, spotlight: { ...booked.spotlight!, status: 'staying' } }).rooms.find(r => r.id === a.id)!.status).toBe('renovating');
    // The hold dropped at the hour boundary ("Don't hold one"): the refit starts before anyone can book the suite
    const dropped = { ...booked, hour: 15, rooms: booked.rooms.map(r => (r.id === b.id ? { ...r, pendingRefit: undefined } : r)), spotlightHold: 'none' as const };
    for (let seed = 0; seed < 10; seed++) {
      const next = busy(() => tickSimulation(dropped, new PRNG(seed))).state;
      expect(next.spotlight!.roomId).toBeUndefined();
      const after = next.rooms.find(r => r.id === a.id)!;
      expect(after.pendingRefit).toBeUndefined(); // (refitted: an hour's work, done this hour)
      expect(after.guestId).toBeUndefined(); // (nobody let in first)
    }
  });

  it('a guest moved after a breakdown is never moved into the held suite (if they\'d still be in it on the day)', () => {
    let s = hotel(2, 0, { day: 9, hour: 12 });
    const [a, b] = s.rooms;
    const g = guest('g', { checkInDay: 8, stayLength: 4 });
    s = occupy(s, a, g);
    const incident = { id: 'i1', type: 'mid_stay_breakdown' as const, guestId: g.id, roomId: a.id, stage: 'active' as never, hoursRemaining: 3, chainId: 'i1' };
    s = { ...s, rooms: s.rooms.map(r => (r.id === a.id ? { ...r, condition: 0 } : r)), activeIncidents: [incident] };
    const held = { ...s, spotlight: plan({ arrivalDay: 11, roomId: b.id }) };
    expect(advanceIncidents(held, new PRNG(1)).state.rooms.find(r => r.id === b.id)!.guestId).toBeUndefined();
    // Leaving before the day: may
    const early = { ...held, guests: [{ ...g, stayLength: 2 }] };
    expect(advanceIncidents(early, new PRNG(1)).state.rooms.find(r => r.id === b.id)!.guestId).toBe(g.id);
    // No hold: may
    expect(advanceIncidents(s, new PRNG(1)).state.rooms.find(r => r.id === b.id)!.guestId).toBe(g.id);
  });

  it('a held suite can\'t start a renovation (or a refit) that would run past the arrival', () => {
    const s = hotel(2, 0, { day: 9, hour: 15 }); // (24 hours from the end of this hour, 16:00, runs past 15:00 tomorrow)
    const p = plan({ arrivalDay: 10, arrivalHour: 15, roomId: s.rooms[0].id });
    const held = { ...s, spotlight: p, rooms: s.rooms.map(r => ({ ...r, decor: 50 })) };
    expect(holdBlocksRenovation(held, s.rooms[0].id, RENOVATION.durationHours)).toBe(true);
    expect(renovateRoom(held, s.rooms[0].id)).toBeNull();
    expect(renovateRoom(held, s.rooms[1].id)).not.toBeNull(); // (not held)
    const later = { ...held, spotlight: { ...p, arrivalDay: 12 } };
    expect(holdBlocksRenovation(later, s.rooms[0].id, RENOVATION.durationHours)).toBe(false);
    expect(renovateRoom(later, s.rooms[0].id)).not.toBeNull();
    expect(holdBlocksRenovation({ ...held, hour: 14 }, s.rooms[0].id, RENOVATION.durationHours)).toBe(false); // (done by 15:00: just in time)
    // A refit too: a long one is refused, a short one (done in time) goes ahead
    const studio = furnishingOf(s.rooms[0]);
    const swapped = { ...studio, items: studio.items.map(x => (x.id === 'art' ? { ...x, tier: 1 as const } : x)) };
    expect(refitRoom(held, s.rooms[0].id, swapped)).not.toBeNull();
    expect(refitRoom({ ...held, hour: 14, day: 10 }, s.rooms[0].id, swapped)).toBeNull();
  });

  it('the hold moves to a suite that will be free if this one won\'t be (with a story line), and only then; held by hand, it stays; let go, none', () => {
    const s = hotel(2, 0, { day: 10, hour: 9 });
    const [a, b] = s.rooms;
    const p = plan({ arrivalDay: 11, roomId: a.id });
    // a breaks: the hold moves to b
    const broke = { ...s, spotlight: p, rooms: s.rooms.map(r => (r.id === a.id ? { ...r, condition: 0 } : r)) };
    const moved = planSpotlight(broke).state;
    expect(moved.spotlight!.roomId).toBe(b.id);
    expect(moved.storyLog[moved.storyLog.length - 1]).toMatchObject({ type: 'spotlight_hold', roomId: b.id });
    expect(moved.storyLog[moved.storyLog.length - 1].message).toMatch(/^The suite held for the travel writer is now Room \S+\.$/);
    // ... late in the day, the suite they're waiting for won't be ready after all: said so
    const waitingFor = { ...s, day: 11, hour: 19, staff: { ...s.staff, housekeepers: 1 }, spotlight: { ...p, roomId: a.id }, rooms: s.rooms.map(r => (r.id === a.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 2.5 } : { ...r, condition: 0 })) };
    const late = planSpotlight(waitingFor).state;
    expect(late.spotlight!.roomId).toBeUndefined();
    expect(late.storyLog[late.storyLog.length - 1].message).toMatch(/^Room \S+ won't be ready for the travel writer today after all: they'll take the best room free\.$/);
    // ... and if none will be free, says so
    const none = planSpotlight({ ...broke, rooms: broke.rooms.map(r => ({ ...r, condition: 0 })) }).state;
    expect(none.storyLog[none.storyLog.length - 1].message).toMatch(/^No suite will be free for the travel writer by then/);
    // A better suite coming free doesn't take the hold from one that's ready (a guest leaving b this morning, on the day)
    const onDay = { ...s, day: 11, hour: 11, spotlight: { ...p, roomId: a.id }, rooms: s.rooms.map(r => (r.id === a.id ? { ...r, decor: 60 } : r.id === b.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 1 } : r)) };
    expect(planSpotlight(onDay).state.spotlight!.roomId).toBe(a.id);
    // Held by hand: b over the better a
    const worseB = { ...s, rooms: s.rooms.map(r => (r.id === b.id ? { ...r, decor: 40 } : r)), spotlight: p };
    expect(holdFor(worseB, worseB.rooms[1])).toEqual({ held: false, who: 'travel writer', when: 'Thu ~15:00' });
    const chosen = holdSuite(worseB, b.id)!;
    expect(chosen.spotlight!.roomId).toBe(b.id);
    expect(planSpotlight(chosen).state.spotlight!.roomId).toBe(b.id);
    expect(holdFor(chosen, chosen.rooms[1])!.held).toBe(true);
    expect(holdSuite(worseB, 'nope')).toBeNull();
    const withStd = addRoom(worseB, 'standard', 7, 2, 0, 'up')!;
    expect(holdSuite(withStd, withStd.rooms[2].id)).toBeNull(); // (not a suite)
    expect(holdSuite({ ...worseB, rooms: worseB.rooms.map(r => (r.id === b.id ? { ...r, condition: 0 } : r)) }, b.id)).toBeNull(); // (broken)
    // A suite being refitted ranks by how fresh the refit leaves it
    const refit = { ...s, spotlight: { ...p, roomId: undefined }, rooms: s.rooms.map(r => (r.id === a.id ? { ...r, status: 'renovating' as const, renovationHoursRemaining: 2, decor: 30, refitting: { decorAfter: 40 } } : { ...r, decor: 80 })) };
    expect(planSpotlight(refit).state.spotlight!.roomId).toBe(b.id);
    // Let go: no hold, and it stays let go
    const released = releaseHold(chosen)!;
    expect(released.spotlight!.roomId).toBeUndefined();
    expect(planSpotlight(released).state.spotlight!.roomId).toBeUndefined();
    expect(releaseHold(released)).toBeNull();
    expect(holdLetGo(released)).toBe(true);
    // ... and held by hand again
    const again = holdSuite(released, a.id)!;
    expect(again.spotlight).toMatchObject({ roomId: a.id, chosen: true, released: false });
    expect(planSpotlight(again).state.spotlight!.roomId).toBe(a.id);
    // ... or by choosing to hold one, from the Staff panel
    const policy = setHoldPolicy(released, 'hold');
    expect(policy.spotlight!.released).toBe(false);
    expect(planSpotlight(policy).state.spotlight!.roomId).toBe(a.id);
    expect(setHoldPolicy(released, 'none').spotlight!.released).toBe(true);
    expect(setHoldPolicy(released, 'none').spotlightHold).toBe('none');
    // The policy: don't hold one (unless by hand): an automatic hold is let go
    expect(planSpotlight({ ...s, spotlight: { ...p, roomId: undefined }, spotlightHold: 'none' }).state.spotlight!.roomId).toBeUndefined();
    expect(planSpotlight({ ...s, spotlight: p, spotlightHold: 'none' }).state.spotlight!.roomId).toBeUndefined();
    expect(planSpotlight({ ...chosen, spotlightHold: 'none' }).state.spotlight!.roomId).toBe(b.id);
  });
});

describe('Spotlight guests: arriving', () => {
  it('who they are: the writer alone on a getaway, even-handed and vocal; the celebrity a couple, a big spender behind a do-not-disturb sign', () => {
    const w = spotlightGuest(plan(), 10);
    expect(w.id).toBe('spotlight-10');
    expect(w.party).toEqual({ kind: 'solo', size: 1 });
    expect(w.purpose).toBe('getaway');
    expect(w.profile).toMatchObject({ chronotype: 'regular', sleep: 'normal', rowdiness: 'normal', favorite: 'none', housekeeping: 'standard', patience: 'normal', voice: 'vocal', spending: 'standard' });
    expect(w.stayLength).toBe(SPOTLIGHT.nights);
    expect(quirkOf(w)).toBe('notebook');
    const c = spotlightGuest(plan({ kind: 'celebrity' }), 10);
    expect(c.party).toEqual({ kind: 'couple', size: 2 });
    expect(c.trait).toBe('big_spender');
    expect(c.profile).toMatchObject({ housekeeping: 'dnd', patience: 'patient', voice: 'typical', spending: 'splurger', rowdiness: 'normal' });
    expect(quirkOf(c)).toBe('star');
    expect(spotlightGuest(plan(), 10)).toEqual(w); // (no draws: the same every time)
    // ... in this game: another game's writer that day is someone else
    const here = spotlightGuest(plan({ salt: 'booking-a' }), 10);
    const there = spotlightGuest(plan({ salt: 'booking-b' }), 10);
    expect(here.id).toMatch(/^spotlight-10-/);
    expect(here.id).not.toBe(there.id);
    expect(here).toEqual(spotlightGuest(plan({ salt: 'booking-a' }), 10));
  });

  it('decided the hour before they walk in, first in line, into the held suite; waiting for it while it\'s nearly ready, unless an equal suite is free; at the last hour, any room or none', () => {
    const s = hotel(2, 1, { day: 10, hour: 14 });
    const [a, b, std] = s.rooms;
    const p = plan({ roomId: a.id }); // (walks in at 15:00: decided at 14:00)
    const at = { ...s, spotlight: p };
    expect(spotlightArrival(at, 13, getAvailableRooms(at))).toBeNull(); // (not yet)
    expect(spotlightArrival({ ...at, day: 9 }, 14, getAvailableRooms(at))).toBeNull();
    expect(spotlightArrival(at, 14, getAvailableRooms(at))!.room!.id).toBe(a.id);
    expect(spotlightArrival(at, 17, getAvailableRooms(at))!.room!.id).toBe(a.id); // (late: still)
    // The held suite still being cleaned, nearly done: they wait for it, unless the other suite is as good
    const worseB = at.rooms.map(r => (r.id === b.id ? { ...r, decor: 50 } : r));
    const nearly = { ...at, rooms: worseB.map(r => (r.id === a.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 2 } : r)) };
    expect(spotlightArrival(nearly, 14, getAvailableRooms(nearly))).toBeNull();
    const equal = { ...at, rooms: at.rooms.map(r => (r.id === a.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 2 } : r)) };
    expect(spotlightArrival(equal, 14, getAvailableRooms(equal))!.room!.id).toBe(b.id);
    // ... and if it won't be ready by the last check-in, the other suite now
    const slow = { ...at, rooms: worseB.map(r => (r.id === a.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 9 } : r)) };
    expect(spotlightArrival(slow, 14, getAvailableRooms(slow))!.room!.id).toBe(b.id);
    // ... and at the last hour, whatever's best
    expect(spotlightArrival(nearly, ECONOMY.checkInEndHour - 1, getAvailableRooms(nearly))!.room!.id).toBe(b.id);
    // Both suites being cleaned: they wait while one will be ready by the last check-in, and at 21:00 take the standard
    const both = { ...at, rooms: at.rooms.map(r => (r.id !== std.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 2 } : r)) };
    expect(spotlightArrival(both, 14, getAvailableRooms(both))).toBeNull();
    expect(spotlightArrival(both, ECONOMY.checkInEndHour - 1, getAvailableRooms(both))!.room!.id).toBe(std.id);
    const bothSlow = { ...at, rooms: at.rooms.map(r => (r.id !== std.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 9 } : r)) };
    expect(spotlightArrival(bothSlow, 14, getAvailableRooms(bothSlow))!.room!.id).toBe(std.id); // (no suite by 21:00: the standard now)
    // Suites taken for days: no waiting (the standard now)
    const g1 = guest('g1', { checkInDay: 9, stayLength: 4 });
    const g2 = guest('g2', { checkInDay: 9, stayLength: 4 });
    const full = occupy(occupy(at, a, g1), b, g2);
    expect(spotlightArrival(full, 14, getAvailableRooms(full))!.room!.id).toBe(std.id);
    // Nothing free at all: they wait, and at the last hour go elsewhere
    const packed = occupy(full, std, guest('g3', { checkInDay: 9, stayLength: 4 }));
    expect(spotlightArrival(packed, 14, getAvailableRooms(packed))).toBeNull();
    expect(spotlightArrival(packed, ECONOMY.checkInEndHour - 1, getAvailableRooms(packed))!.room).toBeNull();
    // No hold (let go): the best suite free
    const none = { ...at, spotlight: { ...p, roomId: undefined }, rooms: worseB };
    expect(spotlightArrival(none, 14, getAvailableRooms(none))!.room!.id).toBe(a.id);
    // ... or, with none free but one being cleaned in time, they wait for it (not the standard room)
    const unheld = { ...none, rooms: none.rooms.map(r => (r.id !== std.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 2 } : r)) };
    expect(spotlightArrival(unheld, 14, getAvailableRooms(unheld))).toBeNull();
    // ... but not for one with a refit booked (not held: it starts once the suite's empty): the standard room now
    const refits = { ...unheld, rooms: unheld.rooms.map(r => (r.id !== std.id ? { ...r, pendingRefit: furnishingOf(r) } : r)) };
    expect(spotlightArrival(refits, 14, getAvailableRooms(refits))!.room!.id).toBe(std.id);
    // A held suite renovating till after the last check-in: not worth waiting for (the other suite now)
    const renov = { ...at, rooms: worseB.map(r => (r.id === a.id ? { ...r, status: 'renovating' as const, renovationHoursRemaining: 8 } : r)) };
    expect(spotlightArrival(renov, 14, getAvailableRooms(renov))!.room!.id).toBe(b.id); // (15:00 + 8 = 23:00)
    const renovSoon = { ...renov, rooms: renov.rooms.map(r => (r.id === a.id ? { ...r, renovationHoursRemaining: 6 } : r)) };
    expect(spotlightArrival(renovSoon, 14, getAvailableRooms(renovSoon))).toBeNull(); // (done by 21:00: they wait)
    // A couple never takes a suite with one single bed
    const single = { ...b, furnishing: { ...furnishingOf(b), items: furnishingOf(b).items.map(x => (x.id === 'bed' ? { ...x, kind: 'bed_single' as const } : x)) } };
    const solo = { ...at, spotlight: { ...p, kind: 'celebrity' as const, roomId: undefined }, rooms: [occupy(at, a, guest('x', { checkInDay: 9, stayLength: 4 })).rooms[0], single, std] };
    const tookC = spotlightArrival({ ...solo, guests: [guest('x', { checkInDay: 9, stayLength: 4 })] }, ECONOMY.checkInEndHour - 1, getAvailableRooms(solo))!;
    expect(tookC.room?.id).not.toBe(single.id);
    withSwitch(SPOTLIGHT, false, () => expect(spotlightArrival(at, 14, getAvailableRooms(at))).toBeNull());
  });

  it('the story says so when the held suite wasn\'t ready', () => {
    const s = hotel(2, 0, { day: 10, hour: 14 });
    const [a, b] = s.rooms;
    const at = { ...s, spotlight: plan({ roomId: a.id }) };
    const w = spotlightGuest(at.spotlight!, 10);
    expect(spotlightCheckedIn(at, w, b).events[0].message).toMatch(/checked in to Room \S+ \(Room \S+, held for them, wasn't ready\)\.$/);
    expect(spotlightCheckedIn(at, w, a).events[0].message).toMatch(/checked in to Room \S+\.$/);
  });

  it('checked in at the desk (with the queue and without), the plan staying; or gone elsewhere, done', () => {
    const s = hotel(1, 0, { day: 10, hour: 14 });
    const at = { ...s, spotlight: plan({ roomId: s.rooms[0].id }) };
    for (const queue of [true, false]) {
      const r = withSwitch(PATIENCE, queue, () => processArrivals(at, 14, new PRNG(1)));
      expect(r.spotlight!.room!.id).toBe(s.rooms[0].id);
      expect(r.checkedIn[0]).toMatchObject({ guest: { id: 'spotlight-10' }, roomId: s.rooms[0].id });
      expect(r.checkedIn.filter(c => c.roomId === s.rooms[0].id)).toHaveLength(1);
      if (queue) expect(r.checkedIn[0].desk).toBeDefined();
    }
    const r = processArrivals(at, 14, new PRNG(1));
    const after = spotlightCheckedIn(at, r.spotlight!.guest, r.spotlight!.room);
    expect(after.state.spotlight).toMatchObject({ status: 'staying', guestId: 'spotlight-10', roomId: s.rooms[0].id });
    expect(after.events[0].type).toBe('spotlight_arrived');
    const gone = spotlightCheckedIn(at, r.spotlight!.guest, null);
    expect(gone.state.spotlight!.status).toBe('done');
    expect(gone.events[0].message).toMatch(/found no room free and went elsewhere/);
    expect(spotlightCheckedIn(at, r.spotlight!.guest, null, true).events[0].message).toMatch(/nobody at the front desk/);
    // With no hold, the room they take is theirs alone that hour (a crowd at the desk)
    const loose = { ...at, spotlight: { ...at.spotlight!, roomId: undefined }, reviewScore: 10, starRating: 5 };
    for (let seed = 0; seed < 20; seed++) {
      for (const queue of [true, false]) {
        const rr = withSwitch(PATIENCE, queue, () => busy(() => processArrivals(loose, 14, new PRNG(seed))));
        expect(rr.checkedIn.filter(c => c.roomId === s.rooms[0].id)).toHaveLength(1);
      }
    }
    // Without the queue, they're one of the hour's check-ins (the desk's capacity, all told)
    const roomy = hotel(1, 5, { day: 10, hour: 14, reviewScore: 10, starRating: 5 });
    const crowd = { ...roomy, spotlight: plan({ roomId: roomy.rooms[0].id }) };
    let full = 0;
    for (let seed = 0; seed < 10; seed++) {
      const rr = withSwitch(PATIENCE, false, () => busy(() => processArrivals(crowd, 14, new PRNG(seed))));
      expect(rr.spotlight?.room?.id).toBe(roomy.rooms[0].id);
      expect(rr.checkedIn.length).toBeLessThanOrEqual(getCheckInCapacity(crowd));
      if (rr.checkedIn.length === getCheckInCapacity(crowd)) full++;
    }
    expect(full).toBeGreaterThan(0); // (the desk was the limit)
    // Nobody at the desk (no queue): they wait, and at the last hour go
    const noDesk = { ...at, staff: { ...at.staff, frontDesk: 0 } };
    withSwitch(PATIENCE, false, () => {
      expect(processArrivals(noDesk, 14, new PRNG(1)).spotlight).toBeUndefined();
      expect(processArrivals(noDesk, ECONOMY.checkInEndHour - 1, new PRNG(1)).spotlight).toMatchObject({ room: null, noDesk: true });
    });
  });

  it('through the tick: announced, held, walking in at the hour, into the held suite, then out with the review told and the plan done', () => {
    let s = hotel(2, 0, { day: 9, hour: 9, spotlight: plan({ status: 'planned', announceDay: 9, arrivalDay: 10, arrivalHour: 15 }) });
    s = { ...s, rooms: s.rooms.map((r, i) => (i === 1 ? { ...r, decor: 60 } : r)) };
    const [a, b] = s.rooms;
    const prng = new PRNG(3);
    const seen: string[] = [];
    let walkedIn = -1;
    let walker: Walker | undefined;
    while (!(s.day === 12 && s.hour === 13)) {
      if (s.spotlight?.status === 'announced' && s.spotlight.roomId === a.id) s = holdSuite(s, b.id)!; // (the worse one, by hand)
      const r = tickSimulation(s, prng);
      seen.push(...r.events.filter(e => e.type.startsWith('spotlight')).map(e => e.type));
      s = r.state;
      const g = s.guests.find(x => x.id === 'spotlight-10');
      if (g && walkedIn < 0) walkedIn = g.trip![0].start;
      walker = walker ?? s.walkers?.find(x => x.guestId === 'spotlight-10');
    }
    expect(seen).toEqual(['spotlight_announced', 'spotlight_arrived', 'spotlight_review']);
    expect(walkedIn).toBeGreaterThanOrEqual(arrivalTime({ arrivalDay: 10, arrivalHour: 15 }));
    expect(walkedIn).toBeLessThan(arrivalTime({ arrivalDay: 10, arrivalHour: 15 }) + 1);
    expect(s.spotlight).toMatchObject({ status: 'done', roomId: b.id });
    expect(s.spotlight!.outcome).toBeDefined();
    expect(s.storyLog.filter(e => e.chainId === 'spotlight-10').map(e => e.type)).toEqual(expect.arrayContaining(['spotlight_announced', 'spotlight_arrived']));
    expect(s.bookings.find(x => x.guestId === 'spotlight-10')?.weight).toBe(SPOTLIGHT.writer.bookingWeight);
    expect(walker?.spotlight).toEqual({ kind: 'writer' });
    expect(quirkOf(walker!)).toBe('notebook');
  });

  it('through the tick: the held suite still being cleaned at the hour, they wait for it (a worse suite free), and check in to it once it\'s ready', () => {
    let s = hotel(2, 0, { day: 10, hour: 12 });
    const [a, b] = s.rooms;
    s = {
      ...s, staff: { ...s.staff, housekeepers: 2 },
      rooms: s.rooms.map(r => (r.id === a.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 4 } : { ...r, decor: 50 })),
      spotlight: plan({ arrivalDay: 10, arrivalHour: 15, roomId: a.id }),
    };
    const prng = new PRNG(4);
    let inAt = -1;
    while (s.day === 10 && s.hour < ECONOMY.checkInEndHour) {
      expect(s.spotlight!.roomId).toBe(a.id); // (the hold never moves to b)
      s = tickSimulation(s, prng).state;
      if (inAt < 0 && s.spotlight!.status === 'staying') inAt = s.hour;
    }
    expect(s.spotlight).toMatchObject({ status: 'staying', roomId: a.id });
    expect(s.rooms.find(r => r.id === a.id)!.guestId).toBe('spotlight-10');
    expect(inAt).toBeGreaterThan(15); // (later than they'd have walked in)
  });

  it('a celebrity walking out early (no room to move to after a breakdown): settled at their rate, and told', () => {
    let s = hotel(1, 0, { day: 11, hour: 12 });
    const suite = s.rooms[0];
    const c = { ...spotlightGuest(plan({ kind: 'celebrity' }), 10), spotlight: { kind: 'celebrity' as const, rate: 2 }, checkInDay: 10, stayLength: 2 };
    s = occupy(s, suite, c);
    s = {
      ...s, spotlight: plan({ kind: 'celebrity', status: 'staying', guestId: c.id, roomId: suite.id }),
      rooms: s.rooms.map(r => ({ ...r, condition: 0 })),
      activeIncidents: [{ id: 'i1', type: 'mid_stay_breakdown', guestId: c.id, roomId: suite.id, stage: 'active' as never, hoursRemaining: 1, chainId: 'i1' }],
    };
    const r = tickSimulation(s, new PRNG(1));
    const walked = r.events.find(e => e.type === 'guest_walked_out');
    expect(walked).toBeDefined();
    const booked = r.state.bookings.find(x => x.guestId === c.id)!;
    expect(booked.nightRate).toBe(suite.pricePerNight * 2);
    const told = r.events.find(e => e.type === 'spotlight_review')!;
    expect(told.message).toMatch(/checked out early \(\$[\d,]+\), with a /);
    expect(told.data!.paid).toBe(walked!.data!.cashDelta);
    expect(walked!.data!.cashDelta).toBe(calculateEarlyDepartureSettlement(suite.pricePerNight * 2, 1, 1).cashDelta);
    // Moved down after the first night, then out: the night stayed at double, the refund at the price
    const moved = { ...c, spotlight: { kind: 'celebrity' as const, rate: 2, until: 11 }, stayLength: 3 };
    const settled = spotlightSettlement(moved, 100, 1, 2);
    expect(settled.revenue).toBe(200);
    expect(settled.comp).toBeCloseTo(ECONOMY.earlyDepartureRefundRate * 100 * 2, 9);
    // ... two nights stayed (one double), one left: 300 for the stay, the refund at the price
    const longer = spotlightSettlement(moved, 100, 2, 1);
    expect(longer.revenue).toBe(300);
    expect(longer.comp).toBeCloseTo(ECONOMY.earlyDepartureRefundRate * 100, 9);
    // ... moved after two of three nights, out after one: a double night left to refund
    expect(spotlightSettlement({ ...moved, spotlight: { kind: 'celebrity', rate: 2, until: 12 } }, 100, 1, 2).comp).toBeCloseTo(ECONOMY.earlyDepartureRefundRate * 100 * 3, 9);
    // ... and unmoved, all at double (the plain settlement at twice the price)
    expect(spotlightSettlement({ ...moved, spotlight: { kind: 'celebrity', rate: 2 } }, 100, 1, 2)).toEqual(calculateEarlyDepartureSettlement(200, 1, 2));
    expect(doubleNights({ ...moved, spotlight: { kind: 'celebrity' } })).toBe(0);
    expect(r.state.spotlight!.status).toBe('done');
  });
});

describe('Spotlight guests: the travel writer\'s review', () => {
  it('judges the hotel a star up (6 stars: their own standard), wanting what that class must have; the review counts 5 times over', () => {
    const w = spotlightGuest(plan(), 10);
    expect(judgedStars(w, 3)).toBe(4);
    expect(judgedStars(guest('g'), 3)).toBe(3);
    expect(judgedStars({ spotlight: { kind: 'celebrity' } }, 3)).toBe(3);
    withSwitch(SPOTLIGHT, false, () => expect(judgedStars(w, 3)).toBe(3));
    expect(expectationAt(4)).toBe(STAR_RATING.expectationMultiplier[4]);
    expect(expectationAt(6)).toBe(SPOTLIGHT.writer.expectationAbove5);
    expect(amenityRuleAt(4)!.minimumTier).toBe('premium');
    expect(amenityRuleAt(5)!.minimumTier).toBe('luxury');
    expect(amenityRuleAt(6)!.minimumTier).toBe('luxury');
    expect(amenityRuleAt(3)).toBeNull();
    expect(bookingWeightFor(w)).toBe(SPOTLIGHT.writer.bookingWeight);
    expect(bookingWeightFor(spotlightGuest(plan({ kind: 'celebrity' }), 10))).toBeUndefined();
  });

  it('their review: basic amenities at 3 stars a fault (the 4-star rule), premium no bonus; harsher on what\'s wrong; no draw for the variance', () => {
    const s = hotel(1, 0, { day: 12, hour: 10 });
    const room = { ...s.rooms[0], status: 'occupied' as const, guestId: 'spotlight-10', condition: 40 };
    const w = { ...spotlightGuest(plan(), 10), checkInDay: 10 };
    const plain = { ...w, id: 'g', spotlight: undefined };
    const basic = { ...s, amenities: { ...s.amenities, suite: 'basic' as const } };
    const prem = { ...s, amenities: { ...s.amenities, suite: 'premium' as const } };
    const wb = calculateGuestReviewBreakdown(room, basic, w, new PRNG(1));
    expect(wb.amenityPenalty).toBe(AMENITIES.starExpectations[0].penaltyIfBelow);
    expect(wb.amenityBonus).toBe(0); // (basic, below the class's own: no bonus, and never less)
    expect(wb.expectation).toBeGreaterThan(STAR_RATING.expectationMultiplier[3]);
    expect(calculateGuestReviewBreakdown(room, basic, plain, new PRNG(1)).expectation).toBeUndefined();
    expect(calculateGuestReviewBreakdown(room, basic, plain, new PRNG(1)).amenityPenalty).toBe(0);
    expect(calculateGuestReviewBreakdown(room, prem, w, new PRNG(1)).amenityBonus).toBe(0);
    expect(calculateGuestReviewBreakdown(room, prem, plain, new PRNG(1)).amenityBonus).toBe(AMENITIES.tiers.premium.reviewBonus);
    withSwitch({ get enabled() { return SPOTLIGHT.writer.parAmenities; }, set enabled(v) { SPOTLIGHT.writer.parAmenities = v; } }, false, () => {
      expect(calculateGuestReviewBreakdown(room, prem, w, new PRNG(1)).amenityBonus).toBe(AMENITIES.tiers.premium.reviewBonus);
    });
    // The same draw-free variance whatever the stream
    const v1 = calculateGuestReviewBreakdown(room, prem, w, new PRNG(1)).guestVariance;
    expect(calculateGuestReviewBreakdown(room, prem, w, new PRNG(99)).guestVariance).toBe(v1);
    expect(Math.abs(v1)).toBeLessThanOrEqual(REVIEW.varianceRange);
    const prng = new PRNG(5);
    calculateGuestReviewBreakdown(room, prem, w, prng);
    expect(prng.next()).toBe(new PRNG(5).next()); // (nothing drawn)
    // Harsher on its own: with par amenities off, the same room, the same temperament, the writer still scores it lower
    withSwitch({ get enabled() { return SPOTLIGHT.writer.parAmenities; }, set enabled(v) { SPOTLIGHT.writer.parAmenities = v; } }, false, () => {
      const twin = { ...plain, profile: w.profile, party: w.party, purpose: w.purpose };
      const lux = { ...s, amenities: { ...s.amenities, suite: 'luxury' as const } };
      const worn = { ...room, condition: 5 };
      const byWriter = calculateGuestReviewBreakdown(worn, lux, w, new PRNG(1));
      const byGuest = calculateGuestReviewBreakdown(worn, lux, twin, new PRNG(1));
      expect(byWriter.amenityPenalty).toBe(byGuest.amenityPenalty);
      expect(byWriter.finalScore - byWriter.guestVariance).toBeLessThan(byGuest.finalScore - byGuest.guestVariance - 0.05);
    });
    // Harsher: a worn room costs the writer more than an ordinary guest at the same stars
    const noVar = (b: GuestReviewBreakdown) => b.finalScore - b.guestVariance;
    expect(noVar(calculateGuestReviewBreakdown(room, prem, w, new PRNG(1))))
      .toBeLessThan(noVar(calculateGuestReviewBreakdown(room, prem, { ...plain, profile: w.profile, party: w.party, purpose: w.purpose }, new PRNG(1))) - 0.05);
  });

  it('tries every facility the hotel has, in turn, even when cross; once each', () => {
    let s = hotel(1, 0, { day: 10, hour: 10 });
    s = addFacility(s, 'gym', 7, 0, 0, 'down')!;
    const w = { ...spotlightGuest(plan(), 10), satisfaction: 2 };
    const plain = { ...guest('g'), satisfaction: 2 };
    const one = { ...occupy(s, s.rooms[0], w) };
    const two = { ...occupy(s, s.rooms[0], plain) };
    const after = planFacilityVisits(one);
    expect(after.guests[0].tripKind).toBe('visit');
    expect(after.guests[0].trip!.some(l => l.kind === 'stay' && l.placeId === s.facilities[0].id)).toBe(true);
    expect(planFacilityVisits(two).guests[0].trip).toBeUndefined(); // (an ordinary cross guest stays in)
    // Not when the facility's not in use (03:00)
    expect(planFacilityVisits({ ...one, hour: 3 }).guests[0].trip).toBeUndefined();
    // However far: with the walk limit at nothing, the writer still goes
    const was = FACILITY_VISITS.maxWalkHours;
    FACILITY_VISITS.maxWalkHours = 0;
    try {
      expect(planFacilityVisits({ ...one, guests: [{ ...w, satisfaction: 60 }] }).guests[0].tripKind).toBe('visit');
    } finally {
      FACILITY_VISITS.maxWalkHours = was;
    }
    // Been: not forced again
    const been = { ...one, guests: [{ ...w, facilitiesUsed: { gym: { level: 1, day: 10 } } }] };
    expect(planFacilityVisits(been).guests[0].trip).toBeUndefined();
    withSwitch(SPOTLIGHT, false, () => expect(planFacilityVisits(one).guests[0].trip).toBeUndefined());
  });

  it('names what they loved and minded most (the price never a reason to love it); nothing, below the floors', () => {
    expect(nameReview(BD({ amenityBonus: 0.5, decorPenalty: 0.4 }), {})).toEqual({ best: 'the amenities', worst: 'tired decor' });
    expect(nameReview(BD({ facilityBonus: 0.6 }), { facilitiesUsed: { pool: { level: 1, day: 1 }, gym: { level: 1, day: 1 } } }).best).toMatch(/^the (pool|gym)$/);
    expect(nameReview(BD({ priceFairness: 0.5 }), {})).toEqual({ best: null, worst: 'the prices' });
    expect(nameReview(BD({ amenityBonus: SPOTLIGHT.praiseFloor - 0.01, noisePenalty: SPOTLIGHT.faultFloor - 0.01 }), {})).toEqual({ best: null, worst: null });
    expect(nameReview(BD({ cleanlinessBonus: -0.5, conditionBonus: 0.4 }), {})).toEqual({ best: 'a room in perfect repair', worst: 'a grubby room' });
    // As the writer felt it: tired decor (x their expectation) over the prices
    expect(nameReview(BD({ priceFairness: 0.8, decorPenalty: 0.3 }), {}).worst).toBe('the prices');
    expect(nameReview(BD({ priceFairness: 0.8, decorPenalty: 0.3, expectation: 1.9 }), {}).worst).toBe('tired decor');
  });

  it('8.5 or more: a write-up, 20% more bookings for two days; 4 or less: it spreads (the day\'s bad review); between, just the review; the plan done', () => {
    const w = { ...spotlightGuest(plan(), 10), checkInDay: 10 };
    const s = hotel(1, 0, { day: 12, hour: 11, guests: [w], spotlight: plan({ status: 'staying', guestId: w.id, roomId: 'room' }) });
    const out = (score: number, b = BD({ amenityBonus: 0.5 })) => recordSpotlightOutcome(s, [{ guest: w, booking: booking(w, 'room', score), breakdown: b, roomId: 'room' }]);
    const up = out(SPOTLIGHT.writer.writeUpAt);
    expect(up.state.activeReputationPenalties).toEqual([{ multiplier: SPOTLIGHT.writer.writeUpMult, hoursRemaining: SPOTLIGHT.writer.writeUpHours, kind: 'write_up' }]);
    expect(up.state.spotlight).toMatchObject({ status: 'done', outcome: 'write_up' });
    expect(up.events[0].message).toMatch(/write-up is out \(8\.5\/10\): loved the amenities; nothing to fault\. Bookings up 20% for a day\./);
    expect(up.state.storyLog[up.state.storyLog.length - 1]).toMatchObject({ type: 'write_up', chainId: 'spotlight-10' });
    expect(writeUpMultiplier(up.state)).toBe(SPOTLIGHT.writer.writeUpMult);
    expect(getReputationPenaltyMultiplier(up.state)).toBe(SPOTLIGHT.writer.writeUpMult);
    const mid = out(SPOTLIGHT.writer.writeUpAt - 0.01);
    expect(mid.state.activeReputationPenalties).toEqual([]);
    expect(mid.state.spotlight!.outcome).toBe('review');
    const pan = out(SPOTLIGHT.writer.panAt, BD({ noisePenalty: 1 }));
    expect(pan.state.activeReputationPenalties).toEqual([{ multiplier: STORY.reviewSemiViralPenaltyMultiplier, hoursRemaining: STORY.reviewSemiViralPenaltyHours }]);
    expect(pan.state.spotlight!.outcome).toBe('pan');
    expect(pan.events[0].message).toMatch(/minded noisy nights\. It's spreading: bookings down 30% for two days\./);
    expect(out(SPOTLIGHT.writer.panAt + 0.01).state.spotlight!.outcome).toBe('review');
    // The pan is the day's bad review: no other spreads today
    const other = guest('other');
    const bad: DepartedGuestReview = { guestName: 'other', roomId: 'r2', booking: booking(other, 'r2', 1), breakdown: BD({ noisePenalty: 3 }), guest: other };
    const viral = checkReviewSemiViral(pan.state, [bad], new PRNG(1));
    expect(viral.state.activeReputationPenalties).toHaveLength(1);
    expect(checkReviewSemiViral(s, [bad], new PRNG(1)).state.activeReputationPenalties).toHaveLength(1); // (without it, it would)
    // Stacking off: the pan replaces a bad review spreading, not a write-up
    const was = STORY.reviewSemiViralStacks;
    STORY.reviewSemiViralStacks = false;
    try {
      const wu = { multiplier: 1.2, hoursRemaining: 5, kind: 'write_up' as const };
      const off = recordSpotlightOutcome({ ...s, activeReputationPenalties: [wu, { multiplier: 0.7, hoursRemaining: 3 }] }, [{ guest: w, booking: booking(w, 'room', SPOTLIGHT.writer.panAt), breakdown: BD({ noisePenalty: 1 }), roomId: 'room' }]);
      expect(off.state.activeReputationPenalties).toEqual([wu, { multiplier: STORY.reviewSemiViralPenaltyMultiplier, hoursRemaining: STORY.reviewSemiViralPenaltyHours }]);
    } finally {
      STORY.reviewSemiViralStacks = was;
    }
    // A day one already spread: the pan keeps it going, no deeper
    const spread = checkReviewSemiViral(s, [bad], new PRNG(1)).state;
    const aged = { ...spread, activeReputationPenalties: spread.activeReputationPenalties.map(p => ({ ...p, hoursRemaining: 10 })) };
    const both = recordSpotlightOutcome(aged, [{ guest: w, booking: booking(w, 'room', SPOTLIGHT.writer.panAt), breakdown: BD({ noisePenalty: 1 }), roomId: 'room' }]);
    expect(both.state.activeReputationPenalties).toEqual([{ multiplier: STORY.reviewSemiViralPenaltyMultiplier, hoursRemaining: STORY.reviewSemiViralPenaltyHours }]);
    expect(both.events[0].message).toMatch(/With today's other bad review, bookings stay down 30% for two days\./);
    expect(both.state.spotlight!.outcome).toBe('pan');
    // Not this one's departure: nothing (gone some other way: the plan's over)
    expect(recordSpotlightOutcome(s, []).state).toBe(s);
    expect(recordSpotlightOutcome({ ...s, guests: [] }, []).state.spotlight!.status).toBe('done');
    withSwitch(SPOTLIGHT, false, () => expect(out(9.5).state).toBe(s));
  });

  it('a write-up isn\'t undone by a bad review spreading (stacking off), ticks down, and the bots\' demand looks past it', () => {
    const w = { multiplier: 1.2, hoursRemaining: 2, kind: 'write_up' as const };
    const s = hotel(1, 0, { activeReputationPenalties: [w, { multiplier: 0.7, hoursRemaining: 5 }] });
    const other = guest('other');
    const bad: DepartedGuestReview = { guestName: 'other', roomId: 'r2', booking: booking(other, 'r2', 1), breakdown: BD({ noisePenalty: 3 }), guest: other };
    const was = STORY.reviewSemiViralStacks;
    STORY.reviewSemiViralStacks = false;
    try {
      const after = checkReviewSemiViral(s, [bad], new PRNG(1)).state.activeReputationPenalties;
      expect(after).toEqual([w, { multiplier: STORY.reviewSemiViralPenaltyMultiplier, hoursRemaining: STORY.reviewSemiViralPenaltyHours }]);
    } finally {
      STORY.reviewSemiViralStacks = was;
    }
    const ticked = tickReputationPenalties(s).activeReputationPenalties;
    expect(ticked[0]).toEqual({ ...w, hoursRemaining: 1 });
    // The bots' building looks past it (as past the season); staffing doesn't
    const plainDemand = hotel(2, 2, { day: 30, reviewScore: 0.5 }); // (little demand: under full)
    const boosted = { ...plainDemand, activeReputationPenalties: [w] };
    expect(demandOccupancy(boosted, true)).toBeCloseTo(demandOccupancy(plainDemand, true), 12);
    expect(demandOccupancy(boosted, false)).toBeGreaterThan(demandOccupancy(plainDemand, false));
    // A spotlight guest's own bad review never spreads as an ordinary one
    const celeb = { ...spotlightGuest(plan({ kind: 'celebrity' }), 10) };
    const theirs: DepartedGuestReview = { guestName: 'c', roomId: 'r', booking: booking(celeb, 'r', 1), breakdown: BD({ noisePenalty: 3 }), guest: celeb };
    expect(checkReviewSemiViral(hotel(1, 0), [theirs], new PRNG(1)).state.activeReputationPenalties).toEqual([]);
  });
});

describe('Spotlight guests: the celebrity', () => {
  it('pays double in a top-floor suite (and only there), walking out too; never back again', () => {
    const s = hotel(1, 1, { day: 12, hour: 10 });
    const [suite, std] = s.rooms;
    const at = { ...s, spotlight: plan({ kind: 'celebrity', arrivalDay: 12, arrivalHour: 10, roomId: suite.id }) };
    const arriving = spotlightArrival(at, 10, getAvailableRooms(at))!;
    expect(arriving.room!.id).toBe(suite.id);
    expect(arriving.guest.spotlight).toEqual({ kind: 'celebrity', rate: SPOTLIGHT.celebrity.rateMult });
    // Not a suite: the price
    const noSuite = { ...at, rooms: at.rooms.map(r => (r.id === suite.id ? { ...r, status: 'cleaning' as const } : r)) };
    const lower = spotlightArrival(noSuite, ECONOMY.checkInEndHour - 1, getAvailableRooms(noSuite))!;
    expect(lower.room!.id).toBe(std.id);
    expect(lower.guest.spotlight).toEqual({ kind: 'celebrity' });
    // Checking out: twice the room's price a night, and no return
    const c = { ...arriving.guest, checkInDay: 10, stayLength: 2 };
    const staying = occupy({ ...s, hour: 10, spotlight: plan({ kind: 'celebrity', status: 'staying', guestId: c.id }) }, suite, c);
    const out = processDepartures(staying, new PRNG(1));
    expect(out.departed[0].booking.nightRate).toBe(suite.pricePerNight * 2);
    expect(out.returningGuestPool).toEqual(staying.returningGuestPool);
    // (delighted, an ordinary guest would be back)
    const happy = { ...c, satisfaction: 100 };
    const asGuest = occupy({ ...s, hour: 10 }, suite, { ...happy, id: 'g', spotlight: undefined });
    expect(processDepartures(asGuest, new PRNG(1)).returningGuestPool.length).toBe(1);
    expect(processDepartures(occupy({ ...s, hour: 10, spotlight: staying.spotlight }, suite, happy), new PRNG(1)).returningGuestPool).toEqual([]);
    const rec = recordSpotlightOutcome(staying, [{ guest: c, booking: out.departed[0].booking, breakdown: out.departed[0].breakdown, roomId: suite.id }]);
    expect(rec.events[0].message).toMatch(new RegExp(`checked out: \\$${(suite.pricePerNight * 4).toLocaleString('en-US')} \\(double, for the top floor\\)`));
    expect(rec.state.activeReputationPenalties).toEqual([]); // (no write-up from a celebrity)
    // Moved off the top floor after a night: the story says one night was double
    const partly = { ...c, spotlight: { kind: 'celebrity' as const, rate: 2, until: 11 } };
    expect(recordSpotlightOutcome(staying, [{ guest: partly, booking: out.departed[0].booking, breakdown: out.departed[0].breakdown, roomId: suite.id, paid: 600 }]).events[0].message)
      .toMatch(/checked out: \$600 \(double for 1 night on the top floor\), and a/);
    const none = { ...c, spotlight: { kind: 'celebrity' as const, rate: 2, until: 10 } };
    expect(recordSpotlightOutcome(staying, [{ guest: none, booking: out.departed[0].booking, breakdown: out.departed[0].breakdown, roomId: suite.id, paid: 400 }]).events[0].message)
      .toMatch(/checked out: \$400, and a/);
    // What they paid, a late-checkout fee included, as the tick says
    expect(recordSpotlightOutcome(staying, [{ guest: c, booking: out.departed[0].booking, breakdown: out.departed[0].breakdown, roomId: suite.id, paid: 1234 }]).events[0].message).toMatch(/checked out: \$1,234 \(double/);
  });

  it('through the tick: what a celebrity paid includes a late-checkout fee', () => {
    let s = hotel(1, 0, { day: 12, hour: 12, lateCheckout: 'fee' });
    const suite = s.rooms[0];
    const c = { ...spotlightGuest(plan({ kind: 'celebrity' }), 10), spotlight: { kind: 'celebrity' as const, rate: 2 }, checkInDay: 10, stayLength: 2 };
    const owl = { ...c, profile: { ...c.profile!, chronotype: 'night' as const } };
    s = { ...occupy(s, suite, owl), spotlight: plan({ kind: 'celebrity', status: 'staying', guestId: owl.id, roomId: suite.id }) };
    const prng = new PRNG(1);
    let told: GameEvent | undefined;
    for (let i = 0; i < 6 && !told; i++) {
      const r = tickSimulation(s, prng);
      told = r.events.find(e => e.type === 'spotlight_review');
      s = r.state;
    }
    const fee = Math.round(suite.pricePerNight * GUEST_PROFILE.lateCheckoutFee);
    expect(told!.data!.paid).toBe(suite.pricePerNight * 2 * 2 + fee);
  });

  it('the double rate is for a top-floor suite: a suite lower down is the price, and one moved off the top floor pays the price from then', () => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    s = buildFloor(s)!.state;
    s = addElevator(s, 0, 0)!;
    s = addRoom(s, 'suite', 3, 2, 0, 'up')!;
    s = addRoom(s, 'suite', 4, 2, 1, 'up')!;
    s = { ...s, day: 12, hour: 14, noiseSources: [], guests: [] };
    const up = s.rooms.find(r => r.floor === 1)!;
    const down = s.rooms.find(r => r.floor === 0)!;
    const at = { ...s, spotlight: plan({ kind: 'celebrity', arrivalDay: 12, arrivalHour: 15, roomId: down.id, chosen: true }) };
    const lower = spotlightArrival(at, 14, getAvailableRooms(at))!;
    expect(lower.room!.id).toBe(down.id);
    expect(lower.guest.spotlight).toEqual({ kind: 'celebrity' });
    expect(spotlightArrival({ ...at, spotlight: { ...at.spotlight!, roomId: up.id } }, 14, getAvailableRooms(at))!.guest.spotlight).toEqual({ kind: 'celebrity', rate: 2 });
    // With no hold, the top floor (though the suite lower down is fresher)
    const loose = { ...at, spotlight: { ...at.spotlight!, roomId: undefined, chosen: false }, rooms: at.rooms.map(r => (r.id === up.id ? { ...r, decor: 50 } : r)) };
    expect(spotlightArrival(loose, 14, getAvailableRooms(loose))!.room!.id).toBe(up.id);
    // In the top-floor suite, it breaks; moved down, they pay the price
    const c = { ...spotlightGuest(plan({ kind: 'celebrity', arrivalDay: 12 }), 12), id: 'spotlight-12', spotlight: { kind: 'celebrity' as const, rate: 2 }, stayLength: 2 };
    let st = occupy({ ...s, spotlight: plan({ kind: 'celebrity', arrivalDay: 12, status: 'staying', guestId: c.id }) }, up, c);
    st = { ...st, rooms: st.rooms.map(r => (r.id === up.id ? { ...r, condition: 0 } : r)), activeIncidents: [{ id: 'i1', type: 'mid_stay_breakdown', guestId: c.id, roomId: up.id, stage: 'active' as never, hoursRemaining: 3, chainId: 'i1' }] };
    const moved = advanceIncidents(st, new PRNG(1)).state;
    expect(moved.rooms.find(r => r.id === down.id)!.guestId).toBe(c.id);
    expect(moved.guests[0].spotlight).toEqual({ kind: 'celebrity', rate: 2, until: 12 });
    expect(describeSpotlight(moved.guests[0], moved)[0]).toBe('Celebrity: paying the usual price (moved off the top floor)'); // (moved the day they came: no nights at double)
    expect(describeSpotlight({ ...moved.guests[0], spotlight: { kind: 'celebrity', rate: 2, until: 13 } }, moved)[0]).toBe('Celebrity: paying double for 1 night on the top floor (moved since)');
    // Moved along the same floor: still double
    const twoUp = addRoom(st, 'suite', 5, 2, 1, 'up')!;
    const along = advanceIncidents({ ...twoUp, rooms: twoUp.rooms.map(r => (r.id === down.id ? { ...r, status: 'occupied' as const, guestId: 'someone' } : r)) }, new PRNG(1)).state;
    expect(along.guests[0].spotlight).toEqual({ kind: 'celebrity', rate: 2 });
    // Billed double for the nights before the move only (here: none of the two, moved on the day they came)
    expect(spotlightNightRate(moved.guests[0], 100)).toBe(100);
    expect(spotlightNightRate({ ...moved.guests[0], spotlight: { kind: 'celebrity', rate: 2, until: 13 } }, 100)).toBe(150);
    expect(spotlightNightRate({ ...moved.guests[0], spotlight: { kind: 'celebrity', rate: 2 } }, 100)).toBe(200);
    expect(spotlightNightRate({ ...moved.guests[0], spotlight: { kind: 'celebrity' } }, 100)).toBe(100);
  });

  it('draws 10% more walk-ins the day they come, once they\'re in', () => {
    const s = hotel(1, 0, { day: 12, hour: 16 });
    const c = { ...spotlightGuest(plan({ kind: 'celebrity', arrivalDay: 12 }), 12), id: 'spotlight-12' };
    const staying = { ...s, guests: [c], spotlight: plan({ kind: 'celebrity', arrivalDay: 12, status: 'staying', guestId: c.id }) };
    expect(celebrityPull(staying)).toBe(SPOTLIGHT.celebrity.walkInMult);
    expect(getExpectedArrivalsPerDay(staying) / getExpectedArrivalsPerDay({ ...staying, guests: [] })).toBeCloseTo(SPOTLIGHT.celebrity.walkInMult, 9);
    expect(celebrityPull({ ...staying, day: 13 })).toBe(1);
    expect(celebrityPull({ ...staying, spotlight: { ...staying.spotlight!, kind: 'writer' } })).toBe(1);
    expect(celebrityPull({ ...staying, guests: [] })).toBe(1);
    withSwitch(SPOTLIGHT, false, () => expect(celebrityPull(staying)).toBe(1));
  });
});

describe('Spotlight guests: on screen', () => {
  it('the top bar: due (and when), staying, and what\'s moving bookings', () => {
    const s = hotel(1, 0, { day: 9, hour: 9 });
    const T = (9 - 1) * 24 + 9;
    expect(spotlightBanner({ ...s, spotlight: plan() }, T)).toEqual(['✎ Travel writer due Wed ~15:00 (in 1d 6h)']);
    expect(spotlightBanner({ ...s, spotlight: plan() }, arrivalTime(plan()) - 0.5)).toEqual(['✎ Travel writer due Wed ~15:00 (in under an hour)']);
    expect(spotlightBanner({ ...s, spotlight: plan() }, arrivalTime(plan()) + 2)).toEqual(['✎ Travel writer due Wed ~15:00 (now)']);
    expect(spotlightBanner({ ...s, spotlight: plan({ kind: 'celebrity' }) }, T)[0]).toMatch(/^★ Celebrity due/);
    const w = spotlightGuest(plan(), 10);
    const staying = { ...occupy(s, s.rooms[0], w), spotlight: plan({ status: 'staying' as const, guestId: w.id, roomId: 'moved-from' }) };
    expect(spotlightBanner(staying, T)).toEqual(['✎ Travel writer staying in 124']); // (the room they're in now)
    expect(spotlightBanner({ ...s, activeReputationPenalties: [{ multiplier: 1.2, hoursRemaining: 30, kind: 'write_up' }, { multiplier: 0.7, hoursRemaining: 5 }] }, T))
      .toEqual(['Write-up: bookings +20% (30h)', 'Bad review spreading: bookings −30% (5h)']);
    withSwitch(SPOTLIGHT, false, () => expect(spotlightBanner({ ...s, spotlight: plan() }, T)).toEqual([]));
  });

  it('their card says who they are', () => {
    const s = hotel(1, 0);
    const w = spotlightGuest(plan(), 10);
    expect(describeSpotlight(w, s)[0]).toMatch(/^Travel writer: judges the hotel as a 4-star one/);
    const celeb = { ...spotlightGuest(plan({ kind: 'celebrity' }), 10), spotlight: { kind: 'celebrity' as const, rate: 2 } };
    expect(describeSpotlight(celeb, s)).toEqual(['Celebrity: paying double for a top-floor suite', 'Keeps the door shut; draws 10% more walk-ins the day they come']);
    expect(describeSpotlight({ ...celeb, profile: { ...celeb.profile!, housekeeping: undefined } }, s)[1]).toBe('Draws 10% more walk-ins the day they come');
    expect(describeSpotlight(guest('g'), s)).toEqual([]);
    // What they've still to try, of what's open
    const gym = addFacility(s, 'gym', 7, 0, 0, 'down')!;
    expect(describeSpotlight(w, gym)[1]).toMatch(/; yet to try: the gym$/);
    expect(describeSpotlight({ ...w, facilitiesUsed: { gym: { level: 1, day: 10 } } }, gym)[1]).toMatch(/; has tried everything here$/);
    expect(describeSpotlight(w, s)[1]).toMatch(/or less and it spreads$/); // (nothing open)
    // The room card's tag
    expect(guestTags(w)).toEqual(['travel writer']);
    expect(guestTags(spotlightGuest(plan({ kind: 'celebrity' }), 10))).toEqual(['celebrity', 'big spender']);
  });
});

describe('Spotlight guests: in line', () => {
  it('no patience clock over a spotlight guest (they never give up), as there is over anyone else', () => {
    const s = hotel(1, 0, { day: 10, hour: 15 });
    const desk = s.fixtures.find(f => f.type === 'desk')!;
    const wait: Leg[] = [{ kind: 'stay', at: { gridX: desk.gridX, gridY: desk.gridY + 1, floor: 0 }, start: 0, end: 100, activity: 'wait', lane: `${desk.id}:0`, placeId: desk.id } as Leg];
    const w = { ...spotlightGuest(plan(), 10), trip: wait, tripKind: 'arrival' as const };
    const g = { ...guest('g'), trip: wait, tripKind: 'arrival' as const };
    expect(guestFigures({ ...s, guests: [g] }, 50).figures[0].clock).toBeGreaterThan(0);
    expect(guestFigures({ ...s, guests: [w] }, 50).figures[0].clock).toBeUndefined();
  });
});

describe('Spotlight guests: the story kept', () => {
  it('an announced spotlight guest\'s story stays in the log however many others come after it', () => {
    let s = hotel(1, 0, { day: 9, spotlight: plan({ status: 'planned', announceDay: 9, arrivalDay: 11, chainId: 'spotlight-11' }) });
    s = planSpotlight(s).state;
    for (let i = 0; i < STORY.storyLogMaxChains + 5; i++) s = appendStoryLogEntry({ ...s, hour: 10 + (i % 10) }, { type: 'note', message: `n${i}` }).state;
    expect(s.storyLog.some(e => e.chainId === 'spotlight-11')).toBe(true);
    expect(new Set(s.storyLog.map(e => e.chainId)).size).toBe(STORY.storyLogMaxChains);
    // Once it's over, it goes like any other
    let done: HotelState = { ...s, spotlight: { ...s.spotlight!, status: 'done' } };
    for (let i = 0; i < STORY.storyLogMaxChains; i++) done = appendStoryLogEntry(done, { type: 'note', message: `m${i}` }).state;
    expect(done.storyLog.some(e => e.chainId === 'spotlight-11')).toBe(false);
  });
});

describe('Spotlight guests: switched off', () => {
  it('a suite is any suite: no holds, no spotlight arrivals, no write-ups', () => {
    const s = hotel(1, 0, { day: 10, hour: 15, spotlight: plan({ roomId: 'room-x' }) });
    withSwitch(SPOTLIGHT, false, () => {
      expect(holdFor(s, s.rooms[0])).toBeNull();
      expect(holdSuite(s, s.rooms[0].id)).toBeNull();
      expect(holdBlocksRenovation({ ...s, spotlight: plan({ roomId: s.rooms[0].id }) }, s.rooms[0].id, 999)).toBe(false);
      expect(processArrivals(s, 14, new PRNG(1)).spotlight).toBeUndefined();
      // A spotlight guest from a save made with it on: an ordinary guest now
      const c = { ...spotlightGuest(plan({ kind: 'celebrity' }), 10), spotlight: { kind: 'celebrity' as const, rate: 2 }, checkInDay: 10, stayLength: 2 };
      const w = { ...spotlightGuest(plan(), 10), checkInDay: 10, stayLength: 2 };
      const there = occupy({ ...hotel(1, 0, { day: 12, hour: 10 }) }, hotel(1, 0).rooms[0], c);
      expect(processDepartures(there, new PRNG(1)).departed[0].booking.nightRate).toBe(there.rooms[0].pricePerNight);
      expect(bookingWeightFor(w)).toBeUndefined();
      expect(quirkOf(c)).toBe('coin');
      expect(guestTags(w)).toEqual([]);
      const prng = new PRNG(5);
      calculateGuestReviewBreakdown(there.rooms[0], there, w, prng);
      expect(prng.next()).not.toBe(new PRNG(5).next()); // (the variance drawn, as for anyone)
      // A write-up left in a save lifts nothing; a writer's bad review left in the log isn't the day's one
      expect(getReputationPenaltyMultiplier({ ...there, activeReputationPenalties: [{ multiplier: 1.2, hoursRemaining: 5, kind: 'write_up' }] })).toBe(1);
      expect(writeUpMultiplier({ activeReputationPenalties: [{ multiplier: 1.2, hoursRemaining: 5, kind: 'write_up' }] })).toBe(1);
      const other = guest('other');
      const bad: DepartedGuestReview = { guestName: 'other', roomId: 'r2', booking: booking(other, 'r2', 1), breakdown: BD({ noisePenalty: 3 }), guest: other };
      const panned = { ...there, storyLog: [{ id: 'x', day: there.day, hour: 9, type: 'spotlight_pan', message: 'm', chainId: 'spotlight-11' }] };
      expect(checkReviewSemiViral(panned, [bad], new PRNG(1)).state.activeReputationPenalties).toHaveLength(1);
    });
    expect(profileRoom(s.rooms[0]).type).toBe('suite');
  });
});
