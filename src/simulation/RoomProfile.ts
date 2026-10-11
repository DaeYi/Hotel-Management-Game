import type { Room, RoomType, Furnishing, FurnitureItem, Direction, Party } from './types.js';
import {
  FURNITURE, ROOM_PRESETS, PRESET_FOR_TYPE, FURNISHING, ROOM_CELLS, GROUP_KINDS,
  type PresetId, type ArrangementId, type Tier, type Rot, type FurnitureKind, type FurnitureGroup,
} from '../config/furniture.js';
import { ROOM_CONFIG } from '../config/balance.js';

// What a room is, worked out from what's in it (docs/designs/rooms-rethink.md).
// The player never picks "deluxe" or "family": they furnish a room, and the
// furniture decides who it fits (its class: single, double, twin, family) and
// how nice it is (its grade). A room nice enough (FURNISHING.deluxeQuality) is
// deluxe; deluxe with a lounge is a junior suite. room.type holds the result as
// the original standard / deluxe / suite category, so prices, stars and
// amenities read it as before -- and a room furnished like one of the
// original types is exactly that type, at exactly its numbers.

export type WallEdge = 'top' | 'right' | 'bottom' | 'left';
const EDGES: WallEdge[] = ['top', 'right', 'bottom', 'left'];

/** A piece with its rectangle in the room (door-local cells, door on the bottom edge). */
export interface PlacedItem extends FurnitureItem {
  w: number;
  h: number;
  group: FurnitureGroup;
  wall: boolean;
  edge: WallEdge; // a wall piece: the edge of its cell it hangs on; a bed: the edge its head is against
}

/** Who a room fits: one person, a couple in one bed, two in separate beds, or three or more. */
export type LayoutClass = 'single' | 'double' | 'twin' | 'family';

export type RoomIssueCode = 'no_bed' | 'no_bath' | 'outside' | 'size' | 'overlap' | 'doorway' | 'unreachable' | 'wall';
export interface RoomIssue {
  code: RoomIssueCode;
  itemId?: string;
  message: string;
}

export interface RoomProfile {
  type: RoomType; // the category: standard / deluxe / suite
  layoutClass: LayoutClass;
  label: string; // "Standard Queen", "Deluxe Twin", "Standard Family Room", "Junior Suite"
  quality: number; // weighted tier average, 1-2
  sleeps: number; // people it sleeps when they'll share a bed (couples, families)
  beds: number; // people it sleeps when nobody shares a bed (friends, colleagues)
  hasLounge: boolean;
  items: PlacedItem[];
  furnishingCost: number; // shell + furniture: what it would cost to build like this
  freeCells: number; // floor not taken by furniture
  issues: RoomIssue[]; // why it can't be sold (empty: it can)
}

/** A piece's rectangle and facing. */
export function placeItem(item: FurnitureItem): PlacedItem {
  const spec = FURNITURE[item.kind];
  const w0 = spec.size[0];
  const h0 = item.length ?? spec.size[1];
  const turned = item.rot % 2 === 1;
  return { ...item, w: turned ? h0 : w0, h: turned ? w0 : h0, group: spec.group, wall: !!spec.wall, edge: EDGES[item.rot] };
}

/** A preset's pieces in an arrangement, with the given kinds and tiers (by piece id), mirrored or not. */
function presetItems(preset: PresetId, arrangement: ArrangementId, mirrored: boolean, kinds: Record<string, { kind: FurnitureKind; tier: Tier }>): FurnitureItem[] {
  const pieces = ROOM_PRESETS[preset].arrangements[arrangement].pieces;
  const items: FurnitureItem[] = pieces
    .filter(p => kinds[p.id])
    .map(p => ({ id: p.id, kind: kinds[p.id].kind, tier: kinds[p.id].tier, x: p.x, y: p.y, rot: p.rot ?? 0, ...(p.length ? { length: p.length } : {}) }));
  return mirrored ? mirrorItems(items) : items;
}

/** Pieces flipped left to right. */
export function mirrorItems(items: FurnitureItem[]): FurnitureItem[] {
  return items.map(item => {
    const { w } = placeItem(item);
    const rot = (item.rot % 2 === 1 ? (item.rot + 2) % 4 : item.rot) as Rot;
    return { ...item, x: ROOM_CELLS - item.x - w, rot };
  });
}

