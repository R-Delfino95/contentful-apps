import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig(() => ({
  base: '', // relative paths
  // Stamped into the `passthrough` of every Robots job so a job can be attributed to this plugin
  // and this version without adding a header to every Mux call the app makes.
  define: {
    __MUX_APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 3000,
  },
  build: {
    // the parent project that combines both the frontend and the hosted app action backend needs to be able to override
    // the default location to its own build path
    outDir: process.env.BUILD_PATH || './build',
  },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/setupTests.ts'],
  },
}));
