// The binary link between a player and the host, the same shape on the client and the server. A Transport carries the
// hot path (inputs, pings, snapshots, events, inventory); JSON (lobby, welcome, results, voice relay) stays on the
// primary WebSocket, which is the control channel for every transport. Implementations: client/src/game/net.ts and
// server/transport-ws.ts (WebSocket, today's redundant primary + aux pair). Types and pure helpers only: shared/ stays
// free of DOM and Node APIs. Which channel a frame takes is decided here and nowhere else (channelOf).
//
// Ordering rules live with the receivers, not the transport, because every transport needs them: ClientMatch keeps the
// newest snapshot / events tick, inventory seq and pong; MatchHost and Match.pushInput keep each input and inventory op
// seq once. That is what lets the WebSocket transport send every frame on two sockets (first copy wins), and an
// unreliable transport deliver frames late, out of order or not at all.
import { M } from "./proto";

export const enum Channel { Reliable = 0, Unreliable = 1 }
/** how a frame travels. Unreliable frames are newest-wins (a later one replaces a lost one); every other frame must
 *  arrive, in order. Caster snapshots stay reliable: they carry every player (often more than one datagram holds) and a
 *  commentator seat favours a complete picture over the lowest latency */
export function channelOf(type: number): Channel {
  return type === M.Input || type === M.Ping || type === M.Pong || type === M.Snapshot ? Channel.Unreliable : Channel.Reliable;
}

export type TransportKind = "ws";

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

/** send a frame on the channel its type travels on */
export function sendFrame(t: Transport, u8: Uint8Array) {
  if (channelOf(u8[0]) === Channel.Unreliable) t.sendUnreliable(u8); else t.sendReliable(u8);
}
