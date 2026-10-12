import type { Guest, HotelState, Party, PartyKind, Room } from './types.js';
import { PARTIES, SURNAMES } from '../config/balance.js';
import { hash01 } from './Movement.js';
import { getCurrentSeason, getDayOfWeek } from './SeasonManager.js';

// Parties (docs/designs/rooms-rethink.md, "Party size and capacity"). One
// Guest is one booking -- one room, one trip, one review -- for a party of
// one to four. Everything about a party is worked out from the booking's id
// with hash01, never the shared random stream, so who books doesn't shift
// anything else that happens. A booking of one or two people is what every
// guest was before parties, so everything a party changes scales only with
// the people beyond two.

const SOLO: Party = { kind: 'solo', size: 1 };
const KINDS: PartyKind[] = ['solo', 'business', 'couple', 'friends', 'family'];
const NUMBER_WORDS = ['no one', 'one', 'two', 'three', 'four', 'five', 'six'];

/** A booking's party (one person for bookings from before parties). */
export function partyOf(guest: Pick<Guest, 'party'> | null | undefined): Party {
  return guest?.party ?? SOLO;
}

/** People in a booking. */
export function partySize(guest: Pick<Guest, 'party'> | null | undefined): number {
  return partyOf(guest).size;
}

/** Whether a party shares beds: couples and families do; friends and colleagues don't. */
export function sharesBeds(party: Party): boolean {
  return party.kind === 'couple' || party.kind === 'family';
}

/** Children in a party: a family's members beyond the first two. */
export function kidsIn(party: Party): number {
  return party.kind === 'family' ? Math.max(0, party.size - 2) : 0;
}

/**
 * How much more a booking of this many people makes of anything per person
 * -- noise, wear, mess, consumables, spending: 1 for one or two (as every
 * booking was), +PARTIES.perPersonScale for each person beyond.
 */
export function perPersonFactor(size: number): number {
  return 1 + PARTIES.perPersonScale * Math.max(0, size - 2);
}

/** How much room a party takes at a facility, counted in bookings of two (so one or two people are one). */
export function partyLoad(size: number): number {
  return Math.max(1, size / 2);
}

/** The per-person factor for whoever is staying in a room (1 if nobody, or nobody known). */
export function occupantFactor(state: Pick<HotelState, 'guests'>, room: Pick<Room, 'guestId'>, guests?: Map<string, Guest>): number {
  if (!room.guestId) return 1;
  const guest = guests ? guests.get(room.guestId) : state.guests.find(g => g.id === room.guestId);
  return perPersonFactor(partySize(guest));
}

/** Guests by id, for looking parties up across many rooms. */
export function guestsById(state: Pick<HotelState, 'guests'>): Map<string, Guest> {
  return new Map(state.guests.map(g => [g.id, g]));
}

/** What a party's budget is multiplied by: more people, more to spend on a room. */
export function budgetMultiplier(size: number): number {
  return size <= 2 ? 1 : PARTIES.budgetMult[Math.min(size, 5)] ?? 1;
}

/** Who books on a day: weekdays are business and solo travellers, weekends couples and families; summer brings more families. */
export function getPartyMix(day: number): Record<PartyKind, number> {
  const weekend = getDayOfWeek(day) >= 5;
  const mix = { ...(weekend ? PARTIES.weekend : PARTIES.weekday) };
  if (getCurrentSeason(day) === 'summer') {
    const shift = Math.min(mix.solo, PARTIES.summerShift);
    mix.solo -= shift;
    mix.family += shift;
  }
  return mix;
}

/** Pick from weighted options with a roll in [0, 1). */
export function pick<T>(options: Array<[T, number]>, roll: number): T {
  const total = options.reduce((sum, [, w]) => sum + w, 0);
  let at = roll * total;
  for (const [value, weight] of options) {
    if (at < weight) return value;
    at -= weight;
  }
  return options[options.length - 1][0];
}

/** Who a booking is for, from its id and the day it arrives (one person if parties are off). */
export function rollParty(id: string, day: number): Party {
  if (!PARTIES.enabled) return SOLO;
  const mix = getPartyMix(day);
  const kind = pick(KINDS.map(k => [k, mix[k]] as [PartyKind, number]), hash01(`${id}#party`));
  const size = kind === 'couple' ? 2
    : kind === 'friends' ? pick(PARTIES.friendsSizes, hash01(`${id}#party-size`))
    : kind === 'family' ? pick(PARTIES.familySizes, hash01(`${id}#party-size`))
    : 1;
  return { kind, size };
}

/** A party that books as one or two instead: the parents take a double, or one friend comes alone. */
export function smallerParty(party: Party, id: string): Party {
  if (party.size <= 1) return party;
  if (party.size === 2) return SOLO; // a couple, or two friends: one comes alone
  return sharesBeds(party) || hash01(`${id}#party-reroll-kind`) < 0.5 ? { kind: 'couple', size: 2 } : SOLO;
}

/** A booking for a different party: its budget follows the party's size. */
export function withParty(guest: Guest, party: Party): Guest {
  const budget = guest.budget / budgetMultiplier(partySize(guest)) * budgetMultiplier(party.size);
  // A family doesn't throw parties: the loud-guest trait goes with friends and couples
  const trait = party.kind === 'family' && guest.trait === 'party_guest' ? 'normal' : guest.trait;
  return { ...guest, party, budget, trait };
}

/** A party's family name, from its id. */
export function surnameOf(id: string): string {
  return SURNAMES[Math.floor(hash01(`${id}#surname`) * SURNAMES.length)];
}

/**
 * What to call a booking in messages: one or two people go by the guest's
 * name, as before; a bigger party by a singular group name ("the Okafor
 * family", "Priya's group"), so every message reads the same either way.
 */
export function partyLabel(guest: Pick<Guest, 'id' | 'name' | 'party'>): string {
  const party = partyOf(guest);
  if (party.size < 3) return guest.name;
  return party.kind === 'family' ? `the ${surnameOf(guest.id)} family` : `${guest.name}'s group`;
}

/** The same, starting a sentence. */
export function PartyLabel(guest: Pick<Guest, 'id' | 'name' | 'party'>): string {
  const label = partyLabel(guest);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Who a party is, in a few words: "a family of four", "two friends", "a couple", "a business traveller". */
export function describeParty(party: Party): string {
  switch (party.kind) {
    case 'solo': return 'a solo traveller';
    case 'business': return 'a business traveller';
    case 'couple': return 'a couple';
    case 'friends': return `${NUMBER_WORDS[party.size] ?? party.size} friends`;
    case 'family': return `a family of ${NUMBER_WORDS[party.size] ?? party.size}`;
  }
}

/** A number in words, for messages ("no room for four"). */
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}
