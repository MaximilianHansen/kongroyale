// Interactive water: a GPU wave-equation simulation in a 48 m window that follows the camera (256², 19 cm cells).
// Anything can disturb it through the WaterApi — a kong wading (continuous wake → a real V-shaped Kelvin-ish wake at
// speed), a bullet or rocket hitting the water (a ring that spreads and fades), a body landing from the glider. The
// water shader adds its slopes to the surface normal, its height to the displacement near the camera and its foam
// channel to the foam. Cost: 1–2 full-screen passes on a 256² target per frame (≈ 0.02 ms).
//   RT texel = (h now, h previous, foam, 0)
import * as THREE from "three";
import type { Scope } from "../../engine/res/scope";

export const SIM_SIZE = 48;       // metres covered
const N = 256;                    // cells per side
const DX = SIM_SIZE / N;          // metres per cell
const MAX_DROPS = 24;
const STEP = 1 / 60;

const VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FS = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
uniform vec2 uShift;              // window move since the previous step, in uv
uniform vec4 uDrops[${MAX_DROPS}]; // uv x, uv y, radius (uv), strength (m, + = push down / splash crater)
uniform float uDropFoam[${MAX_DROPS}];
uniform int uN;
uniform float uC2;
uniform float uDamp;
uniform float uFoamDecay;
varying vec2 vUv;
vec4 at(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture2D(uPrev, uv); }
void main() {
  vec2 uv = vUv + uShift;
  float t = ${(1 / N).toFixed(6)};
  vec4 c = at(uv);
  float lap = at(uv + vec2(t, 0.0)).r + at(uv - vec2(t, 0.0)).r + at(uv + vec2(0.0, t)).r + at(uv - vec2(0.0, t)).r - 4.0 * c.r;
  float hn = (2.0 * c.r - c.g + uC2 * lap) * uDamp;
  float foam = c.b * uFoamDecay;
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= uN) break;
    vec4 d = uDrops[i];
    float q = distance(vUv, d.xy) / max(d.z, 1e-4);
    float g = exp(-q * q * 2.0);
    hn -= d.w * g;
    foam += uDropFoam[i] * g;
  }
  // absorb at the window border so rings never bounce back
  vec2 e = min(vUv, 1.0 - vUv);
  float border = smoothstep(0.0, 0.08, min(e.x, e.y));
  gl_FragColor = vec4(hn * border, c.r * border, clamp(foam, 0.0, 1.5), 0.0);
}`;

interface Drop { x: number; z: number; r: number; s: number; foam: number }

export class InteractiveRipples {
  /** current state texture (h, h_prev, foam) — sample with origin/scale below */
  get texture(): THREE.Texture { return this.#rts[this.#cur].texture; }
  /** world xz of the window's min corner */
  readonly origin = new THREE.Vector2();
  readonly size = SIM_SIZE;
  readonly cells = N;
  /** wave speed (m/s) and damping per second */
  speed = 1.35;
  damping = 0.9;
  #rts: THREE.WebGLRenderTarget[];
  #cur = 0;
  #mat: THREE.ShaderMaterial;
  #scene = new THREE.Scene();
  #cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  #drops: Drop[] = [];
  #acc = 0;
  #started = false;
  active = 1e9; // frames since the last disturbance (the sim sleeps — and the shader skips it — when nothing moves)

  constructor(parentScope: Scope) {
    const ripScope = parentScope.child("ripples");
    const opts: THREE.RenderTargetOptions = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    this.#rts = [ripScope.target(new THREE.WebGLRenderTarget(N, N, opts)), ripScope.target(new THREE.WebGLRenderTarget(N, N, opts))];
    this.#rts.forEach((r, i) => (r.texture.name = `water-interact-${i}`));
    this.#mat = ripScope.material(new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null }, uShift: { value: new THREE.Vector2() },
        uDrops: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) },
        uDropFoam: { value: new Array(MAX_DROPS).fill(0) },
        uN: { value: 0 }, uC2: { value: 0 }, uDamp: { value: 1 }, uFoamDecay: { value: 0.99 },
      },
      vertexShader: VS, fragmentShader: FS, depthTest: false, depthWrite: false,
    }));
    const q = new THREE.Mesh(ripScope.geometry("geo.world", new THREE.PlaneGeometry(2, 2)), this.#mat);
    q.frustumCulled = false;
    this.#scene.add(q);
  }

  /** push the surface at (x, z): radius r (m), strength s (m, ~0.02 wading … 0.3 rocket), foam 0..1 */
  disturb(x: number, z: number, r: number, s: number, foam = 0.4) {
    if (this.#drops.length >= 64) this.#drops.shift();
    this.#drops.push({ x, z, r: Math.max(r, DX * 1.5), s, foam });
    this.active = 0;
  }

  update(renderer: THREE.WebGLRenderer, dt: number, camX: number, camZ: number) {
    // window follows the camera in whole cells
    const ox = Math.round((camX - SIM_SIZE / 2) / DX) * DX, oz = Math.round((camZ - SIM_SIZE / 2) / DX) * DX;
    if (!this.#started) { this.origin.set(ox, oz); this.#started = true; }
    if (this.active > 600 && !this.#drops.length) { this.origin.set(ox, oz); return; } // asleep (10 s of calm)
    this.#acc = Math.min(this.#acc + dt, STEP * 3);
    if (this.#acc < STEP && !this.#drops.length) return;
    const prevRT = renderer.getRenderTarget(), prevXR = renderer.xr.enabled; renderer.xr.enabled = false;
    const u = this.#mat.uniforms;
    const c = (this.speed * STEP) / DX;
    u.uC2.value = Math.min(0.45, c * c);
    u.uDamp.value = Math.exp(-this.damping * STEP * 0.5);
    u.uFoamDecay.value = Math.exp(-STEP / 1.6);
    let steps = 0;
    while (this.#acc >= STEP || (steps === 0 && this.#drops.length)) {
      this.#acc = Math.max(0, this.#acc - STEP);
      (u.uShift.value as THREE.Vector2).set((ox - this.origin.x) / SIM_SIZE, (oz - this.origin.y) / SIM_SIZE);
      this.origin.set(ox, oz);
      const n = Math.min(this.#drops.length, MAX_DROPS);
      const dv = u.uDrops.value as THREE.Vector4[], df = u.uDropFoam.value as number[];
      for (let i = 0; i < n; i++) {
        const d = this.#drops[i];
        dv[i].set((d.x - ox) / SIM_SIZE, (d.z - oz) / SIM_SIZE, d.r / SIM_SIZE, d.s * 0.35);
        df[i] = d.foam;
      }
      u.uN.value = n;
      this.#drops.splice(0, n);
      u.uPrev.value = this.#rts[this.#cur].texture;
      this.#cur ^= 1;
      renderer.setRenderTarget(this.#rts[this.#cur]);
      renderer.render(this.#scene, this.#cam);
      if (++steps >= 3) break;
    }
    renderer.setRenderTarget(prevRT); renderer.xr.enabled = prevXR;
    this.active++;
  }
}
