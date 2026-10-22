// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/preact';
import { createRef } from 'preact';
import { App } from '../src/ui/App';
import { GameController } from '../src/game/GameController';
import { hiringCandidates } from '../src/simulation/StaffHiring';
import { hospitalityOf, specialtyOf, specialtyLabel } from '../src/simulation/StaffProfiles';
import type { Guest } from '../src/simulation/types';

afterEach(() => { cleanup(); localStorage.clear(); });

function setup() {
  localStorage.setItem('hotel-game-tutorial-seen', '1');
  const c = new GameController();
  render(<App controller={c} worldRef={createRef()} />);
  const flush = () => act(() => c.update(0));
  return { c, flush };
}

it('reassigns housekeeping priorities from the team and inspector and saves each choice', () => {
  const { c, flush } = setup();
  const member = c.state.staffRoster!.find(m => m.role === 'housekeeper')!;
  act(() => c.togglePanel('staff')); flush();
  const picker = screen.getByLabelText(`Specialty for ${member.name}`) as HTMLSelectElement;
  expect(Array.from(picker.options, o => o.value)).toEqual(['turnover_runner', 'room_attendant']);
  fireEvent.change(picker, { target: { value: 'room_attendant' } }); flush();
  expect(specialtyOf(c.state.staffRoster!.find(m => m.id === member.id)!)).toBe('room_attendant');
  expect(screen.getByText('Daily cleans first; rooms with guests out first.')).toBeTruthy();
  expect(new GameController().state.staffRoster!.find(m => m.id === member.id)?.profile?.specialty).toBe('room_attendant');
  fireEvent.click(screen.getByRole('button', { name: member.name, exact: true })); flush();
  const card = screen.getByRole('dialog', { name: member.name });
  expect(card.textContent).toContain('Hospitality: Polite');
  fireEvent.change(within(card).getByLabelText(`Specialty for ${member.name}`), { target: { value: 'turnover_runner' } }); flush();
  expect(specialtyOf(c.state.staffRoster!.find(m => m.id === member.id)!)).toBe('turnover_runner');
  expect(new GameController().state.staffRoster!.find(m => m.id === member.id)?.profile?.specialty).toBe('turnover_runner');
});

it('explains candidate hospitality and offers only desk specialties for a clerk', () => {
  const { c, flush } = setup();
  act(() => c.togglePanel('staff')); flush();
  fireEvent.click(within(screen.getByRole('group', { name: 'Hiring role' })).getByRole('button', { name: 'Front desk' }));
  const candidates = hiringCandidates(c.state, 'front_desk', 'late');
  for (const candidate of candidates) {
    const card = screen.getByRole('button', { name: `Hire ${candidate.name}` }).closest('li')!;
    const member = { ...candidate, at: null };
    expect(card.textContent).toContain(`Specialty: ${specialtyLabel(specialtyOf(member))}`);
    const hospitality = hospitalityOf(member);
    expect(card.textContent).toContain(`Hospitality: ${hospitality[0].toUpperCase()}${hospitality.slice(1)}`);
    expect(card.textContent).toContain(hospitality === 'warm' ? '+4 mood at check-in' : hospitality === 'curt' ? '−3 mood at check-in' : 'No change to check-in time or guest mood');
  }
  const member = c.state.staffRoster!.find(m => m.role === 'front_desk')!;
  const picker = screen.getByLabelText(`Specialty for ${member.name}`) as HTMLSelectElement;
  expect(Array.from(picker.options, o => o.value)).toEqual(['greeter', 'upseller', 'concierge']);
  fireEvent.change(picker, { target: { value: 'upseller' } }); flush();
  expect(screen.getByText('Offers big spenders a higher room class at its price; 25% accept if a suitable room is free and within budget.')).toBeTruthy();
  expect(screen.queryByLabelText(`Hospitality for ${member.name}`)).toBeNull();
});

it('lets maintenance choose preventive work and explains the safe away-window rule', () => {
  const { c, flush } = setup();
  act(() => c.togglePanel('staff')); flush();
  fireEvent.click(within(screen.getByRole('group', { name: 'Hiring role' })).getByRole('button', { name: 'Maintenance' }));
  const candidate = hiringCandidates(c.state, 'maintenance')[0];
  fireEvent.click(screen.getByRole('button', { name: `Hire ${candidate.name}` })); flush();
  const member = c.state.staffRoster!.find(m => m.candidateId === candidate.id)!;
  const picker = screen.getByLabelText(`Specialty for ${member.name}`) as HTMLSelectElement;
  expect(Array.from(picker.options, o => o.value)).toEqual(['responder', 'preventive']);
  const wage = member.dailyWage;
  fireEvent.change(picker, { target: { value: 'preventive' } }); flush();
  expect(screen.getByText('Vacant repairs first; also services occupied rooms below 40% to 85% while guests are out. Respects Do not disturb and finishes before they return.')).toBeTruthy();
  expect(c.state.staffRoster!.find(m => m.id === member.id)).toMatchObject({ dailyWage: wage, profile: { specialty: 'preventive', hospitality: 'polite' } });
});

it('keeps a stoic mood hidden until that guest has met a concierge and shows actual staff encounters', () => {
  const { c, flush } = setup();
  const member = c.state.staffRoster!.find(m => m.role === 'front_desk')!;
  act(() => { c.setStaffSpecialty(member.id, 'concierge'); });
  const guest: Guest = {
    id: 'quiet-guest', name: 'Ines', budget: 300, stayLength: 3, trait: 'normal', satisfaction: 44,
    checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
    profile: { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11, voice: 'stoic' },
  };
  c.state = { ...c.state, day: 2, hour: 12, guests: [guest] };
  act(() => c.selectGuest(guest.id, { gridX: 5, gridY: 2 })); flush();
  const card = () => screen.getByRole('dialog', { name: 'Ines' });
  expect(card().textContent).toContain('Mood:  ? (keeps it to themselves)');
  expect(card().textContent).not.toContain('44%');
  c.state = { ...c.state, guests: [{ ...guest, service: {
    contacts: [{ staffId: member.id, name: member.name!, kind: 'check_in', at: 24.5, hospitality: 'warm', mood: 4 }],
    hospitalityMood: 4, concierge: { staffId: member.id, name: member.name!, at: 24.5 },
    upsell: { staffId: member.id, name: member.name!, fromRoomId: 'old-room', fromType: 'standard', toType: 'deluxe', extraPerNight: 35, at: 24.5 },
  } }] };
  act(() => c.selectGuest(guest.id, { gridX: 5, gridY: 2 })); flush();
  expect(card().textContent).toContain('44%');
  expect(card().textContent).toContain(`${member.name}: check-in · warm · day 2, 00:30 · +4 mood`);
  expect(card().textContent).toContain(`${member.name} learned their mood during a desk conversation`);
  expect(card().textContent).toContain('Standard to deluxe (+$35/night)');
  expect(card().textContent).toMatch(/Hospitality: \+\d+(?:\.\d+)?\/10 review contribution/);
});
