// The playtest perf HUD (?perfhud): a small panel in the top-left corner that shows the newest second of the metrics
// ring (recorder.ts): fps, frame p95 and max, GPU ms, ping and jitter, heap, and the renderer's resource counts.

const CSS = `.kr-perfhud { position: fixed; left: 8px; top: 30vh; z-index: 99998; pointer-events: none; user-select: none;
  font: 600 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #fbf3c9; background: rgba(10,30,46,0.72);
  border: 1px solid rgba(255,212,0,0.45); border-radius: 4px; padding: 4px 7px; white-space: pre; font-variant-numeric: tabular-nums; }
.kr-perfhud b { font-weight: 700; color: #ffd400; }
.kr-perfhud .bad { color: #ff8a7a; }`;

const fixed = (v: number, d: number) => (v < 0 ? "–" : v.toFixed(d));
const warn = (bad: boolean, text: string) => (bad ? `<span class="bad">${text}</span>` : text);

/** add the panel and return the function that redraws it from a ring row */
export function installPerfHud(ring: Float32Array): (at: number) => void {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const el = document.createElement("div");
  el.className = "kr-perfhud";
  document.body.appendChild(el);
  return (at) => {
    const v = (i: number) => ring[at + i];
    el.innerHTML = [
      `<b>${fixed(v(1), 0)}</b> fps · p95 ${warn(v(3) > 33.4, fixed(v(3), 1) + " ms")} · max ${warn(v(4) > 50, fixed(v(4), 0))} · gpu ${v(7) > 0 ? fixed(v(7), 1) : "–"} ms`,
      `ping ${warn(v(8) > 120, fixed(v(8), 0))} ms ± ${fixed(v(9), 1)} · heap ${fixed(v(10), 0)} MB · ${warn(v(5) > 0, fixed(v(5), 0) + " stalls")}`,
      `tex ${v(11)} · geo ${v(12)} · prog ${v(13)} · scale ${fixed(v(14), 2)}`,
    ].join("\n");
  };
}
