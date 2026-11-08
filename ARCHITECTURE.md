# How Kong Royale works

This is a tour for someone who has never seen the code. It covers the big pieces and names the files where each one
lives. The comment at the top of each file goes into more detail.

## The big picture

Kong Royale has three parts:

- **`client/`**: the browser game. It draws the island with three.js, reads input, plays sound and shows the UI.
- **`server/`**: a Node.js process. It runs lobbies and matches, and decides everything that matters.
- **`shared/`**: the game rules and the network protocol. Both the server and the browser run this code.

```
      Browser (client/)                                     Server (server/)
 +-------------------------------+                 +-------------------------------+
 | input --> prediction          |   inputs 60/s   | lobby --> MatchHost --> Match |
 |           (shared/sim)        | --------------> |           (shared/net)        |
 |               ^               |                 |                (shared/sim)   |
 |   reconcile   |               |  snapshots 30/s |                               |
 |   snapshots --+--> three.js   | <-------------- | events, inventory, results    |
 +-------------------------------+                 +-------------------------------+
```

In **practice mode** (Play against bots) there is no server. The browser runs the same `Match` and `MatchHost`
classes itself, behind the same link interface the WebSocket uses (`client/src/game/net.ts`). So practice exercises
exactly the code an online match does.

## The match loop

The simulation runs at a fixed **60 ticks a second** (`TICK_HZ` in `shared/sim/const.ts`).

On the server (`server/index.ts`), each lobby with a running match has a timer that fires every 4 ms. It adds the
elapsed time to an accumulator and steps the match once per 1/60 s it owes, at most six steps at a time. If a match
throws errors more than five times, the server ends that match and sends its players back to the lobby. One broken
match never takes the process down.

`MatchHost.tick()` (`shared/net/host.ts`) does one step and sends what came out of it:

1. `Match.step()` (`shared/sim/match.ts`) advances the phase clock, the storm, every player (humans and bots), the
   vehicles, rockets, bombs, crate walls and respawns, then checks for a winner.
2. Events from that tick (hits, kills, chests opened and so on) go to every player as one binary frame.
3. Every second tick, each player gets a **snapshot** (30 a second).
4. Once a second, each player gets their inventory.

A match goes through four phases: **Warmup** (25 s on the lobby islet), **Plane**, **Play** and **Results** (14 s).
The warm-up waits up to 40 s for any player whose browser is still loading the island. Bots fill the empty seats, up
to 50 in solo and 48 in trios (`shared/sim/teams.ts` decides the squads).

Early in a match, a player who dies **redeploys** after a short wait (`RESURGENCE_S`). Later, at a storm phase or once
few squads remain, deaths become final.

## Inputs, prediction and reconciliation

The client never waits for the server to move its own kong. The netcode contract is written at the top of
`client/src/game/client.ts`:

- **Prediction.** Every tick, the client turns the player's controls into an `Input`, quantises it exactly as the
  server will decode it, sends it, and steps its own kong with `stepPlayer` from `shared/sim/player.ts`. It stores the
  result under the input's sequence number.
- **Reconciliation.** Each snapshot carries the server's exact state after the last input it processed (`lastSeq`). If
  that matches what the client predicted, nothing happens. If not, the client restores the server's state and replays
  every input the server hasn't processed yet.
- **Input pacing.** The server simulates every input exactly once, in order. A per-player credit lets a player catch up
  after a network stall but never move faster than 60 ticks a second.
- **Lag compensation.** Each input records which snapshot moment the player was looking at. When they shoot, the server
  rewinds other players to that moment (up to 350 ms back) and runs the same hit test as the client
  (`shared/sim/hitscan.ts`). What you saw hit is what the server counts as a hit.
- **Other players** are drawn slightly in the past, interpolated between snapshots, with a buffer that grows and
  shrinks with network jitter. They are never extrapolated.

The tuk-tuk and the helicopter (`shared/sim/vehicle.ts`, `shared/sim/heli.ts`) work the same way. The driver predicts
the vehicle; passengers and onlookers interpolate it.

## The wire

`shared/net/proto.ts` defines the protocol. The fast path (inputs, snapshots, events, inventory, pings) is binary,
little-endian, written with a `DataView`. The rare path (lobbies, match start, voice handshakes) is JSON.

Every binary frame decodes on its own: there is no delta compression against earlier frames. A lagging or late player
can pick up from any frame.

