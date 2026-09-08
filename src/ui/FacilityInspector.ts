import Phaser from 'phaser';
import type { HotelState, Facility } from '../simulation/types';
import { FACILITY_CONFIG } from '../config/balance';
import { TILE_SIZE, GRID_OFFSET_X, GRID_OFFSET_Y } from './GridRenderer';
import { getDemolishRefund } from '../simulation/HotelState';

// Facilities currently don't decay or need repair (see design doc's Facility
// Decay/Repair Decision — "no decay" is the default). This panel is
// intentionally smaller than RoomInspector: no price slider (facilities
// don't have a per-night price) and no condition bar/repair button.
const PANEL_W = 220;
const PANEL_H = 140;

export class FacilityInspector {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private titleText: Phaser.GameObjects.Text;
  private statsText: Phaser.GameObjects.Text;
  private demolishBtn: Phaser.GameObjects.Text;

  private selectedFacilityId: string | null = null;

  // Container world position (updated on show)
  private panelWorldX = 0;
  private panelWorldY = 0;

  private onDemolish: (facilityId: string) => void;

  constructor(
    scene: Phaser.Scene,
    onDemolish: (facilityId: string) => void
  ) {
    this.scene = scene;
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
    const closeBtn = scene.add.text(PANEL_W - 28, 8, '✕', {
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

    // Demolish button
    this.demolishBtn = scene.add.text(PANEL_W / 2, 100, 'Demolish', {
      fontSize: '12px', fontFamily: 'monospace', color: '#e74c3c',
      backgroundColor: '#3a1a1a',
      padding: { x: 12, y: 6 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.demolishBtn.on('pointerdown', () => {
      if (this.selectedFacilityId) {
        this.onDemolish(this.selectedFacilityId);
        this.hide();
      }
    });
    this.demolishBtn.on('pointerover', () => this.demolishBtn.setColor('#ffffff'));
    this.demolishBtn.on('pointerout', () => this.demolishBtn.setColor('#e74c3c'));
    this.container.add(this.demolishBtn);
  }

  show(facility: Facility) {
    this.selectedFacilityId = facility.id;

    // Position near the facility but keep on screen
    const facilityScreenX = GRID_OFFSET_X + facility.gridX * TILE_SIZE + TILE_SIZE;
    const facilityScreenY = GRID_OFFSET_Y + facility.gridY * TILE_SIZE;
    this.panelWorldX = Math.min(facilityScreenX, 960 - PANEL_W - 8);
    this.panelWorldY = Math.min(Math.max(facilityScreenY, 8), 640 - PANEL_H - 8);
    this.container.setPosition(this.panelWorldX, this.panelWorldY);

    this.updateContent(facility);
    this.container.setVisible(true);
  }

  hide() {
    this.selectedFacilityId = null;
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

  getSelectedFacilityId(): string | null {
    return this.selectedFacilityId;
  }

  update(state: HotelState) {
    if (!this.selectedFacilityId || !this.container.visible) return;
    const facility = state.facilities.find(f => f.id === this.selectedFacilityId);
    if (!facility) {
      this.hide();
      return;
    }
    this.updateContent(facility);
  }

  private updateContent(facility: Facility) {
    const config = FACILITY_CONFIG[facility.type];
    this.titleText.setText(config?.label ?? facility.type);

    this.statsText.setText(
      `${config?.description ?? ''}\n` +
      `Operating cost: $${config?.dailyOperatingCost ?? 0}/day`
    );

    const refund = getDemolishRefund(config?.buildCost ?? 0);
    this.demolishBtn.setText(`Demolish (+$${refund})`);
  }
}
