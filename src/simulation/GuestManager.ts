import type { Guest, GuestTrait, Room, HotelState, Booking, GameEvent, ReturningGuestProfile, PartyKind } from './types.js';
import type { PRNG } from './prng.js';
import { cleanlinessTerm } from './CleaningPreference.js';
import { ECONOMY, GUEST_TRAITS, REVIEW, STAFF, AMENITIES, GUEST_NAMES, SATISFACTION, STORY, PARTIES, GUEST_PROFILE, LOYALTY, GUEST_FAVORITES, FACILITY_CONFIG, VOICE, SPENDING, SPOTLIGHT } from '../config/balance.js';
import { getDecorReviewPenalty } from './DecorManager.js';
import { getCampaignDemandMultiplier } from './MarketingManager.js';
import { getCheckInCapacity } from './Layout.js';
import { getAvailableRooms, getElevatorWaitPenalty } from './HotelState.js';
import { facilityReviewBonus } from './FacilityManager.js';
import { reviewNoisePenalty } from './NoiseManager.js';
import { getExpectationMultiplier, getPartyFairPrice, getPriceMultiplier, getStarDemandMultiplier } from './StarRatingManager.js';
import { profileRoom, fitsParty, classPriceFactor, partyPriceFactor } from './RoomProfile.js';
import { spendingOn, spendingOf } from './Spending.js';
import { partyOf, rollParty, withParty, smallerParty, partyLabel, PartyLabel, describeParty, numberWord, sharesBeds } from './Party.js';
import { hash01 } from './Movement.js';
import { queueOn, lanesOf, deskArrivalTimes, laneBookings, quoteLane, book, patienceHours } from './DeskQueue.js';
import { voiceOn, voiceOf } from './Voice.js';
import { CHECK_IN_HOURS, roomTile } from './GuestMovement.js';
import { findRoute } from './Layout.js';
import { rollPurpose } from './Purpose.js';
import { rollProfile, checkoutHour, wantsLateCheckout, lateCheckoutPolicy, guestPace } from './Profile.js';
import { returnEntry, addToPool, dueIndexes, pickDue, tierOf, staysOf, ordinal, expectationMultFor, bookingWeightFor, isLostRegular, personIdOf } from './Loyalty.js';
import { moodOf } from './Mood.js';
import { roomFit, type RoomFeature } from './Preferences.js';
import { getTotalDemandMultiplier } from './SeasonManager.js';
import { getReputationPenaltyMultiplier } from './StoryGenerator.js';
import { spotlightOn, spotlightArrival, heldFrom, judgedStars, expectationAt, amenityRuleAt, celebrityPull, spotlightNightRate } from './Spotlight.js';

export function generateGuestTrait(prng: PRNG): GuestTrait {
  const roll = prng.next();
  if (roll < GUEST_TRAITS.lightSleeperChance) return 'light_sleeper';
  if (roll < GUEST_TRAITS.lightSleeperChance + GUEST_TRAITS.bigSpenderChance) return 'big_spender';
  if (roll < GUEST_TRAITS.lightSleeperChance + GUEST_TRAITS.bigSpenderChance + GUEST_TRAITS.partyGuestChance) return 'party_guest';
  return 'normal';
}

function generateGuestName(prng: PRNG): string {
  return GUEST_NAMES[Math.floor(prng.next() * GUEST_NAMES.length)];
}

/** A guest's nightly budget: a higher-star hotel attracts wealthier guests. */
function generateBudget(prng: PRNG, starRating: number): number {
  return prng.range(ECONOMY.guestMinBudget, ECONOMY.guestMaxBudget) * getPriceMultiplier(starRating);
}

function generateFreshGuest(prng: PRNG, day: number, starRating: number): Guest {
  const trait = generateGuestTrait(prng);
  let budget = generateBudget(prng, starRating);
  if (trait === 'big_spender') {
    budget *= GUEST_TRAITS.bigSpenderBudgetMult;
  }

  return {
    id: `guest-${day}-${Math.floor(prng.next() * 100000)}`,
    name: generateGuestName(prng),
    budget,
    stayLength: prng.int(ECONOMY.guestMinStay, ECONOMY.guestMaxStay),
    trait,
    satisfaction: SATISFACTION.initial,
    checkInDay: day,
    isReturning: false,
    hadNoiseComplaint: false,
  };
}

/** A guest pulled from returningGuestPool: same name/trait as their prior stay (design-review D7). */
function generateReturningGuest(profile: ReturningGuestProfile, prng: PRNG, day: number, starRating: number): Guest {
  let budget = generateBudget(prng, starRating);
  if (profile.trait === 'big_spender') {
    budget *= GUEST_TRAITS.bigSpenderBudgetMult;
  }

  return {
    id: `guest-${day}-${Math.floor(prng.next() * 100000)}`,
    name: profile.name,
    budget,
    stayLength: prng.int(ECONOMY.guestMinStay, ECONOMY.guestMaxStay),
    trait: profile.trait,
    satisfaction: SATISFACTION.initial,
    checkInDay: day,
    isReturning: true,
    hadNoiseComplaint: false,
    // With loyalty on: the same person, one more stay, and what they had last time
    ...(LOYALTY.enabled && profile.personId ? {
      loyalty: {
        personId: profile.personId, stays: (profile.stays ?? 1) + 1,
        ...(profile.lastRoomId ? { lastRoomId: profile.lastRoomId, lastRoomType: profile.roomType } : {}),
        ...(profile.lastReview !== undefined ? { lastReview: profile.lastReview } : {}),
      },
    } : {}),
  };
}

