// poi-jungle kit — GOLD + BANANAS. Stylized gold only reads as gold when it reflects something CONTRASTY: the sky IBL is a
// flat pale blue-grey, so metal-1 gold under it turns cream/peach. Every gold material here gets its own small warm
// "treasure-room" environment instead (a PMREM of a procedural equirect: near-black warm surroundings, a few hot warm-white
// softboxes and pin-point sparkles, a dim amber horizon band) → saturated yellow gold with dark reflections and hot
// highlights, identical outdoors and inside the vault (no interior darkening on metal). Glow (the idol's) lives in a
// separate additive fresnel shell + halo sprite — never in the base material's emissive.
// Bananas: a real banana (pentagonal, tapered, curved, brown tip, green-brown stem) in hands of 3–6 fanned from a crown.
import * as THREE from "three";
import { mulberry } from "./jungle-mat";
import { tint, type Geo } from "./jungle-geo";
import { onRestore } from "../../../engine/res/restore";

let _env: THREE.Texture | null = null;
let _rt: THREE.WebGLRenderTarget | null = null;
/** the warm contrasty PMREM env for gold (built once per renderer) */
export function goldEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  if (!_env) for (const _ of goldEnvSteps(renderer)) { /* all at once */ }
  return _env!;
}
/** goldEnv time-sliced: a streamed build awaits this before it makes its gold materials (built in one piece, the
 *  equirect + PMREM held the main thread ~0.4 s in a match's warm-up) */
export async function prepareGoldEnv(renderer: THREE.WebGLRenderer, yieldFn: () => Promise<void>): Promise<void> {
  if (!_env) for (const _ of goldEnvSteps(renderer)) await yieldFn();
}
function* goldEnvSteps(renderer: THREE.WebGLRenderer): Generator<void> {
  const W = 512, H = 256, data = new Float32Array(W * H * 4);
  // tuned THROUGH the atmos tone curve (PBR-Neutral shoulder desaturates above ~0.76 → white): mid reflections carry the
  // yellow (a warm dome ~0.4), softboxes stay ≤ 4 (light gold, not white), only tiny sparkles go hot
  // a bright room with big softboxes blows out through the tone curve's shoulder (cream chest), so:
  // a warm dim dome (reflections ≈ 0.45–0.7 → saturated yellow after the gold tint), DARK bands (horizon + floor) that
  // read as polished metal, a few SMALL softboxes ≤ 1.5 and pin sparkles (the only things allowed to go hot)
  const spots: Array<[number, number, number, number, [number, number, number]]> = [
    // azimuth°, elevation°, radius°, intensity, colour
    [35, 40, 6, 1.5, [1.0, 0.9, 0.7]], [150, 26, 8, 1.1, [1.0, 0.86, 0.62]], [245, 16, 4, 1.6, [1.0, 0.92, 0.75]],
    [300, 55, 5, 1.3, [1.0, 0.9, 0.72]], [95, 72, 12, 0.8, [1.0, 0.93, 0.8]],
  ];
  const rnd = mulberry(8181);
  for (let i = 0; i < 14; i++) spots.push([rnd() * 360, -5 + rnd() * 70, 0.8 + rnd() * 1.0, 3 + rnd() * 3, [1.0, 0.92, 0.75]]);
  const dirOf = (az: number, el: number) => { const a = az * Math.PI / 180, e = el * Math.PI / 180; return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)]; };
  const S = spots.map(([az, el, r, I, c]) => ({ d: dirOf(az, el), cr: Math.cos(r * Math.PI / 180), I, c }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x === 0 && y % 16 === 15) yield;
    const el = (0.5 - (y + 0.5) / H) * 180, az = ((x + 0.5) / W) * 360, d = dirOf(az, el);
    const up = Math.max(0, d[1]), dn = Math.max(0, -d[1]);
    // warm dome brightening upward, a broken dark horizon stripe, a dark floor with a faint amber bounce
    const stripe = Math.exp(-(((el - 10) / 10) ** 2)) * (0.65 + 0.35 * Math.sin(az * Math.PI / 40));
    let k = (0.34 + 0.4 * Math.pow(up, 0.7)) * (1 - 0.88 * stripe);
    if (d[1] < 0) k = 0.06 + 0.1 * Math.exp(-dn * 4);
    const band = Math.exp(-(((el + 4) / 5) ** 2)) * (0.5 + 0.5 * Math.sin(az * Math.PI / 70)) * 0.22;   // amber fire band just below the horizon
    let r = k * 1.0 + band, g = k * 0.93 + band * 0.5, b = k * 0.8 + band * 0.12;
    for (const s of S) {
      const c = d[0] * s.d[0] + d[1] * s.d[1] + d[2] * s.d[2];
      if (c > s.cr - 0.01) { const q = Math.min(1, Math.max(0, (c - (s.cr - 0.01)) / 0.01)); r += s.I * s.c[0] * q; g += s.I * s.c[1] * q; b += s.I * s.c[2] * q; }
    }
    const i = (y * W + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
  }
  yield;
  // (bilinear 2x up to 1024 x 512: the PMREM's cube size is width / 4, and at 256 its filter program is the one the sky
  // IBL already linked (atmos/env.ts fromScene) — at 128 a second one linked synchronously, ~0.3 s)
  const W2 = W * 2, H2 = H * 2, half = new Uint16Array(W2 * H2 * 4);
  for (let y = 0; y < H2; y++) {
    const fy = Math.min(H - 1, Math.max(0, (y + 0.5) / 2 - 0.5)), y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W2; x++) {
      const fx = (x + 0.5) / 2 - 0.5, x0 = Math.floor(fx), tx = fx - x0, xa = (x0 + W) % W, xb = (x0 + 1) % W;
      for (let c = 0; c < 4; c++) {
        const a = data[(y0 * W + xa) * 4 + c] * (1 - tx) + data[(y0 * W + xb) * 4 + c] * tx, b = data[(y1 * W + xa) * 4 + c] * (1 - tx) + data[(y1 * W + xb) * 4 + c] * tx;
        half[(y * W2 + x) * 4 + c] = THREE.DataUtils.toHalfFloat(a * (1 - ty) + b * ty);
      }
    }
    if (y % 64 === 63) yield;
  }
  const tex = new THREE.DataTexture(half, W2, H2, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping; tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  const pm = new THREE.PMREMGenerator(renderer);
  if (!_rt) onRestore("bake", () => { Array.from(goldEnvSteps(renderer)); });
  _rt = pm.fromEquirectangular(tex, _rt);
  _env = _rt.texture;
  pm.dispose(); tex.dispose();
}

