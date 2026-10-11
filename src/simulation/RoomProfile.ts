import type { Room, RoomType, Furnishing, FurnitureItem, Direction } from './types.js';
import {
  FURNITURE, ROOM_PRESETS, PRESET_FOR_TYPE, FURNISHING, ROOM_CELLS, SLOT_KINDS,
  type PresetId, type ArrangementId, type SlotKind, type Tier, type FurnitureKind, type WallEdge,
} from '../config/furniture.js';

// What a room is, worked out from what's in it (docs/designs/rooms-rethink.md,
// phase 1). The player never picks "deluxe": they furnish a room, and a room
// furnished well enough (FURNISHING.deluxeQuality) is deluxe; one that also
// has a lounge is a junior suite. room.type is this derived category, kept on
// the room so prices, stars, amenities and everything else that reads it work
// as before -- and a room furnished like one of today's types is exactly that
// type, at exactly today's numbers.

/** A piece of furniture with its place in the room (door-local cells: door on the bottom edge). */
export interface PlacedItem extends FurnitureItem {
  x: number;
  y: number;
  w: number;
  h: number;
  wall: boolean;
  edge: WallEdge; // for a wall piece, the edge of its cell it hangs on
}

export interface RoomProfile {
  type: RoomType; // the category: standard / deluxe / suite
  label: string; // "Standard Queen", "Deluxe King", "Junior Suite"
  quality: number; // weighted tier average, 1-2
  sleeps: number;
  hasLounge: boolean;
  items: PlacedItem[];
  furnishingCost: number; // shell + furniture: what it would cost to build like this
}

/** The furnishing a room of a type is built with: its preset's defaults. */
export function defaultFurnishing(preset: PresetId, arrangement: ArrangementId = 'bath_front', mirrored = false): Furnishing {
  const p = ROOM_PRESETS[preset];
  const items: FurnitureItem[] = p.slots
    .filter(slot => p.defaults[slot])
    .map(slot => ({ slot, kind: p.defaults[slot]!.kind, tier: p.defaults[slot]!.tier }));
  return { preset, arrangement, mirrored, items };
}

/** A room's furnishing (rooms from before furniture, or built in tests, get their type's preset). */
export function furnishingOf(room: Pick<Room, 'type' | 'furnishing'>): Furnishing {
  return room.furnishing ?? defaultFurnishing(PRESET_FOR_TYPE[room.type]);
}

const profiles = new WeakMap<Furnishing, RoomProfile>();

