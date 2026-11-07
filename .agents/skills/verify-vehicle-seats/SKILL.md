---
name: verify-vehicle-seats
description: Model-check Kong Royale's vehicle seats (tuk-tuks and helicopters) with TLA+ - v.seats and each rider's st/veh/seat must always agree, one squad per vehicle, no dead rider. Use before calling done any change to how a kong gets into, out of, or between vehicle seats, or to what clears a seat - shared/sim/vehicle.ts freeSeat/enterVehicle/exitVehicle/switchSeat/takeSeat, shared/sim/match.ts useVehicle/ejectAll/kill/stepVehicles/spawnTuks, shared/sim/player.hot.ts stepRide, shared/sim/player.ts resetForMatch.
---

# Verify vehicle seats

A vehicle seat is stored twice: in the vehicle (`v.seats[k] = pid`, shared/sim/vehicle.ts) and in the rider
(`st === PS.Ride`, `veh`, `seat`, shared/sim/player.ts). Six places change one copy and must change the other. When
they disagree, a dead kong keeps a seat, two kongs drive one tuk-tuk, or a squad rides an enemy's vehicle, and since the
sim runs on both sides, the client's prediction rubber-bands. No test reaches these orders of events. This skill checks
every order of them in a small TLA+ model.

## The rules (tools/formal/VehicleSeats.tla)

| Rule | In plain words | If it breaks |
|---|---|---|
| SeatsAgree | A seat names a kong exactly when that kong rides this vehicle in this seat. | Ghost seats nobody can take, or a kong riding a seat the vehicle thinks is free. |
| NoDeadRider | No dead kong holds a seat. | A corpse blocks the seat; a dead driver steers. |
| OneSquad | Everyone in one vehicle is in one squad. | An enemy gets a free ride, or is carried into your squad's fight. |
| RideOnWheels | A kong rides only a vehicle on its wheels, or one that has just gone over or sunk and is about to throw it out. | A kong sits in a wreck or underwater. |

## Run it

```sh
node tools/formal/tlc.mjs VehicleSeats --mutants
```

It needs Java 11 or newer on PATH. The first run downloads the pinned TLA+ tools jar (version and SHA-256 in
tools/formal/tlc.mjs) into node_modules/.cache. A run takes about 5 seconds: 3 kongs in 2 squads, 2 vehicles of 3
seats, about 32,500 distinct states. Expected output: one `PASS VehicleSeats` line and one `PASS ... mutant` line per
entry in tools/formal/VehicleSeats.mutants.json. Exit 0 means all of them passed. Any other exit is a finding or a broken
setup, and the output says which.

Each mutant takes one guard out of a scratch copy of the model and must make TLC report the rule its entry names. A
mutant that still passes means the model can no longer see that guard. Fix the model, not the mutant.

On Windows, tlc.mjs suggests `winget install Microsoft.OpenJDK.21`. Microsoft's portable JDK zip also works without an
installer: unzip it and put its `bin` folder on PATH. On Windows on ARM, use the aarch64 build
(`https://aka.ms/download-jdk/microsoft-jdk-21-windows-aarch64.zip`), which runs natively. There the run took 7 s, including the first jar download.

## When the check fails

TLC prints the shortest path to the broken rule, one state per step, with the action that took each step. Read it
against the action table below, then decide which one it is:

- **A real bug.** The path is a sequence of real calls. Replay it against the code: a headless match
  with scripted riders (`npx tsx tools/sim-smoke.mts trios 7 --riders --check`, about 71,000 rider-ticks checked; a plain
  `trios 42` run checks 0, because nobody boards a vehicle in that match) or a small script that drives `Match`
  through the same calls. If it reproduces, report it with the path and the replay. Do not weaken the rule.
- **A modelling error.** The path uses a step the code cannot take (for example, a step the code guards that the model
  does not). Fix the model so that it says what the code does, and cite the code line in the action's comment.

## Keep the model in step with the code

Each action in the model names the function it stands for. When you change one of these, change the model in the
same pull request and run the check:

| Code | Model action |
|---|---|
| shared/sim/vehicle.ts `freeSeat`, `enterVehicle`; match.ts `useVehicle` | Enter, FreeSeat |
| player.hot.ts `stepRide` (E, or the vehicle not `VS.Ok`), vehicle.ts `exitVehicle` | GetOut, ExitSeats |
| vehicle.ts `switchSeat`, `takeSeat` | Switch |
| match.ts `kill` | Die |
| match.ts `ejectAll`, `tukEvents` (TIP, SUNK), `blowTuk` | EjectAll, Events, Blow |
| vehicle.ts `stepVehicle` / `stepTumble` tipping and sinking, `flipVehicle`, `stepRighting` | Tip, Sink, Flip, Righted |
| match.ts `stepVehicles` (wreck clear-up and respawn, the seat loop) | Clear, Heal |
| match.ts `spawnTuks` with `resetForMatch` in `enterWarmup` / `enterPlane` | Phase |
| match.ts `stepRespawns`, warm-up respawn, buy-back | Respawn |

Coverage record: tools/formal/VehicleSeats.covers.json names the code this model describes (one region per function,
method or switch case in the table above) and the writes it guards, and records a token hash of each region as of the
last run that passed. npm test's `formal` check (tools/formal/drift.mjs, no Java) fails when a region changed, moved or
vanished, when the model's own files changed, or when code outside the regions writes the guarded state. Then read each
change against the table: if the code changed shape, change the model and cite the line; if a function moved or a new
one writes the state, update the regions or the `allow` list (a function, each write it may make there, listed once per occurrence, and why). Re-verify and record in one step:

```sh
node tools/formal/tlc.mjs VehicleSeats --mutants --record
```

It writes the hashes only when the model and every mutant pass, so a model can't be marked verified without TLC.

## What it does not cover

Positions, physics and health are left out: any vehicle may tip, sink or blow up at any time, which covers every real
cause. Any order of players and vehicles inside one tick is allowed, which includes the real order. Helicopter-only
rules (the door gun, the rotor) are not modelled; their seats use the same functions. The model checks the shared
simulation's rules only, not the network: whether a client's prediction agrees with the server is netlab's job
(`npm run netlab`).
