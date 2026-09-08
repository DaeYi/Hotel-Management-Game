import Phaser from 'phaser';
import type { RoomType, FacilityType, TileType } from '../simulation/types';
import { ROOM_CONFIG, FACILITY_CONFIG } from '../config/balance';

const ROOM_COLORS: Record<RoomType, number> = {
  standard: 0x4a90d9,
  deluxe: 0x9b59b6,
  suite: 0xf1c40f,
};

const PANEL_WIDTH = 160;

interface BuildOption {
  type: TileType;
  label: string;
  cost: number;
  subtitle: string;
  color: number;
  category: 'room' | 'facility';
}

export class BuildPanel {
  private scene: Phaser.Scene;
  private x: number;
  private y: number;
  private selectedType: TileType | null = null;
  private onSelect: (type: TileType | null) => void;
  private buttonBackgrounds: Map<string, Phaser.GameObjects.Graphics> = new Map();
  private costTexts: Map<string, Phaser.GameObjects.Text> = new Map();
  private options: BuildOption[] = [];

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    onSelect: (type: TileType | null) => void
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
        subtitle: `$${config.defaultPrice}/night`,
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
  }

  private create() {
    const totalHeight = 40 + this.options.length * 56 + 20; // header + buttons + padding

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
      if (option.category !== lastCategory && option.category === 'facility') {
        // Divider line
        const divG = this.scene.add.graphics();
        divG.lineStyle(1, 0x3a3a5a, 0.5);
        divG.lineBetween(this.x + 8, btnY + 2, this.x + PANEL_WIDTH - 8, btnY + 2);

        this.scene.add.text(this.x + 12, btnY + 6, 'FACILITIES', {
          fontSize: '11px', fontFamily: 'monospace', color: '#8888aa',
        });
        btnY += 22;
      }
      lastCategory = option.category;

      this.createButton(option, btnY);
      btnY += 56;
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
    swatch.fillRect(6, 6, 10, 10);
    container.add(swatch);

    // Name
    container.add(this.scene.add.text(22, 4, option.label, {
      fontSize: '12px', fontFamily: 'monospace', color: '#ffffff',
    }));

    // Cost
    const costText = this.scene.add.text(6, 22, `$${option.cost.toLocaleString()}`, {
      fontSize: '11px', fontFamily: 'monospace', color: '#aaaacc',
    });
    container.add(costText);
    this.costTexts.set(option.type, costText);

    // Subtitle
    container.add(this.scene.add.text(6, 36, option.subtitle, {
      fontSize: '10px', fontFamily: 'monospace', color: '#888899',
    }));

    // Hit area
    const hitArea = this.scene.add.rectangle(
      (PANEL_WIDTH - 16) / 2, 26, PANEL_WIDTH - 16, 52
    );
    hitArea.setInteractive({ useHandCursor: true });
    hitArea.setAlpha(0.01);
    container.add(hitArea);

    hitArea.on('pointerdown', () => {
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
    g.fillRoundedRect(0, 0, PANEL_WIDTH - 16, 52, 6);
    g.lineStyle(2, color, strokeAlpha);
    g.strokeRoundedRect(0, 0, PANEL_WIDTH - 16, 52, 6);
  }

  private refreshAllButtons() {
    for (const [type, bg] of this.buttonBackgrounds) {
      const option = this.options.find(o => o.type === type)!;
      this.drawButton(bg, option.color, this.selectedType === type);
    }
  }

  updateAffordability(cash: number) {
    for (const option of this.options) {
      const text = this.costTexts.get(option.type);
      if (text) {
        text.setColor(cash >= option.cost ? '#aaaacc' : '#e74c3c');
      }
    }
  }

  getSelectedType(): TileType | null {
    return this.selectedType;
  }

  /** Check if selected type is a room type */
  isRoomSelected(): boolean {
    return this.selectedType !== null && ['standard', 'deluxe', 'suite'].includes(this.selectedType);
  }

  /** Check if selected type is a facility type */
  isFacilitySelected(): boolean {
    return this.selectedType !== null && !this.isRoomSelected();
  }

  clearSelection() {
    this.selectedType = null;
    this.refreshAllButtons();
  }
}
