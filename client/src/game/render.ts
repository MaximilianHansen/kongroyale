// Turns the ClientMatch into pixels + sound: camera, view model, kong actors, loot/chests, plane, gliders, storm,
// tracers/impacts, rockets, HUD state. Uses ONLY the module contracts (actors/weapons/audio api) + the storm/ui APIs.
// Game feel lives here: recoil patterns (aim kick that recovers + a camera punch that springs back), trauma camera
// shake, footsteps per surface (local + nearby remotes), death cam, the cargo-bay ride in the plane, and the optional
// third-person camera (over the shoulder on foot, behind the kong in the drop; SETTINGS → Camera view).
// Per-frame code allocates nothing (scratch vectors, pooled rockets, reused HUD rows).
import * as THREE from "three";
import { RangeView } from "./range";
import { lootCard, manualLootCandidate, weaponHudEligible } from "./hud-state";
import { bindingText, climbText, descendText, glyphFamily, lookText } from "../settings/labels";
import { device } from "../settings/device";
import { glyph, PB, stickGlyph } from "../settings/pad";
import { preferences } from "../settings/preferences";
import { camCast, findOpenSpot } from "./camcollide";
import { ReloadTrigger } from "../weapons/reload-edge";
import type { Engine } from "../engine/engine";
import type { KongActor, KongPose, KongState } from "../actors/api";
import type { ChestView, Fx, LootView, ViewModel, ViewModelMotion, WeaponsKit } from "../weapons/api";
import type { AirHands } from "../weapons/viewmodel";
import type { GameAudio, PoiTheme, Sfx } from "../audio/api";
import type { StormVisual } from "./storm/api";
import { stageLength } from "../../../shared/sim/storm";
import type { AccoladeId, Hud, HudState, HotbarSlot } from "../ui/api";
import { ClientMatch, type EventSink, type Remote } from "./client";
import type { GameInput } from "./input";
import { AMMO_TYPES, PS, SK, consumableId, weaponId, rarityOf, eyeY as simEyeY, canPullChute, FF_DOWN, FF_DIVE_DOWN, type Player } from "../../../shared/sim/player";
import { PLANE_OPEN_S, FREEFALL_FOV, FREEFALL_FOV_MAX, GLIDE_FOV, PLANE_FOV } from "../../../shared/sim/plane";
import { ZIP_LINES, zipNear } from "../../../shared/sim/zipline";
import { PLANE_BAY_S, CHUTE_CUT_HOLD_S, CONSUMABLE_DEFS, DT, PLANE_ALT, PLANE_SPEED, WEAPON_DEFS, SPRINT, SOLO_REDEPLOYS, WARMUP_S, resurgenceDelay, scopeSway, SCOPE_SWAY } from "../../../shared/sim/const";
import { makeShotResult, traceShot } from "../../../shared/sim/hitscan";
import { weaponDef, currentSpread } from "../../../shared/sim/player";
import { IK, type Item } from "../../../shared/sim/loot";
import { makeHit, surfaceById } from "../../../shared/sim/world";
import { ANN, HELD_STOWED, SURF_PLAYER } from "../../../shared/net/proto";
import { Biome, CONSUMABLES, POIS, WEAPONS, type WeaponId } from "../../../shared/world/map";
import type { Surface } from "../../../shared/world/colliders";
import type { Terrain } from "../../../shared/world/terrain";
import { releasePlanePaint, restorePlanePaint, type PlaneProps } from "../actors/plane";
import type { GliderProps } from "../actors/glider";
import { outfitFor } from "../actors/outfit-pick";
import type { LightBalancer } from "./lights";
import { AmmoBoxes } from "./ammobox";
import { resources, type Scope } from "../engine/res/scope";
import { GlassFx, glassShardPrefab } from "../world/glass-fx";
import { PG, glassAim } from "../../../shared/sim/glass";
import { MarkerBeams, type MarkerSpec } from "./markers";
import { SQUAD_COLOURS } from "../ui/minimap";
import { SpectateTracker } from "./spectate";
import { FRAME_GEO, InteractHighlight, hullReady, meshParts, prewarmHull, type HlPart } from "./highlight";
import { AccoladeTracker, BIG } from "./accolades";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createTukTuk, tukDebris, type TukDraw, type TukView, tukPrefabs } from "../actors/tuktuk";
import { createHeli, heliDebris, heliPrefabs } from "../actors/heli-tripo";
import { BananaRounds } from "./banana-rounds";
import { createHelipad } from "../actors/helipad";
import { TukFx } from "./tuk-fx";
import { tukControls } from "./tuk-hud";
import { TukThru } from "./tuk-thru";
import { STATIONS, onAir, stationName } from "../audio/radio";
import { TUK, VE, VF, VKind, VS, freeSeat, specOf, vehicleInReach, vehPoint } from "../../../shared/sim/vehicle";
import { HELI, TOP_BANANA, gunAngles, gunOf, padSlope } from "../../../shared/sim/heli";
import { KILL_BOMB, KILL_GUN, KILL_HELI, KILL_TUK, VK } from "../../../shared/net/proto";
import type { VehRemote } from "./client";
import { gamepads } from "./gamepad";
import { SWIM_DEV, WaterFx } from "./water-fx";
import { UpdraftFx } from "./updraft-fx";
import { BuffOverlay } from "../ui/buff";
import { ClimbViews } from "./climb-views";
import type { WaterApi } from "../world/water/api";
import { BombFx, bombPrefabs } from "./bomb";
import { CoverViews, coverGhostPrefab } from "./cover";
import { ANN_ECON, OFFERS, Offer, SOLO_LIFE } from "../../../shared/sim/economy";
import { ECON, SWIM_FLOAT_Y, UW_EYE, SWIM_EYE, DIVE_MIN_DEPTH } from "../../../shared/sim/const";
import { bananaStand, tickStands } from "../weapons/stand";
import { BOMB } from "../../../shared/sim/const";
import { bombSlot } from "../../../shared/sim/player";
import { killBaseWeapon, killMythic, MYTHIC_R, MYTHICS, mythicIndexOfPoi, mythicOf } from "../../../shared/sim/mythic";

/** controller rumble per weapon: [strong motor, weak motor, ms, right-trigger impulse] */
const FIRE_RUMBLE: Record<string, [number, number, number, number]> = {
  pistol: [0.12, 0.45, 70, 0.35], smg: [0.1, 0.35, 45, 0.25], ar: [0.22, 0.45, 60, 0.4],
  shotgun: [0.75, 0.6, 150, 0.9], sniper: [0.9, 0.5, 200, 1], rocket: [1, 0.8, 300, 0.8],
};

export interface Kits {
  createKong: (ctx: Engine, o?: { variant?: number; lod?: "hi" | "lo" }) => Promise<KongActor>;
  /** give a match kong back to the session pool (index.ts) instead of disposing it — the next match reuses it */
  releaseKong?: (a: KongActor, variant: number) => void;
  createGlider: (ctx: Engine) => Promise<GliderProps>;
  plane: PlaneProps;
  weapons: WeaponsKit; viewModel: ViewModel; fx: Fx; audio: GameAudio; storm: StormVisual; hud: Hud;
  /** keeps the point-light count constant (./lights.ts) — chest bursts register their light here */
  lights?: LightBalancer;
}
interface ActorSlot { actor: KongActor; pose: KongPose; glider: GliderProps | null; id: number; lastFire: number; lastReload: number; stepAcc: number; wasGrounded: boolean; swimEvt: number }
interface RocketView { id: number; mesh: THREE.Mesh; x: number; y: number; z: number; vx: number; vy: number; vz: number; live: boolean; life: number }
/** enemy gunfire shows on the maps within this range (m), fading over SHOT_PING_MS */
const SHOT_PING_R = 200, SHOT_PING_MS = 1500;
/** the spectator bar's key labels (refreshed each frame from the bindings) */
const SPEC_KEYS = { prev: "←", next: "→", list: "TAB" };
/** the watched kong's drawing low-pass (s): ~4× less frame-to-frame jerk for ~0.2 m of lag at a sprint */
const SPEC_SMOOTH_S = 0.05;
const V3 = new THREE.Vector3(), V3b = new THREE.Vector3(), V3c = new THREE.Vector3(), E = new THREE.Euler(0, 0, 0, "YXZ");
/** a squadmate's drawn position (GameRender.mateAt) */
const MATE_AT = new THREE.Vector3();
const POS3: [number, number, number] = [0, 0, 0];
const DEG = Math.PI / 180;
/** the glide look the deploy lifts the view to (rad; -29 deg — a glide camera reads best at -25..-35 deg) */
const DEPLOY_LOOK = -0.5;
/** vertical fov (deg). 72° vertical ≈ 103° horizontal at 16:9 — the classic PC shooter width */
const BASE_FOV = 72;

/** terrain biome → footstep / impact surface (box surfaces come straight from the collider) */
const BIOME_SURF: Surface[] = [];
BIOME_SURF[Biome.DeepOcean] = "water"; BIOME_SURF[Biome.Reef] = "water"; BIOME_SURF[Biome.Beach] = "sand"; BIOME_SURF[Biome.Grass] = "grass";
BIOME_SURF[Biome.Jungle] = "grass"; BIOME_SURF[Biome.Rock] = "stone"; BIOME_SURF[Biome.Cinder] = "stone"; BIOME_SURF[Biome.Path] = "sand";
BIOME_SURF[Biome.Farmland] = "grass"; BIOME_SURF[Biome.Paved] = "concrete"; BIOME_SURF[Biome.Lagoon] = "water";
export function surfaceAt(terrain: Terrain, surf: number, x: number, z: number): Surface {
  // terrain is 255 in the sim and 127 after the 7-bit wire mask (EV.Shot)
  if (surf !== 255 && surf !== 127) return surfaceById(surf);
  return BIOME_SURF[terrain.biomeAt(x, z)] ?? "grass";
}

/** the chest hum: starts within this (m), keeps playing out to HUM_KEEP, muted this long after you open a chest */
const HUM_R = 9, HUM_KEEP = 11.5, HUM_MUTE_MS = 5000, MYTH_HUM_R = 8;
/** per-weapon recoil pattern: [vertical multiplier, horizontal multiplier] per shot index (loops the tail) */
const PATTERN: Record<WeaponId, Array<[number, number]>> = {
  pistol: [[1, 0.2], [1, -0.3], [1.05, 0.35], [1, -0.2]],
  smg: [[0.7, 0.3], [0.8, -0.5], [0.9, 0.6], [0.95, -0.7], [1, 0.8], [1, -0.6], [0.9, 0.9], [0.9, -1], [0.85, 0.7], [0.85, -0.8]],
  ar: [[1, 0], [1.05, 0.15], [1.1, 0.3], [1.1, 0.45], [1.0, 0.3], [0.9, -0.1], [0.85, -0.45], [0.8, -0.6], [0.75, -0.4], [0.75, 0.1], [0.7, 0.5], [0.7, 0.6], [0.7, 0.3], [0.7, -0.2], [0.7, -0.5]],
  shotgun: [[1, 0.25], [1, -0.25]],
  sniper: [[1, 0.15]],
  rocket: [[1, 0.1]],
};

/** apply the atmos material patch to a freshly added subtree right away (the atmos sweep only runs every 24 frames:
 * without this, new kongs / chests / loot / gliders draw their first frames unpatched and compile throwaway programs) */
export function patchTree(engine: Engine, o: THREE.Object3D) {
  const atmos = engine.shared.get("atmos") as { patch?: (m: THREE.Material) => void } | undefined;
  if (!atmos?.patch) return;
  o.traverse((c) => { const m = (c as THREE.Mesh).material; if (!m) return; if (Array.isArray(m)) m.forEach((x) => atmos.patch!(x)); else atmos.patch!(m); });
}

/** (caster) a commentator seat (client/src/caster) owns the camera and the field of view, has no player HUD, and sees
 *  every kong it draws (team colours, POV, nameplates) */
export interface CasterView {
  /** place engine.camera for this frame (after every other system moved) */
  camera(dt: number): void;
  /** the vertical field of view this frame (deg) */
  fov: number;
  /** after a kong was posed: team look, hidden in POV … */
  actor?(r: Remote, actor: KongActor): void;
  /** the POV hands: the motion to animate the first-person viewmodel with (it shows the watched kong's gun), or null
   *  (hidden). The seat equips / fires / reloads it itself */
  hands?(): ViewModelMotion | null;
}

