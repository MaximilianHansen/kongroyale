# Kong Royale — Water Performance Optimization Implementation Report

> **Branch:** `perf/water-optimization` (diff over base commit `28a6991` / [docs/water-optimization-research.md](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/docs/water-optimization-research.md))  
> **Test Environment:** NVIDIA GeForce RTX 5060 (ANGLE D3D11, `EXT_disjoint_timer_query_webgl2`, `WEBGL_blend_func_extended` dual-source active), Windows 11, Chrome  
> **Scope:** `19` modified files ([client/src/world/water/](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/index.ts), [client/src/world/pois/the-murk/](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/the-murk/water.ts), [tools/lint/baseline.json](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/tools/lint/baseline.json)); budget files ([tools/size-budgets.json](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/tools/size-budgets.json), `tools/memory-*.json`) and `shared/` remain untouched.

---

## 1. Executive Summary

Water rendering and lifecycle optimizations across global ocean water and **The Murk** were completed, audited, and stabilized with the following verified outcomes over baseline `28a6991`:

- **Interleaved `1920×1080` (`q=high`) GPU Timing (RTX 5060, `--disable-gpu-vsync --disable-frame-rate-limit`):**
  - Previously reported ~`14.5%` regressions on `biome-01-beach` and `water-underwater` were eliminated after resolving three root causes (60 Hz idle GPU clocking in non-interleaved runs, 4-ray corner clipping in `waterGrabBounds` on horizon-straddling views, and an ANGLE `GL_INVALID_OPERATION (1282)` state leak in `dualsrc.ts`).
  - Across post-fix interleaved runs, `poi-13-the-murk` improved **`-19.1%`** (`4.149 → 3.356 ms` p50), `water-harbor-low` **`-6.9%`** (`4.305 → 4.009 ms`), `water-shallows-down` **`-5.7%`** (`4.309 → 4.065 ms`), `water-underwater-up` **`-5.5%`** (`2.182 → 2.061 ms`), `island-01-master-aerial` **`-2.9%`** (`4.750 → 4.610 ms`), `poi-09-mist-falls` **`-1.9%`** (`3.790 → 3.718 ms`), and `biome-01-beach` **`-0.6%`** (`5.295 → 5.264 ms`), while `water-underwater` remained statistically flat within round-to-round variance (**`+2.1%` / `+0.044 ms`**: `2.041 → 2.085 ms` p50, `p95 -0.5%`, isolated `water` `-30.5%`).
- **Actual Memory & Resource Ownership (`verify-memory`, Windows Chrome D3D11 `1600×900`):**
  - Controlled `?resaudit` title-modules 3-match comparison: `webglMB` dropped **`1290.9 → 1224.3 MB` (`-66.6 MB`)** at `title` and **`1819.4 → 1752.2 MB` (`-67.2 MB`)** in `warmup` (`textureMB` **`-66.0 MB`**, `-5` textures across every phase); `textureCpuMB` dropped **`281.1 → 245.7 MB` (`-35.4 MB`)** at `title` and **`316.2 → 285.7 MB` (`-30.5 MB`)** in `warmup`.
  - Scope ownership (`ownedMB`) rose **`595.2 → 666.7 MB` (`+71.5 MB`)** while `unownedMB` dropped **`1201.0 → 1064.4 MB` (`-136.6 MB`, `-21` unowned resources at `title`, `-22` at `left3`)**. Match-to-match leak (`left2 → left3`) stayed unchanged (`webglMB +2.1 → +2.1 MB`, `0` leaked textures, `0` owned ledger growth).
