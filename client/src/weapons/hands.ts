// First-person kong hands that actually hold the guns.
//
// The 3P kong's closed fist is a rigid ball of fingers that could only be pushed THROUGH a grip (fingers poking out
// of the front, the thumb out of the back). This is a dedicated 1P hand: one SkinnedMesh per hand (skin + peel + fur
// = 3 draws), 18 bones, and a grip solver that wraps every finger segment AROUND the grip's cross-section (an
// ellipse with semi-axes a × b), so a finger can never pass through it:
//
//   hand frame (canonical right hand): the grip axis = +Y (index finger at +Y, pinky at −Y), the palm lies on the +X
//   side of the grip (its inner face touching the grip at x = a), the fingers wrap +X → −Z → −X, the thumb wraps the
//   other way round the back (+Z) to meet them. The wrist / forearm leave the heel of the palm toward +Z.
//   The left hand is the mirror image (x → −x): palm on the −X side.
//
// Posing: setGrip(a, b, curl) → finger / thumb bone angles (curl 0 = relaxed open hand, 1 = wrapped tight),
// aimForearm(target) → the wrist bone turns the forearm toward an elbow point (camera space, off screen), clamped so
// the wrist never breaks. Zero allocation per frame.
//
// The LOOK of the target-art kong — chunky bare kong fingers in the kong's tan skin (knuckle creases, pale nails), the back
// of the hand and the wrist wrapped in a thick banana-PEEL cuff (sugar-spotted ripe yellow, the peel's petals folded
// back over the arm, their cream undersides showing) and a forearm of big sculpted chocolate-brown fur clumps
// (shingled, pointed toward the hand, lit crests and dark gaps) instead of a fur-textured tube. Four separate fingers
// (round sections, no overlap: overlapping ellipses read as a mitten of beads).
import * as THREE from "three";
import { rbox } from "./lib/geo";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { flag } from "../flags";
import { releaseGeometryAfterUpload } from "../engine/geometry-release";

// ------------------------------------------------------------------------------------------------ dimensions (m)
/** palm: thickness (x), width along the grip (y), length heel → knuckles (z) */
const PT = 0.036, PW = 0.106, PL = 0.09;
/** finger rows along the grip axis (index → pinky): 26 mm apart, the fat fingers touch side by side */
const FY = [0.039, 0.013, -0.013, -0.038];
/** finger radius (the wrap solver's offset) — fat, SHORT kong fingers: round a gun's grip they reach its front corner
 *  (a row of fingers seen from the side), not all the way round to the far side (four fingertips seen end-on) */
const FR = [0.0148, 0.0154, 0.0149, 0.0132];
const FL: number[][] = [[0.034, 0.024, 0.02], [0.037, 0.026, 0.021], [0.035, 0.025, 0.02], [0.028, 0.02, 0.017]];
const TR = [0.0164, 0.0148, 0.0136];
const TL = [0.03, 0.025, 0.021];
/** the thumb base (palm space): heel end, index side, grip face */
const T0 = new THREE.Vector3(-PT / 2 + 0.013, PW / 2 - 0.004, PL / 2 - 0.024);
// long enough to always leave the frame (the 55° viewmodel projection holds the guns further out; a 0.9 m forearm
// ended in view as a ragged fur stump)
const FORE_LEN = 1.5;
/** forearm / cuff girth multiplier */
const ARM_K = 1.45;

/** the v2 kong arms — a gorilla forearm that swells to ~2× the wrist
 *  right behind a thick banana-peel cuff, big pointed fur clumps that break the silhouette, a skin (not peel) back of the
 *  hand with knuckle bumps, chunkier squared-off fingers. Same bones, grip solver and 3 draws per hand; fewer triangles.
 *  A/B: `?arms=2` = v2, `?arms=1` = the current arms; with no query, localStorage `kr.arms` = "2" picks v2. Default = current. */
export const ARMS2: boolean = (() => {
  try {
    if (typeof location === "undefined") return false;
    const q = flag("arms");
    if (q) return q === "2";
    return typeof localStorage !== "undefined" && localStorage.getItem("kr.arms") === "2";
  } catch { return false; }
})();

/** dev A/B (`?armsab`, a bench script): every hand mesh is kept so the bench can swap v1 ↔ v2 geometry
 *  on the live meshes (same bones) and time both in ONE page at the same frame — null (nothing kept) otherwise */
const AB: THREE.SkinnedMesh[] | null = (() => { try { return flag("armsab") ? [] : null; } catch { return null; } })();
export function swapArmsAB(v2: boolean): number {
  if (!AB) return 0;
  for (const m of AB) m.geometry = handGeo(m.name.endsWith("L") ? "L" : "R", v2).geo;
  return AB.length;
}

export interface HandMats { glove: THREE.Material; peel: THREE.Material; fur: THREE.Material }

let mats: HandMats | null = null;
/** shared materials: the kong's tan skin (fingers, palm; `glove` keeps its old name for callers), the banana-peel wrap,
 *  the clumped forearm fur */
export function handMaterials(): HandMats {
  if (mats) return mats;
  const sk = skinTex(), pt = peelTex(), ft = furTex();
  // soft, slightly waxy kong skin: vertex colours carry the tones (creases, nails, knuckles), a fine pore bump
  const glove = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, roughness: 0.58, metalness: 0, bumpMap: sk, bumpScale: 0.5, envMapIntensity: 0.7 });
  // the peel: ripe yellow with sugar spots + fibres (texture) × vertex tones (darker edges), a satin sheen like the guns'
  const peel = new THREE.MeshPhysicalMaterial({ color: "#ffffff", vertexColors: true, map: pt.map, bumpMap: pt.bump, bumpScale: 0.6, roughness: 0.42, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.35, envMapIntensity: 0.6 });
  // fur clumps: vertex colours (dark roots → lit tips, darker clump edges) × a fine strand texture along each clump;
  // double-sided: a lifted clump tip shows its underside
  const fur = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, map: ft.map, bumpMap: ft.bump, bumpScale: 1.1, roughness: 0.84, metalness: 0, envMapIntensity: 0.55, side: THREE.DoubleSide });
  glove.name = "vm-skin"; peel.name = "vm-peel"; fur.name = "vm-fur";
  mats = { glove, peel, fur };
  return mats;
}

function canvas(w: number, h: number) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** skin: a mid-grey bump with soft pores and fine wrinkles (tileable) */
function skinTex(): THREE.Texture {
  const c = canvas(256, 256), g = c.getContext("2d")!, r = rng(7);
  g.fillStyle = "#808080"; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) { const x = r() * 256, y = r() * 256, s = 0.8 + r() * 1.6, v = 96 + r() * 30 | 0; g.fillStyle = `rgba(${v},${v},${v},0.7)`; g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = "rgba(70,70,70,0.35)"; g.lineWidth = 1;
  for (let i = 0; i < 70; i++) { const x = r() * 256, y = r() * 256; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + (r() - 0.5) * 30, y + (r() - 0.5) * 6, x + (r() - 0.5) * 50, y + (r() - 0.5) * 10); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}

