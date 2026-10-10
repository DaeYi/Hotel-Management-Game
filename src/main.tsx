import Phaser from 'phaser';
import { render, createRef } from 'preact';
import { GameController } from './game/GameController';
import { WorldScene } from './render/WorldScene';
import { WORLD_WIDTH, WORLD_HEIGHT } from './render/GridRenderer';
import { App } from './ui/App';
import './ui/styles.css';

// The game (state + clock + actions), the HTML interface around it, and the
// renderer drawing the world inside it. The interface and renderer both only
// talk to the controller, so either can be replaced independently.
const controller = new GameController();
const worldRef = createRef<HTMLDivElement>();

render(<App controller={controller} worldRef={worldRef} />, document.getElementById('app')!);

new Phaser.Game({
  type: Phaser.AUTO,
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  parent: worldRef.current!,
  backgroundColor: '#16213e',
  scene: [new WorldScene(controller)],
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
});

window.addEventListener('keydown', event => {
  if (event.key === 'PageUp' || event.key === 'PageDown') {
    event.preventDefault(); // switch floors, don't scroll the page
    controller.setFloor(controller.currentFloor + (event.key === 'PageUp' ? 1 : -1));
  } else if (event.key === 'Escape') {
    if (controller.tool) controller.selectTool(null);
    else if (controller.selection) controller.clearSelection();
    else controller.closePanel();
  }
});

controller.start();
