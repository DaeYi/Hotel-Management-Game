import type Phaser from 'phaser';

// The small marks drawn on guests (docs/designs/guest-staff-personalities.md,
// Display budget): at most one quirk icon per guest -- a moon for a light
// sleeper, a music note for a rowdy one, a "$" for a big spender -- and a "z"
// by a guest asleep in their room. Graphics only (no text or textures), a few
// primitives each, drawn every frame. The legend uses the same glyphs as text.

export type Quirk = 'moon' | 'note' | 'coin';

/** The legend's text for each mark. */
export const QUIRK_GLYPHS: Record<Quirk | 'asleep', string> = { moon: '☾', note: '♪', coin: '$', asleep: 'z' };

/** The colour of a big spender's "$" (pale green: never the VIP's gold). */
export const COIN_COLOR = 0x82e0aa;

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
  } else if (quirk === 'coin') {
    // A "$": an S of three bars joined at alternate ends, and the stroke through it
    g.fillStyle(COIN_COLOR, 1);
    g.fillRect(x - 1.8, y - 2.4, 3.6, 0.9);
    g.fillRect(x - 1.8, y - 2.4, 0.9, 2.4);
    g.fillRect(x - 1.8, y - 0.45, 3.6, 0.9);
    g.fillRect(x + 0.9, y - 0.45, 0.9, 2.4);
    g.fillRect(x - 1.8, y + 1.5, 3.6, 0.9);
    g.fillRect(x - 0.35, y - 3.4, 0.7, 6.8);
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

/** The door hangers' colours: red, do not disturb; green, please make up the room. */
export const HANGER_COLORS: Record<'dnd' | 'makeup', number> = { dnd: 0xe74c3c, makeup: 0x2ecc71 };

/** The colour of the ring round a room with visitors in (noisy). */
export const VISITORS_COLOR = 0xff6b6b;

/**
 * A hanger on a room's door (docs/designs/guest-staff-personalities.md,
 * Housekeeping preference): a small tag hanging inside the room off one end of
 * the door bar, on a tile of `size` at (x, y), turned with the door.
 */
export function drawHanger(g: Phaser.GameObjects.Graphics, x: number, y: number, door: 'up' | 'right' | 'down' | 'left', pref: 'dnd' | 'makeup', size: number) {
  const long = size * 0.4;
  const thick = 4;
  const mid = (size - long) / 2;
  const along = mid + long - 7; // near the bar's far end
  const upright = door === 'up' || door === 'down';
  const [w, h] = upright ? [7, 10] : [10, 7];
  const [ax, ay] = door === 'up' ? [x + along, y + thick] : door === 'down' ? [x + along, y + size - thick - h]
    : door === 'left' ? [x + thick, y + along] : [x + size - thick - w, y + along];
  // Pale-edged, so it reads against the furniture; do not disturb has a white bar across, like a no-entry sign
  g.fillStyle(HANGER_COLORS[pref], 1);
  g.fillRect(ax, ay, w, h);
  g.lineStyle(1, 0xf5f5f5, 0.9);
  g.strokeRect(ax, ay, w, h);
  if (pref === 'dnd') {
    g.fillStyle(0xffffff, 1);
    if (upright) g.fillRect(ax + 1.5, ay + h / 2 - 1, w - 3, 2);
    else g.fillRect(ax + w / 2 - 1, ay + 1.5, 2, h - 3);
  }
}

/** A "z" (asleep) with its top-left at (x, y), 5px square. */
export function drawSleepZ(g: Phaser.GameObjects.Graphics, x: number, y: number) {
  g.lineStyle(1.5, 0xecf0f1, 0.9);
  g.lineBetween(x, y, x + 5, y);
  g.lineBetween(x + 5, y, x, y + 5);
  g.lineBetween(x, y + 5, x + 5, y + 5);
}

/** A clock filling red as someone in line runs out of patience (`used` 0-1), centred at (x, y), on a dark disc. */
export function drawClock(g: Phaser.GameObjects.Graphics, x: number, y: number, used: number) {
  g.fillStyle(BACKING, 0.9);
  g.fillCircle(x, y, 4.5);
  g.fillStyle(0xf5f5f5, 1);
  g.fillCircle(x, y, 3.4);
  g.fillStyle(0xe74c3c, 1);
  g.slice(x, y, 3.4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, used), false);
  g.fillPath();
  g.lineStyle(0.9, BACKING, 1);
  g.lineBetween(x, y, x, y - 2.6);
}

/** A speech bubble with a "!" (on the way to complain), centred at (x, y). */
export function drawComplaint(g: Phaser.GameObjects.Graphics, x: number, y: number) {
  g.fillStyle(0xf5f5f5, 1);
  g.fillRoundedRect(x - 4.5, y - 4, 9, 7, 2);
  g.fillTriangle(x - 2, y + 3, x + 1, y + 3, x - 3, y + 6);
  g.lineStyle(1, BACKING, 0.9);
  g.strokeRoundedRect(x - 4.5, y - 4, 9, 7, 2);
  g.fillStyle(0xe74c3c, 1);
  g.fillRect(x - 0.6, y - 2.8, 1.3, 3);
  g.fillRect(x - 0.6, y + 0.9, 1.3, 1.2);
}

/** A telephone (a guest just rang the front desk to complain), centred at (x, y), on a dark disc. */
export function drawPhone(g: Phaser.GameObjects.Graphics, x: number, y: number) {
  g.fillStyle(BACKING, 0.9);
  g.fillCircle(x, y, 4.5);
  g.fillStyle(0xf5f5f5, 1);
  g.fillRect(x - 3, y - 2.2, 6, 1.6); // the handset
  g.fillRect(x - 3, y - 1.4, 1.6, 2);
  g.fillRect(x + 1.4, y - 1.4, 1.6, 2);
  g.fillRect(x - 1.6, y + 0.4, 3.2, 2.2); // the base
}

/** The legend's text for the desk marks. */
export const DESK_GLYPHS = { phone: '\u260e' };