/** banana peel: ripe yellow, faint fibres, brown sugar spots + specks (map, sRGB) and their relief (bump) — tileable */
function peelTex(): { map: THREE.Texture; bump: THREE.Texture } {
  const S = 256, c = canvas(S, S), g = c.getContext("2d")!, b = canvas(S, S), gb = b.getContext("2d")!, r = rng(23);
  g.fillStyle = "#f4c11b"; g.fillRect(0, 0, S, S);
  gb.fillStyle = "#808080"; gb.fillRect(0, 0, S, S);
  const wrap = (f: (ox: number, oy: number) => void) => { for (const ox of [0, -S, S]) for (const oy of [0, -S, S]) f(ox, oy); };
  // fibres: long faint streaks (lighter + deeper yellow)
  for (let i = 0; i < 160; i++) {
    const x = r() * S, y = r() * S, len = 30 + r() * 90, w = 0.6 + r() * 1.4, light = r() < 0.5;
    wrap((ox, oy) => { g.strokeStyle = light ? "rgba(255,226,92,0.35)" : "rgba(214,150,10,0.28)"; g.lineWidth = w; g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(x + ox + (r() - 0.5) * 4, y + oy + len); g.stroke(); });
  }
  // sugar spots: soft brown blobs with a darker heart, a few clusters
  for (let i = 0; i < 16; i++) {
    const x = r() * S, y = r() * S, rr = 2 + r() * 5, e = 0.6 + r() * 0.8, a = r() * Math.PI;
    wrap((ox, oy) => {
      g.save(); g.translate(x + ox, y + oy); g.rotate(a); g.scale(1, e);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, rr * 1.6); gr.addColorStop(0, "rgba(92,52,16,0.95)"); gr.addColorStop(0.45, "rgba(120,72,22,0.8)"); gr.addColorStop(1, "rgba(150,96,24,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, rr * 1.6, 0, Math.PI * 2); g.fill(); g.restore();
      gb.save(); gb.translate(x + ox, y + oy); gb.rotate(a); gb.scale(1, e); gb.fillStyle = "rgba(90,90,90,0.8)"; gb.beginPath(); gb.arc(0, 0, rr, 0, Math.PI * 2); gb.fill(); gb.restore();
    });
  }
  for (let i = 0; i < 40; i++) { const x = r() * S, y = r() * S, rr = 0.5 + r() * 1.0; wrap((ox, oy) => { g.fillStyle = "rgba(80,46,14,0.75)"; g.beginPath(); g.arc(x + ox, y + oy, rr, 0, Math.PI * 2); g.fill(); }); }
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(b); bump.wrapS = bump.wrapT = THREE.RepeatWrapping; bump.anisotropy = 4;
  return { map, bump };
}

/** fur strands along v (a near-white multiply map: the clump colours live in the vertex colours) + their relief */
function furTex(): { map: THREE.Texture; bump: THREE.Texture } {
  const W = 256, H = 256;
  const c = canvas(W, H), g = c.getContext("2d")!, b = canvas(W, H), gb = b.getContext("2d")!, r = rng(11);
  g.fillStyle = "#d8d8d8"; g.fillRect(0, 0, W, H);
  gb.fillStyle = "#7a7a7a"; gb.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) {
    const x = r() * W, y = r() * H, len = 14 + r() * 40, bend = (r() - 0.5) * 5, w = 0.6 + r() * 1.2, tone = r();
    const v = tone < 0.55 ? 150 + r() * 40 : tone < 0.85 ? 235 + r() * 20 : 95 + r() * 30, lum = tone < 0.55 ? 110 : tone < 0.85 ? 190 : 60;
    for (const ox of [0, -W, W]) for (const oy of [0, -H, H]) {
      if (x + ox < -20 || x + ox > W + 20 || y + oy < -60 || y + oy > H + 60) continue;
      g.strokeStyle = `rgba(${v | 0},${v | 0},${v | 0},0.55)`; g.lineWidth = w; g.beginPath(); g.moveTo(x + ox, y + oy); g.quadraticCurveTo(x + ox + bend, y + oy + len / 2, x + ox + bend * 0.3, y + oy + len); g.stroke();
      gb.strokeStyle = `rgba(${lum},${lum},${lum},0.6)`; gb.lineWidth = w; gb.beginPath(); gb.moveTo(x + ox, y + oy); gb.quadraticCurveTo(x + ox + bend, y + oy + len / 2, x + ox + bend * 0.3, y + oy + len); gb.stroke();
    }
  }
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(b); bump.wrapS = bump.wrapT = THREE.RepeatWrapping; bump.anisotropy = 8;
  return { map, bump };
}

// ------------------------------------------------------------------------------------------------ geometry
// palette — the third-person kong's (the sculpt: deep chocolate fur ~#431c0c, cream fists and
// fingers ~#dc9659), peel #f4c218
const SKIN = new THREE.Color("#dc9659"), SKIN_SH = new THREE.Color("#b37440"), CREASE = new THREE.Color("#84482a"), NAIL = new THREE.Color("#f2c99a");
const PALM = new THREE.Color("#cf8a52"), PEEL_IN = new THREE.Color("#f0deaf"), PEEL_EDGE = new THREE.Color("#b98a3c"), WHITE = new THREE.Color(1, 1, 1);
// (the fur map multiplies by ~0.85: the clump mid lands on the sculpt's #431c0c)
const FUR_ROOT = new THREE.Color("#2e1209"), FUR_MID = new THREE.Color("#4f2210"), FUR_TIP = new THREE.Color("#7a3a1c"), FUR_CORE = new THREE.Color("#2a1108");

function colorize(g: THREE.BufferGeometry, c: THREE.Color) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}
/** per-vertex colour from a function of the vertex position */
function paint(g: THREE.BufferGeometry, f: (p: THREE.Vector3, out: THREE.Color) => void) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3), p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < n; i++) { p.fromBufferAttribute(g.attributes.position as THREE.BufferAttribute, i); f(p, c); a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}
function skin(g: THREE.BufferGeometry, bone: number, bone2 = bone, w2: (p: THREE.Vector3) => number = () => 0) {
  const n = g.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(g.attributes.position as THREE.BufferAttribute, i);
    const k = bone2 === bone ? 0 : Math.min(1, Math.max(0, w2(p)));
    si[i * 4] = bone; si[i * 4 + 1] = bone2; sw[i * 4] = 1 - k; sw[i * 4 + 1] = k;
  }
  g.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4));
  g.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
  return g;
}

interface HandGeo { geo: THREE.BufferGeometry; bones: THREE.Bone[]; /** ?geofree: the skinned bind-pose bounds */ bounds?: [THREE.Box3, THREE.Sphere] }

// v2 fur: a step warmer / lighter than v1 (the target art's mid-brown clumps with lit tips; v1 read as a black stump)
const FUR2_ROOT = new THREE.Color("#3a170b"), FUR2_MID = new THREE.Color("#5c2a13"), FUR2_TIP = new THREE.Color("#93502a");
/** bone indices */
const B_PALM = 1, B_WRIST = 2, B_F = 3 /* 3 + finger*3 + seg */, B_T = 15;

/** a ring-strip surface: rows along z (i = 0..N), columns round the arm (j = 0..AN); f fills position + colour */
function tube(N: number, AN: number, f: (t: number, a: number, pos: THREE.Vector3, col: THREE.Color) => void): THREE.BufferGeometry {
  const pos: number[] = [], cols: number[] = [], idx: number[] = [], p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i <= N; i++) for (let j = 0; j <= AN; j++) { f(i / N, (j / AN) * Math.PI * 2, p, c); pos.push(p.x, p.y, p.z); cols.push(c.r, c.g, c.b); }
  for (let i = 0; i < N; i++) for (let j = 0; j < AN; j++) { const a = i * (AN + 1) + j, b = a + AN + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  return g;
}

