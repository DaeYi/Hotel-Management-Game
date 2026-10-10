import Phaser from 'phaser';
import type { HotelState } from '../simulation/types';
import { MARKETING } from '../config/balance';
import { getCampaignCost } from '../simulation/MarketingManager';
import { getExpectedArrivalsPerDay } from '../simulation/GuestManager';
import { getAverageOccupancy } from '../simulation/ObjectivesManager';

// Toggle panel in the Staff/Cleaning/Amenities family. Design tokens match
// GoalsPanel / StoryLogPanel (fill #1a1a3e/95%, border #4a4a6a for management).
const PANEL_W = 300;
const PANEL_H = 264;
const ROW_TOP = 88;
const ROW_H = 52;

export class MarketingPanel {
  private container: Phaser.GameObjects.Container;
  private statusText: Phaser.GameObjects.Text;
  private rows: Array<{ id: string; info: Phaser.GameObjects.Text; button: Phaser.GameObjects.Text }> = [];
  private visible = false;

  constructor(scene: Phaser.Scene, panelX: number, panelY: number, onLaunch: (campaignId: string) => void) {
    this.container = scene.add.container(panelX, panelY).setDepth(18).setVisible(false);

    const bg = scene.add.graphics();
    bg.fillStyle(0x1a1a3e, 0.95);
    bg.fillRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    bg.lineStyle(1, 0x4a4a6a, 1);
    bg.strokeRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    this.container.add(bg);

    this.container.add(scene.add.text(12, 10, 'MARKETING', {
      fontSize: '13px', fontFamily: 'monospace', color: '#8888aa',
    }));

    this.statusText = scene.add.text(12, 32, '', {
      fontSize: '11px', fontFamily: 'monospace', color: '#aaaacc', lineSpacing: 3,
    });
    this.container.add(this.statusText);

    Object.keys(MARKETING.campaigns).forEach((id, i) => {
      const y = ROW_TOP + i * ROW_H;
      const info = scene.add.text(12, y, '', {
        fontSize: '11px', fontFamily: 'monospace', color: '#ccccdd', lineSpacing: 3,
      });
      const button = scene.add.text(PANEL_W - 12, y + 4, 'Launch', {
        fontSize: '11px', fontFamily: 'monospace', color: '#4a90d9',
        backgroundColor: '#2a2a5e', padding: { x: 8, y: 4 },
      }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
      button.on('pointerdown', () => onLaunch(id));
      this.container.add([info, button]);
      this.rows.push({ id, info, button });
    });
  }

  show() { this.visible = true; this.container.setVisible(true); }
  hide() { this.visible = false; this.container.setVisible(false); }
  isVisible(): boolean { return this.visible; }

  update(state: HotelState) {
    if (!this.visible) return;

    const active = state.activeCampaign;
    const occupancy = Math.round(getAverageOccupancy(state, 7) * 100);
    const arrivals = getExpectedArrivalsPerDay(state).toFixed(1);
    const running = active
      ? `Running: ${MARKETING.campaigns[active.id]?.label} (${Math.ceil(active.hoursRemaining / 24)}d left)`
      : 'No campaign running';
    this.statusText.setText(`${running}\nExpected guests: ${arrivals}/day\n7-day occupancy: ${occupancy}%`);

    for (const row of this.rows) {
      const campaign = MARKETING.campaigns[row.id];
      const cost = getCampaignCost(state, row.id);
      row.info.setText(
        `${campaign.label}  $${cost.toLocaleString()}\n` +
        `+${Math.round((campaign.demandBoost - 1) * 100)}% guests for ${campaign.durationDays} days`
      );

      const enabled = !active && state.cash >= cost;
      row.button.setText(active?.id === row.id ? 'Running' : 'Launch');
      row.button.setColor(enabled ? '#4a90d9' : '#555566');
      if (enabled) row.button.setInteractive({ useHandCursor: true });
      else row.button.disableInteractive();
    }
  }
}
