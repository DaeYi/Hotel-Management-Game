import type { CleaningQuality, DailyCleaningCadence } from '../../simulation/types';
import { HOUSEKEEPING } from '../../config/balance';
import { checkHousekeepingCompliance } from '../../simulation/HousekeepingManager';
import { summarizeCleaning, describeWait, GRUBBY_BELOW, type CleaningWait } from '../../simulation/CleaningStatus';
import { useController, useLiveClock } from '../context';
import { CleaningSwatch } from '../CleaningKey';
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

const floorName = (floor: number) => (floor === 0 ? 'Ground' : `Floor ${floor + 1}`);

/**
 * Housekeeping: what's being cleaned right now (the floor plan shows it room
 * by room while this panel is open), and the cleaning policy.
 */
export function HousekeepingPanel() {
  const c = useController();
  useLiveClock(); // the counts follow the housekeepers through the hour, as the overlay does
  const { turnoverQuality, dailyCadence } = c.state.housekeeping;
  const warning = checkHousekeepingCompliance(c.state);
  const now = summarizeCleaning(c.state, c.gameTime);
  const { turnovers, daily } = now;
  const blocked = now.waits.unreachable ?? 0;
  const why = (Object.entries(now.waits) as Array<[CleaningWait, number]>)
    .filter(([wait]) => wait !== 'unreachable')
    .map(([wait, n]) => (turnovers.waiting - blocked === n ? describeWait(wait) : `${n} ${describeWait(wait)}`));
  const elsewhere = [...now.waitingByFloor].filter(([floor]) => floor !== c.currentFloor).sort((a, b) => a[0] - b[0]);
  // What the folded panel says: the same counts as the list, briefly
  const brief = [
    turnovers.waiting > 0 && `${turnovers.waiting} waiting`,
    turnovers.cleaning > 0 && `${turnovers.cleaning} being cleaned`,
    turnovers.onTheWay > 0 && `${turnovers.onTheWay} on the way`,
    daily.due + daily.cleaning > 0 && `${daily.due + daily.cleaning} daily clean${daily.due + daily.cleaning === 1 ? '' : 's'}`,
    now.grubby > 0 && `${now.grubby} grubby`,
  ].filter(Boolean).join(' \u00b7 ') || 'all clean';

  return (
    <PanelCard title="HOUSEKEEPING" summary={brief}>
      <div class="body small">Right now (shown on the floor plan):</div>
      <ul class="cleaning-now small">
        <li><CleaningSwatch kind="cleaning" />Being cleaned: {turnovers.cleaning}</li>
        <li><CleaningSwatch kind="on_the_way" />Housekeeper on the way: {turnovers.onTheWay}</li>
        <li>
          <CleaningSwatch kind="waiting" />Dirty, waiting: {turnovers.waiting - blocked}
          {why.length > 0 && <span class="dim"> ({why.join('; ')})</span>}
        </li>
        {blocked > 0 && <li class="bad"><CleaningSwatch kind="blocked" />Dirty, housekeepers can't reach: {blocked}</li>}
        <li><CleaningSwatch kind="due" />Daily cleans due: {daily.due}{daily.cleaning > 0 && <span class="dim"> ({daily.cleaning} being done)</span>}</li>
        <li><CleaningSwatch kind="grubby" />Grubby rooms (under {GRUBBY_BELOW}% clean): {now.grubby}</li>
      </ul>
      {elsewhere.length > 0 && (
        <div class="tiny cleaning-floors" style={{ marginTop: '4px' }}>
          Waiting on other floors:{' '}
          {elsewhere.map(([floor, n]) => (
            <button key={floor} class="link" onClick={() => c.setFloor(floor)}>{floorName(floor)} ({n})</button>
          ))}
        </div>
      )}

      <div class="body small" style={{ marginTop: '10px' }}>Turnover cleaning:</div>
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
