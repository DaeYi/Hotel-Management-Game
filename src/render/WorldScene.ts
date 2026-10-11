import Phaser from 'phaser';
import type { GameController } from '../game/GameController';
import { GridRenderer } from './GridRenderer';
import { ActorLayer } from './ActorLayer';

/**
 * Draws the floor plan being viewed and the people walking around it, and
 * turns pointer input into tile coordinates for the controller. Holds no game
 * state of its own: everything comes from the GameController, so this scene
 * can be swapped for a 3D renderer without touching the game or the interface.
 */
export class WorldScene extends Phaser.Scene {
  private grid!: GridRenderer;
  private actors!: ActorLayer;
  private lastFeedbackId = 0;

  constructor(private controller: GameController) {
    super('WorldScene');
  }

  create() {
    const c = this.controller;
    this.grid = new GridRenderer(this);
    this.actors = new ActorLayer(this);

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const tile = this.grid.pointerToGrid(pointer);
      if (tile) c.tileDown(tile);
    });
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      c.tileMove(this.grid.pointerToGrid(pointer), pointer.isDown);
    });
    this.input.on('pointerup', () => c.pointerUp());
    this.input.on('gameout', () => c.tileMove(null, false));
  }

  update(_time: number, delta: number) {
    const c = this.controller;
    const { state, currentFloor: floor } = c;

    this.grid.setNoiseOverlay(c.noiseOverlay);
    this.grid.renderRooms(state, floor);
    this.grid.renderFixtures(state, floor);
    this.grid.renderFacilities(state, floor);
    this.actors.update(state, floor, c.gameTime);
    this.grid.renderGuests(state, floor, this.actors.awayGuestIds());
    this.grid.renderNoise(state, floor);
    this.grid.renderConstruction(state, floor);
    this.grid.updateDayNight(state.hour);

    // Placement preview and the success/failure flash
    if (c.tool && c.hover) this.grid.showHoverPreview(c.hover.gridX, c.hover.gridY, c.tool, c.hover.canPlace, c.hover.door, c.hover.doorOpen);
    else this.grid.clearHoverPreview();
    if (c.feedback && c.feedback.id !== this.lastFeedbackId) {
      this.lastFeedbackId = c.feedback.id;
      if (c.feedback.ok) this.grid.showPlacementSuccess(c.feedback.gridX, c.feedback.gridY);
      else this.grid.showPlacementFailure(c.feedback.gridX, c.feedback.gridY);
    }
    this.grid.updateFeedback(delta);
  }
}
