import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mcpBridgePlugin } from './vite-plugin-mcp-bridge';

/**
 * Dev-only proxies for the AI copilot, so a local run keeps the provider call
 * same-origin. The hosted build is static and has no proxy — the copilot detects
 * the 404 and calls the provider directly, which is why nothing depends on these
 * existing in production.
 *
 * Deliberately no COOP/COEP headers anywhere in this config: `require-corp`
 * would block Google Fonts, api.fontsource.org and jsdelivr, which the font
 * picker and text vectorization depend on.
 */
const COPILOT_PROXIES = {
  '/api/anthropic': {
    target: 'https://api.anthropic.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/anthropic/, ''),
  },
  '/api/gemini': {
    target: 'https://generativelanguage.googleapis.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/gemini/, ''),
  },
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), mcpBridgePlugin()],
  optimizeDeps: {
    include: ['opentype.js'],
  },
  server: {
    port: 5176,
    host: true,
    proxy: COPILOT_PROXIES,
  },
  preview: {
    proxy: COPILOT_PROXIES,
  },
});
