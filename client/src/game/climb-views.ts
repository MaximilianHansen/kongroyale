// LADDERS + CLIMBABLE TREES, drawn (the sim is shared/sim/climb.ts + player.ts PS.Climb). Built once from
// the static world's climb list (the same list the sim climbs): Kong Royale-style bamboo ladders lashed with rope
// (stilt huts, the Murk, Coconut Cove), rope pilot ladders with wooden treads hooked over the wreck's deck edge, and on
// the climbable giant trees a rope ladder pinned up the trunk with rope wraps + carved notches, under a plank perch
// (shared/pois/climb-trees.ts). Everything merges into ONE vertex-coloured mesh (one draw call, no textures).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Climb } from "../../../shared/sim/climb";
import { LADDERS, LANDINGS, type Landing } from "../../../shared/pois/ladders";
import { perchFor, type PerchDef } from "../../../shared/pois/climb-trees";
import { releaseGeometryAfterUpload } from "../engine/geometry-release";

const C = (hex: string) => new THREE.Color(hex);
const BAMBOO = C("#c9a95a"), BAMBOO_D = C("#8d7536"), RUNG = C("#b89648"), LASH = C("#6a5232"), ROPE = C("#bfa070"), TREAD = C("#7b4b27"), TREAD_D = C("#5a361b"), PLANK = C("#a8834e"), PLANK_D = C("#7d5d38"), BARK_CUT = C("#4a3020");

/** a cylinder between two points, coloured */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, col: THREE.Color, seg = 6): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return paint(g, col);
}
function box(w: number, h: number, d: number, m: THREE.Matrix4, col: THREE.Color): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(w, h, d).applyMatrix4(m), col);
}
function paint(g: THREE.BufferGeometry, col: THREE.Color): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g; if (ng !== g) g.dispose();
  const n = ng.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const k = 0.92 + 0.08 * ((i * 7919) % 13) / 13; a[i * 3] = col.r * k; a[i * 3 + 1] = col.g * k; a[i * 3 + 2] = col.b * k; }
  ng.setAttribute("color", new THREE.BufferAttribute(a, 3));
  ng.deleteAttribute("uv");
  return ng;
}

/** a ladder's frame: P(u, y, w) = the point u m along the face (lateral), y high, w m off the face */
function frame(c: Climb) {
  const tx = -c.nz, tz = c.nx;
  return (u: number, y: number, w: number) => new THREE.Vector3(c.x + tx * u + c.nx * w, y, c.z + tz * u + c.nz * w);
}

function bambooLadder(c: Climb, out: THREE.BufferGeometry[]) {
  const P = frame(c), yb = c.y0 < -0.9 ? -1.9 : c.y0 - 0.05, yt = c.y1 + 0.95, half = 0.3, off = 0.13;
  for (const u of [-half, half]) {
    out.push(rod(P(u, yb, off), P(u, yt, off), 0.045, BAMBOO, 7));
    for (let y = yb + 0.4; y < yt - 0.1; y += 0.48) out.push(rod(P(u, y - 0.025, off), P(u, y + 0.025, off), 0.054, BAMBOO_D, 7));
    out.push(rod(P(u, yt - 0.01, off), P(u, yt + 0.02, off), 0.05, BAMBOO_D, 7));
  }
  for (let y = Math.max(yb + 0.3, c.y0 + 0.28); y < c.y1 + 0.5; y += 0.31) {
    out.push(rod(P(-half - 0.06, y, off), P(half + 0.06, y, off), 0.028, RUNG, 6));
    for (const u of [-half, half]) out.push(rod(P(u, y - 0.05, off + 0.005), P(u, y + 0.05, off + 0.005), 0.058, LASH, 6));
  }
  // lashed to the face at the top (two short stand-offs into the wall)
  for (const u of [-half, half]) out.push(rod(P(u, c.y1 - 0.15, off), P(u, c.y1 - 0.15, 0), 0.03, LASH, 5));
}

