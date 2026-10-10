import type { StoryLogEntry } from '../../simulation/types';
import { groupByChain } from '../../simulation/StoryGenerator';
import { useController } from '../context';
import { PanelCard } from './PanelCard';

const MAX_CHAINS = 8;

function timestamp(entry: { day: number; hour: number }): string {
  const period = entry.hour < 12 ? 'am' : 'pm';
  const hour = entry.hour % 12 === 0 ? 12 : entry.hour % 12;
  return `Day ${entry.day}, ${hour}${period}`;
}

/** Recent incidents as threads: each chain's origin, then what happened next. */
export function StoryLogPanel() {
  const { state } = useController();
  const chains = groupByChain(state.storyLog).slice(0, MAX_CHAINS); // newest first

  return (
    <PanelCard title="STORY LOG">
      {chains.length === 0 && (
        <div class="dim small">Nothing's happened yet -- check back once guests settle in.</div>
      )}
      {chains.map(chain => {
        const [origin, ...rest]: StoryLogEntry[] = chain.entries;
        return (
          <div key={chain.chainId} class="body small" style={{ marginBottom: '10px' }}>
            <div class="dim tiny">{timestamp(origin)}</div>
            <div>{origin.message}</div>
            {rest.map(entry => (
              <div key={entry.id} class="tiny" style={{ marginLeft: '10px' }}>{'>'} {timestamp(entry)} - {entry.message}</div>
            ))}
          </div>
        );
      })}
    </PanelCard>
  );
}
