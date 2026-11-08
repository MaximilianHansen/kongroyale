// HUMBLE COMMENTATOR — the caster seat app (?caster). A commentator joins any lobby by its code without taking a player
// slot (any time, even mid-match), or opens an EXHIBITION (50 bots, on the server or in this tab) to cast. The seat sees
// everything: every kong at full rate with exact health, every loadout, every event. On top: the camera rig (rig.ts), the
// autopilot director (director.ts), the desk (desk.ts), squad comms listen-in (voice/), and the other seats.
//
//   ?caster                 the caster lobby (join by code / open an exhibition)
//   ?cast=ABCD              straight into lobby ABCD's caster seat
//   ?caster=exhibit&mode=trios   a server exhibition, started at once (AUTO restarts it after each match)
//   ?caster=local&mode=trios     a local exhibition in this tab (no server)
//   &manual                 start in MANUAL (autopilot is on by default)
import type { Engine } from "../engine/engine";
import type { StaticWorld } from "../../../shared/sim/world";
import type { Chest } from "../../../shared/sim/loot";
import { placeLoot } from "../../../shared/sim/loot";
import { NET_VERSION } from "../../../shared/net/proto";
import { POIS } from "../../../shared/world/map";
import { ClientMatch } from "../game/client";
import { GameRender, type Kits } from "../game/render";
import { OfflineLink, connectWs, roomUrl, type Link } from "../game/net";
import type { GameInput } from "../game/input";
import type { TitleScene } from "../game/title";
import type { Hud } from "../ui/api";
import { createMapImage, type PaintedMap } from "../ui/mapimage";
import { CasterState } from "./state";
import { CasterRig, CAM_LABEL, type CamMode } from "./rig";
import { CasterDesk } from "./desk";
import { Director } from "./director";
import { Replay } from "./replay";
import { Highlights } from "./highlights";
import { teamLook } from "./teams";
import { LOBBY_CSS } from "./lobby-css";
import { createCasterComms, type CasterComms } from "./comms";
import { CasterLook } from "./look";
import { Seats } from "./seats";
import { lastResults } from "./panels";
import { flag } from "../flags";

export interface CasterDeps {
  engine: Engine; world: StaticWorld; kits: Kits; hud: Hud; title: TitleScene; input: GameInput; ui: HTMLElement;
  wsUrl: string; prepareIsland: () => Promise<void>; worldHash: number; terrainHash: number | undefined;
}
export interface CasterApp {
  /** a match is on screen: the game's frame loop hands the frame to update() instead of the title */
  readonly active: boolean;
  update(dt: number, t: number): void;
}

type Mode = "solo" | "trios";
interface LobbyMsg { code: string; mode: Mode; host: number; inMatch: boolean; phase: number; players: Array<{ id: number; name: string; squad: number; pid: number; host: boolean }>; casters?: Array<{ id: number; name: string; seat: number; host: boolean; program?: boolean }>; exhibit?: boolean; auto?: boolean; onAir?: number }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const isTyping = (e: Event) => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); };

