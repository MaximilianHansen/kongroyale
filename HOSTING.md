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
| `KR_MAX_CONNS` | `2000` | Most WebSockets the server holds at once. |
| `KR_MAX_PER_IP` | `120` | Most WebSockets from one address. Each player uses two. |
| `KR_HEARTBEAT_TIMEOUT_S` | `30` | Seconds of silence before the server drops a connection. |
| `KR_RESERVED_NAMES` | empty | Comma list of extra names players can't take. |
| `KR_MONGO_URI` | `mongodb://127.0.0.1:27017` | MongoDB for in-game bug reports. Optional: without it, reports wait in `.kongbot/spool/`. |
| `KR_MONGO_DB` | `kong_royale` | Database name for bug reports. |
| `KR_PERF_METRICS` | off | Set `1` to add tick times, event-loop delay and memory use to `/health`. |
| `KR_WARMUP_S` | `25` | Length of the pre-match warm-up in seconds. For test servers. |
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

## Behind a reverse proxy

Most public servers put a proxy in front for HTTPS. The proxy must forward WebSocket upgrades on `/ws` and
`/admin/ws`. Then set `KR_TRUST_PROXY=1`, `KR_HOST=127.0.0.1` so only the proxy can reach the port, and `KR_ORIGINS`
to your site's address.
