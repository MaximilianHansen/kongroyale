import { build, defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { agentBridge } from "./tools/agent-bridge";

// (admin lobby) `vite build` also builds the admin console bundles into dist-admin/ (vite.admin.config.ts) — never into
// dist/, which is served to everyone
const adminBundles = (): Plugin => ({
  name: "kr-admin-bundles", apply: "build",
  async closeBundle() {
    if (process.env.ADMIN_ENTRY) return;
    for (const e of ["login", "console"]) {
      process.env.ADMIN_ENTRY = e;
      try { await build({ configFile: "vite.admin.config.ts" }); } finally { delete process.env.ADMIN_ENTRY; }
    }
  },
});

// (voice) opt-in HTTPS: a microphone needs a secure context, and a phone / another computer reaching this box by its IP
// over plain http is not one. KR_HTTPS_KEY + KR_HTTPS_CERT (PEM files, e.g. a self-signed pair) serve the dev client over
// https (the /ws proxy then runs as wss); unset = plain http.
const https = process.env.KR_HTTPS_KEY && process.env.KR_HTTPS_CERT ? { key: fs.readFileSync(process.env.KR_HTTPS_KEY), cert: fs.readFileSync(process.env.KR_HTTPS_CERT) } : undefined;

// One dev server (port 5317) is shared by every tool. HMR is OFF on purpose: a capture must never be reloaded
// mid-screenshot because some other file was saved. Every navigation loads fresh modules instead.
export default defineConfig({
  base: process.env.DEPLOY_BASE || "/",
  plugins: [adminBundles(), agentBridge()],
  server: {
    port: 5317,
    strictPort: true,
    hmr: false,
    https,
    watch: { ignored: ["**/shots/**", "**/reviews/**", "**/docs/**", "**/tools/**", "**/refs/**"] },
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${process.env.KR_PORT || 3020}`, ws: true },
      // KONGBOT bug reports (server/kongbot.ts)
      "/api": { target: `http://127.0.0.1:${process.env.KR_PORT || 3020}` },
      // the lobby's live status line (ui/lobby-status.ts) reads the game server's /health
      "/health": { target: `http://127.0.0.1:${process.env.KR_PORT || 3020}` },
      // (admin lobby) the admin page, its API and socket live on the game server (built bundles: `vite build` first)
      "/admin": { target: `http://127.0.0.1:${process.env.KR_PORT || 3020}`, ws: true },
    },
    // `--host` puts this server on the network: serve this checkout only (never its parent folder, where other
    // projects and their .env files live), plus an optional `refs` folder of your own reference images when it exists,
    // and never dotfiles such as the admin key
    fs: {
      allow: [fileURLToPath(new URL(".", import.meta.url)), ...(fs.existsSync("refs") ? [fs.realpathSync("refs")] : [])],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.git/**", ".admin-key*", "**/.kongbot/**", "**/.claude/**"],
    },
  },
  // module workers (every `new Worker(url, { type: "module" })` in the client): ES output lets a worker code-split —
  // the static-world worker (engine/static-world.worker.ts) dynamic-imports the veg scatter like the server does
  // `vite preview` (tools): the same game-server proxy as dev (the dev view's /api/annotations, kongbot, /ws)
  preview: {
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${process.env.KR_PORT || 3020}`, ws: true },
      "/api": { target: `http://127.0.0.1:${process.env.KR_PORT || 3020}` },
      "/health": { target: `http://127.0.0.1:${process.env.KR_PORT || 3020}` },
    },
  },
  worker: { format: "es" },
  build: {
    target: "es2022", outDir: "dist", sourcemap: false,
    // registry.ts in its OWN chunk: main.ts boots with top-level await, and atmos afterBuild dynamic-imports the
    // registry. Inlined into the entry chunk that import would wait for the entry's own TLA to finish = deadlock
    // (prod build hung at "afterBuild:atmos"; dev was fine because every file is its own module there).
    rollupOptions: {
      // engine/dither.ts the same way: the engine (entry chunk) AND streamed modules (terrain rocks,
      // the harbour batches, inst-fade) import it — bundled into the entry, the terrain chunk waited for main.ts's TLA,
      // which was waiting for the terrain chunk: the prod build hung at "build:atmos" (dev fine, as above)
      output: { manualChunks: (id) => (/client\/src\/world\/registry\.ts$/.test(id) ? "registry" : /client\/src\/engine\/dither\.ts$/.test(id) ? "dither" : undefined) },
      // Rollup 4.63 object-literal tracking BUG: `link.onJSON(m)` in client/src/game/net.ts was deleted from the bundle
      // because the literal's initial `onJSON: () => {}` is a no-op and the later reassignment (another module, after
      // the promise resolves) was not seen -> the built client ignored every lobby message. Treating property reads as
      // side effects keeps such calls everywhere (+12 KB of 6.1 MB JS).
      treeshake: { propertyReadSideEffects: "always" },
    },
  },
});
