// Below the surface. While the camera is submerged:
//   • the water surface renders from below (shader.ts WTR_UNDER: Snell's window with the refracted sky + the sun,
//     total internal reflection outside the ~97° cone)
//   • TWO full-screen passes over the finished frame do the water volume along every view ray up to min(scene depth,
//     the surface plane) — the sky and the background are covered too, so nothing leaks at the horizon:
//       1. multiply: per-channel transmission exp(−σ·d) (red dies first → sand turns mint, then teal, then blue)
//       2. add: in-scatter (bright teal toward the surface, deep blue below) × (1 − T), the live caustic network on
//          the seabed (reconstructed from the scene depth copy) and soft light shafts.
// No scene.fog swap (that recompiled every program in the scene on each dive).
import * as THREE from "three";
import type { WorldCtx } from "../../engine/engine";
import type { Scope } from "../../engine/res/scope";
import { DUAL_DST_SENTINEL } from "./dualsrc";
import { CAUS_RANGE, TILE } from "./wavetile";

const _zAxis = new THREE.Vector3(0, 0, 1);

export interface UnderwaterInputs {
  depth: () => THREE.Texture | null;
  caustics: THREE.Texture;
  /** the procedural texture array (layer 2 = the crisp caustic net the surface draws on the floor) */
  net: THREE.Texture;
  sunDir: THREE.Vector3;
  dual?: boolean;
}

export class Underwater {
  active = false;
  #quad: THREE.Mesh;
  #quadMul: THREE.Mesh | null = null;
  #mat: THREE.ShaderMaterial;
  readonly #ctx: WorldCtx;
  readonly #level: number;
  readonly #inp: UnderwaterInputs;

