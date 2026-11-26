// AUDIO CONTRACT. Gameplay calls these; the engine in ./index.ts voices them.
import type { Surface } from "../../../shared/world/colliders";
import type { WeaponId } from "../../../shared/world/map";

export type Sfx =
  | `fire:${WeaponId}` | `reload:${WeaponId}` | `equip` | `dryfire`
  | `hit:body` | `hit:head` | `hit:shield` | `hitmarker` | `kill` | `elim:self`
  | `step:${Surface}` | `step:dirt` | `step:mud` | `land` | `jump` | `slide`
  | `chest:open` | `chest:hum` | `pickup:weapon` | `pickup:ammo` | `pickup:heal` | `heal:use` | `shield:use` | `shield:break`
  | `plane:drone` | `jump:exit` | `freefall:wind` | `glider:open` | `glider:wind`
  | `storm:loop` | `storm:shrink` | `storm:damage`
  | `explosion` | `ui:click` | `ui:countdown` | `ui:victory` | `ui:resurgence` | `whizz`
  // arriving at a named place (the location banner) — a soft mallet arpeggio, ui/poi (currently unused)
  | `ui:poi`
  // the FIRST arrival at a named place in a match — that kind of place's own faint phrase (ui/poi-<theme>)
  | `ui:poi:${PoiTheme}`
  // a special kill's medal pops (ROADKILL, HEADSHOT, DOUBLE KILL … client/src/ui/medals.ts); -big: the
  // vehicle medals and the multi-kills
  | `ui:medal` | `ui:medal-big`
  // the server says a hit we predicted (its tick already played) landed on a SHIELD — the shield's glassy
  // crackle alone, no second tick
  | `hit:shield:confirm`
  // additions (backward compatible): bullet hits on the world, and the countdown's final "GO"
  | `impact:${Surface}` | `ui:countdown-go` | `plane:ramp`
  // YOU took damage (low body thud, no confirm tick — `hit:*` is for hits YOU deal)
  | `hurt`
  // the zipline (shared/sim/zipline.ts) — attach clack, the trolley LOOP (loopId; `rate` = ride
  // speed / 16 m/s, call again with the same loopId to update it; stopLoop to end) and the release at the far pole
  | `zip:attach` | `zip:ride` | `zip:detach`
  // glass: a window pane shatters (layered from the real glass impact + glass debris recordings)
  | `glass:break`
  // TUK-TUK (shared/sim/vehicle.ts). LOOPS (loopId per vehicle; call again with the same loopId to update pos / volume /
  // rate; no `pos` = you are aboard): `tuk:idle` = the two-stroke putter at rest, `tuk:drive` = the engine under load
  // (`rate` = revs, 0.6 crawl … 1.6 flat out), `tuk:skid` = tyre squeal (volume = slip), `tuk:fire` = the burning
  // engine / wreck, `tuk:fuse` = the stuck horn + sputter of a tuk-tuk about to blow. ONE-SHOTS: the horn, engine
  // start / stop (enter / exit), a body crunch (volume = how hard), the tip-over crash, the flip back onto its wheels
  // (creak + thump), an exhaust backfire pop, a hard landing off a jump
  | `tuk:idle` | `tuk:drive` | `tuk:skid` | `tuk:fire` | `tuk:fuse`
  | `tuk:horn` | `tuk:start` | `tuk:stop` | `tuk:crash` | `tuk:tip` | `tuk:flip` | `tuk:backfire` | `tuk:land`
  // WATER — a body going into deep water (`volume` = how hard), a swim stroke (the foot plants
  // while swimming), climbing out (slosh + drips)
  | `water:splash` | `water:stroke` | `water:out`
  // SWIMMING (levels, timings and buses in bank.ts). ON THE SURFACE (`pos` =
  // someone else, readable ~35-40 m): one arm pull (`swim:stroke`, its splash peaks 0.10-0.15 s in: fire at the hand
  // entry, ~0.85 s apart), a sprint-crawl pull (`swim:stroke-fast`, ~0.6 s apart), idle treading (`swim:tread`, every
  // ~1.1 s). TRANSITIONS: duck-diving under (`swim:dive`: breath in, head under at 0.30 s, bubbles), breaking the surface
  // from below (`swim:surface`), a desperate gasp (`swim:gasp`: fire it with swim:surface when surfacing low on air, it
  // lands 0.45 s later). UNDER WATER, yours only (no pos): a stroke (`swim:uw-stroke`), an exhale bubble burst
  // (`swim:bubbles`), ONE heartbeat per call while breath < 30 % (`swim:low-air`, every ~0.9 s)
  | `swim:stroke` | `swim:stroke-fast` | `swim:tread` | `swim:dive` | `swim:surface` | `swim:gasp`
  | `swim:uw-stroke` | `swim:bubbles` | `swim:low-air`
  // the VOLCANO UPDRAFT — the vent's roar (a positioned loop: loopId, pos on the column) and the
  // rush of wind while it carries you (a loop on you: volume / rate = how hard it lifts)
  | `updraft:roar` | `updraft:rush`
  // LADDERS / TREE CLIMBS — grabbing on, a rung under hand / foot
  | `climb:grab` | `climb:rung`
  // HELICOPTER (shared/sim/heli.ts). LOOPS (loopId per helicopter): `heli:rotor` = the blades' chop (`rate` = the
  // spool, 0.6 winding up … 1.05 flat out; volume with it), `heli:turbine` = the engine's whine under it, `heli:alarm` =
  // the cockpit warning of one on fire. ONE-SHOTS: the engine starting up (the pilot climbs in), winding down (the
  // pilot leaves). Crashes, hard landings and the fire share the tuk-tuk's.
  | `heli:rotor` | `heli:turbine` | `heli:alarm` | `heli:start` | `heli:stop`
  // the rotor cutting a kong down (one-shot at the kong)
  | `heli:chop`
  // TOP BANANA, the helicopter's door minigun (shared/sim/heli.ts HELI.GUN_*; a real M134 recording).
  // LOOPS (loopId per helicopter; no `pos` = you are aboard): `gun:fire` = the minigun firing, run while rounds keep leaving
  // (not one call per round), `gun:spin` = the barrels spinning empty (`volume` / `rate` ride the spin), `gun:hot` = the
  // overheated barrels sizzling while it is locked. ONE-SHOTS: `gun:stop` = the burst's last rounds + tail when the fire
  // loop ends, `gun:spinup` / `gun:spindown` = the motor winding the barrels up / the barrels coasting to a stop,
  // `gun:lock` = the quench hiss the moment it overheats, `gun:dry` = the empty belt's clack
  | `gun:fire` | `gun:spin` | `gun:hot` | `gun:stop` | `gun:spinup` | `gun:spindown` | `gun:lock` | `gun:dry`
  // VINE GRAPPLE & BANANA AIRSTRIKE cues
  | `grapple:shoot` | `airstrike:warn`;

