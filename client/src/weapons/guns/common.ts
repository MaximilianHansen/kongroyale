// Shared banana-gun vocabulary. Gun local space: -Z forward (muzzle), +Y up, +X right, origin = top of the grip
// (where the trigger hand sits). All parts are authored in metres.
import * as THREE from "three";
import { alignY, bananaAt, bananaEnd, bananaGeometry, disc, extrudeSmooth, filletCyl, gridGeometry, lathe, polarAt, rbox, ringGeo, rope, roundedPolyPolar, smooth, tf, type BananaOpts, type V3 } from "../lib/geo";
import { PartBuilder } from "../lib/builder";
import { C, type Kind } from "../lib/mats";

export const FWD = new THREE.Vector3(0, 0, -1);
export const UP = new THREE.Vector3(0, 1, 0);
export const RIGHT = new THREE.Vector3(1, 0, 0);
const v3 = (a: V3 | THREE.Vector3) => (a instanceof THREE.Vector3 ? a.clone() : new THREE.Vector3(...a));

/** +X-authored banana → gun frame (stem at `at`, running forward along -Z); returns end info in gun frame */
export function bananaBody(b: PartBuilder, o: BananaOpts & { at: V3; kind?: "gloss"; gradient?: [string, string]; roll?: number; pitch?: number }) {
  // crisp facet ridges on every skin — the rounding is capped so the five faces
  // read as the target art's cel-shaded planes (the glint lays its highlight band along each ridge)
  o = { ...o, round: Math.min(o.round ?? 0.42, 0.2) };
  const g = bananaGeometry(o);
  const m = new THREE.Matrix4().makeTranslation(...o.at)
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
    .multiply(new THREE.Matrix4().makeRotationZ(o.pitch ?? 0))
    .multiply(new THREE.Matrix4().makeRotationX(o.roll ?? 0));
  const [c0, c1] = o.gradient ?? [C.bananaDeep, C.banana];
  b.addGradient(g, c0, c1, "y", "gloss", m);
  const tip = bananaEnd(o, true), stem = bananaEnd(o, false);
  const toGun = (e: { center: THREE.Vector3; dir: THREE.Vector3; radius: number }) => ({
    center: e.center.clone().applyMatrix4(m), dir: e.dir.clone().transformDirection(m), radius: e.radius,
  });
  /** centre-line frame at t in gun space (dir = toward the tip) */
  const at = (t: number) => toGun(bananaAt(o, t));
  /** full section frame at t: centre, tangent, section N (the flat top face normal) / B (side), radius */
  const frame = (t: number) => {
    const bend = o.bend ?? 0.55, a = -bend / 2 + bend * t;
    const e = at(t);
    return { ...e, N: new THREE.Vector3(-Math.sin(a), Math.cos(a), 0).transformDirection(m), B: new THREE.Vector3(0, 0, 1).transformDirection(m) };
  };
  return { tip: toGun(tip), stem: toGun(stem), m, at, frame, opts: o };
}

// ------------------------------------------------------------------------------------------------ iron sights
// every iron sight is a REAL sight line: the front sight's aim point F, a rear sight
// on the line from F that clears every part of the gun behind it, ADS lays that line on the view axis (viewmodel.ts)

/** slope (dy per +z) of the lowest line from F back over every vertex of `built` behind it (z > F.z + zSkip) within
 *  |x| < halfW, `margin` above them — the rear sight sits on F + slope·(z − F.z) */
export function clearSlope(built: { root: THREE.Object3D }, F: THREE.Vector3, halfW: number, margin: number, zSkip = 0.03, zMax = Infinity): number {
  let slope = -Infinity;
  const v = new THREE.Vector3();
  built.root.updateMatrixWorld(true);
  built.root.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (Math.abs(v.x) > halfW || v.z < F.z + zSkip || v.z > zMax) continue;
      slope = Math.max(slope, (v.y + margin - F.y) / (v.z - F.z));
    }
  });
  return Number.isFinite(slope) ? slope : 0;
}

/** a hooded front sight facing down the bore: a ring (hole along Z) on its post, a blade rising inside it whose tip is
 *  the aim point F (with a bright fibre dot), the ring centred on F */
