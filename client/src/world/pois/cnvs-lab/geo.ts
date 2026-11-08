// CNVS LAB — geometry bins: pieces are collected per material (with a per-vertex tint colour and metre UVs) and merged
// into ONE mesh per material per bin set (shell / interior / near props), so the whole POI is a few dozen draw calls.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { chamferBox, uvByNormal } from "../_kit/harbor-geo";

export type V3 = [number, number, number];
const _c = new THREE.Color();

/** strip to position/normal/uv, non-indexed */
function norm(g: THREE.BufferGeometry, uv: boolean, uvScale = 1): THREE.BufferGeometry {
  let o = g.index ? g.toNonIndexed() : g;
  if (!o.attributes.normal) o.computeVertexNormals();
  if (uv || !o.attributes.uv) uvByNormal(o, uvScale);
  for (const k of Object.keys(o.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") o.deleteAttribute(k);
  if (o === g) o = g.clone();
  return o;
}

/** COPLANAR RESOLVER. Every axis-aligned box the lab builds is registered while BOX_REG is set; resolveCoplanar()
 *  then finds face pairs that lie in the same plane, face the same way and overlap (the z-fight: two depths equal to
 *  the last bit) and moves ONE of the two faces off the plane by EPS: the smaller face (a band, trim strip,
 *  overlapping skin) steps OUT — unless its box lies entirely inside the bigger one (a buried piece sharing one
 *  face): that face steps IN, out of sight. Only that face's plane moves (every vertex on it — the side faces stretch
 *  with it, the box stays closed, its neighbours are untouched). Build-time, a few ms. */
export const EPS_COPLANAR = 0.004;
let BOX_REG: Array<{ g: THREE.BufferGeometry; lo: V3; hi: V3 }> | null = null;
export function trackBoxes(on: boolean) { BOX_REG = on ? [] : null; }
export async function resolveCoplanar(y: () => Promise<void>): Promise<{ boxes: number; pairs: number; moved: number }> {
  const R = BOX_REG; BOX_REG = null;
  if (!R) return { boxes: 0, pairs: 0, moved: 0 };
  // (a face can sit in several overlaps: passes until no coplanar pair is left — the moved faces leave their planes)
  const out = { boxes: R.length, pairs: 0, moved: 0 };
  for (let pass = 0; pass < 4; pass++) { const r = coplanarPass(R); if (pass === 0) out.pairs = r.pairs; out.moved += r.moved; if (!r.moved) break; await y(); }
  return out;
}
function coplanarPass(R: Array<{ g: THREE.BufferGeometry; lo: V3; hi: V3 }>): { pairs: number; moved: number } {
  const Q = 0.002, faces = new Map<string, Array<{ i: number; ax: number; sg: number; a: number; u0: number; u1: number; v0: number; v1: number; c: number }>>();
  R.forEach((b, i) => {
    for (let ax = 0; ax < 3; ax++) for (const sg of [-1, 1]) {
      const c = sg > 0 ? b.hi[ax] : b.lo[ax], ua = (ax + 1) % 3, va = (ax + 2) % 3;
      const f = { i, ax, sg, a: (b.hi[ua] - b.lo[ua]) * (b.hi[va] - b.lo[va]), u0: b.lo[ua], u1: b.hi[ua], v0: b.lo[va], v1: b.hi[va], c };
      const k = `${ax}${sg}:${Math.round(c / Q)}`;
      (faces.get(k) ?? faces.set(k, []).get(k)!).push(f);
    }
  });
  // box i, face (ax, sg) → offset along that face's outward normal
  const act = new Map<string, { i: number; ax: number; sg: number; c: number; d: number }>();
  let pairs = 0;
  for (const [k, list] of faces) {
    const [h, q] = k.split(":"), near = faces.get(`${h}:${+q + 1}`) ?? [];
    for (let x = 0; x < list.length; x++) for (const f of [...list.slice(x + 1), ...near]) {
      const e = list[x];
      if (e.i === f.i || Math.abs(e.c - f.c) > Q * 1.5) continue;
      const ou = Math.min(e.u1, f.u1) - Math.max(e.u0, f.u0), ov = Math.min(e.v1, f.v1) - Math.max(e.v0, f.v0);
      if (ou < 0.01 || ov < 0.01) continue;
      pairs++;
      const [sm, bg] = e.a < f.a || (e.a === f.a && e.i > f.i) ? [e, f] : [f, e];
      const key = `${sm.i}:${sm.ax}${sm.sg}`;
      if (act.has(key) || act.has(`${bg.i}:${bg.ax}${bg.sg}`)) continue;
      const A = R[sm.i], B = R[bg.i], t = 0.001;
      const inside = A.lo.every((v, j) => v >= B.lo[j] - t) && A.hi.every((v, j) => v <= B.hi[j] + t);
      const depth = A.hi[sm.ax] - A.lo[sm.ax];
      act.set(key, { i: sm.i, ax: sm.ax, sg: sm.sg, c: sm.c, d: inside ? -Math.min(EPS_COPLANAR, depth * 0.25) : EPS_COPLANAR });
    }
  }
  for (const m of act.values()) {
    const p = R[m.i].g.attributes.position as THREE.BufferAttribute, arr = p.array as Float32Array;
    for (let v = 0; v < p.count; v++) if (Math.abs(arr[v * 3 + m.ax] - m.c) < 1e-3) arr[v * 3 + m.ax] += m.sg * m.d;
    p.needsUpdate = true;
    if (m.sg > 0) R[m.i].hi[m.ax] += m.d; else R[m.i].lo[m.ax] -= m.d;
  }
  return { pairs, moved: act.size };
}

const rotLo = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number): V3 => { const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, sw = Math.abs(Math.sin(r)) > 0.5, hx = sw ? (z1 - z0) / 2 : (x1 - x0) / 2, hz = sw ? (x1 - x0) / 2 : (z1 - z0) / 2; return [cx - hx, y0, cz - hz]; };
const rotHi = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number): V3 => { const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, sw = Math.abs(Math.sin(r)) > 0.5, hx = sw ? (z1 - z0) / 2 : (x1 - x0) / 2, hz = sw ? (x1 - x0) / 2 : (z1 - z0) / 2; return [cx + hx, y1, cz + hz]; };

