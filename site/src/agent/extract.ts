// Before the extract stage: every PDF in the course folder that has no
// finished extraction beside it gets one, written through the bridge under
// _extracted/<file>/. The agent then reads text.md and the page images and
// never asks for tooling. A PDF with its text.md already there is skipped,
// so a re-run costs nothing; images are written first and the text last,
// which is what makes text.md the mark of a finished extraction.

import type { Bridge } from '../engine/bridge-transport.js';
import { BridgeError, type SidecarClient } from '../engine/bridge-client.js';
import { extractPdf, pageStem, toBase64 } from '../engine/pdf-extract.js';

export async function extractMaterials(sidecar: SidecarClient, bridge: Bridge, courseDir: string, say: (text: string, isError?: boolean) => void): Promise<number> {
  const listing = await sidecar.listCourse(courseDir);
  const finished = new Set(listing.extracted.filter((e) => e.text !== null).map((e) => e.source));
  const todo = listing.files.filter((f) => f.kind === 'pdf' && !finished.has(f.relPath));
  for (const f of todo) {
    say(`reading ${f.name}…`);
    const res = await fetch(bridge.fileUrl(courseDir, f.relPath));
    if (!res.ok) throw new BridgeError(-32000, `could not read ${f.relPath} through the bridge: ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    const dir = `_extracted/${f.relPath}`;
    const { pages } = await extractPdf(f.name, data, {
      async image(n, total, jpeg) {
        say(`extracting ${f.name}: page ${n} of ${total}`);
        await sidecar.writeCourse(courseDir, `${dir}/${pageStem(n)}.jpg`, { base64: toBase64(jpeg) });
      },
      async text(markdown) {
        await sidecar.writeCourse(courseDir, `${dir}/text.md`, { text: markdown });
      },
    });
    say(`${f.name}: ${pages} page${pages === 1 ? '' : 's'} of text and images extracted`);
  }
  return todo.length;
}
