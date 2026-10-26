import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom } from '../src/simulation/HotelState.js';
import { roomCleaningAt, summarizeCleaning, describeWait } from '../src/simulation/CleaningStatus.js';
import { getStaffPlan, planStaff } from '../src/simulation/StaffManager.js';
import { processCleaningTick } from '../src/simulation/HousekeepingManager.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { positionAt, hourStart, makeWalk } from '../src/simulation/Movement.js';
import { startTurnoverCleaning } from '../src/simulation/HousekeepingManager.js';
import { GridRenderer, CLEANING_COLORS, TILE_SIZE } from '../src/render/GridRenderer';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { PRNG } from '../src/simulation/prng.js';
import { HOUSEKEEPING, STAFF, TRAVEL } from '../src/config/balance.js';
import type { HotelState } from '../src/simulation/types.js';

/** A starter hotel at noon with `n` standard rooms on row 2, all waiting for a 2-hour turnover. */
function dirtyHotel(n: number, housekeepers: number, hour = 12): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000 };
  for (let x = 0; x < n; x++) s = addRoom(s, 'standard', x, 2)!;
  return {
    ...s, day: 4, hour,
    staff: { ...s.staff, housekeepers },
    rooms: s.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: HOUSEKEEPING.turnoverDuration.standard })),
  };
}

