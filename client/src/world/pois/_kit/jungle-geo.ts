// poi-jungle kit — geometry builders. Everything is built in WORLD space (apply the transform, then compute
// world-projected UVs, then merge) so one static merged mesh per material carries hundreds of blocks/rocks with
// continuous texture tiling and zero per-object overhead.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry } from "./jungle-mat";
import type { Box } from "../../../../../shared/world/colliders";

export type Geo = THREE.BufferGeometry;

// ---------------------------------------------------------------- noise (JS side, for displacement)
const P = new Uint8Array(512);
{ const r = mulberry(99); const p = Array.from({ length: 256 }, (_, i) => i); for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) P[i] = p[i & 255]; }
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const grad = (h: number, x: number, y: number, z: number) => { const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); };
/** classic 3D Perlin, -1..1 */
export function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
  const l = THREE.MathUtils.lerp;
  return l(l(l(grad(P[AA], x, y, z), grad(P[BA], x - 1, y, z), u), l(grad(P[AB], x, y - 1, z), grad(P[BB], x - 1, y - 1, z), u), v),
           l(l(grad(P[AA + 1], x, y, z - 1), grad(P[BA + 1], x - 1, y, z - 1), u), l(grad(P[AB + 1], x, y - 1, z - 1), grad(P[BB + 1], x - 1, y - 1, z - 1), u), v), w);
}
export function fbm3(x: number, y: number, z: number, oct = 3): number {
  let a = 0, f = 1, amp = 0.5; for (let i = 0; i < oct; i++) { a += amp * noise3(x * f, y * f, z * f); f *= 2.03; amp *= 0.5; } return a;
}

// ---------------------------------------------------------------- transforms & attributes
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Euler();
/** apply a world transform in place */
export function place(g: Geo, x: number, y: number, z: number, ry = 0, scale: number | [number, number, number] = 1, rx = 0, rz = 0): Geo {
  _e.set(rx, ry, rz); _q.setFromEuler(_e); _p.set(x, y, z);
  if (typeof scale === "number") _s.setScalar(scale); else _s.set(...scale);
  g.applyMatrix4(_m.compose(_p, _q, _s));
  return g;
}

/** world-space box projection: uv = the two coordinates orthogonal to the dominant normal axis, in metres */
export function boxUVs(g: Geo, scale = 1): Geo {
  const pos = g.attributes.position as THREE.BufferAttribute;
  if (!g.attributes.normal) g.computeVertexNormals();
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u: number, v: number;
    if (ny >= nx && ny >= nz) { u = x; v = z; } else if (nx >= nz) { u = z; v = y; } else { u = x; v = y; }
    uv[i * 2] = u / scale; uv[i * 2 + 1] = v / scale;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

/** constant vertex colour (multiplies the material's albedo) */
export function tint(g: Geo, color: THREE.ColorRepresentation, variance = 0): Geo {
  const c = new THREE.Color(color), n = (g.attributes.position as THREE.BufferAttribute).count, arr = new Float32Array(n * 3);
  const k = 1 + (Math.random() * 2 - 1) * variance;
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r * k; arr[i * 3 + 1] = c.g * k; arr[i * 3 + 2] = c.b * k; }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

/** make attribute sets compatible (position, normal, uv, color) so mergeGeometries never drops anything */
export function normalizeAttrs(g: Geo): Geo {
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) boxUVs(g, 1);
  if (!g.attributes.color) tint(g, "#ffffff");
  for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(k)) g.deleteAttribute(k);
  g.morphAttributes = {};
  return g;
}

export function merge(geos: Geo[]): Geo | null {
  const list = geos.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g)).map(normalizeAttrs);
  if (!list.length) return null;
  const m = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  return m;
}

/** a static shadow-casting mesh from merged geometry */
export function staticMesh(g: Geo | null, mat: THREE.Material, name = "", shadows = true): THREE.Mesh | null {
  if (!g) return null;
  const m = new THREE.Mesh(g, mat);
  m.name = name; m.castShadow = shadows; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrix();
  return m;
}

