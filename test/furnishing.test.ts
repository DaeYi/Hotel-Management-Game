import { describe, it, expect, beforeEach } from 'vitest';
import { createStarterHotel, addRoom, refitRoom, cancelPendingRefit, startPendingRefits, refitAllLike, roomsToRefitLike, getRenovationCost } from '../src/simulation/HotelState.js';
import {
  defaultFurnishing, furnishingOf, profileFurnishing, profileRoom, quoteRefit, validateFurnishing,
  switchPreset, isFurnitureUnlocked, rectToWorld, bedSpot, wallBar,
} from '../src/simulation/RoomProfile.js';
import { processRenovationTick, decayDecor } from '../src/simulation/DecorManager.js';
import { getExpectedPrice } from '../src/simulation/StarRatingManager.js';
import { loadGame } from '../src/simulation/SaveManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { hourStart } from '../src/simulation/Movement.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { PRNG } from '../src/simulation/prng.js';
import { ROOM_CONFIG } from '../src/config/balance.js';
import { FURNITURE, ROOM_PRESETS, PRESET_FOR_TYPE, ROOM_CELLS, SLOT_KINDS, type PresetId, type ArrangementId, type FurnitureKind } from '../src/config/furniture.js';
import type { HotelState, Furnishing, RoomType, Direction } from '../src/simulation/types.js';

const TYPES: RoomType[] = ['standard', 'deluxe', 'suite'];
const PRESETS = Object.keys(ROOM_PRESETS) as PresetId[];
const ARRANGEMENTS: ArrangementId[] = ['bath_front', 'bath_back'];
const DOORS: Direction[] = ['up', 'down', 'left', 'right'];

/** A Standard Queen with premium bed, bathroom and storage: deluxe on quality alone. */
function deluxeQueen(): Furnishing {
  const f = defaultFurnishing('classic_queen');
  return { ...f, items: f.items.map(i => (['bed', 'bath', 'storage'].includes(i.slot) ? { ...i, tier: 2 as const } : i)) };
}

/** A starter hotel with `n` standard rooms on row 2, cash to spare, at `stars`. */
function hotel(n: number, stars = 3): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: stars, starRating: stars };
  for (let x = 0; x < n; x++) s = addRoom(s, 'standard', x, 2)!;
  return s;
}

describe('A room is what it is furnished with', () => {
  it("each type's preset is exactly that type, at exactly its build cost", () => {
    for (const type of TYPES) {
      const preset = PRESET_FOR_TYPE[type];
      expect(ROOM_PRESETS[preset].legacyType).toBe(type);
      for (const arrangement of ARRANGEMENTS) for (const mirrored of [false, true]) {
        const profile = profileFurnishing(defaultFurnishing(preset, arrangement, mirrored));
        expect(profile.type).toBe(type);
        expect(profile.furnishingCost).toBe(ROOM_CONFIG[type].buildCost);
      }
    }
    expect(profileFurnishing(defaultFurnishing('classic_queen')).label).toBe('Standard Queen');
    expect(profileFurnishing(defaultFurnishing('compact_deluxe')).label).toBe('Deluxe King');
    expect(profileFurnishing(defaultFurnishing('exec_studio')).label).toBe('Junior Suite');
  });

  it('new rooms are built with their type\'s furniture', () => {
    let s = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
    TYPES.forEach((type, x) => { s = addRoom(s, type, x, 2)!; });
    for (const room of s.rooms) {
      expect(room.furnishing).toEqual(defaultFurnishing(PRESET_FOR_TYPE[room.type]));
      expect(profileRoom(room).type).toBe(room.type);
    }
  });

  it('premium pieces make a room deluxe; a lounge without the quality is still standard', () => {
    expect(profileFurnishing(deluxeQueen())).toMatchObject({ type: 'deluxe', label: 'Deluxe Queen' });
    // Two premium pieces aren't enough
    const f = defaultFurnishing('classic_queen');
    const two = { ...f, items: f.items.map(i => (['bed', 'bath'].includes(i.slot) ? { ...i, tier: 2 as const } : i)) };
    expect(profileFurnishing(two).type).toBe('standard');
    // A studio layout with its sofa but basic everything else is a standard room
    const suite = defaultFurnishing('exec_studio');
    const studio = { ...suite, items: suite.items.map(i => ({ ...i, tier: 1 as const })) };
    expect(profileFurnishing(studio)).toMatchObject({ type: 'standard', hasLounge: true });
  });

  it('furnishingOf falls back to the type\'s preset for rooms without furniture', () => {
    expect(furnishingOf({ type: 'deluxe' })).toEqual(defaultFurnishing('compact_deluxe'));
  });
});

