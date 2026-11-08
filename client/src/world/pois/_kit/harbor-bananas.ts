// poi-harbor kit — bananas:
// a heap is a DOMED mound skinned with a painted pile of ripe bananas (1024² tileable colour + relief normal map, 2 m
// tile, UVs from world xz — one draw for every heap), topped by a few HERO 3D fruits / hands on its crown and rolled
// off round its foot. Chunky toy-scale FRUIT (≈ 0.3 m, ridged, green stem, dark tip) and whole HANDS (7 fingers from a
// crown) stay instanced prototypes: hi within ~15 m, low beyond, skins to 140 m+.
//
//   const bk = new BananaKit();
//   bk.hand(x, y, z, yaw, tilt, scale)              // one hand lying on a surface at y
//   bk.fruit(x, y, z, yaw, pitch, roll, scale)      // one loose banana
//   bk.heap(x, y, z, rx, rz, h, seed, ground?)      // a heap of hands (+ loose fruit at its foot)
//   bk.crate(base, w, d, top, seed)                 // fill an open crate (2–3 layers, heaped over the rim)
//   bk.spill(x, y, z, dirX, dirZ, count, len, seed, ground?)  // fruit + hands pouring out along a direction
//   group.add(bk.build({ name }))                   // ≤ 3 draws (hands, fruit, heap cores)
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { canvas, drawFruitBanana, normalFromHeight, rng, tex } from "./harbor-paint";

// ripe lemon-gold (#f2c230, not orange-tan), belly a touch deeper, green at the neck
// (deep + saturated — a paler lemon renders S 0.64–0.71, pastel tan, under the sky light + ACES; the target
// art's fruit measures lit #d99701 / mid #9c681a, S 0.83–1.0)
// (and not near-white: ACES + the grade bleach a V ≈ 0.95 albedo to S 0.56–0.7 in the sun; V ≈ 0.85 stays deep gold)
// richer ripe lemon-gold, a warm gold belly
// instead of olive, only a hint of green at the neck
// (the sun + atmos' warm bounce turn a yellow albedo ~12–16° toward orange: #f2c800 rendered #e5a040 H 35 — so the
// albedo sits at H 54–56 to land on the target lemon-gold H 42–46)
const YELLOW = new THREE.Color("#f0da10"), YELLOW_D = new THREE.Color("#e4cc08"), BELLY = new THREE.Color("#d6b606"), GREEN = new THREE.Color("#b6bc1e"), STEM = new THREE.Color("#5a5a16"), TIP = new THREE.Color("#4a2e10");

