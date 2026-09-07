// The card preview: the engine's own review HTML (renderReview, byte-for-
// byte what `ape review` writes) shown in a sandboxed iframe, with one
// addition layered on top -- a Flag button per card that reports the card's
// index back to the app. Nothing here re-renders a card; if the review page
// changes in the engine, this pane changes with it.
import { convertFileSrc } from '@tauri-apps/api/core';

// renderReview points images at file:// paths under the media dir. A Tauri
// webview cannot load file:// from its own origin; the asset protocol can,
// within the scope set in tauri.conf.json.
function rewriteFileUrls(html: string): string {
  return html.replace(/src="file:\/\/([^"]+)"/g, (_m, path: string) => `src="${convertFileSrc(decodeURIComponent(path))}"`);
}

const FLAG_SCRIPT = `<script>
document.querySelectorAll('article').forEach((a, i) => {
  const b = document.createElement('button');
  b.textContent = 'Flag';
  b.className = 'flag';
  b.style.cssText = 'float:right;margin-left:8px';
  b.onclick = () => parent.postMessage({ type: 'ape:flag', noteIndex: i }, '*');
  a.querySelector('.idx').prepend(b);
});
window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'ape:flagged') return;
  document.querySelectorAll('article').forEach((a, i) => {
    a.style.outline = e.data.indexes.includes(i) ? '2px solid #E8C07D' : '';
  });
});
</script>`;

export function mountPreview(host: HTMLElement, html: string, onFlag: (noteIndex: number) => void): { markFlagged(indexes: number[]): void } {
  host.replaceChildren();
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.srcdoc = rewriteFileUrls(html) + FLAG_SCRIPT;
  host.append(frame);

  const listener = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    if (e.data?.type === 'ape:flag' && Number.isInteger(e.data.noteIndex)) onFlag(e.data.noteIndex);
  };
  window.addEventListener('message', listener);

  return {
    markFlagged(indexes) {
      frame.contentWindow?.postMessage({ type: 'ape:flagged', indexes }, '*');
    },
  };
}