/** v2 arm (see ARMS2): the peel cuff + the gorilla forearm, built round the wrist centre `wc` (+Z = toward the elbow).
 *  Silhouette first: wrist 5.4 cm → forearm 11.4 cm radius within 30 cm of the cuff (the target art's arms), the
 *  section a little flatter palm-to-back than across; fur = big pointed clumps whose tips lift off the arm and point
 *  back to the elbow (a saw-tooth edge, not a smooth tube); a peel band of two lapped wraps with rolled lips, four
 *  petals folded back over the fur; a short fur fringe from under the cuff onto the back of the hand. The whole v2 hand
 *  is 26.0 k triangles (v1 31.6 k), the same 3 material groups. */
function buildArm2(wc: THREE.Vector3, mirror: boolean, peelParts: THREE.BufferGeometry[], skinParts: THREE.BufferGeometry[], furParts: THREE.BufferGeometry[]) {
  const sx = mirror ? -1 : 1;
  const blendC = (p: THREE.Vector3) => (p.z - wc.z) / 0.035, blendF = (p: THREE.Vector3) => (p.z - wc.z) / 0.05;
  const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
  /** forearm radius (m) at z (from the wrist centre) */
  const rF = (z: number) => 0.054 + 0.06 * smooth((z - 0.05) / 0.28) - 0.022 * smooth((z - 0.45) / 0.9);
  const EX = 0.9;   // palm ↔ back of the hand (x) is the narrow axis
  // ---- the cuff (at 7 cm round and over the heel of the hand it read as a yellow turtle shell in freefall) — it
  // hugs the flat wrist (elliptical, narrow palm-to-back) and opens toward the forearm
  const Z0 = 0.004, Z1 = 0.074;
  // two wraps of peel: each a slightly tilted band that bulges; the second's leading edge laps over the first (a step,
  // its rim shaded); rolled lips tucked under at both ends
  const rC = (t: number, a = 0) => {
    const tw = t - 0.5 - 0.06 * Math.sin(a + 0.8);   // the overlap step runs round the arm at a slant
    let r = 0.056 + 0.005 * t;
    r += tw < 0 ? 0.003 * Math.sin(Math.PI * (t / Math.max(0.2, 0.5 + tw))) : 0.0045 + 0.003 * Math.sin(Math.PI * Math.min(1, tw / 0.5));
    if (t < 0.05) r -= 0.009 * (1 - t / 0.05) ** 2; if (t > 0.95) r -= 0.009 * ((t - 0.95) / 0.05) ** 2;   // tucked under
    return r;
  };
  const cx = (t: number) => 0.84 + 0.1 * t;   // palm ↔ back flattening of the cuff, hand end → forearm end
  peelParts.push(skin(tube(32, 40, (t, a, p, c) => {
    const r = rC(t, a);
    p.set(wc.x + Math.cos(a) * r * cx(t), wc.y + Math.sin(a) * r * 1.04, wc.z + Z0 + (Z1 - Z0) * t);
    c.copy(WHITE);
    const tw = t - 0.5 - 0.06 * Math.sin(a + 0.8);
    if (tw < 0 && tw > -0.12) c.lerp(PEEL_EDGE, 0.6 * (1 + tw / 0.12));   // shadow under the lapped edge
    if (t < 0.1) c.lerp(PEEL_EDGE, 0.45 * (1 - t / 0.1)); if (t > 0.9) c.lerp(PEEL_EDGE, 0.45 * ((t - 0.9) / 0.1));
  }), B_PALM, B_WRIST, blendC));
  // ---- petals: four folded back over the fur from the elbow edge (forward petals off the hand edge read as ears /
  // a hood and were dropped). Outer face peel, inner face cream (skin material, vertex colour).
  const r2 = rng(mirror ? 141 : 129);
  const petal = (a0: number, zRoot: number, dir: number, L: number, W: number, flare: number, R0: number, ex: number) => {
    for (const side of [1, -1]) {
      const pp: number[] = [], ii: number[] = [], cc: number[] = [];
      const NU = 6, NV = 8;
      for (let v = 0; v <= NV; v++) {
        const tv = v / NV, hw = (W / 2) * Math.pow(Math.max(0, 1 - Math.pow(tv, 1.6)), 0.7) + 0.001;
        for (let u = 0; u <= NU; u++) {
          const tu = (u / NU) * 2 - 1, ang = a0 + (tu * hw) / R0;
          const rr = R0 + flare * Math.pow(tv, 1.7) + 0.0035 * (1 - tu * tu) * Math.sin(Math.PI * tv) + side * 0.0012;
          pp.push(wc.x + Math.cos(ang) * rr * ex, wc.y + Math.sin(ang) * rr * 1.04, wc.z + zRoot + dir * L * tv);
          const cl = side > 0 ? WHITE.clone().lerp(PEEL_EDGE, Math.max(0, Math.abs(tu) - 0.7) * 2 + Math.max(0, tv - 0.8) * 2.5) : PEEL_IN.clone();
          cc.push(cl.r, cl.g, cl.b);
        }
      }
      // outward-facing winding flips with the strip's direction along z
      const fwd = (side > 0) === (dir > 0);
      for (let v = 0; v < NV; v++) for (let u = 0; u < NU; u++) { const a = v * (NU + 1) + u, b = a + NU + 1; if (fwd) ii.push(a, a + 1, b, a + 1, b + 1, b); else ii.push(a, b, a + 1, a + 1, b, b + 1); }
      const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3)); pg.setIndex(ii); pg.computeVertexNormals();
      pg.setAttribute("color", new THREE.Float32BufferAttribute(cc, 3));
      (side > 0 ? peelParts : skinParts).push(skin(pg, B_PALM, B_WRIST, blendC));
    }
  };
  for (let k = 0; k < 4; k++) {
    const a0 = (k / 4) * Math.PI * 2 + 0.4 + (r2() - 0.5) * 0.35;
    petal(a0, Z1 - 0.012, 1, 0.034 + r2() * 0.016, 0.032 + r2() * 0.008, 0.014 + r2() * 0.008, rC(0.9) * 0.99, cx(0.9));
  }
  // ---- a short fur fringe out from under the cuff onto the back of the hand (tips toward the knuckles): it ties the
  // cuff to the hand and says "gorilla" in every pose that shows the back of the hand (v1's forearm clumps covered the
  // whole hand back; this stops 3-4 cm short of the knuckles). On the hand side of the wrist: palm bone only.
  {
    const r4 = rng(mirror ? 171 : 163), cc = new THREE.Color();
    // the back-of-hand dome (buildHandGeo): centre 3.9 mm outboard of the wrist centre, semi-axes 20 × 58 × 45 mm, its
    // centre 31 mm toward the fingers from the wrist centre
    const dome = (z: number) => { const k = Math.sqrt(Math.max(0.05, 1 - ((z + 0.031) / 0.045) ** 2)); return [0.0202 * k, 0.058 * k]; };
    const NC = 6;
    for (let k = 0; k < NC; k++) {
      const a0 = -1.2 + (2.4 * (k + 0.5)) / NC + (r4() - 0.5) * 0.18;
      const L = 0.03 + r4() * 0.014, W = 0.026 + r4() * 0.006, tone = 0.9 + r4() * 0.25, NU = 4, NV = 5;
      const pp: number[] = [], uv: number[] = [], col: number[] = [], ii: number[] = [];
      for (let v = 0; v <= NV; v++) {
        const tv = v / NV, z = 0.012 - L * tv, [dx, dy] = dome(z);
        const hw = (W / 2) * (tv < 0.25 ? 0.85 + tv * 0.6 : Math.pow((1 - tv) / 0.75, 0.8)) + 0.0008;
        // root up under the cuff lip (≈ 34 × 50 mm), the tip lying on the hand's back
        const m = Math.pow(tv, 0.6), rx = (0.034 * (1 - m) + (dx + 0.0035) * m), ry = (0.05 * (1 - m) + (dy + 0.002) * m);
        for (let u = 0; u <= NU; u++) {
          const tu = (u / NU) * 2 - 1, ang = a0 + (tu * hw) / 0.045;
          const bulge = 1 + 0.12 * (1 - tu * tu) * Math.sin(Math.PI * tv);
          pp.push(wc.x + sx * (0.0039 + Math.cos(ang) * rx * bulge), wc.y + Math.sin(ang) * ry * bulge, wc.z + z);
          uv.push((tu + 1) * 0.15 + k * 0.17, tv * 0.3);
          cc.copy(FUR2_ROOT).lerp(FUR2_MID, Math.min(1, tv * 2)).lerp(FUR2_TIP, Math.max(0, tv * 1.6 - 0.5) * 0.9).multiplyScalar(tone * (1 - 0.4 * tu * tu));
          col.push(cc.r, cc.g, cc.b);
        }
      }
      for (let v = 0; v < NV; v++) for (let u = 0; u < NU; u++) { const a = v * (NU + 1) + u, b = a + NU + 1; ii.push(a, a + 1, b, a + 1, b + 1, b); }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(ii); g.computeVertexNormals();
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      furParts.push(skin(g, B_PALM));
    }
  }
  // ---- forearm core (dark, mostly hidden under the clumps)
  {
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 20; i++) { const z = 0.03 + (i / 20) * (FORE_LEN - 0.03); prof.push(new THREE.Vector2(rF(z) * 0.9, z)); }
    const fa = new THREE.LatheGeometry(prof, 20);
    fa.rotateX(Math.PI / 2); fa.scale(EX, 1, 1); fa.translate(wc.x, wc.y, wc.z);
    furParts.push(skin(colorize(fa, FUR_CORE), B_PALM, B_WRIST, blendF));
  }
  // ---- fur clumps: rings from under the cuff to the elbow, tips toward the elbow and lifted (the saw-tooth edge)
  const r3 = rng(mirror ? 153 : 137), c = new THREE.Color();
  const rings: number[] = [];
  for (let z = 0.05; z < 0.62; z += 0.05) rings.push(z);
  for (let z = 0.68; z < 1.4; z += 0.1) rings.push(z);
  rings.forEach((z0r, ri) => {
    const N = z0r < 0.62 ? 7 : 6;
    for (let k = 0; k < N; k++) {
      const a0 = ((k + (ri % 2) * 0.5) / N) * Math.PI * 2 + (r3() - 0.5) * 0.5, z0 = z0r + (r3() - 0.5) * 0.02;
      const side = Math.abs(Math.sin(a0));   // the index / pinky edges carry the silhouette: longer, liftier clumps
      const L = (0.11 + r3() * 0.05) * (1 + 0.12 * side), W = ((2 * Math.PI * rF(z0)) / N) * (1.55 + r3() * 0.35);
      const lift = (0.014 + r3() * 0.014) * (1 + 0.45 * side) * (z0r < 0.1 ? 0.6 : 1), crest = 0.009 + r3() * 0.006, sweep = (r3() - 0.5) * 0.5;
      const tone = 0.86 + r3() * 0.3, NU = 5, NV = 7, uo = r3(), vo = r3();
      const pp: number[] = [], uv: number[] = [], cc: number[] = [], ii: number[] = [];
      for (let v = 0; v <= NV; v++) {
        const tv = v / NV, z = z0 + L * tv, rz = rF(z);
        // a fat root, a pointed tip
        const hw = (W / 2) * (tv < 0.2 ? 0.8 + tv : Math.pow((1 - tv) / 0.8, 0.6)) + 0.0015;   // a full, blunt-pointed tip (glide: 0.85 read as needles)
        for (let u = 0; u <= NU; u++) {
          const tu = (u / NU) * 2 - 1, ang = a0 + (tu * hw) / rz + sweep * tv * tv;
          const rr = rz * 0.96 + 0.002 + crest * (1 - tu * tu) * Math.sin(Math.PI * Math.min(1, tv * 1.1)) + lift * tv * tv;
          pp.push(wc.x + Math.cos(ang) * rr * EX, wc.y + Math.sin(ang) * rr, wc.z + z);
          uv.push(uo + (tu + 1) * 0.18, vo + tv * 0.45);
          c.copy(FUR2_ROOT).lerp(FUR2_MID, Math.min(1, tv * 2.2)).lerp(FUR2_TIP, Math.max(0, tv * 1.7 - 0.55) * 0.9);
          c.multiplyScalar(tone * (1 - 0.42 * Math.pow(Math.abs(tu), 2)));
          cc.push(c.r, c.g, c.b);
        }
      }
      for (let v = 0; v < NV; v++) for (let u = 0; u < NU; u++) { const a = v * (NU + 1) + u, b = a + NU + 1; ii.push(a, a + 1, b, a + 1, b + 1, b); }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(ii); g.computeVertexNormals();
      g.setAttribute("color", new THREE.Float32BufferAttribute(cc, 3));
      furParts.push(skin(g, B_PALM, B_WRIST, blendF));
    }
  });
}

