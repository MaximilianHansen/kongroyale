// Two loot items' models — origin = bottom centre, +Z front, like the heals (buildHeal routes
// here): the BANANA BOMB (a ripe banana turned frag grenade — iron band, spoon lever, pin ring, a peeled-back skin strip
// for a fuse with a glowing ember on its end) and the COCONUT CRATE WALL pack (the folded barricade you carry: three
// coconut-wood boards strapped with twine, a stencilled coconut). Vertex-coloured PartBuilder parts: shared materials,
// one draw per material kind, bake cleanly into the loot far-LOD.
import * as THREE from "three";
import { PartBuilder, type Built } from "./lib/builder";
import { alignY, bananaAt, bananaEnd, bananaGeometry, filletCyl, rbox, rope, tf } from "./lib/geo";

/** the bomb's banana (stem → tip along +X, curling toward +Y), shared with the in-flight / in-hand copies */
export const BOMB_SHAPE = { length: 0.27, radius: 0.052, bend: 0.95, facets: 5, round: 0.45, along: 40, radial: 30 };

export function bananaBomb(): Built {
  const b = new PartBuilder(), o = BOMB_SHAPE;
  b.addGradient(bananaGeometry(o), "#e9a90a", "#ffe04a", "x", "gloss");
  const st = bananaEnd(o, false), tp = bananaEnd(o, true);
  // dark stem stub + a bruised tip
  b.add(filletCyl(st.radius * 0.95, 0.03, 0.006, 14), "#5b3b19", "matte", alignY(st.center.clone().addScaledVector(st.dir, 0.012), st.dir));
  b.add(new THREE.SphereGeometry(tp.radius * 1.15, 12, 8), "#3c2a12", "matte", tf([tp.center.x, tp.center.y, tp.center.z]));
  // the frag kit: two iron bands, the spoon lever along the side, the pin ring at the stem
  for (const t of [0.34, 0.66]) {
    const s = bananaAt(o, t);
    b.add(new THREE.TorusGeometry(s.radius * 1.0, 0.008, 8, 28).rotateX(Math.PI / 2), "#2a2d31", "metal", alignY(s.center, s.dir));
  }
  {
    const s = bananaAt(o, 0.42), side = new THREE.Vector3(0, 0, 1);
    const pos = s.center.clone().addScaledVector(side, s.radius + 0.006);
    const m = new THREE.Matrix4().makeBasis(s.dir, new THREE.Vector3().crossVectors(side, s.dir).normalize(), side).setPosition(pos);
    b.add(rbox(0.15, 0.024, 0.008, 0.003), "#3b4046", "metal", m);
    const r = bananaAt(o, 0.12), rp = r.center.clone().addScaledVector(side, r.radius + 0.022);
    b.add(new THREE.TorusGeometry(0.017, 0.0035, 6, 18), "#d9dde2", "chrome", new THREE.Matrix4().makeBasis(s.dir, side, new THREE.Vector3().crossVectors(s.dir, side).normalize()).setPosition(rp));
  }
  // the peel fuse: a strip of skin peeled back off the stem end, curling, with the ember on it (its own pivot: flickers)
  const base = st.center.clone().addScaledVector(st.dir, 0.02);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i++) { const u = i / 8; pts.push(base.clone().addScaledVector(st.dir, 0.05 * u).add(new THREE.Vector3(0, 0.035 * Math.sin(u * 2.4), 0.012 * u))); }
  b.add(rope(pts, 0.006, false, 0.03, 6, 24), "#f3e3a2", "matte");
  const tipP = pts[pts.length - 1];
  const em = b.sub("ember", [tipP.x, tipP.y, tipP.z]);
  em.add(new THREE.SphereGeometry(0.011, 10, 8), "#ff7a1a", "emissive", tf([tipP.x, tipP.y, tipP.z]));
  const built = b.build({ name: "banana-bomb" });
  // lying on its side (the curl in the horizontal plane), resting on the floor, centred
  const g = new THREE.Group(); g.name = "banana-bomb"; g.add(built.root);
  built.root.rotation.set(-Math.PI / 2, 0, 0);
  g.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(g);
  built.root.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  return { root: g, meshes: built.meshes, tris: built.tris, pivots: built.pivots };
}

/** SMOKE BANANA: slate-charcoal tactical banana canister with bright cyan warning bands, perforated vent collar,
 * chrome pin ring, and glowing cyan ignition ember */
