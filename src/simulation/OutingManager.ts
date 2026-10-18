import type { HotelState, Guest, Leg } from './types.js';
import { GUEST_OUTINGS, GUEST_FAVORITES, SPENDING, EVENT_GUESTS } from '../config/balance.js';
import { findRoute, routeToStreet } from './Layout.js';
import { hourStart, makeWalk, makeStay, isUnderway, hash01 } from './Movement.js';
import { roomTile } from './GuestMovement.js';
import { outingChanceMult, outingHours, facilityChanceMult } from './Purpose.js';
import { activityHour, activityOffset, guestPace } from './Profile.js';
import { isCheckoutDay } from './GuestManager.js';
import { isHosting, hostsTonight } from './Visitors.js';
import { spendingOn, spendingOf } from './Spending.js';

// Guests leave the building during the day -- sightseeing, meetings, the
// beach -- and come back later. Like facility visits, it's decided at each
// hour boundary for guests in their rooms, by a deterministic hash (never the
// shared PRNG), and it's a trip on the guest: down to the nearest street
// entrance, out of the building for a few hours (not drawn: they're in town),
// then back in and up to their room. While they're out their room is empty
// (no dot, and housekeeping does the daily clean first in empty rooms).

const LEAVE_SPREAD = 0.5; // guests set out over the first half of the hour

/** The chance a guest in their room heads out for the day during an hour of the day (business and sightseeing likelier, a getaway less; an early bird two hours earlier, a night owl two later). */
export function outingChance(guest: Pick<Guest, 'trait' | 'purpose' | 'profile'>, hour: number): number {
  if (guest.purpose === 'event') return hour >= EVENT_GUESTS.leaveHours[0] && hour < EVENT_GUESTS.leaveHours[1] ? EVENT_GUESTS.leaveChance : 0;
  const h = activityHour(guest, hour);
  const window = GUEST_OUTINGS.leaveChance.find(([from, to]) => h >= from && h < to);
  return window ? Math.min(1, window[2] * (GUEST_OUTINGS.traitMult[guest.trait] ?? 1) * outingChanceMult(guest)) : 0;
}

/**
 * An outing in place of a facility the hotel doesn't have: a swimmer off to
 * the beach, a foodie out to dinner (the hour starting now). Null if they
 * can't get out, or it's too late in the day.
 */
export function fallbackOuting(state: HotelState, guest: Guest, out: 'beach' | 'breakfast' | 'lunch' | 'dinner'): Leg[] | null {
  const room = state.rooms.find(r => r.guestId === guest.id && r.status === 'occupied');
  if (!room || isCheckoutDay(guest, state.day)) return null;
  const T = hourStart(state);
  const pace = guestPace(guest);
  const exit = routeToStreet(state, roomTile(room), pace);
  if (!exit || exit.path.length < 2) return null;
  const key = `${guest.id}|${state.day}|${state.hour}|fallback`;
  const leave = T + hash01(`${key}-leave`) * LEAVE_SPREAD;
  const outside = leave + exit.hours;
  const [min, max] = GUEST_FAVORITES.fallbackOutingHours;
  const length = min + hash01(`${key}-length`) * (max - min);
  const entrance = exit.path[exit.path.length - 1];
  const back = findRoute(state, entrance, roomTile(room), pace);
  if (!back) return null;
  // Dinner can run late; the beach is a daytime thing
  const latest = (state.day - 1) * 24 + (out === 'dinner' ? 23 : GUEST_OUTINGS.latestReturnHour) + activityOffset(guest);
  const returnAt = Math.min(outside + length, latest - back.hours);
  if (returnAt - outside < 1) return null;
  return [
    makeWalk(exit.path, leave, pace),
    makeStay(entrance, outside, returnAt, 'away', { out }),
    makeWalk(back.path, returnAt, pace),
  ];
}

/**
 * Send guests out for the day, for the hour starting now (call at the hour
 * boundary, with the state for the new hour, after facility visits are
 * planned so a guest isn't both).
 */
