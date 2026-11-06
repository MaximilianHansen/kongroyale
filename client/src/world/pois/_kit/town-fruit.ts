// poi-town FRUIT: every mango and every banana hand in a POI is an INSTANCE of a few smooth hero geometries in one
// BatchedMesh (one draw), with per-instance LOD by camera distance (hi ≥ 18×12 smooth mango / 7-finger hands within
// `hi` m, a lighter version within `lo` m, a 6×4 blob to `far` m, hidden beyond — the fruit-coloured heap mound under
// them carries the pile from afar) and per-instance frustum culling.
//
// Use: a POI calls `beginFruit(new FruitBatch(mats.fruit))` before building its props and `endFruit()` + `build()` after;
// the kits call `fruitSink()?.mango(m, ripe)` / `.hand(m, n, green)` and fall back to their own geometry without a sink.
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { WorldCtx } from "../../../engine/engine";
import { detail, noise3 } from "./town-geo";
import type { TownBins } from "./town-materials";
import type { Pace } from "./pace";

const TAU = Math.PI * 2;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const sstep = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const h3 = (x: number, y: number, z: number) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (dx: number, dy: number, dz: number) => h3(xi + dx, yi + dy, zi + dz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}

// ================================================================================================= geometry
// saturated (ACES eats chroma): green shoulder → lemon → golden → deep orange → red-orange blush (never pink)
const MANGO_RAMP: Array<[number, THREE.Color]> = [[0, new THREE.Color("#5f9a1c")], [0.18, new THREE.Color("#a8c212")], [0.36, new THREE.Color("#ffd000")], [0.58, new THREE.Color("#ffa200")], [0.8, new THREE.Color("#ff8400")], [1, new THREE.Color("#f25a10")]];
function ramp(v: number, o: THREE.Color) {
  const s = MANGO_RAMP;
  if (v <= s[0][0]) { o.copy(s[0][1]); return; }
  for (let i = 1; i < s.length; i++) if (v <= s[i][0]) { o.copy(s[i - 1][1]).lerp(s[i][1], (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0])); return; }
  o.copy(s[s.length - 1][1]);
}
/** plump asymmetric kidney mango, length 1 along x (stem end −x, beak +x), lying on its flat side; smooth normals;
 *  vertex colours = the ripeness ramp (green shoulder at the stem → yellow → orange → red blush on the sunny side) */
