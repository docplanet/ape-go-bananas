// Before the extract stage: every PDF in the course folder that has no
// finished extraction beside it gets one, written through the sidecar under
// _extracted/<file>/. The agent then reads text.md and the page images and
// never asks for tooling. A PDF with its text.md already there is skipped,
// so a re-run costs nothing; images are written first and the text last,
// which is what makes text.md the mark of a finished extraction.

import { EngineError, type EngineHost, type SidecarClient } from '../engine/client.js';
import { extractPdf, pageStem, toBase64 } from '../engine/pdf-extract.js';

export async function extractMaterials(sidecar: SidecarClient, host: EngineHost, courseDir: string, say: (text: string, isError?: boolean) => void): Promise<number> {
  const listing = await sidecar.listCourse(courseDir);
  const finished = new Set(listing.extracted.filter((e) => e.text !== null).map((e) => e.source));
  const todo = listing.files.filter((f) => f.kind === 'pdf' && !finished.has(f.relPath));
  for (const f of todo) {
    say(`reading ${f.name}…`);
    const data = await host.readFile(courseDir, f.relPath);
    if (data === null) throw new EngineError(-32000, `could not read ${f.relPath} from the course folder`);
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
