// Deterministic regional weather simulation: seeded from the match seed, evaluated identically on server and client.
// Models moving, growing/shrinking, merging/splitting regional cells (fog, rain, storm) over 3-6 min lifecycles.
import * as dmath from "./dmath";
import { Rng } from "./rng";

export const enum WeatherKind {
  Clear = 0,
  Fog = 1,
  Rain = 2,
  Storm = 3,
}

export const MAX_WEATHER_CELLS = 6;
export const WEATHER_STRIKE_TELEGRAPH_S = 2.2;
export const WEATHER_STRIKE_ACTIVE_S = 0.35;
export const WEATHER_STRIKE_RADIUS_M = 6.5;
export const WEATHER_STRIKE_DAMAGE = 28;

export interface WeatherCellSpec {
  id: number;
  kind: WeatherKind;
  bornT: number;
  lifeT: number;
  x0: number;
  z0: number;
  vx: number;
  vz: number;
  rPeak: number;
  rainPeak: number;
  fogPeak: number;
  stormPeak: number;
  windX: number;
  windZ: number;
  /** 0 = normal, 1 = splits mid-life into two diverging cells, 2 = merges mid-life */
  behavior: number;
  splitVx: number;
  splitVz: number;
  /** deterministic strike cadence (s) when stormPeak > 0.45 */
  strikeEveryS: number;
  strikePhaseS: number;
}

export interface WeatherPlan {
  seed: number;
  cells: WeatherCellSpec[];
}

export interface WeatherCell {
  id: number;
  kind: WeatherKind;
  x: number;
  z: number;
  vx: number;
  vz: number;
  radius: number;
  rain: number;
  fog: number;
  storm: number;
  windX: number;
  windZ: number;
}

export interface WeatherStrike {
  active: boolean;
  /** 0..1 telegraph buildup before discharge, 1 during discharge */
  telegraph: number;
  discharging: boolean;
  x: number;
  z: number;
  cellId: number;
  strikeKey: number;
}

export interface WeatherState {
  matchPhase: number;
  time: number;
  stormPhase: number;
  count: number;
  cells: WeatherCell[];
  strike: WeatherStrike;
}

