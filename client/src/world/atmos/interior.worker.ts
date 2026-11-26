// atmos interior volume worker (so interiors are not flat-lit and rain stays outside roofs): rasterises the POIs'
// static collision boxes (packed on the main thread and transferred once as a Float32Array so this worker stays ~2 KB
// instead of bundling a duplicate 900 KB copy of shared/pois) into:
//  1) a camera-centred 3D occupancy grid (2x2x2 supersamples → 0..255) for interior sky visibility / GI (when wantVol)
//  2) a camera-centred 2D top-of-roof heightmap (R32F, 256x256 @ 0.5 m = 128x128 m) for rain streak & puddle occlusion
import { BOX_STRIDE, rasterRoof } from "./roof-grid";

interface InitMsg { kind: "init"; buf: Float32Array; n: number }
interface Req {
  kind?: "build"; id: number;
  ox: number; oy: number; oz: number; nx: number; ny: number; nz: number; vs: number;
  rox: number; roz: number; rn: number; rvs: number;
  wantVol: boolean;
}

const S = BOX_STRIDE;
let B: Float32Array | null = null;
let N = 0;
let queued: Req | null = null;

function buildVol(r: Req): Uint8Array {
  const { ox, oy, oz, nx, ny, nz, vs } = r;
  const acc = new Uint8Array(nx * ny * nz);
  const X1 = ox + nx * vs, Y1 = oy + ny * vs, Z1 = oz + nz * vs;
  const b = B!;
  const q = vs * 0.25;
  for (let i = 0; i < N; i++) {
    const o = i * S;
    if (b[o + 13] < ox || b[o + 10] > X1 || b[o + 14] < oy || b[o + 11] > Y1 || b[o + 15] < oz || b[o + 12] > Z1) continue;
    const i0 = Math.max(0, Math.floor((b[o + 10] - ox) / vs)), i1 = Math.min(nx - 1, Math.floor((b[o + 13] - ox) / vs));
    const j0 = Math.max(0, Math.floor((b[o + 11] - oy) / vs)), j1 = Math.min(ny - 1, Math.floor((b[o + 14] - oy) / vs));
    const k0 = Math.max(0, Math.floor((b[o + 12] - oz) / vs)), k1 = Math.min(nz - 1, Math.floor((b[o + 15] - oz) / vs));
    const cx = b[o], cyy = b[o + 1], cz = b[o + 2], hx = b[o + 3], hy = b[o + 4], hz = b[o + 5];
    const c = b[o + 6], s = b[o + 7], cp = b[o + 8], sp = b[o + 9];
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) {
      const vx = ox + (ii + 0.5) * vs, vy = oy + (j + 0.5) * vs, vz = oz + (k + 0.5) * vs;
      let n = 0;
      for (let sz = -1; sz <= 1; sz += 2) for (let sy2 = -1; sy2 <= 1; sy2 += 2) for (let sx = -1; sx <= 1; sx += 2) {
        const dx = vx + sx * q - cx, dy = vy + sy2 * q - cyy, dz = vz + sz * q - cz;
        const lx = dx * c + dz * s, lz0 = -dx * s + dz * c;
        // pitch about the box's local X axis
        const ly = dy * cp - lz0 * sp, lz = dy * sp + lz0 * cp;
        if (Math.abs(lx) <= hx && Math.abs(ly) <= hy && Math.abs(lz) <= hz) n++;
      }
      if (n) { const idx = ii + nx * (j + ny * k); acc[idx] = Math.min(8, acc[idx] + n); }
    }
  }
  for (let i = 0; i < acc.length; i++) acc[i] = Math.min(255, acc[i] * 32);
  return acc;
}

function run(req: Req) {
  const t0 = performance.now();
  const data = req.wantVol ? buildVol(req) : null;
  const roof = rasterRoof(B!, N, req.rox, req.roz, req.rn, req.rvs);
  const transfer: Transferable[] = [roof.buffer];
  if (data) transfer.push(data.buffer);
  (self as unknown as Worker).postMessage({ id: req.id, data, roof, ms: performance.now() - t0, boxes: N }, transfer);
}

self.onmessage = (ev: MessageEvent<InitMsg | Req>) => {
  const m = ev.data;
  if (m.kind === "init") {
    B = m.buf; N = m.n;
    if (queued) { const r = queued; queued = null; run(r); }
    return;
  }
  if (!B) { queued = m; return; }
  run(m);
};
