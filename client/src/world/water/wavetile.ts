// Live GPU ripple field + real caustics. The tile renders every visible frame; the caustics are scheduled by index.ts
// (every other frame, and only while the camera is near enough to see them).
//
// RIPPLES — a tileable heightfield (TILE metres square, 256² texels) = the sum of ~90 lattice-aligned travelling waves
// with real capillary-gravity dispersion (ω² = g·k + σ/ρ·k³), a broad wind-biased directional spread and a flat slope
// spectrum (the "saturation range" of real wind ripples). Because every wave vector sits on the tile's lattice the
// field tiles perfectly while still animating like a real surface (cells form, merge and drift, never just scroll).
//   RGBA8: R, G = ∂h/∂x, ∂h/∂z encoded as slope / TILE_SLOPE_RANGE + 0.5 (±0.6 m/m), B = h, A = ∇²h (both unused)
//   (8-bit halves the bandwidth of the 4 per-pixel tile fetches; decode with wtrTileSl() in the shaders)
// The water shader samples it at three scales (fine / tile / broad) for the surface normal.
//
// CAUSTICS — the classic refracted-grid method (E. Wallace): a 256² grid over the tile is refracted through the ripple
// normals toward a floor at an effective focus depth; every triangle is rasterised where its light lands and writes
// (area before / area after) with additive blending → the bright, curved, crisp caustic network of real shallow water,
// consistent with the ripples above it. ONE grid spanning the tile plus a 25 % margin handles the wrap (the margin
// cells are the periodic images of the opposite edge — ~4× fewer triangles than 3×3 instances). R = sharp focus
// (0–2 m water), G = deeper focus. One light 3×3 tent pass joins sub-texel slivers; no heavier blur (crisp net).
import * as THREE from "three";
import { flag } from "../../flags";
import type { Scope } from "../../engine/res/scope";

export const TILE = 9.0; // metres per ripple tile
/** the tile's slopes are stored as slope / TILE_SLOPE_RANGE + 0.5 in an RGBA8 target */
export const TILE_SLOPE_RANGE = 1.2;
/** the caustics are stored as intensity / CAUS_RANGE in an RGBA8 target (mean ≈ 1 → 0.25) */
export const CAUS_RANGE = 4.0;
const CAUS_ETA = 0.7519;
const _prevClear = new THREE.Color();
const _lightTmp = new THREE.Vector3();

interface WaveDef { kx: number; kz: number; amp: number; omega: number; phase: number }

