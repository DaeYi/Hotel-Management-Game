import type { Fixture, HotelState, StaffMember, StaffItinerary, TilePos, Leg, WalkLeg, FatigueBreak } from './types.js';
import { DESK, TRAVEL } from '../config/balance.js';
import { STAFF_FATIGUE } from '../config/staff.js';
import { getAccessibleDesks, getAccessibleBreakRooms, getFixtureFront, findRoute, routeFromStreet, routeToStreet, isEntranceTile, isHallway } from './Layout.js';
import { hourStart, makeStay, makeWalk, finalTile, sameTile } from './Movement.js';
import { checkInHours, namedFrontDesk, staffDuty, staffDutyAt } from './StaffProfiles.js';
import { fatigueOn, fatigueAt, fatigueGain, projectFatigue, planStaffRest, restReservations, type RestReservation } from './StaffFatigue.js';
import { receptionSupports } from './CrossTraining.js';
import { cleaningSupports } from './ClerkCleaning.js';

export interface DeskDuty { staffId: string; from: number; to: number; checkInHours: number; startUntil?: number; serviceRate?: number }
export interface DeskLane { desk: Fixture; seat: number; front: TilePos; key: string; duties?: DeskDuty[] }

export function physicalDeskLanes(state: HotelState): DeskLane[] {
  return getAccessibleDesks(state).flatMap(desk => {
    const front = getFixtureFront(state, desk);
    return front ? Array.from({ length: DESK.staffPerDesk }, (_, seat) => ({ desk, seat, front, key: `${desk.id}:${seat}` })) : [];
  });
}

interface Assignment { member: StaffMember; lane: DeskLane; day: number; from: number; to: number }
const assignmentCache = new WeakMap<HotelState, Assignment[]>();
const laneCache = new WeakMap<HotelState, DeskLane[]>();

interface ClerkSchedule {
  assignment: Assignment;
  legs: Leg[];
  duties: DeskDuty[];
  breaks: Array<{ from: number; break: FatigueBreak }>;
}
const fatigueCache = new WeakMap<HotelState, { schedules: ClerkSchedule[]; reservations: RestReservation[] }>();

