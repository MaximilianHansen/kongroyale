// The server's end of the WebSocket transport (shared/net/transport.ts): a client's primary socket plus its aux socket
// (client/src/game/net.ts opens it after "welcome"). Every binary frame goes on every open socket and the client keeps
// the first copy; inbound frames from either socket reach onMessage with the socket they came from as the Path, so a
// pong answers on that socket and a malformed frame is struck against it. Backpressure: a socket with a large send
// backlog skips unreliable frames (each snapshot is self-contained) instead of queueing them, and one hopelessly behind
// is terminated.
import { WebSocket, type RawData } from "ws";
import { Channel, channelOf, countSent, makeTransportStats, type Path, type Transport } from "../shared/net/transport";
import type { Sock } from "./index";

/** queued bytes above which a socket skips unreliable frames */
const SKIP_BACKLOG_BYTES = 64 * 1024;
/** queued bytes above which a socket is terminated */
const KILL_BACKLOG_BYTES = 4 * 1024 * 1024;

export class WsTransport implements Transport {
  readonly kind = "ws" as const;
  readonly stats = makeTransportStats("ws");
  onMessage: (u8: Uint8Array, at: number, from: Path) => void = () => {};
  /** `aux`: the client's redundant sockets, shared with Client.aux (at most one) */
  constructor(private readonly sock: Sock, private readonly aux: Sock[], private readonly strike: (s: Sock, why: string) => void) {}
  sendReliable(u8: Uint8Array) { this.send(u8, Channel.Reliable); }
  sendUnreliable(u8: Uint8Array) { this.send(u8, Channel.Unreliable); }
  /** one copy per frame: `u8` may be a view over a reused buffer */
  private send(u8: Uint8Array, ch: Channel) {
    countSent(this.stats, ch, u8.length);
    let buf: Buffer | null = null;
    for (let i = -1; i < this.aux.length; i++) {
      const s = i < 0 ? this.sock : this.aux[i], ws = s.ws;
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ch === Channel.Unreliable && ws.bufferedAmount > SKIP_BACKLOG_BYTES) { this.stats.skipped++; continue; }
      if (ws.bufferedAmount > KILL_BACKLOG_BYTES) { s.closedBy ||= "send backlog > 4 MB"; ws.terminate(); continue; }
      buf ??= Buffer.from(u8);
      ws.send(buf, { binary: true });
    }
  }
  /** a binary message from one of this client's sockets */
  receive(s: Sock, data: RawData) {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    this.stats.recv++; this.stats.recvBytes += buf.byteLength;
    this.onMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), performance.now(), this.pathOf(s));
  }
  private readonly paths = new WeakMap<Sock, Path>();
  private pathOf(s: Sock): Path {
    let p = this.paths.get(s);
    if (!p) {
      // a reply (a pong) goes back on the socket its frame came from only, and counts like any other send
      p = { reply: (u8) => { countSent(this.stats, channelOf(u8[0]), u8.length); if (s.ws.readyState === WebSocket.OPEN) s.ws.send(Buffer.from(u8), { binary: true }); }, strike: (why) => this.strike(s, why) };
      this.paths.set(s, p);
    }
    return p;
  }
  close() { for (const a of this.aux) { a.closedBy ||= "primary closed"; a.ws.close(); } }
}
