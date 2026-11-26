// Kong outfits (char-01-squad) + the golden banana (char-04-victory). Procedural meshes + canvas-painted
// fabrics, attached to a kong's bones with KongActorEx.attach (they ride the animation; staging / cosmetics only).
//   HATS: straw sun hat (red band), BANANA CO. hard hat, pirate tricorn.   TOPS: open Hawaiian shirt (teal hibiscus),
//   hi-vis BANANA CO. work vest, pirate captain's coat (red, gold trim, anchors).
// Bone-local frames (kong-rig rest): head origin at the base of the skull (skull centre ≈ +0.18 y), chest origin at the
// sternum root (mass centre (0, 0.12, 0.05), shoulders ±0.36 at +0.24), character faces −Z, +X = its right.
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { KongActorEx } from "./kong";
import type { KongOutfit } from "./api";
import { BONES, BONE_LIST, type BoneName } from "./kong-rig";
import { actorLook } from "./look";
import { FACE, KONG_VER, PUBLIC_BASE } from "./kong-asset";

const TAU = Math.PI * 2;
function canvas(w: number, h: number) { const c = document.createElement("canvas"); c.width = w; c.height = h; return [c, c.getContext("2d")!] as const; }
function rng(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function tex(c: HTMLCanvasElement, rep = 1, srgb = true) { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; }
/** grain + stitch rows over a flat fabric fill */
function fabric(g: CanvasRenderingContext2D, W: number, H: number, base: string, r: () => number, weave = 0.05) {
  g.fillStyle = base; g.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 3) { g.fillStyle = `rgba(0,0,0,${weave * (0.5 + r())})`; g.fillRect(0, y, W, 1); }
  for (let x = 0; x < W; x += 3) { g.fillStyle = `rgba(255,255,255,${weave * 0.6 * r()})`; g.fillRect(x, 0, 1, H); }
}

// ------------------------------------------------------------------------------------------------ textures
let T: Record<string, THREE.Texture> | null = null;
function textures() {
  if (T) return T;
  const r = rng(77);
  // Hawaiian print: teal with red / coral hibiscus, green monstera leaves, cream stamens
  const [hc, hg] = canvas(1024, 1024);
  fabric(hg, 1024, 1024, "#1fa8a4", r, 0.04);
  const leaf = (x: number, y: number, s: number, a: number) => {
    hg.save(); hg.translate(x, y); hg.rotate(a); hg.fillStyle = r() < 0.5 ? "#2f8f3a" : "#5fb046";
    hg.beginPath(); hg.moveTo(0, 0); hg.bezierCurveTo(s * 0.5, -s * 0.45, s * 1.1, -s * 0.2, s * 1.3, 0); hg.bezierCurveTo(s * 1.1, s * 0.2, s * 0.5, s * 0.45, 0, 0); hg.fill();
    hg.strokeStyle = "rgba(20,70,30,0.8)"; hg.lineWidth = s * 0.05; hg.beginPath(); hg.moveTo(0, 0); hg.lineTo(s * 1.25, 0); hg.stroke(); hg.restore();
  };
  const flower = (x: number, y: number, s: number) => {
    const col = r() < 0.6 ? ["#e8413a", "#ff7f6e"] : ["#f07a3a", "#ffb07a"];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + r() * 0.3; hg.save(); hg.translate(x, y); hg.rotate(a);
      const gr = hg.createRadialGradient(s * 0.5, 0, 0, s * 0.5, 0, s * 0.6); gr.addColorStop(0, col[1]); gr.addColorStop(1, col[0]);
      hg.fillStyle = gr; hg.beginPath(); hg.ellipse(s * 0.5, 0, s * 0.55, s * 0.36, 0, 0, TAU); hg.fill(); hg.restore();
    }
    hg.fillStyle = "#8b1d1d"; hg.beginPath(); hg.arc(x, y, s * 0.16, 0, TAU); hg.fill();
    hg.strokeStyle = "#ffe9a8"; hg.lineWidth = s * 0.05; hg.beginPath(); hg.moveTo(x, y); hg.lineTo(x + s * 0.5, y - s * 0.45); hg.stroke();
  };
  for (let i = 0; i < 40; i++) leaf(r() * 1024, r() * 1024, 50 + r() * 60, r() * TAU);
  for (let i = 0; i < 26; i++) flower(r() * 1024, r() * 1024, 55 + r() * 45);
  // hi-vis vest: yellow with a grey reflective band + BANANA CO. stencil
  const [vc, vg] = canvas(1024, 512);
  fabric(vg, 1024, 512, "#f2c21a", r, 0.05);
  vg.fillStyle = "#d9d9d0"; vg.fillRect(0, 300, 1024, 46); vg.fillStyle = "rgba(255,255,255,0.35)"; vg.fillRect(0, 306, 1024, 6);
  vg.fillStyle = "#3a2a14"; vg.font = "900 62px Impact, Arial Black, sans-serif"; vg.textAlign = "center";
  vg.fillText("BANANA", 512 - 170, 180); vg.fillText("CO.", 512 - 170, 245);
  // pirate coat: deep red wool, darker seams + gold braid rows are geometry
  const [pc, pg] = canvas(512, 512);
  fabric(pg, 512, 512, "#8e2a1c", r, 0.06);
  for (let i = 0; i < 60; i++) { const x = r() * 512, y = r() * 512, rad = 20 + r() * 70, gr = pg.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, r() < 0.5 ? "rgba(40,5,0,0.18)" : "rgba(200,90,60,0.12)"); gr.addColorStop(1, "rgba(0,0,0,0)"); pg.fillStyle = gr; pg.fillRect(x - rad, y - rad, rad * 2, rad * 2); }
  // woven straw
  const [sc, sg] = canvas(512, 512);
  sg.fillStyle = "#d8b56a"; sg.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 16) for (let x = 0; x < 512; x += 16) {
    const o = ((x + y) / 16) % 2;
    const gr = sg.createLinearGradient(x, y, o ? x + 16 : x, o ? y : y + 16); gr.addColorStop(0, "#b89046"); gr.addColorStop(0.5, "#ecd08a"); gr.addColorStop(1, "#a88238");
    sg.fillStyle = gr; sg.fillRect(x + 1, y + 1, 14, 14);
  }
  // the v2 fitted vest (garment uvs: u = once round the body from the open front, v = hem → collar):
  // the reflective band all round, BANANA CO. on the left chest (char-01) and big across the back
  const [v2c, v2g] = canvas(2048, 512);
  fabric(v2g, 2048, 512, "#f2c21a", r, 0.05);
  v2g.fillStyle = "#d9d9d0"; v2g.fillRect(0, 300, 2048, 44); v2g.fillStyle = "rgba(255,255,255,0.35)"; v2g.fillRect(0, 305, 2048, 6);
  v2g.fillStyle = "#3a2a14"; v2g.textAlign = "center";
  // (the left chest panel runs ~u 0.095 → 0.175 between the open front and the armhole: the print is centred in it)
  v2g.font = "900 44px Impact, Arial Black, sans-serif"; v2g.fillText("BANANA", 281, 156); v2g.fillText("CO.", 281, 204);
  v2g.font = "900 104px Impact, Arial Black, sans-serif"; v2g.fillText("BANANA", 1024, 160); v2g.fillText("CO.", 1024, 262);
  T = { hawaii: tex(hc), vest: tex(vc), vest2: tex(v2c), coat: tex(pc, 2), straw: tex(sc, 3) };
  return T;
}

