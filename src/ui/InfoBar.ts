import Phaser from 'phaser';
import type { HotelState } from '../simulation/types';
import { getOccupancyRate } from '../simulation/HotelState';
import { getSeasonInfo } from '../simulation/SeasonManager';

const SEASON_ICONS: Record<string, string> = {
  spring: '\ud83c\udf38',
  summer: '\u2600\ufe0f',
  autumn: '\ud83c\udf42',
  winter: '\u2744\ufe0f',
};

const DEMAND_COLORS: Record<string, string> = {
  'Very High': '#e74c3c',
  'High': '#f39c12',
  'Normal': '#e0e0e0',
  'Low': '#3498db',
  'Very Low': '#9b59b6',
};

export class InfoBar {
  private infoText: Phaser.GameObjects.Text;
  private statusText: Phaser.GameObjects.Text;
  private seasonText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, x: number, topY: number, bottomY: number) {
    this.infoText = scene.add.text(x, topY, '', {
      fontSize: '15px',
      fontFamily: 'monospace',
      color: '#e0e0e0',
    });

    this.seasonText = scene.add.text(x, topY + 22, '', {
      fontSize: '11px',
      fontFamily: 'monospace',
      color: '#888899',
    });

    this.statusText = scene.add.text(x, bottomY, '', {
      fontSize: '13px',
      fontFamily: 'monospace',
      color: '#aaaacc',
    });
  }

  update(state: HotelState, paused: boolean, speedMultiplier: number) {
    const starDisplay = '\u2605'.repeat(state.starRating)
      + '\u2606'.repeat(5 - state.starRating);
    const reviewDisplay = state.reviewScore.toFixed(1);
    const speedLabel = paused ? 'PAUSED' : `${speedMultiplier}x`;

    this.infoText.setText(
      `$${Math.floor(state.cash).toLocaleString()}  |  ` +
      `${starDisplay}  ${reviewDisplay}/10  |  ${speedLabel}`
    );
    this.infoText.setColor(state.cash < 0 ? '#e74c3c' : '#e0e0e0');

    // Season and date line
    const seasonInfo = getSeasonInfo(state.day);
    const seasonIcon = SEASON_ICONS[seasonInfo.season] ?? '';
    const seasonName = seasonInfo.season.charAt(0).toUpperCase() + seasonInfo.season.slice(1);
    const eventStr = seasonInfo.specialEvent ? `  \ud83c\udf89 ${seasonInfo.specialEvent}` : '';
    const demandColor = DEMAND_COLORS[seasonInfo.demandLabel] ?? '#e0e0e0';

    this.seasonText.setText(
      `${seasonInfo.dayOfWeek} Day ${state.day} (Y${seasonInfo.yearNumber})  |  ` +
      `${seasonIcon} ${seasonName}  |  ` +
      `${String(state.hour).padStart(2, '0')}:00  |  ` +
      `Demand: ${seasonInfo.demandLabel}${eventStr}`
    );
    this.seasonText.setColor(demandColor);

    // Bottom status bar
    const occupancy = (getOccupancyRate(state) * 100).toFixed(0);
    const cleaning = state.rooms.filter(r => r.status === 'cleaning').length;
    const cleaningStr = cleaning > 0 ? `  |  Cleaning: ${cleaning}` : '';

    this.statusText.setText(
      `Occupancy: ${occupancy}%  |  ` +
      `Rooms: ${state.rooms.length}  |  ` +
      `Guests: ${state.guests.length}  |  ` +
      `Turned away: ${state.totalTurnedAway}${cleaningStr}`
    );
  }
}
