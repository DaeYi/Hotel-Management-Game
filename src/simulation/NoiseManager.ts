import type { HotelState, Room, Guest, NoiseSource, FacilityType } from './types.js';
import { NOISE, FACILITY_CONFIG, GUEST_PROFILE } from '../config/balance.js';
import { isGuestAway } from './GuestMovement.js';
import { hourStart } from './Movement.js';
import { perPersonFactor, partySize } from './Party.js';
import { isSleepHour, noiseSensitivity, noiseOutputMult, nightOf, sleepHours } from './Profile.js';
import { facilityHours } from './FacilityManager.js';
import { visitorsAt, isAsleepAt } from './Visitors.js';

// Noise (docs/designs/guest-staff-personalities.md, Sleep sensitivity and
// Rowdiness). With guest profiles on, noise is a night-time thing: a guest
// makes noise while they're in their room and awake (a rowdy guest out at a
// bar is silent, one back at 1am is loud), facilities only while they're open,
// and it bothers a guest only while they're in their room in their sleep
// hours, where it's added up night by night (accrueNightNoise) for their
// review. With profiles off it's judged as it always was: everyone in makes
// noise, all day, and a guest's review takes the noise at checkout.

/** Whether noise is judged the night-time way (guest profiles on). */
const nightModel = () => GUEST_PROFILE.enabled;

/** The hour of the day an absolute game time falls in. */
const hourOf = (t: number) => ((Math.floor(t) % 24) + 24) % 24;

/**
 * How much noise a guest in their room makes at time t: the base, times how
 * loud they are (rowdy guests more, late at night more still; by their trait
 * without a profile), times how many of them there are beyond two
 * (perPersonFactor), friends visiting included -- nothing while they're
 * asleep (and they're up while they've visitors in). One function for the
 * noise heard and for who's blamed for it, so the two always agree.
 */
export function occupantNoiseOutput(guest: Guest, t?: number, visitors = 0): number {
  const hour = t === undefined ? 12 : hourOf(t);
  if (visitors <= 0 && nightModel() && t !== undefined && isSleepHour(guest, hour)) return 0;
  return NOISE.baseOccupiedNoise * noiseOutputMult(guest, hour, t) * perPersonFactor(partySize(guest) + Math.max(0, visitors));
}

/** Whether a facility makes noise at an hour: while it's in use (facilityHours), or always, the old way. */
function facilityNoisyAt(type: FacilityType, hour: number): boolean {
  if (!nightModel()) return true;
  return facilityHours(type).some(([from, to]) => hour >= from && hour < to);
}

/** The moment noise is judged at: the middle of the hour being played out. */
const midHour = (state: HotelState) => hourStart(state) + 0.5;

/**
 * Calculate the noise level experienced by a specific room at time t (by
 * default the middle of the current hour).
 * Checks all 8 adjacent cells on the same floor, plus the cells directly above
 * and below (at NOISE.verticalAttenuation strength), for noise sources:
 * - Occupied rooms generate base noise -- while their guest is in (someone
 *   out for the day or at the pool makes no noise in their room)
 * - Guest traits modify noise output (party-prone guests are louder)
 * - Construction zones generate temporary noise
 * - Empty/nonexistent neighbors generate zero noise
 *
 * Returns a noise value from 0 (silent) upward. Higher = worse.
 */