// ------------------------------------------------------------------------------------------------ geometry helpers
/** lathe from a (radius, y) profile, `seg` around, with optional per-angle radius scale */
function latheG(pts: Array<[number, number]>, seg = 48, sx = 1, sz = 1) {
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  g.scale(sx, 1, sz);
  g.computeVertexNormals();
  return g;
}
/** an open garment shell round the torso: elliptical cylinder (rx, rz) from y0 to y1, opened at the front between
 *  ±open (radians from −Z), with a thickness and rolled hem. Returns the chest-local geometry. */
function shell(o: { y0: number; y1: number; rx: number; rz: number; open: number; cz?: number; flare?: number; top?: number; seg?: number; rows?: number; thick?: number }) {
  const seg = o.seg ?? 40, rows = o.rows ?? 14, th = o.thick ?? 0.015;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const a0 = o.open, a1 = TAU - o.open;
  const P = (a: number, v: number, off: number) => {
    const y = o.y0 + (o.y1 - o.y0) * v;
    // shoulders slope in near the top (the neck opening), hem flares out
    const k = 1 + (o.flare ?? 0) * (1 - v) * (1 - v) - (o.top ?? 0.25) * Math.max(0, v - 0.8) / 0.2;
    const rx = o.rx * k + off, rz = o.rz * k + off;
    return [Math.sin(a) * rx, y, -Math.cos(a) * rz + (o.cz ?? 0)];
  };
  for (const side of [0, 1]) {
    const base = pos.length / 3;
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= seg; i++) {
      const a = a0 + (a1 - a0) * (i / seg), v = j / rows;
      pos.push(...P(a, v, side ? -th : 0)); uv.push((i / seg) * 2.2, v * 1.2);
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < seg; i++) {
      const a = base + j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      if (side) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
/** a sleeve: tapered tube along −Y of a limb bone (length L, radii ra → rb) */
function sleeve(L: number, ra: number, rb: number, seg = 24) {
  const g = new THREE.CylinderGeometry(rb, ra, L, seg, 4, true);
  g.translate(0, -L / 2, 0);
  const g2 = g.clone(); g2.scale(0.94, 1, 0.94); const ix = g2.index!.array as Uint16Array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i]; ix[i] = ix[i + 2]; ix[i + 2] = t; }
  g2.computeVertexNormals();
  return merge([g, g2]);
}
function merge(gs: THREE.BufferGeometry[]) {
  const out = gs.map((g) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (!["position", "normal", "uv"].includes(k)) n.deleteAttribute(k); if (!n.attributes.uv) n.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2)); return n; });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const total = out.reduce((s, g) => s + g.attributes.position.count, 0);
  const P = new Float32Array(total * 3), N = new Float32Array(total * 3), U = new Float32Array(total * 2);
  let o = 0;
  for (const g of out) { P.set(g.attributes.position.array as Float32Array, o * 3); N.set(g.attributes.normal.array as Float32Array, o * 3); U.set(g.attributes.uv.array as Float32Array, o * 2); o += g.attributes.position.count; }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(P, 3)); g.setAttribute("normal", new THREE.BufferAttribute(N, 3)); g.setAttribute("uv", new THREE.BufferAttribute(U, 2));
  return g;
}
const M4 = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));
const mesh = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => { const x = new THREE.Mesh(g, m); x.name = name; x.castShadow = true; x.receiveShadow = true; x.frustumCulled = false; return x; };

// ------------------------------------------------------------------------------------------------ outfits
export type HatId = "straw" | "hardhat" | "tricorn" | "shades" | "bandana" | "crown";
export type TopId = "hawaiian" | "vest" | "coat";
/** head-local placement of a hat (sits on the skull top, tilted back a touch) — per kong asset (kong-asset.ts FACE.hat:
 *  the v1 seat was designed for the 0.86 head and scaled with the bigger mascot head; v2 sits on the Tripo skull) */
export const HAT_AT = M4(0, FACE.hat[0], FACE.hat[1], FACE.hat[2], 0, 0, FACE.hat[3]);

