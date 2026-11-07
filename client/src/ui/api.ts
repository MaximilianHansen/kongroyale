// UI CONTRACT (gameplay-internal). client/src/ui/** renders DOM; client/src/game/** feeds it plain state objects.
// The UI never talks to the network. Everything here is data in → pixels out.
//
// Timing: every `at` field is an EVENT KEY (the game uses performance.now() ms). The HUD never compares `at` with
// matchTime — it notices a new `at` value and animates that event on its own clock (the dt passed to update()).
// Fields marked "optional" are later UI additions; the HUD degrades gracefully when they are absent.
import type { ConsumableId, PoiId, Rarity, WeaponId } from "../../../shared/world/map";
import type { Terrain } from "../../../shared/world/terrain";
import type { BotDifficulty } from "../../../shared/sim/const";
import type { EventEndReason, EventRoom } from "../../../shared/net/event";

export type MatchPhase = "lobby" | "warmup" | "plane" | "drop" | "play" | "results";
export type Mode = "solo" | "trios";

export interface HotbarSlot { kind: "weapon" | "consumable" | "empty"; id: WeaponId | ConsumableId | null; rarity: Rarity; count: number;
  /** a mythic's own name (the inventory shows it instead of the gun's) */
  name?: string;
  /** a mythic's own signature colour — a small gem on its hotbar slot / inventory card (the slot itself
   *  wears the mythic tier's colour like any tier) */
  color?: string }

/** the medals a special kill earns (client/src/game/accolades.ts decides, ui/medals.ts shows them) */
export type AccoladeId = "roadkill" | "driveby" | "flyby" | "chopped" | "topbanana" | "headshot" | "longshot" | "bananasplit" | "wrecked" | "payback" | "double" | "triple" | "quad" | "rampage";

export interface SquadMate {
  name: string; x: number; z: number; alive: boolean; hp: number; shield: number; me: boolean;
  /** optional: knocked down (bleeding out) — row turns red */
  downed?: boolean;
  /** optional: seconds until this mate redeploys (resurgence) — row shows the countdown */
  redeploy?: number | null;
  /** optional: facing (same convention as HudState.yaw) — map markers become arrows */
  yaw?: number;
}

