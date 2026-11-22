import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { noiseSuppressionAudioWorkletVitePlugin } from '@workadventure/noise-suppression/vite';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const serviceWorkerTemplate = readFileSync(resolve(appDirectory, 'src/pwa/sw-template.js'), 'utf8');

function fieldBuildId(): string {
  if (process.env.VITE_APP_BUILD_ID) return process.env.VITE_APP_BUILD_ID;
  const sourceDirectory = resolve(appDirectory, 'src');
  const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
  const hash = createHash('sha256');
  hash.update(readFileSync(resolve(appDirectory, 'package.json')));
  hash.update(readFileSync(resolve(appDirectory, 'vite.config.ts')));
  for (const path of sourceFiles(sourceDirectory).sort()) {
    hash.update(path.slice(sourceDirectory.length));
    hash.update(readFileSync(path));
  }
  return hash.digest('hex').slice(0, 16);
}

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
    target: 'http://localhost:3004',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, '')
  }
};

export default defineConfig({
  plugins: [noiseSuppressionAudioWorkletVitePlugin(), react(), offlineShellPlugin()],
  define: { 'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(fieldBuildId()) },
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: {
    port: 4173,
    strictPort: true,
    allowedHosts: ['.trycloudflare.com'],
    proxy: apiProxy
  }
});
