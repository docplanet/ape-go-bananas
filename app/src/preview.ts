// The card preview: the engine's own review HTML (renderReview, byte-for-
// byte what `ape review` writes) shown in a sandboxed iframe, with two
// additions layered on top -- a Flag button per card, and moving between
// cards from the app's own chrome. Nothing here re-renders or restyles a
// card; if the review page changes in the engine, this pane changes with it,
// and the card the person studies in Anki is the card they see here.
import { convertFileSrc } from '@tauri-apps/api/core';

// renderReview points images at file:// paths under the media dir. A Tauri
// webview cannot load file:// from its own origin; the asset protocol can,
// within the scope set in tauri.conf.json.
function rewriteFileUrls(html: string): string {
  return html.replace(/src="file:\/\/([^"]+)"/g, (_m, path: string) => `src="${convertFileSrc(decodeURIComponent(path))}"`);
}

// The only script that runs inside the review. It adds the per-card Flag
// button, scrolls to a card when the app asks, and says which card is at the
// top so the app's counter stays true when the person scrolls by hand. The
// frame has no same-origin, so this is the whole conversation.
const FLAG_SCRIPT = `<script>
const arts = Array.prototype.slice.call(document.querySelectorAll('article'));
arts.forEach((a, i) => {
  const b = document.createElement('button');
  b.textContent = 'Flag';
  b.className = 'flag';
  b.style.cssText = 'float:right;margin-left:8px';
  b.onclick = () => parent.postMessage({ type: 'ape:flag', noteIndex: i }, '*');
  a.querySelector('.idx').prepend(b);
});
window.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.type === 'ape:flagged') {
    arts.forEach((a, i) => {
      a.style.outline = e.data.indexes.includes(i) ? '2px solid #E0B81C' : '';
    });
  }
  if (e.data.type === 'ape:goto' && arts[e.data.index]) {
    arts[e.data.index].scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
});
let queued = false;
window.addEventListener('scroll', () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (let i = 0; i < arts.length; i++) {
      if (arts[i].getBoundingClientRect().bottom > 40) {
        parent.postMessage({ type: 'ape:at', index: i }, '*');
        return;
      }
    }
  });
}, { passive: true });
</script>`;

export interface Preview {
  /** Rings the cards the owner has flagged. */
  markFlagged(indexes: number[]): void;
  /** Scrolls the review to a card, counting from zero. */
  goto(index: number): void;
}

export interface PreviewOptions {
  /** The Flag button on a card. */
  onFlag(noteIndex: number): void;
  /** Which card is at the top now, as the person scrolls. */
  onAt?(index: number): void;
}

export function mountPreview(host: HTMLElement, html: string, opts: PreviewOptions): Preview {
  host.replaceChildren();
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.srcdoc = rewriteFileUrls(html) + FLAG_SCRIPT;
  host.append(frame);

  const listener = (e: MessageEvent): void => {
    if (e.source !== frame.contentWindow) return;
    const data = e.data as { type?: string; noteIndex?: number; index?: number } | null;
    if (data?.type === 'ape:flag' && Number.isInteger(data.noteIndex)) opts.onFlag(data.noteIndex!);
    if (data?.type === 'ape:at' && Number.isInteger(data.index)) opts.onAt?.(data.index!);
  };
  window.addEventListener('message', listener);

  return {
    markFlagged(indexes) {
      frame.contentWindow?.postMessage({ type: 'ape:flagged', indexes }, '*');
    },
    goto(index) {
      frame.contentWindow?.postMessage({ type: 'ape:goto', index }, '*');
    },
  };
}
