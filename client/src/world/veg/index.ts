// Vegetation area — palms, jungle trees, mangroves, bamboo, banana / monstera / ferns / flowers, grass, logs.
// Procedural geometry + pre-painted textures (species/*, tex.ts), one patched material recipe with wind and
// translucency (foliage-material.ts), deterministic island-wide scatter shared with the server
// (shared/world/veg-scatter.ts), instanced LOD tiers + hemi-octahedral impostors (lod.ts, impostor.ts).
// Publishes ctx.shared "veg" (VegApi: plant(kind, transforms)) and "vegInstances" (the scatter result).
// Dev: ?vegcol=1 draws the trunk colliders (shared/world/veg-scatter.ts vegTrunkColliders) around the camera.
import * as THREE from "three";
import type { WorldModule } from "../module";
import type { WorldCtx } from "../../engine/engine";
import type { CamSpec } from "../../engine/views";
import type { VegApi, PlantKind, VegQuality, VegQualityState, VegQualityInput } from "./api";
import { VEG_UNIFORMS, VEG_LIGHT } from "./foliage-material";
import { buildPalm } from "./species/palm";
import { buildJungleTree, buildBush, buildMangrove, buildVine } from "./species/canopy";
import { buildBanana, buildMonstera, buildFern, buildFlowers } from "./species/understory";
import { buildGrass, buildBamboo, buildLog, buildGroundcover, buildLitter } from "./species/ground";
import { initVegTextures, vegTexturesReady } from "./tex";
import { buildStudio, STUDIO_VIEWS } from "./studio";
import type { Species } from "./species/types";
import { SpeciesPool, DetailPool, ImpostorSet, PartGroup, buildPartGroups, VEG_DBG, frustumPlanes, LOD_STATS } from "./lod";
import { IMP_LIGHT, IMP_GRADE, calibrateImpostorLight } from "./impostor";
import { SplatSet, VEG_SPLAT, VEG_SPLAT_SMALL, SPLAT_LEVELS_SMALL } from "./splat";
import { DetailGen, Tinter, CanopyGrid, encodeOcc, hash01, DETAIL_ALIAS, type GenCell } from "./detail-gen";
import { scatterVegetation, loadSpawnMask, spawnMaskBytes, spawnMaskAt, rootSeatY, COLLIDABLE, vegTrunkColliders, nearestRoad, RockIndex, BoxIndex, VARIANTS, DETAIL_CELL, JUNGLE_VIEW, BEACH_VIEW, BEACH_HUMMOCK, placeRelative, type VegKind, type VegInstance, type Clearing, type ScatterEnv } from "../../../../shared/world/veg-scatter";
import { approachLeafHeight } from "../../../../shared/world/veg-landscape";
import { terrainRocks, type RockInstance } from "../../../../shared/world/terrain-gen";
import { terrainData } from "../terrain/load";
import { allClearings, allColliders } from "../../../../shared/pois/index";
import { Biome } from "../../../../shared/world/map";
import { flag } from "../../flags";

const DETAIL_RANGE = 62;
/** max detail cells in flight to the worker */
const MAX_INFLIGHT = 24;

const BUILDERS: Record<VegKind, (v: number) => Species> = {
  palm: (v) => buildPalm({ variant: v }),
  "palm-leaning": (v) => buildPalm({ variant: v, leaning: true }),
  "jungle-tree": buildJungleTree,
  bush: buildBush,
  mangrove: buildMangrove,
  "banana-plant": buildBanana,
  monstera: buildMonstera,
  fern: buildFern,
  flowers: buildFlowers,
  grass: buildGrass,
  bamboo: buildBamboo,
  log: buildLog,
  groundcover: buildGroundcover,
  vine: buildVine,
  litter: buildLitter,
};

/** initial LOD buffer capacities per variant pool (they grow if a view needs more) */
const CAPS: Partial<Record<VegKind, { cap0: number; cap1: number }>> = {
  "jungle-tree": { cap0: 64, cap1: 400 }, palm: { cap0: 64, cap1: 400 }, "palm-leaning": { cap0: 48, cap1: 200 },
  bush: { cap0: 128, cap1: 900 }, monstera: { cap0: 128, cap1: 700 }, "banana-plant": { cap0: 96, cap1: 500 },
  bamboo: { cap0: 32, cap1: 128 }, mangrove: { cap0: 64, cap1: 400 }, log: { cap0: 32, cap1: 96 }, vine: { cap0: 32, cap1: 160 }, litter: { cap0: 48, cap1: 160 },
  grass: { cap0: 4000, cap1: 9000 }, fern: { cap0: 600, cap1: 1500 }, flowers: { cap0: 600, cap1: 1500 }, groundcover: { cap0: 1500, cap1: 3500 },
};

/** kinds whose variant pools share draws (lod.ts PartGroup) — palm + palm-leaning use the same bark / frond / nut materials */
const FAMILY_OF: Partial<Record<VegKind, string>> = { "palm-leaning": "palm" };
/** a family: variant pools refreshed together + the part groups that draw them */
interface Family { pools: SpeciesPool[]; groups: PartGroup[] }

interface DetailBlock { pool: DetailPool; mats: Float32Array; cols: Float32Array; n: number; thin: boolean; /** density-tier count (setQuality) */ detailN?: number }
/** born: when a STREAMED cell landed (performance.now(); the first synchronous fill has none) — its plants grow in over
 * DETAIL_GROW ms (ground-cover cells arriving after a stall must not appear at full scale 25–34 m in view) */
interface DetailCellEntry { cx: number; cz: number; y0: number; y1: number; blocks: DetailBlock[]; born?: number }
const DETAIL_GROW = 650;

const cellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

class VegSystem implements VegApi {
  species = new Map<string, Species>();
  pools = new Map<string, SpeciesPool>();
  poolList: SpeciesPool[] = [];
  families: Family[] = [];
  detail = new Map<string, DetailPool>();
  cells = new Map<number, DetailCellEntry>();
  pending = new Set<number>();
  clearings: Clearing[] = [];
  env: ScatterEnv = {};
  tinter: Tinter;
  canopy = new CanopyGrid();
  gen: DetailGen | null = null;
  worker: Worker | null = null;
  instances: VegInstance[] = [];
  lastCam = new THREE.Vector3(Infinity, Infinity, Infinity);
  lastQuat = new THREE.Quaternion();
  lastDetailCam = new THREE.Vector3(Infinity, Infinity, Infinity);
  lastDetailQuat = new THREE.Quaternion();
  lastRefresh = -1;
  /** the camera each family third was last selected with (urgent full refresh when the view left its margin) */
  famQuat = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
  famPos = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  lastDetailRefresh = -1;
  bigPending = 0;       // bits 1 / 2 / 4 = the family thirds still to refresh
  frame = 0;
  cellsArrived = false;
  /** the first detail fill is done (cells streamed in after it grow in — DETAIL_GROW) */
  private detailFilled = false;
  /** some visible detail cell is still growing in: refresh the ring every frame until it is done */
  private detailGrowing = false;
  frustum = new THREE.Frustum();
  planes = new Float32Array(24);
  cullCam: THREE.PerspectiveCamera;
  ring: Array<[number, number, number]> = [];
  stats: Record<string, unknown> = {};
  texReady = false;
  releaseImp: (() => void) | null = null;
  impostors: ImpostorSet;
  /** the big plants' far tier as gaussian splats (splat.ts); ?vegsplat=0 = impostor cards */
  splats: SplatSet;
  /** … and the understory bank's (bushes, monstera, banana, heliconia); ?vegsplatsmall=0 = their impostor cards */
  splatsSmall: SplatSet;
  lastImpRefresh = 0;
  colDbg: THREE.LineSegments | null = null;
  colDbgAt = new THREE.Vector3(Infinity, 0, Infinity);
  /** update() timing (ms): last, max, and per-phase max since reset — __kr.veg.timing */
  timing = { last: 0, max: 0, n: 0, sum: 0, stream: 0, big: 0, detail: 0, cull: 0, impRefresh: 0 };
  readonly t0 = performance.now();
  /** the shared foliage uniforms (live look tuning from the console / tools: __kr.veg.U.uGrade …) */
  readonly U = VEG_UNIFORMS;
  readonly L = VEG_LIGHT;
  readonly lodStats = LOD_STATS;
  /** far canopy grade (impostor.ts IMP_GRADE) — live tuning */
  readonly impGrade = IMP_GRADE.uImpGrade.value;
  readonly impSplit = IMP_GRADE.uImpSplit.value;
  readonly impLit = IMP_GRADE.uImpLit.value;

