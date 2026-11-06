// The client's WebTransport transport (shared/net/transport.ts), loaded only when ?wt=1 and the server's "welcome"
// offers an endpoint (client/src/game/net.ts imports this chunk lazily). Unreliable frames ride QUIC datagrams, reliable
// ones the session's one bidirectional stream (shared/net/frames.ts); a frame too big for a datagram rides the stream.
// The session authenticates with the aux token as its first stream frame and is up once the server answers
// { t: "wt-ok" }. Anything else (no session within WT_DIAL_MS, refused, closed) is a fallback reason, and net.ts keeps
// the WebSocket pair. A session that stops answering while we send (STALL_MS, like the WebSocket's) counts as closed,
// and one whose datagrams stop coming back while we send them (pings) is given up as "no-datagrams". Outside a match
// nothing else rides the session, so a ping goes out after KEEPALIVE_MS without one: the server ends a session silent
// for its heartbeat timeout (30 s), and a lobby or a results screen lasts longer than that.
import { Channel, countSent, makeTransportStats, type FallbackReason, type Path, type Transport } from "../../../shared/net/transport";
import { Deframer, frame } from "../../../shared/net/frames";
import { M, Writer } from "../../../shared/net/proto";

/** longest wait for the session and the server's answer */
const WT_DIAL_MS = 3000;
/** sending this long without hearing anything back: the session is dead (the WebSocket's STALL_MS) */
const STALL_MS = 3000;
/** a ping after this long without sending anything: well inside the server's silence limit (server/wt.ts silentMaxMs) */
const KEEPALIVE_MS = 10_000;
/** the browser drops an unreliable frame still queued after this long (a stale input or ping is useless) */
const OUTGOING_MAX_AGE_MS = 100;
const MAX_FRAME = 16384;
const SERVER_PATH: Path = { reply: () => {}, strike: () => {} };

