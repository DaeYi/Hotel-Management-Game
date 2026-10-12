import Phaser from 'phaser';
import type { HotelState, RoomType, FacilityType, GuestTrait, Direction, Room, StaffPlan } from '../simulation/types';
import { GRID, ECONOMY, NOISE, FACILITY_CONFIG, DECOR, GUEST_PROFILE } from '../config/balance';
import { calculateRoomNoise, nightRoomNoise } from '../simulation/NoiseManager';
import { formatRoomLabel, isRoomReachable, isFacilityOpen } from '../simulation/HotelState';
import { profileRoom, profileFurnishing, defaultFurnishing, rectToWorld, bedSpot, sleepSpots, wallBar, pillowRect } from '../simulation/RoomProfile';
import { FURNITURE, ROOM_CELLS, ROOM_PRESETS, type PresetId } from '../config/furniture';
import { isHallway } from '../simulation/Layout';
import { getStaffPlan } from '../simulation/StaffManager';
import { roomCleaningAt, GRUBBY_BELOW } from '../simulation/CleaningStatus';
import { getGuestDotColor, isChild } from './figures';
import { partyOf, sharesBeds } from '../simulation/Party';
import { isSleepHour, quirkOf } from '../simulation/Profile';
import { drawQuirk, drawSleepZ } from './quirks';

/** Guest dot color by trait (see figures.ts). */
export { getGuestDotColor };


export const TILE_SIZE = 52;

/** The cleaning overlay's colors (the interface's legend uses the same ones). */
export const CLEANING_COLORS = {
  housekeeper: 0x1abc9c, // the housekeepers' own color (ACTOR_COLORS.housekeeper): someone's on it
  dirty: 0x8b5a2b, // waiting for a turnover: can't be sold until it's cleaned
  hatch: 0x3e2412,
  blocked: 0xe74c3c, // waiting, and housekeepers can't get to it
  due: 0xf39c12, // a daily clean is due
  grubby: 0xa0522d, // getting dirty: under GRUBBY_BELOW it costs review points
  track: 0x15151f,
};
// The canvas is just the floor plan: the HTML interface lives around it.
export const GRID_OFFSET_X = 0;
export const GRID_OFFSET_Y = 0;
export const WORLD_WIDTH = GRID.width * TILE_SIZE;
export const WORLD_HEIGHT = GRID.height * TILE_SIZE;

const ROOM_COLORS: Record<RoomType, number> = {
  standard: 0x4a90d9,
  deluxe: 0x9b59b6,
  suite: 0xf1c40f,
};

const ELEVATOR_COLOR = 0x7f8c8d;
const HALLWAY_COLOR = 0x4b4b63;
const DESK_COLOR = 0xa0522d;
const CLOSET_COLOR = 0x16a085;
const BREAK_ROOM_COLOR = 0x8e44ad;
const ENTRANCE_COLOR = 0x27ae60;

const ROOM_OCCUPIED_COLORS: Record<RoomType, number> = {
  standard: 0x2e6da4,
  deluxe: 0x7d3c98,
  suite: 0xd4ac0d,
};

export class GridRenderer {
  private scene: Phaser.Scene;
  private gridGraphics: Phaser.GameObjects.Graphics;
  private roomGraphics: Phaser.GameObjects.Graphics;
  private guestGraphics: Phaser.GameObjects.Graphics;
  private sleepGraphics: Phaser.GameObjects.Graphics; // rooms whose guests are asleep, dimmed (under the overlays and the dots)
  private hoverGraphics: Phaser.GameObjects.Graphics;
  private feedbackGraphics: Phaser.GameObjects.Graphics;
  private noiseGraphics: Phaser.GameObjects.Graphics;
  private constructionGraphics: Phaser.GameObjects.Graphics;
  private cleaningGraphics: Phaser.GameObjects.Graphics;
  private planCache = new WeakMap<HotelState, StaffPlan>();
  private dayNightOverlay: Phaser.GameObjects.Rectangle;
  private feedbackTimer = 0;
  private showNoiseOverlay = false;
  // Pooled per-room number labels (design-review D9) -- reused across frames,
  // never recreated, since renderRooms() runs every frame.
  private roomLabels: Map<string, Phaser.GameObjects.Text> = new Map();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.gridGraphics = scene.add.graphics();
    this.roomGraphics = scene.add.graphics();
    this.guestGraphics = scene.add.graphics().setDepth(5);
    this.sleepGraphics = scene.add.graphics().setDepth(1);
    this.hoverGraphics = scene.add.graphics().setDepth(6);
    this.feedbackGraphics = scene.add.graphics().setDepth(7);
    this.noiseGraphics = scene.add.graphics().setDepth(3);
    this.cleaningGraphics = scene.add.graphics().setDepth(3); // over the rooms, under the people
    this.constructionGraphics = scene.add.graphics().setDepth(4);