/** What a room furnished like this is. */
export function profileFurnishing(f: Furnishing): RoomProfile {
  const cached = profiles.get(f);
  if (cached) return cached;
  const preset = ROOM_PRESETS[f.preset];
  const places = preset.arrangements[f.arrangement].places;
  const flip: Record<WallEdge, WallEdge> = { top: 'top', bottom: 'bottom', left: 'right', right: 'left' };
  const items: PlacedItem[] = f.items.map(item => {
    const spec = FURNITURE[item.kind];
    const place = places.find(p => p.slot === item.slot)!;
    const w = place.w ?? spec.size[0];
    const h = place.h ?? spec.size[1];
    const edge = place.wall ?? 'top';
    return f.mirrored
      ? { ...item, x: ROOM_CELLS - place.x - w, y: place.y, w, h, wall: !!spec.wall, edge: flip[edge] }
      : { ...item, x: place.x, y: place.y, w, h, wall: !!spec.wall, edge };
  });
  let weighted = 0;
  let weights = 0;
  for (const item of f.items) {
    const spec = FURNITURE[item.kind];
    weighted += item.tier * spec.gradeWeight;
    weights += spec.gradeWeight;
  }
  const quality = weights > 0 ? weighted / weights : 1;
  const hasLounge = f.items.some(i => i.slot === 'living') && f.items.some(i => i.slot === 'tv');
  const deluxe = quality >= FURNISHING.deluxeQuality - 1e-9;
  const type: RoomType = deluxe ? (hasLounge ? 'suite' : 'deluxe') : 'standard';
  const bed = f.items.find(i => i.slot === 'bed');
  const bedName = bed?.kind === 'bed_king' ? 'King' : 'Queen';
  const label = type === 'suite' ? 'Junior Suite' : `${type === 'deluxe' ? 'Deluxe' : 'Standard'} ${bedName}`;
  const furnishingCost = preset.shellCost + f.items.reduce((sum, i) => sum + FURNITURE[i.kind].cost[i.tier], 0);
  const profile: RoomProfile = { type, label, quality, sleeps: bed ? 2 : 0, hasLounge, items, furnishingCost };
  profiles.set(f, profile);
  return profile;
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

/** What a room is (see profileFurnishing). */
export function profileRoom(room: Pick<Room, 'type' | 'furnishing'>): RoomProfile {
  return profileFurnishing(furnishingOf(room));
}

/** What changing a room's furnishing involves: what it costs, how long the room is closed, and what it becomes. */
export interface RefitQuote {
  cost: number;
  installHours: number;
  changed: SlotKind[]; // slots whose piece changes
  moved: boolean; // the layout (arrangement / mirror / preset) changes
  replumbed: boolean; // the bathroom moves
  before: RoomProfile;
  after: RoomProfile;
}

/**
 * Price a refit: the new pieces, less what the old ones fetch
 * (FURNISHING.refitResale), times FURNISHING.refitPremium for fitting them in
 * a working hotel. Moving the bathroom (a new arrangement or mirror; every
 * layout puts it in the same place for the same arrangement) means
 * re-plumbing a bathroom that's otherwise kept: half its price again, and its
 * install time.
 */
export function quoteRefit(from: Furnishing, to: Furnishing): RefitQuote {
  const slotsOf = (f: Furnishing) => new Map(f.items.map(i => [i.slot, i]));
  const a = slotsOf(from);
  const b = slotsOf(to);
  const changed: SlotKind[] = [];
  let spend = 0;
  let resale = 0;
  let hours = 0;
  for (const slot of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(slot);
    const after = b.get(slot);
    if (before && after && before.kind === after.kind && before.tier === after.tier) continue;
    changed.push(slot);
    if (after) {
      spend += FURNITURE[after.kind].cost[after.tier];
      hours += FURNITURE[after.kind].installHours;
    }
    if (before) resale += FURNITURE[before.kind].cost[before.tier] * FURNISHING.refitResale;
  }
  const before = profileFurnishing(from);
  const after = profileFurnishing(to);
  const moved = from.preset !== to.preset || from.arrangement !== to.arrangement || from.mirrored !== to.mirrored;
  const bathAt = (p: RoomProfile) => {
    const bath = p.items.find(i => i.slot === 'bath');
    return bath ? `${bath.x},${bath.y},${bath.w},${bath.h}` : '';
  };
  const replumbed = bathAt(before) !== bathAt(after);
  if (replumbed && !changed.includes('bath')) {
    const bath = b.get('bath');
    if (bath) {
      spend += FURNITURE[bath.kind].cost[bath.tier] * 0.5;
      hours += FURNITURE[bath.kind].installHours;
    }
  }
  const cost = Math.max(0, Math.round((spend - resale) * FURNISHING.refitPremium));
  return { cost, installHours: Math.ceil(hours), changed, moved, replumbed, before, after };
}

/** Whether a piece (at a tier) can be fitted yet: furniture unlocks with the hotel's peak star rating. */
export function isFurnitureUnlocked(kind: FurnitureKind, tier: Tier, peakStars: number): boolean {
  const spec = FURNITURE[kind];
  return peakStars >= spec.requiredStars && (tier === 1 || peakStars >= spec.tier2Stars);
}

/** Whether a furnishing is allowed: every slot of its preset filled with a piece that fits there and is unlocked. */
export function validateFurnishing(f: Furnishing, peakStars: number): string | null {
  const preset = ROOM_PRESETS[f.preset];
  if (!preset || !preset.arrangements[f.arrangement]) return 'Unknown layout';
  for (const slot of preset.slots) {
    const item = f.items.find(i => i.slot === slot);
    if (!item) return `Needs a ${slot}`;
    if (!SLOT_KINDS[slot].includes(item.kind)) return `${FURNITURE[item.kind].label} doesn't go in the ${slot} spot`;
    if (!isFurnitureUnlocked(item.kind, item.tier, peakStars)) return `${FURNITURE[item.kind].label}${item.tier === 2 ? ' (premium)' : ''} needs a higher star rating`;
  }
  if (f.items.some(i => !preset.slots.includes(i.slot))) return 'A piece has no place in this layout';
  return null;
}

/**
 * Start a room over from a preset: its layout and furniture, keeping where
 * the bathroom goes (the player then changes pieces from there).
 */
export function switchPreset(f: Furnishing, preset: PresetId): Furnishing {
  return defaultFurnishing(preset, f.arrangement, f.mirrored);
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

/** Where a guest in their room is: in bed (cells, tile world frame), or the middle of the room. */
export function bedSpot(room: Pick<Room, 'type' | 'furnishing' | 'door'>): [number, number] {
  const bed = profileRoom(room).items.find(i => i.slot === 'bed');
  if (!bed) return [ROOM_CELLS / 2, ROOM_CELLS / 2];
  const r = rectToWorld(room.door, bed);
  return [r.x + r.w / 2, r.y + r.h / 2];
}

