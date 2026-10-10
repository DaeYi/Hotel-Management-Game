import Phaser from 'phaser';

const STEPS = [
  {
    title: 'Step 1: Build Rooms',
    text: 'Click a room type in the BUILD panel on the right,\nthen click on the grid to place it.',
  },
  {
    title: 'Step 2: Guests Arrive',
    text: 'Guests check in between 2 PM and 10 PM.\nThey pay per night and rate your hotel on checkout.',
  },
  {
    title: 'Step 3: Manage Your Rating',
    text: 'Keep ratings high to attract more guests.\nClick rooms to adjust pricing. Watch for noise\nwhen occupancy gets above 65%.',
  },
];

const STORAGE_KEY = 'hotel-game-tutorial-seen';

export class Tutorial {
  private scene: Phaser.Scene;
  private overlay!: Phaser.GameObjects.Rectangle;
  private container!: Phaser.GameObjects.Container;
  private stepIndex = 0;
  private titleText!: Phaser.GameObjects.Text;
  private bodyText!: Phaser.GameObjects.Text;
  private stepIndicator!: Phaser.GameObjects.Text;
  private nextBtn!: Phaser.GameObjects.Text;
  private onComplete: () => void;

  constructor(scene: Phaser.Scene, onComplete: () => void) {
    this.scene = scene;
    this.onComplete = onComplete;

    // Check if already seen
    if (localStorage.getItem(STORAGE_KEY)) {
      onComplete();
      return;
    }

    // Dark overlay
    this.overlay = scene.add.rectangle(480, 320, 960, 640, 0x000000, 0.6).setDepth(50);

    // Dialog
    this.container = scene.add.container(280, 200).setDepth(51);

    const bg = scene.add.graphics();
    bg.fillStyle(0x1a1a3e, 0.98);
    bg.fillRoundedRect(0, 0, 400, 220, 12);
    bg.lineStyle(2, 0x4a90d9, 0.8);
    bg.strokeRoundedRect(0, 0, 400, 220, 12);
    this.container.add(bg);

    this.titleText = scene.add.text(24, 20, '', {
      fontSize: '18px', fontFamily: 'monospace', color: '#4a90d9',
    });
    this.container.add(this.titleText);

    this.bodyText = scene.add.text(24, 56, '', {
      fontSize: '14px', fontFamily: 'monospace', color: '#ccccdd', lineSpacing: 6,
    });
    this.container.add(this.bodyText);

    this.stepIndicator = scene.add.text(24, 185, '', {
      fontSize: '11px', fontFamily: 'monospace', color: '#666688',
    });
    this.container.add(this.stepIndicator);

    this.nextBtn = scene.add.text(310, 175, 'Next \u25b6', {
      fontSize: '15px', fontFamily: 'monospace', color: '#4a90d9',
      backgroundColor: '#2a2a5e',
      padding: { x: 12, y: 6 },
    }).setInteractive({ useHandCursor: true });
    this.nextBtn.on('pointerdown', () => this.advance());
    this.nextBtn.on('pointerover', () => this.nextBtn.setColor('#ffffff'));
    this.nextBtn.on('pointerout', () => this.nextBtn.setColor('#4a90d9'));
    this.container.add(this.nextBtn);

    this.showStep();
  }

  private showStep() {
    const step = STEPS[this.stepIndex];
    this.titleText.setText(step.title);
    this.bodyText.setText(step.text);
    this.stepIndicator.setText(`${this.stepIndex + 1} / ${STEPS.length}`);
    this.nextBtn.setText(this.stepIndex === STEPS.length - 1 ? "Let's go!" : 'Next \u25b6');
  }

  private advance() {
    this.stepIndex++;
    if (this.stepIndex >= STEPS.length) {
      this.close();
    } else {
      this.showStep();
    }
  }

  private close() {
    localStorage.setItem(STORAGE_KEY, '1');
    this.overlay?.destroy();
    this.container?.destroy();
    this.onComplete();
  }
}