export class GameRender implements EventSink {
  /** (caster) set by a commentator seat: the camera chain, the HUD and the hands are its business */
  caster: CasterView | null = null;
  actors = new Map<number, ActorSlot>();
  chestViews = new Map<number, ChestView>();
  readonly matchScope = resources.root.child("match");
  /** the ammo boxes (instanced, near the camera) */
  readonly boxes = new AmmoBoxes(this.matchScope);
  lootViews = new Map<number, LootView>();
  rockets = new Map<number, RocketView>();
  readonly hud: HudState;
  names: string[] = [];
  /** spectating: who can be watched, the kill tallies, the HUD view */
  readonly spec = new SpectateTracker();
  myName = "KONG";
  bobT = 0; landDip = 0; wasGrounded = true; wasSt = 0; lastUseT = 0;
  /** traversal feel: last slide timer, mantle camera sway 1 → 0, slide lean */
  lastMvT = 0; mantleK = 0; slideLean = 0;
  /** swimming: the last swim-hands stroke beat voiced; the 1P water bob (eye offset, roll) */
  private swimEvtSeen = 0; private swimBob = 0; private swimRoll = 0; private swellS = 0;
  /** swimming HUD: 0 dry / 1 on the surface / 2 under; the controls hint shows until swimHintUntil (performance.now ms) */
  private swimHudSt = 0; private swimHintUntil = 0;
  /** weapons: the local reload trigger (edge per sim tick) */
  private readonly reloadTrig = new ReloadTrigger();
  fov = BASE_FOV; fovBase = BASE_FOV; specYaw = 0; specPitch = -0.3;
  lastCull = 0; lastCullX = 1e9; lastCullZ = 1e9;
  /** floating damage numbers in world space (pooled). pred = client-predicted, not yet confirmed by the server */
  dmgWorld: DmgWorld[] = [];
  /** enemy gunfire pings for the maps: one per shooter, refreshed while they keep firing (performance.now ms) */
  private shotPings = new Map<number, { x: number; z: number; at: number }>();
  private readonly dmgPool: DmgWorld[] = [];
  /** our predicted hitscan pellets, oldest first, waiting for the server's verdict (EV.Hit / EV.Shot of our own shots) */
  private readonly pending: PendingPellet[] = []; private pendHead = 0; private pendLen = 0;
  /** solo redeploys used (resurgence lives) */
  redeploysUsed = 0;
  private hudHidden = false;
  deadAt = -1; resCountdown: number | null = null; killedBy: string | null = null; placement = 0; totalSquads = 17; survivedS = 0;
  onEliminated: (() => void) | null = null; onVictory: (() => void) | null = null;
  // ---- feel state
  private swayT0 = -1; private swayY = 0; private swayP = 0; private readonly swayOut = [0, 0];
  /** hold breath while scoped (const.ts SCOPE_SWAY breath*): lungs 0..1, emptied flag, holding, sway factor */
  private breath = 1; private breathOut = false; private breathHold = false; private breathK = 1;
  /** aiming down sights this frame (the HUD hides the crosshair) */
  private adsOn = false;
  private recoilP = 0; private recoilY = 0; private burstN = 0; private lastShotAt = -1; private recoverRate = 10; private burstPitch0 = 0;
  /** match stats seen by this client (the sim does not stream kills/damage to the client) */
  kills = 0; damage = 0; headshots = 0; chestsOpened = 0;
  private punchP = 0; private punchPV = 0; private punchY = 0; private punchYV = 0; private punchR = 0; private punchRV = 0;
  private trauma = 0; private shakeT = 0;
  private stepAcc = 0; private lastStormTick = 0; private lastDry = 0; private prevShield = 0; private prevHp = 100;
  private deathX = 0; private deathY = 0; private deathZ = 0;
  private rampOpen = 0; private planeYawOffset = 0; private planeCamInit = false;
  private humLoop = -1;
  /** the mythic floor gun humming near me (item id, −1 none) and the next scan (ms) */
  private mythHum = -1; private mythScanAt = 0;
  /** after YOU open a chest no hum
   *  starts for a few seconds (it used to jump straight to the next closed chest nearby — it sounded like the same one) */
  private humMuteUntil = -1;
  private itemKind = new Map<number, number>();
  private readonly rocketGeo = shared().rocketGeo;
  private readonly rocketMat = shared().rocketMat;
  private readonly rocketPool: THREE.Mesh[] = [];
  private loops = new Set<string>();
  private fps = 0; private fpsAcc = 0; private fpsN = 0;
  private placeholderPlane: THREE.Object3D | null = null;
  private squadRows: HudState["squad"] = [];
  private readonly mateTags: NonNullable<HudState["mates"]> = [];
  private victoryAt = -1; private meActor: KongActor | null = null; private mePose = makePose(0); private meActorPending = false;
  private readonly streaks: THREE.Mesh;
  private readonly streakU: ReturnType<typeof shared>["streakU"];
  constructor(readonly engine: Engine, readonly cm: ClientMatch, readonly kits: Kits, readonly input: GameInput) {
    const before = new Set(engine.scene.children);
    this.matchScope.defer(() => this.releaseViews());
    this.matchScope.defer(() => void restorePlanePaint());
    this.hud = makeHudState();
    engine.camera.add(kits.viewModel.object);
    engine.scene.add(kits.plane.object);
    engine.scene.add(this.boxes.group); patchTree(engine, this.boxes.group);
    this.hl = this.matchScope.own("other", new InteractHighlight(engine.scene));
    if (kits.plane.object.children.length === 0) { this.placeholderPlane = placeholderPlane(); kits.plane.object.add(this.placeholderPlane); }
    kits.plane.object.visible = false;
    kits.hud.onMapClick = (x, z) => this.setMark(x, z);
    // right click / the pad's clear on the big map: the marker (and its beam) goes everywhere, not only on the big map
    kits.hud.onMapClear = () => this.setMark(null);
    this.markers = new MarkerBeams(engine.scene, (x, z) => engine.terrain.height(x, z), this.matchScope);
    for (let i = 0; i < 4; i++) { const m = new THREE.Mesh(this.rocketGeo, this.rocketMat); m.visible = false; m.castShadow = true; engine.scene.add(m); this.rocketPool.push(m); }
    this.streaks = new THREE.Mesh(shared().streakGeo, shared().streakMat); this.streaks.frustumCulled = false; this.streaks.renderOrder = 5; this.streaks.visible = false; this.streaks.name = "wind-streaks";
    this.streakU = shared().streakU; engine.scene.add(this.streaks);
    this.updraftFx = new UpdraftFx(engine.scene);
    this.matchScope.defer(() => this.updraftFx.dispose((id) => this.kits.audio.stopLoop(id)));
    this.matchScope.own("other", this.buffUi);
    this.climbViews = this.matchScope.own("other", new ClimbViews(engine.scene, cm.world.climbs));
    for (const m of this.climbViews.meshes) patchTree(engine, m);
    // glass: broken panes vanish, shards burst, the shatter plays (client/src/world/glass-fx.ts)
    this.glassFx = this.matchScope.own("other", new GlassFx(engine.scene, cm.glass, (x, y, z, _cause, by) => this.play("glass:break", x, y, z, by === cm.me ? 1 : 0.9)));
    patchTree(engine, this.glassFx.shards);
    this.tukFx = this.matchScope.own("other", new TukFx(engine.scene, (x, z) => engine.terrain.height(x, z)));
    this.tukThru = new TukThru(cm.world, this.tukFx, (s, x, y, z, v) => this.play(s, x, y, z, v));
    // banana bombs: the world copies, the arc preview, the first-person throw
    this.coverViews = new CoverViews(engine.scene, cm.world, kits.fx, (s, x, y, z) => this.play(s === "up" ? "tuk:land" : s === "hit" ? "impact:wood" : s === "break" ? "tuk:crash" : "step:wood", x, y, z, s === "hit" ? 0.5 : 0.9), this.matchScope);
    this.bombFx = new BombFx(engine.scene, engine.camera, cm.world, (x, y, z, sp) => this.play("impact:wood", x, y, z, Math.min(0.55, 0.12 + sp * 0.04)), this.matchScope);
    this.bananas = new BananaRounds(engine.scene, this.matchScope); patchTree(engine, this.bananas.mesh);
    cm.sink = this;
    // (a POI streaming in meanwhile must not adopt these as its own roots, main.ts moduleRoots: its cull would give the
    // custom shaders a dissolve, a program the boot prewarm never linked, and fade gameplay effects as scenery)
    for (const o of engine.scene.children) if (!before.has(o)) o.userData.gameRoot = true;
  }
  readonly glassFx: GlassFx;
  private readonly tukFx: TukFx;
  /** fences / hedges / banana rows a tuk-tuk ploughs through burst (game/tuk-thru.ts) */
  private readonly tukThru: TukThru;
  private readonly bombFx: BombFx;
  private readonly coverViews: CoverViews;
  cover(id: number, _owner: number, fresh: boolean) { this.coverViews.add(this.cm.covers, id, fresh); }
  coverHit(id: number, hp: number) { this.coverViews.hit(id, hp); }
  coverEnd(id: number, why: number) { this.coverViews.end(id, why); }
  private lastCook = 0; private coverOk = false; private coverHeld = false;
  /** bombs carried last frame, until when the pick-up hint shows, the fuse's next tick (s) */
  private bombSeen = 0; private bombHintUntil = 0; private fuseTickAt = 0;
  // ---- (economy) the Banana Stands, the shop prompt, the wallet
  private standViews: THREE.Object3D[] = [];
  /** the stand in reach (its index) — E opens its buy menu (index.ts owns the menu) */
  standNear = -1; private lastE = false; private bountyTeam = -1;
  onShop: ((stand: number) => void) | null = null;
  private cashGainAt = 0; private cashGainAmt = 0;
  cashGain(amount: number) { this.cashGainAt = performance.now(); this.cashGainAmt = amount; }
  private syncStands() {
    if (this.standViews.length === this.cm.stands.length) return;
    for (const o of this.standViews) o.removeFromParent();
    const proto = bananaStand().root;
    this.standViews = this.cm.stands.map((s) => { const o = proto.clone(true); o.position.set(s.x, s.y, s.z); o.rotation.y = s.yaw; o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = !m.userData.noCast; m.receiveShadow = true; } }); this.engine.scene.add(o); patchTree(this.engine, o); return o; });
  }
  /** the buy menu's view of the offers for this kong right now (the server re-checks every rule) */
  shopView(): import("../ui/shop").ShopView {
    const cm = this.cm, p = cm.pred, e = cm.econ, solo = cm.mode === "solo";
    const resOn = (cm.flags & 1) !== 0;
    const mateOut = !solo && cm.remotes.some((r) => r.n > 0 && r.team === p.team && r.id !== cm.me && (r.st === PS.Dead || r.st === PS.Spectate)) && !resOn;
    const offers = OFFERS.map((o) => {
      let name = o.name, desc = o.desc, price = o.price, why: string | undefined;
      if (o.id === Offer.BuyBack) {
        if (solo) { name = SOLO_LIFE.name; desc = SOLO_LIFE.desc; price = SOLO_LIFE.price; if (!resOn) why = "RESURGENCE IS OFF"; else if (this.redeploysUsed <= 0) why = "YOU HAVE ALL YOUR LIVES"; }
        else if (!mateOut) why = resOn ? "SQUADMATES REDEPLOY ON THEIR OWN" : "NO ELIMINATED SQUADMATE";
      } else if (o.id === Offer.Bounty && e.huntTeam !== 255) why = "YOUR SQUAD HAS A CONTRACT";
      else if (o.id === Offer.Ammo && p.slots[p.active].kind !== SK.Weapon) why = "HOLD A GUN FIRST";
      return { id: o.id, name, desc, price, icon: o.icon, ok: !why && e.cash >= price, why };
    });
    return { cash: e.cash, title: "BANANA STAND", sub: (POIS[cm.stands[this.standNear]?.poi ?? -1]?.name ?? "") + " · SPEND YOUR BANANA BUCKS", offers };
  }
  bomb(id: number, owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, fuse: number) {
    this.bombFx.spawn(id, owner === this.cm.me, x, y, z, vx, vy, vz, fuse);
    if (owner !== this.cm.me) this.play("jump", x, y, z, 0.35);
  }
  bombEnd(id: number) { this.bombFx.end(id); }
  localThrow(cooked: number) {
    const p = this.cm.pred;
    this.bombFx.localThrow(p.x, simEyeY(p), p.z, p.yaw, p.pitch, p.vx, p.vz, cooked);
    this.sfx("jump", { volume: 0.4 }); gamepads.rumble(0.15, 0.3, 80);
    // the release: the bomb whooshes out of the hand
    this.kits.audio.play("whizz", { volume: 0.45, rate: 0.62 });
  }
  /** TOP BANANA's rounds drawn as flying bananas (game/banana-rounds.ts) */
  private readonly bananas: BananaRounds;
  // ---- tuk-tuks (shared/sim/vehicle.ts): their views by vehicle id, and the riding camera — third person behind it for
  // the driver (V swaps to the saddle), from the seat for the bench; the driver's view turns WITH the tuk-tuk
  private tuks = new Map<number, TukView>();
  private tukAudio = new Map<number, TukSound>();
  /** the helipad decals (one per spot, once per world) */
  private pads: THREE.Mesh[] = []; private padScope: Scope | null = null; private padWorld: unknown = null; private padKey = 0;
  rideThird = true;
  private rideOn = false; private rideSeat = -1; private rideYaw = 0; private rideRel = 0; private rideSet = 0; private rideFree = 1; private rideAt = 0; private heliTip = 0;
  /** the saddle view's lean into the turn (rad, smoothed) */
  private fpLean = 0;
  /** the radio dial of my tuk-tuk last turned (performance.now) — the HUD flickers the station name */
  private tunedAt = -1e9;
  private camMode = -1; private camBlend = 1; private camKept = false; private tukWarned = false; private noPilotWarned = false; private noPilotAt = -1; private rideSeatAt = -1;
  /** the kind of the vehicle I last sat in (the exit sound after the seat is gone) */
  private rideKind = 0;
  /** TOP BANANA (a helicopter's door gun): rounds fired per vehicle since its last draw (its muzzle flash), the dry click */
  private readonly gunShots = new Int32Array(TUK.MAX); private gunDryAt = 0;
  /** …and when its last round left (performance.now; the fire loop runs while rounds keep coming), and whether that round
   * was my own predicted one (1: 50 ms apart, on time) or one heard from the server (0: they arrive in 33 ms packets) */
  private readonly gunLastAt = new Float64Array(TUK.MAX).fill(-1e9); private readonly gunLocal = new Uint8Array(TUK.MAX);
  private readonly blendP = new THREE.Vector3(); private readonly blendQ = new THREE.Quaternion(); private readonly keptP = new THREE.Vector3(); private readonly keptQ = new THREE.Quaternion();
  // ---- third person (SETTINGS → Camera view; the Camera view key on foot): an over-the-shoulder camera on foot and a
  // chase camera in the drop, my own kong drawn (thirdPersonCamera), my shots aimed from its eyes at the crosshair (thirdAim)
  /** this frame's camera is the third-person one */
  private third = false;
  /** its smoothed distance behind the shoulder (aiming pulls it in), the shoulder side (−1 left … +1 right, eased so a
   *  swap travels), and how much of the side / back offset the walls left free (pulled in at once, eased back out) */
  private tpDist = TP_DIST; private tpSide = 1; private tpSideFree = 1; private tpFree = 1;
  /** the camera is clear of my kong (a wall at my back can push it into the fur: then the kong is not drawn) */
  private tpShow = true;
  /** my last shot (performance.now): the third-person kong's recoil and muzzle */
  private meFireAt = -1e9;
  /** the Camera view key on foot: first ↔ third person (saved, like the settings row) */
  toggleFootView() { preferences.set({ thirdPerson: !preferences.value.thirdPerson }); this.sfx("ui:click", { volume: 0.5 }); }
  /** V: the driver's view, behind the tuk-tuk ↔ from the saddle */
  toggleRideView() { if (this.cm.pred.st === PS.Ride && this.cm.pred.seat === 0) { this.rideThird = !this.rideThird; this.camMode = -2; this.sfx("ui:click", { volume: 0.5 }); } }

  /** create every other kong up front (instanced actors: cheap) so nobody pops in or hitches mid-fight */
  async prewarmActors() {
    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 50; i++) if (i !== this.cm.me) jobs.push(this.ensureActor(i, this.cm.remotes[i]?.team ?? 0));
    await Promise.all(jobs);
    for (const a of this.actors.values()) a.actor.setVisible(false);
  }

  // ---------------------------------------------------------------- events
  /** firing range extras (distance boards, target bars, stats panel); null in a normal match */
  range: RangeView | null = null;
  setRange(on: boolean) { this.range?.dispose(); this.range = on ? new RangeView(this.engine, this.cm, (id) => this.name(id)) : null; }
  hit(shooter: number, victim: number, zone: number, dmg: number, x: number, y: number, z: number, kill: boolean, shieldBreak = false) {
    const me = this.cm.me;
    this.range?.onHit(shooter, victim, zone, dmg, x, y, z, kill);
    if (shooter === me && victim !== me) {
      this.damage += dmg;
      // "break": this hit took the enemy's shield to 0 (blue cracked ring, shards, blue number)
      const kind = kill ? "kill" : shieldBreak ? "break" : zone === 1 ? "head" : zone === 2 ? "shield" : "body";
      const now = performance.now();
      // the server's verdict on the pellet at the head of our prediction queue (EV.Hit precedes that pellet's EV.Shot)
      const rec = this.pendPeek(now);
      const predicted = rec !== null && rec.victim === victim && !rec.confirmed;
      if (predicted) {
        rec!.confirmed = true;
        // the confirmed damage REPLACES this pellet's predicted share of the (one) number on this target
        const d = this.dmgFor(victim, now);
        // the first confirmation REPLACES the predicted kind (the server may say shield / body where we guessed head)
        if (d) { const hadConfirm = d.ca > 0; d.pa = Math.max(0, d.pa - rec!.dmg); d.ca += dmg; d.last = now; d.kind = hadConfirm ? rankKind(d.kind, kind) : kind; d.x = x; d.y = y + 0.3; d.z = z; }
        else this.pushDmg(now, x, y + 0.3, z, 0, dmg, kind, victim);
        // confirm upgrades the predicted marker in place; new information (shield / kill) gets its own sound
        this.hud.hitMarker = { kind, at: now, predicted: false };
        gamepads.rumble(0, kind === "head" ? 0.4 : 0.22, 40);
        if (kill) this.sfx("kill"); else if (zone === 2) this.sfx("hit:shield:confirm", { volume: 0.7 });
      } else {
        this.hud.hitMarker = { kind, at: now, predicted: false };
        const d = this.dmgFor(victim, now);
        if (d) { const hadConfirm = d.ca > 0; d.ca += dmg; d.last = now; d.kind = hadConfirm ? rankKind(d.kind, kind) : kind; d.x = x; d.y = y + 0.3; d.z = z; }
        else this.pushDmg(now, x, y + 0.3, z, 0, dmg, kind, victim);
        this.sfx(kill ? "kill" : zone === 1 ? "hit:head" : zone === 2 ? "hit:shield" : "hit:body");
        this.kits.fx.impact(V3.set(x, y, z), V3b.set(0, 1, 0), "flesh");
      }
      if (shieldBreak && !preferences.value.reducedMotion) this.kits.fx.shieldBreak?.(V3.set(x, y, z));
      if (kill) { const p = this.cm.pred; this.acc.hit(victim, zone, x, y, z, p.x, simEyeY(p), p.z, now); }   // medals
      if (zone === 1) this.headshots++;
      if (kill) this.announce(`ELIMINATED ${this.name(victim)}`, this.kills + 1 > 1 ? `${this.kills + 1} ELIMINATIONS` : "", "kill");
    } else if (victim === me) {
      this.incomingHits.push({ at: performance.now(), damage: dmg });
      while (this.incomingHits.length > 64) this.incomingHits.shift();
      // the damage-direction arc: every hit with a known source (a kong's gun, rocket, bomb, rotor or
      // tuk-tuk — every player is in the snapshots, far ones 1 in 3) points at where the source stood when it landed; the
      // angle is re-aimed every frame against the CAMERA (dmgDirsAim), so it keeps pointing there while you turn, ride
      // or look through the scope
      const s = shooter >= 0 ? this.cm.remotes[shooter] : null;
      if (s && s.n > 0 && shooter !== me) {
        const d = { at: performance.now(), angle: 0, dmg, src: shooter, x: s.x, z: s.z };
        this.hud.damageDirs.push(d); if (this.hud.damageDirs.length > 8) this.hud.damageDirs.shift();
        this.dmgDirsAim();
      }
      this.sfx("hit:body", { volume: 0.55 });
      this.addTrauma(Math.min(0.45, 0.12 + dmg / 120));
      // (Toon HUD feedback) aim flinch scaled by the damage, halved while aiming
      const flinch = Math.min(1, 0.25 + dmg / 40) * (this.adsOn || this.cm.pred.scoped ? 0.5 : 1);
      this.punchPV += flinch * 1.6 * DEG * 18; this.punchRV += flinch * (Math.random() - 0.5) * 3 * DEG * 18;
    } else {
      this.kits.fx.impact(V3.set(x, y, z), V3b.set(0, 1, 0), "flesh");
    }
  }
  /** re-aim every live damage arc at its source against the camera's heading this frame */
  private dmgDirsAim() {
    const D = this.hud.damageDirs; if (!D.length) return;
    const cam = this.engine.camera; cam.getWorldDirection(V3c);
    const yaw = Math.hypot(V3c.x, V3c.z) > 0.05 ? Math.atan2(-V3c.x, -V3c.z) : this.input.yaw;
    const p = this.cm.pred;
    for (const d of D) {
      if (d.x === undefined || d.z === undefined) continue;
      let rel = Math.atan2(-(d.x - p.x), -(d.z - p.z)) - yaw;
      while (rel > Math.PI) rel -= Math.PI * 2; while (rel < -Math.PI) rel += Math.PI * 2;
      d.angle = rel;
    }
  }
  /** the server's verdict on one of OUR pellets (arrives after its EV.Hit, if any): pops the prediction queue and
   * takes back a predicted hit the server did not grant (shot clamped by the rewind cap, target moved, etc.) */
  ownShot(weapon: number, ex: number, ey: number, ez: number, surf: number, hit: boolean) {
    const now = performance.now();
    const rec = this.pendPeek(now);
    if (rec) {
      this.pendPop();
      if (rec.victim >= 0 && !rec.confirmed) {
        const d = this.dmgFor(rec.victim, now);
        if (d) { d.pa = Math.max(0, d.pa - rec.dmg); if (d.pa + d.ca <= 0.5) d.at = -1e9; }
        this.rejected++;
      }
    } else if (hit && surf !== SURF_PLAYER) {
      // no prediction for this pellet (e.g. the tab stalled): draw the server's impact
      V3b.set(ex, ey, ez); const s = surfaceAt(this.engine.terrain, surf, ex, ez);
      this.kits.fx.impact(V3b, V3c.set(0, 1, 0), s);
    }
    void weapon;
  }
  /** the server fired a shot of ours the prediction missed (its hit sound came, its fire sound never did): fire it now
   *  — late by one round trip, never silent */
  unpredictedShots(n: number) {
    const p = this.cm.pred, s = p.slots[p.active];
    this.unpredicted += n;
    if (s.kind !== SK.Weapon || p.hp <= 0 || performance.now() - this.lastShotAt < 120) return;
    const w = WEAPON_DEFS[weaponId(s.id)];
    this.kits.viewModel.fire(); this.sfx(`fire:${w.id}`);
  }
  /** own shots the server fired that the prediction did not (telemetry) */
  unpredicted = 0;
  /** predicted hits the server rejected (telemetry for tools) */
  rejected = 0;
  private pendPeek(now: number): PendingPellet | null {
    // drop records the server never answered (a shot it did not fire): older than 2 RTT + 400 ms
    const maxAge = Math.max(700, this.cm.ping * 2 + 400);
    while (this.pendLen > 0 && now - this.pending[this.pendHead].at > maxAge) this.pendPop();
    return this.pendLen > 0 ? this.pending[this.pendHead] : null;
  }
  private pendPop() { this.pendHead = (this.pendHead + 1) % PEND_N; this.pendLen--; }
  private pendPush(victim: number, dmg: number, at: number) {
    if (this.pendLen >= PEND_N) this.pendPop();
    const r = this.pending[(this.pendHead + this.pendLen) % PEND_N] ??= { victim: -1, dmg: 0, at: 0, confirmed: false };
    this.pending[(this.pendHead + this.pendLen) % PEND_N] = r;
    r.victim = victim; r.dmg = dmg; r.at = at; r.confirmed = false; this.pendLen++;
  }
  /** THE live damage number on `victim` (one per target, stacking window 1 s): predicted (pa) and confirmed (ca) shares
   * of one total — a confirm moves a pellet from pa to ca, a take-back removes it from pa. Otherwise a kill drew its
   * number twice when a new predicted entry started next to an already-confirmed one. */
  private dmgFor(victim: number, now: number): DmgWorld | null {
    let best: DmgWorld | null = null;
    for (let i = this.dmgWorld.length - 1; i >= 0; i--) { const d = this.dmgWorld[i]; if (d.target !== victim || d.at < 0 || now - d.last > 1000) continue; best = d; break; }
    return best;
  }
  private pushDmg(now: number, x: number, y: number, z: number, pa: number, ca: number, kind: DmgWorld["kind"], target: number) {
    if (this.dmgWorld.length >= 16) this.dmgPool.push(this.dmgWorld.shift()!);
    const d = this.dmgPool.pop() ?? { at: 0, last: 0, x: 0, y: 0, z: 0, pa: 0, ca: 0, kind: "body", target: -1 };
    d.at = now; d.last = now; d.x = x; d.y = y; d.z = z; d.pa = pa; d.ca = ca; d.kind = kind; d.target = target;
    this.dmgWorld.push(d);
    return d;
  }
  /** an enemy fired within earshot → red dot on the map + minimap */
  private pingShot(shooter: number, x: number, z: number) {
    const cm = this.cm; if (shooter === cm.me || cm.remotes[shooter]?.team === cm.pred.team) return;
    if (Math.hypot(x - cm.pred.x, z - cm.pred.z) > SHOT_PING_R) return;
    const q = this.shotPings.get(shooter); if (q) { q.x = x; q.z = z; q.at = performance.now(); } else this.shotPings.set(shooter, { x, z, at: performance.now() });
  }
  shot(shooter: number, weapon: number, ox: number, oy: number, oz: number, ex: number, ey: number, ez: number, surf: number, hit: boolean) {
    this.pingShot(shooter, ox, oz);
    if (weapon === KILL_GUN) { this.gunShot(shooter, ox, oy, oz, ex, ey, ez, surf, hit); return; }
    const a = this.actors.get(shooter);
    const w = WEAPONS[weapon] ?? "ar";
    if (a) { a.actor.muzzle(V3); a.pose.fired = true; a.lastFire = performance.now(); } else V3.set(ox, oy, oz);
    this.kits.fx.tracer(V3, V3b.set(ex, ey, ez), w);
    if (hit && surf !== SURF_PLAYER) {
      V3c.set(ox - ex, oy - ey, oz - ez).normalize();
      const s = surfaceAt(this.engine.terrain, surf, ex, ez);
      this.kits.fx.impact(V3b, V3c, s);
      this.play(`impact:${s}`, ex, ey, ez, 0.7);
    }
    this.play(`fire:${w}`, ox, oy, oz, 0.9);
    // whizz if the bullet passed close to us
    const p = this.cm.pred; const d = distPointSeg(p.x, p.y + 1.4, p.z, ox, oy, oz, ex, ey, ez);
    // the crack comes from where the bullet passed (closest point of the tracer), not from inside your head
    if (d < 2.5 && shooter !== this.cm.me) { this.play("whizz", SEGP[0], SEGP[1], SEGP[2], 0.6); this.addTrauma(0.05); }
  }
  private bananasPatched = false;
  /** a banana out of TOP BANANA's barrels (every other round; the atmosphere patch once its material exists) */
  private banana(a: THREE.Vector3, b: THREE.Vector3) {
    if (!this.bananasPatched) { this.bananasPatched = true; patchTree(this.engine, this.bananas.mesh); }
    this.bananas.spawn(a, b);
  }
  /** somebody else's round of TOP BANANA: its tracer leaves the barrels of the helicopter it sits in (as drawn), the
   * minigun's report comes from there; the barrels flash on the next draw */
  private gunShot(shooter: number, ox: number, oy: number, oz: number, ex: number, ey: number, ez: number, surf: number, hit: boolean) {
    const rm = this.cm.remotes[shooter], vid = rm && rm.veh >= 0 ? rm.veh : -1, view = vid >= 0 ? this.tuks.get(vid) : undefined;
    if (vid >= 0) { this.gunShots[vid]++; this.gunLastAt[vid] = performance.now(); this.gunLocal[vid] = 0; }
    if (view?.muzzle && view.object.visible) view.muzzle(V3); else V3.set(ox, oy, oz);
    this.kits.fx.tracer(V3, V3b.set(ex, ey, ez), "ar");
    if (vid >= 0 && (this.gunShots[vid] & 1) === 0) this.banana(V3, V3b);
    if (hit && surf !== SURF_PLAYER) {
      V3c.set(ox - ex, oy - ey, oz - ez).normalize();
      const sf = surfaceAt(this.engine.terrain, surf, ex, ez);
      this.kits.fx.impact(V3b, V3c, sf);
      if ((this.gunShots[Math.max(0, vid)] & 1) === 0) this.play(`impact:${sf}`, ex, ey, ez, 0.55);
    }
    // (the report is the helicopter's `gun:fire` loop, run by updateVehicles while rounds keep coming; a round from a
    // helicopter not known yet gets the burst's end on its own)
    if (vid < 0) this.play("gun:stop", V3.x, V3.y, V3.z, 0.8);
    const p = this.cm.pred; const d = distPointSeg(p.x, p.y + 1.4, p.z, V3.x, V3.y, V3.z, ex, ey, ez);
    if (d < 2.5 && shooter !== this.cm.me && !(p.st === PS.Ride && p.veh === vid)) { this.play("whizz", SEGP[0], SEGP[1], SEGP[2], 0.6); this.addTrauma(0.04); }
  }
  /** the results card's cause-of-death line: what got you + the server-confirmed hit damage you took in the last 10 s */
  deathSummary: { weapon: string; incomingDamage?: number; windowS?: number } | null = null;
  private incomingHits: Array<{ at: number; damage: number }> = [];
  kill(killer: number, victim: number, weapon: number, final: boolean) {
    const me = this.cm.me;
    // a mythic kill carries KILL_MYTHIC + its index: the base gun's silhouette + the mythic's name tag
    const myth = killMythic(weapon); weapon = killBaseWeapon(weapon);
    const wid: HudState["killfeed"][number]["weapon"] = weapon < 6 ? WEAPONS[weapon] : weapon === 255 ? "storm" : weapon === 254 ? "fall" : weapon === KILL_BOMB ? "banana-bomb" : "unknown";
    this.hud.killfeed.push({ at: performance.now(), killer: killer >= 0 ? this.name(killer) : "", victim: this.name(victim), weapon: wid, meKiller: killer === me, meVictim: victim === me, mythic: myth ? { name: myth.name, color: myth.color } : undefined });
    if (this.hud.killfeed.length > 6) this.hud.killfeed.shift();
    this.range?.onKill(killer, victim);
    this.spec.onKill(this.cm, killer, victim, final);   // the spectator bar / list tallies
    if (killer === me && victim !== me && this.cm.remotes[victim]?.team !== this.cm.pred.team && this.cm.phase !== 0) this.kills++;
    if (killer === me && victim !== me) gamepads.rumble(0.35, 0.6, 140);
    // a special kill of mine pops its medals (game/accolades.ts → ui/medals.ts); who got me is remembered.
    // None in the warm-up (nothing counts yet — like the kill counter) or on the range
    if (killer === me && victim !== me && !this.range && this.cm.phase !== 0 && this.cm.remotes[victim]?.team !== this.cm.pred.team) this.accolades(victim, weapon);
    if (victim === me && killer >= 0 && killer !== me) this.acc.died(killer);
    if (victim === me) {
      const deathNow = performance.now();
      this.deathSummary = { weapon: myth ? myth.name : weapon < 6 ? WEAPON_DEFS[WEAPONS[weapon]].name : wid === "storm" ? "Storm" : wid === "fall" ? "Fall damage" : weapon === KILL_TUK ? "Tuk-tuk" : weapon === KILL_BOMB ? "Banana bomb" : weapon === KILL_HELI ? "Helicopter" : weapon === KILL_GUN ? `${TOP_BANANA.name} (door gun)` : "Unknown cause", incomingDamage: Math.round(this.incomingHits.filter((q) => deathNow - q.at <= 10000).reduce((a, q) => a + q.damage, 0)), windowS: 10 };
      this.incomingHits.length = 0;
      this.cm.resetJitter();                  // the view changes (death cam → spectate): re-learn the buffer from fresh arrivals
      const p = this.cm.pred; this.cm.localPose(V3); this.deathX = V3.x; this.deathY = V3.y; this.deathZ = V3.z; void p;
      this.deadAt = performance.now(); this.killedBy = killer >= 0 && killer !== me ? this.name(killer) : wid === "storm" ? "THE STORM" : weapon === KILL_TUK ? "A TUK-TUK" : weapon === KILL_HELI ? "A HELICOPTER" : weapon === KILL_BOMB ? "A BANANA BOMB" : "THE FALL";
      this.resCountdown = final ? null : resurgenceDelay(this.cm.mode, this.cm.storm.phase);
      if (!final && this.cm.phase !== 0) this.redeploysUsed++;
      this.sfx("elim:self");
      this.stopAllLoops();
      this.addTrauma(0.5);
      if (this.range) { this.resCountdown = 3; this.announce("KNOCKED OUT", "back on the firing line in a moment", "info"); }
      else if (this.cm.phase === 0) { this.resCountdown = 3; this.announce("KNOCKED OUT", "respawning on the islet", "info"); }
      else if (final) { this.placement = this.cm.squads; this.announce("ELIMINATED", `by ${this.killedBy}`, "warn"); }
      else this.announce("KNOCKED OUT", this.cm.mode === "solo" ? `REDEPLOY IN ${this.resCountdown}s · ${Math.max(0, SOLO_REDEPLOYS - this.redeploysUsed)} LEFT` : `REDEPLOY IN ${this.resCountdown}s`, "info");
    }
  }
  // ---- accolades
  private readonly acc = new AccoladeTracker();
  private readonly accOut: Array<{ id: AccoladeId; sub: string }> = [];
  private accolades(victim: number, cause: number) {
    const now = performance.now(), out = this.acc.kill(this.cm, victim, cause, now, this.name(victim).toUpperCase(), this.accOut);
    if (!out.length) return;
    const A = (this.hud.accolades ??= []);
    for (let i = 0; i < out.length; i++) A.push({ at: now + i * 0.01, id: out[i].id, sub: out[i].sub });
    while (A.length > 8) A.shift();
    // (and the kill feed's headshot glyph, which no kill set before)
    if (out.some((a) => a.id === "headshot")) { const k = this.hud.killfeed[this.hud.killfeed.length - 1]; if (k?.meKiller) k.head = true; }
    this.sfx(out.some((a) => BIG.has(a.id)) ? "ui:medal-big" : "ui:medal");
  }
  chest(id: number, by: number) {
    const c = this.cm.chests[id];
    if (c?.box) { this.boxes.open(id); this.play("chest:open", c.x, c.y + 0.3, c.z, 0.55); return; }
    const v = this.chestViews.get(id); if (v) { v.open(); this.kits.lights?.track(v.object); }
    if (c) { this.spillFrom.x = c.x; this.spillFrom.y = c.y; this.spillFrom.z = c.z; this.spillFrom.at = performance.now(); }
    if (by === this.cm.me) { this.chestsOpened++; this.humMuteUntil = performance.now() + HUM_MUTE_MS; if (this.humLoop >= 0) { this.stopLoop("chest:hum"); this.humLoop = -1; } if (this.mythHum >= 0) { this.stopLoop("mythic:hum"); this.mythHum = -1; } }
    if (c) this.play("chest:open", c.x, c.y + 0.5, c.z, 1);
    if (this.humLoop === id) { this.stopLoop("chest:hum"); this.humLoop = -1; }
    void by;
  }
  /** end-game regen: the chest / ammo box closed again — the crate, its seam glow + halo come
   * back (ChestView.close); the hum restarts by itself (the hum scan only skips opened chests) */
  chestReset(id: number) {
    const c = this.cm.chests[id];
    if (c?.box) { this.boxes.close(id); return; }
    (this.chestViews.get(id) as (ChestView & { close?(): void }) | undefined)?.close?.();
  }
  spawnItem(it: Item) { this.itemKind.set(it.id, it.kind); this.ensureLoot(it); }
  /** what each live item is, for the "PICKED UP · X" toast */
  private pickupItems = new Map<number, { kind: number; sub: number; rarity: number; count: number }>();
  takeItem(id: number, by: number) {
    const v = this.lootViews.get(id); if (v) { this.drops.delete(v); this.grow.delete(v.object); v.dispose(); this.lootViews.delete(id); }
    if (by === this.cm.me) {
      const k = this.itemKind.get(id), item = this.pickupItems.get(id);
      if (item) this.hud.pickup = { at: performance.now(), label: item.kind === IK.Cash ? `$${(item.count * 10).toLocaleString("en-US")} BANANA BUCKS` : item.kind === IK.Weapon ? (mythicOf(item.rarity)?.name ?? WEAPON_DEFS[WEAPONS[item.sub]].name) : item.kind === IK.Consumable ? CONSUMABLE_DEFS[CONSUMABLES[item.sub]].name : `${AMMO_TYPES[item.sub].toUpperCase()} AMMO` };
      this.sfx(k === IK.Ammo || k === IK.Cash ? "pickup:ammo" : k === IK.Consumable ? "pickup:heal" : "pickup:weapon", { volume: 0.8 });
      const my = item && item.kind === IK.Weapon ? mythicOf(item.rarity) : null;
      if (my) this.announce(`MYTHIC · ${my.name}`, `${POIS.find((q) => q.id === my.poi)?.name ?? ""} SIGNATURE ${WEAPON_DEFS[my.weapon].name} — hits harder than any legendary`, "victory");
    }
    this.itemKind.delete(id); this.pickupItems.delete(id);
  }
  explosion(x: number, y: number, z: number, r: number) {
    this.kits.fx.explosion(V3.set(x, y, z), r);
    this.play("explosion", x, y, z, 1);
    const cam = this.engine.camera.position; const d = Math.hypot(cam.x - x, cam.y - y, cam.z - z);
    this.addTrauma(Math.max(0, 1 - d / 45) * 0.8);
  }
  rocket(id: number, owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    this.pingShot(owner, x, z);
    // our own rocket was already drawn from the muzzle frame (localFire): adopt the oldest predicted one
    if (owner === this.cm.me) {
      const pid = this.predRockets.shift();
      const pr = pid !== undefined ? this.rockets.get(pid) : undefined;
      if (pr) { this.rockets.delete(pid!); pr.id = id; this.rockets.set(id, pr); return; }
    }
    this.addRocket(id, x, y, z, vx, vy, vz);
    if (owner !== this.cm.me) this.play("fire:rocket", x, y, z, 1);
  }
  private addRocket(id: number, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    let mesh = this.rocketPool.pop();
    if (!mesh) { mesh = new THREE.Mesh(this.rocketGeo, this.rocketMat); mesh.castShadow = true; this.engine.scene.add(mesh); }
    mesh.visible = true; mesh.position.set(x, y, z);
    const r: RocketView = { id, mesh, x, y, z, vx, vy, vz, live: true, life: 7 };
    this.rockets.set(id, r);
    return r;
  }
  /** predicted own rockets (negative ids) waiting for the server's EV.Rocket, oldest first */
  private predRockets: number[] = []; private predRocketSeq = 0;
  rocketEnd(id: number) { const r = this.rockets.get(id); if (r) { r.mesh.visible = false; this.rocketPool.push(r.mesh); this.rockets.delete(id); } }
  respawn(id: number, x: number, y: number, z: number) {
    if (id === this.cm.me) {
      this.cm.resetJitter();
      // (re)spawns always start with slot 1 in hand (pistol / warm-up kit)
      this.input.slotWanted = 0;
      this.deadAt = -1; this.resCountdown = null; this.sfx("ui:resurgence");
      if (this.range) this.announce("BACK IN", "firing range", "info");
      else if (this.cm.phase === 0) this.announce("BACK IN", "warm-up — nothing counts yet", "info");
      else { this.announce("REDEPLOYING", "glide back into the fight", "info"); this.loop("glider:wind"); }
    }
    void x; void y; void z;
  }
  /** the server's EV.Jump; our own exit is PREDICTED (shared/sim/plane.ts) and already played at the key press */
  jump(id: number) { if (id === this.cm.me && performance.now() - this.exitAt > 3000) this.onExitPlane(); }
  private exitAt = -1e9;
  private onExitPlane() { this.exitAt = performance.now(); this.sfx("jump:exit"); this.loop("freefall:wind"); this.planeCamInit = false; this.cm.resetJitter(); }
  land(id: number, surf: number) {
    const a = this.actors.get(id); const pos = a ? a.actor.object.position : null;
    if (id === this.cm.me) {
      const p = this.cm.pred; const s = p.swim ? "water" : surfaceAt(this.engine.terrain, surf, p.x, p.z);
      this.stopLoop("freefall:wind"); this.stopLoop("glider:wind"); this.sfx("land"); this.landDip = 0.12; gamepads.rumble(0.25, 0.15, 90);
      // a glider touchdown is soft (the dropPose knee carries it) — the shake is for a freefall crash only
      if (this.lastAirSt !== PS.Glide) this.addTrauma(0.18);
      this.kits.fx.puff(V3.set(p.x, p.y, p.z), s === "sand" ? "sand" : s === "water" ? "splash" : "dust");
    } else if (pos) {
      const s = surfaceAt(this.engine.terrain, surf, pos.x, pos.z);
      this.play("land", pos.x, pos.y, pos.z, 0.8); this.kits.fx.puff(pos, s === "sand" ? "sand" : s === "water" ? "splash" : "dust");
    }
  }
  storm(phase: number, shrinking: boolean) {
    if (phase === 0) return;
    if (shrinking) { this.announce("THE STORM IS CLOSING IN", `phase ${phase} — get inside the white circle`, "storm"); this.sfx("storm:shrink"); }
    else this.announce(`STORM PHASE ${phase}`, "next safe zone marked on the map (M)", "storm");
    this.kits.storm.flash(0.6);
  }
  announceCode(code: number, a: number, b: number) {
    switch (code) {
      case ANN.MatchStart: this.announce("BANANA CO. FLIGHT DEPARTING", `the ramp opens in a moment · ${bindingText("ping", 0)} pings where you'll drop`, "info"); break;
      case ANN.PlaneOpen: {
        this.announce("RAMP OPEN — JUMP!", "SPACE to jump · steer with the mouse · SHIFT to dive · X glider", "info"); this.sfx("ui:countdown-go");
        this.cm.planePos(PP); this.play("plane:ramp", PP.x, PLANE_ALT, PP.z, 1);
        break;
      }
      case ANN.ResurgenceWarn: this.announce("RESURGENCE ENDS IN 20 SECONDS", "after that, kills are final", "warn"); this.sfx("ui:countdown"); break;
      case ANN.ResurgenceOff: {
        this.announce("RESURGENCE OFF", "KILLS ARE FINAL", "warn"); this.sfx("ui:countdown");
        // the server has just eliminated everyone still waiting on a redeploy (Match: resurgence off): my
        // countdown stops here — it would otherwise run on to GO! and stay up, with no redeploy coming
        if (this.deadAt >= 0 && this.resCountdown != null && !this.range && this.cm.phase !== 0) this.resCountdown = null;
        break;
      }
      case ANN.Victory: { const win = a === this.cm.pred.team; if (win) { this.announce("KONG ROYALE VICTORY", "#1", "victory"); this.sfx("ui:victory"); this.placement = 1; this.victoryAt = performance.now(); this.onVictory?.(); } else if (this.deadAt < 0) { this.placement = 2; this.onEliminated?.(); } else if (this.spec.active(this.cm)) this.spectatorVictory(a); break; }
      // (economy) bounties and buy-backs: a / b carry teams (or kong ids) — this squad's news only
      case ANN_ECON.Bounty: { const t = this.cm.pred.team; if (a === (t & 0xff)) { this.announce("BOUNTY CONTRACT ACTIVE", "the marked squad is on your map — 90 s", "kill"); this.sfx("ui:countdown"); } else if (b === (t & 0xff)) { this.announce("YOU HAVE A BOUNTY", "a squad is hunting you — survive 90 s for $500", "warn"); this.sfx("storm:shrink"); } break; }
      case ANN_ECON.BountyDone: { const t = this.cm.pred.team; if (a === (t & 0xff)) { this.announce("BOUNTY COMPLETE", "+$1,500 each · the reward dropped where they fell", "victory"); this.sfx("ui:victory"); } else if (b === (t & 0xff)) this.announce("YOUR BOUNTY WAS CLAIMED", "the hunters got one of you", "warn"); break; }
      case ANN_ECON.BountyOver: { const t = this.cm.pred.team; if (a === (t & 0xff)) this.announce("BOUNTY EXPIRED", "the mark got away", "info"); else if (b === (t & 0xff)) this.announce("BOUNTY SURVIVED", "+$500 for every one of you still standing", "victory"); break; }
      case ANN_ECON.BuyBack: { const q = this.cm.remotes[a]; if (a === this.cm.me || (q && q.team === this.cm.pred.team)) { this.announce(`${this.name(a)} IS BACK`, `bought back by ${this.name(b)} — redeploying`, "info"); this.sfx("ui:resurgence"); } break; }
      case ANN.SquadEliminated: if (a === this.cm.pred.team) { this.placement = b + 1; this.totalSquads = Math.max(this.totalSquads, b + 1); this.resCountdown = null; if (this.cm.mode === "trios") this.announce("SQUAD ELIMINATED", `#${b + 1} · better luck next drop`, "warn"); this.onEliminated?.(); } break;
    }
  }
  /** out and watching when a squad wins: name the winners on the banner (the server points every spectator's camera
   * at them — Match.enterResults); index.ts brings the results card back after the moment */
  private spectatorVictory(team: number) {
    const cm = this.cm, w = cm.spectate >= 0 && cm.remotes[cm.spectate]?.team === team ? cm.spectate : cm.remotes.findIndex((r) => r.team === team && r.n > 0 && !r.deadNow);
    if (w < 0) return;
    const who = this.name(w).toUpperCase();
    this.announce(cm.mode === "trios" ? `${who}'S SQUAD WINS` : `${who} WINS`, "KONG ROYALE VICTORY", "victory");
  }
  /** the results card is up: no banners behind it (they would print through the card) */
  muteAnnounce = false;
  announce(title: string, sub: string, kind: "info" | "warn" | "storm" | "kill" | "victory") { if (this.muteAnnounce) return; this.hud.announce = { at: performance.now(), title, sub, kind }; }
  localFire() {
    { const gv = gunOf(this.cm.vehs, this.cm.pred); if (gv) { this.gunFire(gv.id); return; } }
    const p = this.cm.pred; const slot = p.slots[p.active]; const w = WEAPON_DEFS[weaponId(slot.id)];
    this.kits.viewModel.fire();
    this.meFireAt = performance.now();
    { const r = FIRE_RUMBLE[w.id]; if (r) gamepads.rumble(r[0], r[1], r[2], { right: r[3] }); }
    // ---- aim recoil (moves where the next bullet goes; recovers after the burst unless the player pulled down)
    const now = performance.now();
    if (now - this.lastShotAt > 60000 / w.rpm + 140) { this.burstN = 0; this.burstPitch0 = this.input.pitch - this.recoilP; }
    const pat = PATTERN[w.id]; const k = pat[this.burstN < pat.length ? this.burstN : pat.length - 4 + (this.burstN % Math.min(4, pat.length))] ?? pat[0];
    this.burstN++; this.lastShotAt = now;
    if (w.scope && this.swayT0 >= 0) this.swayT0 = now / 1000 + 60 / w.rpm;   // combat: the sway re-settles after the bolt
    const vis = w.recoil[0] * DEG, hor = w.recoil[1] * DEG;
    const dp = vis * k[0] * (0.62 + (p.crouch ? -0.12 : 0)), dy = hor * k[1] * 0.9 + (Math.random() - 0.5) * hor * 0.35;
    this.input.pitch = Math.min(1.53, this.input.pitch + dp); this.input.yaw -= dy;
    this.recoilP += dp; this.recoilY += dy; this.recoverRate = w.recoil[2];
    // ---- camera punch (visual only, springs back fully) + a little shake for the heavy hitters
    // the punch moves the WORLD under the crosshair, so
    // on automatics a big one reads as the aim jumping around. So: a clean, small kick on automatics (almost no
    // sideways / roll jitter), a firm one on the heavy hitters, and less again aiming down sights
    { const heavy = w.id === "shotgun" || w.id === "sniper" || w.id === "rocket", k = this.adsOn ? 0.6 : 1;
      this.punchPV += vis * (heavy ? 9 : 5.5) * k * (0.95 + Math.random() * 0.1);
      this.punchYV += (Math.random() - 0.5) * hor * (heavy ? 5 : 3) * k; this.punchRV += (Math.random() - 0.5) * vis * (heavy ? 3 : 1.5) * k;
      if (heavy) this.addTrauma(w.id === "rocket" ? 0.14 : 0.08); }
    this.sfx(`fire:${w.id}`);
    if (w.projectile) {
      // the rocket leaves the barrel NOW (same launch maths as the server's Match.resolveShot); the server's copy adopts it
      const pj = w.projectile, cp = Math.cos(p.pitch), sp = Math.sin(p.pitch), sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      const dx = -sy * cp, dy = sp, dz = -cy * cp, oy = simEyeY(p);
      const id = -(++this.predRocketSeq);
      this.addRocket(id, p.x + dx * 0.8, oy + dy * 0.8 - 0.15, p.z + dz * 0.8, dx * pj.speed + p.vx * 0.5, dy * pj.speed, dz * pj.speed + p.vz * 0.5);
      this.predRockets.push(id); if (this.predRockets.length > 8) this.predRockets.shift();
      return;
    }
    // ---- INSTANT hit feedback: trace every pellet exactly like the server will (same spread seed, same drawn
    // hitboxes, same world) — tracer to where it really stops, impact there, predicted marker + number now; the
    // server's EV.Hit / EV.Shot for these pellets confirm (or take back) the prediction ~1 RTT later.
    if (this.third && this.meActor) this.meActor.muzzle(V3); else this.kits.viewModel.muzzle(V3);
    const ox = p.x, oy = simEyeY(p), oz = p.z;
    let hitV = -1, hitZone = 0, hitT = 0, total = 0;
    for (let i = 0; i < p.fired; i++) {
      const r = this.cm.predictShot(i, SHOT, SDIR);
      const ex = ox + SDIR[0] * r.t, ey = oy + SDIR[1] * r.t, ez = oz + SDIR[2] * r.t;
      V3b.set(ex, ey, ez);
      if (i < 5) this.kits.fx.tracer(V3, V3b, w.id);
      let dmg = 0;
      if (r.victim >= 0) {
        // predictShot booked the damage; when our bullets in flight take this kong to 0 the rest of the blast passes through
        dmg = this.cm.predDmg;
        total += dmg; if (hitV < 0 || r.zone === 1) { hitV = r.victim; hitZone = r.zone; hitT = r.t; }
        this.kits.fx.impact(V3b, V3c.set(-SDIR[0], -SDIR[1], -SDIR[2]), "flesh");
      } else if (r.worldHit) {
        const s = surfaceAt(this.engine.terrain, r.surf, ex, ez);
        this.kits.fx.impact(V3b, V3c.set(-SDIR[0], -SDIR[1], -SDIR[2]), s);
        if (i < 2) this.play(`impact:${s}`, ex, ey, ez, w.pellets > 1 ? 0.35 : 0.55);
      }
      this.pendPush(r.victim, dmg, now);
    }
    if (hitV >= 0) {
      const kind = hitZone === 1 ? "head" : "body";   // the kill skull / red number wait for the server's verdict
      this.hud.hitMarker = { kind, at: now, predicted: true };
      const hx = ox + SDIR[0] * hitT, hy = oy + SDIR[1] * hitT + 0.3, hz = oz + SDIR[2] * hitT;
      const d = this.dmgFor(hitV, now);
      if (d) { d.pa += total; d.last = now; d.x = hx; d.y = hy; d.z = hz; if (d.ca <= 0) d.kind = rankKind(d.kind, kind); }
      else this.pushDmg(now, hx, hy, hz, total, 0, kind, hitV);
      this.sfx(hitZone === 1 ? "hit:head" : "hit:body");
    }
  }
  /** MY round of TOP BANANA, predicted this tick: the report, a light kick (no aim recoil: the gun is on its mount), the
   * tracer from the barrels to where the round stops (the same trace as the server's), impacts and hit feedback now */
  private gunFire(vid: number) {
    const p = this.cm.pred, now = performance.now();
    this.gunShots[vid]++;
    // (the report: the `gun:fire` loop updateVehicles runs while rounds keep coming)
    this.gunLastAt[vid] = now; this.gunLocal[vid] = 1;
    gamepads.rumble(0.12, 0.32, 40, { right: 0.25 });
    this.punchPV += 0.3 * DEG * 16 * (0.8 + Math.random() * 0.4); this.punchYV += (Math.random() - 0.5) * 0.35 * DEG * 14; this.punchRV += (Math.random() - 0.5) * 0.2 * DEG * 8;
    const view = this.tuks.get(vid);
    if (view?.muzzle && view.object.visible) view.muzzle(V3); else V3.set(p.x, simEyeY(p) - 0.3, p.z);
    const ox = p.x, oy = simEyeY(p), oz = p.z;
    const r = this.cm.predictShot(0, SHOT, SDIR);
    const ex = ox + SDIR[0] * r.t, ey = oy + SDIR[1] * r.t, ez = oz + SDIR[2] * r.t;
    V3b.set(ex, ey, ez);
    this.kits.fx.tracer(V3, V3b, "ar");
    if ((this.gunShots[vid] & 1) === 0) this.banana(V3, V3b);
    let dmg = 0;
    if (r.victim >= 0) {
      dmg = this.cm.predDmg;
      this.kits.fx.impact(V3b, V3c.set(-SDIR[0], -SDIR[1], -SDIR[2]), "flesh");
      const kind = r.zone === 1 ? "head" : "body";
      this.hud.hitMarker = { kind, at: now, predicted: true };
      const d = this.dmgFor(r.victim, now);
      if (d) { d.pa += dmg; d.last = now; d.x = ex; d.y = ey + 0.3; d.z = ez; if (d.ca <= 0) d.kind = rankKind(d.kind, kind); }
      else this.pushDmg(now, ex, ey + 0.3, ez, dmg, 0, kind, r.victim);
      this.sfx(r.zone === 1 ? "hit:head" : "hit:body", { volume: 0.7 });
    } else if (r.worldHit) {
      const sf = surfaceAt(this.engine.terrain, r.surf, ex, ez);
      this.kits.fx.impact(V3b, V3c.set(-SDIR[0], -SDIR[1], -SDIR[2]), sf);
      if ((this.gunShots[vid] & 1) === 0) this.play(`impact:${sf}`, ex, ey, ez, 0.45);
    }
    this.pendPush(r.victim, dmg, now);
  }
  phase(phase: number) {
    if (phase === 0 || phase === 1) this.input.slotWanted = 0;
    if (phase === 1) { this.placeSeen.fill(0); this.hud.place = null; this.hud.where = null; this.acc.reset(); if (this.hud.accolades) this.hud.accolades.length = 0; this.hud.pickup = null; this.deathSummary = null; this.incomingHits.length = 0; this.totalSquads = this.cm.mode === "solo" ? 50 : 17; this.kills = 0; this.redeploysUsed = 0; this.headshots = 0; this.chestsOpened = 0; this.damage = 0; this.deadAt = -1; this.resCountdown = null; this.placement = 0; this.hud.killfeed.length = 0; this.rampOpen = 0; this.planeCamInit = false; }   // (the warm-up's map pin stays: it marks your drop)
    if (phase === 0 || phase === 1) { this.victoryAt = -1; if (this.meActor) this.meActor.setVisible(false); }
    if (phase === 0) { this.stopAllLoops(); this.deadAt = -1; if (this.range) this.announce("FIRING RANGE", "every item on the rack behind you · targets respawn", "info"); else this.announce("WARM-UP", "loot up, shoot around — the plane leaves soon", "info"); }
  }
  inventory() { this.syncViewModel(); }
  serverSlot(slot: number) { this.input.slotWanted = slot; this.syncViewModel(); }
  /** the held model follows the PREDICTED active slot every frame (keys 1-5, the wheel, pickups, respawns): one equip per
   * change of kind / id / rarity, never a string compare in the frame loop */
  private vmKind = -1; private vmId = -1; private vmRar = -1;
  private syncViewModel() {
    const p = this.cm.pred, s = p.slots[p.active];
    const kind = s.kind === SK.Weapon || s.kind === SK.Consumable ? s.kind : 0, id = kind ? s.id : 0, rar = kind ? s.rarity : 0;
    if (kind === this.vmKind && id === this.vmId && rar === this.vmRar) return;
    const first = this.vmKind < 0;
    this.vmKind = kind; this.vmId = id; this.vmRar = rar;
    if (kind === SK.Weapon) this.kits.viewModel.equip(weaponId(id), rarityOf(rar), mythicOf(rar)?.color ?? null);
    else if (kind === SK.Consumable) this.kits.viewModel.equip(consumableId(id), rarityOf(rar));
    else this.kits.viewModel.equip(null);
    if (!first && kind !== 0) this.sfx("equip", { volume: 0.5 });
  }

  // ---------------------------------------------------------------- per frame
  private sfx(s: Sfx, o?: { volume?: number }) { this.kits.audio.play(s, o); }
  private readonly waterFx = new WaterFx();
  private readonly updraftFx: UpdraftFx;
  private readonly buffUi = new BuffOverlay();
  private readonly climbViews: ClimbViews;
  /** climbing: the gun lowered 0..1, the height at the last rung sound */
  private climbK = 0; private rungY = 0;
  private play(s: Sfx, x: number, y: number, z: number, volume: number) { POS3[0] = x; POS3[1] = y; POS3[2] = z; this.kits.audio.play(s, { pos: POS3, volume }); }
  private loop(id: Sfx) { if (this.loops.has(id)) return; this.loops.add(id); this.kits.audio.play(id, { loopId: id }); }
  private stopLoop(id: string) { if (!this.loops.has(id)) return; this.loops.delete(id); this.kits.audio.stopLoop(id); }
  private stopAllLoops() { for (const l of [...this.loops]) this.stopLoop(l); this.humLoop = -1; this.mythHum = -1; }
  private addTrauma(t: number) { this.trauma = Math.min(1, this.trauma + t); gamepads.rumble(Math.min(1, t * 1.1), Math.min(1, t * 0.8), 90 + t * 320); }
  name(id: number) { return id === this.cm.me ? this.myName : (this.names[id] ?? `KONG-${id}`); }

  // ---- interact highlight: what the E prompt points at gets an outline + rim (client/src/game/highlight.ts)
  private readonly hl: InteractHighlight;
  /** the prompt's target this frame: HL kind + id (chest / item / tuk-tuk id, pane index, zipline pole) */
  private hlKind = 0; private hlId = -1;
  private readonly hlRes = new THREE.Vector2();
  private readonly hlFill = (out: HlPart[]): number => {
    const id = this.hlId;
    switch (this.hlKind) {
      case HL.Chest: {
        const v = this.chestViews.get(id) as (ChestView & { hull?: THREE.BufferGeometry }) | undefined;
        if (!v?.hull || !v.object.visible) return 0;
        v.object.updateWorldMatrix(true, false); out[0].geometry = v.hull; out[0].matrix.copy(v.object.matrixWorld); return 1;
      }
      case HL.Box: { const c = this.cm.chests[id]; if (!c) return 0; out[0].geometry = boxHull(); out[0].matrix.makeRotationY(c.yaw).setPosition(c.x, c.y, c.z); return 1; }
      case HL.Item: { const v = this.lootViews.get(id) as (LootView & { holder?: THREE.Object3D }) | undefined; return v ? meshParts(v.holder ?? v.object, out) : 0; }
      case HL.Tuk: {
        const v = this.tuks.get(id); if (!v || !v.object.visible) return 0;
        const n = meshParts(v.object, out);
        // a helicopter's GLB is many big meshes: weld their hulls in idle slices, outline it once they are ready
        if (v.kind === VKind.Heli) { let ready = true; for (let j = 0; j < n; j++) if (!hullReady(out[j].geometry)) { prewarmHull(out[j].geometry); ready = false; } if (!ready) return 0; }
        return n;
      }
      case HL.Glass: {
        // the pane's face on the camera's side: the unit quad's x → along the pane, y → up, its normal → the pane normal
        const G = this.cm.glass.panes.geo, o = id * PG; if (o + PG > G.length) return 0;
        const cam = this.engine.camera.position, nx = G[o + 3], nz = G[o + 4], s = (cam.x - G[o]) * nx + (cam.z - G[o + 2]) * nz >= 0 ? 1 : -1, off = s * (G[o + 9] + 0.006);
        HM.set(G[o + 5] * G[o + 7] * 2, 0, nx, G[o] + nx * off, 0, G[o + 8] * 2, 0, G[o + 1], G[o + 6] * G[o + 7] * 2, 0, nz, G[o + 2] + nz * off, 0, 0, 0, 1);
        out[0].geometry = FRAME_GEO; out[0].matrix.copy(HM); return 1;
      }
      case HL.Zip: out[0].geometry = zipHull(id); out[0].matrix.identity(); return 1;
    }
    return 0;
  };
  // ---- map marker beams: your marker (+ squadmates', ClientMatch.squadMarks) as towers of light
  private readonly markers: MarkerBeams;
  private readonly markList: MarkerSpec[] = [];
  /** squadmates' markers (trios; the server relays {t:"mark"} to the squad only): pid → spot */
  private readonly squadMarkAt = new Map<number, { x: number; z: number }>();
  private readonly squadMarkRows: NonNullable<HudState["squadMarks"]> = [];
  /** my marker: set (map click, ping) or cleared — and shared with the squad (the server drops it in solo) */
  setMark(x: number | null, z = 0) {
    if (x === null) { if (!this.hud.dropMarker) return; this.hud.dropMarker = null; this.cm.link.sendJSON({ t: "mark", clear: true }); return; }
    this.hud.dropMarker = { x, z }; this.sfx("ui:click", { volume: 0.6 });
    this.cm.link.sendJSON({ t: "mark", x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 });
  }
  /** a squadmate placed / cleared a marker (JSON {t:"mark", pid, x, z} / {t:"mark", pid, clear}) */
  squadMark(m: Record<string, unknown>) {
    const pid = Number(m.pid); if (!Number.isInteger(pid) || pid === this.cm.me) return;
    if (m.clear === true || typeof m.x !== "number" || typeof m.z !== "number") { this.squadMarkAt.delete(pid); return; }
    this.squadMarkAt.set(pid, { x: m.x, z: m.z });
    if (!this.muteAnnounce) this.sfx("ui:click", { volume: 0.45 });
  }
  /** the ping key: the spot under the crosshair (terrain + the world, up to 3 km — from the plane, falling, gliding or
   * on foot) becomes my marker; pinging at it again (within 25 m) clears it */
  private ping() {
    const cm = this.cm, p = cm.pred; if (p.st === PS.Dead || p.st === PS.Spectate || this.kits.hud.mapOpen) return;
    const cam = this.engine.camera; cam.getWorldDirection(V3);
    cm.world.raycast(cam.position.x, cam.position.y, cam.position.z, V3.x, V3.y, V3.z, 3000, PING_HIT, false);
    if (!PING_HIT.hit) { this.sfx("ui:click", { volume: 0.25 }); return; }
    const x = cam.position.x + V3.x * PING_HIT.t, z = cam.position.z + V3.z * PING_HIT.t, mk = this.hud.dropMarker;
    if (mk && Math.hypot(mk.x - x, mk.z - z) < 25) this.setMark(null); else this.setMark(x, z);
  }
  private updateMarkers(dt: number) {
    if (this.input.takePing()) this.ping();
    const L = this.markList; L.length = 0;
    const mk = this.hud.dropMarker;
    if (mk) L.push(markSpec(0, mk.x, mk.z, UI_YELLOW, "me"));
    // squadmates' markers in their squad colours (the colour order of the squad rows / tags)
    const rows = this.squadMarkRows; rows.length = 0;
    if (this.squadMarkAt.size && this.cm.mode === "trios") {
      let k = 0; const team = this.cm.pred.team;
      for (const r of this.cm.remotes) {
        if (r.n <= 0 || r.team !== team || r.id === this.cm.me) continue;
        const sm = this.squadMarkAt.get(r.id), col = SQUAD_COLOURS[k++ % SQUAD_COLOURS.length];
        if (!sm || L.length >= 4) continue;
        L.push(markSpec(L.length, sm.x, sm.z, col, `p${r.id}`)); rows.push({ x: sm.x, z: sm.z, color: col });
      }
    }
    this.hud.squadMarks = rows;
    this.markers.update(dt, this.engine.camera.position, L);
  }
  // ---- location banner: the FIRST time you reach a named
  // place in a match its name comes up in the centre with its own faint sound (once per place per match: a
  // soft phrase per kind of place); every later arrival only names it by the minimap (silent)
  /** the POI I am in (index into POIS, −1 = none), one waiting to be announced, the places reached this match */
  private placeIn = -1; private placeWant = -1; private placeT = 0;
  private readonly placeSeen = new Uint8Array(POIS.length);
  private trackPlace(dt: number) {
    this.placeT += dt; if (this.placeT < 0.2) return; this.placeT = 0;
    const cm = this.cm, p = cm.pred, now = performance.now();
    if (this.range || cm.phase === 0 || p.st === PS.Dead || p.st === PS.Spectate || p.st === PS.Plane) { this.placeIn = -1; this.placeWant = -1; this.hud.where = null; return; }
    // hysteresis: in at 0.8 r, out past 1.05 r — hovering on a border never flips it
    let cur = this.placeIn;
    if (cur >= 0 && Math.hypot(p.x - POIS[cur].x, p.z - POIS[cur].z) > POIS[cur].r * 1.05) cur = -1;
    if (cur < 0) for (let i = 0; i < POIS.length; i++) { const q = POIS[i]; if (q.id !== "lobby-islet" && Math.hypot(p.x - q.x, p.z - q.z) < q.r * 0.8) { cur = i; break; } }
    if (cur !== this.placeIn) { this.placeIn = cur; this.placeWant = cur; if (cur < 0) this.hud.where = null; }
    if (this.placeWant < 0 || this.placeWant !== this.placeIn) { this.placeWant = -1; return; }
    // falling / gliding in: it waits for the arrival (below ~45 m over the ground), like a landing title
    if ((p.st === PS.Freefall || p.st === PS.Glide) && p.y - Math.max(0, this.engine.terrain.height(p.x, p.z)) > 45) return;
    const k = this.placeWant, first = !this.placeSeen[k];
    if (first && this.hud.announce && now - this.hud.announce.at < 4200) return;   // a storm / knock banner first
    this.placeWant = -1;
    const q = POIS[k];
    this.hud.place = { at: now, name: q.name, sub: POI_TAGLINE[q.id] ?? "", first };
    this.hud.where = q.name;
    if (!first) return;
    this.placeSeen[k] = 1;
    if (!this.muteAnnounce) this.sfx(`ui:poi:${POI_THEME[q.id] ?? "coast"}`);
  }
  private updateHighlight(dt: number) {
    const k = this.hlKind;
    this.engine.renderer.getDrawingBufferSize(this.hlRes);
    this.hl.update(dt, k ? HL_KEYS[k] + this.hlId : null, k ? this.hlFill : null, this.hlRes, HL_PUSH[k]);
  }

  update(dt: number, t: number) {
    const cm = this.cm, p = cm.pred, cam = this.engine.camera;
    this.frameDt = dt;
    this.fpsAcc += dt; this.fpsN++; if (this.fpsAcc > 0.5) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }
    cm.interpolate();
    this.range?.update(dt);
    this.glassFx.update(dt);
    this.stepFeel(dt);
    // ---- camera
    const spec = cm.viewTarget();
    const inPlane = p.st === PS.Plane;
    const dead = p.st === PS.Dead || p.st === PS.Spectate;
    const victory = this.victoryAt > 0 && cm.phase === 3;
    if (victory !== this.hudHidden) { this.hudHidden = victory; this.kits.hud.setVisible(!victory); }
    // leaving the plane: the camera flies from the chase view into the jumper's eyes on a critically damped
    // offset spring that starts with the chase camera's own velocity — no cut, no velocity step (dropCamera below)
    if (this.wasSt === PS.Plane && !inPlane && p.st === PS.Freefall) this.exitPending = true;
    this.deployLook(dt);
    this.stepPlaneClock(dt);
    const myVeh = !dead && !victory && !spec ? cm.myVehicle() : null;
    // third person (SETTINGS → Camera view): on foot and in the drop; never through the sniper scope (it is the eyes')
    const third = !this.caster && !victory && !spec && !dead && !inPlane && !myVeh && !p.scoped && preferences.value.thirdPerson && tpState(p.st);
    this.third = third;
    this.specSmooth(spec, dt);
    this.updateVehicles(dt, t);
    if (this.caster) this.caster.camera(dt);
    else if (victory) this.victoryCamera(dt);
    else if (spec) this.spectateCamera(spec, dt);
    else if (inPlane) this.planeCamera(dt);
    else if (dead) this.deathCamera(dt);
    else if (myVeh) this.rideCamera(dt, myVeh);
    else { this.firstPersonCamera(dt); if (third) this.thirdPersonCamera(dt); }
    if (!myVeh) this.rideOn = false;
    else if (p.seat !== this.rideSeatAt) { this.rideSeatAt = p.seat; this.rideAt = performance.now(); }
    // climbing in / out / swapping the view: the camera travels there (0.38 s) instead of cutting
    this.blendCamera(dt, victory || spec || inPlane || dead || this.caster ? -1 : myVeh ? (p.seat === 0 && this.rideThird ? 1 : 2 + p.seat) : third ? TP_CAM_MODE : 0);
    // the local door gunner holds TOP BANANA under its camera (actors/heli-tripo.ts gunnerView): after the camera is final
    if (myVeh && myVeh.kind === VKind.Heli) (this.tuks.get(myVeh.id) as (TukView & { gunnerView?(c: THREE.Camera | null): void }) | undefined)?.gunnerView?.(p.seat === HELI.GUN_SEAT && !dead ? this.engine.camera : null);
    this.dropCamera(dt, inPlane || dead || victory || !!spec || !!myVeh || !!this.caster);
    this.thirdAim();
    // actors: my own kong in first person while falling /
    // gliding — arms in frame in freefall, fists on the bar + legs below under the glider
    if (inPlane && !this.meActor && !this.meActorPending) { this.meActorPending = true; void this.kits.createKong(this.engine, { variant: Math.max(0, cm.me) % 6 }).then((a) => { this.meActor = a; a.setOutfit?.(outfitFor(cm.me, cm.seed)); a.setVisible(false); this.engine.scene.add(a.object); patchTree(this.engine, a.object); }); }
    if (inPlane) this.ensureMyGlider();
    this.windStreaks(dt, inPlane || dead || victory || !!spec);
    // (and drawn once off-screen while riding: programs, buffers and textures are warm before the exit / deploy frame)
    if (inPlane && !this.dropWarm && this.meActor && this.myGlider) {
      this.dropWarm = true; const roots = [this.meActor.object, this.myGlider.object, this.ensureWind()];
      void this.engine.compileObjects(roots).then(() => { if (this.cm.pred.st === PS.Plane) this.engine.warmDraw(roots); });
    }
    if (!victory && !spec && !dead && (p.st === PS.Freefall || p.st === PS.Glide)) {
      if (!this.meActor && !this.meActorPending) { this.meActorPending = true; void this.kits.createKong(this.engine, { variant: Math.max(0, cm.me) % 6 }).then((a) => { this.meActor = a; a.setOutfit?.(outfitFor(cm.me, cm.seed)); this.engine.scene.add(a.object); patchTree(this.engine, a.object); }); }
      if (this.meActor && (this.meActor.pov || third)) { const mp = this.mePose; this.dropBody(V3); mp.x = V3.x; mp.y = V3.y; mp.z = V3.z; mp.yaw = third ? this.dropYaw : this.input.yaw; mp.pitch = this.input.pitch; mp.vx = p.vx; mp.vy = p.vy; mp.vz = p.vz; mp.state = p.st === PS.Glide ? "glide" : "freefall"; mp.weapon = null; mp.team = p.team; mp.friendly = true; mp.crouch = false; mp.sprint = false; mp.fired = false; mp.reloading = false;
        // (third person: the kong as everybody else sees it in the drop — a plain apply() leaves the first-person body)
        this.meActor.setVisible(!third || this.tpShow);
        if (third) this.meActor.apply(mp, dt); else if (this.meActor.pov) { cam.updateMatrixWorld(); this.meActor.pov(cam, mp, dt); } }
    } else if (myVeh && p.seat === 0 && this.rideThird) {
      // at the bars, seen from behind: my own kong drives
      if (!this.meActor && !this.meActorPending) { this.meActorPending = true; void this.kits.createKong(this.engine, { variant: Math.max(0, cm.me) % 6 }).then((a) => { this.meActor = a; a.setOutfit?.(outfitFor(cm.me, cm.seed)); a.setVisible(false); this.engine.scene.add(a.object); patchTree(this.engine, a.object); }); }
      if (this.meActor) { const mp = this.mePose; this.seatPose(mp, myVeh, 0, myVeh.yaw + myVeh.oyaw, 0); mp.weapon = null; mp.team = p.team; mp.friendly = true; mp.crouch = false; mp.sprint = false; this.meActor.setVisible(true); this.meActor.apply(mp, dt); }
    } else if (third) {
      // third person on foot: my own kong, on the body the camera follows
      if (!this.meActor && !this.meActorPending) { this.meActorPending = true; void this.kits.createKong(this.engine, { variant: Math.max(0, cm.me) % 6 }).then((a) => { this.meActor = a; a.setOutfit?.(outfitFor(cm.me, cm.seed)); a.setVisible(false); this.engine.scene.add(a.object); patchTree(this.engine, a.object); }); }
      if (this.meActor) {
        const mp = this.mePose, s = p.slots[p.active]; this.footPose(mp);
        this.meActor.setVisible(this.tpShow); this.meActor.apply(mp, dt);
        this.kits.weapons.setHeldMythic?.(this.meActor.object, mp.weapon !== null && mythicOf(s.rarity) !== null);
      }
    } else if (this.meActor && !victory) this.meActor.setVisible(false);
    // scope (the only zoom in the game)
    const scoped = p.scoped && !spec;
    // weapons: aim-down-sights on every gun (right mouse): the sights come to the eye, FOV ×0.82, sens ×0.8
    const bench = p.st === PS.Ride && p.seat !== 0, atBars = p.st === PS.Ride && p.seat === 0;
    // the door gunner's own guns are holstered: no viewmodel; aim (right mouse) narrows the view onto the minigun's work
    const gunner = !!myVeh && gunOf(cm.vehs, p) !== null;
    const ads = !scoped && !spec && !victory && !inPlane && !dead && this.input.scopeHeld && (gunner || ((p.st === PS.Ground || bench) && p.slots[p.active].kind === SK.Weapon && p.reloadT <= 0 && !p.sprint));
    // freefall ~92-95 deg horizontal (a little wider as the dive speeds up), glide ~97, never wider than the
    // player's own FOV (+14 deg would be 118 deg h at 78 m/s: enough optical flow to make the ground sparkle)
    const air = p.st === PS.Freefall || p.st === PS.Glide;
    if (air || inPlane) this.airAt = performance.now();
    if (air) this.lastAirSt = p.st;
    const ffDive = Math.min(1, Math.max(0, (-p.vy - FF_DOWN) / (FF_DIVE_DOWN - FF_DOWN)));
    this.fovBase = (this.engine.shared.get("display:fov") as number | undefined) ?? this.fovBase;   // SETTINGS → VIDEO, live
    const airFov = Math.min(this.fovBase, p.st === PS.Freefall ? FREEFALL_FOV + (FREEFALL_FOV_MAX - FREEFALL_FOV) * ffDive : GLIDE_FOV);
    const targetFov = this.caster ? this.caster.fov : victory ? 46 : inPlane ? PLANE_FOV : scoped ? this.fovBase / (WEAPON_DEFS.sniper.scope ?? 6) : air ? airFov : (this.fovBase + (p.sprint && !preferences.value.reducedMotion ? 5 : 0) + (p.st === PS.Ground && p.mvT > 0 && !preferences.value.reducedMotion ? 7 : 0) + (p.buffT > 0 && p.st === PS.Ground && !preferences.value.reducedMotion ? 6 : 0) + (atBars && myVeh && !preferences.value.reducedMotion ? Math.min(8, Math.abs(myVeh.vf) * 0.55) : 0)) * (ads ? 0.82 : 1);
    if (this.caster) { this.fov = targetFov; this.fovV = 0; }
    else if (!victory && !scoped && !ads && !spec && performance.now() - this.airAt < 1500) {
      // the drop and the 1.5 s after landing: a critically damped spring (exact step) — no per-frame lerp steps, at most
      // ~0.3 deg / frame at 60 fps
      const w = 5, e = this.fov - targetFov, x = Math.exp(-w * dt), c = this.fovV + w * e;
      this.fov = targetFov + (e + c * dt) * x; this.fovV = (this.fovV - w * c * dt) * x;
    } else { this.fov += (targetFov - this.fov) * Math.min(1, dt * (scoped ? 18 : victory ? 2.5 : 7)); this.fovV = 0; }
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
    this.input.sensScale = scoped ? 1 / 6 : ads ? 0.8 : 1;
    this.input.aimMode = scoped ? 2 : ads ? 1 : 0;
    // scope sway (const.ts scopeSway) — the AIM wanders while scoped, strongest right after scoping in and after
    // each bolt; bullets follow the crosshair, so a good shot is timed through the sway centre. Removed on scope-out.
    // Hold breath (sprint key, the HUD bar "HOLD SHIFT · STEADY"): damps the sway for SCOPE_SWAY.breathS, then the lungs
    // are empty and the sway is worse until they half refill.
    { const S = SCOPE_SWAY;
      this.breathHold = scoped && this.input.sprintHeld() && !this.breathOut && this.breath > 0;
      if (this.breathHold) { this.breath -= dt / S.breathS; if (this.breath <= 0) { this.breath = 0; this.breathOut = true; this.breathHold = false; } }
      else { this.breath = Math.min(1, this.breath + dt / S.refillS); if (this.breathOut && this.breath >= 0.5) this.breathOut = false; }
      this.breathK += ((this.breathHold ? S.breathMul : this.breathOut ? S.outMul : 1) - this.breathK) * Math.min(1, dt * 6); }
    if (scoped) {
      const st = performance.now() / 1000; if (this.swayT0 < 0) this.swayT0 = st;
      scopeSway(st, st - this.swayT0, this.swayOut); const ny = this.swayOut[0] * this.breathK * DEG, np = this.swayOut[1] * this.breathK * DEG;
      this.input.yaw += ny - this.swayY; this.input.pitch += np - this.swayP; this.swayY = ny; this.swayP = np;
    } else if (this.swayT0 >= 0) { this.input.yaw -= this.swayY; this.input.pitch -= this.swayP; this.swayY = this.swayP = 0; this.swayT0 = -1; }
    this.kits.viewModel.setScoped(scoped); this.kits.viewModel.setAds?.(ads); this.adsOn = ads;
    // the viewmodel stays on in freefall / glide — it carries the parachute hands (weapons/viewmodel.ts AIR)
    // a banana bomb in hand: the throwing hand comes up, the gun goes down
    const bombHand = this.bombFx.firstPerson(!victory && !spec && !dead ? p.cookT : 0, dt, t);
    const casterHands = this.caster?.hands?.() ?? null;
    this.kits.viewModel.object.visible = casterHands ? true : !victory && !spec && !inPlane && !dead && !atBars && !gunner && !bombHand && !third;   // (both fists are on the bars / the gun's grips)
    // swimming: the gun stowed (the sim's swim gun timer) → both hands swim
    const swimHands = !victory && !spec && !dead && p.st === PS.Ground && p.swim && (p.under || p.swGun <= 0) && SWIM_DEV.hands;
    { const vm = this.kits.viewModel as ViewModel & Partial<AirHands>;
      vm.air?.(swimHands ? (p.under ? "under" : "swim") : !victory && !spec && !dead && p.st === PS.Freefall ? "freefall" : !victory && !spec && !dead && p.st === PS.Glide ? "glide" : null, this.dropYaw, swimHands ? p.sprint : this.input.sprintHeld());   // the smoothed drop look drives the steering pull
      vm.swimMotion?.(p.under ? Math.hypot(p.vx, p.vy, p.vz) : Math.hypot(p.vx, p.vz)); }
    // freefall / glide wind streaks (GPU-only: world-static air motes you fall past)
    const sp3 = Math.hypot(p.vx, p.vy, p.vz);
    const want = preferences.value.reducedMotion ? 0 : p.st === PS.Freefall ? Math.min(1, Math.max(0, (sp3 - 20) / 45)) : p.st === PS.Glide ? Math.min(0.35, sp3 / 90) : 0;
    const su = this.streakU; su.uAmt.value += (want - su.uAmt.value) * Math.min(1, dt * 4);
    this.streaks.visible = su.uAmt.value > 0.01;
    if (this.streaks.visible) { su.uCam.value.copy(cam.position); su.uVel.value.set(p.vx, p.vy, p.vz); su.uTime.value = t; }
    this.syncViewModel();
    // (treading water with the gun up: no walk bob, no airborne sag — the camera rides the water instead)
    this.kits.viewModel.update(dt, casterHands ?? { speed: p.st === PS.Ride || p.swim ? 0 : Math.hypot(p.vx, p.vz), grounded: p.grounded || p.swim, sprint: p.sprint && !p.swim, crouch: p.crouch, lookDX: this.input.dx, lookDY: this.input.dy });
    // my swim strokes: the sound + splash on the swim hands' beat
    { const vm = this.kits.viewModel as ViewModel & Partial<AirHands>, ev = vm.swimEvt?.() ?? 0;
      if (ev !== this.swimEvtSeen) { this.swimEvtSeen = ev; if (swimHands) this.swimStroke(p.x, p.y, p.z, this.input.yaw, vm.swimEvtKind?.() ?? 0, ev, true); } }
    // on a ladder / trunk the gun drops out of the way (both hands are on the rungs)
    { const want = p.st === PS.Climb ? 1 : 0; this.climbK += (want - this.climbK) * (1 - Math.exp(-dt * (want ? 9 : 6)));
      const vo = this.kits.viewModel.object; vo.position.y = -0.55 * this.climbK; vo.rotation.x = -0.75 * this.climbK; }
    this.input.dx = 0; this.input.dy = 0;
    // weapons: reload = a per-sim-tick edge (weapons/reload-edge.ts), exactly once per sim reload, cancels too
    this.reloadTrig.install(cm); this.reloadTrig.frame(p, this.kits.viewModel, () => this.sfx(`reload:${weaponId(p.slots[p.active].id)}`));
    // a use began since last frame (the timer jumped up; also a chained use straight after the previous one) — edge,
    // not "timer ≈ full", so a frame that saw several predicted ticks at once never misses it
    if (p.useT > this.lastUseT + 1e-4) { const c = CONSUMABLE_DEFS[consumableId(p.slots[p.active].id)]; this.kits.viewModel.use(p.useTotal); this.sfx(c && c.shield > 0 && c.hp === 0 ? "shield:use" : "heal:use"); }
    this.lastUseT = p.useT;
    this.stepSounds(dt);
    // water splashes / wakes / climb-out (water-fx.ts)
    this.waterFx.update(dt, cm, this.engine.shared.get("water") as WaterApi | undefined, (s, o) => this.sfx(s, o), (s, x, y, z, v) => this.play(s, x, y, z, v), this.engine.camera.position.x, this.engine.camera.position.z);
    this.climbViews.update(this.engine.camera.position);
    // the red banana's vignette + timer (ui/buff.ts)
    this.buffUi.update(dt, p.hp > 0 ? p.buffT : 0);
    // the volcano updraft column + its roar (updraft-fx.ts)
    this.updraftFx.update(dt, this.engine.camera.position, p.hp > 0 && p.st !== PS.Dead && p.st !== PS.Plane ? p : null, (s, o) => this.kits.audio.play(s, o), (id) => this.kits.audio.stopLoop(id));
    // state transitions → sounds
    if (p.st !== this.wasSt) {
      if (this.wasSt === PS.Plane && p.st === PS.Freefall && performance.now() - this.exitAt > 3000) this.onExitPlane();
      if (p.st === PS.Glide) { this.stopLoop("freefall:wind"); this.loop("glider:wind"); this.sfx("glider:open"); }
      if (p.st === PS.Freefall && this.wasSt === PS.Glide) { this.stopLoop("glider:wind"); this.loop("freefall:wind"); }
      if (p.st === PS.Ground) { this.stopLoop("freefall:wind"); this.stopLoop("glider:wind"); }
      // mantle: a hand-plant scuff going up, a soft landing on top
      if (p.st === PS.Mantle) { this.sfx(`step:${surfaceAt(this.engine.terrain, p.surf, p.x, p.z)}`, { volume: 0.9 }); this.mantleK = 1; }
      if (this.wasSt === PS.Mantle && p.st === PS.Ground) { this.sfx("land", { volume: 0.32 }); this.landDip = Math.max(this.landDip, 0.04); }
      if (p.st === PS.Climb) { this.sfx("climb:grab", { volume: 0.9 }); this.rungY = p.y; }
      if (this.wasSt === PS.Climb && p.st === PS.Ground && !p.grounded && p.vy > 2) this.sfx("jump", { volume: 0.5 });
      // (a helicopter's start / stop are its own: the rotor loop carries the rest)
      if (p.st === PS.Ride) { const heli = p.veh >= 0 && cm.vehs.list[p.veh]?.kind === VKind.Heli; if (!heli) this.sfx("tuk:start", { volume: p.seat === 0 ? 1 : 0.6 }); else if (p.seat === 0) this.sfx("heli:start", { volume: 0.9 }); this.rideAt = performance.now(); }
      else if (this.wasSt === PS.Ride && p.st === PS.Ground) { const heli = this.rideKind === VKind.Heli; if (!heli) this.sfx("tuk:stop", { volume: 0.7 }); }
      this.wasSt = p.st;
    }
    // climbing: a rung under hand / foot every ~0.34 m
    if (p.st === PS.Climb && Math.abs(p.y - this.rungY) > 0.34) { this.rungY = p.y; this.sfx("climb:rung", { volume: 0.75 }); }
    // crouch-slide start
    if (p.st === PS.Ground && p.mvT > 0 && this.lastMvT <= 0) { this.sfx("slide", { volume: 0.9 }); this.addTrauma(0.06); }
    this.lastMvT = p.st === PS.Ground ? p.mvT : 0;
    if (p.grounded && !this.wasGrounded && p.st === PS.Ground) { this.landDip = Math.max(this.landDip, 0.05); this.sfx("land", { volume: 0.45 }); }
    if (!p.grounded && this.wasGrounded && p.vy > 3) this.sfx("jump", { volume: 0.5 });
    this.wasGrounded = p.grounded;
    // ---- actors
    this.updateActors(dt, t);
    // ---- plane
    this.updatePlane(dt, t);
    // ---- loot & chests
    if (t - this.lastCull > 0.4 || t < this.lastCull) { this.lastCull = t; this.cullLoot(); }
    this.buildViews();
    if (this.grow.size) this.stepGrow(dt);
    for (const v of this.lootViews.values()) v.update(dt, t);
    if (this.drops.size) this.stepDrops();
    this.boxes.update(dt, cm.chests);
    // banana bombs: in flight, the arc while one cooks in our hand, the pin pull
    this.bombFx.update(dt, t);
    this.coverViews.update(dt);
    this.syncStands();
    // the stands' shopkeepers: only the ones near the camera animate / draw their detail
    { const c = this.engine.camera.position; tickStands(this.standViews, c.x, c.z, p.x, p.z, cm.econ.cash, t, dt); }
    { const a = p.slots[p.active], hold = a.kind === SK.Consumable && consumableId(a.id) === "crate-wall" && a.count > 0 && p.st === PS.Ground && !dead && !spec;
      this.coverOk = this.coverViews.preview(hold, p.x, p.y, p.z, this.input.yaw); this.coverHeld = hold; }
    { const cooking = p.cookT > 0 && !dead && !spec;
      if (cooking && this.lastCook <= 0) { this.sfx("equip", { volume: 0.7 }); this.fuseTickAt = 0.12; this.loops.add("bomb:fuse"); this.kits.audio.play("gun:hot", { loopId: "bomb:fuse", volume: 0.28, rate: 1.7 }); }
      // the peel fuse sizzles and ticks while it burns — faster and higher as it runs out
      if (cooking && p.cookT >= this.fuseTickAt) {
        const left = BOMB.fuseS - p.cookT;
        this.kits.audio.play("ui:click", { volume: 0.55 + 0.35 * (1 - left / BOMB.fuseS), rate: 1 + 0.6 * (1 - left / BOMB.fuseS) });
        this.fuseTickAt = p.cookT + (left > 2 ? 0.5 : left > 1 ? 0.33 : 0.16);
      }
      if (!cooking && this.lastCook > 0) this.stopLoop("bomb:fuse");
      this.lastCook = cooking ? p.cookT : 0;
      this.bombFx.arc(cooking, p.x, simEyeY(p), p.z, this.input.yaw, this.input.pitch, p.vx, p.vz, BOMB.fuseS - p.cookT); }
    // ---- rockets (client-side ballistic mirror of the server projectile)
    for (const r of this.rockets.values()) {
      r.life -= dt;
      if (r.life <= 0) { this.rocketEnd(r.id); continue; }                                 // never confirmed / ended: drop it
      if (!r.live) continue;
      r.vy -= WEAPON_DEFS.rocket.projectile!.gravity * dt;
      const nx = r.x + r.vx * dt, ny = r.y + r.vy * dt, nz = r.z + r.vz * dt;
      // it stops where it hits (the explosion arrives with the server's verdict) instead of flying through the wall
      this.cm.world.raycast(r.x, r.y, r.z, nx - r.x, ny - r.y, nz - r.z, 1, RHIT, true);
      if (RHIT.hit || ny < -1) { r.live = false; r.x = RHIT.hit ? RHIT.x : nx; r.y = RHIT.hit ? RHIT.y : ny; r.z = RHIT.hit ? RHIT.z : nz; r.mesh.position.set(r.x, r.y, r.z); continue; }
      r.x = nx; r.y = ny; r.z = nz;
      r.mesh.position.set(r.x, r.y, r.z); r.mesh.quaternion.setFromUnitVectors(V3.set(0, 1, 0), V3b.set(r.vx, r.vy, r.vz).normalize());
    }
    // ---- storm
    const s = cm.storm;
    if (s.phase >= 1 && cm.phase >= 1) this.kits.storm.set(s);
    else this.kits.storm.set(NO_STORM);
    const inside = this.kits.storm.update(dt, t, cam);
    if (inside > 0.5) this.loop("storm:loop"); else this.stopLoop("storm:loop");
    this.kits.fx.update(dt);
    // ---- audio listener
    cam.getWorldDirection(V3); V3b.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const ground = this.engine.terrain.height(cam.position.x, cam.position.z);
    LISTENER.pos[0] = cam.position.x; LISTENER.pos[1] = cam.position.y; LISTENER.pos[2] = cam.position.z;
    LISTENER.fwd[0] = V3.x; LISTENER.fwd[1] = V3.y; LISTENER.fwd[2] = V3.z; LISTENER.up[0] = V3b.x; LISTENER.up[1] = V3b.y; LISTENER.up[2] = V3b.z;
    ENV.biome = this.engine.terrain.biomeAt(cam.position.x, cam.position.z); ENV.inStorm = inside > 0.5; ENV.altitude = cam.position.y - ground; ENV.indoors = false;
    this.kits.audio.update(dt, LISTENER, ENV);
    // ---- HUD (a caster seat draws its own desk: client/src/caster)
    if (this.caster) return;
    this.fillHud(dt, inside);
    this.updateHighlight(dt);
    this.updateMarkers(dt);
    this.trackPlace(dt);
    this.kits.hud.update(this.hud, dt);
  }

  /** recoil recovery + camera punch springs + trauma decay */
  private stepFeel(dt: number) {
    const since = (performance.now() - this.lastShotAt) / 1000;
    // pulling the mouse down against the climb "spends" the recovery: never recover below where the burst started
    if (this.recoilP > 0) this.recoilP = Math.min(this.recoilP, Math.max(0, this.input.pitch - this.burstPitch0));
    if (since > 0.09 && (this.recoilP > 0 || this.recoilY !== 0)) {
      const k = Math.min(1, dt * this.recoverRate * 0.9);
      const bp = this.recoilP * k, by = this.recoilY * k;
      this.input.pitch -= bp; this.input.yaw += by; this.recoilP -= bp; this.recoilY -= by;
      if (this.recoilP < 1e-4) this.recoilP = 0;
    }
    // critically-damped-ish springs (stiff: the punch lasts ~120 ms)
    const K = 260, D = 2 * Math.sqrt(K) * 0.9, sdt = Math.min(dt, 1 / 60);
    for (let i = 0; i < 2; i++) {
      this.punchPV += (-K * this.punchP - D * this.punchPV) * sdt; this.punchP += this.punchPV * sdt;
      this.punchYV += (-K * this.punchY - D * this.punchYV) * sdt; this.punchY += this.punchYV * sdt;
      this.punchRV += (-K * this.punchR - D * this.punchRV) * sdt; this.punchR += this.punchRV * sdt;
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.4); this.shakeT += dt;
  }
  /** camera rotation offsets from punch + trauma shake, written into E (added on top of the aim) */
  private feelOffsets(): [number, number, number] {
    // reduced motion (SETTINGS → ACCESSIBILITY): no trauma shake; the recoil punch stays (it is the aim's own kick)
    const s = preferences.value.reducedMotion ? 0 : this.trauma * this.trauma, t = this.shakeT;
    FEEL[0] = this.punchP + s * 0.035 * (Math.sin(t * 37.1) + 0.5 * Math.sin(t * 71.3));
    FEEL[1] = this.punchY + s * 0.035 * (Math.sin(t * 41.7 + 1.3) + 0.5 * Math.sin(t * 63.9));
    FEEL[2] = this.punchR + s * 0.05 * Math.sin(t * 29.3 + 2.1);
    return FEEL;
  }

  /** swimming: one stroke's sound + splash, on the beat of the arms — another kong's from its
   *  animator (3P), mine from the swim hands (1P). kind 0 surface breaststroke, 1 crawl pull, 2 treading kick, 3 under
   *  water (heard only by a listener under water too); n = the counter (the crawl alternates sides) */
  swimStroke(x: number, y: number, z: number, yaw: number, kind: number, n: number, local: boolean, dist = 0) {
    if (local && !SWIM_DEV.local) return;
    if (kind === 3) {
      if (!SWIM_DEV.sfx) return;
      if (local) this.sfx(SWIM_SFX.uwStroke, { volume: 0.85 });
      else if (dist < 25 && this.waterApi()?.isUnderwater()) this.play(SWIM_SFX.uwStroke, x, y + 0.6, z, 0.7);
      return;
    }
    const snd = kind === 1 ? SWIM_SFX.strokeFast : kind === 2 ? SWIM_SFX.tread : SWIM_SFX.stroke;
    const vol = kind === 2 ? 0.55 : kind === 1 ? 0.95 : 0.85;
    if (SWIM_DEV.sfx) { if (local) this.sfx(snd, { volume: vol }); else this.play(snd, x, WATER_Y, z, vol); }
    const water = this.waterApi();
    if (!water || dist > 48 || !SWIM_DEV.splash) return;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // the breaststroke: both hands breaking the surface ahead; the crawl: one hand going in.
    // (mine: further out and softer — a full splash right under the camera drew hard white spikes)
    const k = local ? 0.45 : 1, ah = local ? 0.6 : 0;
    if (kind === 0) for (const s of [1, -1]) water.disturb(x + fx * (0.75 + ah) + rx * 0.45 * s, z + fz * (0.75 + ah) + rz * 0.45 * s, 0.45, 0.03 * k, 0.55 * k);
    else if (kind === 1) { const s = n & 1 ? 1 : -1; water.disturb(x + fx * (0.95 + ah) + rx * 0.35 * s, z + fz * (0.95 + ah) + rz * 0.35 * s, 0.4, 0.045 * k, 0.8 * k); }
    // (treading: no ripple — a still swimmer must let the interactive water sleep: its GPU passes run while
    //  anything disturbs it; measured: +0.8 ms GPU at a treading spot)
  }
  private waterApi() { return this.engine.shared.get("water") as WaterApi | undefined; }

  /** footsteps (me + nearby remotes), storm damage ticks, shield break, dry fire, chest hum */
  private stepSounds(dt: number) {
    const cm = this.cm, p = cm.pred, now = performance.now();
    // (swimming: no strides — the swim hands' beat voices the strokes, swimStroke)
    if (p.st === PS.Ground && p.grounded && !p.swim && p.hp > 0) {
      const sp = Math.hypot(p.vx, p.vz);
      this.stepAcc += sp * dt;
      const stride = p.sprint ? 2.75 : p.crouch ? 1.4 : 2.1;
      if (this.stepAcc > stride && sp > 0.8 && p.mvT <= 0) {
        this.stepAcc = 0;
        const s: Surface = surfaceAt(this.engine.terrain, p.surf, p.x, p.z);
        this.sfx(`step:${s}`, { volume: p.crouch ? 0.3 : p.sprint ? 0.85 : 0.6 });
      }
    } else this.stepAcc = 0;
    // storm damage tick (the sim drains hp outside the circle; make it felt + heard, ~1/s)
    // the storm bites once a second: 700 ms so jitter never skips one
    if (cm.phase === 2 && this.hud.inStorm && p.hp < this.prevHp - 0.01 && p.st === PS.Ground && now - this.lastStormTick > 700) {
      this.lastStormTick = now; this.sfx("storm:damage", { volume: 0.8 }); this.addTrauma(0.08);
    }
    if (this.prevShield > 0 && p.shield <= 0 && p.hp > 0) this.sfx("shield:break");
    this.prevShield = p.shield; this.prevHp = p.hp;
    // dry fire (a door gunner's: the empty belt clicks while the trigger is held)
    const slot = p.slots[p.active], gv = gunOf(cm.vehs, p);
    if (gv) { if (this.input.fire && this.input.engaged && gv.gunBelt <= 0 && now - this.gunDryAt > 260) { this.gunDryAt = now; this.sfx("gun:dry"); } }
    else if (this.input.fire && this.input.engaged && slot.kind === SK.Weapon && slot.mag === 0 && p.reloadT <= 0 && now - this.lastDry > 320) {
      const w = WEAPON_DEFS[weaponId(slot.id)]; const ai = ["light", "heavy", "shells", "rockets"].indexOf(w.ammo);
      if (p.ammo[ai] <= 0) { this.lastDry = now; this.sfx("dryfire"); }
    }
    // the nearest closed chest hums (positional loop): starts within HUM_R, keeps going to HUM_KEEP (no flip-flop at
    // the edge), silent for HUM_MUTE_MS after you opened one
    if (p.st === PS.Ground && p.hp > 0 && now >= this.humMuteUntil) {
      const cur = this.humLoop >= 0 ? cm.chests[this.humLoop] : undefined;
      const keep = cur && !cur.opened && Math.hypot(cur.x - p.x, cur.z - p.z, (cur.y - p.y) * 0.5) < HUM_KEEP ? cur : null;
      const c = keep ?? cm.nearestChest(HUM_R, false, true);
      const id = c ? c.id : -1;
      if (id !== this.humLoop) {
        if (this.humLoop >= 0) this.stopLoop("chest:hum");
        this.humLoop = id;
        if (c) { this.loops.add("chest:hum"); POS3[0] = c.x; POS3[1] = c.y + 0.5; POS3[2] = c.z; this.kits.audio.play("chest:hum", { pos: POS3, loopId: "chest:hum", volume: 0.7 }); }
      }
    } else if (this.humLoop >= 0) { this.stopLoop("chest:hum"); this.humLoop = -1; }
    // a mythic gun on the floor
    // hums too — the chest hum pitched up into a shimmer — the nearest one within MYTH_HUM_R (scanned 4× a second). Like
    // the chest hum: silent for HUM_MUTE_MS after I open a
    // chest (the mythic it spills is right there), on the ground only, never in the firing range (its rack)
    if (now >= this.mythScanAt) {
      this.mythScanAt = now + 250;
      let best: Item | null = null, bd = MYTH_HUM_R;
      // (a mythic lying by an OPENED chest is that chest's own spill — never a hum there: it read as the chest still humming)
      if (p.hp > 0 && p.st === PS.Ground && !this.range && now >= this.humMuteUntil) for (const it of cm.items.values()) {
        if (it.kind !== IK.Weapon || it.rarity < MYTHIC_R) continue;
        const d = Math.hypot(it.x - p.x, it.y - p.y, it.z - p.z); if (d >= bd) continue;
        let spill = false; for (const c of cm.chests) if (c.opened && Math.abs(c.x - it.x) < 3 && Math.abs(c.z - it.z) < 3 && Math.abs(c.y - it.y) < 2) { spill = true; break; }
        if (!spill) { bd = d; best = it; }
      }
      const id = best ? best.id : -1;
      if (id !== this.mythHum) {
        if (this.mythHum >= 0) this.stopLoop("mythic:hum");
        this.mythHum = id;
        if (best) { this.loops.add("mythic:hum"); POS3[0] = best.x; POS3[1] = best.y + 0.4; POS3[2] = best.z; this.kits.audio.play("chest:hum", { pos: POS3, loopId: "mythic:hum", volume: 0.65, rate: 1.5 }); }
      }
    }
  }

  private firstPersonCamera(dt: number) {
    const cm = this.cm, p = cm.pred, cam = this.engine.camera;
    this.dropPose(V3, dt);
    const eye = p.st === PS.Ground && p.under ? UW_EYE : p.st === PS.Ground && p.swim ? SWIM_EYE : (p.st === PS.Ground || p.st === PS.Mantle) && p.crouch ? (p.st === PS.Ground && p.mvT > 0 ? 0.92 : 1.05) : 1.65;   // (a crouched Mantle = the window vault)
    // view bob
    const speed = Math.hypot(p.vx, p.vz);
    // (the landing-to-run hand-off: the bob amplitude eases in / out instead of switching with `grounded` —
    // a touchdown on a roof edge toggled it every few frames: 0.2 deg roll + 1-3 cm eye snaps)
    const climbV = p.st === PS.Climb ? Math.abs(p.vy) : 0;
    const bobWant = p.grounded && p.st === PS.Ground && p.mvT <= 0 ? Math.min(1, speed / SPRINT) * (p.sprint ? 0.032 : 0.018) : climbV > 0 ? Math.min(1, climbV / 3.4) * 0.026 : 0;
    // reduced motion: no bob, landing dip, mantle pitch or camera roll (the springs keep running underneath)
    const motion = preferences.value.reducedMotion ? 0 : 1;
    const bobAmp = motion * (this.bobAmpS += (bobWant - this.bobAmpS) * (1 - Math.exp(-dt * 10)));
    this.bobT += climbV > 0 ? dt * 7.5 * Math.min(1, climbV / 2.5) : dt * (p.sprint ? 11 : 8.5) * Math.min(1, speed / 3);
    this.landDip = Math.max(0, this.landDip - dt * 0.5);
    // (a drop landing has its own knee: the dropPose fold carries the descent into the spring — no extra dip)
    const dip = this.landDip > 0 && performance.now() - this.airAt > 250 ? Math.sin(Math.min(1, this.landDip / 0.12) * Math.PI) * 0.09 : 0;
    // a window vault ducks at once: at the 14/s rate the eye was still ~1.5 m up as the glide
    // began and passed through the wall over the window
    this.eyeSmooth += (eye - this.eyeSmooth) * Math.min(1, dt * (p.st === PS.Mantle && p.crouch ? 45 : 14));
    // stairs, ledges and bumpy ground read as a smooth ramp: on foot, the eye trails the body's height changes (a step
    // snaps the body up to STEP_H in one tick) on a critically damped spring (exact step: stable at any dt), settling
    // in ~0.2 s. In the air it lets go at once.
    const onFoot = p.st === PS.Ground && p.grounded && !p.swim;
    if (onFoot && this.footOn) this.stepOff = Math.max(-0.6, Math.min(0.6, this.stepOff - (V3.y - this.footY)));
    { const w = onFoot ? 18 : 30, e = Math.exp(-w * dt), c = this.stepV + w * this.stepOff;
      this.stepV = (this.stepV - w * c * dt) * e; this.stepOff = (this.stepOff + c * dt) * e; }
    this.footY = V3.y; this.footOn = onFoot;
    // swimming: the head rides the stroke (rises with the in-sweep's breath, settles in the glide), the crawl rolls the
    // view a little, treading bobs gently, under water a slow sway — small (≤ 3.5 cm): the waterline must not bounce
    { const vm = this.kits.viewModel as ViewModel & Partial<AirHands>, ph = p.st === PS.Ground && p.swim ? vm.swimPhase?.() ?? -1 : -1, bl = vm.swimBlend?.() ?? null;
      let by = 0, br = 0;
      if (ph >= 0 && bl) {
        const u = ph - Math.floor(ph), m = bl[0], cr = p.under ? 0 : bl[1] * m, st = m - cr, t = this.engine.time;
        const lift = u > 0.22 && u < 0.55 ? Math.sin(Math.PI * (u - 0.22) / 0.33) : 0;
        by = p.under ? 0.012 * Math.sin(t * 2.6) : st * (0.034 * lift - 0.012) + (1 - m) * 0.012 * Math.sin(t * 5.34) + cr * 0.01 * Math.sin(ph * Math.PI * 4);
        br = p.under ? 0.012 * Math.sin(t * 1.3) : cr * 0.022 * Math.sin(ph * Math.PI * 2);
      }
      const k = 1 - Math.exp(-dt * 10); this.swimBob += (by - this.swimBob) * k; this.swimRoll += (br - this.swimRoll) * k; }
    cam.position.set(V3.x, V3.y + this.eyeSmooth + this.stepOff + Math.sin(this.bobT * 2) * bobAmp - dip * motion + this.swimBob * motion, V3.z).add(this.poseOff);
    const f = this.feelOffsets();
    // freefall: a gentle wobble from the wind; glide: bank into turns
    let roll = Math.sin(this.bobT) * bobAmp * 0.6 + f[2] + this.swimRoll;
    // slide: lean into it + a low, fast eye; mantle: the view dips and rolls with the arms pulling up
    this.slideLean += ((p.st === PS.Ground && p.mvT > 0 && p.grounded ? 0.07 : 0) - this.slideLean) * Math.min(1, dt * 10);
    roll += this.slideLean;
    let mPitch = 0;
    if (p.st === PS.Mantle) { const u = Math.min(1, p.mvT / 0.35); mPitch = -Math.sin(u * Math.PI) * 0.09; roll += Math.sin(u * Math.PI) * 0.035; }
    this.mantleK = Math.max(0, this.mantleK - dt * 3);
    // glide: bank into A / D on a critically damped spring (not a per-frame lerp, which snapped to 0 on exit)
    { const target = p.st === PS.Glide ? -this.cm.cur.mx * 0.22 : 0, w = 6, e = this.bank - target, x = Math.exp(-w * dt), c = this.bankV + w * e;
      this.bank = target + (e + c * dt) * x; this.bankV = (this.bankV - w * c * dt) * x; roll += this.bank; }
    // freefall: a slow wind wobble that fades in / out with the state (no step at exit / deploy)
    this.wobbleK += ((p.st === PS.Freefall ? 1 : 0) - this.wobbleK) * (1 - Math.exp(-dt * 2.5));
    roll += Math.sin(this.engine.time * 2.1) * 0.012 * this.wobbleK;
    const look = this.dropLook(dt, p.st === PS.Freefall || p.st === PS.Glide);
    E.set(look[0] + f[0] + mPitch * motion, look[1] + f[1], roll * motion, "YXZ");
    cam.quaternion.setFromEuler(E);
    // swim: eye at the surface
    // (a SMOOTH max — a glide into the sea used to sink the eye and then kink it onto 0.35 m in one frame)
    // (swimming: the eye rides the swell — the sea heaves ±0.3 m out here; a fixed eye went under every crest)
    { const on = p.swim && !p.under && p.st === PS.Ground, ws = on ? this.waterApi()?.surfaceAt(cam.position.x, cam.position.z, this.engine.time) ?? 0 : 0;
      this.swellS += (ws - this.swellS) * (1 - Math.exp(-dt * (on ? 12 : 4))); cam.position.y += this.swellS; }
    if (p.swim && !p.under) { const y = cam.position.y, m = 0.26 + this.swellS, d = y - m; cam.position.y = m + 0.5 * (d + Math.sqrt(d * d + 0.0225)); }
    // a hard entry dips the eye under the surface for a moment
    cam.position.y += this.waterFx.dipY() * motion;
  }
  /** third person (SETTINGS → Camera view). On foot: over the shoulder — the head on the same smoothed body and eye
   *  springs as the first-person eye (no walk bob: the kong's own gait shows it), the camera beside it and back along the
   *  whole look, so the crosshair stays the screen's centre. Aiming down sights pulls it in. In the drop it hangs straight
   *  behind the body, farther back (and higher under the glider), on the drop's smoothed look. Walls pull it in at once
   *  (the side leg, then the back leg) and let it out slowly; it never goes under the ground or, swimming, the sea. Runs
   *  after firstPersonCamera, which keeps every eye spring warm for a switch back. */
  private thirdPersonCamera(dt: number) {
    const cm = this.cm, p = cm.pred, cam = this.engine.camera, b = this.body, w = cm.world;
    const air = p.st === PS.Freefall || p.st === PS.Glide, pitch = this.lookS[0], yaw = this.lookS[1];
    const k = 1 - Math.exp(-dt * 8);
    this.tpDist += ((p.st === PS.Glide ? TP_GLIDE_DIST : air ? TP_FALL_DIST : this.adsOn ? TP_ADS_DIST : TP_DIST + (p.sprint ? 0.3 : 0)) - this.tpDist) * k;
    this.tpSide += ((air ? 0 : preferences.value.shoulder === "left" ? -1 : 1) - this.tpSide) * k;
    // the head: the first-person eye without its bob, dip and roll (eyeSmooth carries crouch, slide and swim heights)
    const hx = b.x, hy = b.y + (p.st === PS.Glide ? TP_GLIDE_UP : air ? TP_FALL_UP : this.eyeSmooth + this.stepOff + (p.swim && !p.under ? this.swellS : 0)), hz = b.z;
    // the shoulder point (right = (cos yaw, −sin yaw)); a wall on that side shortens it
    const so = TP_SIDE * this.tpSide, up = air ? 0 : TP_UP, rx = Math.cos(yaw) * so, rz = -Math.sin(yaw) * so, sl = Math.hypot(so, up);
    const su = sl > 1e-3 ? Math.min(1, camCast(w, hx, hy, hz, hx + rx, hy + up, hz + rz, 0.2) / sl) : 1;
    this.tpSideFree = su < this.tpSideFree ? su : this.tpSideFree + (su - this.tpSideFree) * Math.min(1, dt * 4);
    const sx = hx + rx * this.tpSideFree, sy = hy + up * this.tpSideFree, sz = hz + rz * this.tpSideFree;
    // back along the look
    const cp = Math.cos(pitch), fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp, d = this.tpDist;
    let cx = sx - fx * d, cy = sy - fy * d; const cz = sz - fz * d;
    cy = Math.max(cy, this.engine.terrain.height(cx, cz) + 0.3);
    if (p.swim && !p.under) cy = Math.max(cy, WATER_Y + 0.3);
    const want = Math.hypot(cx - sx, cy - sy, cz - sz), free = camCast(w, sx, sy, sz, cx, cy, cz, 0.25), u = want > 1e-3 ? Math.min(1, free / want) : 1;
    this.tpFree = u < this.tpFree ? u : this.tpFree + (u - this.tpFree) * Math.min(1, dt * 3.5);
    cx = sx + (cx - sx) * this.tpFree; cy = sy + (cy - sy) * this.tpFree;
    cam.position.set(cx, cy, sz + (cz - sz) * this.tpFree);
    const f = this.feelOffsets();
    E.set(pitch + f[0], yaw + f[1], f[2] * 0.5 + (air ? this.bank * 0.5 : 0), "YXZ");
    cam.quaternion.setFromEuler(E);
    this.tpShow = Math.hypot(cam.position.x - hx, cam.position.y - hy, cam.position.z - hz) > 0.75;
  }
  /** third person: aim from the EYES (where the server traces my shots from) at the point under the crosshair — the first
   *  thing the camera's centre ray meets past my own kong: a wall, the ground, the sea, a kong's hitbox (the trace the
   *  shot prediction uses) or the end of a bullet's range. GameInput.aimDYaw / aimDPitch carry the difference into the
   *  next inputs (client.ts). Zero in first person, in the drop and in vehicles. */
  private thirdAim() {
    const inp = this.input, p = this.cm.pred;
    if (!this.third || p.st === PS.Freefall || p.st === PS.Glide) { inp.aimDYaw = 0; inp.aimDPitch = 0; return; }
    const c = this.engine.camera.position, b = this.body, yaw = inp.yaw, pitch = inp.pitch, cp = Math.cos(pitch);
    const dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
    const ex = b.x, ey = b.y + simEyeY(p) - p.y, ez = b.z;
    // start level with the eyes: what lies between the camera and my kong cannot be aimed at
    const t0 = Math.max(0, (ex - c.x) * dx + (ey - c.y) * dy + (ez - c.z) * dz);
    const ox = c.x + dx * t0, oy = c.y + dy * t0, oz = c.z + dz * t0;
    traceShot(this.cm.world, ox, oy, oz, dx, dy, dz, this.cm.viewTargets, this.cm.remotes.length, AIM_HIT);
    const vx = ox + dx * AIM_HIT.t - ex, vy = oy + dy * AIM_HIT.t - ey, vz = oz + dz * AIM_HIT.t - ez, h = Math.hypot(vx, vz);
    // (the point is at my own feet or straight overhead: keep the look)
    if (h < 0.6) { inp.aimDYaw = 0; inp.aimDPitch = 0; return; }
    inp.aimDYaw = Math.max(-TP_AIM_MAX, Math.min(TP_AIM_MAX, wrapPi(Math.atan2(-vx, -vz) - yaw)));
    inp.aimDPitch = Math.max(-TP_AIM_MAX, Math.min(TP_AIM_MAX, Math.atan2(vy, h) - pitch));
  }
  /** my kong as the third-person camera shows it: on the drawn body (the camera's own pivot, so they never jitter
   *  apart), facing where it aims, in the sim's state, holding what my hands hold */
  private footPose(mp: KongPose) {
    const p = this.cm.pred, b = this.body, inp = this.input, sp = Math.hypot(p.vx, p.vz), s = p.slots[p.active];
    mp.x = b.x; mp.y = b.y + (p.swim && !p.under && p.st === PS.Ground ? this.swellS : 0); mp.z = b.z;
    mp.yaw = inp.yaw + inp.aimDYaw; mp.pitch = inp.pitch + inp.aimDPitch;
    // a climber's body faces its ladder / trunk whatever it looks at (as updateActors draws everybody else)
    if (p.st === PS.Climb) { const c = this.climbViews.nearest(p.x, p.y, p.z); if (c) mp.yaw = Math.atan2(c.nx, c.nz); }
    mp.vx = p.vx; mp.vy = p.vy; mp.vz = p.vz;
    mp.state = p.swim && p.st === PS.Ground ? (p.under ? "dive" : "swim") : p.st === PS.Mantle ? "mantle" : p.st === PS.Zip ? "zip" : p.st === PS.Climb ? "climb"
      : !p.grounded ? (p.vy > 1 ? "jump" : "fall") : p.crouch && p.mvT > 0 ? "slide" : sp > 0.6 ? "move" : "idle";
    mp.crouch = p.crouch; mp.sprint = p.sprint;
    // (swimming with the gun stowed: both arms stroke)
    mp.weapon = s.kind === SK.Weapon && !(p.swim && (p.under || p.swGun <= 0)) ? weaponId(s.id) : null;
    mp.fired = performance.now() - this.meFireAt < 90; mp.reloading = p.reloadT > 0; mp.hurt = false;
    mp.team = p.team; mp.friendly = true; mp.seatPitch = 0; mp.seatRoll = 0; mp.grips = null;
  }
  /** the drop's look is spring-smoothed — a critically damped follow of the mouse
   *  (w 25: 63 % of a turn-rate change in ~85 ms, no overshoot) instead of every mouse step landing in one frame. The sim
   *  still steers with the raw input. Off on foot: after a landing it holds 0.4 s, stiffens over 0.6 s and hands back. */
  private dropLook(dt: number, air: boolean): readonly [number, number] {
    const L = this.lookS, iy = this.input.yaw, ip = this.input.pitch, P = this.lookPrev;
    if (air && !this.lookOn) { this.lookOn = true; L[0] = P[0] = ip; L[1] = P[1] = iy; this.lookV[0] = this.lookV[1] = 0; }
    if (!this.lookOn) { L[0] = P[0] = ip; L[1] = P[1] = iy; return L; }
    const since = air ? 0 : performance.now() - this.airAt;
    const w = 25 + Math.min(1, Math.max(0, since - 400) / 600) ** 2 * 175, x = Math.exp(-w * dt);
    // exact for a target that moved LINEARLY over the frame (first-order hold): the lag never depends on the frame time
    // (a zero-order-hold step lags R·dt less on a long frame -> fake rate overshoot at uneven frame pacing)
    for (let k = 0; k < 2; k++) {
      const tgt = k === 0 ? ip : iy, u = dt > 0 ? (tgt - P[k]) / dt : 0;
      const y = L[k] - P[k] + 2 * u / w, yv = this.lookV[k] - u, c = yv + w * y;
      L[k] = (y + c * dt) * x + tgt - 2 * u / w; this.lookV[k] = (yv - w * c * dt) * x + u;
      P[k] = tgt;
    }
    if (!air && since > 1000 && Math.abs(L[0] - ip) + Math.abs(L[1] - iy) < 2e-4) { this.lookOn = false; L[0] = ip; L[1] = iy; }
    return L;
  }
  /** the glider opening lifts the view from the dive toward
   *  the glide look (-29 deg, the horizon in the upper fifth) over ~0.8 s on an eased, critically damped curve —
   *  instead of gliding on staring straight down into the canopy (which also kept the sim's
   *  glide-dive engaged: 22 m/s sink into a hard knee). Additive on the player's own pitch: the mouse keeps working
   *  through it, and looking up past the glide look ends it. */
  private deployLook(dt: number) {
    const p = this.cm.pred, inp = this.input;
    if (this.wasSt === PS.Freefall && p.st === PS.Glide && inp.pitch < DEPLOY_LOOK - 0.05) { this.dlTotal = DEPLOY_LOOK - inp.pitch; this.dlT = 0; this.dlDone = 0; }
    if (this.dlTotal <= 0) return;
    if (p.st !== PS.Glide || inp.pitch >= DEPLOY_LOOK || this.dlT > 1.4) { this.dlTotal = 0; return; }
    this.dlT += dt;
    const w = 6.5, s = 1 - (1 + w * this.dlT) * Math.exp(-w * this.dlT), want = this.dlTotal * s;
    inp.pitch = Math.min(DEPLOY_LOOK, inp.pitch + want - this.dlDone); this.dlDone = want;
  }
  private dlTotal = 0; private dlT = 0; private dlDone = 0;
  private readonly lookPrev: [number, number] = [0, 0];
  private readonly lookS: [number, number] = [0, 0]; private readonly lookV: [number, number] = [0, 0]; private lookOn = false;
  /** the camera's (smoothed) yaw in the drop: the glider follows it */
  get dropYaw() { return this.lookOn ? this.lookS[1] : this.input.yaw; }
  /** the jumper's render pose. In the air a uniform quadratic B-spline through the last three sim ticks
   *  (rebuilt from the air step x += v dt) instead of the straight line between the last two: the drawn velocity is
   *  continuous across ticks — no 60 Hz kinks at 144 fps — half a tick (8 ms) later. Any jump between the sources (into
   *  the air, the landing) is folded into an offset spring that starts with the old velocity: the camera never jumps,
   *  and a landing becomes a short knee bend instead of a dead stop. */
  private dropPose(out: THREE.Vector3, dt: number) {
    const cm = this.cm, p = cm.pred;
    cm.localPose(out);
    const air = p.st === PS.Freefall || p.st === PS.Glide;
    if (air) {
      const f = Math.min(1, cm.acc / DT), a = (1 - f) * (1 - f) / 2, c = f * f / 2, b = 1 - a - c;
      // P2 = the newest tick, P1 = P2 - v dt, P0 = P1 - (v - a dt) dt (the spring accelerations ride in fallV / mvT / mvY)
      const x1 = p.x - p.vx * DT, y1 = p.y - p.vy * DT, z1 = p.z - p.vz * DT;
      const x0 = x1 - (p.vx - p.mvT * DT) * DT, y0 = y1 - (p.vy - p.fallV * DT) * DT, z0 = z1 - (p.vz - p.mvY * DT) * DT;
      out.set(a * x0 + b * x1 + c * p.x + cm.errX, a * y0 + b * y1 + c * p.y + cm.errY, a * z0 + b * z1 + c * p.z + cm.errZ);
    }
    const O = this.poseOff, OV = this.poseOffV, L = this.poseLast;
    if (air !== this.poseAir && this.poseValid && dt > 0) {
      // where the old source would be now (its last value + its velocity), minus the new source = the offset to bleed out
      O.x += L.x + this.poseVel.x * dt - out.x; O.y += L.y + this.poseVel.y * dt - out.y; O.z += L.z + this.poseVel.z * dt - out.z;
      OV.copy(this.poseVel);
      if (!air) { OV.x -= p.vx; OV.y -= p.vy; OV.z -= p.vz; } else OV.set(0, 0, 0);
      if (O.lengthSq() > 25) { O.set(0, 0, 0); OV.set(0, 0, 0); }      // a teleport (respawn, state correction): cut
      this.poseFresh = true;
    }
    this.poseAir = air;
    if (dt > 0) { if (this.poseValid) this.poseVel.set((out.x - L.x) / dt, (out.y - L.y) / dt, (out.z - L.z) / dt); L.copy(out); this.poseValid = true; }
    // the offset decays critically damped (vertical w 15: a ~9 m/s glide landing dips ~20 cm; horizontal w 20) and is
    // added to the camera AFTER the on-foot step spring (firstPersonCamera), which must not see it as a step
    if (this.poseFresh) this.poseFresh = false;          // the offset is "now": it starts decaying next frame
    else if (O.lengthSq() > 1e-8 || OV.lengthSq() > 1e-8) { dampAxis(O, OV, "x", 20, dt); dampAxis(O, OV, "y", 15, dt); dampAxis(O, OV, "z", 20, dt); }
    else { O.set(0, 0, 0); OV.set(0, 0, 0); }
    this.body.copy(out).add(O);
  }
  /** the body pose the drop camera was built on this frame (glider, POV kong: no jitter against the camera) */
  private dropBody(out: { x: number; y: number; z: number }) { const b = this.body; out.x = b.x; out.y = b.y; out.z = b.z; }
  private readonly body = new THREE.Vector3(); private poseFresh = false;
  private readonly poseOff = new THREE.Vector3(); private readonly poseOffV = new THREE.Vector3(); private readonly poseLast = new THREE.Vector3(); private readonly poseVel = new THREE.Vector3();
  private lastAirSt: number = PS.Ground; private dropWarm = false; private bobAmpS = 0;
  private poseAir = false; private poseValid = false; private airAt = -1e9; private fovV = 0; private bankV = 0; private wobbleK = 0;
  /** the plane's own smooth clock. cm.planeT() follows the server-clock estimate, which steps (snapshot floor,
   *  15 % per pong): the plane and the chase camera jumped with it. This one advances with the frame and is pulled
   *  gently onto the estimate (a jump > 0.5 s resyncs). */
  private stepPlaneClock(dt: number) {
    const cm = this.cm;
    if (cm.phase !== 1) { this.planeTs = -1; return; }
    const raw = cm.planeT();
    if (this.planeTs < 0 || Math.abs(raw - this.planeTs) > 0.5) this.planeTs = raw;
    else { this.planeTs += dt; this.planeTs += (raw - this.planeTs) * (1 - Math.exp(-dt * 1.5)); }
  }
  private planeTs = -1;
  private planePosSmooth(out: { x: number; z: number }) {
    if (this.planeTs < 0) { this.cm.planePos(out); return; }
    const pl = this.cm.plane; out.x = pl.x0 + pl.dx * PLANE_SPEED * this.planeTs; out.z = pl.z0 + pl.dz * PLANE_SPEED * this.planeTs;
  }
  /** the plane -> eyes hand-off. At the exit frame the camera keeps the chase view's position, orientation and
   *  VELOCITY as an offset from the eyes; the offset decays on a critically damped spring (~0.9 s), the orientation on
   *  the same curve. Also keeps the last camera pose / velocity every frame. */
  private dropCamera(dt: number, off: boolean) {
    const cam = this.engine.camera, X = this.exitOff, XV = this.exitOffV;
    const exitNow = this.exitPending && this.camValid; this.exitPending = false;
    if (exitNow) {
      X.copy(this.camLast).addScaledVector(this.camVel, dt).sub(cam.position);
      XV.copy(this.camVel).sub(V3c.set(this.cm.pred.vx, this.cm.pred.vy, this.cm.pred.vz));
      this.exitQ.copy(this.camLastQ).multiply(QI.copy(cam.quaternion).invert()); this.exitS = 1; this.exitSV = 0;
      if (X.lengthSq() > 200 * 200) { X.set(0, 0, 0); XV.set(0, 0, 0); this.exitS = 0; }
      if (this.exitS > 0) { cam.position.add(X); cam.quaternion.premultiply(this.exitQ); }   // this frame: where the chase view would be
    }
    else if (off) { X.set(0, 0, 0); XV.set(0, 0, 0); this.exitS = 0; this.exitSV = 0; this.poseValid = false; this.poseOff.set(0, 0, 0); this.poseOffV.set(0, 0, 0); this.lookOn = false; }
    else if (this.exitS > 1e-4 || X.lengthSq() > 1e-6 || XV.lengthSq() > 1e-6) {
      const w = 4.4, x = Math.exp(-w * dt);
      dampAxis(X, XV, "x", w, dt); dampAxis(X, XV, "y", w, dt); dampAxis(X, XV, "z", w, dt);
      { const e = this.exitS, c = this.exitSV + w * e; this.exitS = (e + c * dt) * x; this.exitSV = (this.exitSV - w * c * dt) * x; }
      cam.position.add(X);
      QI.identity().slerp(this.exitQ, Math.max(0, Math.min(1, this.exitS))); cam.quaternion.premultiply(QI);
    }
    if (dt > 0) { if (this.camValid) this.camVel.copy(cam.position).sub(this.camLast).divideScalar(dt); this.camLast.copy(cam.position); this.camLastQ.copy(cam.quaternion); this.camValid = true; }
  }
  private exitPending = false; private camValid = false; private exitS = 0; private exitSV = 0;
  private readonly exitOff = new THREE.Vector3(); private readonly exitOffV = new THREE.Vector3(); private readonly exitQ = new THREE.Quaternion();
  private readonly camLast = new THREE.Vector3(); private readonly camVel = new THREE.Vector3(); private readonly camLastQ = new THREE.Quaternion();
  private eyeSmooth = 1.65; private bank = 0; private stepOff = 0; private stepV = 0; private footY = 0; private footOn = false;
  private victorySpotAt = -2; private vsX = 0; private vsY = 0; private vsZ = 0; private vsYawOff = 0; private vsFree = 1; private specFree = 1;
  /** riding the plane: a third-person chase camera around the BANANA CO. plane (behind-right, the island
   * ahead), orbited with the mouse (a first-person cargo-bay seat showed an empty tube). Where you look is
   * where you face when you jump (input.yaw carries straight into the freefall camera). */
  private planeCamera(dt: number) {
    const cm = this.cm, cam = this.engine.camera;
    this.planePosSmooth(PP);
    const heading = Math.atan2(-cm.plane.dx, -cm.plane.dz);
    if (!this.planeCamInit) { this.planeCamInit = true; this.input.yaw = heading - 0.62; this.input.pitch = -0.2; this.planeDist = 44; }
    this.input.pitch = Math.max(-1.05, Math.min(0.3, this.input.pitch));
    // ease in from a wide establishing distance, a slow breathing drift so it never feels parked
    // (the breathing drift runs on the engine's frame clock, not the wall clock read mid-frame — that jittered)
    this.planeDist += (34 - this.planeDist) * (1 - Math.exp(-dt * 0.6));
    const now = this.engine.time, drift = Math.sin(now * 0.31) * 0.03;
    const yaw = this.input.yaw + drift, pitch = this.input.pitch;
    const vx = -Math.sin(yaw) * Math.cos(pitch), vy = Math.sin(pitch), vz = -Math.cos(yaw) * Math.cos(pitch);
    // aim a little ahead of + above the fuselage centre: the plane sits low-left, the island and the drop zone ahead
    const tx = PP.x + cm.plane.dx * 6, ty = PLANE_ALT + 3.2, tz = PP.z + cm.plane.dz * 6;
    cam.position.set(tx - vx * this.planeDist, ty - vy * this.planeDist + 4, tz - vz * this.planeDist);
    const f = this.feelOffsets();
    E.set(pitch + f[0] + Math.sin(now * 1.1) * 0.004, yaw + f[1], Math.sin(now * 0.9) * 0.01 + f[2], "YXZ");
    cam.quaternion.setFromEuler(E);
  }
  private planeDist = 44;
  /** the moment you drop: sink to the ground, tilt, desaturate (HUD) — then spectate / redeploy */
  private deathCamera(dt: number) {
    const cam = this.engine.camera;
    const k = Math.min(1, (performance.now() - (this.deadAt > 0 ? this.deadAt : performance.now())) / 900);
    const e = 1 - (1 - k) * (1 - k);
    // killed in the air: the body drops to the floor (shared stepCorpse) and the death cam rides it down
    if (this.cm.pred.st === PS.Dead) { this.cm.localPose(V3); this.deathY = V3.y; }
    const gy = Math.max(this.engine.terrain.height(this.deathX, this.deathZ), this.deathY);
    cam.position.set(this.deathX, gy + 1.65 - e * 1.25, this.deathZ);
    const f = this.feelOffsets();
    E.set(this.input.pitch * (1 - e) - e * 0.25 + f[0], this.input.yaw + f[1], e * 0.55 + f[2], "YXZ");
    cam.quaternion.setFromEuler(E);
    void dt;
  }
  /** my own kong appears in third person doing a victory emote, camera circles low and heroic */
  private victoryCamera(dt: number) {
    const cm = this.cm, cam = this.engine.camera;
    cm.localPose(V3);
    // won while swimming (or standing in the surf): the emote happens on the nearest shore, never underwater
    if (this.victorySpotAt !== this.victoryAt) {
      this.victorySpotAt = this.victoryAt; this.vsX = V3.x; this.vsY = V3.y; this.vsZ = V3.z;
      const T = this.engine.terrain;
      // won while swimming / in the surf, or deep in the jungle (the orbiting camera would sit in the undergrowth): the
      // emote happens on the nearest open ground — sand, grass, a path — never underwater, never inside a bush
      const open = (x: number, z: number) => { const b = T.biomeAt(x, z); return T.height(x, z) > 0.3 && (b === Biome.Beach || b === Biome.Grass || b === Biome.Path || b === Biome.Paved || b === Biome.Farmland); };
      // the spot needs a 4 m clear ring in the STATIC WORLD (walls, rocks, trunks,
      // roofs overhead) — the kong's own spot if it has one (a rooftop counts), else the nearest open one within 60 m
      const w = cm.world;
      const spot = findOpenSpot(w, V3.x, V3.y, V3.z, 4, (x, z) => T.height(x, z) > 0.3 && T.biomeAt(x, z) !== Biome.Jungle)
        ?? findOpenSpot(w, V3.x, V3.y, V3.z, 3);
      if (spot) { this.vsX = spot[0]; this.vsY = spot[1]; this.vsZ = spot[2]; }
      else if (cm.pred.swim || T.height(V3.x, V3.z) < 0.15 || !open(V3.x, V3.z)) {
        let found = false;
        search: for (let r = 2; r <= 120; r += 3) for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2, x = V3.x + Math.cos(a) * r, z = V3.z + Math.sin(a) * r;
          if (open(x, z) && open(x + 4, z) && open(x - 4, z) && open(x, z + 4) && open(x, z - 4)) { this.vsX = x; this.vsY = T.height(x, z); this.vsZ = z; found = true; break search; }
        }
        if (!found && (cm.pred.swim || T.height(V3.x, V3.z) < 0.15)) {
          search2: for (let r = 2; r <= 80; r += 2) for (let k = 0; k < 24; k++) {
            const a = (k / 24) * Math.PI * 2, x = V3.x + Math.cos(a) * r, z = V3.z + Math.sin(a) * r, h = T.height(x, z);
            if (h > 0.3) { this.vsX = x; this.vsY = h; this.vsZ = z; break search2; }
          }
          if (this.vsY < 0) this.vsY = -0.25;   // open sea: stand in the surf, head and chest out
        }
      }
      this.vsYawOff = NaN;
    }
    V3.set(this.vsX, this.vsY, this.vsZ);
    if (!this.meActor && !this.meActorPending) {
      this.meActorPending = true;
      void this.kits.createKong(this.engine, { variant: Math.max(0, cm.me) % 6 }).then((a) => { this.meActor = a; a.setOutfit?.(outfitFor(cm.me, cm.seed)); this.engine.scene.add(a.object); patchTree(this.engine, a.object); });
    }
    const k = (performance.now() - this.victoryAt) / 1000;
    // the kong faces the SUN (face and chest lit) and the camera stands in front of it, low, looking up —
    // a gentle sway across the front, never round to the back (a full orbit would frame the kong's back)
    const sd = this.engine.shared.get("sunDir") as THREE.Vector3 | undefined;
    const kyaw = sd && Math.hypot(sd.x, sd.z) > 0.05 ? Math.atan2(-sd.x, -sd.z) : this.input.yaw;
    if (this.meActor) {
      const mp = this.mePose; mp.x = V3.x; mp.y = V3.y; mp.z = V3.z; mp.yaw = kyaw; mp.pitch = 0.2; mp.vx = mp.vy = mp.vz = 0;
      mp.state = "emote"; mp.weapon = null; mp.team = cm.pred.team; mp.friendly = true;
      this.meActor.setVisible(true); this.meActor.apply(mp, dt);
    }
    // the front arc the camera sways across must be open: pick the azimuth (nearest the sun-lit front) with the most room
    const w = cm.world, hy = V3.y + 1.4;
    if (Number.isNaN(this.vsYawOff)) {
      let best = -1; this.vsYawOff = 0;
      for (const off of VICTORY_OFFS) {
        const aa = kyaw + VICTORY_FRONT + off, free = Math.min(camCast(w, V3.x, hy, V3.z, V3.x - Math.sin(aa - 0.3) * 5.6, V3.y + 0.9, V3.z - Math.cos(aa - 0.3) * 5.6), camCast(w, V3.x, hy, V3.z, V3.x - Math.sin(aa + 0.3) * 5.6, V3.y + 0.9, V3.z - Math.cos(aa + 0.3) * 5.6));
        if (free > best + 0.3) { best = free; this.vsYawOff = off; }
        if (free >= 5.2) break;
      }
    }
    const a = kyaw + VICTORY_FRONT + this.vsYawOff + 0.3 * Math.sin(k * 0.33), e = Math.min(1, k / 2.5), dist = 5.4 - (e * e * (3 - 2 * e)) * 1.9;
    const fx = -Math.sin(a), fz = -Math.cos(a);
    const gy = Math.max(this.engine.terrain.height(V3.x + fx * dist, V3.z + fz * dist), V3.y - 0.4, 0);
    const cy = Math.max(gy + 0.45, V3.y + 0.55, 0.8);
    // collide: sphere-cast from the kong's head to the wanted spot, pull in to the first wall / rock / roof
    const want = Math.hypot(fx * dist, cy - hy, fz * dist), free = camCast(w, V3.x, hy, V3.z, V3.x + fx * dist, cy, V3.z + fz * dist, 0.3);
    const u = want > 1e-3 ? Math.max(0.25, free / want) : 1;
    this.vsFree += ((u < 1 ? u : 1) - this.vsFree) * (u < this.vsFree ? 1 : Math.min(1, dt * 4));
    const uu = this.vsFree;
    cam.position.set(V3.x + fx * dist * uu, hy + (cy - hy) * uu, V3.z + fz * dist * uu);
    cam.lookAt(V3.x, V3.y + 1.3, V3.z);
  }
  // ---------------------------------------------------------------- tuk-tuks
  /** riding: behind the tuk-tuk (the driver's default — orbit with the mouse, the view swings round with it) or from
   * the seat (the bench, and the driver's V view: a passenger aims where it likes, the world does not turn its gun) */
  private rideCamera(dt: number, vr: VehRemote) {
    const cm = this.cm, p = cm.pred, cam = this.engine.camera, inp = this.input;
    const heli = vr.kind === VKind.Heli, driver = p.seat === 0, third = driver && this.rideThird, gunner = heli && p.seat === HELI.GUN_SEAT;
    this.rideKind = vr.kind;
    const vx = vr.x + vr.ox, vy = vr.y + vr.oy, vz = vr.z + vr.oz, vyaw = vr.yaw + vr.oyaw;
    if (!this.rideOn || this.rideSeat !== p.seat) {
      this.rideOn = true; this.rideSeat = p.seat; this.rideYaw = vyaw; this.rideRel = 0; this.rideFree = 1;
      if (driver) { inp.yaw = vyaw; inp.pitch = heli ? (third ? -0.22 : -0.04) : third ? -0.2 : FP_PITCH; }
      // behind the minigun: the look starts where its barrels point
      if (gunner) { inp.yaw = vr.gunY; inp.pitch = vr.gunP; }
      this.rideSet = inp.yaw;
    }
    let yaw = inp.yaw;
    if (gunner) {
      // the look stays inside the gun's arc (the barrels cannot follow it farther): yaw either side of the left door's
      // normal, pitch within the gun's limits as the body leans them (the sim clamps exactly — heli.ts gunAngles)
      const door = vyaw + Math.PI / 2, rel = Math.max(-HELI.GUN_ARC_YAW, Math.min(HELI.GUN_ARC_YAW, wrapPi(inp.yaw - door)));
      const tilt = vr.pitch * Math.sin(-rel) - vr.roll * Math.cos(rel);
      inp.yaw = door + rel; inp.pitch = Math.max(HELI.GUN_PITCH_MIN + tilt, Math.min(HELI.GUN_PITCH_MAX + tilt, inp.pitch));
      yaw = inp.yaw;
    } else if (driver && heli) {
      // the pilot's look IS the heading it turns toward (shared/sim/heli.ts): kept within reach of the nose, so a flick
      // never asks for a turn the long way round. The chase view follows the nose from behind and leans a third of the
      // way toward where the pilot asks; the cockpit view looks straight where they look
      const rel = Math.max(-1.45, Math.min(1.45, wrapPi(inp.yaw - vyaw)));
      inp.yaw = vyaw + rel; this.rideSet = inp.yaw;
      inp.pitch = Math.max(-1.15, Math.min(0.6, inp.pitch));
      this.rideYaw += wrapPi(vyaw - this.rideYaw) * (1 - Math.exp(-dt * (third ? 4.5 : 14)));
      yaw = third ? this.rideYaw + rel * 0.35 : inp.yaw;
    } else if (driver) {
      this.rideRel += wrapPi(inp.yaw - this.rideSet);                                 // what the mouse did since last frame
      this.rideYaw += wrapPi(vyaw - this.rideYaw) * (1 - Math.exp(-dt * (third ? 5 : 16)));   // the view follows the nose (lazily from behind)
      inp.yaw = this.rideYaw + this.rideRel; this.rideSet = inp.yaw; yaw = inp.yaw;
      if (third) inp.pitch = Math.max(-1.15, Math.min(0.5, inp.pitch));
    }
    const f = this.feelOffsets();
    let pitch = inp.pitch;
    if (third && heli) {
      // low over the ground the helicopter's orbit tips down (HELI_LOW_TIP rad at the skids, none from 15 m up):
      // from 15 m back the camera would look into the tree crowns behind it (they do not stop a camera) — it looks down
      // over them at it instead, the helicopter staying where it was on the screen
      const agl = vy - Math.max(WATER_Y, this.engine.terrain.height(vx, vz)), tip = HELI_LOW_TIP * Math.max(0, Math.min(1, 1 - agl / 15));
      this.heliTip += (tip - this.heliTip) * Math.min(1, dt * 2);
      pitch = Math.max(-1.15, pitch - this.heliTip);
    }
    if (third) {
      // orbit a point over the canopy (the faster the farther); anything between it and the camera pulls the camera in at
      // once, eases back out. A helicopter is framed
      // like the tuk-tuk — about a third of the screen's height at a hover — from twice as far back (it is twice the
      // size: 7.3 m long under an 8 m rotor), round a point over the boom's root just above the blades (a camera pulled
      // in by a wall or a tree stays above the disc, not in it)
      const tb = heli ? HELI_CAM_BACK : 0, tx = vx + Math.sin(vyaw) * tb, ty = vy + (heli ? HELI_CAM_UP : 1.95), tz = vz + Math.cos(vyaw) * tb, cp = Math.cos(pitch);
      const dist = heli ? HELI_CAM_DIST - Math.min(1.5, Math.abs(vr.vf) * 0.055) : 6.3 + Math.min(1.4, Math.abs(vr.vf) * 0.08);
      let cx = tx + Math.sin(yaw) * cp * dist, cy = ty - Math.sin(pitch) * dist + (heli ? 0.6 : 0.5), cz = tz + Math.cos(yaw) * cp * dist;
      const g = (heli ? Math.max(WATER_Y, this.engine.terrain.height(cx, cz)) : this.engine.terrain.height(cx, cz)) + 0.5; if (cy < g) cy = g;
      const want = Math.hypot(cx - tx, cy - ty, cz - tz), free = camCast(cm.world, tx, ty, tz, cx, cy, cz, 0.3), u = want > 1e-3 ? Math.min(1, Math.max(0.2, free / want)) : 1;
      this.rideFree = u < this.rideFree ? u : this.rideFree + (u - this.rideFree) * Math.min(1, dt * 3.5);
      cx = tx + (cx - tx) * this.rideFree; cy = ty + (cy - ty) * this.rideFree; cz = tz + (cz - tz) * this.rideFree;
      // (never with the camera in the blades: pulled in over the disc, it keeps above its plane)
      if (heli) { const hx = cx - vx - Math.sin(vyaw) * HELI.HUB_Z, hz = cz - vz - Math.cos(vyaw) * HELI.HUB_Z, dy = cy - (vy + HELI.ROTOR_Y); if (hx * hx + hz * hz < (HELI.ROTOR_R + 0.8) ** 2 && Math.abs(dy) < 0.7) cy = vy + HELI.ROTOR_Y + 0.7; }
      cam.position.set(cx, cy, cz);
      E.set(pitch + f[0], yaw + f[1], f[2], "YXZ");
    } else if (driver && !heli) {
      // the saddle view: the eye up and forward over the bars — the road over the
      // nose, the bars and gauges framing the bottom, the canopy's edge only at the very top; the fuzzy dice are not
      // drawn for me (TukView.firstPerson). The body leans INTO a turn a little (speed × bars), and the horizon follows
      // a little of the tuk-tuk's own lean
      FPP[0] = vx; FPP[1] = vy; FPP[2] = vz; FPP[3] = vyaw; FPP[4] = vr.pitch; FPP[5] = vr.roll;
      vehPoint(FPP, FP_EYE[0], FP_EYE[1], FP_EYE[2], FPO);
      cam.position.set(FPO[0], FPO[1], FPO[2]);
      const leanIn = vr.steer * Math.min(1, Math.abs(vr.vf) / 9) * FP_LEAN;
      this.fpLean += (leanIn - this.fpLean) * Math.min(1, dt * 6);
      E.set(pitch + f[0], yaw + f[1], f[2] + this.fpLean + Math.max(-0.5, Math.min(0.5, vr.roll * 0.4 * Math.cos(wrapPi(yaw - vyaw)))), "YXZ");
    } else {
      cm.seatEye(vr, p.seat, V3);
      cam.position.set(V3.x, V3.y, V3.z);
      // the horizon leans a little with the vehicle (all of it would be seasick); a helicopter's nose dips in with it
      const d = wrapPi(yaw - vyaw), cd = Math.cos(d), sd = Math.sin(d);
      const lean = heli ? vr.roll * 0.45 * cd + vr.pitch * 0.45 * sd : vr.roll * 0.4 * cd, dip = heli ? (vr.pitch * cd - vr.roll * sd) * 0.4 : 0;
      E.set(pitch + f[0] + dip, yaw + f[1], f[2] + Math.max(-0.5, Math.min(0.5, lean)), "YXZ");
    }
    cam.quaternion.setFromEuler(E);
  }
  /** a change of camera kind (on foot / behind the tuk-tuk / in one of its seats) is travelled, never cut */
  private blendCamera(dt: number, mode: number) {
    const cam = this.engine.camera;
    if (mode !== this.camMode) {
      const smooth = mode >= 0 && this.camMode !== -1 && this.camKept;
      this.camMode = mode;
      if (smooth) { this.blendP.copy(this.keptP); this.blendQ.copy(this.keptQ); this.camBlend = 0; } else this.camBlend = 1;
    }
    if (mode < 0) { this.camKept = false; this.camBlend = 1; return; }
    if (this.camBlend < 1) {
      this.camBlend = Math.min(1, this.camBlend + dt / 0.38);
      const e = 1 - (1 - this.camBlend) ** 3;
      cam.position.lerpVectors(this.blendP, cam.position, e); cam.quaternion.copy(QI.copy(this.blendQ).slerp(cam.quaternion, e));
    }
    this.keptP.copy(cam.position); this.keptQ.copy(cam.quaternion); this.camKept = true;
  }
  /** where squadmate `r` is DRAWN, for its world tag, minimap dot and compass mark: a rider sits on its
   *  vehicle as the vehicle is drawn (seatPose, as the actor loop seats it); its own snapshot position is its seat as
   *  ITS client saw the vehicle (Match.seatRewound), metres behind a fast helicopter */
  private mateAt(r: Remote, out: THREE.Vector3): THREE.Vector3 {
    const vr = r.st === PS.Ride && r.veh >= 0 ? this.cm.vehicles[r.veh] : null;
    if (vr && vr.live && vr.n > 0) this.cm.seatFeet(vr, r.seat, out); else out.set(r.x, r.y, r.z);
    return out;
  }
  /** a kong seated in `vr`: feet on the seat anchor, the seat's tilt in the kong's own frame, the bars for the driver */
  private seatPose(pose: KongPose, vr: VehRemote, seat: number, yaw: number, pitch: number) {
    this.cm.seatFeet(vr, seat, V3c);
    pose.x = V3c.x; pose.y = V3c.y; pose.z = V3c.z; pose.yaw = yaw; pose.pitch = pitch; pose.vx = 0; pose.vy = 0; pose.vz = 0;
    // a helicopter's door gunner sits like the pilot, both fists on TOP BANANA's grips (actors/heli-tripo.ts gunGrip)
    const gunner = vr.kind === VKind.Heli && seat === HELI.GUN_SEAT;
    pose.state = seat === 0 || gunner ? "drive" : "ride";
    const d = wrapPi(yaw - (vr.yaw + vr.oyaw)), c = Math.cos(d), sn = Math.sin(d);
    pose.seatPitch = vr.pitch * c - vr.roll * sn; pose.seatRoll = vr.pitch * sn + vr.roll * c;
    const view = seat === 0 || gunner ? (this.tuks.get(vr.id) as (TukView & { gunGrip?(side: 1 | -1, out: THREE.Vector3): THREE.Vector3 }) | undefined) : undefined;
    pose.grips = view && !view.wreck ? (gunner ? (view.gunGrip ? (view.gunGrip(1, GRIP[0]), view.gunGrip(-1, GRIP[1]), GRIP) : null) : (view.grip(1, GRIP[0]), view.grip(-1, GRIP[1]), GRIP)) : null;
  }
  /** every vehicle in view: its model on the drawn pose, its engine / rotor / horn / tyres / fire in the mix — and the
   * helipads, painted once per world */
  private updateVehicles(dt: number, t: number) {
    const cm = this.cm, cam = this.engine.camera.position, now = performance.now(), mine = cm.pred.st === PS.Ride ? cm.pred.veh : -1;
    // the helipads: this match's (the seed picks them — no empty range pad by Peel Strip in a match), or the
    // firing range's; painted again when that changes
    const padKey = this.range ? -1 : cm.seed;
    if (this.padWorld !== cm.world || this.padKey !== padKey) {
      this.padWorld = cm.world; this.padKey = padKey;
      this.padScope?.dispose();
      const res = this.padScope = this.matchScope.child("pads");
      this.pads = cm.heliSpots(!!this.range).map((sp) => { const m = createHelipad(this.engine.terrain, sp.x, sp.z, sp.yaw); res.geometry("geo.world", m.geometry); res.defer(() => m.removeFromParent()); this.engine.scene.add(m); patchTree(this.engine, m); return m; });
    }
    for (const vr of cm.vehicles) {
      let v = this.tuks.get(vr.id);
      let A = this.tukAudio.get(vr.id);
      const heli = vr.kind === VKind.Heli, SP = specOf(vr.kind);
      const d2 = (vr.x - cam.x) ** 2 + (vr.y - cam.y) ** 2 + (vr.z - cam.z) ** 2, drawR = heli ? HELI_DRAW_R : TUK_DRAW_R;
      const show = vr.live && vr.n > 0 && vr.st !== VS.Gone && d2 < drawR * drawR;
      if (!show) {
        if (v) v.object.visible = false;
        if (A) { for (const k of TUK_LOOPS) this.tukLoop(A, k, vr.id, false, false, "tuk:idle", undefined, 0, 1); A.radio = -1; }
        continue;
      }
      if (v && v.kind !== vr.kind) { v.dispose(); this.tuks.delete(vr.id); v = undefined; }
      if (!v) { v = heli ? createHeli((o) => patchTree(this.engine, o)) : createTukTuk(); this.engine.scene.add(v.object); patchTree(this.engine, v.object); this.tuks.set(vr.id, v); }
      if (!A) { A = { horn: -1e9, on: { I: "", D: "", S: "", F: "", H: "", G: "", O: "", B: "" }, fuseAt: -1, sunkAt: -1, exh: 0, smk: 0, fire: 0, dust: 0, lx: D0, ly: 0, lz: 0, seen: false, lastVf: 0, popAt: 0, radio: -1, radioSt: -1, pilot: false, vy: 0, gunLock: false, gunSt: vr.gunSpin > 0 ? 1 : 0, gunRef: vr.gunSpin }; this.tukAudio.set(vr.id, A); }
      v.object.visible = true;
      if (vr.st === VS.Sunk) { if (A.sunkAt < 0) A.sunkAt = now; } else A.sunkAt = -1;
      const D = TDRAW; D.x = vr.x + vr.ox; D.y = vr.y + vr.oy - (A.sunkAt >= 0 ? Math.min(2.6, (now - A.sunkAt) * 0.0006) : 0); D.z = vr.z + vr.oz; D.yaw = vr.yaw + vr.oyaw; D.pitch = vr.pitch; D.roll = vr.roll;
      // the motion as drawn (the snapshots carry no vertical speed): what the dust, the bob and the altimeter read
      const mvx = A.seen && dt > 1e-4 ? (D.x - A.lx) / dt : 0, mvz = A.seen && dt > 1e-4 ? (D.z - A.lz) / dt : 0, mv = Math.min(40, Math.hypot(mvx, mvz));
      const vyRaw = A.seen && dt > 1e-4 ? Math.max(-60, Math.min(60, (D.y - A.ly) / dt)) : 0;
      A.vy += (vyRaw - A.vy) * Math.min(1, dt * 12);
      A.lx = D.x; A.ly = D.y; A.lz = D.z; A.seen = true;
      D.vf = vr.vf; D.vy = A.vy; D.steer = vr.steer; D.hp = vr.hp / SP.HP; D.flags = vr.flags; D.st = vr.st;
      // (driving a tuk-tuk from the saddle hides its dice / wiper / fringe; a helicopter's cockpit is its own)
      v.firstPerson = !heli && vr.id === mine && cm.pred.seat === 0 && !this.rideThird;
      if (heli) {
        // TOP BANANA: the drawn aim through the drawn pose into the turret's angles (clamped to the arc exactly like the
        // sim's shots), the spin, the heat, the rounds since the last draw
        GP6[0] = D.x; GP6[1] = D.y; GP6[2] = D.z; GP6[3] = D.yaw; GP6[4] = D.pitch; GP6[5] = D.roll;
        gunAngles(vr.gunY, vr.gunP, GP6, GANG);
        D.gunYaw = GANG[0]; D.gunPitch = GANG[1]; D.gunSpin = vr.gunSpin; D.gunHeat = vr.gunHeat; D.gunFire = this.gunShots[vr.id];
      } else { D.gunYaw = D.gunPitch = D.gunSpin = D.gunHeat = undefined; D.gunFire = 0; }
      this.gunShots[vr.id] = 0;
      v.update(D, dt, t, cam);
      if (!heli && vr.st === VS.Ok) this.tukThru.check(D.x, D.y, D.z, D.yaw, vr.vf, d2, now);   // (a tuk-tuk ploughing through fences)
      // ---- sound: aboard it is "you" (no position), otherwise it is out in the world (two loop ids: a loop's 2D / 3D
      // wiring is fixed when it starts)
      const aboard = vr.id === mine, alive2 = vr.st === VS.Ok, near = d2 < (heli ? 420 : 150) ** 2;
      POS3[0] = D.x; POS3[1] = D.y + (heli ? 2.2 : 0.8); POS3[2] = D.z;
      const pos: [number, number, number] | undefined = aboard ? undefined : POS3;
      const burning = (vr.flags & VF.BURN) !== 0 && near, fuse = burning && vr.st !== VS.Wreck;
      if (heli) {
        // the rotor: its chop rises with the spool, the turbine whines under it; the pilot leaving winds it down
        const spool = vr.steer, on = near && vr.st !== VS.Sunk && spool > 0.015, piloted = vr.seats[0] >= 0 && alive2;
        this.tukLoop(A, "I", vr.id, on, aboard, "heli:rotor", pos, Math.max(0.001, 0.12 + 0.88 * spool), 0.62 + 0.42 * spool);
        this.tukLoop(A, "D", vr.id, on, aboard, "heli:turbine", pos, Math.max(0.001, 0.08 + 0.92 * spool * spool), 0.85 + 0.25 * spool);
        this.tukLoop(A, "F", vr.id, burning, aboard, "tuk:fire", pos, 1, 1);
        // the cockpit's warning horn: on fire — or the rotor dying in the air with nobody at the stick
        const rotorOut = alive2 && near && vr.seats[0] < 0 && (vr.flags & VF.AIR) !== 0 && spool < 0.97;
        this.tukLoop(A, "H", vr.id, fuse || rotorOut, aboard, "heli:alarm", pos, 1, 1);
        // TOP BANANA, the door minigun (its sound modelled on an M134). B: the `gun:fire` loop runs while rounds keep
        // leaving — one within the last 80 ms (my own, predicted: 50 ms apart) or 150 ms (heard from the server, in 33 ms
        // packets) — and the burst's tail (`gun:stop`) when it ends. The barrels: the motor winds them up (`gun:spinup`, as
        // the spin leaves 0), G: their empty clatter (`gun:spin`) rides the top of the spin (under the fire, -6 dB), and they
        // coast to a stop (`gun:spindown`, as the spin starts to fall — as loud / as fast as the spin it fell from).
        // Overheated: the quench hiss as it locks (`gun:lock`), O: the barrels sizzle (`gun:hot`) until it unlocks
        const gs = vr.gunSpin, gunOn = near && alive2;
        const firing = gunOn && now - this.gunLastAt[vr.id] < (this.gunLocal[vr.id] ? 80 : 150);
        if (A.on.B && !firing && gunOn) this.kits.audio.play("gun:stop", { pos });
        this.tukLoop(A, "B", vr.id, firing, aboard, "gun:fire", pos, 1, 1);
        const top = Math.max(0, Math.min(1, (gs - 0.75) / 0.25));
        this.tukLoop(A, "G", vr.id, gunOn && gs > 0.75, aboard, "gun:spin", pos, Math.max(0.001, top * top * (firing ? 0.5 : 1)), 0.8 + 0.2 * gs);
        // (with a little hysteresis: a prediction's correction or a snapshot's rounding never reads as a new wind-up / coast;
        // rounds already leaving mean the barrels are up to speed — someone else's spin is drawn from snapshots that can trail
        // their rounds, and a wind-up after the first rounds would be out of order)
        if (firing && A.gunSt !== 1) { A.gunSt = 1; A.gunRef = gs; }
        if (A.gunSt !== 1) {
          if (gs <= 0) { A.gunSt = 0; A.gunRef = 0; } else A.gunRef = Math.min(A.gunRef, gs);
          if (gs > A.gunRef + 0.03) { if (A.gunRef < 0.3 && gunOn) this.kits.audio.play("gun:spinup", { pos }); A.gunSt = 1; A.gunRef = gs; }
        } else {
          A.gunRef = Math.max(A.gunRef, gs);
          if (gs < A.gunRef - 0.04) { if (A.gunRef > 0.3 && gunOn) this.kits.audio.play("gun:spindown", { pos, volume: A.gunRef, rate: 0.85 + 0.15 * A.gunRef }); A.gunSt = 2; A.gunRef = gs; }
        }
        this.tukLoop(A, "O", vr.id, gunOn && vr.gunLock, aboard, "gun:hot", pos, 1, 1);
        if (vr.gunLock && !A.gunLock && gunOn) this.kits.audio.play("gun:lock", { pos });
        A.gunLock = vr.gunLock;
        if (piloted && !A.pilot && !aboard) this.kits.audio.play("heli:start", { pos, volume: 0.9 });
        if (!piloted && A.pilot && alive2 && near) this.kits.audio.play("heli:stop", { pos, volume: 0.8 });
        A.pilot = piloted;
        // (no loud-hailer: the pilot's click would play the tuk-tuk's horn)
        // ---- particles: the rotor wash on the ground under it, smoke and fire off the engine
        if (d2 < 260 * 260 && dt > 0) {
          const fx = this.tukFx, g = Math.max(WATER_Y, this.engine.terrain.height(D.x, D.z)), h = D.y - g;
          if (spool > 0.35 && h < 11 && vr.st !== VS.Sunk) {
            const wet = this.engine.terrain.height(D.x, D.z) < WATER_Y + 0.2, col = wet ? SPRAY : DUST[this.cm.world.groundBiome(D.x, D.z)] ?? null;
            if (col) { A.dust += dt * 26 * spool * (1 - h / 11); while (A.dust >= 1) { A.dust -= 1; const a = Math.random() * 6.283, r = 2.5 + Math.random() * 3.5; fx.dust(D.x + Math.cos(a) * r, g, D.z + Math.sin(a) * r, Math.cos(a) * (2.5 + spool * 3), Math.sin(a) * (2.5 + spool * 3), col, 1.9); } }
          }
          if (alive2 && spool > 0.3) { A.exh += dt * 7 * spool; while (A.exh >= 1) { A.exh -= 1; fx.exhaust(v.exhaust(V3b), Math.sin(D.yaw) * 0.6, Math.cos(D.yaw) * 0.6, 0.25); } }
          const rate = burning ? 24 : vr.st === VS.Wreck ? 5 : D.hp < 0.34 ? 12 : D.hp < 0.67 ? 5 : 0;
          if (rate > 0) { A.smk += dt * rate; while (A.smk >= 1) { A.smk -= 1; fx.smoke(v.engine(V3b), burning ? 1 : vr.st === VS.Wreck ? 0.7 : D.hp < 0.34 ? 0.75 : 0.2, mvx, mvz); } }
          if (burning) { A.fire += dt * (vr.st === VS.Wreck ? 28 : 36); while (A.fire >= 1) { A.fire -= 1; fx.flame(v.engine(V3b), vr.st === VS.Wreck ? 1.6 : 1.2, mvx, mvz, vr.st === VS.Wreck ? 0.9 : 0.7); } }
        }
        continue;
      }
      const eng = alive2 && near && vr.seats[0] >= 0 && !fuse, rev = Math.min(1, Math.abs(vr.vf) / TUK.VMAX);
      // in the cab with the radio on, the engine sits 2.5 dB lower — the music reads over the two-stroke
      const eDuck = aboard && A.radio > 0 ? 0.75 : 1;
      this.tukLoop(A, "I", vr.id, eng, aboard, "tuk:idle", pos, Math.max(0.001, 1 - rev * 1.6) * eDuck, 0.9 + rev * 0.5);
      this.tukLoop(A, "D", vr.id, eng, aboard, "tuk:drive", pos, Math.max(0.001, Math.min(1, rev * 1.9)) * eDuck, 0.62 + rev * 0.98);
      this.tukLoop(A, "S", vr.id, alive2 && near && (vr.flags & VF.SKID) !== 0, aboard, "tuk:skid", pos, Math.min(1, 0.4 + Math.abs(vr.vf) / 14), 1);
      this.tukLoop(A, "F", vr.id, burning, aboard, "tuk:fire", pos, 1, 1);
      // out of health: one last honk as the horn sticks, then its blare sags until the bang
      if (fuse && A.fuseAt < 0) { A.fuseAt = now; this.kits.audio.play("tuk:horn", { pos, volume: 1 }); } else if (!fuse) A.fuseAt = -1;
      this.tukLoop(A, "H", vr.id, fuse, aboard, "tuk:fuse", pos, 1, fuse ? 1 - Math.min(0.2, (now - A.fuseAt) / 13000) : 1);
      // the radio (audio/radio.ts): plays while somebody rides it — in the cab a clean mix, outside from the tuk-tuk
      const R = this.kits.audio.radio;
      if (R) {
        const rode = vr.seats[0] >= 0 || vr.seats[1] >= 0 || vr.seats[2] >= 0, st = alive2 && rode && !fuse ? vr.radio : 0;
        const clock = this.cm.serverTick() * DT;
        if (st !== A.radio) {
          // the dial turned (someone aboard pressed the radio key) → a soft sweep of static as the station fades up
          if (A.radio >= 0 && (aboard || d2 < 40 * 40) && vr.radio !== A.radioSt) R.tune(vr.id, aboard);
          if (aboard && vr.radio !== A.radioSt) { this.tunedAt = now; if (A.cab) this.radioBanner(vr.radio, clock, true); }
          A.radio = st; A.radioSt = vr.radio;
        }
        // the station banner: getting in with the radio on; a new song while I ride
        if (aboard) { if (!A.cab) { if (st > 0) this.radioBanner(st, clock, false); else this.radioCue = -1; } else if (st > 0) this.radioSong(st, clock); }
        A.cab = aboard;
        R.set(vr.id, st, POS3, aboard, Math.sqrt(d2), clock, burning ? 0.5 : 1);
      }
      // the horn: once per press, again while it is held
      if ((vr.flags & VF.HORN) !== 0 && alive2 && !fuse && near) { if (now - A.horn > 900) { A.horn = now; this.kits.audio.play("tuk:horn", { pos, volume: 1 }); } } else if (now - A.horn > 250) A.horn = -1e9;
      // ---- particles (near the camera): the putt of the exhaust, dust off the tyres, smoke, fire, sparks
      if (d2 < 130 * 130 && dt > 0) {
        const fx = this.tukFx, sp = Math.abs(vr.vf), bx = Math.sin(D.yaw), bz = Math.cos(D.yaw);
        if (eng) {
          A.exh += dt * (5 + 15 * rev);
          while (A.exh >= 1) { A.exh -= 1; fx.exhaust(v.exhaust(V3b), bx, bz, rev); }
          // lifting off from speed: now and then it pops
          if (A.lastVf - sp > 0.1 && sp > 6 && now - A.popAt > 1100 && Math.random() < dt * 2.2) { A.popAt = now; fx.backfire(v.exhaust(V3b), bx, bz); this.kits.audio.play("tuk:backfire", { pos, volume: 0.9 }); }
        }
        A.lastVf = sp;
        // dust off the rear tyres on anything loose (white tyre smoke when they slide on a road), a plume when it scrapes
        // along on its side
        if (alive2 && (vr.flags & VF.AIR) === 0 && mv > 3.5) {
          const skid = (vr.flags & VF.SKID) !== 0, col = DUST[this.cm.world.groundBiome(D.x, D.z)] ?? (skid ? TYRE_SMOKE : null);
          if (col) { A.dust += dt * (skid ? 30 : Math.min(15, mv)); while (A.dust >= 1) { A.dust -= 1; const w = v.hub(Math.random() < 0.5 ? 1 : 2, V3b); fx.dust(w.x, w.y - TUK.WHEEL_R, w.z, -mvx * 0.12, -mvz * 0.12, col, skid ? 1.35 : 1); } }
        } else if (vr.st === VS.Tipped && mv > 1.2) {
          A.dust += dt * 26; while (A.dust >= 1) { A.dust -= 1; fx.dust(D.x, D.y - 0.7, D.z, -mvx * 0.1, -mvz * 0.1, DUST[this.cm.world.groundBiome(D.x, D.z)] ?? TYRE_SMOKE, 1.5); }
          if (Math.random() < dt * 16) fx.sparks(D.x, D.y - 0.6, D.z, mvx, mvz, 3);
        }
        // a hurt engine smokes (thin grey under two thirds, thick and dark under one), a dying one burns
        const rate = burning ? 22 : vr.st === VS.Wreck ? 4 : D.hp < 0.34 ? 11 : D.hp < 0.67 ? 4.5 : 0;
        if (rate > 0) { A.smk += dt * rate; while (A.smk >= 1) { A.smk -= 1; fx.smoke(v.engine(V3b), burning ? 1 : vr.st === VS.Wreck ? 0.7 : D.hp < 0.34 ? 0.75 : 0.2, mvx, mvz); } }
        if (burning) { A.fire += dt * (vr.st === VS.Wreck ? 26 : 34); while (A.fire >= 1) { A.fire -= 1; fx.flame(v.engine(V3b), vr.st === VS.Wreck ? 1.5 : 1.1, mvx, mvz, vr.st === VS.Wreck ? 0.75 : 0.5); } }
      }
    }
    this.tukFx.update(dt);
    this.kits.audio.radio?.frame();
    this.bananas.update(dt);
  }
  /** the radio's station banner (ui/hud.ts .kr-radio): `st` tuned in at match time `clock` — the station
   *  big + what is on air (the broadcast's cue sheet, audio/radio-program.ts); `dial` = the dial was turned (OFF shows) */
  private radioCue = -1;
  private radioBanner(st: number, clock: number, dial: boolean) {
    const s = STATIONS[st], c = onAir(st, clock);
    this.radioCue = c ? c.t : -1;
    if (!s || !c) { if (dial) this.hud.radio = { at: performance.now(), station: "RADIO OFF", line: "", kind: "off", big: true }; return; }
    this.hud.radio = { at: performance.now(), station: s.name, line: c.kind === "song" ? `${c.title} — ${c.by}` : c.kind === "ad" ? `${c.by} · ${c.title}` : `${s.host} · ON AIR`, kind: c.kind, big: true };
  }
  /** a new song comes on while I ride: its title under a small station name */
  private radioSong(st: number, clock: number) {
    const c = onAir(st, clock);
    if (!c || c.t === this.radioCue) return;
    this.radioCue = c.t;
    if (c.kind === "song") this.hud.radio = { at: performance.now(), station: STATIONS[st]!.name, line: `${c.title} — ${c.by}`, kind: "song", big: false };
  }
  /** one of a tuk-tuk's loops (I idle, D drive, S skid, F fire, H the stuck horn): started, kept up to date, stopped */
  private tukLoop(A: TukSound, k: TukLoop, id: number, on: boolean, aboard: boolean, sfx: Sfx, pos: [number, number, number] | undefined, volume: number, rate: number) {
    const was = A.on[k], key = on ? (aboard ? "a" : "w") : "";
    if (was && was !== key) this.stopLoop(`tuk${k}${id}${was}`);
    A.on[k] = key;
    if (!on) return;
    const lid = `tuk${k}${id}${key}`;
    this.loops.add(lid); this.kits.audio.play(sfx, { loopId: lid, pos, volume, rate });
  }
  /** a vehicle one-shot from the server (shared/net/proto.ts VK) */
  veh(id: number, kind: number, a: number, x: number, y: number, z: number) {
    const cm = this.cm, mine = cm.driving === id, v = this.tuks.get(id), cam = this.engine.camera.position, d = Math.hypot(cam.x - x, cam.y - y, cam.z - z);
    if (cm.vehicles[id]?.kind === VKind.Heli) {
      switch (kind) {
        case VK.Enter: break;                                                     // (the rotor loop + heli:start are updateVehicles')
        case VK.Tip: this.play("tuk:crash", x, y, z, 1); this.addTrauma(Math.max(0, 1 - d / 40) * 0.6); if (d < 200) this.tukFx.sparks(x, y, z, 0, 0, 14); break;
        case VK.Crash: if (!mine) { this.play("tuk:crash", x, y, z, Math.min(1, 0.35 + a / 160)); if (v && d < 160 && a > 60) this.tukFx.sparks(x, y + 0.6, z, 0, 0, 8); } break;
        case VK.Land: if (!mine) { this.play("tuk:land", x, y, z, Math.min(1, 0.4 + a / 200)); v?.bump(-1.8); } if (d < 160) for (let i = 0; i < 10; i++) { const b = Math.random() * 6.283; this.tukFx.dust(x + Math.cos(b) * 2, y - 0.7, z + Math.sin(b) * 2, Math.cos(b) * 3, Math.sin(b) * 3, DUST[this.cm.world.groundBiome(x, z)] ?? TYRE_SMOKE, 1.8); } break;
        case VK.Slam: if (!mine) { this.play("tuk:land", x, y, z, 0.45); v?.bump(-1.0); } break;
        case VK.Sunk: this.kits.fx.puff(V3.set(x, 0.1, z), "splash"); this.play("land", x, y, z, 1); break;
        case VK.Boom: this.addTrauma(Math.max(0, 1 - d / 90) * 0.6); if (d < 500) { this.tukFx.blast(x, y, z); this.tukFx.blast(x, y + 1.2, z); const bits = heliDebris(); for (const o of bits) patchTree(this.engine, o); this.tukFx.throwPieces(bits, x, y, z); } break;
        // the rotor cut a kong down: the blade's thwack, the hit spraying off the body, sparks off the tips; the pilot
        // feels it in the stick
        case VK.Chop: this.play("heli:chop", x, y, z, 1); if (d < 200) { V3.set(x, y, z); for (let i = 0; i < 3; i++) this.kits.fx.impact(V3, UP3, "flesh"); this.tukFx.sparks(x, y + 0.4, z, 0, 0, 14); } if (mine) this.addTrauma(0.25); break;
      }
      return;
    }
    switch (kind) {
      case VK.Enter: if (a !== cm.me) this.play("tuk:start", x, y, z, 0.9); break;
      case VK.Flip: this.play("tuk:flip", x, y, z, 1); v?.bump(2.2, 0); break;
      case VK.Tip: if (!mine) { this.play("tuk:tip", x, y, z, 1); this.addTrauma(Math.max(0, 1 - d / 14) * 0.5); } if (d < 120) { this.tukFx.sparks(x, y - 0.4, z, 0, 0, 10); for (let i = 0; i < 8; i++) this.tukFx.dust(x, y - 0.8, z, 0, 0, DUST[this.cm.world.groundBiome(x, z)] ?? TYRE_SMOKE, 1.6); } break;
      case VK.Crash: if (!mine) { this.play("tuk:crash", x, y, z, Math.min(1, 0.35 + a / 160)); if (v && d < 100 && a > 60) { v.hub(0, V3b); this.tukFx.sparks(V3b.x, V3b.y + 0.3, V3b.z, 0, 0, 6); } } break;
      case VK.Land: if (!mine) { this.play("tuk:land", x, y, z, Math.min(1, 0.4 + a / 200)); v?.bump(-1.6); } if (d < 100) for (let i = 0; i < 6; i++) this.tukFx.dust(x, y - 0.8, z, 0, 0, DUST[this.cm.world.groundBiome(x, z)] ?? TYRE_SMOKE, 1.3); break;
      case VK.Slam: if (!mine) { this.play("tuk:land", x, y, z, 0.55); v?.bump(-1.2); } break;
      case VK.Sunk: this.kits.fx.puff(V3.set(x, 0.1, z), "splash"); this.play("land", x, y, z, 1); break;
      // (the blast itself arrives as EV.Explosion: the kit's burst + the bang) — here its fireball, its black column and
      // its wheels, bars and banana-laden canopy sailing off
      case VK.Boom: this.addTrauma(Math.max(0, 1 - d / 60) * 0.5); if (d < 320) { this.tukFx.blast(x, y, z); const bits = tukDebris(); for (const o of bits) patchTree(this.engine, o); this.tukFx.throwPieces(bits, x, y, z); } break;
    }
  }
  /** damage landed on a tuk-tuk: mine shows like a hit on a kong (marker + a stacking number), white */
  vehHit(shooter: number, veh: number, dmg: number, x: number, y: number, z: number) {
    if (shooter !== this.cm.me) return;
    const now = performance.now(), key = 1000 + veh;
    this.hud.hitMarker = { kind: "body", at: now, predicted: false };
    const dn = this.dmgFor(key, now);
    if (dn) { dn.ca += dmg; dn.last = now; dn.x = x; dn.y = y + 0.3; dn.z = z; } else this.pushDmg(now, x, y + 0.3, z, 0, dmg, "body", key);
  }
  /** MY vehicle, straight from the prediction (no round trip): what its step just reported */
  tukFeel(id: number, evt: number, hard: number) {
    const v = this.tuks.get(id);
    if (this.cm.vehicles[id]?.kind === VKind.Heli) {
      if (evt & VE.CRASH) { this.sfx("tuk:crash", { volume: Math.min(1, 0.3 + hard / 14) }); this.addTrauma(Math.min(0.7, hard / 20)); v?.bump(-hard * 0.1, (Math.random() - 0.5) * hard * 0.04); gamepads.rumble(0.7, 0.4, 160); }
      if (evt & VE.LAND) { this.sfx("tuk:land", { volume: Math.min(1, 0.35 + hard / 16) }); this.addTrauma(Math.min(0.5, hard / 26)); v?.bump(-hard * 0.14); gamepads.rumble(0.5, 0.3, 140); }
      else if (evt & VE.SLAM) { this.sfx("tuk:land", { volume: 0.4 }); this.addTrauma(0.08); v?.bump(-0.9); gamepads.rumble(0.25, 0.15, 90); }
      if (evt & VE.TIP) { this.addTrauma(0.7); gamepads.rumble(1, 0.8, 400); }
      return;
    }
    if (evt & VE.CRASH) { this.sfx("tuk:crash", { volume: Math.min(1, 0.3 + hard / 13) }); this.addTrauma(Math.min(0.6, hard / 22)); v?.bump(-hard * 0.12, (Math.random() - 0.5) * hard * 0.05); if (v && hard > 5) { v.hub(0, V3b); this.tukFx.sparks(V3b.x, V3b.y + 0.3, V3b.z, 0, 0, 6); } }
    if (evt & VE.LAND) { this.sfx("tuk:land", { volume: Math.min(1, 0.35 + hard / 16) }); this.addTrauma(Math.min(0.5, hard / 30)); v?.bump(-hard * 0.16); }
    if (evt & VE.SLAM) { this.sfx("tuk:land", { volume: 0.6 }); this.addTrauma(0.12); v?.bump(-1.4); }
    if (evt & VE.HOP) { this.sfx("tuk:land", { volume: 0.3 }); v?.bump(1.8); }   // (the hop — springs unload, a thump)
    if (evt & VE.ROLL) { this.sfx("tuk:crash", { volume: 0.9 }); this.addTrauma(0.3); }
    if (evt & VE.TIP) { this.sfx("tuk:tip"); this.addTrauma(0.6); }
  }
  /** the E prompt on a POI's signature chest: what is inside, in the mythic colour */
  private mythicPrompt: NonNullable<HudState["interact"]> & { poi?: number } = { label: "OPEN MYTHIC CHEST", key: "E", rarity: "mythic" };
  private mythicChestPrompt(poi: number): NonNullable<HudState["interact"]> {
    const P = this.mythicPrompt;
    if (P.poi !== poi) { P.poi = poi; const k = mythicIndexOfPoi(poi), d = k >= 0 ? MYTHICS[k] : null; P.detail = d ? `MYTHIC · ${POIS[poi].name}'S SIGNATURE ${WEAPON_DEFS[d.weapon].name}` : "MYTHIC"; P.ammo = d ? d.name : undefined; P.candidateId = -1000 - poi; }
    return P;
  }
  /** the E prompt for vehicle `id` (the server's rules: Match.useVehicle) */
  private tukPrompt(id: number): NonNullable<HudState["interact"]> {
    const cm = this.cm, sim = cm.vehs.list[id], P = TUK_PROMPT, heli = sim.kind === VKind.Heli, name = heli ? "HELICOPTER" : "TUK-TUK";
    P.detail = undefined; P.ammo = undefined; P.blocked = undefined; P.change = undefined;
    if (sim.st === VS.Tipped) { P.label = "FLIP TUK-TUK"; if (Math.hypot(sim.vx, sim.vz) > TUK.FLIP_V) P.blocked = "STILL SLIDING"; else P.detail = "HEAVE IT BACK ONTO ITS WHEELS"; return P; }
    const seat = freeSeat(sim, cm.pred.team, (i) => (i === cm.me ? cm.pred.team : cm.remotes[i]?.team ?? -1));
    if (seat < 0) { P.label = name; P.blocked = sim.seats.some((i) => i >= 0 && i !== cm.me && cm.remotes[i]?.team !== cm.pred.team) ? "ANOTHER SQUAD IS ABOARD" : "FULL"; return P; }
    if (heli) { P.label = seat === 0 ? "FLY HELICOPTER" : seat === HELI.GUN_SEAT ? "MAN THE MINIGUN" : "RIDE SHOTGUN"; P.detail = seat === 0 ? "KONG AIR · 3 SEATS" : seat === HELI.GUN_SEAT ? `${TOP_BANANA.name} · ${sim.gunBelt} ROUNDS ON THE BELT` : "IN THE RIGHT DOOR · YOUR OWN GUNS"; }
    else { P.label = seat === 0 ? "DRIVE TUK-TUK" : "RIDE TUK-TUK"; P.detail = seat === 0 ? "BANANA CO. TAXI · 3 SEATS" : "ON THE BENCH · SHOOT FROM THE BACK"; }
    P.change = `HULL ${Math.max(0, Math.round((sim.hp / specOf(sim.kind).HP) * 100))}%`;
    return P;
  }

  // ---- spectating: the camera rides behind the watched kong and turns with where it looks (smoothed,
  // so you see its fight), plus your own drag (the cursor is free for the bar's arrows / the list) that eases back
  // after 2.5 s; the wheel zooms. A new target is a camera CUT, never a flight across the island.
  private specCamId = -1; private specYawS = 0; private specPitchS = 0; private specOrbitYaw = 0; private specOrbitPitch = 0; private specOrbitAt = -1e9; private specDist = 4.5;
  /** the drag on the game while spectating (mouse px) */
  specOrbit(dx: number, dy: number) {
    this.specOrbitYaw -= dx * 0.0045; this.specOrbitPitch = Math.max(-1.1, Math.min(0.9, this.specOrbitPitch - dy * 0.0038)); this.specOrbitAt = performance.now();
  }
  /** the wheel while spectating */
  specZoom(dy: number) { this.specDist = Math.max(2.4, Math.min(10, this.specDist * Math.exp(dy * 0.0012))); }
  /** the watched kong's server motion comes in bursts — its own input jitter / frame hitches,
   * which the server consumes 1:1 (Match.runHuman), so it stops and then catches up a few ticks at once (about twice the
   * metres in a tuk-tuk: a driver steps it once per input). Every observer gets the same bursts, but the spectate camera
   * rides 4.5 m behind and looked AT the raw point every frame: the whole view shook and the kong surged away and was
   * reeled back (rubber-banding). The watched kong — its actor on foot, its tuk-tuk (and so its seat) when it rides —
   * and the camera's follow point share one short low-pass instead (offset = smoothed − raw). Drawing only: the spectator
   * never shoots, hit tests use the raw blend (ClientMatch.viewTargets / viewVehs). */
  private readonly specSm = { id: -1, veh: -1, rx: 0, ry: 0, rz: 0, ox: 0, oy: 0, oz: 0 };
  private specSmooth(r: Remote | null, dt: number) {
    const S = this.specSm;
    if (!r) { S.id = -1; S.veh = -1; S.ox = S.oy = S.oz = 0; return; }
    const v = r.st === PS.Ride && r.veh >= 0 ? this.cm.vehicles[r.veh] : null, ride = !!v && v.live && v.n > 0 && !v.mine;
    const x = ride ? v!.x : r.x, y = ride ? v!.y : r.y, z = ride ? v!.z : r.z, veh = ride ? v!.id : -1;
    const dx = x - S.rx, dy = y - S.ry, dz = z - S.rz;
    // another kong, in / out of a tuk-tuk, a teleport (redeploy): cut, never smooth across it
    if (S.id !== r.id || S.veh !== veh || dx * dx + dy * dy + dz * dz > 16) S.ox = S.oy = S.oz = 0;
    else { const k = Math.exp(-dt / SPEC_SMOOTH_S); S.ox = (S.ox - dx) * k; S.oy = (S.oy - dy) * k; S.oz = (S.oz - dz) * k; }
    S.id = r.id; S.veh = veh; S.rx = x; S.ry = y; S.rz = z;
    if (ride) { v!.ox = S.ox; v!.oy = S.oy; v!.oz = S.oz; }
  }
  private spectateCamera(r: Remote, dt: number) {
    const cam = this.engine.camera;
    // the follow point: the watched kong as drawn (specSmooth), not its raw interpolated position
    const so = this.specSm, fx = r.x + so.ox, fy = r.y + so.oy, fz = r.z + so.oz;
    const cut = r.id !== this.specCamId;
    if (cut) { this.specCamId = r.id; this.specYawS = r.yaw; this.specPitchS = r.pitch; this.specOrbitYaw = 0; this.specOrbitPitch = 0; this.specFree = 1; }
    let dyaw = r.yaw - this.specYawS; while (dyaw > Math.PI) dyaw -= Math.PI * 2; while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const k = Math.min(1, dt * 5); this.specYawS += dyaw * k; this.specPitchS += (r.pitch - this.specPitchS) * k;
    if (performance.now() - this.specOrbitAt > 2500) { const e = Math.min(1, dt * 1.6); this.specOrbitYaw -= this.specOrbitYaw * e; this.specOrbitPitch -= this.specOrbitPitch * e; }
    this.specYaw = this.specYawS + this.specOrbitYaw;
    this.specPitch = Math.max(-1.2, Math.min(0.6, -0.2 + this.specPitchS * 0.45 + this.specOrbitPitch));
    const dist = this.specDist * (r.st === PS.Ride ? 1.7 : 1);
    const cy = Math.cos(this.specPitch), ox = Math.sin(this.specYaw) * cy * dist, oz = Math.cos(this.specYaw) * cy * dist, oy = -Math.sin(this.specPitch) * dist + 1.6;
    V3.set(fx + ox, fy + oy, fz + oz);
    const g = this.engine.terrain.height(V3.x, V3.z) + 0.6; if (V3.y < g) V3.y = g;
    // collide: never behind a wall — sphere-cast from the spectated kong's head, pull in at once, ease out
    const hx = fx, hy = fy + 1.5, hz = fz, want = Math.hypot(V3.x - hx, V3.y - hy, V3.z - hz);
    const free = camCast(this.cm.world, hx, hy, hz, V3.x, V3.y, V3.z, 0.3), u = want > 1e-3 ? Math.min(1, Math.max(0.15, free / want)) : 1;
    this.specFree = u < this.specFree ? u : this.specFree + (u - this.specFree) * Math.min(1, dt * 4);
    V3.set(hx + (V3.x - hx) * this.specFree, hy + (V3.y - hy) * this.specFree, hz + (V3.z - hz) * this.specFree);
    if (cut || this.specFree < 0.999) cam.position.copy(V3); else cam.position.lerp(V3, Math.min(1, dt * 12));
    cam.lookAt(fx, fy + 1.5, fz);
  }

  private async ensureActor(id: number, team: number): Promise<ActorSlot | null> {
    const a = this.actors.get(id); if (a) return a;
    const pending = this.actorPending.get(id); if (pending) { await pending; return this.actors.get(id) ?? null; }
    const pr = (async () => {
      const actor = await this.kits.createKong(this.engine, { variant: id % 6 });
      actor.setOutfit?.(outfitFor(id, this.cm.seed));   // same look on every client (id + match seed)
      this.engine.scene.add(actor.object); patchTree(this.engine, actor.object);
      const slot: ActorSlot = { actor, pose: makePose(team), glider: null, id, lastFire: 0, lastReload: 0, stepAcc: 0, wasGrounded: true, swimEvt: 0 };
      this.actors.set(id, slot); this.actorPending.delete(id);
    })();
    this.actorPending.set(id, pr); await pr; return this.actors.get(id) ?? null;
  }
  private actorPending = new Map<number, Promise<void>>();
  private gliderPending = new Map<number, boolean>();
  private dressedSeed = NaN;
  private updateActors(dt: number, t: number) {
    // "not heard from" counts snapshots that arrived without this kong (it left interest / the body was
    // cleared), never the clock running on through a delivery stall: a stall freezes everyone where they were (the
    // interpolation holds its newest sample) instead of hiding every kong until the data catches up
    const cm = this.cm, me = cm.me, st = cm.snapTick();
    // the watched kong on foot is drawn on the spectate camera's smoothed follow point (specSmooth)
    const so = this.specSm, sid = so.id >= 0 && so.veh < 0 ? so.id : -1;
    // a new match seed (PLAY AGAIN, a reconnect into another match) re-dresses every kong for it
    if (cm.seed !== this.dressedSeed) { this.dressedSeed = cm.seed; for (const a of this.actors.values()) a.actor.setOutfit?.(outfitFor(a.id, cm.seed)); this.meActor?.setOutfit?.(outfitFor(me, cm.seed)); }
    const cx = this.engine.camera.position.x, cy = this.engine.camera.position.y, cz = this.engine.camera.position.z;
    for (const r of cm.remotes) {
      if (r.id === me) continue;
      const a = this.actors.get(r.id);
      if (r.n === 0) { if (a) { a.actor.setVisible(false); if (a.glider) a.glider.object.visible = false; } continue; }
      const stale = st - r.lastTick > 90; // 1.5 s without data → hide
      if (!a) { if (!stale && r.st !== PS.Plane) void this.ensureActor(r.id, r.team); continue; }
      const show = !stale && r.st !== PS.Plane && r.st !== PS.Spectate && !(r.st === PS.Dead && st - r.lastTick > 120);
      a.actor.setVisible(show);
      if (!show) { if (a.glider) a.glider.object.visible = false; continue; }
      const pose = a.pose;
      pose.x = r.x; pose.y = r.y; pose.z = r.z; pose.yaw = r.yaw; pose.pitch = r.pitch; pose.vx = r.vx; pose.vy = r.vy; pose.vz = r.vz;
      if (r.id === sid) { pose.x += so.ox; pose.y += so.oy; pose.z += so.oz; }
      pose.state = stateOf(r); pose.crouch = r.crouch; pose.sprint = r.sprint;
      // a kong on the surface rides the swell (the sim floats it at a fixed line; the drawn sea heaves ±0.3 m), fading
      // out over its first 0.6 m of a dive
      if (r.swim && r.st === PS.Ground) { const k = Math.min(1, Math.max(0, (r.y - (SWIM_FLOAT_Y - 0.6)) / 0.6)); if (k > 0) pose.y += k * (this.waterApi()?.surfaceAt(r.x, r.z, this.engine.time) ?? 0); }
      // a climber's body faces its ladder / trunk whatever it looks at
      if (r.st === PS.Climb) { const c = this.climbViews.nearest(r.x, r.y, r.z); if (c) pose.yaw = Math.atan2(c.nx, c.nz); }
      pose.seatPitch = 0; pose.seatRoll = 0; pose.grips = null;
      // in a tuk-tuk: seated on it exactly as IT is drawn (the driver faces where it does, the bench where it aims)
      if (r.st === PS.Ride) { const vr = r.veh >= 0 ? cm.vehicles[r.veh] : null; if (vr && vr.live && vr.n > 0) this.seatPose(pose, vr, r.seat, r.seat === 0 ? vr.yaw + vr.oyaw : r.yaw, r.pitch); }
      // (a helicopter's door gunner has its own guns holstered: both fists are on the minigun)
      const gunning = r.st === PS.Ride && r.seat === HELI.GUN_SEAT && r.veh >= 0 && cm.vehicles[r.veh]?.kind === VKind.Heli;
      // (swimming: a stowed gun rides as HELD_STOWED — both arms stroke)
      pose.weapon = !gunning && r.held < 0x80 && r.held !== 0xff && !(r.held & HELD_STOWED) ? WEAPONS[r.held & 7] ?? null : null;
      pose.fired = (r.anim & 8) !== 0 || performance.now() - a.lastFire < 90;
      pose.reloading = (r.anim & 1) !== 0; pose.hurt = (r.anim & 4) !== 0;
      pose.team = r.team; pose.friendly = r.team === cm.pred.team;
      a.actor.apply(pose, dt);
      this.caster?.actor?.(r, a.actor);
      // a kong holding a mythic shows its camo (the held byte's tier bits: 5 = mythic)
      this.kits.weapons.setHeldMythic?.(a.actor.object, pose.weapon !== null && ((r.held >> 3) & 7) >= 5);
      // footsteps of nearby kongs (enemy audio is gameplay information)
      const d2 = (r.x - cx) ** 2 + (r.y - cy) ** 2 + (r.z - cz) ** 2;
      // their swim strokes: on the animator's stroke beat (the sound + the splash land with the arms)
      if (r.swim && r.st === PS.Ground && a.actor.swimEvt) {
        const ev = a.actor.swimEvt();
        if (ev !== a.swimEvt) { a.swimEvt = ev; if (d2 < 45 * 45) this.swimStroke(r.x, r.y, r.z, r.yaw, a.actor.swimEvtKind?.() ?? 0, ev, false, Math.sqrt(d2)); }
      }
      if (r.st === PS.Ground && r.grounded && d2 < 45 * 45) {
        const sp = Math.hypot(r.vx, r.vz); a.stepAcc += sp * dt;
        const stride = r.sprint ? 2.75 : r.crouch ? 1.4 : 2.1;
        if (a.stepAcc > stride && sp > 0.8) { a.stepAcc = 0; if (!r.crouch) this.play(`step:${surfaceAt(this.engine.terrain, 255, r.x, r.z)}`, r.x, r.y, r.z, r.sprint ? 0.9 : 0.65); }
        if (!a.wasGrounded) this.play("land", r.x, r.y, r.z, 0.5);
      }
      a.wasGrounded = r.grounded;
      // glider
      if (r.st === PS.Glide) {
        if (!a.glider && !this.gliderPending.get(r.id)) { this.gliderPending.set(r.id, true); void this.kits.createGlider(this.engine).then((g) => { if (g.object.children.length === 0) g.object.add(placeholderGlider()); g.setLod(true); this.engine.scene.add(g.object); patchTree(this.engine, g.object); a.glider = g; }); }
        if (a.glider) { a.glider.object.visible = true; a.glider.object.position.set(pose.x, pose.y + 2.3, pose.z); a.glider.object.rotation.set(0, r.yaw, 0); a.glider.setBank(0, r.pitch * 0.3); a.glider.update(dt, t); }
      } else if (a.glider) a.glider.object.visible = false;
    }
    // my own glider (seen from below)
    const p = cm.pred;
    if (p.st === PS.Glide) {
      this.ensureMyGlider();
      // the deploy is an unfold, not a pop — the canopy blooms out of the pack (scale 0.15 -> 1 with a small
      // overshoot, rising from the shoulders to its 2.3 m) over ~0.45 s
      if (this.myGlider && this.gliderOpenAt < 0) this.gliderOpenAt = this.engine.time;
      const u = Math.min(1, (this.engine.time - this.gliderOpenAt) / 0.45), ob = 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2;
      if (this.myGlider) { this.dropBody(V3); this.myGlider.object.visible = true; this.myGlider.object.scale.setScalar(Math.max(0.15, ob)); this.myGlider.object.position.set(V3.x, V3.y + 1.2 + 1.1 * Math.min(1, ob), V3.z); this.myGlider.object.rotation.set(0, this.dropYaw, 0); this.myGlider.setBank(-this.cm.cur.mx * 0.35, this.input.pitch * 0.3); if (this.third) this.restRisers(this.myGlider); else this.gripRisers(this.myGlider); this.myGlider.update(dt, t); }
    } else { if (this.myGlider) this.myGlider.object.visible = false; this.gliderOpenAt = -1; }
  }
  /** wind streaks — a world-fixed lattice of faint motes wrapped around the camera
   *  (GPU only: one instanced draw, 4 uniforms a frame) and stretched along the fall velocity, so 36-60 m/s of freefall
   *  READS as speed (first person has no skydive trail or wind to sell it). Fades in with the speed
   *  on a spring, softer under the glider, never within 2.5 m of the eye. */
  private windStreaks(dt: number, off: boolean) {
    const p = this.cm.pred, air = !off && (p.st === PS.Freefall || p.st === PS.Glide);
    const spd = Math.hypot(p.vx, p.vy, p.vz), ss = (a: number, b: number, v: number) => { const u = Math.max(0, Math.min(1, (v - a) / (b - a))); return u * u * (3 - 2 * u); };
    const want = !air || preferences.value.reducedMotion ? 0 : p.st === PS.Freefall ? 0.18 + 0.42 * ss(20, 58, spd) : 0.16 * ss(10, 30, spd);
    this.windA += (want - this.windA) * (1 - Math.exp(-dt * 3));
    if (!this.windMesh) { if (this.windA < 0.003) return; this.ensureWind(); }
    const m = this.windMesh!, u = (m.material as THREE.ShaderMaterial).uniforms;
    m.visible = this.windA > 0.003;
    if (!m.visible) return;
    u.uA.value = this.windA; u.uCam.value.copy(this.engine.camera.position);
    // the streak follows the drawn body velocity (the camera's own derivative carries frame-time jitter)
    { const k = 1 - Math.exp(-dt * 12), w = this.windVel; w.x += (p.vx - w.x) * k; w.y += (p.vy - w.y) * k; w.z += (p.vz - w.z) * k; u.uVel.value.copy(w); }
  }
  private ensureWind(): THREE.Object3D {
    if (this.windMesh) return this.windMesh;
    const N = 260, R = 26, g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    const a = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) { a[i * 4] = Math.random() * 2 * R; a[i * 4 + 1] = Math.random() * 2 * R; a[i * 4 + 2] = Math.random() * 2 * R; a[i * 4 + 3] = Math.random(); }
    g.setAttribute("aP", new THREE.InstancedBufferAttribute(a, 4)); g.instanceCount = N;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3(0, -1, 0) }, uA: { value: 0 }, uR: { value: R } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      vertexShader: /* glsl */ `
        attribute vec4 aP; uniform vec3 uCam; uniform vec3 uVel; uniform float uA; uniform float uR;
        varying float vA; varying float vU; varying float vS;
        void main() {
          vec3 p = uCam + mod(aP.xyz - uCam, 2.0 * uR) - uR;      // world-fixed motes, wrapped around the camera
          float spd = length(uVel); vec3 d = uVel / max(spd, 1e-3);
          float len = clamp(spd * 0.05, 0.0, 3.2) * (0.55 + 0.9 * aP.w);
          vec3 q = p + d * len * position.x;                         // head = the mote, tail = where it was 50 ms ago
          vec3 view = normalize(cameraPosition - q);
          vec3 side = normalize(cross(d, view) + 1e-5);
          float dist = length(p - uCam);
          q += side * position.y * (0.012 + 0.0016 * dist);
          vA = uA * smoothstep(2.5, 7.0, dist) * (1.0 - smoothstep(uR * 0.55, uR * 0.92, dist)) * (0.35 + 0.65 * aP.w);
          vU = position.x; vS = position.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(q, 1.0);
        }`,
      fragmentShader: /* glsl */ `varying float vA; varying float vU; varying float vS;
        void main() { float k = vA * (1.0 - vU) * (1.0 - vS * vS); gl_FragColor = vec4(vec3(0.86, 0.93, 1.0) * k * 0.55, k); }`,
    });
    const m = new THREE.Mesh(g, mat); m.name = "drop-wind"; m.frustumCulled = false; m.renderOrder = 5; m.visible = false;
    this.engine.scene.add(m); this.windMesh = m;
    return m;
  }
  private windMesh: THREE.Mesh | null = null; private windA = 0; private readonly windVel = new THREE.Vector3(0, -1, 0);
  private myGlider: GliderProps | null = null; private gliderOpenAt = -1;
  private ensureMyGlider() {
    if (this.myGlider || this.gliderPending.get(-1)) return;
    this.gliderPending.set(-1, true);
    void this.kits.createGlider(this.engine).then((g) => { if (g.object.children.length === 0) g.object.add(placeholderGlider()); g.object.visible = false; g.setTails?.(false); this.engine.scene.add(g.object); patchTree(this.engine, g.object); this.myGlider = g; });
  }
  /** the risers end in MY first-person fists (viewmodel parachute hands) once they close on them */
  private riserDef: [THREE.Vector3, THREE.Vector3] | null = null;
  private gripRisers(g: GliderProps) {
    const vm = this.kits.viewModel as ViewModel & Partial<AirHands>;
    if (!vm.airGrip) return;
    this.riserDef ??= [g.handL.clone(), g.handR.clone()];
    const L = this.riserL, R = this.riserR;
    // the fists turn their grip along the ropes they hold (the riser tops are up behind the head)
    if (vm.airRope && g.riserTops?.(L, R)) vm.airRope(L, R);
    const w = vm.airGrip(L, R);
    g.object.updateMatrixWorld();
    g.object.worldToLocal(L).lerpVectors(this.riserDef[0], L, w); g.object.worldToLocal(R).lerpVectors(this.riserDef[1], R, w);
    g.setHands(L, R);
  }
  /** third person: the risers end where the glider's own model has them (the third-person kong's fists on the bar) */
  private restRisers(g: GliderProps) {
    this.riserDef ??= [g.handL.clone(), g.handR.clone()];
    g.setHands(this.riserL.copy(this.riserDef[0]), this.riserR.copy(this.riserDef[1]));
  }
  private riserL = new THREE.Vector3(); private riserR = new THREE.Vector3();
  private updatePlane(dt: number, t: number) {
    const cm = this.cm, pl = this.kits.plane;
    const inPlanePhase = cm.phase === 1;
    pl.object.visible = inPlanePhase;
    if (!inPlanePhase) { this.stopLoop("plane:drone"); if (cm.phase === 2) releasePlanePaint(); else if (cm.phase > 2) void restorePlanePaint(); return; }
    this.planePosSmooth(PP);
    // the drone follows the plane: cabin sound while riding, a flyover from the ground once you jumped
    POS3[0] = PP.x; POS3[1] = PLANE_ALT + 2; POS3[2] = PP.z; this.loops.add("plane:drone");
    this.kits.audio.play("plane:drone", { loopId: "plane:drone", pos: POS3 });
    pl.object.position.set(PP.x, PLANE_ALT, PP.z);
    pl.object.rotation.set(0, Math.atan2(-cm.plane.dx, -cm.plane.dz), 0);
    // the ramp lowers over ~1.6 s once the bay opens; riders keep the interior lit (never below 0.002: the bay
    // lining/cargo meshes hide at 0)
    const want = (cm.flags & 8) ? 1 : 0;
    this.rampOpen += Math.sign(want - this.rampOpen) * Math.min(Math.abs(want - this.rampOpen), dt * 0.65);
    pl.setRamp(Math.max(cm.pred.st === PS.Plane ? 0.002 : 0, this.rampOpen)); pl.setGear(0); pl.setEngines(true); pl.update(dt, t);
  }
  /** every 0.4 s (camera moved ≥ 8 m): queue loot / chest views that came into range, hide chests that left it. Views are
   * built a few per frame (never a burst at match start), nearest first.
   * Two centres: the camera, and — in the air — where you are going to
   * touch down (the drop's ground track, ≤ 320 m ahead): the POI you glide into is built before you get there. Both
   * queues are ordered by distance to the nearer centre every cull (the loot queue was first-come: a plane ride queued
   * hundreds of items along the flight line and the town you dropped into waited behind them), stale entries (out of
   * range again) are dropped when they come up. */
  private cullLoot() {
    const cm = this.cm, cam = this.engine.camera; const cx = cam.position.x, cz = cam.position.z, p = cm.pred;
    const air = p.st === PS.Freefall || p.st === PS.Glide;
    if (air) {
      // the ground track: the drop keeps its horizontal velocity until it touches down (agl / sink rate), capped
      const agl = Math.max(0, p.y - Math.max(0, this.engine.terrain.height(p.x, p.z))), sink = Math.max(6, -p.vy);
      const k = Math.min(agl / sink, 320 / Math.max(1, Math.hypot(p.vx, p.vz)));
      this.landX = p.x + p.vx * k; this.landZ = p.z + p.vz * k; this.landOn = true;
    } else this.landOn = false;
    const lx = this.landOn ? this.landX : cx, lz = this.landOn ? this.landZ : cz;
    if (Math.hypot(cx - this.lastCullX, cz - this.lastCullZ) < 8 && Math.hypot(lx - this.lastLandX, lz - this.lastLandZ) < 8 && this.lootViews.size + this.chestViews.size > 0) return;
    this.lastCullX = cx; this.lastCullZ = cz; this.lastLandX = lx; this.lastLandZ = lz;
    const R = LOOT_R * LOOT_R;
    const d2 = (x: number, z: number) => Math.min((x - cx) ** 2 + (z - cz) ** 2, (x - lx) ** 2 + (z - lz) ** 2);
    for (const it of cm.items.values()) {
      const d = d2(it.x, it.z);
      const has = this.lootViews.has(it.id);
      if (d < R && !has) this.ensureLoot(it, true);
      else if (d > R * 1.3 && has) { const lv = this.lootViews.get(it.id)!; this.drops.delete(lv); this.grow.delete(lv.object); lv.dispose(); this.lootViews.delete(it.id); }
    }
    this.boxes.sync(cm.chests, cx, cz);
    for (const c of cm.chests) {
      if (c.box) continue;
      const d = (c.x - cx) ** 2 + (c.z - cz) ** 2;
      const v = this.chestViews.get(c.id);
      if (v) { const on = v.object.visible ? d < CHEST_HIDE_R * CHEST_HIDE_R : d < CHEST_SHOW_R * CHEST_SHOW_R; if (v.object.visible !== on) v.object.visible = on; }
      else if (d2(c.x, c.z) < CHEST_BUILD_R * CHEST_BUILD_R && !this.chestPending.has(c.id)) { this.chestPending.add(c.id); this.buildQ.push(c.id); }
    }
    // nearest first (to the nearer centre)
    this.buildQ.sort((a, b) => { const A = cm.chests[a], B = cm.chests[b]; return (A ? d2(A.x, A.z) : 1e12) - (B ? d2(B.x, B.z) : 1e12); });
    this.lootQ.sort((a, b) => (a.bornAt > 0 ? -1e12 : d2(a.x, a.z)) - (b.bornAt > 0 ? -1e12 : d2(b.x, b.z)));
  }
  private landOn = false; private landX = 0; private landZ = 0; private lastLandX = 1e9; private lastLandZ = 1e9;
  /** is (x, z) within `r` m of the camera or of the predicted touchdown? */
  private inBuildRange(x: number, z: number, r: number) {
    const c = this.engine.camera.position;
    return (x - c.x) ** 2 + (z - c.z) ** 2 < r * r || (this.landOn && (x - this.landX) ** 2 + (z - this.landZ) ** 2 < r * r);
  }
  private lootPending = new Set<number>();
  private chestPending = new Set<number>();
  private buildQ: number[] = [];
  private lootQ: Item[] = [];
  /** views appearing within sight grow out of their floor point over GROW_S instead of popping in (the same shrink the
   * loot / chest systems use at their far edge, run backwards) */
  private readonly grow = new Map<THREE.Object3D, number>();
  private stepGrow(dt: number) {
    for (const [o, t0] of this.grow) {
      const t = t0 + dt, u = Math.min(1, t / GROW_S), k = u * u * (3 - 2 * u);
      o.scale.setScalar(Math.max(0.001, k));
      if (u >= 1) this.grow.delete(o); else this.grow.set(o, t);
    }
  }
  /** a view just built: grow it in when it is within the distance it would be drawn at (else it already fades in with distance) */
  private growIn(o: THREE.Object3D, drawR: number) {
    const c = this.engine.camera.position;
    if ((o.position.x - c.x) ** 2 + (o.position.y - c.y) ** 2 + (o.position.z - c.z) ** 2 > drawR * drawR) return;
    o.scale.setScalar(0.001); this.grow.set(o, 0);
  }
  /** spend a small time budget on view builds every frame: at least 2 chests + 3 items, more while there is time left
   * (≤ 1.6 ms; a landing town is built in a second, not in five) */
  private buildViews() {
    const t0 = performance.now();
    for (let n = 0; n < 6 && this.buildQ.length && (n < 2 || performance.now() - t0 < 0.8); n++) {
      const id = this.buildQ.shift()!; const c = this.cm.chests[id]; if (!c) continue;
      if (!this.inBuildRange(c.x, c.z, CHEST_BUILD_R * 1.15)) { this.chestPending.delete(id); n--; continue; }
      void this.kits.weapons.createChest(rarityOf(c.rarity)).then((v) => {
        if (this.disposed) return;
        v.object.position.set(c.x, c.y, c.z); v.object.rotation.y = c.yaw; this.engine.scene.add(v.object); patchTree(this.engine, v.object); this.chestViews.set(c.id, v);
        prewarmHull(v.hull);
        if (c.opened && !v.opened) { v.open(); this.kits.lights?.track(v.object); }
        else this.growIn(v.object, CHEST_SHOW_R);
      });
    }
    for (let n = 0; n < 16 && this.lootQ.length && (n < 3 || performance.now() - t0 < 1.6); n++) {
      const it = this.lootQ.shift()!;
      if (it.taken || !this.cm.items.has(it.id) || (it.bornAt <= 0 && !this.inBuildRange(it.x, it.z, LOOT_R * 1.15))) { this.lootPending.delete(it.id); continue; }
      const kind = it.kind === IK.Weapon ? WEAPONS[it.sub] : it.kind === IK.Consumable ? CONSUMABLES[it.sub] : it.kind === IK.Cash ? "cash" : "ammo";
      void this.kits.weapons.createLoot(kind, rarityOf(it.rarity), it.kind === IK.Weapon ? mythicOf(it.rarity)?.color ?? null : null).then((v) => {
        this.lootPending.delete(it.id);
        if (this.disposed || it.taken || !this.cm.items.has(it.id)) { v.dispose(); return; }
        v.object.position.set(it.x, it.y, it.z); this.engine.scene.add(v.object); patchTree(this.engine, v.object); this.lootViews.set(it.id, v);
        if (it.bornAt > 0 && this.cm.time - it.bornAt < 1.2) this.startDrop(v, it);
        else this.growIn(v.object, LOOT_DRAW_R);
      });
    }
  }
  /** a freshly spawned item is SEEN falling to where the server put it on the floor: out of the chest mouth
   * in an arc (a spill), or dropping from waist height with a small bounce (a death drop / a swap). Visual only — the
   * item is already where it rests in the sim. */
  private readonly spillFrom = { x: 0, y: 0, z: 0, at: -1e9 };
  private readonly drops = new Map<LootView, { t: number; d: number; sx: number; sy: number; sz: number; ex: number; ey: number; ez: number; h: number }>();
  private startDrop(v: LootView, it: Item) {
    const S = this.spillFrom, spill = performance.now() - S.at < 600 && Math.hypot(it.x - S.x, it.z - S.z) < 3.5 && Math.abs(it.y - S.y) < 3;
    const sx = spill ? S.x : it.x, sz = spill ? S.z : it.z, sy = spill ? S.y + 0.75 : it.y + 0.9;
    const fall = Math.max(0, sy - it.y);
    this.drops.set(v, { t: 0, d: spill ? 0.42 : Math.min(0.9, 0.3 + Math.sqrt(fall) * 0.12), sx, sy, sz, ex: it.x, ey: it.y, ez: it.z, h: spill ? 0.55 : 0 });
    v.object.position.set(sx, sy, sz);
  }
  private stepDrops() {
    const dt = Math.min(0.05, this.frameDt);
    for (const [v, a] of this.drops) {
      a.t += dt;
      const u = Math.min(1, a.t / a.d);
      // horizontal: ease-out (thrown); vertical: gravity-like ease-in onto the floor + the arc of a spill
      const k = 1 - (1 - u) * (1 - u);
      let y = a.sy + (a.ey - a.sy) * (u * u) + a.h * 4 * u * (1 - u);
      // touchdown: one small bounce (0.18 s)
      const b = a.t - a.d; if (b > 0) y = a.ey + Math.max(0, Math.sin(Math.min(1, b / 0.18) * Math.PI)) * 0.07;
      v.object.position.set(a.sx + (a.ex - a.sx) * k, y, a.sz + (a.ez - a.sz) * k);
      if (b > 0.18) { v.object.position.set(a.ex, a.ey, a.ez); this.drops.delete(v); }
    }
  }
  private frameDt = 0.016;
  private ensureLoot(it: Item, inRange = false) {
    this.itemKind.set(it.id, it.kind); this.pickupItems.set(it.id, { kind: it.kind, sub: it.sub, rarity: it.rarity, count: it.count });
    if (this.lootViews.has(it.id) || this.lootPending.has(it.id)) return;
    if (!inRange && !this.inBuildRange(it.x, it.z, LOOT_R)) return;
    this.lootPending.add(it.id);
    // freshly dropped loot (chest burst, a kill) jumps the queue — it is right in front of someone
    if (it.bornAt > 0) this.lootQ.unshift(it); else this.lootQ.push(it);
  }
  /** chests are built lazily near the camera (see cullLoot); this only resets the bookkeeping for a new match */
  async buildChests() {
    for (const v of this.chestViews.values()) v.object.removeFromParent();
    this.chestViews.clear(); this.chestPending.clear(); this.buildQ.length = 0; this.grow.clear();
    this.boxes.reset();
    this.lastCullX = 1e9; this.lastLandX = 1e9;
  }
  private disposed = false;
  /** remove everything this renderer added to the scene (leaving a match) */
  dispose() {
    this.disposed = true;
    this.matchScope.dispose();
  }
  private releaseViews() {
    for (const o of this.standViews) o.removeFromParent(); this.standViews = [];
    this.range?.dispose(); this.range = null;
    for (const a of this.actors.values()) { if (this.kits.releaseKong) this.kits.releaseKong(a.actor, a.id % 6); else a.actor.dispose(); a.glider?.object.removeFromParent(); }
    for (const v of this.lootViews.values()) v.dispose();
    for (const v of this.chestViews.values()) v.object.removeFromParent();
    for (const r of this.rockets.values()) r.mesh.removeFromParent();
    for (const m of this.rocketPool) m.removeFromParent();
    this.myGlider?.object.removeFromParent();
    for (const v of this.tuks.values()) v.dispose();
    this.tuks.clear(); this.tukAudio.clear();
    this.pads = []; this.padScope = null; this.padWorld = null;
    if (this.windMesh) { this.windMesh.removeFromParent(); this.windMesh.geometry.dispose(); (this.windMesh.material as THREE.Material).dispose(); }
    if (this.meActor) { if (this.kits.releaseKong) this.kits.releaseKong(this.meActor, Math.max(0, this.cm.me) % 6); else this.meActor.dispose(); }
    this.streaks.removeFromParent();
    this.kits.viewModel.object.visible = false; this.kits.plane.object.visible = false;
    this.kits.hud.onMapClick = null; this.kits.hud.onMapClear = null;
    this.stopAllLoops();
    this.actors.clear(); this.lootViews.clear(); this.chestViews.clear(); this.rockets.clear(); this.shotPings.clear();
  }

  private fillHud(dt: number, inside: number) {
    const cm = this.cm, p = cm.pred, h = this.hud, s = cm.storm, now = performance.now();
    h.range = !!this.range;
    h.phase = cm.phase === 0 ? "warmup" : cm.phase === 1 ? (p.st === PS.Plane ? "plane" : "drop") : cm.phase === 2 ? (p.st === PS.Freefall || p.st === PS.Glide ? "drop" : "play") : "results";
    h.mode = cm.mode; h.hp = Math.max(0, Math.round(p.hp)); h.shield = Math.max(0, Math.round(p.shield));
    h.alive = cm.alive; h.squadsAlive = cm.squads;
    // the pill clock counts down whatever is next: warm-up → plane, then the storm
    h.stormTimer = cm.phase === 0 ? cm.warmupLeft() : s.timer; h.stormShrinking = cm.phase >= 1 && s.shrinking; h.inStorm = inside > 0.5 && cm.phase >= 1 && s.phase >= 1; h.stormPhase = s.phase;
    h.stormTotal = cm.phase === 0 ? WARMUP_S : cm.plan ? stageLength(cm.plan, s) : 60;
    // the pill says what the clock counts down to; riding the plane it counts to the ramp opening, then to the auto jump
    const riding = cm.phase === 1 && p.st === PS.Plane, rampOpen = riding && cm.planeT() >= PLANE_OPEN_S;
    h.clockLabel = cm.phase === 0 ? "PLANE DEPARTS" : riding ? (rampOpen ? "AUTO JUMP" : "RAMP OPENS") : s.shrinking ? "STORM SHRINKING" : "STORM CLOSES";
    if (riding) { h.stormTimer = Math.max(0, (rampOpen ? PLANE_OPEN_S + PLANE_BAY_S : PLANE_OPEN_S) - cm.planeT()); h.stormTotal = rampOpen ? PLANE_BAY_S : PLANE_OPEN_S; }
    // the warm-up says why it waits: the island is still streaming in (main.ts's stream bookkeeping)
    { const kr = (globalThis as { __kr?: { streamed?: boolean; streamTotal?: number; streamPending?: () => string[] } }).__kr;
      if (cm.phase === 0 && kr && kr.streamed === false) { const tot = Math.max(1, kr.streamTotal ?? 1), left = (kr.streamPending?.() ?? []).length + 1; h.islandLoad = Math.max(0, Math.min(0.99, 1 - left / (tot + 1))); }
      else h.islandLoad = undefined; }
    const wdef = weaponDef(p), gv = p.hp > 0 ? gunOf(cm.vehs, p) : null;
    h.spread = gv ? HELI.GUN_SPREAD + HELI.GUN_SPREAD_HOT * gv.gunHeat : wdef ? currentSpread(p, wdef) : undefined; h.fov = this.engine.camera.fov; h.kills = cm.phase === 0 ? undefined : this.kills;
    h.damage = Math.round(this.damage);   // (Toon HUD) the match-stats damage chip
    // behind TOP BANANA: its panel (rounds left, the heat, overheated / empty) and the pip where its barrels point
    if (gv && !cm.viewTarget()) {
      const g = (h.gun ??= { name: TOP_BANANA.name, belt: 0, beltMax: HELI.GUN_BELT, heat: 0, lock: false, spin: 0, pip: null });
      g.belt = gv.gunBelt; g.heat = gv.gunHeat; g.lock = gv.gunLock; g.spin = gv.gunSpin;
      const vr = cm.vehicles[gv.id];
      GP6[0] = vr.x; GP6[1] = vr.y; GP6[2] = vr.z; GP6[3] = vr.yaw; GP6[4] = vr.pitch; GP6[5] = vr.roll;
      gunAngles(gv.gunAimY, gv.gunAimP, GP6, GANG);
      const cp = Math.cos(GANG[3]), cam = this.engine.camera;
      V3b.set(cam.position.x - Math.sin(GANG[2]) * cp * 200, cam.position.y + Math.sin(GANG[3]) * 200, cam.position.z - Math.cos(GANG[2]) * cp * 200).project(cam);
      if (V3b.z < 1) { const pip = (g.pip ??= { sx: 0.5, sy: 0.5 }); pip.sx = (V3b.x + 1) / 2; pip.sy = (1 - V3b.y) / 2; } else g.pip = null;
    } else h.gun = null;
    if (cm.phase === 1) { cm.planePos(PP); h.planePos ??= { x: 0, z: 0 }; h.planePos.x = PP.x; h.planePos.z = PP.z; } else h.planePos = null;
    h.yaw = this.input.yaw;
    const shots = (h.shots ??= []); shots.length = 0;
    for (const [id, q] of this.shotPings) { const a = 1 - (now - q.at) / SHOT_PING_MS; if (a <= 0) this.shotPings.delete(id); else shots.push({ x: q.x, z: q.z, a }); }
    cm.localPose(V3); h.me.x = V3.x; h.me.z = V3.z; h.me.alive = p.st !== PS.Dead;
    // spectating: the minimap and the compass follow the watched kong and the camera
    { const vt = this.spec.active(cm) ? cm.viewTarget() : null; if (vt) { h.me.x = vt.x; h.me.z = vt.z; h.yaw = this.specYaw; } }
    h.safe.cx = s.cx; h.safe.cz = s.cz; h.safe.r = s.r;
    if (s.phase > 0 && (s.tr !== s.r || s.tx !== s.cx)) { h.next ??= { cx: 0, cz: 0, r: 0 }; h.next.cx = s.tx; h.next.cz = s.tz; h.next.r = s.tr; } else h.next = null;
    if (cm.phase === 1) { h.plane ??= { x0: 0, z0: 0, x1: 0, z1: 0 }; h.plane.x0 = cm.plane.x0; h.plane.z0 = cm.plane.z0; h.plane.x1 = cm.plane.x1; h.plane.z1 = cm.plane.z1; } else h.plane = null;
    // squad (rows reused — no per-frame allocation)
    let n = 0;
    const row = (name: string, x: number, z: number, alive: boolean, hp: number, shield: number, me: boolean) => {
      let r = this.squadRows[n]; if (!r) { r = { name: "", x: 0, z: 0, alive: true, hp: 0, shield: 0, me: false }; this.squadRows[n] = r; }
      r.name = name; r.x = x; r.z = z; r.alive = alive; r.hp = hp; r.shield = shield; r.me = me; n++;
    };
    row(this.myName, V3.x, V3.z, p.st !== PS.Dead, p.hp, p.shield, true);
    if (cm.mode === "trios") for (const r of cm.remotes) if (r.n > 0 && r.team === p.team && r.id !== cm.me) { this.mateAt(r, MATE_AT); row(this.name(r.id), MATE_AT.x, MATE_AT.z, r.st !== PS.Dead, r.hp, r.shield, false); }
    h.squad = this.squadRows; this.squadRows.length = n;
    // squadmate world tags (trios): head point → screen; behind / off screen → the HUD clamps it to the edge
    const cam0 = this.engine.camera; cam0.updateMatrixWorld();
    let mn = 0; const mates = this.mateTags; const st0 = cm.snapTick();   // (a delivery stall keeps the tags on the frozen kongs)
    if (cm.mode === "trios" && cm.phase >= 1 && p.st !== PS.Plane) for (const r of cm.remotes) {
      if (r.n === 0 || r.team !== p.team || r.id === cm.me || r.st === PS.Plane || st0 - r.lastTick > 90 || mn >= 3) continue;
      const dead = r.st === PS.Dead || r.st === PS.Spectate;
      if (dead && !(cm.flags & 1)) continue;
      const tg = mates[mn] ??= { name: "", sx: 0, sy: 0, edge: false, dist: 0, state: "alive", hp: 0, shield: 0 }; mn++;
      this.mateAt(r, MATE_AT);
      V3b.set(MATE_AT.x, MATE_AT.y + 2.45, MATE_AT.z).applyMatrix4(cam0.matrixWorldInverse);
      if (V3b.z > -0.2) { const l = Math.hypot(V3b.x, V3b.y) || 1; tg.sx = 0.5 + (V3b.x / l) * 0.5; tg.sy = 0.5 - (V3b.y / l) * 0.5; tg.edge = true; }
      else { V3b.applyMatrix4(cam0.projectionMatrix); tg.sx = (V3b.x + 1) / 2; tg.sy = (1 - V3b.y) / 2; tg.edge = false; }
      tg.name = this.name(r.id); tg.dist = Math.hypot(MATE_AT.x - V3.x, MATE_AT.y - V3.y, MATE_AT.z - V3.z);
      tg.state = dead ? "redeploy" : r.st === PS.Freefall || r.st === PS.Glide ? "air" : "alive"; tg.hp = r.hp; tg.shield = r.shield;
    }
    mates.length = mn; h.mates = mates;
    // hands
    const slot = p.slots[p.active];
    // (a helicopter's door gunner has its own guns holstered: the TOP BANANA panel instead — h.gun above)
    const handsVisible = (weaponHudEligible(p.st) || (p.st === PS.Ride && p.seat !== 0 && !gunOf(cm.vehs, p))) && !cm.viewTarget();
    h.handsVisible = handsVisible;
    if (handsVisible && slot.kind === SK.Weapon) { const w = WEAPON_DEFS[weaponId(slot.id)]; h.ammo ??= { mag: 0, reserve: 0 }; h.ammo.mag = slot.mag; h.ammo.reserve = p.ammo[["light", "heavy", "shells", "rockets"].indexOf(w.ammo)]; } else h.ammo = null;
    for (let i = 0; i < 5; i++) { const sl = p.slots[i], hs = h.hotbar[i]; hs.kind = sl.kind === SK.Weapon ? "weapon" : sl.kind === SK.Consumable ? "consumable" : "empty"; hs.id = sl.kind === SK.Weapon ? weaponId(sl.id) : sl.kind === SK.Consumable ? consumableId(sl.id) : null; hs.rarity = rarityOf(sl.rarity); hs.count = sl.kind === SK.Weapon ? sl.mag : sl.count; hs.name = sl.kind === SK.Weapon ? mythicOf(sl.rarity)?.name : undefined; hs.color = sl.kind === SK.Weapon ? mythicOf(sl.rarity)?.color : undefined; }
    h.activeSlot = p.active;
    if (handsVisible && p.reloadT > 0) { h.reload ??= { t: 0, total: 1 }; h.reload.t = p.reloadTotal - p.reloadT; h.reload.total = p.reloadTotal; } else h.reload = null;
    if (handsVisible && p.useT > 0) { h.using ??= { t: 0, total: 1, label: "" }; h.using.t = p.useTotal - p.useT; h.using.total = p.useTotal; h.using.label = CONSUMABLE_DEFS[consumableId(slot.id)]?.name ?? ""; }
    // a cooking banana bomb: the fuse burning down in the centre ring
    else if (handsVisible && p.cookT > 0) { h.using ??= { t: 0, total: 1, label: "" }; h.using.t = p.cookT; h.using.total = BOMB.fuseS; h.using.label = BOMB_COOK_LABEL; }
    else h.using = null;
    { const k = bombSlot(p), L = k >= 0 ? (h.lethal ??= { count: 0, key: "G", cooking: false }) : null;
      if (L) { let n = 0; for (const s of p.slots) if (s.kind === SK.Consumable && consumableId(s.id) === "banana-bomb") n += s.count; L.count = n; L.key = bindingText("throw", 0).toUpperCase(); L.cooking = p.cookT > 0;
        // the key hints: a bomb in hand (not yet cooking) → HOLD to cook / RELEASE to throw;
        // the first 6 s after bombs come into the inventory → HOLD G to cook one (a tap alone never teaches it)
        if (n > this.bombSeen) this.bombHintUntil = now + 6000; this.bombSeen = n;
        const inHand = k === p.active && p.slots[k].kind === SK.Consumable;
        L.hint = p.cookT > 0 ? 0 : inHand ? 1 : now < this.bombHintUntil ? 2 : 0; }
      else this.bombSeen = 0;
      h.lethal = handsVisible ? L : null; }
    // expire feed / markers
    while (h.killfeed.length && now - h.killfeed[0].at > 7000) h.killfeed.shift();
    while (h.damageDirs.length && now - h.damageDirs[0].at > 1600) h.damageDirs.shift();
    this.dmgDirsAim();
    if (h.hitMarker && now - h.hitMarker.at > 400) h.hitMarker = null;
    if (h.announce && now - h.announce.at > 4500) h.announce = null;
    // damage numbers: project (a stack keeps its `at` key; the HUD merges amount changes into the same number)
    h.damageNumbers.length = 0;
    const cam = this.engine.camera;
    for (let i = this.dmgWorld.length - 1; i >= 0; i--) {
      const d = this.dmgWorld[i]; const age = (now - d.last) / 1000;
      if (age > 1.0 || d.at < 0) { this.dmgPool.push(d); this.dmgWorld.splice(i, 1); continue; }
      V3b.set(d.x, d.y + age * 0.6, d.z).project(cam); if (V3b.z > 1) continue;
      h.damageNumbers.push(dnRow(i, d.at, (V3b.x + 1) / 2, (1 - V3b.y) / 2, Math.round(d.pa + d.ca), d.kind, d.target, d.ca <= 0));
    }
    // interact prompt
    h.interact = null; this.hlKind = 0;
    // (tuk-tuks: aboard, E is the way out; on foot the one under the crosshair comes first — Match.simulate's order)
    const lx = -Math.sin(p.yaw) * Math.cos(p.pitch), ly = Math.sin(p.pitch), lz = -Math.cos(p.yaw) * Math.cos(p.pitch);
    const tukAim = p.st === PS.Ground && p.hp > 0 && !p.swim ? vehicleInReach(cm.vehs, p.x, p.y, p.z, simEyeY(p), lx, ly, lz, true, !p.grounded) : -1;
    // (glass: a whole pane under the crosshair in arm's reach — E punches it out, exactly the server's rule in Match.simulate)
    const pane = tukAim < 0 && p.st === PS.Ground && p.hp > 0 ? glassAim(cm.glass, p.x, simEyeY(p), p.z, lx, ly, lz) : -1;
    if (p.st === PS.Ride && p.hp > 0) { /* aboard: the tuk-tuk's own panel carries the controls (below); E climbs out */ }
    else if (tukAim >= 0) { h.interact = this.tukPrompt(tukAim); this.hlKind = HL.Tuk; this.hlId = tukAim; }
    else if (pane >= 0) { h.interact = INTERACT_GLASS; this.hlKind = HL.Glass; this.hlId = pane; }
    else if (p.st === PS.Ground && p.hp > 0) {
      const c = cm.nearestChest(3.2, true); if (c) { h.interact = c.box ? INTERACT_BOX : c.rarity >= MYTHIC_R ? this.mythicChestPrompt(c.poi) : INTERACT_CHEST; this.hlKind = c.box ? HL.Box : HL.Chest; this.hlId = c.id; }
      else { const it = manualLootCandidate(cm.items.values(), p, cm.world, !!this.range, cm.stands); if (it) { h.interact = lootCard(p, it, !!this.range); this.hlKind = HL.Item; this.hlId = it.id; } }
      if (!h.interact) { const zk = zipNear(p.x, p.y, p.z); if (zk >= 0) { h.interact = INTERACT_ZIP; this.hlKind = HL.Zip; this.hlId = zk; } } // zipline hook
      if (!h.interact && !p.swim) { const nearTuk = vehicleInReach(cm.vehs, p.x, p.y, p.z, simEyeY(p), lx, ly, lz, false, !p.grounded); if (nearTuk >= 0) { h.interact = this.tukPrompt(nearTuk); this.hlKind = HL.Tuk; this.hlId = nearTuk; } }
    } else if (p.st === PS.Zip && p.hp > 0) { INTERACT_UNZIP.label = `LET GO · ${bindingText("jump", 0).toUpperCase()} JUMP OFF`; h.interact = INTERACT_UNZIP; }
    else if (p.st === PS.Climb && p.hp > 0) { INTERACT_CLIMBING.label = `LET GO · ${bindingText("jump", 0).toUpperCase()} JUMP OFF`; h.interact = INTERACT_CLIMBING; }
    // (economy) a Banana Stand in reach: E opens its buy menu (nothing else claimed E)
    this.standNear = -1;
    if (!h.interact && p.st === PS.Ground && p.hp > 0) {
      let bd = ECON.standReach + 0.65;
      cm.stands.forEach((s, i) => { const d = Math.hypot(s.x - p.x, s.z - p.z); if (d < bd && Math.abs(s.y - p.y) < 2.5) { bd = d; this.standNear = i; } });
      if (this.standNear >= 0) { STAND_PROMPT.key = bindingText("use", 0).toUpperCase(); STAND_PROMPT.detail = `$${cm.econ.cash.toLocaleString("en-US")} · BUY BACK · BOUNTIES · BOMBS · COVER`; h.interact = STAND_PROMPT; }
    }
    { const e = this.input.interactHeld(); if (e && !this.lastE && this.standNear >= 0 && h.interact === STAND_PROMPT) this.onShop?.(this.standNear); this.lastE = e; }
    // the crate wall in hand: what fire does
    if (this.coverHeld && !h.interact) { const P = this.coverOk ? COVER_PROMPT : COVER_NO; P.key = bindingText("fire", 0).toUpperCase(); h.interact = P; }
    h.resurgence.on = (cm.flags & 1) !== 0; h.resurgence.final = (cm.flags & 4) !== 0;
    h.resurgence.lives = cm.mode === "solo" ? Math.max(0, SOLO_REDEPLOYS - this.redeploysUsed) : null;
    h.resurgence.countdown = this.deadAt >= 0 && this.resCountdown != null ? Math.max(0, this.resCountdown - (now - this.deadAt) / 1000) : null;
    h.scoped = p.scoped; h.ads = this.adsOn;
    h.scope = p.scoped ? { zoom: WEAPON_DEFS.sniper.scope ?? 6, breath: this.breath, holding: this.breathHold } : null;   // combat: hold breath
    // spectating: the bar + list (game/spectate.ts → ui/spectate.ts) from the moment the server names
    // someone to watch — even before that kong's first snapshot (the camera waits for it, the bar does not)
    h.spectating = this.spec.active(cm) ? this.name(cm.spectate) : null;
    SPEC_KEYS.prev = `← / ${bindingText("left", 0).toUpperCase()}`; SPEC_KEYS.next = `→ / ${bindingText("right", 0).toUpperCase()}`; SPEC_KEYS.list = bindingText("inventory", 0).toUpperCase();
    h.spectate = this.spec.hudView(cm, (id) => this.name(id), SPEC_KEYS, this.names.length || cm.remotes.length);
    if (p.st === PS.Freefall || p.st === PS.Glide) { const g = Math.max(0, this.engine.terrain.height(p.x, p.z)); h.air ??= { altitude: 0, speed: 0, mode: "freefall", cut: 0 }; h.air.altitude = Math.max(0, p.y - g); h.air.speed = Math.hypot(p.vx, p.vy, p.vz); h.air.mode = p.st === PS.Glide ? "glide" : "freefall"; h.air.cut = p.st === PS.Glide ? Math.min(1, p.airT / CHUTE_CUT_HOLD_S) : 0; } else h.air = null;
    h.chuteReady = p.hp > 0 && canPullChute(p, cm.world);
    // swimming: the air meter + the controls the first few times you swim / dive (counted per browser)
    { const sw = p.st === PS.Ground && p.swim && p.hp > 0, now = performance.now();
      const st = sw ? (p.under ? 2 : 1) : 0;
      if (st !== this.swimHudSt) {
        if (st === 1 && this.swimHudSt === 0 && swimHints[0] < 3 && this.engine.terrain.height(p.x, p.z) < -DIVE_MIN_DEPTH) { swimHints[0]++; this.swimHintUntil = now + 6500; saveSwimHints(); }
        else if (st === 2 && swimHints[1] < 3) { swimHints[1]++; this.swimHintUntil = now + 5000; saveSwimHints(); }
        else if (st === 0) this.swimHintUntil = 0;
        this.swimHudSt = st;
      }
      h.swim = (sw || p.breath < 0.999) && p.hp > 0 && p.st === PS.Ground ? { air: p.breath, under: sw && p.under, low: p.breath < 0.3, hint: sw && now < this.swimHintUntil ? (p.under ? "under" : "surface") : null } : null; }
    // aboard a vehicle: hull / speed / seats (a helicopter: its height and climb too); and every vehicle this client
    // knows of for the maps
    { const mv = p.st === PS.Ride && p.hp > 0 ? cm.myVehicle() : null;
      if (mv) {
        const heli = mv.kind === VKind.Heli, A = this.tukAudio.get(mv.id);
        const V = (h.vehicle ??= { hull: 1, speed: 0, seat: 0, burning: false, seats: 0, kind: 0 }); V.kind = mv.kind; V.hull = mv.hp / specOf(mv.kind).HP; V.speed = mv.vf; V.seat = p.seat; V.burning = (mv.flags & VF.BURN) !== 0; V.seats = (mv.seats[0] >= 0 ? 1 : 0) | (mv.seats[1] >= 0 ? 2 : 0) | (mv.seats[2] >= 0 ? 4 : 0) | (1 << p.seat);
        if (heli) { V.alt = Math.max(0, mv.y - Math.max(WATER_Y, this.engine.terrain.height(mv.x, mv.z))); V.climb = A ? A.vy : 0; V.spool = mv.steer; } else { V.alt = undefined; V.climb = undefined; V.spool = undefined; }
        // the controls: chips over the panel for the first seconds in a seat, keys beside the seats (game/tuk-hud.ts) —
        // a helicopter's gunner / passenger on a controller holds interact to get out (game/input.ts passenger)
        const padHold = heli ? device.pad && p.seat > 0 : this.input.benchHoldExit;
        // a helicopter in the air: the pilot's UP / DOWN and HOLD-to-bail chips stay up; DOWN pulses until it has
        // been used for a while; a warning chip leads — the ground under it too steep to land on
        // (low over it, or sliding on it), the engine dead (the stick taken too late)
        const air = heli && (mv.flags & VF.AIR) !== 0, pilot = heli && p.seat === 0;
        let warn = 0;
        if (pilot) {
          const sim = cm.vehs.list[mv.id], T = this.engine.terrain, gy = T.height(mv.x, mv.z);
          if (sim.hopT >= HELI.NO_PILOT_S) warn = 2;
          else if ((V.alt ?? 99) < 8 && gy > WATER_Y && padSlope(cm.world, mv.x, air ? Math.min(mv.y, gy + 2) : mv.y, mv.z, mv.yaw) > HELI.SLOPE_MAX) warn = 1;   // (low over it, or sliding on it)
          if (air && sim.tip < -0.5 && heliDownS < DOWN_TAUGHT_S && (heliDownS += dt) >= DOWN_TAUGHT_S) { try { localStorage.setItem("kr.heliDownS", String(heliDownS)); } catch { /* private window */ } }
        }
        const ctl = tukControls(p.seat, cm.mode === "trios", now, padHold, heli, air, pilot && heliDownS < DOWN_TAUGHT_S, warn); V.hints = ctl.hints; V.keys = ctl.keys; V.hintsOn = now - this.rideAt < (heli ? 10000 : 6500);
        V.fill = pilot && air ? this.input.bailHold : 0;
        // (the radio is a tuk-tuk's: no radio row in a helicopter)
        V.radio = heli ? undefined : stationName(mv.radio); V.tuning = !heli && now - this.tunedAt < 450;
        const use = bindingText("use", 0).toUpperCase(), swap = bindingText("crouch", 0).toUpperCase();
        // a helicopter in the air with nobody at the stick (the pilot swapped seats, bailed out or dropped):
        // it does not hover — it sinks at once and falls as the rotor winds down, and whoever takes the
        // stick in time spools it back up. Say so; once the rotor is half gone, bail out
        const noPilot = heli && p.seat > 0 && mv.seats[0] < 0 && air && !V.burning && mv.st === VS.Ok;
        if (!noPilot) this.noPilotAt = -1; else if (this.noPilotAt < 0) this.noPilotAt = now;
        V.hint = !noPilot ? undefined : mv.steer < 0.5 ? `ROTOR DYING — BAIL OUT · ${padHold ? `HOLD ${use}` : use}` : `FALLING — ${swap} TAKES THE STICK`;
        if (V.hint && !this.noPilotWarned) { this.noPilotWarned = true; this.announce("NOBODY AT THE STICK", `IT IS FALLING — ${swap} TAKES THE STICK`, "warn"); }
        if (mv.seats[0] >= 0) this.noPilotWarned = false;
        if (V.burning && !this.tukWarned) { this.tukWarned = true; const bail = padHold ? `HOLD ${use}` : use; this.announce(heli ? "ENGINE FIRE" : "TUK-TUK ON FIRE", heli ? `IT IS GOING DOWN — BAIL OUT, ${bail}` : `BAIL OUT — ${bail}`, "warn"); }
      }
      else { h.vehicle = null; this.tukWarned = false; }
      const L = (h.vehicles ??= []); let k = 0;
      // (tuk-tuks within TUK_MAP_R of me — the maps are not a taxi radar for the whole island — and mine with its
      // heading; the few helicopters show wherever they are)
      for (const vr of cm.vehicles) { if (!vr.live || vr.n === 0 || vr.st === VS.Gone || vr.st === VS.Sunk) continue; if (mv !== vr && vr.kind !== VKind.Heli && (vr.x - p.x) ** 2 + (vr.z - p.z) ** 2 > TUK_MAP_R * TUK_MAP_R) continue; const e = (L[k] ??= { x: 0, z: 0, mine: false, wreck: false, kind: 0 }); e.x = vr.x; e.z = vr.z; e.mine = mv === vr; e.wreck = vr.st === VS.Wreck; e.yaw = vr.yaw; e.kind = vr.kind; k++; }
      // in the warm-up the map already shows where this match's taxis and helicopters will be waiting (pick your drop)
      if (cm.phase === 0 && !this.range) {
        for (const sp of cm.taxiRanks()) { const e = (L[k] ??= { x: 0, z: 0, mine: false, wreck: false, kind: 0 }); e.x = sp.x; e.z = sp.z; e.mine = false; e.wreck = false; e.yaw = undefined; e.kind = 0; k++; }
        for (const sp of cm.heliSpots()) { if (sp.poi === ISLET_POI) continue; const e = (L[k] ??= { x: 0, z: 0, mine: false, wreck: false, kind: 0 }); e.x = sp.x; e.z = sp.z; e.mine = false; e.wreck = false; e.yaw = undefined; e.kind = 1; k++; }
      }
      L.length = k; }
    // (economy) the wallet, the stands, my squad's contract, the bounty on my squad
    if (!this.range && cm.stands.length) {
      const E = (h.econ ??= { cash: 0, stands: [], bounty: null, hunted: 0 }), e = cm.econ;
      E.cash = e.cash; E.hunted = cm.phase === 2 ? e.huntedLeft : 0;
      if (E.stands.length !== cm.stands.length) E.stands = cm.stands.map((s) => ({ x: s.x, z: s.z }));
      if (e.huntTeam !== 255 && e.huntLeft > 0 && cm.phase === 2) {
        const B = (E.bounty ??= { x: 0, z: 0, r: ECON.bounty.circleR, left: 0, name: "" });
        B.x = e.hx; B.z = e.hz; B.left = e.huntLeft;
        if (this.bountyTeam !== e.huntTeam) { this.bountyTeam = e.huntTeam; const lead = cm.remotes.find((r) => r.team === e.huntTeam); B.name = cm.mode === "solo" ? (lead ? this.name(lead.id) : "AN ENEMY") : `${lead ? this.name(lead.id) : "AN ENEMY"}'S SQUAD`; }
      } else { E.bounty = null; this.bountyTeam = -1; }
      E.gain = now - this.cashGainAt < 1600 ? { at: this.cashGainAt, amount: this.cashGainAmt } : undefined;
    } else h.econ = null;
    h.net.ping = Math.round(cm.ping); h.net.fps = this.fps;
    h.matchTime = cm.time;
    this.survivedS = cm.time;
    void dt;
  }
}

