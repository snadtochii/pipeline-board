import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'

// Plugin order matters: tanstackStart() first (route generation + SSR entry wiring),
// then nitro() so the production build emits a runnable Node server at
// .output/server/index.mjs (what `npm start` runs), then viteReact().
//
// TanStack Start 1.168.25 production server functions are verified with this app's
// direct server-fn wrapper pattern. Keep shared server logic in plain server-only
// helpers called from `.handler()` bodies. Do not call one `createServerFn` from
// middleware around another server function; TanStack/router #7213 reproduces as
// "Server function info not found" in production for that shape. Verify any Start
// version bump by hitting a real server-fn in a browser (200 + data), not just
// that the page renders.
export default defineConfig({
  server: { port: 3000 },
  plugins: [tanstackStart(), nitro(), viteReact()],
})
