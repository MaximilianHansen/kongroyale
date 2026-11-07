// Player diagnostics, the player's side (?diag): one sheet that sends a report to the game server.
//   REPORT A PROBLEM in the match menu opens it (under ?diag it takes over __kr.kongbot.open; the typed /kongbot bar and
//   F8 stay as they were), and SEND DIAGNOSTICS on the results screen sends at once once the player has agreed. SEND
//   with nothing typed sends diagnostics; a symptom chip and a short note make it a problem report. After a session that
//   died (the heartbeat in diag.ts), the title offers to send what is known about it.
// What goes out is minimised here: no callsign unless the player ticks it, no page URL, time zone, language, lobby code
// or lobby names, no console log, no routing flags. The body is a KONGBOT report (POST /api/kongbot, server/kongbot.ts):
// the diagnostics, the metrics timeline and the input replay ride in bundle (bundle.diag), which the server validates.
import { deadChecked, snapshot } from "./diag";

/** the callsign is offered, unticked, for credit in the fix and to find a player's logs; false removes the checkbox and
 *  the name */
const OFFER_CALLSIGN = true;
/** what the player agrees to before the first send; change it together with what body() sends */
const CONSENT_TEXT = "This helps us find stutters, crashes and lag. We send: your device type, graphics card, browser and game settings; how the game ran (frame rate, memory, ping) for the last 15 minutes; when it stuttered and why; a picture of the game view (not your screen, and without the HUD); and a recording of your inputs in this bot match so we can play it again. If you tick “Include my callsign”, we also send your callsign, so we can credit you when we fix what you found and find your reports in our logs. We don't send your account or anything outside the game. A random ID for this browser lets us count repeat reports once.";
const CONSENT_KEY = "kr.diag.consent", CONSENT_V = "1";
const CHIPS = ["Stutter", "Low FPS", "Lag", "Crashed", "Loading", "Looks wrong", "Other"];
/** the routing flags of client/src/flags.ts (lobby codes, event links, socket URLs): never sent */
const ROUTING = new Set(["cast", "caster", "e", "join", "mode", "program", "ws"]);
const NOTE_MAX = 280, TIMELINE_S = 900, SHOT_W = 1280, MAX_BODY_CHARS = 6_000_000, SEND_GAP_MS = 10_000, TIMEOUT_MS = 20_000;
/** ui/styles.ts UI colours and font, copied so this lazy chunk doesn't make the boot chunk export them */
const UI = { yellow: "#ffd400", creamText: "#fbf3c9", sans: "'KR Sans', Roboto, 'Helvetica Neue', Arial, sans-serif" };
const PHASES = ["warm-up", "plane", "play", "results"];

type Json = Record<string, unknown>;
interface Kongbot { open(): void; context(): Json; screenshot(): Promise<{ dataUrl: string; w: number; h: number } | null> }
interface Kr { kongbot?: Kongbot; playtestBundle?: () => Json; game?: { inMatch?: boolean; cm?: { phase: number; time: number } | null; lobby?: { name?: string } }; ready?: boolean }
const kr = () => (window as unknown as { __kr: Kr }).__kr;

const CSS = `
.kd-sheet { position: fixed; inset: 0; z-index: 100002; display: grid; place-items: center; background: rgba(4,14,22,0.6); font-family: ${UI.sans}; color: ${UI.creamText}; }
.kd-sheet[hidden], .kd-card[hidden] { display: none; }
.kd-box { width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box; background: rgba(10,30,46,0.96);
  border: 2px solid ${UI.yellow}; border-radius: 10px; padding: 16px 18px; box-shadow: 0 8px 28px rgba(0,0,0,0.5); }
.kd-box h2 { font: 800 22px 'Barlow Condensed', ${UI.sans}; letter-spacing: .1em; color: ${UI.yellow}; margin: 0 0 8px; }
.kd-box p { font: 500 13px/1.45 ${UI.sans}; margin: 0 0 10px; color: rgba(246,239,198,0.85); }
.kd-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 10px; }
.kd-chips button, .kd-btns button { font: 700 14px ${UI.sans}; color: ${UI.creamText}; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,212,0,0.4); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.kd-chips button[aria-pressed="true"] { background: ${UI.yellow}; color: #10202e; }
.kd-box textarea { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical; font: 600 15px ${UI.sans}; color: #fff; background: rgba(0,0,0,0.35);
  border: 1px solid rgba(255,212,0,0.35); border-radius: 6px; padding: 8px; outline: none; }
.kd-opts { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 10px 0; font: 600 13px ${UI.sans}; }
.kd-box details { font: 500 12px/1.5 ${UI.sans}; margin: 0 0 12px; color: rgba(246,239,198,0.75); }
.kd-box summary { cursor: pointer; font-weight: 700; }
.kd-btns { display: flex; gap: 8px; justify-content: flex-end; }
.kd-btns .kd-send { background: ${UI.yellow}; color: #10202e; border-color: ${UI.yellow}; }
.kd-status { font: 700 13px ${UI.sans}; min-height: 16px; margin-top: 8px; }
.kd-status.err { color: #ff8a7a; }
.kd-card { position: fixed; left: 24px; bottom: 24px; z-index: 100001; width: min(420px, calc(100vw - 48px)); box-sizing: border-box; background: rgba(10,30,46,0.94);
  border: 2px solid ${UI.yellow}; border-radius: 10px; padding: 12px 14px; font: 600 14px/1.4 ${UI.sans}; color: ${UI.creamText}; }
.kd-card .kd-btns { margin-top: 8px; }
.kd-toast { position: fixed; left: 50%; top: 14vh; transform: translateX(-50%); z-index: 100003; pointer-events: none; font: 800 20px 'Barlow Condensed', ${UI.sans};
  letter-spacing: .08em; color: #10202e; background: ${UI.yellow}; border-radius: 8px; padding: 10px 18px; transition: opacity .35s; }
`;

