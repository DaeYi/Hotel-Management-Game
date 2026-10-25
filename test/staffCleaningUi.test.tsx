// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/preact';
import { createRef } from 'preact';
import { App } from '../src/ui/App';
import { GameController } from '../src/game/GameController';
import { STAFF_CLEANING_SUPPORT } from '../src/config/staff';
import { hiringCandidates } from '../src/simulation/StaffHiring';
import { physicalDeskLanes } from '../src/simulation/FrontDesk';
import { hourStart, makeStay } from '../src/simulation/Movement';
import type { StaffMember } from '../src/simulation/types';

const candidateChance = STAFF_CLEANING_SUPPORT.candidateChance;
afterEach(() => {
  cleanup(); localStorage.clear();
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
  expect(card.textContent).toContain('spare coverage');
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
