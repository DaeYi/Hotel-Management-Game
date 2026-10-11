import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, addFacility, addFixture, buildFloor, addElevator, demolishFacility, demolishElevator, demolishFixture, setRoomDoor } from '../src/simulation/HotelState.js';
import { findRoute, isEntranceTile, getFixtureFront, doorTile } from '../src/simulation/Layout.js';
import { makeWalk, makeStay, positionAt, truncateLegs, legsEnd, hourStart, hash01 } from '../src/simulation/Movement.js';
import { planArrivalTrips, checkInLanes, CHECK_IN_HOURS, departureWalker, isGuestAway, rerouteTrips, tripStillWalkable, guestTileAt } from '../src/simulation/GuestMovement.js';
import { planFacilityVisits, creditFacilityVisits, facilityCapacity, facilityReviewBonus, guestsInFacility, visitChance } from '../src/simulation/FacilityManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { TRAVEL, FACILITY_CONFIG, FACILITY_LEVELS, FACILITY_VISITS, GUEST_OUTINGS, STARTER_LAYOUT } from '../src/config/balance.js';
import { planOutings } from '../src/simulation/OutingManager.js';
import { getStaffPlan } from '../src/simulation/StaffManager.js';
import type { HotelState, Guest, Leg } from '../src/simulation/types.js';

const rich = (s: HotelState): HotelState => ({ ...s, cash: 1_000_000, peakStarRating: 5 });

function guest(id: string, extra: Partial<Guest> = {}): Guest {
  return { id, name: 'Sam', budget: 200, stayLength: 2, trait: 'normal', satisfaction: 60, checkInDay: 1, isReturning: false, hadNoiseComplaint: false, ...extra };
}

/** The starter hotel with `n` guests checked into rooms on row 2 (doors up, onto the first corridor). */
function withGuests(n: number, extra: Partial<HotelState> = {}): HotelState {
  let s = rich(createStarterHotel());
  for (let x = 0; x < n; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
  const guests = s.rooms.map((r, i) => guest(`g${i}`));
  return { ...s, day: 3, hour: 7, guests, rooms: s.rooms.map((r, i) => ({ ...r, status: 'occupied' as const, guestId: guests[i].id })), ...extra };
}

describe('Movement: where an itinerary puts someone', () => {
  it('walks tile by tile at its pace, and rides elevators at TRAVEL.hoursPerFloor per floor', () => {
    const path = [{ gridX: 0, gridY: 1, floor: 0 }, { gridX: 0, gridY: 0, floor: 0 }, { gridX: 0, gridY: 0, floor: 2 }, { gridX: 1, gridY: 0, floor: 2 }];
    const walk = makeWalk(path, 10, 0.1);
    expect(walk.end).toBeCloseTo(10 + 0.1 + 2 * TRAVEL.hoursPerFloor + 0.1, 9);
    const mid = positionAt([walk], 10.05)!;
    expect([mid.x, mid.floor, mid.moving]).toEqual([0, 0, true]);
    expect(mid.y).toBeCloseTo(0.5, 9);
    // In the shaft: the floor left for the first half of the ride, the one arrived at for the second
    expect(positionAt([walk], 10.1 + 0.1)!.floor).toBe(0);
    expect(positionAt([walk], 10.1 + 0.2)!.floor).toBe(2);
    expect(positionAt([walk], 99)).toMatchObject({ x: 1, y: 0, floor: 2, moving: false });
  });

  it('stays put during a stay, and a trip cut short stops at the tile reached', () => {
    const walk = makeWalk([{ gridX: 0, gridY: 1, floor: 0 }, { gridX: 1, gridY: 1, floor: 0 }, { gridX: 2, gridY: 1, floor: 0 }], 0, 0.5);
    const legs: Leg[] = [walk, makeStay({ gridX: 2, gridY: 1, floor: 0 }, 1, 2, 'visit')];
    expect(positionAt(legs, 1.5)).toMatchObject({ x: 2, y: 1, moving: false });
    const cut = truncateLegs(legs, 0.7);
    expect(cut.at).toEqual({ gridX: 1, gridY: 1, floor: 0 });
    expect(legsEnd(cut.legs)).toBeCloseTo(0.5, 9);
  });

  it('routes take the quickest way in time, entering rooms only through their door', () => {
    let s = rich(createStarterHotel());
    s = addRoom(s, 'standard', 5, 2, 0, 'down')!;
    const route = findRoute(s, { gridX: 5, gridY: 1, floor: 0 }, s.rooms[0])!;
    // Can't step down into the room from above: around to (5,3) and in from below
    expect(route.path[route.path.length - 2]).toEqual({ gridX: 5, gridY: 3, floor: 0 });
    expect(route.hours).toBeCloseTo((route.path.length - 1) * TRAVEL.hoursPerTile, 9);
  });

  it('the hash used for choices is deterministic and spread over [0, 1)', () => {
    expect(hash01('guest-1|3|7|gym')).toBe(hash01('guest-1|3|7|gym'));
    const xs = Array.from({ length: 2000 }, (_, i) => hash01(`g${i}`));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.filter(x => x < 0.5).length / xs.length).toBeCloseTo(0.5, 1);
  });
});

