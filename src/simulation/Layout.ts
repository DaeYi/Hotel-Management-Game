import type { HotelState, Fixture, Elevator } from './types.js';
import { GRID, DESK, STAFF, TRAVEL } from '../config/balance.js';

/** A tile position anywhere in the building. */
export interface Pos {
  gridX: number;
  gridY: number;
  floor: number;
}

const key = (x: number, y: number, floor: number) => `${floor},${x},${y}`;

const NEIGHBORS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < GRID.width && y >= 0 && y < GRID.height;
}

/** Walkable tiles: hallways, plus elevator shafts on every built floor. */
function getWalkableSet(state: HotelState): Set<string> {
  const walkable = new Set<string>();
  for (const f of state.fixtures) {
    if (f.type === 'hallway') walkable.add(key(f.gridX, f.gridY, f.floor));
  }
  for (const e of state.elevators) {
    for (let floor = 0; floor < state.floorCount; floor++) walkable.add(key(e.gridX, e.gridY, floor));
  }
  return walkable;
}

/** Street entrances: hallway tiles on the ground floor's outer edge. */
export function getEntranceTiles(state: HotelState): Pos[] {
  return state.fixtures
    .filter(f => f.type === 'hallway' && f.floor === 0
      && (f.gridX === 0 || f.gridY === 0 || f.gridX === GRID.width - 1 || f.gridY === GRID.height - 1))
    .map(f => ({ gridX: f.gridX, gridY: f.gridY, floor: 0 }));
}

/** Walkable neighbors of a walkable tile: same-floor hallway steps, plus the same shaft on other floors. */
function walkableNeighbors(state: HotelState, walkable: Set<string>, pos: Pos): Pos[] {
  const out: Pos[] = [];
  for (const [dx, dy] of NEIGHBORS) {
    const x = pos.gridX + dx;
    const y = pos.gridY + dy;
    if (inBounds(x, y) && walkable.has(key(x, y, pos.floor))) out.push({ gridX: x, gridY: y, floor: pos.floor });
  }
  if (state.elevators.some(e => e.gridX === pos.gridX && e.gridY === pos.gridY)) {
    for (let floor = 0; floor < state.floorCount; floor++) {
      if (floor !== pos.floor) out.push({ gridX: pos.gridX, gridY: pos.gridY, floor });
    }
  }
  return out;
}

// Reachability only changes when fixtures, elevators, or floors change, but is
// asked for every room on every tick and render -- cache it per layout.
const reachCache = new WeakMap<Fixture[], { elevators: Elevator[]; floorCount: number; reachable: Set<string> }>();

/** Every walkable tile connected to the street entrance. */
function getReachableSet(state: HotelState): Set<string> {
  const cached = reachCache.get(state.fixtures);
  if (cached && cached.elevators === state.elevators && cached.floorCount === state.floorCount) return cached.reachable;

  const walkable = getWalkableSet(state);
  const reachable = new Set<string>();
  const queue: Pos[] = getEntranceTiles(state);
  for (const p of queue) reachable.add(key(p.gridX, p.gridY, p.floor));

  while (queue.length > 0) {
    const pos = queue.shift()!;
    for (const next of walkableNeighbors(state, walkable, pos)) {
      const k = key(next.gridX, next.gridY, next.floor);
      if (!reachable.has(k)) {
        reachable.add(k);
        queue.push(next);
      }
    }
  }

  reachCache.set(state.fixtures, { elevators: state.elevators, floorCount: state.floorCount, reachable });
  return reachable;
}

/** A tile is accessible when one of its four sides opens onto a hallway connected to the street. */
export function isTileAccessible(state: HotelState, gridX: number, gridY: number, floor: number): boolean {
  const reachable = getReachableSet(state);
  return NEIGHBORS.some(([dx, dy]) => reachable.has(key(gridX + dx, gridY + dy, floor)));
}

/** Check-in desks guests can actually walk up to. */
export function getAccessibleDesks(state: HotelState): Fixture[] {
  return state.fixtures.filter(f => f.type === 'desk' && isTileAccessible(state, f.gridX, f.gridY, f.floor));
}

/** Staff break rooms that staff can walk into. */
export function getAccessibleBreakRooms(state: HotelState): Fixture[] {
  return state.fixtures.filter(f => f.type === 'breakroom' && isTileAccessible(state, f.gridX, f.gridY, f.floor));
}

/** Front desk staff actually working: each accessible desk seats DESK.staffPerDesk. */
export function getMannedDeskStaff(state: HotelState): number {
  return Math.min(state.staff.frontDesk, getAccessibleDesks(state).length * DESK.staffPerDesk);
}

/** Guests that can be checked in per hour. Zero without a reachable, staffed desk. */
export function getCheckInCapacity(state: HotelState): number {
  return getMannedDeskStaff(state) * STAFF.frontDesk.checkInsPerHour;
}

/**
 * Where housekeeping and maintenance start from: the hallway tile in front of
 * each reachable desk (the lobby), staff closet, and staff break room. With
 * neither, staff come in off the street.
 */
