import type { HotelState, Direction, Facility } from './types.js';
import { GRID, DESK, STAFF, TRAVEL } from '../config/balance.js';

/** A tile position anywhere in the building. */
export interface Pos {
  gridX: number;
  gridY: number;
  floor: number;
}

/** A tile that may have a door (rooms do): it can only be entered or left through that side. */
export type Doorway = Pos & { door?: Direction };

const key = (x: number, y: number, floor: number) => `${floor},${x},${y}`;

const NEIGHBORS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// For desks and the like, the side staff stand on: in front (below) first
const FRONT_FIRST: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]];

export const DIRECTIONS: Direction[] = ['up', 'right', 'down', 'left'];

export const DIRECTION_OFFSETS: Record<Direction, [number, number]> = {
  up: [0, -1],
  right: [1, 0],
  down: [0, 1],
  left: [-1, 0],
};

/** The next door direction clockwise. */
export function rotateDirection(door: Direction): Direction {
  return DIRECTIONS[(DIRECTIONS.indexOf(door) + 1) % DIRECTIONS.length];
}

/** The tile a door opens onto (it may be off the grid or blocked). */
export function doorTile(tile: Pos, door: Direction): Pos {
  const [dx, dy] = DIRECTION_OFFSETS[door];
  return { gridX: tile.gridX + dx, gridY: tile.gridY + dy, floor: tile.floor };
}

/** The tiles a tile can be entered from: just the door tile for a room, any side otherwise. */
function entryTiles(tile: Doorway): Pos[] {
  if (tile.door) return [doorTile(tile, tile.door)];
  return NEIGHBORS.map(([dx, dy]) => ({ gridX: tile.gridX + dx, gridY: tile.gridY + dy, floor: tile.floor }));
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < GRID.width && y >= 0 && y < GRID.height;
}

// Everything below depends only on where things are built, which changes far
// less often than the state (rooms change status every tick). Cache it per
// layout, keyed by a signature of every built position.
interface LayoutCache {
  walkable: Set<string>;
  reachable?: Set<string>;
  travel?: Map<string, number>;
}
const signatureCache = new WeakMap<object, string>();
const layoutCache = new Map<string, LayoutCache>();
const MAX_CACHED_LAYOUTS = 16;

function signatureOf<T extends { gridX: number; gridY: number; floor?: number }>(items: T[], extra: (item: T) => string = () => ''): string {
  let sig = signatureCache.get(items);
  if (sig === undefined) {
    sig = items.map(i => `${i.floor ?? '*'},${i.gridX},${i.gridY}${extra(i)}`).join(';');
    signatureCache.set(items, sig);
  }
  return sig;
}

function getLayout(state: HotelState): LayoutCache {
  const sig = [
    state.floorCount,
    signatureOf(state.rooms, r => r.door),
    signatureOf(state.facilities),
    signatureOf(state.fixtures, f => f.type),
    signatureOf(state.elevators),
  ].join('|');
  let layout = layoutCache.get(sig);
  if (!layout) {
    layout = { walkable: buildWalkableSet(state) };
    if (layoutCache.size >= MAX_CACHED_LAYOUTS) layoutCache.delete(layoutCache.keys().next().value!);
    layoutCache.set(sig, layout);
  }
  return layout;
}

/**
 * Walkable tiles: every tile on a built floor that nothing has been built on
 * is hallway, and elevator shafts are walkable on every floor.
 */
function buildWalkableSet(state: HotelState): Set<string> {
  const walkable = new Set<string>();
  for (let floor = 0; floor < state.floorCount; floor++) {
    for (let y = 0; y < GRID.height; y++) {
      for (let x = 0; x < GRID.width; x++) walkable.add(key(x, y, floor));
    }
  }
  for (const r of state.rooms) walkable.delete(key(r.gridX, r.gridY, r.floor));
  for (const f of state.facilities) walkable.delete(key(f.gridX, f.gridY, f.floor));
  for (const f of state.fixtures) if (f.type !== 'entrance') walkable.delete(key(f.gridX, f.gridY, f.floor));
  return walkable;
}

function getWalkableSet(state: HotelState): Set<string> {
  return getLayout(state).walkable;
}

/** Whether a tile is open hallway (nothing built on it, or an elevator shaft). */
export function isHallway(state: HotelState, gridX: number, gridY: number, floor: number): boolean {
  return getWalkableSet(state).has(key(gridX, gridY, floor));
}

/** Whether a tile is on the outer edge of the floor plan (where a street entrance can go). */
export function isEdgeTile(gridX: number, gridY: number): boolean {
  return gridX === 0 || gridY === 0 || gridX === GRID.width - 1 || gridY === GRID.height - 1;
}

/** Street entrances: the only way in from the street. */
export function getEntranceTiles(state: HotelState): Pos[] {
  return state.fixtures
    .filter(f => f.type === 'entrance')
    .map(f => ({ gridX: f.gridX, gridY: f.gridY, floor: f.floor }));
}

