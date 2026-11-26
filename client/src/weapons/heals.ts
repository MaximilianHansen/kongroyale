// Healing items — target art gear-01-heals. Origin = bottom centre, +Z front.
// Every stencil / stripe / fibre is PAINTED INTO the item's own wrap-around canvas texture (no floating
// decal cylinders, no constant-radius bars floating off tapered surfaces).
//   smoothie      (SHIELD) squat cut-bamboo cup (irregular cut rim with the pale wall showing, vertical grain + splits,
//                 a painted blue shield badge), twine wrap, domed yellow smoothie with a swirl, blue/white spiral
//                 straw, a banana slice (flower seed pattern) on the rim, a two-leaf sprig at the base
//   leaf-bundle   a pillow wrapped in overlapping curved banana-leaf sheets (midribs + parallel veins, tucked end
//                 flaps), two crossing twine lashings, a stitched canvas patch with a red cross lying on top (HEALTH)
//   golden-banana polished metallic gold banana standing stem-up, a gold crown seated on the stem, a kong shield
//                 emblem on the belly surface, brown tip, sparkle glints
import * as THREE from "three";
import type { ConsumableId } from "../../../shared/world/map";
import { PartBuilder, type Built } from "./lib/builder";
import { rng, paintKong, addGlint } from "./lib/mats";
import { bunchPath } from "./chest-tex";
import { bananaGeometry, bananaAt, catmull1, gridGeometry, lathe, polarAt, rope, roundedPolyPolar, tf, filletCyl } from "./lib/geo";
import { airstrikeBeacon, bananaBomb, crateWallPack, smokeBanana, vineGrapple } from "./loot-lane";

/** average colours of textured parts, for the single-mesh far LOD */
const LOD_COLOR: Record<string, string> = {
  "smoothie-cup": "#5e9a2c", "smoothie-top": "#f7cf3a", slice: "#f3dca0", straw: "#f4e6b0", "straw-lip": "#fbfbf6", "sprig-leaf": "#4f9a2e",
  "bundle-wrap": "#4f9a2e", "bundle-edge": "#4f9a2e", "bundle-flap": "#4f9a2e", "leaf-patch": "#e3d4b0", "gb-emblem": "#8a5a12",
};
export const HEAL_ORDER: ConsumableId[] = ["leaf-bundle", "smoothie", "golden-banana", "red-banana"];
const cache = new Map<string, Built>();

