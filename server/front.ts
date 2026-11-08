// The front of a multi-process server (KR_PROCS > 1, HOSTING.md "One process per core"). A match runs on one core:
// every lobby's tick, its sockets and its WebTransport sessions share one process's main thread, so one process holds a
// few matches however many cores the machine has. The front forks KR_PROCS match processes (server/index.ts with
// KR_PROC set) and keeps the one public port. It serves the site itself (server/site.ts: the client, /health summed
// over the processes, bug reports) and hands each game WebSocket, with the upgrade request it read and
// nothing more, to the process that owns it: ?p=N (a player's aux socket) to process N, ?room=CODE to the process the
// code belongs to (server/procs.ts procOf), anything else (a player who will create a room) to the process with the
// fewest players. Each process listens for WebTransport on its own UDP port, KR_WT_PORT + its index, and its "welcome"
// says which. The front counts every game WebSocket against KR_MAX_CONNS and KR_MAX_PER_IP across all processes. A process that exits is started again after a second.
import { fork, type ChildProcess } from "node:child_process";
import http from "node:http";
import type net from "node:net";
import { ipOf } from "./addr";
import { MAX_CONNS, MAX_CONNS_PER_IP } from "./limits";
import { PROCS, lobbyCode, procOf, type ProcHealth, type ToFront, type ToProc } from "./procs";
import { createSite } from "./site";

const RESTART_MS = 1000;
/** a pick whose player made no room within this long (they left, or joined one by code) stops counting */
const PICK_FORGET_MS = 10_000;

interface Proc {
  i: number; child: ChildProcess | null; pid: number;
  /** its last report; null until its world is built (it takes no players before) and after it exits */
  health: ProcHealth | null;
  /** game WebSockets handed to it and not yet closed, by address */
  held: Map<string, number>;
  /** when it was picked for each new room its reports don't hold yet (oldest first), and how many rooms its last report
   *  said players have made there */
  picked: number[]; made: number;
  /** the rooms by address on the other processes it was last sent (JSON), so an unchanged map isn't sent again */
  ownersSent: string;
}

