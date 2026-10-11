import type { Ref } from 'preact';
import type { GameController, PanelId } from '../game/GameController';
import { GameContext, useController, useControllerVersion } from './context';
import { calculateValuation } from '../simulation/ObjectivesManager';
import { getSeasonInfo } from '../simulation/SeasonManager';
import { getOccupancyRate } from '../simulation/HotelState';
import { partySize } from '../simulation/Party';
import { getNextLoanPaymentDay } from '../simulation/EconomyManager';
import { ACTOR_COLORS } from '../render/ActorLayer';
import { CleaningLegend } from './CleaningKey';
import { formatMoney, formatMoneyShort, formatStars, capitalize } from './format';
import { BuildPanel } from './BuildPanel';
import { FloorPanel } from './FloorPanel';
import { GoalTracker } from './GoalTracker';
import { Inspector } from './Inspectors';
import { PanelHost } from './panels';
import { Tutorial, NewGameDialog, BankruptDialog } from './Dialogs';

/**
 * The whole interface around the game world. `worldRef` is the element the
 * renderer (Phaser today) draws into; everything else here is plain HTML.
 */
export function App({ controller, worldRef }: { controller: GameController; worldRef: Ref<HTMLDivElement> }) {
  useControllerVersion(controller);
  return (
    <GameContext.Provider value={controller}>
      <div class="app">
        <header class="topbar">
          <TopBar />
          <GoalTracker />
        </header>
        <Toolbar />
        <div class="main">
          <section class={`world-column${controller.openPanel && controller.panelCollapsed ? ' panel-docked' : ''}`}>
            <div class="world">
              {/* The renderer owns this element's contents; Preact never touches them */}
              <div class="world-canvas" ref={worldRef} />
              <div class="world-overlay">
                <NoVacancySign />
                <ZeroRoomsPrompt />
                <Toasts />
                <PanelHost />
                <Inspector />
              </div>
            </div>
            <StatusBar />
            <Legend />
          </section>
          <div class="side">
            <BuildPanel />
            <FloorPanel />
          </div>
        </div>
        <Tutorial />
        <NewGameDialog />
        <BankruptDialog />
      </div>
    </GameContext.Provider>
  );
}

const SEASON_ICONS: Record<string, string> = {
  spring: '🌸',
  summer: '☀️',
  autumn: '🍂',
  winter: '❄️',
};

const DEMAND_COLORS: Record<string, string> = {
  'Very High': '#e74c3c',
  'High': '#f39c12',
  'Normal': '#e0e0e0',
  'Low': '#3498db',
  'Very Low': '#9b59b6',
};

function TopBar() {
  const c = useController();
  const { state } = c;
  const season = getSeasonInfo(state.day);
  const speedLabel = c.running ? `${c.speed}x` : 'PAUSED';
  return (
    <div>
      <div class="headline">
        <span class={state.cash < 0 ? 'negative' : ''}>{formatMoney(state.cash)}</span>
        {'  |  '}{formatStars(state.starRating)}  {state.reviewScore.toFixed(1)}/10
        {'  |  '}Worth {formatMoneyShort(calculateValuation(state))}
        {'  |  '}{speedLabel}
      </div>
      <div class="subline" style={{ color: DEMAND_COLORS[season.demandLabel] ?? '#e0e0e0' }}>
        {season.dayOfWeek} Day {state.day} (Y{season.yearNumber})  |  {SEASON_ICONS[season.season]} {capitalize(season.season)}
        {'  |  '}{String(state.hour).padStart(2, '0')}:00  |  Demand: {season.demandLabel}
        {season.specialEvent ? `  🎉 ${season.specialEvent}` : ''}
      </div>
    </div>
  );
}

const PANEL_BUTTONS: Array<{ id: PanelId; label: string; group: 'Manage' | 'View' }> = [
  { id: 'staff', label: '🔧 Staff', group: 'Manage' },
  { id: 'housekeeping', label: '🧹 Cleaning', group: 'Manage' },
  { id: 'amenities', label: '🛏️ Amenities', group: 'Manage' },
  { id: 'marketing', label: '📣 Ads', group: 'Manage' },
  { id: 'finance', label: '📈 Finance', group: 'View' },
  { id: 'story', label: '📖 Story', group: 'View' },
];

