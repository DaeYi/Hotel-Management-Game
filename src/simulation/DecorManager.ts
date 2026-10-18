import type { HotelState, GameEvent } from './types.js';
import { profileRoom } from './RoomProfile.js';
import { DECOR } from '../config/balance.js';
import { formatRoomLabel } from './HotelState.js';

/** Fade every room's and facility's decor by one day's worth. Call once per day. */
export function decayDecor(state: HotelState): HotelState {
  const fade = (decor: number) => Math.max(0, decor - DECOR.decayPerDay);
  return {
    ...state,
    rooms: state.rooms.map(r => r.status === 'renovating' ? r : { ...r, decor: fade(r.decor) }),
    facilities: state.facilities.map(f => ({ ...f, decor: fade(f.decor) })),
  };
}

/** Count down renovating rooms; finished rooms reopen good as new. Call once per hour. */
export function processRenovationTick(state: HotelState): { state: HotelState; events: GameEvent[] } {
  if (!state.rooms.some(r => r.status === 'renovating')) return { state, events: [] };

  const events: GameEvent[] = [];
  const rooms = state.rooms.map(room => {
    if (room.status !== 'renovating') return room;
    const hours = room.renovationHoursRemaining - 1;
    if (hours > 0) return { ...room, renovationHoursRemaining: hours };

    if (room.refitting) {
      // A refit: the new furniture's in; it freshens the room as far as it goes
      events.push({
        type: 'renovation_complete',
        message: `Room ${formatRoomLabel(room.gridX, room.gridY, room.floor)} refitted: ${profileRoom(room).label}`,
        data: { roomId: room.id },
      });
      return { ...room, status: 'vacant' as const, renovationHoursRemaining: 0, decor: Math.max(room.decor, room.refitting.decorAfter), refitting: undefined };
    }
    events.push({
      type: 'renovation_complete',
      message: `Room ${formatRoomLabel(room.gridX, room.gridY, room.floor)} renovated`,
      data: { roomId: room.id },
    });
    return { ...room, status: 'vacant' as const, renovationHoursRemaining: 0, decor: 100, condition: 100, cleanliness: 100, damageReportedBy: undefined, cleanedBy: undefined };
  });

  return { state: { ...state, rooms }, events };
}

/** Average decor across all rooms and facilities (100 for an empty hotel). */
export function getAverageDecor(state: HotelState): number {
  const values = [...state.rooms.map(r => r.decor), ...state.facilities.map(f => f.decor)];
  if (values.length === 0) return 100;
  return values.reduce((sum, d) => sum + d, 0) / values.length;
}

/** Star points lost to stale decor: zero while fresh, up to DECOR.maxStarPenalty at 0. */
export function getDecorStarPenalty(state: HotelState): number {
  const staleness = Math.max(0, DECOR.freshThreshold - getAverageDecor(state)) / DECOR.freshThreshold;
  return staleness * DECOR.maxStarPenalty;
}

/** Review effect of a room's decor on the 0-10 scale: 0 while fresh, negative once stale. */
export function getDecorReviewPenalty(decor: number): number {
  return Math.max(0, DECOR.freshThreshold - decor) / DECOR.freshThreshold * DECOR.reviewWeight;
}
