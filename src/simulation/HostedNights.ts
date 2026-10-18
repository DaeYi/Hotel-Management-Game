import type { ActiveIncident, GameEvent, HotelState, Leg, Walker } from './types.js';
import { HOSTED_NIGHTS, GUEST_PROFILE, TRAVEL, SATISFACTION, NOISE, VOICE } from '../config/balance.js';
import { voiceOn, voiceOf, hasComplained } from './Voice.js';
import { routeFromStreet, routeToStreet, getMannedDeskStaff } from './Layout.js';
import { makeWalk, makeStay, truncateLegs, legsEnd, hourStart, hash01, isUnderway } from './Movement.js';
import { roomTile, isGuestAway } from './GuestMovement.js';
import { pick, partyLabel, PartyLabel, partySize } from './Party.js';
import { isSleepHour } from './Profile.js';
import { visitorsOf, visitorsAt, inRoomStay, hostingDay, isAsleepAt, visitorPolicy, theVisitors } from './Visitors.js';
import { calculateRoomNoise, getLoudestNeighborGuestId } from './NoiseManager.js';
import { appendStoryLogEntry } from './StoryGenerator.js';
import { formatRoomLabel } from './HotelState.js';

// Hosted nights (docs/designs/guest-staff-personalities.md, Rowdiness): on one
// night of their stay, picked from their booking, half of rowdy guests -- if
// they're in and up at 22:00 -- have 1-3 friends round. The visitors walk in from the street, go
// up to the room, and leave between 01:00 and 02:00; while they're in, the
// room is louder (the host's up with them, and there are more of them), so a
// neighbour asleep next door may complain -- the lighter they sleep, the
// likelier. Answer it by asking the visitors to leave (the front desk sends
// them out within minutes, and the host loses 10 points of mood), or leave
// them be: once the noise stops the complaint's resolved, but if it's still
// going two sleep-hours on, the neighbour checks out early.

/** The visitors' walking pace (they have no profile: the usual pace). */
const PACE = TRAVEL.guestHoursPerTile;

/** A time of day to five minutes: "00:40". */
export function clockTime(t: number): string {
  const minutes = Math.floor((((t % 24) + 24) % 24) * 12) * 5;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Tonight's visitors, planned at the 22:00 boundary (call after the guests'
 * own trips for the hour are planned): for each rowdy guest whose night it
 * is, who's in their room and not asleep.
 */
export function planVisitors(state: HotelState): HotelState {
  if (!HOSTED_NIGHTS.enabled || !GUEST_PROFILE.enabled || state.hour !== HOSTED_NIGHTS.startHour) return state;
  const T = hourStart(state);
  const dayStart = (state.day - 1) * 24;
  const added: Walker[] = [];
  const guests = state.guests.map(guest => {
    if (guest.hostedNight || hostingDay(guest) !== state.day) return guest;
    if (isUnderway(guest.trip, T)) return guest; // out (or going out): not tonight
    if (isSleepHour(guest, state.hour)) return guest; // an early bird's in bed by now
    const room = state.rooms.find(r => r.guestId === guest.id && r.status === 'occupied');
    if (!room) return guest;
    const tile = roomTile(room);
    const comeIn = routeFromStreet(state, tile, PACE);
    const goOut = routeToStreet(state, tile, PACE);
    if (!comeIn || comeIn.path.length < 2 || !goOut || goOut.path.length < 2) return guest;
    const size = pick(HOSTED_NIGHTS.visitors, hash01(`${guest.id}#visitors`));
    const walkIn = makeWalk(comeIn.path, T + hash01(`${guest.id}#visitors-arrive`) * HOSTED_NIGHTS.arriveSpread, PACE);
    const [from, to] = HOSTED_NIGHTS.leaveHours;
    const leave = Math.max(walkIn.end + HOSTED_NIGHTS.minStay, dayStart + 24 + from + hash01(`${guest.id}#visitors-leave`) * (to - from));
    added.push({
      id: `visit-${guest.id}-${state.day}`, trait: 'normal', isReturning: false, reason: 'visitor', hostId: guest.id,
      party: { kind: size === 1 ? 'solo' : 'friends', size }, ...(guest.purpose ? { purpose: guest.purpose } : {}),
      trip: [walkIn, makeStay(tile, walkIn.end, leave, 'in_room', { placeId: room.id }), makeWalk(goOut.path, leave, PACE)],
    });
    return { ...guest, hostedNight: { day: state.day, visitors: size } };
  });
  return added.length === 0 ? state : { ...state, guests, walkers: [...(state.walkers ?? []), ...added] };
}

