// poi-coast props: crates, pallets, drums, barrels, banana hands, fences, railings, tables, windsock, masts, lamps,
// boulders… Every prop writes into a Batch (merged per material) at a matrix in the batch's frame space.
import * as THREE from "three";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Terrain } from "../../../../../shared/world/terrain";
import { rng } from "../../../../../shared/pois/coast-kit";
import { Batch, M, box, rbox, cyl, sph, blobShadow, type MatKey } from "./coast-kit";

const mul = (a: THREE.Matrix4, b: THREE.Matrix4) => new THREE.Matrix4().multiplyMatrices(a, b);

// ------------------------------------------------------------------------------------------------ bananas
let handGeo: THREE.BufferGeometry | null = null;
let handGeoRipe: THREE.BufferGeometry | null = null;
/** one banana: pentagonal tube bent along an arc, tapered; length ~0.22 m. Vertex colours: green body, dark tips. */
function bananaGeo(ripe: boolean) {
  const g = new THREE.CylinderGeometry(1, 1, 1, 5, 3, true); // 30 tris per finger (pentagonal like a real banana; open ends taper)
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const body = new THREE.Color(ripe ? 0xf2c832 : 0x9cc94a), tip = new THREE.Color(0x3a3020), stem = new THREE.Color(ripe ? 0x9a9a40 : 0x5d8a2c);
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) + 0.5; // 0..1 along
    // chunky toy fingers (thin fingers read as leafy tufts from 5 m)
    const r = 0.031 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.06 + t * 0.94)), 0.45) + 0.004;
    const ang = (t - 0.5) * 1.1, R = 0.2; // bend
    const x = p.getX(i) * r, z = p.getZ(i) * r;
    // bend in the XY plane around a centre at (-R, 0)
    const bx = (R + x) * Math.cos(ang) - R, by = (R + x) * Math.sin(ang);
    p.setXYZ(i, bx, by, z);
    const c = t > 0.94 || t < 0.04 ? tip : t < 0.18 ? stem : body;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
export function bananaHand(ripe = false) {
  if (!ripe && handGeo) return handGeo;
  if (ripe && handGeoRipe) return handGeoRipe;
  const parts: THREE.BufferGeometry[] = [];
  const b = bananaGeo(ripe);
  // fingers packed side by side (fanned 0.28 rad apart, a heap reads as leafy tufts from 5 m)
  for (let row = 0; row < 2; row++) for (let i = 0; i < 4; i++) {
    const a = (i - 1.5) * 0.16;
    const g = b.clone();
    g.applyMatrix4(M(0, 0.02 * row, 0, 0, 0, 0));
    g.applyMatrix4(M(0.02, row * 0.05, (i - 1.5) * 0.062, 0.12 * row, a, 0.42 + row * 0.12));
    parts.push(g);
  }
  const crown = new THREE.CylinderGeometry(0.02, 0.03, 0.09, 6);
  crown.rotateZ(Math.PI / 2); crown.translate(-0.02, 0.02, 0);
  const cc = new Float32Array(crown.attributes.position.count * 3).fill(0.35);
  crown.setAttribute("color", new THREE.Float32BufferAttribute(cc, 3));
  for (const q of parts) if (!q.index) q.setIndex([...Array(q.attributes.position.count).keys()]);
  const merged = mergeGeometries([...parts, crown], false)!;
  merged.computeVertexNormals();
  if (ripe) handGeoRipe = merged; else handGeo = merged;
  return merged;
}

