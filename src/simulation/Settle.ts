import type { HotelState } from './types.js';
import { layoutKey } from './Layout.js';
import { replanStaff, staffWorkKey } from './StaffManager.js';
import { rerouteTrips, checkInLanes } from './GuestMovement.js';

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
  if (workChanged) state = replanStaff(state, t);
  if (lanesChanged) state = rerouteTrips(state, t);
  return state;
}
