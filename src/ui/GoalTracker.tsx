import { evaluateObjective, getCurrentObjective } from '../simulation/ObjectivesManager';
import { useController } from './context';
import { formatObjectiveProgress, formatMoney } from './format';

const URGENT_DAYS = 5;

/** The current goal, always visible in the top-right; click for the full Goals panel. */
export function GoalTracker() {
  const c = useController();
  const { state } = c;
  const objective = getCurrentObjective(state);
  const status = evaluateObjective(state, objective);

  // Owner goals have a deadline and reward; legacy goals have neither
  const daysLeft = objective.deadlineDay === null ? null : objective.deadlineDay - state.day;
  const urgent = daysLeft !== null && daysLeft <= URGENT_DAYS;
  const parts = [formatObjectiveProgress(state, objective)];
  if (daysLeft !== null) parts.push(daysLeft <= 0 ? 'last day' : `${daysLeft}d left`);
  if (objective.reward > 0) parts.push(`+${formatMoney(objective.reward)}`);

  const barColor = status.complete ? 'var(--good)' : urgent ? 'var(--bad)' : 'var(--accent)';
  return (
    <button class="goal-tracker" onClick={() => c.togglePanel('goals')} aria-label="Goals">
      <div class="title">
        {daysLeft === null ? '🏆' : '🎯'} {objective.title}
        <span class="progress"><span style={{ width: `${Math.max(8, status.fraction * 100)}%`, background: barColor }} /></span>
      </div>
      <div class={`detail${urgent ? ' urgent' : ''}`}>{parts.join('  |  ')}</div>
    </button>
  );
}
