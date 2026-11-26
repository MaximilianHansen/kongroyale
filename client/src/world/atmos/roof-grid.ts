// 2D top-of-roof heightmap for rain occlusion (streaks + puddles), rasterised from the same packed static POI
// collider boxes that interior.worker.ts uses for the 3D interior sky-visibility grid.
// Zero external imports so interior.worker.ts stays tiny (~2 KB).

/** Stride in floats per packed box: cx,cy,cz, hx,hy,hz, cosY,sinY, cosP,sinP, minX,minY,minZ, maxX,maxY,maxZ */
export const BOX_STRIDE = 16;
export const ROOF_N = 256;
export const ROOF_VS = 0.5;
export const ROOF_EMPTY = -1e4;

/** Exact top surface Y of a yaw+pitch oriented box at world (wx, wz), or ROOF_EMPTY if (wx, wz) misses it. */
export function boxTopY(
  wx: number, wz: number,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  c: number, s: number, cp: number, sp: number,
): number {
  const dx = wx - cx, dz = wz - cz;
  const lx = dx * c + dz * s;
  if (Math.abs(lx) > hx) return ROOF_EMPTY;
  const lz0 = -dx * s + dz * c;
  if (Math.abs(sp) < 1e-6) return Math.abs(lz0) <= hz ? cy + hy : ROOF_EMPTY;
  if (Math.abs(cp) < 1e-6) return Math.abs(lz0) <= hy ? cy + hz : ROOF_EMPTY;
  // ly = dy * cp - lz0 * sp in [-hy, hy]; lz = dy * sp + lz0 * cp in [-hz, hz]
  const invCp = 1 / cp;
  const a1 = (lz0 * sp - hy) * invCp, b1 = (lz0 * sp + hy) * invCp;
  const lo1 = a1 < b1 ? a1 : b1, hi1 = a1 < b1 ? b1 : a1;
  const invSp = 1 / sp;
  const a2 = (-hz - lz0 * cp) * invSp, b2 = (hz - lz0 * cp) * invSp;
  const lo2 = a2 < b2 ? a2 : b2, hi2 = a2 < b2 ? b2 : a2;
  const lo = lo1 > lo2 ? lo1 : lo2, hi = hi1 < hi2 ? hi1 : hi2;
  return lo <= hi ? cy + hi : ROOF_EMPTY;
}

/** Rasterise the highest solid collider top Y at each (x, z) cell of an n×n grid starting at (ox, oz).
 *  Uses 2×2 sub-samples per cell so thin walls and 0.45 m pitched-roof terraces leave zero pinhole leaks. */
export function rasterRoof(b: Float32Array, count: number, ox: number, oz: number, n = ROOF_N, vs = ROOF_VS): Float32Array {
  const roof = new Float32Array(n * n);
  roof.fill(ROOF_EMPTY);
  const X1 = ox + n * vs, Z1 = oz + n * vs;
  const q = vs * 0.25;
  for (let i = 0; i < count; i++) {
    const o = i * BOX_STRIDE;
    if (b[o + 13] < ox || b[o + 10] > X1 || b[o + 15] < oz || b[o + 12] > Z1) continue;
    const i0 = Math.max(0, Math.floor((b[o + 10] - ox) / vs)), i1 = Math.min(n - 1, Math.floor((b[o + 13] - ox) / vs));
    const k0 = Math.max(0, Math.floor((b[o + 12] - oz) / vs)), k1 = Math.min(n - 1, Math.floor((b[o + 15] - oz) / vs));
    const cx = b[o], cy = b[o + 1], cz = b[o + 2], hx = b[o + 3], hy = b[o + 4], hz = b[o + 5];
    const c = b[o + 6], s = b[o + 7], cp = b[o + 8], sp = b[o + 9];
    const maxBoxY = b[o + 14];
    for (let k = k0; k <= k1; k++) {
      const vz = oz + (k + 0.5) * vs;
      const row = k * n;
      for (let ii = i0; ii <= i1; ii++) {
        const idx = row + ii;
        if (roof[idx] >= maxBoxY) continue;
        const vx = ox + (ii + 0.5) * vs;
        let best = roof[idx];
        const y0 = boxTopY(vx - q, vz - q, cx, cy, cz, hx, hy, hz, c, s, cp, sp);
        if (y0 > best) best = y0;
        const y1 = boxTopY(vx + q, vz - q, cx, cy, cz, hx, hy, hz, c, s, cp, sp);
        if (y1 > best) best = y1;
        const y2 = boxTopY(vx - q, vz + q, cx, cy, cz, hx, hy, hz, c, s, cp, sp);
        if (y2 > best) best = y2;
        const y3 = boxTopY(vx + q, vz + q, cx, cy, cz, hx, hy, hz, c, s, cp, sp);
        if (y3 > best) best = y3;
        roof[idx] = best;
      }
    }
  }
  return roof;
}
