import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom } from '../src/simulation/HotelState.js';
import { calculateGuestReviewBreakdown } from '../src/simulation/GuestManager.js';
import { rollProfile } from '../src/simulation/Profile.js';
import { voiceOf, complainsBelow, hasComplained, moodHidden } from '../src/simulation/Voice.js';
import { planDeskComplaints, hearComplaints, complaintAbout, COMPLAINT_ADVICE } from '../src/simulation/Complaints.js';
import { lanesOf, laneBookings, reseatLanes, readyAt } from '../src/simulation/DeskQueue.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { CHECK_IN_HOURS } from '../src/simulation/GuestMovement.js';
import { selectNewIncident, checkReviewSemiViral, advanceIncidents, type DepartedGuestReview } from '../src/simulation/StoryGenerator.js';
import { fileVisitorComplaints } from '../src/simulation/HostedNights.js';
import { roomTile } from '../src/simulation/GuestMovement.js';
import { routeFromStreet } from '../src/simulation/Layout.js';
import { makeWalk, makeStay, hourStart, legsEnd, hash01, sameTile } from '../src/simulation/Movement.js';
import { guestFigures } from '../src/render/figures.js';
import { PRNG } from '../src/simulation/prng.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { VOICE, SATISFACTION, HOSTED_NIGHTS, STORY, TRAVEL, PATIENCE } from '../src/config/balance.js';
import type { Guest, GuestProfile, HotelState, StayLeg, Walker } from '../src/simulation/types.js';

const PROFILE: GuestProfile = { chronotype: 'regular', mobility: 'normal', sleep: 'normal', rowdiness: 'normal', checkoutHour: 11 };
const with_ = (extra: Partial<GuestProfile>): GuestProfile => ({ ...PROFILE, ...extra });

function guest(id: string, extra: Partial<Guest> = {}): Guest {
  return {
    id, name: id, budget: 1000, stayLength: 5, trait: 'normal', satisfaction: 55, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
    profile: PROFILE, ...extra,
  };
}

/** The starter hotel with these guests in standard rooms from (3,2), one clerk at the desk, at 09:00 on day 3. */
function hotel(guests: Guest[], extra: Partial<HotelState> = {}): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5 };
  for (let x = 0; x < guests.length; x++) s = addRoom(s, 'standard', x + 3, 2, 0, 'up')!;
  return {
    ...s, day: 3, hour: 9, noiseSources: [], guests, staff: { ...s.staff, frontDesk: 1 },
    rooms: s.rooms.map((r, i) => ({ ...r, status: 'occupied' as const, guestId: guests[i].id })),
    ...extra,
  };
}

function withSwitch<T>(sw: { enabled: boolean }, on: boolean, fn: () => T): T {
  const was = sw.enabled;
  sw.enabled = on;
  try { return fn(); } finally { sw.enabled = was; }
}

const vocal = (extra: Partial<Guest> = {}) => guest('v', { profile: with_({ voice: 'vocal' }), satisfaction: 46, ...extra });

