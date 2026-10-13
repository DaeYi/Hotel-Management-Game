import type { Guest, Voice } from './types.js';
import { VOICE, GUEST_PROFILE, SATISFACTION } from '../config/balance.js';

// Voice (docs/designs/guest-staff-personalities.md, Temperament #8): the
// questions the rest of the game asks about how a guest complains. Complaints.ts
// sends them to the front desk; the night's complaints (StoryGenerator,
// HostedNights) and the reviews ask here who may complain, and how hard they judge.

/** Whether Voice is on (it needs guest profiles: voice lives there). */
export function voiceOn(): boolean {
  return VOICE.enabled && GUEST_PROFILE.enabled;
}

/** How a guest complains (typical without a roll, or with the switch off). */
export function voiceOf(guest: { profile?: { voice?: Voice } }): Voice {
  return voiceOn() ? guest.profile?.voice ?? 'typical' : 'typical';
}

/** The mood below which a guest complains (null: they never do); with Voice off, the old incident threshold. */
export function complainsBelow(guest: { profile?: { voice?: Voice } }): number | null {
  if (!voiceOn()) return SATISFACTION.incidentFuelThreshold;
  const voice = voiceOf(guest);
  return voice === 'stoic' ? null : VOICE.complainBelow[voice];
}

/**
 * Whether a guest has complained already this stay (one a stay, whatever
 * about), or is on their way down to: a trip to the desk cut short before the
 * counter (no clerk left there) doesn't count.
 */
export function hasComplained(guest: Pick<Guest, 'hadNoiseComplaint' | 'complaint' | 'trip'>): boolean {
  if (guest.hadNoiseComplaint) return true;
  if (!guest.complaint) return false;
  return guest.complaint.at !== undefined || (guest.trip ?? []).some(l => l.kind === 'stay' && l.activity === 'complain' && !l.credited);
}

/** Whether a stoic guest's mood is hidden from the player (until they check out). */
export function moodHidden(guest: { profile?: { voice?: Voice } }): boolean {
  return voiceOn() && voiceOf(guest) === 'stoic';
}

