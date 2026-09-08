import Phaser from 'phaser';
import type { HotelState, CleaningQuality, DailyCleaningCadence } from '../simulation/types';
import { HOUSEKEEPING } from '../config/balance';
import { checkHousekeepingCompliance } from '../simulation/HousekeepingManager';

const PANEL_W = 260;
const PANEL_H = 220;

export class HousekeepingPanel {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private qualityButtons: Map<string, Phaser.GameObjects.Text> = new Map();
  private cadenceButtons: Map<string, Phaser.GameObjects.Text> = new Map();
  private warningText: Phaser.GameObjects.Text;
  private costText: Phaser.GameObjects.Text;
  private visible = false;

  private onChange: (quality: CleaningQuality, cadence: DailyCleaningCadence) => void;

  constructor(
    scene: Phaser.Scene,
    toggleX: number,
    toggleY: number,
    panelX: number,
    panelY: number,
    onChange: (quality: CleaningQuality, cadence: DailyCleaningCadence) => void
  ) {
    this.scene = scene;
    this.onChange = onChange;

    // Toggle button
    const toggleBtn = scene.add.text(toggleX, toggleY, '\ud83e\uddf9', {
      fontSize: '16px', fontFamily: 'monospace', color: '#888899',
      backgroundColor: '#2a2a4a', padding: { x: 6, y: 2 },
    }).setInteractive({ useHandCursor: true }).setDepth(15);

    toggleBtn.on('pointerdown', () => {
      this.visible = !this.visible;
      this.container.setVisible(this.visible);
      toggleBtn.setColor(this.visible ? '#ffffff' : '#888899');
      toggleBtn.setBackgroundColor(this.visible ? '#4a4a6a' : '#2a2a4a');
    });

    // Panel container
    this.container = scene.add.container(panelX, panelY).setDepth(18).setVisible(false);

    // Background
    const bg = scene.add.graphics();
    bg.fillStyle(0x1a1a3e, 0.95);
    bg.fillRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    bg.lineStyle(1, 0x4a4a6a, 1);
    bg.strokeRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    this.container.add(bg);

    this.container.add(scene.add.text(12, 10, 'HOUSEKEEPING', {
      fontSize: '13px', fontFamily: 'monospace', color: '#8888aa',
    }));

    // Turnover quality section
    this.container.add(scene.add.text(12, 36, 'Turnover cleaning:', {
      fontSize: '11px', fontFamily: 'monospace', color: '#aaaacc',
    }));

    const qualities: Array<{ key: CleaningQuality; label: string }> = [
      { key: 'quick', label: 'Quick' },
      { key: 'standard', label: 'Standard' },
      { key: 'thorough', label: 'Thorough' },
    ];

    qualities.forEach((q, i) => {
      const cost = HOUSEKEEPING.turnoverCost[q.key];
      const hours = HOUSEKEEPING.turnoverDuration[q.key];
      const result = HOUSEKEEPING.turnoverCleanlinessResult[q.key];
      const btn = scene.add.text(12 + i * 82, 56, q.label, {
        fontSize: '11px', fontFamily: 'monospace', color: '#888899',
        backgroundColor: '#2a2a4a', padding: { x: 6, y: 4 },
      }).setInteractive({ useHandCursor: true });

      btn.on('pointerdown', () => this.selectQuality(q.key));

      // Tooltip on hover
      const tooltip = `$${cost}/room, ${hours}h, ${result}% clean`;
      btn.on('pointerover', () => {
        this.costText.setText(tooltip);
      });
      btn.on('pointerout', () => {
        this.updateCostDisplay();
      });

      this.container.add(btn);
      this.qualityButtons.set(q.key, btn);
    });

    // Daily cadence section
    this.container.add(scene.add.text(12, 90, 'During-stay cleaning:', {
      fontSize: '11px', fontFamily: 'monospace', color: '#aaaacc',
    }));

    const cadences: Array<{ key: DailyCleaningCadence; label: string }> = [
      { key: 'daily', label: 'Daily' },
      { key: 'every_other_day', label: 'Every 2d' },
      { key: 'none', label: 'None' },
    ];

    cadences.forEach((c, i) => {
      const btn = scene.add.text(12 + i * 82, 110, c.label, {
        fontSize: '11px', fontFamily: 'monospace', color: '#888899',
        backgroundColor: '#2a2a4a', padding: { x: 6, y: 4 },
      }).setInteractive({ useHandCursor: true });

      btn.on('pointerdown', () => this.selectCadence(c.key));
      this.container.add(btn);
      this.cadenceButtons.set(c.key, btn);
    });

    // Cost display
    this.costText = scene.add.text(12, 145, '', {
      fontSize: '10px', fontFamily: 'monospace', color: '#888899',
    });
    this.container.add(this.costText);

    // Warning for star requirements
    this.warningText = scene.add.text(12, 170, '', {
      fontSize: '10px', fontFamily: 'monospace', color: '#e74c3c',
      wordWrap: { width: PANEL_W - 24 },
    });
    this.container.add(this.warningText);
  }

  show() { this.visible = true; this.container.setVisible(true); }
  hide() { this.visible = false; this.container.setVisible(false); }

  update(state: HotelState) {
    // Highlight active buttons
    for (const [key, btn] of this.qualityButtons) {
      const active = state.housekeeping.turnoverQuality === key;
      btn.setColor(active ? '#ffffff' : '#888899');
      btn.setBackgroundColor(active ? '#4a6a4a' : '#2a2a4a');
    }
    for (const [key, btn] of this.cadenceButtons) {
      const active = state.housekeeping.dailyCadence === key;
      btn.setColor(active ? '#ffffff' : '#888899');
      btn.setBackgroundColor(active ? '#4a6a4a' : '#2a2a4a');
    }

    // Check compliance warning
    const warning = checkHousekeepingCompliance(state);
    this.warningText.setText(warning ? `\u26a0 ${warning}` : '');

    if (this.visible) this.updateCostDisplay();
  }

  private updateCostDisplay() {
    this.costText.setText('Hover a quality option for details');
  }

  private selectQuality(quality: CleaningQuality) {
    const currentCadence = this.getCurrentCadence();
    this.onChange(quality, currentCadence);
  }

  private selectCadence(cadence: DailyCleaningCadence) {
    const currentQuality = this.getCurrentQuality();
    this.onChange(currentQuality, cadence);
  }

  private getCurrentQuality(): CleaningQuality {
    for (const [key, btn] of this.qualityButtons) {
      if (btn.style.backgroundColor === '#4a6a4a') return key as CleaningQuality;
    }
    return 'standard';
  }

  private getCurrentCadence(): DailyCleaningCadence {
    for (const [key, btn] of this.cadenceButtons) {
      if (btn.style.backgroundColor === '#4a6a4a') return key as DailyCleaningCadence;
    }
    return 'daily';
  }
}
