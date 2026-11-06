// Title / lobby screen in the Toon design: the live
// title scene carries the right two-thirds behind a deep-navy fade on the left; the KONG ROYALE lockup top-left, the
// Play / Training / Settings pills, the callsign as identity top-right (inline edit with validation, plus the private
// lobby popover beside it), and one left column: eyebrow, display headline, a mode line from real data, Trios / Solo
// (+ the bot difficulty), ONE yellow Play whose label is the real action, the live status line from the server's
// own /health, and Firing range + Learn controls. Footer: keycap hints from the real bindings (Enter plays, Esc opens
// Settings). Everything the title offers is here: callsign, mode, bot difficulty, PLAY vs bots, private lobbies (create,
// join by code, invite links, the room with its roster and START / LEAVE), firing range, the controls guide, the
// controls strip (Training tab), errors / busy, full screen, controller navigation (ui/padnav.ts).
import type { BotDifficulty, LobbyActions, LobbyPlayer, LobbyScreen, LobbyState, Mode } from "./api";
import { injectStyles } from "./styles";
import { injectMenuStyles } from "./menu-styles";
import { injectLobbyStyles } from "./lobby-styles";
import { createControlsGuide } from "./onboarding";
import { TOON_LOGO, keycap } from "./toon";
import { ICON } from "./lobby-icons";
import { createServerStatus, type ServerStatus } from "./lobby-status";
import { playtestTitle } from "./title-flags";
import { matchSeats } from "../../../shared/sim/const";
import { bindingText, glyphFamily, lookText, onLabelsChange, pauseText } from "../settings/labels";
import { glyph, PB } from "../settings/pad";
import { device } from "../settings/device";

const NAME_KEY = "kr-callsign", MODE_KEY = "kr-mode", DIFF_KEY = "kr-bot-difficulty";
const NAME_MAX = 14;
/** the characters the server keeps in a name (server/index.ts cleanName): anything else would be silently dropped */
const NAME_OK = /^[A-Z0-9 _.!?'-]+$/;
const store = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private */ } } };

type Tab = "play" | "training";
type Ui = "home" | "invite" | "room";

/** the callsign as the server will keep it, or why it can't be one */
export function checkCallsign(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = raw.normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
  if (!v) return { ok: false, error: "Enter a callsign: 1–14 characters." };
  if (v.length > NAME_MAX) return { ok: false, error: `Keep it to ${NAME_MAX} characters.` };
  if (!NAME_OK.test(v)) return { ok: false, error: "Use letters, numbers, spaces and _ . ! ? ' - only." };
  return { ok: true, value: v };
}

