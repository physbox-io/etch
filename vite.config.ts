import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mcpBridgePlugin } from './vite-plugin-mcp-bridge';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), mcpBridgePlugin()],
  optimizeDeps: {
    include: ['opentype.js'],
  },
  server: {
    port: 5176,
    host: true,
  },
});
