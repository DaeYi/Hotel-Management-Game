import type { HotelState, Room, Guest, ActiveIncident, StoryLogEntry, GameEvent, Booking } from './types.js';
import { partyOf, partyLabel, PartyLabel } from './Party.js';
import { profileRoom, fitsParty } from './RoomProfile.js';
import { roomFit, FEATURE_LABELS, type RoomFeature } from './Preferences.js';
import type { PRNG } from './prng.js';
import type { GuestReviewBreakdown } from './GuestManager.js';
import { SATISFACTION, STORY, NOISE, ECONOMY, REVIEW, GUEST_PROFILE, LOYALTY, VOICE, SPENDING, FACILITY_LEVELS } from '../config/balance.js';
import { spendingOn } from './Spending.js';
import { calculateRoomNoise, noiseToRatingPenalty, getLoudestNeighborGuestId, nightNoiseThisHour } from './NoiseManager.js';
import { isAsleepAt, theVisitors } from './Visitors.js';
import { voiceOn, voiceOf, complainsBelow, hasComplained } from './Voice.js';
import type { Voice } from './types.js';
import { cleanlinessTerm } from './CleaningPreference.js';
import { personIdOf } from './Loyalty.js';
import { formatRoomLabel, isRoomReachable } from './HotelState.js';
import { roomMoveTrip, isGuestAway } from './GuestMovement.js';
import { isCheckoutDue } from './GuestManager.js';
import { hourEnd, hourStart, legsEnd } from './Movement.js';
import { spotlightOn, heldFrom } from './Spotlight.js';

// ============================================================================
// Story log: append + chain-aware cap/eviction (design-review D11).
// ============================================================================

export interface StoryLogChain {
  chainId: string;
  entries: StoryLogEntry[]; // chronological within the chain (oldest first)
  mostRecentAbsHour: number;
}

/** Group storyLog entries into chains, newest-first by each chain's most recent event. */
export function groupByChain(storyLog: StoryLogEntry[]): StoryLogChain[] {
  const map = new Map<string, StoryLogEntry[]>();
  for (const entry of storyLog) {
    const key = entry.chainId ?? entry.id;
    const arr = map.get(key) ?? [];
    arr.push(entry);
    map.set(key, arr);
  }
  const chains: StoryLogChain[] = [];
  for (const [chainId, entries] of map) {
    entries.sort((a, b) => (a.day * 24 + a.hour) - (b.day * 24 + b.hour));
    const mostRecentAbsHour = entries.reduce((max, e) => Math.max(max, e.day * 24 + e.hour), 0);
    chains.push({ chainId, entries, mostRecentAbsHour });
  }
  chains.sort((a, b) => b.mostRecentAbsHour - a.mostRecentAbsHour);
  return chains;
}

/** Cap-eviction operates on whole chains, never orphaning an escalation from its origin (D11). */
function pruneToMaxChains(storyLog: StoryLogEntry[], maxChains: number, pinned?: string): StoryLogEntry[] {
  const chains = groupByChain(storyLog);
  if (chains.length <= maxChains) return storyLog;
  if (pinned && chains.some(c => c.chainId === pinned)) {
    // A pinned chain stays, and the newest of the rest fill the other places
    const kept = new Set([pinned, ...chains.filter(c => c.chainId !== pinned).slice(0, maxChains - 1).map(c => c.chainId)]);
    return storyLog.filter(e => kept.has(e.chainId ?? e.id));
  }
  const keep = new Set(chains.slice(0, maxChains).map(c => c.chainId));
  return storyLog.filter(e => keep.has(e.chainId ?? e.id));
}

let logIdCounter = 0;
function nextLogId(state: HotelState): string {
  logIdCounter++;
  return `log-${state.day}-${state.hour}-${logIdCounter}`;
}

interface NewEntryInput {
  type: string;
  guestName?: string;
  roomId?: string;
  message: string;
  chainId?: string; // omit for a standalone entry or a new chain's origin (defaults to its own id)
}

