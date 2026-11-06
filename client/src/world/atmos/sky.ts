// Sky dome: analytic stylized gradient (deep saturated blue → pale horizon band) + sun disc + wide halo + faint rays
// (glsl.ts atmosSky) and a high, wind-stretched CIRRUS / altostratus layer (plane-projected tiling noise) — a whisper at
// midday, the pink streaks that fill the dawn sky. One inverted sphere that follows the camera, drawn after the opaques
// (early-z rejects everything the world covers).
import * as THREE from "three";
import { ATMOS_PARS, type AtmosUniforms } from "./glsl";
import { onRestore } from "../../engine/res/restore";

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // pin to the far plane so the dome never clips against world geometry
  gl_Position.z = gl_Position.w * 0.99999;
}`;

const FRAG = /* glsl */ `
precision highp float;
${ATMOS_PARS}
uniform float uDiscCos;
uniform float uDiscOn;
uniform sampler2D uNoise;
uniform float uCirrus, uCirrusOpacity;
uniform vec3 uCirrusLit, uCirrusShade;
uniform vec2 uCirrusDrift;
// night: x = star strength, y = moon on, z = moon angular radius (rad), w = moon radiance
uniform vec4 uNight;
uniform vec3 uMoonTint;
varying vec3 vDir;
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
// crisp star field: one candidate star per cell of a 300-per-radian grid on the direction cube (~1.2 px stars at 1440p)
vec3 stars(vec3 d) {
  vec3 q = d * 300.0;
  vec3 cell = floor(q);
  float h = hash13(cell);
  if (h < 0.984) return vec3(0.0);
  vec3 sp = cell + 0.5 + (vec3(hash13(cell + 17.1), hash13(cell + 31.7), hash13(cell + 53.3)) - 0.5) * 0.6;
  float r = length(q - sp);
  float b = pow((h - 0.984) / 0.016, 2.5);
  float core = exp(-r * r * 7.0) * (0.3 + 3.2 * b);
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.92, 0.8), hash13(cell + 7.7));
  // denser / brighter toward the zenith (the horizon glow washes the faint ones)
  return tint * core * smoothstep(0.03, 0.35, d.y) * (0.55 + 0.45 * smoothstep(0.2, 0.8, d.y));
}
// value noise on the moon's tangent plane
float mhash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float mnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mhash(i), mhash(i + vec2(1, 0)), f.x), mix(mhash(i + vec2(0, 1)), mhash(i + vec2(1, 1)), f.x), f.y); }
// a big stylised full moon: maria (dark smooth seas), crater rings, limb darkening, a crisp anti-aliased edge
vec4 moon(vec3 d) {
  vec3 m = uAtmSunDir;
  float cr = dot(d, m);
  float R = uNight.z;
  float ang = acos(clamp(cr, -1.0, 1.0));
  if (ang > R * 1.02) return vec4(0.0);
  vec3 T = normalize(cross(m, vec3(0.0, 1.0, 0.0001))), B = cross(T, m);
  vec2 uv = vec2(dot(d, T), dot(d, B)) / sin(R); // −1..1 across the disc
  float r2 = dot(uv, uv);
  float edge = 1.0 - smoothstep(1.0 - fwidth(r2) * 1.5, 1.0, r2);
  float mu = sqrt(max(1.0 - r2, 0.0));
  // maria: low-frequency blotches; craters: rings from a cellular pattern; fine grain
  float n = mnoise(uv * 2.2 + 3.1) * 0.6 + mnoise(uv * 4.7 + 1.7) * 0.4;
  float maria = smoothstep(0.52, 0.68, n);
  vec2 g = uv * 7.0; vec2 gi = floor(g), gf = fract(g) - 0.5;
  float c = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(x, y), h = vec2(mhash(gi + o), mhash(gi + o + 9.3));
    vec2 dd = o + (h - 0.5) * 0.8 - gf;
    float rr = length(dd), rad = 0.12 + 0.22 * h.x;
    if (h.y > 0.45) c += smoothstep(rad * 1.15, rad, rr) * (0.55 + 0.45 * smoothstep(rad * 0.6, rad, rr));
  }
  float grain = mnoise(uv * 24.0) * 0.5 + mnoise(uv * 51.0) * 0.5;
  float alb = 0.93 - 0.3 * maria - 0.1 * clamp(c, 0.0, 1.0) + 0.08 * (grain - 0.5);
  float limb = 0.72 + 0.28 * pow(mu, 0.5);
  return vec4(uMoonTint * alb * limb * uNight.w, edge);
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

