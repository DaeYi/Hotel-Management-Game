import type { HotelState, Leg, WalkLeg, StayLeg, TilePos } from './types.js';
import { stepHours, isHallway, doorTile } from './Layout.js';

// People move on itineraries: legs of walking and staying, timed in absolute
// game hours ((day - 1) * 24 + hour, plus the fraction of the hour). The
// simulation plans and acts on these legs, and the renderer draws everyone
// wherever their legs put them at the current time -- so what's on screen is
// what the simulation is doing, at every speed, across reloads and catch-up
// frames.

/** The absolute game hour the current hour started at. */
export function hourStart(state: Pick<HotelState, 'day' | 'hour'>): number {
  return (state.day - 1) * 24 + state.hour;
}

/** The absolute game time a tick happens at: the end of the current hour. */
export function hourEnd(state: Pick<HotelState, 'day' | 'hour'>): number {
  return hourStart(state) + 1;
}

/** A walk along a path, starting at `start`, at a pace. */
export function makeWalk(path: TilePos[], start: number, hoursPerTile: number): WalkLeg {
  let end = start;
  for (let i = 1; i < path.length; i++) end += stepHours(path[i - 1], path[i], hoursPerTile);
  return { kind: 'walk', start, end, path, hoursPerTile };
}

/** A stay at a tile from `start` to `end`. */
export function makeStay(at: TilePos, start: number, end: number, activity: StayLeg['activity'], extra: Partial<StayLeg> = {}): StayLeg {
  return { kind: 'stay', start, end, at, activity, ...extra };
}

/** When a list of legs is over (-Infinity for none). */
export function legsEnd(legs: Leg[] | null | undefined): number {
  return legs && legs.length > 0 ? legs[legs.length - 1].end : -Infinity;
}

/** Whether a trip is still under way at time t (it has begun or is about to: legs cover [start, end)). */
export function isUnderway(legs: Leg[] | null | undefined, t: number): boolean {
  return !!legs && legs.length > 0 && t < legsEnd(legs);
}

/** Where the legs end up: the last stay's tile, or the last tile walked to (doors kept). */
export function finalTile(legs: Leg[]): TilePos | null {
  const last = legs[legs.length - 1];
  if (!last) return null;
  return last.kind === 'stay' ? last.at : last.path[last.path.length - 1];
}

/** Where someone is at a moment: continuous tile coordinates, and the leg they're on. */
export interface Placement {
  x: number;
  y: number;
  floor: number;
  leg: Leg;
  moving: boolean;
}

/**
 * Where legs put someone at time t. Before the first leg starts they're at
 * its beginning; after the last ends, at its end. An elevator ride keeps them
 * in the shaft, on the floor they left for the first half of the ride and the
 * floor they're heading to for the second.
 */
export function positionAt(legs: Leg[], t: number): Placement | null {
  if (legs.length === 0) return null;
  let leg = legs[0];
  for (const l of legs) {
    if (t < l.start) break;
    leg = l;
  }
  if (leg.kind === 'stay') return { x: leg.at.gridX, y: leg.at.gridY, floor: leg.at.floor, leg, moving: false };

  const path = leg.path;
  if (t <= leg.start || path.length === 1) return { x: path[0].gridX, y: path[0].gridY, floor: path[0].floor, leg, moving: path.length > 1 && t >= leg.start };
  let time = leg.start;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dt = stepHours(a, b, leg.hoursPerTile);
    if (t < time + dt) {
      const f = dt > 0 ? (t - time) / dt : 1;
      if (a.floor !== b.floor) return { x: a.gridX, y: a.gridY, floor: f < 0.5 ? a.floor : b.floor, leg, moving: true };
      return { x: a.gridX + (b.gridX - a.gridX) * f, y: a.gridY + (b.gridY - a.gridY) * f, floor: a.floor, leg, moving: true };
    }
    time += dt;
  }
  const end = path[path.length - 1];
  return { x: end.gridX, y: end.gridY, floor: end.floor, leg, moving: false };
}

/** How far apart a party's members walk, in tiles. */
export const PARTY_SPACING = 0.5;

/**
 * Where member `index` of a party on these legs is at time t (member 0 is
 * the one whose legs they are: positionAt). The others walk ahead of them,
 * PARTY_SPACING tiles apart, along the same path: on each stretch of walking
 * (between stops -- the start, each stay, the end) they set off together,
 * draw ahead, then ease back so everyone gets there at the same moment. So a
 * party leaves a room no later than its first member would, arrives together
 * (at the desk, the gym, their room), and is all in one place while stopped.
 * Pure: the drawing and the tests use the same positions.
 */
