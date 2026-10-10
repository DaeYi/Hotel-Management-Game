import Phaser from 'phaser';
import type { HotelState } from '../simulation/types';
import { OBJECTIVES, LOAN } from '../config/balance';
import { getNextLoanPaymentDay } from '../simulation/EconomyManager';
import { formatObjectiveProgress } from './ObjectiveTracker';

// Toggle panel in the Finance/Staff/Story family: owner goals plus the bank
// loan. Design tokens match StoryLogPanel (fill #1a1a3e/95%, border #6a6a8a).
const PANEL_W = 300;
const PANEL_H = 410;
const ROW_H = 30;
const LIST_TOP = 34;

const STATUS_COLORS = {
  completed: '#2ecc71',
  failed: '#e74c3c',
  current: '#ffffff',
  upcoming: '#666688',
};

export class GoalsPanel {
  private container: Phaser.GameObjects.Container;
  private rows: Phaser.GameObjects.Text[] = [];
  private loanText: Phaser.GameObjects.Text;
  private payStepBtn: Phaser.GameObjects.Text;
  private payOffBtn: Phaser.GameObjects.Text;
  private visible = false;

  constructor(scene: Phaser.Scene, panelX: number, panelY: number, onRepay: (amount: number) => void) {
    this.container = scene.add.container(panelX, panelY).setDepth(18).setVisible(false);

    const bg = scene.add.graphics();
    bg.fillStyle(0x1a1a3e, 0.95);
    bg.fillRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    bg.lineStyle(1, 0x6a6a8a, 1);
    bg.strokeRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    this.container.add(bg);

    this.container.add(scene.add.text(12, 10, "OWNER'S GOALS", {
      fontSize: '13px', fontFamily: 'monospace', color: '#8888aa',
    }));

    const closeBtn = scene.add.text(PANEL_W - 28, 8, '✕', {
      fontSize: '16px', fontFamily: 'monospace', color: '#888899',
    }).setInteractive({ useHandCursor: true });
    closeBtn.on('pointerdown', () => this.hide());
    closeBtn.on('pointerover', () => closeBtn.setColor('#ffffff'));
    closeBtn.on('pointerout', () => closeBtn.setColor('#888899'));
    this.container.add(closeBtn);

    for (let i = 0; i < OBJECTIVES.length; i++) {
      const row = scene.add.text(12, LIST_TOP + i * ROW_H, '', {
        fontSize: '11px', fontFamily: 'monospace', color: STATUS_COLORS.upcoming, lineSpacing: 2,
      });
      this.container.add(row);
      this.rows.push(row);
    }

    const loanTop = LIST_TOP + OBJECTIVES.length * ROW_H + 4;
    const divider = scene.add.graphics();
    divider.lineStyle(1, 0x3a3a5a, 0.8);
    divider.lineBetween(12, loanTop, PANEL_W - 12, loanTop);
    this.container.add(divider);

    this.container.add(scene.add.text(12, loanTop + 6, 'BANK LOAN', {
      fontSize: '11px', fontFamily: 'monospace', color: '#8888aa',
    }));

    this.loanText = scene.add.text(12, loanTop + 22, '', {
      fontSize: '11px', fontFamily: 'monospace', color: '#aaaacc', lineSpacing: 3,
    });
    this.container.add(this.loanText);

    const btnStyle = {
      fontSize: '11px', fontFamily: 'monospace', color: '#4a90d9',
      backgroundColor: '#2a2a5e', padding: { x: 8, y: 4 },
    };
    this.payStepBtn = scene.add.text(12, PANEL_H - 30, `Pay $${LOAN.earlyRepaymentStep.toLocaleString()}`, btnStyle)
      .setInteractive({ useHandCursor: true });
    this.payStepBtn.on('pointerdown', () => onRepay(LOAN.earlyRepaymentStep));
    this.container.add(this.payStepBtn);

    this.payOffBtn = scene.add.text(PANEL_W - 12, PANEL_H - 30, '', btnStyle)
      .setOrigin(1, 0)
      .setInteractive({ useHandCursor: true });
    this.payOffBtn.on('pointerdown', () => onRepay(Number.POSITIVE_INFINITY));
    this.container.add(this.payOffBtn);
  }

  show() { this.visible = true; this.container.setVisible(true); }
  hide() { this.visible = false; this.container.setVisible(false); }
  isVisible(): boolean { return this.visible; }

  update(state: HotelState) {
    if (!this.visible) return;

    OBJECTIVES.forEach((objective, i) => {
      const outcome = state.objectives.outcomes[i];
      const row = this.rows[i];
      if (outcome === 'completed') {
        row.setText(`✓ ${objective.title}  +$${objective.reward.toLocaleString()}\n  ${objective.description}`);
        row.setColor(STATUS_COLORS.completed);
      } else if (outcome === 'failed') {
        row.setText(`✗ ${objective.title}  missed (day ${objective.deadlineDay})\n  ${objective.description}`);
        row.setColor(STATUS_COLORS.failed);
      } else if (i === state.objectives.currentIndex) {
        row.setText(`▶ ${objective.title}  by day ${objective.deadlineDay}\n  ${formatObjectiveProgress(state, objective)}`);
        row.setColor(STATUS_COLORS.current);
      } else {
        row.setText(`· ${objective.title}  by day ${objective.deadlineDay}\n  ${objective.description}`);
        row.setColor(STATUS_COLORS.upcoming);
      }
    });

    const { loan } = state;
    if (loan.balance <= 0) {
      this.loanText.setText('Paid off. The hotel is all yours.');
      this.payStepBtn.setVisible(false);
      this.payOffBtn.setVisible(false);
      return;
    }

    const balance = Math.ceil(loan.balance);
    this.loanText.setText(
      `Owed: $${balance.toLocaleString()}  (${Math.round(LOAN.weeklyInterestRate * 100)}%/week interest)\n` +
      `$${loan.weeklyPayment.toLocaleString()} due on day ${getNextLoanPaymentDay(state.day)}`
    );

    this.payStepBtn.setVisible(true);
    this.payOffBtn.setVisible(true);
    this.payOffBtn.setText(`Pay off ($${balance.toLocaleString()})`);
    this.setEnabled(this.payStepBtn, state.cash >= Math.min(LOAN.earlyRepaymentStep, balance));
    this.setEnabled(this.payOffBtn, state.cash >= balance);
  }

  private setEnabled(btn: Phaser.GameObjects.Text, enabled: boolean) {
    btn.setColor(enabled ? '#4a90d9' : '#555566');
    if (enabled) btn.setInteractive({ useHandCursor: true });
    else btn.disableInteractive();
  }
}