// ---------------------------------------------------------------- primitives
/** bevelled block: a CHAMFERED box (44 triangles — 6 faces, 12 flat 45° edge bevels, 8 corner facets) that catches the
 *  light on every edge like hand-cut stone / timber. (Was RoundedBoxGeometry: 108–300 tris per block.) */
export function bevelBox(w: number, h: number, d: number, bevel = 0.06): Geo {
  const x = w / 2, y = h / 2, z = d / 2, b = Math.max(0.002, Math.min(bevel, x * 0.45, y * 0.45, z * 0.45));
  // per corner (sx, sy, sz): its point on the X face, the Y face and the Z face
  const X = (sx: number, sy: number, sz: number) => [sx * x, sy * (y - b), sz * (z - b)];
  const Y = (sx: number, sy: number, sz: number) => [sx * (x - b), sy * y, sz * (z - b)];
  const Z = (sx: number, sy: number, sz: number) => [sx * (x - b), sy * (y - b), sz * z];
  const pos: number[] = [];
  const tri = (a: number[], c: number[], e: number[]) => {
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = e[0] - a[0], vy = e[1] - a[1], vz = e[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const cx = a[0] + c[0] + e[0], cy = a[1] + c[1] + e[1], cz = a[2] + c[2] + e[2];
    if (nx * cx + ny * cy + nz * cz >= 0) pos.push(...a, ...c, ...e); else pos.push(...a, ...e, ...c);
  };
  const quad = (a: number[], c: number[], e: number[], f: number[]) => { tri(a, c, e); tri(a, e, f); };
  for (const s of [-1, 1]) {
    quad(X(s, -1, -1), X(s, 1, -1), X(s, 1, 1), X(s, -1, 1));
    quad(Y(-1, s, -1), Y(1, s, -1), Y(1, s, 1), Y(-1, s, 1));
    quad(Z(-1, -1, s), Z(1, -1, s), Z(1, 1, s), Z(-1, 1, s));
  }
  for (const a of [-1, 1]) for (const c of [-1, 1]) {
    quad(X(a, c, -1), X(a, c, 1), Y(a, c, 1), Y(a, c, -1));   // edges along z
    quad(Y(-1, a, c), Y(1, a, c), Z(1, a, c), Z(-1, a, c));   // edges along x
    quad(X(a, -1, c), X(a, 1, c), Z(a, 1, c), Z(a, -1, c));   // edges along y
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) tri(X(sx, sy, sz), Y(sx, sy, sz), Z(sx, sy, sz));
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  // per-face 0..1 UVs like BoxGeometry (dominant normal axis of each triangle picks the projection)
  const nv = pos.length / 3, uv = new Float32Array(nv * 2), nrm = g.attributes.normal as THREE.BufferAttribute;
  for (let t = 0; t < nv; t += 3) {
    const ax = Math.abs(nrm.getX(t)), ay = Math.abs(nrm.getY(t)), az = Math.abs(nrm.getZ(t));
    for (let k = t; k < t + 3; k++) {
      const px = pos[k * 3], py = pos[k * 3 + 1], pz = pos[k * 3 + 2];
      let u: number, v: number;
      if (ax >= ay && ax >= az) { u = (pz / (2 * z) + 0.5) * (nrm.getX(t) > 0 ? -1 : 1); v = py / (2 * y) + 0.5; }
      else if (ay >= az) { u = px / (2 * x) + 0.5; v = (pz / (2 * z) + 0.5) * (nrm.getY(t) > 0 ? -1 : 1); }
      else { u = (px / (2 * x) + 0.5) * (nrm.getZ(t) > 0 ? 1 : -1); v = py / (2 * y) + 0.5; }
      uv[k * 2] = u < 0 ? u + 1 : u; uv[k * 2 + 1] = v < 0 ? v + 1 : v;
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

/** a placed, textured bevel box (uv scale in metres) */
export function block(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, o: { bevel?: number; uvScale?: number; tint?: THREE.ColorRepresentation; var?: number; rx?: number; rz?: number } = {}): Geo {
  const g = place(bevelBox(w, h, d, o.bevel ?? 0.06), x, y, z, ry, 1, o.rx ?? 0, o.rz ?? 0);
  boxUVs(g, o.uvScale ?? 1);
  tint(g, o.tint ?? "#ffffff", o.var ?? 0.08);
  return g;
}

export interface RockOpts { seed?: number; detail?: 1 | 2 | 3; angular?: boolean; flatBottom?: number; rough?: number; tint?: THREE.ColorRepresentation }
/** a stylized rock: icosphere displaced by fbm; `angular` = low detail + flat shading (basalt); else smooth boulder */
export function rock(rx: number, ry: number, rz: number, o: RockOpts = {}): Geo {
  const seed = o.seed ?? 1, rnd = mulberry(seed), detail = o.detail ?? (o.angular ? 1 : 2);
  let g: Geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const ox = rnd() * 100, oy = rnd() * 100, oz = rnd() * 100, rough = o.rough ?? (o.angular ? 0.32 : 0.22);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const n = fbm3(v.x * 1.3 + ox, v.y * 1.3 + oy, v.z * 1.3 + oz, 3) + 0.5 * noise3(v.x * 3.1 + oz, v.y * 3.1 + ox, v.z * 3.1 + oy);
    let r = 1 + rough * n;
    if (o.angular) r += 0.12 * (rnd() - 0.5);
    v.multiplyScalar(r);
    // flatten the base so it sits on the ground
    const fb = o.flatBottom ?? 0.55;
    if (v.y < -fb) v.y = -fb - (v.y + fb) * 0.15;
    pos.setXYZ(i, v.x * rx, v.y * ry, v.z * rz);
  }
  if (o.angular) { g.computeVertexNormals(); } else { g = mergeVertsSmooth(g); }
  boxUVs(g, 1);
  tint(g, o.tint ?? "#ffffff", 0.06);
  return g;
}
/** smooth normals on a non-indexed geometry by welding by position */
function mergeVertsSmooth(g: Geo): Geo {
  const pos = g.attributes.position as THREE.BufferAttribute, n = pos.count;
  const key = new Map<string, number[]>(), acc = new Float32Array(n * 3);
  const tri = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    tri.subVectors(c, b).cross(a.clone().sub(b));
    for (let k = 0; k < 3; k++) { const j = i + k; const kk = `${pos.getX(j).toFixed(4)},${pos.getY(j).toFixed(4)},${pos.getZ(j).toFixed(4)}`; let l = key.get(kk); if (!l) key.set(kk, (l = [])); l.push(j); acc[j * 3] += tri.x; acc[j * 3 + 1] += tri.y; acc[j * 3 + 2] += tri.z; }
  }
  const nor = new Float32Array(n * 3);
  for (const idx of key.values()) {
    let x = 0, y = 0, z = 0; for (const j of idx) { x += acc[j * 3]; y += acc[j * 3 + 1]; z += acc[j * 3 + 2]; }
    const l = Math.hypot(x, y, z) || 1; for (const j of idx) { nor[j * 3] = x / l; nor[j * 3 + 1] = y / l; nor[j * 3 + 2] = z / l; }
  }
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return g;
}

/** stacked stone drum (totem plinth, altar base, column) */
export function drum(r: number, h: number, x: number, y: number, z: number, segs = 12, o: { tint?: THREE.ColorRepresentation; uvScale?: number } = {}): Geo {
  const g = place(new THREE.CylinderGeometry(r, r * 1.04, h, segs, 1), x, y + h / 2, z);
  boxUVs(g, o.uvScale ?? 1); tint(g, o.tint ?? "#ffffff", 0.06); return g;
}

/** sagging rope between two points (catenary-ish parabola). uv.u runs in metres for the rope texture. */
export function ropeCurve(a: THREE.Vector3, b: THREE.Vector3, sag: number, n = 16): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) { const t = i / n; pts.push(new THREE.Vector3().lerpVectors(a, b, t).add(new THREE.Vector3(0, -sag * 4 * t * (1 - t), 0))); }
  return new THREE.CatmullRomCurve3(pts);
}
export function rope(a: THREE.Vector3, b: THREE.Vector3, sag: number, radius = 0.08, segs = 24): Geo {
  const curve = ropeCurve(a, b, sag);
  const g = new THREE.TubeGeometry(curve, segs, radius, 6, false);
  const len = curve.getLength(), uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / 0.6, uv.getY(i));
  tint(g, "#ffffff"); return g;
}
/** rope lashing ring around a post */
export function lashing(x: number, y: number, z: number, r: number, turns = 3, ry = 0): Geo {
  const parts: Geo[] = [];
  for (let i = 0; i < turns; i++) parts.push(place(new THREE.TorusGeometry(r + 0.05, 0.045, 4, r > 0.15 ? 14 : 10), x, y + i * 0.09, z, ry, 1, Math.PI / 2));
  return merge(parts)!;
}

