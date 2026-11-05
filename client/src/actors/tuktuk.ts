// THE TUK-TUK — BANANA CO.'s three-wheeled island taxi (the look; shared/sim/vehicle.ts is what it does).
//
// Built from the SAME kit the island's parked vehicles are made of (world/pois/_kit: glossy banana-yellow paint, chocolate
// trim, coral seats, chrome, fat tyres on yellow rims, the BANANA CO. stencil), so it sits in the world like it was
// always there — and then it is a bit much: a roof-rack crate heaped with ripe bananas, a giant banana lying on the
// TAXI sign, a pom-pom fringe round the canopy, fuzzy dice, a brass bulb horn that really squeezes, tassels on the
// grips, round scooter mirrors, a whip aerial with a pennant, and one big cyclops headlight under a chrome brow.
//
// Frame = the sim's body frame: +X right, +Y up, −Z forward, origin on the ground under the middle of the wheelbase.
// Everything is merged per material per moving part (≈ 30 draws close up, 12 beyond DETAIL_M); the parts that move:
// the three wheels, the steering (bars + fork + mudguard), the cabin on its springs, the aerial, the dice, the horn bulb.
import * as THREE from "three";
import { Batch, M, box, cyl, mat, rbox, sph, type MatKey } from "../world/pois/_kit/coast-kit";
import { wheel } from "../world/pois/_kit/coast-vehicles";
import { bananaHand, crate } from "../world/pois/_kit/coast-props";
import { TUK, TYRE, VF, VS } from "../../../shared/sim/vehicle";

const Y = 0xf8d42c, YD = 0xe2a81a, BR = 0x4a2c17, BD = 0x2a1d14, CO = 0xe2553d, COD = 0xb93f2c, TQ = 0x2bb6b0, CR = 0xfff0d2, CH = 0xe2e2e2, DK = 0x27272b, BRASS = 0xdfa63c;
/** small props (fringe, dice, cargo, bolts) are drawn within this distance (m) */
const DETAIL_M = 70;
/** steering head (body frame) and the fork's rake (rad): the bars, the fork and the front wheel turn about this axis */
const HEAD: readonly [number, number, number] = [0, 1.16, -1.0];
const RAKE = Math.atan2(TUK.FRONT - 1.0, 1.16 - TUK.WHEEL_R);
const FORK_L = Math.hypot(TUK.FRONT - 1.0, 1.16 - TUK.WHEEL_R);
/** a flat tyre's radius as a share of a full one: the rubber is gone, the wheel runs on what is left */
const FLAT_K = 0.76;

const mul = (a: THREE.Matrix4, b: THREE.Matrix4) => new THREE.Matrix4().multiplyMatrices(a, b);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** a round bar between two points */
export function rod(b: Batch, a: THREE.Vector3, c: THREE.Vector3, r: number, key: MatKey, color: THREE.ColorRepresentation, seg = 8, o: { lod?: 0 | 1 | 2; shadow?: boolean } = {}) {
  const d = c.clone().sub(a), L = d.length(); if (L < 1e-4) return;
  const g = new THREE.CylinderGeometry(r, r, L, seg, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  b.add(g, key, { m: new THREE.Matrix4().compose(a.clone().add(c).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)), uv: "local", tile: 1, color, ...o });
}
/** one BIG banana (the roof sign's): a slim tapered tube bent along a deep arc in the XY plane, lying on its belly
 * with both ends curling UP (a smile), a stubby stem at −X and a dark tip at +X; ≈ `len` long */
export function bigBanana(len: number, r: number, burnt: boolean): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, 8, 18, false);
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const body = new THREE.Color(burnt ? 0x1c1712 : 0xffd92e), ridge = new THREE.Color(burnt ? 0x181410 : 0xf2bd1e), tip = new THREE.Color(burnt ? 0x0e0b09 : 0x3d2c14), stem = new THREE.Color(burnt ? 0x15110d : 0x8f9a34);
  const arc = 1.7, R = len / arc;
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) + 0.5;
    // a fat belly that tapers to the tip, and a thin neck into the stem
    const prof = t < 0.1 ? 0.3 + 0.25 * (t / 0.1) : Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + (t - 0.1) * 0.93)), 0.5);
    const rr = r * prof + r * 0.05, a = (t - 0.5) * arc, cx = p.getX(i), cz = p.getZ(i);
    // (a banana is five-sided: flatten the round section a touch on its ridges)
    const k = 1 - 0.1 * Math.abs(Math.sin(2.5 * Math.atan2(cz, cx)));
    const x = cx * rr * k, z = cz * rr * k;
    p.setXYZ(i, (R - x) * Math.sin(a), R - (R - x) * Math.cos(a), z);
    const c = t > 0.965 ? tip : t < 0.1 ? stem : Math.abs(Math.sin(2.5 * Math.atan2(cz, cx))) < 0.25 ? ridge : body;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

let signTex: THREE.CanvasTexture | null = null, signMat: THREE.MeshStandardMaterial | null = null, signOff: THREE.MeshStandardMaterial | null = null;
/** the roof sign's face: TAXI in the island's chunky lettering on banana yellow (lit from inside) */
function taxiSign(burnt: boolean): THREE.MeshStandardMaterial {
  if (!signTex) {
    const c = document.createElement("canvas"); c.width = 512; c.height = 160;
    const g = c.getContext("2d")!;
    g.fillStyle = "#ffd83a"; g.fillRect(0, 0, 512, 160);
    g.fillStyle = "#3a2412"; g.fillRect(0, 0, 512, 12); g.fillRect(0, 148, 512, 12);
    for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? "#3a2412" : "#ffd83a"; g.fillRect(i * 32, 16, 32, 14); g.fillRect(i * 32, 130, 32, 14); }
    g.fillStyle = "#3a2412"; g.font = "900 104px 'Barlow Condensed', 'Arial Narrow', Impact, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("TAXI", 256, 84);
    signTex = new THREE.CanvasTexture(c); signTex.colorSpace = THREE.SRGBColorSpace; signTex.anisotropy = 8;
  }
  if (burnt) return (signOff ??= Object.assign(new THREE.MeshStandardMaterial({ map: signTex, color: 0x1a1512, roughness: 0.9 }), { name: "tuk:sign-off" }));
  return (signMat ??= Object.assign(new THREE.MeshStandardMaterial({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.55, roughness: 0.4 }), { name: "tuk:sign" }));
}

