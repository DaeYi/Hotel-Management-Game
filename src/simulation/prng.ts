/**
 * Mulberry32 - a fast, seedable 32-bit PRNG.
 * Deterministic: same seed always produces the same sequence.
 */
export class PRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  /** Returns a float in [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns a float in [min, max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Returns an integer in [min, max] (inclusive) */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Returns true with the given probability (0-1) */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Returns the current internal state (for saving) */
  getState(): number {
    return this.state;
  }

  /** Restores from a saved state */
  static fromState(state: number): PRNG {
    const prng = new PRNG(0);
    prng.state = state;
    return prng;
  }
}
