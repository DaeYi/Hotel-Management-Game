import type { HotelState, StaffMember, Leg, TilePos, FatigueBreak } from './types.js';
import type { StaffIdentity, Stamina } from './StaffProfiles.js';
import { staffDuty, staffDutyAt } from './StaffProfiles.js';
import { STAFF_FATIGUE as RULES, STAFF_PERSONALITIES } from '../config/staff.js';
import { BREAK_ROOM, TRAVEL } from '../config/balance.js';
import { getAccessibleBreakRooms, getStaffBases, findRoute, doorTile, getFixtureFront } from './Layout.js';
import { hourStart, makeStay, makeWalk, sameTile } from './Movement.js';

export interface RestReservation { staffId: string; placeId: string; start: number; end: number }
export const fatigueOn = () => STAFF_PERSONALITIES.enabled && RULES.enabled;
export const staminaOf = (member: StaffIdentity): Stamina => fatigueOn() ? member.profile?.stamina ?? 'normal' : 'normal';
const clamp = (n: number) => Math.max(0, Math.min(100, n));
export const fatigueOf = (member: StaffIdentity): number => fatigueOn() ? clamp(member.stats?.fatigue ?? 0) : 0;
export const fatigueGain = (member: StaffIdentity): number => fatigueOn() ? RULES.gain[staminaOf(member)] : 0;
export const fatigueRate = (member: StaffIdentity): number => fatigueOf(member) >= RULES.tiredAt ? RULES.tiredRate : 1;

function offDutyHours(member: StaffMember, from: number, to: number): number {
  let on = 0;
  const last = staffDutyAt(member, to).day;
  for (let day = staffDutyAt(member, from).day; day <= last; day++) {
    const duty = staffDuty(member, day);
    if (!duty.absent) on += Math.max(0, Math.min(to, duty.end) - Math.max(from, duty.available));
  }
  return Math.max(0, to - from - on);
}

/** Project once over clipped actual legs. Unrepresented off-duty time recovers; waiting on duty does not. */
export function projectFatigue(member: StaffMember, legs: readonly Leg[], from: number, to: number, initial = fatigueOf(member)): number {
  if (!fatigueOn()) return 0;
  let value = initial, cursor = from;
  const gap = (end: number) => { if (end > cursor && value > 0) value = clamp(value - offDutyHours(member, cursor, end) * RULES.offDutyRecovery); };
  for (const leg of legs) {
    const start = Math.max(from, cursor, leg.start), end = Math.min(to, leg.end);
    if (end <= start) continue;
    gap(start);
    const change = leg.kind === 'walk' || leg.activity === 'clean' || leg.activity === 'repair' || leg.activity === 'desk'
      ? fatigueGain(member) : leg.activity === 'rest' ? -(leg.restRate ?? RULES.fallbackRecovery) : 0;
    value = clamp(value + (end - start) * change);
    cursor = end;
    if (cursor >= to) break;
  }
  gap(to);
  return value;
}

/** Live fatigue, without committing it during paused edits or counting the preserved past twice. */
export function fatigueAt(state: HotelState, member: StaffMember, t: number): number {
  if (!fatigueOn()) return 0;
  const from = member.stats?.fatigueAt ?? hourStart(state);
  if (t <= from) return fatigueOf(member);
  const plan = state.staffPlan;
  const legs = plan?.itineraries.find(it => it.staffId === member.id)?.legs ?? [];
  return projectFatigue(member, legs, from, t);
}

export function restReservations(state: HotelState, roster = state.staffRoster ?? [], from = hourStart(state)): RestReservation[] {
  const reservations: RestReservation[] = [];
  for (const member of roster) {
    const b = member.fatigueBreak;
    if (b?.placeId && b.end > from) reservations.push({ staffId: member.id, placeId: b.placeId, start: b.start, end: b.end });
  }
  // The current physical plan also owns rests beginning later this hour;
  // their reservations need not be on the member's boundary state yet.
  for (const it of state.staffPlan?.itineraries ?? []) for (const leg of it.legs) {
    if (leg.kind !== 'stay' || leg.activity !== 'rest' || !leg.placeId || leg.end <= from) continue;
    const existing = reservations.find(r => r.staffId === it.staffId && r.placeId === leg.placeId && r.start <= leg.end && r.end >= leg.start);
    if (existing) { existing.start = Math.min(existing.start, leg.start); existing.end = Math.max(existing.end, leg.end); }
    else reservations.push({ staffId: it.staffId, placeId: leg.placeId, start: leg.start, end: leg.end });
  }
  return reservations;
}

