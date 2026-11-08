// AGENT LINK (dev server only): the game tab's half of the agent bridge (tools/agent-bridge.ts). Long-polls the dev
// server for code an agent sent, runs it as an async function with `kr` (window.__kr) in scope, and posts back the
// value or the error. main.ts loads it only under `vite` (import.meta.env.DEV), never in a build or a ?shot capture.
// Its requests are same-origin, which is what the bridge checks for this side (the agent side needs the token).
const BASE = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}__agent`;

/** JSON-safe copy of a result: three.js objects are cyclic, so depth and size are capped */
function safe(v: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (v === null || typeof v !== "object") return typeof v === "function" ? "[function]" : typeof v === "bigint" ? String(v) : v;
  if (seen.has(v)) return "[cycle]";
  if (depth > 4) return Array.isArray(v) ? `[array ${v.length}]` : `[${v.constructor?.name ?? "object"}]`;
  seen.add(v);
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => safe(x, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).slice(0, 200)) out[k] = safe((v as Record<string, unknown>)[k], depth + 1, seen);
  return out;
}

export function startAgentLink(kr: Record<string, unknown>) {
  const AsyncFn = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...x: unknown[]) => Promise<unknown>;
  const loop = async () => {
    for (;;) {
      let job: { id: number; code: string } | null = null;
      try {
        const r = await fetch(`${BASE}/next`, { cache: "no-store" });
        if (r.status === 200) job = await r.json();
        // (204 = the poll timed out with nothing to run; anything else is the dev server refusing: don't spin on it)
        else if (r.status !== 204) await new Promise((ok) => setTimeout(ok, 3000));
      } catch { await new Promise((ok) => setTimeout(ok, 3000)); }
      if (!job) continue;
      let reply: Record<string, unknown>;
      try { reply = { id: job.id, ok: true, value: safe(await new AsyncFn("kr", "THREE", job.code)(kr, kr.THREE)) }; }
      catch (e) { reply = { id: job.id, ok: false, error: e instanceof Error ? e.stack || e.message : String(e) }; }
      try { await fetch(`${BASE}/result`, { method: "POST", body: JSON.stringify(reply) }); } catch { /* the agent times out */ }
    }
  };
  void loop();
}
