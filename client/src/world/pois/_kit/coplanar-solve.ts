const EPS_COPLANAR = 0.004;
export const CO_STRIDE = 17;
const Q = 0.002;

export interface CoStats { boxes: number; pairs: number; moved: number; ms: number; maxPass: number }
export interface CoSolved extends CoStats { moves: Float64Array }

interface SolveBox { c: Float64Array; a: Float64Array; h: Float64Array; tag: number; live: boolean }
interface Face { b: number; k: number; sg: number; d: number; area: number; nx: number; ny: number; nz: number }
interface Clock { t: number; slice: number }
interface PassOut { pairs: number; moved: number; again: Set<number> }

export function solveCoplanar(packed: Float64Array): CoSolved {
  const it = solveCoplanarSteps(packed, Infinity);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

export function* solveCoplanarSteps(packed: Float64Array, slice: number): Generator<void, CoSolved, void> {
  const R: SolveBox[] = [];
  for (let o = 0; o < packed.length; o += CO_STRIDE) R.push({ c: packed.subarray(o, o + 3), a: packed.subarray(o + 3, o + 12), h: packed.subarray(o + 12, o + 15), tag: packed[o + 15], live: packed[o + 16] === 1 });
  const moves: number[] = [];
  let ms = 0;
  const out = { boxes: R.length, pairs: 0, moved: 0, ms: 0, maxPass: 0 };
  let only: Set<number> | null = null;
  const clock: Clock = { t: performance.now(), slice };
  for (let pass = 0; pass < 4; pass++) {
    const r: PassOut = { pairs: 0, moved: 0, again: new Set<number>() };
    clock.t = performance.now();
    for (const _ of passGen(R, only, r, clock, moves)) { void _; ms += performance.now() - clock.t; out.maxPass = Math.max(out.maxPass, +(performance.now() - clock.t).toFixed(1)); yield; clock.t = performance.now(); }
    ms += performance.now() - clock.t; out.maxPass = Math.max(out.maxPass, +(performance.now() - clock.t).toFixed(1));
    if (pass === 0) out.pairs = r.pairs;
    out.moved += r.moved;
    if (!r.moved || !r.again.size) break;
    only = r.again;
    yield; clock.t = performance.now();
  }
  out.ms = +ms.toFixed(1);
  return { ...out, moves: Float64Array.from(moves) };
}

const keyOf = (nx: number, ny: number, nz: number, qd: number) => ((Math.round(nx * 400) + 400) * 801 + (Math.round(ny * 400) + 400)) * 801 * 4e6 + (Math.round(nz * 400) + 400) * 4e6 + qd + 2e6;

function* passGen(R: SolveBox[], only: Set<number> | null, out: PassOut, clock: Clock, moves: number[]): Generator<void, void, void> {
  const buckets = new Map<number, Face[]>();
  for (let i = 0; i < R.length; i++) {
    const b = R[i];
    for (let k = 0; k < 3; k++) {
      const u = (k + 1) % 3, v = (k + 2) % 3, area = 4 * b.h[u] * b.h[v];
      if (area < 4e-4) continue;
      for (let sg = -1; sg <= 1; sg += 2) {
        const nx = b.a[k * 3] * sg, ny = b.a[k * 3 + 1] * sg, nz = b.a[k * 3 + 2] * sg;
        const d = nx * b.c[0] + ny * b.c[1] + nz * b.c[2] + b.h[k];
        const key = keyOf(nx, ny, nz, Math.round(d / Q));
        if (only && !only.has(key) && !only.has(key - 1)) continue;
        let l = buckets.get(key); if (!l) buckets.set(key, l = []);
        l.push({ b: i, k, sg, d, area, nx, ny, nz });
      }
    }
    if ((i & 1023) === 1023 && performance.now() - clock.t > clock.slice) yield;
  }
  const act = new Map<number, { b: number; k: number; sg: number; delta: number }>();
  const cand: Array<{ f: Face; own: boolean; x: number; r: number }> = [];
  for (const [key, list] of buckets) {
    if (only && !only.has(key)) continue;
    const near = buckets.get(key + 1);
    if (list.length + (near?.length ?? 0) < 2) continue;
    const zAxis = Math.abs(list[0].nx) > 0.7;
    cand.length = 0;
    const put = (f: Face, own: boolean) => { const b = R[f.b], u = (f.k + 1) % 3, v = (f.k + 2) % 3, r = Math.hypot(b.h[u], b.h[v]); cand.push({ f, own, x: (zAxis ? b.c[2] + f.nz * b.h[f.k] : b.c[0] + f.nx * b.h[f.k]) - r, r }); };
    for (const f of list) put(f, true);
    if (near) for (const f of near) put(f, false);
    cand.sort((p, q) => p.x - q.x);
    for (let x = 0; x < cand.length; x++) {
      const ce = cand[x], e = ce.f, A = R[e.b];
      for (let y = x + 1; y < cand.length; y++) {
        const cf = cand[y];
        if (cf.x > ce.x + 2 * ce.r) break;
        if (!ce.own && !cf.own) continue;
        const f = cf.f, B = R[f.b];
        if (e.b === f.b || Math.abs(e.d - f.d) > Q * 1.5) continue;
        if (A.tag !== B.tag && A.tag !== 0 && B.tag !== 0) continue;
        if (e.nx * f.nx + e.ny * f.ny + e.nz * f.nz < 0.9999) continue;
        if (!faceOverlap(A, e.k, B, f.k)) continue;
        out.pairs++;
        const [sm, bg] = e.area < f.area || (e.area === f.area && e.b > f.b) ? [e, f] : [f, e];
        const ks = sm.b * 6 + sm.k * 2 + (sm.sg > 0 ? 1 : 0), kb = bg.b * 6 + bg.k * 2 + (bg.sg > 0 ? 1 : 0);
        if (act.has(ks) || act.has(kb)) { out.again.add(key); continue; }
        const S = R[sm.b], inside = boxInside(S, R[bg.b]);
        act.set(ks, { b: sm.b, k: sm.k, sg: sm.sg, delta: inside ? -Math.min(EPS_COPLANAR, S.h[sm.k] * 0.5) : EPS_COPLANAR });
      }
    }
    if (performance.now() - clock.t > clock.slice) yield;
  }
  for (const m of act.values()) {
    moves.push(m.b, m.k, m.sg, m.delta);
    const b = R[m.b]; if (!b.live) continue;
    const ax = b.a[m.k * 3], ay = b.a[m.k * 3 + 1], az = b.a[m.k * 3 + 2];
    const dx = ax * m.sg * m.delta, dy = ay * m.sg * m.delta, dz = az * m.sg * m.delta;
    b.h[m.k] += m.delta / 2; b.c[0] += dx / 2; b.c[1] += dy / 2; b.c[2] += dz / 2;
    const nx = ax * m.sg, ny = ay * m.sg, nz = az * m.sg, nk = keyOf(nx, ny, nz, Math.round((nx * b.c[0] + ny * b.c[1] + nz * b.c[2] + b.h[m.k]) / Q));
    out.again.add(nk); out.again.add(nk - 1);
  }
  out.moved = act.size;
}

function faceOverlap(A: SolveBox, ka: number, B: SolveBox, kb: number): boolean {
  const au = (ka + 1) % 3, av = (ka + 2) % 3, bu = (kb + 1) % 3, bv = (kb + 2) % 3;
  const dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1], dz = B.c[2] - A.c[2];
  return sepOk(A, au, av, B, bu, bv, A.a, au * 3, dx, dy, dz) && sepOk(A, au, av, B, bu, bv, A.a, av * 3, dx, dy, dz)
    && sepOk(A, au, av, B, bu, bv, B.a, bu * 3, dx, dy, dz) && sepOk(A, au, av, B, bu, bv, B.a, bv * 3, dx, dy, dz);
}

