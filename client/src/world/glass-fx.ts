// BREAKABLE GLASS — the visuals. The sim side lives in shared/sim/glass.ts; this file only DRAWS what
// the client's GlassState says:
//  - a broken pane disappears: the triangles of every glass-material mesh that lie in the pane's slot (the pane's rect,
//    ±0.3 m across it) are collapsed to degenerate ones in place (an index / position write + a ranged upload). Generic:
//    town kit, interiors, hotel / resort, harbour, lab, lighthouse, control tower — and the engine's far HLOD merges
//    of them — all hide their own glass with no per-POI code. A new match restores every collapsed triangle.
//  - one shard system: a single InstancedMesh (SHARDS instances, one draw call, no allocations per frame) of glass
//    slivers that burst out of the pane, fall, skitter on the floor and shrink away.
//  - the shatter sound is the host's (onBreak → "glass:break", built from the real glass recordings in the bank).
import * as THREE from "three";
import { PG, type GlassState } from "../../../shared/sim/glass";
import { makeHit } from "../../../shared/sim/world";
import { onStructure } from "../engine/scene-hooks";

const SHARDS = 384;
const EDGES = 4096;          // jagged glass left standing in the frames of broken panes (persistent for the match)
const SLAB = 0.3;            // m across the pane plane that still counts as "in the window" (interior-side glass)
const EDGE = 0.04;           // rect margin (a pane quad drawn a hair larger than its collider)
const GRAV = 17;

interface GMesh {
  mesh: THREE.Mesh; box: THREE.Box3;
  /** world-space triangle centroids (lazy) + which triangles are glass (multi-material groups) */
  cen: Float32Array | null; ok: Uint8Array | null; tris: number;
}
interface Undo { g: GMesh; tri: number; a: number; b: number; c: number; pos: Float32Array | null }

/** a window-glass material: named glass, or an unnamed see-through mirror-smooth PBR one (the coast kit's) — never water,
 * spray, fog or storm cards (shader materials / rough) */
export const isGlassMat = (m: THREE.Material | undefined) => !!m && m.transparent && m.opacity <= 0.8 && m.name !== "glass:shard"
  && (/glass/i.test(m.name) || ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true && m.opacity <= 0.6 && (m as THREE.MeshStandardMaterial).roughness <= 0.08));
const MAX_TRIS = 400_000;
const BM = new THREE.Matrix4();
function identityBatch(bm: THREE.BatchedMesh): boolean {
  try {
    const n = (bm as unknown as { instanceCount?: number }).instanceCount ?? 0;
    for (let i = 0; i < n; i++) {
      bm.getMatrixAt(i, BM); const e = BM.elements;
      for (let j = 0; j < 16; j++) if (Math.abs(e[j] - (j % 5 === 0 ? 1 : 0)) > 1e-6) return false;
    }
    return true;
  } catch { return false; }
}
const V = new THREE.Vector3(), HIT = makeHit();
// meshes that join the scene after the first scan (a streamed module, an HLOD rebuild) reach the live GlassFx through
// ONE structure listener (engine/scene-hooks) — no periodic scene walks
let live: GlassFx | null = null, hooked = false;

const shardMaterial = () => new THREE.MeshStandardMaterial({ name: "glass:shard", color: "#d9f1f7", roughness: 0.04, metalness: 0.35, envMapIntensity: 2.4, transparent: true, opacity: 0.82, side: THREE.DoubleSide });
/** the shards' program for the session prewarm (game/render.ts renderPrefabs): every GlassFx makes and disposes its own */
export function glassShardPrefab(): THREE.Object3D { return new THREE.InstancedMesh(new THREE.PlaneGeometry(0.01, 0.01), shardMaterial(), 1); }