  constructor(ctx: WorldCtx, level: number, inp: UnderwaterInputs, parentScope: Scope) {
    this.#ctx = ctx; this.#level = level; this.#inp = inp;
    const scope = parentScope.child("underwater"), dual = !!inp.dual;
    const g = scope.geometry("geo.world", new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const uniforms = {
      wtrUwTime: { value: 0 }, wtrUwCamY: { value: 0 },
      wtrUwDepthTex: { value: null }, wtrUwCaus: { value: inp.caustics }, wtrUwNet: { value: inp.net }, wtrUwHas: { value: 0 },
      wtrUwProjInv: { value: new THREE.Matrix4() }, wtrUwCamWorld: { value: new THREE.Matrix4() },
      wtrUwSun: { value: new THREE.Vector3(0, 1, 0) }, wtrUwSunIn: { value: new THREE.Vector3(0, -1, 0) },
      wtrUwAxU: { value: new THREE.Vector3(1, 0, 0) }, wtrUwAxV: { value: new THREE.Vector3(0, 0, 1) },
      wtrUwLevel: { value: level }, wtrUwLight: { value: 1 },
      wtrUwDensity: { value: 0.1 },
      wtrUwUp: { value: new THREE.Color(0.030, 0.34, 0.38) }, wtrUwDown: { value: new THREE.Color(0.002, 0.045, 0.085) },
      wtrUwSigma: { value: new THREE.Vector3(2.6, 0.85, 0.62) },   // × density: per-channel extinction
    };
    const shader = (mulOnly: boolean, mergedDual: boolean) => ({
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.9999, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
uniform float wtrUwTime, wtrUwCamY, wtrUwHas, wtrUwLevel, wtrUwLight, wtrUwDensity;
uniform sampler2D wtrUwDepthTex, wtrUwCaus;
uniform highp sampler2DArray wtrUwNet;
uniform mat4 wtrUwProjInv, wtrUwCamWorld;
uniform vec3 wtrUwSun, wtrUwSunIn, wtrUwAxU, wtrUwAxV, wtrUwUp, wtrUwDown, wtrUwSigma;
void main(){
  float d = wtrUwHas > 0.5 ? texture2D(wtrUwDepthTex, vUv).r : 1.0;
  vec4 v = wtrUwProjInv * vec4(vUv * 2.0 - 1.0, min(d, 0.99999) * 2.0 - 1.0, 1.0);
  vec3 pv = v.xyz / v.w;
  vec3 dirW = normalize((wtrUwCamWorld * vec4(pv, 0.0)).xyz);
  float dScene = d >= 0.99999 ? 1e5 : length(pv);
  float dSurf = dirW.y > 1e-4 ? (wtrUwLevel - wtrUwCamY) / dirW.y : 1e5;     // the surface plane (from below)
  float dd = min(dScene, dSurf);
  vec3 T = exp(-dd * wtrUwDensity * wtrUwSigma);
  vec3 pw = (wtrUwCamWorld * vec4(pv, 1.0)).xyz;
  bool hitFloor = dScene < dSurf && dScene < 1e4;
  float belowS = hitFloor ? max(wtrUwLevel - pw.y, 0.0) : 0.0;
  vec3 Tdown = exp(-belowS * wtrUwDensity * wtrUwSigma * 1.1);
  vec3 Tmul = T * mix(vec3(1.0), Tdown, 0.85);
          ${mulOnly ? "gl_FragColor = vec4(Tmul, 1.0); return;" : ""}
float camDepth = max(wtrUwLevel - wtrUwCamY, 0.0), camAtten = exp(-camDepth * 0.05);
// fog colour by direction: bright teal toward the lit surface, deep blue into the abyss; darker when deeper
float up = smoothstep(-0.45, 0.85, dirW.y);
up *= up * (1.5 - 0.5 * up);                     // (the horizontal view reads blue, the lit surface bright teal)
float fSun = max(dot(dirW, wtrUwSun), 0.0);
fSun *= fSun; fSun *= fSun; fSun *= fSun;
vec3 fc = mix(wtrUwDown, wtrUwUp, up) * wtrUwLight * camAtten + wtrUwUp * (wtrUwLight * 0.6 * fSun);
vec3 f3 = 1.0 - T;
vec3 add = vec3(0.0);
vec3 nW = normalize(cross(dFdx(pw), dFdy(pw)));
nW *= sign(nW.y + 1e-4);
          if (hitFloor) {
            float below = wtrUwLevel - pw.y;
            if (below > 0.0) {
              vec2 fxz = pw.xz + wtrUwSun.xz / max(wtrUwSun.y, 0.2) * below * 0.75;  // light enters along the sun
              // the crisp caustic NET the surface view shows on the floor (the same procedural net, drifting + wobbling
              // with the ripple tile), thinner + softer with depth, + the live refracted-grid caustics as a soft glow
              vec4 c = texture2D(wtrUwCaus, fxz / ${TILE.toFixed(3)}) * ${CAUS_RANGE.toFixed(1)};
vec2 wob = (c.rg - 1.0) * 0.04 + vec2(sin(wtrUwTime * 0.7 + fxz.y * 0.9), cos(wtrUwTime * 0.6 + fxz.x * 0.8)) * 0.012;
vec4 nt = texture(wtrUwNet, vec3(fxz / 13.0 + wob + vec2(wtrUwTime * 0.0065, -wtrUwTime * 0.004), 2.0));
float kD = smoothstep(1.0, 5.0, below);
float net = mix(nt.r, nt.g, kD) * (1.0 - smoothstep(12.0, 30.0, dScene));
float glow = max(mix(c.r, c.g, smoothstep(0.8, 4.0, below)) - 0.8, 0.0) * 0.15;
// only on the faces the sun reaches from above, brightest in the shallows, fading with depth + distance
float faceUp = smoothstep(0.45, 0.85, nW.y) * max(dot(nW, wtrUwSun), 0.0);
add = vec3(0.55, 1.0, 0.92) * (net * 0.55 + glow) * faceUp * wtrUwLight * exp(-below * 0.08 - dScene * 0.04);
            }
          }
// light shafts through Snell's window (basis precomputed on CPU)
float rays = 0.0;
vec3 camW = wtrUwCamWorld[3].xyz;
for (int i = 0; i < 4; i++) {
  float di = 1.5 + float(i) * 3.2;
  if (di > dd) break;
  vec3 q = camW + dirW * di;
  vec2 pl = vec2(dot(q, wtrUwAxU), dot(q, wtrUwAxV));
  float sh = sin(pl.x * 0.9 + sin(pl.y * 0.35 + wtrUwTime * 0.4) * 1.3 + wtrUwTime * 0.25) * 0.5 + 0.5;
  sh *= sin(pl.y * 0.63 - pl.x * 0.21 + wtrUwTime * 0.17) * 0.5 + 0.5;
  float sh2 = sh * sh;
  rays += (sh2 * sh2 * sh2) * exp(-max(wtrUwLevel - q.y, 0.0) * 0.12) * clamp((dd - di) / 3.0, 0.0, 1.0);
}
float ds = max(dot(dirW, -wtrUwSunIn), 0.0);
rays *= (0.18 + 1.1 * (ds * ds * ds)) * wtrUwLight * camAtten;
float snow = 0.0;
if (dd >= 0.9) {
  for (int i = 0; i < 4; i++) {
    float di = 0.9 + float(i) * 1.6;
    if (di > dd) break;
    vec3 q = camW + dirW * di + vec3(wtrUwTime * 0.05, sin(wtrUwTime * 0.3 + float(i)) * 0.08, wtrUwTime * 0.03);
    vec3 cid = floor(q * 1.6), fq = fract(q * 1.6);
    vec3 hp = fract(sin(vec3(dot(cid, vec3(127.1, 311.7, 74.7)), dot(cid, vec3(269.5, 183.3, 246.1)), dot(cid, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
    float dp = length((fq - hp) - dirW * dot(fq - hp, dirW));
    snow += smoothstep(0.018 / (1.0 + float(i) * 0.45), 0.0, dp) * step(0.45, hp.x) / (1.0 + float(i) * 0.35);
  }
}
vec3 snowCol = vec3(0.375, 0.475, 0.45) * snow * wtrUwLight;
gl_FragColor = vec4(fc * f3 + add * T + mix(wtrUwUp, vec3(0.5, 0.9, 0.85), 0.35) * rays * 1.8 + snowCol, 1.0);
          ${mergedDual ? "wtrSrc1 = vec4(Tmul, 1.0);" : ""}
        }`,
    });
    const common = { transparent: true, depthTest: false, depthWrite: false, fog: false, uniforms, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation };
    const mk = (mat: THREE.ShaderMaterial, order: number, name: string) => {
      const m = new THREE.Mesh(g, scope.material(mat));
      m.frustumCulled = false; m.renderOrder = order; m.visible = false; m.name = name;
      ctx.scene.add(m);
      return m;
    };
    if (!dual) {
      this.#quadMul = mk(new THREE.ShaderMaterial({ ...common, ...shader(true, false), blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor }), 9998, "water-underwater-absorb");
    }
    this.#quad = mk(new THREE.ShaderMaterial({
      ...common, ...shader(false, dual),
      ...(dual ? { defines: { WTR_DUAL_SRC: 1 }, blendSrc: THREE.OneFactor, blendDst: DUAL_DST_SENTINEL as unknown as THREE.BlendingDstFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor }
        : { blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor }),
    }), 9999, "water-underwater-volume");
    this.#mat = this.#quad.material as THREE.ShaderMaterial;
  }

  update(t: number, surfaceAt?: (x: number, z: number) => number) {
    const cam = this.#ctx.camera;
    const p = cam.position;
    const surf = surfaceAt ? surfaceAt(p.x, p.z) : this.#level;
    const submerged = p.y < surf - 0.02 && this.#ctx.terrain.height(p.x, p.z) < p.y;
    if (submerged !== this.active) {
      this.active = submerged;
      this.#quad.visible = submerged;
      if (this.#quadMul) this.#quadMul.visible = submerged;
    }
    if (this.active) {
      const u = this.#mat.uniforms;
      u.wtrUwTime.value = t; u.wtrUwCamY.value = p.y; u.wtrUwLevel.value = this.#level;
      const d = this.#inp.depth();
      u.wtrUwDepthTex.value = d; u.wtrUwHas.value = d ? 1 : 0;
      (u.wtrUwProjInv.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
      (u.wtrUwCamWorld.value as THREE.Matrix4).copy(cam.matrixWorld);
      const sd = this.#inp.sunDir;
      (u.wtrUwSun.value as THREE.Vector3).copy(sd);
      // Match GLSL refract(-sunDir, vec3(0, -1, 0), 0.75) for underwater shaft orientation
      const k = 1 - 0.75 * 0.75 * (1 - sd.y * sd.y);
      const sunIn = (u.wtrUwSunIn.value as THREE.Vector3).set(-0.75 * sd.x, k > 0 ? Math.sqrt(k) : 1, -0.75 * sd.z).normalize();
      const axU = (u.wtrUwAxU.value as THREE.Vector3).crossVectors(sunIn, _zAxis).normalize();
      (u.wtrUwAxV.value as THREE.Vector3).crossVectors(sunIn, axU).normalize();
      const sun = this.#ctx.shared.get("sun") as THREE.DirectionalLight | undefined;
      u.wtrUwLight.value = sun ? Math.max(0.2, sun.intensity * Math.max(sd.y, 0.15)) : 2.5;
    }
  }
}