/** One shared schedule supplies both the visible clerk and the queue's promises. */
function fatigueSchedules(state: HotelState): { schedules: ClerkSchedule[]; reservations: RestReservation[] } {
  const cached = fatigueCache.get(state);
  if (cached) return cached;
  const laneKeys = new Set(physicalDeskLanes(state).map(lane => lane.key));
  const breakRooms = new Map(getAccessibleBreakRooms(state).map(room => [room.id, room]));
  const T = hourStart(state), reservations = restReservations(state).filter(r => breakRooms.has(r.placeId)), schedules: ClerkSchedule[] = [];
  for (const a of [...assignments(state)].sort((x, y) => x.from - y.from || x.member.id.localeCompare(y.member.id))) {
    const member = a.member, duty = staffDuty(member, a.day);
    const current = duty.start < T + 1 && duty.end > T;
    if (!current) {
      const origin = Math.max(T, member.stats?.fatigueAt ?? T);
      const offDutyFrom = Math.max(origin, staffDutyAt(member, origin).end);
      const street = routeFromStreet(state, a.lane.front, TRAVEL.hoursPerTile);
      const gain = fatigueGain(member), arrivalFatigue = (street?.hours ?? Infinity) * gain;
      // Four continuous off-duty hours recover even maximum fatigue. Most
      // later eight-hour shifts cannot reach a compulsory break, so their
      // exact speed windows need neither itinerary allocation nor rest-seat
      // simulation. Near/current shifts and possible breaks use the full plan.
      if (street && a.from - street.hours >= offDutyFrom + 100 / STAFF_FATIGUE.offDutyRecovery - 1e-9
        && arrivalFatigue + Math.max(0, a.to - a.from) * gain < STAFF_FATIGUE.breakAt - 1e-9) {
        const crossing = gain > 0 ? a.from + (STAFF_FATIGUE.tiredAt - arrivalFatigue) / gain : Infinity;
        const duties: DeskDuty[] = crossing > a.from + 1e-9 && crossing < a.to - 1e-9
          ? [{ staffId: member.id, from: a.from, startUntil: crossing, to: a.to, checkInHours: checkInHours(member), serviceRate: 1 },
            { staffId: member.id, from: crossing, to: a.to, checkInHours: checkInHours(member) / STAFF_FATIGUE.tiredRate, serviceRate: STAFF_FATIGUE.tiredRate }]
          : [{ staffId: member.id, from: a.from, to: a.to, checkInHours: checkInHours(member) / (arrivalFatigue >= STAFF_FATIGUE.tiredAt ? STAFF_FATIGUE.tiredRate : 1),
            serviceRate: arrivalFatigue >= STAFF_FATIGUE.tiredAt ? STAFF_FATIGUE.tiredRate : 1 }];
        schedules.push({ assignment: a, legs: [], duties, breaks: [] });
        continue;
      }
    }
    let t = current ? Math.max(T, member.stats?.fatigueAt ?? T) : T;
    let pos = current ? member.at : null;
    let fatigue = fatigueAt(state, member, t);
    const legs: Leg[] = [], duties: DeskDuty[] = [], breaks: ClerkSchedule['breaks'] = [];
    const append = (next: Leg[]) => {
      if (!next.length) return;
      const until = next[next.length - 1].end;
      fatigue = projectFatigue(member, next, t, until, fatigue);
      legs.push(...next); t = until; pos = finalTile(next);
    };
    const walk = (route: ReturnType<typeof findRoute>) => {
      if (route?.path.length && route.path.length > 1) append([makeWalk(route.path, t, TRAVEL.hoursPerTile)]);
      else if (route) pos = route.path[0];
    };
    // A saved/current hourly plan is authoritative for what really happens
    // now. Future coverage is projected from where that exact plan leaves
    // the clerk, including a rest or walk carried beyond the boundary.
    const saved = current && (member.stats?.fatigueAt ?? T) <= T && state.staffPlan?.start === T
      ? state.staffPlan.itineraries.find(it => it.staffId === member.id) : undefined;
    // A later hire may now yield to a committed helper or take another seat.
    // Replay a saved counter stay only while it still belongs to this assignment.
    // A stay at a since-demolished desk is only history.
    const existing = saved?.legs.some(l => l.kind === 'stay' && l.activity === 'desk' && l.end > T
      && !!l.lane && laneKeys.has(l.lane)
      && (l.lane !== a.lane.key || l.start < a.from - 1e-9)) ? undefined : saved;
    if (existing) {
      for (const leg of existing.legs.filter(l => l.end > T && l.start < T + 1)) {
        const next = leg.kind === 'stay' ? { ...leg, start: Math.max(T, leg.start), end: Math.min(T + 1, leg.end) } : leg;
        if (next.kind === 'stay' && next.activity === 'desk' && next.lane === a.lane.key) {
          const rate = fatigue >= STAFF_FATIGUE.tiredAt - 1e-9 ? STAFF_FATIGUE.tiredRate : 1;
          duties.push({ staffId: member.id, from: next.start, to: next.end, checkInHours: checkInHours(member) / rate, serviceRate: rate });
        }
        if (next.kind === 'stay' && next.activity === 'rest') {
          const fixed = existing.end.fatigueBreak;
          const rest = fixed && sameTile(fixed.at, next.at) && fixed.end >= next.end ? fixed
            : { at: next.at, start: next.start, end: next.end, ...(next.placeId ? { placeId: next.placeId } : {}) };
          breaks.push({ from: next.start, break: rest });
          if (rest.placeId && breakRooms.has(rest.placeId) && !reservations.some(r => r.staffId === member.id && r.placeId === rest.placeId && r.start === rest.start))
            reservations.push({ staffId: member.id, placeId: rest.placeId, start: rest.start, end: rest.end });
        }
        append([next]);
      }
    } else if (current && member.carry && member.carry.end > t) append([member.carry]);
    const candidateBreak = existing?.end.fatigueBreak ?? member.fatigueBreak;
    const pending = current && candidateBreak && candidateBreak.end > t ? candidateBreak : undefined;
    if (pending && pos) {
      const room = pending.placeId ? breakRooms.get(pending.placeId) : undefined;
      const valid = pending.placeId ? !!room && sameTile(room, pending.at)
        : isHallway(state, pending.at.gridX, pending.at.gridY, pending.at.floor);
      const route = valid ? findRoute(state, pos, pending.at, TRAVEL.hoursPerTile) : null;
      if (!route) {
        // Preserve recovery already earned, but a removed/cut-off room can
        // no longer supply fast recovery for the rest of a saved break.
        const started = t;
        const rest = planStaffRest(state, member, pos, t, reservations, Math.max(0, pending.end - Math.max(t, pending.start)), pending.end);
        append(rest.legs); breaks.push({ from: started, break: rest.reservation });
      } else {
        const started = t;
        walk(route);
        if (t < pending.start) append([makeStay(pos!, t, pending.start, 'wait')]);
        if (t < pending.end) append([makeStay(pos!, t, pending.end, 'rest', {
          restRate: pending.placeId ? STAFF_FATIGUE.roomRecovery : STAFF_FATIGUE.fallbackRecovery,
          ...(pending.placeId ? { placeId: pending.placeId } : {}),
        })]);
        const breakFrom = Math.min(started, ...legs.filter(l => l.kind === 'walk' && sameTile(l.path.at(-1), pending.at)).map(l => l.start));
        breaks.push({ from: breakFrom, break: pending });
      }
    }
    const toDesk = pos ? findRoute(state, pos, a.lane.front, TRAVEL.hoursPerTile) : routeFromStreet(state, a.lane.front, TRAVEL.hoursPerTile);
    if (!toDesk) continue;
    const setOff = Math.max(t, a.from - toDesk.hours);
    if (setOff > t) {
      if (pos) append([makeStay(pos, t, setOff, 'wait')]);
      else { fatigue = projectFatigue(member, [], t, setOff, fatigue); t = setOff; }
    }
    walk(toDesk);
    if (t < a.from) append([makeStay(a.lane.front, t, a.from, 'wait')]);
    // Only service already underway is protected. Queued service is rebooked
    // around a break, so nobody is promised a clerk who has walked away.
    const underway = state.guests.flatMap(g => (g.trip ?? []).filter(l => l.kind === 'stay'
      && (l.activity === 'check_in' || l.activity === 'complain') && l.serviceStaffId === member.id
      && l.start < Math.max(T, member.stats?.fatigueAt ?? T) - 1e-9 && l.end > t));
    const gain = fatigueGain(member);
    let guard = 0;
    while (t < a.to - 1e-9 && guard++ < 100) {
      if (fatigue >= STAFF_FATIGUE.breakAt - 1e-9) {
        const protectedUntil = Math.max(t, ...underway.filter(l => l.start <= t + 1e-9).map(l => l.end));
        if (protectedUntil > t + 1e-9) {
          const until = Math.min(a.to, protectedUntil);
          duties.push({ staffId: member.id, from: t, to: until, checkInHours: checkInHours(member) / STAFF_FATIGUE.tiredRate, serviceRate: STAFF_FATIGUE.tiredRate });
          append([makeStay(a.lane.front, t, until, 'desk', { placeId: a.lane.desk.id, lane: a.lane.key })]);
          continue;
        }
        const started = t;
        const rest = planStaffRest(state, member, pos!, t, reservations);
        append(rest.legs); breaks.push({ from: started, break: rest.reservation });
        walk(findRoute(state, pos!, a.lane.front, TRAVEL.hoursPerTile));
        continue;
      }
      const rate = fatigue >= STAFF_FATIGUE.tiredAt - 1e-9 ? STAFF_FATIGUE.tiredRate : 1;
      const threshold = rate === 1 ? STAFF_FATIGUE.tiredAt : STAFF_FATIGUE.breakAt;
      let until = Math.min(a.to, gain > 0 ? t + (threshold - fatigue) / gain : a.to);
      if (threshold === STAFF_FATIGUE.breakAt) until = Math.min(a.to, Math.max(until, ...underway.filter(l => l.start <= until + 1e-9).map(l => l.end)));
      const from = t;
      append([makeStay(a.lane.front, from, until, 'desk', { placeId: a.lane.desk.id, lane: a.lane.key })]);
      duties.push({ staffId: member.id, from, to: until, checkInHours: checkInHours(member) / rate, serviceRate: rate });
    }
    // A speed threshold changes service beginning afterwards, not a service
    // already quoted. Only breaks and shift ends are hard service deadlines.
    for (let i = 0; i < duties.length; i++) {
      let j = i;
      while (j + 1 < duties.length && Math.abs(duties[j].to - duties[j + 1].from) < 1e-9) j++;
      const startUntil = duties[i].to;
      duties[i] = { ...duties[i], to: duties[j].to, ...(j > i ? { startUntil } : {}) };
    }
    schedules.push({ assignment: a, legs, duties, breaks });
  }
  const result = { schedules, reservations }; fatigueCache.set(state, result); return result;
}

