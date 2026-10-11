import type { Furnishing } from '../simulation/types';
import { profileFurnishing, wallBar, pillowRect } from '../simulation/RoomProfile';
import { FURNITURE, ROOM_CELLS } from '../config/furniture';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

interface RoomPlanProps {
  furnishing: Furnishing;
  size?: number;
  selected?: string | null; // a piece's id: drawn with a white edge
  ghost?: { x: number; y: number; w: number; h: number; ok: boolean } | null; // where a piece would go
  onCell?: (x: number, y: number) => void; // a floor cell clicked (editing)
  onItem?: (id: string) => void; // a piece clicked (editing)
  cellsOnTop?: boolean; // cells over the pieces: tapping anywhere picks a cell (putting a piece down)
}

/**
 * A room seen from above, door at the bottom: its furniture drawn from the same
 * data the floor plan and the simulation use. Premium pieces have a gold edge;
 * pieces with a problem (in the way, can't be reached) a red one. Given
 * onCell/onItem it's the furnishing editor's canvas: cells and pieces are
 * buttons, so it works by tapping (and keyboard) as well as clicking.
 */
export function RoomPlan({ furnishing, size = 120, selected, ghost, onCell, onItem, cellsOnTop }: RoomPlanProps) {
  const cell = size / ROOM_CELLS;
  const { items, issues } = profileFurnishing(furnishing);
  const bad = new Set(issues.map(i => i.itemId).filter(Boolean));
  const editing = !!(onCell || onItem);
  const stroke = (id: string, tier: number) => (id === selected ? '#ffffff' : bad.has(id) ? '#e74c3c' : tier === 2 ? '#f1c40f' : '#555');
  const strokeWidth = (id: string, tier: number) => (id === selected || bad.has(id) || tier === 2 ? 2 : 1);
  const press = (fn: () => void) => ({
    onClick: (e: Event) => { e.stopPropagation(); fn(); },
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } },
  });

  const cells = onCell && Array.from({ length: ROOM_CELLS * ROOM_CELLS }, (_, i) => {
    const x = i % ROOM_CELLS;
    const y = Math.floor(i / ROOM_CELLS);
    return (
      <rect key={`cell-${i}`} class="plan-cell" x={x * cell} y={y * cell} width={cell} height={cell} fill="transparent"
        role="button" tabIndex={0} aria-label={`Cell ${x + 1}, ${y + 1}`} {...press(() => onCell(x, y))} />
    );
  });

  return (
    <svg class={`room-plan${editing ? ' editing' : ''}`} width={size} height={size + 6} viewBox={`0 0 ${size} ${size + 6}`} role={editing ? 'group' : 'img'} aria-label="Room plan">
      <rect x={0.5} y={0.5} width={size - 1} height={size - 1} fill="#2b2b45" stroke="#8e8e9e" />
      {Array.from({ length: ROOM_CELLS - 1 }, (_, i) => (
        <g key={i} stroke="#3a3a58" stroke-width={0.5}>
          <line x1={(i + 1) * cell} y1={0} x2={(i + 1) * cell} y2={size} />
          <line x1={0} y1={(i + 1) * cell} x2={size} y2={(i + 1) * cell} />
        </g>
      ))}
      {onCell && !cellsOnTop && cells}
      {ghost && (
        <rect x={ghost.x * cell + 1} y={ghost.y * cell + 1} width={ghost.w * cell - 2} height={ghost.h * cell - 2} rx={2}
          fill={ghost.ok ? 'rgba(46, 204, 113, 0.25)' : 'rgba(231, 76, 60, 0.25)'} stroke={ghost.ok ? '#2ecc71' : '#e74c3c'} stroke-dasharray="4 3" pointer-events="none" />
      )}
      {items.filter(i => !i.wall).map(item => {
        const spec = FURNITURE[item.kind];
        const head = pillowRect(item);
        return (
          <g key={item.id} class={onItem ? 'plan-item' : undefined}
            {...(onItem ? { role: 'button', tabIndex: 0, 'aria-label': `${spec.label}${item.tier === 2 ? ' (premium)' : ''}`, ...press(() => onItem(item.id)) } : {})}>
            <rect
              x={item.x * cell + 2} y={item.y * cell + 2} width={item.w * cell - 4} height={item.h * cell - 4} rx={2}
              fill={hex(spec.color)} stroke={stroke(item.id, item.tier)} stroke-width={strokeWidth(item.id, item.tier)}
            >
              <title>{`${spec.label}${item.tier === 2 ? ' (premium)' : ''}`}</title>
            </rect>
            {item.group === 'bed' && <rect x={head.x * cell} y={head.y * cell} width={head.w * cell} height={head.h * cell} rx={2} fill="#d0d3d4" pointer-events="none" />}
            {item.kind === 'bunk' && (
              <rect x={item.x * cell + 2} y={(item.y + item.h / 2) * cell - 1} width={item.w * cell - 4} height={2} fill="#7f8c8d" pointer-events="none" />
            )}
          </g>
        );
      })}
      {items.filter(i => i.wall).map(item => {
        // Inset along the wall, 3px thick, on the edge of its cell it hangs on
        const spec = FURNITURE[item.kind];
        const bar = wallBar(item, 3 / cell);
        const along = bar.w > bar.h;
        const color = item.id === selected ? '#ffffff' : bad.has(item.id) ? '#e74c3c' : item.tier === 2 ? '#f1c40f' : 'none';
        return (
          <g key={item.id} class={onItem ? 'plan-item' : undefined}
            {...(onItem ? { role: 'button', tabIndex: 0, 'aria-label': `${spec.label}${item.tier === 2 ? ' (premium)' : ''}`, ...press(() => onItem(item.id)) } : {})}>
            {/* A bigger target than the bar itself, for tapping */}
            {onItem && <rect x={bar.x * cell - 4} y={bar.y * cell - 4} width={bar.w * cell + 8} height={bar.h * cell + 8} fill="transparent" />}
            <rect
              x={bar.x * cell + (along ? 3 : 0)} y={bar.y * cell + (along ? 0 : 3)}
              width={bar.w * cell - (along ? 6 : 0)} height={bar.h * cell - (along ? 0 : 6)}
              fill={hex(spec.color === 0x17202a ? 0xbdc3c7 : spec.color)} stroke={color} stroke-width={color === 'none' ? 0 : 1.5}>
              <title>{spec.label}</title>
            </rect>
          </g>
        );
      })}
      {onCell && cellsOnTop && cells}
      {/* The door, on the bottom edge */}
      <rect x={size * 0.3} y={size - 2} width={size * 0.4} height={4} fill="#d8d8e8" pointer-events="none" />
    </svg>
  );
}
