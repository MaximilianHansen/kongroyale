// The site a public server process serves over HTTP (the single server process, or the front of a multi-process one,
// server/front.ts): the admin area (server/admin/http.ts, the single process only), player bug reports, automatic performance summaries,
// dev-view notes, /health and the built client from dist/ (with KR_SERVE=1). The game WebSockets are not here: server/index.ts takes them.
import path from "node:path";
import type http from "node:http";
import { ipOf } from "./addr";
import { annotationsApi } from "./annotations";
import { autoCapBytes, autoDir, diagAutoApi } from "./diag-auto";
import { kongbotDb } from "./kongbot";
import { serveStatic } from "./static";
import type { createAdminHttp } from "./admin/http";

export function createSite(o: { root: string; serve: boolean; adminHttp?: ReturnType<typeof createAdminHttp>; /** what /health adds; `ok: false` (a front with a match process down) answers 503 */ health(): Record<string, unknown> & { ok?: boolean }; log(...a: unknown[]): void }) {
  const dist = path.join(o.root, "dist"), log = o.log;
  // player bug reports (/kongbot in the game's chat bar) → MongoDB
  const kongbot = kongbotDb(o.root);
  // dev view notes (?dev=annotate) → .kongbot/annotations/*.jsonl (+ Mongo kongbot_annotations)
  const annotations = annotationsApi(o.root);
  // automatic performance summaries from players who opted in (?diag) → <KR_DIAG_AUTO>/<date>.jsonl, own limits
  const diagAuto = diagAutoApi(autoDir(o.root, process.env.KR_DIAG_AUTO ?? (process.env.npm_lifecycle_event === "server" ? "1" : undefined)), log, autoCapBytes(process.env.KR_DIAG_AUTO_MB, log));
  if (diagAuto.dir) log(`automatic summaries are written to ${diagAuto.dir}`);
  function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = (req.url || "/").split("?")[0];
    // (admin lobby) /admin, /admin/api/*, /api/event/CODE — before anything else (server/admin/http.ts)
    if (o.adminHttp?.handle(req, res, url)) return;
    if (url === "/api/kongbot") {
      // a failed store always answers (the client shows "couldn't send"), never a hung request
      void kongbot.handle(req, res, ipOf(req)).catch((error) => {
        log("report request failed", error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: "could not store the report" }));
      });
      return;
    }
    if (url === "/api/diag/auto") {
      void diagAuto.handle(req, res, ipOf(req)).catch((error) => {
        log("automatic summary request failed", error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: "could not store the row" }));
      });
      return;
    }
    if (url === "/api/annotations") {
      void annotations.handle(req, res, ipOf(req)).catch((error) => {
        log("annotation request failed", error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: "could not store the note" }));
      });
      return;
    }
    if (url === "/health") {
      const h = { ok: true, feedback: kongbot.health(), diagAuto: diagAuto.health(), ...o.health() };
      res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(h)); return;
    }
    if (!o.serve || (req.method !== "GET" && req.method !== "HEAD")) { res.writeHead(404); res.end(); return; }
    void serveStatic(req, res, url, dist).catch((error) => { log("asset request failed", error); if (!res.headersSent) res.writeHead(500); res.end(); });
  }
  /** (stops their timers; an in-flight queue import finishes first) */
  const close = () => { void kongbot.close(); void annotations.close(); diagAuto.close(); };
  return { handle, close };
}