export function calculateRoomNoise(
  room: Room,
  state: HotelState,
  t = midHour(state),
): number {
  let totalNoise = 0;

  for (const [nx, ny, nf, weight] of getNeighborCells(room)) {
    // Check for occupied room at this position
    const neighborRoom = state.rooms.find(r => r.floor === nf && r.gridX === nx && r.gridY === ny);

    if (neighborRoom && neighborRoom.status === 'occupied' && neighborRoom.guestId) {
      // Noise from an occupied neighbor, if they're in: their trait and party size set how much
      const guest = state.guests.find(g => g.id === neighborRoom.guestId);
      const neighborNoise = !guest ? NOISE.baseOccupiedNoise : isGuestAway(guest, t) ? 0 : occupantNoiseOutput(guest, t, visitorsAt(state, guest.id, t));

      totalNoise += neighborNoise * weight;
    }

    // Check for facility noise at this position
    const neighborFacility = state.facilities.find(f => f.floor === nf && f.gridX === nx && f.gridY === ny);
    if (neighborFacility && facilityNoisyAt(neighborFacility.type, hourOf(t))) {
      const fConfig = FACILITY_CONFIG[neighborFacility.type];
      if (fConfig) {
        totalNoise += fConfig.noiseOutput * weight;
      }
    }

    // Check for construction noise at this position
    const construction = state.noiseSources.find(
      ns => ns.floor === nf && ns.gridX === nx && ns.gridY === ny && ns.remainingHours > 0
    );
    if (construction) {
      totalNoise += construction.intensity * weight;
    }
  }

  // Also check construction noise ON this room's own cell
  const selfConstruction = state.noiseSources.find(
    ns => ns.floor === room.floor && ns.gridX === room.gridX && ns.gridY === room.gridY && ns.remainingHours > 0
  );
  if (selfConstruction) {
    totalNoise += selfConstruction.intensity;
  }

  return totalNoise;
}

/**
 * Identify the loudest occupied neighbor room's guest, for Noise Complaint's
 * culprit attribution (design-review D9). Fails closed (returns null) when no
 * neighbor contributes noise, or when the top two neighbors tie -- an
 * ambiguous or arbitrary culprit is worse than no complaint firing that tick.
 */
export function getLoudestNeighborGuestId(room: Room, state: HotelState, t = midHour(state)): string | null {
  let topGuestId: string | null = null;
  let topNoise = 0;
  let tied = false;

  for (const [nx, ny, nf, weight] of getNeighborCells(room)) {
    const neighborRoom = state.rooms.find(r => r.floor === nf && r.gridX === nx && r.gridY === ny);
    if (!neighborRoom || neighborRoom.status !== 'occupied' || !neighborRoom.guestId) continue;

    const guest = state.guests.find(g => g.id === neighborRoom.guestId);
    if (!guest || isGuestAway(guest, t)) continue; // not there: can't be the culprit

    const neighborNoise = occupantNoiseOutput(guest, t, visitorsAt(state, guest.id, t)) * weight;

    if (neighborNoise <= 0) continue;

    if (neighborNoise > topNoise + 1e-9) {
      topNoise = neighborNoise;
      topGuestId = guest.id;
      tied = false;
    } else if (Math.abs(neighborNoise - topNoise) <= 1e-9) {
      tied = true;
    }
  }

  return tied ? null : topGuestId;
}

/**
 * Convert raw noise level to a rating penalty.
 * Factors in the guest's noise sensitivity trait.
 */
export function noiseToRatingPenalty(noise: number, guest: Guest): number {
  if (noise <= NOISE.penaltyThreshold) return 0;

  const excessNoise = noise - NOISE.penaltyThreshold;
  let penalty = excessNoise * NOISE.penaltyPerUnit;

  // Light sleepers suffer more
  penalty *= noiseSensitivity(guest);

  return penalty;
}

/** How much a night's noise is over the threshold for a guest, this hour (0 unless they're in their room asleep: not up with visitors). */
export function nightNoiseThisHour(room: Room, state: HotelState, guest: Guest): number {
  const t = midHour(state);
  if (isGuestAway(guest, t) || !isAsleepAt(state, guest, t)) return 0;
  return Math.max(0, calculateRoomNoise(room, state, t) - NOISE.penaltyThreshold) * noiseSensitivity(guest);
}

const nightNoiseCache = new WeakMap<HotelState, Map<string, number>>();

/**
 * How loud a room gets tonight, while its guest (or, empty, anyone) would be
 * asleep: the loudest of those hours, with everyone where they are now. The
 * noise that matters with guest profiles on (by day nobody minds).
 */
