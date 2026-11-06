// BANANA CO. jump plane (drop-01-plane-exterior). Owned by the actors area.
// Contract (keep the exports — showcase.ts, the lobby islet and gameplay use them):
//   createPlane(ctx)  → PlaneProps  (a ~28 m long twin-prop cargo plane, nose toward -Z, origin at the belly centre,
//                                    y = 0 at the bottom of the wheels when the gear is down)
//   views             → view cameras this piece owns (main: "drop-01-plane-exterior"; dev: "wip-plane-*")
//   stage(ctx, id)    → places the plane for a stage hint ("plane" = in flight for drop-01; "wip-plane" = dev)
//
// Everything is procedural: lofted parametric surfaces (fuselage, sponsons, wings, fin, nacelles, cowls, blades, tyres)
// with analytic-ish normals, canvas-painted colour maps + height-derived normal maps + roughness maps (paint, panel
// lines, rivets, cheat line, cockpit glazing, "BANANA CO." livery, banana-leaf fin art, grime/soot/wear).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { WorldCtx } from "../engine/engine";
import type { CamSpec } from "../engine/views";
import { shareGeometries } from "../engine/geo-share";
import { flag } from "../flags";
import { actorLook } from "./look";
import { createKong, type KongActorEx } from "./kong";
import { KongAnimator } from "./kong-rig";
import type { KongPose } from "./api";
import { resources } from "../engine/res/scope";
import { freeImage } from "../engine/texture-release";
import { TAU, ZN, Z_NOSE, Z_UP, Z_RAMP, Z_OPEN, ZE, ZCAP, BELLY, TOP, HW, NOSE_Y, SE, TAIL_TOP, TAIL_BOT, TAIL_W, FLOOR_Y, SKIN, TH0, TH1, WING_Y, WING_LE, WING_C0, WING_C1, WING_HALF, WING_CENTRE, ENG_X, ENG_Y, ENG_Z, COWL_R, PROP_R, PROP_Z, GEAR_TRAVEL, WHEEL_R, NOSE_WHEEL_R, NOSE_GEAR_Z, NOSE_TRAVEL, STAB_Y, STAB_LE, STAB_HALF, FIN_Y0, FIN_Y1, FIN_ZMIN, FIN_ZMAX, YEL, clamp01, lerp, ell, sp, E2, aOfY, WIN_Y, PORTHOLES, FIN_TOP0, finLE, finTE } from "./plane-dims";
import { PLANE_PAINT, PAINT_NAMES, isLayers, type Canvas, type Layers, type PaintName, type PlanePainted } from "./plane-paint";

export interface PlaneProps {
  object: THREE.Group;
  /** spin props, ramp animation, gear */
  update(dt: number, t: number): void;
  /** 0 = ramp closed, 1 = fully lowered */
  setRamp(open: number): void;
  /** 0 = gear up (in flight), 1 = gear down (parked) */
  setGear(down: number): void;
  /** true = props spinning (blurred discs), false = stopped blades */
  setEngines(running: boolean): void;
  /** local-space point where a jumper leaves the rear ramp */
  rampExit: THREE.Vector3;
}

const RAMP_PIVOT = new THREE.Vector3(0, BELLY + 0.16, Z_UP);

// ============================================================================ fuselage shape
interface Sec { w: number; cy: number; h: number }
const S0: Sec = { w: 0, cy: 0, h: 0 };
function sec(z: number, o: Sec = S0): Sec {
  if (z < Z_NOSE) {
    const t = clamp01((Z_NOSE - z) / (Z_NOSE - ZN));
    const top = NOSE_Y + (TOP - NOSE_Y) * ell(t, 1.75);
    const bot = NOSE_Y - (NOSE_Y - BELLY) * ell(t, 2.5);
    o.w = HW * ell(t, 2.1); o.cy = (top + bot) / 2; o.h = (top - bot) / 2;
  } else if (z <= Z_UP) {
    o.w = HW; o.cy = (TOP + BELLY) / 2; o.h = (TOP - BELLY) / 2;
  } else if (z <= ZE) {
    const t = (z - Z_UP) / (ZE - Z_UP);
    const top = TOP - (TOP - TAIL_TOP) * t * t;
    const bot = BELLY + (TAIL_BOT - BELLY) * Math.pow(t, 1.12);
    o.w = HW - (HW - TAIL_W) * Math.pow(t, 1.3); o.cy = (top + bot) / 2; o.h = (top - bot) / 2;
  } else {
    sec(ZE, o);
    const k = ell((z - ZE) / (ZCAP - ZE), 2);
    o.w *= k; o.h *= k; o.cy += 0.06 * (1 - k);
  }
  return o;
}
const secBot = (z: number) => { const s = sec(z, { w: 0, cy: 0, h: 0 }); return s.cy - s.h; };
/** a = angle from the belly: 0 bottom, π/2 starboard (+X), π top, 3π/2 port */
function fuse(z: number, a: number, o: THREE.Vector3, inset = 0) {
  const s = sec(z);
  const w = Math.max(0.01, s.w - inset), h = Math.max(0.01, s.h - inset);
  return o.set(w * sp(Math.sin(a), E2), s.cy - h * sp(Math.cos(a), E2), z);
}
const theta = (z: number) => TH0 + (TH1 - TH0) * Math.pow(clamp01((z - Z_UP) / (Z_OPEN - Z_UP)), 0.9);

// ============================================================================ geometry kit
type Fn = (u: number, v: number, o: THREE.Vector3) => void;
interface SurfOpts { flip?: boolean; uv?: (u: number, v: number, p: THREE.Vector3) => [number, number]; ud?: [number, number]; vd?: [number, number]; color?: (u: number, v: number) => THREE.Color }
/** parametric surface on the grid us × vs with normals from the surface derivatives (seam-free across split patches) */
function surface(us: number[], vs: number[], f: Fn, o: SurfOpts = {}): THREE.BufferGeometry {
  const nu = us.length, nv = vs.length, n = nu * nv;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2);
  const C = o.color ? new Float32Array(n * 3) : null;
  const ud = o.ud ?? [us[0], us[nu - 1]], vd = o.vd ?? [vs[0], vs[nv - 1]];
  const ulo = Math.min(ud[0], ud[1]), uhi = Math.max(ud[0], ud[1]), vlo = Math.min(vd[0], vd[1]), vhi = Math.max(vd[0], vd[1]);
  const eu = (uhi - ulo) * 5e-4, ev = (vhi - vlo) * 5e-4;
  const cu = (x: number) => Math.min(uhi, Math.max(ulo, x)), cv = (x: number) => Math.min(vhi, Math.max(vlo, x));
  const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), du = new THREE.Vector3(), dv = new THREE.Vector3();
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const u = us[i], v = vs[j], k = i * nv + j;
    f(u, v, p);
    P[k * 3] = p.x; P[k * 3 + 1] = p.y; P[k * 3 + 2] = p.z;
    let uu = u;
    for (let tries = 0; tries < 8; tries++) {
      f(cu(uu + eu), v, a); f(cu(uu - eu), v, b); du.subVectors(a, b);
      f(uu, cv(v + ev), a); f(uu, cv(v - ev), b); dv.subVectors(a, b);
      du.cross(dv);
      if (du.lengthSq() > 1e-18) break;
      uu = cu(uu + (uu > (ulo + uhi) / 2 ? -1 : 1) * eu * 6 * (tries + 1)); // step off a pole
    }
    du.normalize(); if (o.flip) du.negate();
    N[k * 3] = du.x; N[k * 3 + 1] = du.y; N[k * 3 + 2] = du.z;
    const t = o.uv ? o.uv(u, v, p) : [(u - us[0]) / (us[nu - 1] - us[0] || 1), (v - vs[0]) / (vs[nv - 1] - vs[0] || 1)];
    UV[k * 2] = t[0]; UV[k * 2 + 1] = t[1];
    if (C && o.color) { const c = o.color(u, v); C[k * 3] = c.r; C[k * 3 + 1] = c.g; C[k * 3 + 2] = c.b; }
  }
  const idx: number[] = [];
  for (let i = 0; i < nu - 1; i++) for (let j = 0; j < nv - 1; j++) {
    const a0 = i * nv + j, b0 = (i + 1) * nv + j, c0 = a0 + 1, d0 = b0 + 1;
    if (o.flip) idx.push(a0, c0, b0, b0, c0, d0); else idx.push(a0, b0, c0, b0, d0, c0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(UV, 2));
  if (C) g.setAttribute("color", new THREE.BufferAttribute(C, 3));
  g.setIndex(idx);
  return g;
}
const range = (a: number, b: number, n: number, pow = 1) => Array.from({ length: n + 1 }, (_, i) => a + (b - a) * Math.pow(i / n, pow));
const cosRange = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + (b - a) * (1 - Math.cos((Math.PI * i) / n)) / 2);
function uniq(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s.filter((x, i) => i === 0 || x - s[i - 1] > 1e-6); }
/** keep position/normal/uv (+color if keepColor), indexed — so mergeGeometries accepts mixed sources */
function prep(g: THREE.BufferGeometry, keepColor = false): THREE.BufferGeometry {
  let q = g.index ? g : (() => { const n = g.attributes.position.count; g.setIndex(Array.from({ length: n }, (_, i) => i)); return g; })();
  for (const k of Object.keys(q.attributes)) if (!["position", "normal", "uv", ...(keepColor ? ["color"] : [])].includes(k)) q.deleteAttribute(k);
  if (!q.attributes.uv) q.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(q.attributes.position.count * 2), 2));
  if (!q.attributes.normal) q.computeVertexNormals();
  q = q.index!.array instanceof Uint32Array ? q : q;
  return q;
}
function merge(gs: THREE.BufferGeometry[], keepColor = false) {
  const m = mergeGeometries(gs.map((g) => prep(g, keepColor)), false);
  if (!m) throw new Error("plane: mergeGeometries failed");
  return m;
}
const Q = new THREE.Quaternion(), V1 = new THREE.Vector3(), V2 = new THREE.Vector3();
/** transform a geometry: place at pos, orient +Y (or given axis) along dir */
function place(g: THREE.BufferGeometry, pos: THREE.Vector3, dir?: THREE.Vector3, from = new THREE.Vector3(0, 1, 0), spin = 0) {
  if (spin) g.rotateY(spin);
  if (dir) { Q.setFromUnitVectors(from, V1.copy(dir).normalize()); g.applyQuaternion(Q); }
  g.translate(pos.x, pos.y, pos.z);
  return g;
}
function rbox(w: number, h: number, d: number, r: number, seg = 2) { return new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)); }
/** cylinder between two points */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 10, r2 = r) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r2, r, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  return place(g, a, V2.subVectors(b, a));
}


// ============================================================================ parts
function airfoil(xc: number, t: number, m: number, p = 0.4) {
  const yt = 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
  const yc = xc < p ? (m / (p * p)) * (2 * p * xc - xc * xc) : (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * xc - xc * xc);
  return [yc, yt];
}
/** v ∈ [0,1] around an airfoil: 0 TE lower → 0.5 LE → 1 TE upper */
const aroundV = (n: number) => uniq([...cosRange(0, 0.5, n), ...cosRange(0.5, 1, n)]);
const chordOf = (v: number) => Math.abs(1 - 2 * v);

interface LiftShape { half: number; chord(x: number): number; le(x: number): number; y(x: number): number; t(x: number): number; camber: number; inc: number; round: number }
function liftSurface(L: LiftShape, nSpan: number, nAround: number, xFrom = -L.half, xTo = L.half) {
  const f: Fn = (s, v, o) => {
    const x = s, ax = Math.abs(x);
    let c = L.chord(ax), le = L.le(ax), th = L.t(ax);
    const q = (ax - (L.half - L.round)) / L.round;
    if (q > 0) { const k = ell(q, 2.2); le += c * 0.42 * (1 - k); c *= Math.max(1e-3, k); th *= Math.max(0.05, Math.pow(k, 0.5)); }
    const xc = chordOf(v), [yc, yt] = airfoil(xc, th, L.camber), up = v >= 0.5 ? 1 : -1;
    const yy = (yc + up * yt) * c;
    o.set(x, L.y(ax) + yy - xc * c * Math.sin(L.inc), le + xc * c * Math.cos(L.inc));
  };
  const spans: number[] = [];
  const edge = L.half - L.round;
  for (const x of range(xFrom, xTo, nSpan)) spans.push(x);
  for (const sgn of [-1, 1]) for (let i = 0; i <= 10; i++) { const x = sgn * (edge + L.round * (1 - Math.cos((Math.PI / 2) * (i / 10)))); if (x >= xFrom && x <= xTo) spans.push(x); }
  return { f, spans: uniq(spans), vs: aroundV(nAround) };
}

