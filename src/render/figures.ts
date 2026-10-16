import type { HotelState, Leg, Party, Purpose, StayLeg } from '../simulation/types';
import { isGuestAway } from '../simulation/GuestMovement';
import { memberPositionAt, legsEnd } from '../simulation/Movement';
import { partyOf, kidsIn } from '../simulation/Party';
import { quirkOf } from '../simulation/Profile';
import { spotlightOn } from '../simulation/Spotlight';
import type { Quirk } from './quirks';
import { GUEST_PROFILE, LOYALTY, PATIENCE } from '../config/balance';
import { seatOf, patienceHours } from '../simulation/DeskQueue';
import { moodHidden } from '../simulation/Voice';
import { tierOf, staysOf } from '../simulation/Loyalty';
import { guestMood, moodFace } from '../simulation/Mood';

/** The colour tier of a returning guest's ring (with loyalty off, they're all just returning). */
export function ringTierOf(stays: number): Figure['ringTier'] {
  const tier = LOYALTY.enabled ? tierOf(stays) : stays >= 2 ? 'returning' : 'first';
  return tier === 'first' ? undefined : tier;
}

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
  quirk?: Quirk; // a spotlight guest, a light sleeper, a rowdy guest or a big spender (on their first member)
  guestId?: string; // the booking they're part of (for picking a guest out with a click); none for people turned away
  opens?: string; // a visitor: the guest whose card a click on them opens (their host)
  ringTier?: 'returning' | 'regular' | 'vip'; // the ring's colour (on their first member)
  mood?: 'irritated' | 'angry'; // a face (on their first member)
  line?: { lane: string; seat: number; serving: boolean; turn: number; leaves?: true; deskX: number; deskY: number }; // in a front desk clerk's line (or at the counter); turn: when they get to the counter (leaves: they'll give up first, then)
  clock?: number; // standing in line: how much of their patience is used (0.5-1; on their first member)
  complaining?: boolean; // on their way to complain at the front desk (on their first member)
}

/** Whether member `index` of a party is a child (a family's members beyond the first two). */
export function isChild(party: Party, index: number): boolean {
  return index >= party.size - kidsIn(party);
}

/** Every member of a party on legs at time t (none while they're out of the building). */
export function partyFigures(id: string, party: Party, legs: Leg[], t: number, color: number, ring: boolean, extra: { quirk?: Quirk | null; guestId?: string; opens?: string; ringTier?: Figure['ringTier']; mood?: Figure['mood'] | null; desks?: Map<string, { x: number; y: number }>; patience?: number; complaining?: boolean } = {}): Figure[] {
  const figures: Figure[] = [];
  for (let m = 0; m < party.size; m++) {
    const at = memberPositionAt(legs, t, m);
    if (!at || (at.leg.kind === 'stay' && at.leg.activity === 'away')) continue;
    // In a front desk clerk's line, or at the counter: where they stand there is the renderer's to lay out
    const stay = at.leg.kind === 'stay' && at.leg.lane !== undefined ? at.leg : null;
    const desk = stay?.placeId ? extra.desks?.get(stay.placeId) : undefined;
    const turn = stay ? turnAt(legs, stay) : null;
    const line = stay && desk && turn ? { lane: stay.lane!, seat: seatOf(stay.lane!), serving: stay.activity !== 'wait', turn: turn.at, ...(turn.leaves ? { leaves: true as const } : {}), deskX: desk.x, deskY: desk.y } : undefined;
    const used = stay && stay.activity === 'wait' && extra.patience ? Math.min(1, (t - stay.start) / extra.patience) : 0;
    figures.push({
      id: m === 0 ? id : `${id}#${m}`, kind: 'guest', color, x: at.x, y: at.y, floor: at.floor, settled: !at.moving,
      ...(at.leg.kind === 'stay' ? { since: at.leg.start } : {}),
      ...(m === 0 && ring ? { ring: true } : {}), ...(isChild(party, m) ? { small: true } : {}),
      ...(m === 0 && extra.quirk ? { quirk: extra.quirk } : {}), ...(extra.guestId ? { guestId: extra.guestId } : {}), ...(extra.opens ? { opens: extra.opens } : {}),
      ...(m === 0 && ring && extra.ringTier ? { ringTier: extra.ringTier } : {}), ...(m === 0 && extra.mood ? { mood: extra.mood } : {}),
      ...(party.size > 1 ? { group: id, member: m } : {}),
      ...(line ? { line } : {}), ...(m === 0 && used >= PATIENCE.clockAt ? { clock: used } : {}),
      ...(m === 0 && extra.complaining ? { complaining: true } : {}),
    });
  }
  return figures;
}