function buildHandGeo(mirror: boolean, v2 = false): HandGeo {
  const sx = mirror ? -1 : 1;
  const skinParts: THREE.BufferGeometry[] = [], peelParts: THREE.BufferGeometry[] = [], furParts: THREE.BufferGeometry[] = [];
  // ---- bones (bind pose: open flat hand, palm at x = PX0)
  const PX0 = 0.03 + PT / 2;
  const root = new THREE.Bone(); root.name = "root";
  const palm = new THREE.Bone(); palm.name = "palm"; palm.position.set(sx * PX0, 0, 0); root.add(palm);
  const wrist = new THREE.Bone(); wrist.name = "wrist"; wrist.position.set(sx * 0.004, 0, PL / 2 - 0.01); palm.add(wrist);
  const bones: THREE.Bone[] = [root, palm, wrist];
  const fingerBones: THREE.Bone[][] = [];
  for (let f = 0; f < 4; f++) {
    const row: THREE.Bone[] = [];
    let parent: THREE.Bone = palm;
    for (let s = 0; s < 3; s++) {
      const b = new THREE.Bone(); b.name = `f${f}${s}`;
      if (s === 0) b.position.set(sx * (-PT / 2 + FR[f] + 0.002), FY[f], -PL / 2 + 0.006);
      else b.position.set(0, 0, -FL[f][s - 1]);
      parent.add(b); parent = b; row.push(b); bones.push(b);
    }
    fingerBones.push(row);
  }
  {
    let parent: THREE.Bone = palm;
    for (let s = 0; s < 3; s++) {
      const b = new THREE.Bone(); b.name = `t${s}`;
      if (s === 0) b.position.set(sx * T0.x, T0.y, T0.z); else b.position.set(0, 0, -TL[s - 1]);
      parent.add(b); parent = b; bones.push(b);
    }
  }
  root.updateMatrixWorld(true);
  const world = (b: THREE.Bone) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);

  // ---- palm: a chunky rounded pad in tan skin (the palm side, darker in the creases), the back of the hand domed and
  // wrapped in peel (faceted like a banana: five soft ridges along the hand) up to the knuckle row
  const pc = world(palm);
  {
    const g = rbox(PT, PW, PL, 0.0165, 5); g.translate(pc.x, pc.y, pc.z);
    skinParts.push(skin(paint(g, (p, c) => { c.copy(PALM); const inner = (pc.x - p.x) * sx / (PT / 2); if (inner > 0.6) c.lerp(SKIN_SH, 0.35); }), B_PALM));
    // the back of the hand: a peel shell over the outboard face, from the wrist to just short of the knuckles
    const dome = new THREE.SphereGeometry(1, 28, 18);
    { const p = dome.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), th = Math.atan2(y, x);
        // banana facets: five flattened faces round the long axis (z)
        const k = 1 - 0.05 * (1 - Math.abs(Math.cos(th * 2.5)));
        p.setXYZ(i, x * k, y * k, z);
      } }
    dome.scale(PT * 0.56, PW * 0.55, PL * 0.5); dome.translate(pc.x + sx * PT * 0.22, pc.y, pc.z + 0.004);
    const dc = new THREE.Vector3(pc.x + sx * PT * 0.22, pc.y, pc.z + 0.004);
    if (!v2) peelParts.push(skin(paint(dome, (p, c) => { c.copy(WHITE); const e = Math.abs(p.z - dc.z) / (PL * 0.5); if (e > 0.82) c.lerp(PEEL_EDGE, (e - 0.82) * 2.5); }), B_PALM));
    else {
      // v2: the back of the hand is bare kong skin (the target art): four soft tendon ridges running to the knuckles, a
      // darker tan toward the wrist, the peel only as the cuff
      const p = dome.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), out = (x - dc.x) * sx;
        if (out <= 0) continue;
        let rid = 0; for (let f = 0; f < 4; f++) rid += Math.exp(-(((y - FY[f]) / 0.0085) ** 2));
        const fade = Math.max(0, Math.min(1, (dc.z - z) / (PL * 0.5) + 0.6));   // strongest toward the knuckles
        p.setX(i, x + sx * 0.0055 * rid * fade * (out / (PT * 0.56)));
      }
      dome.computeVertexNormals();
      skinParts.push(skin(paint(dome, (q, c) => {
        // value shapes the form: the mid-back a step darker, the tendon crests and the knuckle end lighter, the wrist end dark
        c.copy(SKIN).lerp(SKIN_SH, 0.28);
        let rid = 0; for (let f = 0; f < 4; f++) rid += Math.exp(-(((q.y - FY[f]) / 0.007) ** 2));
        const w = (q.z - dc.z) / (PL * 0.5);
        if (w < 0) c.lerp(SKIN, Math.min(1, -w * 1.3)); else c.lerp(CREASE, 0.35 * w);
        c.lerp(NAIL, 0.18 * Math.min(1, rid) * Math.max(0, Math.min(1, 0.6 - w)));
      }), B_PALM));
    }
    // thumb-index webbing: a soft wedge from the thumb base to the index knuckle (blends onto the thumb bone)
    { const a = new THREE.Vector3(pc.x + sx * (T0.x - 0.004), T0.y - 0.004, T0.z), bk = new THREE.Vector3(pc.x + sx * (-PT / 2 + FR[0] + 0.004), FY[0], -PL / 2 + 0.012);
      const d = bk.clone().sub(a), L = d.length(); const w = new THREE.CapsuleGeometry(0.012, L, 4, 12); w.scale(1, 1, 0.8);
      w.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize())); w.translate((a.x + bk.x) / 2, (a.y + bk.y) / 2, (a.z + bk.z) / 2);
      skinParts.push(skin(colorize(w, SKIN), B_PALM, B_T, (q) => Math.max(0, Math.min(1, 1 - q.clone().sub(a).dot(d) / (L * L))))); }
    // the knuckle row: a skin ridge across the front of the palm with four knuckle bumps
    const k = new THREE.CapsuleGeometry(0.0135, PW - 0.03, 4, 12); k.translate(pc.x + sx * 0.002, pc.y, pc.z - PL / 2 + 0.008);
    skinParts.push(skin(colorize(k, SKIN), B_PALM));
    for (let f = 0; f < 4; f++) {
      const kb = new THREE.SphereGeometry(1, 12, 8);
      // v2: big knuckles (a kong walks on them) — proud of the hand's back, a lighter crest catching the light
      if (v2) { kb.scale(0.0135, FR[f] * 1.02, 0.0145); kb.translate(pc.x + sx * (PT / 2 + 0.0005), FY[f], pc.z - PL / 2 + 0.012); skinParts.push(skin(paint(kb, (q, c) => { c.copy(SKIN); const up = (q.x - (pc.x + sx * (PT / 2 + 0.0005))) * sx / 0.0135; if (up > 0.3) c.lerp(NAIL, 0.35 * (up - 0.3)); }), B_PALM)); continue; }
      kb.scale(0.009, FR[f] * 0.95, 0.011); kb.translate(pc.x + sx * (PT / 2 - 0.004), FY[f], pc.z - PL / 2 + 0.01);
      skinParts.push(skin(colorize(kb, SKIN), B_PALM));
    }
  }
  // ---- fingers + thumb: each ONE continuous sculpted tube along its 3 bones (bind pose straight along −Z), skinned with
  // a smooth blend across each joint so a curled finger bends like a real one; a knuckle swell at each joint, a rounded
  // padded tip; painted: tan skin, darker crease lines across the back of each joint, a pale nail on the back of the tip
  const chain = (base: THREE.Vector3, lens: number[], r0: number, taper: number, b0: number, swell: number, flat: number, ys: number, b1 = -1, nails = true) => {
    const total = lens.reduce((a, c) => a + c, 0) + r0 * 0.8, j1 = lens[0], j2 = lens[0] + lens[1];
    const radial = 18, rows = 28;
    const g = new THREE.CylinderGeometry(1, 1, 1, radial, rows, false);
    g.rotateX(-Math.PI / 2); g.translate(0, 0, -0.5);   // along −Z, from z = 0 (knuckle) to z = −1 (tip)
    const pos = g.attributes.position as THREE.BufferAttribute, n = pos.count;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), col = new Float32Array(n * 3), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const u = -pos.getZ(i), d = u * total;
      let ax = pos.getX(i), ay = pos.getY(i);
      // v2: a squared-off (superellipse) section — toy-chunky fingers instead of round sausages
      if (v2) { const k = Math.pow(Math.pow(Math.abs(ax), 2.8) + Math.pow(Math.abs(ay), 2.8), -1 / 2.8); if (isFinite(k)) { ax *= k; ay *= k; } }
      // radius along the finger: taper, a knuckle swell at each joint, a rounded tip (and a rounded root)
      let r = r0 * (1 - taper * u);
      for (const jz of [0, j1, j2]) r *= 1 + swell * Math.exp(-Math.pow((d - jz) / (r0 * 0.7), 2));
      const tipU = (d - (total - r0 * 1.1)) / (r0 * 1.1); if (tipU > 0) r *= Math.sqrt(Math.max(0, 1 - Math.min(1, tipU) * Math.min(1, tipU))) * 0.98 + 0.02;
      const rootU = d / (r0 * 0.5); if (rootU < 1) r *= 0.75 + 0.25 * rootU;
      // nail side (outboard, +x for the right hand) a little flatter than the padded palm side
      const back = ax * sx;
      const fx = back > 0 ? flat : 1;
      pos.setXYZ(i, base.x + ax * r * fx, base.y + ay * r * ys, base.z - Math.min(d, total));
      // smooth two-bone skinning across the joints (blend width ≈ the finger radius)
      const bw = r0 * 0.9; let bA = 0, bB = 0, k = 0;
      if (d < j1 - bw) { bA = 0; bB = 0; } else if (d < j1 + bw) { bA = 0; bB = 1; k = (d - (j1 - bw)) / (2 * bw); }
      else if (d < j2 - bw) { bA = 1; bB = 1; } else if (d < j2 + bw) { bA = 1; bB = 2; k = (d - (j2 - bw)) / (2 * bw); } else { bA = 2; bB = 2; }
      k = k * k * (3 - 2 * k);
      si[i * 4] = b0 + bA; si[i * 4 + 1] = b0 + bB; sw[i * 4] = 1 - k; sw[i * 4 + 1] = k;
      // a webbing chain between two fingers rides both of them half and half
      if (b1 >= 0) { si[i * 4 + 2] = b1 + bA; si[i * 4 + 3] = b1 + bB; sw[i * 4] *= 0.5; sw[i * 4 + 1] *= 0.5; sw[i * 4 + 2] = (1 - k) * 0.5; sw[i * 4 + 3] = k * 0.5; }
      // paint: skin, the palm side a touch darker, crease lines across the back of the joints, the nail
      c.copy(SKIN); if (back < -0.2) c.lerp(SKIN_SH, 0.3);
      if (back > 0.1) for (const jz of [j1, j2]) { const q = Math.abs(d - jz) / (r0 * 0.32); if (q < 1) c.lerp(CREASE, 0.55 * (1 - q * q)); }
      if (nails && back > 0.5 && d > total - r0 * 2.3 && d < total - r0 * 0.35) c.lerp(NAIL, 0.85);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.computeVertexNormals();
    g.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4)); g.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  };
  for (let f = 0; f < 4; f++) {
    const p = world(fingerBones[f][0]);
    skinParts.push(v2 ? chain(p, FL[f], FR[f] * 1.07, 0.08, B_F + f * 3, 0.12, 0.84, 0.94) : chain(p, FL[f], FR[f], 0.1, B_F + f * 3, 0.06, 0.86, 0.94));
    // webbing between this finger and the next: only along the first segment (a real hand's web ends at the first
    // knuckle), so the fingers separate where they wrap the grip — four fingers, not a mitten
    if (f < 3) {
      const q = world(fingerBones[f + 1][0]), mid = p.clone().lerp(q, 0.5);
      skinParts.push(chain(mid, [FL[f][0] * 0.62, 0.0005, 0.0005], (FR[f] + FR[f + 1]) * 0.42, 0.1, B_F + f * 3, 0.0, 0.85, 1.0, B_F + (f + 1) * 3, false));
    }
  }
  {
    const tb = bones.slice(B_T, B_T + 3), p = world(tb[0]);
    skinParts.push(chain(p, TL, TR[0] * (v2 ? 0.92 : 0.84), v2 ? 0.2 : 0.24, B_T, v2 ? 0.1 : 0.05, 0.86, 1.04));
    // thenar mound: the fat muscle pad between the thumb root and the palm heel (no sausage joint)
    const m = new THREE.SphereGeometry(1, 20, 14); m.scale(PT * 0.55, TR[0] * 1.9, TL[0] * 0.95);
    m.translate(p.x + sx * PT * 0.12, p.y - TR[0] * 0.6, p.z + TL[0] * 0.15);
    skinParts.push(skin(colorize(m, SKIN), B_PALM, B_T, (q) => Math.max(0, Math.min(0.6, (p.z - q.z) / (TL[0] * 1.2)))));
  }
  // ---- the peel cuff round the wrist: three stacked peel bands (each a little tilted, a dark seam where one overlaps
  // the next) flaring onto the forearm, then the peel's petals folded back over the fur (yellow outside, cream inside)
  const wc = world(wrist);
  const blend = (p: THREE.Vector3) => (p.z - wc.z) / 0.035;
  if (!v2) {
    const Z0 = -0.012, Z1 = 0.082, N = 36, AN = 48;
    const rAt = (z: number) => {
      const t = (z - Z0) / (Z1 - Z0);
      let r = 0.05 + 0.017 * t;
      // three bands: each bulges, the seams between them dip (the next band's edge lies over it)
      const band = (t * 3) % 1; r += 0.0045 * Math.sin(Math.PI * band) - 0.002;
      // rolled lips at both ends
      if (t < 0.06) r -= 0.006 * (1 - t / 0.06) ** 2; if (t > 0.94) r -= 0.008 * ((t - 0.94) / 0.06) ** 2;
      return r;
    };
    const pos: number[] = [], idx: number[] = [], cols: number[] = [];
    for (let i = 0; i <= N; i++) {
      const z = Z0 + (Z1 - Z0) * (i / N), t = i / N, bandI = Math.min(2, Math.floor(t * 3)), band = (t * 3) % 1;
      for (let j = 0; j <= AN; j++) {
        const a = (j / AN) * Math.PI * 2;
        // each band tilted a little round the arm (a wrapped strip, not a lathe ring)
        const tilt = 0.006 * Math.sin(a + bandI * 2.1);
        const r = rAt(z) * (1 + 0.025 * Math.sin(a * 3 + bandI));
        pos.push(wc.x + Math.cos(a) * r * 1.0, wc.y + Math.sin(a) * r * 1.08, wc.z + z + tilt);
        const seam = band < 0.12 && bandI > 0 ? 1 - band / 0.12 : 0;
        const c = WHITE.clone().lerp(PEEL_EDGE, 0.75 * seam);
        cols.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < AN; j++) { const a = i * (AN + 1) + j, b = a + AN + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
    const cg = new THREE.BufferGeometry(); cg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); cg.setIndex(idx); cg.computeVertexNormals();
    cg.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    peelParts.push(skin(cg, B_PALM, B_WRIST, blend));
    // the petals: four short pointed peel strips from the cuff's elbow edge, folded back flat over the fur
    const r2 = rng(mirror ? 41 : 29);
    for (let k = 0; k < 4; k++) {
      const a0 = (k / 4) * Math.PI * 2 + 0.55 + (r2() - 0.5) * 0.3, L = 0.036 + r2() * 0.018, W = 0.03 + r2() * 0.006, lift = 0.007 + r2() * 0.006;
      const R0 = rAt(Z1 - 0.012) * 0.99, NU = 6, NV = 10;
      for (const side of [1, -1]) {   // 1 = outer (peel), −1 = inner face (cream)
        const pp: number[] = [], ii: number[] = [], cc: number[] = [];
        for (let v = 0; v <= NV; v++) {
          const tv = v / NV, hw = (W / 2) * Math.pow(Math.max(0, 1 - tv * tv), 0.75) + 0.0015;
          for (let u = 0; u <= NU; u++) {
            const tu = (u / NU) * 2 - 1, ang = a0 + (tu * hw) / R0;
            // lies on the cuff at the root, then folds back along the arm and lifts / curls outward
            const rr = R0 + lift * tv * tv + 0.004 * (1 - tu * tu) * Math.sin(Math.PI * tv) + side * 0.0012 + 0.002;
            pp.push(wc.x + Math.cos(ang) * rr, wc.y + Math.sin(ang) * rr * 1.08, wc.z + Z1 - 0.014 + L * tv);
            const cl = side > 0 ? WHITE.clone().lerp(PEEL_EDGE, Math.max(0, Math.abs(tu) - 0.75) * 2.4 + Math.max(0, tv - 0.85) * 2) : PEEL_IN.clone();
            cc.push(cl.r, cl.g, cl.b);
          }
        }
        // (the shapes are built round the already-mirrored wrist, so the winding is the same for both hands: outward)
        for (let v = 0; v < NV; v++) for (let u = 0; u < NU; u++) { const a = v * (NU + 1) + u, b = a + NU + 1; if (side > 0) ii.push(a, a + 1, b, a + 1, b + 1, b); else ii.push(a, b, a + 1, a + 1, b, b + 1); }
        const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3)); pg.setIndex(ii); pg.computeVertexNormals();
        pg.setAttribute("color", new THREE.Float32BufferAttribute(cc, 3));
        (side > 0 ? peelParts : skinParts).push(skin(pg, B_PALM, B_WRIST, blend));
      }
    }
  }
  // ---- forearm: a dark core (lathe: slim wrist → swelling muscle → elbow) under rings of big sculpted fur CLUMPS —
  // pointed, slightly cupped petals of fur shingled along the arm, every tip toward the hand and lifted off the one
  // below it (the target art's clumped silhouette); dark roots → lit tips, darker clump edges, one strand texture
  if (!v2) {
    const rAt = (z: number) => { const t = z / FORE_LEN; return (0.04 + 0.03 * Math.sin(Math.min(1, t / 0.4) * Math.PI / 2) - 0.012 * Math.max(0, (t - 0.5) / 0.5)) * 0.92 * ARM_K; };
    const prof: Array<[number, number]> = [];
    for (let i = 0; i <= 16; i++) { const z = (i / 16) * FORE_LEN; prof.push([rAt(z) * 0.93, z]); }
    const fa = new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), 24);
    fa.rotateX(Math.PI / 2);   // lathe +Y → +Z (toward the elbow)
    fa.translate(wc.x, wc.y, wc.z + 0.07);
    furParts.push(skin(colorize(fa, FUR_CORE), B_PALM, B_WRIST, (p) => (p.z - wc.z) / 0.05));
    const r3 = rng(mirror ? 53 : 37), c = new THREE.Color();
    // rings: dense near the hand (what the view sees), sparse further up the arm (off screen)
    const rings: number[] = [];
    for (let z = 0.085; z < 0.62; z += 0.04) rings.push(z);
    for (let z = 0.7; z < 1.35; z += 0.09) rings.push(z);
    rings.forEach((z0r, ri) => {
      const N = 8, rr0 = rAt(z0r - 0.07);
      for (let k = 0; k < N; k++) {
        // irregular: each clump its own size, lean, lift and a sideways sweep of its tip (no pine-cone pattern)
        const a0 = ((k + (ri % 2) * 0.5) / N) * Math.PI * 2 + (r3() - 0.5) * 0.55, z0 = z0r + (r3() - 0.5) * 0.024;
        const L = 0.1 + r3() * 0.05, W = ((2 * Math.PI * rr0) / N) * (1.45 + r3() * 0.4), lift = 0.004 + r3() * 0.01, cup = 0.005 + r3() * 0.004, sweep = (r3() - 0.5) * 0.45;
        const tone = 0.84 + r3() * 0.32, NU = 5, NV = 8;
        const pp: number[] = [], uv: number[] = [], cc: number[] = [], ii: number[] = [];
        const uo = r3(), vo = r3();
        for (let v = 0; v <= NV; v++) {
          const tv = v / NV, z = z0 - L * tv, rz = rAt(Math.max(0, z - 0.07));
          // a broad leaf of fur: full width most of its length, a rounded (not needle) tip
          const hw = (W / 2) * Math.sqrt(Math.max(0, 1 - Math.pow(tv, 2.6))) + 0.0015;
          for (let u = 0; u <= NU; u++) {
            const tu = (u / NU) * 2 - 1, ang = a0 + (tu * hw) / rz + sweep * tv * tv;
            const rr = rz * 0.97 + 0.003 + cup * (1 - tu * tu) * Math.sin(Math.PI * Math.min(1, tv * 1.15)) + lift * tv * tv;
            pp.push(wc.x + Math.cos(ang) * rr, wc.y + Math.sin(ang) * rr * 0.92, wc.z + z);
            uv.push(uo + (tu + 1) * 0.18, vo + tv * 0.45);
            // dark root → mid → lit tip, darker toward the clump's edges (the gaps between clumps read as depth)
            c.copy(FUR_ROOT).lerp(FUR_MID, Math.min(1, tv * 2)).lerp(FUR_TIP, Math.max(0, tv * 1.6 - 0.6) * 0.8);
            c.multiplyScalar(tone * (1 - 0.3 * Math.pow(Math.abs(tu), 2.4)));
            cc.push(c.r, c.g, c.b);
          }
        }
        for (let v = 0; v < NV; v++) for (let u = 0; u < NU; u++) { const a = v * (NU + 1) + u, b = a + NU + 1; ii.push(a, b, a + 1, a + 1, b, b + 1); }
        const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(ii); g.computeVertexNormals();
        g.setAttribute("color", new THREE.Float32BufferAttribute(cc, 3));
        furParts.push(skin(g, B_PALM, B_WRIST, (p) => (p.z - wc.z) / 0.05));
      }
    });
  }
  if (v2) buildArm2(wc, mirror, peelParts, skinParts, furParts);
  // ---- merge: group 0 = skin, group 1 = peel, group 2 = fur
  const flat = (gs: THREE.BufferGeometry[]) => gs.map((g) => {
    const x = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(x.attributes)) if (!["position", "normal", "uv", "color", "skinIndex", "skinWeight"].includes(k)) x.deleteAttribute(k);
    if (!x.attributes.uv) x.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2));
    if (!x.attributes.color) colorize(x, WHITE);
    return x;
  });
  const sk = mergeGeometries(flat(skinParts))!, pl = mergeGeometries(flat(peelParts))!, fu = mergeGeometries(flat(furParts))!;
  // skin + peel uv = a box projection (skin pores ~4 cm, peel spots ~8 cm a tile)
  for (const [g, k] of [[sk, 25], [pl, 12]] as Array<[THREE.BufferGeometry, number]>) {
    const pos = g.attributes.position as THREE.BufferAttribute, nrm = g.attributes.normal as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
      const x = pos.getX(i) * k, y = pos.getY(i) * k, z = pos.getZ(i) * k;
      if (ax >= ay && ax >= az) uv.setXY(i, y, z); else if (ay >= az) uv.setXY(i, x, z); else uv.setXY(i, x, y);
    }
  }
  const geo = mergeGeometries([sk, pl, fu], true)!;
  geo.computeBoundingSphere();
  return { geo, bones };
}

