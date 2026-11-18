import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxy = {
  '/api': {
    target: 'http://localhost:3004',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, '')
  }
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true, proxy: apiProxy },
  preview: { port: 4180, strictPort: true, proxy: apiProxy }
});