/** the kinds of place with their own arrival phrase */
export type PoiTheme = "coast" | "harbor" | "jungle" | "temple" | "volcano" | "town" | "swamp" | "lab" | "caves";

export interface PlayOpts {
  pos?: [number, number, number]; volume?: number; rate?: number; loopId?: string;
  /** (optional): how long the action lasts, s — `heal:use` / `shield:use` play a use loop for exactly `dur` and a
   * completion cue landing at `dur`; cancel early with stopLoop(loopId) (default loopId "use" for your own) */
  dur?: number;
  /** (optional): what is being used / picked up — consumable id for heal/shield use ("leaf-bundle"…), rarity index
   * 0..4 for pickups (adds a rarity sweetener) */
  item?: string; tier?: number;
}

/** (optional): the storm's safe circle (world x/z centre, radius m) — the audio places the storm wall at the point
 * of the circle nearest you (audible from the safe side, ~200 m out) and crossfades to the inside roar as you cross */
export interface StormCircle { x: number; z: number; r: number }

export interface GameAudio {
  /** must be called from a user gesture before sound can play */
  unlock(): Promise<void>;
  play(s: Sfx, o?: PlayOpts): void;
  stopLoop(loopId: string): void;
  /** listener = camera each frame; `surface` under the player and `indoors` drive ambience beds */
  update(dt: number, listener: { pos: [number, number, number]; fwd: [number, number, number]; up: [number, number, number] }, env: { biome: number; indoors: boolean; inStorm: boolean; altitude: number; storm?: StormCircle | null }): void;
  setMaster(v: number): void;
  /** SETTINGS → AUDIO → DYNAMIC RANGE ("full" = the authored mix) */
  setDynamicRange?(profile: "full" | "reduced"): void;
  /** SETTINGS → AUDIO category levels, 0..1 (1 = the authored mix); they multiply the mixer's bus trims */
  setMix?(levels: { combat: number; ui: number; ambience: number }): void;
  /** the match is over (back to the title / the lobby room): every game sound — loops, beds, the storm, the plane, the
   *  surf, one-shots in flight — fades out now; UI sounds keep playing. The next update() starts the world again. */
  endSession?(): void;
  /** the tuk-tuk radio (audio/radio.ts) — null offline / in renders */
  readonly radio?: import("./radio").Radio | null;
}