/** a heap of banana hands filling an area (w×d) at height y (frame space), `n` hands, tilted randomly */
export function bananaHeap(b: Batch, m: THREE.Matrix4, w: number, d: number, n: number, seed: number, mound = 0.12, ripe = false) {
  const r = rng(seed), hand = bananaHand(ripe);
  for (let i = 0; i < n; i++) {
    const x = (r() - 0.5) * w * 0.9, z = (r() - 0.5) * d * 0.9;
    const e = 1 - Math.min(1, Math.hypot(x / (w / 2), z / (d / 2)));
    const s = 1.5 + r() * 0.5;
    // no shadow casting (98 k casting fruit tris at the plantation; the heaps sit in crates / on belts)
    b.add(hand, "bananaFruit", { m: mul(m, M(x, mound * e + r() * 0.04, z, (r() - 0.5) * 0.6, r() * 6.28, (r() - 0.5) * 0.5, s)), uv: "keep", color: new THREE.Color().setHSL(0.24 + r() * 0.03, 0.55, 0.75 + r() * 0.2), shadow: false });
  }
}

// ------------------------------------------------------------------------------------------------ containers
/** BANANA CO. crate 1.2×0.8×0.8 (L×H×W). `full` = heaped with green banana hands. */
export function crate(b: Batch, m: THREE.Matrix4, o: { full?: boolean; seed?: number; tint?: THREE.ColorRepresentation; lid?: boolean } = {}) {
  const L = 1.2, H = 0.8, W = 0.8;
  // side panels with the stencil (BoxGeometry face UVs 0..1)
  // (ground grime up the lower boards)
  b.add(new THREE.BoxGeometry(L, H, W, 2, 3, 2), "crate", { m: mul(m, M(0, H / 2, 0)), uv: "keep", color: o.tint ?? 0xf0eadc, mud: { y0: m.elements[13], h: 0.45, k: 0.45 } });
  // corner posts + rim (raw wood)
  // corner posts + rim (raw wood) — plain boxes (12 tris; 44-tri bevels on 7–9 cm sticks never read)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(box(0.09, H + 0.02, 0.09), "wood", { m: mul(m, M(sx * (L / 2 - 0.02), H / 2 + 0.01, sz * (W / 2 - 0.02))), tile: 1 });
  for (const sz of [-1, 1]) b.add(box(L + 0.04, 0.07, 0.07), "wood", { m: mul(m, M(0, H + 0.02, sz * (W / 2))), tile: 1 });
  for (const sx of [-1, 1]) b.add(box(0.07, 0.07, W + 0.04), "wood", { m: mul(m, M(sx * (L / 2), H + 0.02, 0)), tile: 1 });
  if (o.lid) b.add(box(L - 0.04, 0.04, W - 0.04), "deck", { m: mul(m, M(0, H + 0.01, 0)), tile: 1.5 });
  if (o.full) bananaHeap(b, mul(m, M(0, H - 0.06, 0)), L - 0.1, W - 0.1, 4, o.seed ?? 1, 0.16);
}

export function pallet(b: Batch, m: THREE.Matrix4) {
  for (let i = 0; i < 5; i++) b.add(box(1.2, 0.03, 0.14), "deck", { m: mul(m, M(0, 0.13, -0.4 + i * 0.2)), tile: 1.2, color: 0xd8c8a8 });
  for (const z of [-0.4, 0, 0.4]) b.add(box(1.2, 0.1, 0.12), "wood", { m: mul(m, M(0, 0.05, z)), tile: 1 });
}

/** 200 l steel drum (0.6 Ø × 0.9) with rolling hoops, lid rim and bung */
export function drum(b: Batch, m: THREE.Matrix4, color: THREE.ColorRepresentation, onSide = false) {
  const mm = onSide ? mul(m, M(0, 0.3, 0, 0, 0, Math.PI / 2, 1)) : m;
  const base = onSide ? M(0, -0.45, 0) : M();
  const at = (y: number) => mul(mm, mul(base, M(0, y, 0)));
  b.add(cyl(0.29, 0.29, 0.86, 20), "pmetal", { m: at(0.45), uv: "local", tile: 1.8, color });
  for (const y of [0.3, 0.6]) b.add(new THREE.TorusGeometry(0.29, 0.012, 5, 20).rotateX(Math.PI / 2), "pmetal", { m: at(y), uv: "local", tile: 1, color });
  for (const y of [0.02, 0.88]) b.add(new THREE.TorusGeometry(0.285, 0.018, 5, 20).rotateX(Math.PI / 2), "steel", { m: at(y), uv: "local", color: 0x8a8a8a });
  b.add(cyl(0.285, 0.285, 0.02, 20), "pmetal", { m: at(0.87), uv: "local", tile: 1, color: new THREE.Color(color).multiplyScalar(0.8) });
  b.add(cyl(0.035, 0.035, 0.03, 8), "steel", { m: mul(at(0.89), M(0.16, 0, 0.05)), color: 0x707070 });
}

