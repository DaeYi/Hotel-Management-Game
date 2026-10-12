import type { Guest, HousekeepingPreference, Leg, Room } from './types.js';
import { GUEST_HOUSEKEEPING, HOUSEKEEPING } from '../config/balance.js';
import { legsEnd, sameTile } from './Movement.js';
import { stepHours } from './Layout.js';

// Housekeeping preference (docs/designs/guest-staff-personalities.md, Tastes
// #11): when a guest wants their room cleaned. Do not disturb: a housekeeper
// goes in only while the whole party is out (their trip says when), so a guest
// who never leaves gets no daily clean. Make up daily: cleaned every day, even
// on an every-other-day cadence, before the other daily cleans, and they mind
// how clean the room is 1.6x as much. Standard: as the hotel does it. A hanger
// on the door says which. With the switch off (or a guest without the roll),
// everyone is standard.

/** When a guest wants their room cleaned (standard without a roll, or with the switch off). */
export function housekeepingPrefOf(guest: Pick<Guest, 'profile'> | undefined): HousekeepingPreference {
  if (!GUEST_HOUSEKEEPING.enabled) return 'standard';
  return guest?.profile?.housekeeping ?? 'standard';
}

/**
 * What a room's cleanliness does to a guest's review (and mood): the usual
 * term, and for a guest who wants the room made up daily, 1.6x as much either
 * side of what a well-kept room is a night on -- so it costs them when a clean
 * is missed, and barely moves otherwise.
 */
export function cleanlinessTerm(cleanliness: number, guest: Pick<Guest, 'profile'>): number {
  const base = (cleanliness - HOUSEKEEPING.cleanlinessMidpoint) / HOUSEKEEPING.cleanlinessScale * HOUSEKEEPING.cleanlinessWeight;
  if (housekeepingPrefOf(guest) !== 'makeup') return base;
  return base + (cleanliness - GUEST_HOUSEKEEPING.makeupExpects) / HOUSEKEEPING.cleanlinessScale * HOUSEKEEPING.cleanlinessWeight * (GUEST_HOUSEKEEPING.makeupWeight - 1);
}

const roomTileOf = (room: Pick<Room, 'gridX' | 'gridY' | 'floor'>) => ({ gridX: room.gridX, gridY: room.gridY, floor: room.floor });

/**
 * The stretches of a trip when someone in the party may be on the room's
 * tile: a stop there, and every step into or out of it, whole. The rest of
 * the party walks ahead of the guest whose legs they are (Movement.
 * memberPositionAt), so they leave no later than the guest and come back in
 * no sooner than the guest starts the last step in.
 */
function inRoomStretches(legs: Leg[], room: Pick<Room, 'gridX' | 'gridY' | 'floor'>): Array<[number, number]> {
  const tile = roomTileOf(room);
  const stretches: Array<[number, number]> = [];
  for (const leg of legs) {
    if (leg.kind === 'stay') {
      if (sameTile(leg.at, tile)) stretches.push([leg.start, leg.end]);
      continue;
    }
    let time = leg.start;
    for (let i = 0; i < leg.path.length; i++) {
      const into = i > 0 ? stepHours(leg.path[i - 1], leg.path[i], leg.hoursPerTile) : 0;
      if (i > 0) time += into;
      if (!sameTile(leg.path[i], tile)) continue;
      const out = i < leg.path.length - 1 ? stepHours(leg.path[i], leg.path[i + 1], leg.hoursPerTile) : 0;
      stretches.push([time - into, time + out]);
    }
  }
  return stretches;
}

/**
 * The stretches of time when a guest's whole party is out of their room, on
 * the trip they're on: from when the last of them has stepped out to when the
 * first steps back in. Nothing without a trip (they're in). An arriving guest
 * is out until they get there.
 */
