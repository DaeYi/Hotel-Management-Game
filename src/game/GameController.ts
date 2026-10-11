import type {
  HotelState, RoomType, FacilityType, TileType, StaffConfig, AmenityTier, CleaningQuality, DailyCleaningCadence, GameEvent,
} from '../simulation/types';
import {
  createStarterHotel, addFixture, demolishFixture, demolishElevator, addRoom, setRoomPrice, repairRoom, demolishRoom,
  addFacility, demolishFacility, renovateRoom, renovateFacility, upgradeFacility, addElevator, buildFloor,
} from '../simulation/HotelState';
import { startCampaign } from '../simulation/MarketingManager';
import { tickSimulation } from '../simulation/tick';
import { checkBankruptcy, repayLoan } from '../simulation/EconomyManager';
import { PRNG } from '../simulation/prng';
import { saveGame, loadGame, deleteSave } from '../simulation/SaveManager';
import { ROOM_CONFIG, FACILITY_CONFIG } from '../config/balance';
import { ToastQueue } from './ToastQueue';

// The game, independent of how it's drawn: state, the clock, and every player
// action. The renderer (Phaser today, 3D later) and the HTML interface both
// read from it and call into it; neither owns any game logic.

/** Anything the build panel can place (a room, facility, hallway, desk, closet, or elevator shaft), or the bulldoze tool. */
export type BuildType = TileType | 'elevator' | 'hallway' | 'desk' | 'closet' | 'bulldoze';

/** Tools that place on (or clear) one tile per click and can be dragged across tiles. */
export const PAINTABLE_TYPES = new Set<BuildType>(['hallway', 'bulldoze']);

export type PanelId = 'staff' | 'housekeeping' | 'amenities' | 'marketing' | 'finance' | 'story' | 'goals';

export type Selection = { kind: 'room' | 'facility'; id: string } | null;

export interface Tile {
  gridX: number;
  gridY: number;
}

/** A placement attempt, for the renderer's success/failure flash. */
export interface PlacementFeedback extends Tile {
  ok: boolean;
  id: number;
}

export const TICK_INTERVAL_MS = 2000; // one game hour at 1x
const MAX_FRAME_MS = 250; // longest real-time step one frame may advance
const TUTORIAL_SEEN_KEY = 'hotel-game-tutorial-seen';

export class GameController {
  state: HotelState;
  private prng: PRNG;

  // Clock
  paused = false;
  speed = 1;
  private tickAccumulator = 0;

  // Interface state
  currentFloor = 0;
  tool: BuildType | null = null;
  selection: Selection = null;
  openPanel: PanelId | null = null;
  noiseOverlay = false;
  tutorialOpen: boolean;
  confirmingNewGame = false;
  gameOver = false;
  hover: (Tile & { canPlace: boolean }) | null = null;
  feedback: PlacementFeedback | null = null;
  readonly toasts = new ToastQueue();

  private lastPainted: Tile | null = null;
  private listeners = new Set<() => void>();
  private tickListeners = new Set<(events: GameEvent[], state: HotelState) => void>();
  private dirty = true;
  private version = 0;

  constructor(private storage: Storage = localStorage) {
    const save = loadGame();
    if (save) {
      this.state = save.state;
      this.prng = PRNG.fromState(save.prngState);
    } else {
      this.prng = new PRNG(Date.now());
      this.state = createStarterHotel(); // free lobby: hallways and a check-in desk
    }
    this.tutorialOpen = !save && !this.storage.getItem(TUTORIAL_SEEN_KEY);
  }

  // === Subscriptions ===