/**
 * Rolling word-of-mouth arrival multiplier, driven by satisfaction at checkout
 * (Satisfaction System Design, point 4). Mirrors updateReviewScore's window and
 * cold-start handling; floor/ceiling per eng-review D11 so this doesn't compound
 * unboundedly with reviewScore's own arrival penalty on the same walkouts.
 */
export function getWordOfMouthMultiplier(state: HotelState): number {
  if (state.bookings.length === 0) return 1.0;
  const recent = state.bookings.slice(-REVIEW.reviewWindowBookingCount);
  if (recent.length === 0) return 1.0;

  // A regular's or VIP's mood counts double (bookings without a weight count once, as ever)
  const weighted = recent.some(b => b.weight !== undefined);
  const avgSatisfaction = weighted
    ? recent.reduce((sum, b) => sum + b.satisfactionAtCheckout * (b.weight ?? 1), 0) / recent.reduce((sum, b) => sum + (b.weight ?? 1), 0)
    : recent.reduce((sum, b) => sum + b.satisfactionAtCheckout, 0) / recent.length;
  const normalized = (avgSatisfaction - SATISFACTION.initial) / SATISFACTION.initial; // roughly -1..+1
  const raw = 1.0 + normalized * (STORY.wordOfMouthCeilingMultiplier - 1.0);
  return Math.max(STORY.wordOfMouthFloorMultiplier, Math.min(STORY.wordOfMouthCeilingMultiplier, raw));
}

/**
 * Expected guest arrivals for the current day: a base market plus hotel
 * visibility (room count), scaled by star rating, review score, season/weekday
 * demand, word-of-mouth, any active reputation penalty (or write-up), and a
 * celebrity in the hotel the day they come.
 */
export function getExpectedArrivalsPerDay(state: HotelState): number {
  const market = ECONOMY.baseArrivalsPerDay + ECONOMY.arrivalsPerSqrtRoom * Math.sqrt(state.rooms.length);
  return market
    * getStarDemandMultiplier(state.starRating)
    * (state.reviewScore / REVIEW.arrivalScoreDivisor)
    * getTotalDemandMultiplier(state.day)
    * getWordOfMouthMultiplier(state)
    * getReputationPenaltyMultiplier(state)
    * getCampaignDemandMultiplier(state)
    * celebrityPull(state);
}

/**
 * Cheapest available room that fits the guest's party (fitsParty), that they
 * can afford, and that they consider worth the price: no more than
 * `priceTolerance` x what the room is worth to them at the hotel's current
 * star level (getPartyFairPrice -- a family room is only a double to a couple).
 * A big spender (spending styles on) takes the best of those instead: see
 * bestRoomFor.
 */
export function matchGuestToRoom(guest: Guest, availableRooms: Room[], priceTolerance: number, starRating: number): Room | null {
  const party = partyOf(guest);
  if (spendingOf(guest) === 'splurger') return bestRoomFor(guest, availableRooms, priceTolerance, starRating);
  for (const room of availableRooms) {
    if (!fitsParty(profileRoom(room), party)) continue;
    const fairPrice = getPartyFairPrice(room, party, starRating);
    if (room.pricePerNight <= guest.budget && room.pricePerNight <= fairPrice * priceTolerance) {
      return room;
    }
  }
  return null;
}

const TYPE_RANK: Record<string, number> = { standard: 0, deluxe: 1, suite: 2 };

/**
 * A big spender's room: of the rooms they'd take at all, the best that suits
 * them -- no beds they'd pay for and not use (so a couple never takes the
 * family room a family needs), then the best type, then the highest floor,
 * then the cheaper -- at no more than their tolerance over the cheapest that
 * would do (SPENDING.tradeUpCap). Ties keep the list's order.
 */
function bestRoomFor(guest: Guest, availableRooms: Room[], priceTolerance: number, starRating: number): Room | null {
  const party = partyOf(guest);
  const ok = availableRooms.filter(room => fitsParty(profileRoom(room), party) && room.pricePerNight <= guest.budget
    && room.pricePerNight <= getPartyFairPrice(room, party, starRating) * priceTolerance);
  if (ok.length === 0) return null;
  const cap = Math.min(...ok.map(r => r.pricePerNight)) * priceTolerance * SPENDING.tradeUpCap;
  const sharing = party.kind === 'couple' || party.kind === 'family';
  const rank = (room: Room): number[] => {
    const profile = profileRoom(room);
    const snug = partyPriceFactor(profile, party) === classPriceFactor(profile) && !(sharing && profile.layoutClass === 'twin');
    return [snug ? 1 : 0, TYPE_RANK[profile.type] ?? 0, room.floor, -room.pricePerNight];
  };
  const above = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  let best: Room | null = null;
  let bestRank: number[] = [];
  for (const room of ok) {
    if (room.pricePerNight > cap + 1e-9) continue;
    const r = rank(room);
    if (!best || above(r, bestRank)) { best = room; bestRank = r; }
  }
  return best;
}

