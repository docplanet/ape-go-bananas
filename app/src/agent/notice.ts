// The line an undoable removal leaves above what it was removed from: what
// happened, the way back, and a dismiss. Shared by the deck list and a deck's
// materials, so both removals read and undo the same way.

export interface Notice {
  show(text: string, action?: { label: string; run(): void }): void;
  hide(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** `el` becomes the line; it starts hidden. It goes by itself after a while, long enough to change one's mind. */
export function mountNotice(el: HTMLElement, lingerMs = 20_000): Notice {
  el.classList.add('dnotice');
  el.setAttribute('role', 'status');
  el.hidden = true;
  let run: (() => void) | undefined;
  let timer: number | undefined;
  const hide = (): void => {
    window.clearTimeout(timer);
    el.hidden = true;
  };
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    hide();
    if (b.dataset.act === 'run') run?.();
  });
  return {
    show(text, action) {
      window.clearTimeout(timer);
      run = action?.run;
      el.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button" class="quiet" data-act="run">${esc(action.label)}</button>` : ''}<button type="button" class="dclose" aria-label="Dismiss">×</button>`;
      el.hidden = false;
      timer = window.setTimeout(hide, lingerMs);
    },
    hide,
  };
}
