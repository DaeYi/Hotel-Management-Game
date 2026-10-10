import Phaser from 'phaser';
import type { HotelState } from '../simulation/types';
import { FLOORS, ELEVATOR } from '../config/balance';
import { getNextFloorCost, getElevatorLoad } from '../simulation/HotelState';

// The building's floors as a stack, ground floor at the bottom like the real
// thing: click a floor to view it, or build the next one up. Design tokens
// match the other panels (fill #1a1a3e, border #4a4a6a, monospace).
const WIDTH = 200;
const ROW_H = 30;
const HEADER_H = 26;
const FOOTER_H = 40;

export class FloorSelector {
  private rows: Phaser.GameObjects.Text[] = [];
  private buildBtn: Phaser.GameObjects.Text;
  private elevatorText: Phaser.GameObjects.Text;
  private bg: Phaser.GameObjects.Graphics;
  private x: number;
  private y: number;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    onSelectFloor: (floor: number) => void,
    onBuildFloor: () => void
  ) {
    this.x = x;
    this.y = y;
    this.bg = scene.add.graphics();

    scene.add.text(x + 12, y + 8, 'FLOORS', {
      fontSize: '11px', fontFamily: 'monospace', color: '#8888aa',
    });

    this.buildBtn = scene.add.text(x + WIDTH / 2, 0, '', {
      fontSize: '11px', fontFamily: 'monospace', color: '#4a90d9',
      backgroundColor: '#2a2a5e', padding: { x: 8, y: 4 },
    }).setOrigin(0.5, 0).setInteractive({ useHandCursor: true });
    this.buildBtn.on('pointerdown', onBuildFloor);

    for (let floor = 0; floor < FLOORS.max; floor++) {
      const row = scene.add.text(x + 8, 0, '', {
        fontSize: '12px', fontFamily: 'monospace', color: '#aaaacc',
        backgroundColor: '#22223a', padding: { x: 6, y: 6 }, fixedWidth: WIDTH - 16,
      }).setInteractive({ useHandCursor: true }).setVisible(false);
      row.on('pointerdown', () => onSelectFloor(floor));
      this.rows.push(row);
    }

    this.elevatorText = scene.add.text(x + 12, 0, '', {
      fontSize: '10px', fontFamily: 'monospace', color: '#888899', lineSpacing: 2,
      wordWrap: { width: WIDTH - 24 },
    });
  }

  update(state: HotelState, currentFloor: number) {
    const canBuild = getNextFloorCost(state) !== null;
    const listTop = this.y + HEADER_H + (canBuild ? ROW_H : 0);
    const height = HEADER_H + (canBuild ? ROW_H : 0) + state.floorCount * ROW_H + FOOTER_H;

    this.bg.clear();
    this.bg.fillStyle(0x1a1a3e, 0.9);
    this.bg.fillRoundedRect(this.x, this.y, WIDTH, height, 8);
    this.bg.lineStyle(1, 0x4a4a6a, 1);
    this.bg.strokeRoundedRect(this.x, this.y, WIDTH, height, 8);

    // "Build floor" sits on the roof
    const cost = getNextFloorCost(state);
    this.buildBtn.setVisible(cost !== null);
    if (cost !== null) {
      const affordable = state.cash >= cost;
      this.buildBtn.setText(`+ Floor ${state.floorCount + 1} ($${cost.toLocaleString()})`);
      this.buildBtn.setColor(affordable ? '#4a90d9' : '#555566');
      this.buildBtn.setY(this.y + HEADER_H);
      if (affordable) this.buildBtn.setInteractive({ useHandCursor: true });
      else this.buildBtn.disableInteractive();
    }

    // Floors, top floor first so the ground floor sits at the bottom
    this.rows.forEach((row, floor) => {
      if (floor >= state.floorCount) {
        row.setVisible(false);
        return;
      }
      const rooms = state.rooms.filter(r => r.floor === floor).length;
      const name = floor === 0 ? 'Ground' : `Floor ${floor + 1}`;
      const selected = floor === currentFloor;
      row.setText(`${selected ? '▶' : ' '} ${name.padEnd(8)} ${rooms} rooms`);
      row.setColor(selected ? '#ffffff' : '#aaaacc');
      row.setBackgroundColor(selected ? '#4a4a6a' : '#22223a');
      row.setY(listTop + (state.floorCount - 1 - floor) * ROW_H);
      row.setVisible(true);
    });

    // Elevator status, since it gates every floor above ground
    const upper = state.rooms.filter(r => r.floor > 0).length;
    let elevatorLine: string;
    if (state.floorCount === 1) {
      elevatorLine = 'Upper floors need an elevator';
    } else if (state.elevators.length === 0) {
      elevatorLine = upper > 0 ? 'No elevator: upper rooms unbookable!' : 'Build an elevator to use upper floors';
    } else {
      const capacity = state.elevators.length * ELEVATOR.roomsServed;
      const busy = getElevatorLoad(state) > 1 ? ' (busy!)' : '';
      elevatorLine = `Elevators: ${state.elevators.length}, ${upper}/${capacity} upper rooms${busy}`;
    }
    this.elevatorText.setText(elevatorLine);
    this.elevatorText.setColor(elevatorLine.includes('!') ? '#e74c3c' : '#888899');
    this.elevatorText.setY(listTop + state.floorCount * ROW_H + 8);
  }
}