export interface GoldOpts { roughness?: number; color?: THREE.ColorRepresentation; env?: number; emissive?: number; vertexColors?: boolean; /** a fresh instance (to patch further — never .clone(): clones lose onBeforeCompile) */ unique?: boolean }
const _gold = new Map<string, THREE.MeshStandardMaterial>();
/** saturated stylized gold: #ffc53a, metalness 1, roughness 0.2–0.3, emissive ≤ 0.1, the warm contrasty env */
export function goldMaterial(renderer: THREE.WebGLRenderer, o: GoldOpts = {}): THREE.MeshStandardMaterial {
  const key = JSON.stringify(o); const hit = o.unique ? undefined : _gold.get(key); if (hit) return hit;
  const m = new THREE.MeshStandardMaterial({ color: o.color ?? "#ffbf2e", metalness: 1, roughness: o.roughness ?? 0.24, envMap: goldEnv(renderer), envMapIntensity: o.env ?? 1.0,
    emissive: "#ffb000", emissiveIntensity: Math.min(0.1, o.emissive ?? 0.05), vertexColors: !!o.vertexColors });
  m.name = "jungle-gold";
  // stylized gold keeps its TINT at grazing angles: Schlick's untinted F90 = 1 turned every coin / chest top seen low and
  // flat into cream. F90 → 0.2 (the grazing term is gold-coloured F0 instead of white)
  m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <lights_physical_fragment>", "#include <lights_physical_fragment>\n material.specularF90 = 0.2;"); };
  m.customProgramCacheKey = () => "jungle-gold-f90";
  if (!o.unique) _gold.set(key, m);
  return m;
}


/** an additive fresnel "glow shell" material for a gold hero (the idol): the halo lives here, not in the gold */
export function glowShellMaterial(color = "#ffb530", strength = 1.6): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
    uniforms: { uCol: { value: new THREE.Color(color) }, uK: { value: strength } },
    vertexShader: "varying vec3 vN; varying vec3 vV; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }",
    fragmentShader: "uniform vec3 uCol; uniform float uK; varying vec3 vN; varying vec3 vV; void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); float a = pow(f, 2.2) * uK; gl_FragColor = vec4(uCol * a, 1.0); }",
  });
}

