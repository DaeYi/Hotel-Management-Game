import type { Furnishing } from '../simulation/types';
import { profileFurnishing, wallBar } from '../simulation/RoomProfile';
import { FURNITURE, ROOM_CELLS } from '../config/furniture';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/**
 * A room seen from above, door at the bottom: its furniture drawn from the same
 * data the floor plan and the simulation use. Premium pieces have a gold edge.
 */
export function RoomPlan({ furnishing, size = 120, highlight }: { furnishing: Furnishing; size?: number; highlight?: string }) {
  const cell = size / ROOM_CELLS;
  const { items } = profileFurnishing(furnishing);
  return (
    <svg class="room-plan" width={size} height={size + 6} viewBox={`0 0 ${size} ${size + 6}`} role="img" aria-label="Room plan">
      <rect x={0.5} y={0.5} width={size - 1} height={size - 1} fill="#2b2b45" stroke="#8e8e9e" />
      {Array.from({ length: ROOM_CELLS - 1 }, (_, i) => (
        <g key={i} stroke="#3a3a58" stroke-width={0.5}>
          <line x1={(i + 1) * cell} y1={0} x2={(i + 1) * cell} y2={size} />
          <line x1={0} y1={(i + 1) * cell} x2={size} y2={(i + 1) * cell} />
        </g>
      ))}
      {items.filter(i => !i.wall).map(item => {
        const spec = FURNITURE[item.kind];
        return (
          <g key={item.slot}>
            <rect
              x={item.x * cell + 2} y={item.y * cell + 2} width={item.w * cell - 4} height={item.h * cell - 4} rx={2}
              fill={hex(spec.color)} stroke={item.tier === 2 ? '#f1c40f' : highlight === item.slot ? '#fff' : '#555'}
              stroke-width={item.tier === 2 || highlight === item.slot ? 2 : 1}
            >
              <title>{`${spec.label}${item.tier === 2 ? ' (premium)' : ''}`}</title>
            </rect>
            {item.slot === 'bed' && <rect x={item.x * cell + 5} y={item.y * cell + 5} width={item.w * cell - 10} height={cell * 0.35} rx={2} fill="#d0d3d4" />}
          </g>
        );
      })}
      {items.filter(i => i.wall).map(item => {
        // Inset along the wall, 3px thick, on the edge of its cell it hangs on
        const bar = wallBar(item, 3 / cell);
        const along = bar.w > bar.h;
        return (
          <rect key={item.slot}
            x={bar.x * cell + (along ? 3 : 0)} y={bar.y * cell + (along ? 0 : 3)}
            width={bar.w * cell - (along ? 6 : 0)} height={bar.h * cell - (along ? 0 : 6)}
            fill={hex(FURNITURE[item.kind].color === 0x17202a ? 0xbdc3c7 : FURNITURE[item.kind].color)}
            stroke={item.tier === 2 ? '#f1c40f' : 'none'}>
            <title>{FURNITURE[item.kind].label}</title>
          </rect>
        );
      })}
      {/* The door, on the bottom edge */}
      <rect x={size * 0.3} y={size - 2} width={size * 0.4} height={4} fill="#d8d8e8" />
    </svg>
  );
}
