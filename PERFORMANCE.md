# Performance improvement plan

This document is the proposed measurement, optimization and continuous-regression workflow for Kong Royale.
It complements [ARCHITECTURE.md](ARCHITECTURE.md), not the implementation rules in [AGENTS.md](AGENTS.md) and
[CONTRIBUTING.md](CONTRIBUTING.md). Memory work has its own plan in [docs/memory-architecture.md](docs/memory-architecture.md).

## Status and recommendation

The plan started from a read-only investigation of client CPU, rendering, simulation, networking and diagnostics. The
five optimization candidates below started as hypotheses, not measured bottlenecks or promised improvements.

Each item is marked **done** where the code for it is in this repository, **open** where it is not, or **obsolete** with
the reason. An item that names a tool or feature this repository does not have yet is written as a proposal. File
references name files and functions rather than line numbers; check them again before implementation.

| Status | Count | Items |
|---|---|---|
| Done | 12 | Benchmark warmup split and real-play scenario, timing without packet hashing, achieved load, simulated network tail gate, result contract and compare, PERF-01 kong animation budget, PERF-05 water SSR, shared benchmark helpers, local Basis transcoder, context-loss restore, replay, no-GPU CI gates |
| Open | 12 | Storm/endgame and multi-lobby scenarios, real-socket and WAN network tails, Windows server wrapper, one GPU query owner, PERF-02, PERF-03, ray collider dedup, PERF-04, GI samples, DOM helpers, automatic incident upload, hardware regression lane |
| Proposed | 3 | In-match real-GPU frame timing, a page-load profiler, a bounded metrics flight recorder |
| Obsolete | 4 | "No benchmarks were run", "no memory leak was established", FND as the first assignment, CI described as build and secrets only |

Build a small performance lab around the existing tools, then assign narrowly scoped experiments. Do not start with
a renderer rewrite, a general-purpose framework, or broad cleanup. Shared measurement and lifecycle procedures
should make extensions safe without forcing unrelated systems into one abstraction. The core of the lab exists
(section 1); the optimization tracks in section 2 are where most of the open work is.

This plan is not approval to change protected areas. Discuss dependencies, CI, wire formats, map/terrain contracts and
balance as AGENTS.md requires. No public-server tests, automatic production rollout, or automatic merging are
authorized by this document.

## Goals

- Improve frame pacing and responsiveness, not just average FPS.
- Preserve authoritative, deterministic simulation and existing visual/collision parity.
- Give independent engineers a repeatable baseline, a bounded experiment and an objective acceptance gate.
- Store machine-readable evidence so later contributors can reproduce and improve results.
- Connect player incidents to private reproductions without making telemetry itself a source of stalls or leaks.

## 1. Establish trustworthy measurements first (FND)

The core of FND exists: the result contract, interleaved runs and the real-play host scenario. Optimization owners
still must not claim a win until their scenario produces repeatable baseline/candidate comparisons.

### Existing foundations

| Capability | Existing entry points |
|---|---|
| Result contract, statistics, environment and JSON output | `tools/performance/schema.ts`, `tools/performance/common.mts` |
| Interleaved baseline/candidate runs and verdicts | `tools/performance/run.mts`, `tools/performance/compare.mts`, `tools/performance/budgets.json` |
| Simulation/serialization timings | `tools/performance/host.mts`, seeded `tools/performance/scenarios/real-play.mts` |
| Bytes allocated per tick and GC | `tools/performance/alloc.mts` |
| Private server/socket workload | `tools/performance/server-bench.mjs`, `tools/performance/sockets.mts` |
| Latency/jitter hit-registration checks | `tools/netlab.mts` |
| Simulated network tails, per transport (`ws`, `wt`) | `tools/performance/net-tail.mts` against `tools/performance/net-budgets.json` |
| Real server over an emulated WAN path, every RTT x loss x transport arm | `tools/performance/netpath-matrix.mts`, `tools/performance/netpath.py` |
| Wire, matrix, geometry and splat coverage checks | `npm run bench:verify` |
| Real-GPU view captures and synchronous render benchmark | `tools/shot.mjs`, `await __kr.bench(n)` (`bench()` in `client/src/engine/dev-probes.ts`) |
| Whole-browser memory and what holds it | `tools/performance/memory.mts` |
| Tick/event-loop histograms, CPU and memory | `server/perf.ts`, enabled by `KR_PERF_METRICS=1` |
| Bounded error/frame evidence | `client/src/kongbot/capture.ts` |
| Player reports, durable server queue and triage | `client/src/kongbot/`, `server/kongbot.ts`, `tools/kongbot/cli.mts` |
| Deterministic match replay | `shared/net/replay.ts`, `tools/replay.mts` |

