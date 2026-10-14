import { describe, it, expect } from 'vitest';
import { createStarterHotel, createHotelState, addRoom, addFacility, getElevatorLoad, getRoomPriceRange, buildFloor, addElevator } from '../src/simulation/HotelState.js';
import { matchGuestToRoom, processArrivals } from '../src/simulation/GuestManager.js';
import { getRoomExpectedPrice, getPartyFairPrice, getExpectedPrice } from '../src/simulation/StarRatingManager.js';
import { profileRoom, fitsParty, neededClass, defaultFurnishing, profileFurnishing, whoFits, sleepSpots } from '../src/simulation/RoomProfile.js';
import { ToastQueue } from '../src/game/ToastQueue.js';
import {
  partyOf, rollParty, withParty, smallerParty, perPersonFactor, partyLoad, budgetMultiplier, getPartyMix, partyLabel,
  occupantFactor,
} from '../src/simulation/Party.js';
import { occupantNoiseOutput, calculateRoomNoise, getLoudestNeighborGuestId } from '../src/simulation/NoiseManager.js';
import { degradeCleanliness } from '../src/simulation/HousekeepingManager.js';
import { degradeRoomConditions, processDailyCosts, amenityCostTonight } from '../src/simulation/EconomyManager.js';
import { planFacilityVisits, creditFacilityVisits, facilityCapacity, facilityLoad } from '../src/simulation/FacilityManager.js';
import { advanceIncidents, recordPartyTurnAways } from '../src/simulation/StoryGenerator.js';
import { memberPositionAt, positionAt, makeWalk, makeStay, legsEnd, hourStart, PARTY_SPACING } from '../src/simulation/Movement.js';
import { guestFigures, partyFigures } from '../src/render/figures.js';
import { PRNG } from '../src/simulation/prng.js';
import { PARTIES, HOUSEKEEPING, ECONOMY, NOISE, FACILITY_CONFIG, FACILITY_LEVELS, TRAVEL, ROOM_CONFIG, ELEVATOR } from '../src/config/balance.js';
import type { Guest, HotelState, Party, PartyKind, Room, ActiveIncident, Leg } from '../src/simulation/types.js';

const P = (kind: PartyKind, size: number): Party => ({ kind, size });
const SOLO = P('solo', 1);
const COUPLE = P('couple', 2);
const FRIENDS2 = P('friends', 2);
const FAMILY4 = P('family', 4);

function guest(id: string, party: Party, extra: Partial<Guest> = {}): Guest {
  return { id, name: 'Priya', budget: 1000, stayLength: 2, trait: 'normal', satisfaction: 60, checkInDay: 1, isReturning: false, hadNoiseComplaint: false, party, ...extra };
}

/** A hotel with rooms of the given kinds on row 2, all empty. */
function hotel(kinds: Array<Parameters<typeof addRoom>[1]>, extra: Partial<HotelState> = {}): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, ...extra };
  kinds.forEach((kind, x) => { s = addRoom(s, kind, x, 2)!; });
  return s;
}

