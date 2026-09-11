// The main pane before a course folder is chosen: one thing to do. The
// agent's session is opened in the folder, so there is nothing to run, and
// nothing to connect, until it is known -- which is why this is the whole
// screen and not one field among several.

export interface HomeOptions {
  /** A native folder dialog, where the shell has one; without it, a field to type the path in. */
  pickFolder?: () => Promise<string | null>;
  onFolder(dir: string): void;
  openSettings(): void;
}

export interface Home {
  /** Whether an agent is set up, which changes the note under the button. */
  setAgent(name: string | null): void;
  focus(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function mountHome(host: HTMLElement, opts: HomeOptions): Home {
  host.innerHTML = `
    <div class="home">
      <h2>Make a deck</h2>
      <p>Choose the folder with the lecture's files — slides as PDF, the transcript, the objectives. The steps run in that folder and everything they write goes beside the material, so a deck can be picked up where it was left.</p>
      ${
        opts.pickFolder
          ? `<div class="setup-row"><button type="button" id="h-pick" class="big">Choose the course folder…</button><span class="muted">or drop a folder anywhere on this window</span></div>`
          : `<div class="setup-row"><input id="h-path" placeholder="/path/to/lecture-3" autocomplete="off" spellcheck="false"><button type="button" id="h-use">Use this folder</button></div>`
      }
      <p class="muted" id="h-agent"></p>
      <ol class="home-steps">
        <li><strong>extract</strong> — the agent reads the material and writes every fact with its source</li>
        <li><strong>organize</strong> — the facts become a card plan</li>
        <li><strong>cards</strong> — the deck is written and checked</li>
        <li><strong>preview and audit</strong> — you flag cards; an independent reader rules on them</li>
        <li><strong>deliver</strong> — an .apkg beside your material, ready for Anki</li>
      </ol>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
  const pathInput = host.querySelector<HTMLInputElement>('#h-path');
  if (opts.pickFolder) {
    const pick = opts.pickFolder;
    $<HTMLButtonElement>('#h-pick').addEventListener('click', () => {
      void pick().then((dir) => {
        if (dir) opts.onFolder(dir);
      });
    });
  } else {
    const use = (): void => {
      const dir = pathInput!.value.trim();
      if (dir) opts.onFolder(dir);
    };
    $<HTMLButtonElement>('#h-use').addEventListener('click', use);
    pathInput!.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') use();
    });
  }
  const agentLine = $<HTMLElement>('#h-agent');
  agentLine.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) opts.openSettings();
  });
  return {
    setAgent(name) {
      agentLine.innerHTML = name
        ? `Agent: ${esc(name)} — it connects when the folder is chosen. <button type="button" class="link">Change in Settings</button>`
        : `No agent set up yet. <button type="button" class="link">Choose one in Settings</button> — it can also wait until the first step.`;
    },
    focus() {
      pathInput?.focus();
    },
  };
}