describe('Voice: who speaks up', () => {
  it('is rolled with the profile: vocal 25 / typical 55 / stoic 20', () => {
    let vocalN = 0;
    let stoicN = 0;
    for (let i = 0; i < 8000; i++) {
      const v = rollProfile(`v${i}`, { kind: 'couple', size: 2 }, 'sightseeing', 'normal')!.voice;
      if (v === 'vocal') vocalN++;
      if (v === 'stoic') stoicN++;
    }
    expect(Math.abs(vocalN / 8000 - 0.25)).toBeLessThan(0.02);
    expect(Math.abs(stoicN / 8000 - 0.2)).toBeLessThan(0.02);
    withSwitch(VOICE, false, () => expect(rollProfile('x', { kind: 'solo', size: 1 }, 'sightseeing', 'normal')!.voice).toBeUndefined());
  });

  it('a vocal guest complains once irritated (below 47), a typical one once angry (below 42), a stoic one never; off, the old line', () => {
    expect(complainsBelow(guest('a', { profile: with_({ voice: 'vocal' }) }))).toBe(47);
    expect(complainsBelow(guest('a', { profile: with_({ voice: 'typical' }) }))).toBe(42);
    expect(complainsBelow(guest('a'))).toBe(42); // no roll: typical
    expect(complainsBelow(guest('a', { profile: with_({ voice: 'stoic' }) }))).toBeNull();
    withSwitch(VOICE, false, () => expect(complainsBelow(guest('a', { profile: with_({ voice: 'stoic' }) }))).toBe(SATISFACTION.incidentFuelThreshold));
    expect(hasComplained(guest('a'))).toBe(false);
    expect(hasComplained(guest('a', { complaint: { about: 'x', via: 'desk', at: 5 } }))).toBe(true); // heard
    const onTheWay = makeStay({ gridX: 1, gridY: 4, floor: 0 }, 5, 5.25, 'complain', { placeId: 'd', lane: 'd:0' });
    expect(hasComplained(guest('a', { complaint: { about: 'x', via: 'desk' }, trip: [onTheWay] }))).toBe(true); // on their way
    expect(hasComplained(guest('a', { complaint: { about: 'x', via: 'desk' }, trip: null }))).toBe(false); // cut short before the counter
    expect(hasComplained(guest('a', { hadNoiseComplaint: true }))).toBe(true);
    expect(moodHidden(guest('a', { profile: with_({ voice: 'stoic' }) }))).toBe(true);
    expect(moodHidden(guest('a', { profile: with_({ voice: 'vocal' }) }))).toBe(false);
    expect(voiceOf(guest('a', { profile: with_({ voice: 'vocal' }) }))).toBe('vocal');
    withSwitch(VOICE, false, () => expect(voiceOf(guest('a', { profile: with_({ voice: 'vocal' }) }))).toBe('typical'));
  });
});