export function makeHat(id: HatId, detail = 1): THREE.Object3D {
  const t = textures(), g = new THREE.Group(); g.name = `hat-${id}`;
  const lathe = (pts: Array<[number, number]>, seg = 48, sx = 1, sz = 1) => latheG(pts, Math.max(10, Math.round(seg * detail)), sx, sz);
  if (id === "straw") {
    const straw = new THREE.MeshStandardMaterial({ map: t.straw, roughness: 0.85, color: "#fff4dc" });
    const brim = lathe([[0.2, 0.0], [0.34, -0.015], [0.43, -0.05], [0.445, -0.065], [0.43, -0.07], [0.33, -0.035], [0.2, -0.02]], 64);
    const crown = lathe([[0.2, -0.01], [0.215, 0.06], [0.21, 0.14], [0.18, 0.2], [0.1, 0.225], [0, 0.23]], 48, 1, 0.95);
    const band = lathe([[0.214, 0.0], [0.219, 0.02], [0.219, 0.07], [0.214, 0.085]], 48, 1.01, 0.96);
    g.add(mesh(brim, straw, "brim"), mesh(crown, straw, "crown"), mesh(band, new THREE.MeshStandardMaterial({ color: "#c8261e", roughness: 0.7 }), "band"));
  } else if (id === "hardhat") {
    const yel = new THREE.MeshPhysicalMaterial({ color: "#f5c010", roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.2 });
    const dome = lathe([[0.235, 0.0], [0.24, 0.06], [0.225, 0.14], [0.18, 0.21], [0.1, 0.25], [0, 0.26]], 56, 1, 1.05);
    const brim = lathe([[0.22, 0.01], [0.3, 0.0], [0.305, -0.012], [0.3, -0.02], [0.22, -0.005]], 56, 1, 1.12);
    const ridge = new THREE.CapsuleGeometry(0.03, 0.34, detail < 1 ? 2 : 6, detail < 1 ? 6 : 12); ridge.rotateX(Math.PI / 2); ridge.scale(1, 0.8, 1); ridge.translate(0, 0.235, 0.0);
    g.add(mesh(dome, yel, "dome"), mesh(brim, yel, "brim"), mesh(ridge, yel, "ridge"));
  } else if (id === "shades") {
    // golden-rimmed tropical shades seated across the brow/eyes (head-local coordinates)
    const gold = new THREE.MeshStandardMaterial({ color: "#f2c43a", metalness: 0.85, roughness: 0.24 });
    const lens = new THREE.MeshStandardMaterial({ color: "#122230", metalness: 0.55, roughness: 0.14 });
    const seg = detail < 1 ? 10 : 20;
    const ey = FACE.eyeMid[1] + 0.015, ez = FACE.eyeMid[2] - 0.115;
    for (const sx of [-1, 1]) {
      const l = new THREE.CylinderGeometry(0.056, 0.052, 0.014, seg);
      l.rotateX(Math.PI / 2); l.scale(1.18, 0.84, 1); l.rotateY(sx * -0.18); l.translate(sx * 0.072, ey, ez);
      g.add(mesh(l, lens, sx < 0 ? "lensL" : "lensR"));
      const rim = new THREE.TorusGeometry(0.056, 0.008, detail < 1 ? 4 : 8, seg);
      rim.scale(1.18, 0.84, 1); rim.rotateY(sx * -0.18); rim.translate(sx * 0.072, ey, ez - 0.002);
      g.add(mesh(rim, gold, sx < 0 ? "rimL" : "rimR"));
      const arm = new THREE.BoxGeometry(0.01, 0.014, 0.22);
      arm.rotateY(sx * 0.12); arm.translate(sx * 0.148, ey + 0.01, ez + 0.12);
      g.add(mesh(arm, gold, sx < 0 ? "armL" : "armR"));
    }
    const bridge = new THREE.BoxGeometry(0.044, 0.012, 0.012); bridge.translate(0, ey + 0.012, ez - 0.008);
    const brow = new THREE.BoxGeometry(0.24, 0.011, 0.011); brow.translate(0, ey + 0.046, ez - 0.005);
    g.add(mesh(bridge, gold, "bridge"), mesh(brow, gold, "brow"));
  } else if (id === "bandana") {
    // crimson jungle headband wrapped around the brow with knotted tails at the back (head-local)
    const red = new THREE.MeshStandardMaterial({ color: "#d62828", roughness: 0.72 });
    const trim = new THREE.MeshStandardMaterial({ color: "#ffd230", roughness: 0.55 });
    const by = FACE.brow.c[1] + 0.025, bz = 0.075;
    const band = lathe([[0.232, -0.036], [0.238, -0.01], [0.238, 0.025], [0.228, 0.042]], 44, 1.0, 1.08);
    band.rotateX(-0.08); band.translate(0, by, bz);
    const stripe = lathe([[0.24, -0.008], [0.242, 0.008]], 44, 1.0, 1.08);
    stripe.rotateX(-0.08); stripe.translate(0, by, bz);
    const knot = new THREE.SphereGeometry(0.036, detail < 1 ? 6 : 12, detail < 1 ? 5 : 8);
    knot.scale(1.15, 0.85, 0.9); knot.translate(0, by + 0.01, bz + 0.255);
    g.add(mesh(band, red, "band"), mesh(stripe, trim, "stripe"), mesh(knot, red, "knot"));
    for (const [sx, rz, len] of [[-1, 0.28, 0.22], [1, -0.34, 0.18]] as const) {
      const tail = new THREE.BoxGeometry(0.045, len, 0.012);
      tail.translate(0, -len * 0.5, 0); tail.rotateX(0.35); tail.rotateZ(rz);
      tail.translate(sx * 0.02, by, bz + 0.26);
      g.add(mesh(tail, red, sx < 0 ? "tailL" : "tailR"));
    }
  } else if (id === "crown") {
    // royal victory crown: gleaming gold 5-point circlet, crimson cap, emerald & ruby gems
    const gold = new THREE.MeshStandardMaterial({ color: "#ffcf2e", metalness: 0.85, roughness: 0.22 });
    const rimM = new THREE.MeshStandardMaterial({ color: "#e59d14", metalness: 0.82, roughness: 0.28 });
    const velvet = new THREE.MeshStandardMaterial({ color: "#8c1622", roughness: 0.85 });
    const ruby = new THREE.MeshStandardMaterial({ color: "#ff3355", roughness: 0.2 });
    const emerald = new THREE.MeshStandardMaterial({ color: "#28d97c", roughness: 0.2 });
    const base = lathe([[0.175, 0.0], [0.185, 0.02], [0.195, 0.085], [0.18, 0.095], [0.165, 0.02]], 40);
    const rim = new THREE.TorusGeometry(0.18, 0.015, detail < 1 ? 4 : 8, Math.max(12, Math.round(40 * detail)));
    rim.rotateX(Math.PI / 2); rim.translate(0, 0.012, 0);
    const cap = lathe([[0.165, 0.04], [0.16, 0.11], [0.11, 0.155], [0, 0.17]], 28);
    g.add(mesh(base, gold, "base"), mesh(rim, rimM, "rim"), mesh(cap, velvet, "cap"));
    const pts = 5;
    for (let k = 0; k < pts; k++) {
      const a = (k / pts) * TAU - Math.PI / 2;
      const sx = Math.cos(a) * 0.188, sz = Math.sin(a) * 0.188;
      const spire = new THREE.ConeGeometry(0.052, 0.13, 4);
      spire.rotateY(-a + Math.PI / 4); spire.translate(sx, 0.14, sz);
      const orb = new THREE.SphereGeometry(0.02, detail < 1 ? 5 : 10, detail < 1 ? 4 : 8);
      orb.translate(sx, 0.21, sz);
      const gem = new THREE.OctahedronGeometry(0.022, 0);
      gem.scale(0.85, 1.15, 0.6); gem.rotateY(-a + Math.PI / 2); gem.translate(Math.cos(a) * 0.198, 0.055, Math.sin(a) * 0.198);
      g.add(mesh(spire, gold, `spire${k}`), mesh(orb, rimM, `orb${k}`), mesh(gem, k % 2 === 0 ? ruby : emerald, `gem${k}`));
    }
  } else {
    const felt = new THREE.MeshStandardMaterial({ color: "#2a211c", roughness: 0.8 });
    const gold = new THREE.MeshStandardMaterial({ color: "#d9a93c", metalness: 0.8, roughness: 0.3 });
    const crown = lathe([[0.2, 0.0], [0.21, 0.08], [0.2, 0.16], [0.15, 0.21], [0, 0.225]], 48);
    // brim folded up into three points (tricorn): a lathe brim whose outer ring lifts with |cos(1.5 a)|
    const brim = lathe([[0.19, 0.0], [0.3, 0.0], [0.4, 0.0], [0.405, 0.012], [0.39, 0.02], [0.19, 0.012]], 72);
    const p = brim.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), rr = Math.hypot(x, z), a = Math.atan2(x, -z);
      const lift = Math.max(0, (rr - 0.21) / 0.19) ** 1.4 * (0.08 + 0.12 * Math.abs(Math.cos(1.5 * a)));
      p.setY(i, p.getY(i) + lift);
      const pull = 1 - 0.18 * Math.abs(Math.sin(1.5 * a)) * Math.max(0, (rr - 0.21) / 0.19);
      p.setX(i, x * pull); p.setZ(i, z * pull);
    }
    brim.computeVertexNormals();
    const trim = new THREE.TorusGeometry(0.33, 0.009, detail < 1 ? 3 : 6, Math.max(12, Math.round(72 * detail))); trim.rotateX(Math.PI / 2); trim.translate(0, 0.11, 0);
    g.add(mesh(crown, felt, "crown"), mesh(brim, felt, "brim"), mesh(trim, gold, "trim"));
  }
  return g;
}

