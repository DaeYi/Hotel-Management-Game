import type { GameEvent, Guest, HotelState, Leg, Room, StayLeg } from './types.js';
import { VOICE, REVIEW, GUEST_FAVORITES, FACILITY_CONFIG, GUEST_PROFILE } from '../config/balance.js';
import { hash01, hourStart, isUnderway, makeStay, legsEnd } from './Movement.js';
import { roomTile, routeVia, walkLegs } from './GuestMovement.js';
import { guestPace, isSleepHour, nightOf } from './Profile.js';
import { isHosting } from './Visitors.js';
import { isCheckoutDay } from './GuestManager.js';
import { cleanlinessTerm } from './CleaningPreference.js';
import { roomFit, FEATURE_LABELS } from './Preferences.js';
import { profileRoom } from './RoomProfile.js';
import { getElevatorWaitPenalty, formatRoomLabel } from './HotelState.js';
import { queueOn, lanesOf, laneBookings, quoteLane, book, deskToday, reseatLanes, type Lane } from './DeskQueue.js';
import { appendStoryLogEntry } from './StoryGenerator.js';
import { PartyLabel } from './Party.js';
import { voiceOn, complainsBelow, hasComplained } from './Voice.js';
import { recordHospitality, serviceSnapshot, serviceMember } from './StaffHospitality.js';

// Voice (docs/designs/guest-staff-personalities.md, Temperament #8): how a
// guest complains. A vocal guest speaks up once they're irritated, a typical
// one once they're angry; a stoic one never does, but minds more in their
// review (and their mood doesn't show). By day a complaint is made in person:
// they walk down to the front desk, wait their turn, take a clerk for a
// quarter of an hour and walk back -- and are heard (a little better for it),
// with what's wrong named for the player. Guests checking in come first: a
// complaint waits for a clerk free of them. At night it's a call: the noise
// complaint and the complaint about a neighbour's visitors. One a stay. In
// person needs the desk queue (Patience): it's what keeps a clerk's time.

export type ComplaintCause = 'noise' | 'condition' | 'cleanliness' | 'room' | 'lifts' | 'favorite' | 'stay';

/** What advice a complaint about something brings (once a day). */
export const COMPLAINT_ADVICE: Partial<Record<ComplaintCause, string>> = {
  noise: 'Light sleepers mind rooms beside facilities and rowdy guests: the noise overlay shows the night.',
  condition: 'Rooms wear a little every night, and maintenance only repairs empty ones: more maintenance, or renovate.',
  cleanliness: 'Housekeeping is behind: more housekeepers, or clean every day.',
  room: 'What a room suits is on its card: Furnish changes it.',
  lifts: 'The lifts are too busy: another lift shaft, or rooms lower down.',
  favorite: 'The build panel says which facilities guests ask for.',
};

/**
 * What a guest would complain about, without the shared random stream:
 * whatever's costing them most -- last night's noise if it woke them, the
 * room's condition, it not being cleaned, something about the room, the wait
 * for the lift, a favourite facility that let them down today -- else just
 * their stay.
 */
export function complaintAbout(state: HotelState, guest: Guest, room: Room): { cause: ComplaintCause; label: string } {
  // (a save from before lastNight was kept: their average night)
  const night = guest.nightNoise;
  const woken = night && night.lastWokenNight === nightOf(guest, hourStart(state)) ? night.lastNight ?? night.exposure / Math.max(1, night.woken) : 0;
  const fit = roomFit(profileRoom(room), guest);
  const favorite = guest.profile?.favorite;
  const missedToday = GUEST_FAVORITES.enabled && favorite && favorite !== 'none' && guest.favoriteMisses?.day === state.day;
  const candidates: Array<{ cause: ComplaintCause; label: string; weight: number }> = [
    { cause: 'noise', label: 'the noise last night', weight: woken * GUEST_PROFILE.nightPenaltyPerUnit },
    { cause: 'condition', label: 'the state of the room', weight: Math.max(0, -(room.condition - REVIEW.conditionMidpoint) / REVIEW.conditionScale * REVIEW.conditionWeight) },
    { cause: 'cleanliness', label: 'the room not being cleaned', weight: Math.max(0, -cleanlinessTerm(room.cleanliness, guest)) },
    { cause: 'room', label: fit.dislikes[0] ? FEATURE_LABELS[fit.dislikes[0]] : 'the room', weight: Math.max(0, -fit.score) },
    { cause: 'lifts', label: 'the wait for the lift', weight: getElevatorWaitPenalty(state, room, guest) },
    { cause: 'favorite', label: missedToday ? `no ${FACILITY_CONFIG[favorite!].label.toLowerCase()}` : 'the facilities', weight: missedToday ? GUEST_FAVORITES.missReview : 0 },
  ];
  let best = candidates[0];
  for (const c of candidates.slice(1)) if (c.weight > best.weight) best = c;
  return best.weight > 0.02 ? { cause: best.cause, label: best.label } : { cause: 'stay', label: 'their stay' };
}

/** Whether any of the hours from a to b (absolute) is in a guest's sleep hours. */
function sleepsBetween(guest: Pick<Guest, 'profile'>, a: number, b: number): boolean {
  for (let h = Math.floor(a); h <= Math.floor(b); h++) if (isSleepHour(guest, ((h % 24) + 24) % 24)) return true;
  return false;
}

/**
 * This hour's complaint trips (call at the hour boundary, after the hour's
 * other trips are planned and before the staff's): each guest awake in their
 * room who's fallen below their voice's line and hasn't complained this stay
 * walks down to the front desk -- the clerk who'll see them soonest, in line
 * if need be, after anyone checking in -- complains for a quarter of an hour,
 * and walks back, all in their waking hours. Not on their last day, not while
 * they've friends round or something's already being dealt with. Nothing with
 * nobody at the desk, or without the desk queue.
 */
