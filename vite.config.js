import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: process.env.VITE_DEV_HOST || '127.0.0.1',
    port: 5173,
    watch: {
      usePolling: process.env.VITE_USE_POLLING === 'true',
    },
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
})
