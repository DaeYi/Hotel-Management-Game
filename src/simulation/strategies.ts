import type { HotelState, RoomType, FacilityType, AmenityTier, Direction } from './types.js';
import { ROOM_CONFIG, FACILITY_CONFIG, GRID, LOAN, ELEVATOR, STARTER_LAYOUT, DESK, CLOSET } from '../config/balance.js';
import {
  addRoom, addFacility, demolishRoom, isTileOccupied, isUnlocked, setRoomPrice, renovateRoom, renovateFacility,
  upgradeFacility, getFacilityUpgradeCost, addElevator, buildFloor, getNextFloorCost, getElevatorLoad, addFixture, getRoomBuildCost,
} from './HotelState.js';
import { profileRoom } from './RoomProfile.js';
import type { PresetId } from '../config/furniture.js';
import { startCampaign, getCampaignCost } from './MarketingManager.js';
import { FACILITY_LEVELS } from '../config/balance.js';
import { getRoomExpectedPrice } from './StarRatingManager.js';
import { repayLoan, processDailyCosts } from './EconomyManager.js';
import { getStaffDailyCost } from './MaintenanceManager.js';
import { housekeepersNeeded, PLANNING_OCCUPANCY } from './HousekeepingManager.js';
import { getAverageOccupancy } from './ObjectivesManager.js';
import { getExpectedArrivalsPerDay } from './GuestManager.js';
import { getTotalDemandMultiplier } from './SeasonManager.js';

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
  expandAtOccupancy: number; // build another room while normal-season demand would fill at least this much
  renovate: boolean; // renovate stale rooms and facilities
  upgrade: boolean; // upgrade facilities when unlocked
  market: boolean; // run marketing campaigns when rooms sit empty
  staffing?: number; // housekeepers hired relative to the estimated need (default 1)
}

const STALE_DECOR = 60; // reinvesting strategies renovate below this
// Share of arriving guests who end up booking (the rest find no room in
// budget or at a price they'll pay) -- measured from balance runs.
const BOOKING_CONVERSION = 0.7;
const AVERAGE_STAY_NIGHTS = 2;

/**
 * The occupancy current demand would fill, with or without the seasonal swing.
 * Planning on demand rather than recent occupancy avoids two traps: building
 * for a summer rush that's gone by winter (demand swings 1.5x to 0.6x), and
 * cutting housekeepers when a cleaning backlog -- not demand -- is what's
 * keeping rooms empty.
 */
function demandOccupancy(state: HotelState, deseasonalize: boolean): number {
  if (state.rooms.length === 0) return 1;
  const arrivals = getExpectedArrivalsPerDay(state) / (deseasonalize ? getTotalDemandMultiplier(state.day) : 1);
  return Math.min(1, arrivals * AVERAGE_STAY_NIGHTS * BOOKING_CONVERSION / state.rooms.length);
}

/** Staff for today's demand with headroom, within half-full and a busy day. */
function staffingOccupancy(state: HotelState): number {
  return Math.min(PLANNING_OCCUPANCY, Math.max(0.5, demandOccupancy(state, false) + 0.1));
}
const MAX_RENOVATIONS_PER_DAY = 3; // don't take half the hotel offline at once

// The managed bots follow STARTER_LAYOUT: hallway rows on every floor, with
// elevator shafts and extra desks on reserved tiles.
const ELEVATOR_TILES = STARTER_LAYOUT.elevatorTiles;
const isReservedTile = (x: number, y: number, floor: number) =>
  STARTER_LAYOUT.hallwayTiles.some(([hx, hy]) => hx === x && hy === y)
  || ELEVATOR_TILES.some(([ex, ey]) => ex === x && ey === y)
  || (floor === 0 && STARTER_LAYOUT.deskTiles.some(([dx, dy]) => dx === x && dy === y))
  || (floor > 0 && STARTER_LAYOUT.closetTile[0] === x && STARTER_LAYOUT.closetTile[1] === y);

const CLOSET_MIN_ROOMS = 6;

/**
 * How full the bots let the lifts get before they stop adding rooms upstairs
 * (every shaft built): past full, each room adds to everyone's wait, but the
 * wait only costs reviews gradually, so a little over full still pays.
 */
export const BOT_MAX_LIFT_LOAD = { value: 1.5 }; // an upper floor gets its own staff closet once it has this many rooms

