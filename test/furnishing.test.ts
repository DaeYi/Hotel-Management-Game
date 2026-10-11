import { describe, it, expect, beforeEach } from 'vitest';
import {
  createStarterHotel, addRoom, refitRoom, cancelPendingRefit, startPendingRefits, refitAllLike, roomsToRefitLike,
  getRenovationCost, getRoomBuildCost, getRoomInvestedCost, getDemolishRefund, demolishRoom,
} from '../src/simulation/HotelState.js';
import {
  defaultFurnishing, furnishingOf, profileFurnishing, profileRoom, quoteRefit, validateFurnishing, switchPreset,
  isFurnitureUnlocked, rectToWorld, bedSpot, sleepSpots, mirrorFurnishing, setArrangement, arrangeItems, cellsOf,
  classPriceFactor, DOORWAY_CELLS,
} from '../src/simulation/RoomProfile.js';
import { processRenovationTick, decayDecor } from '../src/simulation/DecorManager.js';
import { getExpectedPrice, getRoomExpectedPrice } from '../src/simulation/StarRatingManager.js';
import { calculateValuation } from '../src/simulation/ObjectivesManager.js';
import { loadGame } from '../src/simulation/SaveManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { hourStart } from '../src/simulation/Movement.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { PRNG } from '../src/simulation/prng.js';
import { ROOM_CONFIG } from '../src/config/balance.js';
import {
  FURNITURE, ROOM_PRESETS, PRESET_FOR_TYPE, ROOM_CELLS, GROUP_KINDS, FURNISHING,
  type PresetId, type ArrangementId, type FurnitureKind, type Rot, type Tier,
} from '../src/config/furniture.js';
import type { HotelState, Furnishing, FurnitureItem, RoomType, Direction } from '../src/simulation/types.js';

const TYPES: RoomType[] = ['standard', 'deluxe', 'suite'];
const PRESETS = Object.keys(ROOM_PRESETS) as PresetId[];
const ARRANGEMENTS: ArrangementId[] = ['bath_front', 'bath_back'];
const DOORS: Direction[] = ['up', 'down', 'left', 'right'];

/** Pieces of a furnishing changed by id. */
const withItems = (f: Furnishing, change: (i: FurnitureItem) => FurnitureItem): Furnishing => ({ ...f, items: f.items.map(change) });

/** A Standard Queen with premium bed, bathroom and storage: deluxe on quality alone. */
function deluxeQueen(): Furnishing {
  return withItems(defaultFurnishing('classic_queen'), i => (['bed', 'bath', 'storage'].includes(i.id) ? { ...i, tier: 2 as const } : i));
}

/** A starter hotel with `n` standard rooms on row 2, cash to spare, at `stars`. */
function hotel(n: number, stars = 3): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: stars, starRating: stars };
  for (let x = 0; x < n; x++) s = addRoom(s, 'standard', x, 2)!;
  return s;
}

