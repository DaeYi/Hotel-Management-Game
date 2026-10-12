import type Phaser from 'phaser';

// The small marks drawn on guests (docs/designs/guest-staff-personalities.md,
// Display budget): at most one quirk icon per guest -- a moon for a light
// sleeper, a music note for a rowdy one -- and a "z" by a guest asleep in their
// room. Graphics only (no text or textures), a few primitives each, drawn every
// frame. The legend uses the same glyphs as text.

export type Quirk = 'moon' | 'note';

/** The legend's text for each mark. */
export const QUIRK_GLYPHS: Record<Quirk | 'asleep', string> = { moon: '☾', note: '♪', asleep: 'z' };

const BACKING = 0x1b1b2b;

/** A quirk icon centred at (x, y), about 8px across, on a dark disc so it reads on any floor. */
export function drawQuirk(g: Phaser.GameObjects.Graphics, x: number, y: number, quirk: Quirk) {
  g.fillStyle(BACKING, 0.9);
  g.fillCircle(x, y, 4);
  if (quirk === 'moon') {
    // A crescent: a pale disc with a bite out of it
    g.fillStyle(0xf9e79f, 1);
    g.fillCircle(x, y, 2.8);
    g.fillStyle(BACKING, 1);
    g.fillCircle(x + 1.3, y - 1, 2.3);
  } else {
    // A quaver: head, stem, flag
    g.fillStyle(0xf5f5f5, 1);
    g.fillCircle(x - 0.9, y + 1.5, 1.4);
    g.fillRect(x + 0.2, y - 2.8, 1, 4.4);
    g.fillTriangle(x + 1.2, y - 2.8, x + 2.9, y - 1.7, x + 1.2, y - 0.9);
  }
}

/** A "z" (asleep) with its top-left at (x, y), 5px square. */
export function drawSleepZ(g: Phaser.GameObjects.Graphics, x: number, y: number) {
  g.lineStyle(1.5, 0xecf0f1, 0.9);
  g.lineBetween(x, y, x + 5, y);
  g.lineBetween(x + 5, y, x, y + 5);
  g.lineBetween(x, y + 5, x + 5, y + 5);
}
