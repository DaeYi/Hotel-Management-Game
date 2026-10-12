import { describe, it, expect } from 'vitest';
import { createStarterHotel, addRoom } from '../src/simulation/HotelState.js';
import { processArrivals, calculateGuestReviewBreakdown } from '../src/simulation/GuestManager.js';
import { rollParty } from '../src/simulation/Party.js';
import { rollPurpose, describeGuest, awayActivity, popularWith, outingHours, PURPOSES } from '../src/simulation/Purpose.js';
import { roomFeatures, roomFit, whoSuits, listFeatures, type RoomFeature } from '../src/simulation/Preferences.js';
import { profileFurnishing, defaultFurnishing } from '../src/simulation/RoomProfile.js';
import { outingChance, planOutings } from '../src/simulation/OutingManager.js';
import { visitChance } from '../src/simulation/FacilityManager.js';
import { driftSatisfaction, recordRoomDislikes, attributeReviewCause, type DepartedGuestReview } from '../src/simulation/StoryGenerator.js';
import { departureWalker, planArrivalTrips } from '../src/simulation/GuestMovement.js';
import { guestFigures, getGuestDotColor } from '../src/render/figures.js';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { PRNG } from '../src/simulation/prng.js';
import { hourStart, legsEnd } from '../src/simulation/Movement.js';
import { GUEST_PURPOSES, ROOM_PREFERENCES, GUEST_OUTINGS, FACILITY_CONFIG, ECONOMY, REVIEW, PARTIES } from '../src/config/balance.js';
import { tickSimulation } from '../src/simulation/tick.js';
import type { ActiveIncident } from '../src/simulation/types.js';
import type { PresetId } from '../src/config/furniture.js';
import type { Guest, HotelState, Party, PartyKind, Purpose, Room, GuestTrait } from '../src/simulation/types.js';

const P = (kind: PartyKind, size: number): Party => ({ kind, size });

function guest(id: string, party: Party, purpose: Purpose | undefined, extra: Partial<Guest> = {}): Guest {
  return {
    id, name: 'Priya', budget: 1000, stayLength: 2, trait: 'normal', satisfaction: 50, checkInDay: 1, isReturning: false, hadNoiseComplaint: false,
    party, ...(purpose ? { purpose } : {}), ...extra,
  };
}

/** A hotel with rooms of the given kinds on row 2, all empty. */
function hotel(kinds: Array<Parameters<typeof addRoom>[1]>, extra: Partial<HotelState> = {}): HotelState {
  let s: HotelState = { ...createStarterHotel(), cash: 1_000_000, peakStarRating: 5, ...extra };
  kinds.forEach((kind, x) => { s = addRoom(s, kind, x, 2)!; });
  return s;
}

/** A guest checked into a room. */
function staying(s: HotelState, room: Room, g: Guest): HotelState {
  return {
    ...s,
    guests: [...s.guests, g],
    rooms: s.rooms.map(r => (r.id === room.id ? { ...r, status: 'occupied' as const, guestId: g.id } : r)),
  };
}

const features = (preset: PresetId) => [...roomFeatures(profileFurnishing(defaultFurnishing(preset)))].sort();