type Mode = "report" | "crash";
interface Moment { ctx: Json | null; shot: { dataUrl: string; w: number; h: number } | null }

const consented = () => { try { return localStorage.getItem(CONSENT_KEY) === CONSENT_V; } catch { return false; } };
const clientId = () => { try { return localStorage.getItem("kr-kongbot-id"); } catch { return null; } };
let lastSend = -Infinity;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

function toast(text: string): void {
  const t = el("div", "kd-toast", text);
  t.setAttribute("role", "status");
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; }, 5000);
  setTimeout(() => t.remove(), 5500);
}

/** the game view, downscaled to SHOT_W, as a JPEG data URL */
async function smaller(shot: { dataUrl: string; w: number; h: number } | null): Promise<Moment["shot"]> {
  if (!shot || shot.w <= SHOT_W) return shot;
  const img = new Image();
  img.src = shot.dataUrl;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = SHOT_W; c.height = Math.round((shot.h * SHOT_W) / shot.w);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL("image/jpeg", 0.8), w: c.width, h: c.height };
}

async function capture(withShot: boolean): Promise<Moment> {
  const kb = kr().kongbot;
  let ctx: Json | null = null;
  try { ctx = kb ? kb.context() : null; } catch { ctx = null; }
  const shot = withShot && kb ? await kb.screenshot().then(smaller).catch(() => null) : null;
  return { ctx, shot };
}

const keepFlags = (q: unknown) => Object.fromEntries(Object.entries((q ?? {}) as Record<string, string>).filter(([k]) => !ROUTING.has(k)));

/** the KONGBOT context without what a player shouldn't have to give */
function minimise(ctx: Json | null, withName: boolean): Json | null {
  if (!ctx) return null;
  const c = structuredClone(ctx) as Record<string, Json | null>;
  if (c.page) c.page = { ...c.page, url: null, query: keepFlags(c.page.query) };
  if (c.env) { const { tz: _tz, tzOffsetMin: _off, lang: _lang, ...env } = c.env; c.env = env; }
  const g = c.game as (Json & { lobby?: Json | null }) | null;
  if (g) {
    const lobby = g.lobby as { mode?: string; offline?: boolean; isHost?: boolean; players?: unknown[] } | null | undefined;
    c.game = { ...g, callsign: withName ? g.callsign : null, lobby: lobby ? { mode: lobby.mode, offline: lobby.offline, isHost: lobby.isHost, players: lobby.players?.length ?? 0 } : null };
  }
  return c;
}

/** the playtest bundle, its timeline cut to the last TIMELINE_S seconds and its flags to the non-routing ones */
function trimmedBundle(): Json | null {
  const b = kr().playtestBundle?.();
  if (!b) return null;
  const tl = b.timeline as { fields: string[]; rows: number[][]; dropped: number } | null;
  const cut = tl ? Math.max(0, tl.rows.length - TIMELINE_S) : 0;
  return { ...b, flags: keepFlags(b.flags), timeline: tl ? { ...tl, rows: tl.rows.slice(cut), dropped: tl.dropped + cut } : null };
}

