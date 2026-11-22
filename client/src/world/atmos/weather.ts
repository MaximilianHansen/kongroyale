// Tropical weather renderer: GPU-wrapped LineSegments rain with continuous intensity, regional fog/wetness/wind,
// GPU-side shelter occlusion via InteriorVolume, and environmental lightning bolt/telegraph visuals.
import * as THREE from "three";
import { flag } from "../../flags";
import { atmosFlags, type AtmosState } from "./state";
import type { AtmosUniforms } from "./glsl";
import type { InteriorVolume } from "./interior";

export type QualityLevel = "low" | "medium" | "high" | "epic" | "ultra";

/** Public weather visual control API exposed on AtmosApi.weather. */
export interface WeatherApi {
  /** Current smoothed rain intensity (0..1). */
  getRainIntensity(): number;
  /** Target rain intensity (0..1). */
  getRainTarget(): number;
  /** Set target rain intensity (clamped to 0..1); immediate skips the fade. */
  setRainIntensity(intensity: number, immediate?: boolean): void;
  /** Drive full regional weather conditions smoothly (rain, fog, storm, wind, wetness). */
  setConditions(rain: number, fog: number, storm: number, windX: number, windZ: number, wetness?: number, immediate?: boolean): void;
  /** Update active environmental lightning strike telegraph or discharge at world (x, y, z). */
  setLightningStrike(active: boolean, discharging: boolean, x: number, y: number, z: number, telegraph: number): void;
  /** Update distant 3D storm/rain cloud banks for active regional cells. */
  setWeatherCells?(cells: ReadonlyArray<{ x: number; z: number; radius: number; rain: number; storm: number; id: number }>, count: number): void;
}

/** Parse the ?weather= URL flag into a normalized 0..1 rain intensity, or null if unset/unrecognized. */
export function parseWeatherFlag(): number | null {
  const raw = flag("weather");
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "clear" || v === "none" || v === "off") return 0;
  if (v === "rain") return 0.72;
  if (v === "heavy" || v === "squall") return 1.0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

const VOLUME_XZ = 44;
const VOLUME_Y = 20;
const MAX_DROPS = 1400;
const BOLT_SEGS = 18;
const MAX_CELL_CLOUDS = 6;
const TMP_MAT4 = new THREE.Matrix4();
const TMP_POS = new THREE.Vector3();
const TMP_QUAT = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();

const DROP_BUDGET: Record<QualityLevel, number> = {
  low: 420,
  medium: 840,
  high: 1190,
  epic: MAX_DROPS,
  ultra: MAX_DROPS,
};

const QUALITY_ALPHA_GAIN: Record<QualityLevel, number> = {
  low: 1.18,
  medium: 1.08,
  high: 1.02,
  epic: 1.0,
  ultra: 1.0,
};

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function rh(px: number, py: number): number {
  const f = (n: number) => n - Math.floor(n);
  let x = f(px * 0.1031), y = f(py * 0.1031), z = f(px * 0.1031);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d; y += d; z += d;
  return f((x + y) * z);
}