/** The entrance guests use: the one nearest a check-in desk (or the first, without a desk). */
export function getFrontDoor(state: HotelState): Pos | null {
  const entrances = getEntranceTiles(state);
  const desk = getAccessibleDesks(state)[0];
  if (!desk) return entrances[0] ?? null;
  const dist = (p: Pos) => Math.abs(p.gridX - desk.gridX) + Math.abs(p.gridY - desk.gridY);
  return entrances.reduce<Pos | null>((best, p) => (best === null || dist(p) < dist(best) ? p : best), null);
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

/** Every walkable tile connected to the street entrance. */
function getReachableSet(state: HotelState): Set<string> {
  const layout = getLayout(state);
  if (layout.reachable) return layout.reachable;

  const walkable = layout.walkable;
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

  layout.reachable = reachable;
  return reachable;
}

/** Whether a tile is open hallway connected to the street. */
export function isReachableHallway(state: HotelState, pos: Pos): boolean {
  return getReachableSet(state).has(key(pos.gridX, pos.gridY, pos.floor));
}

/**
 * A tile is accessible when it can be entered from a hallway connected to the
 * street: through its door for a room, from any side for desks and the like.
 */
export function isTileAccessible(state: HotelState, gridX: number, gridY: number, floor: number, door?: Direction): boolean {
  const reachable = getReachableSet(state);
  return entryTiles({ gridX, gridY, floor, door }).some(p => reachable.has(key(p.gridX, p.gridY, p.floor)));
}

/**
 * The first door direction -- up, down, right, left, so rooms in rows face
 * the corridor between them -- that opens onto a hallway connected to the
 * street, or null if none does.
 */
export function findOpenDoor(state: HotelState, tile: Pos): Direction | null {
  return (['up', 'down', 'right', 'left'] as Direction[]).find(d => isReachableHallway(state, doorTile(tile, d))) ?? null;
}

/** Whether guests can get into a facility: its door opens onto hallway connected to the street. */
export function isFacilityOpen(state: HotelState, facility: Facility): boolean {
  return isTileAccessible(state, facility.gridX, facility.gridY, facility.floor, facility.door);
}

/** Facilities guests can get into. A facility with a blocked door earns no stars and no review bonus (but still costs upkeep). */
export function getOpenFacilities(state: HotelState): Facility[] {
  return state.facilities.filter(f => isFacilityOpen(state, f));
}

/** Check-in desks guests can actually walk up to. */
export function getAccessibleDesks(state: HotelState) {
  return state.fixtures.filter(f => f.type === 'desk' && isTileAccessible(state, f.gridX, f.gridY, f.floor));
}

/** Staff break rooms that staff can walk into. */
export function getAccessibleBreakRooms(state: HotelState) {
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
 * none of those, staff come in off the street.
 */
export function getStaffBases(state: HotelState): Pos[] {
  const reachable = getReachableSet(state);
  const bases: Pos[] = [];
  for (const f of state.fixtures) {
    if (f.type === 'entrance') continue;
    for (const [dx, dy] of FRONT_FIRST) {
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

/** Walking time (hours) from the nearest staff base to every reachable walkable tile. */
function getTravelMap(state: HotelState): Map<string, number> {
  const layout = getLayout(state);
  if (layout.travel) return layout.travel;

  const walkable = layout.walkable;
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

  layout.travel = hours;
  return hours;
}

/**
 * How long staff take to walk from their nearest base to a room's door, in
 * hours (one step further than the hallway tile outside it). Infinity when no
 * route exists -- staff can't service that room.
 */
export function getStaffTravelHours(state: HotelState, room: Doorway): number {
  const hours = getTravelMap(state);
  let best = Infinity;
  for (const p of entryTiles(room)) {
    const h = hours.get(key(p.gridX, p.gridY, p.floor));
    if (h !== undefined) best = Math.min(best, h + TRAVEL.hoursPerTile);
  }
  return best;
}

/**
 * Shortest walk from one tile to another through connected hallways and
 * elevators (riding a shaft counts as one step per floor). Either end may be
 * a non-walkable tile such as a room or desk, entered from an adjacent
 * hallway -- through its door, for a room. Returns the tiles in order
 * including both ends, or null if there's no route.
 */
export function findPath(state: HotelState, from: Doorway, to: Doorway): Pos[] | null {
  const walkable = getWalkableSet(state);
  const targetKey = key(to.gridX, to.gridY, to.floor);
  const startKey = key(from.gridX, from.gridY, from.floor);
  const start: Pos = { gridX: from.gridX, gridY: from.gridY, floor: from.floor };
  if (startKey === targetKey) return [start];
  const targetEntries = new Set(entryTiles(to).map(p => key(p.gridX, p.gridY, p.floor)));

  const cameFrom = new Map<string, string | null>([[startKey, null]]);
  const positions = new Map<string, Pos>([[startKey, start]]);
  const queue: Pos[] = [start];

  const stepsFrom = (pos: Pos): Pos[] => {
    const posKey = key(pos.gridX, pos.gridY, pos.floor);
    const steps = walkable.has(posKey) ? walkableNeighbors(state, walkable, pos) : [];
    // From a non-walkable start (a room or desk), step out into the hallway (through the door)
    if (!walkable.has(posKey)) {
      for (const p of entryTiles(posKey === startKey ? from : pos)) {
        if (inBounds(p.gridX, p.gridY) && walkable.has(key(p.gridX, p.gridY, p.floor))) steps.push(p);
      }
    }
    // The (non-walkable) destination is entered from the hallway outside its door
    if (targetEntries.has(posKey) && walkable.has(posKey)) {
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