function where(ctx: Json | null): string {
  const g = (ctx?.game ?? null) as { match?: { phase?: string; time?: number } | null; player?: { poi?: { name?: string; inside?: boolean } | null } | null } | null;
  const m = g?.match;
  if (!m) return "outside a match";
  const t = m.time ?? 0, poi = g?.player?.poi;
  return `in ${m.phase ?? "a match"} at ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}${poi?.name ? " near " + poi.name : ""}`;
}

interface Choice { mode: Mode; chip: string | null; note: string; withName: boolean; withShot: boolean }

function message(c: Choice, ctx: Json | null, prev: Json | null): string {
  if (c.mode === "crash" && prev) {
    const p = prev as { phase?: number; poi?: string | null; hidden?: boolean };
    const phase = (p.phase ?? -1) >= 0 ? "in the " + (PHASES[p.phase!] ?? "match") : "outside a match";
    return `Crash: the last session closed unexpectedly ${phase}${p.poi ? " near " + p.poi : ""}${p.hidden ? " (the tab was hidden)" : ""}${c.note ? ": " + c.note : ""}`;
  }
  const head = c.chip ? `[${c.chip}] ` : "";
  return (head + (c.note || "Diagnostics " + where(ctx))).slice(0, 2000);
}

/** build the body (only a crash report carries the dead session, so later reports aren't counted as crashes); past MAX_BODY_CHARS it drops the replay, then the picture, then all but the last 5 minutes */
function body(c: Choice, m: Moment, bundle: Json | null, diag: Json, prev: Json | null) {
  const ctx = minimise(m.ctx, c.withName), dropped: string[] = [];
  bundle = { ...bundle, diag: { ...diag, prev: c.mode === "crash" ? prev : null, install: clientId(), kind: c.mode === "crash" ? "crash" : c.chip || c.note ? "report" : "diagnostics", chip: c.chip, dropped } };
  const name = c.withName && OFFER_CALLSIGN ? kr().game?.lobby?.name ?? null : null;
  const replay = bundle?.replay as { opts?: { humans?: Array<{ name?: string }> } } | null | undefined;
  if (replay?.opts?.humans && !name) bundle = { ...bundle, replay: { ...replay, opts: { ...replay.opts, humans: replay.opts.humans.map((h) => ({ ...h, name: "" })) } } };
  const out = {
    v: 1, message: message(c, m.ctx, prev), reporter: { name, clientId: clientId(), sessionId: (diag.sid as string) ?? null },
    ctx, logs: [] as unknown[], trail: [] as unknown[], shot: c.withShot ? m.shot?.dataUrl ?? null : null, shotSize: c.withShot && m.shot ? [m.shot.w, m.shot.h] : null,
    sentAt: new Date().toISOString(), bundle,
  };
  const size = () => JSON.stringify(out).length;
  if (size() > MAX_BODY_CHARS && out.bundle?.replay) { out.bundle = { ...out.bundle, replay: null }; dropped.push("replay"); }
  if (size() > MAX_BODY_CHARS && out.shot) { out.shot = null; out.shotSize = null; dropped.push("picture"); }
  const tl = out.bundle?.timeline as { rows: number[][]; dropped: number } | null | undefined;
  if (size() > MAX_BODY_CHARS && tl && out.bundle) { const cut = Math.max(0, tl.rows.length - 300); out.bundle = { ...out.bundle, timeline: { ...tl, rows: tl.rows.slice(cut), dropped: tl.dropped + cut } }; dropped.push("timeline"); }
  return out;
}

function bodyNow(c: Choice, m: Moment) {
  const diag = snapshot() as Json;
  return body(c, m, trimmedBundle(), diag, (diag.prev ?? null) as Json | null);
}

async function send(c: Choice, m: Moment): Promise<string> {
  const json = JSON.stringify(bodyNow(c, m));
  // gzip where the browser can: a report is mostly numbers in JSON and shrinks about tenfold on a stream's uplink.
  // The server inflates it (server/kongbot.ts); a browser without CompressionStream sends it as it is
  const gz = typeof CompressionStream === "undefined" ? null : await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer().catch(() => null);
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(new Error("no answer from the server")), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = gz ? { "content-type": "application/json", "content-encoding": "gzip" } : { "content-type": "application/json" };
    const res = await fetch(base + "api/kongbot", { method: "POST", headers, body: gz ?? json, signal: ctl.signal });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; id?: string; error?: string } | null;
    // the server answers 200 with JSON only once the report is stored. On a starved main thread the abort can fire
    // after that answer arrived and before its body is read, which fails the read: the report still went
    const stored = res.ok && (res.headers.get("content-type") ?? "").startsWith("application/json");
    if (!j && stored) { lastSend = performance.now(); return ""; }
    if (!res.ok || !j?.ok) throw new Error(j?.error || "HTTP " + res.status);
    lastSend = performance.now();
    return j.id ?? "";
  } finally { clearTimeout(timer); }
}

