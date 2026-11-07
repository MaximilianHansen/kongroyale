// WEBTRANSPORT ENDPOINT — the server's WebTransport path (server/wt.ts) against a real server on loopback, with the
// Node WebTransport client from the same QUIC module. No browser, no root, about 20 s.
//   npx tsx tools/net/wt-endpoint.test.mts
// Checks: off by default (no "wt" in welcome, /health says why); with KR_WT=1 welcome announces the port and the
// certificate hash; a session with a wrong token, and a second one for the same client, are refused; an attached session
// is told so ({ t: "wt-ok" } on its stream); an authenticated
// session carries inputs, on the stream and as input-window datagrams with lost windows repaired by the next one and
// gaps past the window counted (the snapshots' lastSeq follows them, /health counts them), pings (a pong comes back as a datagram), snapshots as
// datagrams and the reliable frames (inventory) on the stream; /health counts the client on "wt"; a flood of frames
// past the rate limit closes the session and the client's frames go back to its WebSockets. A session counts against the
// per-address cap like a WebSocket, and closing the primary WebSocket closes the session and frees both slots.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { INPUT_WINDOW, M, Reader, Writer, readSnapHeader, writeInput, writeInputs, type SnapHeader } from "../../shared/net/proto";
import { makeInput } from "../../shared/sim/player";
import { Deframer, frame } from "../../shared/net/frames";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };
async function waitFor(f: () => boolean, ms: number) { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) return false; await sleep(20); } return true; }
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

async function startServer(env: Record<string, string>): Promise<{ port: number; proc: ChildProcess; log: () => string }> {
  const port = await freePort(); let out = "";
  const proc = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], { cwd: root, env: { ...process.env, KR_HOST: "127.0.0.1", KR_PORT: String(port), KR_EVENT_MODE: "0", KR_PLAYTEST_BUNDLES: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (d) => { out += d; }); proc.stderr!.on("data", (d) => { out += d; });
  const ok = await waitFor(() => /KONG ROYALE server on/.test(out), 60_000);
  if (!ok) throw new Error("server did not start:\n" + out);
  return { port, proc, log: () => out };
}
const health = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { transports: { clients: Record<string, number>; inputs: { lost: number; recovered: number; dropped: number }; webtransport: { off?: string; open?: number; refused?: Record<string, number> } } };

/** a WebSocket client: JSON control + binary frames */
async function wsClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const json: Record<string, unknown>[] = []; const bin: Uint8Array[] = [];
  ws.on("message", (d: Buffer, isBin: boolean) => { if (isBin) bin.push(new Uint8Array(d)); else json.push(JSON.parse(String(d))); });
  await new Promise((r) => ws.once("open", r));
  await waitFor(() => json.some((m) => m.t === "welcome"), 5000);
  return { ws, json, bin, welcome: json.find((m) => m.t === "welcome") as { aux: string; uid: number; wt?: { port: number; hashes?: string[] } }, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}

// ---- 1. off by default
{
  const s = await startServer({});
  try {
    const c = await wsClient(s.port), h = await health(s.port);
    check(!("wt" in c.welcome), "KR_WT unset: welcome has no wt field");
    check(typeof h.transports.webtransport.off === "string", `KR_WT unset: /health says webtransport is off (${h.transports.webtransport.off})`);
    check(h.transports.clients.ws === 1, "KR_WT unset: the client is on ws");
    c.ws.close();
  } finally { s.proc.kill("SIGTERM"); }
}