export function appendStoryLogEntry(state: HotelState, input: NewEntryInput): { state: HotelState; entry: StoryLogEntry } {
  const id = nextLogId(state);
  const entry: StoryLogEntry = {
    id,
    day: state.day,
    hour: state.hour,
    type: input.type,
    guestName: input.guestName,
    roomId: input.roomId,
    message: input.message,
    chainId: input.chainId ?? id,
  };
  // (an announced or staying spotlight guest's story is kept whatever else happens)
  const pinned = spotlightOn() && state.spotlight && state.spotlight.status !== 'done' ? state.spotlight.chainId : undefined;
  const storyLog = pruneToMaxChains([...state.storyLog, entry], STORY.storyLogMaxChains, pinned);
  return { state: { ...state, storyLog }, entry };
}

const capitalizeFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ============================================================================
// Ambient satisfaction drift (D3).
// ============================================================================

function deriveSatisfactionTarget(room: Room, state: HotelState, guest: Guest): number {
  // Noise only bothers a guest who's in to hear it -- with profiles on, only while they're trying to sleep,
  // an hour of it weighed as a night of it would be in their review
  const noisePenalty = GUEST_PROFILE.enabled
    ? nightNoiseThisHour(room, state, guest) * GUEST_PROFILE.nightPenaltyPerUnit * GUEST_PROFILE.nightDriftWeight
    : isGuestAway(guest, hourStart(state) + 0.5) ? 0 : noiseToRatingPenalty(calculateRoomNoise(room, state), guest);
  const conditionBonus = (room.condition - REVIEW.conditionMidpoint) / REVIEW.conditionScale * REVIEW.conditionWeight;
  const cleanlinessBonus = cleanlinessTerm(room.cleanliness, guest);
  // What they like (or don't) about the room: the same as in their review
  const fit = roomFit(profileRoom(room), guest).score;
  const raw = conditionBonus + cleanlinessBonus - noisePenalty + fit;
  return Math.max(0, Math.min(100, SATISFACTION.initial + raw * 10));
}

/** Small per-tick nudge toward a stay-quality-derived target, independent of incidents. */
export function driftSatisfaction(state: HotelState): HotelState {
  const guests = state.guests.map(guest => {
    const room = state.rooms.find(r => r.status === 'occupied' && r.guestId === guest.id);
    if (!room) return guest;
    const target = deriveSatisfactionTarget(room, state, guest);
    const next = guest.satisfaction + (target - guest.satisfaction) * SATISFACTION.ambientDriftWeight;
    return { ...guest, satisfaction: Math.max(0, Math.min(100, next)) };
  });
  return { ...state, guests };
}

// ============================================================================
// Advance existing activeIncidents (resolve / escalate / room-move).
// ============================================================================

export interface AdvanceResult {
  state: HotelState;
  events: GameEvent[];
  earlyDepartureGuestIds: Set<string>;
}

/**
 * A room to move a guest to: the same kind of room as theirs, empty, working,
 * reachable, and big enough for their party. `rooms` is the rooms as they
 * stand after any moves made earlier this hour (so two guests are never moved
 * into the same one).
 */
function findHealthySameTypeRoom(state: HotelState, rooms: Room[], exclude: Room, guest: Guest): Room | null {
  const party = partyOf(guest);
  const held = heldFrom(state, guest.checkInDay + guest.stayLength - state.day); // (held for a spotlight guest, and they'd still be in it)
  // The smallest that fits, then the cheapest: a couple doesn't take the family room a family needs
  return rooms.filter(r =>
    r.id !== exclude.id
    && r.id !== held
    && r.type === exclude.type
    && r.status === 'vacant'
    && r.condition > ECONOMY.roomBreakdownThreshold
    && isRoomReachable(state, r)
    && fitsParty(profileRoom(r), party)
  ).sort((a, b) => profileRoom(a).sleeps - profileRoom(b).sleeps || profileRoom(a).beds - profileRoom(b).beds || a.pricePerNight - b.pricePerNight)[0] ?? null;
}

/**
 * Advance in-progress incidents at the end of the hour (time T, when a moved
 * guest sets off for their new room).
 */