/** garment fit to the Blender kong (lab-tunable through ctx.shared "story".FIT): shell radii at the chest, taper to the
 *  hem (negative flare = narrower at the hem), neck slope, sleeve radius */
export const FIT = { rx: 0.62, rz: 0.47, flare: -0.22, top: 0.3, sleeveR: 0.25, sleeveL: 0.3, y0: -0.3, cz: 0.04 };
export function makeTop(id: TopId): Array<{ o: THREE.Object3D; bone: "chest" | "shoulderR" | "shoulderL" | "spine" | "elbowR" | "elbowL"; at?: THREE.Matrix4 }> {
  const t = textures();
  if (id === "hawaiian") {
    const m = new THREE.MeshStandardMaterial({ map: t.hawaii, roughness: 0.75, side: THREE.DoubleSide });
    const body = shell({ y0: FIT.y0, y1: 0.46, rx: FIT.rx, rz: FIT.rz, open: 0.62, cz: FIT.cz, flare: FIT.flare, top: FIT.top });
    const collar = shell({ y0: 0.38, y1: 0.5, rx: FIT.rx * 0.68, rz: FIT.rz * 0.72, open: 0.5, cz: FIT.cz + 0.02, top: 0 });
    const sl = sleeve(FIT.sleeveL, FIT.sleeveR, FIT.sleeveR * 0.88);
    return [{ o: mesh(merge([body, collar]), m, "shirt"), bone: "chest" }, { o: mesh(sl, m, "sleeveR"), bone: "shoulderR" }, { o: mesh(sl.clone(), m, "sleeveL"), bone: "shoulderL" }];
  }
  if (id === "vest") {
    const m = new THREE.MeshStandardMaterial({ map: t.vest, roughness: 0.7, side: THREE.DoubleSide });
    m.map!.repeat.set(1, 1);
    const body = shell({ y0: FIT.y0 + 0.04, y1: 0.46, rx: FIT.rx, rz: FIT.rz, open: 0.55, cz: FIT.cz, flare: FIT.flare, top: FIT.top + 0.1 });
    return [{ o: mesh(body, m, "vest"), bone: "chest" }];
  }
  const m = new THREE.MeshStandardMaterial({ map: t.coat, roughness: 0.82, side: THREE.DoubleSide });
  const gold = new THREE.MeshStandardMaterial({ color: "#d4a23c", metalness: 0.75, roughness: 0.32 });
  const body = shell({ y0: -0.72, y1: 0.47, rx: FIT.rx + 0.02, rz: FIT.rz + 0.02, open: 0.48, cz: FIT.cz, flare: 0.1, top: FIT.top, rows: 20 });
  const lapel = shell({ y0: 0.05, y1: 0.47, rx: FIT.rx + 0.03, rz: FIT.rz + 0.03, open: 0.46, cz: FIT.cz, top: FIT.top, seg: 6 });
  const trims: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    for (let k = 0; k < 4; k++) { const b = new THREE.SphereGeometry(0.022, 10, 8); const a = s * 0.62, y = 0.2 - k * 0.14; b.translate(Math.sin(a) * (FIT.rx + 0.04), y, -Math.cos(a) * (FIT.rz + 0.04) + FIT.cz); trims.push(b); }
  }
  const hem = new THREE.TorusGeometry(1, 0.012, 6, 64, TAU - 0.96 * 2); hem.rotateX(Math.PI / 2); hem.rotateY(-Math.PI / 2 + 0.96); hem.scale((FIT.rx + 0.02) * 1.1, 1, (FIT.rz + 0.02) * 1.1); hem.translate(0, -0.72, FIT.cz);
  trims.push(hem);
  const sl = sleeve(0.4, FIT.sleeveR, FIT.sleeveR * 0.84), fsl = sleeve(0.3, FIT.sleeveR * 0.84, FIT.sleeveR * 0.88);
  const cuff = new THREE.CylinderGeometry(0.215, 0.215, 0.08, 24, 1, true); cuff.translate(0, -0.3, 0);
  return [
    { o: mesh(merge([body, lapel]), m, "coat"), bone: "chest" }, { o: mesh(merge(trims), gold, "coat-trim"), bone: "chest" },
    { o: mesh(sl, m, "sleeveR"), bone: "shoulderR" }, { o: mesh(sl.clone(), m, "sleeveL"), bone: "shoulderL" },
    { o: mesh(merge([fsl, cuff]), m, "cuffR"), bone: "elbowR" }, { o: mesh(merge([fsl.clone(), cuff.clone()]), m, "cuffL"), bone: "elbowL" },
  ];
}

