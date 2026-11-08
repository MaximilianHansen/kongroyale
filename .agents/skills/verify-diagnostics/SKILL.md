---
name: verify-diagnostics
description: Model-check Kong Royale's player diagnostics with TLA+ - the crash heartbeat across tabs (no false crash prompt, no lost crash, one report per crash) and the send flow (consent first, callsign only when ticked, every send answered, and the automatic summary, on by default for every player: none before the toast was shown, none after the player turned it off in Settings or under a privacy signal, none from automation) - against the code in client/src/playtest/beat.ts, diag.ts and report.ts. Use before calling done any change to the heartbeat (beat.ts startBeat, writeBeat and its pagehide/pageshow listeners, the startBeat call in main.ts, readBeats, findDeadSession, installDiag), the crash card, the send sheet, quickSend, send or body, or the consent and callsign rules.
---

# Verify player diagnostics

Two TLA+ models describe the diagnostics code in client/src/playtest/. Each first checked the design as written,
found its bugs (docs/statecharts/diagnostics.md), and now checks the code that fixed them.

- `tools/formal/DiagHeartbeat.tla`: two tabs of one browser profile share `localStorage` and Web Locks, through
  every order of loads, the heartbeat starting, closes, kills, back/forward-cache freezes and thaws, and crash-card
  answers. `Design = "locks"` is the code; `"plan"` is the first design (one shared record), kept for
  `DiagHeartbeat.findings.cfg`.
- `tools/formal/DiagSend.tla`: one tab's screens around a send, and the server accepting or refusing it.
  `RefusedShown = TRUE` is the code; `FALSE` is the first design, kept for `DiagSend.findings.cfg`. `Spec` assumes
  every upload ends (weak fairness on Accepted or Refused), which `send`'s `TIMEOUT_MS` abort earns.

## The rules

| Model | Rule | In plain words |
|---|---|---|
| DiagHeartbeat | NoFalseCrash | The title never asks about a crash of a session that is still open or ended cleanly. |
| DiagHeartbeat | NoLostCrash | A session that dies after its first beat stays detectable until a later load picks it up. |
| DiagHeartbeat | OneReportPerCrash | One crash is reported at most once, however many tabs load and whatever the player taps. |
| DiagSend | NoManualSendWithoutConsent | Nothing a player sends leaves the browser before they have seen the consent text on the sheet. |
| DiagSend | CallsignOnlyWhenTicked | The callsign goes only in a send where "Include my callsign" was ticked. |
| DiagSend | AutoOnlyAfterNotice | An automatic summary leaves only after the one-time toast was shown (or the player chose in Settings). The default is on, so this is what makes "the player was told first" true. |
| DiagSend | AutoRespectsOff | And never after the Settings row is turned off, or while Global Privacy Control or Do Not Track is on. |
| DiagSend | AutoNeverInAutomation | A page under automation (`navigator.webdriver`) sends no summary unless the URL or build asked for diagnostics (`?diag`, `VITE_KR_DIAG=1`). The default is on for every player of a production build, so this keeps harnesses, benches and CI jobs from sending. |
| DiagSend | NoBeatUnderSignal | The default writes no heartbeat record while Global Privacy Control or Do Not Track is on; only an explicit `?diag` does. |
| DiagSend | NoBeatAfterOff | A heartbeat record that outlives switching the summaries off in Settings is deleted by the next write (`writeBeat`, within one 5 s beat), unless the player switched back on first. It is a leads-to rule; `BeatTick` is the write and Spec makes it strongly fair. |
| DiagSend | EverySendAnswered | Every send ends with the thank-you and report id, or a message that it did not go. |
| DiagSend | SendEnds | A send never hangs: one of the two shows in the end. |

## What each action is in the code

