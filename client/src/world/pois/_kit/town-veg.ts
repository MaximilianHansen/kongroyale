// poi-town greenery: routes to the veg area's VegApi (ctx.shared "veg") when it exists, otherwise builds a FALLBACK
// palm / banana plant / bush into the POI's own bins so the POI's views are never bare. Fallback = temporary.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import type { VegApi, PlantKind } from "../../veg/api";
import { M, col, cylGeo, tubeGeo } from "./town-geo";
import { leafGeo } from "./town-building";
import type { TownBins } from "./town-materials";
import type { Pace } from "./pace";

export type TownPlant = PlantKind;

const PLANT_BATCH = 16;

export class TownVeg {
  private api: VegApi | undefined;
  private queue = new Map<PlantKind, THREE.Matrix4[]>();
  fallbacks = 0;
  constructor(private ctx: WorldCtx, private bins: TownBins, private rng: () => number) {
    this.api = ctx.shared.get("veg") as VegApi | undefined;
  }
  /** y = ground (terrain sampled when undefined) */
  plant(kind: TownPlant, x: number, z: number, yaw = 0, scale = 1, y?: number) {
    const gy = y ?? this.ctx.terrain.height(x, z);
    const m = M(x, gy, z, yaw, 0, 0, scale);
    if (this.api) {
      const k: PlantKind = kind;
      let q = this.queue.get(k); if (!q) this.queue.set(k, (q = []));
      q.push(m);
      return;
    }
    this.fallbacks++;
    if (kind === "palm" || kind === "palm-leaning" || kind === "jungle-tree") fallbackPalm(this.bins, m, this.rng);
    else if (kind === "banana-plant") fallbackBanana(this.bins, m, this.rng);
    else if (kind === "mangrove") fallbackMangrove(this.bins, m, this.rng);
    else if (kind === "monstera") fallbackMonstera(this.bins, m, this.rng);
    else if (kind === "grass" || kind === "flowers") fallbackBush(this.bins, m.clone().multiply(M(0, 0, 0, 0, 0, 0, 0.35)), this.rng, false);
    else fallbackBush(this.bins, m, this.rng, kind === "fern");
  }
  flush() { for (const _ of this.flushSteps()) void _; }
  async flushAsync(pace: Pace) { for (const _ of this.flushSteps()) { void _; await pace.pause(); } }
  private *flushSteps(): Generator<void> {
    if (!this.api) return;
    for (const [k, ms] of this.queue) { try { for (let i = 0; i < ms.length; i += PLANT_BATCH) { this.api.plant(k, ms.slice(i, i + PLANT_BATCH)); yield; } } catch (e) { console.warn("town-veg: veg.plant failed", k, e); } }
    this.queue.clear();
  }
}

