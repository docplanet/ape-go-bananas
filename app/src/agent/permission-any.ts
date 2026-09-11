// A permission prompt for sessions no chat pane owns.
//
// The chat pane answers agent/requestPermission only for its own session,
// which is right: two panes must not answer each other's prompts. But the
// method's run-sheet deliberately runs the auditor and the adjudicator in
// FRESH sessions that wrote none of the cards, and those have no pane. Their
// requests -- "write audit.md", "write verdicts.md" -- reached the bus with
// nobody to take them, and the bus refused them, so the auditor could be
// denied the one write the stage exists for. (The desktop placeholder had
// the same filter and no fallback.)
//
// This is the fallback: a prompt for any session that nothing else claimed,
// registered at low priority so a chat pane's own handler still wins.

import type { PermissionRequest, SidecarClient } from '../engine/client.js';
import type { Bus } from './bus.js';
import { decide } from './permission-policy.js';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function mountFallbackPermissions(host: HTMLElement, sidecar: SidecarClient, bus: Bus, courseDir: () => string | null): () => void {
  const box = document.createElement('div');
  box.className = 'permission';
  box.hidden = true;
  host.prepend(box);

  return bus.onRequest(
    (req) => {
      if (req.method !== 'agent/requestPermission') return false;
      const r = req as unknown as PermissionRequest;
      const auto = decide(r, courseDir());
      if (auto) {
        void sidecar.answer(r.id, { outcome: { outcome: 'selected', optionId: auto.optionId } });
        return true;
      }
      const where = r.params.toolCall.locations?.map((l) => l.path).join(', ') ?? '';
      box.hidden = false;
      box.innerHTML = `<div class="ptitle">${esc(String(r.params.toolCall.title ?? 'The agent asks permission'))} <small class="muted">(${esc(r.params.sessionId.slice(0, 8))}… — a review session)</small></div>${where ? `<div class="muted">${esc(where)}</div>` : ''}
        <div class="pactions">${r.params.options.map((o) => `<button data-opt="${esc(o.optionId)}" class="${o.kind.startsWith('reject') ? 'quiet' : ''}">${esc(o.name)}</button>`).join('')}</div>`;
      box.onclick = (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-opt]');
        if (!b) return;
        box.hidden = true;
        box.onclick = null;
        void sidecar.answer(r.id, { outcome: { outcome: 'selected', optionId: b.dataset.opt } });
      };
      return true;
    },
    { fallback: true },
  );
}