/** what "welcome" says about the server's endpoint (server/wt.ts WtWelcome) */
export interface WtOffer { port: number; hashes?: string[]; url?: string }
export interface WtLink extends Transport {
  /** settles when the session ends: "no-datagrams" when this side gave up on datagrams that stopped arriving, else
   *  "closed" */
  readonly closed: Promise<FallbackReason>;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** `onMessage` gets every frame from the start: the server switches its frames over before we read "wt-ok", and a
 *  reliable frame (an event) in that window would otherwise be lost */
export async function dialWt(offer: WtOffer, token: string, onMessage: Transport["onMessage"]): Promise<WtLink | FallbackReason> {
  // the server's UDP socket is IPv4, and for "localhost" a browser dials QUIC on ::1 alone (TCP falls back to 127.0.0.1).
  // Only with a certificate checked by hash: a real one is checked against the name, and may name localhost alone
  const host = location.hostname === "localhost" && offer.hashes ? "127.0.0.1" : location.hostname;
  const url = offer.url ?? `https://${host}:${offer.port}/wt`;
  let t: WebTransport;
  try {
    t = new WebTransport(url, {
      requireUnreliable: true, congestionControl: "low-latency",
      ...(offer.hashes ? { serverCertificateHashes: offer.hashes.map((h) => ({ algorithm: "sha-256", value: b64(h) })) } : {}),
    });
  } catch { return "connect-failed"; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), WT_DIAL_MS); });
  // which step a fallback came from goes to the console: "timeout" alone can't say whether the handshake, the stream or
  // the server's answer was late, and browsers differ there
  const t0 = performance.now();
  let step = "the handshake";
  const fail = (why: FallbackReason) => {
    clearTimeout(timer); try { t.close(); } catch { /* not open */ }
    console.warn(`webtransport: ${why} at ${step} after ${Math.round(performance.now() - t0)} ms, staying on WebSockets`);
    return why;
  };
  const up = await Promise.race([t.ready.then(() => "up" as const, () => "connect-failed" as const), timeout]);
  if (up !== "up") return fail(up);
  step = "the stream";
  const bidi = await Promise.race([t.createBidirectionalStream().catch(() => null), timeout]);
  if (!bidi || bidi === "timeout") return fail(bidi === "timeout" ? "timeout" : "connect-failed");
  const sw = bidi.writable.getWriter(), dg = t.datagrams as WebTransportDatagramDuplexStream & { createWritable?: () => WritableStream<Uint8Array> };
  const dw = (dg.createWritable ? dg.createWritable() : dg.writable).getWriter();
  try { dg.outgoingMaxAge = OUTGOING_MAX_AGE_MS; } catch { /* not every browser lets us set it */ }

  const stats = makeTransportStats("wt");
  // dgWait: when we started sending unreliable frames (pings) with no datagram back since; 0 = one came back since.
  // A path that carries the stream but drops datagrams would freeze snapshots while the stream keeps lastRx fresh
  let lastRx = performance.now(), lastTx = lastRx, dgWait = 0, ended = false, gaveUp = false, accepted: (ok: boolean) => void = () => {};
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const okAnswer = new Promise<boolean>((r) => { accepted = r; });
  const deliver = (u8: Uint8Array) => { lastRx = performance.now(); stats.recv++; stats.recvBytes += u8.length; link.onMessage(u8, lastRx, SERVER_PATH); };
  const writeStream = (u8: Uint8Array) => { sw.write(frame(u8)).catch(() => {}); };
  const close = () => { if (ended) return; ended = true; try { t.close(); } catch { /* closing */ } };
  const link: WtLink = {
    kind: "wt", stats, onMessage, close,
    closed: t.closed.then(() => {}, () => {}).then(() => { ended = true; clearInterval(keepalive); accepted(false); return gaveUp ? "no-datagrams" : "closed"; }),
    sendReliable: (u8) => { if (ended) return; countSent(stats, Channel.Reliable, u8.length); lastTx = performance.now(); writeStream(u8); },
    sendUnreliable: (u8) => {
      if (ended) return;
      const now = performance.now();
      if (now - lastRx > STALL_MS && now - lastTx < STALL_MS) { close(); return; }
      // a gap in our own sending (a long task, a background tab) restarts the wait: nothing was owed back then
      if (!dgWait || now - lastTx > STALL_MS) dgWait = now;
      else if (now - dgWait > STALL_MS) { gaveUp = true; close(); return; }
      countSent(stats, Channel.Unreliable, u8.length); lastTx = now;
      if (u8.length > dg.maxDatagramSize) { writeStream(u8); return; }
      dw.write(u8.slice()).catch(() => {});
    },
  };
  const def = new Deframer(MAX_FRAME, (u8) => {
    if (u8[0] === 0x7b) { let m: { t?: unknown } | null = null; try { m = JSON.parse(new TextDecoder().decode(u8)); } catch { /* below */ } accepted(m?.t === "wt-ok"); return; }
    deliver(u8);
  });
  void (async () => { const r = bidi.readable.getReader(); for (;;) { const { value, done } = await r.read(); if (done) break; def.push(value); if (def.bad) { close(); break; } } })().catch(close);
  void (async () => { const r = dg.readable.getReader(); for (;;) { const { value, done } = await r.read(); if (done) break; dgWait = 0; deliver(value); } })().catch(() => {});
  step = "the server's answer";
  writeStream(new TextEncoder().encode(JSON.stringify({ t: "wt", token })));
  const ok = await Promise.race([okAnswer, timeout]);
  if (ok !== true) { close(); return fail(ok === "timeout" ? "timeout" : "auth"); }
  clearTimeout(timer);
  const pingW = new Writer(new ArrayBuffer(16));
  // straight to the datagram writer, past the stall checks: outside a match nothing answers it, and a keepalive counted
  // as our sending would make the first gameplay frame after it look like a dead session
  keepalive = setInterval(() => {
    if (ended || performance.now() - lastTx < KEEPALIVE_MS) return;
    const u8 = pingW.reset().u8(M.Ping).f64(performance.now()).view();
    countSent(stats, Channel.Unreliable, u8.length); dw.write(u8.slice()).catch(() => {});
  }, KEEPALIVE_MS);
  return link;
}
