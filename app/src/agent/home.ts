// The main pane with no deck open: the decks this app has, and a new one.
// A deck is a workspace the app owns (a folder under its data dir, one per
// deck); the person never names a path. Files are added to it by dropping
// them on the window or from a picker, and the agent's session is opened
// in it.
//
// Folders are Anki's own: "Anatomy::Lecture 3" is the deck "Lecture 3" in
// the folder "Anatomy", here and in Anki alike. There is no second tree to
// keep in step with the first -- moving a deck to a folder is renaming it,
// and the engine moves any cards already written along with it. The engine
// also keeps the folders themselves, so one can be made, nested, before any
// deck is put in it.

import type { DeckSummary } from '../engine/client.js';
import { arrange, deckStatus, deckSteps, folderTree, foldersOf, material, matches, SORTS, splitName, when, type FolderNode, type Sort } from './deck-list.js';
import { mountNotice } from './notice.js';

export interface HomeOptions {
  /** Where the folders are listed as places to go, in the rail beside the list. */
  rail?: HTMLElement;
  onNew(name: string): void;
  onOpen(deck: DeckSummary): void;
  /** Resolves true when the name took; the list is refreshed by the caller. */
  onRename(deck: DeckSummary, name: string): Promise<boolean>;
  /** Resolves true when it was made; the list is refreshed by the caller. */
  onNewFolder(name: string): Promise<boolean>;
  /** Every deck in `from`, and beneath it, moved to `to`. */
  onRenameFolder(from: string, to: string): Promise<void>;
  /** An empty folder only. */
  onDeleteFolder(name: string): Promise<void>;
  onDelete(deck: DeckSummary): Promise<void>;
  openSettings(): void;
}

export interface Home {
  /** The decks, and the folders kept for them (which may be empty). */
  setDecks(decks: DeckSummary[], folders?: string[]): void;
  /** The deck still open behind the list, marked in it; null when none is. */
  setOpen(path: string | null): void;
  /** Whether an agent is set up, which changes the note under the list. */
  setAgent(name: string | null): void;
  /** A line above the list -- a deck deleted, with the way back. */
  notify(text: string, action?: { label: string; run(): void }): void;
  focus(): void;
}

const REMEMBER = { sort: 'ape.home.sort', closed: 'ape.home.closed' };
const stored = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage blocked: the list just forgets its sort and folds */
    }
  },
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function path(folder: string): string {
  return folder
    .split('::')
    .map(esc)
    .join('<i class="dsep">::</i>');
}