function buildFuselage(mat: THREE.Material, interiorMat: THREE.Material) {
  const nose = range(ZN, Z_NOSE, 30, 1.7).map((z, i, a) => (i === 0 ? z : z)).map((z) => z);
  // denser near the tip: remap so spacing grows away from the nose
  const noseZ = Array.from({ length: 31 }, (_, i) => ZN + (Z_NOSE - ZN) * (1 - Math.cos((Math.PI / 2) * (i / 30))));
  void nose;
  const cabinZ = range(Z_NOSE, Z_UP, 16);
  const tailA = range(Z_UP, Z_OPEN, 22);
  const tailB = uniq([...range(Z_OPEN, ZE, 8), ...Array.from({ length: 9 }, (_, i) => ZE + (ZCAP - ZE) * Math.sin((Math.PI / 2) * (i / 8)))]);
  const ring = range(0, TAU, 96);
  const uvF = (_u: number, _v: number, p: THREE.Vector3): [number, number] => [0, 0 * p.x];
  void uvF;
  const shellUV = (z: number, a: number): [number, number] => [(z - ZN) / (ZCAP - ZN), a / TAU];
  const full = (zs: number[]) => surface(zs, ring, (z, a, o) => fuse(z, a, o), { flip: true, uv: (z, a) => shellUV(z, a), vd: [0, TAU] });
  // opening region: a ∈ [θ(z), 2π - θ(z)] mapped from v ∈ [0,1]
  const vv = range(0, 1, 80);
  const aOf = (z: number, v: number) => theta(z) + v * (TAU - 2 * theta(z));
  const open = surface(tailA, vv, (z, v, o) => fuse(z, aOf(z, v), o), { flip: true, uv: (z, v) => shellUV(z, aOf(z, v)) });
  const geoms = [full([...noseZ, ...cabinZ.slice(1)]), open, full(tailB)];
  // cut-edge rims (skin thickness) along both sides of the opening
  for (const side of [0, 1]) {
    const rimF: Fn = (z, s, o) => { const a = side ? TAU - theta(z) : theta(z); fuse(z, a, o, s * SKIN); };
    geoms.push(surface(tailA, [0, 1], rimF, { flip: side === 1, uv: (z) => shellUV(z, side ? TAU - theta(z) : theta(z)) }));
  }
  // wing-root fairing on the fuselage top (uses the fuselage paint via top-of-canvas UVs)
  const fair = surface(range(-5.6, 1.9, 30), range(0, Math.PI, 24), (z, a, o) => {
    const t = (z - -5.6) / 7.5;
    const k = t < 0.2 ? ell((0.2 - t) / 0.2, 2) : t > 0.55 ? ell((t - 0.55) / 0.45, 1.6) : 1;
    const w = 1.35 * Math.max(0.02, Math.pow(k, 0.6)), h = 0.62 * k;
    o.set(-w * Math.cos(a), TOP - 0.35 + h * Math.pow(Math.sin(a), 0.8), z);
  }, { uv: (z, a) => [(z - ZN) / (ZCAP - ZN), 0.5 + (Math.cos(a) * 1.35) / 13.4] });
  geoms.push(fair);
  const shell = new THREE.Mesh(merge(geoms), mat);
  shell.name = "fuselage"; shell.castShadow = true; shell.receiveShadow = true;

  // ---- interior lining + bulkheads
  const inner: THREE.BufferGeometry[] = [];
  const iUV = (z: number, a: number): [number, number] => [(z - ZN) / (ZCAP - ZN), a / TAU];
  const cab = range(-9.0, Z_UP, 14);
  inner.push(surface(cab, range(0.5, TAU - 0.5, 60), (z, a, o) => fuse(z, a, o, SKIN), { uv: (z, a) => iUV(z, a) }));
  inner.push(surface(tailA, vv, (z, v, o) => fuse(z, aOf(z, v), o, SKIN), { uv: (z, v) => iUV(z, aOf(z, v)) }));
  inner.push(surface(range(Z_OPEN, 12.9, 4), range(0, TAU, 48), (z, a, o) => fuse(z, a, o, SKIN), { uv: (z, a) => iUV(z, a) }));
  // bulkheads (front at -9, aft at 12.9)
  for (const [z, dir] of [[-9.0, 1], [12.9, -1]] as const) {
    const s = sec(z, { w: 0, cy: 0, h: 0 });
    inner.push(surface([0, 1], range(0, TAU, 48), (r, a, o) => { fuse(z, a, o, SKIN); o.set(o.x * r, s.cy + (o.y - s.cy) * r, z); }, { flip: dir < 0, uv: (r, a) => [0.5 + 0.2 * r * Math.sin(a), 0.5 - 0.3 * r * Math.cos(a)] }));
  }
  const lining = new THREE.Mesh(merge(inner), interiorMat);
  lining.name = "cargo-lining"; lining.receiveShadow = true;
  return { shell, lining };
}

// ramp + upper door: bottom sector of the upswept tail, built in fuselage space then re-based on the hinge
function buildRamp(paintM: THREE.Material, interiorM: THREE.Material, treadM: THREE.Material, metalM: THREE.Material) {
  const group = new THREE.Group(); group.name = "ramp"; group.position.copy(RAMP_PIVOT);
  const zs = range(Z_UP, Z_RAMP, 14), vv = range(-1, 1, 36);
  const aOf = (z: number, v: number) => v * theta(z);
  const shellUV = (z: number, a: number): [number, number] => [(z - ZN) / (ZCAP - ZN), a / TAU];
  const skin: THREE.BufferGeometry[] = [surface(zs, vv, (z, v, o) => fuse(z, aOf(z, v), o), { flip: true, uv: (z, v) => shellUV(z, aOf(z, v)) })];
  for (const s of [-1, 1]) skin.push(surface(zs, [0, 1], (z, t, o) => fuse(z, s * theta(z), o, t * SKIN), { flip: s < 0, uv: (z) => shellUV(z, s * theta(z)) }));
  for (const [z, fl] of [[Z_UP, true], [Z_RAMP, false]] as const) skin.push(surface(vv, [0, 1], (v, t, o) => fuse(z, aOf(z, v), o, t * SKIN), { flip: fl, uv: (v) => shellUV(z, aOf(z, v)) }));
  const skinG = merge(skin); skinG.translate(-RAMP_PIVOT.x, -RAMP_PIVOT.y, -RAMP_PIVOT.z);
  const skinM = new THREE.Mesh(skinG, paintM); skinM.castShadow = true; skinM.receiveShadow = true;
  const inner = surface(zs, vv, (z, v, o) => fuse(z, aOf(z, v), o, SKIN), { uv: (z, v) => [(z - ZN) / (ZCAP - ZN), aOf(z, v) / TAU] });
  inner.translate(-RAMP_PIVOT.x, -RAMP_PIVOT.y, -RAMP_PIVOT.z);
  const innerM = new THREE.Mesh(inner, interiorM); innerM.receiveShadow = true;
  // deck: flat treadplate plank running from the floor line at the hinge to the ramp end
  const slope = Math.atan2(secBot(Z_RAMP) - BELLY, Z_RAMP - Z_UP);
  const len = (Z_RAMP - Z_UP - 0.08) / Math.cos(slope);
  const halfAt = (z: number, y: number) => { // inset section half width at height y
    const s = sec(z, { w: 0, cy: 0, h: 0 }), h = s.h - SKIN, w = s.w - SKIN;
    const cr = THREE.MathUtils.clamp((s.cy - y) / h, -1, 1), ca = sp(cr, SE / 2);
    return w * sp(Math.sqrt(Math.max(0, 1 - ca * ca)), E2) - 0.04;
  };
  const deckY0 = FLOOR_Y - RAMP_PIVOT.y;
  const w0 = halfAt(Z_UP + 0.05, FLOOR_Y), w1 = halfAt(Z_RAMP - 0.1, FLOOR_Y + Math.tan(slope) * (Z_RAMP - Z_UP));
  const deckShape = new THREE.Shape();
  deckShape.moveTo(-w0, 0); deckShape.lineTo(w0, 0); deckShape.lineTo(w1, len); deckShape.lineTo(-w1, len); deckShape.closePath();
  const deck = new THREE.ExtrudeGeometry(deckShape, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 1 });
  // shape is in XY; lay it flat (XZ), top at y = 0, then tilt by the ramp slope
  deck.rotateX(Math.PI / 2); deck.translate(0, -0.0, 0);
  const uvA = deck.attributes.uv as THREE.BufferAttribute, pA = deck.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < uvA.count; i++) uvA.setXY(i, pA.getX(i) * 1.2, pA.getZ(i) * 1.2);
  deck.rotateX(-slope); deck.translate(0, deckY0, 0);
  const deckParts: THREE.BufferGeometry[] = [deck];
  // side kick-rails + treads (raised bars across the deck) + toes at the end
  const dirV = new THREE.Vector3(0, Math.sin(slope), Math.cos(slope));
  for (let i = 1; i < 9; i++) {
    const d = (i / 9) * len, w = lerp(w0, w1, d / len) - 0.1;
    const b = rbox(w * 2, 0.035, 0.07, 0.015); b.rotateX(-slope);
    b.translate(0, deckY0 + dirV.y * d + 0.03, dirV.z * d); deckParts.push(b);
  }
  for (const s of [-1, 1]) {
    const a = new THREE.Vector3(s * (w0 - 0.06), deckY0 + 0.1, 0.05), b = new THREE.Vector3(s * (w1 - 0.06), deckY0 + 0.1 + dirV.y * len, dirV.z * len);
    deckParts.push(rod(a, b, 0.05, 8));
  }
  const toes: THREE.BufferGeometry[] = [];
  const toeW = (w1 * 2 - 0.1) / 3;
  for (let k = 0; k < 3; k++) {
    const t = rbox(toeW - 0.04, 0.05, 0.62, 0.02); t.translate(0, 0, 0.31); t.rotateX(-slope + 0.22);
    t.translate(-w1 + 0.05 + toeW * (k + 0.5), deckY0 + dirV.y * len + 0.01, dirV.z * len);
    toes.push(t);
  }
  const deckM = new THREE.Mesh(merge([...deckParts, ...toes]), treadM); deckM.castShadow = true; deckM.receiveShadow = true;
  // hinge knuckles
  const hinge: THREE.BufferGeometry[] = [];
  for (let k = -3; k <= 3; k++) { const c = new THREE.CylinderGeometry(0.07, 0.07, 0.28, 12); c.rotateZ(Math.PI / 2); c.translate(k * 0.42, 0.02, 0); hinge.push(c); }
  const hingeM = new THREE.Mesh(merge(hinge), metalM); hingeM.castShadow = true;
  group.add(skinM, innerM, deckM, hingeM);
  const exitLocal = new THREE.Vector3(0, deckY0 + dirV.y * (len + 0.5), dirV.z * (len + 0.5));
  return { group, slope, len, exitLocal };
}
function buildUpperDoor(paintM: THREE.Material, interiorM: THREE.Material) {
  const pivot = new THREE.Vector3(0, secBot(Z_OPEN), Z_OPEN);
  const group = new THREE.Group(); group.name = "upper-door"; group.position.copy(pivot);
  const zs = range(Z_RAMP, Z_OPEN, 8), vv = range(-1, 1, 30);
  const aOf = (z: number, v: number) => v * theta(z);
  const uvf = (z: number, a: number): [number, number] => [(z - ZN) / (ZCAP - ZN), a / TAU];
  const parts = [surface(zs, vv, (z, v, o) => fuse(z, aOf(z, v), o), { flip: true, uv: (z, v) => uvf(z, aOf(z, v)) })];
  for (const s of [-1, 1]) parts.push(surface(zs, [0, 1], (z, t, o) => fuse(z, s * theta(z), o, t * SKIN), { flip: s < 0, uv: (z) => uvf(z, s * theta(z)) }));
  parts.push(surface(vv, [0, 1], (v, t, o) => fuse(Z_RAMP, aOf(Z_RAMP, v), o, t * SKIN), { flip: true, uv: (v) => uvf(Z_RAMP, aOf(Z_RAMP, v)) }));
  const g = merge(parts); g.translate(-pivot.x, -pivot.y, -pivot.z);
  const inner = surface(zs, vv, (z, v, o) => fuse(z, aOf(z, v), o, SKIN), { uv: (z, v) => uvf(z, aOf(z, v)) }); inner.translate(-pivot.x, -pivot.y, -pivot.z);
  const m = new THREE.Mesh(g, paintM); m.castShadow = true;
  group.add(m, new THREE.Mesh(inner, interiorM));
  return group;
}