export interface HudState {
  phase: MatchPhase;
  /** optional — swimming: `air` 0..1 of breath left (the bubble meter shows while under water
   *  or refilling), `under` = diving, `low` = nearly out (the meter pulses red), `hint`: "surface" (the dive / climb-out
   *  keys) | "under" (up / down / swim where you look) | null — shown for a few seconds after you start swimming / dive */
  swim?: { air: number; under: boolean; low: boolean; hint: "surface" | "under" | null } | null;
  /** optional: the local kong's movement state allows weapon hands (on foot / zipline / mantle — not plane, freefall,
   *  glide or death); absent = derived from `phase` */
  handsVisible?: boolean;
  /** optional: firing range (no storm clock; warm-up wording replaced) */
  range?: boolean;
  mode: Mode;
  hp: number; shield: number;
  alive: number; squadsAlive: number;
  /** seconds until the wall starts moving (if !shrinking) or until it finishes (if shrinking) */
  stormTimer: number; stormShrinking: boolean; inStorm: boolean; stormPhase: number;
  /** optional: what the pill clock counts down to (PLANE DEPARTS, RAMP OPENS, AUTO JUMP, STORM CLOSES, STORM SHRINKING) */
  clockLabel?: string;
  /** warm-up only: the island stream's progress 0..1 while the warm-up waits for it (undefined = loaded) */
  islandLoad?: number;
  /** camera yaw radians, 0 = north (-Z), increasing counter-clockwise (three.js) */
  yaw: number;
  /** minimap / map data — world metres (x east, z south) */
  me: { x: number; z: number; alive: boolean };
  /** the storm wall NOW (purple outside it) */
  safe: { cx: number; cz: number; r: number };
  /** where the wall is going (white circle); null = same as safe */
  next: { cx: number; cz: number; r: number } | null;
  plane: { x0: number; z0: number; x1: number; z1: number } | null;
  dropMarker: { x: number; z: number } | null;
  squad: SquadMate[];
  ammo: { mag: number; reserve: number } | null;
  hotbar: HotbarSlot[]; activeSlot: number;
  reload: { t: number; total: number } | null;
  /** consumable use progress */
  using: { t: number; total: number; label: string } | null;
  killfeed: Array<{
    at: number; killer: string; victim: string; weapon: WeaponId | "storm" | "fall" | "unknown" | "banana-bomb"; meKiller: boolean; meVictim: boolean;
    /** optional: headshot kill — adds a headshot glyph */
    head?: boolean;
    /** optional: knock (resurgence, not final) vs final elimination — final kills get a skull */
    final?: boolean;
    /** optional: the kill was made with a MYTHIC — its name + colour ride as a tag after the gun */
    mythic?: { name: string; color: string };
  }>;
  /** hit markers to flash (consumed by the HUD: it keeps its own timers). Set a new `at` per hit. */
  hitMarker: {
    kind: "body" | "head" | "shield" | "break" | "kill"; at: number;
    /** optional: client-predicted hit not yet confirmed by the server → thin grey marker; when the confirmation
     *  arrives, send the same kind again with predicted false (same or new `at`) and it snaps to the full marker */
    predicted?: boolean;
  } | null;
  /** damage indicators; angle = relative bearing radians (0 = ahead, +ccw). The game may rewrite `angle` every frame
   *  (the arc keeps pointing at the source while you turn). Optional: `dmg` = the hit's damage (a
   *  bigger hit draws a bigger, stronger arc), `src` = who dealt it (repeated hits from one source refresh one arc
   *  instead of stacking), `x` / `z` = the source's world position (the game's own bookkeeping) */
  damageDirs: Array<{ at: number; angle: number; dmg?: number; src?: number; x?: number; z?: number }>;
  /** floating damage numbers projected to screen (0..1 fractions) — re-projected every frame while alive */
  damageNumbers: Array<{
    at: number; sx: number; sy: number; amount: number; kind: "body" | "head" | "shield" | "break" | "kill";
    /** optional: victim id — hits on the same target within 1 s stack into one growing total */
    target?: number;
    /** optional: client-predicted (grey) until the server confirms; the same `at` may change amount / kind / predicted */
    predicted?: boolean;
  }>;
  interact: {
    label: string; key: string;
    /** optional loot card: the item's id, "RARE · Close range", ammo type + reserve, "REPLACES SLOT 2 · <item>" /
     *  "TAKES SLOT 3", or why it cannot be taken (BACKPACK FULL — the key is hidden) */
    candidateId?: number; detail?: string; ammo?: string; change?: string; blocked?: string;
    /** optional: rarity of the item/chest — tints the prompt */
    rarity?: Rarity;
    /** optional: hold-to-interact progress 0..1 */
    hold?: number;
    /** optional: the action whose key the prompt shows (default: interact) — the crate wall is set down with fire */
    act?: "fire";
    /** optional: sit lower, clear of what you are facing (the Banana Stand's shopkeeper stands right under the crosshair) */
    low?: boolean;
  } | null;
  /** optional (economy): the wallet, the Banana Stands, my squad's bounty contract (the circle the target is
   *  in, seconds left, who) and the bounty ON my squad (seconds left, 0 = none) */
  econ?: { cash: number; stands: Array<{ x: number; z: number }>; bounty: { x: number; z: number; r: number; left: number; name: string } | null; hunted: number; gain?: { at: number; amount: number } } | null;
  /** optional: banana bombs carried + the throw key — the lethal chip by the hotbar (null = none) */
  lethal?: { count: number; key: string; cooking: boolean; /** the key-hint strip: 1 = a bomb in
   *  hand (HOLD to cook, RELEASE to throw), 2 = just picked bombs up (HOLD G to cook & throw), 0 / absent = none */ hint?: number } | null;
  /** optional: the last thing you picked up ("PICKED UP · X" for a moment); a new `at` per pickup */
  pickup?: { at: number; label: string } | null;
  announce: { at: number; title: string; sub?: string; kind: "info" | "warn" | "storm" | "kill" | "victory" } | null;
  /** optional: a location title — you just arrived at a named place; a new `at` per arrival. `first`:
   *  the first arrival there this match — the centre title; later arrivals (false) only name it by the minimap */
  place?: { at: number; name: string; sub: string; first?: boolean } | null;
  /** optional: the tuk-tuk radio's station banner — when you tune in (get in with it on,
   *  turn the dial) the station big + what is on air; a new song while you ride: the song line under a small station
   *  name (big = false). `at` (performance.now) changes = show it again */
  radio?: { at: number; station: string; line: string; kind: "song" | "dj" | "ad" | "off"; big: boolean } | null;
  /** optional: the named place you are in now (the label by the minimap), null = none */
  where?: string | null;
  /** optional: medals for my special kills, oldest first; a new `at` (rising) per medal — the medals of one
   *  kill share a moment and pop as one row */
  accolades?: Array<{ at: number; id: AccoladeId; sub: string }>;
  /** optional: squadmates' map markers, in their squad colours */
  squadMarks?: Array<{ x: number; z: number; color: string }>;
  /** resurgence: on, my redeploy countdown, kills final. optional `lives` = solo redeploys left (null/absent = squad rule) */
  resurgence: { on: boolean; countdown: number | null; final: boolean; lives?: number | null };
  scoped: boolean;
  /** optional: aiming down sights (any gun, not the scope): no crosshair — the sights are the aim point */
  ads?: boolean;
  spectating: string | null;
  /** optional: the spectator bar + player list while you watch someone (null / absent = not spectating) */
  spectate?: SpectateView | null;
  /** freefall / glide readout */
  air: { altitude: number; speed: number; mode: "freefall" | "glide"; /** hold-space-to-cut progress 0..1 (0 = not cutting) */ cut: number } | null;
  /** optional: falling off a ledge high enough to hurt — SPACE pulls the chute */
  chuteReady?: boolean;
  /** network readout (small, corner) */
  net: { ping: number; fps: number };
  matchTime: number;

