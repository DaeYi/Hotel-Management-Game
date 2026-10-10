import type { ComponentChildren } from 'preact';
import type { Room, Facility, HotelState } from '../simulation/types';
import { ROOM_CONFIG, ECONOMY, AMENITIES, DECOR, RENOVATION, GRID, FACILITY_CONFIG, FACILITY_LEVELS } from '../config/balance';
import {
  formatRoomLabel, getDemolishRefund, getRenovationCost, isRoomReachable, getFacilityUpgradeCost,
} from '../simulation/HotelState';
import { getExpectedPrice, getUpkeepMultiplier } from '../simulation/StarRatingManager';
import { calculateRoomNoise } from '../simulation/NoiseManager';
import { getStaffTravelHours } from '../simulation/Layout';
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
  const config = ROOM_CONFIG[room.type];
  const guest = state.guests.find(g => g.id === room.guestId);
  const fair = getExpectedPrice(room.type, state.starRating, room.floor);

  let status: string;
  if (room.status === 'occupied') status = `Occupied (${guest?.trait ?? 'unknown'})`;
  else if (room.status === 'cleaning') status = `Cleaning (${Math.ceil(room.cleaningHoursRemaining)}h left)`;
  else if (room.status === 'renovating') status = `Renovating (${room.renovationHoursRemaining}h left)`;
  else if (room.condition <= ECONOMY.roomBreakdownThreshold) status = 'OUT OF ORDER';
  else status = isRoomReachable(state, room) ? 'Vacant' : 'No hallway access!';

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
    <TileCard tile={room} title={`${capitalize(room.type)} Room ${formatRoomLabel(room.gridX, room.gridY, room.floor)}`}>
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

function FacilityInspector({ facility, state }: { facility: Facility; state: HotelState }) {
  const c = useController();
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
        {`Operating cost: ${formatMoney(operating)}/day\nDecor: ${facility.decor.toFixed(0)}%${facility.decor < DECOR.freshThreshold ? ' (stale)' : ''}`}
      </pre>
      <div class="actions">
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