function pilotLadder(c: Climb, out: THREE.BufferGeometry[]) {
  const P = frame(c), yb = Math.min(c.y0 - 0.5, -1.7), yt = c.y1, half = 0.34, off = 0.1;
  for (const u of [-half, half]) {
    out.push(rod(P(u, yb, off), P(u, yt - 0.05, off), 0.02, ROPE, 5));
    // over the lip: the rope runs up, over the deck edge and back to a hook
    out.push(rod(P(u, yt - 0.05, off), P(u, yt + 0.12, -0.05), 0.022, ROPE, 5));
    out.push(rod(P(u, yt + 0.12, -0.05), P(u, yt + 0.06, -0.55), 0.022, ROPE, 5));
    out.push(rod(P(u, yt + 0.08, -0.55), P(u, yt + 0.02, -0.7), 0.035, TREAD_D, 5));
  }
  let k = 0;
  for (let y = Math.max(yb + 0.35, c.y0 + 0.25); y < yt - 0.15; y += 0.31, k++) {
    const p = P(0, y, off + 0.02), m = new THREE.Matrix4().makeRotationY(Math.atan2(-c.nz, c.nx) * -1 + Math.PI / 2).setPosition(p);
    // every 9th tread a long spreader bar (keeps the ladder off the hull, like a real pilot ladder)
    const wide = k % 9 === 8;
    out.push(box(wide ? 1.5 : 0.78, 0.034, 0.12, m, k % 2 ? TREAD : TREAD_D));
  }
}

/** a giant's perch: the rope ladder hanging from the deck edge (between two buttress roots) with bamboo rungs, rope wraps
 *  round the trunk under the deck (the "this tree is climbable" read from across a clearing), the plank deck, a rope rail
 *  on posts, diagonal braces back to the trunk */
function treeLadder(c: Climb, perch: PerchDef, out: THREE.BufferGeometry[]) {
  const P = frame(c), yb = c.y0 - 0.1, yt = c.y1, half = 0.26, off = 0.12;
  for (const u of [-half, half]) {
    out.push(rod(P(u, yb, off), P(u, yt + 0.02, off), 0.022, ROPE, 5));
    out.push(rod(P(u, yt + 0.02, off), P(u, yt + 0.05, -0.35), 0.024, ROPE, 5));   // over the deck edge to its tie
  }
  for (let y = Math.max(yb + 0.3, c.y0 + 0.25); y < yt - 0.1; y += 0.33) out.push(rod(P(-half - 0.05, y, off), P(half + 0.05, y, off), 0.028, RUNG, 6));
  // rope wraps round the trunk under the perch (thicker below: the trunk flares)
  for (let k = 0; k < 4; k++) {
    const y = c.y1 - 0.9 - k * 1.25, r = perch.trunkR * (1 + 0.06 * (c.y1 - y)) + 0.06;
    if (y < c.y0 + 1.5) break;
    out.push(paint(new THREE.TorusGeometry(r, 0.04, 4, 16).rotateX(Math.PI / 2).translate(perch.x, y, perch.z), ROPE));
    out.push(paint(new THREE.TorusGeometry(r, 0.032, 4, 16).rotateX(Math.PI / 2).translate(perch.x, y + 0.1, perch.z), LASH));
  }
  // the deck boards (= its colliders) with a darker plank seam pattern
  for (const b of perch.planks) {
    const m = new THREE.Matrix4().makeRotationY(-b.yaw).setPosition(b.x, b.y, b.z);
    out.push(box(b.hx * 2, b.hy * 2, b.hz * 2, m, b.dark ? PLANK_D : PLANK));
    const n = Math.max(1, Math.round(b.hz * 2 / 0.32));
    for (let k = 1; k < n; k++) { const v = -b.hz + (k / n) * b.hz * 2; const mm = new THREE.Matrix4().makeRotationY(-b.yaw).multiply(new THREE.Matrix4().makeTranslation(0, b.hy + 0.003, v)).premultiply(new THREE.Matrix4().makeTranslation(b.x, b.y, b.z)); out.push(box(b.hx * 2 - 0.04, 0.008, 0.03, mm, BARK_CUT)); }
  }
  // rail: posts + two ropes
  for (const [x0, z0, x1, z1] of perch.rails) {
    for (const [x, z] of [[x0, z0], [x1, z1]]) out.push(rod(new THREE.Vector3(x, perch.y - 0.05, z), new THREE.Vector3(x, perch.y + 1.08, z), 0.055, PLANK_D, 6));
    out.push(rod(new THREE.Vector3(x0, perch.y + 1.0, z0), new THREE.Vector3(x1, perch.y + 1.0, z1), 0.032, ROPE, 5));
    out.push(rod(new THREE.Vector3(x0, perch.y + 0.55, z0), new THREE.Vector3(x1, perch.y + 0.55, z1), 0.026, ROPE, 5));
  }
  // braces: from the deck corners down-in to the trunk
  for (let k = 0; k < 4; k++) {
    const a = perch.yaw + (k + 0.5) * Math.PI / 2, rr = perch.half * 1.2;
    out.push(rod(new THREE.Vector3(perch.x + Math.cos(a) * perch.trunkR * 1.05, perch.y - 1.9, perch.z + Math.sin(a) * perch.trunkR * 1.05), new THREE.Vector3(perch.x + Math.cos(a) * rr, perch.y - 0.2, perch.z + Math.sin(a) * rr), 0.08, PLANK_D, 6));
  }
}

