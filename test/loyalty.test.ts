import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, addFacility } from '../src/simulation/HotelState.js';
import { processArrivals, processDepartures, calculateGuestReviewBreakdown, getWordOfMouthMultiplier } from '../src/simulation/GuestManager.js';
import { updateReviewScore } from '../src/simulation/EconomyManager.js';
import { rollProfile, favoriteOf, favoriteChanceMult, describeFavorite } from '../src/simulation/Profile.js';
import { visitChance, planFacilityVisits, creditFacilityVisits, facilityReviewBonus, facilityStatus } from '../src/simulation/FacilityManager.js';
import { tierOf, ordinal, describeLoyalty, returnEntry, returnChance, addToPool, dueIndexes, pickDue, expectationMultFor, bookingWeightFor, isLostRegular } from '../src/simulation/Loyalty.js';
import { moodOf, moodFace } from '../src/simulation/Mood.js';
import { recordReturnGuestEntries, recordLostRegulars, attributeReviewCause } from '../src/simulation/StoryGenerator.js';
import { recordDailyStat } from '../src/simulation/ObjectivesManager.js';
import { departureWalker, planArrivalTrips } from '../src/simulation/GuestMovement.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { ToastQueue } from '../src/game/ToastQueue.js';
import { guestFigures } from '../src/render/figures.js';
import { hourStart, makeStay } from '../src/simulation/Movement.js';
import { PRNG } from '../src/simulation/prng.js';
import { GUEST_FAVORITES, LOYALTY, MOOD, SATISFACTION, FACILITY_CONFIG, FACILITY_LEVELS, FACILITY_VISITS, STORY, SPENDING } from '../src/config/balance.js';
import type { Booking, Guest, GuestProfile, HotelState, Leg, Party, PartyKind, ReturningGuestProfile, FacilityType } from '../src/simulation/types.js';

const P = (kind: PartyKind, size: number): Party => ({ kind, size });
const PROFILE: GuestProfile = { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, favorite: 'none' };
const fan = (favorite: FacilityType | 'none'): GuestProfile => ({ ...PROFILE, favorite });

function guest(id: string, extra: Partial<Guest> = {}): Guest {
  return { id, name: 'Sam', budget: 1000, stayLength: 2, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false, ...extra };
}

/** The starter hotel with standard rooms on row 2 (doors up), each with one of these guests in it. */
function hotel(guests: Guest[], extra: Partial<HotelState> = {}): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
  for (let x = 0; x < guests.length; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
  return {
    ...s, day: 3, hour: 9, noiseSources: [], guests,
    rooms: s.rooms.map((r, i) => ({ ...r, status: 'occupied' as const, guestId: guests[i].id })),
    ...extra,
  };
}

/** With a facility type's visit chance set (so tests don't hang on dice). */
function withChance<T>(type: FacilityType, chance: number, fn: () => T): T {
  const original = FACILITY_CONFIG[type].visitChance;
  FACILITY_CONFIG[type].visitChance = [[0, 24, chance]];
  try { return fn(); } finally { FACILITY_CONFIG[type].visitChance = original; }
}

