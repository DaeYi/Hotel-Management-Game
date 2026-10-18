// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/preact';
import { createRef } from 'preact';
import { GameController } from '../src/game/GameController';
import { App } from '../src/ui/App';
import { OBJECTIVES, TRAVEL, SPENDING } from '../src/config/balance';
import { guestWhereabouts } from '../src/ui/Inspectors';
import { createStarterHotel, addRoom, addFacility } from '../src/simulation/HotelState';
import { findRoute } from '../src/simulation/Layout';
import { makeWalk, makeStay } from '../src/simulation/Movement';
import { rerouteTrips, roomTile } from '../src/simulation/GuestMovement';
import type { HotelState, Leg } from '../src/simulation/types';

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
  it('shows a storage failure and lets the player retry saving', () => {
    let blocked = true;
    const storage: Storage = {
      length: 0, key: () => null, getItem: key => key === 'hotel-game-tutorial-seen' ? '1' : null, clear: () => {}, removeItem: () => {},
      setItem: () => { if (blocked) throw new Error('storage full'); },
    };
    const controller = new GameController(storage);
    render(<App controller={controller} worldRef={createRef()} />);
    act(() => { controller.saveNow(); controller.update(0); });
    expect(screen.getByRole('alert').textContent).toContain('Progress could not be saved');
    blocked = false;
    fireEvent.click(screen.getByText('Try saving again'));
    act(() => controller.update(0));
    expect(screen.queryByRole('alert')).toBeNull();
  });

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
    expect(screen.getByRole('group', { name: 'Guests' }).textContent).toBe('Guests:BusinessSightseeingGetawayEvent');
    // A guest from an older save, with no purpose: white, and in the legend too
    controller.state = { ...controller.state, guests: controller.state.guests.map(g => ({ ...g, purpose: undefined })) };
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();
    expect(screen.getByRole('group', { name: 'Guests' }).textContent).toBe('Guests:BusinessSightseeingGetawayEventOther');
  });

  it('a guest card: who they are, their rhythm and quirks, their mood and where they are; it follows them and closes once they have gone', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    const room = { ...controller.state.rooms[0], status: 'occupied' as const, guestId: 'g1' };
    controller.state = {
      ...controller.state, day: 2, hour: 23, rooms: [room],
      guests: [{
        id: 'g1', name: 'Sam', budget: 300, stayLength: 3, trait: 'normal', satisfaction: 72, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
        party: { kind: 'couple', size: 2 }, purpose: 'getaway',
        profile: { chronotype: 'night', mobility: 'limited', sleep: 'light', rowdiness: 'normal', checkoutHour: 11 },
        nightNoise: { exposure: 0.5, woken: 1, lastWokenNight: 0 },
      }],
    };
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();
    expect(screen.getByRole('dialog', { name: /Standard Queen/ }).textContent).toContain('Occupied: a couple on a getaway (light sleeper)');
    fireEvent.click(screen.getByText(/About Sam/));
    flush();
    const card = () => screen.getByRole('dialog', { name: 'Sam' }).textContent!;
    expect(card()).toContain('A couple on a getaway');
    expect(card()).toContain('Night 2 of 3');
    expect(card()).toContain('Night owl, sleeps 01:00-09:00, checks out 11:00 (asked for a late checkout: refused)');
    expect(card()).toContain('Walks slowly');
    expect(card()).toContain('Light sleeper, woken one night');
    expect(card()).toContain('72%');
    expect(card()).toMatch(/In room \d+/); // up at 23:00: a night owl isn't asleep yet
    // Allowing late checkout shows on their card
    controller.setLateCheckout('free');
    flush();
    expect(card()).toContain('checks out 13:00 (late checkout)');
    // Up a floor and back: the card stays
    controller.buildFloor();
    controller.setFloor(1);
    flush();
    expect(screen.getByRole('dialog', { name: 'Sam' })).toBeTruthy();
    controller.setFloor(0);
    // Their checkout (the last hour of their stay): the card stays while they walk out, then closes
    const tick = () => { act(() => (controller as unknown as { doTick(now: number): void }).doTick(0)); flush(); };
    controller.state = { ...controller.state, day: 4, hour: 10, lateCheckout: 'deny' };
    tick();
    expect(controller.selection?.kind).toBe('guest');
    expect((controller.state.walkers ?? []).some(w => w.guestId === 'g1')).toBe(true);
    expect(card()).toContain('Checked out, on their way out');
    expect(card()).toMatch(/Their review: \d/);
    tick();
    tick();
    expect(controller.selection).toBeNull();
  });

  it('a guest card counts nights from the evening, keeps a party name as they leave, and shows an older guest trait', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    const room = { ...controller.state.rooms[0], status: 'occupied' as const, guestId: 'g1' };
    const base = { id: 'g1', name: 'Sam', budget: 300, stayLength: 3, satisfaction: 60, checkInDay: 1, isReturning: false, hadNoiseComplaint: false };
    // 02:00 after their first evening: still their first night. An older save's guest: no profile, a light sleeper by trait
    controller.state = { ...controller.state, day: 2, hour: 2, rooms: [room], guests: [{ ...base, trait: 'light_sleeper' as const, party: { kind: 'solo' as const, size: 1 } }] };
    controller.selectGuest('g1', { gridX: 5, gridY: 2 });
    flush();
    const card = (name: string | RegExp) => screen.getByRole('dialog', { name }).textContent!;
    expect(card('Sam')).toContain('Night 1 of 3');
    expect(card('Sam')).toContain('Light sleeper');
    controller.state = { ...controller.state, hour: 9 };
    controller.selectGuest('g1', { gridX: 5, gridY: 2 });
    flush();
    expect(card('Sam')).toContain('Night 2 of 3');
    // A family walking out keeps its name on the card
    controller.state = {
      ...controller.state, guests: [],
      walkers: [{ id: 'leave-g1-1', trait: 'normal', isReturning: false, reason: 'checked_out', trip: [], guestId: 'g1', name: 'Sam', party: { kind: 'family', size: 4 } }],
    };
    controller.selectGuest('g1', { gridX: 5, gridY: 2 });
    flush();
    expect(card(/family$/)).toContain('Checked out');
  });

  it('a regular: stays, their favourite and how it is going, their mood; the gym knows its fans; the pool is wanted', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.state = { ...controller.state, cash: 1_000_000, peakStarRating: 4, starRating: 4 };
    controller.selectTool('gym');
    controller.tileDown({ gridX: 7, gridY: 2 });
    controller.selectTool(null);
    const room = { ...controller.state.rooms[0], status: 'occupied' as const, guestId: 'g1' };
    controller.state = {
      ...controller.state, day: 9, hour: 15, rooms: [room],
      guests: [{
        id: 'g1', name: 'Mei', budget: 300, stayLength: 3, trait: 'normal', satisfaction: 61.7, checkInDay: 8, isReturning: true, hadNoiseComplaint: false,
        party: { kind: 'solo', size: 1 }, purpose: 'business',
        profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, favorite: 'gym' },
        loyalty: { personId: 'mei', stays: 4 },
        facilitiesUsed: { gym: { level: 1, day: 9, today: 1, visits: 2, lastAt: 200 } },
      }],
      facilityDemand: { day: 9, wanted: { pool: 3 }, full: { gym: 1 }, tooFar: {}, fullAt: { [controller.state.facilities[0].id]: 1 } },
      dailyStats: [{ day: 8, occupancy: 0.5, totalRevenue: 0, valuation: 0, wanted: { pool: 4 } }],
    };
    controller.selectGuest('g1', { gridX: 5, gridY: 2 });
    flush();
    const card = screen.getByRole('dialog', { name: 'Mei' }).textContent!;
    expect(card).toContain('4th stay (a regular)');
    expect(card).toContain('Loves the gym (2 visits this stay)');
    expect(card).toMatch(/61% content/); // rounded down, so the number is in the word's band (62 is delighted)
    controller.tileDown({ gridX: 7, gridY: 2 });
    flush();
    const gym = screen.getByRole('dialog', { name: /Gym/ }).textContent!;
    expect(gym).toContain('Fans staying:   1');
    expect(gym).toContain('Turned back today: 1 (full)');
    expect(screen.getByText('asked for 7\u00d7 this week')).toBeTruthy(); // the pool: 4 yesterday, 3 today
    expect(screen.getByRole('group', { name: 'Guest marks' }).textContent).toContain('VIP');
  });

  it('the cleaning panel sets the late checkout; the legend explains the marks on guests', () => {
    const { controller, flush } = setup();
    controller.togglePanel('housekeeping');
    flush();
    const group = screen.getByRole('group', { name: 'Late checkout' });
    expect(group.textContent).toBe('NoFreeFor a fee');
    fireEvent.click(screen.getByText('For a fee'));
    flush();
    expect(controller.state.lateCheckout).toBe('fee');
    expect(screen.getByRole('group', { name: 'Guest marks' }).textContent).toContain('Light sleeper');
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

describe('Guests and service', () => {
  /** One standard room at (5, 2) with this guest in it, at 23:00 on day 3, with someone at the desk and a housekeeper. */
  function oneRoom(guest: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    const room = { ...controller.state.rooms[0], status: 'occupied' as const, guestId: 'h' };
    controller.state = {
      ...controller.state, day: 3, hour: 23, rooms: [room], staff: { ...controller.state.staff, frontDesk: 1, housekeepers: 1 },
      guests: [{
        id: 'h', name: 'Kit', budget: 300, stayLength: 3, trait: 'normal', satisfaction: 60, checkInDay: 2, isReturning: false, hadNoiseComplaint: false,
        profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'rowdy', checkoutHour: 11 }, ...guest,
      }] as never,
      ...extra,
    };
    return { controller, flush, room };
  }

  it('friends round: the room and guest cards say so, and the front desk can ask them to leave (once)', () => {
    const T = 2 * 24 + 23;
    const { controller, flush, room } = oneRoom({ hostedNight: { day: 3, visitors: 2 } });
    const tile = { gridX: room.gridX, gridY: room.gridY, floor: 0, door: room.door };
    controller.state = {
      ...controller.state,
      walkers: [{
        id: 'visit-h', trait: 'normal', isReturning: false, reason: 'visitor', hostId: 'h', party: { kind: 'friends', size: 2 },
        trip: [{ kind: 'stay', at: tile, start: T - 0.5, end: T + 2, activity: 'in_room', placeId: room.id }, { kind: 'walk', start: T + 2, end: T + 2.5, path: [tile, { gridX: 5, gridY: 1, floor: 0 }], hoursPerTile: 0.5 }],
      }],
    };
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();
    const roomCard = () => screen.getByRole('dialog', { name: /Standard Queen/ }).textContent!;
    expect(roomCard()).toContain('Visitors:    2 visitors since 22:30, leaving about 01:00');
    fireEvent.click(screen.getByText(/About Kit/));
    flush();
    expect(screen.getByRole('dialog', { name: 'Kit' }).textContent).toContain('2 visitors since 22:30, leaving about 01:00');
    fireEvent.click(screen.getByText('Ask the visitors to leave'));
    flush();
    expect(controller.state.walkers![0].trip[0].end).toBeCloseTo(T + 0.1, 9);
    expect(controller.state.guests[0].satisfaction).toBeCloseTo(50, 9);
    expect(screen.queryByText('Ask the visitors to leave')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Kit' }).textContent).toContain('asked to leave');
  });

  it('the staff panel sets what the desk does about complaints; the legend explains the hangers and the ring', () => {
    const { controller, flush } = setup();
    controller.togglePanel('staff');
    flush();
    expect(screen.getByRole('group', { name: 'Visitors' }).textContent).toBe('Ask them to leaveLet them stay');
    fireEvent.click(screen.getByText('Let them stay'));
    flush();
    expect(controller.state.visitorPolicy).toBe('allow');
    const marks = screen.getByRole('group', { name: 'Guest marks' }).textContent!;
    expect(marks).toContain('Make up the room');
    expect(marks).toContain('Do not disturb');
    expect(marks).toContain('Friends round (noisy)');
  });

  it('a do-not-disturb room: the hanger on its card, its guest’s wishes, and the cleaning panel counts it waiting', () => {
    const { controller, flush } = oneRoom({ profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, housekeeping: 'dnd' } }, { hour: 13 });
    controller.state = { ...controller.state, rooms: controller.state.rooms.map(r => ({ ...r, dailyCleanHoursRemaining: 0.5 })) };
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.togglePanel('housekeeping');
    flush();
    const roomCard = screen.getByRole('dialog', { name: /Standard Queen/ }).textContent!;
    expect(roomCard).toContain('Hanger:      Do not disturb');
    expect(roomCard).toContain('do not disturb: waiting for the guests to be out long enough');
    expect(screen.getByText(/Daily cleans waiting for guests to go out: 1/)).toBeTruthy();
    expect(screen.getByText(/Daily cleans due: 0/)).toBeTruthy();
    fireEvent.click(screen.getByText(/About Kit/));
    flush();
    expect(screen.getByRole('dialog', { name: 'Kit' }).textContent).toContain('Do not disturb (cleaned only while out)');
  });

  it('a guest card says "at the Shop" all through the visit, even once something is built across their way back', () => {
    let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
    s = addRoom(s, 'standard', 3, 2, 0, 'up')!;
    s = addFacility(s, 'shop', 8, 0, 0, 'down')!;
    const [room, shop] = [s.rooms[0], s.facilities[0]];
    const at = { gridX: shop.gridX, gridY: shop.gridY, floor: 0, door: shop.door };
    const pace = TRAVEL.guestHoursPerTile;
    const there = makeWalk(findRoute(s, roomTile(room), at, pace)!.path, 10, pace);
    const trip: Leg[] = [there, makeStay(at, there.end, 10.9, 'visit', { placeId: shop.id }), makeWalk(findRoute(s, at, roomTile(room), pace)!.path, 10.9, pace)];
    s = {
      ...s, rooms: [{ ...room, status: 'occupied', guestId: 'g' }],
      guests: [{ id: 'g', name: 'G', budget: 300, stayLength: 3, trait: 'normal', satisfaction: 60, checkInDay: 1, isReturning: false, hadNoiseComplaint: false, trip, tripKind: 'visit' }],
    };
    const after = rerouteTrips(addRoom(s, 'standard', 6, 1, 0, 'up')!, 10.6); // across the corridor back to their room
    expect(after.guests[0].trip).not.toEqual(trip);
    expect(guestWhereabouts(after.guests[0], after, 10.7)).toBe('at the Shop');
    expect(guestWhereabouts(after.guests[0], after, 10.95)).toBe('back from the Shop');
  });
});

describe('The front desk and complaints', () => {
  it('the staff panel tells the desk’s day: the line now, check-ins and waits, give-ups (with advice), complaints heard', () => {
    const { controller, flush } = setup();
    controller.state = { ...controller.state, deskToday: { day: controller.state.day, checkedIn: 4, waitHours: 1, longestWait: 0.5, gaveUp: 2, complaints: 1 } };
    controller.togglePanel('staff');
    flush();
    const desk = screen.getByLabelText('Front desk today').textContent!;
    expect(desk).toContain('In line now: 0');
    expect(desk).toContain('4 checked in today (average wait 15 min)');
    expect(desk).toContain('2 gave up in line');
    expect(desk).toContain('1 complaint at the desk');
    expect(desk).toContain('another clerk would serve them'); // one clerk, a desk that seats two
    const night = controller.state.staffRoster!.find(m => m.role === 'front_desk' && m.shift === 'night')!;
    controller.state = { ...controller.state, staff: { ...controller.state.staff, frontDesk: 4 }, staffRoster: [...controller.state.staffRoster!, { ...night, id: 'extra-night', serial: 99, deskLane: undefined }], staffPlan: null };
    controller.togglePanel('staff');
    controller.togglePanel('staff');
    flush();
    expect(screen.getByLabelText('Front desk today').textContent).toContain('build another desk'); // every seat taken
  });

  it('a guest card says "checking in at the front desk" at a clerk; with the desk queue off, "arriving" as it always did', () => {
    const s = createStarterHotel();
    const desk = s.fixtures.find(f => f.type === 'desk')!;
    const at = { gridX: desk.gridX, gridY: desk.gridY + 1, floor: 0 };
    const g = (lane?: string) => ({
      id: 'g', name: 'G', budget: 300, stayLength: 3, trait: 'normal' as const, satisfaction: 60, checkInDay: 1, isReturning: false, hadNoiseComplaint: false, tripKind: 'arrival' as const,
      trip: [{ kind: 'stay' as const, at, start: 10, end: 10.3, activity: 'check_in' as const, placeId: desk.id, ...(lane ? { lane } : {}) }],
    });
    expect(guestWhereabouts(g(`${desk.id}:0`), s, 10.1)).toBe('checking in at the front desk');
    expect(guestWhereabouts(g(), s, 10.1)).toBe('arriving');
  });

  it('a guest card: how patient and how vocal, the wait to check in, the complaint; a stoic guest’s mood is a "?"', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    const room = { ...controller.state.rooms[0], status: 'occupied' as const, guestId: 'g1' };
    const base = {
      id: 'g1', name: 'Ines', budget: 300, stayLength: 3, trait: 'normal' as const, satisfaction: 44, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
      checkInWait: 0.4, complaint: { about: 'the noise last night', via: 'desk' as const, at: (2 - 1) * 24 + 8.5 },
    };
    controller.state = {
      ...controller.state, day: 2, hour: 12, rooms: [room],
      guests: [{ ...base, profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, patience: 'impatient', voice: 'vocal' } }] as never,
    };
    controller.selectGuest('g1', { gridX: 5, gridY: 2 });
    flush();
    const card = () => screen.getByRole('dialog', { name: 'Ines' }).textContent!;
    expect(card()).toContain('Impatient: waits about 10 minutes in line at most');
    expect(card()).toContain('Speaks up when something is wrong');
    expect(card()).toContain('Waited 24 min in line to check in');
    expect(card()).toContain('Complained at the front desk about the noise last night (08:30)');
    expect(card()).toContain('44%');
    controller.state = { ...controller.state, guests: [{ ...base, profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, voice: 'stoic' } }] as never };
    controller.selectGuest('g1', { gridX: 5, gridY: 2 });
    flush();
    expect(card()).toContain('Mood:  ? (keeps it to themselves)');
    expect(card()).toContain('Keeps it to themselves');
    expect(card()).not.toContain('44%');
    expect(screen.getByRole('group', { name: 'Guest marks' }).textContent).toContain('Losing patience in line');
    expect(screen.getByRole('group', { name: 'Guest marks' }).textContent).toContain('Going to complain');
  });
});

