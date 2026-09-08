import Phaser from 'phaser';
import type { HotelState, Room } from '../simulation/types';
import { ROOM_CONFIG, ECONOMY, AMENITIES } from '../config/balance';
import { TILE_SIZE, GRID_OFFSET_X, GRID_OFFSET_Y } from './GridRenderer';
import { calculateRoomNoise } from '../simulation/NoiseManager';
import { getDemolishRefund } from '../simulation/HotelState';

const PANEL_W = 220;
const PANEL_H = 260;

export class RoomInspector {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private titleText: Phaser.GameObjects.Text;
  private statsText: Phaser.GameObjects.Text;
  private priceValue: Phaser.GameObjects.Text;
  private sliderTrack: Phaser.GameObjects.Graphics;
  private sliderThumb: Phaser.GameObjects.Graphics;

  private selectedRoomId: string | null = null;
  private dragging = false;
  private sliderX = 16;
  private sliderY = 140;
  private sliderW = PANEL_W - 32;

  // Container world position (updated on show)
  private panelWorldX = 0;
  private panelWorldY = 0;

  private repairBtn: Phaser.GameObjects.Text;
  private demolishBtn: Phaser.GameObjects.Text;

  private onPriceChange: (roomId: string, pct: number) => void;
  private onRepair: (roomId: string) => void;
  private onDemolish: (roomId: string) => void;

