// SETTINGS (Toon) · the shell: the compact KONG wordmark and BACK · ESC, the "Settings" title, the five category pills
// (Q / E), the local section tabs (TAB), the rows as outlined tiles, the contextual help panel and the footer (R Restore
// defaults · ↑↓ Select · ←→ Adjust · Saved on this device). One layer owns input while it is open:
//   keyboard   ↑↓ rows · ←→ adjust (Shift = coarse) · Enter / Space change · Tab / Shift+Tab sections · Q / E categories
//              · R restore defaults · Esc back one layer (a capture, the confirm dialog, then Settings itself)
//   controller d-pad / left stick rows and adjust · A change · B back · LB / RB sections · LT / RT categories · Y restore
//              (padnav.ts hands this layer the pad through PadOwner)
//   pointer    hover selects a row (the help follows), click / drag the controls
// Values apply instantly and are saved on this device (the row model: ui/settings-model.ts, settings/panel.ts,
// settings/controller-panel.ts). No gameplay input passes while it is open (the window keydown listener below runs in
// the capture phase and stops every key; game/index.ts gates the rest on `.kr-video.on`).
import type { Engine } from "../engine/engine";
import type { Display } from "../engine/display";
import { preferences } from "../settings/preferences";
import { device } from "../settings/device";
import { backText, glyphFamily, onLabelsChange } from "../settings/labels";
import { PB, glyph, type PadAction } from "../settings/pad";
import type { BindAction } from "../settings/bindings";
import { accessibilityCategory, audioCategory, controlsCategory, kbmBind, kbmClear, kbmSlot } from "../settings/panel";
import { cancelPadCapture, clearPadCapture, controllerCategory, curveSvg, padCapturing, padDiagram, padLegend, padLive, padSlot, padStatus, startPadCapture } from "../settings/controller-panel";
import { videoCategory, type BindRow, type Category, type ChoiceRow, type Row, type SliderRow } from "./settings-model";
import { bindViz, esc, fitHudPreview, fovViz, gfxViz, hudPreview, hwRows, mouseViz, soundViz, speakerViz } from "./settings-viz";
import { TOON_LOGO } from "./toon";
import type { PadOwner } from "./padnav";

export interface SettingsShell {
  readonly root: HTMLElement; readonly isOpen: boolean;
  open(): void; close(): void;
  /** jump to a category (and section): tools and the pause card */
  show(cat: string, sec?: number): void;
}
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>`;
const ALERT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5" stroke-linecap="round"/></svg>`;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const kbd = (t: string, cls = "") => `<kbd class="tn-key${cls ? " " + cls : ""}">${esc(t)}</kbd>`;