/**
 * A visitor sent home at time t: out of the room after `delay` (gathering
 * their things) and off to the street, or, still on the way up, turned round
 * where they are. Null if they hadn't set off yet (they don't come).
 */
function sentHome(state: HotelState, walker: Walker, t: number, delay: number): Walker | null {
  const stay = inRoomStay(walker);
  if (!stay || stay.end <= t) return walker; // on their way already
  if (t <= walker.trip[0].start) return null;
  const at = t >= stay.start ? Math.min(stay.end, t + delay) : t;
  if (at >= stay.end) return walker;
  const cut = truncateLegs(walker.trip, at);
  const legs: Leg[] = [...cut.legs];
  const pos = cut.at!;
  // Stood still between the step they'd reached and now: say so, so the trip has no holes
  const reached = legs.length > 0 ? legsEnd(legs) : walker.trip[0].start;
  if (at > reached + 1e-12) legs.push(makeStay(pos, reached, at, 'wait'));
  const out = routeToStreet(state, pos, PACE);
  if (out && out.path.length > 1) legs.push(makeWalk(out.path, at, PACE));
  return legs.length > 0 ? { ...walker, trip: legs } : null;
}

/** Whether there's someone at the front desk to ask visitors to leave. */
export function canAskVisitorsToLeave(state: HotelState, t = hourStart(state)): boolean {
  return getMannedDeskStaff(state, t) > 0;
}

/**
 * The front desk asks a guest's visitors to leave at time t: they're out of
 * the room within minutes and walk out (anyone still on the way up turns
 * round). The host minds (10 points of mood) and keeps it down for the rest
 * of the night; any complaint about the visitors is answered (the neighbour
 * gets the usual lift). Null if there are no visitors to ask, or nobody at
 * the desk.
 */
export function askToKeepItDown(state: HotelState, hostId: string, t: number): { state: HotelState; events: GameEvent[] } | null {
  const host = state.guests.find(g => g.id === hostId);
  const visiting = visitorsOf(state, hostId).filter(w => (inRoomStay(w)?.end ?? -Infinity) > t);
  // Asked already (by hand, before a complaint came in): they're gone or going; a complaint about them is just answered
  const already = host?.hostedNight?.keptDownAt !== undefined;
  if (!host || (!already && (visiting.length === 0 || !canAskVisitorsToLeave(state, t)))) return null;
  const sent = new Map(already ? [] : visiting.map(w => [w.id, sentHome(state, w, t, HOSTED_NIGHTS.leaveDelay)]));
  const who = theVisitors(visitorsOf(state, hostId).reduce((sum, w) => sum + partySize(w), 0));
  const walkers = (state.walkers ?? []).flatMap(w => (!sent.has(w.id) ? [w] : sent.get(w.id) ? [sent.get(w.id)!] : []));
  // When the last of them is out of the room (asked already: when they went, or are going)
  const leftAt = already
    ? Math.max(host.hostedNight!.keptDownAt!, ...visitorsOf(state, hostId).map(w => inRoomStay(w)?.end ?? -Infinity))
    : Math.max(t, ...[...sent.values()].map(w => (w ? inRoomStay(w)?.end ?? t : t)));
  const room = state.rooms.find(r => r.guestId === hostId);
  const label = room ? formatRoomLabel(room.gridX, room.gridY, room.floor) : '';
  let current: HotelState = {
    ...state,
    walkers,
    guests: already ? state.guests : state.guests.map(g => (g.id === hostId
      ? { ...g, satisfaction: Math.max(0, g.satisfaction - HOSTED_NIGHTS.hostPenalty), hostedNight: { ...(g.hostedNight ?? { day: state.day, visitors: 0 }), keptDownAt: t } }
      : g)),
  };
  // Complaints about them are answered
  const answered = current.activeIncidents.filter(i => i.about === 'visitors' && i.culpritGuestId === hostId);
  for (const incident of answered) {
    const complainer = current.guests.find(g => g.id === incident.guestId);
    current = {
      ...current,
      guests: current.guests.map(g => (g.id === incident.guestId ? { ...g, satisfaction: Math.min(100, g.satisfaction + SATISFACTION.noiseComplaintResolvedBonus) } : g)),
    };
    current = appendStoryLogEntry(current, {
      type: 'noise_complaint_kept_down',
      guestName: complainer ? partyLabel(complainer) : undefined,
      roomId: room?.id,
      message: `You asked Room ${label} to keep it down; ${who} left at ${clockTime(leftAt)}.`,
      chainId: incident.chainId,
    }).state;
  }
  if (answered.length > 0) current = { ...current, activeIncidents: current.activeIncidents.filter(i => !answered.includes(i)) };
  if (already) return answered.length > 0 ? { state: current, events: [] } : null;
  const events: GameEvent[] = [{
    type: 'visitors_asked_to_leave',
    message: `Asked ${who} in Room ${label} to leave (${PartyLabel(host)} won't thank you)`,
    // (with nobody's complaint answered, it's not in the story log: show it even with the log open)
    data: { guestId: hostId, roomId: room?.id, complaints: answered.length, ...(answered.length === 0 ? { unlogged: true } : {}) },
  }];
  return { state: current, events };
}

