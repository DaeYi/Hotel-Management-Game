import Phaser from 'phaser';
import type { HotelState, StaffConfig } from '../simulation/types';
import { STAFF } from '../config/balance';
import { getMaintenanceStatus, getStaffDailyCost } from '../simulation/MaintenanceManager';
import { getUpkeepMultiplier } from '../simulation/StarRatingManager';
import { getHousekeepingStatus } from '../simulation/HousekeepingManager';

const PANEL_W = 280;
const PANEL_H = 400;

interface StaffSection {
  countText: Phaser.GameObjects.Text;
  statusText: Phaser.GameObjects.Text;
}

export class StaffPanel {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private visible = false;

  private sections: Record<string, StaffSection> = {};
  private totalCostText!: Phaser.GameObjects.Text;
  private recommendText!: Phaser.GameObjects.Text;

  private onChange: (staff: StaffConfig) => void;

  constructor(
    scene: Phaser.Scene,
    toggleX: number,
    toggleY: number,
    panelX: number,
    panelY: number,
    onChange: (staff: StaffConfig) => void
  ) {
    this.scene = scene;
    this.onChange = onChange;

    // Toggle button
    const toggleBtn = scene.add.text(toggleX, toggleY, '\ud83d\udd27', {
      fontSize: '16px', fontFamily: 'monospace', color: '#888899',
      backgroundColor: '#2a2a4a', padding: { x: 6, y: 2 },
    }).setInteractive({ useHandCursor: true }).setDepth(15);

    toggleBtn.on('pointerdown', () => {
      this.visible = !this.visible;
      this.container.setVisible(this.visible);
      toggleBtn.setColor(this.visible ? '#ffffff' : '#888899');
      toggleBtn.setBackgroundColor(this.visible ? '#4a4a6a' : '#2a2a4a');
    });

    // Panel
    this.container = scene.add.container(panelX, panelY).setDepth(18).setVisible(false);

    const bg = scene.add.graphics();
    bg.fillStyle(0x1a1a3e, 0.95);
    bg.fillRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    bg.lineStyle(1, 0x4a4a6a, 1);
    bg.strokeRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    this.container.add(bg);

    this.container.add(scene.add.text(12, 10, 'STAFF', {
      fontSize: '13px', fontFamily: 'monospace', color: '#8888aa',
    }));

    // === Front Desk section ===
    let y = 34;
    this.sections.frontDesk = this.createStaffSection(
      y, `Front Desk ($${STAFF.frontDesk.dailyWage}/day):`, 'frontDesk'
    );
    y += 72;

    this.addDivider(y);
    y += 10;

    // === Housekeepers section ===
    this.sections.housekeepers = this.createStaffSection(
      y, `Housekeepers ($${STAFF.housekeeping.dailyWage}/day):`, 'housekeepers'
    );
    y += 72;

    this.addDivider(y);
    y += 10;

    // === Maintenance section ===
    this.sections.maintenance = this.createStaffSection(
      y, `Maintenance ($${STAFF.maintenance.dailyWage}/day):`, 'maintenanceWorkers'
    );
    y += 72;

    this.addDivider(y);
    y += 10;

    // Total cost
    this.totalCostText = scene.add.text(12, y, '', {
      fontSize: '12px', fontFamily: 'monospace', color: '#f1c40f',
    });
    this.container.add(this.totalCostText);

    // Recommendation
    this.recommendText = scene.add.text(12, y + 24, '', {
      fontSize: '10px', fontFamily: 'monospace', color: '#f1c40f',
      wordWrap: { width: PANEL_W - 24 }, lineSpacing: 2,
    });
    this.container.add(this.recommendText);
  }

