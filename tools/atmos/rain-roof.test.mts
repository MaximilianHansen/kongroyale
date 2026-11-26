// Verifies the 2D rain roof-heightmap (client/src/world/atmos/roof-grid.ts) on synthetic roofs (flat, rotated,
// pitched, multi-storey, open sky) AND on real enterable rooms across all 17 POIs (shared/pois/index.ts).
import { BOX_STRIDE, ROOF_EMPTY, ROOF_N, ROOF_VS, boxTopY, rasterRoof } from "../../client/src/world/atmos/roof-grid";
import { allColliders, interiorRoomsById } from "../../shared/pois/index";
import type { Box } from "../../shared/world/colliders";

function packBoxes(boxes: Box[]): Float32Array {
  const buf = new Float32Array(boxes.length * BOX_STRIDE);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i], o = i * BOX_STRIDE, yaw = b.yaw ?? 0, pitch = b.pitch ?? 0;
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
  return buf;
}

function sampleRoof(roof: Float32Array, ox: number, oz: number, x: number, z: number, n = ROOF_N, vs = ROOF_VS): number {
  const ix = Math.max(0, Math.min(n - 1, Math.floor((x - ox) / vs)));
  const iz = Math.max(0, Math.min(n - 1, Math.floor((z - oz) / vs)));
  return roof[ix + iz * n];
}

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) { console.error(`FAIL ${name}${detail ? ": " + detail : ""}`); failed++; }
  else console.log(`PASS ${name}`);
}

// 1. Flat 2-storey house: indoor floor & 2nd floor sheltered, rooftop & street exposed
{
  const boxes: Box[] = [
    { c: [0, 0, 0], h: [4, 0.15, 4], surf: "wood" },      // ground floor
    { c: [0, 3.5, 0], h: [4, 0.15, 4], surf: "wood" },    // 2nd floor
    { c: [0, 7.0, 0], h: [4.3, 0.15, 4.3], surf: "tile" }, // roof (top = 7.15)
  ];
  const ox = -32, oz = -32;
  const roof = rasterRoof(packBoxes(boxes), boxes.length, ox, oz, 128, 0.5);
  const ryIn = sampleRoof(roof, ox, oz, 0, 0, 128, 0.5);
  const ryOut = sampleRoof(roof, ox, oz, 10, 0, 128, 0.5);
  check("flat house shelters 1st & 2nd floor", Math.abs(ryIn - 7.15) < 1e-4, `ryIn=${ryIn}`);
  check("flat house leaves rooftop exposed (y=8.5 > roofY)", 8.5 > ryIn + 0.35);
  check("flat house leaves outdoor street exposed", ryOut === ROOF_EMPTY, `ryOut=${ryOut}`);
}

// 2. Pitched roof (rotated + sloped): exact analytical top Y along the slope
{
  const pitch = 0.45;
  const b: Box = { c: [0, 5.0, 0], h: [4.0, 0.2, 3.0], yaw: 0, pitch, surf: "tile" };
  const yCenter = boxTopY(0, 0, 0, 5.0, 0, 4.0, 0.2, 3.0, 1, 0, Math.cos(pitch), Math.sin(pitch));
  const yHigh = boxTopY(0, 2.0, 0, 5.0, 0, 4.0, 0.2, 3.0, 1, 0, Math.cos(pitch), Math.sin(pitch));
  const yLow = boxTopY(0, -2.0, 0, 5.0, 0, 4.0, 0.2, 3.0, 1, 0, Math.cos(pitch), Math.sin(pitch));
  const expectedCenter = 5.0 + 0.2 / Math.cos(pitch);
  check("pitched roof centre top Y exact", Math.abs(yCenter - expectedCenter) < 1e-4, `got=${yCenter} exp=${expectedCenter}`);
  check("pitched roof rises along +z slope", yHigh > yCenter + 0.5 && yLow < yCenter - 0.5, `low=${yLow} mid=${yCenter} high=${yHigh}`);
  const roof = rasterRoof(packBoxes([b]), 1, -16, -16, 64, 0.5);
  check("pitched roof rasterises above indoor head height (y=2.0)", sampleRoof(roof, -16, -16, 0, 0, 64, 0.5) > 4.5);
}

// 3. Real island POIs: verify all enterable rooms across all POIs are sheltered by their static roof colliders
{
  const boxes = allColliders().filter((b) => b.surf !== "glass" && !b.noShoot && Math.min(b.h[0], b.h[1], b.h[2]) < 40);
  const packed = packBoxes(boxes);
  const byPoi = interiorRoomsById();
  let totalRooms = 0, sheltered = 0;
  const unsheltered: string[] = [];
  for (const [poi, rooms] of Object.entries(byPoi)) {
    if (!rooms.length) continue;
    // build roof grids on demand per room cluster
    for (const r of rooms) {
      totalRooms++;
      const ox = r.x - 16, oz = r.z - 16;
      const roof = rasterRoof(packed, boxes.length, ox, oz, 64, 0.5);
      const ry = sampleRoof(roof, ox, oz, r.x, r.z, 64, 0.5);
      if (ry >= r.y + r.h - 0.5) sheltered++;
      else unsheltered.push(`${poi}:${r.id ?? "?"}@(${r.x.toFixed(1)},${r.y.toFixed(1)},${r.z.toFixed(1)}) h=${r.h} ry=${ry.toFixed(1)}`);
    }
  }
  const pct = totalRooms > 0 ? (sheltered / totalRooms) * 100 : 100;
  console.log(`POI rooms sheltered: ${sheltered}/${totalRooms} (${pct.toFixed(1)}%)`);
  if (unsheltered.length) console.log("  unsheltered rooms (e.g. open-top decks/courtyards):", unsheltered.slice(0, 10));
  check("real POI interior rooms overwhelmingly sheltered (>= 95%)", pct >= 95, `${sheltered}/${totalRooms}`);
}

// 4. Performance check: single 256×256 full-island roof-grid build cost
{
  const boxes = allColliders().filter((b) => b.surf !== "glass" && !b.noShoot && Math.min(b.h[0], b.h[1], b.h[2]) < 40);
  const packed = packBoxes(boxes);
  // Mango Market (densest village on the island)
  const t0 = performance.now();
  const roof = rasterRoof(packed, boxes.length, -128, -128, ROOF_N, ROOF_VS);
  const ms = performance.now() - t0;
  let filled = 0;
  for (let i = 0; i < roof.length; i++) if (roof[i] > ROOF_EMPTY + 1) filled++;
  console.log(`256x256 roof build: ${ms.toFixed(2)} ms (${filled} covered cells / ${roof.length})`);
  check("256x256 roof-grid build fast (< 15 ms)", ms < 15, `${ms.toFixed(2)} ms`);
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("ALL RAIN ROOF OCCLUSION CHECKS PASSED");