// ------------------------------------------------------------------------------------------------ helpers
function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void, srgb = true, wrap = true) {
  const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8;
  if (wrap) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; }
  return t;
}
/** lathe with u = angle, v = height (normalised to [y0, y1]) so a wrap-around canvas maps without stretching */
function latheUV(points: Array<[number, number]>, seg: number, jitter?: (a: number, y: number) => number): THREE.BufferGeometry {
  const pts = points[0][1] > points[points.length - 1][1] ? points.slice().reverse() : points;
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-5), y)), seg);
  const p = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
  let y0 = Infinity, y1 = -Infinity;
  for (const [, y] of pts) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(x, z); // 0 at +Z (front)
    uv.setXY(i, uv.getX(i), (y - y0) / (y1 - y0));
    if (jitter) { const r = Math.hypot(x, z), k = jitter(a, y); if (r > 1e-4) { p.setX(i, x * (1 + k)); p.setZ(i, z * (1 + k)); } }
  }
  g.computeVertexNormals();
  return g;
}
/** shield outline (for stencils / emblems) centred at (cx, cy), half-width w */
function shieldPath(x: CanvasRenderingContext2D, cx: number, cy: number, w: number, hex = false) {
  x.beginPath();
  if (hex) { for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + Math.PI / 6; const px = cx + Math.cos(a) * w, py = cy + Math.sin(a) * w * 1.05; k ? x.lineTo(px, py) : x.moveTo(px, py); } x.closePath(); return; }
  x.moveTo(cx - w, cy - w * 0.95); x.lineTo(cx + w, cy - w * 0.95); x.lineTo(cx + w, cy + w * 0.2); x.quadraticCurveTo(cx + w, cy + w * 0.9, cx, cy + w * 1.2); x.quadraticCurveTo(cx - w, cy + w * 0.9, cx - w, cy + w * 0.2); x.closePath();
}
const mat = (o: THREE.MeshStandardMaterialParameters, name: string) => { const m = new THREE.MeshStandardMaterial(o); m.name = name; return m; };
function mesh(g: THREE.BufferGeometry, m: THREE.Material, name: string, shadow = true): THREE.Mesh {
  const x = new THREE.Mesh(g, m); x.name = name; x.castShadow = shadow; x.receiveShadow = true; return x;
}
/** a twisted twine along points (the target art's tan cord) */
function twine(b: PartBuilder, pts: THREE.Vector3[], r: number, closed = false) {
  b.add(rope(pts, r, closed, r * 5, 8, Math.max(24, pts.length * 4)), "#cfa66a", "rope");
}
/** a leaf (flat-ish, curved, pointed) as geometry, length L, width W, with a midrib crease */
function leafGeo(L: number, W: number, curl = 0.25): THREE.BufferGeometry {
  const nu = 12, nv = 6, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
    const u = i / nu, v = j / nv - 0.5;
    const hw = W * 0.5 * Math.sin(Math.PI * Math.pow(u, 0.8)) * (1 - 0.25 * u);
    const x = v * 2 * hw, z = u * L, y = -Math.abs(v) * W * 0.25 + curl * u * u * L * 0.3;
    pos.push(x, y, z); uv.push(u, j / nv);
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const a = i * (nv + 1) + j, b2 = a + nv + 1; idx.push(a, b2, a + 1, b2, b2 + 1, a + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
let leafMat: THREE.MeshStandardMaterial | null = null;
function smallLeafMat() {
  if (leafMat) return leafMat;
  const t = canvasTex(256, 128, (x) => {
    const g = x.createLinearGradient(0, 0, 256, 0); g.addColorStop(0, "#3f7a1c"); g.addColorStop(1, "#6aa232"); x.fillStyle = g; x.fillRect(0, 0, 256, 128);
    x.strokeStyle = "rgba(200,235,140,.8)"; x.lineWidth = 4; x.beginPath(); x.moveTo(0, 64); x.lineTo(256, 64); x.stroke();
    x.strokeStyle = "rgba(30,80,20,.4)"; x.lineWidth = 1.5; for (let i = 1; i < 16; i++) { const px = i * 16; x.beginPath(); x.moveTo(px, 64); x.quadraticCurveTo(px + 10, 30, px + 22, 0); x.moveTo(px, 64); x.quadraticCurveTo(px + 10, 98, px + 22, 128); x.stroke(); }
  }, true, false);
  leafMat = mat({ map: t, roughness: 0.5, side: THREE.DoubleSide }, "heal-leaf");
  return leafMat;
}
function straw(colour: string, len: number, r: number): THREE.Group {
  const g = new THREE.Group();
  const t = canvasTex(128, 512, (x) => {
    x.fillStyle = "#fbfbf6"; x.fillRect(0, 0, 128, 512);
    x.fillStyle = colour;
    for (let k = -4; k < 12; k++) { x.beginPath(); x.moveTo(0, k * 64); x.lineTo(128, k * 64 + 64); x.lineTo(128, k * 64 + 96); x.lineTo(0, k * 64 + 32); x.closePath(); x.fill(); }
  });
  t.wrapT = THREE.RepeatWrapping;
  const body = mesh(new THREE.CylinderGeometry(r, r, len, 20, 1, true), mat({ map: t, roughness: 0.35, side: THREE.DoubleSide }, "heal-straw"), "straw");
  const lip = mesh(new THREE.TorusGeometry(r * 0.92, r * 0.12, 6, 20), mat({ color: "#fbfbf6", roughness: 0.35 }, "heal-straw-lip"), "straw-lip");
  lip.rotation.x = Math.PI / 2; lip.position.y = len / 2;
  g.add(body, lip);
  return g;
}

// ------------------------------------------------------------------------------------------------ smoothie
function smoothie(): Built {
  const root = new THREE.Group(); root.name = "smoothie";
  const b = new PartBuilder();
  // taller than wide like the target art (H ≈ 1.35 D), a clean slanted cut (not a torn-paper rim), olive
  // bamboo greens (the target art samples h73-86, ours were h90-95 neon lime)
  const R = 0.092, H = 0.25, wall = 0.018;
  const r = rng(4);
  // cup texture: green culm, vertical grain + splits, lighter streaks, the blue shield badge at the front (u .5)
  const tex = canvasTex(1024, 512, (x) => {
    const g = x.createLinearGradient(0, 0, 0, 512); g.addColorStop(0, "#8fab3c"); g.addColorStop(0.6, "#6f8f2a"); g.addColorStop(1, "#56721e"); x.fillStyle = g; x.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 38; i++) { x.strokeStyle = r() < 0.5 ? `rgba(35,75,15,${0.1 + r() * 0.14})` : `rgba(190,225,120,${0.08 + r() * 0.12})`; x.lineWidth = 5 + r() * 9; const px = r() * 1024; x.beginPath(); x.moveTo(px, 0); x.bezierCurveTo(px + (r() - 0.5) * 12, 170, px + (r() - 0.5) * 12, 340, px + (r() - 0.5) * 10, 512); x.stroke(); }
    // splits: dark hairline + a light lip
    for (let i = 0; i < 7; i++) { const px = r() * 1024, y0 = r() * 120, len = 120 + r() * 260; x.strokeStyle = "rgba(25,50,10,.6)"; x.lineWidth = 4; x.beginPath(); x.moveTo(px, y0); x.lineTo(px + (r() - 0.5) * 8, y0 + len); x.stroke(); x.strokeStyle = "rgba(210,235,160,.5)"; x.lineWidth = 1.5; x.beginPath(); x.moveTo(px + 3, y0); x.lineTo(px + 3 + (r() - 0.5) * 8, y0 + len); x.stroke(); }
    // the target art's BANANA CO. stencil instead of a generic blue shield decal: a
    // dark-green STAMPED stencil — a shield outline, a banana bunch and BANANA / CO. — distressed like a real stamp,
    // above the twine (the twine never crosses it)
    const cx = 512, cy = 196, ink = "rgba(38,62,14,0.82)";
    x.save();
    x.strokeStyle = ink; x.lineWidth = 9; shieldPath(x, cx, cy, 76); x.stroke();
    x.fillStyle = ink; bunchPath(x, cx, cy - 22, 70, 0.1);
    x.font = "900 34px Arial Black, Arial, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText("BANANA", cx, cy + 40); x.font = "900 32px Arial Black, Arial, sans-serif"; x.fillText("CO.", cx, cy + 74);
    // distress: erase specks + a couple of worn streaks so it reads stamped, not printed
    x.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 300; i++) { x.fillStyle = `rgba(0,0,0,${0.25 + r() * 0.6})`; x.beginPath(); x.arc(cx - 95 + r() * 190, cy - 95 + r() * 210, 0.6 + r() * 2, 0, Math.PI * 2); x.fill(); }
    x.restore();
    // the erased specks show the bamboo again: repaint the culm colour under the stamp (destination-over)
    x.save(); x.globalCompositeOperation = "destination-over"; x.fillStyle = "#6f8f2a"; x.fillRect(cx - 100, cy - 100, 200, 220); x.restore();
  });
  // outer wall with a jagged cut top, pale cut face, inner wall; u = angle so the stamp faces +Z
  // a gently warped culm with 12 soft vertical slats
  const jag = (a: number, y: number) => 0.01 * Math.sin(a * 3 + 1) * (y / H) + 0.004 * Math.sin(a * 7) - 0.012 * (1 - Math.pow(Math.abs(Math.cos(a * 6)), 0.8)); // softer slat creases (normal aliasing / moire at range)
  const cutY = (a: number) => H + 0.009 * Math.sin(a + 0.6) - 0.005 * Math.pow(Math.max(0, Math.sin(a * 5 + 1)), 12);
  const outer = latheUV([[R * 0.98, 0.004], [R, 0.02], [R * 1.01, H * 0.5], [R * 1.03, H]], 48, jag);
  { const p = outer.attributes.position as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) if (p.getY(i) > H - 0.001) { const a = Math.atan2(p.getX(i), p.getZ(i)); p.setY(i, cutY(a)); } outer.computeVertexNormals(); }
  tex.offset.x = 0.5;
  root.add(mesh(outer, mat({ map: tex, roughness: 0.55, metalness: 0 }, "smoothie-cup"), "smoothie-cup"));
  // cut rim (tan) — follows the jagged top: a lathe band from outer to inner radius near the top
  const rim = latheUV([[R * 1.03, H], [R * 1.0, H + 0.002], [R - wall, H]], 96, jag);
  { const p = rim.attributes.position as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) { const a = Math.atan2(p.getX(i), p.getZ(i)); p.setY(i, cutY(a) + (p.getY(i) - H) + 0.0005); } rim.computeVertexNormals(); }
  b.add(rim, "#e0c98c", "matte");
  b.add(lathe([[R - wall, H - 0.008], [R - wall - 0.002, H - 0.04]], 48), "#bda36a", "matte");
  // pale cut base ring
  b.add(lathe([[R * 0.98, 0.0], [R * 0.99, 0.012]], 48), "#d7c08a", "matte");
  b.add(new THREE.CircleGeometry(R * 0.98, 48).rotateX(Math.PI / 2), "#6f8f3a", "matte", tf([0, 0.001, 0]));
  // twine wrap around the middle (radius follows the wall at that height)
  const tr = R * 1.02 + 0.004;
  const ring: THREE.Vector3[] = []; for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; ring.push(new THREE.Vector3(Math.sin(a) * tr * (1 + jag(a, H * 0.2)), H * 0.2 + Math.sin(a * 2) * 0.003, Math.cos(a) * tr * (1 + jag(a, H * 0.2)))); }
  twine(b, ring, 0.0045, true);
  // smoothie: domed yellow cream with a swirl ridge
  const sm = canvasTex(256, 256, (x) => {
    const g = x.createRadialGradient(128, 128, 10, 128, 128, 128); g.addColorStop(0, "#ffe27a"); g.addColorStop(1, "#f0c235"); x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    x.strokeStyle = "rgba(210,150,20,.45)"; x.lineWidth = 7; x.beginPath(); for (let t = 0; t < 12; t += 0.05) { const rr = 8 + t * 9, px = 128 + Math.cos(t) * rr, py = 128 + Math.sin(t) * rr; t ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke();
    x.strokeStyle = "rgba(255,248,210,.6)"; x.lineWidth = 3; x.beginPath(); for (let t = 0; t < 12; t += 0.05) { const rr = 12 + t * 9, px = 126 + Math.cos(t) * rr, py = 126 + Math.sin(t) * rr; t ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke();
  }, true, false);
  const dome = latheUV([[0.0001, H + 0.004], [R * 0.5, H - 0.0], [R - wall, H - 0.012]], 40);
  { const p = dome.attributes.position as THREE.BufferAttribute, uv = dome.attributes.uv as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / (2 * R) + 0.5, -p.getZ(i) / (2 * R) + 0.5); }
  root.add(mesh(dome, new THREE.MeshPhysicalMaterial({ map: sm, roughness: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.3 }), "smoothie-top"));
  // banana slice leaning on the rim: thick disc, flower seed face, yellow peel ring
  const sliceTex = canvasTex(256, 256, (x) => {
    const g = x.createRadialGradient(128, 128, 0, 128, 128, 128); g.addColorStop(0, "#fff5d2"); g.addColorStop(0.8, "#f6e3a8"); g.addColorStop(1, "#e8cb7c"); x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    x.fillStyle = "rgba(205,160,60,.8)";
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; x.beginPath(); x.ellipse(128 + Math.cos(a) * 28, 128 + Math.sin(a) * 28, 22, 9, a, 0, Math.PI * 2); x.fill(); }
    x.fillStyle = "rgba(120,80,30,.9)"; x.beginPath(); x.arc(128, 128, 9, 0, Math.PI * 2); x.fill();
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + 0.5; x.beginPath(); x.arc(128 + Math.cos(a) * 52, 128 + Math.sin(a) * 52, 4, 0, Math.PI * 2); x.fill(); }
  }, true, false);
  const slice = new THREE.Group();
  const sf = mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.016, 32), [mat({ color: "#f2c21e", roughness: 0.4 }, "slice-peel"), mat({ map: sliceTex, roughness: 0.55 }, "slice-face"), mat({ map: sliceTex, roughness: 0.55 }, "slice-face")] as unknown as THREE.Material, "slice");
  slice.add(sf);
  slice.position.set(-0.072, H + 0.018, 0.055); slice.rotation.set(0.9, 0.5, -0.45);
  root.add(slice);
  // straw
  // the target art's yellow-white straw
  const st = straw("#f0c01c", 0.2, 0.0095); st.position.set(0.026, H + 0.04, -0.012); st.rotation.set(-0.12, 0, -0.2); root.add(st);
  // two-leaf sprig at the base, front right
  const lm = smallLeafMat();
  for (const [ry, rx, s] of [[0.9, -0.2, 1], [1.8, 0.2, 0.8]] as Array<[number, number, number]>) {
    const lf = mesh(leafGeo(0.075 * s, 0.04 * s), lm, "sprig-leaf"); lf.position.set(R * 0.92, 0.045, R * 0.42); lf.rotation.set(rx, ry, 0.3); root.add(lf);
  }
  b.add(new THREE.CylinderGeometry(0.0025, 0.003, 0.07, 6), "#4f7f24", "matte", tf([R * 0.96, 0.03, R * 0.38], [0.3, 0, -0.7]));
  const built = b.build({ name: "smoothie-parts" });
  root.add(built.root);
  return { root, meshes: [], tris: 0, pivots: {} };
}