export function planOutings(state: HotelState, eventsOnly = false): HotelState {
  if (state.guests.length === 0) return state;
  const T = hourStart(state);
  const dayStart = (state.day - 1) * 24;
  let changed = false;
  const guests = state.guests.map(guest => {
    if (eventsOnly && guest.purpose !== 'event') return guest;
    if (isUnderway(guest.trip, T)) return guest; // arriving, or already out
    if (isCheckoutDay(guest, state.day)) return guest; // packing to leave
    if (isHosting(state, guest.id, T)) return guest; // friends round: staying in
    const p = outingChance(guest, state.hour);
    if (p <= 0 || hash01(`${guest.id}|${state.day}|${state.hour}|out`) >= p) return guest;
    const room = state.rooms.find(r => r.guestId === guest.id && r.status === 'occupied');
    if (!room) return guest;
    const pace = guestPace(guest);
    const dayEnd = dayStart + (guest.purpose === 'event' ? EVENT_GUESTS.latestReturnHour : GUEST_OUTINGS.latestReturnHour + activityOffset(guest));
    const out = routeToStreet(state, roomTile(room), pace);
    if (!out || out.path.length < 2) return guest;
    const leave = T + hash01(`${guest.id}|${state.day}|${state.hour}|leave`) * LEAVE_SPREAD;
    const outside = leave + out.hours;
    const hours = outingHours(guest); // a meeting runs till the evening; a getaway's stroll is short
    const length = hours.minHours + hash01(`${guest.id}|${state.day}|${state.hour}|length`) * (hours.maxHours - hours.minHours);
    const entrance = out.path[out.path.length - 1];
    const back = findRoute(state, entrance, roomTile(room), pace);
    if (!back) return guest;
    const returnAt = Math.min(outside + length, dayEnd - back.hours);
    if (returnAt - outside < 1) return guest; // too late in the day to bother
    const trip: Leg[] = [
      makeWalk(out.path, leave, pace),
      makeStay(entrance, outside, returnAt, 'away'),
      makeWalk(back.path, returnAt, pace),
    ];
    changed = true;
    return { ...guest, trip, tripKind: 'outing' as const };
  });
  return changed ? { ...state, guests } : state;
}

/**
 * Thrifty guests eat in town (docs/designs/guest-staff-personalities.md,
 * Spending style), for the hour starting now: in their evening (18:00-20:00
 * for a regular, two hours earlier for an early bird, two later for a night
 * owl), half the time, a thrifty guest in their room heads out to dinner and
 * is back in their room by 22:00 (shifted alike, so well before bed). Once a
 * day; not on their last day, nor the night they have friends round. Call
 * after facility visits are planned, before outings.
 */
export function planDinnersOut(state: HotelState): HotelState {
  if (!spendingOn() || state.guests.length === 0) return state;
  const T = hourStart(state);
  const dayStart = (state.day - 1) * 24;
  const { chance, hours: [from, to], length: [shortest, longest], minOutside, inRoomBy } = SPENDING.dinnerOut;
  let changed = false;
  const guests = state.guests.map(guest => {
    if (spendingOf(guest) !== 'thrifty') return guest;
    const h = activityHour(guest, state.hour);
    if (h < from || h >= to) return guest;
    if (guest.dinnersOut?.day === state.day) return guest; // once a day
    if (isUnderway(guest.trip, T) || isCheckoutDay(guest, state.day)) return guest;
    if (isHosting(state, guest.id, T) || hostsTonight(guest, state.day)) return guest; // friends coming round tonight
    const key = `${guest.id}|${state.day}|${state.hour}|dinner`;
    if (hash01(key) >= Math.min(1, chance * facilityChanceMult(guest, 'restaurant'))) return guest;
    const room = state.rooms.find(r => r.guestId === guest.id && r.status === 'occupied');
    if (!room) return guest;
    const pace = guestPace(guest);
    const exit = routeToStreet(state, roomTile(room), pace);
    if (!exit || exit.path.length < 2) return guest;
    const leave = T + hash01(`${key}-leave`) * LEAVE_SPREAD;
    const outside = leave + exit.hours;
    const entrance = exit.path[exit.path.length - 1];
    const back = findRoute(state, entrance, roomTile(room), pace);
    if (!back) return guest;
    const returnAt = Math.min(outside + shortest + hash01(`${key}-length`) * (longest - shortest), dayStart + inRoomBy + activityOffset(guest) - back.hours);
    if (returnAt - outside < minOutside) return guest; // too far from the street to make an evening of it
    changed = true;
    return {
      ...guest,
      trip: [makeWalk(exit.path, leave, pace), makeStay(entrance, outside, returnAt, 'away', { out: 'dinner' as const }), makeWalk(back.path, returnAt, pace)],
      tripKind: 'outing' as const,
      dinnersOut: { day: state.day, count: guest.dinnersOut?.count ?? 0 }, // (counted once they're out: creditDinnersOut)
    };
  });
  return changed ? { ...state, guests } : state;
}

/** Thrifty guests who got out to dinner this hour (call in the tick, T the end of the hour): counted, for their card. */
export function creditDinnersOut(state: HotelState, t: number): HotelState {
  if (!spendingOn()) return state;
  let changed = false;
  const guests = state.guests.map(g => {
    const i = g.trip ? g.trip.findIndex(l => l.kind === 'stay' && l.activity === 'away' && l.out === 'dinner' && !l.credited && l.start < t) : -1;
    if (i < 0 || spendingOf(g) !== 'thrifty') return g;
    changed = true;
    return { ...g, trip: g.trip!.map((l, k) => (k === i ? { ...l, credited: true } : l)), dinnersOut: { day: g.dinnersOut?.day ?? state.day, count: (g.dinnersOut?.count ?? 0) + 1 } };
  });
  return changed ? { ...state, guests } : state;
}
