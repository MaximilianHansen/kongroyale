// Floor loot — target art loot-05-ground-loot. An item (weapon / heal / ammo bunch) resting on (or hovering just above) the
// ground with a saturated rarity light column rising FROM the item (the column fades out over the item's own height,
// so it never washes the item white), a small hot core, a ground glow and a slow bob + spin.
// Performance: in the game the kit's LootSystem draws
//   · the real item (full meshes, shadows) only within NEAR_R (4.5 m),
//   · beyond it a baked single-mesh LOD (≤ 2k tris, no shadows) through ONE instanced batch per item kind,
//   · every beam / core / ground glow through three instanced batches for ALL loot (colour per instance),
//   · nothing beyond CULL_R (90 m).
// The hut stage (no system) builds everything as real meshes.
import * as THREE from "three";
import type { WorldCtx } from "../engine/engine";
import type { ConsumableId, Rarity, WeaponId } from "../../../shared/world/map";
import { CONSUMABLES, WEAPONS } from "../../../shared/world/map";
import { CONSUMABLE_DEFS } from "../../../shared/sim/const";
import { gunInstance } from "./guns/index";
import { buildHeal } from "./heals";
import { PartBuilder } from "./lib/builder";
import { C, mats } from "./lib/mats";
import { bananaGeometry, bananaEnd, filletCyl, tf, alignY } from "./lib/geo";
import { InstanceBatch, ViewCull, drawn } from "./lib/batch";
import { bake, cluster } from "./held";
import { tintAccent } from "./rarity";
import { camoMaterial, camoSkin, MYTHIC_TINT } from "./camo";
import { cashStack } from "./loot-lane";
import type { LootView } from "./api";

type Item = WeaponId | ConsumableId | "ammo" | "cash";
const BEAM_H = 2.1;