export class Bins {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  tris = 0;
  /** the geometry the last add() stored (resolveCoplanar's registry) */
  last: THREE.BufferGeometry | null = null;
  /** add a geometry (local), placed with m, tinted `tint` (hex / Color); uv = regenerate metre UVs in the piece frame */
  add(mat: THREE.Material, g: THREE.BufferGeometry, m?: THREE.Matrix4, tint: THREE.ColorRepresentation = 0xffffff, uv = true, uvScale = 1): this {
    const geo = norm(g, uv, uvScale);
    if (m) { geo.applyMatrix4(m); if (m.determinant() < 0) flip(geo); }
    const n = geo.attributes.position.count, col = new Float32Array(n * 3);
    _c.set(tint);
    // alias materials (draw-call consolidation): render with the target material, tint × the alias colour (may be > 1:
    // emissive strength for the glow family)
    const al = (mat.userData as { alias?: THREE.Material; aliasTint?: [number, number, number] });
    if (al.alias) { _c.r *= al.aliasTint![0]; _c.g *= al.aliasTint![1]; _c.b *= al.aliasTint![2]; mat = al.alias; }
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    (this.parts.get(mat) ?? this.parts.set(mat, []).get(mat)!).push(geo);
    this.tris += n / 3; this.last = geo;
    return this;
  }
  /** axis-aligned (or yawed, three convention) box from min/max corners; bevel > 0 → chamfered */
  box(mat: THREE.Material, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, o: { bevel?: number; tint?: THREE.ColorRepresentation; rotY?: number; uvOff?: V3 } = {}): this {
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    if (w <= 1e-4 || h <= 1e-4 || d <= 1e-4) return this;
    const g = o.bevel ? chamferBox(w, h, d, o.bevel) : new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Matrix4().makeRotationY(o.rotY ?? 0).setPosition((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    // materials flagged uv01 (screens, signs) keep the box's own per-face 0..1 UVs (the picture fills each face)
    const reg = () => { if (BOX_REG && this.last && !((o.rotY ?? 0) % (Math.PI / 2))) BOX_REG.push({ g: this.last, lo: o.rotY ? rotLo(x0, y0, z0, x1, y1, z1, o.rotY) : [x0, y0, z0], hi: o.rotY ? rotHi(x0, y0, z0, x1, y1, z1, o.rotY) : [x1, y1, z1] }); return this; };
    if ((mat.userData as { uv01?: boolean }).uv01) { this.add(mat, norm(g, false), m, o.tint ?? 0xffffff, false); return reg(); }
    // metre UVs in WORLD-aligned frame (textures continue across neighbouring pieces)
    const geo = norm(g, false);
    geo.translate((x0 + x1) / 2 + (o.uvOff?.[0] ?? 0), (y0 + y1) / 2 + (o.uvOff?.[1] ?? 0), (z0 + z1) / 2 + (o.uvOff?.[2] ?? 0));
    uvByNormal(geo);
    geo.translate(-(x0 + x1) / 2 - (o.uvOff?.[0] ?? 0), -(y0 + y1) / 2 - (o.uvOff?.[1] ?? 0), -(z0 + z1) / 2 - (o.uvOff?.[2] ?? 0));
    this.add(mat, geo, m, o.tint ?? 0xffffff, false);
    return reg();
  }
  /** box centred at c, size s, yaw (three rotation.y), pitch (x), roll (z) */
  obox(mat: THREE.Material, c: V3, s: V3, o: { yaw?: number; pitch?: number; roll?: number; bevel?: number; tint?: THREE.ColorRepresentation } = {}): this {
    const g = o.bevel ? chamferBox(s[0], s[1], s[2], o.bevel) : new THREE.BoxGeometry(s[0], s[1], s[2]);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...c), new THREE.Quaternion().setFromEuler(new THREE.Euler(o.pitch ?? 0, o.yaw ?? 0, o.roll ?? 0, "YXZ")), new THREE.Vector3(1, 1, 1));
    return this.add(mat, g, m, o.tint ?? 0xffffff, true);
  }
  /** cylinder between two points */
  cyl(mat: THREE.Material, a: V3, b: V3, r: number, seg = 10, o: { r1?: number; tint?: THREE.ColorRepresentation; caps?: boolean } = {}): this {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), L = d.length();
    if (L < 1e-4) return this;
    const g = new THREE.CylinderGeometry(o.r1 ?? r, r, L, seg, 1, o.caps === false);
    // uv: u around (metres), v along
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    const m = new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r, uv.getY(i) * L);
    return this.add(mat, g, m, o.tint ?? 0xffffff, false);
  }
  /** straight tube through points (rails) */
  poly(mat: THREE.Material, pts: V3[], r: number, seg = 8, tint: THREE.ColorRepresentation = 0xffffff): this {
    for (let i = 0; i < pts.length - 1; i++) this.cyl(mat, pts[i], pts[i + 1], r, seg, { tint });
    for (let i = 1; i < pts.length - 1; i++) this.add(mat, new THREE.SphereGeometry(r, seg, 6), new THREE.Matrix4().makeTranslation(...pts[i]), tint);
    return this;
  }
  lathe(mat: THREE.Material, prof: Array<[number, number]>, seg: number, m: THREE.Matrix4, tint: THREE.ColorRepresentation = 0xffffff, polarUV = false): this {
    const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg);
    if (polarUV) {
      const pos = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
      const rmax = Math.max(...prof.map((p) => p[0]));
      for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i); uv.setXY(i, (Math.atan2(z, x) / (2 * Math.PI) + 0.5), Math.hypot(x, z) / rmax); }
      return this.add(mat, g, m, tint, false);
    }
    return this.add(mat, g, m, tint, true);
  }
  /** a flat quad (two tris) facing +normal given 4 corners (counter-clockwise seen from the front), uv 0..1 or metres */
  quad(mat: THREE.Material, p: [V3, V3, V3, V3], tint: THREE.ColorRepresentation = 0xffffff, uv01 = true): this {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3]], 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    g.computeVertexNormals();
    return this.add(mat, g, undefined, tint, !uv01);
  }
  empty() { return this.parts.size === 0; }
  /** move every geometry of `o` into this bin (o is left empty) */
  absorb(o: Bins): this { for (const [m, gs] of o.parts) { const a = this.parts.get(m); if (a) a.push(...gs); else this.parts.set(m, gs.slice()); } o.parts.clear(); this.tris += o.tris; o.tris = 0; return this; }
  /** build with a yield after every ~8 ms of merging (the shell bin is one ~50 ms task otherwise) */
  async buildAsync(name: string, o: { cast?: boolean; receive?: boolean; far?: boolean | "force" } = {}, y: () => Promise<void> = async () => {}): Promise<THREE.Group> {
    const all = [...this.parts], grp = new THREE.Group(); grp.name = name;
    let t0 = performance.now();
    for (const [mat, geos] of all) {
      // (a material with thousands of pieces merges in chunks of ≤ 600, a yield between: one 30–40 ms merge was a task)
      for (let i = 0; i < geos.length; i += 600) {
        this.parts = new Map([[mat, geos.slice(i, i + 600)]]);
        for (const c of this.build(name, o).children.slice()) grp.add(c);
        if (performance.now() - t0 > 8) { await y(); t0 = performance.now(); }
      }
    }
    this.parts.clear();
    return grp;
  }
  build(name: string, o: { cast?: boolean; receive?: boolean; far?: boolean | "force" } = {}): THREE.Group {
    const grp = new THREE.Group(); grp.name = name;
    for (const [mat, geos] of this.parts) {
      if (!geos.length) continue;
      const g = mergeGeometries(geos, false);
      if (!g) { console.warn(`[cnvs-lab] merge failed ${name}/${mat.name}`); continue; }
      g.computeBoundingBox(); g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = `${name}:${mat.name}`;
      const transparent = (mat as THREE.Material).transparent;
      mesh.castShadow = !transparent && (o.cast ?? true); mesh.receiveShadow = o.receive ?? true;
      mesh.userData.castShadow = mesh.castShadow; mesh.userData.receiveShadow = mesh.receiveShadow;
      if (o.far !== undefined) mesh.userData.farShadow = o.far;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      grp.add(mesh);
    }
    this.parts.clear();
    return grp;
  }
}