/** The furnishing a room of a preset is built with: its default pieces. */
export function defaultFurnishing(preset: PresetId, arrangement: ArrangementId = 'bath_front', mirrored = false): Furnishing {
  return { preset, arrangement, mirrored, items: presetItems(preset, arrangement, mirrored, ROOM_PRESETS[preset].defaults) };
}

/** Lay pieces out per their preset's arrangement, by id, keeping kinds and tiers (pieces the arrangement has no place for are dropped). */
export function arrangeItems(preset: PresetId, arrangement: ArrangementId, mirrored: boolean, items: Array<Pick<FurnitureItem, 'kind' | 'tier'> & { id: string }>): FurnitureItem[] {
  return presetItems(preset, arrangement, mirrored, Object.fromEntries(items.map(i => [i.id, { kind: i.kind, tier: i.tier }])));
}

/** A room's furnishing (rooms from before furniture, or built in tests, get their type's preset). */
export function furnishingOf(room: Pick<Room, 'type' | 'furnishing'>): Furnishing {
  return room.furnishing ?? defaultFurnishing(PRESET_FOR_TYPE[room.type]);
}

/** Every floor cell a rectangle covers. */
export function cellsOf(r: { x: number; y: number; w: number; h: number }): string[] {
  const cells: string[] = [];
  for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) cells.push(`${x},${y}`);
  return cells;
}

/** The cells just inside the door: they stay clear. */
export const DOORWAY_CELLS = ['1,3', '2,3'];
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * What's wrong with a layout, if anything: a room needs a bed and a bathroom,
 * every piece on the grid and on nothing else, the doorway clear, every piece
 * reachable on foot from the doorway, and wall pieces on a wall (the room's,
 * or the outside of the bathroom's).
 */
function checkLayout(items: PlacedItem[]): RoomIssue[] {
  const issues: RoomIssue[] = [];
  const label = (i: PlacedItem) => FURNITURE[i.kind].label.toLowerCase();
  if (!items.some(i => i.group === 'bed')) issues.push({ code: 'no_bed', message: 'Needs a bed' }); // a sofa bed is extra, not the bed
  if (!items.some(i => i.group === 'bath')) issues.push({ code: 'no_bath', message: 'Needs a bathroom' });

  for (const item of items) {
    const spec = FURNITURE[item.kind];
    if (item.length !== undefined && item.length !== spec.size[1] && !(spec.sizes ?? []).some(([w, h]) => w === spec.size[0] && h === item.length)) {
      issues.push({ code: 'size', itemId: item.id, message: `The ${label(item)} doesn't come in that size` });
    }
    if (item.x < 0 || item.y < 0 || item.x + item.w > ROOM_CELLS || item.y + item.h > ROOM_CELLS) {
      issues.push({ code: 'outside', itemId: item.id, message: `The ${label(item)} doesn't fit in the room there` });
    }
  }
  const floor = items.filter(i => !i.wall);
  const taken = new Map<string, string>();
  for (const item of floor) {
    let overlaps = false;
    for (const cell of cellsOf(item)) {
      if (taken.has(cell)) overlaps = true;
      else taken.set(cell, item.id); // every cell it covers is taken, overlapping or not
    }
    if (overlaps) issues.push({ code: 'overlap', itemId: item.id, message: `The ${label(item)} is on top of something` });
  }
  const blocking = DOORWAY_CELLS.find(c => taken.has(c));
  if (blocking) issues.push({ code: 'doorway', itemId: taken.get(blocking), message: 'Keep the doorway clear' });

  // Walk the free floor from the doorway: every piece must border it
  const reached = new Set(DOORWAY_CELLS.filter(c => !taken.has(c)));
  const queue = [...reached];
  while (queue.length) {
    const [x, y] = queue.pop()!.split(',').map(Number);
    for (const [dx, dy] of STEPS) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= ROOM_CELLS || ny >= ROOM_CELLS || taken.has(k) || reached.has(k)) continue;
      reached.add(k);
      queue.push(k);
    }
  }
  for (const item of floor) {
    const near = cellsOf(item).some(c => {
      const [x, y] = c.split(',').map(Number);
      return STEPS.some(([dx, dy]) => reached.has(`${x + dx},${y + dy}`));
    });
    if (!near) issues.push({ code: 'unreachable', itemId: item.id, message: `There's no way to get to the ${label(item)}` });
  }

  // Wall pieces: on the room's wall, or on the outside of the bathroom's
  const bathCells = new Set(items.filter(i => i.group === 'bath').flatMap(cellsOf));
  const hung = new Set<string>();
  for (const item of items.filter(i => i.wall)) {
    const [dx, dy] = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] }[item.edge];
    const bx = item.x + dx;
    const by = item.y + dy;
    const inBathroom = bathCells.has(`${item.x},${item.y}`);
    const onDoor = item.edge === 'bottom' && by === ROOM_CELLS && DOORWAY_CELLS.includes(`${item.x},${item.y}`);
    const onRoomWall = (bx < 0 || by < 0 || bx >= ROOM_CELLS || by >= ROOM_CELLS) && !onDoor;
    const onBathWall = bathCells.has(`${bx},${by}`);
    const spot = `${item.x},${item.y},${item.edge}`;
    if (inBathroom || (!onRoomWall && !onBathWall)) {
      issues.push({ code: 'wall', itemId: item.id, message: inBathroom ? `The ${label(item)} can't go in the bathroom` : onDoor ? `The ${label(item)} can't hang on the door` : `The ${label(item)} needs a wall to hang on` });
    }
    else if (hung.has(spot)) issues.push({ code: 'overlap', itemId: item.id, message: `The ${label(item)} is where something else hangs` });
    hung.add(spot);
  }
  return issues;
}

