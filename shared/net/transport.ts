// The binary link between a player and the host, the same shape on the client and the server. A Transport carries the
// hot path (inputs, pings, snapshots, events, inventory); JSON (lobby, welcome, results, voice relay) stays on the
// primary WebSocket, which is the control channel for every transport. Implementations: client/src/game/net.ts and
// server/transport-ws.ts (WebSocket, the redundant primary + aux pair), server/transport-wt.ts (WebTransport: QUIC
// datagrams + one reliable stream). Types and pure helpers only: shared/ stays
// free of DOM and Node APIs. Which channel a frame takes is decided here and nowhere else (channelOf).
//
// Ordering rules live with the receivers, not the transport, because every transport needs them: ClientMatch keeps the
// newest snapshot / events tick, inventory seq and pong; MatchHost and Match.pushInput keep each input and inventory op
// seq once. That is what lets the WebSocket transport send every frame on two sockets (first copy wins), and an
// unreliable transport deliver frames late, out of order or not at all.
import { M } from "./proto";

export const enum Channel { Reliable = 0, Unreliable = 1 }
/** how a frame travels. Unreliable frames are newest-wins (a later one replaces a lost one); every other frame must
 *  arrive, in order. A single input (M.Input) is reliable: each one is needed once. The input window (M.Inputs) is
 *  unreliable: the next window carries every input a lost one did. Caster snapshots stay reliable: they carry every
 *  player (often more than one datagram holds) and a commentator seat favours a complete picture over the lowest
 *  latency */
export function channelOf(type: number): Channel {
  return type === M.Inputs || type === M.Ping || type === M.Pong || type === M.Snapshot ? Channel.Unreliable : Channel.Reliable;
}

export type TransportKind = "ws" | "wt";
/** why a link that could have used WebTransport stayed on (or went back to) the WebSockets */
export type FallbackReason = "flag-off" | "server-off" | "unsupported" | "connect-failed" | "timeout" | "auth" | "closed" | "no-datagrams";
export const FALLBACK_REASONS: readonly FallbackReason[] = ["flag-off", "server-off", "unsupported", "connect-failed", "timeout", "auth", "closed", "no-datagrams"];
/** a link's arm in the WebTransport A/B (KR_WT_SHARE, HOSTING.md): "wt" or "ws" as the server assigned it (a tab keeps
 *  its first one for its session), "forced-wt" / "forced-ws" when the page's ?wt=1 / ?wt=0 overrode it, "off" when the
 *  server offered no WebTransport. Only "wt" and "ws" are the experiment */
export type WtArm = "wt" | "ws" | "forced-wt" | "forced-ws" | "off";
export const WT_ARMS: readonly WtArm[] = ["wt", "ws", "forced-wt", "forced-ws", "off"];

/** per-transport counters, the same fields for every kind, so sessions compare across transports */
export interface TransportStats {
  kind: TransportKind;
  /** frames handed to the transport, by Channel */
  sent: [number, number];
  sentBytes: [number, number];
  /** frames delivered to onMessage (every copy, before the receiver's ordering rules) */
  recv: number;
  recvBytes: number;
  /** frames the transport chose not to send (a backed-up or stalled link) */
  skipped: number;
}
export const makeTransportStats = (kind: TransportKind): TransportStats => ({ kind, sent: [0, 0], sentBytes: [0, 0], recv: 0, recvBytes: 0, skipped: 0 });
/** count one outgoing frame */
export function countSent(s: TransportStats, ch: Channel, bytes: number) { s.sent[ch]++; s.sentBytes[ch] += bytes; }

/** where an inbound frame came from: an answer goes back the same way (pongs), a malformed frame is blamed on it */
export interface Path {
  reply(u8: Uint8Array): void;
  strike(why: string): void;
}

export interface Transport {
  readonly kind: TransportKind;
  readonly stats: TransportStats;
  /** ordered, never lost. `u8` is only valid during the call: the transport copies it if it queues */
  sendReliable(u8: Uint8Array): void;
  /** newest wins: may be dropped, never resent. On "ws" it rides the reliable sockets */
  sendUnreliable(u8: Uint8Array): void;
  /** one binary frame from the peer; `at` = arrival time on the performance.now() clock */
  onMessage: (u8: Uint8Array, at: number, from: Path) => void;
  close(): void;
}

/** datagrams each snapshot goes out as (server/transport-wt.ts; tools/netlab.mts models the same). A lost snapshot
 *  datagram is never resent, and the gap it leaves made remotes hold in place (netlab, 150 ms, 1% loss: 0.6% of frames
 *  with one copy, 0 with two). Two copies cost what the WebSocket pair already does: every frame on both sockets */
export const SNAPSHOT_DATAGRAM_COPIES = 2;
/** send a frame on the channel its type travels on */
export function sendFrame(t: Transport, u8: Uint8Array) {
  if (channelOf(u8[0]) === Channel.Unreliable) t.sendUnreliable(u8); else t.sendReliable(u8);
}