function flip(g: THREE.BufferGeometry) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i += 3) for (const a of Object.values(g.attributes) as THREE.BufferAttribute[]) {
    const s = a.itemSize; for (let k = 0; k < s; k++) { const t = a.array[(i + 1) * s + k]; (a.array as Float32Array)[(i + 1) * s + k] = a.array[(i + 2) * s + k]; (a.array as Float32Array)[(i + 2) * s + k] = t; }
  }
}

/** a bin that files every piece into a sub-bin by where it lands (`key` of its transformed bounding-box centre),
 *  so the interiors draw per pod and each pod's interior culls on its own distance */
export class RoutedBins extends Bins {
  subs = new Map<string, Bins>();
  private readonly v = new THREE.Vector3();
  constructor(private readonly key: (x: number, y: number, z: number) => string) { super(); }
  add(mat: THREE.Material, g: THREE.BufferGeometry, m?: THREE.Matrix4, tint: THREE.ColorRepresentation = 0xffffff, uv = true, uvScale = 1): this {
    if (!g.boundingBox) g.computeBoundingBox();
    g.boundingBox!.getCenter(this.v); if (m) this.v.applyMatrix4(m);
    const k = this.key(this.v.x, this.v.y, this.v.z);
    let b = this.subs.get(k); if (!b) this.subs.set(k, b = new Bins());
    const t0 = b.tris; b.add(mat, g, m, tint, uv, uvScale); this.tris += b.tris - t0; this.last = b.last;
    return this;
  }
}