describe('A room is what it is furnished with', () => {
  it("each original type's preset is exactly that type, at exactly its build cost and price", () => {
    for (const type of TYPES) {
      const preset = PRESET_FOR_TYPE[type];
      expect(ROOM_PRESETS[preset].legacyType).toBe(type);
      expect(getRoomBuildCost(type)).toBe(ROOM_CONFIG[type].buildCost);
      for (const arrangement of ARRANGEMENTS) for (const mirrored of [false, true]) {
        const profile = profileFurnishing(defaultFurnishing(preset, arrangement, mirrored));
        expect(profile.type).toBe(type);
        expect(profile.furnishingCost).toBe(ROOM_CONFIG[type].buildCost);
        expect(classPriceFactor(profile)).toBe(1);
        expect(profile.sleeps).toBe(2);
      }
    }
    expect(profileFurnishing(defaultFurnishing('classic_queen')).label).toBe('Standard Queen');
    expect(profileFurnishing(defaultFurnishing('compact_deluxe')).label).toBe('Deluxe King');
    expect(profileFurnishing(defaultFurnishing('exec_studio')).label).toBe('Junior Suite');
  });

  it('twin and family rooms: who they sleep, what they cost, what they\'re worth', () => {
    const twin = profileFurnishing(defaultFurnishing('twin'));
    expect(twin).toMatchObject({ type: 'standard', layoutClass: 'twin', label: 'Standard Twin', sleeps: 2, beds: 2, furnishingCost: 2100 });
    const family = profileFurnishing(defaultFurnishing('bunk_family'));
    // A queen (two who share it, or one who won't) and bunk beds (two)
    expect(family).toMatchObject({ type: 'standard', layoutClass: 'family', label: 'Standard Family Room', sleeps: 4, beds: 3, furnishingCost: 2350 });
    expect(getRoomBuildCost('twin')).toBe(2100);
    let s: HotelState = { ...createStarterHotel(), cash: 100_000 };
    s = addRoom(s, 'twin', 1, 2)!;
    s = addRoom(s, 'bunk_family', 2, 2)!;
    expect(s.cash).toBe(100_000 - 2100 - 2350);
    const [t, f] = s.rooms;
    expect(t.pricePerNight).toBe(Math.round(getExpectedPrice('standard', s.starRating) * 1.05));
    expect(getRoomExpectedPrice(f, s.starRating)).toBe(Math.round(getExpectedPrice('standard', s.starRating) * 1.25));
    expect(sleepSpots(f)).toHaveLength(4);
  });

  it('new rooms are built with their preset\'s furniture', () => {
    let s = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
    TYPES.forEach((type, x) => { s = addRoom(s, type, x, 2)!; });
    for (const room of s.rooms) {
      expect(room.furnishing).toEqual(defaultFurnishing(PRESET_FOR_TYPE[room.type]));
      expect(profileRoom(room).type).toBe(room.type);
    }
  });

  it('premium pieces make a room deluxe; a lounge without the quality is still standard', () => {
    expect(profileFurnishing(deluxeQueen())).toMatchObject({ type: 'deluxe', label: 'Deluxe Queen' });
    const two = withItems(defaultFurnishing('classic_queen'), i => (['bed', 'bath'].includes(i.id) ? { ...i, tier: 2 as const } : i));
    expect(profileFurnishing(two).type).toBe('standard');
    const studio = withItems(defaultFurnishing('exec_studio'), i => ({ ...i, tier: 1 as const }));
    expect(profileFurnishing(studio)).toMatchObject({ type: 'standard', hasLounge: true });
  });

  it('piling in extras doesn\'t buy a grade: only the best of each kind of thing counts', () => {
    const f = defaultFurnishing('classic_queen');
    // Every wall in the room hung with premium art, and a premium TV
    const art: FurnitureItem[] = [];
    for (let x = 0; x < ROOM_CELLS; x++) art.push({ id: `art-${x}`, kind: 'art', tier: 2, x, y: 0, rot: 0 });
    const piled = { ...f, custom: true, items: [...f.items, ...art] };
    const before = profileFurnishing(f).quality;
    const after = profileFurnishing(piled);
    expect(after.issues).toEqual([]);
    expect(after.type).toBe('standard');
    expect(after.quality - before).toBeCloseTo(1 / 10, 9); // one art piece's worth, at tier 2
  });

  it('a one-tile room sleeps four at most, however many beds go in', () => {
    const items: FurnitureItem[] = [
      { id: 'bath', kind: 'bath_shower', tier: 1, x: 2, y: 0, rot: 0 },
      { id: 'bed', kind: 'bunk', tier: 1, x: 0, y: 0, rot: 0 },
      { id: 'bed-2', kind: 'bunk', tier: 1, x: 1, y: 0, rot: 0 },
      { id: 'bed-3', kind: 'bunk', tier: 1, x: 3, y: 2, rot: 0 },
    ];
    const p = profileFurnishing({ preset: 'twin', arrangement: 'bath_back', mirrored: false, custom: true, items });
    expect(p.issues).toEqual([]);
    expect(p).toMatchObject({ sleeps: 4, beds: 4, layoutClass: 'family' });
  });

  it('furnishingOf falls back to the type\'s preset for rooms without furniture', () => {
    expect(furnishingOf({ type: 'deluxe' })).toEqual(defaultFurnishing('compact_deluxe'));
  });
});

describe('Layouts', () => {
  for (const preset of PRESETS) for (const arrangement of ARRANGEMENTS) for (const mirrored of [false, true]) {
    it(`${preset} / ${arrangement}${mirrored ? ' / mirrored' : ''}: works, and no floor is shut off`, () => {
      const f = defaultFurnishing(preset, arrangement, mirrored);
      const { items, issues } = profileFurnishing(f);
      expect(issues).toEqual([]);
      expect(items.map(i => i.id).sort()).toEqual(Object.keys(ROOM_PRESETS[preset].defaults).sort());
      // Every free cell can be walked to from the doorway
      const taken = new Set(items.filter(i => !i.wall).flatMap(cellsOf));
      const reached = new Set(DOORWAY_CELLS);
      const queue = [...DOORWAY_CELLS];
      while (queue.length) {
        const [x, y] = queue.pop()!.split(',').map(Number);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = `${x + dx},${y + dy}`;
          if (x + dx < 0 || y + dy < 0 || x + dx >= ROOM_CELLS || y + dy >= ROOM_CELLS || taken.has(k) || reached.has(k)) continue;
          reached.add(k);
          queue.push(k);
        }
      }
      expect(reached.size + taken.size, 'floor nobody can get to').toBe(ROOM_CELLS * ROOM_CELLS);
      // Mirroring twice, or re-arranging, gets the same layout back
      expect(mirrorFurnishing(mirrorFurnishing(f)).items).toEqual(f.items);
      expect(setArrangement(f, arrangement).items).toEqual(f.items);
    });
  }

  it('the furniture turns with the door: the doorway lands on the side the door faces', () => {
    const doorway = { x: 1, y: ROOM_CELLS - 1, w: 2, h: 1 };
    const side: Record<Direction, (r: ReturnType<typeof rectToWorld>) => boolean> = {
      down: r => r.y + r.h === ROOM_CELLS,
      up: r => r.y === 0,
      left: r => r.x === 0,
      right: r => r.x + r.w === ROOM_CELLS,
    };
    for (const door of DOORS) {
      const r = rectToWorld(door, doorway);
      expect(r.w * r.h).toBe(2);
      expect(side[door](r), door).toBe(true);
      for (const type of TYPES) {
        const [bx, by] = bedSpot({ type, door });
        expect(bx > 0 && bx < ROOM_CELLS && by > 0 && by < ROOM_CELLS).toBe(true);
        for (const [sx, sy] of sleepSpots({ type, door })) expect(sx > 0 && sx < ROOM_CELLS && sy > 0 && sy < ROOM_CELLS).toBe(true);
      }
    }
  });
});