const profiles = new WeakMap<Furnishing, RoomProfile>();

/** What a room furnished like this is. */
export function profileFurnishing(f: Furnishing): RoomProfile {
  const cached = profiles.get(f);
  if (cached) return cached;
  const items = f.items.map(placeItem);

  // Who it sleeps: a shared bed counts once for people who won't share. A
  // one-tile room sleeps FURNISHING.sleepsPerTile at most, however it's crammed.
  let sharing = 0;
  let separate = 0;
  for (const item of items) {
    const spec = FURNITURE[item.kind];
    const n = spec.sleeps ?? 0;
    sharing += n;
    separate += spec.shared ? Math.min(1, n) : n;
  }
  const sleeps = Math.min(FURNISHING.sleepsPerTile, sharing);
  const beds = Math.min(FURNISHING.sleepsPerTile, separate);

  // How nice: the beds together (their average tier: more beds add room, not
  // quality), the best piece of each other kind of thing (extras add nothing),
  // and, for each thing a room is expected to have but doesn't -- storage, a
  // TV, somewhere to sit -- a basic one (so leaving things out can't raise it)
  const weightOf = (group: FurnitureGroup) => FURNITURE[GROUP_KINDS[group][0]].gradeWeight;
  let weighted = 0;
  let weights = 0;
  const bedPieces = items.filter(i => i.group === 'bed');
  if (bedPieces.length > 0) {
    weighted += bedPieces.reduce((sum, b) => sum + b.tier, 0) / bedPieces.length * weightOf('bed');
    weights += weightOf('bed');
  }
  const best = new Map<FurnitureGroup, PlacedItem>();
  for (const item of items) {
    if (item.group === 'bed') continue;
    const prev = best.get(item.group);
    if (!prev || item.tier > prev.tier) best.set(item.group, item);
  }
  for (const [group, item] of best) {
    weighted += item.tier * weightOf(group);
    weights += weightOf(group);
  }
  const expected: FurnitureGroup[] = ['bath', 'storage', 'tv', ...(best.has('living') ? [] : ['seat' as const])];
  for (const group of expected) {
    if (best.has(group)) continue;
    weighted += weightOf(group);
    weights += weightOf(group);
  }
  const quality = weights > 0 ? weighted / weights : 1;

  // A lounge is a sofa and a TV (a sofa bed is somewhere to sleep)
  const hasLounge = items.some(i => i.kind === 'sofa') && items.some(i => i.group === 'tv');
  const deluxe = quality >= FURNISHING.deluxeQuality - 1e-9;
  const type: RoomType = deluxe ? (hasLounge && quality >= FURNISHING.suiteQuality - 1e-9 ? 'suite' : 'deluxe') : 'standard';
  const sharedBed = items.some(i => FURNITURE[i.kind].shared);
  const layoutClass: LayoutClass = sleeps >= 3 ? 'family' : sleeps === 2 ? (sharedBed ? 'double' : 'twin') : 'single';
  const bedName = items.some(i => i.kind === 'bed_king') ? 'King' : 'Queen';
  const noun = { single: 'Single', double: bedName, twin: 'Twin', family: 'Family Room' }[layoutClass];
  const label = type === 'suite'
    ? (layoutClass === 'family' ? 'Family Junior Suite' : 'Junior Suite')
    : `${deluxe ? 'Deluxe' : 'Standard'} ${noun}`;
  const shell = ROOM_PRESETS[f.preset]?.shellCost ?? 0;
  const furnishingCost = shell + items.reduce((sum, i) => sum + FURNITURE[i.kind].cost[i.tier], 0);
  const floorCells = new Set(items.filter(i => !i.wall).flatMap(cellsOf));
  const profile: RoomProfile = {
    type, layoutClass, label, quality, sleeps, beds, hasLounge, items, furnishingCost,
    freeCells: ROOM_CELLS * ROOM_CELLS - floorCells.size,
    issues: checkLayout(items),
  };
  profiles.set(f, profile);
  return profile;
}

