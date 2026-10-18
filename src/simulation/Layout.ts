import type { HotelState, Direction, Facility } from './types.js';
import { GRID, DESK, STAFF, TRAVEL } from '../config/balance.js';
import { deskCoverage } from './FrontDesk.js';
import { namedFrontDesk } from './StaffProfiles.js';

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
  routes: Map<string, RouteTree>; // shortest-time trees, by pace and starting tile
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

/** A string that changes whenever anything is built, demolished, or turned (doors) -- for noticing layout changes. */
export function layoutKey(state: HotelState): string {
  return [
    state.floorCount,
    signatureOf(state.rooms, r => r.door),
    signatureOf(state.facilities, f => f.door),
    signatureOf(state.fixtures, f => f.type),
    signatureOf(state.elevators),
  ].join('|');
}

let currentLayoutSig: string | null = null;

function getLayout(state: HotelState): LayoutCache {
  const sig = layoutKey(state);
  let layout = layoutCache.get(sig);
  if (!layout) {
    layout = { walkable: buildWalkableSet(state), routes: new Map() };
    if (layoutCache.size >= MAX_CACHED_LAYOUTS) layoutCache.delete(layoutCache.keys().next().value!);
    layoutCache.set(sig, layout);
  }
  // Route trees are big: only the layout in use keeps them
  if (sig !== currentLayoutSig) {
    if (currentLayoutSig !== null) layoutCache.get(currentLayoutSig)?.routes.clear();
    currentLayoutSig = sig;
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
export function getMannedDeskStaff(state: HotelState, t?: number): number {
  return namedFrontDesk(state) ? deskCoverage(state, t).length : Math.min(state.staff.frontDesk, getAccessibleDesks(state).length * DESK.staffPerDesk);
}

/** Guests that can be checked in per hour. Zero without a reachable, staffed desk. */
export function getCheckInCapacity(state: HotelState): number {
  return namedFrontDesk(state) ? deskCoverage(state).reduce((sum, d) => sum + 1 / d.checkInHours, 0) : getMannedDeskStaff(state) * STAFF.frontDesk.checkInsPerHour;
}

/**
 * Where housekeeping and maintenance start from: the hallway tile in front of
 * each reachable desk (the lobby), staff closet, and staff break room. With
 * none of those, staff come in off the street.
 */
export function getStaffBases(state: HotelState): Pos[] {
  const bases: Pos[] = [];
  for (const f of state.fixtures) {
    if (f.type === 'entrance') continue;
    const front = getFixtureFront(state, f);
    if (front) bases.push(front);
  }
  return bases.length > 0 ? bases : getEntranceTiles(state);
}

/**
 * The hallway tile in front of a desk, closet, or break room -- where guests
 * stand to check in and staff gather: below it if that's a connected hallway,
 * else above, right, or left. Null when no side opens onto one.
 */
export function getFixtureFront(state: HotelState, fixture: Pos): Pos | null {
  const reachable = getReachableSet(state);
  for (const [dx, dy] of FRONT_FIRST) {
    const x = fixture.gridX + dx;
    const y = fixture.gridY + dy;
    if (reachable.has(key(x, y, fixture.floor))) return { gridX: x, gridY: y, floor: fixture.floor };
  }
  return null;
}

/** Whether a tile is a street entrance. */
export function isEntranceTile(state: HotelState, pos: Pos): boolean {
  return pos.floor === 0 && state.fixtures.some(f => f.type === 'entrance' && f.gridX === pos.gridX && f.gridY === pos.gridY);
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

/** How long one step between neighboring path tiles takes: a hallway step at the walker's pace, or an elevator ride. */
export function stepHours(a: Pos, b: Pos, hoursPerTile: number): number {
  return a.floor !== b.floor ? TRAVEL.hoursPerFloor * Math.abs(a.floor - b.floor) : hoursPerTile;
}

/** A walk: the tiles in order (both ends included; a room or facility end keeps its door) and how long it takes. */
export interface Route {
  path: Doorway[];
  hours: number;
}

interface RouteTree {
  hours: Map<string, number>;
  prev: Map<string, string | null>;
  positions: Map<string, Pos>;
}

/** A tiny binary min-heap for Dijkstra. */
class MinHeap<T> {
  private items: Array<{ k: number; v: T }> = [];
  get size() { return this.items.length; }
  push(k: number, v: T) {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { k: number; v: T } {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Shortest-time walks from one tile to every hallway tile it can reach, at a
 * pace (hours per hallway step; elevator rides cost TRAVEL.hoursPerFloor per
 * floor whoever rides). A non-walkable start -- a room, facility, or desk --
 * is left through its door (any side if it has none). Cached per layout.
 */
function routeTree(state: HotelState, from: Doorway, hoursPerTile: number): RouteTree {
  const layout = getLayout(state);
  const cacheKey = `${hoursPerTile}|${key(from.gridX, from.gridY, from.floor)}|${from.door ?? ''}`;
  const cached = layout.routes.get(cacheKey);
  if (cached) return cached;

  const walkable = layout.walkable;
  const startKey = key(from.gridX, from.gridY, from.floor);
  const tree: RouteTree = { hours: new Map(), prev: new Map(), positions: new Map() };
  const heap = new MinHeap<{ pos: Pos; prev: string | null }>();
  const start: Pos = { gridX: from.gridX, gridY: from.gridY, floor: from.floor };
  if (walkable.has(startKey)) {
    heap.push(0, { pos: start, prev: null });
  } else {
    tree.hours.set(startKey, 0);
    tree.prev.set(startKey, null);
    tree.positions.set(startKey, start);
    for (const p of entryTiles(from)) {
      if (inBounds(p.gridX, p.gridY) && walkable.has(key(p.gridX, p.gridY, p.floor))) heap.push(hoursPerTile, { pos: p, prev: startKey });
    }
  }

  while (heap.size > 0) {
    const { k: h, v: { pos, prev } } = heap.pop();
    const pk = key(pos.gridX, pos.gridY, pos.floor);
    if (tree.hours.has(pk)) continue;
    tree.hours.set(pk, h);
    tree.prev.set(pk, prev);
    tree.positions.set(pk, pos);
    for (const next of walkableNeighbors(state, walkable, pos)) {
      const nk = key(next.gridX, next.gridY, next.floor);
      if (!tree.hours.has(nk)) heap.push(h + stepHours(pos, next, hoursPerTile), { pos: next, prev: pk });
    }
  }

  layout.routes.set(cacheKey, tree);
  return tree;
}

function pathTo(tree: RouteTree, endKey: string): Doorway[] {
  const path: Doorway[] = [];
  for (let k: string | null = endKey; k !== null; k = tree.prev.get(k) ?? null) path.unshift({ ...tree.positions.get(k)! });
  return path;
}

/**
 * The quickest walk from one tile to another through connected hallways and
 * elevators, at a pace (TRAVEL.hoursPerTile for staff, guestHoursPerTile for
 * guests). Either end may be a room, facility, or desk, entered and left from
 * the hallway outside it -- through its door if it has one. Null if there's
 * no way through.
 */
export function findRoute(state: HotelState, from: Doorway, to: Doorway, hoursPerTile = TRAVEL.hoursPerTile): Route | null {
  const startKey = key(from.gridX, from.gridY, from.floor);
  const targetKey = key(to.gridX, to.gridY, to.floor);
  if (startKey === targetKey) return { path: [asTile(from)], hours: 0 };

  const tree = routeTree(state, from, hoursPerTile);
  const walkable = getWalkableSet(state);
  let path: Doorway[] | null = null;
  let hours = Infinity;
  if (walkable.has(targetKey)) {
    const h = tree.hours.get(targetKey);
    if (h !== undefined) {
      hours = h;
      path = pathTo(tree, targetKey);
    }
  } else {
    for (const p of entryTiles(to)) {
      const pk = key(p.gridX, p.gridY, p.floor);
      if (!walkable.has(pk)) continue;
      const h = tree.hours.get(pk);
      if (h !== undefined && h + hoursPerTile < hours) {
        hours = h + hoursPerTile;
        path = [...pathTo(tree, pk), { gridX: to.gridX, gridY: to.gridY, floor: to.floor }];
      }
    }
  }
  if (!path) return null;
  path[0] = asTile(from);
  path[path.length - 1] = asTile(to);
  return { path, hours };
}

/** Just the tile (and door) of something placed on the grid. */
function asTile(p: Doorway): Doorway {
  return p.door ? { gridX: p.gridX, gridY: p.gridY, floor: p.floor, door: p.door } : { gridX: p.gridX, gridY: p.gridY, floor: p.floor };
}

/** The tiles of findRoute's walk, or null if there's no way through. */
export function findPath(state: HotelState, from: Doorway, to: Doorway, hoursPerTile = TRAVEL.hoursPerTile): Doorway[] | null {
  return findRoute(state, from, to, hoursPerTile)?.path ?? null;
}

/** The quickest walk between a tile and the nearest street entrance (either way round), or null. */
export function routeToStreet(state: HotelState, from: Doorway, hoursPerTile = TRAVEL.hoursPerTile): Route | null {
  let best: Route | null = null;
  for (const entrance of getEntranceTiles(state)) {
    const route = findRoute(state, from, entrance, hoursPerTile);
    if (route && (!best || route.hours < best.hours)) best = route;
  }
  return best;
}

/** The quickest walk in from the street to a tile, or null. */
export function routeFromStreet(state: HotelState, to: Doorway, hoursPerTile = TRAVEL.hoursPerTile): Route | null {
  let best: Route | null = null;
  for (const entrance of getEntranceTiles(state)) {
    const route = findRoute(state, entrance, to, hoursPerTile);
    if (route && (!best || route.hours < best.hours)) best = route;
  }
  return best;
}