vec3 cirrus(vec3 d, vec3 col) {
  if (uCirrus <= 0.0 || d.y < 0.005) return col;
  // project onto a high plane; soften the projection toward the horizon so streaks never alias into lines
  vec2 uv = d.xz / (d.y + 0.12) * 0.22 + uCirrusDrift;
  // wind-stretched low-frequency fbm with a WIDE threshold: soft brush-stroke streaks (thin thresholds on busy
  // noise read as hair / marble contours — keep it broad)
  vec2 q = uv * vec2(0.3, 1.25);
  float n = 0.0, a = 0.5, wsum = 0.0;
  for (int i = 0; i < 3; i++) { n += a * texture2D(uNoise, q).r; wsum += a; q = q * vec2(2.0, 1.7) + vec2(0.173, 0.311); a *= 0.45; }
  n /= wsum;
  float cov = smoothstep(1.0 - uCirrus - 0.1, 1.0 - uCirrus + 0.35, n);
  cov *= smoothstep(0.005, 0.12, d.y);
  // lit by the sun: bright forward scatter toward the sun, thicker parts shade toward the base colour
  float mu = max(dot(d, uAtmSunDir), 0.0);
  vec3 lit = uCirrusLit * uAtmSunColor * (0.75 + 1.2 * pow(mu, 6.0));
  vec3 c = mix(lit, uCirrusShade, smoothstep(0.35, 0.95, cov) * 0.45);
  return mix(col, c, cov * uCirrusOpacity);
}