### Fix benchmark blind spots

1. **Separate match warmup from benchmark warmup and add real-play scenarios.** **Done:** `bench:host` plays the real
   start, plane and drop untimed and times only the PLAY phase, and `bench:server` waits for PLAY too. A seeded
   all-bot trios `real-play` scenario is the representative one. **Open:** storm/endgame and multiple-lobby scenarios
   don't exist; do not label synthetic islet combat as representative full-match coverage.
2. **Separate correctness instrumentation from timing.** **Done:** the timed ticks hash nothing; a digest of the match
   state after the window checks that both sides replayed the same match, and `--trace` hashes every packet in a
   separate, slower mode that only compares with traced runs.
3. **Record achieved load.** **Done:** socket results record inputs per player per second and skipped generator steps,
   and the `inputLoadAchieved` and `serverKeptTickRate` gates in `tools/performance/sockets.mts` reject an under-driven run.
4. **Gate relevant network tails.** **Done:** `tools/performance/net-tail.mts` reports RTT, input ack, snapshot gaps,
   corrections, remote holds and hit confirm/ghost rates at 50, 150 and 250 ms RTT with jitter and loss profiles,
   against `net-budgets.json`, on each transport (`ws` is the game's two WebSockets, `wt` is WebTransport with
   input windows and snapshots as datagrams; a budget with `transports` holds only on those); `npm test` fails when a
   row breaks one (check `nettail`). **Open:** real-socket and WAN numbers still need runs over
   `tools/performance/netpath.py` or a real network; `netpath-matrix.mts` automates those runs (section 6).
5. **Keep platform prerequisites explicit.** The server wrapper sets `KR_EVENT_MODE=0` for private room creation.
   **Open:** it spawns the extensionless `node_modules/.bin/tsx`, which works on Linux and macOS; Windows compatibility
   is not established.
6. **Do not confuse render throughput with live latency.** `__kr.bench()` forces completion with `readPixels`. Keep it
   for controlled rendering comparisons. **Proposed:** a normal-rAF in-match frame timer on a real GPU, with a
   fixed-seed route through the island, so live frame pacing can be compared run to run.
7. **Unify GPU query ownership.** **Open.** Elapsed-time queries are owned separately by the engine (the timer query
   pool in `client/src/engine/engine.ts`), display calibration (`client/src/engine/display.ts`) and the storm volume
   (`client/src/game/storm/volume.ts`). The water grab's query (`client/src/world/water/grab.ts`) is an
   `ANY_SAMPLES_PASSED_CONSERVATIVE` occlusion query, not a timer, so the timer owner doesn't need to serve it. One
   bounded query owner should serve calibration, dynamic resolution, profiling and collection. Avoid overlapping
   elapsed-time queries; use exclusive pass-profiling leases. Retain raw valid samples, explicitly mark unsupported
   timing and discard disjoint results. The existing smoothed controller estimate is not a suitable raw regression
   distribution.

### Measure four different sources of lag

