// PEEL HARBOR — two ship-to-shore gantry cranes (tall ripe-yellow STS cranes with lattice legs, truss girder
// reaching over the ship, A-frame apex + stay bars, machinery house on the backreach, trolley + hanging cab, a blue
// container on the spreader). Every number comes from CRANE in shared/pois/peel-harbor.ts; the switchback stair +
// girder walkway match the colliders (craneStair) so kongs can climb to the sniper perch.
import * as THREE from "three";
import { APRON_Y, CRANE, cabStairTop, craneStair, craneStairGap, cranePieces } from "../../../../../shared/pois/peel-harbor";
import { drawPieces, roomMats } from "../_kit/harbor-rooms";
import { Builder, type V3, mergeCasters } from "../_kit/harbor-geo";
import { weather, type HarborMats } from "../_kit/harbor-materials";
import type { Part } from "./parts";
import { flag } from "../../../flags";

const C = CRANE;

let craneYellow: THREE.MeshStandardMaterial | null = null;
/** the crane's own yellow: the harbor paint + salt-air weathering — rust + grime runs weeping down every member
 *  (world-space streaks), grime gradient up from the sill, stronger tone variation (never flat orange planes) */
function cranePaint(m: HarborMats): THREE.MeshStandardMaterial {
  if (craneYellow) return craneYellow;
  const src = m.yellowPaint;
  craneYellow = weather(new THREE.MeshStandardMaterial({ map: src.map, roughnessMap: src.roughnessMap, normalMap: src.normalMap, normalScale: new THREE.Vector2(0.45, 0.45), roughness: src.roughness, metalness: src.metalness }), { vary: 0.2, grime: 0.42, grimeY: APRON_Y + 0.5, grimeH: 7, grimeColor: "#7a5a2e", streak: 0.5, streakColor: "#6b4418" });
  craneYellow.name = "yellowPaint"; // stays textured through the palette merge
  return craneYellow;
}

/** lattice box column from y0 to y1 centred at (x, z), width w */
function latticeLeg(b: Builder, m: HarborMats, x: number, z: number, y0: number, y1: number, w: number) {
  const ch = 0.36, o = w / 2 - ch / 2;
  const Y = cranePaint(m);
  // solid shoe + cap
  b.box(Y, [x, y0 + 0.8, z], [w + 0.2, 1.6, w + 0.2], { bevel: 0.08 });
  b.box(Y, [x, y1 - 0.9, z], [w + 0.1, 1.8, w + 0.1], { bevel: 0.08 });
  // chords
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(Y, [x + sx * o, (y0 + y1) / 2, z + sz * o], [ch, y1 - y0, ch]);
  // panels: X bracing on all four faces + battens (3.6 m panels, no bolt heads — half the lattice tris)
  const ya = y0 + 1.6, yb = y1 - 1.8, n = Math.max(2, Math.round((yb - ya) / 3.6)), h = (yb - ya) / n;
  for (let k = 0; k < n; k++) {
    const p0 = ya + k * h, p1 = p0 + h;
    for (const [fx, fz, ax] of [[1, 0, "z"], [-1, 0, "z"], [0, 1, "x"], [0, -1, "x"]] as Array<[number, number, "x" | "z"]>) {
      const cx = x + fx * o, cz = z + fz * o;
      const a0: V3 = ax === "z" ? [cx, p0, z - o] : [x - o, p0, cz], a1: V3 = ax === "z" ? [cx, p1, z + o] : [x + o, p1, cz];
      const c0: V3 = ax === "z" ? [cx, p0, z + o] : [x + o, p0, cz], c1: V3 = ax === "z" ? [cx, p1, z - o] : [x - o, p1, cz];
      b.beam(Y, a0, a1, 0.16, 0.1);
      b.beam(Y, c0, c1, 0.16, 0.1);
      b.box(Y, [(a0[0] + c0[0]) / 2, p0, (a0[2] + c0[2]) / 2], ax === "z" ? [0.12, 0.18, 2 * o] : [2 * o, 0.18, 0.12]);
    }
    // splice flanges on the four chords at every panel joint (a proud collar)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(Y, [x + sx * o, p0, z + sz * o], [ch + 0.12, 0.14, ch + 0.12]);
  }
  // ladder rungs up the inside face
}

