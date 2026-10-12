import Phaser from 'phaser';
import type { HotelState, Leg, StaffPlan } from '../simulation/types';
import { getAccessibleDesks, getMannedDeskStaff, getAccessibleBreakRooms, getStaffBases, getFixtureFront } from '../simulation/Layout';
import { getStaffPlan } from '../simulation/StaffManager';
import { positionAt, legsEnd, hash01 } from '../simulation/Movement';
import { guestFigures, type Figure } from './figures';
import { BREAK_ROOM } from '../config/balance';
import { GRID_OFFSET_X, GRID_OFFSET_Y, TILE_SIZE } from './GridRenderer';
import { drawQuirk, drawMoodFace, RING_COLORS, SELECTED_COLOR } from './quirks';

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
      if (!figure.guestId) continue;
      const d = Math.hypot(px - x, py - y);
      if (d <= r + 3 && (!best || d < best.d)) best = { id: figure.guestId, d };
    }
    return best?.id ?? null;
  }

  /** Draw everyone on the floor being viewed, where they are at game time t (absolute hours); the selected guest stands out. */
  update(state: HotelState, currentFloor: number, t: number, selectedGuestId: string | null = null) {
    this.selectedGuestId = selectedGuestId;
    // Guests on a trip (walking in, checking in, at a facility, moving rooms)
    // and people walking out: every member of every party
    const guests = guestFigures(state, t);
    const figures: Figure[] = guests.figures;
    this.away = guests.away;

    // Housekeepers and maintenance: this hour's plan
    const plan = this.staffPlan(state);
    const roster = new Map((state.staffRoster ?? []).map(m => [m.id, m]));
    for (const it of plan.itineraries) {
      const color = it.staffId.startsWith('housekeeper') ? ACTOR_COLORS.housekeeper : ACTOR_COLORS.maintenance;
      if (it.legs.length === 0) {
        const at = it.end.at ? roster.get(it.staffId)?.at : null; // staying put (null: gone home)
        if (at) figures.push({ id: it.staffId, kind: 'staff', color, x: at.gridX, y: at.gridY, floor: at.floor, settled: true });
        continue;
      }
      if (t < it.legs[0].start) continue; // still off site
      if (t >= legsEnd(it.legs) && !it.end.at) continue; // gone home
      const figure = this.place(it.legs, t, it.staffId, 'staff', color);
      if (figure) figures.push(figure);
    }

    // Front desk staff without a seat at a desk wait in a break room (or the lobby)
    const breakRooms = getAccessibleBreakRooms(state);
    const lobby = getStaffBases(state)[0];
    const spare = Math.max(0, state.staff.frontDesk - getMannedDeskStaff(state));
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

    // Front desk staff behind their counters (two per desk at most)
    let seated = getMannedDeskStaff(state);
    for (const desk of getAccessibleDesks(state)) {
      for (let seat = 0; seat < 2 && seated > 0; seat++, seated--) {
        if (desk.floor !== currentFloor) continue;
        const cx = GRID_OFFSET_X + desk.gridX * TILE_SIZE + TILE_SIZE * (seat === 0 ? 0.33 : 0.67);
        const cy = GRID_OFFSET_Y + desk.gridY * TILE_SIZE + TILE_SIZE * 0.3;
        this.drawFigure(cx, cy, { id: 'desk', kind: 'staff', color: ACTOR_COLORS.frontDesk, x: 0, y: 0, floor: currentFloor, settled: true });
      }
    }

    // People settled on a tile share it, each in a seat picked from their id
    // (the next free one if it's taken), so others coming and going don't move
    // them. Walkers get a small fixed offset so two on the same path don't
    // merge into one.
    const onFloor = figures.filter(f => f.floor === currentFloor);
    const byTile = new Map<string, Figure[]>();
    for (const f of onFloor) {
      if (!f.settled) continue;
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
    // Quirk icons last, so a neighbour's dot never covers one
    for (const { figure, x, y } of this.drawn) {
      if (figure.quirk) drawQuirk(g, x + 6, y - 7, figure.quirk);
      if (figure.mood) drawMoodFace(g, x - 6, y - 7, figure.mood);
    }
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
      g.strokeRect(cx - 5, cy - 5, 10, 10);
    }
  }
}