| Layer | Primary measurements | Interpretation |
|---|---|---|
| Client CPU | Update/render-submission spans, actor/HUD costs, frame intervals, hitch counts | JS timing is not GPU execution time. |
| GPU | Asynchronous query samples, pass samples, render resolution, draws/points | Reject invalid/disjoint samples; count all frame passes, not only the last render call. |
| Server | Tick execution, deadline lateness, accumulator debt, catch-up batches/cap hits, rolling event-loop delay/utilization | Fast individual ticks do not prove timely delivery under multiple lobbies or GC. |
| Network | RTT/jitter, snapshot age/gaps, input ack age, reconciliation frequency/magnitude, queue depth | Loopback and simulated pipes do not prove WAN or input-to-photon latency. |

Also record memory and resource trends across repeated matches (`memory.mts`). **Proposed:** cold and warm boot
milestones from page load to the playable title and a started match, measured the same way in each browser. The
original investigation found no concrete memory leak; that is **obsolete**. Matches did leak, the leaks were fixed, and
CI now runs a match-to-match memory check.

At 60 FPS the frame interval is 16.67 ms; at 120 FPS it is 8.33 ms. These are interval budgets, not a license for every
subsystem to consume that whole time. Server tick execution needs headroom inside its 16.67 ms fixed step.
Choose supported-device targets after baselining. Browser long-animation-frame entries start above 50 ms and miss
many frame-budget failures, so use them for attribution, not as the only game performance metric.

### The measurement contract

**Done.** `tools/performance/` has `schema.ts`, `compare.mts`, `run.mts`, `scenarios/real-play.mts` and `budgets.json`,
and every runner writes the shared `kong-perf-result` contract. Extend these rather than adding a competing harness.

Browser runtime collection must remain browser-safe; `schema.ts` imports nothing from Node so a browser or GPU
collector can share its types. Keep platform collectors separate while sharing portable types and metric semantics.

Each result should include:

- Schema version, commit, dirty state, scenario id/version, seed and relevant world/asset version.
- Workload phase, player/lobby counts, duration, achieved load and warmup/measurement windows.
- Hardware/OS, Node/browser version, GPU/backend, viewport/DPR and quality/AA/render scale.
- Fixed-quality or adaptive-experience mode, cache state and visibility/focus state.
- Run-level summaries plus bounded raw samples; unsupported and invalid metrics must not become zero-cost results.
- Correctness gates, exit status, errors and artifact references for traces/screenshots.

### Repeatable comparison procedure

1. Define the hypothesis, primary metric, guardrails and eligible files before editing.
2. Verify the fixture is representative and sensitive to the intended change.
3. Fix hardware, browser/backend, workload, seed, resolution and quality. Warm up JIT/shaders where appropriate.
   Measure cold boot separately with an explicit cache protocol.
4. Run repeated interleaved baseline/candidate trials on the same runner (`tools/performance/run.mts`). Start with
   several repetitions, then increase them when variance makes the conclusion unclear. Separate independent runs from
   correlated frames.
5. Compare run-level results and tail distributions (`tools/performance/compare.mts`). Do not pool all frames and
   claim they are independent trials. Establish noise before choosing regression thresholds; report inconclusive
   results honestly.
6. Pass correctness and visual/motion gates. Preserve evidence of failed or rejected experiments.
7. Recheck the accepted candidate against the broader scenario suite and the current integration base.

Maintain two modes:

- **Fixed quality:** disable dynamic resolution and pin settings to compare efficiency.
- **Player experience:** normal frame cap and adaptive resolution; track pacing and image-resolution stability.

Run one timed GPU job per physical GPU. Keep software-rendered functional checks separate from hardware performance
results. Do not add blocking GL reads to production hot paths to make profiling easier.

## 2. Five initial optimization tracks

The order is a dispatch recommendation based on code evidence and experiment scope, not a measured cost ranking.
Keep each experiment single-variable. PERF-01 and PERF-05 have landed; the other three are still hypotheses.

### PERF-01: Budget procedural character animation