const PP = { x: 0, z: 0 };
const QI = new THREE.Quaternion();
/** one critically damped spring step of o[k] toward 0 (velocity ov[k]), exact for any dt */
function dampAxis(o: THREE.Vector3, ov: THREE.Vector3, k: "x" | "y" | "z", w: number, dt: number) { const e = o[k], x = Math.exp(-w * dt), c = ov[k] + w * e; o[k] = (e + c * dt) * x; ov[k] = (ov[k] - w * c * dt) * x; }
/** camera azimuth relative to the kong's yaw for the victory shot (0 = straight in front: the kong faces -Z of its yaw) */
const VICTORY_FRONT = 0;
/** victory azimuth offsets tried in order (radians) when the front arc is blocked */
const VICTORY_OFFS = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.3, -2.3, Math.PI];
const PEND_N = 64;
/** loot views exist within LOOT_R of the camera; chest views are built inside CHEST_BUILD_R and drawn inside SHOW/HIDE */
// chests stay drawn to 230 m: the chest system shrinks them away by its own 200 m (was a visibility switch
// at 140 / 155 m — a crate blinking in and out at the edge of view)
const LOOT_R = 170, CHEST_BUILD_R = 250, CHEST_SHOW_R = 215, CHEST_HIDE_R = 230;
/** a loot view built nearer than this (the loot system draws to 90 m) grows in over GROW_S */
const LOOT_DRAW_R = 95, GROW_S = 0.35;
interface PendingPellet { victim: number; dmg: number; at: number; confirmed: boolean }
/** pa = predicted damage not yet confirmed, ca = confirmed damage; drawn as ONE number (grey until the first confirm) */
interface DmgWorld { at: number; last: number; x: number; y: number; z: number; pa: number; ca: number; kind: "body" | "head" | "shield" | "break" | "kill"; target: number }
const SHOT = makeShotResult();
const RHIT = makeHit(), PING_HIT = makeHit();
const SDIR = new Float64Array(3);
const KRANK = { body: 0, shield: 1, head: 2, break: 3, kill: 4 } as const;
const rankKind = (a: DmgWorld["kind"], b: DmgWorld["kind"]) => (KRANK[b] > KRANK[a] ? b : a);
type DN = HudState["damageNumbers"][number];
const DN_ROWS: DN[] = [];
function dnRow(i: number, at: number, sx: number, sy: number, amount: number, kind: DN["kind"], target: number, pred: boolean): DN {
  const r = DN_ROWS[i] ??= { at: 0, sx: 0, sy: 0, amount: 0, kind: "body" };
  r.at = at; r.sx = sx; r.sy = sy; r.amount = amount; r.kind = kind; r.target = target; r.predicted = pred;
  return r;
}
const FEEL: [number, number, number] = [0, 0, 0];
const NO_STORM = { cx: 0, cz: 0, r: 5000, tx: 0, tz: 0, tr: 5000, shrinking: false, phase: 0 };
const LISTENER = { pos: [0, 0, 0] as [number, number, number], fwd: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
const ENV = { biome: 0, indoors: false, inStorm: false, altitude: 0 };
/** the driver's saddle view: the eye in the body frame [right, up, back], its default pitch, the lean into turns */
export const FP_EYE = [0, 1.79, -0.3], FP_PITCH = -0.12, FP_LEAN = 0.075;
const FPP = new Float64Array(6), FPO = new Float64Array(3);
/** tuk-tuks show on the minimap / big map within this distance of me (m) */
const TUK_MAP_R = 600;
/** I idle / rotor, D drive / turbine, S skid, F fire, H the stuck horn / the alarm — and a helicopter's door gun: G its
 * motor (the barrels' spin), O its overheated barrels, B its fire */
type TukLoop = "I" | "D" | "S" | "F" | "H" | "G" | "O" | "B";
const TUK_LOOPS: TukLoop[] = ["I", "D", "S", "F", "H", "G", "O", "B"];
interface TukSound {
  horn: number; on: Record<TukLoop, "" | "a" | "w">; fuseAt: number; sunkAt: number; exh: number; smk: number; fire: number; dust: number; lx: number; ly: number; lz: number; seen: boolean; lastVf: number; popAt: number;
  /** the radio: the station heard last frame (−1 = not heard: no static on first sight) and the tuned one; cab = I rode it
   *  last frame (getting in with the radio on shows the station banner) */ radio: number; radioSt: number; cab?: boolean;
  /** a helicopter: somebody was at the stick last frame; its climb as drawn (m/s); its door gun was overheated */
  pilot: boolean; vy: number; gunLock: boolean;
  /** its door gun's barrels: 0 at rest, 1 winding up / at speed, 2 coasting down — and the spin's peak since the wind-up
   * began (1) or its low since the coast began (0, 2) */
  gunSt: 0 | 1 | 2; gunRef: number;
}
const D0 = 0;
/** what the tyres kick up, by terrain biome (linear rgb; none on tarmac / decks) + the white of a tyre sliding on a road */
const DUST: Array<readonly [number, number, number] | undefined> = [];
DUST[Biome.Beach] = [0.78, 0.68, 0.46]; DUST[Biome.Grass] = [0.44, 0.4, 0.27]; DUST[Biome.Jungle] = [0.33, 0.29, 0.2]; DUST[Biome.Rock] = [0.42, 0.41, 0.4];
DUST[Biome.Cinder] = [0.2, 0.18, 0.17]; DUST[Biome.Path] = [0.66, 0.54, 0.36]; DUST[Biome.Farmland] = [0.46, 0.35, 0.23];
const TYRE_SMOKE: readonly [number, number, number] = [0.86, 0.86, 0.86];
/** what a rotor whips off the water */
const SPRAY: readonly [number, number, number] = [0.8, 0.86, 0.9];
const WATER_Y = 0;
/** swimming sounds (audio/bank.ts swim:*) */
const SWIM_SFX: Record<"stroke" | "strokeFast" | "tread" | "dive" | "surface" | "gasp" | "uwStroke" | "bubbles" | "lowAir", Sfx> = {
  stroke: "swim:stroke", strokeFast: "swim:stroke-fast", tread: "swim:tread",
  dive: "swim:dive", surface: "swim:surface", gasp: "swim:gasp",
  uwStroke: "swim:uw-stroke", bubbles: "swim:bubbles", lowAir: "swim:low-air",
};
const ISLET_POI = POIS.findIndex((q) => q.id === "lobby-islet");
const TUK_PROMPT: NonNullable<HudState["interact"]> = { label: "DRIVE TUK-TUK", key: "E" }, RIDE_PROMPT: NonNullable<HudState["interact"]> = { label: "GET OUT", key: "E" };
/** tuk-tuks are drawn within this distance of the camera (m); helicopters farther (they are up in the sky) */
const TUK_DRAW_R = 520, HELI_DRAW_R = 1100;
/** third person (render.ts thirdPersonCamera), framed so the kong stands in the lower left with the crosshair clear of
 *  it: the camera's distance behind the shoulder from the hip / aiming down sights (m), how far beside the head the
 *  shoulder point sits and how far above it (m, so the view looks down over the shoulder); in freefall and under the
 *  glider, its distance behind the body and the height over the feet it orbits (m: the glider's whole canopy in view);
 *  the largest eye-to-crosshair aim correction (rad) */
const TP_DIST = 3.7, TP_ADS_DIST = 2.75, TP_SIDE = 1.15, TP_UP = 0.45;
const TP_FALL_DIST = 5.6, TP_FALL_UP = 1.1, TP_GLIDE_DIST = 7.5, TP_GLIDE_UP = 1.9, TP_AIM_MAX = 0.6;
/** blendCamera's id for the third-person camera on foot (0 is first person, 1+ the vehicle views) */
const TP_CAM_MODE = 9;
/** the states the third-person camera follows (the rest keep their own cameras) */
const tpState = (st: number) => st === PS.Ground || st === PS.Mantle || st === PS.Climb || st === PS.Zip || st === PS.Freefall || st === PS.Glide;
const AIM_HIT = makeShotResult();
/** the helicopter's chase camera: its distance at a hover (m; up to 1.5 m less flat out — nose down at speed it
 * shows far less of itself, the view widens with speed too), the point it orbits —
 * this far back from the middle (over the boom's root) and up (just over the blades) */
const HELI_CAM_DIST = 15.5, HELI_CAM_BACK = 1.2, HELI_CAM_UP = 3.4, HELI_LOW_TIP = 0.25;
const TDRAW: TukDraw = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vf: 0, vy: 0, steer: 0, hp: 1, flags: 0, st: 0 };
/** the drawn pose and the turret's angles of the helicopter being drawn (heli.ts gunAngles) */
const GP6 = new Float64Array(6), GANG = new Float64Array(4);
const GRIP: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
const UP3 = new THREE.Vector3(0, 1, 0);
/** the pilot's DOWN chip pulses until DOWN has been held this long in all (s; remembered by the browser) */
const DOWN_TAUGHT_S = 6;
let heliDownS = (() => { try { return Number(localStorage.getItem("kr.heliDownS")) || 0; } catch { return 0; } })();
/** swimming: how many times the surface / under-water control hints have shown (remembered by the browser, 3 each) */
const swimHints = (() => { try { const v = JSON.parse(localStorage.getItem("kr.swimHints") ?? "[0,0]"); return Array.isArray(v) && v.length === 2 ? v.map(Number) : [0, 0]; } catch { return [0, 0]; } })();
const saveSwimHints = () => { try { localStorage.setItem("kr.swimHints", JSON.stringify(swimHints)); } catch { /* */ } };
const wrapPi = (a: number) => { a %= Math.PI * 2; return a > Math.PI ? a - Math.PI * 2 : a <= -Math.PI ? a + Math.PI * 2 : a; };
const INTERACT_CHEST = { label: "OPEN CHEST", key: "E" };
const BOMB_COOK_LABEL = "COOKING · LET GO TO THROW";
const COVER_PROMPT: NonNullable<HudState["interact"]> = { label: "SET DOWN COCONUT CRATE WALL", key: "FIRE", act: "fire", rarity: "rare", detail: "PORTABLE COVER · STOPS BULLETS AND BLASTS · BREAKS" };
const STAND_PROMPT: NonNullable<HudState["interact"]> = { label: "SHOP AT THE BANANA STAND", key: "E", rarity: "legendary", detail: "", low: true };
const COVER_NO: NonNullable<HudState["interact"]> = { label: "NO ROOM FOR THE WALL HERE", key: "FIRE", act: "fire", blocked: "FIND FLAT, OPEN GROUND" };
const INTERACT_BOX = { label: "OPEN AMMO BOX", key: "E" };
const INTERACT_GLASS = { label: "SMASH WINDOW", key: "E" };
const INTERACT_ZIP = { label: "RIDE ZIPLINE", key: "E" }, INTERACT_UNZIP = { label: "LET GO · SPACE JUMP OFF", key: "E" };
const INTERACT_CLIMBING = { label: "LET GO · SPACE JUMP OFF", key: "E" };
function makePose(team: number): KongPose { return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, state: "idle", crouch: false, sprint: false, weapon: null, fired: false, reloading: false, hurt: false, team, friendly: false }; }
function stateOf(r: Remote): KongState {
  // swimming: under water when the feet are well below the float line (no extra snapshot bit)
  if (r.swim && r.st === PS.Ground) return r.y < SWIM_FLOAT_Y - 0.45 ? "dive" : "swim";
  switch (r.st) {
    case PS.Freefall: return "freefall"; case PS.Glide: return "glide"; case PS.Dead: return "dead"; case PS.Plane: return "plane";
    // actors: mantle pull-up, zipline ride and the crouch knee-slide have their own KongStates
    case PS.Mantle: return "mantle"; case PS.Zip: return "zip"; case PS.Ride: return r.seat === 0 ? "drive" : "ride"; case PS.Climb: return "climb";
    default: if (!r.grounded && !r.swim) return r.vy > 1 ? "jump" : "fall"; if (r.crouch && Math.hypot(r.vx, r.vz) > 5) return "slide"; return Math.hypot(r.vx, r.vz) > 0.6 ? "move" : "idle";
  }
}
function makeHudState(): HudState {
  const hotbar: HotbarSlot[] = []; for (let i = 0; i < 5; i++) hotbar.push({ kind: "empty", id: null, rarity: "common", count: 0 });
  return {
    phase: "lobby", mode: "solo", hp: 100, shield: 0, alive: 50, squadsAlive: 17, stormTimer: 0, stormShrinking: false, inStorm: false, stormPhase: 0, yaw: 0,
    me: { x: 0, z: 0, alive: true }, safe: { cx: 0, cz: 0, r: 1250 }, next: null, plane: null, dropMarker: null, squad: [], ammo: null, hotbar, activeSlot: 0, reload: null, using: null,
    killfeed: [], hitMarker: null, damageDirs: [], damageNumbers: [], interact: null, announce: null, resurgence: { on: true, countdown: null, final: false }, scoped: false, spectating: null, air: null, net: { ping: 0, fps: 0 }, matchTime: 0,
  };
}
/** closest point of the last distPointSeg call */
const SEGP: [number, number, number] = [0, 0, 0];
function distPointSeg(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  const dx = bx - ax, dy = by - ay, dz = bz - az; const l2 = dx * dx + dy * dy + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2));
  SEGP[0] = ax + dx * t; SEGP[1] = ay + dy * t; SEGP[2] = az + dz * t;
  return Math.hypot(px - SEGP[0], py - SEGP[1], pz - SEGP[2]);
}
/** visible stand-ins until the actors module ships the real plane / glider (their groups arrive empty from the stubs) */
function placeholderPlane(): THREE.Object3D {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: "#f2c531", roughness: 0.5, metalness: 0.15 }), brown = new THREE.MeshStandardMaterial({ color: "#4a2a12", roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(2.2, 20, 8, 24), yellow); body.rotation.x = Math.PI / 2; body.position.y = 3.2; g.add(body);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(34, 0.5, 5), yellow); wing.position.set(0, 4.6, -1); g.add(wing);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(12, 0.4, 3.2), yellow); tail.position.set(0, 6.8, 11); g.add(tail);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5, 4), brown); fin.position.set(0, 7.2, 11.5); g.add(fin);
  for (const sx of [-8, 8]) { const eng = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 4.5, 16), brown); eng.rotation.x = Math.PI / 2; eng.position.set(sx, 4.3, -1.5); g.add(eng); }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}
