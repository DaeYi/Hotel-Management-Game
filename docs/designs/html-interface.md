# Design: HTML Interface

Date: 2026-10-10
Status: SHIPPED
Repo: DaeYi/Hotel-Management-Game
Leads to: a 3D renderer

## Why

Every panel, button, tooltip, and dialog was drawn with Phaser game objects, and the game loop, state, and player actions lived inside the Phaser scene. Moving to 3D would have meant rewriting the entire interface along with the renderer. Hand-placed pixel coordinates also kept causing text overflow, the interface couldn't be tested, and it didn't adapt to phone screens.

## Architecture

Three layers, each talking only to the controller:

```
                 GameController (src/game)
        state - clock - every player action - toasts
          ^  subscribe / actions       ^  read each frame / pointer -> tiles
          |                            |
   HTML interface (src/ui)      World renderer (src/render)
   Preact components            Phaser: floor plan + walkers
```

- **`GameController`** (`src/game/GameController.ts`) is plain TypeScript with no Phaser:
  - **What it owns:** the `HotelState`, PRNG, game speed and pause, the requestAnimationFrame loop and simulation ticks, saving at day rollover, and bankruptcy.
  - **Interface state:** current floor, build tool, selection, open panel, noise overlay, tutorial and dialogs, hover preview, placement feedback.
  - **Player actions:** all of them (build/paint/bulldoze, staff, prices, renovations, campaigns, loan).
  - **Notifications:** `subscribe()` for interface re-renders, at most once per frame and only when something changed. `onTick()` for per-tick events (the renderer uses it for walkers).
- **`ToastQueue`** (`src/game/ToastQueue.ts`) holds the toast batching and suppression logic, ported out of the Phaser toast class.
- **The renderer** (`src/render/WorldScene.ts`, `GridRenderer.ts`, `ActorLayer.ts`) is a Phaser scene sized to the floor plan only (520×312, scaled to fit). Each frame it reads the controller, and it turns pointer events into tile coordinates for `tileDown`/`tileMove`/`pointerUp`. It holds no game state. A 3D renderer replaces this folder and nothing else.
- **The interface** (`src/ui`) is made of Preact components (about 3 KB):
  - **Layout:** `App` lays out the top bar and goal tracker, the toolbar, the world with its overlays (inspectors, floating panels, toasts, signs), the status bar, the legend, the build panel, and the floor stack.
  - **Panels and dialogs:** the floating panels (Staff, Cleaning, Amenities, Ads, Goals, Story, Finance) are in `src/ui/panels`, and the dialogs (tutorial, new game, bankruptcy) are in `Dialogs.tsx`.
  - **Re-rendering:** only `App` subscribes to the controller; children re-render with it.
- **Styling:** `src/ui/styles.css` uses CSS custom properties for the palette (same dark navy, monospace look) and real layout: flexbox, with a breakpoint for phones. The world box keeps its aspect ratio and scales with the window, and inspectors and panels may hang past its edge.

## Behavior changes

- **Finance chart:** now an SVG fed by the saved end-of-day stats. `DailyStat.reviewScore` was added (optional, so no save migration is needed). The chart survives reloads; it used to reset every session.
- **Keyboard:** PageUp/PageDown switch floors without scrolling the page; Escape drops the build tool, then the selection, then the open panel.
- **Phone-width layout:** the world scales down and the build and floor panels wrap below it.
- **Real DOM:** everything is accessible to screen readers and browser automation (roles, labels, `aria-pressed`).

## Tests

- **`test/controller.test.ts`** (Node):
  - **Clock:** ticks per interval and speed; paused and dialog states; notification batching; save at rollover.
  - **Building:** placement and feedback, hover preview, drag-painting, bulldozing, selection and inspector actions.
  - **Floors, panels, management actions.**
- **`test/ui.test.tsx`** (happy-dom + @testing-library/preact): rendering, tutorial flow, build tool selection and locks, toolbar panels and staff hiring, goal tracker and loan repayment, the room inspector (price slider, demolish), the floor stack, toasts, and the new-game confirmation.

219 tests in total. The Phaser canvas itself still has no automated coverage; a screenshot test would cover it.

## Next: 3D

Replace `src/render` with a Three.js scene that implements the same contract:
- Read `controller.state`, `currentFloor`, `hover`, `feedback`, and `noiseOverlay` each frame.
- Call `tileDown`/`tileMove`/`pointerUp` with tile coordinates from raycasts.
- Subscribe to `onTick` for walkers.

The simulation already has (x, y, floor) positions and pathfinding for people, and nothing in `src/ui` or `src/game` needs to change.
