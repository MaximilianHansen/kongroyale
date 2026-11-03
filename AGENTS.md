# Working on Kong Royale with an AI agent

This file is for AI coding agents, and for people who use them. It says how the project is laid out, how to check a
change, and which rules every change must follow. Read [CONTRIBUTING.md](CONTRIBUTING.md) too; everything there
applies to agent-written code as well. You are responsible for every line an agent writes for you.

## What this is

Kong Royale is a 50-player battle royale in the browser. The client is TypeScript and three.js, the server is Node.js
with WebSockets, and both run the same simulation from `shared/`. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the
pieces fit; read it before changing networking, the simulation or world loading.

## Layout

| Path | What's there |
|---|---|
| `client/src/game/` | The match on the client: prediction (`client.ts`), the network link (`net.ts`), rendering hooks, HUD state |
| `client/src/world/` | The island's visuals. `registry.ts` lists every module; `pois/<id>/` is one location each |
| `client/src/dev/` | A developer view for leaving notes on the world (`?dev=annotate`) |
| `client/src/` (other folders) | `engine/`, `ui/`, `audio/`, `actors/` (the kong), `weapons/`, `settings/`, `caster/`, `voice/`, `kongbot/`, `admin/` |
| `shared/sim/` | The game rules, run on both sides. `const.ts` holds every tunable number |
| `shared/net/` | The binary protocol (`proto.ts`) and the match host loop (`host.ts`) |
| `shared/world/`, `shared/pois/` | The map contract, terrain generator, vegetation scatter and POI collision |
| `server/` | Lobbies and the match loop (`index.ts`), admin lobbies (`admin/`), bug reports, voice relay, static files |
| `public/assets/` | Everything the browser downloads: models, textures, audio, fonts |
| `tools/` | The test runner and the tests, benchmarks, the admin key tool, the bug-report CLI |

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install exact dependency versions. Node 22.12 or newer. |
| `npm run dev` | Dev client on <http://localhost:5317/>. It listens on your network too (`--host`). Hot reload is off: reload the page after a change. |
| `npm run server` | Game server on port 3020, restarted when a file changes. Add `KR_EVENT_MODE=0` to allow creating rooms. |
| `npm run build` | Production build into `dist/` and `dist-admin/`, then precompression. About 15 s. |
| `npm test` | Every check that needs no GPU, network or database. Run `npm run build` first. About 2 min. |
| `npm run typecheck` | The TypeScript check alone (the first step of `npm test`). |
| `npm run sim` | A headless 50-bot match (trios, seed 42). Fast feedback for simulation changes. |
| `npm run netlab` | Hit registration under simulated latency, using the real client and server code. |
| `npm start` | Serve `dist/` and the game server on one port. See [HOSTING.md](HOSTING.md). |

## Rules

1. **The server is authoritative.** The client predicts and asks; the server decides hits, damage, loot, the storm and
   who wins. Never trust a value the client sends without checking it on the server.
2. **`shared/` runs on both sides, so it must stay deterministic.** Same inputs, same result, on Node and in every
   browser. No DOM APIs, no Node APIs (`node:*`, `process`), no `Math.random()` (use `Rng` from `shared/sim/rng.ts`
   with the match seed), and no wall-clock time in game logic. Keep hot paths (`stepPlayer`, collision, hit tests)
   free of per-tick allocations.
3. **Never commit secrets.** No `.env` files, keys, tokens or `.admin-key`. CI scans every pull request for them.
4. **Every asset needs a source and a licence.** Art, models, sounds and fonts must be your own or clearly free to use
   (CC0, or CC-BY with credit). Say where each one came from in the pull request and add it to
   [CREDITS.md](CREDITS.md) if it needs credit. Nothing taken from other games. No single file over 10 MB; CI rejects
   it, because every clone downloads the whole history.
5. **One change per pull request.** A bug fix doesn't come with a refactor of the file around it.
6. **Run `npm run build` and `npm test` before you open the pull request.** Both must pass. If a test fails on
   something you didn't touch, say so in the pull request. Never edit a test just to make it pass.
7. **Only test against servers you run.** Never point a script, bot, load test or browser automation at kongroyale.com
   or any server you don't run.

## Check it in the game

Tests don't show what a change looks or feels like. For anything a player can see or feel:

1. Run `npm run dev` and open <http://localhost:5317/>.
2. Press **Play** for a bot match in the browser, or open **Firing Range** for weapons, heals and hit registration.
3. Add `?seed=N` to the URL to replay the same practice match (same plane path, storm and loot).
4. Add `?debug` to show boot errors on screen.
5. For multiplayer changes, also run `KR_EVENT_MODE=0 npm run server` and play in a room with two browser windows.

To drive the game from a script (Playwright, for example), wait for `window.__kr.ready` to be `true` (the title is
playable) and read `window.__kr.errors` for anything that went wrong. The game needs a real GPU: headless Chrome must
use the hardware, for example `chromium.launch({ channel: "chrome", args: ["--use-angle=metal", "--enable-gpu"] })`
on a Mac. Software rendering is too slow to judge anything. Attach a screenshot or short clip to the pull request.

## Code style

There is no formatter or linter. Match the code around you:

- TypeScript in strict mode, ES modules, two-space indentation, double quotes, semicolons, LF line endings.
- Lines can be long. Wrap comments at about 120 characters.
- Every file starts with a comment saying what it owns and how it fits in. Keep it accurate when you change the file.
- Comments explain why, not what. A `/** ... */` comment on an exported field or function says what it means.
- `camelCase` for functions and variables, `PascalCase` for classes and types, `UPPER_CASE` for constants. Constants
  carry their unit in the name: `WARMUP_S`, `HEARTBEAT_MS`, `NEAR_R` (metres).
- World units are metres and seconds; +Y is up and −Z is north (`shared/world/map.ts`).
- Tunable game numbers belong in `shared/sim/const.ts`, not scattered through the code.
- Use `import type` for type-only imports. Wire ids are `const enum`s in `shared/net/proto.ts`.
- The client UI is plain DOM with small helpers, not a framework.
- No new dependencies without discussion.

## Ask first

Open an issue and discuss before changing any of these:

- **The wire format** (`shared/net/proto.ts`, `shared/net/event.ts`). Any change must bump `NET_VERSION` and update the
  client and server together.
- **The map contract and terrain** (`shared/world/map.ts`, `shared/world/terrain-gen.ts`). Moving a POI's centre or pad
  moves the ground under its buildings. `public/assets/terrain/island.bin` is baked from the generator, and the client
  and server must load the same bytes.
- **Game balance** in `shared/sim/const.ts`: weapon stats, movement speeds, storm timings, loot tables.
- **Security-sensitive server code**: connection limits and rate limits in `server/index.ts`, everything in
  `server/admin/`, the bug-report and voice endpoints, and the dev server's file rules in `vite.config.ts`.
- **Dependencies, CI and project files**: `package.json`, `.github/`, `LICENSE`, `CREDITS.md`.
- **New modes, weapons, vehicles or locations.** Good ideas, but big ones; agree the plan before building it.

Security problems and cheats go to [SECURITY.md](SECURITY.md), never to a public issue.
