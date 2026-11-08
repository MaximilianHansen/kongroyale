// PEEL HARBOR — small white fuel-tank farm (three white cylindrical tanks with welded strakes, low cone roofs,
// yellow top railings + caged ladders, pipe manifold, concrete bund wall, pump house, a pipe rack running to the
// warehouses). Layout: TANKS / TANK_BUND / PUMP_HOUSE / PIPE_RACK in shared/pois/peel-harbor.ts.
import * as THREE from "three";
import { APRON_Y, PIPE_RACK, PUMP_HOUSE, PUMP_SETS, PUMP_Z, TANKS, TANK_BUND, TANK_TIERS, pumpHousePieces, pumpRiser, tankEntries, tankStairPieces } from "../../../../../shared/pois/peel-harbor";
import { drawPieces, roomMats } from "../_kit/harbor-rooms";
import { Builder, type V3, mergeCasters } from "../_kit/harbor-geo";
import { paint, weather, type HarborMats } from "../_kit/harbor-materials";
import { canvas, edgeShade, paintNoise, rng, splotches, stencilText, tex } from "../_kit/harbor-paint";
import type { Part } from "./parts";
import { harborFarProxy } from "./far";

/** one non-repeating wrap texture per tank (u = around, v = up): clean white paint, weld seams, a few rust runs from
 *  the roof rim + nozzles, dust at the foot, a painted tank number. (A tiled streak paint repeats ~12× around
 *  and 3× up each tank and reads as two barcode bands.) */
function tankSkin(idx: number, circumference: number, h: number): THREE.MeshStandardMaterial {
  const W = 2048, H = 512;
  const [el, c] = canvas(W, H);
  c.fillStyle = "#f1efe8"; c.fillRect(0, 0, W, H);
  paintNoise(c, 0, 0, W, H, { seed: 600 + idx, scale: 900, alpha: 0.1, blend: "overlay" });
  // horizontal weld seams every 2.1 m (+ staggered vertical butts)
  const R = rng(610 + idx), pxm = H / h;
  for (let y = 2.4; y < h; y += 2.1) {
    const py = H - y * pxm;
    c.fillStyle = "rgba(120,115,105,0.35)"; c.fillRect(0, py, W, 2); c.fillStyle = "rgba(255,255,255,0.5)"; c.fillRect(0, py + 2, W, 1);
    for (let x = R() * 200; x < W; x += W / 8) { c.fillStyle = "rgba(120,115,105,0.25)"; c.fillRect(x, py, 2, 2.1 * pxm); }
  }
  // rust runs from the roof rim (top) and below the nozzle side, sparse and irregular
  // rain streaks from the roof rim: many thin grey-brown runs + a few rust runs
  for (let i = 0; i < 90; i++) {
    const x = R() * W, len = H * (0.05 + R() ** 1.5 * 0.55), w = 2 + R() * 5;
    const g = c.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, "rgba(120,112,98,0.35)"); g.addColorStop(1, "rgba(120,112,98,0)");
    c.fillStyle = g; c.fillRect(x, 0, w, len);
  }
  const runs = 7 + Math.floor(R() * 5);
  for (let i = 0; i < runs; i++) {
    const x = R() * W, len = H * (0.08 + R() * 0.35), w = 3 + R() * 6;
    const g = c.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, "rgba(140,78,38,0.55)"); g.addColorStop(1, "rgba(140,78,38,0)");
    c.fillStyle = g; c.fillRect(x, 0, w, len);
  }
  edgeShade(c, 0, 0, W, H, { size: H * 0.18, color: "rgba(150,135,110,1)", alpha: 0.5, sides: ["bottom"], blend: "multiply" });
  splotches(c, 0, H * 0.8, W, H * 0.2, { n: 40, rMin: 6, rMax: 26, color: "rgba(140,125,100,1)", alpha: 0.35, seed: 620 + idx, blend: "multiply" });
  // a yellow product band + BANANA CO. (the only signage allowed) centred at u = 0.2 of the wrap (the lathe angle that
  // faces the view camera + the yard, south-east in harbor-local terms)
  c.fillStyle = "#f2b92a"; c.fillRect(0, H * 0.47, W, 16);
  stencilText(c, "BANANA CO.", W * 0.2, H * 0.43, { size: 64, color: "#2b2a28", align: "center", weight: 800, letterSpacing: 6 });
  const map = tex(el, { aniso: 8 });
  map.wrapS = THREE.RepeatWrapping; map.wrapT = THREE.ClampToEdgeWrapping;
  // (LatheGeometry: u grows with phi, which runs left → right seen from outside — a POSITIVE repeat reads correctly;
  // a −1 repeat mirrors the stencil into "IVT" garble)
  map.repeat.set(1 / circumference, 1 / h);
  const m = weather(new THREE.MeshStandardMaterial({ map, roughness: 0.42, metalness: 0.05, name: `tank-skin-${idx}` }), { grime: 0.3, grimeY: 3.6, grimeH: 2.0, vary: 0.04, grimeColor: "#8a7a5e" });
  return m;
}