/** stone/timber stair — returns the visual geometry and matching collider boxes. Steps rise toward +dir (yaw). */
export function stairs(x: number, y: number, z: number, width: number, steps: number, rise: number, tread: number, yaw: number, o: { bevel?: number; uvScale?: number; tint?: THREE.ColorRepresentation; surf?: Box["surf"]; solid?: boolean } = {}): { geo: Geo; boxes: Box[] } {
  const parts: Geo[] = [], boxes: Box[] = [];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (let i = 0; i < steps; i++) {
    const along = i * tread + tread / 2, h = o.solid === false ? rise : rise * (i + 1);
    const cx = x + c * along, cz = z + s * along; // yaw 0 → +x
    const cy = y + (o.solid === false ? rise * i + rise / 2 : h / 2);
    parts.push(block(tread + 0.02, h, width, cx, cy, cz, -yaw, { bevel: o.bevel ?? 0.05, uvScale: o.uvScale ?? 1, tint: o.tint, var: 0.05 }));
    boxes.push({ c: [cx, cy, cz], h: [tread / 2 + 0.01, h / 2, width / 2], yaw: -yaw, surf: o.surf ?? "stone" });
  }
  return { geo: merge(parts)!, boxes };
}

/** wooden crate (uses the painted BANANA CO. side texture on a separate material — returned as its own mesh) */
export function crateMesh(size: number, mat: THREE.Material, x: number, y: number, z: number, ry = 0): THREE.Mesh {
  const g = bevelBox(size, size * 0.8, size, 0.03);
  const m = new THREE.Mesh(g, mat); m.position.set(x, y + size * 0.4, z); m.rotation.y = ry; m.castShadow = m.receiveShadow = true; return m;
}
export function barrel(x: number, y: number, z: number, r = 0.42, h = 1.0): { wood: Geo; bands: Geo } {
  const wood = place(new THREE.CylinderGeometry(r * 0.92, r * 0.92, h, 14, 1), x, y + h / 2, z); boxUVs(wood, 0.6); tint(wood, "#7a4b22");
  const bands = merge([0.12, 0.5, 0.88].map((t) => place(new THREE.CylinderGeometry(r, r, 0.07, 14, 1, true), x, y + h * t, z)))!;
  tint(bands, "#4a4038");
  return { wood, bands };
}

