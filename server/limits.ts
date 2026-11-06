// Per-path rate limits of the game server, one implementation for every transport: a token bucket per WebSocket
// (server/index.ts) and per WebTransport session (server/wt.ts), and the strike count that closes a misbehaving path.
/** frames per second a path may send on average; inputs are 60/s and a TCP stall releases a burst of queued inputs */
export const RATE_PER_S = 150, RATE_BURST = 400;
/** rate-limited or malformed frames before the path is closed */
export const MAX_STRIKES = 400;

export interface Bucket { tokens: number; refill: number; strikes: number; lastMsg: number }
export const makeBucket = (): Bucket => ({ tokens: RATE_BURST, refill: performance.now(), strikes: 0, lastMsg: Date.now() });
/** one frame arrived: true = within the rate (a token is spent) */
export function take(b: Bucket): boolean {
  const now = performance.now();
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.refill) / 1000) * RATE_PER_S); b.refill = now; b.lastMsg = Date.now();
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}
/** count a strike; true = the path is over MAX_STRIKES and must close */
export function struck(b: Bucket, weight = 1): boolean { b.strikes += weight; return b.strikes > MAX_STRIKES; }
