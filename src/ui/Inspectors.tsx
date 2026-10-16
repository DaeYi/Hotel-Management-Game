import type { ComponentChildren } from 'preact';
import type { Room, Facility, HotelState, Guest, FacilityType } from '../simulation/types';
import { ROOM_CONFIG, ECONOMY, AMENITIES, DECOR, RENOVATION, GRID, FACILITY_CONFIG, FACILITY_LEVELS } from '../config/balance';
import {
  formatRoomLabel, getDemolishRefund, isFacilityOpen, getRenovationCost, isRoomReachable, getFacilityUpgradeCost, getRoomInvestedCost, getRoomPriceRange,
} from '../simulation/HotelState';
import { getRoomExpectedPrice, getUpkeepMultiplier } from '../simulation/StarRatingManager';
import { calculateRoomNoise, nightRoomNoise } from '../simulation/NoiseManager';
import { DOOR_ARROWS } from './BuildPanel';
import { RoomPlan } from './RoomPlan';
import { profileRoom, profileFurnishing, furnishingOf, whoFits } from '../simulation/RoomProfile';
import { partyOf } from '../simulation/Party';
import { describeGuest, awayActivity, popularWith } from '../simulation/Purpose';
import { roomFit, listFeatures } from '../simulation/Preferences';
import { RoomSuits } from './RoomSuits';

import { guestTags, describeRhythm, describeTemperament, sleepHours, favoriteOf, describeFavorite } from '../simulation/Profile';
import { housekeepingPrefOf, describeHousekeeping } from '../simulation/CleaningPreference';
import { isAsleepAt, isHosting, theVisitors, visitorCount } from '../simulation/Visitors';
import { describeVisitors, canAskVisitorsToLeave, clockTime } from '../simulation/HostedNights';
import { moodHidden } from '../simulation/Voice';
import { spendingOn, spendingOf, spentHere, saleFor } from '../simulation/Spending';
import { describeLoyalty } from '../simulation/Loyalty';
import { spotlightOn, holdFor, holdBlocksRenovation, describeSpotlight } from '../simulation/Spotlight';
import { guestMood } from '../simulation/Mood';
import { getOpenFacilities } from '../simulation/Layout';
import { PartyLabel } from '../simulation/Party';
import { guestsInFacility, facilityStatus } from '../simulation/FacilityManager';
import { GUEST_PROFILE, GUEST_FAVORITES, LOYALTY, MOOD } from '../config/balance';
import type { Tile } from '../game/GameController';
import { getStaffTravelHours } from '../simulation/Layout';
import { positionAt, legsEnd } from '../simulation/Movement';
import { facilityCapacity, facilityLoad, peopleInFacility, openingHours } from '../simulation/FacilityManager';
import { roomCleaningAt, describeWait, type RoomCleaning } from '../simulation/CleaningStatus';
import { useController, useLiveClock } from './context';
import { formatBar, formatMoney, formatWalk, capitalize } from './format';

/** What a visit to the shop or a table at the restaurant costs a party of one or two, and a big spender's (spending styles on). */
function spendLines(facility: Facility): string[] {
  if (facility.type !== 'shop' && facility.type !== 'restaurant') return [];
  const each = saleFor(facility.type, facility.level, 1, 'standard');
  const big = saleFor(facility.type, facility.level, 1, 'splurger');
  return facility.type === 'shop'
    ? [`Spend/visit:    ${formatMoney(each)} for one or two (big spenders ${formatMoney(big)}; thrifty guests don't shop)`]
    : [`Spend/visit:    ${formatMoney(each)} a table for one or two (big spenders ${formatMoney(big)}; thrifty guests eat out)`];
}