/** What a room is (see profileFurnishing). */
export function profileRoom(room: Pick<Room, 'type' | 'furnishing'>): RoomProfile {
  return profileFurnishing(furnishingOf(room));
}

/** Whether a room can be sold: furnished so it works (a bed, a bathroom, everything reachable). */
export function isBookable(room: Pick<Room, 'type' | 'furnishing'>): boolean {
  return profileRoom(room).issues.length === 0;
}

/**
 * How a room's fair price compares to its category's, for who it fits: a
 * room for one is cheaper; separate beds, and space for a family, dearer. A
 * double (and so every room furnished like one of the original types) is
 * exactly its category's price.
 */
export function classPriceFactor(profile: Pick<RoomProfile, 'type' | 'layoutClass'>): number {
  if (profile.type === 'suite') return profile.layoutClass === 'family' ? 1.1 : profile.layoutClass === 'single' ? 0.75 : 1;
  return { single: 0.75, double: 1, twin: 1.05, family: 1.25 }[profile.layoutClass];
}

/**
 * Whether a room fits a party: couples and families share beds, so they need
 * room for everyone; friends and colleagues each need a bed of their own.
 */
export function fitsParty(profile: Pick<RoomProfile, 'sleeps' | 'beds'>, party: Party): boolean {
  const sharing = party.kind === 'couple' || party.kind === 'family';
  return (sharing ? profile.sleeps : profile.beds) >= party.size;
}

/** Who a room fits, in words: "a couple, families of 4, 2 friends". */
export function whoFits(profile: Pick<RoomProfile, 'sleeps' | 'beds'>): string {
  if (profile.sleeps === 0) return 'nobody (it needs a bed)';
  const parts = [profile.sleeps >= 2 ? 'a couple' : 'one person'];
  if (profile.sleeps >= 3) parts.push(`families of ${profile.sleeps}`);
  if (profile.beds >= 2) parts.push(`${profile.beds} friends`);
  return parts.join(', ');
}

/** The smallest kind of room a party needs: a family room for three or more, twin beds for two who won't share, else a double. */
export function neededClass(party: Party): LayoutClass {
  if (party.size >= 3) return 'family';
  if (party.size === 2 && party.kind !== 'couple' && party.kind !== 'family') return 'twin';
  return 'double';
}

/**
 * What a room is worth to a party, against its category's price: no more than
 * the kind of room they need -- a family room is a double to a couple, so
 * they won't pay a family's price for its extra beds. A double (every room
 * furnished like an original type) is worth exactly its price to anyone.
 */
export function partyPriceFactor(profile: Pick<RoomProfile, 'type' | 'layoutClass'>, party: Party): number {
  const needed = classPriceFactor({ type: profile.type, layoutClass: neededClass(party) });
  return Math.min(classPriceFactor(profile), Math.max(1, needed));
}