export async function runFront(o: { root: string; port: number; host: string; serve: boolean; log(...a: unknown[]): void }) {
  const { log } = o;
  const procs: Proc[] = Array.from({ length: PROCS }, (_, i) => ({ i, child: null, pid: 0, health: null, held: new Map(), picked: [], made: 0, ownersSent: "" }));
  /** game WebSockets held across all processes, in total and by address */
  let open = 0;
  const perIp = new Map<string, number>();
  const count = (p: Proc, ip: string, d: number) => {
    open += d;
    for (const m of [perIp, p.held]) { const n = (m.get(ip) ?? 0) + d; if (n > 0) m.set(ip, n); else m.delete(ip); }
  };
  let stopping = false;

  function spawn(p: Proc) {
    const child = fork(process.argv[1], process.argv.slice(2), { env: { ...process.env, KR_PROC: String(p.i) }, execArgv: process.execArgv });
    p.child = child; p.pid = child.pid ?? 0;
    child.on("message", (m: ToFront) => {
      if (m.t === "health") { p.picked.splice(0, Math.max(0, m.h.made - p.made)); p.made = m.h.made; p.health = m.h; shareOwners(); announce(); }
      else if (m.t === "gone") count(p, m.ip, -1);
    });
    child.on("exit", (code, sig) => {
      if (p.child !== child) return;
      p.child = null; p.health = null; p.picked = []; p.made = 0; p.ownersSent = ""; shareOwners();
      for (const [ip, n] of [...p.held]) count(p, ip, -n);
      if (stopping) { if (procs.every((q) => !q.child)) process.exit(0); return; }
      log(`match process ${p.i} exited (${sig ?? code}); starting it again`);
      setTimeout(() => spawn(p), RESTART_MS);
    });
  }
  for (const p of procs) spawn(p);

  /** each process gets the rooms every address owns on the others, so MAX_LOBBIES_PER_IP holds across processes. It
   *  lags by one report: rooms one address makes on several processes within PUSH_MS can pass it, once */
  function shareOwners() {
    for (const q of procs) {
      if (!q.child?.connected) continue;
      const n: Record<string, number> = {}, ips: Record<string, number> = {};
      let conns = 0;
      for (const p of procs) {
        if (p === q || !p.health) continue;
        for (const [ip, k] of Object.entries(p.health.owners)) n[ip] = (n[ip] ?? 0) + k;
        for (const [ip, k] of Object.entries(p.health.wt)) { ips[ip] = (ips[ip] ?? 0) + k; conns += k; }
        for (const [ip, k] of p.held) { ips[ip] = (ips[ip] ?? 0) + k; conns += k; }
      }
      const s = JSON.stringify([n, conns, ips]);
      if (s !== q.ownersSent) { q.ownersSent = s; q.child.send({ t: "owners", n, conns, ips } satisfies ToProc); }
    }
  }

  /** a process ready for players with the fewest lobbies, counting the rooms it was picked for that its reports don't
   *  hold yet (a report comes every PUSH_MS, and a loaded process takes a while to make the room, so without them rooms
   *  made in a burst bunch up on the process that last reported the fewest). Equal ones take turns */
  let turn = 0;
  function pick(): Proc | null {
    let best: Proc | null = null;
    const now = Date.now(), load = (p: Proc) => { p.picked = p.picked.filter((t) => now - t < PICK_FORGET_MS); return p.health!.lobbies + p.picked.length; };
    for (let k = 0; k < procs.length; k++) { const p = procs[(turn + k) % procs.length]; if (p.health && (!best || load(p) < load(best))) best = p; }
    turn = (turn + 1) % procs.length;
    best?.picked.push(now);
    return best;
  }
  /** /health: the processes' reports summed (clients, sockets, transports' counters), their WebTransport ports, and
   *  each process's own line */
  function health() {
    const up = procs.filter((p) => p.health).map((p) => p.health!);
    const transports: Record<string, unknown> = {};
    for (const h of up) addInto(transports, h.transports);
    // counts add up; the port and the A/B share are settings, the same in every process (each listens on its own port)
    const wts = up.map((h) => h.transports.webtransport as { port?: number; share?: number } | undefined).filter((w) => typeof w?.port === "number");
    if (wts.length) Object.assign(transports.webtransport as object, { port: wts[0]!.port, ports: wts.map((w) => w!.port), share: wts[0]!.share });
    const sum = (k: "lobbies" | "clients" | "sockets") => up.reduce((n, h) => n + h[k], 0);
    // not ok (and 503) while any match process is down: the rooms whose codes it owns can't be reached
    return {
      ok: procs.every((p) => p.health), lobbies: sum("lobbies"), clients: sum("clients"), sockets: sum("sockets"), transports, inputs: up.flatMap((h) => h.inputs),
      procs: procs.map((p) => ({ proc: p.i, pid: p.pid, up: !!p.health, lobbies: p.health?.lobbies ?? 0, clients: p.health?.clients ?? 0, sockets: p.health?.sockets ?? 0, ...(p.health?.performance ? { performance: p.health.performance } : {}) })),
    };
  }

  const site = createSite({ root: o.root, serve: o.serve, health, log });
  const server = http.createServer(site.handle);
  server.headersTimeout = 20_000; server.requestTimeout = 60_000;
  server.on("upgrade", (req, socket, head) => {
    const refuse = (code: number, text: string) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ } socket.destroy(); };
    const [url, query = ""] = (req.url || "/").split("?");
    if (url !== "/ws") { refuse(404, "Not Found"); return; }
    const q = new URLSearchParams(query), n = Number(q.get("p") ?? NaN), room = lobbyCode(q.get("room"));
    const p = Number.isInteger(n) && n >= 0 && n < procs.length ? procs[n] : room ? procs[procOf(room)] : pick();
    const ip = ipOf(req);
    if (!p?.child?.connected || !p.health || open >= MAX_CONNS || (perIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) { refuse(503, "Service Unavailable"); return; }
    // the request again, byte for byte as the process's own HTTP server would have read it, then whatever followed it
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    const bytes = Buffer.concat([Buffer.from(raw + "\r\n", "latin1"), head]);
    count(p, ip, 1);
    (socket as net.Socket).pause();
    p.child.send({ t: "conn", ip, raw: bytes.toString("base64") } satisfies ToProc, socket as net.Socket, (e) => { if (e) { count(p, ip, -1); socket.destroy(); } });
  });

  function shutdown(sig: string) {
    if (stopping) return;
    stopping = true; log(`${sig}: shutting down ${PROCS} match processes`);
    site.close(); server.close();
    for (const p of procs) p.child?.kill("SIGTERM");
    if (procs.every((p) => !p.child)) process.exit(0);
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on("SIGINT", () => shutdown("SIGINT")); process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => log("uncaught", e));
  process.on("unhandledRejection", (e) => log("unhandled rejection", e));
  // the line tools and HOSTING.md wait for, once the port is open and every process has built its world
  let listening = false, announced = false;
  function announce() {
    if (announced || !listening || !procs.every((p) => p.health)) return;
    announced = true;
    const wtBase = Number(process.env.KR_WT_PORT || o.port);
    log(`KONG ROYALE server on ${o.host}:${o.port} (${o.serve ? "serving dist/ + /ws" : "ws only"}) · ${PROCS} match processes${process.env.KR_WT !== "1" ? "" : `, WebTransport on UDP ${wtBase}-${wtBase + PROCS - 1}`}`);
  }
  server.listen(o.port, o.host, () => { listening = true; announce(); });
}

/** numbers summed into a, key by key and object by object; anything else keeps the first value seen */
function addInto(a: Record<string, unknown>, b: Record<string, unknown>) {
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === "number") a[k] = (typeof a[k] === "number" ? (a[k] as number) : 0) + v;
    else if (v && typeof v === "object" && !Array.isArray(v)) addInto((a[k] ??= {}) as Record<string, unknown>, v as Record<string, unknown>);
    else if (!(k in a)) a[k] = v;
  }
}
