import Phaser from 'phaser';
import type { HotelState } from '../simulation/types';
import type { ObjectiveConfig } from '../config/balance';
import { evaluateObjective, getCurrentObjective } from '../simulation/ObjectivesManager';

// Always-on goal tracker in the top-right corner. Unlike the toggle panels,
// the current goal and its deadline are always visible -- clicking it opens
// the full Goals panel. Same design tokens as the other panels.
const WIDTH = 330;
const BAR_W = 90;
const URGENT_DAYS = 5;

/** Human-readable "current / target" for an objective, shared with GoalsPanel. */
export function formatObjectiveProgress(state: HotelState, objective: ObjectiveConfig): string {
  const { current, target } = evaluateObjective(state, objective);
  switch (objective.kind) {
    case 'room_count': return `${current} / ${target} rooms`;
    case 'occupancy_7d': return `${Math.round(current * 100)}% / ${Math.round(target * 100)}% (7-day)`;
    case 'review_score': return `${current.toFixed(1)} / ${target.toFixed(1)} review`;
    case 'star_rating': return `${current}★ / ${target}★`;
    case 'revenue_30d': return `$${Math.round(current).toLocaleString()} / $${target.toLocaleString()}`;
    case 'loan_paid_off': return `$${Math.round(current).toLocaleString()} owed`;
    case 'valuation': return `${formatMoneyShort(current)} / ${formatMoneyShort(target)} value`;
    case 'five_star_days': return `${current} / ${target} days at 5★`;
    case 'occupancy_30d': return `${Math.round(current * 100)}% / ${Math.round(target * 100)}% (30-day)`;
  }
}

/** Compact money for tight spaces: $950k, $1.25M. */
export function formatMoneyShort(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n).toLocaleString()}`;
}

export class ObjectiveTracker {
  private titleText: Phaser.GameObjects.Text;
  private detailText: Phaser.GameObjects.Text;
  private bar: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, right: number, topY: number, onClick: () => void) {
    this.titleText = scene.add.text(right - BAR_W - 8, topY, '', {
      fontSize: '13px', fontFamily: 'monospace', color: '#ffffff',
    }).setOrigin(1, 0);

    this.bar = scene.add.graphics();
    this.bar.setPosition(right - BAR_W, topY + 4);

    this.detailText = scene.add.text(right, topY + 22, '', {
      fontSize: '11px', fontFamily: 'monospace', color: '#888899',
    }).setOrigin(1, 0);

    // One hit area over both lines so the whole tracker opens the Goals panel
    const hit = scene.add.rectangle(right - WIDTH / 2, topY + 18, WIDTH, 36)
      .setAlpha(0.01)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', onClick);
    hit.on('pointerover', () => this.titleText.setColor('#4a90d9'));
    hit.on('pointerout', () => this.titleText.setColor('#ffffff'));
  }

  update(state: HotelState) {
    const objective = getCurrentObjective(state);
    const status = evaluateObjective(state, objective);

    // Owner goals have a deadline and reward; legacy goals have neither
    const daysLeft = objective.deadlineDay === null ? null : objective.deadlineDay - state.day;
    const urgent = daysLeft !== null && daysLeft <= URGENT_DAYS;
    const parts = [formatObjectiveProgress(state, objective)];
    if (daysLeft !== null) parts.push(daysLeft <= 0 ? 'last day' : `${daysLeft}d left`);
    if (objective.reward > 0) parts.push(`+$${objective.reward.toLocaleString()}`);

    this.titleText.setText(`${daysLeft === null ? '🏆' : '🎯'} ${objective.title}`);
    this.detailText.setText(parts.join('  |  '));
    this.detailText.setColor(urgent ? '#e74c3c' : '#888899');
    this.drawBar(status.fraction, status.complete ? 0x2ecc71 : urgent ? 0xe74c3c : 0x4a90d9);
  }

  private drawBar(fraction: number, color: number) {
    this.bar.clear();
    this.bar.fillStyle(0x2a2a4a, 1);
    this.bar.fillRoundedRect(0, 0, BAR_W, 10, 4);
    if (fraction > 0) {
      this.bar.fillStyle(color, 1);
      this.bar.fillRoundedRect(0, 0, Math.max(8, BAR_W * fraction), 10, 4);
    }
  }
}