describe('Who books', () => {
  it('a party is worked out from the booking\'s id: the same id, the same party', () => {
    expect(rollParty('guest-3-123', 3)).toEqual(rollParty('guest-3-123', 3));
    for (let i = 0; i < 500; i++) {
      const p = rollParty(`g-${i}`, 3);
      if (p.kind === 'couple') expect(p.size).toBe(2);
      else if (p.kind === 'friends') expect(p.size).toBeGreaterThanOrEqual(2);
      else if (p.kind === 'family') expect(p.size).toBeGreaterThanOrEqual(3);
      else expect(p.size).toBe(1);
      expect(p.size).toBeLessThanOrEqual(4);
    }
  });

  it('the mix follows the week and the season', () => {
    const count = (day: number) => {
      const n: Record<string, number> = {};
      for (let i = 0; i < 20000; i++) { const k = rollParty(`g${i}`, day).kind; n[k] = (n[k] ?? 0) + 1; }
      return n;
    };
    const weekday = count(1); // a spring Monday
    const weekend = count(6); // a spring Saturday
    for (const [kind, share] of Object.entries(PARTIES.weekday)) expect(weekday[kind] / 20000).toBeCloseTo(share, 1);
    for (const [kind, share] of Object.entries(PARTIES.weekend)) expect(weekend[kind] / 20000).toBeCloseTo(share, 1);
    expect(getPartyMix(92).family).toBeCloseTo(PARTIES.weekday.family + PARTIES.summerShift, 9); // a summer Monday
    expect(getPartyMix(91).family).toBeCloseTo(PARTIES.weekend.family + PARTIES.summerShift, 9); // a summer Sunday
  });

  it('with parties off, everyone is one person, as before', () => {
    PARTIES.enabled = false;
    try { expect(rollParty('g', 6)).toEqual(SOLO); } finally { PARTIES.enabled = true; }
  });

  it('a bigger party has more to spend, and a family is never rowdy', () => {
    const g = guest('x', SOLO, { budget: 100, trait: 'party_guest' });
    const family = withParty(g, FAMILY4);
    expect(family.budget).toBeCloseTo(100 * PARTIES.budgetMult[4], 9);
    expect(family.trait).toBe('normal');
    expect(withParty(family, COUPLE).budget).toBeCloseTo(100, 9);
    expect(budgetMultiplier(1)).toBe(1);
    expect(budgetMultiplier(2)).toBe(1);
    expect(withParty(g, P('friends', 3)).trait).toBe('party_guest');
  });

  it('a party that books smaller: families as a couple; friends as a couple or alone', () => {
    expect(smallerParty(FAMILY4, 'a')).toEqual(COUPLE);
    expect(smallerParty(COUPLE, 'a')).toEqual(SOLO);
    for (let i = 0; i < 20; i++) expect(smallerParty(FRIENDS2, `f${i}`)).toEqual(SOLO);
    for (let i = 0; i < 50; i++) expect(['couple', 'solo']).toContain(smallerParty(P('friends', 3), `f${i}`).kind);
  });

  it('messages call a big party by a group name, and one or two people by name', () => {
    expect(partyLabel(guest('a', SOLO))).toBe('Priya');
    expect(partyLabel(guest('a', COUPLE))).toBe('Priya');
    expect(partyLabel(guest('a', FAMILY4))).toMatch(/^the \w+ family$/);
    expect(partyLabel(guest('a', P('friends', 3)))).toBe("Priya's group");
    expect(partyOf({})).toEqual(SOLO); // a booking from before parties
  });
});

describe('Which rooms fit which parties', () => {
  const double = profileFurnishing(defaultFurnishing('classic_queen'));
  const twin = profileFurnishing(defaultFurnishing('twin'));
  const family = profileFurnishing(defaultFurnishing('bunk_family'));

  it('couples and families share beds; friends need one each', () => {
    expect([SOLO, COUPLE, P('business', 1)].every(p => fitsParty(double, p))).toBe(true);
    expect(fitsParty(double, FRIENDS2)).toBe(false); // one bed
    expect(fitsParty(double, P('family', 3))).toBe(false);
    expect(fitsParty(twin, FRIENDS2)).toBe(true);
    expect(fitsParty(twin, COUPLE)).toBe(true);
    expect(fitsParty(family, FAMILY4)).toBe(true);
    expect(fitsParty(family, P('friends', 3))).toBe(true); // the queen, and two bunks
    expect(fitsParty(family, P('friends', 4))).toBe(false);
    expect(whoFits(family)).toBe('a couple, families of 4, 3 friends');
  });

  it('what a room is worth to a party: no more than the room they need', () => {
    const s = hotel(['standard', 'twin', 'bunk_family']);
    const [d, t, f] = s.rooms;
    // A double is worth its price to anyone it fits
    for (const p of [SOLO, COUPLE, P('business', 1)]) expect(getPartyFairPrice(d, p, s.starRating)).toBe(getRoomExpectedPrice(d, s.starRating));
    // A family room is a family room to a family, a double to a couple
    expect(getPartyFairPrice(f, FAMILY4, s.starRating)).toBe(getRoomExpectedPrice(f, s.starRating));
    expect(getPartyFairPrice(f, COUPLE, s.starRating)).toBe(getExpectedPrice('standard', s.starRating));
    expect(getPartyFairPrice(f, FRIENDS2, s.starRating)).toBe(Math.round(getExpectedPrice('standard', s.starRating) * 1.05));
    expect(getPartyFairPrice(t, FRIENDS2, s.starRating)).toBe(getRoomExpectedPrice(t, s.starRating));
    expect(neededClass(P('family', 3))).toBe('family');
    expect(neededClass(FRIENDS2)).toBe('twin');
    expect(neededClass(SOLO)).toBe('double');
  });

  it('matching: a family takes the family room past a cheaper double; a couple won\'t pay a family room\'s price for beds it doesn\'t need', () => {
    const s = hotel(['standard', 'bunk_family']);
    const [d, f] = s.rooms;
    expect(f.pricePerNight).toBeGreaterThan(d.pricePerNight);
    expect(matchGuestToRoom(guest('fam', FAMILY4), [d, f], 1, s.starRating)?.id).toBe(f.id);
    expect(matchGuestToRoom(guest('cpl', COUPLE), [f], 1, s.starRating)).toBeNull();
    expect(matchGuestToRoom(guest('cpl', COUPLE), [f], 1.3, s.starRating)?.id).toBe(f.id); // unless they'll pay over the odds
    expect(matchGuestToRoom(guest('fr', FRIENDS2), [d], 1.8, s.starRating)).toBeNull(); // one bed between them: no
  });
});

