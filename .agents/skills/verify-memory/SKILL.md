---
name: verify-memory
description: "Measure how much memory Kong Royale makes the whole browser use (browser, renderer and GPU processes) at the title, in the plane, in a match, after leaving and after a second match, and what holds it: WebGL textures and buffers by asset and world module, CPU copies kept after upload, decoded audio, and the JS heap by retainer. Use before calling a memory change done, when you claim a memory saving or regression, when asked why the game needs so much RAM, or to check for leaks across matches."
---

# Verify Kong Royale's memory

Players on 8 and 16 GB machines swap or fail to load. The goal is to make the game playable on a 16 GB machine
without swapping, which means well under 4 GB for the whole browser. This skill measures that number the same way on
every platform, and breaks it down so a cut can be aimed and proved. [docs/memory-architecture.md](../../../docs/memory-architecture.md)
explains the resource layer these numbers check.

Everything runs through one helper, [tools/performance/memory.mts](../../../tools/performance/memory.mts), from the
repository root (Node 22.12+), against a production server you start with [tools/kr-verify.mjs](../../../tools/kr-verify.mjs):

```sh
npm run build
node tools/kr-verify.mjs up --prod --port 3140
npx tsx tools/performance/memory.mts run --url http://127.0.0.1:3140            # profile from the OS: nogpu on Linux, mac, win
npx tsx tools/performance/memory.mts run --url http://127.0.0.1:3140 --matches 1 # cloud SwiftShader: one match (see Gotchas)
npx tsx tools/performance/memory.mts table shots/memory/<stamp>/result.json --md
node tools/kr-verify.mjs down
```

Measure the production build: the dev client loads hundreds of unbundled modules and holds more. Only measure servers
you started (AGENTS.md rule 7); the helper refuses any host but localhost.

## What one run does

One fresh browser profile, one page:

1. Load the title (`window.__kr.ready`), wait 5 s, sample **title**.
2. Press **Play** (`button.tn-play-cta`), sample **plane** when the match reaches the plane phase, then wait for the
   play phase (`cm.phase === 2`, after the drop) and sample **match** `--match-secs` (60) into it. Warm-up never counts
   as the match: on `nogpu` the 25 s warm-up and the plane take several minutes of wall time, and a run that never
   reaches play fails instead of recording a warm-up sample as `match`.
