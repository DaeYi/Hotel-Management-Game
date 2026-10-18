import { describe, it, expect } from 'vitest';
import { ActorLayer } from '../src/render/ActorLayer.js';
import { drawQuirk, COIN_COLOR, QUIRK_GLYPHS } from '../src/render/quirks.js';
import { GRID_OFFSET_X, GRID_OFFSET_Y, TILE_SIZE } from '../src/render/GridRenderer.js';
import { createStarterHotel, addRoom, addFixture } from '../src/simulation/HotelState.js';
import { lanesOf, type Lane } from '../src/simulation/DeskQueue.js';
import { CHECK_IN_HOURS } from '../src/simulation/GuestMovement.js';
import { makeStay, hourStart } from '../src/simulation/Movement.js';
import type { Guest, GuestProfile, HotelState, Party, Walker, StaffMember } from '../src/simulation/types.js';
import { syncStaff } from '../src/simulation/StaffManager.js';

// The front desk as it's drawn (render/ActorLayer.ts): each clerk's line in
// front of them, in the order they'll be served, nobody on top of anybody.

const PROFILE: GuestProfile = { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, patience: 'patient' };

/** An ActorLayer drawing into nothing, keeping where it put each staff square (and, as ever, each guest). */
function layer() {
  const squares: Array<[number, number]> = [];
  const strokes: number[][] = [];
  const g: unknown = new Proxy({}, {
    get: (_t, name) => (...args: number[]) => {
      if (name === 'fillRect' && args[2] === 10 && args[3] === 10) squares.push([args[0] + 5, args[1] + 5]);
      if (name === 'lineTo') strokes.push(args);
      return g;
    },
  });
  const actors = new ActorLayer({ add: { graphics: () => g } } as never);
  return { actors, squares, strokes };
}

describe('Named staff on screen', () => {
  it('draws exactly the on-duty named clerk behind the counter and opens that employee on a click', () => {
    const s = syncStaff(createStarterHotel());
    const { actors, squares } = layer();
    actors.update(s, 0, hourStart(s) + 0.5);
    const drawn = (actors as unknown as { staffDrawn: Array<{ id: string; x: number; y: number }> }).staffDrawn;
    const clerks = drawn.filter(f => s.staffRoster!.find(m => m.id === f.id)?.role === 'front_desk');
    expect(clerks).toHaveLength(1);
    expect(s.staffRoster!.find(m => m.id === clerks[0].id)?.shift).toBe('night');
    const desk = s.fixtures.find(f => f.type === 'desk')!;
    expect(clerks[0].y).toBeLessThan(GRID_OFFSET_Y + (desk.gridY + 1) * TILE_SIZE);
    expect(actors.staffAt(clerks[0].x, clerks[0].y)).toBe(clerks[0].id);
    expect(squares).toHaveLength(drawn.length); // no anonymous desk squares duplicating the roster
  });
  it('draws experience chevrons and picks only the visible worker on the current floor', () => {
    let s = { ...createStarterHotel(), day: 4, hour: 12 };
    const T = hourStart(s);
    const workers: StaffMember[] = ([0, 80, 400] as const).map((workHours, i) => ({
      id: `housekeeper-${100 + i}`, name: `Worker ${i}`, role: 'housekeeper',
      at: { gridX: 4 + i, gridY: 2, floor: 0 },
      profile: { experience: 'rookie', style: 'standard', reliability: 'dependable' },
      stats: { workHours, lateDays: 0, absentDays: 0 },
    }));
    s = { ...s, staffRoster: workers, staffPlan: { start: T, itineraries: workers.map(m => ({ staffId: m.id, legs: [makeStay(m.at!, T, T + 1, 'rest')], end: { at: m.at } })) } };
    const { actors, strokes } = layer();
    actors.update(s, 0, T + 0.5);
    const staff = (actors as unknown as { staffDrawn: Array<{ id: string; x: number; y: number }> }).staffDrawn;
    expect(staff).toHaveLength(3);
    expect(strokes).toHaveLength(6); // one skilled chevron + two veteran chevrons
    for (const f of staff) {
      expect(actors.staffAt(f.x, f.y)).toBe(f.id);
      expect(actors.guestAt(f.x, f.y)).toBeNull();
    }
    expect(actors.staffAt(-100, -100)).toBeNull();
    actors.update(s, 1, T + 0.5);
    expect(actors.staffAt(staff[0].x, staff[0].y)).toBeNull();
  });
});

