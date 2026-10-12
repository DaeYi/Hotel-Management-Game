import type { Guest, Mood } from './types.js';
import { MOOD } from '../config/balance.js';

// How a guest feels right now (docs/designs/guest-staff-personalities.md,
// Status #14): worked out from their satisfaction whenever it's needed, never
// stored or rolled. An angry guest skips the facilities; a delighted one spends
// more at the shop and is likelier to come back (Loyalty.ts); an irritated or
// angry one shows a face on the floor plan. With mood off, everyone's content.

/** How a guest with this satisfaction feels. */
export function moodOf(satisfaction: number): Mood {
  if (!MOOD.enabled) return 'content';
  if (satisfaction < MOOD.angry) return 'angry';
  if (satisfaction < MOOD.irritated) return 'irritated';
  if (satisfaction >= MOOD.delighted) return 'delighted';
  return 'content';
}

/** How a guest feels right now. */
export function guestMood(guest: Pick<Guest, 'satisfaction'>): Mood {
  return moodOf(guest.satisfaction);
}

/** The face a guest shows on the floor plan: only when they're irritated or angry. */
export function moodFace(mood: Mood | undefined): 'irritated' | 'angry' | null {
  return mood === 'irritated' || mood === 'angry' ? mood : null;
}
