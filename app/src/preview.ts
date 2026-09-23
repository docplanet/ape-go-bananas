// The card preview: the engine's own review HTML (renderReview, byte-for-
// byte what `ape review` writes) shown in a sandboxed iframe, with two
// additions layered on top -- a Flag button per card, and moving between
// cards from the app's own chrome. Nothing here re-renders or restyles a
// card; if the review page changes in the engine, this pane changes with it,
// and the card the person studies in Anki is the card they see here.
import { convertFileSrc } from '@tauri-apps/api/core';
import { FLAG_SCRIPT_BODY } from './flag-script.js';

// renderReview points images at file:// paths under the media dir. A Tauri
// webview cannot load file:// from its own origin; the asset protocol can,
// within the scope set in tauri.conf.json.
function rewriteFileUrls(html: string): string {
  return html.replace(/src="file:\/\/([^"]+)"/g, (_m, path: string) => `src="${convertFileSrc(decodeURIComponent(path))}"`);
}

const FLAG_SCRIPT = `<script>${FLAG_SCRIPT_BODY}</script>`;

/** The frame mounted last; a new deck replaces it, and its listener goes with it. */
let unmountLast: (() => void) | null = null;

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
  unmountLast?.();
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
  unmountLast = () => window.removeEventListener('message', listener);

  // The deck's stored flags are marked straight after mounting, before the
  // frame's script is listening, and that message is simply lost. The last
  // marking is kept and sent again once the frame has loaded.
  let flagged: number[] = [];
  const mark = (): void => frame.contentWindow?.postMessage({ type: 'ape:flagged', indexes: flagged }, '*');
  frame.addEventListener('load', mark);

  return {
    markFlagged(indexes) {
      flagged = indexes;
      mark();
    },
    goto(index) {
      frame.contentWindow?.postMessage({ type: 'ape:goto', index }, '*');
    },
  };
}