// ============================================================================ cargo bay (drop-02-plane-interior)
// Yellow ribbed walls (painted panel tile in
// metres + U-channel frames every 0.8 m, split round the portholes), 8 lit portholes a side, an overhead spine beam +
// pipes + lamps, a grey aft portal frame with hazard stripes and the red JUMP lamp over the ramp, red padded seats with
// grey tube frames, headrest loops + harness reels, yellow floor rails with tie-down slots, strapped crates by the ramp,
// and a crew of seated, harnessed kongs along both walls (instanced kongs; createPlane adds them).
export interface BaySeat { side: 1 | -1; z: number; backX: number; seatY: number }
interface BayMats { tread: THREE.Material; metal: THREE.Material; crate: THREE.Material; seat: THREE.Material; lamp: THREE.Material; rib: THREE.Material; frame: THREE.Material; strap: THREE.Material; jump: THREE.Material; glass: THREE.Material; hazard: THREE.Material; railY: THREE.Material; dark: THREE.Material }
const BAY_SEATS_Z = [-7.6, -6.35, -5.1, -3.85, -2.6, -1.35, -0.1, 1.15, 2.4, 3.65];
function bayHalfW() {
  const s = sec(0, { w: 0, cy: 0, h: 0 }), h = s.h - SKIN, w = s.w - SKIN;
  const ca = sp((s.cy - FLOOR_Y) / h, SE / 2);
  return { halfW: w * sp(Math.sqrt(1 - ca * ca), E2) - 0.02, aFloor: Math.acos(ca) };
}
/** inner wall x (one side) at height y above the cabin floor */
function wallX(y: number) {
  const s = sec(0, { w: 0, cy: 0, h: 0 }), h = s.h - SKIN, w = s.w - SKIN;
  const cr = THREE.MathUtils.clamp((s.cy - y) / h, -1, 1), ca = sp(cr, SE / 2);
  return w * sp(Math.sqrt(Math.max(0, 1 - ca * ca)), E2);
}
function buildCargoBay(M: BayMats) {
  const g = new THREE.Group(); g.name = "cargo-bay";
  const { halfW, aFloor } = bayHalfW();
  const Z0 = -9.0;
  // ---- floor slab + yellow aisle rails with tie-down slots + wall tie-down rails / rings
  const floor = rbox(halfW * 2, 0.12, Z_UP - Z0, 0.03); floor.translate(0, FLOOR_Y - 0.06, (Z_UP + Z0) / 2);
  const fu = floor.attributes.uv as THREE.BufferAttribute, fp = floor.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < fu.count; i++) fu.setXY(i, fp.getX(i) * 1.2, fp.getZ(i) * 1.2);
  const floorM = new THREE.Mesh(floor, M.tread); floorM.receiveShadow = true;
  const metal: THREE.BufferGeometry[] = [], rails: THREE.BufferGeometry[] = [], dark: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const r = rbox(0.16, 0.035, Z_UP - Z0 - 0.3, 0.012); r.translate(sx * 0.46, FLOOR_Y + 0.012, (Z_UP + Z0) / 2); rails.push(r);
    for (let z = Z0 + 0.5; z < Z_UP - 0.3; z += 0.55) { const sl = rbox(0.07, 0.02, 0.2, 0.008); sl.translate(sx * 0.46, FLOOR_Y + 0.024, z); dark.push(sl); }
    const x = sx * (halfW - 0.2);
    const wr = rbox(0.1, 0.05, Z_UP - Z0 - 0.4, 0.015); wr.translate(x, FLOOR_Y + 0.02, (Z_UP + Z0) / 2); metal.push(wr);
    for (let z = Z0 + 0.6; z < Z_UP; z += 0.7) { const t = new THREE.TorusGeometry(0.05, 0.012, 5, 10); t.rotateY(Math.PI / 2); t.translate(x, FLOOR_Y + 0.07, z); metal.push(t); }
  }
  // ---- frames: yellow U-channels every 0.8 m (on the wall-panel seams), split round the portholes
  const ribs: THREE.BufferGeometry[] = [];
  const aWin = aOfY(WIN_Y);
  const ribArc = (z: number, a0: number, a1: number) => {
    if (a1 - a0 < 0.05) return;
    const as = range(a0, a1, Math.max(4, Math.round((a1 - a0) * 14)));
    // face (toward the cabin) + two side walls, each its own strip (crisp edges)
    const D = 0.075, Wd = 0.06;
    ribs.push(surface(as, [-Wd, Wd], (a, dz, o) => fuse(z + dz, a, o, SKIN + D), { uv: (a, dz) => [a * 2, dz * 4] }));
    ribs.push(surface(as, [0, D], (a, d, o) => fuse(z - Wd, a, o, SKIN + d), { flip: true, uv: (a, d) => [a * 2, d * 4] }));
    ribs.push(surface(as, [0, D], (a, d, o) => fuse(z + Wd, a, o, SKIN + d), { uv: (a, d) => [a * 2, d * 4] }));
  };
  const pAng = 0.19;
  for (let z = ZN + 0.8 * Math.ceil((Z0 + 0.4 - ZN) / 0.8); z < Z_UP; z += 0.8) {
    const hitP = PORTHOLES.some((zp) => Math.abs(zp - z) < 0.36);
    if (!hitP) { ribArc(z, aFloor, TAU - aFloor); continue; }
    ribArc(z, aFloor, aWin - pAng); ribArc(z, aWin + pAng, TAU - aWin - pAng); ribArc(z, TAU - aWin + pAng, TAU - aFloor);
  }
  for (let z = Z_UP + 0.4; z < Z_OPEN; z += 0.8) ribArc(z, theta(z) + 0.02, TAU - theta(z) - 0.02);
  // stringers (longitudinal) high on the walls
  for (const a of [2.35, TAU - 2.35]) ribs.push(surface(range(Z0 + 0.2, Z_UP, 24), [-0.03, 0.03], (z, d, o) => fuse(z, a + d, o, SKIN + 0.05), { uv: (z, d) => [z, d] }));
  // ---- portholes: grey frame ring + lit sky glass, 8 a side (same z as the livery's)
  const glass: THREE.BufferGeometry[] = [], frames: THREE.BufferGeometry[] = [];
  const pp = new THREE.Vector3(), nn = new THREE.Vector3(), q1 = new THREE.Vector3(), q2 = new THREE.Vector3();
  for (const s of [1, -1]) for (const z of PORTHOLES) {
    const a = s > 0 ? aWin : TAU - aWin;
    fuse(z, a, pp, SKIN);
    fuse(z + 0.01, a, q1, SKIN); fuse(z - 0.01, a, q2, SKIN); const dz = q1.clone().sub(q2);
    fuse(z, a + 0.01, q1, SKIN); fuse(z, a - 0.01, q2, SKIN); nn.copy(dz.cross(q1.sub(q2)).normalize()); if (nn.x * s > 0) nn.negate();   // into the cabin
    const ring = new THREE.TorusGeometry(0.23, 0.036, 8, 28); ring.scale(1, 1, 0.7); place(ring, pp.clone().addScaledVector(nn, 0.03), nn, new THREE.Vector3(0, 0, 1)); frames.push(ring);
    const gl = new THREE.CircleGeometry(0.215, 24); place(gl, pp.clone().addScaledVector(nn, 0.004), nn, new THREE.Vector3(0, 0, 1)); glass.push(gl);
  }
  // ---- overhead: spine beam + two pipes + clamps, lamps
  const beamY = TOP - SKIN - 0.16;
  const beam = rbox(0.56, 0.16, Z_UP - Z0 - 0.4, 0.03); beam.translate(0, beamY, (Z_UP + Z0) / 2); ribs.push(beam);
  for (const a of [Math.PI - 0.62, Math.PI + 0.62]) {
    const pts = range(Z0 + 0.3, Z_UP + 0.2, 10).map((z) => fuse(z, a, new THREE.Vector3(), SKIN + 0.13));
    metal.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.05, 8, false));
    for (let z = Z0 + 0.8; z < Z_UP; z += 1.6) { const c = new THREE.TorusGeometry(0.065, 0.014, 5, 12); const p0 = fuse(z, a, new THREE.Vector3(), SKIN + 0.13); c.translate(p0.x, p0.y, p0.z); metal.push(c); }
  }
  // static-line anchor cables + hanging grab straps + ceiling hatches
  for (const x of [-0.72, 0.72]) {
    const y = fuse(0, Math.PI - Math.sign(x) * 0.36, new THREE.Vector3(), SKIN + 0.3).y;
    metal.push(rod(new THREE.Vector3(x, y, Z0 + 0.4), new THREE.Vector3(x, y, Z_UP - 0.2), 0.012, 6));
    for (let z = Z0 + 1.0; z < Z_UP - 0.5; z += 1.2) { const st = rbox(0.035, 0.34, 0.012, 0.005); st.translate(x, y - 0.17, z); dark.push(st); const lp = new THREE.TorusGeometry(0.05, 0.012, 5, 10); lp.translate(x, y - 0.38, z); dark.push(lp); }
  }
  for (let z = Z0 + 1.6; z < Z_UP - 1; z += 3.2) for (const d of [-1, 1]) { const h = rbox(0.6, 0.03, 0.9, 0.02); h.rotateZ(-d * 0.42); const p0 = fuse(z, Math.PI + d * 0.42, new THREE.Vector3(), SKIN + 0.02); h.translate(p0.x, p0.y, z); dark.push(h); }
  const lamps: THREE.BufferGeometry[] = [];
  for (let z = -8; z < Z_UP; z += 2.4) {
    const l = rbox(0.24, 0.05, 0.7, 0.02); l.translate(0, beamY - 0.1, z); lamps.push(l);
    const h = rbox(0.34, 0.05, 0.8, 0.02); h.translate(0, beamY - 0.07, z); dark.push(h);
  }
  // ---- aft portal: grey frame ring round the cabin section at the ramp hinge + hazard band on its edge + JUMP lamp
  const zP = Z_UP + 0.1;
  const portal = surface(range(aFloor, TAU - aFloor, 48), [0, 1], (a, r, o) => { fuse(zP, a, o, SKIN - 0.01); const c = fuse(zP, a, new THREE.Vector3(), SKIN + 0.24); o.lerp(c, r); o.z = zP; }, { flip: true, uv: (a, r) => [a, r] });
  const portalBack = surface(range(aFloor, TAU - aFloor, 48), [0, 1], (a, r, o) => { const c = fuse(zP + 0.18, a, new THREE.Vector3(), SKIN + 0.24); fuse(zP, a, o, SKIN + 0.24); o.lerp(c, r); }, { uv: (a, r) => [a, r] });
  const hazard = surface(range(aFloor, TAU - aFloor, 64), [0, 1], (a, r, o) => { const c0 = fuse(zP - 0.004, a, new THREE.Vector3(), SKIN + 0.24 - 0.1 * (1 - r)); o.copy(c0); o.z = zP - 0.004; }, { flip: true, uv: (a, r) => [((a - aFloor) / (TAU - 2 * aFloor)) * 22, r] });
  const thr = rbox(halfW * 2 - 0.1, 0.05, 0.25, 0.015); thr.translate(0, FLOOR_Y + 0.01, Z_UP - 0.1);
  const lampTop = fuse(zP, Math.PI, new THREE.Vector3(), SKIN + 0.24);
  const LY = lampTop.y - 0.3;
  const housing = rbox(0.66, 0.5, 0.22, 0.06); housing.translate(0, LY, zP - 0.1); dark.push(housing);
  const jumpLamp = new THREE.CylinderGeometry(0.2, 0.2, 0.1, 8); jumpLamp.rotateX(Math.PI / 2); jumpLamp.rotateZ(Math.PI / 8); jumpLamp.translate(0, LY, zP - 0.22);
  const cage = new THREE.TorusGeometry(0.225, 0.022, 6, 8); cage.rotateZ(Math.PI / 8); cage.translate(0, LY, zP - 0.27); metal.push(cage);
  for (const d of [-1, 1]) { const bar = rbox(0.02, 0.4, 0.02, 0.008); bar.translate(d * 0.09, LY, zP - 0.28); metal.push(bar); }
  // ---- seats (both walls): red padded back + pan + headrest loop, grey tube frame, harness reel
  const seatG: THREE.BufferGeometry[] = [], tubes: THREE.BufferGeometry[] = [];
  const seats: BaySeat[] = [];
  const SEAT_Y = FLOOR_Y + 0.23, BACK_Y = FLOOR_Y + 0.72;
  for (const s of [-1, 1] as const) {
    const xb = wallX(BACK_Y) - 0.12, xs = wallX(SEAT_Y) - 0.02;
    for (const z of BAY_SEATS_Z) {
      const back = rbox(0.12, 0.72, 0.54, 0.05, 3); back.rotateZ(s * 0.1); back.translate(s * xb, BACK_Y, z); seatG.push(back);
      const pan = rbox(0.5, 0.1, 0.54, 0.04, 3); pan.translate(s * (xs - 0.3), SEAT_Y, z); seatG.push(pan);
      const head = new THREE.TorusGeometry(0.15, 0.036, 8, 16, Math.PI); head.rotateY(Math.PI / 2); head.translate(s * (wallX(BACK_Y + 0.5) - 0.1), BACK_Y + 0.42, z); seatG.push(head);
      const reel = rbox(0.1, 0.16, 0.22, 0.02); reel.translate(s * (wallX(BACK_Y + 0.4) - 0.1), BACK_Y + 0.4, z); dark.push(reel);
      // frame: two legs from the pan's front edge to the floor, two posts at the wall
      for (const dz of [-0.24, 0.24]) {
        tubes.push(rod(new THREE.Vector3(s * (xs - 0.52), SEAT_Y - 0.05, z + dz), new THREE.Vector3(s * (xs - 0.48), FLOOR_Y, z + dz), 0.022, 8));
        tubes.push(rod(new THREE.Vector3(s * (xs - 0.52), SEAT_Y - 0.04, z + dz), new THREE.Vector3(s * (wallX(SEAT_Y) - 0.06), SEAT_Y - 0.04, z + dz), 0.02, 8));
      }
      seats.push({ side: s, z, backX: s * (xb - 0.065), seatY: SEAT_Y + 0.05 });
      // dark grey backing panel behind each seat (the target art's seat rows sit on dark metal panels)
      const bp = rbox(0.04, 1.05, 0.66, 0.02); bp.rotateZ(s * 0.1); bp.translate(s * (wallX(BACK_Y) - 0.035), BACK_Y + 0.1, z); dark.push(bp);
    }
    // continuous rails: seat front + top rail + wall posts between the seats
    const z0 = BAY_SEATS_Z[0] - 0.4, z1 = BAY_SEATS_Z[BAY_SEATS_Z.length - 1] + 0.4;
    tubes.push(rod(new THREE.Vector3(s * (xs - 0.53), SEAT_Y - 0.03, z0), new THREE.Vector3(s * (xs - 0.53), SEAT_Y - 0.03, z1), 0.026, 8));
    tubes.push(rod(new THREE.Vector3(s * (wallX(BACK_Y + 0.33) - 0.08), BACK_Y + 0.33, z0), new THREE.Vector3(s * (wallX(BACK_Y + 0.33) - 0.08), BACK_Y + 0.33, z1), 0.024, 8));
    for (let k = 0; k <= BAY_SEATS_Z.length; k++) { const z = (k === 0 ? BAY_SEATS_Z[0] - 0.62 : BAY_SEATS_Z[k - 1] + 0.62); tubes.push(rod(new THREE.Vector3(s * (wallX(FLOOR_Y + 0.05) - 0.05), FLOOR_Y, z), new THREE.Vector3(s * (wallX(BACK_Y + 0.35) - 0.08), BACK_Y + 0.35, z), 0.022, 8)); }
  }
  // ---- BANANA CO. crates strapped by the ramp (cargo straps over them)
  const crates: THREE.BufferGeometry[] = [], straps: THREE.BufferGeometry[] = [];
  for (const [x, y, z, sz, ry] of [[-(halfW - 0.62), 0, -8.3, 0.95, 0.04], [-(halfW - 0.62), 0.95, -8.25, 0.78, 0.1], [halfW - 0.6, 0, -8.2, 0.85, -0.06]] as const) {
    const b = rbox(sz, sz, sz, 0.04); b.rotateY(ry); b.translate(x, FLOOR_Y + y + sz / 2, z); crates.push(b);
    for (const dz of [-0.25, 0.25]) { const st = rbox(sz + 0.03, 0.02, 0.07, 0.008); st.translate(0, sz / 2 + 0.005, dz * sz); const st2 = rbox(0.02, sz + 0.02, 0.07, 0.008); const st3 = st2.clone(); st2.translate(sz / 2 + 0.005, 0, dz * sz); st3.translate(-sz / 2 - 0.005, 0, dz * sz); for (const q of [st, st2, st3]) { q.rotateY(ry); q.translate(x, FLOOR_Y + y + sz / 2, z); straps.push(q); } }
  }
  const mk = (geo: THREE.BufferGeometry, m: THREE.Material, cast = false, name = "") => { const me = new THREE.Mesh(geo, m); me.castShadow = cast; me.receiveShadow = true; if (name) me.name = name; return me; };
  g.add(floorM, mk(merge(metal), M.metal), mk(merge(ribs), M.rib, false, "bay-frames"), mk(merge(seatG), M.seat, false, "bay-seats"), mk(merge(tubes), M.frame), mk(merge(dark), M.dark),
    mk(merge(lamps), M.lamp), mk(merge(crates), M.crate, true), mk(merge(straps), M.strap), mk(merge(rails), M.railY), mk(merge(frames), M.frame), mk(merge(glass), M.glass),
    mk(merge([portal, portalBack, thr]), M.metal), mk(hazard, M.hazard), mk(jumpLamp, M.jump, false, "jump-lamp"));
  return { group: g, seats };
}

