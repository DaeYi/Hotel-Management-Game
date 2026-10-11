import type { HotelState, GuestTrait, Leg, Party } from '../simulation/types';
import { isGuestAway } from '../simulation/GuestMovement';
import { memberPositionAt, legsEnd } from '../simulation/Movement';
import { partyOf, kidsIn } from '../simulation/Party';
import { TRAVEL } from '../config/balance';

// Who is drawn where, without drawing anything (no Phaser here, so the tests
// can check it): every member of every party on a trip or walking out, at
// the positions the simulation's itineraries give them. ActorLayer draws
// these; the guests settled in their rooms are drawn by GridRenderer.

/** Guest dot color by trait, in one place so every trait gets an explicit, distinct color. */
export function getGuestDotColor(trait: GuestTrait): number {
  switch (trait) {
    case 'light_sleeper': return 0x3498db;
    case 'big_spender': return 0xe74c3c;
    case 'party_guest': return 0xe91e63;
    case 'normal': return 0xecf0f1;
  }
}

export interface Figure {
  id: string; // a person: the booking's id for its first member, `${id}#${n}` for the others
  kind: 'guest' | 'staff';
  color: number;
  x: number; // continuous tile coordinates
  y: number;
  floor: number;
  settled: boolean; // standing or sitting at a place (seated with others) rather than walking
  ring?: boolean; // a returning guest (on their first member)
  small?: boolean; // a child
  group?: string; // the party they're with (they sit together)
  member?: number; // which member of it
  since?: number; // when they stopped where they are (people already seated keep their seats)
}

/** Whether member `index` of a party is a child (a family's members beyond the first two). */
export function isChild(party: Party, index: number): boolean {
  return index >= party.size - kidsIn(party);
}

/** Every member of a party on legs at time t (none while they're out of the building). */
export function partyFigures(id: string, party: Party, legs: Leg[], t: number, color: number, ring: boolean): Figure[] {
  const figures: Figure[] = [];
  for (let m = 0; m < party.size; m++) {
    const at = memberPositionAt(legs, t, m, TRAVEL.guestHoursPerTile);
    if (!at || (at.leg.kind === 'stay' && at.leg.activity === 'away')) continue;
    figures.push({
      id: m === 0 ? id : `${id}#${m}`, kind: 'guest', color, x: at.x, y: at.y, floor: at.floor, settled: !at.moving,
      ...(at.leg.kind === 'stay' ? { since: at.leg.start } : {}),
      ...(m === 0 && ring ? { ring: true } : {}), ...(isChild(party, m) ? { small: true } : {}),
      ...(party.size > 1 ? { group: id, member: m } : {}),
    });
  }
  return figures;
}

/**
 * Guests out of their rooms at time t -- arriving, at a facility, moving
 * rooms, back from town -- and people walking out, each party drawn as all
 * its members; and which guests are away from their rooms (not drawn there).
 */
export function guestFigures(state: HotelState, t: number): { figures: Figure[]; away: Set<string> } {
  const figures: Figure[] = [];
  const away = new Set<string>();
  for (const guest of state.guests) {
    const trip = guest.trip;
    if (!trip || trip.length === 0 || t >= legsEnd(trip)) continue;
    if (isGuestAway(guest, t)) away.add(guest.id); // arriving, or out: nobody in the room
    if (t < trip[0].start) continue; // not set out yet (or not here yet)
    figures.push(...partyFigures(guest.id, partyOf(guest), trip, t, getGuestDotColor(guest.trait), guest.isReturning));
  }
  for (const walker of state.walkers ?? []) {
    if (walker.trip.length === 0 || t < walker.trip[0].start || t >= legsEnd(walker.trip)) continue;
    figures.push(...partyFigures(walker.id, partyOf(walker), walker.trip, t, getGuestDotColor(walker.trait), walker.isReturning));
  }
  return { figures, away };
}
