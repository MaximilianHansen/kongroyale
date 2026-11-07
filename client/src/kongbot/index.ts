// KONGBOT — in-game bug reports for playtests. `/` (anywhere) or Enter (in a match) opens a chat bar; `/kongbot <what
// went wrong>` sends a report to the game server (POST /api/kongbot → MongoDB, server/kongbot.ts) with a screenshot and
// the full context (context.ts), the console since boot and the player's last 30 s of movement. The snapshot is taken
// when the bar OPENS — the moment the player reacted — and sent with the message. Triage: `npm run kongbot`
// (tools/kongbot/cli.mts).
import type { Engine } from "../engine/engine";
import { UI } from "../ui/styles";
import { logSnapshot } from "./capture";
import { gatherContext, grabScreenshot, kr, type KongbotContext } from "./context";
import { receiptText, type ReportReceipt } from "./receipt";

const COMMANDS = ["/kongbot", "/kb", "/bug", "/report"];
const TRAIL_HZ = 4, TRAIL_S = 30;
// (crypto.randomUUID only exists in secure contexts; playtesters may be on plain http://<ip>:port)
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
const clientId = (() => {
  try { let v = localStorage.getItem("kr-kongbot-id"); if (!v) { v = rid(); localStorage.setItem("kr-kongbot-id", v); } return v; }
  catch { return "anon"; }
})();
const sessionId = rid();

/** [t (s, page clock), x, y, z, yaw (deg), state, hp + shield, move keys held (0/1)] every 250 ms while a match runs.
 *  Keys held while the position does not change = stuck. */
const trail: number[][] = [];
const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
function sampleTrail() {
  const g = kr().game, p = g?.cm?.pred;
  if (!g?.inMatch || !p) return;
  const input = g.input as unknown as { down?: Set<string>; movementHeld?: () => boolean };
  const wish = input.movementHeld ? +input.movementHeld() : input.down ? +(MOVE_KEYS.some((k) => input.down!.has(k))) : -1;
  trail.push([+(performance.now() / 1000).toFixed(2), +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), Math.round((g.input.yaw * 180) / Math.PI), p.st, p.hp + p.shield, wish]);
  if (trail.length > TRAIL_HZ * TRAIL_S) trail.splice(0, trail.length - TRAIL_HZ * TRAIL_S);
}

const CSS = `
.kb-bar { position: fixed; left: 24px; bottom: 26vh; width: min(620px, calc(100vw - 48px)); z-index: 100000; pointer-events: auto;
  font-family: ${UI.sans}; color: ${UI.creamText}; background: rgba(10,30,46,0.92); border: 2px solid ${UI.yellow}; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.45); padding: 10px 12px 12px; }
.kb-bar[hidden] { display: none; }
.kb-title { font: 800 14px 'Barlow Condensed', ${UI.sans}; letter-spacing: .14em; color: ${UI.yellow}; margin: 0 0 6px; display: flex; justify-content: space-between; gap: 12px; }
.kb-title span:last-child { color: rgba(246,239,198,0.55); letter-spacing: .06em; font-weight: 700; }
.kb-in { width: 100%; box-sizing: border-box; font: 600 18px ${UI.sans}; color: #fff; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,212,0,0.35);
  border-radius: 6px; padding: 9px 10px; outline: none; }
.kb-in:focus { border-color: ${UI.yellow}; }
.kb-in:disabled { opacity: .6; }
.kb-status { font: 700 13px ${UI.sans}; margin-top: 6px; min-height: 16px; color: rgba(246,239,198,0.75); }
.kb-status.err { color: #ff8a7a; }
.kb-toast { position: fixed; left: 50%; top: 14vh; transform: translateX(-50%); z-index: 100001; pointer-events: none;
  font: 800 20px 'Barlow Condensed', ${UI.sans}; letter-spacing: .08em; color: #10202e; background: ${UI.yellow}; border-radius: 8px;
  padding: 10px 18px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); transition: opacity .35s; max-width: calc(100vw - 32px); box-sizing: border-box; text-align: center; }
`;

