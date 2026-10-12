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

/** In the furnishing editor: pick a piece from the furniture list. */
function pickPiece(name: string) {
  fireEvent.click(screen.getByText(name, { selector: '.piece-list span' }));
}

/** In the furnishing editor: pick each named piece from the list and make it premium. */
function upgrade(...pieces: string[]) {
  for (const name of pieces) {
    pickPiece(name);
    fireEvent.click(screen.getByLabelText(`${name} premium`));
  }
}
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
    fireEvent.click(screen.getByText('Standard Queen'));
    flush();
    expect(controller.tool).toBe('standard');
    expect(screen.getByText('Standard Queen').closest('button')!.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByText('Executive Studio').closest('button') as HTMLButtonElement).disabled).toBe(true);
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

    const inspector = screen.getByRole('dialog', { name: /Standard Queen/ });
    expect(inspector.textContent).toContain('Vacant');
    fireEvent.input(screen.getByLabelText('Price per night'), { target: { value: '110' } });
    flush();
    expect(controller.state.rooms[0].pricePerNight).toBe(110);

    fireEvent.click(screen.getByText(/Demolish/));
    flush();
    expect(controller.state.rooms).toHaveLength(0);
    expect(screen.queryByRole('dialog', { name: /Standard Queen/ })).toBeNull();
  });

  it('furnishing a room: premium pieces make it deluxe, and refitting closes it for the fitting', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.tileDown({ gridX: 6, gridY: 2 });
    controller.selectTool(null);
    controller.state = { ...controller.state, peakStarRating: 2 };
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();
    fireEvent.click(screen.getByText(/Furnish/));
    flush();
    const panel = () => screen.getByRole('region', { name: /FURNISH ROOM/ });
    expect(panel()).toBeTruthy();
    // Locked at 2 stars: the studio's sofa needs 3
    expect((screen.getByText('Executive Studio', { selector: '.furnish button' }) as HTMLButtonElement).disabled).toBe(true);

    upgrade('Queen bed', 'Shower room', 'Clothes rail');
    flush();
    expect(panel().textContent).toContain('Deluxe Queen');
    expect(panel().textContent).toContain('Same for the other Standard Queen room');

    const cash = controller.state.cash;
    fireEvent.click(screen.getByText(/Refit now/));
    flush();
    const room = controller.state.rooms.find(r => r.gridX === 5)!;
    expect(room.type).toBe('deluxe');
    expect(room.status).toBe('renovating');
    expect(controller.state.cash).toBe(cash - 2870);
    expect(panel().textContent).toContain('Closed for its refit');
  });

  it('the editor: a bed from the palette makes a family room; a piece in the doorway, or taken out, has to be fixed first', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    controller.openFurnishing(controller.state.rooms[0].id);
    flush();
    const panel = () => screen.getByRole('region', { name: /FURNISH ROOM/ });
    const refit = () => screen.getByText(/Refit now/).closest('button') as HTMLButtonElement;

    // Out with the armchair, in with a single bed where it was
    pickPiece('Armchair');
    fireEvent.click(screen.getByText('Remove'));
    fireEvent.click(screen.getByText('Single bed', { selector: '.palette button' }));
    expect(panel().textContent).toContain('Tap where the single bed goes');
    fireEvent.click(screen.getByLabelText('Cell 1, 3')); // column 1, row 3: the left wall, below the queen
    flush();
    expect(panel().textContent).toContain('Standard Family Room');
    expect(panel().textContent).toContain('Sleeps 3');
    expect(refit().disabled).toBe(false);

    // Moved into the doorway: the room doesn't work, and can't be refitted to
    fireEvent.click(screen.getByText('Move'));
    fireEvent.click(screen.getByLabelText('Cell 2, 3'));
    flush();
    expect(panel().textContent).toContain('Keep the doorway clear');
    expect(refit().disabled).toBe(true);
    fireEvent.click(screen.getByText('Move'));
    fireEvent.click(screen.getByLabelText('Cell 1, 3'));

    // No bathroom: same
    pickPiece('Shower room');
    fireEvent.click(screen.getByText('Remove'));
    flush();
    expect(panel().textContent).toContain('Needs a bathroom');
    expect(refit().disabled).toBe(true);
    fireEvent.click(screen.getByText('Reset'));
    flush();
    expect(panel().textContent).not.toContain('After');
  });

  it('the editor: Esc while putting a piece down cancels that, not the panel; a new bathroom keeps its length', async () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    controller.state = { ...controller.state, peakStarRating: 2 };
    controller.openFurnishing(controller.state.rooms[0].id);
    flush();
    const panel = () => screen.queryByRole('region', { name: /FURNISH ROOM/ });
    fireEvent.click(screen.getByText('Single bed', { selector: '.palette button' }));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); }); // effects run (the Esc handler is installed)
    fireEvent.keyDown(document.body, { key: 'Escape' });
    flush();
    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain('Tap a piece to change it');
    // The long shower room swapped for a bathroom with a tub: still 2x3
    pickPiece('Shower room');
    fireEvent.change(screen.getByLabelText('Bathroom'), { target: { value: 'bath_tub' } });
    flush();
    expect(panel()!.textContent).toContain('2×3');
  });

  it('guest preferences: who a room suits, live in the editor; who is staying and what they like', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    controller.openFurnishing(controller.state.rooms[0].id);
    flush();
    const panel = () => screen.getByRole('region', { name: /FURNISH ROOM/ });
    // A plain queen suits nobody in particular; swap the armchair for a desk and it suits business travellers
    expect(panel().textContent).not.toContain('Good for');
    pickPiece('Armchair');
    fireEvent.change(screen.getByLabelText('Seat'), { target: { value: 'desk' } });
    flush();
    expect(panel().textContent).toContain('Good for business travellers');
    fireEvent.click(screen.getByText(/Refit now/));
    flush();

    // A business traveller staying in it: who they are, and that they like the desk
    const room = { ...controller.state.rooms[0], status: 'occupied' as const, guestId: 'g1', renovationHoursRemaining: 0 };
    controller.state = {
      ...controller.state,
      rooms: [room],
      // A solo booking on business: only the purpose makes them a business traveller who wants a desk
      guests: [{ id: 'g1', name: 'Sam', budget: 300, stayLength: 2, trait: 'light_sleeper', satisfaction: 50, checkInDay: 1, isReturning: false, hadNoiseComplaint: false, party: { kind: 'solo', size: 1 }, purpose: 'business' }],
    };
    controller.closePanel();
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();
    const inspector = screen.getByRole('dialog', { name: /Standard Queen/ });
    expect(inspector.textContent).toContain('Occupied: a business traveller (light sleeper)');
    expect(inspector.textContent).not.toContain('solo traveller');
    expect(inspector.textContent).toContain('Likes the desk');
    expect(inspector.textContent).toContain('Good for business travellers');

    // Out at a meeting till the evening
    const T = (controller.state.day - 1) * 24 + controller.state.hour;
    const street = { gridX: 0, gridY: 0, floor: 0 };
    controller.state = {
      ...controller.state,
      guests: controller.state.guests.map(g => ({ ...g, tripKind: 'outing' as const, trip: [{ kind: 'stay' as const, at: street, start: T - 1, end: T + 7.6, activity: 'away' as const }] })),
    };
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();
    expect(screen.getByRole('dialog', { name: /Standard Queen/ }).textContent).toMatch(/out at a meeting, back about \d\d:00/);

    // The legend says what the guest colours mean
    expect(screen.getByRole('group', { name: 'Guests' }).textContent).toBe('Guests:BusinessSightseeingGetaway');
    // A guest from an older save, with no purpose: white, and in the legend too
    controller.state = { ...controller.state, guests: controller.state.guests.map(g => ({ ...g, purpose: undefined })) };
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();
    expect(screen.getByRole('group', { name: 'Guests' }).textContent).toBe('Guests:BusinessSightseeingGetawayOther');
  });

  it('a twin room warns that couples would not like separate beds; the gym is popular with business travellers', () => {
    const { controller, flush } = setup();
    controller.selectTool('twin');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.state = { ...controller.state, cash: 1_000_000, peakStarRating: 3, starRating: 3 };
    controller.selectTool('gym');
    controller.tileDown({ gridX: 7, gridY: 2 });
    controller.selectTool(null);
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();
    expect(screen.getByRole('dialog', { name: /Twin/ }).textContent).toContain("Couples won't like separate beds");
    controller.tileDown({ gridX: 7, gridY: 2 });
    flush();
    expect(screen.getByRole('dialog', { name: /Gym/ }).textContent).toContain('Popular with:   business travellers');
  });

  it('twin and family rooms can be built from the start', () => {
    const { controller, flush } = setup();
    fireEvent.click(screen.getByText('Standard Twin'));
    controller.tileDown({ gridX: 5, gridY: 2 });
    fireEvent.click(screen.getByText('Family Room'));
    controller.tileDown({ gridX: 6, gridY: 2 });
    flush();
    expect(controller.state.rooms.map(r => r.furnishing?.preset)).toEqual(['twin', 'bunk_family']);
    expect(controller.state.cash).toBe(50_000 - 2100 - 2350);
  });

  it('a refit the hotel can\'t afford yet can be booked; demolishing the room closes its furnishing for good', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    controller.state = { ...controller.state, peakStarRating: 2, cash: 1000 };
    controller.openFurnishing(controller.state.rooms[0].id);
    flush();
    upgrade('Queen bed', 'Shower room', 'Clothes rail');
    flush();
    expect(screen.queryByText(/Refit now/)).toBeNull();
    fireEvent.click(screen.getByText(/Book it: starts once there's \$2,870/));
    flush();
    expect(controller.state.rooms[0].pendingRefit).toBeDefined();
    expect(screen.getByRole('region', { name: /FURNISH ROOM/ }).textContent).toContain("starts once there's $2,870");

    controller.demolishRoom(controller.state.rooms[0].id);
    flush();
    expect(screen.queryByRole('region', { name: /FURNISH ROOM/ })).toBeNull();
    // A new room on the same tile (same id) doesn't bring the panel back
    controller.state = { ...controller.state, cash: 10_000 };
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    flush();
    expect(controller.state.rooms).toHaveLength(1);
    expect(screen.queryByRole('region', { name: /FURNISH ROOM/ })).toBeNull();
  });

  it('the cleaning panel puts the cleaning overlay on the map, and folds out of the way to show it', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    const [room] = controller.state.rooms;
    controller.state = {
      ...controller.state,
      staff: { ...controller.state.staff, housekeepers: 0 },
      rooms: [
        { ...room, status: 'cleaning', cleaningHoursRemaining: 2 },
        { ...room, id: 'room-1-5-2', floor: 1, status: 'cleaning', cleaningHoursRemaining: 2 }, // upstairs
      ],
      floorCount: 2,
    };
    expect(controller.cleaningOverlay).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Cleaning$/ }));
    flush();
    expect(controller.cleaningOverlay).toBe(true);
    const panel = () => screen.getByRole('region', { name: 'HOUSEKEEPING' });
    expect(panel().textContent).toContain('Dirty, waiting: 2');
    expect(panel().textContent).toContain('no housekeepers hired');
    expect(screen.getByRole('group', { name: 'Cleaning overlay key' }).textContent).toContain('Being cleaned');

    // Folded to its title bar: the overlay stays, with a summary beside the title
    fireEvent.click(screen.getByLabelText('Minimize'));
    flush();
    expect(controller.cleaningOverlay).toBe(true);
    expect(panel().textContent).toContain('2 waiting');
    expect(panel().textContent).not.toContain('Turnover cleaning');
    expect(controller.storyLogVisible).toBe(false);
    fireEvent.click(screen.getByLabelText('Expand'));
    flush();
    expect(panel().textContent).toContain('Turnover cleaning');

    // The map shows one floor: the panel points at the others
    fireEvent.click(screen.getByText('Floor 2 (1)'));
    flush();
    expect(controller.currentFloor).toBe(1);

    fireEvent.click(screen.getByLabelText('Close'));
    flush();
    expect(controller.cleaningOverlay).toBe(false);
    expect(screen.queryByRole('group', { name: 'Cleaning overlay key' })).toBeNull();
  });

  it('a folded panel says what the open one would: a grubby room isn\'t "all clean"; a folded story log lets incidents toast', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    controller.state = {
      ...controller.state,
      housekeeping: { ...controller.state.housekeeping, dailyCadence: 'none' },
      rooms: controller.state.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: 'g', cleanliness: 20 })),
    };
    controller.togglePanel('housekeeping');
    controller.toggleCollapsed();
    flush();
    const bar = screen.getByRole('region', { name: 'HOUSEKEEPING' }).textContent!;
    expect(bar).toContain('1 grubby');
    expect(bar).not.toContain('all clean');

    controller.togglePanel('story');
    expect(controller.storyLogVisible).toBe(true);
    controller.toggleCollapsed();
    expect(controller.storyLogVisible).toBe(false);
  });

  it('the room inspector says whether a dirty room is being cleaned or waiting, and why', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    controller.state = {
      ...controller.state,
      staff: { ...controller.state.staff, housekeepers: 0 },
      rooms: controller.state.rooms.map(r => ({ ...r, status: 'cleaning' as const, cleaningHoursRemaining: 2 })),
    };
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();
    expect(screen.getByRole('dialog', { name: /Standard Queen/ }).textContent).toContain('Dirty: waiting, no housekeepers hired');
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
