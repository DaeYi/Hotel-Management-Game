import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Room, Facility, HotelState, Guest, FacilityType } from '../simulation/types';
import { ROOM_CONFIG, ECONOMY, AMENITIES, DECOR, RENOVATION, GRID, FACILITY_CONFIG, FACILITY_LEVELS } from '../config/balance';
import {
  formatRoomLabel, getDemolishRefund, isFacilityOpen, getRenovationCost, isRoomReachable, getFacilityUpgradeCost,
} from '../simulation/HotelState';
import { getExpectedPrice, getUpkeepMultiplier } from '../simulation/StarRatingManager';
import { calculateRoomNoise } from '../simulation/NoiseManager';
import { DOOR_ARROWS } from './BuildPanel';
import { RoomPlan } from './RoomPlan';
import { profileRoom, profileFurnishing, furnishingOf } from '../simulation/RoomProfile';
import { getStaffTravelHours } from '../simulation/Layout';
import { positionAt, legsEnd } from '../simulation/Movement';
import { facilityCapacity, guestsInFacility, openingHours } from '../simulation/FacilityManager';
import { useController } from './context';
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

/** Re-render every so often while the clock runs, so what's shown (who's where) keeps up with the game. */
function useLiveClock(ms = 250) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
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
  const fair = getExpectedPrice(room.type, state.starRating, room.floor);

  let status: string;
  if (room.status === 'occupied') {
    const where = guest ? guestWhereabouts(guest, state, c.gameTime) : null;
    status = `Occupied (${guest?.trait ?? 'unknown'})${where ? `, ${where}` : ''}`;
  }
  else if (room.status === 'cleaning') status = `Cleaning (${Math.ceil(room.cleaningHoursRemaining)}h left)`;
  else if (room.status === 'renovating') status = `Renovating (${room.renovationHoursRemaining}h left)`;
  else if (room.condition <= ECONOMY.roomBreakdownThreshold) status = 'OUT OF ORDER';
  else status = isRoomReachable(state, room) ? 'Vacant' : 'Door blocked: no hallway access!';

  const stats = [
    `Status:      ${status}`,
    `Condition:   ${formatBar(room.condition)} ${room.condition.toFixed(0)}%`,
    `Cleanliness: ${formatBar(room.cleanliness)} ${room.cleanliness.toFixed(0)}%`,
    `Decor:       ${formatBar(room.decor)} ${room.decor.toFixed(0)}%${room.decor < DECOR.freshThreshold ? ' stale' : ''}`,
    `Amenities:   ${AMENITIES.tiers[state.amenities[room.type]]?.label ?? 'Basic'}`,
    `Noise:       ${noiseLabel(calculateRoomNoise(room, state))}`,
    `Staff walk:  ${formatWalk(getStaffTravelHours(state, room))}`,
  ];

  const canRepair = room.condition < 80 && room.status === 'vacant';
  const canRenovate = room.status === 'vacant' && room.decor < 90;
  const renovationCost = getRenovationCost(config.buildCost, state.starRating);
  const canDemolish = room.status !== 'occupied' && room.status !== 'renovating';

  return (
    <TileCard tile={room} title={`${profile.label} ${formatRoomLabel(room.gridX, room.gridY, room.floor)}`}>
      <div class="room-furnishing">
        <RoomPlan furnishing={furnishingOf(room)} size={64} />
        <div>
          <div class="small">{capitalize(room.type)} room{' \u00b7 '}sleeps {profile.sleeps}</div>
          {room.pendingRefit && <div class="small gold">Refit booked: {profileFurnishing(room.pendingRefit).label}</div>}
          <button onClick={() => c.openFurnishing(room.id)}>Furnish{'\u2026'}</button>
        </div>
      </div>
      <pre class="stats">{stats.join('\n')}</pre>
      <label class="price-row">
        <span>Price/night (fair {formatMoney(fair)}):</span>
        <span class="price">{formatMoney(room.pricePerNight)}</span>
      </label>
      <input
        type="range" min={config.minPrice} max={config.maxPrice} step={1} value={room.pricePerNight}
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
            Demolish (+{formatMoney(getDemolishRefund(config.buildCost))})
          </button>
        )}
      </div>
    </TileCard>
  );
}

/** Where a checked-in guest is, when they're not in their room: "arriving", "at the Gym", "moving rooms". */
function guestWhereabouts(guest: Guest, state: HotelState, t: number): string | null {
  const trip = guest.trip;
  if (!trip || trip.length === 0 || t >= legsEnd(trip)) return null;
  if (guest.tripKind === 'arrival') return t < trip[0].start ? 'arriving soon' : 'arriving';
  if (t < trip[0].start) return null; // not set out yet
  if (guest.tripKind === 'move') return 'moving rooms';
  if (guest.tripKind === 'outing') {
    const leg = positionAt(trip, t)?.leg;
    if (leg?.kind === 'stay' && leg.activity === 'away') return 'out for the day';
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
  const inUse = guestsInFacility(state, facility.id, c.gameTime).length;
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
          `In use:         ${inUse}/${capacity}`,
          `Guests who've used one: ${usedBy}`,
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
