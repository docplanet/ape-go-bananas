import { defineConfig } from 'vite';

// The Tauri template's own settings: fixed port so `tauri dev` can find the
// dev server, and no rebuild storms when cargo writes under src-tauri.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: { target: 'es2023' },
});