/** The thin strip a wall piece takes along its edge (door-local cells), for drawing it. */
export function wallBar(item: Pick<PlacedItem, 'x' | 'y' | 'w' | 'h' | 'edge'>, thickness = 0.15): { x: number; y: number; w: number; h: number } {
  switch (item.edge) {
    case 'top': return { x: item.x, y: item.y, w: item.w, h: thickness };
    case 'bottom': return { x: item.x, y: item.y + item.h - thickness, w: item.w, h: thickness };
    case 'left': return { x: item.x, y: item.y, w: thickness, h: item.h };
    case 'right': return { x: item.x + item.w - thickness, y: item.y, w: thickness, h: item.h };
  }
}

/** The pillow end of a bed: a strip along its head edge (door-local cells). */
export function pillowRect(item: Pick<PlacedItem, 'x' | 'y' | 'w' | 'h' | 'edge'>): { x: number; y: number; w: number; h: number } {
  const depth = 0.45;
  const inset = 0.2;
  switch (item.edge) {
    case 'top': return { x: item.x + inset, y: item.y + 0.15, w: item.w - inset * 2, h: depth };
    case 'bottom': return { x: item.x + inset, y: item.y + item.h - 0.15 - depth, w: item.w - inset * 2, h: depth };
    case 'left': return { x: item.x + 0.15, y: item.y + inset, w: depth, h: item.h - inset * 2 };
    case 'right': return { x: item.x + item.w - 0.15 - depth, y: item.y + inset, w: depth, h: item.h - inset * 2 };
  }
}

/** What changing a room's furnishing involves: what it costs, how long the room is closed, and what it becomes. */
export interface RefitQuote {
  cost: number;
  installHours: number;
  changed: string[]; // ids of pieces added, removed or swapped
  moved: boolean; // pieces moved (or the layout it follows changed)
  replumbed: boolean; // the bathroom moves
  before: RoomProfile;
  after: RoomProfile;
}

/**
 * Price a refit, piece by piece (matched by id): the new pieces, less what
 * the old ones fetch (FURNISHING.refitResale), times FURNISHING.refitPremium
 * for fitting them in a working hotel. A piece that stays but moves takes a
 * little time; moving the bathroom means re-plumbing it, half its price again
 * and its install time.
 */
export function quoteRefit(from: Furnishing, to: Furnishing): RefitQuote {
  const byId = (f: Furnishing) => new Map(f.items.map(i => [i.id, i]));
  const a = byId(from);
  const b = byId(to);
  const changed: string[] = [];
  let spend = 0;
  let resale = 0;
  let hours = 0;
  let movedPiece = false;
  let replumbed = false;
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(id);
    const after = b.get(id);
    if (before && after && before.kind === after.kind && before.tier === after.tier) {
      if (before.x === after.x && before.y === after.y && before.rot === after.rot && (before.length ?? 0) === (after.length ?? 0)) continue;
      movedPiece = true;
      const spec = FURNITURE[after.kind];
      if (spec.group === 'bath') {
        replumbed = true;
        spend += spec.cost[after.tier] * 0.5;
        hours += spec.installHours;
      } else {
        hours += FURNISHING.moveHours;
      }
      continue;
    }
    changed.push(id);
    if (after) {
      spend += FURNITURE[after.kind].cost[after.tier];
      hours += FURNITURE[after.kind].installHours;
    }
    if (before) resale += FURNITURE[before.kind].cost[before.tier] * FURNISHING.refitResale;
  }
  const moved = movedPiece || from.preset !== to.preset || from.arrangement !== to.arrangement || from.mirrored !== to.mirrored;
  const cost = Math.max(0, Math.round((spend - resale) * FURNISHING.refitPremium));
  return { cost, installHours: Math.ceil(hours), changed, moved, replumbed, before: profileFurnishing(from), after: profileFurnishing(to) };
}

/** Whether a piece (at a tier) can be fitted yet: furniture unlocks with the hotel's peak star rating. */
export function isFurnitureUnlocked(kind: FurnitureKind, tier: Tier, peakStars: number): boolean {
  const spec = FURNITURE[kind];
  return peakStars >= spec.requiredStars && (tier === 1 || peakStars >= spec.tier2Stars);
}

