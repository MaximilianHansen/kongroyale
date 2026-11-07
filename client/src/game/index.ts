// THE GAME. Boot: prewarm every spawnable prefab (shader programs + textures compiled while the loading screen is up) →
// title/lobby over the live island → connect (ws) or practice (offline host) → match.
import * as THREE from "three";
import type { Engine } from "../engine/engine";
import type { CamSpec } from "../engine/views";
import type { WorldModule } from "../world/module";
import { CONSUMABLES, POIS, RARITIES, WEAPONS, type ConsumableId, type WeaponId } from "../../../shared/world/map";
import { staticWorld } from "../engine/static-world";
import { adoptWorkerLootSpots } from "../engine/lootspots";
import { terrainData } from "../world/terrain/load";
import { placeLoot, type Chest, type Item } from "../../../shared/sim/loot";
import { lootSpotsIdle } from "../../../shared/sim/loot-spots";
import { PS, SK } from "../../../shared/sim/player";
import { warmupViewpoints } from "../../../shared/sim/match";
import { inStorm } from "../../../shared/sim/storm";
import { PLANE_ALT } from "../../../shared/sim/const";
import { createWeaponsKit } from "../weapons/index";
import type { Fx } from "../weapons/api";
import { createAudio } from "../audio/index";
import { createKong, kongManager } from "../actors/kong";
import type { KongActor, KongPose } from "../actors/api";
import { createPlane } from "../actors/plane";
import { createGlider } from "../actors/glider";
import { loadHeli, loadsLazily } from "../actors/heli-tripo";
import { createStormVisual } from "./storm/index";
import { createHud } from "../ui/hud";
import { createInventory } from "../ui/inventory";
import { createShop } from "../ui/shop";
import { createFullscreenUi } from "../ui/fullscreen";
import { createMatchMenu } from "../ui/match-menu";
import { INV, NET_VERSION } from "../../../shared/net/proto";
import type { OutcomeState } from "../../../shared/net/host";
import { createControlCoach, createCoachObserver } from "../ui/onboarding";
import { createLobby } from "../ui/lobby";
import { createEventLobby, type EventLobbyState } from "../ui/event-lobby";
import { EVENT_CODE_RE, EVENT_PARAM, PLAYER_TOKEN_RE, type EventEndReason, type EventRoom } from "../../../shared/net/event";
import { createResults } from "../ui/results";
import { createPersonalBests } from "../ui/personal-bests";
import type { BotDifficulty, LobbyActions, LobbyState, Mode } from "../ui/api";
import { GameInput } from "./input";
import { gamepads } from "./gamepad";
import { VKind } from "../../../shared/sim/vehicle";
import { createAimAssist } from "./aim-assist";
import { createPadNav, type PadLayer } from "../ui/padnav";
import { device } from "../settings/device";
import { PB, type PadAction } from "../settings/pad";
import { preferences } from "../settings/preferences";
import { RIDE_BINDS, type BindAction } from "../settings/bindings";
import { ClientMatch } from "./client";
import { GameRender, patchTree, renderPrefabs, type Kits } from "./render";
import { OfflineLink, connectWs, type Link } from "./net";
import { createFallbackFx } from "./fx-fallback";
import { createLightBalancer } from "./lights";
import { createTitleScene, type TitleScene } from "./title";
import { createGpuWarmer } from "./warm";
import { createBlimp } from "./blimp";
import { createCasterApp, type CasterApp } from "../caster/app";
import { createSquadVoice, type SquadVoice } from "../voice/squad";
import { flag } from "../flags";

export interface GameBoot { views: Record<string, CamSpec>; modules: WorldModule[] }

/** the host's outcome is final: the squad is out (or won) with a real placement */
function completedResult(state: OutcomeState): boolean {
  return (state.winner === true || state.squadOut === true) && Number.isInteger(state.placement) && state.placement > 0;
}

