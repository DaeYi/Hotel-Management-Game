import type { FacilityType, Guest, Party, Purpose } from './types.js';
import { GUEST_OUTINGS, GUEST_PURPOSES } from '../config/balance.js';
import { hash01 } from './Movement.js';
import { describeParty, pick } from './Party.js';

// Why a booking is here (docs/designs/guest-preferences.md): on business, to
// see the sights, or to get away. It follows from the party -- a business
// party is on business, families never are -- so who books is exactly as
// before; it's rolled from the booking's id with hash01, never the shared
// random stream. It decides when guests go out and for how long, which
// facilities they use, and (Preferences.ts) what they like in a room. A
// booking without one (an older save, or purposes off) does what every guest
// did before.

export const PURPOSES: Purpose[] = ['business', 'sightseeing', 'getaway'];

/** A purpose, as a label: "Business". */
export const PURPOSE_LABELS: Record<Purpose, string> = { business: 'Business', sightseeing: 'Sightseeing', getaway: 'Getaway' };

/** Guests with a purpose, as a group: "business travellers". */
export const PURPOSE_GROUPS: Record<Purpose, string> = { business: 'business travellers', sightseeing: 'sightseers', getaway: 'guests on a getaway' };

/** Why a booking is here, from its id and its party (none if purposes are off). */
export function rollPurpose(id: string, party: Party): Purpose | undefined {
  if (!GUEST_PURPOSES.enabled) return undefined;
  return pick(GUEST_PURPOSES.byParty[party.kind], hash01(`${id}#purpose`));
}

/** A booking's purpose (none for bookings from before purposes). */
export function purposeOf(guest: Pick<Guest, 'purpose'> | null | undefined): Purpose | undefined {
  return guest?.purpose;
}

/** Who a booking is, in a few words: "a business traveller", "a couple on a getaway", "a family of four sightseeing". */
export function describeGuest(party: Party, purpose: Purpose | undefined): string {
  if (purpose === 'business') return party.size === 1 ? 'a business traveller' : `${describeParty(party)} on business`;
  if (purpose === 'sightseeing') return `${describeParty(party)} sightseeing`;
  if (purpose === 'getaway') return `${describeParty(party)} on a getaway`;
  return describeParty(party);
}

/** How much likelier a guest is than most to go out for the day. */
export function outingChanceMult(guest: Pick<Guest, 'purpose'>): number {
  return guest.purpose ? GUEST_PURPOSES.outing[guest.purpose].chanceMult : 1;
}

/** How long a guest stays out when they go out for the day. */
export function outingHours(guest: Pick<Guest, 'purpose'>): { minHours: number; maxHours: number } {
  return guest.purpose ? GUEST_PURPOSES.outing[guest.purpose] : GUEST_OUTINGS;
}

/** How much likelier a guest is than most to use a type of facility. */
export function facilityChanceMult(guest: Pick<Guest, 'purpose'>, type: FacilityType): number {
  return guest.purpose ? GUEST_PURPOSES.facility[guest.purpose][type] : 1;
}

/** Who uses a type of facility most: "business travellers" at the gym. */
export function popularWith(type: FacilityType): string[] {
  if (!GUEST_PURPOSES.enabled) return [];
  return PURPOSES.filter(p => GUEST_PURPOSES.facility[p][type] >= 1.3).map(p => PURPOSE_GROUPS[p]);
}

/** Where a guest is when they're out of the building: "out at a meeting", "out sightseeing". */
export function awayActivity(guest: Pick<Guest, 'purpose'>): string {
  switch (guest.purpose) {
    case 'business': return 'out at a meeting';
    case 'sightseeing': return 'out sightseeing';
    case 'getaway': return 'out for a stroll';
    default: return 'out for the day';
  }
}
