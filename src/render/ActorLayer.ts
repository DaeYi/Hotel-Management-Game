import Phaser from 'phaser';
import type { HotelState, GameEvent, Room, GuestTrait } from '../simulation/types';
import { STAFF } from '../config/balance';
import { findPath, getEntranceTiles, getAccessibleDesks, getMannedDeskStaff, getStaffBases } from '../simulation/Layout';
import type { Pos } from '../simulation/Layout';
import { GRID_OFFSET_X, GRID_OFFSET_Y, TILE_SIZE, getGuestDotColor } from './GridRenderer';

// People walking around the building. Purely visual: the simulation still
// runs hour by hour, and these actors act out what it decided -- guests
// walking in to check in and up to their rooms, housekeepers and maintenance
// heading to the rooms they're working on, front desk staff at the desks.

const WALK_TILES_PER_SEC = 3; // at 1x speed
const CHECK_IN_MS = 700; // pause at the desk, at 1x speed
const ELEVATOR_RIDE_MS = 350; // per floor, at 1x speed
const MAX_GUEST_ACTORS = 40; // beyond this, arrivals skip the walk to keep the grid readable

export const ACTOR_COLORS = {
  housekeeper: 0x1abc9c,
  maintenance: 0xe67e22,
  frontDesk: 0x3498db,
};

type StaffRole = 'housekeeper' | 'maintenance';

interface Actor {
  id: string;
  kind: 'guest' | StaffRole;
  color: number;
  x: number; // continuous tile coordinates
  y: number;
  floor: number;
  path: Pos[]; // waypoints still to visit
  waitMs: number; // standing still (checking in, riding the elevator)
  // Guests: what to do when the current walk ends
  then?: 'check_in' | 'despawn';
  guestId?: string;
  roomId?: string;
  // Staff: the room they're heading to or working in (null = idle)
  targetId?: string | null;
}

const tileOf = (a: Actor): Pos => ({ gridX: Math.round(a.x), gridY: Math.round(a.y), floor: a.floor });

