import Phaser from 'phaser';

export interface ToolbarButton {
  id: string;
  label: string;
  group: 'management' | 'view' | 'game';
  toggle?: boolean; // true = stays active until clicked again
}

const BUTTON_STYLE = {
  fontSize: '12px',
  fontFamily: 'monospace',
  color: '#888899',
  backgroundColor: '#22223a',
  padding: { x: 8, y: 4 },
};

const GROUP_COLORS: Record<string, number> = {
  management: 0x4a6a4a,
  view: 0x4a4a6a,
  game: 0x6a4a4a,
};

export class Toolbar {
  private scene: Phaser.Scene;
  private buttons: Map<string, Phaser.GameObjects.Text> = new Map();
  private activePanel: string | null = null;
  private activeToggles: Set<string> = new Set();
  private onAction: (id: string, active: boolean) => void;
  private y: number;

  constructor(scene: Phaser.Scene, x: number, y: number, onAction: (id: string, active: boolean) => void) {
    this.scene = scene;
    this.y = y;
    this.onAction = onAction;

    // Background bar
    const bar = scene.add.graphics().setDepth(14);
    bar.fillStyle(0x16162e, 0.9);
    bar.fillRect(x, y, 960 - x * 2, 24);
    bar.lineStyle(1, 0x2a2a4a, 0.5);
    bar.lineBetween(x, y + 24, 960 - x, y + 24);

    let curX = x + 4;

    // Management group
    curX = this.addGroupLabel(curX, 'Management:', '#6a8a6a');
    curX = this.addButton(curX, { id: 'staff', label: '\ud83d\udd27 Staff', group: 'management' });
    curX = this.addButton(curX, { id: 'housekeeping', label: '\ud83e\uddf9 Cleaning', group: 'management' });
    curX = this.addButton(curX, { id: 'amenities', label: '\ud83d\udecf\ufe0f Amenities', group: 'management' });

    curX += 12; // gap between groups

    // View group
    curX = this.addGroupLabel(curX, 'View:', '#6a6a8a');
    curX = this.addButton(curX, { id: 'chart', label: '\ud83d\udcc8 Finance', group: 'view' });
    curX = this.addButton(curX, { id: 'storylog', label: '\ud83d\udcd6 Story', group: 'view' });
    curX = this.addButton(curX, { id: 'noise', label: '\ud83d\udd0a Noise', group: 'view', toggle: true });

    curX += 12;

    // Game group
    curX = this.addGroupLabel(curX, 'Speed:', '#8a6a6a');
    curX = this.addButton(curX, { id: 'pause', label: '\u23f8', group: 'game', toggle: true });
    curX = this.addButton(curX, { id: 'speed1', label: '1x', group: 'game' });
    curX = this.addButton(curX, { id: 'speed2', label: '2x', group: 'game' });
    curX = this.addButton(curX, { id: 'speed5', label: '5x', group: 'game' });

    curX += 12;
    this.addButton(curX, { id: 'newgame', label: 'New Game', group: 'game' });

    // Default: speed1 active
    this.setSpeedActive('speed1');
  }

  private addGroupLabel(x: number, text: string, color: string): number {
    const label = this.scene.add.text(x, this.y + 4, text, {
      fontSize: '10px', fontFamily: 'monospace', color,
    }).setDepth(15);
    return x + label.width + 4;
  }

  private addButton(x: number, config: ToolbarButton): number {
    const btn = this.scene.add.text(x, this.y + 2, config.label, {
      ...BUTTON_STYLE,
    }).setInteractive({ useHandCursor: true }).setDepth(15);

    btn.on('pointerdown', () => this.handleClick(config));
    btn.on('pointerover', () => {
      if (!this.isActive(config.id)) {
        btn.setColor('#ccccdd');
      }
    });
    btn.on('pointerout', () => {
      if (!this.isActive(config.id)) {
        btn.setColor('#888899');
      }
    });

    this.buttons.set(config.id, btn);
    return x + btn.width + 4;
  }

  private handleClick(config: ToolbarButton) {
    // Speed buttons are special: mutually exclusive within their set
    if (config.id.startsWith('speed')) {
      this.setSpeedActive(config.id);
      this.activeToggles.delete('pause');
      this.updateButton('pause', false);
      this.onAction(config.id, true);
      return;
    }

    if (config.id === 'pause') {
      const wasActive = this.activeToggles.has('pause');
      if (wasActive) {
        this.activeToggles.delete('pause');
      } else {
        this.activeToggles.add('pause');
      }
      this.updateButton('pause', !wasActive);
      this.onAction('pause', !wasActive);
      return;
    }

    if (config.id === 'newgame') {
      this.onAction('newgame', true);
      return;
    }

    // Toggle buttons (noise)
    if (config.toggle) {
      const wasActive = this.activeToggles.has(config.id);
      if (wasActive) {
        this.activeToggles.delete(config.id);
      } else {
        this.activeToggles.add(config.id);
      }
      this.updateButton(config.id, !wasActive);
      this.onAction(config.id, !wasActive);
      return;
    }

    // Panel buttons: only one panel open at a time
    if (config.group === 'management' || config.id === 'chart' || config.id === 'storylog') {
      if (this.activePanel === config.id) {
        // Close current panel
        this.activePanel = null;
        this.updateButton(config.id, false);
        this.onAction(config.id, false);
      } else {
        // Close previous panel, open new one
        if (this.activePanel) {
          this.updateButton(this.activePanel, false);
          this.onAction(this.activePanel, false);
        }
        this.activePanel = config.id;
        this.updateButton(config.id, true);
        this.onAction(config.id, true);
      }
      return;
    }
  }

  private isActive(id: string): boolean {
    return this.activePanel === id || this.activeToggles.has(id);
  }

  private setSpeedActive(activeId: string) {
    for (const id of ['speed1', 'speed2', 'speed5']) {
      this.updateButton(id, id === activeId);
    }
  }

  private updateButton(id: string, active: boolean) {
    const btn = this.buttons.get(id);
    if (!btn) return;
    btn.setColor(active ? '#ffffff' : '#888899');
    btn.setBackgroundColor(active ? '#4a4a6a' : '#22223a');
  }

  /** Clear the active-panel highlight when a panel is opened from outside the toolbar. */
  clearActivePanel() {
    if (this.activePanel) {
      this.updateButton(this.activePanel, false);
      this.activePanel = null;
    }
  }

  /** Programmatically set pause state (e.g., from tutorial) */
  setPaused(paused: boolean) {
    if (paused) {
      this.activeToggles.add('pause');
    } else {
      this.activeToggles.delete('pause');
    }
    this.updateButton('pause', paused);
  }
}