export function frontHood(b: PartBuilder, F: THREE.Vector3, R: number, tube: number, postBottomY: number, color = C.brown) {
  b.add(new THREE.TorusGeometry(R, tube, 12, 36), color, "matte", tf([F.x, F.y, F.z]));
  // hood post under the ring (down to the gun) + the inner blade up to the aim point
  const h0 = F.y - R - tube * 0.5, pl = Math.max(0.004, h0 - postBottomY);
  b.add(rbox(tube * 2.2, pl, tube * 2.6, tube * 0.6, 2), color, "matte", tf([F.x, postBottomY + pl / 2, F.z]));
  const bl = R - 0.0015;
  b.add(rbox(tube * 0.9, bl, tube * 1.4, tube * 0.3, 1), C.brownDark, "matte", tf([F.x, F.y - R + bl / 2, F.z]));
  sightDot(b, new THREE.Vector3(F.x, F.y - tube * 0.15, F.z), tube * 0.75);
}
/** a rear ghost ring (peep) centred on the sight line at R, two uprights down to `baseY` */
export function rearPeep(b: PartBuilder, R: THREE.Vector3, ringR: number, tube: number, baseY: number, color = C.brownDark) {
  b.add(new THREE.TorusGeometry(ringR, tube, 10, 40), color, "matte", tf([R.x, R.y, R.z]));
  const h = Math.max(0.008, R.y - baseY);
  for (const sx of [1, -1]) b.add(rbox(tube * 2, h, tube * 2.6, tube * 0.6, 1), C.brown, "matte", tf([R.x + sx * ringR * 0.8, baseY + h / 2 - tube, R.z]));
}
/** a rear notch (two ears either side of the line, their tops level with it) at R, on a block down to `baseY` */
export function rearNotch(b: PartBuilder, R: THREE.Vector3, gap: number, earW: number, baseY: number, depth = 0.012, color = C.brown) {
  const h = Math.max(0.006, R.y - baseY);
  b.add(rbox(gap + earW * 2, Math.max(0.004, h - 0.008), depth, 0.002, 1), color, "matte", tf([R.x, baseY + (h - 0.008) / 2, R.z]));
  for (const sx of [1, -1]) b.add(rbox(earW, 0.01, depth, 0.0015, 1), color, "matte", tf([R.x + sx * (gap / 2 + earW / 2), R.y - 0.005, R.z]));
  // a fibre dot on each ear (the classic three-dot sight picture with the front dot between them)
  for (const sx of [1, -1]) sightDot(b, new THREE.Vector3(R.x + sx * (gap / 2 + earW / 2), R.y - 0.0035, R.z + depth / 2 + 0.0004), earW * 0.28, C.white);
}
/** a small bright sight dot (unlit, never toned down: a fibre-optic pip that reads against sky and jungle) */
export function sightDot(b: PartBuilder, at: THREE.Vector3, r: number, color = "#e6ff3a") {
  b.add(new THREE.SphereGeometry(r, 12, 8), color, "emissive", tf([at.x, at.y, at.z]));
}

/** a band (strap, collar, ring) that hugs a FACETED banana section: the rounded-polygon section of `body` at t,
 *  grown by `thick`, `width` long along the banana. Author-frame-safe: returns nothing, adds to b. */
export function facetBand(b: PartBuilder, body: ReturnType<typeof bananaBody>, t: number, width: number, thick: number, color: string, kind: Kind = "matte", grow = 0.001) {
  const o = body.opts;
  const f = body.frame(t);
  const tab = roundedPolyPolar(o.facets ?? 5, o.round ?? 0.42);
  const sq = o.squash ?? 1;
  // rounded-rect profile in (radial offset s, axial a): inner face → outer face with fillets
  const r = Math.min(thick, width) * 0.35;
  const prof: Array<[number, number]> = [];
  const push = (s: number, a: number) => prof.push([s, a]);
  push(-0.002, -width / 2);
  for (let k = 0; k <= 4; k++) { const an = (k / 4) * Math.PI / 2; push(grow + thick - r + r * Math.sin(an), -width / 2 + r - r * Math.cos(an)); }
  for (let k = 0; k <= 4; k++) { const an = (k / 4) * Math.PI / 2; push(grow + thick - r + r * Math.cos(an), width / 2 - r + r * Math.sin(an)); }
  push(-0.002, width / 2);
  const radial = 56;
  const g = gridGeometry(prof.length, radial, (i, j, out) => {
    const th = (j / radial) * Math.PI * 2;
    const [s, a] = prof[i];
    const rr = f.radius * polarAt(tab, th) + s;
    out.copy(f.center).addScaledVector(f.dir, a).addScaledVector(f.N, rr * Math.cos(th)).addScaledVector(f.B, rr * Math.sin(th) * sq);
  }, true);
  // profile runs inner→outer→inner along +axial: rows = profile, cols = around. Fix winding if needed.
  b.add(g, color, kind);
  return f;
}

