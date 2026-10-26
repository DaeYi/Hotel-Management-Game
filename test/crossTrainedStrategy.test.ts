import { describe, expect, it } from 'vitest';
import { simulate } from '../src/simulation/simulate.js';
import { STRATEGIES } from '../src/simulation/strategies.js';
import { addRoom, createStarterHotel } from '../src/simulation/HotelState.js';
import { settleChanges } from '../src/simulation/Settle.js';
import { tickSimulation } from '../src/simulation/tick.js';
import { getStaffPlan } from '../src/simulation/StaffManager.js';
import { deskCoverage } from '../src/simulation/FrontDesk.js';
import { candidatesFor, cleaningTrained } from '../src/simulation/StaffProfiles.js';
import { hourStart } from '../src/simulation/Movement.js';
import { PRNG } from '../src/simulation/prng.js';
import type { FrontDeskShift, HotelState, SimulationSummary, StaffMember } from '../src/simulation/types.js';

const crossTrained = STRATEGIES.crossTrained;
const earlyDesk = (state: HotelState) => (state.staffRoster ?? []).filter(m => m.role === 'front_desk' && !m.leaving && m.shift === 'early');

/** Eight rooms at 08:00, when the bots act, with reception staffed by hand. */
function deskHotel(day: number, early: boolean[]): HotelState {
  let state = createStarterHotel();
  for (let x = 0; x < 8; x++) state = addRoom(state, 'standard', x, 2) ?? state;
  const clerk = (serial: number, shift: FrontDeskShift, trained = false): StaffMember => ({
    id: `front_desk-${serial}`, serial, name: `Clerk ${serial}`, role: 'front_desk', shift, at: null, hiredDay: 1, hiredAt: 0,
    dailyWage: trained ? 44.28 : 38.5, stats: { workHours: 80, lateDays: 0, absentDays: 0 },
    profile: { experience: 'skilled', style: 'standard', reliability: 'dependable', stamina: 'normal', hospitality: 'polite', ...(trained ? { cleaningTrained: true } : {}) },
  });
  const roster = [...early.map((trained, i) => clerk(i + 1, 'early', trained)), clerk(early.length + 1, 'late'), clerk(early.length + 2, 'night')];
  return { ...state, day, hour: 8, frontDeskRosterReady: true, staffRoster: roster, nextStaffSerial: roster.length + 1,
    staff: { ...state.staff, frontDesk: roster.length } };
}
const play = (state: HotelState) => settleChanges(state, crossTrained(state), hourStart(state));
const offersTrained = (day: number) => candidatesFor(day, 'front_desk', [], 'early').some(c => c.profile.cleaningTrained);

describe('The cross-trained player staffs reception', () => {
  it('holds one extra early place for a turnover-trained clerk and hires one when offered', () => {
    const offered = Array.from({ length: 60 }, (_, i) => i + 2).find(offersTrained)!;
    const quiet = Array.from({ length: 60 }, (_, i) => i + 2).find(day => !offersTrained(day))!;
    const hired = play(deskHotel(offered, [false]));
    expect(earlyDesk(hired)).toHaveLength(2);
    expect(earlyDesk(hired).filter(m => cleaningTrained(m))).toHaveLength(1);
    // Without a trained offer the extra place stays open, but reception's own place never waits
    expect(earlyDesk(play(deskHotel(quiet, [false])))).toHaveLength(1);
    const covered = play(deskHotel(quiet, []));
    expect(earlyDesk(covered)).toHaveLength(1);
    expect(cleaningTrained(earlyDesk(covered)[0])).toBe(false);
  });

  it('lets untrained clerks go first when the early shift is over-staffed', () => {
    // Trained clerks earn more, so the best-value shortcut would let them go first
    const trimmed = play(deskHotel(10, [true, false, true, false]));
    expect(earlyDesk(trimmed).map(m => m.id).sort()).toEqual(['front_desk-1', 'front_desk-3']);
    expect(earlyDesk(trimmed).every(m => cleaningTrained(m))).toBe(true);
  });
});