/** why a send didn't go: the server's own words (rate limit, busy, too large), a timeout, or a dropped connection.
 *  Every refused send says so on screen. */
const notSent = (e: unknown) => (e instanceof TypeError ? "no connection to the server" : e instanceof Error ? e.message : String(e)).slice(0, 80);

/** a short list of what the body holds, from the body send() would build now (after its size cuts) */
function contents(c: Choice, m: Moment): string[] {
  const kb = (v: unknown) => Math.max(1, Math.round(JSON.stringify(v ?? null).length / 1024)) + " KB";
  const out = bodyNow(c, m), b = out.bundle, ctx = out.ctx ?? {}, d = b.diag as { events: unknown[]; path: { rows: unknown[] } };
  const list = [
    "Device, graphics card, browser, settings and the non-routing URL flags (" + kb(ctx) + ")",
    "Frame rate, memory and ping, one row per second (" + ((b?.timeline as { rows?: unknown[] } | null)?.rows?.length ?? 0) + " s, " + kb(b?.timeline) + ")",
  ];
  const steps = (ctx.perf as { resSteps?: unknown[] | null } | undefined)?.resSteps;
  if (steps?.length) list.push("3D-resolution steps the game took to keep its frame rate (" + steps.length + ", " + kb(steps) + ")");
  if (d) list.push("Stutter markers and their causes (" + d.events.length + ", " + kb(d.events) + ")", "Where you were and where you looked, once a second (" + d.path.rows.length + " s, " + kb(d.path) + ")");
  if (b?.replay) list.push("Your inputs in this bot match (" + kb(b.replay) + ")");
  if (out.shot) list.push("A picture of the game view (" + Math.round(out.shot.length * 0.75 / 1024) + " KB)");
  if (out.reporter.name) list.push("Your callsign");
  return list;
}

function installStyles(): void {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** the sheet: open(mode) captures the moment at once and shows what will be sent */
function createSheet() {
  const root = el("div", "kd-sheet");
  root.hidden = true;
  root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-label", "Send diagnostics");
  const box = el("div", "kd-box"), title = el("h2", "", "SEND DIAGNOSTICS"), consent = el("p", "", CONSENT_TEXT);
  const chips = el("div", "kd-chips"), note = el("textarea", "");
  note.maxLength = NOTE_MAX; note.placeholder = "What happened? (optional)"; note.spellcheck = true;
  const opts = el("div", "kd-opts");
  const check = (label: string, on: boolean) => { const l = el("label", ""), i = el("input", ""); i.type = "checkbox"; i.checked = on; l.append(i, " " + label); opts.appendChild(l); return i; };
  const withShot = check("Include the picture", true), withName = OFFER_CALLSIGN ? check("Include my callsign (so we can credit you in the fix and find your logs)", false) : null;
  const details = el("details", ""), summary = el("summary", "", "What's sent"), list = el("ul", "");
  details.append(summary, list);
  const btns = el("div", "kd-btns"), cancel = el("button", "close", "CANCEL"), sendBtn = el("button", "kd-send", "SEND");
  cancel.type = sendBtn.type = "button";
  btns.append(cancel, sendBtn);
  const status = el("div", "kd-status");
  box.append(title, consent, chips, note, opts, details, btns, status);
  root.appendChild(box);
  document.body.appendChild(root);
  let chip: string | null = null, mode: Mode = "report", moment: Moment = { ctx: null, shot: null }, returnTo: HTMLElement | null = null, sending = false, opens = 0, captured = false;
  for (const name of CHIPS) {
    const b = el("button", "", name);
    b.type = "button"; b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => { chip = chip === name ? null : name; for (const x of chips.children) x.setAttribute("aria-pressed", String(x.textContent === chip)); });
    chips.appendChild(b);
  }
  const choice = (): Choice => ({ mode, chip, note: note.value.trim().slice(0, NOTE_MAX), withName: !!withName?.checked, withShot: withShot.checked });
  const refresh = () => { list.replaceChildren(...contents(choice(), moment).map((t) => el("li", "", t))); };
  details.addEventListener("toggle", refresh);
  withShot.addEventListener("change", refresh); withName?.addEventListener("change", refresh);
  const close = () => { root.hidden = true; returnTo?.focus(); };
  cancel.addEventListener("click", close);
  sendBtn.addEventListener("click", async () => {
    if (sending) return;
    if (performance.now() - lastSend < SEND_GAP_MS) { status.className = "kd-status err"; status.textContent = "Just sent one. Try again in a few seconds."; return; }
    sending = true; sendBtn.disabled = true; status.className = "kd-status"; status.textContent = "Sending…";
    try {
      const id = await send(choice(), moment);
      try { localStorage.setItem(CONSENT_KEY, CONSENT_V); } catch { /* asked again next time */ }
      close();
      toast("SENT, THANKS" + (id ? " · " + id : ""));
    } catch (e) {
      status.className = "kd-status err"; status.textContent = "Not sent: " + notSent(e);
    } finally { sending = false; sendBtn.disabled = !captured; }
  });
  root.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  return {
    async open(m: Mode) {
      if (!root.hidden) return;
      returnTo = document.activeElement as HTMLElement | null;
      mode = m; chip = m === "crash" ? "Crashed" : null; note.value = ""; status.textContent = "";
      for (const x of chips.children) x.setAttribute("aria-pressed", String(x.textContent === chip));
      title.textContent = m === "crash" ? "YOUR LAST SESSION CLOSED" : "SEND DIAGNOSTICS";
      withShot.checked = m !== "crash"; withShot.disabled = m === "crash";
      if (withName) withName.checked = false;
      root.hidden = false;
      const n = ++opens;
      moment = { ctx: null, shot: null }; captured = false; sendBtn.disabled = true; list.replaceChildren(); note.focus();
      const got = await capture(m !== "crash");
      if (n !== opens || root.hidden) return;
      moment = got; captured = true; sendBtn.disabled = sending;
      refresh();
    },
  };
}