/** green banana stem: thick at the peel, tapering, with a slight flare and a brown cut face; bends upward */
export function stemCap(b: PartBuilder, center: THREE.Vector3, dir: THREE.Vector3, r: number, len = r * 1.6, tilt = 0.35) {
  const d = dir.clone().normalize();
  const dd = d.clone().addScaledVector(UP, tilt).normalize();
  // profile along the stem (radius fraction of r) — fat collar, neck, flared cut
  const prof: Array<[number, number]> = [[0, 0], [0.86, 0], [0.8, 0.12], [0.66, 0.3], [0.56, 0.55], [0.54, 0.75], [0.6, 0.92], [0.58, 1], [0, 1]];
  const g = lathe(prof.map(([rr, u]) => [rr * r, u * len]), 20);
  b.addGradient(g, C.limeDark, C.lime, "y", "gloss", alignY(center.clone().addScaledVector(dd, -r * 0.05), dd));
  b.add(disc(r * 0.5, r * 0.08, r * 0.02, 18), C.brownDark, "matte", alignY(center.clone().addScaledVector(dd, len * 0.985), dd));
  // peel collar ridge where the stem leaves the skin
  b.add(ringGeo(r * 0.98, r * 0.8, r * 0.14, r * 0.03, 22), C.bananaDeep, "gloss", alignY(center.clone().addScaledVector(dd, r * 0.02), dd));
}

/** cream slice face inside a brown ring at a cut banana end: cream disc + a seed "star" built from thin geometry
 *  (crisp at any distance, no texture) + three seed dots + a darker inner peel ring */
export function muzzleDisc(b: PartBuilder, center: THREE.Vector3, dir: THREE.Vector3, r: number, ringColor = C.brown, ringDepth = r * 0.5, sliceInset = 0.04) {
  const d = dir.clone().normalize();
  const cr = center.clone().addScaledVector(d, ringDepth * 0.5 - r * 0.05);
  b.add(ringGeo(r * 1.06, r * 0.8, ringDepth, r * 0.08, 28), ringColor, "matte", alignY(cr, d));
  const faceZ = ringDepth - r * 0.05 - r * sliceInset;
  const cs = center.clone().addScaledVector(d, faceZ - r * 0.05);
  sliceDisc(b, cs, d, r * 0.82, r * 0.1);
}

/** a textured banana-slice disc (mats().slice: cream flesh + small seed star) facing `dir` at `c` */
export function sliceDisc(b: PartBuilder, c: THREE.Vector3, dir: THREE.Vector3, r: number, thick: number) {
  const g = filletCyl(r, thick, Math.min(thick * 0.45, r * 0.08), 40);
  const p = g.attributes.position as THREE.BufferAttribute, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / (2 * r) + 0.5; uv[i * 2 + 1] = -p.getZ(i) / (2 * r) + 0.5; }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  b.add(g, C.flesh, "slice", alignY(c, dir));
}

/** open bore: a brown ring with a dark hole */
export function bore(b: PartBuilder, center: THREE.Vector3, dir: THREE.Vector3, r: number, depth = r * 0.7) {
  const d = dir.clone().normalize();
  b.add(ringGeo(r, r * 0.66, depth, r * 0.1, 24), C.brown, "matte", alignY(center.clone().addScaledVector(d, depth * 0.5 - r * 0.05), d));
  const hole = disc(r * 0.67, r * 0.05, 0, 24);
  b.add(hole, "#1a0e07", "matte", alignY(center.clone().addScaledVector(d, depth * 0.1), d));
  const inner = ringGeo(r * 0.68, r * 0.6, depth * 0.9, 0, 24);
  b.add(inner, "#2a1609", "matte", alignY(center.clone().addScaledVector(d, depth * 0.5), d));
}

/** slot-head screw: metal dome with a dark slot */
export function screw(b: PartBuilder, pos: V3 | THREE.Vector3, dir: V3 | THREE.Vector3, r = 0.006, angle = 0.4) {
  const p = v3(pos), d = v3(dir).normalize();
  b.add(filletCyl(r, r * 0.5, r * 0.35, 14), C.steel, "metal", alignY(p, d));
  const slot = new THREE.BoxGeometry(r * 1.5, r * 0.3, r * 0.28);
  slot.translate(0, r * 0.3, 0);
  b.add(slot, "#2b2b2e", "matte", alignY(p, d, 1, angle));
}

/** round leather rivet (domed brown with a darker rim) */
export function rivet(b: PartBuilder, pos: V3 | THREE.Vector3, dir: V3 | THREE.Vector3, r = 0.007) {
  const p = v3(pos), d = v3(dir).normalize();
  b.add(filletCyl(r, r * 0.6, r * 0.5, 12), C.brownDark, "matte", alignY(p.clone().addScaledVector(d, r * 0.1), d));
  b.add(new THREE.SphereGeometry(r * 0.55, 10, 8), C.brownLight, "gloss", tf(p.clone().addScaledVector(d, r * 0.45).toArray() as V3));
}

