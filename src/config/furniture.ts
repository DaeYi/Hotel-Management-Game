import type { RoomType } from '../simulation/types';

// Furnished rooms (docs/designs/rooms-rethink.md, phase 1). A room is laid
// out on a 4x4 grid of 1 m cells inside its tile, in door-local coordinates:
// the door is on the bottom edge, x runs left to right and y top to bottom.
// What's in the room decides what kind of room it is (see RoomProfile.ts), so
// a standard room becomes deluxe by being furnished better, not by being
// rebuilt. Everything here is plain data, read by the simulation, the 2D
// floor plan, the inspector's room plan, and (later) the 3D renderer.

export const ROOM_CELLS = 4; // cells per side of a one-tile room

export type Tier = 1 | 2;
export type FurnitureKind =
  | 'bed_queen' | 'bed_king'
  | 'bath_shower' | 'bath_tub'
  | 'rail' | 'wardrobe'
  | 'armchair' | 'desk'
  | 'sofa'
  | 'tv' | 'art';

/** What a slot holds: one of these groups. */
export type SlotKind = 'bed' | 'bath' | 'storage' | 'seat' | 'living' | 'tv' | 'art';

export interface FurnitureSpec {
  label: string;
  slot: SlotKind;
  size: [number, number]; // cells (w, h) in the door-local frame
  wall?: boolean; // mounted on a wall: takes no floor cell
  gradeWeight: number; // how much it counts toward the room's quality
  cost: Record<Tier, number>;
  installHours: number; // time the room is offline while it goes in
  requiredStars: number; // peak stars needed to fit it (any tier)
  tier2Stars: number; // peak stars needed for its tier 2
  color: number; // 2D drawing
}

export const FURNITURE: Record<FurnitureKind, FurnitureSpec> = {
  bed_queen: { label: 'Queen bed', slot: 'bed', size: [2, 2], gradeWeight: 3, cost: { 1: 300, 2: 900 }, installHours: 2, requiredStars: 1, tier2Stars: 2, color: 0xecf0f1 },
  bed_king: { label: 'King bed', slot: 'bed', size: [2, 2], gradeWeight: 3, cost: { 1: 600, 2: 1200 }, installHours: 2, requiredStars: 2, tier2Stars: 2, color: 0xfdfefe },
  bath_shower: { label: 'Shower room', slot: 'bath', size: [2, 2], gradeWeight: 3, cost: { 1: 350, 2: 1300 }, installHours: 6, requiredStars: 1, tier2Stars: 2, color: 0xaed6f1 },
  bath_tub: { label: 'Bathroom with tub', slot: 'bath', size: [2, 2], gradeWeight: 3, cost: { 1: 900, 2: 2000 }, installHours: 6, requiredStars: 2, tier2Stars: 2, color: 0x85c1e9 },
  rail: { label: 'Clothes rail', slot: 'storage', size: [1, 1], gradeWeight: 1, cost: { 1: 50, 2: 200 }, installHours: 0.5, requiredStars: 1, tier2Stars: 2, color: 0xa0826d },
  wardrobe: { label: 'Wardrobe', slot: 'storage', size: [1, 1], gradeWeight: 1, cost: { 1: 200, 2: 500 }, installHours: 1, requiredStars: 1, tier2Stars: 2, color: 0x8b5a2b },
  armchair: { label: 'Armchair', slot: 'seat', size: [1, 1], gradeWeight: 1, cost: { 1: 50, 2: 300 }, installHours: 0.5, requiredStars: 1, tier2Stars: 2, color: 0xc0392b },
  desk: { label: 'Desk', slot: 'seat', size: [1, 1], gradeWeight: 1, cost: { 1: 300, 2: 600 }, installHours: 0.5, requiredStars: 1, tier2Stars: 2, color: 0x6e4b2a },
  sofa: { label: 'Sofa', slot: 'living', size: [2, 1], gradeWeight: 2, cost: { 1: 1500, 2: 3500 }, installHours: 1, requiredStars: 3, tier2Stars: 3, color: 0x7d3c98 },
  tv: { label: 'TV', slot: 'tv', size: [1, 1], wall: true, gradeWeight: 1, cost: { 1: 50, 2: 500 }, installHours: 0.5, requiredStars: 1, tier2Stars: 2, color: 0x17202a },
  art: { label: 'Artwork', slot: 'art', size: [1, 1], wall: true, gradeWeight: 1, cost: { 1: 300, 2: 1100 }, installHours: 0.5, requiredStars: 1, tier2Stars: 2, color: 0xf5b041 },
};

/** Which kinds may go in each slot. */
export const SLOT_KINDS: Record<SlotKind, FurnitureKind[]> = {
  bed: ['bed_queen', 'bed_king'],
  bath: ['bath_shower', 'bath_tub'],
  storage: ['rail', 'wardrobe'],
  seat: ['armchair', 'desk'],
  living: ['sofa'],
  tv: ['tv'],
  art: ['art'],
};

export const SLOT_LABELS: Record<SlotKind, string> = {
  bed: 'Bed', bath: 'Bathroom', storage: 'Storage', seat: 'Seat', living: 'Lounge', tv: 'TV', art: 'Art',
};

export type PresetId = 'classic_queen' | 'compact_deluxe' | 'exec_studio';
export type ArrangementId = 'bath_front' | 'bath_back';

export type WallEdge = 'top' | 'bottom' | 'left' | 'right';

export interface SlotPlace {
  slot: SlotKind;
  x: number; // door-local cell of the item's top-left
  y: number;
  w?: number; // a size for this spot instead of the piece's own (the long bathroom by the door)
  h?: number;
  wall?: WallEdge; // for a wall piece: the edge of its cell it hangs on (default top)
}

