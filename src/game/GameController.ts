import type {
  HotelState, RoomType, FacilityType, TileType, StaffConfig, AmenityTier, CleaningQuality, DailyCleaningCadence, GameEvent, FixtureType, Direction, Furnishing, LateCheckoutPolicy,
} from '../simulation/types';
import {
  createStarterHotel, addFixture, demolishFixture, demolishElevator, addRoom, setRoomPrice, repairRoom, demolishRoom,
  addFacility, demolishFacility, renovateRoom, renovateFacility, upgradeFacility, addElevator, buildFloor, setRoomDoor, setFacilityDoor,
  refitRoom, refitAllLike, cancelPendingRefit,
} from '../simulation/HotelState';
import { rotateDirection, doorTile, isReachableHallway } from '../simulation/Layout';
import { getRoster, getStaffPlan } from '../simulation/StaffManager';
import { settleChanges } from '../simulation/Settle';
import { furnishingOf } from '../simulation/RoomProfile';
import { hourStart } from '../simulation/Movement';
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

/** Anything the build panel can place (a room, facility, street entrance, desk, closet, break room, or elevator shaft), or the bulldoze tool. */
/** Rooms built from a preset rather than one of the original types. */
export const PRESET_TOOLS = ['twin', 'bunk_family', 'deluxe_twin', 'deluxe_family'] as const;
export type PresetTool = typeof PRESET_TOOLS[number];
export type BuildType = TileType | PresetTool | 'elevator' | FixtureType | 'bulldoze';

/** Whether a build tool builds a room (an original type or a preset). */
export function isRoomTool(tool: BuildType): tool is RoomType | PresetTool {
  return tool in ROOM_CONFIG || (PRESET_TOOLS as readonly string[]).includes(tool);
}

/** Tools that place on (or clear) one tile per click and can be dragged across tiles. */
export const PAINTABLE_TYPES = new Set<BuildType>(['bulldoze']);

export type PanelId = 'staff' | 'housekeeping' | 'amenities' | 'marketing' | 'finance' | 'story' | 'goals' | 'furnish';