describe('Arrivals: guests walk in, check in at a staffed desk, and go up to their room', () => {
  function arrivals(n: number, frontDesk: number) {
    let s = rich(createStarterHotel());
    s = addFixture(s, 'desk', STARTER_LAYOUT.deskTiles[1][0], STARTER_LAYOUT.deskTiles[1][1], 0)!;
    for (let x = 0; x < n; x++) s = addRoom(s, 'standard', x % 9, x < 9 ? 0 : 2, 0, x < 9 ? 'down' : 'up')!;
    s = { ...s, day: 2, hour: 15, staff: { ...s.staff, frontDesk } };
    const checkedIn = s.rooms.map((r, i) => ({ guest: guest(`a${i}`), roomId: r.id }));
    const T = hourStart(s) + 1;
    return { s, T, checkedIn, plan: planArrivalTrips(s, checkedIn, [], T) };
  }

  it('one check-in lane per seated front desk worker; nobody checks in at an empty desk', () => {
    const { s } = arrivals(1, 1);
    expect(checkInLanes(s)).toHaveLength(1);
    expect(checkInLanes({ ...s, staff: { ...s.staff, frontDesk: 3 } })).toHaveLength(3);
  });

  it('each lane serves one guest at a time for CHECK_IN_HOURS, at the front of the desk, and every trip ends in the guest\'s room', () => {
    const { s, T, checkedIn, plan } = arrivals(6, 2);
    const byDesk = new Map<string, Array<[number, number]>>();
    for (const { guest: g, roomId } of checkedIn) {
      const legs = plan.trips.get(g.id)!;
      expect(legs[0].start).toBeGreaterThanOrEqual(T - 1e-9); // nobody's on screen before the booking
      const checkIn = legs.find(l => l.kind === 'stay' && l.activity === 'check_in')!;
      expect(checkIn.end - checkIn.start).toBeCloseTo(CHECK_IN_HOURS, 9);
      const desk = s.fixtures.find(f => f.id === (checkIn as any).placeId)!;
      expect((checkIn as any).at).toEqual(getFixtureFront(s, desk));
      byDesk.set(`${desk.id}`, [...(byDesk.get(desk.id) ?? []), [checkIn.start, checkIn.end]]);
      const room = s.rooms.find(r => r.id === roomId)!;
      const end = positionAt(legs, legsEnd(legs))!;
      expect([end.x, end.y, end.floor]).toEqual([room.gridX, room.gridY, room.floor]);
      expect(isEntranceTile(s, (legs[0] as any).path[0])).toBe(true);
    }
    // Two workers on the first desk: at most two guests checking in there at once
    for (const spans of byDesk.values()) {
      for (const [a0, a1] of spans) {
        expect(spans.filter(([b0, b1]) => b0 < a1 - 1e-9 && a0 < b1 - 1e-9).length).toBeLessThanOrEqual(2);
      }
    }
  });

  it('guests who are turned away or give up walk in and back out to the street', () => {
    const { s, T } = arrivals(1, 1);
    const { walkers } = planArrivalTrips(s, [], [{ guest: guest('x'), outcome: 'impatient' }, { guest: guest('y'), outcome: 'turned_away' }], T);
    expect(walkers.map(w => w.reason)).toEqual(['impatient', 'turned_away']);
    for (const w of walkers) {
      expect(isEntranceTile(s, (w.trip[0] as any).path[0])).toBe(true);
      const last = w.trip[w.trip.length - 1] as any;
      expect(isEntranceTile(s, last.path[last.path.length - 1])).toBe(true);
    }
  });

  it('in a full tick, booked guests are on their way in (not yet in the room) and arrive within the trip', () => {
    let s = rich(createStarterHotel());
    for (let x = 3; x < 9; x++) s = addRoom(s, 'standard', x, 2, 0, 'up')!;
    s = { ...s, day: 6, hour: 17, reviewScore: 9 };
    const prng = new PRNG(5);
    for (let i = 0; i < 4; i++) s = tickSimulation(s, prng).state;
    const T = hourStart(s);
    const arriving = s.guests.filter(g => g.tripKind === 'arrival' && g.trip && legsEnd(g.trip) > T);
    expect(arriving.length).toBeGreaterThan(0);
    for (const g of arriving) {
      const room = s.rooms.find(r => r.guestId === g.id)!;
      expect(room.status).toBe('occupied'); // booked...
      const now = guestTileAt(s, g, T)!;
      expect([now.gridX, now.gridY, now.floor]).not.toEqual([room.gridX, room.gridY, room.floor]); // ...but not in it yet
      expect(isEntranceTile(s, (g.trip![0] as any).path[0])).toBe(true); // coming in off the street
      const end = positionAt(g.trip!, legsEnd(g.trip!))!;
      expect([end.x, end.y, end.floor]).toEqual([room.gridX, room.gridY, room.floor]); // and they get there
      expect(isGuestAway(g, legsEnd(g.trip!))).toBe(false);
    }
  });
});