export function advanceIncidents(state: HotelState, prng: PRNG, T = hourEnd(state)): AdvanceResult {
  const events: GameEvent[] = [];
  const earlyDepartureGuestIds = new Set<string>();
  let current = state;
  const remaining: ActiveIncident[] = [];
  let guests = [...current.guests];
  let rooms = [...current.rooms];

  for (const incident of current.activeIncidents) {
    const guest = guests.find(g => g.id === incident.guestId);
    const room = rooms.find(r => r.id === incident.roomId);

    // Teardown: guest already gone, or their own room vacated some other way.
    if (!guest || !room || room.guestId !== guest.id) {
      continue;
    }

    if (incident.type === 'noise_complaint') {
      // With profiles on, a complaint is about the night: while they're up (or out) it waits
      if (GUEST_PROFILE.enabled && (!isAsleepAt(current, guest, hourStart(current) + 0.5) || isGuestAway(guest, hourStart(current) + 0.5))) {
        remaining.push(incident);
        continue;
      }
      const roomNoise = calculateRoomNoise(room, current);
      if (roomNoise <= NOISE.penaltyThreshold) {
        // Resolved on its own: noise dropped below the threshold.
        guests = guests.map(g => g.id === guest.id
          ? { ...g, satisfaction: Math.min(100, g.satisfaction + SATISFACTION.noiseComplaintResolvedBonus) }
          : g);
        const roomLabel = formatRoomLabel(room.gridX, room.gridY, room.floor);
        // (about visitors: they've gone)
        const hostRoom = incident.about === 'visitors' ? rooms.find(r => r.guestId === incident.culpritGuestId) : undefined;
        const visitors = guests.find(g => g.id === incident.culpritGuestId)?.hostedNight?.visitors ?? 2;
        const appended = appendStoryLogEntry(current, {
          type: 'noise_complaint_resolved',
          guestName: partyLabel(guest),
          roomId: room.id,
          message: incident.about === 'visitors'
            ? `${capitalizeFirst(theVisitors(visitors))}${hostRoom ? ` in Room ${formatRoomLabel(hostRoom.gridX, hostRoom.gridY, hostRoom.floor)}` : ''} left, and ${partyLabel(guest)} got back to sleep.`
            : `The noise around Room ${roomLabel} died down -- ${partyLabel(guest)}'s complaint resolved.`,
          chainId: incident.chainId,
        });
        current = appended.state;
        continue;
      }

      const hoursRemaining = incident.hoursRemaining - 1;
      if (hoursRemaining <= 0) {
        earlyDepartureGuestIds.add(guest.id);
        const roomLabel = formatRoomLabel(room.gridX, room.gridY, room.floor);
        const appended = appendStoryLogEntry(current, {
          type: 'noise_complaint_escalated',
          guestName: partyLabel(guest),
          roomId: room.id,
          message: `Complaint unresolved -- ${partyLabel(guest)} is checking out early from Room ${roomLabel}.`,
          chainId: incident.chainId,
        });
        current = appended.state;
        events.push({
          type: 'noise_complaint_escalated',
          message: `${PartyLabel(guest)}'s noise complaint escalated -- checking out early`,
          data: { guestId: guest.id, roomId: room.id },
        });
        // Dropped: escalated incidents don't persist in activeIncidents; the
        // early-departure pathway (tick.ts) takes over from here.
        continue;
      }

      remaining.push({ ...incident, hoursRemaining });
      continue;
    }

    // mid_stay_breakdown
    // (down at the front desk complaining: the move waits till they're back)
    if (voiceOn() && guest.tripKind === 'complaint' && guest.trip && T < legsEnd(guest.trip) && room.condition <= ECONOMY.roomBreakdownThreshold && !isCheckoutDue(guest, current)) {
      remaining.push(incident);
      continue;
    }
    if (room.condition > ECONOMY.roomBreakdownThreshold || isCheckoutDue(guest, current)) {
      // Repaired before we had to act, or the guest is checking out now
      // anyway (no point moving them) -- drop quietly, no log spam.
      continue;
    }

    const target = findHealthySameTypeRoom(current, rooms, room, guest);
    if (target) {
      const oldRoomId = room.id;
      const oldLabel = formatRoomLabel(room.gridX, room.gridY, room.floor);
      const newLabel = formatRoomLabel(target.gridX, target.gridY, target.floor);
      rooms = rooms.map(r => {
        if (r.id === oldRoomId) return { ...r, status: 'vacant' as const, guestId: undefined };
        if (r.id === target.id) return { ...r, status: 'occupied' as const, guestId: guest.id };
        return r;
      });
      const trip = roomMoveTrip(current, guest, target, T);
      // (a celebrity moved down off the top floor pays the price from today: the double rate is for a top-floor suite)
      const offTop = (g0: Guest) => (g0.spotlight?.rate && g0.spotlight.until === undefined && target.floor < room.floor ? { spotlight: { ...g0.spotlight, until: current.day } } : {});
      guests = guests.map(g => g.id === guest.id
        ? { ...g, satisfaction: Math.min(100, g.satisfaction + SATISFACTION.midStayBreakdownMoveBonus), trip, tripKind: trip ? 'move' as const : undefined, ...offTop(g) }
        : g);
      const appended = appendStoryLogEntry(current, {
        type: 'mid_stay_breakdown_resolved',
        guestName: partyLabel(guest),
        roomId: target.id,
        message: `${PartyLabel(guest)} was moved to Room ${newLabel} after Room ${oldLabel} broke down.`,
        chainId: incident.chainId,
      });
      current = appended.state;
      events.push({
        type: 'mid_stay_breakdown_resolved',
        message: `${PartyLabel(guest)} moved to Room ${newLabel} after a breakdown`,
        data: { guestId: guest.id, fromRoomId: oldRoomId, toRoomId: target.id },
      });
      continue;
    }

    const hoursRemaining = incident.hoursRemaining - 1;
    if (hoursRemaining <= 0) {
      earlyDepartureGuestIds.add(guest.id);
      const roomLabel = formatRoomLabel(room.gridX, room.gridY, room.floor);
      const appended = appendStoryLogEntry(current, {
        type: 'mid_stay_breakdown_escalated',
        guestName: partyLabel(guest),
        roomId: room.id,
        message: `No rooms available -- ${partyLabel(guest)} had to leave Room ${roomLabel} early.`,
        chainId: incident.chainId,
      });
      current = appended.state;
      events.push({
        type: 'noise_complaint_escalated', // reuses the "incident escalated" toast styling
        message: `${PartyLabel(guest)} is leaving early -- no room to move to after a breakdown`,
        data: { guestId: guest.id, roomId: room.id },
      });
      continue;
    }

    remaining.push({ ...incident, hoursRemaining });
  }

  current = { ...current, guests, rooms, activeIncidents: remaining };
  return { state: current, events, earlyDepartureGuestIds };
}