  constructor(readonly ctx: WorldCtx) {
    this.cullCam = new THREE.PerspectiveCamera(90, 1, 0.1, 5000);
    this.impostors = new ImpostorSet(ctx.scene);
    this.impostors.roadAt = (x, z) => nearestRoad(ctx.terrain, x, z);
    this.splats = new SplatSet(ctx.scene);
    this.splats.roadAt = (x, z) => nearestRoad(ctx.terrain, x, z);
    this.splats.atmos = () => ctx.shared.get("atmos") as { uniforms?: Record<string, THREE.IUniform>; glsl?: string } | undefined;
    this.splatsSmall = new SplatSet(ctx.scene, { name: "small", levels: SPLAT_LEVELS_SMALL, shadow: false });
    this.splatsSmall.roadAt = this.splats.roadAt; this.splatsSmall.atmos = this.splats.atmos;
    this.tinter = new Tinter(ctx.terrain);
    // detail ring: cell offsets within range, nearest first (generation priority)
    const n = Math.ceil(DETAIL_RANGE / DETAIL_CELL) + 1;
    for (let dz = -n; dz <= n; dz++) for (let dx = -n; dx <= n; dx++) {
      const d = Math.max(0, Math.hypot(dx, dz) - 1) * DETAIL_CELL;
      if (d <= DETAIL_RANGE) this.ring.push([dx, dz, d]);
    }
    this.ring.sort((a, b) => a[2] - b[2]);
  }

  pool(kind: VegKind, variant: number): SpeciesPool {
    const id = `${kind}:${variant}`;
    let p = this.pools.get(id);
    if (!p) {
      // (every pool is made up-front by makePools — a late one gets a family of its own)
      p = this.newPool(kind, variant);
      const groups = buildPartGroups([p], this.ctx.scene, CAPS[kind] ?? { cap0: 64, cap1: 400 });
      this.families.push({ pools: [p], groups });
    }
    return p;
  }

  private newPool(kind: VegKind, variant: number): SpeciesPool {
    const id = `${kind}:${variant}`;
    const p = new SpeciesPool(this.getSpecies(kind, variant), this.ctx.scene, { cap: 1024 });
    this.pools.set(id, p);
    this.poolList.push(p);
    return p;
  }

  /** every big-plant pool + its family's merged part groups (one draw per part + material across variants) */
  makePools() {
    const fam = new Map<string, { kinds: VegKind[]; pools: SpeciesPool[] }>();
    for (const kind of Object.keys(BUILDERS) as VegKind[]) {
      const f = FAMILY_OF[kind] ?? kind;
      let e = fam.get(f); if (!e) { e = { kinds: [], pools: [] }; fam.set(f, e); }
      e.kinds.push(kind);
      for (let v = 0; v < VARIANTS[kind]; v++) if (!this.pools.has(`${kind}:${v}`)) e.pools.push(this.newPool(kind, v));
    }
    for (const e of fam.values()) {
      if (!e.pools.length) continue;
      const c = CAPS[e.kinds[0]] ?? { cap0: 64, cap1: 400 };
      this.families.push({ pools: e.pools, groups: buildPartGroups(e.pools, this.ctx.scene, { cap0: c.cap0 * 2, cap1: c.cap1 * 2 }) });
    }
    this.stats.draws = this.families.reduce((a, f) => a + f.groups.length * 2, 0);
  }

  private detailPoolById(id: string): DetailPool {
    let p = this.detail.get(id);
    if (!p) {
      const [kind, v] = id.split(":") as [VegKind, string];
      const sp = this.getSpecies(kind, Number(v));
      p = new DetailPool(sp, this.ctx.scene, CAPS[kind] ?? { cap0: 1000, cap1: 3000 });
      this.detail.set(id, p);
    }
    return p;
  }

  getSpecies(kind: VegKind, variant: number): Species {
    const id = `${kind}:${variant}`;
    let sp = this.species.get(id);
    if (!sp) {
      sp = BUILDERS[kind](variant % VARIANTS[kind]);
      // a tier must never be SELECTED while its material's distance shrink already has it at > 0 size
      // (POIs plant ferns / grass / flowers into big pools through veg.plant: selected at 0.94 · lod1 = 32 m, the fern
      // shrink band ends at 34 m → they appeared at 20 % size) — the LOD1 reach covers every part's band
      let f1 = 0;
      for (const p of sp.parts) { const u = (p.mats.mat.userData.veg as { uFade?: { value: THREE.Vector4 } } | undefined)?.uFade?.value; if (u && u.y > f1) f1 = u.y; }
      if (f1 > 0 && sp.lod1 < f1 * 1.08 + 1) sp.lod1 = Math.ceil(f1 * 1.08 + 1);
      this.species.set(id, sp);
    }
    return sp;
  }

  private tintOf(kind: VegKind, x: number, z: number): [number, number, number] {
    const t = TMP3; this.tinter.tint(kind, x, z, t, 0); return [t[0], t[1], t[2]];
  }

  addInstance(p: VegInstance) {
    const t = this.tintOf(p.kind, p.x, p.z);
    const occ = this.canopy.occ(p.x, p.z, CanopyGrid.crown(p) ? p : undefined);
    this.pool(p.kind, p.variant % VARIANTS[p.kind]).add(p.x, p.y, p.z, p.yaw, p.scale, encodeOcc(t[0], occ), t[1], t[2]);
  }

  // ------------------------------------------------------------------------------------------ quality tiers
  /** the tier in effect (the settings menu calls setQuality; the default follows ctx.quality) */
  quality: VegQualityState = { tier: "high", dist: 1, density: 1, shadows: "all" };
  private baseLod = new Map<Species, [number, number]>();
  private baseFade = new Map<THREE.Vector4, [number, number]>();
  private baseCast = new Map<THREE.Object3D, boolean>();
  /** fraction of detail instances kept (refreshDetail) */
  detailDensity = 1;
  /** render-height factor on the tree LOD1 → impostor switch (setQuality; re-applied on a resize) */
  resK = 1;
  private resScale() { const h = this.ctx.renderer.domElement.height || 1440; return Math.min(1.5, Math.max(1, h / 1440)); }