interface Parts { body: THREE.Group; detail: THREE.Group; bars: THREE.Group; fork: THREE.Group; wheel: THREE.Group; brake: THREE.Group; aerial: THREE.Group; dice: THREE.Group; bulb: THREE.Group; roof: THREE.Group }

/** every merged part of one tuk-tuk. `burnt`: the wreck — the same shapes charred, no glass, no cargo, no fringe. */
function build(burnt: boolean): Parts {
  const dark = new THREE.Color(0x15110e);
  const C = (hex: number, keep = 0.1) => (burnt ? new THREE.Color(hex).lerp(dark, 1 - keep).getHex() : hex);
  const K = (k: MatKey): MatKey => (burnt && (k === "gloss" || k === "chrome" || k === "steel" || k === "lamp" || k === "lampRed") ? "pmetal" : k);
  const mk = () => new Batch({ cell: 1e6 });
  const fin = (b: Batch, name: string) => { const g = b.build(name); g.traverse((o) => { o.userData.farShadow = false; }); return g; };

  // ------------------------------------------------------------------------------------------------ body (the tub + nose)
  const b = mk(), d = mk(), roof = mk();
  const D2 = { lod: 2 as const, shadow: false };
  // chassis: floor pan, rails, engine under the bench
  b.add(rbox(1.72, 0.1, 2.5, 0.04), "pmetal", { m: M(0, 0.33, 0.33), color: C(DK), mud: { y0: 0, h: 0.5, k: 0.3 } });
  for (const s of [-1, 1]) b.add(rbox(0.1, 0.12, 2.9, 0.03), "pmetal", { m: M(s * 0.42, 0.25, 0.1), color: C(0x1c1c1f) });
  b.add(rbox(0.9, 0.36, 0.62, 0.08), "pmetal", { m: M(0, 0.2 + 0.18, 1.18), color: C(0x333338) });
  for (let i = 0; i < 5; i++) b.add(box(0.94, 0.03, 0.05), "steel", { m: M(0, 0.26 + i * 0.06, 1.5), color: C(0x8c8c8c), lod: 2 });
  // the floor: ribbed rubber mat
  b.add(box(1.6, 0.02, 1.9), "rubber", { m: M(0, 0.385, 0.15), color: C(0x33312e) });
  // side panels (the bench's tub), belt trim, the sills of the open entries
  for (const s of [-1, 1]) {
    b.add(rbox(0.09, 0.62, 1.5, 0.05), K("gloss"), { m: M(s * 0.88, 0.69, 0.84), color: C(Y), mud: { y0: 0.3, h: 0.55, k: 0.25 } });
    b.add(rbox(0.11, 0.07, 1.56, 0.03), K("gloss"), { m: M(s * 0.885, 1.0, 0.84), color: C(BR) });
    b.add(rbox(0.1, 0.12, 0.84, 0.04), K("gloss"), { m: M(s * 0.86, 0.42, -0.34), color: C(BR) });
    b.add(rbox(0.09, 0.05, 0.84, 0.02), K("chrome"), { m: M(s * 0.9, 0.5, -0.34), color: C(CH) });
    // coral pinstripe + the BANANA CO. stencil
    b.add(box(0.012, 0.045, 1.42), K("gloss"), { m: M(s * 0.928, 0.9, 0.84), color: C(CO), lod: 1 });
    // chrome grab rail over the belt line (the target art's passenger rails)
    rod(b, V(s * 0.9, 1.035, 0.2), V(s * 0.9, 1.24, 0.26), 0.022, K("chrome"), C(CH));
    rod(b, V(s * 0.9, 1.24, 0.26), V(s * 0.9, 1.24, 1.18), 0.022, K("chrome"), C(CH));
    rod(b, V(s * 0.9, 1.24, 1.18), V(s * 0.9, 1.035, 1.26), 0.022, K("chrome"), C(CH));
    rod(b, V(s * 0.9, 1.035, 0.72), V(s * 0.9, 1.24, 0.72), 0.016, K("chrome"), C(CH), 6, { lod: 1 });
    // rear mudguards: chunky arches over the fat tyres
    const arch = new THREE.TorusGeometry(0.47, 0.13, 8, 16, Math.PI); arch.scale(1, 1, 1.7);
    b.add(arch, K("gloss"), { m: M(s * (TUK.HW + 0.05), TUK.WHEEL_R - 0.02, TUK.REAR, 0, Math.PI / 2, 0), uv: "local", tile: 1, color: C(Y) });
    b.add(rbox(0.34, 0.06, 0.2, 0.02), "rubber", { m: M(s * (TUK.HW + 0.05), 0.2, TUK.REAR + 0.5, 0.2, 0, 0), color: C(0x1b1b1b), lod: 1 });
    // tail lamps (dark lenses: the lit ones are the brake part)
    b.add(rbox(0.16, 0.2, 0.07, 0.03), K("gloss"), { m: M(s * 0.7, 0.78, 1.63), color: C(0x6e1410) });
    b.add(sph(0.05, 8, 6), K("lamp"), { m: M(s * 0.7, 0.56, 1.64, 0, 0, 0, 1, 1, 0.5), color: burnt ? 0x1a1512 : 0xff7a1a, lod: 1 });
  }
  // back panel, engine lid with louvres, bumper, plate, spare
  b.add(rbox(1.85, 0.64, 0.09, 0.05), K("gloss"), { m: M(0, 0.69, 1.58), color: C(Y), mud: { y0: 0.3, h: 0.5, k: 0.25 } });
  b.add(rbox(1.5, 0.16, 0.3, 0.06), K("gloss"), { m: M(0, 1.06, 1.45), color: C(BR) });
  for (let i = 0; i < 6; i++) b.add(box(0.5, 0.012, 0.03), "pmetal", { m: M(-0.42, 0.52 + i * 0.045, 1.628), color: C(BD), lod: 2 });
  rod(b, V(-0.86, 0.36, 1.72), V(0.86, 0.36, 1.72), 0.045, K("chrome"), C(CH), 10);
  for (const s of [-1, 1]) rod(b, V(s * 0.6, 0.36, 1.72), V(s * 0.6, 0.36, 1.56), 0.03, K("chrome"), C(CH), 6, { lod: 1 });
  b.add(rbox(0.42, 0.15, 0.02, 0.01), K("gloss"), { m: M(0.42, 0.56, 1.635), color: C(CR), lod: 1 });
  if (!burnt) b.add(new THREE.PlaneGeometry(0.2, 0.2), "badge", { m: M(0.42, 0.56, 1.648), uv: "keep", shadow: false, lod: 2 });
  // ---- seats: the driver's saddle + backrest, the passengers' tufted bench
  b.add(rbox(0.36, 0.26, 0.4, 0.05), "pmetal", { m: M(0, 0.5, 0.0), color: C(0x2c2c30) });
  b.add(rbox(0.6, 0.17, 0.66, 0.08), "fabric", { m: M(0, 0.665, 0.0), color: C(CO) });
  b.add(rbox(0.64, 0.4, 0.1, 0.05), "fabric", { m: M(0, 1.04, 0.36, 0.1, 0, 0), color: C(CO) });
  for (const s of [-1, 1]) rod(b, V(s * 0.24, 0.39, 0.36), V(s * 0.24, 0.9, 0.36), 0.022, K("chrome"), C(CH));
  b.add(rbox(1.62, 0.24, 0.7, 0.1), "fabric", { m: M(0, 0.6, 0.86), color: C(CO) });
  b.add(rbox(1.62, 0.6, 0.17, 0.08), "fabric", { m: M(0, 1.08, 1.28, 0.13, 0, 0), color: C(CO) });
  b.add(rbox(1.66, 0.05, 0.2, 0.02), K("gloss"), { m: M(0, 1.4, 1.32), color: C(BR) });
  for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++) d.add(sph(0.022, 6, 4), "fabric", { m: M(-0.56 + i * 0.28, 0.94 + j * 0.22, 1.185 - j * 0.03), color: C(CR), ...D2 });
  for (let i = 0; i < 5; i++) d.add(sph(0.022, 6, 4), "fabric", { m: M(-0.56 + i * 0.28, 0.722, 0.86), color: C(CR), ...D2 });
  // ---- the nose: an egg-shaped cowl, brown waistband, the cyclops headlight under a chrome brow, two little winkers
  { const egg = new THREE.SphereGeometry(1, 22, 14, Math.PI, Math.PI); egg.scale(0.58, 0.58, 0.4);
    b.add(egg, K("gloss"), { m: M(0, 1.0, -1.0), uv: "local", tile: 2.4, color: C(Y) });
    const band = new THREE.SphereGeometry(1, 22, 3, Math.PI, Math.PI, Math.PI * 0.56, Math.PI * 0.1); band.scale(0.592, 0.592, 0.412);
    b.add(band, K("gloss"), { m: M(0, 1.0, -1.0), uv: "local", tile: 1, color: C(BR) });
    b.add(new THREE.CircleGeometry(1, 22).scale(0.56, 0.56, 1), K("gloss"), { m: M(0, 1.0, -0.995), color: C(BR), shadow: false });   // the dash wall
    b.add(new THREE.TorusGeometry(0.565, 0.028, 6, 26), K("gloss"), { m: M(0, 1.0, -0.99), uv: "local", color: C(YD), lod: 1 });
    for (const [x, y, r] of [[-0.02, 1.2, 0.13], [0.26, 1.08, 0.075]] as const) {
      b.add(new THREE.CircleGeometry(r, 18), K("gloss"), { m: M(x, y, -0.98), color: C(CR), shadow: false, lod: 1 });
      b.add(new THREE.TorusGeometry(r, 0.014, 5, 18), K("chrome"), { m: M(x, y, -0.978), uv: "local", color: C(CH), lod: 1 });
      b.add(box(0.012, r * 0.82, 0.006), "pmetal", { m: M(x + r * 0.2, y + r * 0.22, -0.972, 0, 0, -0.75), color: C(CO), shadow: false, lod: 2 });
    }
    const bez = cyl(0.2, 0.185, 0.1, 20); bez.rotateX(Math.PI / 2);
    b.add(bez, K("chrome"), { m: M(0, 1.14, -1.385), uv: "local", color: C(CH) });
    const lens = new THREE.SphereGeometry(0.165, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2); lens.rotateX(-Math.PI / 2); lens.scale(1, 1, 0.5);
    b.add(lens, K("lamp"), { m: M(0, 1.14, -1.43), color: burnt ? 0x1a1512 : 0xfff1cf });
    // a chrome stone guard: three bars across the glass + the bulb's cap in the middle
    for (const y of [-0.075, 0, 0.075]) rod(b, V(-Math.sqrt(0.168 * 0.168 - y * y), 1.14 + y, -1.455 - 0.055 * (1 - Math.abs(y) / 0.11)), V(Math.sqrt(0.168 * 0.168 - y * y), 1.14 + y, -1.455 - 0.055 * (1 - Math.abs(y) / 0.11)), 0.008, K("chrome"), C(CH), 5, { lod: 1 });
    b.add(sph(0.034, 10, 8), K("chrome"), { m: M(0, 1.14, -1.512), color: C(CH), lod: 1 });
    const brow = new THREE.TorusGeometry(0.21, 0.035, 6, 14, Math.PI); brow.scale(1, 1, 2.2);
    b.add(brow, K("chrome"), { m: M(0, 1.15, -1.4, -0.25, 0, 0), uv: "local", color: C(CH) });
    for (const s of [-1, 1]) {
      b.add(sph(0.062, 12, 8), K("lamp"), { m: M(s * 0.36, 0.86, -1.31, 0, 0, 0, 1, 1, 0.6), color: burnt ? 0x1a1512 : 0xff7a1a });
      b.add(new THREE.TorusGeometry(0.066, 0.014, 5, 12), K("chrome"), { m: M(s * 0.36, 0.86, -1.305, 0, s * -0.5, 0), uv: "local", color: C(CH), lod: 1 });
    }
    if (!burnt) b.add(new THREE.PlaneGeometry(0.26, 0.26), "badge", { m: M(0, 0.72, -1.372, -0.42, Math.PI, 0), uv: "keep", shadow: false, lod: 1 });
    rod(b, V(-0.46, 0.56, -1.22), V(0.46, 0.56, -1.22), 0.035, K("chrome"), C(CH), 10);
    for (const s of [-1, 1]) rod(b, V(s * 0.46, 0.56, -1.22), V(s * 0.5, 0.56, -1.0), 0.035, K("chrome"), C(CH), 8, { lod: 1 });
  }
  // dash shelf + two dials (read from the saddle)
  b.add(rbox(1.0, 0.07, 0.22, 0.03), K("gloss"), { m: M(0, 1.5, -0.93), color: C(BR) });
  // ---- windscreen: raked frame, glass, one wiper
  for (const s of [-1, 1]) rod(b, V(s * 0.53, 1.5, -1.0), V(s * 0.62, 2.03, -0.9), 0.032, K("gloss"), C(BR));
  rod(b, V(-0.62, 2.03, -0.9), V(0.62, 2.03, -0.9), 0.032, K("gloss"), C(BR));
  if (!burnt) {
    const gl = new THREE.PlaneGeometry(1.1, 0.5); b.add(gl, "glass", { m: M(0, 1.775, -0.95, -0.187, 0, 0), uv: "keep", shadow: false });
    rod(d, V(0.05, 1.56, -0.975), V(-0.2, 1.86, -0.93), 0.008, "pmetal", DK, 4, D2);
  }
  // ---- canopy on four posts: chocolate canvas, a banana-yellow top, cream scalloped valance, a pom-pom fringe
  for (const s of [-1, 1]) {
    rod(b, V(s * 0.86, 1.0, 1.42), V(s * 0.86, 2.03, 1.42), 0.034, K("gloss"), C(BR));
    rod(b, V(s * 0.86, 0.4, 0.36), V(s * 0.86, 2.03, 0.36), 0.034, K("gloss"), C(BR));
    rod(b, V(s * 0.62, 2.03, -0.9), V(s * 0.86, 2.03, 0.36), 0.03, K("gloss"), C(BR), 6, { lod: 1 });
  }
  if (!burnt) {
    roof.add(rbox(1.92, 0.09, 2.72, 0.045), "fabric", { m: M(0, 2.075, 0.3), color: BR });
    roof.add(rbox(1.72, 0.035, 2.5, 0.015), "fabric", { m: M(0, 2.13, 0.3), color: Y });
    { const crown = new THREE.SphereGeometry(1, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2); crown.scale(0.84, 0.085, 1.23); roof.add(crown, "fabric", { m: M(0, 2.143, 0.3), uv: "local", tile: 1, color: Y }); }
    // valance: scallops (half discs) alternating cream / yellow all round
    const scal = (x: number, y: number, z: number, ry: number, i: number) => { const g = new THREE.CircleGeometry(0.085, 8, Math.PI, Math.PI); roof.add(g, "fabric", { m: M(x, y, z, 0, ry, 0), uv: "keep", color: i % 2 ? CR : Y, shadow: false, lod: 1 }); };
    for (let i = 0; i < 16; i++) { const z = -0.97 + i * 0.17; scal(-0.962, 2.035, z, -Math.PI / 2, i); scal(0.962, 2.035, z, Math.PI / 2, i); }
    for (let i = 0; i < 11; i++) { const x = -0.85 + i * 0.17; scal(x, 2.035, 1.662, 0, i); scal(x, 2.035, -1.062, Math.PI, i); }
    // the fringe: pom-poms in coral / turquoise / cream
    const POM = [CO, TQ, CR];
    for (let i = 0; i < 15; i++) for (const s of [-1, 1]) d.add(sph(0.042, 6, 5), "fabric", { m: M(s * 0.965, 1.93, -0.9 + i * 0.176), color: POM[i % 3], ...D2 });
    for (let i = 0; i < 10; i++) d.add(sph(0.042, 6, 5), "fabric", { m: M(-0.79 + i * 0.176, 1.93, 1.665), color: POM[(i + 1) % 3], ...D2 });
    // a string of little lamps along the rear edge
    for (let i = 0; i < 6; i++) d.add(sph(0.034, 6, 5), "lamp", { m: M(-0.7 + i * 0.28, 1.985, 1.68), color: i % 2 ? 0xffd27a : 0xff8a5a, ...D2 });
    // ---- the TAXI lightbox with a giant banana lying on it
    roof.add(rbox(0.78, 0.26, 0.2, 0.05), "gloss", { m: M(0, 2.31, -0.62), color: Y });
    for (const s of [-1, 1]) { const f = new THREE.PlaneGeometry(0.7, 0.2); roof.add(f, taxiSign(false), { m: M(0, 2.31, -0.62 + s * 0.102, 0, s > 0 ? 0 : Math.PI, 0), uv: "keep", shadow: false }); }
    for (const s of [-1, 1]) roof.add(rbox(0.06, 0.12, 0.12, 0.02), "pmetal", { m: M(s * 0.26, 2.17, -0.62), color: DK, lod: 1 });
    roof.add(bigBanana(1.16, 0.082, false), "bananaFruit", { m: M(0, 2.445 + 0.078, -0.62, 0.12, 0, 0), uv: "keep" });
    // ---- roof rack: a BANANA CO. crate heaped with ripe hands, strapped down, and a rolled beach mat
    for (const s of [-1, 1]) rod(roof, V(s * 0.7, 2.2, -0.05), V(s * 0.7, 2.2, 1.45), 0.02, "chrome", CH, 6, { lod: 1 });
    for (const z of [0.0, 0.7, 1.4]) rod(roof, V(-0.7, 2.2, z), V(0.7, 2.2, z), 0.02, "chrome", CH, 6, { lod: 1 });
    crate(roof, M(-0.12, 2.2, 0.72, 0, Math.PI / 2 + 0.06, 0, 0.82));
    const hand = bananaHand(true);
    for (let i = 0; i < 9; i++) { const a = i * 2.4, r = 0.1 + (i % 3) * 0.1; roof.add(hand, "bananaFruit", { m: M(-0.12 + Math.cos(a) * r * 0.9, 2.86 + (i % 4) * 0.035 + (i < 3 ? 0.07 : 0), 0.72 + Math.sin(a) * r * 1.3, (i % 3 - 1) * 0.35, a, 0.2, 1.75), uv: "keep", color: new THREE.Color().setHSL(0.135, 0.9, 0.86), shadow: false, lod: 1 }); }
    for (const z of [0.42, 1.02]) roof.add(box(0.72, 0.012, 0.045), "rubber", { m: M(-0.12, 2.875, z), color: 0x1d1d1d, lod: 2 });
    const mat2 = cyl(0.11, 0.11, 1.3, 12); mat2.rotateX(Math.PI / 2);
    roof.add(mat2, "fabric", { m: M(0.56, 2.31, 0.72), uv: "local", tile: 0.4, color: TQ, lod: 1 });
    for (const z of [0.3, 1.14]) { const st = cyl(0.115, 0.115, 0.05, 12); st.rotateX(Math.PI / 2); roof.add(st, "fabric", { m: M(0.56, 2.31, z), color: CR, lod: 2 }); }
  } else {
    // the wreck: a buckled frame where the canopy was
    rod(b, V(-0.86, 2.03, 0.36), V(0.86, 1.9, 0.36), 0.03, "pmetal", C(BR));
    rod(b, V(-0.86, 1.92, 1.42), V(0.86, 2.03, 1.42), 0.03, "pmetal", C(BR));
    for (const s of [-1, 1]) rod(b, V(s * 0.86, 2.03, 0.36), V(s * 0.86, s > 0 ? 2.03 : 1.92, 1.42), 0.03, "pmetal", C(BR));
  }
  // exhaust: a fat chrome can + a kinked tail pipe on the right
  { const can = cyl(0.085, 0.085, 0.5, 12); can.rotateX(Math.PI / 2); b.add(can, K("chrome"), { m: M(0.6, 0.27, 1.42), uv: "local", color: C(0xbdbdbd) });
    rod(b, V(0.6, 0.27, 1.66), V(0.7, 0.33, 1.84), 0.04, K("chrome"), C(CH), 10); }
  // spare wheel cover on the back (a yellow disc with a brown ring)
  { const cover = cyl(0.3, 0.3, 0.14, 20); cover.rotateX(Math.PI / 2); b.add(cover, K("gloss"), { m: M(-0.0, 1.0, 1.72), uv: "local", color: C(YD) });
    const ring = new THREE.TorusGeometry(0.3, 0.05, 8, 20); b.add(ring, "rubber", { m: M(0, 1.0, 1.72), uv: "local", color: C(0x1d1c1b) });
    if (!burnt) b.add(new THREE.PlaneGeometry(0.34, 0.34), "badge", { m: M(0, 1.0, 1.795), uv: "keep", shadow: false, lod: 1 }); }

  // ------------------------------------------------------------------------------------------------ brake lamps (shown while braking)
  const br = mk();
  for (const s of [-1, 1]) br.add(rbox(0.17, 0.21, 0.075, 0.03), "lampRed", { m: M(s * 0.7, 0.78, 1.632), shadow: false });

  // ------------------------------------------------------------------------------------------------ steering: the bars (sprung)
  // in the HEAD frame: +Y up the steering axis, +Z back toward the saddle
  const bars = mk();
  rod(bars, V(0, -0.1, 0), V(0, 0.2, 0), 0.04, K("chrome"), C(CH), 10);
  rod(bars, V(-0.25, 0.2, 0.03), V(0.25, 0.2, 0.03), 0.026, K("chrome"), C(CH), 8);
  for (const s of [-1, 1]) {
    rod(bars, V(s * 0.25, 0.2, 0.03), V(s * 0.36, 0.21, 0.3), 0.024, K("chrome"), C(CH), 8);
    rod(bars, V(s * 0.36, 0.21, 0.26), V(s * 0.36, 0.2, 0.44), 0.036, "rubber", C(CO), 10);          // grip
    bars.add(sph(0.04, 8, 6), K("chrome"), { m: M(s * 0.36, 0.2, 0.45), color: C(CH), lod: 1 });
    if (!burnt) for (let k = 0; k < 4; k++) bars.add(box(0.008, 0.16, 0.014), "fabric", { m: M(s * 0.36 + (k - 1.5) * 0.012, 0.11, 0.47 + (k % 2) * 0.012, 0.25 + (k % 2) * 0.2, 0, (k - 1.5) * 0.12), color: k % 2 ? CO : TQ, ...D2 });   // tassels
    // round scooter mirrors on stalks
    rod(bars, V(s * 0.2, 0.2, 0.03), V(s * 0.44, 0.48, 0.0), 0.012, K("chrome"), C(CH), 5, { lod: 1 });
    const mir = cyl(0.095, 0.095, 0.025, 14); mir.rotateX(Math.PI / 2); bars.add(mir, K("chrome"), { m: M(s * 0.44, 0.5, 0.0, 0, s * -0.25, 0), uv: "local", color: C(CH), lod: 1 });
  }
  bars.add(rbox(0.16, 0.07, 0.1, 0.02), "pmetal", { m: M(0, 0.24, 0.02), color: C(DK), lod: 1 });

  // ------------------------------------------------------------------------------------------------ steering: fork + mudguard (unsprung)
  const fork = mk();
  for (const s of [-1, 1]) rod(fork, V(s * 0.19, -0.12, 0), V(s * 0.19, -FORK_L, 0), 0.036, K("chrome"), C(CH), 8);
  rod(fork, V(-0.2, -0.14, 0), V(0.2, -0.14, 0), 0.04, K("chrome"), C(CH), 8);
  { const fender = new THREE.TorusGeometry(0.44, 0.125, 8, 16, Math.PI * 1.02); fender.scale(1, 1, 1.5);
    fork.add(fender, K("gloss"), { m: M(0, -FORK_L, 0, RAKE - 0.05, Math.PI / 2, 0), uv: "local", tile: 1, color: C(Y) });
    fork.add(rbox(0.3, 0.045, 0.2, 0.015), "rubber", { m: M(0, -FORK_L - 0.1, 0.5, 0.5, 0, 0), color: C(0x1b1b1b), lod: 1 }); }

  // ------------------------------------------------------------------------------------------------ one wheel (axle along X)
  const w = mk();
  wheel(w, M(0, 0, 0, 0, Math.PI / 2, 0), TUK.WHEEL_R, 0.27, { rim: C(Y), rimMat: K("gloss"), lugs: 14, lugH: 0.03 });

  // ------------------------------------------------------------------------------------------------ the small moving bits
  const aerial = mk();
  rod(aerial, V(0, 0, 0), V(0, 1.15, 0), 0.008, K("chrome"), C(CH), 5);
  if (!burnt) { const pen = new THREE.BufferGeometry(); pen.setAttribute("position", new THREE.Float32BufferAttribute([0, 1.14, 0, 0, 0.98, 0, 0, 1.06, 0.34], 3)); pen.computeVertexNormals(); aerial.add(pen, "fabric", { uv: "box", color: CO, shadow: false }); aerial.add(sph(0.022, 6, 5), "bananaFruit", { m: M(0, 1.16, 0), color: Y }); }
  const dice = mk();
  if (!burnt) {
    rod(dice, V(0, 0, 0), V(-0.035, -0.17, 0), 0.004, "pmetal", DK, 4, D2); rod(dice, V(0, 0, 0), V(0.04, -0.23, 0), 0.004, "pmetal", DK, 4, D2);
    dice.add(rbox(0.075, 0.075, 0.075, 0.015), "fabric", { m: M(-0.035, -0.205, 0, 0.3, 0.5, 0.2), color: CR, ...D2 });
    dice.add(rbox(0.075, 0.075, 0.075, 0.015), "fabric", { m: M(0.04, -0.265, 0, 0.6, 0.2, 0.5), color: CO, ...D2 });
  }
  const bulb = mk();
  bulb.add(sph(0.075, 10, 8), "rubber", { m: M(0, 0, 0), color: C(0x1c1c1c) });

  // the horn's brass trumpet (fixed) rides with the body
  { const horn = new THREE.CylinderGeometry(0.02, 0.105, 0.36, 12, 1, true); horn.rotateX(-Math.PI / 2);
    b.add(horn, K("steel"), { m: M(-0.68, 1.58, -1.12, -0.12, 0.2, 0), uv: "local", color: C(BRASS) });
    const flare = new THREE.TorusGeometry(0.105, 0.014, 6, 14); b.add(flare, K("steel"), { m: M(-0.716, 1.6, -1.296, -0.12, 0.2, 0), uv: "local", color: C(BRASS), lod: 1 });
    rod(b, V(-0.6, 1.5, -0.98), V(-0.66, 1.57, -1.0), 0.016, K("chrome"), C(CH), 5, { lod: 1 }); }

  const parts: Parts = { body: fin(b, "tuk:body"), detail: fin(d, "tuk:detail"), roof: fin(roof, "tuk:roof"), bars: fin(bars, "tuk:bars"), fork: fin(fork, "tuk:fork"), wheel: fin(w, "tuk:wheel"), brake: fin(br, "tuk:brake"), aerial: fin(aerial, "tuk:aerial"), dice: fin(dice, "tuk:dice"), bulb: fin(bulb, "tuk:bulb") };
  return parts;
}