/** Teardown rule: drop any activeIncident tied to a guest who departed this tick
 * (normal checkout or walkout) -- an already-departed guest can't escalate further. */
export function dropIncidentsForGuests(activeIncidents: ActiveIncident[], departedGuestIds: Set<string>): ActiveIncident[] {
  return activeIncidents.filter(i => !departedGuestIds.has(i.guestId));
}

// ============================================================================
// Select new incidents (pacing budget + "quiet too long" bias).
// ============================================================================

const ORIGIN_TYPES = new Set(['noise_complaint', 'mid_stay_breakdown', 'review_semi_viral', 'regular_returns']);

function countOriginsToday(storyLog: StoryLogEntry[], day: number): number {
  return storyLog.filter(e => e.day === day && ORIGIN_TYPES.has(e.type) && e.chainId === e.id).length;
}

function mostRecentOriginAbsHour(storyLog: StoryLogEntry[]): number | null {
  let max: number | null = null;
  for (const e of storyLog) {
    if (!ORIGIN_TYPES.has(e.type) || e.chainId !== e.id) continue;
    const absHour = e.day * 24 + e.hour;
    if (max === null || absHour > max) max = absHour;
  }
  return max;
}

type Candidate =
  | { kind: 'noise_complaint'; guest: Guest; room: Room; culpritGuestId: string }
  | { kind: 'mid_stay_breakdown'; guest: Guest; room: Room };

