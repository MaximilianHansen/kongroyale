// VERIFY AFK — an AFK removal in a normal lobby, against the REAL game server (server/index.ts) on a free loopback port
// over real WebSockets. Three raw clients in join order B, C, A: B creates the lobby (so it is the
// host) and starts the match, A plays (sends an input every tick), B and C send no input at all. The server's
// housekeeping (every 10 s of match time) finds B and C AFK in the same sweep after KR_AFK_S (2 s here; 180 s on a real
// server), so the host role has to skip C, who that sweep removes too, and land on A. A second lobby runs beside it with
// nobody playing (D the host, E): both are removed, the role stays with D, E's room frame says the host is away (its room
// screen then offers START, client/src/ui/lobby.ts), and E's START takes the role (Lobby.claimHost).
//
//   npx tsx tools/verify-afk.mts
//
// Passes when B is taken out of the match but kept in the room: an `error` "REMOVED FOR INACTIVITY" with `afk: true`
// (the client goes back to the room on it and keeps the reason on screen, client/src/game/index.ts), a room frame that
// still lists B with no seat, C removed the same way, the host role on A (so the room can START without B or C), B's
// snapshots stopped, A still seated and playing. Before the fix the server removed B from the lobby with an `error`, no afk flag and no room frame,
// so B's client froze on its last snapshot: this script fails there with "frozen". Exits 1 listing the reasons, 0 with
// a JSON summary.
import { spawn } from "node:child_process";
import net from "node:net";
import { WebSocket } from "ws";
import { M, Writer, writeInput } from "../shared/net/proto";
import { makeInput } from "../shared/sim/player";

const AFK_S = 2, LIMIT_MS = 120_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: { ...process.env, KR_EVENT_MODE: "0", KR_PORT: String(port), KR_HOST: "127.0.0.1", KR_WARMUP_S: "120", KR_AFK_S: String(AFK_S) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; server.stdout!.on("data", (d) => { log += d; }); server.stderr!.on("data", (d) => { log += d; });
const problems: string[] = [];
const peers: Peer[] = []; let drive: ReturnType<typeof setInterval> | undefined;
const until = async (f: () => boolean, what: string, ms = LIMIT_MS) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw Error("timeout: " + what); await sleep(20); } };

interface Peer { name: string; ws: WebSocket; uid: number; code: string; pid: number; snaps: number; json: Record<string, unknown>[] }
function connect(name: string): Peer {
  const p: Peer = { name, ws: new WebSocket("ws://127.0.0.1:" + port + "/ws"), uid: 0, code: "", pid: -1, snaps: 0, json: [] };
  p.ws.on("message", (data: Buffer, binary: boolean) => {
    if (binary) { if (data[0] === M.Snapshot) p.snaps++; return; }
    const j = JSON.parse(String(data)) as Record<string, unknown>; p.json.push(j);
    if (j.t === "welcome") p.uid = j.uid as number;
    if (j.t === "lobby") p.code = j.code as string;
    if (j.t === "match") p.pid = (j.pids as Record<string, number>)[p.uid] ?? -1;
  });
  p.ws.on("error", (e) => problems.push(name + ": socket error " + e.message));
  peers.push(p); return p;
}

