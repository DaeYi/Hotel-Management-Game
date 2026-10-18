import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameController, TICK_INTERVAL_MS } from '../src/game/GameController.js';
import { ROOM_CONFIG, ECONOMY } from '../src/config/balance.js';
import { loadGame } from '../src/simulation/SaveManager.js';

/** A controller on a fresh game with the tutorial already dismissed. */
function freshController(): GameController {
  localStorage.clear();
  localStorage.setItem('hotel-game-tutorial-seen', '1');
  return new GameController();
}

describe('GameController: setup', () => {
  beforeEach(() => localStorage.clear());

  it('starts a new game with the free lobby, and shows the tutorial the first time', () => {
    const c = new GameController();
    expect(c.state.fixtures.some(f => f.type === 'desk')).toBe(true);
    expect(c.tutorialOpen).toBe(true);
    expect(c.running).toBe(false);
    c.finishTutorial();
    expect(c.tutorialOpen).toBe(false);
    expect(c.running).toBe(true);
    expect(new GameController().tutorialOpen).toBe(false); // remembered
  });
});

describe('GameController: the clock', () => {
  it('runs one simulation tick per interval, scaled by speed', () => {
    const c = freshController();
    c.update(TICK_INTERVAL_MS - 1);
    expect(c.state.hour).toBe(0);
    c.update(1);
    expect(c.state.hour).toBe(1);
    c.setSpeed(5);
    c.update(TICK_INTERVAL_MS);
    expect(c.state.hour).toBe(6);
  });

  it('does not tick while paused or while a dialog is open', () => {
    const c = freshController();
    c.togglePause();
    c.update(TICK_INTERVAL_MS * 3);
    expect(c.state.hour).toBe(0);
    c.togglePause();
    c.requestNewGame();
    c.update(TICK_INTERVAL_MS * 3);
    expect(c.state.hour).toBe(0);
    c.cancelNewGame();
    c.update(TICK_INTERVAL_MS);
    expect(c.state.hour).toBe(1);
  });

  it('notifies listeners once per update when something changed, and reports tick events', () => {
    const c = freshController();
    let notified = 0;
    let ticks = 0;
    c.subscribe(() => notified++);
    c.onTick(() => ticks++);
    c.update(0); // initial change (construction)
    c.update(0); // nothing new
    expect(notified).toBe(1);
    c.update(TICK_INTERVAL_MS * 2);
    expect(ticks).toBe(2);
    expect(notified).toBe(2);
  });

  it('saves at each day rollover', () => {
    const c = freshController();
    c.setSpeed(5);
    c.update(TICK_INTERVAL_MS * 24 / 5); // 24 hours at 5x
    expect(c.state.day).toBe(2);
    expect(loadGame()?.state.day).toBe(2);
  });
});

