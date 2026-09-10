import type { HotelState, Room, Guest, NoiseSource } from './types.js';
import { NOISE, FACILITY_CONFIG } from '../config/balance.js';

/**
 * Calculate the noise level experienced by a specific room.
 * Checks all 8 adjacent cells for noise sources:
 * - Occupied rooms generate base noise
 * - Guest traits modify noise output (party-prone guests are louder)
 * - Construction zones generate temporary noise
 * - Empty/nonexistent neighbors generate zero noise
 *
 * Returns a noise value from 0 (silent) upward. Higher = worse.
 */
export function calculateRoomNoise(
  room: Room,
  state: HotelState
): number {
  let totalNoise = 0;

  // Check all 8 adjacent cells
  const neighbors = getNeighborCoords(room.gridX, room.gridY);

  for (const [nx, ny] of neighbors) {
    // Check for occupied room at this position
    const neighborRoom = state.rooms.find(r => r.gridX === nx && r.gridY === ny);

    if (neighborRoom && neighborRoom.status === 'occupied' && neighborRoom.guestId) {
      // Base noise from an occupied neighbor
      let neighborNoise = NOISE.baseOccupiedNoise;

      // Guest trait modifies noise OUTPUT
      const guest = state.guests.find(g => g.id === neighborRoom.guestId);
      if (guest) {
        const outputMult = NOISE.traitNoiseOutput[guest.trait] ?? 1;
        neighborNoise *= outputMult;
      }

      totalNoise += neighborNoise;
    }

    // Check for facility noise at this position
    const neighborFacility = state.facilities.find(f => f.gridX === nx && f.gridY === ny);
    if (neighborFacility) {
      const fConfig = FACILITY_CONFIG[neighborFacility.type];
      if (fConfig) {
        totalNoise += fConfig.noiseOutput;
      }
    }

    // Check for construction noise at this position
    const construction = state.noiseSources.find(
      ns => ns.gridX === nx && ns.gridY === ny && ns.remainingHours > 0
    );
    if (construction) {
      totalNoise += construction.intensity;
    }
  }

  // Also check construction noise ON this room's own cell
  const selfConstruction = state.noiseSources.find(
    ns => ns.gridX === room.gridX && ns.gridY === room.gridY && ns.remainingHours > 0
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
export function getLoudestNeighborGuestId(room: Room, state: HotelState): string | null {
  const neighbors = getNeighborCoords(room.gridX, room.gridY);
  let topGuestId: string | null = null;
  let topNoise = 0;
  let tied = false;

  for (const [nx, ny] of neighbors) {
    const neighborRoom = state.rooms.find(r => r.gridX === nx && r.gridY === ny);
    if (!neighborRoom || neighborRoom.status !== 'occupied' || !neighborRoom.guestId) continue;

    const guest = state.guests.find(g => g.id === neighborRoom.guestId);
    if (!guest) continue;

    const outputMult = NOISE.traitNoiseOutput[guest.trait] ?? 1;
    const neighborNoise = NOISE.baseOccupiedNoise * outputMult;

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
  type: 'build' | 'demolish' | 'renovate'
): NoiseSource {
  return {
    gridX,
    gridY,
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
 * Get all noise levels for the grid (for visualization).
 * Returns a Map of "x,y" -> noise level for every room.
 */
export function getNoiseMap(state: HotelState): Map<string, number> {
  const map = new Map<string, number>();
  for (const room of state.rooms) {
    const noise = calculateRoomNoise(room, state);
    map.set(`${room.gridX},${room.gridY}`, noise);
  }
  return map;
}

function getNeighborCoords(x: number, y: number): Array<[number, number]> {
  return [
    [x - 1, y - 1], [x, y - 1], [x + 1, y - 1],
    [x - 1, y],                  [x + 1, y],
    [x - 1, y + 1], [x, y + 1], [x + 1, y + 1],
  ];
}
