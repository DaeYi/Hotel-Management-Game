import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, addFacility, getElevatorWaitPenalty } from '../src/simulation/HotelState.js';
import { processArrivals, processDepartures, isCheckoutDue, calculateGuestReviewBreakdown } from '../src/simulation/GuestManager.js';
import { processRevenue } from '../src/simulation/EconomyManager.js';
import {
  rollProfile, inHours, activityHour, isSleepHour, nightOf, checkoutHour, guestPace, noiseSensitivity, noiseOutputMult, quirkOf,
  describeRhythm, describeTemperament, guestTags,
} from '../src/simulation/Profile.js';
import { rollParty } from '../src/simulation/Party.js';
import { rollPurpose } from '../src/simulation/Purpose.js';
import { calculateRoomNoise, occupantNoiseOutput, accrueNightNoise, reviewNoisePenalty } from '../src/simulation/NoiseManager.js';
import { visitChance, planFacilityVisits, creditFacilityVisits } from '../src/simulation/FacilityManager.js';
import { outingChance, planOutings } from '../src/simulation/OutingManager.js';
import { planArrivalTrips, departureWalker } from '../src/simulation/GuestMovement.js';
import { getStaffPlan } from '../src/simulation/StaffManager.js';
import { memberPositionAt, makeWalk, hourStart, legsEnd, PARTY_SPACING } from '../src/simulation/Movement.js';
import { checkoutsToday } from '../src/simulation/CleaningStatus.js';
import { PRNG } from '../src/simulation/prng.js';
import { GUEST_PROFILE, GUEST_OUTINGS, FACILITY_CONFIG, ECONOMY, NOISE, TRAVEL, GUEST_TRAITS, STORY } from '../src/config/balance.js';
import type { Guest, GuestProfile, HotelState, Party, PartyKind, Leg } from '../src/simulation/types.js';
import { checkReviewSemiViral, type DepartedGuestReview } from '../src/simulation/StoryGenerator.js';
import { driftSatisfaction, advanceIncidents, selectNewIncident } from '../src/simulation/StoryGenerator.js';
import { guestFigures, partyFigures } from '../src/render/figures.js';
import { nightNoiseThisHour } from '../src/simulation/NoiseManager.js';
import { tickSimulation } from '../src/simulation/tick.js';

const P = (kind: PartyKind, size: number): Party => ({ kind, size });
const PROFILE: GuestProfile = { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11 };
const with_ = (extra: Partial<GuestProfile>): GuestProfile => ({ ...PROFILE, ...extra });

function guest(id: string, extra: Partial<Guest> = {}): Guest {
  return { id, name: 'Sam', budget: 1000, stayLength: 2, trait: 'normal', satisfaction: 60, checkInDay: 1, isReturning: false, hadNoiseComplaint: false, ...extra };
}

/** The starter hotel with standard rooms on row 2 (doors up), each with one of these guests in it. */
function hotel(guests: Guest[], extra: Partial<HotelState> = {}): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
  for (let x = 0; x < guests.length; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
  return {
    ...s, day: 3, hour: 7, noiseSources: [], guests,
    rooms: s.rooms.map((r, i) => ({ ...r, status: 'occupied' as const, guestId: guests[i].id })),
    ...extra,
  };
}

