import Phaser from 'phaser';
import type { RoomType, FacilityType, TileType, HotelState } from '../simulation/types';
import { ROOM_CONFIG, FACILITY_CONFIG, ELEVATOR, HALLWAY, DESK, CLOSET } from '../config/balance';
import { getRequiredStars, isUnlocked } from '../simulation/HotelState';
import { getExpectedPrice } from '../simulation/StarRatingManager';

const ROOM_COLORS: Record<RoomType, number> = {
  standard: 0x4a90d9,
  deluxe: 0x9b59b6,
  suite: 0xf1c40f,
};

const PANEL_WIDTH = 160;
const BTN_H = 30;
const BTN_STEP = 34;

/** Anything the build panel can place (a room, facility, hallway, desk, or elevator shaft), or the bulldoze tool. */
export type BuildType = TileType | 'elevator' | 'hallway' | 'desk' | 'closet' | 'bulldoze';

/** Tools that place on (or clear) one tile per click and can be dragged across tiles. */
export const PAINTABLE_TYPES = new Set<BuildType>(['hallway', 'bulldoze']);

const CATEGORY_HEADERS: Record<string, string> = { facility: 'FACILITIES', service: 'SERVICE' };

interface BuildOption {
  type: BuildType;
  label: string;
  cost: number;
  subtitle: string;
  color: number;
  category: 'room' | 'facility' | 'service';
}

function formatCost(cost: number): string {
  return cost > 0 ? `$${cost.toLocaleString()}` : 'Free';
}

