// interiors — the client side of the room-furnishing kit. POI areas call ONE function:
//
//   import { buildInteriors } from "../_kit/interior";
//   await buildInteriors(ctx, rooms, { parent: poiRoot, name: "mm-shop-3" });    // rooms: shared/pois/interior-kit InteriorRoom[]
//
// and add `interiorColliders(rooms)` (shared/pois/interior-kit.ts) to the POI's server colliders — the SAME layout, so
// what you see is what you collide with. Per call: every room's furniture + architectural finish (floor, wall paint,
// dado, baseboards, cornice, ceiling / beams / drop ceiling, door + window casings, sills, glass, curtains, stone
// surrounds) + the LIT SHELL (see RoomFinish.shell) are merged into ~20 draw calls, hidden beyond `maxDist`.
// Light: no PointLights. Every fixture (pendant, lamp, lantern, brazier, stove, fireplace, neon, light panel …)
// is baked per vertex into the room it hangs in (n·l, soft range) — so walls, floor and furniture take the warm pool
// with their own albedo — plus crease / contact occlusion and (showcase, or while atmos' interior volume is off) the
// room's sky visibility through its openings, which scale the ambient. Soft contact shadows are multiplied under every
// floor piece; fire is animated flame cards.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import { furnishRoom, FINISH, FLAT, itemRect, type InteriorLayout, type InteriorRoom, type RoomFinish, type Side } from "../../../../../shared/pois/interior-kit";
import { IBuilder, tessPlaneGeo, type AoFn, type MatKey } from "./interior-geo";
import { drawItem, type DrawCtx, WOOD } from "./interior-draw";
import { artTex, blockTex, ceilTex, contactTex, detailTex, fabricTex, flameTex, floorTex, FLOOR_TILE_M, glowTex, goodsTex, hazardTex, leafTex, metalTex, neonTex, paintTex, plasterTex, rugTex, screenTex, signTex, stoneTex, washTex, windowLightTex, woodTex, rngOf, type FloorKind } from "./interior-tex";

export interface InteriorBuildOpts {
  /** parent object (default ctx.scene). The group is positioned at the first room's origin. */
  parent?: THREE.Object3D;
  name?: string;
  /** hide everything beyond this camera distance (m, default 150); the light pools beyond 70 m */
  maxDist?: number;
  /** draw the architectural finish (default true; per-room `finish` flags still apply) */
  finish?: boolean;
  /** pre-furnished layouts, one per room (a POI that post-processes the kit's layout, e.g. wreck-bay snapping
   *  furniture to a curved hull); default: furnishRoom(room) */
  layouts?: InteriorLayout[];
  /** furniture casts sun shadows (default true) */
  shadows?: boolean;
  /** bake the rooms' sky visibility (fill light only through the windows / doors) into the vertices. "auto" (default):
   *  applied only while atmos' interior volume is off (it derives the same term from the POI's collision walls);
   *  "force": always (the int-* showcase, whose shells are not in the shared collider set); "off" */
  bakeSky?: "auto" | "force" | "off";
}
export interface InteriorBuild { group: THREE.Group; layouts: InteriorLayout[]; tris: number; draws: number }

