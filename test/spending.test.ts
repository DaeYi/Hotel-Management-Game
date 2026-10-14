import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, addFacility } from '../src/simulation/HotelState.js';
import { rollProfile, quirkOf, guestTags } from '../src/simulation/Profile.js';
import { rollSpending, spendingOf, saleFor, spentHere } from '../src/simulation/Spending.js';
import { matchGuestToRoom, processArrivals, calculateGuestReviewBreakdown } from '../src/simulation/GuestManager.js';
import { creditFacilityVisits, planFacilityVisits } from '../src/simulation/FacilityManager.js';
import { planDinnersOut, creditDinnersOut } from '../src/simulation/OutingManager.js';
import { recordBigTabs, attributeReviewCause, type DepartedGuestReview } from '../src/simulation/StoryGenerator.js';
import { recordDailyStat } from '../src/simulation/ObjectivesManager.js';
import { getPartyFairPrice } from '../src/simulation/StarRatingManager.js';
import { makeStay, hourStart, legsEnd, hash01 } from '../src/simulation/Movement.js';
import { PRNG } from '../src/simulation/prng.js';
import { hostingDay, hostsTonight } from '../src/simulation/Visitors.js';
import { profileRoom } from '../src/simulation/RoomProfile.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { SPENDING, FACILITY_CONFIG, FACILITY_LEVELS, MOOD, PATIENCE, ECONOMY, GUEST_FAVORITES, GUEST_PURPOSES, HOSTED_NIGHTS } from '../src/config/balance.js';
import { perPersonFactor } from '../src/simulation/Party.js';
import type { Booking, Facility, Guest, GuestProfile, HotelState, Party, Room, SpendingStyle } from '../src/simulation/types.js';
import type { GuestReviewBreakdown } from '../src/simulation/GuestManager.js';

const PROFILE: GuestProfile = { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, favorite: 'none' };
const styled = (spending: SpendingStyle, extra: Partial<GuestProfile> = {}): GuestProfile => ({ ...PROFILE, spending, ...extra });
const COUPLE: Party = { kind: 'couple', size: 2 };

function guest(id: string, extra: Partial<Guest> = {}): Guest {
  return { id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false, profile: PROFILE, ...extra };
}

/** The starter hotel at 3 stars with standard rooms on row 2 (doors up), each with one of these guests in it. */
function hotel(guests: Guest[], extra: Partial<HotelState> = {}): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
  for (let x = 0; x < guests.length; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
  return {
    ...s, day: 3, hour: 9, noiseSources: [], guests,
    rooms: s.rooms.map((r, i) => ({ ...r, status: 'occupied' as const, guestId: guests[i].id })),
    ...extra,
  };
}

function withSwitch<T>(sw: { enabled: boolean }, on: boolean, fn: () => T): T {
  const was = sw.enabled;
  sw.enabled = on;
  try { return fn(); } finally { sw.enabled = was; }
}

/** With lots of guests turning up (the market multiplied), restoring it after. */
function busy<T>(fn: () => T, arrivalsPerDay = 80): T {
  const was = ECONOMY.baseArrivalsPerDay;
  ECONOMY.baseArrivalsPerDay = arrivalsPerDay;
  try { return fn(); } finally { ECONOMY.baseArrivalsPerDay = was; }
}

