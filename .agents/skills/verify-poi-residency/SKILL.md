---
name: verify-poi-residency
description: Model-check Kong Royale's low-memory POI streaming with TLA+ - which streamed locations hold memory, when one is evicted, and the cap - and draw it as a statechart (docs/statecharts/poi-residency.md). Use before calling done any change to client/src/low-mem.ts nearModule/nextNearModule/evictStreamed/over/evictionsFor/trimStreamed/residents, client/src/main.ts buildOne/buildStreamed/stream or its 2 s trim timer, or the lowmem flags (lowmemcap, lowmembudget, lowmemr, lowmemhyst).
---

# Verify POI residency

In low-memory mode the client streams locations: during a match it builds the nearest queued one and, first, evicts the
farthest live one while the list would go over the cap. Builds and fade-ins run in the background, the camera keeps
moving, a 2 s timer trims too, and a match can start or end at any point. This model checks every order of those events
for four locations and a cap of 2.

## The rules (tools/formal/PoiResidency.tla)

| Rule | In plain words | If it breaks |
|---|---|---|
| AtMostCapPlusOne | At most the cap + 1 streamed locations hold memory, counting the one being built. | Memory grows without bound as you move; Safari kills the tab. |
| NoEvictWhileBuilding | A location is never evicted while it is building or fading in. | A half-built location's resources are freed under it; errors or a leak. |
| NothingPickedOutsideMatch | Nothing new is picked to build at the title, in the room or on the results lobby. | Memory spent where no one plays. |
| GlideTargetFirst | While the player falls or glides, the location the glide heads for is picked before any queued one behind or to the side. | From the parachute, what you fly toward stays an impostor. |
| GlideTargetKept | Making room never evicts the location the glide heads for while one behind or to the side stays. | The location ahead is thrown away for one you have left behind. |
| AtMostCap | At most the cap, counting the one being built. | Today: one over while every resident is protected (the one you stand in, one fading in). |
| NothingBuiltOutsideMatch | No build starts outside a match. | Today: a location picked just before you leave is still built. |

`MaxInside` is how many location circles the camera can stand in at once. `PoiResidency.cfg` (`MaxInside = 1`) checks
the first five, which hold. `PoiResidency.findings.cfg` (`MaxInside = 2`, as where two circles overlap on the map)
checks all seven: AtMostCap and NothingBuiltOutsideMatch break, and so does AtMostCapPlusOne, because both locations you
stand in are kept whatever the cap (docs/statecharts/poi-residency.md has the paths). If the code changes so that a
rule holds, move it into `PoiResidency.cfg` and add a mutant that takes the change out.

## Run it

```sh
node tools/formal/tlc.mjs PoiResidency --mutants
```

Java 11 or newer on PATH; the first run downloads the pinned TLA+ tools jar. About 2 seconds, 115,425 distinct states.
Expected output: one `PASS PoiResidency` line and one `PASS ... mutant` line per entry in `PoiResidency.mutants.json`.
A mutant that passes means the model can no longer see the guard it removes: fix the model, not the mutant.

To see the paths that break AtMostCap, AtMostCapPlusOne and NothingBuiltOutsideMatch, run TLC on the model with
`PoiResidency.findings.cfg` (copy both to a scratch folder as `PoiResidency.tla` and `PoiResidency.cfg` and run
`java -cp node_modules/.cache/tla2tools/1.7.4/tla2tools.jar tlc2.TLC PoiResidency.tla` there, with the jar path made
absolute). TLC prints the shortest path to the first rule it finds broken; take that rule out of the copy's config to
see the next one.

## When a rule breaks

- **A real bug.** Replay the path in the real client: `npm run build`, serve it, open a practice match with
  `?lowmem=1&lowmemcap=2` (and `?seed=N` to replay one plane path), and move the camera between locations in the
  path's order (the memory tool's `--tour` teleport in `tools/performance/memory.mts` does this from a script). Log
  `residents()` and the build queue, and compare with the path. On a no-GPU machine this runs on SwiftShader, slowly.
- **A pick-order question on the descent.** `npx tsx tools/performance/descent-residency.mts [other/low-mem.ts]` runs the real
  `nextNearModule` and `trimStreamed` on a fake clock along a recorded glide (plane over peel-harbor and mango,
  over mango at about 515 m) and prints when each POI is picked, built and evicted, with the altitude. Give it a main
  worktree's low-mem.ts to compare.
- **A modelling error.** A step the code cannot take. Fix the model to say what the code does, citing the line.

## Keep the model in step with the code

| Code | Model action |
|---|---|
| low-mem.ts `nearModule`, `nextNearModule` (in a match only; the admission test) | Pick |
| low-mem.ts `trimStreamed` (and its `residents()`: locations in `modOf` only), `evictionsFor`, `over`, `evictStreamed` | Counted, TrimEvict, TrimDone |
| main.ts `buildStreamed`, `buildOne`, the back-pressure in `stream` | Built, Integrated |
| main.ts `stream`'s 2 s timer (`trim(null)`) | Timer |
| low-mem.ts `distM` (the rank: inside, ahead of the 5 s lookahead, near, far) and `nearModule`'s airborne test (cm.pred.st Freefall or Glide: the build range stops counting height) | Rank, Move's "ahead" class, Jump, Land |
| the camera; `enterMatch` / leaving | Move, EnterMatch, LeaveMatch |

main.ts fills the queue (`streamList`, which low-mem.ts calls `pending`) in top-level boot code that no region can
name, and the write scan does not look for `streamList`; the model starts with every location queued, so read that boot
loop against `Init` when it changes. The caps' values live in client/src/flags.ts, which no region can name; the model takes the cap as a constant and
counts locations rather than megabytes, so the budget estimate (400 MB a location until measured) is not checked.

Coverage record: `tools/formal/PoiResidency.covers.json` names the functions above and the writes that change which
locations are queued, building, built or live (`building`, `streamMs`, `pending`, `modOf`), and records a token hash
of each region as of the last passing run. npm test's `formal` check fails when one changed or when other code writes
that state. The one listed exception is `__kr.rebuildModule`, a developer hook typed into the console. Read the change
against the table, fix the model or the regions (or the `allow` list: a function, each write it may make there, listed
once per occurrence, and why), then:

```sh
node tools/formal/tlc.mjs PoiResidency --mutants --record
```

## What it does not cover

Distances are four classes (inside, ahead of the glide, near, far) and the camera jumps between them at any time. Picks are by distance only: the plane's overview builds (`lowmemview` locations in view during the plane) and the caster's admission
(`nearModule` also picks while casting) are left out. Memory is a count of
locations, not bytes, so the `lowmembudget` path and how much memory an eviction actually frees are out of scope;
`tools/performance/memory.mts` measures that. Desktop mode (no eviction) is not modelled.