The binary frames go through one `Transport` (`shared/net/transport.ts`), the same shape on the client and the server.
`channelOf` puts each frame type on a channel: the input window (`M.Inputs`), pings, pongs and snapshots are
unreliable (a newer one replaces or repairs a lost one), everything else is reliable, including a single input
(`M.Input`, what a WebSocket client sends: each one is needed once and is sent once). JSON always rides the primary WebSocket. The receivers keep the ordering rules
(newest snapshot tick, each input seq once), so a transport may deliver a frame twice, late or never.

Today's transport is **two WebSockets** per player. Binary frames travel on both, and each end keeps the first copy it
gets. A WebSocket runs over TCP, so one lost packet stalls everything behind it; with two sockets, a stall needs both
to lose a packet at once.

When a server started with `KR_WT=1` offers its endpoint in `welcome` and puts the player in its WebTransport arm (`KR_WT_SHARE`, an A/B test: a tab keeps its arm, and `?wt=1` / `?wt=0` override it), the client loads a small lazy
chunk (`client/src/game/wt.ts`) and opens a **WebTransport** session instead of the aux socket: unreliable frames ride
QUIC datagrams, reliable ones the session's one stream. The session authenticates with the aux token and is in use once
the server answers `{ t: "wt-ok" }`. If it can't be had, or closes later, the link stays on (or goes back to) the
WebSocket pair. Either way the client tells the server once which transport it settled on and why (`{ t: "net" }`),
and `/health` counts those reasons across players.

Over datagrams nothing is resent, so the frames carry their own repair. Each tick the client sends its **input window**
(`M.Inputs`): every input the snapshots haven't acknowledged yet, at most `INPUT_WINDOW` (30, the most the server can
catch up), oldest first. A lost datagram costs nothing because the next one carries the same inputs, and the server
queues each seq once, in order (`Match.pushInput`). Each snapshot goes out as two datagrams
(`SNAPSHOT_DATAGRAM_COPIES`), the same downstream cost as the WebSocket pair. Over WebSockets the client keeps sending
single `M.Input` frames: on TCP a window is pure overhead. `/health` counts inputs lost (a seq never queued) and recovered
(queued from a window entry other than its newest).

When a client connects, the server's `welcome` message carries `NET_VERSION` and a hash of the whole collision world.
A client with a different world refuses to play and asks the player to reload.

## Snapshots and interest management

`writeSnapshotFor` in `shared/net/host.ts` builds one snapshot per player:

- The player's own state, at full precision (for reconciliation).
- Squadmates, anyone within 380 m, and anyone skydiving or gliding: every snapshot.
- Players farther away: one snapshot in three. They are beyond bullet range anyway.
- Enemies still in the plane: never sent.
- Exact health and shield: only for squadmates and for players within shooting range.
- Vehicles: often when near or moving, rarely when parked or far.

Each player's record is encoded once per tick and copied into every snapshot that needs it. If a socket falls behind
by more than 64 KB, the server skips its snapshots until it catches up, since the next one will be complete anyway.

## The shared simulation

Everything in `shared/` must give the same answer on the server and in the browser. It has no DOM or Node APIs, and
all randomness comes from the seeded generator in `shared/sim/rng.ts`. Hot paths, such as `stepPlayer`, collision
queries and hit tests, allocate nothing per tick.

| File | What it owns |
|---|---|
| `const.ts` | Every tunable: tick rate, movement speeds, weapon stats, timings |
| `player.ts` | Player state and the per-tick step: movement, jumping, swimming, skydiving, weapon timers, healing |
| `match.ts` | The authoritative match: phases, shots, damage, loot, storm damage, respawns, the winner |
| `hitscan.ts` | Hit testing against the kong-shaped hitbox, shared by client and server |
| `storm.ts` | The storm. The whole plan is picked from the seed at the start, so both sides draw the same circle |
| `loot.ts`, `loot-spots.ts` | Where chests and floor loot spawn (derived from the collision world) and what they hold |
| `bots.ts` | Bots. They send the same `Input` a human does, so the simulation never special-cases them |
| `vehicle.ts`, `heli.ts` | Tuk-tuks and helicopters |
| `plane.ts` | The drop plane's path and the exact exit point when you jump |
| `economy.ts` | Banana Bucks, Banana Stands and bounties |
| `world.ts`, `static-world.ts` | The collision world: the heightfield plus every box, built from one recipe on both sides |

## The island

`shared/world/map.ts` is the map contract: metres, +Y up, −Z north, sea level at 0, and the island centred on the
origin inside a 2.4 km square. Every point of interest (POI) has a centre and a flat pad the terrain promises to keep.

- **Terrain.** `shared/world/terrain-gen.ts` generates the island from a hand-drawn coastline plus hills, a volcano,
  cliffs, erosion and biomes. The result is baked into `public/assets/terrain/island.bin`. The server and the browser
  load the same bytes; the server generates the island itself only if the file is missing.
