import type * as THREE from "three";
import type { Poi } from "../../shared/world/map";
import { isLowMemory } from "./low-mem-device";

export function lowMemoryDevice(forced: string | null, fullPrepare: boolean): boolean {
  const on = isLowMemory(forced, fullPrepare);
  const kr = (globalThis as unknown as { __kr?: { lowMem?: boolean; streamed?: boolean } }).__kr;
  if (kr) { kr.lowMem = on; if (on) kr.streamed = true; }
  return on;
}

function inSession(): boolean {
  const kr = (globalThis as unknown as { __kr?: { game?: { inMatch?: boolean }; caster?: { casting?: boolean } } }).__kr;
  return !!kr?.game?.inMatch || !!kr?.caster?.casting;
}

function nearModule(pending: string[], camera: THREE.Camera, pois: readonly Poi[], radiusM: number): string | null {
  if (!inSession()) return null;
  const e = camera.matrixWorld.elements;
  let best: string | null = null, bestD = radiusM;
  for (const id of pending) {
    const p = pois.find((x) => `poi:${x.id}` === id);
    if (!p) return id;
    const d = Math.hypot(e[12] - p.x, e[13] - (p.padY ?? 0), e[14] - p.z) - p.r;
    if (d < bestD) { best = id; bestD = d; }
  }
  return best;
}

export async function nextNearModule(pending: string[], camera: THREE.Camera, pois: readonly Poi[], radiusM: number): Promise<string> {
  for (;;) {
    const id = nearModule(pending, camera, pois, radiusM);
    if (id) { pending.splice(pending.indexOf(id), 1); return id; }
    await new Promise((r) => setTimeout(r, 250));
  }
}