function buildWings(mat: THREE.Material) {
  const shape: LiftShape = {
    half: WING_HALF, round: 0.95, camber: 0.025, inc: 0.035,
    chord: (x) => (x < WING_CENTRE ? WING_C0 : lerp(WING_C0, WING_C1, (x - WING_CENTRE) / (WING_HALF - WING_CENTRE))),
    le: (x) => WING_LE + (x < WING_CENTRE ? 0 : 0.45 * (x - WING_CENTRE) / (WING_HALF - WING_CENTRE)),
    y: (x) => WING_Y + Math.max(0, x - 1.8) * Math.tan(THREE.MathUtils.degToRad(2.6)),
    t: (x) => lerp(0.17, 0.12, clamp01((x - WING_CENTRE) / (WING_HALF - WING_CENTRE))),
  };
  const { f, spans, vs } = liftSurface(shape, 64, 22);
  const geo = surface(spans, vs, f, { flip: true, uv: (x, v) => [(x + WING_HALF) / (2 * WING_HALF), v], vd: [0, 1] });
  const m = new THREE.Mesh(geo, mat); m.name = "wing"; m.castShadow = true; m.receiveShadow = true;
  // flap-track canoe fairings under the trailing edge
  const canoes: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) for (const x of [3.1, 8.6, 11.8]) {
    const c = new THREE.CapsuleGeometry(0.1, 0.9, 4, 8); c.rotateX(Math.PI / 2); c.scale(1, 1.4, 1);
    const ax = Math.abs(x), le = shape.le(ax), ch = shape.chord(ax);
    c.translate(s * x, shape.y(ax) - 0.2, le + ch * 0.86); canoes.push(c);
  }
  return { mesh: m, shape, canoes };
}

function buildStabs(mat: THREE.Material) {
  const shape: LiftShape = {
    half: STAB_HALF, round: 0.55, camber: 0, inc: 0,
    chord: (x) => lerp(3.2, 1.9, x / STAB_HALF), le: (x) => STAB_LE + 1.05 * (x / STAB_HALF),
    y: (x) => STAB_Y + x * 0.012, t: () => 0.12,
  };
  const { f, spans, vs } = liftSurface(shape, 36, 16);
  const geo = surface(spans, vs, f, { flip: true, uv: (x, v) => [(x + STAB_HALF) / (2 * STAB_HALF), v], vd: [0, 1] });
  const m = new THREE.Mesh(geo, mat); m.name = "stabiliser"; m.castShadow = true; m.receiveShadow = true;
  return m;
}

function buildFin(mat: THREE.Material) {
  const f: Fn = (h, v, o) => {
    const y = lerp(FIN_Y0, FIN_Y1, h);
    let le = finLE(y), te = finTE(y);
    // squared, raked top with small rounded corners (the target art's fin is squared, not a pointed ogive)
    const q = (y - FIN_TOP0) / (FIN_Y1 - FIN_TOP0);
    if (q > 0) { const kl = ell(q, 4.5), kt = ell(q, 3.2); const mid = lerp(le, te, 0.5); le = mid - (mid - le) * kl; te = mid + (te - mid) * Math.max(1e-3, kt); }
    const c = Math.max(1e-3, te - le), xc = chordOf(v), [, yt] = airfoil(xc, 0.12, 0);
    const side = v >= 0.5 ? -1 : 1; // v<0.5 → starboard (+x) skin
    o.set(side * yt * c * (q > 0 ? Math.max(0.15, ell(q, 2.4)) : 1), y, le + xc * c);
  };
  const hs = uniq([...range(0, 1, 40), ...range((FIN_TOP0 - FIN_Y0) / (FIN_Y1 - FIN_Y0), 1, 14, 0.7)]);
  const sx = 0.5 / (FIN_ZMAX - FIN_ZMIN);
  const stbd = surface(hs, cosRange(0, 0.5, 22), f, { flip: true, vd: [0, 1], uv: (_h, _v, p) => [(FIN_ZMAX - p.z) * sx, (p.y - FIN_Y0) / (FIN_Y1 - FIN_Y0)] });
  const port = surface(hs, cosRange(0.5, 1, 22), f, { flip: true, vd: [0, 1], uv: (_h, _v, p) => [0.5 + (p.z - FIN_ZMIN) * sx, (p.y - FIN_Y0) / (FIN_Y1 - FIN_Y0)] });
  const m = new THREE.Mesh(merge([stbd, port]), mat); m.name = "fin"; m.castShadow = true; m.receiveShadow = true;
  return m;
}

function buildSponsons(mat: THREE.Material) {
  const geos: THREE.BufferGeometry[] = [];
  const Z0 = -5.25, Z1 = 1.75;
  for (const s of [-1, 1]) {
    const f: Fn = (z, a, o) => {
      const t = (z - Z0) / (Z1 - Z0);
      const kf = t < 0.16 ? ell((0.16 - t) / 0.16, 2.1) : 1;
      const kr = t > 0.62 ? ell((t - 0.62) / 0.38, 1.5) : 1;
      const k = kf * kr;
      const hw = 0.78 * Math.max(0.03, Math.pow(k, 0.9)), hh = 0.74 * Math.max(0.03, k);
      const cx = s * lerp(1.45, 1.9, Math.pow(kr, 0.6)), cy = lerp(2.05, 1.62, Math.pow(kr, 0.8));
      o.set(cx + hw * sp(Math.sin(a), 2 / 2.5) * s, cy - hh * sp(Math.cos(a), 2 / 2.5), z);
    };
    geos.push(surface(range(Z0, Z1, 40), range(0, TAU, 40), f, { flip: s > 0, vd: [0, TAU], uv: (z, a) => [(z - Z0) / (Z1 - Z0), a / TAU] }));
  }
  const m = new THREE.Mesh(merge(geos), mat); m.name = "sponsons"; m.castShadow = true; m.receiveShadow = true;
  return m;
}

function wheelGeoms(R: number, W: number) {
  // tyre (profile around the axle, axle = X)
  const prof: [number, number][] = [];
  const rim = R * 0.58;
  const pts: [number, number][] = [[rim, W * 0.44], [R * 0.8, W * 0.5], [R * 0.95, W * 0.46], [R * 0.995, W * 0.36], [R, W * 0.2], [R, -W * 0.2], [R * 0.995, -W * 0.36], [R * 0.95, -W * 0.46], [R * 0.8, -W * 0.5], [rim, -W * 0.44]];
  const curve = new THREE.SplineCurve(pts.map(([r, x]) => new THREE.Vector2(x, r)));
  const n = 18;
  for (let i = 0; i <= n; i++) { const p = curve.getPoint(i / n); prof.push([p.y, p.x]); }
  const tyre = surface(range(0, n, n), range(0, TAU, 40), (i, a, o) => {
    const k = Math.min(n - 1, Math.floor(i)), fr = i - k, p0 = prof[k], p1 = prof[Math.min(n, k + 1)];
    const r = lerp(p0[0], p1[0], fr), x = lerp(p0[1], p1[1], fr);
    o.set(x, r * Math.cos(a), r * Math.sin(a));
  }, { uv: (i, a) => [i / n, a / TAU], ud: [0, n], vd: [0, TAU] });
  // hub: dished disc on the outer face + bolt ring + axle cap (both faces)
  const hubs: THREE.BufferGeometry[] = [];
  for (const sgn of [1, -1]) {
    const hp = [new THREE.Vector2(0.001, W * 0.34), new THREE.Vector2(R * 0.12, W * 0.34), new THREE.Vector2(R * 0.16, W * 0.26), new THREE.Vector2(R * 0.36, W * 0.24), new THREE.Vector2(R * 0.44, W * 0.34), new THREE.Vector2(rim * 1.01, W * 0.42), new THREE.Vector2(rim * 1.01, 0)];
    const lg = new THREE.LatheGeometry(hp, 28); lg.rotateZ(-Math.PI / 2); if (sgn < 0) lg.rotateY(Math.PI);
    hubs.push(lg);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU, b = new THREE.CylinderGeometry(0.022, 0.026, 0.05, 6);
      b.rotateZ(Math.PI / 2); b.translate(sgn * W * 0.27, Math.cos(a) * R * 0.27, Math.sin(a) * R * 0.27); hubs.push(b);
    }
  }
  return { tyre, hub: merge(hubs) };
}