function collectCandidates(state: HotelState): Candidate[] {
  const candidates: Candidate[] = [];
  const activeGuestIds = new Set(state.activeIncidents.map(i => i.guestId));

  for (const guest of state.guests) {
    if (activeGuestIds.has(guest.id)) continue;
    const room = state.rooms.find(r => r.status === 'occupied' && r.guestId === guest.id);
    if (!room) continue;

    // Kept awake: in their room, and (with profiles on) in their sleep hours (not up with visitors)
    const tryingToSleep = !GUEST_PROFILE.enabled || isAsleepAt(state, guest, hourStart(state) + 0.5);
    const below = complainsBelow(guest);
    if (!hasComplained(guest) && below !== null && guest.satisfaction < below && tryingToSleep && !isGuestAway(guest, hourStart(state) + 0.5)) {
      const roomNoise = calculateRoomNoise(room, state);
      if (roomNoise > NOISE.penaltyThreshold) {
        const culpritGuestId = getLoudestNeighborGuestId(room, state);
        if (culpritGuestId) {
          candidates.push({ kind: 'noise_complaint', guest, room, culpritGuestId });
        }
      }
    }

    if (room.condition <= ECONOMY.roomBreakdownThreshold) {
      candidates.push({ kind: 'mid_stay_breakdown', guest, room });
    }
  }

  return candidates;
}

export function selectNewIncident(state: HotelState, prng: PRNG): { state: HotelState; events: GameEvent[] } {
  const todayCount = countOriginsToday(state.storyLog, state.day);
  if (todayCount >= STORY.incidentDailyBudget) {
    return { state, events: [] };
  }

  const lastOrigin = mostRecentOriginAbsHour(state.storyLog);
  const currentAbsHour = state.day * 24 + state.hour;
  const quietHours = lastOrigin === null ? Infinity : currentAbsHour - lastOrigin;
  const fireChance = quietHours >= STORY.quietBiasHours
    ? 1.0
    : STORY.quietBiasMinChance + (1 - STORY.quietBiasMinChance) * (quietHours / STORY.quietBiasHours);

  if (!prng.chance(fireChance)) {
    return { state, events: [] };
  }

  const candidates = collectCandidates(state);
  // (with Voice on the pick is drawn either way, so who's below their line doesn't move the random stream)
  const roll = voiceOn() ? prng.next() : null;
  if (candidates.length === 0) {
    return { state, events: [] };
  }

  const picked = candidates[Math.floor((roll ?? prng.next()) * candidates.length)];
  const events: GameEvent[] = [];
  let current = state;

  if (picked.kind === 'noise_complaint') {
    const { guest, room, culpritGuestId } = picked;
    const roomLabel = formatRoomLabel(room.gridX, room.gridY, room.floor);
    const appended = appendStoryLogEntry(current, {
      type: 'noise_complaint',
      guestName: partyLabel(guest),
      roomId: room.id,
      message: `${PartyLabel(guest)} filed a noise complaint about Room ${roomLabel}.`,
    });
    current = appended.state;

    const incident: ActiveIncident = {
      id: `incident-${appended.entry.id}`,
      type: 'noise_complaint',
      guestId: guest.id,
      culpritGuestId,
      roomId: room.id,
      stage: 'active',
      hoursRemaining: STORY.noiseComplaintGraceHours,
      chainId: appended.entry.chainId!,
    };
    current = {
      ...current,
      activeIncidents: [...current.activeIncidents, incident],
      guests: current.guests.map(g => g.id === guest.id
        ? {
          ...g, hadNoiseComplaint: true, satisfaction: Math.max(0, g.satisfaction - SATISFACTION.noiseComplaintPenalty),
          ...(voiceOn() ? { complaint: { about: 'the noise', cause: 'noise', via: 'phone' as const, at: hourEnd(current) } } : {}),
        }
        : g),
    };
    events.push({
      type: 'noise_complaint_filed',
      message: `${PartyLabel(guest)} filed a noise complaint (Room ${roomLabel})`,
      data: { guestId: guest.id, culpritGuestId, roomId: room.id },
    });
  } else {
    const { guest, room } = picked;
    const roomLabel = formatRoomLabel(room.gridX, room.gridY, room.floor);
    const appended = appendStoryLogEntry(current, {
      type: 'mid_stay_breakdown',
      guestName: partyLabel(guest),
      roomId: room.id,
      message: `Room ${roomLabel} broke down while ${partyLabel(guest)} was staying.`,
    });
    current = appended.state;

    const incident: ActiveIncident = {
      id: `incident-${appended.entry.id}`,
      type: 'mid_stay_breakdown',
      guestId: guest.id,
      roomId: room.id,
      stage: 'active',
      hoursRemaining: STORY.midStayBreakdownGraceHours,
      chainId: appended.entry.chainId!,
    };
    current = { ...current, activeIncidents: [...current.activeIncidents, incident] };
  }

  return { state: current, events };
}

