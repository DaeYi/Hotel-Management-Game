import type { HotelState, Guest, Facility, FacilityType, Leg } from './types.js';
import { FACILITY_CONFIG, FACILITY_LEVELS, FACILITY_VISITS, TRAVEL } from '../config/balance.js';
import { findRoute, getOpenFacilities } from './Layout.js';
import { getCurrentSeason } from './SeasonManager.js';
import { hourStart, makeWalk, makeStay, isUnderway, hash01 } from './Movement.js';
import { roomTile } from './GuestMovement.js';
import { partyLoad, partySize, perPersonFactor } from './Party.js';
import { facilityChanceMult } from './Purpose.js';

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

const PACE = TRAVEL.guestHoursPerTile;
const LEAVE_SPREAD = 0.5; // guests set out over the first half of the hour

/**
 * How much a facility holds at once, in bookings of one or two (a bigger
 * party takes more: partyLoad -- a family of four is two bookings' worth).
 */
export function facilityCapacity(facility: Facility): number {
  return Math.round(FACILITY_CONFIG[facility.type].capacity * FACILITY_LEVELS[facility.level - 1].capacityMult);
}

/** The chance a guest in their room heads to a type of facility during an hour of the day (by their purpose: business travellers to the gym, a getaway to the pool). */
export function visitChance(type: FacilityType, hour: number, day: number, guest?: Pick<Guest, 'purpose'>): number {
  const config = FACILITY_CONFIG[type];
  const window = config.visitChance.find(([from, to]) => hour >= from && hour < to);
  if (!window) return 0;
  const season = config.seasonalMultiplier ? FACILITY_VISITS.seasonalChanceMult[getCurrentSeason(day)] ?? 1 : 1;
  return Math.min(1, window[2] * season * (guest ? facilityChanceMult(guest, type) : 1));
}

/** Facility opening hours as text, e.g. "6-9, 17-22". */
export function openingHours(type: FacilityType): string {
  return FACILITY_CONFIG[type].visitChance.map(([from, to]) => `${from}-${to}`).join(', ');
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
  if (open.length === 0 || state.guests.length === 0) return state;
  const T = hourStart(state);
  const types = [...new Set(open.map(f => f.type))];

  // Who wants to go where this hour
  const wants: Array<{ guest: Guest; type: FacilityType; score: number }> = [];
  for (const guest of state.guests) {
    if (isUnderway(guest.trip, T)) continue; // still arriving, or already out (and not yet credited)
    if (!state.rooms.some(r => r.guestId === guest.id && r.status === 'occupied')) continue;
    let best: { type: FacilityType; score: number } | null = null;
    for (const type of types) {
      if (guest.facilitiesUsed?.[type]?.day === state.day) continue; // once a day per type
      const p = visitChance(type, state.hour, state.day, guest);
      if (p <= 0) continue;
      const u = hash01(`${guest.id}|${state.day}|${state.hour}|${type}`);
      if (u < p && (!best || u / p < best.score)) best = { type, score: u / p };
    }
    if (best) wants.push({ guest, ...best });
  }
  if (wants.length === 0) return state;
  wants.sort((a, b) => a.score - b.score || (a.guest.id < b.guest.id ? -1 : 1));

  let current = state;
  for (const { guest, type } of wants) {
    const room = current.rooms.find(r => r.guestId === guest.id);
    if (!room) continue;
    const from = roomTile(room);
    const leave = T + hash01(`${guest.id}|${state.day}|${state.hour}|leave`) * LEAVE_SPREAD;
    // The nearest open facility of the type with room for them, within a short walk
    const options = open
      .filter(f => f.type === type)
      .map(f => ({ f, route: findRoute(current, from, { gridX: f.gridX, gridY: f.gridY, floor: f.floor, door: f.door }, PACE) }))
      .filter((o): o is { f: Facility; route: NonNullable<typeof o.route> } => !!o.route && o.route.hours <= FACILITY_VISITS.maxWalkHours)
      .sort((a, b) => a.route.hours - b.route.hours || (a.f.id < b.f.id ? -1 : 1));
    for (const { f, route } of options) {
      const arrive = leave + route.hours;
      const done = arrive + FACILITY_CONFIG[type].visitHours;
      // The whole party goes, so it has to fit
      if (overlappingVisits(current, f.id, arrive, done) + partyLoad(partySize(guest)) > facilityCapacity(f) + 1e-9) continue;
      const back = findRoute(current, route.path[route.path.length - 1], from, PACE);
      if (!back) continue;
      const trip: Leg[] = [
        makeWalk(route.path, leave, PACE),
        makeStay(route.path[route.path.length - 1], arrive, done, 'visit', { placeId: f.id }),
        makeWalk(back.path, done, PACE),
      ];
      current = { ...current, guests: current.guests.map(g => (g.id === guest.id ? { ...g, trip, tripKind: 'visit' as const } : g)) };
      break;
    }
  }
  return current;
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
  const guests = state.guests.map(g => {
    if (!g.trip?.some(l => l.kind === 'stay' && l.activity === 'visit' && !l.credited && l.start < t)) return g;
    let facilitiesUsed = g.facilitiesUsed;
    const trip = g.trip.map(l => {
      if (l.kind !== 'stay' || l.activity !== 'visit' || l.credited || l.start >= t) return l;
      const f = state.facilities.find(x => x.id === l.placeId);
      if (f) {
        const used = facilitiesUsed?.[f.type];
        facilitiesUsed = { ...facilitiesUsed, [f.type]: { level: Math.max(used?.level ?? 0, f.level), day: Math.floor(l.start / 24) + 1 } };
        cash += FACILITY_CONFIG[f.type].spendPerVisit * FACILITY_LEVELS[f.level - 1].revenueMult * perPersonFactor(partySize(g));
      }
      return { ...l, credited: true };
    });
    changed = true;
    return { ...g, trip, facilitiesUsed };
  });
  return changed ? { ...state, guests, cash } : state;
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
    bonus += b;
  }
  return Math.min(FACILITY_VISITS.maxBonusPerStay, bonus);
}
