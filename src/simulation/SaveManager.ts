import type { HotelState } from './types.js';
import type { PRNG } from './prng.js';

const SAVE_KEY = 'hotel-game-save';
const SAVE_VERSION = 9; // v9: added building facilities

interface SaveData {
  version: number;
  prngState: number;
  state: HotelState;
  timestamp: number;
}

export function saveGame(state: HotelState, prng: PRNG): boolean {
  try {
    const data: SaveData = {
      version: SAVE_VERSION,
      prngState: prng.getState(),
      state,
      timestamp: Date.now(),
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function loadGame(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;

    const data = JSON.parse(raw) as SaveData;

    // Migrate old saves
    if (data.version === 1) {
      data.state.noiseSources = data.state.noiseSources ?? [];
      data.version = 2;
      console.log('Migrated save from v1 to v2');
    }

    if (data.version === 2) {
      data.state.housekeeping = data.state.housekeeping ?? {
        turnoverQuality: 'standard',
        dailyCadence: 'daily',
      };
      // Migrate rooms: add new fields
      data.state.rooms = data.state.rooms.map((r: any) => ({
        ...r,
        cleanliness: r.cleanliness ?? 100,
        status: r.status ?? (r.occupied ? 'occupied' : 'vacant'),
        cleaningHoursRemaining: r.cleaningHoursRemaining ?? 0,
        lastDailyCleanDay: r.lastDailyCleanDay ?? 0,
      }));
      data.version = 3;
      console.log('Migrated save from v2 to v3');
    }

    if (data.version === 3) {
      // Split reputationScore into starRating + reviewScore
      const oldRep = (data.state as any).reputationScore ?? 50;
      data.state.starRating = data.state.starRating ?? 1;
      data.state.reviewScore = data.state.reviewScore ?? (oldRep / 10); // convert 0-100 to 0-10
      delete (data.state as any).reputationScore;
      // Migrate bookings: rating (1-5) -> reviewScore (0-10)
      data.state.bookings = data.state.bookings.map((b: any) => ({
        ...b,
        reviewScore: b.reviewScore ?? (b.rating != null ? b.rating * 2 : 5),
      }));
      data.version = 4;
      console.log('Migrated save from v3 to v4');
    }

    if (data.version === 4) {
      data.state.staff = data.state.staff ?? { maintenanceWorkers: 0, housekeepers: 1 };
      data.version = 5;
      console.log('Migrated save from v4 to v5');
    }

    if (data.version === 5) {
      if (data.state.staff && data.state.staff.housekeepers == null) {
        data.state.staff.housekeepers = 1;
      }
      data.version = 6;
      console.log('Migrated save from v5 to v6');
    }

    if (data.version === 6) {
      if (data.state.staff && data.state.staff.frontDesk == null) {
        data.state.staff.frontDesk = 1;
      }
      data.version = 7;
      console.log('Migrated save from v6 to v7');
    }

    if (data.version === 7) {
      data.state.amenities = data.state.amenities ?? {
        standard: 'basic',
        deluxe: 'basic',
        suite: 'basic',
      };
      data.version = 8;
      console.log('Migrated save from v7 to v8');
    }

    if (data.version === 8) {
      data.state.facilities = data.state.facilities ?? [];
      data.version = 9;
      console.log('Migrated save from v8 to v9');
    }

    if (data.version !== SAVE_VERSION) {
      console.warn(`Save version mismatch: expected ${SAVE_VERSION}, got ${data.version}`);
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

export function hasSavedGame(): boolean {
  return localStorage.getItem(SAVE_KEY) !== null;
}

export function deleteSave(): void {
  localStorage.removeItem(SAVE_KEY);
}