describe('Arrivals with parties', () => {
  /** Run arrivals hour after hour over many days, emptying the rooms each time. */
  function run(s: HotelState, days: number) {
    const prng = new PRNG(7);
    const tally = { booked: 0, bigBooked: 0, smaller: 0, turnedAwayNoFit: 0, oversized: 0, pricedOutPairs: 0, pricedOutSmaller: 0 };
    for (let day = 1; day <= days; day++) {
      for (let hour = ECONOMY.checkInStartHour; hour < ECONOMY.checkInEndHour; hour++) {
        const st = { ...s, day, hour, staff: { ...s.staff, frontDesk: 6 } };
        const r = processArrivals(st, hour, prng);
        for (const { guest: g, roomId } of r.checkedIn) {
          tally.booked++;
          const room = s.rooms.find(x => x.id === roomId)!;
          if (!fitsParty(profileRoom(room), partyOf(g))) tally.oversized++;
          if (partyOf(g).size >= 3) tally.bigBooked++;
        }
        for (const e of r.events) {
          if (e.type === 'guest_arrived' && e.data?.wanted) tally.smaller++;
          if (e.type === 'party_turned_away') tally.turnedAwayNoFit++;
          if (e.type === 'guest_turned_away' && e.data?.partyKind === 'friends' && e.data?.reason === 'price') tally.pricedOutPairs++;
          if (e.type === 'guest_turned_away' && e.data?.reason === 'price' && e.data?.wanted) tally.pricedOutSmaller++;
        }
      }
    }
    return tally;
  }

  it('nobody is put in a room that doesn\'t fit them; in a hotel of doubles, big parties mostly book smaller, a few go elsewhere', () => {
    const t = run(hotel(['standard', 'standard', 'standard', 'standard', 'standard', 'standard']), 60);
    expect(t.oversized).toBe(0);
    expect(t.bigBooked).toBe(0);
    expect(t.pricedOutPairs).toBe(0); // two friends with only doubles free: one comes alone (or they go), not "too expensive"
    expect(t.smaller + t.turnedAwayNoFit).toBeGreaterThan(40);
    expect(t.turnedAwayNoFit).toBeGreaterThan(0);
    // (some who book smaller then find the price too high: a thrifty guest's tolerance is half anyone's)
    expect((t.smaller + t.pricedOutSmaller) / (t.smaller + t.pricedOutSmaller + t.turnedAwayNoFit)).toBeCloseTo(PARTIES.rerollChance, 1);
  });

  it('a party that would book smaller but finds the price too high is still counted as the party it was', () => {
    const s = hotel(['standard', 'standard', 'standard', 'standard', 'standard', 'standard']);
    const dear = { ...s, rooms: s.rooms.map(r => ({ ...r, pricePerNight: getRoomPriceRange(r).max })) };
    expect(run(dear, 60).pricedOutSmaller).toBeGreaterThan(0);
  });

  it('with family rooms, families stay as families', () => {
    const t = run(hotel(['standard', 'bunk_family', 'bunk_family', 'twin', 'standard', 'bunk_family']), 60);
    expect(t.oversized).toBe(0);
    expect(t.bigBooked).toBeGreaterThan(10);
  });

  it('who books never moves the shared random stream: the same draws with parties on or off', () => {
    const s = { ...hotel(['standard', 'standard', 'bunk_family']), day: 6, hour: 15, staff: { ...createStarterHotel().staff, frontDesk: 4 } };
    const on = new PRNG(11);
    processArrivals(s, 15, on);
    PARTIES.enabled = false;
    const off = new PRNG(11);
    try { processArrivals(s, 15, off); } finally { PARTIES.enabled = true; }
    expect(on.next()).toBe(off.next());
  });
});