describe('Where each room\'s cleaning stands', () => {
  it('follows the housekeeper: on the way, then in the room with the work counting down', () => {
    const s = dirtyHotel(3, 1);
    const T = hourStart(s);
    const plan = getStaffPlan(s);
    const stay = plan.itineraries[0].legs.find(l => l.kind === 'stay' && l.job === 'turnover')!;
    expect(stay.kind === 'stay' && stay.placeId).toBeTruthy();
    const roomId = stay.kind === 'stay' ? stay.placeId! : '';

    const before = roomCleaningAt(s, T, plan).get(roomId)!;
    expect(before).toMatchObject({ job: 'turnover', phase: 'on_the_way', hoursLeft: 2, progress: 0, staffId: plan.itineraries[0].staffId });
    const mid = (stay.start + T + 1) / 2;
    const during = roomCleaningAt(s, mid, plan).get(roomId)!;
    expect(during.phase).toBe('cleaning');
    expect(during.hoursLeft).toBeCloseTo(2 - (mid - stay.start), 9);
    expect(during.progress).toBeCloseTo((mid - stay.start) / 2, 9);

    // The other rooms wait: the one housekeeper is busy
    const others = s.rooms.filter(r => r.id !== roomId).map(r => roomCleaningAt(s, mid, plan).get(r.id)!);
    expect(others.every(o => o.phase === 'waiting' && o.wait === 'busy' && o.progress === 0)).toBe(true);
  });

  it('ends the hour with exactly the work the tick leaves', () => {
    const s = dirtyHotel(3, 2);
    const plan = getStaffPlan(s);
    const atEnd = roomCleaningAt(s, hourStart(s) + 1, plan);
    const ticked = processCleaningTick({ ...s, staffPlan: plan }).state;
    for (const room of ticked.rooms) {
      if (room.status === 'cleaning') expect(atEnd.get(room.id)?.hoursLeft ?? 0).toBeCloseTo(room.cleaningHoursRemaining, 9);
      else expect(atEnd.has(room.id)).toBe(false);
    }
  });

  it('says why a room is waiting', () => {
    const at = (s: HotelState) => roomCleaningAt(s, hourStart(s) + 0.5).get(s.rooms[0].id)!;
    expect(at(dirtyHotel(1, 0))).toMatchObject({ phase: 'waiting', wait: 'no_housekeepers' });
    expect(at(dirtyHotel(1, 1, STAFF.housekeeping.workEndHour + 1))).toMatchObject({ phase: 'waiting', wait: 'off_shift' });
    // Hired this hour: nobody's on the roster until the next one
    expect(at({ ...dirtyHotel(1, 1), staffRoster: [] })).toMatchObject({ phase: 'waiting', wait: 'arriving' });
    // A room whose door opens onto the room next door
    const s = dirtyHotel(2, 1);
    const shut = { ...s, rooms: s.rooms.map((r, i) => (i === 0 ? { ...r, door: 'right' as const } : { ...r, status: 'vacant' as const, cleaningHoursRemaining: 0 })) };
    expect(at(shut)).toMatchObject({ phase: 'waiting', wait: 'unreachable' });
    expect(describeWait('off_shift')).toBe(`housekeepers start at ${STAFF.housekeeping.workStartHour}:00`);
  });

  it('progress is measured against the turnover itself: a quality change or a checkout delay doesn\'t move the bar', () => {
    // Checked out under "quick" with no front desk (2h longer), then switched to "standard"
    let s = dirtyHotel(2, 1);
    s = {
      ...s,
      housekeeping: { ...s.housekeeping, turnoverQuality: 'standard' },
      rooms: s.rooms.map(r => {
        const cleaned = startTurnoverCleaning({ ...r, status: 'occupied' }, 'quick');
        return { ...cleaned, cleaningHoursRemaining: cleaned.cleaningHoursRemaining + 2, cleaningHoursTotal: cleaned.cleaningHoursTotal! + 2 };
      }),
    };
    const prng = new PRNG(1);
    const last = new Map<string, number>();
    for (let h = 0; h < 6; h++) {
      const plan = getStaffPlan(s);
      for (const f of [0, 0.25, 0.5, 0.75, 0.999]) {
        for (const [roomId, c] of roomCleaningAt(s, hourStart(s) + f, plan)) {
          if (c.phase === 'waiting' && !last.has(roomId)) expect(c.progress).toBe(0); // nobody's touched it
          expect(c.progress, `${roomId} at hour ${h} + ${f}`).toBeGreaterThanOrEqual(last.get(roomId) ?? 0);
          expect(c.progress).toBeCloseTo(1 - c.hoursLeft / 3, 9);
          last.set(roomId, c.progress);
        }
      }
      s = tickSimulation(s, prng).state;
    }
    expect(last.size).toBe(2);
  });

  it('a housekeeper walking all hour to a room far upstairs is still on the way to it', () => {
    const s = dirtyHotel(1, 1);
    const room = s.rooms[0];
    const T = hourStart(s);
    // A walk that started half an hour ago and ends two hours from now, at the room
    const steps = Math.ceil(2.5 / TRAVEL.hoursPerTile);
    const path = Array.from({ length: steps }, (_, i) => ({ gridX: i % 2 === 0 ? 3 : 4, gridY: 1, floor: 0 }));
    path.push({ gridX: room.gridX, gridY: room.gridY, floor: 0 });
    const carry = makeWalk(path, T - 0.5, TRAVEL.hoursPerTile);
    expect(carry.end).toBeGreaterThan(T + 1);
    const plan = planStaff(s, [{ id: 'housekeeper-0', role: 'housekeeper', at: path[0], roomId: room.id, carry }]);
    expect(plan.itineraries[0].end.roomId).toBe(room.id); // still theirs next hour
    expect(roomCleaningAt(s, T + 0.5, plan).get(room.id)).toMatchObject({ phase: 'on_the_way', staffId: 'housekeeper-0' });
  });

  it('covers daily cleans of guests\' rooms too', () => {
    const s = dirtyHotel(2, 1);
    const daily = {
      ...s,
      rooms: s.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: `g-${r.id}`, cleaningHoursRemaining: 0, dailyCleanHoursRemaining: 0.5, cleanliness: 30 })),
    };
    const status = roomCleaningAt(daily, hourStart(daily) + 0.99);
    expect([...status.values()].every(v => v.job === 'daily')).toBe(true);
    const summary = summarizeCleaning(daily, hourStart(daily));
    expect(summary.daily.cleaning + summary.daily.due).toBe(2);
    expect(summary.grubby).toBe(2);
    expect(summary.turnovers).toEqual({ cleaning: 0, onTheWay: 0, waiting: 0 });
  });

  it('counts a daily clean as due until the housekeeper starts on it', () => {
    const s = dirtyHotel(2, 1);
    const daily = { ...s, rooms: s.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: `g-${r.id}`, cleaningHoursRemaining: 0, dailyCleanHoursRemaining: 0.4 })) };
    const T = hourStart(daily);
    expect([...roomCleaningAt(daily, T).values()].map(c => c.phase)).toContain('on_the_way');
    expect(summarizeCleaning(daily, T).daily).toEqual({ cleaning: 0, due: 2, guestIn: 0 });
  });

  it('counts the hotel by phase, reason and floor', () => {
    const s = dirtyHotel(4, 1);
    const summary = summarizeCleaning(s, hourStart(s));
    expect(summary.turnovers).toEqual({ cleaning: 0, onTheWay: 1, waiting: 3 });
    expect(summary.waits).toEqual({ busy: 3 });
    expect(summary.waitingByFloor.get(0)).toBe(3);
  });

  it('a plan made for another state isn\'t needed: it plans one', () => {
    const s = dirtyHotel(1, 1);
    expect(roomCleaningAt(s, hourStart(s) + 0.5)).toEqual(roomCleaningAt(s, hourStart(s) + 0.5, planStaff(s)));
  });
});