/** one tap: send at once when the player already agreed, else open the sheet */
async function quickSend(sheet: ReturnType<typeof createSheet>, button: HTMLButtonElement): Promise<void> {
  if (!consented()) { void sheet.open("report"); return; }
  if (performance.now() - lastSend < SEND_GAP_MS) { toast("JUST SENT ONE: TRY AGAIN IN A FEW SECONDS"); return; }
  button.disabled = true;
  try {
    const id = await send({ mode: "report", chip: null, note: "", withName: false, withShot: true }, await capture(true));
    button.textContent = "SENT";
    toast("SENT, THANKS" + (id ? " · " + id : ""));
  } catch (e) {
    button.disabled = false;
    toast("NOT SENT: " + notSent(e));
  }
}

/** the title card after a session that died */
function crashCard(sheet: ReturnType<typeof createSheet>, prev: { phase?: number }): void {
  const card = el("div", "kd-card"), text = el("div", "", (prev.phase ?? -1) >= 0 ? "Your last session closed unexpectedly during a match. Send what we know about it?" : "Your last session closed unexpectedly. Send what we know about it?");
  const btns = el("div", "kd-btns"), no = el("button", "close", "NO THANKS"), yes = el("button", "kd-send", "SEND");
  no.type = yes.type = "button";
  btns.append(no, yes);
  card.append(text, btns);
  document.body.appendChild(card);
  no.addEventListener("click", () => card.remove());
  const gone = setInterval(() => { if (kr().game?.inMatch) card.remove(); if (!card.isConnected) clearInterval(gone); }, 1000);
  yes.addEventListener("click", () => { card.remove(); void sheet.open("crash"); });
}

/** wire the sheet into the match menu, the results screen and the title */
export function installReport(): void {
  installStyles();
  const sheet = createSheet();
  const hook = () => { const kb = kr().kongbot; if (kb) kb.open = () => { void sheet.open("report"); }; return !!kb; };
  let results: HTMLButtonElement | null = null, crashPending = true;
  void deadChecked.done.then(() => { if (!(snapshot() as { prev: unknown }).prev) crashPending = false; });
  const tries = setInterval(() => {
    if (!results) {
      const row = document.querySelector<HTMLElement>(".kr-results .btns");
      if (row) {
        results = el("button", "kr-btn", "SEND DIAGNOSTICS");
        results.type = "button";
        results.addEventListener("click", () => void quickSend(sheet, results!));
        row.appendChild(results);
        new MutationObserver(() => { if (results && !row.closest(".kr-hide")) { results.disabled = false; results.textContent = "SEND DIAGNOSTICS"; } }).observe(row.closest(".kr-results")!, { attributes: true, attributeFilter: ["class"] });
      }
    }
    const prev = (snapshot() as { prev: { phase?: number } | null }).prev;
    if (crashPending && prev && kr().ready && !kr().game?.inMatch) { crashPending = false; crashCard(sheet, prev); }
    if (hook() && results && !crashPending) clearInterval(tries);
  }, 2000);
}