  /**
   * VegApi.setQuality — live. `dist` scales every LOD / detail distance and every material shrink band together (the
   * pop-free invariants hold at any scale); `density` thins the small plants in rank order (the survivors' shrink bands
   * are untouched: no pop); shadow casting per tier. Trees / palms / bushes keep their impostors to the horizon.
   */
  setQuality(input: VegQuality | VegQualityInput): VegQualityState {
    const T: Record<VegQuality, VegQualityState> = {
      epic: { tier: "epic", dist: 1.15, density: 1, shadows: "all" },
      high: { tier: "high", dist: 1, density: 1, shadows: "all" },
      medium: { tier: "medium", dist: 0.8, density: 0.7, shadows: "trees" },
      low: { tier: "low", dist: 0.62, density: 0.45, shadows: "none" },
    };
    // the settings may send ONE tier string or an object { density|foliage, distance|viewDist } — never fall
    // back to HIGH silently for an object
    const norm = (v: unknown): VegQuality | undefined => {
      const s = String(v ?? "").toLowerCase();
      return s === "ultra" ? "epic" : (s in T ? s as VegQuality : undefined);
    };
    let q: VegQualityState;
    if (typeof input === "string" || !input) q = { ...(T[norm(input) ?? "high"]) };
    else {
      const dens = input.density ?? input.foliage, dist = input.distance ?? input.viewDist;
      const dt = typeof dens === "number" ? undefined : norm(dens), vt = typeof dist === "number" ? undefined : norm(dist);
      const base = T[dt ?? vt ?? "high"];
      q = { ...base };
      if (typeof dens === "number") q.density = Math.max(0.1, Math.min(1, dens));
      if (typeof dist === "number") q.dist = Math.max(0.4, Math.min(1.5, dist));
      else if (vt) q.dist = T[vt].dist;
    }
    // (the tree impostors' 256 px views are ~1 texel per pixel at the switch only when the
    // switch moves out with the render height — 1440 p: 1×, 2160 p: 1.5×; the LOD0 → LOD1 switch is unchanged)
    this.resK = this.resScale();
    for (const sp of this.species.values()) {
      if (!this.baseLod.has(sp)) this.baseLod.set(sp, [sp.lod0, sp.lod1]);
      const [l0, l1] = this.baseLod.get(sp)!;
      // (detail pools draw from a fixed 62 m cell ring: their reach never exceeds it)
      sp.lod0 = l0 * q.dist; sp.lod1 = l1 * q.dist * (sp.impostor && sp.height > 6 ? this.resK : 1);
      for (const part of sp.parts) {
        const u = (part.mats.mat.userData.veg as { uFade?: { value: THREE.Vector4 } } | undefined)?.uFade?.value;
        if (!u || u.y <= 0) continue;
        if (!this.baseFade.has(u)) this.baseFade.set(u, [u.x, u.y]);
        const [f0, f1] = this.baseFade.get(u)!;
        u.x = f0 * q.dist; u.y = f1 * q.dist;
      }
    }
    for (const p of this.detail.values()) { const u = (p.sp.parts[0].mats.mat.userData.veg as { uFade: { value: THREE.Vector4 } }).uFade.value; p.fade = [u.x, u.y]; }
    this.detailDensity = q.density;
    for (const c of this.cells.values()) for (const b of c.blocks) b.detailN = Math.ceil(b.n * q.density);
    this.impostors.underFar = 330 * q.dist;
    if (this.splatsSmall) this.splatsSmall.underFar = this.impostors.underFar;
    // splats per px² of a plant's screen size by tier (the far tier's GPU cost; low / medium switch to splats nearer)
    { const d = { epic: 1, high: 1, medium: 0.75, low: 0.5 }[q.tier] ?? 1; this.splats?.setDensityK(d); this.splatsSmall?.setDensityK(d); }
    // shadow casters: every veg mesh that casts at build keeps its flag in baseCast
    const TREES = /^veg:(jungle-tree|palm|palm-leaning|mangrove|bamboo)[:|]/;
    this.ctx.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !/^veg:/.test(o.name) || /impostor/.test(o.name)) return;
      if (!this.baseCast.has(o)) this.baseCast.set(o, m.castShadow);
      const base = this.baseCast.get(o)!;
      m.castShadow = base && (q.shadows === "all" || (q.shadows === "trees" && TREES.test(o.name)));
      m.userData.castShadow = m.castShadow;
    });
    this.quality = q;
    this.lastRefresh = -1; this.lastDetailRefresh = -1; this.bigPending = 7;
    return q;
  }

  /** every POI planting (veg.plant), kept so tools can attribute them to their POI owner */
  planted: VegInstance[] = [];
  /** POI foliage with gameplay cover boxes (authored banana pseudostems) — the approach-leaf clamp leaves them alone */
  private solidLeafIndex: BoxIndex | undefined;
  /** POI plantings the spawn mask lifted / dropped, and the trunk / banana ones reported to their owner */
  plantMask = { dropped: 0, issues: [] as Array<{ kind: string; x: number; y: number; z: number; what: string }> };
  /** POI-planted buttress trees sunk onto their roots: [x, z, metres] */
  rootSink: Array<[number, number, number]> = [];
  /** VegApi: POIs dress their grounds with the same plants */
  plant(kind: PlantKind, transforms: THREE.Matrix4[]) {
    if (this.ctx.rebuilding) return;
    const k = kind as VegKind;
    if (!(k in BUILDERS)) { console.warn(`veg.plant: unknown kind ${kind}`); return; }
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), fwd = new THREE.Vector3();
    for (const m of transforms) {
      m.decompose(pos, q, s);
      fwd.set(1, 0, 0).applyQuaternion(q);
      const yaw = Math.atan2(-fwd.z, fwd.x);
      let variant = Math.floor(hash01(pos.x + 3.1, pos.z + 1.7) * VARIANTS[k]);
      if (k === "palm" && variant === 2 && this.ctx.terrain.biomeAt(pos.x, pos.z) !== Biome.Grass) variant = 0; // orange palm = highlands only
      const t = this.tintOf(k, pos.x, pos.z);
      // (POI plantings under DRAWN water or under a drawn POI / rock
      // surface — the spawn mask. Decorative kinds with no POI collider are dropped (buried under a skin / slab, in a
      // rock flank, under water); trunks and bananas (POI owners give them bullet boxes) are only reported to the owner)
      const mk = spawnMaskAt(this.ctx.terrain, pos.x, pos.z);
      if (mk) {
        const wet = k !== "mangrove" && mk[0] > pos.y + 0.05, top = mk[1] - pos.y, hi = mk[2] - pos.y;   // (NaN compares false)
        const soft = !COLLIDABLE.has(k) && k !== "banana-plant";
        if (wet || (top > 0.3 && top < 6) || (!(top > 0.3) && hi > 0.4 && hi < 6)) {
          if (soft) { this.plantMask.dropped++; continue; }
          else this.plantMask.issues.push({ kind: k, x: +pos.x.toFixed(1), y: +pos.y.toFixed(2), z: +pos.z.toFixed(1), what: wet ? `${(mk[0] - pos.y).toFixed(2)} m under drawn water` : `drawn surface ${(top > 0.3 ? top : hi).toFixed(2)} m over the base` });
        }
      }
      // (ferns / grass stay small plants — they fade by scale at ~38 m; a POI planting ≥ 1 m tall would shrink
      // out in view: clamp to 0.98 m)
      if (k === "fern" || k === "grass") { const h = this.getSpecies(k, variant).height; if (h * s.x >= 0.98) s.x = 0.97 / h; }
      // ground-rooted POI leaves near a dirt road obey the
      // same readability rule as the scatter's understory: at most knee-high (0.75 m) within 12 m of the road edge, the
      // cap rising to 3 m at 24 m (veg-landscape approachLeafHeight). Raised pots keep their size; plants that carry a cover
      // box (some authored banana pseudostems) are left alone so the drawn leaves keep matching the server's cover.
      if ((k === "bush" || k === "monstera" || k === "banana-plant") && pos.y <= this.ctx.terrain.height(pos.x, pos.z) + 0.4) {
        const road = nearestRoad(this.ctx.terrain, pos.x, pos.z).d;
        if (road < 24) {
          this.solidLeafIndex ??= new BoxIndex(allColliders().filter((b) => b.surf === "foliage"));
          if (!this.solidLeafIndex.hits(pos.x, pos.y + 0.1, pos.y + 3, pos.z, 0.1))
            s.x = Math.min(s.x, approachLeafHeight(road) / this.getSpecies(k, variant).height);
        }
      }
      // a buttress tree planted on the ground sinks until no root / trunk foot hangs in the air on a slope
      // (the scatter's seatPlant does the same: shared rootSeatY). Trees on decks / rock tops (base ≥ 0.6 m over the terrain)
      // keep their POI-given height. rootSink = how far it went (tools: __kr veg.rootSink)
      if (k === "jungle-tree") {
        const g = this.ctx.terrain.height(pos.x, pos.z);
        if (pos.y < g + 0.6) { const ys = rootSeatY(this.ctx.terrain, variant, pos.x, pos.z, yaw, s.x); if (ys < pos.y) { this.rootSink.push([+pos.x.toFixed(1), +pos.z.toFixed(1), +(pos.y - ys).toFixed(2)]); pos.y = ys; } }
      }
      const inst: VegInstance = { kind: k, variant, x: pos.x, y: pos.y, z: pos.z, yaw, scale: s.x };
      this.planted.push(inst);
      const occ = this.canopy.occ(pos.x, pos.z, CanopyGrid.crown(inst) ? inst : undefined);
      this.pool(k, variant).add(pos.x, pos.y, pos.z, yaw, s.x, encodeOcc(t[0], occ), t[1], t[2]);
    }
  }

  /** start the island scatter in a worker (the main thread builds species / pools meanwhile) */
  private scatterJob: Promise<VegInstance[]> | null = null;
  private rocks: RockInstance[] | undefined;
  startScatter() {
    const t0 = performance.now();
    this.clearings = (allClearings() as unknown[]).filter((c): c is Clearing => !!c && typeof c === "object" && "x" in c);
    try {
      const td = terrainData();
      this.rocks = terrainRocks(td);
      this.env = { rocks: new RockIndex(this.rocks), path: td.path, pathRes: td.res };
    } catch (e) { console.warn("veg: terrain data / rocks unavailable, scattering without them", e); }
    this.stats.rocksMs = Math.round(performance.now() - t0);
    const sync = () => scatterVegetation(this.ctx.terrain, this.clearings, undefined, this.env.rocks);
    if (typeof Worker === "undefined" || flag("vegsyncscatter")) { this.scatterJob = loadSpawnMask().then(sync); return; }
    this.scatterJob = loadSpawnMask().then(() => new Promise<VegInstance[]>((res) => {
      let w: Worker;
      try { w = new Worker(new URL("./scatter-worker.ts", import.meta.url), { type: "module" }); }
      catch (e) { console.warn("veg: no scatter worker, scattering on the main thread", e); res(sync()); return; }
      const T = this.ctx.terrain;
      w.onmessage = (e: MessageEvent<{ ok: boolean; list?: VegInstance[]; ms?: number; error?: string }>) => {
        w.terminate();
        if (e.data.ok && e.data.list) { this.stats.scatterWorkerMs = Math.round(e.data.ms ?? 0); res(e.data.list); }
        else { console.warn("veg: scatter worker failed, scattering on the main thread", e.data.error); res(sync()); }
      };
      w.onerror = (e) => { w.terminate(); console.warn("veg: scatter worker error, scattering on the main thread", e.message); res(sync()); };
      w.postMessage({ heights: T.heights, biome: T.biome, clearings: this.clearings, rocks: this.rocks, mask: spawnMaskBytes() });
    }));
  }

  async scatter() {
    const t0 = performance.now();
    if (!this.scatterJob) this.startScatter();
    const rocks = this.rocks;
    this.instances = await this.scatterJob!;
    this.stats.scatterWaitMs = Math.round(performance.now() - t0);
    const ctx = this.ctx, CH = 2500;
    for (let i = 0; i < this.instances.length; i += CH) { for (const p of this.instances.slice(i, i + CH)) this.canopy.add(p); await ctx.yield(); }
    for (let i = 0; i < this.instances.length; i += CH) { for (const p of this.instances.slice(i, i + CH)) this.addInstance(p); await ctx.yield(); }
    const counts: Record<string, number> = {};
    for (const p of this.instances) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
    this.stats.scatterMs = Math.round(performance.now() - t0);
    this.stats.counts = counts;
    this.gen = new DetailGen(this.ctx.terrain, this.clearings, this.env, this.canopy);
    // the next frame fills the detail ring synchronously (nothing streams in around the camera after the scatter lands)
    this.lastDetailRefresh = -1; this.bigPending = 7;
    // every detail pool exists (and compiles) up-front: a new species variant streaming in later never hitches
    for (const k of ["grass", "flowers", "fern", "groundcover"] as VegKind[]) for (let v = 0; v < VARIANTS[k]; v++) if (!DETAIL_ALIAS[`${k}:${v}`]) this.detailPoolById(`${k}:${v}`);
    // detail worker (streaming while playing); view-camera screenshots generate synchronously for determinism
    if (typeof Worker !== "undefined") {
      try {
        const w = new Worker(new URL("./detail-worker.ts", import.meta.url), { type: "module" });
        const T = this.ctx.terrain;
        w.postMessage({ type: "init", heights: T.heights, biome: T.biome, clearings: this.clearings, rocks, path: this.env.path, pathRes: this.env.pathRes, canopy: this.canopy.cov, mask: spawnMaskBytes() });
        w.onmessage = (e: MessageEvent<GenCell>) => this.acceptCell(e.data);
        w.onerror = (e) => { console.warn("veg: detail worker failed, generating on the main thread", e.message); this.worker = null; this.pending.clear(); };
        this.worker = w;
      } catch (e) { console.warn("veg: no detail worker", e); }
    }
  }

  /**
   * The beach view camera is SOLVED by the water area on the live terrain; the shared dressing (BEACH_VIEW) mirrors
   * its current answer. If the solver moved (terrain edits), warn and re-place the decorative hummock (no colliders:
   * client-only is exact) in front of the live camera so the view never loses its foreground.
   */
  async beachDressing() {
    if (flag("view") !== "biome-01-beach") return;
    try {
      const water = (await import("../water/index")).default as { views?: Record<string, CamSpec> };
      const v = water.views?.["biome-01-beach"];
      if (!v || v.rel) return;
      const d = Math.hypot(v.pos[0] - BEACH_VIEW.x, v.pos[2] - BEACH_VIEW.z);
      this.stats.beachViewDrift = Math.round(d * 10) / 10;
      if (d < 4) return;
      console.warn(`veg: the solved beach camera moved ${d.toFixed(0)} m from BEACH_VIEW (shared/world/veg-scatter.ts) — update it: ${v.pos[0]}, ${v.pos[2]} → ${v.target[0]}, ${v.target[2]}`);
      const T = this.ctx.terrain;
      for (const p of placeRelative({ x: v.pos[0], z: v.pos[2], tx: v.target[0], tz: v.target[2] }, BEACH_HUMMOCK)) {
        const b = T.biomeAt(p.x, p.z);
        if (b === Biome.DeepOcean || b === Biome.Reef || b === Biome.Path || b === Biome.Paved || T.height(p.x, p.z) < 0.3) continue;
        this.addInstance({ kind: p.kind, variant: p.variant, x: p.x, y: T.height(p.x, p.z), z: p.z, yaw: p.yaw, scale: p.scale });
      }
    } catch (e) { console.warn("veg: beach dressing check failed", e); }
  }

  // ---------------------------------------------------------------------------------------------------- detail layer

  private acceptCell(c: GenCell) {
    const key = cellKey(c.cx, c.cz);
    this.pending.delete(key);
    const blocks: DetailBlock[] = c.blocks.map((b) => ({ pool: this.detailPoolById(b.id), mats: b.mats, cols: b.cols, n: b.n, thin: b.kind === "grass" }));
    for (const b of blocks) b.detailN = Math.ceil(b.n * this.detailDensity);
    this.cells.set(key, { cx: c.cx, cz: c.cz, y0: c.y0, y1: c.y1, blocks, born: this.detailFilled ? performance.now() : undefined });
    this.cellsArrived = true;
  }

  /** request missing ring cells (nearest first): from the worker, or synchronously (shots, first fill, no worker) */
  private streamCells(cam: THREE.Vector3, sync: boolean) {
    if (!this.gen) return;                               // the scatter (worker) has not landed yet
    const ccx = Math.floor(cam.x / DETAIL_CELL), ccz = Math.floor(cam.z / DETAIL_CELL);
    let asked = 0;
    for (const [dx, dz] of this.ring) {
      const cx = ccx + dx, cz = ccz + dz, key = cellKey(cx, cz);
      if (this.cells.has(key) || this.pending.has(key)) continue;
      if (sync || !this.worker) {
        if (!sync && asked > 0) break;                 // no worker: one cell per frame
        this.acceptCell(this.gen!.cell(cx, cz));
      } else {
        if (this.pending.size >= MAX_INFLIGHT) break;
        this.pending.add(key);
        this.worker.postMessage({ type: "cell", cx, cz });
      }
      asked++;
    }
    // evict far cells (cheap: only when the cache has grown well past the ring)
    if (this.cells.size > this.ring.length * 1.7) {
      const lim = (DETAIL_RANGE + 80) / DETAIL_CELL;
      for (const [k, c] of this.cells) if (Math.max(Math.abs(c.cx - ccx), Math.abs(c.cz - ccz)) > lim) this.cells.delete(k);
    }
  }

  /** copy the visible ring cells' blocks into the detail pools (no allocation, no re-adding). Depth-writing pools get
   * their cells near → far (early-z), the lawn (no depth write) far → near */
  private visCells: Array<[DetailCellEntry, number]> = [];
  private refreshDetail(cam: THREE.Vector3) {
    for (const p of this.detail.values()) p.begin();
    const ccx = Math.floor(cam.x / DETAIL_CELL), ccz = Math.floor(cam.z / DETAIL_CELL);
    const bx = BOX;
    const vis = this.visCells; vis.length = 0;
    for (const [dx, dz] of this.ring) {
      const cx = ccx + dx, cz = ccz + dz;
      const c = this.cells.get(cellKey(cx, cz));
      if (!c || !c.blocks.length) continue;
      const x0 = cx * DETAIL_CELL, z0 = cz * DETAIL_CELL;
      const nx = Math.max(x0, Math.min(cam.x, x0 + DETAIL_CELL)) - cam.x, nz = Math.max(z0, Math.min(cam.z, z0 + DETAIL_CELL)) - cam.z;
      const dmin = Math.sqrt(nx * nx + nz * nz);
      if (dmin > DETAIL_RANGE) continue;
      if (dmin > 12) {
        bx.min.set(x0 - 1.5, c.y0 - 0.5, z0 - 1.5); bx.max.set(x0 + DETAIL_CELL + 1.5, c.y1 + 0.5, z0 + DETAIL_CELL + 1.5);
        if (!this.frustum.intersectsBox(bx)) continue;
      }
      vis.push([c, dmin]);
    }
    const now = performance.now();
    let growing = false;
    const push = (c: DetailCellEntry, dmin: number, noDepth: boolean) => {
      let k = 1;
      if (c.born !== undefined) { const a = (now - c.born) / DETAIL_GROW; if (a < 1) { k = a <= 0 ? 0 : a * a * (3 - 2 * a); growing = true; } else c.born = undefined; }
      for (const b of c.blocks) {
        if (b.pool.noDepth !== noDepth) continue;
        const sp = b.pool.sp;
        if (dmin > sp.lod1) continue;
        // thinning in rank order: the shader shrinks each instance away by ITS distance (rank → distance in the
        // material's uFade band, foliage-material V_WIND), so dropping the tail here never pops a visible plant
        let n = b.detailN ?? b.n;
        const [f0, f1] = b.pool.fade;
        // (the same rank → distance map as the shader — foliage-material V_WIND: scale band W >= 10 m)
        const span = Math.max(0, f1 - f0 - Math.max(10, (f1 - f0) * 0.3));
        if (f1 > 0 && dmin > f1 - span) n = span > 0 ? Math.ceil(n * Math.max(0, Math.min(1, (f1 - dmin) / span))) : dmin < f1 ? n : 0;
        if (n > 0) b.pool.push(dmin < sp.lod0 ? 0 : 1, b.mats, b.cols, n, dmin, k);
      }
    };
    for (let i = 0; i < vis.length; i++) push(vis[i][0], vis[i][1], false);
    for (let i = vis.length - 1; i >= 0; i--) push(vis[i][0], vis[i][1], true);
    for (const p of this.detail.values()) p.end();
    this.stats.detailCells = vis.length;
    this.detailGrowing = growing;
    this.detailFilled = true;
  }

  // ---------------------------------------------------------------------------------------------------- per frame

  private updateFrustum(cam: THREE.PerspectiveCamera, widen: number) {
    // widened frustum for culling (shadow casters just outside the view + a few degrees of turn still count)
    cam.updateMatrixWorld();
    this.cullCam.fov = Math.min(150, cam.fov + widen); this.cullCam.aspect = cam.aspect; this.cullCam.near = 0.1; this.cullCam.far = 6000;
    this.cullCam.updateProjectionMatrix();
    this.cullCam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    this.frustum.setFromProjectionMatrix(M4.multiplyMatrices(this.cullCam.projectionMatrix, this.cullCam.matrixWorldInverse));
    frustumPlanes(this.frustum, this.planes);
  }

  /**
   * Per frame (budget ≤ 0.5 ms): at most ONE of the refresh jobs runs — big pools group A, big pools group B, or the
   * detail ring — so a sprint + mouse-look never stacks them; detail cells are generated by the worker.
   */
  update(_dt: number, time: number) {
    const t0 = performance.now();
    const cam = this.ctx.camera;
    this.frame++;
    this.assertVisible();
    // window resize → the tree impostor switch follows the render height (setQuality resK)
    if (this.frame % 60 === 0) {
      const rk = this.resScale();
      if (Math.abs(rk - this.resK) > 0.04) {
        this.resK = rk;
        for (const sp of this.species.values()) { const b = this.baseLod.get(sp); if (b && sp.impostor && sp.height > 6) sp.lod1 = b[1] * this.quality.dist * rk; }
        this.lastRefresh = -1; this.bigPending = 7;
      }
    }
    VEG_UNIFORMS.uTime.value = time;
    // the terrain's albedo bake for the grass roots (published by the terrain module once baked)
    const terrainAlbedo = this.ctx.shared.get("terrainAlbedoMap") as THREE.Texture | undefined;
    VEG_UNIFORMS.uTerrainAlbedo.value = terrainAlbedo ?? null;
    VEG_UNIFORMS.uTerrainAlbedoOn.value = terrainAlbedo ? 1 : 0;
    // LOD crossfade clock (real seconds since the veg module started; shots switch LODs instantly)
    const fadeNow = (performance.now() - this.t0) / 1000;
    VEG_UNIFORMS.uFadeNow.value = fadeNow;
    VEG_UNIFORMS.uCamPos.value.copy(cam.position);
    { const at = (this.ctx.shared.get("atmos") as { uniforms?: { uAtmTemporal?: { value: THREE.Vector2 } } } | undefined)?.uniforms?.uAtmTemporal?.value; if (at) VEG_UNIFORMS.uVegTemporal.value.copy(at); }
    const sd = this.ctx.shared.get("sunDir") as THREE.Vector3 | undefined;
    if (sd) VEG_UNIFORMS.uSunDir.value.copy(sd);
    const sun = this.ctx.shared.get("sun") as THREE.DirectionalLight | undefined;
    if (sun?.color) IMP_LIGHT.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
    const gust = 0.5 + 0.25 * Math.sin(time * 0.23) + 0.15 * Math.sin(time * 0.71 + 1);
    VEG_UNIFORMS.uWind.value.set(0.8, gust, 0.6);

    const now = performance.now();
    const first = this.lastDetailRefresh < 0;
    const sync = first || this.ctx.shotMode;
    const ts = performance.now();
    if (!VEG_DBG.has("nodetail")) this.streamCells(cam.position, sync);
    this.timing.stream = Math.max(this.timing.stream, performance.now() - ts);

    const moved = cam.position.distanceTo(this.lastCam) > 2.5;
    const turned = Math.abs(cam.quaternion.dot(this.lastQuat)) < 0.9986;
    const impWork = this.texReady && !!this.releaseImp;
    if (moved || turned || impWork || now - this.lastRefresh > 500 || this.lastRefresh < 0) {
      this.lastCam.copy(cam.position); this.lastQuat.copy(cam.quaternion); this.lastRefresh = now;
      this.bigPending = 7;
    }
    // the detail ring is culled with an extra-wide frustum, so it only needs a refresh every 1.5 m or ~12° of turn
    const dirty = !VEG_DBG.has("nodetail") && (cam.position.distanceTo(this.lastDetailCam) > 1.5 || Math.abs(cam.quaternion.dot(this.lastDetailQuat)) < 0.9945 || this.cellsArrived || this.detailGrowing || now - this.lastDetailRefresh > 700 || first);
    // a family third selected with a frustum that no longer covers the view
    // (a flick turn beyond the 22° widening margin, or a jump) would leave its trees undrawn for 1–3 frames — every third
    // refreshes THIS frame instead (cos(7.5°) on the quaternion = a 15° turn)
    const urgent = this.famQuat.some((q, k) => Math.abs(cam.quaternion.dot(q)) < 0.9914 || cam.position.distanceTo(this.famPos[k]) > 2.5);
    if (urgent) this.bigPending = 7;
    const all = sync || impWork || urgent;
    if (this.bigPending || dirty) this.updateFrustum(cam, dirty && !this.bigPending ? 58 : 44);
    if (this.bigPending && (all || !dirty || this.frame % 3 !== 0)) {
      const tb = performance.now();
      if (impWork) {
        calibrateImpostorLight(this.ctx.renderer, this.ctx.scene, this.ctx.shared.get("sun") as THREE.DirectionalLight | undefined);
        // atlas resolution by tier (VRAM: tree bank ~16 layers × (albedo + normal) — 2048² ≈ 450 MB, 1536² ≈ 290 MB)
        const hiRes = this.quality.tier === "epic" || this.quality.tier === "high";
        this.impostors.atlas = hiRes ? { big: 2048, bigN: 1024, small: 1536, smallN: 768 } : { big: 1536, bigN: 1024, small: 1024, smallN: 512 };
        const SMALL = VEG_SPLAT && VEG_SPLAT_SMALL;
        this.impostors.build(this.ctx.renderer, this.poolList, !VEG_SPLAT ? "all" : SMALL ? "none" : "small");
        // (the impostor programs exist only now — let atmos patch the new materials (sun / cloud shadows, haze),
        // then compile them for the post chain's target before their first draw)
        (this.ctx.shared.get("atmos") as { sweep?: () => number } | undefined)?.sweep?.();
        void compileVeg(this.ctx, this.impostors.meshes, false).catch(() => {});
        const release = this.releaseImp!; this.releaseImp = null;
        if (!VEG_SPLAT) release();
        else {
          // the big plants' splats bake asynchronously (GPU capture + worker clustering); readiness
          // waits for them. A failed bake falls back to the impostor cards for the big plants.
          const big = this.poolList.filter((p) => p.sp.impostor && p.sp.height > 6);
          const small = this.poolList.filter((p) => p.sp.impostor && p.sp.height <= 6);
          this.splatsSmall.underFar = this.impostors.underFar;
          // (both banks bake at once: their cache lookups / captures / workers overlap)
          const smallJob = SMALL ? this.splatsSmall.build(this.ctx.renderer, small).catch((e) => {
            console.error("veg: understory splat bake failed — impostor cards for the understory", e);
            this.impostors.build(this.ctx.renderer, this.poolList, "small");
          }) : Promise.resolve();
          this.splats.build(this.ctx.renderer, big).then(() => smallJob).then(() => {
            // the static far map + canopy map take the splat trees' shadow copy
            (this.ctx.shared.get("atmos") as { sweep?: () => number; bakeShadows?: () => void } | undefined)?.bakeShadows?.();
            return compileVeg(this.ctx, [...this.splats.meshes, ...this.splatsSmall.meshes], true).catch(() => {});
          }).catch((e) => {
            console.error("veg: splat bake failed — impostor cards for the big plants", e);
            this.impostors.build(this.ctx.renderer, this.poolList, "big");
            (this.ctx.shared.get("atmos") as { sweep?: () => number } | undefined)?.sweep?.();
          }).finally(() => { this.lastRefresh = -1; this.bigPending = 7; release(); });
        }
      }
      // three thirds of the families on consecutive frames (the widened cull frustum hides the lag; halves peaked
      // at 1.3 ms on a sprint, thirds stay ≤ 1.5 ms); a family's pools select first, then its part
      // groups merge + copy the selections
      const part = all ? 7 : (this.bigPending & 1 ? 1 : this.bigPending & 2 ? 2 : 4);
      const L = this.families, a = Math.round(L.length / 3), b = Math.round((2 * L.length) / 3);
      const instant = this.ctx.shotMode;
      const run = (f: Family) => { for (const p of f.pools) p.update(cam.position, this.frustum, this.planes, fadeNow, instant); for (const g of f.groups) g.fill(); };
      if (part & 1) for (let i = 0; i < a; i++) run(L[i]);
      if (part & 2) for (let i = a; i < b; i++) run(L[i]);
      if (part & 4) for (let i = b; i < L.length; i++) run(L[i]);
      for (let k = 0; k < 3; k++) if (part & (1 << k)) { this.famQuat[k].copy(cam.quaternion); this.famPos[k].copy(cam.position); }
      this.bigPending &= ~part;
      this.timing.big = Math.max(this.timing.big, performance.now() - tb);
      if (!all) { this.finish(t0, cam.position); return; }
    }
    if (dirty) {
      this.lastDetailCam.copy(cam.position); this.lastDetailQuat.copy(cam.quaternion); this.lastDetailRefresh = now;
      this.cellsArrived = false;
      const td = performance.now();
      this.refreshDetail(cam.position);
      this.timing.detail = Math.max(this.timing.detail, performance.now() - td);
    }
    this.finish(t0, cam.position);
  }

  private finish(t0: number, cam: THREE.Vector3) {
    // impostor draw buffers: only the cells in a widened frustum (re-compacted when the view leaves the wedge)
    const tc = performance.now();
    this.impostors.cull(this.ctx.camera, tc, this.ctx.shotMode);
    const sceneHeight = this.ctx.getSceneHeight();
    this.splats.update(this.ctx.camera, tc, sceneHeight, this.ctx.shotMode);
    this.splatsSmall.update(this.ctx.camera, tc, sceneHeight, this.ctx.shotMode);
    this.timing.cull = Math.max(this.timing.cull, performance.now() - tc);
    if (this.colDbg || VEG_COL_DBG) this.updateColliderDebug(cam);
    // plants added after the bake (POIs planting late) join the impostor meshes — at most every 2 s
    if (this.impostors.built && performance.now() - this.lastImpRefresh > 2000) {
      const tr = performance.now();
      this.lastImpRefresh = tr; this.impostors.refresh(); this.splats.refresh(); this.splatsSmall.refresh();
      this.timing.impRefresh = Math.max(this.timing.impRefresh, performance.now() - tr);
    }
    if (this.frame % 30 === 1) this.stats.pools = this.poolStats();
    const ms = performance.now() - t0;
    this.timing.last = ms; this.timing.max = Math.max(this.timing.max, ms); this.timing.n++; this.timing.sum += ms;
  }

  /**
   * Guards against a veg mesh with count > 0 but visible = false (the floor layer missing from the frame):
   * a foreign save / restore of `visible` around an async step (shader prewarm, a bake) can
   * write a stale `false` back over a tier that has instances. lod.ts only re-derives `visible` on that tier's next
   * refresh (up to 0.7 s for the detail ring, longer for a tier whose selection does not change) — re-assert
   * `visible = count > 0` on every veg LOD mesh each frame (~100 meshes, no allocation).
   */
  private assertVisible() {
    const fix = (m: THREE.InstancedMesh) => {
      const v = m.count > 0; if (m.visible === v) return;
      m.visible = v;
      if (v) { this.visFixes.shown++; this.visFixes.by[m.name] = (this.visFixes.by[m.name] ?? 0) + 1; } else this.visFixes.emptied++;
    };
    for (const f of this.families) for (const g of f.groups) { for (const m of g.meshes.lod0) fix(m); for (const m of g.meshes.lod1) fix(m); }
    for (const p of this.detail.values()) { for (const m of p.meshes.lod0) fix(m); for (const m of p.meshes.lod1) fix(m); }
  }
  /** veg LOD meshes whose `visible` had been changed behind veg's back (assertVisible; tools): `shown` = had instances
   *  but was hidden (plants missing from the frame), `emptied` = empty but made visible (harmless), `by` = shown per mesh */
  visFixes = { shown: 0, emptied: 0, by: {} as Record<string, number> };

  /** A/B probe: switch the alpha-tested foliage between pre-pass + EQUAL colour (true) and one alpha-tested pass */
  setPrepass(on: boolean) {
    this.ctx.scene.traverse((o) => {
      const m = o as THREE.Mesh & { userData: { vegEq?: THREE.Material } };
      if (!m.isMesh || !/^veg:/.test(o.name)) return;
      if (/:pre$/.test(o.name)) { o.layers.mask = on ? 1 : 0; return; }
      const mat = m.material as THREE.Material & { vegSrc?: THREE.Material };
      if (!on && mat.vegSrc) { m.userData.vegEq = mat; m.material = mat.vegSrc; }
      else if (on && m.userData.vegEq) { m.material = m.userData.vegEq; delete m.userData.vegEq; }
    });
  }

  /** per-pool stats (for probes; computed on demand) */
  poolStats() {
    const st: Record<string, unknown> = {};
    for (const [k, p] of this.pools) st[k] = p.stats;
    for (const [k, p] of this.detail) st["detail:" + k] = p.stats;
    return st;
  }

  /** dev overlay (?vegcol=1): the trunk colliders the server uses, as wire boxes within 70 m of the camera */
  private updateColliderDebug(cam: THREE.Vector3) {
    if (this.colDbgAt.distanceTo(cam) < 15) return;
    this.colDbgAt.copy(cam);
    const near = this.instances.filter((p) => Math.hypot(p.x - cam.x, p.z - cam.z) < 70);
    const boxes = vegTrunkColliders(near);
    const pos: number[] = [];
    const E = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const b of boxes) {
      const cs: number[][] = [];
      for (let i = 0; i < 8; i++) cs.push([b.c[0] + (i & 1 ? 1 : -1) * b.h[0], b.c[1] + (i & 4 ? 1 : -1) * b.h[1], b.c[2] + (i & 2 ? 1 : -1) * b.h[2]]);
      for (const [a, c] of E) pos.push(...cs[a], ...cs[c]);
    }
    if (!this.colDbg) {
      this.colDbg = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff2a6a, depthTest: false, transparent: true, opacity: 0.9 }));
      this.colDbg.renderOrder = 999; this.colDbg.frustumCulled = false; this.colDbg.name = "veg:collider-debug";
      this.ctx.scene.add(this.colDbg);
    }
    this.colDbg.geometry.dispose();
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    this.colDbg.geometry = g;
    this.stats.colliderBoxesNear = boxes.length;
  }
}

