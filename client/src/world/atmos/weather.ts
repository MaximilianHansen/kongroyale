// Tropical rain system: GPU-wrapped LineSegments precipitation with continuous 0..1 intensity,
// quality-scaled particle budgets, and GPU-side shelter occlusion via InteriorVolume.
import * as THREE from "three";
import { flag } from "../../flags";
import { atmosFlags, type AtmosState } from "./state";
import type { AtmosUniforms } from "./glsl";
import type { InteriorVolume } from "./interior";

export type QualityLevel = "low" | "medium" | "high" | "epic" | "ultra";

/** Public rain control API exposed on AtmosApi.weather. */
export interface WeatherApi {
  /** Current smoothed rain intensity (0..1). */
  getRainIntensity(): number;
  /** Target rain intensity (0..1). */
  getRainTarget(): number;
  /** Set target rain intensity (clamped to 0..1); immediate skips the fade. */
  setRainIntensity(intensity: number, immediate?: boolean): void;
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

const VOLUME_XZ = 28;
const VOLUME_Y = 18;
const MAX_DROPS = 1400;

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

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
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
  private mat: THREE.ShaderMaterial;
  private rain = 0;
  private rainTarget = 0;
  private puddlesEnabled = true;
  private camOutdoor = 1;
  private visFrame = 0;

  constructor(
    private state: AtmosState,
    private uniforms: AtmosUniforms,
    private applyPostRain?: (streaks: number, puddles: number) => void,
    private applyCloudSky?: (rain: number) => void,
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
        uniform sampler3D uAtmIntVol;
        uniform vec4 uAtmIntO;
        uniform vec3 uAtmIntInv;
        out float vAlpha;
        out float vEnd;

        float shelterTransmittance(vec3 wp) {
          if (uAtmIntO.w < 0.5) return 1.0;
          float trans = 1.0;
          vec3 dir = vec3(0.14, 1.0, 0.06);
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
          vec3 rel = position - uCamPos;
          rel.x += uTime * 2.8 + sin(uTime * 1.15 + phase) * 0.35;
          rel.z += uTime * 1.2 + cos(uTime * 0.95 + phase) * 0.25;
          rel.y -= uTime * speed;
          rel.x = mod(rel.x + ${(VOLUME_XZ * 0.5).toFixed(1)}, ${VOLUME_XZ.toFixed(1)}) - ${(VOLUME_XZ * 0.5).toFixed(1)};
          rel.z = mod(rel.z + ${(VOLUME_XZ * 0.5).toFixed(1)}, ${VOLUME_XZ.toFixed(1)}) - ${(VOLUME_XZ * 0.5).toFixed(1)};
          rel.y = mod(rel.y + ${(VOLUME_Y * 0.5).toFixed(1)}, ${VOLUME_Y.toFixed(1)}) - ${(VOLUME_Y * 0.5).toFixed(1)};
          vec3 basePos = uCamPos + rel;
          vec3 worldPos = basePos + vec3(0.14, len, 0.06) * aEnd;

          float dist = length(rel.xz);
          float nearFade = smoothstep(1.2, 2.8, dist);
          float farFade = smoothstep(${(VOLUME_XZ * 0.5).toFixed(1)}, 4.0, dist);
          float vertFade = smoothstep(${(VOLUME_Y * 0.5).toFixed(1)}, ${(VOLUME_Y * 0.5 - 3).toFixed(1)}, abs(rel.y));
          float shelter = shelterTransmittance(basePos);
          // Subtle spatial/temporal gust variation so rainfall falls in natural sheets rather than a uniform grid
          float gust = 0.72 + 0.28 * sin(basePos.x * 0.22 + uTime * 1.1) * cos(basePos.z * 0.19 - uTime * 0.85);
          float densityVar = smoothstep(0.0, 0.35, uIntensity - aSeed.z * 0.28 + (gust - 0.72) * 0.45);

          vEnd = aEnd;
          vAlpha = nearFade * farFade * vertFade * shelter * gust * densityVar * (0.18 + 0.30 * aSeed.z) * uAlphaGain;
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

    if (flag("cam") || flag("view") || flag("shot")) {
      const f = parseWeatherFlag();
      if (f !== null) {
        this.setRainIntensity(f, true);
      }
    }
  }

  getRainIntensity(): number {
    return this.rain;
  }

  getRainTarget(): number {
    return this.rainTarget;
  }

  setRainIntensity(intensity: number, immediate = false) {
    const clamped = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0;
    this.rainTarget = clamped;
    if (immediate) this.rain = clamped;
  }

  /** Whether rain is currently active or fading. */
  isActive(): boolean {
    return this.rain > 0.005 || this.rainTarget > 0.005;
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
    const step = 1 - Math.exp(-Math.min(0.1, Math.max(0, dt)) * 1.2);
    this.rain += (this.rainTarget - this.rain) * step;
    if (Math.abs(this.rain - this.rainTarget) < 0.001) this.rain = this.rainTarget;

    const flags = atmosFlags();
    const preset = this.state.preset;

    if (!flags.has("nowet")) {
      this.uniforms.uAtmWet.value = Math.max(preset.wet ?? 0, this.rain * 0.85);
    }
    if (!flags.has("nofog")) {
      this.uniforms.uAtmHazeDensity.value = preset.hazeDensity * (1 + this.rain * 0.55);
    }

    if (interior && this.rain > 0.01) {
      if ((this.visFrame++ % 3) === 0) {
        const targetVis = interior.visAt(camera.position);
        this.camOutdoor += (targetVis - this.camOutdoor) * Math.min(1, Math.max(0, dt) * 12);
      }
    } else {
      this.camOutdoor += (1 - this.camOutdoor) * Math.min(1, Math.max(0, dt) * 6);
    }

    const streaks = this.rain * 0.65 * this.camOutdoor;
    const puddles = this.puddlesEnabled ? smoothstep(0.35, 0.9, this.rain) * 0.65 : 0;
    this.applyPostRain?.(streaks, puddles);
    this.applyCloudSky?.(this.rain);

    this.object.visible = this.rain > 0.015;
    if (this.object.visible) {
      this.mat.uniforms.uTime.value = t;
      this.mat.uniforms.uCamPos.value.copy(camera.position);
      this.mat.uniforms.uIntensity.value = this.rain;
    }
  }

  dispose() {
    this.object.geometry.dispose();
    this.mat.dispose();
  }
}
