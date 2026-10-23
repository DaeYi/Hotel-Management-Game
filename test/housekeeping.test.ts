import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, addFixture } from '../src/simulation/HotelState.js';
import {
  processCleaningTick, processDailyHousekeeping, startTurnoverCleaning, estimateHousekeepingHours,
  housekeepersNeeded, housekeepingHoursAvailable, getHousekeepingStatus, PLANNING_OCCUPANCY, baseWalkHours,
} from '../src/simulation/HousekeepingManager.js';
import { processMaintenanceTick } from '../src/simulation/MaintenanceManager.js';
import { getStaffPlan, plannedWork, planStaff, getRoster, syncRoster, restingPlace, replanStaff } from '../src/simulation/StaffManager.js';
import { positionAt, legsEnd, hourStart } from '../src/simulation/Movement.js';
import { findRoute, getStaffTravelHours, isEntranceTile } from '../src/simulation/Layout.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { processDailyCosts } from '../src/simulation/EconomyManager.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { HOUSEKEEPING, STAFF, AMENITIES, TRAVEL } from '../src/config/balance.js';
import { STAFF_FATIGUE } from '../src/config/staff.js';
import type { HotelState } from '../src/simulation/types.js';

/** Starter lobby with `n` standard rooms on row 2, all occupied and due a clean. */
function hotel(n: number, housekeepers: number): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000 };
  for (let x = 0; x < n; x++) s = addRoom(s, 'standard', x, 2)!;
  return {
    ...s, day: 4, hour: HOUSEKEEPING.dailyCleaningHour,
    staff: { ...s.staff, housekeepers },
    rooms: s.rooms.map(r => ({ ...r, status: 'occupied' as const, guestId: `g-${r.id}`, cleanliness: 50 })),
  };
}

describe('Daily cleans share the housekeeping pool', () => {
  it('are queued at the cleaning hour, then worked off hour by hour', () => {
    const queued = processDailyHousekeeping(hotel(2, 1)).state;
    expect(queued.rooms.every(r => r.dailyCleanHoursRemaining === 1 / STAFF.housekeeping.dailyCleanRoomsPerHour)).toBe(true);
    expect(queued.rooms.every(r => r.cleanliness === 50)).toBe(true); // nothing done yet

    let s = queued;
    for (let h = 0; h < 3; h++) s = processCleaningTick({ ...s, hour: s.hour + h }).state;
    expect(s.rooms.every(r => r.lastDailyCleanDay === 4 && r.dailyCleanHoursRemaining === 0)).toBe(true);
    expect(s.rooms.every(r => r.cleanliness === 50 + HOUSEKEEPING.dailyCleaningBoost)).toBe(true);
    expect(s.cash).toBe(queued.cash - 2 * HOUSEKEEPING.dailyCleaningCost);
  });

  it('turnovers come first: they block bookings', () => {
    let s = processDailyHousekeeping(hotel(2, 1)).state;
    // The first room checks out and needs a turnover; one housekeeper-hour is all there is
    s = { ...s, rooms: s.rooms.map((r, i) => i === 0 ? startTurnoverCleaning(r, 'standard') : r) };
    const after = processCleaningTick(s).state;
    const walk = getStaffTravelHours(s, s.rooms[0]); // from the lobby, where the housekeeper waits
    expect(after.rooms[0].cleaningHoursRemaining).toBeCloseTo(HOUSEKEEPING.turnoverDuration.standard - (1 - walk), 6);
    expect(after.rooms[1].dailyCleanHoursRemaining).toBe(s.rooms[1].dailyCleanHoursRemaining); // untouched
  });

  it('a checkout cancels a pending daily clean', () => {
    const s = processDailyHousekeeping(hotel(1, 1)).state;
    expect(startTurnoverCleaning(s.rooms[0], 'standard').dailyCleanHoursRemaining).toBe(0);
  });

  it('guests leaving today get no daily clean (the turnover will do)', () => {
    let s = hotel(2, 1);
    s = { ...s, guests: s.rooms.map((r, i) => ({
      id: r.guestId!, name: 'Sam', budget: 200, stayLength: i === 0 ? 3 : 1, trait: 'normal' as const,
      satisfaction: 50, checkInDay: s.day - 1, isReturning: false, hadNoiseComplaint: false,
    })) };
    const queued = processDailyHousekeeping(s).state;
    expect(queued.rooms.map(r => r.dailyCleanHoursRemaining > 0)).toEqual([true, false]);
  });

  it('daily cleans still pending when the shift ends are skipped', () => {
    let s = processDailyHousekeeping(hotel(9, 1)).state;
    s = { ...s, hour: STAFF.housekeeping.workEndHour - 1 };
    const result = processCleaningTick(s);
    expect(result.state.rooms.every(r => r.dailyCleanHoursRemaining === 0)).toBe(true);
    expect(result.events.some(e => e.type === 'daily_cleaning' && (e.data as any)?.roomsSkipped > 0)).toBe(true);
  });
});

