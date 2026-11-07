---
name: verify-client-lifecycle
description: Model-check Kong Royale's client lifecycle with TLA+ - loading screen, title, practice and online matches, the waiting room, and WebGL context loss and restore - and draw it as a statechart (docs/statecharts/client-lifecycle.md). Use before calling done any change to client/src/game/index.ts offline/online/wire/onJSON/enterMatch/exitToRoom/leaveAll/backToRoom/linkLost, client/src/game/render.ts GameRender and its match scope, client/src/engine/res/restore.ts or restore-run.ts, or the error and room messages the Lobby in server/index.ts sends (housekeeping, unseat, leave, pump, endMatch).
---

# Verify the client lifecycle

The client moves between the loading screen, the title, a room, a match and its results, and it can lose its WebGL
context at any of them. Each move disposes one `GameRender` and wires the next, opens or closes the `match` resource
scope, and reacts to messages the server sends at any time. Those orders of events are where the bugs are: a button
pressed too early, a message that arrives while another screen is up, a second context loss during a restore. Tests and
the boot smoke walk one order each; this model checks all of them.

## The rules (tools/formal/ClientLifecycle.tla)

| Rule | In plain words | If it breaks |
|---|---|---|
| NoMatchWithoutRenderer | A match on screen always has its renderer. | A black match, or a crash in the frame loop. |
| LeaveFreesTheSeat | Back on the title, the server no longer holds a match seat for you. | Your seat runs on as an idle kong; a rejoin finds you still seated. |
| ScopeHasOwner | The `match` scope is open only while a `GameRender` owns it. | Every later PLAY fails with "already has a live child named match". |
| ButtonsAnswer | PLAY, CREATE and JOIN always do something you can see. | A dead button; the player reloads. |
| NoFrozenMatch | A match on screen is one the server still plays for you. | A frozen match with no way back but Leave. |
| ReasonStays | A reason the server gives for ending your match stays until you move on. | "MATCH CRASHED" flashes and is gone. |
| OneRestore | One context restore at a time. | Two `restoreAll` runs upload the same resources at once. |

`ClientLifecycle.cfg` checks the first five, which hold today. `ClientLifecycle.findings.cfg` checks all seven; the
last two break, and docs/statecharts/client-lifecycle.md gives the shortest path to each. When a fix lands, move its rule
from the findings config into `ClientLifecycle.cfg` and add a mutant that takes the fix out again.

## Run it

```sh
node tools/formal/tlc.mjs ClientLifecycle --mutants
```

It needs Java 11 or newer on PATH; the first run downloads the pinned TLA+ tools jar into node_modules/.cache. A run
takes about a second (271 distinct states, `Online = TRUE`). Expected output: one `PASS ClientLifecycle` line and one
`PASS ... mutant` line per entry in `ClientLifecycle.mutants.json`. Each mutant takes one guard out of a scratch copy
of the model and must make TLC report the rule its entry names; a mutant that passes means the model can no longer see
that guard. Fix the model, not the mutant.

To see the paths that break the last two rules, copy `ClientLifecycle.tla` and `ClientLifecycle.findings.cfg` to a
scratch folder (the config renamed to `ClientLifecycle.cfg`) and run
`java -cp <repo>/node_modules/.cache/tla2tools/1.7.4/tla2tools.jar tlc2.TLC ClientLifecycle.tla` there: TLC prints the
shortest path to the first rule it finds broken.

## When a rule breaks

Read the shortest path, then decide which it is:

- **A real bug.** Every step is something the game can do. Replay the path in the real client on a local server
  (`KR_EVENT_MODE=0 npm run server`, `npm run dev`), with the Playwright setup in AGENTS.md ("Check it in the game") or `tools/kr-verify.mjs`: press keys
  before `window.__kr.ready`, send the lobby messages in the path's order, and read `window.__kr.errors`. A protocol-
  level step (an AFK removal, a crashed match) can be driven with a WebSocket client against the local server. Report
  it with the path and the replay. Do not weaken the rule.
- **A modelling error.** A step the code cannot take. Fix the model so it says what the code does, and cite the line.

## Keep the model in step with the code

| Code | Model action |
|---|---|
| main.ts boot, `window.__kr.ready`; the prefab warm-up (`kr.prefabWarmP`) | Ready, Prefabs |
| index.ts `offline`, `prepareIsland`, `wire`; render.ts `GameRender` constructor, `matchScope`, `dispose` | Play, WireScope, WireOk |
| index.ts `online` (CREATE, JOIN) | Connect, JoinFails |
| index.ts `wire`'s `onClose`, `linkLost` at the title | SocketClosesAtTitle |
| index.ts `onJSON` (`match`, `phase`, the room frame), `enterMatch`, `exitToRoom`, `backToRoom` | Start, NextPhase, MatchOver |
| index.ts `leaveAll` | Leave |
| server/index.ts `Lobby`: `housekeeping` (AFK), `unseat`, `leave`; `pump`, `endMatch` (crash, end) | RemovedAfk, Crashed, MatchOver |
| restore.ts `watchContext`; restore-run.ts `restoreAll` | Lose, Restored, RestoreDone, Reload |

Facts no region can name: main.ts sets `__kr.prepare`, `__kr.ready` and `dataset.ready` at top level, and `prepareIsland`
(index.ts) waits for `dataset.ready` before it reads `__kr.prepare`. The model's PLAY, CREATE and JOIN guards
(nothing before the prefabs) depend on both, and the drift check cannot see either change. Read them against the model
whenever main.ts's boot order changes.

Coverage record: `tools/formal/ClientLifecycle.covers.json` names the code above (one region per function) and the
writes the model guards (`inMatch` and `staleMatch` in index.ts, `contextLost` in the engine), and records a token
hash of each region as of the last passing run. npm test's `formal` check (tools/formal/drift.mjs, no Java) fails when a
region changed, moved or vanished, when the model's files changed, or when other code writes the guarded state. Read the
change against the table, fix the model or the regions (or the `allow` list: a function, each write it may make there,
listed once per occurrence, and why), then re-verify and record in one step:

```sh
node tools/formal/tlc.mjs ClientLifecycle --mutants --record
```

## What it does not cover

Timers are steps that can happen at any time (the 10 s reload after a lost context, the server's idle close). Match
phases are one step each; positions, loot and inputs are left out. One tab, one player: two tabs of one profile, or the
caster view, are not modelled. The reconnect card after a mid-match link drop is left out; its writes are
listed in the `allow` list.
