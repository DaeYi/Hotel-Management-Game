import { useController } from '../context';
import { StaffPanel } from './StaffPanel';
import { HousekeepingPanel } from './HousekeepingPanel';
import { AmenitiesPanel } from './AmenitiesPanel';
import { MarketingPanel } from './MarketingPanel';
import { GoalsPanel } from './GoalsPanel';
import { StoryLogPanel } from './StoryLogPanel';
import { FinancePanel } from './FinancePanel';

/** Whichever management/view panel is open (one at a time), floating over the world. */
export function PanelHost() {
  const { openPanel } = useController();
  switch (openPanel) {
    case 'staff': return <StaffPanel />;
    case 'housekeeping': return <HousekeepingPanel />;
    case 'amenities': return <AmenitiesPanel />;
    case 'marketing': return <MarketingPanel />;
    case 'goals': return <GoalsPanel />;
    case 'story': return <StoryLogPanel />;
    case 'finance': return <FinancePanel />;
    default: return null;
  }
}