describe('Why guests come', () => {
  it('follows from the party: business parties are on business, couples, friends and families never are', () => {
    for (let i = 0; i < 2000; i++) {
      const id = `g-${i}`;
      expect(rollPurpose(id, P('business', 1))).toBe('business');
      for (const kind of ['couple', 'friends', 'family'] as PartyKind[]) expect(rollPurpose(id, P(kind, kind === 'couple' ? 2 : 3))).not.toBe('business');
      expect(rollPurpose(id, P('solo', 1))).toBe(rollPurpose(id, P('solo', 1)));
    }
  });

  it('the mix moves with the week through the party mix: business on weekdays, sightseeing at weekends', () => {
    const mix = (day: number) => {
      const n: Record<string, number> = {};
      for (let i = 0; i < 20000; i++) {
        const id = `g${i}`;
        const p = rollPurpose(id, rollParty(id, day))!;
        n[p] = (n[p] ?? 0) + 1 / 20000;
      }
      return n;
    };
    const weekday = mix(1); // a spring Monday
    const weekend = mix(6); // a spring Saturday
    expect(weekday.business).toBeCloseTo(0.445, 1);
    expect(weekday.sightseeing).toBeCloseTo(0.325, 1);
    expect(weekend.business).toBeCloseTo(0.155, 1);
    expect(weekend.sightseeing).toBeCloseTo(0.51, 1);
    expect(weekend.getaway).toBeGreaterThan(weekday.getaway);
  });

  it('with purposes off nobody has one, and who books never moves the shared random stream', () => {
    const s = { ...hotel(['standard', 'standard', 'bunk_family']), day: 6, hour: 15, staff: { ...createStarterHotel().staff, frontDesk: 4 } };
    const on = new PRNG(11);
    const withPurposes = processArrivals(s, 15, on);
    expect(withPurposes.checkedIn.length).toBeGreaterThan(0);
    for (const { guest: g } of withPurposes.checkedIn) expect(PURPOSES).toContain(g.purpose);
    GUEST_PURPOSES.enabled = false;
    const off = new PRNG(11);
    try {
      const without = processArrivals(s, 15, off);
      for (const { guest: g } of without.checkedIn) expect(g.purpose).toBeUndefined();
      expect(without.checkedIn.map(c => c.guest.id)).toEqual(withPurposes.checkedIn.map(c => c.guest.id));
    } finally { GUEST_PURPOSES.enabled = true; }
    expect(on.next()).toBe(off.next());
  });

  it('a party that books smaller keeps the purpose it came with (parents who take a double are still sightseeing)', () => {
    const s = hotel(['standard', 'standard', 'standard', 'standard']);
    const prng = new PRNG(3);
    let smaller = 0;
    for (let day = 1; day <= 40; day++) {
      for (let hour = ECONOMY.checkInStartHour; hour < ECONOMY.checkInEndHour; hour++) {
        const r = processArrivals({ ...s, day, hour, staff: { ...s.staff, frontDesk: 6 } }, hour, prng);
        for (const { guest: g } of r.checkedIn) {
          const original = rollParty(g.id, day);
          expect(g.purpose).toBe(rollPurpose(g.id, original));
          if (original.size > (g.party?.size ?? 1)) smaller++;
        }
      }
    }
    expect(smaller).toBeGreaterThan(5);
  });

  it('reads in a few words', () => {
    expect(describeGuest(P('business', 1), 'business')).toBe('a business traveller');
    expect(describeGuest(P('solo', 1), 'business')).toBe('a business traveller');
    expect(describeGuest(P('couple', 2), 'getaway')).toBe('a couple on a getaway');
    expect(describeGuest(P('family', 4), 'sightseeing')).toBe('a family of four sightseeing');
    expect(describeGuest(P('couple', 2), undefined)).toBe('a couple');
    expect(awayActivity({ purpose: 'business' })).toBe('out at a meeting');
    expect(awayActivity({})).toBe('out for the day');
  });
});

