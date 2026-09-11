// The agent shell: the rail on the left (course folder, deck name, the eight
// stages, the two views), and the agent view (picker, then chat, with a gate
// above for artifacts). It is docs/APP.md's one-window shape, and it is the
// same code in the desktop app and on the tool page when `ape-bridge` opens
// it -- the host (engine/host.ts) is what differs.
//
// The deck view is injected, because that is the one thing the two shells
// do differently: the desktop app loads, checks, renders and exports through
// the sidecar's deck/* methods on the Node engine; the tool page does all of
// that in the tab on the engine it already carries, and the bridge only
// supplies deck.json's text and the image bytes beside it.

import { EngineError, makeSidecarClient, type ConnectResult, type EngineHost, type SidecarClient } from '../engine/client.js';
import { makeBus } from './bus.js';
import { mountChat, type Chat } from './chat.js';
import { extractMaterials } from './extract.js';
import { mountFallbackPermissions } from './permission-any.js';
import { mountPicker, type KeyStore } from './picker.js';
import { mountSignIn } from './signin.js';
import { mountStages, type Stages } from './stages.js';

/** The deck half of the window: everything from "deck.json is there" to the .apkg. */
export interface DeckView {
  /** Shows or hides the deck panes; when hidden, the agent view has the window. */
  show(visible: boolean): void;
  /** Loads `<courseDir>/deck.json`: the checks, the card preview, the owner's flags. Reports its own failures. */
  open(courseDir: string): Promise<void>;
  /** Exports `<courseDir>/deck.json` as an .apkg, loading it first if nothing is open. Reports its own failures. */
  export(courseDir: string): Promise<void>;
}

export interface AgentAppOptions {
  rail: HTMLElement;
  /** The agent view's container: the gate and the picker/chat are built inside it. */
  view: HTMLElement;
  deck: DeckView;
  /** Where an API key entered in the picker is kept: the OS keychain on the desktop, the tab on the site. */
  keys: KeyStore;
  /**
   * A native folder dialog, where the shell has one. With it the rail shows
   * the chosen path and a button; without it, a field to type the path in.
   */
  pickFolder?: () => Promise<string | null>;
}

export interface AgentApp {
  courseDir(): string | null;
  setCourseDir(dir: string): void;
  /** Loads `<dir>/deck.json` into the deck view and shows it. */
  openDeck(dir: string): Promise<void>;
  /** The one status line, for the shell's own messages too (a dropped file, an update). */
  say(text: string, isError?: boolean): void;
  dispose(): Promise<void>;
}