describe('Spending style: who spends how', () => {
  it('big spenders splurge; of the rest, 3 in 8 are thrifty (30% of everyone); kept with the profile; with the switch off, nothing', () => {
    let thrifty = 0;
    for (let i = 0; i < 8000; i++) {
      const s = rollSpending(`g${i}`, 'normal');
      expect(s).not.toBe('splurger');
      if (s === 'thrifty') thrifty++;
    }
    expect(Math.abs(thrifty / 8000 - 0.375)).toBeLessThan(0.02);
    expect(rollSpending('g1', 'big_spender')).toBe('splurger');
    expect(rollProfile('g1', { kind: 'solo', size: 1 }, 'sightseeing', 'big_spender')!.spending).toBe('splurger');
    withSwitch(SPENDING, false, () => expect(rollProfile('g1', { kind: 'solo', size: 1 }, 'sightseeing', 'big_spender')!.spending).toBeUndefined());
    // Without a roll (an older save), the trait says
    expect(spendingOf({ trait: 'big_spender', profile: PROFILE })).toBe('splurger');
    expect(spendingOf({ trait: 'normal', profile: PROFILE })).toBe('standard');
    withSwitch(SPENDING, false, () => expect(spendingOf({ trait: 'big_spender', profile: styled('splurger') })).toBe('standard'));
  });

  it('a "$" over a big spender, unless they’re a light sleeper or rowdy (never at once: one trait roll); tagged on the room card', () => {
    expect(quirkOf({ trait: 'big_spender', profile: styled('splurger') })).toBe('coin');
    expect(quirkOf({ trait: 'normal', profile: styled('thrifty') })).toBeNull();
    expect(quirkOf({ trait: 'normal', profile: styled('splurger', { sleep: 'light' }) })).toBe('moon');
    expect(guestTags({ trait: 'big_spender', profile: styled('splurger') })).toEqual(['big spender']);
    expect(guestTags({ trait: 'normal', profile: styled('thrifty') })).toEqual(['thrifty']);
    withSwitch(SPENDING, false, () => {
      expect(quirkOf({ trait: 'big_spender', profile: styled('splurger') })).toBeNull();
      expect(guestTags({ trait: 'normal', profile: styled('thrifty') })).toEqual([]);
    });
  });

  it('no new random draws: the same stream with spending styles on or off (at the desk queue, and at the old desk with room to spare)', () => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
    for (let x = 0; x < 6; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
    s = { ...s, day: 6, hour: 15, staff: { ...s.staff, frontDesk: 6 } };
    const next = (on: boolean) => withSwitch(SPENDING, on, () => { const p = new PRNG(11); busy(() => processArrivals(s, 15, p)); return p.next(); });
    expect(next(true)).toBe(next(false));
    withSwitch(PATIENCE, false, () => expect(next(true)).toBe(next(false)));
  });

  it('what they have to spend: a thrifty guest 0.7x the draw, everyone else as ever (the same guests come)', () => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
    for (let x = 0; x < 6; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
    s = { ...s, day: 6, hour: 15, staff: { ...s.staff, frontDesk: 6 } };
    const everyone = (on: boolean) => withSwitch(SPENDING, on, () => {
      const r = busy(() => processArrivals(s, 15, new PRNG(5)));
      return new Map([...r.checkedIn.map(c => c.guest), ...r.walkIns.map(w => w.guest)].map(g => [g.id, g]));
    });
    const on = everyone(true);
    const off = everyone(false);
    expect([...on.keys()].sort()).toEqual([...off.keys()].sort());
    let thrifty = 0;
    for (const [id, g] of on) {
      const was = off.get(id)!.budget;
      if (g.profile!.spending === 'thrifty') { thrifty++; expect(g.budget).toBeCloseTo(was * SPENDING.budgetMult.thrifty, 9); } else expect(g.budget).toBe(was);
    }
    expect(thrifty).toBeGreaterThan(0);
  });
});