/** what the renderer feeds a vehicle each frame (the drawn pose + state of client.ts VehRemote). A helicopter reads
 * `steer` as its rotor's spool and `vy` as its climb (m/s, from the drawn motion). */
export interface TukDraw { x: number; y: number; z: number; yaw: number; pitch: number; roll: number; vf: number; vy: number; steer: number; hp: number; flags: number; st: number;
  /** the flat tyres (shared/sim/vehicle.ts TYRE): each runs on its rim and that corner of the body sinks */
  tyres: number;
  // ---- a helicopter's door gun, TOP BANANA (shared/sim/heli.ts; render.ts fills these for helicopters only). The gun
  // swings on HELI.GUN_PIVOT (body frame); its barrels reach HELI.GUN_LEN out to the muzzle.
  /** turret yaw relative to the body (rad): 0 = straight out of the left door along −X, + = swung toward the nose
   * (within ±HELI.GUN_ARC_YAW) */
  gunYaw?: number;
  /** turret pitch relative to the body (rad), + = up (HELI.GUN_PITCH_MIN..MAX) */
  gunPitch?: number;
  /** barrel spin 0..1 (1 = full speed: firing) */
  gunSpin?: number;
  /** barrel heat 0..1 (1 = overheated) */
  gunHeat?: number;
  /** rounds fired since the previous draw (0 most frames): the muzzle flash */
  gunFire?: number }
