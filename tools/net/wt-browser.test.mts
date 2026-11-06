// WEBTRANSPORT IN A BROWSER — the client's real link code (client/src/game/net.ts and its lazy ./wt.ts) in headless
// Chromium against a real server on loopback. Needs a Chromium or Chrome with WebTransport; no GPU, no root, ~30 s.
//   npx tsx tools/net/wt-browser.test.mts [--chrome PATH]     (also KR_CHROME; default: Playwright's own Chromium)
// Checks: with ?wt=1 and a server that offers WebTransport, the link settles on "wt", a ping sent through the link comes
// back as a pong, /health counts the client on wt and one link settled on wt; when the server closes the session (a
// flood past its rate limit) the link goes back to the WebSockets ("closed") and keeps working; without ?wt=1 it stays on the
// WebSockets with "flag-off"; with ?wt=1 against a server without KR_WT it stays there with "server-off", and /health
// counts each reason. With no browser to launch, or no QUIC module build for this platform, it prints SKIP and passes.
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromeArg = process.argv.indexOf("--chrome");
const CHROME = chromeArg > 0 ? process.argv[chromeArg + 1] : process.env.KR_CHROME || undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };
async function waitFor(f: () => boolean, ms: number) { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) return false; await sleep(20); } return true; }
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

async function startServer(env: Record<string, string>): Promise<{ port: number; proc: ChildProcess }> {
  const port = await freePort(); let out = "";
  const proc = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], { cwd: root, env: { ...process.env, KR_HOST: "127.0.0.1", KR_PORT: String(port), KR_EVENT_MODE: "0", KR_PLAYTEST_BUNDLES: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (d) => { out += d; }); proc.stderr!.on("data", (d) => { out += d; });
  if (!(await waitFor(() => /KONG ROYALE server on/.test(out), 60_000))) throw new Error("server did not start:\n" + out);
  return { port, proc };
}
type Health = { transports: { clients: Record<string, number>; settled: { wt: number; ws: Record<string, number> }; webtransport: { off?: string; open?: number } } };
const health = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Health;