/** the coconut (studio sheet gear-01 only — not a game item; kept so the heals sheet shows
 *  the target art's four items) */
function coconut(): Built {
  const root = new THREE.Group(); root.name = "coconut";
  const b = new PartBuilder();
  const r = rng(12);
  const H = 0.29, CUT = 0.205; // the cream peeled cone starts ~CUT (jagged edge painted in the texture)
  const prof: Array<[number, number]> = [[0.0001, 0], [0.055, 0.004], [0.1, 0.026], [0.128, 0.07], [0.136, 0.115], [0.131, 0.16], [0.116, 0.195], [0.104, CUT], [0.086, 0.236], [0.064, 0.262], [0.042, 0.28], [0.028, H]];
  const vCut = CUT / H;
  const tex = canvasTex(1024, 512, (x) => {
    // husk: fresh green, darker + browner toward the base, fibre streaks
    const g = x.createLinearGradient(0, 512, 0, 0); g.addColorStop(0, "#5e4a1c"); g.addColorStop(0.14, "#5a7a22"); g.addColorStop(0.45, "#7aa02e"); g.addColorStop(vCut, "#95b93c"); x.fillStyle = g; x.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 160; i++) { x.strokeStyle = r() < 0.55 ? `rgba(40,80,15,${0.08 + r() * 0.16})` : `rgba(180,225,110,${0.08 + r() * 0.12})`; x.lineWidth = 1 + r() * 3; const px = r() * 1024; x.beginPath(); x.moveTo(px, 512); x.bezierCurveTo(px + (r() - 0.5) * 20, 380, px + (r() - 0.5) * 20, 240, px + (r() - 0.5) * 16, 140); x.stroke(); }
    // peeled top: cream fibre with a jagged lower edge
    const yc = 512 * (1 - vCut);
    x.fillStyle = "#efe2bd";
    x.beginPath(); x.moveTo(0, 0); x.lineTo(1024, 0); x.lineTo(1024, yc);
    for (let px = 1024; px >= 0; px -= 16) x.lineTo(px, yc + (r() - 0.3) * 22);
    x.closePath(); x.fill();
    for (let i = 0; i < 240; i++) { x.strokeStyle = r() < 0.5 ? `rgba(170,150,100,${0.2 + r() * 0.3})` : `rgba(255,250,235,${0.3 + r() * 0.3})`; x.lineWidth = 1 + r() * 2; const px = r() * 1024, py = r() * yc; x.beginPath(); x.moveTo(px, py); x.lineTo(px + (r() - 0.5) * 6, py + 10 + r() * 30); x.stroke(); }
    // kong shield stencil (pale cream), front = u .5
    const cx = 512, cy = 512 * (1 - 0.5);
    // the shared gorilla emblem (paintKong) as a bust inside the hex shield
    x.strokeStyle = "rgba(240,232,205,.92)"; x.lineWidth = 11; shieldPath(x, cx, cy, 84, true); x.stroke();
    x.fillStyle = "rgba(240,232,205,.92)"; x.beginPath(); x.moveTo(cx - 62, cy + 70); x.quadraticCurveTo(cx - 58, cy + 26, cx - 22, cy + 22); x.lineTo(cx + 22, cy + 22); x.quadraticCurveTo(cx + 58, cy + 26, cx + 62, cy + 70); x.closePath(); x.fill();
    paintKong(x, cx, cy - 8, 40, "rgba(240,232,205,.95)", "#6f932a", { line: 0.07 });
    // distress
    x.globalCompositeOperation = "destination-over";
  });
  tex.offset.x = 0.5;
  const husk = latheUV(prof, 56);
  root.add(mesh(husk, mat({ map: tex, roughness: 0.62 }, "coconut-husk"), "coconut-husk"));
  // drinking hole + a dark rim, straw
  b.add(lathe([[0.03, H - 0.001], [0.022, H - 0.004], [0.0001, H - 0.012]], 24), "#3a2412", "matte");
  const st = straw("#e8608a", 0.2, 0.0095); st.position.set(0.014, H + 0.055, 0.0); st.rotation.set(0.05, 0, -0.22); root.add(st);
  // twine around the belly with a knot on the right and two dangling ends
  const tr = 0.131;
  const ring: THREE.Vector3[] = []; for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; ring.push(new THREE.Vector3(Math.sin(a) * tr, 0.135 + Math.sin(a * 2 + 0.4) * 0.004, Math.cos(a) * tr)); }
  twine(b, ring, 0.0045, true);
  const kp = new THREE.Vector3(Math.sin(1.35) * (tr + 0.006), 0.134, Math.cos(1.35) * (tr + 0.006));
  b.add(new THREE.SphereGeometry(0.013, 12, 8).scale(1, 0.85, 1.2), "#cfa66a", "rope", tf(kp.toArray() as [number, number, number]));
  b.add(new THREE.TorusGeometry(0.01, 0.0045, 6, 14), "#cfa66a", "rope", tf([kp.x + 0.004, kp.y + 0.004, kp.z + 0.006], [0.4, 1.2, 0.5]));
  // the two knot ends hang ON the husk (each point pushed onto the lathe surface + the cord radius)
  const onHusk = (a: number, y: number) => { let rr = 0; for (let k = 1; k < prof.length; k++) if (y <= prof[k][1]) { const t = (y - prof[k - 1][1]) / (prof[k][1] - prof[k - 1][1]); rr = prof[k - 1][0] + (prof[k][0] - prof[k - 1][0]) * t; break; } rr += 0.005; return new THREE.Vector3(Math.sin(a) * rr, y, Math.cos(a) * rr); };
  twine(b, [kp.clone(), onHusk(1.42, 0.118), onHusk(1.47, 0.09), onHusk(1.5, 0.068)], 0.0042);
  twine(b, [kp.clone(), onHusk(1.28, 0.116), onHusk(1.22, 0.092), onHusk(1.18, 0.074)], 0.0042);
  const built = b.build({ name: "coconut-parts" });
  root.add(built.root);
  return { root, meshes: [], tris: 0, pivots: {} };
}

