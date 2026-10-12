import type { HotelState, Guest, Room, Leg, TilePos, Walker, Fixture, StayLeg } from './types.js';
import { DESK, STAFF, TRAVEL, GUEST_PROFILE } from '../config/balance.js';
import {
  findRoute, routeFromStreet, routeToStreet, getAccessibleDesks, getMannedDeskStaff, getFixtureFront, getEntranceTiles,
  getOpenFacilities, isEntranceTile, type Route,
} from './Layout.js';
import { makeWalk, makeStay, legsEnd, truncateLegs, walkProgress, stepStillOpen, sameTile, hash01 } from './Movement.js';
import { guestPace } from './Profile.js';

// Guests' comings and goings as trips the simulation plans when it decides
// them: walking in from the street and checking in at a staffed desk, heading
// out to a facility and back, moving rooms, and walking out at checkout. A
// trip starts at the hour boundary the decision was made at, so the guest is
// seen doing exactly what the simulation just did. Between trips a guest is in
// their room.


/** How long checking a guest in takes a front desk worker. */
export const CHECK_IN_HOURS = 1 / STAFF.frontDesk.checkInsPerHour;
const WAIT_IMPATIENT_HOURS = 0.3; // a guest who finds the desk swamped waits this long, then leaves
const INQUIRE_HOURS = 0.1; // a guest asking about rooms they won't take
const WALK_IN_SPREAD = 0.5; // walk-ins who don't check in come in over the first half of the hour

export const roomTile = (room: Pick<Room, 'gridX' | 'gridY' | 'floor' | 'door'>): TilePos =>
  ({ gridX: room.gridX, gridY: room.gridY, floor: room.floor, door: room.door });

const firstTile = (legs: Leg[]): TilePos => (legs[0].kind === 'stay' ? legs[0].at : legs[0].path[0]);

/** What a walker keeps of the guest they were: their party, purpose and profile (their colour, pace and quirk). */
function walkerFields(guest: Guest): Partial<Walker> {
  return { ...(guest.party ? { party: guest.party } : {}), ...(guest.purpose ? { purpose: guest.purpose } : {}), ...(guest.profile ? { profile: guest.profile } : {}) };
}

/** Where a guest is (the tile, door included) at time t: on their trip, or in their room. */
export function guestTileAt(state: HotelState, guest: Guest, t: number): TilePos | null {
  const room = state.rooms.find(r => r.guestId === guest.id);
  if (guest.trip && guest.trip.length > 0 && t < legsEnd(guest.trip)) {
    if (t <= guest.trip[0].start) return guest.tripKind === 'arrival' ? firstTile(guest.trip) : room ? roomTile(room) : firstTile(guest.trip);
    return truncateLegs(guest.trip, t).at;
  }
  return room ? roomTile(room) : null;
}

/**
 * Whether a guest is away from their room at time t: on the way in (an
 * arriving guest isn't in the building yet even before their walk starts), out
 * at a facility, or moving rooms. Someone about to set out is still in.
 */
export function isGuestAway(guest: Guest, t: number): boolean {
  const trip = guest.trip;
  if (!trip || trip.length === 0 || t >= legsEnd(trip)) return false;
  return guest.tripKind === 'arrival' || t >= trip[0].start;
}

/** Check-in lanes: one per front desk worker seated at a desk guests can reach, in seat order. */
export function checkInLanes(state: HotelState): Array<{ desk: Fixture; seat: number; front: TilePos }> {
  const lanes: Array<{ desk: Fixture; seat: number; front: TilePos }> = [];
  let manned = getMannedDeskStaff(state);
  for (const desk of getAccessibleDesks(state)) {
    const front = getFixtureFront(state, desk);
    for (let seat = 0; seat < DESK.staffPerDesk && manned > 0; seat++, manned--) {
      if (front) lanes.push({ desk, seat, front });
    }
  }
  return lanes;
}

/** A walk from one tile to another, going out to the street and back in if the two aren't connected inside (separate wings). */
function routeVia(state: HotelState, from: TilePos, to: TilePos, pace: number): Route | null {
  const direct = findRoute(state, from, to, pace);
  if (direct) return direct;
  const out = routeToStreet(state, from, pace);
  const back = routeFromStreet(state, to, pace);
  if (!out || !back) return null;
  return { path: [...out.path, ...back.path], hours: out.hours + back.hours };
}

