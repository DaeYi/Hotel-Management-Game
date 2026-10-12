import type { ComponentChildren } from 'preact';
import type { Room, Facility, HotelState, Guest, FacilityType } from '../simulation/types';
import { ROOM_CONFIG, ECONOMY, AMENITIES, DECOR, RENOVATION, GRID, FACILITY_CONFIG, FACILITY_LEVELS } from '../config/balance';
import {
  formatRoomLabel, getDemolishRefund, isFacilityOpen, getRenovationCost, isRoomReachable, getFacilityUpgradeCost, getRoomInvestedCost, getRoomPriceRange,
} from '../simulation/HotelState';
import { getRoomExpectedPrice, getUpkeepMultiplier } from '../simulation/StarRatingManager';
import { calculateRoomNoise } from '../simulation/NoiseManager';
import { DOOR_ARROWS } from './BuildPanel';
import { RoomPlan } from './RoomPlan';
import { profileRoom, profileFurnishing, furnishingOf, whoFits } from '../simulation/RoomProfile';
import { partyOf } from '../simulation/Party';
import { describeGuest, awayActivity, popularWith } from '../simulation/Purpose';
import { roomFit, listFeatures } from '../simulation/Preferences';
import { RoomSuits } from './RoomSuits';
import type { GuestTrait } from '../simulation/types';

/** How a guest's trait reads (the loud trait is "rowdy": not to be confused with a party of people). */
const TRAIT_LABELS: Record<GuestTrait, string> = { normal: '', light_sleeper: 'light sleeper', big_spender: 'big spender', party_guest: 'rowdy' };
import { getStaffTravelHours } from '../simulation/Layout';
import { positionAt, legsEnd } from '../simulation/Movement';
import { facilityCapacity, facilityLoad, peopleInFacility, openingHours } from '../simulation/FacilityManager';
import { roomCleaningAt, describeWait, type RoomCleaning } from '../simulation/CleaningStatus';
import { useController, useLiveClock } from './context';
import { formatBar, formatMoney, formatWalk, capitalize } from './format';

/** The inspector for whatever's selected on the grid, if anything. */
export function Inspector() {
  const c = useController();
  const { state, selection } = c;
  if (!selection) return null;
  if (selection.kind === 'room') {
    const room = state.rooms.find(r => r.id === selection.id);
    return room ? <RoomInspector room={room} state={state} /> : null;
  }
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
    status = `Occupied${guest ? `: ${describeGuest(partyOf(guest), guest.purpose)}${TRAIT_LABELS[guest.trait] ? ` (${TRAIT_LABELS[guest.trait]})` : ''}` : ''}${where ? `, ${where}` : ''}`;
  }
  else if (room.status === 'cleaning') status = turnoverStatus(cleaning);
  else if (room.status === 'renovating') status = `Renovating (${room.renovationHoursRemaining}h left)`;
  else if (room.condition <= ECONOMY.roomBreakdownThreshold) status = 'OUT OF ORDER';
  else status = isRoomReachable(state, room) ? 'Vacant' : 'Door blocked: no hallway access!';
  // What the guest staying likes (or doesn't) about the room: part of their review
  const fit = room.status === 'occupied' && guest ? roomFit(profile, guest) : null;

  const stats = [
    `Status:      ${status}`,
    `Condition:   ${formatBar(room.condition)} ${room.condition.toFixed(0)}%`,
    `Cleanliness: ${formatBar(room.cleanliness)} ${room.cleanliness.toFixed(0)}%${cleaning?.job === 'daily' ? `, ${dailyStatus(cleaning)}` : ''}`,
    `Decor:       ${formatBar(room.decor)} ${room.decor.toFixed(0)}%${room.decor < DECOR.freshThreshold ? ' stale' : ''}`,
    `Amenities:   ${AMENITIES.tiers[state.amenities[room.type]]?.label ?? 'Basic'}`,
    `Noise:       ${noiseLabel(calculateRoomNoise(room, state))}`,
    `Staff walk:  ${formatWalk(getStaffTravelHours(state, room))}`,
  ];

  const canRepair = room.condition < 80 && room.status === 'vacant';
  const canRenovate = room.status === 'vacant' && room.decor < 90;
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
        <button onClick={() => c.turnRoomDoor(room.id)} aria-label="Turn door">
          Door {DOOR_ARROWS[room.door]} Turn
        </button>
        {canRepair && (
          <button class="good" disabled={state.cash < ECONOMY.roomRepairCost} onClick={() => c.repairRoom(room.id)}>
            Repair ({formatMoney(ECONOMY.roomRepairCost)})
          </button>
        )}
        {canRenovate && (
          <button class="warn" disabled={state.cash < renovationCost} onClick={() => c.renovateRoom(room.id)}>
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

/** A time of day, to the hour: "18:00". */
function formatClock(t: number): string {
  return `${String(Math.round(t) % 24).padStart(2, '0')}:00`;
}

function guestWhereabouts(guest: Guest, state: HotelState, t: number): string | null {
  const trip = guest.trip;
  if (!trip || trip.length === 0 || t >= legsEnd(trip)) return null;
  if (guest.tripKind === 'arrival') return t < trip[0].start ? 'arriving soon' : 'arriving';
  if (t < trip[0].start) return null; // not set out yet
  if (guest.tripKind === 'move') return 'moving rooms';
  if (guest.tripKind === 'outing') {
    const leg = positionAt(trip, t)?.leg;
    if (leg?.kind === 'stay' && leg.activity === 'away') return `${awayActivity(guest)}, back about ${formatClock(leg.end)}`;
    return t < (trip.find(l => l.kind === 'stay')?.start ?? 0) ? 'heading out' : 'back from town';
  }
  const visit = trip.find(l => l.kind === 'stay' && l.activity === 'visit');
  if (!visit || visit.kind !== 'stay') return 'on the way back';
  const facility = state.facilities.find(f => f.id === visit.placeId);
  const label = facility ? FACILITY_CONFIG[facility.type].label : 'a facility';
  if (positionAt(trip, t)?.leg === visit) return `at the ${label}`;
  return t < visit.start ? `off to the ${label}` : `back from the ${label}`;
}

function FacilityInspector({ facility, state }: { facility: Facility; state: HotelState }) {
  const c = useController();
  useLiveClock();
  const capacity = facilityCapacity(facility);
  // How full it is (a big party takes more room) and how many people that is
  const inUse = facilityLoad(state, facility.id, c.gameTime);
  const people = peopleInFacility(state, facility.id, c.gameTime);
  const usedBy = state.guests.filter(g => g.facilitiesUsed?.[facility.type as FacilityType]).length;
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
          ...(config.spendPerVisit > 0 ? [`Spend/visit:    ${formatMoney(config.spendPerVisit * level.revenueMult)}`] : []),
          `Operating cost: ${formatMoney(operating)}/day`,
          `Decor:          ${facility.decor.toFixed(0)}%${facility.decor < DECOR.freshThreshold ? ' (stale)' : ''}`,
          ...(isFacilityOpen(state, facility) ? [] : ['Door blocked: guests can\'t get in!']),
        ].join('\n')}
      </pre>
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
