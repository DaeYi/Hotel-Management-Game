import type { Guest, RoomType } from './types.js';
import { ROOM_PREFERENCES, GUEST_PURPOSES, PARTIES } from '../config/balance.js';
import { FURNITURE } from '../config/furniture.js';
import { fitsParty, type RoomProfile } from './RoomProfile.js';
import { partyOf } from './Party.js';

// What guests like in a room (docs/designs/guest-preferences.md). A room's
// features are read off its furniture; each guest likes (or dislikes) some of
// them by who they are -- their purpose, their party, their trait
// (ROOM_PREFERENCES). The sum, capped, is their room fit: a term in their
// review and in how their mood drifts over the stay. It never decides which
// room they book. Mostly likes: a plain room is fine, a room furnished for
// the guest is better; the one dislike is a couple given separate beds.

export type RoomFeature = 'desk' | 'tub' | 'kingBed' | 'separateBeds' | 'sofaBed' | 'lounge' | 'art' | 'deluxe';

/** A feature, as a guest would say it: "the desk", "separate beds". */
export const FEATURE_LABELS: Record<RoomFeature, string> = {
  desk: 'the desk', tub: 'the bathtub', kingBed: 'the king bed', separateBeds: 'separate beds',
  sofaBed: 'the sofa bed', lounge: 'the sofa', art: 'the artwork', deluxe: 'the deluxe room',
};

type FeatureProfile = Pick<RoomProfile, 'items' | 'type' | 'sleeps'>;

/** What a room has that guests care about, from its furniture. */
export function roomFeatures(profile: FeatureProfile): Set<RoomFeature> {
  const has = (kind: string) => profile.items.some(i => i.kind === kind);
  const features = new Set<RoomFeature>();
  if (has('desk')) features.add('desk');
  if (has('bath_tub')) features.add('tub');
  if (has('bed_king')) features.add('kingBed');
  if (has('sofa_bed')) features.add('sofaBed');
  if (has('sofa')) features.add('lounge');
  if (has('art')) features.add('art');
  if (profile.type !== 'standard') features.add('deluxe');
  // It sleeps two or more, but has nowhere for two to share
  if (profile.sleeps >= 2 && !profile.items.some(i => FURNITURE[i.kind].shared)) features.add('separateBeds');
  return features;
}

/** Whether a preference rule is about this guest: their purpose, their party, or their trait. */
function isAbout(who: string, guest: Pick<Guest, 'purpose' | 'party' | 'trait'>): boolean {
  return who === guest.purpose || who === partyOf(guest).kind || who === guest.trait;
}

export interface RoomFit {
  score: number; // -maxFit to +maxFit: added to the review, and (x10) to the mood the stay drifts toward
  likes: RoomFeature[];
  dislikes: RoomFeature[];
}

const NO_FIT: RoomFit = { score: 0, likes: [], dislikes: [] };

/** How well a room suits a guest: what they like and dislike in it, and what that adds up to. */
export function roomFit(profile: FeatureProfile, guest: Pick<Guest, 'purpose' | 'party' | 'trait'>): RoomFit {
  if (!ROOM_PREFERENCES.enabled) return NO_FIT;
  const features = roomFeatures(profile);
  let score = 0;
  const likes: RoomFeature[] = [];
  const dislikes: RoomFeature[] = [];
  for (const rule of ROOM_PREFERENCES.rules) {
    const feature = rule.feature as RoomFeature;
    if (!features.has(feature) || !isAbout(rule.who, guest)) continue;
    score += rule.weight;
    const list = rule.weight >= 0 ? likes : dislikes;
    if (!list.includes(feature)) list.push(feature);
  }
  const max = ROOM_PREFERENCES.maxFit;
  return { score: Math.max(-max, Math.min(max, score)), likes, dislikes };
}

type StandIn = Pick<Guest, 'purpose' | 'party' | 'trait'> & { party: NonNullable<Guest['party']> };

/** Kinds of guest a room can suit, each as a typical booking of that kind (the room has to fit it). */
const GROUPS: Array<{ who: string; label: string; guest: StandIn; needs: 'purposes' | 'parties' | 'either' | null }> = [
  { who: 'business', label: 'business travellers', guest: { purpose: 'business', party: { kind: 'business', size: 1 }, trait: 'normal' }, needs: 'either' },
  { who: 'couple', label: 'couples', guest: { party: { kind: 'couple', size: 2 }, trait: 'normal' }, needs: 'parties' },
  { who: 'family', label: 'families', guest: { party: { kind: 'family', size: 3 }, trait: 'normal' }, needs: 'parties' },
  { who: 'friends', label: 'friends', guest: { party: { kind: 'friends', size: 2 }, trait: 'normal' }, needs: 'parties' },
  // Most guests on a getaway are couples
  { who: 'getaway', label: 'getaways', guest: { purpose: 'getaway', party: { kind: 'couple', size: 2 }, trait: 'normal' }, needs: 'purposes' },
  { who: 'big_spender', label: 'big spenders', guest: { party: { kind: 'solo', size: 1 }, trait: 'big_spender' }, needs: null },
];

/** Whether anyone of a kind can book, with purposes or parties switched off. */
function canBook(needs: (typeof GROUPS)[number]['needs']): boolean {
  if (needs === 'purposes') return GUEST_PURPOSES.enabled;
  if (needs === 'parties') return PARTIES.enabled;
  if (needs === 'either') return GUEST_PURPOSES.enabled || PARTIES.enabled;
  return true;
}

/**
 * Who a room suits, and who it doesn't: the kinds of guest it fits who'd
 * like something in it ("business travellers": the desk), and who'd dislike
 * something ("couples": separate beds).
 */
export function whoSuits(profile: FeatureProfile & Pick<RoomProfile, 'beds'>): { goodFor: string[]; notFor: Array<{ label: string; because: string }> } {
  const goodFor: string[] = [];
  const notFor: Array<{ label: string; because: string }> = [];
  if (!ROOM_PREFERENCES.enabled) return { goodFor, notFor };
  const features = roomFeatures(profile);
  for (const group of GROUPS) {
    if (!canBook(group.needs) || !fitsParty(profile, group.guest.party)) continue;
    // Good for them if a typical booking of theirs would like it overall, as their review would have it
    if (roomFit(profile, group.guest).score > 0) { goodFor.push(group.label); continue; }
    // Not for them if something about them is a dislike (one line per thing, not one per kind of guest who shares it)
    const disliked = ROOM_PREFERENCES.rules.filter(r => r.who === group.who && r.weight < 0 && features.has(r.feature as RoomFeature));
    if (disliked.length > 0) notFor.push({ label: group.label, because: listFeatures(disliked.map(r => r.feature as RoomFeature)) });
  }
  return { goodFor, notFor };
}

/** Features in words: "the king bed and the bathtub" (a suite's grade is "the suite"). */
export function listFeatures(features: RoomFeature[], type?: RoomType): string {
  const labels = features.map(f => (f === 'deluxe' && type === 'suite' ? 'the suite' : FEATURE_LABELS[f]));
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