describe('Favourite facilities', () => {
  it('are rolled with the profile, leaning by who the guest is; about half have none', () => {
    const share = (party: Party, purpose: 'business' | 'sightseeing' | 'getaway', f: string) => {
      let n = 0;
      for (let i = 0; i < 4000; i++) if (rollProfile(`g${i}`, party, purpose, 'normal')!.favorite === f) n++;
      return n / 4000;
    };
    SPENDING.enabled = false;
    try { expect(share(P('solo', 1), 'sightseeing', 'none')).toBeCloseTo(0.55, 1); } finally { SPENDING.enabled = true; }
    // A thrifty guest is never a fan of what they won't pay for: more have none
    for (let i = 0; i < 4000; i++) {
      const p = rollProfile(`g${i}`, P('solo', 1), 'sightseeing', 'normal')!;
      if (p.spending === 'thrifty') expect(['shop', 'restaurant']).not.toContain(p.favorite);
    }
    expect(share(P('solo', 1), 'sightseeing', 'none')).toBeGreaterThan(0.6);
    expect(share(P('business', 1), 'business', 'gym')).toBeGreaterThan(share(P('solo', 1), 'sightseeing', 'gym'));
    expect(share(P('family', 4), 'sightseeing', 'pool')).toBeGreaterThan(share(P('solo', 1), 'sightseeing', 'pool'));
    expect(share(P('business', 1), 'business', 'pool')).toBe(0);
    GUEST_FAVORITES.enabled = false;
    try { expect(rollProfile('g', P('solo', 1), 'sightseeing', 'normal')!.favorite).toBeUndefined(); } finally { GUEST_FAVORITES.enabled = true; }
  });

  it('a fan is three times as likely to go; anyone else a little less; a guest without a roll as ever', () => {
    expect(favoriteChanceMult({ profile: fan('gym') }, 'gym')).toBe(GUEST_FAVORITES.fanChanceMult);
    expect(favoriteChanceMult({ profile: fan('gym') }, 'restaurant')).toBe(GUEST_FAVORITES.nonFanChanceMult.restaurant);
    expect(favoriteChanceMult({ profile: fan('none') }, 'gym')).toBe(GUEST_FAVORITES.nonFanChanceMult.gym);
    expect(favoriteChanceMult({ profile: PROFILE }, 'gym')).not.toBe(1);
    expect(favoriteChanceMult({ profile: { ...PROFILE, favorite: undefined } }, 'gym')).toBe(1); // a 1a-era profile
    expect(favoriteChanceMult({}, 'gym')).toBe(1);
    expect(visitChance('gym', 7, 40, { profile: fan('gym') })).toBeCloseTo(Math.min(1, visitChance('gym', 7, 40, {}) * 3), 9);
  });

  it('a fan goes twice a day, a few hours apart; anyone else once', () => {
    withChance('gym', 1, () => {
      let s = hotel([guest('fan', { profile: fan('gym') }), guest('other', { profile: fan('none') })], { hour: 9 });
      s = { ...addFacility(s, 'gym', 2, 0, 0, 'down')!, noiseSources: [] };
      const T = hourStart(s);
      const went = (st: HotelState) => planFacilityVisits(st).guests.filter(g => g.tripKind === 'visit').map(g => g.id);
      const usedAt = (lastAt: number) => ({ gym: { level: 1, day: s.day, today: 1, visits: 1, lastAt } });
      const seen = { ...s, guests: s.guests.map(g => ({ ...g, facilitiesUsed: usedAt(T - 1) })) };
      expect(went(seen)).toEqual([]); // an hour ago: not yet
      const later = { ...s, guests: s.guests.map(g => ({ ...g, facilitiesUsed: usedAt(T - GUEST_FAVORITES.fanRevisitGapHours) })) };
      expect(went(later)).toEqual(['fan']); // the fan goes again; the other doesn't
      const twice = { ...later, guests: later.guests.map(g => ({ ...g, facilitiesUsed: { gym: { ...usedAt(T - 5).gym, today: 2 } } })) };
      expect(went(twice)).toEqual([]);
    });
  });

  it('the gap is from the hour they went: planned, credited, and four hours on they may go again; a new day starts afresh', () => {
    withChance('gym', 1, () => {
      let s = hotel([guest('fan', { profile: fan('gym') })], { hour: 9 });
      s = { ...addFacility(s, 'gym', 2, 0, 0, 'down')!, noiseSources: [] };
      const T = hourStart(s);
      const planned = planFacilityVisits(s);
      expect(planned.guests[0].tripKind).toBe('visit');
      const credited = creditFacilityVisits(planned, T + 1);
      expect(credited.guests[0].facilitiesUsed!.gym).toMatchObject({ today: 1, visits: 1, lastAt: T });
      const at = (hour: number) => planFacilityVisits({ ...credited, hour, guests: credited.guests.map(g => ({ ...g, trip: null, tripKind: undefined })) });
      expect(at(9 + GUEST_FAVORITES.fanRevisitGapHours - 1).guests[0].tripKind).toBeUndefined();
      expect(at(9 + GUEST_FAVORITES.fanRevisitGapHours).guests[0].tripKind).toBe('visit');
      // The next day: twice yesterday doesn't count
      const yesterday = { ...s, guests: s.guests.map(g => ({ ...g, facilitiesUsed: { gym: { level: 1, day: s.day - 1, today: 2, visits: 2, lastAt: T - 2 } } })) };
      const today = planFacilityVisits(yesterday);
      expect(today.guests[0].tripKind).toBe('visit');
      expect(creditFacilityVisits(today, T + 1).guests[0].facilitiesUsed!.gym).toMatchObject({ day: s.day, today: 1, visits: 3 });
    });
  });

  it('a visit lifts their mood (their favourite most), is counted, and a delighted guest spends more at the shop', () => {
    let s = hotel([guest('fan', { profile: fan('shop'), satisfaction: 50 }), guest('happy', { profile: fan('none'), satisfaction: 70 })], { hour: 15 });
    s = { ...addFacility(s, 'shop', 2, 0, 0, 'down')!, noiseSources: [] };
    const shop = s.facilities[0];
    const T = hourStart(s);
    const at = { gridX: shop.gridX, gridY: shop.gridY, floor: 0, door: shop.door };
    const visit = (): Leg[] => [makeStay(at, T + 0.1, T + 0.5, 'visit', { placeId: shop.id })];
    s = { ...s, guests: s.guests.map(g => ({ ...g, trip: visit(), tripKind: 'visit' as const })) };
    const cash = s.cash;
    const after = creditFacilityVisits(s, T + 1);
    const [f, h] = after.guests;
    expect(f.satisfaction).toBe(50 + GUEST_FAVORITES.favoriteVisitMood);
    expect(h.satisfaction).toBe(70 + GUEST_FAVORITES.visitMood);
    expect(f.facilitiesUsed!.shop).toMatchObject({ visits: 1, today: 1 });
    expect(h.facilitiesUsed!.shop).toEqual({ level: 1, day: s.day }); // not a fan: nothing to count
    const spend = FACILITY_CONFIG.shop.spendPerVisit * FACILITY_LEVELS[0].revenueMult;
    expect(after.cash - cash).toBeCloseTo(spend + spend * MOOD.delightedShopMult, 9);
    // In the review, their favourite counts for more
    const used = { shop: { level: 1, day: 3 } };
    expect(facilityReviewBonus(guest('a', { profile: fan('shop'), facilitiesUsed: used }), 3)).toBeCloseTo(FACILITY_CONFIG.shop.visitReviewBonus * GUEST_FAVORITES.fanReviewMult, 9);
    expect(facilityReviewBonus(guest('b', { profile: fan('none'), facilitiesUsed: used }), 3)).toBeCloseTo(FACILITY_CONFIG.shop.visitReviewBonus, 9);
  });

  it('a favourite that isn\'t here lets them down once the stars allow one (a swimmer goes to the beach), and the hotel sees it was wanted', () => {
    withChance('pool', 1, () => {
      const s = hotel([guest('swimmer', { profile: fan('pool'), checkInDay: 2, stayLength: 3 })], { hour: 10 });
      const after = planFacilityVisits(s);
      const g = after.guests[0];
      expect(g.satisfaction).toBe(55 - GUEST_FAVORITES.missMood);
      expect(g.favoriteMisses).toEqual({ day: s.day, count: 1 });
      expect(g.tripKind).toBe('outing');
      expect(g.trip!.some(l => l.kind === 'stay' && l.out === 'beach')).toBe(true);
      expect(after.facilityDemand!.wanted.pool).toBe(1);
      // Once a day
      const again = planFacilityVisits({ ...after, hour: 11, guests: after.guests.map(x => ({ ...x, trip: null, tripKind: undefined })) });
      expect(again.guests[0].satisfaction).toBe(g.satisfaction);
      expect(again.facilityDemand!.wanted.pool).toBe(1);
      // Before the stars allow a pool: wanted, but no letdown
      const early = planFacilityVisits({ ...s, peakStarRating: 2 });
      expect(early.guests[0].satisfaction).toBe(55);
      expect(early.facilityDemand!.wanted.pool).toBe(1);
      // The day's stats keep the count
      expect(recordDailyStat(after).dailyStats.at(-1)!.wanted).toEqual({ pool: 1 });
    });
  });

  it('a foodie with no restaurant goes out for the meal of the hour, at most twice a day, a few hours apart', () => {
    withChance('restaurant', 1, () => {
      const s = hotel([guest('foodie', { profile: fan('restaurant'), checkInDay: 2, stayLength: 3 })], { hour: 7 });
      const meal = (st: HotelState) => {
        const g = planFacilityVisits(st).guests[0];
        const away = g.trip?.find(l => l.kind === 'stay' && l.activity === 'away');
        return away && away.kind === 'stay' ? away.out : undefined;
      };
      expect(meal(s)).toBe('breakfast');
      expect(meal({ ...s, hour: 12 })).toBe('lunch');
      expect(meal({ ...s, hour: 18 })).toBe('dinner');
      const T = hourStart(s);
      const out = planFacilityVisits(s).guests[0];
      expect(out.favoriteOutings).toEqual({ day: s.day, today: 1, lastAt: T });
      const back = (hour: number, outings: Guest['favoriteOutings']) => meal({ ...s, hour, guests: [{ ...s.guests[0], favoriteOutings: outings }] });
      expect(back(9, { day: s.day, today: 1, lastAt: T })).toBeUndefined(); // too soon
      expect(back(12, { day: s.day, today: 1, lastAt: T })).toBe('lunch');
      expect(back(18, { day: s.day, today: 2, lastAt: T + 5 })).toBeUndefined(); // twice already
    });
  });

  it('a full favourite lets a fan down; one too far to walk to is counted, not held against them', () => {
    withChance('gym', 1, () => {
      let s = hotel([guest('fan', { profile: fan('gym') })], { hour: 9 });
      s = { ...addFacility(s, 'gym', 2, 0, 0, 'down')!, noiseSources: [] };
      const gym = s.facilities[0];
      const T = hourStart(s);
      // Full: four others in there all hour
      const at = { gridX: gym.gridX, gridY: gym.gridY, floor: 0, door: gym.door };
      const others = Array.from({ length: 4 }, (_, i) => guest(`o${i}`, { trip: [makeStay(at, T, T + 2, 'visit', { placeId: gym.id })], tripKind: 'visit' }));
      const full = planFacilityVisits({ ...s, guests: [...s.guests, ...others] });
      expect(full.facilityDemand!.full.gym).toBe(1);
      expect(full.facilityDemand!.fullAt).toEqual({ [gym.id]: 1 }); // the gym that was full, on its own card
      expect(full.guests[0].favoriteMisses?.count).toBe(1);
      // Too far to walk to: counted, not held against them
      const saved = FACILITY_VISITS.maxWalkHours;
      FACILITY_VISITS.maxWalkHours = 0.001;
      try {
        const far = planFacilityVisits(s);
        expect(far.facilityDemand!.tooFar.gym).toBe(1);
        expect(far.guests[0].favoriteMisses).toBeUndefined();
        expect(far.guests[0].satisfaction).toBe(55);
      } finally { FACILITY_VISITS.maxWalkHours = saved; }
    });
  });

  it('the hotel has a facility open, built but shut off (its door blocked), or none', () => {
    let s = { ...addFacility(hotel([guest('a')]), 'gym', 2, 0, 0, 'down')!, noiseSources: [] };
    expect(facilityStatus(s, 'gym')).toBe('open');
    expect(facilityStatus(s, 'pool')).toBe('none');
    s = { ...s, facilities: s.facilities.map(f => ({ ...f, door: 'up' as const })) }; // facing the outside wall
    expect(facilityStatus(s, 'gym')).toBe('closed');
  });

  it('their card says how it\'s going', () => {
    const g = guest('a', { profile: fan('pool'), facilitiesUsed: { pool: { level: 1, day: 3, visits: 2 } }, favoriteMisses: { day: 3, count: 1 } });
    expect(describeFavorite(g, 'open', 'Pool')).toBe('Loves the pool (2 visits this stay; let down once)');
    expect(describeFavorite(guest('b', { profile: fan('pool') }), 'none', 'Pool')).toBe("Loves the pool (there isn't one here)");
    expect(describeFavorite(guest('b', { profile: fan('pool'), favoriteMisses: { day: 3, count: 2 } }), 'none', 'Pool')).toBe("Loves the pool (there isn't one here; let down 2 times)");
    expect(describeFavorite(g, 'closed', 'Pool')).toBe('Loves the pool (its door is blocked; 2 visits this stay; let down once)');
    expect(describeFavorite(guest('c', { profile: fan('none') }), 'open', 'Pool')).toBeNull();
    expect(favoriteOf(guest('d', { profile: fan('gym') }))).toBe('gym');
  });

  it('their review loses a little for each day it let them down (at most two), and says so if it\'s the worst thing', () => {
    let s = hotel([guest('a', { profile: fan('pool'), favoriteMisses: { day: 2, count: 3 } })]);
    const room = { ...s.rooms[0], condition: 100, cleanliness: 100, decor: 100 };
    s = { ...s, rooms: [room] };
    const b = calculateGuestReviewBreakdown(room, s, s.guests[0], new PRNG(1));
    expect(b.favoriteMiss).toBeCloseTo(GUEST_FAVORITES.maxMissesPerStay * GUEST_FAVORITES.missReview, 9);
    const plain = calculateGuestReviewBreakdown(room, s, { ...s.guests[0], favoriteMisses: undefined }, new PRNG(1));
    expect(plain.finalScore - b.finalScore).toBeCloseTo(b.favoriteMiss!, 9);
    expect(attributeReviewCause({ ...b, noisePenalty: 0, priceFairness: 1, elevatorPenalty: 0 })).toBe('the pool');
  });

  it('an angry guest skips the facilities', () => {
    withChance('gym', 1, () => {
      let s = hotel([guest('cross', { profile: fan('gym'), satisfaction: MOOD.angry - 1 }), guest('fine', { profile: fan('gym') })]);
      s = { ...addFacility(s, 'gym', 2, 0, 0, 'down')!, noiseSources: [] };
      expect(planFacilityVisits(s).guests.filter(g => g.tripKind === 'visit').map(g => g.id)).toEqual(['fine']);
    });
  });
});