describe('Housekeeping workload', () => {
  it('scales with rooms, occupancy, and turnover quality', () => {
    const small = hotel(4, 1);
    const big = hotel(9, 1);
    expect(estimateHousekeepingHours(big, 0.8)).toBeGreaterThan(estimateHousekeepingHours(small, 0.8));
    expect(estimateHousekeepingHours(big, 0.9)).toBeGreaterThan(estimateHousekeepingHours(big, 0.5));
    const thorough = { ...big, housekeeping: { ...big.housekeeping, turnoverQuality: 'thorough' as const } };
    expect(estimateHousekeepingHours(thorough, 0.8)).toBeGreaterThan(estimateHousekeepingHours(big, 0.8));
  });

  it('housekeepersNeeded covers the estimated hours', () => {
    const s = hotel(9, 1);
    const needed = housekeepersNeeded(s, PLANNING_OCCUPANCY);
    expect(housekeepingHoursAvailable(needed)).toBeGreaterThanOrEqual(estimateHousekeepingHours(s, PLANNING_OCCUPANCY));
    expect(housekeepingHoursAvailable(needed - 1)).toBeLessThan(estimateHousekeepingHours(s, PLANNING_OCCUPANCY));
  });

  it('a recovery room cannot erase supply walks from the workload or halve the understaffed crew', () => {
    const enabled = STAFF_FATIGUE.enabled;
    STAFF_FATIGUE.enabled = true;
    try {
      let original = hotel(9, 1);
      for (const x of [5, 6, 7]) original = addRoom(original, 'standard', x, 5, 0, 'up')!;
      const s = { ...original, housekeeping: { ...original.housekeeping, turnoverQuality: 'thorough' as const } };
      const withBreak = addFixture(s, 'breakroom', 4, 0, 0)!;
      expect(getStaffTravelHours(withBreak, withBreak.rooms[0])).toBeLessThan(getStaffTravelHours(s, s.rooms[0]));
      expect(baseWalkHours(withBreak)).toBeCloseTo(baseWalkHours(s), 10);
      expect(estimateHousekeepingHours(withBreak, PLANNING_OCCUPANCY)).toBeCloseTo(estimateHousekeepingHours(s, PLANNING_OCCUPANCY), 10);
      expect(housekeepersNeeded(s, PLANNING_OCCUPANCY)).toBe(3);
      expect(housekeepersNeeded(withBreak, PLANNING_OCCUPANCY)).toBe(3);
      expect(Math.round(housekeepersNeeded(withBreak, PLANNING_OCCUPANCY) * 0.6)).toBe(2);
      const withCloset = addFixture(withBreak, 'closet', 8, 0, 0)!;
      expect(baseWalkHours(withCloset)).toBeLessThan(baseWalkHours(withBreak));
      expect(estimateHousekeepingHours(withCloset, PLANNING_OCCUPANCY)).toBeLessThan(estimateHousekeepingHours(withBreak, PLANNING_OCCUPANCY));
    } finally {
      STAFF_FATIGUE.enabled = enabled;
    }
  });

  it('retains the original break-room workload estimate when fatigue is disabled', () => {
    const enabled = STAFF_FATIGUE.enabled;
    STAFF_FATIGUE.enabled = false;
    try {
      const s = hotel(9, 1), withBreak = addFixture(s, 'breakroom', 4, 0, 0)!;
      expect(baseWalkHours(withBreak)).toBeLessThan(baseWalkHours(s));
      expect(estimateHousekeepingHours(withBreak, PLANNING_OCCUPANCY)).toBeLessThan(estimateHousekeepingHours(s, PLANNING_OCCUPANCY));
      const legacyWalk = baseWalkHours(withBreak);
      STAFF_FATIGUE.enabled = true;
      expect(baseWalkHours(withBreak)).toBeCloseTo(baseWalkHours(s), 10);
      STAFF_FATIGUE.enabled = false;
      expect(baseWalkHours(withBreak)).toBeCloseTo(legacyWalk, 10);
    } finally {
      STAFF_FATIGUE.enabled = enabled;
    }
  });

  it('the staff panel status warns when a busy day would outrun the team', () => {
    let s = hotel(9, 1);
    s = { ...s, housekeeping: { ...s.housekeeping, turnoverQuality: 'thorough' } }; // a heavy day: deep cleans
    const status = getHousekeepingStatus(s);
    expect(status.hoursNeeded).toBeGreaterThan(status.hoursAvailable);
    expect(status.recommendation).toContain(`${housekeepersNeeded(s, PLANNING_OCCUPANCY)} housekeepers`);
    expect(getHousekeepingStatus({ ...s, staff: { ...s.staff, housekeepers: 20 } }).recommendation).toBeNull();
  });
});

