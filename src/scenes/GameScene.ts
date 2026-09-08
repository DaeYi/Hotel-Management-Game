import Phaser from 'phaser';
import { createHotelState, addRoom, setRoomPrice, repairRoom, demolishRoom, addFacility, demolishFacility, isTileOccupied } from '../simulation/HotelState';
import { tickSimulation } from '../simulation/tick';
import { checkBankruptcy } from '../simulation/EconomyManager';
import { PRNG } from '../simulation/prng';
import { ROOM_CONFIG } from '../config/balance';
import type { HotelState, RoomType, FacilityType, TileType, StaffConfig, AmenityTier, CleaningQuality, DailyCleaningCadence } from '../simulation/types';
import { FACILITY_CONFIG } from '../config/balance';
import { BuildPanel } from '../ui/BuildPanel';
import { InfoBar } from '../ui/InfoBar';
import { GridRenderer, GRID_OFFSET_X, GRID_OFFSET_Y, TILE_SIZE } from '../ui/GridRenderer';
import { RoomInspector } from '../ui/RoomInspector';
import { FacilityInspector } from '../ui/FacilityInspector';
import { NotificationToast } from '../ui/NotificationToast';
import { FinanceChart } from '../ui/FinanceChart';
import { Tutorial } from '../ui/Tutorial';
import { BankruptcyOverlay, NoVacancySign, ZeroRoomsPrompt } from '../ui/Overlays';
import { HousekeepingPanel } from '../ui/HousekeepingPanel';
import { StaffPanel } from '../ui/StaffPanel';
import { AmenitiesPanel } from '../ui/AmenitiesPanel';
import { Toolbar } from '../ui/Toolbar';
import { saveGame, loadGame, deleteSave } from '../simulation/SaveManager';
import { GRID } from '../config/balance';

// Panel position: centered over the grid area
const PANEL_X = GRID_OFFSET_X + 140;
const PANEL_Y = GRID_OFFSET_Y + 60;

export class GameScene extends Phaser.Scene {
  private state!: HotelState;
  private prng!: PRNG;

  private grid!: GridRenderer;
  private buildPanel!: BuildPanel;
  private infoBar!: InfoBar;
  private roomInspector!: RoomInspector;
  private facilityInspector!: FacilityInspector;
  private toasts!: NotificationToast;
  private chart!: FinanceChart;
  private noVacancy!: NoVacancySign;
  private zeroRooms!: ZeroRoomsPrompt;
  private housekeepingPanel!: HousekeepingPanel;
  private staffPanel!: StaffPanel;
  private amenitiesPanel!: AmenitiesPanel;
  private toolbar!: Toolbar;
  private tutorialActive = true;
  private gameOver = false;

  // Simulation timing
  private tickAccumulator = 0;
  private readonly tickInterval = 2000;
  private speedMultiplier = 1;
  private paused = true;

  // Daily revenue tracking for chart
  private dailyRevenue = 0;
  private lastRecordedDay = 0;

  constructor() {
    super('GameScene');
  }

