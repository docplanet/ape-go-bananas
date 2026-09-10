// The engine's compiled output, carried into the page so it can be mounted
// into the container's filesystem. The sidecar that runs in there is the
// same program the desktop app drove over stdio and `ape-bridge` serves over
// HTTP -- not a reimplementation of it -- so the method table, the ACP
// client and the agent registry arrive intact and stay in one place.
//
// Eager, so the 62 files are one lazily-imported chunk rather than 62 network
// round trips; nothing here is fetched until the page starts a container.

const modules = import.meta.glob('../../../dist/**/*.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** WebContainer's mount format: nested `{ directory }` / `{ file: { contents } }`. */
export type FileTree = { [name: string]: { file: { contents: string } } | { directory: FileTree } };

export function put(tree: FileTree, path: string, contents: string): void {
  const parts = path.split('/').filter(Boolean);
  let cursor = tree;
  parts.forEach((part, i) => {
    if (i === parts.length - 1) {
      cursor[part] = { file: { contents } };
      return;
    }
    const existing = cursor[part];
    if (!existing || !('directory' in existing)) cursor[part] = { directory: {} };
    cursor = (cursor[part] as { directory: FileTree }).directory;
  });
}

/** `dist/**` as a tree, keyed from `dist/` down. */
export function engineTree(): FileTree {
  const tree: FileTree = {};
  for (const [path, contents] of Object.entries(modules)) {
    const rel = path.slice(path.indexOf('/dist/') + 1); // ".../dist/sidecar/index.js" -> "dist/sidecar/index.js"
    put(tree, rel, contents);
  }
  return tree;
}

export function engineFileCount(): number {
  return Object.keys(modules).length;
}
