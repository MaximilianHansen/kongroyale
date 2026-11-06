import type { Engine } from "../engine/engine";
import { flag } from "../flags";
import { CAPACITY_S, FIELDS, WIDTH, cursor, pauseClock, recordFrame, ring, rollSecond } from "./metrics.hot";

export interface Timeline { fields: readonly string[]; rows: number[][]; dropped: number }

export function timeline(): Timeline {
  const kept = Math.min(cursor.rows, CAPACITY_S), rows: number[][] = [];
  for (let r = cursor.rows - kept; r < cursor.rows; r++) {
    const at = (r % CAPACITY_S) * WIDTH;
    rows.push(Array.from(ring.subarray(at, at + WIDTH), (v) => Math.round(v * 100) / 100));
  }
  return { fields: FIELDS, rows, dropped: cursor.rows - kept };
}

const CSS = `.kr-perfhud { position: fixed; left: 8px; top: 30vh; z-index: 99998; pointer-events: none; user-select: none;
  font: 600 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #fbf3c9; background: rgba(10,30,46,0.72);
  border: 1px solid rgba(255,212,0,0.45); border-radius: 4px; padding: 4px 7px; white-space: pre; font-variant-numeric: tabular-nums; }
.kr-perfhud b { font-weight: 700; color: #ffd400; }
.kr-perfhud .bad { color: #ff8a7a; }`;

const fixed = (v: number, d: number) => (v < 0 ? "–" : v.toFixed(d));
const warn = (bad: boolean, text: string) => (bad ? `<span class="bad">${text}</span>` : text);

export function installPerfHud(engine: Engine): void {
  if (!flag("notimer")) engine.timeGpu();
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const el = document.createElement("div");
  el.className = "kr-perfhud";
  document.body.appendChild(el);
  engine.onDraw = recordFrame;
  addEventListener("visibilitychange", pauseClock);
  setInterval(() => {
    const at = rollSecond(engine);
    const v = (i: number) => ring[at + i];
    el.innerHTML = [
      `<b>${fixed(v(1), 0)}</b> fps · p95 ${warn(v(3) > 33.4, fixed(v(3), 1) + " ms")} · max ${warn(v(4) > 50, fixed(v(4), 0))} · gpu ${v(7) > 0 ? fixed(v(7), 1) : "–"} ms`,
      `ping ${warn(v(8) > 120, fixed(v(8), 0))} ms ± ${fixed(v(9), 1)} · heap ${fixed(v(10), 0)} MB · ${warn(v(5) > 0, fixed(v(5), 0) + " stalls")}`,
      `tex ${v(11)} · geo ${v(12)} · prog ${v(13)} · scale ${fixed(v(14), 2)}`,
    ].join("\n");
  }, 1000);
  (window as unknown as { __kr?: Record<string, unknown> }).__kr!.playtest = { timeline };
}