describe('Bigger parties, more of everything', () => {
  it('per person beyond two: noise, mess, wear, consumables and spending, by 30% each', () => {
    expect([1, 2, 3, 4].map(perPersonFactor)).toEqual([1, 1, 1 + PARTIES.perPersonScale, 1 + 2 * PARTIES.perPersonScale]);
    expect(occupantNoiseOutput(guest('a', FAMILY4))).toBeCloseTo(NOISE.baseOccupiedNoise * perPersonFactor(4), 9);
    expect(occupantNoiseOutput(guest('a', COUPLE))).toBeCloseTo(NOISE.baseOccupiedNoise, 9);

    let s = hotel(['standard', 'standard']);
    s = {
      ...s,
      guests: [guest('a', COUPLE), guest('b', FAMILY4)],
      rooms: s.rooms.map((r, i) => ({ ...r, status: 'occupied' as const, guestId: i === 0 ? 'a' : 'b', cleanliness: 90, condition: 90 })),
    };
    const clean = degradeCleanliness(s).rooms;
    expect(90 - clean[0].cleanliness).toBeCloseTo(HOUSEKEEPING.cleanlinessDecayPerDay, 9);
    expect(90 - clean[1].cleanliness).toBeCloseTo(HOUSEKEEPING.cleanlinessDecayPerDay * perPersonFactor(4), 9);
    const worn = degradeRoomConditions(s).rooms;
    expect(90 - worn[1].condition).toBeCloseTo((90 - worn[0].condition) * perPersonFactor(4), 9);
    expect(amenityCostTonight(s, s.rooms[1])).toBeCloseTo(amenityCostTonight(s, s.rooms[0]) * perPersonFactor(4), 9);
    // A room with a guest id but no guest (as some tests build them) counts as one or two
    expect(occupantFactor(s, { guestId: 'nobody' })).toBe(1);
    // The day's bill charges it
    const bill = (st: HotelState) => processDailyCosts(st).cashDelta;
    expect(bill(s) - bill({ ...s, guests: [guest('a', COUPLE), guest('b', COUPLE)] })).toBeCloseTo(-amenityCostTonight(s, s.rooms[0]) * (perPersonFactor(4) - 1), 9);
  });

  it('the loudest neighbour is the biggest party, and noise from it is heard', () => {
    let s = hotel(['standard', 'standard', 'standard']);
    s = {
      ...s,
      hour: 12, // midday: everyone's up (asleep, they'd make none)
      guests: [guest('quiet', SOLO), guest('big', FAMILY4), guest('me', SOLO)],
      rooms: s.rooms.map((r, i) => ({ ...r, status: 'occupied' as const, guestId: ['quiet', 'me', 'big'][i] })),
    };
    const me = s.rooms[1];
    expect(getLoudestNeighborGuestId(me, s)).toBe('big');
    const withCouple = { ...s, guests: [guest('quiet', SOLO), guest('big', COUPLE), guest('me', SOLO)] };
    expect(calculateRoomNoise(me, s)).toBeGreaterThan(calculateRoomNoise(me, withCouple));
    expect(getLoudestNeighborGuestId(me, withCouple)).toBeNull(); // two equally loud neighbours: no culprit
  });

  it('a facility takes a big party only if it fits, counted in twos; and they spend more', () => {
    let s = hotel(['standard', 'standard', 'standard', 'standard']);
    s = addFacility(s, 'gym', 2, 0, 0, 'down')!;
    const parties = [FAMILY4, FAMILY4, FAMILY4, COUPLE];
    s = {
      ...s, day: 3, hour: 7,
      guests: parties.map((p, i) => guest(`g${i}`, p)),
      rooms: s.rooms.map((r, i) => ({ ...r, status: 'occupied' as const, guestId: `g${i}` })),
    };
    const original = FACILITY_CONFIG.gym.visitChance;
    FACILITY_CONFIG.gym.visitChance = [[0, 24, 1]];
    let planned: HotelState;
    try { planned = planFacilityVisits(s); } finally { FACILITY_CONFIG.gym.visitChance = original; }
    const gym = planned.facilities[0];
    expect(facilityCapacity(gym)).toBe(4);
    for (let t = hourStart(planned); t < hourStart(planned) + 3; t += 0.05) expect(facilityLoad(planned, gym.id, t)).toBeLessThanOrEqual(4);
    expect(partyLoad(4)).toBe(2);
    expect(partyLoad(1)).toBe(1);
    // Spending: a family of four at the gym spends 1.6x
    const visitor = planned.guests.find(g => g.trip && partyOf(g).size === 4)!;
    const stay = visitor.trip!.find(l => l.kind === 'stay')!;
    const only = { ...planned, guests: [visitor] };
    const spent = creditFacilityVisits(only, stay.start + 0.01).cash - only.cash;
    expect(spent).toBeCloseTo(FACILITY_CONFIG.gym.spendPerVisit * FACILITY_LEVELS[0].revenueMult * perPersonFactor(4), 6);
  });

  it('lifts carry people: a family room upstairs is two rooms\' worth', () => {
    let s = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
    s = buildFloor(s)!.state;
    s = addElevator(s, 0, 0)!;
    s = addRoom(s, 'standard', 3, 2, 1)!;
    const doubles = getElevatorLoad(s);
    expect(doubles).toBeCloseTo(1 / ELEVATOR.roomsServed, 9);
    s = addRoom(s, 'bunk_family', 4, 2, 1)!;
    expect(getElevatorLoad(s)).toBeCloseTo(3 / ELEVATOR.roomsServed, 9);
  });

  it('a family room\'s price runs higher than a standard room\'s', () => {
    const s = hotel(['standard', 'bunk_family']);
    expect(getRoomPriceRange(s.rooms[0])).toEqual({ min: ROOM_CONFIG.standard.minPrice, max: ROOM_CONFIG.standard.maxPrice });
    expect(getRoomPriceRange(s.rooms[1]).max).toBe(Math.round(ROOM_CONFIG.standard.maxPrice * 1.25));
  });
});

