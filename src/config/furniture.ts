import type { RoomType } from '../simulation/types';

// Furnished rooms (docs/designs/rooms-rethink.md). A room is laid out on a
// 4x4 grid of 1 m cells inside its tile, in door-local coordinates: the door
// is on the bottom edge, x runs left to right and y top to bottom. Every piece
// of furniture is a rectangle on that grid (or, for wall pieces, an edge of a
// cell), and what's in the room decides what kind of room it is and who it
// fits (see RoomProfile.ts). Presets are just starting lists of pieces; the
// furnishing editor moves, adds and removes them. Everything here is plain
// data, read by the simulation, the 2D floor plan, the room plans in the
// interface, and (later) the 3D renderer.

export const ROOM_CELLS = 4; // cells per side of a one-tile room

export type Tier = 1 | 2;
/** Quarter turns clockwise from how a piece is specced: a bed with its head on the top edge, a wall piece on the top edge. */
export type Rot = 0 | 1 | 2 | 3;
export type FurnitureKind =
  | 'bed_single' | 'bed_queen' | 'bed_king' | 'bunk'
  | 'bath_shower' | 'bath_tub'
  | 'rail' | 'wardrobe'
  | 'armchair' | 'desk'
  | 'sofa' | 'sofa_bed'
  | 'tv' | 'art';

/** What a piece is for: a room needs a bed and a bathroom, and counts the best of each other kind toward how nice it is. */
export type FurnitureGroup = 'bed' | 'bath' | 'storage' | 'seat' | 'living' | 'tv' | 'art';

export interface FurnitureSpec {
  label: string;
  group: FurnitureGroup;
  size: [number, number]; // cells (w, h) unturned
  sizes?: Array<[number, number]>; // other sizes it comes in (the long bathroom)
  wall?: boolean; // hangs on a wall: takes no floor cell
  sleeps?: number; // people it sleeps
  shared?: boolean; // they share it: only couples and families sleep two in it
  gradeWeight: number; // how much it counts toward the room's quality
  cost: Record<Tier, number>;
  installHours: number; // time the room is offline while it goes in
  requiredStars: number; // peak stars needed to fit it (any tier)
  tier2Stars: number; // peak stars needed for its tier 2
  color: number; // 2D drawing
}

export const FURNITURE: Record<FurnitureKind, FurnitureSpec> = {
  bed_single: { label: 'Single bed', group: 'bed', size: [1, 2], sleeps: 1, gradeWeight: 3, cost: { 1: 200, 2: 600 }, installHours: 1, requiredStars: 1, tier2Stars: 2, color: 0xecf0f1 },
  bed_queen: { label: 'Queen bed', group: 'bed', size: [2, 2], sleeps: 2, shared: true, gradeWeight: 3, cost: { 1: 300, 2: 900 }, installHours: 2, requiredStars: 1, tier2Stars: 2, color: 0xecf0f1 },
  bed_king: { label: 'King bed', group: 'bed', size: [2, 2], sleeps: 2, shared: true, gradeWeight: 3, cost: { 1: 600, 2: 1200 }, installHours: 2, requiredStars: 2, tier2Stars: 2, color: 0xfdfefe },
  bunk: { label: 'Bunk beds', group: 'bed', size: [1, 2], sleeps: 2, gradeWeight: 3, cost: { 1: 400, 2: 1000 }, installHours: 2, requiredStars: 1, tier2Stars: 2, color: 0xd5dbdb },
  bath_shower: { label: 'Shower room', group: 'bath', size: [2, 2], sizes: [[2, 3]], gradeWeight: 3, cost: { 1: 350, 2: 1300 }, installHours: 6, requiredStars: 1, tier2Stars: 2, color: 0xaed6f1 },
  bath_tub: { label: 'Bathroom with tub', group: 'bath', size: [2, 2], sizes: [[2, 3]], gradeWeight: 3, cost: { 1: 900, 2: 2000 }, installHours: 6, requiredStars: 2, tier2Stars: 2, color: 0x85c1e9 },
  rail: { label: 'Clothes rail', group: 'storage', size: [1, 1], gradeWeight: 1, cost: { 1: 50, 2: 200 }, installHours: 0.5, requiredStars: 1, tier2Stars: 2, color: 0xa0826d },
  wardrobe: { label: 'Wardrobe', group: 'storage', size: [1, 1], gradeWeight: 1, cost: { 1: 200, 2: 500 }, installHours: 1, requiredStars: 1, tier2Stars: 2, color: 0x8b5a2b },
  armchair: { label: 'Armchair', group: 'seat', size: [1, 1], gradeWeight: 1, cost: { 1: 50, 2: 300 }, installHours: 0.5, requiredStars: 1, tier2Stars: 2, color: 0xc0392b },
  desk: { label: 'Desk', group: 'seat', size: [1, 1], gradeWeight: 1, cost: { 1: 300, 2: 600 }, installHours: 0.5, requiredStars: 1, tier2Stars: 2, color: 0x6e4b2a },
  sofa: { label: 'Sofa', group: 'living', size: [2, 1], gradeWeight: 2, cost: { 1: 1500, 2: 3500 }, installHours: 1, requiredStars: 3, tier2Stars: 3, color: 0x7d3c98 },
  sofa_bed: { label: 'Sofa bed', group: 'living', size: [2, 1], sleeps: 1, gradeWeight: 2, cost: { 1: 1000, 2: 2500 }, installHours: 1, requiredStars: 2, tier2Stars: 3, color: 0x9b59b6 },
  tv: { label: 'TV', group: 'tv', size: [1, 1], wall: true, gradeWeight: 1, cost: { 1: 50, 2: 500 }, installHours: 0.5, requiredStars: 1, tier2Stars: 2, color: 0x17202a },
  art: { label: 'Artwork', group: 'art', size: [1, 1], wall: true, gradeWeight: 1, cost: { 1: 300, 2: 1100 }, installHours: 0.5, requiredStars: 1, tier2Stars: 2, color: 0xf5b041 },
};

