import type { CleaningSupport, HotelState, Leg, Room, StaffItinerary, StaffMember, TilePos } from './types.js';
import { STAFF_CLEANING_SUPPORT, STAFF_FATIGUE } from '../config/staff.js';
import { TRAVEL } from '../config/balance.js';
import { cleaningRate, cleaningTrained, staffDutyAt } from './StaffProfiles.js';
import { findRoute, getAccessibleDesks, getFixtureFront } from './Layout.js';
import { isRoomReachable } from './HotelState.js';
import { hourStart, makeStay, makeWalk, sameTile } from './Movement.js';
import { fatigueAt, fatigueGain, fatigueOn, projectFatigue } from './StaffFatigue.js';

/** Read saved commitments without calling a planner (the desk queue uses this). */
export function cleaningSupports(state: HotelState): Array<{ member: StaffMember; support: CleaningSupport }> {
  const plan = state.staffPlan?.start === hourStart(state) ? state.staffPlan : null;
  const result: Array<{ member: StaffMember; support: CleaningSupport }> = [];
  for (const member of state.staffRoster ?? []) {
    if (member.role !== 'front_desk') continue;
    const itinerary = plan?.itineraries.find(it => it.staffId === member.id);
    const support = itinerary ? itinerary.end.cleaningSupport : member.cleaningSupport;
    if (!support || !Number.isFinite(support.from) || !Number.isFinite(support.to)
      || !Number.isFinite(support.workUntil) || support.to <= support.from) continue;
    // Keep elapsed absences through a paused replan, including after dismissal.
    // Current physical history remains true even if the capability is disabled.
    if (!itinerary && (!cleaningTrained(member) || member.leaving)) continue;
    result.push({ member, support });
  }
  return result;
}

export interface TurnoverJob { room: Room; hours: number; clearAt: number }

/** At least one other native clerk is physically at reception for the interval. */
function coveredUntil(plans: Map<string, StaffItinerary>, memberId: string, from: number): number {
  const stays = [...plans].filter(([id]) => id !== memberId).flatMap(([, it]) => it.legs)
    .filter(l => l.kind === 'stay' && l.activity === 'desk').sort((a, b) => a.start - b.start);
  let covered = from;
  for (const leg of stays) {
    if (leg.start > covered + 1e-9) break;
    covered = Math.max(covered, leg.end);
  }
  return covered;
}

