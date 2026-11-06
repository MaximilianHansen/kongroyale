// THE GREAT MANGROVE (hero landmark) + every root / limb / log / tangle of the layout. The hollow trunk is drawn from
// the same numbers the colliders use (gmRadius / gmOpen / gmSpiral / GM in shared/pois/the-murk.ts): outer bark
// surface (ridged, only ever OUTSIDE the collider ring), inner hollow wall, rounded lips around the openings, the
// heartwood column, the spiral stair, the Crow's Nest platform, and a big leaf-card crown on the limbs.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { M, col, cylGeo, noise3, tubeGeo, chamferBoxGeo, type ColorFn } from "../_kit/town-geo";
import type { TownBins } from "../_kit/town-materials";
import { GM, gmRadius, gmInner, gmOpen, LAYOUT, rootCurve, nestRails, WATER_Y, massRadius, type Root, type RootMass } from "../../../../../shared/pois/the-murk";
import { soft, taperTube, addPost, addRail, swampFn, murkLantern } from "./geo";
import { leafClumpTexture } from "../../veg/textures";

const TAU = Math.PI * 2;
const MOSS = new THREE.Color("#6d8a34"), MOSS2 = new THREE.Color("#8aa440");
/** bark tint: wet band at the water line, moss on the upper faces / higher up, lighter weathered ridges */
const barkFn = (seed: number, mossy = 0.6): ColorFn => {
  const wet = swampFn(seed, 0);
  return (x, y, z, b, o) => {
    wet(x, y, z, b, o);
    const n = noise3(x * 0.55 + seed, y * 0.35, z * 0.55), n2 = noise3(x * 2.2, y * 1.7 + seed, z * 2.2);
    if (y > WATER_Y + 0.6) {
      const m = Math.max(0, n - 0.5) * 2.4 * mossy;
      if (m > 0) o.lerp(n2 > 0.5 ? MOSS2 : MOSS, Math.min(0.85, m));
    }
    o.multiplyScalar(0.86 + 0.24 * n2);
  };
};

/** is quad (a0..a1, y0..y1) touching an opening (any of 9 sample points)? */
function quadOpen(a0: number, a1: number, y0: number, y1: number): boolean {
  for (const fa of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) if (gmOpen(a0 + (a1 - a0) * fa, y0 + (y1 - y0) * fy)) return true;
  return false;
}