/** one vehicle in the scene — a tuk-tuk (createTukTuk) or a helicopter (actors/heli-tripo.ts createHeli): the same handle */
export interface TukView {
  object: THREE.Group;
  /** what it is (shared/sim/vehicle.ts VKind) */
  readonly kind: number;
  /** drawn state → transforms + its own little motions (springs, wheels, the bulb) */
  update(s: TukDraw, dt: number, t: number, cam: THREE.Vector3): void;
  /** world position of a handlebar grip (the driver's fists), of the exhaust tip and of the engine lid (smoke, fire) */
  grip(side: 1 | -1, out: THREE.Vector3): THREE.Vector3;
  exhaust(out: THREE.Vector3): THREE.Vector3;
  engine(out: THREE.Vector3): THREE.Vector3;
  /** a wheel hub in the world (0 = front, 1 = rear left, 2 = rear right) — dust, sparks, the wreck's flying wheels */
  hub(i: number, out: THREE.Vector3): THREE.Vector3;
  /** kick the body on its springs (a hard landing, a slam back onto three wheels, a hit) */
  bump(up: number, roll?: number): void;
  /** the local driver's saddle view — the fuzzy dice and the small detail (the wiper across the windscreen, the
   * fringe) are not drawn */
  firstPerson: boolean;
  /** a helicopter's door gun: the world position of the barrels' tip as last drawn (the minigun's tracers start here) */
  muzzle?(out: THREE.Vector3): THREE.Vector3;
  /** every drawn part for the prewarm compile */
  readonly wreck: boolean;
  dispose(): void;
}

