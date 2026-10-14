import type { FacilityType, Guest, GuestTrait, SpendingStyle } from './types.js';
import { SPENDING, GUEST_PROFILE, GUEST_TRAITS, FACILITY_CONFIG, FACILITY_LEVELS } from '../config/balance.js';
import { hash01 } from './Movement.js';
import { perPersonFactor } from './Party.js';

// Spending style (docs/designs/guest-staff-personalities.md, Tastes #9): how
// much a guest has to spend and how they spend it. A big spender (the legacy
// trait, drawn from the shared random stream as ever) splurges: the best room
// that suits them within reason, twice as much at the shop, a tab at the
// restaurant. Of the rest, some watch the pennies: less to spend, quicker to
// say no to a price, never the shop, and they eat in town. Everyone else is as
// before. The roll is hashed from the booking's id and kept with the profile,
// so a returning guest spends as they did.

/** Whether spending styles are on (they need guest profiles: the style lives there). */
export function spendingOn(): boolean {
  return SPENDING.enabled && GUEST_PROFILE.enabled;
}

/** How a guest spends, from their id and the legacy trait: a big spender splurges; of the rest, some are thrifty. */
export function rollSpending(id: string, trait: GuestTrait): SpendingStyle {
  if (trait === 'big_spender') return 'splurger';
  return hash01(`${id}#spending`) < SPENDING.thriftyShare / (1 - GUEST_TRAITS.bigSpenderChance) ? 'thrifty' : 'standard';
}

/** How a guest spends (standard with the switch off; without a roll, a big spender splurges). */
export function spendingOf(guest: Pick<Guest, 'profile' | 'trait'>): SpendingStyle {
  if (!spendingOn()) return 'standard';
  return guest.profile?.spending ?? (guest.trait === 'big_spender' ? 'splurger' : 'standard');
}

/** What a visit to a facility costs a guest's party, in whole dollars: the shop, and a cover at the restaurant (nothing elsewhere, or for a thrifty guest). */
export function saleFor(type: FacilityType, level: number, partySize: number, style: SpendingStyle, mult = 1): number {
  const base = type === 'restaurant' ? SPENDING.restaurantPerCover : type === 'shop' ? FACILITY_CONFIG.shop.spendPerVisit : 0;
  return Math.round(base * FACILITY_LEVELS[level - 1].revenueMult * perPersonFactor(partySize) * mult * SPENDING.spendMult[style]);
}

/** What a guest has spent on site this stay (shop and restaurant). */
export function spentHere(guest: Pick<Guest, 'spent'>): number {
  return (guest.spent?.shop ?? 0) + (guest.spent?.restaurant ?? 0);
}