export async function startGame(engine: Engine, boot: GameBoot) {
  const ui = document.getElementById("ui")!;
  const canvas = engine.canvas;
  const releaseBoot = engine.hold("game-prewarm");
  gameStage("world", 0.02);
  // ---- static world for prediction (same data as the server)
  // (perf: built in a Web Worker started at t = 0 — engine/static-world.ts; same recipe as the server)
  const { world, hash: worldHashV, boxes: worldBoxesAll } = await staticWorld(engine.terrain, terrainData());
  // only the count is kept for the mismatch warning: holding the list kept every one of the ~490 k collider
  // objects alive for the whole session (the world has its own packed copy)
  const worldBoxes = { length: worldBoxesAll.length };
  adoptWorkerLootSpots(world, worldHashV); // (perf: the loot spots built off the main thread, hash-checked)
  gameStage("kits", 0.1);

  // ---- kits (contracts)
  const weapons = createWeaponsKit(engine);
  if (!DEFER_PREFABS) void weapons.prepareLoot();
  gameStage("kits:viewmodel", 0.12);
  // (perf: the first-person viewmodel — ~1.7 s of weapon LOD / merge work — only ever draws in a match: with
  // DEFER_PREFABS it is made right after the title is ready, in the prefab warm-up every PRACTICE / CREATE / JOIN waits
  // for (__kr.prepare). ?prewarm=full makes it here.)
  const [viewModel, plane] = await Promise.all([DEFER_PREFABS ? Promise.resolve(null) : weapons.createViewModel(), createPlane(engine)]);
  gameStage("kits:fx", 0.14);
  // the jump plane lives in the scene from boot (hidden when unused): the atmos material patch + the prewarm compile see
  // it, instead of it first drawing — unpatched, compiling 7 programs — the moment a match starts
  plane.object.visible = false; engine.scene.add(plane.object);
  const fx = wrapFx(engine, weapons.createFx(), weapons as unknown as { createRocket?: () => Promise<unknown> });
  gameStage("kits:audio", 0.15);
  const audio = createAudio();
  gameStage("kits:storm", 0.16);
  const storm = createStormVisual(engine);
  gameStage("kits:hud", 0.17);
  const hud = createHud(engine.terrain, POIS);
  gameStage("kits:rest", 0.18);
  const results = createResults();
  // the results card's authoritative numbers (the host's { t: "result" }) for the current match
  let resultOutcome: OutcomeState | null = null, resultTotalSquads: number | null = null, resultDismissed = false;
  // personal bests on this device: one recap session per match (its "before" records), saved once the host confirms
  const personalBests = createPersonalBests();
  let recapSession: object = {};
  const input = new GameInput(canvas);
  // ---- the controller (game/gamepad.ts): menus by focus navigation, the game through GameInput.frame, aim assist on
  // the same hitboxes the shots use, the contextual interact / reload button and slot cycling read the match
  const padnav = createPadNav(gamepads);
  // (aboard a vehicle the interact button is the way out: the prompt is the vehicle's own panel)
  input.interactAvailable = () => !!render?.hud.interact || (!!cm && cm.pred.st === PS.Ride);
  input.riding = () => !!cm && cm.pred.st === PS.Ride;
  input.swimming = () => !!cm && cm.pred.st === PS.Ground && cm.pred.swim;
  input.passenger = () => !!cm && cm.pred.st === PS.Ride && cm.pred.seat > 0 && cm.pred.veh >= 0 && cm.vehs.list[cm.pred.veh]?.kind === VKind.Heli;
  input.flying = () => !!cm && cm.pred.st === PS.Ride && cm.pred.seat === 0 && cm.pred.veh >= 0 && cm.vehs.list[cm.pred.veh]?.kind === VKind.Heli;
  // my helicopter is off its skids (my prediction steps it): the pilot then holds interact to bail out
  input.airborne = () => !!cm && cm.pred.st === PS.Ride && cm.pred.veh >= 0 && cm.vehs.list[cm.pred.veh]?.air === true;
  input.slotFilled = (i) => !!cm && cm.pred.slots[i]?.kind !== SK.Empty;
  input.aimAssist = createAimAssist(() => cm);
  // (perf: while the island streams in, reserve stand-ins for the point lights the streamed POIs will add)
  const lights = createLightBalancer(engine.scene, engine.streaming ? 2 : 0); lights.update();
  engine.onPointLight((root) => lights.track(root));
  const warmer = createGpuWarmer(engine.renderer, engine.scene); let warmReady = false;
  // kong pool: a match needs 49 other kongs + the victory-cam one. They are created once behind the loading screen and
  // handed back after each match (creating them at match start cost a ~55 ms frame).
  const kongPool: KongActor[][] = [[], [], [], [], [], []];
  const takeKong: Kits["createKong"] = async (ctx, o) => {
    const v = ((o?.variant ?? 0) % 6 + 6) % 6;
    if (o?.lod !== "lo" && o?.lod !== "hi") { const a = kongPool[v].pop(); if (a) { a.setVisible(true); return a; } }
    return createKong(ctx, o);
  };
  const releaseKong = (a: KongActor, variant: number) => { a.setVisible(false); a.object.removeFromParent(); kongPool[((variant % 6) + 6) % 6].push(a); };
  const kits: Kits = { createKong: takeKong, releaseKong, createGlider, plane, weapons, viewModel: viewModel as unknown as Kits["viewModel"], fx, audio, storm, hud, lights };
  hud.el && ui.appendChild(hud.el); hud.setVisible(false);
  // the inventory screen (Tab): drag to reorder, drag off the panel to drop
  const inv = createInventory();
  ui.appendChild(inv.el);
  inv.onMove = (a, b) => { if (cm?.inventoryOp(INV.Move, a, b)) audio.play("ui:click", { volume: 0.6 }); };
  inv.onDrop = (a) => { if (cm?.inventoryOp(INV.Drop, a)) audio.play("ui:click", { volume: 0.6 }); };
  // (Toon inventory) Equip: the slot the hands want, as a slot key would; the panel's close button closes as Tab does
  inv.onEquip = (i) => { input.slotWanted = i; audio.play("ui:click", { volume: 0.6 }); };
  inv.onClose = () => setInvOpen(false);
  // (economy) the Banana Stand buy menu: a purchase is a request (INV.Buy); the server decides
  const shop = createShop();
  ui.appendChild(shop.el);
  shop.onBuy = (offer) => { if (cm && shop.stand >= 0 && cm.inventoryOp(INV.Buy, shop.stand, offer)) audio.play("pickup:weapon", { volume: 0.7 }); };
  ui.appendChild(results.el);

  // ---- lobby state
  const url = new URL(location.href);
  const joinCode = (flag("join") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || null;
  // (admin lobby) a player link `?e=CODE`: the event lobby screen instead of the title lobby ("" = not a valid code: the
  // screen says the lobby isn't open)
  const eventRaw = flag(EVENT_PARAM);
  const eventCode = eventRaw === null ? null : EVENT_CODE_RE.test(eventRaw.trim().toUpperCase()) ? eventRaw.trim().toUpperCase() : "";
  // this browser's player session token (sent with every join; an event lobby knows a returning / kicked player by it)
  const playerTok = (() => {
    let t: string | null = null;
    try { t = localStorage.getItem("kr-player-tok"); } catch { /* private mode */ }
    if (t && PLAYER_TOKEN_RE.test(t)) return t;
    t = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem("kr-player-tok", t); } catch { /* private mode: this page keeps it in memory */ }
    return t;
  })();
  // practice bots: EASY unless the player picked another tier on this device
  let botDifficulty: BotDifficulty = "easy";
  try { const stored = localStorage.getItem("kr-bot-difficulty"); if (stored === "standard" || stored === "hard") botDifficulty = stored; } catch { /* private mode */ }
  const lobbyState: LobbyState & EventLobbyState = { code: null, inviteUrl: null, mode: "solo", players: [], meId: 0, isHost: false, busy: false, error: null, offline: false, capacity: 50, invite: eventCode !== null ? null : joinCode, difficulty: botDifficulty, event: null, ended: null };
  let link: Link | null = null, cm: ClientMatch | null = null, render: GameRender | null = null, myUid = 0;
  let inMatch = false, paused = false;
  // a session = one connect / practice / leave. Every async step re-checks its generation: a later choice (or LEAVE)
  // supersedes an earlier one still waiting on the island or the server. Its timers die with it.
  let sessionGeneration = 0, victoryTimer = 0, streamTimer = 0;
  /** online: back in the friend room while the room's match still runs — its traffic is ignored until the next one */
  let staleMatch = false;
  function nextSessionGeneration() { return ++sessionGeneration; }
  function clearSessionTimers() { clearTimeout(victoryTimer); clearInterval(streamTimer); victoryTimer = 0; streamTimer = 0; }
  // ?ws=ws://host:port/ws (tools): a private game server instead of the page's own /ws
  const wsParam = flag("ws");
  const wsUrl = wsParam && /^wss?:\/\/[^\s]+$/.test(wsParam) ? wsParam : (url.protocol === "https:" ? "wss://" : "ws://") + url.host + ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/") + "ws";

  // first-session controls coach (warm-up / firing range; F1 skips) and what it observes
  const coach = createControlCoach(); ui.appendChild(coach.el);
  const coachObserver = createCoachObserver();
  // the game's own full screen is asked for ON the PLAY / FIRING RANGE / CREATE / JOIN click (a user
  // gesture lasts ~5 s: asked again at match start, after the island prepared or the host pressed START, it was refused)
  const fsOnPlay = () => input.autoFullscreen();
  const actions: LobbyActions = {
    skipCoach() { coach.skip(); },
    replayCoach() { coach.replay(); coachObserver.reset(); },
    setName(name) { link?.sendJSON({ t: "hello", name }); },
    async create(mode) { fsOnPlay(); const generation = nextSessionGeneration(); await prepareIsland(); if (generation !== sessionGeneration || !await online(generation)) return; link?.sendJSON({ t: "hello", name: lobby.name }); link?.sendJSON({ t: "create", mode }); },
    async join(code) { lobbyState.ended = null; fsOnPlay(); const generation = nextSessionGeneration(); await prepareIsland(); if (generation !== sessionGeneration || !await online(generation)) return; link?.sendJSON({ t: "hello", name: lobby.name }); link?.sendJSON({ t: "join", code, tok: playerTok }); },
    setMode(mode) { lobbyState.mode = mode; link?.sendJSON({ t: "mode", mode }); },
    start() { link?.sendJSON({ t: "start", mode: lobbyState.mode }); },
    practice(mode, difficulty) { fsOnPlay(); void offline(mode, false, difficulty ?? botDifficulty); },
    setDifficulty(difficulty) { botDifficulty = difficulty; lobbyState.difficulty = difficulty; try { localStorage.setItem("kr-bot-difficulty", difficulty); } catch { /* private mode */ } lobby.update(lobbyState); },
    range() { fsOnPlay(); offline("solo", true); },
    leave() { leaveAll(); },
    pickTeam(team) { link?.sendJSON({ t: "team", team }); },
  };
  const lobby = eventCode !== null ? createEventLobby(actions, eventCode) : createLobby(actions);
  ui.appendChild(lobby.el);
  lobby.update(lobbyState);

  // ---- title scene: standing on the Lookout Point cliffs at the island's south-west, a hero kong
  // on the right third, the island + volcano beyond, the BANANA CO. plane crossing the sky with gliders peeling off.
  gameStage("kits:title", 0.19);
  const title = createTitleScene(engine, plane, kits);
  gameStage("kits:wire", 0.2);
  // the BANANA CO. blimp: drifts round the island in the title, the warm-up and every match
  const blimp = createBlimp(); engine.scene.add(blimp.object);
  // (caster) ?caster / ?cast=CODE: this tab is a commentator seat (client/src/caster) — its own lobby card instead of the
  // player's, its own camera / desk / autopilot once a match runs
  const casterMode = flag("caster") !== null || flag("cast") !== null;
  let caster: CasterApp | null = null;
  if (casterMode) {
    lobby.setVisible(false); lobby.el.style.display = "none";
    caster = createCasterApp({ engine, world, kits, hud, title, input, ui, wsUrl, prepareIsland, worldHash: worldHashV, terrainHash: terrainData().hash });
  }

  // ---- preferences (settings/preferences.ts, the SETTINGS menu's CONTROLS / AUDIO tabs): input subscribes itself; the
  // field of view belongs to the display (engine/display.ts publishes "display:fov")
  preferences.subscribe((p) => { audio.setMaster(p.master); audio.setDynamicRange?.(p.dynamicRange); audio.setMix?.({ combat: p.combat, ui: p.ui, ambience: p.ambience }); audio.radio?.setVolume(p.radio); });
  const currentFov = () => (engine.shared.get("display:fov") as number | undefined) ?? 72;

  function setBusy(b: boolean, err: string | null = null) { lobbyState.busy = b; lobbyState.error = err; lobby.update(lobbyState); }
  /** connect for this session; false when it failed or a newer session superseded it while connecting */
  async function online(generation: number) {
    if (link && !link.offline) return true;
    setBusy(true);
    try {
      const old = link; link = null;
      if (old) { old.onClose = () => {}; old.close(); }
      const connected = await connectWs(wsUrl);
      if (generation !== sessionGeneration) { connected.close(); return false; }
      link = connected; wire(link);
      lobbyState.offline = false; setBusy(false); return true;
    } catch {
      if (generation !== sessionGeneration) return false;
      setBusy(false, "NO SERVER — start `npm run server` or play PRACTICE"); link = null; return false;
    }
  }
  // (perf) a match never starts on a half-built island: while the world still streams in after the title, the first
  // PRACTICE / CREATE / JOIN finishes it at full speed behind a "preparing" card (main.ts __kr.prepare)
  // a session asked for before main.ts marks the title ready (Enter, a controller's A or a focused button behind the
  // loading screen) waits for it: wiring a GameRender before the prefabs exist throws and strands the match scope
  async function prepareIsland(): Promise<void> {
    while (document.documentElement.dataset.ready !== "1") await new Promise((done) => setTimeout(done, 100));
    const p = (window as unknown as { __kr: { prepare?: () => Promise<void> } }).__kr.prepare;
    if (p) await p();
  }
  async function offline(mode: Mode, range = false, difficulty: BotDifficulty = botDifficulty) {
    const generation = nextSessionGeneration();
    await prepareIsland();
    if (generation !== sessionGeneration) return;
    // the loot spots: if the click beat their idle build, finish it in 12 ms slices here — the host's
    // placeLoot would otherwise run the rest as ONE 2-3 s synchronous task (a frozen frame at match start)
    if (!range) await lootSpotsIdle(world, () => new Promise<void>((r) => setTimeout(r, 0)), 12);
    if (generation !== sessionGeneration) return;
    leaveAll();
    // the bots' tier (EASY = 10% damage, accurate only within ~8 m) is the Match's to apply
    botDifficulty = difficulty; lobbyState.difficulty = difficulty;
    const l = new OfflineLink(world, lobby.name, 1, Infinity, range, difficulty); link = l; wire(l);
    lobbyState.offline = true; lobbyState.mode = mode; myUid = 1;
    l.sendJSON({ t: "hello", name: lobby.name }); l.sendJSON({ t: "practice", mode });
    setTimeout(() => l.sendJSON({ t: "start", mode }), 50);
  }
  /** (voice) squad comms (client/src/voice): one per ONLINE link, kept across that room's matches (the mic stays ready) */
  let voice: SquadVoice | null = null, voiceLink: Link | null = null;
  function wire(l: Link) {
    clearSessionTimers();
    if (l.offline) { voice?.dispose(); voice = null; voiceLink = null; }
    else if (voiceLink !== l) { voice?.dispose(); voice = createSquadVoice(l, ui); voiceLink = l; }
    render?.dispose();
    cm = new ClientMatch(world, l);
    render = new GameRender(engine, cm, kits, input);
    render.myName = lobby.name; render.fovBase = currentFov();
    render.onEliminated = () => showResults(false);
    render.onShop = (stand) => setShopOpen(true, stand);
    // four seconds of the victory shot (your kong, confetti, the island) before the results card covers it
    { const r = render; render.onVictory = () => { victoryTimer = window.setTimeout(() => { if (render === r && inMatch) showResults(true); }, 4000); }; }
    // a replaced link's late messages / close never reach the current session
    l.onJSON = (m) => { if (link === l) onJSON(m); };
    // at the title nothing is lost, but the dead link must go, or the next CREATE / JOIN reuses it and sends nothing
    l.onClose = (reason) => { if (link !== l) return; if (inMatch || lobbyState.code) linkLost(l, reason); else link = null; };
  }
  function onJSON(m: Record<string, unknown>) {
    if (reconnect && (m.t === "lobby" || m.t === "match")) stopReconnect();   // back in: the room or our seat answered
    if (staleMatch && (m.t === "phase" || m.t === "result")) return;
    if ((m.t === "rtc" || m.t === "voiceroster") && voice?.onJSON(m)) return;
    if (m.t === "result") {
      const state = m.state as OutcomeState | undefined;
      if (!cm || !render || !state || state.pid !== cm.me || !completedResult(state)) return;
      resultOutcome = state; resultTotalSquads = state.totalSquads;
      resultRecap(); // (saved even when the card was dismissed for SPECTATE)
      // confirm an open card in place; a loss the events missed opens it; a win keeps its 4 s victory shot first
      if (!resultDismissed && (resultsOpen || !state.winner)) showResults(state.winner, resultsOpen);
      return;
    }
    if (m.t === "welcome") {
      myUid = m.uid as number; lobbyState.meId = myUid;
      // the server simulates on its own copy of the island: a different terrain = prediction + hit-reg drift. Refuse.
      // …and the WHOLE static world (POI boxes, trunks, rocks), not just the ground: one changed collider = ghost hits
      const th = m.terrain as number | undefined, mine = terrainData().hash, wh = m.world as number | undefined;
      if ((th !== undefined && mine !== undefined && th !== mine) || (wh !== undefined && wh !== worldHashV) || (m.net !== undefined && m.net !== NET_VERSION)) {
        console.warn(`world mismatch: server terrain ${th} world ${wh} (${m.boxes} boxes) vs client terrain ${mine} world ${worldHashV} (${worldBoxes.length} boxes)`);
        leaveAll(); setBusy(false, "GAME UPDATED — RELOAD THE PAGE"); return;
      }
    }
    else if (m.t === "lobby") {
      const players = m.players as Array<{ id: number; name: string; squad: number; pid: number; host: boolean }>;
      lobbyState.code = m.code as string; lobbyState.mode = m.mode as Mode; lobbyState.isHost = (m.host as number) === myUid;
      lobbyState.inviteUrl = link?.offline ? null : `${location.origin}${location.pathname}?join=${lobbyState.code}`;
      lobbyState.players = players.map((p) => ({ id: p.id, name: p.name, bot: false, host: p.host, squad: p.squad, ready: true }));
      lobbyState.matchRunning = m.inMatch === true && !inMatch;
      lobbyState.casters = Array.isArray(m.casters) ? m.casters.length : 0;
      lobbyState.event = m.ev && typeof m.ev === "object" && Array.isArray((m.ev as EventRoom).players) ? m.ev as EventRoom : null;
      if (staleMatch && m.inMatch === false && link) { staleMatch = false; render?.dispose(); wire(link); }
      lobbyState.busy = false; lobbyState.error = null; lobbyState.invite = null; lobby.update(lobbyState);
      if (cm && render) for (const p of players) if (p.pid >= 0) { cm.names[p.pid] = p.name; render.names[p.pid] = p.name; }
      // the match is over (results done / crash): everyone goes back to the room
      // (practice: the results card stays up for PLAY AGAIN / BACK TO LOBBY)
      if (inMatch && m.inMatch === false && !(link?.offline && resultsOpen)) exitToRoom();
    } else if (m.t === "error") {
      setBusy(false, String(m.msg));
      // a refused re-join (the lobby is gone / locked / full) gets no room frame after it: stop trying
      if (reconnect) { const r = reconnect, msg = String(m.msg); clearTimeout(r.timer); r.timer = window.setTimeout(() => { if (reconnect === r) reconnectGiveUp(msg); }, 1500); }
      // (AFK) the server gave our seat to a bot for inactivity and kept us in the room: show the room
      else if (m.afk === true && inMatch && link && !link.offline && lobbyState.code) backToRoom();
    }
    // (admin lobby) out of the event lobby for good: the server closes the socket next (no "connection lost" after this)
    else if (m.t === "evend") {
      const why: EventEndReason = m.why === "kicked" || m.why === "replaced" ? m.why : "closed";
      lobbyState.ended = { why, msg: typeof m.msg === "string" ? m.msg.slice(0, 200) : "" };
      leaveAll();
    }
    else if (m.t === "match") {
      if (staleMatch && link) { staleMatch = false; render?.dispose(); wire(link); }
      if (!cm || !render) return;
      resultOutcome = null; resultDismissed = false; recapSession = {};
      coachObserver.reset(); coach.resetProgress();
      resultTotalSquads = Array.isArray(m.teams) ? new Set((m.teams as unknown[]).filter((t): t is number => Number.isInteger(t) && (t as number) >= 0)).size || null : null;
      // online: tell the server whether this tab still streams the island in — it holds the warm-up (≤ 40 s) for us
      if (link && !link.offline) {
        const kr = (window as unknown as { __kr: Record<string, unknown> }).__kr, l = link;
        l.sendJSON({ t: "stream", done: kr.streamed !== false });
        if (kr.streamed === false) { const iv = streamTimer = window.setInterval(() => { if (kr.streamed !== false || link !== l) { window.clearInterval(iv); if (link === l) l.sendJSON({ t: "stream", done: true }); } }, 250); }
      }
      const seed = m.seed as number;
      // the firing range has no island loot: its rack arrives in m.items
      const range = m.range === true;
      // the host's chest list (the loot generator) — placeLoot only for an old host that does not send it
      const rows = m.chests as number[][] | undefined;
      const loot: { chests: Chest[]; items: Item[] } = range ? { chests: [], items: [] }
        : rows ? { chests: rows.map((r) => ({ id: r[0], x: r[1], y: r[2], z: r[3], yaw: r[4], rarity: r[5], opened: false, poi: r[6], box: r[7] ? 1 : 0 })), items: [] }
        : placeLoot(seed, world);
      cm.chests = loot.chests;
      cm.items.clear();
      cm.range = range; cm.pred.infAmmo = range; render.setRange(range);
      (m as { myUid?: number }).myUid = myUid;
      if (m.names) { cm.names = (m.names as string[]).slice(); render.names = cm.names; }
      cm.onJSON(m);
      // late-join item list is authoritative; a fresh start has every floor item untaken
      if (!(m.items as unknown[])?.length) for (const it of loot.items) { const c: Item = { ...it }; cm.items.set(c.id, c); }
      if (m.teams) cm.pred.team = (m.teams as number[])[cm.me] ?? 0;
      voice?.setMe(cm.me);
      void render.buildChests();
      void render.prewarmActors();
      enterMatch(cm, render);
    } else if (m.t === "mark") { render?.squadMark(m); }   // a squadmate's marker
    else if (m.t === "phase") { cm?.onJSON(m); if ((m.phase as number) === 3 && resultsOpen) showResults(render?.placement === 1, true);
      // out and spectating (the card was put away for SPECTATE) when the match ends: the winners' moment on the
      // camera (the server points it at them), then the results card comes back — never just a frozen feed
      else if ((m.phase as number) === 3 && resultDismissed && render) { const r = render; clearTimeout(victoryTimer); victoryTimer = window.setTimeout(() => { if (render === r && inMatch && !resultsOpen) showResults(false); }, 4500); }
      if ((m.phase as number) === 0 && inMatch) { results.hide(); resultsOpen = false; hud.setVisible(true); } }
  }
  function enterMatch(c: ClientMatch, r: GameRender) {
    inMatch = true; input.inMatch = true; resultsOpen = false; paused = false; input.clearHeld();
    // a focused menu field (the callsign) must not keep the keyboard once the lobby is gone
    if (lobby.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    lobby.setVisible(false); hud.setVisible(true); results.hide(); title.setVisible(false);
    void audio.unlock(); input.fsRestore = false; input.autoFullscreen(); void input.lock(true);
    r.phase(c.phase);
  }
  /** match over → the lobby room (same link, same lobby): a fresh ClientMatch + renderer for the next START */
  function exitToRoom() {
    if (!link) return;
    clearSessionTimers(); input.clearHeld();
    inMatch = false; input.inMatch = false; input.unlock(); resultsOpen = false; paused = false; hidePause(); setInvOpen(false); setShopOpen(false);
    hud.setVisible(false); hud.setMapOpen(false); results.hide(); lobby.setVisible(true); title.setVisible(true);
    render?.dispose(); cm = null; render = null; audio.endSession?.();
    voice?.endMatch();
    wire(link);
    storm.set({ cx: 0, cz: 0, r: 5000, tx: 0, tz: 0, tr: 5000, shrinking: false, phase: 0 });
    lobby.update(lobbyState);
  }
  /** back to the title: detach the link first (its close / late messages must not re-enter), then reset every bit of
   *  session state so the next PRACTICE / CREATE / JOIN starts clean */
  function leaveAll() {
    stopReconnect();
    nextSessionGeneration(); input.fsRestore = false;
    const old = link; link = null;
    if (old) { old.onClose = () => {}; old.onJSON = () => {}; old.onBinary = () => {}; old.sendJSON({ t: "leave" }); old.close(); }
    clearSessionTimers(); input.clearHeld(); staleMatch = false;
    inMatch = false; input.inMatch = false; input.unlock(); resultsOpen = false; paused = false; hidePause(); setInvOpen(false); setShopOpen(false);
    hud.setVisible(false); hud.setMapOpen(false); results.hide(); lobby.setVisible(true); title.setVisible(true);
    render?.dispose(); audio.endSession?.();
    voice?.dispose(); voice = null; voiceLink = null;
    cm = null; render = null; lobbyState.matchRunning = false; lobbyState.event = null;
    lobbyState.code = null; lobbyState.inviteUrl = null; lobbyState.players = []; lobbyState.meId = 0; lobbyState.isHost = false; lobbyState.offline = false; lobbyState.startingIn = null; lobbyState.invite = null; setBusy(false);
    storm.set({ cx: 0, cz: 0, r: 5000, tx: 0, tz: 0, tr: 5000, shrinking: false, phase: 0 });
  }
  /** online BACK TO LOBBY: back to the friend room on the same connection — never out of it. The others may still be
   *  playing: this tab ignores the rest of that match (START waits for it) and joins the room's next one. */
  function backToRoom() {
    if (!link) return;
    exitToRoom();
    if (!link) return;
    staleMatch = true; link.onBinary = () => {};
    lobbyState.matchRunning = true; lobby.update(lobbyState);
  }
  // ---- an EVENT lobby reconnects by itself. When its link drops on its own (not kicked / closed /
  // replaced: those end with `evend` first and detach the link; not LEAVE), connect again and re-join the same code with
  // the same session token, with backoff, for up to RECONNECT_MS. The server puts us back in the room (team kept) or,
  // mid-match, back in our own seat (server/index.ts Lobby.join: the "match" frame follows, as for a late joiner).
  // Meanwhile a match stays on screen, frozen, under a "reconnecting" card; the room says so in its status. Then the JOIN
  // screen, with a clear message. Other lobbies (?join=, practice) close to the title.
  const RECONNECT_MS = 60_000, RECONNECT_WAITS = [300, 1000, 2000, 3000, 5000];
  let reconnect: { code: string; until: number; tries: number; timer: number; card: boolean } | null = null;
  const reconnectCard = document.createElement("div"); reconnectCard.className = "kr-reconnect"; reconnectCard.setAttribute("role", "status");
  reconnectCard.style.cssText = "position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:25;display:none;padding:12px 26px;border-radius:10px;background:rgba(6,18,28,.9);border:2px solid #ffd400;color:#f6efc6;font:800 24px 'Barlow Condensed',sans-serif;letter-spacing:2px;text-align:center;pointer-events:none;white-space:nowrap";
  ui.appendChild(reconnectCard);
  function reconnectPaint() {
    const r = reconnect;
    lobbyState.reconnecting = !!r;
    reconnectCard.style.display = r?.card ? "block" : "none";
    if (r) reconnectCard.textContent = `CONNECTION LOST · RECONNECTING…${r.tries > 1 ? ` (TRY ${r.tries})` : ""}`;
  }
  function stopReconnect() { if (!reconnect) return; clearTimeout(reconnect.timer); reconnect = null; reconnectPaint(); }
  /** the link closed by itself: an event lobby tries to get back in; anything else goes back to the title */
  function linkLost(l: Link, reason: string) {
    if (eventCode === null || l.offline || !lobbyState.code || lobbyState.ended) { leaveAll(); setBusy(false, reason.toUpperCase()); return; }
    link = null; l.onClose = () => {}; l.onJSON = () => {};   // (dead: nothing late from it reaches the game)
    voice?.dispose(); voice = null; voiceLink = null;
    reconnect ??= { code: lobbyState.code, until: performance.now() + RECONNECT_MS, tries: 0, timer: 0, card: inMatch };
    reconnectLater(nextSessionGeneration());
  }
  function reconnectLater(generation: number) {
    const r = reconnect; if (!r) return;
    clearTimeout(r.timer);
    const wait = RECONNECT_WAITS[Math.min(r.tries, RECONNECT_WAITS.length - 1)];
    if (performance.now() + wait > r.until) { reconnectGiveUp("COULDN'T RECONNECT"); return; }
    r.timer = window.setTimeout(() => void reconnectTry(generation), wait);
    lobbyState.busy = true; reconnectPaint(); lobby.update(lobbyState);
  }
  async function reconnectTry(generation: number) {
    const r = reconnect; if (!r || generation !== sessionGeneration) return;
    r.tries++; reconnectPaint();
    let l: Link;
    try { l = await connectWs(wsUrl, 5000); } catch { if (reconnect === r && generation === sessionGeneration) reconnectLater(generation); return; }
    if (reconnect !== r || generation !== sessionGeneration) { l.close(); return; }
    // a fresh ClientMatch + renderer on the new link (the frozen match goes; the card stays up until the server answers)
    link = l; staleMatch = false;
    exitToRoom();
    l.sendJSON({ t: "hello", name: lobby.name }); l.sendJSON({ t: "join", code: r.code, tok: playerTok });
    // no answer at all (a half-open path): drop this try and go again
    r.timer = window.setTimeout(() => { if (reconnect === r && link === l) { link = null; l.onClose = () => {}; l.onJSON = () => {}; l.close(); reconnectLater(generation); } }, 8000);
  }
  function reconnectGiveUp(msg: string) { stopReconnect(); leaveAll(); setBusy(false, msg); }
  /** the results card. Placement / stats / time come from the host's confirmed outcome when it has arrived (the card
   *  opens on the elimination event and refreshes in place — preserveFocus — when the confirmation or the end lands) */
  /** this device's personal bests for the confirmed outcome (undefined until the host confirmed it, and in the range) */
  function resultRecap() {
    const state = resultOutcome, time = state?.outcomeTime;
    if (!cm || cm.range || !state || typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 86400) return undefined;
    const opponent = link?.offline ? botDifficulty : "friends";
    return personalBests.recap({ mode: cm.mode, opponent }, { placement: state.placement, totalSquads: state.totalSquads, kills: state.kills, damage: Math.round(state.damage), survivedS: Math.floor(time) }, recapSession);
  }
  function showResults(win: boolean, preserveFocus = false) {
    if (!cm || !render || (resultsOpen && !preserveFocus)) return;
    const r = render, c = cm;
    win = resultOutcome?.winner ?? win;
    const placement = resultOutcome?.placement || r.placement || (win ? 1 : c.squads + 1);
    resultsOpen = true; paused = false; input.clearHeld(); hidePause(); hud.setMapOpen(false); setInvOpen(false); setShopOpen(false);
    r.muteAnnounce = true; r.hud.announce = null;
    const t = resultOutcome?.outcomeTime;
    const survivedS = typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= 86400 ? t : null;
    const kills = resultOutcome?.kills ?? r.kills, damage = Math.round(resultOutcome?.damage ?? r.damage);
    const totalSquads = resultTotalSquads ?? Math.max(r.totalSquads, placement);
    const recap = resultRecap();
    results.show({ recap, placement, totalSquads, kills, damage, survivedS, winner: win, squadNames: r.hud.squad.map((s) => s.name), killedBy: r.killedBy, death: r.deathSummary, mode: c.mode, stats: { headshots: r.headshots, chests: r.chestsOpened } },
      { // practice: a fresh match through the usual island prepare + warm-up
        playAgain: link?.offline ? () => { void offline(c.mode, c.range, botDifficulty); } : undefined,
        spectate: !win && c.phase !== 3 ? () => { if (render !== r) return; resultDismissed = true; results.hide(); resultsOpen = false; r.muteAnnounce = false; void input.lock(); } : undefined,
        backToLobby: () => { if (link && !link.offline && lobbyState.code) backToRoom(); else leaveAll(); } }, preserveFocus);
    input.unlock();
  }

  // ---- keys: map, pause
  let resultsOpen = false;
  /** only live gameplay moves, aims or fires: never behind the map, the inventory, pause, results or the video menu */
  const videoMenuOpen = () => !!document.querySelector(".kr-video.on");
  input.gameplayAllowed = () => inMatch && !paused && !resultsOpen && !hud.mapOpen && !inv.open && !shop.open && !videoMenuOpen() && !spectating();
  // ---- spectating: out for good and watching someone. The cursor is free (the bar's ◀ ▶ and the
  // player list are clicked; a drag on the game looks around, the wheel zooms); ← / → (and the strafe keys) cycle,
  // Tab (the inventory key) opens the list, Esc closes it. The server checks every pick (shared/sim/match.ts).
  function spectating() { return inMatch && !!cm && !!render && render.spec.active(cm); }
  function specCycle(dir: -1 | 1) {
    if (!cm || !render) return;
    const id = render.spec.cycle(cm, dir); hud.spectateFlash?.(dir);
    if (id >= 0) { cm.spectateTo(id); audio.play("ui:click", { volume: 0.45 }); }
  }
  function specList(open: boolean) { if (!render || render.spec.listOpen === open) return; render.spec.listOpen = open; audio.play("ui:click", { volume: 0.35 }); }
  hud.onSpectate = (a) => {
    if (!spectating() || !cm || !render) return;
    if (a.t === "prev" || a.t === "next") specCycle(a.t === "prev" ? -1 : 1);
    else if (a.t === "list") specList(a.open);
    else if (a.t === "pick" && render.spec.canWatch(cm, a.id)) { cm.spectateTo(a.id); specList(false); }
  };
  { let drag = false;
    input.canvas.addEventListener("mousedown", (e) => { if (spectating() && !paused && !resultsOpen && (e.button === 0 || e.button === 2)) { drag = true; input.canvas.style.cursor = "grabbing"; } });
    addEventListener("mouseup", () => { if (drag) { drag = false; input.canvas.style.cursor = ""; } });
    addEventListener("mousemove", (e) => { if (drag && spectating()) render?.specOrbit(e.movementX, e.movementY); });
    input.canvas.addEventListener("wheel", (e) => { if (spectating() && !paused) { render?.specZoom(e.deltaY); e.preventDefault(); } }, { passive: false }); }
  /** behind the open map / inventory you keep running (keyboard movement + sprint only) */
  input.moveAllowed = () => inMatch && !paused && !resultsOpen && (hud.mapOpen || inv.open) && !shop.open && !videoMenuOpen();
  /** (economy) the buy menu needs the cursor, like the inventory */
  /** health + shield while the buy menu is open (a drop = taking damage: the menu closes); `shopStorm` = how much HP the
   *  storm may have drained since the last drop (its known rate — storm ticks never close the stand) */
  let shopHs = 0, shopShield = 0, shopStorm = 0;
  function setShopOpen(open: boolean, stand = -1) {
    if (open === shop.open && (!open || stand === shop.stand)) return;
    if (open && cm) { shopHs = cm.pred.hp + cm.pred.shield; shopShield = cm.pred.shield; shopStorm = 0; }
    if (open) { hud.setMapOpen(false); setInvOpen(false); }
    shop.setOpen(open, stand); input.clearHeld();
    if (open && cm && render) shop.update(render.shopView());
    if (open) { input.unlock(); audio.play("chest:open", { volume: 0.35 }); } else if (inMatch && !paused && !resultsOpen && !hud.mapOpen && !inv.open) void input.lock();
  }
  /** the map needs the cursor (click to pin): open frees the pointer, close takes it back */
  function setMapOpen(open: boolean) {
    hud.setMapOpen(open); input.clearHeld(true);
    if (open) input.unlock(); else if (inMatch && !paused && !resultsOpen && !inv.open) void input.lock();
  }
  /** the map key / button: open (closing the inventory) or close */
  function toggleMap() {
    if (hud.mapOpen) setMapOpen(false);
    else { hud.setMapOpen(true); setInvOpen(false); input.clearHeld(true); input.unlock(); }
  }
  /** the inventory key / button opens AND closes the inventory */
  function toggleInventory() {
    if (inv.open) setInvOpen(false);
    else { hud.setMapOpen(false); setInvOpen(true); }
  }
  /** Esc / the menu button peels one layer at a time: inventory → map → pause */
  function escapeLayer() {
    if (shop.open) { setShopOpen(false); return; }
    if (inv.open) { if (!inv.cancel()) setInvOpen(false); return; }
    if (hud.mapOpen) { setMapOpen(false); return; }
    if (paused && menu.back()) return;   // the Leave confirm closes first (back to the menu)
    paused = !paused; input.clearHeld(); if (paused) { input.unlock(); showPause(); } else { hidePause(); void input.lock(); }
  }
  const footKey = (code: string) => (Object.keys(preferences.value.binds) as BindAction[]).some((a) => !RIDE_BINDS.includes(a) && preferences.value.binds[a].includes(code));
  input.onKey = (code) => {
    // F1 skips the warm-up coach on foot (in a seat F1 is a seat key; a rebind that puts an on-foot action on F1 wins)
    if (code === "F1" && inMatch && cm?.pred.st !== PS.Ride && !footKey(code)) { coach.skip(); return true; }
    if (!inMatch) return false;
    // spectating: cycle / the player list (before the inventory key, which is Tab too)
    if (spectating() && !paused && !resultsOpen && !videoMenuOpen() && !hud.mapOpen) {
      if (code === "Escape" && render!.spec.listOpen) { specList(false); return true; }
      if (code === "Tab" || input.matches("inventory", code)) { specList(!render!.spec.listOpen); return true; }
      if (code === "ArrowLeft" || input.matches("left", code)) { specCycle(-1); return true; }
      if (code === "ArrowRight" || input.matches("right", code)) { specCycle(1); return true; }
    }
    // tuk-tuk: the view key swaps the driver's view (behind it ↔ from the saddle)
    if (input.matches("rideView", code) && !paused && !resultsOpen && cm?.pred.st === PS.Ride) { render?.toggleRideView(); return true; }
    if (input.matches("map", code) && !paused && !resultsOpen && !videoMenuOpen()) { toggleMap(); return true; }
    // the inventory key (Tab) opens AND closes the inventory; Esc closes it too
    if (input.matches("inventory", code) && !paused && !resultsOpen && !videoMenuOpen()) { toggleInventory(); return true; }
    if (inv.open && inv.key(code)) return true;
    // (economy) the buy menu: 1-7 buy, the interact key leaves
    if (shop.open) { const n = /^Digit([1-9])$/.exec(code); if (n) { shop.key(+n[1]); return true; } if (input.matches("use", code)) { setShopOpen(false); return true; } }
    if (code === "Escape") {
      if (resultsOpen) return false;
      escapeLayer();
      return true;
    }
    return false;
  };
  // pointer left the game (alt-tab, Esc under pointer lock): show the pause card, never leave the match
  // (on the controller the pointer is never needed: losing it pauses nothing)
  input.onLockChange = (locked) => { if (inMatch && !locked && !device.pad && !paused && !resultsOpen && !hud.mapOpen && !inv.open && !shop.open && !spectating()) { paused = true; showPause(); } };
  /** the inventory needs the cursor: open frees the pointer, close takes it back (the Tab keydown is the user gesture) */
  function setInvOpen(open: boolean) {
    if (open === inv.open) return;
    if (!open && inv.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    inv.setOpen(open); input.clearHeld(true);
    if (open) input.unlock(); else if (inMatch && !paused && !resultsOpen && !hud.mapOpen) void input.lock();
  }
  // the in-match menu: a left sidebar over the still-running game (ui/match-menu.ts). Nothing pauses:
  // online or offline the match keeps running ("MATCH CONTINUES"); `paused` only means the menu is up (no gameplay input)
  const krw = window as unknown as { __kr?: { videoMenu?: { open(): void }; kongbot?: { open(): void } } };
  const menu = createMatchMenu(ui, {
    context: () => ({
      eyebrow: render?.range ? "FIRING RANGE" : `${link?.offline ? "PRACTICE · " : ""}${cm?.mode === "trios" ? "TRIOS" : "SOLO"}${spectating() ? " · SPECTATING" : ""}`,
      range: !!render?.range, analyticsShown: !!render?.range?.statsShown, coach: coach.showing, offline: link ? !!link.offline : !reconnect,
    }),
    // RESUME after the browser took Esc out of the game's full screen: the click puts the full
    // screen back too, like the click on the game after a menu closed
    resume: () => { paused = false; hidePause(); if (input.fsRestore) { input.fsRestore = false; void input.fullscreen(); } void input.lock(); },
    settings: () => { const v = krw.__kr?.videoMenu; if (v) v.open(); else lobby.el.querySelector<HTMLButtonElement>(".kr-video-gear")?.click(); },
    // firing range: the practice analytics (gun stats, aimed range, last hit / kill) open in the PRACTICE widget
    toggleAnalytics: () => { render?.range?.toggleStats(); },
    skipCoach: () => { coach.skip(); },
    canReport: () => !!krw.__kr?.kongbot,
    report: () => { const k = krw.__kr?.kongbot; if (!k) return false; k.open(); return true; },
    leave: () => { paused = false; hidePause(); leaveAll(); },
  });
  const pause = menu.el;
  // the game's own full screen: a toggle on the title + the pause card; when the browser ends it on its
  // own (an Esc it kept — no Keyboard Lock on an http:// page or in Firefox / Safari) the game reacts as to that Esc:
  // the open menu closes (live gameplay already paused on losing the mouse) and the way back is offered
  const fsUi = createFullscreenUi(input, lobby.el, pause);
  input.onFullscreenLost = (escHeld) => {
    if (escHeld || !inMatch) return;   // (a 2 s Esc hold under Keyboard Lock: the game already had that Esc)
    if (resultsOpen) { fsUi.lost("key"); return; }
    // the Esc was meant for the open menu: it closes, the mouse stays free, and the next click on the game takes the
    // mouse back AND restores the full screen (one click, no hunting for a button). In live play the same Esc freed the
    // mouse: the pause card's RESUME puts both back
    input.fsRestore = true;
    const menu = shop.open || inv.open || hud.mapOpen;
    if (shop.open) setShopOpen(false); else if (inv.open) setInvOpen(false); else if (hud.mapOpen) setMapOpen(false);
    fsUi.lost(!menu && (paused || input.locked) ? "resume" : "click");
  };
  // RESUME is always live (no "RESUME IN Ns" countdown): a click inside the browser's ~1 s quiet interval
  // after Esc waits it out inside input.lock() and captures then; a refusal brings this menu back for one more click
  const showPause = () => { input.clearHeld(); menu.show(); };
  const hidePause = () => { menu.hide(); };

  // ---- controller routing: a menu layer gets focus navigation; the open map / inventory get their own controls;
  // live gameplay reads the pad in GameInput.frame. MENU always means Esc (and opens SETTINGS on the title).
  const padTook = (a: PadAction) => preferences.value.pad.binds[a].some((b) => gamepads.pressed[b]);
  function settingsLayer(video: HTMLElement): PadLayer | null {
    if (video.dataset.padCapture) return null;   // the CONTROLLER tab is listening for a button to bind
    const tabs = () => [...video.querySelectorAll<HTMLButtonElement>(".preference-tabs button")];
    return {
      root: video,
      tab: (d) => { const list = tabs(), i = list.findIndex((b) => b.getAttribute("aria-pressed") === "true"); const next = list[(i + d + list.length) % list.length]; next?.click(); next?.focus(); },
      button: (b) => { if (b !== PB.MENU) return false; video.querySelector<HTMLButtonElement>(".close")?.click(); return true; },
      first: () => video.querySelector<HTMLElement>(".preference-tabs button[aria-pressed=true]"),
    };
  }
  function padLayer(): PadLayer | null {
    const video = document.querySelector<HTMLElement>(".kr-video.on");
    if (video) return settingsLayer(video);
    // the onboarding guide, or the ?diag send sheet and crash prompt (playtest/report.ts): a dialog whose .close button is B
    const guide = document.querySelector<HTMLElement>(".kr-guide:not([hidden]), .kd-sheet:not([hidden]), .kd-card");
    if (guide) return { root: guide, back: () => guide.querySelector<HTMLButtonElement>(".close")?.click() };
    if (inMatch) {
      if (resultsOpen) return { root: results.el, back: () => {}, noBack: true };
      if (paused) return { root: pause, first: () => menu.first(), button: (b) => { if (b !== PB.MENU) return false; escapeLayer(); return true; } };
      return null;
    }
    return {
      root: lobby.el, first: () => lobby.padFirst?.() ?? lobby.el.querySelector<HTMLElement>(".kr-btn.play:not([disabled]), .room .kr-btn:not(.kr-hide)"),
      button: (b) => { if (b !== PB.MENU) return false; lobby.el.querySelector<HTMLButtonElement>(".kr-video-gear")?.click(); return true; },
      back: () => { if (lobby.padBack) { lobby.padBack(); return; } const f = lobby.el.querySelector<HTMLDetailsElement>("details[open]"); if (f) { f.open = false; f.querySelector("summary")?.focus(); } },
      hints: [[PB.MENU, "SETTINGS"]],
    };
  }
  // a press on the controller is no "user gesture" to the browser: sound may stay off until one click / key press. Try
  // anyway (it works where the site may autoplay), and say so once if it did not.
  let soundOk = false, soundNoticeShown = false, soundTryAt = -1e9;
  function padUnlockAudio() {
    if (soundOk || performance.now() - soundTryAt < 2000) return;
    soundTryAt = performance.now();
    void audio.unlock().then(() => setTimeout(() => {
      const state = (audio as { stats?: () => { state: string } }).stats?.().state;
      if (!state || state === "running") { soundOk = true; return; }
      if (!soundNoticeShown) { soundNoticeShown = true; padnav.toast("SOUND STARTS AFTER ONE <b>CLICK</b> OR <b>KEY PRESS</b> — A BROWSER RULE FOR CONTROLLERS", 7000); }
    }, 400));
  }
  function routePad(dt: number) {
    if (gamepads.anyPressed()) padUnlockAudio();
    const layer = padLayer();
    padnav.update(layer, dt);
    if (layer || !inMatch || !gamepads.connected) return;
    const g = gamepads;
    if (g.pressed[PB.MENU]) { if (!resultsOpen) escapeLayer(); return; }
    if (resultsOpen || paused) return;
    // spectating on the controller: d-pad / bumpers cycle, the inventory button opens the list
    // (B closes it), the right stick looks around
    if (spectating() && !hud.mapOpen && render) {
      if (g.pressed[PB.LEFT] || g.pressed[PB.LB]) specCycle(-1);
      if (g.pressed[PB.RIGHT] || g.pressed[PB.RB]) specCycle(1);
      if (padTook("inventory")) specList(!render.spec.listOpen);
      else if (g.pressed[PB.B] && render.spec.listOpen) specList(false);
      const look = preferences.value.pad.swapSticks ? g.left : g.right;
      if (Math.hypot(look.x, look.y) > 0.18) render.specOrbit(look.x * 900 * dt, look.y * 700 * dt);
      if (padTook("map")) toggleMap();
      return;
    }
    if (hud.mapOpen) {
      if (g.pressed[PB.B] || padTook("map")) { setMapOpen(false); return; }
      const pad = preferences.value.pad, move = pad.swapSticks ? g.right : g.left, look = pad.swapSticks ? g.left : g.right;
      hud.mapPad?.(dt, { mx: move.x, my: move.y, px: look.x, py: look.y, zoom: g.rt - g.lt, place: g.pressed[PB.A], clear: g.pressed[PB.X] || g.pressed[PB.Y] });
      return;
    }
    if (shop.open) {
      if (g.pressed[PB.B] || padTook("interact")) { setShopOpen(false); return; }
      if (g.pressed[PB.LEFT]) shop.padMove(-1, 0); if (g.pressed[PB.RIGHT]) shop.padMove(1, 0);
      if (g.pressed[PB.UP]) shop.padMove(0, -1); if (g.pressed[PB.DOWN]) shop.padMove(0, 1);
      if (g.pressed[PB.A]) shop.padSelect();
      return;
    }
    if (inv.open) {
      if (g.pressed[PB.B]) { if (!inv.padCancel()) setInvOpen(false); return; }
      if (padTook("inventory")) { setInvOpen(false); return; }
      if (g.pressed[PB.LEFT] || g.pressed[PB.LB]) inv.padMove(-1);
      if (g.pressed[PB.RIGHT] || g.pressed[PB.RB]) inv.padMove(1);
      if (g.pressed[PB.A]) inv.padSelect();
      if (g.pressed[PB.X]) inv.padDrop();
      if (g.pressed[PB.Y]) inv.padEquip();
      return;
    }
    if (!input.gameplayAllowed()) return;
    // tuk-tuk at the bars: the view button swaps behind it ↔ the saddle (input.poll keeps a shared slot button off the hands)
    if (cm?.pred.st === PS.Ride && cm.pred.seat === 0 && padTook("rideView")) render?.toggleRideView();
    // (no hard-wired right-stick view swap in the helicopter: the bindable rideView above serves the
    // tuk-tuk's bars and the helicopter's stick alike; the stick click is crouch / seat swap or the bomb in some layouts)
    if (padTook("map")) toggleMap();
    else if (padTook("inventory")) toggleInventory();
  }
  // plugging in / pulling out a controller: say so; losing the one in use mid-match pauses (it never keeps running blind)
  gamepads.onConnect = (name, family) => padnav.toast(`<b>${family === "playstation" ? "PLAYSTATION" : family === "nintendo" ? "NINTENDO" : "XBOX"}</b> CONTROLLER CONNECTED · ${name.toUpperCase().replace(/[&<>"]/g, "")}`);
  gamepads.onDisconnect = (_name, was) => {
    padnav.toast("CONTROLLER DISCONNECTED");
    if (was && inMatch && !paused && !resultsOpen) { if (inv.open) setInvOpen(false); if (hud.mapOpen) setMapOpen(false); paused = true; input.clearHeld(); showPause(); }
  };
  // keyboard & mouse picked up mid-match with the cursor still free: one click takes it (the game keeps running)
  const clickHint = document.createElement("div"); clickHint.className = "kr-clickhint"; clickHint.textContent = "CLICK TO AIM WITH THE MOUSE";
  clickHint.style.cssText = "position:fixed;left:50%;top:38%;transform:translateX(-50%);z-index:14;display:none;padding:10px 20px;border-radius:8px;background:rgba(6,18,28,.85);border:2px solid #ffd400;color:#f6efc6;font:800 22px 'Barlow Condensed',sans-serif;letter-spacing:2px;pointer-events:none";
  ui.appendChild(clickHint);
  let clickHintOn = false;
  const syncClickHint = () => { const on = inMatch && !device.pad && !input.locked && !input.capturing && input.gameplayAllowed(); if (on !== clickHintOn) { clickHintOn = on; clickHint.style.display = on ? "block" : "none"; } };

  // ---- frame loop
  let wasWatching = false;
  engine.onUpdate((dt, t) => {
    link?.pump?.();
    if (caster && !caster.active) caster.update(dt, t);   // (its link's pump + lobby; the title keeps drawing)
    gamepads.poll();
    routePad(dt);
    blimp.update(dt, t);
    if (caster?.active) caster.update(dt, t);
    else if (inMatch && cm && render) {
      // watching someone: the mouse is the cursor (a capture from the last life is let go once);
      // the player list closes when spectating ends
      const watching = spectating();
      if (watching && !wasWatching && input.locked) input.unlock();
      if (!watching && wasWatching) render.spec.listOpen = false;
      wasWatching = watching;
      const allowFire = input.engaged && input.gameplayAllowed() && cm.pred.st !== PS.Plane;
      input.frame(dt);
      cm.update(dt, input, allowFire);
      render.update(dt, t);
      // the coach: live in the warm-up and the firing range, on foot, with no screen open
      const p = cm.pred;
      const observed = coachObserver.observe({
        session: cm, reliable: true, active: !paused && !resultsOpen && !inv.open && !hud.mapOpen && p.hp > 0 && (p.st === PS.Ground || p.st === PS.Mantle) && (render.hud.phase === "warmup" || render.hud.range === true),
        dt, correction: cm.netStats.corrections, x: p.x, z: p.z, ground: p.st === PS.Ground, sliding: p.st === PS.Ground && p.mvT > 0, mantling: p.st === PS.Mantle,
        movementIntent: input.engaged && input.movementHeld(), interactIntent: input.engaged && input.interactHeld(), fireIntent: input.fire, aimIntent: input.scopeHeld,
        slots: p.slots, slot: p.active, hp: p.hp, shield: p.shield, reload: p.reloadT, use: p.useT, shot: p.shotSeq, mapPinned: !!render.hud.dropMarker, inventoryOpened: inv.open,
      });
      if (observed.reset) coach.resetProgress();
      coach.update(observed);
      if (inv.open) inv.update(render.hud.hotbar, cm.pred.active, cm.pred.ammo);
      // (economy) the buy menu follows the wallet; walking off / dying closes it
      if (shop.open) {
        const st = cm.stands[shop.stand], p = cm.pred, hs = p.hp + p.shield;
        // taking damage closes the stand at once. Not
        // the storm's own drain: it is steady and expected — closing on every storm tick would lock anyone
        // standing in the storm out of the stand, heals included. Only HP the storm's rate can't explain closes it
        const storming = !!cm.plan && inStorm(cm.storm, p.x, p.z);
        shopStorm = storming ? Math.min(shopStorm + cm.storm.dps * dt, cm.storm.dps * 1.5 + 1) : 0;
        const drop = shopHs - hs, stormTick = storming && p.shield >= shopShield - 0.01 && drop <= shopStorm + 1;
        if (drop > 0.5 && stormTick) shopStorm = Math.max(0, shopStorm - drop);
        if (drop > 0.5 && !stormTick) { setShopOpen(false); audio.play("hurt", { volume: 0.5 }); render.announce("UNDER FIRE", "the banana stand closed", "warn"); }
        else if (!st || p.hp <= 0 || p.st !== PS.Ground || Math.hypot(st.x - p.x, st.z - p.z) > 6.5) setShopOpen(false); else shop.update(render.shopView());
        shopHs = hs; shopShield = p.shield;
      }
    } else {
      coach.update({ active: false }); coachObserver.reset();
      title.update(dt, t);
      storm.update(dt, t, engine.camera);
      fx.update(dt);
      if (warmReady) warmer.tick();          // title / lobby / room: finish every driver first-use + texture upload
    }
    lights.update();
    syncClickHint();
  });
  storm.set({ cx: 0, cz: 0, r: 5000, tx: 0, tz: 0, tr: 5000, shrinking: false, phase: 0 });

  // ---- prewarm: every prefab a match can spawn, compiled + uploaded now (behind the loading screen), not mid-fight
  // (perf: the frame loop starts inside prewarm, AFTER the parallel compile of the whole scene — a frame drawn before it
  // compiled every visible program serially on first draw: seconds of onFirstUse stalls)
  await prewarm(engine, kits, title);
  // (perf: the title's warmer.tick uploads the remaining textures / first-uses programs one per frame — the old
  // synchronous flush cost 2-3 s of texSubImage2D behind the loading screen)
  warmReady = true;
  // every program the game uses was compiled + checked by the prewarm. From here on three must not ask the driver for
  // program info logs: getProgramInfoLog is a synchronous GPU-process round trip that waits for the (parallel) compile
  // and the lazily built ANGLE/Metal pipeline — 90-430 ms main-thread stalls at match start / plane entry.
  // A late shader error still reaches the console (the driver logs it). ?shadercheck=1 keeps them.
  if (!flag("shadercheck")) engine.renderer.debug.checkShaderErrors = false;
  gameStage("done", 1);
  releaseBoot();
  // (perf) the prefabs every match spawns: made + warmed in the title's idle time, never behind the loading screen
  if (DEFER_PREFABS) { const kr = (window as unknown as { __kr: Record<string, unknown> }).__kr; kr.prefabWarmP = (async () => {
    while (!kr.ready) await new Promise((r) => setTimeout(r, 100));
    if (!loadsLazily()) void loadHeli().catch((e) => console.error("[heli] model failed", e));
    if (!kits.viewModel) { const t = performance.now(); const vm = await weapons.createViewModel(); vm.object.visible = false; engine.camera.add(vm.object); kits.viewModel = vm; kr.viewModelMs = Math.round(performance.now() - t); }
    const lootRoot = await weapons.prepareLoot(() => new Promise<void>((r) => (kr.prepareUrgent ? setTimeout(r, 0) : requestAnimationFrame(() => setTimeout(r, 0)))));
    await prewarmPrefabs(engine, kits, () => inMatch, lootRoot); await prewarmMatch(engine, kits, title, () => inMatch); kr.warmDone = true; })(); }

  // the loot generator's spots (shared/sim/loot-spots.ts, ~1.5-2 s of probes on the static world) are
  // built in ≤ 6 ms idle slices once the title is ready, so an offline PRACTICE never waits for them (the host's Match
  // finishes a partial build in place if the click comes first)
  { const kr = (window as unknown as { __kr: Record<string, unknown> }).__kr; void (async () => {
    while (!kr.ready) await new Promise((r) => setTimeout(r, 100));
    const t = performance.now();
    const pause = () => new Promise<void>((r) => { const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o: { timeout: number }) => void }).requestIdleCallback; if (ric) ric(() => r(), { timeout: 50 }); else setTimeout(r, 0); });
    const set = await lootSpotsIdle(world, pause, 6);
    kr.lootSpots = { ms: set.ms, wall: Math.round(performance.now() - t), spots: set.spots.length };
  })(); }

  // debug / test handle (tools drive the game through this)
  (window as unknown as { __kr: Record<string, unknown> }).__kr.game = {
    input, lobby, hud, get cm() { return cm; }, get render() { return render; }, get link() { return link; }, get voice() { return voice; }, get inMatch() { return inMatch; },
    world,
    practice: (mode: Mode, difficulty?: BotDifficulty) => offline(mode, false, difficulty ?? botDifficulty), range: () => offline("solo", true), leave: leaveAll, actions, lobbyState: () => ({ ...lobbyState }), startNow: () => link?.sendJSON({ t: "start", mode: lobbyState.mode }),
    state: () => cm ? { phase: cm.phase, st: cm.pred.st, x: +cm.pred.x.toFixed(1), y: +cm.pred.y.toFixed(1), z: +cm.pred.z.toFixed(1), hp: cm.pred.hp, shield: cm.pred.shield, alive: cm.alive, squads: cm.squads, ping: Math.round(cm.ping), interp: +cm.interpTicks.toFixed(1), time: +cm.time.toFixed(1), storm: { ...cm.storm }, slots: cm.pred.slots.map((s) => `${s.kind}:${s.id}:${s.rarity}:${s.count}:${s.mag}`), active: cm.pred.active, kills: cm.pred.kills, actors: render?.actors.size, loot: render?.lootViews.size, chests: render?.chestViews.size, rejected: render?.rejected } : null,
  };
  void boot;
}