function mangoGeo(seg: number, rings: number, ripe: number, shape: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.SphereGeometry(1, seg, rings);
  g.deleteAttribute("uv"); g.deleteAttribute("normal"); g = mergeVertices(g);
  const p = g.attributes.position as THREE.BufferAttribute, bend = 0.05 + shape * 0.02, beak = 0.03 + (shape % 2) * 0.02;
  for (let i = 0; i < p.count; i++) {
    const L = p.getY(i), A = p.getX(i), W = -p.getZ(i);
    const taper = 1 - 0.1 * L - 0.05 * L * L;
    const x = L * 0.5 * (1 + 0.03 * Math.max(0, W));
    const y = A * (0.35 + shape * 0.012) * taper;
    let z = W * 0.41 * taper * (W < 0 ? 0.93 : 1.04);
    z += bend * (0.55 - L * L) - beak * sstep(0.3, 1, L);
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  const n = p.count, col = new Float32Array(n * 3), c = new THREE.Color(), bl = new THREE.Vector3(0.35, 0.85, 0.4).normalize();
  for (let i = 0; i < n; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), nx = x / 0.5, ny = y / 0.35, nz = z / 0.4, l = Math.hypot(nx, ny, nz) || 1;
    const t = (nx * bl.x + ny * bl.y + nz * bl.z) / l;
    // yellow-orange body, a red-orange blush only on the sunny cheek, green at the stem shoulder (never pink)
    const v = 0.2 + ripe * 0.26 + t * 0.26 - 0.16 * sstep(-0.18, -0.48, x) + 0.06 * (vnoise(x * 11 + ripe * 7, y * 11, z * 11) - 0.5);
    ramp(v, c);
    // freckles (lenticels) + the gentle underside falloff (no black halo: ≥ 0.82)
    if (vnoise(x * 60, y * 60, z * 60) > 0.8) c.multiplyScalar(0.9);
    c.multiplyScalar(0.82 + 0.18 * sstep(-0.9, 0.3, ny / l));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}
const BAN_Y = new THREE.Color("#ffe03a"), BAN_G = new THREE.Color("#b8d03a"), BAN_STEM = new THREE.Color("#6c7a2c"), BAN_TIP = new THREE.Color("#3c2c1a"), BAN_CROWN = new THREE.Color("#7a6a2e");
/** one curved banana finger: length `len` along +x curving up (+y) on a circular arc, soft 5-ridged section, thin green
 *  neck at the stem end, dark nub at the tip. Written into the arrays (indexed). */
function finger(P: number[], C: number[], I: number[], m: THREE.Matrix4, len: number, segL: number, segR: number, green: number) {
  const R = len * 1.45, phi = len / R, base = P.length / 3;
  // thin green neck → fat body → blunt tapering tip (~3.6 cm across at 0.2 m long)
  // fat and chunky: stylised bananas read at ~5 cm across a 20 cm finger
  const rad = (t: number) => len * (0.03 + 0.098 * sstep(0.04, 0.3, t) * (1 - 0.86 * sstep(0.72, 1.0, t)));
  const v = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i <= segL; i++) {
    const t = i / segL, a = phi * t;
    const cx = R * Math.sin(a), cy = R * (1 - Math.cos(a));
    const tx = Math.cos(a), ty = Math.sin(a);
    const r = rad(t);
    for (let k = 0; k <= segR; k++) {
      const th = k / segR * TAU, lobe = 1 + 0.07 * Math.cos(5 * th);
      const nx = -ty * Math.cos(th), ny = tx * Math.cos(th), nz = Math.sin(th);
      v.set(cx + nx * r * lobe, cy + ny * r * lobe, nz * r * lobe).applyMatrix4(m);
      P.push(v.x, v.y, v.z);
      c.copy(BAN_Y).lerp(BAN_G, clamp01(green * 0.3 + 0.9 * sstep(0.15, 0.02, t)));
      if (t < 0.1) c.lerp(BAN_STEM, sstep(0.1, 0.0, t));
      if (t > 0.965) c.lerp(BAN_TIP, sstep(0.965, 0.995, t));
      c.multiplyScalar((Math.cos(th) < -0.2 ? 0.93 : 1) * (0.94 + 0.08 * vnoise(t * 14, th * 2, green * 9)) * (Math.abs(Math.cos(5 * th)) > 0.93 ? 1.05 : 1));
      C.push(c.r, c.g, c.b);
    }
  }
  const row = segR + 1;
  for (let i = 0; i < segL; i++) for (let k = 0; k < segR; k++) { const a = base + i * row + k, b = a + row; I.push(a, a + 1, b, a + 1, b + 1, b); }
  // tip cap + stem cap (fans)
  const capEnd = (i: number, tip: boolean) => {
    const t = i / segL, a = phi * t, cx = R * Math.sin(a), cy = R * (1 - Math.cos(a)), tx = Math.cos(a), ty = Math.sin(a), o = tip ? 1 : -1;
    v.set(cx + tx * o * len * 0.015, cy + ty * o * len * 0.015, 0).applyMatrix4(m);
    const ci = P.length / 3; P.push(v.x, v.y, v.z);
    if (tip) C.push(BAN_TIP.r * 0.8, BAN_TIP.g * 0.8, BAN_TIP.b * 0.8); else C.push(BAN_STEM.r, BAN_STEM.g, BAN_STEM.b);
    for (let k = 0; k < segR; k++) { const q = base + i * row + k; if (tip) I.push(q, q + 1, ci); else I.push(q, ci, q + 1); }
  };
  if (segR >= 4) { capEnd(segL, true); capEnd(0, false); }
}
/** a hand of n bananas: crown at the origin, fingers fanned across z pointing +x and curving up (+y) */
function handGeo(n: number, segL: number, segR: number, variant: number): THREE.BufferGeometry {
  const P: number[] = [], C: number[] = [], I: number[] = [];
  let s = (variant * 2654435761 + 97) >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const len = 0.2;
  for (let k = 0; k < n; k++) {
    const u = k - (n - 1) / 2, row = k % 2;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(0.004, row * 0.02, u * 0.05), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -u * 0.12 + (rnd() - 0.5) * 0.08, (row ? 0.14 : 0) + (rnd() - 0.5) * 0.06, "YXZ")), new THREE.Vector3(1, 1, 1));
    finger(P, C, I, m, len * (0.94 + rnd() * 0.12), segL, segR, rnd() * 0.3);
  }
  // crown: a squat brown-green block the fingers grow from
  const crown = segR >= 5 ? new THREE.SphereGeometry(1, 8, 5) : new THREE.SphereGeometry(1, 5, 3), cp = crown.attributes.position as THREE.BufferAttribute, base = P.length / 3;
  for (let i = 0; i < cp.count; i++) { P.push(cp.getX(i) * 0.028 - 0.02, cp.getY(i) * 0.026 + 0.008, cp.getZ(i) * (n * 0.019 + 0.012)); C.push(BAN_CROWN.r, BAN_CROWN.g, BAN_CROWN.b); }
  const ci = crown.getIndex()!; for (let i = 0; i < ci.count; i++) I.push(base + ci.getX(i));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(P.length / 3 * 2), 2));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}

