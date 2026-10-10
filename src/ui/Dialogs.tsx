import { useState } from 'preact/hooks';
import { useController } from './context';
import { formatMoney } from './format';

const TUTORIAL_STEPS = [
  {
    title: 'Step 1: Build Rooms',
    text: 'Pick a room in the BUILD panel and click the grid. Every room needs a door onto a hallway. Guests check in at the desk. Out of space? Build up (FLOORS) and add an elevator.',
  },
  {
    title: 'Step 2: Guests Arrive',
    text: 'Guests check in between 2 PM and 10 PM.\nThey pay per night and rate your hotel on checkout.',
  },
  {
    title: 'Step 3: Manage Your Rating',
    text: 'Keep ratings high to attract more guests. Click rooms to adjust pricing. Watch for noise when occupancy gets above 65%.',
  },
  {
    title: 'Step 4: Goals & the Loan',
    text: "Your $50,000 is a bank loan: $1,000 is due every week. Follow the owner's goals (top right) for cash rewards. Earn stars to unlock deluxe rooms, suites, and new facilities.",
  },
];

/** First-run walkthrough; the clock stays stopped until it's dismissed. */
export function Tutorial() {
  const c = useController();
  const [step, setStep] = useState(0);
  if (!c.tutorialOpen) return null;

  const last = step === TUTORIAL_STEPS.length - 1;
  const { title, text } = TUTORIAL_STEPS[step];
  return (
    <div class="modal-backdrop">
      <div class="card dialog tutorial" role="dialog" aria-modal="true" aria-label="Tutorial">
        <h2>{title}</h2>
        <p>{text}</p>
        <div class="footer">
          <span class="faint small">{step + 1} / {TUTORIAL_STEPS.length}</span>
          <button class="primary" onClick={() => (last ? c.finishTutorial() : setStep(step + 1))}>
            {last ? "Let's go!" : 'Next ▶'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function NewGameDialog() {
  const c = useController();
  if (!c.confirmingNewGame) return null;
  return (
    <div class="modal-backdrop">
      <div class="card dialog" role="dialog" aria-modal="true" aria-label="Start a new game">
        <h2>Start a New Game?</h2>
        <p>Your current progress will be lost.</p>
        <div class="footer">
          <button class="danger" onClick={() => c.startNewGame()}>Start Over</button>
          <button class="primary" onClick={() => c.cancelNewGame()}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function BankruptDialog() {
  const c = useController();
  if (!c.gameOver) return null;
  return (
    <div class="modal-backdrop">
      <div class="card dialog bankrupt" role="dialog" aria-modal="true" aria-label="Bankrupt">
        <h2>BANKRUPT</h2>
        <p>Your hotel went under with{'\n'}{formatMoney(Math.abs(c.state.cash))} in debt.</p>
        <p class="dim small" style={{ marginTop: '12px' }}>The guests have checked out.{'\n'}The lights are off.</p>
        <div class="footer" style={{ justifyContent: 'center' }}>
          <button class="primary" onClick={() => c.startNewGame()}>Try Again</button>
        </div>
      </div>
    </div>
  );
}
