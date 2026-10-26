// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/preact';
import { createRef } from 'preact';
import { App } from '../src/ui/App';
import { GameController, TICK_INTERVAL_MS } from '../src/game/GameController';
import { STAFF_CLEANING_SUPPORT } from '../src/config/staff';
import { addRoom } from '../src/simulation/HotelState';
import { hiringCandidates } from '../src/simulation/StaffHiring';
import { physicalDeskLanes } from '../src/simulation/FrontDesk';
import { getStaffPlan } from '../src/simulation/StaffManager';
import { hourStart, makeStay, makeWalk } from '../src/simulation/Movement';
import type { HotelState, StaffMember } from '../src/simulation/types';

const candidateChance = STAFF_CLEANING_SUPPORT.candidateChance;
afterEach(() => {
  cleanup(); localStorage.clear(); vi.useRealTimers();
  STAFF_CLEANING_SUPPORT.enabled = true;
  STAFF_CLEANING_SUPPORT.candidateChance = candidateChance;
});
function controller() {
  localStorage.setItem('hotel-game-tutorial-seen', '1');
  return new GameController();
}

it('explains early-shift turnover training and preserves the displayed capability and wage on hire/reload', () => {
  STAFF_CLEANING_SUPPORT.candidateChance = 1;
  const c = controller(), candidate = hiringCandidates(c.state, 'front_desk', 'early')[0];
  render(<App controller={c} worldRef={createRef()} />);
  act(() => { c.togglePanel('staff'); c.update(0); });
  fireEvent.click(within(screen.getByRole('group', { name: 'Hiring role' })).getByRole('button', { name: 'Front desk' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Shift for new clerk' }), { target: { value: 'early' } });
  const card = screen.getByRole('button', { name: `Hire ${candidate.name}` }).closest('li')!;
  expect(card.textContent).toContain('Turnover trained');
  expect(card.textContent).toContain('15% training premium included in the agreed wage.');
  expect(card.textContent).toContain('07:00–14:00');
  expect(card.textContent).toContain('only while another early-shift clerk stays at the desk for the whole trip');
  expect(card.textContent).toContain('Specialty:');
  fireEvent.click(within(card).getByRole('button', { name: `Hire ${candidate.name}` }));
  act(() => c.update(0));
  const member = c.state.staffRoster!.find(person => person.candidateId === candidate.id)!;
  expect(member.role).toBe('front_desk');
  expect(member.shift).toBe('early');
  expect(member.dailyWage).toBe(candidate.dailyWage);
  fireEvent.click(screen.getByRole('button', { name: candidate.name, exact: true }));
  act(() => c.update(0));
  const inspector = screen.getByRole('dialog', { name: candidate.name });
  expect(inspector.textContent).toContain('Turnover trained');
  expect(within(inspector).getByRole('combobox', { name: `Specialty for ${candidate.name}` }).querySelectorAll('option')).toHaveLength(3);
  expect(screen.queryByRole('button', { name: /^Train / })).toBeNull();
  const restored = new GameController().state.staffRoster!.find(person => person.id === member.id)!;
  expect(restored.profile?.cleaningTrained).toBe(true);
  expect(restored.dailyWage).toBe(candidate.dailyWage);
});

it('reports actual cleaning separately from counter work and hides disabled training', () => {
  const c = controller(), base = { ...c.state, day: 2, hour: 10 }, T = hourStart(base), lane = physicalDeskLanes(base)[0];
  const member: StaffMember = { id: 'front_desk-trained', name: 'Dana Nguyen', role: 'front_desk', shift: 'early', at: lane.front,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', specialty: 'greeter', cleaningTrained: true },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: T }, dailyWage: 50 };
  c.state = { ...base, staff: { frontDesk: 1, housekeepers: 0, maintenanceWorkers: 0 }, staffRoster: [member],
    staffPlan: { start: T, itineraries: [{ staffId: member.id, legs: [makeStay(lane.front, T, T + 1, 'clean', { job: 'turnover', placeId: 'room-test' })], end: { at: lane.front } }] } };
  render(<App controller={c} worldRef={createRef()} />);
  act(() => { c.togglePanel('staff'); c.update(0); });
  fireEvent.click(within(screen.getByRole('group', { name: 'Hiring role' })).getByRole('button', { name: 'Front desk' }));
  const team = () => screen.getByRole('button', { name: member.name }).closest('li')!;
  expect(team().textContent).toContain('Helping with a turnover');
  expect(screen.getByLabelText('Turnover support').textContent).toContain('1 trained clerk · 1 cleaning now');
  act(() => {
    c.state = { ...c.state, staffPlan: { start: T, itineraries: [{ staffId: member.id,
      legs: [makeStay(lane.front, T, T + 1, 'desk', { lane: lane.key, placeId: lane.desk.id })], end: { at: lane.front } }] } };
    c.closePanel(); c.togglePanel('staff'); c.update(0);
  });
  fireEvent.click(within(screen.getByRole('group', { name: 'Hiring role' })).getByRole('button', { name: 'Front desk' }));
  expect(team().textContent).toContain('At the front desk');
  expect(team().textContent).not.toContain('Helping with a turnover');
  expect(screen.getByLabelText('Turnover support').textContent).toContain('0 cleaning now');
  act(() => { STAFF_CLEANING_SUPPORT.enabled = false; c.closePanel(); c.togglePanel('staff'); c.update(0); });
  fireEvent.click(within(screen.getByRole('group', { name: 'Hiring role' })).getByRole('button', { name: 'Front desk' }));
  expect(team().textContent).not.toContain('Turnover trained');
  expect(screen.queryByLabelText('Turnover support')).toBeNull();
});

it('warns on the hiring card and in the staff panel when no other early-shift clerk can mind the desk', () => {
  STAFF_CLEANING_SUPPORT.candidateChance = 1;
  const c = controller();
  // Nobody on the early shift yet: a trained early clerk would be alone there
  const roster = c.state.staffRoster!.filter(m => !(m.role === 'front_desk' && m.shift === 'early'));
  c.state = { ...c.state, staffRoster: roster, staff: { ...c.state.staff, frontDesk: roster.filter(m => m.role === 'front_desk').length } };
  const candidate = hiringCandidates(c.state, 'front_desk', 'early')[0];
  render(<App controller={c} worldRef={createRef()} />);
  act(() => { c.togglePanel('staff'); c.update(0); });
  fireEvent.click(within(screen.getByRole('group', { name: 'Hiring role' })).getByRole('button', { name: 'Front desk' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Shift for new clerk' }), { target: { value: 'early' } });
  const card = screen.getByRole('button', { name: `Hire ${candidate.name}` }).closest('li')!;
  expect(card.textContent).toContain("No other early-shift clerk yet, so they can't leave the desk to clean.");
  fireEvent.click(within(card).getByRole('button', { name: `Hire ${candidate.name}` }));
  act(() => c.update(0));
  const support = () => screen.getByLabelText('Turnover support').textContent;
  expect(support()).toContain("Can't leave the desk to clean: another early-shift clerk must stay at reception for the whole trip.");
  // A second early-shift clerk to mind the desk: the warnings go
  const hired = c.state.staffRoster!.find(m => m.candidateId === candidate.id)!;
  act(() => {
    c.state = { ...c.state, staff: { ...c.state.staff, frontDesk: c.state.staff.frontDesk + 1 }, staffRoster: [...c.state.staffRoster!,
      { ...hired, id: 'front_desk-cover', candidateId: undefined, name: 'Robin Lee', profile: { ...hired.profile!, cleaningTrained: false } }] };
    c.closePanel(); c.togglePanel('staff'); c.update(0);
  });
  expect(support()).not.toContain("Can't leave the desk");
  fireEvent.click(within(screen.getByRole('group', { name: 'Hiring role' })).getByRole('button', { name: 'Front desk' }));
  fireEvent.click(screen.getByRole('button', { name: hired.name, exact: true }));
  act(() => c.update(0));
  expect(screen.getByRole('dialog', { name: hired.name }).textContent).toContain('only while another early-shift clerk stays at the desk for the whole trip');
  expect(screen.getByRole('dialog', { name: hired.name }).textContent).not.toContain('No other early-shift clerk yet');
});

/** No housekeepers; two early-shift clerks, the first trained; one room needing a long turnover, planned for real. */
function clerkCleaningHotel(state: HotelState): HotelState {
  const base = addRoom({ ...state, day: 2, hour: 11, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
  const people: StaffMember[] = physicalDeskLanes(base).map((lane, index) => ({
    id: index === 0 ? 'helper' : 'cover', serial: index + 1, name: index === 0 ? 'Avery Park' : 'Robin Lee',
    role: 'front_desk', shift: 'early', at: lane.front, deskLane: lane.key, dailyWage: index === 0 ? 46 : 40,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal',
      hospitality: 'polite', ...(index === 0 ? { cleaningTrained: true } : {}) },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: hourStart(base) },
  }));
  const ready: HotelState = { ...base, staffRoster: people, staffPlan: null, guests: [], walkers: [],
    staff: { frontDesk: people.length, housekeepers: 0, maintenanceWorkers: 0 },
    rooms: base.rooms.map(room => ({ ...room, status: 'cleaning', cleaningHoursRemaining: 10, cleaningHoursTotal: 10, dailyCleanHoursRemaining: 0 })) };
  return { ...ready, staffPlan: getStaffPlan(ready) };
}

it('shows the clerk on the way to and cleaning the room in the housekeeping panel, overlay key, room inspector and staff panel', () => {
  vi.useFakeTimers();
  const c = controller();
  c.state = clerkCleaningHotel(c.state);
  const T = hourStart(c.state), room = c.state.rooms[0];
  const visit = c.state.staffPlan!.itineraries.find(it => it.staffId === 'helper')!.legs.filter(leg => leg.kind === 'stay' && leg.activity === 'clean');
  expect(visit.length).toBeGreaterThan(0);
  render(<App controller={c} worldRef={createRef()} />);
  act(() => { c.togglePanel('housekeeping'); c.tileDown({ gridX: room.gridX, gridY: room.gridY }); c.update(0); });
  const panel = () => screen.getByRole('region', { name: 'HOUSEKEEPING' }).textContent;
  const inspector = () => screen.getByRole('dialog', { name: /Standard Queen/ }).textContent;
  // The top of the hour: the clerk is walking there
  expect(panel()).toContain('Staff on the way: 1');
  expect(panel()).toContain('Dirty, waiting: 0');
  expect(screen.getByRole('group', { name: 'Cleaning overlay key' }).textContent).toContain('Staff on the way');
  expect(inspector()).toContain('Dirty: Avery Park from the front desk on the way');
  // Mid-visit: in the room, cleaning
  act(() => { c.update(TICK_INTERVAL_MS * ((visit[0].start + visit.at(-1)!.end) / 2 - T)); vi.advanceTimersByTime(250); });
  expect(panel()).toContain('Being cleaned: 1');
  expect(panel()).toContain('Dirty, waiting: 0');
  expect(panel()).not.toContain('no housekeepers hired');
  expect(inspector()).toContain('Being cleaned by Avery Park from the front desk');
  expect(inspector()).not.toContain('Dirty: waiting');
  act(() => { c.togglePanel('staff'); c.update(0); });
  const staff = screen.getByRole('region', { name: 'STAFF' }).textContent;
  expect(staff).toContain('Cleaning: 1');
  expect(staff).not.toContain('waiting!');
  expect(screen.getByLabelText('Turnover support').textContent).toContain('1 trained clerk · 1 cleaning now.');
  expect(screen.getByLabelText('Turnover support').textContent).not.toContain("Can't");
});

it('says what tiredness slows for clerks, and only mentions cleaning for trained ones', () => {
  const c = controller(), base = { ...c.state, day: 2, hour: 10 }, T = hourStart(base), lane = physicalDeskLanes(base)[0];
  const native: StaffMember = { id: 'front_desk-native', name: 'Sam Ortiz', role: 'front_desk', shift: 'early', at: lane.front,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal' },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 70, fatigueAt: T }, dailyWage: 40 };
  const trained: StaffMember = { ...native, id: 'front_desk-trained', name: 'Dana Nguyen', profile: { ...native.profile!, cleaningTrained: true } };
  // Both tired, walking (not at the desk)
  const walk = makeWalk([lane.front, { ...lane.front, gridX: lane.front.gridX + 1 }], T, 1);
  c.state = { ...base, staff: { frontDesk: 2, housekeepers: 0, maintenanceWorkers: 0 }, staffRoster: [native, trained],
    staffPlan: { start: T, itineraries: [native, trained].map(member => ({ staffId: member.id, legs: [walk], end: { at: lane.front } })) } };
  render(<App controller={c} worldRef={createRef()} />);
  const energyNote = (member: StaffMember) => {
    act(() => { c.selectStaff(member.id); c.update(0); });
    return screen.getByRole('dialog', { name: member.name }).textContent;
  };
  expect(energyNote(native)).toContain('New service is 15% slower while tired.');
  expect(energyNote(trained)).toContain('Cleaning and new service are 15% slower while tired.');
  STAFF_CLEANING_SUPPORT.enabled = false;
  expect(energyNote(native)).toContain('New service is 15% slower while tired.');
  expect(energyNote(trained)).toContain('New service is 15% slower while tired.');
});