/** Whether any of these rooms would take this party at all (whatever it costs). */
function anyFits(rooms: Room[], guest: Guest): boolean {
  const party = partyOf(guest);
  return rooms.some(room => fitsParty(profileRoom(room), party));
}

export interface ArrivalResult {
  checkedIn: Array<{ guest: Guest; roomId: string; desk?: DeskSlot }>; // desk: their place in the queue (with the desk queue on)
  turnedAway: number;
  events: GameEvent[];
  returningGuestPool: ReturningGuestProfile[]; // after any pulls this hour
  walkIns: Array<{ guest: Guest; outcome: 'impatient' | 'turned_away'; desk?: { arriveAt: number; lane?: string; leaveAt?: number; wanted?: PartyKind } }>; // came in but didn't stay
  spotlight?: { guest: Guest; room: Room | null; noDesk?: boolean }; // the spotlight guest, come this hour: their room, or none (gone elsewhere)
}

/** A guest's place in the front desk queue: the clerk, when they reach the desk, and when they're served. */
export interface DeskSlot { lane: string; arriveAt: number; start: number }

/**
 * A guest at the counter: the room they'll take -- a party too big for any free
 * room mostly books smaller (or goes elsewhere: noFit), a regular asks for
 * their old room first, then whatever suits at a price they'll pay -- or none.
 */
function matchAtCounter(state: HotelState, guest: Guest, remainingRooms: Room[], priceTolerance: number): { guest: Guest; room: Room | null; wanted?: PartyKind; inOldRoom: boolean; noFit?: true } {
  // No free room takes a party this big, but one would take one or two of
  // them: most book smaller, the rest go elsewhere
  const party = partyOf(guest);
  let wanted: PartyKind | undefined; // the party they were, if they book smaller
  if (!anyFits(remainingRooms, guest)) {
    const smaller = withParty(guest, smallerParty(party, guest.id));
    const fallback = anyFits(remainingRooms, smaller) ? smaller
      : smaller.party!.size > 1 ? withParty(guest, { kind: 'solo', size: 1 }) : smaller;
    if (fallback.party!.size < party.size && anyFits(remainingRooms, fallback)) {
      if (hash01(`${guest.id}#party-reroll`) < PARTIES.rerollChance) {
        guest = fallback;
        wanted = party.kind;
      } else {
        return { guest, room: null, inOldRoom: false, noFit: true };
      }
    }
  }
  // A regular asks for their old room first (the same room, still the same kind)
  const regular = LOYALTY.enabled && guest.loyalty?.lastRoomId && tierOf(staysOf(guest)) !== 'returning' && tierOf(staysOf(guest)) !== 'first';
  const oldRoom = regular ? remainingRooms.find(r => r.id === guest.loyalty!.lastRoomId && r.type === guest.loyalty!.lastRoomType) : undefined;
  const inOldRoom = oldRoom ? matchGuestToRoom(guest, [oldRoom], priceTolerance, state.starRating) : null;
  if (inOldRoom) guest = { ...guest, loyalty: { ...guest.loyalty!, oldRoom: true } };
  const room = inOldRoom ?? matchGuestToRoom(guest, remainingRooms, priceTolerance, state.starRating);
  return { guest, room, ...(wanted ? { wanted } : {}), inOldRoom: !!inOldRoom };
}

/** A party no free room takes, even booking smaller: turned away (in at `arriveAt` to ask, with the desk queue on). */
function turnAwayNoFit(result: ArrivalResult, guest: Guest, arriveAt?: number): void {
  const party = partyOf(guest);
  result.turnedAway++;
  result.walkIns.push({ guest, outcome: 'turned_away', ...(arriveAt !== undefined ? { desk: { arriveAt } } : {}) });
  const need = sharesBeds(party) ? `no room for ${numberWord(party.size)}` : `no room with ${numberWord(party.size)} beds`;
  result.events.push({
    type: 'party_turned_away',
    message: `${PartyLabel(guest)} was turned away: ${need}`,
    data: { guestId: guest.id, partyKind: party.kind, size: party.size, reason: 'no_fit' },
  });
}

/** No room at a price they'd pay: turned away (in at `arriveAt` to ask, with the desk queue on). */
function turnAwayOverPrice(result: ArrivalResult, guest: Guest, wanted?: PartyKind, arriveAt?: number): void {
  const who = partyOf(guest);
  result.turnedAway++;
  result.walkIns.push({ guest, outcome: 'turned_away', ...(arriveAt !== undefined ? { desk: { arriveAt } } : {}) });
  result.events.push({
    type: 'guest_turned_away',
    message: who.size > 2 ? `${PartyLabel(guest)} turned away (no room at a price they would pay)` : 'Guest turned away (no room at a price they would pay)',
    data: { guestId: guest.id, partyKind: who.kind, size: who.size, reason: 'price', ...(wanted ? { wanted } : {}) },
  });
}

