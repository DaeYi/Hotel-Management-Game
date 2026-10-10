import type { HotelState, GameEvent } from './types.js';
import { MARKETING } from '../config/balance.js';

/** Up-front cost of a campaign for this hotel's current size. */
export function getCampaignCost(state: HotelState, campaignId: string): number {
  const campaign = MARKETING.campaigns[campaignId];
  if (!campaign) return Infinity;
  return campaign.baseCost + campaign.perRoomCost * state.rooms.length;
}

/** Start a campaign. Fails if one is already running or the hotel can't pay. */
export function startCampaign(state: HotelState, campaignId: string): HotelState | null {
  const campaign = MARKETING.campaigns[campaignId];
  if (!campaign || state.activeCampaign) return null;
  const cost = getCampaignCost(state, campaignId);
  if (state.cash < cost) return null;

  return {
    ...state,
    cash: state.cash - cost,
    activeCampaign: { id: campaignId, hoursRemaining: campaign.durationDays * 24 },
  };
}

/** Arrivals multiplier from the running campaign (1.0 when none). */
export function getCampaignDemandMultiplier(state: HotelState): number {
  if (!state.activeCampaign) return 1.0;
  return MARKETING.campaigns[state.activeCampaign.id]?.demandBoost ?? 1.0;
}

/** Count the running campaign down by an hour, ending it at zero. */
export function tickCampaign(state: HotelState): { state: HotelState; events: GameEvent[] } {
  const active = state.activeCampaign;
  if (!active) return { state, events: [] };

  if (active.hoursRemaining > 1) {
    return { state: { ...state, activeCampaign: { ...active, hoursRemaining: active.hoursRemaining - 1 } }, events: [] };
  }
  const label = MARKETING.campaigns[active.id]?.label ?? 'Marketing campaign';
  return {
    state: { ...state, activeCampaign: null },
    events: [{ type: 'campaign_ended', message: `${label} campaign ended` }],
  };
}