/** What the inspector shows: a room or facility, or a guest (anchored where they were picked, so the card doesn't chase them). */
export type Selection = { kind: 'room' | 'facility'; id: string } | { kind: 'guest'; id: string; anchor: Tile } | null;

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
  /** The room the furnishing panel is open for. */
  furnishRoomId: string | null = null;
  /** The open panel is folded down to its title bar, so the floor plan under it shows. */
  panelCollapsed = false;
  noiseOverlay = false;
  tutorialOpen: boolean;
  confirmingNewGame = false;
  gameOver = false;
  /** Which side new rooms and facilities get their door on (R rotates it). */
  doorDirection: Direction = 'down';
  /** The placement preview: for rooms and facilities, also where the door goes and whether it opens onto a connected hallway. */
  hover: (Tile & { canPlace: boolean; door?: Direction; doorOpen?: boolean }) | null = null;
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
      this.state = withPlans(save.state);
      this.prng = PRNG.fromState(save.prngState);
    } else {
      this.prng = new PRNG(Date.now());
      this.state = withPlans(createStarterHotel()); // all hallway, a free street entrance and a check-in desk beside it
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

  /** The current game time in absolute hours ((day - 1) * 24 + hour + progress): where everyone's itinerary is drawn at. */
  get gameTime(): number {
    return hourStart(this.state) + this.hourProgress;
  }

  /**
   * After the player changes something mid-hour, the people it affects carry
   * on from where they are: staff re-plan when the building or their work
   * changes (a room built across a hallway, a room renovated mid-repair), and
   * guests find new ways when the building or the front desk changes. So
   * nobody walks through a new wall, keeps cleaning a room that's gone, or
   * checks in at a desk nobody's sitting at.
   */
  private settle(before: HotelState) {
    this.state = settleChanges(before, this.state, this.gameTime);
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
    this.toasts.add(events, now, this.storyLogVisible);
    for (const listener of this.tickListeners) listener(events, state);

    if (state.day !== prevDay) saveGame(state, this.prng);
    if (checkBankruptcy(state)) this.gameOver = true;
    // A guest's card closes once they've gone (checked out and walked out of the building)
    if (this.selection?.kind === 'guest') {
      const id = this.selection.id;
      if (!state.guests.some(g => g.id === id) && !(state.walkers ?? []).some(w => w.guestId === id)) this.selection = null;
    }
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
    if (this.openPanel !== 'furnish') this.furnishRoomId = null;
    this.panelCollapsed = false;
    this.changed();
  }

  /** Fold the open panel down to its title bar (or open it back up). */
  toggleCollapsed() {
    if (!this.openPanel) return;
    this.panelCollapsed = !this.panelCollapsed;
    this.changed();
  }

  /** The story log is open and unfolded: incidents show there, so they don't toast. */
  get storyLogVisible(): boolean {
    return this.openPanel === 'story' && !this.panelCollapsed;
  }

  /** The cleaning overlay is on the floor plan while the housekeeping panel is open. */
  get cleaningOverlay(): boolean {
    return this.openPanel === 'housekeeping';
  }

  closePanel() {
    this.openPanel = null;
    this.furnishRoomId = null;
    this.panelCollapsed = false;
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
    if (this.selection?.kind !== 'guest') this.selection = null; // a guest's card follows them up and down
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
    if (type === 'entrance' || type === 'desk' || type === 'closet' || type === 'breakroom') return addFixture(this.state, type, gridX, gridY, this.currentFloor);
    if (type === 'elevator') return addElevator(this.state, gridX, gridY);
    if (isRoomTool(type)) return addRoom(this.state, type, gridX, gridY, this.currentFloor, this.doorDirection);
    if (type in FACILITY_CONFIG) return addFacility(this.state, type as FacilityType, gridX, gridY, this.currentFloor, this.doorDirection);
    return null;
  }

  /** Remove a street entrance, desk, staff closet, break room, or elevator shaft (the tile goes back to hallway). Rooms and facilities are demolished from their inspectors. */
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
      const before = this.state;
      const result = this.tryBuild(this.tool, tile.gridX, tile.gridY);
      if (result) {
        this.state = result;
        this.settle(before);
      }
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
   * placement preview, and while the button is down, drag-bulldozes --
   * filling every tile between pointer events, since a fast drag skips tiles.
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
        this.settle(before);
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
    if (!this.tool || !tile) {
      this.hover = null;
      return;
    }
    this.hover = { ...tile, canPlace: this.tryBuild(this.tool, tile.gridX, tile.gridY) !== null };
    if (isRoomTool(this.tool) || this.tool in FACILITY_CONFIG) {
      const door = this.doorDirection;
      this.hover.door = door;
      this.hover.doorOpen = isReachableHallway(this.state, doorTile({ ...tile, floor: this.currentFloor }, door));
    }
  }

  /** Turn the door of the next room or facility to be built a quarter turn clockwise. */
  rotateDoor() {
    this.doorDirection = rotateDirection(this.doorDirection);
    if (this.hover) this.refreshHover(this.hover);
    this.changed();
  }

  /** Turn an existing room's door a quarter turn clockwise (free). */
  turnRoomDoor(roomId: string) {
    const room = this.state.rooms.find(r => r.id === roomId);
    if (room) this.apply(setRoomDoor(this.state, roomId, rotateDirection(room.door)));
  }

  /** Turn an existing facility's door a quarter turn clockwise (free). */
  turnFacilityDoor(facilityId: string) {
    const facility = this.state.facilities.find(f => f.id === facilityId);
    if (facility) this.apply(setFacilityDoor(this.state, facilityId, rotateDirection(facility.door)));
  }

  clearSelection() {
    this.selection = null;
    this.changed();
  }

  /** Show a guest's card (picked on the floor plan, or from a room's or facility's card), anchored at a tile. */
  selectGuest(guestId: string, anchor: Tile) {
    if (this.tutorialOpen || this.tool) return;
    if (!this.state.guests.some(g => g.id === guestId) && !(this.state.walkers ?? []).some(w => w.guestId === guestId)) return;
    this.selection = { kind: 'guest', id: guestId, anchor: { gridX: anchor.gridX, gridY: anchor.gridY } };
    this.changed();
  }

  /** Whether night owls may stay till the late checkout: no, yes, or yes for a fee. */
  setLateCheckout(policy: LateCheckoutPolicy) {
    this.apply({ ...this.state, lateCheckout: policy });
  }

  // === Player actions ===

  /** Apply an action that returns null when it isn't allowed (can't afford, wrong state). */
  private apply(result: HotelState | null): boolean {
    if (!result) return false;
    const before = this.state;
    this.state = result;
    this.settle(before);
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
    if (!this.apply(demolishRoom(this.state, roomId))) return;
    // A rebuilt room on the tile gets the same id: don't reopen its furnishing
    if (this.furnishRoomId === roomId) this.closePanel();
    this.clearSelection();
  }

  /** Open the furnishing panel for a room (it replaces the room's inspector card). */
  openFurnishing(roomId: string) {
    this.furnishRoomId = roomId;
    this.openPanel = 'furnish';
    this.panelCollapsed = false;
    this.selection = null;
    this.changed();
  }

  /** Refit a room with new furniture or layout: now (it closes for the fitting) or after its guest leaves. */
  refitRoom(roomId: string, furnishing: Furnishing, when: 'now' | 'checkout'): boolean {
    return this.apply(refitRoom(this.state, roomId, furnishing, when));
  }

  /** Furnish every other room laid out like this room is now the same way (empty ones now, the rest after checkout). */
  refitAllLike(roomId: string, furnishing: Furnishing): boolean {
    const room = this.state.rooms.find(r => r.id === roomId);
    if (!room) return false;
    return this.apply(refitAllLike(this.state, furnishing, furnishingOf(room).preset, roomId));
  }

  cancelRefit(roomId: string) {
    this.apply(cancelPendingRefit(this.state, roomId));
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

/** A state with its staff roster and this hour's plan in place (new games and loaded saves). */
function withPlans(state: HotelState): HotelState {
  const staffRoster = getRoster(state);
  return { ...state, staffRoster, staffPlan: getStaffPlan({ ...state, staffRoster }), walkers: state.walkers ?? [] };
}
