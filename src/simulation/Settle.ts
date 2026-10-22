import type { HotelState } from './types.js';
import { layoutKey } from './Layout.js';
import { replanStaff, staffWorkKey, syncStaff } from './StaffManager.js';
import { STAFF_PERSONALITIES } from '../config/staff.js';
import { rerouteTrips, checkInLanes } from './GuestMovement.js';
import { GUEST_HOUSEKEEPING } from '../config/balance.js';
import { reseatLanes } from './DeskQueue.js';
import { namedFrontDesk, specialtyOf, hospitalityOf } from './StaffProfiles.js';

/** Who's checking guests in, and where. */
function lanesKey(state: HotelState): string {
  return checkInLanes(state).map(l => `${l.desk.id}:${l.seat}`).join(',') + (namedFrontDesk(state) ? (state.staffRoster ?? []).filter(m => m.role === 'front_desk').map(m => `${m.id}:${m.leaving}:${m.shift}:${m.restUntil}:${specialtyOf(m)}:${hospitalityOf(m)}`).join(',') : '');
}

/**
 * After something changes the hotel mid-hour (the player building or
 * renovating, a headless strategy acting), the people it affects carry on
 * from where they are at time t: staff re-plan when the building or their
 * work changes (a room built across a hallway, a room renovated mid-repair),
 * and guests find new ways when the building or the front desk changes. So
 * nobody walks through a new wall, keeps cleaning a room that's gone, or
 * checks in at a desk nobody's sitting at.
 */
export function settleChanges(before: HotelState, after: HotelState, t: number): HotelState {
  if (STAFF_PERSONALITIES.enabled && (before.staff.housekeepers !== after.staff.housekeepers || before.staff.maintenanceWorkers !== after.staff.maintenanceWorkers || namedFrontDesk(after) && before.staff.frontDesk !== after.staff.frontDesk)) after = syncStaff(after, t);
  const layoutChanged = layoutKey(before) !== layoutKey(after);
  const workChanged = layoutChanged || staffWorkKey(before) !== staffWorkKey(after);
  const lanesChanged = layoutChanged || lanesKey(before) !== lanesKey(after);
  let state = after;
  if (namedFrontDesk(state)) {
    if (workChanged) state = replanStaff(state, t);
    if (lanesChanged) {
      state = reseatLanes(rerouteTrips(state, t), t);
      // Room workers must use the guests' final routes and return times.
      if (workChanged) state = replanStaff(state, t);
    }
    return state;
  }
  // Guests first, so the staff plan around where they'll really be (a do-not-disturb room is
  // cleaned only while they're out); with housekeeping preferences off, the old order
  const guestsFirst = GUEST_HOUSEKEEPING.enabled;
  // (with the desk queue on, everyone not yet at the counter is seated again on the clerks there now)
  if (lanesChanged && guestsFirst) state = reseatLanes(rerouteTrips(state, t), t);
  if (workChanged) state = replanStaff(state, t);
  if (lanesChanged && !guestsFirst) state = reseatLanes(rerouteTrips(state, t), t);
  return state;
}