export function mountHome(host: HTMLElement, opts: HomeOptions): Home {
  host.innerHTML = `
    <div class="home">
      <h2 id="h-title">Decks</h2>
      <form class="newdeck" id="h-new">
        <input id="h-name" placeholder="Deck name — Anatomy::Lecture 3 goes in Anatomy" autocomplete="off">
        <button type="submit">New deck</button>
        <button type="button" class="quiet" id="h-newfolder">New folder</button>
      </form>
      <p class="muted">Or drop lecture files or a folder anywhere on this window: a deck is made for them.</p>
      <div class="dtools" id="h-tools" hidden>
        <input type="search" id="h-find" placeholder="Find a deck" aria-label="Find a deck" autocomplete="off" spellcheck="false">
        <div class="dsort" role="group" aria-label="Sort decks">${SORTS.map((s) => `<button type="button" data-sort="${s.id}">${s.label}</button>`).join('')}</div>
      </div>
      <div id="h-notice"></div>
      <div id="h-decks"></div>
      <p class="muted" id="h-agent"></p>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
  const nameInput = $<HTMLInputElement>('#h-name');
  const find = $<HTMLInputElement>('#h-find');
  const tools = $<HTMLElement>('#h-tools');
  const notice = mountNotice($<HTMLElement>('#h-notice'));
  const list = $<HTMLElement>('#h-decks');
  let decks: DeckSummary[] = [];
  let folders: string[] = [];
  let openPath: string | null = null;
  // The folder the list is narrowed to, "" for every deck. New decks and
  // folders are made in it, so the title says where that is.
  let scope = '';
  const inScope = (name: string): boolean => !scope || name.startsWith(`${scope}::`);
  const title = $<HTMLElement>('#h-title');
  const rail = opts.rail;
  let sort: Sort = SORTS.find((s) => s.id === stored.get(REMEMBER.sort))?.id ?? 'folders';
  let closed = new Set<string>();
  try {
    closed = new Set(JSON.parse(stored.get(REMEMBER.closed) ?? '[]') as string[]);
  } catch {
    /* an unreadable value: everything open */
  }
  // What is being edited in place, so a re-render (a refresh landing) keeps it open.
  let editing: { kind: 'deck'; path: string; value: string } | { kind: 'folder'; folder: string } | { kind: 'new-folder'; parent: string } | null = null;
  let menu: { path: string; page: 'main' | 'move' } | null = null;

  const deckAt = (el: Element | null): DeckSummary | undefined => {
    const path = el?.closest<HTMLElement>('[data-path]')?.dataset.path;
    return decks.find((d) => d.path === path);
  };

  // ---- the list ------------------------------------------------------------------
  function deckRow(d: DeckSummary): string {
    const { folder, leaf } = splitName(d.name);
    if (editing?.kind === 'deck' && editing.path === d.path) {
      return `<li class="deck editing" data-path="${esc(d.path)}">
        <form class="dedit" data-edit="deck">
          <input value="${esc(editing.value)}" aria-label="Deck name" autocomplete="off" spellcheck="false">
          <button type="submit">Save</button><button type="button" class="quiet" data-cancel>Cancel</button>
          <p class="hint">Two colons make a folder: <code>Anatomy::Lecture 3</code>.${d.artifacts.deck ? ' Its cards move with it; any already sent to Anki stay under the old name there.' : ''}</p>
        </form></li>`;
    }
    const steps = deckSteps(d);
    const state = steps === 0 ? '' : steps >= 5 ? ' finished' : ' started';
    const age = when(d.modified);
    const open = d.path === openPath;
    return `<li class="deck${open ? ' current' : ''}" data-path="${esc(d.path)}">
      <button type="button" class="dopen" title="${esc(d.name)}">${sort !== 'folders' && folder ? `<span class="dkick">${path(folder)}</span>` : ''}<strong>${esc(leaf)}${open ? '<span class="dopen-tag">open</span>' : ''}</strong><span class="dmeta">${esc(material(d))}${age ? ` · ${esc(age)}` : ''}</span><span class="dstate">${esc(deckStatus(d))}</span><span class="dsteps${state}"><span class="dtrack"><i style="width:${(steps / 8) * 100}%"></i></span><span class="dmark"></span><span class="dcount">${steps} / 8</span></span></button>
      <button type="button" class="dmore" aria-label="More for ${esc(leaf)}" aria-haspopup="menu" aria-expanded="${menu?.path === d.path}">•••</button>
      ${menu?.path === d.path ? menuHtml(d) : ''}
    </li>`;
  }

  function menuHtml(d: DeckSummary): string {
    if (menu?.page === 'move') {
      const here = splitName(d.name).folder;
      const all = [...new Set([...folders, ...foldersOf(decks)])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      const rows = ['', ...all].map(
        (f) => `<button type="button" role="menuitemradio" aria-checked="${f === here}" data-move="${esc(f)}"${f === here ? ' disabled' : ''}>${f ? path(f) : '<em>No folder</em>'}</button>`,
      );
      return `<div class="dmenu" role="menu" aria-label="Move to folder">
        <div class="dmenu-head">Move to</div>${rows.join('')}
        <button type="button" role="menuitem" data-act="new-folder">New folder…</button></div>`;
    }
    return `<div class="dmenu" role="menu" aria-label="${esc(d.name)}">
      <button type="button" role="menuitem" data-act="rename">Rename…</button>
      <button type="button" role="menuitem" data-act="move">Move to folder…</button>
      <button type="button" role="menuitem" data-act="delete" class="danger">Delete</button></div>`;
  }

  function newFolderForm(parent: string): string {
    if (editing?.kind !== 'new-folder' || editing.parent !== parent) return '';
    return `<form class="dedit dnewfolder" data-edit="new-folder">
      <input placeholder="Folder name" aria-label="New folder${parent ? ` in ${esc(parent)}` : ''}" autocomplete="off" spellcheck="false">
      <button type="submit">Make folder</button><button type="button" class="quiet" data-cancel>Cancel</button>
      <p class="hint">${parent ? `Inside <code>${esc(parent)}</code>.` : 'Two colons nest one inside another: <code>Year 1::Pharm</code>.'} It stays, empty, until a deck is put in it.</p></form>`;
  }

  function folderHead(n: FolderNode, open: boolean): string {
    if (editing?.kind === 'folder' && editing.folder === n.path) {
      return `<header class="dfolder editing"><form class="dedit" data-edit="folder">
        <input value="${esc(n.path)}" aria-label="Folder name" autocomplete="off" spellcheck="false">
        <button type="submit">Save</button><button type="button" class="quiet" data-cancel>Cancel</button>
        <p class="hint">Renames it for every deck inside; change the part before <code>::</code> to move it.</p></form></header>`;
    }
    const f = esc(n.path);
    return `<header class="dfolder">
      <button type="button" class="dfold" aria-expanded="${open}" data-fold="${f}" title="${f}"><span class="dchev" aria-hidden="true"></span><span class="dpath">${esc(n.name)}</span><span class="dn">${n.total || 'empty'}</span></button>
      <span class="dfolder-acts"><button type="button" class="quiet" data-here="${f}" title="A new deck in ${f}">+ Deck</button><button type="button" class="quiet" data-new-folder="${f}" title="A folder inside ${f}">+ Folder</button><button type="button" class="quiet" data-rename-folder="${f}">Rename</button>${n.total === 0 ? `<button type="button" class="quiet danger" data-delete-folder="${f}">Delete</button>` : ''}</span>
    </header>`;
  }

  /** A folder's inside: a new-folder form if one is being made here, its decks, then its subfolders. */
  function inside(n: FolderNode, searching: boolean): string {
    const decksHtml = n.decks.length ? `<ul class="decks">${n.decks.map(deckRow).join('')}</ul>` : '';
    const empty = n.path && n.total === 0 && !n.folders.length && editing?.kind !== 'new-folder' ? `<p class="dempty">Empty — <button type="button" class="link" data-here="${esc(n.path)}">make a deck here</button> or move one in from its ••• menu.</p>` : '';
    return newFolderForm(n.path) + decksHtml + n.folders.map((c) => folderHtml(c, searching)).join('') + empty;
  }

  function folderHtml(n: FolderNode, searching: boolean): string {
    // A search opens every folder it found something in; so does making a folder inside one.
    const open = searching || !closed.has(n.path) || (editing?.kind === 'new-folder' && (editing.parent === n.path || editing.parent.startsWith(`${n.path}::`)));
    return `<section class="dgroup">${folderHead(n, open)}${open ? `<div class="dkids">${inside(n, searching)}</div>` : ''}</section>`;
  }

  function renderTitle(): void {
    if (!scope) {
      title.textContent = 'Decks';
      nameInput.placeholder = 'Deck name — Anatomy::Lecture 3 goes in Anatomy';
      return;
    }
    const segs = scope.split('::');
    title.innerHTML =
      `<button type="button" class="tcrumb" data-scope="">Decks</button>` +
      segs.map((seg, i) => (i === segs.length - 1 ? `<i>›</i><span>${esc(seg)}</span>` : `<i>›</i><button type="button" class="tcrumb" data-scope="${esc(segs.slice(0, i + 1).join('::'))}">${esc(seg)}</button>`)).join('');
    nameInput.placeholder = `Deck name — goes in ${scope}`;
  }

  /** The rail beside the list: every deck, each folder with how many are beneath, and the deck still open. */
  function renderRail(): void {
    if (!rail) return;
    const tree = folderTree(decks, folders);
    const rows: string[] = [];
    const walk = (n: FolderNode, depth: number): void => {
      for (const c of n.folders) {
        rows.push(`<li><button type="button" data-scope="${esc(c.path)}" class="${c.path === scope ? 'on' : ''}" style="--depth:${depth}" title="${esc(c.path)}"><span class="lname">${esc(c.name)}</span><span class="lcount">${c.total}</span></button></li>`);
        walk(c, depth + 1);
      }
    };
    walk(tree, 0);
    const open = decks.find((d) => d.path === openPath);
    rail.innerHTML =
      `<div class="railhead">Library</div><ul class="lib">` +
      `<li><button type="button" data-scope="" class="${scope ? '' : 'on'} lall"><span class="lname">All decks</span><span class="lcount">${decks.length}</span></button></li>` +
      rows.join('') +
      `</ul><button type="button" class="lnewfolder" data-lib-new-folder>+ New folder</button>` +
      (open ? `<div class="railhead">Open</div><button type="button" class="lopen" data-lib-open title="${esc(open.name)}"><span class="lname">${esc(splitName(open.name).leaf)}</span><span aria-hidden="true">→</span></button>` : '');
  }

  function goTo(folder: string): void {
    if (folder === scope) return;
    scope = folder;
    menu = null;
    editing = null;
    render();
    host.closest<HTMLElement>('.view, main, .main')?.scrollTo({ top: 0 });
  }

  function render(): void {
    renderTitle();
    renderRail();
    tools.hidden = decks.length + folders.length < 2;
    for (const b of tools.querySelectorAll<HTMLButtonElement>('[data-sort]')) b.setAttribute('aria-pressed', String(b.dataset.sort === sort));
    const query = find.value.trim();
    if (decks.length === 0 && folders.length === 0 && editing?.kind !== 'new-folder') {
      list.innerHTML = '<ul class="decks"><li class="empty">No decks yet.</li></ul>';
      return;
    }
    const here = decks.filter((d) => inScope(d.name));
    const shown = query ? here.filter((d) => matches(d, query)) : here;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const shownFolders = folders.filter((f) => inScope(f) && words.every((w) => f.toLowerCase().includes(w)));
    if (query && shown.length === 0 && (sort !== 'folders' || shownFolders.length === 0)) {
      list.innerHTML = `<ul class="decks"><li class="empty">Nothing ${scope ? `in ${esc(scope)} ` : ''}matches “${esc(query)}”. <button type="button" class="link" data-clear>Show all</button>${scope ? ` · <button type="button" class="link" data-scope="">Search every deck</button>` : ''}</li></ul>`;
      return;
    }
    // Narrowed to a folder, the tree starts inside it: the title already names it.
    const at = (n: FolderNode): FolderNode => (scope ? findNode(n, scope) ?? { path: scope, name: splitName(scope).leaf, folders: [], decks: [], total: 0 } : n);
    list.innerHTML =
      sort === 'folders'
        ? `<div class="dtree">${inside(at(folderTree(shown, shownFolders)), !!query)}</div>`
        : shown.length
          ? `<ul class="decks">${arrange(shown, sort).map(deckRow).join('')}</ul>`
          : `<ul class="decks"><li class="empty">No decks in ${esc(scope)} yet.</li></ul>`;
    const input = list.querySelector<HTMLInputElement>('.dedit input');
    if (input && document.activeElement !== input) {
      input.focus();
      // A new folder arrives as "New folder::Lecture 3" with the folder part selected, ready to be typed over;
      // a folder being renamed has its own name selected, its parents left as they are.
      const cut = input.value.lastIndexOf('::');
      if (editing?.kind === 'deck' && cut > 0 && input.value.startsWith('New folder::')) input.setSelectionRange(0, cut);
      else if (editing?.kind === 'folder' && cut > 0) input.setSelectionRange(cut + 2, input.value.length);
      else input.select();
    }
    list.querySelector<HTMLElement>('.dmenu button:not(:disabled)')?.focus();
  }

  function findNode(n: FolderNode, path: string): FolderNode | undefined {
    if (n.path === path) return n;
    for (const c of n.folders) {
      if (path === c.path || path.startsWith(`${c.path}::`)) return findNode(c, path);
    }
    return undefined;
  }

  function newFolder(parent: string): void {
    menu = null;
    editing = { kind: 'new-folder', parent };
    if (sort !== 'folders') {
      sort = 'folders';
      stored.set(REMEMBER.sort, sort);
    }
    closed.delete(parent);
    render();
  }

  // ---- what the person does ------------------------------------------------------
  const submit = (): void => {
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    nameInput.value = '';
    opts.onNew(scope ? `${scope}::${name}` : name);
  };
  $<HTMLFormElement>('#h-new').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  $<HTMLButtonElement>('#h-newfolder').addEventListener('click', () => newFolder(scope));
  title.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-scope]');
    if (b) goTo(b.dataset.scope!);
  });
  rail?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>('[data-scope]');
    if (b) return goTo(b.dataset.scope!);
    if (t.closest('[data-lib-new-folder]')) return newFolder(scope);
    const open = t.closest('[data-lib-open]') && decks.find((d) => d.path === openPath);
    if (open) opts.onOpen(open);
  });

  find.addEventListener('input', () => {
    menu = null;
    render();
  });
  find.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && find.value) {
      e.preventDefault();
      find.value = '';
      render();
    } else if (e.key === 'Enter') {
      // Enter opens the one deck found, or the first.
      const first = list.querySelector<HTMLElement>('li.deck');
      const deck = deckAt(first);
      if (deck) opts.onOpen(deck);
    }
  });
  // ⌘F / Ctrl+F finds a deck; the window has no find of its own to shadow.
  document.addEventListener('keydown', (e) => {
    if (host.hidden || tools.hidden || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
    e.preventDefault();
    find.focus();
    find.select();
  });
  tools.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-sort]');
    if (!b) return;
    sort = b.dataset.sort as Sort;
    stored.set(REMEMBER.sort, sort);
    render();
  });

  function closeMenu(focusButton = false): void {
    if (!menu) return;
    const path = menu.path;
    menu = null;
    render();
    if (focusButton) list.querySelector<HTMLElement>(`li[data-path="${CSS.escape(path)}"] .dmore`)?.focus();
  }

  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const deck = deckAt(t);
    const scopeLink = t.closest<HTMLElement>('[data-scope]');
    if (scopeLink) {
      goTo(scopeLink.dataset.scope!);
      return;
    }
    if (t.closest('[data-clear]')) {
      find.value = '';
      render();
      return;
    }
    if (t.closest('[data-cancel]')) {
      editing = null;
      render();
      return;
    }
    const fold = t.closest<HTMLElement>('[data-fold]');
    if (fold) {
      const f = fold.dataset.fold!;
      if (closed.has(f)) closed.delete(f);
      else closed.add(f);
      stored.set(REMEMBER.closed, JSON.stringify([...closed]));
      render();
      return;
    }
    const here = t.closest<HTMLElement>('[data-here]');
    if (here) {
      // Typed names are made inside the folder the list is narrowed to.
      const folder = here.dataset.here!;
      nameInput.value = scope ? (folder === scope ? '' : `${folder.slice(scope.length + 2)}::`) : `${folder}::`;
      nameInput.focus();
      nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length);
      return;
    }
    const sub = t.closest<HTMLElement>('[data-new-folder]');
    if (sub) {
      newFolder(sub.dataset.newFolder!);
      return;
    }
    const dropFolder = t.closest<HTMLElement>('[data-delete-folder]');
    if (dropFolder) {
      void opts.onDeleteFolder(dropFolder.dataset.deleteFolder!);
      return;
    }
    const renameFolder = t.closest<HTMLElement>('[data-rename-folder]');
    if (renameFolder) {
      editing = { kind: 'folder', folder: renameFolder.dataset.renameFolder! };
      menu = null;
      render();
      return;
    }
    if (!deck) return;
    if (t.closest('.dopen')) {
      opts.onOpen(deck);
      return;
    }
    if (t.closest('.dmore')) {
      menu = menu?.path === deck.path ? null : { path: deck.path, page: 'main' };
      render();
      return;
    }
    const move = t.closest<HTMLElement>('[data-move]');
    if (move) {
      const { leaf } = splitName(deck.name);
      const to = move.dataset.move ? `${move.dataset.move}::${leaf}` : leaf;
      menu = null;
      render();
      void opts.onRename(deck, to);
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'move') {
      menu = { path: deck.path, page: 'move' };
      render();
    } else if (act === 'rename' || act === 'new-folder') {
      menu = null;
      editing = { kind: 'deck', path: deck.path, value: act === 'rename' ? deck.name : `New folder::${splitName(deck.name).leaf}` };
      render();
    } else if (act === 'delete') {
      menu = null;
      render();
      void opts.onDelete(deck);
    }
  });

  list.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const value = form.querySelector('input')!.value.trim();
    const was = editing;
    if (!was || !value) return;
    if (was.kind === 'new-folder') {
      const name = was.parent ? `${was.parent}::${value}` : value;
      editing = null;
      render();
      void opts.onNewFolder(name).then((ok) => {
        if (!ok) {
          editing = was;
          render();
        }
      });
      return;
    }
    if (was.kind === 'folder') {
      editing = null;
      render();
      if (value !== was.folder) {
        if (scope === was.folder || scope.startsWith(`${was.folder}::`)) scope = value + scope.slice(was.folder.length);
        void opts.onRenameFolder(was.folder, value);
      }
      return;
    }
    const deck = decks.find((d) => d.path === was.path);
    if (!deck) return;
    editing = null;
    render();
    if (value !== deck.name) {
      void opts.onRename(deck, value).then((ok) => {
        // A refused name comes back to be fixed rather than lost.
        if (!ok) {
          editing = { kind: 'deck', path: deck.path, value };
          render();
        }
      });
    }
  });

  list.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (editing) {
        editing = null;
        render();
      } else closeMenu(true);
      return;
    }
    if (!menu || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const items = [...list.querySelectorAll<HTMLButtonElement>('.dmenu button:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    e.preventDefault();
  });
  // A click anywhere else puts the menu away.
  document.addEventListener('click', (e) => {
    if (menu && !(e.target as HTMLElement).closest('.dmenu, .dmore')) closeMenu();
  });

  const agentLine = $<HTMLElement>('#h-agent');
  agentLine.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) opts.openSettings();
  });

  return {
    setDecks(d, f = []) {
      decks = d;
      folders = f;
      if (scope && !folders.includes(scope) && !foldersOf(decks).includes(scope)) scope = '';
      if (menu && !decks.some((x) => x.path === menu!.path)) menu = null;
      if (editing?.kind === 'deck' && !decks.some((x) => x.path === (editing as { path: string }).path)) editing = null;
      render();
    },
    setOpen(path) {
      if (path === openPath) return;
      openPath = path;
      render();
    },
    setAgent(name) {
      agentLine.innerHTML = name
        ? `Agent: ${esc(name)}. <button type="button" class="link">Change in Settings</button>`
        : `No agent set up yet — <button type="button" class="link">choose one in Settings</button>, or wait until the first step asks.`;
    },
    notify: (text, action) => notice.show(text, action),
    focus() {
      nameInput.focus();
    },
  };
}