// ============================================================================
// A Regular Returns: converts the 'guest_returned' arrival event into a log entry.
// ============================================================================

export function recordReturnGuestEntries(state: HotelState, events: GameEvent[]): HotelState {
  let current = state;
  for (const event of events) {
    if (event.type !== 'guest_returned' || !event.data) continue;
    const guestId = event.data.guestId as string;
    const roomId = event.data.roomId as string;
    const guest = current.guests.find(g => g.id === guestId);
    if (!guest) continue;

    // Glad to be back (and gladder in their old room)
    const lift = SATISFACTION.regularReturnBonus + (LOYALTY.enabled && event.data.oldRoom ? LOYALTY.oldRoomMood : 0);
    const glad = (s: HotelState): HotelState => ({
      ...s,
      guests: s.guests.map(g => (g.id === guestId ? { ...g, satisfaction: Math.min(100, g.satisfaction + lift) } : g)),
    });
    if (LOYALTY.enabled) {
      // With loyalty on, returns are common: a story for a regular or a VIP (one thread per person), a toast for the rest
      const stays = (event.data.stays as number) ?? 2;
      if (stays < LOYALTY.regularFrom) {
        current = glad(current);
        continue;
      }
      current = glad(appendStoryLogEntry(current, {
        type: 'loyal_return',
        guestName: guest.name,
        roomId,
        message: event.message,
        chainId: `person-${personIdOf(guest)}`,
      }).state);
      continue;
    }

    const appended = appendStoryLogEntry(current, {
      type: 'regular_returns',
      guestName: guest.name,
      roomId,
      message: event.message,
    });
    current = glad(appended.state);
  }
  return current;
}

/** A story when a regular or a VIP is lost: their stay was a letdown, and they won't be back (on their own thread). */
export function recordLostRegulars(state: HotelState, events: GameEvent[]): HotelState {
  let current = state;
  for (const event of events) {
    if (event.type !== 'regular_lost' || !event.data) continue;
    current = appendStoryLogEntry(current, {
      type: 'regular_lost',
      roomId: event.data.roomId as string,
      message: event.message,
      chainId: `person-${event.data.personId as string}`,
    }).state;
  }
  return current;
}

/**
 * Story beats for parties turned away because no room was free that would
 * take them ('party_turned_away' events): the first each day makes a story,
 * so the log isn't flooded and never crowds out the incidents. Not an
 * incident origin: it uses none of the day's incident budget.
 */
export function recordPartyTurnAways(state: HotelState, events: GameEvent[]): HotelState {
  let current = state;
  for (const event of events) {
    if (event.type !== 'party_turned_away') continue;
    const chainId = `turnaway-${current.day}`;
    if (current.storyLog.some(e => e.chainId === chainId)) continue;
    const size = (event.data?.size as number) ?? 0;
    const kind = event.data?.partyKind as string | undefined;
    const advice = kind === 'family' ? 'Families need a room that sleeps them all: a family room.'
      : size === 2 ? 'Friends need a bed each: a twin room.'
      : size === 3 ? 'Friends need a bed each: a family room (a queen and bunk beds) takes three.'
      : `Friends need a bed each: ${size} beds of their own (two sets of bunk beds, say).`;
    const appended = appendStoryLogEntry(current, {
      type: 'party_turned_away',
      message: `${event.message}. ${advice}`,
      chainId,
    });
    current = appended.state;
  }
  return current;
}

/** What to do about something guests disliked in a room. */
const DISLIKE_ADVICE: Partial<Record<RoomFeature, string>> = {
  separateBeds: 'Couples want to share a bed, but they book the cheapest free room that sleeps two: price your twins above your doubles, or keep them for friends.',
};