describe('What makes a layout not work', () => {
  const base = defaultFurnishing('classic_queen', 'bath_back');
  const issue = (f: Furnishing) => profileFurnishing({ ...f, custom: true }).issues.map(i => i.code);
  const at = (id: string, change: Partial<FurnitureItem>) => withItems(base, i => (i.id === id ? { ...i, ...change } : i));

  it('no bed, or no bathroom', () => {
    expect(issue({ ...base, items: base.items.filter(i => i.id !== 'bed') })).toContain('no_bed');
    expect(issue({ ...base, items: base.items.filter(i => i.id !== 'bath') })).toContain('no_bath');
  });
  it('pieces on top of each other, off the grid, or in a size they don\'t come in', () => {
    expect(issue(at('seat', { x: 0, y: 0 }))).toContain('overlap');
    expect(issue(at('storage', { x: 4, y: 0 }))).toContain('outside');
    expect(issue(at('bath', { length: 4 }))).toContain('size');
  });
  it('the doorway blocked', () => {
    expect(issue(at('seat', { x: 1, y: 3 }))).toContain('doorway');
  });
  it('a piece nobody can get to', () => {
    // The armchair boxed into the corner behind the bed and the bathroom
    const boxed = withItems(base, i => (i.id === 'bed' ? { ...i, x: 0, y: 1 } : i.id === 'storage' ? { ...i, x: 3, y: 3 } : i.id === 'seat' ? { ...i, x: 0, y: 0 } : i));
    expect(issue(boxed)).toContain('unreachable');
  });
  it('a wall piece hung in the middle of the room, or inside the bathroom', () => {
    expect(issue(at('tv', { x: 1, y: 2, rot: 0 }))).toContain('wall');
    expect(issue(at('tv', { x: 2, y: 1, rot: 3 }))).toContain('wall');
    expect(issue(at('tv', { x: 1, y: 1, rot: 1 }))).not.toContain('wall'); // on the bathroom's outside wall
  });
  it('a room that doesn\'t work can\'t be refitted to, and says why', () => {
    expect(validateFurnishing({ ...base, items: base.items.filter(i => i.id !== 'bed') }, 5)).toBe('Needs a bed');
    expect(validateFurnishing(at('seat', { x: 1, y: 3 }), 5)).toBe('Keep the doorway clear');
    expect(refitRoom(hotel(1), 'room-0-0-2', { ...base, items: base.items.filter(i => i.id !== 'bath') }, 'now')).toBeNull();
  });
});