describe('Who a guest is: rolled once from their id', () => {
  it('the same id, party and purpose give the same profile; off gives none', () => {
    expect(rollProfile('g-1', P('couple', 2), 'getaway', 'normal')).toEqual(rollProfile('g-1', P('couple', 2), 'getaway', 'normal'));
    GUEST_PROFILE.enabled = false;
    try { expect(rollProfile('g-1', P('couple', 2), 'getaway', 'normal')).toBeUndefined(); } finally { GUEST_PROFILE.enabled = true; }
  });

  it('light sleepers and rowdy guests come from the trait; the rest of the mix is hashed to heavy 20 / light 20, quiet 20 / rowdy 15', () => {
    expect(rollProfile('x', P('solo', 1), 'sightseeing', 'light_sleeper')!.sleep).toBe('light');
    expect(rollProfile('x', P('solo', 1), 'sightseeing', 'party_guest')!.rowdiness).toBe('rowdy');
    const n = 20000;
    const count = { heavy: 0, light: 0, quiet: 0, rowdy: 0 };
    for (let i = 0; i < n; i++) {
      const roll = i / n; // the trait mix, as the shared stream draws it
      const trait = roll < 0.2 ? 'light_sleeper' : roll < 0.4 ? 'big_spender' : roll < 0.55 ? 'party_guest' : 'normal';
      const p = rollProfile(`g${i}`, P('solo', 1), 'sightseeing', trait)!;
      if (p.sleep === 'heavy') count.heavy++;
      if (p.sleep === 'light') count.light++;
      if (p.rowdiness === 'quiet') count.quiet++;
      if (p.rowdiness === 'rowdy') count.rowdy++;
    }
    expect(Math.abs(count.heavy / n - 0.2)).toBeLessThan(0.01);
    expect(Math.abs(count.quiet / n - 0.2)).toBeLessThan(0.01);
    expect(count.light / n).toBe(0.2); // exactly: the trait's
    expect(count.rowdy / n).toBe(0.15);
  });

  it('business travellers and families lean early and friends late; business brisk, families slow; early birds leave 07-10', () => {
    const share = (party: Party, purpose: 'business' | 'sightseeing', key: 'chronotype' | 'mobility', value: string) => {
      let k = 0;
      for (let i = 0; i < 5000; i++) if (rollProfile(`g${i}`, party, purpose, 'normal')![key] === value) k++;
      return k / 5000;
    };
    expect(share(P('business', 1), 'business', 'chronotype', 'early')).toBeGreaterThan(share(P('couple', 2), 'sightseeing', 'chronotype', 'early'));
    expect(share(P('friends', 3), 'sightseeing', 'chronotype', 'night')).toBeGreaterThan(share(P('couple', 2), 'sightseeing', 'chronotype', 'night'));
    expect(share(P('business', 1), 'business', 'mobility', 'brisk')).toBeGreaterThan(share(P('couple', 2), 'sightseeing', 'mobility', 'brisk'));
    expect(share(P('family', 4), 'sightseeing', 'mobility', 'limited')).toBeGreaterThan(share(P('couple', 2), 'sightseeing', 'mobility', 'limited'));
    for (let i = 0; i < 500; i++) {
      const p = rollProfile(`g${i}`, P('business', 1), 'business', 'normal')!;
      if (p.chronotype === 'early') expect(p.checkoutHour).toBeGreaterThanOrEqual(7), expect(p.checkoutHour).toBeLessThanOrEqual(10);
      else expect(p.checkoutHour).toBe(ECONOMY.checkOutHour);
    }
  });

  it('arrivals get one after their party and purpose, without moving the shared random stream; a family is never rowdy', () => {
    let s = { ...hotel([]), day: 6, hour: 15, staff: { ...createStarterHotel().staff, frontDesk: 4 } };
    for (let x = 0; x < 6; x++) s = addRoom(s, x % 2 ? 'standard' : 'bunk_family', x + 3, 4, 0, 'up')!;
    const on = new PRNG(11);
    const r = processArrivals(s, 15, on);
    expect(r.checkedIn.length).toBeGreaterThan(0);
    for (const { guest: g } of r.checkedIn) {
      const party = rollParty(g.id, s.day);
      expect(g.profile).toEqual(rollProfile(g.id, party, rollPurpose(g.id, party), g.trait));
    }
    // A family is never rowdy, even when the shared stream drew the party trait for them
    const traits = { ...GUEST_TRAITS };
    Object.assign(GUEST_TRAITS, { lightSleeperChance: 0, bigSpenderChance: 0, partyGuestChance: 1 });
    let families = 0;
    try {
      for (let seed = 0; seed < 60; seed++) {
        for (const { guest: g } of processArrivals({ ...s, day: 6 }, 15, new PRNG(seed)).checkedIn) {
          if (g.party?.kind !== 'family') continue;
          families++;
          expect(g.trait).toBe('normal');
          expect(g.profile!.rowdiness).not.toBe('rowdy');
        }
      }
    } finally { Object.assign(GUEST_TRAITS, traits); }
    expect(families).toBeGreaterThan(0);
    GUEST_PROFILE.enabled = false;
    const off = new PRNG(11);
    try { for (const { guest: g } of processArrivals(s, 15, off).checkedIn) expect(g.profile).toBeUndefined(); } finally { GUEST_PROFILE.enabled = true; }
    expect(on.next()).toBe(off.next());
  });

  it('reads in words', () => {
    const owl = guest('o', { profile: with_({ chronotype: 'night', mobility: 'limited', sleep: 'light', rowdiness: 'rowdy' }), nightNoise: { exposure: 1, woken: 2, lastWokenNight: 3 } });
    expect(describeRhythm(owl, { lateCheckout: 'free' })).toBe('Night owl, sleeps 01:00-09:00, checks out 13:00 (late checkout)');
    expect(describeRhythm(owl, {})).toBe('Night owl, sleeps 01:00-09:00, checks out 11:00 (asked for a late checkout: refused)');
    expect(describeTemperament(owl)).toEqual(['Walks slowly (minds a wait for the lift)', 'Light sleeper, woken 2 nights', 'Rowdy, loudest 22:00-02:00']);
    expect(guestTags(owl)).toEqual(['light sleeper']); // one quirk: light sleepers first
    expect(quirkOf(guest('t', { trait: 'party_guest' }))).toBe('note'); // no profile: by the trait
  });
});