/** truss girder side (in the plane z = zc) from x0 to x1, band y0..y1 */
function trussSide(b: Builder, m: HarborMats, x0: number, x1: number, y0: number, y1: number, zc: number, w: number) {
  const Y = cranePaint(m);
  const chH = 0.75;
  b.box(Y, [(x0 + x1) / 2, y1 - chH / 2, zc], [x1 - x0, chH, w], { bevel: 0.07 });
  b.box(Y, [(x0 + x1) / 2, y0 + chH / 2, zc], [x1 - x0, chH, w], { bevel: 0.07 });
  const n = Math.round((x1 - x0) / 3.2), dx = (x1 - x0) / n;
  for (let i = 0; i <= n; i++) {
    const x = x0 + i * dx;
    b.box(Y, [x, (y0 + y1) / 2, zc], [0.34, y1 - y0 - 2 * chH + 0.1, w * 0.72]);
    if (i < n) {
      const up = i % 2 === 0;
      b.beam(Y, [x, up ? y0 + chH : y1 - chH, zc], [x + dx, up ? y1 - chH : y0 + chH, zc], 0.3, w * 0.62);
    }
  }
}

function railing(b: Builder, m: HarborMats, pts: V3[], h = 1.1, post = 1.6, mat?: THREE.Material) {
  const R = mat ?? cranePaint(m);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], c = pts[i + 1], len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), n = Math.max(1, Math.round(len / post));
    for (let k = 0; k <= n; k++) {
      if (k === n && i < pts.length - 2) continue;
      const t = k / n, p: V3 = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
      b.cyl(R, p, [p[0], p[1] + h, p[2]], 0.035, 6, { caps: false });
    }
  }
  for (const hh of [h, h * 0.5]) b.rail(R, pts.map((p) => [p[0], p[1] + hh, p[2]] as V3), 0.032, 6);
}