/** the trunk skin: rings × segments at radius fn(a, y), quads inside openings skipped; `inward` flips the normals */
function trunkSkin(y0: number, y1: number, dy: number, segs: number, rad: (a: number, y: number) => number, inward: boolean, skip: boolean): THREE.BufferGeometry {
  const rings = Math.ceil((y1 - y0) / dy);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const y = y0 + (y1 - y0) * i / rings;
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * TAU, r = rad(a, y);
      pos.push(GM.x + Math.cos(a) * r, y, GM.z + Math.sin(a) * r);
      uv.push((j / segs) * Math.round(TAU * 3.2), y);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const ya = y0 + (y1 - y0) * i / rings, yb = y0 + (y1 - y0) * (i + 1) / rings, aa = (j / segs) * TAU, ab = ((j + 1) / segs) * TAU;
    if (skip && quadOpen(aa, ab, ya, yb)) continue;
    const a = i * (segs + 1) + j, b = a + segs + 1;
    if (inward) idx.push(a, a + 1, b, a + 1, b + 1, b); else idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** ridge profile: 9 twisting flutes, stronger low down (buttress ribs), always ≥ 0 (outside the collider) */
function ridge(a: number, y: number): number {
  const k = 0.5 + 0.5 * Math.sin(a * 7 + y * 0.22 + Math.sin(a * 3 + y * 0.1) * 0.9);
  const low = 1 + 3.2 * Math.max(0, 1 - (y - 0.3) / 5);
  const lump = noise3(Math.cos(a) * 1.4 + 7, y * 0.18, Math.sin(a) * 1.4);
  return (Math.pow(k, 2.0) * 0.2 * low) + 0.45 * Math.max(0, lump - 0.45) + 0.035 * noise3(Math.cos(a) * 2.5, y * 0.7, Math.sin(a) * 2.5);
}

export interface TreeBins { main: TownBins; near: TownBins; fine: TownBins; lod1: TownBins }

export function addGreatMangrove(B: TreeBins, rng: () => number) {
  const m = B.main, nb = B.near;
  const tint = soft("#c29c72", 0.5, 1.25);
  // ---- outer skin: from under the mud up into the crown (closed above the hollow), ridged outward
  const outer = trunkSkin(-1.4, 20.5, 0.34, 64, (a, y) => gmRadius(y) + ridge(a, y), false, true);
  m.thatch.add(outer, null, tint, barkFn(3, 0.75));
  // top cap (inside the crown, never seen from below)
  m.thatch.add(new THREE.ConeGeometry(gmRadius(20.5) + 0.1, 2.2, 20, 1), M(GM.x, 21.5, GM.z), tint);
  // ---- inner hollow wall (normals inward), darker, damp
  const inner = trunkSkin(GM.floorY - 0.3, GM.platY + 2.72, 0.34, 48, (a, y) => gmInner(y) - 0.02 * noise3(Math.cos(a) * 3, y, Math.sin(a) * 3), true, true);
  // lantern light baked into the vertex colour (warm pools around each spiral lantern + daylight from the openings)
  const lamps = LAYOUT.spiral.filter((_, i) => i % 4 === 2).map((s) => new THREE.Vector3(GM.x + Math.cos(s.a + 0.2) * (s.r1 - 0.12), s.y + 1.7, GM.z + Math.sin(s.a + 0.2) * (s.r1 - 0.12)));
  const WARM = new THREE.Color("#ffb060");
  const glowFn: ColorFn = (x, y, z, b, o) => {
    let k = 0; for (const l of lamps) { const d2 = (x - l.x) ** 2 + (y - l.y) ** 2 + (z - l.z) ** 2; k += 2.2 / (1 + d2 * 0.9); }
    const aIn = Math.atan2(z - GM.z, x - GM.x);
    const day = gmOpen(aIn + 0.15, y) || gmOpen(aIn - 0.15, y) ? 0.5 : 0;
    // (a lantern every third of a turn, bright pools — otherwise the hollow reads near-black)
    o.multiplyScalar(0.85 + Math.min(2.4, k * 0.85) + day).lerp(WARM, Math.min(0.5, k * 0.22));
  };
  nb.thatch.add(inner, null, soft("#9a7a5a", 0.5, 0.8), (x, y, z, b, o) => { const n = noise3(x * 1.3, y * 0.9, z * 1.3); o.multiplyScalar(0.75 + 0.35 * n); if (n > 0.7) o.lerp(MOSS, 0.35); glowFn(x, y, z, b, o); });
  // ---- every opening is a TUNNEL through the wall (thick at the flared foot): reveal strips between the inner and
  // outer skins + rounded bark lips on both faces (they hide the skins' stepped hole edges; the clear opening is exactly
  // the collider's)
  const rOut = (a: number, y: number) => gmRadius(y) + ridge(a, y);
  const rIn = (a: number, y: number) => gmInner(y) - 0.02 * noise3(Math.cos(a) * 3, y, Math.sin(a) * 3);
  const P = (a: number, y: number, r: number) => new THREE.Vector3(GM.x + Math.cos(a) * r, y, GM.z + Math.sin(a) * r);
  const opening = (aC: number, half: number, yA: number, yB: number, sill: boolean) => {
    // outline (a, y): left side up, rounded top, right side down, [sill back]
    const pts: Array<[number, number]> = [], cr = Math.min(0.5, (yB - yA) * 0.3), n = 10;
    const hw = (y: number) => half * 1.0 + 0 * y;
    for (let i = 0; i <= n; i++) pts.push([aC - hw(0), yA + (yB - cr - yA) * i / n]);
    for (let i = 1; i < n; i++) { const t = i / n, ang = Math.PI * (1 - t); pts.push([aC + Math.cos(ang) * hw(0), yB - cr + Math.sin(ang) * cr]); }
    for (let i = 0; i <= n; i++) pts.push([aC + hw(0), yB - cr - (yB - cr - yA) * i / n]);
    if (sill) for (let i = 1; i < n; i++) pts.push([aC + hw(0) - 2 * hw(0) * i / n, yA]);
    const pos: number[] = [];
    const cy = (yA + yB) / 2;
    const L = pts.length - (sill ? 0 : 1);
    for (let k = 0; k < L; k++) {
      const [a0, y0] = pts[k], [a1, y1] = pts[(k + 1) % pts.length];
      const i0 = P(a0, y0, rIn(a0, y0) - 0.05), o0 = P(a0, y0, rOut(a0, y0) + 0.05), i1 = P(a1, y1, rIn(a1, y1) - 0.05), o1 = P(a1, y1, rOut(a1, y1) + 0.05);
      // face normal must point INTO the opening (toward its centre line)
      const mid = new THREE.Vector3().addVectors(i0, o1).multiplyScalar(0.5), toC = P(aC, cy, (rIn(aC, cy) + rOut(aC, cy)) / 2).sub(mid);
      const nrm = new THREE.Vector3().subVectors(o0, i0).cross(new THREE.Vector3().subVectors(i1, i0));
      const tri = nrm.dot(toC) > 0 ? [i0, o0, i1, i1, o0, o1] : [i0, i1, o0, i1, o1, o0];
      for (const v of tri) pos.push(v.x, v.y, v.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const uv: number[] = []; for (let i = 0; i < pos.length / 3; i++) uv.push(pos[i * 3] * 0.5 + pos[i * 3 + 2] * 0.5, pos[i * 3 + 1] * 0.5);
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    m.thatch.add(g, null, soft("#a8865e", 0.5, 1.0), barkFn(9, 0.4));
    // lips: offset 0.22 outward in the wall plane, on both skins
    const lipPts = (r: (a: number, y: number) => number, dr: number) => pts.map(([a, y]) => {
      const da = a < aC - half * 0.5 ? -1 : a > aC + half * 0.5 ? 1 : 0, dyy = y > yB - cr - 0.01 ? 1 : y <= yA + 0.01 && sill ? -1 : 0;
      const rr = r(a, y);
      return P(a + da * 0.22 / rr, y + dyy * 0.22, rr + dr);
    });
    m.thatch.add(tubeGeo(lipPts(rOut, 0.04), 0.3, 8, sill, pts.length * 2), null, tint, barkFn(7, 0.5));
    nb.thatch.add(tubeGeo(lipPts(rIn, -0.04), 0.24, 7, sill, pts.length * 2), null, soft("#7a6450", 0.5, 0.75));
  };
  opening(GM.inA, GM.inHalf, GM.floorY - 0.4, GM.floorY + GM.inH, false);
  opening(GM.outA, GM.outHalf, GM.platY - 0.4, GM.platY + 2.5, false);
  opening(GM.winA, GM.winHalf, GM.winY0, GM.winY1, true);
  // ---- floor + ceiling boards, the heartwood column
  const boards = (y: number, r: number, bin: TownBins, under = false) => {
    for (let z = -r + 0.12; z < r; z += 0.26) {
      const half = Math.sqrt(Math.max(0, r * r - z * z)) - 0.02;
      if (half < 0.2) continue;
      bin.woodDark.box(half * 2, 0.08, 0.24, M(GM.x, y - 0.04, GM.z + z), soft("#a88a68", 0.3, 0.85 + rng() * 0.25), [rng() * 3, z]);
    }
    if (under) bin.wood.box(r * 1.9, 0.12, 0.2, M(GM.x, y - 0.14, GM.z), col("#4a3a2a"));
  };
  boards(GM.floorY, gmInner(GM.floorY) + 0.05, nb);
  boards(GM.platY + 2.72 + 0.1, gmInner(GM.platY + 2.7) + 0.05, nb, true);
  nb.thatch.add(taperTube([new THREE.Vector3(GM.x, GM.floorY - 0.3, GM.z), new THREE.Vector3(GM.x + 0.08, GM.floorY + 5, GM.z - 0.06), new THREE.Vector3(GM.x - 0.06, GM.floorY + 10, GM.z + 0.05), new THREE.Vector3(GM.x, GM.platY + 2.8, GM.z)], 0.5, 0.44, 12, 1.2, 0.18, 11), null, soft("#a88a68", 0.5, 0.9), (x, y, z, b, o) => { barkFn(13, 0.3)(x, y, z, b, o); glowFn(x, y, z, b, o); });
  // ---- spiral stair: radial treads on brackets, a rope hand line on the wall, lanterns every half turn
  const sp = LAYOUT.spiral;
  const handPts: THREE.Vector3[] = [];
  sp.forEach((s, i) => {
    const rm = (s.r0 + s.r1) / 2, len = s.r1 - s.r0 + 0.08, ht = Math.tan(s.da / 2) * s.r1 * 1.05;
    const x = GM.x + Math.cos(s.a) * rm, z = GM.z + Math.sin(s.a) * rm;
    // the tread = its collider (gmBoxes: 2·ht wide): two side-by-side boards with a joint between them (the
    // narrower drawn boards would leave walkable gaps of air between the treads)
    for (const k of [-1, 1]) nb.woodDark.add(chamferBoxGeo(len, 0.07, ht - 0.012, 0.012, [rng() * 3, k]), M(GM.x + Math.cos(s.a) * rm - Math.sin(s.a) * k * ht / 2, s.y - 0.035, GM.z + Math.sin(s.a) * rm + Math.cos(s.a) * k * ht / 2, -s.a), soft(k > 0 ? "#b09070" : "#a88868", 0.3, 0.9 + rng() * 0.2), glowFn);
    nb.wood.box(len * 0.8, 0.12, 0.08, M(x, s.y - 0.13, z, -s.a), col("#4e3c2c"));
    if (i % 2 === 0) handPts.push(new THREE.Vector3(GM.x + Math.cos(s.a) * (s.r1 - 0.06), s.y + 0.95, GM.z + Math.sin(s.a) * (s.r1 - 0.06)));
    if (i % 4 === 2) {
      // a wall bracket (an iron arm into the heartwood wall) + a glowing storm lantern
      const la = s.a + 0.2, lx = GM.x + Math.cos(la) * (s.r1 - 0.12), lz = GM.z + Math.sin(la) * (s.r1 - 0.12);
      nb.metal.box(0.3, 0.03, 0.03, M(GM.x + Math.cos(la) * (s.r1 + 0.02), s.y + 2.2, GM.z + Math.sin(la) * (s.r1 + 0.02), -la), col("#2a2622"));
      murkLantern(nb, M(lx, s.y + 1.72, lz));
    }
    // the tread's support: a bark-on bearer mortised into the trunk wall + a diagonal brace under it (no floating planks)
    {
      const wa = s.a, rw = s.r1 + 0.05, ri = s.r1 - len * 0.55;
      const A0 = new THREE.Vector3(GM.x + Math.cos(wa) * rw, s.y - 0.95, GM.z + Math.sin(wa) * rw), A1 = new THREE.Vector3(GM.x + Math.cos(wa) * ri, s.y - 0.18, GM.z + Math.sin(wa) * ri);
      if (i % 2 === 0) nb.thatch.add(taperTube([A0, A0.clone().lerp(A1, 0.5).add(new THREE.Vector3(0, 0.06, 0)), A1], 0.05, 0.04, 6, 2, 0.05, i), null, soft("#8a6e52", 0.5, 0.8), glowFn);
    }
  });
  if (handPts.length > 3) nb.rope.add(tubeGeo(handPts, 0.026, 4, false, handPts.length * 3), null, col("#b89f6c"));
  // ---- the Crow's Nest platform (planks around the trunk, joists, knee braces, fascia, rails with the bridge gap)
  {
    const ph = GM.platH, rt = gmRadius(GM.platY) - 0.35, y = GM.platY;
    const rects: Array<[number, number, number, number]> = [[-ph, -ph, ph, -rt], [-ph, rt, ph, ph], [-ph, -rt, -rt, rt], [rt, -rt, ph, rt]];
    for (const [x0, z0, x1, z1] of rects) {
      for (let z = z0; z < z1 - 0.05; z += 0.27) {
        const zz = Math.min(z + 0.25, z1);
        m.woodDark.box(x1 - x0, 0.08, zz - z - 0.015, M(GM.x + (x0 + x1) / 2, y - 0.04, GM.z + (z + zz) / 2), soft("#b09070", 0.3, 0.85 + rng() * 0.3), [rng() * 3, z]);
      }
    }
    for (const s of [-1, 1]) {
      m.wood.box(ph * 2 + 0.1, 0.26, 0.08, M(GM.x, y - 0.15, GM.z + s * (ph + 0.04)), soft("#8a7054", 0.5, 0.9));
      m.wood.box(0.08, 0.26, ph * 2 + 0.1, M(GM.x + s * (ph + 0.04), y - 0.15, GM.z), soft("#8a7054", 0.5, 0.9));
      for (const k of [-0.55, 0, 0.55]) {
        m.wood.box(ph * 2, 0.2, 0.16, M(GM.x, y - 0.32, GM.z + s * ph * Math.abs(k) * (k === 0 ? 0 : 1) + (k === 0 ? s * (rt + 0.3) : 0)), col("#4e3c2c"));
      }
    }
    // knee braces from the trunk down-out to the platform edges (8)
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * TAU + 0.2, r0 = gmRadius(y - 3.2) - 0.1, r1 = ph * 0.95 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const a0 = new THREE.Vector3(GM.x + Math.cos(a) * r0, y - 3.2, GM.z + Math.sin(a) * r0), a1 = new THREE.Vector3(GM.x + Math.cos(a) * r1 * 0.8, y - 0.3, GM.z + Math.sin(a) * r1 * 0.8);
      m.thatch.add(taperTube([a0, a0.clone().lerp(a1, 0.5).add(new THREE.Vector3(0, 0.15, 0)), a1], 0.2, 0.15, 7, 1.5, 0.1, i), null, soft("#9a8468", 0.5, 0.95), barkFn(i + 20, 0.3));
    }
    // rails (posts + rope) — matching the noShoot rail colliders, with the gap for the bridge head
    const V = (x: number, z: number) => new THREE.Vector3(GM.x + x, y, GM.z + z);
    for (const [ax, az, bx, bz] of nestRails()) addRail(nb, V(ax, az), V(bx, bz), rng);
    // a lantern post at each corner
    for (const [sx, sz] of [[-1, -1], [1, 1], [-1, 1]]) murkLantern(nb, M(GM.x + sx * (ph - 0.3), y + 1.5, GM.z + sz * (ph - 0.3)));
    // thresholds through the wall (collider: gmBoxes)
    for (const [a, yy] of [[GM.inA, GM.floorY], [GM.outA, GM.platY]] as Array<[number, number]>) {
      const r0 = gmInner(yy) - 0.35, r1 = gmRadius(yy) + 0.1;
      for (let k = -2; k <= 2; k++) {
        const aa = a + k * 0.21 / gmRadius(yy);
        nb.woodDark.box(r1 - r0, 0.08, 0.2, M(GM.x + Math.cos(aa) * (r0 + r1) / 2, yy - 0.04, GM.z + Math.sin(aa) * (r0 + r1) / 2, -aa), soft("#a08060", 0.3, 0.9), [rng() * 2, 0]);
      }
    }
  }
  // ---- LOD1: the trunk as a coarse lathe (shadow proxy + far)
  {
    const prof: Array<[number, number]> = [];
    for (let y = -1; y <= 21; y += 1.5) prof.push([gmRadius(y) + 0.05, y]);
    const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 14);
    B.lod1.thatch.add(g, M(GM.x, 0, GM.z), tint);
  }
}

/** every root / limb / log / tangle as a tapered bark tube (the colliders follow the same curve: rootCurve) */
export async function addRoots(bins: (x: number, z: number) => TownBins, far: TownBins, rng: () => number, small?: (x: number, z: number) => TownBins, yieldFn?: () => Promise<void>) {
  let ri = 0;
  for (const r of LAYOUT.roots) {
    if (yieldFn && ++ri % 40 === 0) await yieldFn();
    const pts = r.pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const mid = pts[Math.floor(pts.length / 2)];
    const radial = r.kind === "trunk" ? 14 : r.kind === "limb" ? 12 : r.kind === "prop" || r.kind === "buttress" ? (r.r0 > 0.45 ? 12 : 8) : r.kind === "aerial" ? 4 : r.kind === "log" ? 12 : 8;
    const perM = r.kind === "aerial" ? 1.0 : r.kind === "limb" || r.kind === "trunk" ? 1.2 : 1.8;
    const lump = r.kind === "aerial" ? 0.05 : 0.14;
    const g = taperTube(pts, r.r0, r.r1, radial, perM, lump, rng() * 50, r.kind === "log" ? 3 : 0);
    const c = r.kind === "aerial" ? soft("#8a7456", 0.6, 1.0) : r.kind === "log" ? soft("#b89a74", 0.5, 1.15) : soft("#c9a276", 0.55, 1.28 + rng() * 0.12);
    // small roots (tangle arches, knees, aerial roots, secondaries) only draw within the near range
    const target = small && r.r0 < 0.34 && r.kind !== "limb" && r.kind !== "trunk" ? small : bins;
    target(mid.x, mid.z).thatch.add(g, null, c, barkFn(rng() * 30, r.kind === "log" ? 0.9 : r.kind === "limb" ? 0.8 : 0.55));
    // a near-tier root keeps a 4-sided core in the MAIN tier, inside its lumpy 8-sided tube
    // (0.72 r < the octagon's 0.92 × 0.86 = 0.79 r worst apothem; same segment density, so no chord cuts out of a bend):
    // beyond 170 m the mangroves keep their spider legs and the root tangles (hard cover) stay instead of vanishing
    if (target === small && r.kind !== "aerial") bins(mid.x, mid.z).thatch.add(taperTube(pts, r.r0 * 0.72, r.r1 * 0.72, 4, perM, 0, 0), null, c);
    if (r.kind === "limb" || r.kind === "trunk" || (r.kind === "prop" && r.r0 > 0.5)) far.thatch.add(taperTube(pts, r.r0, r.r1, 5, 0.5, 0, 0), null, c);
    // dead snags / up-ended root plates end in a BROKEN top: a ring of jagged splinters (no flat saw cut)
    if (r.kind === "trunk" && r.pts.length === 3 && r.r0 <= 0.56) {
      const e = pts[pts.length - 1], h0 = (e.x * 12.9898 + e.z * 78.233) % 1;
      for (let k = 0; k < 6; k++) {
        const hk = Math.abs(Math.sin((h0 + k) * 91.7)), a = k / 6 * Math.PI * 2 + hk, hh = 0.25 + hk * 0.95, rb = r.r1 * (0.32 + 0.18 * hk);
        const sp = new THREE.ConeGeometry(rb, hh, 4, 1);
        sp.translate(0, hh / 2 - 0.06, 0); sp.rotateZ(-0.12 - 0.25 * hk); sp.rotateY(-a);
        sp.translate(e.x + Math.cos(a) * r.r1 * 0.62, e.y, e.z + Math.sin(a) * r.r1 * 0.62);
        target(mid.x, mid.z).thatch.add(sp, null, c, barkFn(k + 40, 0.5));
      }
      // the splintered heartwood stub in the middle
      const st = new THREE.ConeGeometry(r.r1 * 0.55, 0.55 + h0 * 0.4, 5, 1); st.translate(e.x, e.y + 0.2, e.z);
      target(mid.x, mid.z).thatch.add(st, null, c, barkFn(47, 0.5));
    }
  }
  void rootCurve; void addPost; void cylGeo;
}

/** the sculpted ROOT MASS at a tree / tangle / mangrove foot (shared rootMasses / massOfPlant — the colliders are
 *  its octagon tiers): a steep fused-root cone, buttress fins that flare toward the bed and fade up the trunk, grooves
 *  between them, lumps, a wet band + algae at the tea line, moss on the upper faces; a domed knot on trunk-less tangles */
export function rootMassGeo(m: RootMass): THREE.BufferGeometry {
  const RAD = 32, H = m.yt - m.yb, rings = Math.max(6, Math.ceil(H / 0.22)), oct = 1.035;
  const k = 5 + (m.seed % 4), ph = (m.seed % 13) * 0.48;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const circ = Math.max(1, Math.round(TAU * (m.rb + m.rt) / 2 / 1.6));
  const ridge = (a: number) => { const c = 0.5 + 0.5 * Math.cos(k * a + ph + 0.35 * Math.sin(a * 3 + ph)); return c * c * c - 0.28; };
  const R = (y: number, a: number) => {
    const t = Math.min(1, Math.max(0, (y - m.yb) / H));
    const amp = 0.085 * Math.pow(1 - t, 0.7) + 0.02;
    const lump = 0.05 * (noise3(Math.cos(a) * 2.2 + m.seed, y * 1.4, Math.sin(a) * 2.2) - 0.5) * 2;
    return massRadius(m, y) * oct * (1 + amp * ridge(a) + lump);
  };
  for (let i = 0; i <= rings; i++) {
    const y = m.yb + H * i / rings;
    for (let j = 0; j <= RAD; j++) { const a = j / RAD * TAU, r = R(y, a); pos.push(m.x + Math.cos(a) * r, y, m.z + Math.sin(a) * r); uv.push(j / RAD * circ, y * 0.8); }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < RAD; j++) { const a = i * (RAD + 1) + j, b = a + RAD + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  // the cap: closes into the trunk (hidden inside it) or domes into a knot of fused roots
  const base = (rings) * (RAD + 1), capR = 3;
  for (let i = 1; i <= capR; i++) {
    const f = 1 - i / capR, y = m.yt + (m.trunk ? 0.08 * (1 - f) : Math.sin((1 - f) * Math.PI / 2) * Math.max(0.25, m.rt * 0.9));
    for (let j = 0; j <= RAD; j++) { const a = j / RAD * TAU, r = Math.max(0.02, R(m.yt, a) * f); pos.push(m.x + Math.cos(a) * r, y, m.z + Math.sin(a) * r); uv.push(j / RAD * circ * Math.max(0.2, f), y * 0.8 + (1 - f)); }
  }
  for (let i = 0; i < capR; i++) for (let j = 0; j < RAD; j++) { const a = base + i * (RAD + 1) + j, b = a + RAD + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
export function addRootMasses(bins: (x: number, z: number) => TownBins, masses: RootMass[]) {
  for (const m of masses) bins(m.x, m.z).thatch.add(rootMassGeo(m), null, soft("#c9a276", 0.55, 1.22 + (m.seed % 7) * 0.02), barkFn(m.seed, 0.95));
}

const leafTex = new Map<string, THREE.Texture>();
/** leaf-card crown (hero + limb ends): lobed masses of big alpha cards, normals bent out of each lobe. Built in 36 m
 *  CELLS (one card mesh + core per cell): frustum + shadow-cascade culling skip the cells out of view — one swamp-wide
 *  mesh would draw all ~25 k cards (and their shadow casters) from every camera. `dens` < 1: the distance LOD — fewer,
 *  proportionally larger cards (same lobes, same silhouette mass) */
export function crownMesh(ctx: { renderer: THREE.WebGLRenderer }, lobes: Array<{ c: THREE.Vector3; r: number; tint?: [number, number, number] }>, seed = 1, leaf: { hue: number; sat: number; light: number; name?: string } = { hue: 92, sat: 0.55, light: 0.36 }, dens = 1): THREE.Object3D {
  const { group, steps } = crownBuilder(ctx, lobes, seed, leaf, dens);
  for (const st of steps) st();
  return group;
}
/** the crown as a group + one build step per cell (the module yields between them; the far LOD builds lazily) */
export function crownBuilder(ctx: { renderer: THREE.WebGLRenderer }, lobes: Array<{ c: THREE.Vector3; r: number; tint?: [number, number, number] }>, seed = 1, leaf: { hue: number; sat: number; light: number; name?: string } = { hue: 92, sat: 0.55, light: 0.36 }, dens = 1): { group: THREE.Group; steps: Array<() => void> } {
  const cells = new Map<string, typeof lobes>();
  for (const L of lobes) { const k = `${Math.floor(L.c.x / 36)},${Math.floor(L.c.z / 36)}`; let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(L); }
  const group = new THREE.Group(); group.name = "murk:crown-cells";
  let i = 0;
  const steps = [...cells.values()].map((list) => { const sd = seed * 31 + i++; return () => { group.add(crownCell(ctx, list, sd, leaf, dens)); }; });
  return { group, steps };
}
function crownCell(ctx: { renderer: THREE.WebGLRenderer }, lobes: Array<{ c: THREE.Vector3; r: number; tint?: [number, number, number] }>, seed: number, leaf: { hue: number; sat: number; light: number; name?: string }, dens: number): THREE.Mesh {
  const tk = `${leaf.hue}:${leaf.sat}:${leaf.light}`;
  let tex = leafTex.get(tk);
  if (!tex) { tex = leafClumpTexture(leaf.hue === 92 ? 43 : 71, { hue: leaf.hue, sat: leaf.sat, light: leaf.light, leafLen: 36, count: 260, round: false, edgeContrast: 0.3 }); leafTex.set(tk, tex); }
  void ctx;
  const rnd = (() => { let a = seed * 9301 + 49297; return () => { a = (a * 9301 + 49297) % 233280; return a / 233280; }; })();
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], colr: number[] = [];
  const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const L of lobes) {
    // (~25 % fewer, slightly larger cards — the alpha-tested depth prepass overdraw is the crown's GPU cost)
    const N = Math.max(3, Math.round((8 + L.r * L.r * 0.56) * dens));
    for (let i = 0; i < N; i++) {
      // a point on the lobe's upper 3/4 shell, the card roughly tangent to it
      // (down to −50° — the belly is carded too: the opaque core must never show from below)
      const th = rnd() * TAU, el = Math.asin(rnd() * 1.6 - 0.6), rr = L.r * (0.45 + Math.sqrt(rnd()) * 0.55);
      Z.set(Math.cos(th) * Math.cos(el), Math.sin(el), Math.sin(th) * Math.cos(el)).normalize();
      c.copy(L.c).addScaledVector(Z, rr);
      X.set(0, 1, 0).cross(Z); if (X.lengthSq() < 1e-3) X.set(1, 0, 0); X.normalize();
      Y.copy(Z).cross(X).normalize();
      const roll = rnd() * TAU; X.applyAxisAngle(Z, roll); Y.applyAxisAngle(Z, roll);
      // (~20 % less card area per lobe — the alpha-tested prepass overdraw is the crown's cost; the core fills behind)
      const s = Math.min(4.2 / Math.sqrt(dens), L.r * (0.45 + rnd() * 0.18) / Math.sqrt(dens));
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const idx = [0, 1, 2, 0, 2, 3];
      const shade = 0.55 + 0.45 * Math.max(0, Z.y * 0.6 + 0.5) * (0.85 + rnd() * 0.3);
      for (const k of idx) {
        const [u, v] = corners[k];
        const px = c.x + X.x * u * s + Y.x * v * s, py = c.y + X.y * u * s + Y.y * v * s, pz = c.z + X.z * u * s + Y.z * v * s;
        pos.push(px, py, pz);
        // normals: bent out of the LOBE (the whole mass lights as one puff)
        n.set(px - L.c.x, py - L.c.y, pz - L.c.z).normalize().lerp(Z, 0.3).normalize();
        nor.push(n.x, n.y, n.z);
        uv.push((u + 1) / 2, (v + 1) / 2);
        const d = Math.min(1, Math.hypot(px - L.c.x, py - L.c.y, pz - L.c.z) / L.r);
        const k2 = shade * (0.65 + 0.35 * d);
        const tt = L.tint ?? [0.95, 1, 0.9];
        colr.push(k2 * tt[0], k2 * tt[1], k2 * tt[2]);
      }
    }
  }
  // cards sorted LOWEST first: from the walks and the water (under the canopy) the nearest leaves draw first and
  // the prepass's early depth test rejects the stacked cards above them (the crown's overdraw was its GPU cost)
  const nCard = pos.length / 18, order = Array.from({ length: nCard }, (_, i) => i);
  const key = order.map((i) => { let y = 1e9; for (let k = 0; k < 6; k++) y = Math.min(y, pos[i * 18 + k * 3 + 1]); return y; });
  order.sort((a, b) => key[a] - key[b]);
  const re = (src: number[], per: number) => { const out = new Float32Array(src.length); order.forEach((from, to) => { for (let k = 0; k < per * 6; k++) out[to * per * 6 + k] = src[from * per * 6 + k]; }); return out; };
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(re(pos, 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(re(nor, 3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(re(uv, 2), 2));
  g.setAttribute("color", new THREE.BufferAttribute(re(colr, 3), 3));
  g.computeBoundingSphere();
  // two passes (the veg area's trick): an alpha-tested DEPTH-ONLY prepass carves the leaf silhouettes, then the lit pass
  // draws with depthFunc EQUAL and no discard — every covered pixel is shaded exactly once despite the stacked cards
  const pre = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.42, side: THREE.DoubleSide, colorWrite: false, name: "murk:crown-pre" });
  // (Lambert — the leaf cards' GGX specular + env BRDF cost a full-screen standard pass under the canopy for a
  // sheen nobody sees on matte leaves)
  const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, vertexColors: true, depthFunc: THREE.EqualDepth, depthWrite: false, name: "murk:crown-leaves" });
  mat.onBeforeCompile = (sh) => {
    // light through the leaves: never pitch-black under the crown, warm-green transmission
    sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vec3(0.14, 0.2, 0.07);");
  };
  mat.customProgramCacheKey = () => "murk-crown";
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = "murk:crown";
  // (no shadow-map lookups on the leaf cards — the canopy shades itself by its per-card vertex shade + the lobe
  // normals; the cascade PCF taps over ~half the screen under the canopy were the crown's main GPU cost)
  mesh.castShadow = false; mesh.receiveShadow = false;
  const preMesh = new THREE.Mesh(g, pre);
  preMesh.name = "murk:crown-pre";
  preMesh.renderOrder = -5; mesh.renderOrder = -4;
  preMesh.castShadow = true; preMesh.receiveShadow = false;
  preMesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.42 });
  mesh.add(preMesh);
  // OPAQUE LOBE CORES: a lumpy dark leaf-mass blob inside every lobe (0.6 r), drawn before the cards — the cards
  // behind a core fail the early depth test (the crown's alpha-tested overdraw was its GPU cost), and the canopy reads
  // as a dense mass with no see-through holes in the middle of a lobe
  {
    const parts: THREE.BufferGeometry[] = [];
    let li = 0;
    for (const L of lobes) {
      const ico = new THREE.IcosahedronGeometry(L.r * 0.3, 1);
      const pp = ico.getAttribute("position") as THREE.BufferAttribute, v = new THREE.Vector3();
      for (let i = 0; i < pp.count; i++) {
        v.fromBufferAttribute(pp, i);
        const k = 0.7 + 0.55 * noise3(v.x * 0.5 + li * 7.1, v.y * 0.5, v.z * 0.5 + seed);
        // flatter underside (the crown's belly), the top kept round
        pp.setXYZ(i, v.x * k, v.y * k * (v.y < 0 ? 0.7 : 1), v.z * k);
      }
      ico.translate(L.c.x, L.c.y + L.r * 0.12, L.c.z);
      ico.deleteAttribute("uv");
      parts.push(ico); li++;
    }
    const cg = mergeGeometries(parts)!; cg.computeVertexNormals();
    const P = cg.getAttribute("position"), C = new Float32Array(P.count * 3);
    const base = new THREE.Color().setHSL(leaf.hue / 360, leaf.sat * 0.8, leaf.light * 0.42);
    for (let i = 0; i < P.count; i++) { const n = 0.7 + 0.6 * noise3(P.getX(i) * 0.5, P.getY(i) * 0.5, P.getZ(i) * 0.5); C[i * 3] = base.r * n; C[i * 3 + 1] = base.g * n; C[i * 3 + 2] = base.b * n; }
    cg.setAttribute("color", new THREE.BufferAttribute(C, 3));
    const cm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.4, name: "murk:crown-core-foliage" });
    cm.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vec3(0.3, 0.4, 0.16);"); };
    cm.customProgramCacheKey = () => "murk-crown-core";
    const core = new THREE.Mesh(cg, cm);
    core.name = "murk:crown-core"; core.renderOrder = -6; core.castShadow = true; core.receiveShadow = true;
    mesh.add(core);
  }
  return mesh;
}

