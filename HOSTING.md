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
| `KR_WT` | off | Set `1` to open the WebTransport endpoint (QUIC datagrams for inputs and snapshots). See "WebTransport" below. |
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

With `KR_WT=1` the server also listens for WebTransport (HTTP/3 over QUIC, so UDP) on `KR_WT_PORT`. Players who
open the page with `?wt=1` get snapshots and pings as datagrams there, so one lost packet no longer stalls the ones
behind it; inputs and the other frames ride the session's reliable stream. The WebSocket stays open as the control channel and is the fallback: a player whose network blocks UDP, or
whose browser has no WebTransport, plays over WebSockets as before.

- **UDP**: open `KR_WT_PORT` for UDP in the firewall. Nothing may sit in front of it: CDNs and the usual reverse proxies
  don't forward WebTransport.
- **Certificate**: either set `KR_WT_CERT` and `KR_WT_KEY` to a real certificate for the page's host name (the
  same one the HTTPS proxy uses works), or leave them unset. The server then makes its own certificate, valid 13 days
  and renewed in place, and tells each player its SHA-256 so the browser can check it (`serverCertificateHashes`).
- **The QUIC module** (`@fails-components/webtransport-transport-http3-quiche`) is a native optional dependency with
  ready builds for Linux and macOS (x64 and ARM) and Windows x64. Its install script downloads the build, so an install that
  skips scripts (`npm ci --ignore-scripts`, or Bun, which runs no dependency scripts unless told to) leaves it out:
  run `npm rebuild @fails-components/webtransport-transport-http3-quiche` afterwards. Where it doesn't install, the server logs why, says so
  in `/health` (`transports.webtransport.off`) and runs WebSocket-only.
- `/health` counts clients per transport (`transports.clients`), sessions opened and refused, by reason, and how links
  settled (`transports.settled`: on `wt`, or on `ws` with why: `flag-off`, `server-off`, `unsupported`,
  `connect-failed`, `timeout`, `auth`, `closed`, `no-datagrams`), as each player's browser reports it.

## Behind a reverse proxy

Most public servers put a proxy in front for HTTPS. The proxy must forward WebSocket upgrades on `/ws` and
`/admin/ws`. Then set `KR_TRUST_PROXY=1`, `KR_HOST=127.0.0.1` so only the proxy can reach the port, and `KR_ORIGINS`
to your site's address.

WebTransport (`KR_WT=1`) can't go through the proxy. It listens for UDP on `KR_WT_PORT` on every address
(`KR_WT_HOST` defaults to `0.0.0.0` with `KR_TRUST_PROXY=1` and a loopback `KR_HOST`), so open that port to players in the firewall.