describe('Layouts', () => {
  for (const preset of PRESETS) for (const arrangement of ARRANGEMENTS) for (const mirrored of [false, true]) {
    it(`${preset} / ${arrangement}${mirrored ? ' / mirrored' : ''}: everything fits, nothing overlaps, every piece can be reached from the door`, () => {
      const { items } = profileFurnishing(defaultFurnishing(preset, arrangement, mirrored));
      expect(items.map(i => i.slot).sort()).toEqual([...ROOM_PRESETS[preset].slots].sort());
      const taken = new Set<string>();
      for (const item of items) {
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.y).toBeGreaterThanOrEqual(0);
        expect(item.x + item.w).toBeLessThanOrEqual(ROOM_CELLS);
        expect(item.y + item.h).toBeLessThanOrEqual(ROOM_CELLS);
        if (item.wall) continue;
        for (let x = item.x; x < item.x + item.w; x++) for (let y = item.y; y < item.y + item.h; y++) {
          expect(taken.has(`${x},${y}`), `${item.slot} overlaps at ${x},${y}`).toBe(false);
          taken.add(`${x},${y}`);
        }
      }
      expect(taken.has('1,3') || taken.has('2,3')).toBe(false); // the cells inside the door

      // Walk the free floor from the doorway: every piece borders it, and no floor is shut off
      const reached = new Set(['1,3', '2,3']);
      const queue = [[1, 3], [2, 3]];
      const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      while (queue.length) {
        const [x, y] = queue.pop()!;
        for (const [dx, dy] of steps) {
          const k = `${x + dx},${y + dy}`;
          if (x + dx < 0 || y + dy < 0 || x + dx >= ROOM_CELLS || y + dy >= ROOM_CELLS || taken.has(k) || reached.has(k)) continue;
          reached.add(k);
          queue.push([x + dx, y + dy]);
        }
      }
      expect(reached.size + taken.size, 'floor nobody can get to').toBe(ROOM_CELLS * ROOM_CELLS);
      for (const item of items.filter(i => !i.wall)) {
        let reachable = false;
        for (let x = item.x; x < item.x + item.w; x++) for (let y = item.y; y < item.y + item.h; y++) {
          if (steps.some(([dx, dy]) => reached.has(`${x + dx},${y + dy}`))) reachable = true;
        }
        expect(reachable, `${item.slot} can't be reached`).toBe(true);
      }
      // Wall pieces hang on a wall: the room's edge or a bathroom wall
      const bath = items.find(i => i.slot === 'bath')!;
      for (const item of items.filter(i => i.wall)) {
        const bar = wallBar(item);
        const line = item.edge === 'top' || item.edge === 'bottom' ? bar.y + (item.edge === 'bottom' ? bar.h : 0) : bar.x + (item.edge === 'right' ? bar.w : 0);
        const onRoomEdge = line === 0 || line === ROOM_CELLS;
        const onBath = (item.edge === 'left' || item.edge === 'right') && (line === bath.x || line === bath.x + bath.w);
        expect(onRoomEdge || onBath, `${item.slot} isn't on a wall`).toBe(true);
      }
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
      }
    }
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

  it('moving the bathroom means re-plumbing it', () => {
    // Half the shower room's $350 again, x1.4; and its 6 hours
    for (const moved of [{ ...base, mirrored: true }, { ...base, arrangement: 'bath_back' as const }]) {
      expect(quoteRefit(base, moved)).toMatchObject({ cost: 245, installHours: 6, changed: [], moved: true, replumbed: true });
    }
  });

  it("a new layout that leaves the bathroom where it is doesn't re-plumb it", () => {
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
    expect(quoteRefit(defaultFurnishing('compact_deluxe'), switchPreset(base, 'compact_deluxe')).cost).toBeGreaterThanOrEqual(0);
    expect(quoteRefit(defaultFurnishing('exec_studio'), base).cost).toBe(0);
  });

  it('the cheapest route to each category through refits costs no less than building it', () => {
    // From a standard room, the refit to the cheapest deluxe and suite
    // furnishings costs about what the bigger room costs to build, so the
    // refit is a way to upgrade in place, not a discount.
    const cheapest = (preset: PresetId, type: RoomType) => {
      const p = ROOM_PRESETS[preset];
      let best = Infinity;
      const choices = p.slots.map(slot => SLOT_KINDS[slot].flatMap(kind => [1, 2].map(tier => ({ slot, kind, tier: tier as 1 | 2 }))));
      const walk = (i: number, items: Furnishing['items']) => {
        if (i === choices.length) {
          const f: Furnishing = { preset, arrangement: 'bath_front', mirrored: false, items };
          if (profileFurnishing(f).type === type) best = Math.min(best, ROOM_CONFIG.standard.buildCost + quoteRefit(base, f).cost);
          return;
        }
        for (const c of choices[i]) walk(i + 1, [...items, c]);
      };
      walk(0, []);
      return best;
    };
    expect(cheapest('classic_queen', 'deluxe')).toBeGreaterThan(ROOM_CONFIG.deluxe.buildCost * 0.9);
    expect(cheapest('exec_studio', 'suite')).toBeGreaterThan(ROOM_CONFIG.suite.buildCost * 0.9);
  });
});