export interface WeatherSample {
  rain: number;
  fog: number;
  storm: number;
  windX: number;
  windZ: number;
  /** lagged ground wetness estimate (0..1) from current + recent cell passage */
  wetness: number;
  kind: WeatherKind;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Pre-allocate a mutable WeatherState (zero per-tick allocations). */
export function makeWeatherState(): WeatherState {
  const cells: WeatherCell[] = [];
  for (let i = 0; i < MAX_WEATHER_CELLS; i++) {
    cells.push({
      id: 0,
      kind: WeatherKind.Clear,
      x: 0,
      z: 0,
      vx: 0,
      vz: 0,
      radius: 0,
      rain: 0,
      fog: 0,
      storm: 0,
      windX: 0,
      windZ: 0,
    });
  }
  return {
    matchPhase: 0,
    time: 0,
    stormPhase: 0,
    count: 0,
    cells,
    strike: { active: false, telegraph: 0, discharging: false, x: 0, z: 0, cellId: -1, strikeKey: -1 },
  };
}

/** Pre-allocate a mutable WeatherSample (zero per-tick allocations). */
export function makeWeatherSample(): WeatherSample {
  return { rain: 0, fog: 0, storm: 0, windX: 0, windZ: 0, wetness: 0, kind: WeatherKind.Clear };
}

export let ACTIVE_WEATHER: WeatherState | undefined;
export function setActiveWeather(w?: WeatherState): void {
  ACTIVE_WEATHER = w;
}

/** Generate a deterministic 25-minute regional weather schedule from the match seed. */
export function planWeather(seed: number): WeatherPlan {
  const rng = new Rng((seed ^ 0x57454154) >>> 0);
  const cells: WeatherCellSpec[] = [];
  const totalSpecs = 13;
  // Staggered across 0..1500 s so 1-3 regional cells appear with clear breaks and rare thunderstorms.
  for (let i = 0; i < totalSpecs; i++) {
    const bornT = i < 2 ? 0 : Math.max(0, (i - 1) * 112 + (rng.next() - 0.5) * 40);
    const lifeT = 175 + rng.next() * 120; // 2.9 - 4.9 min
    const roll = rng.next();
    const kind = roll < 0.36 ? WeatherKind.Fog : roll < 0.86 ? WeatherKind.Rain : WeatherKind.Storm;

    const angle = rng.next() * Math.PI * 2;
    const dist = 140 + rng.next() * 660;
    const x0 = dmath.cos(angle) * dist;
    const z0 = dmath.sin(angle) * dist;

    // Move generally inward/across the island at 1.6 - 4.2 m/s
    const moveAngle = angle + Math.PI + (rng.next() - 0.5) * 1.3;
    const speed = 1.6 + rng.next() * 2.6;
    const vx = dmath.cos(moveAngle) * speed;
    const vz = dmath.sin(moveAngle) * speed;

    const rPeak = kind === WeatherKind.Fog ? 240 + rng.next() * 140 : kind === WeatherKind.Storm ? 250 + rng.next() * 140 : 270 + rng.next() * 170;
    const rainPeak = kind === WeatherKind.Fog ? 0.06 + rng.next() * 0.12 : kind === WeatherKind.Rain ? 0.52 + rng.next() * 0.35 : 0.82 + rng.next() * 0.18;
    const fogPeak = kind === WeatherKind.Fog ? 0.55 + rng.next() * 0.25 : kind === WeatherKind.Rain ? 0.12 + rng.next() * 0.14 : 0.22 + rng.next() * 0.22;
    const stormPeak = kind === WeatherKind.Storm ? 0.60 + rng.next() * 0.40 : 0;

    const windSpeed = kind === WeatherKind.Fog ? 2 + rng.next() * 3 : kind === WeatherKind.Rain ? 5 + rng.next() * 5 : 9 + rng.next() * 5;
    const windAngle = moveAngle + (rng.next() - 0.5) * 0.5;
    const behavior = i % 5 === 2 ? 1 : i % 6 === 4 ? 2 : 0;
    const perpX = -dmath.sin(moveAngle) * (1.1 + rng.next() * 0.8);
    const perpZ = dmath.cos(moveAngle) * (1.1 + rng.next() * 0.8);

    cells.push({
      id: i + 1,
      kind,
      bornT,
      lifeT,
      x0,
      z0,
      vx,
      vz,
      rPeak,
      rainPeak,
      fogPeak,
      stormPeak,
      windX: dmath.cos(windAngle) * windSpeed,
      windZ: dmath.sin(windAngle) * windSpeed,
      behavior,
      splitVx: perpX,
      splitVz: perpZ,
      strikeEveryS: 16 + rng.next() * 12,
      strikePhaseS: rng.next() * 14,
    });
  }
  return { seed, cells };
}

function pushCell(
  out: WeatherState,
  id: number,
  kind: WeatherKind,
  x: number,
  z: number,
  vx: number,
  vz: number,
  radius: number,
  rain: number,
  fog: number,
  storm: number,
  windX: number,
  windZ: number,
) {
  if (out.count >= MAX_WEATHER_CELLS || radius < 20) return;
  const c = out.cells[out.count++];
  c.id = id;
  c.kind = kind;
  c.x = x;
  c.z = z;
  c.vx = vx;
  c.vz = vz;
  c.radius = radius;
  c.rain = rain;
  c.fog = fog;
  c.storm = storm;
  c.windX = windX;
  c.windZ = windZ;
}

/** Evaluate deterministic regional weather state at match time `time` (zero allocations). */
export function weatherAt(
  plan: WeatherPlan,
  time: number,
  stormPhase: number,
  phase: number,
  out: WeatherState,
): void {
  out.matchPhase = phase;
  out.time = time;
  out.stormPhase = stormPhase;
  out.count = 0;
  out.strike.active = false;
  out.strike.telegraph = 0;
  out.strike.discharging = false;

  // Lobby/Warmup (0) and Results (3) stay completely clear.
  if (phase !== 1 && phase !== 2) return;

  // Final circles (stormPhase >= 4) dial down severe wind & storm hazards while keeping rain/fog atmosphere.
  const severeScale = stormPhase >= 5 ? 0.20 : stormPhase >= 4 ? 0.55 : 1.0;
  const hazardsAllowed = phase === 2 && stormPhase < 5;

  for (let i = 0; i < plan.cells.length && out.count < MAX_WEATHER_CELLS; i++) {
    const sp = plan.cells[i];
    const age = time - sp.bornT;
    if (age < 0 || age > sp.lifeT) continue;
    const u = age / sp.lifeT;

    // Smooth lifecycle envelope: grow over first 20%, peak middle, dissipate over last 25%.
    const env = smoothstep(0.0, 0.20, u) * (1.0 - smoothstep(0.75, 1.0, u));
    if (env <= 0.01) continue;

    // Gentle oscillation in intensity & radius so weather evolves continuously.
    const pulse = 0.88 + 0.12 * dmath.sin(u * Math.PI * 3.0 + sp.id);
    const r = sp.rPeak * (0.45 + 0.55 * env) * pulse;
    const rain = sp.rainPeak * env * pulse;
    const fog = sp.fogPeak * env * (0.7 + 0.3 * pulse);
    const storm = sp.stormPeak * env * severeScale;
    const wx = sp.windX * env * severeScale;
    const wz = sp.windZ * env * severeScale;

    if (sp.behavior === 1 && u > 0.42) {
      // Split into two diverging child cells after 42% of lifetime.
      const dtSplit = age - sp.lifeT * 0.42;
      const cx = sp.x0 + sp.vx * age;
      const cz = sp.z0 + sp.vz * age;
      const childR = r * 0.78;
      pushCell(out, sp.id * 10 + 1, sp.kind, cx + sp.splitVx * dtSplit, cz + sp.splitVz * dtSplit, sp.vx + sp.splitVx, sp.vz + sp.splitVz, childR, rain * 0.92, fog * 0.9, storm * 0.85, wx, wz);
      pushCell(out, sp.id * 10 + 2, sp.kind, cx - sp.splitVx * dtSplit, cz - sp.splitVz * dtSplit, sp.vx - sp.splitVx, sp.vz - sp.splitVz, childR, rain * 0.85, fog * 0.9, storm * 0.8, wx, wz);
    } else if (sp.behavior === 2 && u > 0.35 && u < 0.85) {
      // Merge: two converging fronts coalesce into a stronger core at u = 0.6.
      const mergeK = 1.0 - smoothstep(0.35, 0.62, u);
      const cx = sp.x0 + sp.vx * age;
      const cz = sp.z0 + sp.vz * age;
      const offX = sp.splitVx * 75 * mergeK;
      const offZ = sp.splitVz * 75 * mergeK;
      const boost = 1.0 + (1.0 - mergeK) * 0.22;
      pushCell(out, sp.id, sp.kind, cx + offX, cz + offZ, sp.vx, sp.vz, r * boost, clamp01(rain * boost), clamp01(fog * boost), clamp01(storm * boost), wx, wz);
    } else {
      pushCell(out, sp.id, sp.kind, sp.x0 + sp.vx * age, sp.z0 + sp.vz * age, sp.vx, sp.vz, r, rain, fog, storm, wx, wz);
    }
  }

  // Evaluate rare deterministic environmental lightning strike inside the strongest active storm cell.
  if (!hazardsAllowed) return;
  let bestStorm: WeatherCell | null = null;
  for (let i = 0; i < out.count; i++) {
    const c = out.cells[i];
    if (c.storm > 0.45 && (!bestStorm || c.storm > bestStorm.storm)) bestStorm = c;
  }
  if (!bestStorm) return;

  const specIdx = Math.max(0, (bestStorm.id > 10 ? Math.floor(bestStorm.id / 10) : bestStorm.id) - 1);
  const spec = plan.cells[specIdx];
  if (!spec || spec.strikeEveryS <= 0) return;

  const cycleT = time + spec.strikePhaseS;
  const idx = Math.floor(cycleT / spec.strikeEveryS);
  const inCycle = cycleT - idx * spec.strikeEveryS;
  const totalWin = WEATHER_STRIKE_TELEGRAPH_S + WEATHER_STRIKE_ACTIVE_S;
  if (inCycle < totalWin) {
    // Deterministic cell-relative strike offset (never targets players).
    const h1 = ((idx * 2654435761 + plan.seed + spec.id * 97) >>> 0) / 4294967296;
    const h2 = ((idx * 1597334677 + plan.seed * 3 + spec.id * 53) >>> 0) / 4294967296;
    const ang = h1 * Math.PI * 2;
    const rad = dmath.pow(h2, 0.5) * bestStorm.radius * 0.65;
    out.strike.active = true;
    out.strike.x = bestStorm.x + dmath.cos(ang) * rad;
    out.strike.z = bestStorm.z + dmath.sin(ang) * rad;
    out.strike.cellId = bestStorm.id;
    out.strike.strikeKey = spec.id * 10000 + idx;
    if (inCycle < WEATHER_STRIKE_TELEGRAPH_S) {
      out.strike.telegraph = clamp01(inCycle / WEATHER_STRIKE_TELEGRAPH_S);
      out.strike.discharging = false;
    } else {
      out.strike.telegraph = 1.0;
      out.strike.discharging = true;
    }
  }
}

/** Sample weather at world (x, z) by smoothly blending overlapping cells (zero allocations). */
export function sampleWeatherAt(state: WeatherState, x: number, z: number, out: WeatherSample): void {
  out.rain = 0;
  out.fog = 0;
  out.storm = 0;
  out.windX = 0;
  out.windZ = 0;
  out.wetness = 0;
  out.kind = WeatherKind.Clear;

  if (state.count <= 0) return;

  let wSum = 0;
  let wxSum = 0;
  let wzSum = 0;
  let maxRain = 0;
  let maxFog = 0;
  let maxStorm = 0;
  let wetWake = 0;

  for (let i = 0; i < state.count; i++) {
    const c = state.cells[i];
    const dx = x - c.x;
    const dz = z - c.z;
    const d2 = dx * dx + dz * dz;
    const r2 = c.radius * c.radius;
    if (d2 < r2) {
      const d = Math.sqrt(d2);
      const w = 1.0 - smoothstep(c.radius * 0.55, c.radius, d);
      if (w > 0.001) {
        const r = c.rain * w;
        const f = c.fog * w;
        const s = c.storm * w;
        if (r > maxRain) maxRain = r;
        if (f > maxFog) maxFog = f;
        if (s > maxStorm) maxStorm = s;
        wxSum += c.windX * w;
        wzSum += c.windZ * w;
        wSum += w;
      }
    }
    // Trailing wake behind moving rain cells keeps ground damp for ~35-50 s after cell passes.
    const speedSq = c.vx * c.vx + c.vz * c.vz;
    if (c.rain > 0.15 && speedSq > 0.1) {
      const wakeX = c.x - c.vx * 35;
      const wakeZ = c.z - c.vz * 35;
      const wdx = x - wakeX;
      const wdz = z - wakeZ;
      const wd = dmath.hypot(wdx, wdz);
      if (wd < c.radius * 1.05) {
        const wk = (1.0 - smoothstep(c.radius * 0.3, c.radius * 1.05, wd)) * c.rain * 0.65;
        if (wk > wetWake) wetWake = wk;
      }
    }
  }

  out.rain = clamp01(maxRain);
  out.fog = clamp01(maxFog);
  out.storm = clamp01(maxStorm);
  if (wSum > 0.001) {
    const norm = wSum > 1 ? 1 / wSum : 1;
    out.windX = wxSum * norm;
    out.windZ = wzSum * norm;
  }
  out.wetness = clamp01(Math.max(out.rain * 0.95, wetWake));
  out.kind = out.storm > 0.25 ? WeatherKind.Storm : out.rain > 0.15 ? WeatherKind.Rain : out.fog > 0.2 ? WeatherKind.Fog : WeatherKind.Clear;
}