async function buildCrane(b: Builder, m: HarborMats, cz: number, idx: number, kit: { add(p: import("../../../../../shared/pois/harbor-kit").ContainerPlacement): unknown }, y: () => Promise<void>) {
  const Y = cranePaint(m), D = m.darkPaint, S = m.steel;
  const gz = C.girderHalfZ, gw = 1.25;
  // ---------------- bogies + sill beams (per rail)
  for (const rx of [C.railLand, C.railSea]) {
    const sillY0 = C.sillTop - 1.3;
    b.box(Y, [rx, (sillY0 + C.sillTop) / 2, cz], [1.7, C.sillTop - sillY0, 2 * C.legHalfZ + 5.4], { bevel: 0.1 });
    // vertical stiffeners + a plate seam line along the sill beam faces
    for (let z = cz - C.legHalfZ - 2.2; z <= cz + C.legHalfZ + 2.2; z += 1.4) for (const sx of [-1, 1]) b.box(Y, [rx + sx * 0.87, (sillY0 + C.sillTop) / 2, z], [0.06, C.sillTop - sillY0 - 0.12, 0.1]);
    for (const sx of [-1, 1]) b.box(D, [rx + sx * 0.86, sillY0 + 0.45, cz], [0.02, 0.03, 2 * C.legHalfZ + 5]);
    // hazard end plates
    for (const e of [-1, 1]) b.box(m.hazard, [rx, (sillY0 + C.sillTop) / 2, cz + e * (C.legHalfZ + 2.72)], [1.72, C.sillTop - sillY0 - 0.1, 0.06]);
    // bogie groups: 2 per end, each an equaliser + 2 wheel trucks
    for (const e of [-1, 1]) {
      const ze = cz + e * (C.legHalfZ + 0.6);
      b.box(D, [rx, sillY0 - 0.35, ze], [1.4, 0.7, 4.6], { bevel: 0.08 });
      for (const tz of [-1.25, 1.25]) {
        b.box(Y, [rx, APRON_Y + 0.95, ze + tz], [1.3, 0.8, 2.1], { bevel: 0.08 });
        for (const wz of [-0.55, 0.55]) {
          b.cyl(S, [rx - 0.45, APRON_Y + 0.56, ze + tz + wz], [rx + 0.45, APRON_Y + 0.56, ze + tz + wz], 0.43, 10);
          b.cyl(D, [rx - 0.62, APRON_Y + 0.56, ze + tz + wz], [rx + 0.62, APRON_Y + 0.56, ze + tz + wz], 0.12, 8);
        }
        // motor + gearbox on the outside
        b.box(D, [rx + (rx === C.railLand ? -0.95 : 0.95), APRON_Y + 1.0, ze + tz], [0.6, 0.6, 1.0], { bevel: 0.08 });
      }
      // rail clamp + storm pin
      b.box(Y, [rx, APRON_Y + 0.4, cz + e * (C.legHalfZ + 3.6)], [0.9, 0.8, 0.8], { bevel: 0.08 });
    }
  }
  // cable reel drum on the land sill (a big drum on the side)
  {
    const rz = cz + (idx === 0 ? 1 : -1) * 3;
    b.cyl(D, [C.railLand - 1.1, C.sillTop - 0.3, rz], [C.railLand - 2.3, C.sillTop - 0.3, rz], 1.35, 24);
    b.cyl(m.rubber, [C.railLand - 1.25, C.sillTop - 0.3, rz], [C.railLand - 2.15, C.sillTop - 0.3, rz], 1.2, 24);
    b.box(Y, [C.railLand - 1.7, C.sillTop - 1.3, rz], [1.5, 1.0, 0.5]);
  }
  await y();
  // ---------------- legs (lattice)
  for (const rx of [C.railLand, C.railSea]) for (const sz of [-1, 1]) latticeLeg(b, m, rx, cz + sz * C.legHalfZ, C.sillTop, C.portalY - 0.2, C.legW);
  // portal beams along z (top of each rail's leg pair) + mid ties + knee braces
  for (const rx of [C.railLand, C.railSea]) {
    b.box(Y, [rx, C.portalY - 1.0, cz], [1.6, 2.0, 2 * C.legHalfZ + C.legW], { bevel: 0.1 });
    for (let z = cz - C.legHalfZ + 1.2; z < cz + C.legHalfZ - 0.8; z += 1.5) for (const sx of [-1, 1]) b.box(Y, [rx + sx * 0.82, C.portalY - 1.0, z], [0.06, 1.8, 0.09]);
    b.box(Y, [rx, 17, cz], [0.9, 0.9, 2 * C.legHalfZ - C.legW], { bevel: 0.06 });
    for (const sz of [-1, 1]) b.beam(Y, [rx, C.portalY - 6.5, cz + sz * (C.legHalfZ - 0.9)], [rx, C.portalY - 1.9, cz + sz * 1.2], 0.55, 0.55, { bevel: 0.05 });
  }
  // portal ties along x (between land and sea legs) at mid height + knee braces up to the girder
  for (const sz of [-1, 1]) {
    const z = cz + sz * C.legHalfZ;
    b.box(Y, [(C.railLand + C.railSea) / 2, 18.5, z], [C.railSea - C.railLand - C.legW, 1.0, 0.9], { bevel: 0.06 });
    b.beam(Y, [C.railLand + 0.9, 24, z], [C.railLand + 5.5, C.portalY - 0.4, z], 0.6, 0.6, { bevel: 0.05 });
    b.beam(Y, [C.railSea - 0.9, 24, z], [C.railSea - 5.5, C.portalY - 0.4, z], 0.6, 0.6, { bevel: 0.05 });
    // outboard knee to the boom
    b.beam(Y, [C.railSea + 0.9, 25, z], [C.railSea + 6.5, C.portalY - 0.2, cz + sz * gz], 0.55, 0.55, { bevel: 0.05 });
    b.beam(Y, [C.railLand - 0.9, 25, z], [C.railLand - 7, C.portalY - 0.2, cz + sz * gz], 0.55, 0.55, { bevel: 0.05 });
  }
  await y();
  // ---------------- main girder (twin trusses) + cross members
  for (const sz of [-1, 1]) {
    const zc = cz + sz * gz;
    // backreach part (x0..land rail+2) is a closed box girder; the boom a truss
    b.box(Y, [(C.girderX0 + C.railLand + 2) / 2, (C.girderY0 + C.girderY1) / 2, zc], [C.railLand + 2 - C.girderX0, C.girderY1 - C.girderY0, gw], { bevel: 0.1 });
    trussSide(b, m, C.railLand + 2, C.girderX1, C.girderY0, C.girderY1, zc, gw);
    // stiffener ribs on the box part
    for (let x = C.girderX0 + 1.5; x < C.railLand + 1; x += 2.2) b.box(Y, [x, (C.girderY0 + C.girderY1) / 2, zc + sz * (gw / 2 + 0.04)], [0.12, C.girderY1 - C.girderY0 - 0.3, 0.08]);
  }
  for (let x = C.girderX0 + 1; x < C.girderX1; x += 6.4) {
    b.box(Y, [x, C.girderY0 + 0.3, cz], [0.5, 0.5, 2 * gz], {});
    b.box(Y, [x + 3.2, C.girderY1 - 0.25, cz], [0.4, 0.4, 2 * gz], {});
  }
  // boom nose (tip frame + sheave housing)
  b.box(Y, [C.girderX1 + 0.3, C.girderY0 + 1.4, cz], [1.4, 2.4, 2 * gz + gw], { bevel: 0.12 });
  b.cyl(D, [C.girderX1 + 0.3, C.girderY0 + 1.4, cz - gz - 0.8], [C.girderX1 + 0.3, C.girderY0 + 1.4, cz + gz + 0.8], 0.35, 12);
  // boom hinge knuckles at the sea leg
  for (const sz of [-1, 1]) b.cyl(D, [C.railSea + 2, C.girderY0 + 1.2, cz + sz * (gz - 0.8)], [C.railSea + 2, C.girderY0 + 1.2, cz + sz * (gz + 0.8)], 0.7, 16);
  // trolley rails on the girder tops
  for (const sz of [-1, 1]) b.box(S, [(C.railLand + C.girderX1) / 2, C.girderY1 + 0.08, cz + sz * gz], [C.girderX1 - C.railLand, 0.16, 0.18]);
  // the grating deck between the trusses over the backreach + portal (the collider's floor: no 34 m drop between
  // the girders until the open boom past the sea leg)
  { const xs = C.railSea + 2; b.box(m.galv, [(C.girderX0 + xs) / 2, C.girderY1 - 0.06, cz], [xs - C.girderX0, 0.08, 2 * gz - gw], {}); }
  // walkways (outboard of each girder) + railings
  const [g0, g1] = cabStairTop(idx);
  for (const sz of [-1, 1]) {
    const wz = cz + sz * (gz + gw / 2 + 0.5);
    b.box(m.galv, [(C.girderX0 + C.girderX1) / 2, C.girderY1 - 0.06, wz], [C.girderX1 - C.girderX0, 0.08, 1.0]);
    for (let x = C.girderX0 + 1; x < C.girderX1; x += 6.4) b.box(Y, [x, C.girderY1 - 0.3, wz], [0.14, 0.4, 1.0]);
    // (the +z railing opens where the cab stair tops out — same gap as the rail colliders)
    if (sz > 0) { railing(b, m, [[C.girderX0 + 0.2, C.girderY1, wz + sz * 0.48], [g0, C.girderY1, wz + sz * 0.48]], 1.1, 3.0); railing(b, m, [[g1, C.girderY1, wz + sz * 0.48], [C.girderX1 - 0.2, C.girderY1, wz + sz * 0.48]], 1.1, 3.0); }
    else { const [s0, s1] = craneStairGap(); railing(b, m, [[C.girderX0 + 0.2, C.girderY1, wz + sz * 0.48], [s0, C.girderY1, wz + sz * 0.48]], 1.1, 3.0); railing(b, m, [[s1, C.girderY1, wz + sz * 0.48], [C.girderX1 - 0.2, C.girderY1, wz + sz * 0.48]], 1.1, 3.0); }
  }
  await y();
  // ---------------- A-frame + stays
  const apexZs = [cz - gz, cz + gz];
  const apxB = C.apexX - 8.5, apxF = C.apexX + 7.5;
  for (const az of apexZs) {
    b.beam(Y, [apxB, C.girderY1, az], [C.apexX - 0.5, C.apexY - 1, az], 1.05, 1.05, { bevel: 0.08 });
    b.beam(Y, [apxF, C.girderY1, az], [C.apexX + 0.5, C.apexY - 1, az], 1.05, 1.05, { bevel: 0.08 });
    b.box(Y, [C.apexX, 45.5, az], [apxF - apxB - 6.4, 0.6, 0.6]);
    // ladder rungs up the back leg
    for (let y = C.girderY1 + 1; y < C.apexY - 2; y += 1.0) {
      const t = (y - C.girderY1) / (C.apexY - 1 - C.girderY1);
      const x = apxB + (C.apexX - 0.5 - apxB) * t;
      b.box(Y, [x + 0.62, y, az], [0.05, 0.05, 0.55]);
    }
  }
  b.box(Y, [C.apexX, C.apexY - 0.3, cz], [2.4, 1.8, 2 * gz + 1.4], { bevel: 0.14 });
  b.box(Y, [C.apexX, 45.5, cz], [0.7, 0.7, 2 * gz]);
  // (no z-tie at y 39.5 on the apex axis x = apexX: it would sit in mid-air between the leg pairs — the tie beams run
  // along each leg pair at y 45.5 only (above), and the two A-frames are tied across z at the LEGS' x positions)
  for (const y of [39.5]) {
    const t = (y - C.girderY1) / (C.apexY - 1 - C.girderY1);
    for (const [x0, x1] of [[apxB, C.apexX - 0.5], [apxF, C.apexX + 0.5]]) b.box(Y, [x0 + (x1 - x0) * t, y, cz], [0.6, 0.6, 2 * gz]);
  }
  for (const sz of [-1, 1]) b.cyl(D, [C.apexX - 0.9, C.apexY + 0.2, cz + sz * (gz + 0.9)], [C.apexX + 0.9, C.apexY + 0.2, cz + sz * (gz + 0.9)], 0.6, 14);
  // apex platform railing + aviation light
  railing(b, m, [[C.apexX - 1.2, C.apexY + 0.6, cz - gz - 0.7], [C.apexX + 1.2, C.apexY + 0.6, cz - gz - 0.7], [C.apexX + 1.2, C.apexY + 0.6, cz + gz + 0.7], [C.apexX - 1.2, C.apexY + 0.6, cz + gz + 0.7], [C.apexX - 1.2, C.apexY + 0.6, cz - gz - 0.7]], 0.9, 1.4);
  // aviation beacons: apex (both ends of the head beam) + boom tip — red lens on a dark housing with a cage
  for (const [bx, by, bz] of [[C.apexX, C.apexY + 0.6, cz - gz - 0.3], [C.apexX, C.apexY + 0.6, cz + gz + 0.3], [C.girderX1 + 0.3, C.girderY0 + 2.6, cz]] as V3[]) {
    b.cyl(D, [bx, by, bz], [bx, by + 0.25, bz], 0.3, 12);
    b.cyl(m.warnLight, [bx, by + 0.25, bz], [bx, by + 0.75, bz], 0.24, 12);
    b.cyl(D, [bx, by + 0.75, bz], [bx, by + 0.85, bz], 0.28, 12);
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.4; b.cyl(D, [bx + Math.cos(a) * 0.3, by + 0.25, bz + Math.sin(a) * 0.3], [bx + Math.cos(a) * 0.3, by + 0.8, bz + Math.sin(a) * 0.3], 0.02, 4, { caps: false }); }
  }
  // stays: thin dark wire ropes (forestays to the boom, backstays to the backreach) with sockets + a spreader bar
  const fxs = [C.railSea + 11, C.railSea + 25, C.girderX1 - 0.6];
  for (const az of apexZs) {
    const top: V3 = [C.apexX + 0.6, C.apexY - 0.4, az];
    for (const fx of fxs) {
      for (const dz of [-0.18, 0.18]) b.cyl(m.cable, [top[0], top[1], az + dz], [fx, C.girderY1 + 0.25, az + dz], 0.055, 6, { caps: false });
      b.box(D, [fx, C.girderY1 + 0.35, az], [0.6, 0.5, 0.7], { bevel: 0.05 });
    }
    for (const bx of [C.girderX0 + 1, C.girderX0 + 9]) {
      const by = C.house.y1 + (bx < C.girderX0 + 5 ? -4.9 : 0.2);
      for (const dz of [-0.18, 0.18]) b.cyl(m.cable, [C.apexX - 0.6, C.apexY - 0.4, az + dz], [bx, by, az + dz], 0.06, 6, { caps: false });
      b.box(D, [bx, by + 0.2, az], [0.5, 0.5, 0.6], { bevel: 0.05 });
    }
    b.box(D, [C.apexX + 0.9, C.apexY - 0.8, az], [0.9, 0.7, 0.8], { bevel: 0.06 });
  }
  await y();
  // ---------------- machinery house on the backreach (a hollow room + roof stair + the cab below: shared pieces)
  const H = C.house;
  const hy = (H.y0 + H.y1) / 2;
  drawPieces(b, cranePieces(cz, idx), roomMats(m, { steel: "#e8b21c" }));
  for (const sz of [-1, 1]) {
    const fz = cz + sz * (H.halfZ + 0.03);
    // ribs + louvres on the outside of the walls
    for (let x = H.x0 + 0.8; x < H.x1 - 0.4; x += 1.2) { if (Math.abs(x - (H.x1 - 3)) < 0.8 || Math.abs(x - (H.x0 + (sz < 0 ? 6.2 : 14.2))) < 1.0) continue; b.box(Y, [x, hy, fz + sz * 0.05], [0.1, H.y1 - H.y0 - 0.6, 0.1]); }
    for (const lx of [H.x0 + 3, H.x0 + 9.5]) {
      b.box(D, [lx, hy + 0.6, fz + sz * 0.02], [2.4, 1.6, 0.04]);
      for (let k = 0; k < 7; k++) b.box(m.galv, [lx, hy - 0.1 + k * 0.22, fz + sz * 0.06], [2.3, 0.05, 0.06]);
    }
  }
  b.box(Y, [(H.x0 + H.x1) / 2, H.y1 + 0.3, cz], [H.x1 - H.x0 + 0.3, 0.12, 2 * H.halfZ + 0.3]);
  b.cyl(m.galv, [H.x0 + 13, H.y1 + 0.24, cz - 1.5], [H.x0 + 13, H.y1 + 1.4, cz - 1.5], 0.35, 10);
  // ---------------- trolley, cab, hoist, spreader
  const tx = C.trolleyX[idx], sy = C.spreaderY[idx];
  b.box(Y, [tx, C.girderY1 + 1.0, cz], [4.8, 1.7, 2 * gz + 1.4], { bevel: 0.12 });
  b.box(D, [tx - 0.8, C.girderY1 + 2.1, cz], [2.4, 0.6, 3.2], { bevel: 0.08 });
  for (const sx of [-1.8, 1.8]) for (const sz of [-1, 1]) b.cyl(S, [tx + sx, C.girderY1 + 0.45, cz + sz * gz - 0.3], [tx + sx, C.girderY1 + 0.45, cz + sz * gz + 0.3], 0.32, 12);
  // cab hanging below (hanger frame through the girder gap); the cab itself is a shared-piece room (drawn above)
  const cab = C.cabin, cx = tx + cab.dx;
  b.box(Y, [cx, (cab.y1 + C.girderY0) / 2, cz], [0.5, C.girderY0 - cab.y1 + 0.2, 1.8]);
  b.box(D, [cx + cab.halfX + 0.35, cab.y1 + 0.05, cz], [0.7, 0.08, 2 * cab.halfZ + 0.2], { bevel: 0.02 });
  for (const mz of [-cab.halfZ + 0.06, cab.halfZ - 0.06]) b.box(D, [cx + cab.halfX - 0.03, (cab.y0 + cab.y1) / 2, cz + mz], [0.1, cab.y1 - cab.y0, 0.1]);
  // hoist ropes → headblock → spreader
  const hb = sy + 1.3;
  for (const sx of [-1.1, 1.1]) for (const sz of [-0.8, 0.8]) b.cyl(m.cable, [tx + sx, C.girderY0 + 0.2, cz + sz], [tx + sx * 0.6, hb + 0.4, cz + sz * 0.6], 0.045, 5, { caps: false });
  b.box(Y, [tx, hb, cz], [2.2, 0.8, 2.0], { bevel: 0.08 });
  b.box(Y, [tx, sy + 0.35, cz], [2.5, 0.5, 12.2], { bevel: 0.06 });
  for (const sz of [-1, 1]) b.box(D, [tx, sy + 0.35, cz + sz * 5.9], [2.6, 0.62, 0.5], { bevel: 0.05 });
  b.box(Y, [tx, sy + 0.72, cz], [0.6, 0.3, 11]);
  if (idx === 0) kit.add({ x: tx, y: sy + 0.08 - 2.591, z: cz, yaw: Math.PI / 2, color: "blue" });
  // floodlights under the girder + on the portal
  for (const lx of [C.railLand - 8, C.railLand + 10, C.railSea + 12, C.railSea + 28, C.railSea + 44]) for (const sz of [-1, 1]) {
    b.box(D, [lx, C.girderY0 - 0.3, cz + sz * gz], [0.6, 0.4, 0.5], { bevel: 0.05 });
    b.box(m.lampLens, [lx, C.girderY0 - 0.51, cz + sz * gz], [0.48, 0.03, 0.38]);
  }
  // festoon cable loops along the backreach→boom (under the north girder)
  const fz = cz - gz - 0.2;
  for (let x = C.girderX0 + 4; x < C.railSea; x += 4) b.tube(m.rubber, [[x, C.girderY0 - 0.2, fz], [x + 2, C.girderY0 - 1.3, fz], [x + 4, C.girderY0 - 0.2, fz]], 0.06, 5);
  // ---------------- stair tower (matches craneStair colliders)
  const st = craneStair(cz);
  for (const f of st.flights) {
    const dirZ = f.dir, z0 = f.z - (dirZ * f.run) / 2, z1 = f.z + (dirZ * f.run) / 2;
    for (const sx of [-1, 1]) b.beam(Y, [f.x + sx * (f.w / 2), f.y0 - 0.1, z0], [f.x + sx * (f.w / 2), f.y1 - 0.1, z1], 0.08, 0.26);
    // (parity: the treads ARE the collider's — same count, same tops, same depth)
    const nT = Math.ceil((f.y1 - f.y0) / 0.3), d = f.run / nT;
    for (let k = 0; k < nT; k++) {
      const t = (k + 0.5) / nT;
      b.box(m.galv, [f.x, f.y0 + (f.y1 - f.y0) * ((k + 1) / nT) - 0.02, z0 + (z1 - z0) * t], [f.w, 0.04, d + 0.02]);
    }
  }
  for (const l of st.landings) b.box(m.galv, [l.x, l.y - 0.05, l.z], [2 * l.hx, 0.1, 2 * l.hz]);
  const sx0 = Math.min(...st.flights.map((f) => f.x)) - 0.75, sx1 = Math.max(...st.flights.map((f) => f.x)) + 0.75;
  const sz0 = Math.min(...st.landings.map((l) => l.z)) - 0.75, sz1 = cz - C.legHalfZ + 3.1;
  for (const px of [sx0, sx1]) for (const pz of [sz0, sz1]) b.box(Y, [px, (APRON_Y + C.girderY1) / 2, pz], [0.22, C.girderY1 - APRON_Y, 0.22]);
  for (let y = APRON_Y + 5.6; y < C.girderY1; y += 5.6) {
    b.box(Y, [(sx0 + sx1) / 2, y, sz0], [sx1 - sx0, 0.16, 0.14]);
    b.box(Y, [sx0, y, (sz0 + sz1) / 2], [0.14, 0.16, sz1 - sz0]);
  }
  // outer handrail up the tower (west side)
  for (let y = APRON_Y + 1.1; y < C.girderY1 + 1; y += 2.8) b.box(Y, [sx0, y, (sz0 + sz1) / 2], [0.05, 0.05, sz1 - sz0]);
}

