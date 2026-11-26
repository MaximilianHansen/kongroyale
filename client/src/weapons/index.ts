// The weapons kit gameplay + actors use (contract: ./api.ts). Look/feel lives in the pieces:
//   viewmodel.ts (1P kong arms + guns, springs), held.ts (3P single-draw LOD guns), chest.ts (crates), loot.ts (floor
//   loot), heals.ts (consumables), fx.ts (muzzle flashes, tracers, impacts, explosions, shells, rocket projectile).
// Optional pieces are loaded through import.meta.glob so a missing / broken piece degrades to a no-op instead of
// taking the game down; the kit forwards to them once loaded.
import * as THREE from "three";
import type { WorldCtx } from "../engine/engine";
import type { ConsumableId, Rarity, WeaponId } from "../../../shared/world/map";
import type { ChestView, Fx, LootView, WeaponsKit } from "./api";
import { createViewModel, type VmFx } from "./viewmodel";
import { createHeld, setHeldCamo } from "./held";
import { tickCamo } from "./camo";
import { ChestSystem, createChestView } from "./chest";
import { createLootView, LootSystem } from "./loot";
import { CONSUMABLES, WEAPONS } from "../../../shared/world/map";
import { flag } from "../flags";

/** FX piece surface (fx.ts): the contract Fx + extras the viewmodel / kongs use */
export type FxEx = Fx & VmFx & { hitSparkle?(pos: THREE.Vector3, headshot: boolean): void; markerSmoke?(pos: THREE.Vector3, k?: number): void };
interface FxModule { createFx(ctx: WorldCtx): FxEx; createRocketView?(ctx: WorldCtx, fx: FxEx): { object: THREE.Object3D; update(dt: number): void }; createArrowView?(ctx: WorldCtx, fx: FxEx): { object: THREE.Object3D; update(dt: number, stuck?: boolean): void } }
const FX_MODULES = import.meta.glob<FxModule>("./fx.ts");

/** the atmos warm multi-bounce (state.ts warmBounce 1.2) feeds a yellow albedo's own chroma back into its fill: every
 *  banana's shade went apricot / tan. Weapons materials keep a
 *  quarter of it (a warm shade, still lemon). Wraps the atmos hook AFTER it ran; a no-op if its text ever changes. */
