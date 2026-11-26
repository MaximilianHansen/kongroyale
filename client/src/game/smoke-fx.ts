// Volumetric-look 3D billowing smoke clouds for the SMOKE BANANA (shared/sim/const.ts SMOKE).
// One instanced billboard draw call for all active clouds (up to 8 clouds × 32 puffs = 256 puffs),
// with session-cached procedural cloud texture, zero-allocation cloud/puff pools, smooth expansion / swirl / fade,
// and an inside-smoke full-screen mist overlay when the camera steps into the cloud.
import * as THREE from "three";
import { SMOKE } from "../../../shared/sim/const";
import { resources, type Scope } from "../engine/res/scope";

const MAX_CLOUDS = 8;
const PUFFS_PER_CLOUD = 32;
const MAX_PUFFS = MAX_CLOUDS * PUFFS_PER_CLOUD;

interface PuffDef {
  ox: number; oy: number; oz: number;
  r: number; rot0: number; spin: number;
  op: number; shade: number; phase: number;
}

interface Cloud {
  active: boolean;
  id: number;
  x: number; y: number; z: number;
  age: number; dur: number;
  puffs: PuffDef[];
}

const VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aParams;
varying vec2 vUv;
varying float vAlpha;
varying float vShade;
void main() {
  vUv = uv;
  vAlpha = aParams.z;
  vShade = aParams.w;
  float r = aParams.x;
  float c = cos(aParams.y), s = sin(aParams.y);
  vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * r;
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  mv.xy += p;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
varying float vShade;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vAlpha;
  if (a < 0.015) discard;
  float lit = clamp(tex.r * 0.55 + vUv.y * 0.35 + vShade * 0.35, 0.0, 1.0);
  vec3 shadowCol = vec3(0.46, 0.54, 0.60);
  vec3 midCol    = vec3(0.76, 0.82, 0.86);
  vec3 hiCol     = vec3(0.95, 0.97, 0.99);
  vec3 col = lit < 0.5 ? mix(shadowCol, midCol, lit * 2.0) : mix(midCol, hiCol, (lit - 0.5) * 2.0);
  gl_FragColor = vec4(col, a);
}`;

let cachedPuffTex: THREE.CanvasTexture | null = null;
/** session-cached 256×256 procedural cloud texture (painted & uploaded once, shared across prewarm and matches) */
function sharedPuffTexture(): THREE.CanvasTexture {
  if (cachedPuffTex) return cachedPuffTex;
  const S = 256;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, S, S);
  const lobes: Array<[number, number, number, number, number]> = [
    [128, 132, 92, 0.92, 0.72],
    [94, 110, 68, 0.88, 0.92],
    [164, 114, 64, 0.85, 0.88],
    [126, 86, 62, 0.86, 0.98],
    [82, 152, 56, 0.80, 0.52],
    [168, 156, 54, 0.78, 0.50],
    [128, 166, 58, 0.76, 0.44],
    [108, 128, 56, 0.82, 0.82],
    [148, 134, 52, 0.80, 0.76],
  ];
  for (const [x, y, r, a, lum] of lobes) {
    const gr = g.createRadialGradient(x - r * 0.14, y - r * 0.18, r * 0.08, x, y, r);
    const v = Math.round(135 + lum * 120);
    gr.addColorStop(0, `rgba(${v},${v},${v},${a})`);
    gr.addColorStop(0.55, `rgba(${Math.round(v * 0.92)},${Math.round(v * 0.92)},${Math.round(v * 0.92)},${a * 0.72})`);
    gr.addColorStop(1, `rgba(${Math.round(v * 0.8)},${Math.round(v * 0.8)},${Math.round(v * 0.8)},0)`);
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = resources.root.texture("tex.actor", new THREE.CanvasTexture(c));
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  cachedPuffTex = t;
  return t;
}

function makeSmokeMaterial(): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uMap: { value: sharedPuffTexture() } },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  mat.name = "smoke-cloud";
  return mat;
}

function makeSmokeGeometry(maxPuffs: number): { geo: THREE.InstancedBufferGeometry; centers: THREE.InstancedBufferAttribute; params: THREE.InstancedBufferAttribute } {
  const base = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.uv = base.attributes.uv;
  base.dispose();
  const cArr = new Float32Array(maxPuffs * 3);
  const pArr = new Float32Array(maxPuffs * 4);
  const centers = new THREE.InstancedBufferAttribute(cArr, 3);
  const params = new THREE.InstancedBufferAttribute(pArr, 4);
  centers.setUsage(THREE.DynamicDrawUsage);
  params.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aCenter", centers);
  geo.setAttribute("aParams", params);
  return { geo, centers, params };
}

/** session prewarm prefab (game/render.ts renderPrefabs): compiles the custom GLSL shader & uploads the puff texture before combat */
export function smokePrefabs(): THREE.Object3D[] {
  const { geo, params } = makeSmokeGeometry(1);
  (params.array as Float32Array).set([1, 0, 0.5, 0.5]);
  const mesh = new THREE.InstancedMesh(geo, makeSmokeMaterial(), 1);
  mesh.count = 1;
  mesh.frustumCulled = false;
  return [mesh];
}

function fillPuffs(out: PuffDef[], seed: number) {
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x85ebca6b) + 0x9e3779b9) >>> 0; return s / 4294967296; };
  const R = SMOKE.radius, H = SMOKE.height;
  let k = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rnd() * 0.5, d = (0.12 + rnd() * 0.34) * R, pf = out[k++];
    pf.ox = Math.cos(a) * d; pf.oy = 0.95 + rnd() * (H * 0.48); pf.oz = Math.sin(a) * d;
    pf.r = 3.6 + rnd() * 1.1; pf.rot0 = rnd() * Math.PI * 2; pf.spin = (rnd() - 0.5) * 0.36;
    pf.op = 0.94; pf.shade = 0.45 + rnd() * 0.25; pf.phase = rnd() * 6.28;
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rnd() * 0.35, d = (0.42 + rnd() * 0.44) * R, ringH = (i & 1) ? 0.75 + rnd() * 1.3 : 1.7 + rnd() * 1.6, pf = out[k++];
    pf.ox = Math.cos(a) * d; pf.oy = ringH; pf.oz = Math.sin(a) * d;
    pf.r = 3.1 + rnd() * 1.15; pf.rot0 = rnd() * Math.PI * 2; pf.spin = (rnd() - 0.5) * 0.44;
    pf.op = 0.84; pf.shade = 0.35 + (ringH / H) * 0.55; pf.phase = rnd() * 6.28;
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rnd() * 0.6, d = (0.14 + rnd() * 0.48) * R, pf = out[k++];
    pf.ox = Math.cos(a) * d; pf.oy = H * 0.68 + rnd() * (H * 0.36); pf.oz = Math.sin(a) * d;
    pf.r = 2.7 + rnd() * 1.0; pf.rot0 = rnd() * Math.PI * 2; pf.spin = (rnd() - 0.5) * 0.5;
    pf.op = 0.68; pf.shade = 0.75 + rnd() * 0.25; pf.phase = rnd() * 6.28;
  }
}

export class SmokeFx {
  private readonly pool: Cloud[];
  private readonly mesh: THREE.InstancedMesh;
  private readonly centers: THREE.InstancedBufferAttribute;
  private readonly params: THREE.InstancedBufferAttribute;
  private readonly hazeEl: HTMLDivElement | null = null;
  private hazeAlpha = 0;
  private lastHazeStr = "0";
  private activeCount = 0;

  constructor(scene: THREE.Scene, res: Scope) {
    this.pool = Array.from({ length: MAX_CLOUDS }, () => ({
      active: false, id: -1, x: 0, y: 0, z: 0, age: 0, dur: SMOKE.durationS,
      puffs: Array.from({ length: PUFFS_PER_CLOUD }, () => ({ ox: 0, oy: 0, oz: 0, r: 0, rot0: 0, spin: 0, op: 0, shade: 0, phase: 0 })),
    }));

    const { geo, centers, params } = makeSmokeGeometry(MAX_PUFFS);
    this.centers = centers;
    this.params = params;
    res.geometry("geo.actor", geo);

    const mat = res.material(makeSmokeMaterial());
    this.mesh = res.own("geo.actor", new THREE.InstancedMesh(geo, mat, MAX_PUFFS), () => (centers.array as Float32Array).byteLength + (params.array as Float32Array).byteLength);
    this.mesh.name = "smoke-clouds";
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.renderOrder = 7;
    this.mesh.userData.gameRoot = true;
    scene.add(this.mesh);

    if (typeof document !== "undefined") {
      const div = document.createElement("div");
      div.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:6;opacity:0;background:radial-gradient(ellipse 80% 80% at 50% 50%, rgba(206,220,230,0.86) 0%, rgba(154,174,188,0.92) 68%, rgba(114,134,148,0.96) 100%);will-change:opacity;";
      document.body.appendChild(div);
      this.hazeEl = div;
    }

    res.defer(() => {
      this.clear();
      this.mesh.removeFromParent();
      this.hazeEl?.remove();
    });
  }

  spawn(id: number, x: number, y: number, z: number, dur: number = SMOKE.durationS) {
    let slot: Cloud | null = null;
    for (let i = 0; i < MAX_CLOUDS; i++) {
      const c = this.pool[i];
      if (c.active && c.id === id) { c.x = x; c.y = y; c.z = z; c.age = Math.max(0, SMOKE.durationS - dur); c.dur = SMOKE.durationS; return; }
      if (!c.active && !slot) slot = c;
    }
    if (!slot) {
      slot = this.pool[0];
      for (let i = 1; i < MAX_CLOUDS; i++) if (this.pool[i].age > slot.age) slot = this.pool[i];
    } else this.activeCount++;
    slot.active = true; slot.id = id; slot.x = x; slot.y = y; slot.z = z;
    slot.age = Math.max(0, SMOKE.durationS - dur); slot.dur = SMOKE.durationS;
    fillPuffs(slot.puffs, id * 977 + Math.round(x * 13) + Math.round(z * 29));
  }

  clear() {
    for (let i = 0; i < MAX_CLOUDS; i++) this.pool[i].active = false;
    this.activeCount = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
    if (this.hazeEl && this.lastHazeStr !== "0") { this.hazeAlpha = 0; this.lastHazeStr = "0"; this.hazeEl.style.opacity = "0"; }
  }

  update(dt: number, camPos: THREE.Vector3) {
    if (this.activeCount === 0 && this.hazeAlpha === 0) return;
    const h = Math.min(dt, 0.05);
    let insideMax = 0;
    let outIdx = 0;
    const cArr = this.centers.array as Float32Array;
    const pArr = this.params.array as Float32Array;

    for (let i = 0; i < MAX_CLOUDS; i++) {
      const cl = this.pool[i];
      if (!cl.active) continue;
      cl.age += h;
      const left = cl.dur - cl.age;
      if (left <= 0) { cl.active = false; this.activeCount--; continue; }

      const gU = Math.min(1, cl.age / SMOKE.growS);
      const grow = 1 - Math.pow(1 - gU, 3);
      const fade = left < SMOKE.fadeS ? Math.max(0, left / SMOKE.fadeS) : 1;
      const fadeEase = fade * fade * (3 - 2 * fade);
      const riseFade = left < SMOKE.fadeS ? (1 - fade) * 1.15 : 0;

      const dx = camPos.x - cl.x;
      const dy = (camPos.y - (cl.y + SMOKE.height * 0.42)) * 1.18;
      const dz = camPos.z - cl.z;
      const effR = SMOKE.radius * grow;
      const dist = Math.hypot(dx, dy, dz);
      if (effR > 0.5 && dist < effR * 1.05) {
        const sub = Math.max(0, Math.min(1, 1 - (dist - effR * 0.35) / (effR * 0.7)));
        const v = sub * fadeEase;
        if (v > insideMax) insideMax = v;
      }

      const puffs = cl.puffs;
      for (let k = 0; k < PUFFS_PER_CLOUD && outIdx < MAX_PUFFS; k++) {
        const pf = puffs[k];
        const turbX = Math.sin(cl.age * 0.9 + pf.phase) * 0.24 * grow;
        const turbY = Math.cos(cl.age * 0.75 + pf.phase * 1.3) * 0.18 * grow;
        const turbZ = Math.cos(cl.age * 0.85 + pf.phase * 0.7) * 0.24 * grow;
        const c3 = outIdx * 3, p4 = outIdx * 4;
        cArr[c3] = cl.x + pf.ox * grow + turbX;
        cArr[c3 + 1] = cl.y + 0.3 + (pf.oy - 0.3) * grow + turbY + riseFade;
        cArr[c3 + 2] = cl.z + pf.oz * grow + turbZ;
        pArr[p4] = pf.r * (0.28 + 0.72 * grow) * (1 + (1 - fade) * 0.16);
        pArr[p4 + 1] = pf.rot0 + cl.age * pf.spin;
        pArr[p4 + 2] = pf.op * Math.min(1, gU * 2.2) * fadeEase;
        pArr[p4 + 3] = pf.shade;
        outIdx++;
      }
    }

    this.mesh.count = outIdx;
    this.mesh.visible = outIdx > 0;
    if (outIdx > 0) {
      this.centers.needsUpdate = true;
      this.params.needsUpdate = true;
    }

    if (this.hazeEl) {
      const target = insideMax * 0.86;
      this.hazeAlpha += (target - this.hazeAlpha) * Math.min(1, h * 11);
      if (this.hazeAlpha < 0.004 && target === 0) this.hazeAlpha = 0;
      const next = this.hazeAlpha === 0 ? "0" : this.hazeAlpha.toFixed(3);
      if (next !== this.lastHazeStr) { this.lastHazeStr = next; this.hazeEl.style.opacity = next; }
    }
  }
}