export function scheduledDeskBreaks(state: HotelState): RestReservation[] {
  return fatigueOn() ? fatigueSchedules(state).reservations : [];
}

/** Assign seats per shift, keeping an employee's seat when possible. Spare clerks cover absences. */
function assignments(state: HotelState): Assignment[] {
  const cached = assignmentCache.get(state);
  if (cached) return cached;
  const lanes = physicalDeskLanes(state), result: Assignment[] = [];
  const supports = receptionSupports(state);
  const cleaning = cleaningSupports(state);
  const T = hourStart(state);
  const nativeSeats = new Map<string, { lane: string; desk: Leg[] }>();
  if ((supports.length || cleaning.length) && state.staffPlan?.start === T) {
    const away: Array<[string, { lane: string; desk: Leg[] }]> = [];
    for (const member of state.staffRoster ?? []) {
      if (member.role !== 'front_desk' || member.leaving) continue;
      const now = Math.max(T, member.stats?.fatigueAt ?? T);
      // A demolished desk no longer holds a seat.
      const desk = state.staffPlan.itineraries.find(it => it.staffId === member.id)?.legs.filter(l =>
        l.kind === 'stay' && l.activity === 'desk' && l.end > now + 1e-9 && l.start < T + 1
        && lanes.some(lane => lane.key === l.lane)) ?? [];
      const first = desk[0];
      if (first?.kind === 'stay' && first.lane) nativeSeats.set(member.id, { lane: first.lane, desk });
      else {
        const duty = staffDutyAt(member, now);
        const returning = cleaning.find(c => c.member.id === member.id && c.support.to > now);
        if (returning && !duty.absent && duty.end > now + 1e-9 && lanes.some(lane => lane.key === returning.support.lane))
          away.push([member.id, { lane: returning.support.lane, desk }]);
      }
    }
    // Only an on-duty clerk still away on a room visit holds their seat, and
    // never against a clerk whose own plan sits there this hour.
    for (const [id, seat] of away) if (![...nativeSeats.values()].some(other => other.lane === seat.lane)) nativeSeats.set(id, seat);
  }
  const groups = (['early', 'late', 'night'] as const).map(shift => (state.staffRoster ?? [])
    .filter(m => m.role === 'front_desk' && (m.shift ?? 'late') === shift && !m.leaving)
    .sort((a, b) => Number(!a.deskLane) - Number(!b.deskLane) || (a.serial ?? 0) - (b.serial ?? 0)));
  for (let day = state.day - 1; day <= state.day + 3; day++) {
    for (const people of groups) {
      const free = new Set(lanes.map(l => l.key));
      const groupDuty = people[0] && staffDuty(people[0], day);
      const current = groupDuty && groupDuty.start < T + 1 && groupDuty.end > T;
      const reserved = current ? new Map([...nativeSeats].map(([id, seat]) => [seat.lane, id])) : new Map<string, string>();
      // Keep the native staff already in the physical plan ahead of newly
      // hired or returning clerks, even when their boundary deskLane is empty.
      const ordered = current && nativeSeats.size ? [...people].sort((a, b) => Number(nativeSeats.has(b.id)) - Number(nativeSeats.has(a.id))) : people;
      for (const member of ordered) {
        const duty = staffDuty(member, day);
        if (duty.absent || duty.available >= duty.end || duty.end <= T) continue;
        const now = Math.max(T, member.stats?.fatigueAt ?? T);
        // Nor does a check-in cut short when its desk was demolished.
        const serving = supports.length && duty.start <= now && duty.end > now ? state.guests.flatMap(g => g.trip ?? []).find(l => l.kind === 'stay'
          && (l.activity === 'check_in' || l.activity === 'complain') && l.serviceStaffId === member.id
          && l.start < now - 1e-9 && l.end > now && lanes.some(lane => lane.key === l.lane)) : undefined;
        const servingLane = serving?.kind === 'stay' ? serving.lane : undefined;
        const planned = current ? nativeSeats.get(member.id) : undefined;
        const fixedLane = servingLane ?? planned?.lane;
        const candidates = lanes.filter(l => free.has(l.key) && (!fixedLane || l.key === fixedLane)
          && (!reserved.has(l.key) || reserved.get(l.key) === member.id))
          .sort((a, b) => Number(b.key === member.deskLane) - Number(a.key === member.deskLane));
        let selected: { lane: DeskLane; ready: number; delayed: boolean } | undefined;
        for (const lane of candidates) {
          const street = routeFromStreet(state, lane.front);
          if (!street) continue;
          let ready = duty.available;
          if (duty.start < T + 1 - 1e-9 && duty.end > T) {
            const itinerary = state.staffPlan?.start === T ? state.staffPlan.itineraries.find(it => it.staffId === member.id) : undefined;
            const alreadySeated = itinerary?.legs.find(l => l.kind === 'stay' && l.activity === 'desk' && l.placeId === lane.desk.id && l.end > T);
            if (alreadySeated) ready = Math.max(ready, alreadySeated.start);
            else if (member.at || member.carry) {
              const at = member.carry?.path.at(-1) ?? member.at!;
              const route = findRoute(state, at, lane.front);
              if (!route) continue;
              ready = Math.max(ready, member.carry?.end ?? T) + route.hours;
            } else {
              // On-time commuters arrive for the start; late workers and new hires walk in after they are due.
              ready = Math.max(T, duty.available) + street.hours;
            }
          } else if (duty.available > duty.start + 1e-9) ready += street.hours;
          // A helper can occupy this native clerk's actual break gap. That
          // does not move either clerk or invalidate their authoritative plan.
          const keepsPlan = planned?.lane === lane.key && !planned.desk.some(l => supports.some(({ support }) =>
            support.lane === lane.key && l.start < support.to - 1e-9 && l.end > support.from + 1e-9));
          const blockedUntil = servingLane === lane.key || keepsPlan ? ready : Math.max(ready, ...supports.filter(({ support }) =>
            support.lane === lane.key && support.to > Math.max(T, ready) + 1e-9 && support.from < duty.end - 1e-9).map(({ support }) => support.to));
          if (blockedUntil >= duty.end - 1e-9) continue;
          const candidate = { lane, ready: blockedUntil, delayed: blockedUntil > ready + 1e-9 };
          if (!selected || selected.delayed && (!candidate.delayed || candidate.ready < selected.ready - 1e-9)) selected = candidate;
          if (!candidate.delayed) break;
        }
        if (!selected) continue;
        const { lane, ready } = selected;
        free.delete(lane.key);
        result.push({ member, lane, day, from: ready, to: duty.end });
      }
    }
  }
  assignmentCache.set(state, result);
  return result;
}