function tameBounce(m: THREE.Material) {
  if (m.userData.wpnBounceTamed) return;
  m.userData.wpnBounceTamed = true;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = function (shader, r) {
    prev.call(this, shader, r);
    shader.fragmentShader = shader.fragmentShader.replace("uAtmBounce * atmWarm", "uAtmBounce * atmWarm * 0.25");
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => prevKey() + "|wpnTB";
  m.needsUpdate = true;
}

/** one kit per WorldCtx (gameplay, actors and stages all call createWeaponsKit(ctx)) */
const kits = new WeakMap<WorldCtx, WeaponsKitEx>();

export interface WeaponsKitEx extends WeaponsKit {
  /** a supply drop (parachute + crate + yellow marker smoke); gameplay places it and calls update(dt) each frame */
  createSupplyDrop(): Promise<import("./supply").SupplyDrop>;
  /** the in-flight rocket (banana bunch + coconut nose + trail); null until the fx piece provides it */
  createRocket(): Promise<{ object: THREE.Object3D; update(dt: number): void } | null>;
  /** the in-flight / sticky explosive bamboo arrow (Bamboo Bow) */
  createArrow(): Promise<{ object: THREE.Object3D; update(dt: number, stuck?: boolean): void } | null>;
  prepareLoot(next?: () => Promise<void>): Promise<THREE.Object3D>;
}

/** boot cost of the weapons area (main thread ms) — a perf script reads window.__krWpnBoot */
const bootT: Record<string, number> = {};
if (typeof window !== "undefined") (window as unknown as { __krWpnBoot: Record<string, number> }).__krWpnBoot = bootT;

export function createWeaponsKit(ctx: WorldCtx): WeaponsKitEx {
  const hit = kits.get(ctx);
  if (hit) return hit;
  const tKit = performance.now();

  // ---- atmos material patch (CSM shadows, haze) for everything the kit creates after the world's afterBuild sweep
  const atmos = () => ctx.shared.get("atmos") as { patch?(m: THREE.Material): void } | undefined;
  const patched = new WeakSet<THREE.Material>();
  const patchTree = (o: THREE.Object3D) => {
    const a = atmos();
    if (!a?.patch) return;
    o.traverse((c) => {
      const m = (c as THREE.Mesh).material;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) if (!patched.has(x) && !(x as THREE.ShaderMaterial).isShaderMaterial) { patched.add(x); try { a.patch!(x); tameBounce(x); } catch { /* not patchable */ } }
    });
  };

  // ---- FX: a forwarding proxy so gameplay can hold it synchronously while fx.ts loads
  let real: FxEx | null = null;
  let fxMod: FxModule | null = null;
  const fxLoad = (FX_MODULES["./fx.ts"]?.() ?? Promise.resolve(null)).then((m) => { fxMod = m; if (m) real = m.createFx(ctx); return m; }).catch((e) => { console.error("[weapons] fx piece failed to load", e); return null; });
  const fx: FxEx = {
    tracer: (a, b, w) => real?.tracer(a, b, w),
    impact: (p, n, s) => real?.impact(p, n, s),
    explosion: (p, r) => real?.explosion(p, r),
    puff: (p, k) => real?.puff(p, k),
    update: (dt) => real?.update(dt),
    muzzleFlash: (p, d, w, fp) => real?.muzzleFlash?.(p, d, w, fp),
    shell: (p, v, w) => real?.shell?.(p, v, w),
    hitSparkle: (p, h) => real?.hitSparkle?.(p, h),
    markerSmoke: (p, k) => real?.markerSmoke?.(p, k),
  };

  // ---- chests: ONE system per ctx — closed crates drawn through instanced batches per rarity (LOD + 200 m cull), a
  // fixed pool of burst lights that lives in the scene for good (the light count never changes → no recompiles)
  let tp = performance.now();
  const chestSys = new ChestSystem(ctx);
  patchTree(chestSys.root);
  bootT.chestMs = Math.round(performance.now() - tp); tp = performance.now();
  // ---- floor loot: real item within 4.5 m, instanced ≤2k-tri LODs beyond, instanced beams / glows, cull at 90 m
  const lootSys = new LootSystem(ctx);
  patchTree(lootSys.root);
  bootT.lootMs = Math.round(performance.now() - tp);
  // the far-LOD bakes of every floor-loot item (~1-2 s of main thread) are left to the game's prefab warm-up after the title;
  // ?lootlater=0 runs them one item per macrotask right after boot (done long before the deferred prefab prewarm compiles them)
  let lootPrep: Promise<THREE.Object3D> | null = null;
  const prepareLoot = (next: () => Promise<void> = () => new Promise<void>((r) => setTimeout(r, 0))) => (lootPrep ??= (async () => {
    let spent = 0;
    for (const item of [...WEAPONS, ...CONSUMABLES, "ammo"] as const) {
      await next();
      const t0 = performance.now(); lootSys.prepare([item]); patchTree(lootSys.root); spent += performance.now() - t0;
    }
    bootT.lootPrepMs = Math.round(spent);
    return lootSys.root;
  })());
  if (!flag("lootlater")) void prepareLoot();
  let tick = 0;
  ctx.onUpdate((dt, t) => { tick++; chestSys.update(dt, t); lootSys.update(t); tickCamo(t); });
  // remote kongs holding a mythic: their held gun (under the actor's hand socket) wears the
  // camo; remembered per actor so a frame where nothing changed costs two map lookups
  const heldState = new WeakMap<THREE.Object3D, { gun: THREE.Object3D | null; on: boolean; sock: THREE.Object3D | null }>();
  bootT.kitMs = (bootT.kitMs ?? 0) + Math.round(performance.now() - tKit);

  const kit: WeaponsKitEx = {
    async createViewModel() {
      const t0 = performance.now();
      const vm = await createViewModel(() => real, (o) => patchTree(o));
      patchTree(vm.object);
      bootT.viewModelMs = Math.round(performance.now() - t0);
      return vm;
    },
    createFx() { return fx; },
    prepareLoot,
    async createChest(rarity: Rarity) {
      const v = createChestView(ctx, rarity, {}, chestSys);
      // a chest that is opened in the same tick it was created was already open when we arrived: no burst
      const born = tick;
      const view: ChestView = {
        object: v.object, hull: v.hull,
        open: () => v.open(tick === born),
        close: () => v.close(),
        get opened() { return v.opened; },
      };
      return view;
    },
    async createLoot(item: WeaponId | ConsumableId | "ammo" | "cash", rarity: Rarity, skin?: string | null): Promise<LootView> {
      const v = createLootView(ctx, 0, item, rarity, { grounded: false, skin }, lootSys);
      patchTree(v.object);
      return v;
    },
    async createHeldWeapon(id: WeaponId, rarity: Rarity) {
      const o = createHeld(id, rarity);
      patchTree(o);
      return o;
    },
    setHeldMythic(actorRoot: THREE.Object3D, on: boolean) {
      let st = heldState.get(actorRoot);
      if (!st) { st = { gun: null, on: false, sock: actorRoot.getObjectByName("hand-socket") ?? null }; heldState.set(actorRoot, st); }
      const gun = st.sock?.children[0] ?? null;
      if (gun === st.gun && on === st.on) return;
      st.gun = gun; st.on = on;
      if (gun) { setHeldCamo(gun, on); if (on) patchTree(gun); }
    },
    async createSupplyDrop() {
      const { createSupplyDrop } = await import("./supply");
      const d = createSupplyDrop(ctx, fx);
      patchTree(d.object);
      return d;
    },
    async createRocket() {
      await fxLoad;
      if (!fxMod?.createRocketView || !real) return null;
      const r = fxMod.createRocketView(ctx, real);
      patchTree(r.object);
      return r;
    },
    async createArrow() {
      await fxLoad;
      if (!fxMod?.createArrowView || !real) return null;
      const r = fxMod.createArrowView(ctx, real);
      patchTree(r.object);
      return r;
    },
  };
  kits.set(ctx, kit);
  return kit;
}