describe('How far over a fair price they’ll go', () => {
  it('a thrifty guest never past 1.4x fair, anyone else to 1.8x, a big spender to 2.2x: at the desk queue and at the old desk', () => {
    const styles = (ratio: number, queue: boolean) => withSwitch(PATIENCE, queue, () => {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
      for (let x = 0; x < 6; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
      s = { ...s, day: 6, hour: 15, staff: { ...s.staff, frontDesk: 6 } };
      s = { ...s, rooms: s.rooms.map(r => ({ ...r, pricePerNight: getPartyFairPrice(r, COUPLE, s.starRating) * ratio })) };
      const who: string[] = [];
      for (let seed = 1; seed <= 40; seed++) who.push(...busy(() => processArrivals(s, 15, new PRNG(seed))).checkedIn.map(c => c.guest.profile!.spending!));
      return who;
    });
    for (const queue of [true, false]) {
      const dear = styles(1.5, queue);
      expect(dear).toContain('standard');
      expect(dear).not.toContain('thrifty');
      const dearer = styles(2, queue);
      expect(dearer.length).toBeGreaterThan(0);
      expect(dearer.every(s => s === 'splurger')).toBe(true);
    }
  });
});

describe('A big spender’s room', () => {
  // At 3 stars: a double, a deluxe double, a suite and a deluxe family room
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, starRating: 3 };
  s = addRoom(s, 'standard', 3, 2, 0, 'up')!;
  s = addRoom(s, 'deluxe', 4, 2, 0, 'up')!;
  s = addRoom(s, 'suite', 5, 2, 0, 'up')!;
  s = addRoom(s, 'deluxe_family', 6, 2, 0, 'up')!;
  const [std, dlx, suite, fam] = s.rooms;
  const price = (r: Room, p: number) => ({ ...r, pricePerNight: p });
  const rooms = [price(std, 100), price(dlx, 150), price(fam, 160), price(suite, 210)]; // cheapest first, as getAvailableRooms gives them
  const couple = (spending: SpendingStyle) => guest('c', { party: COUPLE, profile: styled(spending), trait: spending === 'splurger' ? 'big_spender' : 'normal' });
  const pick = (g: Guest, tolerance: number, list = rooms) => matchGuestToRoom(g, list, tolerance, 3)?.id;

  it('everyone else takes the cheapest room they’ll pay for, as ever', () => {
    expect(pick(couple('standard'), 2.2)).toBe(std.id);
    expect(pick(couple('thrifty'), 2.2)).toBe(std.id);
    withSwitch(SPENDING, false, () => expect(pick(couple('splurger'), 2.2)).toBe(std.id));
  });

  it('a big spender takes the best that suits them, at no more than their tolerance over the cheapest that would do', () => {
    expect(getPartyFairPrice(suite, COUPLE, 3) * 2.2).toBeGreaterThan(210); // (all of them fair enough at this tolerance)
    expect(pick(couple('splurger'), 2.2)).toBe(suite.id); // 100 x 2.2 = 220: the suite
    expect(pick(couple('splurger'), 1.6)).toBe(dlx.id); // 160: the deluxe double (not the family room)
    expect(pick(couple('splurger'), 1.4)).toBe(std.id); // 140: nothing better
    // No beds they'd pay for and not use: the double before a deluxe family room
    expect(pick(couple('splurger'), 2.2, [price(std, 100), price(fam, 120)])).toBe(std.id);
    // Then the highest floor, then the cheaper
    const up = { ...price(dlx, 150), id: 'up', floor: 1 };
    expect(pick(couple('splurger'), 2.2, [price(std, 100), price(dlx, 150), up])).toBe('up');
    expect(pick(couple('splurger'), 2.2, [price(std, 100), price(dlx, 150), { ...price(dlx, 140), id: 'cheaper' }])).toBe('cheaper');
    // Nothing they'd pay for: nothing
    expect(pick({ ...couple('splurger'), budget: 50 }, 2.2)).toBeUndefined();
  });

  it('a couple never counts twin beds as suiting them, not even a twin junior suite (friends do)', () => {
    const f = suite.furnishing!;
    const twinSuite = { ...price(suite, 200), id: 'twin-suite', furnishing: { ...f, custom: true, items: f.items.map(i => (i.kind === 'bed_king' ? { ...i, kind: 'bunk' as const } : i)) } };
    expect(profileRoom(twinSuite)).toMatchObject({ type: 'suite', layoutClass: 'twin' });
    expect(pick(couple('splurger'), 2.2, [price(std, 100), price(dlx, 150), twinSuite])).toBe(dlx.id);
    const friends = guest('f', { party: { kind: 'friends', size: 2 }, profile: styled('splurger'), trait: 'big_spender' });
    expect(pick(friends, 2.2, [price(std, 100), price(dlx, 150), twinSuite])).toBe('twin-suite');
  });
});