describe('Room moves and stories', () => {
  it('after a breakdown a family is moved only into a room that fits them, and two guests never into one room', () => {
    let s = hotel(['standard', 'standard', 'bunk_family', 'standard']);
    const [broken1, broken2, familyRoom, spare] = s.rooms;
    const incident = (id: string, g: string, room: Room): ActiveIncident => ({ id, type: 'mid_stay_breakdown', guestId: g, roomId: room.id, stage: 'active', hoursRemaining: 3, chainId: id });
    s = {
      ...s,
      guests: [guest('fam', P('family', 3), { checkInDay: 1, stayLength: 5 }), guest('two', COUPLE, { checkInDay: 1, stayLength: 5 })],
      rooms: s.rooms.map(r => (r.id === broken1.id ? { ...r, status: 'occupied' as const, guestId: 'fam', condition: 0 }
        : r.id === broken2.id ? { ...r, status: 'occupied' as const, guestId: 'two', condition: 0 } : r)),
      activeIncidents: [incident('i1', 'fam', broken1), incident('i2', 'two', broken2)],
    };
    const after = advanceIncidents(s, new PRNG(1)).state;
    expect(after.rooms.find(r => r.id === familyRoom.id)!.guestId).toBe('fam');
    expect(after.rooms.find(r => r.id === spare.id)!.guestId).toBe('two');
    // Only one room free, and it's a double: the family can't go there; the couple can
    let tight = { ...s, rooms: s.rooms.filter(r => r.id !== familyRoom.id) };
    tight = { ...tight, activeIncidents: [incident('i1', 'fam', broken1), incident('i2', 'two', broken2)] };
    const t2 = advanceIncidents(tight, new PRNG(1)).state;
    expect(t2.rooms.find(r => r.id === spare.id)!.guestId).toBe('two');
    expect(t2.rooms.filter(r => r.guestId === 'fam').map(r => r.id)).toEqual([broken1.id]);
    // Two guests, one free room that fits both: the second waits
    let one = { ...s, rooms: s.rooms.filter(r => r.id !== spare.id) };
    one = { ...one, guests: [guest('fam', COUPLE, { stayLength: 5 }), guest('two', COUPLE, { stayLength: 5 })] };
    const t3 = advanceIncidents(one, new PRNG(1)).state;
    expect(t3.rooms.filter(r => r.guestId === 'fam' || r.guestId === 'two')).toHaveLength(2);
  });

  it('a breakdown moves a guest to the smallest room that fits: a couple doesn\'t take the family room a family needs', () => {
    let s = hotel(['standard', 'standard', 'bunk_family', 'standard']);
    const [a, b, f, d] = s.rooms;
    const incident = (id: string, g: string, room: Room): ActiveIncident => ({ id, type: 'mid_stay_breakdown', guestId: g, roomId: room.id, stage: 'active', hoursRemaining: 1, chainId: id });
    s = {
      ...s,
      guests: [guest('cpl', COUPLE, { stayLength: 5 }), guest('fam', FAMILY4, { stayLength: 5 })],
      // the family room priced below the double, so cheapest-first alone would give it to the couple
      rooms: s.rooms.map(r => (r.id === a.id ? { ...r, status: 'occupied' as const, guestId: 'cpl', condition: 0 }
        : r.id === b.id ? { ...r, status: 'occupied' as const, guestId: 'fam', condition: 0 }
        : r.id === f.id ? { ...r, pricePerNight: d.pricePerNight - 20 } : r)),
      activeIncidents: [incident('i1', 'cpl', a), incident('i2', 'fam', b)],
    };
    const result = advanceIncidents(s, new PRNG(1));
    expect(result.state.rooms.find(r => r.id === d.id)!.guestId).toBe('cpl');
    expect(result.state.rooms.find(r => r.id === f.id)!.guestId).toBe('fam');
    expect(result.earlyDepartureGuestIds.size).toBe(0);
  });

  it('the turn-away story says what kind of room would have taken them', () => {
    const s = { ...createHotelState(), day: 4 };
    const story = (kind: PartyKind, size: number) => recordPartyTurnAways(s, [{ type: 'party_turned_away', message: 'x', data: { partyKind: kind, size } }]).storyLog[0].message;
    expect(story('family', 4)).toMatch(/family room/);
    expect(story('family', 4)).not.toMatch(/twin/);
    expect(story('friends', 2)).toMatch(/twin/);
    expect(story('friends', 4)).toMatch(/bunk/);
  });

  it('a family turned away makes a story -- once a day, and not at the expense of the incidents', () => {
    const s = { ...createHotelState(), day: 4 };
    const event = { type: 'party_turned_away' as const, message: 'The Okafor family was turned away: no room for four', data: { size: 4 } };
    const once = recordPartyTurnAways(s, [event, event]);
    expect(once.storyLog).toHaveLength(1);
    expect(once.storyLog[0].message).toMatch(/Okafor/);
    expect(recordPartyTurnAways(once, [event]).storyLog).toHaveLength(1);
    expect(recordPartyTurnAways({ ...once, day: 5 }, [event]).storyLog).toHaveLength(2);
  });
});

