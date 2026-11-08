# Run your own server

One Node process serves the game files and runs every multiplayer match. You need Node.js 22.12 or newer and a
machine that can keep a CPU core busy during matches.

```sh
npm ci           # install everything, including dev dependencies (npm start uses tsx)
npm run build    # build the client into dist/ and precompress it
npm start        # serve dist/ and the game server on port 3020
```

Open `http://<your machine>:3020/` once the server prints a line starting `KONG ROYALE server on`. Startup takes a
few seconds while it builds the island's collision world. `GET /health` returns a small JSON status for uptime checks.

`npm start` sets `KR_SERVE=1` with POSIX shell syntax. On Windows, run it from Git Bash or WSL.

## How players get into a match

A fresh build is set up for hosted events:

- The title screen shows one **Play** button, which starts a bot match in the player's browser, with a live player
  count under it (labelled "Live playtest"). Solo / Trios, bot
  difficulty and Friends are hidden; the Firing Range is still there.
- Players can't create rooms (`KR_EVENT_MODE` is on). Instead, an admin creates **event lobbies** at `/admin` and
  shares their links. Players open the link, pick a team and wait for the admin to start.

To run event lobbies, create an admin key and give the server its hash:

```sh
node tools/admin-lobby/key.mjs                                    # writes .admin-key; it never prints the key
KR_ADMIN_KEY_SHA256=$(node tools/admin-lobby/key.mjs --hash) npm start
```

Open `/admin` and paste the key from `.admin-key`. Keep that file private. `--rotate` replaces the key, and
`KR_ADMIN_KEY_FILE=<path>` makes the tool use a different file.

If you'd rather let anyone create a private room and share its code, build and run with both of these:

```sh
VITE_KR_PLAYTEST=0 npm run build   # the full title screen: Solo / Trios, bot difficulty, Friends
KR_EVENT_MODE=0 npm start          # players may create rooms
```

## Settings

The server reads these environment variables. Leave a variable unset to get its default.

| Variable | Default | What it does |
|---|---|---|
| `KR_PORT` or `PORT` | `3020` | Port for the web page, the API and the WebSockets. `KR_PORT` wins if both are set. |
| `KR_HOST` | `0.0.0.0` with `npm start`, `127.0.0.1` with `npm run server` | Address to listen on. |
| `KR_SERVE` | `1` with `npm start` | Also serve the built client from `dist/`. Without it the server only answers WebSockets and the API. |
| `KR_EVENT_MODE` | on | Players can only join lobbies by link. Set `0` to let players create rooms and caster exhibitions. |
| `KR_PLAYTEST_BUNDLES` | off | `1` (or a folder path) saves playtest bundles (F8 and KONGBOT reports with `?perfhud`) to disk. `npm run server` defaults it to `1`; `npm start` does not. `0` switches it off. `npx tsx tools/playtest/cli.mts list` reads the folder. |
| `KR_ADMIN_KEY_SHA256` | unset (admin off) | SHA-256 of the admin key, from `node tools/admin-lobby/key.mjs --hash`. Never the key itself. |
| `KR_ADMIN_ALLOW_IPS` | empty | Comma list of addresses that skip the global wrong-key brake. Per-address lockouts still apply. |
| `KR_ADMIN_ORIGINS` | `KR_ORIGINS` | Origins allowed to use the admin pages, if they differ from the site's own. |
| `KR_ADMIN_SESSION_S` | `43200` (12 h) | Admin session length in seconds, from 2 s up to 12 h. |
| `KR_SECURE_COOKIE` | off | Set `1` to mark the admin cookie `Secure` when HTTPS ends somewhere the server can't see. |
| `KR_BASE_PATH` | empty | The public prefix if a proxy serves the game under a sub-path, such as `/kong`. Build with `DEPLOY_BASE` to match. |
| `KR_IP_SALT` | random at each start | Salt for the hashed addresses that admin logins and lobby kicks use. The server never stores raw addresses there. |
| `KR_TRUST_PROXY` | off | Set `1` to read the player's real address from proxy headers. See below before you set it. |
| `KR_PROXY_IPS` | empty | Comma list of extra proxy addresses to trust, besides this machine. Only used with `KR_TRUST_PROXY=1`. |
| `KR_ORIGINS` | empty (any) | Comma list of page origins allowed to open a game WebSocket, such as `https://example.com`. |
| `KR_MAX_CONNS` | `2000` | Most connections (WebSockets and WebTransport sessions) the server holds at once. |
| `KR_MAX_PER_IP` | `120` | Most connections from one address. Each player uses two. |
| `KR_HEARTBEAT_TIMEOUT_S` | `30` | Seconds of silence before the server drops a connection. |
| `KR_RESERVED_NAMES` | empty | Comma list of extra names players can't take. |
| `KR_MONGO_URI` | `mongodb://127.0.0.1:27017` | MongoDB for in-game bug reports. Optional: without it, reports wait in `.kongbot/spool/`. |
| `KR_MONGO_DB` | `kong_royale` | Database name for bug reports. |
| `KR_PERF_METRICS` | off | Set `1` to add tick times, event-loop delay and memory use to `/health`. |
| `KR_WARMUP_S` | `25` | Length of the pre-match warm-up in seconds. For test servers. |
| `KR_WT` | off | Set `1` to open the WebTransport endpoint (QUIC datagrams for inputs and snapshots) for the share of players `KR_WT_SHARE` names. See "WebTransport" below. |
| `KR_WT_SHARE` | `1` | With `KR_WT=1`: the share of players, `0` to `1`, the server puts in the WebTransport arm of its A/B. The rest stay on WebSockets. |
| `KR_WT_PORT` | `KR_PORT` | UDP port of the WebTransport endpoint. |
| `KR_WT_HOST` | `KR_HOST`, or `0.0.0.0` when `KR_TRUST_PROXY=1` and `KR_HOST` is loopback | Address the WebTransport endpoint listens on. Behind a proxy on loopback it listens on every address, because UDP comes straight from players. |
| `KR_WT_CERT`, `KR_WT_KEY` | unset (self-signed) | PEM certificate and key for the WebTransport endpoint, valid for the page's host name. |
| `KR_WT_URL` | `https://<page host>:<KR_WT_PORT>/wt` | The address players dial, if it differs. |
| `KR_ANNOTATE` | off | Set `1` to accept developer notes from other machines. A local dev tool; leave it off on a public server. |

