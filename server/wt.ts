// The WebTransport endpoint: off unless KR_WT=1. Players' inputs, pings and snapshots ride QUIC datagrams
// here, everything else binary rides one reliable stream; the primary WebSocket stays the control channel (JSON) and
// authenticates the session: its first stream frame is `{ t: "wt", token }` with the token from "welcome", exactly like
// the aux socket (never in the URL), and the server answers `{ t: "wt-ok" }` on the stream once it is attached. A session counts against the same total and per-address caps as a WebSocket, gets
// the same token bucket and strikes (server/limits.ts), at most one per client, and frames no longer than MAX_PAYLOAD.
// Needs UDP to KR_WT_PORT and a certificate: KR_WT_CERT + KR_WT_KEY (PEM, a real one for the page's host name), or a
// self-signed one made here and announced by its SHA-256 (server/wt-cert.ts). No proxy or CDN may sit in front.
// The QUIC stack is @fails-components/webtransport over Google quiche (a native module, an optional dependency): when it
// can't load, startWt throws and the server runs WebSocket-only, saying why in its log and /health.
import fs from "node:fs";
import crypto from "node:crypto";
import { addrKey } from "./addr";
import { Deframer, frame } from "../shared/net/frames";
import { WtTransport, type WtSessionLike } from "./transport-wt";
import { makeBucket, struck, take } from "./limits";
import { selfSigned } from "./wt-cert";

const AUTH_MS = 3000;
/** loaded by name at runtime: its type declarations only resolve under Node's export conditions, and nothing else may
 *  pull the native module in */
const QUIC_MODULE = "@fails-components/webtransport";
/** its native QUIC binding, imported on its own first: QUIC_MODULE logs a failed load and carries on, and its server
 *  then never becomes ready */
const QUIC_BINDING = "@fails-components/webtransport-transport-http3-quiche";
/** longest wait for the QUIC server to listen */
const START_MS = 10_000;
/** renew a self-signed certificate this long before it ends */
const RENEW_BEFORE_MS = 86_400_000;

export interface WtConfig { port: number; host: string; certFile?: string; keyFile?: string; url?: string; maxPayload: number; origins: string[]; silentMaxMs: number }
export interface WtHooks {
  /** may this address open one more connection (the WebSockets' total and per-address caps) */
  admit(ip: string): boolean;
  opened(ip: string): void; closed(ip: string): void;
  /** the session showed this token: attach the transport to its client (false = unknown token, or one already attached) */
  attach(token: string, t: WtTransport): boolean;
  detach(t: WtTransport): void;
  log(...a: unknown[]): void;
}
/** what "welcome" tells a client about this endpoint */
export interface WtWelcome { port: number; hashes?: string[]; url?: string }
export interface WtEndpoint {
  welcome(): WtWelcome;
  /** sessions open now, opened since start, refused by reason */
  readonly counts: { open: number; opened: number; refused: Record<string, number> };
  close(): void;
}

interface Stream<T> { getReader(): { read(): Promise<{ value?: T; done: boolean }>; releaseLock(): void } }
interface Session extends WtSessionLike {
  readonly peerAddress?: string; readonly header?: Record<string, string> | null;
  ready: Promise<void>; closed: Promise<unknown>;
  incomingBidirectionalStreams: Stream<{ readable: Stream<Uint8Array>; writable: { getWriter(): { write(c: Uint8Array): Promise<void> } } }>;
  datagrams: WtSessionLike["datagrams"] & { readable: Stream<Uint8Array>; createWritable(): { getWriter(): { write(c: Uint8Array): Promise<void> } } };
}
interface Server { startServer(): void; stopServer(): void; ready: Promise<void>; sessionStream(path: string): Stream<Session>; updateCert?(cert: string, key: string): void }

/** "1.2.3.4:5678" / "[::1]:5678" → the address part */
const hostOf = (peer = "") => peer.startsWith("[") ? peer.slice(1, peer.indexOf("]")) : peer.includes(".") ? peer.replace(/:\d+$/, "") : peer;

async function* each<T>(s: Stream<T>) { const r = s.getReader(); try { for (;;) { const { value, done } = await r.read(); if (done) return; yield value as T; } } finally { r.releaseLock(); } }

