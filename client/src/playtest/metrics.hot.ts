import type { Engine } from "../engine/engine";

export const FIELDS = ["t", "fps", "p50Ms", "p95Ms", "maxMs", "over50", "over100", "gpuMs", "pingMs", "jitterMs", "heapMB", "textures", "geometries", "programs", "renderScale", "phase"] as const;
export const WIDTH = FIELDS.length;
export const CAPACITY_S = 7200;
export const ring = new Float32Array(CAPACITY_S * WIDTH);
export const cursor = { rows: 0 };

const BINS = 256, BIN_MS = 0.5, STALL_MS = 50, HITCH_MS = 100;
const hist = new Uint16Array(BINS);
const second = { frames: 0, sumMs: 0, maxMs: 0, over50: 0, over100: 0 };
const clock = { skip: true };

interface KrMatch { phase: number; ping: number; jitter: number }
interface KrHandle { __kr?: { game?: { inMatch?: boolean; cm?: KrMatch | null } } }
interface HeapPerf { memory?: { usedJSHeapSize: number } }

function clearSecond(): void {
  hist.fill(0);
  second.frames = 0;
  second.sumMs = 0;
  second.maxMs = 0;
  second.over50 = 0;
  second.over100 = 0;
}

export function recordFrame(dt: number): void {
  if (clock.skip) { clock.skip = false; return; }
  hist[dt >= BINS * BIN_MS ? BINS - 1 : Math.floor(dt / BIN_MS)]++;
  second.frames++;
  second.sumMs += dt;
  if (dt > second.maxMs) second.maxMs = dt;
  if (dt > STALL_MS) second.over50++;
  if (dt > HITCH_MS) second.over100++;
}

export function pauseClock(): void {
  clock.skip = true;
}

function percentile(p: number): number {
  const target = second.frames * p;
  let acc = 0;
  for (let i = 0; i < BINS - 1; i++) {
    acc += hist[i];
    if (acc >= target) return (i + 1) * BIN_MS;
  }
  return second.maxMs;
}

export function rollSecond(engine: Engine): number {
  const row = (cursor.rows % CAPACITY_S) * WIDTH;
  const k = (globalThis as unknown as KrHandle).__kr;
  const game = k?.game;
  const cm = game?.inMatch ? game.cm ?? null : null;
  const heap = (performance as unknown as HeapPerf).memory;
  const info = engine.renderer.info;
  ring[row] = performance.now() / 1000;
  ring[row + 1] = second.sumMs > 0 ? (second.frames * 1000) / second.sumMs : 0;
  ring[row + 2] = second.frames ? percentile(0.5) : 0;
  ring[row + 3] = second.frames ? percentile(0.95) : 0;
  ring[row + 4] = second.maxMs;
  ring[row + 5] = second.over50;
  ring[row + 6] = second.over100;
  ring[row + 7] = engine.gpuMs;
  ring[row + 8] = cm ? cm.ping : -1;
  ring[row + 9] = cm ? cm.jitter : -1;
  ring[row + 10] = heap ? heap.usedJSHeapSize / 1048576 : -1;
  ring[row + 11] = info.memory.textures;
  ring[row + 12] = info.memory.geometries;
  ring[row + 13] = info.programs ? info.programs.length : 0;
  ring[row + 14] = engine.renderScale;
  ring[row + 15] = cm ? cm.phase : -1;
  clearSecond();
  cursor.rows++;
  return row;
}
