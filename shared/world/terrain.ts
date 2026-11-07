// The heightfield every system stands on: rendering, water depth, vegetation scatter, POI placement, collision,
// bots and the server all sample THIS object. The API below is a contract.
import { Biome, WORLD } from "./map";
import * as dmath from "../sim/dmath";

export class Terrain {
  readonly half = WORLD.HALF;
  readonly cell = WORLD.CELL;
  /** samples per side */
  readonly res: number;

  constructor(
    /** res*res heights in metres, row-major, row = z index, col = x index; sample (i,j) sits at (-HALF + j*CELL, -HALF + i*CELL) */
    readonly heights: Float32Array,
    /** res*res Biome ids */
    readonly biome: Uint8Array,
  ) {
    this.res = Math.round(Math.sqrt(heights.length));
    if (this.res * this.res !== heights.length) throw new Error("terrain: heights is not square");
  }

  /** height at world (x, z); clamps to the grid edge. TRIANGLE-EXACT: it interpolates on the same two triangles per
   * 2 m cell that the renderer draws (client/src/world/terrain/lod.ts — diagonal alternates with the parity of the
   * global cell index: even (i + j) → (i,j)–(i+1,j+1), odd → (i,j+1)–(i+1,j)), so collision, hit-reg, vegetation and
   * props stand on exactly the ground that is drawn (bilinear would be up to ±0.25 m off the mesh). */
  height(x: number, z: number): number {
    const r = this.res, fx = (x + this.half) / this.cell, fz = (z + this.half) / this.cell;
    let j = Math.floor(fx), i = Math.floor(fz);
    if (j < 0) j = 0; else if (j > r - 2) j = r - 2;
    if (i < 0) i = 0; else if (i > r - 2) i = r - 2;
    const tx = Math.min(1, Math.max(0, fx - j)), tz = Math.min(1, Math.max(0, fz - i));
    const h = this.heights, k = i * r + j;
    const h00 = h[k], h01 = h[k + 1], h10 = h[k + r], h11 = h[k + r + 1];
    if (((i + j) & 1) === 0) {
      return tx >= tz ? h00 + (h01 - h00) * tx + (h11 - h01) * tz : h00 + (h10 - h00) * tz + (h11 - h10) * tx;
    }
    return tx + tz <= 1 ? h00 + (h01 - h00) * tx + (h10 - h00) * tz : h11 + (h10 - h11) * (1 - tx) + (h01 - h11) * (1 - tz);
  }

  /** unit surface normal at (x, z), written into `out` ([x, y, z]) */
  normal(x: number, z: number, out: number[] | Float32Array = [0, 1, 0]): number[] | Float32Array {
    const e = this.cell;
    const dx = this.height(x + e, z) - this.height(x - e, z);
    const dz = this.height(x, z + e) - this.height(x, z - e);
    const nx = -dx, ny = 2 * e, nz = -dz, l = dmath.hypot3(nx, ny, nz);
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
  }

  /** nearest-sample biome id at (x, z) */
  biomeAt(x: number, z: number): Biome {
    const r = this.res;
    const j = Math.min(r - 1, Math.max(0, Math.round((x + this.half) / this.cell)));
    const i = Math.min(r - 1, Math.max(0, Math.round((z + this.half) / this.cell)));
    return this.biome[i * r + j] as Biome;
  }

  /** world position of sample (i, j) */
  sampleX(j: number) { return -this.half + j * this.cell; }
  sampleZ(i: number) { return -this.half + i * this.cell; }
}
