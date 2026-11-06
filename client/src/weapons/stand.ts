// The BANANA STAND kiosk, a tropical fruit stand:
//   • a counter painted banana-yellow (the solid part — shared/sim/economy.ts STAND_SIZE: 2.4 × 1.15 × 1.3 m)
//     with the Banana Bucks coin on a dark plaque, a plank top, a tilted crate of bananas and a tiered display of what the
//     stand sells (shield smoothie, leaf bundle, banana bomb, coconut crate wall, ammo, a stack of Bucks), a service bell
//   • a straw-thatched gable roof (ragged shingled courses, its own straw texture) on four bamboo posts, banana leaves
//     draped over the ridge, bananas hanging at the corners, a reed screen at the back
//   • a hand-painted BANANA STAND board on the ridge with a big banana on top (the silhouette that reads from afar)
//   • the shopkeeper: a little monkey in a banana-yellow cap and apron behind the counter — breathes, looks round, keeps
//     his eyes on you, waves when you walk up and hops when you buy (tickStands, once per frame; near stands only)
// Origin = floor centre, +Z = the customers' side. Vertex-coloured PartBuilder parts on the weapons' shared
// materials (one draw per material kind) + the thatch and the sign; the monkey and the small display pieces (the
// "detail" group) stop drawing past DETAIL_M and cast no shadow. 16 stands per match (one per named POI).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { PartBuilder, type Built } from "./lib/builder";
import { bananaGeometry, extrude, rbox, rope, tf } from "./lib/geo";
import { rng, type Kind } from "./lib/mats";
import { cashStack, crateWallPack } from "./loot-lane";
import { BANANA_PATH, drawCoin } from "../ui/coin";

/** counter top surface (m) */
const TOP = 1.06;
/** roof: ridge height, eave height, eave distance from the ridge line (z), half length along X */
const RIDGE = 3.14, EAVE = 2.42, EZ = 1.06, RX = 1.55;
const SLOPE = Math.atan2(RIDGE - EAVE, EZ);
/** the monkey and the small display pieces stop drawing past this distance (m) */
const DETAIL_M = 55;
/** the monkey's feet (on his crate behind the counter) and his scale (≈ 1.2 m with the cap: little next to a kong) */
const MONKEY_AT: [number, number, number] = [0.0, 0.46, -0.3], MONKEY_S = 1.18;
const PAINT = ["#f3c22f", "#ecb627", "#f6ca3b", "#e9b024", "#f2c02c", "#eeb92a", "#f5c636", "#e6ad22"];
const WOOD = ["#b47d45", "#a46f3b", "#bd884f", "#a9763f", "#9f6a36", "#b78249"];
const STRAW = ["#f0d8a0", "#e6c98a", "#f6e2b0", "#ead095", "#e2c27e"];

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const M = (p: [number, number, number], r: [number, number, number] = [0, 0, 0], s: number | [number, number, number] = 1) => tf(p, r, s);

/** a banana coloured along its own length (stem → tip): a deeper yellow at both ends */
function paintedBanana(b: PartBuilder, o: { length: number; radius: number; bend?: number; along?: number; radial?: number; squash?: number }, m: THREE.Matrix4, deep = "#d38f08", mid = "#f6c21a", kind: Kind = "gloss") {
  const g = bananaGeometry({ facets: 5, round: 0.5, along: 10, radial: 8, bend: 0.95, ...o });
  const px = g.attributes.position as THREE.BufferAttribute, A = new THREE.Color(deep), B = new THREE.Color(mid), c = new THREE.Color();
  b.addPainted(g, (_p, k) => { const t = px.getX(k) / o.length; return c.lerpColors(A, B, Math.min(1, Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 1.6)); }, kind, m);
}

/** a ripe banana up close (fingers deep yellow at both ends read as carrots):
 *  a green neck at the stem, lemon-banana yellow along the body, a brown-black flower tip. `green` 0..1 = how unripe */
const BAN_NECK = new THREE.Color("#5f7d22"), BAN_GREEN = new THREE.Color("#a9bd3c"), BAN_YELLOW = new THREE.Color("#f3dc45"), BAN_TIP = new THREE.Color("#4a3214");
function ripeBanana(b: PartBuilder, o: { length: number; radius: number; bend?: number; along?: number; radial?: number }, m: THREE.Matrix4, green = 0, kind: Kind = "matte") {
  const g = bananaGeometry({ facets: 5, round: 0.5, along: 10, radial: 8, bend: 0.95, ...o });
  const px = g.attributes.position as THREE.BufferAttribute, c = new THREE.Color(), body = BAN_YELLOW.clone().lerp(BAN_GREEN, green);
  b.addPainted(g, (_p, k) => {
    const t = Math.min(1, Math.max(0, px.getX(k) / o.length));
    if (t < 0.08) return c.copy(BAN_NECK);
    if (t < 0.24) return c.lerpColors(BAN_NECK, body, (t - 0.08) / 0.16);
    if (t < 0.9) return c.copy(body);
    return c.lerpColors(body, BAN_TIP, Math.min(1, (t - 0.9) / 0.06));
  }, kind, m);
}

/** a "hand" of bananas: n fingers side by side, stems at a small crown (origin), lying along +X and curling up (+Y) */
function hand(b: PartBuilder, n: number, len: number, rad: number, m: THREE.Matrix4, seed: number) {
  const r = rng(seed), green = r() * 0.3;
  for (let i = 0; i < n; i++) {
    const mm = new THREE.Matrix4().makeRotationY((i - (n - 1) / 2) * 0.19 + (r() - 0.5) * 0.06)
      .multiply(new THREE.Matrix4().makeRotationX((r() - 0.5) * 0.18)).multiply(new THREE.Matrix4().makeTranslation(0.01, 0, 0)).premultiply(m);
    // slimmer than before (a banana is ~7× as long as it is wide), curved
    ripeBanana(b, { length: len * (0.9 + r() * 0.18), radius: rad * (0.8 + r() * 0.1), bend: 1.05, along: 9, radial: 6 }, mm, green + r() * 0.08);
  }
  b.add(new THREE.CylinderGeometry(rad * 0.55, rad * 0.75, rad * 1.6, 6).rotateZ(Math.PI / 2), "#6f6a2a", "matte", m.clone().multiply(new THREE.Matrix4().makeTranslation(-0.004, 0, 0)));
}