- **Download Size Compliance (`check-size`):**
  - `entry` (`34,353 / 34,371 B gz`), `boot` (`1,164,034 / 1,164,042 B gz`), `workers` (`3,075,015 / 3,075,025 B gz`), and **`lazy` (`3,069,097 / 3,069,111 B gz`, `+157 B` vs `28a6991`'s `3,068,940 B` baseline)** all pass against untouched [tools/size-budgets.json](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/tools/size-budgets.json).
- **Visual & Underwater Verification:**
  - All 6 above-water, harbor, waterfall, aerial, and Murk views at `1920×1080` match baseline closely (`meanAbs 0.025–0.574`, `pctGt5 0.03%–0.35%`). Underwater views animate caustics, surface cutouts, and marine snow cleanly with zero WebGL errors (`err: 0`), trading slightly softer foreground seabed caustics filaments (`meanAbs 7.73–8.73` at `128` grid / `1/30 s` on `high` vs baseline `200` grid / every frame).

---

## 2. Implemented Changes & Stabilization Fixes

| Area | Primary Files | Key Implementation & Review Fixes |
|---|---|---|
| **`SceneGrab` & SSR** | [grab.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/grab.ts), [index.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/index.ts), [shader.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/shader.ts), [material.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/material.ts) | Dynamic `waterGrabBounds` intersecting all 8 frustum corners and 12 edges against `[level - amp, level + amp]` (replacing the initial 4-corner check that clipped horizon-straddling views like `biome-01-beach` to `grabRows = 0`); resolution-scaled grab (`0.5×` on `low`/`medium`, `1×` on `high`/`ultra`); `cdFbo` combined color+depth FBO blit (`#copyDepth`); clip-space SSR interpolation (`cp0`/`cpDir`) clamped to `wtrGrabMaxV`; `WTR_LOW`/`WTR_LITE`/`WTR_ULTRA` step tiers. |
| **The Murk Culling & Shared Grab** | [the-murk/water.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/the-murk/water.ts), [the-murk/fx.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/the-murk/fx.ts), [the-murk/index.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/pois/the-murk/index.ts) | Shares `ctx.shared.get("waterGrab")` via `request`/`ensureCopied`; frustum/distance culls `murk:water` and restricts `murk:haze` visibility to swamp range; adds `wtrMurkOwned` ocean discard inside the swamp core; scales Murk SSR steps by quality preset. |
| **Nearshore Foam Split & Shader Helpers** | [shader.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/shader.ts), [index.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/index.ts) | Splits `FOAM_STACK` into `water-foam` (`levels 0..6`, skipping level 7 & horizon skirt), while keeping `WTR_FOAMMAIN` configurable; keeps `wtrSuv()` in `FRAG_PARS` so `kr-water-foam` compiles cleanly without `#include <clipping_planes_pars_fragment>`; guards `CONTACT_COLLAR` sampling (`dist < 110.0 && dFg > 0.22`) in `FRAG_FOAM`; factors `wtrCw()` chop helper. |
| **`ObstacleBake` Lazy Scratch Targets** | [obstacles.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/obstacles.ts), [index.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/index.ts) | Retains only final `rtC` permanently (`4096²` / `32 MiB` on `high`/`ultra`, `2048²` / `8 MiB` on `medium`/`low`) and lazily allocates/disposes intermediate `rtA`, `rtW2` scratch targets via child scopes; preserves previous `rtC` during incremental `!fromScratch` rebakes (`uPass > 2.5`) and throttles rebakes. |
| **`Spray` & `Flotsam` Culling** | [spray.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/spray.ts), [flotsam.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/flotsam.ts) | Partitions spray into `300 m` XZ sectors with AABB distance/frustum/underwater/aerial culling; updates `Flotsam` with `aFlId`/`aFcId` frustum & `340 m` distance culling without per-tick allocations. |
| **Underwater, Dual-Source Fix & Caustics** | [dualsrc.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/dualsrc.ts), [underwater.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/underwater.ts), [wavetile.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/wavetile.ts) | Merges underwater absorption/fog into one `WTR_DUAL_SRC` pass with non-dual fallback; lazily allocates/frees `caustics-tmp` when surfacing (`releaseCausticsScratch`); precomputes `uHit0` and scales caustics grids/cadence by preset. **Bug fix in `dualsrc.ts`:** hooks `gl.disable` (`bfs(1, 0, 1, 0)` when `BLEND && src1`) and `gl.enable` (`bfs(sSr, SRC1, sSa, sDa)`) so ANGLE D3D11 never hits `GL_INVALID_OPERATION (1282)` on subsequent non-blended FBO `drawArrays` after `water-underwater-volume` (`renderOrder = 9999`), which had blacked out the underwater foreground seabed. |
| **`Scope` Ownership, Worker Scopes & CPU Releases** | [bakeclient.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/bakeclient.ts), [fields.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/fields.ts), [textures.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/textures.ts), [interact.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/interact.ts), [skyirr.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/skyirr.ts), [tools/lint/baseline.json](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/tools/lint/baseline.json) | Registers water and Murk targets, textures, geometries, and workers under `Scope` (`-46` lines removed from `tools/lint/baseline.json`); allocates `1×1` placeholder field textures with `releaseAfterUpload` (`fields.ts`); fixes concurrent bake scope collision in `bakeclient.ts` using unique `workerScope.child(\`job-\${id}\`)`. |

### Quality Preset Parameters (Verified in Built Bundle)

| Parameter | `low` | `medium` | `high` | `ultra` |
|---|---|---|---|---|
| Clipmap cells/level (`wcells`) | `48` | `56` | `64` | `64` |
| Main SSR shader (`WTR_SSR_N / G / R`) | `WTR_LOW` (`6 / 1.95 / 2`) | `WTR_LITE` (`9 / 1.65 / 3`) | Default (`20 / 1.3 / 3`) | `WTR_ULTRA` (`24 / 1.24 / 4`) |
| `SceneGrab.scale` | `0.5` | `0.5` | `1.0` | `1.0` |
| `ObstacleBake` pierce / final `rtC` | `2048 / 2048` | `4096 / 2048` | `4096 / 4096` | `4096 / 4096` |
| Baked field resolution / array & tile aniso | `256` / `2× & 2×` | `512` / `4× & 4×` | `512` / `4× & 8×` | `512` / `8× & 8×` |
| Caustics target / grid / interval | `1×1` / `0` / disabled | `256²` / `96` / `1/20 s` | `512²` / `128` / `1/30 s` | `512²` / `160` / `1/30 s` |
| `WaveTile` cadence / `Spray` cap | `1/16 s` / `1,200` | `1/20 s` / `1,800` | `1/24 s` / `2,400` | `1/30 s` / `2,400` |
| Murk SSR mode | Off (`reflMap` fallback) | Shared grab (`6` steps, `1.75×`) | Shared grab (`9` steps, `1.75×`) | Shared grab (`12` steps, `1.5×`) |

---

## 3. Investigation of the `1080p` Regressions & Reproducible GPU Results

### Why Earlier `1080p` Runs Showed ~`14.5%` Slowdowns

1. **VSync Idle Clocking & Non-Interleaved Drift:** Earlier standalone runs drove frames at 60 Hz `rAF` without `--disable-gpu-vsync --disable-frame-rate-limit`. At `~2–5 ms` `1080p` GPU work, the RTX 5060 repeatedly dropped into low-clock P8 idle states between frames (producing `~16 ms` spikes and `stdev` up to `4.9 ms`), skewing `biome-01-beach` and `water-underwater` comparisons depending on boost history.
2. **Horizon-Straddling `waterGrabBounds` Clipping:** The initial 4-corner frustum test set `grabRows = 0, grabSkip = true` when top rays missed the sea plane above the horizon and bottom rays crossed near `v = 0` (`biome-01-beach`), omitting near reflections/grabbed depth until replaced by exact 8-corner + 12-edge frustum-slab intersection.
3. **Broken Underwater Shading (`dualsrc.ts` `GL_INVALID_OPERATION 1282`):** Until `gl.disable`/`gl.enable` reset `BLEND_DST_RGB` off `SRC1_COLOR_WEBGL`, `water-underwater` threw GL errors on subsequent non-blended FBO draws and shaded a blacked-out foreground seabed, making pre-fix timing non-comparable.

### Post-Fix Interleaved `1920×1080` Results (`q=high`, `seed=42`, RTX 5060 ANGLE D3D11)

Both arms (`28a6991` baseline vs current working tree) served production `dist/` builds locally and alternated rounds in the same Chrome process (`--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist --disable-gpu-vsync --disable-frame-rate-limit`), settled for 60 frames with `vegsplat=0&atmos=notaa&dpr=1` and verified identical `camPos`/`camQuat` and `errors: []` on every arm:

- **`ab-deep-postfix`:** `6` rounds × `300` ON + `120` OFF frames (`n=1800` valid ON samples per arm).
- **`ab-rest-postfix`:** `4` rounds × `240` ON + `120` OFF frames (`n` = valid non-disjoint resolved GPU timer queries out of `960`).

| View | `n` (Base / Opt) | Base p50 → Opt p50 (ms) | p50 Delta | Base → Opt p95 (ms) | Base / Opt IQR (ms) | Base / Opt stdev (ms) | Base → Opt `offP50` (ms) | Base → Opt Isolated Water (ms) |
|---|---:|---|---|---|---:|---:|---|---|
| `biome-01-beach` | `1800 / 1800` | `5.295 → 5.264` | `-0.031 (-0.6%)` | `6.758 → 6.718` (`-0.6%`) | `0.989 / 0.940` | `1.009 / 0.924` | `4.492 → 4.509` | `0.803 → 0.755` (`-5.9%`) |
| `water-underwater` | `1800 / 1800` | `2.041 → 2.085` | `+0.044 (+2.1%)` | `3.087 → 3.071` (`-0.5%`) | `0.512 / 0.547` | `0.451 / 0.463` | `1.819 → 1.930` | `0.222 → 0.155` (`-30.5%`) |
| `water-underwater-up` | `1800 / 1800` | `2.182 → 2.061` | `-0.120 (-5.5%)` | `3.223 → 3.004` (`-6.8%`) | `0.499 / 0.454` | `0.478 / 0.415` | `1.886 → 1.791` | `0.296 → 0.271` (`-8.5%`) |
| `poi-13-the-murk` | `550 / 960` | `4.149 → 3.356` | **`-0.793 (-19.1%)`** | `5.367 → 4.467` (`-16.8%`) | `0.754 / 0.635` | `0.556 / 0.526` | `3.583 → 3.204` | `0.566 → 0.152` (`-73.2%`) |
| `water-harbor-low` | `404 / 507` | `4.305 → 4.009` | **`-0.296 (-6.9%)`** | `5.104 → 4.980` (`-2.4%`) | `0.706 / 0.542` | `0.406 / 0.433` | `2.691 → 2.231` | `1.614 → 1.778` (`+10.2%`) |
| `water-shallows-down` | `159 / 150` | `4.309 → 4.065` | **`-0.244 (-5.7%)`** | `4.747 → 4.461` (`-6.0%`) | `0.726 / 0.809` | `0.399 / 0.474` | `1.538 → 1.553` | `2.771 → 2.512` (`-9.4%`) |
| `island-01-master-aerial` | `960 / 960` | `4.750 → 4.610` | `-0.140 (-2.9%)` | `5.993 → 5.722` (`-4.5%`) | `0.894 / 0.896` | `1.564 / 1.687` | `4.228 → 4.180` | `0.522 → 0.430` (`-17.6%`) |
| `poi-09-mist-falls` | `529 / 518` | `3.790 → 3.718` | `-0.073 (-1.9%)` | `4.518 → 4.450` (`-1.5%`) | `0.566 / 0.566` | `0.367 / 0.359` | `3.507 → 3.648` | `0.283 → 0.070` (`-75.4%`) |

*Notes:* Earlier non-interleaved pre-fix `1440p`, `4K`, and preset sweep tables were omitted rather than mixing incomparable pre-fix/un-interleaved runs with post-fix interleaved runs. On `water-underwater`, per-round p50 deltas spanned `-10.0%` (`-0.223 ms`) to `+10.3%` (`+0.204 ms`), indicating statistical parity on overall GPU frame time (`+0.044 ms`) despite a `-30.5%` reduction in `setOff`-isolated water time. On `island-01-master-aerial`, `grabRows` dropped `1 → 0` and `grabSkip` switched `false → true`. Active WebGL program counts (`diag.programs`) dropped across every view (`242 → 237` beach, `172 → 167` harbor, `175 → 174` murk, `142 → 132` underwater, `152 → 142` underwater-up, `233 → 224` aerial, `165 → 156` mist-falls, `141 → 134` shallows).

---

## 4. Matched Visual & Underwater Caustics Motion Audit (`1920×1080`, `q=high`, `seed=42`)

Matched `shot=1` screenshots captured at identical camera pose and timestamps (`0` console/page/WebGL errors on both `base` and `cand`) establish:

### Static Surface, Harbor, Waterfall, Murk & Aerial Diffs (`t = 12.00`)

| View | Mean Abs Channel Diff | RMS Diff | `% Pixels > 5` | `% Pixels > 20` | Max Channel Diff |
|---|---:|---:|---:|---:|---:|
| `biome-01-beach` | `0.025` | `1.054` | `0.07%` | `0.02%` | `209` |
| `water-harbor-low` | `0.032` | `1.501` | `0.10%` | `0.05%` | `234` |
| `poi-09-mist-falls` | `0.046` | `0.350` | `0.17%` | `0.00%` | `17` |
| `poi-13-the-murk` | `0.400` | `0.801` | `0.35%` | `0.00%` | `74` |
| `island-01-master-aerial` | `0.500` | `1.236` | `0.03%` | `0.02%` | `190` |
| `water-shallows-down` | `0.574` | `2.886` | `0.23%` | `0.11%` | `221` |

### Underwater Views & Motion Sequence (`t = 12.00, 12.15, 12.30, 12.45`)

- **Matched Timestamp A/B (`base` vs `cand`):**
  - `water-underwater`: `meanAbs 7.726` (`12.00`) → `8.276` (`12.15`) → `8.382` (`12.30`) → `8.729` (`12.45`); `pctGt5 29.96%..31.32%`, `pctGt20 16.09%..17.49%`.
  - `water-underwater-up`: `meanAbs 3.771` (`12.00`) → `3.886` (`12.15`) → `3.929` (`12.30`) → `4.098` (`12.45`); `pctGt5 11.34%..11.85%`, `pctGt20 6.68%..7.64%`.
- **Consecutive `0.15 s` Frame Motion (`t -> t + 0.15`):**
  - `water-underwater`: `base meanAbs 7.923 / 7.170 / 7.403` (`pctGt20 15.48% / 14.16% / 14.10%`) vs `cand meanAbs 5.583 / 5.264 / 5.722` (`pctGt20 9.44% / 9.01% / 10.38%`).
  - `water-underwater-up`: `base meanAbs 7.056 / 6.396 / 6.276` (`pctGt20 16.46% / 15.40% / 14.20%`) vs `cand meanAbs 6.000 / 5.684 / 5.672` (`pctGt20 13.93% / 13.64% / 13.06%`).
- **Genuine Visual Tradeoffs (Not "Identical Visuals"):** Visual inspection confirms intact Snell's window, volumetric shafts, water attenuation gradients, marine snow, and live seabed caustics motion across every `0.15 s` step. However, reducing `WaveTile` caustics on `high` (`128` grid at `1/30 s` vs baseline `200` grid every frame) softens sharp fine bright caustics filaments on close seabed slopes (`meanAbs ~8`), while `low` disables refracted caustics (`grid = 0`) and `low`/`medium` halve `SceneGrab` (`0.5×`) and final `ObstacleBake` resolution (`2048²`).

---

## 5. Before-and-After Memory Audit (`verify-memory`) & CI Calibration

All memory figures below were measured directly with [tools/performance/memory.mts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/tools/performance/memory.mts) (`--profile win --channel chrome --viewport 1600x900`, `seed=42`, `0` errors) against both `28a6991` and the current build (not derived from budget ceilings):

### Controlled Title-Modules Warm-up & Resource Ownership (`?resaudit&modules=atmos,terrain,water,veg,poi:lobby-islet,showcase,weapons-showcase,gameplay-stage`, `--warmup --matches 3`)

| Phase | `webglMB` (Base → Opt) | `textureMB` (Base → Opt) | `textureCount` | `bufferMB` (Base → Opt) | `textureCpuMB` (Base → Opt) | `ownedMB` (Base → Opt) | `unownedMB` (`unownedCount`) |
|---|---|---|---|---|---|---|---|
| `title` | `1290.9 → 1224.3` (**`-66.6`**) | `1120.1 → 1054.1` (**`-66.0`**) | `264 → 259` (`-5`) | `135.3 → 134.8` (`-0.5`) | `281.1 → 245.7` (**`-35.4`**) | `595.2 → 666.7` (`+71.5`) | `1201.0 (830) → 1064.4 (809)` (`-136.6 MB`, `-21`) |
| `warmup` | `1819.4 → 1752.2` (**`-67.2`**) | `1586.7 → 1520.7` (**`-66.0`**) | `348 → 343` (`-5`) | `191.5 → 190.3` (`-1.2`) | `316.2 → 285.7` (**`-30.5`**) | `598.1 → 669.6` (`+71.5`) | `1283.7 (1374) → 1147.0 (1352)` (`-136.7 MB`, `-22`) |
| `left1` | `1849.4 → 1782.2` (`-67.2`) | `1626.4 → 1560.4` (`-66.0`) | `346 → 341` (`-5`) | `181.8 → 180.6` (`-1.2`) | `314.6 → 284.0` (`-30.6`) | `596.3 → 667.9` (`+71.6`) | `1311.8 (1341) → 1175.0 (1319)` (`-136.8 MB`, `-22`) |
| `left2` | `1849.5 → 1782.3` (`-67.2`) | `1626.4 → 1560.4` (`-66.0`) | `346 → 341` (`-5`) | `181.9 → 180.7` (`-1.2`) | `314.6 → 284.0` (`-30.6`) | `596.3 → 667.9` (`+71.6`) | `1311.7 (1341) → 1175.0 (1319)` (`-136.7 MB`, `-22`) |
| `left3` | `1851.6 → 1784.4` (`-67.2`) | `1626.4 → 1560.4` (`-66.0`) | `346 → 341` (`-5`) | `184.0 → 182.8` (`-1.2`) | `314.6 → 284.0` (`-30.6`) | `596.3 → 667.9` (`+71.6`) | `1311.9 (1346) → 1175.2 (1324)` (`-136.7 MB`, `-22`) |
| `leak` (`left2→left3`) | `+2.1 → +2.1` | `—` | `0 → 0` | `—` | `—` | `0` ledger growth | `0.2 (5) → 0.2 (5)` |

### Full-Island 2-Match Run (`--matches 2 --match-secs 30`, `1600×900`)

- `match`: `webglMB` `4024.0 → 3955.5 MB` (`-68.5 MB`), `textureMB` `2633.1 → 2575.5 MB` (`-57.6 MB`), `bufferMB` `1349.7 → 1338.8 MB` (`-10.9 MB`), `textureCpuMB` `471.2 → 443.5 MB` (`-27.7 MB`), `GPUMB` `7392.1 → 7297.5 MB` (`-94.6 MB`), `totalMB` `10883.8 → 10797.3 MB` (`-86.5 MB`).
- `match2`: `webglMB` `4112.1 → 4031.2 MB` (`-80.9 MB`), `textureMB` `2714.3 → 2645.2 MB` (`-69.1 MB`), `textureCpuMB` `436.5 → 408.8 MB` (`-27.7 MB`; `typed array` mirrors `61.9 → 31.4 MB`), `GPUMB` `7561.9 → 7439.2 MB` (`-122.7 MB`), `totalMB` `11048.7 → 10926.5 MB` (`-122.2 MB`).
- *(At un-scoped full-island `title`, background POI streaming loaded different POIs at sample time—`the-plantation` vs `mango-market`—causing non-deterministic `title` deltas; deterministic per-resource gains are reflected in the controlled `?resaudit` run above.)*
- **CI Memory Budget Calibration:** `tools/memory-budgets.json`, `tools/memory-warmup-budgets.json`, `tools/memory-lowmem-budgets.json`, and `tools/memory-leak-budgets.json` remain untouched locally (`nogpu` SwiftShader runs could not execute locally without `chromium_headless_shell`, and per `verify-memory`, budgets must be calibrated from CI's `memory-result` and `memory-lowmem-result` artifacts). Because controlled reductions exceed `underPct: 5` (`title.webglMB -5.16%`, `title.textureMB -5.89%`, `title.textureCpuMB -12.6%`, `warmup.textureCpuMB -9.6%`), CI budget recalibration from CI artifacts will be required when landing the PR.

---

## 6. Download Size Breakdown & Compliance (`check-size`)

| Bucket | Baseline `28a6991` (B gz) | Current Build (B gz) | Budget (`tools/size-budgets.json`) | Margin |
|---|---:|---:|---:|---:|
| `entry` | `34,353` | `34,353` | `34,371` | `-18 B` |
| `boot` | `1,164,034` | `1,164,034` | `1,164,042` | `-8 B` |
| `workers` | `3,075,015` | `3,075,015` | `3,075,025` | `-10 B` |
| **`lazy`** | `3,068,940` | **`3,069,097`** | `3,069,111` | **`-14 B`** |

- **Why `lazy` increased initially and how compliance was restored:** Comparing compiled Vite chunks (`dist/assets/` vs `28a6991`) showed `+320 B gz` in the `grab` chunk (`2,270 → 2,590 B gz`, normalized refs) from shared-grab synchronization (`request`, `ensureCopied`), downsampling `scale`, combined `cdFbo` depth+color blitting, and `#` private field renaming reducing gzip token repetition despite slightly fewer raw bytes (`7,019 → 6,965 B`), alongside growth in `the-murk` (`wtrMurkOwned`/frustum culling/SSR presets). Factoring `wtrCw()`, removing dead scratch targets (`#rtP`/`#rtB`/`#rtW1`) and unused wrapper state in [water/index.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/index.ts), [obstacles.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/obstacles.ts), [fields.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/fields.ts), [dualsrc.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/dualsrc.ts), and stripping excess template-literal GLSL indentation in [underwater.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/underwater.ts) and [spray.ts](file:///c:/Users/Blaine%20Oler/.gemini/antigravity/scratch/kongroyale/client/src/world/water/spray.ts) trimmed `lazy:index` chunks by `-163 B gz` net, returning total `lazy JS` to `3,069,097 B gz` (`<= 3,069,111 B` and well above the `-5%` ratchet floor `2,915,656 B`).

---

## 7. Build & Full Test Verification (`npm run build` + All 40 `npm test` Checks)

| Check / Command | Outcome | Observed Details |
|---|---|---|
| `npm run typecheck` | **PASS** | `tsc --noEmit` exited 0 |
| `npm run build` | **PASS** | `599` modules built; `220` assets precompressed (`vite build && node tools/performance/precompress.mjs`) |
| `npx tsx tools/check-size.mts --budgets tools/size-budgets.json` | **PASS** | `entry=34353`, `boot=1164034`, `workers=3075015`, `lazy=3069097 <= 3069111` |
| Underwater pixel/error check (`check-uw.mjs`) | **PASS** | `water-underwater` `err: 0` on both arms; seabed pixels restored cleanly |
| `npm test` (full 40-check suite) | **39 PASS / 1 FAIL (`alloc`)** | All `39` other checks passed (`types`, `formal` 4/4 TLA+ models, `lint` `732` files / `7` gating rules / `219` baselined sites, `bundles`, `auto`, `consent`, `triage`, `ab`, `gate`, `size`, `prreport`, `farbake`, `assets`, `dmath`, `movement`, `swimming`, `face`, `anim`, `walkgraph`, `flags`, `fuzz`, `solver`, `glass`, `planeview`, `res`, `raycast`, `refresh`, `resguard`, `scenegate`, `hlod`, `parity`, `sim`, `replay`, `nettail`, `afk`, `redteam`, `wt`, `procs`, `wtbrowser`). |
| `wtbrowser` (inside `npm test`) | **PASS (Internal `SKIP`)** | Reported `✔` (exit 0) with internal `SKIP no browser to launch (chromium_headless_shell-1248/...)` because Playwright headless Chromium is not installed on this machine. |
| `alloc` (`host allocation per tick`, inside `npm test`) | **FAIL (Verified Pre-Existing)** | `allocBytesPerTick 169530 <= 179832` (`ok`); `gcCount 18` tripped `>20% under budget 80: lower the budget to 20` (`9.8 ms` in `7200` ticks). Reproduced identically on baseline commit `28a6991` (`allocBytesPerTick 169681 <= 179832`, `FAIL host/real-play gcCount 18, budget 80`). |

---

## 8. Remaining Limitations & Open Follow-Ups

1. **Resolution / Preset / Driver Coverage:** Post-fix GPU timings were re-measured only at `1920×1080` (`q=high`) on one Windows RTX 5060 (ANGLE D3D11) system; `1440p`, `4K`, `low`/`medium`/`ultra` preset frame timings, and non-NVIDIA/Linux/macOS drivers remain unmeasured after the final `dualsrc.ts` / `waterGrabBounds` fixes.
2. **Sample Loss & View-Specific Flatness:** `water-harbor-low`, `water-shallows-down`, `poi-09-mist-falls`, and `poi-13-the-murk` (base) had dropped disjoint WebGL timer samples (`n = 150..550` resolved out of `960`), and `water-underwater` overall frame time is statistically flat (`+2.1%`, per-round `-10.0%` to `+10.3%`) despite `-30.5%` isolated water time.
3. **Caustics Fidelity vs Frame Cost:** `high` caustics uses `128` grid subdivisions (`1/30 s`) vs `200` every frame at baseline, trading slightly softer close-range caustic filament contrast for lower vertex/target cost.
4. **CI Memory Budget & Browser Test Gaps:** CI SwiftShader `memory-*.json` budgets require recalibration from CI artifacts once run in GitHub Actions, and local `nogpu` memory + `wtbrowser` browser WebTransport checks were skipped locally because `chromium_headless_shell` is not installed.