const TMP3 = new Float32Array(3);
const BOX = new THREE.Box3();
const M4 = new THREE.Matrix4();
const VEG_COL_DBG = flag("vegcol");

const views: Record<string, CamSpec> = {
  ...STUDIO_VIEWS,
  // jungle interior on a trail (target art: banana + bunch front-left, buttress giant left, the trail running into a
  // bright opening, bamboo + monstera right, mossy log on the left path edge, bromeliads, canopy overhead)
  // (level with the target art: its trail vanishes at ~47 % of the height)
  "biome-02-jungle": { pos: [JUNGLE_VIEW.x, 1.45, JUNGLE_VIEW.z], target: [JUNGLE_VIEW.tx, 2.0, JUNGLE_VIEW.tz], fov: 62, rel: true, t: 12, stage: "jungle" /* atmos: staged sun ahead of the trail + denser forest air (god rays) */, note: "veg: jungle trail W of the temple, looking NE along the path (dressing: shared/world/veg-scatter.ts HAND_PLACED)" },
};

let system: VegSystem | null = null;

/** compile the programs of `objs` with the keys the frame really uses: the scene is drawn into the post chain's render
 * target (linear output, no tone mapping in the shader), so compile with an offscreen target bound (sync issue, async
 * wait — KHR_parallel_shader_compile) */