/** a bunch hanging from a hook: a stalk with tiers of fingers pointing out and up */
function hangingBunch(b: PartBuilder, at: THREE.Vector3, seed: number) {
  const r = rng(seed);
  b.add(new THREE.CylinderGeometry(0.018, 0.024, 0.34, 6), "#6a6326", "matte", M([at.x, at.y - 0.17, at.z]));
  for (let tier = 0; tier < 3; tier++) for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + tier * 0.8 + r() * 0.2, y = at.y - 0.1 - tier * 0.09;
    const m = new THREE.Matrix4().makeTranslation(at.x, y, at.z).multiply(new THREE.Matrix4().makeRotationY(a)).multiply(new THREE.Matrix4().makeRotationZ(1.0 + r() * 0.2));
    ripeBanana(b, { length: 0.18 + r() * 0.03, radius: 0.023, bend: 0.85, along: 6, radial: 5 }, m, 0.15 + r() * 0.25, "gloss");
  }
  b.add(rope([V(at.x, at.y, at.z), V(at.x + 0.01, at.y + 0.08, at.z), V(at.x, at.y + 0.16, at.z)], 0.008, false, 0.03, 5, 6), "#cfa66a", "rope");
}

/** a bamboo pole from a to b (node rings optional) */
function bamboo(b: PartBuilder, a: THREE.Vector3, e: THREE.Vector3, r: number, col = "#cdb56b", node: string | null = "#94803d") {
  const d = new THREE.Vector3().subVectors(e, a), L = d.length(), mid = new THREE.Vector3().addVectors(a, e).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  b.add(new THREE.CylinderGeometry(r, r * 1.06, L, 8, 1), col, "matte", new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)));
  if (!node) return;
  const n = Math.max(1, Math.round(L / 0.6));
  for (let k = 1; k < n; k++) {
    const p = a.clone().addScaledVector(d, k / n);
    b.add(new THREE.TorusGeometry(r * 1.02, r * 0.17, 4, 8).rotateX(Math.PI / 2), node, "matte", new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
  }
}

/** the display's fruit: a plain satin material (the weapons' painted materials wear small curved parts pale — a crate of
 *  bananas under the thatch read cream, not yellow) */
let fruitMat: THREE.MeshStandardMaterial | null = null;
function fruitMaterial(): THREE.MeshStandardMaterial {
  if (!fruitMat) { fruitMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0, envMapIntensity: 0.6 }); fruitMat.name = "banana-stand-fruit"; }
  return fruitMat;
}

// ------------------------------------------------------------------------------------------------ thatch
let thatchMat: THREE.MeshStandardMaterial | null = null;
/** straw: golden fibres running down the slope (v), darker grooves, a few loose light strands (tiles every ~0.6 m) */
function thatchMaterial(): THREE.MeshStandardMaterial {
  if (thatchMat) return thatchMat;
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const x = c.getContext("2d")!, r = rng(57);
  x.fillStyle = "#d6b469"; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1500; i++) {
    const px = r() * 256, py = r() * 256, len = 26 + r() * 70, tilt = (r() - 0.5) * 0.18, dark = r() < 0.45;
    x.strokeStyle = dark ? `rgba(${110 + r() * 30 | 0},${75 + r() * 25 | 0},${25 + r() * 15 | 0},${0.18 + r() * 0.3})` : `rgba(${245 + r() * 10 | 0},${222 + r() * 25 | 0},${150 + r() * 50 | 0},${0.22 + r() * 0.35})`;
    x.lineWidth = 0.8 + r() * 2.2;
    for (const ox of [0, 256]) for (const oy of [0, 256]) { x.beginPath(); x.moveTo(px - ox, py - oy); x.lineTo(px - ox + Math.sin(tilt) * len, py - oy + Math.cos(tilt) * len); x.stroke(); }
  }
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = 8;
  map.repeat.set(1.7, 1.7);
  thatchMat = new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.96, metalness: 0 });
  thatchMat.name = "banana-stand-thatch";
  return thatchMat;
}
/** one thatch course: a straw slab whose lower edge is a ragged fringe (2-D outline extruded, x along the ridge; the
 *  outline's y runs up the slope, 0 at the course's top edge) */