function fallbackPalm(bins: TownBins, at: THREE.Matrix4, rng: () => number) {
  const h = 7 + rng() * 4, lean = (rng() - 0.5) * 0.6, dir = rng() * 6.28;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(new THREE.Vector3(Math.cos(dir) * lean * t * t * 3, t * h, Math.sin(dir) * lean * t * t * 3)); }
  const trunk = tubeGeo(pts, 0.22, 8, false, 18);
  // taper: scale radius by height
  const pos = trunk.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); const t = y / h; const c = new THREE.CatmullRomCurve3(pts).getPoint(Math.min(1, Math.max(0, t))); const k = 1.15 - 0.5 * t; pos.setXYZ(i, c.x + (pos.getX(i) - c.x) * k, y, c.z + (pos.getZ(i) - c.z) * k); }
  trunk.computeVertexNormals();
  bins.woodDark.add(trunk, at, col("#8a6a4a"), (x, y, z, b, o) => { const k = 0.85 + 0.3 * Math.abs(Math.sin(y * 3.7)); o.multiplyScalar(k); });
  const top = pts[6];
  const crown = at.clone().multiply(M(top.x, top.y, top.z));
  const nF = 17;
  for (let i = 0; i < nF; i++) {
    const a = i * Math.PI * 2 / nF + rng() * 0.3, tilt = 0.15 + (i % 3) * 0.35 + rng() * 0.4, len = 3.0 + rng() * 1.4;
    const g = frondGeo(len, 1.1 + rng() * 0.4);
    bins.leaf.add(g, crown.clone().multiply(M(0, 0, 0, a, 0, 0)).multiply(M(0, 0.1, 0, 0, -Math.PI / 2 + tilt)), col(rng() < 0.5 ? "#4f9a2e" : "#6fb63a"), (x, y, z, b, o) => { o.multiplyScalar(0.8 + 0.2 * Math.min(1, (y - top.y - at.elements[13]) / 2 + 0.6)); });
  }
  // coconuts
  for (let i = 0; i < 5; i++) bins.fruit.add(new THREE.SphereGeometry(0.16, 8, 6), crown.clone().multiply(M((rng() - 0.5) * 0.5, -0.2, (rng() - 0.5) * 0.5)), col("#8f7a3a"));
}
/** palm frond: central rib with paired leaflets, built as one folded strip with serrated look */
function frondGeo(len: number, wid: number): THREE.BufferGeometry {
  const n = 14, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, z = t * len, w = Math.sin(Math.min(1, t * 1.15) * Math.PI) ** 0.6 * wid / 2 * (i % 2 ? 1 : 0.62);
    const droop = -t * t * len * 0.5;
    pos.push(-w, droop - w * 0.5, z, 0, droop + 0.02, z, w, droop - w * 0.5, z);
    uv.push(0, t, 0.5, t, 1, t);
  }
  for (let i = 0; i < n; i++) { const a = i * 3; idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function fallbackBanana(bins: TownBins, at: THREE.Matrix4, rng: () => number) {
  const h = 2.2 + rng() * 1.2;
  bins.leaf.add(cylGeo(0.12, 0.2, h, 8), at.clone().multiply(M(0, h / 2, 0)), col("#8fb04a"));
  const n = 7 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = i * Math.PI * 2 / n + rng() * 0.5, tilt = 0.35 + rng() * 0.9, len = 2.2 + rng() * 1.3, y = h - 0.3 - rng() * 0.8;
    bins.leaf.add(leafGeo(len, len * 0.42), at.clone().multiply(M(0, y, 0, a, 0, 0)).multiply(M(0, 0, 0, 0, -tilt)).multiply(M(0, 0, len / 2)), col(rng() < 0.5 ? "#4f9a2e" : "#7bc043"));
  }
  // a hanging bunch
  if (rng() < 0.6) for (let k = 0; k < 8; k++) bins.fruit.add(new THREE.CapsuleGeometry(0.05, 0.16, 3, 6), at.clone().multiply(M(0.25, h - 0.9 - (k % 4) * 0.14, 0.15, k * 0.8, 0, 0.4)).multiply(M(0.1, 0, 0)), col("#e8c93a"));
}
function fallbackBush(bins: TownBins, at: THREE.Matrix4, rng: () => number, fern = false) {
  const n = fern ? 10 : 7;
  for (let i = 0; i < n; i++) {
    if (fern) {
      const a = i * Math.PI * 2 / n + rng() * 0.4, tilt = 0.5 + rng() * 0.6, len = 1.0 + rng() * 0.5;
      bins.leaf.add(frondGeo(len, 0.35), at.clone().multiply(M(0, 0.15, 0, a, 0, 0)).multiply(M(0, 0, 0, 0, -Math.PI / 2 + tilt)), col("#3f8f2f"));
    } else {
      const s = 0.45 + rng() * 0.35;
      bins.leaf.add(new THREE.IcosahedronGeometry(s, 1), at.clone().multiply(M((rng() - 0.5) * 1.1, s * 0.8 + rng() * 0.3, (rng() - 0.5) * 1.1)), col(rng() < 0.5 ? "#3f8a2e" : "#5aa83a"), (x, y, z, b, o) => { o.multiplyScalar(0.75 + 0.25 * Math.min(1, (y - at.elements[13]) / 1.2)); });
    }
  }
}
function fallbackMonstera(bins: TownBins, at: THREE.Matrix4, rng: () => number) {
  const n = 6 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = i * Math.PI * 2 / n + rng() * 0.6, tilt = 0.3 + rng() * 0.8, len = 1.1 + rng() * 0.6;
    bins.woodDark.add(cylGeo(0.02, 0.025, len, 5), at.clone().multiply(M(0, 0.1, 0, a, 0, 0)).multiply(M(0, 0, 0, 0, -tilt)).multiply(M(0, len / 2, 0)), col("#4a6a2a"));
    bins.leaf.add(leafGeo(len * 0.9, len * 0.8), at.clone().multiply(M(0, 0.1, 0, a, 0, 0)).multiply(M(0, 0, 0, 0, -tilt)).multiply(M(0, len, 0, 0, -Math.PI / 2 + tilt + 0.3)).multiply(M(0, 0, len * 0.4)), col("#2f7a2a"));
  }
}
function fallbackMangrove(bins: TownBins, at: THREE.Matrix4, rng: () => number) {
  const h = 3.5 + rng() * 2;
  // prop roots: arcs from the trunk base out and down into the water
  for (let i = 0; i < 9; i++) {
    const a = i * Math.PI * 2 / 9 + rng() * 0.5, r = 0.8 + rng() * 1.0;
    const pts = [new THREE.Vector3(0, 1.2 + rng() * 0.6, 0), new THREE.Vector3(Math.cos(a) * r * 0.6, 0.7, Math.sin(a) * r * 0.6), new THREE.Vector3(Math.cos(a) * r, -0.6, Math.sin(a) * r)];
    bins.woodDark.add(tubeGeo(pts, 0.05, 5, false, 8), at, col("#5a3f2a"));
  }
  bins.woodDark.add(cylGeo(0.12, 0.2, h - 1, 7), at.clone().multiply(M(0, 1 + (h - 1) / 2, 0)), col("#6a4a30"));
  for (let i = 0; i < 4; i++) {
    const a = i * 1.57 + rng(), r = 0.9 + rng() * 0.8;
    const pts = [new THREE.Vector3(0, h - 1.2, 0), new THREE.Vector3(Math.cos(a) * r * 0.5, h - 0.4, Math.sin(a) * r * 0.5), new THREE.Vector3(Math.cos(a) * r, h + 0.2, Math.sin(a) * r)];
    bins.woodDark.add(tubeGeo(pts, 0.05, 5, false, 8), at, col("#6a4a30"));
  }
  for (let i = 0; i < 16; i++) {
    const s = 0.5 + rng() * 0.5, a = rng() * 6.28, r = rng() * 1.8;
    bins.leaf.add(new THREE.IcosahedronGeometry(s, 1), at.clone().multiply(M(Math.cos(a) * r, h - 0.6 + rng() * 1.6, Math.sin(a) * r)), col(rng() < 0.5 ? "#6fb040" : "#8ccf4a"), (x, y, z, b, o) => { o.multiplyScalar(0.72 + 0.28 * Math.min(1, (y - at.elements[13] - h + 1) / 2)); });
  }
}
