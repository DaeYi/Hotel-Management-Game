import { MARKETING } from '../../config/balance';
import { getCampaignCost } from '../../simulation/MarketingManager';
import { getExpectedArrivalsPerDay } from '../../simulation/GuestManager';
import { getAverageOccupancy } from '../../simulation/ObjectivesManager';
import { useController } from '../context';
import { formatMoney } from '../format';
import { PanelCard } from './PanelCard';

export function MarketingPanel() {
  const c = useController();
  const { state } = c;
  const active = state.activeCampaign;

  return (
    <PanelCard title="MARKETING">
      <div class="body small">
        {active ? `Running: ${MARKETING.campaigns[active.id]?.label} (${Math.ceil(active.hoursRemaining / 24)}d left)` : 'No campaign running'}
      </div>
      <div class="dim tiny">Expected guests: {getExpectedArrivalsPerDay(state).toFixed(1)}/day</div>
      <div class="dim tiny">7-day occupancy: {Math.round(getAverageOccupancy(state, 7) * 100)}%</div>
      <hr class="divider" />
      {Object.entries(MARKETING.campaigns).map(([id, campaign]) => {
        const cost = getCampaignCost(state, id);
        return (
          <div key={id} class="row spread" style={{ marginBottom: '10px' }}>
            <div>
              <div class="small">{campaign.label}  {formatMoney(cost)}</div>
              <div class="dim tiny">+{Math.round((campaign.demandBoost - 1) * 100)}% guests for {campaign.durationDays} days</div>
            </div>
            <button class="primary" disabled={!!active || state.cash < cost} onClick={() => c.startCampaign(id)}>
              {active?.id === id ? 'Running' : 'Launch'}
            </button>
          </div>
        );
      })}
    </PanelCard>
  );
}