function tank(b: Builder, m: HarborMats, x: number, z: number, r: number, h: number, idx: number) {
  const y0 = APRON_Y;
  // shell + base ring + strakes (weld seams as slight steps) + cone roof
  b.lathe(m.concrete, [[r + 0.5, 0], [r + 0.5, 0.35], [r - 0.2, 0.35]], 40, new THREE.Matrix4().makeTranslation(x, y0, z));
  const prof: Array<[number, number]> = [[r, 0.35]];
  for (let y = 2.4; y < h; y += 2.1) { prof.push([r, y - 0.02], [r + 0.025, y], [r + 0.025, y + 0.08], [r, y + 0.1]); }
  prof.push([r, h], [r + 0.08, h + 0.05], [r + 0.08, h + 0.22]);
  b.lathe(tankSkin(idx, Math.PI * 2 * (r + 0.08), h + 0.3), prof, 48, new THREE.Matrix4().makeTranslation(x, y0, z));
  b.lathe(m.tankWhite, [[r + 0.08, h + 0.22], [r * 0.5, h + 0.9], [0.9, h + 1.25], [0.001, h + 1.3]], 48, new THREE.Matrix4().makeTranslation(x, y0, z));
  // roof vent + hatch
  b.cyl(m.galv, [x, y0 + h + 1.25, z], [x, y0 + h + 1.9, z], 0.35, 10);
  b.cyl(m.galv, [x, y0 + h + 1.9, z], [x, y0 + h + 2.05, z], 0.55, 10);
  b.box(m.galv, [x + r * 0.55, y0 + h + 0.95, z], [0.8, 0.2, 0.8], { bevel: 0.04 });
  // top railing (yellow) around the rim — open where the stair landing / the bridges come in (same chords as the colliders)
  const Y = m.yellowPaint, n = 24, rr = r - 0.15, ent = tankEntries(idx), yr = y0 + h + TANK_TIERS(TANKS[idx])[0][1];
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
    if (ent.some((e) => Math.abs(Math.atan2(Math.sin(am - e), Math.cos(am - e))) < 0.3)) continue;
    const p0: V3 = [x + Math.cos(a0) * rr, yr, z + Math.sin(a0) * rr], p1: V3 = [x + Math.cos(a1) * rr, yr, z + Math.sin(a1) * rr];
    for (const p of [p0, p1]) b.cyl(Y, p, [p[0], p[1] + 1.05, p[2]], 0.03, 5, { caps: false });
    for (const hh of [1.05, 0.55]) b.cyl(Y, [p0[0], p0[1] + hh, p0[2]], [p1[0], p1[1] + hh, p1[2]], 0.035, 5);
    b.cyl(Y, [p0[0], p0[1] + 0.05, p0[2]], [p1[0], p1[1] + 0.05, p1[2]], 0.05, 4);
  }
  // (no caged ladders — the tanks are climbed by the stair behind them + the roof bridges)
  // outlet nozzle + valve toward the manifold (east)
  const nx = x + (r + 0.8), ny = y0 + 1.2;
  b.cyl(m.galv, [x + r - 0.1, ny, z], [nx, ny, z], 0.25, 12);
  b.cyl(m.redPaint, [nx - 0.1, ny, z], [nx + 0.15, ny, z], 0.4, 12);
  for (const fx of [x + r + 0.15, nx - 0.2, nx + 0.25]) b.cyl(m.galv, [fx - 0.04, ny, z], [fx + 0.04, ny, z], 0.34, 12);
  b.cyl(m.yellowPaint, [nx + 0.02, ny, z], [nx + 0.02, ny + 0.6, z], 0.03, 5);
  b.add(m.redPaint, new THREE.TorusGeometry(0.28, 0.03, 6, 18).rotateX(Math.PI / 2), new THREE.Matrix4().makeTranslation(nx + 0.02, ny + 0.64, z));
  for (let k = 0; k < 3; k++) { const a = k * Math.PI / 1.5; b.cyl(m.redPaint, [nx + 0.02, ny + 0.64, z], [nx + 0.02 + Math.cos(a) * 0.27, ny + 0.64, z + Math.sin(a) * 0.27], 0.015, 4, { caps: false }); }
}

