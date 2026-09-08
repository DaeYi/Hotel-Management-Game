// SaveManager.ts calls the browser's localStorage API directly, which works
// fine in the real (Vite-bundled, browser-run) game. Under plain Node/vitest
// there's no jsdom in this project, and Node's own experimental localStorage
// global requires a --localstorage-file flag to actually implement
// setItem/clear/etc. — without it, those methods are simply missing. This
// installs a minimal in-memory polyfill only when the native one isn't
// functional, so SaveManager's tests can run without adding jsdom as a
// dependency for one file.
class MemoryStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  get length(): number {
    return this.store.size;
  }
}

const existing = (globalThis as any).localStorage;
if (typeof existing?.setItem !== 'function' || typeof existing?.clear !== 'function') {
  (globalThis as any).localStorage = new MemoryStorage();
}