function seatFree(reservations: RestReservation[], id: string, memberId: string, from: number, to: number): boolean {
  const overlaps = reservations.filter(r => r.placeId === id && r.staffId !== memberId && r.start < to - 1e-9 && r.end > from + 1e-9);
  const points = [from, ...overlaps.map(r => Math.max(from, r.start))];
  return points.every(t => new Set(overlaps.filter(r => r.start <= t + 1e-9 && r.end > t + 1e-9).map(r => r.staffId)).size < BREAK_ROOM.seats);
}

/** Pick the nearest seat that is free for the whole rest, or a reachable slower-rest fallback. */
export function planStaffRest(state: HotelState, member: StaffMember, at: TilePos, from: number, reservations: RestReservation[], duration = RULES.breakHours, deadline = Infinity, idle = false): { legs: Leg[]; at: TilePos; until: number; reservation: FatigueBreak } {
  const rooms = getAccessibleBreakRooms(state).map(room => {
    const route = findRoute(state, at, room, TRAVEL.hoursPerTile);
    return { room, route, arrival: from + (route?.hours ?? Infinity) };
  }).filter(o => o.route && seatFree(reservations, o.room.id, member.id, o.arrival, Math.min(o.arrival + duration, deadline)))
    .sort((a, b) => a.arrival - b.arrival || a.room.id.localeCompare(b.room.id));
  const occupiedRoom = state.rooms.find(r => sameTile(r, at));
  const fixture = state.fixtures.find(f => f.type === 'breakroom' && sameTile(f, at));
  const outside = occupiedRoom ? doorTile(occupiedRoom, occupiedRoom.door) : fixture ? getFixtureFront(state, fixture) : null;
  const bases = getStaffBases(state).filter(base => !state.fixtures.some(f => f.type === 'breakroom' && sameTile(f, base)));
  const fallback = [...(outside ? [outside] : []), ...bases].map(base => ({ base, route: findRoute(state, at, base, TRAVEL.hoursPerTile) }))
    .filter(o => o.route).sort((a, b) => a.route!.hours - b.route!.hours)[0];
  type RoomOption = (typeof rooms)[number];
  let selected: RoomOption | undefined = rooms[0];
  if (idle && selected && fallback && Number.isFinite(deadline)) {
    const recovered = (route: NonNullable<RoomOption['route']>, target: TilePos, recovery: number) => {
      const walk = route.path.length > 1 ? [makeWalk(route.path, from, TRAVEL.hoursPerTile)] : [];
      const arrival = walk.at(-1)?.end ?? from;
      const legs = arrival < deadline ? [...walk, makeStay(target, arrival, deadline, 'rest', { restRate: recovery })] : walk;
      return projectFatigue(member, legs, from, deadline);
    };
    const roomFatigue = recovered(selected.route!, selected.room, RULES.roomRecovery);
    const nearbyFatigue = recovered(fallback.route!, fallback.base, RULES.fallbackRecovery);
    // A fresh worker gains nothing by walking down several floors to rest.
    // During spare time choose the most recovery by the next planning point,
    // then the shortest walk; a compulsory break still takes a real room.
    if (nearbyFatigue < roomFatigue - 1e-9 || Math.abs(nearbyFatigue - roomFatigue) < 1e-9 && fallback.route!.hours < selected.route!.hours) selected = undefined;
  }
  let target: TilePos = selected ? { gridX: selected.room.gridX, gridY: selected.room.gridY, floor: selected.room.floor } : at;
  let route = selected?.route;
  if (!selected && fallback) { target = fallback.base; route = fallback.route; }
  const legs: Leg[] = [];
  if (route && route.path.length > 1) legs.push(makeWalk(route.path, from, TRAVEL.hoursPerTile));
  const start = legs.at(-1)?.end ?? from, end = Math.max(start, Math.min(start + duration, deadline));
  const reservation: FatigueBreak = { at: target, start, end, ...(selected ? { placeId: selected.room.id } : {}) };
  if (end > start) legs.push(makeStay(target, start, end, 'rest', { restRate: selected ? RULES.roomRecovery : RULES.fallbackRecovery, ...(selected ? { placeId: selected.room.id } : {}) }));
  if (selected && end > start) reservations.push({ staffId: member.id, placeId: selected.room.id, start, end });
  return { legs, at: target, until: end, reservation };
}

export function breakRoomOccupancy(state: HotelState, roomId: string, t: number): number {
  if (!fatigueOn()) return 0;
  const occupants = new Set<string>();
  for (const it of state.staffPlan?.itineraries ?? []) if (it.legs.some(l => l.kind === 'stay' && l.activity === 'rest' && l.placeId === roomId && l.start <= t && l.end > t)) occupants.add(it.staffId);
  return occupants.size;
}

/** Busy-day staffing advice budgets some time for recovery rather than assuming an uninterrupted shift. */
export function fatigueCapacityShare(state: HotelState): number {
  return !fatigueOn() ? 1 : getAccessibleBreakRooms(state).length > 0 ? RULES.planningShare.room : RULES.planningShare.elsewhere;
}