/** Future coverage is part of the queue: a closed shift cannot promise immediate service. */
export function scheduledDeskLanes(state: HotelState): DeskLane[] {
  const cached = laneCache.get(state);
  if (cached) return cached;
  const all = assignments(state);
  const supports = receptionSupports(state);
  const cleaning = cleaningSupports(state);
  // Without fatigue nothing replays this hour's plan. A clerk it ends with
  // still walking to this desk (sent there mid-hour, say when their own desk
  // was demolished) opens the lane only when they arrive.
  const T = hourStart(state);
  const arrival = (a: Assignment) => {
    const legs = (state.staffPlan?.start === T ? state.staffPlan.itineraries.find(it => it.staffId === a.member.id)?.legs : undefined) ?? [];
    const last = legs.at(-1);
    return last?.kind === 'walk' && last.end > a.from + 1e-9 && sameTile(last.path.at(-1), a.lane.front)
      && !legs.some(l => l.kind === 'stay' && l.activity === 'desk' && l.placeId === a.lane.desk.id && l.end > T) ? last.end : a.from;
  };
  const lanes = physicalDeskLanes(state).map(lane => ({ ...lane, duties: [...(fatigueOn()
    ? fatigueSchedules(state).schedules.filter(s => s.assignment.lane.key === lane.key).flatMap(s => s.duties).sort((a, b) => a.from - b.from)
    : all.filter(a => a.lane.key === lane.key).map(a => ({ staffId: a.member.id, from: arrival(a), to: a.to, checkInHours: checkInHours(a.member) }))),
    ...supports.filter(({ support }) => support.lane === lane.key).flatMap(({ member, support }): DeskDuty[] => {
      const tired = fatigueOn() ? support.tiredFrom : undefined;
      const hours = checkInHours(member), base = { staffId: member.id, from: support.from, to: support.to };
      if (tired === undefined || tired >= support.to - 1e-9) return [{ ...base, checkInHours: hours, serviceRate: 1 }];
      if (tired <= support.from + 1e-9) return [{ ...base, checkInHours: hours / STAFF_FATIGUE.tiredRate, serviceRate: STAFF_FATIGUE.tiredRate }];
      return [{ ...base, startUntil: tired, checkInHours: hours, serviceRate: 1 },
        { ...base, from: tired, checkInHours: hours / STAFF_FATIGUE.tiredRate, serviceRate: STAFF_FATIGUE.tiredRate }];
    })].flatMap((duty: DeskDuty) => {
      // Both walks and the room stay close the lane. A service beginning
      // before departure must also finish before the clerk leaves.
      let pieces = [duty];
      for (const { member, support } of cleaning) {
        if (member.id !== duty.staffId) continue;
        pieces = pieces.flatMap(part => {
          if (support.to <= part.from || support.from >= part.to) return [part];
          const kept: DeskDuty[] = [];
          if (part.from < support.from) kept.push({ ...part, to: support.from,
            ...(part.startUntil !== undefined ? { startUntil: Math.min(part.startUntil, support.from) } : {}) });
          if (part.to > support.to && (part.startUntil ?? part.to) > support.to) kept.push({ ...part, from: support.to });
          return kept;
        });
      }
      return pieces;
    }).sort((a, b) => a.from - b.from) }));
  laneCache.set(state, lanes);
  return lanes;
}

