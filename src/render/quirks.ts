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

/** The return ring's colour: white for a returning guest, silver for a regular, gold for a VIP. */
export const RING_COLORS: Record<'returning' | 'regular' | 'vip', number> = { returning: 0xffffff, regular: 0xbfc9ca, vip: 0xf4c542 };

/** The selected guest's ring (not to be mistaken for a VIP's gold). */
export const SELECTED_COLOR = 0x5dade2;

/** The colours of the mood faces. */
export const MOOD_COLORS: Record<'irritated' | 'angry', number> = { irritated: 0xe67e22, angry: 0xe74c3c };

/** A small face centred at (x, y) for an irritated (flat mouth) or angry (frown) guest, on the same dark disc as a quirk. */
export function drawMoodFace(g: Phaser.GameObjects.Graphics, x: number, y: number, mood: 'irritated' | 'angry') {
  g.fillStyle(BACKING, 0.9);
  g.fillCircle(x, y, 4);
  g.fillStyle(MOOD_COLORS[mood], 1);
  g.fillCircle(x, y, 3);
  // Eyes, and the mouth
  g.fillStyle(BACKING, 1);
  g.fillRect(x - 1.6, y - 1.4, 1, 1);
  g.fillRect(x + 0.6, y - 1.4, 1, 1);
  g.lineStyle(0.9, BACKING, 1);
  if (mood === 'irritated') g.lineBetween(x - 1.4, y + 1.2, x + 1.4, y + 1.2);
  else {
    g.lineBetween(x - 1.5, y + 1.8, x, y + 0.9);
    g.lineBetween(x, y + 0.9, x + 1.5, y + 1.8);
  }
}

/** A "z" (asleep) with its top-left at (x, y), 5px square. */
export function drawSleepZ(g: Phaser.GameObjects.Graphics, x: number, y: number) {
  g.lineStyle(1.5, 0xecf0f1, 0.9);
  g.lineBetween(x, y, x + 5, y);
  g.lineBetween(x + 5, y, x, y + 5);
  g.lineBetween(x, y + 5, x + 5, y + 5);
}