export function smokeBanana(): Built {
  const b = new PartBuilder(), o = BOMB_SHAPE;
  b.addGradient(bananaGeometry(o), "#303a45", "#566778", "x", "gloss");
  const st = bananaEnd(o, false), tp = bananaEnd(o, true);
  // metallic pressure cap + dark rubberized tip
  b.add(filletCyl(st.radius * 1.05, 0.036, 0.006, 16), "#9aa8b8", "metal", alignY(st.center.clone().addScaledVector(st.dir, 0.015), st.dir));
  b.add(new THREE.SphereGeometry(tp.radius * 1.15, 12, 8), "#222933", "matte", tf([tp.center.x, tp.center.y, tp.center.z]));
  // twin cyan tactical warning stripes + dark iron clamp band
  for (const [t, col, r] of [[0.28, "#38d9f0", 0.007], [0.5, "#1d242c", 0.008], [0.72, "#38d9f0", 0.007]] as const) {
    const s = bananaAt(o, t);
    b.add(new THREE.TorusGeometry(s.radius * 1.0, r, 8, 28).rotateX(Math.PI / 2), col, col === "#38d9f0" ? "gloss" : "metal", alignY(s.center, s.dir));
  }
  // spoon lever + chrome pull ring
  {
    const s = bananaAt(o, 0.42), side = new THREE.Vector3(0, 0, 1);
    const pos = s.center.clone().addScaledVector(side, s.radius + 0.006);
    const m = new THREE.Matrix4().makeBasis(s.dir, new THREE.Vector3().crossVectors(side, s.dir).normalize(), side).setPosition(pos);
    b.add(rbox(0.15, 0.024, 0.008, 0.003), "#6e7d8c", "metal", m);
    const r = bananaAt(o, 0.12), rp = r.center.clone().addScaledVector(side, r.radius + 0.022);
    b.add(new THREE.TorusGeometry(0.017, 0.0035, 6, 18), "#e6edf5", "chrome", new THREE.Matrix4().makeBasis(s.dir, side, new THREE.Vector3().crossVectors(s.dir, side).normalize()).setPosition(rp));
  }
  // vent ports + glowing cyan ignition ember
  const ventBase = st.center.clone().addScaledVector(st.dir, 0.036);
  const em = b.sub("ember", [ventBase.x, ventBase.y, ventBase.z]);
  em.add(new THREE.SphereGeometry(0.014, 10, 8), "#5cf2ff", "emissive", tf([ventBase.x, ventBase.y, ventBase.z]));
  const built = b.build({ name: "smoke-bomb" });
  const g = new THREE.Group(); g.name = "smoke-bomb"; g.add(built.root);
  built.root.rotation.set(-Math.PI / 2, 0, 0);
  g.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(g);
  built.root.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  return { root: g, meshes: built.meshes, tris: built.tris, pivots: built.pivots };
}

/** VINE GRAPPLE: carved bamboo handle, coiled emerald jungle vine spool, and triple curved grappling claw hooks */
export function vineGrapple(): Built {
  const b = new PartBuilder();
  // carved bamboo handle & winch drum
  b.add(filletCyl(0.024, 0.18, 0.006, 14), "#8c6130", "matte", tf([0, 0.09, 0]));
  b.add(filletCyl(0.055, 0.09, 0.008, 20), "#3f7a24", "matte", tf([0, 0.17, 0.02], [Math.PI / 2, 0, 0]));
  // coiled emerald vine loops around the winch drum
  for (let k = 0; k < 4; k++) {
    b.add(new THREE.TorusGeometry(0.058, 0.011, 8, 22), k % 2 === 0 ? "#48b836" : "#6ee045", "gloss", tf([0, 0.17, -0.015 + k * 0.022]));
  }
  // metallic launcher collar + 3 curved bronze grappling claw prongs pointing up-forward
  b.add(filletCyl(0.032, 0.07, 0.006, 16), "#3b424a", "metal", tf([0, 0.23, 0.04], [0.55, 0, 0]));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const pts = [
      new THREE.Vector3(0, 0.25, 0.06),
      new THREE.Vector3(Math.cos(a) * 0.07, 0.31, 0.11 + Math.sin(a) * 0.04),
      new THREE.Vector3(Math.cos(a) * 0.095, 0.27, 0.05 + Math.sin(a) * 0.05),
    ];
    b.add(rope(pts, 0.01, false, 0, 6, 16), "#d9a938", "metal");
  }
  // emerald glowing target crystal on the front
  b.add(new THREE.SphereGeometry(0.018, 10, 8), "#4dff88", "emissive", tf([0, 0.25, 0.075]));
  const built = b.build({ name: "vine-grapple" });
  const g = new THREE.Group(); g.name = "vine-grapple"; g.add(built.root);
  g.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(g);
  built.root.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  return { root: g, meshes: built.meshes, tris: built.tris, pivots: built.pivots };
}