/** wooden barrel with iron hoops (0.9 m) */
export function barrel(b: Batch, m: THREE.Matrix4) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(new THREE.Vector2(0.28 + 0.06 * Math.sin(Math.PI * t), t * 0.9)); }
  const g = new THREE.LatheGeometry(pts, 16);
  b.add(g, "wood", { m, uv: "local", tile: 0.6, color: 0xb88a5a });
  for (const y of [0.1, 0.32, 0.58, 0.8]) {
    const r = 0.28 + 0.06 * Math.sin(Math.PI * y / 0.9) + 0.006;
    b.add(new THREE.TorusGeometry(r, 0.012, 4, 18).rotateX(Math.PI / 2), "steel", { m: mul(m, M(0, y, 0)), color: 0x4a4038 });
  }
  b.add(cyl(0.28, 0.28, 0.02, 16), "wood", { m: mul(m, M(0, 0.89, 0)), uv: "local", tile: 0.5, color: 0x9a7048 });
}

export function jerryCan(b: Batch, m: THREE.Matrix4, color: THREE.ColorRepresentation = 0xc0392b) {
  b.add(rbox(0.36, 0.46, 0.17, 0.03), "pmetal", { m: mul(m, M(0, 0.23, 0)), uv: "local", tile: 1, color });
  b.add(rbox(0.2, 0.04, 0.05, 0.015), "pmetal", { m: mul(m, M(-0.04, 0.48, 0)), color });
  b.add(cyl(0.025, 0.025, 0.06, 8), "steel", { m: mul(m, M(0.12, 0.49, 0, 0, 0, -0.5)), color: 0x606060 });
}

export function sack(b: Batch, m: THREE.Matrix4, color: THREE.ColorRepresentation = 0xcdb993) {
  const g = new THREE.SphereGeometry(0.3, 10, 8);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setXYZ(i, p.getX(i) * 1.25, y * (y < 0 ? 0.55 : 0.8), p.getZ(i) * 0.9); }
  g.computeVertexNormals();
  b.add(g, "fabric", { m: mul(m, M(0, 0.17, 0)), uv: "local", tile: 1, color });
}

