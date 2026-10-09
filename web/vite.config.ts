import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 后端地址：pi-starter `npm run web` 默认 127.0.0.1:3000，可用 PI_BACKEND 覆盖。
const backend = process.env.PI_BACKEND ?? 'http://127.0.0.1:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // UI 组件自引用（shadcn / assistant-ui registry 生成的 import 都用 @/）
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 线协议单源：直接吃后端的 src/protocol.ts，前后端同一份类型，不存在翻译表漂移
      '@pi/protocol': fileURLToPath(new URL('../src/protocol.ts', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // 对话、模型、设置、能力目录全部走 WS 帧（见 protocol.ts 的 ClientMessage），
      // 所以开发期只需要把 /ws 转发到后端；REST 端点仅供调试，前端不调。
      //
      // ★ 不要设 changeOrigin：后端 originAllowed() 要求 Origin 的 host 等于请求 Host
      //   （同源校验，防跨站 WS 劫持）。changeOrigin 会把转发 Host 改成 127.0.0.1:3000，
      //   而浏览器 Origin 仍是 localhost:5173，不等即 403。
      //   透传原始 Host 后两者相等，校验自然通过；非浏览器客户端不带 Origin，本来也放行。
      '/ws': { target: backend, ws: true },
      // 日志检索走 REST（GET /logs、/logs/stats，见 src/http/log-routes.ts）。
      // 开发期前端与后端不同源，代理转发；生产期前端由后端同源静态托管，直接可达。
      '/logs': { target: backend },
    },
  },
})
