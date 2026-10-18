import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom, addFacility, addFixture } from '../src/simulation/HotelState.js';
import { rollProfile, noiseOutputMult } from '../src/simulation/Profile.js';
import { processDailyHousekeeping, processCleaningTick, degradeCleanliness, estimateHousekeepingHours } from '../src/simulation/HousekeepingManager.js';
import { planStaff, restingPlace } from '../src/simulation/StaffManager.js';
import {
  housekeepingPrefOf, cleanlinessTerm, awayStretches, partyOutOfRoom, dndCleanStart, describeHousekeeping,
} from '../src/simulation/CleaningPreference.js';
import { calculateGuestReviewBreakdown, processArrivals } from '../src/simulation/GuestManager.js';
import { driftSatisfaction, advanceIncidents } from '../src/simulation/StoryGenerator.js';
import { roomCleaningAt, summarizeCleaning, describeWait } from '../src/simulation/CleaningStatus.js';
import { findRoute, routeToStreet, routeFromStreet, isEntranceTile } from '../src/simulation/Layout.js';
import { roomTile, rerouteTrips, isGuestAway } from '../src/simulation/GuestMovement.js';
import { makeWalk, makeStay, hourStart, legsEnd, memberPositionAt, positionAt, hash01 } from '../src/simulation/Movement.js';
import { calculateRoomNoise, getLoudestNeighborGuestId, occupantNoiseOutput, nightNoiseThisHour } from '../src/simulation/NoiseManager.js';
import { visitorsAt, isHosting, isAsleepAt, hostingDay, visitorPolicy } from '../src/simulation/Visitors.js';
import { planVisitors, askToKeepItDown, fileVisitorComplaints, sendOrphanedVisitorsHome, describeVisitors, clockTime } from '../src/simulation/HostedNights.js';
import { planOutings } from '../src/simulation/OutingManager.js';
import { planFacilityVisits } from '../src/simulation/FacilityManager.js';
import { guestFigures } from '../src/render/figures.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { PRNG } from '../src/simulation/prng.js';
import { perPersonFactor } from '../src/simulation/Party.js';
import {
  GUEST_HOUSEKEEPING, HOSTED_NIGHTS, GUEST_PROFILE, HOUSEKEEPING, STAFF, TRAVEL, NOISE, SATISFACTION, GUEST_OUTINGS, FACILITY_CONFIG, LOYALTY, STORY,
} from '../src/config/balance.js';
import type { Guest, GuestProfile, HotelState, Leg, Party, StayLeg, Walker } from '../src/simulation/types.js';

const PROFILE: GuestProfile = { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11 };
const with_ = (extra: Partial<GuestProfile>): GuestProfile => ({ ...PROFILE, ...extra });
const PACE = TRAVEL.guestHoursPerTile;

function guest(id: string, extra: Partial<Guest> = {}): Guest {
  return {
    id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
    profile: PROFILE, ...extra,
  };
}

/** The starter hotel with standard rooms on row 2 from x = 3 (doors up), each with one of these guests in it. */
function hotel(guests: Guest[], extra: Partial<HotelState> = {}): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
  for (let x = 0; x < guests.length; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
  return {
    ...s, day: 3, hour: 12, noiseSources: [], guests,
    rooms: s.rooms.map((r, i) => ({ ...r, status: 'occupied' as const, guestId: guests[i].id })),
    ...extra,
  };
}

const roomOf = (s: HotelState, id: string) => s.rooms.find(r => r.guestId === id)!;

/** A guest out for the day: down to the street at `leave`, back in their room at `back`. */
function outing(s: HotelState, g: Guest, leave: number, back: number): Guest {
  const tile = roomTile(roomOf(s, g.id));
  const out = routeToStreet(s, tile, PACE)!;
  const inn = routeFromStreet(s, tile, PACE)!;
  const walkOut = makeWalk(out.path, leave, PACE);
  const walkBack = makeWalk(inn.path, back - (makeWalk(inn.path, 0, PACE).end), PACE);
  return { ...g, tripKind: 'outing', trip: [walkOut, makeStay(out.path[out.path.length - 1], walkOut.end, walkBack.start, 'away'), walkBack] };
}

/** Queue a daily clean in every room. */
const due = (s: HotelState, hours = 0.5): HotelState => ({ ...s, rooms: s.rooms.map(r => ({ ...r, dailyCleanHoursRemaining: hours })) });

/** Every daily-clean stay in a plan, by room. */
function dailyStays(plan: ReturnType<typeof planStaff>): StayLeg[] {
  return plan.itineraries.flatMap(it => it.legs).filter((l): l is StayLeg => l.kind === 'stay' && l.job === 'daily');
}

function withSwitch<T>(sw: { enabled: boolean }, on: boolean, fn: () => T): T {
  const was = sw.enabled;
  sw.enabled = on;
  try { return fn(); } finally { sw.enabled = was; }
}

