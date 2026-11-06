// poi-town: procedural BRONZE GORILLA STATUE (hero of the Mango Market fountain).
// Sculpted in code as a signed-distance field — ~150 smooth-blended muscle/feature primitives (round cones,
// ellipsoids, rounded boxes) with carved eyes, nostrils, mouth, finger and toe grooves — polygonised with narrow-band
// surface nets, decimated with meshoptimizer (quadric) to the triangle budget, shaded with analytic SDF normals and a
// baked patina (SDF ambient occlusion + curvature: verdigris in crevices, rubbed-bright bronze on raised forms, green
// run-off streaks, polished toes/knuckles). The golden banana bunch is a separate swept mesh (5-ridged bananas).
// Built once per page (cached), every call returns a light group sharing the geometry.
//
// Pose: chest out, statue's RIGHT arm (−x, image-left seen from the front) raised high gripping
// the bunch by its stalk; LEFT arm bent, elbow out, fist in front of the hip; short bent legs, wide stance.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import type { LabEnv } from "./town-lab";
// @ts-ignore — three ships the meshopt simplifier (wasm, MIT) without typings
import { MeshoptSimplifier } from "three/addons/libs/meshopt_simplifier.module.js";
import { M, col, cylGeo, latheGeo, chamferBoxGeo } from "./town-geo";
import { shadowOnlyMaterial } from "./town-materials";
import { ctxPace, type Pace } from "./pace";
import { flag } from "../../../flags";

interface Simplifier {
  ready: Promise<void>;
  supported: boolean;
  simplify(idx: Uint32Array, pos: Float32Array, stride: number, target: number, err: number, flags?: string[]): [Uint32Array, number];
}
const SIMP = MeshoptSimplifier as Simplifier;

// ---------------------------------------------------------------------------------------------------------------
// SDF sculpt kit
type V3 = [number, number, number];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: V3): V3 => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** combination of basis vectors: o + u*a + v*b + w*c */
const comb = (o: V3, u: V3, a: number, v: V3, b: number, w: V3, c: number): V3 =>
  [o[0] + u[0] * a + v[0] * b + w[0] * c, o[1] + u[1] * a + v[1] * b + w[1] * c, o[2] + u[2] * a + v[2] * b + w[2] * c];

const smin = (a: number, b: number, k: number) => {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
};

const enum PK { Ell, Cone, Box }
interface Prim {
  grp: false; add: boolean; k: number; t: PK;
  c: V3; r: V3; R: number[]; // centre, radii / half extents, world→local rows
  a: V3; ba: V3; l2: number; rr: number; a2: number; il2: number; ra: number; rb: number; round: number;
  lo: V3; hi: V3;
}
interface Grp { grp: true; add: boolean; k: number; items: Array<Prim | Grp>; lo: V3; hi: V3; name: string }
/** padding added to every bound (≥ the narrow band + AO reach the mesher/baker query) */
const PAD = 0.14;

function evalPrim(p: Prim, x: number, y: number, z: number): number {
  if (p.t === PK.Cone) {
    const pax = x - p.a[0], pay = y - p.a[1], paz = z - p.a[2];
    const ba = p.ba, l2 = p.l2;
    const yy = pax * ba[0] + pay * ba[1] + paz * ba[2];
    const zz = yy - l2;
    const qx = pax * l2 - ba[0] * yy, qy = pay * l2 - ba[1] * yy, qz = paz * l2 - ba[2] * yy;
    const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2;
    const k = Math.sign(p.rr) * p.rr * p.rr * x2;
    if (Math.sign(zz) * p.a2 * z2 > k) return Math.sqrt(x2 + z2) * p.il2 - p.rb;
    if (Math.sign(yy) * p.a2 * y2 < k) return Math.sqrt(x2 + y2) * p.il2 - p.ra;
    return (Math.sqrt(x2 * p.a2 * p.il2) + yy * p.rr) * p.il2 - p.ra;
  }
  const dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2], R = p.R;
  const lx = R[0] * dx + R[1] * dy + R[2] * dz, ly = R[3] * dx + R[4] * dy + R[5] * dz, lz = R[6] * dx + R[7] * dy + R[8] * dz;
  if (p.t === PK.Ell) {
    const rx = p.r[0], ry = p.r[1], rz = p.r[2];
    if (rx === ry && ry === rz) return Math.hypot(lx, ly, lz) - rx;
    const k0 = Math.hypot(lx / rx, ly / ry, lz / rz);
    const k1 = Math.hypot(lx / (rx * rx), ly / (ry * ry), lz / (rz * rz));
    return k1 < 1e-9 ? -Math.min(rx, ry, rz) : k0 * (k0 - 1) / k1;
  }
  const rd = p.round;
  const qx = Math.abs(lx) - p.r[0] + rd, qy = Math.abs(ly) - p.r[1] + rd, qz = Math.abs(lz) - p.r[2] + rd;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - rd;
}
function evalGrp(g: Grp, x: number, y: number, z: number, cull: boolean): number {
  let d = 1e9;
  for (const it of g.items) {
    if (cull && (x < it.lo[0] || x > it.hi[0] || y < it.lo[1] || y > it.hi[1] || z < it.lo[2] || z > it.hi[2])) continue;
    const v = it.grp ? evalGrp(it, x, y, z, cull) : evalPrim(it, x, y, z);
    if (it.add) d = smin(d, v, it.k);
    else d = -smin(-d, v, it.k); // smooth subtraction: max(d, -v)
  }
  return d;
}

/** rotation rows (world→local) from yaw/pitch/roll (YXZ like town-geo M) */
function rotRows(yaw = 0, pitch = 0, roll = 0): number[] {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
  const e = m.elements; // column-major: column i = local axis i in world
  return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
}
/** rotation rows from a local y axis direction and a hint for local z */
function rowsAlong(dir: V3, zHint: V3): number[] {
  const ay = norm3(dir);
  let az = sub3(zHint, mul3(ay, dot3(zHint, ay)));
  if (len3(az) < 1e-4) az = Math.abs(ay[0]) < 0.9 ? cross3(ay, [1, 0, 0]) : cross3(ay, [0, 0, 1]);
  az = norm3(az);
  const ax = cross3(ay, az);
  return [...ax, ...ay, ...az];
}

