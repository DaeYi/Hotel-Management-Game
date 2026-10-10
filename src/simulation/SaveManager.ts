import type { HotelState } from './types.js';
import type { PRNG } from './prng.js';
import { GUEST_NAMES, LOAN, GRID, STARTER_LAYOUT } from '../config/balance.js';
import { starterHallways } from './HotelState.js';
import { calculateStarRating } from './StarRatingManager.js';

const SAVE_KEY = 'hotel-game-save';
const SAVE_VERSION = 15; // v15: daily cleans are queued housekeeping jobs

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
      // Floors arrived in v13; the v14 step below re-packs every layout anyway
      data.version = 13;
      console.log('Migrated save from v12 to v13');
    }

    if (data.version === 13) {
      packIntoLayout(data.state);
      data.version = 14;
      console.log('Migrated save from v13 to v14');
    }

    if (data.version === 14) {
      data.state.rooms = data.state.rooms.map((r: any) => ({ ...r, dailyCleanHoursRemaining: r.dailyCleanHoursRemaining ?? 0 }));
      data.version = 15;
      console.log('Migrated save from v14 to v15');
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
 * v13 -> v14: hallways and check-in desks are new, and the floor plan grew to
 * fit them, so no older layout would have any bookable rooms. Re-pack every
 * room and facility (rooms first, in old floor/row/column order) into the
 * STARTER_LAYOUT room tiles across as many floors as it takes, with hallway
 * rows on every floor, the free desk on the ground floor, and elevator shafts
 * on the reserved tiles (at least one if there are upper floors). Ids are
 * kept, so checked-in guests stay in their rooms.
 */
export function packIntoLayout(state: any): void {
  const byPosition = (a: any, b: any) => (a.floor ?? 0) - (b.floor ?? 0) || a.gridY - b.gridY || a.gridX - b.gridX;
  const items = [...[...state.rooms].sort(byPosition), ...[...state.facilities].sort(byPosition)];

  const isReserved = (x: number, y: number, floor: number) =>
    STARTER_LAYOUT.hallwayTiles.some(([hx, hy]) => hx === x && hy === y)
    || STARTER_LAYOUT.elevatorTiles.some(([ex, ey]) => ex === x && ey === y)
    || (floor === 0 && STARTER_LAYOUT.deskTiles.some(([dx, dy]) => dx === x && dy === y));
  const slotsOn = (floor: number) => {
    const slots: Array<[number, number]> = [];
    for (let y = 0; y < GRID.height; y++) {
      for (let x = 0; x < GRID.width; x++) if (!isReserved(x, y, floor)) slots.push([x, y]);
    }
    return slots;
  };

  let floor = 0;
  let slots = slotsOn(0);
  const placed = items.map(item => {
    if (slots.length === 0) slots = slotsOn(++floor);
    const [gridX, gridY] = slots.shift()!;
    return { ...item, floor, gridX, gridY };
  });
  const placedIds = new Set(state.rooms.map((r: any) => r.id));
  state.rooms = placed.filter(p => placedIds.has(p.id));
  state.facilities = placed.filter(p => !placedIds.has(p.id)).map(f => ({ ...f, level: f.level ?? 1, decor: f.decor ?? 100 }));
  state.floorCount = floor + 1;

  const shafts = Math.min(STARTER_LAYOUT.elevatorTiles.length,
    Math.max(state.floorCount > 1 ? 1 : 0, (state.elevators ?? []).length));
  state.elevators = STARTER_LAYOUT.elevatorTiles.slice(0, shafts).map(([x, y]) => ({ id: `elevator-${x}-${y}`, gridX: x, gridY: y }));

  const [deskX, deskY] = STARTER_LAYOUT.deskTiles[0];
  state.fixtures = [
    ...Array.from({ length: state.floorCount }, (_, f) => starterHallways(f)).flat(),
    { id: `desk-0-${deskX}-${deskY}`, type: 'desk', gridX: deskX, gridY: deskY, floor: 0 },
  ];
  state.noiseSources = []; // positions no longer line up; construction noise is short-lived anyway
}

export function hasSavedGame(): boolean {
  return localStorage.getItem(SAVE_KEY) !== null;
}

export function deleteSave(): void {
  localStorage.removeItem(SAVE_KEY);
}