- **POIs.** Each location has two halves: `shared/pois/<id>.ts` holds its layout and collision boxes, and
  `client/src/world/pois/<id>/` builds what you see. `shared/pois/index.ts` lists them all.
- **Vegetation.** `shared/world/veg-scatter.ts` places every tree from the seed and the terrain. The server uses the
  trunks as colliders; the client draws them with instancing and impostors (`client/src/world/veg/`).

### Loading and streaming

`client/src/main.ts` boots the game. `client/src/world/registry.ts` lists every world module in build order. Each
module exports a `WorldModule` (`client/src/world/module.ts`) with a `build()` and optional `afterBuild()`.

The boot starts every module's download at once. The modules the title screen needs (sky, terrain, water, plants, the
lobby islet) build first. The rest of the island then builds in idle time, nearest to the islet first, while the player
is on the title screen or in the warm-up. Long builds yield between chunks so the page keeps painting. Heavy work runs
in Web Workers: the collision world (`client/src/engine/static-world.worker.ts`), loot spots, terrain jobs and plant
scatter. Distant POIs are merged into fewer draw calls (`client/src/engine/hlod.ts`).

Useful URL flags for development: `?debug` shows boot errors on screen, `?seed=N` makes a practice match repeatable,
`?modules=atmos,terrain` builds only some modules, and `?q=low` picks a quality level.

## Assets

Models, textures, sounds and fonts live in `public/assets/`, one folder per area (actors, audio, pois, terrain, ui,
veg, vehicles, water). Textures are WebP or KTX2, models are glTF binaries, and sounds come in two formats (Opus in
`.ogg`, AAC in `.m4a`); the browser picks the one it supports. Decoders for compressed models and textures are in
`public/assets/decoders/` and `public/assets/actors/basis/`.

`npm run build` runs Vite, which copies `public/` into `dist/` unchanged and bundles the code. It also builds the
admin pages into `dist-admin/`, which the server hands out only through `/admin`. Then
`tools/performance/precompress.mjs` writes Brotli and gzip copies next to each compressible file. `server/static.ts`
serves those copies when the browser accepts them, so the server never compresses anything while matches run.

Every asset needs a known source and a licence. See [CREDITS.md](CREDITS.md).

## Admin and event lobbies

For organised events, an admin runs lobbies from `/admin` (`server/admin/`, `client/src/admin/`, protocol in
`shared/net/event.ts`). The admin logs in with a key; the server only knows its SHA-256 hash. The admin creates an
event lobby, shares its link, sorts players into teams, and starts, ends or closes rounds. Players can't take over an
event lobby, and their team picks survive reconnects.

With `KR_EVENT_MODE` on (the default), players can only join lobbies by link. `npm test` runs a red-team script
against the admin login and console (`tools/admin-lobby/redteam.mjs`). [HOSTING.md](HOSTING.md) explains the setup.

## Caster seats

A caster seat (`?caster` in the URL, `client/src/caster/`) watches a match without playing in it. Up to eight seats can
join any lobby, even mid-match. They get a full-information snapshot: every player with exact health, and every
vehicle. A caster can also open an exhibition of 50 bots.

## KONGBOT bug reports

KONGBOT is the in-game bug reporter. A player types `/kongbot <what went wrong>` in the chat bar (`/` opens it), and the
client sends the message with a screenshot and the game's state (`client/src/kongbot/`). The server stores reports in
MongoDB, or on disk in `.kongbot/spool/` when MongoDB isn't available (`server/kongbot.ts`).

## Voice

Squad voice is peer to peer over WebRTC (`client/src/voice/`). The server only relays the connection handshake and
tells each squad who has a microphone (`server/voice.ts`). A player can reach only their own squadmates and the caster
seats listening to their squad. Browsers allow the microphone only on HTTPS or `localhost`.

## Words used in the code

- **View cameras:** fixed cameras opened with `?view=<id>` (`client/src/engine/views.ts`), used for screenshots and
  visual checks. Locations are laid out so they read well from them.
- **Target art:** the painted concept images each location, biome and asset was built to match. They aren't in
  this repository, so comments quote the colours and framing measured from them.
- **Toon design:** the UI design system in `client/src/ui/toon.ts` (colours, type and components) that the HUD and
  lobby styles use.

## Tests

`npm test` (`tools/run-tests.mjs`) runs every check that needs no GPU, network or database: the type check, movement
and swimming, the kong's face and animation, the building walk graph, the bots' path solver, glass, wire and geometry
parity, a full headless match with seed 42 (`npm run sim`), and the admin red team. Run `npm run build` first.
