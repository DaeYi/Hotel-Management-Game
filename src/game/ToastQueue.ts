import type { GameEvent } from '../simulation/types';

// Toast notifications for game events, independent of how they're drawn.
// Routine events (arrivals, checkouts, cleaning...) are batched over a couple
// of seconds into one toast ("3 guests checked in"); important ones show
// right away.

export interface Toast {
  id: number;
  message: string;
  color: string;
  expiresAt: number; // ms timestamp
}

export const TOAST_DURATION_MS = 3000;
const TOAST_MAX = 4;
const BATCH_INTERVAL_MS = 2000;

export const EVENT_COLORS: Record<string, string> = {
  guest_arrived: '#2ecc71',
  guest_returned: '#2ecc71',
  guest_departed: '#3498db',
  guest_walked_out: '#e67e22',
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
  noise_complaint_filed: '#e67e22',
  noise_complaint_escalated: '#e74c3c',
  mid_stay_breakdown_resolved: '#2ecc71',
  loan_payment: '#f39c12',
  loan_paid_off: '#2ecc71',
  objective_completed: '#2ecc71',
  objective_failed: '#e74c3c',
  build_unlocked: '#9b59b6',
  renovation_complete: '#2ecc71',
  campaign_ended: '#f39c12',
  floor_built: '#9b59b6',
};

/** Incident-related event types (design-review D13): suppressed as toasts while
 * the Story Log panel is open, since the player is already looking at them there. */
export const INCIDENT_EVENT_TYPES = new Set([
  'guest_returned', 'guest_walked_out', 'noise_complaint_filed',
  'noise_complaint_escalated', 'mid_stay_breakdown_resolved',
]);

/** Shown immediately rather than batched. */
const IMMEDIATE_EVENT_TYPES = new Set([
  'bankrupt', 'room_broken', 'star_rating_changed', 'season_changed', 'review_score_changed',
  'loan_payment', 'loan_paid_off', 'objective_completed', 'objective_failed', 'build_unlocked',
  'campaign_ended', 'floor_built', ...INCIDENT_EVENT_TYPES,
]);

export class ToastQueue {
  toasts: Toast[] = [];
  private nextId = 1;
  private buffer = new Map<string, { count: number; lastMessage: string }>();
  private lastFlush = 0;

  /** Queue toasts for a batch of events. `storyLogOpen` suppresses incident toasts. */
  add(events: GameEvent[], now: number, storyLogOpen = false) {
    for (const event of events) {
      if (storyLogOpen && INCIDENT_EVENT_TYPES.has(event.type)) continue;

      if (event.type === 'loan_payment' && event.data?.missed) {
        this.show(event.message, '#e74c3c', now);
      } else if (IMMEDIATE_EVENT_TYPES.has(event.type)) {
        this.show(event.message, EVENT_COLORS[event.type] ?? '#ffffff', now);
      } else {
        const existing = this.buffer.get(event.type);
        if (existing) {
          existing.count++;
          existing.lastMessage = event.message;
        } else {
          this.buffer.set(event.type, { count: 1, lastMessage: event.message });
        }
      }
    }
  }

  /** Flush batched events periodically and drop expired toasts. Returns true if anything changed. */
  update(now: number): boolean {
    let changed = false;
    if (now - this.lastFlush >= BATCH_INTERVAL_MS) {
      this.lastFlush = now;
      if (this.buffer.size > 0) {
        for (const [type, data] of this.buffer) {
          this.show(data.count === 1 ? data.lastMessage : batchLabel(type, data.count, data.lastMessage), EVENT_COLORS[type] ?? '#ffffff', now);
        }
        this.buffer.clear();
        changed = true;
      }
    }
    const before = this.toasts.length;
    this.toasts = this.toasts.filter(t => t.expiresAt > now);
    return changed || this.toasts.length !== before;
  }

  private show(message: string, color: string, now: number) {
    this.toasts = [...this.toasts, { id: this.nextId++, message, color, expiresAt: now + TOAST_DURATION_MS }].slice(-TOAST_MAX);
  }
}

function batchLabel(type: string, count: number, lastMessage: string): string {
  if (type === 'guest_arrived') return `${count} guests checked in`;
  if (type === 'guest_departed') return `${count} guests checked out`;
  if (type === 'guest_turned_away') return `${count} guests turned away`;
  return `${count}x ${lastMessage}`;
}