  private createStaffSection(y: number, label: string, staffKey: string): StaffSection {
    this.container.add(this.scene.add.text(12, y, label, {
      fontSize: '11px', fontFamily: 'monospace', color: '#aaaacc',
    }));

    const counterY = y + 20;

    // Minus button
    const minusBtn = this.scene.add.text(12, counterY, ' - ', {
      fontSize: '16px', fontFamily: 'monospace', color: '#e74c3c',
      backgroundColor: '#3a1a1a', padding: { x: 8, y: 2 },
    }).setInteractive({ useHandCursor: true });
    minusBtn.on('pointerdown', () => this.adjustStaff(staffKey, -1));
    minusBtn.on('pointerover', () => minusBtn.setColor('#ffffff'));
    minusBtn.on('pointerout', () => minusBtn.setColor('#e74c3c'));
    this.container.add(minusBtn);

    // Count
    const countText = this.scene.add.text(70, counterY, '0', {
      fontSize: '18px', fontFamily: 'monospace', color: '#ffffff', padding: { x: 12, y: 0 },
    });
    this.container.add(countText);

    // Plus button
    const plusBtn = this.scene.add.text(120, counterY, ' + ', {
      fontSize: '16px', fontFamily: 'monospace', color: '#2ecc71',
      backgroundColor: '#1a3a2e', padding: { x: 8, y: 2 },
    }).setInteractive({ useHandCursor: true });
    plusBtn.on('pointerdown', () => this.adjustStaff(staffKey, 1));
    plusBtn.on('pointerover', () => plusBtn.setColor('#ffffff'));
    plusBtn.on('pointerout', () => plusBtn.setColor('#2ecc71'));
    this.container.add(plusBtn);

    // Status
    const statusText = this.scene.add.text(12, counterY + 28, '', {
      fontSize: '10px', fontFamily: 'monospace', color: '#888899',
      wordWrap: { width: PANEL_W - 24 },
    });
    this.container.add(statusText);

    return { countText, statusText };
  }

  private addDivider(y: number) {
    const divider = this.scene.add.graphics();
    divider.lineStyle(1, 0x3a3a5a, 0.5);
    divider.lineBetween(12, y, PANEL_W - 12, y);
    this.container.add(divider);
  }

  private currentStaff: StaffConfig = { maintenanceWorkers: 0, housekeepers: 1, frontDesk: 1 };

  private adjustStaff(key: string, delta: number) {
    const k = key as keyof StaffConfig;
    this.currentStaff = {
      ...this.currentStaff,
      [k]: Math.max(0, (this.currentStaff[k] ?? 0) + delta),
    };
    this.onChange(this.currentStaff);
  }

  show() { this.visible = true; this.container.setVisible(true); }
  hide() { this.visible = false; this.container.setVisible(false); }

  update(state: HotelState) {
    this.currentStaff = { ...state.staff };

    // Front desk
    this.sections.frontDesk.countText.setText(`${state.staff.frontDesk}`);
    const fdCapacity = state.staff.frontDesk > 0
      ? state.staff.frontDesk * STAFF.frontDesk.checkInsPerHour
      : STAFF.frontDesk.selfServiceCapacity;
    this.sections.frontDesk.statusText.setText(
      `Check-in capacity: ${fdCapacity}/hr` +
      (state.staff.frontDesk === 0 ? ' (kiosk only!)' : '') +
      `  |  24/7 shift`
    );

    // Housekeepers
    this.sections.housekeepers.countText.setText(`${state.staff.housekeepers}`);
    const hkStatus = getHousekeepingStatus(state);
    const waitStr = hkStatus.roomsWaiting > 0 ? ` (${hkStatus.roomsWaiting} waiting!)` : '';
    this.sections.housekeepers.statusText.setText(
      `Cleaning: ${hkStatus.roomsBeingCleaned}${waitStr}  |  Cap: ${hkStatus.turnoverCapacity}/hr`
    );

    // Maintenance
    this.sections.maintenance.countText.setText(`${state.staff.maintenanceWorkers}`);
    const maintStatus = getMaintenanceStatus(state);
    this.sections.maintenance.statusText.setText(
      `Needs repair: ${maintStatus.roomsNeedingRepair}  |  Cap: ${maintStatus.effectiveCapacity} rooms`
    );

    // Total cost
    // Wages scale with prestige upkeep; the per-role labels show base wages
    const upkeep = getUpkeepMultiplier(state.starRating);
    const upkeepNote = upkeep > 1 ? ` (${state.starRating}★ wages x${upkeep})` : '';
    this.totalCostText.setText(`Total staff: $${Math.round(getStaffDailyCost(state))}/day${upkeepNote}`);

    // Most urgent recommendation
    const recommendations: string[] = [];
    if (state.staff.frontDesk === 0 && state.rooms.length > 0) {
      recommendations.push('No front desk! Most guests will leave.');
    }
    if (hkStatus.recommendation) recommendations.push(hkStatus.recommendation);
    if (maintStatus.recommendation) recommendations.push(maintStatus.recommendation);
    this.recommendText.setText(recommendations.length > 0
      ? '\u2139 ' + recommendations[0]
      : ''
    );
  }
}
