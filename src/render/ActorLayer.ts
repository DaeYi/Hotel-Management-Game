import Phaser from 'phaser';
import type { HotelState, Leg, StaffPlan } from '../simulation/types';
import { getAccessibleDesks, getMannedDeskStaff, getAccessibleBreakRooms, getStaffBases, getFixtureFront } from '../simulation/Layout';
import { getStaffPlan } from '../simulation/StaffManager';
import { positionAt, legsEnd, hash01 } from '../simulation/Movement';
import { guestFigures, type Figure } from './figures';
import { BREAK_ROOM } from '../config/balance';
import { STAFF_PERSONALITIES } from '../config/staff';
import { experienceOf, namedFrontDesk, receptionTrained, cleaningTrained } from '../simulation/StaffProfiles';
import { fatigueOn } from '../simulation/StaffFatigue';
import { GRID_OFFSET_X, GRID_OFFSET_Y, TILE_SIZE } from './GridRenderer';
import { drawClock, drawComplaint, drawQuirk, drawMoodFace, RING_COLORS, SELECTED_COLOR } from './quirks';

// People in the building, drawn exactly where the simulation has them. Nothing
// here moves anyone: guests' trips (arriving, out at a facility, moving rooms),
// people walking out, and the staff's hourly plan are all itineraries the
// simulation made and acts on; each frame this layer just asks where those
// itineraries put everyone at the current game time. So a cleaner is in the
// room while it's being cleaned, a guest is in the gym while they're getting
// its review bonus, and nobody drifts at 5x speed or after a reload.

export const ACTOR_COLORS = {
  housekeeper: 0x1abc9c,
  maintenance: 0xe67e22,
  frontDesk: 0x3498db,
};

/** Across a desk, given which way its front is along x (0: above or below it): where its two clerks, and their lines, sit side by side. */
function acrossDesk(towardX: number): [number, number] {
  return towardX === 0 ? [1, 0] : [0, 1];
}

// Where people sit or stand when several share a tile (fractions of the tile)
const SEATS: Array<[number, number]> = [
  [0.22, 0.27], [0.5, 0.18], [0.78, 0.27], [0.22, 0.73], [0.5, 0.82], [0.78, 0.73],
].slice(0, Math.max(6, BREAK_ROOM.seats)) as Array<[number, number]>;

