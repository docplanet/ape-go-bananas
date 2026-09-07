// The chat pane: one session, streamed updates rendered as they arrive, the
// agent's own config options and modes as selectors, and the permission
// prompt answered over the reverse channel. Same code for an ACP agent and
// for the embedded OpenRouter loop -- the sidecar hides which is which.
import { sidecar, SidecarError, type ConfigOption, type ConnectResult, type ModeState, type PermissionRequest, type SessionUpdate } from './sidecar';

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function mountChat(host: HTMLElement, conn: ConnectResult, say: (t: string, e?: boolean) => void) {
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
  function append(kind: string, text: string, asBlock = false) {
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

  function renderSelectors() {
    const parts: string[] = [];
    for (const o of configOptions) {
      if (o.type !== 'select' || !o.options) continue;
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
      say(err instanceof SidecarError ? err.message : String(err), true);
    }
  });

  function onUpdate(update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        append('agent', ((update.content as { text?: string })?.text) ?? '');
        break;
      case 'agent_thought_chunk':
        append('thought', ((update.content as { text?: string })?.text) ?? '');
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

  const unlisten = sidecar.onNotification((method, params) => {
    if (method !== 'agent/update') return;
    const p = params as { sessionId: string; update: SessionUpdate };
    if (p.sessionId === session.sessionId) onUpdate(p.update);
  });

  const unlistenReq = sidecar.onRequest((req) => {
    if (req.method !== 'agent/requestPermission') {
      void sidecar.refuse(req.id, `unknown request ${req.method}`);
      return;
    }
    const r = req as PermissionRequest;
    if (r.params.sessionId !== session.sessionId) return; // another pane's
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
      append('tool', `error: ${err instanceof SidecarError ? err.message : String(err)}`, true);
    } finally {
      busy = false;
      current = null;
      stop.classList.add('hidden');
    }
  };
  stop.onclick = () => void sidecar.cancel(session.sessionId);

  return {
    async dispose() {
      (await unlisten)();
      (await unlistenReq)();
      await sidecar.disconnect(conn.connectionId).catch(() => undefined);
    },
  };
}