// ------------------------------------------------------------------------------------------------ Blender garments
// The tops are sculpted in Blender as offset shells of the kong's own body (baked into
// public/assets/actors/kong/outfits.glb + hi-outfit-<kind>-{albedo,normal,ao}.webp), skinned with the kong's weights and
// driven by the kong's bone matrices every draw (a THREE.Skeleton fed from animator.world) — they fit the real
// shoulders + mane and follow every pose. The procedural shells (makeTop) remain the fallback.
const GBASE = PUBLIC_BASE + (KONG_VER === "v2" ? "assets/actors/kong2/" : "assets/actors/kong/");
type Garment = { geo: THREE.BufferGeometry; mat: THREE.Material };
let GARM: Promise<Map<TopId, Garment> | null> | null = null;
/** rest-pose joint positions (model space) — the bind pose of every skinned vertex */
const REST_J = (() => {
  const at = (b: BoneName): THREE.Vector3 => { const d = BONES[b]; const o = new THREE.Vector3(...d.offset); return d.parent ? o.add(at(d.parent)) : o; };
  return BONE_LIST.map((b) => at(b));
})();
/** v2 tops: the canvas pattern on cylindrical uvs, both sides drawn (open cloth) */
export function topMaterial(kind: TopId): THREE.MeshStandardMaterial {
  const t = textures();
  const map = kind === "hawaiian" ? t.hawaii : kind === "vest" ? t.vest2 : t.coat;
  return new THREE.MeshStandardMaterial({ map, roughness: kind === "vest" ? 0.62 : kind === "coat" ? 0.82 : 0.75, metalness: 0, side: THREE.DoubleSide, name: `outfit-${kind}` });
}
function loadGarments(): Promise<Map<TopId, Garment> | null> {
  return (GARM ??= (async () => {
    if (KONG_VER === "v2") {
      try {
        const geos = await loadTopGeos();
        const out = new Map<TopId, Garment>();
        for (const [kind, gg] of geos) {
          const g = gg.hi.clone(), A = g.attributes as Record<string, THREE.BufferAttribute>, n = g.attributes.position.count;
          const si = new Uint16Array(n * 4); for (let i = 0; i < n * 4; i++) si[i] = A.aBones.array[i];
          g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute("skinWeight", A.aWeights);
          out.set(kind, { geo: g, mat: actorLook(topMaterial(kind), { key: `outfit2-${kind}`, spec: 0.45 }) });
        }
        return out.size ? out : null;
      } catch (e) { console.warn("[outfits] v2 garments unavailable, using the procedural shells:", e); return null; }
    }
    try {
      const gltf = await new GLTFLoader().loadAsync(GBASE + "outfits.glb");
      const tl = new THREE.TextureLoader();
      const tx = async (n: string, srgb: boolean) => { const t = await tl.loadAsync(GBASE + n + ".webp"); t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; return t; };
      const out = new Map<TopId, Garment>();
      const meshes: THREE.Mesh[] = [];
      gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      for (const kind of ["hawaiian", "vest", "coat"] as TopId[]) {
        const m = meshes.find((x) => (x.name || x.parent?.name || "").includes(`outfit-${kind}`));
        if (!m) continue;
        const src = m.geometry, A = src.attributes as Record<string, THREE.BufferAttribute>, n = src.attributes.position.count;
        const g = new THREE.BufferGeometry();
        for (const k of ["position", "normal", "tangent", "uv"]) if (src.attributes[k]) g.setAttribute(k, src.attributes[k]);
        if (src.index) g.setIndex(src.index);
        const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          si[i * 4] = Math.round(A._bi01.getX(i)); si[i * 4 + 1] = Math.round(A._bi01.getY(i)); si[i * 4 + 2] = Math.round(A._bi23.getX(i)); si[i * 4 + 3] = Math.round(A._bi23.getY(i));
          sw[i * 4] = A._bw01.getX(i); sw[i * 4 + 1] = A._bw01.getY(i); sw[i * 4 + 2] = A._bw23.getX(i); sw[i * 4 + 3] = A._bw23.getY(i);
        }
        g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
        const key = `hi-outfit-${kind}`;
        const [map, normalMap, aoMap] = await Promise.all([tx(`${key}-albedo`, true), tx(`${key}-normal`, false), tx(`${key}-ao`, false)]);
        const mat = actorLook(new THREE.MeshStandardMaterial({ map, normalMap, aoMap, roughness: kind === "vest" ? 0.62 : 0.82, metalness: 0, name: key }), { key, spec: 0.45 });
        out.set(kind, { geo: g, mat });
      }
      return out.size ? out : null;
    } catch (e) { console.warn("[outfits] Blender garments unavailable, using the procedural shells:", e); return null; }
  })());
}
// ------------------------------------------------------------------------------------------------ match variety
// kong-variety: every kong in a match
// wears a seeded mix of these hats + tops. kong.ts draws them INSTANCED through the same bone texture as the bodies
// (hats rigid on the head bone, tops skinned like the fur under them), hi + lo tiers only.
export const HAT_IDS: HatId[] = ["straw", "hardhat", "tricorn", "shades", "bandana", "crown"];
export const TOP_IDS: TopId[] = ["hawaiian", "vest", "coat"];
export { outfitFor } from "./outfit-pick";
export type Outfit = KongOutfit;

