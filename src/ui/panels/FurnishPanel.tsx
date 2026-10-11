import { useState } from 'preact/hooks';
import type { Furnishing, FurnitureItem, Room } from '../../simulation/types';
import {
  ROOM_PRESETS, GROUP_KINDS, GROUP_LABELS, FURNITURE, ROOM_CELLS,
  type PresetId, type Tier, type FurnitureKind, type FurnitureGroup, type Rot, type ArrangementId,
} from '../../config/furniture';
import {
  furnishingOf, quoteRefit, validateFurnishing, switchPreset, isFurnitureUnlocked, setArrangement, mirrorFurnishing,
  profileFurnishing, placeItem, classPriceFactor,
} from '../../simulation/RoomProfile';
import { formatRoomLabel, roomsToRefitLike } from '../../simulation/HotelState';
import { getExpectedPrice } from '../../simulation/StarRatingManager';
import { useController } from '../context';
import { formatMoney } from '../format';
import { PanelCard } from './PanelCard';
import { RoomPlan } from '../RoomPlan';

/**
 * Furnish a room: start from a preset, choose where the bathroom goes, and
 * arrange the furniture -- swap or upgrade a piece, move it, turn it, take it
 * out, or add another (a second bed, a sofa bed). The furniture decides what
 * the room is (its label, who it sleeps, its fair price), shown live; a room
 * that doesn't work (no bed, a piece nobody can reach) can't be refitted to.
 * The change happens now if the room is empty -- it closes for the fitting --
 * or after its guest leaves; and can be copied to every room laid out alike.
 */
export function FurnishPanel() {
  const c = useController();
  const room = c.state.rooms.find(r => r.id === c.furnishRoomId);
  if (!room) return null;
  return <FurnishEditor key={room.id} room={room} />;
}

/** What tapping the plan does: pick a piece, put a new one down, or move the picked one. */
type Mode = { kind: 'pick' } | { kind: 'add'; piece: FurnitureKind } | { kind: 'move'; id: string };

const PALETTE: FurnitureKind[] = ['bed_single', 'bed_queen', 'bed_king', 'bunk', 'sofa_bed', 'sofa', 'armchair', 'desk', 'rail', 'wardrobe', 'tv', 'art', 'bath_shower', 'bath_tub'];

/** A fresh id for a new piece of a group: 'bed-2', 'tv-3'. */
function newId(items: FurnitureItem[], group: FurnitureGroup): string {
  const used = new Set(items.map(i => i.id));
  if (!used.has(group)) return group;
  let n = 2;
  while (used.has(`${group}-${n}`)) n++;
  return `${group}-${n}`;
}

/** A piece moved so its top-left is at (x, y), kept on the grid. */
function placedAt(item: FurnitureItem, x: number, y: number): FurnitureItem {
  const { w, h } = placeItem({ ...item, x: 0, y: 0 });
  return { ...item, x: Math.max(0, Math.min(ROOM_CELLS - w, x)), y: Math.max(0, Math.min(ROOM_CELLS - h, y)) };
}