class Sculpt {
  root: Grp = { grp: true, add: true, k: 0, items: [], lo: [0, 0, 0], hi: [0, 0, 0], name: "root" };
  private stack: Grp[] = [this.root];
  private sub = false;
  private get cur() { return this.stack[this.stack.length - 1]; }
  group(name: string, k: number, fn: () => void, add = true) {
    const g: Grp = { grp: true, add, k, items: [], lo: [0, 0, 0], hi: [0, 0, 0], name };
    this.cur.items.push(g); this.stack.push(g); fn(); this.stack.pop();
  }
  /** everything created inside `fn` is carved away (smooth subtraction with each prim's k) */
  carve(fn: () => void) { const s = this.sub; this.sub = true; fn(); this.sub = s; }
  private push(p: Omit<Prim, "grp" | "add" | "lo" | "hi">) {
    const prim: Prim = { ...p, grp: false, add: !this.sub, lo: [0, 0, 0], hi: [0, 0, 0] };
    // bounds
    if (p.t === PK.Cone) {
      const b = add3(p.a, p.ba);
      for (let i = 0; i < 3; i++) { prim.lo[i] = Math.min(p.a[i] - p.ra, b[i] - p.rb); prim.hi[i] = Math.max(p.a[i] + p.ra, b[i] + p.rb); }
    } else {
      for (let i = 0; i < 3; i++) {
        const h = Math.abs(p.R[i]) * p.r[0] + Math.abs(p.R[3 + i]) * p.r[1] + Math.abs(p.R[6 + i]) * p.r[2];
        prim.lo[i] = p.c[i] - h; prim.hi[i] = p.c[i] + h;
      }
    }
    for (let i = 0; i < 3; i++) { prim.lo[i] -= PAD + p.k; prim.hi[i] += PAD + p.k; }
    this.cur.items.push(prim);
  }
  private base() { return { a: [0, 0, 0] as V3, ba: [0, 0, 0] as V3, l2: 0, rr: 0, a2: 0, il2: 0, ra: 0, rb: 0, round: 0, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], c: [0, 0, 0] as V3, r: [0, 0, 0] as V3 }; }
  sph(c: V3, r: number, k = 0.03) { this.push({ ...this.base(), t: PK.Ell, k, c, r: [r, r, r] }); }
  ell(c: V3, r: V3, k = 0.03, yaw = 0, pitch = 0, roll = 0) { this.push({ ...this.base(), t: PK.Ell, k, c, r, R: rotRows(yaw, pitch, roll) }); }
  /** ellipsoid whose local y spans a→b (× `over`), radius rx across, rz towards `zHint` */
  ellAlong(a: V3, b: V3, rx: number, rz: number, zHint: V3 = [0, 0, 1], k = 0.03, over = 1) {
    const c = lerp3(a, b, 0.5), ry = len3(sub3(b, a)) / 2 * over;
    this.push({ ...this.base(), t: PK.Ell, k, c, r: [rx, ry, rz], R: rowsAlong(sub3(b, a), zHint) });
  }
  box(c: V3, half: V3, round: number, k = 0.03, yaw = 0, pitch = 0, roll = 0) { this.push({ ...this.base(), t: PK.Box, k, c, r: half, round: Math.min(round, half[0], half[1], half[2]), R: rotRows(yaw, pitch, roll) }); }
  boxAlong(c: V3, half: V3, round: number, yAxis: V3, zHint: V3, k = 0.03) { this.push({ ...this.base(), t: PK.Box, k, c, r: half, round: Math.min(round, half[0], half[1], half[2]), R: rowsAlong(yAxis, zHint) }); }
  /** round cone a(ra) → b(rb) */
  cone(a: V3, b: V3, ra: number, rb: number, k = 0.03) {
    const ba = sub3(b, a), l2 = dot3(ba, ba), rr = ra - rb;
    this.push({ ...this.base(), t: PK.Cone, k, a, ba, l2, rr, a2: l2 - rr * rr, il2: 1 / l2, ra, rb });
  }
  /** chain of round cones through points with radii */
  chain(pts: V3[], rs: number[], k = 0.03) { for (let i = 0; i < pts.length - 1; i++) this.cone(pts[i], pts[i + 1], rs[i], rs[i + 1], k); }
  /** raw (unculled) distance of everything built so far — for placing features on the surface while sculpting */
  d(p: V3) { return evalGrp(this.root, p[0], p[1], p[2], false); }
  /** sphere-trace from `o` along `dir` to the current surface (falls back to o + dir*max) */
  hit(o: V3, dir: V3, max = 2): V3 {
    const n = norm3(dir); let t = 0;
    for (let i = 0; i < 96 && t < max; i++) { const d = this.d(comb(o, n, t, n, 0, n, 0)); if (d < 0.0008) break; t += Math.max(d * 0.8, 0.0015); }
    return comb(o, n, t, n, 0, n, 0);
  }
  finalize(): Grp {
    const bound = (g: Grp) => {
      const lo: V3 = [1e9, 1e9, 1e9], hi: V3 = [-1e9, -1e9, -1e9];
      for (const it of g.items) {
        if (it.grp) bound(it);
        if (!it.add) continue; // carves never extend a group
        for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], it.lo[i]); hi[i] = Math.max(hi[i], it.hi[i]); }
      }
      for (let i = 0; i < 3; i++) { g.lo[i] = lo[i] - g.k; g.hi[i] = hi[i] + g.k; }
    };
    bound(this.root);
    return this.root;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the gorilla (design units = metres, feet on the plate at y ≈ 0.09, faces +z; rescaled to `height` afterwards)
interface Anchors { gripR: V3; gripAxis: V3; polish: Array<[V3, number]> }