/** the kit FX, or — while the weapons fx module is missing — a small gameplay fallback so shots are never invisible */
function wrapFx(engine: Engine, kitFx: Fx, kit: { createRocket?: () => Promise<unknown> }): Fx {
  const fb = createFallbackFx(engine.scene);
  let live = false;
  void kit.createRocket?.().then((r) => { live = !!r; fb.object.visible = !live; }).catch(() => { /* keep the fallback */ });
  return {
    tracer: (a, b, w) => { if (live) kitFx.tracer(a, b, w); else fb.tracer(a, b, w); },
    impact: (p, n, s) => { if (live) kitFx.impact(p, n, s); else fb.impact(p, n, s); },
    shieldBreak: (p) => kitFx.shieldBreak?.(p),
    explosion: (p, r) => { if (live) kitFx.explosion(p, r); else fb.explosion(p, r); },
    puff: (p, k) => { if (live) kitFx.puff(p, k); else fb.puff(p, k); },
    update: (dt) => { kitFx.update(dt); if (!live) fb.update(dt); },
  };
}

/** boot progress for the loading screen + diagnosis (window.__kr.gameStage / gameProgress 0..1) */
function gameStage(name: string, p: number) {
  const kr = (window as unknown as { __kr?: Record<string, unknown> }).__kr;
  if (kr) { kr.gameProgress = p; kr.gameStage = name; (kr.gameStageAt as Record<string, number> | undefined) ?? (kr.gameStageAt = {}); (kr.gameStageAt as Record<string, number>)[name] = Math.round(performance.now()); }
}
/** perf: chests / loot / held weapons / glider / render prefabs are prewarmed after the title is ready
 * (prewarmPrefabs) — ?prewarm=full builds them all before ready instead */
