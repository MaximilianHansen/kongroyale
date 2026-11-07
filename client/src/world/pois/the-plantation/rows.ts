// THE PLANTATION banana rows: our own cultivated banana plant (3 variants × 3 LODs) drawn as InstancedMeshes —
// fibrous pseudostem, 8–10 big torn paddle leaves (painted leaf card, V-folded along the midrib, drooping),
// dry leaf skirt, and on most plants an arching stalk with a crinkled glossy BLUE fruit bag + maroon bud.
// Thousands of plants: per-instance distance LOD + frustum culling, rebuilt only when the camera moves/turns.
// Leaves/bags sway in the wind (vertex shader) and glow lime when back-lit by the sun (cheap translucency).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { WorldCtx } from "../../../engine/engine";
import { rng } from "../../../../../shared/pois/coast-kit";
import { NOCULL, T } from "../_kit/coast-kit";
import * as TX from "../_kit/coast-tex";

type Spot = [number, number, number, number, number, number]; // x, z, yaw, scale, variant, bag

// LOD0 < 38 m (the only ring that casts) < LOD1 < 110 m < LOD2 < 230 m < LOD3 (~20 tris) < 420 m; beyond that the
// terrain's painted crop rows carry the field (otherwise 1.4 M tris of LOD2 plants draw from the lighthouse, 500 m away)
const LOD_D = [16, 64, 160, 320];
/** the widened culling camera (scratch: update() copies the view camera into it) */
const FC = new THREE.PerspectiveCamera();
const shared = {
  uTime: { value: 0 },
  uSunView: { value: new THREE.Vector3(0, 1, 0) },
};