/** leather strap wrapped around a tube of radius r (axis `dir` through `center`); rivets at ±x */
export function strap(b: PartBuilder, center: V3 | THREE.Vector3, dir: V3 | THREE.Vector3, r: number, width = 0.03, thick = 0.006, color = C.brown, rivets = true, buckle = false) {
  const c = v3(center), d = v3(dir).normalize();
  b.add(ringGeo(r + thick, r - 0.002, width, thick * 0.45, 32), color, "matte", alignY(c, d));
  // stitched edge lines (two thin darker rings)
  b.add(ringGeo(r + thick + 0.0006, r + thick - 0.0015, width * 0.06, 0, 32), C.brownDark, "matte", alignY(c.clone().addScaledVector(d, width * 0.38), d));
  b.add(ringGeo(r + thick + 0.0006, r + thick - 0.0015, width * 0.06, 0, 32), C.brownDark, "matte", alignY(c.clone().addScaledVector(d, -width * 0.38), d));
  if (rivets) {
    const side = new THREE.Vector3().crossVectors(d, UP).normalize();
    if (side.lengthSq() < 0.1) side.set(1, 0, 0);
    rivet(b, c.clone().addScaledVector(side, r + thick), side, width * 0.22);
    rivet(b, c.clone().addScaledVector(side, -(r + thick)), side.clone().negate(), width * 0.22);
  }
  if (buckle) {
    b.add(rbox(width * 1.2, thick * 2.2, width * 0.9, thick * 0.6, 2), C.brownLight, "matte", tf(c.clone().addScaledVector(UP, r + thick * 0.8).toArray() as V3));
  }
}

/** rope lashing: n turns of rope around a tube (axis dir through center) */
export function ropeWrap(b: PartBuilder, center: V3 | THREE.Vector3, dir: V3 | THREE.Vector3, r: number, turns = 3, ropeR = 0.0055, color = C.rope, pitchGap = 1.05, phase = 0) {
  const c = v3(center), d = v3(dir).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d);
  const pts: THREE.Vector3[] = [];
  const pitch = ropeR * 2 * pitchGap;
  const N = Math.round(turns * 20);
  for (let i = 0; i <= N; i++) {
    const t = i / N, a = t * turns * Math.PI * 2 + phase;
    const y = (t - 0.5) * turns * pitch;
    pts.push(new THREE.Vector3(Math.cos(a) * (r + ropeR * 0.85), y, Math.sin(a) * (r + ropeR * 0.85)).applyQuaternion(q).add(c));
  }
  b.add(rope(pts, ropeR, false, ropeR * 6, 8, N), color, "rope");
  // end knot: a small bulge
  const kp = pts[pts.length - 1].clone();
  b.add(new THREE.SphereGeometry(ropeR * 1.35, 10, 8), color, "rope", tf(kp.toArray() as V3));
}

/** ribbed cream "banana flesh" grip: a tapered lathe with soft segment bulges, brown backstrap, lime base cap.
 *  top at `top`, pointing down along `dir` (unit), length len, radius r. */