/**
 * A big restaurant tab among this hour's checkouts (SPENDING.bigTab x the
 * restaurant's level), the biggest of them: "Malik ran up a $210 restaurant
 * tab." The day's first only (checkouts come over several hours); not an
 * incident (it uses none of the day's story budget).
 */
export function recordBigTabs(state: HotelState, departures: DepartedGuestReview[]): HotelState {
  if (!spendingOn()) return state;
  const chainId = `tab-${state.day}`;
  if (state.storyLog.some(e => e.chainId === chainId)) return state;
  const level = Math.max(0, ...state.facilities.filter(f => f.type === 'restaurant').map(f => f.level));
  if (level === 0) return state;
  const line = SPENDING.bigTab * FACILITY_LEVELS[level - 1].revenueMult;
  const top = departures.filter(d => (d.tab ?? 0) >= line).sort((a, b) => b.tab! - a.tab!)[0];
  if (!top) return state;
  const name = top.guestName.charAt(0).toUpperCase() + top.guestName.slice(1);
  return appendStoryLogEntry(state, { type: 'big_tab', guestName: top.guestName, roomId: top.roomId, message: `${name} ran up a $${top.tab} restaurant tab.`, chainId }).state;
}

/**
 * A story beat when guests check out unhappy with something in their room
 * (separate beds for a couple): once a day, naming who and where, so the
 * player can see what the reviews are about. Not an incident origin: it uses
 * none of the day's incident budget.
 */
export function recordRoomDislikes(state: HotelState, departures: DepartedGuestReview[]): HotelState {
  const chainId = `dislike-${state.day}`;
  if (state.storyLog.some(e => e.chainId === chainId)) return state;
  const unhappy = departures.filter(d => d.breakdown.roomDislikes?.length);
  if (unhappy.length === 0) return state;
  // The thing most of them disliked
  const counts = new Map<RoomFeature, DepartedGuestReview[]>();
  for (const d of unhappy) for (const f of d.breakdown.roomDislikes!) counts.set(f, [...(counts.get(f) ?? []), d]);
  const [feature, who] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const rooms = who.map(d => state.rooms.find(r => r.id === d.roomId)).filter((r): r is Room => !!r).map(r => formatRoomLabel(r.gridX, r.gridY, r.floor));
  const name = who[0].guestName.charAt(0).toUpperCase() + who[0].guestName.slice(1);
  const where = rooms.length === 0 ? '' : rooms.length === 1 ? ` in room ${rooms[0]}` : ` (rooms ${rooms.join(', ')})`;
  const message = who.length === 1
    ? `${name} didn't like ${FEATURE_LABELS[feature]}${where}.`
    : `${who.length} guests didn't like ${FEATURE_LABELS[feature]}${where}.`;
  // (with spending styles, a big spender books the best room instead)
  const advice = feature === 'separateBeds' && spendingOn() ? DISLIKE_ADVICE.separateBeds!.replace('but they book', 'but most book') : DISLIKE_ADVICE[feature];
  return appendStoryLogEntry(state, {
    type: 'room_disliked',
    message: advice ? `${message} ${advice}` : message,
    chainId,
    ...(who.length === 1 ? { roomId: who[0].roomId } : {}),
  }).state;
}

// ============================================================================
// Review Goes Semi-Viral: attribution rule + temporary arrival penalty.
// ============================================================================

/** Fixed tie-break order: noise, condition, cleanliness, amenities, price (design doc). */
export function attributeReviewCause(b: GuestReviewBreakdown): string {
  const candidates = [
    { label: 'noise', magnitude: b.noisePenalty },
    { label: 'tired decor', magnitude: b.decorPenalty },
    { label: 'elevator waits', magnitude: b.elevatorPenalty },
    { label: 'room condition', magnitude: Math.max(0, -b.conditionBonus) },
    { label: 'cleanliness', magnitude: Math.max(0, -b.cleanlinessBonus) },
    { label: 'amenities', magnitude: b.amenityPenalty },
    { label: 'pricing', magnitude: (1 - b.priceFairness) * REVIEW.basePriceFairnessWeight },
    { label: b.roomDislikes?.[0] ? FEATURE_LABELS[b.roomDislikes[0]] : 'the room', magnitude: Math.max(0, -b.roomFit) },
    { label: b.favoriteMissLabel ?? 'the facilities', magnitude: b.favoriteMiss ?? 0 },
  ];
  let winner = candidates[0];
  for (const c of candidates.slice(1)) {
    if (c.magnitude > winner.magnitude) winner = c;
  }
  return winner.label;
}