/** a banana: curved tapered tube with a stem, +x = tip direction, lying on its side */
export function banana(len = 0.22, x = 0, y = 0, z = 0, ry = 0, rz = 0): Geo {
  const pts = [new THREE.Vector3(-len / 2, 0, 0), new THREE.Vector3(-len / 4, len * 0.12, 0), new THREE.Vector3(len / 4, len * 0.12, 0), new THREE.Vector3(len / 2, -len * 0.02, 0)];
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, 8, len * 0.12, 6, false);
  const pos = g.attributes.position as THREE.BufferAttribute; // taper the ends
  for (let i = 0; i < pos.count; i++) { const t = (pos.getX(i) + len / 2) / len; const k = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, Math.max(0, t))); const p = curve.getPoint(Math.min(1, Math.max(0, t))); pos.setXYZ(i, pos.getX(i), p.y + (pos.getY(i) - p.y) * k, pos.getZ(i) * k); }
  g.computeVertexNormals();
  place(g, x, y, z, ry, 1, 0, rz); tint(g, "#ffd83a", 0.05); return g;
}


/** convert a placed axis-aligned block to a collider */
export const boxCol = (x: number, y: number, z: number, w: number, h: number, d: number, yaw = 0, surf: Box["surf"] = "stone"): Box => ({ c: [x, y, z], h: [w / 2, h / 2, d / 2], yaw, surf });
