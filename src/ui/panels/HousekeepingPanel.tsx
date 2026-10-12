import type { CleaningQuality, DailyCleaningCadence, LateCheckoutPolicy } from '../../simulation/types';
import { HOUSEKEEPING, GUEST_PROFILE, ECONOMY, GUEST_HOUSEKEEPING } from '../../config/balance';
import { lateCheckoutPolicy } from '../../simulation/Profile';
import { checkoutsToday } from '../../simulation/CleaningStatus';
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

const LATE_POLICIES: Array<{ key: LateCheckoutPolicy; label: string }> = [
  { key: 'deny', label: 'No' },
  { key: 'free', label: 'Free' },
  { key: 'fee', label: 'For a fee' },
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
  const due = checkoutsToday(c.state);
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
        <li><CleaningSwatch kind="due" />Daily cleans due: {daily.due - daily.guestIn}{daily.cleaning > 0 && <span class="dim"> ({daily.cleaning} being done)</span>}</li>
        {GUEST_HOUSEKEEPING.enabled && GUEST_PROFILE.enabled && <li><CleaningSwatch kind="guest_in" />Daily cleans waiting for guests to go out: {daily.guestIn}</li>}
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
        {GUEST_HOUSEKEEPING.enabled && GUEST_PROFILE.enabled && <> Hangers on the doors: green, make up the room every day (first, and on the off days too); red, do not disturb (only while they're out).</>}
      </div>

      {GUEST_PROFILE.enabled && (
        <>
          <div class="body small" style={{ marginTop: '10px' }}>Late checkout (night owls ask to stay till {GUEST_PROFILE.lateCheckoutHour}:00):</div>
          <div class="row" style={{ marginTop: '4px' }} role="group" aria-label="Late checkout">
            {LATE_POLICIES.map(p => (
              <button key={p.key} class={lateCheckoutPolicy(c.state) === p.key ? 'chosen' : ''} aria-pressed={lateCheckoutPolicy(c.state) === p.key}
                onClick={() => c.setLateCheckout(p.key)}>{p.label}</button>
            ))}
          </div>
          <div class="dim tiny" style={{ marginTop: '4px' }}>
            No: they leave at {ECONOMY.checkOutHour}:00, a little put out. Free: their room's ready for the next guest later.
            For a fee: as free, and they pay {Math.round(GUEST_PROFILE.lateCheckoutFee * 100)}% of a night. Early birds leave before {ECONOMY.checkOutHour}:00 either way.
          </div>
          {due.total > 0 && (
            <div class="tiny" style={{ marginTop: '4px' }}>
              Still to check out today: {due.total}{due.late > 0 ? ` (${due.late} late, at ${GUEST_PROFILE.lateCheckoutHour}:00)` : ''}
            </div>
          )}
        </>
      )}

      {warning && <div class="bad tiny" style={{ marginTop: '8px' }}>{'⚠'} {warning}</div>}
    </PanelCard>
  );
}