// Random layouts, to check nothing about a room can be had for less than it should cost
describe('Any layout at all', () => {
  const KINDS = Object.keys(FURNITURE) as FurnitureKind[];
  /** A preset's layout with a few random changes: pieces moved, turned, added, taken out, swapped, upgraded. */
  function random(seed: number): Furnishing {
    const prng = new PRNG(seed);
    const pick = <T,>(list: T[]): T => list[Math.floor(prng.next() * list.length)];
    let items = defaultFurnishing(pick(PRESETS), pick(ARRANGEMENTS), prng.next() < 0.5).items;
    const changes = 1 + Math.floor(prng.next() * 4);
    for (let k = 0; k < changes; k++) {
      const roll = prng.next();
      const target = pick(items);
      if (roll < 0.3 && target) items = items.map(i => (i === target ? { ...i, x: Math.floor(prng.next() * ROOM_CELLS), y: Math.floor(prng.next() * ROOM_CELLS) } : i));
      else if (roll < 0.45 && target) items = items.map(i => (i === target ? { ...i, rot: ((i.rot + 1) % 4) as Rot } : i));
      else if (roll < 0.65) {
        const kind = pick(KINDS);
        const spec = FURNITURE[kind];
        items = [...items, {
          id: `p${k}`, kind, tier: (prng.next() < 0.5 ? 1 : 2) as Tier,
          x: Math.floor(prng.next() * ROOM_CELLS), y: Math.floor(prng.next() * ROOM_CELLS), rot: Math.floor(prng.next() * 4) as Rot,
          ...(spec.sizes && prng.next() < 0.3 ? { length: spec.sizes[0][1] } : {}),
        }];
      } else if (roll < 0.75 && target) items = items.filter(i => i !== target);
      else if (roll < 0.9 && target) items = items.map(i => (i === target ? { ...i, kind: pick(GROUP_KINDS[FURNITURE[i.kind].group]), length: undefined } : i));
      else if (target) items = items.map(i => (i === target ? { ...i, tier: (3 - i.tier) as Tier } : i));
    }
    return { preset: 'classic_queen', arrangement: 'bath_front', mirrored: false, custom: true, items };
  }

  it('classifies consistently: sleeps and beds capped, quality in range, a price and a cost that follow from the pieces', () => {
    let bookable = 0;
    for (let seed = 1; seed <= 4000; seed++) {
      const f = random(seed);
      const p = profileFurnishing(f);
      expect(p.sleeps).toBeLessThanOrEqual(FURNISHING.sleepsPerTile);
      expect(p.beds).toBeLessThanOrEqual(p.sleeps);
      expect(p.quality).toBeGreaterThanOrEqual(1);
      expect(p.quality).toBeLessThanOrEqual(2);
      expect(p.furnishingCost).toBe(1200 + f.items.reduce((sum, i) => sum + FURNITURE[i.kind].cost[i.tier], 0));
      if (p.type === 'suite') expect(p.hasLounge && p.quality >= FURNISHING.deluxeQuality - 1e-9).toBe(true);
      if (p.layoutClass === 'family') expect(p.sleeps).toBeGreaterThanOrEqual(3);
      if (p.issues.length === 0) {
        bookable++;
        expect(p.sleeps).toBeGreaterThan(0);
        expect(f.items.some(i => FURNITURE[i.kind].group === 'bath')).toBe(true);
        // Every piece is on the grid and on nothing else, and the doorway is clear
        const cells = p.items.filter(i => !i.wall).flatMap(cellsOf);
        expect(new Set(cells).size).toBe(cells.length);
        expect(cells.some(c => DOORWAY_CELLS.includes(c))).toBe(false);
      }
      // Another copy of a non-bed piece never changes how nice the room is
      const extra = f.items.find(i => FURNITURE[i.kind].group !== 'bed');
      if (extra) {
        const copy = { ...f, items: [...f.items, { ...extra, id: 'copy', tier: Math.min(extra.tier, 1) as Tier }] };
        expect(profileFurnishing(copy).quality).toBeLessThanOrEqual(p.quality + 1e-9);
      }
    }
    expect(bookable).toBeGreaterThan(800); // the checks on working rooms ran
  });
});

