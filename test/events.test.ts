import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_GUESTS, GUEST_PURPOSES } from '../src/config/balance.js';
import { getActiveEvent, getSpecialEvent } from '../src/simulation/SeasonManager.js';
import { rollPurpose, withEventStay, awayActivity } from '../src/simulation/Purpose.js';
import { rollProfile } from '../src/simulation/Profile.js';
import { createStarterHotel, addRoom } from '../src/simulation/HotelState.js';
import { processArrivals } from '../src/simulation/GuestManager.js';
import { planOutings, outingChance } from '../src/simulation/OutingManager.js';
import { hourStart, positionAt } from '../src/simulation/Movement.js';
import { saveGame, loadGame } from '../src/simulation/SaveManager.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { estimateHousekeepingHours } from '../src/simulation/HousekeepingManager.js';
import { PRNG } from '../src/simulation/prng.js';
import type { Guest } from '../src/simulation/types.js';

const guest = (id: string): Guest => ({ id, name: 'Sam', budget: 200, stayLength: 2, trait: 'normal', satisfaction: 60, checkInDay: 46, isReturning: false, hadNoiseComplaint: false });
afterEach(() => { EVENT_GUESTS.enabled = true; GUEST_PURPOSES.enabled = true; localStorage.clear(); });

describe('Event visitors', () => {
  it('calendar windows have one absolute end, including the New Year wrap', () => {
    expect(getActiveEvent(46)).toEqual({ name: 'Spring Festival', endDay: 53 });
    expect(getActiveEvent(52)?.endDay).toBe(53);
    expect(getSpecialEvent(53)).toBeNull();
    expect(getActiveEvent(356)).toEqual({ name: 'New Year', endDay: 366 });
    expect(getActiveEvent(361)).toEqual({ name: 'New Year', endDay: 366 });
    expect(getActiveEvent(365)?.endDay).toBe(366);
    expect(getSpecialEvent(366)).toBeNull();
  });

  it('the configured share of existing bookings attends deterministically, only during an event', () => {
    let n = 0;
    for (let i = 0; i < 10000; i++) {
      const id = `g${i}`, party = { kind: 'solo' as const, size: 1 };
      const p = rollPurpose(id, party, 46);
      expect(rollPurpose(id, party, 46)).toBe(p);
      if (p === 'event') n++;
      expect(rollPurpose(id, party, 53)).not.toBe('event');
    }
    expect(n / 10000).toBeGreaterThan(EVENT_GUESTS.share - 0.01);
    expect(n / 10000).toBeLessThan(EVENT_GUESTS.share + 0.01);
    EVENT_GUESTS.enabled = false;
    expect(rollPurpose('g1', { kind: 'solo', size: 1 }, 46)).toBe(rollPurpose('g1', { kind: 'solo', size: 1 }));
  });

  it('stays through the final event night, with 20% more budget, and saves that identity', () => {
    const g = withEventStay({ ...guest('g'), purpose: 'event' }, 52);
    expect(g).toMatchObject({ stayLength: 1, budget: 240, eventStay: { name: 'Spring Festival', endDay: 53 } });
    const state = { ...createStarterHotel(), guests: [g] };
    saveGame(state, new PRNG(1));
    expect(loadGame()?.state.guests[0]).toEqual(g);
    expect(awayActivity(g)).toBe('at the event');
  });

  it('arrivals receive the event stay without changing the number of arrival rolls', () => {
    let state = { ...createStarterHotel(), day: 46, hour: 15, cash: 1_000_000, staff: { housekeepers: 1, maintenanceWorkers: 0, frontDesk: 2 } };
    for (let x = 2; x < 10; x++) state = addRoom(state, 'standard', x, 0, 0, 'down')!;
    let seen = 0;
    for (let seed = 0; seed < 20; seed++) {
      const a = new PRNG(seed), b = new PRNG(seed);
      const on = processArrivals(state, 15, a);
      EVENT_GUESTS.enabled = false;
      const off = processArrivals(state, 15, b);
      EVENT_GUESTS.enabled = true;
      expect(a.getState()).toBe(b.getState());
      expect(on.checkedIn.length + on.turnedAway).toBe(off.checkedIn.length + off.turnedAway);
      for (const { guest: g } of on.checkedIn.filter(x => x.guest.purpose === 'event')) {
        seen++; expect(g.stayLength).toBe(7); expect(g.eventStay?.name).toBe('Spring Festival');
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('event outings follow the evening clock and cross midnight through real entrance trips', () => {
    let state = addRoom({ ...createStarterHotel(), day: 47, hour: 19 }, 'standard', 5, 2, 0, 'up')!;
    let found = false;
    for (let i = 0; i < 100 && !found; i++) {
      const g = withEventStay({ ...guest(`event${i}`), purpose: 'event', profile: rollProfile(`event${i}`, { kind: 'solo', size: 1 }, 'event', 'normal') }, 46);
      state = { ...state, guests: [g], rooms: state.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: g.id })) };
      const planned = planOutings(state).guests[0];
      const away = planned.trip?.find(l => l.kind === 'stay' && l.activity === 'away');
      if (!away || away.end < (state.day - 1) * 24 + 24) continue;
      found = true;
      expect(planned.tripKind).toBe('outing');
      expect(planned.trip?.[0].kind).toBe('walk');
      expect(planned.trip?.at(-1)?.kind).toBe('walk');
      expect(planned.trip!.at(-1)!.end).toBeLessThanOrEqual((state.day - 1) * 24 + 25);
      expect(positionAt(planned.trip!, hourStart(state) + 4)?.leg).toMatchObject({ kind: 'stay', activity: 'away' });
      expect(outingChance(g, 10)).toBe(0);
      expect(outingChance(g, 18)).toBe(EVENT_GUESTS.leaveChance);
    }
    expect(found).toBe(true);
  });

  it('fresh event guests lean late and rowdy, while families remain quiet or normal', () => {
    let late = 0, rowdy = 0;
    for (let i = 0; i < 1000; i++) {
      const p = rollProfile(`g${i}`, { kind: 'solo', size: 1 }, 'event', 'normal')!;
      if (p.chronotype === 'night') late++;
      if (p.rowdiness === 'rowdy') rowdy++;
      expect(rollProfile(`g${i}`, { kind: 'family', size: 4 }, 'event', 'normal')!.rowdiness).not.toBe('rowdy');
    }
    expect(late).toBeGreaterThan(400); expect(rowdy).toBeGreaterThan(230);
  });

  it('staffing estimates allow for long event stays and prepare for their checkout rush', () => {
    let state = addRoom({ ...createStarterHotel(), day: 46, hour: 15 }, 'standard', 5, 2, 0, 'up')!;
    const g = withEventStay({ ...guest('long'), purpose: 'event' }, 46);
    state = { ...state, guests: [g] };
    const during = estimateHousekeepingHours(state, 1);
    expect(during).toBeLessThan(estimateHousekeepingHours({ ...state, guests: [{ ...g, eventStay: undefined }] }, 1));
    expect(estimateHousekeepingHours({ ...state, day: 52 }, 1)).toBeGreaterThan(during);
  });

  it('with event guests off, committed balance runs are unchanged', () => {
    EVENT_GUESTS.enabled = false;
    const run = simulate(60, 9, undefined, STRATEGIES.balanced);
    expect(run.finalCash).toBeCloseTo(18185.5, 6);
    expect(run.avgReviewScore).toBeCloseTo(7.768753167219546, 9);
    expect(run.totalRevenue).toBe(110823);
    expect(run.totalTurnedAway).toBe(508);
  }, 120000);
});