async function compileVeg(ctx: WorldCtx, objs: THREE.Object3D[], wait = true) {
  const holder = new THREE.Object3D();
  (holder as unknown as { children: THREE.Object3D[] }).children = objs;   // a view of the meshes (not re-parented)
  const R = ctx.renderer, rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }), prev = R.getRenderTarget();
  R.setRenderTarget(rt);
  let p: Promise<unknown> = Promise.resolve();
  try { p = R.compileAsync(holder, ctx.camera, ctx.scene); } finally { R.setRenderTarget(prev); }
  if (wait) await p; else p.catch(() => {});
  rt.dispose();
}

/**
 * The sun's shadow-DEPTH programs of every veg caster (compileAsync never makes them; the cascades draw only the casters
 * near the camera, so the first tree / litter tier to enter a cascade compiled one mid-play): one shadow-map render
 * with every caster tier forced on — an idle tier draws ONE instance with a zero (degenerate) matrix — then restored.
 *
 * (A bare depth render after the frame failed with "TypeError: Cannot read properties of null (reading
 * 'state') at renderBufferDirect" on every boot:
 * three r186 nulls the render state when render() returns, so it threw and NO foliage depth program was ever prewarmed —
 * the first tree to enter a sun cascade mid-match compiled on a live frame (a hitch / a late shadow pop-in). This one
 * runs INSIDE a scene render, like the engine's warmDraw: a private camera layer that holds only the scene's lights
 * (the render's setupLights gives the depth programs the light-state key the real cascade passes use; no colour draw at
 * all), then, from that render's onAfterRender, one depth draw of the forced tiers into a stand-in light's 16² map.
 * The sun's cascades are never drawn or touched.)
 */