describe('Refit quotes', () => {
  const base = defaultFurnishing('classic_queen');

  it('nothing changed costs nothing', () => {
    expect(quoteRefit(base, defaultFurnishing('classic_queen'))).toMatchObject({ cost: 0, installHours: 0, changed: [], moved: false });
  });

  it('new pieces, less half what the old ones were worth, plus the fitting premium', () => {
    // (900 + 1300 + 200 new) - (300 + 350 + 50) / 2 back = 2,050; x1.4 = 2,870.
    // Bed 2h + bathroom 6h + rail 0.5h = 8.5h, rounded up.
    const q = quoteRefit(base, deluxeQueen());
    expect(q).toMatchObject({ cost: 2870, installHours: 9, moved: false });
    expect(q.changed.sort()).toEqual(['bath', 'bed', 'storage']);
    expect(q.after.type).toBe('deluxe');
  });

  it('moving the bathroom means re-plumbing it; moving the rest takes a little time', () => {
    // Half the shower room's $350 again, x1.4; its 6 hours, and a quarter hour per other piece moved
    expect(quoteRefit(base, mirrorFurnishing(base))).toMatchObject({ cost: 245, installHours: 7, changed: [], moved: true, replumbed: true });
    expect(quoteRefit(base, setArrangement(base, 'bath_back'))).toMatchObject({ cost: 245, installHours: 7, replumbed: true });
    const chairMoved = withItems(base, i => (i.id === 'seat' ? { ...i, x: 0, y: 2 } : i));
    expect(quoteRefit(base, chairMoved)).toMatchObject({ cost: 0, installHours: 1, moved: true, replumbed: false });
  });

  it('a new layout name with every piece where it was moves nothing', () => {
    expect(quoteRefit(base, { ...base, preset: 'compact_deluxe' })).toMatchObject({ cost: 0, installHours: 0, moved: true, replumbed: false });
  });

  it('starting from another preset brings its furniture, keeping the bathroom where it is', () => {
    const studio = switchPreset({ ...base, arrangement: 'bath_back', mirrored: true }, 'exec_studio');
    expect(studio).toEqual(defaultFurnishing('exec_studio', 'bath_back', true));
    // King 1,200 + tub 2,000 + sofa 3,500 + wardrobe 500 + TV 500 + art 1,100 = 8,800 new,
    // less half the standard kit's 800 back = 8,400; x1.4 = 11,760. 2 + 6 + 1 + 1 + 0.5 + 0.5 = 11h.
    expect(quoteRefit(base, switchPreset(base, 'exec_studio'))).toMatchObject({ cost: 11760, installHours: 11, replumbed: false });
  });

  it('downgrading never pays out', () => {
    expect(quoteRefit(defaultFurnishing('exec_studio'), base).cost).toBe(0);
    expect(quoteRefit(defaultFurnishing('compact_deluxe'), base).cost).toBe(0);
  });

  it('a second bed turns a double into a family room', () => {
    const family = { ...base, custom: true, items: [...base.items.filter(i => i.id !== 'seat'), { id: 'bed-2', kind: 'bed_single' as const, tier: 1 as const, x: 0, y: 2, rot: 0 as const }] };
    const p = profileFurnishing(family);
    expect(p.issues).toEqual([]);
    expect(p).toMatchObject({ layoutClass: 'family', sleeps: 3, label: 'Standard Family Room' });
    // A single bed in, an armchair out (half its $50 back), x1.4
    expect(quoteRefit(base, family).cost).toBe(Math.round((200 - 25) * 1.4));
  });

  it('the cheapest way up to the same room as a deluxe or a suite, by refitting, costs about what building it would', () => {
    // (A premium single bed makes a cheaper deluxe room -- a Deluxe Single, at three quarters of the price)
    const cheapest = (preset: PresetId, type: RoomType) => {
      const layoutClass = profileFurnishing(defaultFurnishing(preset)).layoutClass;
      const pieces = ROOM_PRESETS[preset].arrangements.bath_front.pieces;
      let best = Infinity;
      const choices = pieces.map(piece => {
        const group = FURNITURE[ROOM_PRESETS[preset].defaults[piece.id].kind].group;
        return GROUP_KINDS[group].flatMap(kind => [1, 2].map(tier => ({ ...piece, kind, tier: tier as Tier })));
      });
      const walk = (i: number, picked: Array<{ id: string; kind: FurnitureKind; tier: Tier }>) => {
        if (i === choices.length) {
          const f: Furnishing = { preset, arrangement: 'bath_front', mirrored: false, items: arrangeItems(preset, 'bath_front', false, picked) };
          const p = profileFurnishing(f);
          if (p.type === type && p.layoutClass === layoutClass && p.issues.length === 0) best = Math.min(best, ROOM_CONFIG.standard.buildCost + quoteRefit(base, f).cost);
          return;
        }
        for (const c of choices[i]) walk(i + 1, [...picked, c]);
      };
      walk(0, []);
      return best;
    };
    expect(cheapest('classic_queen', 'deluxe')).toBeGreaterThan(ROOM_CONFIG.deluxe.buildCost * 0.9);
    expect(cheapest('exec_studio', 'suite')).toBeGreaterThan(ROOM_CONFIG.suite.buildCost * 0.85);
  });
});

describe('What can be fitted', () => {
  it('furniture unlocks with peak stars', () => {
    expect(isFurnitureUnlocked('bed_queen', 1, 1)).toBe(true);
    expect(isFurnitureUnlocked('bed_queen', 2, 1)).toBe(false);
    expect(isFurnitureUnlocked('bed_king', 1, 1)).toBe(false);
    expect(isFurnitureUnlocked('bunk', 1, 1)).toBe(true);
    expect(isFurnitureUnlocked('sofa', 1, 2)).toBe(false);
    expect(isFurnitureUnlocked('sofa_bed', 1, 2)).toBe(true);
    expect(isFurnitureUnlocked('sofa', 2, 3)).toBe(true);
  });

  it('a furnishing must be unlocked, its ids unique', () => {
    expect(validateFurnishing(defaultFurnishing('classic_queen'), 1)).toBeNull();
    expect(validateFurnishing(defaultFurnishing('twin'), 1)).toBeNull();
    expect(validateFurnishing(defaultFurnishing('bunk_family'), 1)).toBeNull();
    expect(validateFurnishing(deluxeQueen(), 1)).toMatch(/star rating/);
    expect(validateFurnishing(deluxeQueen(), 2)).toBeNull();
    expect(validateFurnishing(defaultFurnishing('exec_studio'), 2)).toMatch(/star rating/);
    expect(validateFurnishing(defaultFurnishing('exec_studio'), 3)).toBeNull();
    const f = defaultFurnishing('classic_queen');
    expect(validateFurnishing({ ...f, items: [...f.items, { ...f.items[0] }] }, 5)).toMatch(/share an id/);
    for (const kind of Object.keys(FURNITURE) as FurnitureKind[]) expect(GROUP_KINDS[FURNITURE[kind].group]).toContain(kind);
  });
});

