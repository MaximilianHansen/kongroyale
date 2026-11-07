// Frames on a byte stream: the WebTransport transport's reliable channel is one QUIC stream, which carries bytes, not
// messages, so each frame goes out as [length u16 LE][payload] and Deframer cuts the bytes back into frames. One
// implementation for the client (client/src/game/wt.ts), the server (server/transport-wt.ts) and the tools.
/** bytes in front of every frame */
export const FRAME_HEAD = 2;

/** a frame with its length in front (a new buffer: streams queue what they are given) */
export function frame(u8: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEAD + u8.length);
  out[0] = u8.length & 0xff; out[1] = u8.length >>> 8; out.set(u8, FRAME_HEAD);
  return out;
}

/** cuts a byte stream into frames. `max`: the longest frame accepted; a longer or empty one ends the stream (`bad`) */
export class Deframer {
  private buf = new Uint8Array(0);
  /** set once a frame broke the rules; push() then ignores everything */
  bad = false;
  constructor(private readonly max: number, private readonly onFrame: (u8: Uint8Array) => void) {}
  push(chunk: Uint8Array) {
    if (this.bad) return;
    let b = chunk;
    if (this.buf.length) { b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); }
    let o = 0;
    while (b.length - o >= FRAME_HEAD) {
      const n = b[o] | (b[o + 1] << 8);
      if (n === 0 || n > this.max) { this.bad = true; return; }
      if (b.length - o - FRAME_HEAD < n) break;
      this.onFrame(b.subarray(o + FRAME_HEAD, o + FRAME_HEAD + n));
      o += FRAME_HEAD + n;
      if (this.bad) return;
    }
    this.buf = b.slice(o);
  }
}