/** A guest with a room: arriving (and, someone back, returning). */
function announceArrival(result: ArrivalResult, guest: Guest, room: Room, wanted: PartyKind | undefined, inOldRoom: boolean): void {
  const who = partyOf(guest);
  result.events.push({
    type: 'guest_arrived',
    message: who.size > 2 ? `${PartyLabel(guest)} arriving for a ${profileRoom(room).label}` : `Guest arriving for a ${room.type} room`,
    data: { guestId: guest.id, roomId: room.id, trait: guest.trait, partyKind: who.kind, size: who.size, ...(wanted ? { wanted } : {}) },
  });
  if (guest.isReturning) {
    const stays = staysOf(guest);
    const which = stays > 2 ? `their ${ordinal(stays)} stay` : 'another stay';
    result.events.push({
      type: 'guest_returned',
      // The guest who stayed before, by name: who they bring this time is new
      message: `${guest.name} is back for ${which}${who.size > 2 ? (who.kind === 'family' ? ', with the family' : ', with friends') : ''}${inOldRoom ? ', in their old room' : ''}!`,
      // (a second stay with loyalty on gets no story: its toast must show whatever's open)
      data: { guestId: guest.id, roomId: room.id, stays, ...(inOldRoom ? { oldRoom: true } : {}), ...(LOYALTY.enabled && stays < LOYALTY.regularFrom ? { unlogged: true } : {}) },
    });
  }
}

/** How far over a fair price a guest may go, against anyone else: a thrifty guest half as far, a big spender half as far again. */
function toleranceMult(guest: Guest): number {
  return SPENDING.toleranceMult[spendingOf(guest)];
}