export class BuildPanel {
  private scene: Phaser.Scene;
  private x: number;
  private y: number;
  private selectedType: BuildType | null = null;
  private onSelect: (type: BuildType | null) => void;
  private buttonBackgrounds: Map<string, Phaser.GameObjects.Graphics> = new Map();
  private costTexts: Map<string, Phaser.GameObjects.Text> = new Map();
  private subtitleTexts: Map<string, Phaser.GameObjects.Text> = new Map();
  private containers: Map<string, Phaser.GameObjects.Container> = new Map();
  private locked: Set<string> = new Set();
  private options: BuildOption[] = [];

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    onSelect: (type: BuildType | null) => void
  ) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.onSelect = onSelect;
    this.buildOptions();
    this.create();
  }

  private buildOptions() {
    // Room types
    for (const type of ['standard', 'deluxe', 'suite'] as RoomType[]) {
      const config = ROOM_CONFIG[type];
      this.options.push({
        type,
        label: type.charAt(0).toUpperCase() + type.slice(1),
        cost: config.buildCost,
        subtitle: `$${config.defaultPrice}/nt`,
        color: ROOM_COLORS[type],
        category: 'room',
      });
    }
    // Facility types
    for (const [type, config] of Object.entries(FACILITY_CONFIG)) {
      this.options.push({
        type: type as FacilityType,
        label: config.label,
        cost: config.buildCost,
        subtitle: `$${config.dailyOperatingCost}/day`,
        color: config.color,
        category: 'facility',
      });
    }
    // Building infrastructure
    this.options.push({
      type: 'hallway',
      label: 'Hallway',
      cost: HALLWAY.buildCost,
      subtitle: 'drag to lay',
      color: 0x8e8e9e,
      category: 'service',
    });
    this.options.push({
      type: 'desk',
      label: 'Check-in Desk',
      cost: DESK.buildCost,
      subtitle: `ground fl, ${DESK.staffPerDesk} staff`,
      color: 0xa0522d,
      category: 'service',
    });
    this.options.push({
      type: 'closet',
      label: 'Staff Closet',
      cost: CLOSET.buildCost,
      subtitle: 'shorter staff walks',
      color: 0x16a085,
      category: 'service',
    });
    // Elevator shafts run through every floor
    this.options.push({
      type: 'elevator',
      label: 'Elevator',
      cost: ELEVATOR.buildCost,
      subtitle: `${ELEVATOR.roomsServed} upper rooms`,
      color: 0x7f8c8d,
      category: 'service',
    });
    this.options.push({
      type: 'bulldoze',
      label: 'Bulldoze',
      cost: 0,
      subtitle: 'hall/desk/closet/lift',
      color: 0xc0392b,
      category: 'service',
    });
  }

  private create() {
    const headers = new Set(this.options.map(o => o.category)).size - 1;
    const totalHeight = 30 + this.options.length * BTN_STEP + headers * 22 + 4; // header + buttons + category labels

    // Panel background
    const bg = this.scene.add.graphics();
    bg.fillStyle(0x1a1a3e, 0.9);
    bg.fillRoundedRect(this.x, this.y, PANEL_WIDTH, totalHeight, 8);
    bg.lineStyle(1, 0x4a4a6a, 1);
    bg.strokeRoundedRect(this.x, this.y, PANEL_WIDTH, totalHeight, 8);

    this.scene.add.text(this.x + 12, this.y + 8, 'ROOMS', {
      fontSize: '11px', fontFamily: 'monospace', color: '#8888aa',
    });

    let btnY = this.y + 26;
    let lastCategory = '';

    for (const option of this.options) {
      // Category divider
      if (option.category !== lastCategory && CATEGORY_HEADERS[option.category]) {
        // Divider line
        const divG = this.scene.add.graphics();
        divG.lineStyle(1, 0x3a3a5a, 0.5);
        divG.lineBetween(this.x + 8, btnY + 2, this.x + PANEL_WIDTH - 8, btnY + 2);

        this.scene.add.text(this.x + 12, btnY + 6, CATEGORY_HEADERS[option.category], {
          fontSize: '11px', fontFamily: 'monospace', color: '#8888aa',
        });
        btnY += 22;
      }
      lastCategory = option.category;

      this.createButton(option, btnY);
      btnY += BTN_STEP;
    }
  }

  private createButton(option: BuildOption, btnY: number) {
    const container = this.scene.add.container(this.x + 8, btnY);

    // Button background
    const btnBg = this.scene.add.graphics();
    this.drawButton(btnBg, option.color, false);
    container.add(btnBg);
    this.buttonBackgrounds.set(option.type, btnBg);

    // Color swatch
    const swatch = this.scene.add.graphics();
    swatch.fillStyle(option.color, 1);
    swatch.fillRect(6, 6, 8, 8);
    container.add(swatch);

    // Name
    container.add(this.scene.add.text(18, 3, option.label, {
      fontSize: '11px', fontFamily: 'monospace', color: '#ffffff',
    }));

    // Cost (or lock notice) on the second line, subtitle beside it
    const costText = this.scene.add.text(6, 16, formatCost(option.cost), {
      fontSize: '10px', fontFamily: 'monospace', color: '#aaaacc',
    });
    container.add(costText);
    this.costTexts.set(option.type, costText);

    // Subtitle
    const subtitle = this.scene.add.text(PANEL_WIDTH - 22, 16, option.subtitle, {
      fontSize: '9px', fontFamily: 'monospace', color: '#888899',
    }).setOrigin(1, 0);
    container.add(subtitle);
    this.subtitleTexts.set(option.type, subtitle);
    this.containers.set(option.type, container);

    // Hit area
    const hitArea = this.scene.add.rectangle(
      (PANEL_WIDTH - 16) / 2, BTN_H / 2, PANEL_WIDTH - 16, BTN_H
    );
    hitArea.setInteractive({ useHandCursor: true });
    hitArea.setAlpha(0.01);
    container.add(hitArea);

    hitArea.on('pointerdown', () => {
      if (this.locked.has(option.type)) return;
      this.selectedType = this.selectedType === option.type ? null : option.type;
      this.refreshAllButtons();
      this.onSelect(this.selectedType);
    });

    hitArea.on('pointerover', () => {
      if (this.selectedType !== option.type) {
        this.drawButton(btnBg, option.color, false, true);
      }
    });

    hitArea.on('pointerout', () => {
      this.drawButton(btnBg, option.color, this.selectedType === option.type);
    });
  }

  private drawButton(g: Phaser.GameObjects.Graphics, color: number, selected: boolean, hover = false) {
    g.clear();
    const fillAlpha = selected ? 0.5 : hover ? 0.4 : 0.3;
    const strokeAlpha = selected ? 1 : hover ? 0.8 : 0.6;
    g.fillStyle(color, fillAlpha);
    g.fillRoundedRect(0, 0, PANEL_WIDTH - 16, BTN_H, 6);
    g.lineStyle(2, color, strokeAlpha);
    g.strokeRoundedRect(0, 0, PANEL_WIDTH - 16, BTN_H, 6);
  }

  private refreshAllButtons() {
    for (const [type, bg] of this.buttonBackgrounds) {
      const option = this.options.find(o => o.type === type)!;
      this.drawButton(bg, option.color, this.selectedType === type);
    }
  }

  /** Refresh lock state, affordability, and room prices (which follow the star rating). */
  update(state: HotelState) {
    for (const option of this.options) {
      const costText = this.costTexts.get(option.type);
      const subtitle = this.subtitleTexts.get(option.type);
      const container = this.containers.get(option.type);
      if (!costText || !subtitle || !container) continue;

      const unlocked = !(option.type in ROOM_CONFIG || option.type in FACILITY_CONFIG) || isUnlocked(state, option.type as TileType);
      if (unlocked) {
        this.locked.delete(option.type);
        container.setAlpha(1);
        costText.setText(formatCost(option.cost));
        costText.setColor(state.cash >= option.cost ? '#aaaacc' : '#e74c3c');
      } else {
        this.locked.add(option.type);
        container.setAlpha(0.45);
        costText.setText(`🔒 Unlocks at ${getRequiredStars(option.type as TileType)}★`);
        costText.setColor('#aaaacc');
        if (this.selectedType === option.type) this.clearSelection();
      }

      if (option.category === 'room') {
        subtitle.setText(`$${getExpectedPrice(option.type as RoomType, state.starRating)}/nt`);
      }
    }
  }

  getSelectedType(): BuildType | null {
    return this.selectedType;
  }

  isElevatorSelected(): boolean {
    return this.selectedType === 'elevator';
  }

  /** Check if selected type is a room type */
  isRoomSelected(): boolean {
    return this.selectedType !== null && ['standard', 'deluxe', 'suite'].includes(this.selectedType);
  }

  /** Check if selected type is a facility type */
  isFacilitySelected(): boolean {
    return this.selectedType !== null && !this.isRoomSelected() && !this.isElevatorSelected();
  }

  clearSelection() {
    this.selectedType = null;
    this.refreshAllButtons();
  }
}