describe('Complaining at the front desk', () => {
  it('a vocal guest below the line walks down to the desk, takes a clerk a quarter of an hour, and walks back', () => {
    const s = hotel([vocal(), guest('t', { satisfaction: 46 })]);
    const planned = planDeskComplaints(s);
    const v = planned.guests[0];
    expect(v.tripKind).toBe('complaint');
    expect(v.complaint).toMatchObject({ via: 'desk' });
    expect(v.complaint!.at).toBeUndefined(); // not heard yet
    const legs = v.trip!;
    const room = planned.rooms[0];
    expect(legs[0].kind === 'walk' && legs[0].path[0].gridX === room.gridX && legs[0].path[0].gridY === room.gridY).toBe(true);
    expect(legs[0].start).toBeGreaterThanOrEqual(hourStart(s));
    expect(legs[0].start).toBeLessThan(hourStart(s) + VOICE.setOffSpread);
    const said = legs.find(l => l.kind === 'stay' && l.activity === 'complain') as StayLeg;
    expect(said.end - said.start).toBeCloseTo(VOICE.complainHours, 12);
    expect(said.lane).toBe(lanesOf(s)[0].key);
    const last = legs[legs.length - 1];
    expect(last.kind === 'walk' && last.path[last.path.length - 1].gridX === room.gridX).toBe(true);
    for (let i = 1; i < legs.length; i++) expect(legs[i].start).toBeCloseTo(legs[i - 1].end, 9);
    // A typical guest at 46 doesn't (yet); a stoic one never
    expect(planned.guests[1].tripKind).toBeUndefined();
    expect(planDeskComplaints(hotel([vocal({ profile: with_({ voice: 'stoic' }), satisfaction: 10 })])).guests[0].tripKind).toBeUndefined();
    // The clerk's time is booked: a check-in planned after fits round it
    expect(laneBookings(planned, hourStart(s)).get(said.lane!)).toEqual([[said.start, said.end]]);
  });

  it('not when asleep, out, with friends round, in the middle of something, on their last day, with nobody at the desk, or twice', () => {
    const plan = (g: Guest, extra: Partial<HotelState> = {}) => planDeskComplaints(hotel([g], extra)).guests[0].tripKind;
    expect(plan(vocal())).toBe('complaint');
    expect(plan(vocal(), { hour: 2 })).toBeUndefined(); // asleep
    expect(plan(vocal({ profile: with_({ voice: 'vocal', chronotype: 'early', mobility: 'limited' }) }), { hour: 20 })).toBeUndefined(); // they'd still be out at bedtime (21:00)
    expect(plan(vocal({ profile: with_({ voice: 'vocal', chronotype: 'early', mobility: 'limited' }) }), { hour: 15 })).toBe('complaint');
    expect(plan(vocal({ trip: [makeStay({ gridX: 0, gridY: 4, floor: 0 }, 50, 60, 'away')], tripKind: 'outing' }))).toBe('outing'); // out: carries on
    expect(plan(vocal({ checkInDay: 1, stayLength: 2 }))).toBeUndefined(); // checks out today
    expect(plan(vocal({ complaint: { about: 'x', via: 'phone', at: 1 } }))).toBeUndefined();
    expect(plan(vocal({ hadNoiseComplaint: true }))).toBeUndefined();
    expect(plan(vocal(), { staff: { ...createStarterHotel().staff, frontDesk: 0 } })).toBeUndefined();
    expect(plan(vocal(), { activeIncidents: [{ id: 'i', type: 'mid_stay_breakdown', guestId: 'v', roomId: 'r', stage: 'active', hoursRemaining: 3, chainId: 'c' }] })).toBeUndefined();
    const s = hotel([vocal()]);
    const host = { ...s, walkers: [{ id: 'f', trait: 'normal' as const, isReturning: false, reason: 'visitor' as const, hostId: 'v', trip: [makeStay(roomTile(s.rooms[0]), hourStart(s) - 1, hourStart(s) + 2, 'in_room', { placeId: s.rooms[0].id })] }] };
    expect(planDeskComplaints(host).guests[0].tripKind).toBeUndefined();
    withSwitch(VOICE, false, () => expect(plan(vocal({ satisfaction: 5 }))).toBeUndefined());
    withSwitch(PATIENCE, false, () => expect(plan(vocal())).toBeUndefined()); // in person needs the desk queue (a clerk's time)
  });

  it('a trip down cut short before the counter (no clerk left) doesn\u2019t count: they go back, and can come down again', () => {
    const s = hotel([vocal()]);
    const planned = planDeskComplaints(s);
    const legs = planned.guests[0].trip!;
    const said = legs.find(l => l.kind === 'stay' && l.activity === 'complain') as StayLeg;
    const t = (legs[0].start + said.start) / 2;
    const gone = settleChanges(planned, { ...planned, staff: { ...planned.staff, frontDesk: 0 } }, t);
    const g = gone.guests[0];
    expect(g.trip!.some(l => l.kind === 'stay' && l.activity === 'complain')).toBe(false);
    expect(hasComplained(g)).toBe(false);
    expect(hearComplaints(gone, legsEnd(g.trip!) + 1).events).toEqual([]);
    // They turn back at once, not on down to an empty desk
    expect(g.trip!.some(l => l.kind === 'walk' && l.end > t && sameTile(l.path[l.path.length - 1], said.at))).toBe(false);
    // Back in their room, with a clerk at the desk again: down they come
    const later = { ...gone, hour: 11, staff: { ...gone.staff, frontDesk: 1 }, guests: [{ ...g, trip: null, tripKind: undefined }] };
    expect(planDeskComplaints(later).guests[0].tripKind).toBe('complaint');
  });

  it('in line: guests checking in come first; complaints in the order they got there', () => {
    const s = hotel([vocal(), guest('w'), guest('c', { profile: with_({ voice: 'vocal' }) })]);
    const [a] = lanesOf(s);
    const T = hourStart(s);
    const at = (activity: 'check_in' | 'complain', ready: number, start: number, hours: number) => [
      ...(start > ready ? [makeStay(a.front, ready, start, 'wait', { placeId: a.desk.id, lane: a.key })] : []),
      makeStay(a.front, start, start + hours, activity, { placeId: a.desk.id, lane: a.key }),
    ];
    const C = VOICE.complainHours;
    // Booked in the order they were planned: v's complaint (there at 0.1), then w checking in (there at
    // 0.2), then c's complaint (there at 0.05)
    const booked = {
      ...s,
      guests: [
        { ...s.guests[0], tripKind: 'complaint' as const, complaint: { about: 'x', via: 'desk' as const }, trip: at('complain', T + 0.1, T + 0.1, C) },
        { ...s.guests[1], tripKind: 'arrival' as const, trip: at('check_in', T + 0.2, T + 0.1 + C, CHECK_IN_HOURS) },
        { ...s.guests[2], tripKind: 'complaint' as const, complaint: { about: 'x', via: 'desk' as const }, trip: at('complain', T + 0.05, T + 0.1 + C + CHECK_IN_HOURS, C) },
      ],
    };
    const seated = reseatLanes(booked, T);
    const start = (id: string, activity: string) => (seated.guests.find(g => g.id === id)!.trip!.find(l => l.kind === 'stay' && l.activity === activity) as StayLeg).start;
    expect(start('w', 'check_in')).toBeCloseTo(T + 0.2, 9); // checking in: straight away
    expect(start('c', 'complain')).toBeCloseTo(T + 0.2 + CHECK_IN_HOURS, 9); // then c, who got there first
    expect(start('v', 'complain')).toBeCloseTo(T + 0.2 + CHECK_IN_HOURS + C, 9); // then v
    // Each waits in line from when they got there
    const v = seated.guests.find(g => g.id === 'v')!.trip!;
    expect(v[0]).toMatchObject({ kind: 'stay', activity: 'wait', lane: a.key });
    expect(v[0].start).toBeCloseTo(T + 0.1, 9);
  });

  it('someone at the counter when the building changes carries on there: heard once', () => {
    const s = hotel([vocal()]);
    const planned = planDeskComplaints(s);
    const said = planned.guests[0].trip!.find(l => l.kind === 'stay' && l.activity === 'complain') as StayLeg;
    const back = planned.guests[0].trip!.slice(planned.guests[0].trip!.indexOf(said) + 1);
    const path = back.flatMap(l => (l.kind === 'walk' ? l.path : []));
    const t = said.start + 0.05;
    // A room built across their way back (a tile on it that isn't the desk's front or their door)
    const across = path.slice(1, -1).map(p => addRoom(planned, 'standard', p.gridX, p.gridY, p.floor, 'up')).find(Boolean)!;
    expect(across).toBeTruthy();
    const built = settleChanges(planned, across, t);
    expect(built.guests[0].trip!.filter(l => l.kind === 'stay' && l.activity === 'complain')).toHaveLength(1);
    const first = hearComplaints(built, said.start + 0.1);
    expect(first.events).toHaveLength(1);
    expect(hearComplaints(first.state, said.start + 1.1).events).toEqual([]);
  });

  it('what about: what costs them most (last night\u2019s noise, a worn room), else their stay', () => {
    const s = hotel([vocal()]);
    const room = s.rooms[0];
    const T = hourStart(s);
    const night = Math.floor((T - 23) / 24);
    const woken = (lastNight: number) => vocal({ nightNoise: { exposure: 1, woken: 1, lastWokenNight: night, lastNight } });
    expect(complaintAbout(s, woken(1), room)).toEqual({ cause: 'noise', label: 'the noise last night' });
    expect(complaintAbout(s, woken(1), { ...room, condition: 20 }).cause).toBe('noise'); // a bad night beats a worn room
    expect(complaintAbout(s, woken(0.03), { ...room, condition: 20 }).cause).toBe('condition'); // a little noise doesn't
    expect(complaintAbout(s, vocal({ nightNoise: { exposure: 1, woken: 1, lastWokenNight: night - 1, lastNight: 1 } }), room).cause).not.toBe('noise'); // the night before
    expect(complaintAbout(s, vocal(), { ...room, condition: 20 }).cause).toBe('condition');
    // A save from before last night's noise was kept: their average night stands in
    expect(complaintAbout(s, vocal({ nightNoise: { exposure: 2, woken: 2, lastWokenNight: night } }), room).cause).toBe('noise');
    expect(complaintAbout(s, vocal(), { ...room, condition: 100, cleanliness: 100 })).toEqual({ cause: 'stay', label: 'their stay' });
  });

  it('heard once they get to the counter: a little better for it, a toast, a line in the story log (with advice, once a day)', () => {
    const base = hotel([vocal(), guest('w', { profile: with_({ voice: 'vocal' }), satisfaction: 46 })]);
    const worn = { ...base, rooms: base.rooms.map(r => ({ ...r, condition: 20 })) };
    const planned = planDeskComplaints(worn);
    const said = planned.guests.map(g => g.trip!.find(l => l.kind === 'stay' && l.activity === 'complain') as StayLeg);
    // Before they get there: nothing
    expect(hearComplaints(planned, Math.min(...said.map(l => l.start))).events).toEqual([]);
    const T = Math.max(...said.map(l => l.start)) + 0.01;
    const r = hearComplaints(planned, T);
    expect(r.events.map(e => e.type)).toEqual(['guest_complained', 'guest_complained']);
    expect(r.events[0].message).toMatch(/complained at the front desk about the state of the room$/);
    expect(r.state.guests[0].satisfaction).toBeCloseTo(46 + VOICE.heardMood, 9);
    expect(r.state.guests[0].complaint!.at).toBeCloseTo(said[0].start, 9);
    const lines = r.state.storyLog.filter(e => e.chainId === `complaints-${base.day}`);
    expect(lines).toHaveLength(2);
    expect(lines.filter(e => e.message.includes(COMPLAINT_ADVICE.condition!))).toHaveLength(1); // advice once a day
    expect(lines.every(e => e.id !== e.chainId)).toBe(true); // not a new story: no incident budget
    expect(r.state.deskToday!.complaints).toBe(2);
    expect(hearComplaints(r.state, T + 1).events).toEqual([]); // once
    // Once, even split in two
    const g = planned.guests[0];
    const k = g.trip!.indexOf(said[0]);
    const split = { ...planned, guests: [{ ...g, trip: [...g.trip!.slice(0, k), { ...said[0], end: said[0].start + 0.1 }, { ...said[0], start: said[0].start + 0.1 }, ...g.trip!.slice(k + 1)] }] };
    const one = hearComplaints(split, said[0].start + 0.05);
    expect(one.events).toHaveLength(1);
    expect(hearComplaints(one.state, said[0].start + 0.2).events).toEqual([]);
  });

  it('two come down to complain at once: whoever gets to the desk first is heard first', () => {
    let found = 0;
    for (let i = 0; i < 400 && found < 3; i++) {
      const a = guest(`a${i}`, { profile: with_({ voice: 'vocal' }), satisfaction: 40 });
      const b = guest(`b${i}`, { profile: with_({ voice: 'vocal' }), satisfaction: 40 });
      const planned = planDeskComplaints(hotel([a, b]));
      const at = (id: string) => {
        const trip = planned.guests.find(g => g.id === id)!.trip;
        const k = trip ? trip.findIndex(l => l.kind === 'stay' && l.activity === 'complain') : -1;
        return k < 0 ? null : { ready: readyAt(trip!, k), start: trip![k].start };
      };
      const [pa, pb] = [at(a.id), at(b.id)];
      // b planned second, but there first, and close enough that one would wait for the other
      if (!pa || !pb || !(pb.ready < pa.ready && pa.ready < pb.ready + VOICE.complainHours)) continue;
      found++;
      expect(pb.start).toBeLessThan(pa.start);
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('Voice at night, in reviews, and on screen', () => {
  it('the night\’s noise complaint: a vocal guest kept awake rings at 46; a stoic one never; the pick is drawn either way', () => {
    // A rowdy night owl awake next to a vocal regular asleep at midnight
    const sleeper = guest('s', { profile: with_({ voice: 'vocal' }), satisfaction: 46 });
    const owl = guest('o', { profile: with_({ chronotype: 'night', rowdiness: 'rowdy' }), party: { kind: 'friends', size: 4 } });
    const s = hotel([sleeper, owl], { day: 3, hour: 0, storyLog: [] });
    const filed = (st: HotelState) => selectNewIncident(st, new PRNG(1));
    // (the quiet bias: with no origins in the log, the fire chance is 1)
    const r = filed(s);
    expect(r.state.activeIncidents.map(i => [i.type, i.guestId])).toEqual([['noise_complaint', 's']]);
    expect(r.state.guests[0].complaint).toMatchObject({ via: 'phone', about: 'the noise' });
    const stoic = { ...s, guests: [{ ...sleeper, profile: with_({ voice: 'stoic' }) }, owl] };
    expect(filed(stoic).state.activeIncidents).toEqual([]);
    // Off: 46 isn't below the old line
    withSwitch(VOICE, false, () => expect(filed(s).state.activeIncidents).toEqual([]));
    // One complaint a stay: someone who's been down to the desk today doesn't ring as well
    const been = { ...s, guests: [{ ...sleeper, complaint: { about: 'x', via: 'desk' as const, at: hourStart(s) - 10 } }, owl] };
    expect(filed(been).state.activeIncidents).toEqual([]);
    // With Voice on the pick is drawn even with nobody to pick (the stream doesn't follow moods)
    const draws = (on: boolean) => withSwitch(VOICE, on, () => { const p = new PRNG(5); selectNewIncident(stoic, p); return p.next(); });
    const p2 = new PRNG(5); p2.next(); p2.next();
    expect(draws(true)).toBe(p2.next());
  });

  it('visitors next door: a stoic neighbour never complains, a vocal one likelier; nor anyone who\u2019s complained already', () => {
    const pick = (ok: (roll: number) => boolean) => {
      for (let i = 0; ; i++) if (ok(hash01(`n${i}|h|3|complain`))) return `n${i}`;
    };
    const light = HOSTED_NIGHTS.complaintChance.light;
    const ids = [pick(roll => roll >= light && roll < light * VOICE.visitorComplaintMult.vocal), pick(roll => roll < light)];
    const host = guest('h', { profile: with_({ rowdiness: 'rowdy' }), checkInDay: 3, stayLength: 1, hostedNight: { day: 3, visitors: 2 } });
    const run = (voice: 'vocal' | 'typical' | 'stoic', id = ids[0], extra: Partial<Guest> = {}) => {
      const s0 = hotel([host, guest(id, { profile: with_({ sleep: 'light', voice }), ...extra })], { day: 3, hour: 23, visitorPolicy: 'allow' });
      const tile = roomTile(s0.rooms[0]);
      const inn = routeFromStreet(s0, tile, TRAVEL.guestHoursPerTile)!;
      const walkIn = makeWalk(inn.path, 70 - 1, TRAVEL.guestHoursPerTile);
      const w: Walker = { id: 'vis', trait: 'normal', isReturning: false, reason: 'visitor', hostId: 'h', party: { kind: 'friends', size: 2 }, trip: [walkIn, makeStay(tile, walkIn.end, 74, 'in_room', { placeId: s0.rooms[0].id })] };
      return fileVisitorComplaints({ ...s0, walkers: [w] }, 72).state;
    };
    const make = (...a: Parameters<typeof run>) => run(...a).activeIncidents.length;
    expect(make('vocal')).toBe(1); // a roll only a vocal guest's raised chance covers
    expect(make('typical')).toBe(0);
    expect(make('stoic')).toBe(0);
    expect(make('typical', ids[1])).toBe(1); // a roll anyone's chance covers
    expect(make('stoic', ids[1])).toBe(0); // but a stoic guest's
    expect(make('typical', ids[1], { complaint: { about: 'x', via: 'desk', at: 60 } })).toBe(0); // one a stay
    expect(run('typical', ids[1]).guests.find(g => g.id === ids[1])!.complaint).toMatchObject({ via: 'phone', about: 'the visitors next door', at: 72 }); // (this call was theirs)
  });

  it('a stoic guest minds more in their review, the others a little less (on average the same); off, as ever', () => {
    const room = (s: HotelState) => ({ ...s.rooms[0], condition: 30, cleanliness: 30 });
    const s = hotel([guest('a')]);
    const score = (voice: 'vocal' | 'typical' | 'stoic') => calculateGuestReviewBreakdown(room(s), s, guest('a', { profile: with_({ voice }) }), new PRNG(1)).finalScore;
    expect(score('stoic')).toBeLessThan(score('typical'));
    expect(score('vocal')).toBe(score('typical'));
    const mean = 0.25 * VOICE.reviewPenaltyMult.vocal + 0.55 * VOICE.reviewPenaltyMult.typical + 0.2 * VOICE.reviewPenaltyMult.stoic;
    expect(mean).toBeCloseTo(1, 9);
    withSwitch(VOICE, false, () => expect(calculateGuestReviewBreakdown(room(s), s, guest('a', { profile: with_({ voice: 'stoic' }) }), new PRNG(1)).finalScore)
      .toBe(calculateGuestReviewBreakdown(room(s), s, guest('a', { profile: with_({ voice: 'typical' }) }), new PRNG(1)).finalScore));
  });

  it('a stoic guest\’s bad review is twice as likely to be the one that spreads (the same one draw)', () => {
    const review = (name: string, voice: 'typical' | 'stoic'): DepartedGuestReview => ({
      guestName: name, roomId: 'r', voice,
      booking: { id: name, roomId: 'r', guestId: name, nightRate: 80, reviewScore: 1, satisfactionAtCheckout: 30 },
      breakdown: { noisePenalty: 0, decorPenalty: 0, elevatorPenalty: 0, conditionBonus: -1, cleanlinessBonus: 0, amenityPenalty: 0, priceFairness: 1, guestVariance: 0, facilityBonus: 0, amenityBonus: 0, roomFit: 0, finalScore: 1 },
    });
    const s = hotel([guest('a')], { storyLog: [] });
    let stoicPicked = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const r = checkReviewSemiViral(s, [review('Ann', 'typical'), review('Sto', 'stoic')], new PRNG(seed));
      if (r.state.storyLog[0]?.guestName === 'Sto') stoicPicked++;
    }
    expect(Math.abs(stoicPicked / 600 - 2 / 3)).toBeLessThan(0.06);
  });

  it('a room move after a breakdown waits while the guest is down at the desk complaining', () => {
    const s0 = hotel([vocal(), guest('x')]);
    const planned = planDeskComplaints(s0);
    const broken = {
      ...planned,
      rooms: planned.rooms.map((r, i) => (i === 0 ? { ...r, condition: 0 } : { ...r, status: 'vacant' as const, guestId: undefined })),
      guests: [planned.guests[0]],
      activeIncidents: [{ id: 'i', type: 'mid_stay_breakdown' as const, guestId: 'v', roomId: planned.rooms[0].id, stage: 'active' as const, hoursRemaining: 2, chainId: 'c' }],
    };
    const T = hourStart(broken) + 1;
    const r = advanceIncidents(broken, new PRNG(1), T);
    expect(r.state.activeIncidents).toHaveLength(1);
    expect(r.state.activeIncidents[0].hoursRemaining).toBe(2); // waiting, not counting down
    expect(r.state.guests[0].tripKind).toBe('complaint');
  });

  it('in the tick: someone fed up walks down, is heard (a toast, counted for the day), once', () => {
    let s = hotel([vocal({ satisfaction: 30 }), guest('x', { satisfaction: 80 })]);
    const prng = new PRNG(4);
    const types: string[] = [];
    for (let h = 0; h < 5; h++) {
      const r = tickSimulation(s, prng);
      types.push(...r.events.map(e => e.type));
      s = r.state;
    }
    expect(types.filter(t => t === 'guest_complained')).toHaveLength(1);
    expect(s.deskToday!.complaints).toBe(1);
    expect(s.guests.find(g => g.id === 'v')!.complaint).toMatchObject({ via: 'desk', at: expect.any(Number) });
    expect(s.guests.find(g => g.id === 'x')!.complaint).toBeUndefined();
  });

  it('at checkout a review carries its writer\u2019s voice: a stoic guest\u2019s bad one is the one that spreads twice as often', () => {
    const was = { ...VOICE.reviewPenaltyMult };
    const line = STORY.reviewSemiViralScoreThreshold;
    Object.assign(VOICE.reviewPenaltyMult, { vocal: 1, typical: 1, stoic: 1 }); // (the same reviews, whoever wrote them)
    STORY.reviewSemiViralScoreThreshold = 11; // (and every one bad enough to spread)
    try {
      let stoic = 0;
      let n = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const s0 = hotel([guest('a', { checkInDay: 1, stayLength: 2 }), guest('b', { checkInDay: 1, stayLength: 2, profile: with_({ voice: 'stoic' }) })], { hour: 10, storyLog: [] });
        const r = tickSimulation(s0, new PRNG(seed));
        const viral = r.state.storyLog.find(e => e.type === 'review_semi_viral');
        if (!viral) continue;
        n++;
        if (viral.guestName === 'b') stoic++;
      }
      expect(n).toBeGreaterThan(200);
      expect(Math.abs(stoic / n - 2 / 3)).toBeLessThan(0.08);
    } finally {
      Object.assign(VOICE.reviewPenaltyMult, was);
      STORY.reviewSemiViralScoreThreshold = line;
    }
  });

  it('on screen: someone on the way to complain has a bubble; a stoic guest\’s mood face doesn\’t show', () => {
    const s = planDeskComplaints(hotel([vocal()]));
    const t = s.guests[0].trip![0].start + 0.05;
    const { figures } = guestFigures(s, t);
    expect(figures.find(f => f.id === 'v')!.complaining).toBe(true);
    const angry = { ...s, guests: [{ ...s.guests[0], satisfaction: 20, profile: with_({ voice: 'stoic' }) }] };
    expect(guestFigures(angry, t).figures.find(f => f.id === 'v')!.mood).toBeUndefined();
    const angryVocal = { ...s, guests: [{ ...s.guests[0], satisfaction: 20 }] };
    expect(guestFigures(angryVocal, t).figures.find(f => f.id === 'v')!.mood).toBe('angry');
    expect(legsEnd(s.guests[0].trip!)).toBeGreaterThan(t);
  });
});
