// The chat pane: one session, streamed updates rendered as they arrive, the
// agent's own config options and modes as selectors, and the permission
// prompt answered over the reverse channel. Same code for an ACP agent and
// for the embedded OpenRouter loop -- the sidecar hides which is which.
//
// A host carries one events stream, so the notification and request
// handlers here are registered through a small multiplexer (bus.ts) rather
// than replacing whatever the picker registered.

import { EngineError, type ConfigOption, type ConnectResult, type ModeState, type PermissionRequest, type SessionUpdate, type SidecarClient } from '../engine/client.js';
import type { Bus } from './bus.js';
import { decide } from './permission-policy.js';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export interface Chat {
  dispose(): Promise<void>;
  /**
   * Applies this pane's current model / effort / mode selections to another
   * session. The auditor and adjudicator run in fresh sessions, and a fresh
   * session gets the agent's defaults -- which is how an audit the user
   * started on Sonnet ran on Opus at default effort, silently, for minutes.
   * The choice a user made in the selectors should hold for the sessions the
   * method spins up on their behalf.
   */
  applyConfigTo(sessionId: string): Promise<void>;
}

export function mountChat(host: HTMLElement, sidecar: SidecarClient, bus: Bus, conn: ConnectResult, say: (t: string, e?: boolean) => void, courseDir: () => string | null): Chat {
  const session = conn.session!;
  let busy = false;
  let cost = 0;
  let configOptions = session.configOptions ?? [];
  let modes = session.modes;

  host.innerHTML = `
    <section class="chat-pane">
      <header class="bar"><span>${esc(conn.agent?.name ?? conn.provider)}</span><span class="grow"></span><div id="selectors" class="selectors"></div><span id="cost" class="muted"></span></header>
      <div id="messages" class="messages"></div>
      <div id="permission" class="permission hidden"></div>
      <form id="composer" class="composer"><textarea id="input" rows="3" placeholder="Ask the agent…"></textarea><button type="submit" id="send">Send</button><button type="button" id="stop" class="quiet hidden">Stop</button></form>
    </section>`;
  const messages = host.querySelector<HTMLDivElement>('#messages')!;
  const selectors = host.querySelector<HTMLDivElement>('#selectors')!;
  const permission = host.querySelector<HTMLDivElement>('#permission')!;
  const input = host.querySelector<HTMLTextAreaElement>('#input')!;
  const costEl = host.querySelector<HTMLSpanElement>('#cost')!;
  const stop = host.querySelector<HTMLButtonElement>('#stop')!;

  let current: HTMLElement | null = null;
  let currentKind = '';
  function append(kind: string, text: string, asBlock = false): void {
    if (!asBlock && current && currentKind === kind) {
      current.textContent += text;
    } else {
      current = document.createElement('div');
      current.className = `msg ${kind}`;
      current.textContent = text;
      messages.append(current);
      currentKind = kind;
    }
    messages.scrollTop = messages.scrollHeight;
  }

  function renderSelectors(): void {
    const parts: string[] = [];
    for (const o of configOptions) {
      if (o.type !== 'select' || !o.options) continue;
      // Claude's "agent" option lists the coding sub-agents installed on this
      // computer (claude-code-guide, plugin agents); none of them makes cards.
      if (/^agent$/i.test(o.id) || /^agent$/i.test(o.name)) continue;
      parts.push(`<label>${esc(o.name)} <select data-config="${o.id}">${o.options.map((x) => `<option value="${esc(x.value)}" ${x.value === o.currentValue ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`);
    }
    if (modes) {
      parts.push(`<label>Mode <select data-mode="1">${modes.availableModes.map((m) => `<option value="${esc(m.id)}" ${m.id === modes!.currentModeId ? 'selected' : ''} title="${esc(m.description ?? '')}">${esc(m.name)}</option>`).join('')}</select></label>`);
    }
    selectors.innerHTML = parts.join('');
  }
  renderSelectors();

  selectors.addEventListener('change', async (e) => {
    const sel = e.target as HTMLSelectElement;
    try {
      if (sel.dataset.config) {
        const r = await sidecar.setConfigOption(session.sessionId, sel.dataset.config, sel.value);
        configOptions = r.configOptions as ConfigOption[];
      } else if (sel.dataset.mode) {
        const r = await sidecar.setMode(session.sessionId, sel.value);
        modes = r.modes as ModeState;
      }
      renderSelectors();
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
  });

  function onUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        append('agent', (update.content as { text?: string })?.text ?? '');
        break;
      case 'agent_thought_chunk':
        append('thought', (update.content as { text?: string })?.text ?? '');
        break;
      case 'user_message_chunk':
        break;
      case 'tool_call':
        append('tool', `▸ ${String(update.title ?? update.toolCallId)}`, true);
        break;
      case 'tool_call_update': {
        const status = update.status ? ` — ${String(update.status)}` : '';
        const content = Array.isArray(update.content) ? (update.content as { content?: { text?: string } }[]).map((c) => c.content?.text ?? '').join('') : '';
        append('tool', `  ${String(update.title ?? '')}${status}${content ? `\n${content.slice(0, 400)}` : ''}`, true);
        break;
      }
      case 'usage_update': {
        const meta = update._meta as { cost?: number } | undefined;
        if (meta?.cost) cost += meta.cost;
        const used = typeof update.used === 'number' ? update.used : 0;
        costEl.textContent = `${used.toLocaleString()} tokens${cost ? ` · $${cost.toFixed(4)}` : ''}`;
        break;
      }
      case 'current_mode_update': {
        const id = (update.currentModeId ?? update.modeId) as string | undefined;
        if (modes && id) {
          modes.currentModeId = id;
          renderSelectors();
        }
        break;
      }
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) {
          configOptions = update.configOptions as ConfigOption[];
          renderSelectors();
        }
        break;
      case 'plan':
        append('tool', `plan: ${JSON.stringify(update.entries ?? update).slice(0, 300)}`, true);
        break;
      default:
        break;
    }
  }

  const offUpdate = bus.onNotification((method, params) => {
    if (method !== 'agent/update') return;
    const p = params as { sessionId: string; update: SessionUpdate };
    if (p.sessionId === session.sessionId) onUpdate(p.update);
  });

  const offRequest = bus.onRequest((req) => {
    if (req.method !== 'agent/requestPermission') return false;
    const r = req as unknown as PermissionRequest;
    if (r.params.sessionId !== session.sessionId) return false; // another pane's
    const auto = decide(r, courseDir());
    if (auto) {
      append('tool', `${String(r.params.toolCall.title ?? 'permission')} — ${auto.reason}`);
      void sidecar.answer(r.id, { outcome: { outcome: 'selected', optionId: auto.optionId } });
      return true;
    }
    const where = r.params.toolCall.locations?.map((l) => l.path).join(', ') ?? '';
    permission.classList.remove('hidden');
    permission.innerHTML = `<div class="ptitle">${esc(String(r.params.toolCall.title ?? 'The agent asks permission'))}</div>${where ? `<div class="muted">${esc(where)}</div>` : ''}
      <div class="pactions">${r.params.options.map((o) => `<button data-opt="${esc(o.optionId)}" class="${o.kind.startsWith('reject') ? 'quiet' : ''}">${esc(o.name)}</button>`).join('')}</div>`;
    permission.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-opt]');
      if (!b) return;
      permission.classList.add('hidden');
      permission.onclick = null;
      void sidecar.answer(r.id, { outcome: { outcome: 'selected', optionId: b.dataset.opt } });
    };
    return true;
  });

  host.querySelector<HTMLFormElement>('#composer')!.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    append('user', text, true);
    current = null;
    busy = true;
    stop.classList.remove('hidden');
    try {
      const r = await sidecar.prompt(session.sessionId, [{ type: 'text', text }]);
      if (r.stopReason !== 'end_turn') append('tool', `(stopped: ${r.stopReason})`, true);
    } catch (err) {
      append('tool', `error: ${err instanceof EngineError ? err.message : String(err)}`, true);
    } finally {
      busy = false;
      current = null;
      stop.classList.add('hidden');
    }
  };
  stop.onclick = () => void sidecar.cancel(session.sessionId);

  return {
    async dispose() {
      offUpdate();
      offRequest();
      await sidecar.disconnect(conn.connectionId).catch(() => undefined);
    },
    async applyConfigTo(sessionId) {
      for (const o of configOptions) {
        if (o.type !== 'select' || typeof o.currentValue !== 'string') continue;
        await sidecar.setConfigOption(sessionId, o.id, o.currentValue).catch(() => undefined);
      }
      if (modes?.currentModeId) await sidecar.setMode(sessionId, modes.currentModeId).catch(() => undefined);
    },
  };
}
