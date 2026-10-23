import type { RoomType, FacilityType, TileType, Direction, HotelState } from '../simulation/types';
import type { BuildType, PresetTool } from '../game/GameController';
import { ROOM_CONFIG, FACILITY_CONFIG, ELEVATOR, DESK, CLOSET, BREAK_ROOM, ENTRANCE, GUEST_FAVORITES } from '../config/balance';
import { ROOM_PRESETS, PRESET_FOR_TYPE, type PresetId } from '../config/furniture';
import { getRequiredStars, isUnlocked, getRoomBuildCost, presetFor } from '../simulation/HotelState';
import { defaultFurnishing, profileFurnishing } from '../simulation/RoomProfile';
import { getRoomExpectedPrice } from '../simulation/StarRatingManager';
import { useController } from './context';
import { formatMoney, capitalize } from './format';
import { fatigueOn } from '../simulation/StaffFatigue';
import { STAFF_FATIGUE } from '../config/staff';

interface BuildOption {
  type: BuildType;
  label: string;
  cost: number;
  subtitle: string;
  color: string;
  category: 'ROOMS' | 'FACILITIES' | 'SERVICE';
}

const ROOM_COLORS: Record<RoomType, string> = { standard: '#4a90d9', deluxe: '#9b59b6', suite: '#f1c40f' };
const ROOM_TOOLS: Array<RoomType | PresetTool> = ['standard', 'twin', 'bunk_family', 'deluxe', 'deluxe_twin', 'deluxe_family', 'suite'];

/** The category a room tool builds (twin and family rooms are standard rooms). */
const roomTypeOf = (tool: RoomType | PresetId): RoomType => profileFurnishing(defaultFurnishing(presetFor(tool))).type;
const toCss = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

/** Times guests wanted a type of facility the hotel hasn't built over the last week, today included (once per guest a day): demand before the spend. */
function wantedThisWeek(state: HotelState, type: FacilityType): number {
  if (!GUEST_FAVORITES.enabled || state.facilities.some(f => f.type === type)) return 0;
  const today = state.facilityDemand?.day === state.day ? state.facilityDemand.wanted[type] ?? 0 : 0;
  return today + state.dailyStats.filter(s => s.day > state.day - 7 && s.day < state.day).reduce((sum, s) => sum + (s.wanted?.[type] ?? 0), 0);
}

const OPTIONS: BuildOption[] = [
  ...ROOM_TOOLS.map(tool => ({
    type: tool, label: ROOM_PRESETS[presetFor(tool)].label, cost: getRoomBuildCost(tool), subtitle: '', color: ROOM_COLORS[roomTypeOf(tool)], category: 'ROOMS' as const,
  })),
  ...(Object.entries(FACILITY_CONFIG)).map(([type, config]) => ({
    type: type as FacilityType, label: config.label, cost: config.buildCost,
    subtitle: `$${config.dailyOperatingCost}/day`, color: toCss(config.color), category: 'FACILITIES' as const,
  })),
  { type: 'entrance', label: 'Street Entrance', cost: ENTRANCE.buildCost, subtitle: 'ground fl, outer edge', color: '#27ae60', category: 'SERVICE' },
  { type: 'desk', label: 'Check-in Desk', cost: DESK.buildCost, subtitle: `ground fl, ${DESK.staffPerDesk} staff`, color: '#a0522d', category: 'SERVICE' },
  { type: 'closet', label: 'Staff Closet', cost: CLOSET.buildCost, subtitle: 'shorter walks', color: '#16a085', category: 'SERVICE' },
  { type: 'breakroom', label: 'Break Room', cost: BREAK_ROOM.buildCost, subtitle: 'idle staff rest', color: '#8e44ad', category: 'SERVICE' },
  { type: 'elevator', label: 'Elevator', cost: ELEVATOR.buildCost, subtitle: `${ELEVATOR.roomsServed} upper rooms`, color: '#7f8c8d', category: 'SERVICE' },
  { type: 'bulldoze', label: 'Bulldoze', cost: 0, subtitle: 'door/desk/staff/lift', color: '#c0392b', category: 'SERVICE' },
];

export const DOOR_ARROWS: Record<Direction, string> = { up: '↑', right: '→', down: '↓', left: '←' };

const isTile = (type: BuildType): type is TileType => type in ROOM_CONFIG || type in FACILITY_CONFIG;
/** The type whose unlock a build option waits on (a twin or family room: a standard room's). */
const unlockType = (type: BuildType): TileType | null => (isTile(type) ? type : type in ROOM_PRESETS ? roomTypeOf(type as PresetId) : null);

export function BuildPanel() {
  const c = useController();
  const { state } = c;
  let lastCategory = '';

  return (
    <aside class="card build-panel" aria-label="Build">
      {OPTIONS.map(option => {
        const header = option.category !== lastCategory ? option.category : null;
        lastCategory = option.category;
        const gate = unlockType(option.type);
        const locked = gate !== null && !isUnlocked(state, gate);
        const affordable = state.cash >= option.cost;
        const wanted = option.category === 'FACILITIES' ? wantedThisWeek(state, option.type as FacilityType) : 0;
        const subtitle = option.category === 'ROOMS'
          ? `$${getRoomExpectedPrice({ type: roomTypeOf(option.type as RoomType | PresetId), furnishing: defaultFurnishing(presetFor(option.type as RoomType | PresetId)), floor: 0 }, state.starRating)}/nt`
          : option.type === 'breakroom' && fatigueOn() ? `${BREAK_ROOM.seats} rest seats`
          : wanted > 0 ? `asked for ${wanted}\u00d7 this week` : option.subtitle;
        const cost = locked
          ? `🔒 ${getRequiredStars(gate!)}★`
          : option.cost > 0 ? formatMoney(option.cost) : 'Free';

        const doorPicker = (option.category === 'ROOMS' || option.category === 'FACILITIES') && c.tool === option.type && (
          <button class="door-picker" onClick={() => c.rotateDoor()} aria-label={`Door faces ${c.doorDirection}. Rotate door`}>
            Door: {DOOR_ARROWS[c.doorDirection]} {c.doorDirection} <span class="faint">(R to rotate)</span>
          </button>
        );

        return (
          <div key={option.type}>
            {header && <div class="section-label" style={header === 'ROOMS' ? { marginTop: 0 } : undefined}>{header}</div>}
            <button
              class={`build-option${c.tool === option.type ? ' selected' : ''}${locked ? ' locked' : ''}`}
              style={{ '--option-color': option.color }}
              disabled={locked}
              aria-pressed={c.tool === option.type}
              title={option.type === 'breakroom' && fatigueOn() ? `${BREAK_ROOM.seats} staff can rest here at once. Rest restores ${STAFF_FATIGUE.roomRecovery} energy/hour, versus ${STAFF_FATIGUE.fallbackRecovery} elsewhere. Shorter walks leave more time to recover.` : undefined}
              onClick={() => c.selectTool(option.type)}
            >
              <div class="name">{option.label}</div>
              <div class="details">
                <span class={!locked && !affordable ? 'unaffordable' : ''}>{cost}</span>
                <span class="sub">{subtitle}</span>
              </div>
            </button>
            {doorPicker}
          </div>
        );
      })}
    </aside>
  );
}