function thatchCourse(len: number, depth: number, thick: number, seed: number): THREE.BufferGeometry {
  const r = rng(seed), pts: Array<[number, number]> = [[-len / 2, 0], [len / 2, 0]];
  const teeth = Math.round(len / 0.1);
  for (let i = teeth; i >= 0; i--) {
    const x = -len / 2 + (i / teeth) * len + (i > 0 && i < teeth ? (r() - 0.5) * 0.035 : 0);
    pts.push([x, -depth - (i % 2 ? 0.01 + r() * 0.03 : 0.06 + r() * 0.09)]);
  }
  return extrude(pts, thick, 0, 1);
}
/** both slopes of the roof as one mesh (the straw material), courses shingled: each higher course lies over the one below */
function thatchRoof(): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const courses = 5, slopeLen = EZ / Math.cos(SLOPE) + 0.12, step = slopeLen / courses;
  const tint = new THREE.Color();
  for (const side of [1, -1]) {
    // basis: x along the ridge, u = up the slope, n = out of the roof (mirrored on the back slope: right-handed frame)
    const u = V(0, Math.sin(SLOPE), -side * Math.cos(SLOPE)), n = V(0, Math.cos(SLOPE), side * Math.sin(SLOPE)), X = V(side, 0, 0);
    for (let k = 0; k < courses; k++) {
      // (a course stops at the ridge: past it its plane would keep rising into a crest over the ridge)
      const edge = slopeLen - k * step, depth = Math.min(step + 0.22, edge + 0.02);
      const g = thatchCourse(RX * 2 + 0.1 - k * 0.03, depth, 0.085, 100 + k + (side > 0 ? 0 : 50));
      // the eave course hangs a touch steeper (the fringe); every course lifted 4 cm over the one below
      const tiltM = new THREE.Matrix4().makeRotationX(k === 0 ? -0.08 : (k % 2 ? 0.015 : -0.015));
      const o = V(0, RIDGE, 0).addScaledVector(u, -(edge - depth)).addScaledVector(n, 0.04 * k + 0.045);
      g.applyMatrix4(new THREE.Matrix4().makeBasis(X, u, n).setPosition(o).multiply(tiltM));
      tint.set(STRAW[(k * 2 + (side > 0 ? 0 : 1)) % STRAW.length]);
      const nv = g.attributes.position.count, col = new Float32Array(nv * 3);
      for (let i = 0; i < nv; i++) { col[i * 3] = tint.r; col[i * 3 + 1] = tint.g; col[i * 3 + 2] = tint.b; }
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      parts.push(g);
    }
  }
  const mesh = new THREE.Mesh(mergeGeometries(parts.map((g) => g.index ? g.toNonIndexed() : g), false)!, thatchMaterial());
  mesh.name = "banana-stand-thatch"; mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}
/** a banana leaf draped over the ridge: along z (across the ridge), following the roof's two slopes, sagging at its tips
 *  (u along the leaf, v across: the weapons' leaf texture has its midrib on v = .5) */