// ------------------------------------------------------------------------------------------------ leaf bundle
// a squarish pillow WRAPPED in five real banana-
// leaf sheets. Each sheet is a strip laid ON a rounded-box (superellipsoid) surface — around X (over the top, front to
// back) or around Z (side to side) — a layer proud of the previous one, its edges lifting a little, its end tapering
// to a tip that lies flat on the pillow (tucked, never sticking out). Painted leaf: pale midrib, parallel veins, darker
// rims, a few splits. Two DOUBLE twine lashings cross on top under a stitched canvas patch with a red cross.
const BUN = { a: 0.155, b: 0.08, c: 0.13, n: 5 };
/** superellipsoid radius toward (dy, dz) in the YZ plane at a given x (null outside) */
function bunSurfX(x: number, phi: number, grow = 0): THREE.Vector3 {
  const { a, b, c, n } = BUN;
  const fx = Math.min(0.999, Math.pow(Math.abs(x) / a, n));
  const cy = Math.cos(phi), sz = Math.sin(phi);
  const r = Math.pow((1 - fx) / (Math.pow(Math.abs(cy) / b, n) + Math.pow(Math.abs(sz) / c, n)), 1 / n);
  const p = new THREE.Vector3(x, cy * r, sz * r);
  return p.addScaledVector(bunNormal(p), grow);
}
function bunSurfZ(z: number, phi: number, grow = 0): THREE.Vector3 {
  const { a, b, c, n } = BUN;
  const fz = Math.min(0.999, Math.pow(Math.abs(z) / c, n));
  const cy = Math.cos(phi), sx = Math.sin(phi);
  const r = Math.pow((1 - fz) / (Math.pow(Math.abs(cy) / b, n) + Math.pow(Math.abs(sx) / a, n)), 1 / n);
  const p = new THREE.Vector3(sx * r, cy * r, z);
  return p.addScaledVector(bunNormal(p), grow);
}
function bunNormal(p: THREE.Vector3): THREE.Vector3 {
  const { a, b, c, n } = BUN;
  const g = (v: number, s: number) => Math.sign(v) * Math.pow(Math.abs(v) / s, n - 1) / s;
  return new THREE.Vector3(g(p.x, a), g(p.y, b), g(p.z, c)).normalize();
}
let bunLeafTex: THREE.CanvasTexture | null = null;
function bundleLeafTex(): THREE.CanvasTexture {
  if (bunLeafTex) return bunLeafTex;
  const r = rng(33);
  bunLeafTex = canvasTex(1024, 256, (x) => {
    // u (x) = along the sheet, v (y) = across; the midrib at v .5
    const g = x.createLinearGradient(0, 0, 0, 256);
    // deeper banana-leaf greens (the target art's #3f8a2a parcel; a lime read neon)
    g.addColorStop(0, "#23480c"); g.addColorStop(0.1, "#336614"); g.addColorStop(0.32, "#417c1c"); g.addColorStop(0.5, "#54922a"); g.addColorStop(0.68, "#417c1c"); g.addColorStop(0.9, "#336614"); g.addColorStop(1, "#23480c");
    x.fillStyle = g; x.fillRect(0, 0, 1024, 256);
    // broad painterly light streaks along the leaf
    for (let i = 0; i < 26; i++) { x.strokeStyle = `rgba(${r() < 0.5 ? "150,200,70" : "30,70,10"},${0.06 + r() * 0.1})`; x.lineWidth = 6 + r() * 14; const y = 20 + r() * 216; x.beginPath(); x.moveTo(0, y); x.bezierCurveTo(300, y + (r() - 0.5) * 20, 700, y + (r() - 0.5) * 20, 1024, y + (r() - 0.5) * 16); x.stroke(); }
    // parallel veins running out from the midrib at ~60°
    for (let u = -80; u < 1100; u += 9) {
      x.strokeStyle = `rgba(28,64,10,${0.18 + r() * 0.12})`; x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(u, 124); x.quadraticCurveTo(u + 30, 60, u + 60, 2); x.moveTo(u, 132); x.quadraticCurveTo(u + 30, 196, u + 60, 254); x.stroke();
      if (r() < 0.35) { x.strokeStyle = "rgba(170,215,95,.18)"; x.lineWidth = 1; x.beginPath(); x.moveTo(u + 3, 124); x.quadraticCurveTo(u + 33, 60, u + 63, 2); x.stroke(); }
    }
    // pale raised midrib with a dark edge
    x.fillStyle = "rgba(30,70,12,.45)"; x.fillRect(0, 122, 1024, 12);
    const mg = x.createLinearGradient(0, 123, 0, 133); mg.addColorStop(0, "#9cc255"); mg.addColorStop(1, "#6f9a30"); x.fillStyle = mg; x.fillRect(0, 124, 1024, 7);
    // splits along the veins (a lit lip + dark gap)
    for (let i = 0; i < 9; i++) { const u = r() * 1024, top = r() < 0.5; x.strokeStyle = "rgba(20,45,8,.75)"; x.lineWidth = 2; x.beginPath(); x.moveTo(u, top ? 0 : 256); x.lineTo(u + 22, top ? 40 + r() * 40 : 216 - r() * 40); x.stroke(); x.strokeStyle = "rgba(190,225,120,.45)"; x.lineWidth = 1; x.beginPath(); x.moveTo(u + 2, top ? 0 : 256); x.lineTo(u + 24, top ? 40 : 216); x.stroke(); }
    // darker, slightly yellowed rims
    // leaf rims: a dark fold line + a lit lip (each sheet edge reads as a separate overlapping leaf)
    x.fillStyle = "rgba(18,40,6,.8)"; x.fillRect(0, 0, 1024, 7); x.fillRect(0, 249, 1024, 7);
    x.fillStyle = "rgba(170,210,90,.55)"; x.fillRect(0, 7, 1024, 3); x.fillRect(0, 246, 1024, 3);
  }, true, false);
  bunLeafTex.wrapS = THREE.RepeatWrapping;
  return bunLeafTex;
}
/** a leaf sheet laid on the pillow: axis 'x' (wraps round X: over the top front↔back at x = off) or 'z' (round Z at
 *  z = off); phi0 → phi1 = the wrap angles; hw = half width; layer = offset out; tip = taper at the phi1 end */