function hash(i: number, s: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(s, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** deterministic ripple spectrum on the tile lattice */
function spectrum(): WaveDef[] {
  const waves: WaveDef[] = [];
  const used = new Set<string>();
  const windA = 0.55; // radians — dominant ripple direction
  let seed = 1;
  // rings from λ = TILE/1.5 (6 m) down to λ ≈ 0.2 m, log-spaced; more waves on the short rings (they carry the texture)
  const rings = 26;
  for (let r = 0; r < rings; r++) {
    const kmag = 1.5 * Math.pow(46 / 1.5, r / (rings - 1)); // lattice radius (cycles per tile)
    const count = r < 4 ? 2 : r < 12 ? 3 : 4;
    for (let c = 0; c < count; c++) {
      let tries = 0;
      while (tries++ < 12) {
        const u = hash(seed++, 7);
        // wind-biased spread: 70 % within ±70° of the wind, 30 % anywhere (cross/opposing ripples make the lens cells)
        const spread = hash(seed++, 9) < 0.7 ? (u - 0.5) * 2.4 : u * Math.PI * 2;
        const a = windA + spread;
        const m = Math.round(Math.cos(a) * kmag), n = Math.round(Math.sin(a) * kmag);
        if (m === 0 && n === 0) continue;
        const key = `${m},${n}`;
        if (used.has(key) || used.has(`${-m},${-n}`)) continue;
        used.add(key);
        const kx = (2 * Math.PI * m) / TILE, kz = (2 * Math.PI * n) / TILE, k = Math.hypot(kx, kz);
        // slope per wave (k·a): flat-ish slope spectrum, a little stronger in the 0.4–2 m band (the visible lens cells)
        const lam = (2 * Math.PI) / k;
        const band = Math.exp(-Math.pow(Math.log(lam / 0.9) / 1.1, 2));
        const slope = (0.010 + 0.016 * band) * (0.6 + 0.8 * hash(seed++, 11));
        const omega = Math.sqrt(9.81 * k + 7.3e-5 * k * k * k);
        waves.push({ kx, kz, amp: slope / k, omega, phase: hash(seed++, 13) * Math.PI * 2 });
        break;
      }
    }
  }
  return waves;
}

const FS_TILE = (n: number) => /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec4 uW[${n}];      // kx, kz, amp, omega
uniform float uPh[${n}];
varying vec2 vUv;
void main() {
  vec2 p = vUv * ${TILE.toFixed(3)};
  // (perf: only the slopes — B / A (height, laplacian) were never read)
  vec2 d = vec2(0.0);
  for (int i = 0; i < ${n}; i++) {
    vec4 w = uW[i];
    d += w.xy * (w.z * cos(w.x * p.x + w.y * p.y - w.w * uTime + uPh[i]));
  }
  gl_FragColor = vec4(clamp(d / ${TILE_SLOPE_RANGE.toFixed(3)} + 0.5, 0.0, 1.0), 0.5, 0.5);
}`;

const VS_QUAD = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const VS_CAUS = /* glsl */ `
precision highp float;
uniform sampler2D uTile;
uniform vec3 uLight;
uniform vec2 uHit0;
uniform float uDepth;
uniform float uSlope;       // slope gain for the caustic focus
varying vec2 vOld;
varying vec2 vNew;
void main() {
  vec2 uv = position.xy;
  vec2 w = (texture2D(uTile, uv).rg - 0.5) * ${TILE_SLOPE_RANGE.toFixed(3)};
  vec3 n = normalize(vec3(-w.x * uSlope, 1.0, -w.y * uSlope));
  vec3 r = refract(uLight, n, ${CAUS_ETA.toFixed(4)});
  vec2 hit = uv * ${TILE.toFixed(3)} + r.xz * (uDepth / max(-r.y, 0.2));
  vec2 p = (hit - uHit0) / ${TILE.toFixed(3)};
  vOld = uv * ${TILE.toFixed(3)};
  vNew = p * ${TILE.toFixed(3)};
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_CAUS = /* glsl */ `
precision highp float;
uniform vec4 uMask;
varying vec2 vOld;
varying vec2 vNew;
void main() {
  vec2 dOx = dFdx(vOld), dOy = dFdy(vOld);
  vec2 dNx = dFdx(vNew), dNy = dFdy(vNew);
  float oldA = abs(dOx.x * dOy.y - dOx.y * dOy.x);
  float newA = abs(dNx.x * dNy.y - dNx.y * dNy.x);
  float I = min(oldA / max(newA, 1e-7), 12.0);
  gl_FragColor = uMask * I;
}`;

const FS_BLUR = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDir;          // one texel
varying vec2 vUv;
void main() {
  // 3×3 tent (4 bilinear taps at half-texel offsets): joins sub-texel slivers of focused lines, keeps them crisp
  vec2 h = uDir * 0.5;
  gl_FragColor = (texture2D(uTex, vUv + vec2(h.x, h.x)) + texture2D(uTex, vUv - vec2(h.x, h.x))
               + texture2D(uTex, vUv + vec2(h.x, -h.x)) + texture2D(uTex, vUv - vec2(h.x, -h.x))) * (0.25 / ${CAUS_RANGE.toFixed(1)});
}`;

export class WaveTile {
  readonly tile: THREE.WebGLRenderTarget;
  readonly caustics: THREE.WebGLRenderTarget;
  readonly waves: WaveDef[];
  /** effective caustic focus depths (m) for the R / G channels, and the slope gain used for focusing */
  focus = [1.7, 4.2];
  focusSlope = 3.0;
  readonly #scope: Scope;
  #tmpScope: Scope | null = null;
  readonly #causRes: number;
  #tileScene = new THREE.Scene();
  #causScene = new THREE.Scene();
  #cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  #tileMat: THREE.ShaderMaterial;
  #causMat: THREE.ShaderMaterial | null = null;
  #causTmp: THREE.WebGLRenderTarget | null = null;
  #blurMat: THREE.ShaderMaterial | null = null;
  #blurScene = new THREE.Scene();

  constructor(res = 256, causRes = 512, grid = 128, parentScope: Scope) {
    const scope = this.#scope = parentScope.child("wavetile");
    this.#causRes = Math.max(1, causRes);
    const causOn = grid > 0 && causRes > 1;
    this.waves = spectrum();
    const n = this.waves.length;
    const baseOpts: THREE.RenderTargetOptions = {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false,
    };
    const qGeo = scope.geometry("geo.world", new THREE.PlaneGeometry(2, 2));
    this.tile = scope.target(new THREE.WebGLRenderTarget(res, res, { ...baseOpts, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true }));
    this.tile.texture.name = "water-ripple-tile"; this.tile.texture.anisotropy = flag("waniso") || 8;
    this.caustics = scope.target(new THREE.WebGLRenderTarget(this.#causRes, this.#causRes, {
      ...baseOpts, minFilter: causOn ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, generateMipmaps: causOn,
    }));
    this.caustics.texture.name = "water-caustics";
    if (causOn) {
      this.caustics.texture.anisotropy = 4;
      this.#blurMat = scope.material(new THREE.ShaderMaterial({
        uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() } },
        vertexShader: VS_QUAD, fragmentShader: FS_BLUR, depthTest: false, depthWrite: false,
      }));
      const bq = new THREE.Mesh(qGeo, this.#blurMat);
      bq.frustumCulled = false;
      this.#blurScene.add(bq);
    }

    const W = this.waves.map((w) => new THREE.Vector4(w.kx, w.kz, w.amp, w.omega));
    this.#tileMat = scope.material(new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uW: { value: W }, uPh: { value: this.waves.map((w) => w.phase) } },
      vertexShader: VS_QUAD, fragmentShader: FS_TILE(n), depthTest: false, depthWrite: false,
    }));
    const quad = new THREE.Mesh(qGeo, this.#tileMat);
    quad.frustumCulled = false;
    this.#tileScene.add(quad);

    if (causOn) {
      // caustic grid: `grid` quads per tile over uv [−M, 1+M]² (M = 0.25 margin; the tile texture wraps)
      const M = 0.25, G = Math.round(grid * (1 + 2 * M));
      const g = scope.geometry("geo.world", new THREE.BufferGeometry());
      const pos = new Float32Array((G + 1) * (G + 1) * 3);
      for (let i = 0, k = 0; i <= G; i++) for (let j = 0; j <= G; j++, k += 3) { pos[k] = -M + (j / G) * (1 + 2 * M); pos[k + 1] = -M + (i / G) * (1 + 2 * M); pos[k + 2] = 0; }
      const idx = new Uint32Array(G * G * 6);
      for (let i = 0, k = 0; i < G; i++) for (let j = 0; j < G; j++) {
        const a = i * (G + 1) + j, b = a + 1, c = a + G + 1, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      this.#causMat = scope.material(new THREE.ShaderMaterial({
        uniforms: {
          uTile: { value: this.tile.texture }, uLight: { value: new THREE.Vector3(0, -1, 0) }, uHit0: { value: new THREE.Vector2() }, uDepth: { value: 2 },
          uSlope: { value: 1 }, uMask: { value: new THREE.Vector4(1, 0, 0, 0) },
        },
        vertexShader: VS_CAUS, fragmentShader: FS_CAUS, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      }));
      const mesh = new THREE.Mesh(g, this.#causMat);
      mesh.frustumCulled = false;
      this.#causScene.add(mesh);
    }
    scope.defer(() => { this.#tmpScope = null; this.#causTmp = null; });
  }

  #ensureCausTmp(): THREE.WebGLRenderTarget {
    if (this.#causTmp) return this.#causTmp;
    const tmpScope = this.#tmpScope ??= this.#scope.child("caustics-tmp");
    return (this.#causTmp = tmpScope.target(new THREE.WebGLRenderTarget(this.#causRes, this.#causRes, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: false, stencilBuffer: false,
    })));
  }

  /** release temporary HalfFloat caustics accumulator when camera leaves water */
  releaseCausticsScratch() {
    if (this.#tmpScope && !this.#tmpScope.isDisposed) this.#tmpScope.dispose();
    this.#tmpScope = this.#causTmp = null;
  }

  /** render the ripple tile for time t (and the caustics when `caustics`); sunDir = unit vector toward the sun */
  update(renderer: THREE.WebGLRenderer, t: number, sunDir: THREE.Vector3, caustics = true) {
    const prevRT = renderer.getRenderTarget();
    const prevXR = renderer.xr.enabled; renderer.xr.enabled = false;
    this.#tileMat.uniforms.uTime.value = t;
    renderer.setRenderTarget(this.tile);
    renderer.render(this.#tileScene, this.#cam);
    if (caustics) this.renderCaustics(renderer, sunDir);
    renderer.setRenderTarget(prevRT);
    renderer.xr.enabled = prevXR;
  }

  /** caustics from the current tile: 2 focus depths (R, G) into tmp, one tent pass into the mipmapped target */
  renderCaustics(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3) {
    if (!this.#causMat || !this.#blurMat) return;
    const tmp = this.#ensureCausTmp();
    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevClear = renderer.getClearColor(_prevClear), prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(tmp);
    renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false);
    renderer.autoClear = false;
    const u = this.#causMat.uniforms;
    _lightTmp.copy(sunDir).multiplyScalar(-1).normalize();
    (u.uLight.value as THREE.Vector3).copy(_lightTmp);
    u.uSlope.value = this.focusSlope;
    const k0 = 1 - CAUS_ETA * CAUS_ETA * (1 - _lightTmp.y * _lightTmp.y);
    const scale = k0 > 0 ? CAUS_ETA / Math.max(Math.sqrt(k0), 0.2) : 0;
    const hit0 = u.uHit0.value as THREE.Vector2;
    for (let c = 0; c < 2; c++) {
      const depth = this.focus[c];
      u.uDepth.value = depth;
      hit0.set(_lightTmp.x * scale * depth, _lightTmp.z * scale * depth);
      (u.uMask.value as THREE.Vector4).set(c === 0 ? 1 : 0, c === 1 ? 1 : 0, 0, 0);
      renderer.render(this.#causScene, this.#cam);
    }
    this.#blurMat.uniforms.uTex.value = tmp.texture; (this.#blurMat.uniforms.uDir.value as THREE.Vector2).set(1 / this.caustics.width, 0);
    renderer.setRenderTarget(this.caustics); renderer.render(this.#blurScene, this.#cam);
    this.#blurMat.uniforms.uTex.value = null;
    renderer.autoClear = prevAuto;
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setRenderTarget(prevRT);
  }

  /** CPU mirror of the ripple height (for debugging / tests) */
  heightAt(x: number, z: number, t: number): number {
    let h = 0;
    for (const w of this.waves) h += w.amp * Math.sin(w.kx * x + w.kz * z - w.omega * t + w.phase);
    return h;
  }
}