function sculptGorilla(): { root: Grp; anchors: Anchors } {
  const S = new Sculpt();
  const polish: Array<[V3, number]> = [];

  // ---- bronze base plate (cast with the figure; feet fillet into it)
  S.group("plate", 0.02, () => {
    S.box([0, 0.035, 0.05], [0.8, 0.035, 0.58], 0.03, 0);
  });

  // ---- legs: short, thick, bowed; knees out-forward; big hand-like feet gripping the plate
  for (const s of [-1, 1]) {
    const H: V3 = [s * 0.27, 0.8, 0.0], K: V3 = [s * 0.5, 0.46, 0.15], A: V3 = [s * 0.47, 0.23, 0.02];
    S.group(`leg${s}`, 0.07, () => {
      S.cone(H, K, 0.28, 0.19, 0.06);
      S.ellAlong(lerp3(H, K, 0.05), lerp3(H, K, 1.0), 0.22, 0.22, [0, 0.3, 1], 0.06);          // quads mass
      S.ellAlong(add3(lerp3(H, K, 0.2), [s * 0.07, 0, -0.07]), add3(lerp3(H, K, 0.9), [s * 0.05, 0, -0.08]), 0.18, 0.16, [0, 0, 1], 0.05); // hamstring/outer
      S.sph(add3(K, [0, 0.01, 0.06]), 0.16, 0.05);                                             // knee
      S.cone(K, A, 0.18, 0.13, 0.05);
      S.ellAlong(add3(lerp3(K, A, 0.0), [s * 0.03, 0, -0.08]), add3(lerp3(K, A, 0.7), [s * 0.02, 0, -0.06]), 0.16, 0.14, [0, 0, 1], 0.05); // calf
      S.sph(A, 0.13, 0.05);
    });
    // foot (own group, tighter blends so toes stay readable)
    const fy = s * 0.22; // toes splay outward
    const fdir: V3 = [Math.sin(fy), 0, Math.cos(fy)], fside: V3 = [Math.cos(fy), 0, -Math.sin(fy)];
    const F: V3 = [s * 0.48, 0.145, 0.1];
    S.group(`foot${s}`, 0.05, () => {
      S.box(F, [0.15, 0.075, 0.2], 0.07, 0.04, fy);
      S.sph(comb(F, fdir, -0.15, fside, 0, fdir, 0), 0.125, 0.05);                                  // heel
      S.ellAlong(comb(A, fdir, -0.02, fside, 0, fdir, 0), comb(F, fdir, 0.05, fside, 0, fdir, 0), 0.15, 0.13, [0, 1, 0], 0.05); // instep
      // four toes: knuckled capsules curling down onto the plate
      for (let i = 0; i < 4; i++) {
        const off = (i - 1.5) * 0.07 + s * 0.02;
        const t0 = comb(F, fdir, 0.13, fside, off, [0, 1, 0], 0.02), t1 = comb(F, fdir, 0.225, fside, off * 1.1, [0, 1, 0], 0.0), t2 = comb(F, fdir, 0.255, fside, off * 1.12, [0, 1, 0], -0.05);
        S.chain([t0, t1, t2], [0.058, 0.052, 0.046], 0.018);
        if (i === 0 || i === 3) polish.push([t1, 0.07]);
      }
      // big toe (hallux) splayed toward the midline
      const h0 = comb(F, fdir, 0.02, fside, -s * 0.11, [0, 1, 0], 0.0), h1 = comb(F, fdir, 0.12, fside, -s * 0.2, [0, 1, 0], -0.02), h2 = comb(F, fdir, 0.17, fside, -s * 0.22, [0, 1, 0], -0.05);
      S.chain([h0, h1, h2], [0.064, 0.052, 0.044], 0.02);
      polish.push([h1, 0.07]);
    });
    // toe separations
    S.group(`toecut${s}`, 0.0, () => {
      S.carve(() => {
        for (let i = 0; i < 3; i++) {
          const off = (i - 1) * 0.07 + s * 0.02;
          S.cone(comb(F, fdir, 0.2, fside, off * 1.12, [0, 1, 0], 0.06), comb(F, fdir, 0.31, fside, off * 1.15, [0, 1, 0], -0.02), 0.009, 0.012, 0.01);
        }
      });
    });
  }

  // ---- torso: barrel chest, pecs, soft six-pack, lats, hunched trapezius
  S.group("torso", 0.1, () => {
    S.group("mass", 0.09, () => {
      S.ell([0, 0.84, -0.02], [0.46, 0.28, 0.35], 0.08);                // pelvis
      S.ell([0, 1.13, 0.06], [0.5, 0.42, 0.4], 0.08);                   // belly
      S.ell([0, 1.58, 0.0], [0.66, 0.5, 0.46], 0.08);                   // rib cage
      S.ell([0, 1.98, -0.1], [0.56, 0.28, 0.36], 0.08, 0, 0.35);        // trapezius hump
      for (const s of [-1, 1]) {
        S.ell([s * 0.4, 1.5, -0.12], [0.3, 0.42, 0.3], 0.08, s * 0.2);  // lats
        S.ell([s * 0.19, 0.8, -0.22], [0.22, 0.22, 0.19], 0.06);        // glutes
        S.ell([s * 0.34, 1.1, 0.12], [0.12, 0.22, 0.18], 0.08, s * 0.35); // obliques
      }
    });
    // pecs: two heavy slabs meeting at a centre groove; the raised-arm side stretched up toward the arm
    S.group("pecs", 0.05, () => {
      S.ell([-0.29, 1.76, 0.33], [0.33, 0.24, 0.17], 0.05, -0.15, 0, 0.3);
      S.ell([0.29, 1.71, 0.34], [0.33, 0.23, 0.17], 0.05, 0.15, 0, -0.2);
    });
    // six-pack: soft pads placed on the belly surface
    S.group("abs", 0.04, () => {
      for (let r = 0; r < 3; r++) for (const s of [-1, 1]) {
        const y = 1.4 - r * 0.16, x = s * (0.11 - r * 0.005);
        const p = S.hit([x, y, 1.2], [0, 0, -1]);
        S.ell(add3(p, [0, 0, -0.03]), [0.1, 0.075, 0.05], 0.04, s * 0.12);
      }
    });
    S.carve(() => {
      // linea alba (shallow) + navel
      S.cone(S.hit([0, 1.02, 1.2], [0, 0, -1]), S.hit([0, 1.5, 1.2], [0, 0, -1]), 0.012, 0.012, 0.03);
      S.sph(add3(S.hit([0, 0.93, 1.2], [0, 0, -1]), [0, 0, 0.006]), 0.024, 0.014);
    });
  });

  // ---- head: big and round, sunk low between the shoulders; one heavy brow shelf, deep-set lidded eyes, broad
  // heart-shaped nose with flared nostrils on top of a protruding muzzle, wide closed proud mouth
  const hp = (x: number, y: number, z: number): V3 => [x, y - 0.05, z + 0.03];
  S.group("head", 0.12, () => {
    S.group("skull", 0.07, () => {
      S.ell(hp(0, 2.27, 0.06), [0.38, 0.35, 0.37], 0.07);               // cranium
      S.ell(hp(0, 2.47, -0.07), [0.19, 0.2, 0.3], 0.1, 0, -0.55);      // sagittal crest, peaking toward the back
      for (const s of [-1, 1]) S.ell(hp(s * 0.22, 2.03, 0.2), [0.19, 0.2, 0.2], 0.07); // jowls
      S.ell(hp(0, 1.93, 0.25), [0.29, 0.14, 0.27], 0.07);              // jaw
      S.ell(hp(0, 2.0, 0.47), [0.25, 0.18, 0.24], 0.06);               // muzzle
      S.ell(hp(0, 1.985, 0.6), [0.2, 0.08, 0.12], 0.05);               // long bulging upper lip
      S.ell(hp(0, 1.87, 0.5), [0.18, 0.07, 0.13], 0.05);               // chin / lower lip
    });
    S.group("face", 0.045, () => {
      // brow: one continuous heavy bar with two faint lobes, sloping back into the forehead
      S.ell(hp(0, 2.37, 0.36), [0.3, 0.11, 0.14], 0.08);               // forehead
      S.ell(hp(0, 2.29, 0.44), [0.32, 0.1, 0.12], 0.07);
      for (const s of [-1, 1]) S.ell(hp(s * 0.14, 2.295, 0.46), [0.15, 0.09, 0.1], 0.06, s * 0.2, 0, -s * 0.12);
      S.ell(hp(0, 2.17, 0.56), [0.085, 0.1, 0.05], 0.05);              // nose bridge
      S.ell(hp(0, 2.07, 0.63), [0.155, 0.08, 0.06], 0.05);             // flat broad nose pad
      for (const s of [-1, 1]) S.ell(hp(s * 0.37, 2.17, 0.02), [0.045, 0.08, 0.07], 0.035, s * 0.35); // small round ears
    });
    S.carve(() => {
      for (const s of [-1, 1]) S.ell(hp(s * 0.15, 2.185, 0.53), [0.1, 0.07, 0.08], 0.03);          // eye sockets
      for (const s of [-1, 1]) {                                                                   // big nostrils
        const p = S.hit(hp(s * 0.066, 2.06, 1.2), [0, 0.3, -1]);
        S.ell(add3(p, [0, 0.003, 0.0]), [0.05, 0.034, 0.045], 0.018, s * 0.25, 0.35, s * 0.5);
      }
      for (const s of [-1, 1]) S.sph(hp(s * 0.4, 2.17, 0.04), 0.035, 0.02);                          // ear bowls
    });
    // eyeballs deep under the brow with carved pupils (classic cast-statue eyes)
    S.group("eyes", 0.012, () => {
      for (const s of [-1, 1]) S.sph(hp(s * 0.15, 2.185, 0.46), 0.066, 0.01);
    });
    S.carve(() => {
      for (const s of [-1, 1]) {
        const p = S.hit(hp(s * 0.145, 2.185, 1.2), [0, 0, -1]);
        S.sph(add3(p, [0, 0, 0.017]), 0.034, 0.008);
      }
      // mouth: a wide straight line across the muzzle, corners tucked
      const mouth: V3[] = [];
      for (let i = 0; i <= 6; i++) {
        const x = (i / 6 - 0.5) * 0.42, y = 1.935 + (Math.abs(x) / 0.21) ** 2 * 0.014;
        mouth.push(add3(S.hit(hp(x, y, 1.2), [0, 0, -1]), [0, 0, 0.004]));
      }
      S.chain(mouth, [0.009, 0.013, 0.015, 0.015, 0.015, 0.013, 0.009], 0.015);
    });
  });

  // ---- arms (upper arm, deltoid, biceps/triceps, huge forearm, fist)
  const fist = (W: V3, u: V3, v: V3, thumb: 1 | -1, sz: number, knuckleShine: boolean): { grip: V3; axis: V3 } => {
    // u = knuckle direction (continuation of the forearm), v = palm side (fingers curl towards), w = across the fingers
    u = norm3(u); v = norm3(sub3(v, mul3(u, dot3(v, u)))); const w = mul3(norm3(cross3(u, v)), thumb);
    const s = sz;
    S.group("fist", 0.025, () => {
      S.boxAlong(comb(W, u, 0.1 * s, v, 0, w, 0), [0.12 * s, 0.1 * s, 0.088 * s], 0.06 * s, u, v, 0.03); // palm block (local y = u)
      for (let i = 0; i < 4; i++) {
        const o = (i - 1.5) * 0.058 * s;
        const k0 = comb(W, u, 0.19 * s, v, -0.03 * s, w, o * 1.05);
        const k1 = comb(W, u, 0.235 * s, v, 0.045 * s, w, o * 1.02);
        const k2 = comb(W, u, 0.2 * s, v, 0.105 * s, w, o);
        const k3 = comb(W, u, 0.135 * s, v, 0.105 * s, w, o * 0.95);
        S.chain([k0, k1, k2, k3], [0.05 * s, 0.047 * s, 0.043 * s, 0.038 * s], 0.012);
        S.sph(k0, 0.052 * s, 0.015);                                    // knuckle
        if (knuckleShine) polish.push([k0, 0.08 * s]);
      }
      // thumb across the front of the curled fingers
      S.chain([comb(W, u, 0.03 * s, v, 0.06 * s, w, 0.12 * s), comb(W, u, 0.1 * s, v, 0.13 * s, w, 0.1 * s), comb(W, u, 0.16 * s, v, 0.15 * s, w, 0.03 * s)], [0.058 * s, 0.05 * s, 0.043 * s], 0.02);
    });
    S.carve(() => {
      // finger separation grooves on the curled side
      for (let i = 0; i < 3; i++) {
        const o = (i - 1) * 0.058 * s;
        S.cone(comb(W, u, 0.245 * s, v, 0.0, w, o), comb(W, u, 0.2 * s, v, 0.13 * s, w, o), 0.006 * s, 0.008 * s, 0.008);
      }
    });
    // the tunnel the curled fingers close around (a gripped stalk runs along w, thumb side up)
    return { grip: comb(W, u, 0.165 * s, v, 0.05 * s, w, 0), axis: w };
  };

  // statue's right arm (−x): raised high, forearm near-vertical, fist gripping the bunch stalk
  let gr: { grip: V3; axis: V3 } = { grip: [0, 0, 0], axis: [0, 1, 0] };
  const SR: V3 = [-0.68, 1.97, -0.02], ER: V3 = [-1.2, 2.42, 0.02], WR: V3 = [-1.24, 2.92, 0.1];
  S.group("armR", 0.07, () => {
    S.ell(add3(SR, [-0.07, 0.07, 0.0]), [0.28, 0.26, 0.28], 0.07, 0, 0, 0.6);    // deltoid
    S.cone(SR, ER, 0.21, 0.16, 0.05);
    S.ellAlong(lerp3(SR, ER, 0.25), lerp3(SR, ER, 0.9), 0.14, 0.13, [0, 0.4, 1], 0.04);    // biceps
    S.ellAlong(add3(lerp3(SR, ER, 0.15), [0, -0.07, -0.05]), add3(lerp3(SR, ER, 0.85), [0, -0.06, -0.06]), 0.13, 0.12, [0, -1, 0], 0.04); // triceps
    S.sph(ER, 0.14, 0.05);
    const mid = lerp3(ER, WR, 0.42);
    S.chain([ER, mid, WR], [0.17, 0.25, 0.15], 0.05);
    S.ellAlong(add3(lerp3(ER, WR, 0.08), [-0.05, 0, -0.02]), add3(lerp3(ER, WR, 0.72), [-0.04, 0, 0.0]), 0.2, 0.18, [0, 0, 1], 0.05); // forearm flexors
    gr = fist(WR, [0.1, 0.35, 1], [1, 0, 0], 1, 1.32, false);
  });
  // statue's left arm (+x): elbow out and back, big fist forward of the hip
  const SL: V3 = [0.7, 1.9, -0.03], EL: V3 = [1.18, 1.28, -0.14], WL: V3 = [0.96, 0.86, 0.14];
  S.group("armL", 0.07, () => {
    S.ell(add3(SL, [0.07, 0.03, 0.0]), [0.28, 0.27, 0.28], 0.07, 0, 0, -0.3);
    S.cone(SL, EL, 0.21, 0.16, 0.05);
    S.ellAlong(add3(lerp3(SL, EL, 0.25), [0, 0, 0.05]), add3(lerp3(SL, EL, 0.85), [0, 0, 0.05]), 0.13, 0.14, [0, 0, 1], 0.04);  // biceps
    S.ellAlong(add3(lerp3(SL, EL, 0.15), [0.03, 0, -0.07]), add3(lerp3(SL, EL, 0.85), [0.02, 0, -0.07]), 0.13, 0.12, [0, 0, -1], 0.04); // triceps
    S.sph(EL, 0.14, 0.05);
    const mid = lerp3(EL, WL, 0.42);
    S.chain([EL, mid, WL], [0.17, 0.26, 0.15], 0.05);
    S.ellAlong(add3(lerp3(EL, WL, 0.08), [0.05, 0, 0.0]), add3(lerp3(EL, WL, 0.72), [0.04, 0, 0.02]), 0.2, 0.19, [1, 0, 0], 0.05);
    fist(WL, sub3(WL, EL), [-1, 0, -0.35], -1, 1.32, true);
  });

  return { root: S.finalize(), anchors: { gripR: gr.grip, gripAxis: gr.axis, polish } };
}