/** a timber landing bolted to the cliff between two ladders (Mist Falls): plank deck on two joists and a front
 *  beam, knee braces down into the rock, rope rails on posts along both open sides (the front stays open: the ladders top
 *  out there). Matches shared/pois/ladders.ts landingBoxes (deck 0.3 m, rails at ±(hx − 0.04), front → 1 m short of the back) */
function landingDeck(l: Landing, out: THREE.BufferGeometry[]) {
  const zf = l.z - l.hz, zb = l.z + l.hz, y = l.y, M = new THREE.Matrix4(), V = (x: number, yy: number, z: number) => new THREE.Vector3(x, yy, z);
  for (let z = zf + 0.14, i = 0; z < zb - 0.05; z += 0.27, i++) out.push(box(l.hx * 2 + (i % 3 === 1 ? -0.08 : 0), 0.06, 0.25, M.makeTranslation(l.x + (i % 2 ? 0.03 : -0.03), y - 0.03, z), i % 4 === 2 ? PLANK_D : PLANK));
  for (const s of [-1, 1]) out.push(box(0.18, 0.24, zb - zf, M.makeTranslation(l.x + s * (l.hx - 0.35), y - 0.18, l.z), TREAD_D));
  out.push(box(l.hx * 2 + 0.1, 0.26, 0.2, M.makeTranslation(l.x, y - 0.17, zf + 0.1), TREAD));
  for (const s of [-1, 1]) {
    const bx = l.x + s * (l.hx - 0.35);
    out.push(rod(V(bx, y - 0.28, zf + 0.25), V(bx, y - 2.9, zf + 2.6), 0.07, TREAD_D, 6));
    // rope rail on posts along the open side
    const x = l.x + s * (l.hx - 0.04), z1 = zb - 1.0;
    for (let z = zf + 0.08; z <= z1 + 0.01; z += Math.max(0.5, (z1 - zf - 0.08) / Math.max(1, Math.round((z1 - zf) / 1.5)))) out.push(rod(V(x, y - 0.25, z), V(x, y + 1.1, z), 0.05, BAMBOO, 6));
    out.push(rod(V(x, y + 1.02, zf + 0.08), V(x, y + 1.02, z1), 0.03, ROPE, 5));
    out.push(rod(V(x, y + 0.55, zf + 0.08), V(x, y + 0.55, z1), 0.025, ROPE, 5));
  }
}

