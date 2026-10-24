import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { defineConfig } from 'vite'

// Dev: HMR server on 8199 so the board (real backend) on 8198 can be watched live.
// All API / WS / SSE traffic is proxied to 8198 so the React app talks to the REAL backend;
// auth rides through unchanged (Bearer header for reads/writes, ?token= for SSE/WS).
// Build: vite-plugin-singlefile inlines JS+CSS into ONE dist/index.html, so the Python board
// server keeps serving a single file with zero changes.
const BOARD = 'http://127.0.0.1:8198'

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: {
    host: true,
    port: 8290,
    strictPort: true,
    allowedHosts: true, // internal tool, reached via the host's LAN IP
    proxy: {
      '/api': { target: BOARD, changeOrigin: true },
      '/ws': { target: BOARD, changeOrigin: true, ws: true },
      '/vendor': { target: BOARD, changeOrigin: true },
      '/healthz': { target: BOARD, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', assetsInlineLimit: 100_000_000, cssCodeSplit: false },
})