describe('What can be fitted', () => {
  it('furniture unlocks with peak stars', () => {
    expect(isFurnitureUnlocked('bed_queen', 1, 1)).toBe(true);
    expect(isFurnitureUnlocked('bed_queen', 2, 1)).toBe(false);
    expect(isFurnitureUnlocked('bed_king', 1, 1)).toBe(false);
    expect(isFurnitureUnlocked('sofa', 1, 2)).toBe(false);
    expect(isFurnitureUnlocked('sofa', 2, 3)).toBe(true);
  });

  it('a furnishing must fill every slot with a piece that goes there, and be unlocked', () => {
    expect(validateFurnishing(defaultFurnishing('classic_queen'), 1)).toBeNull();
    expect(validateFurnishing(deluxeQueen(), 1)).toMatch(/star rating/);
    expect(validateFurnishing(deluxeQueen(), 2)).toBeNull();
    expect(validateFurnishing(defaultFurnishing('exec_studio'), 2)).toMatch(/star rating/);
    expect(validateFurnishing(defaultFurnishing('exec_studio'), 3)).toBeNull();
    const f = defaultFurnishing('classic_queen');
    expect(validateFurnishing({ ...f, items: f.items.filter(i => i.slot !== 'bed') }, 5)).toMatch(/Needs a bed/);
    expect(validateFurnishing({ ...f, items: f.items.map(i => (i.slot === 'seat' ? { ...i, kind: 'bed_queen' as const } : i)) }, 5)).toMatch(/doesn't go/);
    expect(validateFurnishing({ ...f, items: [...f.items, { slot: 'art', kind: 'art', tier: 1 }] }, 5)).toMatch(/no place/);
    for (const kind of Object.keys(FURNITURE) as (keyof typeof FURNITURE)[]) {
      expect(SLOT_KINDS[FURNITURE[kind].slot]).toContain(kind);
    }
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

    // It freshens the room as far as $2,870 would go on a renovation
    const share = Math.min(1, 2870 / getRenovationCost(ROOM_CONFIG.deluxe.buildCost, s.starRating));
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
      // Every piece down to a cheaper one that keeps the category
      const f = furnishingOf(s.rooms[0]);
      const cheaper = { ...f, items: f.items.map(i => ({ ...i, kind: cheaperKind[i.kind] ?? i.kind })) };
      expect(profileFurnishing(cheaper).type).toBe(type);
      const quote = quoteRefit(f, cheaper);
      let t = refitRoom(s, s.rooms[0].id, cheaper, 'now')!;
      while (t.rooms[0].status === 'renovating') t = processRenovationTick(t).state;
      const perPoint = getRenovationCost(ROOM_CONFIG[type].buildCost, s.starRating) / 80; // renovating: 20 -> 100
      expect(t.rooms[0].decor - 20).toBeLessThanOrEqual(quote.cost / perPoint + 1e-9);
    }
  });

  it('a refit that keeps the category keeps the price', () => {
    let s = hotel(1);
    s = { ...s, rooms: s.rooms.map(r => ({ ...r, pricePerNight: 123 })) };
    const f = defaultFurnishing('classic_queen');
    const desk = { ...f, items: f.items.map(i => (i.slot === 'seat' ? { ...i, kind: 'desk' as const } : i)) };
    const after = refitRoom(s, s.rooms[0].id, desk, 'now')!;
    expect(after.rooms[0]).toMatchObject({ type: 'standard', pricePerNight: 123 });
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
    const f = defaultFurnishing('classic_queen');
    const desk = { ...f, items: f.items.map(i => (i.slot === 'seat' ? { ...i, kind: 'desk' as const } : i)) };
    const older = { ...s, cash: 100, rooms: s.rooms.map(r => (r.id === b.id ? { ...r, pendingRefit: desk } : r)) };
    const booked = refitAllLike(older, deluxeQueen(), 'classic_queen', a.id)!;
    expect(booked.rooms.find(r => r.id === b.id)).toMatchObject({ status: 'vacant', pendingRefit: deluxeQueen() });
    expect(booked.cash).toBe(100);
    // Once done, there's nothing left to copy to: B is refitted and C is booked for it
    expect(roomsToRefitLike(after, deluxeQueen(), 'classic_queen', a.id)).toEqual([]);
    expect(refitAllLike(after, deluxeQueen(), 'classic_queen', a.id)).toBeNull();
  });
});

describe('Saves from before furniture', () => {
  beforeEach(() => localStorage.clear());

  it('load with every room furnished as its type, so nothing about it changes', () => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
    TYPES.forEach((type, x) => { s = addRoom(s, type, x, 2)!; });
    const v18 = { ...s, rooms: s.rooms.map(({ furnishing: _, ...r }) => r) };
    localStorage.setItem('hotel-game-save', JSON.stringify({ version: 18, prngState: 7, state: v18, timestamp: 0 }));
    const loaded = loadGame()!;
    expect(loaded.version).toBe(19);
    for (const room of loaded.state.rooms) {
      expect(room.furnishing).toEqual(defaultFurnishing(PRESET_FOR_TYPE[room.type]));
      expect(profileRoom(room).type).toBe(room.type);
    }
    expect(loaded.state.rooms.map(r => r.pricePerNight)).toEqual(s.rooms.map(r => r.pricePerNight));
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
