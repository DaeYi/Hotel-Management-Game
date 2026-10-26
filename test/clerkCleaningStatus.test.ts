import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_CLEANING_SUPPORT } from '../src/config/staff.js';
import { TRAVEL } from '../src/config/balance.js';
import { addRoom, createStarterHotel } from '../src/simulation/HotelState.js';
import { physicalDeskLanes } from '../src/simulation/FrontDesk.js';
import { getStaffPlan } from '../src/simulation/StaffManager.js';
import { roomCleaningAt, summarizeCleaning } from '../src/simulation/CleaningStatus.js';
import { checkHousekeepingCompliance, clerksFreeToClean, getHousekeepingStatus, processCleaningTick } from '../src/simulation/HousekeepingManager.js';
import { hourStart, makeWalk, positionAt } from '../src/simulation/Movement.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { GridRenderer, CLEANING_COLORS } from '../src/render/GridRenderer';
import { staffActivity } from '../src/ui/StaffPeople';
import type { HotelState, StaffMember, StayLeg, Walker } from '../src/simulation/types.js';

// Every cleaning readout -- the room inspector, the housekeeping panel, the
// floor overlay and the staff panel's housekeeping line -- has to show a
// trained clerk's turnover visit as it happens, the way it shows a
// housekeeper's; and the clerk's own activity has to say where the visit is.

const enabled = STAFF_CLEANING_SUPPORT.enabled;
afterEach(() => { STAFF_CLEANING_SUPPORT.enabled = enabled; });

/** Two early-shift clerks at the desk (the first trained), no housekeepers, and every room needing a long turnover. */
function hotel(hour = 11, remaining = 10): HotelState {
  const base = addRoom({ ...createStarterHotel(), day: 2, hour, cash: 1_000_000 }, 'standard', 5, 2, 0, 'up')!;
  const people: StaffMember[] = physicalDeskLanes(base).map((lane, index) => ({
    id: index === 0 ? 'helper' : 'cover', serial: index + 1, name: index === 0 ? 'Avery Park' : 'Robin Lee',
    role: 'front_desk', shift: 'early', at: lane.front, deskLane: lane.key, dailyWage: index === 0 ? 46 : 40,
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal',
      hospitality: 'polite', ...(index === 0 ? { cleaningTrained: true } : {}) },
    stats: { workHours: 80, lateDays: 0, absentDays: 0, fatigue: 0, fatigueAt: hourStart(base) },
  }));
  return { ...base, frontDeskRosterReady: true, staffRoster: people, staffPlan: null,
    staff: { frontDesk: people.length, housekeepers: 0, maintenanceWorkers: 0 },
    rooms: base.rooms.map(room => ({ ...room, status: 'cleaning', cleaningHoursRemaining: remaining,
      cleaningHoursTotal: remaining, dailyCleanHoursRemaining: 0 })) };
}
function planned(state: HotelState): HotelState { return { ...state, staffPlan: getStaffPlan(state) }; }
function legs(state: HotelState, id = 'helper') { return getStaffPlan(state).itineraries.find(itinerary => itinerary.staffId === id)!.legs; }
function cleans(state: HotelState, id = 'helper'): StayLeg[] {
  return legs(state, id).filter((leg): leg is StayLeg => leg.kind === 'stay' && leg.activity === 'clean');
}
/** Three dirty rooms: the trained clerk and a housekeeper each take one. */
function sharedHotel(hour = 11): HotelState {
  let state = hotel(hour);
  state = addRoom(state, 'standard', 6, 2, 0, 'up')!;
  state = addRoom(state, 'standard', 7, 2, 0, 'up')!;
  const keeper: StaffMember = { ...state.staffRoster![1], id: 'keeper', serial: 3, name: 'Kim Lane', role: 'housekeeper', shift: undefined, deskLane: undefined };
  return planned({ ...state, staff: { ...state.staff, housekeepers: 1 }, staffRoster: [...state.staffRoster!, keeper],
    rooms: state.rooms.map(room => ({ ...room, status: 'cleaning', cleaningHoursRemaining: 10, cleaningHoursTotal: 10 })) });
}
/** Run GridRenderer.renderCleaning against a recorder and return the colours it fills with. */
function overlayFills(state: HotelState, t: number): unknown[] {
  const calls: Array<[string, ...unknown[]]> = [];
  const graphics = new Proxy({}, { get: (_, name) => (...args: unknown[]) => { calls.push([String(name), ...args]); } });
  const renderer = Object.create(GridRenderer.prototype);
  renderer.cleaningGraphics = graphics;
  renderer.planCache = new WeakMap();
  GridRenderer.prototype.renderCleaning.call(renderer, state, 0, t, true);
  return calls.filter(call => call[0] === 'fillStyle').map(call => call[1]);
}