/** rest-pose model-space accessory geometry with the kong skin attributes (aBones / aWeights), per tier [hi, lo] */
export interface AccPiece { tiers: [THREE.BufferGeometry, THREE.BufferGeometry]; mat: THREE.Material }
const HEAD_J = () => REST_J[BONE_LIST.indexOf("head")];
const HEAD_DIRECT = new Set<HatId>(["shades", "bandana"]);
/** a hat as ONE geometry, its sub-meshes' material colours baked into vertex colours (the straw keeps its weave map) */
function hatGeometry(id: HatId, detail: number): THREE.BufferGeometry {
  const g = makeHat(id, detail);
  const M = HEAD_DIRECT.has(id)
    ? new THREE.Matrix4().makeTranslation(HEAD_J())
    : new THREE.Matrix4().makeTranslation(HEAD_J()).multiply(HAT_AT);
  const parts: THREE.BufferGeometry[] = [];
  g.updateMatrixWorld(true);
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    src.applyMatrix4(new THREE.Matrix4().multiplyMatrices(M, m.matrixWorld));
    const n = src.attributes.position.count, c = (m.material as THREE.MeshStandardMaterial).color, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    if (!src.attributes.uv) src.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (!src.attributes.normal) src.computeVertexNormals();
    const o2 = new THREE.BufferGeometry();
    for (const k of ["position", "normal", "uv"]) o2.setAttribute(k, src.attributes[k]);
    o2.setAttribute("color", new THREE.BufferAttribute(col, 3));
    parts.push(o2);
  });
  const total = parts.reduce((a, p) => a + p.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const [k, w] of [["position", 3], ["normal", 3], ["uv", 2], ["color", 3]] as const) {
    const arr = new Float32Array(total * w); let o = 0;
    for (const p of parts) { arr.set(p.attributes[k].array as Float32Array, o); o += p.attributes[k].array.length; }
    out.setAttribute(k, new THREE.BufferAttribute(arr, w));
  }
  const bi = new Float32Array(total * 4), bw = new Float32Array(total * 4), hb = BONE_LIST.indexOf("head");
  for (let i = 0; i < total; i++) { bi[i * 4] = hb; bw[i * 4] = 1; }
  out.setAttribute("aBones", new THREE.BufferAttribute(bi, 4)); out.setAttribute("aWeights", new THREE.BufferAttribute(bw, 4));
  return out;
}
let TOPG: Promise<Map<TopId, { hi: THREE.BufferGeometry; lo: THREE.BufferGeometry }>> | null = null;
/** the v2 fitted tops (hi + lo) from kong2/outfits.glb as kong-skinned geometry (aBones / aWeights) */
function loadTopGeos() {
  return (TOPG ??= (async () => {
    const gltf = await new GLTFLoader().loadAsync(PUBLIC_BASE + "assets/actors/kong2/outfits.glb");
    const byName = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) byName.set(m.name || m.parent?.name || "", m.geometry); });
    const prep = (src: THREE.BufferGeometry) => {
      const g = new THREE.BufferGeometry();
      for (const k of ["position", "normal", "uv"]) if (src.attributes[k]) g.setAttribute(k, src.attributes[k]);
      if (src.index) g.setIndex(src.index);
      const A = src.attributes as Record<string, THREE.BufferAttribute>, n = src.attributes.position.count;
      const bi = new Float32Array(n * 4), bw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        bi[i * 4] = Math.round(A._bi01.getX(i)); bi[i * 4 + 1] = Math.round(A._bi01.getY(i)); bi[i * 4 + 2] = Math.round(A._bi23.getX(i)); bi[i * 4 + 3] = Math.round(A._bi23.getY(i));
        bw[i * 4] = A._bw01.getX(i); bw[i * 4 + 1] = A._bw01.getY(i); bw[i * 4 + 2] = A._bw23.getX(i); bw[i * 4 + 3] = A._bw23.getY(i);
      }
      g.setAttribute("aBones", new THREE.BufferAttribute(bi, 4)); g.setAttribute("aWeights", new THREE.BufferAttribute(bw, 4));
      return g;
    };
    const out = new Map<TopId, { hi: THREE.BufferGeometry; lo: THREE.BufferGeometry }>();
    for (const kind of TOP_IDS) {
      const hi = byName.get(`outfit-${kind}`), lo = byName.get(`lo_outfit-${kind}`);
      if (hi && lo) out.set(kind, { hi: prep(hi), lo: prep(lo) });
    }
    return out;
  })());
}
/** every accessory for the instanced draw: hats (both kong versions), tops (v2's fitted garments; none on v1) */
export async function loadAccessories(): Promise<{ hats: AccPiece[]; tops: AccPiece[] }> {
  const t = textures();
  const hats = HAT_IDS.map((id): AccPiece => ({
    tiers: [hatGeometry(id, 1), hatGeometry(id, 0.3)],
    mat: new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: id === "straw" ? t.straw : null,
      roughness: id === "crown" ? 0.24 : id === "shades" ? 0.2 : id === "hardhat" ? 0.36 : id === "straw" ? 0.85 : 0.72,
      metalness: id === "crown" ? 0.75 : id === "shades" ? 0.45 : 0,
      name: `hat-${id}`,
    }),
  }));
  let tops: AccPiece[] = [];
  if (KONG_VER === "v2") {
    try {
      const geos = await loadTopGeos();
      tops = TOP_IDS.filter((k) => geos.has(k)).map((k) => ({ tiers: [geos.get(k)!.hi, geos.get(k)!.lo], mat: topMaterial(k) }));
      if (tops.length !== TOP_IDS.length) tops = [];
    } catch (e) { console.warn("[outfits] v2 tops unavailable (hats only):", e); tops = []; }
  }
  return { hats, tops };
}