export function mountAgentApp(host: EngineHost, opts: AgentAppOptions): AgentApp {
  const { rail, view, deck } = opts;
  rail.innerHTML = `
    <h1>A.P.E.</h1>
    <div class="course">
      <label class="muted" for="coursedir">Course folder</label>
      ${
        opts.pickFolder
          ? `<div class="pathrow"><div id="coursedir" class="path" title="">none</div><button type="button" id="pickdir" class="quiet">Choose…</button></div>`
          : `<input id="coursedir" placeholder="/path/to/lecture-3" autocomplete="off" spellcheck="false">`
      }
      <label class="muted" for="deckname-in">Deck name</label>
      <input id="deckname-in" placeholder="Course::Lecture 3" autocomplete="off">
    </div>
    <div class="railhead">Steps <span class="muted">— click one to run</span></div>
    <ol class="stages" id="stages"></ol>
    <div class="railhead">View</div>
    <nav class="views">
      <button type="button" data-view="agent" title="The agent: the picker, and the chat">Agent</button>
      <button type="button" data-view="deck" title="The deck: every card, the checks and your flags — after stage 5">Deck</button>
    </nav>
    <div class="status" id="status"></div>`;
  view.innerHTML = `<section class="gate" hidden></section><section class="agent-host"></section>`;
  const $ = <T extends HTMLElement>(root: HTMLElement, sel: string): T => root.querySelector<T>(sel)!;
  const status = $<HTMLElement>(rail, '#status');
  const say = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle('error', isError);
  };
  const gate = $<HTMLElement>(view, '.gate');
  const agentHost = $<HTMLElement>(view, '.agent-host');

  // ---- the engine, wherever it is running -------------------------------------
  const sidecar: SidecarClient = makeSidecarClient(host);
  say(`engine ${host.info.version} on node ${host.info.node}`);
  const bus = makeBus(sidecar);

  // ---- views -----------------------------------------------------------------
  const showView = (name: 'agent' | 'deck'): void => {
    view.hidden = name !== 'agent';
    deck.show(name === 'deck');
  };
  $<HTMLElement>(rail, '.views').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
    if (b) showView(b.dataset.view as 'agent' | 'deck');
  });

  // ---- course folder + deck name --------------------------------------------
  const deckNameInput = $<HTMLInputElement>(rail, '#deckname-in');
  let courseDir: string | null = host.courseRoot();
  const courseChanged = (): void => {
    stages.setConnection(connection);
    void stages.refreshMarks();
  };
  let showCourseDir: (dir: string | null) => void;
  if (opts.pickFolder) {
    const path = $<HTMLElement>(rail, '#coursedir');
    showCourseDir = (dir) => {
      path.textContent = dir ?? 'none';
      path.title = dir ?? '';
    };
    const pick = opts.pickFolder;
    $<HTMLButtonElement>(rail, '#pickdir').addEventListener('click', () => {
      void pick().then((dir) => {
        if (dir) setCourseDir(dir);
      });
    });
  } else {
    const input = $<HTMLInputElement>(rail, '#coursedir');
    showCourseDir = (dir) => {
      input.value = dir ?? '';
    };
    input.addEventListener('change', () => {
      courseDir = input.value.trim() || null;
      courseChanged();
    });
  }
  function setCourseDir(dir: string): void {
    courseDir = dir;
    showCourseDir(dir);
    courseChanged();
  }
  showCourseDir(courseDir);

  // Prompts for sessions no chat pane owns -- the auditor's and the
  // adjudicator's. Without this their write permissions went unanswered.
  mountFallbackPermissions(view, sidecar, bus, () => courseDir);

  // ---- stages + agent --------------------------------------------------------
  let connection: ConnectResult | null = null;
  let chat: Chat | null = null;
  // The runner gets a client whose newSession carries the chat pane's
  // selections over: the method's fresh auditor/adjudicator sessions must use
  // the model and mode the user picked, not the agent's defaults.
  const runnerClient: SidecarClient = {
    ...sidecar,
    newSession: async (connectionId: string) => {
      const r = await sidecar.newSession(connectionId);
      await chat?.applyConfigTo(r.session.sessionId);
      return r;
    },
  };
  const openDeck = async (dir: string): Promise<void> => {
    showView('deck');
    await deck.open(dir);
  };
  const stages: Stages = mountStages($<HTMLOListElement>(rail, '#stages'), gate, {
    sidecar: runnerClient,
    courseDir: () => courseDir,
    deckName: () => deckNameInput.value.trim(),
    say,
    showView,
    openDeck,
    exportDeck: async () => {
      if (courseDir) await deck.export(courseDir);
    },
    prepareMaterials: async (dir) => {
      await extractMaterials(sidecar, host, dir, say);
    },
  });

  let signInButton: HTMLButtonElement | null = null;
  function showPicker(): void {
    chat = null;
    connection = null;
    stages.setConnection(null);
    if (signInButton) signInButton.hidden = false;
    mountPicker(agentHost, sidecar, bus, host.dataDir(), () => courseDir, opts.keys, {
      say,
      onConnected(result) {
        if (!result.session || !courseDir) {
          say('connected but no session', true);
          return;
        }
        connection = result;
        chat = mountChat(agentHost, sidecar, bus, result, say, () => courseDir);
        stages.setConnection(result);
        // Signed in and connected: the sign-in button is now a confusing
        // second door, so it goes until the picker comes back.
        if (signInButton) signInButton.hidden = true;
        say(`${result.agent?.name ?? result.provider} ready — click 1 extract on the left to start`);
        void stages.refreshMarks();
      },
    });
  }

  // Signing in is the CLI's own flow, so a host that runs it offers it as a
  // console rather than a form (signin.ts).
  if (host.signIn) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost signin-open';
    button.textContent = 'Sign in to Claude';
    button.addEventListener('click', () => {
      button.disabled = true;
      mountSignIn(view, host, say, () => {
        button.disabled = false;
      });
    });
    $<HTMLElement>(rail, '.views').after(button);
    signInButton = button;
  }

  showView('agent');
  showPicker();
  void stages.refreshMarks();
  const dispose = async (): Promise<void> => {
    await chat?.dispose();
    host.close();
  };
  window.addEventListener('beforeunload', () => void dispose());

  return {
    courseDir: () => courseDir,
    setCourseDir,
    openDeck,
    say,
    dispose,
  };
}

export { EngineError };