function FurnishEditor({ room }: { room: Room }) {
  const c = useController();
  const { state } = c;
  const current = furnishingOf(room);
  const [draft, setDraft] = useState<Furnishing>(room.pendingRefit ?? current);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'pick' });
  const quote = quoteRefit(current, draft);
  const after = profileFurnishing(draft);
  const problem = validateFurnishing(draft, state.peakStarRating);
  const unchanged = quote.changed.length === 0 && !quote.moved;
  const vacant = room.status === 'vacant';
  // "Rooms like this one" are the ones with the layout this room has now
  const others = roomsToRefitLike(state, draft, current.preset, room.id);
  const othersCost = others.reduce((sum, r) => sum + quoteRefit(furnishingOf(r), draft).cost, 0);
  const later = room.status === 'occupied' ? 'after checkout' : room.status === 'cleaning' ? 'after cleaning' : 'when it reopens';
  const waiting = room.pendingRefit && vacant ? quoteRefit(current, room.pendingRefit).cost : null;
  const sameAsBooked = !!room.pendingRefit && (() => {
    const q = quoteRefit(room.pendingRefit, draft);
    return q.changed.length === 0 && !q.moved;
  })();
  const affordable = state.cash >= quote.cost;
  const fair = (f: Furnishing) => {
    const p = profileFurnishing(f);
    return Math.round(getExpectedPrice(p.type, state.starRating, room.floor) * classPriceFactor(p));
  };
  const item = draft.items.find(i => i.id === selected) ?? null;

  /** Change the pieces: the layout is the player's own from here. */
  const edit = (items: FurnitureItem[]) => setDraft({ ...draft, custom: true, items });
  const update = (id: string, change: Partial<FurnitureItem>) => edit(draft.items.map(i => (i.id === id ? { ...i, ...change } : i)));
  const unlocked = (kind: FurnitureKind, tier: Tier = 1) => isFurnitureUnlocked(kind, tier, state.peakStarRating);

  const onCell = (x: number, y: number) => {
    if (mode.kind === 'add') {
      const id = newId(draft.items, FURNITURE[mode.piece].group);
      edit([...draft.items, placedAt({ id, kind: mode.piece, tier: 1, x: 0, y: 0, rot: 0 }, x, y)]);
      setSelected(id);
      setMode({ kind: 'pick' });
    } else if (mode.kind === 'move') {
      const moving = draft.items.find(i => i.id === mode.id);
      if (moving) update(moving.id, placedAt(moving, x, y));
      setMode({ kind: 'pick' });
    } else {
      // Tapping the floor picks whatever's there
      const hit = after.items.find(i => !i.wall && x >= i.x && x < i.x + i.w && y >= i.y && y < i.y + i.h);
      setSelected(hit ? hit.id : null);
    }
  };
  const placing = mode.kind !== 'pick';
  const hint = mode.kind === 'add' ? `Tap where the ${FURNITURE[mode.piece].label.toLowerCase()} goes (its top-left corner)`
    : mode.kind === 'move' ? 'Tap where it goes (its top-left corner)'
    : 'Tap a piece to change it';

  return (
    <PanelCard title={`FURNISH ROOM ${formatRoomLabel(room.gridX, room.gridY, room.floor)}`}>
      <div class="furnish">
        <div class="furnish-top">
          <RoomPlan furnishing={draft} size={160} selected={selected}
            onCell={onCell} onItem={placing ? undefined : id => setSelected(id === selected ? null : id)} cellsOnTop={placing} />
          <div class="furnish-summary">
            <div class="dim small">Now</div>
            <div>{quote.before.label}</div>
            <div class="dim small">Sleeps {quote.before.sleeps} · {formatMoney(fair(current))}/night fair</div>
            {!unchanged && (
              <>
                <div class="dim small" style={{ marginTop: '6px' }}>After</div>
                <div class={after.type !== quote.before.type || after.layoutClass !== quote.before.layoutClass ? 'gold' : ''}>{after.label}</div>
                <div class="dim small">Sleeps {after.sleeps}{after.beds < after.sleeps ? ` (${after.beds} in separate beds)` : ''} · {formatMoney(fair(draft))}/night fair</div>
              </>
            )}
          </div>
        </div>
        <div class="dim small furnish-hint" aria-live="polite">
          {hint}{placing && <> <button class="link" onClick={() => setMode({ kind: 'pick' })}>Cancel</button></>}
        </div>

        {item && !placing && <PieceEditor item={item} draft={draft} unlocked={unlocked}
          onChange={change => update(item.id, change)}
          onMove={() => setMode({ kind: 'move', id: item.id })}
          onRemove={() => { edit(draft.items.filter(i => i.id !== item.id)); setSelected(null); }} />}

        <div class="section-label">ADD</div>
        <div class="row-buttons palette">
          {PALETTE.map(kind => (
            <button key={kind} aria-pressed={mode.kind === 'add' && mode.piece === kind} disabled={!unlocked(kind)}
              title={unlocked(kind) ? '' : `Needs ${FURNITURE[kind].requiredStars}★`}
              onClick={() => { setSelected(null); setMode(mode.kind === 'add' && mode.piece === kind ? { kind: 'pick' } : { kind: 'add', piece: kind }); }}>
              {FURNITURE[kind].label}{unlocked(kind) ? '' : ` ${FURNITURE[kind].requiredStars}★`}
            </button>
          ))}
        </div>

        <div class="section-label">START FROM</div>
        <div class="row-buttons">
          {(Object.keys(ROOM_PRESETS) as PresetId[]).map(id => {
            const next = switchPreset(draft, id);
            const locked = next.items.some(i => !unlocked(i.kind, i.tier));
            return (
              <button key={id} aria-pressed={draft.preset === id && !draft.custom} disabled={locked}
                title={locked ? 'Needs a higher star rating' : ''} onClick={() => { setDraft(next); setSelected(null); }}>
                {ROOM_PRESETS[id].label}
              </button>
            );
          })}
        </div>
        <div class="section-label">BATHROOM</div>
        <div class="row-buttons">
          {(['bath_front', 'bath_back'] as ArrangementId[]).map(a => (
            <button key={a} aria-pressed={draft.arrangement === a && !draft.custom}
              title={draft.custom ? `Puts the ${ROOM_PRESETS[draft.preset].label} pieces back in their places` : ''}
              onClick={() => { setDraft(setArrangement(draft, a)); setSelected(null); }}>
              {ROOM_PRESETS[draft.preset].arrangements[a].label}
            </button>
          ))}
          <button aria-pressed={draft.mirrored} onClick={() => setDraft(mirrorFurnishing(draft))}>Mirror</button>
        </div>

        <div class="section-label">FURNITURE</div>
        <ul class="piece-list">
          {draft.items.map(i => (
            <li key={i.id}>
              <button class={`piece${i.id === selected ? ' selected' : ''}`} onClick={() => { setMode({ kind: 'pick' }); setSelected(i.id === selected ? null : i.id); }}>
                <span>{FURNITURE[i.kind].label}</span>
                <span class={i.tier === 2 ? 'gold' : 'dim'}>{i.tier === 2 ? 'Premium' : 'Basic'}</span>
              </button>
            </li>
          ))}
        </ul>

        {after.issues.length > 0 && (
          <ul class="warn-text small furnish-issues">
            {after.issues.map((issue, k) => <li key={k}>{issue.message}</li>)}
          </ul>
        )}
        {problem && after.issues.length === 0 && <p class="warn-text small">{problem}</p>}
        {!unchanged && !problem && (
          <p class="dim small">
            Refit: {formatMoney(quote.cost)}, room closed {Math.max(1, quote.installHours)}h.
            {after.type !== quote.before.type && ` It becomes a ${after.type} room.`}
          </p>
        )}
        {room.status === 'renovating' && (
          <p class="small">
            Closed for {room.refitting ? 'its refit' : 'renovation'}: {room.renovationHoursRemaining}h to go.
          </p>
        )}
        {room.pendingRefit && (
          <p class="small">
            {waiting !== null ? `Refit booked: it starts once there's ${formatMoney(waiting)}.` : `Refit booked for ${later}.`}{' '}
            <button class="link" onClick={() => c.cancelRefit(room.id)}>Cancel</button>
          </p>
        )}
        <div class="actions">
          {vacant && affordable ? (
            <button class="primary" disabled={unchanged || !!problem}
              onClick={() => c.refitRoom(room.id, draft, 'now')}>
              Refit now ({formatMoney(quote.cost)}, {Math.max(1, quote.installHours)}h)
            </button>
          ) : (
            <button class="primary" disabled={unchanged || !!problem || sameAsBooked}
              onClick={() => c.refitRoom(room.id, draft, 'checkout')}>
              {vacant ? `Book it: starts once there's ${formatMoney(quote.cost)}` : `Refit ${later} (${formatMoney(quote.cost)})`}
            </button>
          )}
          {others.length > 0 && (
            <button disabled={!!problem} onClick={() => c.refitAllLike(room.id, draft)}>
              Same for {others.length === 1 ? 'the other' : `all ${others.length} other`} {ROOM_PRESETS[current.preset].label} room{others.length === 1 ? '' : 's'} ({formatMoney(othersCost)})
            </button>
          )}
          {!unchanged && <button onClick={() => { setDraft(current); setSelected(null); setMode({ kind: 'pick' }); }}>Reset</button>}
        </div>
      </div>
    </PanelCard>
  );
}