/** one finger along +X (stem end at x=0), curving up (+Y), pentagonal ridged section, vertex-coloured. `len` metres. */
function fingerInto(pos: number[], nor: number[], col: number[], m: THREE.Matrix4, len: number, segs: number, sides: number) {
  const P: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) { const t = i / segs; P.push(new THREE.Vector3(t * len, Math.sin(t * Math.PI * 0.9) * len * 0.2 + t * t * len * 0.07, 0)); }
  // chunky toy fruit (fat, clearly curved bananas): stalk → full belly → blunt tip
  const rad = (t: number) => (t < 0.1 ? len * (0.034 + t * 0.2) : len * (0.058 + 0.082 * Math.pow(Math.sin(Math.min(1, (t - 0.1) / 0.88) * Math.PI), 0.45))) * (t > 0.95 ? 0.72 : 1);
  const ring: THREE.Vector3[][] = [], rn: THREE.Vector3[][] = [];
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, p = P[i];
    const tg = (i < segs ? P[i + 1].clone().sub(p) : p.clone().sub(P[i - 1])).normalize();
    const n = new THREE.Vector3(0, 0, 1), b = new THREE.Vector3().crossVectors(tg, n).normalize();
    n.crossVectors(b, tg).normalize();
    const r = rad(t), row: THREE.Vector3[] = [], rowN: THREE.Vector3[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2 + 0.3, d = n.clone().multiplyScalar(Math.cos(a)).add(b.clone().multiplyScalar(Math.sin(a)));
      row.push(p.clone().addScaledVector(d, r).applyMatrix4(m)); rowN.push(d.clone().applyMatrix3(nm).normalize());
    }
    ring.push(row); rn.push(rowN);
  }
  const colAt = (t: number, s: number): THREE.Color => {
    // facets alternate (ridged fruit); the inner curve (s = 2, 3: the belly facing down/in) is a deeper gold
    const c = t < 0.08 ? STEM.clone() : t < 0.2 ? GREEN.clone().lerp(YELLOW, (t - 0.08) / 0.12) : (s === 2 || s === 3 ? BELLY : s % 2 ? YELLOW : YELLOW_D).clone();
    if (t > 0.92) c.lerp(TIP, Math.min(1, (t - 0.92) / 0.08) * 0.25);
    return c;
  };
  for (let i = 0; i < segs; i++) for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides;
    // flat-ish facets (ridged fruit): per-facet normal = average of its 4 corner normals
    const q = [[i, s], [i + 1, s], [i + 1, s1], [i, s1]] as Array<[number, number]>;
    const fn = new THREE.Vector3(); for (const [a, b] of q) fn.add(rn[a][b]); fn.normalize();
    // (winding: A → D → C, A → C → B faces OUTWARD — an A B C order turns every finger inside out, so only
    // the far, back-lit inner faces draw and the bananas read as flat khaki paper)
    // mostly SMOOTH normals (a plump fruit; pure facet normals read as folded paper at 2 m) with a hint of the
    // facet left in for the ridges
    for (const k of [0, 3, 2, 0, 2, 1]) {
      const [a, b] = q[k], v = ring[a][b], c = colAt(a / segs, s), vn = rn[a][b].clone().multiplyScalar(0.72).addScaledVector(fn, 0.28).normalize();
      pos.push(v.x, v.y, v.z); nor.push(vn.x, vn.y, vn.z); col.push(c.r, c.g, c.b);
    }
  }
  // blunt dark tip cap
  const tipC = P[segs].clone().applyMatrix4(m), tn = P[segs].clone().sub(P[segs - 1]).normalize().applyMatrix3(nm).normalize();
  for (let s = 0; s < sides; s++) {
    const a = ring[segs][s], b = ring[segs][(s + 1) % sides];
    for (const v of [a, b, tipC]) { pos.push(v.x, v.y, v.z); nor.push(tn.x, tn.y, tn.z); col.push(TIP.r, TIP.g, TIP.b); }
  }
}
function geoFrom(pos: number[], nor: number[], col: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

const fruitCache = new Map<boolean, THREE.BufferGeometry>();
/** a loose banana ≈ 0.3 m along +X, lying on y = 0 (low: 3 segments — for 35 m+) */
export function fruitGeometry(low = false): THREE.BufferGeometry {
  const hit = fruitCache.get(low); if (hit) return hit;
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  fingerInto(pos, nor, col, new THREE.Matrix4().makeTranslation(-0.15, 0.035, 0), 0.3, low ? 3 : 5, 5);
  const g = geoFrom(pos, nor, col);
  fruitCache.set(low, g);
  return g;
}
const handCache = new Map<boolean, THREE.BufferGeometry>();
/** a hand: 6 fingers (4 + 2 rows) fanned from a green crown, lying on y = 0, fingers toward +X, ≈ 0.36 × 0.34 m */
export function handGeometry(low = false): THREE.BufferGeometry {
  const hit = handCache.get(low); if (hit) return hit;
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const segs = low ? 3 : 5, sides = 5;
  // fingers packed side by side in two rows from the crown (a real hand, not a fan): [z offset, yaw, lift, len, row]
  const fingers: Array<[number, number, number, number, number]> = [[-0.12, -0.2, 0, 0.3, 0], [-0.04, -0.07, 0, 0.31, 0], [0.04, 0.07, 0, 0.31, 0], [0.12, 0.2, 0, 0.3, 0], [-0.075, -0.13, 0.07, 0.29, 1], [0.0, 0, 0.075, 0.3, 1], [0.075, 0.13, 0.07, 0.29, 1]];
  for (const [oz, yaw, lift, len, row] of fingers) {
    const m = new THREE.Matrix4().makeTranslation(-0.02 - row * 0.03, 0.045 + lift, oz).multiply(new THREE.Matrix4().makeRotationY(yaw)).multiply(new THREE.Matrix4().makeRotationZ(0.1 + row * 0.16)).multiply(new THREE.Matrix4().makeTranslation(0.02, 0, 0));
    fingerInto(pos, nor, col, m, len, segs, sides);
  }
  // the crown + a stub of stalk
  const crown = new THREE.BoxGeometry(0.045, 0.05, 0.19).toNonIndexed().translate(-0.03, 0.055, 0);
  const stalk = new THREE.CylinderGeometry(0.018, 0.024, 0.07, 6).toNonIndexed().rotateZ(Math.PI / 2).translate(-0.08, 0.06, 0);
  for (const g of [crown, stalk]) {
    g.computeVertexNormals();
    const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(STEM.r, STEM.g, STEM.b); }
  }
  const g = geoFrom(pos, nor, col);
  handCache.set(low, g);
  return g;
}

let matCache: THREE.MeshStandardMaterial | null = null;
export function bananaMaterial(): THREE.MeshStandardMaterial {
  if (matCache) return matCache;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0, envMapIntensity: 0.8, name: "banana-fruit" });
  // stylised fruit (saturated, glowing yellow even in the shade): a little of the albedo comes back as a warm
  // wrap/bounce term, so shaded bananas stay golden instead of going khaki under the blue sky light
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vec3( 0.1, 0.1, 0.05 );");
  };
  m.customProgramCacheKey = () => "banana-fruit-wrap2";
  return (matCache = m);
}
// ------------------------------------------------------------------------------------------------ baked heap skin
let bakeRenderer: THREE.WebGLRenderer | null = null;
/** give the kit the engine's renderer: the heap skin is then BAKED from real 3D fruit (see bakeHeapSkin) instead of
 *  painted with 2D banana drawings (which read as orange-tan chips, or straw / noodles up close) */