// ------------------------------------------------------------------------------------------------ fences & rails
/** picket/rail fence along a polyline following the ground (`y` fixed or terrain). White by default. */
export function railFence(b: Batch, pts: Array<[number, number]>, o: { terrain?: Terrain; y?: number; h?: number; spacing?: number; color?: THREE.ColorRepresentation; mat?: MatKey; rails?: number } = {}) {
  const h = o.h ?? 1.05, sp = o.spacing ?? 2.2, col = o.color ?? 0xf1ede2, mt = o.mat ?? "wood", rails = o.rails ?? 2;
  const Y = (x: number, z: number) => (o.y !== undefined ? o.y : o.terrain!.height(x, z));
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / sp));
    for (let k = 0; k <= n; k++) {
      if (k === n && i < pts.length - 2) continue;
      const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n, y = Y(x, z);
      b.add(rbox(0.13, h + 0.35, 0.13, 0.025), mt, { m: M(x, y + (h + 0.35) / 2 - 0.3, z), tile: 1, color: col });
      b.add(rbox(0.17, 0.05, 0.17, 0.02), mt, { m: M(x, y + h + 0.06, z), tile: 1, color: col });
    }
    for (let k = 0; k < n; k++) {
      const x0 = ax + (bx - ax) * k / n, z0 = az + (bz - az) * k / n, x1 = ax + (bx - ax) * (k + 1) / n, z1 = az + (bz - az) * (k + 1) / n;
      const y0 = Y(x0, z0), y1 = Y(x1, z1), len = Math.hypot(x1 - x0, z1 - z0), yaw = Math.atan2(-(z1 - z0), x1 - x0), pitch = Math.atan2(y1 - y0, len);
      for (let r = 0; r < rails; r++) {
        const ry = h * (rails === 1 ? 0.95 : 0.45 + 0.5 * r / (rails - 1));
        b.add(rbox(Math.hypot(len, y1 - y0) + 0.1, 0.09, 0.05, 0.015), mt, { m: M((x0 + x1) / 2, (y0 + y1) / 2 + ry, (z0 + z1) / 2, 0, yaw, pitch, 1, 1, 1, "YZX"), tile: 1.5, color: col });
      }
    }
  }
}

/** metal or wood balustrade: posts + top rail + mid rails between two points at height y (frame space) */
export function railing(b: Batch, x0: number, z0: number, x1: number, z1: number, y: number, o: { h?: number; spacing?: number; mat?: MatKey; color?: THREE.ColorRepresentation; bars?: number; thick?: number; balusters?: boolean } = {}) {
  const h = o.h ?? 1.1, sp = o.spacing ?? 1.2, mt = o.mat ?? "pmetal", col = o.color ?? 0x3a332c, t = o.thick ?? 0.05;
  const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / sp)), yaw = Math.atan2(-(z1 - z0), x1 - x0);
  for (let k = 0; k <= n; k++) {
    const x = x0 + (x1 - x0) * k / n, z = z0 + (z1 - z0) * k / n;
    b.add(rbox(t * 1.4, h, t * 1.4, t * 0.3), mt, { m: M(x, y + h / 2, z, 0, yaw, 0), tile: 1, color: col });
  }
  b.add(rbox(L + t * 2, t * 1.3, t * 2, t * 0.4), mt, { m: M((x0 + x1) / 2, y + h, (z0 + z1) / 2, 0, yaw, 0), tile: 1, color: col });
  const bars = o.bars ?? 1;
  for (let r = 1; r <= bars; r++) b.add(rbox(L, t * 0.8, t * 0.8, t * 0.2), mt, { m: M((x0 + x1) / 2, y + h * r / (bars + 1), (z0 + z1) / 2, 0, yaw, 0), tile: 1, color: col });
  if (o.balusters) {
    const nb = Math.round(L / 0.16);
    for (let k = 1; k < nb; k++) { const x = x0 + (x1 - x0) * k / nb, z = z0 + (z1 - z0) * k / nb; b.add(box(t * 0.6, h - 0.1, t * 0.6), mt, { m: M(x, y + h / 2, z, 0, yaw, 0), tile: 1, color: col }); }
  }
}

// ------------------------------------------------------------------------------------------------ furniture & dressing
export function picnicTable(b: Batch, m: THREE.Matrix4) {
  b.add(rbox(2.0, 0.07, 0.85, 0.02), "deck", { m: mul(m, M(0, 0.78, 0)), tile: 1.5, color: 0xd9c6a6 });
  for (const s of [-1, 1]) {
    b.add(rbox(2.0, 0.06, 0.3, 0.02), "deck", { m: mul(m, M(0, 0.46, s * 0.72)), tile: 1.5, color: 0xd9c6a6 });
    for (const e of [-0.75, 0.75]) b.add(rbox(0.08, 1.1, 0.08, 0.02), "wood", { m: mul(m, M(e, 0.42, s * 0.36, s * 0.62, 0, 0)), tile: 1 });
  }
  for (const e of [-0.75, 0.75]) b.add(rbox(0.08, 0.08, 1.7, 0.02), "wood", { m: mul(m, M(e, 0.42, 0)), tile: 1 });
}