export function processArrivals(
  state: HotelState,
  hour: number,
  prng: PRNG
): ArrivalResult {
  const result: ArrivalResult = { checkedIn: [], turnedAway: 0, events: [], returningGuestPool: state.returningGuestPool, walkIns: [] };

  if (hour < ECONOMY.checkInStartHour || hour >= ECONOMY.checkInEndHour) {
    return result;
  }

  const hoursInWindow = ECONOMY.checkInEndHour - ECONOMY.checkInStartHour;
  const arrivalsThisHour = getExpectedArrivalsPerDay(state) / hoursInWindow;

  const guaranteed = Math.floor(arrivalsThisHour);
  const extra = prng.chance(arrivalsThisHour - guaranteed) ? 1 : 0;
  const totalArrivals = guaranteed + extra;

  // Check-ins happen at a reachable desk, at the pace of the front desk staff seated there
  const checkInCapacity = getCheckInCapacity(state);

  const available = getAvailableRooms(state);
  // Rooms booked this hour (any free room is open to the next guest, cheaper or not)
  const booked = new Set<string>();
  let checkedInThisHour = 0;
  let pool = [...state.returningGuestPool];
  const lanes = queueOn() ? lanesOf(state) : [];
  const queue = lanes.length > 0 ? lanes : null; // (no lanes: nobody to queue for, as before)
  const waiting: Array<{ guest: Guest; pulled: ReturningGuestProfile | null; priceTolerance: number; reserved?: Room }> = [];
  // Guest ids come from a random draw, so two can clash: give a clash a suffix
  // (no extra draw, so the random stream stays the same) -- everything that
  // follows a guest around (their trip, their room) is keyed by id
  const taken = new Set(state.guests.map(g => g.id));
  // The spotlight guest, come this hour (Spotlight.ts; no draws): first in line, their room decided (the
  // held suite, if it's ready). With nobody at the desk, they wait, till the last hour
  let spot = spotlightArrival(state, hour, available);
  if (spot?.room && !queue && checkInCapacity === 0) spot = hour >= ECONOMY.checkInEndHour - 1 ? { guest: spot.guest, room: null, noDesk: true } : null;
  if (spot) {
    result.spotlight = spot;
    taken.add(spot.guest.id);
    if (spot.room) {
      booked.add(spot.room.id);
      if (queue) waiting.push({ guest: spot.guest, pulled: null, priceTolerance: 1, reserved: spot.room });
      else {
        checkedInThisHour++;
        result.checkedIn.push({ guest: spot.guest, roomId: spot.room.id });
        announceArrival(result, spot.guest, spot.room, undefined, false);
      }
    }
  }
  // The suite held for an announced spotlight guest is no one else's if they'd still be in it when the guest comes
  const holdOut = (rooms: Room[], g: Guest) => {
    const held = heldFrom(state, g.stayLength);
    return held ? rooms.filter(r => r.id !== held) : rooms;
  };

  for (let i = 0; i < totalArrivals; i++) {
    let guest: Guest;
    // Someone back for another stay (with loyalty on, only those due back by now)
    let pulled: ReturningGuestProfile | null = null;
    const due = dueIndexes(pool, state.day);
    if (due.length > 0 && prng.chance(STORY.returningGuestPullChance)) {
      const idx = pickDue(pool, due, prng.next());
      pulled = pool[idx];
      pool = [...pool.slice(0, idx), ...pool.slice(idx + 1)];
      guest = generateReturningGuest(pulled, prng, state.day, state.starRating);
    } else {
      guest = generateFreshGuest(prng, state.day, state.starRating);
    }
    if (taken.has(guest.id)) {
      let n = 2;
      while (taken.has(`${guest.id}-${n}`)) n++;
      guest = { ...guest, id: `${guest.id}-${n}` };
    }
    taken.add(guest.id);
    // Who the booking's for, and why they're here, from its id (so nothing
    // else's randomness moves). The purpose stays if they book smaller below.
    guest = withParty(guest, rollParty(guest.id, state.day));
    const purpose = rollPurpose(guest.id, partyOf(guest));
    if (purpose) guest = { ...guest, purpose };
    // Who they are, beyond the trip (their party and purpose lean it; a family is never rowdy)
    const profile = rollProfile(guest.id, partyOf(guest), purpose, guest.trait);
    if (profile) guest = { ...guest, profile };
    // A returning guest is who they were: their rhythm, pace, sleep and favourite (a new trip, a new party)
    if (pulled?.profile && LOYALTY.enabled && guest.profile) {
      // ...but with the family this time, never rowdy (the fresh roll knows)
      const rowdiness = partyOf(guest).kind === 'family' ? guest.profile.rowdiness : pulled.profile.rowdiness;
      // (someone first here before housekeeping preferences has one now)
      const housekeeping = pulled.profile.housekeeping ?? guest.profile.housekeeping;
      const patience = pulled.profile.patience ?? guest.profile.patience;
      const voice = pulled.profile.voice ?? guest.profile.voice;
      const spending = pulled.profile.spending ?? guest.profile.spending;
      guest = { ...guest, profile: { ...pulled.profile, rowdiness, ...(housekeeping ? { housekeeping } : {}), ...(patience ? { patience } : {}), ...(voice ? { voice } : {}), ...(spending ? { spending } : {}) } };
      // Someone first here before spending styles, thrifty now: no longer a fan of what they won't pay for
      const fav = guest.profile!.favorite;
      if (spending === 'thrifty' && (fav === 'shop' || fav === 'restaurant')) guest = { ...guest, profile: { ...guest.profile!, favorite: 'none' } };
    }
    // What they have to spend: the draw as ever, scaled by how they spend (a big spender's x1.5 is already in it)
    if (spendingOn() && guest.profile?.spending) {
      const legacy = guest.trait === 'big_spender' ? GUEST_TRAITS.bigSpenderBudgetMult : 1;
      guest = { ...guest, budget: guest.budget * SPENDING.budgetMult[guest.profile.spending] / legacy };
    }
    // Turned away (desk, room, price): with loyalty on, they'll try again another day
    const requeue = () => {
      if (pulled && LOYALTY.enabled) pool = addToPool(pool, { ...pulled, dueDay: state.day + 2 });
    };

    // With the desk queue on, everyone is decided first -- the same draws for each,
    // whatever the desk does -- and served at the desk below, in the order they arrive
    if (queue) {
      waiting.push({ guest, pulled, priceTolerance: spendingOn() ? 1 + prng.next() * ECONOMY.priceToleranceSpread * toleranceMult(guest) : 1 + prng.next() * ECONOMY.priceToleranceSpread });
      continue;
    }

    // Front desk at capacity: guest leaves impatiently
    if (checkedInThisHour >= checkInCapacity) {
      result.turnedAway++;
      result.walkIns.push({ guest, outcome: 'impatient' });
      result.events.push({
        type: 'guest_impatient',
        message: `${partyOf(guest).size > 2 ? PartyLabel(guest) : 'Guest'} left (${checkInCapacity === 0 ? 'no staffed check-in desk' : 'front desk too busy'})`,
        data: { reason: checkInCapacity === 0 ? 'no_desk' : 'front_desk_capacity', guestId: guest.id, partyKind: partyOf(guest).kind, size: partyOf(guest).size },
      });
      requeue();
      continue;
    }

    const remainingRooms = holdOut(available.filter(r => !booked.has(r.id)), guest);
    const priceTolerance = spendingOn() ? 1 + prng.next() * ECONOMY.priceToleranceSpread * toleranceMult(guest) : 1 + prng.next() * ECONOMY.priceToleranceSpread;
    const match = matchAtCounter(state, guest, remainingRooms, priceTolerance);
    if (match.noFit) {
      turnAwayNoFit(result, guest);
      requeue();
      continue;
    }
    guest = match.guest;
    if (match.room) {
      booked.add(match.room.id);
      checkedInThisHour++;
      result.checkedIn.push({ guest, roomId: match.room.id });
      announceArrival(result, guest, match.room, match.wanted, match.inOldRoom);
    } else {
      turnAwayOverPrice(result, guest, match.wanted);
      requeue();
    }
  }

  // The desk queue: in the order they reach the desk, each takes a room (as
  // ever: the party fits, a regular's old room, the price) and then the first
  // free clerk -- unless the wait would outlast their patience, when they stand
  // in line that long and walk out, and the room is the next guest's
  if (queue) {
    const T = (state.day - 1) * 24 + hour + 1;
    const arriveAt = deskArrivalTimes(state, queue, T);
    const busy = laneBookings(state, T, undefined, true); // (check-ins first: complaints are fitted round them)
    waiting.forEach(({ guest: arriving, pulled, priceTolerance, reserved }, i) => {
      let guest = arriving;
      const requeue = () => {
        if (pulled && LOYALTY.enabled) pool = addToPool(pool, { ...pulled, dueDay: state.day + 2 });
      };
      const at = arriveAt(guest.id, i, waiting.length);
      if (reserved) {
        // The spotlight guest: expected, and seen however long the line (they never give up)
        const slot = quoteLane(queue, busy, () => at, CHECK_IN_HOURS, lane => !!findRoute(state, lane.front, roomTile(reserved), guestPace(guest)))!;
        book(busy, slot.lane.key, slot.start, slot.start + CHECK_IN_HOURS);
        result.checkedIn.push({ guest, roomId: reserved.id, desk: { lane: slot.lane.key, arriveAt: at, start: slot.start } });
        announceArrival(result, guest, reserved, undefined, false);
        return;
      }
      const match = matchAtCounter(state, guest, holdOut(available.filter(r => !booked.has(r.id)), guest), priceTolerance);
      if (match.noFit) {
        turnAwayNoFit(result, guest, at);
        requeue();
        return;
      }
      guest = match.guest;
      const room = match.room;
      if (!room) {
        turnAwayOverPrice(result, guest, match.wanted, at);
        requeue();
        return;
      }
      const pace = guestPace(guest);
      const slot = quoteLane(queue, busy, () => at, CHECK_IN_HOURS, lane => !!findRoute(state, lane.front, roomTile(room), pace))!;
      const patience = patienceHours(guest);
      if (slot.start - at > patience + 1e-9) {
        // (the toast comes as they walk out: DeskQueue.recordGiveUps)
        result.turnedAway++;
        result.walkIns.push({ guest, outcome: 'impatient', desk: { arriveAt: at, lane: slot.lane.key, leaveAt: at + patience, ...(match.wanted ? { wanted: match.wanted } : {}) } });
        requeue();
        return;
      }
      book(busy, slot.lane.key, slot.start, slot.start + CHECK_IN_HOURS);
      booked.add(room.id);
      result.checkedIn.push({ guest, roomId: room.id, desk: { lane: slot.lane.key, arriveAt: at, start: slot.start } });
      announceArrival(result, guest, room, match.wanted, match.inOldRoom);
    });
  }

  result.returningGuestPool = pool;
  return result;
}

