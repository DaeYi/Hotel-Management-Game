import Phaser from 'phaser';
import { deleteSave } from '../simulation/SaveManager';

/**
 * Bankruptcy screen — game over overlay with restart button.
 */
export class BankruptcyOverlay {
  private container: Phaser.GameObjects.Container;

  constructor(scene: Phaser.Scene, finalDebt: number) {
    this.container = scene.add.container(0, 0).setDepth(100);

    // Dark overlay
    const bg = scene.add.rectangle(480, 320, 960, 640, 0x000000, 0.75);
    this.container.add(bg);

    // Panel
    const panel = scene.add.graphics();
    panel.fillStyle(0x1a1a2e, 0.95);
    panel.fillRoundedRect(280, 180, 400, 260, 12);
    panel.lineStyle(2, 0xe74c3c, 0.8);
    panel.strokeRoundedRect(280, 180, 400, 260, 12);
    this.container.add(panel);

    this.container.add(scene.add.text(480, 210, 'BANKRUPT', {
      fontSize: '28px', fontFamily: 'monospace', color: '#e74c3c',
    }).setOrigin(0.5));

    this.container.add(scene.add.text(480, 260, `Your hotel went under with\n$${Math.abs(Math.floor(finalDebt)).toLocaleString()} in debt.`, {
      fontSize: '14px', fontFamily: 'monospace', color: '#ccccdd',
      align: 'center', lineSpacing: 6,
    }).setOrigin(0.5));

    this.container.add(scene.add.text(480, 320, 'The guests have checked out.\nThe lights are off.', {
      fontSize: '12px', fontFamily: 'monospace', color: '#888899',
      align: 'center', lineSpacing: 4,
    }).setOrigin(0.5));

    // Restart button
    const restartBtn = scene.add.text(480, 390, 'Try Again', {
      fontSize: '16px', fontFamily: 'monospace', color: '#4a90d9',
      backgroundColor: '#2a2a5e',
      padding: { x: 24, y: 10 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    restartBtn.on('pointerdown', () => {
      deleteSave();
      localStorage.removeItem('hotel-game-tutorial-seen');
      window.location.reload();
    });
    restartBtn.on('pointerover', () => restartBtn.setColor('#ffffff'));
    restartBtn.on('pointerout', () => restartBtn.setColor('#4a90d9'));
    this.container.add(restartBtn);
  }
}

/**
 * "No Vacancy" indicator shown when all rooms are occupied.
 */
export class NoVacancySign {
  private text: Phaser.GameObjects.Text;
  private bg: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.bg = scene.add.graphics().setDepth(8);
    this.text = scene.add.text(x, y, 'NO VACANCY', {
      fontSize: '13px', fontFamily: 'monospace', color: '#e74c3c',
      fontStyle: 'bold',
    }).setDepth(8).setOrigin(0.5).setVisible(false);
  }

  update(totalRooms: number, occupiedRooms: number) {
    const show = totalRooms > 0 && occupiedRooms >= totalRooms;
    this.text.setVisible(show);

    if (show) {
      this.bg.clear();
      const bounds = this.text.getBounds();
      this.bg.fillStyle(0x1a1a2e, 0.85);
      this.bg.fillRoundedRect(bounds.x - 8, bounds.y - 4, bounds.width + 16, bounds.height + 8, 4);
      this.bg.lineStyle(1, 0xe74c3c, 0.6);
      this.bg.strokeRoundedRect(bounds.x - 8, bounds.y - 4, bounds.width + 16, bounds.height + 8, 4);
    } else {
      this.bg.clear();
    }
  }
}

/**
 * Prompt shown when player has zero rooms.
 */
export class ZeroRoomsPrompt {
  private container: Phaser.GameObjects.Container;
  private dismissed = false;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.container = scene.add.container(x, y).setDepth(8);

    const bg = scene.add.graphics();
    bg.fillStyle(0x1a1a3e, 0.9);
    bg.fillRoundedRect(-140, -30, 280, 60, 8);
    bg.lineStyle(1, 0x4a90d9, 0.6);
    bg.strokeRoundedRect(-140, -30, 280, 60, 8);
    this.container.add(bg);

    this.container.add(scene.add.text(0, -12, '\u2190 Select a room type to build', {
      fontSize: '13px', fontFamily: 'monospace', color: '#4a90d9',
    }).setOrigin(0.5));

    this.container.add(scene.add.text(0, 10, 'then click on the grid to place it', {
      fontSize: '11px', fontFamily: 'monospace', color: '#888899',
    }).setOrigin(0.5));
  }

  update(roomCount: number) {
    if (this.dismissed) return;
    if (roomCount > 0) {
      this.dismissed = true;
      this.container.setVisible(false);
    }
  }
}
