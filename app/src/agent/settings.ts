// Settings: the agent, and the app's own facts. The agent is a setting, not
// a step -- chosen once, remembered, and connected on its own whenever a
// course folder is chosen. picker.ts renders into the agent slot.

import type { EngineHost } from '../engine/client.js';
import { mountSignIn } from './signin.js';

export interface SettingsOptions {
  onDone(): void;
  say(text: string, isError?: boolean): void;
}

export interface Settings {
  readonly agentSlot: HTMLElement;
  /** Facts that arrive after mount: where the method files are. */
  setMethodDir(dir: string | null): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function mountSettings(host: HTMLElement, engine: EngineHost, opts: SettingsOptions): Settings {
  host.innerHTML = `
    <header class="bar"><h2>Settings</h2><span class="grow"></span><button type="button" id="set-done">Done</button></header>
    <section class="set-section">
      <h3>Agent</h3>
      <p class="hint">The agent does the reading and writing, on a subscription you already pay for. It runs on this computer, in the course folder, and is connected on its own each time a folder is chosen.</p>
      <div id="set-agent"></div>
      <div id="set-signin"></div>
    </section>
    <section class="set-section">
      <h3>This app</h3>
      <dl class="facts">
        <dt>Engine</dt><dd>${esc(engine.info.engine)} ${esc(engine.info.version)} on Node ${esc(engine.info.node)}, over ${esc(engine.info.transport)}</dd>
        <dt>Agents are installed in</dt><dd class="path">${esc(engine.dataDir())}</dd>
        <dt>Method files</dt><dd class="path" id="set-method">…</dd>
      </dl>
      <p class="hint">Nothing leaves this computer except what the agent sends to its own service. Artifacts live beside your material; the app keeps no copy.</p>
    </section>`;
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
  $<HTMLButtonElement>('#set-done').addEventListener('click', () => opts.onDone());

  // Signing in is the CLI's own flow, so a host that runs it offers it as a
  // console rather than a form (signin.ts). Neither current host does.
  if (engine.signIn) {
    const slot = $<HTMLElement>('#set-signin');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = 'Sign in to Claude';
    button.addEventListener('click', () => {
      button.disabled = true;
      mountSignIn(slot, engine, opts.say, () => {
        button.disabled = false;
      });
    });
    slot.append(button);
  }

  return {
    agentSlot: $<HTMLElement>('#set-agent'),
    setMethodDir(dir) {
      $<HTMLElement>('#set-method').textContent = dir ?? '(not found — the steps cannot run)';
    },
  };
}