/**
 * Whether a guest's stay is up by the end of the current hour: their last
 * night is over and it's checkout time (ECONOMY.checkOutHour). The tick at
 * the end of hour 10 happens at 11:00, so that's when 11:00 checkouts leave.
 */
export function isCheckoutDue(guest: Guest, state: Pick<HotelState, 'day' | 'hour' | 'lateCheckout'>): boolean {
  return state.day - guest.checkInDay >= guest.stayLength && state.hour + 1 >= checkoutHour(guest, state);
}

/** Whether a guest leaves today (their checkout time may not have come yet). */
export function isCheckoutDay(guest: Guest, day: number): boolean {
  return day - guest.checkInDay >= guest.stayLength;
}

export interface DepartureResult {
  departed: Array<{ guest: Guest; roomId: string; booking: Booking; breakdown: GuestReviewBreakdown; lateFee?: number }>;
  events: GameEvent[];
  returningGuestPool: ReturningGuestProfile[];
}

export function processDepartures(
  state: HotelState,
  prng: PRNG
): DepartureResult {
  const result: DepartureResult = { departed: [], events: [], returningGuestPool: state.returningGuestPool };
  let pool = [...state.returningGuestPool];

  for (const stayed of state.guests) {
    if (isCheckoutDue(stayed, state)) {
      const room = state.rooms.find(r => r.status === 'occupied' && r.guestId === stayed.id);
      if (!room) continue;
      // A night owl who asked for a late checkout: refused (a little put out), or granted (for a fee, maybe)
      const policy = lateCheckoutPolicy(state);
      const refused = wantsLateCheckout(stayed) && policy === 'deny';
      const guest = refused ? { ...stayed, satisfaction: Math.max(0, stayed.satisfaction - GUEST_PROFILE.lateCheckoutRefused) } : stayed;
      const lateFee = wantsLateCheckout(stayed) && policy === 'fee' ? Math.round(room.pricePerNight * GUEST_PROFILE.lateCheckoutFee) : 0;

      const breakdown = calculateGuestReviewBreakdown(room, state, guest, prng);
      const score = breakdown.finalScore;
      const rate = spotlightOn() && guest.spotlight?.rate ? spotlightNightRate(guest, room.pricePerNight) : room.pricePerNight; // (a celebrity on the top floor pays double)
      const totalPaid = rate * guest.stayLength + lateFee;

      const weight = bookingWeightFor(guest);
      const booking: Booking = {
        id: `booking-${guest.id}`,
        roomId: room.id,
        guestId: guest.id,
        nightRate: rate,
        reviewScore: score,
        satisfactionAtCheckout: guest.satisfaction,
        ...(weight ? { weight } : {}),
      };

      result.departed.push({ guest, roomId: room.id, booking, breakdown, ...(lateFee > 0 ? { lateFee } : {}) });
      result.events.push({
        type: 'guest_departed',
        message: `${partyOf(guest).size > 2 ? PartyLabel(guest) : 'Guest'} checked out (${score.toFixed(1)}/10, $${totalPaid})`,
        data: {
          guestId: guest.id, roomId: room.id, reviewScore: score, totalPaid, partyKind: partyOf(guest).kind, size: partyOf(guest).size,
          roomFit: breakdown.roomFit, liked: !!breakdown.roomLikes, disliked: !!breakdown.roomDislikes, noisePenalty: breakdown.noisePenalty,
          mood: moodOf(guest.satisfaction), stays: staysOf(guest), favoriteMisses: guest.favoriteMisses?.count ?? 0,
        },
      });

      // Will they be back? (Satisfaction System Design, point 3; Loyalty.ts)
      const entry = spotlightOn() && guest.spotlight ? null : returnEntry(guest, guest.satisfaction, room, score, state.day); // (a spotlight guest is a one-off)
      if (entry) pool = addToPool(pool, entry);
      else if (isLostRegular(guest, score)) {
        result.events.push({
          type: 'regular_lost',
          message: `${guest.name} won't be back: their ${ordinal(staysOf(guest))} stay was a letdown`,
          data: { guestId: guest.id, personId: personIdOf(guest), roomId: room.id, stays: staysOf(guest) },
        });
      }
    }
  }

  result.returningGuestPool = pool;
  return result;
}

