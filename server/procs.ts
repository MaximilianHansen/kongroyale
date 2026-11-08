// One server process per core (KR_PROCS, HOSTING.md "One process per core"): which match process owns a lobby code,
// and the messages between the front (server/front.ts) and its match processes (server/index.ts with KR_PROC set).
// With KR_PROCS unset or 1 the server is the single process it always was and nothing here routes anything.
import os from "node:os";

/** the characters of a lobby code (server/index.ts newCode) */
export const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** a lobby code as a player or a URL gives it: upper case, letters and digits, at most 8 */
export const lobbyCode = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
/** match processes: KR_PROCS, "auto" for one per core; 1 (the default) is one process that is also the front. At most
 *  one per code character, so every process owns some codes */
export const PROCS = Math.max(1, Math.min(CODE_CHARS.length, process.env.KR_PROCS === "auto" ? os.availableParallelism() : Math.floor(Number(process.env.KR_PROCS) || 1)));
/** this match process's index under a front (0..PROCS-1); -1 for a single process, and for the front itself */
export const PROC = process.env.KR_PROC === undefined ? -1 : Number(process.env.KR_PROC);
/** the WebTransport URL a match process tells its players (KR_WT_URL): process i listens on KR_WT_PORT + i, so its URL's
 *  port moves by i too */
export const procWtUrl = (url: string | undefined, i = PROC) => {
  if (!url || i <= 0) return url;
  const u = new URL(url); u.port = String(Number(u.port || 443) + i); return u.href;
};
/** the match process that owns a lobby code: its first character's place in CODE_CHARS, modulo the process count. A
 *  process only mints codes it owns, so the front routes a code without asking anyone */
export const procOf = (code: string, n = PROCS) => Math.max(0, CODE_CHARS.indexOf(code[0] ?? "")) % n;

/** what a match process tells the front about itself every PUSH_MS: its share of /health, and what the front needs to
 *  spread new rooms and to hold the per-address room cap across processes */
export interface ProcHealth {
  lobbies: number; clients: number; sockets: number;
  /** rooms players have made here since it started: the front matches them against the rooms it sent here */
  made: number;
  /** rooms each address owns here, for the per-address room cap across processes */
  owners: Record<string, number>;
  /** WebTransport sessions each address holds here: the front tells the other processes, so the total and per-address
   *  caps count sessions on every process */
  wt: Record<string, number>;
  transports: Record<string, unknown>; inputs: unknown[]; performance?: unknown;
}
export const PUSH_MS = 500;
/** front → match process. "conn": a game WebSocket's TCP socket rides along as the handle, with the upgrade request it
 *  already read (base64) and the address the front counted it under. "owners": the rooms each address owns on the other
 *  processes, as they last reported, with their connections in total ("conns") and per address ("ips"): WebSockets and
 *  WebTransport sessions */
export type ToProc =
  | { t: "conn"; ip: string; raw: string }
  | { t: "owners"; n: Record<string, number>; conns: number; ips: Record<string, number> };
/** match process → front. "gone": a socket the front handed over has closed (the front's per-address count drops) */
export type ToFront =
  | { t: "health"; h: ProcHealth }
  | { t: "gone"; ip: string };