export function bench(b: Batch, m: THREE.Matrix4) {
  b.add(rbox(1.8, 0.06, 0.42, 0.02), "deck", { m: mul(m, M(0, 0.45, 0)), tile: 1.5 });
  b.add(rbox(1.8, 0.3, 0.05, 0.02), "deck", { m: mul(m, M(0, 0.78, -0.2, -0.15, 0, 0)), tile: 1.5 });
  for (const e of [-0.75, 0.75]) { b.add(rbox(0.07, 0.45, 0.4, 0.02), "wood", { m: mul(m, M(e, 0.22, 0)), tile: 1 }); b.add(rbox(0.06, 0.6, 0.06, 0.02), "wood", { m: mul(m, M(e, 0.7, -0.2, -0.15, 0, 0)), tile: 1 }); }
}

/** striped windsock on a pole; the sock points along local +X (downwind), drooping slightly */
export function windsock(b: Batch, m: THREE.Matrix4, poleH = 6, lattice = false) {
  if (lattice) latticeMast(b, m, poleH, 0.35, { color: 0x9a9a9a, bands: false });
  else b.add(cyl(0.06, 0.08, poleH, 10), "pmetal", { m: mul(m, M(0, poleH / 2, 0)), uv: "local", color: 0xe8e4dc });
  b.add(new THREE.TorusGeometry(0.34, 0.025, 6, 16), "steel", { m: mul(m, M(0.05, poleH - 0.2, 0, 0, Math.PI / 2, 0)), color: 0x555555 });
  // sock: 5 alternating stripes, tapering, droop
  const seg = 5, L = 2.6;
  for (let i = 0; i < seg; i++) {
    const t0 = i / seg, t1 = (i + 1) / seg, r0 = 0.34 - 0.18 * t0, r1 = 0.34 - 0.18 * t1;
    const g = new THREE.CylinderGeometry(r1, r0, L / seg, 14, 1, true);
    g.rotateZ(-Math.PI / 2);
    const x = 0.05 + (t0 + t1) / 2 * L, drop = -0.35 * ((t0 + t1) / 2) ** 2;
    b.add(g, "fabric", { m: mul(m, M(x, poleH - 0.2 + drop, 0, 0, 0, -0.18 * (t0 + t1) / 2)), uv: "local", tile: 1, color: i % 2 ? 0xf4f0e8 : 0xe0442e });
  }
}

/** triangular lattice mast (red/white bands optional) */
export function latticeMast(b: Batch, m: THREE.Matrix4, h: number, w = 0.9, o: { color?: THREE.ColorRepresentation; bands?: boolean; taper?: number } = {}) {
  const taper = o.taper ?? 0.45, legs = 3, bandH = h / 7;
  const corner = (k: number, y: number) => { const a = (k / legs) * Math.PI * 2 + Math.PI / 6, r = (w / 2) * (1 - taper * y / h); return [Math.cos(a) * r, y, Math.sin(a) * r]; };
  const segs = Math.ceil(h / 1.2);
  const bandCol = (y: number) => (o.bands === false ? (o.color ?? 0xdddddd) : Math.floor(y / bandH) % 2 ? 0xf2efe8 : 0xd8392b);
  for (let k = 0; k < legs; k++) {
    for (let s = 0; s < segs; s++) {
      const y0 = (s / segs) * h, y1 = ((s + 1) / segs) * h;
      const a = corner(k, y0), c = corner(k, y1);
      strut(b, a, c, 0.05, bandCol((y0 + y1) / 2), m);
      const a2 = corner((k + 1) % legs, y1);
      strut(b, a, a2, 0.025, bandCol((y0 + y1) / 2), m);
      const h2 = corner((k + 1) % legs, y0);
      strut(b, a, h2, 0.025, bandCol(y0), m);
    }
  }
}