describe('What guests do, by why they came', () => {
  it('business travellers and sightseers go out more, and for longer; a getaway stays in', () => {
    const hour = GUEST_OUTINGS.leaveChance[0][0];
    const base = outingChance({ trait: 'normal' }, hour);
    expect(outingChance({ trait: 'normal', purpose: 'business' }, hour)).toBeCloseTo(base * GUEST_PURPOSES.outing.business.chanceMult, 9);
    expect(outingChance({ trait: 'normal', purpose: 'getaway' }, hour)).toBeLessThan(base);
    expect(outingChance({ trait: 'normal', purpose: 'sightseeing' }, hour)).toBeGreaterThan(base);
    expect(outingHours({ purpose: 'sightseeing' }).minHours).toBeGreaterThan(GUEST_OUTINGS.minHours);
    expect(outingHours({ purpose: 'sightseeing' }).maxHours).toBeGreaterThan(GUEST_OUTINGS.maxHours);
    expect(outingHours({ purpose: 'getaway' }).maxHours).toBeLessThan(GUEST_OUTINGS.maxHours);
    expect(outingHours({ purpose: 'business' }).minHours).toBeGreaterThan(GUEST_OUTINGS.maxHours - 2);
    expect(outingHours({})).toMatchObject({ minHours: GUEST_OUTINGS.minHours, maxHours: GUEST_OUTINGS.maxHours });
  });

  it('a business traveller is out at meetings till the evening (back by the latest return)', () => {
    const saved = GUEST_OUTINGS.leaveChance;
    GUEST_OUTINGS.leaveChance = [[0, 24, 1]];
    try {
      let s = hotel(['standard']);
      s = staying({ ...s, day: 3, hour: 8 }, s.rooms[0], guest('biz', P('business', 1), 'business', { checkInDay: 2, stayLength: 3 }));
      const after = planOutings(s);
      const trip = after.guests[0].trip!;
      const away = trip.find(l => l.kind === 'stay')!;
      expect(away.end - away.start).toBeGreaterThanOrEqual(GUEST_PURPOSES.outing.business.minHours - 1e-9);
      expect(legsEnd(trip)).toBeLessThanOrEqual(hourStart({ ...s, hour: 0 }) + GUEST_OUTINGS.latestReturnHour + 1e-9);
    } finally { GUEST_OUTINGS.leaveChance = saved; }
  });

  it('facilities by purpose: business travellers to the gym, a getaway to the pool, sightseers to the shop', () => {
    const at = (type: 'gym' | 'pool' | 'shop', purpose?: Purpose) => {
      const hour = FACILITY_CONFIG[type].visitChance[0][0];
      return visitChance(type, hour, 40, purpose ? { purpose } : {});
    };
    expect(at('gym', 'business')).toBeGreaterThan(at('gym'));
    expect(at('pool', 'getaway')).toBeGreaterThan(at('pool'));
    expect(at('pool', 'business')).toBeLessThan(at('pool'));
    expect(at('shop', 'sightseeing')).toBeGreaterThan(at('shop'));
    expect(visitChance('gym', 7, 40)).toBe(visitChance('gym', 7, 40, {})); // a guest from before purposes, as before
    expect(popularWith('gym')).toContain('business travellers');
    expect(popularWith('pool')).toContain('guests on a getaway');
    expect(popularWith('shop')).toContain('sightseers');
  });

  it('a chance never goes over one', () => {
    const saved = FACILITY_CONFIG.pool.visitChance;
    FACILITY_CONFIG.pool.visitChance = [[0, 24, 0.9]];
    try { expect(visitChance('pool', 12, 100, { purpose: 'getaway' })).toBe(1); } finally { FACILITY_CONFIG.pool.visitChance = saved; }
  });
});

describe('What a room has that guests care about', () => {
  it('is read off the furniture', () => {
    expect(features('classic_queen')).toEqual([]);
    expect(features('compact_deluxe')).toEqual(['deluxe', 'desk', 'kingBed']);
    expect(features('exec_studio')).toEqual(['art', 'deluxe', 'kingBed', 'lounge', 'tub']);
    expect(features('twin')).toEqual(['separateBeds']);
    expect(features('deluxe_twin')).toEqual(['deluxe', 'desk', 'separateBeds']);
    expect(features('bunk_family')).toEqual([]); // the parents share the queen
  });

  it('an armchair isn\'t a desk, and a sofa bed isn\'t a sofa', () => {
    const f = defaultFurnishing('classic_queen');
    const desk = { ...f, items: f.items.map(i => (i.kind === 'armchair' ? { ...i, kind: 'desk' as const } : i)) };
    expect(roomFeatures(profileFurnishing(desk)).has('desk')).toBe(true);
    const queen = profileFurnishing(f);
    const withSofaBed = { ...queen, items: [...queen.items, { ...queen.items[0], id: 'living', kind: 'sofa_bed' as const }] };
    expect(roomFeatures(withSofaBed).has('sofaBed')).toBe(true);
    expect(roomFeatures(withSofaBed).has('lounge')).toBe(false);
  });
});