| Code | Model action |
|---|---|
| The page loading, before main.ts runs (the boot JS downloading and evaluating) | DiagHeartbeat Open |
| main.ts → beat.ts `startBeat` on a game page under diag: takes the session's Web Lock, then `writeBeat` inside it, and adds the pagehide and pageshow listeners | DiagHeartbeat BootBeat |
| The lazy playtest chunk: diag.ts `installDiag` → (after `live.done`) `findDeadSession` (under the `kr.diag.claim` lock: `readBeats`, delete every record that isn't clean and whose lock isn't held, keep the newest as `prev`); report.ts `installReport` shows `crashCard` about it | DiagHeartbeat Check |
| `startBeat`'s pagehide listener (clean), its pageshow listener with `persisted` (running again), the 5 s beat in `installDiag`'s per-second hook | Close, Freeze, Thaw (Beat is the first design's) |
| report.ts `crashCard`: SEND opens the sheet in crash mode; NO THANKS or a match starting removes the card | DiagHeartbeat Answer; DiagSend OpenSheet, DismissCrash |
| report.ts `quickSend` (SEND DIAGNOSTICS on the results card; reads `consented`) | DiagSend QuickSend |
| `installReport`'s takeover of `__kr.kongbot.open` (REPORT A PROBLEM) | DiagSend OpenSheet |
| report.ts `createSheet` (its SEND and CANCEL; stores `kr.diag.consent` after a send goes through) | SheetSend, SheetCancel, Accepted |
| beat.ts `summariesDefault` (production build, no `?diag` in the URL, not `navigator.webdriver`) and `summariesOn` (that, and `autoOn()`, or `diagOn()`); read by main.ts (`startBeat`), playtest/index.ts (the recorder, diag.ts and auto.ts chunks) and settings-model.ts (the Settings row shows wherever `summariesDefault` holds, so a player who turned it off can turn it back on) | DiagSend `Runs` (the guard on ShowNotice, AutoSend and BootBeat), BootBeat (main.ts `startBeat`) |
| consent.ts `autoOn`, `autoTold`, `autoMaySend`, `privacySignal`, `markTold`, `setAuto` (kr.diag.auto, kr.diag.auto.told); the Settings → Video → Diagnostics row in ui/settings-model.ts | DiagSend SettingsToggle (counts as told) |
| auto.ts `showNotice`: the one-time toast on the title once `__kr.ready` (it asks nothing, links to Settings, goes away after 6 s), not under the privacy signal | DiagSend ShowNotice |
| auto.ts `emit` (sends when `autoMaySend()`, holds up to eight rows while the toast can still come, else drops) → `beacon` (navigator.sendBeacon to /api/diag/auto) | DiagSend AutoSend |
| report.ts `send` (the POST and its `TIMEOUT_MS` abort), `notSent`, and `body` and `minimise` (what a send carries; the callsign only when ticked) | Accepted, Refused, ToastGone |

**The first beat is written at boot, inside the lock.** main.ts calls `startBeat` once the boot JS has run, before the
world loads and before the lazy diag chunk arrives, so a tab killed during load still leaves a record (on a slow link
the lazy chunk queues behind the world's downloads). The record is written only once the page holds its Web Lock, so a slow boot never looks dead to another
tab: the mutant "the first beat is written outside the lock" breaks NoFalseCrash in 4 states. What is left, written
into NoLostCrash as `\cap started`: a tab killed before main.ts runs (while the boot JS downloads and parses) leaves
no record. Drop `\cap started` and TLC shows the path: Open, Kill, Open.

**Two dead sessions, one card:** when two sessions died (a browser crash with two tabs open), one load claims both and
the card asks about the newest only. The model counts both as picked up (`seen`), and at most one report goes out.

Not modelled: the production-build and `?diag=0` conditions of `summariesDefault` (a page without them never starts the summaries, the same as a bot page with no flag), time, the 7-day expiry of old records (`KEEP_MS`), browsers without Web Locks (they keep no heartbeat),
`SEND_GAP_MS` (a send within 10 s of the last one is turned away on screen and sends nothing), and, for the automatic
summary, which event makes a row (a long frame, low fps, a lost context, a repeated error, a crash, a match end), its
rate limits and its size. Those are in auto.ts and tools/playtest/diag-auto.test.mts; the model only guards whether a row
may leave. `tools/playtest/auto-consent.test.mts` runs consent.ts itself (default on, told first, off in Settings, both privacy signals,
blocked storage).

## Run it

```sh
node tools/formal/tlc.mjs DiagHeartbeat --mutants --record
node tools/formal/tlc.mjs DiagSend --mutants --record
```

Java 11 or newer on PATH. About a second each. Each mutant removes one guard the code has (the lock check, the pageshow
beat, the claim's delete, the consent check, the callsign tick in each send path, the refused message, the timeout) and
must make TLC report the rule its entry names. `--record` then writes the token hashes of the code regions into
`<Model>.covers.json`, and npm test's `formal` check (`tools/formal/drift.mjs`) fails when that code changes without a
re-check, or when other code writes the heartbeat records or the consent flag. To see the paths the first design takes,
copy a model and its `.findings.cfg` to a scratch folder (the config renamed to `<Model>.cfg`) and run
`java -cp <repo>/node_modules/.cache/tla2tools/1.7.4/tla2tools.jar tlc2.TLC <Model>.tla` there: TLC prints the shortest
path to the first rule it finds broken.

## Check it in a browser

Two tabs of one Playwright browser context share `localStorage` and Web Locks; a killed page is a crashed renderer (CDP
`Page.crash`); a refused upload is a routed 429 on `/api/kongbot` or the local server's rate limit. Only test against a
server you run.
