import type { HotelState, ReceptionSupport, StaffMember } from './types.js';
import { receptionTrained, staffDutyAt } from './StaffProfiles.js';
import { hourStart } from './Movement.js';
import { STAFF_FATIGUE } from '../config/staff.js';

/** Read commitments without invoking the planner: queue readers must stay pure. */
export function receptionSupports(state: HotelState): Array<{ member: StaffMember; support: ReceptionSupport }> {
  const plan = state.staffPlan?.start === hourStart(state) ? state.staffPlan : null;
  const itineraries = new Map(plan?.itineraries.map(it => [it.staffId, it]));
  const result: Array<{ member: StaffMember; support: ReceptionSupport }> = [];
  for (const member of state.staffRoster ?? []) {
    if (!receptionTrained(member) || member.leaving) continue;
    const itinerary = itineraries.get(member.id);
    const blocks: ReceptionSupport[] = [];
    // A replan retains the work already done. Read those real counter stays
    // as well as the final commitment: a short block can end in a break or
    // cleaning before this hour's boundary.
    for (const leg of itinerary?.legs ?? []) {
      if (leg.kind !== 'stay' || leg.activity !== 'desk' || !leg.lane) continue;
      const previous = blocks.at(-1);
      const tiredFrom = leg.workRate === STAFF_FATIGUE.tiredRate ? leg.start : undefined;
      if (previous?.lane === leg.lane && Math.abs(previous.to - leg.start) < 1e-8) {
        previous.to = leg.end;
        if (previous.tiredFrom === undefined && tiredFrom !== undefined) previous.tiredFrom = tiredFrom;
      } else blocks.push({ lane: leg.lane, from: leg.start, to: leg.end, ...(tiredFrom !== undefined ? { tiredFrom } : {}) });
    }
    const saved = itinerary ? itinerary.end.receptionSupport : member.receptionSupport;
    const committed = saved ? { ...saved, from: Math.max(hourStart(state), saved.from) } : undefined;
    if (committed && !blocks.some(b => b.lane === committed.lane && b.from <= committed.from + 1e-8 && b.to >= committed.to - 1e-8)) blocks.push(committed);
    for (const support of blocks) {
      if (!Number.isFinite(support.from) || !Number.isFinite(support.to) || support.to <= support.from) continue;
      const duty = staffDutyAt(member, support.from);
      const from = Math.max(support.from, duty.available), to = Math.min(support.to, duty.end, member.dismissedAt ?? Infinity);
      if (duty.absent || to <= from || (member.restUntil ?? -Infinity) > from) continue;
      // Physical stays are authoritative for a rest later in the same plan.
      if (!itinerary && (member.fatigueBreak?.end ?? -Infinity) > from) continue;
      result.push({ member, support: { ...support, from, to } });
    }
  }
  return result;
}