  constructor(
    scene: Phaser.Scene,
    onPriceChange: (roomId: string, pct: number) => void,
    onRepair: (roomId: string) => void,
    onDemolish: (roomId: string) => void
  ) {
    this.scene = scene;
    this.onPriceChange = onPriceChange;
    this.onRepair = onRepair;
    this.onDemolish = onDemolish;

    this.container = scene.add.container(0, 0).setDepth(20).setVisible(false);

    // Background
    const bg = scene.add.graphics();
    bg.fillStyle(0x1a1a3e, 0.95);
    bg.fillRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    bg.lineStyle(1, 0x6a6a8a, 1);
    bg.strokeRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    this.container.add(bg);

    // Title
    this.titleText = scene.add.text(12, 10, '', {
      fontSize: '14px', fontFamily: 'monospace', color: '#ffffff',
    });
    this.container.add(this.titleText);

    // Close button
    const closeBtn = scene.add.text(PANEL_W - 28, 8, '\u2715', {
      fontSize: '16px', fontFamily: 'monospace', color: '#888899',
    });
    closeBtn.setInteractive({ useHandCursor: true });
    closeBtn.on('pointerdown', () => this.hide());
    closeBtn.on('pointerover', () => closeBtn.setColor('#ffffff'));
    closeBtn.on('pointerout', () => closeBtn.setColor('#888899'));
    this.container.add(closeBtn);

    // Stats
    this.statsText = scene.add.text(12, 34, '', {
      fontSize: '12px', fontFamily: 'monospace', color: '#aaaacc', lineSpacing: 4,
    });
    this.container.add(this.statsText);

    // Price label
    this.container.add(scene.add.text(12, 120, 'Price per night:', {
      fontSize: '11px', fontFamily: 'monospace', color: '#888899',
    }));

    // Price value
    this.priceValue = scene.add.text(PANEL_W - 16, 120, '', {
      fontSize: '13px', fontFamily: 'monospace', color: '#f1c40f',
    }).setOrigin(1, 0);
    this.container.add(this.priceValue);

    // Slider track
    this.sliderTrack = scene.add.graphics();
    this.container.add(this.sliderTrack);

    // Slider thumb (drawn as graphics, not a game object with drag)
    this.sliderThumb = scene.add.graphics();
    this.container.add(this.sliderThumb);

    // Repair button (shown only for damaged/broken rooms)
    this.repairBtn = scene.add.text(PANEL_W / 2, 175, `Repair ($${ECONOMY.roomRepairCost})`, {
      fontSize: '12px', fontFamily: 'monospace', color: '#2ecc71',
      backgroundColor: '#1a3a2e',
      padding: { x: 12, y: 6 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.repairBtn.on('pointerdown', () => {
      if (this.selectedRoomId) this.onRepair(this.selectedRoomId);
    });
    this.repairBtn.on('pointerover', () => this.repairBtn.setColor('#ffffff'));
    this.repairBtn.on('pointerout', () => this.repairBtn.setColor('#2ecc71'));
    this.container.add(this.repairBtn);

    // Demolish button
    this.demolishBtn = scene.add.text(PANEL_W / 2, 205, 'Demolish', {
      fontSize: '12px', fontFamily: 'monospace', color: '#e74c3c',
      backgroundColor: '#3a1a1a',
      padding: { x: 12, y: 6 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.demolishBtn.on('pointerdown', () => {
      if (this.selectedRoomId) {
        this.onDemolish(this.selectedRoomId);
        this.hide();
      }
    });
    this.demolishBtn.on('pointerover', () => this.demolishBtn.setColor('#ffffff'));
    this.demolishBtn.on('pointerout', () => this.demolishBtn.setColor('#e74c3c'));
    this.container.add(this.demolishBtn);

    // Use scene-level pointer events for slider interaction
    scene.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this.container.visible || !this.selectedRoomId) return;
      if (this.isInSliderArea(pointer.x, pointer.y)) {
        this.dragging = true;
        this.applySliderPosition(pointer.x);
      }
    });

    scene.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (this.dragging) {
        this.applySliderPosition(pointer.x);
      }
    });

    scene.input.on('pointerup', () => {
      this.dragging = false;
    });
  }

  show(room: Room, state: HotelState) {
    this.selectedRoomId = room.id;

    // Position near the room but keep on screen
    const roomScreenX = GRID_OFFSET_X + room.gridX * TILE_SIZE + TILE_SIZE;
    const roomScreenY = GRID_OFFSET_Y + room.gridY * TILE_SIZE;
    this.panelWorldX = Math.min(roomScreenX, 960 - PANEL_W - 8);
    this.panelWorldY = Math.min(Math.max(roomScreenY, 8), 640 - PANEL_H - 8);
    this.container.setPosition(this.panelWorldX, this.panelWorldY);

    this.updateContent(room, state);
    this.updateSliderPosition(room);
    this.container.setVisible(true);
  }

  hide() {
    this.selectedRoomId = null;
    this.dragging = false;
    this.container.setVisible(false);
  }

  isVisible(): boolean {
    return this.container.visible;
  }

  /** Check if a world-space point is inside the inspector panel */
  containsPoint(worldX: number, worldY: number): boolean {
    if (!this.container.visible) return false;
    return worldX >= this.panelWorldX
      && worldX <= this.panelWorldX + PANEL_W
      && worldY >= this.panelWorldY
      && worldY <= this.panelWorldY + PANEL_H;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  getSelectedRoomId(): string | null {
    return this.selectedRoomId;
  }

  update(state: HotelState) {
    if (!this.selectedRoomId || !this.container.visible) return;
    const room = state.rooms.find(r => r.id === this.selectedRoomId);
    if (!room) {
      this.hide();
      return;
    }
    this.updateContent(room, state);
  }

  private updateContent(room: Room, state: HotelState) {
    const config = ROOM_CONFIG[room.type];
    const typeName = room.type.charAt(0).toUpperCase() + room.type.slice(1);

    this.titleText.setText(`${typeName} Room`);

    const guest = state.guests.find(g => g.id === room.guestId);
    let statusLine: string;
    if (room.status === 'occupied') {
      statusLine = `Status:     Occupied (${guest?.trait ?? 'unknown'})`;
    } else if (room.status === 'cleaning') {
      statusLine = `Status:     Cleaning (${room.cleaningHoursRemaining}h left)`;
    } else if (room.condition <= ECONOMY.roomBreakdownThreshold) {
      statusLine = 'Status:     OUT OF ORDER';
    } else {
      statusLine = 'Status:     Vacant';
    }

    const condBar = '\u2588'.repeat(Math.round(room.condition / 10))
      + '\u2591'.repeat(10 - Math.round(room.condition / 10));

    const cleanBar = '\u2588'.repeat(Math.round(room.cleanliness / 10))
      + '\u2591'.repeat(10 - Math.round(room.cleanliness / 10));

    const noise = calculateRoomNoise(room, state);
    const noiseLabel = noise <= 0.2 ? 'Quiet'
      : noise <= 0.5 ? 'Low'
      : noise <= 1.0 ? 'Moderate'
      : noise <= 1.5 ? 'Loud'
      : 'Very Loud';

    const amenityTier = state.amenities[room.type];
    const amenityLabel = AMENITIES.tiers[amenityTier]?.label ?? 'Basic';

    this.statsText.setText(
      `${statusLine}\n` +
      `Condition:  ${condBar} ${room.condition.toFixed(0)}%\n` +
      `Cleanliness:${cleanBar} ${room.cleanliness.toFixed(0)}%\n` +
      `Amenities:  ${amenityLabel}  |  Noise: ${noiseLabel}`
    );

    this.priceValue.setText(`$${room.pricePerNight}`);

    // Show repair button when condition is below 80% and room is vacant
    const needsRepair = room.condition < 80 && room.status === 'vacant';
    this.repairBtn.setVisible(needsRepair);
    if (needsRepair && state.cash < ECONOMY.roomRepairCost) {
      this.repairBtn.setColor('#e74c3c');
      this.repairBtn.setText(`Repair ($${ECONOMY.roomRepairCost}) - can't afford`);
    } else if (needsRepair) {
      this.repairBtn.setColor('#2ecc71');
      this.repairBtn.setText(`Repair ($${ECONOMY.roomRepairCost})`);
    }

    // Show demolish button when room is not occupied (allow during cleaning)
    this.demolishBtn.setVisible(room.status !== 'occupied');
    const refund = getDemolishRefund(ROOM_CONFIG[room.type].buildCost);
    this.demolishBtn.setText(`Demolish (+$${refund})`);
  }

  private updateSliderPosition(room: Room) {
    const config = ROOM_CONFIG[room.type];
    const range = config.maxPrice - config.minPrice;
    const pct = (room.pricePerNight - config.minPrice) / range;

    this.drawSliderTrack(config.minPrice, config.maxPrice, config.expectedPrice);
    this.drawThumb(this.sliderX + pct * this.sliderW);
  }

  private drawSliderTrack(min: number, max: number, expected: number) {
    this.sliderTrack.clear();

    // Track background
    this.sliderTrack.fillStyle(0x2a2a4a, 1);
    this.sliderTrack.fillRoundedRect(this.sliderX, this.sliderY + 4, this.sliderW, 8, 4);

    // Expected price marker (green tick)
    const expectedPct = (expected - min) / (max - min);
    const markerX = this.sliderX + expectedPct * this.sliderW;
    this.sliderTrack.fillStyle(0x2ecc71, 0.8);
    this.sliderTrack.fillRect(markerX - 1, this.sliderY, 2, 16);
  }

  private drawThumb(localX: number) {
    this.sliderThumb.clear();
    this.sliderThumb.fillStyle(0xf1c40f, 1);
    this.sliderThumb.fillRoundedRect(localX - 7, this.sliderY - 1, 14, 18, 3);
  }

  private isInSliderArea(worldX: number, worldY: number): boolean {
    const localX = worldX - this.panelWorldX;
    const localY = worldY - this.panelWorldY;
    return localX >= this.sliderX - 10
      && localX <= this.sliderX + this.sliderW + 10
      && localY >= this.sliderY - 10
      && localY <= this.sliderY + 26;
  }

  private applySliderPosition(worldX: number) {
    if (!this.selectedRoomId) return;

    const localX = worldX - this.panelWorldX - this.sliderX;
    const clamped = Math.max(0, Math.min(this.sliderW, localX));
    const pct = clamped / this.sliderW;

    this.drawThumb(this.sliderX + clamped);
    this.onPriceChange(this.selectedRoomId, pct);
  }
}