/** a skinned garment riding kong k (world-space skinning; the mesh itself sits at the scene origin) */
function skinnedGarment(k: KongActorEx, gm: Garment): THREE.SkinnedMesh {
  const bones = BONE_LIST.map(() => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; return b; });
  const inv = REST_J.map((j) => new THREE.Matrix4().makeTranslation(-j.x, -j.y, -j.z));
  const skel = new THREE.Skeleton(bones, inv);
  const mesh = new THREE.SkinnedMesh(gm.geo, gm.mat);
  mesh.bindMode = THREE.DetachedBindMode;
  mesh.bind(skel, new THREE.Matrix4());
  mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = "kong-garment";
  mesh.matrixAutoUpdate = false;
  mesh.onBeforeRender = () => { const W = k.animator.world; for (let i = 0; i < bones.length; i++) bones[i].matrixWorld.copy(W[i]); skel.update(); };
  return mesh;
}

/** dress a kong: hat on the head, top (the Blender garment when available) + outfit shorts colour */
export async function dress(k: KongActorEx, o: { hat?: HatId; top?: TopId; shorts?: THREE.ColorRepresentation }): Promise<THREE.Object3D[]> {
  const added: THREE.Object3D[] = [];
  if (o.hat) k.attach(makeHat(o.hat), "head", HAT_AT);
  if (o.top) {
    const G = await loadGarments();
    const gm = G?.get(o.top);
    if (gm) added.push(skinnedGarment(k, gm));
    else for (const p of makeTop(o.top)) k.attach(p.o, p.bone, p.at);
  }
  if (o.shorts) k.setLook({ shorts: o.shorts });
  return added;   // (skinned garments: the caller adds them to the scene root — they skin in world space)
}

// ------------------------------------------------------------------------------------------------ golden banana
/** the victory trophy: a fat curved golden banana ~0.9 m long (x axis = its length, curving up at both ends) */
export function goldenBanana(): THREE.Mesh {
  const n = 40, pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) { const t = i / n, x = (t - 0.5) * 0.92; pts.push(new THREE.Vector3(x, 1.0 * x * x - 0.1, 0)); }
  const curve = new THREE.CatmullRomCurve3(pts);
  const R = (t: number) => 0.105 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 1.02))), 0.55) + 0.012;
  const seg = 5 * 6, geo = new THREE.BufferGeometry(), pos: number[] = [], idx: number[] = [];
  const frames = curve.computeFrenetFrames(n, false);
  for (let i = 0; i <= n; i++) {
    const t = i / n, c = curve.getPointAt(t), N = frames.normals[i], B = frames.binormals[i], r = R(t);
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * TAU, ridge = 1 - 0.07 * Math.pow(Math.abs(Math.cos(a * 2.5)), 6);   // 5 soft ridges
      const p = c.clone().addScaledVector(N, Math.cos(a) * r * ridge).addScaledVector(B, Math.sin(a) * r * ridge);
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < seg; j++) { const a = i * (seg + 1) + j, b = a + seg + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  // stem nub
  const stem = new THREE.CylinderGeometry(0.018, 0.026, 0.09, 10); stem.rotateZ(Math.PI / 2 + 0.5); stem.translate(0.5, 0.1, 0);
  const g = merge([geo, stem]);
  // not a flat plank: a deeper curve, fatter, less self-glow so the round
  // body shades (a bright rim + a darker belly) instead of a flat emissive band
  const m = new THREE.MeshPhysicalMaterial({ color: "#ffc93a", metalness: 1, roughness: 0.24, clearcoat: 0.8, clearcoatRoughness: 0.06, emissive: "#ff9d00", emissiveIntensity: 0.22 });
  const me = new THREE.Mesh(g, m); me.name = "golden-banana"; me.castShadow = true;
  return me;
}

