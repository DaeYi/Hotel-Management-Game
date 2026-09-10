import Phaser from 'phaser';
import type { HotelState } from '../simulation/types';
import { groupByChain } from '../simulation/StoryGenerator';

// Toggle panel matching the existing Finance/Staff family (design-review D6):
// "persistent" means retained history across opens/closes, not always-on-screen.
// Design tokens (design-review D5, verified in FacilityInspector.ts): panel fill
// #1a1a3e/95%, border #6a6a8a, monospace, #ffffff primary / #888899 secondary /
// #aaaacc body text.
const PANEL_W = 280;
const PANEL_H = 360;
const CONTENT_TOP = 34;
const MAX_CHAIN_BLOCKS = 8; // pool size -- no scroll this pass (design-review D12)
const BLOCK_LINE_HEIGHT = 14;

export class StoryLogPanel {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private emptyText: Phaser.GameObjects.Text;
  private chainTexts: Phaser.GameObjects.Text[] = [];
  private visible = false;

  constructor(scene: Phaser.Scene, panelX: number, panelY: number) {
    this.scene = scene;

    this.container = scene.add.container(panelX, panelY).setDepth(18).setVisible(false);

    const bg = scene.add.graphics();
    bg.fillStyle(0x1a1a3e, 0.95);
    bg.fillRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    bg.lineStyle(1, 0x6a6a8a, 1);
    bg.strokeRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    this.container.add(bg);

    this.container.add(scene.add.text(12, 10, 'STORY LOG', {
      fontSize: '13px', fontFamily: 'monospace', color: '#8888aa',
    }));

    const closeBtn = scene.add.text(PANEL_W - 28, 8, '✕', {
      fontSize: '16px', fontFamily: 'monospace', color: '#888899',
    });
    closeBtn.setInteractive({ useHandCursor: true });
    closeBtn.on('pointerdown', () => this.hide());
    closeBtn.on('pointerover', () => closeBtn.setColor('#ffffff'));
    closeBtn.on('pointerout', () => closeBtn.setColor('#888899'));
    this.container.add(closeBtn);

    // Warm empty state (design-review D2), not a blank box or generic "No entries."
    this.emptyText = scene.add.text(12, CONTENT_TOP + 8, "Nothing's happened yet -- check back once guests settle in.", {
      fontSize: '11px', fontFamily: 'monospace', color: '#888899',
      wordWrap: { width: PANEL_W - 24 }, lineSpacing: 4,
    });
    this.container.add(this.emptyText);

    for (let i = 0; i < MAX_CHAIN_BLOCKS; i++) {
      const text = scene.add.text(12, 0, '', {
        fontSize: '11px', fontFamily: 'monospace', color: '#aaaacc', lineSpacing: 3,
        wordWrap: { width: PANEL_W - 24 },
      }).setVisible(false);
      this.container.add(text);
      this.chainTexts.push(text);
    }
  }

  show() { this.visible = true; this.container.setVisible(true); }
  hide() { this.visible = false; this.container.setVisible(false); }
  isVisible(): boolean { return this.visible; }

  update(state: HotelState) {
    if (!this.visible) return;

    const chains = groupByChain(state.storyLog); // already newest-first (D11)
    this.emptyText.setVisible(chains.length === 0);

    let y = CONTENT_TOP;
    const maxY = PANEL_H - 12;
    let shown = 0;

    for (const chain of chains) {
      if (shown >= MAX_CHAIN_BLOCKS) break;

      const lines: string[] = [];
      const origin = chain.entries[0];
      lines.push(this.formatTimestamp(origin), origin.message);
      for (const cont of chain.entries.slice(1)) {
        lines.push(`  > ${this.formatTimestamp(cont)} - ${cont.message}`);
      }

      const blockHeight = lines.length * BLOCK_LINE_HEIGHT + 6;
      if (y + blockHeight > maxY && shown > 0) break; // stop once it no longer fits (D12)

      const text = this.chainTexts[shown];
      text.setText(lines.join('\n'));
      text.setPosition(12, y);
      text.setVisible(true);
      y += blockHeight;
      shown++;
    }

    for (let i = shown; i < MAX_CHAIN_BLOCKS; i++) {
      this.chainTexts[i].setVisible(false);
    }
  }

  private formatTimestamp(entry: { day: number; hour: number }): string {
    const period = entry.hour < 12 ? 'am' : 'pm';
    const displayHour = entry.hour % 12 === 0 ? 12 : entry.hour % 12;
    return `Day ${entry.day}, ${displayHour}${period}`;
  }
}