function buildGear(tyreM: THREE.Material, hubM: THREE.Material, strutM: THREE.Material, darkM: THREE.Material) {
  const main: THREE.Group[] = [];
  const { tyre, hub } = wheelGeoms(WHEEL_R, 0.38);
  const WZ = [-3.95, -2.78, -1.61, -0.44];
  for (const s of [-1, 1]) {
    const g = new THREE.Group(); g.name = s > 0 ? "gear-R" : "gear-L";
    const x = s * 1.98;
    const t: THREE.BufferGeometry[] = [], h: THREE.BufferGeometry[] = [], st: THREE.BufferGeometry[] = [];
    for (const z of WZ) { t.push(tyre.clone().translate(x, WHEEL_R, z)); h.push(hub.clone().translate(x, WHEEL_R, z)); }
    // bogie beams + oleo struts (hidden in the sponson when retracted)
    for (const zc of [(WZ[0] + WZ[1]) / 2, (WZ[2] + WZ[3]) / 2]) {
      st.push(rod(new THREE.Vector3(x - s * 0.26, WHEEL_R, zc - 0.62), new THREE.Vector3(x - s * 0.26, WHEEL_R, zc + 0.62), 0.07, 8));
      st.push(rod(new THREE.Vector3(x - s * 0.26, WHEEL_R, zc), new THREE.Vector3(x - s * 0.26, WHEEL_R + 1.1, zc), 0.09, 10));
      st.push(rod(new THREE.Vector3(x - s * 0.26, WHEEL_R + 0.35, zc), new THREE.Vector3(x - s * 0.26, WHEEL_R + 1.25, zc), 0.12, 10));
    }
    const mt = new THREE.Mesh(merge(t), tyreM), mh = new THREE.Mesh(merge(h), hubM), ms = new THREE.Mesh(merge(st), strutM);
    for (const m of [mt, mh, ms]) { m.castShadow = true; m.receiveShadow = true; }
    g.add(mt, mh, ms); main.push(g);
  }
  // nose gear: twin wheels, strut, torque link
  const ng = new THREE.Group(); ng.name = "gear-nose";
  const nw = wheelGeoms(NOSE_WHEEL_R, 0.24);
  const nt: THREE.BufferGeometry[] = [], nh: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) { nt.push(nw.tyre.clone().translate(s * 0.2, NOSE_WHEEL_R, NOSE_GEAR_Z)); nh.push(nw.hub.clone().translate(s * 0.2, NOSE_WHEEL_R, NOSE_GEAR_Z)); }
  const ns = [
    rod(new THREE.Vector3(-0.1, NOSE_WHEEL_R, NOSE_GEAR_Z), new THREE.Vector3(0.1, NOSE_WHEEL_R, NOSE_GEAR_Z), 0.06, 8),
    rod(new THREE.Vector3(0, NOSE_WHEEL_R, NOSE_GEAR_Z), new THREE.Vector3(0, NOSE_WHEEL_R + 1.25, NOSE_GEAR_Z - 0.05), 0.075, 10),
    rod(new THREE.Vector3(0, NOSE_WHEEL_R + 0.45, NOSE_GEAR_Z), new THREE.Vector3(0, NOSE_WHEEL_R + 1.4, NOSE_GEAR_Z - 0.05), 0.1, 10),
    rod(new THREE.Vector3(0, NOSE_WHEEL_R + 0.25, NOSE_GEAR_Z + 0.12), new THREE.Vector3(0, NOSE_WHEEL_R + 0.6, NOSE_GEAR_Z + 0.2), 0.03, 6),
  ];
  const mt = new THREE.Mesh(merge(nt), tyreM), mh = new THREE.Mesh(merge(nh), hubM), ms = new THREE.Mesh(merge(ns), strutM);
  for (const m of [mt, mh, ms]) { m.castShadow = true; m.receiveShadow = true; }
  ng.add(mt, mh, ms);
  // dark wheel-well boxes inside the sponsons / nose so the retracted wheels sit in shadowed bays
  const wells: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) { const b = rbox(0.5, 0.5, 4.5, 0.05); b.translate(s * 1.98, 1.25, -2.2); wells.push(b); }
  { const b = rbox(0.62, 0.55, 1.5, 0.05); b.translate(0, 1.62, NOSE_GEAR_Z); wells.push(b); }
  const wellM = new THREE.Mesh(merge(wells), darkM);
  return { main, nose: ng, wells: wellM };
}

function buildEngine(cowlM: THREE.Material, nacM: THREE.Material, darkM: THREE.Material, spinM: THREE.Material, bladeM: THREE.Material, discM: THREE.Material, sootM: THREE.Material, s: number) {
  const eng = new THREE.Group(); eng.name = s > 0 ? "engine-R" : "engine-L";
  // cowl: lathe around the engine axis (+Z aft). profile u: inner lip → outer → rear
  const prof: [number, number][] = [[0.8, 0.34], [0.82, 0.14], [0.87, 0.03], [0.95, 0.0], [1.0, 0.05], [1.03, 0.2], [COWL_R, 0.6], [COWL_R, 1.4], [1.02, 2.0], [0.98, 2.4]];
  const pc = new THREE.CatmullRomCurve3(prof.map(([r, z]) => new THREE.Vector3(r, z, 0)));
  const np = 40, pp = pc.getSpacedPoints(np);
  const cowl = surface(range(0, np, np), range(0, TAU, 56), (i, a, o) => {
    const k = Math.min(np - 1, Math.floor(i)), fr = i - k, p0 = pp[k], p1 = pp[k + 1];
    const r = lerp(p0.x, p1.x, fr), z = lerp(p0.y, p1.y, fr);
    o.set(r * Math.sin(a), r * Math.cos(a), z);
  }, { uv: (i, a) => [i / np, a / TAU], ud: [0, np], vd: [0, TAU] });
  const cowlMesh = new THREE.Mesh(cowl, cowlM); cowlMesh.castShadow = true; cowlMesh.receiveShadow = true;
  // nacelle body behind the cowl, blending up into the wing
  const L = 7.6;
  const nac = surface(range(0, 1, 30), range(0, TAU, 40), (t, a, o) => {
    const r = 0.98 * (1 - 0.62 * Math.pow(t, 1.6)), cy = 0.55 * Math.pow(t, 1.4);
    const topFlat = 1 + 0.25 * Math.pow(t, 0.8);
    const y = -Math.cos(a) * r * (Math.cos(a) < 0 ? topFlat : 1);
    o.set(Math.sin(a) * r * (1 - 0.06 * t), cy + y, 2.35 + t * L);
  }, { flip: true, uv: (t, a) => [t, a / TAU], vd: [0, TAU] });
  const nacMesh = new THREE.Mesh(nac, nacM); nacMesh.castShadow = true; nacMesh.receiveShadow = true;
  // engine face: crankcase + 9 cylinders behind the lip; gills; exhaust stubs
  const dark: THREE.BufferGeometry[] = [];
  const face = new THREE.CircleGeometry(0.84, 32); face.translate(0, 0, 0.42); dark.push(face);
  const crank = new THREE.SphereGeometry(0.34, 20, 10, 0, TAU, 0, Math.PI / 2); crank.rotateX(-Math.PI / 2); crank.scale(1, 1, 0.6); crank.translate(0, 0, 0.4); dark.push(crank);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * TAU, cyl = new THREE.CylinderGeometry(0.1, 0.12, 0.42, 10);
    cyl.translate(0, 0.52, 0); cyl.rotateZ(a); cyl.translate(0, 0, 0.36); dark.push(cyl);
    for (let f = 0; f < 4; f++) { const fin = new THREE.CylinderGeometry(0.15, 0.15, 0.018, 12); fin.translate(0, 0.4 + f * 0.07, 0); fin.rotateZ(a); fin.translate(0, 0, 0.36); dark.push(fin); }
  }
  const soot: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * TAU, flap = rbox(0.3, 0.025, 0.44, 0.01);
    flap.translate(0, 0, 0.2); flap.rotateX(-0.2); flap.translate(0, 0.965, 2.34); flap.rotateZ(a); soot.push(flap);
  }
  for (const side of [-1, 1]) for (const dy of [-0.2, -0.55]) {
    const p0 = new THREE.Vector3(side * 0.85, dy, 2.6), p1 = new THREE.Vector3(side * 1.02, dy - 0.05, 3.0), p2 = new THREE.Vector3(side * 1.08, dy - 0.08, 3.35);
    soot.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([p0, p1, p2]), 8, 0.085, 10, false));
    const lip = new THREE.TorusGeometry(0.085, 0.018, 6, 12); lip.translate(p2.x, p2.y, p2.z); soot.push(lip);
  }
  const darkMesh = new THREE.Mesh(merge(dark), darkM), sootMesh = new THREE.Mesh(merge(soot), sootM);
  sootMesh.castShadow = true;
  // spinner (vertex coloured: brown base ring, glossy black-brown dome)
  const spinL = 1.25;
  const spin = surface(range(0, 1, 18), range(0, TAU, 32), (t, a, o) => {
    const r = 0.46 * ell(t, 1.9) * (t < 0.05 ? 1 : 1);
    o.set(r * Math.sin(a), r * Math.cos(a), PROP_Z - ENG_Z + 0.12 - t * spinL);
  }, { vd: [0, TAU], flip: true, color: (t) => (t < 0.16 ? new THREE.Color("#6b4724") : t < 0.2 ? new THREE.Color("#e0b030") : new THREE.Color("#1e1713")) });
  const spinMesh = new THREE.Mesh(spin, spinM); spinMesh.castShadow = true;
  // prop: 4 crisp blades (stopped) + blurred disc (running), both on a spinning hub group
  const prop = new THREE.Group(); prop.position.set(0, 0, PROP_Z - ENG_Z);
  const blades: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const b = surface(range(0.34, PROP_R, 22), range(0, TAU, 14), (r, a, o) => {
      const t = (r - 0.34) / (PROP_R - 0.34);
      let c = 0.18 + 0.24 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.12)) ;
      const tipQ = (r - (PROP_R - 0.14)) / 0.14;
      if (tipQ > 0) c *= Math.max(0.02, ell(tipQ, 2));
      const th = lerp(0.1, 0.028, Math.pow(t, 0.6)) * (tipQ > 0 ? Math.max(0.1, ell(tipQ, 2)) : 1);
      const beta = Math.atan(0.9 / (r + 0.2)) * 0.9;
      const cx = (c / 2) * Math.cos(a), cz = (th / 2) * Math.sin(a) + 0.02 * Math.cos(a) * Math.cos(a);
      o.set(cx * Math.cos(beta) - cz * Math.sin(beta), r, cx * Math.sin(beta) + cz * Math.cos(beta));
    }, { vd: [0, TAU], color: (r) => (r > PROP_R - 0.24 ? new THREE.Color(YEL) : new THREE.Color("#1f1813")) });
    b.rotateZ((k / 4) * TAU + 0.35);
    blades.push(b);
  }
  const hubC = new THREE.CylinderGeometry(0.36, 0.4, 0.3, 20); hubC.rotateX(Math.PI / 2);
  const colorAttr = new Float32Array(hubC.attributes.position.count * 3).fill(0.12); hubC.setAttribute("color", new THREE.BufferAttribute(colorAttr, 3));
  const bladeMesh = new THREE.Mesh(merge([...blades, hubC], true), bladeM); bladeMesh.castShadow = true;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(PROP_R + 0.03, 64), discM); disc.renderOrder = 2;
  prop.add(bladeMesh, disc);
  // brown cowling lip ring (reads from behind as the outline of the cowl mouth around the prop disc)
  const lip = new THREE.TorusGeometry(0.97, 0.075, 10, 56); lip.translate(0, 0, 0.07);
  const lipMesh = new THREE.Mesh(lip, darkM); lipMesh.castShadow = true;
  eng.add(cowlMesh, nacMesh, darkMesh, sootMesh, spinMesh, prop, lipMesh);
  eng.position.set(s * ENG_X, ENG_Y, ENG_Z);
  return { eng, prop, blades: bladeMesh, disc };
}