/** cylinder strut between two points (frame-local coords, then matrix m) */
export function strut(b: Batch, a: number[], c: number[], r: number, color: THREE.ColorRepresentation, m: THREE.Matrix4, key: MatKey = "pmetal") {
  const va = new THREE.Vector3(...(a as [number, number, number])), vc = new THREE.Vector3(...(c as [number, number, number]));
  const d = vc.clone().sub(va), L = d.length();
  if (L < 1e-3) return;
  const g = new THREE.CylinderGeometry(r, r, L, 5, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  const mm = new THREE.Matrix4().compose(va.clone().add(vc).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  b.add(g, key, { m: mul(m, mm), uv: "local", tile: 1, color });
}

/** parabolic dish antenna facing local +Z */
export function dish(b: Batch, m: THREE.Matrix4, r = 0.7) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(new THREE.Vector2(t * r, t * t * r * 0.35)); }
  const g = new THREE.LatheGeometry(pts, 20);
  g.rotateX(Math.PI / 2);
  b.add(g, "pmetal", { m, uv: "local", tile: 1, color: 0xe9e6de });
  // the shell's BACK (without it the dish is invisible from behind):
  // same bowl 4 cm behind, winding flipped, a darker grey with a rim + 4 ribs
  const back = new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p.x, p.y - 0.04)), 20); back.rotateX(Math.PI / 2);
  { const ix = back.index!; for (let i = 0; i < ix.count; i += 3) { const a = ix.getX(i + 1); ix.setX(i + 1, ix.getX(i + 2)); ix.setX(i + 2, a); } back.computeVertexNormals(); }
  b.add(back, "pmetal", { m, uv: "local", tile: 1, color: 0xb9b6ae });
  { const rim = new THREE.TorusGeometry(r, 0.035, 5, 28); rim.translate(0, 0, r * 0.35 - 0.02); b.add(rim, "pmetal", { m, uv: "local", tile: 1, color: 0xd8d5cc }); }
  for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + 0.4; strut(b, [0, 0, -0.06], [Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92, r * 0.3], 0.025, 0x8a8780, m); }
  b.add(cyl(0.02, 0.02, r * 0.8, 6), "steel", { m: mul(m, M(0, 0, r * 0.4, Math.PI / 2, 0, 0)), color: 0x777777 });
  b.add(sph(0.06, 8, 6), "steel", { m: mul(m, M(0, 0, r * 0.8)), color: 0x666666 });
  b.add(cyl(0.08, 0.1, 0.2, 8), "steel", { m: mul(m, M(0, 0, -0.08, Math.PI / 2, 0, 0)), color: 0x5a5a5a });
}

/** lamp post with a warm lantern; returns the world lamp position (frame-space) for glow sprites */
export function lampPost(b: Batch, m: THREE.Matrix4, h = 3.4) {
  b.add(cyl(0.05, 0.08, h, 8), "pmetal", { m: mul(m, M(0, h / 2, 0)), uv: "local", color: 0x2d2a26 });
  b.add(cyl(0.14, 0.18, 0.12, 8), "pmetal", { m: mul(m, M(0, 0.06, 0)), color: 0x2d2a26 });
  b.add(rbox(0.26, 0.34, 0.26, 0.03), "lamp", { m: mul(m, M(0, h + 0.1, 0)) });
  b.add(cyl(0.02, 0.22, 0.14, 4), "pmetal", { m: mul(m, M(0, h + 0.34, 0, 0, Math.PI / 4, 0)), color: 0x2d2a26 });
  return new THREE.Vector3(0, h + 0.1, 0).applyMatrix4(m);
}