describe('Room fit', () => {
  const fit = (preset: PresetId, g: Pick<Guest, 'purpose' | 'party' | 'trait'>) => roomFit(profileFurnishing(defaultFurnishing(preset)), g);
  const who = (kind: PartyKind, size: number, purpose?: Purpose, trait: GuestTrait = 'normal') => ({ party: P(kind, size), trait, ...(purpose ? { purpose } : {}) });

  it('business travellers like a desk; a plain room is fine for anyone', () => {
    expect(fit('compact_deluxe', who('business', 1, 'business'))).toEqual({ score: 0.4, likes: ['desk'], dislikes: [] });
    for (const g of [who('business', 1, 'business'), who('couple', 2, 'sightseeing'), who('family', 4, 'getaway'), who('solo', 1, 'sightseeing', 'big_spender')]) {
      expect(fit('classic_queen', g).score).toBe(0);
    }
  });

  it('couples don\'t like separate beds', () => {
    expect(fit('twin', who('couple', 2, 'sightseeing'))).toEqual({ score: -0.6, likes: [], dislikes: ['separateBeds'] });
    expect(fit('twin', who('friends', 2, 'sightseeing')).score).toBe(0); // friends want them
  });

  it('a getaway couple in a suite likes everything, up to the cap', () => {
    const f = fit('exec_studio', who('couple', 2, 'getaway'));
    expect(f.score).toBe(ROOM_PREFERENCES.maxFit);
    expect(f.likes).toEqual(['kingBed', 'tub', 'art']);
    expect(listFeatures(f.likes)).toBe('the king bed, the bathtub and the artwork');
    // A big spender on a getaway likes the grade too: 1.3 in all, capped
    const more = fit('exec_studio', who('couple', 2, 'getaway', 'big_spender'));
    expect(more.score).toBe(ROOM_PREFERENCES.maxFit);
    expect(more.likes).toEqual(['kingBed', 'tub', 'art', 'deluxe']);
    expect(listFeatures(more.likes, 'suite')).toBe('the king bed, the bathtub, the artwork and the suite');
    const saved = ROOM_PREFERENCES.maxFit;
    ROOM_PREFERENCES.maxFit = 0.5;
    try {
      expect(fit('twin', who('couple', 2, 'sightseeing')).score).toBe(-0.5);
      expect(fit('exec_studio', who('couple', 2, 'getaway')).score).toBe(0.5);
    } finally { ROOM_PREFERENCES.maxFit = saved; }
  });

  it('a business party likes a desk even with purposes off; big spenders like a deluxe room', () => {
    expect(fit('compact_deluxe', who('business', 1)).likes).toContain('desk');
    expect(fit('compact_deluxe', who('solo', 1, 'sightseeing', 'big_spender')).likes).toEqual(['deluxe']);
  });

  it('with preferences off, nobody likes or dislikes anything', () => {
    ROOM_PREFERENCES.enabled = false;
    try { expect(fit('twin', who('couple', 2, 'sightseeing')).score).toBe(0); } finally { ROOM_PREFERENCES.enabled = true; }
  });
});

describe('In the review and the mood', () => {
  it('adds the room fit to the review, with no extra draw from the shared random stream', () => {
    let s = hotel(['compact_deluxe']);
    const room = s.rooms[0];
    s = staying(s, room, guest('a', P('business', 1), 'business'));
    const r1 = new PRNG(5);
    const r2 = new PRNG(5);
    const liked = calculateGuestReviewBreakdown(room, s, guest('a', P('business', 1), 'business'), r1);
    const plain = calculateGuestReviewBreakdown(room, s, guest('a', P('solo', 1), 'sightseeing'), r2);
    expect(liked.roomFit).toBeCloseTo(0.4, 9);
    expect(liked.roomLikes).toEqual(['desk']);
    expect(plain.roomFit).toBe(0);
    expect(plain.roomLikes).toBeUndefined();
    expect(liked.finalScore - plain.finalScore).toBeCloseTo(0.4, 9);
    // Exactly the one draw a review always made (its variance), whoever the guest
    const ref = new PRNG(5);
    const variance = ref.range(-REVIEW.varianceRange, REVIEW.varianceRange);
    expect(liked.guestVariance).toBe(variance);
    expect(plain.guestVariance).toBe(variance);
    const next = ref.next();
    expect(r1.next()).toBe(next);
    expect(r2.next()).toBe(next);
  });

  it('a couple in separate beds reviews worse, and the review blames the beds when it\'s the worst thing', () => {
    let s = hotel(['twin']);
    const room = { ...s.rooms[0], condition: 100, cleanliness: 100, decor: 100 };
    s = { ...s, rooms: [room] };
    const b = calculateGuestReviewBreakdown(room, s, guest('c', P('couple', 2), 'getaway'), new PRNG(2));
    expect(b.roomFit).toBeCloseTo(-0.6, 9);
    expect(b.roomDislikes).toEqual(['separateBeds']);
    expect(attributeReviewCause({ ...b, priceFairness: 1, noisePenalty: 0 })).toBe('separate beds');
  });

  it('a guest\'s mood drifts toward a higher mark in a room they like', () => {
    let s = hotel(['compact_deluxe', 'compact_deluxe']);
    s = staying(s, s.rooms[0], guest('biz', P('business', 1), 'business'));
    s = staying(s, s.rooms[1], guest('see', P('solo', 1), 'sightseeing'));
    let after = s;
    for (let i = 0; i < 200; i++) after = driftSatisfaction(after);
    const mood = (id: string) => after.guests.find(g => g.id === id)!.satisfaction;
    expect(mood('biz') - mood('see')).toBeCloseTo(4, 0); // 0.4 on the review is 4 points of mood
  });
});