/** First free room tile, lowest floor first, row-major -- keeps the hotel compact, so facilities end up next to rooms. */
function findFreeTile(state: HotelState): { x: number; y: number; floor: number } | null {
  for (let floor = 0; floor < state.floorCount; floor++) {
    for (let y = 0; y < GRID.height; y++) {
      for (let x = 0; x < GRID.width; x++) {
        if (!isReservedTile(x, y, floor) && !isTileOccupied(state, x, y, floor)) return { x, y, floor };
      }
    }
  }
  return null;
}

const isTemplateHallway = (x: number, y: number) => STARTER_LAYOUT.hallwayTiles.some(([hx, hy]) => hx === x && hy === y);

/** The door for a template room tile: onto the template hallway beside it. */
function templateDoor(x: number, y: number): Direction {
  if (isTemplateHallway(x, y - 1)) return 'up';
  if (isTemplateHallway(x, y + 1)) return 'down';
  return isTemplateHallway(x + 1, y) ? 'right' : 'left';
}

/** Give each busy upper floor a staff closet, so housekeeping and maintenance don't walk up from the lobby. */
function addClosetsIfNeeded(state: HotelState, afford: Afford): HotelState {
  let s = state;
  const [x, y] = STARTER_LAYOUT.closetTile;
  for (let floor = 1; floor < s.floorCount; floor++) {
    const rooms = s.rooms.filter(r => r.floor === floor).length;
    const hasCloset = s.fixtures.some(f => f.type === 'closet' && f.floor === floor);
    if (rooms >= CLOSET_MIN_ROOMS && !hasCloset && afford(s, CLOSET.buildCost)) {
      s = addFixture(s, 'closet', x, y, floor) ?? s;
    }
  }
  return s;
}

/** Add a check-in desk on the next reserved desk tile when front desk staff outnumber the seats. */
function addDeskIfNeeded(state: HotelState, afford: Afford): HotelState {
  const desks = state.fixtures.filter(f => f.type === 'desk').length;
  if (state.staff.frontDesk <= desks * DESK.staffPerDesk || !afford(state, DESK.buildCost)) return state;
  for (const [x, y] of STARTER_LAYOUT.deskTiles) {
    const next = addFixture(state, 'desk', x, y, 0);
    if (next) return next;
  }
  return state;
}

/** Whether the bot can spend `cost` and keep its reserve (times `mult` for bigger purchases). */
type Afford = (state: HotelState, cost: number, mult?: number) => boolean;

const SAFETY_DAYS = 10;

/** What the hotel spends per day before revenue: operating costs, amenities, facilities, staff. */
function getDailyRunningCost(state: HotelState): number {
  return -processDailyCosts(state).cashDelta + getStaffDailyCost(state);
}

/** Add an elevator on the next reserved shaft tile, if one is free and affordable. */
function addReservedElevator(state: HotelState, afford: Afford): HotelState {
  if (!afford(state, ELEVATOR.buildCost)) return state;
  for (const [x, y] of ELEVATOR_TILES) {
    const next = addElevator(state, x, y);
    if (next) return next;
  }
  return state;
}

/**
 * Room mix: some twin and family rooms for the friends and families who
 * can't use a double (a share of the hotel, once it's past its first few
 * rooms), else what pushes star points -- deluxe once unlocked, every third
 * room a suite once those unlock.
 */
