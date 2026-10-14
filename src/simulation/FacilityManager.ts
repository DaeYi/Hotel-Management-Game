import type { HotelState, Guest, Facility, FacilityType, Leg } from './types.js';
import { FACILITY_CONFIG, FACILITY_LEVELS, FACILITY_VISITS, TRAVEL, GUEST_PROFILE, GUEST_FAVORITES, MOOD, SPENDING } from '../config/balance.js';
import { spendingOn, spendingOf, saleFor } from './Spending.js';
import { findRoute, getOpenFacilities } from './Layout.js';
import { getCurrentSeason } from './SeasonManager.js';
import { hourStart, makeWalk, makeStay, isUnderway, hash01 } from './Movement.js';
import { roomTile } from './GuestMovement.js';
import { partyLoad, partySize, perPersonFactor } from './Party.js';
import { facilityChanceMult } from './Purpose.js';
import { activityHour, guestPace, favoriteOf, favoriteChanceMult } from './Profile.js';
import { guestMood } from './Mood.js';
import { fallbackOuting } from './OutingManager.js';
import { isHosting } from './Visitors.js';

// Guests use the hotel's facilities. Each hour boundary, guests who are in
// their rooms may head out to a facility -- breakfast at the restaurant, a
// morning workout, an afternoon swim -- by chances that depend on the hour
// (FACILITY_CONFIG[type].visitChance). The choice is deterministic (a hash of
// guest, day, hour and type) so it never shifts the shared PRNG. A guest only
// goes if an open facility of that type is a short walk away and has room.
// The visit is a trip on the guest (out, stay, back), drawn as it happens.
// Once the guest gets there (creditFacilityVisits, at the next hour boundary),
// their review gets that facility's bonus and a shop visit is a sale -- so a
// visit cut short on the way (the gym demolished, the guest checking out)
// earns nothing.

const LEAVE_SPREAD = 0.5; // guests set out over the first half of the hour

/**
 * How much a facility holds at once, in bookings of one or two (a bigger
 * party takes more: partyLoad -- a family of four is two bookings' worth).
 */
export function facilityCapacity(facility: Facility): number {
  return Math.round(FACILITY_CONFIG[facility.type].capacity * FACILITY_LEVELS[facility.level - 1].capacityMult);
}

/** The chance a guest in their room heads to a type of facility during an hour of the day (by their purpose: business travellers to the gym, a getaway to the pool). */
export function visitChance(type: FacilityType, hour: number, day: number, guest?: Pick<Guest, 'purpose' | 'profile'>): number {
  const config = FACILITY_CONFIG[type];
  // An early bird keeps a regular's hours two hours early, a night owl two hours late
  const h = guest ? activityHour(guest, hour) : hour;
  const window = config.visitChance.find(([from, to]) => h >= from && h < to);
  if (!window) return 0;
  const season = config.seasonalMultiplier ? FACILITY_VISITS.seasonalChanceMult[getCurrentSeason(day)] ?? 1 : 1;
  return Math.min(1, window[2] * season * (guest ? facilityChanceMult(guest, type) * favoriteChanceMult(guest, type) : 1));
}

/**
 * The hours a type of facility is in use: its visiting windows, and with
 * guest profiles on, two hours either side (early birds come two hours early,
 * night owls stay two late). Overlapping hours merged.
 */