describe('Parties walk together', () => {
  const tile = (x: number) => ({ gridX: x, gridY: 1, floor: 0 });
  const path = Array.from({ length: 10 }, (_, i) => tile(i));
  const pace = TRAVEL.guestHoursPerTile;
  const legs: Leg[] = [
    makeStay(tile(0), 10, 10.2, 'wait'),
    makeWalk(path, 10.2, pace),
  ];
  legs.push(makeStay(tile(9), legsEnd(legs), legsEnd(legs) + 0.5, 'visit', { placeId: 'gym' }));

  it('together at every stop; spread out along the way, each a little ahead; never behind the first', () => {
    const walk = legs[1];
    for (const t of [10.1, walk.start, walk.end, walk.end + 0.2]) {
      const lead = positionAt(legs, t)!;
      for (let m = 1; m < 4; m++) expect(memberPositionAt(legs, t, m)).toMatchObject({ x: lead.x, y: lead.y, floor: lead.floor });
    }
    const mid = (walk.start + walk.end) / 2;
    const lead = positionAt(legs, mid)!;
    for (let m = 1; m < 4; m++) expect(memberPositionAt(legs, mid, m)!.x - lead.x).toBeCloseTo(m * PARTY_SPACING, 6);
    // No jumps: everyone moves smoothly, and nobody is ever behind the first member
    for (let m = 0; m < 4; m++) {
      let prev = memberPositionAt(legs, walk.start, m)!;
      for (let t = walk.start; t <= walk.end; t += 0.005) {
        const at = memberPositionAt(legs, t, m)!;
        expect(Math.abs(at.x - prev.x)).toBeLessThan(0.25);
        expect(at.x).toBeGreaterThanOrEqual(positionAt(legs, t)!.x - 1e-9);
        prev = at;
      }
    }
  });

  it('a party rides the lift together: nobody changes floor before the rest', () => {
    const route = [tile(3), tile(2), tile(1), tile(0), { gridX: 0, gridY: 1, floor: 1 }, { gridX: 1, gridY: 1, floor: 1 }, { gridX: 2, gridY: 1, floor: 1 }];
    const trip: Leg[] = [makeWalk(route, 20, pace)];
    for (let t = 20; t <= legsEnd(trip); t += 0.005) {
      const floors = [0, 1, 2, 3].map(m => memberPositionAt(trip, t, m)!.floor);
      expect(new Set(floors).size, `split across floors at ${t}`).toBe(1);
    }
  });

  it('friends sleep a bed each before anyone shares', () => {
    const s = hotel(['bunk_family']);
    const room = s.rooms[0];
    const spots = sleepSpots(room, true);
    const together = sleepSpots(room);
    expect(spots).toHaveLength(4);
    // The queen's second place comes last when nobody shares
    expect(spots[3]).toEqual(together[1]);
    expect(new Set(spots.slice(0, 3).map(String)).size).toBe(3);
  });

  it('batched toasts count people, as the status bar does', () => {
    const q = new ToastQueue();
    q.add([{ type: 'guest_arrived', message: 'a', data: { size: 4 } }, { type: 'guest_arrived', message: 'b', data: { size: 1 } }], 0);
    q.update(10_000);
    expect(q.toasts.map(t => t.message)).toContain('5 guests arriving');
  });

  it('everyone in a party is drawn; children smaller; nobody while they\'re out for the day', () => {
    const figures = partyFigures('g', FAMILY4, legs, (legs[1].start + legs[1].end) / 2, 0xffffff, true);
    expect(figures).toHaveLength(4);
    expect(figures.filter(f => f.small)).toHaveLength(2);
    expect(figures.filter(f => f.ring).map(f => f.id)).toEqual(['g']);
    const away: Leg[] = [makeStay(tile(0), 10, 12, 'away')];
    expect(partyFigures('g', FAMILY4, away, 11, 0xffffff, false)).toEqual([]);
    const s = { ...createStarterHotel(), guests: [guest('g', P('friends', 3), { trip: legs })] };
    expect(guestFigures(s, 10.1).figures).toHaveLength(3);
  });
});