// ---- 2. on
type Lib = { WebTransport: new (url: string, o: unknown) => any; quicheLoaded: Promise<unknown> };
// the QUIC module ships ready builds for Linux and macOS (x64, arm64) and Windows x64; elsewhere the server runs
// WebSocket-only (part 1 above still ran) and this part is skipped, never on a platform that has a build. The build is
// fetched by the binding's install script, so `npm ci --ignore-scripts` leaves it out: that fails, saying how to fetch
// it (CI runs that rebuild)
const prebuilt = process.platform === "linux" || process.platform === "darwin" || (process.platform === "win32" && process.arch === "x64");
const BINDING = "@fails-components/webtransport-transport-http3-quiche";
let lib: Lib;
try { await import(BINDING as string); lib = await import("@fails-components/webtransport" as string) as Lib; await lib.quicheLoaded; }
catch (e) {
  // the binding's own import throws when its native module is missing (QUIC_MODULE would only log it)
  if (prebuilt) { console.log("FAIL  KR_WT=1 checks: the QUIC binding did not load; after npm ci --ignore-scripts fetch it with npm rebuild " + BINDING); throw e; }
  console.log(`SKIP  KR_WT=1 checks: no QUIC module build for ${process.platform}-${process.arch} (${String(e).slice(0, 100)})`);
  process.exit(failed ? 1 : 0);
}
// two connections per address: the primary WebSocket and one session (the per-address cap counts both kinds)
const s = await startServer({ KR_WT: "1", KR_WARMUP_S: "60", KR_MAX_PER_IP: "2" });
try {
  const c = await wsClient(s.port), wtw = c.welcome.wt;
  check(!!wtw && wtw.port === s.port && wtw.hashes?.length === 1, `KR_WT=1: welcome announces port ${wtw?.port} and one certificate hash`);
  const hashes = (wtw?.hashes ?? []).map((h) => ({ algorithm: "sha-256", value: new Uint8Array(Buffer.from(h, "base64")) }));
  const url = `https://127.0.0.1:${wtw!.port}/wt`;
  const open = async (token: string) => {
    const t = new lib.WebTransport(url, { serverCertificateHashes: hashes }); await t.ready;
    const bidi = await t.createBidirectionalStream(), sw = bidi.writable.getWriter();
    const frames: Uint8Array[] = [], dgrams: Uint8Array[] = []; let closed = false;
    void t.closed.then(() => { closed = true; }, () => { closed = true; });
    const def = new Deframer(16384, (u8) => frames.push(u8.slice()));
    void (async () => { const r = bidi.readable.getReader(); for (;;) { const { value, done } = await r.read().catch(() => ({ done: true, value: undefined })); if (done) return; def.push(value); } })();
    void (async () => { const r = t.datagrams.readable.getReader(); for (;;) { const { value, done } = await r.read().catch(() => ({ done: true, value: undefined })); if (done) return; dgrams.push(value); } })();
    await sw.write(frame(new TextEncoder().encode(JSON.stringify({ t: "wt", token }))));
    const dw = t.datagrams.createWritable().getWriter();
    return { t, sw, dw, frames, dgrams, closed: () => closed };
  };

  const bad = await open("not-a-token");
  check(await waitFor(bad.closed, 5000), "a session with an unknown token is closed");
  check((await health(s.port)).transports.webtransport.refused?.auth === 1, "/health counts it as refused: auth");

  c.send({ t: "hello", name: "WT" }); c.send({ t: "create", mode: "solo" });
  await waitFor(() => c.json.some((m) => m.t === "lobby"), 5000);
  const w = await open(c.welcome.aux);
  await sleep(300);
  check(await waitFor(() => w.frames.some((f) => new TextDecoder().decode(f) === '{"t":"wt-ok"}'), 3000), "an attached session gets { t: \"wt-ok\" } on its stream");
  check((await health(s.port)).transports.clients.wt === 1, "/health counts the client on wt");
  const twice = await open(c.welcome.aux);
  check(await waitFor(twice.closed, 5000) && !w.closed(), "a second session for the same client is refused, the first stays");
  const third = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
  check(await new Promise<boolean>((r) => { third.once("open", () => r(false)); third.once("error", () => r(true)); }), "the session counts against the per-address cap: a third connection from 127.0.0.1 is refused (KR_MAX_PER_IP=2)");

  c.send({ t: "start" });
  check(await waitFor(() => c.json.some((m) => m.t === "match"), 15_000), "the match starts (JSON on the WebSocket)");
  const wsBinBefore = c.bin.length;
  const inW = new Writer(new ArrayBuffer(64)), inp = makeInput();
  for (let seq = 1; seq <= 30; seq++) { inp.seq = seq; writeInput(inW.reset(), inp); await w.sw.write(frame(inW.view())); }
  const pingAt = performance.now(); inW.reset().u8(M.Ping).f64(pingAt); await w.dw.write(inW.view().slice());
  const h = {} as SnapHeader;
  const snaps = () => w.dgrams.filter((d) => d[0] === M.Snapshot);
  check(await waitFor(() => snaps().some((d) => { const r = new Reader(d); r.u8(); readSnapHeader(r, h); return h.lastSeq === 30; }), 5000), `inputs on the stream reach the match: a snapshot datagram acknowledges seq 30 (${snaps().length} snapshot datagrams)`);
  check(w.dgrams.some((d) => d[0] === M.Pong && new Reader(d.subarray(1)).f64() === pingAt), "a ping datagram is answered by a pong datagram");
  check(await waitFor(() => w.frames.some((f) => f[0] === M.Inventory), 3000), "reliable frames (inventory) arrive on the stream");
  check(c.bin.length === wsBinBefore, `no binary frames on the WebSocket while the session lives (${c.bin.length - wsBinBefore})`);

  // input windows as datagrams (M.Inputs): the windows for seqs 35, 36 and 50 are "lost"; the next window carries them
  const ring = Array.from({ length: 64 }, makeInput), winW = new Writer(new ArrayBuffer(512));
  for (let seq = 31; seq <= 60; seq++) {
    ring[seq % 64].seq = seq;
    if (seq === 35 || seq === 36 || seq === 50) continue;
    const first = Math.max(31, seq - INPUT_WINDOW + 1);
    writeInputs(winW.reset(), ring, first, seq - first + 1); await w.dw.write(winW.view().slice()); await sleep(5);
  }
  check(await waitFor(() => snaps().some((d) => { const r = new Reader(d); r.u8(); readSnapHeader(r, h); return h.lastSeq === 60; }), 5000), "input windows as datagrams reach the match: a snapshot acknowledges seq 60");
  let hin = (await health(s.port)).transports.inputs;
  check(hin.recovered === 3 && hin.lost === 0, `the three inputs whose window was lost are recovered from the next one, none lost (/health inputs ${JSON.stringify(hin)})`);
  // a window that starts past a gap the window can't cover: the skipped seqs count as lost
  ring[100 % 64].seq = 100; writeInputs(winW.reset(), ring, 100, 1); await w.dw.write(winW.view().slice());
  check(await waitFor(() => snaps().some((d) => { const r = new Reader(d); r.u8(); readSnapHeader(r, h); return h.lastSeq === 100; }), 5000), "a window past a gap is queued (snapshot acknowledges seq 100)");
  hin = (await health(s.port)).transports.inputs;
  check(hin.lost === 39, `seqs 61-99 count as lost (${hin.lost})`);

  // the stream, not datagrams: every frame of the flood arrives, so the count past the bucket (400) is exact
  for (let i = 0; i < 1200; i++) { inW.reset().u8(M.Ping).f64(i); void w.sw.write(frame(inW.view())); }
  check(await waitFor(w.closed, 5000), "a flood of 1200 frames past the rate limit (400 burst, 400 strikes) closes the session");
  const before = c.bin.length;
  check(await waitFor(() => c.bin.length > before + 10, 3000), "the client's frames go back to its WebSockets");
  const hh = await health(s.port);
  check(hh.transports.clients.ws === 1 && !hh.transports.clients.wt && hh.transports.webtransport.open === 0, `/health: back on ws, no session open (${JSON.stringify(hh.transports)})`);
  c.ws.close();

  // the player leaves: closing the primary WebSocket closes the session too, and frees both of its slots
  await sleep(200);
  for (let round = 1; round <= 2; round++) {
    const c2 = await wsClient(s.port), w2 = await open(c2.welcome.aux);
    check(await waitFor(() => w2.frames.some((f) => new TextDecoder().decode(f) === '{"t":"wt-ok"}'), 3000), `round ${round}: a new client gets its session (the address has room for both connections)`);
    c2.ws.close();
    check(await waitFor(w2.closed, 5000), `round ${round}: closing the primary WebSocket closes the session`);
    await sleep(200);
    check((await health(s.port)).transports.webtransport.open === 0, `round ${round}: /health has no session open`);
  }
} finally { s.proc.kill("SIGTERM"); }
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("webtransport endpoint: all checks passed");
process.exit(0);