export class ClimbViews {
  /** one merged mesh per ~200 m cell (frustum + distance culled), all sharing one vertex-coloured material */
  readonly meshes: THREE.Mesh[] = [];
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  constructor(scene: THREE.Scene, private readonly climbs: Climb[]) {
    const style = new Map<string, string>();
    for (const l of LADDERS) style.set(`${l.c.x.toFixed(2)},${l.c.z.toFixed(2)},${l.c.y1.toFixed(2)}`, l.style);
    const cells = new Map<string, { climbs: Climb[]; landings: Landing[] }>();
    const cell = (x: number, z: number) => { const key = `${Math.floor(x / 200)},${Math.floor(z / 200)}`; let c = cells.get(key); if (!c) cells.set(key, c = { climbs: [], landings: [] }); return c; };
    for (const c of climbs) cell(c.x, c.z).climbs.push(c);
    for (const l of LANDINGS) cell(l.x, l.z).landings.push(l);
    // a cell's parts are built again when a context restore refills its released arrays (geofree)
    const merged = (cl: { climbs: Climb[]; landings: Landing[] }) => {
      const parts: THREE.BufferGeometry[] = [];
      for (const c of cl.climbs) {
        if (c.kind === 1) treeLadder(c, perchFor(c), parts);
        else if (style.get(`${c.x.toFixed(2)},${c.z.toFixed(2)},${c.y1.toFixed(2)}`) === "pilot") pilotLadder(c, parts); else bambooLadder(c, parts);
      }
      for (const l of cl.landings) landingDeck(l, parts);
      const g = mergeGeometries(parts, false)!;
      for (const p of parts) p.dispose();
      return g;
    };
    for (const cl of cells.values()) {
      const g = merged(cl);
      g.computeBoundingSphere(); g.computeBoundingBox();
      releaseGeometryAfterUpload(g, () => { const fresh = merged(cl), out: Record<string, THREE.TypedArray> = {}; for (const [k, a] of Object.entries(fresh.attributes)) out[k] = (a as THREE.BufferAttribute).array; if (fresh.index) out.index = fresh.index.array; return out; });
      const m = new THREE.Mesh(g, this.mat);
      m.name = "climbs"; m.castShadow = true; m.receiveShadow = true;
      scene.add(m); this.meshes.push(m);
    }
  }
  /** per frame: drop the cells far from the camera (ladders read to ~450 m; the perches are big enough to see that far) */
  update(cam: THREE.Vector3) {
    for (const m of this.meshes) { const b = m.geometry.boundingSphere!; m.visible = b.center.distanceTo(cam) - b.radius < 450; }
  }
  /** a climb's foot you could walk into from here (the HUD hint): within 1.6 m, facing it */
  nearFoot(x: number, y: number, z: number, yaw: number): boolean {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (const c of this.climbs) {
      const rx = x - c.x, rz = z - c.z; if (rx > 3 || rx < -3 || rz > 3 || rz < -3) continue;
      const dn = rx * c.nx + rz * c.nz, lat = rz * c.nx - rx * c.nz;
      if (Math.abs(lat) < c.hw + 0.4 && dn > -0.2 && dn < c.off + 1.4 && y > c.y0 - 0.8 && y < c.y1 - 1.2 && fx * -c.nx + fz * -c.nz > 0.3) return true;
    }
    return false;
  }
  /** the climb a remote kong at (x, y, z) is on (the nearest line) — its body faces the face */
  nearest(x: number, y: number, z: number): Climb | null {
    let best: Climb | null = null, bd = 4;
    for (const c of this.climbs) { if (y < c.y0 - 2 || y > c.y1 + 1) continue; const d = Math.hypot(x - (c.x + c.nx * c.off), z - (c.z + c.nz * c.off)); if (d < bd) { bd = d; best = c; } }
    return best;
  }
  dispose() { for (const m of this.meshes) { m.removeFromParent(); m.geometry.dispose(); } this.mat.dispose(); }
}