// ---------------------------------------------------------------------------------------------------------------
// narrow-band surface nets
function polygonise(root: Grp, lo: V3, hi: V3, h: number, B: number) {
  const f = (x: number, y: number, z: number) => evalGrp(root, x, y, z, true);
  const cx = Math.ceil((hi[0] - lo[0]) / (h * B)), cy = Math.ceil((hi[1] - lo[1]) / (h * B)), cz = Math.ceil((hi[2] - lo[2]) / (h * B));
  const nx = cx * B + 1, ny = cy * B + 1, nz = cz * B + 1;
  const field = new Float32Array(nx * ny * nz).fill(NaN);
  const F = (i: number, j: number, k: number) => {
    const id = i + nx * (j + ny * k);
    let v = field[id];
    if (v !== v) { v = f(lo[0] + i * h, lo[1] + j * h, lo[2] + k * h); field[id] = v; }
    return v;
  };
  // coarse pass → active coarse cells
  const thr = B * h * 0.87 * 1.7;
  const active: number[] = [];
  const C = new Float32Array((cx + 1) * (cy + 1) * (cz + 1));
  for (let k = 0; k <= cz; k++) for (let j = 0; j <= cy; j++) for (let i = 0; i <= cx; i++) C[i + (cx + 1) * (j + (cy + 1) * k)] = F(i * B, j * B, k * B);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    let mn = 1e9, neg = false, pos = false;
    for (let c = 0; c < 8; c++) {
      const v = C[(i + (c & 1)) + (cx + 1) * ((j + ((c >> 1) & 1)) + (cy + 1) * (k + (c >> 2)))];
      mn = Math.min(mn, Math.abs(v)); if (v < 0) neg = true; else pos = true;
    }
    if (mn < thr || (neg && pos)) active.push(i, j, k);
  }
  // cell vertices (lazy)
  const cellV = new Map<number, number>();
  const verts: number[] = [];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  const cellVertex = (i: number, j: number, k: number): number => {
    const id = i + nx * (j + ny * k);
    const got = cellV.get(id);
    if (got !== undefined) return got;
    for (let c = 0; c < 8; c++) cv[c] = F(i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2));
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of EDGES) {
      const va = cv[a], vb = cv[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += (a & 1) + (((b & 1) - (a & 1)) * t); sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t); sz += (a >> 2) + (((b >> 2) - (a >> 2)) * t);
      n++;
    }
    let px = lo[0] + (i + sx / n) * h, py = lo[1] + (j + sy / n) * h, pz = lo[2] + (k + sz / n) * h;
    // one Newton step onto the true surface (kept inside the cell's neighbourhood)
    const e = h * 0.25, d0 = f(px, py, pz);
    const gx = f(px + e, py, pz) - f(px - e, py, pz), gy = f(px, py + e, pz) - f(px, py - e, pz), gz = f(px, py, pz + e) - f(px, py, pz - e);
    const gl = Math.hypot(gx, gy, gz) / (2 * e);
    if (gl > 1e-6) {
      const step = Math.max(-h * 0.6, Math.min(h * 0.6, d0 / gl));
      const inv = 1 / (gl * 2 * e);
      px -= gx * inv * step; py -= gy * inv * step; pz -= gz * inv * step;
    }
    const vi = verts.length / 3;
    verts.push(px, py, pz);
    cellV.set(id, vi);
    return vi;
  };
  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (flip) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d);
  };
  for (let n = 0; n < active.length; n += 3) {
    const i0 = active[n] * B, j0 = active[n + 1] * B, k0 = active[n + 2] * B;
    for (let k = k0; k < k0 + B; k++) for (let j = j0; j < j0 + B; j++) for (let i = i0; i < i0 + B; i++) {
      const v0 = F(i, j, k), in0 = v0 < 0;
      // edge +x
      if (j > 0 && k > 0 && i + 1 < nx && (F(i + 1, j, k) < 0) !== in0) quad(cellVertex(i, j - 1, k - 1), cellVertex(i, j, k - 1), cellVertex(i, j, k), cellVertex(i, j - 1, k), !in0);
      // edge +y
      if (i > 0 && k > 0 && j + 1 < ny && (F(i, j + 1, k) < 0) !== in0) quad(cellVertex(i - 1, j, k - 1), cellVertex(i - 1, j, k), cellVertex(i, j, k), cellVertex(i, j, k - 1), !in0);
      // edge +z
      if (i > 0 && j > 0 && k + 1 < nz && (F(i, j, k + 1) < 0) !== in0) quad(cellVertex(i - 1, j - 1, k), cellVertex(i, j - 1, k), cellVertex(i, j, k), cellVertex(i - 1, j, k), !in0);
    }
  }
  return { pos: new Float32Array(verts), idx: new Uint32Array(idx) };
}