/** falling golden confetti: instanced curled paper squares scattered through a box around `centre` */
export function confetti(centre: THREE.Vector3, size: THREE.Vector3, n = 420, seed = 9): THREE.InstancedMesh {
  const g = new THREE.PlaneGeometry(1, 0.6, 2, 1);
  const p = g.attributes.position as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) p.setZ(i, 0.12 * Math.pow(p.getX(i) * 2, 2));
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ color: "#ffd03a", metalness: 0.9, roughness: 0.22, side: THREE.DoubleSide, emissive: "#b37a00", emissiveIntensity: 0.6 });
  const im = new THREE.InstancedMesh(g, m, n); im.name = "confetti";
  const r = rng(seed), M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const tints = ["#ffd03a", "#ffe07a", "#f2b21e", "#fff0b0"];
  for (let i = 0; i < n; i++) {
    v.set(centre.x + (r() - 0.5) * size.x, centre.y + (r() - 0.5) * size.y, centre.z + (r() - 0.5) * size.z);
    q.setFromEuler(e.set(r() * TAU, r() * TAU, r() * TAU)); const k = 0.05 + r() * r() * 0.16; s.set(k, k, k);
    im.setMatrixAt(i, M.compose(v, q, s)); im.setColorAt(i, new THREE.Color(tints[i % tints.length]));
  }
  im.frustumCulled = false;
  return im;
}

// ------------------------------------------------------------------------------------------------ summit rock (char-04)
/** a chunky basalt summit rock, its (roughly flat) TOP at local y = 0, `h` tall below; dark faceted stone with warm
 *  edge wear and glowing lava seams near the base (char-04: the kong stands on a black lava rock) */
export function basaltRock(w: number, h: number, d: number, seed = 1): THREE.Mesh {
  const r = rng(seed);
  // indexed (merged) so the normals are smooth — the non-indexed icosahedron shaded as flat facets
  const g0 = new THREE.IcosahedronGeometry(1, 6); g0.deleteAttribute("uv"); g0.deleteAttribute("normal");
  const g = mergeVertices(g0); g0.dispose();
  const p = g.attributes.position as THREE.BufferAttribute, col = new Float32Array(p.count * 3);
  // low-frequency lumps (a few big planar-ish facets) + a flattened top
  const planes = Array.from({ length: 9 }, () => { const n = new THREE.Vector3(r() - 0.5, (r() - 0.5) * 0.6, r() - 0.5).normalize(); return { n, d: 0.78 + r() * 0.16 }; });
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    for (const pl of planes) { const k = v.dot(pl.n); if (k > pl.d) v.addScaledVector(pl.n, (pl.d - k) * 0.85); }
    if (v.y > 0.62) v.y = 0.62 + (v.y - 0.62) * 0.12;                          // the flat standing top
    const n = Math.sin(v.x * 7.1 + seed) * Math.sin(v.z * 6.3) * 0.025 + Math.sin(v.y * 11 + v.x * 3) * 0.015
      + Math.sin(v.x * 23 + v.y * 17) * Math.sin(v.z * 19 - v.y * 7) * 0.008 + Math.sin(v.x * 41 + v.z * 37 + v.y * 29) * 0.004;
    v.multiplyScalar(1 + n);
    p.setXYZ(i, v.x * w * 0.5, (v.y - 0.64) * h * 0.6, v.z * d * 0.5);
    // colour: basalt with warm-lit worn tops, near-black crevices, lava glow low down (in the emissive via colour > 1)
    const top = Math.max(0, v.y - 0.3), low = Math.max(0, -0.1 - v.y);
    const base = 0.13 + 0.08 * (0.5 + 0.5 * Math.sin(v.x * 13 + v.z * 9)) + 0.04 * Math.sin(v.x * 37 + v.z * 31) + top * 0.2;
    // warm dark volcanic rock (target art: brown-black basalt, sun-warmed tops) — not a grey plaster lump
    col[i * 3] = base * 1.35; col[i * 3 + 1] = base * 1.0; col[i * 3 + 2] = base * 0.78;
    if (low > 0.2 && Math.sin(v.x * 17 + v.z * 23 + v.y * 5) > 0.82) { col[i * 3] = 2.6; col[i * 3 + 1] = 0.7; col[i * 3 + 2] = 0.1; }
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
  m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += max( vColor.rgb - 1.0, 0.0 ) * 1.6;"); };
  m.customProgramCacheKey = () => "basalt-lava";
  const me = new THREE.Mesh(g, m); me.name = "summit-rock"; me.castShadow = true; me.receiveShadow = true;
  return me;
}
/** additive sun-burst sprite (rays + halo) behind the trophy */
export function sunBurst(size: number): THREE.Sprite {
  const [c, g] = canvas(512, 512);
  const gr = g.createRadialGradient(256, 256, 0, 256, 256, 256);
  gr.addColorStop(0, "rgba(255,244,200,1)"); gr.addColorStop(0.12, "rgba(255,214,110,0.85)"); gr.addColorStop(0.4, "rgba(255,170,60,0.25)"); gr.addColorStop(1, "rgba(255,150,40,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
  g.globalCompositeOperation = "lighter";
  const r = rng(5);
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * TAU + r() * 0.1, L = 150 + r() * 100, w = 0.02 + r() * 0.03;
    const rg = g.createLinearGradient(256, 256, 256 + Math.cos(a) * L, 256 + Math.sin(a) * L);
    rg.addColorStop(0, "rgba(255,230,150,0.5)"); rg.addColorStop(1, "rgba(255,200,90,0)");
    g.fillStyle = rg; g.beginPath(); g.moveTo(256, 256); g.lineTo(256 + Math.cos(a - w) * L, 256 + Math.sin(a - w) * L); g.lineTo(256 + Math.cos(a + w) * L, 256 + Math.sin(a + w) * L); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: new THREE.Color(1.6, 1.3, 0.9) }));
  s.scale.setScalar(size); s.name = "sun-burst";
  return s;
}