// Four seeds of long games: enough for the medians, about a minute locally.
const SEEDS = [0, 1, 2, 3];
const DAYS = 300;
interface Run { summary: SimulationSummary; trained: number; cleanHours: number }
const runs = new Map<string, Run[]>();
/** Each player's games, counting trained clerks hired and their real room work in each hour's plan. */
function games(name: 'crossTrained' | 'understaffed'): Run[] {
  if (!runs.has(name)) runs.set(name, SEEDS.map(seed => {
    const trained = new Set<string>();
    let cleanHours = 0;
    const summary = simulate(DAYS, seed, undefined, state => {
      const T = hourStart(state);
      for (const m of state.staffRoster ?? []) if (cleaningTrained(m)) trained.add(m.id);
      if (state.staffPlan?.start === T) for (const it of state.staffPlan.itineraries) {
        if (!trained.has(it.staffId)) continue;
        for (const leg of it.legs) if (leg.kind === 'stay' && leg.activity === 'clean') cleanHours += Math.max(0, Math.min(T + 1, leg.end) - Math.max(T, leg.start));
      }
      return STRATEGIES[name](state);
    });
    return { summary, trained: trained.size, cleanHours };
  }));
  return runs.get(name)!;
}
const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

describe('Turnover-trained clerks in long games', () => {
  it('hires trained clerks who do real room work, and never goes bankrupt', () => {
    for (const [i, run] of games('crossTrained').entries()) {
      expect(run.summary.wentBankrupt, `seed ${SEEDS[i]}`).toBe(false);
      expect(run.trained, `seed ${SEEDS[i]}`).toBeGreaterThanOrEqual(1);
      expect(run.cleanHours, `seed ${SEEDS[i]}`).toBeGreaterThan(100);
    }
  }, 120000); // Four 300-day games of a growing hotel exceeded the default five seconds.

  it('is worth at least half as much again as the understaffed player it builds on', () => {
    const lean = median(games('understaffed').map(r => r.summary.finalValuation));
    expect(games('understaffed').every(r => r.trained === 0)).toBe(true);
    expect(median(games('crossTrained').map(r => r.summary.finalValuation))).toBeGreaterThanOrEqual(1.5 * lean);
  }, 120000); // Four more 300-day games (and the cross-trained ones if run alone) exceeded the default five seconds.
});

describe('Reception coverage during real cross-trained play', () => {
  it('advertises exactly the clerks physically at a desk, never a trained clerk who is away', () => {
    for (const seed of [9, 5]) {
      let state = createStarterHotel();
      for (let x = 0; x < 8; x++) state = addRoom(state, 'standard', x, 2) ?? state;
      const prng = new PRNG(seed);
      let away = 0, cleans = 0;
      for (let h = 0; h < 90 * 24; h++) {
        state = settleChanges(state, crossTrained(state), hourStart(state));
        const T = hourStart(state), now = { ...state, staffPlan: getStaffPlan(state) };
        const trained = (now.staffRoster ?? []).filter(m => cleaningTrained(m)).map(m => m.id);
        for (const it of now.staffPlan.itineraries) if (trained.includes(it.staffId)) cleans += it.legs.filter(leg => leg.kind === 'stay' && leg.activity === 'clean').length;
        for (let t = T + 0.001; t < T + 1; t += 0.025) {
          const physical = now.staffPlan.itineraries.filter(it => it.legs.some(leg =>
            leg.kind === 'stay' && leg.activity === 'desk' && leg.start <= t && leg.end > t)).map(it => it.staffId).sort();
          const promised = [...new Set(deskCoverage(now, t).map(duty => duty.staffId))].sort();
          const at = `seed ${seed}, day ${now.day} ${now.hour}:${String(Math.floor((t - T) * 60)).padStart(2, '0')}`;
          expect(promised, `coverage on ${at}`).toEqual(physical);
          for (const id of trained) {
            const legs = now.staffPlan.itineraries.find(it => it.staffId === id)?.legs ?? [];
            if (!legs.some(leg => leg.start <= t && leg.end > t && (leg.kind === 'walk' || leg.activity === 'clean'))) continue;
            away++;
            expect(promised, `${id} advertised while away on ${at}`).not.toContain(id);
          }
        }
        state = tickSimulation(state, prng).state;
      }
      // Trips actually happened: trained clerks cleaned and were away for many sampled moments
      expect(cleans, `seed ${seed}`).toBeGreaterThan(100);
      expect(away, `seed ${seed}`).toBeGreaterThan(2000);
    }
  }, 60000); // Two 90-day games sampled forty times an hour exceeded the default five seconds.
});