try {
  await until(() => /KONG ROYALE server on/.test(log), "server start");
  const B = connect("B"); await until(() => B.uid > 0, "B welcome");
  B.ws.send(JSON.stringify({ t: "hello", name: "AFK B" })); B.ws.send(JSON.stringify({ t: "create", mode: "trios" }));
  await until(() => !!B.code, "B's lobby");
  const C = connect("C"); await until(() => C.uid > 0, "C welcome");
  C.ws.send(JSON.stringify({ t: "hello", name: "AFK C" })); C.ws.send(JSON.stringify({ t: "join", code: B.code }));
  await until(() => C.code === B.code, "C joins");
  const A = connect("A"); await until(() => A.uid > 0, "A welcome");
  A.ws.send(JSON.stringify({ t: "hello", name: "PLAYER A" })); A.ws.send(JSON.stringify({ t: "join", code: B.code }));
  await until(() => A.code === B.code, "A joins");
  B.ws.send(JSON.stringify({ t: "start" }));
  await until(() => A.pid >= 0 && B.pid >= 0 && C.pid >= 0, "all three seated");
  const D = connect("D"); await until(() => D.uid > 0, "D welcome");
  D.ws.send(JSON.stringify({ t: "hello", name: "AFK D" })); D.ws.send(JSON.stringify({ t: "create", mode: "trios" }));
  await until(() => !!D.code, "D's lobby");
  const E = connect("E"); await until(() => E.uid > 0, "E welcome");
  E.ws.send(JSON.stringify({ t: "hello", name: "AFK E" })); E.ws.send(JSON.stringify({ t: "join", code: D.code }));
  await until(() => E.code === D.code, "E joins");
  D.ws.send(JSON.stringify({ t: "start" }));
  await until(() => D.pid >= 0 && E.pid >= 0, "D and E seated");
  // A plays: one input per 60 Hz tick; B and C never send one
  const w = new Writer(new ArrayBuffer(64)), inp = makeInput(); let seq = 0;
  drive = setInterval(() => { inp.seq = ++seq; inp.mz = 1; writeInput(w.reset(), inp); A.ws.send(w.view()); }, 1000 / 60);
  const removedAt = (p: Peer) => p.json.findIndex((j) => j.t === "error" && j.msg === "REMOVED FOR INACTIVITY");
  const removed = () => removedAt(B);
  await until(() => removed() >= 0 && removedAt(C) >= 0 && removedAt(D) >= 0 && removedAt(E) >= 0, "B, C, D and E removed for inactivity", 40_000);
  await sleep(1500);
  const i = removed(), err = B.json[i], after = B.json.slice(i + 1);
  const room = [...B.json].reverse().find((j) => j.t === "lobby") as { host: number; inMatch: boolean; players: { id: number; pid: number }[] } | undefined;
  const snapsAt = B.snaps; await sleep(1000); const snapsLater = B.snaps - snapsAt;
  const aSnaps = A.snaps; await sleep(500); const aLive = A.snaps - aSnaps;
  clearInterval(drive);
  const hostOf = (p: Peer) => ([...p.json].reverse().find((j) => j.t === "lobby") as { host: number } | undefined)?.host;
  const idleHost = hostOf(E), awayFlag = ([...E.json].reverse().find((j) => j.t === "lobby") as { hostAway?: boolean } | undefined)?.hostAway;
  if (idleHost !== D.uid) problems.push("with nobody playing the host role should stay with D until someone asks (host " + idleHost + ", D is " + D.uid + ")");
  if (awayFlag !== true) problems.push("E's room frame does not say the host is away, so its room screen offers no START");
  E.ws.send(JSON.stringify({ t: "start" }));
  await until(() => hostOf(E) === E.uid, "E's START takes the host role from away D", 5_000).catch(() => problems.push("E's START did not take the host role from away D (host " + hostOf(E) + ")"));
  if (C.json[removedAt(C)].afk !== true) problems.push("C's removal has no afk flag");
  if (room?.players.find((p) => p.id === C.uid)?.pid !== -1) problems.push("C is not in the room frame without a seat");
  if (err.afk !== true) problems.push("frozen: the removal has no afk flag, so the client stays on its match");
  const me = room?.players.find((p) => p.id === B.uid);
  if (!room || !me) problems.push("frozen: no room frame lists B any more, so its client has nowhere to go");
  else {
    if (me.pid !== -1) problems.push("B still holds seat " + me.pid + " in the room frame");
    if (room.host !== A.uid) problems.push("the host role stayed on the AFK player (host " + room.host + ", A is " + A.uid + ")");
    if (!room.inMatch) problems.push("the room frame says no match is running, but A is still playing");
  }
  if (snapsLater > 0) problems.push("B still gets snapshots after its removal (" + snapsLater + " in 1 s)");
  if (aLive === 0) problems.push("A's match stopped");
  if (B.ws.readyState !== WebSocket.OPEN) problems.push("B's socket was closed");
  const summary = { afk: err.afk === true, roomListsB: !!me, bSeat: me?.pid ?? null, hostIsA: room?.host === A.uid, cSeat: room?.players.find((p) => p.id === C.uid)?.pid ?? null, idleHostIsD: idleHost === D.uid, hostAway: awayFlag === true, claimedByE: hostOf(E) === E.uid, framesAfterError: after.map((j) => j.t), bSnapsAfter: snapsLater, aSnapsIn500ms: aLive };
  if (problems.length) { console.error("VERIFY AFK FAILED:\n  " + problems.join("\n  ") + "\n" + JSON.stringify(summary)); process.exitCode = 1; }
  else console.log("VERIFY AFK PASSED " + JSON.stringify(summary));
} catch (e) {
  console.error("VERIFY AFK FAILED: " + (e as Error).message + "\n" + log.split("\n").slice(-15).join("\n")); process.exitCode = 1;
} finally {
  clearInterval(drive);
  for (const p of peers) p.ws.terminate();
  server.kill("SIGTERM");
}