/** Walk legs for a route that may leave the building and come back in elsewhere (the walk round outside isn't drawn). */
function walkLegs(route: Route, start: number, pace: number): Leg[] {
  const legs: Leg[] = [];
  let seg: TilePos[] = [route.path[0]];
  let t = start;
  for (let i = 1; i < route.path.length; i++) {
    const a = route.path[i - 1];
    const b = route.path[i];
    const adjacent = a.floor !== b.floor ? a.gridX === b.gridX && a.gridY === b.gridY : Math.abs(a.gridX - b.gridX) + Math.abs(a.gridY - b.gridY) <= 1;
    if (adjacent) {
      seg.push(b);
      continue;
    }
    if (seg.length > 1) {
      const w = makeWalk(seg, t, pace);
      legs.push(w);
      t = w.end;
    }
    seg = [b];
  }
  if (seg.length > 1) legs.push(makeWalk(seg, t, pace));
  return legs;
}

/**
 * Trips for this hour's arrivals, made at the hour boundary T they were
 * decided at: each guest who got a room walks in from the street to a staffed
 * check-in lane (one with a way to their room, if any has), waits their turn,
 * checks in (CHECK_IN_HOURS, one guest at a time per worker -- the capacity
 * the simulation allowed), then walks to their room. Guests who were turned
 * away or gave up on a swamped desk walk in, ask or wait, and walk out again.
 */
export function planArrivalTrips(
  state: HotelState,
  checkedIn: Array<{ guest: Guest; roomId: string }>,
  walkIns: Array<{ guest: Guest; outcome: 'impatient' | 'turned_away' }>,
  T: number,
): { trips: Map<string, Leg[]>; walkers: Walker[] } {
  const trips = new Map<string, Leg[]>();
  const walkers: Walker[] = [];
  const lanes = checkInLanes(state);
  const laneFree = lanes.map(() => T);
  const served = lanes.map(() => 0);
  // Each lane's check-ins start once the slowest walker could have got there
  // from the street, so they're spaced the same whoever walks in (and an hour's
  // last check-in never runs into the next hour's first)
  const slowest = GUEST_PROFILE.enabled ? GUEST_PROFILE.pace.limited : TRAVEL.guestHoursPerTile;
  const laneStart = lanes.map(l => T + (routeFromStreet(state, l.front, slowest)?.hours ?? 0));

  for (const { guest, roomId } of checkedIn) {
    const room = state.rooms.find(r => r.id === roomId);
    if (!room) continue;
    const legs: Leg[] = [];
    const pace = guestPace(guest);
    // The least busy lane, preferring ones with a way inside to the room
    const reaches = lanes.map(l => !!findRoute(state, l.front, roomTile(room), pace));
    const lane = lanes.map((_, i) => i).sort((a, b) => Number(reaches[b]) - Number(reaches[a]) || served[a] - served[b] || a - b)[0];
    if (lane !== undefined) {
      const { front, desk } = lanes[lane];
      const walkIn = routeFromStreet(state, front, pace);
      if (walkIn) {
        const slotStart = (GUEST_PROFILE.enabled ? laneStart[lane] - walkIn.hours : T) + served[lane] * CHECK_IN_HOURS;
        served[lane]++;
        const walk = makeWalk(walkIn.path, Math.max(T, GUEST_PROFILE.enabled ? slotStart : slotStart - walkIn.hours), pace);
        if (walk.path.length > 1) legs.push(walk);
        const serviceStart = Math.max(walk.end, laneFree[lane]);
        if (serviceStart > walk.end) legs.push(makeStay(front, walk.end, serviceStart, 'wait', { placeId: desk.id }));
        legs.push(makeStay(front, serviceStart, serviceStart + CHECK_IN_HOURS, 'check_in', { placeId: desk.id }));
        laneFree[lane] = serviceStart + CHECK_IN_HOURS;
        const toRoom = routeVia(state, front, roomTile(room), pace);
        if (toRoom) legs.push(...walkLegs(toRoom, serviceStart + CHECK_IN_HOURS, pace));
      }
    }
    if (legs.length === 0) {
      // No staffed desk to stop at: straight up to the room
      const route = routeFromStreet(state, roomTile(room), pace);
      if (route) legs.push(makeWalk(route.path, T, pace));
    }
    if (legs.length > 0) trips.set(guest.id, legs);
  }

  walkIns.forEach(({ guest, outcome }, i) => {
    const start = T + ((i + 1) / (walkIns.length + 1)) * WALK_IN_SPREAD;
    const spot = lanes.length > 0 ? lanes[i % lanes.length].front : getAccessibleDesks(state).map(d => getFixtureFront(state, d)).find(Boolean) ?? getEntranceTiles(state)[0];
    if (!spot) return;
    const legs: Leg[] = [];
    const pace = guestPace(guest);
    const walkIn = routeFromStreet(state, spot, pace);
    let t = start;
    if (walkIn && walkIn.path.length > 1) {
      const walk = makeWalk(walkIn.path, t, pace);
      legs.push(walk);
      t = walk.end;
    }
    const linger = outcome === 'impatient' ? WAIT_IMPATIENT_HOURS : INQUIRE_HOURS;
    legs.push(makeStay(spot, t, t + linger, outcome === 'impatient' ? 'wait' : 'inquire'));
    t += linger;
    const out = routeToStreet(state, spot, pace);
    if (out && out.path.length > 1) legs.push(makeWalk(out.path, t, pace));
    walkers.push({ id: `walkin-${guest.id}-${T}`, trait: guest.trait, isReturning: guest.isReturning, reason: outcome, trip: legs, ...walkerFields(guest) });
  });

  return { trips, walkers };
}