export function createLobby(actions: LobbyActions): LobbyScreen {
  injectStyles(); injectMenuStyles(); injectLobbyStyles();
  const root = h("div", "kr-lobby tn-play", null);
  root.dataset.tab = "play";
  // the playtest title: ONE Play — no Trios / Solo, no bot difficulty, no Friends (ui/title-flags.ts)
  const PLAYTEST = playtestTitle();
  if (PLAYTEST) root.dataset.playtest = "1";
  h("div", "tn-play-shade", root);

  // ---------------- brand + nav
  const brand = h("img", "tn-logo tn-play-brand", root);
  brand.src = TOON_LOGO.lockup; brand.alt = "Kong Royale"; brand.draggable = false;
  const nav = h("nav", "tn-play-nav", root); nav.setAttribute("aria-label", "Lobby");
  const navBtn = (label: string) => { const b = h("button", "tn-pill", nav); b.type = "button"; b.textContent = label; return b; };
  const navPlay = navBtn("Play"), navTraining = navBtn("Training"), navSettings = navBtn("Settings");
  navPlay.addEventListener("click", () => setTab("play"));
  navTraining.addEventListener("click", () => setTab("training"));
  navSettings.addEventListener("click", () => openSettings());

  // ---------------- identity: callsign + edit, private lobby (friends)
  const id = h("div", "tn-play-id", root);
  const cs = h("div", "tn-play-cs", id);
  h("small", "", cs).textContent = "Callsign";
  const csName = h("b", "", cs);
  h("span", "tn-play-div", id);
  // inline edit: a disclosure popover (B on a controller closes it: game/index.ts closes the lobby's open <details>)
  const csPop = h("details", "tn-play-pop", id);
  const csSum = h("summary", "tn-play-link tn-play-link--sm", csPop);
  csSum.innerHTML = `${ICON.pencil}<span>Edit callsign</span>`;
  const csForm = h("form", "tn-play-panel", csPop); csForm.noValidate = true; csForm.setAttribute("aria-label", "Edit callsign");
  const csLabel = h("label", "tn-play-plabel", csForm); csLabel.textContent = "Callsign"; csLabel.htmlFor = "kr-callsign";
  const csInput = h("input", "tn-play-input", csForm);
  csInput.id = "kr-callsign"; csInput.maxLength = NAME_MAX; csInput.spellcheck = false; csInput.autocomplete = "off"; csInput.placeholder = "KONG";
  csInput.setAttribute("aria-describedby", "kr-callsign-help");
  const csHelp = h("div", "tn-play-help", csForm); csHelp.id = "kr-callsign-help";
  const csRow = h("div", "tn-play-prow", csForm);
  const csCancel = h("button", "tn-btn tn-btn--tertiary", csRow); csCancel.type = "button"; csCancel.textContent = "Cancel";
  const csSave = h("button", "tn-btn tn-btn--primary", csRow); csSave.type = "submit"; csSave.textContent = "Save";
  const HELP = "1–14 letters or numbers. Other players see this.";

  const frPop = h("details", "tn-play-pop", id);
  const frSum = h("summary", "tn-play-link tn-play-link--sm", frPop);
  frSum.innerHTML = `${ICON.friends}<span>Friends</span>`;
  frPop.hidden = PLAYTEST;
  const fr = h("div", "tn-play-panel", frPop); fr.setAttribute("role", "group"); fr.setAttribute("aria-label", "Play with friends");
  h("div", "tn-play-plabel", fr).textContent = "Play with friends";
  h("p", "tn-play-help", fr).textContent = "A private lobby for invited players. Bots fill the empty seats; the host picks the mode and starts.";
  const btnCreate = h("button", "tn-btn tn-btn--primary tn-play-wide", fr); btnCreate.type = "button";
  h("div", "tn-play-or", fr).textContent = "or join with a code";
  const joinRow = h("div", "tn-play-joinrow", fr);
  const codeInput = h("input", "tn-play-input tn-play-code", joinRow);
  codeInput.setAttribute("aria-label", "Lobby code"); codeInput.maxLength = 6; codeInput.placeholder = "CODE"; codeInput.spellcheck = false; codeInput.autocomplete = "off";
  const btnJoin = h("button", "tn-btn", joinRow); btnJoin.type = "button"; btnJoin.textContent = "Join";
  const frErr = h("div", "tn-play-help tn-play-ferr", fr); frErr.setAttribute("role", "alert");

  const toast = h("div", "tn-toast tn-play-toast", root); toast.setAttribute("role", "status");

  // ---------------- left column
  const main = h("div", "tn-play-main", root);
  // PLAY tab (home / invited / private lobby room)
  const play = h("section", "tn-play-sec-play", main);
  const eyebrow = h("div", "tn-eyebrow tn-play-eyebrow", play);
  h("h1", "tn-lobby-display tn-play-display", play).innerHTML = "Rule the<br>island.";
  const codeRow = h("div", "tn-play-coderow", play);
  const codeBig = h("div", "tn-title tn-play-roomcode", codeRow);
  const btnCopy = h("button", "tn-play-link", codeRow); btnCopy.type = "button";
  const modeLine = h("p", "tn-play-modeline", play);
  const choices = h("div", "tn-play-choices", play);
  const modes = h("div", "tn-play-modes", choices); modes.setAttribute("role", "radiogroup"); modes.setAttribute("aria-label", "Squad size");
  const modeBtn = (m: Mode, label: string) => { const b = h("button", "tn-pill", modes); b.type = "button"; b.setAttribute("role", "radio"); b.textContent = label; b.dataset.v = m; return b; };
  const btnTrios = modeBtn("trios", "Trios"), btnSolo = modeBtn("solo", "Solo");
  const bots = h("div", "tn-play-bots", choices);
  h("span", "tn-play-botslbl", bots).textContent = "Bots";
  const seg = h("div", "tn-seg", bots); seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-label", "Bot difficulty");
  const diffBtns = new Map<BotDifficulty, HTMLButtonElement>();
  for (const [d, label] of [["easy", "Easy"], ["standard", "Standard"], ["hard", "Hard"]] as const) {
    const b = h("button", "", seg); b.type = "button"; b.setAttribute("role", "radio"); b.textContent = label; b.dataset.v = d;
    b.addEventListener("click", () => setDifficulty(d));
    diffBtns.set(d, b);
  }
  const btnDecline = h("button", "tn-play-link", choices); btnDecline.type = "button"; btnDecline.innerHTML = `<span>Play vs bots instead</span>`;
  const roster = h("div", "tn-play-roster", play);
  // the one primary of the region: .kr-btn.play is the controller's first focus (game/index.ts padLayer)
  const cta = h("button", "tn-play-cta kr-btn play", play); cta.type = "button";
  const ctaLabel = h("span", "lbl", cta);
  const ctaSub = h("span", "sub", cta);
  h("span", "tn-play-spin", cta);
  cta.insertAdjacentHTML("beforeend", ICON.arrow);
  const err = h("div", "tn-play-err", play); err.setAttribute("role", "alert");
  const live = h("div", "tn-play-live", play); live.setAttribute("role", "status");
  const links = h("div", "tn-play-links", play);
  const btnRange = h("button", "tn-play-link", links); btnRange.type = "button"; btnRange.innerHTML = `${ICON.target}<span>Firing range</span>`;
  const btnGuide = h("button", "tn-play-link", links); btnGuide.type = "button"; btnGuide.innerHTML = `${ICON.book}<span>Learn controls</span>`;
  // (.room .kr-btn = the controller's first focus when Play is disabled, e.g. a guest waiting: only while in a room, and
  // after Play in the DOM so a host lands on Start match)
  const leaveBar = h("div", "tn-play-leavebar", links);
  const btnLeave = h("button", "tn-play-link kr-btn", leaveBar); btnLeave.type = "button"; btnLeave.innerHTML = `${ICON.leave}<span>Leave lobby</span>`;

  // TRAINING tab
  const training = h("section", "tn-play-sec-training", main);
  const tEyebrow = h("div", "tn-eyebrow tn-play-eyebrow", training); tEyebrow.textContent = "Training";
  h("h1", "tn-lobby-display tn-play-display", training).innerHTML = "Sharpen<br>up.";
  const tiles = h("div", "tn-play-tiles", training);
  const tile = (title: string, sub: string) => { const b = h("button", "tn-play-tile", tiles); b.type = "button"; h("b", "", b).textContent = title; const s = h("span", "", b); s.textContent = sub; b.insertAdjacentHTML("beforeend", ICON.chevron); return b; };
  const tileRange = tile("Firing range", "Every weapon, infinite ammo, targets at 10–205 m.");
  const tileGuide = tile("Learn controls", "Ten short lessons. Keys follow your bindings.");
  const keysHead = h("div", "tn-eyebrow tn-play-keyshead", training);
  const keys = h("div", "tn-play-keys", training);

  // ---------------- footer: keycap hints (real bindings), the game's full-screen toggle is adopted into it
  const foot = h("div", "tn-play-foot", root);
  const hintEnter = h("span", "tn-play-hint", foot), hintEsc = h("span", "tn-play-hint", foot);

  // ---------------- the controls guide (ui/onboarding.ts) — opened by Learn controls; its range button replays the coach
  const guide = createControlsGuide(() => actions.skipCoach?.(), () => { commitName(); actions.replayCoach?.(); actions.range(); });
  root.append(guide.el);
  const guideOpen = () => !guide.el.hidden;
  const openGuide = () => { closePops(); guide.open(); actions.replayCoach?.(); };

  // ================================================================ state
  let tab: Tab = "play";
  // the player's own pick (remembered on this device); in a private lobby the room's mode (the server's) shows instead
  let homeMode: Mode = store.get(MODE_KEY) === "trios" ? "trios" : "solo", mode: Mode = homeMode;
  const storedDiff = store.get(DIFF_KEY);
  let difficulty: BotDifficulty = storedDiff === "standard" || storedDiff === "hard" ? storedDiff : "easy";
  let last: LobbyState | null = null, ui: Ui = "home", inviteDeclined: string | null = null, status: ServerStatus = { state: "checking" };
  actions.setMode(mode);

  const callsign = () => (store.get(NAME_KEY) || "").toUpperCase().slice(0, NAME_MAX) || "KONG";
  function commitName() { actions.setName(callsign()); }
  const paintName = () => { csName.textContent = callsign(); };
  paintName();

  // ---------------- settings: the gear ui/settings.ts mounts into the lobby root (hidden here: the nav pill is its face)
  function openSettings() { closePops(); root.querySelector<HTMLButtonElement>(".kr-video-gear")?.click(); }

  // ---------------- tabs
  function setTab(t: Tab, quiet = false) {
    if (t === "training" && ui === "room") return;   // (the range would leave the private lobby)
    const changed = t !== tab;
    tab = t; root.dataset.tab = t;
    navPlay.classList.toggle("is-on", t === "play"); navTraining.classList.toggle("is-on", t === "training");
    navPlay.setAttribute("aria-current", String(t === "play")); navTraining.setAttribute("aria-current", String(t === "training"));
    if (changed && !quiet) swap(t === "play" ? play : training);
    paintHints();
  }
  const swap = (el: HTMLElement) => { el.classList.remove("tn-play-swap"); void el.offsetWidth; el.classList.add("tn-play-swap"); };

  // ---------------- mode + difficulty (remembered on this device)
  function paintMode() {
    for (const b of [btnTrios, btnSolo]) { const on = b.dataset.v === mode; b.classList.toggle("is-on", on); b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; }
  }
  function setModeLocal(m: Mode) {
    if (ui === "room") { if (last?.isHost) actions.setMode(m); return; }   // the server echoes the room's mode back
    homeMode = mode = m; store.set(MODE_KEY, m); paintMode(); paintModeLine(); actions.setMode(m);
  }
  btnTrios.addEventListener("click", () => setModeLocal("trios"));
  btnSolo.addEventListener("click", () => setModeLocal("solo"));
  function paintDifficulty() { diffBtns.forEach((b, d) => { const on = d === difficulty; b.classList.toggle("is-on", on); b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; }); }
  function setDifficulty(d: BotDifficulty) { difficulty = d; store.set(DIFF_KEY, d); paintDifficulty(); actions.setDifficulty?.(d); }
  // radio groups: arrows move the choice (Tab enters / leaves the group on its chosen pill)
  for (const g of [modes, seg]) g.addEventListener("keydown", (ev) => {
    const dir = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    const list = [...g.querySelectorAll<HTMLButtonElement>("button:not([disabled])")], i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    ev.preventDefault();
    const next = list[(i + dir + list.length) % list.length]; next.focus(); next.click();
  });
  paintMode(); paintDifficulty();

  // ---------------- popovers (callsign edit, friends): one open at a time; outside click / Esc / B closes
  const pops = [csPop, frPop];
  for (const p of pops) p.addEventListener("toggle", () => {
    if (p.open) {
      for (const q of pops) if (q !== p && q.open) q.open = false;
      if (p === csPop) { csInput.value = callsign() === "KONG" && !store.get(NAME_KEY) ? "" : callsign(); setCsError(null); requestAnimationFrame(() => { csInput.focus(); csInput.select(); }); }
      else { frErr.textContent = ""; }
    } else if (p.contains(document.activeElement) && document.activeElement !== p.querySelector("summary")) p.querySelector<HTMLElement>("summary")?.focus();
  });
  function closePops() { for (const p of pops) if (p.open) p.open = false; }
  root.addEventListener("pointerdown", (ev) => { for (const p of pops) if (p.open && !p.contains(ev.target as Node)) p.open = false; });

  // callsign validation: shown on Save (and cleared as soon as the text is valid again)
  function setCsError(msg: string | null) {
    csInput.setAttribute("aria-invalid", String(!!msg));
    csForm.classList.toggle("is-error", !!msg);
    if (msg) { csHelp.innerHTML = `${ICON.alert}<span></span>`; csHelp.querySelector("span")!.textContent = msg; }
    else csHelp.textContent = HELP;
    csHelp.classList.toggle("is-error", !!msg);
  }
  csInput.addEventListener("input", () => { if (csForm.classList.contains("is-error") && checkCallsign(csInput.value).ok) setCsError(null); });
  csForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const r = checkCallsign(csInput.value);
    if (!r.ok) { setCsError(r.error); csInput.focus(); return; }
    store.set(NAME_KEY, r.value); paintName(); actions.setName(r.value);
    csPop.open = false; showToast("Callsign saved");
    pop(csName);
  });
  csCancel.addEventListener("click", () => { csPop.open = false; });
  for (const inp of [csInput, codeInput]) inp.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closePops(); }
    if (ev.key === "Enter" && inp === codeInput) { ev.preventDefault(); ev.stopPropagation(); doJoin(); }
  });

  // private lobbies
  btnCreate.addEventListener("click", () => { commitName(); actions.create(mode); });
  const doJoin = () => { const code = codeInput.value.trim().toUpperCase(); if (code) { commitName(); actions.join(code); } else { frErr.textContent = "Enter the lobby code your friend shared."; codeInput.focus(); } };
  btnJoin.addEventListener("click", doJoin);
  let inviteUrl: string | null = null, copyTimer = 0;
  btnCopy.addEventListener("click", () => {
    if (!inviteUrl) return;
    void navigator.clipboard?.writeText(inviteUrl).then(() => { btnCopy.querySelector("span")!.textContent = "Copied!"; clearTimeout(copyTimer); copyTimer = window.setTimeout(() => { btnCopy.querySelector("span")!.textContent = "Copy invite link"; }, 1400); });
  });
  btnCopy.innerHTML = `${ICON.copy}<span>Copy invite link</span>`;
  btnLeave.addEventListener("click", () => actions.leave());
  btnDecline.addEventListener("click", () => { inviteDeclined = last?.invite ?? null; if (last) update(last); });

  // the one action: what Play does right now
  function primary(): void {
    if (cta.disabled) return;
    if (ui === "room") { actions.start(); return; }
    commitName();
    if (ui === "invite" && last?.invite) actions.join(last.invite);
    else actions.practice(mode, difficulty);
  }
  cta.addEventListener("click", primary);
  btnRange.addEventListener("click", () => { commitName(); actions.range(); });
  tileRange.addEventListener("click", () => { commitName(); actions.range(); });
  btnGuide.addEventListener("click", openGuide);
  tileGuide.addEventListener("click", openGuide);

  // ---------------- server status (real data: /health), the live line
  const server = createServerStatus((s) => { status = s; paintLive(); });
  function paintLive() {
    live.classList.toggle("is-off", status.state !== "online");
    if (status.state === "online") { const n = status.players; live.innerHTML = `<i></i><span>Live playtest</span><span class="sep">·</span><span><b>${n}</b> ${n === 1 ? "player" : "players"} online</span>`; }
    else if (status.state === "checking") live.innerHTML = `<i></i><span>Checking the playtest server…</span>`;
    else live.innerHTML = `<i></i><span>Server offline</span><span class="sep">·</span><span>Bot matches only</span>`;
  }
  paintLive();

  // ---------------- copy: eyebrow, mode line, the Play label
  function paintModeLine() {
    // a trios match seats 48 (16 even trios), solo 50 (shared/sim/const.ts matchSeats)
    const s = last, cap = Math.min(s?.capacity ?? 50, matchSeats(ui === "room" && s ? s.mode : mode));
    if (ui === "room" && s) {
      const humans = s.players.length, botsN = Math.max(0, cap - humans);
      modeLine.innerHTML = `<b>${humans}</b> ${humans === 1 ? "player" : "players"} + ${botsN} bots · ${s.mode === "trios" ? "Trios" : "Solo"} · Resurgence${s.casters ? ` · ${s.casters} ${s.casters === 1 ? "caster" : "casters"} watching` : ""}`;
    } else if (ui === "invite" && s?.invite) modeLine.textContent = `Lobby ${s.invite} · The host picks the mode`;
    else modeLine.innerHTML = PLAYTEST ? `<b>${cap}</b> players · Resurgence` : `<b>${cap}</b> players · ${mode === "trios" ? "Trios" : "Solo"} · Resurgence`;
    modeLine.title = ui === "home" ? (mode === "solo" ? `Starts now: you + ${cap - 1} bots. No public matchmaking.` : "Starts now: you + 2 bot teammates against bot squads. No public matchmaking.") : "";
  }
  function setCta(label: string, enabled: boolean, spin = false, sub = "") {
    if (ctaLabel.textContent !== label) ctaLabel.textContent = label;
    if (ctaSub.textContent !== sub) ctaSub.textContent = sub;
    cta.setAttribute("aria-label", sub ? `${label} ${sub}` : label);
    cta.disabled = !enabled; cta.classList.toggle("is-spin", spin);
  }

  // ---------------- footer hints + the Training controls strip (current bindings, current device)
  function hint(el: HTMLElement, key: string, label: string) {
    el.replaceChildren(keycap(key, "accent"), document.createTextNode(label));
  }
  function ctaVerb() { return ui === "room" ? "Start match" : ui === "invite" ? "Join lobby" : "Play"; }
  function paintHints() {
    // on a controller ui/padnav.ts shows its own hint bar (A select · B back · MENU settings): no second copy here
    const pad = device.pad, f = glyphFamily();
    if (pad) hint(hintEnter, glyph(PB.A, f), "Select");
    else hint(hintEnter, "Enter", tab === "training" ? "Firing range" : ctaVerb());
    hintEnter.hidden = pad || (tab === "play" && cta.disabled);
    hint(hintEsc, pad ? pauseText() : "Esc", "Settings");
    hintEsc.hidden = pad;
  }
  onLabelsChange(() => {
    paintHints();
    const key = (a: Parameters<typeof bindingText>[0]) => bindingText(a, 0).toUpperCase();
    const move = device.pad ? key("fwd") : (["fwd", "left", "back", "right"] as const).map(key).join("");
    const strip: Array<[string, string]> = device.pad
      ? [[move, "Move"], [lookText(), "Look"], [key("fire"), "Fire"], [key("jump"), "Jump"], [key("use"), "Open / take"], [key("map"), "Map"], [pauseText(), "Pause"]]
      : [[move, "Move"], [key("jump"), "Jump"], [key("use"), "Open / take"], [key("map"), "Map"], [key("inventory"), "Inventory"], ["ESC", "Pause"], ["/", "Report a bug"]];
    keysHead.textContent = device.pad ? "Your controller" : "Your keys";
    keys.replaceChildren(...strip.map(([k, label]) => { const s = document.createElement("span"); s.className = "tn-play-hint"; s.append(keycap(k), label); return s; }));
  });

  // the game's full-screen toggle (ui/fullscreen.ts appends it to this root) becomes a footer hint
  const adopt = () => { const fs = root.querySelector<HTMLElement>(":scope > .kr-fs-btn"); if (fs) { foot.appendChild(fs); fs.style.removeProperty("right"); fs.style.removeProperty("top"); fs.style.removeProperty("height"); } };
  new MutationObserver(adopt).observe(root, { childList: true });

  // ---------------- keyboard: Enter plays (Training: the firing range), Esc closes a popover or opens Settings
  addEventListener("keydown", (ev) => {
    if (root.classList.contains("kr-hide") || ev.defaultPrevented || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key !== "Enter" && ev.key !== "Escape") return;
    if (document.querySelector(".kr-video.on")) return;      // (settings handles its own keys)
    const t = ev.target as HTMLElement | null;
    if (t && t !== document.body && !root.contains(t)) return; // another overlay (the bug report bar, a toast) owns it
    if (guideOpen()) { if (ev.key === "Escape") { ev.preventDefault(); guide.el.querySelector<HTMLButtonElement>(".close")?.click(); } return; }
    if (ev.key === "Escape") {
      ev.preventDefault();
      if (pops.some((p) => p.open)) closePops(); else openSettings();
      return;
    }
    // Enter: a focused control keeps its own Enter
    if (t && t.closest("button, summary, input, select, textarea, a, [role=radio]")) return;
    if (pops.some((p) => p.open)) return;
    ev.preventDefault();
    if (tab === "training") { commitName(); actions.range(); } else primary();
  });

  // ================================================================ state → screen
  let rosterSig = "";
  function update(s: LobbyState) {
    last = s;
    // (an offline practice / range match reports itself as lobby "SOLO" while it starts: that is no private lobby)
    const inRoom = s.code != null && !s.offline, starting = s.offline;
    // (the firing range runs as solo and writes that into the game's lobby state: home keeps the player's pick; never
    // re-sent while an offline match owns the link — it would answer with a lobby message)
    if (inRoom) mode = s.mode;
    else { mode = homeMode; if (s.mode !== homeMode && !starting) actions.setMode(homeMode); }
    if (s.difficulty && s.difficulty !== difficulty) { difficulty = s.difficulty; paintDifficulty(); }
    paintMode();
    if (s.invite !== inviteDeclined && inviteDeclined && !s.invite) inviteDeclined = null;
    const prevUi = ui;
    ui = inRoom ? "room" : s.invite && s.invite !== inviteDeclined ? "invite" : "home";
    root.dataset.ui = ui;
    leaveBar.classList.toggle("room", inRoom);
    if (ui === "room" && tab === "training") setTab("play", true);
    navTraining.disabled = ui === "room";
    navTraining.title = ui === "room" ? "Leave the private lobby to train" : "";
    if (ui !== prevUi) { swap(play); if (ui === "room") closePops(); if (ui === "room" || prevUi === "room") window.setTimeout(() => server.refresh(), 600); }
    const host = inRoom && s.isHost, guest = (inRoom && !s.isHost) || ui === "invite";
    root.classList.toggle("guest", guest);

    // eyebrow + headline
    eyebrow.textContent = ui === "room" ? (s.isHost ? "Private lobby · You're the host" : "Private lobby · The host picks the mode")
      : ui === "invite" ? "You're invited" : "Battle royale";
    if (inRoom) codeBig.textContent = s.code!;
    inviteUrl = s.inviteUrl; btnCopy.hidden = !s.inviteUrl;
    paintModeLine();

    // the one primary
    if (ui === "room") {
      if (host) setCta(s.matchRunning ? "Match in progress" : s.startingIn != null ? `Starting ${Math.ceil(s.startingIn)}` : "Start match", !s.busy && !s.matchRunning);
      else setCta(s.matchRunning ? "Match in progress" : "Waiting for host", false, !s.matchRunning);
    } else if (starting) setCta("Starting…", false, true);
    else if (s.busy) setCta("Connecting…", false, true);
    else if (ui === "invite") setCta("Join lobby", true, false, s.invite ?? "");
    else setCta("Play", true, false, PLAYTEST ? "" : "vs bots");

    // controls that need the connection idle
    for (const b of [btnCreate, btnJoin, btnRange, tileRange, btnSolo, btnTrios, ...diffBtns.values()]) b.disabled = s.busy;
    if (inRoom) for (const b of [btnSolo, btnTrios]) b.disabled = s.busy || !s.isHost;
    btnLeave.disabled = s.busy;
    btnCreate.textContent = s.busy ? "Connecting…" : "Create lobby";
    if (s.invite && !codeInput.value) codeInput.value = s.invite;
    frSum.hidden = inRoom;
    btnDecline.hidden = ui !== "invite";

    // errors: the main line; while the friends popover is open, there too
    err.hidden = !s.error;
    if (s.error) { err.innerHTML = `${ICON.alert}<span></span>`; err.querySelector("span")!.textContent = s.error; }
    frErr.textContent = frPop.open && s.error ? s.error : "";
    if (s.error) server.refresh();

    // roster (only rebuilt when it changed)
    if (inRoom) {
      const sig = JSON.stringify([s.mode, s.meId, s.players.map((p) => [p.id, p.name, p.host, p.squad])]);
      if (sig !== rosterSig) { rosterSig = sig; paintRoster(s); }
    } else rosterSig = "";
    paintHints();
  }

  function paintRoster(s: LobbyState) {
    roster.replaceChildren();
    roster.classList.toggle("solo", s.mode === "solo");
    const chip = (parent: HTMLElement, p: LobbyPlayer | null) => {
      const name = p ? (p.name || "KONG") : "Bot", me = !!p && p.id === s.meId;
      const d = h("div", "tn-play-chip" + (p ? (me ? " is-me" : "") : " is-bot") + (name.length > (p?.host ? 7 : 9) ? " is-long" : ""), parent);
      if (p?.host) d.insertAdjacentHTML("beforeend", ICON.crown);
      h("span", "nm", d).textContent = name;
      if (p) d.title = `${name}${me ? " (you)" : ""}${p.host ? " · host" : ""}`;
      return d;
    };
    if (s.mode === "trios") {
      const squads = new Map<number, LobbyPlayer[]>();
      for (const p of s.players) { const a = squads.get(p.squad) ?? []; a.push(p); squads.set(p.squad, a); }
      for (const sq of [...squads.keys()].sort((a, b) => a - b).slice(0, 6)) {
        const ps = squads.get(sq)!;
        const row = h("div", "tn-play-squad" + (ps.some((p) => p.id === s.meId) ? " is-mine" : ""), roster);
        h("div", "sq", row).textContent = `Squad ${sq + 1}`;
        for (let i = 0; i < 3; i++) chip(row, ps[i] ?? null);
      }
    } else for (const p of s.players.slice(0, 12)) chip(roster, p);
  }

  // ---------------- little moments
  let toastTimer = 0;
  function showToast(msg: string) {
    toast.innerHTML = `<span></span>`; toast.querySelector("span")!.textContent = msg;
    toast.classList.remove("on"); void toast.offsetWidth; toast.classList.add("on");
    clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.classList.remove("on"), 1800);
  }
  const pop = (el: HTMLElement) => { el.classList.remove("tn-play-popin"); void el.offsetWidth; el.classList.add("tn-play-popin"); };

  setCsError(null);
  btnGuide.querySelector("span")!.textContent = "Learn controls";
  setTab("play", true);
  server.start();

  return {
    el: root,
    update,
    setVisible(v: boolean) {
      const was = !root.classList.contains("kr-hide");
      root.classList.toggle("kr-hide", !v);
      if (v) {
        if (!was) { setTab("play", true); swap(main); }
        btnGuide.querySelector("span")!.textContent = "Learn controls";
        server.start();
      } else { closePops(); server.stop(); }
    },
    get name() { return callsign(); },
  };
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement | null): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}