// ================================================================================================= the batch
type Kind = "mango" | "hand";
interface FruitInst { kind: Kind; v: number; m: THREE.Matrix4; c: THREE.Color; x: number; y: number; z: number }
const MANGO_V = 4, HAND_V = 3; // ripeness variants / hand finger-count variants (5, 6, 7)
interface FruitCell { cx: number; cz: number; cy: number; r: number; items: FruitInst[] }

/**
 * One InstancedMesh per (kind, variant, lod) geometry — ≤ 21 real instanced draws for the whole POI (a
 * BatchedMesh draws every visible fruit as its own multi-draw range: ~700 sub-draws at Mango Market). Every few frames, while
 * the camera moves, the fruit of the cells within `far` and inside the view frustum are written into the mesh of their
 * LOD (hi within `hi` m, lo within `lo`, min to `far`, 3D distance).
 */
export class FruitBatch {
  private list: FruitInst[] = [];
  private meshes: Record<Kind, THREE.InstancedMesh[][]> = { mango: [], hand: [] };
  private all: THREE.InstancedMesh[] = [];
  private cells: FruitCell[] = [];
  private tick = 0;
  private last = new THREE.Vector3(1e9, 0, 0);
  private lastQ = new THREE.Quaternion();
  private frustum = new THREE.Frustum();
  private _pm = new THREE.Matrix4();
  private _sph = new THREE.Sphere();
  private cam: THREE.Camera | null = null;
  constructor(private material: THREE.Material, readonly o: { hi?: number; lo?: number; far?: number; name?: string } = {}) {}
  get count() { return this.list.length; }
  /** a mango lying on its flat side; `m` = world matrix of its centre (unit length along local x → scale = fruit length) */
  mango(m: THREE.Matrix4, ripe = Math.random(), tint = 1) {
    const v = Math.min(MANGO_V - 1, Math.floor(clamp01(ripe) * MANGO_V));
    this.push("mango", v, m, new THREE.Color(tint, tint, tint));
  }
  /** a hand of 5–7 bananas (`n`), crown at the origin, fingers pointing +x curving up; ~0.2 m fingers at scale 1 */
  hand(m: THREE.Matrix4, n = 6, green = 0) {
    const v = Math.max(0, Math.min(HAND_V - 1, n - 5));
    const g = clamp01(green);
    this.push("hand", v, m, new THREE.Color(1 - 0.12 * g, 1, 1 - 0.3 * g));
  }
  private push(kind: Kind, v: number, m: THREE.Matrix4, c: THREE.Color) {
    const e = m.elements;
    if (![e[12], e[13], e[14]].every(Number.isFinite)) return;
    this.list.push({ kind, v, m: m.clone(), c, x: e[12], y: e[13], z: e[14] });
  }
  build(ctx: WorldCtx, group: THREE.Group): THREE.Group | null { const it = this.steps(ctx, group); let s = it.next(); while (!s.done) s = it.next(); return s.value; }
  async buildAsync(ctx: WorldCtx, group: THREE.Group, pace: Pace): Promise<THREE.Group | null> { const it = this.steps(ctx, group); let s = it.next(); while (!s.done) { await pace.pause(); s = it.next(); } return s.value; }
  private *steps(ctx: WorldCtx, group: THREE.Group): Generator<void, THREE.Group | null, void> {
    if (!this.list.length) return null;
    const g = new THREE.Group(); g.name = this.o.name ?? "town:fruit";
    // hi 16×12 (smooth), lo 8×6, min 6×4; hands 8×7 / 4×4 / 2×3 per finger
    const cap: Record<Kind, number[]> = { mango: new Array(MANGO_V).fill(0), hand: new Array(HAND_V).fill(0) };
    for (const it of this.list) cap[it.kind][it.v]++;
    const mk = (kind: Kind, v: number, lod: number, geo: THREE.BufferGeometry) => {
      const n = cap[kind][v];
      const im = new THREE.InstancedMesh(geo, this.material, Math.max(1, n));
      im.name = `${g.name}:${kind}${v}:l${lod}`;
      im.count = 0; im.visible = false; im.frustumCulled = false;
      im.castShadow = false; im.receiveShadow = true;
      im.userData.castShadow = false; im.userData.farShadow = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      g.add(im); this.all.push(im);
      return im;
    };
    for (let v = 0; v < MANGO_V; v++) { if (!cap.mango[v]) { this.meshes.mango.push([]); continue; } const r = (v + 0.5) / MANGO_V; this.meshes.mango.push([mk("mango", v, 0, mangoGeo(16, 12, r, v)), mk("mango", v, 1, mangoGeo(8, 6, r, v)), mk("mango", v, 2, mangoGeo(6, 4, r, v))]); yield; }
    for (let v = 0; v < HAND_V; v++) { if (!cap.hand[v]) { this.meshes.hand.push([]); continue; } this.meshes.hand.push([mk("hand", v, 0, handGeo(5 + v, 12, 9, v)), mk("hand", v, 1, handGeo(5 + v, 4, 4, v)), mk("hand", v, 2, handGeo(5 + v, 2, 3, v))]); yield; }
    // 16 m cells
    const map = new Map<string, FruitCell>();
    for (const it of this.list) {
      const k = `${Math.floor(it.x / 16)},${Math.floor(it.z / 16)}`;
      let c = map.get(k); if (!c) map.set(k, (c = { cx: 0, cz: 0, cy: 0, r: 0, items: [] }));
      c.items.push(it);
    }
    yield;
    for (const c of map.values()) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const it of c.items) { x0 = Math.min(x0, it.x); x1 = Math.max(x1, it.x); z0 = Math.min(z0, it.z); z1 = Math.max(z1, it.z); y0 = Math.min(y0, it.y); y1 = Math.max(y1, it.y); }
      c.cx = (x0 + x1) / 2; c.cz = (z0 + z1) / 2; c.cy = (y0 + y1) / 2; c.r = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 0.5;
      this.cells.push(c);
    }
    yield;
    group.add(g);
    this.cam = ctx.camera;
    this.update(ctx.camera.position, true);
    ctx.onUpdate(() => { this.tick++; if ((this.tick & 3) === 1) this.update(ctx.camera.position); });
    return g;
  }
  update(p: THREE.Vector3, force = false) {
    const cam = this.cam as THREE.PerspectiveCamera | null;
    if (!cam) return;
    // only when the camera moved / turned (fruit never moves)
    if (!force && p.distanceToSquared(this.last) < 0.04 && cam.quaternion.angleTo(this.lastQ) < 0.02) return;
    this.last.copy(p); this.lastQ.copy(cam.quaternion);
    cam.updateMatrixWorld();
    this._pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this._pm);
    const hi = this.o.hi ?? 3.5, lo = this.o.lo ?? 7, far = this.o.far ?? 11;
    for (const im of this.all) im.count = 0;
    for (const c of this.cells) {
      const dc = Math.hypot(p.x - c.cx, p.y - c.cy, p.z - c.cz) - c.r;
      if (dc > far) continue;
      this._sph.center.set(c.cx, c.cy, c.cz); this._sph.radius = c.r + 0.3;
      if (!this.frustum.intersectsSphere(this._sph)) continue;
      for (const it of c.items) {
        const d = Math.hypot(p.x - it.x, p.y - it.y, p.z - it.z);
        if (d > far) continue;
        const im = this.meshes[it.kind][it.v][d < hi ? 0 : d < lo ? 1 : 2];
        const i = im.count++;
        im.setMatrixAt(i, it.m); im.setColorAt(i, it.c);
      }
    }
    for (const im of this.all) { im.visible = im.count > 0; if (im.count) { im.instanceMatrix.clearUpdateRanges(); im.instanceMatrix.addUpdateRange(0, im.count * 16); im.instanceMatrix.needsUpdate = true; im.instanceColor!.clearUpdateRanges(); im.instanceColor!.addUpdateRange(0, im.count * 3); im.instanceColor!.needsUpdate = true; } }
  }
}