function buildDetails(metalM: THREE.Material, darkM: THREE.Material, redM: THREE.Material, greenM: THREE.Material, whiteM: THREE.Material, glassM: THREE.Material, frameM: THREE.Material, wingShape: LiftShape) {
  const g = new THREE.Group(); g.name = "details";
  const metal: THREE.BufferGeometry[] = [], dark: THREE.BufferGeometry[] = [], glass: THREE.BufferGeometry[] = [], frames: THREE.BufferGeometry[] = [];
  const p = new THREE.Vector3(), n = new THREE.Vector3(), q = new THREE.Vector3();
  const normalAt = (z: number, a: number) => {
    fuse(z + 0.01, a, q); fuse(z - 0.01, a, p); const dz = q.clone().sub(p);
    fuse(z, a + 0.01, q); fuse(z, a - 0.01, p); const da = q.clone().sub(p);
    return dz.cross(da).normalize().negate();
  };
  // portholes: glass lens (shallow spherical cap) + raised frame ring, 8 each side along the cheat line
  for (const s of [1, -1]) for (const z of PORTHOLES) {
    const a = s > 0 ? aOfY(WIN_Y) : TAU - aOfY(WIN_Y);
    fuse(z, a, p); n.copy(normalAt(z, a));
    const R = 0.62, rr = 0.225, th = Math.asin(rr / R);
    const cap = new THREE.SphereGeometry(R, 20, 4, 0, TAU, 0, th);
    cap.translate(0, -R * Math.cos(th) + 0.004, 0); place(cap, p, n); glass.push(cap);
    const ring = new THREE.TorusGeometry(0.255, 0.038, 8, 28); ring.scale(1, 1, 0.55); ring.rotateX(Math.PI / 2);
    place(ring, p.clone().addScaledVector(n, 0.008), n); frames.push(ring);
  }
  // beacons (top + belly), nav lights, tail light
  const top = fuse(1.9, Math.PI, new THREE.Vector3());
  const beacon = (pos: THREE.Vector3, up: number) => {
    const dome = new THREE.SphereGeometry(0.11, 14, 8, 0, TAU, 0, Math.PI / 2); dome.scale(1, 1.3, 1); if (up < 0) dome.rotateX(Math.PI);
    dome.translate(pos.x, pos.y + up * 0.05, pos.z);
    const base = new THREE.CylinderGeometry(0.14, 0.16, 0.06, 14); base.translate(pos.x, pos.y + up * 0.02, pos.z);
    return { dome, base };
  };
  const b1 = beacon(top, 1);
  // (no belly beacon: from the drop-01 camera it reads as a pink blob under the plane)
  const red = [b1.dome], green: THREE.BufferGeometry[] = [], white: THREE.BufferGeometry[] = [];
  metal.push(b1.base);
  for (const s of [-1, 1]) {
    const x = s * (WING_HALF - 0.28), le = wingShape.le(Math.abs(x)) + wingShape.chord(Math.abs(x)) * 0.42 * (1 - ell((Math.abs(x) - (WING_HALF - 0.95)) / 0.95, 2.2)) + 0.05;
    const l = new THREE.SphereGeometry(0.09, 12, 8); l.scale(1.6, 0.8, 1); l.translate(x, wingShape.y(Math.abs(x)), le);
    (s < 0 ? red : green).push(l);
  }
  { const l = new THREE.SphereGeometry(0.07, 10, 6); const tp = fuse(ZCAP - 0.02, 0, new THREE.Vector3()); l.translate(0, sec(ZCAP - 0.05).cy, ZCAP + 0.02); white.push(l); void tp; }
  // antennas: two blade antennas on top, one on the belly, whip + long wire from a mast to the fin
  const blade = (z: number, a: number, h: number, sw = 0.25) => {
    fuse(z, a, p); const nn = normalAt(z, a);
    const sh = new THREE.Shape(); sh.moveTo(-sw, 0); sh.lineTo(sw * 0.4, 0); sh.lineTo(sw * 0.2, h); sh.lineTo(-sw * 0.05, h); sh.closePath();
    const eg = new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 1 });
    eg.translate(0, 0, -0.015); eg.rotateY(Math.PI / 2); place(eg, p, nn); dark.push(eg);
  };
  blade(-7.2, Math.PI, 0.42); blade(3.3, Math.PI, 0.36); blade(-0.3, 0, 0.3); blade(6.6, Math.PI + 0.25, 0.3);
  // (no HF wire from a mast to the fin: the target art has none and a 7 mm wire only aliases into a stray line)
  // pitot tubes on both nose sides
  for (const s of [1, -1]) {
    const a = s > 0 ? 1.95 : TAU - 1.95; fuse(-12.35, a, p); const nn = normalAt(-12.35, a);
    const base = p.clone().addScaledVector(nn, 0.0), out = p.clone().addScaledVector(nn, 0.18);
    metal.push(rod(base, out, 0.022, 6)); metal.push(rod(out, out.clone().add(new THREE.Vector3(0, 0, -0.32)), 0.016, 6));
  }
  // landing lights in the wing leading edge (glass lenses)
  for (const s of [-1, 1]) { const l = new THREE.SphereGeometry(0.12, 14, 8, 0, TAU, 0, Math.PI / 2); l.rotateX(-Math.PI / 2); l.scale(1.2, 0.7, 0.4); l.translate(s * 3.2, wingShape.y(3.2) + 0.02, WING_LE - 0.005); glass.push(l); }
  const mk = (geo: THREE.BufferGeometry[], m: THREE.Material, cast = true) => { if (!geo.length) return; const me = new THREE.Mesh(merge(geo), m); me.castShadow = cast; me.receiveShadow = true; g.add(me); return me; };
  mk(metal, metalM); mk(dark, darkM); mk(glass, glassM, false); mk(frames, frameM); mk(red, redM, false); mk(green, greenM, false); mk(white, whiteM, false);
  return g;
}

// ============================================================================ assembly
type Img = Canvas | ImageBitmap;
type Tex = Layers<THREE.Texture>;
type TexSet = PlanePainted<THREE.Texture>;
let TEX: TexSet | null = null;
let painting: Promise<PlanePainted<Img>> | null = null;
let paintGen = 0, paintReleased = false;
let restoring: Promise<void> | null = null;
const PAINT_FREE = flag("planefree");
const yieldT = () => new Promise<void>((r) => setTimeout(r, 0));
const isBitmap = (img: unknown): img is ImageBitmap => typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap;

function paintPlane(): Promise<PlanePainted<Img>> {
  const t0 = performance.now();
  const out: Partial<Record<PaintName, Img | Layers<Img>>> = {};
  return new Promise((resolve, reject) => {
    let finished = false;
    const finishHere = async () => {
      if (finished) return;
      finished = true;
      let k = 0;
      for (const n of PAINT_NAMES) if (!out[n]) { out[n] = PLANE_PAINT[n](); k++; await yieldT(); }
      console.info(`[plane] textures ready ${(performance.now() - t0).toFixed(0)} ms after start (${k} painted on the main thread)`);
      resolve(out as PlanePainted<Img>);
    };
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return void finishHere().catch(reject);
    const scope = resources.root.child("plane-paint");
    const stop = () => { scope.dispose(); finishHere().catch(reject); };
    try {
      const w = scope.worker(new Worker(new URL("./plane-paint.worker.ts", import.meta.url), { type: "module" }));
      let left = PAINT_NAMES.length;
      w.onmessage = (e: MessageEvent<{ name: PaintName; set?: ImageBitmap | Layers<ImageBitmap>; error?: string }>) => {
        const { name, set, error } = e.data;
        if (set) out[name] = set;
        else console.warn("[plane] texture worker:", name, error);
        if (--left === 0) stop();
      };
      w.onerror = (ev) => { console.warn("[plane] texture worker failed, painting on the main thread", ev.message); stop(); };
    } catch (e) {
      console.warn("[plane] no texture worker", e);
      stop();
    }
  });
}
if (typeof window !== "undefined") painting = paintPlane();

function wrap(img: Img, colour: boolean, repeat: boolean, aniso: number): THREE.Texture {
  const t = resources.root.texture("tex.actor", new THREE.Texture(img));
  t.flipY = !isBitmap(img);
  t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}
const wrapLayers = (s: Layers<Img>): Tex => ({ map: wrap(s.map, true, true, 8), normal: wrap(s.normal, false, true, 8), rough: wrap(s.rough, false, true, 8) });
function wrapAll(p: PlanePainted<Img>): TexSet {
  return {
    fT: wrapLayers(p.fT), wT: wrapLayers(p.wT), sT: wrapLayers(p.sT), finT: wrapLayers(p.finT), cT: wrapLayers(p.cT), nT: wrapLayers(p.nT), spT: wrapLayers(p.spT), tyT: wrapLayers(p.tyT),
    trT: wrapLayers(p.trT), inT: wrapLayers(p.inT), webT: wrapLayers(p.webT),
    hazT: wrap(p.hazT, true, true, 8), pgT: wrap(p.pgT, true, false, 1), crT: wrapLayers(p.crT), discT: wrap(p.discT, true, false, 8),
  };
}

function flat<T>(set: PlanePainted<T>): T[] {
  const out: T[] = [];
  for (const n of PAINT_NAMES) {
    const v: T | Layers<T> = set[n];
    if (isLayers(v)) out.push(v.map, v.normal, v.rough);
    else out.push(v);
  }
  return out;
}

function swapImage(t: THREE.Texture, image: Img) {
  t.image = image;
  t.flipY = !isBitmap(image);
  t.dispose();
  t.needsUpdate = true;
}

export function releasePlanePaint() {
  if (!PAINT_FREE || !TEX || paintReleased) return;
  paintReleased = true; paintGen++;
  for (const t of flat(TEX)) {
    const one = document.createElement("canvas"); one.width = 1; one.height = 1;
    const old = t.image;
    one.getContext("2d")!.drawImage(old as CanvasImageSource, 0, 0, 1, 1);
    swapImage(t, one);
    freeImage(old);
  }
}

export function restorePlanePaint(): Promise<void> {
  if (!TEX || !paintReleased) return Promise.resolve();
  return restoring ??= (async () => {
    const gen = paintGen;
    const fresh = await paintPlane();
    if (gen !== paintGen || !TEX) return;
    paintReleased = false;
    const cur = flat(TEX), next = flat(fresh);
    for (let i = 0; i < cur.length; i++) swapImage(cur[i], next[i]);
  })().finally(() => { restoring = null; });
}