function rnoise(px: number, py: number): number {
  const ix = Math.floor(px), iy = Math.floor(py);
  let fx = px - ix, fy = py - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = rh(ix, iy), b = rh(ix + 1, iy), c = rh(ix, iy + 1), d = rh(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Matches post.ts puddleMask(wp.xz) so footsteps can splash in visible puddles. */
export function puddleAt(x: number, z: number): number {
  const n = rnoise(x * 0.13, z * 0.13) * 0.55 + rnoise(x * 0.37 + 7.3, z * 0.37 + 7.3) * 0.33 + rnoise(x * 1.3 + 2.1, z * 1.3 + 2.1) * 0.12;
  return smoothstep(0.605, 0.640, n);
}

function buildRainGeometry(): THREE.BufferGeometry {
  const pos = new Float32Array(MAX_DROPS * 2 * 3);
  const seed = new Float32Array(MAX_DROPS * 2 * 3);
  const end = new Float32Array(MAX_DROPS * 2);
  let s = 1337;
  const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };

  for (let i = 0; i < MAX_DROPS; i++) {
    const x = (rand() - 0.5) * VOLUME_XZ;
    const y = rand() * VOLUME_Y;
    const z = (rand() - 0.5) * VOLUME_XZ;
    const sp = 0.82 + rand() * 0.48;
    const len = 0.40 + rand() * 0.55;
    const zSeed = rand();
    for (let k = 0; k < 2; k++) {
      const vi = i * 2 + k;
      pos[vi * 3] = x;
      pos[vi * 3 + 1] = y;
      pos[vi * 3 + 2] = z;
      seed[vi * 3] = sp;
      seed[vi * 3 + 1] = len;
      seed[vi * 3 + 2] = zSeed;
      end[vi] = k;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
  geo.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
  geo.setDrawRange(0, MAX_DROPS * 2);
  return geo;
}

export class TropicalWeather implements WeatherApi {
  readonly object: THREE.LineSegments;
  readonly fxGroup = new THREE.Group();
  private mat: THREE.ShaderMaterial;
  private boltLines: THREE.LineSegments;
  private boltMat: THREE.LineBasicMaterial;
  private telegraphRing: THREE.Mesh;
  private telegraphMat: THREE.MeshBasicMaterial;
  private cellClouds: THREE.InstancedMesh;
  private cellCloudMat: THREE.ShaderMaterial;
  private cellData = new Float32Array(MAX_CELL_CLOUDS * 4);
  private cellAttr: THREE.InstancedBufferAttribute;
  private rain = 0;
  private rainTarget = 0;
  private fog = 0;
  private fogTarget = 0;
  private storm = 0;
  private stormTarget = 0;
  private wet = 0;
  private wetTarget = 0;
  private windX = 0;
  private windZ = 0;
  private windXTarget = 0;
  private windZTarget = 0;
  private flash = 0;
  private nextAmbientFlashT = 8;
  private wasDischarging = false;
  private puddlesEnabled = true;
  private camOutdoor = 1;
  private visFrame = 0;

  constructor(
    private state: AtmosState,
    private uniforms: AtmosUniforms,
    private applyPostRain?: (streaks: number, puddles: number) => void,
    private applyCloudSky?: (rain: number, storm: number, flash: number) => void,
  ) {
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
        uIntensity: { value: 0 },
        uAlphaGain: { value: 1 },
        uWind: { value: new THREE.Vector2(2.4, 1.0) },
        uColor: { value: new THREE.Color(0xc2d4e8) },
        uAtmIntVol: uniforms.uAtmIntVol,
        uAtmIntO: uniforms.uAtmIntO,
        uAtmIntInv: uniforms.uAtmIntInv,
      },
      vertexShader: /* glsl */ `
        precision highp float;
        precision highp sampler3D;
        in vec3 aSeed;
        in float aEnd;
        uniform float uTime;
        uniform vec3 uCamPos;
        uniform float uIntensity;
        uniform float uAlphaGain;
        uniform vec2 uWind;
        uniform sampler3D uAtmIntVol;
        uniform vec4 uAtmIntO;
        uniform vec3 uAtmIntInv;
        out float vAlpha;
        out float vEnd;

        float shelterTransmittance(vec3 wp, vec3 rainDir) {
          if (uAtmIntO.w < 0.5) return 1.0;
          float trans = 1.0;
          vec3 dir = normalize(vec3(rainDir.x, 1.0, rainDir.z));
          float heights[7];
          heights[0] = 0.6;
          heights[1] = 1.4;
          heights[2] = 2.4;
          heights[3] = 3.8;
          heights[4] = 5.6;
          heights[5] = 8.0;
          heights[6] = 11.0;
          for (int i = 0; i < 7; i++) {
            vec3 sp = wp + dir * heights[i];
            vec3 t = (sp - uAtmIntO.xyz) * uAtmIntInv;
            if (all(greaterThanEqual(t, vec3(0.0))) && all(lessThanEqual(t, vec3(1.0)))) {
              float occ = textureLod(uAtmIntVol, t, 0.0).r;
              trans *= 1.0 - smoothstep(0.12, 0.42, occ);
              if (trans < 0.02) return 0.0;
            }
          }
          return trans;
        }

        void main() {
          float speed = 22.0 * aSeed.x;
          float len = aSeed.y * (0.75 + 0.35 * uIntensity);
          float phase = aSeed.z * 6.2831853;
          vec2 windDrift = clamp(uWind, vec2(-12.0), vec2(12.0));
          vec3 rel = position - uCamPos;
          rel.x += uTime * (1.4 + windDrift.x * 0.35) + sin(uTime * 1.15 + phase) * 0.35;
          rel.z += uTime * (0.6 + windDrift.y * 0.35) + cos(uTime * 0.95 + phase) * 0.25;
          rel.y -= uTime * speed;
          rel.x = mod(rel.x + ${(VOLUME_XZ * 0.5).toFixed(1)}, ${VOLUME_XZ.toFixed(1)}) - ${(VOLUME_XZ * 0.5).toFixed(1)};
          rel.z = mod(rel.z + ${(VOLUME_XZ * 0.5).toFixed(1)}, ${VOLUME_XZ.toFixed(1)}) - ${(VOLUME_XZ * 0.5).toFixed(1)};
          rel.y = mod(rel.y + ${(VOLUME_Y * 0.5).toFixed(1)}, ${VOLUME_Y.toFixed(1)}) - ${(VOLUME_Y * 0.5).toFixed(1)};
          vec3 basePos = uCamPos + rel;
          vec3 tilt = vec3(0.06 + windDrift.x * 0.032, len, 0.03 + windDrift.y * 0.032);
          vec3 worldPos = basePos + tilt * aEnd;

          float dist = length(rel.xz);
          float nearFade = smoothstep(1.2, 2.8, dist);
          float farFade = smoothstep(${(VOLUME_XZ * 0.5).toFixed(1)}, 7.0, dist);
          float vertFade = smoothstep(${(VOLUME_Y * 0.5).toFixed(1)}, ${(VOLUME_Y * 0.5 - 3).toFixed(1)}, abs(rel.y));
          float shelter = shelterTransmittance(basePos, tilt);
          float gust = 0.78 + 0.22 * sin(basePos.x * 0.22 + uTime * 1.1) * cos(basePos.z * 0.19 - uTime * 0.85);
          float densityVar = smoothstep(0.0, 0.22, uIntensity - aSeed.z * 0.20 + (gust - 0.78) * 0.4);

          vEnd = aEnd;
          vAlpha = nearFade * farFade * vertFade * shelter * gust * densityVar * (0.26 + 0.34 * aSeed.z) * uAlphaGain;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uIntensity;
        uniform vec3 uColor;
        in float vAlpha;
        in float vEnd;
        out vec4 fragColor;
        void main() {
          float taper = smoothstep(0.0, 0.35, vEnd) * (0.65 + 0.35 * vEnd);
          float a = vAlpha * taper * uIntensity;
          if (a < 0.01) discard;
          fragColor = vec4(uColor, a);
        }
      `,
    });

    this.object = new THREE.LineSegments(buildRainGeometry(), this.mat);
    this.object.name = "atmos-tropical-rain";
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.userData.castShadow = false;
    this.object.userData.farShadow = false;

    const boltGeo = new THREE.BufferGeometry();
    boltGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(BOLT_SEGS * 2 * 3), 3));
    this.boltMat = new THREE.LineBasicMaterial({ color: new THREE.Color(2.2, 2.7, 3.6), transparent: true, opacity: 0.95, depthWrite: false, fog: false });
    this.boltLines = new THREE.LineSegments(boltGeo, this.boltMat);
    this.boltLines.name = "atmos-weather-bolt";
    this.boltLines.frustumCulled = false;
    this.boltLines.visible = false;

    const ringGeo = new THREE.RingGeometry(4.8, 6.5, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.telegraphMat = new THREE.MeshBasicMaterial({ color: 0x9be2ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
    this.telegraphRing = new THREE.Mesh(ringGeo, this.telegraphMat);
    this.telegraphRing.name = "atmos-weather-telegraph";
    this.telegraphRing.visible = false;

    const cellGeo = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.55);
    this.cellAttr = new THREE.InstancedBufferAttribute(this.cellData, 4);
    cellGeo.setAttribute("aCell", this.cellAttr);
    this.cellCloudMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */ `
        precision highp float;
        in vec4 aCell; // x = rain, y = storm, z = seed, w = radius
        out vec2 vUv;
        out vec4 vCell;
        out vec3 vWPos;
        void main() {
          vUv = uv;
          vCell = aCell;
          vec4 wp = instanceMatrix * vec4(position, 1.0);
          vWPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        uniform vec3 uCamPos;
        in vec2 vUv;
        in vec4 vCell;
        in vec3 vWPos;
        out vec4 fragColor;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
            mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }
        float fbm(vec2 p) {
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 3; i++) { s += a * vnoise(p); p *= 2.05; a *= 0.5; }
          return s;
        }

        void main() {
          float rain = vCell.x, storm = vCell.y, seed = vCell.z, rad = vCell.w;
          float dCam = length(vWPos.xz - uCamPos.xz);
          float farFade = smoothstep(rad * 0.55, rad * 1.15, dCam);
          if (farFade < 0.01) discard;

          float n = fbm(vec2(vUv.x * 7.0 + uTime * 0.02 + seed * 11.0, vUv.y * 3.0));
          // Upper band (0.55..1.0): thick dark storm cloud bank; lower band (0..0.55): distant rain curtain
          float cloudBand = smoothstep(0.45, 0.68, vUv.y + (n - 0.5) * 0.16) * (1.0 - smoothstep(0.86, 1.0, vUv.y));
          float curtain = smoothstep(0.02, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 0.72, vUv.y)) * (0.4 + 0.6 * vnoise(vec2(vUv.x * 28.0 + uTime * 0.05, vUv.y * 2.0)));

          vec3 rainCol = mix(vec3(0.26, 0.32, 0.40), vec3(0.14, 0.18, 0.25), storm);
          vec3 curtainCol = vec3(0.32, 0.39, 0.48);
          float cloudA = cloudBand * (0.45 + 0.35 * storm + 0.15 * rain);
          float curtA = curtain * rain * 0.22;
          float a = clamp(cloudA + curtA, 0.0, 0.82) * farFade;
          if (a < 0.01) discard;
          vec3 col = mix(curtainCol, rainCol, clamp(cloudA / max(a, 1e-4), 0.0, 1.0));
          fragColor = vec4(col, a);
        }
      `,
    });
    this.cellClouds = new THREE.InstancedMesh(cellGeo, this.cellCloudMat, MAX_CELL_CLOUDS);
    this.cellClouds.name = "atmos-weather-cell-clouds";
    this.cellClouds.frustumCulled = false;
    this.cellClouds.count = 0;

    this.fxGroup.name = "atmos-weather-fx";
    this.fxGroup.add(this.boltLines, this.telegraphRing, this.cellClouds);

    if (flag("cam") || flag("view") || flag("shot")) {
      const f = parseWeatherFlag();
      if (f !== null) this.setRainIntensity(f, true);
    }
  }

  getRainIntensity(): number {
    return this.rain;
  }

  getRainTarget(): number {
    return this.rainTarget;
  }

  setRainIntensity(intensity: number, immediate = false) {
    const r = clamp01(intensity);
    this.setConditions(r, r * 0.35, r > 0.85 ? (r - 0.85) * 4 : 0, 2.4 * r, 1.0 * r, r * 0.95, immediate);
  }

  setConditions(rain: number, fog: number, storm: number, windX: number, windZ: number, wetness = rain, immediate = false) {
    this.rainTarget = clamp01(rain);
    this.fogTarget = clamp01(fog);
    this.stormTarget = clamp01(storm);
    this.wetTarget = clamp01(wetness);
    this.windXTarget = Number.isFinite(windX) ? windX : 0;
    this.windZTarget = Number.isFinite(windZ) ? windZ : 0;
    if (immediate) {
      this.rain = this.rainTarget;
      this.fog = this.fogTarget;
      this.storm = this.stormTarget;
      this.wet = this.wetTarget;
      this.windX = this.windXTarget;
      this.windZ = this.windZTarget;
      if (this.stormTarget === 0) this.flash = 0;
    }
  }

  setLightningStrike(active: boolean, discharging: boolean, x: number, y: number, z: number, telegraph: number) {
    if (!active) {
      this.telegraphRing.visible = false;
      this.boltLines.visible = false;
      this.wasDischarging = false;
      return;
    }
    this.telegraphRing.position.set(x, y + 0.18, z);
    if (!discharging) {
      this.telegraphRing.visible = true;
      const pulse = 0.35 + 0.65 * telegraph;
      this.telegraphRing.scale.setScalar(0.55 + 0.45 * telegraph);
      this.telegraphMat.opacity = 0.22 + 0.48 * pulse;
      this.boltLines.visible = false;
      this.wasDischarging = false;
    } else {
      this.telegraphRing.visible = true;
      this.telegraphRing.scale.setScalar(1.0);
      this.telegraphMat.opacity = 0.85;
      if (!this.wasDischarging) {
        this.wasDischarging = true;
        this.rebuildBolt(x, y, z);
        this.flash = 1.0;
      }
      this.boltLines.visible = true;
    }
  }

  private rebuildBolt(x: number, y: number, z: number) {
    const pos = this.boltLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    let s = (Math.floor(x * 13 + z * 31) ^ 0x9e3779b9) >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
    let cx = x, cy = y, cz = z;
    const mainSegs = 14;
    for (let i = 0; i < mainSegs; i++) {
      const ny = y + ((i + 1) / mainSegs) * 115;
      const nx = x + rnd() * (i < mainSegs - 1 ? 14 : 24);
      const nz = z + rnd() * (i < mainSegs - 1 ? 14 : 24);
      pos.setXYZ(i * 2, cx, cy, cz);
      pos.setXYZ(i * 2 + 1, nx, ny, nz);
      cx = nx; cy = ny; cz = nz;
    }
    // 4 short fork segments
    for (let i = mainSegs; i < BOLT_SEGS; i++) {
      const bi = 4 + (i - mainSegs) * 2;
      const bx = pos.getX(bi * 2), by = pos.getY(bi * 2), bz = pos.getZ(bi * 2);
      pos.setXYZ(i * 2, bx, by, bz);
      pos.setXYZ(i * 2 + 1, bx + rnd() * 18, by - 12, bz + rnd() * 18);
    }
    pos.needsUpdate = true;
  }

  setWeatherCells(cells: ReadonlyArray<{ x: number; z: number; radius: number; rain: number; storm: number; id: number }>, count: number) {
    let n = 0;
    for (let i = 0; i < count && n < MAX_CELL_CLOUDS; i++) {
      const c = cells[i];
      if (c.rain <= 0.15 && c.storm <= 0.15) continue;
      TMP_POS.set(c.x, 70, c.z);
      TMP_SCALE.set(c.radius * 0.95, 220, c.radius * 0.95);
      TMP_MAT4.compose(TMP_POS, TMP_QUAT, TMP_SCALE);
      this.cellClouds.setMatrixAt(n, TMP_MAT4);
      const o = n * 4;
      this.cellData[o] = c.rain;
      this.cellData[o + 1] = c.storm;
      this.cellData[o + 2] = c.id;
      this.cellData[o + 3] = c.radius;
      n++;
    }
    this.cellClouds.count = n;
    if (n > 0) {
      this.cellClouds.instanceMatrix.needsUpdate = true;
      this.cellAttr.needsUpdate = true;
    }
  }

  /** Whether rain or fog/storm is currently active or fading. */
  isActive(): boolean {
    return this.rain > 0.005 || this.rainTarget > 0.005 || this.fog > 0.005 || this.fogTarget > 0.005;
  }

  setEffectsQuality(level: QualityLevel) {
    const count = DROP_BUDGET[level] ?? MAX_DROPS;
    this.object.geometry.setDrawRange(0, count * 2);
    this.mat.uniforms.uAlphaGain.value = QUALITY_ALPHA_GAIN[level] ?? 1.0;
  }

  setPuddlesEnabled(enabled: boolean) {
    this.puddlesEnabled = enabled;
  }

  update(camera: THREE.Camera, dt: number, t: number, interior?: InteriorVolume | null) {
    const cdt = Math.min(0.1, Math.max(0, dt));
    const step = 1 - Math.exp(-cdt * 1.2);
    this.rain += (this.rainTarget - this.rain) * step;
    this.fog += (this.fogTarget - this.fog) * step;
    this.storm += (this.stormTarget - this.storm) * step;
    this.wet += (this.wetTarget - this.wet) * (1 - Math.exp(-cdt * 0.45));
    this.windX += (this.windXTarget - this.windX) * step;
    this.windZ += (this.windZTarget - this.windZ) * step;

    if (Math.abs(this.rain - this.rainTarget) < 0.001) this.rain = this.rainTarget;
    if (Math.abs(this.fog - this.fogTarget) < 0.001) this.fog = this.fogTarget;
    if (Math.abs(this.storm - this.stormTarget) < 0.001) this.storm = this.stormTarget;
    if (Math.abs(this.wet - this.wetTarget) < 0.001) this.wet = this.wetTarget;

    if (this.storm > 0.25 && t >= this.nextAmbientFlashT) {
      this.flash = Math.max(this.flash, 0.35 + this.storm * 0.35);
      this.nextAmbientFlashT = t + 7 + ((Math.floor(t * 10) % 9) + 1);
    }
    this.flash = Math.max(0, this.flash - cdt * 4.0);

    const flags = atmosFlags();
    const preset = this.state.preset;

    if (!flags.has("nowet")) {
      this.uniforms.uAtmWet.value = Math.max(preset.wet ?? 0, this.wet * 0.85);
    }
    if (!flags.has("nofog")) {
      this.uniforms.uAtmHazeDensity.value = preset.hazeDensity * (1 + this.rain * 0.55 + this.fog * 1.65);
    }

    if (interior && this.rain > 0.01) {
      if ((this.visFrame++ % 3) === 0) {
        const targetVis = interior.visAt(camera.position);
        this.camOutdoor += (targetVis - this.camOutdoor) * Math.min(1, cdt * 12);
      }
    } else {
      this.camOutdoor += (1 - this.camOutdoor) * Math.min(1, cdt * 6);
    }

    const streaks = this.rain * 0.65 * this.camOutdoor;
    const puddles = this.puddlesEnabled ? smoothstep(0.25, 0.85, this.wet) * 0.80 : 0;
    this.applyPostRain?.(streaks, puddles);
    this.applyCloudSky?.(Math.max(this.rain, this.fog * 0.55), this.storm, this.flash);

    this.object.visible = this.rain > 0.015;
    if (this.cellClouds.count > 0) {
      this.cellCloudMat.uniforms.uTime.value = t;
      (this.cellCloudMat.uniforms.uCamPos.value as THREE.Vector3).copy(camera.position);
    }
    if (this.object.visible) {
      this.mat.uniforms.uTime.value = t;
      this.mat.uniforms.uCamPos.value.copy(camera.position);
      this.mat.uniforms.uIntensity.value = this.rain;
      (this.mat.uniforms.uWind.value as THREE.Vector2).set(this.windX, this.windZ);
    }
  }

  dispose() {
    this.object.geometry.dispose();
    this.mat.dispose();
    this.boltLines.geometry.dispose();
    this.boltMat.dispose();
    this.telegraphRing.geometry.dispose();
    this.telegraphMat.dispose();
    this.cellClouds.geometry.dispose();
    this.cellCloudMat.dispose();
  }
}