export function createSettingsShell(engine: Engine, display: Display): SettingsShell {
  const CATS: Category[] = [controlsCategory(), controllerCategory(), audioCategory(), videoCategory(engine, display), accessibilityCategory()];
  const root = document.createElement("div");
  root.className = "kr-video tn-set kr-tu";
  root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-label", "Settings");
  root.innerHTML = `<div class="tn-set-scrim"></div>
    <div class="tn-set-in">
      <div class="tn-set-top"><img class="tn-logo tn-set-logo" src="${TOON_LOGO.wordmark}" alt="Kong Royale"><button type="button" class="close tn-set-back" data-a="close" tabindex="-1"></button></div>
      <h1 class="tn-title tn-set-title">Settings</h1>
      <nav class="tn-set-cats" role="tablist" aria-label="Settings categories"></nav>
      <div class="tn-set-sub" role="tablist" aria-label="Sections"></div>
      <div class="tn-set-body"><div class="tn-set-table" role="list"></div><aside class="tn-set-help" id="tn-set-help"></aside></div>
      <footer class="tn-set-foot">
        <button type="button" class="tn-set-hint tn-set-restore" data-a="restore" tabindex="-1"></button>
        <div class="tn-set-hints"></div>
        <div class="tn-set-status" role="status" aria-atomic="true"></div>
      </footer>
    </div>`;
  document.body.appendChild(root);
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const backBtn = $<HTMLButtonElement>(".tn-set-back"), catsEl = $(".tn-set-cats"), subEl = $(".tn-set-sub"), body = $(".tn-set-body");
  const table = $(".tn-set-table"), help = $(".tn-set-help"), restoreBtn = $(".tn-set-restore"), hintsEl = $(".tn-set-hints"), statusEl = $(".tn-set-status");
  const msgEl = document.createElement("div"); msgEl.className = "tn-set-msg"; msgEl.setAttribute("role", "status");

  // ---------------------------------------------------------------- state
  let cat = 0, sec = 0, row = 0, slot = 0;
  let rows: Row[] = [], rowEls: HTMLElement[] = [];
  /** a binding listening for input (kbm: key / mouse / wheel; pad: a controller button, controller-panel.ts) */
  let capture: { r: BindRow; index: number } | null = null;
  /** the refusal shown on a row (a conflict, a key that cannot be cleared) */
  let rowError: { id: string; text: string } | null = null;
  let dialog: { el: HTMLElement; focus: number; ok: () => void; trigger: "key" | "pointer" } | null = null;
  let drag: { r: SliderRow; i: number; el: HTMLElement; v: number; pid: number } | null = null;
  /** what the footer hints show now (paintHints) */
  let hintsSig = "";
  let hwOpen = false, swallowClick = false, prevFocus: HTMLElement | null = null, loop = 0, hwTimer = 0, savedTimer = 0, toastTimer = 0;
  /** the last input: a keyboard-opened Settings shows the focus ring at once */
  let lastKey = false;
  addEventListener("keydown", () => { lastKey = true; }, true);
  addEventListener("pointerdown", () => { lastKey = false; }, true);
  const narrow = matchMedia("(max-aspect-ratio: 13/10)");
  const C = () => CATS[cat], SEC = () => C().sections[clamp(sec, 0, C().sections.length - 1)];
  const isOpen = () => root.classList.contains("on");
  /** one design px in CSS px (the logo is 160 design px wide) */
  const logo = root.querySelector<HTMLElement>(".tn-set-logo")!;
  const tu = () => (logo.getBoundingClientRect().width || 160) / 160;

  // ---------------------------------------------------------------- chrome (pills, sections, keycaps)
  function renderChrome() {
    const pad = device.pad, f = glyphFamily();
    backBtn.innerHTML = `Back · <b>${esc(backText())}</b>`;
    catsEl.innerHTML = CATS.map((c, i) => `<button type="button" class="tn-pill${i === cat ? " is-on" : ""}" role="tab" aria-selected="${i === cat}" data-a="cat" data-i="${i}" tabindex="-1">${esc(c.name)}</button>`).join("")
      + `<span class="tn-set-qe" aria-hidden="true">${kbd(pad ? glyph(PB.LT, f) : "Q")}${kbd(pad ? glyph(PB.RT, f) : "E")}</span>`;
    const secs = C().sections;
    subEl.innerHTML = secs.map((s, i) => `<button type="button" class="tn-subtab${i === sec ? " is-on" : ""}" role="tab" aria-selected="${i === sec}" data-a="sec" data-i="${i}" tabindex="-1">${esc(s.name)}</button>`).join("")
      + (secs.length > 1 ? (pad ? `<span aria-hidden="true" style="display:flex;gap:${"calc(8 * var(--tu))"}">${kbd(glyph(PB.LB, f))}${kbd(glyph(PB.RB, f))}</span>` : kbd("Tab")) : "");
    restoreBtn.innerHTML = `${kbd(pad ? glyph(PB.Y, f) : "R")} Restore defaults`;
    hintsSig = ""; paintHints();
    paintStatus();
  }
  /** the footer hints; while a key slot listens: a clickable CLEAR
   *  (= Backspace / Delete) and Esc cancel */
  function paintHints() {
    const clear = !!capture && capture.r.device === "kbm";
    if (hintsSig === String(clear)) return;
    hintsSig = String(clear);
    hintsEl.innerHTML = clear
      ? `<button type="button" class="tn-set-hint tn-set-clear" data-a="clear" tabindex="-1">${kbd("Backspace")} Clear</button><span class="tn-set-hint">${kbd("Esc")} Cancel</span>`
      : `<span class="tn-set-hint">${kbd("↑↓")} Select</span><span class="tn-set-hint">${kbd("←→")} Adjust</span>`;
  }
  function paintStatus(flash = false) {
    const ok = preferences.persisted;
    statusEl.classList.toggle("is-error", !ok);
    statusEl.innerHTML = ok ? `${CHECK}Saved on this device` : `${ALERT}This session only: storage unavailable`;
    if (flash) { statusEl.classList.add("is-flash"); clearTimeout(savedTimer); savedTimer = window.setTimeout(() => statusEl.classList.remove("is-flash"), 700); }
  }
  const saved = () => paintStatus(true);

  // ---------------------------------------------------------------- rows
  function buildControl(r: Row): string {
    switch (r.kind) {
      case "slider": return `<div class="tn-set-sl"><div class="tn-slider" role="slider" aria-label="${esc(r.label)}" aria-valuemin="${r.min}" aria-valuemax="${r.max}"><div class="track"></div><div class="fill"></div><div class="thumb"></div></div><div class="tn-set-val"></div></div>`;
      case "switch": return `<button type="button" class="tn-switch" role="switch" data-a="sw" tabindex="-1" aria-label="${esc(r.label)}"><span class="t"></span><span class="sw"></span></button>`;
      case "seg": return `<div class="tn-seg" role="radiogroup" aria-label="${esc(r.label)}"></div>`;
      case "cycle": return `<div class="tn-cycle"><button type="button" data-a="cyc" data-d="-1" tabindex="-1" aria-label="Previous">‹</button><div class="v" aria-live="polite"></div><button type="button" data-a="cyc" data-d="1" tabindex="-1" aria-label="Next">›</button></div>`;
      case "bind": return `<div class="tn-set-bind">${Array.from({ length: r.count }, (_, k) => `<button type="button" class="tn-set-slot" data-a="slot" data-s="${k}" tabindex="-1"></button>`).join("")}</div>`;
      case "action": return `<button type="button" class="tn-btn tn-set-act" data-a="act" tabindex="-1">${esc(r.text)}</button>`;
    }
  }
  function slotView(r: BindRow, k: number) {
    const index = r.first + k;
    if (r.device === "kbm") { const s = kbmSlot(r.action as BindAction, index); return { ...s, html: "" }; }
    const s = padSlot(r.action as PadAction, index);
    return { ...s, html: s.html };
  }
  function paintRow(i: number) {
    const r = rows[i], el = rowEls[i]; if (!r || !el) return;
    const dis = r.disabled?.() ?? null, err = rowError?.id === r.id ? rowError.text : null;
    el.classList.toggle("is-sel", i === row);
    el.classList.toggle("is-off", !!dis);
    el.classList.toggle("is-error", !!err);
    const small = el.querySelector<HTMLElement>(".lbl small")!, sub = dis ?? "";
    if (small.textContent !== sub) small.textContent = sub;
    small.hidden = !sub;
    const errEl = el.querySelector<HTMLElement>(".tn-set-err")!;
    if (errEl.textContent !== (err ?? "")) errEl.textContent = err ?? "";
    errEl.hidden = !err;
    const ctl = el.querySelector<HTMLElement>(".ctl")!;
    if (r.kind === "slider") {
      const v = drag?.i === i ? drag.v : r.get(), p = clamp((v - r.min) / (r.max - r.min), 0, 1) * 100;
      ctl.querySelector<HTMLElement>(".fill")!.style.width = `${p}%`;
      ctl.querySelector<HTMLElement>(".thumb")!.style.left = `${p}%`;
      const t = r.fmt(v), val = ctl.querySelector<HTMLElement>(".tn-set-val")!;
      if (val.textContent !== t) val.textContent = t;
      const sl = ctl.querySelector<HTMLElement>(".tn-slider")!; sl.setAttribute("aria-valuenow", String(v)); sl.setAttribute("aria-valuetext", t);
    } else if (r.kind === "switch") {
      const on = r.get(), b = ctl.querySelector<HTMLElement>(".tn-switch")!;
      b.setAttribute("aria-checked", String(on)); b.setAttribute("aria-disabled", String(!!dis));
      b.querySelector(".t")!.textContent = on ? "On" : "Off";
    } else if (r.kind === "seg") {
      const opts = r.options(), cur = r.get(), seg = ctl.querySelector<HTMLElement>(".tn-seg")!, sig = opts.map((o) => o.label).join("|");
      if (seg.dataset.sig !== sig) { seg.dataset.sig = sig; seg.innerHTML = opts.map((o, k) => `<button type="button" role="radio" data-a="seg" data-v="${k}" tabindex="-1">${esc(o.label)}</button>`).join(""); }
      seg.querySelectorAll<HTMLElement>("button").forEach((b, k) => { const on = opts[k].v === cur; b.classList.toggle("is-on", on); b.setAttribute("aria-checked", String(on)); });
    } else if (r.kind === "cycle") {
      const cur = r.get(), o = r.options().find((x) => x.v === cur), t = r.state?.() ?? o?.label ?? String(cur);
      const v = ctl.querySelector<HTMLElement>(".v")!; if (v.textContent !== t) v.textContent = t;
    } else if (r.kind === "bind") {
      ctl.querySelectorAll<HTMLElement>(".tn-set-slot").forEach((b, k) => {
        const s = slotView(r, k);
        const listening = !!capture && capture.r.id === r.id && k === slotOf(capture);
        b.classList.toggle("is-capture", listening);
        b.classList.toggle("is-empty", !listening && !s.bound && !s.unbound);
        b.classList.toggle("is-unbound", !listening && s.unbound);
        b.classList.toggle("is-target", i === row && k === slot);
        const html = listening ? "Press a key or button" : s.html ? `${s.html}` : esc(s.text);
        if (b.innerHTML !== html) b.innerHTML = html;
        b.setAttribute("aria-label", `${r.label} ${r.count > 1 ? (k ? "alternate" : "primary") : ""}: ${listening ? "listening" : s.bound ? s.text : "unbound"}`);
      });
    }
  }
  /** which visible slot a capture fills */
  const slotOf = (c: NonNullable<typeof capture>) => c.index - c.r.first;
  function paintAll() { for (let i = 0; i < rows.length; i++) paintRow(i); paintHints(); }

  function renderSection(animate = false) {
    rows = SEC().rows();
    row = clamp(row, 0, Math.max(0, rows.length - 1));
    rowEls = rows.map((r, i) => {
      const el = document.createElement("div");
      el.className = "tn-set-row tn-tile"; el.dataset.i = String(i); el.tabIndex = -1; el.setAttribute("role", "listitem"); el.setAttribute("aria-label", r.label);
      el.innerHTML = `<div class="lbl tn-label">${esc(r.label)}<small hidden></small></div><div class="ctl">${buildControl(r)}</div><div class="tn-set-err" role="alert" hidden></div>`;
      return el;
    });
    msgEl.textContent = ""; msgEl.classList.remove("is-error");
    table.replaceChildren(...rowEls, msgEl);
    if (animate) { table.scrollTop = 0; swap(table); swap(help); }
    paintAll(); renderHelp(); placeHelp();
  }
  const swap = (el: HTMLElement) => { el.classList.remove("tn-set-swap"); void el.offsetWidth; el.classList.add("tn-set-swap"); };

  // ---------------------------------------------------------------- help panel
  let helpSig = "";
  function renderHelp() {
    const r = rows[row]; if (!r) { help.replaceChildren(); return; }
    const h = r.help(), title = h.title ?? r.label, viz = h.viz;
    const listening = !!capture && capture.r.id === r.id;
    let vizHtml = "";
    if (viz === "mouse") vizHtml = mouseViz();
    else if (viz === "speaker") vizHtml = speakerViz();
    else if (viz === "sound") vizHtml = soundViz();
    else if (viz === "fov") vizHtml = fovViz(display);
    else if (viz === "gfx") vizHtml = gfxViz(display);
    else if (viz === "curve") vizHtml = `${curveSvg()}<div class="tn-set-cap tn-eyebrow">Stick input → turn speed · dashed = linear</div>`;
    else if (viz === "sticks") vizHtml = `<canvas class="tn-set-sticks" data-sticks width="720" height="290"></canvas>${padLine()}`;
    else if (viz === "pad") vizHtml = `${padDiagram(h.pad)}${h.legend ? `<div class="tn-set-legend">${padLegend(h.pad)}</div>` : ""}${padLine(!h.legend)}<div class="tn-set-padlast" data-pad-last></div>`;
    else if (viz === "bind" && r.kind === "bind") vizHtml = bindViz(Array.from({ length: r.count }, (_, k) => slotView(r, k)), listening);
    const sig = `${r.id}|${title}|${h.eb}|${h.body.join("|")}|${vizHtml}|${viz === "hud" ? `${preferences.value.hudScale}:${preferences.value.uiScale}` : ""}`;
    if (sig === helpSig) return;
    helpSig = sig;
    help.innerHTML = `<div class="tn-eyebrow">${esc(h.eb)}</div><h3 class="tn-heading">${esc(title)}</h3>${h.body.map((p) => `<p>${esc(p)}</p>`).join("")}`
      + (vizHtml ? `<div class="tn-set-viz">${vizHtml}</div>` : "")
      + (viz === "hw" ? `<details class="tn-set-disc"${hwOpen ? " open" : ""}><summary class="tn-eyebrow"><span class="tri" aria-hidden="true">▶</span>Hardware details ${kbd(device.pad ? glyph(PB.X, glyphFamily()) : "I")}</summary><dl class="tn-set-hw">${hwRows(engine, display)}</dl></details>` : "");
    if (viz === "hud") { const box = hudPreview(); const v = document.createElement("div"); v.className = "tn-set-viz"; v.append(box); help.append(v); fitHudPreview(box, tu()); }
    help.querySelector("details")?.addEventListener("toggle", (e) => { hwOpen = (e.target as HTMLDetailsElement).open; });
  }
  /** the connection line; `hint` adds how to connect one (left out under the Layout legend, where space is short) */
  function padLine(hint = true) {
    const s = padStatus();
    return `<div class="tn-set-padline tn-eyebrow"><i class="dot${s.on ? " on" : ""}"></i>${esc(s.text)}</div>${s.sub && hint ? `<div class="tn-support">${esc(s.sub)}</div>` : ""}`;
  }
  /** narrow windows and enlarged menu text: the help panel opens under the active row instead of beside the table */
  function placeHelp() {
    const stack = narrow.matches || preferences.value.uiScale >= 1.25;
    root.classList.toggle("is-stack", stack);
    if (stack) { const el = rowEls[row]; if (el && el.nextSibling !== help) el.after(help); }
    else if (help.parentElement !== body) body.append(help);
  }
  narrow.addEventListener("change", () => { if (isOpen()) placeHelp(); });

  // ---------------------------------------------------------------- selection
  function select(i: number, how: { focus?: boolean; scroll?: boolean } = {}) {
    if (!rows.length) return;
    i = clamp(i, 0, rows.length - 1);
    if (i !== row) {
      const prev = row; row = i;
      if (rows[prev]?.kind === "bind" || rows[i].kind === "bind") slot = 0;
      paintRow(prev); paintRow(i); renderHelp(); placeHelp();
    }
    rowEls.forEach((el, k) => { if (k === row) el.setAttribute("aria-describedby", "tn-set-help"); else el.removeAttribute("aria-describedby"); });
    if (how.focus) rowEls[i]?.focus({ preventScroll: true });
    if (how.scroll) scrollToRow(i);
  }
  function scrollToRow(i: number) {
    const el = rowEls[i]; if (!el) return;
    const pad = 12 * tu();
    const top = el.offsetTop - table.offsetTop, bottom = top + el.offsetHeight + (help.parentElement === table ? help.offsetHeight : 0);
    if (top - pad < table.scrollTop) table.scrollTop = Math.max(0, top - pad);
    else if (bottom + pad > table.scrollTop + table.clientHeight) table.scrollTop = bottom + pad - table.clientHeight;
  }
  function setCat(i: number) {
    endCapture(); rowError = null;
    cat = (i + CATS.length) % CATS.length; sec = 0; row = 0; slot = 0;
    renderChrome(); renderSection(true); select(0, { focus: true });
  }
  function setSec(i: number) {
    const n = C().sections.length; if (n < 2 && i !== 0) return;
    endCapture(); rowError = null;
    sec = (i + n) % n; row = 0; slot = 0;
    renderChrome(); renderSection(true); select(0, { focus: true });
  }

  // ---------------------------------------------------------------- changing values
  function afterChange() { paintAll(); renderHelp(); saved(); }
  function adjust(r: Row, dir: number, coarse = false) {
    if (r.disabled?.()) return;
    if (r.kind === "slider") {
      const v = +clamp(Math.round((r.get() + dir * r.step * (coarse ? 5 : 1)) / r.step) * r.step, r.min, r.max).toFixed(4);
      if (v !== r.get()) { r.set(v); afterChange(); }
    } else if (r.kind === "switch") { if (r.get() !== dir > 0) { r.set(dir > 0); afterChange(); } }
    else if (r.kind === "seg" || r.kind === "cycle") step(r, dir, r.kind === "cycle");
    else if (r.kind === "bind") { const s = clamp(slot + dir, 0, r.count - 1); if (s !== slot) { slot = s; paintRow(row); } }
  }
  function step(r: ChoiceRow, dir: number, wrap: boolean) {
    const opts = r.options(), n = opts.length; let j = opts.findIndex((o) => o.v === r.get());
    if (j < 0) j = dir > 0 ? -1 : n;                         // a state (Custom): step onto the first / last real choice
    j = wrap ? (j + dir + n) % n : clamp(j + dir, 0, n - 1);
    if (opts[j] && opts[j].v !== r.get()) { r.set(opts[j].v); afterChange(); }
  }
  function activate(r: Row) {
    if (r.disabled?.()) return;
    if (r.kind === "switch") { r.set(!r.get()); afterChange(); }
    else if (r.kind === "seg") step(r, 1, true);
    else if (r.kind === "cycle") step(r, 1, true);
    else if (r.kind === "bind") startCapture(r, slot);
    else if (r.kind === "action") { const m = r.run(); setMsg(m || ""); }
  }
  function setMsg(text: string, error = false) { msgEl.textContent = text; msgEl.classList.toggle("is-error", error); }

  // ---------------------------------------------------------------- binding capture
  function startCapture(r: BindRow, k: number) {
    endCapture(false);
    rowError = null;
    if (r.device === "kbm") {
      const s = kbmSlot(r.action as BindAction, r.first + k);
      capture = { r, index: r.count === 1 ? r.first : s.target };
      setMsg("Listening for a key, mouse button or wheel · Esc cancels · Backspace clears");
    } else {
      capture = { r, index: k };
      const warn = startPadCapture(r.action as PadAction, k, (res) => {
        capture = null;
        if (res.error) { rowError = { id: r.id, text: res.error }; setMsg(res.error, true); }
        else setMsg(res.message ?? "");
        afterChange();
      });
      setMsg(warn ?? `Listening for a controller button · ${glyph(PB.MENU, glyphFamily())} or Esc cancels`, !!warn);
    }
    slot = clamp(k, 0, r.count - 1);
    paintAll(); renderHelp();
  }
  /** stop listening (Esc, another row / section / category, closing); `quiet` keeps the message */
  function endCapture(clearMsg = true) {
    if (!capture) return;
    if (capture.r.device === "pad") cancelPadCapture();
    capture = null;
    if (clearMsg) setMsg("");
    paintAll(); renderHelp();
  }
  function kbmCaptureCode(code: string) {
    if (!capture || capture.r.device !== "kbm") return;
    const { r, index } = capture, res = kbmBind(r.action as BindAction, index, code);
    if (res.error) { rowError = { id: r.id, text: res.error }; setMsg(res.error, true); paintRow(row); return; }
    capture = null; rowError = null; setMsg(res.message ?? ""); afterChange();
  }
  function captureClear() {
    if (!capture) return;
    if (capture.r.device === "pad") { clearPadCapture(); return; }
    const { r, index } = capture, res = kbmClear(r.action as BindAction, index);
    if (res.error) { rowError = { id: r.id, text: res.error }; setMsg(res.error, true); paintRow(row); return; }
    capture = null; rowError = null; setMsg(res.message ?? ""); afterChange();
  }

  // ---------------------------------------------------------------- restore defaults (confirm dialog)
  function openReset(trigger: "key" | "pointer") {
    endCapture();
    const c = C();
    const el = document.createElement("div"); el.className = "tn-set-dlg";
    el.innerHTML = `<div class="tn-dialog" role="alertdialog" aria-modal="true" aria-labelledby="tn-set-dlg-h" aria-describedby="tn-set-dlg-p">
      <h2 id="tn-set-dlg-h">Restore ${esc(c.name)} defaults?</h2><p id="tn-set-dlg-p" class="tn-body">${esc(c.reset.body)}</p>
      <div class="acts"><button type="button" class="tn-btn" data-dlg="cancel">Cancel</button><button type="button" class="tn-btn tn-btn--primary" data-dlg="ok">Restore defaults</button></div></div>`;
    root.append(el);
    dialog = { el, focus: 0, trigger, ok: () => {
      c.reset.run(); rowError = null; closeDialog();
      renderChrome(); renderSection(); select(row, { focus: true });
      saved(); toast(`${CHECK}${esc(c.name)} defaults restored`);
    } };
    focusDialog(0);
  }
  function focusDialog(i: number) {
    if (!dialog) return;
    const btns = [...dialog.el.querySelectorAll<HTMLButtonElement>("[data-dlg]")];
    dialog.focus = (i + btns.length) % btns.length;
    btns.forEach((b, k) => b.classList.toggle("is-focus", k === dialog!.focus));
    btns[dialog.focus].focus({ preventScroll: true });
  }
  function closeDialog() {
    if (!dialog) return;
    dialog.el.remove(); dialog = null;
    restoreBtn.blur(); rowEls[row]?.focus({ preventScroll: true });
  }
  function dialogAct(which: "ok" | "cancel") { if (!dialog) return; if (which === "ok") dialog.ok(); else closeDialog(); }
  function toast(html: string) {
    root.querySelector(".tn-set-toast")?.remove();
    const t = document.createElement("div"); t.className = "tn-toast tn-set-toast is-in"; t.setAttribute("role", "status"); t.innerHTML = html;
    root.append(t); clearTimeout(toastTimer); toastTimer = window.setTimeout(() => t.remove(), 2600);
  }

  // ---------------------------------------------------------------- Esc: back one layer
  function back() {
    if (capture) { rowError = null; endCapture(); setMsg("Binding cancelled."); return; }
    if (dialog) { closeDialog(); return; }
    close();
  }

  // ---------------------------------------------------------------- pointer
  root.addEventListener("click", (ev) => {
    if (swallowClick) { swallowClick = false; ev.stopImmediatePropagation(); ev.preventDefault(); return; }
    const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-a], [data-dlg]"); if (!t) return;
    if (dialog) { if (t.dataset.dlg) dialogAct(t.dataset.dlg as "ok" | "cancel"); return; }
    const rowEl = t.closest<HTMLElement>(".tn-set-row"), i = rowEl ? Number(rowEl.dataset.i) : -1, r = rows[i];
    if (r && i !== row) select(i);
    switch (t.dataset.a) {
      case "close": close(); break;
      case "cat": setCat(Number(t.dataset.i)); break;
      case "sec": setSec(Number(t.dataset.i)); break;
      case "restore": openReset("pointer"); break;
      case "sw": if (r) activate(r); break;
      case "seg": if (r?.kind === "seg" && !r.disabled?.()) { const o = r.options()[Number(t.dataset.v)]; if (o && o.v !== r.get()) { r.set(o.v); afterChange(); } } break;
      case "cyc": if (r?.kind === "cycle") step(r, Number(t.dataset.d), true); break;
      case "slot": if (r?.kind === "bind") { const k = Number(t.dataset.s); if (capture?.r.id === r.id && slotOf(capture) === k) break; startCapture(r, k); } break;
      case "clear": captureClear(); break;
      case "act": if (r) activate(r); break;
    }
  });
  table.addEventListener("pointerover", (ev) => {
    if (capture || dialog || drag) return;
    const el = (ev.target as HTMLElement).closest<HTMLElement>(".tn-set-row"); if (!el) return;
    const i = Number(el.dataset.i); if (i !== row) select(i);
  });
  root.addEventListener("pointermove", () => root.classList.remove("is-kbd"), { passive: true });
  // sliders: press anywhere on the track, drag; heavy video values apply on release, the rest live
  table.addEventListener("pointerdown", (ev) => {
    if (capture || dialog || ev.button !== 0) return;
    const sl = (ev.target as HTMLElement).closest<HTMLElement>(".tn-slider"); if (!sl) return;
    const i = Number(sl.closest<HTMLElement>(".tn-set-row")!.dataset.i), r = rows[i];
    if (r?.kind !== "slider" || r.disabled?.()) return;
    ev.preventDefault(); select(i);
    drag = { r, i, el: sl, v: r.get(), pid: ev.pointerId };
    sl.setPointerCapture(ev.pointerId); sl.classList.add("is-drag");
    dragTo(ev.clientX);
  });
  function dragTo(x: number) {
    if (!drag) return;
    const b = drag.el.getBoundingClientRect(), r = drag.r;
    const v = +clamp(Math.round((r.min + clamp((x - b.left) / b.width, 0, 1) * (r.max - r.min)) / r.step) * r.step, r.min, r.max).toFixed(4);
    if (v === drag.v && v === r.get()) return;
    drag.v = v;
    if (!r.onRelease && v !== r.get()) { r.set(v); saved(); renderHelp(); }
    paintRow(drag.i);
  }
  table.addEventListener("pointermove", (ev) => { if (drag && ev.pointerId === drag.pid) dragTo(ev.clientX); });
  const endDrag = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.pid) return;
    const d = drag; drag = null; d.el.classList.remove("is-drag");
    if (d.v !== d.r.get()) { d.r.set(d.v); afterChange(); } else paintRow(d.i);
  };
  table.addEventListener("pointerup", endDrag); table.addEventListener("pointercancel", endDrag);

  // binding capture by mouse button / wheel (the press that binds must not also click what is under the cursor)
  root.addEventListener("mousedown", (ev) => {
    if (!capture || capture.r.device !== "kbm") return;
    // the footer's CLEAR is clicked, not captured
    if (ev.button === 0 && (ev.target as HTMLElement).closest?.('[data-a="clear"]')) return;
    ev.stopImmediatePropagation(); ev.preventDefault();
    swallowClick = ev.button === 0;
    addEventListener("mouseup", () => setTimeout(() => { swallowClick = false; }, 0), { once: true, capture: true });
    kbmCaptureCode(`Mouse${ev.button}`);
  }, true);
  root.addEventListener("auxclick", (ev) => { if (ev.button >= 3) ev.preventDefault(); }, true);
  // Chrome navigates on the side buttons' mouseup: binding Mouse 4 / 5 from the title (no match
  // running, so game/input.ts does not hold them) went BACK a page and left the game
  root.addEventListener("mouseup", (ev) => { if (ev.button >= 3) ev.preventDefault(); }, true);
  root.addEventListener("contextmenu", (ev) => ev.preventDefault());
  root.addEventListener("wheel", (ev) => {
    if (!capture || capture.r.device !== "kbm") return;
    ev.stopImmediatePropagation(); ev.preventDefault();
    if (Math.abs(ev.deltaY) >= 1) kbmCaptureCode(ev.deltaY > 0 ? "WheelDown" : "WheelUp");
  }, { capture: true, passive: false });

  // a lone Alt released on Windows focuses Chrome's menu unless the page takes the keyup: binding
  // Alt must not send the next keys to the browser
  addEventListener("keyup", (ev) => { if (isOpen() && (ev.code === "AltLeft" || ev.code === "AltRight")) ev.preventDefault(); }, true);
  // ---------------------------------------------------------------- keyboard (capture phase: nothing reaches the game)
  addEventListener("keydown", (ev) => {
    if (!isOpen() || document.querySelector("dialog[open]")) return;
    ev.stopImmediatePropagation();
    if (capture) {
      ev.preventDefault();
      if (ev.code === "Escape") back();
      else if (ev.code === "Backspace" || ev.code === "Delete") captureClear();
      else if (capture.r.device === "kbm") {
        if (ev.repeat) return;
        // Left / Right Ctrl, Alt and Shift bind on their own; Meta / Cmd and combos stay reserved
        const lone = /^(Control|Alt|Shift)(Left|Right)$/.test(ev.code);
        if (ev.metaKey || ((ev.ctrlKey || ev.altKey) && !lone)) { setMsg("Browser modifier shortcuts are reserved: press Ctrl, Alt or Shift on its own.", true); return; }
        kbmCaptureCode(ev.code);
      }
      return;
    }
    root.classList.add("is-kbd");
    const handled = () => ev.preventDefault();
    if (dialog) {
      if (ev.code === "Escape") { handled(); closeDialog(); }
      else if (ev.code === "ArrowLeft" || ev.code === "ArrowRight" || ev.code === "Tab") { handled(); focusDialog(dialog.focus + (ev.code === "ArrowLeft" || ev.shiftKey ? -1 : 1)); }
      else if (ev.code === "Enter" || ev.code === "Space" || ev.code === "NumpadEnter") { handled(); dialogAct(dialog.focus === 1 ? "ok" : "cancel"); }
      return;
    }
    const r = rows[row];
    switch (ev.code) {
      case "Escape": handled(); back(); break;
      case "ArrowDown": handled(); select(row + 1, { focus: true, scroll: true }); break;
      case "ArrowUp": handled(); select(row - 1, { focus: true, scroll: true }); break;
      case "Home": handled(); select(0, { focus: true, scroll: true }); break;
      case "End": handled(); select(rows.length - 1, { focus: true, scroll: true }); break;
      case "PageDown": handled(); select(row + 5, { focus: true, scroll: true }); break;
      case "PageUp": handled(); select(row - 5, { focus: true, scroll: true }); break;
      case "ArrowRight": case "ArrowLeft": handled(); if (r) adjust(r, ev.code === "ArrowRight" ? 1 : -1, ev.shiftKey); break;
      case "Enter": case "NumpadEnter": case "Space": handled(); if (!ev.repeat && r) activate(r); break;
      case "Tab": handled(); setSec(sec + (ev.shiftKey ? -1 : 1)); break;
      case "KeyQ": handled(); setCat(cat - 1); break;
      case "KeyE": handled(); setCat(cat + 1); break;
      case "KeyR": handled(); if (!ev.repeat) openReset("key"); break;
      case "KeyI": { const d = help.querySelector("details"); if (d) { handled(); d.open = !d.open; } break; }
    }
  }, true);

  // ---------------------------------------------------------------- controller (padnav hands the pad over)
  /** a held direction repeats (padnav auto-repeat): after 1.2 s of holding, sliders take coarse steps */
  let heldDir = "", heldSince = 0, lastMove = 0;
  const owner: PadOwner = {
    move(dir) {
      if (!isOpen()) return false;
      if (capture) return true;
      if (dialog) { if (dir === "left" || dir === "right") focusDialog(dialog.focus + (dir === "left" ? -1 : 1)); return true; }
      const now = performance.now();
      if (dir !== heldDir || now - lastMove > 450) { heldDir = dir; heldSince = now; }
      lastMove = now;
      const coarse = now - heldSince > 1200, r = rows[row];
      if (dir === "up" || dir === "down") select(row + (dir === "down" ? 1 : -1), { focus: true, scroll: true });
      else if (r) adjust(r, dir === "right" ? 1 : -1, coarse);
      return true;
    },
    button(b) {
      if (!isOpen()) return false;
      if (capture) {
        if (capture.r.device === "kbm" && (b === PB.B || b === PB.MENU)) back();
        return true;                                       // a controller capture reads the press itself
      }
      if (dialog) {
        if (b === PB.A) dialogAct(dialog.focus === 1 ? "ok" : "cancel");
        else if (b === PB.B || b === PB.MENU) closeDialog();
        return true;
      }
      const r = rows[row];
      if (b === PB.A) { if (r) activate(r); }
      else if (b === PB.B || b === PB.MENU) back();
      else if (b === PB.LB || b === PB.RB) setSec(sec + (b === PB.RB ? 1 : -1));
      else if (b === PB.LT || b === PB.RT) setCat(cat + (b === PB.RT ? 1 : -1));
      else if (b === PB.Y) openReset("key");
      else if (b === PB.X) { const d = help.querySelector("details"); if (d) d.open = !d.open; }
      return true;
    },
  };
  (root as HTMLElement & { krPad?: PadOwner }).krPad = owner;

  // ---------------------------------------------------------------- live updates
  let pending = 0;
  const repaint = () => { if (!isOpen() || pending) return; pending = requestAnimationFrame(() => { pending = 0; if (!drag) paintAll(); renderHelp(); placeHelp(); }); };
  preferences.subscribe((p) => { root.style.setProperty("--ts", String(p.uiScale)); repaint(); });
  display.onChange.push(repaint);
  onLabelsChange(() => { if (isOpen()) { renderChrome(); repaint(); } });
  const tick = () => {
    loop = requestAnimationFrame(tick);
    if (C().id === "pad" || padCapturing()) padLive(help);
  };

  // ---------------------------------------------------------------- open / close
  function open() {
    if (document.querySelector("dialog[open]")) return;
    prevFocus = document.activeElement as HTMLElement | null;
    // opened from a controller: start on CONTROLLER instead of mouse & keyboard
    if (device.pad && CATS[cat].id === "kbm") { cat = CATS.findIndex((c) => c.id === "pad"); sec = 0; row = 0; }
    root.classList.add("on"); document.documentElement.classList.add("kr-settings-open");
    root.classList.toggle("is-kbd", lastKey);
    helpSig = "";
    renderChrome(); renderSection(); select(row, { focus: true, scroll: true });
    cancelAnimationFrame(loop); loop = requestAnimationFrame(tick);
    clearInterval(hwTimer);
    hwTimer = window.setInterval(() => { const dl = help.querySelector<HTMLElement>(".tn-set-disc[open] .tn-set-hw"); if (dl) { const h = hwRows(engine, display); if (dl.innerHTML !== h) dl.innerHTML = h; } }, 500);
  }
  function close() {
    endCapture(); if (dialog) { dialog.el.remove(); dialog = null; }
    drag = null; rowError = null;
    root.classList.remove("on", "is-kbd"); document.documentElement.classList.remove("kr-settings-open");
    cancelAnimationFrame(loop); clearInterval(hwTimer);
    root.querySelector(".tn-set-toast")?.remove();
    if (root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    prevFocus?.focus?.({ preventScroll: true });
  }
  return {
    root,
    get isOpen() { return isOpen(); },
    open, close,
    show(id: string, s = 0) {
      const i = CATS.findIndex((c) => c.id === id); if (i < 0) return;
      if (!isOpen()) open();
      cat = i; endCapture(); rowError = null; sec = clamp(s, 0, CATS[i].sections.length - 1); row = 0; slot = 0;
      renderChrome(); renderSection(); select(0, { focus: true, scroll: true });
    },
  };
}
