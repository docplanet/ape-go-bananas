// The shell: docs/APP.md's one window. The rail on the left holds the course
// folder, the deck name, the eight steps and Settings; the main pane is card
// generation -- the bar that says what is next, the artifact gate, the
// agent's live output, the deck preview at step 6 -- and, before a folder
// is chosen, the one prompt to choose it. The agent is a setting: chosen
// once in Settings, remembered, connected on its own whenever a folder is
// chosen, because its session is opened in that folder.
//
// It is the same code in the desktop app and on the tool page when
// `ape-bridge` opens it -- the host (engine/host.ts) is what differs. The
// deck view is injected, because that is the one thing the two shells do
// differently: the desktop app loads, checks, renders and exports through
// the sidecar's deck/* methods on the Node engine; the tool page does all
// of that in the tab on the engine it already carries.

import { EngineError, makeSidecarClient, type ConnectResult, type EngineHost, type SidecarClient } from '../engine/client.js';
import { makeBus } from './bus.js';
import { mountChat, type Chat } from './chat.js';
import { extractMaterials } from './extract.js';
import { mountHome, type Home } from './home.js';
import { mountFallbackPermissions } from './permission-any.js';
import { mountPicker, type KeyStore, type Picker } from './picker.js';
import { mountSettings, type Settings } from './settings.js';
import { mountStages, type Stages } from './stages.js';

/** The deck half of the window: everything from "deck.json is there" to the .apkg. */
export interface DeckView {
  /** Shows or hides the deck panes; when hidden, the agent pane has the main area. */
  show(visible: boolean): void;
  /** Loads `<courseDir>/deck.json`: the checks, the card preview, the owner's flags. Reports its own failures. */
  open(courseDir: string): Promise<void>;
  /** Exports `<courseDir>/deck.json`; the path written, or null when it was saved some other way (a download) or failed. Reports its own failures. */
  export(courseDir: string): Promise<string | null>;
}

export interface AgentAppOptions {
  rail: HTMLElement;
  /** The next-step bar's element, above the main pane's views. */
  bar: HTMLElement;
  /** The main pane's container for everything but the deck view: home, settings, the gate and the agent's output. */
  view: HTMLElement;
  deck: DeckView;
  /** Where an API key entered in Settings is kept: the OS keychain on the desktop, the tab on the site. */
  keys: KeyStore;
  /** A native folder dialog, where the shell has one; without it, a field to type the path in. */
  pickFolder?: () => Promise<string | null>;
}

export interface AgentApp {
  courseDir(): string | null;
  /** Validates the folder, remembers it, connects the chosen agent, and shows the steps. False when it is not a folder the engine can list. */
  setCourseDir(dir: string): Promise<boolean>;
  /** Loads `<dir>/deck.json` into the deck view and shows it. */
  openDeck(dir: string): Promise<void>;
  /** The one status line, for the shell's own messages too (a dropped file, an update). */
  say(text: string, isError?: boolean): void;
  dispose(): Promise<void>;
}

const REMEMBER = { course: 'ape.course', agent: 'ape.agent', deck: (dir: string) => `ape.deck:${dir}` };
const remember = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string | null): void => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* a webview with storage blocked: the app still works, it just forgets */
    }
  },
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function basename(dir: string): string {
  return dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dir;
}