/** The picked piece: swap it for another of its kind, choose basic or premium, move, turn, resize, or take it out. */
function PieceEditor({ item, draft, unlocked, onChange, onMove, onRemove }: {
  item: FurnitureItem;
  draft: Furnishing;
  unlocked: (kind: FurnitureKind, tier?: Tier) => boolean;
  onChange: (change: Partial<FurnitureItem>) => void;
  onMove: () => void;
  onRemove: () => void;
}) {
  const spec = FURNITURE[item.kind];
  const sizes = [spec.size, ...(spec.sizes ?? [])];
  const length = item.length ?? spec.size[1];
  const nextLength = sizes[(sizes.findIndex(([, h]) => h === length) + 1) % sizes.length][1];
  const placed = profileFurnishing(draft).items.find(i => i.id === item.id);
  return (
    <div class="piece-editor" role="group" aria-label={`${spec.label} (selected)`}>
      <div class="furnish-row">
        <span class="slot-name">{GROUP_LABELS[spec.group]}</span>
        {GROUP_KINDS[spec.group].length > 1 ? (
          <select aria-label={GROUP_LABELS[spec.group]} value={item.kind}
            onChange={e => {
              const kind = (e.target as HTMLSelectElement).value as FurnitureKind;
              onChange({ kind, tier: unlocked(kind, item.tier) ? item.tier : 1, length: undefined });
            }}>
            {GROUP_KINDS[spec.group].map(kind => (
              <option key={kind} value={kind} disabled={!unlocked(kind)}>
                {FURNITURE[kind].label}{unlocked(kind) ? '' : ` (${FURNITURE[kind].requiredStars}★)`}
              </option>
            ))}
          </select>
        ) : <span class="slot-kind">{spec.label}</span>}
        <span class="tier-toggle">
          {([1, 2] as Tier[]).map(tier => (
            <button key={tier} aria-pressed={item.tier === tier} aria-label={`${spec.label} ${tier === 1 ? 'basic' : 'premium'}`}
              disabled={!unlocked(item.kind, tier)} onClick={() => onChange({ tier })}>
              {tier === 1 ? 'Basic' : 'Premium'}
            </button>
          ))}
        </span>
      </div>
      <div class="row-buttons">
        <button onClick={onMove}>Move</button>
        <button onClick={() => onChange({ rot: ((item.rot + 1) % 4) as Rot })}>{spec.wall ? 'Next wall' : 'Turn'}</button>
        {sizes.length > 1 && <button onClick={() => onChange({ length: nextLength === spec.size[1] ? undefined : nextLength })}>{nextLength > length ? 'Longer' : 'Shorter'}</button>}
        <button onClick={onRemove}>Remove</button>
        <span class="dim small">{formatMoney(FURNITURE[item.kind].cost[item.tier])}{placed ? ` · ${placed.w}×${placed.h}` : ''}</span>
      </div>
    </div>
  );
}
