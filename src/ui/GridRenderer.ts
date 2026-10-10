import Phaser from 'phaser';
import type { HotelState, RoomType, FacilityType, GuestTrait } from '../simulation/types';
import { GRID, ECONOMY, NOISE, FACILITY_CONFIG, DECOR } from '../config/balance';
import { calculateRoomNoise } from '../simulation/NoiseManager';
import { formatRoomLabel } from '../simulation/HotelState';

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

export const TILE_SIZE = 32;
export const GRID_OFFSET_X = 16;
export const GRID_OFFSET_Y = 72;

const ROOM_COLORS: Record<RoomType, number> = {
  standard: 0x4a90d9,
  deluxe: 0x9b59b6,
  suite: 0xf1c40f,
};

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
      ?? 0xcccccc;

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

  renderRooms(state: HotelState) {
    this.roomGraphics.clear();
    const seenRoomIds = new Set<string>();

    for (const room of state.rooms) {
      const x = GRID_OFFSET_X + room.gridX * TILE_SIZE;
      const y = GRID_OFFSET_Y + room.gridY * TILE_SIZE;
      const color = room.status === 'occupied' ? ROOM_OCCUPIED_COLORS[room.type]
        : room.status === 'cleaning' ? 0x888888
        : room.status === 'renovating' ? 0xd35400
        : ROOM_COLORS[room.type];
      const alpha = room.condition <= ECONOMY.roomBreakdownThreshold ? 0.3 : 0.85;

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
          fontSize: '7px', fontFamily: 'monospace', color: '#ffffff',
        }).setAlpha(0.55).setDepth(2);
        this.roomLabels.set(room.id, label);
      }
      label.setText(formatRoomLabel(room.gridX, room.gridY));
      label.setPosition(x + 2, y + 1);
    }

    // A demolished room's label is removed rather than left dangling.
    for (const [roomId, label] of this.roomLabels) {
      if (!seenRoomIds.has(roomId)) {
        label.destroy();
        this.roomLabels.delete(roomId);
      }
    }
  }

  renderFacilities(state: HotelState) {
    // Facilities are drawn on the same graphics layer as rooms
    for (const facility of state.facilities) {
      const x = GRID_OFFSET_X + facility.gridX * TILE_SIZE;
      const y = GRID_OFFSET_Y + facility.gridY * TILE_SIZE;
      const fConfig = FACILITY_CONFIG[facility.type];
      if (!fConfig) continue;

      // Fill with facility color
      this.roomGraphics.fillStyle(fConfig.color, 0.85);
      this.roomGraphics.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);

      // Icon/label: first letter of the facility type
      const label = fConfig.label.charAt(0);
      // Draw a small centered letter (using graphics since text would need separate objects)
      this.roomGraphics.fillStyle(0xffffff, 0.7);
      // Simple centered dot pattern for identification
      const cx = x + TILE_SIZE / 2;
      const cy = y + TILE_SIZE / 2;
      switch (facility.type) {
        case 'gym':
          // Dumbbell shape: two circles connected
          this.roomGraphics.fillCircle(cx - 6, cy, 4);
          this.roomGraphics.fillCircle(cx + 6, cy, 4);
          this.roomGraphics.fillRect(cx - 6, cy - 1.5, 12, 3);
          break;
        case 'restaurant':
          // Fork/plate: circle with lines
          this.roomGraphics.fillCircle(cx, cy, 7);
          this.roomGraphics.fillStyle(fConfig.color, 1);
          this.roomGraphics.fillCircle(cx, cy, 5);
          break;
        case 'pool':
          // Wave lines
          this.roomGraphics.fillStyle(0xffffff, 0.7);
          this.roomGraphics.fillRect(cx - 8, cy - 2, 16, 2);
          this.roomGraphics.fillRect(cx - 6, cy + 2, 12, 2);
          break;
        case 'shop':
          // Shopping bag shape
          this.roomGraphics.fillRect(cx - 5, cy - 3, 10, 8);
          this.roomGraphics.fillStyle(fConfig.color, 1);
          this.roomGraphics.fillRect(cx - 3, cy - 1, 6, 4);
          break;
      }
    }
  }

  renderGuests(state: HotelState) {
    this.guestGraphics.clear();

    for (const guest of state.guests) {
      const room = state.rooms.find(r => r.guestId === guest.id);
      if (!room) continue;

      const x = GRID_OFFSET_X + room.gridX * TILE_SIZE + TILE_SIZE / 2;
      const y = GRID_OFFSET_Y + room.gridY * TILE_SIZE + TILE_SIZE / 2;

      const dotColor = getGuestDotColor(guest.trait);

      this.guestGraphics.fillStyle(dotColor, 0.9);
      this.guestGraphics.fillCircle(x, y, 4);

      // Return-guest marker (design-review D7/D10): a thin ring around the
      // existing trait-color dot, visible on the grid during actual play.
      if (guest.isReturning) {
        this.guestGraphics.lineStyle(1.5, 0xffffff, 0.9);
        this.guestGraphics.strokeCircle(x, y, 6.5);
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

  toggleNoiseOverlay() {
    this.showNoiseOverlay = !this.showNoiseOverlay;
    if (!this.showNoiseOverlay) this.noiseGraphics.clear();
    return this.showNoiseOverlay;
  }

  /** Render noise levels as a color overlay on rooms */
  renderNoise(state: HotelState) {
    this.noiseGraphics.clear();
    if (!this.showNoiseOverlay) return;

    for (const room of state.rooms) {
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
  renderConstruction(state: HotelState) {
    this.constructionGraphics.clear();

    for (const ns of state.noiseSources) {
      const x = GRID_OFFSET_X + ns.gridX * TILE_SIZE;
      const y = GRID_OFFSET_Y + ns.gridY * TILE_SIZE;

      // Yellow pulsing outline for active construction
      const pulse = 0.4 + Math.sin(Date.now() / 300) * 0.2;
      this.constructionGraphics.lineStyle(2, 0xf39c12, pulse);
      this.constructionGraphics.strokeRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);

      // Small construction icon (hammer)
      this.constructionGraphics.fillStyle(0xf39c12, 0.8);
      this.constructionGraphics.fillTriangle(
        x + TILE_SIZE - 10, y + 3,
        x + TILE_SIZE - 3, y + 3,
        x + TILE_SIZE - 6, y + 10
      );
    }
  }
}
