// Interior sky visibility + 2D roof heightmap: camera-centred occupancy grid + top-of-roof heightmap of the POIs'
// static collision boxes (real window / door openings), rebuilt in a worker (interior.worker.ts) whenever the camera
// leaves the grid's inner region.
// - The AO pass (post.ts) ray-marches the 3D volume along upper-hemisphere directions for indoor sky fill.
// - The rain pass (post.ts) reads the 2D R32F roof heightmap so rain streaks and puddles stay strictly outdoors
//   (never inside houses, hangars, porches, or caves) while still raining on exposed rooftops and outside windows.
import * as THREE from "three";
import { resources } from "../../engine/res/scope";
import type { AtmosUniforms } from "./glsl";
import { BOX_STRIDE, ROOF_EMPTY, ROOF_N, ROOF_VS } from "./roof-grid";

export const INT_N = [128, 48, 128] as const;
export const INT_VS = 0.5;

export class InteriorVolume {
  readonly tex: THREE.Data3DTexture;
  readonly roofTex: THREE.DataTexture;
  private worker: Worker | null = null;
  private pending = false;
  private id = 0;
  private center = new THREE.Vector3(1e9, 0, 0);
  private hasVol = false;
  /** tools: last rebuild (ms in the worker, box count) */
  stats = { n: 0, ms: 0, boxes: 0 };