/** Which kinds are in each group (a piece can be swapped for another of its group). */
export const GROUP_KINDS: Record<FurnitureGroup, FurnitureKind[]> = {
  bed: ['bed_single', 'bed_queen', 'bed_king', 'bunk'],
  bath: ['bath_shower', 'bath_tub'],
  storage: ['rail', 'wardrobe'],
  seat: ['armchair', 'desk'],
  living: ['sofa', 'sofa_bed'],
  tv: ['tv'],
  art: ['art'],
};

export const GROUP_LABELS: Record<FurnitureGroup, string> = {
  bed: 'Bed', bath: 'Bathroom', storage: 'Storage', seat: 'Seat', living: 'Lounge', tv: 'TV', art: 'Art',
};

export type PresetId = 'classic_queen' | 'compact_deluxe' | 'exec_studio' | 'twin' | 'bunk_family';
export type ArrangementId = 'bath_front' | 'bath_back';

/** Where a preset's piece goes: door-local cell of its top-left, how it's turned, and a length if not its own (the long bathroom). */
export interface PresetPiece {
  id: string; // the piece's id in the room: 'bed', 'bed-2', 'bath', ...
  x: number;
  y: number;
  rot?: Rot;
  length?: number;
}

export interface RoomPreset {
  label: string; // what the build card calls it
  legacyType?: RoomType; // the original room type it matches exactly
  shellCost: number; // walls, floor, plumbing: the rest is the furniture
  arrangements: Record<ArrangementId, { label: string; pieces: PresetPiece[] }>;
  defaults: Record<string, { kind: FurnitureKind; tier: Tier }>; // by piece id
}

const SHELL = 1200;

/**
 * Where things go. The door is in the middle of the bottom edge, so the two
 * cells inside it stay clear, and every piece can be walked up to from them
 * (test/furnishing.test.ts checks both, for every layout, mirrored or not).
 * Bed heads are against the back wall. "Bath by the door" is a long bathroom
 * down the right side, entered just inside the door; "at the back" is a
 * square one in the back corner, leaving the front of the room open. Wall
 * pieces (TV, art) hang on one edge of their cell (rot: 0 top, 1 right, 2
 * bottom, 3 left) and take no floor.
 */
const BASIC: Record<ArrangementId, PresetPiece[]> = {
  bath_front: [
    { id: 'bed', x: 0, y: 0 }, { id: 'bath', x: 2, y: 0, length: 3 }, { id: 'storage', x: 3, y: 3 },
    { id: 'seat', x: 0, y: 3 }, { id: 'tv', x: 0, y: 3, rot: 2 },
  ],
  bath_back: [
    { id: 'bed', x: 0, y: 0 }, { id: 'bath', x: 2, y: 0 }, { id: 'storage', x: 3, y: 2 },
    { id: 'seat', x: 0, y: 3 }, { id: 'tv', x: 0, y: 3, rot: 2 },
  ],
};
// A studio's sofa stands against the left wall, facing a TV across the room
const STUDIO: Record<ArrangementId, PresetPiece[]> = {
  bath_front: [
    { id: 'bed', x: 0, y: 0 }, { id: 'bath', x: 2, y: 0, length: 3 }, { id: 'living', x: 0, y: 2, rot: 1 },
    { id: 'storage', x: 3, y: 3 }, { id: 'tv', x: 1, y: 2, rot: 1 }, { id: 'art', x: 0, y: 0, rot: 3 },
  ],
  bath_back: [
    { id: 'bed', x: 0, y: 0 }, { id: 'bath', x: 2, y: 0 }, { id: 'living', x: 0, y: 2, rot: 1 },
    { id: 'storage', x: 3, y: 2 }, { id: 'tv', x: 3, y: 3, rot: 1 }, { id: 'art', x: 0, y: 0, rot: 3 },
  ],
};
// Two single beds side by side against the back wall
const TWIN: Record<ArrangementId, PresetPiece[]> = {
  bath_front: [
    { id: 'bed', x: 0, y: 0 }, { id: 'bed-2', x: 1, y: 0 }, { id: 'bath', x: 2, y: 0, length: 3 },
    { id: 'storage', x: 3, y: 3 }, { id: 'seat', x: 0, y: 3 }, { id: 'tv', x: 0, y: 3, rot: 2 },
  ],
  bath_back: [
    { id: 'bed', x: 0, y: 0 }, { id: 'bed-2', x: 1, y: 0 }, { id: 'bath', x: 2, y: 0 },
    { id: 'storage', x: 3, y: 2 }, { id: 'seat', x: 0, y: 3 }, { id: 'tv', x: 0, y: 3, rot: 2 },
  ],
};
// A queen against the back wall, and bunk beds along the left wall below it
const FAMILY: Record<ArrangementId, PresetPiece[]> = {
  bath_front: [
    { id: 'bed', x: 0, y: 0 }, { id: 'bed-2', x: 0, y: 2 }, { id: 'bath', x: 2, y: 0, length: 3 },
    { id: 'storage', x: 3, y: 3 }, { id: 'tv', x: 1, y: 2, rot: 1 },
  ],
  bath_back: [
    { id: 'bed', x: 0, y: 0 }, { id: 'bed-2', x: 0, y: 2 }, { id: 'bath', x: 2, y: 0 },
    { id: 'storage', x: 3, y: 2 }, { id: 'tv', x: 3, y: 3, rot: 1 },
  ],
};