/** bind-pose geometry is built with x mirrored for the left hand (positions were built with sx already) */
const geoCache: Partial<Record<"R" | "L" | "R2" | "L2", HandGeo>> = {};
/** one geometry per side and look, shared by every hand; under ?geofree it drops its CPU arrays after upload (the skin
 * is GPU-skinned and the hands are never culled or raycast) and a context restore rebuilds them */
function handGeo(side: "R" | "L", v2: boolean): HandGeo {
  const key = v2 ? (`${side}2` as const) : side;
  let g = geoCache[key];
  if (g) return g;
  geoCache[key] = g = buildHandGeo(side === "L", v2);
  releaseGeometryAfterUpload(g.geo, () => {
    const fresh = buildHandGeo(side === "L", v2).geo, out: Record<string, THREE.TypedArray> = {};
    for (const [name, a] of Object.entries(fresh.attributes)) out[name] = (a as THREE.BufferAttribute).array;
    if (fresh.index) out.index = fresh.index.array;
    return out;
  });
  return g;
}

// ------------------------------------------------------------------------------------------------ grip solver
const SCAN = 72;
/** planar chain around an offset ellipse (a + rr, b + rr) in the canonical XZ plane; returns absolute angles α (about
 *  +Y, from −Z toward −X). wrap = +1: φ increasing (+X → −Z → −X), −1: decreasing (+X → +Z → −X). */