describe('Amenities are charged per occupied room', () => {
  it('empty rooms cost no amenities', () => {
    const occupied = hotel(4, 1);
    const empty = { ...occupied, rooms: occupied.rooms.map(r => ({ ...r, status: 'vacant' as const, guestId: undefined })) };
    const perRoom = AMENITIES.tiers[occupied.amenities.standard].dailyCostPerRoom;
    expect(processDailyCosts(empty).cashDelta - processDailyCosts(occupied).cashDelta).toBeCloseTo(4 * perRoom, 6);
  });
});

describe('Balance: there is a right amount of housekeeping', () => {
  it('staffing to the workload beats under-staffing by far, and over-staffing too', () => {
    const runs = 24;
    const median = (name: string) => {
      const vals = Array.from({ length: runs }, (_, i) => simulate(400, i, undefined, STRATEGIES[name]).finalValuation).sort((a, b) => a - b);
      return (vals[runs / 2 - 1] + vals[runs / 2]) / 2;
    };
    const right = median('balanced');
    // Measured over 24 seeds x 400 days: 0.6x the housekeepers ends about 39% lower (turnovers pile up,
    // daily cleans go undone), 1.6x about 30% lower (idle wages hold back building); 1.0x to 1.2x is
    // the top of the curve. With spotlight guests (phase 3b), measured over 96 seeds: staffing to the
    // workload beats 0.6x by 1.60x and 1.6x by 1.39x (1.61x and 1.34x without them). These 24 seeds:
    // 1.69x and 1.47x (1.62x and 1.38x without). The test once took six seeds, too few: re-rolling the
    // random stream alone (no change to the game) failed one six-seed run in five or so, and no run of 24.
    // Even 24 can fall short: of the four runs of 24 in those 96 seeds, one (48-71) is 1.47x and 1.29x
    // with spotlight guests, so a change that fails here needs the 96-seed check before it's blamed.
    expect(right).toBeGreaterThan(median('understaffed') * 1.5);
    expect(right).toBeGreaterThan(median('overstaffed') * 1.15);
  }, 3600000); // Same 72 seeded runs; fatigue now projects physical work, recovery and future desk coverage.
});

