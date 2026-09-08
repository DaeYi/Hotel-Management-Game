import Phaser from 'phaser';
import type { HotelState, RoomType, AmenityTier } from '../simulation/types';
import { AMENITIES, ROOM_CONFIG } from '../config/balance';

const PANEL_W = 300;
const PANEL_H = 280;

const TIER_ORDER: AmenityTier[] = ['basic', 'premium', 'luxury'];

export class AmenitiesPanel {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private visible = false;

  private tierButtons: Map<string, Phaser.GameObjects.Text[]> = new Map();
  private costTexts: Map<string, Phaser.GameObjects.Text> = new Map();
  private totalCostText!: Phaser.GameObjects.Text;
  private descText!: Phaser.GameObjects.Text;

  private onChange: (amenities: Record<RoomType, AmenityTier>) => void;

  constructor(
    scene: Phaser.Scene,
    toggleX: number,
    toggleY: number,
    panelX: number,
    panelY: number,
    onChange: (amenities: Record<RoomType, AmenityTier>) => void
  ) {
    this.scene = scene;
    this.onChange = onChange;

    // Toggle button
    const toggleBtn = scene.add.text(toggleX, toggleY, '\ud83d\udecf\ufe0f', {
      fontSize: '16px', fontFamily: 'monospace', color: '#888899',
      backgroundColor: '#2a2a4a', padding: { x: 6, y: 2 },
    }).setInteractive({ useHandCursor: true }).setDepth(15);

    toggleBtn.on('pointerdown', () => {
      this.visible = !this.visible;
      this.container.setVisible(this.visible);
      toggleBtn.setColor(this.visible ? '#ffffff' : '#888899');
      toggleBtn.setBackgroundColor(this.visible ? '#4a4a6a' : '#2a2a4a');
    });

    // Panel
    this.container = scene.add.container(panelX, panelY).setDepth(18).setVisible(false);

    const bg = scene.add.graphics();
    bg.fillStyle(0x1a1a3e, 0.95);
    bg.fillRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    bg.lineStyle(1, 0x4a4a6a, 1);
    bg.strokeRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    this.container.add(bg);

    this.container.add(scene.add.text(12, 10, 'IN-ROOM AMENITIES', {
      fontSize: '13px', fontFamily: 'monospace', color: '#8888aa',
    }));

    // One row per room type
    const roomTypes: RoomType[] = ['standard', 'deluxe', 'suite'];
    roomTypes.forEach((type, i) => {
      const y = 40 + i * 56;
      this.createRoomTypeRow(type, y);
    });

    // Description text (shows on hover)
    this.descText = scene.add.text(12, 212, 'Hover a tier for details', {
      fontSize: '10px', fontFamily: 'monospace', color: '#888899',
      wordWrap: { width: PANEL_W - 24 },
    });
    this.container.add(this.descText);

    // Total cost
    this.totalCostText = scene.add.text(12, 245, '', {
      fontSize: '12px', fontFamily: 'monospace', color: '#f1c40f',
    });
    this.container.add(this.totalCostText);
  }

  private createRoomTypeRow(type: RoomType, y: number) {
    const typeName = type.charAt(0).toUpperCase() + type.slice(1);
    this.container.add(this.scene.add.text(12, y, `${typeName}:`, {
      fontSize: '11px', fontFamily: 'monospace', color: '#aaaacc',
    }));

    const buttons: Phaser.GameObjects.Text[] = [];
    TIER_ORDER.forEach((tier, j) => {
      const tierConfig = AMENITIES.tiers[tier];
      const btn = this.scene.add.text(90 + j * 70, y, tierConfig.label, {
        fontSize: '11px', fontFamily: 'monospace', color: '#888899',
        backgroundColor: '#2a2a4a', padding: { x: 6, y: 4 },
      }).setInteractive({ useHandCursor: true });

      btn.on('pointerdown', () => this.selectTier(type, tier));
      btn.on('pointerover', () => {
        this.descText.setText(`${tierConfig.label}: ${tierConfig.description}\n$${tierConfig.dailyCostPerRoom}/room/day | Review: +${tierConfig.reviewBonus.toFixed(1)}`);
      });
      btn.on('pointerout', () => {
        this.descText.setText('Hover a tier for details');
      });

      this.container.add(btn);
      buttons.push(btn);
    });
    this.tierButtons.set(type, buttons);

    // Per-type cost
    const costText = this.scene.add.text(90, y + 22, '', {
      fontSize: '9px', fontFamily: 'monospace', color: '#666688',
    });
    this.container.add(costText);
    this.costTexts.set(type, costText);
  }

  show() { this.visible = true; this.container.setVisible(true); }
  hide() { this.visible = false; this.container.setVisible(false); }

  private currentAmenities: Record<RoomType, AmenityTier> = {
    standard: 'basic', deluxe: 'basic', suite: 'basic',
  };

  private selectTier(type: RoomType, tier: AmenityTier) {
    this.currentAmenities = { ...this.currentAmenities, [type]: tier };
    this.onChange(this.currentAmenities);
  }

  update(state: HotelState) {
    this.currentAmenities = { ...state.amenities };

    // Update button highlights
    for (const [type, buttons] of this.tierButtons) {
      const activeTier = state.amenities[type as RoomType];
      buttons.forEach((btn, j) => {
        const isActive = TIER_ORDER[j] === activeTier;
        btn.setColor(isActive ? '#ffffff' : '#888899');
        btn.setBackgroundColor(isActive ? '#4a6a4a' : '#2a2a4a');
      });
    }

    // Update per-type costs
    const roomCounts: Record<string, number> = { standard: 0, deluxe: 0, suite: 0 };
    for (const room of state.rooms) roomCounts[room.type]++;

    for (const [type, costText] of this.costTexts) {
      const tier = state.amenities[type as RoomType];
      const config = AMENITIES.tiers[tier];
      const count = roomCounts[type] ?? 0;
      const dailyCost = count * (config?.dailyCostPerRoom ?? 0);
      costText.setText(`${count} rooms x $${config?.dailyCostPerRoom ?? 0} = $${dailyCost}/day`);
    }

    // Total amenity cost
    let totalDaily = 0;
    for (const room of state.rooms) {
      const tier = state.amenities[room.type];
      const config = AMENITIES.tiers[tier];
      if (config) totalDaily += config.dailyCostPerRoom;
    }
    this.totalCostText.setText(`Total amenity cost: $${totalDaily}/day`);
  }
}