/** How a guest spends, for their card: "Big spender: spent $84 here this stay (restaurant $60, shop $24)", and what it makes them mind. */
function describeSpending(guest: Guest): string[] {
  const total = spentHere(guest);
  const parts = [
    guest.spent?.restaurant ? `restaurant ${formatMoney(guest.spent.restaurant)}` : '',
    guest.spent?.shop ? `shop ${formatMoney(guest.spent.shop)}` : '',
  ].filter(Boolean);
  switch (spendingOf(guest)) {
    case 'splurger':
      return [total > 0 ? `Big spender: spent ${formatMoney(total)} here this stay (${parts.join(', ')})` : 'Big spender: nothing spent here yet', 'Notices the amenities, and tired decor'];
    case 'thrifty': {
      const n = guest.dinnersOut?.count ?? 0;
      return [`Watches the pennies: no shop, eats in town${n > 0 ? ` (out to dinner ${n} night${n === 1 ? '' : 's'})` : ''}`, 'Minds a high price more than the frills'];
    }
    default:
      return total > 0 ? [`Spent ${formatMoney(total)} here this stay`] : [];
  }
}

/** The inspector for whatever's selected on the grid, if anything. */
export function Inspector() {
  const c = useController();
  const { state, selection } = c;
  if (!selection) return null;
  if (selection.kind === 'room') {
    const room = state.rooms.find(r => r.id === selection.id);
    return room ? <RoomInspector room={room} state={state} /> : null;
  }
  if (selection.kind === 'guest') return <GuestInspector guestId={selection.id} anchor={selection.anchor} state={state} />;
  const facility = state.facilities.find(f => f.id === selection.id);
  return facility ? <FacilityInspector facility={facility} state={state} /> : null;
}

/** A card beside the selected tile: to its right, or its left on the right half of the floor. */
function TileCard({ tile, title, children }: { tile: { gridX: number; gridY: number }; title: string; children: ComponentChildren }) {
  const c = useController();
  const onRight = tile.gridX < GRID.width / 2;
  const style = {
    top: `${Math.min(tile.gridY, GRID.height - 4) / GRID.height * 100}%`,
    ...(onRight
      ? { left: `${(tile.gridX + 1) / GRID.width * 100}%` }
      : { right: `${(GRID.width - tile.gridX) / GRID.width * 100}%` }),
  };
  return (
    <div class="card inspector" style={style} role="dialog" aria-label={title}>
      <div class="card-title" style={{ color: '#fff', fontSize: '14px' }}>
        {title}
        <button class="close" onClick={() => c.clearSelection()} aria-label="Close">{'✕'}</button>
      </div>
      {children}
    </div>
  );
}

function noiseLabel(noise: number): string {
  if (noise <= 0.2) return 'Quiet';
  if (noise <= 0.5) return 'Low';
  if (noise <= 1.0) return 'Moderate';
  if (noise <= 1.5) return 'Loud';
  return 'Very Loud';
}