describe('The staff on screen do exactly the work the simulation credits', () => {
  /** Two checkouts being turned over plus queued daily cleans, two housekeepers. */
  function busyHotel(): HotelState {
    let s = processDailyHousekeeping(hotel(6, 2)).state;
    s = { ...s, hour: 12, rooms: s.rooms.map((r, i) => i < 2 ? { ...startTurnoverCleaning(r, 'standard'), cleaningHoursRemaining: 0.3 + i } : r) };
    return s;
  }

  it('each worker\'s hour is one unbroken itinerary, and a room never has two workers at once', () => {
    const plan = getStaffPlan(busyHotel());
    const T = plan.start;
    const stays: Array<{ room: string; from: number; to: number }> = [];
    for (const it of plan.itineraries) {
      expect(it.legs[0].start).toBeCloseTo(T, 9);
      for (let i = 1; i < it.legs.length; i++) expect(it.legs[i].start).toBeCloseTo(it.legs[i - 1].end, 9);
      for (const l of it.legs) if (l.kind === 'stay' && l.job) stays.push({ room: l.placeId!, from: l.start, to: l.end });
    }
    for (const a of stays) for (const b of stays) {
      if (a !== b && a.room === b.room) expect(a.to <= b.from + 1e-9 || b.to <= a.from + 1e-9).toBe(true);
    }
  });

  it('a housekeeper walks to a room before working in it, and is in the room while they work', () => {
    const s = busyHotel();
    const plan = getStaffPlan(s);
    for (const it of plan.itineraries) {
      it.legs.forEach((leg, i) => {
        if (leg.kind !== 'stay' || !leg.job) return;
        const room = s.rooms.find(r => r.id === leg.placeId)!;
        const prev = it.legs[i - 1];
        if (prev) expect(prev.kind === 'walk' && prev.path[prev.path.length - 1]).toMatchObject({ gridX: room.gridX, gridY: room.gridY, floor: room.floor });
        const mid = positionAt(it.legs, (leg.start + leg.end) / 2)!;
        expect([mid.x, mid.y, mid.floor]).toEqual([room.gridX, room.gridY, room.floor]);
      });
    }
  });

  it('the cleaning tick credits each room exactly the time a housekeeper spends in it', () => {
    const before = busyHotel();
    const plan = getStaffPlan(before);
    const turnover = plannedWork(plan, 'turnover');
    const daily = plannedWork(plan, 'daily');
    const after = processCleaningTick(before).state;
    for (const room of before.rooms) {
      const next = after.rooms.find(r => r.id === room.id)!;
      if (room.status === 'cleaning') {
        const done = next.status === 'cleaning' ? room.cleaningHoursRemaining - next.cleaningHoursRemaining : room.cleaningHoursRemaining;
        expect(done).toBeCloseTo(Math.min(room.cleaningHoursRemaining, turnover.get(room.id) ?? 0), 6);
      } else {
        expect(room.dailyCleanHoursRemaining - next.dailyCleanHoursRemaining).toBeCloseTo(Math.min(room.dailyCleanHoursRemaining, daily.get(room.id) ?? 0), 6);
      }
    }
  });

  it('maintenance repairs each room for exactly the time a worker is in it', () => {
    let s = hotel(4, 1);
    s = { ...s, hour: 12, staff: { ...s.staff, maintenanceWorkers: 2 },
      rooms: s.rooms.map((r, i) => ({ ...r, status: 'vacant' as const, guestId: undefined, condition: 20 + i * 10 })) };
    const repair = plannedWork(getStaffPlan(s), 'repair');
    expect([...repair.keys()].sort()).toEqual([s.rooms[0].id, s.rooms[1].id].sort()); // worst two
    const after = processMaintenanceTick(s).state;
    s.rooms.forEach((r, i) => expect(after.rooms[i].condition).toBeCloseTo(r.condition + (repair.get(r.id) ?? 0) * STAFF.maintenance.repairPerHour, 6));
  });

  it('a full tick applies the plan stored in the state, and leaves everyone where the plan ends', () => {
    let before = busyHotel();
    before = { ...before, staffRoster: getRoster(before) };
    before = { ...before, staffPlan: planStaff(before) };
    const plan = before.staffPlan!;
    const planned = plannedWork(plan, 'turnover');
    const after = tickSimulation(before, new PRNG(1)).state;
    for (const room of before.rooms.filter(r => r.status === 'cleaning')) {
      const next = after.rooms.find(r => r.id === room.id)!;
      const progressed = next.status !== 'cleaning' || next.cleaningHoursRemaining < room.cleaningHoursRemaining;
      expect(progressed).toBe(planned.has(room.id));
    }
    for (const it of plan.itineraries) {
      const member = after.staffRoster!.find(m => m.id === it.staffId)!;
      expect(member.at).toEqual(it.end.at);
    }
  });

  it('positions carry over the hour boundary: where a worker ends one hour is where the next begins', () => {
    let s = busyHotel();
    const prng = new PRNG(3);
    for (let h = 0; h < 6; h++) {
      const plan = getStaffPlan(s);
      const T = hourStart(s);
      s = tickSimulation(s, prng).state;
      const next = getStaffPlan(s);
      for (const it of plan.itineraries) {
        const nx = next.itineraries.find(i => i.staffId === it.staffId);
        if (!nx || nx.legs.length === 0 || it.legs.length === 0) continue;
        const a = positionAt(it.legs, T + 1 - 1e-9)!;
        const b = positionAt(nx.legs, T + 1 + 1e-9)!;
        expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeLessThan(0.6);
        expect(a.floor).toBe(b.floor);
      }
    }
  });

  it('a worker keeps at their room from one hour to the next (no handoffs)', () => {
    let s = hotel(3, 2);
    s = { ...s, hour: 12, rooms: s.rooms.map(r => startTurnoverCleaning(r, 'standard')) };
    const first = getStaffPlan(s);
    const rooms = (plan: typeof first) => new Map(plan.itineraries.filter(it => it.staffId.startsWith('housekeeper')).map(it => [it.staffId, it.legs.filter(l => l.kind === 'stay' && l.job).map(l => (l as any).placeId).pop()]));
    s = tickSimulation(s, new PRNG(1)).state;
    expect(rooms(getStaffPlan(s))).toEqual(rooms(first));
  });
});

