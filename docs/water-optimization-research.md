# Kong Royale Water Architecture, Frame & Memory Audit, and Optimization Research

> **Branch:** `perf/water-optimization` (commit `28a6991`)  
> **Hardware & Driver Tested:** NVIDIA GeForce RTX 5060 (ANGLE D3D11 `vs_5_0 ps_5_0`, Driver `32.0.16.1088`), Windows  
> **Raw Measurement Outputs (gitignored):** `reports/performance/water-tour-heli.json`, `reports/performance/water-census-heli.json`, `reports/performance/water-mem.json/result.json`, `reports/performance/water-bench.json`, `reports/performance/water-bench-v2.json`

---

## 1. Executive Summary

Kong Royale has **two independent water rendering stacks** plus gameplay physics and audio integrations:

1. **Global Ocean / Reef / Lagoon / Harbor System** ([`client/src/world/water/`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/index.ts)): An 8-level concentric 2×2-fan clipmap (`50,432` triangles at `high`/`ultra`/`medium`, `28,224` at `low`) extending out to a `60 km` horizon skirt, shaded by a custom-patched `MeshStandardMaterial` (`159 KB` GLSL in [`shader.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/shader.ts)), dual-source blending (`WEBGL_blend_func_extended`, or 3-pass fallback), deep-water early-Z occluder, procedural/worker-baked `1201×1201` bathymetry/shelter/slope fields, `4096×4096` obstacle/shoreline-coverage baker, `24 Hz` `WaveTile` normal/caustics generator, `256×256` interactive ripple PDE, `1080p`+ full-frame `SceneGrab` color/depth copy, 2-pass `Underwater` screen overlay, `Flotsam` crates/collars, and `Spray` particles (`8,528` quads).
2. **Local Inland & POI Water Systems**:
   - **Jungle Water Kit** ([`client/src/world/pois/_kit/jungle-water.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/_kit/jungle-water.ts)) used by **Mist Falls** (`28.8k`-tri pool, river chunks, 5 falls sheets, cascade, rainbow mist) and **CNVS Lab** (4 falls sheets, veil sheets, mist puffs, pool).
   - **The Murk** ([`client/src/world/pois/the-murk/water.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/the-murk/water.ts)): Custom `10,772`-tri swamp mesh with its **own second `SceneGrab`**, `1` texel/m `reflMap`, `512×512` `siltTexture`, and fullscreen `murk:haze` pass (`frustumCulled = false`).
   - **Town Water / Resort Pool / Fountain** ([`town-water.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/_kit/town-water.ts), [`town-fountain.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/_kit/town-fountain.ts), Coconut Cove resort pool, Mango Market fountain), plus **Coco Caves** (`caves-pool`: `29,360` tris) and **Wreck Bay** (`wreckbay:pools-light`: `3,240` tris).

### Top Empirical Takeaways (RTX 5060)

- **1080p vs. 4K Scaling Proves Severe Fragment & Bandwidth Bound Cost:**
  - At **1920×1080 (`q=high`, uncapped)**, sea water costs **`1.18 ms` GPU (`24.6%`)** in Harbor low view (`4.79 → 3.61 ms`), **`1.13 ms` GPU (`25.1%`)** in The Murk (`4.51 → 3.38 ms`), **`0.65 ms` GPU (`11.4%`)** at East Beach (`5.66 → 5.01 ms`), and **`0.36 ms` GPU (`17.2%`)** Underwater (`2.10 → 1.74 ms`).
  - At **3840×2160 (`?dpr=2`, 4× pixels)**, water cost explodes by **7–9×** (more than pixel ratio):
    - `water-harbor-low`: **`15.99 ms` (71.3 FPS) → `5.69 ms` (147.9 FPS)** — sea water alone consumes **`10.30 ms` GPU (`64.4%` of the entire frame)**.
    - `biome-01-beach`: **`10.62 ms` (104.4 FPS) → `6.17 ms` (161.7 FPS)** — water consumes **`4.45 ms` (`41.9%`)**.
    - `water-underwater`: **`8.22 ms` (134.4 FPS) → `5.31 ms` (177.9 FPS)** — water consumes **`2.91 ms` (`35.4%`)**.
- **`SceneGrab` + SSR/Refraction (`WTR_SCENE`) is the Single Biggest Lever:** Disabling scene capture + SSR/refraction (`?wnoscene=1`) saves **`1.04 ms` GPU (`-24.1%`)** at 1080p Harbor view (`4.33 → 3.29 ms`). Meanwhile, skipping the `rows` row-clipping optimization (`grab.rows = 1` hardcoded in `index.ts`) forces a full `1920×1080` (or `4K`) framebuffer color + depth copy every frame whenever any water pixel passes the occlusion query.
- **Merged `WTR_FOAMMAIN` Increases Fragment Register Pressure:** Splitting foam back into `foamMesh` (`?wfoampass=1`) or disabling dual-source blending (`?wnodual=1`) on `water-harbor-low` *improved* 1080p GPU time (**`4.09 ms`** and **`3.91 ms`** vs **`4.33 ms`**) despite +1–2 draws and +50k–100k tris, because `WTR_FOAMMAIN` compiles `FOAM_STACK` into every open-ocean fragment.
- **Persistent GPU VRAM Footprint (`~152.6–163.2 MiB` dedicated to global sea GPU targets/textures, plus `~48+ MiB` CPU mirrors and POI water targets including The Murk's second `SceneGrab`):** `ObstacleBake` alone holds **`98.00 MiB`** of `4096×4096` / `1024×1024` render targets all session, and **none of `world/water/` is tracked by `Scope` (`region:water` reports `0 B`)**.
- **Unnecessary Cross-Map Draws:** `murk:water` (`frustumCulled = false`), `murk:haze` (`renderOrder 1000`), `water-spray` (`8,528` quads), and `flotsam-crates`/`flotsam-foam` submit draw calls on **every frame anywhere on the island**, including East Coast beaches, Underwater views, and inland Mist Falls.

---

## 2. Complete Subsystem & File Inventory

### 2.1 Global Ocean Stack (`client/src/world/water/` — 22 files, 372 KB)

| File | Size | Responsibility |
|---|---|---|
| [`index.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/index.ts) | 35.9 KB | Module orchestrator, clipmap LOD switching (`mesh`/`meshMid`/`meshFar`), `preMesh`/`mulMesh`/`foamMesh`, `occ`, update loop, `__krWater` handle, dev views |
| [`api.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/api.ts) | 2.7 KB | `WaterApi` contract (`level`, `depthAt`, `shoreDistanceAt`, `surfaceAt`, `registerFoam*`, `clearFoam`, `rebakeObstacles`, `isUnderwater`, `disturb`, `splash`) |
| [`shader.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/shader.ts) | 159.2 KB | All GLSL vertex/fragment chunks (`VERT_*`, `FRAG_COLOR`, `FOAM_STACK`, `wtrSSRTrace`, `wtrColumn`, 8 chop wavelets, Snell's window, underwater caustics) |
| [`material.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/material.ts) | 23.9 KB | Uniform factory (`wtr*`), `LIGHTS_SUN_ONLY`/`LIGHTS_WATER`, `makeMain("near"|"mid"|"far")`, `mul`, `prepass`, `makeFoam(far)` |
| [`clipmap.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/clipmap.ts) | 4.9 KB | Concentric 8-level 2×2-fan clipmap builder (`wlevel` attribute, stitched T-junction borders, `60 km` horizon skirt) |
| [`dualsrc.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/dualsrc.ts) | 4.1 KB | Patches `WebGL2RenderingContext.blendFuncSeparate` for `WEBGL_blend_func_extended` (`DUAL_DST_SENTINEL` → `SRC1_COLOR_WEBGL`) |
| [`grab.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/grab.ts) | 14.3 KB | `SceneGrab`: framebuffer color+depth copy (`blitFramebuffer` / `copyTexSubImage2D`) + `ANY_SAMPLES_PASSED_CONSERVATIVE` visibility query every 8 frames |
| [`obstacles.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/obstacles.ts) | 30.0 KB | `ObstacleBake`: 6 RTs (`rtA`/`rtP`/`rtB`/`rtC`/`rtW1`/`rtW2`), 4 full-scene sheared ortho passes, async PBO `wideCellsAsync` |
| [`fields.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/fields.ts) | 10.6 KB | GPU textures `wtrField` (`RGBA16F`), `wtrField2` (`RGBA8`), `wtrField3` (`RGBA16F`) + CPU/GPU `FoamMask` (`2048²` canvas + `Uint8Array` + R8) |
| [`fieldbake.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/fieldbake.ts) | 12.3 KB | Worker CPU compute: Felzenszwalb 2D EDT (`dLand`, `dWater`, `dLag`), 16-ray lagoon shelter exposure, blurs, steepness max-filter, `spray` spawns |
| [`textures.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/textures.ts) / [`texbake.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/texbake.ts) | 8.8 KB | Procedural `DataArrayTexture` `512×512×3` `RGBA8` (`wtrTex2`: foam lace/density/bubbles/streaks, FBM noise, Worley caustic net + SDF) |
| [`bakeclient.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/bakeclient.ts) / [`bake.worker.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/bake.worker.ts) | 6.6 KB | Spawns temporary Web Workers (`wTex`, `wFld`, optional `wBeach`) during boot |
| [`waves.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/waves.ts) | 4.7 KB | 6 Gerstner swells (`len` 58, 31, 17, 9.5, 5.3, 3.1 m), unrolled GLSL `gerstner`/`gerstnerSlopeShort` (`LONG=5`) & JS `swellHeight()` |
| [`wavetile.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/wavetile.ts) | 13.0 KB | 9 m tile of ~90 capillary-gravity waves (`rings=26`) rendered into `256²` `wtrTile` at `24 Hz`, plus `300²` caustics mesh into `512²` RT at `20–30 Hz` |
| [`interact.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/interact.ts) | 6.3 KB | `InteractiveRipples`: `256×256` `RGBA16F` ping-pong PDE over 48 m camera window, 60 Hz accumulator, auto-sleeps after 600 idle frames |
| [`underwater.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/underwater.ts) | 10.6 KB | `Underwater`: 2 fullscreen triangle passes (`renderOrder` 9998 multiply + 9999 additive: extinction, seabed caustics, light shafts, marine snow) |
| [`flotsam.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/flotsam.ts) | 22.1 KB | `Flotsam`: `InstancedMesh` crates (`1024×512` `CanvasTexture`, `7` instances) + `flotsam-foam` collars updated per-frame via `surfaceAt` |
| [`spray.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/spray.ts) | 8.1 KB | `Spray`: Single `InstancedMesh` (`8,528` active quad instances observed at runtime, up to 19,200 capacity), vertex-animated, `gl_Position` culled `> 340 m` |
| [`skyirr.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/skyirr.ts) | 3.1 KB | `SkyIrradianceProbe`: `1×1` `FloatType` RT sampling diffuse irradiance for `(0,1,0)` whenever `scene.environment` changes |
| [`beachcam.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/beachcam.ts) | 7.1 KB | View solver & cache verifier (`public/assets/water/beach-view.json`) for `?view=biome-01-beach` |

### 2.2 Local POI Water, Gameplay Physics & Audio Files

- **Jungle & Cascades Kit:** [`jungle-water.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/_kit/jungle-water.ts), [`mist-falls/water.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/mist-falls/water.ts), [`cnvs-lab/falls.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/cnvs-lab/falls.ts).
- **Swamp / Pools / Caves / Fountains:** [`the-murk/water.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/the-murk/water.ts), [`town-water.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/_kit/town-water.ts), [`town-fountain.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/_kit/town-fountain.ts), [`coconut-cove/index.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/coconut-cove/index.ts), [`coco-caves/fx.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/coco-caves/fx.ts), [`the-wreck/dressing.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/the-wreck/dressing.ts).
- **Simulation & Hitscan:** [`shared/sim/const.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/shared/sim/const.ts), [`shared/sim/player.hot.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/shared/sim/player.hot.ts), [`shared/sim/hitscan.hot.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/shared/sim/hitscan.hot.ts), [`shared/sim/vehicle.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/shared/sim/vehicle.ts), [`shared/sim/heli.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/shared/sim/heli.ts), [`shared/sim/storm.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/shared/sim/storm.ts).
- **FX, UI, Rig & Audio:** [`client/src/game/water-fx.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/game/water-fx.ts), [`client/src/game/render.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/game/render.ts), [`client/src/actors/kong-rig.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/actors/kong-rig.ts), [`client/src/ui/hud.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/ui/hud.ts), [`client/src/ui/mappaint.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/ui/mappaint.ts), [`client/src/audio/surf.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/audio/surf.ts), [`client/src/audio/ambience.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/audio/ambience.ts), [`client/src/audio/mixer.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/audio/mixer.ts).

---

## 3. Global Sea Rendering Pipeline & Frame Lifecycle

### 3.1 Geometry & Altitude LOD Switching

- **Clipmap Grid (`clipmap.ts`):** `levels = 8`, `baseCell = 1.0 m` (cell size doubles each ring: `1 m` to `128 m`), `cells = 64` per axis on `medium`/`high`/`ultra` (**`26,177` vertices / `50,432` triangles**), reduced to `cells = 48` on `low` (**`28,224` triangles**), plus a horizon skirt extending to `60,000 m`. All 7 clipmap-backed meshes (`mesh`, `meshMid`, `meshFar`, `preMesh`, `mulMesh`, `foamMesh`, `foamMeshFar`) **share the clipmap geometry**.
- **Active Altitude Mesh Switching (`index.ts`):**
  - **Low (`< 120 m`):** `water` (`mesh`) — Full `WTR_NEAR`, `WTR_VALL`, `WTR_SCENE`, `WTR_VCORE`, `WTR_VSHADOW`, `WTR_FOAMMAIN`.
  - **Mid (`120 m – 320 m`):** `water-mid` (`meshMid`) — Keeps `WTR_SCENE` (SSR/refraction) and `WTR_VCORE`/`WTR_VSHADOW`, drops `WTR_NEAR` & `WTR_VALL` detail.
  - **Far (`> 320 m`):** `water-far` (`meshFar`) — Drops `WTR_SCENE`, `WTR_VSHADOW`, `depthWrite = false`, adds `WTR_FAR` + `WTR_MULFLD2`.
- **Deep-Water Occluder Disc (`water-occluder`):** `481` vertices / `912` triangles, `renderOrder = -1000`, `colorWrite = false`, `depthWrite = true` (`depth: 7, slope: 0.006`). Checked every 10 frames (`c.y > 12 || deep >= 2`) to mask underwater terrain overdraw from deep-sea tiles.

### 3.2 Blending & Multi-Pass Pipeline (`material.ts` + `dualsrc.ts`)

By default (`dualSrcExt = true` verified on RTX 5060 D3D11), WebGL2 uses `WEBGL_blend_func_extended` with `DUAL_DST_SENTINEL`:
1. **`WTR_DUAL_SRC` + `WTR_FOAMMAIN` (Default Fast Path — 1 Draw):** Computes surface transmittance (`src1` / secondary color), subsurface refraction, specular/SSR, AND `FOAM_STACK` in a single fragment pass (`renderOrder = -1`).
2. **Separate Foam (`?wfoampass=1` — 2 Draws):** Strips `WTR_FOAMMAIN` out of the main pass and enables `foamMesh` / `foamMeshFar` (`renderOrder = -0.5`) separately.
3. **No Dual-Source Fallback (`?wnodual=1` — 3 Draws):** Enables `mulMesh` (`water-mul`, `renderOrder = -2`, multiplicative volume transmittance) → `mesh` (`renderOrder = -1`) → `foamMesh` (`renderOrder = -0.5`).
4. **Depth Prepass (`?wprepass=1`):** Optionally draws `preMesh` (`water-depth`, `renderOrder = -3`, `drawRange.start = 42240` outer rings). Off by default.

### 3.3 Dynamic Frame Sub-Passes (Inside `water.update()` / `onBeforeRender`)

1. **`WaveTile` & Caustics (`wavetile.ts`):**
   - Updates `wtrTile` (`256×256` `RGBA8` + hardware `generateMipmaps` + aniso `8`) at **`TILE_DT = 1/24 s` (`41.67 ms`)**, summing ~90 dispersive capillary-gravity cosines per fragment over a `9 m` tile.
   - When `under.active && causZone(c.x, c.z)`: renders a **`300×300` displaced mesh (`180,000` tris × 2 focus passes = `360,000` tris observed in `tris` counter!)** into `causTmp` (`512×512` `RGBA16F`) followed by a `3×3` tent filter pass into `caustics` (`512×512` `RGBA8` + mips) at **`1/20–1/30 s`**.
2. **`InteractiveRipples` (`interact.ts`):** `256×256` `RGBA16F` ping-pong wave PDE covering a `48 m × 48 m` moving box around the camera, stepped at 60 Hz while awake (up to 24 disturbance drops/step) and sleeping after 600 idle frames.
3. **`SceneGrab` (`grab.ts`):**
   - Copies scene color + depth into `wtrSceneCol` and `wtrSceneDepth` **each frame** unless the `ANY_SAMPLES_PASSED_CONSERVATIVE` occlusion query (checked every `8` frames) reported 0 visible water pixels (`grab.visible = false`, observed in inland Mist Falls!).
   - **`grab.rows = 1` is hardcoded in `index.ts:273`**, disabling horizon row clipping (`100%` of viewport pixels are copied on every visible frame).
4. **`ObstacleBake` (`obstacles.ts`):**
   - Checks visibility changes in the scene every 8/60 frames (or 12 frames after a `> 40 m` camera teleport). When triggered (`bakes = 5` at initial view settle → `48..51` across view switches), draws the visible scene into **`scene:override water-obstacle-cov:other-camera`** using **4 sheared orthographic passes** (`ABOVE`/`BELOW` × 2 diagonals) plus edge-dilation/EDT passes into `rtA`/`rtP`/`rtB`/`rtC`/`rtW1`/`rtW2`, plus optional async PBO readback `wideCellsAsync`.
   - From the real-match heli census (`water-census-heli.json`), this override pass averages `0.04 calls/frame` and `0.163 ms` amortized (`~4.08 ms` CPU cost per active bake frame, `~14` draws).
5. **`Underwater` (`underwater.ts`):** When camera sits below `surfaceAt`, renders `water-underwater-absorb` (`renderOrder 9998`, fullscreen multiply) and `water-underwater-volume` (`renderOrder 9999`, fullscreen additive: seabed caustic net, 4 volumetric god-ray taps, 4 animated marine snow parallax shells).

---

## 4. Build, Memory, Resource Audit & Mesh Triangle Inventory

### 4.1 Build & Bake Timings (`q=high`, 1920×1080, `water-bench.json`)

- **Worker startup (`terrainMs`):** `60 ms` read/decode; `terrain` module build `3,031 ms`.
- **`water` synchronous `build`:** **`47 ms`** (spawns 2 bake workers `wTex` & `wFld` cleanly in parallel).
- **`water` `afterBuild`:** **`448 ms`** (initial texture uploads, shader pre-setup & initial `ObstacleBake` warm).
- **Water POI builds:** `poi:peel-harbor` (`2,997 ms`), `poi:mango-market` (`2,963 ms`), `poi:the-wreck` (`1,150 ms`), `poi:the-murk` (`668 ms`), `poi:cnvs-lab` (`443 ms`), `poi:mist-falls` (`329 ms`), `poi:coconut-cove` (`238 ms`), `poi:stilt-town` (`491 ms`), `poi:wreck-bay` (`518 ms`).

### 4.2 Exact Mesh & Triangle Inventory (Live Runtime Inspection)

| Object Name | POI / Module | Type | `visible` | `frustumCulled` | `renderOrder` | Vertices | Triangles (Total) | Instances | Material |
|---|---|---|---:|:---:|---:|---:|---:|---:|---|
| `water` (`water-mid`, `water-far`) | `water` | Mesh | 1 active | `false` | `-1` | `26,177` | **`50,432`** (`28,224` low) | `1` | `MeshStandardMaterial` |
| `water-depth` / `water-mul` / `water-foam*` | `water` | Mesh | conditional | `false` | `-3 / -2 / -0.5` | `26,177` | `50,432` each | `1` | `Shader` / `Standard` |
| `water-occluder` | `water` | Mesh | dynamic | `false` | `-1000` | `481` | `912` | `1` | `ShaderMaterial` |
| `water-underwater-absorb` / `-volume` | `water` | Mesh | underwater | `false` | `9998` / `9999` | `3` × 2 | `1` × 2 | `1` | `ShaderMaterial` |
| `water-spray` | `water` | Instanced | `true` | **`false`** | `2` | `4` | **`17,056`** | `8,528` | `ShaderMaterial` |
| `flotsam-crates` / `flotsam-foam` | `water` | Instanced | `true` | **`false`** | `0` / `1` | `336` / `4` | `1,176` / `14` | `7` / `7` | `MeshStandardMaterial` |
| `murk:water` | `poi:the-murk` | Mesh | `true` | **`false`** | `0` | `5,695` | **`10,772`** | `1` | `MeshStandardMaterial` |
| `murk:haze` | `poi:the-murk` | Mesh | `true` | **`false`** | `1000` | `4` | `2` (fullscreen) | `1` | `ShaderMaterial` |
| `murk:silt` / `murk:mist` / `murk:lilies` | `poi:the-murk` | Mesh/Inst | `true` | `true`/`false`/`true` | `-10`/`4`/`5` | `14,180`/`68`/`84` | `7,090`/`34`/`15,960` | `1`/`1`/`133` | `Standard`/`Shader` |
| `jungle-water` (Mist Falls pool + 2 river chunks) | `poi:mist-falls` | Mesh | `true` | `true` | `2` | `14,641+3,362+4,225` | **`28,800 + 6,400 + 8,192`** | `1` each | `MeshStandardMaterial` |
| `jungle-falls` (5) + `jungle-cascade` + rainbow | `poi:mist-falls` | Mesh | `true` | `true` | `3` / `6` | `3,001` | `5,322` | `1` each | `Shader` / `Basic` |
| `lab:falls-water*` + `lab:falls-puff` (10) | `poi:cnvs-lab` | Mesh | `true` | `true` | `3` / `4` | `6,111+` | **`11,136 + 20`** | `1` each | `ShaderMaterial` |
| `caves-pool` (+ `caves-lava-pool`) | `poi:coco-caves` | Mesh | `true` | `true` | `2` / `0` | `40,401` / `27` | **`29,360` / `32`** | `1` | `MeshStandardMaterial` |
| `cove:pool-water` | `poi:coconut-cove` | Mesh | `true` | `true` | `2` | `352` | `616` | `1` | `MeshStandardMaterial` |
| `fountain:water` / `fountain:jets` | `poi:mango-market` | Mesh | `true` | `true` | `0` / `2` | `74` / `2,040` | `72` / `2,912` | `1` | `MeshStandardMaterial` |
| `wreckbay:pools-light` / `firepool` / `waterfall` | `poi:wreck-bay` | Mesh | `true` | `true` | `2` / `3` | `2,367` | `3,308` | `1` | `Basic` / `Shader` |
| `wreck-stern-hull:wreck-hold-pool` & `wh-light-pool` ×6 | harbor/wreck | Mesh | `true` | `true` | `0` / `2` | `372` | `124` | `1` each | `MeshBasicMaterial` |

### 4.3 GPU VRAM, Texture & Target Footprint (Observed at `1920×1080`, `q=high`)

Exact WebGL allocations extracted directly from `__krWater` (`water-bench-v2.json`):

| Allocation | Dimensions & Format | Mipmaps | GPU Size | Lifetime & Ownership |
|---|---|---:|---:|---|
| `ObstacleBake.rtA` | `4096×4096` `RG8` | No | **`32.00 MiB`** | Whole session (unowned) |
| `ObstacleBake.rtP` | `4096×4096` `R8` | No | **`16.00 MiB`** | Whole session (unowned) |
| `ObstacleBake.rtB` | `4096×4096` `R8` | No | **`16.00 MiB`** | Whole session (unowned) |
| `ObstacleBake.rtC` (`u.wtrObstacle`) | `4096×4096` `RG8` | No | **`32.00 MiB`** | Whole session (unowned; same texture) |
| `ObstacleBake.rtW1` & `rtW2` | `2 × 1024×1024` `R8` | No | `2.00 MiB` | Whole session (unowned) |
| `WaterFields.wtrField` | `1201×1201` `RGBA16F` | No | **`11.00 MiB`** | Whole session (unowned) |
| `WaterFields.wtrField2` | `1201×1201` `RGBA8` | No | `5.50 MiB` | Whole session (unowned) |
| `WaterFields.wtrField3` | `1201×1201` `RGBA16F` | No | **`11.00 MiB`** | Whole session (unowned) |
| `wtrTex2` (`DataArrayTexture`) | `512×512×3` `RGBA8` | Yes (`aniso 4`) | `4.00 MiB` | Whole session (unowned) |
| `WaveTile.tile` (`wtrTile`) | `256×256` `RGBA8` | Yes (`aniso 8`) | `0.33 MiB` | Whole session (unowned) |
| `WaveTile.caustics` | `512×512` `RGBA8` | Yes (`aniso 4`) | `1.33 MiB` | Whole session (unowned) |
| `WaveTile.causTmp` | `512×512` `RGBA16F` | No | `2.00 MiB` | Whole session (unowned) |
| `InteractiveRipples.rts[0,1]` (`wtrSim`) | `2 × 256×256` `RGBA16F` | No | `1.00 MiB` | Whole session (unowned) |
| `SceneGrab` (Sea: color + depth) | `1920×1080` (`cW×cH`, `dW×dH`) | Color mip: yes | **`~18.5–29.0 MiB`** | Whole session; **4× larger at 4K (`74–116 MiB`)** |
| **Subtotal Global Sea GPU Targets/Textures** | — | — | **`~152.6–163.2 MiB`** | (**`0 B` in `region:water` `Scope` ledger!**) |
| **CPU Mirrors & Local POI Water Textures** | `FoamMask` (`2048²` HTMLCanvas `16 MiB` + `4 MiB` `Uint8Array` + `4 MiB` R8 GPU), `WaterFields` (`1201²` shore/field buffers), `Flotsam` `1024×512` `CanvasTexture` (`2 MiB` base), `mist-falls` (`1536×540` R8 `0.79 MiB` + `jungle-water` `512²` `1 MiB`), `the-murk` (`silt` `512²` `1 MiB` + `reflMap` + second `1920×1080` `SceneGrab`) | — | **`~48+ MiB`** | Also unowned in `Scope` (`tools/lint/baseline.json`) |

- **Process Memory Tour (`tools/performance/memory.mts --profile win --tour 35`, `1600×900@1`):**
  - Title (2 POIs): Total **`5,943.9 MB`** (GPU `3,449.4 MB`, Renderer `2,344.2 MB`, WebGL `1,386.6 MB` in `403` textures, buffers `158.2 MB`, CPU copies: geometry `115.7 MB`, textures `281.5 MB`, audio `46.4 MB`).
  - Plane (17 POIs built): Total **`11,332.9 MB`** (GPU `7,835.2 MB`, Renderer `3,352.9 MB`, WebGL `4,142.3 MB` in `1,245` textures, buffers `1,341.1 MB`, renderbuffers `30.2 MB`, JS heap `290 MB`).
  - Match1 → Match2 peak reached **`12,131 MB`** (GPU `8,401.8 MB`), with leak delta `left1 → left2` of only `+0.9 MB` WebGL and `0` leaked texture count across matches (`match1 → match2` `+78.5 MB` WebGL, `19` textures).
- **Resource Ownership (`?resaudit=1` on `biome-01-beach`):** `unowned`: `2,051` objects = `2,930.80 MB` (`geometry` `920.6 MB`, `texture` `1,586.1 MB`, `target` `424.1 MB`), while `region:water`, `region:poi:the-murk`, and `region:poi:mist-falls` all report `{ count: 0, bytes: 0 }` due to remaining entries in `tools/lint/baseline.json`.
- **Audio Assets (`public/assets/audio/kr/`):** `122` `.ogg` files (**`3.10 MB` / `3,249,067 B`**) and `122` `.m4a` files (**`4.43 MB` / `4,640,651 B`**) covering `swim/*`, `amb/surf*`, `amb/underwater`, `amb/waterfall*`, `amb1/wave*`, `amb1/slap*`, `step/water*`, `imp/water*`.

---

## 5. Gameplay Simulation & Audio Integration

- **Swimming State & Depth Rules ([`shared/sim/const.ts`](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/shared/sim/const.ts)):** `WATER_LEVEL = 0`, enter swim at depth `SWIM_SURFACE = 1.35 m`, exit hysteresis `SWIM_LEAVE = 1.2 m`, float feet `SWIM_FLOAT_Y = -1.15 m`, duck-dive minimum `DIVE_MIN_DEPTH = 2.6 m`. Speeds: `SWIM = 4.8 m/s`, `SWIM_SPRINT = 6.0 m/s`, `SWIM_TREAD = 2.6 m/s`, `UW_SPEED = 4.2 m/s`, `UW_SPRINT = 5.4 m/s`, `UW_VERT = 3.2 m/s`, `UW_BUOY = 0.45 m/s`, `DIVE_KICK = 5.2 m/s`. Breath: `BREATH_S = 20 s` (refill `3.5 s`, pushes diver up when depleted — no drowning damage). Mantle from water onto docks/hulls between `SWIM_MANTLE_MIN = 0.15 m` and `SWIM_MANTLE_MAX = 2.35 m`.
- **Netcode Cost (`proto.ts`):** Adds `+16` bytes (`breath` + `swGun` as `f64`) to self-state packets only while `p.swim` is true.
- **Ballistics (`hitscan.hot.ts`):** `waterT()` analytically intersects bullet rays against the `y = WATER_LEVEL` plane and stops rounds on open water (`ground < -0.05`), giving divers full underwater bullet cover.
- **Vehicles (`vehicle.ts`, `heli.ts`):** Tuk-tuks experience progressive drag above `TUK.WADE = 0.3 m` (minimum `22%` speed factor) and flood/sink at `TUK.SINK = 1.05 m`; helicopters lose buoyancy / sink at `HELI.SINK = 0.3 m` and treat sea surface (`WATER_LEVEL - 0.15 m`) as minimum skid floor.
- **Storm Pathfinding (`storm.ts`):** Accounts for deep water traversal speed using `SWIM_PLAN = 3.2 m/s`.
- **Visual FX & Audio (`water-fx.ts`, `surf.ts`, `mixer.ts`, `ambience.ts`):** `WaterFx` pushes droplets into `InteractiveRipples` (`disturb`) and splash particles (`splash`); `SurfSync` aligns breaker/lap one-shots (`amb1/wave`, `amb1/slap`) with shoreline wave phase; `Mixer.setUnderwater()` sweeps `20 kHz → 450 Hz` exponential low-pass and `-6 dB` attenuation across world/ambience while crossfading `amb/underwater` (`near` bus bypasses muffle).

---

## 6. Empirical GPU, CPU, Draw Call & Frame Timings (RTX 5060)

> **Methodology Note:** Initial VSync-capped (`60 Hz`) testing showed NVIDIA P-state downclocking masking GPU differences (~15.5–16.3 ms across most views). Switching to uncapped Chromium (`--disable-gpu-vsync --disable-frame-rate-limit`) with unsmoothed per-frame `EXT_disjoint_timer_query_webgl2` queries exposed exact RTX 5060 GPU execution times down to `< 0.05 ms`.

### 6.1 Real-Match Helicopter Tour & Draw Census (`gpu-match.mts --route tour --segments heli`, `q=high`)

| Phase / Segment | Frame Interval p50 / p95 | GPU Frame p50 / p95 / p99 | CPU Step p50 / p95 | Effective FPS | Avg Calls / Tris (Census) |
|---|---:|---:|---:|---:|---|
| `gpu/match/warmup-15s` | `16.72 / 73.12 ms` | `7.50 / 14.96 / 35.43 ms` | `7.51 / 14.29 ms` | `34.53 FPS` | Warmup + compile/stream |
| `gpu/match/plane` | `16.66 / 16.90 ms` | `6.66 / 8.12 / 11.18 ms` | `8.06 / 9.78 ms` | `58.53 FPS` | — |
| `gpu/match/descent` | `16.67 / 17.97 ms` | `8.55 / 11.92 / 21.91 ms` | `10.90 / 14.70 ms` | `58.90 FPS` | — |
| `gpu/tour/heli` (59.25 s) | `17.65 / 28.45 ms` | **`10.41 / 14.75 / 30.19 ms`** | `15.35 / 21.59 ms` | `50.09 FPS` | `533` (p95 `825`) calls / `3.68M` (p95 `6.00M`) tris |

In the helicopter census (`2,969` frames), `submitMs` averaged `11.09 ms` (`567.7` draws total including shadows/aux): `water` averaged `2.0` draws (`water-mid` `0.062 ms`, `~water-spray` `0.015 ms`, plus `flotsam-crates` `0.028 ms` + `flotsam-foam` `0.030 ms`), `poi:the-murk` averaged `49.4` draws (`murk:water` `1.0` draw/`0.039 ms`, `murk:haze` `2.3` draws/`0.028 ms`), and `scene:override water-obstacle-cov:other-camera` averaged `0.04` calls/frame (`0.163 ms` amortized ≈ **`4.08 ms` CPU per active bake frame**).

### 6.2 Uncapped 1080p Water View Sweep (`bench-water-v2.json`, `q=high`, `1920×1080`)

| View Camera | FPS | GPU p50 | GPU p95 | CPU p50 | Draws | Triangles | Sea `grabVis` | `isUnderwater` |
|---|---:|---:|---:|---:|---:|---:|:---:|:---:|
| `biome-01-beach` | `151.8` | `6.44 ms` | `7.78 ms` | `6.3 ms` | `370` | `2,429,700` | `true` | `false` |
| `murk-aerial` | `177.9` | `6.29 ms` | `6.72 ms` | `5.8 ms` | `250` | `2,627,911` | `true` | `false` |
| `island-01-master-aerial` | `154.7` | `5.86 ms` | `7.08 ms` | `6.0 ms` | `364` | `1,894,475` | `true` | `false` |
| `poi-06-stilt-town` | `181.7` | `5.27 ms` | `6.53 ms` | `5.3 ms` | `370` | `3,131,248` | `true` | `false` |
| `poi-13-the-murk` | `189.3` | `5.05 ms` | `6.72 ms` | `5.0 ms` | `169` | `2,040,706` | `true` | `false` |
| `poi-12-mango-market` | `81.4` | `5.01 ms` | `17.77 ms` | `5.0 ms` | `164` | `1,867,988` | **`true`** | `false` |
| `poi-01-peel-harbor` | `233.3` | `4.96 ms` | `5.46 ms` | `4.0 ms` | `257` | `1,716,119` | `true` | `false` |
| `water-harbor-low` | `195.0` | `4.80 ms` | `5.95 ms` | `4.9 ms` | `206` | `1,574,343` | `true` | `false` |
| `poi-05-coconut-cove` | `216.1` | `4.51 ms` | `6.02 ms` | `4.4 ms` | `208` | `1,630,968` | `true` | `false` |
| `poi-09-mist-falls` | `202.3` | `4.45 ms` | `6.77 ms` | `4.7 ms` | `302` | `1,340,489` | `false` | `false` |
| `water-shallows-down` | `260.3` | `4.31 ms` | `5.62 ms` | `2.6 ms` | `132` | `1,229,174` | `true` | `false` |
| `poi-08-cnvs-lab` | `214.5` | `4.30 ms` | `6.39 ms` | `4.3 ms` | `231` | `1,391,973` | `true` | `false` |
| `falls-close` | `263.7` | `4.15 ms` | `4.80 ms` | `3.6 ms` | `304` | `1,387,126` | `false` | `false` |
| `cove-pool` | `230.3` | `4.11 ms` | `5.74 ms` | `4.2 ms` | `213` | `1,255,974` | `true` | `false` |
| `falls-pool` | `251.2` | `3.98 ms` | `4.52 ms` | `3.5 ms` | `303` | `1,255,471` | `false` | `false` |
| `water-sun-glitter` | `269.1` | `3.64 ms` | `4.36 ms` | `1.6 ms` | `114` | `739,550` | `true` | `false` |
| `water-cove-bay` | `285.9` | `3.60 ms` | `4.42 ms` | `2.8 ms` | `157` | `804,364` | `true` | `false` |
| `poi-02-the-wreck` | `289.5` | `3.22 ms` | `4.47 ms` | `3.1 ms` | `252` | `1,156,038` | `true` | `false` |
| `water-reef-low` | `332.6` | `2.75 ms` | `4.21 ms` | `2.8 ms` | `123` | `936,552` | `true` | `false` |
| `water-underwater` | `365.5` | `2.50 ms` | `4.15 ms` | `2.7 ms` | `113` | `976,987` | `true` | `true` |
| `water-underwater-up` | `386.5` | `2.34 ms` | `3.51 ms` | `2.3 ms` | `118` | `989,583` | `true` | `true` |

### 6.3 Total Marginal Cost of Global Water: 1080p vs. 4K (`q=high`)

| View | 1080p Base | 1080p `waterOff` | **1080p Water Cost** | 4K Base (`dpr=2`) | 4K `waterOff` | **4K Water Cost** |
|---|---:|---:|---:|---:|---:|---:|
| `water-harbor-low` | `4.79 ms` (`233 FPS`) | `3.61 ms` (`248 FPS`) | **`1.18 ms` (`24.6%`)** | `15.99 ms` (`71.3 FPS`) | `5.69 ms` (`147.9 FPS`) | **`10.30 ms` (`64.4%`)** |
| `poi-13-the-murk` | `4.51 ms` (`250 FPS`) | `3.38 ms` (`278 FPS`) | **`1.13 ms` (`25.1%`)** | — | — | — |
| `biome-01-beach` | `5.66 ms` (`174 FPS`) | `5.01 ms` (`159 FPS`) | **`0.65 ms` (`11.4%`)** | `10.62 ms` (`104.4 FPS`) | `6.17 ms` (`161.7 FPS`) | **`4.45 ms` (`41.9%`)** |
| `water-underwater` | `2.10 ms` (`484 FPS`) | `1.74 ms` (`560 FPS`) | **`0.36 ms` (`17.2%`)** | `8.22 ms` (`134.4 FPS`) | `5.31 ms` (`177.9 FPS`) | **`2.91 ms` (`35.4%`)** |
| `island-01-master-aerial` | `5.19 ms` (`181 FPS`) | `4.93 ms` (`173 FPS`) | **`0.26 ms` (`5.0%`)** | — | — | — |

### 6.4 URL Flag, Shader Architecture & Preset Ablations (1080p Uncapped, vs. `q=high`)

| Configuration | `biome-01-beach` GPU (Δ) | `water-harbor-low` GPU (Δ) | `water-underwater` GPU (Δ) | `island-01-master-aerial` GPU (Δ) | `poi-13-the-murk` GPU | Programs / Main Tris |
|---|---:|---:|---:|---:|---:|---|
| `q=high` (baseline) | `4.83 ms` (`—`) | `4.33 ms` (`—`) | `2.01 ms` (`—`) | `4.81 ms` (`—`) | `4.48 ms` | `236` / `50,432` |
| `q=low` (`WTR_LITE`) | `4.35 ms` (`-0.48 ms`) | `3.26 ms` (`-1.08 ms`) | `1.93 ms` (`-0.08 ms`) | `4.72 ms` (`-0.10 ms`) | — | `218` / `28,224` |
| `q=medium` | `4.79 ms` (`-0.04 ms`) | `3.51 ms` (`-0.82 ms`) | `1.82 ms` (`-0.20 ms`) | `4.83 ms` (`+0.02 ms`) | — | `227` / `50,432` |
| `q=ultra` | `5.27 ms` (`+0.45 ms`) | `4.73 ms` (`+0.40 ms`) | `2.04 ms` (`+0.03 ms`) | `5.53 ms` (`+0.72 ms`) | — | `236` / `50,432` |
| `?wnoscene=1` (no `SceneGrab` / SSR) | `4.57 ms` (`-0.25 ms`) | **`3.29 ms` (`-1.04 ms`)** | `2.38 ms` (`+0.37 ms`) | **`4.44 ms` (`-0.38 ms`)** | — | `236` / `50,432` |
| `?wfoampass=1` (split foam pass) | `4.84 ms` (`+0.02 ms`) | **`4.09 ms` (`-0.24 ms`)** | `1.96 ms` (`-0.05 ms`) | — | — | `235` / `50,432` ×2 |
| `?wnodual=1` (3-pass fallback) | `4.96 ms` (`+0.13 ms`) | **`3.91 ms` (`-0.42 ms`)** | `2.38 ms` (`+0.36 ms`) | — | — | `236` / `50,432` ×3 |
| `?wprepass=1` (depth prepass) | **`5.57 ms` (`+0.74 ms`)** | `4.19 ms` (`-0.14 ms`) | — | `5.06 ms` (`+0.25 ms`) | — | `237` / `50,432` ×2 |
| `?wcells=32` (`-75%` mesh tris) | `4.89 ms` (`+0.07 ms`) | `4.52 ms` (`+0.18 ms`) | — | `4.71 ms` (`-0.10 ms`) | — | `236` / `12,416` |
| `?murknoscene=1` (Murk grab off) | `5.32 ms` | — | — | — | **`4.12 ms` (`-0.36 ms`)** | `234` / `50,432` |

**Sub-Pass Runtime Toggle Highlights (`[2/4]`):**
- Turning off **`water-occluder`** (`noOcc`) on `biome-01-beach` increased GPU p50 from `5.66 → 6.22 ms` (**`+0.57 ms`** slower without early-Z disc occlusion). On `water-harbor-low`, where nearby piers/structures break depth continuity, `water-occluder` cost vs. benefit varied (`4.79 → 4.24 ms` when `noTile` was followed by `noOcc`).
- Disabling **`SceneGrab` copy only** (`noGrab` / `noColour` at `water-harbor-low` while `WTR_SCENE` stays in the shader) saved **`~0.50 ms`**, while disabling both the copy AND the in-shader SSR/refraction (`?wnoscene=1`) saved **`1.04 ms`** — splitting the `WTR_SCENE` cost almost evenly (**`~0.5 ms` blit bandwidth + `~0.5 ms` SSR raymarch & refraction ALU/tex at 1080p**, scaling to **`~8–9 ms` combined at 4K**).

---

## 7. Prioritized Water Optimization Roadmap (`perf/water-optimization`)

### Tier 1 — High-Impact GPU & Frame-Time Wins

1. **Restore & Upgrade `SceneGrab` Horizon Row-Clipping (`grab.rows`) + Half-Res / Smart Triggering**
   - **Finding:** `index.ts:273` hardcodes `grab.rows = 1;`, forcing a full-viewport (`1080p` / `4K`) HDR color + depth blit on every frame with any visible water pixel. Even in `poi-12-mango-market` (`grabVis=true`), a tiny distant water sliver triggers a full-screen FBO copy. Meanwhile at 4K `water-harbor-low`, `WTR_SCENE` consumes the bulk of water's `10.30 ms` GPU time.
   - **Optimization:** Compute exact projected water screen bounds (horizon `y` + lowest clipmap vertex or screen bounding rect of visible coastal water) to set `grab.rows` dynamically (`30–60%` immediate blit reduction); downsample/half-res SSR reflection or trace at half-res; and automatically disable `SceneGrab` (`WTR_SCENE` bypass) whenever camera altitude exceeds refraction/SSR range (`> 120 m`, or when only distant `dist > 320 m` water is visible).
   - **Estimated Savings:** **`0.4–0.9 ms` GPU at 1080p**, **`4–6 ms` GPU at 4K**, plus **`~10–50 MiB` VRAM** if half-res color/depth grab is adopted on `medium`/`low`.

2. **Eliminate Double Rendering & Duplicate `SceneGrab` in The Murk (`the-murk/water.ts`)**
   - **Finding:** Inside `poi-13-the-murk`, **global sea water costs `1.13 ms` (`25.1%`) GPU underneath the swamp**, while `murk:water` draws on top with its own **second full-screen `SceneGrab`** (`?murknoscene=1` saves **`0.36 ms`** even at 1080p). Moreover, because `murk:water` sets `frustumCulled = false` and `murk:haze` sits at `renderOrder = 1000`, **both execute unconditionally on every frame across the entire island** (observed in `biome-01-beach`, `poi-05-coconut-cove`, `poi-09-mist-falls`, and `water-underwater`).
   - **Optimization:** Enable `frustumCulled = true` with tight world bounding spheres/distance gates (`> 260 m`) on `murk:water` and `murk:haze`; share the global sea `SceneGrab` instead of allocating a second FBO copy in `the-murk/water.ts`; and add a Murk exclusion mask/discard or depth clip to global sea `water-main` inside The Murk basin so both water surfaces never double-shade the same pixels.
   - **Estimated Savings:** **`~1.0–1.5 ms` GPU inside The Murk**, **`-20 MiB` (`1080p`) / `-80 MiB` (`4K`) VRAM**, and eliminates `2–3` wasted draw calls globally across all other POIs.

3. **De-bloat Main Water Fragment Shader / Decouple `FOAM_STACK` (`WTR_FOAMMAIN`)**
   - **Finding:** Empirical testing proved that pulling `FOAM_STACK` out of the main `water` shader (`?wfoampass=1` and `?wnodual=1`) *beat* the merged `WTR_FOAMMAIN` pass at `water-harbor-low` (**`4.09 ms`** and **`3.91 ms`** vs **`4.33 ms`**) because high VGPR count from `FOAM_STACK` lowers SM occupancy on *every* deep-water fragment even when `anyFoam == false`.
   - **Optimization:** Split `FOAM_STACK` onto nearshore rings/cells (`foamMesh` with `drawRange` limited to near/shore rings `0..3` instead of all `50,432` triangles!) OR create a dedicated shallow/shore shader variant without `FOAM_STACK` in open deep ocean tiles.
   - **Estimated Savings:** **`0.25–0.45 ms` GPU at 1080p**, **`~1.5–2.5 ms` GPU at 4K**, with far fewer redundant foam shading pixels.

4. **Frustum-Cull / Range-Gate `water-spray` (`8,528` Quads) and `flotsam`**
   - **Finding:** `water-spray` (`frustumCulled = false`, `17,056` tris), `flotsam-crates`, and `flotsam-foam` draw even underground/underwater (`water-underwater`) and in inland POIs (`poi-09-mist-falls`, `poi-12-mango-market`). Even though `spray`'s vertex shader collapses quads beyond `340 m`, the GPU still processes `34,112` vertices every frame.
   - **Optimization:** Partition `water-spray` into spatial cells / sectors (matching world terrain grid or 4 coastal quadrants) with `frustumCulled = true`, and toggle `visible = false` when camera distance `> 360 m` from the coast (`shoreDistanceAt`) or underwater. Do the same `visible` / distance gate on `flotsam` and inland `mist-falls`/`cnvs-lab` particle puffs.

### Tier 2 — VRAM, Allocation & Hitch Reductions

5. **Downsize & Lifecycle-Scope `ObstacleBake` Targets (`98.00 MiB` → `~12–25 MiB`)**
   - **Finding:** `ObstacleBake` allocates **four `4096×4096` render targets** (`rtA` `32 MiB`, `rtP` `16 MiB`, `rtB` `16 MiB`, `rtC` `32 MiB`) plus `rtW1`/`rtW2` (`2 MiB`) — **`98.00 MiB` permanent GPU memory** (`~0.5 m`/texel over `2.05 km`). Even on `rtB` (EDT/ping-pong intermediate), full `4096²` is held forever after the initial bake finishes!
   - **Optimization:** Free transient bake RTs (`rtA`, `rtP`, `rtB`) via `withScope` after initial island obstacle baking completes (keeping only `rtC` `wtrObstacle`, or dropping `4096²` → `2048²` by default at `medium`/`high`, reserving `4096²` for `epic`/`ultra` or packing foam + cover efficiently). Reduce dynamic `maybeBake` re-bake trigger frequency when camera moves across already-streamed cells so `~4.08 ms` CPU override spikes (`scene:override water-obstacle-cov:other-camera`) never fire mid-combat.
   - **Estimated Savings:** **`64–86 MiB` GPU VRAM** saved (`~40–55%` of total global sea VRAM) and fewer CPU bake frame spikes.

6. **Free CPU Mirrors After Worker/Texture Upload (`FoamMask` & `WaterFields`)**
   - **Finding:** `FoamMask` retains a `2048×2048` 2D `<canvas>` (`16 MiB`) + `Uint8Array` (`4 MiB`) + R8 GPU copy (`4 MiB`), while `WaterFields` allocates `1201×1201` backing buffers alongside `27.50 MiB` GPU `RGBA16F`/`RGBA8`. Most `registerFoam*` callers (coconut cove, peel harbor, the wreck, stilt town, lobby islet) finish during POI module build before `afterBuild` completes.
   - **Optimization:** Replace `FoamMask` canvas compositing with direct `Uint8Array` rasterization (`-16 MiB` CPU bitmap), drop/compact unnecessary CPU field buffers once `depthAt` / `shoreDistanceAt` only require compact height/shore lookups, and move `client/src/world/water/`, `the-murk/water.ts`, `mist-falls/water.ts`, and `jungle-water.ts` onto `Scope` ownership to retire their entries in `tools/lint/baseline.json` (`docs/resources.md`).

### Tier 3 — Secondary & Quality-of-Life Optimizations

7. **Optimize Underwater Caustics Generation (`WaveTile` `300×300` × 2 Passes = `360,000` Tris)**
   - **Finding:** Underwater frames (`water-underwater`, `water-underwater-up`) execute `WaveTile`'s `300×300` vertex refraction mesh twice (`360,000` tris) + tent blur every 33–50 ms (`p95` jumps from `2.1 ms` → `4.15 ms` on update frames).
   - **Optimization:** Lower default grid (`200` → `128`, matching `low` preset) or compute analytical Worley/Gerstner caustics directly in fragment (`wtrTex2` already contains a baked Worley caustic SDF!), eliminating the `360,000`-triangle RT pass and `2.00 MiB` `causTmp` RT completely.

8. **Throttle / Cull Far POI Water Draws (`mist-falls`, `coconut-cove`, `mango-market`, `coco-caves`)**
   - **Finding:** At East Beach (`biome-01-beach`), `poi:mist-falls` submits `42` draw calls (`0.409 ms` CPU, including `jungle-river-chunk` and `falls-rainbow-mist`); `caves-pool` inside `coco-caves` carries `29,360` triangles (`40,401` verts) for an interior cavern pool.
   - **Optimization:** Ensure stricter HLOD / distance culling on `jungle-river`, `jungle-falls`, and `falls-rainbow-mist`, and decimate `caves-pool` (`40,401` → `< 4,000` verts) without visual change.

9. **Gate `InteractiveRipples` (`2× 256²` `RGBA16F`) & Expose Player Water Quality Setting**
   - **Finding:** Water scales only off coarse overall `engine.quality` (`low` vs `medium`/`high`/`ultra`), leaving `high` & `medium` running nearly identical full-res `SceneGrab`, `50k` clipmap triangles, and `4096²` `ObstacleBake` (no player-facing Water Quality toggle in `Display` settings yet).
   - **Optimization:** Skip binding/sampling `wtrSim` (`InteractiveRipples`) in the shader when `ripples.active == false` or camera height `> 60 m`, and add an independent Water Quality setting (`Low / Medium / High`) controlling `SceneGrab` SSR/resolution, clipmap `cells` (`32`/`48`/`64`), `FOAM_STACK` LOD, and `ObstacleBake` resolution (`2048` vs `4096`).