export function fleshGrip(b: PartBuilder, top: V3 | THREE.Vector3, dir: V3 | THREE.Vector3, len: number, r: number, o: { ribs?: number; back?: boolean; cap?: boolean; topBand?: boolean; taper?: number; color?: string; capColor?: string; flat?: number } = {}) {
  const { ribs = 5, back = true, cap = true, topBand = false, taper = 0.85, color = C.cream, capColor = C.lime, flat = 0.78 } = o;
  const t = v3(top), d = v3(dir).normalize();
  const pts: Array<[number, number]> = [];
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const u = i / N; // 0 top → 1 bottom
    const base = r * (1 - (1 - taper) * u);
    const rib = 1 + 0.045 * Math.pow(0.5 - 0.5 * Math.cos(u * ribs * Math.PI * 2), 0.9) - 0.02;
    const end = u < 0.04 ? Math.sin((u / 0.04) * Math.PI / 2) : u > 0.96 ? Math.sin(((1 - u) / 0.04) * Math.PI / 2) : 1;
    pts.push([base * rib * Math.sqrt(Math.max(end, 0.02)), u * len]);
  }
  pts.unshift([0, 0]); pts.push([0, len]);
  let g = lathe(pts, 22);
  g.scale(1, 1, flat);
  b.add(g, color, "gloss", alignY(t, d));
  // segment lines: thin darker rings between ribs
  for (let k = 1; k < ribs; k++) {
    const u = k / ribs, rr = r * (1 - (1 - taper) * u) * 0.985;
    const gg = ringGeo(rr + 0.0004, rr - 0.003, 0.0016, 0, 22); gg.scale(1, 1, flat);
    b.add(gg, C.creamDeep, "matte", alignY(t.clone().addScaledVector(d, u * len), d));
  }
  if (back) {
    // brown backstrap running down the rear of the grip
    const back = new THREE.Vector3(0, 0, 1).projectOnPlane(d).normalize();
    const bsLen = len * 0.92;
    const bs = rbox(r * 0.9, bsLen, r * 0.42, r * 0.16, 2);
    b.add(bs, C.brown, "matte", alignY(t.clone().addScaledVector(d, len * 0.5).addScaledVector(back, r * flat * 0.86), d, 1));
    screw(b, t.clone().addScaledVector(d, len * 0.78).addScaledVector(back, r * flat * 1.08), back, r * 0.16);
  }
  if (topBand) b.add(ringGeo(r * 1.06, r * 0.9, len * 0.07, r * 0.02, 22).scale(1, 1, flat), C.banana, "gloss", alignY(t.clone().addScaledVector(d, len * 0.035), d));
  if (cap) {
    const cg = filletCyl(r * taper * 1.05, len * 0.09, r * 0.06, 22); cg.scale(1, 1, flat);
    b.add(cg, capColor, "gloss", alignY(t.clone().addScaledVector(d, len * 0.995), d));
    b.add(ringGeo(r * taper * 1.06, r * taper * 0.9, len * 0.02, 0, 22).scale(1, 1, flat), C.banana, "gloss", alignY(t.clone().addScaledVector(d, len * 0.945), d));
  }
}


/** brown trigger guard (D-ring, extruded in X) + curved trigger. `at` = top-front of the guard, hanging down. */
export function triggerGuard(b: PartBuilder, at: V3 | THREE.Vector3, len = 0.075, drop = 0.045, thick = 0.007, width = 0.016) {
  const a = v3(at);
  // profile in (z, y): front top → rounded loop → rear top
  const outer: Array<[number, number]> = [[0, 0], [-len * 0.15, -drop * 0.55], [-len * 0.45, -drop], [-len * 0.85, -drop * 0.7], [-len, -drop * 0.1], [-len, 0.004], [-len + thick, 0.004], [-len + thick, -drop * 0.15], [-len * 0.82, -drop + thick], [-len * 0.45, -drop + thick], [-len * 0.2, -drop * 0.5], [-thick * 0.6, 0.004]];
  const g = extrudeSmooth(outer.map(([z, y]) => [z, y]), width, thick * 0.35, 40, 2);
  g.rotateY(Math.PI / 2); // profile authored in (x=z,y) → rotate so it lies in the gun's z/y plane
  b.add(smooth(g, 50), C.brown, "matte", tf(a.toArray() as V3));
  // trigger: a curved blade inside the loop
  const tg = rbox(width * 0.5, drop * 0.55, thick * 1.2, thick * 0.4, 2);
  b.add(tg, C.brownDark, "matte", tf([a.x, a.y - drop * 0.34, a.z - len * 0.36], [0.35, 0, 0]));
}

/** brown metal receiver block with a bevel — a workhorse for frames, rails and mounts */
export function block(b: PartBuilder, center: V3 | THREE.Vector3, size: V3, color: string = C.brown, kind: Kind = "matte", rot: V3 = [0, 0, 0], bevel = 0.004) {
  b.add(rbox(size[0], size[1], size[2], bevel, 2), color, kind, tf(v3(center).toArray() as V3, rot));
}

/** cylinder along an axis with filleted rims */
export function tube(b: PartBuilder, center: V3 | THREE.Vector3, dir: V3 | THREE.Vector3, r: number, len: number, color: string, kind: Kind = "gloss", fillet = r * 0.12, seg = 24, rTop = r, rBot = r) {
  b.add(filletCyl(r, len, fillet, seg, rTop, rBot), color, kind, alignY(v3(center), v3(dir)));
}