describe('Shifts, hiring, and letting staff go', () => {
  it('at the end of the shift staff walk out through the street entrance; before it they walk in and are at their posts at 6:00', () => {
    let s = hotel(2, 1);
    s = { ...s, staffRoster: getRoster({ ...s, hour: 12 }), hour: STAFF.housekeeping.workEndHour };
    const out = getStaffPlan(s).itineraries[0];
    const last = out.legs[out.legs.length - 1];
    expect(last.kind).toBe('walk');
    expect(isEntranceTile(s, (last as any).path[(last as any).path.length - 1])).toBe(true);
    expect(out.end.at).toBeNull();

    s = { ...s, staffRoster: getRoster(s).map(m => ({ ...m, at: null })), hour: STAFF.housekeeping.workStartHour - 1 };
    const inbound = getStaffPlan(s).itineraries[0];
    expect(legsEnd(inbound.legs)).toBeCloseTo(hourStart(s) + 1, 9); // arrives right at 6:00
    expect(inbound.end.at).toEqual(restingPlace(s, 0)!.at);
  });

  it('new hires walk in off the street, and staff let go walk out', () => {
    let s = hotel(2, 1);
    s = { ...s, hour: 12, staffRoster: getRoster({ ...s, hour: 12 }), staff: { ...s.staff, housekeepers: 2 } };
    let roster = syncRoster(s);
    expect(roster.filter(m => m.role === 'housekeeper').map(m => m.at === null)).toEqual([false, true]);
    const hireId = roster.find(m => m.role === 'housekeeper' && m.at === null)!.id;
    const hire = planStaff({ ...s, staffRoster: roster }).itineraries.find(it => it.staffId === hireId)!;
    const firstStep = hire.legs[0];
    expect(firstStep.kind === 'walk' && isEntranceTile(s, firstStep.path[0])).toBe(true);

    s = { ...s, staffRoster: roster.map(m => ({ ...m, at: { gridX: 4, gridY: 4, floor: 0 } })), staff: { ...s.staff, housekeepers: 1 } };
    roster = syncRoster(s);
    expect(roster.filter(m => m.leaving).length).toBe(1);
    const leaving = planStaff({ ...s, staffRoster: roster }).itineraries.find(it => roster.find(m => m.id === it.staffId)!.leaving)!;
    expect(leaving.end.at).toBeNull();
  });
});