describe('Early birds and night owls', () => {
  it('hours wrap past midnight', () => {
    expect(inHours(22, [21, 5])).toBe(true);
    expect(inHours(3, [21, 5])).toBe(true);
    expect(inHours(5, [21, 5])).toBe(false);
    expect(inHours(12, [9, 17])).toBe(true);
    const early = { profile: with_({ chronotype: 'early' as const }) };
    expect(activityHour(early, 4)).toBe(6);
    expect(activityHour({ profile: with_({ chronotype: 'night' }) }, 1)).toBe(23);
    expect(isSleepHour(early, 22)).toBe(true);
    expect(isSleepHour({}, 22)).toBe(false); // a regular sleeps 23-07
    expect(nightOf(early, 2 * 24 + 22)).toBe(nightOf(early, 3 * 24 + 4)); // the evening and the morning after: one night
  });

  it('facilities and outings two hours earlier for an early bird, two later for a night owl', () => {
    const early = { profile: with_({ chronotype: 'early' }) };
    const night = { profile: with_({ chronotype: 'night' }) };
    expect(visitChance('gym', 4, 40, early)).toBe(visitChance('gym', 6, 40, {}));
    expect(visitChance('restaurant', 21, 40, night)).toBe(visitChance('restaurant', 19, 40, {}));
    expect(visitChance('gym', 4, 40, {})).toBe(0);
    expect(outingChance({ trait: 'normal', ...early }, 6)).toBe(outingChance({ trait: 'normal' }, 8));
    expect(outingChance({ trait: 'normal', ...night }, 17)).toBe(outingChance({ trait: 'normal' }, 15));
  });

  it('a night owl out for the day is back by 23:00', () => {
    const saved = GUEST_OUTINGS.leaveChance;
    GUEST_OUTINGS.leaveChance = [[0, 24, 1]];
    try {
      const s = hotel([guest('owl', { profile: with_({ chronotype: 'night' }), checkInDay: 2, stayLength: 3 })], { hour: 17 });
      const trip = planOutings(s).guests[0].trip!;
      expect(legsEnd(trip)).toBeCloseTo((s.day - 1) * 24 + GUEST_OUTINGS.latestReturnHour + 2, 6); // out all evening, back at 23:00
      const bird = hotel([guest('bird', { profile: with_({ chronotype: 'early' }), checkInDay: 2, stayLength: 3 })], { hour: 15 });
      expect(legsEnd(planOutings(bird).guests[0].trip!)).toBeCloseTo((s.day - 1) * 24 + GUEST_OUTINGS.latestReturnHour - 2, 6); // back by 19:00
    } finally { GUEST_OUTINGS.leaveChance = saved; }
  });

  it('a night owl\'s late swim that starts after midnight counts for the day it was planned, so tomorrow\'s isn\'t blocked', () => {
    let s = hotel([guest('owl', { profile: with_({ chronotype: 'night' }), checkInDay: 1, stayLength: 4 })], { hour: 23 });
    s = addFacility(s, 'gym', 2, 0, 0, 'down')!;
    const gym = s.facilities[0];
    const T = hourStart(s);
    const at = { gridX: gym.gridX, gridY: gym.gridY, floor: 0, door: gym.door };
    const trip: Leg[] = [{ kind: 'stay', at, start: T + 1.5, end: T + 2, activity: 'visit', placeId: gym.id }];
    // Planned in the 23:00 hour; the visit itself starts at 00:30 the next day
    s = { ...s, guests: [{ ...s.guests[0], trip: [{ kind: 'stay', at, start: T + 0.4, end: T + 1.5, activity: 'wait' }, ...trip], tripKind: 'visit' }] };
    expect(Math.floor((T + 1.5) / 24) + 1).toBe(s.day + 1); // (the visit itself is tomorrow's)
    const credited = creditFacilityVisits(s, T + 2.5);
    expect(credited.guests[0].facilitiesUsed?.gym?.day).toBe(s.day);
  });

  it('checkout: an early bird at their own hour; a night owl at 11:00 (refused, a little put out) or 13:00 (free, or for a fee)', () => {
    const early = guest('e', { profile: with_({ chronotype: 'early', checkoutHour: 8 }), checkInDay: 1, stayLength: 2 });
    const owl = guest('o', { profile: with_({ chronotype: 'night' }), checkInDay: 1, stayLength: 2, satisfaction: 60 });
    expect(isCheckoutDue(early, { day: 3, hour: 6 })).toBe(false);
    expect(isCheckoutDue(early, { day: 3, hour: 7 })).toBe(true); // the 07:00-08:00 hour ends at 08:00
    expect(checkoutHour(owl, {})).toBe(ECONOMY.checkOutHour);
    expect(checkoutHour(owl, { lateCheckout: 'free' })).toBe(GUEST_PROFILE.lateCheckoutHour);
    expect(checkoutHour(guest('r'), { lateCheckout: 'free' })).toBe(ECONOMY.checkOutHour); // no profile: as ever

    const at = (hour: number, lateCheckout?: HotelState['lateCheckout']) => processDepartures(hotel([owl], { hour, ...(lateCheckout ? { lateCheckout } : {}) }), new PRNG(1));
    const refused = at(10);
    expect(refused.departed).toHaveLength(1);
    expect(refused.departed[0].booking.satisfactionAtCheckout).toBe(60 - GUEST_PROFILE.lateCheckoutRefused);
    expect(at(10, 'free').departed).toHaveLength(0);
    expect(at(10, 'fee').departed).toHaveLength(0); // for a fee, they stay till 13:00 too
    expect(checkoutHour(owl, { lateCheckout: 'fee' })).toBe(GUEST_PROFILE.lateCheckoutHour);
    const free = at(12, 'free');
    expect(free.departed[0].booking.satisfactionAtCheckout).toBe(60);
    expect(free.departed[0].lateFee).toBeUndefined();
    const fee = at(12, 'fee');
    const room = hotel([owl]).rooms[0];
    expect(fee.departed[0].lateFee).toBe(Math.round(room.pricePerNight * GUEST_PROFILE.lateCheckoutFee));
    const s = hotel([owl], { hour: 12, lateCheckout: 'fee' });
    expect(processRevenue(s, fee).cashDelta - processRevenue(s, free).cashDelta).toBe(fee.departed[0].lateFee);
  });

  it('the Cleaning panel can say how many are still to check out today, and how many late', () => {
    const s = hotel([
      guest('a', { checkInDay: 1, stayLength: 2 }),
      guest('o', { profile: with_({ chronotype: 'night' }), checkInDay: 1, stayLength: 2 }),
      guest('later', { checkInDay: 2, stayLength: 3 }),
    ], { hour: 9, lateCheckout: 'free' });
    expect(checkoutsToday(s)).toEqual({ total: 2, late: 1 });
  });
});