export interface DepartedGuestReview {
  guestName: string;
  roomId: string;
  booking: Booking;
  breakdown: GuestReviewBreakdown;
  voice?: Voice; // how they complain (a stoic guest's bad review is likelier to spread)
  tab?: number; // what they spent at the restaurant this stay (spending styles on)
  guest?: Guest; // who it was (the spotlight guest's review is their own story)
  paid?: number; // a spotlight guest: what they paid (the bill and any late fee, or a walkout's settlement)
}

export function checkReviewSemiViral(
  state: HotelState,
  departures: DepartedGuestReview[],
  prng: PRNG
): { state: HotelState; events: GameEvent[] } {
  const todayCount = countOriginsToday(state.storyLog, state.day);
  if (todayCount >= STORY.incidentDailyBudget) {
    return { state, events: [] };
  }
  // One bad review spreading a day: checkouts come at several hours now (early
  // birds, late checkouts), and each batch mustn't be another chance to go viral
  // (a travel writer's bad review, spreading, is the day's one too)
  if (GUEST_PROFILE.enabled && state.storyLog.some(e => (e.type === 'review_semi_viral' || (e.type === 'spotlight_pan' && spotlightOn())) && e.day === state.day)) {
    return { state, events: [] };
  }

  const bad = departures.filter(d => d.booking.reviewScore < STORY.reviewSemiViralScoreThreshold && !(spotlightOn() && d.guest?.spotlight)); // (a spotlight guest's review is told on its own)
  if (bad.length === 0) {
    return { state, events: [] };
  }

  const chosen = voiceOn() ? pickWeighted(bad, d => VOICE.viralAuthorWeight[d.voice ?? 'typical'], prng.next()) : bad[Math.floor(prng.next() * bad.length)];
  const cause = attributeReviewCause(chosen.breakdown);
  const appended = appendStoryLogEntry(state, {
    type: 'review_semi_viral',
    guestName: chosen.guestName,
    roomId: chosen.roomId,
    message: `${chosen.guestName}'s bad review (${cause}) is hurting bookings.`,
  });

  const nextState: HotelState = {
    ...appended.state,
    activeReputationPenalties: [
      ...(STORY.reviewSemiViralStacks ? appended.state.activeReputationPenalties : appended.state.activeReputationPenalties.filter(p => p.kind === 'write_up')), // (a write-up isn't undone)
      { multiplier: STORY.reviewSemiViralPenaltyMultiplier, hoursRemaining: STORY.reviewSemiViralPenaltyHours },
    ],
  };

  return {
    state: nextState,
    events: [{
      type: 'review_score_changed',
      message: `A review about ${cause} is spreading -- arrivals dip for a while`,
      data: { cause },
    }],
  };
}

/** One of a list picked by a roll in [0, 1), in proportion to weights. */
function pickWeighted<T>(items: T[], weight: (t: T) => number, roll: number): T {
  const total = items.reduce((sum, t) => sum + weight(t), 0);
  let at = roll * total;
  for (const t of items) {
    if (at < weight(t)) return t;
    at -= weight(t);
  }
  return items[items.length - 1];
}

/** Combined multiplier from all active temporary reputation penalties (Review Goes Semi-Viral), and write-ups. */
export function getReputationPenaltyMultiplier(state: HotelState): number {
  return state.activeReputationPenalties.reduce((mult, p) => (p.kind === 'write_up' && !spotlightOn() ? mult : mult * p.multiplier), 1.0);
}

export function tickReputationPenalties(state: HotelState): HotelState {
  const activeReputationPenalties = state.activeReputationPenalties
    .map(p => ({ ...p, hoursRemaining: p.hoursRemaining - 1 }))
    .filter(p => p.hoursRemaining > 0);
  return { ...state, activeReputationPenalties };
}