  // ---- optional additions ----
  /** current weapon spread (degrees, half-angle) → crosshair bloom; absent = static per-weapon crosshair */
  spread?: number;
  /** vertical camera FOV in degrees (to convert spread to pixels); default 75 */
  fov?: number;
  /** my eliminations this match (elimination banner counter); absent = counted from the kill feed */
  kills?: number;
  /** optional (Toon HUD): the damage I have dealt this match (the match-stats chip; absent = no damage chip) */
  damage?: number;
  /** live plane position during the flight (map + minimap plane icon); absent = the icon rides the path by time */
  planePos?: { x: number; z: number } | null;
  /** plane flight progress 0..1 along `plane` (used when planePos is absent) */
  planeT?: number;
  /** sniper scope details: zoom factor, breath 0..1 (1 = full lungs), holding breath */
  scope?: { zoom?: number; breath?: number; holding?: boolean; range?: number } | null;
  /** seconds of the whole storm phase (fills the pill timer bar); absent = no bar */
  stormTotal?: number;
  /** freefall ceiling (m) for the altimeter scale; default 600 */
  airCeiling?: number;
  /** optional: squadmates as world-space tags (trios). sx/sy = screen fractions of the head point; `edge` = the point is
   * behind the camera or off screen (the HUD clamps the tag to the screen edge and points an arrow at it). */
  mates?: Array<{ name: string; sx: number; sy: number; edge: boolean; dist: number; state: "alive" | "air" | "redeploy"; hp: number; shield: number }>;
  /** optional: aboard a tuk-tuk — hull 0..1, speed (m/s), my seat (0 = at the bars), on fire, who is aboard (bit per seat) */
  vehicle?: { hull: number; speed: number; seat: number; burning: boolean; seats: number;
    /** what it is (shared/sim/vehicle.ts VKind: 0 tuk-tuk, 1 helicopter) */ kind: number;
    /** a helicopter: height over the ground (m), climb (m/s, + up), the rotor's spool 0..1 */ alt?: number; climb?: number; spool?: number;
    /** optional: the controls, shown over the panel for the first seconds aboard */ hint?: string;
    /** optional: the controls as [key, label, flags] chips over the panel; hintsOn = shown (false: faded out — except the
     * chips flagged 1 = keep; 2 = pulse, 4 = fills with `fill`, 8 = a warning: game/tuk-hud.ts CHIP) */ hints?: Array<[string, string, number?]>; hintsOn?: boolean;
    /** optional: how far a held chip (flag 4: the pilot's bail-out hold) is, 0..1 */ fill?: number;
    /** optional: the key per seat (shown beside its dot), the swap-seat key, the radio key ("" = none) */ keys?: { seat: [string, string, string]; swap: string; radio: string };
    /** optional: the radio — the station's name, null = switched off (undefined: no radio row); tuning = just changed */ radio?: string | null; tuning?: boolean } | null;
  /** optional: manning a helicopter's door gun (TOP BANANA, shared/sim/heli.ts): rounds left on the belt of beltMax,
   * barrel heat 0..1, overheated (it will not fire until it has cooled), barrel spin 0..1, and where its barrels point on
   * screen (fractions; null = behind the camera) — the panel replaces the ammo counter and the hotbar */
  gun?: { name: string; belt: number; beltMax: number; heat: number; lock: boolean; spin: number; pip: { sx: number; sy: number } | null } | null;
  /** optional: vehicles for the maps (world xz; `mine` = the one I ride, `wreck` = burnt out, `kind` as above) */
  vehicles?: Array<{ x: number; z: number; mine: boolean; wreck: boolean; yaw?: number; kind: number }>;
  /** optional: recent enemy gunfire within earshot (map + minimap red dots). a = 1 fresh → 0 faded out */
  shots?: Array<{ x: number; z: number; a: number }>;
}