/** a horizontal end-suction centrifugal pump set on its skid — finned motor (green) with a
 *  terminal box + conduit, a yellow coupling guard, a red cast volute with a suction leg down into the floor and the
 *  discharge riser (check valve, gate valve + hand wheel, pressure gauge) up through the roof to the pipe rack */
function pumpSet(b: Builder, m: HarborMats, i: number) {
  const P = PUMP_HOUSE, X = P.x + PUMP_SETS[i], Y = APRON_Y, Z = P.z + PUMP_Z;
  const motor = paint("#3f7d5a", { rough: 0.45, grime: 0.3, name: "pump-motor-green" }), cast = paint("#a83a2a", { rough: 0.55, grime: 0.4, name: "pump-volute-red" });
  const D = m.darkPaint, S = m.steel, G = m.galv;
  // skid: two channels + cross members on a plinth
  b.box(m.concrete, [X, Y + 0.05, Z], [2.1, 0.1, 1.0], { bevel: 0.02 });
  for (const dz of [-0.36, 0.36]) b.box(D, [X, Y + 0.16, Z + dz], [2.0, 0.12, 0.1]);
  for (const dx of [-0.9, 0, 0.9]) b.box(D, [X + dx, Y + 0.16, Z], [0.08, 0.1, 0.7]);
  // motor: finned housing, end bell, fan cowl, feet, terminal box + flexible conduit into the floor
  const my = Y + 0.6, mx0 = X - 0.95, mx1 = X + 0.05;
  for (const dz of [-0.24, 0.24]) b.box(motor, [X - 0.45, Y + 0.3, Z + dz], [0.7, 0.16, 0.12]);
  b.cyl(motor, [mx0 + 0.18, my, Z], [mx1 - 0.08, my, Z], 0.3, 20);
  for (let k = 0; k < 9; k++) { const x = mx0 + 0.24 + k * 0.075; b.cyl(motor, [x - 0.012, my, Z], [x + 0.012, my, Z], 0.335, 20); }
  b.cyl(D, [mx0, my, Z], [mx0 + 0.2, my, Z], 0.31, 20, { r1: 0.27 });
  for (let k = 0; k < 6; k++) b.box(G, [mx0 - 0.005, my - 0.18 + k * 0.07, Z], [0.01, 0.025, 0.4]);
  b.cyl(S, [mx1 - 0.08, my, Z], [mx1 + 0.08, my, Z], 0.24, 16);
  b.box(motor, [X - 0.45, my + 0.36, Z + 0.12], [0.26, 0.16, 0.24], { bevel: 0.02 });
  b.tube(D, [[X - 0.45, my + 0.42, Z + 0.25], [X - 0.45, my + 0.5, Z + 0.45], [X - 0.45, Y + 0.3, Z + 0.5], [X - 0.45, Y + 0.02, Z + 0.52]], 0.025, 6, { samples: 12 });
  // coupling guard + bearing frame
  b.cyl(m.yellowPaint, [X + 0.06, my, Z], [X + 0.32, my, Z], 0.17, 16);
  b.box(D, [X + 0.33, Y + 0.38, Z], [0.2, 0.36, 0.34]);
  b.cyl(S, [X + 0.32, my, Z], [X + 0.42, my, Z], 0.12, 12);
  // volute casing: a fat disc with a bolt ring, suction eye + reducer bending down into the floor
  const vx = X + 0.55, vy = Y + 0.56;
  b.cyl(cast, [vx - 0.14, vy, Z], [vx + 0.14, vy, Z], 0.36, 24);
  b.cyl(cast, [vx - 0.17, vy, Z], [vx - 0.13, vy, Z], 0.39, 24);
  for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2; b.cyl(S, [vx - 0.19, vy + Math.cos(a) * 0.36, Z + Math.sin(a) * 0.36], [vx - 0.15, vy + Math.cos(a) * 0.36, Z + Math.sin(a) * 0.36], 0.018, 6); }
  b.cyl(cast, [vx + 0.14, vy, Z], [vx + 0.32, vy, Z], 0.16, 16, { r1: 0.2 });
  b.cyl(G, [vx + 0.32, vy, Z], [vx + 0.38, vy, Z], 0.24, 16);
  b.tube(G, [[vx + 0.38, vy, Z], [vx + 0.6, vy, Z], [vx + 0.72, vy - 0.2, Z], [vx + 0.74, Y - 0.05, Z]], 0.16, 14, { samples: 16 });
  b.cyl(G, [vx + 0.74, Y + 0.02, Z], [vx + 0.74, Y + 0.1, Z], 0.26, 16);
  // discharge riser (shared pumpRiser = the collider): flanges, check valve, gate valve + hand wheel, gauge; through the
  // roof, over it on sleepers, to the pipe rack's end
  const [a, bb, c, d] = pumpRiser(i).map(([x, y, z]) => [P.x + x, Y + y, P.z + z] as V3);
  const sx = Math.sign(c[0] - bb[0]) || 1;
  b.cyl(G, [a[0], vy + 0.3, a[2]], [bb[0], bb[1] - 0.29, bb[2]], 0.15, 14);
  b.tube(G, [[bb[0], bb[1] - 0.3, bb[2]], [bb[0], bb[1], bb[2]], [bb[0] + sx * 0.3, bb[1], bb[2]]], 0.15, 14, { samples: 10 });
  if (Math.abs(c[0] - bb[0]) > 0.6) b.cyl(G, [bb[0] + sx * 0.29, c[1], c[2]], [c[0] - sx * 0.29, c[1], c[2]], 0.15, 14);
  b.tube(G, [[c[0] - sx * 0.3, c[1], c[2]], [c[0], c[1], c[2]], [c[0], c[1], c[2] + 0.3]], 0.15, 14, { samples: 10 });
  b.cyl(G, [c[0], c[1], c[2] + 0.29], [d[0], d[1], d[2]], 0.15, 14);
  for (const fy of [Y + 1.25, Y + 2.6, Y + 3.7]) b.cyl(S, [a[0], fy - 0.03, a[2]], [a[0], fy + 0.03, a[2]], 0.22, 14);
  b.box(D, [a[0], Y + 1.45, a[2]], [0.34, 0.3, 0.34], { bevel: 0.04 });
  b.box(cast, [a[0], Y + 1.95, a[2]], [0.36, 0.34, 0.36], { bevel: 0.05 });
  b.cyl(m.yellowPaint, [a[0], Y + 1.95, a[2] - 0.18], [a[0], Y + 1.95, a[2] - 0.5], 0.03, 6);
  b.add(m.redPaint, new THREE.TorusGeometry(0.2, 0.025, 6, 18), new THREE.Matrix4().makeTranslation(a[0], Y + 1.95, a[2] - 0.52));
  for (let k = 0; k < 3; k++) { const ang = k * Math.PI / 1.5; b.cyl(m.redPaint, [a[0], Y + 1.95, a[2] - 0.52], [a[0] + Math.cos(ang) * 0.19, Y + 1.95 + Math.sin(ang) * 0.19, a[2] - 0.52], 0.012, 4, { caps: false }); }
  b.cyl(S, [a[0], Y + 1.15, a[2] - 0.15], [a[0], Y + 1.15, a[2] - 0.32], 0.02, 6);
  b.cyl(D, [a[0], Y + 1.15, a[2] - 0.32], [a[0], Y + 1.15, a[2] - 0.38], 0.09, 16);
  b.cyl(m.whitePaint, [a[0], Y + 1.15, a[2] - 0.385], [a[0], Y + 1.15, a[2] - 0.39], 0.075, 16);
  // roof sleepers under the run every ~1.2 m + the roof penetration collar
  const roof = Y + P.h + 0.25;
  const run = (p0: V3, p1: V3) => { const L = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]), n = Math.max(1, Math.round(L / 1.2)); for (let k = 0; k <= n; k++) { const t = k / n, x = p0[0] + (p1[0] - p0[0]) * t, z = p0[2] + (p1[2] - p0[2]) * t; if (Math.abs(z - P.z) > P.d / 2 - 0.1) continue; b.box(m.concrete, [x, (roof + p0[1] - 0.15) / 2, z], [0.34, p0[1] - 0.15 - roof, 0.34], { bevel: 0.03 }); b.box(S, [x, p0[1] - 0.14, z], [0.36, 0.03, 0.36]); } };
  run(bb, c); run(c, [c[0], c[1], P.z + P.d / 2 - 0.2]);
  b.cyl(D, [bb[0], roof, bb[2]], [bb[0], roof + 0.25, bb[2]], 0.24, 14, { r1: 0.18 });
}