function bundleSheet(axis: "x" | "z", off: number, phi0: number, phi1: number, hw: number, layer: number, tip0 = 0.12, tip1 = 0.28, skew = 0): THREE.BufferGeometry {
  const nu = 44, nv = 10, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const surf = axis === "x" ? bunSurfX : bunSurfZ;
  let len = 0; let prev: THREE.Vector3 | null = null;
  for (let i = 0; i <= nu; i++) { const p = surf(off, phi0 + (phi1 - phi0) * (i / nu)); if (prev) len += p.distanceTo(prev); prev = p; }
  for (let i = 0; i <= nu; i++) {
    const u = i / nu, phi = phi0 + (phi1 - phi0) * u;
    // width: blunt start (tucked under the previous sheet), a long pointed tip at the end
    const wStart = Math.min(1, u / tip0 * 0.6 + 0.4), wEnd = u > 1 - tip1 ? Math.pow((1 - u) / tip1, 0.8) : 1;
    const w = hw * Math.min(wStart, wEnd);
    for (let j = 0; j <= nv; j++) {
      const v = j / nv - 0.5;
      const o2 = off + v * 2 * w + skew * (u - 0.5) * hw;
      // edges lift off the layer below (the overlapping-leaf read), the blade ripples a little
      const lift = layer + 0.0055 * Math.pow(Math.abs(v * 2), 4) + 0.0014 * Math.sin(u * 17 + v * 3); // less edge lift → no dark gaps between layers
      const p = surf(o2, phi, lift);
      pos.push(p.x, p.y, p.z); uv.push(u * len / 0.34, j / nv);
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const a0 = i * (nv + 1) + j, b0 = a0 + nv + 1; idx.push(a0, b0, a0 + 1, b0, b0 + 1, a0 + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  // outward check: the first row's normal must point away from the centre
  const n0 = new THREE.Vector3().fromBufferAttribute(g.attributes.normal as THREE.BufferAttribute, (nu >> 1) * (nv + 1) + (nv >> 1));
  const p0 = new THREE.Vector3().fromBufferAttribute(g.attributes.position as THREE.BufferAttribute, (nu >> 1) * (nv + 1) + (nv >> 1));
  if (n0.dot(p0) < 0) { const ix = g.index!.array as Uint16Array | Uint32Array; for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; } g.computeVertexNormals(); }
  return g;
}
function leafBundle(): Built {
  const root = new THREE.Group(); root.name = "leaf-bundle";
  const b = new PartBuilder();
  const H0 = BUN.b + 0.004;   // lift so the bottom sits on y = 0
  // core pillow (dark leaf green; mostly hidden)
  const core = new THREE.SphereGeometry(1, 48, 32);
  { const p = core.attributes.position as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) { const d = new THREE.Vector3().fromBufferAttribute(p, i); const phi = Math.atan2(d.z, d.y); const q = bunSurfX(d.x * BUN.a * 0.999, phi); p.setXYZ(i, q.x, q.y, q.z); } core.computeVertexNormals(); }
  b.add(core, "#2f5a12", "matte", tf([0, H0, 0]));
  const leafM = mat({ map: bundleLeafTex(), roughness: 0.58, side: THREE.DoubleSide }, "bundle-wrap");
  addGlint(leafM, 0.1, { key: 0.6 });
  const sheet = (g: THREE.BufferGeometry, name: string) => { const m2 = mesh(g, leafM, name); m2.position.y = H0; m2.userData.lodColor = "#4f8a1c"; root.add(m2); };
  const P = Math.PI;
  // layer 0: two long sheets round Z (side to side, under → over → under), covering the whole pillow
  sheet(bundleSheet("z", -0.06, -P * 0.95, P * 0.95, 0.085, 0.002, 0.1, 0.2, 0.1), "bundle-leaf");
  sheet(bundleSheet("z", 0.065, P * 0.95, -P * 0.9, 0.085, 0.004, 0.1, 0.22, -0.1), "bundle-leaf");
  // layer 1: two sheets round X (front → over the top → back), their tips tucked on the underside / back
  sheet(bundleSheet("x", -0.07, P * 0.8, -P * 0.75, 0.095, 0.008, 0.08, 0.25, 0.08), "bundle-leaf");
  sheet(bundleSheet("x", 0.075, -P * 0.85, P * 0.7, 0.09, 0.011, 0.08, 0.3, -0.12), "bundle-leaf");
  // layer 2: the top fold — a shorter sheet over the top whose pointed tip lies on the front-right shoulder
  sheet(bundleSheet("z", 0.01, -P * 0.62, P * 0.5, 0.075, 0.015, 0.2, 0.42, 0.25), "bundle-leaf");
  // twine: two DOUBLE lashings crossing on top (one round Z at x ≈ −0.02, one round X at z ≈ 0.02, both a little skewed)
  const cordR = 0.0048, grow = 0.0165 + cordR * 0.75; // seated on the top leaf layer (not floating ~1 cm off)
  const lash = (axis: "x" | "z", off: number, skew: number) => {
    for (const d of [-0.0065, 0.0065]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 96; i++) {
        const phi = (i / 96) * P * 2;
        const o2 = off + d + skew * Math.cos(phi) * 0.03;
        const p = (axis === "x" ? bunSurfX : bunSurfZ)(o2, phi, grow);
        p.y += H0; pts.push(p);
      }
      b.add(rope(pts, cordR, true, cordR * 5, 8, 200), "#c9a068", "rope");
    }
  };
  lash("z", -0.015, 0.5); lash("x", 0.02, -0.6);
  // a small knot where they cross (under the patch edge)
  const built = b.build({ name: "leaf-bundle-parts" });
  root.add(built.root);
  // canvas patch at the crossing, lying on the top (stitched border, weave, red cross)
  const patchTex = canvasTex(512, 512, (x) => {
    x.fillStyle = "#ece0c2"; x.fillRect(0, 0, 512, 512);
    const rr = rng(8);
    x.strokeStyle = "rgba(160,140,100,.3)"; x.lineWidth = 2; for (let i = 0; i < 512; i += 6) { x.beginPath(); x.moveTo(i + rr() * 2, 0); x.lineTo(i, 512); x.moveTo(0, i); x.lineTo(512, i + rr() * 2); x.stroke(); }
    for (let i = 0; i < 60; i++) { x.fillStyle = `rgba(150,120,80,${0.05 + rr() * 0.08})`; x.beginPath(); x.ellipse(rr() * 512, rr() * 512, 10 + rr() * 40, 6 + rr() * 20, rr() * 3, 0, Math.PI * 2); x.fill(); }
    // red cross, slightly worn
    x.fillStyle = "#c62f24"; x.fillRect(196, 104, 120, 304); x.fillRect(104, 196, 304, 120);
    x.globalCompositeOperation = "destination-out"; for (let i = 0; i < 300; i++) { x.fillStyle = `rgba(0,0,0,${rr() * 0.3})`; x.beginPath(); x.arc(100 + rr() * 312, 100 + rr() * 312, rr() * 3, 0, Math.PI * 2); x.fill(); } x.globalCompositeOperation = "source-over";
    x.strokeStyle = "rgba(110,80,40,.85)"; x.lineWidth = 5; x.setLineDash([16, 12]); x.beginPath(); x.arc(256, 256, 226, 0, Math.PI * 2); x.stroke(); x.setLineDash([]);
    x.strokeStyle = "rgba(190,170,130,1)"; x.lineWidth = 10; x.beginPath(); x.arc(256, 256, 250, 0, Math.PI * 2); x.stroke();
  }, true, false);
  const pr = 0.068;
  const patchG = new THREE.CylinderGeometry(pr, pr * 1.02, 0.008, 48, 1);
  // domed to sit on the leaf layers
  { const p = patchG.attributes.position as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) { const rr2 = Math.hypot(p.getX(i), p.getZ(i)); p.setY(i, p.getY(i) - rr2 * rr2 * 1.6); } patchG.computeVertexNormals(); }
  const patch = mesh(patchG, [mat({ color: "#cdbb94", roughness: 0.9 }, "patch-edge"), mat({ map: patchTex, roughness: 0.9 }, "patch-face"), mat({ color: "#cdbb94", roughness: 0.9 }, "patch-edge")] as unknown as THREE.Material, "leaf-patch");
  const top = bunSurfX(0.0, 0.05, 0.034); top.y += H0;
  patch.position.copy(top); patch.rotation.set(0.1, 0.3, -0.03);
  root.add(patch);
  return { root, meshes: [], tris: 0, pivots: {} };
}