/** what the spectator UI shows (client/src/ui/spectate.ts) */
export interface SpectateView {
  /** the kong being watched */
  id: number; name: string; team: number;
  /** a squadmate of mine (trios) */
  mate: boolean;
  /** exact health + shield (the watched kong always carries them), 0..100 each */
  hp: number; shield: number;
  /** what it holds (null = nothing / unknown) */
  held: { name: string; rarity: Rarity; kind: "weapon" | "item" } | null;
  /** eliminations this match (counted from the kill feed) */
  kills: number;
  /** standing in the storm */
  inStorm: boolean;
  /** it just went down: who got it ("" = the storm / a fall) — the camera moves on in a moment */
  down: { by: string } | null;
  /** 1-based place of the target in the cycle order, and how many can be watched */
  index: number; count: number;
  /** kongs / squads left, solo or trios */
  alive: number; squads: number; trios: boolean;
  /** a squadmate is still alive: only the squad can be watched */
  squadOnly: boolean;
  /** the full player list (Tab) is open */
  listOpen: boolean;
  /** every player (only filled while the list is open): alive first */
  list: Array<{ id: number; name: string; team: number; kills: number; alive: boolean; mate: boolean; watching: boolean; canWatch: boolean }>;
  /** key labels for the hints */
  keys: { prev: string; next: string; list: string };
}
/** what the spectator UI asks for */
export type SpectateAction = { t: "prev" } | { t: "next" } | { t: "pick"; id: number } | { t: "list"; open: boolean };

export interface Hud {
  el: HTMLElement;
  update(s: HudState, dt: number): void;
  setVisible(v: boolean): void;
  /** full-screen map (M) */
  setMapOpen(open: boolean): void;
  readonly mapOpen: boolean;
  /** player placed a drop marker on the map (world xz); right-click / second click on the marker clears it (null) */
  onMapClick: ((x: number, z: number) => void) | null;
  /** optional: called with null when the player removes the marker */
  onMapClear?: (() => void) | null;
  /** optional: replace an item icon with a custom render (e.g. a real 3D render of the weapon model) */
  setIconRenderer?(fn: IconRenderer | null): void;
  /** optional: one frame of controller input on the open map (reticle, pan, zoom, mark / remove) */
  mapPad?(dt: number, c: import("./bigmap").MapPad): void;
  /** optional: the spectator bar's arrows / the player list were clicked */
  onSpectate?: ((a: SpectateAction) => void) | null;
  /** optional: a key cycled the watched player — the matching arrow dips like a click */
  spectateFlash?(dir: -1 | 1): void;
}

/** returns a square canvas/image (transparent background) for an item, or null to keep the built-in icon */
export type IconRenderer = (id: WeaponId | ConsumableId, rarity: Rarity, sizePx: number) => HTMLCanvasElement | HTMLImageElement | null | Promise<HTMLCanvasElement | HTMLImageElement | null>;

/** practice bots: EASY · STANDARD (full-strength bots) · HARD */
export type { BotDifficulty } from "../../../shared/sim/const";