describe('The cleaning readouts show a trained clerk’s turnover', () => {
  it('shows the clerk on the way, then in the room with the work counting down, and ends the hour where the tick does', () => {
    const state = planned(hotel()), T = hourStart(state), room = state.rooms[0];
    const visit = cleans(state), first = visit[0], last = visit.at(-1)!;
    expect(first.start).toBeGreaterThan(T);
    expect(roomCleaningAt(state, T).get(room.id)).toMatchObject({ job: 'turnover', phase: 'on_the_way', staffId: 'helper', hoursLeft: 10, progress: 0 });
    for (const share of [0.1, 0.5, 0.9]) {
      const t = first.start + (last.end - first.start) * share;
      const done = visit.reduce((sum, leg) => sum + Math.max(0, Math.min(leg.end, t) - leg.start) * (leg.workRate ?? 1), 0);
      const now = roomCleaningAt(state, t).get(room.id)!;
      expect(now).toMatchObject({ job: 'turnover', phase: 'cleaning', staffId: 'helper' });
      expect(now.hoursLeft).toBeCloseTo(10 - done, 9);
      expect(now.progress).toBeCloseTo(done / 10, 9);
    }
    // Walking back: nobody's in the room any more, and what was done stays done
    const after = roomCleaningAt(state, last.end + 0.01).get(room.id)!;
    expect(after).toMatchObject({ phase: 'waiting', wait: 'no_housekeepers' });
    expect(after.progress).toBeGreaterThan(0);
    expect(roomCleaningAt(state, T + 1).get(room.id)!.hoursLeft).toBeCloseTo(processCleaningTick(state).state.rooms[0].cleaningHoursRemaining, 9);
  });

  it('counts the room as being cleaned, not waiting, in the housekeeping summary and the staff panel’s line', () => {
    const state = planned(hotel()), T = hourStart(state);
    const visit = cleans(state), mid = (visit[0].start + visit.at(-1)!.end) / 2, back = visit.at(-1)!.end + 0.01;
    expect(summarizeCleaning(state, T).turnovers).toEqual({ cleaning: 0, onTheWay: 1, waiting: 0 });
    expect(summarizeCleaning(state, mid).turnovers).toEqual({ cleaning: 1, onTheWay: 0, waiting: 0 });
    expect(summarizeCleaning(state, mid).waits).toEqual({});
    expect(getHousekeepingStatus(state, mid)).toMatchObject({ roomsBeingCleaned: 1, roomsWaiting: 0 });
    // Once the clerk heads back to the desk, the room really is waiting again
    expect(summarizeCleaning(state, back).turnovers).toEqual({ cleaning: 0, onTheWay: 0, waiting: 1 });
    expect(getHousekeepingStatus(state, back).roomsWaiting).toBe(1);
  });

  it('counts only the rooms nobody is on when a housekeeper and a clerk are both cleaning', () => {
    const state = sharedHotel(), visit = cleans(state), mid = (visit[0].start + visit.at(-1)!.end) / 2;
    expect(cleans(state, 'keeper').some(leg => leg.start <= mid && mid < leg.end)).toBe(true);
    expect(summarizeCleaning(state, mid).turnovers).toEqual({ cleaning: 2, onTheWay: 0, waiting: 1 });
    expect(getHousekeepingStatus(state, mid)).toMatchObject({ roomsBeingCleaned: 3, roomsWaiting: 1 });
  });

  it('does not count the overnight queue waiting for the morning shift', () => {
    const state = { ...sharedHotel(23), staffPlan: null };
    expect(summarizeCleaning(state, hourStart(state)).waits).toEqual({ off_shift: 3 });
    expect(getHousekeepingStatus(state)).toMatchObject({ roomsBeingCleaned: 3, roomsWaiting: 0 });
  });

  it('draws the room on the floor overlay as being cleaned while the clerk is in it', () => {
    const state = planned(hotel()), visit = cleans(state), mid = (visit[0].start + visit.at(-1)!.end) / 2;
    const fills = overlayFills(state, mid);
    expect(fills).toContain(CLEANING_COLORS.housekeeper);
    expect(fills).not.toContain(CLEANING_COLORS.dirty);
  });

  it('matches every worker in a room, clerks included, hour after hour', () => {
    let state = sharedHotel(7);
    state = planned({ ...state, staffPlan: null,
      staffRoster: state.staffRoster!.map(member => member.id === 'cover' ? { ...member, profile: { ...member.profile!, cleaningTrained: true } } : member) });
    const prng = new PRNG(11);
    let clerks = 0;
    for (let hour = 7; hour < 14; hour++) {
      const T = hourStart(state), plan = getStaffPlan(state);
      for (let t = T; t < T + 1; t += 0.05) {
        const status = roomCleaningAt(state, t, plan);
        for (const itinerary of plan.itineraries) {
          const leg = positionAt(itinerary.legs, t)?.leg;
          if (leg?.kind !== 'stay' || leg.job !== 'turnover' || !leg.placeId || t < leg.start || t >= leg.end) continue;
          if (itinerary.staffId !== 'keeper') clerks++;
          const shown = status.get(leg.placeId);
          if (shown) expect(shown, `${leg.placeId} at ${t}`).toMatchObject({ phase: 'cleaning', staffId: itinerary.staffId });
        }
        for (const [roomId, shown] of status) {
          if (shown.phase !== 'cleaning') continue;
          const leg = positionAt(plan.itineraries.find(itinerary => itinerary.staffId === shown.staffId)!.legs, t)?.leg;
          expect(leg?.kind === 'stay' && leg.placeId === roomId && leg.job === 'turnover', `${roomId} at ${t}`).toBe(true);
        }
      }
      const atEnd = roomCleaningAt(state, T + 1, plan), before = state;
      state = tickSimulation(state, prng).state;
      for (const room of before.rooms) {
        const after = state.rooms.find(r => r.id === room.id)!;
        if (after.status === 'cleaning') expect(atEnd.get(room.id)?.hoursLeft ?? 0).toBeCloseTo(after.cleaningHoursRemaining, 9);
      }
    }
    expect(clerks).toBeGreaterThan(20);
  });
});