export function useBananaRenderer(r: THREE.WebGLRenderer) { bakeRenderer = r; }
/** metres per skin tile (UV = world xz / HEAP_TILE) */
export const HEAP_TILE = 2;
let heightCache: { data: Float32Array; size: number } | null = null;
/** the baked pile's relief (0 = the deepest gap, 1 = the crown of the top fruit) at a tile uv — the dome's vertices
 *  follow it so the heap silhouette is lumpy fruit, not a smooth jelly dome */
export function heapRelief(u: number, v: number): number {
  const h = heightCache; if (!h) return 0.5;
  const S = h.size, x = ((u % 1) + 1) % 1 * S, y = ((v % 1) + 1) % 1 * S;
  const x0 = Math.floor(x) % S, y0 = Math.floor(y) % S, x1 = (x0 + 1) % S, y1 = (y0 + 1) % S, fx = x - Math.floor(x), fy = y - Math.floor(y);
  const g = (i: number, j: number) => h.data[j * S + i];
  return (g(x0, y0) * (1 - fx) + g(x1, y0) * fx) * (1 - fy) + (g(x0, y1) * (1 - fx) + g(x1, y1) * fx) * fy;
}
/**
 * Bake a tileable 2 × 2 m pile of ripe bananas: ~110 hands + 60 loose fruit (the hi prototypes, 1.3× toy scale) in four
 * tumbled layers, rendered straight down (orthographic, wrapped copies across the tile edges) into ALBEDO (vertex
 * colours + cavity darkening from the pile's depth), a TANGENT-SPACE NORMAL map of the actual fruit surfaces, and the
 * height field (for heapRelief). One-time, ~40 ms; the maps are 1024².
 */