/**
 * This hour's complaints about visitors (call in the tick after the other
 * incidents, T the end of the hour): a neighbour asleep in their room, kept
 * awake by a guest's visitors (the loudest thing they can hear, at the middle
 * of the hour) may complain -- the lighter they sleep, the likelier, decided
 * once a night from their booking. One complaint a night per host. It opens
 * a noise complaint with a short grace, on the night's own thread in the
 * story log (not a new story, so the day's incident budget doesn't stop it);
 * with the "ask" policy and someone at the desk, the visitors are asked to
 * leave there and then. Nobody checking out this hour (`leaving`) complains,
 * or hosts.
 */
export function fileVisitorComplaints(state: HotelState, T: number, leaving: ReadonlySet<string> = new Set()): { state: HotelState; events: GameEvent[] } {
  if (!HOSTED_NIGHTS.enabled || !GUEST_PROFILE.enabled || !(state.walkers ?? []).some(w => w.reason === 'visitor')) return { state, events: [] };
  const mid = hourStart(state) + 0.5;
  const events: GameEvent[] = [];
  let current = state;
  for (const host of state.guests) {
    const night = host.hostedNight;
    if (!night || night.complainedBy || leaving.has(host.id) || visitorsAt(current, host.id, mid) === 0) continue;
    const hostRoom = current.rooms.find(r => r.guestId === host.id && r.status === 'occupied');
    if (!hostRoom) continue;
    const busy = new Set(current.activeIncidents.map(i => i.guestId));
    let complainerRoom = null as typeof hostRoom | null;
    const complainer = current.guests.find(g => {
      // (not someone leaving this hour, or who's complained already this stay)
      if (g.id === host.id || busy.has(g.id) || leaving.has(g.id) || hasComplained(g) || !g.profile) return false;
      const room = current.rooms.find(r => r.guestId === g.id && r.status === 'occupied');
      if (!room || isGuestAway(g, mid) || !isAsleepAt(current, g, mid)) return false;
      if (hash01(`${g.id}|${host.id}|${night.day}|complain`) >= HOSTED_NIGHTS.complaintChance[g.profile.sleep] * (voiceOn() ? VOICE.visitorComplaintMult[voiceOf(g)] : 1)) return false;
      if (calculateRoomNoise(room, current, mid) <= NOISE.penaltyThreshold || getLoudestNeighborGuestId(room, current, mid) !== host.id) return false;
      complainerRoom = room;
      return true;
    });
    if (!complainer || !complainerRoom) continue;
    const room = complainerRoom as typeof hostRoom;
    const hostLabel = formatRoomLabel(hostRoom.gridX, hostRoom.gridY, hostRoom.floor);
    const label = formatRoomLabel(room.gridX, room.gridY, room.floor);
    const chainId = `hosted-${host.id}-${night.day}`;
    const visitors = visitorsOf(current, host.id);
    const since = Math.min(...visitors.map(w => inRoomStay(w)?.start ?? Infinity));
    const count = visitors.reduce((sum, w) => sum + partySize(w), 0);
    current = appendStoryLogEntry(current, {
      type: 'visitors',
      guestName: partyLabel(host),
      roomId: hostRoom.id,
      message: `Room ${hostLabel} has ${count === 1 ? 'a visitor' : `${count} visitors`}${Number.isFinite(since) ? ` (since ${clockTime(since)})` : ''}.`,
      chainId,
    }).state;
    const filed = appendStoryLogEntry(current, {
      type: 'noise_complaint_visitors',
      guestName: partyLabel(complainer),
      roomId: room.id,
      message: `${PartyLabel(complainer)} in Room ${label} complained about the noise.`,
      chainId,
    });
    current = filed.state;
    const incident: ActiveIncident = {
      id: `incident-${filed.entry.id}`,
      type: 'noise_complaint',
      guestId: complainer.id,
      culpritGuestId: host.id,
      roomId: room.id,
      stage: 'active',
      hoursRemaining: HOSTED_NIGHTS.complaintGraceHours,
      chainId,
      about: 'visitors',
    };
    current = {
      ...current,
      activeIncidents: [...current.activeIncidents, incident],
      guests: current.guests.map(g => (g.id === complainer.id
        ? {
          ...g, hadNoiseComplaint: true, satisfaction: Math.max(0, g.satisfaction - SATISFACTION.noiseComplaintPenalty),
          ...(voiceOn() ? { complaint: { about: 'the visitors next door', cause: 'noise', via: 'phone' as const, at: T } } : {}),
        }
        : g.id === host.id ? { ...g, hostedNight: { ...night, complainedBy: complainer.id } } : g)),
    };
    events.push({
      type: 'noise_complaint_filed',
      message: `${PartyLabel(complainer)} complained about ${theVisitors(count)} in Room ${hostLabel}`,
      data: { guestId: complainer.id, culpritGuestId: host.id, roomId: room.id, about: 'visitors' },
    });
    // Ask them to leave (the policy), or say they've been asked already (by hand)
    if (visitorPolicy(current) === 'ask' || night.keptDownAt !== undefined) {
      const asked = askToKeepItDown(current, host.id, T);
      if (asked) {
        current = asked.state;
        events.push(...asked.events);
      }
    }
  }
  return { state: current, events };
}

