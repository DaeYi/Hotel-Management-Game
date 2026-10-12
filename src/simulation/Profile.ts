import type { Chronotype, FacilityType, Guest, GuestProfile, GuestTrait, HotelState, LateCheckoutPolicy, Mobility, Party, Purpose, Rowdiness, SleepSensitivity } from './types.js';
import { ECONOMY, GUEST_PROFILE, NOISE, TRAVEL, GUEST_FAVORITES, GUEST_HOUSEKEEPING } from '../config/balance.js';
import { hash01 } from './Movement.js';
import { pick } from './Party.js';

// Who a guest is, beyond their trip (docs/designs/guest-staff-personalities.md,
// Body and Temperament): when they're up (chronotype), how fast they walk
// (mobility), how much night noise bothers them (sleep sensitivity) and how
// much they make (rowdiness). Rolled once from the booking's id when they
// arrive -- after their party and purpose, which lean it -- and stored on the
// guest, so it never changes under them. The legacy trait (drawn from the
// shared random stream, as ever) still makes light sleepers and rowdy guests;
// the rest is hashed. A guest without a profile (an older save, or profiles
// off) is a regular, at the usual pace, judged by their trait as before.

/** Who a guest is, from their id, party, purpose and trait (none if profiles are off). */
export function rollProfile(id: string, party: Party, purpose: Purpose | undefined, trait: GuestTrait): GuestProfile | undefined {
  if (!GUEST_PROFILE.enabled) return undefined;
  const lean = purpose === 'business' || party.kind === 'business' ? 'business' : party.kind === 'family' ? 'family' : party.kind === 'friends' ? 'friends' : 'base';
  const chronotype = pick(GUEST_PROFILE.chronotype[lean] ?? GUEST_PROFILE.chronotype.base, hash01(`${id}#chronotype`));
  const mobility = pick(GUEST_PROFILE.mobility[lean] ?? GUEST_PROFILE.mobility.base, hash01(`${id}#mobility`));
  const sleep: SleepSensitivity = trait === 'light_sleeper' ? 'light' : hash01(`${id}#sleep`) < GUEST_PROFILE.heavySleeperChance ? 'heavy' : 'normal';
  const rowdiness: Rowdiness = trait === 'party_guest' ? 'rowdy' : hash01(`${id}#rowdiness`) < GUEST_PROFILE.quietChance ? 'quiet' : 'normal';
  const [first, last] = GUEST_PROFILE.earlyCheckoutHours;
  const checkoutHour = chronotype === 'early' ? first + Math.floor(hash01(`${id}#checkout`) * (last - first + 1)) : ECONOMY.checkOutHour;
  // The facility they seek out (business travellers the gym, families and getaways the pool)
  const favoriteLean = lean === 'business' || lean === 'family' ? lean : purpose === 'getaway' ? 'getaway' : 'base';
  const favorite = GUEST_FAVORITES.enabled ? pick(GUEST_FAVORITES.byLean[favoriteLean], hash01(`${id}#favorite`)) : undefined;
  // When they want their room cleaned (a business traveller made up daily, a getaway left alone)
  const housekeepingLean = lean === 'business' ? 'business' : purpose === 'getaway' ? 'getaway' : 'base';
  const housekeeping = GUEST_HOUSEKEEPING.enabled ? pick(GUEST_HOUSEKEEPING.byLean[housekeepingLean], hash01(`${id}#housekeeping`)) : undefined;
  return { chronotype, mobility, sleep, rowdiness, checkoutHour, ...(favorite ? { favorite } : {}), ...(housekeeping ? { housekeeping } : {}) };
}

/** A guest's favourite facility (none: no favourite, or favourites off). */
export function favoriteOf(guest: Pick<Guest, 'profile'>): FacilityType | null {
  const f = GUEST_FAVORITES.enabled ? guest.profile?.favorite : undefined;
  return f && f !== 'none' ? f : null;
}

/** How much likelier than most a guest is to go to a type of facility: a fan three times, anyone else a little less (1 without a favourite roll). */
export function favoriteChanceMult(guest: Pick<Guest, 'profile'>, type: FacilityType): number {
  const f = GUEST_FAVORITES.enabled ? guest.profile?.favorite : undefined;
  if (f === undefined) return 1;
  return f === type ? GUEST_FAVORITES.fanChanceMult : GUEST_FAVORITES.nonFanChanceMult[type];
}