describe('A trained clerk’s activity follows the turnover visit', () => {
  it('waits at the desk for the room to empty, walks there, helps, heads back, then serves again', () => {
    let state = hotel(11, 0.2);
    const T = hourStart(state), room = state.rooms[0];
    // The last guest walks out of the room 0.45h into the hour
    const tile = { gridX: room.gridX, gridY: room.gridY, floor: room.floor, door: room.door };
    const leaving: Walker = { id: 'leaving', trait: 'normal', isReturning: false, reason: 'checked_out',
      trip: [makeWalk([tile, { gridX: room.gridX, gridY: room.gridY - 1, floor: room.floor }], T + 0.45, TRAVEL.hoursPerTile)] };
    state = planned({ ...state, walkers: [leaving] });
    const helper = state.staffRoster![0], visit = legs(state);
    expect(visit.map(leg => leg.kind === 'stay' ? leg.activity : leg.kind)).toEqual(['wait', 'walk', 'clean', 'walk', 'desk']);
    expect(visit.map(leg => staffActivity(helper, state, (leg.start + leg.end) / 2))).toEqual([
      'Waiting to start a turnover', 'Walking to a turnover', 'Helping with a turnover', 'Heading back to the desk', 'At the front desk']);
    expect(staffActivity(state.staffRoster![1], state, T + 0.5)).toBe('At the front desk');
  });

  it('says so when a blocked route leaves the clerk in the room, this hour and the next', () => {
    let state = planned(hotel());
    const at = cleans(state)[0].start + 0.05;
    state = settleChanges(state, addRoom(state, 'standard', 5, 1, 0, 'up')!, at);
    const helper = () => state.staffRoster!.find(member => member.id === 'helper')!;
    expect(legs(state).some(leg => leg.kind === 'walk' && leg.start >= at)).toBe(false);
    expect(staffActivity(helper(), state, at + 0.1)).toBe("Can't get back to the desk");
    state = tickSimulation(state, new PRNG(5)).state;
    expect(staffActivity(helper(), state, hourStart(state) + 0.5)).toBe("Can't get back to the desk");
  });
});