// ------------------------------------------------------------------------------------------------ shared beam
const BEAM_VERT = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vCol; varying float vY;
uniform vec3 uColor; uniform float uStart;
void main() {
  vUv = uv; vY = position.y;
  vec4 lp = vec4(position, 1.0);
#ifdef USE_INSTANCING
  lp = instanceMatrix * lp;
  mat3 nm = mat3(modelViewMatrix * instanceMatrix);
#else
  mat3 nm = mat3(modelViewMatrix);
#endif
#ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
#else
  vCol = uColor;
#endif
  vec4 mv = modelViewMatrix * lp;
  vN = normalize(nm * normal); vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
/** column: it rises FROM THE FLOOR, wider than the item, saturated; around the item (vY < uItem) its
 *  middle is hollowed out (only the rim of the cylinder glows there) so the item keeps its own colours inside the light;
 *  brightest just above the item, fading with height; soft rising streaks; a thin hot core line above the item */
const BEAM_FRAG = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vCol; varying float vY;
uniform float uTime; uniform float uStart; uniform float uH; uniform float uCore; uniform float uItem;
void main() {
  // a crisp LIGHT column, not a smoky column of fog — the colour concentrates toward the axis (steep
  // facing falloff), a thin hot core line, a faint bright rim outlining the column, soft rising streaks, a hot pool at
  // the floor; round the item the middle stays hollow so the item keeps its own colours inside the light
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float h = clamp(vY / uH, 0.0, 1.0);
  float fade = pow(1.0 - h, 2.3);
  float base = smoothstep(uStart - 0.02, uStart + 0.05, vY);
  float flick = 0.92 + 0.08 * sin(uTime * 3.0 + vUv.y * 9.0);
  float a = atan(vN.x, vN.z);
  float streak = 0.7 + 0.3 * sin(a * 7.0 + uTime * 0.6) * sin(vUv.x * 40.0 - uTime * 1.2 + vY * 3.0);
  float zone = 1.0 - smoothstep(uItem * 0.8, uItem * 1.3 + 0.05, vY);
  float pool = exp(-vY * 5.0);
  // round the item only the FAR half of the column draws (front faces fade out in the item zone): the item occludes
  // the light behind it by depth instead of being tinted by additive light in front of it (it keeps its colours)
  float front = gl_FrontFacing ? 1.0 - zone : 1.0;
  // a steeper facing falloff (soft edges, no fog wall) + a brighter hot core and floor pool — the shafts
  // read as LIGHT with a white-hot axis, not as a tinted column of smoke over whatever stands behind them
  float body = pow(facing, 3.6) * fade * base * flick * streak * front * (0.5 + 1.3 * pool);
  float core = pow(facing, 24.0) * uCore * fade * base * front;
  vec3 c = vCol * body * 1.15 + mix(vCol, vec3(1.0), 0.22) * core * 1.9; // vivid, the core keeps its hue
  gl_FragColor = vec4(c, 0.0);
}`;
let beamGeo: THREE.BufferGeometry | null = null, glowGeo: THREE.BufferGeometry | null = null;
const beamUniforms = { uTime: { value: 0 }, uStart: { value: 0.0 }, uH: { value: BEAM_H }, uCore: { value: 1.0 }, uItem: { value: 0.42 }, uColor: { value: new THREE.Color(1, 1, 1) } };
function beamGeometry() {
  // a tapered column from the FLOOR, a little wider than the item footprint (r 0.26 at the floor → 0.12 at the top)
  beamGeo ??= new THREE.CylinderGeometry(0.1, 0.17, BEAM_H, 32, 8, true).translate(0, BEAM_H / 2, 0); // narrower
  return beamGeo;
}
function glowGeometry() { glowGeo ??= new THREE.PlaneGeometry(1.2, 1.2).rotateX(-Math.PI / 2).translate(0, 0.015, 0); return glowGeo; }
function beamMaterial(instanced: boolean, color?: THREE.Color, start = 0.25): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
    uniforms: instanced ? beamUniforms : { ...beamUniforms, uColor: { value: color ?? new THREE.Color(1, 1, 1) }, uStart: { value: 0 }, uItem: { value: start } },
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, side: THREE.DoubleSide, toneMapped: false,
  });
  m.name = "loot-beam";
  return m;
}
let glowMatI: THREE.MeshBasicMaterial | null = null;
function glowMaterial(color?: THREE.Color): THREE.MeshBasicMaterial {
  if (!color && glowMatI) return glowMatI;
  const m = new THREE.MeshBasicMaterial({ map: mats().glow, color: color ?? 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  m.name = "loot-glow";
  if (!color) glowMatI = m;
  return m;
}
/** saturated beam colours (the pale chest-glow hues washed out on the floor) */
export const BEAM_COL: Record<Rarity, string> = { common: "#c9d6ea", uncommon: "#4cff1c", rare: "#2a8fff", epic: "#b43cff", legendary: "#ffb20a", mythic: "#ff1c58" };
/** heals glow by what they restore, whatever their rarity: green = health, blue = shield (the golden banana keeps gold) */
export const HEAL_GLOW = { hp: "#3dff5a", shield: "#2a8fff" };
export function lootGlowColor(item: Item, rarity: Rarity): string {
  if (item === "cash") return "#ffd21a";   // (economy) Banana Bucks glow banana-gold
  // every beam is its RARITY colour (the genre's standard read); heals keep their restore colour only when common
  if (!(CONSUMABLES as readonly string[]).includes(item) || rarity !== "common") return BEAM_COL[rarity];
  const c = CONSUMABLE_DEFS[item as ConsumableId];
  return c.shield === 0 ? HEAL_GLOW.hp : c.hp === 0 ? HEAL_GLOW.shield : BEAM_COL[rarity];
}
const beamCol = (item: Item, r: Rarity) => new THREE.Color(lootGlowColor(item, r));

// ------------------------------------------------------------------------------------------------ items
let bunchCache: THREE.Group | null = null;
/** ammo: a hand of five bananas lying on its side (stems joined in a brown crown at one end, fanning, curling up) */
function ammoBunch(): THREE.Group {
  if (!bunchCache) {
    const b = new PartBuilder();
    const crown = new THREE.Vector3(-0.13, 0.05, 0);
    for (let i = 0; i < 5; i++) {
      const fan = (i - 2) * 0.2, lift = 0.05 + Math.abs(i - 2) * 0.012;
      const len = 0.25 - Math.abs(i - 2) * 0.012, r = 0.034;
      const g = bananaGeometry({ length: len, radius: r, bend: 0.85, facets: 5, round: 0.45, along: 30, radial: 26 });
      // banana +X runs from the crown outward (fanning in XZ), its back (+Y) up → curls upward at the tip
      const dir = new THREE.Vector3(Math.cos(fan), 0.12, Math.sin(fan)).normalize();
      const up = new THREE.Vector3(0, 1, 0).projectOnPlane(dir).normalize();
      const zp = new THREE.Vector3().crossVectors(dir, up);
      const m = new THREE.Matrix4().makeBasis(dir, up, zp).setPosition(crown.clone().add(new THREE.Vector3(0, lift - 0.05 + (i % 2) * 0.012, (i - 2) * 0.012)));
      b.addGradient(g, C.bananaDeep, C.banana, "y", "gloss", m);
      const t = bananaEnd({ length: len, radius: r, bend: 0.85 }, true);
      b.add(new THREE.SphereGeometry(r * 0.24, 8, 6), "#3a2414", "matte", tf(t.center.clone().applyMatrix4(m).toArray() as [number, number, number]));
    }
    b.add(filletCyl(0.035, 0.07, 0.01, 12, 0.028, 0.04), C.brownDark, "matte", alignY(crown.clone().add(new THREE.Vector3(-0.02, 0.012, 0)), new THREE.Vector3(-1, 0.3, 0)));
    b.add(filletCyl(0.022, 0.012, 0.004, 12), "#7a5030", "matte", alignY(crown.clone().add(new THREE.Vector3(-0.058, 0.024, 0)), new THREE.Vector3(-1, 0.3, 0)));
    bunchCache = b.build({ name: "ammo-bunch" }).root;
  }
  return bunchCache.clone(true) as THREE.Group;
}
function itemMesh(item: Item, scale: number, grounded: boolean, rarity?: Rarity, skin: string | null = null): THREE.Object3D {
  if ((WEAPONS as readonly string[]).includes(item)) {
    const g = gunInstance(item as WeaponId);
    const ms: THREE.Mesh[] = [];
    if (g.pivots.accent) { g.pivots.accent.visible = true; if (rarity) { g.pivots.accent.traverse((o) => { if ((o as THREE.Mesh).isMesh) ms.push(o as THREE.Mesh); }); tintAccent(ms, rarity); } }
    // a mythic on the floor wears the camo (its own tint; the generic one when it has none —
    // the prewarm's createLoot(w, "mythic") compiles the camo programs that way)
    const tint = skin ?? (rarity === "mythic" ? MYTHIC_TINT : null);
    if (tint) camoSkin(g.meshes.filter((m) => !ms.includes(m) && !(m.material as THREE.MeshBasicMaterial).isMeshBasicMaterial), tint);
    // lying on its left side: the side profile faces up (and toward whoever looks down at it)
    g.root.rotation.set(0, grounded ? -Math.PI / 2 + 0.3 : 0, -Math.PI / 2 + 0.06, "YXZ");
    g.root.scale.setScalar(1.5 * scale);
    return g.root;
  }
  if (item === "ammo") { const m = ammoBunch(); m.scale.setScalar(1.3 * scale); return m; }
  if (item === "cash") { const m = cashStack().root; m.scale.setScalar(1.25 * scale); return m; }
  const m = buildHeal(item as ConsumableId).root; m.scale.setScalar(1.15 * scale); return m;
}
/** item geometry centred over the origin, resting on y = 0 (returns the holder offset + extents) */
function place(mesh: THREE.Object3D): { holder: THREE.Group; top: number; radius: number } {
  const holder = new THREE.Group(); holder.add(mesh);
  holder.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(holder);
  const c = bb.getCenter(new THREE.Vector3());
  mesh.position.x -= c.x; mesh.position.z -= c.z; mesh.position.y -= bb.min.y;
  return { holder, top: bb.max.y - bb.min.y, radius: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 };
}

// far LOD per item kind: baked single vertex-coloured mesh, clustered down to ≤ 2k triangles
const lodCache = new Map<string, { geo: THREE.BufferGeometry; top: number }>();
const LOD_TRIS = [2000, 450];
let lodMat: THREE.MeshStandardMaterial | null = null;
function lodMaterial() { lodMat ??= Object.assign(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05 }), { name: "loot-lod" }); return lodMat; }
function lodFor(item: Item, level = 0): { geo: THREE.BufferGeometry; top: number } {
  const key = `${item}:${level}`;
  let h = lodCache.get(key);
  if (h) return h;
  const { holder, top } = place(itemMesh(item, 1, false));
  holder.updateMatrixWorld(true);
  const full = bake(holder, () => true) ?? new THREE.BoxGeometry(0.2, 0.1, 0.3);
  let cell = 0.012, g = cluster(full, cell);
  while (((g.index ? g.index.count : g.attributes.position.count) / 3) > LOD_TRIS[level] && cell < 0.3) { cell *= 1.3; g = cluster(full, cell); }
  g.computeBoundingSphere();
  h = { geo: g, top };
  lodCache.set(key, h);
  return h;
}

/** smoothstep over 0..1 (clamped) — the distance fades */
const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
// ------------------------------------------------------------------------------------------------ system (kit)
interface Member { v: LootViewEx; item: Item; rarity: Rarity; col: string; /** a mythic gun: camo LOD, a taller pulsing beam */ myth: boolean }
export type LootViewEx = LootView & { object: THREE.Group; holder: THREE.Group; itemRoot: THREE.Object3D; top: number; bob: THREE.Group; beamY: number };

export class LootSystem {
  /** real item within NEAR_R, ≤2k-tri LOD to FAR2_R, ≤450-tri LOD to CULL_R */
  // perf: LOD1 from 22 m
  // nothing may pop: items + beams reach 90 m and fade over their last 25 m (the item shrinks into its floor point, the
  // beam dims to nothing); the floor pool fades to 0 by 32 m instead of cutting there
  static NEAR_R = 4.5; static FAR2_R = 22; static CULL_R = 90; static FADE_R = 65;
  readonly root = new THREE.Group();
  readonly members = new Set<Member>();
  private far = new Map<string, InstanceBatch>();
  private beams: THREE.InstancedMesh; private glows: THREE.InstancedMesh;
  private cull = new ViewCull();
  private _p = new THREE.Vector3(); private _m = new THREE.Matrix4(); private _c = new THREE.Color(); private _f = new THREE.Matrix4(); private _s = new THREE.Vector3();
  constructor(readonly ctx: WorldCtx) {
    this.root.name = "loot-system";
    this.beams = new THREE.InstancedMesh(beamGeometry(), beamMaterial(true), 512);
    this.glows = new THREE.InstancedMesh(glowGeometry(), glowMaterial(), 512);
    for (const [m, n, ro] of [[this.beams, "loot-beams", 6], [this.glows, "loot-glows", 4]] as Array<[THREE.InstancedMesh, string, number]>) {
      m.name = n; m.frustumCulled = false; m.count = 0; m.visible = false; m.renderOrder = ro; m.castShadow = false; m.receiveShadow = false; m.userData.castShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.setColorAt(0, new THREE.Color(1, 1, 1)); m.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      this.root.add(m);
    }
    ctx.scene.add(this.root);
  }
  private farBatch(item: Item, level = 0, myth = false): InstanceBatch {
    const key = `${item}:${level}${myth ? ":m" : ""}`;
    let b = this.far.get(key);
    if (!b) {
      // a mythic gun keeps its camo past the real-item range: its own batch with the camo LOD material
      const mat = myth ? camoMaterial(lodMaterial(), MYTHIC_TINT)! : lodMaterial();
      b = new InstanceBatch(lodFor(item, level).geo, mat, { name: `loot-far:${key}`, cap: myth ? 32 : 256, castShadow: false, receiveShadow: true });
      this.root.add(b.mesh);
      this.far.set(key, b);
      const atmos = this.ctx.shared.get("atmos") as { patch?(m: THREE.Material): void } | undefined;
      try { atmos?.patch?.(mat); } catch { /* ok */ }
    }
    return b;
  }
  /** all far batches exist from boot (prewarm sees them) */
  prepare(items: Item[]) { for (const i of items) { this.farBatch(i, 0); this.farBatch(i, 1); if ((WEAPONS as readonly string[]).includes(i)) { this.farBatch(i, 0, true); this.farBatch(i, 1, true); } } }
  update(t: number) {
    beamUniforms.uTime.value = t;
    this.cull.refresh(this.ctx.camera);
    const cp = this.cull.pos, scene = this.ctx.scene;
    for (const b of this.far.values()) b.begin();
    let n = 0, ng = 0;
    const bm = this.beams.instanceMatrix.array as Float32Array, gm = this.glows.instanceMatrix.array as Float32Array;
    const bc = this.beams.instanceColor!.array as Float32Array, gc = this.glows.instanceColor!.array as Float32Array;
    for (const mb of this.members) {
      const o = mb.v.object;
      if (!drawn(o, scene)) continue;
      if (o.matrixAutoUpdate || o.matrixWorldNeedsUpdate) o.updateWorldMatrix(true, false);
      this._p.setFromMatrixPosition(o.matrixWorld);
      const d = this._p.distanceTo(cp);
      const near = d < LootSystem.NEAR_R;
      if (mb.v.itemRoot.visible !== near) mb.v.itemRoot.visible = near;
      if (d > LootSystem.CULL_R) continue;
      this._p.y += 0.6;
      if (!this.cull.sees(this._p, 1.4)) continue;
      const ff = d > LootSystem.FADE_R ? 1 - smooth01((d - LootSystem.FADE_R) / (LootSystem.CULL_R - LootSystem.FADE_R)) : 1;
      if (!near) {
        if (mb.v.bob.matrixAutoUpdate || mb.v.bob.matrixWorldNeedsUpdate) mb.v.bob.updateWorldMatrix(false, false);
        this.farBatch(mb.item, d < LootSystem.FAR2_R ? 0 : 1, mb.myth).push(ff < 1 ? this._f.copy(mb.v.bob.matrixWorld).scale(this._s.setScalar(Math.max(0.001, ff))) : mb.v.bob.matrixWorld);
      }
      if (n < 512) {
        // beams / glows: the object's own frame (no bob, no spin), colour = rarity (heals: green / blue), dimmer far away; the column starts
        // at the item's top so it never washes the item
        // a mythic's column is taller and
        // wider and breathes (a slow pulse), its floor pool bigger: readable as THE mythic from across a POI
        const myth = mb.myth, pulse = myth ? 1.15 + 0.35 * Math.sin(t * 3.1 + o.id * 0.7) : 1;
        this._m.makeTranslation(0, mb.v.beamY, 0).premultiply(o.matrixWorld);
        if (myth) this._m.scale(this._s.set(1.35, 1.9, 1.35));
        this._m.toArray(bm, n * 16);
        const k = 1 - 0.5 * Math.min(1, d / LootSystem.FADE_R);
        this._c.set(mb.col).multiplyScalar(k * ff * pulse);
        bc[n * 3] = this._c.r; bc[n * 3 + 1] = this._c.g; bc[n * 3 + 2] = this._c.b;
        // the floor pool only near (32 m), fading out over its last 8 m
        if (d < (myth ? 48 : 32)) {
          if (myth) this._f.copy(o.matrixWorld).scale(this._s.set(1.9, 1, 1.9)).toArray(gm, ng * 16); else o.matrixWorld.toArray(gm, ng * 16);
          this._c.multiplyScalar(0.9 * (1 - smooth01((d - (myth ? 40 : 24)) / 8))); gc[ng * 3] = this._c.r; gc[ng * 3 + 1] = this._c.g; gc[ng * 3 + 2] = this._c.b; ng++;
        }
        n++;
      }
    }
    for (const b of this.far.values()) b.end();
    for (const [m, c] of [[this.beams, n], [this.glows, ng]] as Array<[THREE.InstancedMesh, number]>) { m.count = c; m.visible = c > 0; if (c) { m.instanceMatrix.needsUpdate = true; m.instanceColor!.needsUpdate = true; } }
    void this._m;
  }
}

// ------------------------------------------------------------------------------------------------ view
export interface LootOpts { grounded?: boolean; scale?: number; /** the gun's signature colour */ skin?: string | null }

export function createLootView(_ctx: WorldCtx, _floorY: number, item: Item, rarity: Rarity, opts: LootOpts = {}, sys?: LootSystem): LootViewEx {
  const { grounded = true, scale = 1 } = opts;
  const object = new THREE.Group(); object.name = `loot:${item}:${rarity}`;
  const { holder, top } = place(itemMesh(item, scale, grounded, rarity, opts.skin ?? null));
  const lift = grounded ? 0.01 : 0.22;
  // bob = the moving frame (bob + spin): the far batch copies ITS world matrix; the real item lives under it
  const bob = new THREE.Group(); bob.name = "loot-bob"; bob.add(holder);
  object.add(bob);
  if (sys) {
    bob.matrixAutoUpdate = false;
    bob.updateMatrix();
    // Skip walking 10-20 child meshes per loot item while itemRoot is hidden (> 4.5 m away).
    const ownUMW = holder.updateMatrixWorld;
    let was = 1;
    holder.updateMatrixWorld = function (f?: boolean) {
      if (!this.visible) { was = 0; return; }
      ownUMW.call(this, f || !was);
      was = 1;
    };
  }
  holder.traverse((o) => { if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).castShadow = true; (o as THREE.Mesh).receiveShadow = true; } });
  if (!sys) {
    // standalone (stages): own beam + glow meshes
    const beam = new THREE.Mesh(beamGeometry(), beamMaterial(false, beamCol(item, rarity), top + lift + 0.05));
    beam.name = "loot-beam"; beam.renderOrder = 6; beam.userData.castShadow = false; beam.castShadow = false;
    const glow = new THREE.Mesh(glowGeometry(), glowMaterial(beamCol(item, rarity).multiplyScalar(1.5)));
    glow.name = "loot-glow"; glow.renderOrder = 4; glow.userData.castShadow = false; glow.castShadow = false;
    object.add(beam, glow);
  }
  const phase = Math.random() * 6.28;
  const view: LootViewEx = {
    object, holder, itemRoot: holder, top, bob, beamY: 0,
    update(_dt: number, t: number) {
      if (!sys || !grounded || holder.visible) {
        bob.position.y = lift + (grounded ? 0.004 : 0.05) * (0.5 + 0.5 * Math.sin(t * 1.7 + phase));
        if (!grounded) bob.rotation.y = t * 0.6 + phase;
        if (sys) bob.updateMatrix();
      }
      if (!sys) beamUniforms.uTime.value = t;
    },
    dispose() { object.removeFromParent(); if (sys) for (const m of sys.members) if (m.v === view) { sys.members.delete(m); break; } },
  };
  view.update(0, 0);
  if (sys) sys.members.add({ v: view, item, rarity, col: lootGlowColor(item, rarity), myth: rarity === "mythic" && (WEAPONS as readonly string[]).includes(item) });
  return view;
}