/**
 * When someone in a clerk's line gets to the counter: their check-in or
 * complaint after the wait. Someone who'll give up first: not before they
 * leave (which is before it would have been their turn).
 */
function turnAt(legs: Leg[], stay: StayLeg): { at: number; leaves?: true } {
  if (stay.activity !== 'wait') return { at: stay.start };
  const served = legs.find(l => l.kind === 'stay' && l.activity !== 'wait' && l.lane === stay.lane && l.start >= stay.end - 1e-9);
  return served ? { at: served.start } : { at: stay.end, leaves: true };
}

/** Where each desk is (for laying out the line in front of it). */
function deskSpots(state: HotelState): Map<string, { x: number; y: number }> {
  return new Map(state.fixtures.filter(f => f.type === 'desk').map(f => [f.id, { x: f.gridX, y: f.gridY }]));
}

/** Whether a guest is on their way to complain at the desk (until they've had their say). */
function onWayToComplain(guest: { tripKind?: string; trip?: Leg[] | null }, t: number): boolean {
  if (guest.tripKind !== 'complaint' || !guest.trip) return false;
  const stay = guest.trip.find(l => l.kind === 'stay' && l.activity === 'complain');
  return !!stay && t < stay.end;
}

/**
 * Guests out of their rooms at time t -- arriving, at a facility, moving
 * rooms, back from town -- and people walking out, each party drawn as all
 * its members; and which guests are away from their rooms (not drawn there).
 */
export function guestFigures(state: HotelState, t: number): { figures: Figure[]; away: Set<string> } {
  const figures: Figure[] = [];
  const away = new Set<string>();
  const desks = deskSpots(state);
  for (const guest of state.guests) {
    const trip = guest.trip;
    if (!trip || trip.length === 0 || t >= legsEnd(trip)) continue;
    if (isGuestAway(guest, t)) away.add(guest.id); // arriving, or out: nobody in the room
    if (t < trip[0].start) continue; // not set out yet (or not here yet)
    figures.push(...partyFigures(guest.id, partyOf(guest), trip, t, getGuestDotColor(guest.purpose), guest.isReturning, {
      quirk: GUEST_PROFILE.enabled ? quirkOf(guest) : null, guestId: guest.id, ringTier: ringTierOf(staysOf(guest)),
      mood: moodHidden(guest) ? null : moodFace(guestMood(guest)), // (a stoic guest's mood doesn't show)
      desks, patience: guest.spotlight && spotlightOn() ? undefined : patienceHours(guest), complaining: onWayToComplain(guest, t), // (a spotlight guest is expected: no clock)
    }));
  }
  for (const walker of state.walkers ?? []) {
    if (walker.trip.length === 0 || t < walker.trip[0].start || t >= legsEnd(walker.trip)) continue;
    figures.push(...partyFigures(walker.id, partyOf(walker), walker.trip, t, getGuestDotColor(walker.purpose), walker.isReturning, {
      quirk: GUEST_PROFILE.enabled ? quirkOf(walker) : null, ...(walker.guestId ? { guestId: walker.guestId } : {}), ...(walker.hostId ? { opens: walker.hostId } : {}),
      ringTier: ringTierOf(walker.stays ?? (walker.isReturning ? 2 : 1)), mood: moodFace(walker.mood),
      desks, patience: patienceHours(walker),
    }));
  }
  return { figures, away };
}