export class GlassFx {
  private readonly meshes: GMesh[] = [];
  private readonly known = new WeakSet<THREE.Object3D>();
  private warmI = 0;
  private pruneDue = false;
  private scannedOnce = false; private readonly pending: THREE.Object3D[] = []; private applied = 0; private epoch = -1;
  private readonly undo = new Map<number, Undo[]>();
  // shards
  readonly shards: THREE.InstancedMesh;
  private readonly P = new Float32Array(SHARDS * 3); private readonly Vel = new Float32Array(SHARDS * 3);
  private readonly R = new Float32Array(SHARDS * 4);   // rot x, y, z, spin
  private readonly L = new Float32Array(SHARDS * 3);   // life left, life total, floor y
  private readonly S = new Float32Array(SHARDS);       // size
  private next = 0; private live = 0;
  private readonly m4 = new THREE.Matrix4(); private readonly q = new THREE.Quaternion(); private readonly e = new THREE.Euler(); private readonly sc = new THREE.Vector3();
  private time = 0;
  /** stats (tools / ?glass debug): panes hidden, triangles collapsed, glass meshes known */
  readonly stats = { hidden: 0, tris: 0, meshes: 0, scans: 0, ms: 0, warmMs: 0 };

  constructor(readonly scene: THREE.Scene, readonly st: GlassState, readonly onBreak: (x: number, y: number, z: number, cause: number, by: number) => void) {
    // a sliver: a thin irregular triangular plate (both faces), ~1 × 0.6 units, scaled per shard
    const g = new THREE.BufferGeometry();
    const p = [0, 0.5, 0.004, -0.32, -0.42, 0.004, 0.38, -0.3, 0.004, 0, 0.5, -0.004, 0.38, -0.3, -0.004, -0.32, -0.42, -0.004];
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    g.computeVertexNormals();
    const mat = shardMaterial();
    this.shards = new THREE.InstancedMesh(g, mat, SHARDS);
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shards.frustumCulled = false; this.shards.castShadow = false; this.shards.receiveShadow = false;
    this.shards.visible = false; this.shards.count = SHARDS;
    this.m4.makeScale(0, 0, 0); for (let i = 0; i < SHARDS; i++) this.shards.setMatrixAt(i, this.m4);
    scene.add(this.shards);
    // the jagged teeth left in a smashed frame: two thin triangles on a base along the edge, pointing into the opening
    const e = new THREE.BufferGeometry();
    e.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.12, 0.62, 0, -0.5, 0, 0, 0.12, 0.62, 0, -0.18, 1, 0], 3));
    e.computeVertexNormals();
    this.edges = new THREE.InstancedMesh(e, mat, EDGES);
    this.edges.frustumCulled = false; this.edges.castShadow = false; this.edges.receiveShadow = false;
    this.edges.count = 0; this.edges.visible = false;
    scene.add(this.edges);
    live = this;
    if (!hooked) { hooked = true; onStructure((p, child, added) => { const g = live; if (!child || !g || !g.scannedOnce) return; if (added) { if (g.pending.length < 65536) g.pending.push(child); } else if (p === g.scene || p.name === "far-merge") g.pruneDue = true; }); }
  }
  readonly edges: THREE.InstancedMesh;
  private edgeN = 0;
  /** 3-7 teeth along the frame of pane k (bigger at the bottom, where real glass hangs on) */
  private teeth(k: number) {
    const G = this.st.panes.geo, o = k * PG;
    const cx = G[o], cy = G[o + 1], cz = G[o + 2], nx = G[o + 3], nz = G[o + 4], ux = G[o + 5], uz = G[o + 6], hw = G[o + 7], hh = G[o + 8];
    let seed = (k * 2654435761) >>> 0; const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const n = 3 + Math.floor(rnd() * 5), mesh = this.edges, M = this.m4.elements;
    for (let i = 0; i < n; i++) {
      const edge = i === 0 ? 0 : Math.floor(rnd() * 4);   // 0 bottom, 1 top, 2 left, 3 right (always one at the bottom)
      const along = (rnd() * 2 - 1) * 0.8, w = 0.08 + rnd() * 0.2, h = (edge === 0 ? 0.1 : 0.06) + rnd() * (edge === 0 ? 0.26 : 0.16);
      // base point + in-plane axes: X along the edge, Y into the opening
      let bx: number, by: number, bz: number, Xx: number, Xy: number, Xz: number, Yx: number, Yy: number, Yz: number;
      if (edge < 2) { const sg = edge === 0 ? 1 : -1; bx = cx + ux * along * hw; by = cy - sg * (hh - 0.015); bz = cz + uz * along * hw; Xx = ux * sg; Xy = 0; Xz = uz * sg; Yx = 0; Yy = sg; Yz = 0; }
      else { const sg = edge === 2 ? 1 : -1; bx = cx - ux * sg * (hw - 0.015); by = cy + along * hh; bz = cz - uz * sg * (hw - 0.015); Xx = 0; Xy = -sg; Xz = 0; Yx = ux * sg; Yy = 0; Yz = uz * sg; }
      // columns: X·w, Y·h, n (thickness 1), translation
      M[0] = Xx * w; M[1] = Xy * w; M[2] = Xz * w; M[3] = 0;
      M[4] = Yx * h; M[5] = Yy * h; M[6] = Yz * h; M[7] = 0;
      M[8] = nx; M[9] = 0; M[10] = nz; M[11] = 0;
      M[12] = bx; M[13] = by; M[14] = bz; M[15] = 1;
      const j = this.edgeN % EDGES; this.edgeN++;
      mesh.setMatrixAt(j, this.m4);
    }
    mesh.count = Math.min(EDGES, this.edgeN); mesh.visible = mesh.count > 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** once per frame */
  update(dt: number) {
    const st = this.st;
    this.time += dt;
    if (st.epoch !== this.epoch) { this.restoreAll(); this.epoch = st.epoch; this.applied = 0; }
    // the one full scene walk (~4 ms) happens 3 s into the session (the warm-up islet), not on the first smashed window
    if (!this.scannedOnce && this.time > 3) { const t0 = performance.now(); this.scan(this.scene); this.scannedOnce = true; this.stats.ms += performance.now() - t0; }
    // …and the triangle centroids, one glass mesh per frame, so the first smashed window costs ~nothing
    else if (this.scannedOnce && this.warmI < this.meshes.length) { const t0 = performance.now(), g = this.meshes[this.warmI++]; if (!g.cen) this.centroids(g); this.stats.warmMs = Math.max(this.stats.warmMs, performance.now() - t0); }
    if (this.pruneDue) this.prune();
    if (this.pending.length > 0) {
      // late meshes (a module streamed in, an HLOD merge rebuilt): the panes already broken apply to them too
      const t0 = performance.now(), n0 = this.meshes.length;
      for (const o of this.pending) if (this.inScene(o)) this.scan(o);
      this.pending.length = 0;
      for (let i = n0; i < this.meshes.length; i++) for (let k = 0; k < this.applied; k++) this.hideIn(this.meshes[i], st.order[k]);
      this.stats.ms += performance.now() - t0;
    }
    if (this.applied < st.count) {
      const t0 = performance.now();
      if (!this.scannedOnce) { this.scan(this.scene); this.scannedOnce = true; }
      while (this.applied < st.count) this.hide(st.order[this.applied++]);
      this.stats.ms += performance.now() - t0;
    }
    // fresh breaks → shards + sound
    if (st.freshN > 0) {
      const F = st.fresh, g = st.panes.geo;
      for (let i = 0; i < st.freshN; i++) {
        const k = F[i * 3], c = F[i * 3 + 1], sd = (c >> 2) & 3;
        this.burst(k, c & 3, sd === 1 ? 1 : sd === 2 ? -1 : 0);
        const o = k * PG; this.onBreak(g[o], g[o + 1], g[o + 2], c & 3, F[i * 3 + 2]);
      }
      st.freshN = 0;
    }
    if (this.live > 0) this.stepShards(dt);
  }

  // ---------------------------------------------------------------- hiding panes
  private prune() {
    this.pruneDue = false;
    let w = 0, warm = this.warmI;
    for (let i = 0; i < this.meshes.length; i++) {
      if (this.inScene(this.meshes[i].mesh)) this.meshes[w++] = this.meshes[i];
      else if (i < this.warmI) warm--;
    }
    this.meshes.length = w; this.warmI = warm; this.stats.meshes = w;
    for (const [k, list] of this.undo) {
      const keep = list.filter((u) => this.inScene(u.g.mesh));
      if (keep.length) this.undo.set(k, keep); else this.undo.delete(k);
    }
  }
  private inScene(o: THREE.Object3D) { let p: THREE.Object3D | null = o; while (p && p !== this.scene) p = p.parent; return p === this.scene; }
  private scan(root: THREE.Object3D) {
    this.stats.scans++;
    root.traverse((o) => {
      if (this.known.has(o)) return;
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh || m === this.shards) return;
      // a BatchedMesh (the town kit's LOD tiers, the harbour) whose instances all sit at identity: its geometry is in
      // mesh space like a plain mesh's, and collapsing in its shared index works the same
      if ((m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh && !identityBatch(m as unknown as THREE.BatchedMesh)) return;
      const mat = m.material;
      const glassy = Array.isArray(mat) ? mat.some(isGlassMat) : isGlassMat(mat);
      if (!glassy) return;
      const geo = m.geometry as THREE.BufferGeometry;
      if (!geo?.attributes?.position) return;
      this.known.add(o);
      if (!geo.boundingBox) geo.computeBoundingBox();
      m.updateWorldMatrix(true, false);
      const box = geo.boundingBox!.clone().applyMatrix4(m.matrixWorld);
      const tris = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
      if (tris > MAX_TRIS) return;
      this.meshes.push({ mesh: m, box, cen: null, ok: null, tris });
    });
    this.stats.meshes = this.meshes.length;
  }
  private hide(k: number) {
    const before = this.stats.tris;
    for (const g of this.meshes) this.hideIn(g, k);
    if (this.stats.tris > before) this.stats.hidden++;
    this.teeth(k);
  }
  private paneBox = new THREE.Box3();
  private hideIn(g: GMesh, k: number) {
    const G = this.st.panes.geo, o = k * PG;
    const cx = G[o], cy = G[o + 1], cz = G[o + 2], nx = G[o + 3], nz = G[o + 4], ux = G[o + 5], uz = G[o + 6], hw = G[o + 7] + EDGE, hh = G[o + 8] + EDGE, ht = G[o + 9] + SLAB;
    const ex = Math.abs(ux) * hw + Math.abs(nx) * ht, ez = Math.abs(uz) * hw + Math.abs(nz) * ht;
    this.paneBox.min.set(cx - ex, cy - hh, cz - ez); this.paneBox.max.set(cx + ex, cy + hh, cz + ez);
    if (!g.box.intersectsBox(this.paneBox)) return;
    if (!g.cen) this.centroids(g);
    const cen = g.cen!, ok = g.ok!;
    let geo = g.mesh.geometry as THREE.BufferGeometry;
    let list: Undo[] | undefined;
    for (let t = 0; t < g.tris; t++) {
      if (!ok[t]) continue;
      const rx = cen[t * 3] - cx, ry = cen[t * 3 + 1] - cy, rz = cen[t * 3 + 2] - cz;
      if (Math.abs(ry) > hh || Math.abs(rx * nx + rz * nz) > ht || Math.abs(rx * ux + rz * uz) > hw) continue;
      // collapse triangle t (once: a later pane over the same triangle finds it gone)
      ok[t] = 0;
      if (!list) { list = this.undo.get(k); if (!list) this.undo.set(k, list = []); geo = this.own(g); }
      const idx = geo.index;
      if (idx) {
        const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2);
        list.push({ g, tri: t, a, b, c, pos: null });
        idx.setX(t * 3 + 1, a); idx.setX(t * 3 + 2, a);
        idx.addUpdateRange(t * 3, 3); idx.needsUpdate = true;
      } else {
        const pa = geo.attributes.position as THREE.BufferAttribute, arr = pa.array as Float32Array, s = t * 9;
        list.push({ g, tri: t, a: 0, b: 0, c: 0, pos: arr.slice(s, s + 9) });
        for (let j = 3; j < 9; j++) arr[s + j] = arr[s + (j % 3)];
        pa.addUpdateRange(s, 9); pa.needsUpdate = true;
      }
      this.stats.tris++;
    }
  }
  /** a geometry shared with other meshes is cloned before the first edit (only this mesh's glass changes) */
  private own(g: GMesh): THREE.BufferGeometry {
    const geo = g.mesh.geometry as THREE.BufferGeometry;
    if ((geo.userData as { glassOwned?: boolean }).glassOwned) return geo;
    let users = 0;
    for (const q of this.meshes) if (q.mesh.geometry === geo) users++;
    const out = users > 1 ? geo.clone() : geo;
    (out.userData as { glassOwned?: boolean }).glassOwned = true;
    if (out !== geo) g.mesh.geometry = out;
    return out;
  }
  private centroids(g: GMesh) {
    const geo = g.mesh.geometry as THREE.BufferGeometry, pos = geo.attributes.position as THREE.BufferAttribute, idx = geo.index;
    const cen = new Float32Array(g.tris * 3), ok = new Uint8Array(g.tris);
    const mat = g.mesh.material, mw = g.mesh.matrixWorld.elements;
    if (Array.isArray(mat)) {
      for (const gr of geo.groups) if (isGlassMat(mat[gr.materialIndex ?? 0])) { const t0 = Math.floor(gr.start / 3), t1 = Math.min(g.tris, Math.floor((gr.start + gr.count) / 3)); for (let t = t0; t < t1; t++) ok[t] = 1; }
    } else ok.fill(1);
    // raw arrays (getX per vertex made a town batch's first break a 186 ms frame)
    const P = (pos as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute ? null : pos.array as ArrayLike<number>;
    const I = idx ? idx.array as ArrayLike<number> : null;
    const e0 = mw[0], e1 = mw[1], e2 = mw[2], e4 = mw[4], e5 = mw[5], e6 = mw[6], e8 = mw[8], e9 = mw[9], e10 = mw[10], e12 = mw[12], e13 = mw[13], e14 = mw[14];
    for (let t = 0; t < g.tris; t++) {
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < 3; j++) {
        const v = I ? I[t * 3 + j] : t * 3 + j;
        if (P) { x += P[v * 3]; y += P[v * 3 + 1]; z += P[v * 3 + 2]; } else { x += pos.getX(v); y += pos.getY(v); z += pos.getZ(v); }
      }
      x /= 3; y /= 3; z /= 3;
      cen[t * 3] = e0 * x + e4 * y + e8 * z + e12;
      cen[t * 3 + 1] = e1 * x + e5 * y + e9 * z + e13;
      cen[t * 3 + 2] = e2 * x + e6 * y + e10 * z + e14;
    }
    g.cen = cen; g.ok = ok;
  }
  private restoreAll() {
    for (const list of this.undo.values()) for (const u of list) {
      const geo = u.g.mesh.geometry as THREE.BufferGeometry;
      if (u.pos) { const pa = geo.attributes.position as THREE.BufferAttribute; (pa.array as Float32Array).set(u.pos, u.tri * 9); pa.addUpdateRange(u.tri * 9, 9); pa.needsUpdate = true; }
      else if (geo.index) { const idx = geo.index; idx.setX(u.tri * 3, u.a); idx.setX(u.tri * 3 + 1, u.b); idx.setX(u.tri * 3 + 2, u.c); idx.addUpdateRange(u.tri * 3, 3); idx.needsUpdate = true; }
      if (u.g.ok) u.g.ok[u.tri] = 1;
    }
    this.undo.clear(); this.stats.hidden = 0; this.stats.tris = 0;
    if (this.edges) { this.edgeN = 0; this.edges.count = 0; this.edges.visible = false; }
  }

  // ---------------------------------------------------------------- shards
  private burst(k: number, cause: number, side: number) {
    const G = this.st.panes.geo, o = k * PG;
    const cx = G[o], cy = G[o + 1], cz = G[o + 2], nx = G[o + 3], nz = G[o + 4], ux = G[o + 5], uz = G[o + 6], hw = G[o + 7], hh = G[o + 8];
    const area = 4 * hw * hh, n = Math.max(10, Math.min(40, Math.round(area * 16)));
    // the floors on both sides (shards land on the sill / room floor / street)
    const w = this.st.world, bot = cy - hh;
    const floorAt = (s: number) => { w.raycast(cx + nx * s * 0.6, bot + 0.2, cz + nz * s * 0.6, 0, -1, 0, 40, HIT, false); return HIT.hit ? HIT.y : bot - 40; };
    const fPos = floorAt(1), fNeg = floorAt(-1);
    // away from the breaker (side = the side the hit came from); unknown → both ways
    const dir = side !== 0 ? -side : 0, push = cause === 3 ? 6 : cause === 1 ? 3.6 : 2.6;
    for (let i = 0; i < n; i++) {
      const j = this.next; this.next = (this.next + 1) % SHARDS;
      const a = (Math.random() * 2 - 1) * hw * 0.95, b = (Math.random() * 2 - 1) * hh * 0.95;
      this.P[j * 3] = cx + ux * a; this.P[j * 3 + 1] = cy + b; this.P[j * 3 + 2] = cz + uz * a;
      const d = dir !== 0 ? (Math.random() < 0.82 ? dir : -dir) : (Math.random() < 0.5 ? 1 : -1);
      const sp = push * (0.35 + Math.random() * 0.9);
      this.Vel[j * 3] = nx * d * sp + ux * (Math.random() - 0.5) * 2.2;
      this.Vel[j * 3 + 1] = 0.6 + Math.random() * 1.8 - (b > 0 ? 0.6 : 0);
      this.Vel[j * 3 + 2] = nz * d * sp + uz * (Math.random() - 0.5) * 2.2;
      this.R[j * 4] = Math.random() * 6.28; this.R[j * 4 + 1] = Math.random() * 6.28; this.R[j * 4 + 2] = Math.random() * 6.28; this.R[j * 4 + 3] = 4 + Math.random() * 14;
      const life = 2.2 + Math.random() * 1.6;
      this.L[j * 3] = life; this.L[j * 3 + 1] = life; this.L[j * 3 + 2] = (d > 0 ? fPos : fNeg) + 0.01;
      this.S[j] = 0.05 + Math.random() * Math.random() * 0.16;
    }
    this.live = SHARDS; this.shards.visible = true;
  }
  private stepShards(dt: number) {
    const P = this.P, Vl = this.Vel, R = this.R, L = this.L, mesh = this.shards;
    let alive = 0;
    for (let j = 0; j < SHARDS; j++) {
      if (L[j * 3] <= 0) continue;
      L[j * 3] -= dt;
      if (L[j * 3] <= 0) { this.m4.makeScale(0, 0, 0); mesh.setMatrixAt(j, this.m4); continue; }
      alive++;
      const fy = L[j * 3 + 2];
      let x = P[j * 3], y = P[j * 3 + 1], z = P[j * 3 + 2];
      if (y > fy + 1e-3 || Vl[j * 3 + 1] > 0) {
        Vl[j * 3 + 1] -= GRAV * dt;
        const drag = Math.exp(-dt * 0.6); Vl[j * 3] *= drag; Vl[j * 3 + 2] *= drag;
        x += Vl[j * 3] * dt; y += Vl[j * 3 + 1] * dt; z += Vl[j * 3 + 2] * dt;
        R[j * 4] += R[j * 4 + 3] * dt; R[j * 4 + 2] += R[j * 4 + 3] * 0.7 * dt;
        if (y < fy) {   // hit the floor: a low bounce, then it skitters flat
          y = fy; Vl[j * 3 + 1] = Vl[j * 3 + 1] < -2.5 ? -Vl[j * 3 + 1] * 0.22 : 0; Vl[j * 3] *= 0.45; Vl[j * 3 + 2] *= 0.45; R[j * 4 + 3] *= 0.4;
          if (Vl[j * 3 + 1] === 0) { R[j * 4] = Math.PI / 2; }
        }
      } else { const fr = Math.exp(-dt * 7); Vl[j * 3] *= fr; Vl[j * 3 + 2] *= fr; x += Vl[j * 3] * dt; z += Vl[j * 3 + 2] * dt; }
      P[j * 3] = x; P[j * 3 + 1] = y; P[j * 3 + 2] = z;
      const s = this.S[j] * Math.min(1, L[j * 3] / 0.5);
      this.e.set(R[j * 4], R[j * 4 + 1], R[j * 4 + 2]); this.q.setFromEuler(this.e);
      this.sc.set(s, s, s); V.set(x, y, z);
      this.m4.compose(V, this.q, this.sc); mesh.setMatrixAt(j, this.m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (alive === 0) { this.live = 0; mesh.visible = false; }
  }

  dispose() {
    if (live === this) live = null;
    this.restoreAll(); this.scene.remove(this.shards); this.scene.remove(this.edges); this.shards.geometry.dispose(); this.edges.geometry.dispose(); (this.shards.material as THREE.Material).dispose(); }
}
