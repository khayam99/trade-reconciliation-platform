import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: mode === 'e2e' ? Number(process.env.E2E_WEB_PORT ?? '5174') : 5173,
    proxy: {
      '/api': process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000',
    },
  },
}));