function nextRoomType(state: HotelState): RoomType | PresetId {
  const n = state.rooms.length;
  if (n >= 6) {
    const classes = state.rooms.map(r => profileRoom(r).layoutClass);
    const deluxe = isUnlocked(state, 'deluxe');
    if (classes.filter(c => c === 'family').length < Math.round(n * BOT_ROOM_MIX.family)) return deluxe ? 'deluxe_family' : 'bunk_family';
    if (classes.filter(c => c === 'twin').length < Math.round(n * BOT_ROOM_MIX.twin)) return deluxe ? 'deluxe_twin' : 'twin';
  }
  if (isUnlocked(state, 'suite') && n % 3 === 0) return 'suite';
  if (isUnlocked(state, 'deluxe')) return 'deluxe';
  return 'standard';
}
/** The share of rooms the bots keep for families (sleeping four) and for friends (twin beds). */
export const BOT_ROOM_MIX = { family: 0.12, twin: 0.08 };

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

    // Never spend below ~10 days of running costs: a slow season (winter demand
    // is 0.6x) shouldn't tip an expensive hotel into debt. Bigger purchases also
    // want a multiple of the base reserve banked first.
    const safety = SAFETY_DAYS * getDailyRunningCost(s);
    const afford: Afford = (st, cost, mult = 1) => st.cash - cost >= Math.max(opts.cashReserve * mult, safety);

    s = {
      ...s,
      staff: {
        // Housekeepers sized to a busy day's workload (turnovers + daily round,
        // walks included); a maintenance worker keeps up with ~40 rooms, front desk ~20.
        housekeepers: Math.max(1, Math.round(housekeepersNeeded(s, staffingOccupancy(s)) * (opts.staffing ?? 1))),
        maintenanceWorkers: Math.max(1, Math.ceil(rooms / 40)),
        frontDesk: Math.max(1, Math.ceil(rooms / 20)),
      },
      housekeeping: { turnoverQuality: s.peakStarRating >= 2 ? 'thorough' : 'standard', dailyCadence: 'daily' },
    };

    const tier = amenityTierFor(s.starRating);
    s = { ...s, amenities: { standard: tier, deluxe: tier, suite: tier } };

    for (const room of s.rooms) {
      const price = Math.round(getRoomExpectedPrice(room, s.starRating) * opts.priceMultiplier);
      if (room.pricePerNight !== price) s = setRoomPrice(s, room.id, price);
    }

    // Build at most one thing per day: a newly unlocked facility first, else a room if busy
    const tile = findFreeTile(s);
    if (tile) {
      const facility = (Object.keys(FACILITY_CONFIG) as FacilityType[]).find(type =>
        isUnlocked(s, type)
        && !s.facilities.some(f => f.type === type)
        && afford(s, FACILITY_CONFIG[type].buildCost)
      );
      if (facility) {
        s = addFacility(s, facility, tile.x, tile.y, tile.floor, templateDoor(tile.x, tile.y)) ?? s;
      } else {
        const type = nextRoomType(s);
        const busy = rooms < 10 || demandOccupancy(s, true) >= opts.expandAtOccupancy;
        // Every lift shaft built and the lifts already full: another room upstairs only makes everyone wait longer
        const liftsFull = tile.floor > 0 && s.elevators.length >= ELEVATOR_TILES.length && getElevatorLoad(s) >= BOT_MAX_LIFT_LOAD.value;
        if (busy && !liftsFull && afford(s, getRoomBuildCost(type))) {
          s = addRoom(s, type, tile.x, tile.y, tile.floor, templateDoor(tile.x, tile.y)) ?? s;
        }
      }
    } else if (demandOccupancy(s, true) >= opts.expandAtOccupancy && !(s.elevators.length >= ELEVATOR_TILES.length && getElevatorLoad(s) >= BOT_MAX_LIFT_LOAD.value)) {
      // Out of room and still busy: build upward (shaft first, so the new floor is reachable) -- unless the lifts can't take more
      if (s.elevators.length === 0) s = addReservedElevator(s, afford);
      const floorCost = getNextFloorCost(s);
      if (s.elevators.length > 0 && floorCost !== null && afford(s, floorCost, 2)) {
        const built = buildFloor(s);
        if (built) s = built.state;
      }
    }

    s = addDeskIfNeeded(s, afford);
    s = addClosetsIfNeeded(s, afford);

    // Keep elevator waits comfortable as the upper floors fill
    if (s.elevators.length > 0 && getElevatorLoad(s) > 0.9) {
      s = addReservedElevator(s, afford);
    }

    // Climbing stars: with cash to spare, swap a vacant lower-tier double for the
    // best unlocked type (a suite, eventually) -- room mix is the biggest star
    // lever. Twin and family rooms stay: they're for the guests a double can't take.
    const best: RoomType = isUnlocked(s, 'suite') ? 'suite' : isUnlocked(s, 'deluxe') ? 'deluxe' : 'standard';
    const replaceable = s.rooms.find(r => r.status === 'vacant' && r.type !== best && (r.type === 'standard' || best === 'suite')
      && profileRoom(r).layoutClass === 'double');
    // (And once the lifts can't take more rooms upstairs, upgrading is where the money goes.)
    const builtOut = s.elevators.length >= ELEVATOR_TILES.length && getElevatorLoad(s) >= BOT_MAX_LIFT_LOAD.value;
    if (replaceable && (s.starRating < 5 || builtOut) && afford(s, ROOM_CONFIG[best].buildCost, 4)) {
      const cleared = demolishRoom(s, replaceable.id);
      if (cleared) s = addRoom(cleared, best, replaceable.gridX, replaceable.gridY, replaceable.floor, replaceable.door) ?? s;
    }

    s = reinvest(s, opts, afford);

    // Surplus cash pays the loan down early
    while (s.loan.balance > 0 && afford(s, LOAN.earlyRepaymentStep, 3)) {
      s = repayLoan(s, LOAN.earlyRepaymentStep) ?? s;
    }

    return s;
  };
}

