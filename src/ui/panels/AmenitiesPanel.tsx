import type { RoomType, AmenityTier } from '../../simulation/types';
import { AMENITIES } from '../../config/balance';
import { amenityCostTonight } from '../../simulation/EconomyManager';
import { guestsById } from '../../simulation/Party';
import { useController } from '../context';
import { formatMoney, capitalize } from '../format';
import { PanelCard } from './PanelCard';

const TIERS: AmenityTier[] = ['basic', 'premium', 'luxury'];
const ROOM_TYPES: RoomType[] = ['standard', 'deluxe', 'suite'];

export function AmenitiesPanel() {
  const c = useController();
  const { state } = c;

  // Amenities are used up by guests: charged per occupied room, as the simulation does (more for bigger parties)
  const occupied: Record<RoomType, number> = { standard: 0, deluxe: 0, suite: 0 };
  const cost: Record<RoomType, number> = { standard: 0, deluxe: 0, suite: 0 };
  const guests = guestsById(state);
  for (const room of state.rooms) {
    if (room.status !== 'occupied') continue;
    occupied[room.type]++;
    cost[room.type] += amenityCostTonight(state, room, guests);
  }
  const costFor = (type: RoomType) => cost[type];
  const total = ROOM_TYPES.reduce((sum, type) => sum + costFor(type), 0);

  return (
    <PanelCard title="IN-ROOM AMENITIES">
      {ROOM_TYPES.map(type => (
        <div key={type} style={{ marginBottom: '8px' }}>
          <div class="row">
            <span class="body small" style={{ width: '72px' }}>{capitalize(type)}:</span>
            {TIERS.map(tier => (
              <button key={tier} class={state.amenities[type] === tier ? 'chosen' : ''} aria-pressed={state.amenities[type] === tier}
                onClick={() => c.setAmenity(type, tier)}>{AMENITIES.tiers[tier].label}</button>
            ))}
          </div>
          <div class="faint tiny" style={{ marginLeft: '78px' }}>
            {occupied[type]} occupied x {formatMoney(AMENITIES.tiers[state.amenities[type]].dailyCostPerRoom)}{costFor(type) > occupied[type] * AMENITIES.tiers[state.amenities[type]].dailyCostPerRoom + 0.5 ? ' (more for big parties)' : ''} = {formatMoney(costFor(type))}/night
          </div>
        </div>
      ))}
      <hr class="divider" />
      {TIERS.map(tier => {
        const t = AMENITIES.tiers[tier];
        return (
          <div key={tier} class="dim tiny" style={{ marginBottom: '4px' }}>
            <span class="body">{t.label}</span>: {t.description}. {formatMoney(t.dailyCostPerRoom)}/occupied room (+30% per guest beyond two), review +{t.reviewBonus.toFixed(1)}
          </div>
        );
      })}
      <div class="gold small" style={{ marginTop: '6px' }}>Amenity cost tonight: {formatMoney(total)}</div>
    </PanelCard>
  );
}