export function awayStretches(guest: Pick<Guest, 'trip' | 'tripKind'>, room: Pick<Room, 'gridX' | 'gridY' | 'floor'>): Array<[number, number]> {
  const trip = guest.trip;
  if (!trip || trip.length === 0) return [];
  const start = guest.tripKind === 'arrival' ? -Infinity : trip[0].start;
  const end = legsEnd(trip);
  const away: Array<[number, number]> = [];
  let from = start;
  for (const [a, b] of inRoomStretches(trip, room).sort((x, y) => x[0] - y[0])) {
    if (a > from) away.push([from, Math.min(a, end)]);
    from = Math.max(from, b);
  }
  if (end > from) away.push([from, end]);
  return away.filter(([a, b]) => b > a + 1e-9);
}

/** Whether a guest's whole party is out of their room for all of [a, b]. */
export function partyOutOfRoom(guest: Pick<Guest, 'trip' | 'tripKind'>, room: Pick<Room, 'gridX' | 'gridY' | 'floor'>, a: number, b: number): boolean {
  return awayStretches(guest, room).some(([from, to]) => from <= a + 1e-9 && b <= to + 1e-9);
}

/**
 * When a housekeeper arriving at time `arrive` could start a do-not-disturb
 * room's clean of `hours`: once the party is out (waiting at the door up to
 * `maxWait` for them to finish leaving), if they stay out till it's done.
 * Null if they won't.
 */
export function dndCleanStart(guest: Pick<Guest, 'trip' | 'tripKind'>, room: Pick<Room, 'gridX' | 'gridY' | 'floor'>, arrive: number, hours: number, maxWait = GUEST_HOUSEKEEPING.dndMaxWait): number | null {
  for (const [from, to] of awayStretches(guest, room)) {
    const start = Math.max(arrive, from);
    if (start - arrive <= maxWait + 1e-9 && start + hours <= to + 1e-9) return start;
  }
  return null;
}

/**
 * When a housekeeper `travel` hours from a do-not-disturb room's door should
 * set off to get there just as the party is out (for a clean of `hours`,
 * stepping in included): the soonest such moment after `now` and before
 * `until`. Null if none.
 */
export function dndSetOff(guest: Pick<Guest, 'trip' | 'tripKind'>, room: Pick<Room, 'gridX' | 'gridY' | 'floor'>, now: number, travel: number, hours: number, until: number): number | null {
  let best: number | null = null;
  for (const [from, to] of awayStretches(guest, room)) {
    const setOff = from - travel;
    if (setOff <= now + 1e-9 || setOff >= until || from + hours > to + 1e-9) continue;
    if (best === null || setOff < best) best = setOff;
  }
  return best;
}

/**
 * Whether a do-not-disturb room could be cleaned at some point in [from,
 * until) -- the party is out long enough, starting in that time -- and when
 * that chance ends (for putting the soonest-closing first). Null if it can't.
 */
export function dndOpening(guest: Pick<Guest, 'trip' | 'tripKind'>, room: Pick<Room, 'gridX' | 'gridY' | 'floor'>, from: number, until: number, hours: number): number | null {
  for (const [a, b] of awayStretches(guest, room)) {
    const start = Math.max(a, from);
    if (start < until && start + hours <= b + 1e-9) return b;
  }
  return null;
}

const PREF_TEXT: Record<HousekeepingPreference, string> = {
  dnd: 'Do not disturb (cleaned only while out)',
  standard: '',
  makeup: 'Wants the room made up daily',
};

/** A guest's housekeeping wishes and how they've gone, for their card: "Do not disturb (cleaned only while out): cleaned 1 of 2 days". Null for a standard guest. */
export function describeHousekeeping(guest: Pick<Guest, 'profile' | 'cleans'>): string | null {
  const pref = housekeepingPrefOf(guest);
  if (pref === 'standard') return null;
  const done = guest.cleans?.done ?? 0;
  const days = done + (guest.cleans?.missed ?? 0);
  return days > 0 ? `${PREF_TEXT[pref]}: cleaned ${done} of ${days} day${days === 1 ? '' : 's'}` : PREF_TEXT[pref];
}
