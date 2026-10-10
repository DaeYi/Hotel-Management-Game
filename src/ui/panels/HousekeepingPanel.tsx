import type { CleaningQuality, DailyCleaningCadence } from '../../simulation/types';
import { HOUSEKEEPING } from '../../config/balance';
import { checkHousekeepingCompliance } from '../../simulation/HousekeepingManager';
import { useController } from '../context';
import { PanelCard } from './PanelCard';

const QUALITIES: Array<{ key: CleaningQuality; label: string }> = [
  { key: 'quick', label: 'Quick' },
  { key: 'standard', label: 'Standard' },
  { key: 'thorough', label: 'Thorough' },
];

const CADENCES: Array<{ key: DailyCleaningCadence; label: string }> = [
  { key: 'daily', label: 'Daily' },
  { key: 'every_other_day', label: 'Every 2d' },
  { key: 'none', label: 'None' },
];

export function HousekeepingPanel() {
  const c = useController();
  const { turnoverQuality, dailyCadence } = c.state.housekeeping;
  const warning = checkHousekeepingCompliance(c.state);

  return (
    <PanelCard title="HOUSEKEEPING">
      <div class="body small">Turnover cleaning:</div>
      <div class="row" style={{ marginTop: '4px' }}>
        {QUALITIES.map(q => (
          <button key={q.key} class={turnoverQuality === q.key ? 'chosen' : ''} aria-pressed={turnoverQuality === q.key}
            onClick={() => c.setHousekeeping(q.key, dailyCadence)}>{q.label}</button>
        ))}
      </div>
      <div class="dim tiny" style={{ marginTop: '4px' }}>
        {QUALITIES.map(q => (
          <div key={q.key}>
            {q.label}: ${HOUSEKEEPING.turnoverCost[q.key]}, {HOUSEKEEPING.turnoverDuration[q.key]}h, {HOUSEKEEPING.turnoverCleanlinessResult[q.key]}% clean
          </div>
        ))}
      </div>

      <div class="body small" style={{ marginTop: '10px' }}>During-stay cleaning:</div>
      <div class="row" style={{ marginTop: '4px' }}>
        {CADENCES.map(cd => (
          <button key={cd.key} class={dailyCadence === cd.key ? 'chosen' : ''} aria-pressed={dailyCadence === cd.key}
            onClick={() => c.setHousekeeping(turnoverQuality, cd.key)}>{cd.label}</button>
        ))}
      </div>
      <div class="dim tiny" style={{ marginTop: '4px' }}>
        Daily cleans are queued at {HOUSEKEEPING.dailyCleaningHour}:00 and done after checkout cleaning.
      </div>

      {warning && <div class="bad tiny" style={{ marginTop: '8px' }}>{'⚠'} {warning}</div>}
    </PanelCard>
  );
}