export function installKongbot(engine: Engine) {
  setInterval(sampleTrail, 1000 / TRAIL_HZ);
  const style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);
  const bar = document.createElement("div"); bar.className = "kb-bar"; bar.hidden = true;
  bar.innerHTML = `<div class="kb-title"><span>🦍 KONGBOT · BUG REPORT</span><span>ENTER SEND · ESC CANCEL</span></div>
    <input class="kb-in" maxlength="2000" spellcheck="true" autocomplete="off" placeholder="/kongbot what went wrong?">
    <div class="kb-status">A screenshot, your position and the game logs are attached.</div>`;
  document.body.appendChild(bar);
  const input = bar.querySelector("input")!, status = bar.querySelector(".kb-status") as HTMLDivElement;

  let snap: Promise<{ ctx: KongbotContext | null; shot: Awaited<ReturnType<typeof grabScreenshot>> }> | null = null;
  let sending = false, openedAt = 0;

  const setStatus = (t: string, err = false) => { status.textContent = t; status.classList.toggle("err", err); };
  function open() {
    if (!bar.hidden) return;
    // the game must not keep walking on a key that was held when the bar opened
    const gi = kr().game?.input as unknown as { clearHeld?: () => void } | undefined;
    gi?.clearHeld?.();
    // snapshot NOW (what the player is reacting to); the picture comes with the next drawn frame
    openedAt = performance.now() / 1000;
    snap = (async () => {
      let ctx: KongbotContext | null = null;
      try { ctx = gatherContext(engine); } catch (e) { console.warn("[kongbot] context", e); }
      const shot = await grabScreenshot(engine).catch(() => null);
      if (ctx && shot?.frame) (ctx.perf as Record<string, unknown>).frame = shot.frame;
      return { ctx, shot };
    })();
    bar.hidden = false; input.disabled = false; input.value = "/kongbot "; setStatus("A screenshot, your position and the game logs are attached.");
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
  function close() { bar.hidden = true; input.blur(); snap = null; }

  async function submit() {
    if (sending) return;
    const raw = input.value.trim();
    const cmd = raw.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!COMMANDS.includes(cmd)) { setStatus("Chat is reports-only for now: type /kongbot <what went wrong>", true); return; }
    const message = raw.slice(cmd.length).trim();
    if (message.length < 3) { setStatus("Tell KONGBOT what went wrong: /kongbot <description>", true); return; }
    sending = true; input.disabled = true; setStatus("Sending…");
    try {
      const { ctx, shot } = snap ? await snap : { ctx: null, shot: null };
      const body = {
        v: 1, message, reporter: { name: kr().game?.lobby?.name ?? null, clientId, sessionId },
        ctx, logs: logSnapshot(), trail: trail.filter((t) => t[0] <= openedAt), shot: shot?.dataUrl ?? null, shotSize: shot ? [shot.w, shot.h] : null,
        sentAt: new Date().toISOString(), bundle: (kr() as { playtestBundle?: () => unknown }).playtestBundle?.(),
      };
      // (a server that never answers: give up after 15 s and say so — Enter retries)
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error("no answer from the server")), 15_000);
      let res: Response, j: ReportReceipt;
      try { res = await fetch(`${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}api/kongbot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal }); j = await res.json().catch(() => ({})) as ReportReceipt; }
      finally { clearTimeout(timer); }
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      close();
      // SENT (in the database) vs SAVED ON THE GAME SERVER (the database was down: queued, delivered later)
      toast(receiptText(j));
      console.info(`[kongbot] report sent ${j.id ?? ""}`);
    } catch (e) {
      input.disabled = false; input.focus();
      setStatus(`Couldn't send (${e instanceof Error ? e.message : String(e)}). Enter to retry.`, true);
    } finally { sending = false; }
  }

  function toast(text: string) {
    const t = document.createElement("div"); t.className = "kb-toast"; t.textContent = text;
    t.setAttribute("role", "status");
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; }, 6000);
    setTimeout(() => t.remove(), 6500);
  }

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); void submit(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  // capture phase: before the game's own key handling
  addEventListener("keydown", (e) => {
    if (!bar.hidden || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const inMatch = !!kr().game?.inMatch;
    // Enter on a focused menu button (the match menu, results) presses that button, not KONGBOT
    if (e.code === "Slash" || e.key === "/" || (e.key === "Enter" && inMatch && t?.tagName !== "BUTTON")) { e.preventDefault(); e.stopImmediatePropagation(); open(); }
  }, true);

  (kr() as Record<string, unknown>).kongbot = { open, close, mark: (m: string) => { if (!bar.hidden || sending) return false; open(); input.value = "/kongbot " + m; void submit(); return true; }, context: () => gatherContext(engine), screenshot: () => grabScreenshot(engine) };
}