export function nightRoomNoise(room: Room, state: HotelState): number {
  let cache = nightNoiseCache.get(state);
  if (!cache) nightNoiseCache.set(state, (cache = new Map()));
  const cached = cache.get(room.id);
  if (cached !== undefined) return cached;
  const guest = state.guests.find(g => g.id === room.guestId);
  const [from, to] = sleepHours(guest ?? {});
  const dayStart = (state.day - 1) * 24;
  let loudest = 0;
  for (let h = from; h !== to; h = (h + 1) % 24) {
    // Tonight: the hours after midnight are tomorrow's (unless it's already past midnight)
    const t = dayStart + h + 0.5 + (h < from && state.hour >= to ? 24 : 0);
    loudest = Math.max(loudest, calculateRoomNoise(room, { ...state, hour: h }, t));
  }
  cache.set(room.id, loudest);
  return loudest;
}

/**
 * Add this hour's night noise to every sleeping guest's tally (call each
 * tick, before anyone checks out): the noise over the threshold, times how
 * much it bothers them, and each night it woke them. Nothing with profiles off.
 */
export function accrueNightNoise(state: HotelState): HotelState {
  if (!nightModel() || state.guests.length === 0) return state;
  let changed = false;
  const guests = state.guests.map(guest => {
    const room = state.rooms.find(r => r.status === 'occupied' && r.guestId === guest.id);
    if (!room) return guest;
    const excess = nightNoiseThisHour(room, state, guest);
    if (excess <= 0) return guest;
    changed = true;
    const night = nightOf(guest, hourStart(state));
    const before = guest.nightNoise ?? { exposure: 0, woken: 0, lastWokenNight: -Infinity };
    const woke = before.lastWokenNight !== night;
    const lastNight = (woke ? 0 : before.lastNight ?? 0) + excess;
    return { ...guest, nightNoise: { exposure: before.exposure + excess, woken: before.woken + (woke ? 1 : 0), lastWokenNight: night, lastNight } };
  });
  return changed ? { ...state, guests } : state;
}

/**
 * The noise part of a guest's review: the night noise they slept through,
 * averaged over the nights they stayed (with profiles off, the noise in
 * their room right now, as it always was).
 */
export function reviewNoisePenalty(room: Room, state: HotelState, guest: Guest): number {
  if (!nightModel()) return noiseToRatingPenalty(calculateRoomNoise(room, state), guest);
  const nights = Math.max(1, Math.min(guest.stayLength, state.day - guest.checkInDay));
  return Math.min(GUEST_PROFILE.maxNightNoisePenalty, (guest.nightNoise?.exposure ?? 0) / nights * GUEST_PROFILE.nightPenaltyPerUnit);
}


/**
 * Create a construction noise source when building/demolishing/renovating.
 */
export function createConstructionNoise(
  gridX: number,
  gridY: number,
  type: 'build' | 'demolish' | 'renovate',
  floor: number
): NoiseSource {
  return {
    gridX,
    gridY,
    floor,
    intensity: NOISE.constructionIntensity[type],
    remainingHours: NOISE.constructionDuration[type],
    type,
  };
}

/**
 * Tick down construction noise sources. Called each game-hour.
 */
export function tickNoiseSources(sources: NoiseSource[]): NoiseSource[] {
  return sources
    .map(ns => ({ ...ns, remainingHours: ns.remainingHours - 1 }))
    .filter(ns => ns.remainingHours > 0);
}

/**
 * Get all noise levels on one floor (for visualization).
 * Returns a Map of "x,y" -> noise level for every room on that floor.
 */
export function getNoiseMap(state: HotelState, floor: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const room of state.rooms) {
    if (room.floor !== floor) continue;
    const noise = calculateRoomNoise(room, state);
    map.set(`${room.gridX},${room.gridY}`, noise);
  }
  return map;
}

/** [x, y, floor, weight]: the 8 same-floor neighbors at full weight, plus directly above and below. */
function getNeighborCells(room: Room): Array<[number, number, number, number]> {
  const { gridX: x, gridY: y, floor: f } = room;
  return [
    [x - 1, y - 1, f, 1], [x, y - 1, f, 1], [x + 1, y - 1, f, 1],
    [x - 1, y, f, 1],                        [x + 1, y, f, 1],
    [x - 1, y + 1, f, 1], [x, y + 1, f, 1], [x + 1, y + 1, f, 1],
    [x, y, f + 1, NOISE.verticalAttenuation],
    [x, y, f - 1, NOISE.verticalAttenuation],
  ];
}