/** wall-mounted lantern (bracket along local +Z) */
export function wallLamp(b: Batch, m: THREE.Matrix4) {
  b.add(box(0.05, 0.05, 0.3), "pmetal", { m: mul(m, M(0, 0.2, 0.15)), color: 0x2d2a26 });
  b.add(rbox(0.2, 0.28, 0.2, 0.02), "lamp", { m: mul(m, M(0, 0.05, 0.3)) });
  b.add(cyl(0.01, 0.16, 0.1, 4), "pmetal", { m: mul(m, M(0, 0.24, 0.3, 0, Math.PI / 4, 0)), color: 0x2d2a26 });
  return new THREE.Vector3(0, 0.05, 0.3).applyMatrix4(m);
}

/** faceted stylised boulder: convex hull of jittered ellipsoid points, gently rounded; size = radii */
export function boulderGeo(seed: number, rx: number, ry: number, rz: number, facets = 26) {
  const r = rng(seed), pts: THREE.Vector3[] = [];
  for (let i = 0; i < facets; i++) {
    const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const k = 0.78 + r() * 0.3;
    pts.push(new THREE.Vector3(Math.cos(a) * s * rx * k, u * ry * k, Math.sin(a) * s * rz * k));
  }
  let g: THREE.BufferGeometry = new ConvexGeometry(pts);
  g = g.index ? g : g;
  g.computeVertexNormals();
  return g;
}

/** smooth chunky boulder: subdivided icosphere with low-frequency lumps + a couple of flat facets (chiselled look) */
export function roundBoulderGeo(seed: number, rx: number, ry: number, rz: number, detail = 3) {
  const r = rng(seed), g = new THREE.IcosahedronGeometry(1, detail);
  const ph = Array.from({ length: 9 }, () => r() * 6.283), fq = Array.from({ length: 3 }, () => 1.3 + r() * 1.4);
  const cuts = Array.from({ length: 3 }, () => { const v = new THREE.Vector3(r() - 0.5, r() * 0.8 - 0.2, r() - 0.5).normalize(); return { n: v, d: 0.78 + r() * 0.12 }; });
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    let k = 1 + 0.12 * Math.sin(v.x * fq[0] + ph[0]) * Math.sin(v.y * fq[1] + ph[1]) + 0.09 * Math.sin(v.z * fq[2] + ph[2] + v.x) + 0.04 * Math.sin(v.y * 5 + ph[3]) * Math.cos(v.x * 4 + ph[4]);
    v.multiplyScalar(k);
    for (const c of cuts) { const d = v.dot(c.n); if (d > c.d) v.addScaledVector(c.n, c.d - d); }
    if (v.y < -0.55) v.y = -0.55 + (v.y + 0.55) * 0.2;
    p.setXYZ(i, v.x * rx, v.y * ry, v.z * rz);
  }
  g.computeVertexNormals();
  return g;
}