function placeholderGlider(): THREE.Object3D {
  const g = new THREE.Group();
  const peel = new THREE.Mesh(new THREE.SphereGeometry(2.9, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.32), new THREE.MeshStandardMaterial({ color: "#f5d130", roughness: 0.5, side: THREE.DoubleSide }));
  peel.scale.set(1, 0.45, 0.55); peel.position.y = 1.4; g.add(peel);
  const barMat = new THREE.MeshStandardMaterial({ color: "#c9a76a", roughness: 0.8 });
  for (const sx of [-1.2, 1.2]) { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), barMat); r.position.set(sx * 0.4, 0.8, 0); r.rotation.z = sx * 0.4; g.add(r); }
  return g;
}
/** materials / geometry every match shares (created once, prewarmed with the rest at boot — see index.ts prewarm) */
let SHARED: { rocketGeo: THREE.BufferGeometry; rocketMat: THREE.Material; streakGeo: THREE.BufferGeometry; streakMat: THREE.Material; streakU: { uCam: { value: THREE.Vector3 }; uVel: { value: THREE.Vector3 }; uAmt: { value: number }; uTime: { value: number } } } | null = null;
function shared() {
  if (SHARED) return SHARED;
  const streakU = { uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3(0, -1, 0) }, uAmt: { value: 0 }, uTime: { value: 0 } };
  const st = buildStreaks(260, streakU);
  SHARED = { rocketGeo: new THREE.CapsuleGeometry(0.09, 0.4, 4, 8), rocketMat: new THREE.MeshStandardMaterial({ color: "#f5c531", emissive: "#ffb000", emissiveIntensity: 2.4, roughness: 0.4 }), streakGeo: st.geometry, streakMat: st.material as THREE.Material, streakU };
  return SHARED;
}
/** meshes using the per-match materials, for the boot prewarm pass. The effects the GameRender constructor makes every
 *  match (interact highlight, map markers, updraft, tuk debris, banana rounds, ammo boxes, glass shards, the cover
 *  ghost, the bomb arc and pin) get one session-long copy each here, never disposed: their programs stay linked, so a
 *  match's first frames link none of them (RAY-16) */
