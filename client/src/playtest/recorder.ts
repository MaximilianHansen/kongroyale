// The playtest recorder: once a second it rolls the frame-time histogram into the metrics ring (metrics.hot.ts) and
// hands the new row to whoever listens: the perf HUD (?perfhud) draws it, the diagnostics sampler (?diag, diag.ts)
// looks for hitch causes in it. Both share one ring and one clock. Loaded only when one of them is on (playtest/index.ts).
import type { Engine } from "../engine/engine";
import { CAPACITY_S, FIELDS, WIDTH, cursor, pauseClock, recordFrame, ring, rollSecond } from "./metrics.hot";

export { ring };

export interface Timeline { fields: readonly string[]; rows: number[][]; dropped: number }

/** the ring as rows, oldest first */
export function timeline(): Timeline {
  const kept = Math.min(cursor.rows, CAPACITY_S), rows: number[][] = [];
  for (let r = cursor.rows - kept; r < cursor.rows; r++) {
    const at = (r % CAPACITY_S) * WIDTH;
    rows.push(Array.from(ring.subarray(at, at + WIDTH), (v) => Math.round(v * 100) / 100));
  }
  return { fields: FIELDS, rows, dropped: cursor.rows - kept };
}

/** start the per-frame and per-second recording; `onSecond` gets the offset of each new row in `ring` */
export function startRecorder(engine: Engine, onSecond: (row: number) => void): void {
  engine.onDraw = recordFrame;
  addEventListener("visibilitychange", pauseClock);
  setInterval(() => onSecond(rollSecond(engine)), 1000);
  (window as unknown as { __kr: Record<string, unknown> }).__kr.playtest = { timeline };
}
