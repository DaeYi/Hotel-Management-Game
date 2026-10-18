import type { Fixture, HotelState, StaffMember, StaffItinerary, TilePos, Leg, WalkLeg } from './types.js';
import { DESK, TRAVEL } from '../config/balance.js';
import { getAccessibleDesks, getFixtureFront, findRoute, routeFromStreet, routeToStreet, isEntranceTile } from './Layout.js';
import { hourStart, makeStay, makeWalk } from './Movement.js';
import { checkInHours, namedFrontDesk, staffDuty, staffDutyAt } from './StaffProfiles.js';

export interface DeskDuty { staffId: string; from: number; to: number; checkInHours: number }
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

/** Assign seats per shift, keeping an employee's seat when possible. Spare clerks cover absences. */
function assignments(state: HotelState): Assignment[] {
  const cached = assignmentCache.get(state);
  if (cached) return cached;
  const lanes = physicalDeskLanes(state), result: Assignment[] = [];
  const T = hourStart(state);
  const groups = (['early', 'late', 'night'] as const).map(shift => (state.staffRoster ?? [])
    .filter(m => m.role === 'front_desk' && (m.shift ?? 'late') === shift && !m.leaving)
    .sort((a, b) => Number(!a.deskLane) - Number(!b.deskLane) || (a.serial ?? 0) - (b.serial ?? 0)));
  for (let day = state.day - 1; day <= state.day + 3; day++) {
    for (const people of groups) {
      const free = new Set(lanes.map(l => l.key));
      for (const member of people) {
        const duty = staffDuty(member, day);
        if (duty.absent || duty.available >= duty.end || duty.end <= T) continue;
        const lane = lanes.find(l => l.key === member.deskLane && free.has(l.key)) ?? lanes.find(l => free.has(l.key));
        if (!lane) continue;
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
  const lanes = physicalDeskLanes(state).map(lane => ({ ...lane, duties: all.filter(a => a.lane.key === lane.key)
    .map(a => ({ staffId: a.member.id, from: a.from, to: a.to, checkInHours: checkInHours(a.member) })).sort((a, b) => a.from - b.from) }));
  laneCache.set(state, lanes);
  return lanes;
}

export function deskCoverage(state: HotelState, t = hourStart(state)): DeskDuty[] {
  if (!namedFrontDesk(state)) return [];
  return scheduledDeskLanes(state).flatMap(l => l.duties!.filter(d => d.from <= t + 1e-9 && d.to > t + 1e-9));
}

/** The clerk follows the same commute that determines when their lane opens. */
export function planDeskClerk(state: HotelState, member: StaffMember, from: number): StaffItinerary {
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
      const setOff = pos ? Math.max(t, duty.available) : Math.max(t, a.from - route.hours);
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