describe('Advice with no housekeepers hired', () => {
  it('keeps the strong warning while the trained clerk is the only early-shift clerk, and says why', () => {
    const state = hotel(), helper = state.staffRoster![0];
    const alone: HotelState = { ...state, staff: { ...state.staff, frontDesk: 1 }, staffRoster: [helper] };
    expect(cleans(alone)).toHaveLength(0);
    expect(clerksFreeToClean(alone)).toEqual([]);
    expect(getHousekeepingStatus(alone).recommendation).toMatch(/^Hire housekeepers or rooms will never be cleaned!/);
    expect(getHousekeepingStatus(alone).recommendation).toContain("can't leave the desk to clean without another early-shift clerk");
    expect(checkHousekeepingCompliance(alone)).toMatch(/^No housekeepers hired! Rooms will not be cleaned/);
    expect(checkHousekeepingCompliance(alone)).toContain('another early-shift clerk');
    // A colleague on another shift can't mind the desk during the morning visit either
    const lateCover = { ...state, staffRoster: state.staffRoster!.map(member => member.id === 'cover' ? { ...member, shift: 'late' as const } : member) };
    expect(clerksFreeToClean(lateCover)).toEqual([]);
    expect(getHousekeepingStatus(lateCover).recommendation).toMatch(/never be cleaned/);
  });

  it('softens the advice once another early-shift clerk can cover the desk', () => {
    const state = hotel();
    expect(cleans(state).length).toBeGreaterThan(0);
    expect(clerksFreeToClean(state).map(member => member.id)).toEqual(['helper']);
    expect(getHousekeepingStatus(state).recommendation).not.toMatch(/never/);
    expect(getHousekeepingStatus(state).recommendation).toContain('trained clerks only help with morning turnovers');
    expect(checkHousekeepingCompliance(state)).toMatch(/^No dedicated housekeepers/);
  });

  it('says exactly what it always did with the training switched off', () => {
    STAFF_CLEANING_SUPPORT.enabled = false;
    const state = hotel(), alone: HotelState = { ...state, staff: { ...state.staff, frontDesk: 1 }, staffRoster: [state.staffRoster![0]] };
    for (const s of [state, alone]) {
      expect(getHousekeepingStatus(s).recommendation).toBe('Hire housekeepers or rooms will never be cleaned!');
      expect(checkHousekeepingCompliance(s)).toBe('No housekeepers hired! Rooms will not be cleaned');
    }
  });
});
