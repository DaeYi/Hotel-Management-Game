import Phaser from 'phaser';
import type { HotelState, Facility } from '../simulation/types';
import { FACILITY_CONFIG, FACILITY_LEVELS, DECOR } from '../config/balance';
import { TILE_SIZE, GRID_OFFSET_X, GRID_OFFSET_Y } from './GridRenderer';
import { getDemolishRefund, getRenovationCost, getFacilityUpgradeCost } from '../simulation/HotelState';
import { getUpkeepMultiplier } from '../simulation/StarRatingManager';

// Smaller than RoomInspector: no price slider (facilities don't have a
// per-night price). Facilities don't wear down like rooms, but their decor
// fades and they can be upgraded twice (levels 2 and 3, gated by stars).
const PANEL_W = 240;
const PANEL_H = 228;

const BUTTON_STYLE = {
  fontSize: '12px', fontFamily: 'monospace', padding: { x: 12, y: 6 },
};

export class FacilityInspector {
  private container: Phaser.GameObjects.Container;
  private titleText: Phaser.GameObjects.Text;
  private statsText: Phaser.GameObjects.Text;
  private upgradeBtn: Phaser.GameObjects.Text;
  private renovateBtn: Phaser.GameObjects.Text;
  private demolishBtn: Phaser.GameObjects.Text;

  private selectedFacilityId: string | null = null;

  // Container world position (updated on show)
  private panelWorldX = 0;
  private panelWorldY = 0;

  constructor(
    scene: Phaser.Scene,
    onUpgrade: (facilityId: string) => void,
    onRenovate: (facilityId: string) => void,
    onDemolish: (facilityId: string) => void
  ) {
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
      wordWrap: { width: PANEL_W - 24 },
    });
    this.container.add(this.statsText);

    const makeButton = (y: number, color: string, bgColor: string, onClick: (id: string) => void) => {
      const btn = scene.add.text(PANEL_W / 2, y, '', { ...BUTTON_STYLE, color, backgroundColor: bgColor })
        .setOrigin(0.5).setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => {
        if (this.selectedFacilityId) onClick(this.selectedFacilityId);
      });
      btn.on('pointerover', () => btn.setColor('#ffffff'));
      btn.on('pointerout', () => btn.setColor(btn.getData('color') ?? color));
      btn.setData('color', color);
      this.container.add(btn);
      return btn;
    };

    this.upgradeBtn = makeButton(144, '#4a90d9', '#1a2a4a', onUpgrade);
    this.renovateBtn = makeButton(174, '#e67e22', '#3a2a1a', onRenovate);
    this.demolishBtn = makeButton(204, '#e74c3c', '#3a1a1a', id => {
      onDemolish(id);
      this.hide();
    });
  }

  show(facility: Facility, state: HotelState) {
    this.selectedFacilityId = facility.id;

    // Position near the facility but keep on screen
    const facilityScreenX = GRID_OFFSET_X + facility.gridX * TILE_SIZE + TILE_SIZE;
    const facilityScreenY = GRID_OFFSET_Y + facility.gridY * TILE_SIZE;
    this.panelWorldX = Math.min(facilityScreenX, 960 - PANEL_W - 8);
    this.panelWorldY = Math.min(Math.max(facilityScreenY, 8), 640 - PANEL_H - 8);
    this.container.setPosition(this.panelWorldX, this.panelWorldY);

    this.updateContent(facility, state);
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
    this.updateContent(facility, state);
  }

  private updateContent(facility: Facility, state: HotelState) {
    const config = FACILITY_CONFIG[facility.type];
    const level = FACILITY_LEVELS[facility.level - 1];
    this.titleText.setText(`${config.label}  (Lv ${facility.level}/${FACILITY_LEVELS.length})`);

    const operating = Math.round(config.dailyOperatingCost * level.operatingMult * getUpkeepMultiplier(state.starRating));
    const decorNote = facility.decor < DECOR.freshThreshold ? ' (stale)' : '';
    this.statsText.setText(
      `${config.description}\n` +
      `Operating cost: $${operating}/day\n` +
      `Decor: ${facility.decor.toFixed(0)}%${decorNote}`
    );

    // Upgrade: hidden at max level; shows the star requirement while locked
    const upgradeCost = getFacilityUpgradeCost(facility);
    const next = FACILITY_LEVELS[facility.level];
    this.upgradeBtn.setVisible(upgradeCost !== null);
    if (upgradeCost !== null && next) {
      if (state.peakStarRating < next.requiredStars) {
        this.setButton(this.upgradeBtn, `Upgrade to Lv ${facility.level + 1}: needs ${next.requiredStars}★`, '#666688');
      } else {
        const affordable = state.cash >= upgradeCost;
        this.setButton(this.upgradeBtn, `Upgrade to Lv ${facility.level + 1} ($${upgradeCost.toLocaleString()})`, affordable ? '#4a90d9' : '#e74c3c');
      }
    }

    // Renovate once decor has started to fade
    const canRenovate = facility.decor < 90;
    this.renovateBtn.setVisible(canRenovate);
    if (canRenovate) {
      const cost = getRenovationCost(config.buildCost, state.starRating);
      this.setButton(this.renovateBtn, `Renovate ($${cost.toLocaleString()})`, state.cash >= cost ? '#e67e22' : '#e74c3c');
    }

    const refund = getDemolishRefund(config.buildCost);
    this.demolishBtn.setText(`Demolish (+$${refund.toLocaleString()})`);
  }

  private setButton(btn: Phaser.GameObjects.Text, text: string, color: string) {
    btn.setText(text);
    btn.setColor(color);
    btn.setData('color', color);
  }
}