describe('Departures: guests walk out from wherever they are', () => {
  it('a checked-out guest leaves their room for the street as the tick that checked them out happens', () => {
    let s = withGuests(1);
    s = { ...s, hour: 23, guests: [{ ...s.guests[0], checkInDay: 1, stayLength: 2 }] }; // last night ends at midnight
    const after = tickSimulation(s, new PRNG(1)).state;
    expect(after.guests).toHaveLength(0);
    const walker = after.walkers!.find(w => w.reason === 'checked_out')!;
    const room = s.rooms[0];
    expect((walker.trip[0] as any).path[0]).toMatchObject({ gridX: room.gridX, gridY: room.gridY });
    expect(walker.trip[0].start).toBeCloseTo(hourStart(s) + 1, 9);
    const last = walker.trip[walker.trip.length - 1] as any;
    expect(isEntranceTile(after, last.path[last.path.length - 1])).toBe(true);
  });

  it('a guest out at a facility when they leave walks out from there', () => {
    let s = withGuests(1);
    s = addFacility(s, 'gym', 6, 0, 0, 'down')!;
    const gym = s.facilities[0];
    const T = hourStart(s) + 0.5;
    const at = { gridX: gym.gridX, gridY: gym.gridY, floor: 0, door: gym.door };
    const g = { ...s.guests[0], trip: [makeStay(at, T - 0.5, T + 1, 'visit', { placeId: gym.id })] as Leg[] };
    const walker = departureWalker(s, g, T, 'walked_out')!;
    expect((walker.trip[0] as any).path[0]).toMatchObject({ gridX: gym.gridX, gridY: gym.gridY });
  });
});