/** Compose one real round trip. Room work and desk service keep the same person. */
export function planClerkCleaning(
  state: HotelState, member: StaffMember, baseline: StaffItinerary,
  nativePlans: Map<string, StaffItinerary>, jobs: TurnoverJob[], claimed: Set<string>, from: number,
): StaffItinerary {
  const T = hourStart(state), end = T + 1, saved = member.cleaningSupport;
  const windowEnd = Math.floor(from / 24) * 24 + STAFF_CLEANING_SUPPORT.endHour;
  // An absence never outlasts the hour it was planned in, the morning window
  // or the clerk's shift. Beyond those, the native plan alone places them.
  const bound = Math.min(end, windowEnd, staffDutyAt(member, from).end);
  const commitment = (support: CleaningSupport): CleaningSupport | undefined => {
    const to = Math.min(support.to, bound);
    return to > Math.max(support.from, T) + 1e-9 ? { ...support, to } : undefined;
  };
  const unchanged = () => saved ? { ...baseline, end: { ...baseline.end, cleaningSupport: saved } } : baseline;
  const recalled = () => {
    if (!saved) return baseline;
    const returned = baseline.legs.find(l => l.kind === 'stay' && l.activity === 'desk');
    // No counter stay means no arrival promise: a blocked route may leave
    // the clerk in the room for the rest of this hour.
    const support = commitment({ ...saved, workUntil: Math.min(saved.workUntil, from), to: Math.max(from, returned?.start ?? end) });
    return support ? { ...baseline, end: { ...baseline.end, cleaningSupport: support } } : baseline;
  };
  // A finished visit stays in the hourly history. It cannot become a second
  // visit each time the player edits the hotel while paused.
  if (saved && saved.to <= from + 1e-9) return unchanged();
  if (!cleaningTrained(member) || member.leaving || !member.at) return recalled();
  const duty = staffDutyAt(member, from);
  if (duty.absent || duty.available > from + 1e-9 || duty.end <= from
    || (member.fatigueBreak?.end ?? -Infinity) > from || (member.restUntil ?? -Infinity) > from) return recalled();
  if (!saved && (from % 24 < STAFF_CLEANING_SUPPORT.startHour || from >= windowEnd)) return baseline;
  const underway = state.guests.some(g => (g.trip ?? []).some(l => l.kind === 'stay'
    && (l.activity === 'check_in' || l.activity === 'complain') && l.serviceStaffId === member.id
    && l.start < from - 1e-9 && l.end > from + 1e-9));
  if (underway) return recalled();

  const lanes = getAccessibleDesks(state).flatMap(desk => {
    const front = getFixtureFront(state, desk);
    return front ? [{ desk, front }] : [];
  });
  const seated = baseline.legs.find(l => l.kind === 'stay' && l.activity === 'desk' && l.start <= from + 1e-9 && l.end > from);
  const seat = saved?.lane ?? (seated?.kind === 'stay' ? seated.lane : undefined);
  const lane = lanes.find(l => seat?.startsWith(`${l.desk.id}:`));
  if (!seat || !lane) return recalled();
  if (!saved && (member.carry || !sameTile(member.at, lane.front))) return baseline;

  const initialFatigue = fatigueAt(state, member, from), gain = fatigueGain(member);
  const energyLimit = fatigueOn() && gain > 0 ? from + Math.max(0, (STAFF_FATIGUE.breakAt - initialFatigue) / gain) : Infinity;
  // The room work is over. The native plan normally walks the clerk back to
  // a seat; when that walk ends with the hour or the shift it has no seat to
  // offer and would turn them out to the street mid-way. Finish the planned
  // walk back to their own seat instead.
  if (saved && from >= saved.workUntil - 1e-9 && !baseline.legs.some(l => l.kind === 'stay' && l.activity === 'desk')) {
    const legs: Leg[] = [];
    let t = from, pos: TilePos = member.at;
    if (member.carry && member.carry.end > from) {
      legs.push(member.carry); t = member.carry.end; pos = member.carry.path.at(-1)!;
    }
    const back = findRoute(state, pos, lane.front, TRAVEL.hoursPerTile);
    if (back) {
      if (back.path.length > 1) { const walk = makeWalk(back.path, t, TRAVEL.hoursPerTile); legs.push(walk); t = walk.end; }
      const last = legs.at(-1), carry = last?.kind === 'walk' && last.end > end + 1e-9 ? last : undefined;
      if (t >= Math.min(end, duty.end) - 1e-9) return { staffId: member.id, legs, end: { ...baseline.end, at: back.path.at(-1)!,
        roomId: undefined, carry, deskLane: undefined, cleaningSupport: commitment({ ...saved, to: t }) } };
    }
  }
  // Native coverage is reserved for the entire trip, not just its departure.
  const coverageEnd = coveredUntil(nativePlans, member.id, from);
  const latest = Math.min(end, windowEnd, duty.end, saved?.to ?? from + STAFF_CLEANING_SUPPORT.supportHours, energyLimit, coverageEnd);
  const options = saved ? jobs.filter(j => j.room.id === saved.roomId) : jobs.filter(j => !claimed.has(j.room.id));
  for (const job of options) {
    if (job.hours <= 1e-9 || job.room.status !== 'cleaning' || !isRoomReachable(state, job.room)) continue;
    const legs: Leg[] = [];
    let t = from, pos: TilePos = member.at;
    const appendWalk = (route: NonNullable<ReturnType<typeof findRoute>>) => {
      if (route.path.length > 1) { const walk = makeWalk(route.path, t, TRAVEL.hoursPerTile); legs.push(walk); t = walk.end; }
      pos = route.path.at(-1)!;
    };
    if (member.carry && member.carry.end > from) {
      legs.push(member.carry); t = member.carry.end; pos = member.carry.path.at(-1)!;
    }
    const at: TilePos = { gridX: job.room.gridX, gridY: job.room.gridY, floor: job.room.floor, door: job.room.door };
    const outward = findRoute(state, pos, at, TRAVEL.hoursPerTile), back = findRoute(state, at, lane.front, TRAVEL.hoursPerTile);
    if (!outward || !back) continue;
    // Wait before setting off, so the last departing guest clears the room.
    const setOff = Math.max(t, job.clearAt - outward.hours);
    if (setOff > t) { legs.push(makeStay(pos, t, setOff, 'wait')); t = setOff; }
    appendWalk(outward);
    const workStart = t;
    const stop = Math.min(saved?.workUntil ?? Infinity, latest - back.hours);
    let remaining = job.hours;
    while (remaining > 1e-9 && t < stop - 1e-9) {
      const projected = projectFatigue(member, legs, from, t, initialFatigue);
      const energy = Math.abs(projected - STAFF_FATIGUE.tiredAt) < 1e-8 ? STAFF_FATIGUE.tiredAt : projected;
      const rate = cleaningRate({ ...member, stats: { ...member.stats!, fatigue: energy, fatigueAt: t } });
      const tired = fatigueOn() && energy < STAFF_FATIGUE.tiredAt - 1e-9 && gain > 0
        ? t + (STAFF_FATIGUE.tiredAt - energy) / gain : Infinity;
      const until = Math.min(stop, tired, t + remaining / rate);
      if (until <= t + 1e-9) break;
      legs.push(makeStay(at, t, until, 'clean', { job: 'turnover', placeId: job.room.id, workRate: rate }));
      remaining -= (until - t) * rate; t = until;
    }
    const workUntil = t;
    // Finishing an almost-clean room is useful even if it needs less than the
    // ordinary minimum block. A new partial visit must meet that minimum.
    if (workUntil <= workStart + 1e-9 || !saved && remaining > 1e-9 && workUntil - workStart < STAFF_CLEANING_SUPPORT.minWorkHours - 1e-9) continue;
    appendWalk(back);
    if (!saved && coverageEnd < t - 1e-9) continue;
    // A changed building/roster can recall an existing visit; never continue
    // optional room work if the remaining native coverage has vanished.
    if (saved && coverageEnd < t - 1e-9) break;
    const support = commitment({ roomId: job.room.id, lane: seat, from: saved?.from ?? from, to: t, workUntil: Math.min(saved?.workUntil ?? workUntil, workUntil) });
    const returnAt = t;
    const returnFatigue = projectFatigue(member, legs, from, returnAt, initialFatigue);
    const tired = fatigueOn() && returnFatigue < STAFF_FATIGUE.tiredAt - 1e-9 && gain > 0
      ? returnAt + (STAFF_FATIGUE.tiredAt - returnFatigue) / gain : Infinity;
    if (t < Math.min(end, duty.end)) {
      const tailEnd = Math.min(end, duty.end, energyLimit);
      if (tired > t + 1e-9 && tired < tailEnd - 1e-9) {
        legs.push(makeStay(pos, t, tired, 'desk', { placeId: lane.desk.id, lane: seat })); t = tired;
      }
      if (t < tailEnd) legs.push(makeStay(pos, t, tailEnd, 'desk', { placeId: lane.desk.id, lane: seat }));
      // Reuse the native plan's scheduled recovery once its active-energy
      // limit is reached. Trips consume the same fatigue as desk time.
      if (tailEnd < end - 1e-9) {
        const delay = Math.max(0, returnAt - tailEnd);
        const recovery = baseline.legs.filter(l => l.end > tailEnd && l.start >= tailEnd - 1e-9)
          .map(l => ({ ...l, start: l.start + delay, end: l.end + delay }));
        legs.push(...recovery);
      }
    }
    claimed.add(job.room.id);
    const last = legs.at(-1), carry = last?.kind === 'walk' && last.end > end + 1e-9 ? last : undefined;
    return { staffId: member.id, legs, end: { ...baseline.end, at: last?.kind === 'walk' ? last.path.at(-1)! : last?.at ?? pos,
      roomId: undefined, carry, deskLane: last?.kind === 'stay' && last.activity === 'desk' ? seat : undefined,
      cleaningSupport: support } };
  }
  // A recalled, demolished or completed room is left immediately. The native
  // baseline starts at the real position and walks all the way back.
  return recalled();
}
