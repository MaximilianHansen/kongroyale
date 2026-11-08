// Replays one recorded descent through the real lowmem residency code (client/src/low-mem.ts nextNearModule
// and trimStreamed) on a fake clock with a scripted camera: the plane at 720 m over peel-harbor and mango-market, a jump,
// a glide to mango that passes it at about 515 m on a 326 degree heading, turning to 10 degrees, down to the ground. A
// pick "builds" in BUILD_S seconds (default 2, about an M3 in Safari). Prints when each POI is picked, built and
// evicted, with the altitude, and which POIs are resident at 515 m and 437 m (the heights of the two recorded shots). Point it
// at another checkout's low-mem.ts to compare (a worktree of main sharing this node_modules):
//   npx tsx tools/performance/descent-residency.mts [path/to/low-mem.ts] [--out result.json]
import * as THREE from "three";
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2), outAt = args.indexOf("--out");
const outPath = outAt >= 0 ? args[outAt + 1] : null;
const lowMemPath = path.resolve(args.find((a, i) => !a.startsWith("--") && (outAt < 0 || i !== outAt + 1)) ?? new URL("../../client/src/low-mem.ts", import.meta.url).pathname);
let T = 0;
Object.defineProperty(globalThis, "performance", { value: { now: () => T, timeOrigin: 0 }, configurable: true });
const timers: Array<{ at: number; fn: () => void }> = [];
(globalThis as any).setTimeout = (fn: () => void, ms = 0) => { timers.push({ at: T + ms, fn }); return 0; };
(globalThis as any).setInterval = () => 0; (globalThis as any).clearInterval = () => {};
(globalThis as any).fetch = async () => { throw new Error("no network in the replay"); };
const runTimers = () => { for (let i = 0; i < timers.length; i++) if (timers[i].at <= T) { const t = timers.splice(i--, 1)[0]; t.fn(); } };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const { POIS } = await import("../../shared/world/map");
const kr: any = { game: { inMatch: true, cm: { phase: 1, pred: { st: 4 } } }, modules: [] };
(globalThis as any).__kr = kr;
const lm = await import(lowMemPath);
const { flag } = await import("../../client/src/flags");

const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.5, 6000);
const scene = new THREE.Scene();
const engine: any = { camera, scene, updates: [], updLabels: [], occlusion: { unregister() {} }, far: { pois: [], drop() {} },
  statics: { rootKey: "__s", entries: [], unfreeze() {} }, cull: { roots: [], drop() {}, stale: new Set(), touchedAt: new Map(), staleSince: new Map(), revealing: () => false } };
const modOf = new Map<string, any>(), scopeOf = new Map(), rootsOf = new Map<string, THREE.Object3D[]>(), loaded: any[] = [];
const world: any = { modOf, scopeOf, rootsOf, loaded, roots: (id: string) => rootsOf.get(id) ?? [], report: () => {}, build: async () => ({ integrated: Promise.resolve() }) };

// the path: plane at 720 m from (1300, 900) towards NW at 62 m/s, over peel-harbor then mango-market
const PLANE = { x: 1300, z: 900 }, dir = new THREE.Vector2(-1500, -1400).normalize(), PLANE_MPS = 62, PLANE_ALT = 720;
const JUMP_S = 9.5, GLIDE_MPS = 30, SINK_MPS = 9.5, PLANE_PHASE_S = 41, PITCH = -0.45;
const MANGO = POIS.find((p: any) => p.id === "mango-market")!;
const pos = { x: 0, y: PLANE_ALT, z: 0 }, st = { v: 4 };
let yaw = Math.atan2(-dir.x, -dir.y), turned = false, turnAt = 0;
function step(dt: number) {
  if (T / 1000 < JUMP_S) { const s = PLANE_MPS * T / 1000; pos.x = PLANE.x + dir.x * s; pos.z = PLANE.z + dir.y * s; st.v = 4; }
  else if (pos.y > 2) {
    st.v = 2;
    const toMango = Math.hypot(MANGO.x - pos.x, MANGO.z - pos.z);
    // to mango, then the recorded compass: about 326 degrees over mango, turning to about 10 degrees over 8 s, then held
    if (!turned && toMango < 40) { turned = true; turnAt = T; }
    const deg = turned ? Math.min(370, 326 + 44 * (T - turnAt) / 8000) : 0;
    yaw = turned ? -deg * Math.PI / 180 : Math.atan2(-(MANGO.x - pos.x), -(MANGO.z - pos.z));
    pos.x += -Math.sin(yaw) * GLIDE_MPS * dt; pos.z += -Math.cos(yaw) * GLIDE_MPS * dt; pos.y -= SINK_MPS * dt;
  } else st.v = 0;
  kr.game.cm.pred.st = st.v;
  kr.game.cm.phase = T / 1000 < PLANE_PHASE_S ? 1 : 2;
  camera.position.set(pos.x, pos.y + 2, pos.z);
  camera.rotation.set(PITCH, yaw, 0, "YXZ");
  camera.updateMatrixWorld(true); camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
}

const pending = POIS.filter((p: any) => p.id !== "lobby-islet").map((p: any) => "poi:" + p.id);
const streamMs: Record<string, number> = {};
const events: any[] = [], snaps: any[] = [];
const resident = () => [...modOf.keys()].filter((k) => k.startsWith("poi:")).map((k) => k.slice(4));
function build(id: string) { const mod = { id, release: async () => {} }; modOf.set(id, mod); loaded.push(mod); rootsOf.set(id, []); kr.modules = loaded.map((m) => m.id); }
// coconut-cove was built in the warm-up (the recorded log)
build("poi:coconut-cove"); streamMs["poi:coconut-cove"] = 1; pending.splice(pending.indexOf("poi:coconut-cove"), 1);
const BUILD_S = Number(process.env.BUILD_S || 2), DT = 0.05;
const now = () => ({ t: Math.round(T / 100) / 10, y: Math.round(pos.y), x: Math.round(pos.x), z: Math.round(pos.z), st: st.v, phase: kr.game.cm.phase });
let buildUntil = -1, building: string | null = null, picking: Promise<string> | null = null, shots = new Set<number>();
while (pos.y > 2 && T < 300_000) {
  T += DT * 1000; step(DT);
  for (const alt of [515, 437]) if (pos.y <= alt && !shots.has(alt)) { shots.add(alt); snaps.push({ alt, ...now(), yaw: Math.round(yaw * 1000) / 1000, resident: resident() }); }
  if (building && T >= buildUntil) { streamMs[building] = Math.round(BUILD_S * 1000); events.push({ ev: "built", id: building.slice(4), ...now() }); building = null; }
  if (building) continue;
  if (!picking) { const before = new Set(resident()); picking = lm.nextNearModule(pending, camera, POIS, flag("lowmemr"), flag("lowmemview")).then(async (id: string) => {
      events.push({ ev: "picked", id: id.slice(4), ...now() });
      await lm.trimStreamed(engine, world, id, pending, streamMs, POIS);
      for (const g of before) if (!modOf.has("poi:" + g)) events.push({ ev: "evicted", id: g, ...now() });
      build(id); building = id; buildUntil = T + BUILD_S * 1000; picking = null; return id; }); }
  runTimers(); await settle();
}
if (outPath) fs.writeFileSync(outPath, JSON.stringify({ lowMemPath, BUILD_S, events, snaps }, null, 1));
for (const e of events) console.log(JSON.stringify(e));
for (const s of snaps) console.log("SNAP", JSON.stringify(s));
process.exit(0);