describe('Facility visits: guests really go, and only visitors get the bonus', () => {
  function gymHotel(guests: number, extra: Partial<HotelState> = {}) {
    let s = withGuests(guests, extra);
    s = addFacility(s, 'gym', 2, 0, 0, 'down')!;
    return s;
  }

  /** Plan with a facility type's visit chance set, so tests don't hang on a few dice. */
  function withChance<T>(type: string, chance: number, fn: () => T): T {
    const original = FACILITY_CONFIG[type].visitChance;
    FACILITY_CONFIG[type].visitChance = [[0, 24, chance]];
    try { return fn(); } finally { FACILITY_CONFIG[type].visitChance = original; }
  }

  it('in the morning some guests head to the gym: out, a visit inside, and back to their room', () => {
    const s = withChance('gym', 0.5, () => planFacilityVisits(gymHotel(6)));
    const visitors = s.guests.filter(g => g.trip);
    expect(visitors.length).toBeGreaterThan(0);
    for (const g of visitors) {
      expect(g.tripKind).toBe('visit');
      const kinds = g.trip!.map(l => (l.kind === 'stay' ? l.activity : l.kind));
      expect(kinds).toEqual(['walk', 'visit', 'walk']);
      const stay = g.trip![1] as any;
      expect(stay.placeId).toBe(s.facilities[0].id);
      expect(stay.end - stay.start).toBeCloseTo(FACILITY_CONFIG.gym.visitHours, 9);
      expect(guestsInFacility(s, s.facilities[0].id, (stay.start + stay.end) / 2)).toContainEqual(expect.objectContaining({ id: g.id }));
      // Still in their room (dot shown) until they set out
      expect(isGuestAway(g, g.trip![0].start - 1e-6)).toBe(false);
      expect(isGuestAway(g, g.trip![0].start + 1e-6)).toBe(true);
    }
    // Planning is deterministic
    expect(withChance('gym', 0.5, () => planFacilityVisits(gymHotel(6))).guests.map(g => g.trip)).toEqual(s.guests.map(g => g.trip));
  });

  it('a visit counts once the guest gets there -- not when it is planned', () => {
    const planned = withChance('gym', 1, () => planFacilityVisits(gymHotel(1)));
    const stay = planned.guests[0].trip![1];
    expect(planned.guests[0].facilitiesUsed?.gym).toBeUndefined();
    expect(creditFacilityVisits(planned, stay.start).guests[0].facilitiesUsed?.gym).toBeUndefined(); // not there yet
    const credited = creditFacilityVisits(planned, stay.start + 0.01);
    expect(credited.guests[0].facilitiesUsed?.gym).toEqual({ level: 1, day: planned.day });
    expect(creditFacilityVisits(credited, stay.end).guests[0]).toBe(credited.guests[0]); // only once
  });

  it('a visit cut short before the guest gets there earns nothing', () => {
    let s = withChance('gym', 1, () => planFacilityVisits(gymHotel(1)));
    const leave = s.guests[0].trip![0].start;
    s = demolishFacility(s, s.facilities[0].id)!;
    s = rerouteTrips(s, leave + 0.01);
    expect(s.guests[0].trip?.some(l => l.kind === 'stay' && l.activity === 'visit') ?? false).toBe(false);
    expect(creditFacilityVisits(s, leave + 2).guests[0].facilitiesUsed?.gym).toBeUndefined();
  });

  it('never more guests inside than the facility holds', () => {
    const after = withChance('gym', 1, () => planFacilityVisits(gymHotel(7))); // everyone wants to go
    const gym = after.facilities[0];
    expect(after.guests.filter(g => g.trip).length).toBe(facilityCapacity(gym));
    for (let t = hourStart(after); t < hourStart(after) + 3; t += 0.05) {
      expect(guestsInFacility(after, gym.id, t).length).toBeLessThanOrEqual(facilityCapacity(gym));
    }
  });

  it('nobody goes to a facility whose door is blocked', () => {
    let s = gymHotel(6);
    s = addRoom(s, 'standard', 2, 1, 0, 'up')!; // right outside the gym's door
    expect(withChance('gym', 1, () => planFacilityVisits(s)).guests.some(g => g.trip)).toBe(false);
  });

  it('nobody walks further than FACILITY_VISITS.maxWalkHours (one way) to a facility', () => {
    let s = buildFloor(buildFloor(rich(createStarterHotel()))!.state)!.state;
    s = addElevator(s, 0, 0)!;
    s = addFacility(s, 'gym', 3, 0, 0, 'down')!;
    const visit = (x: number, floor: number) => {
      let h = addRoom(s, 'standard', x, 2, floor, 'up')!;
      h = { ...h, day: 3, hour: 7, guests: [guest('g')], rooms: h.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'g' })) };
      const walk = findRoute(h, h.rooms[0], { gridX: 3, gridY: 0, floor: 0, door: 'down' }, TRAVEL.guestHoursPerTile)!.hours;
      return { walk, trip: withChance('gym', 1, () => planFacilityVisits(h)).guests[0].trip };
    };
    const far = visit(9, 2);
    expect(far.walk).toBeGreaterThan(FACILITY_VISITS.maxWalkHours);
    expect(far.trip).toBeFalsy();
    const near = visit(9, 0); // over the limit there and back, within it one way
    expect(near.walk).toBeLessThanOrEqual(FACILITY_VISITS.maxWalkHours);
    expect(2 * near.walk).toBeGreaterThan(FACILITY_VISITS.maxWalkHours);
    expect(near.trip).toBeTruthy();
    const upstairs = visit(1, 1); // guests upstairs ride the elevator down
    expect(upstairs.trip).toBeTruthy();
    expect((upstairs.trip![0] as any).path.some((p: any, i: number, path: any[]) => i > 0 && p.floor !== path[i - 1].floor)).toBe(true);
  });

  it('the review bonus comes only from facilities a guest used, scaled by level and season, and capped', () => {
    const visitor = guest('v', { facilitiesUsed: { gym: { level: 2, day: 3 }, shop: { level: 1, day: 3 } } });
    expect(facilityReviewBonus(guest('s'), 3)).toBe(0);
    expect(facilityReviewBonus(visitor, 3)).toBeCloseTo(
      FACILITY_CONFIG.gym.visitReviewBonus * FACILITY_LEVELS[1].reviewMult + FACILITY_CONFIG.shop.visitReviewBonus, 9);
    const swimmer = guest('p', { facilitiesUsed: { pool: { level: 1, day: 100 } } });
    expect(facilityReviewBonus(swimmer, 100)).toBeCloseTo(FACILITY_CONFIG.pool.visitReviewBonus * FACILITY_VISITS.seasonalBonusMult, 9); // day 100 is summer
    const everything = guest('e', { facilitiesUsed: { gym: { level: 3, day: 1 }, restaurant: { level: 3, day: 1 }, pool: { level: 3, day: 1 }, shop: { level: 3, day: 1 } } });
    expect(facilityReviewBonus(everything, 1)).toBe(FACILITY_VISITS.maxBonusPerStay);
    expect(visitChance('pool', 12, 100)).toBeCloseTo(FACILITY_CONFIG.pool.visitChance[0][2] * FACILITY_VISITS.seasonalChanceMult.summer, 9);
    expect(facilityCapacity({ type: 'gym', level: 3 } as any)).toBe(Math.round(FACILITY_CONFIG.gym.capacity * FACILITY_LEVELS[2].capacityMult));
  });

  it('shop visits are sales, once the guest gets there, at the shop\'s level', () => {
    for (const level of [1, 2]) {
      let s = withGuests(3, { hour: 18 });
      s = addFacility(s, 'shop', 2, 0, 0, 'down')!;
      s = { ...s, facilities: s.facilities.map(f => ({ ...f, level })) };
      const planned = withChance('shop', 1, () => planFacilityVisits(s));
      const shoppers = planned.guests.filter(g => g.trip).length;
      expect(shoppers).toBeGreaterThan(0);
      expect(planned.cash).toBe(s.cash); // nothing sold yet
      const after = creditFacilityVisits(planned, hourStart(s) + 3);
      expect(after.cash - s.cash).toBeCloseTo(shoppers * FACILITY_CONFIG.shop.spendPerVisit * FACILITY_LEVELS[level - 1].revenueMult, 9);
    }
  });

  it('a guest uses each type of facility at most once a day', () => {
    const planned = withChance('gym', 0.5, () => planFacilityVisits(gymHotel(6)));
    expect(planned.guests.some(g => g.trip)).toBe(true);
    const s = creditFacilityVisits(planned, hourStart(planned) + 3);
    const back = { ...s, hour: 19, guests: s.guests.map(g => ({ ...g, trip: null })) };
    const evening = withChance('gym', 1, () => planFacilityVisits(back));
    for (const g of evening.guests) if (planned.guests.find(x => x.id === g.id)!.trip) expect(g.trip).toBeNull();
  });
});

