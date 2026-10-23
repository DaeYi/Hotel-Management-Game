import { it, expect } from 'vitest';
import { staffRate, specialtyOf } from '../src/simulation/StaffProfiles.js';
import { fatigueAt } from '../src/simulation/StaffFatigue.js';
import { createStarterHotel, addRoom, getAvailableRooms } from '../src/simulation/HotelState.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { getStaffPlan } from '../src/simulation/StaffManager.js';
import { assignStaffSpecialty } from '../src/simulation/StaffHiring.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { processCleaningTick } from '../src/simulation/HousekeepingManager.js';
import { processMaintenanceTick } from '../src/simulation/MaintenanceManager.js';
import { positionAt, memberPositionAt, legsEnd, hourStart } from '../src/simulation/Movement.js';
import { facilityCapacity, facilityLoad, visitChance } from '../src/simulation/FacilityManager.js';
import { isEntranceTile, stepHours } from '../src/simulation/Layout.js';
import { partyOf, partyLoad } from '../src/simulation/Party.js';
import { fitsParty } from '../src/simulation/RoomProfile.js';
import { guestFigures } from '../src/render/figures.js';
import { STAFF, TRAVEL, SPOTLIGHT } from '../src/config/balance.js';
import type { HotelState, Leg, OnSiteTakings } from '../src/simulation/types.js';
import { guestPace } from '../src/simulation/Profile.js';
import { housekeepingPrefOf, partyOutOfRoom } from '../src/simulation/CleaningPreference.js';
import { patienceHours, readyAt } from '../src/simulation/DeskQueue.js';
import { isSleepHour, activityHour, activityOffset } from '../src/simulation/Profile.js';
import { spendingOf, spentHere } from '../src/simulation/Spending.js';
import { isCheckoutDay } from '../src/simulation/GuestManager.js';
import { hostsTonight } from '../src/simulation/Visitors.js';
import { isGuestAway, checkInLanes } from '../src/simulation/GuestMovement.js';
import { arrivalTime } from '../src/simulation/Spotlight.js';
import { profileRoom } from '../src/simulation/RoomProfile.js';

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
  let dndCleans = 0;
  let visitorNights = 0;
  let queued = 0;
  let gaveUp = 0;
  let complaintTrips = 0;
  let charges = 0;
  let dinners = 0;
  let thriftyTrips = 0;
  let held = 0;
  let heldTaken = 0;
  let spotlights = 0;
  let toured = 0;
  let writersLeft = 0;
  let tourSkips = 0;
  let preventiveRepairs = 0;
  let preventiveStarts = 0;
  let preventiveContinuations = 0;
  let preventiveCompleted = 0;
  // Spotlight guests every other week, whatever the stars (a 200-day bot hotel spends most of it below 5 stars, where they're rare)
  const weekly = SPOTLIGHT.weeklyChance;
  SPOTLIGHT.weeklyChance = { 3: 0.5, 4: 0.5, 5: 0.5 };
  try {
  for (const seed of [1, 2]) {
    let s: HotelState = createStarterHotel();
    let preventiveJobs = new Set<string>();
    // Doubles, and rooms for friends and families, so parties of every size stay
    const kinds = ['standard', 'standard', 'bunk_family', 'standard', 'twin', 'standard', 'bunk_family', 'standard'] as const;
    kinds.forEach((kind, x) => { s = addRoom(s, kind, x, 2) ?? s; });
    const prng = new PRNG(seed);
    // Recovery rooms take space and capital before the hotel expands. Keep
    // every coverage gate, and run long enough to exercise the same volume.
    for (let h = 0; h < 24 * 220; h++) {
      s = settleChanges(s, STRATEGIES.balanced(s), hourStart(s));
      // This fixture exercises occupied-room maintenance deliberately; the
      // quick-hire shortcut's changing candidate mix must not decide coverage.
      for (const member of s.staffRoster ?? []) {
        if (member.role !== 'maintenance' || member.leaving || specialtyOf(member) === 'preventive') continue;
        s = settleChanges(s, assignStaffSpecialty(s, member.id, 'preventive') ?? s, hourStart(s));
      }
      const before = s;
      const plan = getStaffPlan(before);
      const T = hourStart(before);
      const withCurrentPlan = { ...before, staffPlan: plan };
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
          const worker = before.staffRoster?.find(m => m.id === it.staffId);
          // The work stay snapshots its rate when it begins. A worker can
          // cross the tired threshold between two stays in this same hour.
          const fatigue = worker ? fatigueAt(withCurrentPlan, worker, l.start) : 0;
          const expectedRate = worker ? staffRate({ ...worker, stats: { ...worker.stats!, fatigue } }) : 1;
          const rate = l.workRate ?? 1;
          if (Math.abs(rate - expectedRate) > 1e-9) bad('planned rate differs from the worker skill', `${it.staffId}: ${rate} vs ${expectedRate} at ${l.start}, fatigue ${fatigue}`);
          m.set(room.id, (m.get(room.id) ?? 0) + (Math.min(l.end, T + 1) - Math.max(l.start, T)) * rate);
        }
        return m;
      };
      const turn = timeIn('turnover');
      const daily = timeIn('daily');
      const repair = timeIn('repair');
      const continuingPreventive = new Set<string>();
      for (const it of plan.itineraries) for (const [index, l] of it.legs.entries()) {
        if (l.kind !== 'stay' || l.job !== 'repair') continue;
        const room = before.rooms.find(x => x.id === l.placeId);
        if (room?.status === 'vacant') continue; // existing vacant-room checks below are unchanged
        if (!room || room.status !== 'occupied' || !l.preventive) {
          bad('repair planned in a room that is not vacant', l.placeId ?? it.staffId); continue;
        }
        preventiveRepairs++;
        const worker = before.staffRoster?.find(m => m.id === it.staffId);
        const guest = before.guests.find(g => g.id === room.guestId);
        if (!worker || worker.role !== 'maintenance' || specialtyOf(worker) !== 'preventive') bad('occupied repair without preventive employee', it.staffId);
        if (l.repairTarget !== 85) bad('preventive repair has no fixed 85 target', room.id);
        if (!guest || housekeepingPrefOf(guest) === 'dnd') {
          bad('preventive repair without an eligible away guest', room.id); continue;
        }
        const key = `${it.staffId}|${room.id}|${guest.id}`;
        continuingPreventive.add(key);
        if (!preventiveJobs.has(key)) {
          preventiveStarts++;
          if (room.condition >= 40) bad('preventive repair started at or above 40', `${room.id}: ${room.condition}`);
        } else preventiveContinuations++;
        if (room.condition >= 85) bad('preventive repair continued at or above its target', `${room.id}: ${room.condition}`);
        if (!partyOutOfRoom(guest, room, l.start, l.end)) bad('party present during preventive work', room.id);
        // The trip's whole-party away interval must cover every room step,
        // not just the midpoint of the working stay. This includes carried
        // walks crossing an hour boundary and the explicit final step out.
        for (const leg of it.legs) {
          if (leg.kind !== 'walk') continue;
          let time = leg.start;
          for (let k = 1; k < leg.path.length; k++) {
            const a = leg.path[k - 1], b = leg.path[k], end = time + stepHours(a, b, leg.hoursPerTile);
            const touchesRoom = (a.gridX === room.gridX && a.gridY === room.gridY && a.floor === room.floor)
              || (b.gridX === room.gridX && b.gridY === room.gridY && b.floor === room.floor);
            if (touchesRoom && !partyOutOfRoom(guest, room, time, end)) bad('party present during preventive entry or exit', `${room.id} at ${time}`);
            time = end;
          }
        }
        const rate = l.workRate ?? 1; // independently checked against the worker's live energy above
        const workBefore = it.legs.slice(0, index).reduce((sum, leg) => sum + (leg.kind === 'stay' && leg.job === 'repair' && leg.placeId === room.id
          ? Math.max(0, Math.min(leg.end, T + 1) - Math.max(leg.start, T)) * (leg.workRate ?? 1) : 0), 0);
        const finish = l.start + Math.max(0, 85 - room.condition - workBefore * STAFF.maintenance.repairPerHour) / (STAFF.maintenance.repairPerHour * rate);
        const outBy = finish + TRAVEL.hoursPerTile;
        if (!partyOutOfRoom(guest, room, l.start, outBy)) bad('preventive job cannot finish and exit before guest returns', room.id);
        if (outBy > (before.day - 1) * 24 + STAFF.maintenance.workEndHour + 1e-9) bad('preventive job cannot finish within shift', room.id);
      }
      preventiveJobs = continuingPreventive;
      const maintained = processMaintenanceTick(before).state; // the repair step on its own, before guests arrive
      for (const room of before.rooms.filter(x => x.status === 'vacant')) {
        const expected = Math.min(100, room.condition + (repair.get(room.id) ?? 0) * STAFF.maintenance.repairPerHour);
        if (Math.abs(maintained.rooms.find(x => x.id === room.id)!.condition - expected) > 1e-6) bad('repair != time in room', room.id);
      }
      for (const room of before.rooms.filter(x => x.status === 'occupied' && repair.has(x.id))) {
        const actual = maintained.rooms.find(x => x.id === room.id)!;
        const expected = Math.min(85, room.condition + repair.get(room.id)! * STAFF.maintenance.repairPerHour);
        if (Math.abs(actual.condition - expected) > 1e-6) bad('preventive repair != time in room or exceeded 85', room.id);
        if (actual.status !== 'occupied' || actual.guestId !== room.guestId) bad('preventive repair changed room occupancy', room.id);
        if (actual.condition >= 85 - 1e-9) preventiveCompleted++;
      }
      const cleaned = processCleaningTick(before).state;
      for (const room of before.rooms.filter(x => x.status === 'occupied' && x.dailyCleanHoursRemaining > 0)) {
        const next = cleaned.rooms.find(x => x.id === room.id)!;
        const doneHours = next.lastDailyCleanDay === before.day && room.lastDailyCleanDay !== before.day ? room.dailyCleanHoursRemaining : room.dailyCleanHoursRemaining - next.dailyCleanHoursRemaining;
        const lastHour = before.hour === STAFF.housekeeping.workEndHour - 1 && next.dailyCleanHoursRemaining === 0 && next.lastDailyCleanDay !== before.day;
        if (!lastHour && Math.abs(doneHours - Math.min(room.dailyCleanHoursRemaining, daily.get(room.id) ?? 0)) > 1e-6) bad('daily clean != time in room', room.id);
      }
      // L: nobody from housekeeping is ever in a do-not-disturb room (cleaning, waiting, stepping in)
      // while anyone's in it -- every member of the guest's party, drawn where the simulation has them
      // (a guest with no trip is in), and anyone visiting -- with no exceptions
      const dndRooms = before.rooms.filter(r => r.status === 'occupied' && housekeepingPrefOf(before.guests.find(g => g.id === r.guestId)) === 'dnd');
      for (const it of plan.itineraries) {
        if (it.legs.length === 0) continue;
        const cleansDnd = it.legs.some(l => l.kind === 'stay' && l.job === 'daily' && dndRooms.some(r => r.id === l.placeId));
        if (cleansDnd) dndCleans++;
        for (let tt = Math.max(T, it.legs[0].start) + 0.001; tt < Math.min(T + 1, legsEnd(it.legs)); tt += 0.02) {
          const me = positionAt(it.legs, tt)!;
          const room = dndRooms.find(r => Math.round(me.x) === r.gridX && Math.round(me.y) === r.gridY && me.floor === r.floor);
          if (!room) continue;
          const guest = before.guests.find(g => g.id === room.guestId)!;
          const legs = guest.trip ?? [];
          const onTrip = legs.length > 0 && tt < legsEnd(legs) && (tt >= legs[0].start || guest.tripKind === 'arrival');
          if (!onTrip) { bad('staff in a do-not-disturb room with the guest in', `${it.staffId} in ${room.id} at ${tt}`); continue; }
          const people = [{ id: guest.id, legs, size: partyOf(guest).size }, ...(before.walkers ?? []).map(w => ({ id: w.id, legs: w.trip, size: partyOf(w).size }))];
          for (const pp of people) {
            if (!pp.legs.length || tt < pp.legs[0].start || tt >= legsEnd(pp.legs)) continue;
            for (let m = 0; m < pp.size; m++) {
              const at = memberPositionAt(pp.legs, tt, m)!;
              if (Math.round(at.x) === room.gridX && Math.round(at.y) === room.gridY && at.floor === room.floor) bad('staff in a do-not-disturb room with the guest in', `${it.staffId}: ${pp.id}#${m} in ${room.id} at ${tt}`);
            }
          }
        }
      }
      const r = tickSimulation(before, prng);
      const after = r.state;
      const T1v = hourStart(after);
      // O: the front desk queue. Arrivals decided this tick set off no earlier than the hour they were decided
      // at and wait no longer than their patience (as quoted when they join the line: a clerk let go later
      // can slow it). At each desk everyone checking in is served in the order they
      // got there, across hours, and so is everyone come to complain. Someone who gave up stood in their
      // clerk's line exactly their patience, then left by an entrance.
      const had = new Set(before.guests.map(g => g.id));
      for (const g of after.guests) {
        if (had.has(g.id) || g.tripKind !== 'arrival' || !g.trip) continue;
        if (g.trip[0].start < T1v - 1e-9) bad('set off before the hour they were decided at', g.id);
        const k = g.trip.findIndex(l => l.kind === 'stay' && l.activity === 'check_in' && l.lane);
        if (k < 0) continue;
        const ready = readyAt(g.trip, k);
        if (g.trip[k].start > ready + 1e-9) queued++;
        if (g.trip[k].start - ready > patienceHours(g) + 1e-9 && !g.spotlight) bad('waited in line past their patience', g.id); // (a spotlight guest is expected: they wait)
      }
      for (const activity of ['check_in', 'complain'] as const) {
        const served: Array<{ desk: string; arrive: number; start: number; who: string }> = [];
        for (const g of after.guests) {
          const k = g.trip ? g.trip.findIndex(l => l.kind === 'stay' && l.activity === activity && l.lane && l.end > T1v - 1) : -1;
          if (k < 0) continue;
          served.push({ desk: (g.trip![k] as any).placeId, arrive: readyAt(g.trip!, k), start: g.trip![k].start, who: g.id });
        }
        for (const a of served) for (const b of served) {
          if (a.desk === b.desk && a.arrive < b.arrive - 1e-9 && a.start > b.start + 1e-9) bad(`served out of turn (${activity})`, `${b.who} before ${a.who}`);
        }
      }
      const walkedIn = new Set((before.walkers ?? []).map(w => w.id));
      for (const w of after.walkers ?? []) {
        if (w.reason !== 'impatient' || walkedIn.has(w.id)) continue;
        if (w.trip[0].start < T1v - 1e-9) bad('set off before the hour they were decided at', w.id);
        const line = w.trip.find(l => l.kind === 'stay' && l.activity === 'wait' && (l as any).lane) as any;
        if (!line) continue;
        gaveUp++;
        if (Math.abs(line.end - line.start - patienceHours(w)) > 1e-9) bad('gave up after other than their patience', w.id);
        if (w.trip.some(l => l.kind === 'stay' && l.activity === 'check_in')) bad('gave up but checked in', w.id);
        const last = w.trip[w.trip.length - 1];
        if (last.kind !== 'walk' || !isEntranceTile(after, last.path[last.path.length - 1])) bad('gave up but did not walk out', w.id);
      }
      // Q: complaint trips go from the room to a clerk at a desk and back, awake all the way
      for (const g of after.guests) {
        if (g.tripKind !== 'complaint' || !g.trip || g.trip[0].start < T1v - 1e-9) continue;
        complaintTrips++;
        const room = after.rooms.find(r => r.guestId === g.id)!;
        const first = g.trip[0];
        const start = first.kind === 'walk' ? first.path[0] : first.at;
        if (start.gridX !== room.gridX || start.gridY !== room.gridY || start.floor !== room.floor) bad('complaint trip not from their room', g.id);
        const said = g.trip.filter(l => l.kind === 'stay' && l.activity === 'complain') as any[];
        if (said.length !== 1 || !checkInLanes(after).some(l => `${l.desk.id}:${l.seat}` === said[0].lane && l.front.gridX === said[0].at.gridX && l.front.gridY === said[0].at.gridY)) bad('complaint not at a clerk', g.id);
        for (let h = Math.floor(g.trip[0].start); h <= Math.floor(legsEnd(g.trip)); h++) if (isSleepHour(g, ((h % 24) + 24) % 24)) bad('complaining in their sleep hours', g.id);
      }
      // R: a complaint is heard only once they've got to the counter
      for (const e of r.events) {
        if (e.type !== 'guest_complained') continue;
        const g = after.guests.find(x => x.id === e.data?.guestId);
        if (!g?.complaint?.at || g.complaint.at >= T1v - 1e-9) bad('heard before they got to the desk', String(e.data?.guestId));
      }
      // S: money follows the visits: a guest's spending grows only when they've got to a shop or restaurant this
      // hour (never a thrifty guest), and the hotel's takings by exactly what its guests spent, those leaving included
      let spentNow = 0;
      for (const g of before.guests) {
        const now = after.guests.find(x => x.id === g.id);
        const left = now ? undefined : (after.walkers ?? []).find(w => w.guestId === g.id);
        const was = spentHere(g);
        const is = now ? spentHere(now) : left ? left.spent ?? 0 : was;
        if (is < was - 1e-9) bad('spending went down', g.id);
        if (is <= was + 1e-9) continue;
        charges++;
        spentNow += is - was;
        const reached = (g.trip ?? []).some(l => l.kind === 'stay' && l.activity === 'visit' && !l.credited && l.start < T1v
          && ['shop', 'restaurant'].includes(before.facilities.find(f => f.id === l.placeId)?.type ?? ''));
        if (!reached) bad('charged without a visit', g.id);
        if (spendingOf(g) === 'thrifty') bad('a thrifty guest charged', g.id);
      }
      // ... and everyone else who got to one this hour paid
      for (const g of before.guests) {
        if (spendingOf(g) === 'thrifty') continue;
        const paid = (g.trip ?? []).some(l => l.kind === 'stay' && l.activity === 'visit' && !l.credited && l.start < T1v
          && ['shop', 'restaurant'].includes(before.facilities.find(f => f.id === l.placeId)?.type ?? ''));
        if (!paid) continue;
        const now = after.guests.find(x => x.id === g.id);
        const left = now ? undefined : (after.walkers ?? []).find(w => w.guestId === g.id);
        if ((now ? spentHere(now) : left?.spent ?? 0) <= spentHere(g) + 1e-9) bad('went to the shop or restaurant and paid nothing', g.id);
      }
      const takings = (o?: OnSiteTakings) => (o?.shop ?? 0) + (o?.restaurant ?? 0);
      if (Math.abs(takings(after.onSite) - takings(before.onSite) - spentNow) > 1e-6) bad('takings differ from what guests spent', `${takings(after.onSite) - takings(before.onSite)} vs ${spentNow}`);
      // T: a thrifty guest never goes to the shop or the restaurant
      for (const g of after.guests) {
        if (spendingOf(g) !== 'thrifty' || !g.trip || g.trip[0].start < T1v - 1e-9) continue;
        if (g.tripKind === 'visit') thriftyTrips++;
        if (g.trip.some(l => l.kind === 'stay' && l.activity === 'visit' && ['shop', 'restaurant'].includes(after.facilities.find(f => f.id === l.placeId)?.type ?? ''))) bad('a thrifty guest at the shop or restaurant', g.id);
      }
      // U: a thrifty guest's dinner in town: set off in their evening (18:00-20:00 by their clock), at least an hour
      // out, back in their room by 22:00 by their clock, awake all the way, not on their last day or a night with friends round
      for (const g of after.guests) {
        if (spendingOf(g) !== 'thrifty' || g.tripKind !== 'outing' || !g.trip || g.trip[0].start < T1v - 1e-9) continue;
        const away = g.trip.find(l => l.kind === 'stay' && l.activity === 'away') as (Leg & { out?: string }) | undefined;
        if (!away || away.out !== 'dinner') continue;
        dinners++;
        const h = activityHour(g, after.hour);
        if (h < 18 || h >= 20) bad('dinner out of their evening', `${g.id} ${h}`);
        if (away.end - away.start < 1 - 1e-9) bad('dinner under an hour', g.id);
        if (legsEnd(g.trip) > (after.day - 1) * 24 + 22 + activityOffset(g) + 1e-9) bad('back from dinner late', g.id);
        for (let hh = Math.floor(g.trip[0].start); hh <= Math.floor(legsEnd(g.trip) - 1e-9); hh++) if (isSleepHour(g, ((hh % 24) + 24) % 24)) bad('out to dinner in their sleep hours', g.id);
        if (isCheckoutDay(g, after.day)) bad('dinner on their last day', g.id);
        if (hostsTonight(g, after.day)) bad('dinner on a night with friends round', g.id);
      }
      // W: spotlight guests. Nobody is booked into the suite held for one who'd still be in it on their day; the
      // guest walks in on their day, no earlier than their hour, and checks in (first in line) to a suite if one
      // was free; a travel writer leaving has tried every facility type the hotel had open all their stay
      const spot = before.spotlight;
      if (spot?.status === 'announced' && spot.roomId) {
        held++;
        for (const g of after.guests) {
          if (had.has(g.id) || g.spotlight) continue;
          if (after.rooms.find(x => x.guestId === g.id)?.id === spot.roomId && g.checkInDay + g.stayLength >= spot.arrivalDay) bad('booked into the held suite', g.id);
        }
      }
      for (const g of after.guests) {
        if (had.has(g.id) || !g.spotlight) continue;
        spotlights++;
        if (!spot || !g.id.startsWith(`spotlight-${spot.arrivalDay}`) || before.day !== spot.arrivalDay || !g.trip || g.trip[0].start < arrivalTime(spot) - 1e-9) bad('spotlight guest early or unplanned', g.id);
        if (!g.trip || g.trip[0].start < T1v - 1e-9 || g.tripKind !== 'arrival') bad('spotlight guest not walking in', g.id);
        const room = after.rooms.find(x => x.guestId === g.id)!;
        const free = getAvailableRooms(before);
        const freeSuite = free.some(x => profileRoom(x).type === 'suite' && fitsParty(profileRoom(x), partyOf(g)));
        if (freeSuite && profileRoom(room).type !== 'suite') bad('spotlight guest not given a free suite', g.id);
        // The held suite, ready, is theirs (and the story says so if not)
        if (spot?.roomId && free.some(x => x.id === spot.roomId) && room.id !== spot.roomId) bad('spotlight guest not in the held suite, though it was ready', g.id);
        if (spot?.roomId && room.id === spot.roomId) heldTaken++;
        if (after.spotlight?.status !== 'staying' || after.spotlight.guestId !== g.id) bad('spotlight guest checked in but the plan not staying', g.id);
      }
      for (const g of before.guests) {
        if (g.spotlight?.kind !== 'writer' || after.guests.some(x => x.id === g.id)) continue;
        writersLeft++;
        if (before.facilities.every(f => g.facilitiesUsed?.[f.type])) toured++;
      }
      // ... and a writer's visit while some facility type is still untried goes to an untried one, if one's open to them then
      // (the tour comes first; a visit to one they've tried is only when every untried one is shut, out of hours, or full)
      for (const g of after.guests) {
        if (g.spotlight?.kind !== 'writer' || g.tripKind !== 'visit' || !g.trip || g.trip[0].start < T1v - 1e-9) continue;
        const prev = before.guests.find(x => x.id === g.id);
        const stay = g.trip.find(l => l.kind === 'stay' && l.activity === 'visit') as { placeId?: string } | undefined;
        const type = after.facilities.find(f => f.id === stay?.placeId)?.type;
        if (type && prev?.facilitiesUsed?.[type]) {
          const untried = after.facilities.filter(f => !prev.facilitiesUsed?.[f.type] && visitChance(f.type, after.hour, after.day, g) > 0);
          if (untried.some(f => facilityLoad(after, f.id, T1v + 1) < facilityCapacity(f) - 1)) tourSkips++;
        }
      }
      // M: visitors walk in from the street, and are drawn in a room only while it's their host's and the host is in
      for (const w of after.walkers ?? []) {
        if (w.reason !== 'visitor') continue;
        const first = w.trip[0];
        if (first.start >= T1v - 1e-9) {
          visitorNights++;
          if (first.kind !== 'walk' || !isEntranceTile(after, first.path[0])) bad('visitors do not come in from the street', w.id);
        }
        for (const tt of [T1v + 0.05, T1v + 0.35, T1v + 0.65, T1v + 0.95]) {
          const at = positionAt(w.trip, tt);
          const leg = at?.leg;
          if (!at || !leg || leg.kind !== 'stay' || leg.activity !== 'in_room' || tt >= legsEnd(w.trip)) continue;
          const room = after.rooms.find(x => x.id === leg.placeId);
          const host = after.guests.find(g => g.id === w.hostId);
          if (!room || room.guestId !== w.hostId || !host || isGuestAway(host, tt)) bad('visitors in a room without their host', `${w.id} at ${tt}`);
          if (room && (Math.round(at.x) !== room.gridX || Math.round(at.y) !== room.gridY || at.floor !== room.floor)) bad('visitors drawn outside the room they are in', w.id);
        }
      }
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
          // (the same lift ride, carried over, changing floor at the very boundary: one ride, not a jump)
          const sameRide = endPos.leg.kind === 'walk' && startPos.leg.kind === 'walk' && endPos.leg.start === startPos.leg.start && endPos.leg.path.length === startPos.leg.path.length;
          const inLift = sameRide && Math.abs(endPos.x - startPos.x) < 1e-6 && Math.abs(endPos.y - startPos.y) < 1e-6 && after.elevators.some(e => e.gridX === Math.round(endPos.x) && e.gridY === Math.round(endPos.y));
          if (Math.abs(endPos.x - startPos.x) > 0.6 || Math.abs(endPos.y - startPos.y) > 0.6 || (endPos.floor !== startPos.floor && !inLift)) bad('staff jumps at the hour boundary', `${it.staffId} ${JSON.stringify([endPos.x, endPos.y, endPos.floor])} -> ${JSON.stringify([startPos.x, startPos.y, startPos.floor])}`);
        }
      }
      // E/G: guest trips
      const checkIns: Array<{ desk: string; a: number; b: number; front: string; lane?: string; who: string }> = [];
      for (const g of after.guests) {
        if (!g.trip) continue;
        if (!contiguous(g.trip)) bad('guest trip not contiguous', g.id);
        for (const l of g.trip) if (l.kind === 'stay' && (l.activity === 'check_in' || l.activity === 'complain')) checkIns.push({ desk: l.placeId!, a: l.start, b: l.end, front: `${l.at.gridX},${l.at.gridY}`, lane: l.lane, who: g.id });
        const room = after.rooms.find(x => x.guestId === g.id);
        const last = g.trip[g.trip.length - 1];
        const end = last.kind === 'walk' ? last.path[last.path.length - 1] : last.at;
        if (room && (end.gridX !== room.gridX || end.gridY !== room.gridY || end.floor !== room.floor)) bad('guest trip does not end in their room', g.id);
      }
      // K: everyone walks at their own pace (a slow walker slowly, a party with them)
      for (const g of after.guests) for (const l of g.trip ?? []) if (l.kind === 'walk' && Math.abs(l.hoursPerTile - guestPace(g)) > 1e-12) bad('guest walking at the wrong pace', g.id);
      for (const w of after.walkers ?? []) for (const l of w.trip) if (l.kind === 'walk' && Math.abs(l.hoursPerTile - guestPace(w)) > 1e-12) bad('walker walking at the wrong pace', w.id);
      // N: one clerk serves one person at a time (check-ins and complaints on a lane never overlap), and at
      // any moment a desk serves no more people than it has clerks seated (2 at most; the seats now, for
      // what's still to come)
      for (const c of checkIns) {
        if (c.lane && checkIns.some(d => d !== c && d.lane === c.lane && d.a < c.b - 1e-9 && c.a < d.b - 1e-9)) bad('two people at one clerk at once', `${c.lane} ${c.who}`);
        const at = c.a + 1e-6;
        const serving = checkIns.filter(d => d.desk === c.desk && d.a <= at && at < d.b).length;
        const seats = at >= T1v + 1e-9 ? checkInLanes(after).filter(l => l.desk.id === c.desk).length : 2;
        if (serving > Math.max(seats, at >= T1v + 1e-9 ? 0 : 2)) bad('more people served at a desk than clerks seated', `${c.desk} ${serving} > ${seats}`);
        if (c.lane && c.a >= T1v - 1e-9 && !checkInLanes(after).some(l => `${l.desk.id}:${l.seat}` === c.lane)) bad('served by a clerk who is not there', c.lane);
      }
      // F: capacity, counting parties by size -- the visits planned there, and the people drawn there
      for (const f of after.facilities) {
        for (const t of [T + 1.1, T + 1.4, T + 1.7, T + 1.95]) {
          const n = after.guests.filter(g => g.trip?.some(l => l.kind === 'stay' && l.placeId === f.id && l.start <= t && t < l.end))
            .reduce((sum, g) => sum + partyLoad(partyOf(g).size), 0);
          if (n > facilityCapacity(f) + 1e-9) bad('facility over capacity', f.id);
          const inside = after.guests.filter(g => g.trip && Array.from({ length: partyOf(g).size }, (_, m) => memberPositionAt(g.trip!, t, m))
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
              const at = memberPositionAt(p.legs, tt, m)!;
              if (Math.round(at.x) === room.gridX && Math.round(at.y) === room.gridY && at.floor === room.floor) bad('someone in a room while staff work it', `${p.id}#${m} in ${room.id} (${st.job}) at ${tt}`);
            }
          }
        }
      }
      s = after;
    }
    expect(visits).toBeGreaterThan(0); // the run got far enough for guests to be using facilities
  }
  } finally {
    SPOTLIGHT.weeklyChance = weekly;
  }
  if (process.env.ALIGNMENT_COUNTS === '1') process.stdout.write(`${JSON.stringify({ problems, examples, partyTrips, dndCleans, visitorNights, queued, gaveUp, complaintTrips, charges, dinners, thriftyTrips, held, spotlights, heldTaken, toured, writersLeft, tourSkips, preventiveRepairs, preventiveStarts, preventiveContinuations, preventiveCompleted })}\n`);
  expect(problems, JSON.stringify(examples)).toEqual({});
  expect(partyTrips).toBeGreaterThan(50); // parties of three or more came and went
  expect(dndCleans).toBeGreaterThan(20); // do-not-disturb rooms were cleaned (while their guests were out)
  expect(visitorNights).toBeGreaterThan(20); // rowdy guests had friends round
  expect(queued).toBeGreaterThan(20); // people waited their turn at the desk
  expect(gaveUp).toBeGreaterThan(0); // and some gave up
  expect(complaintTrips).toBeGreaterThan(3); // and some walked down to complain
  expect(charges).toBeGreaterThan(1500); // guests spent money at the shop and the restaurant
  expect(dinners).toBeGreaterThan(200); // thrifty guests ate in town
  expect(thriftyTrips).toBeGreaterThan(300); // (and went to the gym and pool)
  expect(held).toBeGreaterThan(24); // a suite was held for a spotlight guest
  expect(spotlights).toBeGreaterThan(3); // who came
  expect(heldTaken).toBeGreaterThan(2); // into the suite held for them
  expect(toured / writersLeft).toBeGreaterThan(0.6); // and travel writers tried everything (most: some found a facility full every hour)
  expect(tourSkips).toBe(0); // never passing over an untried facility with room
  expect(preventiveRepairs).toBeGreaterThan(10); // occupied-room maintenance ran across several real away windows
  expect(preventiveStarts).toBeGreaterThan(0);
  expect(preventiveContinuations).toBeGreaterThan(0);
  expect(preventiveCompleted).toBeGreaterThan(0);
}, 300000);