export async function createPlane(ctx: WorldCtx, opts: { crew?: boolean } = {}): Promise<PlaneProps> {
  const object = new THREE.Group();
  object.name = "plane";

  // ---- textures + materials
  // painted once per page and shared by every plane (the lobby's parked plane + the flight plane)
  if (!TEX) { const p = await (painting ??= paintPlane()).finally(() => { painting = null; }); TEX ??= wrapAll(p); }
  const { fT, wT, sT, finT, cT, nT, spT, tyT, trT, inT, webT, hazT, pgT, crT, discT } = TEX as TexSet;
  const paint = (t: Tex, o: THREE.MeshPhysicalMaterialParameters = {}) => new THREE.MeshPhysicalMaterial({
    map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(0.9, 0.9), roughnessMap: t.rough, roughness: 1, metalness: 0,
    // glossy lemon-yellow enamel (target art: a lacquered toy plane): strong clearcoat; a small LEMON fill through the
    // albedo map keeps shaded sides yellow (a dark-orange fill read ochre)
    // (pastel butter, saturation 0.66 vs 0.85–0.95 — the sky env on a 0.6 clearcoat + a lemon fill washed the
    // yellow out: a thinner coat, half the env, a small fill)
    clearcoat: 0.35, clearcoatRoughness: 0.14, envMapIntensity: 0.6,
    // a yellow fill through the albedo map (the target art lights the plane like a studio: its shaded flank stays lemon, never
    // tan) — with the thinner coat it lifts saturation, not whiteness
    // at 0.2 the shaded flank measured val 0.55 / sat 0.6 vs the target art's 0.8 / 0.95
    emissive: new THREE.Color("#ffdc30"), emissiveMap: t.map, emissiveIntensity: 0.3,
  });
  // (fin hue 32 vs the target art's 46 — atmos's warm bounce squared the yellow's chroma in the fill)
  const paintL = (t: Tex, o: THREE.MeshPhysicalMaterialParameters = {}) => actorLook(paint(t, o), { key: "plane-paint" });
  const fuseM = paintL(fT), wingM = paintL(wT), stabM = paintL(sT), finM = paintL(finT), cowlM = paintL(cT), nacM = paintL(nT), sponM = paintL(spT);
  const tyreM = new THREE.MeshStandardMaterial({ map: tyT.map, normalMap: tyT.normal, roughnessMap: tyT.rough, roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  const hubM = new THREE.MeshStandardMaterial({ color: "#c9c6bd", metalness: 0.85, roughness: 0.32 });
  const strutM = new THREE.MeshStandardMaterial({ color: "#d8d8d4", metalness: 0.9, roughness: 0.18 });
  const metalM = new THREE.MeshStandardMaterial({ color: "#7c7a74", metalness: 0.8, roughness: 0.4 });
  const darkM = new THREE.MeshStandardMaterial({ color: "#241f1b", metalness: 0.5, roughness: 0.55 });
  const sootM = new THREE.MeshStandardMaterial({ color: "#3b3129", metalness: 0.6, roughness: 0.5 });
  const wellM = new THREE.MeshStandardMaterial({ color: "#16110d", metalness: 0, roughness: 0.9, side: THREE.BackSide });
  const spinM = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.22, clearcoat: 0.8, clearcoatRoughness: 0.1 });
  const bladeM = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.35, clearcoat: 0.5, clearcoatRoughness: 0.2 });
  // unlit: a blur disc is an image of moving blades, not a lit surface (a lit disc goes grey from its back side)
  const discM = new THREE.MeshBasicMaterial({ map: discT, transparent: true, depthWrite: false, side: THREE.DoubleSide, color: "#8a8178" });
  const glassM = new THREE.MeshPhysicalMaterial({ color: "#0d161d", metalness: 0.1, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.8 });
  const frameM = new THREE.MeshPhysicalMaterial({ color: "#d8d2c2", metalness: 0.7, roughness: 0.28, clearcoat: 0.4 });
  const glow = (c: string, i: number) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: i, roughness: 0.2 });
  const redM = glow("#ff2a1a", 2.2), greenM = glow("#27ff5a", 2.0), whiteM = glow("#fff6e0", 0.7), lampM = glow("#fff1c9", 3.2);
  const treadM = new THREE.MeshStandardMaterial({ map: trT.map, normalMap: trT.normal, roughnessMap: trT.rough, roughness: 1, metalness: 0.75, envMapIntensity: 0.9 });
  // cargo bay: yellow painted walls lit by the cabin lamps (a small emissive fill through the albedo —
  // no PointLights: a light-count change recompiles every program), shaded red webbing seats (no emissive)
  for (const x of [inT.map, inT.normal, inT.rough]) { x.wrapS = x.wrapT = THREE.RepeatWrapping; x.repeat.set((ZCAP - ZN) / 1.6, 7.8); }
  for (const x of [webT.map, webT.normal, webT.rough]) x.wrapS = x.wrapT = THREE.RepeatWrapping;
  const interiorM = actorLook(new THREE.MeshStandardMaterial({ map: inT.map, normalMap: inT.normal, normalScale: new THREE.Vector2(0.8, 0.8), roughnessMap: inT.rough, roughness: 1, metalness: 0.1, emissiveMap: inT.map, emissive: "#fff1d0", emissiveIntensity: 0.16, side: THREE.FrontSide, envMapIntensity: 0.4 }), { key: "bay-wall" });
  const ribM = actorLook(new THREE.MeshStandardMaterial({ color: "#e6b414", roughness: 0.55, metalness: 0.15, emissive: "#e6b414", emissiveIntensity: 0.1, envMapIntensity: 0.4 }), { key: "bay-rib" });
  const crateM = new THREE.MeshStandardMaterial({ map: crT.map, normalMap: crT.normal, roughnessMap: crT.rough, roughness: 1, metalness: 0, emissive: "#3a2410", emissiveIntensity: 0.25, envMapIntensity: 0.45 });
  const seatM = new THREE.MeshStandardMaterial({ map: webT.map, normalMap: webT.normal, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.86, metalness: 0, color: "#ffffff", envMapIntensity: 0.4 });
  const bayFrameM = new THREE.MeshStandardMaterial({ color: "#9a9ea2", metalness: 0.75, roughness: 0.34 });
  const strapM = new THREE.MeshStandardMaterial({ color: "#2a2622", roughness: 0.8, metalness: 0 });
  const bayDarkM = new THREE.MeshStandardMaterial({ color: "#3a3835", roughness: 0.6, metalness: 0.4 });
  const jumpM = new THREE.MeshStandardMaterial({ color: "#ff2410", emissive: "#ff2410", emissiveIntensity: 4.5, roughness: 0.3 });
  const glassBayM = new THREE.MeshBasicMaterial({ map: pgT, color: "#ffffff" });
  const hazM = new THREE.MeshStandardMaterial({ map: hazT, roughness: 0.6, metalness: 0.2, emissive: "#ffffff", emissiveMap: hazT, emissiveIntensity: 0.08 });
  const railYM = actorLook(new THREE.MeshStandardMaterial({ color: "#f0c01a", roughness: 0.5, metalness: 0.2 }), { key: "bay-rail" });
  for (const t of [trT, crT]) for (const x of [t.map, t.normal, t.rough]) x.wrapS = x.wrapT = THREE.RepeatWrapping;

  // ---- geometry
  await yieldT();
  const { shell, lining } = buildFuselage(fuseM, interiorM);
  await yieldT();
  const ramp = buildRamp(fuseM, interiorM, treadM, metalM);
  const door = buildUpperDoor(fuseM, interiorM);
  const bayB = buildCargoBay({ tread: treadM, metal: metalM, crate: crateM, seat: seatM, lamp: lampM, rib: ribM, frame: bayFrameM, strap: strapM, jump: jumpM, glass: glassBayM, hazard: hazM, railY: railYM, dark: bayDarkM }), bay = bayB.group;
  const wings = buildWings(wingM);
  const canoes = new THREE.Mesh(merge(wings.canoes), wingM); canoes.castShadow = true;
  const stabs = buildStabs(stabM), fin = buildFin(finM), spons = buildSponsons(sponM);
  await yieldT();
  const gear = buildGear(tyreM, hubM, strutM, wellM);
  const engines = [-1, 1].map((s) => buildEngine(cowlM, nacM, darkM, spinM, bladeM, discM, sootM, s));
  const details = buildDetails(metalM, darkM, redM, greenM, whiteM, glassM, frameM, wings.shape);
  object.add(shell, lining, ramp.group, door, bay, wings.mesh, canoes, stabs, fin, spons, gear.wells, gear.nose, ...gear.main, details, ...engines.map((e) => e.eng));

  // ---- state
  const rampExit = new THREE.Vector3();
  // max ramp angle: the toe tips touch y = 0 with the gear down
  const toeEnd = ramp.exitLocal.clone();
  let rampMax = 0.5;
  for (let a = 0; a < 1.2; a += 0.002) { const y = RAMP_PIVOT.y + toeEnd.y * Math.cos(a) - toeEnd.z * Math.sin(a); if (y <= 0.03) { rampMax = a; break; } }
  let running = true, rampOpen = 0, gearDown = 1;
  const setRamp = (o: number) => {
    rampOpen = clamp01(o);
    ramp.group.rotation.x = rampOpen * rampMax;
    door.rotation.x = Math.min(1, rampOpen * 8) * 0.22;
    door.visible = rampOpen < 0.12;
    bay.visible = lining.visible = rampOpen > 0.001;
    rampExit.copy(ramp.exitLocal).applyAxisAngle(new THREE.Vector3(1, 0, 0), ramp.group.rotation.x).add(RAMP_PIVOT);
  };
  const setGear = (d: number) => {
    gearDown = clamp01(d);
    for (const g of gear.main) g.position.y = (1 - gearDown) * GEAR_TRAVEL;
    gear.nose.position.y = (1 - gearDown) * NOSE_TRAVEL;
  };
  const setEngines = (r: boolean) => { running = r; for (const e of engines) { e.disc.visible = r; e.blades.visible = !r; } };
  setRamp(0); setGear(1); setEngines(false);
  let spin = 0;
  const update = (dt: number, t: number) => {
    spin = running ? t * 31 : spin + dt * 0.0;
    for (const [i, e] of engines.entries()) e.prop.rotation.z = (i ? -1 : 1) * spin + i * 0.7;
    const blink = (Math.sin(t * 7) > 0.6 ? 1.1 : 0.25);
    redM.emissiveIntensity = blink;
  };
  void gearDown;
  shareGeometries("plane", object);
  // ---- the crew: seated, harnessed kongs along both walls
  const crew = opts.crew === false ? null : await buildCrew(ctx, object, bayB.seats, bay);
  const update2 = (dt: number, t: number) => { update(dt, t); crew?.pose(dt); };
  return { object, update: update2, setRamp, setGear, setEngines, rampExit };
}

// ============================================================================ cabin crew
/** seated kongs (the other riders): sit pose + harness straps conformed to each one's chest; posed in world space from
 *  the plane's matrix every update (gameplay moves the plane first), hidden whenever the plane / bay is hidden or the
 *  plane is not level (their root has yaw only) */