export function renderPrefabs(): THREE.Object3D[] {
  const s = shared();
  const r = new THREE.Mesh(s.rocketGeo, s.rocketMat); r.castShadow = true;
  const w = new THREE.Mesh(s.streakGeo, s.streakMat); w.frustumCulled = false;
  const fx = new THREE.Group() as unknown as THREE.Scene;
  const effects = [new InteractHighlight(fx).group, new MarkerBeams(fx, () => 0, resources.root).group, new UpdraftFx(fx).group, new TukFx(fx, () => 0).object, new BananaRounds(fx, resources.root).mesh, new AmmoBoxes(resources.root).group, glassShardPrefab(), coverGhostPrefab(), ...bombPrefabs()];
  // (the highlight draws its hull / rim meshes empty until it has a target, then with the target's geometry, and a
  // program's key reads which attributes the geometry has: a second copy carries a small real mesh)
  const hl = new InteractHighlight(fx).group, geo = new THREE.PlaneGeometry(0.01, 0.01);
  hl.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !m.geometry.getAttribute("position")) m.geometry = geo; });
  effects.push(hl);
  // (a tuk-tuk, fresh and burnt out: its lamps, lightbox and glass compile here, not when the first one drives into view)
  // (the Banana Stand kiosk — its shopkeeper's fur, the thatch, the leaves and the sign compile here too)
  return [r, w, ...tukPrefabs(), ...heliPrefabs(), bananaStand().root, ...effects];
}
/** wind streaks: n thin quads, positions/extrusion entirely in the vertex shader (zero CPU per frame) */
function buildStreaks(n: number, u: Record<string, THREE.IUniform>): THREE.Mesh {
  const seed = new Float32Array(n * 4 * 4), corner = new Float32Array(n * 4 * 2), idx: number[] = [];
  let r = 7331; const rnd = () => ((r = (Math.imul(r, 1664525) + 1013904223) | 0), ((r >>> 8) & 0xffff) / 65536);
  for (let i = 0; i < n; i++) {
    const s4 = [rnd(), rnd(), rnd(), rnd()];
    for (let v = 0; v < 4; v++) { seed.set(s4, (i * 4 + v) * 4); corner[(i * 4 + v) * 2] = v & 1 ? 1 : -1; corner[(i * 4 + v) * 2 + 1] = v >> 1; }
    const b = i * 4; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
  g.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
  g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed; attribute vec2 aCorner; uniform vec3 uCam, uVel; uniform float uTime, uAmt; varying float vA;
      void main() {
        float sp = max(length(uVel), 1.0); vec3 dir = uVel / sp;
        vec3 cell = (aSeed.xyz - 0.5) * 70.0;
        vec3 off = mod(cell - uVel * uTime + 35.0, 70.0) - 35.0;
        float d = length(off);
        vec3 wp = uCam + off;
        float len = sp * (0.035 + 0.05 * aSeed.w);
        vec3 p = wp - dir * len * aCorner.y;
        vec3 view = normalize(wp - uCam + 1e-4);
        vec3 side = normalize(cross(dir, view) + 1e-5) * (0.018 + 0.012 * aSeed.w) * clamp(d * 0.12, 0.4, 3.0);
        p += side * aCorner.x;
        vA = uAmt * (1.0 - aCorner.y) * smoothstep(2.5, 7.0, d) * (1.0 - smoothstep(24.0, 35.0, d)) * (0.35 + 0.65 * aSeed.w);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `varying float vA; void main() { gl_FragColor = vec4(vec3(0.92, 0.95, 1.0) * vA * 0.55, vA * 0.55); }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 5; mesh.visible = false; mesh.name = "wind-streaks";
  return mesh;
}
export type { Player };

// ---- interact highlight targets
const enum HL { None = 0, Chest = 1, Box = 2, Item = 3, Tuk = 4, Glass = 5, Zip = 6 }
const HL_KEYS = ["", "c", "b", "i", "t", "g", "z"];
/** how far (m) the outline sits behind its object: hides the outlines of parts lying on the object (bigger things, more) */
const HL_PUSH = [0, 0.14, 0.1, 0.05, 0.16, 0.06, 0.1];
const HM = new THREE.Matrix4();
let boxHullG: THREE.BufferGeometry | null = null;
const zipHulls = new Map<number, THREE.BufferGeometry>();
/** the ammo box's silhouette (client/src/game/ammobox.ts: 0.76 × 0.36 + lid × 0.44, standing on its origin) */
const boxHull = () => (boxHullG ??= new THREE.BoxGeometry(0.78, 0.44, 0.46).translate(0, 0.22, 0));
/** a zipline pole + its hanging T-bar (canopy-line/structures.ts addZip), world space; k = line * 2 + end (zipNear) */
function zipHull(k: number): THREE.BufferGeometry {
  let g = zipHulls.get(k); if (g) return g;
  const L = ZIP_LINES[k >> 1], e = k & 1;
  const px = e ? L.bx : L.ax, py = e ? L.by : L.ay, pz = e ? L.bz : L.az, deck = e ? L.yb : L.ya;
  const qx = e ? L.ax : L.bx, qz = e ? L.az : L.bz, l = Math.hypot(qx - px, qz - pz), ux = (qx - px) / l, uz = (qz - pz) / l;
  const pole = new THREE.CylinderGeometry(0.17, 0.17, py + 0.35 - (deck - 0.4), 10).translate(px, (py + 0.35 + deck - 0.4) / 2, pz);
  const hx = px + ux * 0.6, hz = pz + uz * 0.6, hy = py - 0.05 - 4 * L.sag * (0.6 / L.Lh);
  const rod = new THREE.CylinderGeometry(0.03, 0.03, 1.0, 6).translate(hx, hy - 0.5, hz);
  const bar = new THREE.CylinderGeometry(0.05, 0.05, 0.62, 8).rotateZ(Math.PI / 2).rotateY(Math.atan2(-uz, ux) + Math.PI / 2).translate(hx, hy - 1.02, hz);
  g = mergeGeometries([pole.toNonIndexed(), rod.toNonIndexed(), bar.toNonIndexed()])!; zipHulls.set(k, g);
  return g;
}

// ---- marker beams
const UI_YELLOW = "#ffd400";
const MARK_POOL: MarkerSpec[] = Array.from({ length: 4 }, () => ({ x: 0, z: 0, color: "", key: "" }));
const markSpec = (i: number, x: number, z: number, color: string, key: string) => { const m = MARK_POOL[i]; m.x = x; m.z = z; m.color = color; m.key = key; return m; };

/** the kind of place each POI is: its first arrival plays that kind's faint phrase (ui/poi-<theme>) */
const POI_THEME: Record<string, PoiTheme> = {
  "coconut-cove": "coast", "stilt-town": "coast", "lookout-point": "coast", "wreck-bay": "coast", "peel-harbor": "harbor", "the-wreck": "harbor",
  "canopy-line": "jungle", "banana-temple": "temple", "ripe-peak": "volcano", "mango-market": "town", "the-plantation": "town",
  "the-murk": "swamp", "cnvs-lab": "lab", "peel-strip": "lab", "coco-caves": "caves", "mist-falls": "caves",
};
/** the location banner's sub-line per POI */
const POI_TAGLINE: Record<string, string> = {
  "peel-harbor": "Banana Co. docks", "mango-market": "Market square", "coconut-cove": "Beach resort", "stilt-town": "Village on stilts",
  "the-murk": "Mangrove swamp", "banana-temple": "Ancient ruins", "ripe-peak": "The volcano", "mist-falls": "Waterfall gorge",
  "cnvs-lab": "Research lab", "canopy-line": "Treetop ziplines", "peel-strip": "Airstrip", "the-plantation": "Banana farm",
  "lookout-point": "Lighthouse cliffs", "the-wreck": "Banana Co. freighter", "coco-caves": "Sea caves", "wreck-bay": "Shipwreck cove",
};