const DEFER_PREFABS = flag("prewarm") !== "full";
/** scene roots whose content the loading frames never draw (storm, weapon FX, loot beams, the FX fallback): with
 *  DEFER_PREFABS their programs compile after ready (prewarmMatch), not behind the loading screen */
const MATCH_ONLY_ROOTS = new Set(["storm", "weapons-fx", "loot-system", "fx-fallback"]);

/** after the title is ready: make every spawnable prefab (chests of every rarity, opened; every weapon × rarity as loot
 * and held; consumables; ammo; glider; render prefabs) one at a time, then compile them in parallel and draw them ONCE
 * into an offscreen target on a private layer (never on screen, no shadows): programs, first use, textures, buffers.
 * Stops as soon as a match starts (the match then makes what it needs on demand). Nothing is disposed. */
async function prewarmPrefabs(engine: Engine, kits: Kits, isBusy: () => boolean, lootRoot: THREE.Object3D) {
  const t0 = performance.now();
  const kr = (window as unknown as { __kr: Record<string, unknown> }).__kr;
  kr.prefabWarm = "make";
  const LAYER = 29;
  // one prefab per idle frame in the title; back to back once a match is waiting for it (main.ts __kr.prepare)
  const idle = () => kr.prepareUrgent ? Promise.resolve() : new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const g = new THREE.Group(); g.name = "prewarm-prefabs";
  g.visible = true;
  // far below the island: the chest burst lights and any stray pixel stay out of every real view
  g.position.set(engine.camera.position.x, -3000, engine.camera.position.z);
  engine.scene.add(g);
  let n = 0;
  const put = (o: THREE.Object3D) => { o.position.set((n % 8) * 1.4 - 5, Math.floor(n / 8) * 1.4 - 4, 0); n++; g.add(o); };
  const chests: Array<{ open(): void; object: THREE.Object3D; update?(dt: number, t: number): void }> = [];
  const makers: Array<() => Promise<unknown>> = [];
  for (const r of RARITIES) makers.push(() => kits.weapons.createChest(r).then((v) => { put(v.object); chests.push(v as typeof chests[number]); }));
  for (const w of WEAPONS) for (const r of RARITIES) { makers.push(() => kits.weapons.createLoot(w, r).then((v) => put(v.object))); makers.push(() => kits.weapons.createHeldWeapon(w, r).then((o) => put(o))); }
  for (const c of CONSUMABLES) makers.push(() => kits.weapons.createLoot(c, "rare").then((v) => put(v.object)));
  makers.push(() => kits.weapons.createLoot("ammo", "common").then((v) => put(v.object)));
  makers.push(() => kits.createGlider(engine).then((gl) => put(gl.object)));
  makers.push(async () => { if (!loadsLazily()) await loadHeli().catch((e) => console.error("[heli] model failed", e)); for (const o of renderPrefabs()) put(o); });
  for (const mk of makers) {
    if (isBusy()) { kr.prefabWarm = "stopped (match)"; return; }
    try { await mk(); } catch (e) { console.warn("[prewarm] prefab", e); }
    await idle();
  }
  // private layer, no shadows (never shown again: nothing to restore), everything drawable
  g.traverse((o) => { o.visible = true; o.frustumCulled = false; o.layers.set(LAYER); o.castShadow = false; o.userData.castShadow = false; });
  for (const c of chests) { c.open(); c.update?.(0.3, 0); kits.lights?.track(c.object); }
  // the chest pool lights joined on layer 0 (the balancer counts them; far below the island they light nothing)
  kits.lights?.update();
  (engine.shared.get("atmos") as { sweep?: () => number } | undefined)?.sweep?.();
  if (isBusy()) { kr.prefabWarm = "stopped (match)"; return; }
  kr.prefabWarm = "compile";
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  cam.position.set(g.position.x, g.position.y, g.position.z + 16); cam.lookAt(g.position); cam.updateMatrixWorld();
  cam.layers.set(LAYER);
  const r = engine.renderer;
  const rt = new THREE.WebGLRenderTarget(256, 256, { type: THREE.HalfFloatType });
  const list: THREE.Object3D[] = []; g.traverse((o) => list.push(o)); lootRoot.traverse((o) => list.push(o));
  const fake = { traverse(fn: (o: THREE.Object3D) => void) { for (const o of list) fn(o); }, traverseVisible() { /* lights: the scene's */ } } as unknown as THREE.Object3D;
  // the scene's lights must be seen by the private camera (their count is part of every program key)
  const lights: THREE.Light[] = []; engine.scene.traverse((o) => { if ((o as THREE.Light).isLight) lights.push(o as THREE.Light); });
  const prev = r.getRenderTarget();
  let compiled: Promise<unknown> = Promise.resolve();
  for (const l of lights) l.layers.enable(LAYER);
  r.setRenderTarget(rt);
  try { compiled = r.compileAsync(fake, cam, engine.scene); } catch (e) { console.warn("[prewarm] compile", e); }
  r.setRenderTarget(prev);
  for (const l of lights) l.layers.disable(LAYER);
  try { await compiled; } catch { /* the draw below compiles */ }
  if (isBusy()) { kr.prefabWarm = "stopped (match)"; rt.dispose(); return; }
  // one offscreen draw: first use, texture uploads, VAOs (the shadow maps are left alone)
  kr.prefabWarm = "draw";
  await idle();
  const lost = engine.contextLost;
  if (!lost) {
    const sm = r.shadowMap, au = sm.autoUpdate;
    for (const l of lights) l.layers.enable(LAYER);
    sm.autoUpdate = false;
    try { r.setRenderTarget(rt); r.render(engine.scene, cam); } catch (e) { console.warn("[prewarm] draw", e); }
    finally { r.setRenderTarget(prev); sm.autoUpdate = au; for (const l of lights) l.layers.disable(LAYER); }
  }
  rt.dispose();
  // hide (never dispose — a disposed material would compile again); the pool lights go back to the pool
  const pool: THREE.Object3D[] = []; g.traverse((o) => { if ((o as THREE.PointLight).isPointLight) pool.push(o); });
  for (const l of pool) l.removeFromParent();
  g.visible = false;
  kits.lights?.update();
  if (lost) { kr.prefabWarm = "stopped (context lost)"; return; }
  kr.prefabWarm = "done";
  kr.prefabWarmMs = Math.round(performance.now() - t0);
}

