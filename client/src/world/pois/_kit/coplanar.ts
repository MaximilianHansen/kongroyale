import { resources } from "../../../engine/res/scope";
import { flag } from "../../../flags";
import { CO_STRIDE, solveCoplanar, solveCoplanarSteps, type CoSolved, type CoStats } from "./coplanar-solve";
import type { Pace } from "./pace";

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
let workerJobs = 0;

export interface CoBox {
  c: [number, number, number];
  a: Float64Array;
  h: [number, number, number];
  tag: number;
  pos: () => ArrayLike<number> & { [i: number]: number } | null;
  v0: number; vn: number;
}

export class Coplanar {
  boxes: CoBox[] = [];
  addMatrix(w: number, h: number, d: number, e: ArrayLike<number>, tag: number, pos: CoBox["pos"], v0: number, vn: number): void {
    const a = new Float64Array(9), hh: [number, number, number] = [0, 0, 0], dims = [w, h, d];
    for (let k = 0; k < 3; k++) {
      const x = e[k * 4], y = e[k * 4 + 1], z = e[k * 4 + 2], L = Math.sqrt(x * x + y * y + z * z);
      if (!(L > 1e-9) || !(dims[k] > 1e-4)) return;
      a[k * 3] = x / L; a[k * 3 + 1] = y / L; a[k * 3 + 2] = z / L; hh[k] = (dims[k] * L) / 2;
    }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (Math.abs(a[i * 3] * a[j * 3] + a[i * 3 + 1] * a[j * 3 + 1] + a[i * 3 + 2] * a[j * 3 + 2]) > 1e-3) return;
    this.boxes.push({ c: [e[12], e[13], e[14]], a, h: hh, tag, pos, v0, vn });
  }
  addGeometry(g: { attributes: { position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number }; normal?: { getX(i: number): number; getY(i: number): number; getZ(i: number): number } } }, e: ArrayLike<number> | null, tag: number, pos: CoBox["pos"], v0: number, vn: number): void {
    const p = g.attributes.position, n = g.attributes.normal; if (!n || p.count > 64) return;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      if (Math.max(ax, ay, az) < 0.999) return;
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, E = e ?? ID;
    const m = [E[0], E[1], E[2], 0, E[4], E[5], E[6], 0, E[8], E[9], E[10], 0,
      E[0] * cx + E[4] * cy + E[8] * cz + E[12], E[1] * cx + E[5] * cy + E[9] * cz + E[13], E[2] * cx + E[6] * cy + E[10] * cz + E[14], 1];
    this.addMatrix(x1 - x0, y1 - y0, z1 - z0, m, tag, pos, v0, vn);
  }
  resolve(): CoStats {
    const it = this.apply(solveCoplanar(this.pack()), Infinity);
    let st = it.next();
    while (!st.done) st = it.next();
    return st.value;
  }
  *steps(slice = 12): Generator<void, CoStats, void> { return yield* this.apply(yield* solveCoplanarSteps(this.pack(), slice), slice); }
  async resolveAsync(pace: Pace, slice: number): Promise<CoStats> {
    const solved = flag("coworker") ? await pace.wait(solveInWorker(this.pack())) : null;
    const it = solved ? this.apply(solved, slice) : this.steps(slice);
    let st = it.next();
    while (!st.done) { await pace.pause(); st = it.next(); }
    return st.value;
  }
  private pack(): Float64Array {
    const out = new Float64Array(this.boxes.length * CO_STRIDE);
    for (let i = 0, o = 0; i < this.boxes.length; i++, o += CO_STRIDE) {
      const b = this.boxes[i];
      out[o] = b.c[0]; out[o + 1] = b.c[1]; out[o + 2] = b.c[2];
      out.set(b.a, o + 3);
      out[o + 12] = b.h[0]; out[o + 13] = b.h[1]; out[o + 14] = b.h[2];
      out[o + 15] = b.tag; out[o + 16] = b.pos() ? 1 : 0;
    }
    return out;
  }
  private *apply(s: CoSolved, slice: number): Generator<void, CoStats, void> {
    const M = s.moves;
    let t0 = performance.now();
    for (let i = 0; i < M.length; i += 4) {
      if ((i & 4095) === 4092 && performance.now() - t0 > slice) { yield; t0 = performance.now(); }
      const b = this.boxes[M[i]], k = M[i + 1], sg = M[i + 2], delta = M[i + 3], P = b.pos(); if (!P) continue;
      const ax = b.a[k * 3], ay = b.a[k * 3 + 1], az = b.a[k * 3 + 2], hk = b.h[k] * sg, tol = Math.max(1e-3, b.h[k] * 1e-3);
      const dx = ax * sg * delta, dy = ay * sg * delta, dz = az * sg * delta;
      for (let v = b.v0, ve = b.v0 + b.vn; v < ve; v++) {
        const t = (P[v * 3] - b.c[0]) * ax + (P[v * 3 + 1] - b.c[1]) * ay + (P[v * 3 + 2] - b.c[2]) * az;
        if (Math.abs(t - hk) < tol) { P[v * 3] += dx; P[v * 3 + 1] += dy; P[v * 3 + 2] += dz; }
      }
      b.h[k] += delta / 2; b.c[0] += dx / 2; b.c[1] += dy / 2; b.c[2] += dz / 2;
    }
    this.boxes = [];
    return { boxes: s.boxes, pairs: s.pairs, moved: s.moved, ms: s.ms, maxPass: s.maxPass };
  }
}

function solveInWorker(packed: Float64Array): Promise<CoSolved | null> {
  if (typeof Worker === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const scope = resources.root.child("coplanar-" + ++workerJobs);
    const done = (r: CoSolved | null) => { scope.dispose(); resolve(r); };
    try {
      const w = scope.worker(new Worker(new URL("./coplanar.worker.ts", import.meta.url), { type: "module" }));
      w.onmessage = (e: MessageEvent<CoSolved>) => done(e.data);
      w.onerror = (e) => { console.warn("coplanar worker failed, resolving on the main thread", e.message); done(null); };
      w.postMessage(packed, [packed.buffer]);
    } catch (e) {
      console.warn("coplanar: no worker", e);
      done(null);
    }
  });
}
