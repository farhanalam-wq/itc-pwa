import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxy = {
  '/api': {
    target: 'http://localhost:3002',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, '')
  }
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, proxy: apiProxy },
  preview: { proxy: apiProxy }
});