export interface GuestReviewBreakdown {
  noisePenalty: number;
  decorPenalty: number;
  elevatorPenalty: number;
  conditionBonus: number;
  cleanlinessBonus: number;
  amenityPenalty: number;
  priceFairness: number; // fairness ratio (1 = perfect match, lower = worse in either direction), as the guest felt it (a thrifty guest overcharged minds more)
  guestVariance: number;
  facilityBonus: number;
  amenityBonus: number;
  roomFit: number; // how well the room suited them (Preferences.ts): what they liked, less what they didn't
  roomLikes?: RoomFeature[];
  roomDislikes?: RoomFeature[];
  favoriteMiss?: number; // their favourite facility let them down (missing, or full)
  favoriteMissLabel?: string; // "the pool"
  expectation?: number; // a travel writer's: how hard they minded what was wrong (x the room's penalties; see Spotlight.nameReview)
  finalScore: number;
}

/**
 * Calculate a guest's review score (0-10), and the components that produced
 * it (design-review-required refactor, eng-review D4: attribution rule for
 * Review Goes Semi-Viral, and walkout Bookings need the real breakdown, not
 * just the final score). Higher star hotels have higher expectations, so the
 * same service produces lower scores at a 5-star vs a 2-star hotel.
 */
export function calculateGuestReviewBreakdown(
  room: Room,
  state: HotelState,
  guest: Guest,
  prng: PRNG
): GuestReviewBreakdown {
  const expectedPrice = getPartyFairPrice(room, partyOf(guest), state.starRating);
  // How they spend (spending styles on) weighs a few things: a thrifty guest minds being overcharged
  // more and the amenities less, a big spender the amenities and the decor more
  const style = spendingOf(guest);
  const fair = 1 - Math.abs(room.pricePerNight - expectedPrice) / expectedPrice;
  const overcharge = style !== 'standard' && room.pricePerNight > expectedPrice ? SPENDING.review.overcharge[style] : 1;
  const priceFairness = overcharge === 1 ? fair : 1 - (1 - fair) * overcharge; // (as they felt it)

  // Noise: the nights they slept through (or, with profiles off, the noise now)
  const noisePenalty = reviewNoisePenalty(room, state, guest);

  // Condition and cleanliness
  const conditionBonus = (room.condition - REVIEW.conditionMidpoint) / REVIEW.conditionScale * REVIEW.conditionWeight;
  const cleanlinessBonus = cleanlinessTerm(room.cleanliness, guest); // (a guest who wants the room made up daily minds more)
  const decorPenalty = style === 'standard' ? getDecorReviewPenalty(room.decor) : getDecorReviewPenalty(room.decor) * SPENDING.review.decorPenalty[style];
  const elevatorPenalty = getElevatorWaitPenalty(state, room, guest);

  // Facilities the guest actually used this stay (gym, restaurant, pool, shop)
  const facilityBonus = facilityReviewBonus(guest, state.day);

  // In-room amenities bonus
  const amenityTier = state.amenities[room.type];
  const amenityConfig = AMENITIES.tiers[amenityTier];
  let amenityBonus = style === 'standard' ? amenityConfig?.reviewBonus ?? 0 : (amenityConfig?.reviewBonus ?? 0) * SPENDING.review.amenityBonus[style];

  // Amenity expectation penalty: high-star hotels with low amenities get penalized
  let amenityPenalty = 0;
  const judged = judgedStars(guest, state.starRating);
  if (judged !== state.starRating) {
    // A travel writer judges the hotel a class up: what that class must have is no bonus, and short of it, a fault
    const rule = amenityRuleAt(judged);
    if (rule) {
      const tierOrder = ['basic', 'premium', 'luxury'];
      if (SPOTLIGHT.writer.parAmenities) amenityBonus = Math.max(0, amenityBonus - (AMENITIES.tiers[rule.minimumTier]?.reviewBonus ?? 0));
      if (tierOrder.indexOf(amenityTier) < tierOrder.indexOf(rule.minimumTier)) amenityPenalty = rule.penaltyIfBelow;
    }
  } else for (const req of AMENITIES.starExpectations) {
    if (state.starRating >= req.minStars) {
      const tierOrder = ['basic', 'premium', 'luxury'];
      const currentIdx = tierOrder.indexOf(amenityTier);
      const requiredIdx = tierOrder.indexOf(req.minimumTier);
      if (currentIdx < requiredIdx) {
        amenityPenalty = style === 'standard' ? req.penaltyIfBelow : req.penaltyIfBelow * SPENDING.review.amenityPenalty[style];
      }
      break;
    }
  }

  // What they liked (or didn't) in the room: their purpose, party and trait against its furniture
  const fit = roomFit(profileRoom(room), guest);

  // Their favourite facility let them down (missing, or full): a little off the review, a day at a time
  const favorite = guest.profile?.favorite;
  const misses = GUEST_FAVORITES.enabled ? Math.min(GUEST_FAVORITES.maxMissesPerStay, guest.favoriteMisses?.count ?? 0) : 0;
  const favoriteMiss = misses * GUEST_FAVORITES.missReview;

  // Random variance (a spotlight guest's from their id: no draw)
  const guestVariance = spotlightOn() && guest.spotlight ? (hash01(`${guest.id}#variance`) * 2 - 1) * REVIEW.varianceRange : prng.range(-REVIEW.varianceRange, REVIEW.varianceRange);

  // Raw score before expectation adjustment
  const rawScore = REVIEW.baseScore
    + priceFairness * REVIEW.basePriceFairnessWeight
    - noisePenalty
    - decorPenalty
    - elevatorPenalty
    + conditionBonus
    + cleanlinessBonus
    + amenityBonus
    + facilityBonus
    - amenityPenalty
    + fit.score
    - favoriteMiss
    + guestVariance;

  // Apply star expectation multiplier to penalties
  // Higher star = penalties are amplified, bonuses stay the same
  // (the loyal forgive more; a stoic guest, saying nothing at the time, minds more)
  const expectation = (judged !== state.starRating ? expectationAt(judged) : getExpectationMultiplier(state.starRating)) * expectationMultFor(guest) * (voiceOn() ? VOICE.reviewPenaltyMult[voiceOf(guest)] : 1);
  const penalties = noisePenalty + decorPenalty + elevatorPenalty + Math.max(0, -conditionBonus) + Math.max(0, -cleanlinessBonus) + amenityPenalty;
  const expectationAdjustment = penalties * (expectation - 1);

  const finalScore = rawScore - expectationAdjustment;
  const clampedScore = Math.max(REVIEW.minScore, Math.min(REVIEW.maxScore, finalScore));

  return {
    noisePenalty,
    decorPenalty,
    elevatorPenalty,
    conditionBonus,
    cleanlinessBonus,
    amenityPenalty,
    priceFairness,
    guestVariance,
    facilityBonus,
    amenityBonus,
    roomFit: fit.score,
    ...(favoriteMiss > 0 && favorite && favorite !== 'none' ? { favoriteMiss, favoriteMissLabel: `the ${FACILITY_CONFIG[favorite].label.toLowerCase()}` } : {}),
    ...(fit.likes.length > 0 ? { roomLikes: fit.likes } : {}),
    ...(fit.dislikes.length > 0 ? { roomDislikes: fit.dislikes } : {}),
    ...(judged !== state.starRating ? { expectation } : {}), // (a travel writer's: how hard they minded what was wrong)
    finalScore: clampedScore,
  };
}

/**
 * Calculate a guest's review score (0-10). Byte-identical to the pre-refactor
 * implementation -- callers that only need the final number don't need to
 * change; use calculateGuestReviewBreakdown when the components matter.
 */
export function calculateGuestReview(
  room: Room,
  state: HotelState,
  guest: Guest,
  prng: PRNG
): number {
  return calculateGuestReviewBreakdown(room, state, guest, prng).finalScore;
}