describe('Re-planning mid-hour (the player builds while staff are out)', () => {
  /** Two housekeepers mid-way through an hour of turnovers, with the plan stored as the game keeps it. */
  function midHour() {
    let s = hotel(6, 2);
    s = { ...s, hour: 12, rooms: s.rooms.map((r, i) => ({ ...startTurnoverCleaning(r, 'standard'), cleaningHoursRemaining: i < 2 ? 0.3 : 3 })) };
    s = { ...s, staffRoster: getRoster(s) };
    return { ...s, staffPlan: planStaff(s) } as HotelState;
  }
  const work = (s: HotelState) => ['turnover', 'daily', 'repair'].map(k => [...plannedWork(getStaffPlan(s), k as any)].sort());

  it('with nothing changed, re-planning keeps the same work and everyone where they were', () => {
    const s = midHour();
    const T = hourStart(s);
    for (const t of [T + 0.2, T + 0.5, T + 0.8]) {
      const re = replanStaff(s, t);
      const before = work(s), after = work(re);
      before.forEach((kind, i) => kind.forEach(([room, h], j) => {
        expect(after[i][j][0]).toBe(room);
        expect(after[i][j][1]).toBeCloseTo(h as number, 9);
      }));
      for (const it of getStaffPlan(s).itineraries) {
        const ni = getStaffPlan(re).itineraries.find(x => x.staffId === it.staffId)!;
        for (let k = 1; k < ni.legs.length; k++) expect(ni.legs[k].start).toBeCloseTo(ni.legs[k - 1].end, 9);
        for (const u of [t - 0.1, t - 0.01]) {
          const a = positionAt(it.legs, u)!, b = positionAt(ni.legs, u)!;
          expect([b.x, b.y, b.floor]).toEqual([a.x, a.y, a.floor]);
        }
      }
    }
  });

  it('a room finished earlier in the hour is not cleaned again', () => {
    const s = midHour();
    const T = hourStart(s);
    const first = getStaffPlan(s).itineraries.flatMap(it => it.legs).find(l => l.kind === 'stay' && l.job === 'turnover')!;
    const re = replanStaff(s, first.end + 0.05);
    expect(plannedWork(getStaffPlan(re), 'turnover').get((first as any).placeId)).toBeCloseTo(0.3, 9);
    expect(T).toBeLessThan(first.end);
  });

  it('a worker cut off by a new room does not hold up everyone else', () => {
    let s = hotel(6, 2);
    s = { ...s, hour: 12, rooms: s.rooms.map((r, i) => ({ ...startTurnoverCleaning(r, 'standard'), cleaningHoursRemaining: 3 })) };
    // housekeeper-0 is inside room 0, whose doorway (x,1) then gets built over
    const room0 = s.rooms[0];
    s = { ...s, staffRoster: getRoster(s).map((m, i) => (i === 0 ? { ...m, at: { gridX: room0.gridX, gridY: room0.gridY, floor: 0, door: room0.door }, roomId: room0.id } : m)) };
    s = addRoom({ ...s, cash: 1_000_000 }, 'standard', room0.gridX, room0.gridY - 1, 0, 'up')!;
    const plan = planStaff(s);
    const stuck = plan.itineraries[0];
    expect(stuck.legs.every(l => l.kind === 'stay' && l.at.gridX === room0.gridX && l.at.gridY === room0.gridY)).toBe(true); // stays put, drawn where they are
    const others = plan.itineraries.slice(1).flatMap(it => it.legs).filter(l => l.kind === 'stay' && l.job === 'turnover');
    expect(others.length).toBeGreaterThan(0); // the other housekeeper still works
  });

  it('a step under way is finished, not undone (no jump back)', () => {
    const s = midHour();
    const it = getStaffPlan(s).itineraries.find(i => i.legs.some(l => l.kind === 'walk'))!;
    const walk = it.legs.find(l => l.kind === 'walk')! as any;
    const t = walk.start + 1.5 * TRAVEL.hoursPerTile; // halfway through the second step
    const re = getStaffPlan(replanStaff(s, t)).itineraries.find(i => i.staffId === it.staffId)!;
    for (const u of [t - 0.005, t, t + 0.005]) {
      const a = positionAt(it.legs, u)!, b = positionAt(re.legs, u)!;
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeLessThan(1e-9);
    }
  });

  it('the work credited is the time spent in the room (worked out by hand)', () => {
    let s = hotel(1, 1);
    s = { ...s, hour: 12, rooms: [{ ...startTurnoverCleaning(s.rooms[0], 'standard'), cleaningHoursRemaining: 3 }] };
    const walk = getStaffTravelHours(s, s.rooms[0]); // from the lobby, where the housekeeper waits
    expect(processCleaningTick(s).state.rooms[0].cleaningHoursRemaining).toBeCloseTo(3 - (1 - walk), 9);
  });
});