**Status: done.** A kong drawn at the min tier re-poses at most every `ANIM_SMALL_S` (1/30 s), and one neither in view
nor casting a shadow into it every `ANIM_HIDDEN_S` (0.1 s). In between, its last pose follows the body rigidly, and
shots and hits it skipped still play (`client/src/actors/kong.ts`, `client/src/actors/kong-rig.ts`). Drawing is
unchanged.

**Hypothesis:** full animation work was paid for remote characters that are tiny or off-screen, even though drawing
already used screen-size LOD. `updateActors` calls `apply`, which runs the full pose/IK/face pipeline.

Evidence: `updateActors` in `client/src/game/render.ts`, `client/src/actors/kong.ts`, `client/src/actors/kong-rig.ts`.

- Gates that still apply to any further change: stable pose recovery, hands/weapons/outfits/eyes, shadows and relevant
  auxiliary views. Do not freeze a character merely because the main camera cannot see it if another visible pass still
  needs its pose.
- Preserve instanced rendering, bone texture uploads, LOD hysteresis and dither crossfade.
- Never alter simulation/hitboxes or assume render pose budgeting changes authoritative state.

### PERF-02: Invalidate and cache interaction queries

**Status: open.** The interact prompt is recomputed every frame.

**Hypothesis:** per-frame HUD interaction work scans world collections unnecessarily. The prompt block queries
vehicles twice and checks loot, chests, glass and ziplines; the loot helper scans all items.

Evidence: the interact prompt in `client/src/game/render.ts`, `aimedItem` in `shared/sim/pickup.ts`.

- First experiment: reuse same-frame results and cache prompt candidates until relevant player/aim/world changes,
  with a bounded refresh interval. Test cadence before building a new index.
- Invalidate on spawn/take/remove, relevant state changes and snapshot updates; handle practice and online paths.
  Recompute on an interaction action; a stale prompt must never authorize gameplay.
- Scenarios: empty jungle, dense/looted POI, aiming across adjacent items, range racks, moving vehicles and ziplines.
- Metrics: prompt CPU, inspected candidates/raycasts, refresh count and prompt response delay.
- Gates: unchanged pickup choice/reachability; no stale prompt or perceptible interaction delay. A provisional
  100 ms maximum refresh bound is a hypothesis to test, not a guaranteed acceptable feel.
- Preserve existing HUD dirty checks and server-side validation.
- Owner: gameplay/UI engineer.

### PERF-03: Deterministic loot candidate indexing

