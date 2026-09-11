// The provider picker: every agent the public registry knows, installable
// in place, plus the API-key slot. Sign-in runs the vendor's own flow from a
// button -- the sidecar spawns it on the user's machine and a browser opens
// for the OAuth step (docs/research/claude-adapter-auth.md §4).
//
// An API key entered here goes to agent/connect and to the store the shell
// provides: the OS keychain in the desktop app, sessionStorage on the tool
// page (this tab, until it closes). Nothing else sees it.

import { EngineError, type ConnectResult, type Provider, type SidecarClient } from '../engine/client.js';
import type { Bus } from './bus.js';

export interface PickerCallbacks {
  onConnected(result: ConnectResult): void;
  say(text: string, isError?: boolean): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Where an API key lives between sessions. Names are provider ids. */
export interface KeyStore {
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
}

export function mountPicker(host: HTMLElement, sidecar: SidecarClient, bus: Bus, dataDir: string, courseDir: () => string | null, keys: KeyStore, cb: PickerCallbacks): void {
  let providers: Provider[] = [];
  let pending: ConnectResult | null = null; // a connection waiting on sign-in
  const progress = new Map<string, string[]>();

  host.innerHTML = `
    <section class="picker">
      <header class="bar"><h2>Choose an agent</h2><span class="grow"></span><button id="refresh">Refresh list</button></header>
      <p class="hint">Subscription agents install on this computer and sign in through your browser. Or use any model with an OpenRouter key.</p>
      <ul class="providers" id="providers"></ul>
      <div id="auth" class="auth hidden"></div>
      <pre id="log" class="log hidden"></pre>
    </section>`;
  const list = host.querySelector<HTMLUListElement>('#providers')!;
  const auth = host.querySelector<HTMLDivElement>('#auth')!;
  const log = host.querySelector<HTMLPreElement>('#log')!;

  function render(): void {
    list.innerHTML = providers
      .map((p) => {
        const state = p.kind === 'api' ? 'API key' : p.installed ? `installed ${p.installedVersion}` : p.installable ? `v${p.version ?? '?'}` : `${p.distribution} (not installable yet)`;
        const actions =
          p.kind === 'api'
            ? `<input type="password" placeholder="sk-or-…" data-key="${p.id}" autocomplete="off"><button data-connect="${p.id}">Connect</button>`
            : p.installed
              ? `<button data-connect="${p.id}">Connect</button><button data-uninstall="${p.id}" class="quiet">Remove</button>`
              : p.installable
                ? `<button data-install="${p.id}">Install</button>`
                : '';
        const lines = progress.get(p.id);
        return `<li data-id="${p.id}"><div class="pname">${esc(p.name)} <small>${esc(state)}</small></div><div class="pdesc">${esc(p.description)}</div><div class="pactions">${actions}</div>${lines ? `<pre class="plog">${esc(lines.slice(-6).join('\n'))}</pre>` : ''}</li>`;
      })
      .join('');
    for (const input of list.querySelectorAll<HTMLInputElement>('input[data-key]')) {
      void keys.get(input.dataset.key!).then(
        (v) => {
          if (v && !input.value) input.value = v;
        },
        () => undefined,
      );
    }
  }

  async function load(refresh = false): Promise<void> {
    try {
      const res = await sidecar.listProviders(dataDir, refresh);
      providers = res.providers;
      if (res.registry.error) cb.say(`registry: ${res.registry.error}`, true);
      render();
    } catch (err) {
      cb.say(String(err), true);
    }
  }

  function showAuth(result: ConnectResult): void {
    pending = result;
    auth.classList.remove('hidden');
    const status = result.authStatus ? `${result.authStatus.label}` : 'Sign-in needed';
    auth.innerHTML = `<div class="pname">${esc(result.agent?.name ?? result.provider)} · ${esc(status)}</div>
      <div class="pactions">${result.authMethods.map((m) => `<button data-login="${m.id}" title="${esc(m.description ?? '')}">${esc(m.name)}</button>`).join('')}
      <button data-skip="1" class="quiet">Continue anyway</button></div>`;
  }

  async function connect(id: string): Promise<void> {
    const cwd = courseDir();
    if (!cwd) {
      cb.say('choose a course folder first', true);
      return;
    }
    const params: { provider: string; dataDir: string; cwd: string; apiKey?: string } = { provider: id, dataDir, cwd };
    const p = providers.find((x) => x.id === id);
    if (p?.kind === 'api') {
      const input = list.querySelector<HTMLInputElement>(`input[data-key="${id}"]`);
      const key = input?.value.trim() ?? '';
      if (!key) {
        cb.say('enter an API key', true);
        return;
      }
      params.apiKey = key;
      await keys.set(id, key).catch(() => undefined);
    }
    cb.say(`connecting to ${id}…`);
    try {
      const result = await sidecar.connect(params);
      if (result.authRequired || (result.authStatus?.kind === 'none' && result.authMethods.length > 0)) {
        showAuth(result);
        cb.say(result.authStatus?.label ?? 'sign-in needed');
        return;
      }
      cb.onConnected(result);
    } catch (err) {
      cb.say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  host.addEventListener('click', async (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.id === 'refresh') return void load(true);
    const { install, uninstall, connect: conn, login, skip } = t.dataset;
    if (install) {
      progress.set(install, ['installing…']);
      render();
      try {
        const r = await sidecar.installProvider(dataDir, install);
        cb.say(`installed ${r.package} ${r.version}`);
      } catch (err) {
        cb.say(err instanceof EngineError ? err.message : String(err), true);
      }
      progress.delete(install);
      await load();
    } else if (uninstall) {
      await sidecar.uninstallProvider(dataDir, uninstall).catch(() => undefined);
      await load();
    } else if (conn) {
      await connect(conn);
    } else if (login && pending) {
      log.classList.remove('hidden');
      log.textContent = '';
      cb.say('signing in — finish in the browser tab that opens…');
      try {
        const r = await sidecar.login(pending.connectionId, login);
        if (r.authenticated && r.session) {
          cb.say('signed in');
          auth.classList.add('hidden');
          cb.onConnected({ ...pending, ...r, session: r.session, authRequired: false } as ConnectResult);
        } else {
          cb.say(`sign-in did not complete (exit ${r.exitCode})`, true);
        }
      } catch (err) {
        cb.say(err instanceof EngineError ? err.message : String(err), true);
      }
    } else if (skip && pending?.session) {
      cb.onConnected(pending);
    }
  });

  // Through the bus, never the client directly: the transport holds ONE
  // notification handler, so registering here would silently replace the
  // chat pane's and the stage runner's -- which is exactly what happened in
  // the first live run (a stage completed with an empty chat).
  bus.onNotification((method, params) => {
    if (method === 'agents/progress') {
      const p = params as { id: string; line: string };
      const lines = progress.get(p.id) ?? [];
      lines.push(p.line);
      progress.set(p.id, lines);
      render();
    } else if (method === 'agent/loginOutput') {
      const p = params as { line: string };
      log.textContent += `${p.line}\n`;
      log.scrollTop = log.scrollHeight;
    }
  });

  void load();
}
