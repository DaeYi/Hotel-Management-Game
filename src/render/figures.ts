import type { HotelState, Leg, Party, Purpose } from '../simulation/types';
import { isGuestAway } from '../simulation/GuestMovement';
import { memberPositionAt, legsEnd } from '../simulation/Movement';
import { partyOf, kidsIn } from '../simulation/Party';
import { quirkOf } from '../simulation/Profile';
import { GUEST_PROFILE } from '../config/balance';

// Who is drawn where, without drawing anything (no Phaser here, so the tests
// can check it): every member of every party on a trip or walking out, at
// the positions the simulation's itineraries give them. ActorLayer draws
// these; the guests settled in their rooms are drawn by GridRenderer.

/** Guest dot colours by why they're here (the legend shows them): unlike any staff or facility colour, and apart in brightness too. */
export const PURPOSE_COLORS: Record<Purpose, number> = {
  business: 0x5d6d7e, // slate: a suit
  sightseeing: 0xf4d03f, // yellow: a sun hat
  getaway: 0xf1948a, // rose
};
export const NO_PURPOSE_COLOR = 0xecf0f1; // a guest from before purposes (or with purposes off)

/** Guest dot colour, by purpose. */
export function getGuestDotColor(purpose: Purpose | undefined): number {
  return purpose ? PURPOSE_COLORS[purpose] : NO_PURPOSE_COLOR;
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
  quirk?: 'moon' | 'note'; // a light sleeper or a rowdy guest (on their first member)
  guestId?: string; // the booking they're part of (for picking a guest out with a click); none for people turned away
}

/** Whether member `index` of a party is a child (a family's members beyond the first two). */
export function isChild(party: Party, index: number): boolean {
  return index >= party.size - kidsIn(party);
}

/** Every member of a party on legs at time t (none while they're out of the building). */
export function partyFigures(id: string, party: Party, legs: Leg[], t: number, color: number, ring: boolean, extra: { quirk?: 'moon' | 'note' | null; guestId?: string } = {}): Figure[] {
  const figures: Figure[] = [];
  for (let m = 0; m < party.size; m++) {
    const at = memberPositionAt(legs, t, m);
    if (!at || (at.leg.kind === 'stay' && at.leg.activity === 'away')) continue;
    figures.push({
      id: m === 0 ? id : `${id}#${m}`, kind: 'guest', color, x: at.x, y: at.y, floor: at.floor, settled: !at.moving,
      ...(at.leg.kind === 'stay' ? { since: at.leg.start } : {}),
      ...(m === 0 && ring ? { ring: true } : {}), ...(isChild(party, m) ? { small: true } : {}),
      ...(m === 0 && extra.quirk ? { quirk: extra.quirk } : {}), ...(extra.guestId ? { guestId: extra.guestId } : {}),
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
    figures.push(...partyFigures(guest.id, partyOf(guest), trip, t, getGuestDotColor(guest.purpose), guest.isReturning, { quirk: GUEST_PROFILE.enabled ? quirkOf(guest) : null, guestId: guest.id }));
  }
  for (const walker of state.walkers ?? []) {
    if (walker.trip.length === 0 || t < walker.trip[0].start || t >= legsEnd(walker.trip)) continue;
    figures.push(...partyFigures(walker.id, partyOf(walker), walker.trip, t, getGuestDotColor(walker.purpose), walker.isReturning, { quirk: GUEST_PROFILE.enabled ? quirkOf(walker) : null, ...(walker.guestId ? { guestId: walker.guestId } : {}) }));
  }
  return { figures, away };
}