export function planDeskComplaints(state: HotelState): HotelState {
  if (!voiceOn() || !queueOn(state) || state.guests.length === 0) return state;
  const lanes: Lane[] = lanesOf(state);
  if (lanes.length === 0) return state;
  const T = hourStart(state);
  const busy = laneBookings(state, T);
  let changed = false;
  const guests = state.guests.map(g => {
    const below = complainsBelow(g);
    if (below === null || g.satisfaction >= below || hasComplained(g)) return g;
    if (isUnderway(g.trip, T) || isHosting(state, g.id, T) || isCheckoutDay(g, state.day)) return g;
    if (state.activeIncidents.some(i => i.guestId === g.id)) return g;
    const room = state.rooms.find(r => r.guestId === g.id && r.status === 'occupied');
    if (!room) return g;
    const pace = guestPace(g);
    const setOff = T + hash01(`${g.id}|${state.day}|${state.hour}|complain`) * VOICE.setOffSpread;
    const ways = new Map(lanes.map(l => [l.key, routeVia(state, roomTile(room), l.front, pace)]));
    const slot = quoteLane(lanes, busy, lane => { const r = ways.get(lane.key); return r ? setOff + r.hours : null; }, VOICE.complainHours);
    if (!slot) return g;
    const back = routeVia(state, slot.lane.front, roomTile(room), pace);
    if (!back) return g;
    const there = walkLegs(ways.get(slot.lane.key)!, setOff, pace);
    const arrive = there.length > 0 ? legsEnd(there) : setOff;
    const start = Math.max(arrive, slot.start);
    const lane = { lane: slot.lane.key, serviceStaffId: slot.staffId, ...serviceSnapshot(state.staffRoster?.find(m => m.id === slot.staffId)) };
    const legs: Leg[] = [
      ...there,
      ...(start > arrive + 1e-12 ? [makeStay(slot.lane.front, arrive, start, 'wait', { placeId: slot.lane.desk.id, ...lane })] : []),
      makeStay(slot.lane.front, start, start + slot.hours, 'complain', { placeId: slot.lane.desk.id, ...lane }),
      ...walkLegs(back, start + slot.hours, pace),
    ];
    if (sleepsBetween(g, setOff, legsEnd(legs))) return g; // they'd be walking about in their own night
    book(busy, slot.lane.key, start, start + slot.hours);
    const about = complaintAbout(state, g, room);
    changed = true;
    return { ...g, trip: legs, tripKind: 'complaint' as const, complaint: { about: about.label, cause: about.cause, via: 'desk' as const } };
  });
  // In line in the order they get there, round the check-ins already booked
  return changed ? reseatLanes({ ...state, guests }, T) : state;
}

/**
 * The hour's complaints at the desk (call in the tick, T the end of the hour):
 * each guest who got to the counter is heard -- a little better for it -- with
 * a toast and a line in the story log naming what's wrong (and, the first
 * time today, what to do about it). Not an incident: it doesn't use up the
 * day's stories.
 */
export function hearComplaints(state: HotelState, T: number): { state: HotelState; events: GameEvent[] } {
  if (!voiceOn()) return { state, events: [] };
  const events: GameEvent[] = [];
  let current = state;
  for (const g of state.guests) {
    if (g.tripKind !== 'complaint' || !g.trip || !g.complaint || g.complaint.at !== undefined) continue; // (heard once)
    const i = g.trip.findIndex(l => l.kind === 'stay' && l.activity === 'complain' && !l.credited && l.start < T);
    if (i < 0) continue;
    const stay = g.trip[i] as StayLeg;
    const room = current.rooms.find(r => r.guestId === g.id);
    const label = room ? formatRoomLabel(room.gridX, room.gridY, room.floor) : '';
    const cause = (g.complaint.cause ?? 'stay') as ComplaintCause;
    const member = serviceMember(current, stay);
    const heard = { ...g, trip: g.trip!.map((l, k) => (k === i ? { ...l, credited: true } : l)), satisfaction: Math.min(100, g.satisfaction + VOICE.heardMood), complaint: { ...g.complaint!, at: stay.start } };
    const met = member ? recordHospitality(heard, member, 'complaint', stay.start) : heard;
    current = {
      ...current,
      guests: current.guests.map(x => (x.id === g.id
        ? met
        : x)),
    };
    const chainId = `complaints-${current.day}`;
    const advice = COMPLAINT_ADVICE[cause];
    const advised = !!advice && current.storyLog.some(e => e.chainId === chainId && e.message.includes(advice));
    current = appendStoryLogEntry(current, {
      type: 'guest_complained',
      guestName: PartyLabel(g),
      roomId: room?.id,
      message: `${PartyLabel(g)}${label ? ` (Room ${label})` : ''} complained at the front desk about ${g.complaint.about}.${member ? ` ${member.name} heard them${met.satisfaction - g.satisfaction > VOICE.heardMood ? ' and put them at ease' : ''}.` : ''}${advice && !advised ? ` ${advice}` : ''}`,
      chainId,
    }).state;
    const today = deskToday(current);
    current = { ...current, deskToday: { ...today, complaints: today.complaints + 1 } };
    events.push({
      type: 'guest_complained',
      message: `${PartyLabel(g)}${label ? ` (Room ${label})` : ''} complained at the front desk about ${g.complaint.about}`,
      data: { guestId: g.id, roomId: room?.id, cause },
    });
  }
  return { state: current, events };
}