function sepOk(A: SolveBox, au: number, av: number, B: SolveBox, bu: number, bv: number, L: Float64Array, o: number, dx: number, dy: number, dz: number): boolean {
  const lx = L[o], ly = L[o + 1], lz = L[o + 2], a = A.a, b = B.a;
  const ra = A.h[au] * Math.abs(a[au * 3] * lx + a[au * 3 + 1] * ly + a[au * 3 + 2] * lz) + A.h[av] * Math.abs(a[av * 3] * lx + a[av * 3 + 1] * ly + a[av * 3 + 2] * lz);
  const rb = B.h[bu] * Math.abs(b[bu * 3] * lx + b[bu * 3 + 1] * ly + b[bu * 3 + 2] * lz) + B.h[bv] * Math.abs(b[bv * 3] * lx + b[bv * 3 + 1] * ly + b[bv * 3 + 2] * lz);
  return ra + rb - Math.abs(dx * lx + dy * ly + dz * lz) >= 0.01;
}

function boxInside(S: SolveBox, B: SolveBox): boolean {
  for (let c = 0; c < 8; c++) {
    let x = S.c[0], y = S.c[1], z = S.c[2];
    for (let k = 0; k < 3; k++) { const s = (c >> k) & 1 ? 1 : -1; x += S.a[k * 3] * S.h[k] * s; y += S.a[k * 3 + 1] * S.h[k] * s; z += S.a[k * 3 + 2] * S.h[k] * s; }
    for (let k = 0; k < 3; k++) { const t = (x - B.c[0]) * B.a[k * 3] + (y - B.c[1]) * B.a[k * 3 + 1] + (z - B.c[2]) * B.a[k * 3 + 2]; if (Math.abs(t) > B.h[k] + 0.001) return false; }
  }
  return true;
}