type SkinMaps = { map: THREE.Texture; normalMap: THREE.Texture };
function bakeHeapSkin(renderer: THREE.WebGLRenderer): SkinMaps | null {
  const it = bakeSteps(renderer);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
/** the bake as a generator — it yields between the passes and every block of rows, so `prepareBananaSkin`
 *  can run it in the module's time slices (it was one ~260 ms main-thread task) */
function* bakeSteps(renderer: THREE.WebGLRenderer): Generator<void, SkinMaps | null, void> {
  const T = HEAP_TILE, S = 1024, R = 2048;
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const r = rng(90210);
  const hand = handGeometry(false), fr = fruitGeometry(false);
  const put = (g: THREE.BufferGeometry, m: THREE.Matrix4) => {
    const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute, c = g.attributes.color as THREE.BufferAttribute;
    const nm = new THREE.Matrix3().getNormalMatrix(m), v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m); pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); nor.push(v.x, v.y, v.z);
      col.push(c.getX(i), c.getY(i), c.getZ(i));
    }
  };
  const e = new THREE.Euler(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), tp = new THREE.Vector3(), mm = new THREE.Matrix4();
  // (big chunky toy fruit — the heap should read as individual 0.5 m bananas: 3 loose layers, 16–20 pieces each)
  const layers = 3;
  for (let l = 0; l < layers; l++) {
    // a dense bed (no gaps down to the dark ground) + two tumbled layers on it
    const n = l === 0 ? 52 : 24;   // (a dense bed — bare gaps showed the dark clear colour as "soil patches")
    for (let i = 0; i < n; i++) {
      const isHand = r() < 0.62, s = (isHand ? 1.6 : 1.9) * (0.9 + 0.2 * r());
      const x = r() * T, z = r() * T, y = l * 0.11 + r() * 0.04;
      e.set((r() - 0.5) * (isHand ? 0.5 : 0.9), r() * Math.PI * 2, (r() - 0.5) * (isHand ? 0.45 : 0.7), "YZX");
      q.setFromEuler(e); sc.setScalar(s);
      // wrapped copies so the tile repeats seamlessly (only the ones that reach into the tile)
      for (const ox of [-T, 0, T]) for (const oz of [-T, 0, T]) {
        if (x + ox < -0.4 || x + ox > T + 0.4 || z + oz < -0.4 || z + oz > T + 0.4) continue;
        mm.compose(tp.set(x + ox, y, z + oz), q, sc);
        put(isHand ? hand : fr, mm);
      }
      if (i % 10 === 9) yield;   // (the 100 pieces in one step took ~125 ms)
    }
  }
  yield;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const yMax = layers * 0.11 + 0.32;
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { mode: { value: 0 }, yMax: { value: yMax } },
    vertexShader: `precision highp float; in vec3 position; in vec3 normal; in vec3 color; uniform mat4 projectionMatrix; uniform mat4 modelViewMatrix;
      out vec3 vC; out vec3 vN; out float vY;
      void main() { vC = color; vN = normal; vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
    fragmentShader: `precision highp float; uniform int mode; uniform float yMax; in vec3 vC; in vec3 vN; in float vY; out vec4 o;
      void main() {
        vec3 n = normalize( gl_FrontFacing ? vN : -vN );
        if ( mode == 0 ) o = vec4( pow( max( vC, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) ), 1.0 );
        else if ( mode == 1 ) o = vec4( n * 0.5 + 0.5, 1.0 );
        else o = vec4( vec3( clamp( vY / yMax, 0.0, 1.0 ) ), 1.0 );
      }`,
    side: THREE.DoubleSide,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(g, mat));
  const cam = new THREE.OrthographicCamera(-T / 2, T / 2, T / 2, -T / 2, 0.1, 20);
  cam.position.set(T / 2, 10, T / 2); cam.up.set(0, 0, -1); cam.lookAt(T / 2, 0, T / 2); cam.updateMatrixWorld(true);
  const rt = new THREE.WebGLRenderTarget(R, R, { depthBuffer: true, type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
  const px: Uint8Array[] = [];
  // (one pass per step, the renderer's state restored before each yield: the three 2048² render + readback passes in one
  // step were a single 8 s task on SwiftShader)
  try {
    for (const [mode, clear] of [[0, 0x9a6c0e], [1, 0x80ff80], [2, 0x000000]] as Array<[number, number]>) {
      const prevRT = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
      try {
        renderer.autoClear = true;
        mat.uniforms.mode.value = mode;
        renderer.setRenderTarget(rt); renderer.setClearColor(clear, 1); renderer.clear(true, true, true);
        renderer.render(scene, cam);
        const buf = new Uint8Array(R * R * 4);
        renderer.readRenderTargetPixels(rt, 0, 0, R, R, buf);
        px.push(buf);
      } finally { renderer.setRenderTarget(prevRT); renderer.setClearColor(prevClear, prevAlpha); renderer.autoClear = prevAuto; }
      yield;
    }
  } catch (err) { console.warn("[bananas] heap bake failed", err); return null; } finally {
    rt.dispose(); g.dispose(); mat.dispose();
  }
  // downsample 2048 → 1024 (2×2 box) into float planes; the rows stay as read (row 0 = world z = T: with the canvas
  // texture's flipY that is v = 1 → uv.v = z / T)
  yield;
  const A = new Float32Array(S * S * 3), N = new Float32Array(S * S * 3), H = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (x === 0 && (y & 127) === 127) yield;
    let ar = 0, ag = 0, ab = 0, nx = 0, ny = 0, nz = 0, hh = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const k = ((2 * y + dy) * R + 2 * x + dx) * 4;
      ar += px[0][k]; ag += px[0][k + 1]; ab += px[0][k + 2];
      nx += px[1][k] / 127.5 - 1; ny += px[1][k + 1] / 127.5 - 1; nz += px[1][k + 2] / 127.5 - 1;
      hh += px[2][k];
    }
    const i = y * S + x;
    A[i * 3] = ar / 4; A[i * 3 + 1] = ag / 4; A[i * 3 + 2] = ab / 4;
    N[i * 3] = nx; N[i * 3 + 1] = ny; N[i * 3 + 2] = nz;
    H[i] = hh / (4 * 255);
  }
  // a wide blur of the height = the local "surface" level: a pixel well below it is a gap between fruit (cavity)
  const blur = (src: Float32Array, rad: number) => {
    const tmp = new Float32Array(S * S), out = new Float32Array(S * S);
    for (let y = 0; y < S; y++) { let acc = 0; for (let k = -rad; k <= rad; k++) acc += src[y * S + ((k + S) % S)]; for (let x = 0; x < S; x++) { tmp[y * S + x] = acc / (2 * rad + 1); acc += src[y * S + ((x + rad + 1) % S)] - src[y * S + ((x - rad + S) % S)]; } }
    for (let x = 0; x < S; x++) { let acc = 0; for (let k = -rad; k <= rad; k++) acc += tmp[((k + S) % S) * S + x]; for (let y = 0; y < S; y++) { out[y * S + x] = acc / (2 * rad + 1); acc += tmp[((y + rad + 1) % S) * S + x] - tmp[((y - rad + S) % S) * S + x]; } }
    return out;
  };
  yield;
  const Hb1 = blur(H, 14);
  yield;
  const Hb = blur(Hb1, 14);
  yield;
  const [ael, ac] = canvas(S, S), [nel, nc] = canvas(S, S);
  const ai = ac.createImageData(S, S), ni = nc.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    if ((i & 131071) === 131071) yield;
    // cavity: deep gaps go dark warm brown, the top layer keeps full ripe yellow
    // (deep, WARM cavities — the gaps between fruit go orange-brown, never olive mud — and the crown layer a
    // touch brighter than the bed: the heap should show strong self-shadow between chunky glossy fruit)
    const cav = Math.max(0, Math.min(1, (Hb[i] - H[i]) * 6)), depth = 0.72 + 0.34 * Math.min(1, H[i] / 0.75);
    const k = depth * (1 - 0.55 * cav);
    ai.data[i * 4] = Math.min(255, A[i * 3] * k * (1 + 0.08 * cav)); ai.data[i * 4 + 1] = Math.min(255, A[i * 3 + 1] * k * (0.94 + 0.06 * k) * (1 - 0.12 * cav)); ai.data[i * 4 + 2] = Math.min(255, A[i * 3 + 2] * k * (1 - 0.4 * cav)); ai.data[i * 4 + 3] = 255;
    // world normal (x, y up, z) → tangent space (T = +x = +u, B = +z = +v, N = +y)
    let tx = N[i * 3], ty = N[i * 3 + 2], tz = N[i * 3 + 1];
    const l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
    if (tz < 0.05) { tz = 0.05; }
    ni.data[i * 4] = Math.round((tx * 0.5 + 0.5) * 255); ni.data[i * 4 + 1] = Math.round((ty * 0.5 + 0.5) * 255); ni.data[i * 4 + 2] = Math.round((tz * 0.5 + 0.5) * 255); ni.data[i * 4 + 3] = 255;
  }
  ac.putImageData(ai, 0, 0); nc.putImageData(ni, 0, 0);
  heightCache = { data: new Float32Array(S * S), size: S };
  // heightCache is indexed by texture (u, v): v = 1 − row / S (flipY) → store rows flipped
  for (let y = 0; y < S; y++) heightCache.data.set(H.subarray((S - 1 - y) * S, (S - y) * S), y * S);
  return { map: tex(ael, { aniso: 8 }), normalMap: tex(nel, { srgb: false, aniso: 8 }) };
}

let coreCache: THREE.MeshStandardMaterial | null = null;
/** the heap SKIN: a pile of ripe bananas (tileable 2 m, UV = world xz / 2) — BAKED from real 3D fruit when the engine
 *  renderer was handed over (useBananaRenderer), else painted — reads as a heap of individual fruit from 5 m to 200 m
 *  for one draw; hero 3D fruit sit on top of it near the camera */
let skinPre: SkinMaps | null = null, skinJob: Promise<void> | null = null;
/** bake the heap skin in the module's time slices (call before anything builds a BananaKit) */
export function prepareBananaSkin(yieldFn: () => Promise<void>): Promise<void> {
  if (coreCache || skinPre || !bakeRenderer) return Promise.resolve();
  return (skinJob ??= (async () => { const it = bakeSteps(bakeRenderer!); let r = it.next(); while (!r.done) { await yieldFn(); r = it.next(); } skinPre = r.value; })());
}
export function bananaCoreMat(): THREE.MeshStandardMaterial {
  if (coreCache) return coreCache;
  const baked = skinPre ?? (bakeRenderer ? bakeHeapSkin(bakeRenderer) : null);
  if (baked) {
    coreCache = new THREE.MeshStandardMaterial({ map: baked.map, normalMap: baked.normalMap, normalScale: new THREE.Vector2(1.45, 1.45), roughness: 0.38, metalness: 0, envMapIntensity: 0.8, name: "banana-skin" });
    coreCache.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vec3( 0.12, 0.12, 0.04 );");
    };
    coreCache.customProgramCacheKey = () => "banana-skin-wrap";
    return coreCache;
  }
  const S = 1024;
  const [el, c] = canvas(S, S), [hel, h] = canvas(S, S);
  c.fillStyle = "#b8871c"; c.fillRect(0, 0, S, S);        // the shaded gaps deep in the pile (warm gold, not mud)
  h.fillStyle = "#000"; h.fillRect(0, 0, S, S);
  const r = rng(4711);
  const N = 240;
  for (let i = 0; i < N; i++) {
    const depth = i / N;                                  // later = higher in the pile = brighter, less shaded
    const x = r() * S, y = r() * S, len = 230 + r() * 90, rot = r() * Math.PI * 2;
    const k = 0.86 + 0.14 * depth, ripe = r();
    const col = ripe < 0.12 ? `rgb(${Math.round(214 * k)},${Math.round(196 * k)},${Math.round(52 * k)})` : `rgb(${Math.round(247 * k)},${Math.round((198 + ripe * 14) * k)},${Math.round(48 * k)})`;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      if (x + ox < -len || x + ox > S + len || y + oy < -len || y + oy > S + len) continue;
      drawFruitBanana(c, x + ox, y + oy, len, rot, { color: col, shade: "rgba(214,150,20,0.4)", highlight: "rgba(255,252,220,0.5)", ridge: "rgba(190,140,30,0.3)", tip: "#3b2a10", stem: "#7a7a26", outline: "rgba(120,80,10,0.5)" });
      const g = Math.round(90 + 165 * depth);
      drawFruitBanana(h, x + ox, y + oy, len, rot, { color: `rgb(${g},${g},${g})`, flat: true });
    }
  }
  h.filter = "blur(3px)"; h.drawImage(hel, 0, 0); h.filter = "none";
  const map = tex(el, { aniso: 8 }), normalMap = tex(normalFromHeight(hel, 5), { srgb: false });
  coreCache = new THREE.MeshStandardMaterial({ map, normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.48, metalness: 0, name: "banana-skin" });
  coreCache.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vec3( 0.12, 0.12, 0.04 );");
  };
  coreCache.customProgramCacheKey = () => "banana-skin-wrap";
  return coreCache;
}
/** @deprecated single-fruit prototype (use fruitGeometry) */
export const bananaGeometry = fruitGeometry;

/** lumpy mound (radius r, height h) — squashed displaced hemisphere, base slightly sunk (the heap's core) */
export function moundGeo(r: number, h: number, seed: number, lowRes = false, hiRes = false): THREE.BufferGeometry {
  const g0 = lowRes ? new THREE.SphereGeometry(1, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2) : hiRes ? new THREE.SphereGeometry(1, 30, 11, 0, Math.PI * 2, 0, Math.PI / 2) : new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  g0.deleteAttribute("normal");
  const g = mergeVertices(g0);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // lumpy, domed (rounded 0.6–1 m mounds, not flat carpets)
    const n = 1 + 0.12 * Math.sin(x * 5 + seed) * Math.cos(z * 4.3 - seed) + 0.06 * Math.sin(x * 11 - z * 9 + seed * 2);
    p.setXYZ(i, x * r * n, Math.pow(Math.max(0, y), 0.8) * h * n - 0.06, z * r * n);
  }
  g.computeVertexNormals();
  return g;
}

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

export class BananaKit {
  readonly hands: THREE.Matrix4[] = [];
  readonly fruits: THREE.Matrix4[] = [];
  readonly cores: Array<{ m: THREE.Matrix4; r: number; h: number; seed: number }> = [];
  /** old API: the single-fruit matrices (kept so callers can test `bk.mats.length`) */
  get mats() { return [...this.hands, ...this.fruits]; }
  constructor(readonly low = false) {}
  private push(list: THREE.Matrix4[], x: number, y: number, z: number, yaw: number, pitch: number, roll: number, s: number) {
    _e.set(roll, yaw, pitch, "YZX"); _q.setFromEuler(_e); _p.set(x, y, z); _s.setScalar(s);
    list.push(new THREE.Matrix4().compose(_p, _q, _s));
  }
  /** one loose banana (three.js yaw, pitch about its width, roll about its length) */
  fruit(x: number, y: number, z: number, yaw: number, pitch = 0, roll = 0, scale = 1) { this.push(this.fruits, x, y, z, yaw, pitch, roll, scale); }
  /** old API: add(x,y,z,yaw,pitch,roll,scale) = one fruit */
  add(x: number, y: number, z: number, yaw: number, pitch: number, roll: number, scale = 1) { this.fruit(x, y, z, yaw, pitch, roll, scale / 1.6); }
  /** one hand lying on a surface at y (tilt: pitch/roll in radians, e.g. following a heap's slope) */
  hand(x: number, y: number, z: number, yaw: number, _n = 6, scale = 1, seed = 1, pitch = 0, roll = 0) {
    const r = rng(seed);
    this.push(this.hands, x, y, z, yaw, pitch + (r() - 0.5) * 0.12, roll + (r() - 0.5) * 0.2, scale * (0.92 + 0.16 * r()));
  }
  /**
   * A heap of hands: an elliptical mound (rx, rz, height h) covered by hands lying on its surface in two layers
   * (tilted with the slope, random yaw), a dark core under them, loose fruit rolled off around the foot.
   */
  heap(x: number, y: number, z: number, rx: number, rz: number, h: number, seed = 2, ground?: (x: number, z: number) => number, yaw = 0, scale = 1) {
    const r = rng(seed), c = Math.cos(yaw), s = Math.sin(yaw);
    const hAt = (u: number, v: number) => { const d = Math.min(1, Math.hypot(u / rx, v / rz)); return h * (1 - d * d) ** 0.8; };
    // the skinned dome (the heap itself)
    this.cores.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(rx, 1, rz)), r: 1, h, seed });
    // hero fruit on the crown (a hand every third piece), following the slope — a few, not a carpet
    // (every other hero piece a whole HAND — the crown
    // reads as separate bunches over the baked skin)
    const area = Math.PI * rx * rz, n = Math.max(10, Math.min(40, Math.round(area * 3.2)));
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.7, u = Math.cos(a) * d * rx, v = Math.sin(a) * d * rz;
      const yy = hAt(u, v), gx = (hAt(u + 0.1, v) - hAt(u - 0.1, v)) / 0.2, gz = (hAt(u, v + 0.1) - hAt(u, v - 0.1)) / 0.2;
      const wx = x + u * c + v * s, wz = z - u * s + v * c, base = ground ? Math.max(y, ground(wx, wz)) : y;
      const hy = r() * 6.28, slopeA = Math.atan(Math.hypot(gx, gz)), dir = Math.atan2(-gz, gx) + yaw, rel = dir - hy;
      if (i % 2 === 0) this.hand(wx, base + yy - 0.06 * scale, wz, hy, 6, scale * 0.95, seed * 31 + i, Math.cos(rel) * slopeA, -Math.sin(rel) * slopeA);
      else this.fruit(wx, base + yy - 0.04 * scale, wz, hy, Math.cos(rel) * slopeA + (r() - 0.5) * 0.3, -Math.sin(rel) * slopeA + (r() - 0.5) * 1.4, scale * (0.9 + 0.2 * r()));
    }
    // rolled off round the foot and strewn 2–4 m out (single fruit, the odd hand)
    for (let i = 0; i < Math.max(4, n * 0.55); i++) {
      const a = r() * Math.PI * 2, out = r() < 0.4 ? 0.1 + r() * 0.5 : 2 + r() * 2, u = Math.cos(a) * (rx + out), v = Math.sin(a) * (rz + out);
      const wx = x + u * c + v * s, wz = z - u * s + v * c;
      this.fruit(wx, (ground ? ground(wx, wz) : y) + 0.005, wz, r() * 6.28, (r() - 0.5) * 0.3, (r() - 0.5) * 0.6, scale * (0.9 + 0.2 * r()));
    }
  }
  /** fill an open crate (local frame `base` = crate centre at its floor): a skinned dome heaped over the rim + a few
   *  hero hands on its crown */
  crate(base: THREE.Matrix4, w: number, d: number, rim: number, seed: number, scale = 1) {
    const r = rng(seed), wp = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), e = new THREE.Euler();
    base.decompose(wp, q, sc);
    e.setFromQuaternion(q, "YXZ");
    const byaw = e.y, cy = Math.cos(byaw), sy = Math.sin(byaw);
    this.cores.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(wp.x, wp.y + rim - 0.1, wp.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, byaw, 0)), new THREE.Vector3(w * 0.5, 1, d * 0.52)), r: 1, h: 0.36 * scale, seed });
    for (let i = 0; i < 3; i++) {
      if (i === 2 && r() < 0.4) continue;
      const lx = (i - 1) * w * 0.26 + (r() - 0.5) * 0.08, lz = (r() - 0.5) * d * 0.3;
      const x = wp.x + lx * cy + lz * sy, z = wp.z - lx * sy + lz * cy, out = Math.hypot(lx / (w / 2), lz / (d / 2));
      this.hand(x, wp.y + rim + 0.12 * scale * (1 - out * out), z, byaw + r() * 6.28, 6, scale, seed * 17 + i, (r() - 0.5) * 0.3, (r() - 0.5) * 0.3);
    }
  }
  /** old API: a mound of `count` loose items within `radius`, heaped to `height` → a heap of hands */
  pile(x: number, y: number, z: number, _count: number, radius: number, height: number, seed = 2, scale = 1) {
    this.heap(x, y, z, radius, radius * 0.85, height, seed, undefined, 0, Math.min(1.6, scale / 2.2));
  }
  /** fruit (and a few hands) pouring out along (dirX, dirZ): dense near the origin, thinning over `length` metres */
  spill(x: number, y: number, z: number, dirX: number, dirZ: number, count: number, length: number, seed = 3, ground?: (x: number, z: number) => number, scale = 1) {
    const r = rng(seed), l = Math.hypot(dirX, dirZ) || 1, dx = dirX / l, dz = dirZ / l, px = -dz, pz = dx, s = Math.min(1.6, scale / 2.2);
    count = Math.max(4, Math.round(count * 0.3));   // a scatter of hero fruit, not a carpet
    for (let i = 0; i < count; i++) {
      const t = r() ** 1.6 * length, w = (r() - 0.5) * (0.6 + t * 0.55);
      const bx = x + dx * t + px * w, bz = z + dz * t + pz * w;
      const by = (ground ? ground(bx, bz) : y) + Math.max(0, 0.3 - t * 0.1) * r() * s;
      if (r() < 0.3) this.hand(bx, by, bz, r() * 6.28, 6, s, seed * 7 + i, (r() - 0.5) * 0.3, (r() - 0.5) * 0.3);
      else this.fruit(bx, by + 0.005, bz, r() * Math.PI * 2, (r() - 0.5) * 0.4, (r() - 0.5) * 1.2, s * (0.85 + 0.3 * r()));
    }
  }
  /**
   * Per-INSTANCE distance LOD (a box-level LOD shows every hand of the beach at full detail as soon as the camera
   * touches the spill's bounding box): hands + fruit in two instanced meshes each (full model ≤ `near`, the 3-segment
   * one to `far`, nothing beyond), re-bucketed when the camera moves > 1.5 m; the skins as one mesh (the caller LODs it).
   * `update(camLocal)` takes the camera in the group's frame (world when the group sits at the origin).
   */
  buildLod(o: { name: string; near: number; far: number }): THREE.Group & { update(cam: THREE.Vector3): void } {
    const g = new THREE.Group() as THREE.Group & { update(cam: THREE.Vector3): void };
    g.name = o.name;
    const lists: Array<{ mats: THREE.Matrix4[]; pos: THREE.Vector3[]; hi: THREE.InstancedMesh; lo: THREE.InstancedMesh }> = [];
    for (const [list, hiG, loG, nm] of [[this.hands, handGeometry(false), handGeometry(true), "hands"], [this.fruits, fruitGeometry(false), fruitGeometry(true), "fruit"]] as const) {
      if (!list.length) continue;
      const mk = (geo: THREE.BufferGeometry, lvl: string) => {
        const im = new THREE.InstancedMesh(geo, bananaMaterial(), list.length);
        im.name = `${o.name}-${nm}-${lvl}`; im.count = 0; im.visible = false;
        im.castShadow = false; im.receiveShadow = true; im.userData.castShadow = false; im.userData.farShadow = false;
        g.add(im); return im;
      };
      lists.push({ mats: list, pos: list.map((m) => new THREE.Vector3().setFromMatrixPosition(m)), hi: mk(hiG, "hi"), lo: mk(loG, "lo") });
    }
    const skins = this.cores.length ? this.build({ name: `${o.name}-skins-tmp`, noCores: false }).children.find((c) => c.name.endsWith("-cores")) : undefined;
    if (skins) { skins.name = `${o.name}-skins`; g.add(skins); }
    const last = new THREE.Vector3(1e9, 0, 0), n2 = o.near * o.near, f2 = o.far * o.far;
    g.update = (cam: THREE.Vector3) => {
      if (cam.distanceToSquared(last) < 2.25) return;
      last.copy(cam);
      for (const L of lists) {
        let h = 0, l = 0;
        const ha = L.hi.instanceMatrix.array as Float32Array, la = L.lo.instanceMatrix.array as Float32Array;
        for (let i = 0; i < L.mats.length; i++) {
          const d2 = L.pos[i].distanceToSquared(cam);
          if (d2 < n2) ha.set(L.mats[i].elements, 16 * h++); else if (d2 < f2) la.set(L.mats[i].elements, 16 * l++);
        }
        for (const [im, c] of [[L.hi, h], [L.lo, l]] as const) { im.count = c; im.visible = c > 0; im.instanceMatrix.needsUpdate = true; im.boundingSphere = null; if (c) im.computeBoundingSphere(); }
      }
    };
    return g;
  }
  /** ≤ 3 draws: hands, loose fruit, heap skins (no shadows by default — they sit in the props' contact shade) */
  build(o: { shadows?: boolean; name?: string; low?: boolean; noCores?: boolean } = {}): THREE.Group {
    const g = new THREE.Group();
    g.name = o.name ?? "bananas";
    const inst = (geo: THREE.BufferGeometry, list: THREE.Matrix4[], name: string) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geo, bananaMaterial(), list.length);
      list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = o.shadows ?? false; mesh.receiveShadow = true;
      mesh.userData.castShadow = mesh.castShadow; mesh.userData.farShadow = false;
      mesh.name = name;
      mesh.computeBoundingSphere();
      g.add(mesh);
    };
    inst(handGeometry(o.low ?? this.low), this.hands, `${g.name}-hands`);
    inst(fruitGeometry(o.low ?? this.low), this.fruits, `${g.name}-fruit`);
    if (this.cores.length && !o.noCores) {
      const skinMat = bananaCoreMat();   // (bakes the skin first: the domes follow its relief below)
      // (crate fillers — under a metre across — get the low-res dome)
      const geos = this.cores.map((c) => {
        const small = new THREE.Vector3().setFromMatrixScale(c.m).x < 0.8;
        const g = moundGeo(c.r, c.h, c.seed, small, !small).applyMatrix4(c.m);
        // lumpy silhouette: every vertex pushed out along its normal by the baked pile's relief at its skin uv (the
        // rim stays on the ground)
        const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute;
        const ctr = new THREE.Vector3().setFromMatrixPosition(c.m), base = ctr.y, uvs = new Float32Array(p.count * 2);
        const sc = new THREE.Vector3().setFromMatrixScale(c.m), yaw = Math.atan2(-c.m.elements[8], c.m.elements[0]) || 0, cyw = Math.cos(yaw), syw = Math.sin(yaw);
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i), nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
          // AZIMUTHAL (arc-length) mapping — the distance along the dome's surface from its crown, not the flat top
          // projection, which smears the fruit down the steep flanks into "noodles"
          const dx = x - ctr.x, dz = z - ctr.z, d = Math.hypot(dx, dz);
          let u = ctr.x / HEAP_TILE, v = ctr.z / HEAP_TILE;
          if (d > 1e-4) {
            const lx = (dx * cyw - dz * syw) / sc.x, lz = (dx * syw + dz * cyw) / sc.z, rDir = d / Math.max(1e-4, Math.hypot(lx, lz));
            const t = Math.asin(Math.min(1, d / rDir)), H = c.h;
            let arc = 0; const N = 8;
            for (let k = 0; k < N; k++) { const a = ((k + 0.5) / N) * t; arc += Math.hypot(rDir * Math.cos(a), H * Math.sin(a)) * (t / N); }
            u += (dx / d) * arc / HEAP_TILE; v += (dz / d) * arc / HEAP_TILE;
          }
          uvs[i * 2] = u; uvs[i * 2 + 1] = v;
          const k = Math.min(1, Math.max(0, (y - base) / 0.18)), rel = (heapRelief(u, v) - 0.55) * 0.2 * k;
          p.setXYZ(i, x + nx * rel, y + ny * rel, z + nz * rel);
        }
        g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
        return g.toNonIndexed();
      });
      const pos: number[] = [], nor: number[] = [], uv: number[] = [];
      for (const q of geos) {
        const pa = q.attributes.position.array as Float32Array;
        pos.push(...pa); nor.push(...(q.attributes.normal.array as Float32Array)); uv.push(...(q.attributes.uv.array as Float32Array));
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, skinMat);
      mesh.name = `${g.name}-cores`; mesh.castShadow = false; mesh.receiveShadow = true; mesh.userData.castShadow = false; mesh.userData.farShadow = false;
      g.add(mesh);
    }
    return g;
  }
}