/** a bunch of bananas radiating around an axis (drum magazines, launcher nose) */
export function bananaBunch(b: PartBuilder, center: V3 | THREE.Vector3, axis: V3 | THREE.Vector3, count: number, ringR: number, o: { length?: number; radius?: number; bend?: number; splay?: number; stems?: boolean; phase?: number; tipsOut?: boolean; gradient?: [string, string] } = {}) {
  const { length = 0.16, radius = 0.028, bend = 0.7, splay = 0.25, stems = true, phase = 0, tipsOut = true, gradient } = o;
  const c = v3(center), ax = v3(axis).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, ax);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + phase;
    const radial = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).applyQuaternion(q);
    const base = c.clone().addScaledVector(radial, ringR);
    const g = bananaGeometry({ length, radius, bend, along: 30, radial: 20 });
    // banana authored along +X, ridge up (+Y) → put its axis along `ax`, with its belly (−Y) facing inward
    const m = new THREE.Matrix4().compose(base, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    // build orthonormal frame: X' = ax (tilted outward by splay), Y' = radial (belly inward = −Y' → curl outward)
    const xp = ax.clone().addScaledVector(radial, splay).normalize();
    const yp = radial.clone().negate().projectOnPlane(xp).normalize();
    const zp = new THREE.Vector3().crossVectors(xp, yp);
    const rot = new THREE.Matrix4().makeBasis(xp, yp, zp);
    m.multiply(rot);
    if (!tipsOut) m.multiply(new THREE.Matrix4().makeTranslation(-length, 0, 0));
    const [c0, c1] = gradient ?? [C.bananaDeep, C.banana];
    b.addGradient(g, c0, c1, "y", "gloss", m);
    if (stems) {
      const e = bananaEnd({ length, radius, bend }, false);
      const cen = e.center.clone().applyMatrix4(m), dir = e.dir.clone().transformDirection(m);
      b.add(filletCyl(radius * 0.4, radius * 0.9, radius * 0.08, 12, radius * 0.33, radius * 0.42), C.brownDark, "matte", alignY(cen.addScaledVector(dir, radius * 0.4), dir));
    }
    const t = bananaEnd({ length, radius, bend }, true);
    const tc = t.center.clone().applyMatrix4(m);
    b.add(new THREE.SphereGeometry(radius * 0.22, 8, 6), C.brownDark, "matte", tf(tc.toArray() as V3));
  }
}




/** two-point rope loop (e.g. sling ring): tiny torus */
export function ringLoop(b: PartBuilder, at: V3 | THREE.Vector3, r = 0.012, t = 0.003, rot: V3 = [0, 0, 0]) {
  b.add(new THREE.TorusGeometry(r, t, 8, 20), C.brown, "matte", tf(v3(at).toArray() as V3, rot));
}


// ------------------------------------------------------------------------------------------------------------------
// Target-art tracing (gear-03-weapons, 2880²): every gun is authored from pixel coordinates read off the target art.

/** art px → gun space. (X0, Y0) = art px of the gun origin (top of the grip), K = metres per art px,
 *  cz = cos of the target art's yaw (its horizontal foreshortening is undone), alpha = the target art's muzzle-up tilt
 *  (removed here; the stage pose re-applies it as pitch so the bore is level in gun space) */
export function tracer(X0: number, Y0: number, K: number, cz = 1, alpha = 0) {
  const KZ = K / cz, ca = Math.cos(alpha), sa = Math.sin(alpha);
  const rp = (x: number, y: number, xOff = 0): THREE.Vector3 => {
    const dx = x - X0, dy = y - Y0;
    const fwd = -dx * ca - dy * sa, up = dx * sa - dy * ca;
    return new THREE.Vector3(xOff, up * K, -fwd * KZ);
  };
  const p2 = (pts: Array<[number, number]>) => pts.map(([x, y]) => { const v = rp(x, y); return [-v.z, v.y] as [number, number]; });
  /** extrude a traced side outline `w` wide (X), bevel `bv`; `sharp` keeps corners (polygon) instead of a spline */
  const side = (pts: Array<[number, number]>, w: number, bv: number, sharp = false, holes: Array<Array<[number, number]>> = []) => {
    let g: THREE.BufferGeometry;
    if (sharp) {
      const s = new THREE.Shape(p2(pts).map(([a, c]) => new THREE.Vector2(a, c)));
      for (const h of holes) s.holes.push(new THREE.Path(p2(h).map(([a, c]) => new THREE.Vector2(a, c))));
      g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.0005, w - 2 * bv), bevelEnabled: bv > 0, bevelThickness: bv, bevelSize: bv, bevelSegments: 3, curveSegments: 6 });
      g.translate(0, 0, -(w - 2 * bv) / 2);
    } else g = extrudeSmooth(p2(pts), w, bv, 72, 3, holes.map(p2));
    g.rotateY(Math.PI / 2);
    return smooth(g, sharp ? 40 : 62);
  };
  return { rp, side, K, KZ };
}