describe('How guests spend', () => {
  const profile = (spending: 'thrifty' | 'standard' | 'splurger') => ({ chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, spending });

  it('a guest card says how they spend; a leaving guest what they spent; the legend has the "$"', () => {
    const { controller, flush } = setup();
    controller.selectTool('standard');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    const room = { ...controller.state.rooms[0], status: 'occupied' as const, guestId: 'g1' };
    const base = { id: 'g1', name: 'Malik', budget: 300, stayLength: 3, trait: 'big_spender', satisfaction: 60, checkInDay: 1, isReturning: false, hadNoiseComplaint: false };
    const show = (guest: object) => {
      controller.state = { ...controller.state, day: 2, hour: 12, rooms: [room], guests: [guest] as never };
      controller.selectGuest('g1', { gridX: 5, gridY: 2 });
      flush();
      return screen.getByRole('dialog', { name: 'Malik' }).textContent!;
    };
    const big = show({ ...base, profile: profile('splurger'), spent: { shop: 24, restaurant: 60 } });
    expect(big).toContain('Big spender: spent $84 here this stay (restaurant $60, shop $24)');
    expect(big).toContain('Notices the amenities, and tired decor');
    expect(show({ ...base, profile: profile('splurger') })).toContain('Big spender: nothing spent here yet');
    const thrifty = show({ ...base, trait: 'normal', profile: profile('thrifty'), dinnersOut: { day: 2, count: 2 } });
    expect(thrifty).toContain('Watches the pennies: no shop, eats in town (out to dinner 2 nights)');
    expect(thrifty).toContain('Minds a high price more than the frills');
    // A guest from an older save (no profile): what they've spent, too; a big spender what they mind
    expect(show({ ...base, trait: 'normal', spent: { shop: 26, restaurant: 0 } })).toContain('Spent $26 here this stay');
    const older = show({ ...base, spent: { shop: 26, restaurant: 0 } });
    expect(older).toContain('Big spender: spent $26 here this stay (shop $26)');
    expect(older).toContain('Notices the amenities, and tired decor');
    const standard = show({ ...base, trait: 'normal', profile: profile('standard'), spent: { shop: 26, restaurant: 0 } });
    expect(standard).toContain('Spent $26 here this stay');
    expect(standard).not.toContain('Big spender');
    expect(screen.getByRole('group', { name: 'Guest marks' }).textContent).toContain('Big spender');
    // Checked out, on their way out
    controller.state = {
      ...controller.state, guests: [],
      walkers: [{ id: 'w', trait: 'big_spender', isReturning: false, reason: 'checked_out', guestId: 'g1', name: 'Malik', spent: 84, trip: [makeStay({ gridX: 1, gridY: 4, floor: 0 }, 0, 999, 'wait')] }],
    };
    controller.selectGuest('g1', { gridX: 1, gridY: 4 });
    flush();
    expect(screen.getByRole('dialog', { name: 'Malik' }).textContent).toContain('Spent $84 here');
  });

  it('the restaurant’s card says what a cover costs, and who pays more or nothing; the Finance panel splits the month’s revenue', () => {
    const { controller, flush } = setup();
    controller.state = { ...controller.state, cash: 1_000_000, peakStarRating: 5, starRating: 5 };
    controller.selectTool('restaurant');
    controller.tileDown({ gridX: 7, gridY: 2 });
    controller.selectTool(null);
    controller.tileDown({ gridX: 7, gridY: 2 });
    flush();
    expect(screen.getByRole('dialog', { name: /Restaurant/ }).textContent).toContain('Spend/visit:    $12 a table for one or two (big spenders $24; thrifty guests eat out)');
    // A shop at level 2: half as much again; with spending styles off, the card as before
    controller.selectTool('shop');
    controller.tileDown({ gridX: 8, gridY: 2 });
    controller.selectTool(null);
    controller.state = { ...controller.state, facilities: controller.state.facilities.map(f => (f.type === 'shop' ? { ...f, level: 2 } : f)) };
    controller.tileDown({ gridX: 8, gridY: 2 });
    flush();
    const shop = () => screen.getByRole('dialog', { name: /Shop/ }).textContent!;
    expect(shop()).toContain("Spend/visit:    $39 for one or two (big spenders $78; thrifty guests don't shop)");
    SPENDING.enabled = false;
    try {
      controller.tileDown({ gridX: 8, gridY: 2 });
      flush();
      expect(shop()).toContain('Spend/visit:    $39');
      expect(shop()).not.toContain('big spenders');
    } finally { SPENDING.enabled = true; }
    controller.state = { ...controller.state, totalRevenue: 10000, onSite: { shop: 300, restaurant: 700, splurgers: 600 }, dailyStats: [{ day: 1, occupancy: 0.5, totalRevenue: 0, valuation: 0 }] };
    controller.togglePanel('finance');
    flush();
    expect(screen.getByText(/^Revenue, last 30 days:/).textContent).toBe('Revenue, last 30 days: $10,000 (rooms $9,000, on site $1,000)');
    expect(screen.getByLabelText('On-site takings').textContent).toContain('On site: restaurant $700, shop $300 · 60% from big spenders');
  });

  it('the Finance panel\u2019s split covers the last 30 days (a save from before spending styles counts from zero); nothing before the first day ends', () => {
    const { controller, flush } = setup();
    const day = (d: number, revenue: number, onSite?: { shop: number; restaurant: number; splurgers: number }) => ({ day: d, occupancy: 0.5, totalRevenue: revenue, valuation: 0, ...(onSite ? { onSite } : {}) });
    // 32 days: the baseline (31 back) had takings of 100 so far; the month since, 500 more
    const stats = Array.from({ length: 32 }, (_, i) => day(i + 1, 1000 * i, i <= 1 ? { shop: 60, restaurant: 40, splurgers: 50 } : { shop: 60 + i * 10, restaurant: 40 + i * 5, splurgers: 50 }));
    controller.state = { ...controller.state, dailyStats: stats, totalRevenue: 31000, onSite: { shop: 400, restaurant: 200, splurgers: 300 } };
    controller.togglePanel('finance');
    flush();
    expect(screen.getByText(/^Revenue, last 30 days:/).textContent).toBe('Revenue, last 30 days: $30,000 (rooms $29,500, on site $500)');
    // The baseline from before spending styles: counted from zero
    controller.state = { ...controller.state, dailyStats: stats.map((s, i) => (i === 1 ? day(2, 1000) : s)) };
    controller.togglePanel('finance');
    controller.togglePanel('finance');
    flush();
    expect(screen.getByText(/^Revenue, last 30 days:/).textContent).toBe('Revenue, last 30 days: $30,000 (rooms $29,400, on site $600)');
    // The first day, before it's recorded: the revenue so far
    controller.state = { ...controller.state, dailyStats: [], totalRevenue: 52, onSite: { shop: 52, restaurant: 0, splurgers: 0 } };
    controller.togglePanel('finance');
    controller.togglePanel('finance');
    flush();
    expect(screen.getByText(/^Revenue, last 30 days:/).textContent).toBe('Revenue, last 30 days: $52 (rooms $0, on site $52)');
  });
});

