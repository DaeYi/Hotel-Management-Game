import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { GameController } from '../game/GameController';

export const GameContext = createContext<GameController | null>(null);

/** The game controller, for components rendered inside <App>. */
export function useController(): GameController {
  const controller = useContext(GameContext);
  if (!controller) throw new Error('useController() outside <GameContext.Provider>');
  return controller;
}

/**
 * Re-render whenever the controller reports a change. Only the root needs
 * this: children re-render with it.
 */
export function useControllerVersion(controller: GameController): number {
  const [version, setVersion] = useState(controller.getVersion());
  useEffect(() => controller.subscribe(() => setVersion(controller.getVersion())), [controller]);
  return version;
}

/** Re-render every so often while the clock runs, so what's shown (who's where) keeps up with the game. */
export function useLiveClock(ms = 250) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}
