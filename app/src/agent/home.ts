// The main pane with no deck open: the decks this app has, and a new one.
// A deck is a workspace the app owns (a folder under its data dir, one per
// deck); the person never names a path. Files are added to it by dropping
// them on the window or from a picker, and the agent's session is opened
// in it.

import type { DeckSummary } from '../engine/client.js';

export interface HomeOptions {
  onNew(name: string): void;
  onOpen(deck: DeckSummary): void;
  openSettings(): void;
}

export interface Home {
  setDecks(decks: DeckSummary[]): void;
  /** Whether an agent is set up, which changes the note under the list. */
  setAgent(name: string | null): void;
  focus(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Where a deck is, in one phrase. */
export function deckStatus(d: DeckSummary): string {
  const a = d.artifacts;
  if (a.deck) return 'cards written — preview, audit, export';
  if (a.plan) return 'plan written — next: cards';
  if (a.inventory) return 'inventory written — next: organize';
  if (d.files > 0) return 'materials added — next: extract';
  return 'empty — add files';
}

function material(d: DeckSummary): string {
  if (d.files === 0) return 'no files yet';
  const other = d.files - d.pdfs;
  return [d.pdfs ? `${d.pdfs} PDF${d.pdfs === 1 ? '' : 's'}` : '', other ? `${other} other file${other === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
}

export function mountHome(host: HTMLElement, opts: HomeOptions): Home {
  host.innerHTML = `
    <div class="home">
      <h2>Decks</h2>
      <form class="newdeck" id="h-new">
        <input id="h-name" placeholder="Name the deck — Anatomy::Lecture 3 makes a subdeck" autocomplete="off">
        <button type="submit">New deck</button>
      </form>
      <p class="muted">Or drop lecture files or a folder anywhere on this window: a deck is made for them.</p>
      <ul class="decks" id="h-decks"></ul>
      <p class="muted" id="h-agent"></p>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
  const nameInput = $<HTMLInputElement>('#h-name');
  const list = $<HTMLUListElement>('#h-decks');
  let decks: DeckSummary[] = [];

  const submit = (): void => {
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    nameInput.value = '';
    opts.onNew(name);
  };
  $<HTMLFormElement>('#h-new').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit();
  });
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-path]');
    const deck = li && decks.find((d) => d.path === li.dataset.path);
    if (deck) opts.onOpen(deck);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-path]');
    const deck = li && decks.find((d) => d.path === li.dataset.path);
    if (!deck) return;
    e.preventDefault();
    opts.onOpen(deck);
  });
  const agentLine = $<HTMLElement>('#h-agent');
  agentLine.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) opts.openSettings();
  });

  return {
    setDecks(d) {
      decks = d;
      list.innerHTML = decks.length
        ? decks
            .map(
              (deck) =>
                `<li data-path="${esc(deck.path)}" role="button" tabindex="0"><strong>${esc(deck.name)}</strong><span class="dmeta">${esc(material(deck))} · ${esc(deckStatus(deck))}</span></li>`,
            )
            .join('')
        : '<li class="empty">No decks yet.</li>';
    },
    setAgent(name) {
      agentLine.innerHTML = name
        ? `Agent: ${esc(name)}. <button type="button" class="link">Change in Settings</button>`
        : `No agent set up yet — <button type="button" class="link">choose one in Settings</button>, or wait until the first step asks.`;
    },
    focus() {
      nameInput.focus();
    },
  };
}