/** Visitors whose host has gone (checked out early, moved rooms) leave at time T. */
export function sendOrphanedVisitorsHome(state: HotelState, T: number): HotelState {
  const walkers = state.walkers ?? [];
  if (!walkers.some(w => w.reason === 'visitor')) return state;
  let changed = false;
  const next = walkers.flatMap(w => {
    const stay = w.reason === 'visitor' ? inRoomStay(w) : undefined;
    if (!stay || stay.end <= T) return [w];
    const room = state.rooms.find(r => r.id === stay.placeId);
    if (room && room.status === 'occupied' && room.guestId === w.hostId && state.guests.some(g => g.id === w.hostId)) return [w];
    changed = true;
    const sent = sentHome(state, w, T, 0);
    return sent ? [sent] : [];
  });
  return changed ? { ...state, walkers: next } : state;
}

/** A guest's visitors in words, for their room's and their own card: "2 visitors since 22:40, leaving about 01:30". Null with none. */
export function describeVisitors(state: HotelState, hostId: string, t: number): string | null {
  const visiting = visitorsOf(state, hostId).filter(w => legsEnd(w.trip) > t);
  if (visiting.length === 0) return null;
  const count = visiting.reduce((sum, w) => sum + partySize(w), 0);
  const who = count === 1 ? 'A visitor' : `${count} visitors`;
  const stays = visiting.map(inRoomStay).filter((s): s is NonNullable<typeof s> => !!s && s.end > t);
  if (stays.length === 0) return `${who} leaving`;
  const asked = state.guests.find(g => g.id === hostId)?.hostedNight?.keptDownAt !== undefined;
  const since = Math.min(...stays.map(s => s.start));
  const until = Math.max(...stays.map(s => s.end));
  if (visitorsAt(state, hostId, t) === 0) return `${who} on the way up`;
  return `${who} since ${clockTime(since)}, ${asked ? 'asked to leave' : `leaving about ${clockTime(until)}`}`;
}