describe('What a room is worth follows what\'s in it', () => {
  it('refund, renovation and value read the furniture; the original rooms\' numbers are unchanged', () => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
    TYPES.forEach((type, x) => { s = addRoom(s, type, x, 2)!; });
    for (const room of s.rooms) expect(getRoomInvestedCost(room)).toBe(ROOM_CONFIG[room.type].buildCost);
    const refitted = { ...s.rooms[0], furnishing: deluxeQueen(), type: 'deluxe' as const };
    expect(getRoomInvestedCost(refitted)).toBe(1200 + 900 + 1300 + 200 + 50 + 50);
    const before = calculateValuation(s);
    const after = calculateValuation({ ...s, rooms: [refitted, ...s.rooms.slice(1)] });
    expect(after - before).toBeCloseTo(1700, 6); // $3,700 of room where there was $2,000
    const demolished = demolishRoom({ ...s, rooms: [refitted, ...s.rooms.slice(1)] }, refitted.id)!;
    expect(demolished.cash - s.cash).toBe(getDemolishRefund(3700));
  });
});

describe('Refitting a room', () => {
  it('now: an empty room closes for the fitting, becomes what it is furnished as, and reopens fresher', () => {
    let s = hotel(1);
    s = { ...s, rooms: s.rooms.map(r => ({ ...r, decor: 40 })) };
    const room = s.rooms[0];
    const after = refitRoom(s, room.id, deluxeQueen(), 'now')!;
    const refitted = after.rooms[0];
    expect(after.cash).toBe(s.cash - 2870);
    expect(refitted).toMatchObject({ type: 'deluxe', status: 'renovating', renovationHoursRemaining: 9 });
    expect(refitted.furnishing).toEqual(deluxeQueen());
    expect(refitted.pricePerNight).toBe(Math.max(ROOM_CONFIG.deluxe.minPrice, Math.min(ROOM_CONFIG.deluxe.maxPrice, getExpectedPrice('deluxe', s.starRating, 0))));
    expect(after.noiseSources.length).toBe(s.noiseSources.length + 1);

    // It freshens the room as far as $2,870 would go on renovating it
    const share = Math.min(1, 2870 / getRenovationCost(getRoomInvestedCost(refitted), s.starRating));
    let t = after;
    for (let h = 0; h < 8; h++) {
      t = decayDecor(processRenovationTick(t).state);
      expect(t.rooms[0].status).toBe('renovating');
    }
    const done = processRenovationTick(t);
    expect(done.state.rooms[0]).toMatchObject({ status: 'vacant', renovationHoursRemaining: 0, refitting: undefined });
    expect(done.state.rooms[0].decor).toBeCloseTo(40 + 60 * share, 6);
    expect(done.events[0].message).toMatch(/refitted: Deluxe Queen/);
  });

  it('swapping pieces for cheaper ones is no cheaper a way to freshen decor than renovating', () => {
    const cheaperKind: Record<string, FurnitureKind> = { bed_king: 'bed_queen', bath_tub: 'bath_shower', wardrobe: 'rail', desk: 'armchair' };
    for (const type of ['deluxe', 'suite'] as const) {
      let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 4, starRating: 4 };
      s = addRoom(s, type, 0, 2)!;
      s = { ...s, rooms: s.rooms.map(r => ({ ...r, decor: 20 })) };
      const f = furnishingOf(s.rooms[0]);
      const cheaper = withItems(f, i => ({ ...i, kind: cheaperKind[i.kind] ?? i.kind }));
      expect(profileFurnishing(cheaper).type).toBe(type);
      const quote = quoteRefit(f, cheaper);
      let t = refitRoom(s, s.rooms[0].id, cheaper, 'now')!;
      while (t.rooms[0].status === 'renovating') t = processRenovationTick(t).state;
      const perPoint = getRenovationCost(profileFurnishing(cheaper).furnishingCost, s.starRating) / 80; // renovating: 20 -> 100
      expect(t.rooms[0].decor - 20).toBeLessThanOrEqual(quote.cost / perPoint + 1e-9);
    }
  });

  it('a refit that keeps the category and who it fits keeps the price; one for other people resets it', () => {
    let s = hotel(1);
    s = { ...s, rooms: s.rooms.map(r => ({ ...r, pricePerNight: 123 })) };
    const desk = withItems(defaultFurnishing('classic_queen'), i => (i.id === 'seat' ? { ...i, kind: 'desk' as const } : i));
    expect(refitRoom(s, s.rooms[0].id, desk, 'now')!.rooms[0]).toMatchObject({ type: 'standard', pricePerNight: 123 });
    const twin = switchPreset(defaultFurnishing('classic_queen'), 'twin');
    expect(refitRoom(s, s.rooms[0].id, twin, 'now')!.rooms[0].pricePerNight).toBe(Math.round(getExpectedPrice('standard', s.starRating) * 1.05));
  });

  it('is refused if it changes nothing, is locked, can\'t be afforded, or the room isn\'t empty', () => {
    const s = hotel(1);
    const id = s.rooms[0].id;
    expect(refitRoom(s, id, defaultFurnishing('classic_queen'), 'now')).toBeNull();
    expect(refitRoom({ ...s, peakStarRating: 1 }, id, deluxeQueen(), 'now')).toBeNull();
    expect(refitRoom({ ...s, cash: 2869 }, id, deluxeQueen(), 'now')).toBeNull();
    const occupied = { ...s, rooms: s.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'g' })) };
    expect(refitRoom(occupied, id, deluxeQueen(), 'now')).toBeNull();
  });

  it('after checkout: booked for free, paid and started once the room is empty', () => {
    const s = hotel(1);
    const id = s.rooms[0].id;
    const occupied = { ...s, rooms: s.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'g' })) };
    const booked = refitRoom(occupied, id, deluxeQueen(), 'checkout')!;
    expect(booked.cash).toBe(s.cash);
    expect(booked.rooms[0]).toMatchObject({ type: 'standard', status: 'occupied', pendingRefit: deluxeQueen() });
    expect(startPendingRefits(booked)).toBe(booked); // still occupied
    expect(cancelPendingRefit(booked, id).rooms[0].pendingRefit).toBeUndefined();

    const emptied = { ...booked, rooms: booked.rooms.map(r => ({ ...r, status: 'vacant' as const, guestId: undefined })) };
    const broke = { ...emptied, cash: 100 };
    expect(startPendingRefits(broke).rooms[0].pendingRefit).toBeDefined(); // waits for the money
    const started = startPendingRefits(emptied);
    expect(started.cash).toBe(s.cash - 2870);
    expect(started.rooms[0]).toMatchObject({ type: 'deluxe', status: 'renovating', pendingRefit: undefined });
  });

  it('"after checkout" on an empty room refits it now, or books it until it can be afforded', () => {
    const s = hotel(1);
    expect(refitRoom(s, s.rooms[0].id, deluxeQueen(), 'checkout')!.rooms[0].status).toBe('renovating');
    const broke = refitRoom({ ...s, cash: 100 }, s.rooms[0].id, deluxeQueen(), 'checkout')!;
    expect(broke.cash).toBe(100);
    expect(broke.rooms[0]).toMatchObject({ status: 'vacant', type: 'standard', pendingRefit: deluxeQueen() });
  });
});