describe('Money spent on site', () => {
  /** A hotel with a shop and a restaurant, and these guests each just back from one (a visit to credit at T). */
  function visited(...visits: Array<{ g: Guest; at: 'shop' | 'restaurant' }>) {
    let s = hotel(visits.map(v => v.g), { hour: 14 });
    s = { ...addFacility(addFacility(s, 'shop', 2, 0, 0, 'down')!, 'restaurant', 4, 0, 0, 'down')!, noiseSources: [] };
    const T = hourStart(s);
    const place = (type: string) => s.facilities.find(f => f.type === type)!;
    const tile = (f: Facility) => ({ gridX: f.gridX, gridY: f.gridY, floor: f.floor, door: f.door });
    s = { ...s, guests: s.guests.map((g, i) => ({ ...g, tripKind: 'visit' as const, trip: [makeStay(tile(place(visits[i].at)), T - 0.6, T - 0.2, 'visit', { placeId: place(visits[i].at).id })] })) };
    return { s, T };
  }

  it('a cover at the restaurant, the shop as before; a big spender twice as much (three times delighted at the shop); a thrifty guest nothing', () => {
    const { s, T } = visited(
      { g: guest('a', { profile: styled('standard') }), at: 'restaurant' },
      { g: guest('b', { profile: styled('splurger'), trait: 'big_spender', party: { kind: 'family', size: 4 } }), at: 'restaurant' },
      { g: guest('c', { profile: styled('splurger'), trait: 'big_spender', satisfaction: 95 }), at: 'shop' },
      { g: guest('d', { profile: styled('thrifty') }), at: 'shop' },
    );
    const r = creditFacilityVisits(s, T);
    const spent = (id: string) => r.guests.find(g => g.id === id)!.spent;
    expect(spent('a')).toEqual({ shop: 0, restaurant: SPENDING.restaurantPerCover });
    expect(perPersonFactor(4)).toBeGreaterThan(1);
    expect(spent('b')!.restaurant).toBe(Math.round(SPENDING.restaurantPerCover * perPersonFactor(4) * 2));
    expect(spent('c')!.shop).toBe(Math.round(FACILITY_CONFIG.shop.spendPerVisit * MOOD.delightedShopMult * 2));
    expect(spent('d')).toBeUndefined();
    const total = spentHere(r.guests.find(g => g.id === 'a')!) + spentHere(r.guests.find(g => g.id === 'b')!) + spentHere(r.guests.find(g => g.id === 'c')!);
    expect(r.cash - s.cash).toBe(total);
    expect(r.totalRevenue - s.totalRevenue).toBe(total); // takings are revenue, as room bills are
    expect(r.onSite).toEqual({ shop: spent('c')!.shop, restaurant: spent('a')!.restaurant + spent('b')!.restaurant, splurgers: spent('b')!.restaurant + spent('c')!.shop });
    expect(saleFor('restaurant', 2, 1, 'standard')).toBe(Math.round(SPENDING.restaurantPerCover * FACILITY_LEVELS[1].revenueMult));
    // Credited once
    expect(creditFacilityVisits(r, T + 1)).toBe(r);
  });

  it('with the switch off: the restaurant earns nothing and the shop as ever, and nothing is kept', () => {
    withSwitch(SPENDING, false, () => {
      const { s, T } = visited({ g: guest('a'), at: 'restaurant' }, { g: guest('b'), at: 'shop' });
      const r = creditFacilityVisits(s, T);
      expect(r.cash - s.cash).toBeCloseTo(FACILITY_CONFIG.shop.spendPerVisit, 9);
      expect(r.totalRevenue).toBe(s.totalRevenue);
      expect(r.onSite).toBeUndefined();
      expect(r.guests.every(g => g.spent === undefined)).toBe(true);
    });
  });

  it('the day’s takings are kept with the day’s stats (for the Finance panel)', () => {
    const { s, T } = visited({ g: guest('a', { profile: styled('standard') }), at: 'restaurant' });
    const r = recordDailyStat(creditFacilityVisits(s, T));
    expect(r.dailyStats[r.dailyStats.length - 1].onSite).toEqual({ shop: 0, restaurant: SPENDING.restaurantPerCover, splurgers: 0 });
    withSwitch(SPENDING, false, () => expect(recordDailyStat(s).dailyStats[0].onSite).toBeUndefined());
  });

  it('a thrifty guest set on the shop or restaurant this hour stays in (not the gym instead); set on the gym, they go', () => {
    const types = ['shop', 'restaurant', 'gym'] as const;
    const original = types.map(t => FACILITY_CONFIG[t].visitChance);
    for (const t of types) FACILITY_CONFIG[t].visitChance = [[0, 24, 1]];
    try {
      const build = (g: Guest) => {
        const s = hotel([g], { hour: 13 });
        return { ...addFacility(addFacility(addFacility(s, 'shop', 2, 0, 0, 'down')!, 'restaurant', 4, 0, 0, 'down')!, 'gym', 6, 0, 0, 'down')!, noiseSources: [] };
      };
      const went = (g: Guest) => {
        const planned = planFacilityVisits(build(g));
        const stay = planned.guests[0].trip?.find(l => l.kind === 'stay' && l.activity === 'visit') as { placeId?: string } | undefined;
        return stay ? planned.facilities.find(f => f.id === stay.placeId)!.type : null;
      };
      // What anyone with these rolls would pick this hour
      const find = (want: (t: string | null) => boolean) => { for (let i = 0; i < 500; i++) if (want(went(guest(`th${i}`, { profile: styled('standard') })))) return `th${i}`; return ''; };
      const shopper = find(t => t === 'shop' || t === 'restaurant');
      const gymgoer = find(t => t === 'gym');
      expect([shopper, gymgoer].every(Boolean)).toBe(true);
      expect(went(guest(shopper, { profile: styled('thrifty') }))).toBeNull(); // stays in
      expect(went(guest(gymgoer, { profile: styled('thrifty') }))).toBe('gym');
    } finally {
      types.forEach((t, i) => { FACILITY_CONFIG[t].visitChance = original[i]; });
    }
  });

  it('a thrifty guest never goes to the shop or the restaurant, whoever else does', () => {
    const original = { shop: FACILITY_CONFIG.shop.visitChance, restaurant: FACILITY_CONFIG.restaurant.visitChance };
    FACILITY_CONFIG.shop.visitChance = [[0, 24, 1]];
    FACILITY_CONFIG.restaurant.visitChance = [[0, 24, 1]];
    try {
      let s = hotel([guest('t', { profile: styled('thrifty') }), guest('n', { profile: styled('standard') })], { hour: 13 });
      s = { ...addFacility(addFacility(s, 'shop', 2, 0, 0, 'down')!, 'restaurant', 4, 0, 0, 'down')!, noiseSources: [] };
      const planned = planFacilityVisits(s);
      const where = (id: string) => planned.guests.find(g => g.id === id)!.trip?.find(l => l.kind === 'stay' && l.activity === 'visit');
      expect(where('n')).toBeDefined();
      const t = where('t') as { placeId?: string } | undefined;
      expect(t === undefined || !['shop', 'restaurant'].includes(planned.facilities.find(f => f.id === t.placeId)!.type)).toBe(true);
    } finally {
      FACILITY_CONFIG.shop.visitChance = original.shop;
      FACILITY_CONFIG.restaurant.visitChance = original.restaurant;
    }
  });
});