/** the Great Mangrove's crown leaf: sunlit lime-gold */
// (a warm GOLD — THE MURK's accent colour; lime reads as just another green from the plane)
export const HERO_LEAF = { hue: 50, sat: 0.86, light: 0.52 };
/** the hero crown's lobes: over the fork, at every limb end, filling between */
export function heroLobes(): Array<{ c: THREE.Vector3; r: number; tint?: [number, number, number] }> {
  const out: Array<{ c: THREE.Vector3; r: number; tint?: [number, number, number] }> = [];
  out.push({ c: new THREE.Vector3(GM.x, 31.5, GM.z), r: 12.5 });
  out.push({ c: new THREE.Vector3(GM.x + 4, 26.5, GM.z - 3), r: 8.0 });
  const limbs = LAYOUT.roots.filter((r: Root) => r.kind === "limb");
  for (const L of limbs) {
    const e = L.pts[L.pts.length - 1], mid = L.pts[Math.floor(L.pts.length / 2)];
    if (L.r0 < 0.9) { out.push({ c: new THREE.Vector3(e[0], Math.max(e[1] + 2.2, 21.5), e[2]), r: 4.2 }); continue; }
    if (e[1] < 16) { out.push({ c: new THREE.Vector3(e[0], e[1] + 2.4, e[2]), r: 4.6 }); out.push({ c: new THREE.Vector3((e[0] + mid[0]) / 2, mid[1] + 3.4, (e[2] + mid[2]) / 2), r: 3.8 }); continue; }
    out.push({ c: new THREE.Vector3(e[0], e[1] + 2.0, e[2]), r: 7.4 });
    out.push({ c: new THREE.Vector3((e[0] + mid[0]) / 2, (e[1] + mid[1]) / 2 + 3.6, (e[2] + mid[2]) / 2), r: 6.2 });
  }
  // (the giant's crown is drawn with its own lime-gold leaf texture — see HERO_LEAF — a landmark colour that reads apart
  // from the green canopy from the plane; a vertex tint alone cannot turn a green texture gold)
  for (const o of out) o.tint = [1.05, 1.0, 0.9];
  return out;
}

