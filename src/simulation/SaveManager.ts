import type { HotelState } from './types.js';
import type { PRNG } from './prng.js';
import { GUEST_NAMES, LOAN, GRID } from '../config/balance.js';
import { calculateStarRating } from './StarRatingManager.js';

const SAVE_KEY = 'hotel-game-save';
const SAVE_VERSION = 13; // v13: multiple floors, elevators, smaller floor plan

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

    if (data.version === 9) {
      data.state.activeIncidents = data.state.activeIncidents ?? [];
      data.state.returningGuestPool = data.state.returningGuestPool ?? [];
      data.state.storyLog = data.state.storyLog ?? [];
      data.state.activeReputationPenalties = data.state.activeReputationPenalties ?? [];
      // Guests already checked in inside a loaded save predate Guest.name/isReturning/
      // hadNoiseComplaint -- backfill a generated name (design doc's Save Compatibility
      // section) and default the new flags, mirroring v2->v3's per-room backfill pattern.
      data.state.guests = data.state.guests.map((g: any) => ({
        ...g,
        name: g.name ?? GUEST_NAMES[Math.floor(Math.random() * GUEST_NAMES.length)],
        isReturning: g.isReturning ?? false,
        hadNoiseComplaint: g.hadNoiseComplaint ?? false,
      }));
      // Existing bookings predate satisfactionAtCheckout -- backfill a neutral value
      // so the word-of-mouth rolling window doesn't choke on missing data.
      data.state.bookings = data.state.bookings.map((b: any) => ({
        ...b,
        satisfactionAtCheckout: b.satisfactionAtCheckout ?? 50,
      }));
      data.version = 10;
      console.log('Migrated save from v9 to v10');
    }

    if (data.version === 10) {
      // Saves from before the loan existed start debt-free rather than being
      // handed a $50k balance mid-game. Star thresholds also changed in v11, so
      // recompute the rating and treat it as the peak for unlocks.
      data.state.loan = data.state.loan ?? { balance: 0, weeklyPayment: LOAN.weeklyPayment, missedPayments: 0 };
      data.state.objectives = data.state.objectives ?? { currentIndex: 0, outcomes: [] };
      data.state.dailyStats = data.state.dailyStats ?? [];
      data.state.starRating = calculateStarRating(data.state);
      data.state.peakStarRating = data.state.peakStarRating ?? data.state.starRating;
      data.version = 11;
      console.log('Migrated save from v10 to v11');
    }

    if (data.version === 11) {
      // Existing buildings start fresh rather than suddenly stale; facilities at level 1.
      data.state.rooms = data.state.rooms.map((r: any) => ({
        ...r,
        decor: r.decor ?? 100,
        renovationHoursRemaining: r.renovationHoursRemaining ?? 0,
      }));
      data.state.facilities = data.state.facilities.map((f: any) => ({
        ...f,
        decor: f.decor ?? 100,
        level: f.level ?? 1,
      }));
      data.state.activeCampaign = data.state.activeCampaign ?? null;
      data.state.daysAtFiveStars = data.state.daysAtFiveStars ?? 0;
      // Older snapshots predate valuation; 0 is only used for history, never for goals
      data.state.dailyStats = data.state.dailyStats.map((d: any) => ({ ...d, valuation: d.valuation ?? 0 }));
      data.version = 12;
      console.log('Migrated save from v11 to v12');
    }

    if (data.version === 12) {
      migrateToFloors(data.state);
      data.version = 13;
      console.log('Migrated save from v12 to v13');
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

/**
 * v12 -> v13: the old single 20x15 grid doesn't fit the new 8x5 floor plan, so
 * re-pack everything (rooms first, then facilities, in old row-major order) onto
 * as many floors as it takes. When that's more than one floor, tile (0, 0) is
 * kept free on every floor for an elevator, which the hotel gets for free so
 * upper-floor rooms stay bookable. Ids are kept, so guests stay in their rooms.
 */
export function migrateToFloors(state: any): void {
  const byPosition = (a: any, b: any) => a.gridY - b.gridY || a.gridX - b.gridX;
  const rooms = [...state.rooms].sort(byPosition);
  const facilities = [...state.facilities].sort(byPosition);
  const total = rooms.length + facilities.length;
  const perFloor = GRID.width * GRID.height;
  const needsElevator = total > perFloor;
  const usablePerFloor = needsElevator ? perFloor - 1 : perFloor;

  let slot = 0;
  const place = (item: any) => {
    const floor = Math.floor(slot / usablePerFloor);
    const index = (slot % usablePerFloor) + (needsElevator ? 1 : 0); // skip (0, 0) for the shaft
    slot++;
    return { ...item, floor, gridX: index % GRID.width, gridY: Math.floor(index / GRID.width) };
  };

  state.rooms = rooms.map(place);
  state.facilities = facilities.map(place);
  state.floorCount = Math.max(1, Math.ceil(total / usablePerFloor));
  state.elevators = needsElevator ? [{ id: 'elevator-0-0', gridX: 0, gridY: 0 }] : [];
  state.noiseSources = []; // positions no longer line up; construction noise is short-lived anyway
}

export function hasSavedGame(): boolean {
  return localStorage.getItem(SAVE_KEY) !== null;
}

export function deleteSave(): void {
  localStorage.removeItem(SAVE_KEY);
}