/**
 * A guest leaving the building at time T -- checked out, or walking out early
 * -- from wherever they are (usually their room; maybe the gym) to the
 * nearest street entrance. Null if they're walled in.
 */
export function departureWalker(state: HotelState, guest: Guest, T: number, reason: Walker['reason']): Walker | null {
  const from = guestTileAt(state, guest, T);
  if (!from) return null;
  const pace = guestPace(guest);
  const route = routeToStreet(state, from, pace);
  if (!route || route.path.length < 2) return null;
  return { id: `leave-${guest.id}-${T}`, trait: guest.trait, isReturning: guest.isReturning, reason, trip: [makeWalk(route.path, T, pace)], ...walkerFields(guest), guestId: guest.id, name: guest.name };
}

/** A guest moving rooms at time T (after a breakdown): from where they are to the new room (round by the street if need be). */
export function roomMoveTrip(state: HotelState, guest: Guest, to: Room, T: number): Leg[] | null {
  const from = guestTileAt(state, guest, T);
  if (!from) return null;
  const pace = guestPace(guest);
  const route = routeVia(state, from, roomTile(to), pace);
  return route && route.path.length > 1 ? walkLegs(route, T, pace) : null;
}

/** Drop walkers who have left the building by time t, and finished trips. */
export function tidyMovement(state: HotelState, t: number): HotelState {
  const walkers = (state.walkers ?? []).filter(w => legsEnd(w.trip) > t);
  let changed = walkers.length !== (state.walkers ?? []).length;
  const guests = state.guests.map(g => {
    if (g.trip && legsEnd(g.trip) <= t) {
      changed = true;
      return { ...g, trip: null, tripKind: undefined };
    }
    return g;
  });
  return changed ? { ...state, walkers, guests } : state;
}

/** Whether a stop still makes sense: a desk still staffed there, a facility still open, through the same door. */
function stayStillValid(state: HotelState, stay: StayLeg): boolean {
  if ((stay.activity === 'check_in' || stay.activity === 'wait') && stay.placeId) {
    return checkInLanes(state).some(l => l.desk.id === stay.placeId && sameTile(l.front, stay.at));
  }
  if (stay.activity === 'visit') return getOpenFacilities(state).some(f => f.id === stay.placeId && f.door === stay.at.door);
  if (stay.activity === 'away') return isEntranceTile(state, stay.at); // out through a street entrance
  return true;
}

/**
 * Whether what's left of a trip after t still works in the building as it is
 * now: every step still ahead can be taken (hallway still hallway, doors on
 * the same side, elevators still there), the places it stops at still make
 * sense, and a trip in off the street still starts at a street entrance.
 */
export function tripStillWalkable(state: HotelState, legs: Leg[], t: number, fromStreet = false): boolean {
  if (fromStreet && legs.length > 0 && t <= legs[0].start && !isEntranceTile(state, firstTile(legs))) return false;
  for (const leg of legs) {
    if (leg.end <= t) continue;
    if (leg.kind === 'stay') {
      if (!stayStillValid(state, leg)) return false;
      continue;
    }
    const from = t > leg.start ? walkProgress(leg, t).index : 0;
    for (let i = from + 1; i < leg.path.length; i++) {
      if (!stepStillOpen(state, leg.path[i - 1], leg.path[i])) return false;
    }
  }
  return true;
}

/**
 * Carry on with a trip from time t in the building as it now is: keep what's
 * been done, head for each stop still ahead that still makes sense (a desk to
 * check in at, a facility to visit) and finally the destination -- the
 * guest's room, or the street for someone leaving. A trip that hasn't begun
 * starts as planned, from the street (arrivals) or the room (visits).
 */