export function memberPositionAt(legs: Leg[], t: number, index: number, hoursPerTile: number): Placement | null {
  if (index <= 0 || legs.length === 0) return positionAt(legs, t);
  if (t <= legs[0].start || t >= legsEnd(legs)) return positionAt(legs, t);
  // The stretch of walking t is in: back to the last stop, on to the next
  let k = 0;
  for (let i = 0; i < legs.length; i++) if (legs[i].start <= t) k = i;
  if (legs[k].kind === 'stay') return positionAt(legs, t);
  let from = k;
  while (from > 0 && legs[from - 1].kind === 'walk') from--;
  let to = k;
  while (to < legs.length - 1 && legs[to + 1].kind === 'walk') to++;
  let s = legs[from].start;
  let e = legs[to].end;
  // A ride in the lift is a stop too: everyone boards together and gets off together
  for (let i = from; i <= to; i++) {
    const leg = legs[i];
    if (leg.kind !== 'walk') continue;
    let time = leg.start;
    for (let j = 1; j < leg.path.length; j++) {
      const dt = stepHours(leg.path[j - 1], leg.path[j], leg.hoursPerTile);
      if (leg.path[j - 1].floor !== leg.path[j].floor) {
        if (time + dt <= t) s = Math.max(s, time + dt);
        else if (time >= t) e = Math.min(e, time);
        else return positionAt(legs, t); // riding: all in the lift
      }
      time += dt;
    }
  }
  const lead = index * PARTY_SPACING * hoursPerTile;
  const ahead = Math.max(0, Math.min(lead, t - s, (e - t) / 2));
  return positionAt(legs, t + ahead);
}

/**
 * The path tile someone has most recently reached at time t on a walk (where
 * a walk cut short at t can be resumed from), and the walk's tiles before it.
 */
export function walkProgress(leg: WalkLeg, t: number): { tile: TilePos; index: number } {
  let time = leg.start;
  let index = 0;
  for (let i = 1; i < leg.path.length; i++) {
    time += stepHours(leg.path[i - 1], leg.path[i], leg.hoursPerTile);
    if (time > t) break;
    index = i;
  }
  return { tile: leg.path[index], index };
}

/**
 * Cut legs short at time t: legs that are over are kept, a walk under way
 * stops at the tile reached, and a stay under way ends at t. Returns the kept
 * legs and the tile they leave off at (null if t is before they begin).
 */
export function truncateLegs(legs: Leg[], t: number): { legs: Leg[]; at: TilePos | null; time: number } {
  const kept: Leg[] = [];
  let at: TilePos | null = null;
  let time = t;
  for (const leg of legs) {
    if (leg.start >= t) break;
    if (leg.end <= t) {
      kept.push(leg);
      at = leg.kind === 'stay' ? leg.at : leg.path[leg.path.length - 1];
      continue;
    }
    if (leg.kind === 'stay') {
      kept.push({ ...leg, end: t });
      at = leg.at;
    } else {
      const { tile, index } = walkProgress(leg, t);
      const walked = makeWalk(leg.path.slice(0, index + 1), leg.start, leg.hoursPerTile);
      if (walked.path.length > 1) kept.push(walked);
      at = tile;
      time = Math.max(t, walked.end);
    }
    break;
  }
  if (!at && legs.length > 0 && legs[0].start < t) at = legs[0].kind === 'stay' ? legs[0].at : legs[0].path[0];
  return { legs: kept, at, time };
}

/** Whether two tiles are the same tile (doors aside). */
export function sameTile(a: TilePos | null | undefined, b: TilePos | null | undefined): boolean {
  return !!a && !!b && a.gridX === b.gridX && a.gridY === b.gridY && a.floor === b.floor;
}

/**
 * A deterministic number in [0, 1) from a string -- for choices that must not
 * consume the shared PRNG (which would shift every other random roll), like
 * who heads to the gym this hour. FNV-1a, then a murmur3 finalizer.
 */
export function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Whether a step from one path tile to the next can still be taken in the building as it is now. */
export function stepStillOpen(state: HotelState, a: TilePos, b: TilePos): boolean {
  if (a.floor !== b.floor) {
    return a.gridX === b.gridX && a.gridY === b.gridY && Math.max(a.floor, b.floor) < state.floorCount
      && state.elevators.some(e => e.gridX === a.gridX && e.gridY === a.gridY);
  }
  if (Math.abs(a.gridX - b.gridX) + Math.abs(a.gridY - b.gridY) !== 1) return false;
  const doorOk = (inside: TilePos, outside: TilePos) => {
    const place = state.rooms.find(r => sameTile(r, inside)) ?? state.facilities.find(f => sameTile(f, inside));
    return !!place && place.door === inside.door && sameTile(doorTile(inside, place.door), outside);
  };
  if (b.door) return doorOk(b, a);
  if (a.door) return doorOk(a, b) && isHallway(state, b.gridX, b.gridY, b.floor);
  return isHallway(state, b.gridX, b.gridY, b.floor);
}