These are read when you build or run the dev server, not by the game server:

| Variable | Default | What it does |
|---|---|---|
| `VITE_KR_PLAYTEST` | unset: simple title in a build, full title in `npm run dev` | `1` forces the simple title screen (one Play button); `0` forces the full one. |
| `DEPLOY_BASE` | `/` | The sub-path the built client is served from. |
| `KR_HTTPS_KEY`, `KR_HTTPS_CERT` | unset | PEM files that make `npm run dev` use HTTPS, so a phone or another computer can use its microphone for voice. |

## Bug reports

KONGBOT is the in-game bug reporter (`/kongbot <message>` in the chat bar). Without MongoDB, reports pile up in
`.kongbot/spool/`; delete them if you don't want them.

Reports from the player diagnostics sheet (`?diag`) arrive gzip-compressed (`Content-Encoding: gzip`). The server
inflates them itself, up to the same 12 MB as an uncompressed report, so a proxy in front must pass the body through
unchanged (nginx and Caddy do by default) and allow bodies that large (nginx: `client_max_body_size 12m;` on the
`/api/kongbot` location).

## Be careful with these

- **`KR_TRUST_PROXY`**: set it only when a reverse proxy (nginx, Caddy) runs on the same machine, or at an address you
  list in `KR_PROXY_IPS`. The server then believes the client address that proxy reports, and every per-address limit,
  lockout and kick depends on it. Without it, behind a proxy every player shares one address and quickly hits the
  per-address limits.
