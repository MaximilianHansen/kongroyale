// The server's end of the WebTransport transport (shared/net/transport.ts) for one authenticated session
// (server/wt.ts): unreliable frames as QUIC datagrams, reliable frames on the session's one bidirectional stream
// (shared/net/frames.ts). A frame too big for one datagram rides the stream instead. Backpressure: unreliable frames are
// skipped while too many datagrams wait to be written (a snapshot goes out as SNAPSHOT_DATAGRAM_COPIES datagrams), and a session whose stream backlog passes 4 MB is closed, like a
// WebSocket that far behind, as is one whose stream fails a write.
import { Channel, SNAPSHOT_DATAGRAM_COPIES, countSent, makeTransportStats, type Path, type Transport } from "../shared/net/transport";
import { M } from "../shared/net/proto";
import { frame } from "../shared/net/frames";

/** datagrams waiting to be written above which unreliable frames are skipped */
const SKIP_PENDING_DATAGRAMS = 64;
/** queued stream bytes above which the session is closed */
const KILL_BACKLOG_BYTES = 4 * 1024 * 1024;

/** what the transport needs from a session (the @fails-components/webtransport session, narrowed) */
export interface WtSessionLike {
  datagrams: { maxDatagramSize: number };
  close(info?: { closeCode?: number; reason?: string }): void;
}
interface Writer { write(chunk: Uint8Array): Promise<void> }

export class WtTransport implements Transport {
  readonly kind = "wt" as const;
  readonly stats = makeTransportStats("wt");
  onMessage: (u8: Uint8Array, at: number, from: Path) => void = () => {};
  /** frames too big for one datagram, sent on the stream instead */
  oversize = 0;
  private pendingDatagrams = 0; private backlog = 0; private closed = false;
  readonly datagramPath: Path; readonly streamPath: Path;
  /** `ended`: the endpoint's cleanup (server/wt.ts), run once whoever closes the session, so the client goes back to
   *  its WebSockets and the session's slot is freed */
  constructor(private readonly session: WtSessionLike, private readonly dgram: Writer, private readonly stream: Writer, strike: (why: string) => void, private readonly ended: () => void) {
    this.datagramPath = { reply: (u8) => this.sendUnreliable(u8), strike };
    this.streamPath = { reply: (u8) => this.sendReliable(u8), strike };
  }
  sendReliable(u8: Uint8Array) {
    if (this.closed) return;
    countSent(this.stats, Channel.Reliable, u8.length);
    this.writeStream(u8);
  }
  sendUnreliable(u8: Uint8Array) {
    if (this.closed) return;
    countSent(this.stats, Channel.Unreliable, u8.length);
    if (u8.length > this.session.datagrams.maxDatagramSize) { this.oversize++; this.writeStream(u8); return; }
    if (this.pendingDatagrams >= SKIP_PENDING_DATAGRAMS) { this.stats.skipped++; return; }
    const copies = u8[0] === M.Snapshot ? SNAPSHOT_DATAGRAM_COPIES : 1;
    for (let k = 0; k < copies; k++) {
      this.pendingDatagrams++;
      this.dgram.write(u8.slice()).then(() => { this.pendingDatagrams--; }, () => { this.pendingDatagrams--; });
    }
  }
  private writeStream(u8: Uint8Array) {
    const f = frame(u8), n = f.length;
    if (this.backlog + n > KILL_BACKLOG_BYTES) { this.close("send backlog > 4 MB"); return; }
    this.backlog += n;
    // a stream that fails a write (the peer stopped reading it) loses every reliable frame after it: end the session
    this.stream.write(f).then(() => { this.backlog -= n; }, () => { this.backlog -= n; this.close("stream write failed"); });
  }
  /** an inbound frame on the datagram or stream path */
  receive(u8: Uint8Array, from: Path) {
    this.stats.recv++; this.stats.recvBytes += u8.length;
    this.onMessage(u8, performance.now(), from);
  }
  close(reason = "closed") {
    if (this.closed) return;
    this.closed = true;
    try { this.session.close({ closeCode: 0, reason }); } catch { /* gone */ }
    this.ended();
  }
}