// ---------------------------------------------------------------- bananas
const YEL = new THREE.Color("#ffd23a"), YEL2 = new THREE.Color("#ffe25a"), GRN = new THREE.Color("#a8b83a"), TIP = new THREE.Color("#3e2c14"), STEM = new THREE.Color("#7a6a2c");
/** one banana, local frame: stem at the origin, runs along +x, curving up (+y). Pentagonal, tapered, brown tip. */
export function bananaGeo(len: number, seed = 1, ripe = 1): Geo {
  const rnd = mulberry(seed), A = 1.05 + rnd() * 0.3, R = len / A, rMax = len * (0.1 + rnd() * 0.015), nA = 16, nR = 10;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const c = new THREE.Color();
  const ctr = (t: number) => { const a = -A * 0.15 + A * t; return [R * Math.sin(a), R * (1 - Math.cos(a)) - R * (1 - Math.cos(-A * 0.15))]; };
  const rad = (t: number) => {
    if (t < 0.1) return rMax * (0.22 + 0.06 * t / 0.1);                           // stem
    if (t < 0.28) return rMax * (0.28 + 0.72 * Math.sin((t - 0.1) / 0.18 * Math.PI / 2));
    if (t < 0.84) return rMax * (1 - 0.1 * ((t - 0.28) / 0.56) ** 2);
    return rMax * Math.max(0.12, 0.9 * Math.max(0, Math.cos(Math.min(1, (t - 0.84) / 0.16) * Math.PI / 2)) ** 0.8);  // tip
  };
  for (let i = 0; i <= nA; i++) {
    const t = i / nA, [px, py] = ctr(t), [qx, qy] = ctr(Math.min(1, t + 0.01)), [ox, oy] = ctr(Math.max(0, t - 0.01));
    const tx = qx - ox, ty = qy - oy, tl = Math.hypot(tx, ty), nx = -ty / tl, ny = tx / tl;   // normal in the xy plane (up side)
    const r = rad(t);
    c.copy(t < 0.1 ? STEM : t > 0.94 ? TIP : YEL);
    if (t >= 0.1 && t < 0.3) c.lerp(GRN, (1 - (t - 0.1) / 0.2) * 0.55 * (1.2 - ripe));
    if (t > 0.86 && t <= 0.94) c.lerp(TIP, (t - 0.86) / 0.08 * 0.6);
    for (let j = 0; j <= nR; j++) {
      const th = j / nR * Math.PI * 2, rr = r * (1 + 0.07 * Math.cos(th * 5));      // five soft ridges
      const cx = Math.cos(th) * rr, cz = Math.sin(th) * rr;
      pos.push(px + nx * cx, py + ny * cx, cz);
      const cc = c.clone(); if (t >= 0.1 && t <= 0.94) cc.lerp(YEL2, Math.max(0, Math.cos(th * 5)) * 0.25);   // ridge highlights
      col.push(cc.r, cc.g, cc.b);
    }
  }
  for (let i = 0; i < nA; i++) for (let j = 0; j < nR; j++) { const a = i * (nR + 1) + j, b = a + nR + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  // end caps
  for (const [i, flip] of [[0, true], [nA, false]] as Array<[number, boolean]>) {
    const [px, py] = ctr(i / nA), ci = pos.length / 3; pos.push(px + (i ? len * 0.004 : -len * 0.004), py, 0); const cc = i ? TIP : STEM; col.push(cc.r, cc.g, cc.b);
    for (let j = 0; j < nR; j++) { const a = i * (nR + 1) + j; if (flip) idx.push(ci, a + 1, a); else idx.push(ci, a, a + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
  g.computeVertexNormals();
  // outward winding guard
  const P = g.attributes.position as THREE.BufferAttribute, N = g.attributes.normal as THREE.BufferAttribute; let s = 0;
  for (let i = 0; i < (nA + 1) * (nR + 1); i += 7) { const t = Math.floor(i / (nR + 1)) / nA, [px, py] = ctr(t); s += (P.getX(i) - px) * N.getX(i) + (P.getY(i) - py) * N.getY(i) + P.getZ(i) * N.getZ(i); }
  if (s < 0) { const ix = g.index!.array as Uint32Array; for (let k = 0; k < ix.length; k += 3) { const q = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = q; } g.computeVertexNormals(); }
  return g.toNonIndexed();
}

/** a hand of `n` bananas fanned from a crown (stem at the origin, fingers along +x curving up), placed at (x,y,z) with
 *  yaw `ry` and a roll `rz` (lying on its side ≈ 0.3–0.6). Vertex colours only — use bananaMaterial(). */
export function bananaHand(n: number, len: number, x: number, y: number, z: number, ry = 0, rz = 0, seed = 1): Geo {
  const rnd = mulberry(seed * 31 + n), parts: Geo[] = [], m = new THREE.Matrix4();
  for (let k = 0; k < n; k++) {
    const f = n > 1 ? k / (n - 1) - 0.5 : 0, b = bananaGeo(len * (0.92 + rnd() * 0.14), seed * 7 + k);
    m.makeRotationFromEuler(new THREE.Euler(f * 0.5 + (rnd() - 0.5) * 0.08, f * 0.9, (rnd() - 0.5) * 0.12)); b.applyMatrix4(m);
    b.translate(0, Math.abs(f) * len * 0.03, f * len * 0.1);
    parts.push(b);
  }
  // crown: a stubby green-brown knob joining the stems
  const crown = new THREE.CylinderGeometry(len * 0.045, len * 0.06, len * 0.16, 7).rotateZ(Math.PI / 2).translate(-len * 0.05, 0, 0).toNonIndexed(); tint(crown, "#6a5a26");
  crown.deleteAttribute("uv"); parts.push(crown);
  const pos: number[] = [], col: number[] = [], nor: number[] = [];
  for (const p of parts) { pos.push(...(p.attributes.position.array as Float32Array)); col.push(...(p.attributes.color.array as Float32Array)); nor.push(...(p.attributes.normal.array as Float32Array)); p.dispose(); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz, "YXZ")), new THREE.Vector3(1, 1, 1)));
  // uv for merge compatibility
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}
let _ban: THREE.MeshStandardMaterial | null = null;
/** the banana material: vertex colours carry the yellow/green/brown (material colour stays white — never tint² orange) */
export function bananaMaterial(): THREE.MeshStandardMaterial {
  if (_ban) return _ban;
  _ban = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.48, metalness: 0, vertexColors: true });
  _ban.name = "jungle-banana";
  return _ban;
}
