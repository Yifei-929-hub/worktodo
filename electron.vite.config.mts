import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [
      react(),
      {
        // 热更新需要内联脚本和 WebSocket，仅在开发时放宽
        name: 'dev-csp',
        apply: 'serve',
        transformIndexHtml: (html: string) =>
          html.replace(
            "default-src 'self'",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*"
          )
      }
    ]
  }
})