describe('Changing the building mid-trip', () => {
  /** One guest walking from the corridor's west end to their room. */
  function walking() {
    const s = withGuests(1);
    const room = s.rooms[0];
    const route = findRoute(s, { gridX: 0, gridY: 1, floor: 0 }, room, TRAVEL.guestHoursPerTile)!;
    const T = hourStart(s);
    return { s: { ...s, guests: [{ ...s.guests[0], trip: [makeWalk(route.path, T, TRAVEL.guestHoursPerTile)] }] } as HotelState, room, route, T };
  }
  const endsIn = (legs: Leg[], room: { gridX: number; gridY: number; floor: number }) => {
    const end = positionAt(legs, 1e9)!;
    return end.x === room.gridX && end.y === room.gridY && end.floor === room.floor;
  };

  it('a guest whose way is blocked by a new room finds a way around from where they are', () => {
    const { s, room, route, T } = walking();
    const blockAt = route.path[2];
    let built = addRoom(s, 'standard', blockAt.gridX, blockAt.gridY, 0, 'up')!;
    expect(tripStillWalkable(built, built.guests[0].trip!, T + 0.01)).toBe(false);
    built = rerouteTrips(built, T + 0.01);
    expect(tripStillWalkable(built, built.guests[0].trip!, T + 0.01)).toBe(true);
    expect(endsIn(built.guests[0].trip!, room)).toBe(true);
  });

  it('building behind someone (on tiles they have passed) leaves their trip alone', () => {
    const { s, route, T } = walking();
    const t = T + 3.5 * TRAVEL.guestHoursPerTile; // past path[3]
    const behind = route.path[1];
    const built = addRoom(s, 'standard', behind.gridX, behind.gridY, 0, 'down')!;
    expect(tripStillWalkable(built, built.guests[0].trip!, t)).toBe(true);
    expect(rerouteTrips(built, t).guests[0].trip).toBe(built.guests[0].trip);
  });

  it('turning the door of the room someone is heading for sends them round to the new door', () => {
    const { s, room, T } = walking();
    const turned = setRoomDoor(s, room.id, 'down')!;
    expect(tripStillWalkable(turned, turned.guests[0].trip!, T + 0.01)).toBe(false);
    const trip = rerouteTrips(turned, T + 0.01).guests[0].trip!;
    const last = trip[trip.length - 1] as any;
    expect(last.path[last.path.length - 2]).toMatchObject(doorTile(room, 'down'));
  });

  it('an arriving guest who has not come in yet still comes in off the street and checks in', () => {
    let s = rich(createStarterHotel());
    s = addRoom(s, 'standard', 8, 2, 0, 'up')!;
    s = { ...s, day: 2, hour: 15 };
    const T = hourStart(s) + 1;
    const g = guest('late');
    const { trips } = planArrivalTrips(s, [{ guest: g, roomId: s.rooms[0].id }], [], T);
    let state: HotelState = { ...s, guests: [{ ...g, trip: trips.get('late')!, tripKind: 'arrival' }], rooms: s.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'late' })) };
    const legs = trips.get('late')!;
    const toRoom = legs[legs.length - 1] as any;
    const block = toRoom.path[Math.floor(toRoom.path.length / 2)];
    state = rerouteTrips(addRoom(state, 'standard', block.gridX, block.gridY, 0, 'down')!, T - 0.5);
    const trip = state.guests[0].trip!;
    expect(isEntranceTile(state, (trip[0] as any).path[0])).toBe(true);
    expect(trip.some(l => l.kind === 'stay' && l.activity === 'check_in')).toBe(true);
    expect(endsIn(trip, s.rooms[0])).toBe(true);
  });

  it('when an elevator someone is riding is demolished, they go round by another one', () => {
    let s = buildFloor(rich(createStarterHotel()))!.state;
    s = addElevator(addElevator(s, 0, 0)!, 9, 0)!;
    s = addRoom(s, 'standard', 1, 2, 1, 'up')!;
    s = { ...s, day: 3, hour: 7, guests: [guest('up')], rooms: s.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'up' })) };
    const T = hourStart(s);
    const route = findRoute(s, { gridX: 1, gridY: 1, floor: 0 }, s.rooms[0], TRAVEL.guestHoursPerTile)!;
    expect(route.path.some(p => p.gridX === 0 && p.gridY === 0)).toBe(true); // via the near shaft
    s = { ...s, guests: [{ ...s.guests[0], trip: [makeWalk(route.path, T, TRAVEL.guestHoursPerTile)] }] };
    const without = demolishElevator(s, s.elevators.find(e => e.gridX === 0)!.id)!;
    const trip = rerouteTrips(without, T + 0.01).guests[0].trip!;
    expect(trip.some(l => l.kind === 'walk' && l.path.some(p => p.gridX === 9 && p.gridY === 0 && p.floor === 1))).toBe(true);
    expect(endsIn(trip, s.rooms[0])).toBe(true);
  });

  it('people leaving by a street entrance that gets bulldozed leave by another one', () => {
    let s = withGuests(1);
    s = addFixture(s, 'entrance', 9, 1, 0)!;
    const T = hourStart(s);
    const w = departureWalker(s, s.guests[0], T, 'checked_out')!;
    const path = (w.trip[0] as any).path;
    const exit = path[path.length - 1];
    s = { ...s, walkers: [w] };
    const gone = demolishFixture(s, s.fixtures.find(f => f.type === 'entrance' && f.gridX === exit.gridX && f.gridY === exit.gridY)!.id)!;
    const after = rerouteTrips(gone, T + 0.01).walkers![0];
    const last = after.trip[after.trip.length - 1] as any;
    expect(isEntranceTile(gone, last.path[last.path.length - 1])).toBe(true);
  });
});