  create() {
    const save = loadGame();
    if (save) {
      this.state = save.state;
      this.prng = PRNG.fromState(save.prngState);
      this.lastRecordedDay = this.state.day;
    } else {
      this.prng = new PRNG(Date.now());
      this.state = createHotelState();
    }

    // Info bar (top two lines)
    const bottomY = GRID_OFFSET_Y + GRID.height * TILE_SIZE + 8;
    this.infoBar = new InfoBar(this, GRID_OFFSET_X, 4, bottomY);

    // Toolbar (below info bar, above grid)
    this.toolbar = new Toolbar(this, GRID_OFFSET_X, 46, (id, active) => {
      this.handleToolbarAction(id, active);
    });

    // Grid renderer
    this.grid = new GridRenderer(this);

    // Build panel (right side)
    const buildPanelX = GRID_OFFSET_X + GRID.width * TILE_SIZE + 16;
    this.buildPanel = new BuildPanel(this, buildPanelX, GRID_OFFSET_Y, () => {
      if (this.buildPanel.getSelectedType()) {
        this.roomInspector.hide();
        this.facilityInspector.hide();
      }
    });

    // Room inspector (popup on room click)
    this.roomInspector = new RoomInspector(
      this,
      (roomId, pct) => this.handlePriceChange(roomId, pct),
      (roomId) => this.handleRepair(roomId),
      (roomId) => this.handleDemolish(roomId)
    );

    // Facility inspector (popup on facility click)
    this.facilityInspector = new FacilityInspector(
      this,
      (facilityId) => this.handleDemolishFacility(facilityId)
    );

    // Notification toasts
    this.toasts = new NotificationToast(this, GRID_OFFSET_X, bottomY - 12);

    // Finance chart (no toggle button, controlled by toolbar)
    this.chart = new FinanceChart(
      this,
      -100, -100, // toggle button offscreen (toolbar controls visibility now)
      GRID_OFFSET_X + 160, GRID_OFFSET_Y + 120
    );

    // Management panels (no toggle buttons, controlled by toolbar)
    this.housekeepingPanel = new HousekeepingPanel(
      this,
      -100, -100,
      PANEL_X, PANEL_Y,
      (quality, cadence) => this.handleHousekeepingChange(quality, cadence)
    );

    this.staffPanel = new StaffPanel(
      this,
      -100, -100,
      PANEL_X, PANEL_Y,
      (staff) => this.handleStaffChange(staff)
    );

    this.amenitiesPanel = new AmenitiesPanel(
      this,
      -100, -100,
      PANEL_X, PANEL_Y,
      (amenities) => this.handleAmenitiesChange(amenities)
    );

    // Edge case overlays
    const gridCenterX = GRID_OFFSET_X + (GRID.width * TILE_SIZE) / 2;
    this.noVacancy = new NoVacancySign(this, gridCenterX, GRID_OFFSET_Y - 12);
    const gridCenterY = GRID_OFFSET_Y + (GRID.height * TILE_SIZE) / 2;
    this.zeroRooms = new ZeroRoomsPrompt(this, gridCenterX, gridCenterY);

    // Input handlers
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.handleClick(pointer);
    });
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      this.handleGridHover(pointer);
    });

    // Tutorial
    if (!save) {
      new Tutorial(this, () => {
        this.tutorialActive = false;
        this.paused = false;
        this.speedMultiplier = 1;
        this.toolbar.setPaused(false);
      });
    } else {
      this.tutorialActive = false;
      this.paused = false;
    }
  }

  update(_time: number, delta: number) {
    if (this.tutorialActive || this.gameOver) return;

    if (!this.paused) {
      this.tickAccumulator += delta * this.speedMultiplier;
      while (this.tickAccumulator >= this.tickInterval) {
        this.tickAccumulator -= this.tickInterval;
        this.doTick();
      }
    }

    this.grid.renderRooms(this.state);
    this.grid.renderFacilities(this.state);
    this.grid.renderGuests(this.state);
    this.grid.renderNoise(this.state);
    this.grid.renderConstruction(this.state);
    this.grid.updateDayNight(this.state.hour);
    this.grid.updateFeedback(delta);
    this.infoBar.update(this.state, this.paused, this.speedMultiplier);
    this.buildPanel.updateAffordability(this.state.cash);
    this.roomInspector.update(this.state);
    this.facilityInspector.update(this.state);
    this.housekeepingPanel.update(this.state);
    this.staffPanel.update(this.state);
    this.amenitiesPanel.update(this.state);
    this.toasts.update(delta);

    const occupied = this.state.rooms.filter(r => r.status === 'occupied').length;
    this.noVacancy.update(this.state.rooms.length, occupied);
    this.zeroRooms.update(this.state.rooms.length);
  }

  private doTick() {
    const prevDay = this.state.day;
    const { state, events } = tickSimulation(this.state, this.prng);
    this.state = state;

    for (const event of events) {
      if (event.type === 'guest_departed' && event.data) {
        this.dailyRevenue += (event.data.totalPaid as number) || 0;
      }
    }

    this.toasts.addEvents(events);

    if (this.state.day !== prevDay && this.state.day > this.lastRecordedDay) {
      this.chart.recordDay(this.dailyRevenue, this.state.reviewScore);
      this.dailyRevenue = 0;
      this.lastRecordedDay = this.state.day;
      saveGame(this.state, this.prng);
    }

    if (checkBankruptcy(this.state)) {
      this.gameOver = true;
      this.paused = true;
      new BankruptcyOverlay(this, this.state.cash);
    }
  }

  // === Toolbar actions ===

  private handleToolbarAction(id: string, active: boolean) {
    switch (id) {
      case 'staff':
        if (active) {
          this.hideAllPanels();
          this.staffPanel.show();
        } else {
          this.staffPanel.hide();
        }
        break;
      case 'housekeeping':
        if (active) {
          this.hideAllPanels();
          this.housekeepingPanel.show();
        } else {
          this.housekeepingPanel.hide();
        }
        break;
      case 'amenities':
        if (active) {
          this.hideAllPanels();
          this.amenitiesPanel.show();
        } else {
          this.amenitiesPanel.hide();
        }
        break;
      case 'chart':
        if (active) {
          this.hideAllPanels();
          this.chart.show();
        } else {
          this.chart.hide();
        }
        break;
      case 'noise':
        this.grid.toggleNoiseOverlay();
        break;
      case 'pause':
        this.paused = active;
        break;
      case 'speed1':
        this.paused = false;
        this.speedMultiplier = 1;
        this.toolbar.setPaused(false);
        break;
      case 'speed2':
        this.paused = false;
        this.speedMultiplier = 2;
        this.toolbar.setPaused(false);
        break;
      case 'speed5':
        this.paused = false;
        this.speedMultiplier = 5;
        this.toolbar.setPaused(false);
        break;
      case 'newgame':
        this.showNewGameConfirm();
        break;
    }
  }

  private hideAllPanels() {
    this.staffPanel.hide();
    this.housekeepingPanel.hide();
    this.amenitiesPanel.hide();
    this.chart.hide();
  }

  // === Click handlers ===

  private handleClick(pointer: Phaser.Input.Pointer) {
    if (this.tutorialActive) return;
    if (this.roomInspector.isVisible() && this.roomInspector.containsPoint(pointer.x, pointer.y)) {
      return;
    }
    if (this.facilityInspector.isVisible() && this.facilityInspector.containsPoint(pointer.x, pointer.y)) {
      return;
    }

    const selectedType = this.buildPanel.getSelectedType();
    const cell = this.grid.pointerToGrid(pointer);

    if (selectedType && cell) {
      let result: HotelState | null = null;
      if (this.buildPanel.isRoomSelected()) {
        result = addRoom(this.state, selectedType as RoomType, cell.gridX, cell.gridY);
      } else if (this.buildPanel.isFacilitySelected()) {
        result = addFacility(this.state, selectedType as FacilityType, cell.gridX, cell.gridY);
      }
      if (result) {
        this.state = result;
        this.grid.showPlacementSuccess(cell.gridX, cell.gridY);
      } else {
        this.grid.showPlacementFailure(cell.gridX, cell.gridY);
      }
      return;
    }

    if (!selectedType && cell) {
      const room = this.state.rooms.find(
        r => r.gridX === cell.gridX && r.gridY === cell.gridY
      );
      if (room) {
        this.facilityInspector.hide();
        this.roomInspector.show(room, this.state);
        return;
      }

      const facility = this.state.facilities.find(
        f => f.gridX === cell.gridX && f.gridY === cell.gridY
      );
      if (facility) {
        this.roomInspector.hide();
        this.facilityInspector.show(facility);
        return;
      }

      this.roomInspector.hide();
      this.facilityInspector.hide();
    }
  }

  private handleGridHover(pointer: Phaser.Input.Pointer) {
    const selectedType = this.buildPanel.getSelectedType();
    if (!selectedType) {
      this.grid.clearHoverPreview();
      return;
    }
    const cell = this.grid.pointerToGrid(pointer);
    if (!cell) {
      this.grid.clearHoverPreview();
      return;
    }
    const canPlace = this.canPlaceTile(selectedType, cell.gridX, cell.gridY);
    this.grid.showHoverPreview(cell.gridX, cell.gridY, selectedType, canPlace);
  }

  private canPlaceTile(type: TileType, gridX: number, gridY: number): boolean {
    if (isTileOccupied(this.state, gridX, gridY)) return false;
    const roomTypes = ['standard', 'deluxe', 'suite'];
    if (roomTypes.includes(type)) {
      return this.state.cash >= ROOM_CONFIG[type as RoomType].buildCost;
    }
    const fConfig = FACILITY_CONFIG[type];
    return fConfig ? this.state.cash >= fConfig.buildCost : false;
  }

  // === State change handlers ===

  private handleAmenitiesChange(amenities: Record<RoomType, AmenityTier>) {
    this.state = { ...this.state, amenities };
  }

  private handleStaffChange(staff: StaffConfig) {
    this.state = { ...this.state, staff };
  }

  private handleHousekeepingChange(quality: CleaningQuality, cadence: DailyCleaningCadence) {
    this.state = {
      ...this.state,
      housekeeping: { turnoverQuality: quality, dailyCadence: cadence },
    };
  }

  private handleDemolish(roomId: string) {
    const result = demolishRoom(this.state, roomId);
    if (result) {
      this.state = result;
      this.roomInspector.hide();
    }
  }

  private handleDemolishFacility(facilityId: string) {
    const result = demolishFacility(this.state, facilityId);
    if (result) {
      this.state = result;
      this.facilityInspector.hide();
    }
  }

  private handleRepair(roomId: string) {
    const result = repairRoom(this.state, roomId);
    if (result) {
      this.state = result;
      const room = this.state.rooms.find(r => r.id === roomId);
      if (room) this.roomInspector.show(room, this.state);
    }
  }

  private handlePriceChange(roomId: string, pct: number) {
    const room = this.state.rooms.find(r => r.id === roomId);
    if (!room) return;
    const config = ROOM_CONFIG[room.type];
    const newPrice = Math.round(config.minPrice + pct * (config.maxPrice - config.minPrice));
    this.state = setRoomPrice(this.state, roomId, newPrice);
  }

  private showNewGameConfirm() {
    this.paused = true;
    const container = this.add.container(0, 0).setDepth(100);
    container.add(this.add.rectangle(480, 320, 960, 640, 0x000000, 0.6));

    const panel = this.add.graphics();
    panel.fillStyle(0x1a1a3e, 0.95);
    panel.fillRoundedRect(310, 230, 340, 180, 12);
    panel.lineStyle(2, 0x4a4a6a, 0.8);
    panel.strokeRoundedRect(310, 230, 340, 180, 12);
    container.add(panel);

    container.add(this.add.text(480, 260, 'Start a New Game?', {
      fontSize: '18px', fontFamily: 'monospace', color: '#ffffff',
    }).setOrigin(0.5));

    container.add(this.add.text(480, 295, 'Your current progress will be lost.', {
      fontSize: '12px', fontFamily: 'monospace', color: '#aaaacc',
    }).setOrigin(0.5));

    const confirmBtn = this.add.text(400, 350, 'Start Over', {
      fontSize: '14px', fontFamily: 'monospace', color: '#e74c3c',
      backgroundColor: '#3a1a1a', padding: { x: 16, y: 8 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    confirmBtn.on('pointerdown', () => {
      deleteSave();
      localStorage.removeItem('hotel-game-tutorial-seen');
      window.location.reload();
    });
    confirmBtn.on('pointerover', () => confirmBtn.setColor('#ffffff'));
    confirmBtn.on('pointerout', () => confirmBtn.setColor('#e74c3c'));
    container.add(confirmBtn);

    const cancelBtn = this.add.text(560, 350, 'Cancel', {
      fontSize: '14px', fontFamily: 'monospace', color: '#4a90d9',
      backgroundColor: '#2a2a5e', padding: { x: 16, y: 8 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    cancelBtn.on('pointerdown', () => {
      container.destroy();
      this.paused = false;
    });
    cancelBtn.on('pointerover', () => cancelBtn.setColor('#ffffff'));
    cancelBtn.on('pointerout', () => cancelBtn.setColor('#4a90d9'));
    container.add(cancelBtn);
  }
}
