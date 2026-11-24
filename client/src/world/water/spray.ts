// SPRAY BURSTS: every swell that surges against a sea stack, a big rock or a
// cliff foot throws up a burst of white spray. One instanced draw of camera-facing puffs, animated entirely in the vertex
// shader (no CPU work per frame): each spawn point fires in step with the surge foam at its spot (the same phase formula
// as shader.ts "SURGE"), 6 puffs per point rise 1-4 m on a ballistic arc, grow, drift with the wind and fade.
// Spawn points: steep windward coast from the field bake (fieldbake.ts `spray`) + windward faces of big objects standing
// in open water (the obstacle bake's wide proximity, read back once — obstacles.ts `wideCells`).
import * as THREE from "three";
import { WAVES } from "./waves";
import type { Scope } from "../../engine/res/scope";

const PER = 8;
/** spatial grid cell size (m) for sectoring spray bursts so distant/offscreen coasts are culled cheaply */
const SECTOR_M = 300;
/** vertex fade reaches zero at 340 m; add a 15 m sector AABB margin so sectors hide only after alpha == 0 */
const MAX_SPRAY_DIST_SQ = 355 * 355;
/** swell travel direction (the windward face looks along −WD) */
const WD = WAVES[0].dir;

export interface SprayPoint { x: number; z: number; nx: number; nz: number }