export interface RoomPreset {
  label: string; // what the build card calls it
  legacyType: RoomType; // the room type it matches (and replaces) exactly
  shellCost: number; // walls, floor, plumbing: the rest is the furniture
  slots: SlotKind[];
  arrangements: Record<ArrangementId, { label: string; places: SlotPlace[] }>;
  defaults: Partial<Record<SlotKind, { kind: FurnitureKind; tier: Tier }>>;
}

const SHELL = 1200;

/**
 * Where things go. The door is in the middle of the bottom edge, so the two
 * cells inside it stay clear, and every piece can be walked up to from them
 * (test/furnishing.test.ts checks both, for every layout, mirrored or not).
 * The bed's head is against the back wall. "Bath by the door" is a long
 * bathroom down the right side, entered just inside the door; "at the back"
 * is a square one in the back corner, leaving the front of the room open.
 * Wall pieces (TV, art) hang on one edge of their cell and take no floor.
 */
const BASIC_PLACES: Record<ArrangementId, SlotPlace[]> = {
  bath_front: [
    { slot: 'bed', x: 0, y: 0 }, { slot: 'bath', x: 2, y: 0, h: 3 }, { slot: 'storage', x: 3, y: 3 },
    { slot: 'seat', x: 0, y: 3 }, { slot: 'tv', x: 0, y: 3, wall: 'bottom' },
  ],
  bath_back: [
    { slot: 'bed', x: 0, y: 0 }, { slot: 'bath', x: 2, y: 0 }, { slot: 'storage', x: 3, y: 2 },
    { slot: 'seat', x: 0, y: 3 }, { slot: 'tv', x: 0, y: 3, wall: 'bottom' },
  ],
};
// A studio's sofa stands against the left wall, facing a TV across the room
const STUDIO_PLACES: Record<ArrangementId, SlotPlace[]> = {
  bath_front: [
    { slot: 'bed', x: 0, y: 0 }, { slot: 'bath', x: 2, y: 0, h: 3 }, { slot: 'living', x: 0, y: 2, w: 1, h: 2 },
    { slot: 'storage', x: 3, y: 3 }, { slot: 'tv', x: 1, y: 2, wall: 'right' }, { slot: 'art', x: 0, y: 0, wall: 'left' },
  ],
  bath_back: [
    { slot: 'bed', x: 0, y: 0 }, { slot: 'bath', x: 2, y: 0 }, { slot: 'living', x: 0, y: 2, w: 1, h: 2 },
    { slot: 'storage', x: 3, y: 2 }, { slot: 'tv', x: 3, y: 3, wall: 'right' }, { slot: 'art', x: 0, y: 0, wall: 'left' },
  ],
};

export const ROOM_PRESETS: Record<PresetId, RoomPreset> = {
  // $1,200 shell + $800 of basic furniture = $2,000, today's standard room
  classic_queen: {
    label: 'Standard Queen',
    legacyType: 'standard',
    shellCost: SHELL,
    slots: ['bed', 'bath', 'storage', 'seat', 'tv'],
    arrangements: { bath_front: { label: 'Bath by the door', places: BASIC_PLACES.bath_front }, bath_back: { label: 'Bath at the back', places: BASIC_PLACES.bath_back } },
    defaults: { bed: { kind: 'bed_queen', tier: 1 }, bath: { kind: 'bath_shower', tier: 1 }, storage: { kind: 'rail', tier: 1 }, seat: { kind: 'armchair', tier: 1 }, tv: { kind: 'tv', tier: 1 } },
  },
  // $1,200 + $3,800 = $5,000, today's deluxe room
  compact_deluxe: {
    label: 'Deluxe King',
    legacyType: 'deluxe',
    shellCost: SHELL,
    slots: ['bed', 'bath', 'storage', 'seat', 'tv'],
    arrangements: { bath_front: { label: 'Bath by the door', places: BASIC_PLACES.bath_front }, bath_back: { label: 'Bath at the back', places: BASIC_PLACES.bath_back } },
    defaults: { bed: { kind: 'bed_king', tier: 2 }, bath: { kind: 'bath_shower', tier: 2 }, storage: { kind: 'wardrobe', tier: 2 }, seat: { kind: 'desk', tier: 1 }, tv: { kind: 'tv', tier: 2 } },
  },
  // $1,200 + $8,800 = $10,000, today's suite: a studio with a lounge
  exec_studio: {
    label: 'Executive Studio',
    legacyType: 'suite',
    shellCost: SHELL,
    slots: ['bed', 'bath', 'living', 'storage', 'tv', 'art'],
    arrangements: { bath_front: { label: 'Bath by the door', places: STUDIO_PLACES.bath_front }, bath_back: { label: 'Bath at the back', places: STUDIO_PLACES.bath_back } },
    defaults: { bed: { kind: 'bed_king', tier: 2 }, bath: { kind: 'bath_tub', tier: 2 }, living: { kind: 'sofa', tier: 2 }, storage: { kind: 'wardrobe', tier: 2 }, tv: { kind: 'tv', tier: 2 }, art: { kind: 'art', tier: 2 } },
  },
};

export const PRESET_FOR_TYPE: Record<RoomType, PresetId> = {
  standard: 'classic_queen',
  deluxe: 'compact_deluxe',
  suite: 'exec_studio',
};

export const FURNISHING = {
  deluxeQuality: 1.75, // weighted tier average at which a room is deluxe
  refitResale: 0.5, // share of a removed piece's cost you get back
  refitPremium: 1.4, // fitting out a room in place costs more than the parts (labour, disruption)
};