  /** Called (at most once per frame) whenever anything visible changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called after every simulation tick with that tick's events and the new state. */
  onTick(listener: (events: GameEvent[], state: HotelState) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /** Increments on every change, so views can tell when to re-render. */
  getVersion(): number {
    return this.version;
  }

  private changed() {
    this.dirty = true;
  }

  /** How far through the current game hour the clock is (0-1), for animating within the hour. */
  get hourProgress(): number {
    return Math.min(1, this.tickAccumulator / TICK_INTERVAL_MS);
  }

  /** Whether the clock is actually running (not paused, and no dialog in the way). */
  get running(): boolean {
    return !this.paused && !this.tutorialOpen && !this.confirmingNewGame && !this.gameOver;
  }

  // === The loop ===

  /** Advance real time: run due simulation ticks, age toasts, and notify listeners. */
  update(deltaMs: number, now = performance.now()) {
    if (this.running) {
      this.tickAccumulator += deltaMs * this.speed;
      while (this.tickAccumulator >= TICK_INTERVAL_MS && !this.gameOver) {
        this.tickAccumulator -= TICK_INTERVAL_MS;
        this.doTick(now);
      }
    }
    if (this.toasts.update(now)) this.changed();

    if (this.dirty) {
      this.dirty = false;
      this.version++;
      for (const listener of this.listeners) listener();
    }
  }

  /**
   * Drive update() from requestAnimationFrame. Each frame's time step is
   * capped, so returning to a backgrounded tab (where frames pause) resumes
   * the game rather than fast-forwarding through the time away.
   */
  start() {
    let last = performance.now();
    const frame = (now: number) => {
      this.update(Math.min(now - last, MAX_FRAME_MS), now);
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private doTick(now: number) {
    const prevDay = this.state.day;
    const { state, events } = tickSimulation(this.state, this.prng);
    this.state = state;
    this.toasts.add(events, now, this.openPanel === 'story');
    for (const listener of this.tickListeners) listener(events, state);

    if (state.day !== prevDay) saveGame(state, this.prng);
    if (checkBankruptcy(state)) this.gameOver = true;
    this.changed();
  }

  // === Clock controls ===

  setSpeed(speed: number) {
    this.speed = speed;
    this.paused = false;
    this.changed();
  }

  togglePause() {
    this.paused = !this.paused;
    this.changed();
  }

  // === Panels and overlays ===

  togglePanel(panel: PanelId) {
    this.openPanel = this.openPanel === panel ? null : panel;
    this.changed();
  }

  closePanel() {
    this.openPanel = null;
    this.changed();
  }

  toggleNoiseOverlay() {
    this.noiseOverlay = !this.noiseOverlay;
    this.changed();
  }

  finishTutorial() {
    this.tutorialOpen = false;
    this.storage.setItem(TUTORIAL_SEEN_KEY, '1');
    this.paused = false;
    this.speed = 1;
    this.changed();
  }

  requestNewGame() {
    this.confirmingNewGame = true;
    this.changed();
  }

  cancelNewGame() {
    this.confirmingNewGame = false;
    this.changed();
  }

  /** Wipe the save and start over (the page reloads into a fresh game). */
  startNewGame() {
    deleteSave();
    this.storage.removeItem(TUTORIAL_SEEN_KEY);
    window.location.reload();
  }

  // === Floors ===

  setFloor(floor: number) {
    const next = Math.max(0, Math.min(this.state.floorCount - 1, floor));
    if (next === this.currentFloor) return;
    this.currentFloor = next;
    this.selection = null;
    this.hover = null;
    this.changed();
  }

  buildFloor() {
    const result = buildFloor(this.state);
    if (!result) return;
    this.state = result.state;
    this.toasts.add(result.events, performance.now());
    this.setFloor(this.state.floorCount - 1);
    this.changed();
  }

  // === Building on the grid ===

  selectTool(tool: BuildType | null) {
    this.tool = this.tool === tool ? null : tool;
    if (this.tool) this.selection = null;
    this.hover = null;
    this.changed();
  }

  /** The state after building `type` at a tile on the current floor, or null if not allowed (also the hover check). */
  tryBuild(type: BuildType, gridX: number, gridY: number): HotelState | null {
    if (type === 'bulldoze') return this.bulldoze(gridX, gridY);
    if (type === 'hallway' || type === 'desk' || type === 'closet') return addFixture(this.state, type, gridX, gridY, this.currentFloor);
    if (type === 'elevator') return addElevator(this.state, gridX, gridY);
    if (type in ROOM_CONFIG) return addRoom(this.state, type as RoomType, gridX, gridY, this.currentFloor);
    if (type in FACILITY_CONFIG) return addFacility(this.state, type as FacilityType, gridX, gridY, this.currentFloor);
    return null;
  }

  /** Remove a hallway, desk, staff closet, or elevator shaft. Rooms and facilities are demolished from their inspectors. */
  private bulldoze(gridX: number, gridY: number): HotelState | null {
    const fixture = this.state.fixtures.find(f => f.floor === this.currentFloor && f.gridX === gridX && f.gridY === gridY);
    if (fixture) return demolishFixture(this.state, fixture.id);
    const elevator = this.state.elevators.find(e => e.gridX === gridX && e.gridY === gridY);
    if (elevator) return demolishElevator(this.state, elevator.id);
    return null;
  }

  /** Pointer pressed on a tile: build with the selected tool, or select what's there. */
  tileDown(tile: Tile) {
    if (this.tutorialOpen) return;
    if (this.tool) {
      this.lastPainted = tile;
      const result = this.tryBuild(this.tool, tile.gridX, tile.gridY);
      if (result) this.state = result;
      this.feedback = { ...tile, ok: result !== null, id: (this.feedback?.id ?? 0) + 1 };
      this.refreshHover(tile);
      this.changed();
      return;
    }

    const room = this.state.rooms.find(r => r.floor === this.currentFloor && r.gridX === tile.gridX && r.gridY === tile.gridY);
    const facility = this.state.facilities.find(f => f.floor === this.currentFloor && f.gridX === tile.gridX && f.gridY === tile.gridY);
    this.selection = room ? { kind: 'room', id: room.id } : facility ? { kind: 'facility', id: facility.id } : null;
    this.changed();
  }

  /**
   * Pointer moved over the grid (tile null = off the grid). Updates the
   * placement preview, and while the button is down, drag-paints hallways
   * or bulldozes -- filling every tile between pointer events, since a fast
   * drag skips tiles.
   */
  tileMove(tile: Tile | null, pointerDown: boolean) {
    const before = this.state;
    this.refreshHover(tile);
    if (pointerDown && tile && this.tool && PAINTABLE_TYPES.has(this.tool)) {
      const last = this.lastPainted;
      if (!last || last.gridX !== tile.gridX || last.gridY !== tile.gridY) {
        const from = last ?? tile;
        const steps = Math.max(Math.abs(tile.gridX - from.gridX), Math.abs(tile.gridY - from.gridY));
        for (let i = 1; i <= Math.max(1, steps); i++) {
          const t = steps === 0 ? 1 : i / steps;
          const result = this.tryBuild(this.tool,
            Math.round(from.gridX + (tile.gridX - from.gridX) * t),
            Math.round(from.gridY + (tile.gridY - from.gridY) * t));
          if (result) this.state = result;
        }
        this.lastPainted = tile;
        this.refreshHover(tile);
      }
    }
    // The renderer reads the hover preview every frame; only painting needs the UI to update
    if (this.state !== before) this.changed();
  }

  pointerUp() {
    this.lastPainted = null;
  }

  private refreshHover(tile: Tile | null) {
    this.hover = this.tool && tile ? { ...tile, canPlace: this.tryBuild(this.tool, tile.gridX, tile.gridY) !== null } : null;
  }

  clearSelection() {
    this.selection = null;
    this.changed();
  }

  // === Player actions ===

  /** Apply an action that returns null when it isn't allowed (can't afford, wrong state). */
  private apply(result: HotelState | null): boolean {
    if (!result) return false;
    this.state = result;
    this.changed();
    return true;
  }

  setStaff(staff: StaffConfig) {
    this.apply({ ...this.state, staff });
  }

  setHousekeeping(turnoverQuality: CleaningQuality, dailyCadence: DailyCleaningCadence) {
    this.apply({ ...this.state, housekeeping: { turnoverQuality, dailyCadence } });
  }

  setAmenity(type: RoomType, tier: AmenityTier) {
    this.apply({ ...this.state, amenities: { ...this.state.amenities, [type]: tier } });
  }

  startCampaign(campaignId: string) {
    this.apply(startCampaign(this.state, campaignId));
  }

  repayLoan(amount: number) {
    this.apply(repayLoan(this.state, amount));
  }

  setRoomPrice(roomId: string, price: number) {
    this.apply(setRoomPrice(this.state, roomId, price));
  }

  repairRoom(roomId: string) {
    this.apply(repairRoom(this.state, roomId));
  }

  renovateRoom(roomId: string) {
    this.apply(renovateRoom(this.state, roomId));
  }

  demolishRoom(roomId: string) {
    if (this.apply(demolishRoom(this.state, roomId))) this.clearSelection();
  }

  upgradeFacility(facilityId: string) {
    this.apply(upgradeFacility(this.state, facilityId));
  }

  renovateFacility(facilityId: string) {
    this.apply(renovateFacility(this.state, facilityId));
  }

  demolishFacility(facilityId: string) {
    if (this.apply(demolishFacility(this.state, facilityId))) this.clearSelection();
  }
}
