import Phaser from 'phaser';

const CHART_W = 300;
const CHART_H = 160;
const PADDING = 30;

export class FinanceChart {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private chartGraphics: Phaser.GameObjects.Graphics;
  private toggleBtn: Phaser.GameObjects.Text;
  private revLabel: Phaser.GameObjects.Text;
  private ratLabel: Phaser.GameObjects.Text;
  private noDataText: Phaser.GameObjects.Text;
  private visible = false;

  private revenueHistory: number[] = [];
  private ratingHistory: number[] = [];
  private maxDays = 30;

  constructor(scene: Phaser.Scene, toggleX: number, toggleY: number, chartX: number, chartY: number) {
    this.scene = scene;

    // Toggle button
    this.toggleBtn = scene.add.text(toggleX, toggleY, '\ud83d\udcc8', {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: '#888899',
      backgroundColor: '#2a2a4a',
      padding: { x: 6, y: 2 },
    }).setInteractive({ useHandCursor: true }).setDepth(15);

    this.toggleBtn.on('pointerdown', () => this.toggle());
    this.toggleBtn.on('pointerover', () => this.toggleBtn.setColor('#ffffff'));
    this.toggleBtn.on('pointerout', () => this.toggleBtn.setColor(this.visible ? '#ffffff' : '#888899'));

    // Chart container
    this.container = scene.add.container(chartX, chartY).setDepth(15).setVisible(false);

    // Background
    const bg = scene.add.graphics();
    bg.fillStyle(0x0a0a1e, 0.92);
    bg.fillRoundedRect(0, 0, CHART_W, CHART_H, 8);
    bg.lineStyle(1, 0x4a4a6a, 0.8);
    bg.strokeRoundedRect(0, 0, CHART_W, CHART_H, 8);
    this.container.add(bg);

    // Title
    this.container.add(scene.add.text(8, 6, 'Last 30 Days', {
      fontSize: '11px', fontFamily: 'monospace', color: '#888899',
    }));

    // Legend
    this.container.add(scene.add.text(CHART_W - 140, 6, '\u2588 Revenue  \u2588 Reviews', {
      fontSize: '10px', fontFamily: 'monospace', color: '#888899',
    }));
    // Color the legend squares
    const legendG = scene.add.graphics();
    legendG.fillStyle(0x2ecc71, 1);
    legendG.fillRect(CHART_W - 140, 8, 8, 8);
    legendG.fillStyle(0xf1c40f, 1);
    legendG.fillRect(CHART_W - 66, 8, 8, 8);
    this.container.add(legendG);

    // Chart drawing area
    this.chartGraphics = scene.add.graphics();
    this.container.add(this.chartGraphics);

    // Persistent axis labels (updated on redraw)
    this.revLabel = scene.add.text(4, 24, '', {
      fontSize: '9px', fontFamily: 'monospace', color: '#2ecc71',
    });
    this.container.add(this.revLabel);

    this.ratLabel = scene.add.text(CHART_W - 18, 24, '', {
      fontSize: '9px', fontFamily: 'monospace', color: '#f1c40f',
    });
    this.container.add(this.ratLabel);

    // No data message
    this.noDataText = scene.add.text(CHART_W / 2, CHART_H / 2, 'No data yet\nLet a few days pass...', {
      fontSize: '12px', fontFamily: 'monospace', color: '#666688', align: 'center',
    }).setOrigin(0.5);
    this.container.add(this.noDataText);
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  show() {
    this.visible = true;
    this.container.setVisible(true);
    this.toggleBtn.setColor('#ffffff');
    this.toggleBtn.setBackgroundColor('#4a4a6a');
    this.redraw();
  }

  hide() {
    this.visible = false;
    this.container.setVisible(false);
    this.toggleBtn.setColor('#888899');
    this.toggleBtn.setBackgroundColor('#2a2a4a');
  }

  recordDay(dailyRevenue: number, avgRating: number) {
    this.revenueHistory.push(dailyRevenue);
    this.ratingHistory.push(avgRating);

    if (this.revenueHistory.length > this.maxDays) {
      this.revenueHistory.shift();
      this.ratingHistory.shift();
    }

    if (this.visible) this.redraw();
  }

  private redraw() {
    this.chartGraphics.clear();

    if (this.revenueHistory.length < 2) {
      this.noDataText.setVisible(true);
      this.revLabel.setText('');
      this.ratLabel.setText('');
      return;
    }

    this.noDataText.setVisible(false);

    const plotX = PADDING;
    const plotY = 24;
    const plotW = CHART_W - PADDING * 2;
    const plotH = CHART_H - 40;

    // Grid lines
    this.chartGraphics.lineStyle(1, 0x2a2a4a, 0.5);
    for (let i = 0; i <= 4; i++) {
      const y = plotY + (plotH * i) / 4;
      this.chartGraphics.lineBetween(plotX, y, plotX + plotW, y);
    }

    // Revenue line (green, left Y axis)
    const maxRevenue = Math.max(...this.revenueHistory, 1);
    this.drawLine(
      this.revenueHistory,
      plotX, plotY, plotW, plotH,
      0, maxRevenue,
      0x2ecc71
    );

    // Review score line (yellow, right Y axis, scale 0-10)
    this.drawLine(
      this.ratingHistory,
      plotX, plotY, plotW, plotH,
      0, 10,
      0xf1c40f
    );

    // Update axis labels
    this.revLabel.setText(maxRevenue >= 1000 ? `$${(maxRevenue / 1000).toFixed(0)}k` : `$${maxRevenue.toFixed(0)}`);
    this.ratLabel.setText('10');
  }

  private drawLine(
    data: number[],
    plotX: number, plotY: number, plotW: number, plotH: number,
    minVal: number, maxVal: number,
    color: number
  ) {
    const range = maxVal - minVal || 1;
    const step = plotW / (this.maxDays - 1);

    this.chartGraphics.lineStyle(2, color, 0.8);
    this.chartGraphics.beginPath();

    const startIdx = this.maxDays - data.length;
    for (let i = 0; i < data.length; i++) {
      const x = plotX + (startIdx + i) * step;
      const normalized = (data[i] - minVal) / range;
      const y = plotY + plotH - normalized * plotH;

      if (i === 0) {
        this.chartGraphics.moveTo(x, y);
      } else {
        this.chartGraphics.lineTo(x, y);
      }
    }
    this.chartGraphics.strokePath();
  }
}