// ------------------------------------------------------------------------------------------------ golden banana
// a faceted banana standing STEM-UP whose thick
// stem end is capped by a crown seated right on it (no neck), in a real polished-gold material: metalness 1 against a
// HIGH-CONTRAST HDR studio env (white softbox strips + a warm-white top over dark umber) → pale-gold highlights, rich
// gold mids, dark amber falloff along every facet; clearcoat for the white glints; a bronze kong-shield emblem wrapped
// onto the belly; brown cut tip; sparkles.
let goldEnv: THREE.DataTexture | null = null;
function goldEnvTex(): THREE.DataTexture {
  if (goldEnv) return goldEnv;
  const W = 256, H = 128, data = new Uint16Array(W * H * 4);
  const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const el = 90 - (j + 0.5) / H * 180, az = (i + 0.5) / W * 360;
    // warm umber below, warm grey mid, a bright warm-white dome above
    let v = el < -5 ? 0.05 + 0.1 * sm(-60, -8, el) : 0.22 + 0.5 * sm(15, 70, el);
    // two big vertical-ish softboxes (key front-left, fill right) + a thin horizon strip
    const box = (a0: number, a1: number, e0: number, e1: number, k: number) => sm(a0 - 4, a0 + 2, az) * (1 - sm(a1 - 2, a1 + 4, az)) * sm(e0 - 3, e0 + 2, el) * (1 - sm(e1 - 2, e1 + 3, el)) * k;
    v += box(150, 190, 8, 62, 4.2) + box(250, 268, 4, 50, 2.4) + box(20, 70, 18, 40, 1.6);
    v += 1.8 * sm(-2.5, 0, el) * (1 - sm(0, 2.5, el));
    // dark flags between the boxes (the target art's dark reflection bands)
    v *= 1 - 0.75 * sm(195, 205, az) * (1 - sm(235, 245, az)) * sm(-5, 5, el) * (1 - sm(40, 55, el));
    const k = (j * W + i) * 4;
    data[k] = THREE.DataUtils.toHalfFloat(v * 1.0); data[k + 1] = THREE.DataUtils.toHalfFloat(v * 0.98); data[k + 2] = THREE.DataUtils.toHalfFloat(v * 0.92); data[k + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  goldEnv = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  goldEnv.mapping = THREE.EquirectangularReflectionMapping; goldEnv.colorSpace = THREE.LinearSRGBColorSpace;
  goldEnv.magFilter = THREE.LinearFilter; goldEnv.minFilter = THREE.LinearFilter; goldEnv.generateMipmaps = false; goldEnv.needsUpdate = true;
  return goldEnv;
}
let goldM: THREE.MeshPhysicalMaterial | null = null;
export function goldMat(): THREE.MeshPhysicalMaterial {
  if (goldM) return goldM;
  goldM = new THREE.MeshPhysicalMaterial({ color: "#ffcc0a", metalness: 1, roughness: 0.2, clearcoat: 0.4, clearcoatRoughness: 0.06, envMap: goldEnvTex(), envMapIntensity: 1.15, emissive: new THREE.Color("#5a3400"), emissiveIntensity: 0.22 });
  goldM.name = "golden-banana";
  addGlint(goldM, 0.3, { ring: 0.8, line: 0.5, key: 1.6 });
  return goldM;
}
function goldenBanana(): Built {
  const root = new THREE.Group(); root.name = "golden-banana";
  // a real banana silhouette (a plain thick-to-thin profile reads as a horn): a slightly narrower neck under the
  // crown, full through the middle, a quick taper to the cut tip, and a strong C curl
  const L = 0.44, R = 0.09;
  // the stem end NARROWS to a neck (0.56 R) the crown sits
  // on, the chord leans only ~20° (the target art's stem stands upright, the body sweeps down-left)
  const o = { length: L, radius: R, bend: 1.3, facets: 5, round: 0.36, along: 64, radial: 60, profile: [0.56, 0.7, 0.88, 0.98, 1, 1, 0.98, 0.93, 0.82, 0.62, 0.34] };
  const g = bananaGeometry(o);
  // stand it STEM-UP: banana +X (stem → tip) → down, its concave side (+Y) → left; lean the chord so the stem stands
  // upright and the tip sweeps out to the lower left
  const m = new THREE.Matrix4().makeRotationZ(-0.42).multiply(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1)));
  g.applyMatrix4(m);
  const gold = goldMat();
  const body = mesh(g, gold, "golden-banana"); body.userData.lodColor = "#f0b41a";
  const grp = new THREE.Group(); grp.add(body);
  const stem = bananaAt(o, 0), tip = bananaAt(o, 1);
  const sc = stem.center.clone().applyMatrix4(m), up = stem.dir.clone().negate().transformDirection(m).normalize();
  const tc = tip.center.clone().applyMatrix4(m), tdir = tip.dir.clone().transformDirection(m).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  const r0 = stem.radius;   // section corner radius at the stem end (the neck)
  const cap = mesh(new THREE.CircleGeometry(r0 * 1.02, 40).rotateX(-Math.PI / 2), gold, "gb-cap"); cap.position.copy(sc); cap.quaternion.copy(q); grp.add(cap);
  // crown seated ON the neck: ONE bent zigzag sheet (a band flaring from the neck with five points, the valleys joined
  // like a real crown), a rolled lip at the base, a ball fixed ON every point, a jewel on the band front
  const crown = new THREE.Group(); crown.name = "gb-crown"; crown.position.copy(sc).addScaledVector(up, -0.016); crown.quaternion.copy(q);
  {
    const rb = r0 * 1.04, rt = R * 0.84, bh = 0.022, ph = 0.03, N = 5, TH = 0.005;
    // unrolled outline (u ∈ [0, 1] round the crown, y up): flat bottom, top = band height + zigzag points
    const top = (u: number) => { const f = (u * N) % 1; return bh + ph * (1 - Math.abs(f - 0.5) * 2); };
    const radAt = (y: number) => rb + (rt - rb) * Math.min(1, y / (bh + ph));
    const cols = N * 16, rows = 10, pos: number[] = [], idx: number[] = [];
    // two skins (outer / inner) + the top edge strip: a grid (cols × rows) per skin, u wraps
    const vert = (u: number, v: number, outer: boolean) => { const y = v * top(u), r = radAt(y) + (outer ? TH / 2 : -TH / 2), a = u * Math.PI * 2; return [Math.sin(a) * r, y, Math.cos(a) * r]; };
    for (const outer of [true, false]) {
      const base = pos.length / 3;
      for (let i = 0; i <= cols; i++) for (let j = 0; j <= rows; j++) pos.push(...vert(i / cols, j / rows, outer));
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) { const a = base + i * (rows + 1) + j, b2 = a + rows + 1; if (outer) idx.push(a, b2, a + 1, b2, b2 + 1, a + 1); else idx.push(a, a + 1, b2, b2, a + 1, b2 + 1); }
    }
    { const base = pos.length / 3; for (let i = 0; i <= cols; i++) { pos.push(...vert(i / cols, 1, true)); pos.push(...vert(i / cols, 1, false)); } for (let i = 0; i < cols; i++) { const a = base + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
    const cg = new THREE.BufferGeometry(); cg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); cg.setIndex(idx); cg.computeVertexNormals();
    crown.add(mesh(cg, gold, "gb-crown-band"));
    // rolled base lip + a mid bead
    crown.add(mesh(new THREE.TorusGeometry(rb + TH * 0.6, 0.0045, 10, 48).rotateX(Math.PI / 2), gold, "gb-crown-lip"));
    crown.add(mesh(new THREE.TorusGeometry(radAt(bh * 0.9) + TH * 0.4, 0.0028, 8, 48).rotateX(Math.PI / 2).translate(0, bh * 0.9, 0), gold, "gb-crown-bead"));
    for (let k = 0; k < N; k++) {
      const u = (k + 0.5) / N, a = u * Math.PI * 2, y = bh + ph, r = radAt(y);
      const ball = mesh(new THREE.SphereGeometry(0.0085, 16, 12), gold, "gb-crown-ball");
      ball.position.set(Math.sin(a) * r, y + 0.006, Math.cos(a) * r); crown.add(ball);
      // a small jewel on the band under each point
      const jw = mesh(new THREE.SphereGeometry(0.0055, 12, 8).scale(1, 1, 0.5), gold, "gb-jewel");
      const rj = radAt(bh * 0.45) + TH;
      jw.position.set(Math.sin(a) * rj, bh * 0.45, Math.cos(a) * rj); jw.lookAt(Math.sin(a) * 2, bh * 0.45, Math.cos(a) * 2); crown.add(jw);
    }
  }
  grp.add(crown);
  // brown cut tip: a short dark stub with a paler cut face
  const tipG = filletCyl(tip.radius * 0.95, 0.022, 0.004, 20); tipG.translate(0, 0.006, 0);
  const tipM = mesh(tipG, mat({ color: "#5a3418", roughness: 0.55 }, "gb-tip"), "gb-tip"); tipM.position.copy(tc); tipM.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tdir); tipM.userData.lodColor = "#5a3418"; grp.add(tipM);
  // kong-shield emblem WRAPPED onto the front of the belly at t = .44
  const embTex = canvasTex(512, 512, (x) => {
    x.fillStyle = "#4a2a0c"; x.fillRect(0, 0, 512, 512);
    shieldPath(x, 256, 250, 190); x.fillStyle = "#5c3510"; x.fill();
    shieldPath(x, 256, 250, 158); const gr = x.createLinearGradient(100, 60, 420, 460); gr.addColorStop(0, "#c98a2a"); gr.addColorStop(0.5, "#a06418"); gr.addColorStop(1, "#6e400c"); x.fillStyle = gr; x.fill();
    x.strokeStyle = "#f2c24a"; x.lineWidth = 6; shieldPath(x, 256, 250, 166); x.stroke();
    paintKong(x, 256, 262, 96, "#f8d25a", "#3a1e04", { light: "#ffe79a", line: 0.075 });
  }, true, false);
  // a thin bronze plate lying FLAT on the banana's front facet (5 facets: faces at θ = 0, ±72°, ±144° from the concave
  // side; θ = −72° faces the camera) at t = .46, its long axis along the banana
  const sh = new THREE.Shape(); const w = 0.036; sh.moveTo(-w, w * 0.95); sh.lineTo(w, w * 0.95); sh.lineTo(w, -w * 0.15); sh.quadraticCurveTo(w, -w * 0.85, 0, -w * 1.26); sh.quadraticCurveTo(-w, -w * 0.85, -w, -w * 0.15); sh.closePath();
  const eg = new THREE.ExtrudeGeometry(sh, { depth: 0.002, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0012, bevelSegments: 2, curveSegments: 10 });
  { const p = eg.attributes.position as THREE.BufferAttribute, uv = eg.attributes.uv as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / (2.3 * w) + 0.5, p.getY(i) / (2.4 * w) + 0.52); }
  const tE = 0.46, aE = -o.bend / 2 + o.bend * tE, fE = bananaAt(o, tE);
  const Nw = new THREE.Vector3(-Math.sin(aE), Math.cos(aE), 0).transformDirection(m), Bw = new THREE.Vector3(0, 0, 1).transformDirection(m);
  const th = -(72 * Math.PI) / 180;
  const nE = Nw.clone().multiplyScalar(Math.cos(th)).addScaledVector(Bw, Math.sin(th)).normalize();
  if (nE.z < 0) nE.copy(Nw).multiplyScalar(Math.cos(th)).addScaledVector(Bw, -Math.sin(th)).normalize();
  const faceD = fE.radius * ((1 - o.round) * Math.cos(Math.PI / 5) + o.round);
  const fc = fE.center.clone().applyMatrix4(m), fdir = fE.dir.clone().transformDirection(m).normalize();
  const em = mesh(eg, [mat({ map: embTex, roughness: 0.34, metalness: 0.3, envMap: goldEnvTex(), envMapIntensity: 0.7 }, "gb-emblem"), mat({ color: "#6a3e10", roughness: 0.35, metalness: 0.5, envMap: goldEnvTex() }, "gb-emblem-rim")] as unknown as THREE.Material, "gb-emblem");
  em.userData.lodColor = "#8a5a12";
  const upE = fdir.clone().negate().projectOnPlane(nE).normalize();
  const bx = new THREE.Vector3().crossVectors(upE, nE);
  em.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(bx, upE, nE));
  em.position.copy(fc).addScaledVector(nE, faceD - 0.0006);
  grp.add(em);
  // sparkle glints (additive star sprites) round the silhouette
  const spark = canvasTex(64, 64, (x) => { const c = 32; const gg = x.createRadialGradient(c, c, 0, c, c, c); gg.addColorStop(0, "rgba(255,255,255,1)"); gg.addColorStop(0.3, "rgba(255,250,200,.4)"); gg.addColorStop(1, "rgba(255,240,180,0)"); x.fillStyle = gg; x.fillRect(0, 0, 64, 64); x.fillStyle = "#fff"; x.beginPath(); x.moveTo(c, 0); x.quadraticCurveTo(c, c, 64, c); x.quadraticCurveTo(c, c, c, 64); x.quadraticCurveTo(c, c, 0, c); x.quadraticCurveTo(c, c, c, 0); x.fill(); }, true, false);
  const spm = new THREE.SpriteMaterial({ map: spark, color: new THREE.Color(2.0, 1.85, 1.3), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  // stand it on the ground: bottom at y = 0, centred in x / z
  grp.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(grp);
  grp.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  root.add(grp);
  const hgt = bb.max.y - bb.min.y, wid = bb.max.x - bb.min.x;
  for (const [x, y, z, s] of [[-wid * 0.2, hgt * 0.62, 0.06, 0.07], [wid * 0.42, hgt * 0.38, 0.07, 0.045], [-wid * 0.34, hgt * 0.16, 0.08, 0.035], [wid * 0.1, hgt * 0.93, 0.05, 0.03]] as Array<[number, number, number, number]>) {
    const sp = new THREE.Sprite(spm); sp.position.set(x, y, z); sp.scale.setScalar(s); sp.name = "gb-glint"; sp.userData.castShadow = false; root.add(sp);
  }
  return { root, meshes: [], tris: 0, pivots: {} };
}

/** the RED BANANA, an unmistakable BANANA: the classic half-peeled silhouette — standing stem-up, the
 *  top third peeled, three red peel petals folded down and curling out (cream undersides), the pale peach flesh standing
 *  out of them with a rounded top; a plump five-faceted body in real red-banana colours (deep maroon-red with darker
 *  ridges, sugar spots and fibre streaks), a dark flower-end tip, a short stem stub on one petal. A faint red glow keeps
 *  it reading as special on the ground. */
function redBanana(): Built {
  const root = new THREE.Group(); root.name = "red-banana";
  const o = { length: 0.42, radius: 0.08, bend: 1.05, facets: 5, round: 0.38, profile: [0.62, 0.8, 0.92, 0.98, 1, 1, 0.98, 0.93, 0.82, 0.62, 0.34] };
  const tab = roundedPolyPolar(o.facets, o.round);
  const R = o.length / (2 * Math.sin(o.bend / 2));
  /** a span of the banana surface from t0 to t1 (closed round), radius = o.radius × profile × rk(t) × facet(θ) */
  const span = (t0: number, t1: number, along: number, radial: number, rk: (t: number) => number, facet = 1) => gridGeometry(along + 1, radial, (i, j, out) => {
    const t = t0 + (t1 - t0) * (i / along), a = -o.bend / 2 + o.bend * t;
    const cx = R * (Math.sin(a) + Math.sin(o.bend / 2)), cy = -R * (Math.cos(a) - Math.cos(o.bend / 2));
    const th = (j / radial) * Math.PI * 2, f = 1 + (polarAt(tab, th) - 1) * facet;
    const rr = o.radius * catmull1(o.profile, t) * rk(t) * f;
    out.set(cx - Math.sin(a) * rr * Math.cos(th), cy + Math.cos(a) * rr * Math.cos(th), rr * Math.sin(th));
  }, true, [o.length * 4 * (t1 - t0), 1]);
  const T_PEEL = 0.33;
  // ---- the peel: a texture of real red-banana skin (maroon-red, darker streaks along the fibres, lighter ridges, sugar
  // spots); u runs along the banana, v round it (gridGeometry's uv)
  const peelTex = canvasTex(512, 256, (x) => {
    const r = rng(41);
    const g0 = x.createLinearGradient(0, 0, 0, 256);
    // five facets round v: each face a little lighter in its middle, darker at the ridges
    for (let k = 0; k < 5; k++) { const y0 = (k / 5) * 256, y1 = ((k + 1) / 5) * 256; const gg = x.createLinearGradient(0, y0, 0, y1); gg.addColorStop(0, "#5e1022"); gg.addColorStop(0.5, "#a2213a"); gg.addColorStop(1, "#5e1022"); x.fillStyle = gg; x.fillRect(0, y0, 512, y1 - y0); }
    void g0;
    for (let i = 0; i < 220; i++) { const y = r() * 256, x0 = r() * 512, l = 40 + r() * 160, w = 0.6 + r() * 1.6; x.strokeStyle = r() < 0.6 ? `rgba(70,8,16,${0.18 + r() * 0.2})` : `rgba(230,96,88,${0.12 + r() * 0.14})`; x.lineWidth = w; x.beginPath(); x.moveTo(x0, y); x.lineTo(x0 + l, y + (r() - 0.5) * 3); x.stroke(); }
    for (let i = 0; i < 26; i++) { const cx = r() * 512, cy = r() * 256, rr = 1.5 + r() * 4; const gg = x.createRadialGradient(cx, cy, 0, cx, cy, rr * 1.8); gg.addColorStop(0, "rgba(40,6,8,0.9)"); gg.addColorStop(1, "rgba(60,10,12,0)"); x.fillStyle = gg; x.beginPath(); x.ellipse(cx, cy, rr * 2.2, rr, 0, 0, Math.PI * 2); x.fill(); }
  });
  peelTex.wrapT = THREE.RepeatWrapping;
  const peel = new THREE.MeshPhysicalMaterial({ map: peelTex, roughness: 0.42, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.3, sheen: 0.35, sheenColor: new THREE.Color("#ff8a7a"), emissive: new THREE.Color("#3a0408"), emissiveIntensity: 0.6 });
  peel.name = "red-banana";
  const inner = mat({ color: "#f1e2c2", roughness: 0.7, side: THREE.DoubleSide }, "rb-peel-in");
  // the flesh: pale peach-cream, faint lengthwise lines (vertex colour streaks), a soft waxy sheen
  const fleshM = mat({ color: "#ffffff", vertexColors: true, roughness: 0.55, emissive: new THREE.Color("#2a1608"), emissiveIntensity: 0.25 }, "rb-flesh");
  const grp = new THREE.Group();
  // the body: the peel from the peel line down to the flower end, a dark cap at the end
  const body = mesh(span(T_PEEL, 1, 44, 60, () => 1), peel, "red-banana"); body.userData.lodColor = "#8e1c33"; grp.add(body);
  // the peel's torn rim at the peel line: a slightly proud, lighter band
  const rim = mesh(span(T_PEEL - 0.004, T_PEEL + 0.018, 2, 60, (t) => 1.035 - 0.02 * Math.abs(t - T_PEEL) / 0.02), inner, "rb-rim"); rim.userData.lodColor = "#e8d3b0"; grp.add(rim);
  // the flesh core: from just below the peel line up, its top rounded into a dome
  const T_TOP = 0.03, CAP = 0.11;
  const fleshG = span(T_TOP, T_PEEL + 0.06, 30, 40, (t) => 0.8 * (t < T_TOP + CAP ? Math.sqrt(Math.max(0.0004, 1 - Math.pow((T_TOP + CAP - t) / CAP, 2))) : 1), 0.35);
  { const pp = fleshG.attributes.position as THREE.BufferAttribute, n = pp.count, col = new Float32Array(n * 3), c = new THREE.Color(), a = new THREE.Color("#f6dfb8"), b = new THREE.Color("#e9c79a");
    const uv = fleshG.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) { const v = uv.getY(i); const k = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 9); c.copy(a).lerp(b, 0.25 * k * k); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    fleshG.setAttribute("color", new THREE.BufferAttribute(col, 3)); }
  const flesh = mesh(fleshG, fleshM, "rb-flesh"); flesh.userData.lodColor = "#f2d8b0"; grp.add(flesh);
  // the petals: three peel strips from the peel line, folded down over the body and curling out, tapering to a point;
  // red outside (the peel texture), cream inside
  const at = bananaAt(o, T_PEEL), C0 = at.center, D = at.dir;
  const N0 = new THREE.Vector3(-D.y, D.x, 0), B0 = new THREE.Vector3(0, 0, 1);
  const r0 = at.radius * 1.0;
  // each petal hangs down ON the body (its own radius at that height), lifting off it toward its end and curling out at
  // the tip — a section of the banana's own surface, peeled back
  const rBody = (t: number) => o.radius * catmull1(o.profile, Math.min(1, t));
  const petal = (th0: number, half: number, len: number, flare: number, curl: number, side: 1 | -1) => {
    const NU = 8, NV = 16;
    return gridGeometry(NV + 1, NU, (iv, iu, out) => {
      const v = iv / NV, u = (iu / NU) * 2 - 1;
      // the strip narrows to a rounded point
      const w = half * Math.pow(Math.max(0, 1 - Math.pow(v, 2.4)), 0.55) + 0.01 * (1 - v);
      const t = T_PEEL + (len / o.length) * v, c = bananaAt(o, Math.min(1, t));
      const rr = rBody(t) * 1.03 + 0.003 + flare * Math.pow(v, 2.2) + side * 0.0016 + 0.004 * (1 - u * u);
      const th = th0 + u * w / rr;
      const cl = curl * Math.pow(v, 3);
      const n = this_N.set(-c.dir.y, c.dir.x, 0);
      out.copy(c.center).addScaledVector(c.dir, -cl * 0.4).addScaledVector(n, Math.cos(th) * (rr + cl)).addScaledVector(B0, Math.sin(th) * (rr + cl));
    }, false, [1, 1]);
  };
  const this_N = new THREE.Vector3();
  const peelRot = [0.35, 0.35 + (Math.PI * 2) / 3, 0.35 + (Math.PI * 4) / 3];
  const petalL = [0.15, 0.13, 0.165], petalF = [0.032, 0.042, 0.028], petalC = [0.034, 0.042, 0.028];
  for (let k = 0; k < 3; k++) {
    const half = r0 * (Math.PI / 3) * 0.98;
    const outer = petal(peelRot[k], half, petalL[k], petalF[k], petalC[k], 1), innerG = petal(peelRot[k], half * 0.97, petalL[k] * 0.995, petalF[k], petalC[k], -1);
    // the inner sheet faces inward: flip its winding
    { const ix = innerG.index!.array as Uint16Array | Uint32Array; for (let t = 0; t < ix.length; t += 3) { const q = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = q; } innerG.computeVertexNormals(); }
    const po = mesh(outer, peel, "red-banana"); po.userData.lodColor = "#8e1c33"; grp.add(po);
    const pi = mesh(innerG, inner, "rb-peel-in"); pi.userData.lodColor = "#efe0c0"; grp.add(pi);
  }
  // the flower end: a dark, slightly shrivelled cap
  const tip = bananaAt(o, 1), tipG = filletCyl(tip.radius * 0.95, 0.02, 0.005, 16); tipG.translate(0, 0.006, 0);
  const tipM = mesh(tipG, mat({ color: "#2b1810", roughness: 0.65 }, "rb-tip"), "rb-tip"); tipM.position.copy(tip.center); tipM.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.dir); tipM.userData.lodColor = "#2b1810"; grp.add(tipM);
  // stand it STEM-UP like the golden banana: banana +X (stem → tip) → down, its concave side → left, the chord leaning
  const m = new THREE.Matrix4().makeRotationZ(-0.36).multiply(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1)));
  grp.applyMatrix4(m);
  const wrap = new THREE.Group(); wrap.add(grp);
  wrap.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(wrap);
  wrap.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  root.add(wrap);
  return { root, meshes: [], tris: 0, pivots: {} };
}