  constructor(private u: AtmosUniforms) {
    const [nx, ny, nz] = INT_N;
    const t = new THREE.Data3DTexture(new Uint8Array(nx * ny * nz), nx, ny, nz);
    t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType; t.colorSpace = THREE.NoColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = true; t.unpackAlignment = 1; t.needsUpdate = true;
    this.tex = t;
    u.uAtmIntVol.value = t;
    u.uAtmIntInv.value.set(1 / (nx * INT_VS), 1 / (ny * INT_VS), 1 / (nz * INT_VS));

    const rdata = new Float32Array(ROOF_N * ROOF_N);
    rdata.fill(ROOF_EMPTY);
    const rt = resources.root.texture("tex.world", new THREE.DataTexture(rdata, ROOF_N, ROOF_N, THREE.RedFormat, THREE.FloatType));
    rt.colorSpace = THREE.NoColorSpace;
    rt.minFilter = THREE.NearestFilter; rt.magFilter = THREE.NearestFilter;
    rt.wrapS = rt.wrapT = THREE.ClampToEdgeWrapping;
    rt.generateMipmaps = false; rt.unpackAlignment = 1; rt.needsUpdate = true;
    this.roofTex = rt;
    u.uAtmRoofMap.value = rt;

    try {
      this.worker = new Worker(new URL("./interior.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (ev: MessageEvent<{ id: number; data: Uint8Array | null; roof: Float32Array; ms: number; boxes: number }>) => this.done(ev.data);
      this.worker.onerror = (e) => { console.warn("[atmos] interior volume worker failed", e.message); this.worker = null; this.pending = false; };
      void import("../../../../shared/pois/index").then(({ allColliders }) => {
        if (!this.worker) return;
        const boxes = allColliders().filter((b) => b.surf !== "glass" && !b.noShoot && Math.min(b.h[0], b.h[1], b.h[2]) < 40);
        const S = BOX_STRIDE, n = boxes.length, buf = new Float32Array(n * S);
        for (let i = 0; i < n; i++) {
          const b = boxes[i], o = i * S, yaw = b.yaw ?? 0, pitch = b.pitch ?? 0;
          const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
          buf[o] = b.c[0]; buf[o + 1] = b.c[1]; buf[o + 2] = b.c[2];
          buf[o + 3] = b.h[0]; buf[o + 4] = b.h[1]; buf[o + 5] = b.h[2];
          buf[o + 6] = cy; buf[o + 7] = sy; buf[o + 8] = cp; buf[o + 9] = sp;
          const hzp = Math.abs(cp) * b.h[2] + Math.abs(sp) * b.h[1];
          const ex = Math.abs(cy) * b.h[0] + Math.abs(sy) * hzp, ez = Math.abs(sy) * b.h[0] + Math.abs(cy) * hzp;
          const ey = Math.abs(cp) * b.h[1] + Math.abs(sp) * b.h[2];
          buf[o + 10] = b.c[0] - ex; buf[o + 11] = b.c[1] - ey; buf[o + 12] = b.c[2] - ez;
          buf[o + 13] = b.c[0] + ex; buf[o + 14] = b.c[1] + ey; buf[o + 15] = b.c[2] + ez;
        }
        this.worker.postMessage({ kind: "init", buf, n }, [buf.buffer]);
      }, (e) => console.warn("[atmos] interior colliders load failed", e));
    } catch (e) { console.warn("[atmos] interior volume off", e); }
  }

  private req: { ox: number; oy: number; oz: number; rox: number; roz: number; wantVol: boolean } | null = null;
  /** per frame: request a re-centred grid when the camera nears the edge (xz > 14 m or y > 5 m from the centre),
   *  or when the 3D GI volume is freshly enabled */
  update(cam: THREE.Vector3, wantVol = true) {
    if (!this.worker || this.pending) return;
    const dx = cam.x - this.center.x, dz = cam.z - this.center.z, dy = cam.y - this.center.y;
    const needVolNow = wantVol && !this.hasVol;
    if (!needVolNow && Math.abs(dx) < 14 && Math.abs(dz) < 14 && (!wantVol || Math.abs(dy) < 5)) return;
    const [nx, ny, nz] = INT_N;
    // snap to 4-voxel steps (the content of a voxel never shifts sub-voxel between rebuilds)
    const g = INT_VS * 4;
    const cx = Math.round(cam.x / g) * g, cy = Math.round(cam.y / g) * g, cz = Math.round(cam.z / g) * g;
    this.req = {
      ox: cx - (nx * INT_VS) / 2, oy: cy - ny * INT_VS * 0.3, oz: cz - (nz * INT_VS) / 2,
      rox: cx - (ROOF_N * ROOF_VS) / 2, roz: cz - (ROOF_N * ROOF_VS) / 2,
      wantVol,
    };
    this.center.set(cx, cy, cz);
    this.pending = true;
    this.worker.postMessage({ id: ++this.id, ...this.req, nx, ny, nz, vs: INT_VS, rn: ROOF_N, rvs: ROOF_VS });
  }

  /** the interior sky visibility AT a point — the AO pass's interiorVis for an up-facing surface
   *  (post.ts: the straight-up probe, then 1 up + 5 rising rays marched through the grid, their sky share), on the CPU
   *  copy of the grid: what the first-person viewmodel's own pass dims the gun and hands by. 1 = outdoors. */
  visAt(p: THREE.Vector3): number {
    if (this.u.uAtmIntO.value.w < 0.5) return 1;
    const occ = (x: number, y: number, z: number) => this.occ(x, y, z);
    const px = p.x, py = p.y + 0.3, pz = p.z;
    if (occ(px, py + 1.2, pz) + occ(px, py + 3, pz) + occ(px, py + 6, pz) + occ(px, py + 10, pz) < 0.03) return 1;
    let sum = 0, ws = 0;
    for (let k = 0; k < 11; k++) {
      // the up ray + two rings of 5 (25° and 50° elevation): the shader alternates them over frames, here both at once
      const up = k === 0, se = k <= 5 ? 0.42 : 0.77, ce = Math.sqrt(1 - se * se), a = k * 1.2566371 + (k > 5 ? 0.63 : 0);
      const dx = up ? 0 : Math.cos(a) * ce, dy = up ? 1 : se, dz = up ? 0 : Math.sin(a) * ce;
      const w = dy + 0.08;
      let T = 1, t = 0.35;
      for (let s = 0; s < 10; s++) { T *= 1 - Math.min(occ(px + dx * t, py + dy * t, pz + dz * t) * 1.6, 1) * 0.9; t += 0.35 + t * 0.18; }
      sum += T * w; ws += w;
    }
    return sum / ws;
  }
  /** occupancy 0..1 at a world point (trilinear on the CPU grid, 0 outside) */
  private occ(x: number, y: number, z: number): number {
    const o = this.u.uAtmIntO.value, [nx, ny, nz] = INT_N, d = (this.tex.image as { data: Uint8Array }).data;
    const fx = (x - o.x) / INT_VS - 0.5, fy = (y - o.y) / INT_VS - 0.5, fz = (z - o.z) / INT_VS - 0.5;
    if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return 0;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz), tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const ix1 = Math.min(ix + 1, nx - 1), iy1 = Math.min(iy + 1, ny - 1), iz1 = Math.min(iz + 1, nz - 1);
    const at = (i: number, j: number, k: number) => d[i + nx * (j + ny * k)];
    const c00 = at(ix, iy, iz) * (1 - tx) + at(ix1, iy, iz) * tx, c10 = at(ix, iy1, iz) * (1 - tx) + at(ix1, iy1, iz) * tx;
    const c01 = at(ix, iy, iz1) * (1 - tx) + at(ix1, iy, iz1) * tx, c11 = at(ix, iy1, iz1) * (1 - tx) + at(ix1, iy1, iz1) * tx;
    return ((c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz) / 255;
  }

  private done(r: { id: number; data: Uint8Array | null; roof: Float32Array; ms: number; boxes: number }) {
    this.pending = false;
    if (r.id !== this.id || !this.req) return;
    if (r.data) {
      (this.tex.image as { data: Uint8Array }).data = r.data;
      this.tex.needsUpdate = true;
      this.u.uAtmIntO.value.set(this.req.ox, this.req.oy, this.req.oz, 1);
      this.hasVol = true;
    }
    (this.roofTex.image as { data: Float32Array }).data = r.roof;
    this.roofTex.needsUpdate = true;
    this.u.uAtmRoofO.value.set(this.req.rox, this.req.roz, 1 / ROOF_VS, 1);
    this.stats = { n: this.stats.n + 1, ms: Math.round(r.ms), boxes: r.boxes };
  }
}
