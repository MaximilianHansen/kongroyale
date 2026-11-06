// LOW-MEMORY DEVICE — the one answer to "may this browser run out of memory?". The boot's low-memory mode (low-mem.ts:
// POIs build only near the player), the helicopter's first-use model load (actors/heli-tripo.ts) and the memory savers
// that default on with it (lowMemSaver: ?geofree, ?audioevict) all ask here, so they always agree. Low-memory is:
//   • Safari, and every other WebKit browser that is not Chromium (so every iOS browser): WebKit's per-tab memory limit
//     applies whatever the RAM;
//   • navigator.deviceMemory under 8 (GB; Chromium only, rounded down to a power of two and capped at 8);
//   • no deviceMemory at all (Firefox; Chromium on a page that is not a secure context) and at most FEW_CORES_N logical
//     cores. Firefox reports no memory figure, but a 4 GB machine rarely has more than 4 threads, and an 8 GB one with
//     4 threads is slow enough that building POIs on demand pays for itself anyway.
// ?lowmem=1 / =0 force it either way; ?prepare=full (build everything up front) turns it off. Never on outside a page
// (Node, workers).
import { flag } from "./flags";

/** at most this many logical cores counts as low-memory in a browser that reports no deviceMemory */
const FEW_CORES_N = 4;

/** the device counts as low-memory (see the header). `forced` = the ?lowmem value, `fullPrepare` = ?prepare=full */
export function isLowMemory(forced: string | null, fullPrepare: boolean): boolean {
  if (fullPrepare || typeof document === "undefined" || typeof navigator === "undefined") return false;
  if (forced !== null) return forced === "1";
  const ua = navigator.userAgent;
  if (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) return true;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (mem !== undefined) return mem < 8;
  const cores = navigator.hardwareConcurrency;
  return cores > 0 && cores <= FEW_CORES_N;
}

/** a memory saver's switch (`v` = its flag's value): "1" on, "0" off, absent = on exactly when the low-memory mode is */
export function lowMemSaver(v: string | null): boolean {
  return v === null ? isLowMemory(flag("lowmem"), flag("prepare") === "full") : v === "1";
}
