import type { Guest, ReturningGuestProfile, Room } from './types.js';
import { LOYALTY, SATISFACTION, STORY, SPOTLIGHT, GUEST_PROFILE } from '../config/balance.js';
import { hash01 } from './Movement.js';
import { moodOf } from './Mood.js';

// Loyalty (docs/designs/guest-staff-personalities.md, Status #12): the same
// person, stay after stay. A guest who enjoyed their stay may want to come back
// -- the happier, the likelier, a delighted guest more so -- after a few days to
// a month, as themselves: the same chronotype, pace, sleep and favourite (their
// purpose and party are new each trip). Each return counts: returning (a
// second stay), regular (third and fourth), VIP (fifth and on). Regulars ask
// for their old room, the loyal forgive more, and their reviews count double;
// a regular who leaves unhappier than last time is lost. With loyalty off,
// the old rule: back if satisfaction reached SATISFACTION.returnEligibleThreshold.

export type LoyaltyTier = 'first' | 'returning' | 'regular' | 'vip';

/** The tier a guest on this many stays is in. */
export function tierOf(stays: number): LoyaltyTier {
  if (stays >= LOYALTY.vipFrom) return 'vip';
  if (stays >= LOYALTY.regularFrom) return 'regular';
  return stays >= 2 ? 'returning' : 'first';
}

/** How many stays this is for a guest (this one included). */
export function staysOf(guest: Pick<Guest, 'loyalty' | 'isReturning'>): number {
  return guest.loyalty?.stays ?? (guest.isReturning ? 2 : 1);
}

/** The person a booking is: the id of their first booking with the hotel. */
export function personIdOf(guest: Pick<Guest, 'loyalty' | 'id'>): string {
  return guest.loyalty?.personId ?? guest.id;
}

/** "3rd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** A guest's history with the hotel in words: "First stay", "2nd stay", "4th stay (a regular)", "VIP: 6th stay". */
export function describeLoyalty(guest: Pick<Guest, 'loyalty' | 'isReturning'>): string {
  const stays = staysOf(guest);
  const tier = tierOf(stays);
  if (tier === 'vip') return `VIP: ${ordinal(stays)} stay`;
  if (tier === 'regular') return `${ordinal(stays)} stay (a regular)`;
  return stays >= 2 ? `${ordinal(stays)} stay` : 'First stay';
}

/** How much a guest's high expectations amplify what's wrong: the loyal forgive more (1 for a first stay, or with loyalty off). */
export function expectationMultFor(guest: Pick<Guest, 'loyalty' | 'isReturning'>): number {
  if (!LOYALTY.enabled) return 1;
  const tier = tierOf(staysOf(guest));
  return tier === 'first' ? 1 : LOYALTY.expectationMult[tier];
}

/** How many times over a guest's review and mood count in the hotel's rolling windows (none: once). */
export function bookingWeightFor(guest: Pick<Guest, 'loyalty' | 'isReturning' | 'spotlight'>): number | undefined {
  if (SPOTLIGHT.enabled && GUEST_PROFILE.enabled && guest.spotlight?.kind === 'writer') return SPOTLIGHT.writer.bookingWeight; // a travel writer's review is read by many
  if (!LOYALTY.enabled) return undefined;
  const tier = tierOf(staysOf(guest));
  return tier === 'regular' || tier === 'vip' ? LOYALTY.bookingWeight : undefined;
}

/** The chance a guest leaving this happy wants to come back (with loyalty on). */
export function returnChance(satisfaction: number): number {
  const base = Math.max(0, Math.min(1, (satisfaction - LOYALTY.entryFrom) / (LOYALTY.entryFull - LOYALTY.entryFrom)));
  return Math.min(1, base * (moodOf(satisfaction) === 'delighted' ? LOYALTY.delightedMult : 1));
}

/** Whether a regular has been lost: they left with a review well below last time's. */
export function isLostRegular(guest: Pick<Guest, 'loyalty' | 'isReturning'>, review: number): boolean {
  const last = guest.loyalty?.lastReview;
  return LOYALTY.enabled && tierOf(staysOf(guest)) !== 'first' && tierOf(staysOf(guest)) !== 'returning'
    && last !== undefined && review < last - LOYALTY.lostBelowLastReview;
}

/**
 * Whether a guest checking out will want to come back, and if so, what the
 * hotel remembers of them: with loyalty on, by a chance that rises with their
 * satisfaction (a hash of their booking, never the shared random stream); off,
 * the old rule.
 */
export function returnEntry(guest: Guest, satisfaction: number, room: Room, review: number, day: number): ReturningGuestProfile | null {
  if (!LOYALTY.enabled) {
    return satisfaction >= SATISFACTION.returnEligibleThreshold ? { name: guest.name, trait: guest.trait, roomType: room.type } : null;
  }
  if (isLostRegular(guest, review)) return null;
  if (hash01(`${guest.id}#return`) >= returnChance(satisfaction)) return null;
  const [soonest, latest] = LOYALTY.returnAfterDays;
  return {
    name: guest.name, trait: guest.trait, roomType: room.type,
    personId: personIdOf(guest), stays: staysOf(guest),
    ...(guest.profile ? { profile: guest.profile } : {}),
    lastRoomId: room.id, lastReview: review,
    dueDay: day + soonest + Math.floor(hash01(`${guest.id}#return-day`) * (latest - soonest + 1)),
  };
}

/** The pool with someone added: at most poolMaxSize, letting go of the least loyal (then the longest waiting) first. */
export function addToPool(pool: ReturningGuestProfile[], entry: ReturningGuestProfile): ReturningGuestProfile[] {
  if (!LOYALTY.enabled) return [...pool, entry].slice(-STORY.returningGuestPoolMaxSize);
  const next = [...pool, entry];
  while (next.length > LOYALTY.poolMaxSize) {
    let drop = 0;
    for (let i = 1; i < next.length; i++) if ((next[i].stays ?? 1) < (next[drop].stays ?? 1)) drop = i;
    next.splice(drop, 1);
  }
  return next;
}

/** The people in the pool who could come back today (everyone, with loyalty off). */
export function dueIndexes(pool: ReturningGuestProfile[], day: number): number[] {
  return pool.map((p, i) => [p, i] as const).filter(([p]) => !LOYALTY.enabled || (p.dueDay ?? 0) <= day).map(([, i]) => i);
}

/** Which of the due people comes, from one roll in [0, 1): VIPs weighted up (with loyalty off, floor(roll x n), as ever). */
export function pickDue(pool: ReturningGuestProfile[], due: number[], roll: number): number {
  if (!LOYALTY.enabled) return due[Math.floor(roll * due.length)];
  const weights = due.map(i => (tierOf((pool[i].stays ?? 1) + 1) === 'vip' ? LOYALTY.vipPullWeight : 1));
  let at = roll * weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k < due.length; k++) {
    if (at < weights[k]) return due[k];
    at -= weights[k];
  }
  return due[due.length - 1];
}
