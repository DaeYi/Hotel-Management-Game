import { useState } from 'preact/hooks';
import type { Furnishing, Room } from '../../simulation/types';
import { ROOM_PRESETS, SLOT_KINDS, SLOT_LABELS, FURNITURE, type PresetId, type Tier, type FurnitureKind } from '../../config/furniture';
import { furnishingOf, quoteRefit, validateFurnishing, switchPreset, isFurnitureUnlocked } from '../../simulation/RoomProfile';
import { formatRoomLabel, roomsToRefitLike } from '../../simulation/HotelState';
import { getExpectedPrice } from '../../simulation/StarRatingManager';
import { useController } from '../context';
import { formatMoney } from '../format';
import { PanelCard } from './PanelCard';
import { RoomPlan } from '../RoomPlan';

/**
 * Furnish a room: pick its layout, where the bathroom goes, and each piece of
 * furniture and how nice it is. What it's furnished with decides what kind of
 * room it is (and so its fair price and its share of the hotel's stars). The
 * change happens now if the room is empty -- it closes for the fitting -- or
 * after its guest leaves; and can be copied to every room with this layout.
 */
export function FurnishPanel() {
  const c = useController();
  const room = c.state.rooms.find(r => r.id === c.furnishRoomId);
  if (!room) return null;
  return <FurnishEditor key={room.id} room={room} />;
}

function FurnishEditor({ room }: { room: Room }) {
  const c = useController();
  const { state } = c;
  const current = furnishingOf(room);
  const [draft, setDraft] = useState<Furnishing>(room.pendingRefit ?? current);
  const quote = quoteRefit(current, draft);
  const problem = validateFurnishing(draft, state.peakStarRating);
  const unchanged = quote.changed.length === 0 && !quote.moved;
  const preset = ROOM_PRESETS[draft.preset];
  const vacant = room.status === 'vacant';
  // "Rooms like this one" are the ones with the layout this room has now
  const others = roomsToRefitLike(state, draft, current.preset, room.id);
  const othersCost = others.reduce((sum, r) => sum + quoteRefit(furnishingOf(r), draft).cost, 0);
  const later = room.status === 'occupied' ? 'after checkout' : room.status === 'cleaning' ? 'after cleaning' : 'when it reopens';
  // A booked refit on an empty room is waiting for the money
  const waiting = room.pendingRefit && vacant ? quoteRefit(current, room.pendingRefit).cost : null;
  const sameAsBooked = !!room.pendingRefit && (() => {
    const q = quoteRefit(room.pendingRefit, draft);
    return q.changed.length === 0 && !q.moved;
  })();
  const affordable = state.cash >= quote.cost;

  const setItem = (slot: string, kind: FurnitureKind, tier: Tier) =>
    setDraft({ ...draft, items: draft.items.map(i => (i.slot === slot ? { ...i, kind, tier } : i)) });

  const fairBefore = getExpectedPrice(quote.before.type, state.starRating, room.floor);
  const fairAfter = getExpectedPrice(quote.after.type, state.starRating, room.floor);

  return (
    <PanelCard title={`FURNISH ROOM ${formatRoomLabel(room.gridX, room.gridY, room.floor)}`}>
      <div class="furnish">
        <div class="furnish-top">
          <RoomPlan furnishing={draft} size={128} />
          <div class="furnish-summary">
            <div class="dim small">Now</div>
            <div>{quote.before.label}</div>
            <div class="dim small">{formatMoney(fairBefore)}/night fair</div>
            {!unchanged && (
              <>
                <div class="dim small" style={{ marginTop: '6px' }}>After</div>
                <div class={quote.after.type !== quote.before.type ? 'gold' : ''}>{quote.after.label}</div>
                <div class="dim small">{formatMoney(fairAfter)}/night fair</div>
              </>
            )}
          </div>
        </div>

        <div class="section-label">START FROM</div>
        <div class="row-buttons">
          {(Object.keys(ROOM_PRESETS) as PresetId[]).map(id => {
            const next = id === draft.preset ? draft : switchPreset(draft, id);
            const locked = !!validateFurnishing(next, state.peakStarRating);
            return (
              <button key={id} aria-pressed={draft.preset === id} disabled={locked && draft.preset !== id}
                title={locked ? 'Needs a higher star rating' : ''} onClick={() => setDraft(next)}>
                {ROOM_PRESETS[id].label}
              </button>
            );
          })}
        </div>
        <div class="section-label">BATHROOM</div>
        <div class="row-buttons">
          {(['bath_front', 'bath_back'] as const).map(a => (
            <button key={a} aria-pressed={draft.arrangement === a} onClick={() => setDraft({ ...draft, arrangement: a })}>
              {preset.arrangements[a].label}
            </button>
          ))}
          <button aria-pressed={draft.mirrored} onClick={() => setDraft({ ...draft, mirrored: !draft.mirrored })}>Mirror</button>
        </div>

        <div class="section-label">FURNITURE</div>
        {preset.slots.map(slot => {
          const item = draft.items.find(i => i.slot === slot)!;
          return (
            <div class="furnish-row" key={slot}>
              <span class="slot-name">{SLOT_LABELS[slot]}</span>
              {SLOT_KINDS[slot].length > 1 ? (
                <select aria-label={SLOT_LABELS[slot]} value={item.kind}
                  onChange={e => setItem(slot, (e.target as HTMLSelectElement).value as FurnitureKind, item.tier)}>
                  {SLOT_KINDS[slot].map(kind => (
                    <option key={kind} value={kind} disabled={!isFurnitureUnlocked(kind, 1, state.peakStarRating)}>
                      {FURNITURE[kind].label}{isFurnitureUnlocked(kind, 1, state.peakStarRating) ? '' : ` (${FURNITURE[kind].requiredStars}★)`}
                    </option>
                  ))}
                </select>
              ) : <span class="slot-kind">{FURNITURE[item.kind].label}</span>}
              <span class="tier-toggle">
                {([1, 2] as Tier[]).map(tier => (
                  <button key={tier} aria-pressed={item.tier === tier} aria-label={`${SLOT_LABELS[slot]} ${tier === 1 ? 'basic' : 'premium'}`}
                    disabled={!isFurnitureUnlocked(item.kind, tier, state.peakStarRating)}
                    onClick={() => setItem(slot, item.kind, tier)}>
                    {tier === 1 ? 'Basic' : 'Premium'}
                  </button>
                ))}
              </span>
            </div>
          );
        })}

        {problem && <p class="warn-text small">{problem}</p>}
        {!unchanged && !problem && (
          <p class="dim small">
            Refit: {formatMoney(quote.cost)}, room closed {quote.installHours}h.
            {quote.after.type !== quote.before.type && ` It becomes a ${quote.after.type} room.`}
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
              Refit now ({formatMoney(quote.cost)}, {quote.installHours}h)
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
          {!unchanged && <button onClick={() => setDraft(current)}>Reset</button>}
        </div>
      </div>
    </PanelCard>
  );
}