export function getStaffBases(state: HotelState): Pos[] {
  const reachable = getReachableSet(state);
  const bases: Pos[] = [];
  for (const f of state.fixtures) {
    if (f.type === 'hallway') continue;
    for (const [dx, dy] of NEIGHBORS) {
      const x = f.gridX + dx;
      const y = f.gridY + dy;
      if (reachable.has(key(x, y, f.floor))) {
        bases.push({ gridX: x, gridY: y, floor: f.floor });
        break;
      }
    }
  }
  return bases.length > 0 ? bases : getEntranceTiles(state);
}

// Travel times depend only on the layout, like reachability -- cache them too.
const travelCache = new WeakMap<Fixture[], { elevators: Elevator[]; floorCount: number; hours: Map<string, number> }>();

/** Walking time (hours) from the nearest staff base to every reachable walkable tile. */
function getTravelMap(state: HotelState): Map<string, number> {
  const cached = travelCache.get(state.fixtures);
  if (cached && cached.elevators === state.elevators && cached.floorCount === state.floorCount) return cached.hours;

  const walkable = getWalkableSet(state);
  const hours = new Map<string, number>();
  const frontier: Array<{ pos: Pos; h: number }> = getStaffBases(state).map(pos => ({ pos, h: 0 }));

  // Dijkstra over a tiny graph: steps cost hoursPerTile, elevator rides hoursPerFloor
  while (frontier.length > 0) {
    frontier.sort((a, b) => a.h - b.h);
    const { pos, h } = frontier.shift()!;
    const k = key(pos.gridX, pos.gridY, pos.floor);
    if (hours.has(k)) continue;
    hours.set(k, h);
    for (const next of walkableNeighbors(state, walkable, pos)) {
      const nk = key(next.gridX, next.gridY, next.floor);
      if (hours.has(nk)) continue;
      const cost = next.floor !== pos.floor ? TRAVEL.hoursPerFloor * Math.abs(next.floor - pos.floor) : TRAVEL.hoursPerTile;
      frontier.push({ pos: next, h: h + cost });
    }
  }

  travelCache.set(state.fixtures, { elevators: state.elevators, floorCount: state.floorCount, hours });
  return hours;
}

/**
 * How long staff take to walk from their nearest base to a room's door, in
 * hours (one step further than the hallway tile outside). Infinity when no
 * route exists -- staff can't service that room.
 */
export function getStaffTravelHours(state: HotelState, room: { gridX: number; gridY: number; floor: number }): number {
  const hours = getTravelMap(state);
  let best = Infinity;
  for (const [dx, dy] of NEIGHBORS) {
    const h = hours.get(key(room.gridX + dx, room.gridY + dy, room.floor));
    if (h !== undefined) best = Math.min(best, h + TRAVEL.hoursPerTile);
  }
  return best;
}

/**
 * Shortest walk from one tile to another through connected hallways and
 * elevators (riding a shaft counts as one step per floor). Either end may be
 * a non-walkable tile such as a room or desk, entered from an adjacent
 * hallway. Returns the tiles in order including both ends, or null if
 * there's no route.
 */
export function findPath(state: HotelState, from: Pos, to: Pos): Pos[] | null {
  const walkable = getWalkableSet(state);
  const targetKey = key(to.gridX, to.gridY, to.floor);
  const startKey = key(from.gridX, from.gridY, from.floor);
  const start: Pos = { gridX: from.gridX, gridY: from.gridY, floor: from.floor };
  if (startKey === targetKey) return [start];

  const cameFrom = new Map<string, string | null>([[startKey, null]]);
  const positions = new Map<string, Pos>([[startKey, start]]);
  const queue: Pos[] = [start];

  const stepsFrom = (pos: Pos): Pos[] => {
    const steps = walkable.has(key(pos.gridX, pos.gridY, pos.floor)) ? walkableNeighbors(state, walkable, pos) : [];
    // From a non-walkable start (a room or desk), step out into adjacent hallways
    if (!walkable.has(key(pos.gridX, pos.gridY, pos.floor))) {
      for (const [dx, dy] of NEIGHBORS) {
        const x = pos.gridX + dx;
        const y = pos.gridY + dy;
        if (inBounds(x, y) && walkable.has(key(x, y, pos.floor))) steps.push({ gridX: x, gridY: y, floor: pos.floor });
      }
    }
    // The (non-walkable) destination can be entered from any adjacent walkable tile
    if (pos.floor === to.floor && Math.abs(pos.gridX - to.gridX) + Math.abs(pos.gridY - to.gridY) === 1
      && walkable.has(key(pos.gridX, pos.gridY, pos.floor))) {
      steps.push({ gridX: to.gridX, gridY: to.gridY, floor: to.floor });
    }
    return steps;
  };

  while (queue.length > 0) {
    const pos = queue.shift()!;
    const posKey = key(pos.gridX, pos.gridY, pos.floor);
    if (posKey === targetKey) break;
    if (posKey !== startKey && !walkable.has(posKey)) continue; // never walk through rooms

    for (const next of stepsFrom(pos)) {
      const k = key(next.gridX, next.gridY, next.floor);
      if (!cameFrom.has(k)) {
        cameFrom.set(k, posKey);
        positions.set(k, next);
        queue.push(next);
      }
    }
  }

  if (!cameFrom.has(targetKey)) return null;
  const path: Pos[] = [];
  for (let k: string | null = targetKey; k !== null; k = cameFrom.get(k) ?? null) {
    path.unshift(positions.get(k)!);
  }
  return path;
}