/** Where on tile (tx, ty) a point is, as fractions of it. */
const onTile = ([x, y]: [number, number], tx: number, ty: number): [number, number] => [(x - GRID_OFFSET_X) / TILE_SIZE - tx, (y - GRID_OFFSET_Y) / TILE_SIZE - ty];

/** Everyone drawn on a tile: id and position in pixels. */
function drawnOn(actors: ActorLayer, tile: { gridX: number; gridY: number }): Array<{ id: string; x: number; y: number }> {
  const drawn = (actors as unknown as { drawn: Array<{ figure: { id: string }; x: number; y: number }> }).drawn;
  return drawn.filter(d => Math.floor((d.x - GRID_OFFSET_X) / TILE_SIZE) === tile.gridX && Math.floor((d.y - GRID_OFFSET_Y) / TILE_SIZE) === tile.gridY)
    .map(d => ({ id: d.figure.id, x: d.x, y: d.y }));
}

function closest(points: Array<{ x: number; y: number }>): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) best = Math.min(best, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
  return best;
}

/** Someone checking in at a lane: in line from `ready` if their turn comes later. */
function arriving(id: string, lane: Lane, ready: number, start: number, party?: Party): Guest {
  return {
    id, name: id, budget: 1000, stayLength: 3, trait: 'normal', satisfaction: 60, checkInDay: 1, isReturning: false, hadNoiseComplaint: false, profile: PROFILE,
    ...(party ? { party } : {}), tripKind: 'arrival',
    trip: [
      ...(start > ready ? [makeStay(lane.front, ready, start, 'wait', { placeId: lane.desk.id, lane: lane.key })] : []),
      makeStay(lane.front, start, start + CHECK_IN_HOURS, 'check_in', { placeId: lane.desk.id, lane: lane.key }),
    ],
  };
}

const at = (s: HotelState, extra: Partial<HotelState>): HotelState => ({ ...s, day: 6, hour: 15, ...extra });