- **The admin key**: only ever put its hash in the environment. Make it with `node tools/admin-lobby/key.mjs`. Never
  commit `.admin-key` (it's in `.gitignore`), and rotate it with `--rotate` if it leaks.
- **`KR_EVENT_MODE=0`** on a public server lets anyone create rooms (at most 4 per address and 400 in total).
- **Raising `KR_MAX_CONNS` or `KR_MAX_PER_IP`** makes it easier for one address to exhaust the server.

## WebTransport

Players use WebSockets unless the deployment turns WebTransport on. With `KR_WT=1` the server also listens for
WebTransport (HTTP/3 over QUIC, so UDP) on `KR_WT_PORT`, and `KR_WT_SHARE` picks the share of players who use it, so
the two transports can be compared in real play (an A/B test). A player in the WebTransport arm sends inputs and gets
snapshots and pings as datagrams, so one lost packet no longer stalls the ones behind it; the other frames ride the
session's reliable stream. The WebSocket stays open as the control channel and is the fallback: a player whose network
blocks UDP, or whose browser has no WebTransport, plays over WebSockets as before.

### Turn it on

Set both on the game server and restart it:

```sh
KR_WT=1 KR_WT_SHARE=0.5 npm start    # WebTransport for half the players, WebSockets for the other half
```

- `KR_WT_SHARE` goes from `0` to `1`. Unset, it is `1`: every player. `0` keeps the endpoint open but puts no new
  player in the WebTransport arm.
- The server draws each player's arm when they connect and tells their browser in `welcome`. A browser tab keeps the
  first arm it gets for as long as it is open, through reconnects and reloads, so a player never switches transport
  mid-session. A new share applies to tabs opened after the restart.
- `?wt=1` in the page address always tries WebTransport and `?wt=0` never does, whatever the arm. They are for testing,
  and those players are counted as `forced-wt` and `forced-ws`, outside the experiment.
- To turn it off, unset `KR_WT`. Everyone is then on WebSockets.
- A match on WebTransport costs the server about twice the CPU of the same match on WebSockets (the QUIC library runs
  on the server's main thread), so at `KR_WT_SHARE=1` one server process holds about half as many matches.

### What the server needs

- **UDP**: open `KR_WT_PORT` for UDP in the firewall (by default the same number as the HTTP port, 3020). Nothing may
  sit in front of it: CDNs and the usual reverse proxies don't forward WebTransport. Players who can't reach it still
  play: their link gives up on WebTransport within about 3 s and stays on WebSockets.
- **Certificate**: either set `KR_WT_CERT` and `KR_WT_KEY` to a real certificate for the page's host name (the
  same one the HTTPS proxy uses works), or leave them unset. The server then makes its own certificate, valid 13 days
  and renewed in place, and tells each player its SHA-256 so the browser can check it (`serverCertificateHashes`).
- **The QUIC module** (`@fails-components/webtransport-transport-http3-quiche`) is a native optional dependency with
  ready builds for Linux and macOS (x64 and ARM) and Windows x64. Its install script downloads the build, so an install that
  skips scripts (`npm ci --ignore-scripts`, or Bun, which runs no dependency scripts unless told to) leaves it out:
  run `npm rebuild @fails-components/webtransport-transport-http3-quiche` afterwards. Where it doesn't install, the server logs why, says so
  in `/health` (`transports.webtransport.off`) and runs WebSocket-only.

### Read the A/B

- `/health` counts clients per transport (`transports.clients`), sessions opened and refused, by reason, and how links
  settled (`transports.settled`: on `wt`, or on `ws` with why: `flag-off` (the page or the arm chose WebSockets),
  `server-off`, `unsupported`, `connect-failed`, `timeout`, `auth`, `closed`, `no-datagrams`), as each player's
  browser reports it. `transports.arms` splits that by arm (`wt`, `ws`, `forced-wt`, `forced-ws`, `off`) and adds
  each arm's inputs in running matches as the server queued them: `seqs`, `lost` and `recovered` (from the input
  window). `transports.webtransport.share` is the share in force. The arm and the fallback reason are what each
  browser reports: the server takes only a known arm, once per link, but a kept arm and a made-up one look the same
  to it, so a player can move their own links between arms. That skews the counts by their share of the links and
  touches nothing in the match.
- Every KONGBOT report, F8 mark and diagnostics bundle carries the link's arm, transport, fallback reason, input→ack
  times and the hit markers that waited for the server (`ctx.game.net`).
- `npx tsx tools/playtest/ab.mts --health http://<your server>:3020/health` splits the saved bundles by arm
  (input→ack, deferred markers per minute of play, ping, lag spikes, fallbacks) and adds the server's input gaps per
  arm. Compare `wt` with `ws`; the forced and off rows are not part of the experiment.

## Behind a reverse proxy

Most public servers put a proxy in front for HTTPS. The proxy must forward WebSocket upgrades on `/ws` and
`/admin/ws`. Then set `KR_TRUST_PROXY=1`, `KR_HOST=127.0.0.1` so only the proxy can reach the port, and `KR_ORIGINS`
to your site's address.

WebTransport (`KR_WT=1`) can't go through the proxy. It listens for UDP on `KR_WT_PORT` on every address
(`KR_WT_HOST` defaults to `0.0.0.0` with `KR_TRUST_PROXY=1` and a loopback `KR_HOST`), so open that port to players in the firewall.
