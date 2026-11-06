import type { Engine } from "./engine";
export { enableFly } from "./fly";

export function installTexProf(e: Engine) {
  const gl = e.renderer.getContext() as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const fn of ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D", "texStorage2D", "texStorage3D", "compressedTexImage2D", "compressedTexSubImage2D", "generateMipmap"]) {
    const f = gl[fn]; if (typeof f !== "function") continue;
    gl[fn] = (...a: unknown[]) => {
      const t0 = performance.now();
      try { return f.apply(gl, a); } finally {
        const ms = performance.now() - t0;
        if (ms > 0.5) {
          const src = a.find((x) => x && typeof x === "object" && "width" in (x as object)) as { width?: number; height?: number } | undefined;
          const nums = a.filter((x) => typeof x === "number") as number[];
          const w = src?.width ?? nums[3] ?? 0, h = src?.height ?? nums[4] ?? 0;
          const kr = (globalThis as { __kr?: { stage?: string; streamStage?: string } }).__kr;
          const row: Engine["texProf"][number] = { fn, w, h, d: fn.includes("3D") ? nums[5] ?? 0 : 1, ms: +ms.toFixed(1), stage: String(kr?.streamStage && kr.streamStage !== "done" ? kr.streamStage : kr?.stage ?? ""), at: Math.round(t0) };
          const so = a.find((x) => x && typeof x === "object") as { constructor?: { name?: string }; src?: string } | undefined;
          if (so) { row.kind = so.constructor?.name ?? "?"; if (typeof so.src === "string") row.src = so.src.replace(/^.*\/assets\//, "").slice(0, 80); }
          if (ms > 8) row.site = (new Error().stack ?? "").split("\n").slice(2, 9).map((l) => l.trim().replace(/^at /, "").replace(/https?:\/\/[^/]+\//, "").replace(/\?[^:]*:/, ":")).join(" < ");
          e.texProf.push(row); if (e.texProf.length > 4000) e.texProf.shift();
        }
      }
    };
  }
}

export function bench(e: Engine, n = 60): { avgMs: number; p95Ms: number; fps: number; calls: number; tris: number } {
  const gl = e.renderer.getContext();
  const px = new Uint8Array(4);
  const times: number[] = [];
  const info = e.renderer.info;
  const auto = info.autoReset;
  info.autoReset = false;
  let calls = 0, tris = 0;
  for (let i = 0; i < n; i++) {
    info.reset();
    const t0 = performance.now();
    e.step(1 / 120);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    times.push(performance.now() - t0);
    calls += info.render.calls; tris += info.render.triangles;
  }
  info.autoReset = auto;
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / n;
  return { avgMs: +avg.toFixed(2), p95Ms: +times[Math.floor(n * 0.95)].toFixed(2), fps: Math.round(1000 / avg), calls: Math.round(calls / n), tris: Math.round(tris / n) };
}
