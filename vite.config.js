import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import prefsPlugin from './vite-prefs-plugin.js'

export default defineConfig({
  plugins: [react(), prefsPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: { clientPort: 443 },
  },
})