describe('Night noise', () => {
  const awake = (x: Partial<GuestProfile> = {}) => with_({ chronotype: 'night', ...x }); // up at 23:00

  it('a guest makes noise only while they\'re in and awake: a regular asleep at 02:00 is silent, a night owl at 23:00 isn\'t', () => {
    const s = hotel([guest('me', { profile: PROFILE }), guest('n', { profile: PROFILE })], { hour: 2 });
    expect(calculateRoomNoise(s.rooms[0], s)).toBe(0);
    const owls = hotel([guest('me', { profile: PROFILE }), guest('n', { profile: awake() })], { hour: 23 });
    expect(calculateRoomNoise(owls.rooms[0], owls)).toBeCloseTo(NOISE.baseOccupiedNoise, 9);
  });

  it('rowdy guests are louder, louder still late at night; quiet ones softer', () => {
    const rowdy = guest('r', { profile: awake({ rowdiness: 'rowdy' }) });
    expect(noiseOutputMult(rowdy, 15)).toBe(GUEST_PROFILE.output.rowdy);
    expect(noiseOutputMult(rowdy, 23)).toBe(GUEST_PROFILE.output.rowdy * GUEST_PROFILE.rowdyLateMult);
    expect(noiseOutputMult(guest('q', { profile: with_({ rowdiness: 'quiet' }) }), 23)).toBe(GUEST_PROFILE.output.quiet);
    expect(occupantNoiseOutput(rowdy, 3 * 24 + 23.5)).toBeCloseTo(NOISE.baseOccupiedNoise * 2.5 * 1.5, 9);
    expect(noiseSensitivity(guest('h', { profile: with_({ sleep: 'heavy' }) }))).toBe(0.5);
    expect(noiseSensitivity(guest('l', { trait: 'light_sleeper' }))).toBe(NOISE.traitNoiseSensitivity.light_sleeper); // no profile: as ever
  });

  it('a facility is quiet when it\'s closed', () => {
    let s = hotel([guest('me', { profile: PROFILE })], { hour: 3 });
    s = { ...addFacility(s, 'restaurant', 3, 1, 0, 'up')!, noiseSources: [] }; // built (no building work going on)
    expect(calculateRoomNoise(s.rooms[0], s)).toBe(0);
    expect(calculateRoomNoise(s.rooms[0], { ...s, hour: 19 })).toBeCloseTo(FACILITY_CONFIG.restaurant.noiseOutput, 9);
  });

  it('noise is added up only while a guest is in their room in their sleep hours, night by night, and their review takes the average', () => {
    const party = guest('loud', { profile: awake({ rowdiness: 'rowdy' }), party: P('friends', 4) });
    const me = guest('me', { profile: with_({ sleep: 'light' }), checkInDay: 1, stayLength: 2 });
    let s = hotel([me, party], { day: 2, hour: 23 });
    const noise = calculateRoomNoise(s.rooms[0], s);
    expect(noise).toBeGreaterThan(NOISE.penaltyThreshold);
    s = accrueNightNoise(s);
    const excess = (noise - NOISE.penaltyThreshold) * 2;
    expect(s.guests[0].nightNoise).toMatchObject({ exposure: excess, woken: 1 });
    s = accrueNightNoise({ ...s, day: 3, hour: 0 }); // the same night: still one woken
    expect(s.guests[0].nightNoise!.woken).toBe(1);
    expect(accrueNightNoise({ ...s, day: 3, hour: 14 }).guests[0].nightNoise).toEqual(s.guests[0].nightNoise); // awake: nothing
    // Out of the room: nothing either
    const out = { ...s, guests: s.guests.map(g => (g.id === 'me' ? { ...g, tripKind: 'outing' as const, trip: [{ kind: 'stay' as const, at: { gridX: 0, gridY: 0, floor: 0 }, start: 0, end: 999, activity: 'away' as const }] } : g)) };
    expect(accrueNightNoise({ ...s, day: 3, hour: 0 }).guests[0].nightNoise!.exposure).toBeGreaterThan(s.guests[0].nightNoise!.exposure); // in: it counts
    expect(accrueNightNoise({ ...out, day: 3, hour: 0 }).guests[0].nightNoise).toEqual(s.guests[0].nightNoise); // out: it doesn't
    // Two nights' stay: the review takes the average night
    const checkout = { ...s, day: 3, hour: 10 };
    expect(reviewNoisePenalty(checkout.rooms[0], checkout, checkout.guests[0])).toBeCloseTo(s.guests[0].nightNoise!.exposure / 2 * GUEST_PROFILE.nightPenaltyPerUnit, 9);
    const b = calculateGuestReviewBreakdown(checkout.rooms[0], checkout, checkout.guests[0], new PRNG(1));
    expect(b.noisePenalty).toBeCloseTo(s.guests[0].nightNoise!.exposure / 2 * GUEST_PROFILE.nightPenaltyPerUnit, 9);
  });

  it('with profiles off, noise is what it always was: everyone in is heard, at any hour, and the review takes it at checkout', () => {
    GUEST_PROFILE.enabled = false;
    try {
      const s = hotel([guest('me'), guest('n')], { hour: 2 });
      expect(calculateRoomNoise(s.rooms[0], s)).toBeCloseTo(NOISE.baseOccupiedNoise, 9);
      expect(accrueNightNoise(s)).toBe(s);
    } finally { GUEST_PROFILE.enabled = true; }
  });
});