**Status: open.** Any change must pass the determinism gates (the `sim` step's golden hashes). The per-item closure
in `autoPickup` is gone, but pickup and bot acquisition still scan every item.

**Hypothesis:** automatic pickup and bot acquisition repeatedly scan loot collections; cost grows with players
multiplied by world loot.

Evidence: `autoPickup` in `shared/sim/match.ts`, the loot searches in `shared/sim/bots.hot.ts`.

- First experiment: a match-owned, allocation-free spatial candidate index for bounded pickup queries.
  Expand to bot acquisition only after proving weighted search coverage and tie ordering remain equivalent.
- Preserve original candidate order, floor/reachability checks, freshly spawned drops and taken-item visibility.
  A local-radius lookup must not silently replace a bot's global search.
- Scenarios: hot-drop loot, many dropped items, sparse late game and multiple fixed seeds.
- Metrics: inspected candidates, query/bot CPU, simulation p95/p99 and bot arming/acquisition times.
- Gates: deterministic state/event trace comparisons, pickup tests, path/movement checks and full seeded matches.
  Share candidate lookup where appropriate, not every caller's decision policy.
- Preserve existing think staggering and pickup cadence. Do not start by indexing the 50 players; maintenance may
  exceed savings and a once-per-tick index could change sequential observation semantics.
- Owner: simulation engineer.

Follow-up after profiling: ray-local collider deduplication in `raycast` in `shared/sim/world.ts`. **Status: open.** A box
spanning several cells can still be tested once per cell; the capsule queries already deduplicate with a generation
stamp, the raycast doesn't. Preserve equal-distance selection, normals, terrain precedence, glass and nested query
safety. Existing grids/DDA already provide a broadphase; do not replace them without comparative evidence.

### PERF-04: Separate tree and understory splat budgets

**Status: open.** The density sweep hasn't been run. Quality tiers apply one `dist` and one `density` multiplier
(the tier table in `client/src/world/veg/index.ts`).

**Hypothesis:** the same quality multiplier for trees and understory spends unnecessary far-vegetation work.

Evidence: `client/src/world/veg/index.ts`, `client/src/world/veg/splat.ts`.

- First experiment: hold trees fixed; sweep understory density in small steps, such as baseline, -10%, -20%.
  Evaluate tree density independently afterward. Reuse existing `SplatSet` density controls. It needs a fixed-seed
  motion route on a real GPU (see FND item 6).
- Scenarios: jungle trail, aerial forest, descent into canopy; fixed 1080p/1440p/4K where supported.
- Metrics: valid GPU p50/p95, frame p95/p99, submitted points/per-level counts and selection CPU.
- Gates: no crown holes, silhouette loss, shimmer, brightness shifts or visible transition bands; test moving
  cameras with TAA and with FXAA/off.
- Preserve actual-scene-height selection, complementary dissolves, ordering, dirty uploads and fallback paths.
  Fewer points can mean larger sprites and more overdraw; accept measured frame improvement, not point count alone.
- Owner: vegetation engineer.

### PERF-05: Reduce water SSR refinement cost

**Status: done.** High-tier SSR refines its hit in three binary steps (`client/src/world/water/shader.ts`); march count,
reach and strength were left alone.

Separate later experiment: GI samples eight to six, without changing AO resolution or temporal blending.
**Status: open.** `GI_SAMPLES` is 8 (`client/src/world/atmos/post.ts`). The file already uses blur/history and
staggered work; compare compute frames separately from reused frames. Prior quarter-resolution AO artifacts are
documented there; do not repeat that shortcut.

## 3. Extension and DRY procedures

Every new subsystem or substantial extension should describe:

1. Which module owns it and where per-frame work registers.
2. What makes its state dirty, when it sleeps and its update cadence.
3. Which resources it owns and whether teardown disposes or deliberately pools them.
4. Which counters/spans identify its cost without per-frame allocation.
5. Which scenario, correctness test and visual/motion gate exercise it.

Build on `WorldModule` in `client/src/world/module.ts`, which takes a region resource scope and an optional `release`.
Preserve idempotent `afterBuild`, sliced builds, readiness holds and shared authoritative collision layouts. Add
contract fields only for demonstrated reuse. Resource ownership rules are in
[docs/memory-architecture.md](docs/memory-architecture.md) and enforced by the `resource-owner` lint rule.

Small DRY work worth considering, in separate scoped changes:

- One GPU query lifecycle and portable metric semantics. **Open**, the same item as FND item 7.
- Existing benchmark statistics/environment helpers rather than new per-runner implementations. **Done:** every runner
  writes the shared `kong-perf-result` contract.
- Shared DOM `el`/dirty-text/class/clock helpers, preserving differing behavior instead of mechanically replacing it.
  **Open.**
- Consistent decoder configuration. **Done:** the Basis transcoder is served from `public/assets/actors/basis/`, and one
  KTX2 pool in `client/src/engine/assets.ts` serves every KTX2 load.

Do not attach an unrelated cleanup to an optimization PR. Fewer lines or abstractions alone are not performance wins.

## 4. In-game diagnostics and crash evidence (OBS)

Extend KONGBOT's bounded capture and triage rather than replacing it. Submission is player-initiated; capturing errors
in a local buffer is not automatic crash delivery.

**Done:** context loss restores in place with reload as the fallback, and CI checks it on SwiftShader
(`tools/verify-context-loss.mts`). A deterministic replay exists: `replayMatch` in `shared/net/replay.ts` re-issues a
recorded match's inputs on a fresh match, and `tools/replay.mts` has a round-trip test.

**Proposed:** a cheap, bounded flight recorder: a per-second metrics timeline for the session (frame time, GPU time,
ping, heap, textures), saved with the active flags and the build identity when a player sends a report. **Open:**
automatic incident upload. The rules below apply before anything is sent without the player pressing a button.

- Do not run visual raycasts, screenshots, large serialization or synchronous GL diagnostics in a hitch callback.
- Sample, deduplicate and rate-limit automatic reports; cap storage, payloads and retry/backoff.
- Treat current URLs/query strings, callsigns, screenshots, console content and movement trails as potentially
  sensitive. Establish consent, redaction, access and retention before automatic upload; do not reuse the full manual
  report payload by default. Do not transmit to an external service without user authorization.
- Distinguish handled errors, context loss, disconnects, stalls and confirmed process exits. A killed renderer/GPU
  process may never execute a reporting callback. Combine breadcrumbs with private runner watchdogs and server
  evidence; no client-only system guarantees complete crash capture.
- Manual report snapshots are not deterministic replays on their own; use the replay log for that.

Server-side telemetry ingestion needs discussion first. Preserve existing quotas and durable fallbacks. Heavy report
handling/storage must not starve the authoritative match event loop.

## 5. Continuous improvement workflow (OPS)

```text
Incident or regression
  -> deduplicate and claim work
  -> private reproduction and baseline
  -> isolated single-variable candidate
  -> correctness + performance + visual/motion checks
  -> evidence-backed pull request
  -> human review and normal release process
```

- Give each task an owner, file scope, hypothesis, scenario, primary metric, guardrails and stop condition.
- Use isolated branches/worktrees; keep shared-file edits serial or explicitly coordinated.
- Schedule bounded trials, not an infinite mutation loop. Cap attempts, time, CPU/GPU/memory, disk and retries.
- Deduplicate incidents/tasks, use expiring claims and heartbeat/watchdog recovery, and retain rejected experiments.
- Keep one timed job per GPU; do not compare runs contaminated by other builds or workloads on the same machine.
- Use fast CPU/correctness gates first, then dedicated hardware runs and longer soak/rematch runs.
- Record runner health and instrumentation overhead. Retain artifacts for failures and accepted candidates with
  explicit retention limits; do not silently advance baselines after a failure.
- Re-run integrated changes; independently beneficial patches can interact badly.
- Produce PRs, not automatic merges or deployments. CI/runner/service additions require the repository's discussion.

**Done:** `.github/workflows/ci.yml` runs more than build, tests and secret checks. It also runs a no-GPU boot smoke
with a title memory budget, a match-to-match memory check and a context-restore check, and `npm test` checks download
size against `tools/size-budgets.json`. The earlier description of CI as build and secrets only is obsolete.

**Open:** a hardware performance regression lane. Real-GPU timing is a manual step (`tools/shot.mjs --bench` on a
developer's machine, for example an M-series Mac or a desktop with a discrete GPU), not a CI gate or a scheduled run. A
staged rollout would be: local FND artifacts -> private repeatable runs -> reviewed regression lane -> scheduled
soak/incident intake. This plan installs none of those services or schedules.

## 6. Commands and validation

Existing examples, run from the repository root after installing dependencies. Use only servers you run.

```sh
npm run build
npm test
npm run bench:host -- --out reports/performance/host-base.json
npm run netlab -- 20,80,160,250,320 --jitter 20 --secs 20 --weapon ar
npm run sim -- trios 42
node tools/shot.mjs biome-01-beach --bench --q high --out shots/performance/base
```

`bench:host` times the PLAY phase, and its `real-play` scenario is the representative one; the other host scenarios
are synthetic. `bench:splat-viewport` is a CPU-side coverage regression check, not a GPU speed benchmark.
`shot --bench` is a synchronous view benchmark, not a live CPU/input-latency test.

For the private server wrapper on Linux/macOS, build first, then:

```sh
npm run bench:server -- --seconds 60 --out reports/performance/sockets-base.json
```

The wrapper sets `KR_EVENT_MODE=0` itself, but its process spawning is not Windows-compatible. Do not work around a
failed launch by pointing tests at a public host.

`bench:server -- --transport wt` starts the server with `KR_WT=1` and gives every player a WebTransport session (the
QUIC module's Node client) instead of the aux socket: input windows and pings as datagrams, as a browser on `?wt=1`
sends them, and a gate that `/health` counts every player on `wt`. Its default output is `sockets-final-wt.json`.

**Netpath matrix.** `tools/performance/netpath-matrix.mts` runs the real server and `sockets.mts` over the emulated
path of `netpath.py` for every RTT x loss x transport arm, n runs per arm, interleaved: each repetition walks every
cell once and runs the transports back to back in an order that alternates by repetition. Every run gets a fresh
server (`KR_WT=1` for both transports) and its own `sockets.mts` result; each arm's metrics are summarised over the
runs that passed `sockets.mts`'s gates (`noDeathsInWindow` excepted: with two players the match is mostly bots, and
bots die), with the median run as p50. It writes a `kong-perf-result`, a Markdown table and every run's result. The
defaults (0/50/150/250 ms x 0/1% loss x ws/wt, n = 10, 30 s) take about 4 hours, so it is never part of CI or
`npm test`. It needs Linux with passwordless sudo, and its results are labelled "emulated path":

```sh
npx tsx tools/performance/netpath-matrix.mts                                         # the whole matrix, about 4 h
npx tsx tools/performance/netpath-matrix.mts --rtts 150 --losses 1 --n 3 --secs 20   # one cell, both transports
```

For a single WebTransport run over the same path, start the server with `KR_WT=1` and run `sockets.mts` with
`--transport wt` instead of `--aux` (QUIC rides UDP through the relay like any other IP packet).

Before every PR, run `npm run build` then `npm test`, plus the narrow scenario/correctness gates.
Visible changes also need a real-GPU local play check and screenshot or clip. Record unavailable checks as blocked,
not passed. Do not install dependencies or change CI just to conceal an environment limitation.

## 7. Dispatch order and completion evidence

1. FND: **done** for host and socket workloads. Still open: storm/endgame and multi-lobby scenarios, real-socket and
   WAN network tails, the Windows server wrapper and the GPU query owner. Proposed: in-match real-GPU timing and a
   page-load profiler.
2. PERF-01: done. PERF-02: open.
3. PERF-03 and ray deduplication: open; trace fixtures exist (the `sim` step's golden hashes).
4. PERF-04 and GI samples: open. PERF-05 is done.
5. OBS/OPS: replay, context-loss restore and the no-GPU CI gates are done; a flight recorder is proposed; automatic
   upload and a hardware regression lane are open.

Each delivered task needs: hypothesis, before/after commit ids, full scenario/configuration, repetitions and noise,
primary and guardrail metrics, correctness/visual results, artifacts, limitations and a recommendation to keep,
reject or continue. A careful negative result is useful. Never invent a baseline, gain or successful validation.

## Research references

These inform procedures, not proof of this game's bottlenecks:

- [MDN: WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices):
  avoid blocking GL operations in production paths; prefer asynchronous work.
- [Khronos: WebGL2 timer queries](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/):
  asynchronous availability and disjoint validity.
- [MDN: long animation frames](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing):
  50 ms reporting threshold and attribution.
- [Node 22: performance APIs](https://nodejs.org/docs/latest-v22.x/api/perf_hooks.html):
  event-loop delay/utilization; histogram delay units require conversion.
- [Google Benchmark guide](https://google.github.io/benchmark/user_guide.html):
  warmup, repetitions and random interleaving to reduce system-state bias. Its principles apply here without adding
  the C++ library as a dependency.