/** BANANA AIRSTRIKE: rugged BANANA CO. red-and-gold tactical laser target designator radio with whip antenna & red laser lens */
export function airstrikeBeacon(): Built {
  const b = new PartBuilder();
  // chunky yellow-and-crimson tactical radio body
  b.add(rbox(0.15, 0.22, 0.09, 0.018), "#d92b24", "gloss", tf([0, 0.11, 0]));
  b.add(rbox(0.158, 0.055, 0.098, 0.012), "#ffd21f", "gloss", tf([0, 0.165, 0]));
  b.add(rbox(0.158, 0.036, 0.098, 0.01), "#282e36", "metal", tf([0, 0.025, 0]));
  // recessed dark screen & glowing red laser optic lens
  b.add(rbox(0.095, 0.058, 0.012, 0.005), "#151a22", "matte", tf([0, 0.105, 0.044]));
  b.add(new THREE.TorusGeometry(0.028, 0.007, 8, 20), "#252b34", "metal", tf([0, 0.165, 0.052]));
  b.add(new THREE.SphereGeometry(0.021, 12, 8), "#ff3326", "emissive", tf([0, 0.165, 0.052]));
  // tall whip antenna + blinking red beacon tip
  b.add(filletCyl(0.006, 0.24, 0.002, 10), "#2c333c", "metal", tf([0.052, 0.31, -0.01]));
  b.add(new THREE.SphereGeometry(0.015, 10, 8), "#ff4530", "emissive", tf([0.052, 0.435, -0.01]));
  // side rubber bumper grips
  for (const sx of [-1, 1]) b.add(rbox(0.018, 0.14, 0.07, 0.006), "#232830", "matte", tf([sx * 0.082, 0.1, 0]));
  const built = b.build({ name: "airstrike" });
  const g = new THREE.Group(); g.name = "airstrike"; g.add(built.root);
  g.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(g);
  built.root.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  return { root: g, meshes: built.meshes, tris: built.tris, pivots: built.pivots };
}

export function crateWallPack(): Built {
  const b = new PartBuilder();
  // three boards stacked (0.62 × 0.05 × 0.2), grain tones, the top one with a stencilled coconut
  const tones = ["#8a5a2e", "#9b6837", "#7d5129"];
  for (let i = 0; i < 3; i++) b.add(rbox(0.62, 0.05, 0.2, 0.012), tones[i], "matte", tf([0, 0.026 + i * 0.054, (i - 1) * 0.012]));
  // cross battens + twine straps
  for (const x of [-0.22, 0.22]) {
    b.add(rbox(0.05, 0.03, 0.24, 0.008), "#5c3a1c", "matte", tf([x, 0.18, 0]));
    const loop: THREE.Vector3[] = [];
    for (let k = 0; k <= 16; k++) { const a = (k / 16) * Math.PI * 2; loop.push(new THREE.Vector3(x + 0.05, 0.1 + Math.sin(a) * 0.1, Math.cos(a) * 0.115)); }
    b.add(rope(loop, 0.007, true, 0.035, 6, 48), "#cfa66a", "rope");
  }
  // the coconut emblem (half coconut, three eyes) on the top board
  b.add(new THREE.SphereGeometry(0.06, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), "#5e3a1c", "matte", tf([0, 0.18, 0], [0, 0, 0], [1, 0.55, 1]));
  for (const [x, z] of [[-0.018, -0.012], [0.018, -0.012], [0, 0.018]] as Array<[number, number]>) b.add(new THREE.SphereGeometry(0.008, 8, 6), "#2a180a", "matte", tf([x, 0.212, z]));
  const built = b.build({ name: "crate-wall-pack" });
  // (carried in one hand: a compact bundle — callers scale the root, so the size lives one level down)
  const g = new THREE.Group(); g.name = "crate-wall-pack"; built.root.scale.setScalar(0.72); g.add(built.root);
  return { root: g, meshes: built.meshes, tris: built.tris, pivots: built.pivots };
}

/** the deployed COCONUT CRATE WALL (shared/sim/cover.ts COVER: 2.4 × 1.3 × 0.4 m, origin = floor centre, the wall runs
 * along X, +Z faces the kong who set it): two rows of three coconut-wood crates — dark frame rails, a diagonal brace, a
 * stencilled coconut — lashed together with twine, a few coconuts heaped on top */