function ridgeLeaf(L: number, Wd: number, lift: number, seed: number): THREE.BufferGeometry {
  const r = rng(seed), rows = 16, cols = 6, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const tan = Math.tan(SLOPE);
  for (let i = 0; i <= rows; i++) {
    const t = i / rows, z = (t - 0.5) * L, half = Wd * 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.04 + 0.02)), 0.6);
    // over the ridge: a soft crown, then along the slope, the tips sagging below it
    const az = Math.abs(z), y = lift - az * (tan + 0.19) - Math.max(0, az - 0.62) * 0.4 + 0.04 * Math.exp(-az * az * 30);
    for (let j = 0; j <= cols; j++) {
      const s = (j / cols) * 2 - 1;
      pos.push(s * half, y - Math.abs(s) * half * 0.18 + (Math.abs(s) > 0.9 ? (r() - 0.5) * 0.015 : 0), z);
      uv.push(t, j / cols);
    }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { const a = i * (cols + 1) + j, b2 = a + cols + 1; idx.push(a, b2, a + 1, a + 1, b2, b2 + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------------------------------------ the sign
let signTex: THREE.CanvasTexture | null = null;
let signMat: THREE.MeshStandardMaterial | null = null;
const SIGN_FONT = "800 132px 'Barlow Condensed', 'Arial Narrow', Impact, sans-serif";
function signTexture(): THREE.CanvasTexture {
  if (signTex) return signTex;
  const c = document.createElement("canvas"); c.width = 1024; c.height = 256;
  drawSign(c);
  signTex = new THREE.CanvasTexture(c); signTex.colorSpace = THREE.SRGBColorSpace; signTex.anisotropy = 8;
  // (the UI font may still be on its way: paint the board again once it is in)
  try { if (document.fonts && !document.fonts.check(SIGN_FONT)) void document.fonts.load(SIGN_FONT).then(() => { drawSign(c); if (signTex) signTex.needsUpdate = true; }).catch(() => { /* fallback font stays */ }); } catch { /* no FontFaceSet */ }
  return signTex;
}
/** plank board, a cream painted panel, chunky lettering with a sign painter's drop shadow, a banana and the Bucks coin */
function drawSign(c: HTMLCanvasElement) {
  const x = c.getContext("2d")!, r = rng(31);
  const tones = ["#8f5b2c", "#7f4f25", "#956134"];
  for (let i = 0; i < 3; i++) { x.fillStyle = tones[i]; x.fillRect(0, (i * 256) / 3, 1024, 256 / 3 + 1); }
  x.strokeStyle = "rgba(40,18,4,0.6)"; x.lineWidth = 4;
  for (let i = 1; i < 3; i++) { x.beginPath(); x.moveTo(0, (i * 256) / 3); x.lineTo(1024, (i * 256) / 3); x.stroke(); }
  for (let i = 0; i < 70; i++) { x.strokeStyle = `rgba(50,24,6,${0.08 + r() * 0.12})`; x.lineWidth = 1 + r() * 2; const y = r() * 256; x.beginPath(); x.moveTo(r() * 1024, y); x.lineTo(r() * 1024, y + (r() - 0.5) * 6); x.stroke(); }
  const rr = (X: number, Y: number, W: number, H: number, R: number) => { x.beginPath(); x.moveTo(X + R, Y); x.arcTo(X + W, Y, X + W, Y + H, R); x.arcTo(X + W, Y + H, X, Y + H, R); x.arcTo(X, Y + H, X, Y, R); x.arcTo(X, Y, X + W, Y, R); x.closePath(); };
  rr(22, 20, 980, 216, 36); x.fillStyle = "#fff0bf"; x.fill(); x.lineWidth = 9; x.strokeStyle = "#d39a1c"; x.stroke();
  for (let i = 0; i < 160; i++) { x.fillStyle = `rgba(150,100,40,${0.05 + r() * 0.1})`; x.beginPath(); x.arc(40 + r() * 944, 36 + r() * 184, 1 + r() * 3, 0, Math.PI * 2); x.fill(); }
  x.font = SIGN_FONT; x.textAlign = "center"; x.textBaseline = "middle";
  const text = "BANANA STAND", w = x.measureText(text).width, sx = Math.min(1, 640 / w);
  x.save(); x.translate(512, 136); x.scale(sx, 1);
  x.fillStyle = "#e39a12"; x.fillText(text, 5, 6);
  x.fillStyle = "#5a2a0c"; x.fillText(text, 0, 0);
  x.restore();
  // a banana on the left, the Bucks coin on the right (outside the lettering)
  x.save(); x.translate(44, 30); x.scale(5.6, 5.6); x.rotate(-0.12); x.fillStyle = "#f2b80f"; x.fill(new Path2D(BANANA_PATH)); x.lineWidth = 0.8; x.strokeStyle = "#7a4a08"; x.stroke(new Path2D(BANANA_PATH)); x.restore();
  drawCoin(x, 914, 128, 72);
}

/** merge an already built item (another PartBuilder's meshes) into `b` at `m` — no draw call of its own */
function addBuilt(b: PartBuilder, built: Built, m: THREE.Matrix4) {
  built.root.updateMatrixWorld(true);
  for (const mesh of built.meshes) {
    const kind = mesh.name.slice(mesh.name.lastIndexOf(":") + 1) as Kind;
    b.addColored(mesh.geometry, kind, m.clone().multiply(mesh.matrixWorld));
  }
}

// ------------------------------------------------------------------------------------------------ the shopkeeper
/** a little monkey (≈ 1 m with his cap) built as separate pivots — body, head, eyes, both arms, tail — for tickStands.
 *  The same face as the buy menu's badge (ui/shop.ts MONKEY_SVG): heart-shaped tan face, big dark eyes, yellow cap. */
function monkey(): THREE.Group {
  const FUR = "#8a5226", TAN = "#ffd9a6", DARK = "#1f1006", CAP = "#ffc400", CAP2 = "#f0b400";
  const part = (name: string, build: (b: PartBuilder) => void) => { const b = new PartBuilder(); build(b); const g = b.build({ name: `stand-monkey:${name}`, shadows: false }).root; g.name = `monkey-${name}`; return g; };
  // body: pivot at the hips; torso with a lighter belly, legs, a banana-yellow bow tie and the Bucks coin as a badge
  const body = part("body", (b) => {
    b.add(new THREE.SphereGeometry(0.2, 14, 10), FUR, "fur", M([0, 0.2, 0], [0, 0, 0], [1, 1.15, 0.86]));
    b.add(new THREE.SphereGeometry(0.15, 12, 9), "#d9a36b", "matte", M([0, 0.17, 0.07], [0, 0, 0], [1, 1.15, 0.7]));
    for (const sx of [-1, 1]) b.add(new THREE.CapsuleGeometry(0.06, 0.18, 3, 8), FUR, "fur", M([sx * 0.095, -0.13, 0.02]));
    for (const sx of [-1, 1]) b.add(new THREE.ConeGeometry(0.045, 0.085, 4), CAP, "matte", M([sx * 0.045, 0.405, 0.135], [0, 0, sx * Math.PI / 2], [1, 1, 0.55]));
    b.add(new THREE.SphereGeometry(0.022, 8, 6), CAP2, "matte", M([0, 0.405, 0.142]));
    b.add(new THREE.CylinderGeometry(0.04, 0.04, 0.012, 14).rotateX(Math.PI / 2), "#a86a06", "gold", M([0.075, 0.25, 0.165], [-0.25, 0.35, 0]));
    b.add(new THREE.CylinderGeometry(0.032, 0.032, 0.014, 14).rotateX(Math.PI / 2), "#ffd21f", "gold", M([0.075, 0.25, 0.168], [-0.25, 0.35, 0]));
  });
  // head: pivot at the neck; skull, face mask + muzzle, ears, nose, smile, the cap (lifted clear of the eyes)
  const head = part("head", (b) => {
    b.add(new THREE.SphereGeometry(0.16, 16, 12), FUR, "fur", M([0, 0.14, 0]));
    for (const sx of [-1, 1]) {
      b.add(new THREE.SphereGeometry(0.078, 12, 9), TAN, "matte", M([sx * 0.052, 0.15, 0.1], [0, 0, 0], [1, 1.08, 0.55]));
      b.add(new THREE.SphereGeometry(0.068, 10, 8), FUR, "fur", M([sx * 0.168, 0.14, 0], [0, 0, 0], [0.45, 1, 1]));
      b.add(new THREE.SphereGeometry(0.044, 8, 6), "#f2b98a", "matte", M([sx * 0.18, 0.14, 0.012], [0, 0, 0], [0.3, 1, 1]));
      b.add(new THREE.SphereGeometry(0.011, 6, 5), "#6a3a1a", "matte", M([sx * 0.018, 0.098, 0.194]));
    }
    b.add(new THREE.SphereGeometry(0.09, 14, 10), TAN, "matte", M([0, 0.08, 0.11], [0, 0, 0], [1.15, 0.82, 0.72]));
    b.add(new THREE.TorusGeometry(0.036, 0.008, 5, 12, Math.PI), "#5a2f12", "matte", M([0, 0.066, 0.17], [0.25, 0, Math.PI]));
    // the cap: a dome (its seam, a banana badge) and the brim, all above the brow
    b.add(new THREE.SphereGeometry(0.166, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), CAP, "matte", M([0, 0.215, -0.01], [-0.18, 0, 0], [1, 0.7, 1]));
    b.add(new THREE.CylinderGeometry(0.11, 0.115, 0.016, 16, 1, false, -Math.PI / 2, Math.PI), CAP2, "matte", M([0, 0.232, 0.095], [0.3, 0, 0], [1.05, 1, 0.82]));
    paintedBanana(b, { length: 0.075, radius: 0.013, bend: 1.0, along: 6, radial: 5 }, M([-0.037, 0.31, 0.085], [-0.75, 0, 0.2]), "#6b3d06", "#7d4a0c", "matte");
  });
  const eyes = part("eyes", (b) => {
    for (const sx of [-1, 1]) {
      b.add(new THREE.SphereGeometry(0.036, 12, 10), DARK, "gloss", M([sx * 0.05, 0, 0], [0, 0, 0], [0.95, 1.25, 0.55]));
      b.add(new THREE.SphereGeometry(0.011, 6, 5), "#ffffff", "gloss", M([sx * 0.05 + 0.012, 0.016, 0.018]));
    }
  });
  // arms bent at the elbow (shoulder at the origin): the forearm points forward — at rest it lies on the counter, raised
  // (arm rotated forward and out) the forearm stands up: the wave
  const arm = (side: 1 | -1) => part(side > 0 ? "armL" : "armR", (b) => {
    const E = V(side * 0.01, -0.15, 0.03), H = V(side * 0.015, -0.17, 0.21);
    const seg = (a: THREE.Vector3, e: THREE.Vector3, rad: number) => {
      const d = new THREE.Vector3().subVectors(e, a), mid = new THREE.Vector3().addVectors(a, e).multiplyScalar(0.5);
      b.add(new THREE.CapsuleGeometry(rad, Math.max(0.01, d.length()), 3, 8), FUR, "fur", new THREE.Matrix4().compose(mid, new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize()), V(1, 1, 1)));
    };
    seg(V(0, 0, 0), E, 0.046); seg(E, H, 0.042);
    b.add(new THREE.SphereGeometry(0.052, 10, 8), TAN, "matte", M([H.x, H.y, H.z + 0.035], [0, 0, 0], [1, 0.85, 1.15]));
  });
  const tail = part("tail", (b) => {
    const pts = [V(0, 0, 0), V(0, -0.06, -0.1), V(0.02, 0.0, -0.22), V(0.03, 0.18, -0.29), V(0.0, 0.33, -0.23), V(-0.03, 0.36, -0.12), V(-0.01, 0.29, -0.08), V(0.0, 0.25, -0.12)];
    b.add(rope(pts, 0.022, false, 0.05, 6, 32), FUR, "fur");
  });
  const armL = arm(1), armR = arm(-1);
  const root = new THREE.Group(); root.name = "stand-monkey";
  body.position.set(0, 0.32, 0); root.add(body);
  head.position.set(0, 0.44, 0.0); body.add(head);
  eyes.position.set(0, 0.152, 0.142); head.add(eyes);
  armL.position.set(0.19, 0.36, 0); armR.position.set(-0.19, 0.36, 0); body.add(armL, armR);
  tail.position.set(0, 0.06, -0.15); body.add(tail);
  return root;
}

// ------------------------------------------------------------------------------------------------ the kiosk
/** BANANA STAND kiosk (see the header) */
export function bananaStand(): Built {
  const b = new PartBuilder(), d = new PartBuilder(), fr = new PartBuilder();   // d = the detail group's static pieces (display, bell), fr = its fruit
  const r = rng(77);
  // ---- counter: kick plate, dark backing, 8 banana-yellow painted front planks between dark battens, natural-wood sides,
  // the back with a stock shelf, a plank top with seams
  b.add(rbox(2.44, 0.1, 1.3, 0.02, 1), "#4a2a12", "matte", M([0, 0.05, 0]));
  b.add(rbox(2.36, 0.92, 0.04, 0.01, 1), "#3a2210", "matte", M([0, 0.52, 0.575]));
  for (let i = 0; i < 8; i++) b.add(rbox(0.286, 0.86, 0.05, 0.014, 1), PAINT[i], "matte", M([-1.05 + i * 0.3, 0.53, 0.604], [0, 0, (r() - 0.5) * 0.014]));
  for (const y of [0.13, 0.93]) b.add(rbox(2.44, 0.085, 0.06, 0.016, 1), "#5a3416", "matte", M([0, y, 0.636]));
  for (const x of [-1.19, 1.19]) b.add(rbox(0.08, 0.9, 0.07, 0.016, 1), "#5a3416", "matte", M([x, 0.53, 0.62]));
  for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) b.add(rbox(0.05, 0.29, 1.2, 0.012, 1), WOOD[(k * 2 + (sx > 0 ? 1 : 0)) % WOOD.length], "matte", M([sx * 1.18, 0.2 + k * 0.3, -0.02], [(r() - 0.5) * 0.01, 0, 0]));
  b.add(rbox(2.36, 0.5, 0.04, 0.01, 1), "#4a2a12", "matte", M([0, 0.3, -0.6]));
  b.add(rbox(2.3, 0.04, 0.46, 0.01, 1), "#8a5a2e", "matte", M([0, 0.58, -0.38]));
  b.add(rbox(2.58, 0.08, 1.42, 0.025, 2), "#a8743e", "matte", M([0, TOP - 0.04, 0.01]));
  for (let i = 0; i < 4; i++) b.add(new THREE.BoxGeometry(2.56, 0.004, 0.008), "#6b4320", "matte", M([0, TOP + 0.001, -0.42 + i * 0.284]));
  // the Banana Bucks coin on a dark round plaque in the middle of the front
  { const cy = 0.53, cz = 0.64;
    b.add(new THREE.CylinderGeometry(0.31, 0.31, 0.035, 32).rotateX(Math.PI / 2), "#4a2a12", "matte", M([0, cy, cz]));
    b.add(new THREE.CylinderGeometry(0.255, 0.255, 0.04, 32).rotateX(Math.PI / 2), "#a86a06", "gold", M([0, cy, cz + 0.012]));
    b.add(new THREE.CylinderGeometry(0.228, 0.228, 0.05, 32).rotateX(Math.PI / 2), "#ffd21f", "gold", M([0, cy, cz + 0.014]));
    b.add(new THREE.TorusGeometry(0.19, 0.011, 5, 32), "#e5a10c", "gold", M([0, cy, cz + 0.04]));
    paintedBanana(b, { length: 0.3, radius: 0.046, bend: 1.15, along: 14, radial: 8, squash: 0.45 }, M([-0.15, cy - 0.035, cz + 0.042], [0, 0, 0.5]), "#5a3205", "#6b3d06", "matte");
  }
  // ---- posts (bamboo, through the counter corners up under the eaves), eave beams, the ridge pole, rafters
  const roofY = (z: number) => EAVE + (EZ - Math.abs(z)) * Math.tan(SLOPE);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bamboo(b, V(sx * 1.14, 0.02, sz * 0.58), V(sx * 1.14, roofY(0.58) - 0.02, sz * 0.58), 0.052);
  for (const sz of [-1, 1]) bamboo(b, V(-RX + 0.06, roofY(0.6) - 0.06, sz * 0.6), V(RX - 0.06, roofY(0.6) - 0.06, sz * 0.6), 0.044, "#bfa55e", null);
  bamboo(b, V(-RX, RIDGE - 0.04, 0), V(RX, RIDGE - 0.04, 0), 0.05, "#bfa55e", null);
  for (const sx of [-1.14, 0, 1.14]) for (const sz of [-1, 1]) bamboo(b, V(sx, RIDGE - 0.05, 0), V(sx, EAVE - 0.03, sz * (EZ - 0.02)), 0.03, "#b59b55", null);
  // ---- the reed screen at the back (the shopkeeper stands out against it) + two tie bars
  for (let i = 0; i < 15; i++) { const x = -1.05 + i * 0.15; bamboo(b, V(x, TOP, -0.62), V(x, roofY(0.62) - 0.05 - (i % 3) * 0.04, -0.62), 0.043, i % 2 ? "#cdb46c" : "#bea055", null); }
  for (const y of [1.6, 2.3]) b.add(new THREE.CylinderGeometry(0.02, 0.02, 2.24, 6).rotateZ(Math.PI / 2), "#7a6430", "matte", M([0, y, -0.58]));
  // ---- banana leaves draped over the ridge
  const leaves: Array<[number, number, number, number]> = [[-1.25, 1.5, 0.5, 0.1], [-0.72, 1.7, 0.56, -0.12], [-0.18, 1.55, 0.52, 0.08], [0.36, 1.75, 0.58, -0.1], [0.9, 1.6, 0.52, 0.12], [1.32, 1.45, 0.48, -0.06]];
  leaves.forEach(([x, L, Wd, yaw], i) => b.add(ridgeLeaf(L, Wd, 0.34, 300 + i), "#ffffff", "leaf", M([x, RIDGE, 0], [0, yaw, 0])));
  // ---- the sign on the ridge: two bamboo uprights, the board, a big banana on top
  for (const sx of [-0.74, 0.74]) bamboo(b, V(sx, RIDGE + 0.1, 0.03), V(sx, RIDGE + 0.72, 0.03), 0.036);
  b.add(rbox(2.0, 0.52, 0.06, 0.02, 2), "#6b3f1c", "matte", M([0, RIDGE + 0.6, 0.03]));
  paintedBanana(b, { length: 1.0, radius: 0.125, bend: 1.0, along: 22, radial: 14 }, M([-0.5, RIDGE + 0.97, 0.04], [0, 0, 0.05]), "#d8960a", "#ffd23a");
  b.add(new THREE.CylinderGeometry(0.03, 0.036, 0.1, 8), "#5b3b19", "matte", M([-0.52, RIDGE + 1.0, 0.04], [0, 0, 1.2]));
  b.add(new THREE.SphereGeometry(0.035, 8, 6), "#3c2a12", "matte", M([0.5, RIDGE + 1.01, 0.04]));
  // ---- bananas hanging at the front corners (above head height)
  hangingBunch(b, V(-1.34, roofY(0.92) - 0.1, 0.92), 11);
  hangingBunch(b, V(1.34, roofY(0.92) - 0.08, 0.92), 12);

  // ---- detail: the display on the counter (left: a tilted crate of bananas; right: a two-step riser with the stock)
  { const cm = new THREE.Matrix4().makeTranslation(-0.66, TOP + 0.07, 0.18).multiply(new THREE.Matrix4().makeRotationX(0.42));
    const slat = (w: number, h: number, dd: number, p: [number, number, number], col: string) => d.add(rbox(w, h, dd, 0.008, 1), col, "matte", cm.clone().multiply(M(p)));
    slat(0.8, 0.025, 0.5, [0, 0, 0], "#a77140");
    for (const z of [-0.24, 0.24]) for (const y of [0.05, 0.15]) slat(0.8, 0.07, 0.022, [0, y, z], y < 0.1 ? "#b47d45" : "#c08b52");
    for (const x of [-0.39, 0.39]) slat(0.022, 0.2, 0.5, [x, 0.09, 0], "#9a6838");
    d.add(rbox(0.7, 0.14, 0.12, 0.01, 1), "#6b4320", "matte", M([-0.66, TOP + 0.07, -0.08]));
    hand(fr, 5, 0.24, 0.034, cm.clone().multiply(M([-0.22, 0.1, -0.08], [0, 0.3, 0])), 21);
    hand(fr, 6, 0.25, 0.035, cm.clone().multiply(M([0.1, 0.11, 0.06], [0, -0.2, 0.05])), 22);
    hand(fr, 5, 0.23, 0.033, cm.clone().multiply(M([-0.05, 0.1, -0.15], [0, 2.8, 0])), 23);
    hand(fr, 4, 0.24, 0.034, cm.clone().multiply(M([0.25, 0.1, -0.12], [0, 2.4, 0])), 24);
  }
  { // the riser
    d.add(rbox(0.8, 0.08, 0.42, 0.01, 1), "#a8743e", "matte", M([0.66, TOP + 0.04, 0.32]));
    d.add(rbox(0.8, 0.24, 0.3, 0.01, 1), "#b47d45", "matte", M([0.66, TOP + 0.12, -0.02]));
    // upper step: a shield smoothie, a leaf bundle, a coconut crate wall pack
    { const x = 0.42, y = TOP + 0.24, z = -0.02;
      d.add(new THREE.CylinderGeometry(0.068, 0.063, 0.19, 12), "#78982f", "matte", M([x, y + 0.095, z]));
      d.add(new THREE.CylinderGeometry(0.07, 0.07, 0.012, 12), "#e0c98c", "matte", M([x, y + 0.19, z]));
      d.add(new THREE.SphereGeometry(0.06, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), "#ffd84a", "gloss", M([x, y + 0.19, z], [0, 0, 0], [1, 0.55, 1]));
      d.add(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 5), "#f0c01c", "gloss", M([x + 0.02, y + 0.26, z - 0.01], [-0.1, 0, -0.25]));
      d.add(new THREE.TorusGeometry(0.068, 0.006, 4, 16).rotateX(Math.PI / 2), "#cfa66a", "rope", M([x, y + 0.06, z]));
      d.add(new THREE.CylinderGeometry(0.032, 0.032, 0.004, 12).rotateX(Math.PI / 2), "#2e86d6", "matte", M([x, y + 0.11, z + 0.066])); }
    { const x = 0.68, y = TOP + 0.24, z = -0.02;
      d.add(new THREE.IcosahedronGeometry(0.085, 1), "#3f8a2a", "matte", M([x, y + 0.08, z], [0.3, 0.5, 0], [1, 0.82, 0.95]));
      for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; d.add(new THREE.ConeGeometry(0.025, 0.09, 4), "#4f9a32", "matte", M([x + Math.cos(a) * 0.05, y + 0.15, z + Math.sin(a) * 0.05], [Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5])); }
      d.add(new THREE.TorusGeometry(0.072, 0.007, 4, 16).rotateX(Math.PI / 2), "#cfa66a", "rope", M([x, y + 0.08, z], [0, 0, 0], [1, 1, 0.95])); }
    addBuilt(d, crateWallPack(), M([0.95, TOP + 0.24, -0.03], [0, -0.25, 0], 0.62));
    // lower step: a banana bomb (a low-poly copy: banana, two iron bands, the pin ring, the ember), ammo, a stack of Bucks
    { const bm = M([0.3, TOP + 0.12, 0.36], [0, 0.55, 0]);
      paintedBanana(d, { length: 0.27, radius: 0.05, bend: 0.95, along: 12, radial: 8 }, bm, "#d8960a", "#ffd23a");
      for (const t of [0.09, 0.18]) d.add(new THREE.TorusGeometry(0.052, 0.008, 4, 12).rotateY(Math.PI / 2), "#2a2d31", "metal", bm.clone().multiply(M([t, -0.012, 0])));
      d.add(new THREE.TorusGeometry(0.017, 0.004, 4, 10), "#d9dde2", "chrome", bm.clone().multiply(M([0.02, 0.04, 0.05])));
      d.add(new THREE.SphereGeometry(0.012, 6, 5), "#ff7a1a", "emissive", bm.clone().multiply(M([-0.035, 0.025, 0]))); }
    { const x = 0.7, y = TOP + 0.08, z = 0.34;
      d.add(rbox(0.22, 0.12, 0.13, 0.012, 1), "#5d6b2e", "matte", M([x, y + 0.06, z], [0, 0.15, 0]));
      d.add(new THREE.BoxGeometry(0.224, 0.025, 0.132), "#ffd21f", "matte", M([x, y + 0.085, z], [0, 0.15, 0]));
      for (let k = 0; k < 3; k++) { const bx = x - 0.05 + k * 0.05; d.add(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 6), "#c9973a", "metal", M([bx, y + 0.145, z], [0, 0.15, 0])); d.add(new THREE.ConeGeometry(0.012, 0.025, 6), "#b07a30", "metal", M([bx, y + 0.18, z], [0, 0.15, 0])); } }
    addBuilt(d, cashStack(), M([0.97, TOP + 0.08, 0.36], [0, -0.4, 0], 1.3));
    // price tags on the steps' front edges
    for (const [x, y, z] of [[0.42, TOP + 0.24, 0.13], [0.68, TOP + 0.24, 0.13], [0.95, TOP + 0.24, 0.13], [0.36, TOP + 0.08, 0.535], [0.7, TOP + 0.08, 0.535], [0.97, TOP + 0.08, 0.535]] as Array<[number, number, number]>)
      d.add(rbox(0.09, 0.05, 0.006, 0.004, 1), "#ffd21f", "matte", M([x, y - 0.025, z], [0.2, 0, (r() - 0.5) * 0.12]));
  }
  // the brass service bell in front of the shopkeeper
  d.add(new THREE.CylinderGeometry(0.06, 0.065, 0.015, 14), "#3a2210", "matte", M([0.0, TOP + 0.008, 0.42]));
  d.add(new THREE.SphereGeometry(0.052, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2), "#d8a838", "metal", M([0.0, TOP + 0.015, 0.42]));
  d.add(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 6), "#c79a35", "metal", M([0.0, TOP + 0.08, 0.42]));
  // the crate the shopkeeper stands on (seen from behind the counter)
  b.add(rbox(0.56, 0.34, 0.44, 0.015, 1), "#a8743e", "matte", M([MONKEY_AT[0], 0.25, MONKEY_AT[2]]));
  b.add(rbox(0.58, 0.06, 0.46, 0.01, 1), "#7a4a22", "matte", M([MONKEY_AT[0], MONKEY_AT[1] - 0.03, MONKEY_AT[2]]));

  const built = b.build({ name: "banana-stand" });
  built.root.add(thatchRoof());
  const detail = d.build({ name: "banana-stand-detail", shadows: false }).root;
  detail.name = "banana-stand-detail";
  { const fruit = fr.build({ name: "banana-stand-fruit", shadows: false }).root; fruit.traverse((c) => { if ((c as THREE.Mesh).isMesh) (c as THREE.Mesh).material = fruitMaterial(); }); detail.add(fruit); }
  // ---- the sign's painted faces (both sides)
  if (!signMat) { signMat = new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.82, metalness: 0 }); signMat.name = "banana-stand-sign"; }
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.94, 0.49), signMat);
  sign.position.set(0, RIDGE + 0.6, 0.062); sign.name = "banana-stand-sign"; built.root.add(sign);
  const sign2 = sign.clone(); sign2.rotation.y = Math.PI; sign2.position.z = -0.002; built.root.add(sign2);
  // ---- the shopkeeper
  const mk = monkey();
  mk.position.set(...MONKEY_AT); mk.scale.setScalar(MONKEY_S);
  detail.add(mk);
  built.root.add(detail);
  detail.traverse((c) => { if ((c as THREE.Mesh).isMesh) { c.castShadow = false; c.userData.noCast = true; } });
  let tris = 0; built.root.traverse((c) => { const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined; if ((c as THREE.Mesh).isMesh && g) tris += (g.index ? g.index.count : g.attributes.position.count) / 3; });
  return { root: built.root, meshes: built.meshes, tris, pivots: {} };
}