/** thin a candidate list to at most one point per `cell` metres (first wins) */
export function thinPoints(pts: SprayPoint[], cell: number, max: number): SprayPoint[] {
  const seen = new Set<string>(), out: SprayPoint[] = [];
  for (const p of pts) {
    const k = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** spawn candidates on the windward side of big objects from the wide proximity readback (RGBA8, row 0 = south edge =
 *  +z… see obstacles.ts: uv = (x·scale + 0.5, 0.5 − z·scale)), keeping cells 2.5-6 m out over water deeper than 1.5 m */
export function objectSprayPoints(cells: Uint8Array, size: number, half: number, depthAt: (x: number, z: number) => number): SprayPoint[] {
  const out: SprayPoint[] = [];
  const cellM = (2 * half) / size;
  const val = (i: number, j: number) => (i < 0 || j < 0 || i >= size || j >= size ? 0 : cells[(j * size + i) * 4] / 255);
  for (let j = 1; j < size - 1; j++) for (let i = 1; i < size - 1; i++) {
    const v = val(i, j);
    if (v < 0.6 || v > 0.86) continue;                      // (1 − v)·16.4 m ≈ 2.3-6.5 m from the object
    // uv.y = 0.5 − z·scale (row j ↔ v = (j + 0.5)/size) → z = (0.5 − v)/scale
    const x = ((i + 0.5) / size - 0.5) * 2 * half, z = (0.5 - (j + 0.5) / size) * 2 * half;
    if (depthAt(x, z) < 0.6) continue;
    // away from the object = down the proximity gradient (x → +i, z → −j)
    const gx = val(i + 1, j) - val(i - 1, j), gz = -(val(i, j + 1) - val(i, j - 1));
    const gl = Math.hypot(gx, gz);
    if (gl < 1e-3) continue;
    const ax = -gx / gl, az = -gz / gl;
    if (ax * -WD[0] + az * -WD[1] < -0.4) continue;          // windward + side faces
    out.push({ x, z, nx: ax, nz: az });
  }
  void cellM;
  return out;
}

export class Spray {
  readonly group = new THREE.Group();
  readonly sectors: Array<{ mesh: THREE.InstancedMesh; minX: number; maxX: number; minZ: number; maxZ: number }> = [];
  readonly uniforms: Record<string, THREE.IUniform>;
  readonly #scope: Scope;

  constructor(points: SprayPoint[], shared: Record<string, THREE.IUniform>, parentScope: Scope) {
    const scope = this.#scope = parentScope.child("spray");
    this.group.name = "water-spray";
    this.uniforms = {
      wtrTime: shared.wtrTime, wtrPeriod: shared.wtrPeriod, wtrSkyIrr: shared.wtrSkyIrr, wtrContact: shared.wtrContact,
      uSunCol: { value: new THREE.Color(3, 3, 3) }, uSunDir: shared.wtrSunDirW, uSpray: { value: 1.0 },
    };
    const mat = new THREE.ShaderMaterial({
      name: "water-spray", uniforms: this.uniforms, transparent: true, depthWrite: false, depthTest: true,
      vertexShader: /* glsl */ `
attribute vec4 aSp; attribute vec3 aDir;
uniform float wtrTime, wtrPeriod, uSpray;
varying vec2 vUv; varying float vA;
float coastPhase(vec2 xz) { return sin(xz.x * 0.013 + xz.y * 0.009) * 0.35 + sin(xz.x * 0.0051 - xz.y * 0.0077) * 0.55 + sin(xz.y * 0.021 + 1.3) * 0.12; }
void main() {
  vec2 xz = aSp.xy;
  float camD = length(cameraPosition.xz - xz);
  // the surge's phase at this spot (shader.ts SURGE / rock fringe): the burst starts as the surge peaks
  // (+ a per-point jitter over ~60 % of the cycle — neighbouring points shared one phase, so a whole cliff
  //  foot burst at once for ~15 % of the time and a still frame usually caught none)
  float jit = fract(sin(dot(floor(xz * 0.5), vec2(12.9898, 78.233))) * 43758.5453) * 0.6;
  float psi = fract(wtrTime / (wtrPeriod * 1.2) + coastPhase(xz) * 1.7 + dot(xz, vec2(-0.004, 0.011)) + jit);
  float strong = 0.55 + 0.45 * fract(sin(dot(floor(wtrTime / (wtrPeriod * 1.2) + coastPhase(xz) * 1.7 + dot(xz, vec2(-0.004, 0.011)) + jit) + xz, vec2(12.9898, 78.233))) * 43758.5453);
  float tau = (psi - 0.1 - aSp.z * 0.05) * wtrPeriod * 1.2;     // seconds since this puff left
  float life = 1.0 + 0.7 * aSp.w;
  float on = step(0.0, tau) * step(tau, life) * uSpray * (1.0 - smoothstep(260.0, 340.0, camD));
  float v0 = (4.0 + 5.0 * aDir.z) * strong;
  vec2 out2 = vec2(aDir.x, aDir.y);
  vec2 side = vec2(-out2.y, out2.x) * (aSp.w - 0.5) * 3.0;
  // a burst climbs the object's face (back toward it) and falls back out on the wind
  vec3 p = vec3(xz.x, 0.0, xz.y) + vec3(-out2.x, 0.0, -out2.y) * (1.2 + 1.8 * aSp.z)
         + vec3(side.x, 0.0, side.y) * 0.4 + vec3(out2.x, 0.0, out2.y) * tau * (0.6 + 0.8 * aSp.w)
         + vec3(0.0, v0 * tau - 4.0 * tau * tau, 0.0);
  p.y = max(p.y, 0.05);
  float k = clamp(tau / life, 0.0, 1.0);
  // (bigger + taller — at eye level 50-70 m from a cliff foot 0.5-2 m puffs were a few px)
  float size = mix(0.8, 3.4, sqrt(k)) * (0.7 + 0.5 * aDir.z) * strong * on;
  vA = on * (1.0 - k) * (1.0 - k) * smoothstep(0.0, 0.08, k) * 0.85;
  vUv = uv;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  if (on < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // (culled)
}`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunCol, uSunDir, wtrSkyIrr;
varying vec2 vUv; varying float vA;
float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float n = vn(vUv * 6.0 + vA * 3.0) * 0.6 + vn(vUv * 13.0) * 0.4;
  // a misty core + a fringe of droplets (spray, never smoke)
  float mist = smoothstep(1.0, 0.2, r + (n - 0.5) * 0.7);
  float drops = step(0.78, vn(vUv * 38.0 + vA * 7.0)) * smoothstep(1.05, 0.5, r);
  float a = max(mist * 0.75, drops) * vA;
  if (a < 0.004) discard;
  vec3 lit = vec3(1.0, 1.02, 1.05) * (uSunCol * max(uSunDir.y, 0.1) * 0.318 * 1.2 + wtrSkyIrr);
  gl_FragColor = vec4(lit, a);
}`,
    });
    const spMat = scope.material(mat);

    const buckets = new Map<number, SprayPoint[]>();
    for (const p of points) {
      const k = ((Math.floor(p.x / SECTOR_M) + 64) << 10) + Math.floor(p.z / SECTOR_M) + 64;
      let b = buckets.get(k);
      if (!b) buckets.set(k, b = []);
      b.push(p);
    }
    const base = new THREE.PlaneGeometry(1, 1), idMat = new THREE.Matrix4();
    const posA = base.getAttribute("position"), uvA = base.getAttribute("uv"), idxA = base.getIndex();
    for (const pts of buckets.values()) {
      const count = pts.length * PER, g = scope.geometry("geo.world", new THREE.BufferGeometry());
      g.setAttribute("position", posA); g.setAttribute("uv", uvA); g.setIndex(idxA);
      const inst = new Float32Array(count * 4), dir = new Float32Array(count * 3);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
        for (let q = 0; q < PER; q++) {
          const i = k * PER + q;
          inst[i * 4] = p.x; inst[i * 4 + 1] = p.z; inst[i * 4 + 2] = q / PER; inst[i * 4 + 3] = Math.random();
          dir[i * 3] = p.nx; dir[i * 3 + 1] = p.nz; dir[i * 3 + 2] = Math.random();
        }
      }
      g.setAttribute("aSp", new THREE.InstancedBufferAttribute(inst, 4));
      g.setAttribute("aDir", new THREE.InstancedBufferAttribute(dir, 3));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3((minX + maxX) * 0.5, 6, (minZ + maxZ) * 0.5), Math.hypot(maxX - minX, maxZ - minZ) * 0.5 + 10);
      const m = new THREE.InstancedMesh(g, spMat, count);
      m.name = "water-spray-sector"; m.renderOrder = 2;
      m.castShadow = m.receiveShadow = m.userData.castShadow = m.userData.farShadow = false;
      m.userData.noFoam = true;
      for (let i = 0; i < count; i++) m.setMatrixAt(i, idMat);
      this.group.add(m);
      this.sectors.push({ mesh: m, minX, maxX, minZ, maxZ });
    }
    scope.defer(() => base.dispose());
  }

  update(camPos: THREE.Vector3, visible: boolean, sun?: THREE.DirectionalLight) {
    let any = false;
    if (visible && camPos.y <= 450 && this.sectors.length) {
      const cx = camPos.x, cz = camPos.z;
      for (const s of this.sectors) {
        const dx = cx < s.minX ? s.minX - cx : cx > s.maxX ? cx - s.maxX : 0;
        const dz = cz < s.minZ ? s.minZ - cz : cz > s.maxZ ? cz - s.maxZ : 0;
        if (s.mesh.visible = dx * dx + dz * dz <= MAX_SPRAY_DIST_SQ) any = true;
      }
      if (any && sun) (this.uniforms.uSunCol.value as THREE.Color).copy(sun.color).multiplyScalar(sun.intensity);
    }
    this.group.visible = any;
  }

  dispose() { this.#scope.dispose(); }
}