describe('Save migration to v18', () => {
  it('guests start in their rooms with no facility visits; old staff positions are dropped (rebuilt on load)', async () => {
    const { loadGame } = await import('../src/simulation/SaveManager.js');
    const state: any = { ...withGuests(1), walkers: undefined, staffRoster: [{ id: 'x', role: 'housekeeper', at: { gridX: 9, gridY: 9, floor: 0 } }], staffPlan: {} };
    for (const g of state.guests) { delete g.trip; delete g.facilitiesUsed; }
    localStorage.clear();
    localStorage.setItem('hotel-game-save', JSON.stringify({ version: 17, prngState: 1, state }));
    const loaded = loadGame()!;
    expect(loaded.version).toBe(20);
    expect(loaded.state.guests[0]).toMatchObject({ trip: null, facilitiesUsed: {} });
    expect(loaded.state.walkers).toEqual([]);
    expect(loaded.state.staffRoster).toBeUndefined();
    expect(loaded.state.staffPlan).toBeNull();
    localStorage.clear();
  });
});

describe('Upper floors', () => {
  it('a guest heading to an upstairs room rides the elevator, taking TRAVEL.hoursPerFloor per floor', () => {
    let s = buildFloor(rich(createStarterHotel()))!.state;
    s = buildFloor(s)!.state;
    s = addElevator(s, 0, 0)!;
    s = addRoom(s, 'standard', 3, 2, 2, 'up')!;
    const route = findRoute(s, { gridX: 0, gridY: 1, floor: 0 }, s.rooms[0], TRAVEL.guestHoursPerTile)!;
    const rides = route.path.filter((p, i) => i > 0 && p.floor !== route.path[i - 1].floor);
    expect(rides.length).toBeGreaterThan(0);
    const tiles = route.path.filter((p, i) => i > 0 && p.floor === route.path[i - 1].floor).length;
    expect(route.hours).toBeCloseTo(tiles * TRAVEL.guestHoursPerTile + 2 * TRAVEL.hoursPerFloor, 9);
  });
});