describe('GameController: building', () => {
  it('paused building and management changes survive an immediate reload', () => {
    const c = freshController();
    c.togglePause();
    c.selectTool('standard');
    c.tileDown({ gridX: 5, gridY: 2 });
    c.setRoomPrice(c.state.rooms[0].id, 95);
    c.setHousekeeping('thorough', 'every_other_day');
    const loaded = new GameController();
    expect(loaded.state).toEqual(c.state);
    expect(loaded.state.rooms[0].pricePerNight).toBe(95);
    expect(loaded.paused).toBe(true);
  });

  it('a mid-hour save resumes the same clock, plans and random stream', () => {
    const c = freshController();
    c.selectTool('standard');
    c.tileDown({ gridX: 5, gridY: 2 });
    c.update(0.6 * TICK_INTERVAL_MS);
    c.setRoomPrice(c.state.rooms[0].id, 90); // saves the edit at its actual time
    const loaded = new GameController();
    expect(loaded.gameTime).toBeCloseTo(c.gameTime, 12);
    expect(loaded.state.staffPlan).toEqual(c.state.staffPlan);
    c.update(0.4 * TICK_INTERVAL_MS);
    loaded.update(0.4 * TICK_INTERVAL_MS);
    expect(loaded.state).toEqual(c.state);
    expect(loadGame()?.prngState).toBeDefined();
  });

  it('uses the supplied storage, exposes save failure, and can retry', () => {
    const items = new Map<string, string>([['hotel-game-tutorial-seen', '1']]);
    let blocked = true;
    const storage: Storage = {
      get length() { return items.size; }, key: i => [...items.keys()][i] ?? null,
      getItem: key => items.get(key) ?? null, clear: () => items.clear(), removeItem: key => { items.delete(key); },
      setItem: (key, value) => { if (blocked) throw new Error('full'); items.set(key, value); },
    };
    const c = new GameController(storage);
    c.selectTool('standard'); c.tileDown({ gridX: 5, gridY: 2 });
    expect(c.saveError).toBe(true);
    blocked = false;
    expect(c.saveNow()).toBe(true);
    expect(c.saveError).toBe(false);
    expect(new GameController(storage).state.rooms).toEqual(c.state.rooms);
  });

  it('page exit cannot recreate the discarded save when starting over', () => {
    const c = freshController(); c.togglePause();
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    try {
      c.startNewGame(); c.saveNow();
      expect(loadGame()).toBeNull();
      expect(reload).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it('builds with the selected tool on a clicked tile, and flags the result for the renderer', () => {
    const c = freshController();
    c.selectTool('standard');
    c.tileDown({ gridX: 5, gridY: 2 });
    expect(c.state.rooms).toHaveLength(1);
    expect(c.state.cash).toBe(ECONOMY.startingCash - ROOM_CONFIG.standard.buildCost);
    expect(c.feedback).toMatchObject({ gridX: 5, gridY: 2, ok: true });

    c.tileDown({ gridX: 5, gridY: 2 }); // occupied now
    expect(c.feedback).toMatchObject({ ok: false });
  });

  it('previews whether the hovered tile can take the selected tool', () => {
    const c = freshController();
    c.selectTool('standard');
    c.tileMove({ gridX: 5, gridY: 2 }, false);
    expect(c.hover).toEqual({ gridX: 5, gridY: 2, canPlace: true, door: 'down', doorOpen: true });
    c.tileMove({ gridX: 1, gridY: 3 }, false); // the lobby desk
    expect(c.hover?.canPlace).toBe(false);
    c.tileMove({ gridX: 5, gridY: 5 }, false); // bottom row: a door facing down opens onto the outside wall
    expect(c.hover).toMatchObject({ canPlace: true, doorOpen: false });
    c.tileMove(null, false);
    expect(c.hover).toBeNull();
  });

  it('new rooms get the chosen door; R turns it, and the inspector turns an existing door', () => {
    const c = freshController();
    c.selectTool('standard');
    c.rotateDoor(); // down -> left
    c.tileDown({ gridX: 5, gridY: 2 });
    expect(c.state.rooms[0].door).toBe('left');
    c.selectTool(null);
    c.turnRoomDoor(c.state.rooms[0].id);
    expect(c.state.rooms[0].door).toBe('up');
  });

  it('facilities get the chosen door too, and turn from their inspector', () => {
    const c = freshController();
    c.state = { ...c.state, cash: 1_000_000, peakStarRating: 5 };
    c.selectTool('gym');
    c.tileMove({ gridX: 5, gridY: 2 }, false);
    expect(c.hover).toMatchObject({ door: 'down', doorOpen: true });
    c.tileDown({ gridX: 5, gridY: 2 });
    expect(c.state.facilities[0].door).toBe('down');
    c.selectTool(null);
    c.turnFacilityDoor(c.state.facilities[0].id);
    expect(c.state.facilities[0].door).toBe('left');
  });

  it('drag-bulldozes desks and the like back to hallway, and leaves rooms to their inspector', () => {
    const c = freshController();
    c.selectTool('standard');
    c.tileDown({ gridX: 5, gridY: 2 });
    c.selectTool('closet');
    c.tileDown({ gridX: 6, gridY: 4 });
    c.selectTool('bulldoze');
    c.tileDown({ gridX: 4, gridY: 4 });
    c.tileMove({ gridX: 7, gridY: 4 }, true);
    c.pointerUp();
    expect(c.state.fixtures.some(f => f.type === 'closet')).toBe(false);
    c.tileDown({ gridX: 5, gridY: 2 });
    expect(c.state.rooms).toHaveLength(1);
  });

  it('selects rooms when no tool is active, and the inspector actions act on them', () => {
    const c = freshController();
    c.selectTool('standard');
    c.tileDown({ gridX: 5, gridY: 2 });
    c.selectTool(null);
    c.tileDown({ gridX: 5, gridY: 2 });
    expect(c.selection).toEqual({ kind: 'room', id: c.state.rooms[0].id });

    c.setRoomPrice(c.state.rooms[0].id, 120);
    expect(c.state.rooms[0].pricePerNight).toBe(120);
    c.demolishRoom(c.state.rooms[0].id);
    expect(c.state.rooms).toHaveLength(0);
    expect(c.selection).toBeNull();
  });
});

describe('GameController: floors and panels', () => {
  it('builds a floor and switches to it; floor changes clear the selection', () => {
    const c = freshController();
    c.buildFloor();
    expect(c.state.floorCount).toBe(2);
    expect(c.currentFloor).toBe(1);
    c.setFloor(5);
    expect(c.currentFloor).toBe(1); // clamped
    c.setFloor(0);
    expect(c.currentFloor).toBe(0);
  });

  it('opens one panel at a time; toggling the open one closes it', () => {
    const c = freshController();
    c.togglePanel('staff');
    expect(c.openPanel).toBe('staff');
    c.togglePanel('goals');
    expect(c.openPanel).toBe('goals');
    c.togglePanel('goals');
    expect(c.openPanel).toBeNull();
  });

  it('management actions update the state', () => {
    const c = freshController();
    c.setStaff({ ...c.state.staff, housekeepers: 4 });
    c.setHousekeeping('thorough', 'every_other_day');
    c.setAmenity('standard', 'premium');
    expect(c.state.staff.housekeepers).toBe(4);
    expect(c.state.housekeeping).toEqual({ turnoverQuality: 'thorough', dailyCadence: 'every_other_day' });
    expect(c.state.amenities.standard).toBe('premium');
    c.repayLoan(5000);
    expect(c.state.loan.balance).toBe(45000);
  });
});

describe('GameController: people keep up with changes mid-hour', () => {
  it('building across a housekeeper\'s path mid-hour re-plans them around it, keeping what they did', async () => {
    const { getStaffPlan, plannedWork } = await import('../src/simulation/StaffManager.js');
    const { positionAt } = await import('../src/simulation/Movement.js');
    const { startTurnoverCleaning } = await import('../src/simulation/HousekeepingManager.js');
    const c = freshController();
    c.state = { ...c.state, cash: 1_000_000, hour: 12 };
    c.selectTool('standard');
    c.doorDirection = 'up';
    c.tileDown({ gridX: 8, gridY: 2 });
    c.selectTool(null);
    c.state = { ...c.state, rooms: c.state.rooms.map(r => startTurnoverCleaning(r, 'standard')), staffRoster: undefined, staffPlan: null };
    c.state = { ...c.state, staffPlan: getStaffPlan(c.state) };
    c.update(TICK_INTERVAL_MS * 0.05); // a little into the hour: the housekeeper is on the way
    const t = c.gameTime;
    const before = c.state.staffPlan!.itineraries[0];
    const walk = before.legs.find(l => l.kind === 'walk')!;
    expect(walk.start).toBeLessThan(t);
    expect(walk.end).toBeGreaterThan(t);
    const ahead = (walk as any).path[(walk as any).path.length - 3];
    c.selectTool('standard');
    c.doorDirection = 'down';
    c.tileDown({ gridX: ahead.gridX, gridY: ahead.gridY }); // a room right in their way
    const after = c.state.staffPlan!.itineraries[0];
    expect(after).not.toEqual(before);
    for (let i = 1; i < after.legs.length; i++) expect(after.legs[i].start).toBeCloseTo(after.legs[i - 1].end, 9);
    for (const leg of after.legs) if (leg.kind === 'walk' && leg.end > t) {
      expect(leg.path.some(p => p.gridX === ahead.gridX && p.gridY === ahead.gridY && !p.door)).toBe(false);
    }
    const a = positionAt(before.legs, t - 0.01)!, b = positionAt(after.legs, t - 0.01)!;
    expect([b.x, b.y]).toEqual([a.x, a.y]); // what already happened stays happened
    expect(plannedWork(c.state.staffPlan!, 'turnover').size).toBeGreaterThan(0); // still gets there
  });

  it('renovating a room mid-repair frees the maintenance worker (no repairing a room under renovation)', async () => {
    const { getStaffPlan } = await import('../src/simulation/StaffManager.js');
    const c = freshController();
    c.state = { ...c.state, cash: 1_000_000, hour: 12, staff: { ...c.state.staff, maintenanceWorkers: 1 } };
    c.selectTool('standard');
    c.doorDirection = 'up';
    c.tileDown({ gridX: 3, gridY: 2 });
    c.selectTool(null);
    c.state = { ...c.state, rooms: c.state.rooms.map(r => ({ ...r, condition: 40, decor: 50 })), staffRoster: undefined, staffPlan: null };
    c.state = { ...c.state, staffPlan: getStaffPlan(c.state) };
    const room = c.state.rooms[0];
    const repairing = () => c.state.staffPlan!.itineraries.flatMap(it => it.legs).some(l => l.kind === 'stay' && l.job === 'repair' && l.placeId === room.id && l.end > c.gameTime);
    c.update(TICK_INTERVAL_MS * 0.4);
    expect(repairing()).toBe(true);
    c.renovateRoom(room.id);
    expect(c.state.rooms[0].status).toBe('renovating');
    expect(repairing()).toBe(false);
  });

  it('loading an older save puts the staff at work and plans their hour', () => {
    localStorage.clear();
    localStorage.setItem('hotel-game-tutorial-seen', '1');
    const c0 = new GameController();
    const state: any = { ...c0.state, hour: 12, staff: { ...c0.state.staff, housekeepers: 2, maintenanceWorkers: 1 } };
    delete state.staffRoster;
    delete state.staffPlan;
    delete state.walkers;
    localStorage.setItem('hotel-game-save', JSON.stringify({ version: 17, prngState: 1, state }));
    const c = new GameController();
    expect(c.state.staffRoster!.map(m => m.role).sort()).toEqual(['housekeeper', 'housekeeper', 'maintenance']);
    expect(c.state.staffRoster!.every(m => m.at !== null)).toBe(true); // on shift at noon
    expect(c.state.staffPlan).not.toBeNull();
    localStorage.clear();
  });
});