/** after the title is ready (DEFER_PREFABS): what the boot prewarm would do with real frames behind the loading
 * screen, as invisible excursion frames (engine.excursion: hooks + one offscreen draw from another viewpoint, camera
 * restored in the same task) — every viewmodel item, a look-around from every warm-up spawn, the jump plane's altitude,
 * and the 50-kong session pool drawn once at match distances holding every weapon. One step per idle frame in the
 * title; back to back while a match waits (__kr.prepare). Stops if a match starts anyway. */
async function prewarmMatch(engine: Engine, kits: Kits, title: TitleScene, isBusy: () => boolean) {
  const t0 = performance.now();
  const kr = (window as unknown as { __kr: Record<string, unknown> }).__kr;
  const idle = () => kr.prepareUrgent ? Promise.resolve() : new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const vm = kits.viewModel;
  const vmItems: Array<WeaponId | ConsumableId> = [...WEAPONS, ...CONSUMABLES];
  kr.matchWarm = "match-only";
  await Promise.all([engine.compileObjects(engine.scene.children.filter((o) => MATCH_ONLY_ROOTS.has(o.name))), kits.storm.compile(engine.renderer)]);
  if (isBusy()) return;
  kr.matchWarm = "viewmodel";
  for (const it of vmItems) { if (isBusy()) return; vm.equip(it, (CONSUMABLES as readonly string[]).includes(it) ? "rare" : "epic"); await idle(); }
  vm.equip(null);
  const excursion = (setup: (cam: THREE.PerspectiveCamera) => void, dt = 0) => {
    title.freeze = true;
    try { engine.excursion(setup, dt); } finally { title.freeze = false; }
  };
  // warm-up spawns: the LOD chunks / veg / props a spawn sees + the viewmodel cycling every item
  kr.matchWarm = "look-around";
  const wv = warmupViewpoints();
  let vi = 0;
  for (const [x, z] of wv.pts) {
    for (let h = 0; h < 2; h++) {
      if (isBusy()) return;
      vm.equip(vmItems[vi++ % vmItems.length], "epic");
      const was = vm.object.visible; vm.object.visible = true;
      excursion((cam) => { cam.position.set(x, Math.max(0, engine.terrain.height(x, z)) + 1.7, z); cam.rotation.set(-0.1, wv.yaw + (h / 2) * Math.PI * 2, 0, "YXZ"); cam.fov = 118; });
      vm.object.visible = was;
      await idle();
    }
  }
  vm.equip(null);
  // the jump plane's altitude (atmos cloud impostors for the high view)
  kr.matchWarm = "plane";
  for (let h = 0; h < 3; h++) {
    if (isBusy()) return;
    const a = (h / 3) * Math.PI * 2;
    excursion((cam) => { cam.position.set(Math.cos(a) * 900, PLANE_ALT, Math.sin(a) * 900); cam.rotation.set(-0.35, a + Math.PI / 2, 0, "YXZ"); cam.fov = 110; });
    await idle();
  }
  // the session kong pool: 50 match kongs, made a few per idle frame, drawn once (invisibly) at match distances holding
  // every weapon — the far-LOD weapon batches are built by that draw, patched, and drawn again with the final program
  kr.matchWarm = "kongs";
  const made: KongActor[] = [];
  for (let i = 0; i < 50; i += 5) {
    if (isBusy()) { made.forEach((a, k) => kits.releaseKong?.(a, k % 6)); return; }
    made.push(...await Promise.all(Array.from({ length: 5 }, (_, k) => createKong(engine, { variant: (i + k) % 6 }))));
    await idle();
  }
  {
    const wp = warmupViewpoints().pts[0] ?? [0, 1020];
    const ox = wp[0], oz = wp[1], oy = Math.max(0, engine.terrain.height(ox, oz)) + 1.7;
    const place = () => made.forEach((a, i) => {
      const d = [6, 14, 35, 70, 120][i % 5] + Math.floor(i / 5) * 3, s2 = ((i % 7) - 3) * 1.6;
      const x = ox + s2, z = oz - d;
      const kp: KongPose = { x, y: Math.max(0, engine.terrain.height(x, z)), z, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, state: i % 3 === 0 ? "move" : "idle", crouch: i % 4 === 1, sprint: false, weapon: WEAPONS[i % WEAPONS.length], fired: i % 2 === 0, reloading: false, hurt: false, team: i % 17, friendly: i % 3 === 0 };
      if (!a.object.parent) engine.scene.add(a.object);
      a.setVisible(true); a.apply(kp, 0.016);
    });
    const look = (cam: THREE.PerspectiveCamera) => { cam.position.set(ox, oy, oz); cam.rotation.set(-0.05, 0, 0, "YXZ"); cam.fov = 72; };
    // (perf) the pool's programs (every variant) compile in parallel first: the excursion draws below never compile
    await engine.compileObjects([...made.map((a) => a.object), (await kongManager(engine)).weaponWarm()]);
    if (isBusy()) { made.forEach((a, k) => kits.releaseKong?.(a, k % 6)); return; }
    // all in ONE task: no real title frame ever draws the pool
    place(); excursion(look, 0.1); excursion(look, 0.1);
    (engine.shared.get("atmos") as { sweep?: () => number } | undefined)?.sweep?.();
    patchTree(engine, engine.scene);
    excursion(look, 0.1);
    for (const a of made) a.setVisible(false);
  }
  const crowd = (await kongManager(engine)).warmBatches();
  patchTree(engine, crowd);
  await engine.compileObjects([crowd]);
  if (!isBusy()) engine.warmDraw([crowd]);
  made.forEach((a, i) => kits.releaseKong?.(a, i % 6));
  kits.lights?.update();
  kr.matchWarm = "done";
  kr.matchWarmMs = Math.round(performance.now() - t0);
}