/** scale X of every vertex by a factor interpolated along Z (z0 → s0, z1 → s1): tapers extruded side profiles */
export function taperX(g: THREE.BufferGeometry, z0: number, z1: number, s0: number, s1: number, y0?: number, y1?: number, sy0 = 1, sy1 = 1) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const f = Math.min(1, Math.max(0, (p.getZ(i) - z0) / (z1 - z0)));
    let s = s0 + (s1 - s0) * f;
    if (y0 !== undefined && y1 !== undefined) { const fy = Math.min(1, Math.max(0, (p.getY(i) - y0) / (y1 - y0))); s *= sy0 + (sy1 - sy0) * fy; }
    p.setX(i, p.getX(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

/** a band (strap / collar) hugging a BUNDLE of tubes along Z: `circles` = [x, y, r] sections at z; the band follows
 *  their convex hull, `thick` proud, `width` along Z. Rounded edges. */
export function hullBand(b: PartBuilder, circles: Array<[number, number, number]>, z: number, width: number, thick: number, color: string, kind: Kind = "matte", samples = 96) {
  const hull = (grow: number): THREE.Vector2[] => {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * Math.PI * 2, ux = Math.cos(a), uy = Math.sin(a);
      let best = -1e9, bx = 0, by = 0;
      for (const [cx, cy, r] of circles) { const s = cx * ux + cy * uy + r; if (s > best) { best = s; bx = cx; by = cy; } }
      const r = circles.find(([cx, cy]) => cx === bx && cy === by)![2];
      out.push(new THREE.Vector2(bx + ux * (r + grow), by + uy * (r + grow)));
    }
    return out;
  };
  // rows = rounded-rect profile (radial offset, axial), cols = around the hull
  const rr = Math.min(thick, width) * 0.4;
  const prof: Array<[number, number]> = [[-0.003, -width / 2]];
  for (let k = 0; k <= 4; k++) { const an = (k / 4) * Math.PI / 2; prof.push([thick - rr + rr * Math.sin(an), -width / 2 + rr - rr * Math.cos(an)]); }
  for (let k = 0; k <= 4; k++) { const an = (k / 4) * Math.PI / 2; prof.push([thick - rr + rr * Math.cos(an), width / 2 - rr + rr * Math.sin(an)]); }
  prof.push([-0.003, width / 2]);
  const base = hull(0), n = base.length;
  // outward normals of the hull (averaged neighbours)
  const nrm = base.map((p, i) => { const a = base[(i + n - 1) % n], c = base[(i + 1) % n]; return new THREE.Vector2(c.y - a.y, -(c.x - a.x)).normalize(); });
  const g = gridGeometry(prof.length, n, (i, j, out) => {
    const [s, a] = prof[i];
    out.set(base[j].x + nrm[j].x * s, base[j].y + nrm[j].y * s, z + a);
  }, true);
  // winding: columns run counter-clockwise (seen from +Z), rows along +Z → (around × axial) points outward
  b.add(g, color, kind);
}

/** a rope lashing that HUGS a bundle of parallel tubes (circles [x, y, r] in the gun's XY section at axial `z`):
 *  `turns` helical turns round the bundle's convex hull (+ the rope radius), advancing along +Z; a knot at the end */
export function hullRope(b: PartBuilder, circles: Array<[number, number, number]>, z: number, turns = 3, ropeR = 0.0052, color = C.rope, gap = 1.1) {
  const S = 48, pitch = ropeR * 2 * gap, pts: THREE.Vector3[] = [];
  const N = Math.round(turns * S);
  for (let i = 0; i <= N; i++) {
    const a = (i / S) * Math.PI * 2, ux = Math.cos(a), uy = Math.sin(a);
    let best = -1e9, bx = 0, by = 0, br = 0;
    for (const [cx, cy, r] of circles) { const sc = cx * ux + cy * uy + r; if (sc > best) { best = sc; bx = cx; by = cy; br = r; } }
    const g = br + ropeR * 0.8;
    pts.push(new THREE.Vector3(bx + ux * g, by + uy * g, z + (i / N - 0.5) * turns * pitch));
  }
  b.add(rope(pts, ropeR, false, ropeR * 6, 8, N * 2), color, "rope");
  b.add(new THREE.SphereGeometry(ropeR * 1.4, 10, 8), color, "rope", tf(pts[pts.length - 1].toArray() as V3));
}

/** sweep a rounded (superellipse) section along a curve in the gun's YZ plane; section size / scale per u ∈ [u0,u1].
 *  depth = extent along the curve normal (front/back), width = along X. Returns the geometry (not added). */
export function sweepYZ(curve: THREE.Curve<THREE.Vector3>, u0: number, u1: number, depth: (u: number) => number, width: (u: number) => number, o: { along?: number; radial?: number; exp?: number; closeEnds?: boolean } = {}) {
  const { along = 40, radial = 36, exp = 2.4, closeEnds = false } = o;
  const P = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), X = new THREE.Vector3(1, 0, 0);
  const g = gridGeometry(along + 1, radial, (i, j, out) => {
    const f = i / along, u = u0 + (u1 - u0) * f;
    curve.getPointAt(u, P); curve.getTangentAt(u, T);
    N.crossVectors(X, T).normalize();
    const th = (j / radial) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
    const e = 2 / exp;
    const sc = closeEnds ? Math.sqrt(Math.max(0.0004, Math.sin(Math.min(1, Math.min(f, 1 - f) / 0.06) * Math.PI / 2))) : 1;
    out.copy(P).addScaledVector(N, (depth(u) / 2) * Math.sign(c) * Math.pow(Math.abs(c), e) * sc).addScaledVector(X, (width(u) / 2) * Math.sign(s) * Math.pow(Math.abs(s), e) * sc);
  }, true);
  return g;
}

