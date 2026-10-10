import type { ComponentChildren } from 'preact';
import { useController } from '../context';

/** Shared frame for the floating panels: title, close button, scrollable body. */
export function PanelCard({ title, children }: { title: string; children: ComponentChildren }) {
  const c = useController();
  return (
    <section class="card floating-panel" aria-label={title}>
      <div class="card-title">
        {title}
        <button class="close" onClick={() => c.closePanel()} aria-label="Close">{'✕'}</button>
      </div>
      {children}
    </section>
  );
}
