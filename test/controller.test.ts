import { describe, it, expect, beforeEach } from 'vitest';
import { GameController, TICK_INTERVAL_MS } from '../src/game/GameController.js';
import { HALLWAY, ROOM_CONFIG, ECONOMY } from '../src/config/balance.js';
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
    expect(c.hover).toEqual({ gridX: 5, gridY: 2, canPlace: true });
    c.tileMove({ gridX: 5, gridY: 1 }, false); // the lobby hallway
    expect(c.hover?.canPlace).toBe(false);
    c.tileMove(null, false);
    expect(c.hover).toBeNull();
  });

  it('drag-paints hallways across every tile, even when the pointer skips some', () => {
    const c = freshController();
    c.selectTool('hallway');
    c.tileDown({ gridX: 0, gridY: 3 });
    c.tileMove({ gridX: 6, gridY: 3 }, true); // one big jump
    c.pointerUp();
    // (9, 3) is the starter layout's hallway spine; everything from 0 to 6 is new
    const row3 = c.state.fixtures.filter(f => f.type === 'hallway' && f.gridY === 3 && f.gridX <= 6);
    expect(row3.map(f => f.gridX).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(c.state.cash).toBe(ECONOMY.startingCash - 7 * HALLWAY.buildCost);
  });

  it('bulldozes hallways but leaves rooms to their inspector', () => {
    const c = freshController();
    c.selectTool('standard');
    c.tileDown({ gridX: 5, gridY: 2 });
    c.selectTool('bulldoze');
    c.tileDown({ gridX: 5, gridY: 1 });
    expect(c.state.fixtures.some(f => f.gridX === 5 && f.gridY === 1)).toBe(false);
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