export class ActorLayer {
  private graphics: Phaser.GameObjects.Graphics;
  private guests: Actor[] = [];
  private staff: Actor[] = [];
  private nextDesk = 0;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics().setDepth(6);
  }

  /** Guests currently walking -- their room dot is hidden until they get there. */
  walkingGuestIds(): Set<string> {
    return new Set(this.guests.filter(g => g.then !== 'despawn' && g.guestId).map(g => g.guestId!));
  }

  /** Spawn walkers for this tick's arrivals and departures. Call with the state after the tick. */
  handleEvents(events: GameEvent[], state: HotelState) {
    for (const event of events) {
      const roomId = event.data?.roomId as string | undefined;
      const room = roomId ? state.rooms.find(r => r.id === roomId) : undefined;
      if (!room || this.guests.length >= MAX_GUEST_ACTORS) continue;

      if (event.type === 'guest_arrived') {
        this.spawnArrival(state, room, event.data?.guestId as string, event.data?.trait as GuestTrait | undefined);
      } else if (event.type === 'guest_departed' || event.type === 'guest_walked_out') {
        this.spawnDeparture(state, room);
      }
    }
  }

  private spawnArrival(state: HotelState, room: Room, guestId: string, trait: GuestTrait | undefined) {
    const entrances = getEntranceTiles(state);
    const desks = getAccessibleDesks(state);
    if (entrances.length === 0 || desks.length === 0) return;

    const desk = desks[this.nextDesk++ % desks.length];
    const entrance = entrances[guestId.length % entrances.length];
    const toDesk = findPath(state, entrance, desk);
    if (!toDesk) return;
    toDesk.pop(); // stop at the counter, not on it

    this.guests.push({
      id: `arrive-${guestId}`,
      kind: 'guest',
      color: getGuestDotColor(trait ?? 'normal'),
      x: entrance.gridX, y: entrance.gridY, floor: 0,
      path: toDesk.slice(1),
      waitMs: 0,
      then: 'check_in',
      guestId,
      roomId: room.id,
    });
  }

  private spawnDeparture(state: HotelState, room: Room) {
    const entrances = getEntranceTiles(state);
    if (entrances.length === 0) return;
    const path = findPath(state, room, entrances[0]);
    if (!path) return;
    this.guests.push({
      id: `leave-${room.id}-${Math.random()}`,
      kind: 'guest',
      color: 0xbdc3c7,
      x: room.gridX, y: room.gridY, floor: room.floor,
      path: path.slice(1),
      waitMs: 0,
      then: 'despawn',
    });
  }

  /** Advance everyone and draw the ones on the floor being viewed. `speed` is the game speed (0 when paused). */
  update(state: HotelState, currentFloor: number, deltaMs: number, speed: number) {
    const dt = deltaMs * speed;
    this.syncStaff(state);

    for (const guest of this.guests) this.step(guest, dt, state);
    this.guests = this.guests.filter(g => !(g.path.length === 0 && g.waitMs <= 0 && g.then === 'despawn'));
    for (const member of this.staff) this.step(member, dt, state);

    this.draw(state, currentFloor);
  }

  /** Move an actor along its path; handle arrival at the desk and the end of a guest's walk. */
  private step(actor: Actor, dt: number, state: HotelState) {
    if (actor.waitMs > 0) {
      actor.waitMs -= dt;
      return;
    }

    let budget = (dt / 1000) * WALK_TILES_PER_SEC;
    while (budget > 0 && actor.path.length > 0) {
      const next = actor.path[0];
      if (next.floor !== actor.floor) {
        // Elevator ride: wait, then step out on the new floor
        actor.floor = next.floor;
        actor.x = next.gridX;
        actor.y = next.gridY;
        actor.path.shift();
        actor.waitMs = ELEVATOR_RIDE_MS;
        return;
      }
      const dx = next.gridX - actor.x;
      const dy = next.gridY - actor.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        actor.x = next.gridX;
        actor.y = next.gridY;
        actor.path.shift();
        budget -= dist;
      } else {
        actor.x += (dx / dist) * budget;
        actor.y += (dy / dist) * budget;
        budget = 0;
      }
    }

    if (actor.path.length === 0 && actor.then === 'check_in') {
      // At the counter: check in, then head for the room
      const room = state.rooms.find(r => r.id === actor.roomId);
      const toRoom = room ? findPath(state, tileOf(actor), room) : null;
      actor.waitMs = CHECK_IN_MS;
      actor.path = toRoom ? toRoom.slice(1) : [];
      actor.then = 'despawn'; // vanishes into the room on arrival
    }
  }

  /**
   * Keep one actor per housekeeper and maintenance worker, and point each at
   * a room that needs them right now (or back to the lobby when idle).
   */
  private syncStaff(state: HotelState) {
    const counts: Record<StaffRole, number> = {
      housekeeper: state.staff.housekeepers,
      maintenance: state.staff.maintenanceWorkers,
    };
    const bases = getStaffBases(state);

    for (const role of ['housekeeper', 'maintenance'] as StaffRole[]) {
      const members = this.staff.filter(s => s.kind === role);
      while (members.length < counts[role] && bases.length > 0) {
        const home = bases[0];
        const actor: Actor = {
          id: `${role}-${members.length}`, kind: role,
          color: role === 'housekeeper' ? ACTOR_COLORS.housekeeper : ACTOR_COLORS.maintenance,
          x: home.gridX, y: home.gridY, floor: home.floor, path: [], waitMs: 0, targetId: null,
        };
        members.push(actor);
        this.staff.push(actor);
      }
      for (const extra of members.splice(counts[role])) this.staff = this.staff.filter(s => s !== extra);

      const targets = role === 'housekeeper' ? this.housekeepingTargets(state) : this.maintenanceTargets(state);
      const claimed = new Set(members.map(m => m.targetId).filter(id => id && targets.some(t => t.id === id)));
      for (const member of members) {
        const stillValid = member.targetId && targets.some(t => t.id === member.targetId);
        if (stillValid) continue;
        const next = targets.find(t => !claimed.has(t.id));
        if (next) claimed.add(next.id);
        // Idle staff head for a base on their own floor if there is one
        const home = bases.find(b => b.floor === member.floor) ?? bases[0] ?? null;
        this.sendTo(member, state, next ?? null, home);
      }
    }
  }

  private sendTo(actor: Actor, state: HotelState, room: Room | null, home: Pos | null) {
    const goal: Pos | null = room ?? home;
    if ((actor.targetId ?? null) === (room?.id ?? null) && actor.path.length > 0) return;
    actor.targetId = room?.id ?? null;
    if (!goal) return;
    const path = findPath(state, tileOf(actor), goal);
    actor.path = path ? path.slice(1) : [];
  }

  /** Rooms being turned over, plus occupied rooms getting their daily clean this morning. */
  private housekeepingTargets(state: HotelState): Room[] {
    const turnover = state.rooms.filter(r => r.status === 'cleaning');
    const daily = state.rooms.filter(r => r.status === 'occupied' && r.dailyCleanHoursRemaining > 0);
    return [...turnover, ...daily];
  }

  /** Vacant rooms the maintenance crew is fixing during its shift. */
  private maintenanceTargets(state: HotelState): Room[] {
    if (state.hour < STAFF.maintenance.workStartHour || state.hour >= STAFF.maintenance.workEndHour) return [];
    return state.rooms
      .filter(r => r.status === 'vacant' && r.condition < STAFF.maintenance.conditionThreshold)
      .sort((a, b) => a.condition - b.condition);
  }

  private draw(state: HotelState, currentFloor: number) {
    const g = this.graphics;
    g.clear();

    // Front desk staff behind their counters (two per desk at most)
    let seated = getMannedDeskStaff(state);
    for (const desk of getAccessibleDesks(state)) {
      if (desk.floor !== currentFloor) continue;
      for (let seat = 0; seat < 2 && seated > 0; seat++, seated--) {
        const cx = GRID_OFFSET_X + desk.gridX * TILE_SIZE + TILE_SIZE * (seat === 0 ? 0.33 : 0.67);
        const cy = GRID_OFFSET_Y + desk.gridY * TILE_SIZE + TILE_SIZE * 0.3;
        this.drawStaff(cx, cy, ACTOR_COLORS.frontDesk);
      }
    }

    // Walkers and working staff, nudged apart when they share a tile
    const all = [...this.staff, ...this.guests].filter(a => a.floor === currentFloor);
    all.forEach((actor, i) => {
      const jitter = ((i % 3) - 1) * TILE_SIZE * 0.15;
      const cx = GRID_OFFSET_X + (actor.x + 0.5) * TILE_SIZE + jitter;
      const cy = GRID_OFFSET_Y + (actor.y + 0.5) * TILE_SIZE + ((Math.floor(i / 3) % 3) - 1) * TILE_SIZE * 0.15;
      if (actor.kind === 'guest') {
        g.fillStyle(actor.color, 1);
        g.fillCircle(cx, cy, 5);
        g.lineStyle(1.5, 0xffffff, 0.9);
        g.strokeCircle(cx, cy, 5);
      } else {
        this.drawStaff(cx, cy, actor.color);
      }
    });
  }

  /** Staff are small squares with a white outline, so they read differently from guest dots. */
  private drawStaff(cx: number, cy: number, color: number) {
    const g = this.graphics;
    g.fillStyle(color, 1);
    g.fillRect(cx - 5, cy - 5, 10, 10);
    g.lineStyle(1.5, 0xffffff, 0.9);
    g.strokeRect(cx - 5, cy - 5, 10, 10);
  }
}