describe('Thrifty guests eat in town', () => {
  function withChance<T>(fn: () => T): T {
    const was = SPENDING.dinnerOut.chance;
    SPENDING.dinnerOut.chance = 1;
    try { return fn(); } finally { SPENDING.dinnerOut.chance = was; }
  }
  const at = (g: Guest, hour: number, extra: Partial<HotelState> = {}) => withChance(() => planDinnersOut(hotel([g], { hour, ...extra })).guests[0]);

  it('in their evening: out to the street, an hour or two in town, back in their room by 22:00; once a day', () => {
    const g = at(guest('t', { profile: styled('thrifty') }), 18);
    expect(g.tripKind).toBe('outing');
    expect(g.trip!.map(l => (l.kind === 'walk' ? 'walk' : l.activity))).toEqual(['walk', 'away', 'walk']);
    const away = g.trip![1] as { out?: string; start: number; end: number };
    expect(away.out).toBe('dinner');
    expect(away.end - away.start).toBeGreaterThanOrEqual(SPENDING.dinnerOut.minOutside);
    expect(legsEnd(g.trip!)).toBeLessThanOrEqual(2 * 24 + 22 + 1e-9);
    expect(g.dinnersOut).toEqual({ day: 3, count: 0 }); // (counted once they're out)
    const out = creditDinnersOut(hotel([g], { hour: 19 }), away.start + 0.1).guests[0];
    expect(out.dinnersOut).toEqual({ day: 3, count: 1 });
    expect(creditDinnersOut(hotel([out], { hour: 19 }), away.start + 1).guests[0].dinnersOut!.count).toBe(1); // once
    expect(creditDinnersOut(hotel([g], { hour: 19 }), away.start - 0.1).guests[0].dinnersOut!.count).toBe(0); // not out yet
    // Once a day
    expect(at({ ...g, trip: null, tripKind: undefined }, 19).trip).toBeNull();
  });

  it('an early bird goes two hours earlier, a night owl two later; nobody else, nor on their last day, nor with the switch off', () => {
    const t = (extra: Partial<GuestProfile>) => guest('t', { profile: styled('thrifty', extra) });
    expect(at(t({ chronotype: 'early' }), 16).tripKind).toBe('outing');
    expect(at(t({}), 16).tripKind).toBeUndefined();
    expect(at(t({ chronotype: 'night' }), 20).tripKind).toBe('outing');
    expect(at(t({}), 20).tripKind).toBeUndefined();
    expect(at(guest('n', { profile: styled('standard') }), 18).tripKind).toBeUndefined();
    expect(at(guest('t', { profile: styled('thrifty'), checkInDay: 1, stayLength: 2 }), 18).tripKind).toBeUndefined(); // checks out today
    withSwitch(SPENDING, false, () => expect(at(t({}), 18).tripKind).toBeUndefined());
  });

  it('not on the night their friends come round (an early bird’s in bed by then; with hosted nights off nobody comes)', () => {
    let id = '';
    for (let i = 0; i < 500 && !id; i++) if (hostingDay(guest(`h${i}`, { profile: styled('thrifty', { rowdiness: 'rowdy' }) })) === 3) id = `h${i}`;
    expect(id).not.toBe('');
    const host = (extra: Partial<GuestProfile> = {}) => guest(id, { profile: styled('thrifty', { rowdiness: 'rowdy', ...extra }) });
    expect(hostsTonight(host(), 3)).toBe(true);
    expect(at(host(), 18).tripKind).toBeUndefined();
    expect(hostsTonight(host({ chronotype: 'early' }), 3)).toBe(false);
    expect(at(host({ chronotype: 'early' }), 16).tripKind).toBe('outing');
    withSwitch(HOSTED_NIGHTS, false, () => {
      expect(hostsTonight(host(), 3)).toBe(false);
      expect(at(host(), 18).tripKind).toBe('outing');
    });
  });

  it('in the tick: a dinner is counted once they’re out', () => {
    const planned = withChance(() => planDinnersOut(hotel([guest('t', { profile: styled('thrifty') })], { hour: 18 })));
    expect(planned.guests[0].dinnersOut).toEqual({ day: 3, count: 0 });
    expect(tickSimulation(planned, new PRNG(1)).state.guests[0].dinnersOut).toEqual({ day: 3, count: 1 });
  });

  it('a business traveller is likelier to go out to eat (their purpose, as at the restaurant)', () => {
    let id = '';
    for (let i = 0; i < 2000 && !id; i++) {
      const u = hash01(`d${i}|3|18|dinner`);
      if (u >= SPENDING.dinnerOut.chance && u < SPENDING.dinnerOut.chance * GUEST_PURPOSES.facility.business.restaurant) id = `d${i}`;
    }
    expect(id).not.toBe('');
    const go = (purpose?: 'business') => planDinnersOut(hotel([guest(id, { profile: styled('thrifty'), ...(purpose ? { purpose } : {}) })], { hour: 18 })).guests[0].tripKind;
    expect(go('business')).toBe('outing');
    expect(go()).toBeUndefined();
  });
});