/** Late-game spending: renovations, facility upgrades, and marketing when rooms sit empty. */
function reinvest(state: HotelState, opts: ManagedOptions, afford: Afford): HotelState {
  let s = state;
  const canSpend = (cost: number, reserveMult = 1) => afford(s, cost, reserveMult);
  // Discretionary spending waits until there's enough banked to keep climbing
  // (a suite swap needs cashReserve x 4 on top of the suite itself).
  const surplusMult = 6;

  if (opts.renovate) s = renovateStale(s, canSpend);

  if (opts.upgrade) {
    for (const facility of s.facilities) {
      const cost = getFacilityUpgradeCost(facility);
      const level = FACILITY_LEVELS[facility.level];
      if (cost !== null && level && s.peakStarRating >= level.requiredStars && canSpend(cost, surplusMult)) {
        s = upgradeFacility(s, facility.id) ?? s;
      }
    }
  }

  if (opts.market && !s.activeCampaign && getAverageOccupancy(s, 7) < 0.7) {
    const campaign = ['national', 'online', 'local'].find(id => canSpend(getCampaignCost(s, id), surplusMult));
    if (campaign) s = startCampaign(s, campaign) ?? s;
  }

  return s;
}

/** Renovations are upkeep, not luxury: they only need the normal cash reserve. */
function renovateStale(state: HotelState, canSpend: (cost: number) => boolean): HotelState {
  let s = state;
  const stale = s.rooms
    .filter(r => r.status === 'vacant' && r.decor < STALE_DECOR)
    .sort((a, b) => a.decor - b.decor)
    .slice(0, MAX_RENOVATIONS_PER_DAY);
  for (const room of stale) {
    const next = renovateRoom(s, room.id);
    if (next && canSpend(s.cash - next.cash)) s = next;
  }
  for (const facility of s.facilities.filter(f => f.decor < STALE_DECOR)) {
    const next = renovateFacility(s, facility.id);
    if (next && canSpend(s.cash - next.cash)) s = next;
  }
  return s;
}

const ALL_SINKS = { renovate: true, upgrade: true, market: true };
const NO_SINKS = { renovate: false, upgrade: false, market: false };

export const balancedStrategy = managedStrategy({ priceMultiplier: 1.0, cashReserve: 8000, expandAtOccupancy: 0.9, ...ALL_SINKS });
export const greedyStrategy = managedStrategy({ priceMultiplier: 1.6, cashReserve: 8000, expandAtOccupancy: 0.9, ...ALL_SINKS });
/** Balanced play that never renovates, upgrades, or markets -- just banks the cash. */
export const hoarderStrategy = managedStrategy({ priceMultiplier: 1.0, cashReserve: 8000, expandAtOccupancy: 0.9, ...NO_SINKS });

export const STRATEGIES: Record<string, Strategy> = {
  idle: idleStrategy,
  balanced: balancedStrategy,
  greedy: greedyStrategy,
  hoarder: hoarderStrategy,
  // Housekeeping staffed below / above the estimated need, for checking there's a right amount
  understaffed: managedStrategy({ priceMultiplier: 1.0, cashReserve: 8000, expandAtOccupancy: 0.9, ...ALL_SINKS, staffing: 0.6 }),
  overstaffed: managedStrategy({ priceMultiplier: 1.0, cashReserve: 8000, expandAtOccupancy: 0.9, ...ALL_SINKS, staffing: 1.6 }),
  // One sink at a time, for measuring what each is worth
  renovateOnly: managedStrategy({ priceMultiplier: 1.0, cashReserve: 8000, expandAtOccupancy: 0.9, ...NO_SINKS, renovate: true }),
  upgradeOnly: managedStrategy({ priceMultiplier: 1.0, cashReserve: 8000, expandAtOccupancy: 0.9, ...NO_SINKS, upgrade: true }),
  marketOnly: managedStrategy({ priceMultiplier: 1.0, cashReserve: 8000, expandAtOccupancy: 0.9, ...NO_SINKS, market: true }),
};