/** lantern LIGHT in the hollow: an additive warm skin just inside the inner wall + a pool on the floor, per-vertex
 *  falloff from every spiral lantern (the interiors kit's light-pool trick — no PointLights). The vertex-colour bake alone
 *  could only brighten what the (shadowed) ambient already lit, so the hollow stays near-black. */
export function hollowGlow(): THREE.Mesh {
  const lamps = LAYOUT.spiral.filter((_, i) => i % 4 === 2).map((s) => new THREE.Vector3(GM.x + Math.cos(s.a + 0.2) * (s.r1 - 0.12), s.y + 1.89, GM.z + Math.sin(s.a + 0.2) * (s.r1 - 0.12)));
  lamps.push(new THREE.Vector3(GM.x, GM.floorY + 2.2, GM.z));
  const skin = trunkSkin(GM.floorY - 0.2, GM.platY + 2.6, 0.3, 40, (a, y) => gmInner(y) - 0.02 * noise3(Math.cos(a) * 3, y, Math.sin(a) * 3) - 0.015, true, true);
  const floor = new THREE.CircleGeometry(gmInner(GM.floorY) - 0.08, 32); floor.rotateX(-Math.PI / 2); floor.translate(GM.x, GM.floorY + 0.012, GM.z);
  const geo = mergeGeometries([skin.toNonIndexed(), floor.toNonIndexed()].map((g) => { g.deleteAttribute("normal"); return g; }))!;
  const P = geo.getAttribute("position"), C = new Float32Array(P.count * 3), warm = new THREE.Color("#ffbe80");
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    let k = 0; for (const l of lamps) { const d2 = (x - l.x) ** 2 + (y - l.y) ** 2 + (z - l.z) ** 2; k += 1 / (1 + d2 * 0.9); }
    // (MULTIPLIED onto what is drawn — the bark / planks keep their texture; pools ×4 at a lantern, ×1.5 between them)
    k = 0.5 + Math.min(1.0, k) * 3.8;
    C[i * 3] = warm.r * k; C[i * 3 + 1] = warm.g * k; C[i * 3 + 2] = warm.b * k;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(C, 3));
  // result = dst × (1 + src): lantern light modulated by the surface's own colour
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor, depthWrite: false, depthFunc: THREE.LessEqualDepth, side: THREE.DoubleSide, toneMapped: false, fog: false, name: "murk:hollow-glow" });
  const m = new THREE.Mesh(geo, mat);
  m.name = "murk:hollow-glow"; m.castShadow = false; m.receiveShadow = false; m.renderOrder = 3;
  // the lanterns' FILL inside the hollow: dst × (1 + warm fill), strongest near a lantern.
  // Not an on/off switch on the camera (×2.8–4.4 with the depth test off: the lighting visibly changes on the way in /
  // out, and the outdoors seen back through the gate blows out too).
  // Instead: a DEPTH-TESTED shell just inside the wall mass (gmInner + 0.3 m, BackSide, GREATER-EQUAL: only what lies in
  // front of the shell = the hollow's own contents; the outdoors seen through the gate / window is behind it and keeps
  // its light), a gentler fill (×1.4–2.2), and a SMOOTH fade over the root-gate tunnel + ~0.3 s time constant.
  {
    const y0 = GM.floorY - 0.6, y1 = GM.hollowTop + 0.2;
    const cg = new THREE.CylinderGeometry(1, 1, y1 - y0, 28, 24, true); cg.translate(0, (y0 + y1) / 2, 0);
    const Pc = cg.getAttribute("position"), Cc = new Float32Array(Pc.count * 3), fillC = new THREE.Color("#ffe2b8");
    for (let i = 0; i < Pc.count; i++) {
      const y = Pc.getY(i), rr = gmInner(Math.min(Math.max(y, GM.floorY), GM.hollowTop)) + 0.3;
      Pc.setXYZ(i, GM.x + Pc.getX(i) * rr, y, GM.z + Pc.getZ(i) * rr);
    }
    for (let i = 0; i < Pc.count; i++) {
      const x = Pc.getX(i), y = Pc.getY(i), z = Pc.getZ(i);
      let k = 0; for (const l of lamps) { const d2 = (x - l.x) ** 2 + (y - l.y) ** 2 + (z - l.z) ** 2; k += 1 / (1 + d2 * 0.35); }
      k = 0.4 + Math.min(1.2, k) * 0.7;
      Cc[i * 3] = fillC.r * k; Cc[i * 3 + 1] = fillC.g * k; Cc[i * 3 + 2] = fillC.b * k;
    }
    cg.setAttribute("color", new THREE.BufferAttribute(Cc, 3));
    const fm = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor, depthWrite: false, depthTest: true, depthFunc: THREE.GreaterEqualDepth, side: THREE.BackSide, toneMapped: false, fog: false, name: "murk:hollow-glow-fill" });
    const fill = new THREE.Mesh(cg, fm);
    fill.name = "murk:hollow-glow-fill"; fill.renderOrder = 900; fill.frustumCulled = false;
    const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    let fv = 0, last = 0;
    fill.onBeforeRender = (_r, _s, cam) => {
      const c = cam.position, rc = Math.hypot(c.x - GM.x, c.z - GM.z), ri = gmInner(Math.min(Math.max(c.y, GM.floorY), GM.hollowTop));
      // 1 deep in the hollow → 0 a metre and a half into the gate tunnel / out of the platform door; 0 above / below
      const f = (1 - sm(ri - 0.4, ri + 1.4, rc)) * sm(GM.floorY - 0.4, GM.floorY + 0.4, c.y) * (1 - sm(GM.hollowTop - 0.8, GM.hollowTop + 0.2, c.y));
      const now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 1; last = now;
      fv += (f - fv) * (1 - Math.exp(-dt * 7));
      fm.color.setScalar(fv < 0.004 ? 0 : fv);
    };
    m.add(fill);
  }
  return m;
}