describe('Night noise in the day\'s order', () => {
  const loudNeighbour = () => guest('owl', { profile: with_({ chronotype: 'night', rowdiness: 'rowdy' }), party: P('friends', 4) });

  it('a guest\'s mood sours with the noise while they\'re trying to sleep, not while they\'re up', () => {
    const me = guest('me', { profile: PROFILE, satisfaction: 50 });
    // One rowdy night owl next door (loud enough to keep them up, not so loud the mood hits bottom)
    const night = hotel([me, guest('owl', { profile: with_({ chronotype: 'night', rowdiness: 'rowdy' }) })], { hour: 23 });
    const day = { ...night, hour: 14 };
    const excess = nightNoiseThisHour(night.rooms[0], night, night.guests[0]);
    expect(excess).toBeGreaterThan(0);
    expect(nightNoiseThisHour(day.rooms[0], day, day.guests[0])).toBe(0);
    let a = night;
    let b = day;
    for (let i = 0; i < 400; i++) { a = driftSatisfaction(a); b = driftSatisfaction(b); }
    const gap = b.guests[0].satisfaction - a.guests[0].satisfaction;
    expect(gap).toBeCloseTo(excess * GUEST_PROFILE.nightPenaltyPerUnit * GUEST_PROFILE.nightDriftWeight * 10, 0);
  });

  it('a tick adds the night\'s noise to a sleeping guest\'s tally before anyone checks out', () => {
    const me = guest('me', { profile: with_({ sleep: 'light' }), checkInDay: 2, stayLength: 3 });
    const s = hotel([me, loudNeighbour()], { day: 3, hour: 23 });
    const after = tickSimulation(s, new PRNG(1)).state;
    expect(after.guests.find(g => g.id === 'me')!.nightNoise!.exposure).toBeGreaterThan(0);
  });

  it('a noise complaint is filed only while the guest is trying to sleep', () => {
    const me = guest('me', { profile: PROFILE, satisfaction: 20 });
    const s = hotel([me, loudNeighbour()], { hour: 14 });
    const filed = (st: HotelState) => selectNewIncident(st, new PRNG(1)).state.activeIncidents.filter(i => i.type === 'noise_complaint');
    expect(calculateRoomNoise(s.rooms[0], s)).toBeGreaterThan(NOISE.penaltyThreshold); // just as loud by day
    expect(filed(s)).toHaveLength(0);
    expect(filed({ ...s, hour: 23 })).toHaveLength(1);
  });

  it('with profiles off, quirks are not drawn (the legend that explains them is not there)', () => {
    const light = guest('l', { trait: 'light_sleeper', party: P('solo', 1) });
    const legs: Leg[] = [{ kind: 'stay', at: { gridX: 0, gridY: 0, floor: 0 }, start: 0, end: 10, activity: 'wait' }];
    expect(partyFigures('l', P('solo', 1), legs, 1, 0, false, { quirk: quirkOf(light) })[0].quirk).toBe('moon');
    const s = hotel([{ ...light, trip: legs, tripKind: 'visit' }], { hour: 1 });
    expect(guestFigures(s, 0.5).figures[0].quirk).toBe('moon');
    GUEST_PROFILE.enabled = false;
    try {
      expect(guestFigures(s, 0.5).figures[0].quirk).toBeUndefined();
    } finally { GUEST_PROFILE.enabled = true; }
  });

  it('a noise complaint waits while the guest is up, and is judged again when they\'re trying to sleep', () => {
    const me = guest('me', { profile: PROFILE, satisfaction: 20 });
    let s = hotel([me, loudNeighbour()], { hour: 14 });
    const incident = { id: 'nc', type: 'noise_complaint' as const, guestId: 'me', roomId: s.rooms[0].id, stage: 'active' as const, hoursRemaining: 1, chainId: 'nc', culpritGuestId: 'owl' };
    s = { ...s, activeIncidents: [incident] };
    // Daytime: neither resolved nor escalated (the noise by day is no part of it)
    const day = advanceIncidents(s, new PRNG(1));
    expect(day.state.activeIncidents).toEqual([incident]);
    expect(day.earlyDepartureGuestIds.size).toBe(0);
    // At night, still noisy and out of time: they leave
    const night = advanceIncidents({ ...s, hour: 23 }, new PRNG(1));
    expect(night.earlyDepartureGuestIds.has('me')).toBe(true);
  });

  it('with profiles off, a second bad review the same day still spreads (as it always did)', () => {
    const bad: DepartedGuestReview = {
      guestName: 'Sam', roomId: 'r1',
      booking: { id: 'b1', roomId: 'r1', guestId: 'g1', nightRate: 80, reviewScore: 1, satisfactionAtCheckout: 10 },
      breakdown: { noisePenalty: 3, decorPenalty: 0, elevatorPenalty: 0, conditionBonus: 0, cleanlinessBonus: 0, amenityPenalty: 0, priceFairness: 1, guestVariance: 0, facilityBonus: 0, amenityBonus: 0, roomFit: 0, finalScore: 1 },
    };
    GUEST_PROFILE.enabled = false;
    try {
      const s = { ...hotel([]), day: 5, hour: 3 };
      const first = checkReviewSemiViral(s, [bad], new PRNG(1)).state;
      expect(checkReviewSemiViral({ ...first, hour: 10 }, [bad], new PRNG(2)).state.activeReputationPenalties).toHaveLength(2);
    } finally { GUEST_PROFILE.enabled = true; }
    void STORY;
  });
});