function Toolbar() {
  const c = useController();
  const panelButton = (b: typeof PANEL_BUTTONS[number]) => (
    <button key={b.id} class={c.openPanel === b.id ? 'active' : ''} onClick={() => c.togglePanel(b.id)}>{b.label}</button>
  );
  return (
    <nav class="toolbar" aria-label="Game controls">
      <span class="group-label" style={{ color: '#6a8a6a' }}>Manage:</span>
      {PANEL_BUTTONS.filter(b => b.group === 'Manage').map(panelButton)}
      <span class="group-label" style={{ color: '#6a6a8a' }}>View:</span>
      {PANEL_BUTTONS.filter(b => b.group === 'View').map(panelButton)}
      <button class={c.noiseOverlay ? 'active' : ''} onClick={() => c.toggleNoiseOverlay()}>{'🔊'} Noise</button>
      <span class="group-label" style={{ color: '#8a6a6a' }}>Speed:</span>
      <button class={c.paused ? 'active' : ''} onClick={() => c.togglePause()} aria-label="Pause">{'⏸'}</button>
      {[1, 2, 5].map(speed => (
        <button key={speed} class={!c.paused && c.speed === speed ? 'active' : ''} onClick={() => c.setSpeed(speed)}>{speed}x</button>
      ))}
      <span class="spacer" />
      <button onClick={() => c.requestNewGame()}>New Game</button>
    </nav>
  );
}

function StatusBar() {
  const { state } = useController();
  const cleaning = state.rooms.filter(r => r.status === 'cleaning').length;
  const renovating = state.rooms.filter(r => r.status === 'renovating').length;
  const parts = [
    `Occupancy: ${Math.round(getOccupancyRate(state) * 100)}%`,
    `Rooms: ${state.rooms.length}`,
    `Guests: ${state.guests.reduce((sum, g) => sum + partySize(g), 0)}`,
    `Bookings turned away: ${state.totalTurnedAway}`,
  ];
  if (cleaning > 0) parts.push(`Cleaning: ${cleaning}`);
  if (renovating > 0) parts.push(`Renovating: ${renovating}`);
  if (state.loan.balance > 0) {
    parts.push(`Loan: ${formatMoney(Math.ceil(state.loan.balance))} (${formatMoney(state.loan.weeklyPayment)} due day ${getNextLoanPaymentDay(state.day)})`);
  }
  return <div class="statusbar">{parts.join('  |  ')}</div>;
}

const toCss = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

function Legend() {
  const c = useController();
  return (
    <div class="legend">
      <span><span class="swatch round" style={{ background: '#ecf0f1' }} />Guest</span>
      <span><span class="swatch" style={{ background: toCss(ACTOR_COLORS.frontDesk) }} />Front desk</span>
      <span><span class="swatch" style={{ background: toCss(ACTOR_COLORS.housekeeper) }} />Housekeeping</span>
      <span><span class="swatch" style={{ background: toCss(ACTOR_COLORS.maintenance) }} />Maintenance</span>
      {c.cleaningOverlay && (
        <span class="legend-group" role="group" aria-label="Cleaning overlay key">
          <span class="legend-title">Cleaning:</span>
          <CleaningLegend />
        </span>
      )}
    </div>
  );
}

function Toasts() {
  const c = useController();
  return (
    <div class="toasts" aria-live="polite">
      {c.toasts.toasts.map(t => <div key={t.id} class="toast" style={{ color: t.color }}>{t.message}</div>)}
    </div>
  );
}

function NoVacancySign() {
  const { state } = useController();
  const occupied = state.rooms.filter(r => r.status === 'occupied').length;
  if (state.rooms.length === 0 || occupied < state.rooms.length) return null;
  return <div class="no-vacancy">NO VACANCY</div>;
}

function ZeroRoomsPrompt() {
  const c = useController();
  if (c.state.rooms.length > 0 || c.tool) return null;
  return (
    <div class="card zero-rooms">
      <div class="lead">Select a room type to build {'→'}</div>
      <div class="dim small">then click a tile; keep its door (R to turn) on an open hallway</div>
    </div>
  );
}