describe('The front desk on screen', () => {
  it('each clerk’s line in front of them, in the order they’ll be served; someone who’ll give up stays behind those there first; two families at the counter apart', () => {
    let s = { ...createStarterHotel(), cash: 1_000_000 };
    s = addRoom(s, 'standard', 3, 2, 0, 'up')!;
    s = at(s, { staff: { ...s.staff, frontDesk: 2 } });
    const [a, b] = lanesOf(s);
    const T = hourStart(s);
    const family: Party = { kind: 'family', size: 4 };
    const quitter: Walker = { id: 'q', trait: 'normal', isReturning: false, reason: 'impatient', profile: { ...PROFILE, patience: 'impatient' }, trip: [makeStay(a.front, T + 0.1, T + 0.25, 'wait', { placeId: a.desk.id, lane: a.key })] };
    s = {
      ...s,
      guests: [
        arriving('f1', a, T, T, family), arriving('f2', b, T, T, family), arriving('c', a, T + 0.05, T + CHECK_IN_HOURS, { kind: 'couple', size: 2 }),
        // At b, z got there before y but is served after them (say y's room was the one free): y stands ahead
        arriving('z', b, T + 0.05, T + 2 * CHECK_IN_HOURS), arriving('y', b, T + 0.1, T + CHECK_IN_HOURS),
      ],
      walkers: [quitter],
    };
    const { actors, squares } = layer();
    actors.update(s, 0, T + 0.2);
    const front = a.front;
    const here = drawnOn(actors, front);
    expect(here).toHaveLength(4 + 4 + 2 + 1 + 2);
    expect(closest(here)).toBeGreaterThan(4); // nobody on top of anybody
    const pos = (id: string) => onTile([here.find(d => d.id === id)!.x, here.find(d => d.id === id)!.y], front.gridX, front.gridY);
    // The desk is above its front: nearest the counter is the smallest y; the couple came first, then q (who'll give up)
    expect(pos('f1')[1]).toBeLessThan(pos('c')[1]);
    expect(pos('c')[1]).toBeLessThan(pos('q')[1]);
    expect(pos('f2')[1]).toBeLessThan(pos('y')[1]);
    expect(pos('y')[1]).toBeLessThan(pos('z')[1]);
    // Each line on its clerk's side: seat 0 left, seat 1 right, as the clerks sit
    const clerks = squares.map(p => onTile(p, a.desk.gridX, a.desk.gridY)).filter(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1).sort((p, q) => p[0] - q[0]);
    expect(clerks).toHaveLength(2);
    expect(clerks[0][0]).toBeLessThan(0.5);
    expect(clerks[1][0]).toBeGreaterThan(0.5);
    expect(clerks.every(([, y]) => y < 0.5)).toBe(true); // behind the counter, away from the front
    for (const m of ['f1', 'f1#1', 'f1#2', 'f1#3', 'c', 'q']) expect(pos(m)[0]).toBeLessThan(0.5);
    for (const m of ['f2', 'f2#1', 'f2#2', 'f2#3', 'y', 'z']) expect(pos(m)[0]).toBeGreaterThan(0.5);
  });

  it('a desk facing up, or sideways: its clerks and their lines on the same side', () => {
    // Facing up: the desk on the bottom row, the starter desk gone
    let s = { ...createStarterHotel(), cash: 1_000_000 };
    s = { ...s, fixtures: s.fixtures.filter(f => f.type !== 'desk') };
    s = addFixture(s, 'desk', 1, 5, 0)!;
    s = addRoom(s, 'standard', 3, 2, 0, 'up')!;
    s = at(s, { staff: { ...s.staff, frontDesk: 1 } });
    const [up] = lanesOf(s);
    expect(up.front.gridY).toBe(4); // in front of it, above
    const T = hourStart(s);
    let drawn = layer();
    drawn.actors.update({ ...s, guests: [arriving('g', up, T, T)] }, 0, T + 0.1);
    const g = drawnOn(drawn.actors, up.front)[0];
    const [gx, gy] = onTile([g.x, g.y], up.front.gridX, up.front.gridY);
    const [cx, cy] = onTile(drawn.squares.find(p => Math.floor(p[1] / TILE_SIZE) === 5)!, up.desk.gridX, up.desk.gridY);
    expect([gx < 0.5, cx < 0.5]).toEqual([true, true]); // seat 0, both on the left
    expect(gy).toBeGreaterThan(0.5); // at the counter, below them
    expect(cy).toBeGreaterThan(0.5); // the clerk behind it
    // Facing right: a desk between two rooms, with its own two clerks (the starter desk has the first two)
    let r = { ...createStarterHotel(), cash: 1_000_000 };
    r = addRoom(r, 'standard', 8, 3, 0, 'up')!;
    r = addRoom(r, 'standard', 8, 1, 0, 'up')!;
    r = addFixture(r, 'desk', 8, 2, 0)!;
    r = at(r, { staff: { ...r.staff, frontDesk: 4 } });
    const side = lanesOf(r).filter(l => l.desk.gridX === 8);
    expect(side.map(l => [l.front.gridX, l.front.gridY])).toEqual([[9, 2], [9, 2]]);
    drawn = layer();
    drawn.actors.update({ ...r, guests: [arriving('s0', side[0], T, T), arriving('s1', side[1], T, T)] }, 0, T + 0.1);
    const pos = (id: string) => { const d = drawnOn(drawn.actors, side[0].front).find(q => q.id === id)!; return onTile([d.x, d.y], 9, 2); };
    const clerks = drawn.squares.map(p => onTile(p, 8, 2)).filter(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1).sort((p, q) => p[1] - q[1]);
    expect(clerks).toHaveLength(2);
    expect([clerks[0][1] < 0.5, clerks[1][1] > 0.5]).toEqual([true, true]); // seat 0 above seat 1
    expect(clerks.every(([x]) => x < 0.5)).toBe(true); // behind the counter, away from the front
    expect([pos('s0')[1] < 0.5, pos('s1')[1] > 0.5]).toEqual([true, true]); // each in front of their own clerk
    expect([pos('s0')[0] < 0.5, pos('s1')[0] < 0.5]).toEqual([true, true]); // at the counter, on the desk's side
  });

  it('two desks facing each other across one spot: each line keeps to its own half', () => {
    let s = { ...createStarterHotel(), cash: 1_000_000 };
    s = addRoom(s, 'standard', 3, 2, 0, 'up')!;
    s = addFixture(s, 'desk', 1, 5, 0)!;
    s = at(s, { staff: { ...s.staff, frontDesk: 4 } });
    const lanes = lanesOf(s);
    expect(lanes.map(l => [l.front.gridX, l.front.gridY])).toEqual([[1, 4], [1, 4], [1, 4], [1, 4]]);
    const T = hourStart(s);
    const guests = lanes.flatMap((l, i) => [0, 1, 2, 3].map(k => arriving(`g${i}-${k}`, l, T + 0.01 * k, T + k * CHECK_IN_HOURS)));
    const { actors } = layer();
    actors.update({ ...s, guests }, 0, T + 0.1);
    const here = drawnOn(actors, { gridX: 1, gridY: 4 });
    expect(here).toHaveLength(guests.length);
    for (const d of here) {
      const lane = lanes[Number(d.id.slice(1, d.id.indexOf('-')))];
      const y = (d.y - GRID_OFFSET_Y) / TILE_SIZE - 4;
      expect(lane.desk.gridY < 4 ? y < 0.5 : y > 0.5).toBe(true); // the desk above: the top half; below: the bottom
    }
    expect(closest(here)).toBeGreaterThan(4);
  });

  it('two desks at right angles facing one spot: their lines keep apart', () => {
    let s = { ...createStarterHotel(), cash: 1_000_000 };
    s = addRoom(s, 'standard', 8, 3, 0, 'up')!;
    s = addRoom(s, 'standard', 8, 1, 0, 'up')!;
    s = addFixture(s, 'desk', 8, 2, 0)!;
    s = addFixture(s, 'desk', 9, 1, 0)!;
    s = at(s, { staff: { ...s.staff, frontDesk: 6 } });
    const lanes = lanesOf(s).filter(l => l.front.gridX === 9 && l.front.gridY === 2);
    expect(new Set(lanes.map(l => l.desk.id)).size).toBe(2);
    const T = hourStart(s);
    const guests = lanes.flatMap((l, i) => [0, 1, 2].map(k => arriving(`g${i}-${k}`, l, T + 0.01 * k, T + k * CHECK_IN_HOURS)));
    const { actors } = layer();
    actors.update({ ...s, guests }, 0, T + 0.1);
    const here = drawnOn(actors, { gridX: 9, gridY: 2 });
    expect(here).toHaveLength(guests.length);
    expect(closest(here)).toBeGreaterThan(4);
  });

  it('someone else on the desk’s spot (asking, turned away) stands clear of the lines', () => {
    let s = { ...createStarterHotel(), cash: 1_000_000 };
    s = addRoom(s, 'standard', 3, 2, 0, 'up')!;
    s = at(s, { staff: { ...s.staff, frontDesk: 2 } });
    const [a, b] = lanesOf(s);
    const T = hourStart(s);
    const asking: Walker = { id: 'ask', trait: 'normal', isReturning: false, reason: 'turned_away', trip: [makeStay(a.front, T, T + 0.5, 'inquire')] };
    const { actors } = layer();
    actors.update({ ...s, guests: [arriving('x', a, T, T), arriving('y', b, T, T)], walkers: [asking] }, 0, T + 0.1);
    const here = drawnOn(actors, a.front);
    const ask = here.find(d => d.id === 'ask')!;
    for (const d of here) if (d !== ask) expect(Math.hypot(d.x - ask.x, d.y - ask.y)).toBeGreaterThan(TILE_SIZE * 0.4);
  });
});

describe('A big spender\u2019s mark', () => {
  it('is a pale green "$" on the dark disc (six bars), not the moon\u2019s or the note\u2019s shapes', () => {
    const calls: Array<[string, ...number[]]> = [];
    const g: unknown = new Proxy({}, { get: (_t, name) => (...args: number[]) => { calls.push([String(name), ...args]); return g; } });
    const draw = (q: 'moon' | 'note' | 'coin') => { calls.length = 0; drawQuirk(g as never, 0, 0, q); return [...calls]; };
    const coin = draw('coin');
    expect(coin.filter(c => c[0] === 'fillStyle').map(c => c[1])).toContain(COIN_COLOR);
    expect(coin.filter(c => c[0] === 'fillRect')).toHaveLength(6);
    expect(coin.filter(c => c[0] === 'fillCircle')).toHaveLength(1); // just the disc
    expect(draw('note').filter(c => c[0] === 'fillStyle').map(c => c[1])).not.toContain(COIN_COLOR);
    expect(QUIRK_GLYPHS.coin).toBe('$');
  });
});