describe('Walking pace', () => {
  it('each guest walks at their own pace, the whole party with them, and a slow walker minds the lift', () => {
    const slow = guest('slow', { profile: with_({ mobility: 'limited' }), party: P('family', 3) });
    const s = hotel([slow], { hour: 11 });
    const walker = departureWalker(s, slow, hourStart(s), 'checked_out')!;
    const walk = walker.trip[0] as Extract<Leg, { kind: 'walk' }>;
    expect(walk.hoursPerTile).toBe(GUEST_PROFILE.pace.limited);
    expect(walker.profile).toEqual(slow.profile);
    expect(walker.guestId).toBe('slow');
    const mid = (walk.start + walk.end) / 2;
    expect(Math.hypot(memberPositionAt([walk], mid, 1)!.x - memberPositionAt([walk], mid, 0)!.x, memberPositionAt([walk], mid, 1)!.y - memberPositionAt([walk], mid, 0)!.y)).toBeCloseTo(PARTY_SPACING, 6);
    expect(guestPace({})).toBe(TRAVEL.guestHoursPerTile);
    expect(GUEST_PROFILE.pace.normal).toBe(TRAVEL.guestHoursPerTile);
    // The lift
    const up = { ...s.rooms[0], floor: 1 };
    const busy = { ...s, elevators: [], rooms: [up, ...Array.from({ length: 40 }, (_, i) => ({ ...up, id: `x${i}`, status: 'occupied' as const }))] };
    const base = getElevatorWaitPenalty(busy, up);
    if (base > 0) expect(getElevatorWaitPenalty(busy, up, slow)).toBeCloseTo(base * GUEST_PROFILE.limitedLiftMult, 9);
  });

  it('check-ins are spaced the same whoever walks in, so a slow walker never holds up the next hour\'s first', () => {
    const s = { ...hotel([]), day: 4, hour: 15, staff: { ...createStarterHotel().staff, frontDesk: 1 } };
    let st = s;
    for (let x = 0; x < 4; x++) st = addRoom(st, 'standard', x + 3, 2, 0, 'up')!;
    const T = hourStart(st);
    const mk = (id: string, mobility: GuestProfile['mobility']) => guest(id, { profile: with_({ mobility }) });
    const first = planArrivalTrips(st, [{ guest: mk('slow', 'limited'), roomId: st.rooms[0].id }, { guest: mk('a', 'normal'), roomId: st.rooms[1].id }, { guest: mk('b', 'normal'), roomId: st.rooms[2].id }], [], T);
    const next = planArrivalTrips({ ...st, hour: 16 }, [{ guest: mk('fast', 'brisk'), roomId: st.rooms[3].id }], [], T + 1);
    const checkIns = (trips: Map<string, Leg[]>) => [...trips.values()].flatMap(l => l.filter(x => x.kind === 'stay' && x.activity === 'check_in'));
    const lastEnd = Math.max(...checkIns(first.trips).map(l => l.end));
    const nextStart = Math.min(...checkIns(next.trips).map(l => l.start));
    expect(nextStart).toBeGreaterThanOrEqual(lastEnd - 1e-9);
  });

  it('a housekeeper doesn\'t start turning a room over until the slow walker leaving it has stepped out', () => {
    const slow = guest('slow', { profile: with_({ mobility: 'limited' }) });
    const atRoom = (s: HotelState): HotelState => {
      const room = s.rooms[0];
      // The housekeeper was finishing the daily clean in there: right at the door
      return { ...s, staffRoster: [{ id: 'housekeeper-0', role: 'housekeeper', at: { gridX: room.gridX, gridY: room.gridY, floor: room.floor, door: room.door } }] };
    };
    let s = atRoom(hotel([slow], { hour: 11, staff: { ...createStarterHotel().staff, housekeepers: 1 } }));
    const room = s.rooms[0];
    const walker = departureWalker(s, slow, hourStart(s), 'checked_out')!;
    s = { ...s, guests: [], walkers: [walker], rooms: [{ ...room, status: 'cleaning' as const, guestId: undefined, cleaningHoursRemaining: 2, cleaningHoursTotal: 2 }] };
    const walk = walker.trip[0] as Extract<Leg, { kind: 'walk' }>;
    const legs = getStaffPlan(s).itineraries.flatMap(it => it.legs);
    const clean = legs.find(l => l.kind === 'stay' && l.job === 'turnover');
    expect(legs[0]).toMatchObject({ kind: 'stay', activity: 'wait' });
    expect(clean!.start).toBeCloseTo(walk.start + GUEST_PROFILE.pace.limited, 9);
    // Nobody leaving: straight to work
    const empty = { ...s, walkers: [] };
    expect(getStaffPlan(empty).itineraries.flatMap(it => it.legs).find(l => l.kind === 'stay' && l.job === 'turnover')!.start).toBeCloseTo(hourStart(s), 9);
  });
});