let current: FruitBatch | null = null;
export interface FruitSink { mango(m: THREE.Matrix4, ripe?: number, tint?: number): void; hand(m: THREE.Matrix4, n?: number, green?: number): void }
/** swallows fruit: the LOW-detail copy of a prop never emits individual fruit (its heap mound carries the pile, and the
 *  full-detail copy already put the fruit into the POI's FruitBatch, which has its own distance LOD) */
const NULL_SINK: FruitSink = { mango() {}, hand() {} };
/** the fruit sink of the POI being built (null outside a POI build → kits use their own merged fallback) */
export function fruitSink(): FruitSink | null { return detail() && !muted ? current : NULL_SINK; }
let muted = false;
/** build a copy of a prop without emitting its fruit again (the MEDIUM-detail copy of a TownLod prop: the full copy
 *  already put its fruit into the batch) */
export function withoutFruit<T>(fn: () => T): T { const m = muted; muted = true; try { return fn(); } finally { muted = m; } }
export function beginFruit(f: FruitBatch) { current = f; }
export function endFruit() { current = null; }

// ================================================================================================= heap mound
/** the fruit-HEAP mound: a dome (radii rx, ry, rz; base at the matrix origin) skinned with the painted heap texture
 *  (heapM / heapB bins, metre UVs) — fills the gaps under the fruit up close and IS the heap beyond the fruit's `far`.
 *  The dome is lumpy (fruit-sized bumps) so its silhouette is not a smooth cake. */
