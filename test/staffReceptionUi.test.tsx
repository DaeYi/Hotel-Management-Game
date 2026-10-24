// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/preact';
import { createRef } from 'preact';
import { App } from '../src/ui/App';
import { GameController } from '../src/game/GameController';
import { STAFF_CROSS_TRAINING } from '../src/config/staff';
import { hiringCandidates } from '../src/simulation/StaffHiring';
import { checkInHours } from '../src/simulation/StaffProfiles';
import { physicalDeskLanes } from '../src/simulation/FrontDesk';
import { hourStart, makeStay } from '../src/simulation/Movement';
import type { StaffMember } from '../src/simulation/types';

afterEach(() => {
  cleanup(); localStorage.clear();
  STAFF_CROSS_TRAINING.enabled = true;
  STAFF_CROSS_TRAINING.candidateChance = 0.25;
});

function controller() {
  localStorage.setItem('hotel-game-tutorial-seen', '1');
  return new GameController();
}

it('shows reception training separately from specialty, hires at the displayed wage, and preserves it through reload', () => {
  STAFF_CROSS_TRAINING.candidateChance = 1;
  const c = controller(), candidate = hiringCandidates(c.state, 'housekeeper')[0];
  render(<App controller={c} worldRef={createRef()} />);
  act(() => { c.togglePanel('staff'); c.update(0); });
  const card = screen.getByRole('button', { name: `Hire ${candidate.name}` }).closest('li')!;
  expect(card.textContent).toContain('Reception trained');
  expect(card.textContent).toContain(`Base reception check-in: ${Math.round(checkInHours(candidate) * 60)} min`);
  expect(card.textContent).toContain('15% training premium included in the agreed wage.');
  expect(card.textContent).toContain('Specialty:');
  fireEvent.click(within(card).getByRole('button', { name: `Hire ${candidate.name}` }));
  act(() => c.update(0));
  const member = c.state.staffRoster!.find(person => person.candidateId === candidate.id)!;
  expect(member.role).toBe('housekeeper');
  expect(member.dailyWage).toBe(candidate.dailyWage);
  fireEvent.click(screen.getByRole('button', { name: candidate.name, exact: true }));
  act(() => c.update(0));
  const inspector = screen.getByRole('dialog', { name: candidate.name });
  expect(inspector.textContent).toContain('Reception trained');
  expect(within(inspector).getByRole('combobox', { name: `Specialty for ${candidate.name}` }).querySelectorAll('option')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /^Train / })).toBeNull();
  const restored = new GameController().state.staffRoster!.find(person => person.id === member.id)!;
  expect(restored.profile?.receptionTrained).toBe(true);
  expect(restored.dailyWage).toBe(candidate.dailyWage);
});

it('labels actual reception support separately from cleaning and hides capability when the feature is disabled', () => {
  const c = controller();
  const base = { ...c.state, day: 2, hour: 14 }, T = hourStart(base), lane = physicalDeskLanes(base)[0];
  const member: StaffMember = { id: 'housekeeper-trained', name: 'Dana Nguyen', role: 'housekeeper', at: lane.front,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', specialty: 'turnover_runner', receptionTrained: true },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: T }, dailyWage: 80.5 };
  c.state = { ...base, staff: { frontDesk: 0, housekeepers: 1, maintenanceWorkers: 0 }, staffRoster: [member],
    staffPlan: { start: T, itineraries: [{ staffId: member.id, legs: [makeStay(lane.front, T, T + 1, 'desk', { lane: lane.key, placeId: lane.desk.id })], end: { at: lane.front } }] } };
  render(<App controller={c} worldRef={createRef()} />);
  act(() => { c.togglePanel('staff'); c.update(0); });
  const team = () => screen.getByRole('button', { name: member.name }).closest('li')!;
  expect(team().textContent).toContain('Supporting reception');
  expect(screen.getByLabelText('Reception support').textContent).toContain('1 trained housekeeper · 1 supporting now');
  act(() => {
    c.state = { ...c.state, staffPlan: { start: T, itineraries: [{ staffId: member.id,
      legs: [makeStay(lane.front, T, T + 1, 'clean', { job: 'turnover', placeId: 'room-test' })], end: { at: lane.front } }] } };
    c.closePanel(); c.togglePanel('staff'); c.update(0);
  });
  expect(team().textContent).toContain('Turning over a room');
  expect(team().textContent).not.toContain('Supporting reception');
  expect(screen.getByLabelText('Reception support').textContent).toContain('0 supporting now');
  act(() => { STAFF_CROSS_TRAINING.enabled = false; c.closePanel(); c.togglePanel('staff'); c.update(0); });
  expect(team().textContent).not.toContain('Reception trained');
  expect(screen.queryByLabelText('Reception support')).toBeNull();
});