export async function startWt(cfg: WtConfig, hooks: WtHooks): Promise<WtEndpoint> {
  let lib: { Http3Server: new (o: Record<string, unknown>) => Server; quicheLoaded: Promise<unknown> };
  try { await import(QUIC_BINDING); lib = await import(QUIC_MODULE) as typeof lib; await lib.quicheLoaded; }
  catch (e) { throw new Error(`the QUIC module did not load (${String(e).slice(0, 120)}); npm installs it on Linux, macOS and Windows x64`); }
  const real = !!(cfg.certFile && cfg.keyFile);
  let cert: string, key: string, hash: Buffer | null = null, notAfter = Infinity;
  if (real) { cert = fs.readFileSync(cfg.certFile!, "utf8"); key = fs.readFileSync(cfg.keyFile!, "utf8"); }
  else ({ cert, key, sha256: hash, notAfter } = selfSigned());
  const server = new lib.Http3Server({ port: cfg.port, host: cfg.host, secret: crypto.randomBytes(16).toString("hex"), cert, privKey: key });
  server.startServer();
  // a server that fails to start (a bad certificate, the port taken) logs it and never settles ready
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const started = await Promise.race([server.ready.then(() => true, () => false), new Promise<false>((r) => { startTimer = setTimeout(() => r(false), START_MS); })]);
  clearTimeout(startTimer);
  if (!started) { try { server.stopServer(); } catch { /* never started */ } throw new Error(`the QUIC server did not start on udp ${cfg.host}:${cfg.port} within ${START_MS / 1000} s`); }
  const renew = real ? null : setInterval(() => {
    if (notAfter - Date.now() > RENEW_BEFORE_MS) return;
    const next = selfSigned();
    try { server.updateCert!(next.cert, next.key); hash = next.sha256; notAfter = next.notAfter; hooks.log("webtransport: renewed the self-signed certificate"); }
    catch (e) { hooks.log("webtransport: could not renew the self-signed certificate, restart the server before it ends:", String(e)); }
  }, 3_600_000);
  renew?.unref();
  const counts = { open: 0, opened: 0, refused: {} as Record<string, number> };
  const refuse = (s: Session, why: string) => { counts.refused[why] = (counts.refused[why] ?? 0) + 1; try { s.close({ closeCode: 1, reason: why }); } catch { /* gone */ } };

  async function handle(s: Session) {
    const ip = addrKey(hostOf(s.peerAddress));
    const origin = s.header?.origin ?? s.header?.Origin ?? "";
    if (cfg.origins.length && !cfg.origins.includes(origin)) { refuse(s, "origin"); return; }
    if (!hooks.admit(ip)) { refuse(s, "limit"); return; }
    // the slot is taken now, not once the handshake ends: sessions arriving together must not all pass admit
    counts.open++; hooks.opened(ip);
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const up = await Promise.race([s.ready.then(() => true, () => false), new Promise<false>((r) => { readyTimer = setTimeout(() => r(false), AUTH_MS); })]);
    clearTimeout(readyTimer);
    if (!up) { counts.open--; hooks.closed(ip); refuse(s, "handshake"); return; }
    counts.opened++;
    const bucket = makeBucket();
    let t: WtTransport | null = null, done = false;
    // once, whoever ends it: this side (end, or the transport closing itself: backlog, primary socket gone) or the peer
    // (s.closed; a session this side closed never settles it)
    const cleanup = () => { if (done) return; done = true; clearTimeout(authTimer); clearInterval(silence); counts.open--; hooks.closed(ip); if (t) hooks.detach(t); };
    const end = (why: string) => { if (done) return; if (t) t.close(why); else refuse(s, why); cleanup(); };
    const strike = (why: string) => { if (struck(bucket)) { hooks.log(`closing a webtransport session: ${why}`); end(why); } };
    const authTimer = setTimeout(() => end("timeout"), AUTH_MS);
    const silence = setInterval(() => { if (Date.now() - bucket.lastMsg > cfg.silentMaxMs) end("silent"); }, 5000);
    void s.closed.catch(() => {}).finally(cleanup);
    try {
      const streams = s.incomingBidirectionalStreams.getReader(), first = await streams.read(); streams.releaseLock();
      if (first.done || !first.value) return;
      const bidi = first.value, sw = bidi.writable.getWriter(), dw = s.datagrams.createWritable().getWriter();
      const def = new Deframer(cfg.maxPayload, (u8) => {
        if (!take(bucket)) { strike("rate"); return; }
        if (t) { t.receive(u8, t.streamPath); return; }
        let m: { t?: unknown; token?: unknown } | null = null;
        try { m = JSON.parse(new TextDecoder().decode(u8)); } catch { /* below */ }
        clearTimeout(authTimer);
        const next = new WtTransport(s, dw, sw, strike, cleanup);
        if (!m || m.t !== "wt" || typeof m.token !== "string" || !hooks.attach(m.token, next)) { end("auth"); return; }
        t = next;
        // the client switches its binary frames over only once it reads this (a JSON frame: "{" is no frame type)
        void sw.write(frame(new TextEncoder().encode(JSON.stringify({ t: "wt-ok" })))).catch(() => {});
        void (async () => { for await (const dg of each(s.datagrams.readable)) { if (done) return; if (!take(bucket)) strike("rate"); else t!.receive(dg, t!.datagramPath); } })().catch(() => {});
      });
      for await (const chunk of each(bidi.readable)) { def.push(chunk); if (def.bad) { end("bad frame"); return; } if (done) return; }
    } catch { /* the session ended */ }
    end("closed");
  }
  void (async () => { for await (const s of each(server.sessionStream("/wt"))) void handle(s).catch((e) => hooks.log("webtransport session error", e)); })();
  hooks.log(`webtransport on udp ${cfg.host}:${cfg.port} (${real ? "certificate " + cfg.certFile : "self-signed certificate, announced by hash"})`);
  return {
    counts,
    welcome: () => ({ port: cfg.port, ...(hash ? { hashes: [hash.toString("base64")] } : {}), ...(cfg.url ? { url: cfg.url } : {}) }),
    close: () => { if (renew) clearInterval(renew); try { server.stopServer(); } catch { /* stopping */ } },
  };
}
