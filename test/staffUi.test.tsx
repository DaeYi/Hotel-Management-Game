// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/preact';
import { createRef } from 'preact';
import { App } from '../src/ui/App';
import { GameController } from '../src/game/GameController';
import { hiringCandidates } from '../src/simulation/StaffHiring';

afterEach(() => { cleanup(); localStorage.clear(); });

it('hires the chosen person, opens their individual card, and lets that person go', () => {
  localStorage.clear(); localStorage.setItem('hotel-game-tutorial-seen', '1');
  const c = new GameController();
  const candidate = hiringCandidates(c.state, 'housekeeper')[1];
  render(<App controller={c} worldRef={createRef()} />);
  act(() => { c.togglePanel('staff'); c.update(0); });
  expect(screen.getAllByRole('button', { name: /^Hire / })).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: `Hire ${candidate.name}` }));
  act(() => c.update(0));
  expect(c.state.staff.housekeepers).toBe(2);
  const person = c.state.staffRoster!.find(m => m.candidateId === candidate.id)!;
  expect(person.profile).toEqual(candidate.profile);
  fireEvent.click(screen.getByRole('button', { name: candidate.name, exact: true }));
  act(() => c.update(0));
  const card = screen.getByRole('dialog', { name: candidate.name });
  expect(card.textContent).toContain(candidate.profile.style);
  expect(card.textContent).toContain(candidate.profile.reliability);
  fireEvent.click(screen.getByRole('button', { name: 'Let go', exact: true }));
  act(() => c.update(0));
  expect(c.state.staff.housekeepers).toBe(1);
  expect(c.state.staffRoster!.some(m => m.id === person.id && !m.leaving)).toBe(false);
});

it('changes the hiring role to maintenance and preserves the chosen hire through reload', () => {
  localStorage.clear(); localStorage.setItem('hotel-game-tutorial-seen', '1');
  const c = new GameController(), candidate = hiringCandidates(c.state, 'maintenance')[0];
  render(<App controller={c} worldRef={createRef()} />);
  act(() => { c.togglePanel('staff'); c.update(0); });
  const role = screen.getByRole('group', { name: 'Hiring role' });
  fireEvent.click(role.querySelectorAll('button')[1]);
  fireEvent.click(screen.getByRole('button', { name: `Hire ${candidate.name}` }));
  act(() => c.update(0));
  expect(c.state.staff.maintenanceWorkers).toBe(1);
  const loaded = new GameController();
  expect(loaded.state.staffRoster!.find(m => m.candidateId === candidate.id)).toMatchObject({ name: candidate.name, profile: candidate.profile, dailyWage: candidate.dailyWage });
});