describe('Loyalty', () => {
  it('tiers by stays, in words', () => {
    expect([1, 2, 3, 4, 5, 9].map(tierOf)).toEqual(['first', 'returning', 'regular', 'regular', 'vip', 'vip']);
    expect([1, 2, 3, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '11th', '12th', '13th', '21st', '22nd']);
    expect(describeLoyalty(guest('a'))).toBe('First stay');
    expect(describeLoyalty(guest('a', { isReturning: true }))).toBe('2nd stay');
    expect(describeLoyalty(guest('a', { isReturning: true, loyalty: { personId: 'p', stays: 4 } }))).toBe('4th stay (a regular)');
    expect(describeLoyalty(guest('a', { isReturning: true, loyalty: { personId: 'p', stays: 6 } }))).toBe('VIP: 6th stay');
  });

  it('the happier a guest leaves, the likelier they want to come back (a delighted one more so), a few days to a month on', () => {
    expect(returnChance(LOYALTY.entryFrom)).toBe(0);
    expect(returnChance(LOYALTY.entryFull)).toBe(1);
    expect(returnChance(MOOD.delighted)).toBeCloseTo(Math.min(1, (MOOD.delighted - LOYALTY.entryFrom) / (LOYALTY.entryFull - LOYALTY.entryFrom) * LOYALTY.delightedMult), 9);
    const room = hotel([guest('a')]).rooms[0];
    const entry = returnEntry(guest('a', { profile: PROFILE }), 100, room, 8, 10)!;
    expect(entry).toMatchObject({ name: 'Sam', personId: 'a', stays: 1, profile: PROFILE, lastRoomId: room.id, lastReview: 8 });
    expect(entry.dueDay).toBeGreaterThanOrEqual(10 + LOYALTY.returnAfterDays[0]);
    expect(entry.dueDay).toBeLessThanOrEqual(10 + LOYALTY.returnAfterDays[1]);
    expect(returnEntry(guest('a'), LOYALTY.entryFrom, room, 8, 10)).toBeNull();
    // Off: the old rule, as it was
    LOYALTY.enabled = false;
    try {
      expect(returnEntry(guest('a'), SATISFACTION.returnEligibleThreshold, room, 8, 10)).toEqual({ name: 'Sam', trait: 'normal', roomType: room.type });
      expect(returnEntry(guest('a'), SATISFACTION.returnEligibleThreshold - 1, room, 8, 10)).toBeNull();
    } finally { LOYALTY.enabled = true; }
  });

  it('a regular who leaves much unhappier than last time is lost', () => {
    const regular = guest('r', { isReturning: true, loyalty: { personId: 'p', stays: 3, lastReview: 8 } });
    expect(isLostRegular(regular, 6.5)).toBe(true);
    expect(isLostRegular(regular, 7.5)).toBe(false);
    expect(isLostRegular({ ...regular, loyalty: { personId: 'p', stays: 2, lastReview: 8 } }, 5)).toBe(false); // a second stay isn't a regular yet
    const room = hotel([guest('a')]).rooms[0];
    expect(returnEntry(regular, 100, room, 6, 10)).toBeNull();
  });

  it('the pool keeps the most loyal; only those due can come; VIPs are likelier', () => {
    const p = (name: string, stays: number, dueDay = 0): ReturningGuestProfile => ({ name, trait: 'normal', roomType: 'standard', personId: name, stays, dueDay });
    let pool: ReturningGuestProfile[] = Array.from({ length: LOYALTY.poolMaxSize }, (_, i) => p(`p${i}`, 2));
    pool = addToPool(pool, p('vip', 6));
    expect(pool).toHaveLength(LOYALTY.poolMaxSize);
    expect(pool.some(x => x.name === 'vip')).toBe(true);
    expect(pool.some(x => x.name === 'p0')).toBe(false); // the least loyal, longest waiting, made room
    expect(pool.some(x => x.name === 'p1')).toBe(true);
    const due = dueIndexes([p('a', 1, 5), p('b', 1, 9), p('c', 4, 3)], 5);
    expect(due).toEqual([0, 2]);
    const both = [p('a', 1), p('v', 4)]; // the second would be on their 5th stay: a VIP
    expect(pickDue(both, [0, 1], 0.3)).toBe(0);
    expect(pickDue(both, [0, 1], 0.4)).toBe(1); // weights 1 : 2
    LOYALTY.enabled = false;
    try {
      expect(dueIndexes([p('a', 1, 99)], 5)).toEqual([0]);
      expect(pickDue(both, [0, 1], 0.4)).toBe(0); // floor(0.4 x 2)
    } finally { LOYALTY.enabled = true; }
  });

  it('a regular comes back as the same person, one stay more, and asks for their old room', () => {
    let s = { ...hotel([]), day: 30, hour: 15, staff: { ...createStarterHotel().staff, frontDesk: 6 } };
    for (let x = 0; x < 4; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
    const old = s.rooms[2];
    const me: GuestProfile = { ...PROFILE, chronotype: 'night', favorite: 'gym', housekeeping: 'makeup', patience: 'patient', voice: 'stoic', spending: 'thrifty' };
    s = { ...s, returningGuestPool: [{ name: 'Mei', trait: 'normal', roomType: old.type, personId: 'mei', stays: 2, profile: me, lastRoomId: old.id, lastReview: 8, dueDay: 20 }] };
    let back: Guest | undefined;
    let roomId = '';
    for (let seed = 1; seed < 400 && !back; seed++) {
      const r = processArrivals(s, 15, new PRNG(seed));
      const c = r.checkedIn.find(x => x.guest.name === 'Mei' && x.guest.isReturning);
      if (c) { back = c.guest; roomId = c.roomId; }
    }
    expect(back).toBeDefined();
    expect(back!.loyalty).toMatchObject({ personId: 'mei', stays: 3, lastRoomId: old.id, oldRoom: true });
    expect(back!.profile).toEqual(me);
    expect(roomId).toBe(old.id);
  });

  it('a rowdy guest who comes back with the family is not rowdy this time', () => {
    let s = { ...hotel([]), day: 30, hour: 15, staff: { ...createStarterHotel().staff, frontDesk: 6 } };
    for (let x = 0; x < 4; x++) s = addRoom(s, 'bunk_family', x + 3, 2, 0, 'up')!;
    const rowdy: GuestProfile = { ...PROFILE, rowdiness: 'rowdy' };
    s = { ...s, returningGuestPool: Array.from({ length: 20 }, (_, i) => ({ name: 'Rex', trait: 'party_guest' as const, roomType: 'standard' as const, personId: `rex${i}`, stays: 1, profile: rowdy, dueDay: 1 })) };
    let families = 0;
    for (let seed = 1; seed < 300 && families < 3; seed++) {
      for (const { guest: g } of processArrivals(s, 15, new PRNG(seed)).checkedIn) {
        if (!g.isReturning) continue;
        if (g.party?.kind === 'family') { families++; expect(g.profile!.rowdiness).not.toBe('rowdy'); }
        else expect(g.profile!.rowdiness).toBe('rowdy');
      }
    }
    expect(families).toBeGreaterThan(0);
  });

  it('a returning guest turned away tries again another day', () => {
    // No staffed desk: everyone leaves
    const s = { ...hotel([]), day: 30, hour: 15, staff: { ...createStarterHotel().staff, frontDesk: 0 }, returningGuestPool: [{ name: 'Mei', trait: 'normal' as const, roomType: 'standard' as const, personId: 'mei', stays: 2, dueDay: 20 }] };
    for (let seed = 1; seed < 200; seed++) {
      const r = processArrivals(s, 15, new PRNG(seed));
      if (r.returningGuestPool.length === 1 && r.returningGuestPool[0].dueDay === s.day + 2) return;
    }
    throw new Error('never pulled and put back');
  });

  it('the loyal forgive more, and a regular\'s review and mood count double', () => {
    expect(expectationMultFor(guest('a'))).toBe(1);
    expect(expectationMultFor(guest('a', { isReturning: true }))).toBe(LOYALTY.expectationMult.returning);
    expect(expectationMultFor(guest('a', { isReturning: true, loyalty: { personId: 'p', stays: 5 } }))).toBe(LOYALTY.expectationMult.vip);
    expect(bookingWeightFor(guest('a', { isReturning: true }))).toBeUndefined();
    expect(bookingWeightFor(guest('a', { isReturning: true, loyalty: { personId: 'p', stays: 3 } }))).toBe(LOYALTY.bookingWeight);
    const b = (score: number, sat: number, weight?: number): Booking => ({ id: `b${score}`, roomId: 'r', guestId: 'g', nightRate: 80, reviewScore: score, satisfactionAtCheckout: sat, ...(weight ? { weight } : {}) });
    const s = { ...createStarterHotel(), bookings: [b(4, 40), b(10, 70, 2)] };
    expect(updateReviewScore(s)).toBeCloseTo((4 + 20) / 3, 9);
    expect(getWordOfMouthMultiplier(s)).toBeCloseTo(getWordOfMouthMultiplier({ ...s, bookings: [b(4, 40), b(10, 70), b(10, 70)] }), 9);
    // A VIP judges the same room more kindly
    let st = hotel([guest('v')], { starRating: 5 });
    const room = { ...st.rooms[0], condition: 20 };
    st = { ...st, rooms: [room] };
    const vip = calculateGuestReviewBreakdown(room, st, guest('v', { isReturning: true, loyalty: { personId: 'p', stays: 5 } }), new PRNG(1));
    const stranger = calculateGuestReviewBreakdown(room, st, guest('v'), new PRNG(1));
    expect(vip.finalScore).toBeGreaterThan(stranger.finalScore);
  });

  it('a regular\'s return is a story on their own thread; a second stay is a toast; a lost regular is a story too', () => {
    const regular = guest('r', { isReturning: true, loyalty: { personId: 'mei', stays: 3 }, satisfaction: 50 });
    const second = guest('s', { isReturning: true, satisfaction: 50 });
    const s = hotel([regular, second]);
    const after = recordReturnGuestEntries(s, [
      { type: 'guest_returned', message: 'Sam is back for their 3rd stay, in their old room!', data: { guestId: 'r', roomId: s.rooms[0].id, stays: 3, oldRoom: true } },
      { type: 'guest_returned', message: 'Sam is back for another stay!', data: { guestId: 's', roomId: s.rooms[1].id, stays: 2 } },
    ]);
    expect(after.storyLog.map(e => [e.type, e.chainId])).toEqual([['loyal_return', 'person-mei']]);
    expect(after.guests[0].satisfaction).toBe(50 + SATISFACTION.regularReturnBonus + LOYALTY.oldRoomMood);
    expect(after.guests[1].satisfaction).toBe(50 + SATISFACTION.regularReturnBonus);
    const lost = recordLostRegulars(after, [{ type: 'regular_lost', message: "Sam won't be back", data: { guestId: 'r', personId: 'mei', roomId: s.rooms[0].id, stays: 3 } }]);
    expect(lost.storyLog.at(-1)).toMatchObject({ type: 'regular_lost', chainId: 'person-mei' });
    void STORY;
  });

  it('a regular whose stay was a letdown is lost at checkout (a second stay is not); one who walks out is lost too', () => {
    const regular = guest('r', { checkInDay: 1, stayLength: 2, isReturning: true, loyalty: { personId: 'mei', stays: 4, lastReview: 9.9 }, satisfaction: 90 });
    const unkept = (st: HotelState) => ({ ...st, rooms: st.rooms.map(x => ({ ...x, cleanliness: 40 })) }); // the room wasn't made up
    const s = unkept(hotel([regular], { hour: 10 }));
    const r = processDepartures(s, new PRNG(1));
    expect(r.events.find(e => e.type === 'regular_lost')!.data).toMatchObject({ personId: 'mei', stays: 4, roomId: s.rooms[0].id });
    expect(r.returningGuestPool).toEqual([]);
    const second = processDepartures(unkept(hotel([{ ...regular, loyalty: { personId: 'mei', stays: 2, lastReview: 9.9 } }], { hour: 10 })), new PRNG(1));
    expect(second.events.some(e => e.type === 'regular_lost')).toBe(false);
    // Walking out mid-stay after a breakdown, with nowhere to move them: lost, with a story
    const walker = { ...regular, checkInDay: 2, stayLength: 3 };
    const st = hotel([walker], { day: 3, hour: 14 });
    const incident = { id: 'i', type: 'mid_stay_breakdown' as const, guestId: 'r', roomId: st.rooms[0].id, stage: 'active' as const, hoursRemaining: 1, chainId: 'i' };
    const { state: after, events } = tickSimulation({ ...st, rooms: st.rooms.map(x => ({ ...x, condition: 0 })), activeIncidents: [incident] }, new PRNG(1));
    expect(events.some(e => e.type === 'regular_lost')).toBe(true);
    expect(after.storyLog.some(e => e.type === 'regular_lost' && e.chainId === 'person-mei')).toBe(true);
  });

  it('a returning guest turned away walks out with their ring; a second stay toasts even with the story log open', () => {
    const s = { ...hotel([]), day: 4, hour: 15 };
    const vip = guest('v', { isReturning: true, loyalty: { personId: 'p', stays: 6 } });
    const { walkers } = planArrivalTrips(s, [], [{ guest: vip, outcome: 'impatient' }], hourStart(s));
    expect(walkers[0].stays).toBe(6);
    expect(guestFigures({ ...s, walkers }, hourStart(s) + 0.3).figures[0]).toMatchObject({ ring: true, ringTier: 'vip' });
    const q = new ToastQueue();
    q.add([{ type: 'guest_returned', message: 'Sam is back for another stay!', data: { guestId: 'g', stays: 2, unlogged: true } }], 0, true);
    q.add([{ type: 'guest_returned', message: 'Mei is back for their 3rd stay!', data: { guestId: 'm', stays: 3 } }], 0, true);
    expect(q.toasts.map(t => t.message)).toEqual(['Sam is back for another stay!']); // (shown at once)
  });

  it('with loyalty off, the pool is exactly the old one: back at 65, oldest out first, no due days', () => {
    LOYALTY.enabled = false;
    try {
      const plain = (i: number): ReturningGuestProfile => ({ name: `p${i}`, trait: 'normal', roomType: 'standard' });
      const pool = Array.from({ length: STORY.returningGuestPoolMaxSize }, (_, i) => plain(i));
      const happy = guest('h', { checkInDay: 1, stayLength: 2, satisfaction: SATISFACTION.returnEligibleThreshold });
      const s = hotel([happy], { hour: 10, returningGuestPool: pool });
      const r = processDepartures(s, new PRNG(1));
      expect(r.returningGuestPool).toHaveLength(STORY.returningGuestPoolMaxSize);
      expect(r.returningGuestPool[0].name).toBe('p1');
      expect(r.returningGuestPool.at(-1)).toEqual({ name: 'Sam', trait: 'normal', roomType: s.rooms[0].type });
      expect(r.departed[0].booking.weight).toBeUndefined();
    } finally { LOYALTY.enabled = true; }
  });

  it('checking out: the review, whether they\'ll be back, and how they left go with them', () => {
    const happy = guest('h', { checkInDay: 1, stayLength: 2, satisfaction: 90, profile: PROFILE, isReturning: true, loyalty: { personId: 'hp', stays: 3 } });
    const s = hotel([happy], { hour: 10 });
    const r = processDepartures(s, new PRNG(1));
    expect(r.departed[0].booking.weight).toBe(LOYALTY.bookingWeight);
    expect(r.returningGuestPool[0]).toMatchObject({ personId: 'hp', stays: 3, lastRoomId: s.rooms[0].id });
    expect(r.events.find(e => e.type === 'guest_departed')!.data).toMatchObject({ mood: 'delighted', stays: 3 });
    const walker = departureWalker(s, happy, hourStart(s), 'checked_out')!;
    expect(walker).toMatchObject({ stays: 3, mood: 'delighted' });
    // A night owl refused a late checkout walks out as put out as they left
    const owl = guest('o', { checkInDay: 1, stayLength: 2, satisfaction: MOOD.irritated + 2, profile: { ...PROFILE, chronotype: 'night' } });
    const { state: after } = tickSimulation(hotel([owl], { hour: 10 }), new PRNG(1));
    expect(after.walkers!.find(w => w.guestId === 'o')!.mood).toBe('irritated');
  });
});

describe('Mood', () => {
  it('bands where guests really are; off, everyone is content', () => {
    expect(moodOf(MOOD.angry - 0.1)).toBe('angry');
    expect(moodOf(MOOD.irritated - 0.1)).toBe('irritated');
    expect(moodOf(MOOD.irritated)).toBe('content');
    expect(moodOf(MOOD.delighted)).toBe('delighted');
    expect(moodFace('irritated')).toBe('irritated');
    expect(moodFace('delighted')).toBeNull();
    MOOD.enabled = false;
    try { expect(moodOf(10)).toBe('content'); } finally { MOOD.enabled = true; }
  });

  it('figures show the face and the ring\'s tier', () => {
    const legs: Leg[] = [{ kind: 'stay', at: { gridX: 0, gridY: 0, floor: 0 }, start: 0, end: 10, activity: 'wait' }];
    const s = hotel([
      guest('cross', { satisfaction: MOOD.angry - 1, trip: legs, tripKind: 'visit' }),
      guest('vip', { isReturning: true, loyalty: { personId: 'v', stays: 6 }, trip: legs, tripKind: 'visit' }),
    ]);
    const f = guestFigures(s, 1).figures;
    expect(f.find(x => x.guestId === 'cross')!.mood).toBe('angry');
    expect(f.find(x => x.guestId === 'vip')).toMatchObject({ ring: true, ringTier: 'vip' });
    MOOD.enabled = false;
    try { expect(guestFigures(s, 1).figures.find(x => x.guestId === 'cross')!.mood).toBeUndefined(); } finally { MOOD.enabled = true; }
  });
});
