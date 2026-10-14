import type { DailyStat, OnSiteTakings } from '../../simulation/types';
import { SPENDING } from '../../config/balance';
import { spendingOn } from '../../simulation/Spending';
import { calculateValuation, getRecentRevenue } from '../../simulation/ObjectivesManager';
import { useController } from '../context';
import { formatMoney, formatMoneyShort } from '../format';
import { PanelCard } from './PanelCard';

const DAYS = 30;
const W = 290;
const H = 140;
const PAD = { left: 30, right: 18, top: 10, bottom: 14 };

/** Revenue earned each day, from the cumulative end-of-day snapshots (the first day has no prior snapshot). */
function dailyRevenue(stats: DailyStat[]): number[] {
  return stats.slice(1).map((s, i) => s.totalRevenue - stats[i].totalRevenue);
}

/**
 * The shop and restaurant takings over the last 30 days, from the cumulative
 * end-of-day snapshots (from zero where there's none that far back: a save
 * from before spending styles), and the room bills the rest of the revenue.
 */
function recentOnSite(stats: DailyStat[], now: OnSiteTakings | undefined, revenue: number) {
  if (!now) return null;
  const before = (stats.length > DAYS ? stats[stats.length - DAYS - 1].onSite : undefined) ?? { shop: 0, restaurant: 0, splurgers: 0 };
  const shop = now.shop - before.shop;
  const restaurant = now.restaurant - before.restaurant;
  const total = shop + restaurant;
  return { shop, restaurant, total, splurgers: now.splurgers - before.splurgers, rooms: SPENDING.onSiteIsRevenue ? revenue - total : revenue };
}

/** Polyline points for values scaled into the plot area, right-aligned to the last DAYS days. */
function points(values: number[], max: number): string {
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = plotW / (DAYS - 1);
  const offset = DAYS - values.length;
  return values.map((v, i) => `${PAD.left + (offset + i) * step},${PAD.top + plotH - (v / max) * plotH}`).join(' ');
}

export function FinancePanel() {
  const { state } = useController();
  const recent = state.dailyStats.slice(-(DAYS + 1));
  const revenue = dailyRevenue(recent).slice(-DAYS);
  const reviews = recent.slice(-revenue.length).map(s => s.reviewScore).filter((r): r is number => r !== undefined);
  const maxRevenue = Math.max(1, ...revenue);
  const plotH = H - PAD.top - PAD.bottom;
  // (before the first day is recorded, the revenue so far: on-site takings can come in on the first day)
  const month = state.dailyStats.length === 0 ? state.totalRevenue : getRecentRevenue(state, 30);
  const onSite = spendingOn() ? recentOnSite(state.dailyStats, state.onSite, month) : null;

  return (
    <PanelCard title="FINANCE: LAST 30 DAYS">
      {revenue.length < 2 ? (
        <div class="faint small" style={{ textAlign: 'center', padding: '30px 0' }}>No data yet. Let a few days pass...</div>
      ) : (
        <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily revenue and review score">
          {[0, 1, 2, 3, 4].map(i => (
            <line key={i} class="grid-line" x1={PAD.left} x2={W - PAD.right} y1={PAD.top + (plotH * i) / 4} y2={PAD.top + (plotH * i) / 4} />
          ))}
          <polyline class="revenue" points={points(revenue, maxRevenue)} />
          {reviews.length >= 2 && <polyline class="reviews" points={points(reviews, 10)} />}
          <text x={2} y={PAD.top + 8} fill="var(--good)">{formatMoneyShort(maxRevenue)}</text>
          <text x={W - PAD.right + 4} y={PAD.top + 8} fill="var(--gold)">10</text>
        </svg>
      )}
      <div class="row tiny" style={{ gap: '14px', marginTop: '4px' }}>
        <span class="good">{'—'} Revenue/day</span>
        <span class="gold">{'—'} Review score</span>
      </div>
      <hr class="divider" />
      <div class="body small">
        Revenue, last 30 days: {formatMoney(month)}
        {onSite && (SPENDING.onSiteIsRevenue ? ` (rooms ${formatMoney(onSite.rooms)}, on site ${formatMoney(onSite.total)})` : ` (rooms; on site ${formatMoney(onSite.total)} more)`)}
      </div>
      {onSite && onSite.total > 0 && (
        <div class="body small" aria-label="On-site takings">
          On site: {[onSite.restaurant > 0 ? `restaurant ${formatMoney(onSite.restaurant)}` : '', onSite.shop > 0 ? `shop ${formatMoney(onSite.shop)}` : ''].filter(Boolean).join(', ')}
          {' \u00b7 '}{Math.round(onSite.splurgers / onSite.total * 100)}% from big spenders
        </div>
      )}
      <div class="body small">Total revenue: {formatMoney(state.totalRevenue)}</div>
      <div class="body small">Hotel worth: {formatMoneyShort(calculateValuation(state))}</div>
    </PanelCard>
  );
}