export interface LobbyPlayer { id: number; name: string; bot: boolean; host: boolean; squad: number; ready: boolean }
export interface LobbyState {
  code: string | null; inviteUrl: string | null; mode: Mode; players: LobbyPlayer[]; meId: number; isHost: boolean;
  /** true while connecting / joining */
  busy: boolean; error: string | null; offline: boolean;
  /** optional: match size bots fill up to (default 50) */
  capacity?: number;
  /** optional: the host was removed for inactivity, so a guest's START takes the host role (server Lobby.claimHost) */
  hostAway?: boolean;
  /** optional: seconds until the match starts (host pressed START) */
  startingIn?: number | null;
  /** optional: lobby code from an invite link (?join=CODE) — the home screen offers JOIN LOBBY after a callsign */
  invite?: string | null;
  /** optional: the room's match is still running (you went back to the room early): START waits for it to end */
  matchRunning?: boolean;
  /** optional: the practice bots' difficulty (remembered on this device) */
  difficulty?: BotDifficulty;
  /** optional (caster): commentator seats watching this lobby (client/src/caster) */
  casters?: number;
  /** optional (admin lobby): the event room (`lobby.ev`) while in an event lobby, else null */
  event?: EventRoom | null;
  /** optional (admin lobby): this tab is out of its event lobby for good (`evend`: kicked / closed / replaced) */
  ended?: { why: EventEndReason; msg: string } | null;
}
export interface LobbyActions {
  setName(name: string): void;
  create(mode: Mode): void;
  join(code: string): void;
  setMode(mode: Mode): void;
  start(): void;
  /** offline practice vs bots (runs the sim in-browser) */
  practice(mode: Mode, difficulty?: BotDifficulty): void;
  setDifficulty?(difficulty: BotDifficulty): void;
  /** the controls coach: replay it from the start / skip it for good */
  replayCoach?(): void;
  skipCoach?(): void;
  /** offline firing range: every item on a rack, infinite ammo, respawning targets at marked distances */
  range(): void;
  leave(): void;
  /** optional (admin lobby): pick a TRIOS team in an event lobby (0-based; −1 = no team, auto-placed at START) */
  pickTeam?(team: number): void;
}
export interface LobbyScreen {
  el: HTMLElement;
  update(s: LobbyState): void;
  setVisible(v: boolean): void;
  readonly name: string;
  /** optional: the control a controller focuses first (else the game's default: the Play button) */
  padFirst?(): HTMLElement | null;
  /** optional: the controller's B on this screen (else: close an open popover) */
  padBack?(): void;
}

export interface ResultsState {
  /** optional: this device's personal bests for the mode / opponent (absent in the firing range or unconfirmed) */
  recap?: import("./personal-bests").BestRecap;
  /** survivedS = the authoritative TIME IN MATCH (null = not confirmed by the host: shown as —) */
  placement: number; totalSquads: number; kills: number; damage: number; survivedS: number | null; winner: boolean;
  squadNames: string[]; killedBy: string | null; mode: Mode;
  /** optional: the final cause of death (weapon / storm / fall) + the confirmed hit damage taken just before */
  death?: { weapon: string; incomingDamage?: number; windowS?: number } | null;
  /** optional extra stats row */
  stats?: { headshots?: number; accuracy?: number; revives?: number; distance?: number; redeploys?: number; chests?: number };
  /** optional per-squad-member lines (trios) */
  squad?: Array<{ name: string; kills: number; damage: number; me?: boolean }>;
}
/** the results card's buttons: PLAY AGAIN (practice), SPECTATE (the match still runs), BACK TO LOBBY (always) */
export interface ResultsActions { playAgain?: () => void; spectate?: () => void; backToLobby: () => void }
/** preserveFocus: a refresh of the open card (confirmed numbers, the match ended) — no re-animation, focus kept */
export interface ResultsScreen { el: HTMLElement; show(s: ResultsState, actions: ResultsActions, preserveFocus?: boolean): void; hide(): void }

/** painted top-down island map used by the minimap + full map, generated from the shared terrain (client only) */
export interface MapImage { canvas: HTMLCanvasElement; /** world → pixel */ toPx(x: number, z: number): [number, number]; toWorld(px: number, py: number): [number, number]; sizePx: number; half: number }
export type CreateMapImage = (terrain: Terrain, sizePx: number, pois: Array<{ id: PoiId; name: string; x: number; z: number }>) => MapImage;