describe('Reviews by how they spend', () => {
  const room = (s: HotelState, extra: Partial<Room> = {}) => ({ ...s.rooms[0], condition: 80, cleanliness: 90, ...extra });
  const review = (spending: SpendingStyle, priceRatio: number, extra: Partial<Room> = {}, state: Partial<HotelState> = {}) => {
    const s = hotel([guest('a')], state);
    const g = guest('a', { profile: styled(spending), trait: spending === 'splurger' ? 'big_spender' : 'normal' });
    const r = room(s, extra);
    const fair = getPartyFairPrice(r, { kind: 'solo', size: 1 }, s.starRating);
    return calculateGuestReviewBreakdown({ ...r, pricePerNight: fair * priceRatio }, { ...s, ...state }, g, new PRNG(3));
  };

  it('a thrifty guest minds being overcharged half as much again; priced under fair, as anyone', () => {
    const over = (s: SpendingStyle) => review(s, 1.2);
    expect(over('standard').priceFairness).toBeCloseTo(0.8, 9);
    expect(over('thrifty').priceFairness).toBeCloseTo(1 - 0.2 * SPENDING.review.overcharge.thrifty, 9); // as they felt it
    expect(over('standard').finalScore - over('thrifty').finalScore).toBeCloseTo(0.2 * (SPENDING.review.overcharge.thrifty - 1) * 2, 9);
    expect(review('thrifty', 0.8).finalScore).toBe(review('standard', 0.8).finalScore);
    // So the story names what they felt
    const b = (pf: number): GuestReviewBreakdown => ({ ...over('standard'), noisePenalty: 0.65, priceFairness: pf });
    expect(attributeReviewCause(b(over('standard').priceFairness))).toBe('noise');
    expect(attributeReviewCause(b(over('thrifty').priceFairness - 0.05))).toBe('pricing');
  });

  it('the amenities count less for a thrifty guest and more for a big spender; tired decor more for a big spender', () => {
    const lux = { amenities: { ...hotel([]).amenities, standard: 'premium' as const } };
    const amenity = (s: SpendingStyle) => review(s, 1, {}, lux).amenityBonus;
    expect(amenity('standard')).toBeGreaterThan(0);
    expect(amenity('thrifty')).toBeCloseTo(amenity('standard') * SPENDING.review.amenityBonus.thrifty, 9);
    expect(amenity('splurger')).toBeCloseTo(amenity('standard') * SPENDING.review.amenityBonus.splurger, 9);
    const decor = (s: SpendingStyle) => review(s, 1, { decor: 10 }).decorPenalty;
    expect(decor('standard')).toBeGreaterThan(0);
    expect(decor('splurger')).toBeCloseTo(decor('standard') * SPENDING.review.decorPenalty.splurger, 9);
    expect(decor('thrifty')).toBe(decor('standard'));
    withSwitch(SPENDING, false, () => expect(review('splurger', 1, { decor: 10 }).decorPenalty).toBe(review('standard', 1, { decor: 10 }).decorPenalty));
  });

  it('a 4-star hotel with basic amenities: the penalty minds less for a thrifty guest, more for a big spender; overpriced, a big spender minds as anyone', () => {
    const four = { starRating: 4, amenities: { ...hotel([]).amenities, standard: 'basic' as const } };
    const penalty = (s: SpendingStyle) => review(s, 1, {}, four).amenityPenalty;
    expect(penalty('standard')).toBeGreaterThan(0);
    expect(penalty('thrifty')).toBeCloseTo(penalty('standard') * SPENDING.review.amenityPenalty.thrifty, 9);
    expect(penalty('splurger')).toBeCloseTo(penalty('standard') * SPENDING.review.amenityPenalty.splurger, 9);
    expect(review('splurger', 1.2).priceFairness).toBe(review('standard', 1.2).priceFairness);
  });
});