/** Whether a furnishing is allowed: every piece unlocked, and the room works (see RoomProfile.issues). Null if so, else why not. */
export function validateFurnishing(f: Furnishing, peakStars: number): string | null {
  if (!ROOM_PRESETS[f.preset] || !ROOM_PRESETS[f.preset].arrangements[f.arrangement]) return 'Unknown layout';
  if (new Set(f.items.map(i => i.id)).size !== f.items.length) return 'Two pieces share an id';
  for (const item of f.items) {
    if (!FURNITURE[item.kind]) return 'Unknown furniture';
    if (!isFurnitureUnlocked(item.kind, item.tier, peakStars)) return `${FURNITURE[item.kind].label}${item.tier === 2 ? ' (premium)' : ''} needs a higher star rating`;
  }
  const profile = profileFurnishing(f);
  const issue = profile.issues[0];
  if (issue) return issue.message;
  // The furniture can't make a room a category the hotel hasn't unlocked yet
  if (peakStars < ROOM_CONFIG[profile.type].requiredStars) return `A ${profile.type} room needs ${ROOM_CONFIG[profile.type].requiredStars} stars`;
  return null;
}

/** Start a room over from a preset: its layout and furniture, keeping where the bathroom goes. */
export function switchPreset(f: Furnishing, preset: PresetId): Furnishing {
  return defaultFurnishing(preset, f.arrangement, f.mirrored);
}

/** The preset's pieces, with the kinds and grades chosen for them, laid out by one of its arrangements (back to the preset's layout: pieces added beyond the preset's are dropped). */
export function setArrangement(f: Furnishing, arrangement: ArrangementId): Furnishing {
  const { custom: _, ...rest } = f;
  return { ...rest, arrangement, items: arrangeItems(f.preset, arrangement, f.mirrored, f.items) };
}

/** Everything flipped left to right. */
export function mirrorFurnishing(f: Furnishing): Furnishing {
  return { ...f, mirrored: !f.mirrored, items: mirrorItems(f.items) };
}

/**
 * Where a point in a room's door-local frame (cells, door on the bottom edge)
 * is in the world frame of its tile (cells from the tile's top-left), for a
 * room whose door faces `door`: the furniture turns with the door.
 */
export function localToWorld(door: Direction, lx: number, ly: number): [number, number] {
  const n = ROOM_CELLS;
  switch (door) {
    case 'down': return [lx, ly];
    case 'up': return [n - lx, n - ly];
    case 'left': return [n - ly, lx];
    case 'right': return [ly, n - lx];
  }
}

/** A door-local rectangle (cells) in the tile's world frame. */
export function rectToWorld(door: Direction, r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const [ax, ay] = localToWorld(door, r.x, r.y);
  const [bx, by] = localToWorld(door, r.x + r.w, r.y + r.h);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/**
 * Where people sleep in a room (cells, tile world frame), one spot per
 * person it sleeps: two across a double bed, two along bunk beds, one to a
 * single or a sofa bed. Empty if it has no bed.
 */
export function sleepSpots(room: Pick<Room, 'type' | 'furnishing' | 'door'>, separate = false): Array<[number, number]> {
  const own: Array<[number, number]> = []; // a bed each
  const shared: Array<[number, number]> = []; // the second place in a shared bed
  for (const item of profileRoom(room).items) {
    const spec = FURNITURE[item.kind];
    const n = spec.sleeps ?? 0;
    if (n === 0) continue;
    const r = rectToWorld(room.door, item);
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      const spot: [number, number] = n === 1 ? [r.x + r.w / 2, r.y + r.h / 2]
        : r.w >= r.h ? [r.x + r.w * f, r.y + r.h / 2] : [r.x + r.w / 2, r.y + r.h * f];
      // Sharing: in bed order. Not sharing (friends): one to a bed before anyone shares
      (separate && spec.shared && k > 0 ? shared : own).push(spot);
    }
  }
  return [...own, ...shared].slice(0, FURNISHING.sleepsPerTile);
}

/** Where a guest in their room is: in bed (cells, tile world frame), or the middle of the room. */
export function bedSpot(room: Pick<Room, 'type' | 'furnishing' | 'door'>): [number, number] {
  const bed = profileRoom(room).items.find(i => (FURNITURE[i.kind].sleeps ?? 0) > 0);
  if (!bed) return [ROOM_CELLS / 2, ROOM_CELLS / 2];
  const r = rectToWorld(room.door, bed);
  return [r.x + r.w / 2, r.y + r.h / 2];
}