export const part: Part = {
  id: "tanks",
  async build({ ctx, mats, group, lod, c1 }) {
    const b = new Builder(true);
    for (const [i, t] of TANKS.entries()) { tank(b, mats, t.x, t.z, t.r, t.h, i); await ctx.yield(); }
    // bund wall (low concrete) with a gap on the east side for access
    const B = TANK_BUND, bh = B.h, bt = 0.35, y = APRON_Y + bh / 2;
    b.box(mats.concrete, [(B.x0 + B.x1) / 2, y, B.z0], [B.x1 - B.x0, bh, bt], { bevel: 0.05 });
    b.box(mats.concrete, [(B.x0 + B.x1) / 2, y, B.z1], [B.x1 - B.x0, bh, bt], { bevel: 0.05 });
    b.box(mats.concrete, [B.x0, y, (B.z0 + B.z1) / 2], [bt, bh, B.z1 - B.z0], { bevel: 0.05 });
    const gz = (B.z0 + B.z1) / 2;
    b.box(mats.concrete, [B.x1, y, (B.z0 + gz - 2) / 2], [bt, bh, gz - 2 - B.z0], { bevel: 0.05 });
    b.box(mats.concrete, [B.x1, y, (gz + 2 + B.z1) / 2], [bt, bh, B.z1 - gz - 2], { bevel: 0.05 });
    // manifold header along the east inside of the bund
    b.cyl(mats.galv, [B.x1 - 1.2, APRON_Y + 1.2, B.z0 + 2], [B.x1 - 1.2, APRON_Y + 1.2, B.z1 - 2], 0.3, 12);
    for (let zz = B.z0 + 4; zz < B.z1 - 2; zz += 6) b.box(mats.darkPaint, [B.x1 - 1.2, APRON_Y + 0.55, zz], [0.5, 1.1, 0.4]);
    // pump house (a real room — door, windows, pumps + panel inside, a stair to the roof: shared pieces = colliders)
    drawPieces(b, pumpHousePieces(), roomMats(mats));
    for (let i = 0; i < PUMP_SETS.length; i++) pumpSet(b, mats, i);
    await ctx.yield();
    drawPieces(b, tankStairPieces(), roomMats(mats));
    // pipe rack: portal frames every ~6 m carrying three pipes
    const rackMat = paint("#8d9296", { rough: 0.5, name: "rack-steel" });
    const pts = PIPE_RACK.pts, ry = APRON_Y + PIPE_RACK.y;
    const pipeMats = [mats.yellowPaint, mats.galv, paint("#b9bdbf", { name: "pipe-silver" })];
    for (let i = 0; i < pts.length - 1; i++) {
      await ctx.yield();
      const [ax, az] = pts[i], [cx, cz] = pts[i + 1], len = Math.hypot(cx - ax, cz - az), n = Math.max(1, Math.round(len / 6));
      const ux = (cx - ax) / len, uz = (cz - az) / len, px = -uz, pz = ux;
      for (let k = 0; k <= n; k++) {
        const fx = ax + (cx - ax) * (k / n), fz = az + (cz - az) * (k / n);
        for (const s of [-1, 1]) b.box(rackMat, [fx + px * s * 1.1, APRON_Y + ry / 2 - APRON_Y / 2, fz + pz * s * 1.1], [0.25, ry - APRON_Y, 0.25]);
        b.beam(rackMat, [fx - px * 1.3, ry, fz - pz * 1.3], [fx + px * 1.3, ry, fz + pz * 1.3], 0.25, 0.3);
        b.box(mats.concrete, [fx, APRON_Y + 0.15, fz], [Math.abs(px) * 2.6 + 0.6, 0.3, Math.abs(pz) * 2.6 + 0.6]);
      }
      pipeMats.forEach((pm, j) => {
        const off = (j - 1) * 0.7, r0 = j === 1 ? 0.28 : 0.2;
        b.cyl(pm, [ax - ux * 0.3 + px * off, ry + 0.4, az - uz * 0.3 + pz * off], [cx + ux * 0.3 + px * off, ry + 0.4, cz + uz * 0.3 + pz * off], r0, 10);
        // flanges every 6 m + a gate valve with a hand wheel mid-run
        for (let t = 3; t < len; t += 6) { const fx = ax + ux * t + px * off, fz = az + uz * t + pz * off; b.cyl(mats.galv, [fx - ux * 0.05, ry + 0.4, fz - uz * 0.05], [fx + ux * 0.05, ry + 0.4, fz + uz * 0.05], r0 + 0.07, 10); }
        const vx = ax + ux * len * 0.5 + px * off, vz = az + uz * len * 0.5 + pz * off;
        b.box(mats.darkPaint, [vx, ry + 0.4, vz], [0.5, 0.55, 0.5], { bevel: 0.05 });
        b.cyl(mats.galv, [vx, ry + 0.65, vz], [vx, ry + 1.0, vz], 0.04, 6);
        b.add(mats.redPaint, new THREE.TorusGeometry(0.22, 0.025, 6, 16).rotateX(Math.PI / 2), new THREE.Matrix4().makeTranslation(vx, ry + 1.02, vz));
      });
    }
    // bund slab (the farm sits partly beyond the apron on the pad)
    b.box(mats.concrete, [(B.x0 + B.x1) / 2, APRON_Y - 0.6, (B.z0 + B.z1) / 2], [B.x1 - B.x0 + 2, 1.2, B.z1 - B.z0 + 2], { bevel: 0.08 });
    const farm = await b.buildAsync("tank-farm", { palette: (m) => !/^tank-skin|^concrete$|^room-/.test(m.name) && !m.transparent }, () => ctx.yield());
    group.add(farm);
    const far = harborFarProxy({ tanks: true, name: "tank-farm-far" });
    group.add(far);
    // the tank farm is a landmark of the poi-01 view (tall white tanks behind the yellow shed, ~230 m out).
    // (a 330 m cut to the flat-palette proxy was a visible pop on every fly-in — tank shading
    // changed and 6 meshes appeared in one frame. The full model is RESIDENT; the proxy is only the cascade-1 /
    // far-map caster, so the shadows do not switch either. ~5 draws while the harbor is in view.)
    far.userData.c1Shadow = false; c1.push(far);
    mergeCasters(farm, { farShadow: false, c1: false });
    lod.pair(farm, far, 330);
  },
};