function RoomInspector({ room, state }: { room: Room; state: HotelState }) {
  const c = useController();
  useLiveClock();
  const config = ROOM_CONFIG[room.type];
  const profile = profileRoom(room);
  const guest = state.guests.find(g => g.id === room.guestId);
  const fair = getRoomExpectedPrice(room, state.starRating);
  const cleaning = roomCleaningAt(state, c.gameTime).get(room.id);

  let status: string;
  if (room.status === 'occupied') {
    const where = guest ? guestWhereabouts(guest, state, c.gameTime) : null;
    const tags = guest ? guestTags(guest) : [];
    status = `Occupied${guest ? `: ${describeGuest(partyOf(guest), guest.purpose)}${tags.length ? ` (${tags.join(', ')})` : ''}` : ''}${where ? `, ${where}` : ''}`;
  }
  else if (room.status === 'cleaning') status = turnoverStatus(cleaning);
  else if (room.status === 'renovating') status = `Renovating (${room.renovationHoursRemaining}h left)`;
  else if (room.condition <= ECONOMY.roomBreakdownThreshold) status = 'OUT OF ORDER';
  else status = isRoomReachable(state, room) ? 'Vacant' : 'Door blocked: no hallway access!';
  // What the guest staying likes (or doesn't) about the room: part of their review
  const fit = room.status === 'occupied' && guest ? roomFit(profile, guest) : null;

  // Friends round, and the hanger on the door
  const visitors = room.status === 'occupied' && guest ? describeVisitors(state, guest.id, c.gameTime) : null;
  const hanger = room.status === 'occupied' && guest ? housekeepingPrefOf(guest) : 'standard';
  // Held for an announced spotlight guest (or it could be)
  const hold = holdFor(state, room);

  const stats = [
    `Status:      ${status}`,
    ...(hold?.held ? [`Held:        for the ${hold.who} (${hold.when})`] : []),
    ...(visitors ? [`Visitors:    ${visitors}`] : []),
    `Condition:   ${formatBar(room.condition)} ${room.condition.toFixed(0)}%`,
    `Cleanliness: ${formatBar(room.cleanliness)} ${room.cleanliness.toFixed(0)}%${cleaning?.job === 'daily' ? `, ${dailyStatus(cleaning)}` : ''}`,
    ...(hanger !== 'standard' ? [`Hanger:      ${hanger === 'dnd' ? 'Do not disturb' : 'Please make up the room'}`] : []),
    `Decor:       ${formatBar(room.decor)} ${room.decor.toFixed(0)}%${room.decor < DECOR.freshThreshold ? ' stale' : ''}`,
    `Amenities:   ${AMENITIES.tiers[state.amenities[room.type]]?.label ?? 'Basic'}`,
    GUEST_PROFILE.enabled ? `Night noise: ${noiseLabel(nightRoomNoise(room, state))}` : `Noise:       ${noiseLabel(calculateRoomNoise(room, state))}`,
    `Staff walk:  ${formatWalk(getStaffTravelHours(state, room))}`,
  ];

  const canRepair = room.condition < 80 && room.status === 'vacant';
  const canRenovate = room.status === 'vacant' && room.decor < 90;
  const heldBack = holdBlocksRenovation(state, room.id, RENOVATION.durationHours); // (it wouldn't be done in time)
  const renovationCost = getRenovationCost(getRoomInvestedCost(room), state.starRating);
  const canDemolish = room.status !== 'occupied' && room.status !== 'renovating';

  return (
    <TileCard tile={room} title={`${profile.label} ${formatRoomLabel(room.gridX, room.gridY, room.floor)}`}>
      <div class="room-furnishing">
        <RoomPlan furnishing={furnishingOf(room)} size={64} />
        <div>
          <div class="small">{capitalize(room.type)} room{' \u00b7 '}sleeps {profile.sleeps}</div>
          <div class="dim small">Fits {whoFits(profile)}</div>
          <RoomSuits profile={profile} />
          {room.pendingRefit && <div class="small gold">Refit booked: {profileFurnishing(room.pendingRefit).label}</div>}
          <button onClick={() => c.openFurnishing(room.id)}>Furnish{'\u2026'}</button>
        </div>
      </div>
      <pre class="stats">{stats.join('\n')}</pre>
      {fit && (fit.likes.length > 0 || fit.dislikes.length > 0) && (
        <div class="small guest-fit">
          {fit.likes.length > 0 && <span class="good-text">Likes {listFeatures(fit.likes, profile.type)}. </span>}
          {fit.dislikes.length > 0 && <span class="warn-text">Doesn't like {listFeatures(fit.dislikes)}.</span>}
        </div>
      )}
      {guest && room.status === 'occupied' && (
        <button class="link guest-link" onClick={() => c.selectGuest(guest.id, room)}>About {PartyLabel(guest)}{'\u2026'}</button>
      )}
      <label class="price-row">
        <span>Price/night (fair {formatMoney(fair)}):</span>
        <span class="price">{formatMoney(room.pricePerNight)}</span>
      </label>
      <input
        type="range" min={getRoomPriceRange(room).min} max={getRoomPriceRange(room).max} step={1} value={room.pricePerNight}
        aria-label="Price per night"
        onInput={e => c.setRoomPrice(room.id, Number((e.target as HTMLInputElement).value))}
      />
      <div class="actions">
        {guest && room.status === 'occupied' && <AskVisitorsButton hostId={guest.id} state={state} />}
        <button onClick={() => c.turnRoomDoor(room.id)} aria-label="Turn door">
          Door {DOOR_ARROWS[room.door]} Turn
        </button>
        {canRepair && (
          <button class="good" disabled={state.cash < ECONOMY.roomRepairCost} onClick={() => c.repairRoom(room.id)}>
            Repair ({formatMoney(ECONOMY.roomRepairCost)})
          </button>
        )}
        {hold?.held && (
          <button onClick={() => c.releaseHold()} title={`It can be booked again; the ${hold.who} takes the best suite free when they come`}>
            Let the hold go
          </button>
        )}
        {hold && !hold.held && (
          <button class="good" onClick={() => c.holdSuite(room.id)} title={`Instead of the suite held now (if any)`}>
            Hold for the {hold.who}
          </button>
        )}
        {canRenovate && (
          <button class="warn" disabled={state.cash < renovationCost || heldBack} onClick={() => c.renovateRoom(room.id)}
            title={heldBack && hold ? `Held for the ${hold.who}: it wouldn't be done by ${hold.when}` : undefined}>
            Renovate ({formatMoney(renovationCost)}, {RENOVATION.durationHours}h)
          </button>
        )}
        {canDemolish && (
          <button class="danger" onClick={() => c.demolishRoom(room.id)}>
            Demolish (+{formatMoney(getDemolishRefund(getRoomInvestedCost(room)))})
          </button>
        )}
      </div>
    </TileCard>
  );
}

/** "Ask the visitors to leave": while a guest has friends in (or on the way up) and nobody's asked yet. */
function AskVisitorsButton({ hostId, state }: { hostId: string; state: HotelState }) {
  const c = useController();
  const host = state.guests.find(g => g.id === hostId);
  if (!host || host.hostedNight?.keptDownAt !== undefined || !isHosting(state, hostId, c.gameTime)) return null;
  const staffed = canAskVisitorsToLeave(state);
  return (
    <button class="warn" disabled={!staffed} title={staffed ? `${PartyLabel(host)} will mind` : 'Nobody at the front desk to ask'}
      onClick={() => c.askVisitorsToLeave(hostId)}>
      Ask {theVisitors(visitorCount(state, hostId))} to leave
    </button>
  );
}

/** Where a checked-in guest is, when they're not in their room: "arriving", "at the Gym", "moving rooms". */
/** Housekeeping time left: "40 min", "1.5h". */
function formatHoursLeft(hours: number): string {
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${hours.toFixed(1)}h`;
}

/** A room between guests: being cleaned, a housekeeper on the way, or waiting (and why). */
function turnoverStatus(cleaning: RoomCleaning | undefined): string {
  if (!cleaning) return 'Cleaned: reopens on the hour';
  const left = formatHoursLeft(cleaning.hoursLeft);
  if (cleaning.phase === 'cleaning') return `Being cleaned (${left} left)`;
  if (cleaning.phase === 'on_the_way') return `Dirty: housekeeper on the way (${left} to clean)`;
  return `Dirty: waiting, ${describeWait(cleaning.wait!)}`;
}

/** A guest's room with a daily clean queued. */
function dailyStatus(cleaning: RoomCleaning): string {
  if (cleaning.phase === 'cleaning') return 'being cleaned';
  if (cleaning.phase === 'on_the_way') return 'housekeeper on the way';
  return `daily clean due (${describeWait(cleaning.wait!)})`;
}

/** "12 min so far". */
function minutesSince(t: number, from: number): string {
  return `${Math.max(1, Math.round((t - from) * 60))} min so far`;
}

/** A time of day, to the hour: "18:00". */
function formatClock(t: number): string {
  return `${String(Math.round(t) % 24).padStart(2, '0')}:00`;
}

export function guestWhereabouts(guest: Guest, state: HotelState, t: number): string | null {
  const trip = guest.trip;
  if (!trip || trip.length === 0 || t >= legsEnd(trip)) return null;
  if (guest.tripKind === 'arrival') {
    // In line at the front desk, or at the counter
    const leg = t >= trip[0].start ? positionAt(trip, t)?.leg : undefined;
    if (leg?.kind === 'stay' && leg.activity === 'wait' && leg.lane) return `in line at the front desk (${minutesSince(t, leg.start)})`;
    if (leg?.kind === 'stay' && leg.activity === 'check_in' && leg.lane) return 'checking in at the front desk';
    return t < trip[0].start ? 'arriving soon' : 'arriving';
  }
  if (guest.tripKind === 'complaint') {
    // Down to the front desk to complain, and back
    if (t < trip[0].start) return null;
    const leg = positionAt(trip, t)?.leg;
    const counter = trip.find(l => l.kind === 'stay' && l.activity === 'complain');
    const about = guest.complaint?.about ?? 'their stay';
    if (leg?.kind === 'stay' && leg.activity === 'complain') return `complaining at the front desk about ${about}`;
    if (leg?.kind === 'stay' && leg.activity === 'wait') return `waiting at the front desk to complain about ${about}`;
    return counter && t < counter.start ? `on the way to the front desk to complain about ${about}` : 'on the way back from the front desk';
  }
  if (t < trip[0].start) return null; // not set out yet
  if (guest.tripKind === 'move') return 'moving rooms';
  if (guest.tripKind === 'outing') {
    const leg = positionAt(trip, t)?.leg;
    if (leg?.kind === 'stay' && leg.activity === 'away') {
      const doing = leg.out === 'beach' ? 'at the beach' : leg.out === 'breakfast' ? 'out for breakfast' : leg.out === 'lunch' ? 'out to lunch' : leg.out === 'dinner' ? 'out to dinner' : awayActivity(guest);
      return `${doing}, back about ${formatClock(leg.end)}`;
    }
    return t < (trip.find(l => l.kind === 'stay')?.start ?? 0) ? 'heading out' : 'back from town';
  }
  const visit = trip.find(l => l.kind === 'stay' && l.activity === 'visit');
  if (!visit || visit.kind !== 'stay') return 'on the way back';
  const facility = state.facilities.find(f => f.id === visit.placeId);
  const label = facility ? FACILITY_CONFIG[facility.type].label : 'a facility';
  if (positionAt(trip, t)?.leg === visit) return `at the ${label}`;
  return t < visit.start ? `off to the ${label}` : `back from the ${label}`;
}

/**
 * A guest's card (picked on the floor plan, or from their room's card): who
 * they are and why they're here, their rhythm, their pace, how they sleep and
 * how loud they are, what they think of their room, their mood, and where they
 * are now. It stays where it was opened while they move about, and closes once
 * they've left the building.
 */
function GuestInspector({ guestId, anchor, state }: { guestId: string; anchor: Tile; state: HotelState }) {
  const c = useController();
  useLiveClock();
  const guest = state.guests.find(g => g.id === guestId);
  if (!guest) {
    // Checked out: on their way out of the building
    const walker = (state.walkers ?? []).find(w => w.guestId === guestId);
    if (!walker) return null;
    const booking = state.bookings.find(b => b.guestId === guestId);
    return (
      <TileCard tile={anchor} title={PartyLabel({ id: guestId, name: walker.name ?? 'Guest', party: walker.party })}>
        <div class="small">{spotlightOn() && walker.spotlight ? `The ${walker.spotlight.kind === 'writer' ? 'travel writer' : 'celebrity'}: ` : ''}{walker.reason === 'walked_out' ? 'Checked out early' : 'Checked out'}, on their way out.</div>
        {booking && <div class="small">Their review: {booking.reviewScore.toFixed(1)}/10{booking.weight && spotlightOn() && walker.spotlight?.kind === 'writer' ? ` (counts ${booking.weight} times over)` : ''}</div>}
        {walker.spent ? <div class="small">Spent {formatMoney(walker.spent)} here</div> : null}
      </TileCard>
    );
  }
  const party = partyOf(guest);
  const room = state.rooms.find(r => r.guestId === guest.id);
  const where = guestWhereabouts(guest, state, c.gameTime);
  const roomLabel = room ? formatRoomLabel(room.gridX, room.gridY, room.floor) : null;
  const asleep = GUEST_PROFILE.enabled && !where && isAsleepAt(state, guest, c.gameTime);
  const visitors = describeVisitors(state, guest.id, c.gameTime);
  const housekeeping = describeHousekeeping(guest);
  // How long they waited to check in, and their complaint this stay
  const waited = guest.checkInWait !== undefined && guest.checkInWait >= 5 / 60 ? `Waited ${Math.round(guest.checkInWait * 60)} min in line to check in` : null;
  const complained = guest.complaint?.at !== undefined
    ? `${guest.complaint.via === 'phone' ? 'Rang the front desk' : 'Complained at the front desk'} about ${guest.complaint.about} (${clockTime(guest.complaint.at)})`
    : null;
  const hidden = moodHidden(guest);
  // Which night of the stay: before they wake, they're still in the night that began yesterday
  const night = Math.min(guest.stayLength, Math.max(1, state.day - guest.checkInDay + (state.hour < sleepHours(guest)[1] ? 0 : 1)));
  const fit = room ? roomFit(profileRoom(room), guest) : null;
  const elsewhere = room && room.floor !== c.currentFloor;
  const favorite = favoriteOf(guest);
  const favoriteLine = favorite ? describeFavorite(guest, facilityStatus(state, favorite), FACILITY_CONFIG[favorite].label) : null;
  const lines = [
    `${capitalize(describeGuest(party, guest.purpose))}${guest.isReturning && !LOYALTY.enabled ? ', back again' : ''}`,
    ...describeSpotlight(guest, state),
    `Night ${night} of ${guest.stayLength}${LOYALTY.enabled ? ` \u00b7 ${describeLoyalty(guest)}` : ''}`,
    ...(favoriteLine ? [favoriteLine] : []),
    ...(housekeeping ? [housekeeping] : []),
    ...(waited ? [waited] : []),
    ...(complained ? [complained] : []),
    ...(guest.profile ? [describeRhythm(guest, state)] : []),
    ...describeTemperament(guest),
    // How they spend (without a profile -- an older save -- what the trait says)
    ...(!guest.profile ? (spendingOn() ? [...guestTags(guest).filter(t => t !== 'big spender').map(capitalize), ...describeSpending(guest)] : guestTags(guest).map(capitalize))
      : spendingOn() ? describeSpending(guest) : guest.trait === 'big_spender' ? ['Big spender'] : []),
  ];
  return (
    <TileCard tile={anchor} title={PartyLabel(guest)}>
      {lines.map(l => <div key={l} class="small">{l}</div>)}
      {fit && (fit.likes.length > 0 || fit.dislikes.length > 0) && (
        <div class="small guest-fit">
          {fit.likes.length > 0 && <span class="good-text">Likes {listFeatures(fit.likes, room ? profileRoom(room).type : undefined)}. </span>}
          {fit.dislikes.length > 0 && <span class="warn-text">Doesn't like {listFeatures(fit.dislikes)}.</span>}
        </div>
      )}
      <pre class="stats">{hidden ? 'Mood:  ? (keeps it to themselves)' : `Mood:  ${formatBar(guest.satisfaction)} ${Math.floor(guest.satisfaction)}%${MOOD.enabled ? ` ${guestMood(guest)}` : ''}`}</pre>
      {visitors && (
        <div class="small visitors">
          {visitors}{' '}<AskVisitorsButton hostId={guest.id} state={state} />
        </div>
      )}
      <div class="small">
        {where ? capitalize(where) : asleep ? 'Asleep in' : 'In'}{!where && roomLabel ? ` room ${roomLabel}` : ''}{' '}
        {room && (
          <button class="link" onClick={() => { c.setFloor(room.floor); c.tileDown({ gridX: room.gridX, gridY: room.gridY }); }}>
            {elsewhere || where ? `(room ${roomLabel}${elsewhere ? ', another floor' : ''})` : '(show the room)'}
          </button>
        )}
      </div>
    </TileCard>
  );
}

function FacilityInspector({ facility, state }: { facility: Facility; state: HotelState }) {
  const c = useController();
  useLiveClock();
  const capacity = facilityCapacity(facility);
  // How full it is (a big party takes more room) and how many people that is
  const inUse = facilityLoad(state, facility.id, c.gameTime);
  const people = peopleInFacility(state, facility.id, c.gameTime);
  const usedBy = state.guests.filter(g => g.facilitiesUsed?.[facility.type as FacilityType]).length;
  const here = guestsInFacility(state, facility.id, c.gameTime);
  // Fans let down today: it was full, or too far to walk to
  const demand = state.facilityDemand?.day === state.day ? state.facilityDemand : null;
  const full = demand?.fullAt?.[facility.id] ?? 0;
  const far = demand?.tooFar[facility.type] ?? 0;
  const turnedBack = [full > 0 && `${full} (full)`, far > 0 && `${far} (too far to walk)`].filter(Boolean).join(', ');
  const config = FACILITY_CONFIG[facility.type];
  const level = FACILITY_LEVELS[facility.level - 1];
  const next = FACILITY_LEVELS[facility.level];
  const upgradeCost = getFacilityUpgradeCost(facility);
  const operating = Math.round(config.dailyOperatingCost * level.operatingMult * getUpkeepMultiplier(state.starRating));
  const renovationCost = getRenovationCost(config.buildCost, state.starRating);

  return (
    <TileCard tile={facility} title={`${config.label}  (Lv ${facility.level}/${FACILITY_LEVELS.length})`}>
      <p class="body small">{config.description}</p>
      <pre class="stats" style={{ marginTop: '6px' }}>
        {[
          `Open hours:     ${openingHours(facility.type)}`,
          `In use:         ${Number.isInteger(inUse) ? inUse : inUse.toFixed(1)}/${capacity}${people > inUse ? ` (${people} people)` : ''}`,
          `Guests who've used one: ${usedBy}`,
          ...(popularWith(facility.type).length > 0 ? [`Popular with:   ${popularWith(facility.type).join(', ')}`] : []),
          ...(GUEST_FAVORITES.enabled ? [`Fans staying:   ${state.guests.filter(g => favoriteOf(g) === facility.type).length}`] : []),
          ...(turnedBack ? [`Turned back today: ${turnedBack}`] : []),
          ...(spendingOn() ? spendLines(facility) : config.spendPerVisit > 0 ? [`Spend/visit:    ${formatMoney(config.spendPerVisit * level.revenueMult)}`] : []),
          `Operating cost: ${formatMoney(operating)}/day`,
          `Decor:          ${facility.decor.toFixed(0)}%${facility.decor < DECOR.freshThreshold ? ' (stale)' : ''}`,
          ...(isFacilityOpen(state, facility) ? [] : ['Door blocked: guests can\'t get in!']),
        ].join('\n')}
      </pre>
      {here.length > 0 && (
        <div class="small here-now">
          Here now:{' '}
          {here.map((g, i) => (
            <span key={g.id}>{i > 0 && ', '}<button class="link" onClick={() => c.selectGuest(g.id, facility)}>{PartyLabel(g)}</button></span>
          ))}
        </div>
      )}
      <div class="actions">
        <button onClick={() => c.turnFacilityDoor(facility.id)} aria-label="Turn door">
          Door {DOOR_ARROWS[facility.door]} Turn
        </button>
        {upgradeCost !== null && next && (
          state.peakStarRating < next.requiredStars
            ? <button disabled>Upgrade to Lv {facility.level + 1}: needs {next.requiredStars}{'★'}</button>
            : <button class="primary" disabled={state.cash < upgradeCost} onClick={() => c.upgradeFacility(facility.id)}>
                Upgrade to Lv {facility.level + 1} ({formatMoney(upgradeCost)})
              </button>
        )}
        {facility.decor < 90 && (
          <button class="warn" disabled={state.cash < renovationCost} onClick={() => c.renovateFacility(facility.id)}>
            Renovate ({formatMoney(renovationCost)})
          </button>
        )}
        <button class="danger" onClick={() => c.demolishFacility(facility.id)}>
          Demolish (+{formatMoney(getDemolishRefund(config.buildCost))})
        </button>
      </div>
    </TileCard>
  );
}
