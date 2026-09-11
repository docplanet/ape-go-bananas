// The deck's materials: a tile per file the person added, with its kind,
// size and -- once the extract step has read it -- how many pages came out.
// Files are added by dropping them on the window or from a picker, and
// removed from the tile. What the agent will be given is exactly what is
// here; nothing is hidden in a folder the person cannot see.

import type { CourseFile, Extracted } from '../engine/client.js';

export interface MaterialsOptions {
  onAdd(): void;
  onRemove(relPath: string): void;
}

export interface Materials {
  set(files: CourseFile[], extracted: Extracted[]): void;
  count(): number;
}

const KIND: Record<CourseFile['kind'], string> = { pdf: 'PDF', image: 'image', audio: 'audio', video: 'video', text: 'text', slides: 'slides', doc: 'document', other: 'file' };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What a file's tile says under its name. */
export function describe(f: CourseFile, e: Extracted | undefined): string {
  const parts = [size(f.bytes)];
  if (e?.text) parts.push(e.images.length ? `${e.images.length} page${e.images.length === 1 ? '' : 's'} read` : 'text read');
  else if (f.kind === 'slides') parts.push('export to PDF for the agent to read it');
  else if (f.kind === 'doc') parts.push('the agent reads this as it can');
  return parts.join(' · ');
}

export function mountMaterials(host: HTMLElement, opts: MaterialsOptions): Materials {
  host.innerHTML = `
    <header class="mhead"><h3>Materials <small id="m-count"></small></h3><span class="grow"></span><button type="button" id="m-add" class="quiet">Add files…</button></header>
    <div class="tiles" id="m-tiles"></div>`;
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
  const tiles = $<HTMLElement>('#m-tiles');
  let files: CourseFile[] = [];

  $<HTMLButtonElement>('#m-add').addEventListener('click', () => opts.onAdd());
  tiles.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const remove = t.closest<HTMLButtonElement>('button[data-remove]');
    if (remove) return opts.onRemove(remove.dataset.remove!);
    if (t.closest('.tile.add')) opts.onAdd();
  });

  return {
    set(list, extracted) {
      files = list;
      $('#m-count').textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '';
      tiles.innerHTML =
        files
          .map((f) => {
            const e = extracted.find((x) => x.source === f.relPath);
            return `<div class="tile kind-${f.kind}" title="${esc(f.relPath)}"><div class="tkind">${KIND[f.kind]}</div><div class="tname">${esc(f.name)}</div><div class="tmeta">${esc(describe(f, e))}</div><button type="button" class="tremove" data-remove="${esc(f.relPath)}" title="Remove ${esc(f.name)}">×</button></div>`;
          })
          .join('') +
        `<div class="tile add" role="button" tabindex="0"><div class="tname">${files.length ? 'Add more' : 'Add files'}</div><div class="tmeta">Drop slides as PDF, the transcript, notes — or a whole folder — here</div></div>`;
    },
    count: () => files.length,
  };
}
