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
  spotlight_announced: '#c39bd3',
  spotlight_arrived: '#c39bd3',
  spotlight_review: '#c39bd3',
  staff_notice: '#1abc9c',
  guest_returned: '#2ecc71',
  guest_departed: '#3498db',
  guest_walked_out: '#e67e22',
  guest_turned_away: '#e67e22',
  guest_impatient: '#e67e22',
  party_turned_away: '#e67e22',
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
  regular_lost: '#e67e22',
  visitors_asked_to_leave: '#3498db',
  dnd_rooms_left: '#3498db',
  guest_complained: '#e67e22',
};

/** Incident-related event types (design-review D13): suppressed as toasts while
 * the Story Log panel is open, since the player is already looking at them there. */
export const INCIDENT_EVENT_TYPES = new Set([
  'guest_returned', 'regular_lost', 'guest_walked_out', 'noise_complaint_filed',
  'noise_complaint_escalated', 'mid_stay_breakdown_resolved', 'visitors_asked_to_leave', 'guest_complained',
  'spotlight_announced', 'spotlight_arrived', 'spotlight_review', 'staff_notice',
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
  private buffer = new Map<string, { count: number; people: number; lastMessage: string }>();
  private lastFlush = 0;

  /** Queue toasts for a batch of events. `storyLogOpen` suppresses incident toasts. */
  add(events: GameEvent[], now: number, storyLogOpen = false) {
    for (const event of events) {
      if (storyLogOpen && INCIDENT_EVENT_TYPES.has(event.type) && !event.data?.unlogged) continue; // (in the open log already, unless it isn't logged)

      if (event.type === 'loan_payment' && event.data?.missed) {
        this.show(event.message, '#e74c3c', now);
      } else if (IMMEDIATE_EVENT_TYPES.has(event.type)) {
        this.show(event.message, EVENT_COLORS[event.type] ?? '#ffffff', now);
      } else {
        const existing = this.buffer.get(event.type);
        const people = typeof event.data?.size === 'number' ? event.data.size as number : 1;
        if (existing) {
          existing.count++;
          existing.people += people;
          existing.lastMessage = event.message;
        } else {
          this.buffer.set(event.type, { count: 1, people, lastMessage: event.message });
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
          this.show(data.count === 1 ? data.lastMessage : batchLabel(type, data.count, data.people, data.lastMessage), EVENT_COLORS[type] ?? '#ffffff', now);
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

/** A batch of the same event: counted in people (a family of four is four guests), as the status bar counts them. */
function batchLabel(type: string, count: number, people: number, lastMessage: string): string {
  if (type === 'guest_arrived') return `${people} guests arriving`;
  if (type === 'guest_departed') return `${people} guests checked out`;
  if (type === 'guest_turned_away') return `${people} guests turned away`;
  if (type === 'party_turned_away') return `${count} parties turned away: no room big enough`;
  if (type === 'guest_impatient') return `${people} guests gave up at the front desk`;
  return `${count}x ${lastMessage}`;
}