function wrapChain(px: number, pz: number, lens: number[], rr: number, a: number, b: number, wrap: number, out: number[]) {
  const A = a + rr, Bz = b + rr;
  const ex = (f: number) => A * Math.cos(f), ez = (f: number) => -Bz * Math.sin(f);
  let x = px, z = pz;
  let phi = Math.atan2(-z / Bz, x / A);
  for (let s = 0; s < lens.length; s++) {
    const L = lens[s];
    // scan forward along the wrap for the first ellipse point at distance ≥ L
    let lo = phi, hi = phi, found = false, best = phi, bestD = 1e9;
    for (let i = 1; i <= SCAN; i++) {
      const f = phi + wrap * (i / SCAN) * Math.PI * 1.2;
      const d = Math.hypot(ex(f) - x, ez(f) - z);
      if (d < bestD) { bestD = d; best = f; }
      if (d >= L) { hi = f; lo = phi + wrap * ((i - 1) / SCAN) * Math.PI * 1.2; found = true; break; }
    }
    let tx: number, tz: number;
    if (found) {
      for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; if (Math.hypot(ex(m) - x, ez(m) - z) >= L) hi = m; else lo = m; }
      tx = ex(hi); tz = ez(hi); phi = hi;
    } else { tx = ex(best); tz = ez(best); phi = best; }
    let dx = tx - x, dz = tz - z; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    out[s] = Math.atan2(-dx, -dz);
    x += dx * L; z += dz * L;
  }
}