const arrangements = (pieces: Record<ArrangementId, PresetPiece[]>) => ({
  bath_front: { label: 'Bath by the door', pieces: pieces.bath_front },
  bath_back: { label: 'Bath at the back', pieces: pieces.bath_back },
});

export const ROOM_PRESETS: Record<PresetId, RoomPreset> = {
  // $1,200 shell + $800 of basic furniture = $2,000, the original standard room
  classic_queen: {
    label: 'Standard Queen',
    legacyType: 'standard',
    shellCost: SHELL,
    arrangements: arrangements(BASIC),
    defaults: { bed: { kind: 'bed_queen', tier: 1 }, bath: { kind: 'bath_shower', tier: 1 }, storage: { kind: 'rail', tier: 1 }, seat: { kind: 'armchair', tier: 1 }, tv: { kind: 'tv', tier: 1 } },
  },
  // $1,200 + $3,800 = $5,000, the original deluxe room
  compact_deluxe: {
    label: 'Deluxe King',
    legacyType: 'deluxe',
    shellCost: SHELL,
    arrangements: arrangements(BASIC),
    defaults: { bed: { kind: 'bed_king', tier: 2 }, bath: { kind: 'bath_shower', tier: 2 }, storage: { kind: 'wardrobe', tier: 2 }, seat: { kind: 'desk', tier: 1 }, tv: { kind: 'tv', tier: 2 } },
  },
  // $1,200 + $8,800 = $10,000, the original suite: a studio with a lounge
  exec_studio: {
    label: 'Executive Studio',
    legacyType: 'suite',
    shellCost: SHELL,
    arrangements: arrangements(STUDIO),
    defaults: { bed: { kind: 'bed_king', tier: 2 }, bath: { kind: 'bath_tub', tier: 2 }, living: { kind: 'sofa', tier: 2 }, storage: { kind: 'wardrobe', tier: 2 }, tv: { kind: 'tv', tier: 2 }, art: { kind: 'art', tier: 2 } },
  },
  // Two singles: for friends and colleagues, who won't share a bed. $2,100.
  twin: {
    label: 'Standard Twin',
    shellCost: SHELL,
    arrangements: arrangements(TWIN),
    defaults: { bed: { kind: 'bed_single', tier: 1 }, 'bed-2': { kind: 'bed_single', tier: 1 }, bath: { kind: 'bath_shower', tier: 1 }, storage: { kind: 'rail', tier: 1 }, seat: { kind: 'armchair', tier: 1 }, tv: { kind: 'tv', tier: 1 } },
  },
  // A queen and bunk beds: sleeps four. $2,350.
  bunk_family: {
    label: 'Family Room',
    shellCost: SHELL,
    arrangements: arrangements(FAMILY),
    defaults: { bed: { kind: 'bed_queen', tier: 1 }, 'bed-2': { kind: 'bunk', tier: 1 }, bath: { kind: 'bath_shower', tier: 1 }, storage: { kind: 'rail', tier: 1 }, tv: { kind: 'tv', tier: 1 } },
  },
};

export const PRESET_FOR_TYPE: Record<RoomType, PresetId> = {
  standard: 'classic_queen',
  deluxe: 'compact_deluxe',
  suite: 'exec_studio',
};

export const FURNISHING = {
  deluxeQuality: 1.75, // weighted tier average at which a room is deluxe
  sleepsPerTile: 4, // the most a one-tile room sleeps, however many beds are crammed in
  refitResale: 0.5, // share of a removed piece's cost you get back
  refitPremium: 1.4, // fitting out a room in place costs more than the parts (labour, disruption)
  moveHours: 0.25, // moving a piece that stays (other than the bathroom, which is re-plumbed)
};
