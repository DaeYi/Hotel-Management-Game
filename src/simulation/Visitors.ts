import type { Guest, HotelState, StayLeg, VisitorPolicy, Walker } from './types.js';
import { hash01 } from './Movement.js';
import { isSleepHour } from './Profile.js';
import { partySize } from './Party.js';
import { HOSTED_NIGHTS } from '../config/balance.js';

// Hosted nights (docs/designs/guest-staff-personalities.md, Rowdiness): on one
// night of their stay, half of rowdy guests have friends round. The visitors are
// walkers (reason 'visitor', with the host's id): in from the street, a stay
// in the host's room, and out again -- so where they're drawn is where the
// noise is. This file answers the questions the noise, the planners and the
// renderer ask (who's in, who's hosting, who's asleep); HostedNights.ts plans
// the visits, takes complaints and asks visitors to leave.

/** What the front desk does when a neighbour complains about visitors (absent: asks them to leave). */
export function visitorPolicy(state: Pick<HotelState, 'visitorPolicy'>): VisitorPolicy {
  return state.visitorPolicy ?? 'ask';
}

/** A visitor's stay in their host's room (if they've one still on their trip). */
export function inRoomStay(walker: Walker): StayLeg | undefined {
  return walker.trip.find((l): l is StayLeg => l.kind === 'stay' && l.activity === 'in_room');
}

const byHostCache = new WeakMap<Walker[], Map<string, Walker[]>>();

/** The visitors who've come to see a guest (walking in, in the room, or on their way out). */
export function visitorsOf(state: Pick<HotelState, 'walkers'>, hostId: string): Walker[] {
  const walkers = state.walkers;
  if (!walkers || walkers.length === 0) return [];
  let byHost = byHostCache.get(walkers);
  if (!byHost) {
    byHost = new Map();
    for (const w of walkers) {
      if (w.reason !== 'visitor' || !w.hostId) continue;
      byHost.set(w.hostId, [...(byHost.get(w.hostId) ?? []), w]);
    }
    byHostCache.set(walkers, byHost);
  }
  return byHost.get(hostId) ?? [];
}

/** "the visitor" or "the visitors". */
export function theVisitors(count: number): string {
  return count === 1 ? 'the visitor' : 'the visitors';
}

/** How many people have come to see a guest (walking in, in the room, or on their way out). */
export function visitorCount(state: Pick<HotelState, 'walkers'>, hostId: string): number {
  return visitorsOf(state, hostId).reduce((sum, w) => sum + partySize(w), 0);
}

/** How many visitors are in a guest's room at time t (0 for nobody). */
export function visitorsAt(state: Pick<HotelState, 'walkers'>, hostId: string, t: number): number {
  let n = 0;
  for (const w of visitorsOf(state, hostId)) {
    const stay = inRoomStay(w);
    if (stay && stay.start <= t && t < stay.end) n += partySize(w);
  }
  return n;
}

/** Whether a guest has visitors in their room, or on the way up, after time t: they stay in for them. */
export function isHosting(state: Pick<HotelState, 'walkers'>, hostId: string, t: number): boolean {
  return visitorsOf(state, hostId).some(w => (inRoomStay(w)?.end ?? -Infinity) > t);
}

/** Whether a guest is asleep at time t (if they're in): in their sleep hours, unless they've visitors in. */
export function isAsleepAt(state: Pick<HotelState, 'walkers'>, guest: Pick<Guest, 'id' | 'profile'>, t: number): boolean {
  const hour = ((Math.floor(t) % 24) + 24) % 24;
  return isSleepHour(guest, hour) && visitorsAt(state, guest.id, t) === 0;
}

/** The day whose night a rowdy guest has friends round: half of them, one night of their stay, from their booking (null for anyone else). */
export function hostingDay(guest: Pick<Guest, 'id' | 'profile' | 'checkInDay' | 'stayLength'>): number | null {
  if (guest.profile?.rowdiness !== 'rowdy' || hash01(`${guest.id}#hosts`) >= HOSTED_NIGHTS.hostShare) return null;
  return guest.checkInDay + Math.floor(hash01(`${guest.id}#hosted`) * guest.stayLength);
}