export class ActorLayer {
  private graphics: Phaser.GameObjects.Graphics;
  private planCache = new WeakMap<HotelState, StaffPlan>();
  private away = new Set<string>();
  private drawn: Array<{ figure: Figure; x: number; y: number; r: number }> = []; // guests drawn last frame, for clicks
  private selectedGuestId: string | null = null;
  private selectedStaffId: string | null = null;
  private staffDrawn: Array<{ id: string; x: number; y: number }> = [];

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics().setDepth(6);
  }

  /** Guests who aren't in their room right now (arriving, out, moving) -- their room dot is hidden. */
  awayGuestIds(): Set<string> {
    return this.away;
  }

  /**
   * The guest (booking) drawn under a point on the floor plan last frame, if
   * any: the nearest figure within a few pixels of its dot. Staff aren't
   * picked, nor people turned away (no booking).
   */
  guestAt(px: number, py: number): string | null {
    let best: { id: string; d: number } | null = null;
    for (const { figure, x, y, r } of this.drawn) {
      const id = figure.guestId ?? figure.opens; // a visitor: their host
      if (!id) continue;
      const d = Math.hypot(px - x, py - y);
      if (d <= r + 3 && (!best || d < best.d)) best = { id, d };
    }
    return best?.id ?? null;
  }

  staffAt(px: number, py: number): string | null {
    let best: { id: string; distance: number } | null = null;
    for (const f of this.staffDrawn) {
      const distance = Math.hypot(px - f.x, py - f.y);
      if (distance <= 9 && (!best || distance < best.distance)) best = { id: f.id, distance };
    }
    return best?.id ?? null;
  }

  /** Draw everyone on the floor being viewed, where they are at game time t (absolute hours); the selected guest stands out. */
  update(state: HotelState, currentFloor: number, t: number, selectedGuestId: string | null = null, selectedStaffId: string | null = null) {
    this.selectedGuestId = selectedGuestId;
    this.selectedStaffId = selectedStaffId;
    this.staffDrawn = [];
    // Guests on a trip (walking in, checking in, at a facility, moving rooms)
    // and people walking out: every member of every party
    const guests = guestFigures(state, t);
    const figures: Figure[] = guests.figures;
    this.away = guests.away;

    // Housekeepers and maintenance: this hour's plan
    const plan = this.staffPlan(state);
    const roster = new Map((state.staffRoster ?? []).map(m => [m.id, m]));
    for (const it of plan.itineraries) {
      const member = roster.get(it.staffId);
      const marks = STAFF_PERSONALITIES.enabled && member ? { staffId: it.staffId, chevrons: experienceOf(member) === 'veteran' ? 2 : experienceOf(member) === 'skilled' ? 1 : 0,
        ...(receptionTrained(member) ? { uniformAccent: ACTOR_COLORS.frontDesk }
          : cleaningTrained(member) ? { uniformAccent: ACTOR_COLORS.housekeeper } : {}) } : {};
      const color = member?.role === 'front_desk' ? ACTOR_COLORS.frontDesk : member?.role === 'housekeeper' || it.staffId.startsWith('housekeeper') ? ACTOR_COLORS.housekeeper : ACTOR_COLORS.maintenance;
      if (it.legs.length === 0) {
        const at = it.end.at ? roster.get(it.staffId)?.at : null; // staying put (null: gone home)
        if (at) figures.push({ id: it.staffId, kind: 'staff', color, x: at.gridX, y: at.gridY, floor: at.floor, settled: true, ...marks });
        continue;
      }
      if (t < it.legs[0].start) continue; // still off site
      if (t >= legsEnd(it.legs) && !it.end.at) continue; // gone home
      const figure = this.place(it.legs, t, it.staffId, 'staff', color);
      const leg = positionAt(it.legs, t)?.leg;
      const resting = fatigueOn() && leg?.kind === 'stay' && leg.activity === 'rest' && leg.restRate !== undefined && leg.start <= t && t < leg.end;
      const counter = leg?.kind === 'stay' && leg.activity === 'desk' && leg.placeId && leg.lane ? { deskId: leg.placeId, seat: Number(leg.lane.slice(leg.lane.lastIndexOf(':') + 1)) } : undefined;
      if (figure) figures.push({ ...figure, ...marks, counter, ...(resting ? { resting: true } : {}) });
    }

    // Front desk staff without a seat at a desk wait in a break room (or the lobby)
    const breakRooms = getAccessibleBreakRooms(state);
    const lobby = getStaffBases(state)[0];
    const spare = namedFrontDesk(state) ? 0 : Math.max(0, state.staff.frontDesk - getMannedDeskStaff(state));
    for (let i = 0; i < spare; i++) {
      const spot = breakRooms.length > 0 ? breakRooms[i % breakRooms.length] : lobby;
      if (spot) figures.push({ id: `frontdesk-spare-${i}`, kind: 'staff', color: ACTOR_COLORS.frontDesk, x: spot.gridX, y: spot.gridY, floor: spot.floor, settled: true });
    }

    this.draw(state, currentFloor, figures);
  }

  /** The plan for the hour being shown (the simulation's own, or computed once for a state without one). */
  private staffPlan(state: HotelState): StaffPlan {
    let plan = this.planCache.get(state);
    if (!plan) {
      plan = getStaffPlan(state);
      this.planCache.set(state, plan);
    }
    return plan;
  }

  /** A figure where its legs put it at time t (null while they're out of the building). */
  private place(legs: Leg[], t: number, id: string, kind: Figure['kind'], color: number): Figure | null {
    const at = positionAt(legs, t);
    if (!at || (at.leg.kind === 'stay' && at.leg.activity === 'away')) return null;
    return { id, kind, color, x: at.x, y: at.y, floor: at.floor, settled: !at.moving, ...(at.leg.kind === 'stay' ? { since: at.leg.start } : {}) };
  }

  private draw(state: HotelState, currentFloor: number, figures: Figure[]) {
    const g = this.graphics;
    g.clear();
    this.drawn = [];

    // Front desk staff behind their counters (two per desk at most), side by side across the desk from
    // the spot in front of it, seat 0 first -- the way their lines are laid out (layOutLines)
    let seated = namedFrontDesk(state) ? 0 : getMannedDeskStaff(state);
    for (const desk of getAccessibleDesks(state)) {
      const front = getFixtureFront(state, desk);
      const fx = front ? Math.sign(front.gridX - desk.gridX) : 0;
      const fy = front && fx === 0 ? Math.sign(front.gridY - desk.gridY) || 1 : 0;
      const [ax, ay] = acrossDesk(fx);
      for (let seat = 0; seat < 2 && seated > 0; seat++, seated--) {
        if (desk.floor !== currentFloor) continue;
        const off = seat === 0 ? -0.17 : 0.17;
        const cx = GRID_OFFSET_X + (desk.gridX + 0.5 + ax * off - fx * 0.2) * TILE_SIZE;
        const cy = GRID_OFFSET_Y + (desk.gridY + 0.5 + ay * off - fy * 0.2) * TILE_SIZE;
        this.drawFigure(cx, cy, { id: 'desk', kind: 'staff', color: ACTOR_COLORS.frontDesk, x: 0, y: 0, floor: currentFloor, settled: true });
      }
    }

    // People settled on a tile share it, each in a seat picked from their id
    // (the next free one if it's taken), so others coming and going don't move
    // them. Walkers get a small fixed offset so two on the same path don't
    // merge into one.
    for (const figure of figures.filter(f => f.floor === currentFloor && f.counter)) {
      const desk = state.fixtures.find(d => d.id === figure.counter!.deskId);
      if (!desk) continue;
      const front = getFixtureFront(state, desk);
      const fx = front ? Math.sign(front.gridX - desk.gridX) : 0;
      const fy = front && fx === 0 ? Math.sign(front.gridY - desk.gridY) || 1 : 0;
      const [ax, ay] = acrossDesk(fx), off = figure.counter!.seat === 0 ? -0.17 : 0.17;
      this.drawFigure(GRID_OFFSET_X + (desk.gridX + 0.5 + ax * off - fx * 0.2) * TILE_SIZE,
        GRID_OFFSET_Y + (desk.gridY + 0.5 + ay * off - fy * 0.2) * TILE_SIZE, figure);
    }
    const onFloor = figures.filter(f => f.floor === currentFloor && !f.counter);
    // The front desk: each clerk's line, laid out (who's being served at the counter, the rest behind)
    const lineSpots = this.layOutLines(onFloor.filter(f => f.settled && f.line));
    const byTile = new Map<string, Figure[]>();
    for (const f of onFloor) {
      if (!f.settled || f.line) continue;
      const key = `${Math.round(f.x)},${Math.round(f.y)}`;
      byTile.set(key, [...(byTile.get(key) ?? []), f]);
    }
    // Where people gather (facilities, break rooms, the spot in front of a
    // desk) they always take seats, so the first one doesn't hop aside when a
    // second arrives; elsewhere someone alone stands in the middle.
    const gatheringTiles = new Set([
      ...state.facilities.filter(f => f.floor === currentFloor).map(f => `${f.gridX},${f.gridY}`),
      ...getAccessibleBreakRooms(state).filter(b => b.floor === currentFloor).map(b => `${b.gridX},${b.gridY}`),
      ...getAccessibleDesks(state).map(d => getFixtureFront(state, d)).filter(p => p && p.floor === currentFloor).map(p => `${p!.gridX},${p!.gridY}`),
    ]);
    for (const [key, group] of byTile) {
      // First come, first seated: whoever's been there longest picks first, so nobody already seated moves
      group.sort((a, b) => (a.since ?? -Infinity) - (b.since ?? -Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (group.length === 1 && !gatheringTiles.has(key)) {
        const f = group[0];
        this.drawFigure(GRID_OFFSET_X + (Math.round(f.x) + 0.5) * TILE_SIZE, GRID_OFFSET_Y + (Math.round(f.y) + 0.5) * TILE_SIZE, f);
        continue;
      }
      const lined = lineSpots.get(key);
      if (lined) {
        // Beside a front desk line (asking, or staff waiting there): the seat farthest from anyone in it, and from each other
        const used = [...lined];
        for (const f of group) {
          let best = 0;
          let far = -1;
          SEATS.forEach(([sx, sy], i) => {
            const d = Math.min(9, ...used.map(([ux, uy]) => Math.hypot(sx - ux, sy - uy)));
            if (d > far + 1e-9) { far = d; best = i; }
          });
          const [sx, sy] = SEATS[best];
          used.push([sx, sy]);
          this.drawFigure(GRID_OFFSET_X + (Math.round(f.x) + sx) * TILE_SIZE, GRID_OFFSET_Y + (Math.round(f.y) + sy) * TILE_SIZE, f);
        }
        continue;
      }
      const taken = new Map<number, number>(); // seat -> people in it
      for (const f of group) {
        // A party sits together: its members in the seats after its first one's
        let seat = f.group !== undefined
          ? (Math.floor(hash01(`${f.group}seat`) * SEATS.length) + (f.member ?? 0)) % SEATS.length
          : Math.floor(hash01(`${f.id}seat`) * SEATS.length);
        for (let tries = 0; tries < SEATS.length && taken.has(seat); tries++) seat = (seat + 1) % SEATS.length;
        const squeeze = (taken.get(seat) ?? 0) * 3; // more people than seats: squeeze in
        taken.set(seat, (taken.get(seat) ?? 0) + 1);
        const [sx, sy] = SEATS[seat];
        this.drawFigure(
          GRID_OFFSET_X + (Math.round(f.x) + sx) * TILE_SIZE + squeeze,
          GRID_OFFSET_Y + (Math.round(f.y) + sy) * TILE_SIZE + squeeze, f);
      }
    }
    for (const f of onFloor) {
      if (f.settled) continue;
      const ox = (hash01(f.id) - 0.5) * TILE_SIZE * 0.3;
      const oy = (hash01(`${f.id}y`) - 0.5) * TILE_SIZE * 0.3;
      this.drawFigure(GRID_OFFSET_X + (f.x + 0.5) * TILE_SIZE + ox, GRID_OFFSET_Y + (f.y + 0.5) * TILE_SIZE + oy, f);
    }
    // Quirk icons last, so a neighbour's dot never covers one; on the left, a clock running
    // out in line, else a complaint on its way, else a mood face
    for (const { figure, x, y } of this.drawn) {
      if (figure.quirk) drawQuirk(g, x + 6, y - 7, figure.quirk);
      if (figure.clock !== undefined) drawClock(g, x - 6, y - 7, figure.clock);
      else if (figure.complaining) drawComplaint(g, x - 6, y - 8);
      else if (figure.mood) drawMoodFace(g, x - 6, y - 7, figure.mood);
    }
  }

  /**
   * The front desk tile: whoever is at the counter stands under their clerk,
   * and the rest queue behind them in that clerk's line in the order they'll
   * be served (someone who'll give up first stays behind everyone who got
   * there before them), a party together, inside its clerk's half; a long
   * line squeezes up to fit the tile. Two desks facing one tile keep to their
   * own parts of it. Where they stand on the tile is drawing only: the
   * simulation has them all on it. Returns where everyone stood on each tile
   * (fractions of it), for seating anyone else there clear of the lines.
   */
  private layOutLines(figures: Figure[]): Map<string, Array<[number, number]>> {
    const spots = new Map<string, Array<[number, number]>>();
    const byTile = new Map<string, Figure[]>();
    for (const f of figures) {
      const key = `${Math.round(f.x)},${Math.round(f.y)}`;
      byTile.set(key, [...(byTile.get(key) ?? []), f]);
    }
    for (const [key, group] of byTile) {
      const [tx, ty] = key.split(',').map(Number);
      const here: Array<[number, number]> = [];
      spots.set(key, here);
      // Each clerk's line: parties, the one at the counter first, then in the order they'll get there
      type Party = { figs: Figure[]; serving: boolean; turn: number; leaves: boolean; since: number; id: string };
      const lines = new Map<string, Party[]>();
      const parties = new Map<string, Figure[]>();
      for (const f of group) parties.set(f.group ?? f.id, [...(parties.get(f.group ?? f.id) ?? []), f]);
      for (const [id, figs] of parties) {
        const lead = figs[0].line!;
        const list = lines.get(lead.lane) ?? [];
        list.push({ figs: figs.sort((a, b) => (a.member ?? 0) - (b.member ?? 0)), serving: lead.serving, turn: lead.turn, leaves: !!lead.leaves, since: Math.min(...figs.map(f => f.since ?? 0)), id });
        lines.set(lead.lane, list);
      }
      // Toward each desk facing this tile
      const toward = new Map<string, [number, number]>();
      for (const f of group) {
        const { deskX, deskY } = f.line!;
        const dx = Math.sign(deskX - tx);
        toward.set(`${deskX},${deskY}`, [dx, dx === 0 ? Math.sign(deskY - ty) || -1 : 0]);
      }
      const shared = toward.size > 1;
      const span = shared ? 0.26 : 0.72; // from the counter to the back of the tile (or of its part)
      for (const list of lines.values()) {
        const { seat, deskX, deskY } = list[0].figs[0].line!;
        // Toward the desk, and across it (the way its clerks sit)
        const [dx, dy] = toward.get(`${deskX},${deskY}`)!;
        const [ax, ay] = acrossDesk(dx);
        // Another desk off to one side of this one's line (the two at right angles): this line keeps to the other side
        let side = 0;
        for (const [k, [ox, oy]] of toward) if (k !== `${deskX},${deskY}`) side -= ox * ax + oy * ay;
        side = Math.max(-1, Math.min(1, side));
        // Someone who'll give up before their turn stays behind everyone who got there first
        let latest = -Infinity;
        for (const party of [...list].sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1))) {
          if (party.leaves) party.turn = Math.max(party.turn, latest);
          latest = Math.max(latest, party.turn);
        }
        list.sort((a, b) => Number(b.serving) - Number(a.serving) || a.turn - b.turn || a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const half = side === 0 ? 0.2 : 0.1; // each clerk's half of the line's width
        const across = side * 0.2 + (seat % 2 === 0 ? -half : half);
        const step = Math.min(0.24, span / Math.max(1, list.length - 1));
        list.forEach((party, k) => {
          const depth = 0.3 - step * k; // nearest the counter first
          const apart = Math.min(0.13, (half * 1.5) / Math.max(1, party.figs.length - 1)); // a party side by side, inside its clerk's half
          party.figs.forEach((f, m) => {
            const spread = (m - (party.figs.length - 1) / 2) * apart;
            const ox = 0.5 + dx * depth + ax * (across + spread);
            const oy = 0.5 + dy * depth + ay * (across + spread);
            here.push([ox, oy]);
            this.drawFigure(GRID_OFFSET_X + (tx + ox) * TILE_SIZE, GRID_OFFSET_Y + (ty + oy) * TILE_SIZE, f);
          });
        });
      }
    }
    return spots;
  }

  /** Guests are dots (children smaller) and staff are squares, both outlined in white; the selected guest's party is circled in gold. */
  private drawFigure(cx: number, cy: number, f: Figure) {
    const g = this.graphics;
    g.fillStyle(f.color, 1);
    g.lineStyle(1.5, 0xffffff, 0.9);
    if (f.kind === 'guest') {
      const r = f.small ? 3.5 : 5;
      g.fillCircle(cx, cy, r);
      g.strokeCircle(cx, cy, r);
      if (f.ring) {
        g.lineStyle(1.5, RING_COLORS[f.ringTier ?? 'returning'], 0.95);
        g.strokeCircle(cx, cy, 8);
      }
      if (f.guestId && f.guestId === this.selectedGuestId) {
        g.lineStyle(2, SELECTED_COLOR, 1);
        g.strokeCircle(cx, cy, r + 5);
      }
      this.drawn.push({ figure: f, x: cx, y: cy, r });
    } else {
      g.fillRect(cx - 5, cy - 5, 10, 10);
      if (f.uniformAccent !== undefined) {
        g.fillStyle(f.uniformAccent, 1);
        g.fillRect(cx, cy - 5, 5, 10);
      }
      g.strokeRect(cx - 5, cy - 5, 10, 10);
      if (f.staffId) {
        this.staffDrawn.push({ id: f.staffId, x: cx, y: cy });
        for (let i = 0; i < (f.chevrons ?? 0); i++) {
          const y = cy - 8 - i * 4;
          g.lineStyle(1, 0xffffff, 0.9);
          g.beginPath(); g.moveTo(cx - 3, y + 2); g.lineTo(cx, y); g.lineTo(cx + 3, y + 2); g.strokePath();
        }
        if (f.resting) {
          // A small z beside the experience marks: only real recovery, never idle waiting.
          g.lineStyle(1.5, 0xb7d5f9, 1);
          g.beginPath(); g.moveTo(cx + 6, cy - 11); g.lineTo(cx + 11, cy - 11); g.lineTo(cx + 6, cy - 6); g.lineTo(cx + 11, cy - 6); g.strokePath();
        }
        if (f.staffId === this.selectedStaffId) { g.lineStyle(2, SELECTED_COLOR, 1); g.strokeRect(cx - 8, cy - 8, 16, 16); }
      }
    }
  }
}