/** far proxy (shown beyond 150 m on the ground, so it keeps the crane's READ: see-through
 *  lattice legs (4 chords + one X per face per 7 m panel), twin truss girders with verticals + diagonals, the A-frame,
 *  stays, machinery house, trolley, cab and spreader; ≈ 3 k tris a crane in the same textured paint) */
function craneProxy(b: Builder, m: HarborMats, cz: number, idx: number) {
  const Y = cranePaint(m), D = m.darkPaint;
  const gz = C.girderHalfZ, gw = 1.25;
  for (const rx of [C.railLand, C.railSea]) {
    b.box(Y, [rx, (C.sillTop - 1.3 + C.sillTop) / 2, cz], [1.7, 1.3, 2 * C.legHalfZ + 5.4]);
    b.box(D, [rx, (APRON_Y + C.sillTop - 1.3) / 2, cz], [1.4, C.sillTop - 1.3 - APRON_Y, 2 * C.legHalfZ + 4.6]);
    for (const sz of [-1, 1]) {
      const x = rx, z = cz + sz * C.legHalfZ, y0 = C.sillTop, y1 = C.portalY - 0.2, w = C.legW, o = w / 2 - 0.18;
      for (const ax of [-1, 1]) for (const az of [-1, 1]) b.box(Y, [x + ax * o, (y0 + y1) / 2, z + az * o], [0.36, y1 - y0, 0.36]);
      const n = Math.max(2, Math.round((y1 - y0) / 7)), h = (y1 - y0) / n;
      for (let k = 0; k < n; k++) {
        const p0 = y0 + k * h, p1 = p0 + h;
        for (const [fx, fz, ax] of [[1, 0, "z"], [-1, 0, "z"], [0, 1, "x"], [0, -1, "x"]] as Array<[number, number, "x" | "z"]>) {
          const cx = x + fx * o, cc = z + fz * o;
          const a0: V3 = ax === "z" ? [cx, p0, z - o] : [x - o, p0, cc], a1: V3 = ax === "z" ? [cx, p1, z + o] : [x + o, p1, cc];
          const c0: V3 = ax === "z" ? [cx, p0, z + o] : [x + o, p0, cc], c1: V3 = ax === "z" ? [cx, p1, z - o] : [x - o, p1, cc];
          b.beam(Y, a0, a1, 0.2, 0.14); b.beam(Y, c0, c1, 0.2, 0.14);
        }
      }
    }
    b.box(Y, [rx, C.portalY - 1, cz], [1.6, 2, 2 * C.legHalfZ + C.legW]);
    b.box(Y, [rx, 17, cz], [0.9, 0.9, 2 * C.legHalfZ - C.legW]);
  }
  for (const sz of [-1, 1]) {
    const z = cz + sz * C.legHalfZ;
    b.box(Y, [(C.railLand + C.railSea) / 2, 18.5, z], [C.railSea - C.railLand - C.legW, 1.0, 0.9]);
    b.beam(Y, [C.railSea + 0.9, 25, z], [C.railSea + 6.5, C.portalY - 0.2, cz + sz * gz], 0.55, 0.55);
    b.beam(Y, [C.railLand - 0.9, 25, z], [C.railLand - 7, C.portalY - 0.2, cz + sz * gz], 0.55, 0.55);
  }
  for (const sz of [-1, 1]) {
    const zc = cz + sz * gz, chH = 0.75, x0 = C.railLand + 2, x1 = C.girderX1;
    b.box(Y, [(C.girderX0 + x0) / 2, (C.girderY0 + C.girderY1) / 2, zc], [x0 - C.girderX0, C.girderY1 - C.girderY0, gw]);
    b.box(Y, [(x0 + x1) / 2, C.girderY1 - chH / 2, zc], [x1 - x0, chH, gw]);
    b.box(Y, [(x0 + x1) / 2, C.girderY0 + chH / 2, zc], [x1 - x0, chH, gw]);
    const n = Math.round((x1 - x0) / 6.4), dx = (x1 - x0) / n;
    for (let i = 0; i <= n; i++) {
      const x = x0 + i * dx;
      b.box(Y, [x, (C.girderY0 + C.girderY1) / 2, zc], [0.34, C.girderY1 - C.girderY0 - 2 * chH, gw * 0.72]);
      if (i < n) b.beam(Y, [x, C.girderY0 + chH, zc], [x + dx, C.girderY1 - chH, zc], 0.3, gw * 0.62);
    }
  }
  b.box(Y, [C.girderX1 + 0.3, C.girderY0 + 1.4, cz], [1.4, 2.4, 2 * gz + gw]);
  for (const az of [cz - gz, cz + gz]) {
    b.beam(Y, [C.apexX - 8.5, C.girderY1, az], [C.apexX - 0.5, C.apexY - 1, az], 1.05, 1.05);
    b.beam(Y, [C.apexX + 7.5, C.girderY1, az], [C.apexX + 0.5, C.apexY - 1, az], 1.05, 1.05);
    // (proxy wires are 5-sided CYLINDERS — smooth normals let atmos' thin-wire path widen them to
    // ≥ ~1.7 px; a box beam's flat faces only slid apart and the far stays kept dashing)
    for (const fx of [C.railSea + 11, C.railSea + 25, C.girderX1 - 0.6]) b.cyl(m.cable, [C.apexX + 0.6, C.apexY - 0.4, az], [fx, C.girderY1 + 0.25, az], 0.06, 5, { caps: false });
    for (const bx of [C.girderX0 + 1, C.girderX0 + 9]) b.cyl(m.cable, [C.apexX - 0.6, C.apexY - 0.4, az], [bx, C.house.y1 + (bx < C.girderX0 + 5 ? -4.9 : 0.2), az], 0.06, 5, { caps: false });
  }
  b.box(Y, [C.apexX, C.apexY - 0.3, cz], [2.4, 1.8, 2 * gz + 1.4]);
  b.box(Y, [C.apexX, 45.5, cz], [0.7, 0.7, 2 * gz]);
  const H = C.house;
  b.box(Y, [(H.x0 + H.x1) / 2, (H.y0 + H.y1) / 2, cz], [H.x1 - H.x0, H.y1 - H.y0, 2 * H.halfZ]);
  const tx = C.trolleyX[idx], sy = C.spreaderY[idx], cab = C.cabin;
  b.box(Y, [tx, C.girderY1 + 1.0, cz], [4.8, 1.7, 2 * gz + 1.4]);
  b.box(Y, [tx + cab.dx, (cab.y0 + cab.y1) / 2, cz], [2 * cab.halfX, cab.y1 - cab.y0, 2 * cab.halfZ]);
  b.box(m.windowDark, [tx + cab.dx + cab.halfX + 0.02, (cab.y0 + cab.y1) / 2 + 0.2, cz], [0.04, 1.6, 2 * cab.halfZ - 0.4]);
  b.box(Y, [tx, sy + 0.35, cz], [2.5, 0.5, 12.2]);
  for (const sx of [-1.1, 1.1]) b.cyl(m.cable, [tx + sx, C.girderY0, cz], [tx + sx * 0.6, sy + 1.7, cz], 0.05, 5, { caps: false });
}

