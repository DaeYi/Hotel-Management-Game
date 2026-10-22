import type { Guest, HotelState, StaffMember, StayLeg } from './types.js';
import { STAFF_PERSONALITIES, STAFF_SPECIALTIES } from '../config/staff.js';
import { specialtyOf } from './StaffProfiles.js';
import { spendingOf } from './Spending.js';
import { getAvailableRooms } from './HotelState.js';
import { heldFrom } from './Spotlight.js';
import { profileRoom, fitsParty, partyPriceFactor, classPriceFactor } from './RoomProfile.js';
import { partyOf } from './Party.js';
import { getPartyFairPrice } from './StarRatingManager.js';
import { guestPace } from './Profile.js';
import { roomTile, routeVia, walkLegs, guestTileAt } from './GuestMovement.js';
import { hash01, truncateLegs, legsEnd, walkProgress, makeWalk, makeStay, sameTile } from './Movement.js';
import { startTurnoverCleaning } from './HousekeepingManager.js';
import { appendStoryLogEntry } from './StoryGenerator.js';

/** An actual counter offer, after the room selected by the normal matcher. No reservation or PRNG draw. */
export function offerUpsell(state: HotelState, guestId: string, member: StaffMember, stay: StayLeg, now = stay.start): HotelState {
  if (!STAFF_PERSONALITIES.enabled || !STAFF_SPECIALTIES.enabled || specialtyOf(member) !== 'upseller') return state;
  const guest = state.guests.find(g => g.id === guestId);
  if (!guest || guest.spotlight || guest.loyalty?.oldRoom || guest.service?.upsell || spendingOf(guest) !== 'splurger'
    || hash01(`${guest.id}|upsell`) >= STAFF_SPECIALTIES.upsellChance) return state;
  const original = state.rooms.find(r => r.guestId === guest.id);
  if (!original || !guest.trip) return state;
  const rank = { standard: 0, deluxe: 1, suite: 2 };
  const party = partyOf(guest), pace = guestPace(guest);
  const beingRepaired = new Set((state.staffPlan?.itineraries ?? []).flatMap(it => it.legs.filter(l =>
    l.kind === 'stay' && l.job === 'repair' && l.start < now && l.end > (state.staffPlan?.start ?? now - 1)).map(l => (l as StayLeg).placeId)));
  const candidates = getAvailableRooms(state).filter(r => rank[r.type] > rank[original.type] && !beingRepaired.has(r.id)
    && r.pricePerNight > original.pricePerNight && r.id !== heldFrom(state, guest.stayLength)
    && fitsParty(profileRoom(r), party)
    && partyPriceFactor(profileRoom(r), party) === classPriceFactor(profileRoom(r))
    && r.pricePerNight <= guest.budget
    && r.pricePerNight <= getPartyFairPrice(r, party, state.starRating) * (guest.checkInPriceTolerance ?? 1))
    .sort((a, b) => rank[a.type] - rank[b.type] || a.pricePerNight - b.pricePerNight || a.id.localeCompare(b.id));
  let cut = now > stay.end ? truncateLegs(guest.trip, now) : null;
  // Finish a step already being drawn, then turn toward the new room.
  const walking = guest.trip.findIndex(l => l.kind === 'walk' && l.start < now && l.end > now);
  if (cut && walking >= 0) {
    const leg = guest.trip[walking];
    if (leg.kind === 'walk') {
      const progress = walkProgress(leg, now);
      const step = makeWalk(leg.path.slice(0, progress.index + 2), leg.start, leg.hoursPerTile);
      cut = { legs: [...guest.trip.slice(0, walking), step], at: step.path.at(-1)!, time: step.end };
    }
  }
  const from = cut ? cut.at ?? guestTileAt(state, guest, now) : stay.at;
  if (!from) return state;
  const room = candidates.find(r => !!routeVia(state, from, roomTile(r), pace));
  if (!room) return state;
  const route = routeVia(state, from, roomTile(room), pace)!;
  const index = guest.trip.findIndex(l => l.kind === 'stay' && l.activity === 'check_in' && l.start === stay.start);
  if (index < 0) return state;
  const prefix = [...(cut?.legs ?? guest.trip.slice(0, index + 1))];
  const setOff = Math.max(stay.end, cut?.time ?? now);
  const stoppedAt = legsEnd(prefix);
  if (setOff > stoppedAt + 1e-9) prefix.push(makeStay(from, stoppedAt, setOff, 'in_room', { placeId: original.id }));
  const upgraded: Guest = { ...guest, trip: [...prefix, ...walkLegs(route, setOff, pace)],
    service: { contacts: [], hospitalityMood: 0, ...guest.service, upsell: {
      staffId: member.id, name: member.name ?? member.id, fromRoomId: original.id,
      fromType: original.type, toType: room.type, extraPerNight: room.pricePerNight - original.pricePerNight, at: stay.start,
    } } };
  const visitedOriginal = now >= legsEnd(guest.trip) - 1e-9 || !!cut && sameTile(cut.at, roomTile(original));
  const vacated = visitedOriginal ? startTurnoverCleaning(original, state.housekeeping.turnoverQuality) : { ...original, status: 'vacant' as const, guestId: undefined };
  const result: HotelState = { ...state, rooms: state.rooms.map(r => r.id === original.id ? vacated
    : r.id === room.id ? { ...r, status: 'occupied', guestId: guest.id } : r),
    guests: state.guests.map(g => g.id === guest.id ? upgraded : g) };
  return appendStoryLogEntry(result, { type: 'staff_upsell', guestName: guest.name, roomId: room.id,
    message: `${member.name ?? 'The clerk'} arranged a ${room.type} upgrade for ${guest.name} (+$${room.pricePerNight - original.pricePerNight}/night).`, chainId: `service-${guest.id}` }).state;
}
