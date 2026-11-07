import type { WorldCtx } from "../../../engine/engine";

export interface Pace {
  pause(): Promise<void>;
  wait<T>(p: Promise<T>): Promise<T>;
}

export const PACE_CHECK_MS = 1;

export function ctxPace(ctx: WorldCtx): Pace {
  return { pause: () => ctx.yield(), wait: (p) => p };
}

export class SlicePace implements Pace {
  busyMs = 0;
  maxMs = 0;
  private t = performance.now();
  constructor(private readonly ctx: WorldCtx) {}
  async pause(): Promise<void> {
    if (performance.now() - this.t < this.ctx.sliceMs) return;
    this.end(performance.now());
    await this.ctx.afterPaint();
    this.t = performance.now();
  }
  async wait<T>(p: Promise<T>): Promise<T> {
    this.end(performance.now());
    const v = await p;
    this.t = performance.now();
    return v;
  }
  finish() { this.end(performance.now()); this.t = performance.now(); }
  private end(at: number) {
    const d = at - this.t;
    this.busyMs += d;
    if (d > this.maxMs) this.maxMs = d;
  }
}
