// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/preact';
import { createRef } from 'preact';
import { App } from '../src/ui/App';
import { GameController, TICK_INTERVAL_MS } from '../src/game/GameController';
import { STAFF_FATIGUE } from '../src/config/staff';
import { BREAK_ROOM } from '../src/config/balance';
import { addFixture, addRoom } from '../src/simulation/HotelState';
import { hiringCandidates } from '../src/simulation/StaffHiring';
import { staminaOf } from '../src/simulation/StaffFatigue';
import { getStaffPlan } from '../src/simulation/StaffManager';
import { hourStart, makeStay, makeWalk } from '../src/simulation/Movement';
import type { StaffMember, StaffPlan } from '../src/simulation/types';

afterEach(() => { cleanup(); localStorage.clear(); STAFF_FATIGUE.enabled = true; vi.useRealTimers(); });

function controller() {
  localStorage.setItem('hotel-game-tutorial-seen', '1');
  return new GameController();
}

function show(c: GameController) {
  render(<App controller={c} worldRef={createRef()} />);
  return () => act(() => c.update(0));
}

function workingHotel(c: GameController, fatigue = 60) {
  const built = addRoom({ ...c.state, day: 1, hour: 12 }, 'standard', 5, 2, 0, 'up')!;
  const member: StaffMember = { ...built.staffRoster!.find(m => m.role === 'housekeeper')!,
    at: { gridX: 5, gridY: 2, floor: 0 },
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal' },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue } };
  const T = hourStart(built), room = built.rooms[0];
  const plan: StaffPlan = { start: T, itineraries: [{ staffId: member.id, legs: [
    makeStay(member.at!, T, T + 1, 'clean', { placeId: room.id, job: 'turnover', workRate: STAFF_FATIGUE.tiredRate }),
  ], end: { at: member.at } }] };
  c.state = { ...built, staff: { frontDesk: 0, housekeepers: 1, maintenanceWorkers: 0 }, staffRoster: [member], staffPlan: plan };
  return { member, T, room };
}

it('shows each candidate’s fixed stamina and preserves their agreed wage when hired', () => {
  const c = controller(), candidate = hiringCandidates(c.state, 'housekeeper')[0];
  const flush = show(c);
  act(() => c.togglePanel('staff')); flush();
  const candidateCard = screen.getByRole('button', { name: `Hire ${candidate.name}` }).closest('li')!;
  const stamina = staminaOf(candidate);
  const label = `${stamina[0].toUpperCase()}${stamina.slice(1)}`;
  expect(candidateCard.textContent).toContain(`Stamina: ${label}`);
  expect(candidateCard.textContent).toContain(`${STAFF_FATIGUE.gain[stamina]} fatigue/active hour`);
  expect(within(candidateCard).getByTitle(/Stamina is fixed at hire/).title).toContain('Stamina does not change wages');
  fireEvent.click(within(candidateCard).getByRole('button', { name: `Hire ${candidate.name}` })); flush();
  const hired = c.state.staffRoster!.find(m => m.candidateId === candidate.id)!;
  expect(hired.dailyWage).toBe(candidate.dailyWage);
  expect(hired.profile?.stamina).toBe(candidate.profile.stamina);
  fireEvent.click(screen.getByRole('button', { name: candidate.name, exact: true })); flush();
  const card = screen.getByRole('dialog', { name: candidate.name });
  expect(card.textContent).toContain(`Stamina: ${label}`);
  expect(within(card).getByRole('progressbar', { name: `Energy for ${candidate.name}` })).toBeTruthy();
  expect(screen.queryByLabelText(`Stamina for ${candidate.name}`)).toBeNull();
});

it('projects energy through visible work between ticks and shows tiredness in the staff inspector', () => {
  vi.useFakeTimers();
  const c = controller(), { member } = workingHotel(c);
  const flush = show(c);
  act(() => c.selectStaff(member.id)); flush();
  const energy = () => screen.getByRole('progressbar', { name: `Energy for ${member.name}` }) as HTMLProgressElement;
  expect(energy().value).toBe(40);
  expect(energy().getAttribute('aria-valuetext')).toContain('Tired');
  act(() => { c.update(TICK_INTERVAL_MS / 2); vi.advanceTimersByTime(250); });
  expect(c.state.staffRoster![0].stats!.fatigue).toBe(60);
  expect(energy().value).toBe(38); // normal stamina now uses 5 energy per active hour
  expect(screen.getByRole('dialog', { name: member.name }).textContent).toContain('15% slower while tired');
});

it('updates the displayed cleaning rate when the current itinerary crosses the tired threshold', () => {
  vi.useFakeTimers();
  const c = controller(), { member, room } = workingHotel(c, 59);
  c.state = { ...c.state, rooms: [{ ...room, status: 'cleaning', cleaningHoursRemaining: 10 }], staffPlan: null };
  c.state = { ...c.state, staffPlan: getStaffPlan(c.state) };
  const flush = show(c);
  act(() => c.selectStaff(member.id)); flush();
  const card = () => screen.getByRole('dialog', { name: member.name });
  expect(card().textContent).toContain('Cleaning 1×');
  act(() => { c.update(TICK_INTERVAL_MS / 2); vi.advanceTimersByTime(250); });
  expect(c.state.staffRoster![0].stats!.fatigue).toBe(59);
  expect(card().textContent).toContain('Cleaning 0.85×');
});

it('shows a mandatory break only when the worker reaches the rest stay and counts actual occupied seats', () => {
  vi.useFakeTimers();
  const c = controller();
  const { member, T } = workingHotel(c, 85);
  const withRoom = addFixture(c.state, 'breakroom', 6, 2, 0)!;
  const room = withRoom.fixtures.find(f => f.type === 'breakroom')!;
  const hall = { gridX: room.gridX, gridY: room.gridY - 1, floor: 0 }, at = { gridX: room.gridX, gridY: room.gridY, floor: 0 };
  const person = { ...member, at: hall, fatigueBreak: { at, placeId: room.id, start: T + 0.25, end: T + 0.75 } };
  const resting: StaffMember = { ...member, id: 'colleague', name: 'Colleague', at, stats: { ...member.stats!, fatigue: 70 } };
  c.state = { ...withRoom, staff: { ...withRoom.staff, housekeepers: 2 }, staffRoster: [person, resting], staffPlan: {
    start: T, itineraries: [
      { staffId: person.id, legs: [makeWalk([hall, at], T, 0.25), makeStay(at, T + 0.25, T + 0.75, 'rest', { placeId: room.id, restRate: STAFF_FATIGUE.roomRecovery })], end: { at } },
      { staffId: resting.id, legs: [makeStay(at, T, T + 1, 'rest', { placeId: room.id, restRate: STAFF_FATIGUE.roomRecovery })], end: { at } },
    ],
  } };
  const flush = show(c);
  act(() => c.togglePanel('staff')); flush();
  const panel = () => screen.getByLabelText('Staff breaks');
  expect(panel().textContent).toContain(`1/${BREAK_ROOM.seats} seats in use`);
  expect(screen.getByRole('progressbar', { name: `Energy for ${person.name}` }).getAttribute('aria-valuetext')).toContain('Needs a break');
  act(() => { c.update(TICK_INTERVAL_MS / 2); vi.advanceTimersByTime(250); });
  expect(panel().textContent).toContain(`2/${BREAK_ROOM.seats} seats in use`);
  expect(screen.getByRole('progressbar', { name: `Energy for ${person.name}` }).getAttribute('aria-valuetext')).toContain('Taking a break in the break room');
  expect(screen.getAllByText(`Recovering ${STAFF_FATIGUE.roomRecovery} energy/hour.`).length).toBeGreaterThan(0);
  expect(panel().textContent).toContain('30-minute break');
});

it('explains break-room recovery when building and hides fatigue UI when disabled', () => {
  const c = controller();
  const flush = show(c);
  const build = screen.getByRole('button', { name: /Break Room/ });
  expect(build.textContent).toContain(`${BREAK_ROOM.seats} rest seats`);
  expect(build.title).toContain(`${STAFF_FATIGUE.roomRecovery} energy/hour`);
  act(() => c.togglePanel('staff')); flush();
  expect(screen.getByLabelText('Staff breaks').textContent).toContain('No break rooms yet');
  STAFF_FATIGUE.enabled = false;
  act(() => { c.closePanel(); c.togglePanel('staff'); }); flush();
  expect(screen.queryByLabelText('Staff breaks')).toBeNull();
  expect(screen.queryByRole('progressbar', { name: /^Energy for / })).toBeNull();
  expect(screen.queryByText(/^Stamina:/)).toBeNull();
  expect(screen.getByRole('button', { name: /Break Room/ }).textContent).toContain('idle staff rest');
});

it('shows the saved rest rate instead of retroactively granting an older stay faster recovery', () => {
  const c = controller();
  const { member, T } = workingHotel(c, 70);
  const built = addFixture(c.state, 'breakroom', 6, 2, 0)!;
  const room = built.fixtures.find(f => f.type === 'breakroom')!;
  const at = { gridX: room.gridX, gridY: room.gridY, floor: room.floor };
  c.state = { ...built, staffRoster: [{ ...member, at }], staffPlan: { start: T, itineraries: [{ staffId: member.id,
    legs: [makeStay(at, T, T + 1, 'rest', { placeId: room.id })], end: { at } }] } };
  const flush = show(c);
  act(() => c.selectStaff(member.id)); flush();
  const card = screen.getByRole('dialog', { name: member.name });
  expect(card.textContent).toContain('Resting in the break room');
  expect(card.textContent).toContain(`Recovering ${STAFF_FATIGUE.fallbackRecovery} energy/hour.`);
});