/** a boulder sitting on the terrain (sunk a bit), with moss on top via vertex colours */
export function boulder(b: Batch, terrain: Terrain, x: number, z: number, size: number, seed: number, o: { yaw?: number; flat?: number; sink?: number; tint?: THREE.ColorRepresentation; key?: MatKey } = {}) {
  const ry = size * (o.flat ?? 0.7);
  const g = roundBoulderGeo(seed, size, ry, size * 0.85);
  const n = g.attributes.normal, p = g.attributes.position, col = new Float32Array(p.count * 3);
  const base = new THREE.Color(o.tint ?? 0xffffff), moss = new THREE.Color(0x86a64a), dark = base.clone().multiplyScalar(0.62);
  for (let i = 0; i < p.count; i++) {
    const up = n.getY(i), t = Math.max(0, (up - 0.6) / 0.4) * 0.8, low = Math.max(0, Math.min(1, (-p.getY(i) / ry) * 1.2));
    const c = base.clone().lerp(dark, low * 0.6).lerp(moss, t);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const y = terrain.height(x, z) - ry * (o.sink ?? 0.3);
  b.add(g, o.key ?? "rock", { m: M(x, y, z, 0, o.yaw ?? seed, 0), uv: "box", tile: Math.max(2, size * 1.6) });
  blobShadow(b, terrain, x, z, size * 2.8, size * 2.5, o.yaw ?? 0, undefined, 0.8);
}

/** stacked logs */
export function logPile(b: Batch, m: THREE.Matrix4, n = 6) {
  let k = 0;
  for (let row = 0; k < n; row++) for (let i = 0; i < 3 - row && k < n; i++, k++) {
    const g = cyl(0.14, 0.14, 1.6, 10);
    g.rotateX(Math.PI / 2);
    b.add(g, "wood", { m: mul(m, M((i - (2 - row) / 2) * 0.29, 0.14 + row * 0.25, 0)), uv: "local", tile: 1, color: 0xa47a52 });
  }
}

/** simple ladder (rails + rungs) from (0,0,0) up local +Y, leaning toward -Z by `lean` radians */
export function ladder(b: Batch, m: THREE.Matrix4, h: number, w = 0.55, key: MatKey = "pmetal", color: THREE.ColorRepresentation = 0x585048) {
  for (const s of [-1, 1]) b.add(box(0.05, h, 0.06), key, { m: mul(m, M(s * w / 2, h / 2, 0)), color, tile: 1 });
  for (let y = 0.3; y < h; y += 0.3) b.add(cyl(0.02, 0.02, w, 6).rotateZ(Math.PI / 2), key, { m: mul(m, M(0, y, 0)), color, uv: "local", tile: 1 });
}

/** floodlight pole with a cross-bar of 4 lamp heads (plantation). `lit` = emissive lenses (night); by day the lenses
 *  are plain frosted glass (lit at midday they make a pink halo in the sky). Returns lens positions (frame space). */
export function floodPole(b: Batch, m: THREE.Matrix4, h = 11, lit = false) {
  b.add(cyl(0.1, 0.16, h, 10), "pmetal", { m: mul(m, M(0, h / 2, 0)), uv: "local", tile: 2, color: 0x9a9a98 });
  b.add(cyl(0.2, 0.26, 0.4, 10), "pmetal", { m: mul(m, M(0, 0.2, 0)), color: 0x9d988e }); // pmetal, not concrete: one draw fewer
  b.add(box(2.2, 0.1, 0.1), "pmetal", { m: mul(m, M(0, h - 0.1, 0)), color: 0x6a6a68 });
  b.add(box(1.4, 0.06, 0.06), "pmetal", { m: mul(m, M(0, h - 0.8, 0)), color: 0x6a6a68 });
  for (const s of [-1, 1]) strut(b, [s * 0.1, h - 1.4, 0], [s * 0.7, h - 0.12, 0], 0.03, 0x6a6a68, m);
  b.add(rbox(0.36, 0.5, 0.24, 0.03), "pmetal", { m: mul(m, M(0, 1.6, 0.14)), color: 0x8d8f86 }); // junction box
  const out: THREE.Vector3[] = [];
  for (const x of [-0.85, -0.3, 0.3, 0.85]) {
    b.add(rbox(0.46, 0.36, 0.22, 0.04), "pmetal", { m: mul(m, M(x, h + 0.2, 0.05, -0.45, 0, 0)), color: 0xdedcd6 });
    b.add(box(0.38, 0.28, 0.02), lit ? "lamp" : "plain", { m: mul(m, M(x, h + 0.14, 0.17, -0.45, 0, 0)), color: 0xe6ecef });
    b.add(box(0.04, 0.34, 0.12), "pmetal", { m: mul(m, M(x, h + 0.02, 0, 0, 0, 0)), color: 0x6a6a68 });
    out.push(new THREE.Vector3(x, h + 0.13, 0.2).applyMatrix4(m));
  }
  return lit ? out : [];
}
