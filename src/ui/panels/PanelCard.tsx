import type { ComponentChildren } from 'preact';
import { useController } from '../context';

/**
 * Shared frame for the floating panels: title, minimize and close buttons,
 * scrollable body. Minimized, a panel is just its title bar (with `summary`
 * beside it), so the floor plan under it shows -- the housekeeping panel's
 * overlay, say -- while the panel stays open.
 */
export function PanelCard({ title, summary, children }: { title: string; summary?: string; children: ComponentChildren }) {
  const c = useController();
  const collapsed = c.panelCollapsed;
  return (
    <section class={`card floating-panel${collapsed ? ' collapsed' : ''}`} aria-label={title}>
      <div class="card-title">
        <span>
          {title}
          {collapsed && summary && <span class="panel-summary">{summary}</span>}
        </span>
        <span class="card-buttons">
          <button class="close" onClick={() => c.toggleCollapsed()} aria-label={collapsed ? 'Expand' : 'Minimize'} aria-expanded={!collapsed}>
            {collapsed ? '+' : '−'}
          </button>
          <button class="close" onClick={() => c.closePanel()} aria-label="Close">{'✕'}</button>
        </span>
      </div>
      {!collapsed && children}
    </section>
  );
}