describe('Refitting every room like this one', () => {
  it('empty rooms now, occupied ones after checkout; rooms already like it, or laid out otherwise, are left alone', () => {
    let s = hotel(4);
    s = addRoom({ ...s, peakStarRating: 5 }, 'deluxe', 4, 2)!;
    const [a, b, c, d, deluxe] = s.rooms;
    s = {
      ...s,
      rooms: s.rooms.map(r => (r.id === c.id ? { ...r, status: 'occupied' as const, guestId: 'g' } : r.id === d.id ? { ...r, furnishing: deluxeQueen(), type: 'deluxe' as const } : r)),
    };
    expect(roomsToRefitLike(s, deluxeQueen(), 'classic_queen', a.id).map(r => r.id)).toEqual([b.id, c.id]);
    const after = refitAllLike(s, deluxeQueen(), 'classic_queen', a.id)!;
    const byId = (id: string) => after.rooms.find(r => r.id === id)!;
    expect(byId(a.id)).toMatchObject({ type: 'standard', status: 'vacant' });
    expect(byId(b.id)).toMatchObject({ type: 'deluxe', status: 'renovating' });
    expect(byId(c.id)).toMatchObject({ type: 'standard', status: 'occupied', pendingRefit: deluxeQueen() });
    expect(byId(d.id)).toEqual(s.rooms.find(r => r.id === d.id));
    expect(byId(deluxe.id)).toEqual(s.rooms.find(r => r.id === deluxe.id));
    expect(after.cash).toBe(s.cash - 2870);
    expect(refitAllLike(s, deluxeQueen(), 'exec_studio', a.id)).toBeNull();
    // An empty room that can't be afforded yet is booked, replacing what it was booked for before
    const desk = withItems(defaultFurnishing('classic_queen'), i => (i.id === 'seat' ? { ...i, kind: 'desk' as const } : i));
    const older = { ...s, cash: 100, rooms: s.rooms.map(r => (r.id === b.id ? { ...r, pendingRefit: desk } : r)) };
    const booked = refitAllLike(older, deluxeQueen(), 'classic_queen', a.id)!;
    expect(booked.rooms.find(r => r.id === b.id)).toMatchObject({ status: 'vacant', pendingRefit: deluxeQueen() });
    expect(booked.cash).toBe(100);
    // Once done, there's nothing left to copy to: B is refitted and C is booked for it
    expect(roomsToRefitLike(after, deluxeQueen(), 'classic_queen', a.id)).toEqual([]);
    expect(refitAllLike(after, deluxeQueen(), 'classic_queen', a.id)).toBeNull();
  });
});