async function buildCrew(ctx: WorldCtx, object: THREE.Group, seats: BaySeat[], bay: THREE.Object3D) {
  const used = seats.filter((st) => st.z > -1.0);
  const members: Array<{ k: KongActorEx; local: THREE.Vector3; yaw: number }> = [];
  const straps: THREE.BufferGeometry[] = [], buckles: THREE.BufferGeometry[] = [];
  const probe = new KongAnimator(0);
  const tmp = new THREE.Vector3(), P = (x: number, y: number, z: number, m: THREE.Matrix4) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  // head yaw toward the FRONT of the plane (+) / the ramp (−), pitch, chest twist: the two nearest the seat camera grin at
  // it (target art: the big foreground kongs look at the camera), the rest look down the bay at the ramp or at each other
  const looksNear: Array<[number, number, number]> = [[0.62, -0.05, 0.12], [0.5, 0.02, 0.08]];
  const looksFar: Array<[number, number, number]> = [[-0.7, -0.1, -0.05], [-0.35, 0.05, 0], [-0.8, -0.05, -0.08], [0.2, 0.1, 0.05], [-0.6, -0.12, 0.04], [-0.9, 0, -0.05], [-0.15, -0.15, 0.1], [-0.7, 0.05, 0]];
  let i = 0;
  for (const st of used) {
    const yaw = st.side * Math.PI / 2;
    const base: KongPose = { x: 0, y: FLOOR_Y, z: st.z, yaw, pitch: 0, vx: 0, vz: 0, vy: 0, state: "idle", crouch: false, sprint: false, weapon: null, team: 0, friendly: true };
    probe.showPose = "sit"; probe.overlay = null;
    probe.update(base, 0);
    // the pack's back against the seat back, the pelvis on the pan
    const chest = probe.bone("chest"), hips = probe.bone("hips");
    const pb = P(0, 0.03, 0.47, chest), hy = tmp.setFromMatrixPosition(hips).y;
    const local = new THREE.Vector3(st.backX - pb.x, st.seatY + 0.22 - (hy - FLOOR_Y), st.z);
    base.x = local.x; base.y = local.y;
    probe.update(base, 0);
    // harness (3D webbing, 7 × 1.6 cm, routed OUTSIDE the fur: over the trapezius beside the head, down the
    // pecs to a chest buckle, + a lap belt) — flat cards cut through muzzles and eyes
    const cm = probe.bone("chest"), hm = probe.bone("hips");
    for (const sx of [-1, 1]) {
      // (the Blender kong's trapezius tops out at ≈ chest + 0.42: a route at + 0.55 hung in the air as black hoops)
      const ctrl = [P(sx * 0.2, 0.28, 0.4, cm), P(sx * 0.25, 0.38, 0.26, cm), P(sx * 0.27, 0.43, 0.06, cm), P(sx * 0.27, 0.36, -0.17, cm), P(sx * 0.22, 0.2, -0.33, cm), P(sx * 0.1, 0.02, -0.36, cm), P(sx * 0.03, -0.06, -0.35, cm)];
      straps.push(strap3d(ctrl, P(0, 0.15, 0.02, cm), 0.07, 0.016));
    }
    straps.push(strap3d([P(-0.4, 0.04, 0.02, hm), P(-0.34, 0.08, -0.26, hm), P(0, 0.11, -0.4, hm), P(0.34, 0.08, -0.26, hm), P(0.4, 0.04, 0.02, hm)], P(0, 0.05, 0, hm), 0.065, 0.016));
    for (const [bx, by, bz, m] of [[0, -0.05, -0.395, cm], [0, 0.11, -0.415, hm]] as const) { const b = rbox(0.12, 0.085, 0.035, 0.012); b.applyMatrix4(new THREE.Matrix4().extractRotation(m)); const c = P(bx, by, bz, m); b.translate(c.x, c.y, c.z); buckles.push(b); }
    const k = await createKong(ctx, { variant: 20 + i * 3 });
    k.animator.showPose = "sit";
    const near = st.z < 0.5;
    const [hy2, hp, cy] = near ? looksNear[st.side > 0 ? 0 : 1] : looksFar[i % looksFar.length];
    // (+yaw turns the head to the kong's left; the front of the plane is on a port kong's left, a starboard kong's right)
    k.animator.overlay = (add) => { add.R("head", hp, hy2 * (st.side > 0 ? -1 : 1)); add.R("chest", 0, cy * 0.5 * (st.side > 0 ? -1 : 1)); };
    k.setLodBias(0.6);
    k.setLook({ fill: "#564c3a" });
    k.setVisible(false);
    members.push({ k, local, yaw });
    i++;
  }
  const strapM = new THREE.MeshStandardMaterial({ color: "#3a332c", roughness: 0.74 });
  const buckleM = new THREE.MeshStandardMaterial({ color: "#b8bcc0", metalness: 0.85, roughness: 0.3 });
  const harness = new THREE.Group(); harness.name = "bay-harness";
  harness.add(new THREE.Mesh(merge(straps), strapM), new THREE.Mesh(merge(buckles), buckleM));
  bay.add(harness);
  const up = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler();
  let shown = false;
  const visible = () => { if (!bay.visible) return false; let o: THREE.Object3D | null = object; while (o) { if (!o.visible) return false; o = o.parent; } return !!object.parent; };
  const pose = (dt: number) => {
    object.updateMatrixWorld(true);
    q.setFromRotationMatrix(object.matrixWorld); up.set(0, 1, 0).applyQuaternion(q);
    const on = visible() && up.y > 0.9994;
    if (on !== shown) { shown = on; for (const m of members) m.k.setVisible(on); }
    if (!on) return;
    e.setFromQuaternion(q, "YXZ");
    for (const m of members) {
      const w = m.local.clone().applyMatrix4(object.matrixWorld);
      m.k.apply({ x: w.x, y: w.y, z: w.z, yaw: e.y + m.yaw, pitch: 0, vx: 0, vz: 0, vy: 0, state: "idle", crouch: false, sprint: false, weapon: null, team: 0, friendly: true }, dt);
    }
  };
  // hide them the frame the plane / bay goes away (gameplay stops calling update() once the plane is hidden)
  ctx.onUpdate(() => { if (shown && !visible()) { shown = false; for (const m of members) m.k.setVisible(false); } });
  return { pose };
}
/** a 3D webbing strap (rounded rectangle w × t) along a curve, its broad face turned away from `centre` */
function strap3d(ctrl: THREE.Vector3[], centre: THREE.Vector3, w: number, t: number) {
  const curve = new THREE.CatmullRomCurve3(ctrl, false, "centripetal");
  const n = 40, ring = 12, pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, c = curve.getPoint(u), tg = curve.getTangent(u), out = c.clone().sub(centre); out.addScaledVector(tg, -out.dot(tg)).normalize();
    const side = new THREE.Vector3().crossVectors(tg, out).normalize();
    for (let j = 0; j < ring; j++) {
      const a = (j / ring) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      // superellipse (flat faces, rounded edges)
      const x = Math.sign(ca) * Math.pow(Math.abs(ca), 0.35) * w / 2, y = Math.sign(sa) * Math.pow(Math.abs(sa), 0.35) * t / 2;
      const p = c.clone().addScaledVector(side, x).addScaledVector(out, y + t / 2 + 0.004);
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < ring; j++) { const a = i * ring + j, b = i * ring + (j + 1) % ring, c = a + ring, d = b + ring; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const ng = g.toNonIndexed(); ng.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
  return ng;
}

// ============================================================================ staging + shot cameras
// In flight (drop-01): low over the turquoise water just off the south coast, flying north-west toward Ripe Peak.
// The camera offset/target (plane-yaw frame), fov and plane pitch/bank were solved by fitting 10 landmarks of
// the drop-01 target art (fin top, stab tips, nose, wingtips, spinners, ramp end, wheels) with a horizon-at-mid-frame constraint.
// The plane yaw is then derived so Ripe Peak sits ~7° right of the view axis as in the target art.
const PEAK = new THREE.Vector3(-380, 201, -430);
// Offshore SW of LOOKOUT POINT looking NNE along the green west coast —
// open sea + islets left, the coast, beach + reef below-right, the red/white lighthouse on its cliff at the right edge,
// Ripe Peak small and hazy behind the nose
const DROP_CAM = new THREE.Vector3(-860, 140, 660);
/** the whole camera + plane rig is pitched about the camera (the fitted plane framing is kept): tilted up 3° (sign:
 *  + = camera up), so open turquoise-blue sea sits under the plane and the wreck below the frame */
const RIG_TILT = THREE.MathUtils.degToRad(3);
// the camera sits ~4 m BELOW the wing plane, 3/4 behind-right, looking up — both prop discs show under the
// nacelles, the belly + sponson bogies read, the fin towers top-left (target art). Fitted to 8 target-art landmarks + the horizon
// (fit loss 0.067, camera 4.0 m under the pitched wing plane, horizon at 52 %).
// From there the camera sits higher (≈ 2.5 m over the wing plane) and further abeam (≈ 30° off the tail) so BOTH prop
// discs read beside the nacelles; the rig is turned 0.15 rad further so the coast + beach + reef sit right and Ripe
// Peak's lava cone leaves the frame
const DROP_CAM_L = new THREE.Vector3(18, 9, 32), DROP_TGT_L = new THREE.Vector3(4, 3.5, 2), DROP_FOV = 36;
const FLIGHT = (() => {
  const yawOf = (dx: number, dz: number) => Math.atan2(-dx, -dz);
  const camYawL = yawOf(DROP_TGT_L.x - DROP_CAM_L.x, DROP_TGT_L.z - DROP_CAM_L.z);
  const peakYaw = yawOf(PEAK.x - DROP_CAM.x, PEAK.z - DROP_CAM.z);
  const yaw = peakYaw + 0.61 - camYawL;   // turned left of Ripe Peak — sea + reef under the plane, the coast right (target art)
  const pos = DROP_CAM.clone().sub(DROP_CAM_L.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
  return { pos, yaw, pitch: -0.12, bank: 0.01 };
})();
const PARK = { pos: new THREE.Vector3(0, 2.5, 1020), yaw: 0.55 };
/** drop-02 (cabin): at the match altitude off the south coast flying south, so the open ramp looks back at the island;
 *  the camera is gameplay's seat camera (render.ts planeCamera: plane-local 0.55, floor + 1.5, −6.2, pitch −0.18) */
// from the seat the open ramp shows down to ≈ −12°, so the
// plane flies LOW (250 m) ≈ 1.2 km off the south coast heading south — the whole island fills the ramp opening
const CABIN = { pos: new THREE.Vector3(80, 250, 2200), yaw: Math.PI + 0.12 };
const cabinM = new THREE.Matrix4().compose(CABIN.pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, CABIN.yaw, 0, "YXZ")), new THREE.Vector3(1, 1, 1));
const flightM0 = new THREE.Matrix4().compose(FLIGHT.pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, FLIGHT.yaw, 0, "YXZ")), new THREE.Vector3(1, 1, 1));
const flightFull0 = new THREE.Matrix4().compose(FLIGHT.pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(FLIGHT.pitch, FLIGHT.yaw, FLIGHT.bank, "YXZ")), new THREE.Vector3(1, 1, 1));
const tiltM = (() => {
  const flat = new THREE.Matrix4().compose(FLIGHT.pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, FLIGHT.yaw, 0, "YXZ")), new THREE.Vector3(1, 1, 1));
  const c = DROP_CAM_L.clone().applyMatrix4(flat), t = DROP_TGT_L.clone().applyMatrix4(flat);
  const right = new THREE.Vector3().subVectors(t, c).cross(new THREE.Vector3(0, 1, 0)).normalize();
  return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationAxis(right, RIG_TILT)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
})();
const flightFullM = tiltM.clone().multiply(flightFull0);
const flightM = tiltM.clone().multiply(flightM0);
const parkM = new THREE.Matrix4().compose(PARK.pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, PARK.yaw, 0, "YXZ")), new THREE.Vector3(1, 1, 1));
const W = (m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] => { const v = new THREE.Vector3(x, y, z).applyMatrix4(m); return [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]; };
const cam = (m: THREE.Matrix4, p: [number, number, number], t: [number, number, number], fov: number, stage: string, note?: string): CamSpec => ({ pos: W(m, ...p), target: W(m, ...t), fov, stage, note });

export const views: Record<string, CamSpec> = {
  "drop-01-plane-exterior": cam(flightM, DROP_CAM_L.toArray(), DROP_TGT_L.toArray(), DROP_FOV, "plane", "plane in flight, 3/4 from behind-right; island + Ripe Peak behind"),
  "wip-plane-flight-ramp": cam(flightFullM, [7, -2.5, 24], [0, 2.5, 8], 40, "plane"),
  "wip-plane-flight-engine": cam(flightFullM, [14, 3, -16], [ENG_X, ENG_Y, ENG_Z], 38, "plane"),
  "wip-plane-flight-tail": cam(flightFullM, [9, 6, 26], [0, 8, 12], 40, "plane"),
  // the camera stands in the aisle 5 m short of the ramp hinge, low, looking aft
  // through the big lit open ramp at the island (target art), three harnessed kongs down each wall in frame
  "drop-02-plane-interior": cam(cabinM, [-0.25, FLOOR_Y + 1.12, -2.3], [0.15, FLOOR_Y + 0.55, 10.5], 72, "plane-cabin", "cargo bay looking aft through the open ramp"),
  "wip-plane-cabin-wide": cam(cabinM, [0, FLOOR_Y + 1.6, -8.4], [0, FLOOR_Y + 0.9, 4], 80, "plane-cabin"),
  "wip-plane-cabin-side": cam(cabinM, [1.2, FLOOR_Y + 1.3, -1.0], [-1.6, FLOOR_Y + 0.9, -3.6], 60, "plane-cabin"),
  "wip-plane-front": cam(parkM, [-14, 4.5, -30], [0, 4, -2], 45, "wip-plane"),
  "wip-plane-side": cam(parkM, [36, 4.5, 0], [0, 4.2, 0], 50, "wip-plane"),
  "wip-plane-rear-ramp": cam(parkM, [5, 4, 30], [0, 3, 6], 45, "wip-plane"),
  "wip-plane-tail": cam(parkM, [12, 8, 22], [0, 8, 11.5], 42, "wip-plane"),
  "wip-plane-parked": cam(parkM, [-26, 7, 22], [0, 3.5, 0], 50, "wip-plane"),
  "wip-plane-nose": cam(parkM, [7, 4.6, -20], [0, 4, -12], 38, "wip-plane"),
};

const staged = new Map<string, PlaneProps>();
export async function stage(ctx: WorldCtx, id: string): Promise<void> {
  if (id !== "plane" && id !== "wip-plane" && id !== "plane-cabin") return;
  if (staged.has(id)) return;
  const p = await createPlane(ctx);
  staged.set(id, p);
  if (id === "plane") {
    flightFullM.decompose(p.object.position, p.object.quaternion, p.object.scale);
    // stills show blurred prop DISCS too (the target art's props read as motion blur, not stopped blades)
    p.setGear(0); p.setRamp(0.6); p.setEngines(true);
  } else if (id === "plane-cabin") {
    cabinM.decompose(p.object.position, p.object.quaternion, p.object.scale);
    p.setGear(0); p.setRamp(1); p.setEngines(true);
    // the target art's cargo door is the whole rear section (ramp down, upper door up): clip the tail-cone skin + lining aft
    // of the portal frame so the camera sees sky + island through a big lit opening
    ctx.renderer.localClippingEnabled = true;
    p.object.updateMatrixWorld(true);
    const n = new THREE.Vector3(0, 0, -1).transformDirection(p.object.matrixWorld), o = new THREE.Vector3(0, 0, Z_UP + 0.35).applyMatrix4(p.object.matrixWorld);
    const clip = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
    p.object.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh || (m.name !== "fuselage" && m.name !== "cargo-lining" && m.name !== "bay-frames")) return;
      const mm = (m.material as THREE.Material).clone();          // the ramp shares the paint: clip a private copy
      mm.clippingPlanes = [clip]; mm.clipShadows = false;
      m.material = mm;
    });
  } else {
    p.object.position.copy(PARK.pos);
    p.object.rotation.set(0, PARK.yaw, 0, "YXZ");
    p.setGear(1); p.setRamp(1); p.setEngines(false);
  }
  ctx.scene.add(p.object);
  p.update(0, 12);
  ctx.onUpdate((dt, t) => p.update(dt, t));
}