describe('A big tab', () => {
  const departure = (name: string, tab?: number): DepartedGuestReview => ({
    guestName: name, roomId: 'r', ...(tab ? { tab } : {}),
    booking: { id: name, roomId: 'r', guestId: name, nightRate: 100, reviewScore: 8, satisfactionAtCheckout: 60 } as Booking,
    breakdown: {} as GuestReviewBreakdown,
  });
  const withRestaurant = (level: number) => {
    const s = { ...addFacility(hotel([], { storyLog: [] }), 'restaurant', 4, 0, 0, 'down')!, noiseSources: [] };
    return { ...s, facilities: s.facilities.map(f => ({ ...f, level })) };
  };

  it('a big restaurant tab at checkout makes a story (the biggest that hour; big for the restaurant); the day’s first only, not an incident', () => {
    const s = withRestaurant(1);
    const r = recordBigTabs(s, [departure('Malik', 210), departure('Ann', 120), departure('Bo')]);
    expect(r.storyLog.map(e => e.message)).toEqual(['Malik ran up a $210 restaurant tab.']);
    expect(r.storyLog[0].id).not.toBe(r.storyLog[0].chainId); // a line, not a new story
    expect(recordBigTabs(r, [departure('Cy', 400)])).toBe(r); // once a day
    expect(recordBigTabs(s, [departure('Ann', 99)])).toBe(s); // not big
    const finer = withRestaurant(2); // a finer restaurant: a bigger tab
    expect(recordBigTabs(finer, [departure('Ann', 120)])).toBe(finer);
    expect(recordBigTabs(finer, [departure('Ann', SPENDING.bigTab * FACILITY_LEVELS[1].revenueMult)]).storyLog).toHaveLength(1);
    withSwitch(SPENDING, false, () => expect(recordBigTabs(s, [departure('Malik', 210)])).toBe(s));
  });

  it('in the tick: a guest checking out with a big tab makes the story', () => {
    const malik = guest('Malik', { checkInDay: 1, stayLength: 2, trait: 'big_spender', profile: styled('splurger'), spent: { shop: 0, restaurant: 150 } });
    const s0 = hotel([malik], { hour: 10, storyLog: [] });
    const s = { ...addFacility(s0, 'restaurant', 4, 0, 0, 'down')!, noiseSources: [] };
    const r = tickSimulation(s, new PRNG(1));
    expect(r.state.guests.some(g => g.id === 'Malik')).toBe(false); // checked out
    expect(r.state.storyLog.map(e => e.message)).toContain('Malik ran up a $150 restaurant tab.');
  });
});

