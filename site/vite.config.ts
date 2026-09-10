import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Relative asset URLs. GitHub Pages serves this project repo under
  // /ape-go-bananas/, not at the origin root, so Vite's default `base: '/'`
  // emits /assets/... URLs that 404 there -- including the worker chunk and
  // the sql.js wasm, which fail silently and leave a dead page. './' keeps
  // the build correct at any base, including a custom domain later.
  base: './',

  // Two pages: the download page at /, the browser tool at /tool/.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2023',
    rollupOptions: {
      input: { download: here('index.html'), tool: here('tool/index.html') },
    },
  },
  server: {
    // The engine's compiled dist/ sits above this project's root. The build
    // resolves it as an ordinary relative import; the dev server needs to be
    // told it may serve from there.
    fs: { allow: ['..'] },
  },
  worker: { format: 'es' },
});