function continueTrip(state: HotelState, legs: Leg[], t: number, destination: TilePos | 'street', fromStreetTrip: boolean, pace: number): Leg[] {
  const notStarted = legs.length > 0 && t <= legs[0].start;
  const cut = notStarted ? { legs: [] as Leg[], at: firstTile(legs), time: legs[0].start } : truncateLegs(legs, t);
  const out: Leg[] = [...cut.legs];
  let pos: TilePos | null = cut.at;
  let time = Math.max(t, cut.time);
  let fromStreet = notStarted && fromStreetTrip;
  // Stood still between the step they'd reached and now: say so, so the trip has no holes
  const lastEnd = legsEnd(out);
  if (pos && out.length > 0 && time > lastEnd + 1e-12) out.push(makeStay(pos, lastEnd, time, 'wait'));

  const goTo = (target: TilePos): boolean => {
    if (!fromStreet && pos && sameTile(pos, target)) return true;
    const route = fromStreet ? routeFromStreet(state, target, pace) : pos ? routeVia(state, pos, target, pace) : null;
    if (!route) return false;
    const walk = walkLegs(route, time, pace);
    out.push(...walk);
    if (walk.length > 0) time = legsEnd(walk);
    pos = target;
    fromStreet = false;
    return true;
  };

  for (const original of legs) {
    let leg = original;
    // Out in town and their entrance is gone: they come back in by another
    if (leg.kind === 'stay' && leg.activity === 'away' && leg.end > t && !isEntranceTile(state, leg.at)) {
      const exit = pos ? routeToStreet(state, pos, pace) : null;
      if (!exit) continue;
      leg = { ...leg, at: exit.path[exit.path.length - 1] };
    }
    if (leg.kind !== 'stay' || leg.end <= t || !stayStillValid(state, leg)) continue;
    if (leg.activity === 'away' && !notStarted && leg.start < t) {
      // Already out in town: they come back in by this entrance at the same time
      pos = leg.at;
      out.push({ ...leg, start: time, end: leg.end });
      time = leg.end;
      continue;
    }
    const ongoing = !notStarted && leg.start < t && pos !== null && sameTile(pos, leg.at);
    if (!goTo(leg.at)) continue;
    const length = ongoing ? leg.end - t : leg.end - leg.start;
    const start = Math.max(time, leg.start);
    if (start > time && leg.activity === 'check_in') out.push(makeStay(leg.at, time, start, 'wait', { placeId: leg.placeId }));
    const begin = leg.activity === 'check_in' ? start : time;
    out.push({ ...leg, start: begin, end: begin + length });
    time = begin + length;
  }
  if (destination === 'street') {
    if (pos) {
      const route = routeToStreet(state, pos, pace);
      if (route && route.path.length > 1) out.push(makeWalk(route.path, time, pace));
    }
  } else {
    goTo(destination);
  }
  return out;
}

/**
 * After the player changes the building mid-hour (or the front desk), send
 * anyone whose trip no longer works a new way from where they are, keeping
 * the stops that still make sense.
 */
export function rerouteTrips(state: HotelState, t: number): HotelState {
  let changed = false;
  const guests = state.guests.map(g => {
    const arriving = g.tripKind === 'arrival';
    if (!g.trip || g.trip.length === 0 || t >= legsEnd(g.trip) || tripStillWalkable(state, g.trip, t, arriving)) return g;
    const room = state.rooms.find(r => r.guestId === g.id);
    if (!room) return g;
    changed = true;
    const trip = continueTrip(state, g.trip, t, roomTile(room), arriving, guestPace(g));
    return { ...g, trip: trip.length > 0 ? trip : null, tripKind: trip.length > 0 ? g.tripKind : undefined };
  });
  const walkers = (state.walkers ?? []).map(w => {
    const end = w.trip[w.trip.length - 1];
    const exitsByEntrance = !!end && end.kind === 'walk' && isEntranceTile(state, end.path[end.path.length - 1]);
    const walkIn = w.reason === 'turned_away' || w.reason === 'impatient';
    if (w.trip.length === 0 || t >= legsEnd(w.trip) || (exitsByEntrance && tripStillWalkable(state, w.trip, t, walkIn))) return w;
    changed = true;
    return { ...w, trip: continueTrip(state, w.trip, t, 'street', walkIn, guestPace(w)) };
  });
  return changed ? { ...state, guests, walkers } : state;
}

/** A small deterministic delay (hours, < max) for spreading people out, without the shared PRNG. */
export function stagger(id: string, max: number): number {
  return hash01(id) * max;
}