describe('Returning guests', () => {
  it('a thrifty guest back from before spending styles is no fan of the shop or restaurant (no letdowns they’d never feel)', () => {
    expect(GUEST_FAVORITES.enabled).toBe(true);
    // Found through arrivals: a remembered shop fan, now rolled thrifty
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, day: 30, hour: 15 };
    for (let x = 0; x < 4; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
    s = { ...s, staff: { ...s.staff, frontDesk: 6 } };
    const seen = { thrifty: 0, other: 0 };
    for (let i = 0; i < 600 && (seen.thrifty === 0 || seen.other === 0); i++) {
      const pool = [{ name: 'Mei', trait: 'normal' as const, roomType: 'standard' as const, personId: `mei${i}`, stays: 2, profile: { ...PROFILE, favorite: 'shop' as const }, lastReview: 8, dueDay: 20 }];
      const r = processArrivals({ ...s, returningGuestPool: pool }, 15, new PRNG(i));
      for (const g of [...r.checkedIn.map(c => c.guest), ...r.walkIns.map(w => w.guest)]) {
        if (g.name !== 'Mei' || !g.isReturning) continue;
        seen[g.profile!.spending === 'thrifty' ? 'thrifty' : 'other']++;
        expect(g.profile!.spending).toBe(rollSpending(g.id, g.trait)); // a roll now, from this booking
        expect(g.profile!.favorite).toBe(g.profile!.spending === 'thrifty' ? 'none' : 'shop');
      }
    }
    expect(seen.thrifty).toBeGreaterThan(0);
    expect(seen.other).toBeGreaterThan(0);
  });
});
