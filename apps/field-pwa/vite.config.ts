import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const serviceWorkerTemplate = readFileSync(resolve(appDirectory, 'src/pwa/sw-template.js'), 'utf8');

function offlineShellPlugin(): Plugin {
  return {
    name: 'itc-field-offline-shell',
    apply: 'build',
    generateBundle(_options, bundle) {
      const buildInputs = Object.keys(bundle).sort().join('\n');
      const version = createHash('sha256').update(buildInputs).digest('hex').slice(0, 12);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: serviceWorkerTemplate.replace('__BUILD_CACHE__', version)
      });
    }
  };
}

const apiProxy = {
  '/api': {
    target: 'http://localhost:3002',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, '')
  }
};

export default defineConfig({
  plugins: [react(), offlineShellPlugin()],
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: { port: 4173, strictPort: true, proxy: apiProxy }
});
