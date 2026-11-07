import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: { process: 'globalThis.process' },
  worker: { format: 'es' },
  resolve: {
    alias: {
      stream: 'stream-browserify',
      events: fileURLToPath(new URL('./node_modules/events/events.js', import.meta.url)),
      process: fileURLToPath(new URL('./node_modules/process/browser.js', import.meta.url)),
      util: fileURLToPath(new URL('./node_modules/util/util.js', import.meta.url)),
    },
  },
})