// ------------------------------------------------------------------------------------------------ animation
interface StandAnim { detail: THREE.Object3D; root: THREE.Object3D; body: THREE.Object3D; head: THREE.Object3D; eyes: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D; tail: THREE.Object3D;
  wave: number; waveT: number; near: boolean; cash: number; hop: number; phase: number; nextWave: number }
const ANIM = new WeakMap<THREE.Object3D, StandAnim>();
function animOf(o: THREE.Object3D): StandAnim | null {
  let a = ANIM.get(o);
  if (a) return a;
  const detail = o.getObjectByName("banana-stand-detail"), root = o.getObjectByName("stand-monkey");
  const g = (n: string) => o.getObjectByName(`monkey-${n}`)!;
  if (!detail || !root) return null;
  a = { detail, root, body: g("body"), head: g("head"), eyes: g("eyes"), armL: g("armL"), armR: g("armR"), tail: g("tail"), wave: 0, waveT: -1, near: false, cash: -1, hop: 0, phase: Math.abs(o.position.x * 0.37 + o.position.z * 0.11) % 6.28, nextWave: 6 };
  ANIM.set(o, a);
  return a;
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * once per frame (the game's render update): every stand past DETAIL_M hides its detail group (the shopkeeper + the
 * display); the near ones animate the shopkeeper — breathing, a slow look round, eyes on you within 9 m, a wave when you
 * walk up (and now and then while you are around), a happy hop when your wallet goes down (you bought something), a tail
 * swish, blinks. No allocation; a few matrix writes for the one or two stands in view.
 */
export function tickStands(views: readonly THREE.Object3D[], cx: number, cz: number, px: number, pz: number, cash: number, t: number, dt: number) {
  for (const o of views) {
    const a = animOf(o); if (!a) continue;
    const show = Math.hypot(o.position.x - cx, o.position.z - cz) < DETAIL_M;
    if (a.detail.visible !== show) a.detail.visible = show;
    if (!show) { a.near = false; continue; }
    // the player in the stand's frame (+Z = the customers' side)
    const dx = px - o.position.x, dz = pz - o.position.z, c = Math.cos(o.rotation.y), s = Math.sin(o.rotation.y);
    const lx = dx * c - dz * s, lz = dx * s + dz * c, dp = Math.hypot(lx, lz);
    const near = dp < 7.5 && lz > -1;
    if (near && !a.near) a.waveT = 0;
    a.near = near;
    if (a.cash >= 0 && cash < a.cash && dp < 5) { a.hop = 1; a.waveT = 0; }
    a.cash = cash;
    a.nextWave -= dt;
    if (a.nextWave <= 0) { a.nextWave = 9 + ((t * 7.3) % 6); if (dp < 22 && a.waveT < 0) a.waveT = 0; }
    if (a.waveT >= 0) { a.waveT += dt; if (a.waveT > 2.4) a.waveT = -1; }
    a.wave = lerp(a.wave, a.waveT >= 0 && a.waveT < 2.0 ? 1 : 0, Math.min(1, dt * 7));
    const ph = t + a.phase;
    // breathing + a little sway; the hop
    a.hop = Math.max(0, a.hop - dt * 2.4);
    a.root.position.y = MONKEY_AT[1] + (a.hop > 0 ? Math.sin((1 - a.hop) * Math.PI) * 0.1 : 0);
    a.body.scale.y = 1 + Math.sin(ph * 2.3) * 0.012;
    a.body.rotation.z = Math.sin(ph * 0.9) * 0.035;
    // look: at the player within 9 m (yaw clamped), else a slow glance round
    const look = dp < 9 && lz > -0.5 ? Math.max(-0.75, Math.min(0.75, Math.atan2(lx - MONKEY_AT[0], lz - MONKEY_AT[2]))) : Math.sin(ph * 0.37) * 0.45;
    a.head.rotation.y = lerp(a.head.rotation.y, look, Math.min(1, dt * 4));
    a.head.rotation.x = Math.sin(ph * 0.8) * 0.05 + (dp < 9 ? -0.05 : 0.03);
    a.head.rotation.z = Math.sin(ph * 0.63) * 0.07 + a.wave * 0.12;
    // arms: forearms resting on the counter; the right one comes up into a wave (forearm up, the hand rocking)
    a.armL.rotation.set(-0.25 + Math.sin(ph * 1.1) * 0.03, 0, 0.12);
    a.armR.rotation.set(lerp(-0.25, -1.55, a.wave), 0, lerp(-0.12, -0.45 + Math.sin(ph * 11) * 0.32, a.wave));
    // tail swish, blinks
    a.tail.rotation.set(Math.sin(ph * 1.05) * 0.12, 0, Math.sin(ph * 1.6) * 0.3);
    a.eyes.scale.y = (ph % 4.1) < 0.11 ? 0.12 : 1;
  }
}