#ifdef SKY_BAKED
// the sky radiance (gradient + halo + shafts + ground) is BAKED per preset into an equirect table — the dome costs
// one fetch per pixel instead of ~15 transcendentals (it covers ~45 % of a beach frame, plus the water under it)
uniform sampler2D uSkyBake;
vec3 skyBaked(vec3 d) {
  float az = atan(d.x, -d.z), el = asin(clamp(d.y, -1.0, 1.0));
  return texture2D(uSkyBake, vec2(az * 0.15915494 + 0.5, (el + SKY_EL0) / (1.5707963 + SKY_EL0))).rgb;
}
#endif
void main() {
  vec3 d = normalize(vDir);
#ifdef SKY_BAKED
  vec3 col = skyBaked(d);
#else
  vec3 col = atmosSky(d);
#endif
  col = cirrus(d, col);
  float mu = dot(d, uAtmSunDir);
  // sun disc: bright core (blooms) with a soft limb
  float disc = smoothstep(uDiscCos - 0.0006, uDiscCos + 0.0003, mu);
  col += uAtmSunColor * disc * 14.0 * uDiscOn;
  if (uNight.x > 0.0) col += stars(d) * uNight.x;
  if (uNight.y > 0.5) { vec4 mo = moon(d); col = mix(col, mo.rgb, mo.a); }
  // dither against banding in the smooth gradient
  col += (hash12(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** equirect bake of atmosSky: u = azimuth (atan(x, −z)), v = elevation from −SKY_EL0 to 90° */
const SKY_EL0 = 0.25;
const BAKE_FRAG = /* glsl */ `
precision highp float;
${ATMOS_PARS}
uniform vec2 uSize;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float az = (uv.x - 0.5) * 6.2831853, el = uv.y * (1.5707963 + ${SKY_EL0.toFixed(3)}) - ${SKY_EL0.toFixed(3)};
  vec3 d = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
  gl_FragColor = vec4(atmosSky(d), 1.0);
}`;

/** tiling smooth value noise (R8, 256², repeat) — the cirrus layer's source */
function makeNoise(size = 256, cells = 32, seed = 7): THREE.DataTexture {
  let a = seed;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const lat = new Float32Array(cells * cells).map(() => rnd());
  const L = (x: number, y: number) => lat[((y % cells) + cells) % cells * cells + (((x % cells) + cells) % cells)];
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x / size) * cells, fy = (y / size) * cells;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const v = (L(ix, iy) * (1 - tx) + L(ix + 1, iy) * tx) * (1 - ty) + (L(ix, iy + 1) * (1 - tx) + L(ix + 1, iy + 1) * tx) * ty;
    data[y * size + x] = Math.round(v * 255);
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
let sharedNoise: THREE.DataTexture | null = null;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor(u: AtmosUniforms, radius = 8000) {
    sharedNoise ??= makeNoise();
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...u, uDiscCos: { value: Math.cos(THREE.MathUtils.degToRad(0.45)) }, uDiscOn: { value: 1 },
        uNoise: { value: sharedNoise }, uCirrus: { value: 0 }, uCirrusOpacity: { value: 0 },
        uCirrusLit: { value: new THREE.Color(1, 1, 1) }, uCirrusShade: { value: new THREE.Color(0.7, 0.75, 0.85) },
        uCirrusDrift: { value: new THREE.Vector2() },
        uNight: { value: new THREE.Vector4(0, 0, 0.06, 1) }, uMoonTint: { value: new THREE.Color(1, 1, 1) },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: true,
    });
    const geo = new THREE.SphereGeometry(radius, 64, 40);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = "atmos-sky";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 900; // after opaque world, before transparents (water/clouds)
    this.mesh.matrixAutoUpdate = true;
  }

  private bakeRT: THREE.WebGLRenderTarget | null = null;
  private bakeMat: THREE.ShaderMaterial | null = null;
  /** bake the sky radiance for the current preset (the dome then samples it); call after the atmos uniforms changed */
  bake(renderer: THREE.WebGLRenderer, u: AtmosUniforms, w = 2048, h = 1024) {
    if (!this.bakeRT) {
      this.bakeRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
      const t = this.bakeRT.texture;
      t.colorSpace = THREE.NoColorSpace; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
      this.bakeMat = new THREE.ShaderMaterial({
        vertexShader: "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }", fragmentShader: BAKE_FRAG,
        uniforms: { ...u, uSize: { value: new THREE.Vector2(w, h) } }, depthTest: false, depthWrite: false, toneMapped: false,
      });
      const m = this.material;
      m.defines = { ...(m.defines ?? {}), SKY_BAKED: 1, SKY_EL0: SKY_EL0.toFixed(3) };
      m.uniforms.uSkyBake = { value: t };
      m.needsUpdate = true;
      onRestore("bake", () => this.bake(renderer, u, w, h));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const quad = new THREE.Mesh(g, this.bakeMat!);
    quad.frustumCulled = false;
    const prev = renderer.getRenderTarget(), prevTM = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(this.bakeRT);
    renderer.render(quad, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    renderer.setRenderTarget(prev); renderer.toneMapping = prevTM;
    g.dispose();
  }

  setDisc(deg: number, on: boolean) {
    this.material.uniforms.uDiscCos.value = Math.cos(THREE.MathUtils.degToRad(deg * 0.5));
    this.material.uniforms.uDiscOn.value = on ? 1 : 0;
  }

  /** night sky: star strength, moon (drawn at the light's direction — the moon IS the key at night), radius (deg), radiance */
  setNight(stars: number, moonDeg: number, moonI: number, tint: THREE.Color) {
    const u = this.material.uniforms;
    (u.uNight.value as THREE.Vector4).set(stars, moonDeg > 0 ? 1 : 0, THREE.MathUtils.degToRad(moonDeg), moonI);
    (u.uMoonTint.value as THREE.Color).copy(tint);
  }

  setCirrus(cover: number, opacity: number, lit: THREE.Color, shade: THREE.Color) {
    const u = this.material.uniforms;
    u.uCirrus.value = cover; u.uCirrusOpacity.value = opacity;
    (u.uCirrusLit.value as THREE.Color).copy(lit); (u.uCirrusShade.value as THREE.Color).copy(shade);
  }

  /** keep centred on the camera; t drifts the cirrus with the wind */
  update(cam: THREE.Camera, t = 0) {
    this.mesh.position.copy(cam.position);
    (this.material.uniforms.uCirrusDrift.value as THREE.Vector2).set(t * 0.0006, t * 0.0002);
  }
}

/** 128×1 half-float RGBA table (the sky gradient over u = sqrt(elevation / 90°)) */
export function makeLUT(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint16Array(128 * 4), 128, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
export function toHalf(f: Float32Array): Uint16Array {
  const o = new Uint16Array(f.length);
  for (let i = 0; i < f.length; i++) o[i] = THREE.DataUtils.toHalfFloat(Math.min(f[i], 65000));
  return o;
}

/**
 * Horizon skirt (so from altitude the sea / sky horizon is not a razor-hard line): an open cylinder a few km
 * out around the camera, drawn after the water and before the clouds, depth-tested (everything nearer — the island,
 * POIs, the near sea — is untouched). It fades whatever lies beyond it (the far sea) into the horizon sky over the last
 * ~2.5° below the horizon, so the sea meets the sky through a pale haze band like the target art. At eye level it is a
 * hair-thin band on the horizon line; from the plane / the drop it is the soft horizon of the aerial target art.
 */
const SKIRT_FRAG = /* glsl */ `
precision highp float;
${ATMOS_PARS}
uniform float uSkirtDeg, uSkirtMax;
varying vec3 vW;
void main() {
  vec3 d = normalize(vW - uAtmCamPos);
  float el = asin(clamp(d.y, -1.0, 1.0)) * 57.29578;
  // the geometric horizon dips below eye level with altitude (≈ 0.0321 · √h degrees)
  float dip = 0.0321 * sqrt(max(uAtmCamPos.y, 0.0));
  float a = smoothstep(-dip - uSkirtDeg, -dip + 0.05, el) * uSkirtMax;
  if (a < 0.003) discard;
  vec3 c = atmosHorizonSky(d);
  gl_FragColor = vec4(c * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
export class HorizonSkirt {
  readonly mesh: THREE.Mesh;
  constructor(u: AtmosUniforms, readonly radius = 5200) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true).translate(0, 0.5, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: "varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
      fragmentShader: SKIRT_FRAG,
      uniforms: { ...u, uSkirtDeg: { value: 2.5 }, uSkirtMax: { value: 0.85 } },
      side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true, fog: false, toneMapped: true,
      premultipliedAlpha: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "atmos-horizon-skirt";
    this.mesh.frustumCulled = false;
    // after the water (renderOrder 0, drawn in the transparent pass), before the clouds (0.5)
    this.mesh.renderOrder = 0.25;
    this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    this.mesh.userData.castShadow = false; this.mesh.userData.receiveShadow = false;
  }
  update(cam: THREE.Camera) {
    const h = Math.max(cam.position.y, 1);
    this.mesh.position.set(cam.position.x, -40, cam.position.z);
    this.mesh.scale.set(this.radius, h + 40 + this.radius * 0.01, this.radius);
    this.mesh.updateMatrixWorld();
  }
}