export function deskCoverage(state: HotelState, t = hourStart(state)): DeskDuty[] {
  if (!namedFrontDesk(state)) return [];
  return scheduledDeskLanes(state).flatMap(l => l.duties!.filter(d => d.from <= t + 1e-9 && (d.startUntil ?? d.to) > t + 1e-9));
}

/** The clerk follows the same commute that determines when their lane opens. */
export function planDeskClerk(state: HotelState, member: StaffMember, from: number, reservations?: RestReservation[]): StaffItinerary {
  if (fatigueOn() && !member.leaving) {
    const end = hourStart(state) + 1;
    const alreadyLive = (state.staffRoster ?? []).filter(m => m.role === 'front_desk').every(m => (m.stats?.fatigueAt ?? -Infinity) >= from);
    const liveState = from > hourStart(state) + 1e-9 && !alreadyLive ? { ...state, staffRoster: (state.staffRoster ?? []).map(m => ({ ...m,
      stats: { workHours: m.stats?.workHours ?? 80, lateDays: m.stats?.lateDays ?? 0, absentDays: m.stats?.absentDays ?? 0, ...m.stats,
        fatigue: fatigueAt(state, m, from), fatigueAt: from } })) } : state;
    const scheduled = fatigueSchedules(liveState);
    const schedule = scheduled.schedules.find(s => s.assignment.member.id === member.id && s.legs.some(l => l.end > from && l.start < end));
    if (schedule) {
      const legs = schedule.legs.filter(l => l.end > from && l.start < end).map(l => l.kind === 'stay' ? { ...l, start: Math.max(from, l.start), end: Math.min(end, l.end) } : l);
      for (const reservation of scheduled.reservations.filter(r => r.staffId === member.id)) {
        if (!reservations?.some(r => r.staffId === reservation.staffId && r.placeId === reservation.placeId && r.start === reservation.start)) reservations?.push(reservation);
      }
      const last = legs.at(-1), carry = last?.kind === 'walk' && last.end > end ? last : undefined;
      const pending = schedule.breaks.find(b => b.from < end - 1e-9 && b.break.end > end + 1e-9)?.break;
      const seated = last?.kind === 'stay' && last.activity === 'desk';
      return { staffId: member.id, legs, end: { at: finalTile(legs), carry, deskLane: seated ? schedule.assignment.lane.key : undefined, fatigueBreak: pending } };
    }
  }
  return legacyDeskClerk(state, member, from);
}

