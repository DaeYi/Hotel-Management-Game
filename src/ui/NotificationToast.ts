import Phaser from 'phaser';
import type { GameEvent } from '../simulation/types';

interface Toast {
  text: Phaser.GameObjects.Text;
  bg: Phaser.GameObjects.Graphics;
  life: number; // ms remaining
}

const TOAST_DURATION = 3000;
const TOAST_FADE = 500;
const TOAST_MAX = 4;
const TOAST_HEIGHT = 28;
const TOAST_MARGIN = 4;

const EVENT_COLORS: Record<string, string> = {
  guest_arrived: '#2ecc71',
  guest_departed: '#3498db',
  guest_turned_away: '#e67e22',
  guest_impatient: '#e67e22',
  review_score_changed: '#f1c40f',
  star_rating_changed: '#9b59b6',
  bankrupt: '#e74c3c',
  room_broken: '#e74c3c',
  room_cleaned: '#2ecc71',
  daily_cleaning: '#3498db',
  maintenance_repair: '#f39c12',
  season_changed: '#9b59b6',
};

export class NotificationToast {
  private scene: Phaser.Scene;
  private toasts: Toast[] = [];
  private x: number;
  private y: number;
  private eventBuffer: Map<string, { count: number; lastMessage: string }> = new Map();
  private bufferFlushTimer = 0;
  private readonly BUFFER_INTERVAL = 2000; // batch events over 2s

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.scene = scene;
    this.x = x;
    this.y = y;
  }

  /** Buffer events for batching (e.g., "3 guests turned away" instead of 3 separate toasts) */
  addEvents(events: GameEvent[]) {
    for (const event of events) {
      // Always show these immediately
      if (event.type === 'bankrupt' || event.type === 'room_broken' || event.type === 'star_rating_changed' || event.type === 'season_changed') {
        this.showToast(event.message, EVENT_COLORS[event.type] ?? '#ffffff');
        continue;
      }

      // Review score changes: show immediately
      if (event.type === 'review_score_changed') {
        this.showToast(event.message, EVENT_COLORS[event.type] ?? '#ffffff');
        continue;
      }

      // Batch arrivals, departures, turned away
      const key = event.type;
      const existing = this.eventBuffer.get(key);
      if (existing) {
        existing.count++;
        existing.lastMessage = event.message;
      } else {
        this.eventBuffer.set(key, { count: 1, lastMessage: event.message });
      }
    }
  }

  update(delta: number) {
    // Flush buffer periodically
    this.bufferFlushTimer += delta;
    if (this.bufferFlushTimer >= this.BUFFER_INTERVAL) {
      this.bufferFlushTimer = 0;
      this.flushBuffer();
    }

    // Update existing toasts
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const toast = this.toasts[i];
      toast.life -= delta;

      // Fade out
      if (toast.life < TOAST_FADE) {
        const alpha = Math.max(0, toast.life / TOAST_FADE);
        toast.text.setAlpha(alpha);
        toast.bg.setAlpha(alpha);
      }

      // Remove expired
      if (toast.life <= 0) {
        toast.text.destroy();
        toast.bg.destroy();
        this.toasts.splice(i, 1);
      }
    }

    // Reposition (slide up as toasts expire)
    this.toasts.forEach((toast, i) => {
      const targetY = this.y - (this.toasts.length - 1 - i) * (TOAST_HEIGHT + TOAST_MARGIN);
      toast.text.y += (targetY + 6 - toast.text.y) * 0.15;
      toast.bg.y = toast.text.y - 6;
    });
  }

  private flushBuffer() {
    for (const [type, data] of this.eventBuffer) {
      const color = EVENT_COLORS[type] ?? '#ffffff';
      if (data.count === 1) {
        this.showToast(data.lastMessage, color);
      } else {
        const label = type === 'guest_arrived' ? `${data.count} guests checked in`
          : type === 'guest_departed' ? `${data.count} guests checked out`
          : type === 'guest_turned_away' ? `${data.count} guests turned away`
          : `${data.count}x ${data.lastMessage}`;
        this.showToast(label, color);
      }
    }
    this.eventBuffer.clear();
  }

  private showToast(message: string, color: string) {
    // Remove oldest if at max
    while (this.toasts.length >= TOAST_MAX) {
      const old = this.toasts.shift()!;
      old.text.destroy();
      old.bg.destroy();
    }

    const y = this.y;

    const bg = this.scene.add.graphics().setDepth(25);
    bg.fillStyle(0x1a1a3e, 0.85);
    bg.fillRoundedRect(this.x, y, 280, TOAST_HEIGHT, 4);
    // Color accent bar on left
    const hexColor = parseInt(color.replace('#', ''), 16);
    bg.fillStyle(hexColor, 1);
    bg.fillRect(this.x, y, 3, TOAST_HEIGHT);

    const text = this.scene.add.text(this.x + 10, y + 6, message, {
      fontSize: '12px',
      fontFamily: 'monospace',
      color,
    }).setDepth(26);

    this.toasts.push({ text, bg, life: TOAST_DURATION });
  }
}
