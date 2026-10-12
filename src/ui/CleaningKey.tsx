import { CLEANING_COLORS } from '../render/GridRenderer';
import { GUEST_HOUSEKEEPING, GUEST_PROFILE } from '../config/balance';

// The cleaning overlay's key: little swatches drawn the way the floor plan
// draws each state, from the same colors.

const css = (color: number, alpha = 1) => {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export type CleaningKeyKind = 'cleaning' | 'on_the_way' | 'waiting' | 'blocked' | 'due' | 'guest_in' | 'grubby';

const hatch = (edge: number, stripes: number = CLEANING_COLORS.hatch) => ({
  background: `repeating-linear-gradient(45deg, ${css(stripes, 0.9)} 0 2px, ${css(CLEANING_COLORS.dirty, 0.75)} 2px 5px)`,
  border: `2px solid ${css(edge)}`,
});

const STYLES: Record<CleaningKeyKind, Record<string, string>> = {
  cleaning: { background: css(CLEANING_COLORS.housekeeper, 0.35), border: `2px solid ${css(CLEANING_COLORS.housekeeper)}` },
  on_the_way: { ...hatch(CLEANING_COLORS.housekeeper), borderStyle: 'dashed' },
  waiting: hatch(CLEANING_COLORS.dirty),
  blocked: hatch(CLEANING_COLORS.blocked, CLEANING_COLORS.blocked),
  due: { background: css(CLEANING_COLORS.due), borderRadius: '50%', border: `1px solid ${css(CLEANING_COLORS.track)}` },
  guest_in: { background: css(CLEANING_COLORS.track), borderRadius: '50%', border: `2px solid ${css(CLEANING_COLORS.due)}` },
  grubby: { background: css(CLEANING_COLORS.grubby, 0.6), border: '2px solid transparent' },
};

export function CleaningSwatch({ kind }: { kind: CleaningKeyKind }) {
  return <span class="cleaning-swatch" style={STYLES[kind]} aria-hidden="true" />;
}

const LABELS: Record<CleaningKeyKind, string> = {
  cleaning: 'Being cleaned',
  on_the_way: 'Housekeeper on the way',
  waiting: 'Dirty, waiting',
  blocked: "Dirty, can't be reached",
  due: 'Daily clean due',
  guest_in: 'Daily clean due, guests in (do not disturb)',
  grubby: 'Grubby: under 50% clean (hurts reviews)',
};

/** The key under the floor plan while the overlay is on. */
export function CleaningLegend() {
  return (
    <>
      {(Object.keys(LABELS) as CleaningKeyKind[]).filter(kind => kind !== 'guest_in' || (GUEST_HOUSEKEEPING.enabled && GUEST_PROFILE.enabled)).map(kind => (
        <span key={kind}><CleaningSwatch kind={kind} />{LABELS[kind]}</span>
      ))}
      <span><span class="cleaning-bar" aria-hidden="true"><span style={{ background: css(CLEANING_COLORS.housekeeper) }} /></span>How far along</span>
    </>
  );
}