describe('Guests go out for the day', () => {
  /** Guests mid-stay (not leaving today), at an hour of the morning. */
  const midStay = (n: number, extra: Partial<HotelState>) => {
    const s = withGuests(n, extra);
    return { ...s, guests: s.guests.map(g => ({ ...g, checkInDay: s.day - 1, stayLength: 3 })) };
  };

  /** Plan with a higher chance of heading out, so tests don't hang on a few dice. */
  function withOutingChance<T>(chance: number, fn: () => T): T {
    const original = GUEST_OUTINGS.leaveChance;
    GUEST_OUTINGS.leaveChance = [[0, 24, chance]];
    try { return fn(); } finally { GUEST_OUTINGS.leaveChance = original; }
  }

  it('some guests head out in the morning: down to the street, out for a few hours, back up to their room', () => {
    const s = withOutingChance(0.6, () => planOutings(midStay(6, { hour: 9 })));
    const out = s.guests.filter(g => g.tripKind === 'outing');
    expect(out.length).toBeGreaterThan(0);
    for (const g of out) {
      const [walkOut, away, walkBack] = g.trip! as any[];
      expect([walkOut.kind, away.activity, walkBack.kind]).toEqual(['walk', 'away', 'walk']);
      expect(isEntranceTile(s, away.at)).toBe(true);
      expect(away.end - away.start).toBeGreaterThanOrEqual(1);
      expect(away.end - away.start).toBeLessThanOrEqual(GUEST_OUTINGS.maxHours + 1e-9);
      expect(legsEnd(g.trip!)).toBeLessThanOrEqual((s.day - 1) * 24 + GUEST_OUTINGS.latestReturnHour + 1e-9);
      const room = s.rooms.find(r => r.guestId === g.id)!;
      const end = positionAt(g.trip!, legsEnd(g.trip!))!;
      expect([end.x, end.y, end.floor]).toEqual([room.gridX, room.gridY, room.floor]);
      // Out of the building in between: away from the room, and not anywhere on the floor plan
      const mid = (away.start + away.end) / 2;
      expect(isGuestAway(g, mid)).toBe(true);
      expect((positionAt(g.trip!, mid)!.leg as any).activity).toBe('away');
    }
    expect(withOutingChance(0.6, () => planOutings(midStay(6, { hour: 9 }))).guests.map(g => g.trip)).toEqual(s.guests.map(g => g.trip)); // deterministic
  });

  it('nobody heads out on their last morning (they check out at 11:00), or while already out', () => {
    let s = midStay(4, { hour: 9 });
    s = { ...s, guests: s.guests.map((g, i) => (i < 2 ? { ...g, checkInDay: s.day - g.stayLength } : g)) };
    const planned = withOutingChance(1, () => planOutings(s));
    expect(planned.guests.slice(0, 2).every(g => !g.trip)).toBe(true);
    expect(planned.guests.slice(2).every(g => g.tripKind === 'outing')).toBe(true);
    expect(withOutingChance(1, () => planOutings({ ...planned, hour: 10 })).guests.map(g => g.trip)).toEqual(planned.guests.map(g => g.trip));
  });

  it('a guest whose street entrance is bulldozed while they are out comes back in by another', () => {
    let s: HotelState = midStay(1, { hour: 9 });
    s = addFixture(s, 'entrance', 9, 1, 0)!;
    s = withOutingChance(1, () => planOutings(s));
    const away = s.guests[0].trip![1] as any;
    const gone = demolishFixture(s, s.fixtures.find(f => f.type === 'entrance' && f.gridX === away.at.gridX && f.gridY === away.at.gridY)!.id)!;
    const t = (away.start + away.end) / 2;
    const trip = rerouteTrips(gone, t).guests[0].trip!;
    const stillAway = trip.find(l => l.kind === 'stay' && l.activity === 'away' && l.end > t) as any;
    expect(stillAway).toBeTruthy();
    expect(isEntranceTile(gone, stillAway.at)).toBe(true);
    expect(stillAway.end).toBeCloseTo(away.end, 9); // same time back
  });

  it('housekeeping does the daily clean in rooms whose guest is out first', () => {
    let s = withGuests(3, { hour: 12 });
    s = { ...s, staff: { ...s.staff, housekeepers: 1 }, rooms: s.rooms.map(r => ({ ...r, dailyCleanHoursRemaining: 0.5, cleanliness: r.gridX === 3 ? 10 : 60 })) };
    // The guest in the cleanest room is out; the others are in
    const outRoom = s.rooms.find(r => r.cleanliness === 60)!;
    const T = hourStart(s);
    s = { ...s, guests: s.guests.map(g => (g.id === outRoom.guestId ? { ...g, tripKind: 'outing' as const, trip: [makeStay({ gridX: 0, gridY: 4, floor: 0 }, T - 1, T + 4, 'away')] } : g)) };
    const plan = getStaffPlan(s);
    const firstClean = plan.itineraries[0].legs.find(l => l.kind === 'stay' && l.job === 'daily') as any;
    expect(firstClean.placeId).toBe(outRoom.id);
  });

  it('guests check out at 11:00: the tick at the end of hour 10', () => {
    let s = withGuests(1);
    s = { ...s, guests: [{ ...s.guests[0], checkInDay: s.day - 2, stayLength: 2 }] };
    expect(tickSimulation({ ...s, hour: 9 }, new PRNG(1)).state.guests).toHaveLength(1);
    const after = tickSimulation({ ...s, hour: 10 }, new PRNG(1)).state;
    expect(after.guests).toHaveLength(0);
    expect(after.hour).toBe(11);
    expect(after.walkers!.find(w => w.reason === 'checked_out')!.trip[0].start).toBe(hourStart(after));
  });
});