3. Leave the match (`__kr.game.leave()`, what the pause menu's Leave match calls), wait 10 s, sample **left1**.
4. Repeat for the second match: **match2**, **left2** (`--matches N` sets how many; `--matches 0` stops after the title).

Every sample forces two garbage collections first (CDP `HeapProfiler.collectGarbage`), so the JS heap is what is
retained, not what is waiting for GC. `performance.memory.usedJSHeapSize` read without a GC is not comparable
between runs; never quote it as retained memory.

`result.json` is a `kong-perf-result` ([schema.ts](../../../tools/performance/schema.ts)) with one case per sample
(`memory/title`, `memory/plane`, `memory/match`, `memory/left1`, `memory/match2`, `memory/left2`), plus
`leaks`: the change from left1 to left2, match to match2, and title to left1. A healthy game shows near zero from left1
to left2. `--heap` adds a V8 heap snapshot at the title (about 1 minute and 3 GB of Node memory on SwiftShader).

`--tour SECONDS` moves the player through every POI (or the ones named by `--stops poi,poi`) during the match sample,
holding each for SECONDS, and records `evictions` (what low-memory streaming evicted, from `__kr.evictions`) and
`coldDraws` (textures an eviction released that were drawn again and had to reload). Use it with `?lowmem=1` in the
URL to check streaming; it needs a practice match.

## What the numbers mean

| Metric | Source | Meaning |
|---|---|---|
| `totalMB` | Every browser process from CDP `SystemInfo.getProcessInfo`, memory from the OS | What the browser costs the machine. Linux: PSS (shared pages split between sharers, so the sum is honest). macOS: `phys_footprint` from `footprint` (Activity Monitor's Memory column), RSS if that fails. Windows: private bytes (closest to Task Manager's Memory column) |
| `browserMB`, `rendererMB`, `GPUMB`, ... | The same, per process type | The renderer holds the JS heap, decoded images and audio; the GPU process holds the driver's copy of textures and buffers |
| `heapUsedMB` | CDP `Runtime.getHeapUsage` after GC | Retained JS objects. ArrayBuffer and typed array contents are **not** in it; they show in `rendererMB` and in `--heap` as `system / JSArrayBufferData` |
| `webglMB` | Wrappers on every WebGL allocation call, installed before the game's scripts | What the game asked WebGL to hold: `textureMB` (per mip level and cube face, from `texImage*`, `texStorage*`, `compressedTexImage*`, `generateMipmap`, minus `deleteTexture`), `bufferMB`, `renderbufferMB`, `drawingMB` (the canvas, estimated from its context attributes). Every count but `drawingMB` is exact for what the page's own WebGL contexts allocate; contexts in workers are not wrapped. Repeat runs agree within about 1.5% (streaming order varies) |
| `textureCount` | The same | Live WebGL textures |
| `geometryCpuMB` | three.js objects reachable from the scene and the world modules | Vertex and index arrays three keeps in JS after upload |
| `textureCpuMB` | The same | Images, ImageBitmaps, canvases and DataTexture arrays a texture reachable from the scene still holds after upload. Copies held by render targets or off-scene caches are not in it, so it is a lower bound |
| `audioMB` | Wrappers on `decodeAudioData`, `createBuffer` and `OfflineAudioContext` | Live decoded AudioBuffers (32-bit float per sample per channel) |

`table --md` adds, for the last match sample: the 40 largest textures with size, mip levels, format and owner
(`label @module`; `(not in the scene)` means no scene object references it: render targets, texture arrays,
caches), texture and geometry bytes per world module (`__kr.moduleIds()`), the largest geometry copies, CPU copies by
kind, decoded audio by source URL, and with `--heap` the heap by constructor and the retainer path of every object
over 1 MB.

## Platforms and calibration

| Profile | Where | Browser | What `totalMB` includes |
|---|---|---|---|
| `nogpu` | Linux without a GPU | Playwright's Chromium, `--use-angle=swiftshader`, 640x360 | Textures and buffers live in the GPU process's CPU memory, so `GPUMB` is a direct measure of GPU allocation. Use it for A/B and the budget; never as the number a player sees |
| `mac` | Apple silicon | Chrome, `--use-angle=metal`, 1600x900 | Unified memory: GPU allocations count in `phys_footprint` of the GPU process |
| `win` | Windows | Chrome or Edge (`--channel msedge`), `--use-angle=d3d11`, 1600x900 | Private bytes. Textures in dedicated VRAM on a discrete GPU are not system memory and are not counted; on an integrated or unified-memory GPU they are |

`webglMB` is computed the same way on every platform, so it is the bridge: the ratio of `totalMB` to `webglMB` on
Metal and D3D11 against SwiftShader is the calibration. Record the viewport and DPR (`--viewport`, `--dpr`) with every
number: render targets scale with the drawing buffer. On `nogpu` keep 640x360; at 1600x900 SwiftShader trips the
game's 90 s settle timeout. `nogpu` adds `?vegsplat=0` like kr-verify does.

A `nogpu` run with two matches takes about 11 minutes on 8 vCPUs and about 25 on 4 (the title alone takes 2 and 6). It
peaks around 10 GB, and once a renderer briefly passed 28 GB while Peel Harbor streamed in. Give it a machine of its
own with 16 GB or more, and never run two at once. Every 15 s (`--trace-secs`) the harness logs the process totals, the
JS heap, WebGL bytes, the match phase and the stream stage into `timeline` in result.json; that is where to look for a
spike between samples. A watchdog stops the browser and fails the run once the processes pass `--max-mb` (default 70%
of the machine's memory), so a runaway can't take the machine down with it.

## A/B and reporting

1. Same profile, viewport, DPR and seed on both sides; `config` in result.json records them.
2. `webglMB`, `textureCount`, `geometryCpuMB`, `textureCpuMB` and `audioMB` repeat within a few percent for a build:
   one run a side shows a change bigger than that. `totalMB` and `heapUsedMB` move by tens of MB between runs: run 3 a
   side, interleaved, and quote the range.
3. Quote the phase (`match` and `left2` matter most: a player's machine has to survive the match, and leaks show
   after the second one), the profile and the viewport. Attach the `table --md` output to the pull request.
4. A cut that only moves bytes (from `textureCpuMB` to `GPUMB`, say) has not saved anything: check `totalMB`.

## The budget

[tools/memory-budgets.json](../../../tools/memory-budgets.json) holds what the game may keep at the playable title on
`nogpu` at 640x360 and seed 42: WebGL bytes, texture bytes, buffer bytes, texture count and the CPU copies. CI's no-GPU
boot smoke job runs it after the boot check:

```sh
npx tsx tools/performance/memory.mts run --url http://127.0.0.1:3140 --matches 0 --budgets tools/memory-budgets.json
```

A number over its budget fails. A number more than `underPct` (5%) under it also fails, and the message names the new
budget (the measured value plus `headroomPct`, 2%), so a cut lands together with its lower budget, the same way
`tools/size-budgets.json` works. Recheck a saved run without rerunning it:
`npx tsx tools/performance/memory.mts check shots/memory/<run>/result.json` (it reads `tools/memory-budgets.json` unless
you pass `--budgets`). The file's `config` must match the run's, so a budget never applies to a different viewport or
profile. Process totals are not budgeted: they move by a gigabyte between runs.

Two more files budget the match the same way (see docs/memory-architecture.md, "In-match and low-memory budgets"):
[tools/memory-warmup-budgets.json](../../../tools/memory-warmup-budgets.json) for the first warm-up of the
match-to-match run below, and [tools/memory-lowmem-budgets.json](../../../tools/memory-lowmem-budgets.json) for CI's
"no-GPU low-memory memory" job:

```sh
npx tsx tools/performance/memory.mts run --url "http://127.0.0.1:3140/?lowmem=1&geofree=1&farimp=1" --matches 1 \
  --max-mb 9000 --budgets tools/memory-lowmem-budgets.json
```

Every sample also records `residentPois`, `peakResidentPois` and `evictions`. `--budgets` can be given more than once.
Calibrate a budget from CI's own runs (the `memory-result` and `memory-lowmem-result` artifacts), never from a local
machine: the plane phase and stream timing differ.

## Match to match and resource ownership

[tools/memory-leak-budgets.json](../../../tools/memory-leak-budgets.json) is checked by CI's "no-GPU match-to-match
memory" job:

```sh
npx tsx tools/performance/memory.mts run --url "http://127.0.0.1:3140/?resaudit&modules=atmos,terrain,water,veg,poi:lobby-islet,showcase,weapons-showcase,gameplay-stage" \
  --warmup --matches 3 --max-mb 9000 --budgets tools/memory-leak-budgets.json
```

`--warmup` samples each match in its warm-up (phase 0) and leaves it at once, and fails a sample taken in any other
phase. `?resaudit` loads `client/src/engine/res/audit.ts`, which records every geometry, texture and render target the
renderer holds, and `__kr.resAudit()` splits them into what a resource scope owns and what it doesn't. That adds
`ownedMB`, `unownedMB`, `unownedCount` and `ledger.<category>MB` to every sample. The run also adds a `memory/leak` case:
what grew from the second-to-last left sample to the last one, never negative. It prints the unowned resources that grew
by name or geometry type. Compare the last two matches, not the first two: the island is still streaming during the
first one, so left1 to left2 moves by 0 to 46 geometries from run to run, while left2 to left3 moves by 0 to 2.

Keep this to the title modules and the warm-up. On SwiftShader the browser passes 10 GB once Peel Harbor streams in,
which kills a 16 GB runner. Always pass `--max-mb`. The file sets `underPct` to 100 because growth is zero when nothing
leaks, so these numbers are ceilings: lower `left3` by hand when an owner moves to a scope.

## Gotchas

- `(not in the scene)` textures are real allocations the scene walk can't name. The `sites` table shows the call
  site, but in the production build every three.js upload comes from one chunk; measure the dev client
  (`node tools/kr-verify.mjs up`, port 5417) to see source names, and never quote its totals.
- Never read the page with Playwright's `page.evaluate` while a match loads. On SwiftShader it drove the browser
  process from 50 MB to 7 GB and the renderer to 12 GB within two minutes of Play, and runs passed 28 GB. With the
  same reads sent as plain `Runtime.evaluate` over the page's CDP session (what `memory.mts` does since scenario
  version 3), the same match peaked at 8.8 GB and the browser process stayed at 47 MB. Process totals from the plane
  on in results before version 3 are not trustworthy. Version 3 doesn't remove the growth entirely: a two-match run at
  640x360 grew the same way in its second match, while the whole island streamed in (browser process 4.5 GB, 25.9 GB
  total). The cause is unknown. It has only appeared on SwiftShader under automation and only while non-title POIs
  stream: Metal kept the browser process at about 83 MB through two matches, and warm-up runs limited to title modules
  (`--warmup` with `?modules=`, the CI leak job) peak at 5-5.7 GB. Keep full-island SwiftShader runs to one match.
- `nogpu` runs add `?vegsplat=0`, which makes the game bake impostor banks that a player with splats on (the
  default) never gets: 331-547 MB more textures. SwiftShader texture totals overstate player memory by about that much,
  so rank texture costs with splats on wherever the run allows it. The CI budget is still a fair ratchet because every
  run measures the same thing.
- WebGL in workers (OffscreenCanvas) is not wrapped; the bytes still show in the process totals.
- `--heap` on a 4-vCPU machine pauses the page for a minute; take it in its own run, never in one you time.
- Chrome may discard decoded images and purge GPU memory under pressure; a 64 GB workstation and a 16 GB laptop
  can differ for the same build. Measure on the machine class you are claiming for.