export function createCasterApp(d: CasterDeps): CasterApp {
  const { engine, world, kits } = d;
  // ---- the caster lobby (over the title scene)
  { const st = document.createElement("style"); st.textContent = LOBBY_CSS; document.head.appendChild(st); }
  const panel = document.createElement("div"); panel.className = "kcl"; d.ui.appendChild(panel);
  let myName = (() => { try { return localStorage.getItem("kr-caster-name") || "CASTER"; } catch { return "CASTER"; } })();
  let link: Link | null = null, cm: ClientMatch | null = null, render: GameRender | null = null;
  /** the room code the server link was opened for (game/index.ts online: a front routes a link by it) */
  let linkRoom = "";
  let state: CasterState | null = null, rig: CasterRig | null = null, desk: CasterDesk | null = null, director: Director | null = null;
  /** (voice) listen-in on squads + bot callouts (comms.ts): one per match on screen */
  let comms: CasterComms | null = null;
  let lobby: LobbyMsg | null = null, myUid = 0, casting = false, error = "", busy = false, local = false;
  /** instant replay + highlights (replay.ts, highlights.ts) */
  let replay: Replay | null = null, highlights: Highlights | null = null;
  let map: PaintedMap | null = null;
  const autoDefault = !flag("manual");
  /** (seats.ts) the other seats' cameras, mirroring, the producer's TAKE, pings. `program`: this window is a PROGRAM
   *  output (?cast=CODE&program — the OBS feed): it only mirrors the seat on air, behind the broadcast layer */
  const program = flag("program");
  let seats: Seats | null = null;

  function drawPanel() {
    const l = lobby, inLobby = !!l && !casting;
    const seats = l?.casters ?? [], players = l?.players ?? [];
    const owner = l ? (seats.find((c) => c.id === l.host) ?? players.find((p) => p.id === l.host)) : null;
    const iOwn = !!l && l.host === myUid;
    // a PROGRAM window shows a standby slate until the match (OBS captures it)
    if (program && !error) { panel.innerHTML = `<div class="kb-slate"><div><b>KONG ROYALE</b><span>LIVE${l ? ` · ${esc(l.code)}` : ""}</span><em>${busy ? "CONNECTING…" : l ? "THE MATCH STARTS SOON" : "STAND BY"}</em></div></div>`; return; }
    panel.innerHTML = `<div class="kcl-card">
      <div class="kcl-brand"><b>KONG ROYALE</b><span>CASTER DESK</span></div>
      <label class="kcl-name">YOUR CASTER NAME <input data-k="name" maxlength="14" value="${esc(myName)}"></label>
      ${inLobby ? `
        <div class="kcl-lobby">
          <div class="kcl-code">LOBBY <b>${esc(l!.code)}</b> · ${l!.mode.toUpperCase()}${l!.exhibit ? " · EXHIBITION" : ""}</div>
          <div class="kcl-status">${l!.inMatch ? "A MATCH IS RUNNING — JOINING…" : iOwn ? "PRESS START WHEN READY" : `WAITING FOR ${esc(owner?.name ?? "THE HOST")} TO START`}</div>
          <div class="kcl-cols"><div><h5>CASTER SEATS (${seats.length}/8)</h5>${seats.map((c) => `<div class="kcl-row ${c.id === myUid ? "me" : ""}">SEAT ${c.seat + 1} · ${esc(c.name)}${c.host ? " ★" : ""}</div>`).join("")}</div>
          <div><h5>PLAYERS (${players.length})</h5>${players.length ? players.map((p) => `<div class="kcl-row">${esc(p.name)}${p.host ? " ★" : ""}</div>`).join("") : `<div class="kcl-row dim">${l!.exhibit ? "50 BOTS (humans may join with the code)" : "nobody yet"}</div>`}</div></div>
          ${iOwn && !l!.inMatch ? `<div class="kcl-btns"><button data-a="start" class="go">START MATCH</button><button data-a="mode">${l!.mode === "solo" ? "SWITCH TO TRIOS" : "SWITCH TO SOLO"}</button>${l!.exhibit && !local ? `<button data-a="auto">${l!.auto ? "AUTO-RESTART ON" : "AUTO-RESTART OFF"}</button>` : ""}</div>` : ""}
          <div class="kcl-btns"><button data-a="leave">LEAVE</button></div>
          <p class="kcl-hint">Other casters join this desk with <b>?cast=${esc(l!.code)}</b> · players join the match with the code <b>${esc(l!.code)}</b></p>
        </div>` : `
        <div class="kcl-join"><input data-k="code" maxlength="8" placeholder="LOBBY CODE" value="${esc(flag("cast") ?? "")}"><button data-a="join" class="go">CAST THIS LOBBY</button></div>
        <div class="kcl-or">— OR OPEN AN EXHIBITION (50 BOTS) —</div>
        <div class="kcl-btns"><button data-a="ex-solo">SERVER · SOLO</button><button data-a="ex-trios" class="go">SERVER · TRIOS</button></div>
        <div class="kcl-btns"><button data-a="lo-solo">THIS TAB · SOLO</button><button data-a="lo-trios">THIS TAB · TRIOS</button></div>
        <p class="kcl-hint">Server exhibitions can take more caster seats (share the code). "This tab" runs the match locally — no server needed.</p>`}
      ${lastResults.html && !l?.inMatch ? `<div class="kcl-last"><h5>LAST MATCH</h5><div class="kb-results on kcl-res">${lastResults.html}</div></div>` : ""}
      ${busy ? `<div class="kcl-busy">CONNECTING…</div>` : ""}${error ? `<div class="kcl-err">${esc(error)}</div>` : ""}
    </div>`;
  }
  panel.addEventListener("input", (e) => { const t = e.target as HTMLInputElement; if (t.dataset.k === "name") { myName = t.value.toUpperCase().slice(0, 14); try { localStorage.setItem("kr-caster-name", myName); } catch { /* private */ } link?.sendJSON({ t: "hello", name: myName }); } });
  panel.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a; if (!a) return;
    void kits.audio.unlock();
    if (a === "join") { const code = (panel.querySelector<HTMLInputElement>("[data-k=code]")?.value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""); if (code) void joinServer({ t: "cast", code }); else { error = "TYPE A LOBBY CODE"; drawPanel(); } }
    else if (a === "ex-solo" || a === "ex-trios") void joinServer({ t: "exhibit", mode: a === "ex-solo" ? "solo" : "trios", auto: true });
    else if (a === "lo-solo" || a === "lo-trios") void startLocal(a === "lo-solo" ? "solo" : "trios");
    else if (a === "start") link?.sendJSON({ t: "start", mode: lobby?.mode });
    else if (a === "mode") link?.sendJSON({ t: "mode", mode: lobby?.mode === "solo" ? "trios" : "solo" });
    else if (a === "auto") link?.sendJSON({ t: "castopt", auto: !lobby?.auto });
    else if (a === "leave") leave();
  });
  panel.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.target as HTMLElement).dataset.k === "code") panel.querySelector<HTMLElement>("[data-a=join]")?.click(); });

  // ---- connections
  async function joinServer(first: Record<string, unknown>) {
    error = ""; busy = true; drawPanel();
    await d.prepareIsland();
    try {
      const room = first.t === "cast" ? String(first.code ?? "") : "";
      if (!link || link.offline || (link.proc !== undefined && linkRoom !== room)) { closeLink(); const l = await connectWs(roomUrl(d.wsUrl, room)); link = l; linkRoom = room; local = false; wire(l); }
      link!.sendJSON({ t: "hello", name: myName }); link!.sendJSON(first);
      if (first.t === "exhibit" && flag("caster") === "exhibit") setTimeout(() => link?.sendJSON({ t: "start" }), 400);
    } catch { error = "NO GAME SERVER — start `npm run server`, or cast a match in THIS TAB"; link = null; }
    busy = false; drawPanel();
  }
  async function startLocal(mode: Mode) {
    error = ""; busy = true; drawPanel();
    await d.prepareIsland();
    closeLink();
    const l = new OfflineLink(world, myName, 1, Infinity, false, "standard", true); link = l; local = true; myUid = 1; wire(l);
    l.sendJSON({ t: "hello", name: myName }); l.sendJSON({ t: "exhibit", mode });
    setTimeout(() => l.sendJSON({ t: "start", mode }), 50);
    busy = false; drawPanel();
  }
  function closeLink() { const old = link; link = null; if (old) { old.onClose = () => {}; old.onJSON = () => {}; old.onBinary = () => {}; old.sendJSON({ t: "leave" }); old.close(); } endSession(); }
  function leave() { closeLink(); lobby = null; casting = false; drawPanel(); }

  function wire(l: Link) {
    endSession();
    cm = new ClientMatch(world, l);
    render = new GameRender(engine, cm, kits, d.input);
    state = new CasterState(cm);
    rig = new CasterRig(engine, world, state, engine.canvas);
    director = new Director(state);
    seats = new Seats({ link: () => link, rig: () => rig, state: () => state, desk: () => desk, mySeat: () => cm?.seat ?? -1, myUid: () => myUid,
      casters: () => lobby?.casters ?? [{ id: myUid, name: myName, seat: cm?.seat ?? 0, host: true }],
      setAuto: (on) => setAuto(on), autoOn: () => !!director?.enabled }, program);
    director.onShot = (shot, glide) => { rig?.set(shot, glide); };
    // (replay) the recorder wraps the renderer's sink BEFORE the tee: every visual event is recorded with its tick, and
    // the live ones are not drawn while a replay is on screen (CasterState still counts them through the tee)
    director.cm = cm; replay = new Replay(cm, render, state, rig, director); cm.sink = replay.sinkFor(render); highlights = new Highlights(cm, state, replay, director);
    const st = state, rg = rig, r = render;
    // (look) team outlines + x-ray, nameplates / markers, POV hands, damage numbers (look.ts)
    const lk = look = new CasterLook(engine, kits, cm, state, rig, d.ui);
    render.caster = {
      get fov() { return rg.fov; },
      camera: (dt) => { st.update(dt); if (director && cm) director.update(cm.phase); rg.apply(dt); },
      // team outline (+ a faint team rim) on every kong; the POV kong is hidden (we are inside its head)
      actor: (rm, actor) => lk.actor(rm, actor),
      hands: () => lk.hands(),
    };
    teeSink(r, st);
    l.onJSON = (m) => { if (link === l) onJSON(m); };
    l.onClose = (reason) => { if (link === l) { link = null; endSession(); casting = false; lobby = null; error = reason.toUpperCase(); showLobby(); } };
  }
  /** every event reaches the renderer (FX, sounds) AND the caster's picture of the match */
  function teeSink(r: GameRender, st: CasterState) {
    const c = cm!;
    const sink = c.sink!;
    c.sink = new Proxy(sink, { get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      switch (prop) {
        case "hit": return (shooter: number, victim: number, zone: number, dmg: number, x: number, y: number, z: number, kill: boolean, sb?: boolean) => { v.call(target, shooter, victim, zone, dmg, x, y, z, kill, sb); st.onHit(shooter, victim, zone, dmg, kill); st.creditFight(victim, dmg, kill); };
        case "shot": return (shooter: number, weapon: number, ox: number, oy: number, oz: number, ex: number, ey: number, ez: number, surf: number, hit: boolean) => { v.call(target, shooter, weapon, ox, oy, oz, ex, ey, ez, surf, hit); st.onShot(shooter, ex, ey, ez); };
        case "kill": return (killer: number, victim: number, weapon: number, final: boolean) => { v.call(target, killer, victim, weapon, final); st.onKill(killer, victim, weapon, final); };
        case "announceCode": return (code: number, a: number, b: number) => { v.call(target, code, a, b); st.onAnnounce(code, a, b); };
        case "storm": return (phase: number, shrinking: boolean) => { v.call(target, phase, shrinking); st.onStorm(phase, shrinking); };
        case "phase": return (phase: number) => { v.call(target, phase); st.onPhase(phase); };
        default: return v.bind(target);
      }
    } });
    void r;
  }
  let look: CasterLook | null = null;

  function onJSON(m: Record<string, unknown>) {
    if (m.t === "welcome") {
      myUid = m.uid as number;
      const th = m.terrain as number | undefined, wh = m.world as number | undefined;
      if ((th !== undefined && d.terrainHash !== undefined && th !== d.terrainHash) || (wh !== undefined && wh !== d.worldHash) || (m.net !== undefined && m.net !== NET_VERSION)) { error = "GAME UPDATED — RELOAD THE PAGE"; closeLink(); drawPanel(); }
    } else if (m.t === "lobby") {
      lobby = m as unknown as LobbyMsg;
      if (cm && render) for (const p of lobby.players) if (p.pid >= 0) { cm.names[p.pid] = p.name; render.names[p.pid] = p.name; }
      seats?.onLobby(lobby);
      // the match ended (results done): back to the lobby card, a fresh renderer for the next one
      if (casting && !lobby.inMatch) { casting = false; if (link) wire(link); showLobby(); }
      if (!casting) drawPanel();
    } else if (m.t === "match") {
      if (!cm || !render || m.caster !== true) return;
      enterMatch(m);
    } else if (m.t === "rtc" || m.t === "voiceroster" || m.t === "listening") { comms?.onJSON(m); }
    else if (m.t === "phase") { cm?.onJSON(m); }
    else if (m.t === "castcam") seats?.onCastcam(m);
    else if (m.t === "castprog") seats?.onProg(m);
    else if (m.t === "castping") seats?.onPing(m); else if (m.t === "error") { error = String(m.msg); busy = false; if (!casting) drawPanel(); else desk?.toast(error); }
  }

  function enterMatch(m: Record<string, unknown>) {
    const c = cm!, r = render!;
    const range = m.range === true, seed = m.seed as number, rows = m.chests as number[][] | undefined;
    c.chests = rows ? rows.map((x): Chest => ({ id: x[0], x: x[1], y: x[2], z: x[3], yaw: x[4], rarity: x[5], opened: false, poi: x[6], box: x[7] ? 1 : 0 })) : placeLoot(seed, world).chests;
    c.items.clear(); c.range = range; r.setRange(range);
    if (m.names) { c.names = (m.names as string[]).slice(); r.names = c.names; }
    c.onJSON(m);
    for (const p of lobby?.players ?? []) if (p.pid >= 0) { c.names[p.pid] = p.name; r.names[p.pid] = p.name; }
    void r.buildChests(); void r.prewarmActors();
    r.phase(c.phase);
    map ??= createMapImage(engine.terrain, 2560, POIS) as PaintedMap;
    desk?.dispose();
    desk = new CasterDesk(state!, rig!, c, map, lobby?.code ?? (local ? "LOCAL" : "—"), {
      follow: (id, mode) => { manual(); rig!.set({ mode: mode ?? (rig!.mode === "pov" || rig!.mode === "orbit" ? rig!.mode : "follow"), target: id, fight: -1, group: [] }); },
      fight: (id) => { manual(); const f = state!.fight(id); if (f) rig!.set({ mode: "drone", fight: id, group: f.players, target: f.players[0] }); },
      team: (team) => { manual(); const t = state!.teams.get(team); if (t) { const alive = t.members.filter((id) => state!.players[id].alive); rig!.set({ mode: "drone", fight: -1, group: alive.length ? alive : t.members, target: alive[0] ?? t.members[0] }); } },
      setMode: (mode) => { manual(); setMode(mode); },
      toggleAuto: () => setAuto(!director!.enabled),
      toggleListen: (team) => { comms?.toggle(team); },
      freeAt: (x, z) => { manual(); engine.camera.position.set(x, engine.terrain.height(x, z) + 90, z + 60); engine.camera.lookAt(x, engine.terrain.height(x, z), z); rig!.set({ mode: "free" }); },
      followSeat: (seat) => seats?.toggleFollow(seat),
      take: (seat) => seats?.take(seat), ping: () => seats?.sendPing(), acceptPing: () => seats?.accept(),
    });
    d.ui.appendChild(desk.el);
    replay?.attach(desk.el); highlights?.attach(desk.el);
    comms?.dispose(); comms = createCasterComms({ link: link!, state: state!, desk, cm: c });
    if (program) desk.setProgram(true);
    casting = true; panel.style.display = "none"; d.title.setVisible(false); d.hud.setVisible(false);
    setAuto(autoDefault && !program);
    if (!autoDefault) { const first = state!.players.find((p) => p.alive) ?? state!.players[0]; rig!.set({ mode: "follow", target: first.id }); }
    void kits.audio.unlock();
  }

  function setMode(mode: CamMode) {
    const r = rig!, s = state!;
    if ((mode === "follow" || mode === "pov" || mode === "orbit") && (r.target < 0 || !s.players[r.target]?.alive)) {
      const f = r.fight >= 0 ? s.fight(r.fight) : null;
      const pick = f?.players.find((id) => s.players[id].alive) ?? s.players.find((p) => p.alive && p.live)?.id ?? -1;
      r.set({ mode, target: pick, fight: -1 });
    } else if (mode === "drone" && r.fight < 0 && r.target >= 0) {
      const f = s.players[r.target]?.fight ?? -1, fight = f >= 0 ? s.fight(f) : null;
      r.set({ mode, fight: fight ? fight.id : -1, group: fight ? fight.players : [r.target] });
    } else r.set({ mode, fight: mode === "follow" || mode === "pov" || mode === "orbit" ? -1 : r.fight });
    desk?.toast(CAM_LABEL[mode]);
  }
  function setAuto(on: boolean) {
    if (!director || !desk) return;
    director.setEnabled(on); desk.auto = on;
    if (on) { if (seats && !seats.program) seats.follow = -1; desk.toast("AUTOPILOT ON — following the action"); }
    else { desk.dirText = ""; }
  }
  /** a hand on the controls: the autopilot steps aside */
  function manual() { rig?.cancelKillCam(); if (director?.enabled) { setAuto(false); desk?.toast("MANUAL — SPACE gives the camera back to the autopilot"); } if (seats) seats.follow = -1; }

  function showLobby() { desk?.dispose(); desk = null; panel.style.display = ""; d.title.setVisible(true); drawPanel(); }
  function endSession() { replay?.dispose(); replay = null; highlights?.dispose(); highlights = null; comms?.dispose(); comms = null; look?.dispose(); look = null; render?.dispose(); rig?.dispose(); desk?.dispose(); render = null; cm = null; state = null; rig = null; desk = null; director = null; kits.audio.endSession?.(); }

  // ---- keys
  window.addEventListener("keydown", (e) => {
    if (!casting || !rig || !state || !desk || isTyping(e)) return;
    // a PROGRAM window takes no direction (H peeks at the desk; the output itself stays clean)
    if (program) { if (e.code === "KeyH") desk.setClean(!desk.clean); return; }
    const s = state, r = rig;
    const alive = s.players.filter((p) => p.alive && p.live && !p.inPlane);
    const k = e.code;
    // (seats) N pings my shot to the other seats, Y takes the last ping, ENTER (producer) puts my camera on air; B = board
    if (k === "KeyN") { seats?.sendPing(); return; }
    if (k === "KeyY") { seats?.accept(); return; }
    if (k === "Enter" || k === "NumpadEnter") { if (seats && cm) seats.take(cm.seat); e.preventDefault(); return; }
    if (k === "KeyB") { desk.toggleBoard(); return; }
    if (k === "Space" || k === "KeyP") { setAuto(!director!.enabled); e.preventDefault(); return; }
    const modeKeys: Record<string, CamMode> = { Digit1: "follow", Digit2: "pov", Digit3: "drone", Digit4: "orbit", Digit5: "overhead", Digit6: "free" };
    if (modeKeys[k]) { manual(); setMode(modeKeys[k]); return; }
    if (k === "Tab") {
      e.preventDefault(); manual();
      const order = [...s.teams.values()].sort((a, b) => a.id - b.id).flatMap((t) => t.members).filter((id) => s.players[id].alive && s.players[id].live);
      if (!order.length) return;
      const i = order.indexOf(r.target), n = order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length];
      r.set({ mode: r.mode === "pov" || r.mode === "orbit" ? r.mode : "follow", target: n, fight: -1, group: [] });
      return;
    }
    if (k === "KeyF") { const f = s.fights[0]; if (f) { manual(); r.set({ mode: "drone", fight: f.id, group: f.players, target: f.players[0] }); desk.toast(`HOTTEST FIGHT · ${f.where}`); } else desk.toast("NO FIGHT RIGHT NOW"); return; }
    if (k === "KeyG") { if (s.fights.length) { manual(); const i = s.fights.findIndex((f) => f.id === r.fight), f = s.fights[(i + 1) % s.fights.length]; r.set({ mode: "drone", fight: f.id, group: f.players, target: f.players[0] }); desk.toast(`FIGHT ${s.fights.indexOf(f) + 1}/${s.fights.length} · ${f.where}`); } return; }
    if (k === "KeyT") { const top = alive.sort((a, b) => b.kills - a.kills || b.damage - a.damage)[0]; if (top) { manual(); r.set({ mode: "follow", target: top.id, fight: -1 }); desk.toast(`TOP FRAGGER · ${top.name} · ${top.kills}`); } return; }
    if (k === "KeyC") { r.rechase(); return; }
    if (k === "KeyM") { desk.setTactical(!desk.tactical); return; }
    if (k === "KeyH") { desk.setClean(!desk.clean); return; }
    // (look) X = x-ray: every kong through walls / trees as its team's silhouette · I = nameplates + team markers
    if (k === "KeyX" && look) { desk.toast(look.cycleXray()); return; }
    if (k === "KeyI" && look) { look.setPlates(!look.plates); look.teamRings = look.plates; desk.toast(look.plates ? "NAMEPLATES ON" : "NAMEPLATES OFF"); return; }
    // (voice) L = listen in on the watched kong's squad (again = stop)
    if (k === "KeyL") { const p = r.target >= 0 ? s.players[r.target] : r.fight >= 0 ? s.players[s.fight(r.fight)?.players[0] ?? -1] : undefined; if (p) comms?.toggle(p.team); else desk.toast("FOLLOW A KONG — L LISTENS TO ITS SQUAD"); return; }
    if (k === "Slash" || k === "F1") { desk.toggleHelp(); e.preventDefault(); return; }
    if (k === "Escape") { desk.closeOverlay(); return; }
  });

  // ---- boot: URL shortcuts
  drawPanel();
  const wantCast = flag("cast"), wantCaster = flag("caster"), wantMode: Mode = flag("mode") === "trios" ? "trios" : "solo";
  const kr = (window as unknown as { __kr: Record<string, unknown> }).__kr;
  void (async () => {
    while (!kr.ready) await new Promise((r) => setTimeout(r, 100));
    if (wantCast) void joinServer({ t: "cast", code: wantCast.toUpperCase(), program });
    else if (wantCaster === "local") void startLocal(wantMode);
    else if (wantCaster === "exhibit") void joinServer({ t: "exhibit", mode: wantMode, auto: true });
  })();
  // audio needs a gesture: the first click / key anywhere unlocks it
  const unlock = () => { void kits.audio.unlock(); window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  window.addEventListener("pointerdown", unlock); window.addEventListener("keydown", unlock);

  // tools / tests
  kr.caster = { get replay() { return replay; }, get highlights() { return highlights; }, get look() { return look; }, get cm() { return cm; }, get state() { return state; }, get rig() { return rig; }, get director() { return director; }, get desk() { return desk; }, get casting() { return casting; }, get lobby() { return lobby; }, get seats() { return seats; }, get comms() { return comms; },
    setMode: (m: CamMode) => { manual(); setMode(m); }, setAuto: (on: boolean) => setAuto(on), startNow: () => link?.sendJSON({ t: "start", mode: lobby?.mode }), get link() { return link; }, follow: (id: number, mode?: CamMode) => { manual(); rig?.set({ mode: mode ?? "follow", target: id, fight: -1 }); } };

  return {
    get active() { return casting; },
    update(dt: number, t: number) {
      link?.pump?.();
      if (!casting || !cm || !render) return;
      cm.update(dt, d.input, false);
      // (replay) record the newest snapshots, then (while replaying) draw the recorded past for this one frame
      replay?.record(); replay?.begin(dt);
      render.update(dt, t);
      replay?.frameUi(); highlights?.update(); highlights?.frameUi();
      look?.update(dt);
      if (director?.enabled && desk) desk.dirText = director.line ? `<i>AUTO</i> · ${director.line}` : "<i>AUTO</i> · looking for the action…";
      if (desk && seats) desk.seats = seats.infos();
      seats?.update(dt);
      comms?.update(dt);
      desk?.update(dt);
      // (replay) the live rings back only now: the whole frame (nameplates, desk) saw the same moment
      replay?.end();
    },
  };
}