// the page: net.ts bundled the way the game ships it (the WebTransport code is a separate lazy chunk), plus a few lines
// that open a link, wait for it to settle and send pings through it
const ENTRY = `import { connectWs } from "./client/src/game/net";
import { M, Writer, writeInput } from "./shared/net/proto";
import { makeInput } from "./shared/sim/player";
(window as any).run = async (url: string, flood: boolean) => {
  const link = await connectWs(url), out: Record<string, unknown> = { pong: false };
  link.onBinary = (u8) => { if (u8[0] === M.Pong) out.pong = true; };
  const t0 = performance.now();
  while (performance.now() - t0 < 8000 && link.transport?.kind !== "wt" && !link.fallback) await new Promise((r) => setTimeout(r, 20));
  out.kind = link.transport?.kind; out.fallback = link.fallback ?? null;
  // only a running match answers pings: make a lobby and start it (a long warm-up, so it is still running at the end)
  let inLobby = false, inMatch = false; link.onJSON = (m) => { if (m.t === "lobby") inLobby = true; if (m.t === "match") inMatch = true; };
  link.sendJSON({ t: "hello", name: "WT" }); link.sendJSON({ t: "create", mode: "solo" });
  while (performance.now() - t0 < 12000 && !inLobby) await new Promise((r) => setTimeout(r, 20));
  link.sendJSON({ t: "start" });
  while (performance.now() - t0 < 30000 && !inMatch) await new Promise((r) => setTimeout(r, 20));
  out.inMatch = inMatch;
  const w = new Writer(new ArrayBuffer(16));
  for (let i = 0; i < 30 && !out.pong; i++) { link.sendBinary(w.reset().u8(M.Ping).f64(performance.now()).view()); await new Promise((r) => setTimeout(r, 100)); }
  out.stats = structuredClone(link.transport?.stats); out.chunks = performance.getEntriesByType("resource").map((e) => e.name.split("/").pop());
  if (out.kind !== "wt" || !flood) return out;
  // a flood past the server's rate limit gets the session closed: the link must go back to the WebSockets and work.
  // Inputs, because they ride the stream: every one arrives, so the count past the bucket is exact (datagrams may drop)
  const iw = new Writer(new ArrayBuffer(64)), inp = makeInput();
  for (let i = 0; i < 1200; i++) { inp.seq = i + 1; writeInput(iw.reset(), inp); link.sendBinary(iw.view()); }
  const t1 = performance.now();
  while (performance.now() - t1 < 8000 && link.transport?.kind === "wt") await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 500));
  out.after = { kind: link.transport?.kind, fallback: link.fallback ?? null, pong: false };
  link.onBinary = (u8) => { if (u8[0] === M.Pong) (out.after as { pong: boolean }).pong = true; };
  for (let i = 0; i < 30 && !(out.after as { pong: boolean }).pong; i++) { link.sendBinary(w.reset().u8(M.Ping).f64(performance.now()).view()); await new Promise((r) => setTimeout(r, 100)); }
  return out;
};`;
const bundle = await build({ stdin: { contents: ENTRY, resolveDir: root, loader: "ts", sourcefile: "wt-browser-entry.ts" }, bundle: true, splitting: true, format: "esm", write: false, outdir: "/out", entryNames: "entry", target: "es2022", logLevel: "silent" });
const files = new Map(bundle.outputFiles.map((f) => [path.basename(f.path), f.contents]));
const page = http.createServer((req, res) => {
  const name = (req.url ?? "/").split("?")[0].slice(1) || "index.html";
  if (name === "index.html") { res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><script type="module" src="/entry.js"></script>'); return; }
  const body = files.get(name);
  if (!body) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/javascript" }); res.end(body);
});
const pagePort = await freePort();
await new Promise<void>((r) => page.listen(pagePort, "127.0.0.1", r));

let browser: Browser;
try { browser = await chromium.launch({ executablePath: CHROME, headless: true }); } catch (e) {
  console.log(`SKIP  no browser to launch (${String(e).split("\n")[0].slice(0, 120)}); pass --chrome or run npx playwright install chromium`);
  page.close(); process.exit(0);
}
type Run = { kind?: string; fallback: string | null; pong: boolean; stats: { sent?: [number, number]; recv?: number }; chunks: string[]; after?: { kind?: string; fallback: string | null; pong: boolean } };
async function run(query: string, port: number, flood = false): Promise<Run> {
  const p = await browser.newPage();
  try {
    await p.goto(`http://127.0.0.1:${pagePort}/${query}`);
    await p.waitForFunction(() => typeof (window as unknown as { run?: unknown }).run === "function");
    return await p.evaluate(([u, f]) => (window as unknown as { run: (u: string, f: boolean) => Promise<Run> }).run(u, f), [`ws://127.0.0.1:${port}/ws`, flood] as const);
  } finally { await p.close(); }
}

try {
  // ---- 1. the server offers WebTransport
  const wtPort = await freePort();
  const s = await startServer({ KR_WT: "1", KR_WT_PORT: String(wtPort), KR_WARMUP_S: "60" });
  try {
    const h0 = await health(s.port);
    if (h0.transports.webtransport.off) console.log(`SKIP  KR_WT=1 checks: the endpoint is off (${h0.transports.webtransport.off})`);
    else {
      const on = await run("?wt=1", s.port, true);
      check(on.kind === "wt" && on.fallback === null, `?wt=1: the link settles on WebTransport (${on.kind}, ${on.fallback})`);
      check(on.pong, "a ping through the WebTransport link is answered");
      check((on.stats.recv ?? 0) > 0 && (on.stats.sent?.[1] ?? 0) > 0, `the wt transport counts what it sends and receives (sent ${on.stats.sent}, recv ${on.stats.recv})`);
      check(on.chunks.some((c) => c !== "entry.js" && /\.js$/.test(c)), `the WebTransport code arrives as its own lazy chunk (${on.chunks.join(", ")})`);
      const h1 = await health(s.port);
      check(h1.transports.settled.wt === 1, `/health counts one link settled on wt (${h1.transports.settled.wt})`);
      check(on.after?.kind === "ws" && on.after.fallback === "closed" && on.after.pong, `after the server closes the session the link is back on the WebSockets, "closed", and pings work (${on.after?.kind}, ${on.after?.fallback}, pong ${on.after?.pong})`);
      check(h1.transports.settled.ws.closed === 1, `/health counts one closed fallback (${h1.transports.settled.ws.closed})`);
      const off = await run("", s.port);
      check(off.kind === "ws" && off.fallback === "flag-off" && off.pong, `no ?wt: the link stays on the WebSockets, "flag-off", and pings work (${off.kind}, ${off.fallback})`);
      await sleep(100);
      check((await health(s.port)).transports.settled.ws["flag-off"] === 1, "/health counts one flag-off fallback");
    }
  } finally { s.proc.kill("SIGTERM"); }

  // ---- 2. the server does not offer it
  const s2 = await startServer({ KR_WARMUP_S: "60" });
  try {
    const r = await run("?wt=1", s2.port);
    check(r.kind === "ws" && r.fallback === "server-off" && r.pong, `?wt=1, KR_WT unset: the link stays on the WebSockets, "server-off" (${r.kind}, ${r.fallback})`);
    await sleep(100);
    check((await health(s2.port)).transports.settled.ws["server-off"] === 1, "/health counts one server-off fallback");
  } finally { s2.proc.kill("SIGTERM"); }
} finally { await browser.close(); page.close(); }

console.log(failed ? `webtransport in a browser: ${failed} check(s) FAILED` : "webtransport in a browser: all checks passed");
process.exit(failed ? 1 : 0);