/** "Loves the pool (2 visits this stay)", "Loves the pool (there isn't one)": a guest's favourite and how it's going. */
export function describeFavorite(guest: Pick<Guest, 'profile' | 'facilitiesUsed' | 'favoriteMisses'>, hotelHas: 'open' | 'closed' | 'none', label: string): string | null {
  const favorite = favoriteOf(guest);
  if (!favorite) return null;
  const visits = guest.facilitiesUsed?.[favorite]?.visits ?? 0;
  const missed = guest.favoriteMisses?.count ?? 0;
  const been = visits > 0 ? `${visits} visit${visits === 1 ? '' : 's'} this stay` : '';
  const how = hotelHas === 'none' ? "there isn't one here" : hotelHas === 'closed' ? `its door is blocked${been ? `; ${been}` : ''}` : been || 'not been yet';
  return `Loves the ${label.toLowerCase()} (${how}${missed > 0 ? `; let down ${missed === 1 ? 'once' : `${missed} times`}` : ''})`;
}

/** A guest's chronotype (a regular, for a guest without a profile). */
export function chronotypeOf(guest: Pick<Guest, 'profile'>): Chronotype {
  return guest.profile?.chronotype ?? 'regular';
}

/** Whether an hour of the day falls in [from, to), wrapping past midnight (21-05). */
export function inHours(hour: number, [from, to]: [number, number]): boolean {
  const h = ((hour % 24) + 24) % 24;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/** How much earlier or later than most a guest does things: -2, 0 or +2 hours. */
export function activityOffset(guest: Pick<Guest, 'profile'>): number {
  return GUEST_PROFILE.activityOffset[chronotypeOf(guest)];
}

/** The hour of a regular's day that an hour is for this guest (an early bird's 06:00 is a regular's 08:00). */
export function activityHour(guest: Pick<Guest, 'profile'>, hour: number): number {
  return (((hour - activityOffset(guest)) % 24) + 24) % 24;
}

/** When a guest sleeps: [from, to) hours of the day. */
export function sleepHours(guest: Pick<Guest, 'profile'>): [number, number] {
  return GUEST_PROFILE.sleepHours[chronotypeOf(guest)];
}

/** Whether an hour of the day is in a guest's sleep hours. */
export function isSleepHour(guest: Pick<Guest, 'profile'>, hour: number): boolean {
  return inHours(hour, sleepHours(guest));
}

/** Which night an absolute game hour's sleep belongs to (the same number from the evening to the morning after). */
export function nightOf(guest: Pick<Guest, 'profile'>, absHour: number): number {
  return Math.floor((absHour - sleepHours(guest)[0]) / 24);
}

/** A hotel's late checkout policy (no late checkout unless the player allows it). */
export function lateCheckoutPolicy(state: Pick<HotelState, 'lateCheckout'>): LateCheckoutPolicy {
  return state.lateCheckout ?? 'deny';
}

/** Whether a guest asks for a late checkout (night owls do). */
export function wantsLateCheckout(guest: Pick<Guest, 'profile'>): boolean {
  return chronotypeOf(guest) === 'night';
}

/** The hour a guest checks out on their last morning: an early bird's own hour, a night owl's late checkout if allowed, else 11:00. */
export function checkoutHour(guest: Pick<Guest, 'profile'>, state: Pick<HotelState, 'lateCheckout'>): number {
  if (!guest.profile) return ECONOMY.checkOutHour;
  if (wantsLateCheckout(guest)) return lateCheckoutPolicy(state) === 'deny' ? ECONOMY.checkOutHour : GUEST_PROFILE.lateCheckoutHour;
  return guest.profile.checkoutHour;
}

/** How fast someone walks: hours per tile (the usual guest pace without a profile). */
export function guestPace(who: { profile?: GuestProfile }): number {
  return who.profile ? GUEST_PROFILE.pace[who.profile.mobility] : TRAVEL.guestHoursPerTile;
}

/** How much a guest minds noise at night (by their legacy trait, without a profile). */
export function noiseSensitivity(guest: Pick<Guest, 'profile' | 'trait'>): number {
  return guest.profile ? GUEST_PROFILE.sensitivity[guest.profile.sleep] : NOISE.traitNoiseSensitivity[guest.trait] ?? 1;
}

/**
 * How loud a guest is, as a multiple of the usual, at an hour of the day (by
 * their legacy trait, without a profile). A rowdy guest is louder still late
 * at night -- unless the front desk asked their visitors to leave (at time t
 * or before, that night): then they keep it down.
 */
export function noiseOutputMult(guest: Pick<Guest, 'profile' | 'trait' | 'hostedNight'>, hour: number, t?: number): number {
  if (!guest.profile) return NOISE.traitNoiseOutput[guest.trait] ?? 1;
  const asked = guest.hostedNight?.keptDownAt;
  const keptDown = asked !== undefined && t !== undefined && t >= asked && t < guest.hostedNight!.day * 24 + GUEST_PROFILE.rowdyLateHours[1];
  const late = guest.profile.rowdiness === 'rowdy' && inHours(hour, GUEST_PROFILE.rowdyLateHours) && !keptDown ? GUEST_PROFILE.rowdyLateMult : 1;
  return GUEST_PROFILE.output[guest.profile.rowdiness] * late;
}

/** The one quirk a guest's figure shows: a moon for a light sleeper, a note for a rowdy one (light sleepers first). */
export function quirkOf(guest: Pick<Guest, 'profile' | 'trait'>): 'moon' | 'note' | null {
  const light = guest.profile ? guest.profile.sleep === 'light' : guest.trait === 'light_sleeper';
  if (light) return 'moon';
  const rowdy = guest.profile ? guest.profile.rowdiness === 'rowdy' : guest.trait === 'party_guest';
  return rowdy ? 'note' : null;
}

/** A guest's quirks in a word or two each: "light sleeper", "rowdy", "big spender". */
export function guestTags(guest: Pick<Guest, 'profile' | 'trait'>): string[] {
  const quirk = quirkOf(guest);
  return [quirk === 'moon' ? 'light sleeper' : quirk === 'note' ? 'rowdy' : '', guest.trait === 'big_spender' ? 'big spender' : ''].filter(Boolean);
}

const CHRONOTYPE_LABELS: Record<Chronotype, string> = { early: 'Early bird', regular: 'Regular hours', night: 'Night owl' };
const MOBILITY_LABELS: Record<Mobility, string> = { brisk: 'Walks briskly', normal: 'Walks at an easy pace', limited: 'Walks slowly (minds a wait for the lift)' };
const SLEEP_LABELS: Record<SleepSensitivity, string> = { heavy: 'Heavy sleeper', normal: 'Sleeps normally', light: 'Light sleeper' };
const ROWDINESS_LABELS: Record<Rowdiness, string> = { quiet: 'Quiet', normal: '', rowdy: 'Rowdy, loudest 22:00-02:00' };

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** A guest's rhythm in words: "Night owl, sleeps 01:00-09:00, checks out 13:00 (late checkout)". */
export function describeRhythm(guest: Pick<Guest, 'profile'>, state: Pick<HotelState, 'lateCheckout'>): string {
  const [from, to] = sleepHours(guest);
  const out = checkoutHour(guest, state);
  const late = wantsLateCheckout(guest) ? (out > ECONOMY.checkOutHour ? ' (late checkout)' : ' (asked for a late checkout: refused)') : '';
  return `${CHRONOTYPE_LABELS[chronotypeOf(guest)]}, sleeps ${hh(from)}-${hh(to)}, checks out ${hh(out)}${late}`;
}

/** The rest of a guest's profile in words, one line each (nothing for a guest without one). */
export function describeTemperament(guest: Pick<Guest, 'profile' | 'nightNoise'>): string[] {
  const p = guest.profile;
  if (!p) return [];
  const woken = guest.nightNoise?.woken ?? 0;
  const wokenText = woken > 0 ? `woken ${woken === 1 ? 'one night' : `${woken} nights`}` : '';
  // A normal sleeper is only worth a line if the noise has woken them
  const sleep = p.sleep === 'normal' ? (wokenText ? `Woken by noise ${wokenText.slice(6)}` : '') : `${SLEEP_LABELS[p.sleep]}${wokenText ? `, ${wokenText}` : ''}`;
  return [MOBILITY_LABELS[p.mobility], sleep, ROWDINESS_LABELS[p.rowdiness]].filter(Boolean);
}