describe('Checkouts at several hours', () => {
  it('a bad review goes viral once a day at most, however many checkout hours there are', () => {
    const bad: DepartedGuestReview = {
      guestName: 'Sam', roomId: 'r1',
      booking: { id: 'b1', roomId: 'r1', guestId: 'g1', nightRate: 80, reviewScore: 1, satisfactionAtCheckout: 10 },
      breakdown: { noisePenalty: 3, decorPenalty: 0, elevatorPenalty: 0, conditionBonus: 0, cleanlinessBonus: 0, amenityPenalty: 0, priceFairness: 1, guestVariance: 0, facilityBonus: 0, amenityBonus: 0, roomFit: 0, finalScore: 1 },
    };
    const s = { ...hotel([]), day: 5, hour: 7 };
    const early = checkReviewSemiViral(s, [bad], new PRNG(1)).state; // the early birds' checkouts
    expect(early.activeReputationPenalties).toHaveLength(1);
    const later = checkReviewSemiViral({ ...early, hour: 10 }, [{ ...bad, guestName: 'Lee' }], new PRNG(2)).state; // the 11:00 checkouts
    expect(later.activeReputationPenalties).toHaveLength(1);
    expect(checkReviewSemiViral({ ...later, day: 6 }, [bad], new PRNG(3)).state.activeReputationPenalties).toHaveLength(2); // tomorrow's is tomorrow's
  });
});

describe('Facility visits by chronotype', () => {
  it('an early bird is at the gym at 05:00, while regulars are asleep', () => {
    const saved = FACILITY_CONFIG.gym.visitChance;
    FACILITY_CONFIG.gym.visitChance = [[6, 9, 1]];
    try {
      let s = hotel([guest('early', { profile: with_({ chronotype: 'early' }), checkInDay: 2, stayLength: 3 }), guest('reg', { profile: PROFILE, checkInDay: 2, stayLength: 3 })], { hour: 5 });
      s = addFacility(s, 'gym', 2, 0, 0, 'down')!;
      const planned = planFacilityVisits(s);
      expect(planned.guests.find(g => g.id === 'early')!.trip).toBeTruthy();
      expect(planned.guests.find(g => g.id === 'reg')!.trip ?? null).toBeNull();
    } finally { FACILITY_CONFIG.gym.visitChance = saved; }
  });
});

void makeWalk;
