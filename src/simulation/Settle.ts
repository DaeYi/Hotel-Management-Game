import type { HotelState } from './types.js';
import { layoutKey } from './Layout.js';
import { replanStaff, staffWorkKey } from './StaffManager.js';
import { rerouteTrips, checkInLanes } from './GuestMovement.js';
import { GUEST_HOUSEKEEPING } from '../config/balance.js';
import { reseatLanes } from './DeskQueue.js';

/** Who's checking guests in, and where. */
function lanesKey(state: HotelState): string {
  return checkInLanes(state).map(l => `${l.desk.id}:${l.seat}`).join(',');
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
  const layoutChanged = layoutKey(before) !== layoutKey(after);
  const workChanged = layoutChanged || staffWorkKey(before) !== staffWorkKey(after);
  const lanesChanged = layoutChanged || lanesKey(before) !== lanesKey(after);
  let state = after;
  // Guests first, so the staff plan around where they'll really be (a do-not-disturb room is
  // cleaned only while they're out); with housekeeping preferences off, the old order
  const guestsFirst = GUEST_HOUSEKEEPING.enabled;
  // (with the desk queue on, everyone not yet at the counter is seated again on the clerks there now)
  if (lanesChanged && guestsFirst) state = reseatLanes(rerouteTrips(state, t), t);
  if (workChanged) state = replanStaff(state, t);
  if (lanesChanged && !guestsFirst) state = reseatLanes(rerouteTrips(state, t), t);
  return state;
}