describe('Saves from before', () => {
  beforeEach(() => localStorage.clear());

  it('from before furniture: every room furnished as its type, so nothing about it changes', () => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
    TYPES.forEach((type, x) => { s = addRoom(s, type, x, 2)!; });
    const v18 = { ...s, rooms: s.rooms.map(({ furnishing: _, ...r }) => r) };
    localStorage.setItem('hotel-game-save', JSON.stringify({ version: 18, prngState: 7, state: v18, timestamp: 0 }));
    const loaded = loadGame()!;
    expect(loaded.version).toBe(20);
    for (const room of loaded.state.rooms) {
      expect(room.furnishing).toEqual(defaultFurnishing(PRESET_FOR_TYPE[room.type]));
      expect(profileRoom(room).type).toBe(room.type);
    }
    expect(loaded.state.rooms.map(r => r.pricePerNight)).toEqual(s.rooms.map(r => r.pricePerNight));
  });

  it('from before pieces had places: each goes where its layout put it, and the room is what it was', () => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
    TYPES.forEach((type, x) => { s = addRoom(s, type, x, 2)!; });
    // The furnishings as they were saved: pieces by slot, with no position
    const old = (f: Furnishing) => ({ preset: f.preset, arrangement: f.arrangement, mirrored: f.mirrored, items: f.items.map(i => ({ slot: i.id, kind: i.kind, tier: i.tier })) });
    const custom = mirrorFurnishing(setArrangement(deluxeQueen(), 'bath_back'));
    const v19 = {
      ...s,
      rooms: s.rooms.map((r, i) => ({ ...r, furnishing: old(i === 0 ? custom : r.furnishing!), ...(i === 1 ? { pendingRefit: old(custom) } : {}) })),
    };
    localStorage.setItem('hotel-game-save', JSON.stringify({ version: 19, prngState: 7, state: v19, timestamp: 0 }));
    const loaded = loadGame()!;
    expect(loaded.version).toBe(20);
    expect(loaded.state.rooms[0].furnishing).toEqual(custom);
    expect(loaded.state.rooms[1].pendingRefit).toEqual(custom);
    for (const room of loaded.state.rooms.slice(1)) expect(room.furnishing).toEqual(defaultFurnishing(PRESET_FOR_TYPE[room.type]));
  });
});

describe('Refits in a running hotel', () => {
  it('booked refits start as guests leave, and nobody is put in a room being refitted', () => {
    let s = hotel(8, 1);
    const prng = new PRNG(5);
    let refitsSeen = 0;
    const step = () => {
      s = settleChanges(s, STRATEGIES.balanced(s), hourStart(s));
      s = tickSimulation(s, prng).state;
      for (const room of s.rooms) {
        if (room.status !== 'renovating') continue;
        expect(room.guestId).toBeUndefined();
        const now = hourStart(s);
        const headedThere = s.guests.some(g => (g.trip ?? []).some(l => l.kind === 'stay' && l.placeId === room.id && l.end > now));
        expect(headedThere).toBe(false);
        refitsSeen++;
      }
    };
    for (let h = 0; h < 24 * 20; h++) step();
    s = { ...s, cash: Math.max(s.cash, 100_000), peakStarRating: Math.max(2, s.peakStarRating) };
    const standard = s.rooms.filter(r => r.type === 'standard');
    expect(standard.length).toBeGreaterThan(0);
    for (const room of standard) s = refitRoom(s, room.id, deluxeQueen(), 'checkout') ?? s;
    for (let h = 0; h < 24 * 20; h++) step();
    for (const room of standard) {
      const now = s.rooms.find(r => r.id === room.id);
      if (!now) continue; // the bot may have rebuilt it
      expect(now.pendingRefit).toBeUndefined();
    }
    expect(s.rooms.filter(r => standard.some(o => o.id === r.id) && r.type === 'deluxe').length).toBeGreaterThan(0);
    expect(refitsSeen).toBeGreaterThan(0); // the checks above ran
  });
});