describe('Who a room suits', () => {
  const suits = (preset: PresetId) => whoSuits(profileFurnishing(defaultFurnishing(preset)));

  it('a plain room suits nobody in particular', () => {
    expect(suits('classic_queen')).toEqual({ goodFor: [], notFor: [] });
    expect(suits('bunk_family')).toEqual({ goodFor: [], notFor: [] });
  });

  it('says who\'d like it, and who wouldn\'t', () => {
    expect(suits('compact_deluxe').goodFor).toEqual(['business travellers', 'couples', 'getaways', 'big spenders']);
    expect(suits('twin')).toEqual({ goodFor: [], notFor: [{ label: 'couples', because: 'separate beds' }] });
    expect(suits('deluxe_twin')).toEqual({ goodFor: ['business travellers', 'big spenders'], notFor: [{ label: 'couples', because: 'separate beds' }] });
    // A suite with one king bed: no families, no friends
    expect(suits('exec_studio').goodFor).toEqual(['couples', 'getaways', 'big spenders']);
  });

  it('is what the review would say: a twin with a bathtub isn\'t "good for getaways" (most are couples, who\'d mind the beds)', () => {
    const f = defaultFurnishing('twin');
    const tub = profileFurnishing({ ...f, items: f.items.map(i => (i.kind === 'bath_shower' ? { ...i, kind: 'bath_tub' as const } : i)) });
    expect(roomFit(tub, { purpose: 'getaway', party: P('couple', 2), trait: 'normal' }).score).toBeLessThan(0);
    expect(whoSuits(tub).goodFor).not.toContain('getaways');
    expect(whoSuits(tub).notFor).toEqual([{ label: 'couples', because: 'separate beds' }]);
  });

  it('with purposes off there are no getaways to suit, and no facility is popular with anyone', () => {
    GUEST_PURPOSES.enabled = false;
    try {
      expect(suits('exec_studio').goodFor).toEqual(['couples', 'big spenders']);
      expect(suits('compact_deluxe').goodFor).toContain('business travellers'); // business parties still book
      expect(popularWith('gym')).toEqual([]);
    } finally { GUEST_PURPOSES.enabled = true; }
    PARTIES.enabled = false;
    try { expect(suits('compact_deluxe').goodFor).toEqual(['business travellers', 'getaways', 'big spenders']); } finally { PARTIES.enabled = true; }
  });
});