/** wind sway + back-light translucency + shade fill, patched into a MeshStandardMaterial */
function foliage(m: THREE.MeshStandardMaterial, o: { sway: number; flutter: number; trans: number; fill: number; h: number }) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime; sh.uniforms.uSunView = shared.uSunView;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", `#include <common>\nuniform float uTime;`).replace("#include <begin_vertex>", `#include <begin_vertex>
      {
        vec3 ip = vec3(0.0);
        #ifdef USE_INSTANCING
          ip = instanceMatrix[3].xyz;
        #endif
        float ph = ip.x * 0.37 + ip.z * 0.53;
        float hk = clamp(transformed.y / ${o.h.toFixed(2)}, 0.0, 1.4); hk *= hk;
        float w = sin(uTime * 1.1 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.4;
        transformed.x += w * ${o.sway.toFixed(3)} * hk;
        transformed.z += cos(uTime * 0.9 + ph) * ${(o.sway * 0.6).toFixed(3)} * hk;
        transformed.y += sin(uTime * 4.7 + ph + position.x * 2.1 + position.z * 1.7) * ${o.flutter.toFixed(3)} * hk;
      }`);
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>\nuniform vec3 uSunView;`).replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      {
        vec3 toFrag = normalize(-vViewPosition);
        float tr = pow(max(dot(toFrag, uSunView), 0.0), 3.0);
        totalEmissiveRadiance += diffuseColor.rgb * (vec3(0.75, 1.0, 0.35) * tr * ${o.trans.toFixed(3)} + ${o.fill.toFixed(3)});
      }`);
  };
  m.customProgramCacheKey = () => `coast-foliage-${o.sway}-${o.trans}-${o.fill}`;
  return m;
}

// ------------------------------------------------------------------------------------------------ geometry
/** the leaf card's blade half-width (fraction of the card) along v (0 = petiole … 1 = tip), measured from the texture */
const BLADE = [0.04, 0.11, 0.33, 0.41, 0.45, 0.47, 0.455, 0.44, 0.395, 0.3, 0.115];
const bladeHW = (t: number) => { const f = Math.max(0, Math.min(1, t)) * 10, i = Math.min(9, Math.floor(f)); return BLADE[i] + (BLADE[i + 1] - BLADE[i]) * (f - i); };
/** a leaf: V-folded ribbon along a drooping arc; UV maps the whole leaf card (petiole at v=0). `shaped` (far LODs):
 *  the ribbon follows the blade outline and only samples inside it, so it can be drawn OPAQUE (no alpha test —
 *  alpha-tested foliage defeats the tile GPU's hidden-surface removal; the field measured ~0.8 ms mostly from
 *  alpha-tested far plants) */
function leafGeo(base: THREE.Vector3, yaw: number, pitch0: number, droop: number, len: number, width: number, segs: number, cols: number, tint: THREE.Color, twist: number, curl = 0.22, shaped = false) {
  const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)), side = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
  const pts: THREE.Vector3[] = [base.clone()];
  let p = base.clone();
  for (let i = 1; i <= segs; i++) {
    const t = i / segs, pitch = pitch0 - droop * Math.pow(t, 1.25);
    p = p.clone().addScaledVector(dir, Math.cos(pitch) * len / segs).add(new THREE.Vector3(0, Math.sin(pitch) * len / segs, 0));
    pts.push(p);
  }
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, a = pts[Math.max(0, i - 1)], b = pts[Math.min(segs, i + 1)];
    const tan = b.clone().sub(a).normalize(), sd = side.clone().applyAxisAngle(tan, twist * t);
    const nrm = new THREE.Vector3().crossVectors(sd, tan).normalize();
    const ao = 0.5 + 0.5 * Math.min(1, t * 2.4);
    // blade width along the leaf follows the texture's blade outline (narrow petiole → full paddle → rounded tip)
    for (let j = 0; j < cols; j++) {
      let u = cols === 1 ? 0.5 : j / (cols - 1);
      if (shaped) u = 0.5 + (u - 0.5) * 2 * bladeHW(t) * 0.9;
      const s = (u - 0.5) * 2, off = s * width * 0.5;
      // tent-shaped cross-section: raised midrib, halves falling away and curling at the edges, more toward the tip
      const drop = (Math.abs(s) * 0.12 + s * s * curl) * width * (0.35 + 0.65 * t);
      const q = pts[i].clone().addScaledVector(sd, off).addScaledVector(nrm, -drop);
      pos.push(q.x, q.y, q.z); uv.push(u, t);
      const k = ao * (1 - 0.12 * Math.abs(s));
      col.push(tint.r * k, tint.g * k, tint.b * k);
    }
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < cols - 1; j++) { const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** swept tube along points with a radius function; UV u around, v = length/1.2; vertex colour AO toward the base */
function sweep(pts: THREE.Vector3[], radial: number, rad: (t: number) => number, aoBase = 0.6, capTop = false, nSeg = 0) {
  const curve = new THREE.CatmullRomCurve3(pts), n = nSeg || Math.max(2, pts.length * 3);
  const frames = curve.computeFrenetFrames(n, false);
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  let acc = 0, prev = curve.getPoint(0);
  for (let i = 0; i <= n; i++) {
    const t = i / n, c = curve.getPoint(t); acc += c.distanceTo(prev); prev = c;
    const N = frames.normals[i], B = frames.binormals[i], r = rad(t), k = aoBase + (1 - aoBase) * Math.min(1, t * 3);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a);
      pos.push(c.x + r * (cs * N.x + sn * B.x), c.y + r * (cs * N.y + sn * B.y), c.z + r * (cs * N.z + sn * B.z));
      uv.push(j / radial, acc / 1.2); col.push(k, k, k);
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < radial; j++) { const a = i * (radial + 1) + j, b = a + 1, c = a + radial + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  if (capTop) { const top = curve.getPoint(1), cap = new THREE.CircleGeometry(rad(1), radial); cap.rotateX(-Math.PI / 2); cap.translate(top.x, top.y, top.z); const cc = new Float32Array(cap.attributes.position.count * 3).fill(0.8); cap.setAttribute("color", new THREE.BufferAttribute(cc, 3)); return mergeGeometries([g, cap], false)!; }
  return g;
}

/** crinkled bag (teardrop lathe, jittered) hanging from `top`, length L */
function bagGeo(top: THREE.Vector3, L: number, R: number, radial: number, seed: number) {
  const r = rng(seed);
  // readable bags: a tied neck gathering into a full sack, straight sides, a soft rim at the bottom
  // where the lowest hand pokes out; vertical plastic folds + small random crinkles
  const prof: Array<[number, number]> = [[0.03, 0], [0.09, -0.03], [0.14, -0.07], [0.62, -0.17], [0.92, -0.32], [1.0, -0.52], [0.99, -0.74], [0.93, -0.92], [0.78, -0.99], [0.5, -1.0], [0.05, -1.0]];
  const pts = prof.map(([rr, y]) => new THREE.Vector2(Math.max(0.02, rr * R), y * L));
  const g = new THREE.LatheGeometry(pts, radial);
  const p = g.attributes.position, col = new Float32Array(p.count * 3), ph = r() * 6;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), rr = Math.hypot(x, z), a = Math.atan2(z, x);
    if (rr > 0.05) { const fold = 0.075 * Math.sin(a * 7 + ph + y * 2.5) + 0.04 * Math.sin(a * 13 - y * 9); const k = 1 + fold * Math.min(1, -y / (L * 0.25)) + (r() - 0.5) * 0.06; p.setX(i, x * k); p.setZ(i, z * k); }
    const shade = 0.82 + 0.18 * Math.min(1, -y / (L * 0.4));
    col[i * 3] = shade; col[i * 3 + 1] = shade; col[i * 3 + 2] = shade;
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.translate(top.x, top.y, top.z);
  return g;
}
/** the lowest hand poking out under the bag rim: 7 short green fingers curving out + up (fat prisms with a dark tip) */
function bagHand(bottom: THREE.Vector3, R: number, seed: number) {
  const r = rng(seed), gs: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + r() * 0.4, d = R * (0.35 + r() * 0.3);
    const b0 = bottom.clone().add(new THREE.Vector3(Math.cos(a) * d, 0.06, Math.sin(a) * d));
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const pts = [b0, b0.clone().addScaledVector(out, 0.07).add(new THREE.Vector3(0, -0.1, 0)), b0.clone().addScaledVector(out, 0.13).add(new THREE.Vector3(0, -0.12, 0)), b0.clone().addScaledVector(out, 0.19).add(new THREE.Vector3(0, -0.07, 0))];
    gs.push(sweep(pts, 5, (t) => 0.034 * (1 - 0.55 * t * t), 0.75, false, 4));
  }
  return mergeGeometries(gs, false)!;
}

interface Variant { plant: THREE.BufferGeometry[]; stem: THREE.BufferGeometry[]; bag: THREE.BufferGeometry[] }

interface LeafSpec { yaw: number; pitch0: number; droop: number; len: number; tint: THREE.Color; twist: number; petiole: number; baseDrop: number; dead?: boolean }
interface PlantSpec { off: THREE.Vector3; h: number; r0: number; lean: THREE.Vector3; leaves: LeafSpec[] }

function plantSpec(r: () => number, off: THREE.Vector3, h: number, nLeaf: number, lenK: number, r0: number, dead: number): PlantSpec {
  const leaves: LeafSpec[] = [];
  const yaw0 = r() * 6.283;
  for (let i = 0; i < nLeaf; i++) {
    const age = nLeaf === 1 ? 0.5 : i / (nLeaf - 1); // 0 youngest (upright, rolled) … 1 oldest (low, droopy)
    const green = new THREE.Color().setHSL(0.24 + r() * 0.035 - age * 0.02, 0.5 + r() * 0.2, 0.52 + r() * 0.1 - age * 0.06);
    const tint = new THREE.Color(0.86 + r() * 0.16, 0.92 + r() * 0.1, 0.8 + r() * 0.12).multiply(new THREE.Color(1, 1, 1).lerp(green.multiplyScalar(1.7), 0.35));
    leaves.push({
      yaw: yaw0 + i * 2.39996 + (r() - 0.5) * 0.4,
      pitch0: (80 - 52 * age + (r() - 0.5) * 10) * Math.PI / 180,
      droop: (22 + 78 * Math.pow(age, 1.15) + r() * 16) * Math.PI / 180,
      len: (2.0 + r() * 0.6) * lenK * (0.72 + 0.28 * Math.min(1, age * 2.5)),
      tint, twist: (r() - 0.5) * 0.8, petiole: (0.3 + r() * 0.25) * lenK, baseDrop: 0.06 + age * 0.55 * lenK,
    });
  }
  for (let k = 0; k < dead; k++) leaves.push({ yaw: r() * 6.283, pitch0: -1.2 - r() * 0.2, droop: 0.2, len: (1.1 + r() * 0.5) * lenK, tint: new THREE.Color(0.95, 0.7 + r() * 0.1, 0.42), twist: 1.2 * (r() - 0.5), petiole: 0.05, baseDrop: 0.45 + k * 0.25, dead: true });
  return { off, h, r0, lean: new THREE.Vector3((r() - 0.5) * 0.22, 0, (r() - 0.5) * 0.22), leaves };
}

function plantGeo(p: PlantSpec, lod: number, leafGs: THREE.BufferGeometry[], stemGs: THREE.BufferGeometry[]) {
  // perf (211 k tris of LOD2 plants otherwise): LOD1 leaves are flat cards (the V-fold doesn't read past 26 m),
  // LOD2+ two-segment outline ribbons
  const segs = [5, 3, 2, 2][lod], cols = [5, 3, 2, 2][lod], radial = [8, 5, 4, 3][lod], stemSeg = [6, 3, 2, 1][lod];
  const o = p.off, stemPts = [o.clone().add(new THREE.Vector3(0, -0.15, 0)), o.clone().add(new THREE.Vector3(p.lean.x * 0.3, p.h * 0.5, p.lean.z * 0.3)), o.clone().add(new THREE.Vector3(p.lean.x, p.h, p.lean.z))];
  const top = stemPts[2];
  const list = lod === 3 ? p.leaves.filter((L, i) => !L.dead && i % 3 === 1) : lod === 2 ? p.leaves.filter((L, i) => !L.dead && i % 2 === 0) : lod === 1 ? p.leaves.filter((L) => !L.dead || L.baseDrop < 0.6) : p.leaves;
  for (const L of list) {
    const dir = new THREE.Vector3(Math.cos(L.yaw), 0, Math.sin(L.yaw));
    const pBase = top.clone().add(new THREE.Vector3(0, -L.baseDrop, 0));
    const lBase = pBase.clone().addScaledVector(dir, L.petiole * Math.cos(L.pitch0)).add(new THREE.Vector3(0, L.petiole * Math.sin(L.pitch0), 0));
    // perf: EVERY ring uses the outline-shaped opaque leaf (no alpha test — an alpha-tested near ring costs ~0.5 ms:
    // alpha test defeats the tile GPU's hidden-surface removal, in the main AND the shadow pass); LOD0 keeps 7 columns so
    // the paddle outline stays smooth up close
    leafGs.push(leafGeo(lBase, L.yaw, L.pitch0 - 0.08, L.droop, L.len, L.len * (L.dead ? 0.28 : 0.4), L.dead ? Math.max(2, segs - 3) : segs, L.dead ? 2 : cols, L.tint, L.twist, L.dead ? 0.5 : 0.22, true));
    // petiole: a fleshy sheath that wraps out of the crown (thick at the base, tapering into the midrib) along an arc
    // (not thin brown sticks)
    if (lod === 0 && !L.dead) { const mid = pBase.clone().lerp(lBase, 0.5).add(new THREE.Vector3(0, 0.06, 0)); stemGs.push(sweep([pBase.clone().addScaledVector(dir, -0.06), mid, lBase], 5, (t) => 0.075 * (1 - t) + 0.024, 0.85, false, 4)); }
  }
  stemGs.push(sweep(stemPts, radial, (t) => p.r0 * (1 - 0.4 * t) + p.r0 * 0.45 * Math.pow(Math.max(0, 1 - t / 0.12), 2), 0.5, true, stemSeg));
}

function buildVariant(v: number): Variant {
  const r = rng(700 + v * 31);
  // taller plants (pseudostem 2.7–3.6 m → 4–5 m to the leaf tips) so the canopies overlap
  const h = 2.7 + v * 0.32 + r() * 0.3;
  const main = plantSpec(r, new THREE.Vector3(0, 0, 0), h, 12 + v, 1.0 + v * 0.05, 0.17, 3);
  // the pseudostem stands straight (its collider is a vertical box inside it — shared bananaColliders)
  main.lean.set(0, 0, 0);
  const fa = r() * 6.28;
  // a fuller follower (the lower storey, so no bare stems): 0.6 h with longer leaves, and a bigger sucker
  const follower = plantSpec(r, new THREE.Vector3(Math.cos(fa) * 0.6, 0, Math.sin(fa) * 0.6), h * 0.6, 8, 0.78, 0.11, 1);
  const sa = fa + 2 + r();
  const sucker = plantSpec(r, new THREE.Vector3(Math.cos(sa) * 0.5, 0, Math.sin(sa) * 0.5), 0.55, 5, 0.5, 0.06, 0);
  for (const L of sucker.leaves) { L.pitch0 = (70 + r() * 15) * Math.PI / 180; L.droop = 0.5 + r() * 0.4; }
  const bagYaw = r() * 6.283, bagDir = new THREE.Vector3(Math.cos(bagYaw), 0, Math.sin(bagYaw));
  const top = new THREE.Vector3(main.lean.x, h, main.lean.z);
  const plantLod = (lod: number) => {
    const leafGs: THREE.BufferGeometry[] = [], stemGs: THREE.BufferGeometry[] = [], minorGs: THREE.BufferGeometry[] = [];
    plantGeo(main, lod, leafGs, stemGs);
    // (the follower + sucker are young pups — soft, no collider: their stems ride with the leaves)
    if (lod < 2) plantGeo(follower, lod, leafGs, minorGs);
    if (lod === 0) plantGeo(sucker, lod, leafGs, minorGs);
    if (lod === 3) { stemGs.length = 0; const st = new THREE.CylinderGeometry(0.1, 0.16, h, 3, 1, true); st.translate(main.lean.x * 0.5, h / 2, main.lean.z * 0.5); const cc = new Float32Array(st.attributes.position.count * 3).fill(0.7); st.setAttribute("color", new THREE.BufferAttribute(cc, 3)); stemGs.push(st); }
    const leafGeoAll = mergeGeometries(leafGs, false)!;
    const stemAll = mergeGeometries(stemGs, false)!;
    const minorAll = minorGs.length ? mergeGeometries(minorGs, false)! : null;
    // EVERY LOD is ONE draw (perf: draws, not triangles, dominate the field's cost) — the stem samples a solid green
    // texel of the leaf card and carries its look in vertex colours: a smooth green → olive sheath (no
    // bamboo rings) with soft vertical dry streaks (by angle round the stem) and the AO toward the base
    for (const sg of minorAll ? [stemAll, minorAll] : [stemAll]) {
      const suv = sg.attributes.uv as THREE.BufferAttribute, sp = sg.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < suv.count; i++) suv.setXY(i, 0.42, 0.45);
      const sc = sg.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < sc.count; i++) {
        const a = Math.atan2(sp.getZ(i), sp.getX(i)), streak = 0.5 + 0.5 * Math.sin(a * 5 + sp.getY(i) * 0.4), dry = Math.max(0, streak - 0.55) * 1.6;
        sc.setXYZ(i, sc.getX(i) * (0.78 + 0.3 * dry), sc.getY(i) * (0.66 + 0.06 * dry), sc.getZ(i) * (0.4 + 0.02 * dry));
      }
    }
    // the pseudostems are their OWN instanced mesh ("banana-stem": hard — they carry the colliders) so the
    // collider ≡ visual check sees them; the leaves stay "banana-leaf" (soft, no colliders)
    return { leaf: minorAll ? mergeGeometries([minorAll, leafGeoAll], false)! : leafGeoAll, stem: stemAll };
  };
  const bagLod = (lod: number) => {
    // the peduncle arches out of the crown and hangs the bagged bunch beside the stem
    // the bunch hangs clear BELOW the crown on an arching stalk (the bags read from 40 m; higher, they hide in the
    // leaves), bigger bag
    const bagTop = top.clone().addScaledVector(bagDir, 0.62).add(new THREE.Vector3(0, -0.85, 0));
    const BL = 1.15, BR = 0.36;
    const bag = bagGeo(bagTop, BL, BR, [18, 9, 5, 4][lod], 900 + v);
    const stalk = sweep([top.clone().add(new THREE.Vector3(0, -0.15, 0)), top.clone().addScaledVector(bagDir, 0.45).add(new THREE.Vector3(0, 0.1, 0)), top.clone().addScaledVector(bagDir, 0.62).add(new THREE.Vector3(0, -0.35, 0)), bagTop.clone().add(new THREE.Vector3(0, 0.12, 0))], [6, 4, 3, 3][lod], (t) => 0.05 - 0.012 * t, 0.8);
    // ONE material for bag + stalk + fruit + tie: the colour lives in the vertex colours
    const tint = (g: THREE.BufferGeometry, rgb: [number, number, number], keep = false) => {
      const n = g.attributes.position.count, old = g.attributes.color as THREE.BufferAttribute | undefined, cc = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const k = keep && old ? old.getX(i) : 1; cc[i * 3] = rgb[0] * k; cc[i * 3 + 1] = rgb[1] * k; cc[i * 3 + 2] = rgb[2] * k; }
      g.setAttribute("color", new THREE.BufferAttribute(cc, 3));
      if (!g.index) g.setIndex([...Array(n).keys()]);
      g.deleteAttribute("normal"); g.computeVertexNormals();
      for (const a of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(a)) g.deleteAttribute(a);
      if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
      return g;
    };
    // a light sky-blue plastic (target lit #3a9ee8 → #7cc4f2)
    const BLUE: [number, number, number] = [0.1, 0.46, 1.0], GREEN: [number, number, number] = [0.2, 0.3, 0.07], FRUIT: [number, number, number] = [0.3, 0.55, 0.08], TIE: [number, number, number] = [0.03, 0.03, 0.035];
    if (lod >= 2) { const oc = new THREE.OctahedronGeometry(0.33, 0); oc.scale(0.95, 1.7, 0.95); oc.translate(bagTop.x, bagTop.y - 0.55, bagTop.z); return tint(oc, BLUE); }
    const parts = [tint(bag, BLUE, true), tint(stalk, GREEN)];
    if (lod === 0) {
      parts.push(tint(bagHand(bagTop.clone().add(new THREE.Vector3(0, -BL, 0)), BR, 950 + v), FRUIT, true));
      const tie = new THREE.TorusGeometry(0.05, 0.022, 5, 10); tie.rotateX(Math.PI / 2); tie.translate(bagTop.x, bagTop.y - 0.035, bagTop.z);
      parts.push(tint(tie, TIE));
    }
    return mergeGeometries(parts, false)!;
  };
  const pl = [0, 1, 2, 3].map(plantLod);
  return { plant: pl.map((q) => q.leaf), stem: pl.map((q) => q.stem), bag: [0, 1, 2, 3].map(bagLod) };
}


// ------------------------------------------------------------------------------------------------ field
export class BananaField {
  private variants: Variant[] = [];
  private meshes: THREE.InstancedMesh[][] = [];   // [variant*3+lod] plant, bag
  private lastPos = new THREE.Vector3(Infinity, 0, 0);
  private lastDir = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private m = new THREE.Matrix4();
  private mats: THREE.Matrix4[];
  private cols: THREE.Color[] = [];
  private bagCols: THREE.Color[] = [];
  private sphere = new THREE.Sphere(new THREE.Vector3(), 4.5);
  readonly group = new THREE.Group();

  constructor(private spots: Spot[], leafTex: THREE.Texture, leafN: THREE.Texture) {
    const stemSet = T.bananaTrunk(), crinkle = T.crinkle();
    const leafMat = foliage(new THREE.MeshStandardMaterial({ map: leafTex, normalMap: leafN, normalScale: new THREE.Vector2(0.8, 0.8), alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.46, vertexColors: true, envMapIntensity: 0.8 }), { sway: 0.07, flutter: 0.035, trans: 0.55, fill: 0.06, h: 2.8 });
    const leafFar = foliage(new THREE.MeshStandardMaterial({ map: leafTex, normalMap: leafN, normalScale: new THREE.Vector2(0.6, 0.6), side: THREE.DoubleSide, roughness: 0.5, vertexColors: true, envMapIntensity: 0.8 }), { sway: 0.07, flutter: 0.035, trans: 0.55, fill: 0.06, h: 2.8 });
    leafFar.customProgramCacheKey = () => "coast-foliage-far";
    // perf (GPU timer: the field is ~0.7–0.9 ms of the poi-07 frame, almost
    // all fragment shading of leaves covering half the frame): past the LOD0 ring the leaves shade with a LAMBERT
    // material (no GGX specular, no IBL, no normal map) — the same leaf card, vertex + instance colours, translucency
    const leafLite = foliage(new THREE.MeshLambertMaterial({ map: leafTex, side: THREE.DoubleSide, vertexColors: true }) as unknown as THREE.MeshStandardMaterial, { sway: 0.07, flutter: 0.035, trans: 0.55, fill: 0.08, h: 2.8 });
    leafLite.customProgramCacheKey = () => "coast-foliage-lite";
    const stemMat = foliage(new THREE.MeshStandardMaterial({ map: stemSet.map, normalMap: stemSet.normalMap, roughness: 0.78, vertexColors: true, color: 0xc9d69a }), { sway: 0.07, flutter: 0, trans: 0, fill: 0.04, h: 2.8 });
    // glossy translucent blue plastic: soft vertical folds (no drawn scribbles), clearcoat sheen, strong back-light glow
    const bc = TX.bagCrinkle();
    const bagMat = foliage(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0.0, normalMap: bc.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), vertexColors: true, emissive: 0x1a5aa6, emissiveIntensity: 0.42, envMapIntensity: 1.5 }), { sway: 0.07, flutter: 0.01, trans: 0.8, fill: 0.07, h: 2.8 });
    void crinkle;
    // the plastic's glow belongs to the bag only (blue vertex channel ≈ 1): the fruit, stalk and tie stay unlit-free
    { const prev = bagMat.onBeforeCompile; bagMat.onBeforeCompile = (sh, rr) => { prev.call(bagMat, sh, rr); sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance *= vColor.b;\n#endif"); }; bagMat.customProgramCacheKey = () => "coast-bag-r4"; }
    const stalkMat = foliage(new THREE.MeshStandardMaterial({ color: 0x6f8a3a, roughness: 0.7, vertexColors: true }), { sway: 0.07, flutter: 0, trans: 0, fill: 0.03, h: 2.8 });
    for (const m of [leafMat, leafFar, leafLite, stemMat, bagMat, stalkMat]) m.name = "plantation:banana";
    for (let v = 0; v < 3; v++) this.variants.push(buildVariant(v));
    const counts = [0, 0, 0], bagCounts = [0, 0, 0];
    for (const s of spots) { counts[s[4]]++; if (s[5]) bagCounts[s[4]]++; }
    const all = spots.length, allBags = bagCounts[0] + bagCounts[1] + bagCounts[2];
    for (let v = 0; v < 3; v++) for (let lod = 0; lod < 4; lod++) {
      // LOD3 draws every plant with variant 0 (one draw); LOD ≥ 1 plants are one material (one draw each)
      // LOD ≥ 1 draws every plant with variant 0 (one draw per ring: past 20 m the variants don't read, the draws do)
      const cap = lod >= 1 ? (v === 0 ? all : 1) : v === 1 ? 1 : v === 2 ? counts[1] + counts[2] : counts[v];
      const capB = lod >= 1 ? (v === 0 ? allBags : 1) : v === 1 ? 1 : Math.max(1, v === 2 ? bagCounts[1] + bagCounts[2] : bagCounts[v]);
      const pm = new THREE.InstancedMesh(this.variants[v].plant[lod], lod === 0 ? leafFar : leafLite, Math.max(1, cap));
      const bm = new THREE.InstancedMesh(this.variants[v].bag[lod], bagMat, capB);
      const sm = new THREE.InstancedMesh(this.variants[v].stem[lod], lod === 0 ? leafFar : leafLite, Math.max(1, cap));
      for (const im of [pm, bm, sm]) {
        im.count = 0; im.frustumCulled = false; im.castShadow = lod === 0; im.receiveShadow = lod < 2; im.name = `plantation:banana-leaf:v${v}:lod${lod}`; // "leaf" = soft for the parity tool (the pseudostems carry their own colliders)
        im.userData.castShadow = lod === 0; im.userData.farShadow = false;
        this.group.add(im);
      }
      sm.name = `plantation:banana-stem:v${v}:lod${lod}`;
      this.meshes.push([pm, bm, sm]);
    }
    // per-plant tint (leaf greens drift yellow/blue-green, bags lighter/darker) + a small lean → no tiled carpet
    const rv = rng(4242);
    this.cols = spots.map(() => { const y = rv(), k = 0.9 + rv() * 0.18; return new THREE.Color(k * (0.96 + y * 0.12), k * (1 + (rv() - 0.5) * 0.06), k * (1.02 - y * 0.2)); });
    this.bagCols = spots.map(() => { const k = 0.86 + rv() * 0.26, h = (rv() - 0.5) * 0.12; return new THREE.Color(k * (1 - h), k, k * (1 + h * 0.5)); });
    const up = new THREE.Vector3(0, 1, 0), ax = new THREE.Vector3();
    this.mats = spots.map(([x, z, yaw, s]) => {
      const lean = rv() * 0.09 * 0, la = rv() * 6.283; ax.set(Math.cos(la), 0, Math.sin(la)); // (no lean — stem ≡ collider)
      const q = new THREE.Quaternion().setFromAxisAngle(ax, lean).multiply(new THREE.Quaternion().setFromAxisAngle(up, yaw));
      return new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s * (0.92 + ((x * 7.13) % 1 + 1) % 1 * 0.16), s));
    });
  }

  /** set ground heights once terrain is known */
  ground(h: (x: number, z: number) => number) { for (let i = 0; i < this.spots.length; i++) { const e = this.mats[i].elements; e[13] = h(this.spots[i][0], this.spots[i][1]) - 0.06; } }

  update(cam: THREE.PerspectiveCamera, force = false) {
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    if (!force && cam.position.distanceToSquared(this.lastPos) < 9 && dir.dot(this.lastDir) > 0.995) return;
    this.lastPos.copy(cam.position); this.lastDir.copy(dir);
    // widened frustum (bigger fov) so plants just off-screen still cast shadows / don't pop while turning
    // (perf: a scratch camera, never cam.clone() — that deep-copies everything parented to the camera, the whole viewmodel)
    const fc = FC; fc.aspect = cam.aspect; fc.near = cam.near; fc.zoom = cam.zoom; fc.fov = Math.min(120, cam.fov * 1.35); fc.far = 700; fc.updateProjectionMatrix();
    cam.updateMatrixWorld(); fc.matrixWorld.copy(cam.matrixWorld); fc.matrixWorldInverse.copy(cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m.multiplyMatrices(fc.projectionMatrix, fc.matrixWorldInverse));
    for (const [pm, bm, sm] of this.meshes) { pm.count = 0; bm.count = 0; sm.count = 0; }
    const cx = cam.position.x, cz = cam.position.z;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i], dx = s[0] - cx, dz = s[1] - cz, d = Math.sqrt(dx * dx + dz * dz);
      this.sphere.center.set(s[0], this.mats[i].elements[13] + 1.8, s[1]);
      if (!NOCULL && d > 8 && !this.frustum.intersectsSphere(this.sphere)) continue;
      if (!NOCULL && d > LOD_D[3]) continue;
      // (`?nocull`, the parity tool: every plant at LOD1 — the stem each collider wraps is drawn at any distance)
      const lod = NOCULL ? 1 : d < LOD_D[0] ? 0 : d < LOD_D[1] ? 1 : d < LOD_D[2] ? 2 : 3;
      // perf: two variants in the LOD0 ring (v1 folds into v2 — per-plant scale, lean + tint keep the variety), one
      // beyond (2 draws fewer at every view)
      const [pm, bm, sm] = this.meshes[(lod >= 1 ? 0 : s[4] === 1 ? 2 : s[4]) * 4 + lod];
      sm.setColorAt(sm.count, this.cols[i]);
      sm.setMatrixAt(sm.count++, this.mats[i]);
      pm.setColorAt(pm.count, this.cols[i]);
      pm.setMatrixAt(pm.count++, this.mats[i]);
      if (s[5]) { bm.setColorAt(bm.count, this.bagCols[i]); bm.setMatrixAt(bm.count++, this.mats[i]); }
    }
    for (const [pm, bm, sm] of this.meshes) {
      pm.visible = pm.count > 0; bm.visible = bm.count > 0; sm.visible = sm.count > 0;
      pm.instanceMatrix.needsUpdate = true; bm.instanceMatrix.needsUpdate = true; sm.instanceMatrix.needsUpdate = true;
      if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
      if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
      if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    }
  }

  static attach(ctx: WorldCtx, field: BananaField) {
    ctx.scene.add(field.group);
    const sunV = new THREE.Vector3();
    ctx.onUpdate((_dt, t) => {
      shared.uTime.value = t;
      const sd = ctx.shared.get("sunDir") as THREE.Vector3 | undefined;
      if (sd) { sunV.copy(sd).transformDirection(ctx.camera.matrixWorldInverse); shared.uSunView.value.copy(sunV); }
      field.update(ctx.camera);
    });
  }
}
