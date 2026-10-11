import type { HotelState, Room, Guest, NoiseSource } from './types.js';
import { NOISE, FACILITY_CONFIG } from '../config/balance.js';
import { isGuestAway } from './GuestMovement.js';
import { hourStart } from './Movement.js';

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
      // Base noise from an occupied neighbor, if they're in
      let neighborNoise = NOISE.baseOccupiedNoise;

      // Guest trait modifies noise OUTPUT
      const guest = state.guests.find(g => g.id === neighborRoom.guestId);
      if (guest && isGuestAway(guest, t)) neighborNoise = 0;
      else if (guest) {
        const outputMult = NOISE.traitNoiseOutput[guest.trait] ?? 1;
        neighborNoise *= outputMult;
      }

      totalNoise += neighborNoise * weight;
    }

    // Check for facility noise at this position
    const neighborFacility = state.facilities.find(f => f.floor === nf && f.gridX === nx && f.gridY === ny);
    if (neighborFacility) {
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

    const outputMult = NOISE.traitNoiseOutput[guest.trait] ?? 1;
    const neighborNoise = NOISE.baseOccupiedNoise * outputMult * weight;

    if (neighborNoise <= 0) continue;

    if (neighborNoise > topNoise) {
      topNoise = neighborNoise;
      topGuestId = guest.id;
      tied = false;
    } else if (neighborNoise === topNoise) {
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
  const sensitivityMult = NOISE.traitNoiseSensitivity[guest.trait] ?? 1;
  penalty *= sensitivityMult;

  return penalty;
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