/** gear-01 studio only: the coconut (not a game item) */
export function buildCoconut(): Built {
  let hit = cache.get("coconut");
  if (!hit) { hit = coconut(); cache.set("coconut", hit); }
  return { ...hit, root: hit.root.clone(true) as THREE.Group };
}

export function buildHeal(id: ConsumableId): Built {
  let hit = cache.get(id);
  if (!hit) {
    // the banana bomb and the crate wall pack live in ./loot-lane.ts
    hit = id === "smoothie" ? smoothie() : id === "leaf-bundle" ? leafBundle() : id === "red-banana" ? redBanana() : id === "banana-bomb" ? bananaBomb() : id === "smoke-bomb" ? smokeBanana() : id === "vine-grapple" ? vineGrapple() : id === "airstrike" ? airstrikeBeacon() : id === "crate-wall" ? crateWallPack() : goldenBanana();
    hit.root.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      const x = o as THREE.Mesh; x.castShadow = x.castShadow !== false; x.receiveShadow = true;
      // far-LOD bake colour for textured parts (loot.ts / held.ts bake vertex colours; textures are dropped there)
      const lod = LOD_COLOR[x.name];
      if (lod) x.userData.lodColor = lod;
    });
    cache.set(id, hit);
  }
  // return a clone so callers can place it freely (geometry + materials shared)
  const root = hit.root.clone(true) as THREE.Group;
  return { ...hit, root };
}