/** chunky swept grip (banana-flesh style): body with `ribs` soft bulges + darker groove rings, optional top/bottom
 *  bands and an end cap. pts = centre line top → bottom (gun space). */
export function curvedGrip(b: PartBuilder, pts: THREE.Vector3[], o: { depth: number; width: number; taper?: number; ribs?: number; ribU?: [number, number]; body?: string; groove?: string;
  bands?: Array<{ u0: number; u1: number; color: string; grow?: number; kind?: Kind }>; cap?: { u0: number; color: string; kind?: Kind } }) {
  const { depth, width, taper = 0.9, ribs = 6, ribU = [0.12, 0.84], body = C.cream, groove = C.creamDeep, bands = [], cap } = o;
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.5);
  const tap = (u: number) => 1 - (1 - taper) * u;
  const rib = (u: number) => {
    if (u < ribU[0] || u > ribU[1]) return 1;
    const f = (u - ribU[0]) / (ribU[1] - ribU[0]);
    return 1 + 0.05 * Math.pow(Math.sin(f * ribs * Math.PI), 2) - 0.02;
  };
  const end = cap ? cap.u0 + 0.01 : 1;
  b.add(sweepYZ(curve, 0, end, (u) => depth * tap(u) * rib(u), (u) => width * tap(u) * rib(u), { along: 90, radial: 40 }), body, "gloss");
  // groove rings in the valleys between ribs (a hair proud of the valley so they read as painted lines)
  for (let k = 1; k < ribs; k++) {
    const u = ribU[0] + ((ribU[1] - ribU[0]) * k) / ribs;
    const w = 0.012;
    b.add(sweepYZ(curve, u - w / 2, u + w / 2, (uu) => depth * tap(uu) * 0.985, (uu) => width * tap(uu) * 0.985, { along: 2, radial: 40 }), groove, "matte");
  }
  for (const bd of bands) {
    const gr = bd.grow ?? 1.07;
    b.add(sweepYZ(curve, bd.u0, bd.u1, (u) => depth * tap(u) * gr, (u) => width * tap(u) * gr, { along: 12, radial: 40, closeEnds: true }), bd.color, bd.kind ?? "gloss");
  }
  if (cap) {
    b.add(sweepYZ(curve, cap.u0, 1, (u) => depth * tap(u) * 1.04, (u) => width * tap(u) * 1.04, { along: 14, radial: 40, closeEnds: true }), cap.color, cap.kind ?? "gloss");
  }
  return curve;
}

/** rarity accent: a small faceted gem (vertex white, kind "emissive") in the `accent` pivot + a brown bezel on the
 *  parent, on the flank at `pos` facing `n`. Call once per flank with the same sub-builder. */
export function accentGem(b: PartBuilder, acc: PartBuilder, pos: V3 | THREE.Vector3, n: V3 | THREE.Vector3, size = 0.012, up: V3 | THREE.Vector3 = [0, 1, 0]) {
  const p = v3(pos), d = v3(n).normalize();
  b.add(filletCyl(size * 1.45, size * 0.5, size * 0.2, 6), C.brownDark, "matte", alignY(p, d, 1, Math.PI / 6));
  const gem = new THREE.OctahedronGeometry(size, 0);
  gem.scale(1, 0.55, 1.25);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d);
  const upv = v3(up).applyQuaternion(q.clone().invert());
  const m = new THREE.Matrix4().compose(p.clone().addScaledVector(d, size * 0.32), q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(upv.x, upv.z))), new THREE.Vector3(1, 1, 1));
  acc.add(gem, C.white, "emissive", m);
}