// ---------------------------------------------------------------------------------------------------------------
// cheap deterministic 3D value noise for the patina
function hash3(i: number, j: number, k: number) {
  let h = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, z: number) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  const fx = x - i, fy = y - j, fz = z - k;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(hash3(i, j, k), hash3(i + 1, j, k), ux), l(hash3(i, j + 1, k), hash3(i + 1, j + 1, k), ux), uy),
    l(l(hash3(i, j, k + 1), hash3(i + 1, j, k + 1), ux), l(hash3(i, j + 1, k + 1), hash3(i + 1, j + 1, k + 1), ux), uy), uz);
}
const fbm = (x: number, y: number, z: number) => vnoise(x, y, z) * 0.55 + vnoise(x * 2.03, y * 2.03, z * 2.03) * 0.3 + vnoise(x * 4.1, y * 4.1, z * 4.1) * 0.15;
const sat = (v: number) => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------------------------------------------------------
// golden banana bunch (a "hand" of bananas fanning up from a crown on the stalk), swept 5-ridge sections
function bananaGeo(len: number, rMax: number, bend: number, segL = 16, segR = 15): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], colr: number[] = [], idx: number[] = [];
  const Rc = len / bend;
  const tip = new THREE.Color("#7a5412"), body = new THREE.Color("#ffffff"), stem = new THREE.Color("#b88a2a");
  const prof = (s: number) => {
    if (s < 0.14) return 0.3 + 0.1 * (s / 0.14);
    if (s < 0.42) { const t = (s - 0.14) / 0.28; return 0.4 + 0.6 * Math.sin(t * Math.PI / 2); }
    if (s < 0.8) return 1.0 - (s - 0.42) * 0.12;
    const t = (s - 0.8) / 0.2; return (0.955 - 0.1) * Math.cos(t * Math.PI / 2) ** 0.8 + 0.1 * (1 - t) + 0.12 * t;
  };
  for (let i = 0; i <= segL; i++) {
    const s = i / segL, phi = bend * s;
    const cy = Rc * Math.sin(phi), cz = Rc * (1 - Math.cos(phi));
    const ty = Math.cos(phi), tz = Math.sin(phi); // tangent; frame: X = (1,0,0), N = (0, -tz, ty)
    const r = rMax * prof(s);
    for (let j = 0; j <= segR; j++) {
      const th = j / segR * Math.PI * 2;
      const ridge = 1 + 0.075 * Math.cos(5 * th);
      const ox = Math.cos(th) * r * ridge, on = Math.sin(th) * r * ridge * 0.92;
      pos.push(ox, cy - tz * on, cz + ty * on);
      nor.push(Math.cos(th), -tz * Math.sin(th), ty * Math.sin(th));
      const c = s < 0.1 ? stem : s > 0.93 ? tip : body;
      colr.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < segL; i++) for (let j = 0; j < segR; j++) {
    const a = i * (segR + 1) + j, b = a + segR + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  // tip cap
  const phi = bend, cy = Rc * Math.sin(phi), cz = Rc * (1 - Math.cos(phi));
  const ci = pos.length / 3;
  pos.push(0, cy + Math.cos(phi) * rMax * 0.08, cz + Math.sin(phi) * rMax * 0.08); nor.push(0, Math.cos(phi), Math.sin(phi)); colr.push(tip.r, tip.g, tip.b);
  const last = segL * (segR + 1);
  for (let j = 0; j < segR; j++) idx.push(last + j, ci, last + j + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colr, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
function bunchGeo(grip: V3, axis: V3): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(...axis).normalize();
  const base = new THREE.Matrix4().makeBasis(...(() => {
    const y = up.clone(), z = new THREE.Vector3(0, 0, 1).sub(y.clone().multiplyScalar(y.z)).normalize(), x = new THREE.Vector3().crossVectors(y, z);
    return [x, y, z] as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  })()).setPosition(grip[0], grip[1], grip[2]);
  const gold = (g: THREE.BufferGeometry, c = "#ffffff") => {
    const n = g.attributes.position.count, cc = new THREE.Color(c), a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = cc.r; a[i * 3 + 1] = cc.g; a[i * 3 + 2] = cc.b; }
    g.setAttribute("color", new THREE.BufferAttribute(a, 3));
    return g;
  };
  // stalk through the fist + knobbly crown
  const stalk = gold(latheGeo([[0, -0.12], [0.055, -0.12], [0.058, 0.04], [0.08, 0.1], [0.13, 0.17], [0.13, 0.23], [0.08, 0.28], [0, 0.29]], 14), "#c89a35");
  stalk.deleteAttribute("uv");
  parts.push(stalk.applyMatrix4(base));
  // two rings of bananas fanning out and curving up
  const rings: Array<{ n: number; tilt: number; len: number; r: number; y: number; bend: number; off: number }> = [
    { n: 9, tilt: 1.45, len: 0.56, r: 0.088, y: 0.16, bend: 1.25, off: 0 },
    { n: 6, tilt: 0.9, len: 0.54, r: 0.086, y: 0.2, bend: 0.85, off: 0.5 },
    { n: 3, tilt: 0.3, len: 0.48, r: 0.082, y: 0.25, bend: 0.4, off: 0.2 },
  ];
  for (const R of rings) for (let i = 0; i < R.n; i++) {
    const yaw = (i + R.off) / R.n * Math.PI * 2 + 0.2;
    const g = bananaGeo(R.len * (0.94 + 0.12 * hash3(i, R.n, 7)), R.r, R.bend);
    // banana local: grows along +y bending toward +z; tilt it outward (toward +z) then yaw around the stalk
    // so it leaves the crown sideways and curls upward
    // (yaw about the stalk) · (tilt outward) · (half-turn so the bend plane curls the banana back UP and in)
    const m = new THREE.Matrix4().makeTranslation(0, R.y, 0)
      .multiply(new THREE.Matrix4().makeRotationY(yaw))
      .multiply(new THREE.Matrix4().makeRotationX(R.tilt))
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    g.applyMatrix4(m);
    g.applyMatrix4(base);
    parts.push(g);
  }
  const merged = mergeSimple(parts);
  return merged;
}
function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.attributes.position.count; ni += p.index ? p.index.count : p.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), colr = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const p of parts) {
    if (!p.attributes.normal) p.computeVertexNormals();
    const n = p.attributes.position.count;
    pos.set(p.attributes.position.array as Float32Array, vo * 3);
    nor.set(p.attributes.normal.array as Float32Array, vo * 3);
    colr.set(p.attributes.color.array as Float32Array, vo * 3);
    if (p.index) { const a = p.index.array; for (let i = 0; i < a.length; i++) idx[io + i] = a[i] + vo; io += a.length; }
    else { for (let i = 0; i < n; i++) idx[io + i] = vo + i; io += n; }
    vo += n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.BufferAttribute(colr, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
// build: sculpt → mesh → decimate → normals + patina
interface StatueGeo { bronze: THREE.BufferGeometry; gold: THREE.BufferGeometry; top: number; tris: number; ms: number }
let cache: Promise<StatueGeo> | null = null;
/** voxel size (m, design units) and target triangle count of the bronze body */
const VOXEL = 0.02, TARGET_TRIS = 26000;

async function buildStatueGeo(): Promise<StatueGeo> {
  const t0 = performance.now();
  const { root, anchors } = sculptGorilla();
  const f = (x: number, y: number, z: number) => evalGrp(root, x, y, z, true);
  const lo: V3 = [root.lo[0] + PAD * 0.8, -0.03, root.lo[2] + PAD * 0.8], hi: V3 = [root.hi[0] - PAD * 0.8, root.hi[1] - PAD * 0.8, root.hi[2] - PAD * 0.8];
  const t1 = performance.now();
  const { pos, idx } = polygonise(root, lo, hi, VOXEL, 5);
  const t2 = performance.now();
  // decimate (quadric) to the budget
  let fidx: Uint32Array = idx;
  await SIMP.ready;
  if (SIMP.supported && idx.length / 3 > TARGET_TRIS) {
    const [out] = SIMP.simplify(idx, pos, 3, TARGET_TRIS * 3, 0.02, []);
    fidx = out;
  }
  const t3 = performance.now();
  // compact
  const remap = new Int32Array(pos.length / 3).fill(-1);
  let nv = 0;
  for (let i = 0; i < fidx.length; i++) if (remap[fidx[i]] < 0) remap[fidx[i]] = nv++;
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), Cc = new Float32Array(nv * 3);
  for (let i = 0; i < remap.length; i++) if (remap[i] >= 0) { const o = remap[i] * 3; P[o] = pos[i * 3]; P[o + 1] = pos[i * 3 + 1]; P[o + 2] = pos[i * 3 + 2]; }
  const I = new Uint32Array(fidx.length);
  for (let i = 0; i < fidx.length; i++) I[i] = remap[fidx[i]];
  // analytic normals + patina
  const cBase = col("#726353"), cDark = col("#4c4239"), cHi = col("#ad9679"), cVerd = col("#6a8676"), cVerdDark = col("#3a4a41"), cPolish = col("#dcb574");
  const tmp = new THREE.Color();
  const e = 0.006;
  for (let v = 0; v < nv; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    let nx = f(x + e, y, z) - f(x - e, y, z), ny = f(x, y + e, z) - f(x, y - e, z), nz = f(x, y, z + e) - f(x, y, z - e);
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    N[v * 3] = nx; N[v * 3 + 1] = ny; N[v * 3 + 2] = nz;
    // ambient occlusion (SDF cone steps)
    let occ = 0, w = 1;
    for (let s = 1; s <= 5; s++) {
      const dd = 0.035 * s;
      occ += (dd - Math.max(-0.05, f(x + nx * dd, y + ny * dd, z + nz * dd))) * w;
      w *= 0.6;
    }
    const ao = sat(1 - occ * 3.2);
    // curvature: offset-surface test (convex → negative shrink, concave → positive)
    const cd = 0.03;
    const lap = (f(x + nx * cd + cd, y + ny * cd, z + nz * cd) + f(x + nx * cd - cd, y + ny * cd, z + nz * cd) + f(x + nx * cd, y + ny * cd + cd, z + nz * cd) +
      f(x + nx * cd, y + ny * cd - cd, z + nz * cd) + f(x + nx * cd, y + ny * cd, z + nz * cd + cd) + f(x + nx * cd, y + ny * cd, z + nz * cd - cd)) / 6 - cd;
    const convex = sat(lap * 400), concave = sat(-lap * 300);
    const nse = fbm(x * 3.1, y * 3.1, z * 3.1);
    tmp.copy(cBase).lerp(cDark, sat(0.5 - nse) * 0.8);
    // rain run-off streaks: green verdigris running down from upward-facing ledges
    const streak = sat((vnoise(x * 9, y * 0.8, z * 9) - 0.55) * 3.5) * sat(1 - Math.abs(ny) * 1.4) * sat((y - 0.25) * 2);
    tmp.lerp(cVerd, streak * 0.3);
    // crevices: verdigris + dark
    tmp.lerp(cVerd, concave * 0.35 * (0.6 + nse * 0.8));
    tmp.lerp(cVerdDark, sat(1 - ao) * 0.4);
    // raised forms: rubbed lighter bronze, upward faces catch a warmer sheen
    tmp.lerp(cHi, sat(convex * 0.8 + sat(ny) * 0.12) * (0.55 + nse * 0.5));
    // polished spots (toes, knuckles people touch)
    for (const [p, r] of anchors.polish) {
      const d = Math.hypot(x - p[0], y - p[1], z - p[2]);
      if (d < r * 1.6) tmp.lerp(cPolish, sat(1 - d / (r * 1.6)) * 0.85);
    }
    tmp.multiplyScalar(0.38 + 0.62 * ao);
    // grime ring at the plate
    if (y < 0.14) tmp.multiplyScalar(0.8 + 0.2 * sat(y / 0.14));
    Cc[v * 3] = tmp.r; Cc[v * 3 + 1] = tmp.g; Cc[v * 3 + 2] = tmp.b;
  }
  const bronze = new THREE.BufferGeometry();
  bronze.setAttribute("position", new THREE.BufferAttribute(P, 3));
  bronze.setAttribute("normal", new THREE.BufferAttribute(N, 3));
  bronze.setAttribute("color", new THREE.BufferAttribute(Cc, 3));
  bronze.setIndex(new THREE.BufferAttribute(I, 1));
  bronze.computeBoundingBox();
  const gold = bunchGeo(anchors.gripR, anchors.gripAxis);
  gold.computeBoundingBox();
  const top = Math.max(bronze.boundingBox!.max.y, gold.boundingBox!.max.y);
  const ms = performance.now() - t0;
  const tris = I.length / 3;
  console.info(`[town-statue] sculpt ${idx.length / 3} → ${tris} tris (+ bunch ${gold.index!.count / 3}), ${ms.toFixed(0)} ms (sdf ${(t1 - t0).toFixed(0)}, mesh ${(t2 - t1).toFixed(0)}, simplify ${(t3 - t2).toFixed(0)}, shade ${(performance.now() - t3).toFixed(0)})`);
  return { bronze, gold, top, tris, ms };
}

let mats: { bronze: THREE.MeshStandardMaterial; gold: THREE.MeshStandardMaterial } | null = null;
/** cast-bronze surface grain (procedural bump in object space) + roughness break-up; polished (bright) patina = glossier */
function addGrain(m: THREE.MeshStandardMaterial, amp: number, key: string) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGrain = { value: amp };
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vSPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSPos = position;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vSPos;
uniform float uGrain;
float gH3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gVN(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gH3(i), gH3(i + vec3(1, 0, 0)), f.x), mix(gH3(i + vec3(0, 1, 0)), gH3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(gH3(i + vec3(0, 0, 1)), gH3(i + vec3(1, 0, 1)), f.x), mix(gH3(i + vec3(0, 1, 1)), gH3(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
vec3 gPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float fd) {
  vec3 sx = normalize(dFdx(surf_pos)), sy = normalize(dFdy(surf_pos));
  vec3 r1 = cross(sy, surf_norm), r2 = cross(surf_norm, sx);
  float det = dot(sx, r1) * fd;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surf_norm - grad);
}`).replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
{ float gh = (gVN(vSPos * 24.0) * 0.5 + gVN(vSPos * 70.0) * 0.3 + gVN(vSPos * 8.0) * 0.2) * uGrain;
  normal = gPerturb(-vViewPosition, normal, vec2(dFdx(gh), dFdy(gh)), faceDirection); }`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
roughnessFactor *= (0.82 + 0.36 * gVN(vSPos * 5.0)) * mix(1.0, 0.55, smoothstep(0.22, 0.5, dot(vColor.rgb, vec3(0.3333))));`);
  };
  m.customProgramCacheKey = () => key;
}
function statueMats() {
  if (!mats) {
    mats = {
      bronze: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.82, roughness: 0.4, envMapIntensity: 1.35, name: "town:statue-bronze" }),
      gold: new THREE.MeshStandardMaterial({ vertexColors: true, color: "#ffd045", metalness: 0.55, roughness: 0.28, emissive: "#5a3a00", emissiveIntensity: 0.3, envMapIntensity: 1.2, name: "town:statue-gold" }),
    };
    addGrain(mats.bronze, 0.0016, "statue-bronze-grain");
    // the baked patina drives the METAL too — verdigris (green-dominant vertex colour) is matte + non-metal, the
    // rubbed raised forms stay bright polished bronze, so the figure reads with edge highlights instead of one dark sheen
    {
      const prev = mats.bronze.onBeforeCompile, prevKey = mats.bronze.customProgramCacheKey?.bind(mats.bronze);
      mats.bronze.onBeforeCompile = (sh, r) => {
        prev.call(mats!.bronze, sh, r);
        sh.fragmentShader = sh.fragmentShader
          .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n#ifdef USE_COLOR\n float townVerd = clamp((vColor.g - vColor.r) * 7.0 + 0.1, 0.0, 1.0);\n float townHi = clamp((vColor.r - 0.32) * 4.0, 0.0, 1.0);\n roughnessFactor = mix(mix(roughnessFactor, 0.26, townHi), 0.78, townVerd);\n#endif")
          .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n#ifdef USE_COLOR\n metalnessFactor *= 1.0 - 0.75 * townVerd;\n#endif");
      };
      mats.bronze.customProgramCacheKey = () => (prevKey ? prevKey() : "") + "-verd-r4";
    }
    mats.bronze.color.setRGB(1.3, 1.24, 1.12);
  }
  return mats;
}

/** procedural bronze gorilla statue holding a golden banana bunch aloft. Origin = centre of the feet on the
 *  statue's own base plate (the plate's underside, so it sits flush on a pedestal); faces +z; `height` = top of the
 *  raised bunch in metres. */
export async function buildGorillaStatue(ctx: WorldCtx, height = 3.4, pace: Pace = ctxPace(ctx)): Promise<THREE.Group> {
  // baked geometry (public/assets/pois/town/statue.bin, ~0.5 MB) saves the ~1 s sculpt
  // on load; the live sculpt is the fallback (and what the bake runs)
  cache ??= loadBakedStatue().then((g) => g ?? buildStatueGeo());
  const g = await pace.wait(cache);
  const m = statueMats();
  const group = new THREE.Group();
  group.name = "gorilla-statue";
  const body = new THREE.Mesh(g.bronze, m.bronze), bunch = new THREE.Mesh(g.gold, m.gold);
  body.name = "gorilla-statue:bronze"; bunch.name = "gorilla-statue:gold";
  for (const o of [body, bunch]) { o.castShadow = true; o.receiveShadow = true; group.add(o); }
  // perf: the body's ~26 k tris never cast — a ~2.5 k-tri decimated twin casts instead (invisible in the main pass)
  await pace.pause();
  await pace.wait(SIMP.ready);
  const caster = await statueCaster(g);
  await pace.pause();
  if (caster) {
    body.castShadow = false; body.userData.castShadow = false;
    const cm = new THREE.Mesh(caster, shadowOnlyMaterial());
    cm.name = "gorilla-statue:caster"; cm.castShadow = true; cm.userData.castShadow = true; cm.userData.farShadow = true; cm.frustumCulled = false;
    group.add(cm);
  }
  group.scale.setScalar(height / g.top);
  group.userData.tris = g.tris + g.gold.index!.count / 3;
  return group;
}

let casterCache: Promise<THREE.BufferGeometry | null> | null = null;
function statueCaster(g: StatueGeo): Promise<THREE.BufferGeometry | null> {
  return (casterCache ??= (async () => {
    await SIMP.ready;
    if (!SIMP.supported) return null;
    const pos = g.bronze.attributes.position.array as Float32Array;
    const idx = new Uint32Array(g.bronze.index!.array as ArrayLike<number>);
    const [out] = SIMP.simplify(idx, pos, 3, 2500 * 3, 0.05, []);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(out, 1));
    return geo;
  })());
}

// ---------------------------------------------------------------------------------------------------------------
// bake format: u32 [magic, version, nVb, nIb, nVg, nIg] f32 [top] · per mesh: f32 pos (3n) · i8 normal (4n) · u8 colour (4n) · u16 idx
const MAGIC = 0x5354_4131, VERSION = 3;
export async function bakeStatue(): Promise<ArrayBuffer> {
  const g = await buildStatueGeo();
  const parts = [g.bronze, g.gold];
  const counts = parts.flatMap((m) => [m.attributes.position.count, m.index!.count]);
  let size = 6 * 4 + 4;
  for (const m of parts) { if (m.attributes.position.count > 65535) throw new Error("statue bake: > 65535 verts"); size += m.attributes.position.count * (12 + 4 + 4) + m.index!.count * 2; }
  const buf = new ArrayBuffer(size), dv = new DataView(buf);
  [MAGIC, VERSION, ...counts].forEach((v, i) => dv.setUint32(i * 4, v, true));
  dv.setFloat32(24, g.top, true);
  let o = 28;
  for (const m of parts) {
    const n = m.attributes.position.count, P = m.attributes.position, N = m.attributes.normal, C = m.getAttribute("color");
    for (let i = 0; i < n; i++) { dv.setFloat32(o, P.getX(i), true); dv.setFloat32(o + 4, P.getY(i), true); dv.setFloat32(o + 8, P.getZ(i), true); o += 12; }
    for (let i = 0; i < n; i++) { dv.setInt8(o, Math.round(N.getX(i) * 127)); dv.setInt8(o + 1, Math.round(N.getY(i) * 127)); dv.setInt8(o + 2, Math.round(N.getZ(i) * 127)); o += 4; }
    for (let i = 0; i < n; i++) { const c = C ? [C.getX(i), C.getY(i), C.getZ(i)] : [1, 1, 1]; for (let k = 0; k < 3; k++) dv.setUint8(o + k, Math.max(0, Math.min(255, Math.round(c[k] * 255)))); o += 4; }
    const I = m.index!;
    for (let i = 0; i < I.count; i++) { dv.setUint16(o, I.getX(i), true); o += 2; }
  }
  return buf;
}
async function loadBakedStatue(): Promise<StatueGeo | null> {
  if (typeof fetch === "undefined" || flag("sculpt")) return null;
  try {
    const r = await fetch(`${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}assets/pois/town/statue.bin`);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer(), dv = new DataView(buf);
    if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== VERSION) return null;
    const cnt = [2, 3, 4, 5].map((i) => dv.getUint32(i * 4, true)), top = dv.getFloat32(24, true);
    let o = 28;
    const read = (n: number, ni: number): THREE.BufferGeometry => {
      const pos = new Float32Array(buf.slice(o, o + n * 12)); o += n * 12;
      const nor = new Int8Array(buf, o, n * 4); o += n * 4;
      const col = new Uint8Array(buf, o, n * 4); o += n * 4;
      const idx = new Uint16Array(buf.slice(o, o + ni * 2)); o += ni * 2;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("normal", new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(nor, 4), 3, 0, true));
      g.setAttribute("color", new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(col, 4), 3, 0, true));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingBox(); g.computeBoundingSphere();
      return g;
    };
    const bronze = read(cnt[0], cnt[1]), gold = read(cnt[2], cnt[3]);
    return { bronze, gold, top, tris: cnt[1] / 3, ms: 0 };
  } catch { return null; }
}


// ---------------------------------------------------------------------------------------------------------------
// asset lab (slot "statue"): hero on a simple stone plinth + side / back turn-arounds on the floor
export async function lab(env: LabEnv) {
  const { bins } = env;
  const stone = col("#a79d8b");
  // hero plinth (the fountain owns the real pedestal — this is only a stand for the lab)
  bins.stone.add(chamferBoxGeo(2.2, 0.5, 2.2, 0.05), env.at(0, 0.25, 0), stone);
  bins.stone.add(chamferBoxGeo(1.9, 0.18, 1.9, 0.04), env.at(0, 0.59, 0), stone.clone().multiplyScalar(1.05));
  // faces north (−z) so the midday sun (NNW) lights its front-left; lab cams sit north of it
  const hero = await buildGorillaStatue(env.ctx, 3.4);
  hero.applyMatrix4(env.at(0, 0.68, 0, Math.PI));
  env.extra.push(hero);
  // turn-arounds: side (faces +x) and back (faces −z) at kong scale neighbours
  const side = await buildGorillaStatue(env.ctx, 3.4);
  side.applyMatrix4(env.at(-6.5, 0, -1.5, -Math.PI / 2));
  env.extra.push(side);
  const back = await buildGorillaStatue(env.ctx, 3.4);
  back.applyMatrix4(env.at(6.5, 0, -1.5, 0));
  env.extra.push(back);
  // a 2 m kong-height reference post (scale check)
  bins.metal.add(cylGeo(0.05, 0.05, 2.0, 8), env.at(-3, 1.0, 3), col("#c9483b"));
  void M; void latheGeo;
}
