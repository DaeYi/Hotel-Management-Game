import { it, expect } from 'vitest';
import { createStarterHotel, addRoom } from '../src/simulation/HotelState.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { getStaffPlan } from '../src/simulation/StaffManager.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { processCleaningTick } from '../src/simulation/HousekeepingManager.js';
import { processMaintenanceTick } from '../src/simulation/MaintenanceManager.js';
import { positionAt, memberPositionAt, legsEnd, hourStart } from '../src/simulation/Movement.js';
import { facilityCapacity } from '../src/simulation/FacilityManager.js';
import { isEntranceTile } from '../src/simulation/Layout.js';
import { partyOf, partyLoad } from '../src/simulation/Party.js';
import { guestFigures } from '../src/render/figures.js';
import { STAFF, TRAVEL } from '../src/config/balance.js';
import type { HotelState, Leg } from '../src/simulation/types.js';

function contiguous(legs: Leg[]): boolean {
  for (let i = 1; i < legs.length; i++) if (Math.abs(legs[i].start - legs[i - 1].end) > 1e-6) return false;
  return true;
}

// A long run of the balanced bot, checking every hour that what the staff and
// guests are shown doing is what the simulation does: work is credited only
// for time someone spends in the room, nobody jumps between hours, rooms have
// one worker at a time, desks serve no more guests than they seat,
// facilities never hold more than their capacity, people leave by the street
// entrance, and nobody is in a room while it's turned over or repaired --
// counting every member of every party, each drawn where the simulation has them.
it('what everyone is shown doing is what the simulation does, hour after hour', () => {
  const problems: Record<string, number> = {};
  const examples: Record<string, string> = {};
  const bad = (k: string, ex: string) => { problems[k] = (problems[k] ?? 0) + 1; if (!examples[k]) examples[k] = ex; };
  let visits = 0;
  let partyTrips = 0;
  for (const seed of [1, 2]) {
    let s: HotelState = createStarterHotel();
    // Doubles, and rooms for friends and families, so parties of every size stay
    const kinds = ['standard', 'standard', 'bunk_family', 'standard', 'twin', 'standard', 'bunk_family', 'standard'] as const;
    kinds.forEach((kind, x) => { s = addRoom(s, kind, x, 2) ?? s; });
    const prng = new PRNG(seed);
    for (let h = 0; h < 24 * 200; h++) {
      s = settleChanges(s, STRATEGIES.balanced(s), hourStart(s));
      const before = s;
      const plan = getStaffPlan(before);
      const T = hourStart(before);
      // C/D: itineraries contiguous, one worker per room at a time
      const stays: Array<{ room: string; a: number; b: number; who: string }> = [];
      for (const it of plan.itineraries) {
        if (!contiguous(it.legs)) bad('staff legs not contiguous', JSON.stringify(it.legs.map(l => [l.kind, l.start, l.end])));
        for (const l of it.legs) if (l.kind === 'stay' && l.job) stays.push({ room: l.placeId!, a: l.start, b: l.end, who: it.staffId });
      }
      for (let i = 0; i < stays.length; i++) for (let j = i + 1; j < stays.length; j++) {
        const x = stays[i], y = stays[j];
        if (x.room === y.room && x.a < y.b - 1e-9 && y.a < x.b - 1e-9) bad('two workers in one room at once', `${x.who} ${y.who} ${x.room}`);
      }
      // A (staff): each room gets exactly the time someone spends in it --
      // worked out from where the itineraries put people, not from the plan's
      // own bookkeeping -- and nothing is planned that can't be credited
      const timeIn = (job: string) => {
        const m = new Map<string, number>();
        for (const it of plan.itineraries) for (const l of it.legs) {
          if (l.kind !== 'stay' || l.job !== job) continue;
          const room = before.rooms.find(x => x.id === l.placeId);
          const at = positionAt(it.legs, (l.start + l.end) / 2)!;
          if (!room || at.x !== room.gridX || at.y !== room.gridY || at.floor !== room.floor) { bad('working stay not in its room', `${it.staffId} ${l.placeId}`); continue; }
          m.set(room.id, (m.get(room.id) ?? 0) + Math.min(l.end, T + 1) - Math.max(l.start, T));
        }
        return m;
      };
      const turn = timeIn('turnover');
      const daily = timeIn('daily');
      const repair = timeIn('repair');
      for (const [id] of repair) if (before.rooms.find(x => x.id === id)?.status !== 'vacant') bad('repair planned in a room that is not vacant', id);
      const maintained = processMaintenanceTick(before).state; // the repair step on its own, before guests arrive
      for (const room of before.rooms.filter(x => x.status === 'vacant')) {
        const expected = Math.min(100, room.condition + (repair.get(room.id) ?? 0) * STAFF.maintenance.repairPerHour);
        if (Math.abs(maintained.rooms.find(x => x.id === room.id)!.condition - expected) > 1e-6) bad('repair != time in room', room.id);
      }
      const cleaned = processCleaningTick(before).state;
      for (const room of before.rooms.filter(x => x.status === 'occupied' && x.dailyCleanHoursRemaining > 0)) {
        const next = cleaned.rooms.find(x => x.id === room.id)!;
        const doneHours = next.lastDailyCleanDay === before.day && room.lastDailyCleanDay !== before.day ? room.dailyCleanHoursRemaining : room.dailyCleanHoursRemaining - next.dailyCleanHoursRemaining;
        const lastHour = before.hour === STAFF.housekeeping.workEndHour - 1 && next.dailyCleanHoursRemaining === 0 && next.lastDailyCleanDay !== before.day;
        if (!lastHour && Math.abs(doneHours - Math.min(room.dailyCleanHoursRemaining, daily.get(room.id) ?? 0)) > 1e-6) bad('daily clean != time in room', room.id);
      }
      const r = tickSimulation(before, prng);
      const after = r.state;
      for (const g of after.guests) for (const l of g.trip ?? []) if (l.kind === 'stay' && l.activity === 'visit' && l.start >= hourStart(after)) visits++;
      for (const room of before.rooms) {
        const next = after.rooms.find(x => x.id === room.id);
        if (!next) continue;
        if (room.status === 'cleaning') {
          const done = next.status === 'cleaning' ? room.cleaningHoursRemaining - next.cleaningHoursRemaining : room.cleaningHoursRemaining;
          const planned = Math.min(turn.get(room.id) ?? 0, room.cleaningHoursRemaining);
          if (Math.abs(done - planned) > 1e-6 && !(next.status !== 'cleaning' && planned >= room.cleaningHoursRemaining - 1e-6)) bad('turnover progress != planned', `${room.id} done ${done} planned ${planned}`);
        }
      }
      // B: staff continuity across the boundary
      const nextPlan = getStaffPlan(after);
      for (const it of plan.itineraries) {
        const nx = nextPlan.itineraries.find(i => i.staffId === it.staffId);
        if (!nx) continue;
        const endPos = it.legs.length ? positionAt(it.legs, T + 1 - 1e-9) : null;
        const startPos = nx.legs.length ? positionAt(nx.legs, T + 1 + 1e-9) : null;
        const goneEnd = it.legs.length > 0 && legsEnd(it.legs) <= T + 1 && !it.end.at;
        const notYet = nx.legs.length > 0 && nx.legs[0].start > T + 1 + 1e-6;
        if (endPos && startPos && !goneEnd && !notYet) {
          if (Math.abs(endPos.x - startPos.x) > 0.6 || Math.abs(endPos.y - startPos.y) > 0.6 || endPos.floor !== startPos.floor) bad('staff jumps at the hour boundary', `${it.staffId} ${JSON.stringify([endPos.x, endPos.y, endPos.floor])} -> ${JSON.stringify([startPos.x, startPos.y, startPos.floor])}`);
        }
      }
      // E/G: guest trips
      const checkIns: Array<{ desk: string; a: number; b: number; front: string }> = [];
      for (const g of after.guests) {
        if (!g.trip) continue;
        if (!contiguous(g.trip)) bad('guest trip not contiguous', g.id);
        for (const l of g.trip) if (l.kind === 'stay' && l.activity === 'check_in') checkIns.push({ desk: l.placeId!, a: l.start, b: l.end, front: `${l.at.gridX},${l.at.gridY}` });
        const room = after.rooms.find(x => x.guestId === g.id);
        const last = g.trip[g.trip.length - 1];
        const end = last.kind === 'walk' ? last.path[last.path.length - 1] : last.at;
        if (room && (end.gridX !== room.gridX || end.gridY !== room.gridY || end.floor !== room.floor)) bad('guest trip does not end in their room', g.id);
      }
      // per desk, check-ins overlap at most staffPerDesk at once
      for (const c of checkIns) {
        const overlap = checkIns.filter(d => d.desk === c.desk && d.a < c.b - 1e-9 && c.a < d.b - 1e-9).length;
        if (overlap > 2) bad('more check-ins at once than seats', c.desk);
      }
      // F: capacity, counting parties by size -- the visits planned there, and the people drawn there
      for (const f of after.facilities) {
        for (const t of [T + 1.1, T + 1.4, T + 1.7, T + 1.95]) {
          const n = after.guests.filter(g => g.trip?.some(l => l.kind === 'stay' && l.placeId === f.id && l.start <= t && t < l.end))
            .reduce((sum, g) => sum + partyLoad(partyOf(g).size), 0);
          if (n > facilityCapacity(f) + 1e-9) bad('facility over capacity', f.id);
          const inside = after.guests.filter(g => g.trip && Array.from({ length: partyOf(g).size }, (_, m) => memberPositionAt(g.trip!, t, m, TRAVEL.guestHoursPerTile))
            .some(at => at && at.leg.kind === 'stay' && at.leg.placeId === f.id))
            .reduce((sum, g) => sum + partyLoad(partyOf(g).size), 0);
          if (inside > facilityCapacity(f) + 1e-9) bad('more people drawn in a facility than it holds', f.id);
        }
      }
      // J: every member of a party out of their room is drawn, together while stopped
      for (const t of [T + 1.05, T + 1.35, T + 1.65, T + 1.9]) {
        const { figures } = guestFigures(after, t);
        for (const g of [...after.guests.map(g => ({ id: g.id, legs: g.trip ?? [], party: partyOf(g) })), ...(after.walkers ?? []).map(w => ({ id: w.id, legs: w.trip, party: partyOf(w) }))]) {
          if (!g.legs.length || t < g.legs[0].start || t >= legsEnd(g.legs)) continue;
          const at = positionAt(g.legs, t)!;
          const drawn = figures.filter(f => f.id === g.id || f.id.startsWith(`${g.id}#`));
          const expected = at.leg.kind === 'stay' && at.leg.activity === 'away' ? 0 : g.party.size;
          if (drawn.length !== expected) bad('party members drawn != party size', `${g.id} drew ${drawn.length} of ${expected}`);
          if (at.leg.kind === 'stay' && drawn.some(f => Math.abs(f.x - at.x) > 1e-9 || Math.abs(f.y - at.y) > 1e-9 || f.floor !== at.floor)) bad('party apart while stopped', g.id);
          if (g.party.size >= 3) partyTrips++;
        }
      }
      // H: walkers end at an entrance
      for (const w of after.walkers ?? []) {
        const last = w.trip[w.trip.length - 1];
        const end = last.kind === 'walk' ? last.path[last.path.length - 1] : last.at;
        if (!isEntranceTile(after, end)) bad('walker does not leave by an entrance', w.id);
      }
      // I: nobody (guest or walker) is in a room while staff turn it over or repair it
      const nextStays: Array<{ room: string; a: number; b: number; job: string }> = [];
      // (a housekeeper already in the room when the hour began -- doing the daily clean of a guest who then walked out -- was there with the guest's say-so)
      const T1 = hourStart(after);
      for (const it of getStaffPlan(after).itineraries) for (const l of it.legs) {
        if (l.kind !== 'stay' || (l.job !== 'turnover' && l.job !== 'repair')) continue;
        const wasInside = l.start <= T1 + 1e-9 && after.staffRoster?.find(m => m.id === it.staffId)?.at?.door !== undefined;
        if (!wasInside) nextStays.push({ room: l.placeId!, a: l.start, b: l.end, job: l.job });
      }
      for (const st of nextStays) {
        const room = after.rooms.find(x => x.id === st.room);
        if (!room) continue;
        for (const tt of [st.a + 0.001, (st.a + st.b) / 2]) {
          const people = [...after.guests.map(g => ({ id: g.id, legs: g.trip ?? [], size: partyOf(g).size })), ...(after.walkers ?? []).map(w => ({ id: w.id, legs: w.trip, size: partyOf(w).size }))];
          for (const p of people) {
            if (!p.legs.length || tt < p.legs[0].start || tt >= legsEnd(p.legs)) continue;
            for (let m = 0; m < p.size; m++) {
              const at = memberPositionAt(p.legs, tt, m, TRAVEL.guestHoursPerTile)!;
              if (Math.round(at.x) === room.gridX && Math.round(at.y) === room.gridY && at.floor === room.floor) bad('someone in a room while staff work it', `${p.id}#${m} in ${room.id} (${st.job}) at ${tt}`);
            }
          }
        }
      }
      s = after;
    }
    expect(visits).toBeGreaterThan(0); // the run got far enough for guests to be using facilities
  }
  expect(partyTrips).toBeGreaterThan(50); // parties of three or more came and went
  expect(problems, JSON.stringify(examples)).toEqual({});
}, 300000);