/** instantiate one of everything a match spawns next to the title camera, compile it all (KHR_parallel_shader_compile
 * via compileAsync), then draw REAL frames with all of it in view (post chain, shadow cascades, opened chests, the jump
 * plane with its ramp down, every kong variant) so every program key the match will use exists — then HIDE it all.
 * Nothing is disposed: a disposed material releases its program and the next match would compile it again. */
async function prewarm(engine: Engine, kits: Kits, title: TitleScene) {
  const t0 = performance.now();
  gameStage("prewarm:assets", 0.2);
  const g = new THREE.Group(); g.name = "prewarm";
  const jobs: Array<Promise<unknown>> = [];
  const put = (o: THREE.Object3D, i: number) => { o.position.set((i % 8) * 1.2 - 4, Math.floor(i / 8) * 1.2, 0); g.add(o); };
  let n = 0;
  const chests: Array<{ open(): void; object: THREE.Object3D; update?(dt: number, t: number): void }> = [];
  // (perf: with DEFER_PREFABS the chests / loot / held weapons / glider / render prefabs are made and warmed AFTER the
  // title is ready — prewarmPrefabs(), offscreen, in idle time — instead of behind the loading screen)
  if (!DEFER_PREFABS) {
  for (const r of RARITIES) jobs.push(kits.weapons.createChest(r).then((v) => { put(v.object, n++); chests.push(v as typeof chests[number]); }));
  // every weapon in every rarity, held and as loot (the rarity accents are separate materials / programs)
  for (const w of WEAPONS) for (const r of RARITIES) { jobs.push(kits.weapons.createLoot(w, r).then((v) => put(v.object, n++))); jobs.push(kits.weapons.createHeldWeapon(w, r).then((o) => put(o, n++))); }
  for (const c of CONSUMABLES) jobs.push(kits.weapons.createLoot(c, "rare").then((v) => put(v.object, n++)));
  jobs.push(kits.weapons.createLoot("ammo", "common").then((v) => put(v.object, n++)));
  jobs.push(kits.createGlider(engine).then((gl) => put(gl.object, n++)));
  if (!loadsLazily()) await loadHeli().catch((e) => console.error("[heli] model failed", e));
  for (const o of renderPrefabs()) put(o, n++);
  }
  // one kong of every variant (team tints / outlines included), posed in a row
  // (perf: with DEFER_PREFABS the session kong pool is made + compiled + drawn after ready — prewarmMatch — instead)
  const kongs = DEFER_PREFABS ? [] : await Promise.all([0, 1, 2, 3, 4, 5].map((variant) => kits.createKong(engine, { variant })));
  await Promise.all(jobs);
  gameStage("prewarm:stage", 0.35);
  // the viewmodel: equip every weapon + consumable once so each model and material exists
  // (perf: deferred with the rest of the match warm-up → prewarmMatch() after the title is ready)
  if (!DEFER_PREFABS) {
  for (const w of WEAPONS) kits.viewModel.equip(w, "epic");
  for (const c of CONSUMABLES) kits.viewModel.equip(c, "rare");
  kits.viewModel.equip(null);
  }
  if (kits.viewModel) engine.camera.add(kits.viewModel.object);
  // storm: show a ring so its materials compile too
  if (!DEFER_PREFABS) kits.storm.set({ cx: 0, cz: 0, r: 900, tx: 0, tz: 0, tr: 700, shrinking: true, phase: 2 });
  // everything visible (hidden burst cones / lids / beams included) for the compile pass
  g.traverse((o) => { o.visible = true; o.frustumCulled = false; });
  title.update(0.016, 0);
  const cam = engine.camera;
  cam.updateMatrixWorld();
  const fwd = cam.getWorldDirection(new THREE.Vector3());
  g.position.copy(cam.position).addScaledVector(fwd, 12);
  g.quaternion.copy(cam.quaternion);
  engine.scene.add(g);
  kongs.forEach((kong, i) => {
    const kp: KongPose = { x: g.position.x + (i - 2.5) * 1.4, y: g.position.y - 1, z: g.position.z, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, state: "idle", crouch: false, sprint: false, weapon: WEAPONS[i % WEAPONS.length], fired: true, reloading: false, hurt: false, team: i, friendly: i % 2 === 0 };
    kong.apply(kp, 0.016); engine.scene.add(kong.object);
  });
  // the jump plane: 70 m ahead, ramp down, engines running, interior lit (it is culled above the title frame, so it
  // would otherwise first draw — and compile — the moment a match starts)
  const plane = kits.plane;
  const planePos = plane.object.position.clone(), planeRot = plane.object.rotation.clone(), planeVis = plane.object.visible;
  plane.object.position.copy(cam.position).addScaledVector(fwd, 70); plane.object.visible = true;
  plane.setRamp(1); plane.setEngines(true); plane.setGear(0); plane.update(0.016, 0);
  plane.object.traverse((o) => { o.frustumCulled = false; });
  // open every chest (light burst, sparkles, cone) — their pool lights are tracked by the balancer
  for (const c of chests) { c.open(); c.update?.(0.3, 0); kits.lights?.track(c.object); }
  // FX: one of each kind in view
  const P = new THREE.Vector3().copy(g.position), N = new THREE.Vector3(0, 1, 0);
  kits.fx.tracer(P, P.clone().add(new THREE.Vector3(3, 0, 0)), "ar");
  for (const s of ["wood", "metal", "stone", "sand", "grass", "water", "flesh"] as const) kits.fx.impact(P, N, s);
  kits.fx.explosion(P, 3); kits.fx.puff(P, "sand"); kits.fx.update(0.016);
  kits.lights?.update();
  // the atmos material patch (sun shadows, cloud shadows, aerial haze) must be on BEFORE compiling, or we compile keys
  // the game never draws with
  (engine.shared.get("atmos") as { sweep?: () => number } | undefined)?.sweep?.();
  // compile EVERYTHING (hidden world pieces too: distance-culled POIs like the lobby islet, LODs) with the program keys a
  // match really uses: the scene is drawn into the post chain's render target (no tone mapping / sRGB in the shader),
  // so compile against an offscreen target, not the screen. KHR_parallel_shader_compile keeps it off the main thread.
  // Everything below until the restore is SYNCHRONOUS: other systems (terrain / veg / POI LODs) toggle visibility in
  // their per-frame updates, so no frame may run while we have forced hidden things visible (restoring after an await
  // hid the terrain LOD nodes that had been selected meanwhile — a black title beach). compileAsync issues every program
  // synchronously and only waits for the parallel compile afterwards.
  gameStage("prewarm:compile", 0.45);
  const hidden: THREE.Object3D[] = [];
  engine.scene.traverse((o) => { if (!o.visible && !o.userData.krDummy) { hidden.push(o); o.visible = true; } });
  const deferred = DEFER_PREFABS ? engine.scene.children.filter((o) => MATCH_ONLY_ROOTS.has(o.name)) : [];
  const walk = (o: THREE.Object3D, fn: (o: THREE.Object3D) => void) => { if (deferred.includes(o)) return; fn(o); for (const c of o.children) walk(c, fn); };
  const titleScene = { traverse: (fn: (o: THREE.Object3D) => void) => walk(engine.scene, fn), traverseVisible() {} } as unknown as THREE.Object3D;
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  const prevRT = engine.renderer.getRenderTarget();
  engine.renderer.setRenderTarget(rt);
  let compiled: Promise<unknown> = Promise.resolve();
  try { compiled = engine.renderer.compileAsync(titleScene, cam, engine.scene); } catch { /* unsupported: the frames below compile */ }
  engine.renderer.setRenderTarget(prevRT);
  // (perf: textures upload on first draw behind the loading screen — the frames below — and the rest one per frame in
  // the title (warmer.tick); the synchronous upload of every scene texture here cost 2.2 s of texSubImage2D)
  // shadow DEPTH programs (alpha-tested foliage, skinned kongs, instanced props): compileAsync never makes them and the
  // sun cascades only draw casters near the camera, so the first jungle tree to enter a cascade mid-match compiled one.
  // Render the sun's shadow map once with every caster un-culled (still synchronous, still behind the loading screen).
  const sun = engine.shared.get("sun") as THREE.DirectionalLight | undefined;
  if (sun?.castShadow) {
    const unculled: THREE.Object3D[] = [];
    engine.scene.traverse((o) => { if (o.castShadow && o.frustumCulled) { unculled.push(o); o.frustumCulled = false; } });
    const sm = engine.renderer.shadowMap, au = sm.autoUpdate, nu = sm.needsUpdate;
    sm.needsUpdate = true; sun.shadow.needsUpdate = true;
    for (const o of deferred) o.visible = false;
    try { sm.render([sun], engine.scene, cam); } catch { /* the frames below compile */ }
    for (const o of deferred) o.visible = true;
    sm.autoUpdate = au; sm.needsUpdate = nu; sun.shadow.needsUpdate = true;
    for (const o of unculled) o.frustumCulled = true;
  }
  // (after the shadow pass: storm.compile compiles its own scene, which leaves three's render state without the sun's
  // shadow, so a shadow pass after it warmed depth programs without USE_SHADOWMAP that no real frame draws)
  if (!DEFER_PREFABS) compiled = Promise.all([compiled, kits.storm.compile(engine.renderer)]);
  for (const o of hidden) o.visible = false;
  gameStage("prewarm:compile-wait", 0.55);
  try { await compiled; } catch { /* the frames below compile */ }
  rt.dispose();
  gameStage("prewarm:frames", 0.6);
  engine.start();
  // real frames with the prefabs + plane in view: the true program keys (post chain target, shadow cascades, instancing,
  // skinning, the chest lights on), texture uploads, shadow depth programs
  const frames = (k: number) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r(0) : requestAnimationFrame(f)); requestAnimationFrame(f); });
  await frames(4);
  // a 360° look-around where the warm-up spawns (islet centre, eye height) with the viewmodel cycling every item: the
  // first draw of each LOD node / veg batch / POI chunk / viewmodel (VAO + buffer upload + the Metal pipeline ANGLE
  // builds lazily at first draw) happens here instead of in the first seconds of the match
  // (perf: DEFER_PREFABS → the look-around, the plane altitude and the kong pool run AFTER the title is ready as
  // invisible excursion frames — prewarmMatch() / engine.excursion — instead of real frames behind the loading screen)
  if (!DEFER_PREFABS) {
  gameStage("prewarm:look-around", 0.65);
  title.freeze = true;
  const islet = POIS.find((q) => q.id === "lobby-islet")!;
  const vmItems: Array<WeaponId | ConsumableId> = [...WEAPONS, ...CONSUMABLES];
  kits.viewModel.object.visible = true;
  void islet;
  // from every warm-up spawn spot (zone centres + corners), looking round: the LOD chunks / veg / props a spawn sees get
  // their first draw (buffer upload, VAO, the Metal pipeline for the REAL scene target) now, not in the first seconds of PRACTICE
  const wv = warmupViewpoints();
  let vi = 0;
  for (const [x, z] of wv.pts) {
    // (load time: 2 wide headings instead of 4 at 72° — the same ring of LOD chunks, half the boot frames)
    for (let h = 0; h < 2; h++) {
      cam.position.set(x, Math.max(0, engine.terrain.height(x, z)) + 1.7, z);
      cam.rotation.set(-0.1, wv.yaw + (h / 2) * Math.PI * 2, 0, "YXZ"); cam.fov = 118; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      kits.viewModel.equip(vmItems[vi++ % vmItems.length], "epic");
      await frames(1);
    }
  }
  for (let k = vi; k < vmItems.length; k++) { kits.viewModel.equip(vmItems[k], "epic"); await frames(1); }
  // …and from the jump plane's altitude: the atmos cloud impostors for the high view are built on the first frames up
  // there (otherwise a 0.3-0.65 s plane-entry hitch)
  kits.viewModel.object.visible = false;
  for (let h = 0; h < 3; h++) {
    const a = (h / 3) * Math.PI * 2;
    cam.position.set(Math.cos(a) * 900, PLANE_ALT, Math.sin(a) * 900);
    cam.rotation.set(-0.35, a + Math.PI / 2, 0, "YXZ"); cam.fov = 110; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    await frames(2);
  }
  kits.viewModel.object.visible = true;
  kits.viewModel.equip(null);
  title.freeze = false;
  gameStage("prewarm:kongs", 0.8);
  // the session kong pool: 50 match kongs made now (hidden), not at match start
  const made = await Promise.all(Array.from({ length: 50 }, (_, i) => createKong(engine, { variant: i % 6 })));
  // …and drawn once at match distances holding every weapon: far kongs switch to the lo / min LOD whose weapons are an
  // INSTANCED batch built on first use — its program compiled at match start (otherwise a 0.4-1 s PRACTICE freeze)
  {
    const fwd2 = cam.getWorldDirection(new THREE.Vector3()); fwd2.y = 0; fwd2.normalize();
    const side = new THREE.Vector3(-fwd2.z, 0, fwd2.x);
    made.forEach((a, i) => {
      const d = [6, 14, 35, 70, 120][i % 5] + Math.floor(i / 5) * 3, s2 = ((i % 7) - 3) * 1.6;
      const x = cam.position.x + fwd2.x * d + side.x * s2, z = cam.position.z + fwd2.z * d + side.z * s2;
      const kp: KongPose = { x, y: Math.max(0, engine.terrain.height(x, z)), z, yaw: Math.atan2(fwd2.x, fwd2.z), pitch: 0, vx: 0, vy: 0, vz: 0, state: i % 3 === 0 ? "move" : "idle", crouch: i % 4 === 1, sprint: false, weapon: WEAPONS[i % WEAPONS.length], fired: i % 2 === 0, reloading: false, hurt: false, team: i % 17, friendly: i % 3 === 0 };
      engine.scene.add(a.object); a.setVisible(true); a.apply(kp, 0.016);
    });
    await frames(3);
    // the far-LOD weapon batches were created by those frames — patch them (atmos) and draw again with the final program
    (engine.shared.get("atmos") as { sweep?: () => number } | undefined)?.sweep?.();
    patchTree(engine, engine.scene);
    await frames(2);
    for (const a of made) a.setVisible(false);
  }
  const crowd = (await kongManager(engine)).warmBatches();
  patchTree(engine, crowd);
  await engine.compileObjects([crowd]);
  engine.warmDraw([crowd]);
  made.forEach((a, i) => kits.releaseKong?.(a, i % 6));
  }
  // hide (never dispose) — programs stay cached for the whole session. The chest pool lights go back to the pool
  // (a light with no parent is free for the next chest that opens); the balancer keeps the light count constant.
  const pool: THREE.Object3D[] = []; g.traverse((o) => { if ((o as THREE.PointLight).isPointLight) pool.push(o); });
  for (const l of pool) l.removeFromParent();
  g.visible = false; for (const k of kongs) k.setVisible(false);
  if (kits.viewModel) kits.viewModel.object.visible = false;
  plane.object.position.copy(planePos); plane.object.rotation.copy(planeRot); plane.object.visible = planeVis;
  plane.setRamp(0.8);
  kits.lights?.update();
  kits.storm.set({ cx: 0, cz: 0, r: 5000, tx: 0, tz: 0, tr: 5000, shrinking: false, phase: 0 });
  await frames(2);
  gameStage("prewarm:first-use", 0.95);
  // FIRST USE of every program now: three asks the driver for a program's uniforms / attributes the first time it draws
  // with it — a synchronous GPU-process round trip that waits for everything queued before it. compileAsync only
  // compiles; programs first drawn in the match (far-LOD kongs, the islet's veg, rocks, loot) paid 0.1-0.6 s EACH at
  // match start. Ask now, behind the loading screen.
  // (perf: only programs whose parallel compile is already done — a not-ready one would block here; warmer.tick first-uses
  // the rest in the title without ever waiting)
  for (const q of (engine.renderer.info.programs ?? []) as unknown as Array<{ getUniforms?: () => unknown; getAttributes?: () => unknown; isReady?: () => boolean }>) {
    try { if (!q.isReady || q.isReady()) { q.getUniforms?.(); q.getAttributes?.(); } } catch { /* a program that failed to link reports it on its own */ }
  }
  (window as unknown as { __kr: Record<string, unknown> }).__kr.prewarmMs = Math.round(performance.now() - t0);
}