export function facilityHours(type: FacilityType): Array<[number, number]> {
  const widen = GUEST_PROFILE.enabled ? 2 : 0;
  const windows = FACILITY_CONFIG[type].visitChance
    .map(([from, to]) => [Math.max(0, from - widen), Math.min(24, to + widen)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [from, to] of windows) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** Whether the hotel has a type of facility guests can use: open, built but its door blocked (closed), or none. */
export function facilityStatus(state: HotelState, type: FacilityType): 'open' | 'closed' | 'none' {
  if (getOpenFacilities(state).some(f => f.type === type)) return 'open';
  return state.facilities.some(f => f.type === type) ? 'closed' : 'none';
}

/** Facility opening hours as text, e.g. "6-9, 17-22". */
export function openingHours(type: FacilityType): string {
  return facilityHours(type).map(([from, to]) => `${from}-${to}`).join(', ');
}

/** The guests using a facility at time t (inside it, not walking there or back). */
export function guestsInFacility(state: HotelState, facilityId: string, t: number): Guest[] {
  return state.guests.filter(g => g.trip?.some(l => l.kind === 'stay' && l.placeId === facilityId && l.start <= t && t < l.end));
}

/** The people using a facility at time t. */
export function peopleInFacility(state: HotelState, facilityId: string, t: number): number {
  return guestsInFacility(state, facilityId, t).reduce((sum, g) => sum + partySize(g), 0);
}

/** How full a facility is at time t, in the units of facilityCapacity. */
export function facilityLoad(state: HotelState, facilityId: string, t: number): number {
  return guestsInFacility(state, facilityId, t).reduce((sum, g) => sum + partyLoad(partySize(g)), 0);
}

/** How full a facility is with visits (stays planned at it) that overlap [from, to), in the units of facilityCapacity. */
function overlappingVisits(state: HotelState, facilityId: string, from: number, to: number): number {
  let n = 0;
  for (const g of state.guests) {
    for (const l of g.trip ?? []) {
      if (l.kind === 'stay' && l.placeId === facilityId && l.start < to && from < l.end) n += partyLoad(partySize(g));
    }
  }
  return n;
}

/**
 * Send guests out to facilities for the hour starting now (call at the hour
 * boundary, with the state for the new hour): each visit is a trip on the
 * guest. It's credited once they get there (creditFacilityVisits).
 */
export function planFacilityVisits(state: HotelState): HotelState {
  const open = getOpenFacilities(state);
  const favorites = GUEST_FAVORITES.enabled;
  if ((open.length === 0 && !favorites) || state.guests.length === 0) return state;
  const T = hourStart(state);
  const openTypes = [...new Set(open.map(f => f.type))];
  // Today's let-downs so far (favourites on): kept on the state for the facility cards and the day's stats
  let demand = favorites ? todaysDemand(state) : null;
  const letDown = new Map<string, FacilityType>(); // guests whose favourite let them down this hour
  const outings = new Map<string, Leg[]>(); // ... and went to the beach or out to dinner instead
  const countAt = (guest: Guest, facilityId: string) => {
    if (!demand) return;
    const key = `fullAt|${guest.id}|${facilityId}`;
    if (demand.seen.includes(key)) return;
    demand = { ...demand, seen: [...demand.seen, key], fullAt: { ...demand.fullAt, [facilityId]: (demand.fullAt?.[facilityId] ?? 0) + 1 } };
  };
  const count = (kind: 'wanted' | 'full' | 'tooFar', guest: Guest, type: FacilityType) => {
    if (!demand) return;
    const key = `${kind}|${guest.id}|${type}`;
    if (demand.seen.includes(key)) return; // each guest once a day
    demand = { ...demand, seen: [...demand.seen, key], [kind]: { ...demand[kind], [type]: (demand[kind][type] ?? 0) + 1 } };
  };

  // Who wants to go where this hour
  const wants: Array<{ guest: Guest; type: FacilityType; score: number }> = [];
  for (const guest of state.guests) {
    if (isUnderway(guest.trip, T)) continue; // still arriving, or already out (and not yet credited)
    if (isHosting(state, guest.id, T)) continue; // friends round: staying in
    if (!state.rooms.some(r => r.guestId === guest.id && r.status === 'occupied')) continue;
    if (MOOD.enabled && guestMood(guest) === 'angry') continue; // too cross to enjoy anything
    // A fan wants their favourite whether or not the hotel has one
    const favorite = favorites ? favoriteOf(guest) : null;
    const types = favorite && !openTypes.includes(favorite) ? [...openTypes, favorite] : openTypes;
    let best: { type: FacilityType; score: number } | null = null;
    for (const type of types) {
      if (!mayGoAgain(guest, type, state.day, T)) continue; // once a day per type (a fan: twice, a few hours apart)
      const p = visitChance(type, state.hour, state.day, guest);
      if (p <= 0) continue;
      const u = hash01(`${guest.id}|${state.day}|${state.hour}|${type}`);
      if (u < p && (!best || u / p < best.score)) best = { type, score: u / p };
    }
    if (!best) continue;
    // A thrifty guest pays for nothing here: set on the shop or the restaurant this hour, they stay in
    // (handing the hour to the gym or pool instead had the cash-limited bots gain up to 9%)
    if ((best.type === 'shop' || best.type === 'restaurant') && spendingOf(guest) === 'thrifty') continue;
    if (!openTypes.includes(best.type)) {
      // Their favourite isn't here: a letdown once the hotel's stars allow one; a swimmer heads for
      // the beach and a foodie out to dinner instead
      count('wanted', guest, best.type); // demand the player can see before building
      if (state.peakStarRating >= FACILITY_CONFIG[best.type].requiredStars) letDown.set(guest.id, best.type);
      if ((best.type === 'pool' || best.type === 'restaurant') && mayGoOut(guest, state.day, T)) {
        // A meal out is breakfast, lunch or dinner by their hour
        const h = activityHour(guest, state.hour);
        const meal = h < 11 ? 'breakfast' : h < 16 ? 'lunch' : 'dinner';
        const trip = fallbackOuting(state, guest, best.type === 'pool' ? 'beach' : meal);
        if (trip) outings.set(guest.id, trip);
      }
      continue;
    }
    wants.push({ guest, ...best });
  }
  wants.sort((a, b) => a.score - b.score || (a.guest.id < b.guest.id ? -1 : 1));

  let current = state;
  for (const { guest, type } of wants) {
    const room = current.rooms.find(r => r.guestId === guest.id);
    if (!room) continue;
    const from = roomTile(room);
    const pace = guestPace(guest);
    const leave = T + hash01(`${guest.id}|${state.day}|${state.hour}|leave`) * LEAVE_SPREAD;
    // The nearest open facility of the type with room for them, within a short walk
    const routes = open
      .filter(f => f.type === type)
      .map(f => ({ f, route: findRoute(current, from, { gridX: f.gridX, gridY: f.gridY, floor: f.floor, door: f.door }, pace) }));
    const options = routes
      .filter((o): o is { f: Facility; route: NonNullable<typeof o.route> } => !!o.route && o.route.hours <= FACILITY_VISITS.maxWalkHours)
      .sort((a, b) => a.route.hours - b.route.hours || (a.f.id < b.f.id ? -1 : 1));
    if (options.length === 0 && routes.some(o => o.route)) count('tooFar', guest, type); // there's one, but it's too far to walk
    let placed = false;
    for (const { f, route } of options) {
      const arrive = leave + route.hours;
      const done = arrive + FACILITY_CONFIG[type].visitHours;
      // The whole party goes, so it has to fit
      if (overlappingVisits(current, f.id, arrive, done) + partyLoad(partySize(guest)) > facilityCapacity(f) + 1e-9) continue;
      const back = findRoute(current, route.path[route.path.length - 1], from, pace);
      if (!back) continue;
      const trip: Leg[] = [
        makeWalk(route.path, leave, pace),
        makeStay(route.path[route.path.length - 1], arrive, done, 'visit', { placeId: f.id }),
        makeWalk(back.path, done, pace),
      ];
      current = { ...current, guests: current.guests.map(g => (g.id === guest.id ? { ...g, trip, tripKind: 'visit' as const } : g)) };
      placed = true;
      break;
    }
    if (!placed && options.length > 0) {
      // Every one in reach was full (each counted on its own card too)
      count('full', guest, type);
      for (const { f } of options) countAt(guest, f.id);
      if (favorites && favoriteOf(guest) === type) letDown.set(guest.id, type);
    }
  }
  if (!demand) return current;
  // Let down (once a day each): a little put out, and it'll be in their review; and the outings instead
  const guests = current.guests.map(g => {
    let next = g;
    if (letDown.has(g.id) && g.favoriteMisses?.day !== state.day) {
      next = {
        ...next,
        satisfaction: Math.max(0, next.satisfaction - GUEST_FAVORITES.missMood),
        favoriteMisses: { day: state.day, count: (g.favoriteMisses?.count ?? 0) + 1 },
      };
    }
    const trip = outings.get(g.id);
    if (trip) {
      const before = g.favoriteOutings;
      next = {
        ...next, trip, tripKind: 'outing' as const,
        favoriteOutings: { day: state.day, today: before?.day === state.day ? before.today + 1 : 1, lastAt: T },
      };
    }
    return next;
  });
  return { ...current, guests, facilityDemand: demand };
}

/** Today's facility let-downs so far (a fresh count on a new day). */
function todaysDemand(state: HotelState): NonNullable<HotelState['facilityDemand']> & { seen: string[] } {
  const d = state.facilityDemand;
  if (d && d.day === state.day) return { ...d, seen: (d as { seen?: string[] }).seen ?? [] };
  return { day: state.day, wanted: {}, full: {}, tooFar: {}, seen: [] };
}

/** Whether a fan whose favourite isn't here may go out for it again (the beach, a meal out): like a visit, twice a day, a few hours apart. */
function mayGoOut(guest: Guest, day: number, T: number): boolean {
  const done = guest.favoriteOutings;
  if (!done || done.day !== day) return true;
  return done.today < GUEST_FAVORITES.fanVisitsPerDay && T - done.lastAt >= GUEST_FAVORITES.fanRevisitGapHours;
}

/** Whether a guest may go to a type of facility again today: once a day, or a fan to their favourite twice, a few hours apart. */
function mayGoAgain(guest: Guest, type: FacilityType, day: number, T: number): boolean {
  const used = guest.facilitiesUsed?.[type];
  if (!used || used.day !== day) return true;
  if (favoriteOf(guest) !== type) return false;
  return (used.today ?? 1) < GUEST_FAVORITES.fanVisitsPerDay && T - (used.lastAt ?? -Infinity) >= GUEST_FAVORITES.fanRevisitGapHours;
}

/**
 * Credit every facility visit that has begun by time t and hasn't been
 * credited yet: the guest used that facility (facilitiesUsed: its review
 * bonus at checkout) and, at a shop, spent money. Call at each hour boundary,
 * before anyone checks out.
 */
export function creditFacilityVisits(state: HotelState, t: number): HotelState {
  let cash = state.cash;
  let changed = false;
  // With spending styles on: what each guest spends, in whole dollars, kept with them and in the day's takings
  const money = spendingOn();
  let onSite = state.onSite ?? { shop: 0, restaurant: 0, splurgers: 0 };
  let takings = 0;
  const guests = state.guests.map(g => {
    if (!g.trip?.some(l => l.kind === 'stay' && l.activity === 'visit' && !l.credited && l.start < t)) return g;
    let facilitiesUsed = g.facilitiesUsed;
    let satisfaction = g.satisfaction;
    let spent = g.spent;
    const trip = g.trip.map(l => {
      if (l.kind !== 'stay' || l.activity !== 'visit' || l.credited || l.start >= t) return l;
      const f = state.facilities.find(x => x.id === l.placeId);
      if (f) {
        const used = facilitiesUsed?.[f.type];
        // The day the visit was planned (a night owl's 23:00 swim that starts after midnight is still today's)
        const day = Math.floor(g.trip![0].start / 24) + 1;
        const fan = favoriteOf(g) === f.type;
        // A fan's favourite: how many times today and this stay, and when last (for twice a day, a few hours apart)
        const count = fan ? { today: used?.day === day ? (used.today ?? 1) + 1 : 1, visits: (used?.visits ?? 0) + 1, lastAt: Math.floor(g.trip![0].start) } : {};
        facilitiesUsed = { ...facilitiesUsed, [f.type]: { level: Math.max(used?.level ?? 0, f.level), day, ...count } };
        // A delighted guest spends more at the shop
        const splurge = MOOD.enabled && guestMood({ satisfaction }) === 'delighted' && f.type === 'shop' ? MOOD.delightedShopMult : 1;
        if (!money) cash += FACILITY_CONFIG[f.type].spendPerVisit * FACILITY_LEVELS[f.level - 1].revenueMult * perPersonFactor(partySize(g)) * splurge;
        else if (f.type === 'shop' || f.type === 'restaurant') {
          const style = spendingOf(g);
          const sale = saleFor(f.type, f.level, partySize(g), style, splurge);
          if (sale > 0) {
            cash += sale;
            takings += sale;
            spent = { shop: spent?.shop ?? 0, restaurant: spent?.restaurant ?? 0 };
            spent[f.type] += sale;
            onSite = { ...onSite, [f.type]: onSite[f.type] + sale, splurgers: onSite.splurgers + (style === 'splurger' ? sale : 0) };
          }
        }
        // Enjoying it lifts their mood, their favourite most
        if (GUEST_FAVORITES.enabled) satisfaction = Math.min(100, satisfaction + (fan ? GUEST_FAVORITES.favoriteVisitMood : GUEST_FAVORITES.visitMood));
      }
      return { ...l, credited: true };
    });
    changed = true;
    return { ...g, trip, facilitiesUsed, satisfaction, ...(spent ? { spent } : {}) };
  });
  if (!changed) return state;
  if (!money || takings === 0) return { ...state, guests, cash };
  return { ...state, guests, cash, onSite, ...(SPENDING.onSiteIsRevenue ? { totalRevenue: state.totalRevenue + takings } : {}) };
}

/**
 * A guest's review bonus from the facilities they used this stay: each type
 * once, at the best level they used, more in its season (the pool in summer),
 * capped at FACILITY_VISITS.maxBonusPerStay.
 */
export function facilityReviewBonus(guest: Guest, day: number): number {
  let bonus = 0;
  for (const [type, used] of Object.entries(guest.facilitiesUsed ?? {})) {
    const config = FACILITY_CONFIG[type];
    if (!config || !used) continue;
    let b = config.visitReviewBonus * FACILITY_LEVELS[used.level - 1].reviewMult;
    if (config.seasonalMultiplier && getCurrentSeason(day) === config.seasonalMultiplier) b *= FACILITY_VISITS.seasonalBonusMult;
    if (favoriteOf(guest) === type) b *= GUEST_FAVORITES.fanReviewMult; // their favourite
    bonus += b;
  }
  return Math.min(FACILITY_VISITS.maxBonusPerStay, bonus);
}