function legacyDeskClerk(state: HotelState, member: StaffMember, from: number): StaffItinerary {
  const end = hourStart(state) + 1, legs: Leg[] = [];
  let t = from, pos = member.at, deskLane: string | undefined;
  if (member.carry && member.carry.end > from) {
    legs.push(member.carry); t = member.carry.end; pos = member.carry.path.at(-1)!;
  }
  const walk = (route: ReturnType<typeof findRoute>) => {
    if (!route) return;
    if (route.path.length > 1) { const leg = makeWalk(route.path, t, TRAVEL.hoursPerTile); legs.push(leg); t = leg.end; }
    pos = route.path.at(-1)!;
  };
  const a = !member.leaving ? assignments(state).find(a => a.member.id === member.id && a.to > from && staffDuty(member, a.day).start <= end) : undefined;
  const duty = a ? staffDuty(member, a.day) : staffDutyAt(member, from);
  if (a && duty.start < end + 1e-9) {
    const route = pos ? findRoute(state, pos, a.lane.front) : routeFromStreet(state, a.lane.front);
    if (route) {
      const setOff = pos ? Math.max(t, duty.available, a.from - route.hours) : Math.max(t, a.from - route.hours);
      if (setOff < end) {
        if (pos && setOff > t) legs.push(makeStay(pos, t, setOff, 'wait'));
        t = setOff; walk(route); deskLane = a.lane.key;
        if (t < end && t < a.to) legs.push(makeStay(a.lane.front, t, Math.min(end, a.to), 'desk', { placeId: a.lane.desk.id, lane: a.lane.key }));
      }
    }
  } else if (pos && t < end) {
    walk(routeToStreet(state, pos));
    if (pos && isEntranceTile(state, pos) && t <= end) pos = null;
  }
  const last = legs.at(-1);
  const carry = last?.kind === 'walk' && last.end > end ? last as WalkLeg : undefined;
  return { staffId: member.id, legs, end: { at: pos, carry, deskLane } };
}
