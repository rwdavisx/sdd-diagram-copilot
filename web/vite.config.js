import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // dev-mode: proxy API + SSE to a running `node server.js ...` instance
    proxy: {
      '/api': 'http://localhost:4400',
    },
  },
})