// ------------------------------------------------------------------------------------------------ materials
let MATS: Map<MatKey, THREE.Material> | null = null;
/** seconds, shared by every fire material (advanced by any build's update hook) */
const FIRE_T = { value: 0 };
function mats(): Map<MatKey, THREE.Material> {
  if (MATS) return MATS;
  // lighting value structure: the fill / ambient a kit surface receives is scaled per vertex by `kao`
  // — x = local occlusion (floor–wall / wall–wall / wall–ceiling creases, contact under floor pieces), y = the room's sky
  // visibility through its openings (negative = forced; positive = only while atmos' interior volume is off). A small
  // albedo-proportional "bounce" keeps a room readable, scaled the same way, so deep corners go dark and lamp / window
  // pools read against them.
  const FILL = 0.06;
  const DETAIL_S = 0.5;
  const std = (name: string, map: THREE.Texture | null, rough: number, metal = 0, extra: Partial<THREE.MeshStandardMaterialParameters> = {}, detail = 0, detailScale = 4) => {
    const m = new THREE.MeshStandardMaterial({ name: `int-${name}`, map, roughness: rough, metalness: metal, vertexColors: true, ...extra });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute vec2 kao;\nattribute vec3 klamp;\nvarying vec2 vKao;\nvarying vec3 vKLamp;").replace("#include <begin_vertex>", "#include <begin_vertex>\n  vKao = kao; vKLamp = klamp;");
      let fs = sh.fragmentShader.replace("#include <common>", `#include <common>\nvarying vec2 vKao;\nvarying vec3 vKLamp;${detail ? "\nuniform sampler2D uKDetail;" : ""}`);
      if (detail && map) {
        sh.uniforms.uKDetail = { value: detailTex() };
        fs = fs.replace("#include <map_fragment>", `#include <map_fragment>\n  diffuseColor.rgb *= mix( 1.0, texture2D( uKDetail, vMapUv * ${detailScale.toFixed(2)} ).g * 2.0, ${detail.toFixed(2)} );`);
      }
      fs = fs.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
  float kSky = abs( vKao.y );
#ifdef ATMOS_SSAO
  if ( vKao.y > 0.0 && uAtmGIParams.x > 0.5 && uAtmGIParams.z > 0.0 ) kSky = 1.0;   // atmos' interior volume has it
#endif
  float kI = clamp( vKao.x, 0.0, 1.0 ) * clamp( kSky, 0.0, 1.0 );
  totalEmissiveRadiance += diffuseColor.rgb * ${FILL.toFixed(3)} * kI;`);
      // the room's lamps / fires / light panels: irradiance baked per vertex (room frame, n·l, soft range) → diffuse light
      fs = fs.replace("#include <aomap_fragment>", "#include <aomap_fragment>\n  reflectedLight.indirectDiffuse *= kI;\n  reflectedLight.indirectSpecular *= kI;\n  reflectedLight.directDiffuse += diffuseColor.rgb * vKLamp;");
      sh.fragmentShader = fs;
    };
    m.customProgramCacheKey = () => `int-k3-${FILL}-${detail}-${detailScale}-${DETAIL_S}`;
    return m;
  };
  const m = new Map<MatKey, THREE.Material>();
  m.set("wood", std("wood", woodTex(), 0.6));
  m.set("paint", std("paint", paintTex(), 0.5));
  m.set("fabric", std("fabric", fabricTex(), 0.95));
  m.set("cloth", std("curtain-cloth", fabricTex(), 0.95));   // soft (curtains, banners, hammock cloth): named for parity
  m.set("metal", std("metal", metalTex(), 0.42, 0.35));
  m.set("stone", std("stone", stoneTex(), 0.9, 0, {}, 0.35, 3));
  m.set("leaf", std("leaf", leafTex(), 0.7));
  m.set("goods", std("goods", goodsTex(), 0.55));
  m.set("art", std("art", artTex(), 0.75));
  m.set("rug", std("rug", rugTex(), 0.95));
  m.set("sign", std("sign", signTex(), 0.6));
  m.set("hazard", std("hazard", hazardTex(), 0.8));
  m.set("plaster", std("plaster", plasterTex(), 0.9, 0, {}, 0.18, 6));
  m.set("wl-block", std("wl-block", blockTex(), 0.88, 0, {}, 0.45, 5));
  m.set("ceil", std("ceil", ceilTex(), 0.92));
  for (const k of ["planks", "boards", "tiles", "checker", "concrete", "stone", "deck"] as FloorKind[]) m.set(`fl-${k}` as MatKey, std(`fl-${k}`, floorTex(k), k === "tiles" || k === "checker" ? 0.35 : k === "concrete" ? 0.85 : 0.62, 0, {}, k === "stone" || k === "concrete" ? 0.4 : 0.12, k === "stone" || k === "concrete" ? 5 : 3));
  m.set("glow", new THREE.MeshBasicMaterial({ name: "int-glow", vertexColors: true }));
  m.set("screen", new THREE.MeshBasicMaterial({ name: "int-screen", map: screenTex(), vertexColors: true }));
  m.set("glass", new THREE.MeshStandardMaterial({ name: "int-glass", vertexColors: true, color: 0xffffff, transparent: true, opacity: 0.3, roughness: 0.04, metalness: 0.1, depthWrite: false }));
  // fake light: dst · (1 + light) — the pool brightens the surface it falls on in proportion to what is already there
  // (planks stay planks, a dark floor gets a warm pool, nothing washes to a flat beige the way an additive glow did)
  const fx = (name: string, map: THREE.Texture) => new THREE.MeshBasicMaterial({ name, map, vertexColors: true, transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false });
  m.set("fx", fx("int-fx", glowTex()));
  m.set("fxwin", fx("int-fxwin", windowLightTex()));
  m.set("fxwash", fx("int-fxwash", washTex()));
  m.set("neon", new THREE.MeshBasicMaterial({ name: "int-neon", map: neonTex(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  // contact shadows: multiplied onto whatever floor is under them (a ShaderMaterial: atmos leaves it alone — no fog)
  m.set("shadow", new THREE.ShaderMaterial({
    name: "int-contact", transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    uniforms: { uMap: { value: contactTex() } },
    vertexShader: "attribute vec3 color; varying vec2 vUv; varying float vK; void main() { vUv = uv; vK = color.r; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }",
    fragmentShader: "uniform sampler2D uMap; varying vec2 vUv; varying float vK; void main() { float s = texture2D( uMap, vUv ).r; gl_FragColor = vec4( vec3( mix( 1.0, s, vK ) ), 1.0 ); }",
  }));
  // animated fire: crossed flame cards, a scrolled noise distorts a teardrop mask (colour.r = intensity, .b = phase)
  m.set("fire", new THREE.ShaderMaterial({
    name: "int-fire", transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uMap: { value: flameTex() }, uT: FIRE_T },
    vertexShader: "attribute vec3 color; varying vec2 vUv; varying vec3 vC; void main() { vUv = uv; vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }",
    fragmentShader: `uniform sampler2D uMap; uniform float uT; varying vec2 vUv; varying vec3 vC;
void main() {
  float ph = vC.b * 17.0;
  float n1 = texture2D( uMap, vec2( vUv.x * 0.9 + ph, vUv.y * 0.8 - uT * 1.25 ) ).g;
  float n2 = texture2D( uMap, vec2( vUv.x * 1.8 - ph * 0.7, vUv.y * 1.7 - uT * 2.3 ) ).g;
  vec2 d = vUv + vec2( ( n1 - 0.5 ) * 0.28 * vUv.y, ( n2 - 0.5 ) * 0.14 - 0.04 );
  float m = texture2D( uMap, clamp( d, vec2( 0.002 ), vec2( 0.998 ) ) ).r;
  float f = smoothstep( 0.06, 0.95, m * ( 0.55 + 0.9 * n2 ) );
  vec3 c = mix( vec3( 1.0, 0.22, 0.03 ), vec3( 1.0, 0.62, 0.16 ), smoothstep( 0.15, 0.55, f ) );
  c = mix( c, vec3( 1.0, 0.93, 0.7 ), smoothstep( 0.6, 0.95, f ) );
  gl_FragColor = vec4( c * f * vC.r * 3.2, 1.0 );
}`,
  }));
  MATS = m;
  return m;
}
const FURNITURE: ReadonlySet<MatKey> = new Set(["wood", "paint", "fabric", "cloth", "metal", "stone", "leaf", "goods"]);
const UNLIT_FX: ReadonlySet<MatKey> = new Set(["glow", "fx", "fxwin", "fxwash", "neon", "shadow", "fire", "screen"]);

// ------------------------------------------------------------------------------------------------ helpers
const HALF_PI = Math.PI / 2;
function sideYaw(s: Side): number { return s === 0 ? Math.PI : s === 1 ? -HALF_PI : s === 2 ? 0 : HALF_PI; }
function wallPoint(room: { w: number; d: number }, s: Side, along: number, off: number): [number, number] {
  switch (s) { case 0: return [along, room.d / 2 - off]; case 1: return [room.w / 2 - off, along]; case 2: return [along, -room.d / 2 + off]; default: return [-room.w / 2 + off, along]; }
}
/** wall-frame matrix: origin on side s at `along`, offset `off` into the room; local +x along the wall (as sideYaw), +z into the room */
function wallM(room: InteriorRoom, s: Side, along: number, off: number, y: number): THREE.Matrix4 {
  const [x, z] = wallPoint(room, s, along, off);
  return new THREE.Matrix4().makeRotationY(sideYaw(s)).setPosition(x, y, z);
}
/** along-wall coordinate → wall-frame local x (the frame's +x runs opposite to `along` on sides 0 and 3) */
const alongSign = (s: Side) => (s === 0 || s === 3 ? -1 : 1);

/** solid intervals of a wall between the doors (for baseboards) and per height band (for paint) */
function intervals(L: number, cuts: Array<[number, number]>): Array<[number, number]> {
  const cs = cuts.map(([a, b]) => [Math.max(-L / 2, a), Math.min(L / 2, b)] as [number, number]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out: Array<[number, number]> = [];
  let x = -L / 2;
  for (const [a, b] of cs) { if (a > x + 0.01) out.push([x, a]); x = Math.max(x, b); }
  if (L / 2 > x + 0.01) out.push([x, L / 2]);
  return out;
}

// ------------------------------------------------------------------------------------------------ lit shell
/** the finish actually drawn: the POI's finish + the kit's LIT SHELL (see RoomFinish.shell) */
export function drawnFinish(room: InteriorRoom, f: RoomFinish): RoomFinish & { liner: boolean; skinOff: number } {
  const out = { ...f, liner: false, skinOff: 0 };
  if (f.shell === false || room.openTop) return out;
  const st = room.style;
  if (f.ceiling === "none" && (st === "shop" || st === "lab" || st === "house" || st === "hut")) {
    out.ceiling = st === "shop" || st === "lab" ? "grid" : st === "hut" ? "planks" : "plaster";
    out.liner = true;
  }
  if (f.wall === null && (st === "shop" || st === "lab")) {
    out.wall = FINISH[st].wall; out.dado = f.dado ?? FINISH[st].dado; out.baseboard = true;
    out.skinOff = 0.035;   // the POI's own wall skin may stand proud of the nominal inner face (Mango: ~2 cm)
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ occlusion
type Light = DrawCtx["lights"][number];
/** per-vertex occlusion of one room (room frame): creases (floor–wall, wall–wall, wall–ceiling), a broad contact term
 *  around floor pieces, and the sky visibility through the room's openings */
const LAMP_K = 2.1;
function roomAo(room: InteriorRoom, L: InteriorLayout, lights: Light[]): AoFn {
  const W = room.w, D = room.d, H = room.h, top = !room.openTop, dark = !!room.dark;
  const feet: Array<[number, number, number, number, number]> = [];
  for (const it of L.items) if (it.y < 0.05 && !FLAT.has(it.kind) && it.col && it.h > 0.3) { const r = itemRect(it); feet.push([r.x0, r.z0, r.x1, r.z1, Math.min(1, it.h / 1.2)]); }
  const ops = room.openings.map((o) => {
    const y0 = o.y0 ?? (o.kind === "window" ? 1.0 : 0), h = o.h ?? (o.kind === "window" ? 1.3 : 2.3);
    const [cx, cz] = o.side === 0 ? [o.at, D / 2] : o.side === 1 ? [W / 2, o.at] : o.side === 2 ? [o.at, -D / 2] : [-W / 2, o.at];
    const [nx, nz] = o.side === 0 ? [0, -1] : o.side === 1 ? [-1, 0] : o.side === 2 ? [0, 1] : [1, 0];
    return { cx, cy: y0 + h / 2, cz, nx, nz, area: o.w * h * (o.kind === "window" ? 1 : 0.8) };
  });
  const AMB = dark ? 0.1 : 0.14;
  const lamps = lights.map((l) => ({ x: l.x, y: l.y, z: l.z, R: Math.max(1.2, l.r * 1.6), r0: Math.max(0.6, l.r * 0.42), k: LAMP_K, cr: l.c.r, cg: l.c.g, cb: l.c.b }));
  const ex = (t: number, k: number) => (t >= k * 6 ? 0 : Math.exp(-(t > 0 ? t : 0) / k));
  return (x, y, z, nx, ny, nz, out) => {
    // lamps: n·l (softly wrapped), inverse-square with a core radius, a smooth range cut
    let er = 0, eg = 0, eb = 0;
    for (let i = 0; i < lamps.length; i++) {
      const l = lamps[i], lx = l.x - x, ly = l.y - y, lz = l.z - z, d2 = lx * lx + ly * ly + lz * lz, R2 = l.R * l.R;
      if (d2 > R2) continue;
      const d = Math.sqrt(d2) + 1e-4, nl = (lx * nx + ly * ny + lz * nz) / d;
      if (nl <= -0.25) continue;
      const q = 1 - d2 / R2, e = (l.k * ((nl + 0.25) / 1.25) * q * q) / (1 + d2 / (l.r0 * l.r0));
      er += l.cr * e; eg += l.cg * e; eb += l.cb * e;
    }
    out[2] = er; out[3] = eg; out[4] = eb;
    const dx = W / 2 - Math.abs(x), dz = D / 2 - Math.abs(z);
    const Ex = ex(dx, 0.42), Ez = ex(dz, 0.42), ew = Ex > Ez ? Ex : Ez;
    let occ = 0.32 * Ex * Ez;
    if (ew > 0) { occ += 0.5 * ex(y, 0.38) * ew; if (top) occ += 0.38 * ex(H - y, 0.5) * ew; }
    if (y < 0.4 && feet.length) {
      let c = 0;
      for (const f of feet) {
        const ddx = Math.max(f[0] - x, 0, x - f[2]), ddz = Math.max(f[1] - z, 0, z - f[3]);
        if (ddx > 0.9 || ddz > 0.9) continue;
        const v = f[4] * Math.exp(-Math.sqrt(ddx * ddx + ddz * ddz) / 0.3);
        if (v > c) c = v;
      }
      if (c > 0) occ += 0.4 * c * ex(y, 0.25);
    }
    out[0] = Math.max(0.2, 1 - occ) * (dark ? 0.8 : 1);
    // sky: Σ area · cosθ(surface) · cosθ(opening) / (π d² + area)
    let vis = 0;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i], vx = o.cx - x, vy = o.cy - y, vz = o.cz - z, d2 = vx * vx + vy * vy + vz * vz + 1e-4;
      const dd = vx * nx + vy * ny + vz * nz, dn = -(vx * o.nx + vz * o.nz);
      if (dd <= 0 || dn <= 0) continue;
      vis += (o.area * dd * dn) / (d2 * (Math.PI * d2 + o.area));
    }
    out[1] = AMB + (1 - AMB) * Math.min(1, vis * 2.2);
  };
}

/** the drop ceiling's light panels (room frame) — drawn by drawFinish, lit into the vertices before */
function gridPanels(room: InteriorRoom): Array<{ x: number; z: number; vent: boolean }> {
  const W = room.w, D = room.d, out: Array<{ x: number; z: number; vent: boolean }> = [];
  const nx = Math.max(1, Math.round(W / 2.4)), nz = Math.max(1, Math.round(D / 2.4));
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = -W / 2 + (i + 0.5) * W / nx, z = -D / 2 + (j + 0.5) * D / nz;
    out.push({ x: Math.round(x / 0.6) * 0.6, z: Math.round(z / 0.6) * 0.6 + 0.3, vent: (i + j) % 3 === 2 });
  }
  return out;
}
const panelLight = (room: InteriorRoom, p: { x: number; z: number }): Light => ({ x: p.x, y: room.h - 0.1, z: p.z, r: 1.9, c: new THREE.Color(0.95, 0.93, 0.85), floor: true });

// ------------------------------------------------------------------------------------------------ finish
/** the ceiling of a W × D room (centred) minus its holes, as rectangles [cx, cz, w, d]: a grid on every hole
 * edge, cells outside every hole merged along x per row */
function ceilPieces(W: number, D: number, holes?: Array<[number, number, number, number]>): Array<[number, number, number, number]> {
  if (!holes?.length) return [[0, 0, W, D]];
  const xs = [-W / 2, W / 2], zs = [-D / 2, D / 2];
  for (const [x0, z0, x1, z1] of holes) { for (const x of [x0, x1]) if (x > -W / 2 && x < W / 2) xs.push(x); for (const z of [z0, z1]) if (z > -D / 2 && z < D / 2) zs.push(z); }
  xs.sort((a, b) => a - b); zs.sort((a, b) => a - b);
  const out: Array<[number, number, number, number]> = [];
  for (let j = 0; j < zs.length - 1; j++) {
    const za = zs[j], zb = zs[j + 1]; if (zb - za < 1e-3) continue;
    let run = -1;
    for (let i = 0; i <= xs.length - 1; i++) {
      const open = i < xs.length - 1 && xs[i + 1] - xs[i] > 1e-3 && !inHole(holes, (xs[i] + xs[i + 1]) / 2, (za + zb) / 2, 0);
      if (open && run < 0) run = i;
      if (!open && run >= 0) { const xa = xs[run], xb = xs[i]; out.push([(xa + xb) / 2, (za + zb) / 2, xb - xa, zb - za]); run = -1; }
    }
  }
  return out;
}
function inHole(holes: Array<[number, number, number, number]> | undefined, x: number, z: number, m: number): boolean {
  return !!holes?.some(([x0, z0, x1, z1]) => x > x0 - m && x < x1 + m && z > z0 - m && z < z1 + m);
}
/** a beam's span [a0, a1] (along x when alongX, else along z) at cross position p, minus the holes it crosses */
function cutSpan(a0: number, a1: number, holes: Array<[number, number, number, number]> | undefined, alongX: boolean, p: number): Array<[number, number]> {
  let segs: Array<[number, number]> = [[a0, a1]];
  for (const [x0, z0, x1, z1] of holes ?? []) {
    const [h0, h1, c0, c1] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
    if (p < c0 - 0.1 || p > c1 + 0.1) continue;
    segs = segs.flatMap(([s0, s1]) => (h1 <= s0 || h0 >= s1 ? [[s0, s1]] : [[s0, h0], [h1, s1]]).filter(([u, v]) => v - u > 0.2) as Array<[number, number]>);
  }
  return segs;
}

function drawFinish(B: IBuilder, room: InteriorRoom, f: RoomFinish & { liner?: boolean; skinOff?: number }, fxLights: Light[]) {
  const W = room.w, D = room.d, H = room.h, t = room.wallT ?? 0.25, so = f.skinOff ?? 0;
  const roomBase = B.base.clone();
  // floor (tessellated: the per-vertex occlusion needs vertices across it)
  if (f.floor !== "none") {
    const tile = FLOOR_TILE_M[f.floor as FloorKind] ?? 2;
    B.base.copy(roomBase);
    // (laid around floorHoles: one plane over the whole room would cover the stair well and hide the flight below)
    for (const [cx, cz, pw, pd] of ceilPieces(W, D, room.floorHoles))
      B.push(`fl-${f.floor}` as MatKey, tessPlaneGeo(pw, pd, 0.5), B.M(cx, 0.012, cz, 0, -HALF_PI, 0), "#ffffff", { uv: "rect", wear: 0, under: 0, rect: [(cx - pw / 2 + W / 2) / tile, (cz - pd / 2 + D / 2) / tile, (cx + pw / 2 + W / 2) / tile, (cz + pd / 2 + D / 2) / tile] });
  }
  const sides: Side[] = [0, 1, 2, 3];
  const wallCol = f.wall ? new THREE.Color(f.wall) : null;
  const dadoCol = f.dado ? new THREE.Color(f.dado) : null;
  const trim = room.style === "cabin" || room.style === "hut" ? WOOD[1] : room.style === "warehouse" ? "#6e6a60" : "#f4eee2";
  const trimKey: MatKey = room.style === "cabin" || room.style === "hut" || room.style === "warehouse" ? "wood" : "paint";
  const stoneWalls = f.wallMat === "stone";
  for (const s of sides) {
    const L = s % 2 === 0 ? W : D;
    const ops = room.openings.filter((o) => o.side === s);
    const sg = alongSign(s);
    const at = (a: number) => a * sg;   // along → wall-frame x
    const doorCuts = ops.filter((o) => o.kind !== "window").map((o) => [o.at - o.w / 2, o.at + o.w / 2] as [number, number]);
    const winCuts = ops.filter((o) => o.kind === "window").map((o) => [o.at - o.w / 2, o.at + o.w / 2] as [number, number]);
    const band = (y0: number, y1: number, key: MatKey, col: THREE.Color, off: number, thick = 0.012) => {
      if (y1 - y0 < 0.01) return;
      // split vertically at the opening edges so a band never crosses an opening
      const ys = [y0, y1];
      for (const o of ops) { const oy0 = o.y0 ?? (o.kind === "window" ? 1.0 : 0), oy1 = oy0 + (o.h ?? (o.kind === "window" ? 1.3 : 2.3)); for (const y of [oy0, oy1]) if (y > y0 + 0.01 && y < y1 - 0.01) ys.push(y); }
      ys.sort((a, b) => a - b);
      for (let k = 0; k < ys.length - 1; k++) {
        const ya = ys[k], yb = ys[k + 1];
        const cc: Array<[number, number]> = [];
        for (const o of ops) { const oy0 = o.y0 ?? (o.kind === "window" ? 1.0 : 0), oy1 = oy0 + (o.h ?? (o.kind === "window" ? 1.3 : 2.3)); if (yb > oy0 + 0.001 && ya < oy1 - 0.001) cc.push([o.at - o.w / 2, o.at + o.w / 2]); }
        for (const [a, b] of intervals(L - 0.002, cc)) {
          B.base.copy(roomBase).multiply(wallM(room, s, (a + b) / 2, off, 0));
          const us = key === "plaster" ? 1 / 3 : key === "fl-boards" ? 0.5 : key === "wl-block" ? 1 / 2.4 : 1;
          B.push(key, tessPlaneGeo(b - a, yb - ya, 0.5), B.M(0, (ya + yb) / 2, 0), col, { uv: "wall", uvScale: us, uvOff: [((a + b) / 2) * alongSign(s), (ya + yb) / 2], wear: 0, under: 0, grime: ya < 0.01 ? 0.12 : 0 });
          void thick;
        }
      }
    };
    // wall paint (+ dado + chair rail)
    const dadoH = 0.95;
    const wallKey: MatKey = f.wallMat === "panel" ? "fl-boards" : f.wallMat === "stone" ? "wl-block" : "plaster";
    const wallTint = wallCol && f.wallMat !== "plaster" ? wallCol.clone().lerp(new THREE.Color("#ffffff"), f.wallMat === "panel" ? 0.62 : 0.45) : wallCol;
    if (wallCol) band(dadoCol ? dadoH : 0, H, wallKey, wallTint!, 0.006 + so);
    if (dadoCol) { band(0, dadoH, "paint", dadoCol, 0.01 + so, 0.02); }
    if (dadoCol) for (const [a, b] of intervals(L, [...doorCuts, ...winCuts.filter(() => dadoH > 0.97)])) {
      B.base.copy(roomBase).multiply(wallM(room, s, (a + b) / 2, 0.02 + so, 0));
      B.box(trimKey, 0, dadoH - 0.02, -0.01, b - a, 0.05, 0.04, trim, { b: 0.01 });
    }
    // baseboards
    if (f.baseboard) for (const [a, b] of intervals(L, doorCuts)) {
      B.base.copy(roomBase).multiply(wallM(room, s, (a + b) / 2, 0.02 + so, 0));
      B.box(trimKey, 0, 0.0, -0.0, b - a, 0.13, 0.028, trim, { b: 0.008, grime: 0.2 });
    }
    // cornice
    if (f.ceiling !== "none" && !room.openTop && (wallCol || dadoCol || f.liner)) {
      B.base.copy(roomBase).multiply(wallM(room, s, 0, 0.03 + so, 0));
      B.box(trimKey, 0, H - (f.ceiling === "grid" ? 0.17 : 0.1), -0.02, L - 2 * so, 0.1, 0.06, trim, { b: 0.015 });
    }
    // openings: casings, jamb linings, sills, glass, curtains
    for (const o of ops) {
      const isWin = o.kind === "window", y0 = o.y0 ?? (isWin ? 1.0 : 0), h = o.h ?? (isWin ? 1.3 : 2.3), cx = at(o.at);
      B.base.copy(roomBase).multiply(wallM(room, s, 0, 0, 0));
      const cw = 0.09, cd = 0.03, col = trim;
      if (stoneWalls && !f.frames) {
        // dressed-stone surround: a lintel block over the opening, a projecting sill under a window, block jambs
        const sc = new THREE.Color(f.wall ?? "#cbbf9f").lerp(new THREE.Color("#ffffff"), 0.2);
        B.box("stone", cx, y0 + h, 0.02, o.w + 0.5, 0.26, 0.12, sc.clone().multiplyScalar(0.92), { b: 0.03, grime: 0.1 });
        B.box("stone", cx, y0 + h - 0.02, -t / 2, o.w + 0.02, 0.05, t - 0.02, sc.clone().multiplyScalar(0.8), { b: 0.01, wear: 0.2 });
        if (isWin) {
          B.box("stone", cx, y0 - 0.14, 0.03, o.w + 0.36, 0.14, 0.16, sc, { b: 0.025, grime: 0.15 });
          B.box("stone", cx, y0 - 0.02, -t / 2 + 0.02, o.w + 0.02, 0.03, t, sc.clone().multiplyScalar(0.85), { b: 0.008 });
          B.box("stone", cx, y0 - 0.3, 0.01, o.w * 0.5, 0.14, 0.08, sc.clone().multiplyScalar(0.88), { b: 0.02 });   // corbel
        }
        for (const sx of [-1, 1]) for (let k = 0; k < Math.max(2, Math.round(h / 0.45)); k++) {
          const bh = h / Math.max(2, Math.round(h / 0.45)), wide = k % 2 ? 0.2 : 0.3;
          B.box("stone", cx + sx * (o.w / 2 + wide / 2 - 0.02), y0 + k * bh + 0.01, 0.015, wide, bh - 0.02, 0.07, sc.clone().multiplyScalar(0.9 + (k % 3) * 0.05), { b: 0.02 });
        }
      }
      if (f.frames) {
        // casing (inner face)
        for (const sx of [-1, 1]) B.box(trimKey, cx + sx * (o.w / 2 + cw / 2), isWin ? y0 - 0.02 : 0, cd / 2, cw, h + (isWin ? 0.04 : 0) + cw, cd, col, { b: 0.01, grime: isWin ? 0 : 0.15 });
        B.box(trimKey, cx, y0 + h, cd / 2, o.w + 2 * cw + 0.04, cw, cd + 0.01, col, { b: 0.012 });
        // jamb linings through the wall
        for (const sx of [-1, 1]) B.box(trimKey, cx + sx * (o.w / 2 - 0.01), y0, -t / 2, 0.02, h, t - 0.01, col, { b: 0, wear: 0 });
        B.box(trimKey, cx, y0 + h - 0.02, -t / 2, o.w, 0.02, t - 0.01, col, { b: 0, wear: 0 });
        if (isWin) {
          B.box(trimKey, cx, y0 - 0.045, 0.02, o.w + 0.16, 0.045, t * 0.5 + 0.1, col, { b: 0.012 });    // sill (stool)
          B.box(trimKey, cx, y0 - 0.2, cd / 2, o.w + 0.1, 0.16, cd, col, { b: 0.008 });                 // apron
        }
      }
      if (isWin && f.glass) {
        B.box("glass", cx, y0 + 0.02, -t / 2, o.w - 0.04, h - 0.04, 0.012, "#d6ecf2", { b: 0, wear: 0, under: 0 });
        const mc = room.style === "lab" ? "#9aa7ad" : trim, mk: MatKey = room.style === "lab" ? "metal" : trimKey;
        // (no cross mullion — panes break and the opening is a vault; the frame stays)
        for (const sx of [-1, 1]) B.box(mk, cx + sx * (o.w / 2 - 0.04), y0, -t / 2, 0.06, h, 0.06, mc, { b: 0.01 });
        for (const yy of [y0, y0 + h - 0.06]) B.box(mk, cx, yy, -t / 2, o.w - 0.04, 0.06, 0.06, mc, { b: 0.01 });
      }
      if (isWin && f.curtains) {
        const fab = ["#d9483b", "#2f8a86", "#e8b04a", "#f2e3c7"][Math.abs(Math.round(o.at * 7 + room.seed)) % 4];
        B.cyl("metal", cx, y0 + h + 0.18, 0.1, 0.012, 0.012, o.w + 0.9, "#c9a45a", { rz: HALF_PI, seg: 6 });
        for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) {
          B.box("cloth", cx + sx * (o.w / 2 + 0.12 + k * 0.09), y0 - 0.25, 0.08 + (k % 2) * 0.03, 0.1, h + 0.4, 0.05, new THREE.Color(fab).multiplyScalar(0.92 + (k % 2) * 0.12), { b: 0.02, wear: 0 });
        }
      }
      // window light on the floor (not underground)
      if (isWin && !room.dark) {
        B.base.copy(roomBase).multiply(wallM(room, s, 0, 0, 0));
        B.push("fxwin", planeUp(), B.M(cx, 0.035, Math.min(1.2, (s % 2 === 0 ? D : W) * 0.35), 0, -HALF_PI, 0, o.w * 1.25, Math.min(2.2, (s % 2 === 0 ? D : W) * 0.6), 1), new THREE.Color(0.55, 0.5, 0.4), { uv: "geo", wear: 0, under: 0 });
      }
    }
  }
  // ceiling (a liner when the kit's lit shell hangs under the POI's own ceiling)
  const grid = f.ceiling === "grid";
  if (!room.openTop && f.ceiling !== "none") {
    B.base.copy(roomBase);
    const ceilCol = f.ceiling === "planks" ? "#ffffff" : wallCol ? wallCol.clone().lerp(new THREE.Color("#ffffff"), 0.6) : new THREE.Color("#efe7d8");
    // stair wells stay OPEN: the ceiling is laid as rectangles around room.ceilHoles
    const pieces = ceilPieces(W, D, room.ceilHoles);
    if (!grid) for (const [cx, cz, pw, pd] of pieces) B.push(f.ceiling === "planks" ? "fl-boards" : "plaster", tessPlaneGeo(pw, pd, 0.5), B.M(cx, H - 0.018 - (f.liner ? 0.01 : 0), cz, 0, HALF_PI, 0), ceilCol, { uv: "rect", rect: f.ceiling === "planks" ? [(cx - pw / 2) * 0.5, (cz - pd / 2) * 0.5, (cx + pw / 2) * 0.5, (cz + pd / 2) * 0.5] : [(cx - pw / 2) / 3, (cz - pd / 2) / 3, (cx + pw / 2) / 3, (cz + pd / 2) / 3], wear: 0, under: 0 });
    if (grid) {
      // drop ceiling 7 cm under the slab: tiles + a light panel every ~2.4 m (glow + a pool on the floor) + vents
      for (const [cx, cz, pw, pd] of ceilPieces(W - 0.02, D - 0.02, room.ceilHoles)) B.push("ceil", tessPlaneGeo(pw, pd, 0.6), B.M(cx, H - 0.07, cz, 0, HALF_PI, 0), "#ffffff", { uv: "rect", rect: [(cx - pw / 2) / 1.2, (cz - pd / 2) / 1.2, (cx + pw / 2) / 1.2, (cz + pd / 2) / 1.2], wear: 0, under: 0 });
      for (const pn of gridPanels(room)) {
        if (inHole(room.ceilHoles, pn.x, pn.z, 0.7)) continue;
        const gx = pn.x, gz = pn.z;
        if (pn.vent) { B.box("metal", gx, H - 0.085, gz, 0.5, 0.02, 0.5, "#cfd3d3", { b: 0.005 }); for (let k = -2; k <= 2; k++) B.box("paint", gx + k * 0.08, H - 0.088, gz, 0.03, 0.005, 0.4, "#555", { b: 0, wear: 0 }); continue; }
        B.box("metal", gx, H - 0.09, gz, 0.62, 0.025, 1.22, "#e6e8e6", { b: 0.006 });
        B.box("glow", gx, H - 0.095, gz, 0.54, 0.01, 1.14, new THREE.Color(2.1, 2.05, 1.85), { b: 0, wear: 0, under: 0 });
        fxLights.push(panelLight(room, pn));
      }
    }
    if ((f.ceiling === "beams" || f.ceiling === "planks") && H >= 2.6) {
      const alongX = W < D, span = alongX ? W : D, len = alongX ? D : W, n = Math.max(1, Math.round(len / 1.3));
      for (let i = 1; i < n + 1; i++) {
        const p = -len / 2 + (i - 0.5) * (len / n);
        // (a beam crossing a stair well is cut at the well: the pieces either side stay)
        for (const [a0, a1] of cutSpan(-span / 2, span / 2, room.ceilHoles, alongX, p)) {
          if (alongX) B.box("wood", (a0 + a1) / 2, H - 0.2, p, a1 - a0, 0.19, 0.16, WOOD[3], { b: 0.02 });
          else B.box("wood", p, H - 0.2, (a0 + a1) / 2, 0.16, 0.19, a1 - a0, WOOD[3], { b: 0.02 });
        }
      }
    }
  }
  // light: warm pools on the floor, a wash on the ceiling above a fixture, a wall-wash behind lamps standing near a wall
  const ceilY = H - (grid ? 0.11 : 0.035);
  for (const Lt of fxLights) {
    B.base.copy(roomBase);
    const warm = Lt.c.clone();
    if (Lt.floor) {
      // A light pool belongs to its floor, including the real stair cutout.
      // Preserve the original pool UVs on each surviving rectangle.
      const size = Lt.r * 2;
      const holes = room.floorHoles?.map(([x0,z0,x1,z1]) => [x0-Lt.x,z0-Lt.z,x1-Lt.x,z1-Lt.z] as [number,number,number,number]);
      for (const [cx,cz,w,d] of ceilPieces(size,size,holes)) {
        B.push("fx", planeUp(), B.M(Lt.x+cx,0.04,Lt.z+cz,0,-HALF_PI,0,w,d,1),warm.clone().multiplyScalar(0.9),{ uv: "rect", rect: [(cx-w/2)/size+0.5,(cz-d/2)/size+0.5,(cx+w/2)/size+0.5,(cz+d/2)/size+0.5],wear:0,under:0 });
      }
    }
    if (!room.openTop && f.ceiling !== "none" && Lt.y > H - 1.4) {
      const size = Lt.r * 1.5;
      const holes = room.ceilHoles?.map(([x0,z0,x1,z1]) => [x0-Lt.x,z0-Lt.z,x1-Lt.x,z1-Lt.z] as [number,number,number,number]);
      for (const [cx,cz,w,d] of ceilPieces(size,size,holes)) {
        B.push("fx",planeUp(),B.M(Lt.x+cx,ceilY,Lt.z+cz,0,HALF_PI,0,w,d,1),warm.clone().multiplyScalar(grid?0.9:0.8),{uv:"rect",rect:[(cx-w/2)/size+0.5,(cz-d/2)/size+0.5,(cx+w/2)/size+0.5,(cz+d/2)/size+0.5],wear:0,under:0});
      }
    }
    // wall wash: the nearest wall within 1.1 m of a lamp below the ceiling band
    if (Lt.y < H - 0.5 && Lt.wash === true) {
      const cand: Array<[Side, number]> = [[0, D / 2 - Lt.z], [2, Lt.z + D / 2], [1, W / 2 - Lt.x], [3, Lt.x + W / 2]];
      cand.sort((p, q) => p[1] - q[1]);
      const [ws, dist] = cand[0];
      if (dist < 1.1) {
        const along = ws % 2 === 0 ? Lt.x : Lt.z, k = 1 - dist / 1.1;
        const blocked = room.openings.some((o) => o.side === ws && Math.abs(o.at - along) < o.w / 2 + 0.5);
        if (!blocked) {
          B.base.copy(roomBase).multiply(wallM(room, ws, along, 0.02, 0));
          const hh = Math.min(H - 0.1, 2.6), yc = Math.min(Math.max(Lt.y, hh / 2), H - hh / 2 - 0.05);
          B.push("fxwash", planeUp(), B.M(0, yc, 0, 0, 0, 0, 1.9, hh, 1), warm.clone().multiplyScalar(2.6 * k), { uv: "geo", wear: 0, under: 0 });
        }
      }
    }
  }
  B.base.copy(roomBase);
}
/** closed temple halls: stone architraves along each column row and tie beams across the nave, at the ceiling */
function drawArchitraves(B: IBuilder, room: InteriorRoom, L: InteriorLayout, roomM: THREE.Matrix4) {
  const cols = L.items.filter((i) => i.kind === "column");
  if (cols.length < 4) return;
  const H = room.h, naveX = Math.abs(cols[0].z - cols[1].z) < 0.3 || new Set(cols.map((c) => Math.round(c.z * 2))).size <= 2;
  const across = (c: (typeof cols)[number]) => (naveX ? c.z : c.x), along = (c: (typeof cols)[number]) => (naveX ? c.x : c.z);
  const rows = new Map<number, typeof cols>();
  for (const c of cols) { const k = Math.round(across(c) * 2); rows.set(k, [...(rows.get(k) ?? []), c]); }
  B.base.copy(roomM);
  const col = "#a89a80";
  for (const row of rows.values()) {
    row.sort((a, b) => along(a) - along(b));
    if (row.length < 2) continue;
    const a0 = along(row[0]) - 0.5, a1 = along(row[row.length - 1]) + 0.5, t = across(row[0]);
    B.box("stone", naveX ? (a0 + a1) / 2 : t, H - 0.46, naveX ? t : (a0 + a1) / 2, naveX ? a1 - a0 : 0.62, 0.46, naveX ? 0.62 : a1 - a0, col, { b: 0.04, grime: 0.1 });
  }
  // tie beams between facing columns
  const [r0, r1] = [...rows.values()];
  if (r0 && r1) for (const c of r0) {
    const o = r1.find((q) => Math.abs(along(q) - along(c)) < 0.3);
    if (!o) continue;
    const a = along(c), t0 = across(c), t1 = across(o);
    B.box("stone", naveX ? a : (t0 + t1) / 2, H - 0.4, naveX ? (t0 + t1) / 2 : a, naveX ? 0.5 : Math.abs(t1 - t0), 0.4, naveX ? Math.abs(t1 - t0) : 0.5, "#9c8f78", { b: 0.035 });
  }
}
/** contact shadows: a soft dark footprint (multiplied) under every floor-standing piece */
function drawContacts(B: IBuilder, L: InteriorLayout, roomM: THREE.Matrix4) {
  for (const it of L.items) {
    if (it.y > 0.05 || FLAT.has(it.kind) || it.h < 0.15 || it.kind === "column" && it.w < 0.3) continue;
    const legged = it.kind === "table" || it.kind === "coffee-table" || it.kind === "chair" || it.kind === "desk" || it.kind === "stool" || it.kind === "side-table" || it.kind === "office-chair" || it.kind === "map-table" || it.kind === "floor-lamp" || it.kind === "workbench";
    const k = legged ? 0.62 : it.h > 1 ? 1.0 : 0.85, m = legged ? 0.3 : 0.24;
    B.base.multiplyMatrices(roomM, new THREE.Matrix4().makeRotationY(it.yaw).setPosition(it.x, 0, it.z));
    const w = it.w + 2 * m, d = it.d + 2 * m;
    B.push("shadow", planeUp(), B.M(0, 0.036, 0, 0, -HALF_PI, 0, w, d, 1), new THREE.Color(k, k, k), { uv: "geo", wear: 0, under: 0 });
  }
}
let _pu: THREE.BufferGeometry | null = null;
function planeUp() { return (_pu ??= new THREE.PlaneGeometry(1, 1).toNonIndexed()); }

/** one room's furniture + finish + light into the builder (sync; buildInteriors yields between rooms). Exported for the
 *  build benchmark. */
export function buildRoomInto(B: IBuilder, room: InteriorRoom, L: InteriorLayout, ox: number, oy: number, oz: number, fin = true, sky: "auto" | "force" | "off" = "auto"): InteriorLayout {
    const roomM = new THREE.Matrix4().makeRotationY(room.yaw).setPosition(room.x - ox, room.y - oy, room.z - oz);
    B.toRoom.copy(roomM).invert();
    const itM = new THREE.Matrix4(), p = new THREE.Vector3();
    // pass 1 (dry): every fixture's light, so pass 2 can bake it into the vertices of the room it stands in
    const fin0 = fin ? drawnFinish(room, L.finish) : null;
    const lit: Light[] = [];
    {
      const DB = new IBuilder(); DB.dry = true;
      const Dd: DrawCtx = { B: DB, style: room.style, ceil: room.h, rng: rngOf(room.seed * 7 + 3), lights: [] };
      for (const it of L.items) {
        itM.makeRotationY(it.yaw).setPosition(it.x, it.y, it.z);
        Dd.ceil = room.h - it.y; Dd.lights = [];
        drawItem(Dd, it);
        for (const l of Dd.lights) { p.set(l.x, l.y, l.z).applyMatrix4(itM); lit.push({ ...l, x: p.x, y: p.y, z: p.z }); }
      }
      if (fin0 && !room.openTop && fin0.ceiling === "grid") for (const pn of gridPanels(room)) if (!pn.vent) lit.push(panelLight(room, pn));
    }
    const ao = roomAo(room, L, lit);
    B.ao = sky === "off" ? (x, y, z, nx, ny, nz, out) => { ao(x, y, z, nx, ny, nz, out); out[1] = 1; } : ao;
    B.skyForce = sky === "force";
    const D: DrawCtx = { B, style: room.style, ceil: room.h, rng: rngOf(room.seed * 7 + 3), lights: [] };
    const localLights: DrawCtx["lights"] = [];
    for (const it of L.items) {
      itM.makeRotationY(it.yaw).setPosition(it.x, it.y, it.z);
      B.base.multiplyMatrices(roomM, itM);
      D.ceil = room.h - it.y;
      D.lights = [];
      drawItem(D, it);
      // lights → room-local
      for (const l of D.lights) { p.set(l.x, l.y, l.z).applyMatrix4(itM); localLights.push({ ...l, x: p.x, y: p.y, z: p.z }); }
    }
    drawContacts(B, L, roomM);
    if (room.style === "temple" && !room.openTop) drawArchitraves(B, room, L, roomM);
    B.base.copy(roomM);
    if (fin0) drawFinish(B, room, fin0, localLights);
    B.ao = null;
  return L;
}

// ------------------------------------------------------------------------------------------------ public API
export async function buildInteriors(ctx: WorldCtx, rooms: InteriorRoom[], o: InteriorBuildOpts = {}): Promise<InteriorBuild> {
  const group = new THREE.Group();
  group.name = o.name ?? "interiors";
  const layouts: InteriorLayout[] = [];
  if (!rooms.length) return { group, layouts, tris: 0, draws: 0 };
  let tick: ((t: number) => void) | null = null;
  ctx.onUpdate((_dt, t) => tick?.(t));
  const ox = rooms[0].x, oy = rooms[0].y, oz = rooms[0].z;
  group.position.set(ox, oy, oz);
  const B = new IBuilder();
  const fin = o.finish !== false;
  const sky = o.bakeSky ?? "auto";
  for (const [ri, room] of rooms.entries()) {
    layouts.push(buildRoomInto(B, room, o.layouts?.[ri] ?? furnishRoom(room), ox, oy, oz, fin, sky));
    await ctx.yield();
  }
  const M = mats();
  const meshes = B.meshes((k) => M.get(k)!, group.name);
  const shadows = o.shadows !== false;
  let fx: THREE.Mesh[] = [];
  for (const m of meshes) {
    const k = m.name.split(":").pop() as MatKey;
    m.castShadow = shadows && FURNITURE.has(k);
    m.receiveShadow = !UNLIT_FX.has(k);
    if (k === "glass") m.renderOrder = 2;
    if (k === "shadow") m.renderOrder = 1;
    if (k === "fx" || k === "fxwin" || k === "fxwash") { m.renderOrder = 3; fx.push(m); }
    if (k === "fire" || k === "neon") m.renderOrder = 4;
    group.add(m);
  }
  fx = fx.filter(Boolean);
  (o.parent ?? ctx.scene).add(group);
  group.updateMatrixWorld(true);
  // distance culling (one sphere per call)
  const box = new THREE.Box3();
  for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld)); }
  const centre = box.getCenter(new THREE.Vector3()), rad = box.getSize(new THREE.Vector3()).length() / 2;
  const far = o.maxDist ?? 150, fxFar = 70;
  // write `visible` only when THIS cull's own decision changes. A POI that also LODs the group (canopy-line's
  // distanceSwitch hides it every 6th frame beyond 58 m) would be overruled every frame → the interiors flicker 5
  // frames on / 1 off (10 Hz).
  let own: boolean | null = null;
  // the distance cull switches the group's CHILDREN, not the group: a group added straight to the scene is
  // a module root, and roots carry the terrain-occlusion gate on `visible` — the engine could not dissolve a root's own
  // switch (the harbor's ship / shed rooms appeared in one frame at ~105 m); the children dissolve like every module switch
  const fxSet = new Set<THREE.Object3D>(fx);
  tick = (t) => {
    const d = ctx.camera.position.distanceTo(centre) - rad;
    const vis = d < far;
    if (vis !== own) { own = vis; for (const c of group.children) if (!fxSet.has(c)) c.visible = vis; }
    if (vis) FIRE_T.value = t;
    const fv = vis && d < fxFar;
    for (const m of fx) if (m.visible !== fv) m.visible = fv;
  };
  return { group, layouts, tris: B.tris, draws: meshes.length };
}

export { furnishRoom };
export type { InteriorRoom };
