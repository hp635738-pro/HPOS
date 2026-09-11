import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import prefsPlugin from './vite-prefs-plugin.js'
import runtimeProxyPlugin from './vite-runtime-plugin.js'
import diagPlugin from './vite-diag-plugin.js'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), prefsPlugin(), runtimeProxyPlugin(), diagPlugin()],
  // Bundled Electron loads dist/index.html through file://, so assets must be relative.
  base: './',
  // `@/*` mirrors tsconfig paths so shadcn-style `@/components/...` imports resolve.
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: { clientPort: 443 },
  },
})