export function crateWall(w = 2.4, h = 1.3, t = 0.4): Built {
  const b = new PartBuilder();
  const cw = w / 3, ch = h / 2 - 0.02, rnd = (i: number) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
  for (let row = 0; row < 2; row++) for (let i = 0; i < 3; i++) {
    const k = row * 3 + i, x = -w / 2 + cw * (i + 0.5) + (row ? (rnd(k) - 0.5) * 0.05 : 0), y = row * (ch + 0.02) + ch / 2, ry = (rnd(k + 7) - 0.5) * 0.06;
    const tone = ["#93602f", "#a06a36", "#87582a", "#9b6532", "#8d5c2d", "#a36d38"][k];
    const M = (lx: number, ly: number, lz: number, rx = 0, rz = 0) => tf([x + lx, y + ly, lz], [rx, ry, rz]);
    b.add(rbox(cw - 0.03, ch - 0.02, t - 0.02, 0.015), tone, "matte", M(0, 0, 0));
    // board seams on both faces
    for (let s = 1; s < 4; s++) for (const fz of [t / 2 - 0.005, -t / 2 + 0.005]) b.add(new THREE.BoxGeometry(cw - 0.06, 0.008, 0.006), "#4a2e14", "matte", M(0, -ch / 2 + (ch * s) / 4, fz));
    // frame rails (top / bottom) + corner posts, darker
    for (const fz of [t / 2 + 0.005, -t / 2 - 0.005]) {
      for (const ly of [ch / 2 - 0.03, -ch / 2 + 0.03]) b.add(rbox(cw - 0.02, 0.06, 0.03, 0.008), "#5a3818", "matte", M(0, ly, fz));
      for (const lx of [cw / 2 - 0.035, -cw / 2 + 0.035]) b.add(rbox(0.06, ch - 0.02, 0.03, 0.008), "#5a3818", "matte", M(lx, 0, fz));
      // the brace
      const L = Math.hypot(cw - 0.12, ch - 0.12), a = Math.atan2(ch - 0.12, cw - 0.12) * ((k & 1) ? 1 : -1);
      b.add(rbox(L, 0.05, 0.025, 0.006), "#62401d", "matte", M(0, 0, fz * 1.02, 0, a));
    }
    // the stencilled coconut on the kong's side (+Z), dark paint
    if ((k + 1) % 2) { b.add(new THREE.CircleGeometry(0.075, 20), "#3a2410", "matte", M(0.0, 0.0, t / 2 + 0.022)); for (const [ex, ey] of [[-0.022, 0.018], [0.022, 0.018], [0, -0.02]] as Array<[number, number]>) b.add(new THREE.CircleGeometry(0.013, 10), "#b98a52", "matte", M(ex, ey, t / 2 + 0.024)); }
  }
  // twine lashings round the stack at both joints
  for (const x of [-w / 6, w / 6]) {
    const loop: THREE.Vector3[] = [];
    for (let k2 = 0; k2 <= 24; k2++) { const a = (k2 / 24) * Math.PI * 2; loop.push(new THREE.Vector3(x, h / 2 + Math.sin(a) * (h / 2 + 0.01), Math.cos(a) * (t / 2 + 0.02))); }
    b.add(rope(loop, 0.012, true, 0.05, 6, 72), "#cfa66a", "rope");
  }
  // coconuts on top
  for (const [x, z, r] of [[-0.75, 0.04, 0.11], [-0.55, -0.06, 0.1], [0.62, 0.02, 0.105]] as Array<[number, number, number]>) b.add(new THREE.SphereGeometry(r, 14, 10), "#5c3a1a", "matte", tf([x, h + r * 0.75, z], [0.3, 0, 0.2], [1, 0.9, 1]));
  return b.build({ name: "crate-wall" });
}

// (economy) the BANANA STAND kiosk lives in ./stand.ts (thatch, leaves, the monkey shopkeeper)

/** (economy) a stack of BANANA BUCKS on the floor: a fat wad of banana-yellow notes with a green band, a few loose notes
 * fanned beside it and a gold coin on top */
export function cashStack(): Built {
  const b = new PartBuilder();
  for (let k = 0; k < 7; k++) b.add(rbox(0.2, 0.012, 0.1, 0.004), k % 2 ? "#f5df6e" : "#ecd25a", "matte", tf([0, 0.006 + k * 0.013, 0], [0, (k % 3 - 1) * 0.04, 0]));
  b.add(rbox(0.04, 0.1, 0.106, 0.005), "#3a9a3c", "matte", tf([0, 0.048, 0]));
  for (const [x, z, r] of [[0.13, 0.06, 0.6], [-0.12, -0.05, -0.5]] as Array<[number, number, number]>) b.add(rbox(0.2, 0.006, 0.1, 0.003), "#f2dc66", "matte", tf([x, 0.004, z], [0, r, 0]));
  b.add(new THREE.CylinderGeometry(0.035, 0.035, 0.01, 20), "#ffcf3a", "metal", tf([0.02, 0.1, 0.01]));
  return b.build({ name: "cash-stack" });
}
