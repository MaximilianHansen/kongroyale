// Runtime invariants for development and CI, behind ?invariants (main.ts loads this chunk only with the flag). Today
// one invariant, "a location is never invisible" (engine/invariants.hot.ts): every frame, each POI in view that has
// been drawn by its built model, a far impostor or an HLOD proxy must stay drawn by them. A violation goes to
// __kr.errors as one "[invariant] ..." line naming the POI and the frame it began, and to __kr.invariants for scripts:
// tools/verify-invariants.mts flies and teleports through the swap ranges on a software renderer and fails on any.
import type * as THREE from "three";
import type { Engine } from "./engine";
import { POIS } from "../../../shared/world/map";
import { scanPois, type PoiWatch } from "./invariants.hot";

/** the height (m) above a POI's pad its view sphere covers: the same box the low-memory stream's view test uses */
const VIEW_H_M = 300;
/** coverage a drawn POI must keep: a hand-over that leaves less than half its pixels drawn reads as it vanishing */
const COVER_MIN = 0.5;

/** one gap: the frame it began, how many frames it lasted (0 while it lasts) and the lowest coverage in it */
export interface Violation {
  id: string; frame: number; frames: number; distM: number; frameMs: number;
  cover: number; near: number; impostor: number; hlod: number;
  /** what stands for the POI inside the view, shown or not: "impostor", "hlod", "model" */
  inView: string[];
}
/** __kr.invariants: frames checked, the coverage a POI must keep, frames each POI was checked, frames it was drawn by
 *  its impostor and HLOD proxies alone, and every gap */
export interface InvariantReport { frames: number; floor: number; seen: Record<string, number>; farSeen: Record<string, number>; violations: Violation[] }

/** `roots`: a POI's model roots ([] while not built); `modules`: the built module list, whose identity changes on every
 *  build and eviction (__kr.modules) */
export function installInvariants(engine: Engine, roots: (id: string) => THREE.Object3D[], modules: () => unknown, report: (where: string, e: unknown) => void): InvariantReport {
  const pois = POIS.filter((p) => p.id !== "lobby-islet"), n = pois.length;
  const open = new Map<number, Violation>();
  const w: PoiWatch = {
    ids: pois.map((p) => "poi:" + p.id),
    cx: Float64Array.from(pois, (p) => p.x), cy: Float64Array.from(pois, (p) => (p.padY ?? 0) + VIEW_H_M / 2), cz: Float64Array.from(pois, (p) => p.z),
    cr: Float64Array.from(pois, (p) => Math.hypot(p.r, VIEW_H_M / 2)),
    roots: pois.map(() => []), impostors: pois.map(() => null),
    near: new Float32Array(n), imp: new Float32Array(n), hlod: new Float32Array(n), dist: new Float32Array(n),
    since: new Float64Array(n).fill(-1), seen: new Float64Array(n), farSeen: new Float64Array(n), inView: new Uint8Array(n), shownOnce: new Uint8Array(n), low: new Float32Array(n), floor: COVER_MIN,
    isBuilt: (id) => engine.isBuilt(id),
    onBad(i, frame) {
      const r2 = (x: number) => Math.round(x * 100) / 100;
      const v: Violation = {
        id: w.ids[i], frame, frames: 0, distM: Math.round(w.dist[i]), frameMs: Math.round(engine.frameMs[(engine.frameCount + engine.frameMs.length - 1) % engine.frameMs.length]),
        cover: r2(w.low[i]), near: r2(w.near[i]), impostor: r2(w.imp[i]), hlod: r2(w.hlod[i]),
        inView: ["impostor", "hlod", "model"].filter((_, b) => w.inView[i] & (1 << b)),
      };
      open.set(i, v);
      out.violations.push(v);
      const state = (x: number) => (x < 0 ? "none" : x.toFixed(2));
      report("invariant", `${v.id} drawn at ${v.cover.toFixed(2)} < ${w.floor} from frame ${frame}, ${v.distM} m away (model ${w.roots[i].length ? v.near.toFixed(2) : "not built"}, impostor ${state(v.impostor)}, hlod ${state(v.hlod)}; frame ${v.frameMs} ms)`);
    },
    onGood(i, frame) {
      const v = open.get(i);
      if (v) { v.frames = frame - v.frame; v.cover = Math.round(w.low[i] * 100) / 100; }
      open.delete(i);
    },
  };
  const out: InvariantReport = {
    frames: 0,
    get floor() { return w.floor; },
    set floor(x: number) { w.floor = x; },
    get seen() { return Object.fromEntries(w.ids.map((id, i) => [id, w.seen[i]])); },
    get farSeen() { return Object.fromEntries(w.ids.map((id, i) => [id, w.farSeen[i]])); },
    violations: [],
  };
  let seenModules: unknown, sceneKids = -1, impGroup: THREE.Object3D | null = null, impKids = -1;
  const sync = () => {
    seenModules = modules(); sceneKids = engine.scene.children.length;
    impGroup = engine.scene.children.find((o) => o.name === "far-merge-impostors") ?? null;
    impKids = impGroup?.children.length ?? -1;
    for (let i = 0; i < n; i++) {
      w.roots[i] = roots(w.ids[i]);
      w.impostors[i] = impGroup?.children.find((o) => o.name === "far-impostor:" + pois[i].id) ?? null;
    }
  };
  const update = engine.cull.update.bind(engine.cull);
  engine.cull.update = (camera, height) => {
    update(camera, height);
    if (engine.drawOverride || engine.contextLost) return;
    if (modules() !== seenModules || engine.scene.children.length !== sceneKids || (impGroup?.children.length ?? -1) !== impKids) sync();
    out.frames++;
    scanPois(w, camera, engine.scene, engine.cull, engine.far.pois, engine.occlusion.hidden, engine.frames);
  };
  return out;
}