function warmShadows(ctx: WorldCtx, objs: THREE.Object3D[]): number {
  const sun = ctx.shared.get("sun") as THREE.DirectionalLight | undefined;
  const r = ctx.renderer, sm = r.shadowMap, scene = ctx.scene;
  if (!sun?.castShadow || !sm.enabled) return 0;
  const LAYER = 31;   // (a private layer: 29 is atmos C1_LAYER — cascade-1 casters — and the prefab warm-up, 30 the engine warmDraw)
  const forced: Array<{ m: THREE.InstancedMesh; vis: boolean; n: number; mask: number; fc: boolean }> = [];
  for (const o of objs) {
    const m = o as THREE.InstancedMesh;
    if (!m.isInstancedMesh || !m.castShadow || (m.visible && m.count > 0) || /impostor/.test(m.name)) continue;
    forced.push({ m, vis: m.visible, n: m.count, mask: m.layers.mask, fc: m.frustumCulled });
    m.userData.vegWarm = true;   // (lod.ts: a LOD1 caster's near-instance limit is off for this one render)
    const a = m.instanceMatrix.array as Float32Array;
    a.fill(0, 0, 16);
    m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, 16); m.instanceMatrix.needsUpdate = true;
    m.count = 1; m.visible = true; m.frustumCulled = false;
  }
  if (!forced.length) return 0;
  const lights: THREE.Object3D[] = [];
  scene.traverse((o) => { if ((o as THREE.Light).isLight && !o.layers.isEnabled(LAYER)) { lights.push(o); o.layers.enable(LAYER); } });
  const cam = new THREE.PerspectiveCamera();
  cam.copy(ctx.camera, false); cam.layers.set(LAYER); cam.updateMatrixWorld(true);
  const L = new THREE.DirectionalLight(0xffffff, 0);
  L.castShadow = true; L.shadow.mapSize.set(16, 16); L.shadow.autoUpdate = true; L.updateMatrixWorld(true); L.target.updateMatrixWorld(true);
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  const prev = r.getRenderTarget(), au = sm.autoUpdate, nu = sm.needsUpdate, clear = new THREE.Color();
  const own = Object.prototype.hasOwnProperty.call(scene, "onAfterRender") ? scene.onAfterRender : undefined;
  const before = r.info.programs?.length ?? 0;
  let done = false, err: unknown = null;
  scene.onAfterRender = (...args: Parameters<THREE.Scene["onAfterRender"]>) => {
    own?.apply(scene, args);
    if (done || args[2] !== cam) return;
    done = true;
    for (const f of forced) f.m.layers.enable(LAYER);
    const ca = r.getClearAlpha(); r.getClearColor(clear);
    // (throwing here would leave three's render-state stack unpopped: keep it and report after)
    try { sm.needsUpdate = true; L.shadow.needsUpdate = true; sm.render([L], scene, cam); } catch (e) { err = e; }
    r.setClearColor(clear, ca);   // (the depth pass leaves a white clear colour behind)
  };
  sm.autoUpdate = false;
  try { r.setRenderTarget(rt); r.render(scene, cam); }
  finally {
    if (own) scene.onAfterRender = own; else delete (scene as { onAfterRender?: unknown }).onAfterRender;
    r.setRenderTarget(prev); sm.autoUpdate = au; sm.needsUpdate = nu; sun.shadow.needsUpdate = true;
    for (const l of lights) l.layers.disable(LAYER);
    for (const f of forced) { f.m.count = f.n; f.m.visible = f.vis; f.m.layers.mask = f.mask; f.m.frustumCulled = f.fc; delete f.m.userData.vegWarm; }
    L.shadow.map?.dispose(); L.dispose(); rt.dispose();
  }
  if (err) throw err;
  if (!done) throw new Error("the warm render never reached onAfterRender");
  return (r.info.programs?.length ?? 0) - before;
}

