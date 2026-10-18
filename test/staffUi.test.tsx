// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/preact';
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

it('shows coverage gaps and hires a named front desk clerk for the chosen night shift', () => {
  localStorage.setItem('hotel-game-tutorial-seen', '1');
  const c = new GameController();
  const night = c.state.staffRoster!.find(m => m.role === 'front_desk' && m.shift === 'night')!;
  c.dismissStaff(night.id);
  render(<App controller={c} worldRef={createRef()} />);
  act(() => { c.togglePanel('staff'); c.update(0); });
  expect(screen.getByLabelText('Front desk shift coverage').textContent).toContain('Night · 22:00–06:00: No clerk assigned');
  fireEvent.click(within(screen.getByRole('group', { name: 'Hiring role' })).getByRole('button', { name: 'Front desk' }));
  fireEvent.change(screen.getByLabelText('Shift for new clerk'), { target: { value: 'night' } });
  const candidate = hiringCandidates(c.state, 'front_desk', 'night')[0];
  fireEvent.click(screen.getByRole('button', { name: `Hire ${candidate.name}` }));
  act(() => c.update(0));
  const person = c.state.staffRoster!.find(m => m.candidateId === candidate.id)!;
  expect(person.shift).toBe('night'); expect(person.dailyWage).toBe(candidate.dailyWage);
  expect(screen.getByLabelText('Front desk shift coverage').textContent).toContain('Night · 22:00–06:00: 1 clerk');
  fireEvent.click(screen.getByRole('button', { name: candidate.name, exact: true }));
  act(() => c.update(0));
  const card = screen.getByRole('dialog', { name: candidate.name });
  expect(card.textContent).toContain('min'); expect(card.textContent).toContain('/8h shift');
  expect(card.textContent).toContain('Night pay includes a 25% premium');
  expect(within(card).getByLabelText(`Shift for ${candidate.name}`).hasAttribute('disabled')).toBe(true);
  expect(new GameController().state.staffRoster!.find(m => m.id === person.id)).toEqual(person);
});

it('can change an off-duty clerk’s shift from the staff card and persists the assignment and rest', () => {
  localStorage.setItem('hotel-game-tutorial-seen', '1');
  const c = new GameController(), early = c.state.staffRoster!.find(m => m.role === 'front_desk' && m.shift === 'early')!;
  c.state = { ...c.state, day: 2, hour: 15, staffPlan: null };
  render(<App controller={c} worldRef={createRef()} />);
  act(() => { c.togglePanel('staff'); c.update(0); });
  fireEvent.click(within(screen.getByRole('group', { name: 'Hiring role' })).getByRole('button', { name: 'Front desk' }));
  fireEvent.change(screen.getByLabelText(`Shift for ${early.name}`), { target: { value: 'night' } });
  act(() => c.update(0));
  const changed = c.state.staffRoster!.find(m => m.id === early.id)!;
  expect(changed.shift).toBe('night'); expect(changed.restUntil).toBe(54);
  expect(new GameController().state.staffRoster!.find(m => m.id === early.id)).toEqual(changed);
});