export function mountAgentApp(host: EngineHost, opts: AgentAppOptions): AgentApp {
  const { rail, bar, view, deck } = opts;
  rail.innerHTML = `
    <h1>A.P.E.</h1>
    <div class="railhead">Course folder</div>
    <div class="course">
      <div id="rail-course" class="path">none</div>
      <div id="rail-summary" class="muted"></div>
      <button type="button" id="rail-change" class="quiet">Choose…</button>
    </div>
    <label class="railhead" for="rail-deck">Deck name</label>
    <input id="rail-deck" placeholder="Course::Lecture 3" autocomplete="off" title="What the deck is called in Anki. Two colons make a subdeck.">
    <div class="railhead">Steps</div>
    <ol class="stages" id="stages"></ol>
    <div class="railfoot">
      <div id="rail-agent" class="muted"></div>
      <button type="button" id="rail-settings" class="quiet">Settings</button>
      <div class="status" id="status"></div>
    </div>`;
  view.innerHTML = `<section class="home-pane" hidden></section><section class="settings-pane" hidden></section><section class="gate" hidden></section><section class="agent-host" hidden></section>`;
  bar.className = 'nextbar';
  bar.hidden = true;
  const $ = <T extends HTMLElement>(root: HTMLElement, sel: string): T => root.querySelector<T>(sel)!;
  const status = $<HTMLElement>(rail, '#status');
  const say = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle('error', isError);
  };
  const homeEl = $<HTMLElement>(view, '.home-pane');
  const settingsEl = $<HTMLElement>(view, '.settings-pane');
  const gate = $<HTMLElement>(view, '.gate');
  const agentHost = $<HTMLElement>(view, '.agent-host');
  const deckInput = $<HTMLInputElement>(rail, '#rail-deck');

  // ---- the engine, wherever it is running -------------------------------------
  const sidecar: SidecarClient = makeSidecarClient(host);
  const bus = makeBus(sidecar);

  // ---- screens ---------------------------------------------------------------
  type Screen = 'home' | 'settings' | 'agent' | 'deck';
  let screen: Screen = 'home';
  let before: Screen = 'home';
  function show(name: Screen): void {
    if (name !== 'settings') before = name;
    screen = name;
    view.hidden = name === 'deck';
    homeEl.hidden = name !== 'home';
    settingsEl.hidden = name !== 'settings';
    gate.hidden = name !== 'agent' || gate.innerHTML === '';
    agentHost.hidden = name !== 'agent';
    bar.hidden = !(name === 'agent' || name === 'deck') || !courseDir;
    deck.show(name === 'deck');
  }

  // ---- course folder + deck name --------------------------------------------
  let courseDir: string | null = null;
  let connection: ConnectResult | null = null;
  let chat: Chat | null = null;

  deckInput.addEventListener('change', () => {
    if (courseDir) remember.set(REMEMBER.deck(courseDir), deckInput.value.trim());
  });

  async function setCourseDir(dir: string): Promise<boolean> {
    let summary: string;
    try {
      const { files, artifacts } = await sidecar.listCourse(dir);
      const pdfs = files.filter((f) => f.kind === 'pdf').length;
      const texts = files.filter((f) => f.kind === 'text').length;
      const material = [pdfs ? `${pdfs} PDF${pdfs === 1 ? '' : 's'}` : '', texts ? `${texts} text file${texts === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') || 'no material yet';
      const resume = artifacts.deck ? 'deck.json is there' : artifacts.plan ? 'plan.md is there' : artifacts.inventory ? 'inventory.md is there' : 'nothing written yet';
      summary = `${material} · ${resume}`;
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
      return false;
    }
    if (chat) {
      // The agent's session was opened in the old folder; a new folder is a new session.
      await chat.dispose();
      chat = null;
      connection = null;
      stages.setConnection(null);
      picker.setState({ connected: null });
    }
    courseDir = dir;
    remember.set(REMEMBER.course, dir);
    $<HTMLElement>(rail, '#rail-course').textContent = dir;
    $<HTMLElement>(rail, '#rail-course').title = dir;
    $<HTMLElement>(rail, '#rail-summary').textContent = summary;
    deckInput.value = remember.get(REMEMBER.deck(dir)) ?? basename(dir);
    picker.setState({ hasFolder: true });
    show('agent');
    await stages.refresh();
    const chosen = remember.get(REMEMBER.agent);
    if (chosen) {
      const ok = await picker.connectIfInstalled(chosen);
      if (!ok && !connection) say(`${picker.nameOf(chosen) ?? chosen} could not be connected — see Settings`, true);
    } else {
      say('no agent chosen yet — the first step will send you to Settings');
    }
    return true;
  }

  $<HTMLButtonElement>(rail, '#rail-change').addEventListener('click', () => {
    if (opts.pickFolder) {
      void opts.pickFolder().then((dir) => {
        if (dir) void setCourseDir(dir);
      });
    } else {
      show('home');
      home.focus();
    }
  });
  $<HTMLButtonElement>(rail, '#rail-settings').addEventListener('click', () => show('settings'));

  // ---- home, settings ----------------------------------------------------------
  const home: Home = mountHome(homeEl, {
    ...(opts.pickFolder ? { pickFolder: opts.pickFolder } : {}),
    onFolder: (dir) => void setCourseDir(dir),
    openSettings: () => show('settings'),
  });
  const settings: Settings = mountSettings(settingsEl, host, {
    onDone: () => show(before === 'settings' ? 'home' : before),
    say,
  });
  void sidecar.listMethod().then(
    (m) => settings.setMethodDir(m.dir),
    () => settings.setMethodDir(null),
  );

  // Prompts for sessions no chat pane owns -- the auditor's and the
  // adjudicator's. Without this their write permissions went unanswered.
  mountFallbackPermissions(view, sidecar, bus, () => courseDir);

  // ---- the agent, as a setting --------------------------------------------------
  function showAgentLine(): void {
    const chosen = remember.get(REMEMBER.agent);
    const name = chosen ? (picker.nameOf(chosen) ?? chosen) : null;
    $<HTMLElement>(rail, '#rail-agent').textContent = !name ? 'No agent chosen' : connection ? `${name} · connected` : `${name} · not connected`;
    home.setAgent(name);
  }
  const picker: Picker = mountPicker(settingsEl.querySelector<HTMLElement>('#set-agent')!, sidecar, bus, host.dataDir(), () => courseDir, opts.keys, {
    say,
    onChosen(id) {
      remember.set(REMEMBER.agent, id);
      picker.setState({ chosen: id });
      showAgentLine();
    },
    onConnected(result) {
      if (!result.session || !courseDir) {
        say('connected but no session', true);
        return;
      }
      void (async () => {
        if (chat) await chat.dispose();
        // The adapter names itself by its package; the person chose "Claude Agent".
        const named: ConnectResult = { ...result, agent: { name: picker.nameOf(result.provider) ?? result.agent?.name ?? result.provider, version: result.agent?.version ?? '' } };
        connection = named;
        chat = mountChat(agentHost, sidecar, bus, named, say, () => courseDir);
        stages.setConnection(result);
        picker.setState({ connected: result.provider, chosen: result.provider });
        remember.set(REMEMBER.agent, result.provider);
        showAgentLine();
        say(`${named.agent!.name} ready`);
        if (screen === 'settings') show('agent');
        await stages.refresh();
      })();
    },
  });
  picker.setState({ chosen: remember.get(REMEMBER.agent) });

  // ---- the steps ---------------------------------------------------------------
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
    show('deck');
    await deck.open(dir);
  };
  const stages: Stages = mountStages($<HTMLOListElement>(rail, '#stages'), bar, gate, {
    sidecar: runnerClient,
    courseDir: () => courseDir,
    deckName: () => deckInput.value.trim(),
    say,
    showAgentView: () => show('agent'),
    openDeck,
    exportDeck: async () => (courseDir ? deck.export(courseDir) : null),
    prepareMaterials: async (dir) => {
      await extractMaterials(sidecar, host, dir, say);
    },
    openSettings: () => show('settings'),
  });

  // ---- start -------------------------------------------------------------------
  say(`engine ${host.info.version} on node ${host.info.node}`);
  show('home');
  showAgentLine();
  void (async () => {
    // The folder the host was opened on, else the one from last time.
    const first = host.courseRoot() ?? remember.get(REMEMBER.course);
    if (first && !(await setCourseDir(first))) {
      remember.set(REMEMBER.course, null);
      show('home');
    }
    showAgentLine();
  })();

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

export { EngineError, esc };