const mod: WorldModule = {
  id: "veg",
  views,
  async build(ctx: WorldCtx) {
    const t0 = performance.now();
    initVegTextures((l) => ctx.hold(l), ctx.renderer);
    system = new VegSystem(ctx);
    system.releaseImp = ctx.hold("veg-impostors");
    vegTexturesReady().then(() => { system!.texReady = true; });
    const kr = (window as unknown as { __kr?: Record<string, unknown> }).__kr;
    if (kr) kr.veg = system;
    // the island scatter runs in a worker meanwhile
    system.startScatter();
    // every species is built up-front (deterministic geometry) so the pools exist before POIs plant into them
    for (const kind of Object.keys(BUILDERS) as VegKind[]) {
      for (let v = 0; v < VARIANTS[kind]; v++) {
        try { system.getSpecies(kind, v); } catch (e) { console.error(`veg: species ${kind}:${v} failed`, e); }
      }
      await ctx.yield();
    }
    system.stats.speciesMs = Math.round(performance.now() - t0);
    system.makePools();
    await ctx.yield();
    // (the next modules build while the worker scatters; readiness is held until the island is planted)
    const releaseScatter = ctx.hold("veg-scatter");
    const scattered = system.scatter().then(() => system!.beachDressing()).catch((e) => console.error("veg: scatter failed", e)).finally(releaseScatter);
    if (ctx.shotMode) await scattered;
    // dev studio (stable species inspection stage out at sea) — only when a veg-* view is requested
    if (/^veg-/.test(flag("view") ?? "")) {
      buildStudio(ctx.scene, (k, v) => system!.getSpecies(k, v), (k, v, x, y, z, yaw, sc) => system!.pool(k, v).add(x, y, z, yaw, sc, 1, 1, 1));
    }
    // quality tier: ?vegq= overrides, else the engine's quality (ultra → epic)
    {
      const qq = flag("vegq") as VegQuality | null;
      const map: Record<string, VegQuality> = { ultra: "epic", high: "high", medium: "medium", low: "low" };
      system.setQuality(qq && ["low", "medium", "high", "epic"].includes(qq) ? qq : map[ctx.quality] ?? "high");
    }
    // (POIs plant through veg.plant right after this: the spawn mask must be in place — it is a 185 KB fetch)
    await loadSpawnMask();
    ctx.shared.set("veg", system as VegApi);
    void scattered.then(() => ctx.shared.set("vegInstances", system!.instances));
    ctx.onUpdate((dt, t) => system!.update(dt, t));
    system.stats.buildMs = Math.round(performance.now() - t0);
  },
  /**
   * Compile EVERY veg program up-front (after atmos' afterBuild patched the materials) — including pools with no
   * instance in view (the highland palm, mangroves …) — so no veg shader ever compiles on first sight, with or
   * without the game's prewarm.
   */
  async afterBuild(ctx: WorldCtx) {
    const t0 = performance.now();
    const list: THREE.Object3D[] = [];
    ctx.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && /^veg:/.test(o.name)) list.push(o); });
    // (grass / litter LOD1 and impostor programs used to compile again during play: they had been compiled
    // for the SCREEN — sRGB output + tone mapping in the shader — while the frame draws the scene into the post chain's
    // linear render target, a different program key ("srgb → srgb-linear"). Compile against an
    // offscreen target, like the game's boot prewarm; + the shadow-depth programs of every caster (warmShadows).)
    try { await compileVeg(ctx, list); } catch (e) { console.warn("veg: program precompile failed", e); }
    if (flag("vegwarm")) try { const n = warmShadows(ctx, list); if (system) system.stats.shadowWarmPrograms = n; } catch (e) { console.warn("veg: shadow program warm-up failed", e); }
    if (system) system.stats.compileMs = Math.round(performance.now() - t0);
  },
};
export default mod;