export const part: Part = {
  id: "crane",
  async build({ ctx, mats, group, kit, lod, c1 }) {
    // both cranes in ONE merged builder (≈10 draws), full detail at every distance; a ~1 k-tri proxy each for the shadows
    const b = new Builder(true), far = new Builder(true);
    for (let i = 0; i < C.zs.length; i++) { await buildCrane(b, mats, C.zs[i], i, kit, () => ctx.yield()); await ctx.yield(); craneProxy(far, mats, C.zs[i], i); }
    // (the wire ropes keep their own "cable" material — atmos' thin-wire path holds them ≥ ~1.7 px)
    const g = await b.buildAsync("crane", { palette: (m) => m.name !== "yellowPaint" && m.name !== "cable" && !m.transparent && !/^room-(grating|checker)/.test(m.name) }, () => ctx.yield());
    group.add(g);
    await ctx.yield();
    const pg = await far.buildAsync("crane-proxy", { palette: (m) => m.name !== "yellowPaint" && m.name !== "cable" }, () => ctx.yield());
    // the far shadow map's crane caster (force-shown by the bake whatever the camera distance at load); it never casts
    // into cascade 1 itself — the harbor-wide C1 caster carries its silhouette
    pg.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.userData.castShadow = true; o.userData.farShadow = "force"; o.userData.c1Shadow = false; } });
    group.add(pg);
    c1.push(pg);
    // perf: the lattice's detailed silhouette casts into cascade 0 only (89 k shadow tris otherwise in the 26–220 m
    // cascade); the full crane within 150 m on the ground (330 m from the air: the elevated poi-01 view and the plane)
    mergeCasters(g, { farShadow: false, c1: false });
    // (the cranes are the port's LANDMARK: they never swap to the proxy (a swap at 150 m on the ground / 330 m in the
    // air, and the AIR_Y switch between the two while landing, reads as the crane re-spawning). The full crane is ≈10
    // draws; the proxy stays as a SHADOW-ONLY stand-in: force-shown for the far shadow-map bake + merged into the
    // harbor's cascade-1 caster) (?craneproxy = the old swap, A/B)
    if (flag("craneproxy")) lod.pair(g, pg, 150, { air: 330 });
    else { pg.visible = false; pg.userData.farShadow = "force"; }
    void THREE;
  },
};
