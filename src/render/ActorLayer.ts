import Phaser from 'phaser';
import type { HotelState, GameEvent, Room, GuestTrait, Fixture } from '../simulation/types';
import { findPath, getFrontDoor, getAccessibleDesks, getMannedDeskStaff, getStaffBases, getAccessibleBreakRooms } from '../simulation/Layout';
import { planHousekeeping, currentJob } from '../simulation/HousekeepingManager';
import { planMaintenance } from '../simulation/MaintenanceManager';
import { TRAVEL, BREAK_ROOM } from '../config/balance';
import { TICK_INTERVAL_MS } from '../game/GameController';
import type { Pos } from '../simulation/Layout';
import { GRID_OFFSET_X, GRID_OFFSET_Y, TILE_SIZE, getGuestDotColor } from './GridRenderer';

// People walking around the building. Purely visual: the simulation still
// runs hour by hour, and these actors act out what it decided -- guests
// walking in to check in and up to their rooms, housekeepers and maintenance
// heading to the rooms they're working on, front desk staff at the desks,
// and anyone without work waiting in a staff break room.

// Guests stroll at a readable pace (their walk is decoration only).
const GUEST_TILES_PER_SEC = 3; // at 1x speed
const GUEST_ELEVATOR_RIDE_MS = 350; // per floor, at 1x speed
const CHECK_IN_MS = 700; // pause at the desk, at 1x speed

// Staff walk at exactly the pace the simulation charges for (TRAVEL), so a
// housekeeper reaches a room when the simulated walk there ends.
const STAFF_TILES_PER_SEC = 1 / TRAVEL.hoursPerTile / (TICK_INTERVAL_MS / 1000); // at 1x speed
const STAFF_ELEVATOR_RIDE_MS = TRAVEL.hoursPerFloor * TICK_INTERVAL_MS; // per floor, at 1x speed
// Where resting staff sit in a break room tile (fractions of the tile), around the table
const BREAK_ROOM_SEATS: Array<[number, number]> = [
  [0.22, 0.27], [0.5, 0.18], [0.78, 0.27], [0.22, 0.73], [0.5, 0.82], [0.78, 0.73],
].slice(0, BREAK_ROOM.seats) as Array<[number, number]>;
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
  // Staff: the room they're heading to or working in, or where they wait when idle
  targetId?: string | null;
  pathed?: boolean; // a path to the current target has been computed
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
    const entrance = getFrontDoor(state);
    const desks = getAccessibleDesks(state);
    if (!entrance || desks.length === 0) return;

    const desk = desks[this.nextDesk++ % desks.length];
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
    const entrance = getFrontDoor(state);
    if (!entrance) return;
    const path = findPath(state, room, entrance);
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

  /**
   * Advance everyone and draw the ones on the floor being viewed. `speed` is
   * the game speed (0 when paused); `hourProgress` (0-1) is how far through
   * the current game hour the clock is, which sets where each housekeeper is
   * in their hour's job list.
   */
  update(state: HotelState, currentFloor: number, deltaMs: number, speed: number, hourProgress: number) {
    const dt = deltaMs * speed;
    this.syncStaff(state, hourProgress);

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

    const staff = actor.kind !== 'guest';
    let budget = (dt / 1000) * (staff ? STAFF_TILES_PER_SEC : GUEST_TILES_PER_SEC);
    while (budget > 0 && actor.path.length > 0) {
      const next = actor.path[0];
      if (next.floor !== actor.floor) {
        // Elevator ride: wait, then step out on the new floor
        actor.floor = next.floor;
        actor.x = next.gridX;
        actor.y = next.gridY;
        actor.path.shift();
        actor.waitMs = staff ? STAFF_ELEVATOR_RIDE_MS : GUEST_ELEVATOR_RIDE_MS;
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
   * Keep one actor per housekeeper and maintenance worker, each following the
   * same work plan the simulation applies (planHousekeeping / planMaintenance):
   * housekeeper i works through their own job list over the hour, moving on
   * when a job's share of the hour is up. Idle staff wait in a break room
   * (on their own floor if there is one), or else at a staff base.
   */
  private syncStaff(state: HotelState, hourProgress: number) {
    const counts: Record<StaffRole, number> = {
      housekeeper: state.staff.housekeepers,
      maintenance: state.staff.maintenanceWorkers,
    };
    const bases = getStaffBases(state);
    const breakRooms = getAccessibleBreakRooms(state);
    const housekeeping = planHousekeeping(state);
    const maintenance = planMaintenance(state);

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

      members.forEach((member, i) => {
        const roomId = role === 'housekeeper'
          ? currentJob(housekeeping[i] ?? [], hourProgress)?.roomId ?? null
          : maintenance[i] ?? null;
        const room = roomId ? state.rooms.find(r => r.id === roomId) ?? null : null;
        const home: Pos | null = breakRooms.find(b => b.floor === member.floor)
          ?? bases.find(b => b.floor === member.floor) ?? breakRooms[0] ?? bases[0] ?? null;
        this.sendTo(member, state, room, home);
      });
    }
  }

  /** Point an actor at a room (or home when null); only re-paths when the target changes. */
  private sendTo(actor: Actor, state: HotelState, room: Room | null, home: Pos | null) {
    const targetId = room?.id ?? (home ? `home:${home.gridX},${home.gridY},${home.floor}` : null);
    if (actor.targetId === targetId && actor.pathed) return;
    actor.targetId = targetId;
    actor.pathed = true;
    const goal: Pos | null = room ?? home;
    if (!goal) return;
    const path = findPath(state, tileOf(actor), goal);
    actor.path = path ? path.slice(1) : [];
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

    // Staff resting in break rooms sit around the table; front desk staff
    // without a seat at a desk wait there too
    const breakRooms = getAccessibleBreakRooms(state);
    const seatsTaken = new Map<Fixture, number>();
    const sitDown = (breakRoom: Fixture, color: number) => {
      const n = seatsTaken.get(breakRoom) ?? 0;
      seatsTaken.set(breakRoom, n + 1);
      if (breakRoom.floor !== currentFloor) return;
      const [sx, sy] = BREAK_ROOM_SEATS[n % BREAK_ROOM_SEATS.length];
      const overflow = Math.floor(n / BREAK_ROOM_SEATS.length) * 3; // past the seats, staff squeeze in
      this.drawStaff(
        GRID_OFFSET_X + (breakRoom.gridX + sx) * TILE_SIZE + overflow,
        GRID_OFFSET_Y + (breakRoom.gridY + sy) * TILE_SIZE + overflow, color);
    };
    const resting = new Set<Actor>();
    for (const member of this.staff) {
      if (member.path.length > 0 || member.waitMs > 0) continue;
      const breakRoom = breakRooms.find(b => b.floor === member.floor
        && b.gridX === Math.round(member.x) && b.gridY === Math.round(member.y));
      if (!breakRoom) continue;
      resting.add(member);
      sitDown(breakRoom, member.color);
    }
    const spareFrontDesk = breakRooms.length > 0 ? state.staff.frontDesk - getMannedDeskStaff(state) : 0;
    for (let i = 0; i < spareFrontDesk; i++) sitDown(breakRooms[i % breakRooms.length], ACTOR_COLORS.frontDesk);

    // Walkers and working staff, nudged apart when they share a tile
    const all = [...this.staff, ...this.guests].filter(a => a.floor === currentFloor && !resting.has(a));
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