describe('Housekeeping preference: who wants what', () => {
  it('is rolled with the profile: about a quarter do not disturb, a fifth want the room made up; business leans make-up, getaways leave-alone', () => {
    const share = (party: Party, purpose: 'business' | 'sightseeing' | 'getaway', pref: string) => {
      let k = 0;
      for (let i = 0; i < 6000; i++) if (rollProfile(`h${i}`, party, purpose, 'normal')!.housekeeping === pref) k++;
      return k / 6000;
    };
    expect(Math.abs(share({ kind: 'couple', size: 2 }, 'sightseeing', 'dnd') - 0.25)).toBeLessThan(0.02);
    expect(Math.abs(share({ kind: 'couple', size: 2 }, 'sightseeing', 'makeup') - 0.2)).toBeLessThan(0.02);
    expect(share({ kind: 'business', size: 1 }, 'business', 'makeup')).toBeGreaterThan(0.26);
    expect(share({ kind: 'couple', size: 2 }, 'getaway', 'dnd')).toBeGreaterThan(0.31);
    expect(rollProfile('x', { kind: 'solo', size: 1 }, 'sightseeing', 'normal')).toEqual(rollProfile('x', { kind: 'solo', size: 1 }, 'sightseeing', 'normal'));
    withSwitch(GUEST_HOUSEKEEPING, false, () => expect(rollProfile('x', { kind: 'solo', size: 1 }, 'sightseeing', 'normal')!.housekeeping).toBeUndefined());
  });

  it('missing (an older profile) or switched off, everyone is standard', () => {
    expect(housekeepingPrefOf(guest('a'))).toBe('standard');
    expect(housekeepingPrefOf(undefined)).toBe('standard');
    expect(housekeepingPrefOf(guest('a', { profile: with_({ housekeeping: 'dnd' }) }))).toBe('dnd');
    withSwitch(GUEST_HOUSEKEEPING, false, () => expect(housekeepingPrefOf(guest('a', { profile: with_({ housekeeping: 'dnd' }) }))).toBe('standard'));
  });

  it('someone back from before preferences gets one now; someone who had one keeps it', () => {
    let s: HotelState = { ...hotel([]), day: 30, hour: 15, staff: { ...createStarterHotel().staff, frontDesk: 6 } };
    for (let x = 0; x < 4; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
    const pool = (profile: GuestProfile) => [{ name: 'Mei', trait: 'normal' as const, roomType: 'standard' as const, personId: 'mei', stays: 2, profile, lastReview: 8, dueDay: 20 }];
    const back = (state: HotelState) => {
      for (let seed = 1; seed < 400; seed++) {
        const c = processArrivals(state, 15, new PRNG(seed)).checkedIn.find(x => x.guest.name === 'Mei' && x.guest.isReturning);
        if (c) return c.guest;
      }
      return undefined;
    };
    const fresh = back({ ...s, returningGuestPool: pool(with_({ favorite: 'gym' })) })!;
    const rolled = rollProfile(fresh.id, fresh.party!, fresh.purpose, fresh.trait)!;
    expect(fresh.profile!.housekeeping).toBe(rolled.housekeeping);
    // (and a patience and a voice, for someone first here before those)
    expect([fresh.profile!.patience, fresh.profile!.voice]).toEqual([rolled.patience, rolled.voice]);
    expect(rolled.patience && rolled.voice).toBeTruthy();
    expect(back({ ...s, returningGuestPool: pool(with_({ housekeeping: 'makeup', patience: 'patient', voice: 'stoic' })) })!.profile).toMatchObject({ housekeeping: 'makeup', patience: 'patient', voice: 'stoic' });
    expect(LOYALTY.enabled).toBe(true);
  });
});

describe('Make up daily', () => {
  it('every other day: on the off days only make-up rooms are queued (none with the switch off); "none" means none', () => {
    const guests = [guest('m', { profile: with_({ housekeeping: 'makeup' }) }), guest('s'), guest('d', { profile: with_({ housekeeping: 'dnd' }) })];
    const s = hotel(guests, { hour: HOUSEKEEPING.dailyCleaningHour, housekeeping: { turnoverQuality: 'standard', dailyCadence: 'every_other_day' } });
    const queued = (state: HotelState) => processDailyHousekeeping(state).state.rooms.map(r => r.dailyCleanHoursRemaining > 0);
    expect(queued({ ...s, day: 3 })).toEqual([true, false, false]);
    expect(queued({ ...s, day: 4 })).toEqual([true, true, true]);
    withSwitch(GUEST_HOUSEKEEPING, false, () => expect(queued({ ...s, day: 3 })).toEqual([false, false, false]));
    expect(queued({ ...s, day: 3, housekeeping: { turnoverQuality: 'standard', dailyCadence: 'none' } })).toEqual([false, false, false]);
  });

  it('make-up rooms are cleaned before standard ones (a do-not-disturb room whose guests are out before either)', () => {
    let s = hotel([
      guest('s', { profile: with_({}) }),
      guest('m', { profile: with_({ housekeeping: 'makeup' }) }),
      guest('d', { profile: with_({ housekeeping: 'dnd' }) }),
    ], { staff: { ...createStarterHotel().staff, housekeepers: 1 } });
    s = due(s, 0.2);
    s = { ...s, rooms: s.rooms.map(r => ({ ...r, cleanliness: r.guestId === 's' ? 10 : 70 })) }; // the standard room's the dirtiest
    const T = hourStart(s);
    s = { ...s, guests: s.guests.map(g => (g.id === 'd' ? outing(s, g, T - 1, T + 4) : g)) };
    expect(dailyStays(planStaff(s)).map(l => l.placeId)).toEqual(['d', 'm', 's'].map(id => roomOf(s, id).id));
    // Off: dirtiest first, as ever (the do-not-disturb guest is out: first)
    withSwitch(GUEST_HOUSEKEEPING, false, () => expect(dailyStays(planStaff(s)).map(l => l.placeId)).toEqual(['d', 's', 'm'].map(id => roomOf(s, id).id)));
  });

  it('a make-up guest minds cleanliness 1.6x as much either side of a well-kept room: it costs them when a clean is missed', () => {
    const std = guest('s');
    const mk = guest('m', { profile: with_({ housekeeping: 'makeup' }) });
    const weight = HOUSEKEEPING.cleanlinessWeight;
    const missed = GUEST_HOUSEKEEPING.makeupExpects - HOUSEKEEPING.cleanlinessDecayPerDay; // a clean missed: another night on
    expect(cleanlinessTerm(70, std)).toBeCloseTo((70 - 50) / 100 * weight, 12);
    expect(cleanlinessTerm(GUEST_HOUSEKEEPING.makeupExpects, mk)).toBeCloseTo(cleanlinessTerm(GUEST_HOUSEKEEPING.makeupExpects, std), 12);
    expect(cleanlinessTerm(missed, mk) - cleanlinessTerm(missed, std)).toBeCloseTo(-(GUEST_HOUSEKEEPING.makeupExpects - missed) / 100 * weight * 0.6, 12);
    expect(cleanlinessTerm(100, mk)).toBeGreaterThan(cleanlinessTerm(100, std));
    withSwitch(GUEST_HOUSEKEEPING, false, () => expect(cleanlinessTerm(missed, mk)).toBe(cleanlinessTerm(missed, std)));
    // In the review, and in the mood
    const s = hotel([std, mk]);
    const dirty = { ...s, rooms: s.rooms.map(r => ({ ...r, cleanliness: missed, condition: 100 })) };
    const review = (g: Guest) => calculateGuestReviewBreakdown(roomOf(dirty, g.id), dirty, g, new PRNG(1));
    expect(review(mk).cleanlinessBonus).toBeCloseTo(cleanlinessTerm(missed, mk), 12);
    expect(review(mk).finalScore).toBeLessThan(review(std).finalScore);
    const drifted = driftSatisfaction(dirty).guests;
    expect(drifted[1].satisfaction).toBeLessThan(drifted[0].satisfaction);
  });

  it('nobody is woken for a daily clean: a night owl\'s room waits till they\'re up (profiles off: as ever)', () => {
    let s = hotel([guest('o', { profile: with_({ chronotype: 'night' }) }), guest('r')], { hour: 8, staff: { ...createStarterHotel().staff, housekeepers: 2 } });
    s = due(s);
    const cleaned = (st: HotelState) => dailyStays(planStaff(st)).map(l => l.placeId);
    expect(GUEST_PROFILE.sleepHours.night[1]).toBeGreaterThan(8); // (still asleep at 08:00)
    expect(cleaned(s)).toEqual([roomOf(s, 'r').id]);
    expect(describeWait(roomCleaningAt(s, hourStart(s) + 0.5).get(roomOf(s, 'o').id)!.wait!)).toBe('the guests are asleep');
    expect(cleaned({ ...s, hour: GUEST_PROFILE.sleepHours.night[1] }).sort()).toEqual(s.rooms.map(r => r.id).sort());
    // Out of the room, asleep or not, nobody's disturbed
    const out = { ...s, guests: s.guests.map(g => (g.id === 'o' ? outing(s, g, hourStart(s) - 1, hourStart(s) + 4) : g)) };
    expect(cleaned(out).sort()).toEqual(s.rooms.map(r => r.id).sort());
    withSwitch(GUEST_PROFILE, false, () => expect(cleaned(s).sort()).toEqual(s.rooms.map(r => r.id).sort()));
  });

  it('the staffing estimate counts make-up rooms on the off days', () => {
    const s = hotel([guest('a')], { housekeeping: { turnoverQuality: 'standard', dailyCadence: 'every_other_day' } });
    const on = estimateHousekeepingHours(s, 0.8);
    const off = withSwitch(GUEST_HOUSEKEEPING, false, () => estimateHousekeepingHours(s, 0.8));
    expect(on).toBeGreaterThan(off);
    const daily = { ...s, housekeeping: { turnoverQuality: 'standard' as const, dailyCadence: 'daily' as const } };
    expect(estimateHousekeepingHours(daily, 0.8)).toBe(withSwitch(GUEST_HOUSEKEEPING, false, () => estimateHousekeepingHours(daily, 0.8)));
  });
});

describe('Do not disturb', () => {
  const dndHotel = (extra: Partial<Guest> = {}) => {
    const s = hotel([guest('d', { profile: with_({ housekeeping: 'dnd' }), ...extra }), guest('s')], { staff: { ...createStarterHotel().staff, housekeepers: 1 } });
    return due(s);
  };
  const walkThere = (s: HotelState) => findRoute(s, restingPlace(s, 0)!.at, roomTile(roomOf(s, 'd')), TRAVEL.hoursPerTile)!.hours;

  it('a guest at home is never disturbed: the housekeeper cleans the room next door instead', () => {
    const s = dndHotel();
    const stays = dailyStays(planStaff(s));
    expect(stays.map(l => l.placeId)).toEqual([roomOf(s, 's').id]);
    // Off: their room's cleaned like any other
    withSwitch(GUEST_HOUSEKEEPING, false, () => expect(dailyStays(planStaff(s)).map(l => l.placeId)).toContain(roomOf(s, 'd').id));
  });

  /** Where a housekeeper is (rounded to a tile) at each moment of their hour, and whether any of the party is in the room then. */
  function inWithGuests(plan: ReturnType<typeof planStaff>, g: Guest, room: { gridX: number; gridY: number; floor: number }, size: number): number[] {
    const clashes: number[] = [];
    for (const it of plan.itineraries) {
      if (it.legs.length === 0) continue;
      for (let t = it.legs[0].start; t < legsEnd(it.legs); t += 0.005) {
        const at = positionAt(it.legs, t)!;
        if (Math.round(at.x) !== room.gridX || Math.round(at.y) !== room.gridY || at.floor !== room.floor) continue;
        const trip = g.trip ?? [];
        const onTrip = trip.length > 0 && t >= trip[0].start && t < legsEnd(trip);
        const anyoneIn = !onTrip || Array.from({ length: size }, (_, m) => memberPositionAt(trip, t, m)!)
          .some(p => Math.round(p.x) === room.gridX && Math.round(p.y) === room.gridY && p.floor === room.floor);
        if (anyoneIn) clashes.push(t);
      }
    }
    return clashes;
  }
  const STEP = TRAVEL.hoursPerTile; // a housekeeper's step

  it('cleaned while they are out, every one of them, start to finish; the housekeeper waits outside the door for them to go, then steps in', () => {
    let s = dndHotel({ party: { kind: 'friends', size: 3 } });
    const T = hourStart(s);
    const atDoor = T + walkThere(s) - STEP;
    s = { ...s, guests: s.guests.map(g => (g.id === 'd' ? outing(s, g, atDoor + 0.1, T + 4) : g)) };
    const g = s.guests[0];
    const room = roomOf(s, 'd');
    const plan = planStaff(s);
    const legs = plan.itineraries[0].legs;
    const clean = legs.find(l => l.kind === 'stay' && l.job === 'daily' && l.placeId === room.id) as StayLeg;
    expect(clean).toBeTruthy();
    const [[from, to]] = awayStretches(g, room);
    expect(from).toBeCloseTo(atDoor + 0.1 + PACE, 9); // once the last of them has stepped out of the door
    expect(clean.start).toBeCloseTo(from + STEP, 9); // then a step in
    expect(clean.end + STEP).toBeLessThanOrEqual(to + 1e-9); // and out again before they're back
    const [wait, stepIn] = legs.slice(legs.indexOf(clean) - 2, legs.indexOf(clean)) as [StayLeg, Leg];
    expect([wait.kind, wait.activity, wait.at.gridX, wait.at.gridY]).toEqual(['stay', 'wait', room.gridX, room.gridY - 1]); // in the hallway, at the door
    expect(wait.end - wait.start).toBeLessThanOrEqual(GUEST_HOUSEKEEPING.dndMaxWait + 1e-9);
    expect(stepIn.kind === 'walk' && stepIn.start === wait.end && stepIn.path.length === 2).toBe(true);
    expect(inWithGuests(plan, g, room, 3)).toEqual([]);
  });

  it('slow to go: the housekeeper does something else first and comes back once they have gone, or sets off in time; never waits long, never goes in with them', () => {
    const s = dndHotel();
    const T = hourStart(s);
    const atDoor = T + walkThere(s) - STEP;
    const leave = atDoor + GUEST_HOUSEKEEPING.dndMaxWait + 0.05;
    const room = roomOf(s, 'd');
    const out = (state: HotelState, l: number, back: number) => ({ ...state, guests: state.guests.map(g => (g.id === 'd' ? outing(state, g, l, back) : g)) });
    // With the room next door to do first: that, then back for theirs
    const busy = out(s, leave, T + 4);
    const plan = planStaff(busy);
    expect(dailyStays(plan).map(l => l.placeId)).toEqual([roomOf(s, 's').id, room.id]);
    expect(inWithGuests(plan, busy.guests[0], room, 1)).toEqual([]);
    // With nothing else to do: they rest, then set off to be at the door as the party goes
    const alone = { ...out(s, leave, T + 4), rooms: busy.rooms.map(r => (r.id === room.id ? r : { ...r, dailyCleanHoursRemaining: 0 })) };
    const legs = planStaff(alone).itineraries[0].legs;
    const clean = legs.find(l => l.kind === 'stay' && l.job === 'daily') as StayLeg;
    const [[from]] = awayStretches(alone.guests[0], room);
    expect(clean.start).toBeCloseTo(from + STEP, 9);
    expect(legs.filter(l => l.kind === 'stay' && l.activity === 'wait').every(l => l.end - l.start <= GUEST_HOUSEKEEPING.dndMaxWait + 1e-9)).toBe(true);
    expect(legs[0]).toMatchObject({ kind: 'stay', activity: 'rest' });
    expect(inWithGuests(planStaff(alone), alone.guests[0], room, 1)).toEqual([]);
    // Back too soon to finish: not at all
    expect(dailyStays(planStaff(out(s, T - 1, atDoor + 0.4))).map(l => l.placeId)).not.toContain(room.id);
    expect(dailyStays(planStaff(out(s, T - 1, T + 4))).map(l => l.placeId)).toContain(room.id);
  });

  it('the clean leaves time to step back out before the party is back (a party of three, the lead walking ahead)', () => {
    let s = dndHotel({ party: { kind: 'friends', size: 3 } });
    const T = hourStart(s);
    const atDoor = T + walkThere(s) - STEP;
    const room = roomOf(s, 'd');
    // Back with just enough time for a step in and the clean, but not the step out
    s = { ...s, guests: s.guests.map(g => (g.id === 'd' ? outing(s, g, T - 1, atDoor + STEP + 0.5 + PACE + 0.01) : g)) };
    const plan = planStaff(s);
    expect(dailyStays(plan).map(l => l.placeId)).not.toContain(room.id);
    expect(inWithGuests(plan, s.guests[0], room, 3)).toEqual([]);
    // With the step out too: cleaned, and out before they're in
    const roomy = { ...s, guests: s.guests.map(g => (g.id === 'd' ? outing(s, g, T - 1, atDoor + 2 * STEP + 0.5 + PACE + 0.01) : g)) };
    expect(dailyStays(planStaff(roomy)).map(l => l.placeId)).toContain(room.id);
    expect(inWithGuests(planStaff(roomy), roomy.guests[0], room, 3)).toEqual([]);
  });

  it('waiting for a party to go out later, a housekeeper never waits inside a room (not even the one just cleaned)', () => {
    let s = hotel([
      guest('d', { profile: with_({ housekeeping: 'dnd' }), party: { kind: 'couple', size: 2 } }),
      guest('e', { profile: with_({ housekeeping: 'dnd' }), party: { kind: 'couple', size: 2 } }),
    ], { staff: { ...createStarterHotel().staff, housekeepers: 1 } });
    s = due(s);
    const T = hourStart(s);
    const d = roomOf(s, 'd');
    const e = roomOf(s, 'e');
    s = { ...s, rooms: s.rooms.map(r => (r.id === d.id ? { ...r, dailyCleanHoursRemaining: 0.2 } : r)) };
    // d is out (back long after); e is in for now
    s = { ...s, guests: s.guests.map(g => (g.id === 'd' ? outing(s, g, T - 1, T + 4) : g)) };
    const done = dailyStays(planStaff(s)).find(l => l.placeId === d.id)!.end;
    // e goes out a while after d's room is done: too late to wait at the door for, too soon to go and rest first
    const eLeaves = done + STEP + GUEST_HOUSEKEEPING.dndMaxWait + 0.05 - PACE;
    s = { ...s, guests: s.guests.map(g => (g.id === 'e' ? outing(s, g, eLeaves, T + 4) : g)) };
    const plan = planStaff(s);
    expect(dailyStays(plan).map(l => l.placeId)).toEqual([d.id, e.id]);
    const legs = plan.itineraries[0].legs;
    const idle = legs.filter(l => l.kind === 'stay' && !l.job) as StayLeg[];
    expect(idle.some(l => l.activity === 'wait' && l.end - l.start > GUEST_HOUSEKEEPING.dndMaxWait)).toBe(true); // waited a while somewhere
    for (const l of idle) expect(s.rooms.some(r => r.gridX === l.at.gridX && r.gridY === l.at.gridY && r.floor === l.at.floor)).toBe(false);
    expect(inWithGuests(plan, s.guests[0], d, 2)).toEqual([]);
    expect(inWithGuests(plan, s.guests[1], e, 2)).toEqual([]);
  });

  it('a clean cut at the bell carries on next hour, even with only a step’s time to spare', () => {
    let s = due(dndHotel(), 1.5);
    s = { ...s, rooms: s.rooms.map(r => (r.guestId === 's' ? { ...r, dailyCleanHoursRemaining: 0 } : r)) };
    const T = hourStart(s);
    const room = roomOf(s, 'd');
    const generous = { ...s, guests: s.guests.map(g => (g.id === 'd' ? outing(s, g, T - 1, T + 5) : g)) };
    const first = dailyStays(planStaff(generous)).find(l => l.placeId === room.id)!;
    expect(first.end).toBeCloseTo(T + 1, 9); // cut at the bell
    // Back just in time: the rest of the clean and a step out, with a hair to spare
    const tight = { ...s, guests: s.guests.map(g => (g.id === 'd' ? outing(s, g, T - 1, first.start + 1.5 + STEP + 0.01 + PACE) : g)) };
    const planned = { ...tight, staffPlan: planStaff(tight) };
    expect(dailyStays(planned.staffPlan!).find(l => l.placeId === room.id)!.start).toBeCloseTo(first.start, 9);
    const next = tickSimulation(planned, new PRNG(1)).state;
    const carry = dailyStays(next.staffPlan!).find(l => l.placeId === room.id);
    expect(carry).toBeTruthy();
    expect(carry!.start).toBeCloseTo(T + 1, 9);
    expect(inWithGuests(next.staffPlan!, next.guests.find(g => g.id === 'd')!, room, 1)).toEqual([]);
  });

  it('the away stretches: from the last of them stepping out to the first stepping back in; an arriving guest is out until they get there', () => {
    const s = dndHotel();
    const T = hourStart(s);
    const g = outing(s, s.guests[0], T, T + 3);
    const [[from, to]] = awayStretches(g, roomOf(s, 'd'));
    expect(from).toBeCloseTo(T + PACE, 9);
    expect(to).toBeCloseTo(T + 3 - PACE, 9);
    expect(partyOutOfRoom(g, roomOf(s, 'd'), from, to)).toBe(true);
    expect(partyOutOfRoom(g, roomOf(s, 'd'), T, to)).toBe(false);
    expect(awayStretches({ ...g, trip: null }, roomOf(s, 'd'))).toEqual([]);
    expect(awayStretches({ ...g, tripKind: 'arrival' }, roomOf(s, 'd'))[0][0]).toBe(-Infinity);
    expect(dndCleanStart(g, roomOf(s, 'd'), T, 0.5)).toBeCloseTo(T + PACE, 9);
    expect(dndCleanStart(g, roomOf(s, 'd'), T, 0.5, 0)).toBeNull();
    // Standing in the room a while first (a trip re-made after a change to the building): in till they go
    const tile = roomTile(roomOf(s, 'd'));
    const waited = { ...g, trip: [makeStay(tile, T - 0.5, T + 0.2, 'wait'), ...(outing(s, s.guests[0], T + 0.2, T + 3).trip!)] };
    expect(awayStretches(waited, roomOf(s, 'd'))[0][0]).toBeCloseTo(T + 0.2 + PACE, 9);
  });

  const isGuestAwayAt = (s: HotelState, t: number) => isGuestAway(s.guests[0], t);
  it('the panel, the overlay and the room card say the room is waiting for its guests to go out', () => {
    const s = dndHotel();
    const t = hourStart(s) + 0.5;
    const status = roomCleaningAt(s, t).get(roomOf(s, 'd').id)!;
    expect([status.phase, status.wait]).toEqual(['waiting', 'guest_in']);
    expect(describeWait('guest_in')).toMatch(/do not disturb/);
    expect(summarizeCleaning(s, t).daily.guestIn).toBe(1);
    const T = hourStart(s);
    const out = { ...s, guests: s.guests.map(g => (g.id === 'd' ? outing(s, g, T - 2, T + 5) : g)) };
    expect(roomCleaningAt(out, t).get(roomOf(s, 'd').id)?.wait).not.toBe('guest_in');
    // Out, but back too soon for a clean: still waiting on them, not on the housekeepers
    const brief = { ...s, guests: s.guests.map(g => (g.id === 'd' ? outing(s, g, T - 2, T + 0.4) : g)) };
    expect(dailyStays(planStaff(brief)).map(l => l.placeId)).not.toContain(roomOf(s, 'd').id);
    expect(isGuestAwayAt(brief, T + 0.2)).toBe(true);
    expect(roomCleaningAt(brief, T + 0.2).get(roomOf(s, 'd').id)?.wait).toBe('guest_in');
  });

  it('at the end of the shift, a room left alone is not a staffing problem; each guest is told how their cleans went', () => {
    let s = hotel([
      guest('d', { profile: with_({ housekeeping: 'dnd' }) }),
      guest('s'),
      guest('m', { profile: with_({ housekeeping: 'makeup' }) }),
    ], { hour: STAFF.housekeeping.workEndHour - 1, staff: { ...createStarterHotel().staff, housekeepers: 1 } });
    s = { ...s, rooms: s.rooms.map(r => ({ ...r, dailyCleanHoursRemaining: r.guestId === 'm' ? 0.01 : 5 })) };
    const r = processCleaningTick(s);
    const left = r.events.find(e => (e.data as any)?.roomsLeft);
    const skipped = r.events.find(e => (e.data as any)?.roomsSkipped);
    expect(left!.type).toBe('dnd_rooms_left'); // its own toast, not batched with "N rooms cleaned"
    expect(skipped!.type).toBe('daily_cleaning');
    expect((left!.data as any).roomsLeft).toBe(1);
    expect((skipped!.data as any).roomsSkipped).toBe(1);
    const cleans = Object.fromEntries(r.state.guests.map(g => [g.id, g.cleans]));
    expect(cleans).toEqual({ d: { done: 0, missed: 1 }, s: { done: 0, missed: 1 }, m: { done: 1, missed: 0 } });
    expect(describeHousekeeping(r.state.guests[0])).toBe('Do not disturb (cleaned only while out): cleaned 0 of 1 day');
    expect(describeHousekeeping(r.state.guests[2])).toBe('Wants the room made up daily: cleaned 1 of 1 day');
    expect(describeHousekeeping(r.state.guests[1])).toBeNull();
    withSwitch(GUEST_HOUSEKEEPING, false, () => {
      const off = processCleaningTick(s);
      expect(off.events.some(e => (e.data as any)?.roomsLeft)).toBe(false);
      expect(off.state.guests.every(g => g.cleans === undefined)).toBe(true);
    });
  });

  it('a rowdy guest’s room gets dirty faster', () => {
    const s = hotel([guest('r', { profile: with_({ rowdiness: 'rowdy' }) }), guest('q')]);
    const after = degradeCleanliness(s).rooms.map(r => r.cleanliness);
    expect(after[0]).toBeCloseTo(100 - HOUSEKEEPING.cleanlinessDecayPerDay * GUEST_HOUSEKEEPING.rowdyMessMult, 9);
    expect(after[1]).toBeCloseTo(100 - HOUSEKEEPING.cleanlinessDecayPerDay, 9);
    withSwitch(GUEST_HOUSEKEEPING, false, () => expect(degradeCleanliness(s).rooms[0].cleanliness).toBeCloseTo(100 - HOUSEKEEPING.cleanlinessDecayPerDay, 9));
  });

  it('a guest brought back early by a change to the building is planned around: guests find their way first, then staff re-plan', () => {
    let s = dndHotel();
    const T = hourStart(s);
    const room = roomOf(s, 'd');
    const tile = roomTile(room);
    const atDoor = T + walkThere(s) - TRAVEL.hoursPerTile;
    // Out through the far entrance, back (as things stand) just in time for a clean starting when the housekeeper
    // gets there: a step in, the clean, a step out, before they start their last step in
    const farIn = makeWalk(routeFromStreet(s, tile, PACE)!.path, 0, PACE).end;
    const g0 = outing(s, s.guests[0], T - 1, atDoor + 2 * TRAVEL.hoursPerTile + 0.5 + PACE + 0.01);
    expect(farIn).toBeGreaterThan(0.1);
    // A nearer entrance, right above the room
    s = addFixture({ ...s, guests: [g0, s.guests[1]] }, 'entrance', 3, 0, 0)!;
    expect(s).toBeTruthy();
    s = { ...s, staffPlan: planStaff(s) };
    expect(dailyStays(s.staffPlan!).map(l => l.placeId)).toContain(room.id);
    // The far entrance is bricked up mid-hour: they come back in by the near one, sooner -- before the clean would be done
    const t = T + 0.02;
    const after = settleChanges(s, { ...s, fixtures: s.fixtures.filter(f => !(f.type === 'entrance' && f.gridX === 0)) }, t);
    const g = after.guests[0];
    expect(legsEnd(g.trip!)).toBeLessThan(legsEnd(g0.trip!) - 0.05);
    expect(dailyStays(after.staffPlan!).filter(l => l.placeId === room.id && l.end > t)).toEqual([]);
  });
});

describe('Settling a change mid-hour: with preferences off, the old order', () => {
  it('staff re-plan before guests find a new way (so a housekeeper waiting on someone walking out waits as before); on, guests first', () => {
    const run = () => {
      let s = hotel([guest('x')], { staff: { ...createStarterHotel().staff, housekeepers: 1 } });
      s = addFixture({ ...s, cash: 1_000_000 }, 'entrance', 9, 0, 0)!; // a second way out, far off
      const room = s.rooms[0];
      s = { ...s, guests: [], rooms: [{ ...room, status: 'cleaning' as const, guestId: undefined, cleaningHoursRemaining: 2, cleaningHoursTotal: 2 }] };
      const T = hourStart(s);
      const tile = roomTile(room);
      // A slow walker just checked out, walking out of the room from T; a housekeeper right outside the door
      const slow = GUEST_PROFILE.pace.limited;
      const walker: Walker = { id: 'w', trait: 'normal', isReturning: false, reason: 'checked_out', profile: with_({ mobility: 'limited' }), trip: [makeWalk(routeToStreet(s, tile, slow)!.path, T, slow)] };
      s = { ...s, walkers: [walker], staffRoster: [{ id: 'housekeeper-0', role: 'housekeeper', at: { gridX: room.gridX, gridY: room.gridY - 1, floor: 0 } }] };
      s = { ...s, staffPlan: planStaff(s) };
      const before = s.staffPlan!.itineraries[0].legs.find(l => l.kind === 'stay' && l.job === 'turnover')!;
      expect(before.start).toBeCloseTo(T + slow, 9); // waits for them to step out
      // The entrance they're heading for goes, while they're still in the doorway
      const exit = walker.trip[0] as any;
      const end = exit.path[exit.path.length - 1];
      const after = settleChanges(s, { ...s, fixtures: s.fixtures.filter(f => !(f.type === 'entrance' && f.gridX === end.gridX && f.gridY === end.gridY)) }, T + slow / 2);
      return { T, slow, clean: after.staffPlan!.itineraries[0].legs.find(l => l.kind === 'stay' && l.job === 'turnover' && l.end > T + slow / 2)! };
    };
    const off = withSwitch(GUEST_HOUSEKEEPING, false, run);
    expect(off.clean.start).toBeCloseTo(off.T + off.slow, 9); // planned around the walk as it was
    const on = run();
    expect(on.clean.start).toBeCloseTo(on.T + on.slow / 2 + on.slow, 9); // around the walk as it now is
  });
});

describe('Re-planning staff mid-hour', () => {
  it('a housekeeper stopped mid-step (the tile ahead built on) stands where they got to: the hour has no holes', () => {
    let s = hotel([guest('x')], { staff: { ...createStarterHotel().staff, housekeepers: 1 } });
    s = { ...s, guests: [], rooms: s.rooms.map(r => ({ ...r, status: 'cleaning' as const, guestId: undefined, cleaningHoursRemaining: 2, cleaningHoursTotal: 2 })) };
    s = { ...s, staffPlan: planStaff(s) };
    const T = hourStart(s);
    const walk = s.staffPlan!.itineraries[0].legs.find(l => l.kind === 'walk') as any;
    expect(walk).toBeTruthy();
    let checked = 0;
    for (let i = 1; i < walk.path.length - 1; i++) {
      const b = walk.path[i];
      const t = walk.start + (i - 0.5) * TRAVEL.hoursPerTile; // half way into the step onto b
      for (const door of ['up', 'down', 'left', 'right'] as const) {
        const built = addRoom({ ...s, cash: 1_000_000 }, 'standard', b.gridX, b.gridY, b.floor, door);
        if (!built) continue;
        const after = settleChanges(s, built, t);
        const legs = after.staffPlan!.itineraries[0].legs;
        expect(legs[0].start).toBeCloseTo(T, 9);
        for (let k = 1; k < legs.length; k++) expect(legs[k].start).toBeCloseTo(legs[k - 1].end, 9);
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Hosted nights
// ---------------------------------------------------------------------------

/** A rowdy host (in 3,2) whose night it is tonight, and a sleeper next door (4,2). */
function party(sleeper: Partial<Guest> = {}, host: Partial<Guest> = {}, extra: Partial<HotelState> = {}): HotelState {
  const day = 3;
  const h = guest('h', { profile: with_({ rowdiness: 'rowdy' }), checkInDay: day, stayLength: 1, ...host });
  const n = guest('n', { profile: with_({ sleep: 'light' }), ...sleeper });
  return hotel([h, n], { day, hour: HOSTED_NIGHTS.startHour, staff: { ...createStarterHotel().staff, frontDesk: 1 }, ...extra });
}

/** Visitors in the host's room from `from` to `until` (walking in before, out after). */
function visitor(s: HotelState, hostId: string, size: number, from: number, until: number, id = `visit-${hostId}`): Walker {
  const tile = roomTile(roomOf(s, hostId));
  const inn = routeFromStreet(s, tile, PACE)!;
  const out = routeToStreet(s, tile, PACE)!;
  const walkIn = makeWalk(inn.path, from - makeWalk(inn.path, 0, PACE).end, PACE);
  return {
    id, trait: 'normal', isReturning: false, reason: 'visitor', hostId, party: { kind: 'friends', size },
    trip: [walkIn, makeStay(tile, walkIn.end, until, 'in_room', { placeId: roomOf(s, hostId).id }), makeWalk(out.path, until, PACE)],
  };
}

/** A sleeper id whose roll says they complain about this host's visitors tonight (or doesn't). */
function sleeperWho(complains: boolean, sleep: 'light' | 'heavy' = 'light', day = 3, host = 'h'): string {
  for (let i = 0; ; i++) {
    const id = `n${i}`;
    if ((hash01(`${id}|${host}|${day}|complain`) < HOSTED_NIGHTS.complaintChance[sleep]) === complains) return id;
  }
}

/** The absolute time of an hour of the night after day `day` (24 = midnight). */
const at = (day: number, hour: number) => (day - 1) * 24 + hour;

describe('Hosted nights: who has friends round', () => {
  it('half of rowdy guests, on one night of their stay, from their booking; nobody else', () => {
    expect(hostingDay(guest('a'))).toBeNull();
    let hosts = 0;
    const nights = [0, 0, 0];
    for (let i = 0; i < 4000; i++) {
      const g = guest(`r${i}`, { profile: with_({ rowdiness: 'rowdy' }), checkInDay: 10, stayLength: 3 });
      const day = hostingDay(g);
      if (day === null) continue;
      hosts++;
      expect(day).toBeGreaterThanOrEqual(10);
      expect(day).toBeLessThanOrEqual(12);
      nights[day - 10]++;
    }
    expect(Math.abs(hosts / 4000 - HOSTED_NIGHTS.hostShare)).toBeLessThan(0.03);
    expect(Math.min(...nights)).toBeGreaterThan(hosts / 3 * 0.85); // any night of the stay
  });

  it('at 22:00 their friends walk in from the street to the room, stay till between 01:00 and 02:00, and walk out again', () => {
    const s = party();
    const planned = planVisitors(s);
    const [w] = planned.walkers!;
    expect(w).toMatchObject({ reason: 'visitor', hostId: 'h' });
    expect(w.guestId).toBeUndefined();
    const [walkIn, stay, walkOut] = w.trip as [Leg, StayLeg, Leg];
    expect(walkIn.kind === 'walk' && isEntranceTile(s, walkIn.path[0])).toBe(true);
    expect(walkIn.start).toBeGreaterThanOrEqual(hourStart(s));
    expect(walkIn.start).toBeLessThan(hourStart(s) + HOSTED_NIGHTS.arriveSpread);
    expect([stay.activity, stay.placeId, stay.start]).toEqual(['in_room', roomOf(s, 'h').id, walkIn.end]);
    expect(stay.at).toMatchObject({ gridX: 3, gridY: 2, floor: 0 });
    expect(stay.end).toBeGreaterThanOrEqual(Math.max(at(3, 25), stay.start + HOSTED_NIGHTS.minStay) - 1e-9);
    expect(stay.end).toBeLessThanOrEqual(Math.max(at(3, 26), stay.start + HOSTED_NIGHTS.minStay) + 1e-9);
    expect(walkOut.kind === 'walk' && walkOut.start === stay.end && isEntranceTile(s, walkOut.path[walkOut.path.length - 1])).toBe(true);
    expect(w.party!.size).toBeGreaterThanOrEqual(1);
    expect(w.party!.size).toBeLessThanOrEqual(3);
    expect(planned.guests[0].hostedNight).toEqual({ day: 3, visitors: w.party!.size });
    expect(planVisitors(s)).toEqual(planned); // deterministic
    expect(planVisitors(planned).walkers).toHaveLength(1); // once a stay
  });

  it('not on another night or at another hour, not while out, not for an early bird (asleep by 22:00), and not with the switch off', () => {
    const s = party();
    expect(planVisitors({ ...s, hour: 21 }).walkers ?? []).toHaveLength(0);
    expect(planVisitors({ ...s, day: 4 }).walkers ?? []).toHaveLength(0);
    expect(planVisitors(party({}, { profile: with_({ rowdiness: 'rowdy', chronotype: 'early' }) })).walkers ?? []).toHaveLength(0);
    const T = hourStart(s);
    expect(planVisitors({ ...s, guests: s.guests.map(g => (g.id === 'h' ? outing(s, g, T, T + 2) : g)) }).walkers ?? []).toHaveLength(0);
    expect(planVisitors(party({}, { profile: with_({}) })).walkers ?? []).toHaveLength(0);
    withSwitch(HOSTED_NIGHTS, false, () => expect(planVisitors(s).walkers ?? []).toHaveLength(0));
    withSwitch(GUEST_PROFILE, false, () => expect(planVisitors(s).walkers ?? []).toHaveLength(0));
  });

  it('while they are in, the host is up, the room is louder, and the neighbour hears it (and knows who to blame)', () => {
    const s0 = party();
    const s = { ...s0, walkers: [visitor(s0, 'h', 2, at(3, 22.5), at(3, 25.5))] };
    const t = at(3, 24.5); // 00:30
    const host = s.guests[0];
    expect(visitorsAt(s, 'h', t)).toBe(2);
    expect(visitorsAt(s, 'h', at(3, 25.6))).toBe(0); // gone (walking out)
    expect(isAsleepAt(s, host, t)).toBe(false);
    expect(isAsleepAt(s0, host, t)).toBe(true);
    expect(occupantNoiseOutput(host, t, 2)).toBeCloseTo(NOISE.baseOccupiedNoise * GUEST_PROFILE.output.rowdy * GUEST_PROFILE.rowdyLateMult * perPersonFactor(3), 9);
    const next = roomOf(s, 'n');
    expect(calculateRoomNoise(next, s0, t)).toBe(0); // asleep, alone: silent
    expect(calculateRoomNoise(next, s, t)).toBeGreaterThan(NOISE.penaltyThreshold);
    expect(getLoudestNeighborGuestId(next, s, t)).toBe('h');
    // The host isn't kept awake by their own party; the neighbour is
    const night = { ...s, day: 4, hour: 0 };
    expect(nightNoiseThisHour(roomOf(s, 'h'), night, host)).toBe(0);
    expect(nightNoiseThisHour(next, night, s.guests[1])).toBeGreaterThan(0);
    // and stays in for them
    expect(isHosting(s, 'h', at(3, 22))).toBe(true);
    expect(isHosting(s, 'h', at(3, 25.6))).toBe(false);
  });

  it('a host stays in for their friends: no trips out while they are coming or there', () => {
    const s0 = party({}, {}, { hour: 10 });
    const T = hourStart(s0);
    const s = { ...s0, walkers: [visitor(s0, 'h', 1, T + 0.5, T + 3)] };
    const original = GUEST_OUTINGS.leaveChance;
    GUEST_OUTINGS.leaveChance = [[0, 24, 1]];
    try {
      const out = planOutings({ ...s, guests: s.guests.map(g => ({ ...g, checkInDay: 1, stayLength: 5 })) });
      expect(out.guests.find(g => g.id === 'h')!.trip ?? null).toBeNull();
      expect(out.guests.find(g => g.id === 'n')!.tripKind).toBe('outing');
    } finally { GUEST_OUTINGS.leaveChance = original; }
    const gym = addFacility({ ...s, cash: 1_000_000 }, 'gym', 3, 4)!;
    const was = FACILITY_CONFIG.gym.visitChance;
    FACILITY_CONFIG.gym.visitChance = [[0, 24, 1]];
    try {
      const visits = planFacilityVisits({ ...gym, guests: gym.guests.map(g => ({ ...g, checkInDay: 1, stayLength: 5 })) });
      expect(visits.guests.find(g => g.id === 'h')!.trip ?? null).toBeNull();
      expect(visits.guests.find(g => g.id === 'n')!.tripKind).toBe('visit');
    } finally { FACILITY_CONFIG.gym.visitChance = was; }
  });

  it('visitors are drawn in the host’s colour, and a click on one opens the host’s card', () => {
    const s0 = party({}, { purpose: 'getaway' });
    const s = planVisitors(s0);
    const stay = s.walkers![0].trip[1];
    const { figures } = guestFigures(s, stay.start + 0.1);
    const mine = figures.filter(f => f.id.startsWith('visit-'));
    expect(mine).toHaveLength(s.walkers![0].party!.size);
    expect(mine.every(f => f.opens === 'h' && f.guestId === undefined)).toBe(true);
    expect(describeVisitors(s, 'h', stay.start + 0.1)).toBe(`${mine.length === 1 ? 'A visitor' : `${mine.length} visitors`} since ${clockTime(stay.start)}, leaving about ${clockTime(stay.end)}`);
    expect(describeVisitors(s, 'h', s.walkers![0].trip[0].start + 0.01)).toMatch(/on the way up$/);
    expect(describeVisitors(s, 'n', stay.start)).toBeNull();
    expect(clockTime(at(3, 24.67))).toBe('00:40');
  });
});

describe('Hosted nights: complaints and "keep it down"', () => {
  /** The neighbour asleep at 23:00 with the visitors in till `until` (an hour of the night). */
  const night = (complains: boolean, until: number, extra: Partial<HotelState> = {}, sleep: 'light' | 'heavy' = 'light') => {
    const id = sleeperWho(complains, sleep);
    const s0 = party({ id, name: id, profile: with_({ sleep }) }, { hostedNight: { day: 3, visitors: 2 } }, { hour: 23, ...extra });
    return { s: { ...s0, walkers: [visitor(s0, 'h', 2, at(3, 22.5), at(3, until))] }, id };
  };

  it('a neighbour kept awake complains (once), on the night’s own thread; left to it, the incident waits', () => {
    const { s, id } = night(true, 25.6, { visitorPolicy: 'allow' });
    const T = at(3, 24);
    const r = fileVisitorComplaints(s, T);
    const incident = r.state.activeIncidents[0];
    expect(incident).toMatchObject({ type: 'noise_complaint', guestId: id, culpritGuestId: 'h', about: 'visitors', hoursRemaining: HOSTED_NIGHTS.complaintGraceHours, chainId: 'hosted-h-3' });
    const thread = r.state.storyLog.filter(e => e.chainId === 'hosted-h-3');
    expect(thread.map(e => e.type)).toEqual(['visitors', 'noise_complaint_visitors']);
    expect(thread.every(e => e.id !== e.chainId)).toBe(true); // not a new story: the day's budget doesn't stop it
    expect(thread[0].message).toMatch(/^Room \S+ has 2 visitors \(since 22:30\)\.$/);
    const n = r.state.guests.find(g => g.id === id)!;
    expect(n.satisfaction).toBeCloseTo(55 - SATISFACTION.noiseComplaintPenalty, 9);
    expect(n.hadNoiseComplaint).toBe(true);
    expect(r.state.guests[0].hostedNight).toEqual({ day: 3, visitors: 2, complainedBy: id });
    expect(r.events.map(e => e.type)).toEqual(['noise_complaint_filed']);
    expect(r.state.walkers![0].trip[1].end).toBe(at(3, 25.6)); // still there
  });

  it('one complaint a night per host; nobody complains when their roll says no, when asleep through it, or when away', () => {
    const { s } = night(true, 25.6, { visitorPolicy: 'allow' });
    const once = fileVisitorComplaints(s, at(3, 24)).state;
    expect(once.guests[0].hostedNight!.complainedBy).toBe(once.guests[1].id);
    expect(fileVisitorComplaints({ ...once, activeIncidents: [] }, at(3, 24)).state.activeIncidents).toHaveLength(0);
    expect(fileVisitorComplaints(night(false, 25.6).s, at(3, 24)).events).toEqual([]);
    expect(fileVisitorComplaints({ ...s, hour: 22 }, at(3, 23)).state.activeIncidents).toHaveLength(0); // 22:30: not their sleep hours yet
    const T = hourStart(s);
    const away = { ...s, guests: s.guests.map(g => (g.id !== 'h' ? outing(s, g, T - 2, T + 3) : g)) };
    expect(fileVisitorComplaints(away, at(3, 24)).state.activeIncidents).toHaveLength(0);
    withSwitch(HOSTED_NIGHTS, false, () => expect(fileVisitorComplaints(s, at(3, 24)).state.activeIncidents).toHaveLength(0));
  });

  it('with the "ask" policy (the default) the desk sends them home there and then: the host minds, the neighbour is answered', () => {
    const { s, id } = night(true, 25.6);
    expect(visitorPolicy(s)).toBe('ask');
    const T = at(3, 24);
    const r = fileVisitorComplaints(s, T);
    expect(r.state.activeIncidents).toHaveLength(0);
    const w = r.state.walkers![0];
    expect(w.trip[1]).toMatchObject({ activity: 'in_room', end: T + HOSTED_NIGHTS.leaveDelay });
    expect(w.trip[2].kind === 'walk' && w.trip[2].start === T + HOSTED_NIGHTS.leaveDelay && isEntranceTile(s, w.trip[2].path[w.trip[2].path.length - 1])).toBe(true);
    expect(visitorsAt(r.state, 'h', T + HOSTED_NIGHTS.leaveDelay + 0.01)).toBe(0);
    const host = r.state.guests[0];
    expect(host.satisfaction).toBeCloseTo(55 - HOSTED_NIGHTS.hostPenalty, 9);
    expect(host.hostedNight!.keptDownAt).toBe(T);
    expect(r.state.guests.find(g => g.id === id)!.satisfaction).toBeCloseTo(55 - SATISFACTION.noiseComplaintPenalty + SATISFACTION.noiseComplaintResolvedBonus, 9);
    const last = r.state.storyLog[r.state.storyLog.length - 1];
    expect(last).toMatchObject({ type: 'noise_complaint_kept_down', chainId: 'hosted-h-3' });
    expect(last.message).toMatch(/keep it down; the visitors left at 00:05\.$/);
    expect(r.events.map(e => e.type)).toEqual(['noise_complaint_filed', 'visitors_asked_to_leave']);
    expect(r.events[1].data?.unlogged).toBeUndefined(); // answered a complaint: it's in the log
    // Nobody at the desk: nobody to ask
    const unstaffed = fileVisitorComplaints({ ...s, staff: { ...s.staff, frontDesk: 0 } }, T);
    expect(unstaffed.state.activeIncidents).toHaveLength(1);
  });

  it('asked to keep it down, the host stays quieter for the rest of the night', () => {
    const host = guest('h', { profile: with_({ rowdiness: 'rowdy' }), hostedNight: { day: 3, visitors: 2, keptDownAt: at(3, 23.2) } });
    expect(noiseOutputMult(host, 23, at(3, 23.5))).toBe(GUEST_PROFILE.output.rowdy);
    expect(noiseOutputMult(host, 23, at(3, 23.1))).toBe(GUEST_PROFILE.output.rowdy * GUEST_PROFILE.rowdyLateMult); // not yet
    expect(noiseOutputMult(host, 1, at(3, 25.5))).toBe(GUEST_PROFILE.output.rowdy);
    expect(noiseOutputMult(host, 22, at(4, 22.5))).toBe(GUEST_PROFILE.output.rowdy * GUEST_PROFILE.rowdyLateMult); // the next night
  });

  it('asking by hand: any time they are there or on the way (who turns round), not twice, not with nobody at the desk', () => {
    const s0 = party();
    const s = { ...s0, walkers: [visitor(s0, 'h', 2, at(3, 22.8), at(3, 25.5))] };
    // Still walking up: they turn round where they are, and walk back out
    const t = s.walkers[0].trip[0].start + 0.05;
    const r = askToKeepItDown(s, 'h', t)!;
    const w = r.state.walkers![0];
    expect(w.trip.some(l => l.kind === 'stay' && l.activity === 'in_room')).toBe(false);
    for (let i = 1; i < w.trip.length; i++) expect(w.trip[i].start).toBeCloseTo(w.trip[i - 1].end, 9);
    const end = positionAt(w.trip, legsEnd(w.trip))!;
    expect(isEntranceTile(s, { gridX: end.x, gridY: end.y, floor: end.floor })).toBe(true);
    expect(r.events[0].type).toBe('visitors_asked_to_leave');
    expect(r.events[0].message).toMatch(/^Asked the visitors in Room \S+ to leave/);
    expect(r.events[0].data?.unlogged).toBe(true); // nobody's complaint answered: not in the story log, so the toast shows with it open
    expect(askToKeepItDown(r.state, 'h', t + 0.1)).toBeNull(); // nobody left to ask
    const one = { ...s0, walkers: [visitor(s0, 'h', 1, at(3, 22.8), at(3, 25.5))] };
    expect(askToKeepItDown(one, 'h', at(3, 23.5))!.events[0].message).toMatch(/^Asked the visitor in Room/);
    expect(askToKeepItDown({ ...s, staff: { ...s.staff, frontDesk: 0 } }, 'h', t)).toBeNull();
    expect(askToKeepItDown(s, 'n', t)).toBeNull();
    // Not set off yet: they don't come
    expect(askToKeepItDown(s, 'h', s.walkers[0].trip[0].start - 0.01)!.state.walkers).toHaveLength(0);
  });

  it('left to it: the visitors gone in time, the neighbour gets back to sleep; still going two sleep-hours on, they check out early', () => {
    const run = (until: number) => {
      const { s, id } = night(true, until, { visitorPolicy: 'allow' });
      let state = fileVisitorComplaints(s, at(3, 24)).state;
      const out = [];
      for (const hour of [0, 1]) {
        const r = advanceIncidents({ ...state, day: 4, hour }, new PRNG(1), at(4, hour + 1));
        state = r.state;
        out.push(r);
      }
      return { id, out, state };
    };
    const early = run(25.2);
    expect(early.out[1].earlyDepartureGuestIds.size).toBe(0);
    expect(early.state.activeIncidents).toHaveLength(0);
    expect(early.state.storyLog[early.state.storyLog.length - 1]).toMatchObject({ type: 'noise_complaint_resolved', chainId: 'hosted-h-3' });
    expect(early.state.storyLog[early.state.storyLog.length - 1].message).toMatch(/^The visitors in Room \S+ left, and n\d+ got back to sleep\.$/);
    const late = run(25.8);
    expect([...late.out[1].earlyDepartureGuestIds]).toEqual([late.id]);
    expect(late.state.storyLog[late.state.storyLog.length - 1]).toMatchObject({ type: 'noise_complaint_escalated', chainId: 'hosted-h-3' });
  });

  it('a host who leaves (or moves rooms) takes the party with them: the visitors go too', () => {
    const s0 = party();
    const s = { ...s0, walkers: [visitor(s0, 'h', 2, at(3, 22.5), at(3, 25.5)), visitor(s0, 'h', 1, at(3, 23.9), at(3, 25.5), 'late')] };
    const T = at(3, 23);
    const gone = sendOrphanedVisitorsHome({ ...s, guests: s.guests.filter(g => g.id !== 'h'), rooms: s.rooms.map(r => (r.guestId === 'h' ? { ...r, status: 'cleaning' as const, guestId: undefined } : r)) }, T);
    expect(gone.walkers).toHaveLength(1); // the one not yet set off doesn't come
    expect(gone.walkers![0].trip[1]).toMatchObject({ activity: 'in_room', end: T });
    expect(sendOrphanedVisitorsHome(s, T)).toBe(s);
  });

  it('turning the host’s door mid-visit: the visit carries on (one stay), and they leave by the new door', () => {
    const s0 = party();
    const s = { ...s0, walkers: [visitor(s0, 'h', 2, at(3, 22.5), at(3, 25.5))] };
    const t = at(3, 23);
    const turned = { ...s, rooms: s.rooms.map(r => (r.guestId === 'h' ? { ...r, door: 'down' as const } : r)) };
    const after = settleChanges(s, turned, t);
    const w = after.walkers![0];
    const stays = w.trip.filter(l => l.kind === 'stay' && l.activity === 'in_room') as StayLeg[];
    expect(stays).toHaveLength(1);
    expect([stays[0].start, stays[0].end, stays[0].at.door]).toEqual([s.walkers[0].trip[1].start, at(3, 25.5), 'down']);
    expect(visitorsAt(after, 'h', at(3, 24.5))).toBe(2);
    for (let i = 1; i < w.trip.length; i++) expect(w.trip[i].start).toBeCloseTo(w.trip[i - 1].end, 9);
    const out = w.trip[w.trip.length - 1];
    expect(out.kind === 'walk' && out.path[1].gridY === 3).toBe(true); // out through the new door, below
  });

  it('rebuilding across their way out mid-visit keeps one stay: still there, still noisy, still answerable', () => {
    const s0 = party();
    const s = { ...s0, cash: 1_000_000, walkers: [visitor(s0, 'h', 2, at(3, 22.5), at(3, 25.5))] };
    const t = at(3, 23.3);
    const out = s.walkers[0].trip[2];
    expect(out.kind).toBe('walk');
    // A room built on a tile they'd walk through (not right at the host's door)
    let built: HotelState | null = null;
    for (const tile of (out as any).path.slice(2, -1)) {
      built = addRoom(s, 'standard', tile.gridX, tile.gridY, tile.floor, 'up');
      if (built && routeToStreet(built, roomTile(roomOf(s, 'h')), PACE)) break;
      built = null;
    }
    expect(built).toBeTruthy();
    const after = settleChanges(s, built!, t);
    const w = after.walkers![0];
    expect(w.trip).not.toEqual(s.walkers[0].trip); // rerouted
    expect(w.trip.filter(l => l.kind === 'stay' && l.activity === 'in_room')).toHaveLength(1);
    expect(visitorsAt(after, 'h', at(3, 24.5))).toBe(2);
    expect(isHosting(after, 'h', at(3, 24.5))).toBe(true);
    expect(askToKeepItDown(after, 'h', at(3, 24.5))).not.toBeNull();
  });

  it('visitors not yet set off when their entrance goes still come in from the street', () => {
    const s0 = party();
    const s1 = addFixture({ ...s0, cash: 1_000_000 }, 'entrance', 3, 0, 0)!;
    // Planned in through the first entrance (the second came later)
    const w0 = visitor(s0, 'h', 2, at(3, 23.5), at(3, 25.5));
    const s = { ...s1, walkers: [w0] };
    const first = w0.trip[0] as any;
    const gone = { ...s, fixtures: s.fixtures.filter(f => !(f.type === 'entrance' && f.gridX === first.path[0].gridX && f.gridY === first.path[0].gridY)) };
    const t = first.start - 0.2;
    const after = settleChanges(s, gone, t);
    const w = after.walkers![0];
    const walkIn = w.trip[0] as any;
    expect(walkIn.kind).toBe('walk');
    expect(isEntranceTile(gone, walkIn.path[0])).toBe(true);
    expect(w.trip.filter(l => l.kind === 'stay' && l.activity === 'in_room')).toHaveLength(1);
  });

  it('asked by hand in the last minutes of the hour, then a complaint at the bell: the host minds once', () => {
    const { s, id } = night(true, 25.6);
    const T = at(3, 24);
    const asked = askToKeepItDown(s, 'h', T - 0.05)!;
    expect(asked.state.guests[0].satisfaction).toBeCloseTo(55 - HOSTED_NIGHTS.hostPenalty, 9);
    const r = fileVisitorComplaints(asked.state, T);
    expect(r.state.guests[0].satisfaction).toBeCloseTo(55 - HOSTED_NIGHTS.hostPenalty, 9);
    expect(r.state.guests[0].hostedNight!.keptDownAt).toBe(T - 0.05);
    expect(r.events.map(e => e.type)).toEqual(['noise_complaint_filed']);
    expect(r.state.activeIncidents).toHaveLength(0); // answered
    expect(r.state.storyLog[r.state.storyLog.length - 1].type).toBe('noise_complaint_kept_down');
    expect(r.state.guests.find(g => g.id === id)!.satisfaction).toBeCloseTo(55 - SATISFACTION.noiseComplaintPenalty + SATISFACTION.noiseComplaintResolvedBonus, 9);
  });

  it('asked by hand earlier in the hour (gone by the bell), then a complaint at the bell: answered there and then', () => {
    const { s, id } = night(true, 25.6);
    const T = at(3, 24);
    const asked = askToKeepItDown(s, 'h', T - 0.4)!;
    expect(visitorsAt(asked.state, 'h', T - 0.1)).toBe(0); // gone by now
    const r = fileVisitorComplaints({ ...asked.state, visitorPolicy: 'allow' }, T); // (answered whatever the policy: they were asked)
    expect(r.state.activeIncidents).toHaveLength(0);
    expect(r.state.guests[0].satisfaction).toBeCloseTo(55 - HOSTED_NIGHTS.hostPenalty, 9);
    const last = r.state.storyLog[r.state.storyLog.length - 1];
    expect(last.type).toBe('noise_complaint_kept_down');
    expect(last.message).toMatch(/left at 23:4\d\.$/); // when they really left
    expect(r.state.guests.find(g => g.id === id)!.satisfaction).toBeCloseTo(55 - SATISFACTION.noiseComplaintPenalty + SATISFACTION.noiseComplaintResolvedBonus, 9);
  });

  it('in the tick: a neighbour leaving early this hour (their room broke down, nowhere to move them) does not complain', () => {
    const { s, id } = night(true, 25.6, { visitorPolicy: 'allow' });
    const broken = {
      ...s,
      rooms: s.rooms.map(r => (r.guestId === id ? { ...r, condition: 0 } : r)),
      activeIncidents: [{ id: 'i', type: 'mid_stay_breakdown' as const, guestId: id, roomId: roomOf(s, id).id, stage: 'active' as const, hoursRemaining: 1, chainId: 'c' }],
      // (the day's incident budget spent, so no fresh breakdown opens for them this tick)
      storyLog: [1, 2].map(n => ({ id: `o${n}`, day: 3, hour: 20, type: 'mid_stay_breakdown', message: '', chainId: `o${n}` })),
    };
    const r = tickSimulation(broken, new PRNG(1));
    expect(r.events.some(e => e.type === 'noise_complaint_filed')).toBe(false);
    expect(r.state.guests.some(g => g.id === id)).toBe(false); // gone
    // Without the breakdown, the same neighbour complains in the same tick
    expect(tickSimulation(s, new PRNG(1)).events.some(e => e.type === 'noise_complaint_filed' && e.data?.about === 'visitors')).toBe(true);
  });

  it('one complaint a night per host, even with a second neighbour kept awake', () => {
    const ids: string[] = [];
    for (let i = 0; ids.length < 2; i++) if (hash01(`m${i}|h|3|complain`) < HOSTED_NIGHTS.complaintChance.light) ids.push(`m${i}`);
    const light = with_({ sleep: 'light' });
    const h = guest('h', { profile: with_({ rowdiness: 'rowdy' }), checkInDay: 3, stayLength: 1, hostedNight: { day: 3, visitors: 2 } });
    const s0 = hotel([guest(ids[0], { profile: light }), h, guest(ids[1], { profile: light })], { day: 3, hour: 23, visitorPolicy: 'allow', staff: { ...createStarterHotel().staff, frontDesk: 1 } });
    const s = { ...s0, walkers: [visitor(s0, 'h', 3, at(3, 22.5), at(3, 25.8))] };
    const first = fileVisitorComplaints(s, at(3, 24)).state;
    expect(first.activeIncidents).toHaveLength(1);
    // An hour on, the other neighbour is still kept awake: no second complaint about the same night
    const later = fileVisitorComplaints({ ...first, day: 4, hour: 0 }, at(4, 1)).state;
    expect(later.activeIncidents).toHaveLength(1);
  });

  it('nobody leaving this hour complains or hosts, and nobody complains twice in a stay', () => {
    const { s, id } = night(true, 25.6, { visitorPolicy: 'allow' });
    const T = at(3, 24);
    expect(fileVisitorComplaints(s, T).state.activeIncidents).toHaveLength(1);
    expect(fileVisitorComplaints(s, T, new Set([id])).state.activeIncidents).toHaveLength(0);
    expect(fileVisitorComplaints(s, T, new Set(['h'])).state.activeIncidents).toHaveLength(0);
    const complained = { ...s, guests: s.guests.map(g => (g.id === id ? { ...g, hadNoiseComplaint: true } : g)) };
    expect(fileVisitorComplaints(complained, T).state.activeIncidents).toHaveLength(0);
  });

  it('a whole night in the tick: friends round at 22:00, a complaint, sent home', () => {
    const id = sleeperWho(true);
    let s = party({ id, name: id }, {}, { hour: 21 });
    // The whole hotel needs the night shift covered, as well as its daytime crew.
    s = { ...s, staff: { ...s.staff, frontDesk: 3 } };
    const prng = new PRNG(1);
    const events: string[] = [];
    for (let h = 0; h < 6; h++) {
      const r = tickSimulation(s, prng);
      events.push(...r.events.map(e => e.type));
      s = r.state;
    }
    expect(s.guests.find(g => g.id === 'h')!.hostedNight).toMatchObject({ day: 3, complainedBy: id });
    expect(events).toContain('visitors_asked_to_leave');
    expect(s.storyLog.some(e => e.type === 'noise_complaint_kept_down')).toBe(true);
    expect(STORY.incidentDailyBudget).toBeGreaterThan(0);
  });
});
