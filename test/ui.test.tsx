// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/preact';
import { createRef } from 'preact';
import { GameController } from '../src/game/GameController';
import { App } from '../src/ui/App';
import { OBJECTIVES } from '../src/config/balance';

/** Render the interface around a controller; the world element is left empty (no renderer in tests). */
function setup(options: { tutorialSeen?: boolean } = {}) {
  localStorage.clear();
  if (options.tutorialSeen ?? true) localStorage.setItem('hotel-game-tutorial-seen', '1');
  const controller = new GameController();
  render(<App controller={controller} worldRef={createRef()} />);
  /** Push controller changes into the DOM, as the animation loop does (act() applies Preact's re-render). */
  const flush = () => act(() => controller.update(0));
  return { controller, flush };
}

afterEach(() => cleanup());
beforeEach(() => localStorage.clear());

describe('Interface', () => {
  it('shows cash, the current goal, and the free lobby\'s first-goal progress', () => {
    setup();
    expect(screen.getByText('$50,000')).toBeTruthy();
    expect(screen.getByText(new RegExp(OBJECTIVES[0].title))).toBeTruthy();
    expect(screen.getByText(/0 \/ 8 rooms/)).toBeTruthy();
  });

  it('the tutorial walks through its steps and starts the clock', () => {
    const { controller, flush } = setup({ tutorialSeen: false });
    expect(screen.getByRole('dialog', { name: 'Tutorial' })).toBeTruthy();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText(/Next/));
    fireEvent.click(screen.getByText("Let's go!"));
    flush();
    expect(controller.tutorialOpen).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Tutorial' })).toBeNull();
  });

  it('build options select tools; locked ones are disabled', () => {
    const { controller, flush } = setup();
    fireEvent.click(screen.getByText('Standard'));
    flush();
    expect(controller.tool).toBe('standard');
    expect(screen.getByText('Standard').closest('button')!.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByText('Suite').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('toolbar buttons open panels, and the staff panel hires staff', () => {
    const { controller, flush } = setup();
    fireEvent.click(screen.getByText(/Staff$/));
    flush();
    const panel = screen.getByRole('region', { name: 'STAFF' });
    expect(panel).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/More Housekeepers/));
    flush();
    expect(controller.state.staff.housekeepers).toBe(2);
    fireEvent.click(screen.getByLabelText('Close'));
    flush();
    expect(screen.queryByRole('region', { name: 'STAFF' })).toBeNull();
  });

  it('the goal tracker opens the goals panel, which can repay the loan', () => {
    const { controller, flush } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Goals' }));
    flush();
    expect(screen.getByText('BANK LOAN')).toBeTruthy();
    fireEvent.click(screen.getByText('Pay $5,000'));
    flush();
    expect(controller.state.loan.balance).toBe(45000);
  });

  it('selecting a room opens its inspector; the price slider and demolish work', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();

    const inspector = screen.getByRole('dialog', { name: /Standard Room/ });
    expect(inspector.textContent).toContain('Vacant');
    fireEvent.input(screen.getByLabelText('Price per night'), { target: { value: '110' } });
    flush();
    expect(controller.state.rooms[0].pricePerNight).toBe(110);

    fireEvent.click(screen.getByText(/Demolish/));
    flush();
    expect(controller.state.rooms).toHaveLength(0);
    expect(screen.queryByRole('dialog', { name: /Standard Room/ })).toBeNull();
  });

  it('floors: building one adds it to the stack and switches to it', () => {
    const { controller, flush } = setup();
    fireEvent.click(screen.getByText(/\+ Floor 2/));
    flush();
    expect(controller.currentFloor).toBe(1);
    expect(screen.getByText(/Floor 2/, { selector: 'button[aria-pressed="true"]' })).toBeTruthy();
    fireEvent.click(screen.getByText(/Ground/));
    flush();
    expect(controller.currentFloor).toBe(0);
  });

  it('game events show up as toasts', () => {
    const { controller, flush } = setup();
    controller.toasts.add([{ type: 'objective_completed', message: 'Goal complete: Test' }], performance.now());
    act(() => {
      controller.togglePause(); // any change, so the toast list re-renders
      controller.update(0);
    });
    expect(screen.getByText('Goal complete: Test')).toBeTruthy();
  });

  it('new game asks for confirmation first', () => {
    const { controller, flush } = setup();
    fireEvent.click(screen.getByText('New Game'));
    flush();
    expect(screen.getByRole('dialog', { name: 'Start a new game' })).toBeTruthy();
    expect(controller.running).toBe(false);
    fireEvent.click(screen.getByText('Cancel'));
    flush();
    expect(screen.queryByRole('dialog', { name: 'Start a new game' })).toBeNull();
  });
});
