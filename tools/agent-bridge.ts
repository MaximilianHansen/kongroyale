// AGENT BRIDGE (dev server only): a live line from a coding agent into the game tab that is running right now.
// The agent POSTs JavaScript to /__agent/run; the open game tab (client/src/dev/agent-link.ts) long-polls
// /__agent/next, runs it as an async function with `kr` (window.__kr) in scope, and posts the value back to
// /__agent/result, which answers the agent's waiting request. One tab at a time: the newest poller wins.
//
//   curl -s localhost:5317/__agent/run -H "x-kr-agent-token: $(cat .kongbot/agent-token)" --data-binary 'return kr.fps()'
//   curl -s localhost:5317/__agent/status -H "x-kr-agent-token: $(cat .kongbot/agent-token)"   → { connected, … }
//
// Who may do what (this endpoint runs code in the player's tab):
//   • every route: loopback only — the dev server also listens on the network (--host).
//   • /run, /status (the agent): the token header. A fresh random token is written to .kongbot/agent-token (git-ignored,
//     and denied to the browser by vite.config.ts) each time the dev server starts, so a local tool can read it and a
//     web page in the same browser can't: without this, any site the developer has open could POST code to /run.
//   • /next, /result (the game tab): a same-origin request (Sec-Fetch-Site, which a page can't forge), so another site
//     can neither take the agent's code nor answer for the tab.
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const POLL_MS = 25_000, RUN_TIMEOUT_MS = 120_000, MAX_BODY = 1 << 20;
const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

export const agentBridge = (): Plugin => ({
  name: "kr-agent-bridge", apply: "serve",
  configureServer(server) {
    const token = randomBytes(24).toString("hex");
    const tokenFile = path.join(server.config.root, ".kongbot", "agent-token");
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
    const hasToken = (req: IncomingMessage) => {
      const h = req.headers["x-kr-agent-token"];
      const a = Buffer.from(typeof h === "string" ? h : ""), b = Buffer.from(token);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    const sameOrigin = (req: IncomingMessage) => req.headers["sec-fetch-site"] === "same-origin";

    let poller: ServerResponse | null = null, lastSeen = 0, seq = 0;
    const queue: { id: number; code: string }[] = [];
    const waiting = new Map<number, { res: ServerResponse; timer: NodeJS.Timeout }>();

    const body = (req: IncomingMessage) => new Promise<string>((ok, fail) => {
      let s = "";
      req.on("data", (c) => { s += c; if (s.length > MAX_BODY) { fail(new Error("body too large")); req.destroy(); } });
      req.on("end", () => ok(s));
      req.on("error", fail);
    });
    const json = (res: ServerResponse, code: number, v: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
    const flush = () => {
      if (!poller || !queue.length) return;
      const p = poller; poller = null;
      json(p, 200, queue.shift());
    };

    server.middlewares.use("/__agent", async (req, res) => {
      if (!LOOPBACK.includes(req.socket.remoteAddress ?? "")) return json(res, 403, { error: "loopback only" });
      const url = req.url ?? "/";
      try {
        if (url.startsWith("/status")) {
          if (!hasToken(req)) return json(res, 403, { error: "agent token required" });
          return json(res, 200, { connected: Date.now() - lastSeen < POLL_MS + 5_000, lastSeenMs: lastSeen ? Date.now() - lastSeen : null, queued: queue.length });
        }

        if (url.startsWith("/next")) {
          if (!sameOrigin(req)) return json(res, 403, { error: "the game tab only" });
          lastSeen = Date.now();
          if (poller) json(poller, 204, null);
          poller = res;
          const t = setTimeout(() => { if (poller === res) { poller = null; res.statusCode = 204; res.end(); } }, POLL_MS);
          res.on("close", () => { clearTimeout(t); if (poller === res) poller = null; });
          return flush();
        }

        if (url.startsWith("/result") && req.method === "POST") {
          if (!sameOrigin(req)) return json(res, 403, { error: "the game tab only" });
          lastSeen = Date.now();
          const r = JSON.parse(await body(req)) as { id: number };
          const w = waiting.get(r.id);
          if (w) { clearTimeout(w.timer); waiting.delete(r.id); json(w.res, 200, r); }
          return json(res, 200, { ok: true });
        }

        if (url.startsWith("/run") && req.method === "POST") {
          if (!hasToken(req)) return json(res, 403, { error: "agent token required (.kongbot/agent-token)" });
          const code = await body(req), id = ++seq;
          const timer = setTimeout(() => {
            waiting.delete(id);
            const i = queue.findIndex((j) => j.id === id);
            if (i >= 0) queue.splice(i, 1);
            json(res, 504, { id, error: "no answer from the game tab (is it open on the dev server?)" });
          }, RUN_TIMEOUT_MS);
          waiting.set(id, { res, timer });
          queue.push({ id, code });
          return flush();
        }

        json(res, 404, { error: "unknown agent route" });
      } catch (e) {
        if (!res.headersSent) json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    });
  },
});