describe('Spotlight guests', () => {
  it('the top bar counts down; the held suite\'s card says so, lets the hold go, and won\'t renovate past the arrival; another suite can be held; the Staff panel sets the policy', () => {
    const { controller, flush } = setup();
    controller.state = { ...controller.state, cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    controller.selectTool('suite');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.tileDown({ gridX: 6, gridY: 2 });
    controller.selectTool(null);
    const [a, b] = controller.state.rooms;
    controller.state = {
      ...controller.state, day: 10, hour: 8, rooms: controller.state.rooms.map(r => ({ ...r, decor: 50 })),
      spotlight: { kind: 'writer', week: 1, salt: '', announceDay: 9, arrivalDay: 10, arrivalHour: 15, status: 'announced', chainId: 'spotlight-10', roomId: a.id },
    };
    flush();
    expect(document.body.textContent).toMatch(/Travel writer due Wed ~15:00 \((in \d+h|now)\)/);
    controller.tileDown({ gridX: 5, gridY: 2 });
    flush();
    const card = () => screen.getByRole('dialog', { name: /Suite/ });
    expect(card().textContent).toContain('Held:        for the travel writer (Wed ~15:00)');
    const renovate = screen.getByText(/^Renovate/) as HTMLButtonElement;
    expect(renovate.disabled).toBe(true);
    expect(renovate.title).toBe('Held for the travel writer: it wouldn\'t be done by Wed ~15:00');
    fireEvent.click(screen.getByText('Let the hold go'));
    flush();
    expect(controller.state.spotlight!.roomId).toBeUndefined();
    expect(controller.state.spotlight!.released).toBe(true);
    // The other suite: hold it instead
    // (first, a travel writer staying elsewhere: their card says who they are)
    const writer = { id: 'spotlight-3', name: 'Casey Larsen', budget: 1e9, stayLength: 2, trait: 'normal' as const, satisfaction: 60, checkInDay: 9, isReturning: false, hadNoiseComplaint: false, party: { kind: 'solo' as const, size: 1 }, profile: { chronotype: 'regular' as const, mobility: 'normal' as const, sleep: 'normal' as const, rowdiness: 'normal' as const, checkoutHour: 11 }, spotlight: { kind: 'writer' as const } };
    controller.state = { ...controller.state, guests: [writer], rooms: controller.state.rooms.map(r => (r.id === a.id ? { ...r, status: 'occupied' as const, guestId: writer.id } : r)) };
    controller.selectGuest(writer.id, a);
    flush();
    expect(screen.getByRole('dialog', { name: /Casey Larsen/ }).textContent).toContain('Travel writer: judges the hotel as a 4-star one');
    controller.state = { ...controller.state, guests: [], rooms: controller.state.rooms.map(r => (r.id === a.id ? { ...r, status: 'vacant' as const, guestId: undefined } : r)) };
    controller.tileDown({ gridX: 6, gridY: 2 });
    flush();
    fireEvent.click(screen.getByText('Hold for the travel writer'));
    flush();
    expect(controller.state.spotlight).toMatchObject({ roomId: b.id, chosen: true, released: false });
    // The Staff panel: the policy, and a note when the hold was let go
    controller.releaseHold();
    controller.togglePanel('staff');
    flush();
    expect(screen.getByText(/The hold was let go for the guest coming now/)).toBeTruthy();
    fireEvent.click(screen.getByText('Hold a suite'));
    flush();
    expect(controller.state.spotlight!.released).toBe(false);
    fireEvent.click(screen.getByText("Don't hold one"));
    flush();
    expect(controller.state.spotlightHold).toBe('none');
  });

  it('the Furnish panel: a refit of the held suite that wouldn\'t be done in time is booked for after the guest', () => {
    const { controller, flush } = setup();
    controller.state = { ...controller.state, cash: 1_000_000, peakStarRating: 5, starRating: 3 };
    controller.selectTool('suite');
    controller.tileDown({ gridX: 5, gridY: 2 });
    controller.selectTool(null);
    const [a] = controller.state.rooms;
    controller.state = {
      ...controller.state, day: 10, hour: 12,
      spotlight: { kind: 'writer', week: 1, salt: '', announceDay: 9, arrivalDay: 10, arrivalHour: 15, status: 'announced', chainId: 'spotlight-10', roomId: a.id },
    };
    controller.openFurnishing(a.id);
    flush();
    const panel = () => screen.getByRole('region', { name: /FURNISH ROOM/ });
    pickPiece('Bathroom with tub');
    fireEvent.change(screen.getByLabelText('Bathroom'), { target: { value: 'bath_shower' } });
    flush();
    expect(panel().textContent).toContain('Held for the travel writer (Wed ~15:00): a refit waits till they\'ve been.');
    expect(screen.queryByText(/^Refit now/)).toBeNull();
    fireEvent.click(screen.getByText(/^Refit after the travel writer/));
    flush();
    expect(controller.state.rooms[0].pendingRefit).toBeDefined();
    expect(controller.state.rooms[0].status).toBe('vacant');
    expect(panel().textContent).toContain('Refit booked: it starts once the travel writer has been.');
    // Held but being cleaned: the refit can't start before they've been either
    controller.cancelRefit(a.id);
    // (a day ahead: a refit begun now would be done in time, but the room's not empty to begin it)
    controller.state = { ...controller.state, day: 9, rooms: controller.state.rooms.map(r => (r.id === a.id ? { ...r, status: 'cleaning' as const, cleaningHoursRemaining: 0.5 } : r)) };
    flush();
    expect(screen.getByText(/^Refit after the travel writer/)).toBeTruthy();
    expect(screen.queryByText(/^Refit after cleaning/)).toBeNull();
    expect(panel().textContent).toContain('Held for the travel writer (Wed ~15:00): a refit waits till they\'ve been.');
  });
});