export function fruitMound(bins: TownBins, m: THREE.Matrix4, rx: number, ry: number, rz: number, kind: "mango" | "banana", seed = Math.random()) {
  const big = Math.max(rx, rz) > 0.35, seg = detail() ? (big ? 16 : 10) : (big ? 8 : 6), rings = detail() ? (big ? 5 : 3) : 2;
  const g = new THREE.SphereGeometry(1, seg, rings, 0, TAU, 0, Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
  const ox = seed * 7.3, oz = seed * 3.1, bump = kind === "mango" ? 0.035 : 0.025;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) * rx, z = pos.getZ(i) * rz, yu = pos.getY(i);
    // fruit-sized lumps on the upper surface (none at the rim, so it still sits flush in its crate)
    const b = yu > 0.2 ? bump * (noise3(x * 9 + ox, 0, z * 9 + oz) - 0.4) * Math.min(1, (yu - 0.2) * 3) : 0;
    pos.setXYZ(i, x, yu * ry + b, z);
    uv.setXY(i, x + ox, z + oz);
  }
  g.computeVertexNormals();
  const k = 0.94 + (seed % 0.1);
  (kind === "mango" ? bins.heapM : bins.heapB).add(g, m, new THREE.Color(k, k, k));
}

/** (dev) geometry builders for dev checks */
export const __test = { mangoGeo, handGeo };
