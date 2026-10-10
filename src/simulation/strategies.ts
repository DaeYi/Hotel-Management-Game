import type { HotelState, RoomType, FacilityType, AmenityTier } from './types.js';
import { ROOM_CONFIG, FACILITY_CONFIG, GRID, LOAN } from '../config/balance.js';
import { addRoom, addFacility, demolishRoom, isTileOccupied, isUnlocked, setRoomPrice } from './HotelState.js';
import { getExpectedPrice } from './StarRatingManager.js';
import { repayLoan } from './EconomyManager.js';
import { getAverageOccupancy } from './ObjectivesManager.js';

/**
 * A scripted player for headless balance runs. Called once per game hour;
 * strategies decide for themselves when to act (most act once a day).
 */
export type Strategy = (state: HotelState) => HotelState;

/** Never touches anything after the initial setup. */
export const idleStrategy: Strategy = state => state;

interface ManagedOptions {
  priceMultiplier: number; // relative to the fair price for the current star level
  cashReserve: number; // never spend below this on construction
  expandAtOccupancy: number; // build another room once 7-day occupancy reaches this
}

/** First free tile in row-major order -- keeps the hotel compact, so facilities end up next to rooms. */
function findFreeTile(state: HotelState): { x: number; y: number } | null {
  for (let y = 0; y < GRID.height; y++) {
    for (let x = 0; x < GRID.width; x++) {
      if (!isTileOccupied(state, x, y)) return { x, y };
    }
  }
  return null;
}

/** Room mix that pushes star points: deluxe once unlocked, every third room a suite once those unlock. */
function nextRoomType(state: HotelState): RoomType {
  if (isUnlocked(state, 'suite') && state.rooms.length % 3 === 0) return 'suite';
  if (isUnlocked(state, 'deluxe')) return 'deluxe';
  return 'standard';
}

function amenityTierFor(stars: number): AmenityTier {
  if (stars >= 4) return 'luxury';
  if (stars >= 3) return 'premium';
  return 'basic';
}

/**
 * A reasonable hands-on manager: staffs to hotel size, prices at the fair
 * rate (times priceMultiplier), cleans thoroughly, builds every facility once
 * it unlocks, expands when busy, upgrades amenities with stars, and pays the
 * loan down early when cash piles up.
 */
function managedStrategy(opts: ManagedOptions): Strategy {
  return state => {
    if (state.hour !== 8) return state;
    let s = state;
    const rooms = s.rooms.length;

    s = {
      ...s,
      staff: {
        // Roughly what each role can cover: a housekeeper turns over/cleans ~10
        // rooms in a shift, a maintenance worker keeps up with ~40, front desk ~20.
        housekeepers: Math.max(1, Math.ceil(rooms / 10)),
        maintenanceWorkers: Math.max(1, Math.ceil(rooms / 40)),
        frontDesk: Math.max(1, Math.ceil(rooms / 20)),
      },
      housekeeping: { turnoverQuality: s.starRating >= 3 ? 'thorough' : 'standard', dailyCadence: 'daily' },
    };

    const tier = amenityTierFor(s.starRating);
    s = { ...s, amenities: { standard: tier, deluxe: tier, suite: tier } };

    for (const room of s.rooms) {
      const price = Math.round(getExpectedPrice(room.type, s.starRating) * opts.priceMultiplier);
      if (room.pricePerNight !== price) s = setRoomPrice(s, room.id, price);
    }

    // Build at most one thing per day: a newly unlocked facility first, else a room if busy
    const tile = findFreeTile(s);
    if (tile) {
      const facility = (Object.keys(FACILITY_CONFIG) as FacilityType[]).find(type =>
        isUnlocked(s, type)
        && !s.facilities.some(f => f.type === type)
        && s.cash - FACILITY_CONFIG[type].buildCost >= opts.cashReserve
      );
      if (facility) {
        s = addFacility(s, facility, tile.x, tile.y) ?? s;
      } else {
        const type = nextRoomType(s);
        const busy = rooms < 10 || getAverageOccupancy(s, 7) >= opts.expandAtOccupancy;
        if (busy && s.cash - ROOM_CONFIG[type].buildCost >= opts.cashReserve) {
          s = addRoom(s, type, tile.x, tile.y) ?? s;
        }
      }
    }

    // Climbing stars: with cash to spare, swap a vacant lower-tier room for the
    // best unlocked type (a suite, eventually) -- room mix is the biggest star lever.
    const best: RoomType = isUnlocked(s, 'suite') ? 'suite' : isUnlocked(s, 'deluxe') ? 'deluxe' : 'standard';
    const replaceable = s.rooms.find(r => r.status === 'vacant' && r.type !== best && (r.type === 'standard' || best === 'suite'));
    if (replaceable && s.starRating < 5 && s.cash - ROOM_CONFIG[best].buildCost >= opts.cashReserve * 4) {
      const cleared = demolishRoom(s, replaceable.id);
      if (cleared) s = addRoom(cleared, best, replaceable.gridX, replaceable.gridY) ?? s;
    }

    // Surplus cash pays the loan down early
    while (s.loan.balance > 0 && s.cash - LOAN.earlyRepaymentStep >= opts.cashReserve * 3) {
      s = repayLoan(s, LOAN.earlyRepaymentStep) ?? s;
    }

    return s;
  };
}

export const balancedStrategy = managedStrategy({ priceMultiplier: 1.0, cashReserve: 8000, expandAtOccupancy: 0.75 });
export const greedyStrategy = managedStrategy({ priceMultiplier: 1.6, cashReserve: 8000, expandAtOccupancy: 0.75 });

export const STRATEGIES: Record<string, Strategy> = {
  idle: idleStrategy,
  balanced: balancedStrategy,
  greedy: greedyStrategy,
};