let SHARED: Parts | null = null, SHARED_WRECK: Parts | null = null;
/** the merged geometry is built once and shared by every tuk-tuk (each instance only owns its transforms) */
function partsFor(burnt: boolean): Parts { return burnt ? (SHARED_WRECK ??= build(true)) : (SHARED ??= build(false)); }
const share = (g: THREE.Group) => { const c = g.clone(); return c; };

/** one tuk-tuk in the scene */
export function createTukTuk(): TukView {
  const root = new THREE.Group(); root.name = "tuk-tuk"; root.rotation.order = "YXZ";
  const lean = new THREE.Group(), cabin = new THREE.Group();
  root.add(lean); lean.add(cabin);
  let P: Parts = partsFor(false), wreck = false;
  const headC = new THREE.Group(), headU = new THREE.Group(), steerC = new THREE.Group(), steerU = new THREE.Group();
  for (const h of [headC, headU]) { h.position.set(HEAD[0], HEAD[1], HEAD[2]); h.rotation.x = RAKE; }
  headC.add(steerC); headU.add(steerU); cabin.add(headC); lean.add(headU);
  const wF = new THREE.Group(), wL = new THREE.Group(), wR = new THREE.Group();
  wF.position.set(0, -FORK_L, 0); steerU.add(wF);
  wL.position.set(-TUK.HW, TUK.WHEEL_R, TUK.REAR); wR.position.set(TUK.HW, TUK.WHEEL_R, TUK.REAR); wR.rotation.y = Math.PI;
  lean.add(wL, wR);
  const aerial = new THREE.Group(), dice = new THREE.Group(), bulb = new THREE.Group(), brake = new THREE.Group(), detail = new THREE.Group();
  aerial.position.set(0.86, 2.08, 1.42); dice.position.set(0, 2.0, -0.9); bulb.position.set(-0.62, 1.53, -0.93);
  cabin.add(aerial, dice, bulb, brake, detail);
  const gripR = new THREE.Object3D(), gripL = new THREE.Object3D(), exh = new THREE.Object3D(), eng = new THREE.Object3D();
  gripR.position.set(0.36, 0.2, 0.35); gripL.position.set(-0.36, 0.2, 0.35); steerC.add(gripR, gripL);
  exh.position.set(0.72, 0.34, 1.9); eng.position.set(0, 1.0, 1.35); cabin.add(exh, eng);
  let bodyG: THREE.Group, roofG: THREE.Group;
  const dress = () => {
    for (const g of [cabin, steerC, steerU, wF, wL, wR, aerial, dice, bulb, brake, detail]) for (const c of [...g.children]) if ((c as THREE.Group).isGroup && c.name.startsWith("tuk:")) g.remove(c);
    bodyG = share(P.body); roofG = share(P.roof);
    cabin.add(bodyG, roofG); detail.add(share(P.detail)); steerC.add(share(P.bars)); steerU.add(share(P.fork));
    wF.add(share(P.wheel)); wL.add(share(P.wheel)); wR.add(share(P.wheel));
    aerial.add(share(P.aerial)); dice.add(share(P.dice)); bulb.add(share(P.bulb)); brake.add(share(P.brake));
    brake.visible = false;
  };
  dress();
  // ---- its own little motions
  let spin = 0, steer = 0, lastVf = 0, lastYaw = 0, have = false;
  let bY = 0, bV = 0, rollS = 0, rollV = 0, pitS = 0, pitV = 0;         // cabin springs: heave, lean, squat / dive
  let aX = 0, aXV = 0, aZ = 0, aZV = 0, dX = 0, dXV = 0, dZ = 0, dZV = 0; // aerial + dice pendulums
  let hornK = 0, shake = 0;
  let sagY = 0, sagP = 0, sagR = 0, tyres = 0;                          // the body settling onto its flat tyres
  const Q = new THREE.Vector3();
  const view: TukView = {
    object: root, firstPerson: false, kind: 0,
    get wreck() { return wreck; },
    update(s, dt, t, cam) {
      const isWreck = s.st === VS.Wreck;
      if (isWreck !== wreck) { wreck = isWreck; P = partsFor(wreck); dress(); }
      root.position.set(s.x, s.y, s.z); root.rotation.set(s.pitch, s.yaw, s.roll, "YXZ");
      const d2 = (cam.x - s.x) ** 2 + (cam.y - s.y) ** 2 + (cam.z - s.z) ** 2;
      detail.visible = d2 < DETAIL_M * DETAIL_M && !view.firstPerson; aerial.visible = d2 < DETAIL_M * DETAIL_M; dice.visible = detail.visible;
      if (s.tyres !== tyres) {
        tyres = s.tyres;
        wF.scale.set(1, tyres & TYRE.FRONT ? FLAT_K : 1, tyres & TYRE.FRONT ? FLAT_K : 1);
        wL.scale.set(1, tyres & TYRE.LEFT ? FLAT_K : 1, tyres & TYRE.LEFT ? FLAT_K : 1);
        wR.scale.set(1, tyres & TYRE.RIGHT ? FLAT_K : 1, tyres & TYRE.RIGHT ? FLAT_K : 1);
      }
      if (wreck) { lean.rotation.set(0, 0, 0.07); lean.position.y = -0.06; cabin.position.y = 0; cabin.rotation.set(0.05, 0, 0); return; }
      dt = Math.min(dt, 0.05);
      // what the body feels: forward / sideways acceleration from the drawn motion itself
      let dyaw = have ? s.yaw - lastYaw : 0; if (dyaw > Math.PI) dyaw -= Math.PI * 2; else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const acc = have && dt > 1e-4 ? Math.max(-30, Math.min(30, (s.vf - lastVf) / dt)) : 0, lat = dt > 1e-4 ? Math.max(-30, Math.min(30, s.vf * dyaw / dt)) : 0;
      lastVf = s.vf; lastYaw = s.yaw; have = true;
      const running = s.st === VS.Ok && (s.flags & VF.PARK) === 0, upright = Math.abs(s.roll) < 0.9;
      // ---- wheels + bars
      spin += (s.vf / TUK.WHEEL_R) * dt;
      wF.rotation.x = -spin; wL.rotation.x = -spin; wR.rotation.x = spin;
      steer += (s.steer - steer) * Math.min(1, dt * 18);
      steerC.rotation.y = steer; steerU.rotation.y = steer;
      // ---- the cabin on its springs: leans OUT of a turn (lat > 0 = turning left → the top goes right), squats under
      // power, dives under brakes, heaves over bumps, and the two-stroke shakes it at idle
      const k = 150, c = 13;
      const rollT = upright ? Math.max(-0.085, Math.min(0.085, -lat * 0.0042)) : 0, pitT = upright ? Math.max(-0.05, Math.min(0.06, acc * 0.0045)) : 0;
      rollV += ((rollT - rollS) * k - rollV * c) * dt; rollS += rollV * dt;
      pitV += ((pitT - pitS) * k - pitV * c) * dt; pitS += pitV * dt;
      bV += (-bY * 230 - bV * 12) * dt; bY += bV * dt;
      if (running && upright) bV += (Math.sin(t * 31.7 + s.x) + Math.sin(t * 17.3 + s.z)) * Math.min(1, Math.abs(s.vf) / 9) * 1.1 * dt * 6;   // road chatter
      shake = running ? 1 : Math.max(0, shake - dt * 3);
      const idle = running ? (1 - Math.min(1, Math.abs(s.vf) / 6)) * 0.0035 + 0.0012 : 0;
      // the body rests on the plane through the three hubs, as shared/sim/vehicle.ts wheels() lays it on the road
      const drop = TUK.WHEEL_R * (1 - FLAT_K), hF = tyres & TYRE.FRONT ? -drop : 0, hL = tyres & TYRE.LEFT ? -drop : 0, hR = tyres & TYRE.RIGHT ? -drop : 0, hB = (hL + hR) / 2;
      const kS = Math.min(1, dt * 10);
      sagY += (hB + (hF - hB) * (TUK.REAR / TUK.WHEELBASE) - sagY) * kS; sagP += ((hF - hB) / TUK.WHEELBASE - sagP) * kS; sagR += ((hR - hL) / (2 * TUK.HW) - sagR) * kS;
      lean.rotation.set(sagP, 0, rollS + sagR); lean.position.y = TUK.HW * Math.abs(Math.sin(rollS)) + sagY;
      cabin.position.set(Math.sin(t * 43) * idle, Math.max(-0.07, Math.min(0.09, bY)) + Math.sin(t * 57 + 1) * idle, 0);
      cabin.rotation.set(pitS, 0, Math.sin(t * 49 + 2) * idle * 0.6);
      // ---- pendulums: the aerial whips against the motion, the dice swing
      const px = -acc * 0.012, pz = lat * 0.012;
      aXV += ((px * 1.4 - aX) * 90 - aXV * 3.2) * dt; aX += aXV * dt; aZV += ((pz * 1.4 - aZ) * 90 - aZV * 3.2) * dt; aZ += aZV * dt;
      dXV += ((px * 2.4 - dX) * 38 - dXV * 2.2) * dt; dX += dXV * dt; dZV += ((pz * 2.4 - dZ) * 38 - dZV * 2.2) * dt; dZ += dZV * dt;
      aerial.rotation.set(Math.max(-0.7, Math.min(0.7, aX - Math.abs(s.vf) * 0.012)), 0, Math.max(-0.7, Math.min(0.7, aZ)));
      dice.rotation.set(Math.max(-1.1, Math.min(1.1, dX)), 0, Math.max(-1.1, Math.min(1.1, dZ)));
      // ---- the horn's rubber bulb squeezes while it honks; the brake lamps light
      hornK += (((s.flags & VF.HORN) ? 1 : 0) - hornK) * Math.min(1, dt * 22);
      const sq = 1 - 0.45 * hornK * (0.75 + 0.25 * Math.sin(t * 38));
      bulb.scale.set(1 + (1 - sq) * 0.5, sq, 1 + (1 - sq) * 0.5);
      brake.visible = (s.flags & (VF.BRAKE | VF.PARK)) === VF.BRAKE;
    },
    grip(side, out) { root.updateWorldMatrix(true, true); return (side > 0 ? gripR : gripL).getWorldPosition(out); },
    exhaust(out) { exh.updateWorldMatrix(true, false); return exh.getWorldPosition(out); },
    engine(out) { eng.updateWorldMatrix(true, false); return eng.getWorldPosition(out); },
    hub(i, out) { const w = i === 0 ? wF : i === 1 ? wL : wR; w.updateWorldMatrix(true, false); return w.getWorldPosition(out); },
    bump(up, roll = 0) { bV += up; rollV += roll; },
    dispose() { root.removeFromParent(); },
  };
  void Q; void mat; void mul; void COD;
  return view;
}

/** loose pieces of a tuk-tuk for the bang: [a wheel, the canopy with its cargo, the bars] — fresh objects, the caller
 * owns them (client/src/game/tuk-fx.ts throws them about) */
export function tukDebris(): THREE.Object3D[] {
  const P = partsFor(true), F = partsFor(false);
  const roof = share(F.roof); roof.position.y = -2.1;
  const lid = new THREE.Group(); lid.add(roof);
  const bars = new THREE.Group(); bars.add(share(P.bars));
  return [share(P.wheel), share(P.wheel), share(P.wheel), lid, bars];
}
/** one of each (fresh + wreck) for the prewarm compile */
export function tukPrefabs(): THREE.Object3D[] {
  const a = createTukTuk(), b = createTukTuk();
  b.update({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vf: 0, vy: 0, steer: 0, hp: 0, flags: 0, st: VS.Wreck, tyres: 0 }, 0.016, 0, new THREE.Vector3());
  const g = new THREE.Group(); g.add(a.object, b.object); b.object.position.x = 3;
  a.object.traverse((o) => { o.visible = true; });
  return [g];
}