/** relaxed (open) hand, angles relative to the parent */
const OPEN_F = [0.25, 0.3, 0.22];
const OPEN_T = [0.55, 0.15, 0.1];

export interface Hand {
  mesh: THREE.SkinnedMesh;
  /** the grip frame = the mesh itself: place / orient / scale it (hand-local units = metres × its scale) */
  root: THREE.Bone;
  side: "R" | "L";
  /** wrap the hand around an a × b grip (hand-local m); curl 0..1 (0 = relaxed open), thumb 0..1 (thumb wrap) */
  setGrip(a: number, b: number, curl: number, thumb?: number): void;
  /** turn the forearm toward `target` (world space) */
  aimForearm(target: THREE.Vector3): void;
  /** the same aim with `target` in the hand mesh's OWN space (no world matrices involved) */
  aimForearmLocal(target: THREE.Vector3): void;
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();
const Z_AXIS = new THREE.Vector3(0, 0, 1), Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpF = [0, 0, 0], tmpT = [0, 0, 0];

export function createHand(side: "R" | "L"): Hand {
  const mirror = side === "L";
  const src = handGeo(side, ARMS2);
  // fresh bones per hand instance (same bind pose)
  const bones = src.bones.map((b) => { const n = new THREE.Bone(); n.name = b.name; n.position.copy(b.position); n.quaternion.copy(b.quaternion); return n; });
  const parentOf = (i: number) => { const p = src.bones[i].parent; return p ? src.bones.indexOf(p as THREE.Bone) : -1; };
  for (let i = 1; i < bones.length; i++) bones[parentOf(i)].add(bones[i]);
  const m = handMaterials();
  const mesh = new THREE.SkinnedMesh(src.geo, [m.glove, m.peel, m.fur]);
  if (AB) AB.push(mesh);
  mesh.name = `vm-hand${side}`;
  mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true; mesh.userData.castShadow = false;
  const root = bones[0];
  mesh.add(root);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones), new THREE.Matrix4());
  // ?geofree: skinned bounds read CPU vertices, so the first hand of a geometry takes them before the upload drops the
  // arrays and later hands copy them (a Box3 over the viewmodel would otherwise compute them from a released geometry)
  if (flag("geofree")) {
    if (!src.bounds) { mesh.computeBoundingBox(); mesh.computeBoundingSphere(); src.bounds = [mesh.boundingBox!.clone(), mesh.boundingSphere!.clone()]; }
    else { mesh.boundingBox = src.bounds[0].clone(); mesh.boundingSphere = src.bounds[1].clone(); }
  }
  const sx = mirror ? -1 : 1;
  const palm = bones[B_PALM], wrist = bones[B_WRIST];
  const knuckle = FY.map((_, f) => bones[B_F + f * 3].position.clone());

  const hand: Hand = {
    mesh, root, side,
    setGrip(a, b, curl, thumb = curl) {
      palm.position.x = sx * (a + PT / 2);
      for (let f = 0; f < 4; f++) {
        // canonical frame: knuckle at palm + offset (x mirrored back)
        const kx = a + PT / 2 + (knuckle[f].x * sx), kz = knuckle[f].z;
        wrapChain(kx, kz, FL[f], FR[f], a, b, 1, tmpF);
        let prev = 0;
        for (let s = 0; s < 3; s++) {
          const rel = Math.min(1.95, Math.max(-0.1, tmpF[s] - prev)); prev += rel;
          const ang = rel * curl + OPEN_F[s] * (1 - curl) * (0.9 + f * 0.06);
          bones[B_F + f * 3 + s].quaternion.setFromAxisAngle(Y_AXIS, sx * ang);
        }
      }
      {
        const tx = a + PT / 2 + T0.x, tz = T0.z;
        wrapChain(tx, tz, TL, TR[0], a, b, -1, tmpT);
        let prev = 0;
        for (let s = 0; s < 3; s++) {
          let rel = tmpT[s] - prev; if (s > 0) rel = Math.max(-1.6, Math.min(1.6, rel)); prev += rel;
          const ang = rel * thumb + OPEN_T[s] * (1 - thumb);
          bones[B_T + s].quaternion.setFromAxisAngle(Y_AXIS, sx * ang);
        }
      }
    },
    aimForearm(target) {
      // the target in the palm's space → direction from the wrist; clamp the wrist bend to 65°
      palm.updateMatrixWorld(true);
      _m.copy(palm.matrixWorld).invert();
      _v.copy(target).applyMatrix4(_m).sub(wrist.position).normalize();
      const ang = _v.angleTo(Z_AXIS), lim = 2.6;
      _q.setFromUnitVectors(Z_AXIS, _v);
      if (ang > lim) { _q2.identity(); _q.slerpQuaternions(_q2, _q, lim / ang); }
      wrist.quaternion.copy(_q);
    },
    aimForearmLocal(target) {
      // hand space → palm space: the root bone is the identity and the palm bone only translates (setGrip)
      _v.copy(target).sub(palm.position).sub(wrist.position).normalize();
      const ang = _v.angleTo(Z_AXIS), lim = 2.6;
      _q.setFromUnitVectors(Z_AXIS, _v);
      if (ang > lim) { _q2.identity(); _q.slerpQuaternions(_q2, _q, lim / ang); }
      wrist.quaternion.copy(_q);
    },
  };
  hand.setGrip(0.03, 0.03, 1);
  return hand;
}
