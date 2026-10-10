import Phaser from 'phaser';
import type { HotelState, RoomType, FacilityType, GuestTrait } from '../simulation/types';
import { GRID, ECONOMY, NOISE, FACILITY_CONFIG, DECOR } from '../config/balance';
import { calculateRoomNoise } from '../simulation/NoiseManager';
import { formatRoomLabel, isRoomReachable } from '../simulation/HotelState';

/** Guest dot color by trait, in one place so every trait gets an explicit,
 * distinct color instead of silently falling through to the default. */
export function getGuestDotColor(trait: GuestTrait): number {
  switch (trait) {
    case 'light_sleeper': return 0x3498db;
    case 'big_spender': return 0xe74c3c;
    case 'party_guest': return 0xe91e63;
    case 'normal': return 0xecf0f1;
  }
}

export const TILE_SIZE = 52;
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
  private hoverGraphics: Phaser.GameObjects.Graphics;
  private feedbackGraphics: Phaser.GameObjects.Graphics;
  private noiseGraphics: Phaser.GameObjects.Graphics;
  private constructionGraphics: Phaser.GameObjects.Graphics;
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
    this.hoverGraphics = scene.add.graphics().setDepth(6);
    this.feedbackGraphics = scene.add.graphics().setDepth(7);
    this.noiseGraphics = scene.add.graphics().setDepth(3);
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

  /** Show a ghost preview of where the tile will be placed */
  showHoverPreview(gridX: number, gridY: number, type: string, canPlace: boolean) {
    this.hoverGraphics.clear();
    const x = GRID_OFFSET_X + gridX * TILE_SIZE;
    const y = GRID_OFFSET_Y + gridY * TILE_SIZE;

    // Get color: room types use ROOM_COLORS, facilities use FACILITY_CONFIG
    const color = ROOM_COLORS[type as RoomType]
      ?? FACILITY_CONFIG[type]?.color
      ?? (type === 'hallway' ? HALLWAY_COLOR : type === 'desk' ? DESK_COLOR : type === 'closet' ? CLOSET_COLOR : type === 'bulldoze' ? 0xc0392b : ELEVATOR_COLOR);

    if (canPlace) {
      this.hoverGraphics.fillStyle(color, 0.4);
      this.hoverGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      this.hoverGraphics.lineStyle(2, color, 0.8);
      this.hoverGraphics.strokeRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    } else {
      // Red X for invalid placement
      this.hoverGraphics.fillStyle(0xe74c3c, 0.2);
      this.hoverGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      this.hoverGraphics.lineStyle(2, 0xe74c3c, 0.6);
      this.hoverGraphics.lineBetween(x + 6, y + 6, x + TILE_SIZE - 6, y + TILE_SIZE - 6);
      this.hoverGraphics.lineBetween(x + TILE_SIZE - 6, y + 6, x + 6, y + TILE_SIZE - 6);
    }
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
      const alpha = room.condition <= ECONOMY.roomBreakdownThreshold || !isRoomReachable(state, room) ? 0.3 : 0.85;

      this.roomGraphics.fillStyle(color, alpha);
      this.roomGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);

      // Brown strip along the top once decor goes stale (renovate to clear it)
      if (room.decor < DECOR.freshThreshold && room.status !== 'renovating') {
        this.roomGraphics.fillStyle(0x8e6e53, 0.9);
        this.roomGraphics.fillRect(x + 2, y + 2, TILE_SIZE - 4, 2);
      }

      // Condition bar at bottom when below 80%
      if (room.condition < 80) {
        const barWidth = ((TILE_SIZE - 4) * room.condition) / 100;
        const barColor = room.condition < 30 ? 0xe74c3c : 0xf39c12;
        this.roomGraphics.fillStyle(barColor, 0.8);
        this.roomGraphics.fillRect(x + 2, y + TILE_SIZE - 4, barWidth, 2);
      }

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

  /** Draw one floor's hallways and check-in desks. Call before rooms, which share the graphics layer. */
  renderFixtures(state: HotelState, floor: number) {
    for (const fixture of state.fixtures) {
      if (fixture.floor !== floor) continue;
      const x = GRID_OFFSET_X + fixture.gridX * TILE_SIZE;
      const y = GRID_OFFSET_Y + fixture.gridY * TILE_SIZE;
      if (fixture.type === 'hallway') {
        // Carpet runner: a flat strip with a faint centre line
        this.roomGraphics.fillStyle(HALLWAY_COLOR, 1);
        this.roomGraphics.fillRect(x, y, TILE_SIZE, TILE_SIZE);
        this.roomGraphics.fillStyle(0x6b6b85, 0.6);
        this.roomGraphics.fillRect(x + TILE_SIZE / 2 - 1, y + TILE_SIZE / 2 - 1, 2, 2);
      } else if (fixture.type === 'closet') {
        // Staff closet: a door with shelves behind it
        this.roomGraphics.fillStyle(CLOSET_COLOR, 0.85);
        this.roomGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        this.roomGraphics.fillStyle(0xffffff, 0.6);
        for (let shelf = 0; shelf < 3; shelf++) {
          this.roomGraphics.fillRect(x + 10, y + 12 + shelf * 10, TILE_SIZE - 20, 3);
        }
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

      // Fill with facility color
      this.roomGraphics.fillStyle(fConfig.color, 0.85);
      this.roomGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);

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
  renderGuests(state: HotelState, floor: number, walking: Set<string> = new Set()) {
    this.guestGraphics.clear();

    for (const guest of state.guests) {
      if (walking.has(guest.id)) continue;
      const room = state.rooms.find(r => r.guestId === guest.id);
      if (!room || room.floor !== floor) continue;

      const x = GRID_OFFSET_X + room.gridX * TILE_SIZE + TILE_SIZE / 2;
      const y = GRID_OFFSET_Y + room.gridY * TILE_SIZE + TILE_SIZE / 2;

      const dotColor = getGuestDotColor(guest.trait);

      this.guestGraphics.fillStyle(dotColor, 0.9);
      this.guestGraphics.fillCircle(x, y, 6);

      // Return-guest marker (design-review D7/D10): a thin ring around the
      // existing trait-color dot, visible on the grid during actual play.
      if (guest.isReturning) {
        this.guestGraphics.lineStyle(1.5, 0xffffff, 0.9);
        this.guestGraphics.strokeCircle(x, y, 9);
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

  /** Render noise levels as a color overlay on one floor's rooms */
  renderNoise(state: HotelState, floor: number) {
    this.noiseGraphics.clear();
    if (!this.showNoiseOverlay) return;

    for (const room of state.rooms) {
      if (room.floor !== floor) continue;
      const noise = calculateRoomNoise(room, state);
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