describe('Telling the player', () => {
  const review = (name: string, room: Room, dislikes?: RoomFeature[]): DepartedGuestReview => ({
    guestName: name, roomId: room.id,
    booking: { id: `b-${name}`, roomId: room.id, guestId: name, nightRate: 100, reviewScore: 5, satisfactionAtCheckout: 50 },
    breakdown: {
      noisePenalty: 0, decorPenalty: 0, elevatorPenalty: 0, conditionBonus: 0, cleanlinessBonus: 0, amenityPenalty: 0,
      priceFairness: 1, guestVariance: 0, facilityBonus: 0, amenityBonus: 0, roomFit: dislikes ? -0.6 : 0, finalScore: 5,
      ...(dislikes ? { roomDislikes: dislikes } : {}),
    },
  });

  it('a story when guests didn\'t like something in their room: once a day, saying where and why', () => {
    const s = { ...hotel(['twin', 'twin', 'standard']), day: 4 };
    const [a, b, c] = s.rooms;
    const none = recordRoomDislikes(s, [review('Sam', c)]);
    expect(none.storyLog).toHaveLength(0);
    const one = recordRoomDislikes(s, [review('Priya', a, ['separateBeds']), review('Sam', c)]);
    expect(one.storyLog).toHaveLength(1);
    expect(one.storyLog[0].message).toMatch(/^Priya didn't like separate beds in room [^ ]+\. Couples want to share a bed, but they book the cheapest free room that sleeps two/);
    const two = recordRoomDislikes(s, [review('Priya', a, ['separateBeds']), review('the Okafor family', b, ['separateBeds'])]);
    expect(two.storyLog[0].message).toMatch(/^2 guests didn't like separate beds \(rooms [^ ]+, [^ ]+\)/);
    expect(recordRoomDislikes(one, [review('Lee', b, ['separateBeds'])]).storyLog).toHaveLength(1); // once a day
  });

  it('walkers keep their purpose, and figures are coloured by it', () => {
    let s = { ...hotel(['standard']), day: 2, hour: 11 };
    s = staying(s, s.rooms[0], guest('biz', P('business', 1), 'business'));
    const walker = departureWalker(s, s.guests[0], hourStart(s), 'checked_out')!;
    expect(walker.purpose).toBe('business');
    const { figures } = guestFigures({ ...s, guests: [], walkers: [walker] }, hourStart(s) + 0.01);
    expect(figures[0].color).toBe(getGuestDotColor('business'));
    // Turned away, or tired of waiting at the desk: drawn in their colour all the same
    const walkIns = planArrivalTrips(s, [], [{ guest: guest('imp', P('couple', 2), 'getaway'), outcome: 'impatient' }], hourStart(s));
    expect(walkIns.walkers.map(w => w.purpose)).toEqual(['getaway']);
  });

  it('a guest who walks out early is counted with what they thought of the room', () => {
    let s = { ...hotel(['twin']), day: 3, hour: 14 };
    s = staying(s, s.rooms[0], guest('cpl', P('couple', 2), 'getaway', { checkInDay: 2, stayLength: 3 }));
    const incident: ActiveIncident = { id: 'i', type: 'mid_stay_breakdown', guestId: 'cpl', roomId: s.rooms[0].id, stage: 'active', hoursRemaining: 1, chainId: 'i' };
    // Nowhere to move them: they walk out
    const { events } = tickSimulation({ ...s, rooms: s.rooms.map(r => ({ ...r, condition: 0 })), activeIncidents: [incident] }, new PRNG(1));
    const out = events.find(e => e.type === 'guest_walked_out');
    expect(out?.data).toMatchObject({ roomFit: -0.6, disliked: true, liked: false });
  });

  it('a returning guest comes back by name, whoever they bring this time', async () => {
    const { processArrivals: arrive } = await import('../src/simulation/GuestManager.js');
    const s = { ...hotel(['standard', 'bunk_family', 'twin', 'standard']), day: 6, hour: 15, staff: { ...createStarterHotel().staff, frontDesk: 6 }, returningGuestPool: Array.from({ length: 15 }, () => ({ name: 'Sam', trait: 'normal' as const, roomType: 'standard' as const })) };
    let returned: string[] = [];
    // Until one comes back with a bigger party than before (a family, say)
    for (let seed = 1; seed <= 200 && !returned.some(m => m.includes(', with')); seed++) {
      returned = [...returned, ...arrive(s, 15, new PRNG(seed)).events.filter(e => e.type === 'guest_returned').map(e => e.message)];
    }
    expect(returned.some(m => m.includes(', with'))).toBe(true);
    for (const m of returned) expect(m).toMatch(/^Sam is back for another stay(, with the family|, with friends)?!$/);
  });
});

describe('Balance', () => {
  it('purposes and preferences off: a run is exactly as it was', () => {
    // With both off, nothing new happens: no purposes, no room fit
    GUEST_PURPOSES.enabled = false;
    ROOM_PREFERENCES.enabled = false;
    try {
      const run = simulate(30, 9, undefined, STRATEGIES.balanced);
      // The same run before purposes and preferences existed (c0782c1). If an unrelated
      // balance change moves these, re-record them from a run with both switches off.
      expect(run.finalCash).toBeCloseTo(10843.2, 6);
      expect(run.avgReviewScore).toBeCloseTo(7.829402384430483, 9);
      expect(run.totalRevenue).toBe(36831);
      expect(run.totalTurnedAway).toBe(246);
      expect(run.avgRoomFit).toBe(0);
      expect(run.likedShare).toBe(0);
      expect(run.dislikedShare).toBe(0);
      expect(run.returningArrivals).toBe(0);
    } finally { GUEST_PURPOSES.enabled = true; ROOM_PREFERENCES.enabled = true; }
  }, 120000);

  it('on: some guests like their room, and the bot hotel still thrives', () => {
    const run = simulate(120, 9, undefined, STRATEGIES.balanced);
    expect(run.likedShare).toBeGreaterThan(0.05);
    expect(run.wentBankrupt).toBe(false);
  }, 120000);
});