// The overlay draws what the simulation does. Through weeks of a running
// hotel, at moments all through each hour: a room shown being cleaned has its
// housekeeper standing in it, cleaning it; every housekeeper cleaning a room
// shows it as being cleaned; and the work a room is shown with at the end of
// the hour is what the tick leaves it with.
it('the cleaning overlay matches the housekeepers, hour after hour', () => {
  let checked = 0;
  let compared = 0;
  const progress = new Map<string, number>();
  for (const seed of [3, 4]) {
    let s: HotelState = createStarterHotel();
    for (let x = 0; x < 8; x++) s = addRoom(s, 'standard', x, 2) ?? s;
    const prng = new PRNG(seed);
    for (let h = 0; h < 24 * 30; h++) {
      s = settleChanges(s, STRATEGIES.balanced(s), hourStart(s));
      const T = hourStart(s);
      const plan = getStaffPlan(s);
      for (const f of [0, 0.13, 0.37, 0.5, 0.71, 0.94]) {
        const t = T + f;
        const status = roomCleaningAt(s, t, plan);
        for (const room of s.rooms) if (room.status !== 'cleaning') progress.delete(room.id);
        for (const [roomId, c] of status) {
          if (c.job === 'turnover') {
            expect(c.progress, `${roomId} progress went back`).toBeGreaterThanOrEqual((progress.get(roomId) ?? 0) - 1e-9);
            progress.set(roomId, c.progress);
          }
          if (c.phase !== 'cleaning') continue;
          const it = plan.itineraries.find(i => i.staffId === c.staffId)!;
          const leg = positionAt(it.legs, t)?.leg;
          expect(leg?.kind === 'stay' && leg.placeId === roomId && leg.job === c.job, `${roomId} at ${t}`).toBe(true);
          checked++;
        }
        for (const it of plan.itineraries) {
          if (!it.staffId.startsWith('housekeeper')) continue;
          const leg = positionAt(it.legs, t)?.leg;
          if (leg?.kind !== 'stay' || (leg.job !== 'turnover' && leg.job !== 'daily') || !leg.placeId) continue;
          const c = status.get(leg.placeId);
          // In the room cleaning it (unless its last minute's work is already done)
          if (c) expect(c).toMatchObject({ phase: 'cleaning', staffId: it.staffId, job: leg.job });
        }
      }
      const before = s;
      const atEnd = roomCleaningAt(before, T + 1, plan);
      s = tickSimulation(s, prng).state;
      for (const room of before.rooms) {
        if (room.status !== 'cleaning') continue;
        const after = s.rooms.find(r => r.id === room.id);
        if (!after) continue;
        if (after.status === 'cleaning') expect(atEnd.get(room.id)?.hoursLeft ?? 0).toBeCloseTo(after.cleaningHoursRemaining, 9);
        else expect(atEnd.has(room.id), `${room.id} shown dirty but cleaned`).toBe(false);
        compared++;
      }
    }
  }
  expect(checked).toBeGreaterThan(100);
  expect(compared).toBeGreaterThan(100);
}, 60000); // Sixty simulated days have exceeded the default five seconds on the CI runner.

describe('Drawing the overlay', () => {
  /** Run GridRenderer.renderCleaning against a recorder: every graphics call, in order. */
  function draw(state: HotelState, t: number, show = true) {
    const calls: Array<[string, ...unknown[]]> = [];
    const graphics = new Proxy({}, { get: (_, name) => (...args: unknown[]) => { calls.push([String(name), ...args]); } });
    const renderer = Object.create(GridRenderer.prototype);
    renderer.cleaningGraphics = graphics;
    renderer.planCache = new WeakMap();
    GridRenderer.prototype.renderCleaning.call(renderer, state, 0, t, show);
    return calls;
  }
  const fills = (calls: Array<[string, ...unknown[]]>) => calls.filter(c => c[0] === 'fillStyle').map(c => c[1]);

  it('draws nothing when it\'s off', () => {
    const s = dirtyHotel(2, 1);
    expect(draw(s, hourStart(s) + 0.5, false)).toEqual([['clear']]);
  });

  it('a turnover finished mid-hour is drawn clean, not grubby, until the tick reopens the room', () => {
    let s = dirtyHotel(1, 1);
    s = { ...s, rooms: s.rooms.map(r => ({ ...r, cleaningHoursRemaining: 0.1, cleanliness: 40 })) };
    const plan = getStaffPlan(s);
    const stay = plan.itineraries[0].legs.find(l => l.kind === 'stay' && l.job === 'turnover')!;
    expect(fills(draw({ ...s, staffPlan: plan }, (stay.start + stay.end) / 2))).toContain(CLEANING_COLORS.housekeeper);
    const after = draw({ ...s, staffPlan: plan }, stay.end + 0.01);
    expect(fills(after)).not.toContain(CLEANING_COLORS.grubby);
    expect(fills(after)).toEqual([]);
  });

  it('a guest\'s room under 50% clean is tinted grubby; one at 60% isn\'t', () => {
    const s = dirtyHotel(2, 1);
    const rooms = { ...s, rooms: s.rooms.map((r, i) => ({ ...r, status: 'occupied' as const, guestId: `g-${i}`, cleaningHoursRemaining: 0, cleanliness: i === 0 ? 40 : 60 })) };
    expect(fills(draw(rooms, hourStart(rooms) + 0.5)).filter(c => c === CLEANING_COLORS.grubby)).toHaveLength(1);
  });

  it('keeps a worn room\'s condition bar on top of the overlay', () => {
    let s = dirtyHotel(1, 1);
    s = { ...s, rooms: s.rooms.map(r => ({ ...r, condition: 20 })) };
    const calls = draw(s, hourStart(s));
    const room = s.rooms[0];
    const barY = room.gridY * TILE_SIZE + TILE_SIZE - 4;
    const bar = calls.findIndex(c => c[0] === 'fillRect' && c[2] === barY && c[4] === 2);
    expect(bar).toBeGreaterThan(-1);
    expect(calls.slice(bar + 1).some(c => c[0] === 'lineBetween' || c[0] === 'strokeRect')).toBe(false);
  });
});
