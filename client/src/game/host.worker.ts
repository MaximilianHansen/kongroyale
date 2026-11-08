// The practice host worker (?hostworker=1): an offline practice match's authoritative host, off the main thread. It
// builds the static world from the same baked island file with the same recipe as the page and the server
// (shared/sim/static-world.ts) plus the loot spots, says ready with the world hash (the page uses this worker only when
// the hash equals its own world's), then runs one OfflineLink per practice session, the class that runs in the tab
// without the flag. Everything the link sends the page (JSON and binary frames, in order) leaves in one message per
// task, at the end of the task (a microtask), with the binary buffers transferred. Page side: ./host-worker.ts.
import { decodeTerrainFile } from "../../../shared/world/terrain-gen";
import { Terrain } from "../../../shared/world/terrain";
import { buildStaticWorld } from "../../../shared/sim/static-world";
import { lootSpots } from "../../../shared/sim/loot-spots";
import type { StaticWorld } from "../../../shared/sim/world";
import type { Match } from "../../../shared/sim/match";
import type { ReplayRecorder } from "../../../shared/net/replay";
import { OfflineLink, type PracticeEnv } from "./net";
import { copyView } from "./host-tools";
import type { FromHost, ToHost, OutItem, RecPart } from "./host-worker";

const post = (m: FromHost, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
/** the host's view copy goes to the page at most this often while a tool reads it (ticks) */
const VIEW_EVERY_TICKS = 6;

let world: StaticWorld | null = null;
let session: { sid: number; link: OfflineLink; streamed: boolean; record: boolean; watch: boolean; viewTick: number } | null = null;
let rec: { src: { rec: ReplayRecorder; match: Match } | null; sent: number; tick: number; reset: boolean } = { src: null, sent: 0, tick: -1, reset: false };
let items: OutItem[] = [], transfer: Transferable[] = [], scheduled = false, busyMs = 0;

function out(item: OutItem, buf?: ArrayBuffer) {
  items.push(item); if (buf) transfer.push(buf);
  if (!scheduled) { scheduled = true; queueMicrotask(flush); }
}

function flush() {
  scheduled = false;
  const s = session; if (!s) { items = []; transfer = []; return; }
  let part: RecPart | undefined;
  const src = rec.src;
  // (the tick goes too when no event is new: the page's log must end where the match it accompanies is)
  if (rec.reset || (src && (src.rec.events.length > rec.sent || src.match.tick !== rec.tick))) {
    part = src ? { opts: rec.reset ? src.rec.opts : undefined, events: src.rec.events.slice(rec.sent), ticks: src.match.tick, warmupS: src.match.warmupS, endAfterResults: src.match.endAfterResults } : null;
    rec.reset = false; rec.sent = src ? src.rec.events.length : 0; rec.tick = src ? src.match.tick : -1;
  }
  const m = s.link.match;
  const view = s.watch && m && m.tick - s.viewTick >= VIEW_EVERY_TICKS ? (s.viewTick = m.tick, copyView(m)) : undefined;
  post({ k: "out", sid: s.sid, items, rec: part, view, busyMs }, transfer);
  items = []; transfer = [];
}

function open(d: Extract<ToHost, { k: "open" }>) {
  session?.link.close();
  const s = { sid: d.sid, streamed: d.streamed, record: d.record, watch: false, viewTick: -1e9, link: null as unknown as OfflineLink };
  const env: PracticeEnv = {
    seed: () => d.seed,
    recordReplay: () => s.record,
    streamed: () => s.streamed,
    replay: (src) => { rec = { src, sent: 0, tick: -1, reset: true }; },
  };
  const link = s.link = new OfflineLink(world!, d.name, d.botDamageToHumans, d.botAimRange, d.range, d.difficulty, false, env);
  link.onJSON = (m) => { if (session === s) out([0, m]); };
  link.onBinary = (u8, at) => { if (session === s) out([1, u8, at], u8.buffer as ArrayBuffer); };
  link.onClose = () => {};
  const pump = link.pump.bind(link);
  link.pump = () => { const t = performance.now(); pump(); busyMs += performance.now() - t; };
  session = s;
}

self.onmessage = async (ev: MessageEvent<ToHost>) => {
  const d = ev.data;
  if (d.k === "build") {
    try {
      const t0 = performance.now();
      const r = await fetch(d.url, { cache: "no-cache" });
      if (!r.ok) throw new Error(`island.bin ${r.status}`);
      const td = decodeTerrainFile(await r.arrayBuffer());
      const built = await buildStaticWorld(new Terrain(td.heights, td.biome), td);
      lootSpots(built.world);
      world = built.world;
      post({ k: "ready", hash: built.hash, origin: performance.timeOrigin, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      post({ k: "failed", error: String(e instanceof Error ? e.stack || e.message : e) });
    }
    return;
  }
  if (d.k === "open") { open(d); return; }
  const s = session;
  if (!s || d.sid !== s.sid) return;
  switch (d.k) {
    case "json": s.link.sendJSON(d.o); break;
    case "bin": s.link.sendBinary(new Uint8Array(d.buf)); break;
    case "env": s.streamed = d.streamed; s.record = d.record; break;
    case "tool": s.link.hostTool(d.t); break;
    case "watch": s.watch = true; s.viewTick = -1e9; break;
    case "close": s.link.close(); session = null; rec = { src: null, sent: 0, tick: -1, reset: false }; items = []; transfer = []; break;
  }
};
