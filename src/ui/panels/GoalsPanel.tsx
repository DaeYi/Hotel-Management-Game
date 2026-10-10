import { OBJECTIVES, LOAN } from '../../config/balance';
import { getNextLoanPaymentDay } from '../../simulation/EconomyManager';
import { getCurrentObjective, isLegacyPhase, calculateValuation } from '../../simulation/ObjectivesManager';
import { useController } from '../context';
import { formatMoney, formatMoneyShort, formatObjectiveProgress } from '../format';
import { PanelCard } from './PanelCard';

const STATUS_COLORS = {
  completed: 'var(--good)',
  failed: 'var(--bad)',
  current: '#ffffff',
  upcoming: 'var(--text-faint)',
};

export function GoalsPanel() {
  const c = useController();
  const { state } = c;
  const { loan } = state;
  const balance = Math.ceil(loan.balance);

  return (
    <PanelCard title="OWNER'S GOALS">
      <ol style={{ listStyle: 'none' }}>
        {OBJECTIVES.map((objective, i) => {
          const outcome = state.objectives.outcomes[i];
          const current = i === state.objectives.currentIndex;
          let marker: string, headline: string, detail: string, color: string;
          if (outcome === 'completed') {
            [marker, headline, detail, color] = ['✓', `${objective.title}  +${formatMoney(objective.reward)}`, objective.description, STATUS_COLORS.completed];
          } else if (outcome === 'failed') {
            [marker, headline, detail, color] = ['✗', `${objective.title}  missed (day ${objective.deadlineDay})`, objective.description, STATUS_COLORS.failed];
          } else if (current) {
            [marker, headline, detail, color] = ['▶', `${objective.title}  by day ${objective.deadlineDay}`, formatObjectiveProgress(state, objective), STATUS_COLORS.current];
          } else {
            [marker, headline, detail, color] = ['·', `${objective.title}  by day ${objective.deadlineDay}`, objective.description, STATUS_COLORS.upcoming];
          }
          return (
            <li key={objective.id} class="small" style={{ color, marginBottom: '6px' }}>
              <div>{marker} {headline}</div>
              <div class="tiny" style={{ marginLeft: '14px' }}>{detail}</div>
            </li>
          );
        })}
      </ol>

      <div class="gold small">
        {isLegacyPhase(state) ? (() => {
          const goal = getCurrentObjective(state);
          const done = state.objectives.currentIndex - OBJECTIVES.length;
          return <>{'▶'} {goal.title} ({done} legacy done)<div class="tiny" style={{ marginLeft: '14px' }}>{formatObjectiveProgress(state, goal)}</div></>;
        })() : <>{'·'} Legacy goals unlock after these<div class="tiny" style={{ marginLeft: '14px' }}>Hotel worth {formatMoneyShort(calculateValuation(state))}</div></>}
      </div>

      <hr class="divider" />
      <div class="section-label" style={{ marginTop: 0 }}>BANK LOAN</div>
      {loan.balance <= 0 ? (
        <div class="body small">Paid off. The hotel is all yours.</div>
      ) : (
        <>
          <div class="body small">Owed: {formatMoney(balance)}  ({Math.round(LOAN.weeklyInterestRate * 100)}%/week interest)</div>
          <div class="body small">{formatMoney(loan.weeklyPayment)} due on day {getNextLoanPaymentDay(state.day)}</div>
          <div class="row spread" style={{ marginTop: '8px' }}>
            <button class="primary" disabled={state.cash < Math.min(LOAN.earlyRepaymentStep, balance)} onClick={() => c.repayLoan(LOAN.earlyRepaymentStep)}>
              Pay {formatMoney(LOAN.earlyRepaymentStep)}
            </button>
            <button class="primary" disabled={state.cash < balance} onClick={() => c.repayLoan(Number.POSITIVE_INFINITY)}>
              Pay off ({formatMoney(balance)})
            </button>
          </div>
        </>
      )}
    </PanelCard>
  );
}
