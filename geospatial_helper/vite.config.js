import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  // shpjs (and its deps) use Node's `buffer` module.
  // Alias it to the browser-compatible 'buffer' npm package so Vite
  // bundles it instead of externalizing it.
  resolve: {
    alias: {
      buffer: 'buffer',
    },
  },
  define: {
    // Some CJS packages reference `global` — map it to globalThis in the browser.
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Suppress the 500 kB size warning — bundling geospatial libs is inherently heavy
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
      },
      output: {
        // Flat output — no assets/ subfolder — keeps manifest paths simple
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
})