    this.dayNightOverlay = scene.add.rectangle(
      GRID_OFFSET_X + (GRID.width * TILE_SIZE) / 2,
      GRID_OFFSET_Y + (GRID.height * TILE_SIZE) / 2,
      GRID.width * TILE_SIZE,
      GRID.height * TILE_SIZE,
      0x000033,
      0
    ).setDepth(10);

    this.drawGrid();
  }

  private drawGrid() {
    // Background
    const bg = this.scene.add.graphics();
    bg.fillStyle(0x0f3460, 0.3);
    bg.fillRect(GRID_OFFSET_X, GRID_OFFSET_Y, GRID.width * TILE_SIZE, GRID.height * TILE_SIZE);
    bg.setDepth(-1);

    // Grid lines
    this.gridGraphics.lineStyle(1, 0x2a2a4a, 0.5);
    for (let x = 0; x <= GRID.width; x++) {
      this.gridGraphics.lineBetween(
        GRID_OFFSET_X + x * TILE_SIZE, GRID_OFFSET_Y,
        GRID_OFFSET_X + x * TILE_SIZE, GRID_OFFSET_Y + GRID.height * TILE_SIZE
      );
    }
    for (let y = 0; y <= GRID.height; y++) {
      this.gridGraphics.lineBetween(
        GRID_OFFSET_X, GRID_OFFSET_Y + y * TILE_SIZE,
        GRID_OFFSET_X + GRID.width * TILE_SIZE, GRID_OFFSET_Y + y * TILE_SIZE
      );
    }
  }

  /** Convert pointer coords to grid coords. Returns null if out of bounds. */
  pointerToGrid(pointer: Phaser.Input.Pointer): { gridX: number; gridY: number } | null {
    const gridX = Math.floor((pointer.x - GRID_OFFSET_X) / TILE_SIZE);
    const gridY = Math.floor((pointer.y - GRID_OFFSET_Y) / TILE_SIZE);
    if (gridX < 0 || gridX >= GRID.width || gridY < 0 || gridY >= GRID.height) return null;
    return { gridX, gridY };
  }

  /** Show a ghost preview of where the tile will be placed (rooms: with their door, red if it opens onto no connected hallway) */
  showHoverPreview(gridX: number, gridY: number, type: string, canPlace: boolean, door?: Direction, doorOpen?: boolean) {
    this.hoverGraphics.clear();
    const x = GRID_OFFSET_X + gridX * TILE_SIZE;
    const y = GRID_OFFSET_Y + gridY * TILE_SIZE;

    // Get color: room types use ROOM_COLORS, facilities use FACILITY_CONFIG
    const color = ROOM_COLORS[type as RoomType]
      ?? (type in ROOM_PRESETS ? ROOM_COLORS[profileFurnishing(defaultFurnishing(type as PresetId)).type] : undefined)
      ?? FACILITY_CONFIG[type]?.color
      ?? (type === 'desk' ? DESK_COLOR : type === 'closet' ? CLOSET_COLOR : type === 'breakroom' ? BREAK_ROOM_COLOR : type === 'entrance' ? ENTRANCE_COLOR : type === 'bulldoze' ? 0xc0392b : ELEVATOR_COLOR);

    if (canPlace) {
      this.hoverGraphics.fillStyle(color, 0.4);
      this.hoverGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      this.hoverGraphics.lineStyle(2, color, 0.8);
      this.hoverGraphics.strokeRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      if (door) this.drawDoor(this.hoverGraphics, x, y, door, doorOpen ? 0xffffff : 0xe74c3c, 1);
    } else {
      // Red X for invalid placement
      this.hoverGraphics.fillStyle(0xe74c3c, 0.2);
      this.hoverGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      this.hoverGraphics.lineStyle(2, 0xe74c3c, 0.6);
      this.hoverGraphics.lineBetween(x + 6, y + 6, x + TILE_SIZE - 6, y + TILE_SIZE - 6);
      this.hoverGraphics.lineBetween(x + TILE_SIZE - 6, y + 6, x + 6, y + TILE_SIZE - 6);
    }
  }

  /** A room's furniture, as laid out in its furnishing and turned to face its door. */
  private drawFurniture(room: Room, x: number, y: number, alpha: number) {
    const g = this.roomGraphics;
    const cell = TILE_SIZE / ROOM_CELLS;
    for (const item of profileRoom(room).items) {
      const spec = FURNITURE[item.kind];
      if (item.wall) {
        // A thin piece on the wall it hangs on
        const edge = rectToWorld(room.door, wallBar(item));
        g.fillStyle(spec.color === 0x17202a ? 0xbdc3c7 : spec.color, alpha);
        g.fillRect(x + edge.x * cell, y + edge.y * cell, Math.max(2, edge.w * cell), Math.max(2, edge.h * cell));
        continue;
      }
      const r = rectToWorld(room.door, item);
      const px = x + r.x * cell + 1.5;
      const py = y + r.y * cell + 1.5;
      const pw = r.w * cell - 3;
      const ph = r.h * cell - 3;
      g.fillStyle(spec.color, alpha);
      g.fillRect(px, py, pw, ph);
      if (item.group === 'bed') {
        // Pillows at the head of the bed
        const head = rectToWorld(room.door, pillowRect(item));
        g.fillStyle(0xbfc9ca, alpha);
        g.fillRect(x + head.x * cell, y + head.y * cell, head.w * cell, head.h * cell);
        if (item.kind === 'bunk') {
          // The top bunk: a rail down the middle
          const mid = rectToWorld(room.door, { x: item.x, y: item.y + item.h / 2 - 0.05, w: item.w, h: 0.1 });
          g.fillStyle(0x7f8c8d, alpha);
          g.fillRect(x + mid.x * cell, y + mid.y * cell, Math.max(1, mid.w * cell), Math.max(1, mid.h * cell));
        }
      }
      g.lineStyle(1, item.tier === 2 ? 0xf1c40f : 0x34495e, alpha);
      g.strokeRect(px, py, pw, ph);
    }
  }

  /** The condition bar along the bottom of a room, once it's below 80%. */
  private drawConditionBar(g: Phaser.GameObjects.Graphics, room: Room, x: number, y: number) {
    if (room.condition >= 80) return;
    const barWidth = ((TILE_SIZE - 4) * room.condition) / 100;
    g.fillStyle(room.condition < 30 ? 0xe74c3c : 0xf39c12, 0.8);
    g.fillRect(x + 2, y + TILE_SIZE - 4, barWidth, 2);
  }

  /** A door: a gap-colored bar on the edge of the tile, on the side it opens. */
  private drawDoor(g: Phaser.GameObjects.Graphics, x: number, y: number, door: Direction, color: number, alpha: number) {
    const long = TILE_SIZE * 0.4;
    const thick = 4;
    const mid = (TILE_SIZE - long) / 2;
    g.fillStyle(color, alpha);
    if (door === 'up') g.fillRect(x + mid, y, long, thick);
    else if (door === 'down') g.fillRect(x + mid, y + TILE_SIZE - thick, long, thick);
    else if (door === 'left') g.fillRect(x, y + mid, thick, long);
    else g.fillRect(x + TILE_SIZE - thick, y + mid, thick, long);
  }

  clearHoverPreview() {
    this.hoverGraphics.clear();
  }

  /** Flash green on successful placement */
  showPlacementSuccess(gridX: number, gridY: number) {
    const x = GRID_OFFSET_X + gridX * TILE_SIZE;
    const y = GRID_OFFSET_Y + gridY * TILE_SIZE;
    this.feedbackGraphics.clear();
    this.feedbackGraphics.lineStyle(3, 0x2ecc71, 1);
    this.feedbackGraphics.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
    this.feedbackTimer = 300; // ms
  }

  /** Flash red on failed placement */
  showPlacementFailure(gridX: number, gridY: number) {
    const x = GRID_OFFSET_X + gridX * TILE_SIZE;
    const y = GRID_OFFSET_Y + gridY * TILE_SIZE;
    this.feedbackGraphics.clear();
    this.feedbackGraphics.lineStyle(3, 0xe74c3c, 1);
    this.feedbackGraphics.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
    this.feedbackTimer = 300;
  }

  /** Draw the rooms on one floor. Upper-floor rooms with no elevator to reach them are dimmed. */
  renderRooms(state: HotelState, floor: number) {
    this.roomGraphics.clear();
    const seenRoomIds = new Set<string>();

    for (const room of state.rooms) {
      if (room.floor !== floor) continue;
      const x = GRID_OFFSET_X + room.gridX * TILE_SIZE;
      const y = GRID_OFFSET_Y + room.gridY * TILE_SIZE;
      const color = room.status === 'occupied' ? ROOM_OCCUPIED_COLORS[room.type]
        : room.status === 'cleaning' ? 0x888888
        : room.status === 'renovating' ? 0xd35400
        : ROOM_COLORS[room.type];
      const usable = room.condition > ECONOMY.roomBreakdownThreshold && isRoomReachable(state, room);

      // The floor, tinted by what kind of room it is and what's happening in it; then the furniture
      this.roomGraphics.fillStyle(color, usable ? 0.55 : 0.25);
      this.roomGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      this.drawFurniture(room, x, y, usable ? 0.95 : 0.4);
      // The door: hallway-colored where it opens onto a connected hallway, red where it's blocked
      this.drawDoor(this.roomGraphics, x, y, room.door, isRoomReachable(state, room) ? 0xd8d8e8 : 0xe74c3c, 0.95);

      // Brown strip along the top once decor goes stale (renovate to clear it)
      if (room.decor < DECOR.freshThreshold && room.status !== 'renovating') {
        this.roomGraphics.fillStyle(0x8e6e53, 0.9);
        this.roomGraphics.fillRect(x + 2, y + 2, TILE_SIZE - 4, 2);
      }

      this.drawConditionBar(this.roomGraphics, room, x, y);

      seenRoomIds.add(room.id);
      let label = this.roomLabels.get(room.id);
      if (!label) {
        label = this.scene.add.text(0, 0, '', {
          fontSize: '10px', fontFamily: 'monospace', color: '#ffffff',
        }).setAlpha(0.6).setDepth(2);
        this.roomLabels.set(room.id, label);
      }
      label.setText(formatRoomLabel(room.gridX, room.gridY, room.floor));
      label.setPosition(x + 4, y + 4);
    }

    // A demolished room's label (or one on another floor) is removed rather than left dangling.
    for (const [roomId, label] of this.roomLabels) {
      if (!seenRoomIds.has(roomId)) {
        label.destroy();
        this.roomLabels.delete(roomId);
      }
    }
  }

  /** Draw one floor's open hallway (every free tile), check-in desks, closets, and break rooms. Shares the rooms' graphics layer. */
  renderFixtures(state: HotelState, floor: number) {
    // Carpet on every tile nothing has been built on
    for (let gy = 0; gy < GRID.height; gy++) {
      for (let gx = 0; gx < GRID.width; gx++) {
        if (!isHallway(state, gx, gy, floor) || state.elevators.some(e => e.gridX === gx && e.gridY === gy)) continue;
        const x = GRID_OFFSET_X + gx * TILE_SIZE;
        const y = GRID_OFFSET_Y + gy * TILE_SIZE;
        this.roomGraphics.fillStyle(HALLWAY_COLOR, 1);
        this.roomGraphics.fillRect(x, y, TILE_SIZE, TILE_SIZE);
        this.roomGraphics.fillStyle(0x6b6b85, 0.6);
        this.roomGraphics.fillRect(x + TILE_SIZE / 2 - 1, y + TILE_SIZE / 2 - 1, 2, 2);
      }
    }
    for (const fixture of state.fixtures) {
      if (fixture.floor !== floor) continue;
      const x = GRID_OFFSET_X + fixture.gridX * TILE_SIZE;
      const y = GRID_OFFSET_Y + fixture.gridY * TILE_SIZE;
      if (fixture.type === 'entrance') {
        // Street entrance: a doormat with an arrow pointing in from the street side
        const cx = x + TILE_SIZE / 2;
        const cy = y + TILE_SIZE / 2;
        this.roomGraphics.fillStyle(ENTRANCE_COLOR, 0.85);
        this.roomGraphics.fillRect(x + 6, y + 6, TILE_SIZE - 12, TILE_SIZE - 12);
        this.roomGraphics.fillStyle(0xffffff, 0.9);
        const s = 9;
        if (fixture.gridX === 0) this.roomGraphics.fillTriangle(cx + s, cy, cx - s, cy - s, cx - s, cy + s);
        else if (fixture.gridX === GRID.width - 1) this.roomGraphics.fillTriangle(cx - s, cy, cx + s, cy - s, cx + s, cy + s);
        else if (fixture.gridY === 0) this.roomGraphics.fillTriangle(cx, cy + s, cx - s, cy - s, cx + s, cy - s);
        else this.roomGraphics.fillTriangle(cx, cy - s, cx - s, cy + s, cx + s, cy + s);
      } else if (fixture.type === 'closet') {
        // Staff closet: a door with shelves behind it
        this.roomGraphics.fillStyle(CLOSET_COLOR, 0.85);
        this.roomGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        this.roomGraphics.fillStyle(0xffffff, 0.6);
        for (let shelf = 0; shelf < 3; shelf++) {
          this.roomGraphics.fillRect(x + 10, y + 12 + shelf * 10, TILE_SIZE - 20, 3);
        }
      } else if (fixture.type === 'breakroom') {
        // Break room: a table with a coffee cup; resting staff sit around it
        this.roomGraphics.fillStyle(BREAK_ROOM_COLOR, 0.85);
        this.roomGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        this.roomGraphics.fillStyle(0xd2a679, 0.9);
        this.roomGraphics.fillCircle(x + TILE_SIZE / 2, y + TILE_SIZE / 2, TILE_SIZE * 0.16);
        this.roomGraphics.fillStyle(0xffffff, 0.9);
        this.roomGraphics.fillRect(x + TILE_SIZE / 2 - 2, y + TILE_SIZE / 2 - 3, 4, 5);
      } else {
        // Floor tile with a wooden counter across the top half
        this.roomGraphics.fillStyle(HALLWAY_COLOR, 1);
        this.roomGraphics.fillRect(x, y, TILE_SIZE, TILE_SIZE);
        this.roomGraphics.fillStyle(DESK_COLOR, 1);
        this.roomGraphics.fillRect(x + 4, y + TILE_SIZE * 0.45, TILE_SIZE - 8, TILE_SIZE * 0.25);
        this.roomGraphics.fillStyle(0xd2a679, 1);
        this.roomGraphics.fillRect(x + 4, y + TILE_SIZE * 0.45, TILE_SIZE - 8, 3);
      }
    }
  }

  /** Draw one floor's facilities, plus every elevator shaft (they run through all floors). */
  renderFacilities(state: HotelState, floor: number) {
    for (const elevator of state.elevators) {
      const x = GRID_OFFSET_X + elevator.gridX * TILE_SIZE;
      const y = GRID_OFFSET_Y + elevator.gridY * TILE_SIZE;
      const cx = x + TILE_SIZE / 2;
      const cy = y + TILE_SIZE / 2;
      this.roomGraphics.fillStyle(ELEVATOR_COLOR, 0.9);
      this.roomGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      // Up/down arrows
      this.roomGraphics.fillStyle(0xffffff, 0.8);
      this.roomGraphics.fillTriangle(cx - 8, cy - 4, cx + 8, cy - 4, cx, cy - 14);
      this.roomGraphics.fillTriangle(cx - 8, cy + 4, cx + 8, cy + 4, cx, cy + 14);
    }

    // Facilities are drawn on the same graphics layer as rooms
    for (const facility of state.facilities) {
      if (facility.floor !== floor) continue;
      const x = GRID_OFFSET_X + facility.gridX * TILE_SIZE;
      const y = GRID_OFFSET_Y + facility.gridY * TILE_SIZE;
      const fConfig = FACILITY_CONFIG[facility.type];
      if (!fConfig) continue;

      // Fill with facility color (dimmed when guests can't get in), and its door
      const open = isFacilityOpen(state, facility);
      this.roomGraphics.fillStyle(fConfig.color, open ? 0.85 : 0.3);
      this.roomGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      this.drawDoor(this.roomGraphics, x, y, facility.door, open ? 0xd8d8e8 : 0xe74c3c, 0.95);

      // Small centered icon per facility type (graphics, not text objects)
      this.roomGraphics.fillStyle(0xffffff, 0.7);
      // Simple centered dot pattern for identification
      const cx = x + TILE_SIZE / 2;
      const cy = y + TILE_SIZE / 2;
      switch (facility.type) {
        case 'gym':
          // Dumbbell shape: two circles connected
          this.roomGraphics.fillCircle(cx - 12, cy, 8);
          this.roomGraphics.fillCircle(cx + 12, cy, 8);
          this.roomGraphics.fillRect(cx - 12, cy - 3, 24, 6);
          break;
        case 'restaurant':
          // Fork/plate: circle with lines
          this.roomGraphics.fillCircle(cx, cy, 14);
          this.roomGraphics.fillStyle(fConfig.color, 1);
          this.roomGraphics.fillCircle(cx, cy, 10);
          break;
        case 'pool':
          // Wave lines
          this.roomGraphics.fillStyle(0xffffff, 0.7);
          this.roomGraphics.fillRect(cx - 16, cy - 4, 32, 4);
          this.roomGraphics.fillRect(cx - 12, cy + 4, 24, 4);
          break;
        case 'shop':
          // Shopping bag shape
          this.roomGraphics.fillRect(cx - 10, cy - 6, 20, 16);
          this.roomGraphics.fillStyle(fConfig.color, 1);
          this.roomGraphics.fillRect(cx - 6, cy - 2, 12, 8);
          break;
      }
    }
  }

  /** Guest dots in their rooms. `walking` guests are drawn by the ActorLayer instead until they arrive. */
  /** Draw a dot in each guest's room while they're in it (not while they're on their way in, out at a facility, or moving rooms). */
  renderGuests(state: HotelState, floor: number, away: Set<string> = new Set(), selectedGuestId: string | null = null) {
    this.guestGraphics.clear();
    this.sleepGraphics.clear();

    for (const guest of state.guests) {
      if (away.has(guest.id)) continue;
      const room = state.rooms.find(r => r.guestId === guest.id);
      if (!room || room.floor !== floor) continue;

      // In bed: one person in the middle of it, a party one to a sleeping spot
      const party = partyOf(guest);
      const spots = party.size > 1 ? sleepSpots(room, !sharesBeds(party)) : [];
      const dotColor = getGuestDotColor(guest.purpose);
      // Asleep (in their sleep hours, and in): the room dims, and a "z" by them
      const asleep = GUEST_PROFILE.enabled && room.status === 'occupied' && isSleepHour(guest, state.hour);
      if (asleep) {
        this.sleepGraphics.fillStyle(0x0b1030, 0.35);
        this.sleepGraphics.fillRect(GRID_OFFSET_X + room.gridX * TILE_SIZE + 1, GRID_OFFSET_Y + room.gridY * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      }
      const quirk = GUEST_PROFILE.enabled ? quirkOf(guest) : null;
      for (let m = 0; m < party.size; m++) {
        const [bx, by] = spots[m] ?? bedSpot(room);
        const x = GRID_OFFSET_X + room.gridX * TILE_SIZE + bx * (TILE_SIZE / ROOM_CELLS);
        const y = GRID_OFFSET_Y + room.gridY * TILE_SIZE + by * (TILE_SIZE / ROOM_CELLS);
        // Outlined, so a guest in a white bed still shows
        const r = isChild(party, m) ? 4 : party.size > 1 ? 5 : 6;
        this.guestGraphics.fillStyle(dotColor, 0.95);
        this.guestGraphics.fillCircle(x, y, r);
        this.guestGraphics.lineStyle(1.5, 0x1b1b2b, 0.9);
        this.guestGraphics.strokeCircle(x, y, r);

        // Return-guest marker (design-review D7/D10): a thin ring around the
        // first member's trait-color dot, visible on the grid during actual play.
        if (m === 0 && guest.isReturning) {
          this.guestGraphics.lineStyle(1.5, 0xffffff, 0.9);
          this.guestGraphics.strokeCircle(x, y, 9);
        }
        if (guest.id === selectedGuestId) {
          this.guestGraphics.lineStyle(2, 0xf1c40f, 1);
          this.guestGraphics.strokeCircle(x, y, r + 5);
        }
        if (m === 0) {
          // Kept inside the room's tile
          const left = GRID_OFFSET_X + room.gridX * TILE_SIZE;
          const top = GRID_OFFSET_Y + room.gridY * TILE_SIZE;
          const clampX = (v: number) => Math.min(left + TILE_SIZE - 6, Math.max(left + 6, v));
          const clampY = (v: number) => Math.min(top + TILE_SIZE - 6, Math.max(top + 6, v));
          if (quirk) drawQuirk(this.guestGraphics, clampX(x + 8), clampY(y - 9), quirk);
          if (asleep) drawSleepZ(this.guestGraphics, clampX(x - 13), clampY(y - 14));
        }
      }
    }
  }

  updateDayNight(hour: number) {
    let darkness = 0;
    if (hour >= 22 || hour < 6) {
      darkness = 0.25;
    } else if (hour >= 20) {
      darkness = (hour - 20) * 0.125;
    } else if (hour < 8) {
      darkness = (8 - hour) * 0.125;
    }
    this.dayNightOverlay.setAlpha(darkness);
  }

  updateFeedback(delta: number) {
    if (this.feedbackTimer > 0) {
      this.feedbackTimer -= delta;
      if (this.feedbackTimer <= 0) {
        this.feedbackGraphics.clear();
      }
    }
  }

  setNoiseOverlay(on: boolean) {
    if (on === this.showNoiseOverlay) return;
    this.showNoiseOverlay = on;
    if (!on) this.noiseGraphics.clear();
  }

  /** Render noise levels as a color overlay on one floor's rooms (with guest profiles on: the noise at night, which is the noise that matters) */
  renderNoise(state: HotelState, floor: number) {
    this.noiseGraphics.clear();
    if (!this.showNoiseOverlay) return;

    for (const room of state.rooms) {
      if (room.floor !== floor) continue;
      const noise = GUEST_PROFILE.enabled ? nightRoomNoise(room, state) : calculateRoomNoise(room, state);
      if (noise <= 0) continue;

      const x = GRID_OFFSET_X + room.gridX * TILE_SIZE;
      const y = GRID_OFFSET_Y + room.gridY * TILE_SIZE;

      // Map noise to alpha: 0 = invisible, 2+ = strong red
      const intensity = Math.min(1, noise / 2.5);
      if (intensity > 0.05) {
        this.noiseGraphics.fillStyle(0xff4444, intensity * 0.4);
        this.noiseGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      }
    }
  }

  /**
   * The cleaning overlay on one floor's rooms at game time t: rooms waiting
   * for a turnover are hatched brown (red-edged if housekeepers can't get to
   * them); a housekeeper in the room tints it teal, with a teal frame, and one
   * on the way marks its corners; a bar shows how far the clean has got. Rooms
   * with a daily clean due get an amber dot, and rooms grubby enough to cost
   * review points (in use, or ready to sell) a brown tint.
   */
  renderCleaning(state: HotelState, floor: number, t: number, show: boolean) {
    const g = this.cleaningGraphics;
    g.clear();
    if (!show) return;
    let plan = this.planCache.get(state);
    if (!plan) {
      plan = getStaffPlan(state);
      this.planCache.set(state, plan);
    }
    const status = roomCleaningAt(state, t, plan);
    const S = TILE_SIZE;
    const C = CLEANING_COLORS;

    for (const room of state.rooms) {
      if (room.floor !== floor || room.status === 'renovating') continue;
      const x = GRID_OFFSET_X + room.gridX * S;
      const y = GRID_OFFSET_Y + room.gridY * S;
      const job = status.get(room.id);

      // A room in use (or ready to sell) grubby enough to cost review points. One
      // between guests is dirty until its turnover's done (and clean once it is).
      if ((room.status === 'occupied' || room.status === 'vacant') && room.cleanliness < GRUBBY_BELOW) {
        g.fillStyle(C.grubby, 0.45);
        g.fillRect(x + 1, y + 1, S - 2, S - 2);
      }
      if (!job) continue;

      if (job.phase === 'cleaning') {
        g.fillStyle(C.housekeeper, 0.3);
        g.fillRect(x + 1, y + 1, S - 2, S - 2);
      } else if (job.job === 'turnover') {
        g.fillStyle(C.dirty, 0.5);
        g.fillRect(x + 1, y + 1, S - 2, S - 2);
        this.hatch(g, x, y, job.wait === 'unreachable' ? C.blocked : C.hatch);
      }

      if (job.phase === 'cleaning') {
        g.lineStyle(2, C.housekeeper, 1);
        g.strokeRect(x + 2, y + 2, S - 4, S - 4);
      } else if (job.phase === 'on_the_way') {
        this.corners(g, x, y, C.housekeeper);
      } else if (job.wait === 'unreachable') {
        g.lineStyle(2, C.blocked, 0.9);
        g.strokeRect(x + 2, y + 2, S - 4, S - 4);
      }

      if (job.job === 'daily' && job.phase !== 'cleaning') {
        g.fillStyle(C.due, 1);
        g.fillCircle(x + S - 9, y + 9, 5);
        g.lineStyle(1.5, C.track, 1);
        g.strokeCircle(x + S - 9, y + 9, 5);
      }

      // How far the clean has got (a turnover always; a daily clean once it's begun)
      if (job.job === 'turnover' || job.phase === 'cleaning') {
        g.fillStyle(C.track, 0.85);
        g.fillRect(x + 5, y + S - 10, S - 10, 4);
        g.fillStyle(C.housekeeper, 1);
        g.fillRect(x + 5, y + S - 10, (S - 10) * job.progress, 4);
      }
      // The frame and corners run over the bottom edge: keep the condition bar on top
      this.drawConditionBar(g, room, x, y);
    }
  }

  /** Diagonal hatching across a tile. */
  private hatch(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number) {
    const S = TILE_SIZE;
    g.lineStyle(1.5, color, 0.7);
    for (let d = -S + 6; d < S; d += 9) {
      // The line x' - y' = d inside the tile
      g.lineBetween(x + Math.max(0, d), y + Math.max(0, -d), x + Math.min(S, S + d), y + Math.min(S, S - d));
    }
  }

  /** Corner brackets around a tile: someone's on their way to it. */
  private corners(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number) {
    const S = TILE_SIZE;
    const a = 3;
    const len = 11;
    g.lineStyle(2.5, color, 1);
    for (const [cx, cy, dx, dy] of [[x + a, y + a, 1, 1], [x + S - a, y + a, -1, 1], [x + a, y + S - a, 1, -1], [x + S - a, y + S - a, -1, -1]]) {
      g.lineBetween(cx, cy, cx + dx * len, cy);
      g.lineBetween(cx, cy, cx, cy + dy * len);
    }
  }

  /** Render construction zones with animated stripes */
  renderConstruction(state: HotelState, floor: number) {
    this.constructionGraphics.clear();

    for (const ns of state.noiseSources) {
      if (ns.floor !== floor) continue;
      const x = GRID_OFFSET_X + ns.gridX * TILE_SIZE;
      const y = GRID_OFFSET_Y + ns.gridY * TILE_SIZE;

      // Yellow pulsing outline for active construction
      const pulse = 0.4 + Math.sin(Date.now() / 300) * 0.2;
      this.constructionGraphics.lineStyle(2, 0xf39c12, pulse);
      this.constructionGraphics.strokeRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);

      // Small construction icon (hammer)
      this.constructionGraphics.fillStyle(0xf39c12, 0.8);
      this.constructionGraphics.fillTriangle(
        x + TILE_SIZE - 14, y + 4,
        x + TILE_SIZE - 4, y + 4,
        x + TILE_SIZE - 9, y + 14
      );
    }
  }
}
