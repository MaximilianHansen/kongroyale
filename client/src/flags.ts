// The URL flag registry: every ?name=value the client reads is declared in FLAGS with its kind (how the value parses, and
// its default) and its owner, and the doc comment above the entry says what the flag does. tools/flags/test.mts fails on a
// flag without one. The purposes are comments, not strings, so they stay out of the bundles: this file is in the entry,
// the boot chunk and five worker builds. Read a flag with flag("name"); a raw location.search read fails lint (url-flags).
import { EVENT_PARAM } from "../../shared/net/event";

type Kind<T> = { readonly type: string; readonly default: T; readonly parse: (value: string) => T };

const on: Kind<boolean> = { type: "on unless =0", default: true, parse: (v) => v !== "0" };
const present: Kind<boolean> = { type: "on when present", default: false, parse: () => true };
const one: Kind<boolean> = { type: "on when =1", default: false, parse: (v) => v === "1" };
const num = (d: number): Kind<number> => ({ type: "number", default: d, parse: Number });
const text: Kind<string | null> = { type: "string", default: null, parse: (v) => v };
const list: Kind<readonly string[]> = { type: "comma list", default: [], parse: (v) => v.split(",").filter(Boolean) };
const maybeNum: Kind<number | null> = { type: "number or absent", default: null, parse: Number };
const finite = (d: number): Kind<number> => ({ type: "finite number", default: d, parse: (v) => (Number.isFinite(Number(v)) ? Number(v) : d) });
const subset: Kind<readonly string[] | undefined> = { type: "comma list, absent = all", default: undefined, parse: (v) => v.split(",").filter(Boolean) };
const numbers: Kind<readonly number[] | undefined> = { type: "comma numbers", default: undefined, parse: (v) => v.split(",").map(Number) };

type Owner = "actors" | "atmos" | "audio" | "boot" | "caster" | "engine" | "game" | "pois" | "terrain" | "ui" | "veg" | "voice" | "water" | "weapons";
type Flag = { readonly kind: Kind<unknown>; readonly owner: Owner; readonly routing?: true };

const FLAGS = {
  /** show the display-preset toasts to automated browsers too */
  announce: { kind: present, owner: "boot" },
  /** first-person arms: =2 the v2 arms, =1 the current ones; absent = localStorage kr.arms */
  arms: { kind: text, owner: "weapons" },
  /** keep every hand mesh so a bench can swap v1 and v2 arms live */
  armsab: { kind: present, owner: "weapons" },
  /** atmosphere debug switches: noao, nogr, nobloom, nosmaa, nosharpen, noshadow, noclouds, nopost, nofog, nocloudshadow, cloudmarch */
  atmos: { kind: list, owner: "atmos" },
  /** override preset fields as key:value,key:value (hex colours as c0ffee) */
  atmosp: { kind: text, owner: "atmos" },
  /** free the decoded sound of on-demand groups when a match ends (memory) */
  audioevict: { kind: one, owner: "audio" },
  /** open the auxiliary socket next to the match socket */
  aux: { kind: on, owner: "game" },
  /** per-plant tint variation on banana leaves */
  bananatint: { kind: on, owner: "veg" },
  /** ad-hoc camera x,y,z,tx,ty,tz[,fov] instead of the game */
  cam: { kind: text, owner: "boot" },
  /** Canopy Line perf probe: hide crowns, det, main or cast */
  canopyOff: { kind: list, owner: "pois" },
  /** open as a caster seat on this lobby code */
  cast: { kind: text, owner: "caster", routing: true },
  /** open as a caster seat (=exhibit starts an exhibition) */
  caster: { kind: text, owner: "caster", routing: true },
  /** Coco Caves remaining sky ambient deep inside */
  cavesAmb: { kind: finite(0.36), owner: "pois" },
  /** Coco Caves ablation: hide parts whose names contain these */
  cavesHide: { kind: list, owner: "pois" },
  /** Coco Caves lamp irradiance gain */
  cavesLamp: { kind: finite(0.7), owner: "pois" },
  /** Coco Caves sky visibility at which the outside look is fully back */
  cavesSky: { kind: finite(0.32), owner: "pois" },
  /** log the coplanar-face fixes the town and coast kits make */
  codebug: { kind: present, owner: "pois" },
  /** resolve the town kit's coplanar faces in a Web Worker; =0 resolves them on the main thread, time-sliced */
  coworker: { kind: on, owner: "pois" },
  /** Peel Harbor cranes swap to their proxy at 150 m (the old behaviour) */
  craneproxy: { kind: present, owner: "pois" },
  /** Peel Harbor container LOD distance (m) */
  ctLod: { kind: num(18), owner: "pois" },
  /** Peel Harbor container mid LOD distance (m); 0 = none */
  ctMid: { kind: num(0), owner: "pois" },
  /** detail cull distances scale with the camera's field of view */
  cullfov: { kind: on, owner: "engine" },
  /** compile match-only kong and chest programs after ready */
  deferkong: { kind: one, owner: "game" },
  /** show boot errors on screen */
  debug: { kind: present, owner: "boot" },
  /** diagnostics recorder; =0 off, absent = VITE_KR_DIAG */
  diag: { kind: text, owner: "ui" },
  /** dev tools after ready, and the full title (=annotate opens the world annotator) */
  dev: { kind: text, owner: "boot" },
  /** LOD fades dither; =0 scales instead (always off under Node) */
  dither: { kind: on, owner: "engine" },
  /** __kr.drawCensus: per-draw main-thread cost by pass and class */
  drawcensus: { kind: present, owner: "engine" },
  /** device pixel ratio instead of the screen's (capped at 2); 0 = the screen's */
  dpr: { kind: num(0), owner: "engine" },
  /** Mist Falls materials render double-sided */
  dside: { kind: present, owner: "pois" },
  /** dynamic resolution: =1 on, =0 forced off, absent = the setting */
  dynres: { kind: text, owner: "engine" },
  /** event lobby code from an admin's player link */
  [EVENT_PARAM]: { kind: text, owner: "game", routing: true },
  /** elevation-aware LOD distances in the POIs; =0 = the old switches */
  elevlod: { kind: on, owner: "pois" },
  /** free-fly camera on top of a view */
  fly: { kind: present, owner: "boot" },
  /** tucked first-person arms and item hold; =0 = the older outstretched arms */
  fp3: { kind: on, owner: "weapons" },
  /** full scene-graph camera updates instead of the camera-only walk */
  fullcam: { kind: present, owner: "engine" },
  /** weapon stages play effects live instead of frozen */
  fxlive: { kind: present, owner: "weapons" },
  /** time (s) the fx stage freezes at; default 0.2 */
  fxt: { kind: text, owner: "weapons" },
  /** drop the CPU vertex arrays of static meshes once they are on the GPU and rebuild them on a context restore; =0 keeps them, and ?dev=annotate keeps them unless =1 */
  geofree: { kind: on, owner: "engine" },
  /** copies of one asset share their identical vertex arrays (crates per rarity, the two planes); =0 keeps a copy each */
  geoshare: { kind: on, owner: "engine" },
  /** renderer string to classify instead of the real GPU's */
  gpu: { kind: text, owner: "engine" },
  /** run the display frame-rate guard in automated browsers too */
  guard: { kind: present, owner: "boot" },
  /** chest stage hero gun position x,y,z */
  gunat: { kind: text, owner: "weapons" },
  /** chest stage hero gun weapon id; default rocket */
  gunid: { kind: text, owner: "weapons" },
  /** chest stage hero gun scale,pitch,roll */
  gunpose: { kind: text, owner: "weapons" },
  /** chest stage hero gun muzzle side: =1 up-right, else down-left; absent = up-right */
  gunrev: { kind: text, owner: "weapons" },
  /** hysteresis on Peel Harbor LOD switches */
  harborhyst: { kind: on, owner: "pois" },
  /** turn off Peel Harbor's LOD culling */
  harborNoCull: { kind: present, owner: "pois" },
  /** =1 runs an offline practice match's host in a Web Worker instead of on the main thread */
  hostworker: { kind: one, owner: "game" },
  /** build only these Peel Harbor parts (plus the apron) */
  harborOnly: { kind: subset, owner: "pois" },
  /** audition page without its buttons (scripted runs) */
  headless: { kind: present, owner: "audio" },
  /** modules that take longer than this (ms) build behind the match card */
  heavyms: { kind: num(Infinity), owner: "boot" },
  /** =1 loads the helicopter model at its first use in a match, =0 when the title is ready (the prefab warm-up); absent = first use on Safari and on devices reporting under 8 GB, else when the title is ready */
  helilazy: { kind: text, owner: "actors" },
  /** dev builds: ICE server URLs for voice, comma list */
  ice: { kind: text, owner: "voice" },
  /** dev check: every frame, each POI in view must draw its model, impostor or HLOD; gaps go to __kr.errors */
  invariants: { kind: present, owner: "engine" },
  /** impostors crossfade between their baked views */
  impblend: { kind: on, owner: "veg" },
  /** cull impostor cells outside the view; =0 draws every impostor every frame */
  impcull: { kind: on, owner: "veg" },
  /** four numbers that replace the impostor colour grade uImpGrade */
  impgrade: { kind: numbers, owner: "veg" },
  /** impostor quads cast the island-wide canopy shadows into the static far map */
  impshadow: { kind: on, owner: "veg" },
  /** four numbers that replace the impostor shade/sun split uImpSplit */
  impsplit: { kind: numbers, owner: "veg" },
  /** Mist Falls water without its rocks */
  jdbgNoRocks: { kind: present, owner: "pois" },
  /** join this private lobby code */
  join: { kind: text, owner: "game", routing: true },
  /** check the baked jungle layout still matches the terrain */
  jungleCheck: { kind: present, owner: "pois" },
  /** jungle POIs plant no vegetation */
  jungleNoVeg: { kind: present, owner: "pois" },
  /** kong asset: v1, v2 or alt; absent = v2 */
  kong: { kind: text, owner: "actors" },
  /** near-tier kong normal, clothing and sneaker maps load at 1024², 2048² for your victory shot and view pages; =0 keeps 2048² */
  konghalf: { kind: on, owner: "actors" },
  /** kong shadow proxy shrink (cm); 0 = no kong shadows */
  kongproxy: { kind: maybeNum, owner: "actors" },
  /** force every kong into LOD tier 0, 1 or 2 */
  kongtier: { kind: text, owner: "actors" },
  /** the procedural kong instead of the asset */
  kongv: { kind: one, owner: "actors" },
  /** =1 loads POI textures from .ktx2 copies, =etc1s with ETC1S normal maps */
  ktx2: { kind: text, owner: "engine" },
  /** v2 kong ripe-yellow chroma */
  kysat: { kind: num(1.12), owner: "actors" },
  /** v2 kong ripe-yellow value */
  kyval: { kind: num(0.97), owner: "actors" },
  /** CNVS Lab perf A/B: hide shell, near, interior, glass, rocks, vines, falls, gravel, rooms */
  labhide: { kind: list, owner: "pois" },
  /** the anti-pop LOD path: terrain geomorph, rock and HLOD crossfades, view-dependent detail culling */
  lodv: { kind: on, owner: "engine" },
  /** bake the floor-loot far LODs after the title is ready, before the prefab warm-up a match waits for, instead of during boot; =0 bakes them during boot */
  lootlater: { kind: on, owner: "weapons" },
  /** build POIs only near the player: =1 on, =0 off, absent = auto */
  lowmem: { kind: text, owner: "boot" },
  /** lowmem build distance (m, horizontal; in the warm-up and on the plane it counts height above the pad too, and on the plane up to lowmemview POIs in view build as well, ahead of nearby ones out of view) */
  lowmemr: { kind: num(450), owner: "boot" },
  /** lowmem: at most this many far POIs build because they are in view during the plane; the rest stay terrain until landing */
  lowmemview: { kind: num(2), owner: "boot" },
  /** lowmem: at most this many streamed POIs stay built; past it the farthest is evicted, never the nearest or the one the player is in */
  lowmemcap: { kind: num(3), owner: "boot" },
  /** lowmem: estimated MB (vertex arrays + textures) the streamed POIs may hold; past it the farthest is evicted like lowmemcap */
  lowmembudget: { kind: num(1500), owner: "boot" },
  /** lowmem: draw a baked far impostor (public/assets/far) for every streamed POI that is not built */
  farimp: { kind: on, owner: "boot" },
  /** lowmem: at the cap or budget, a pending POI builds only if it is this much nearer (m) than the POI it would evict */
  lowmemhyst: { kind: num(100), owner: "boot" },
  /** caster camera starts in manual instead of autopilot */
  manual: { kind: present, owner: "caster" },
  /** open the full-screen map (view-camera captures) */
  map: { kind: one, owner: "ui" },
  /** mode of the lobby a caster creates: trios, else solo */
  mode: { kind: text, owner: "caster", routing: true },
  /** build only these modules (ids or prefixes) */
  modules: { kind: subset, owner: "boot" },
  /** The Murk water debug mode */
  murkdbg: { kind: num(0), owner: "pois" },
  /** The Murk water without its scene grab */
  murknoscene: { kind: present, owner: "pois" },
  /** The Murk: skip building decks, huts or int */
  murkoff: { kind: list, owner: "pois" },
  /** never show the display-preset toasts */
  noannounce: { kind: present, owner: "boot" },
  /** streamed POIs draw before their build gate releases */
  nobuildgate: { kind: present, owner: "boot" },
  /** chest stress stage without chests */
  nochests: { kind: present, owner: "weapons" },
  /** turn off detail, POI and harbor culling: draw everything at full detail */
  nocull: { kind: present, owner: "engine" },
  /** turn off the static matrix cache */
  nofreeze: { kind: present, owner: "engine" },
  /** turn off the far HLOD merge */
  nohlod: { kind: present, owner: "engine" },
  /** chest studio without the chest's own light */
  nolight: { kind: present, owner: "weapons" },
  /** chest stress stage without loot */
  noloot: { kind: present, owner: "weapons" },
  /** compute loot spots on the main thread instead of a worker */
  nolootworker: { kind: present, owner: "engine" },
  /** turn off POI occlusion culling */
  noocc: { kind: present, owner: "engine" },
  /** chest stage chests stay closed */
  noopen: { kind: present, owner: "weapons" },
  /** build every module before the title instead of streaming */
  nostream: { kind: present, owner: "boot" },
  /** chest stage without the stress field */
  nostress: { kind: present, owner: "weapons" },
  /** act as a browser without GPU timer queries */
  notimer: { kind: present, owner: "engine" },
  /** warm draws skip the roots' shadow-depth programs */
  nowarmshadow: { kind: present, owner: "engine" },
  /** culled detail switches off at once instead of fading out */
  offinstant: { kind: on, owner: "engine" },
  /** kong outfit dev view (=N picks the count; empty = 1) */
  outfits: { kind: text, owner: "actors" },
  /** paint coast textures at load instead of loading the baked ones */
  painttex: { kind: present, owner: "pois" },
  /** perf HUD + metrics timeline */
  perfhud: { kind: present, owner: "ui" },
  /** =1 sizes the post chain's screen-sized targets (TAA history, velocity, viewmodel, scene buffers) from the quality tier's pixel cap instead of the canvas, and stretches the result to the canvas in the final blit */
  pixcap: { kind: one, owner: "atmos" },
  /** the plane's painted canvases and their GPU copies are freed after the drop and repainted when the match ends; =0 keeps them */
  planefree: { kind: on, owner: "actors" },
  /** longest edge (px) of POI texture files and harbor-kit paint, downscaled before upload; absent = 1024, 512 on low-memory devices; 0 = no cap */
  poicap: { kind: maybeNum, owner: "engine" },
  /** playtest title with one Play button: present or =1 on, =0 off */
  playtest: { kind: text, owner: "ui" },
  /** =full builds everything behind the match card instead of streaming */
  prepare: { kind: text, owner: "boot" },
  /** =full prewarms every prefab before ready instead of after */
  prewarm: { kind: text, owner: "game" },
  /** this caster window is the program output (OBS feed) */
  program: { kind: present, owner: "caster", routing: true },
  /** build quality ultra, high, medium or low instead of the video preset's */
  q: { kind: text, owner: "boot" },
  /** target time (ms) for the title to be ready; the stream planner works back from it */
  readyby: { kind: num(25000), owner: "boot" },
  /** pre-ready planner uses the measured post-build estimate (stored per device) and never plans past readyby; =0 plans with the fixed estimate */
  readyest: { kind: on, owner: "boot" },
  /** Mist Falls merges its near rock sets into meshes; =0 = the old instanced sets */
  rockMerge: { kind: on, owner: "pois" },
  /** draw the terrain rocks */
  rocks: { kind: on, owner: "terrain" },
  /** __kr.resAudit(): what the renderer holds outside a scope */
  resaudit: { kind: present, owner: "engine" },
  /** half-rate guard: =1 on, =0 off; absent = on unless automated */
  resguard: { kind: text, owner: "engine" },
  /** pin the 3D resolution scale; 0 = not pinned */
  scale: { kind: num(0), owner: "engine" },
  /** town statue sculpts live instead of loading its baked mesh */
  sculpt: { kind: present, owner: "pois" },
  /** practice match seed (plane line, storm, loot); 0 = random */
  seed: { kind: num(0), owner: "game" },
  /** keep three's shader error checks on */
  shadercheck: { kind: present, owner: "game" },
  /** log build slices over N ms to __kr.sliceLog; 0 = off */
  slicelog: { kind: num(50), owner: "engine" },
  /** capture mode: frozen time, pixel ratio 1, HUD hidden */
  shot: { kind: present, owner: "boot" },
  /** read splat captures back from the GPU asynchronously */
  splasync: { kind: one, owner: "veg" },
  /** keep baked splats in the browser cache; =0 bakes on every load */
  splcache: { kind: on, owner: "veg" },
  /** splat opacity cut-off gain */
  splcut: { kind: num(1), owner: "veg" },
  /** splat shader switches: noatm, nofog, nofar */
  spldbg: { kind: list, owner: "veg" },
  /** splat density that picks a level from a plant's projected radius */
  spldens: { kind: num(0.3), owner: "veg" },
  /** near-splat hue shift */
  splhue: { kind: num(-0.12), owner: "veg" },
  /** bake splats from the crown hull capture (always on under Node) */
  splhull: { kind: one, owner: "veg" },
  /** splat keep fraction */
  splkeep: { kind: num(0.35), owner: "veg" },
  /** levels with at least this many splats are captured from LOD1 */
  splnear: { kind: num(1024), owner: "veg" },
  /** splat ambient occlusion gain */
  splocc: { kind: num(1), owner: "veg" },
  /** splat ambient occlusion gain far away */
  splocfar: { kind: num(0.5), owner: "veg" },
  /** splat opacity gain */
  splop: { kind: num(1.35), owner: "veg" },
  /** splat capture resolution (px) */
  splres: { kind: num(256), owner: "veg" },
  /** near-splat saturation */
  splsat: { kind: num(1.1), owner: "veg" },
  /** splat shadow gain */
  splshadow: { kind: num(1), owner: "veg" },
  /** splat shadow gain far away */
  splshfar: { kind: num(0.6), owner: "veg" },
  /** splat shadow offset */
  splshoff: { kind: num(1), owner: "veg" },
  /** splat capture spread */
  splspread: { kind: num(1.25), owner: "veg" },
  /** splat size gain */
  splsz: { kind: num(1), owner: "veg" },
  /** splat capture thickness */
  splthick: { kind: num(0.22), owner: "veg" },
  /** lava steam vents in the badlands */
  steam: { kind: on, owner: "terrain" },
  /** storm volume debug mode */
  stormdebug: { kind: finite(0), owner: "game" },
  /** hide these storm parts (comma list) */
  stormhide: { kind: text, owner: "game" },
  /** grace (ms) after ready before streaming resumes, for a quick Play click */
  streamgrace: { kind: num(2500), owner: "boot" },
  /** stream budget per frame in ms: title,warm,match */
  streamslice: { kind: numbers, owner: "engine" },
  /** weapon studio light overrides as key:value,key:value */
  studio: { kind: text, owner: "weapons" },
  /** sun elevation,azimuth in degrees instead of the preset's */
  sun: { kind: numbers, owner: "atmos" },
  /** time of day (hours) for views and captures */
  t: { kind: num(12), owner: "boot" },
  /** drop a texture's CPU copy once it is on the GPU, where its owner opted in */
  texfree: { kind: on, owner: "engine" },
  /** profile texture uploads */
  texprof: { kind: present, owner: "engine" },
  /** far terrain material beyond 350 m */
  tfar: { kind: on, owner: "terrain" },
  /** town materials crossfade between LOD tiers */
  townxfade: { kind: on, owner: "pois" },
  /** debug colours for the veg colliders */
  vegcol: { kind: one, owner: "veg" },
  /** veg perf attribution switches: noshadow, noimp, nolod0, nolod1, nodetail */
  vegdbg: { kind: list, owner: "veg" },
  /** depth pre-pass for alpha-tested foliage (measured slower, so off) */
  vegpre: { kind: one, owner: "veg" },
  /** veg quality tier (low, medium, high, epic) instead of the engine's */
  vegq: { kind: text, owner: "veg" },
  /** LOD1 of the casting species casts into the dynamic shadow cascades */
  vegshadow1: { kind: on, owner: "veg" },
  /** opaque LOD0 parts crossfade with their tier */
  vegsolidfade: { kind: on, owner: "veg" },
  /** gaussian-splat far trees */
  vegsplat: { kind: on, owner: "veg" },
  /** gaussian-splat far understory */
  vegsplatsmall: { kind: on, owner: "veg" },
  /** scatter the vegetation on the main thread instead of a worker */
  vegsyncscatter: { kind: present, owner: "veg" },
  /** compile every veg shadow program at load */
  vegwarm: { kind: on, owner: "veg" },
  /** foliage LOD tiers crossfade */
  vegxfade: { kind: on, owner: "veg" },
  /** Mist Falls rock veneer splits into near and far parts */
  veneerSplit: { kind: on, owner: "pois" },
  /** boot into a fixed dev view (a POI, biome or studio) instead of the game */
  view: { kind: text, owner: "boot" },
  /** detail fades in and out at the cull edge (always off under Node) */
  visfade: { kind: on, owner: "engine" },
  /** viewmodel stage reload frozen at this fraction; default 0.33 */
  vmu: { kind: text, owner: "weapons" },
  /** anisotropy of the water normal and ripple textures; 0 = the default (4, ripples 8) */
  waniso: { kind: num(0), owner: "water" },
  /** water clipmap base cell size (m); 0 = 1 m */
  wbase: { kind: num(0), owner: "water" },
  /** water clipmap cells per level; 0 = by quality (48 low, else 64) */
  wcells: { kind: num(0), owner: "water" },
  /** draw foam in its own pass instead of the main water pass */
  wfoampass: { kind: present, owner: "water" },
  /** paint demo foam shapes */
  wfoamtest: { kind: present, owner: "water" },
  /** water clipmap levels; 0 = 8 */
  wlevels: { kind: num(0), owner: "water" },
  /** turn off dual-source blending for water */
  wnodual: { kind: present, owner: "water" },
  /** turn off the scene grab behind water (refraction) */
  wnoscene: { kind: present, owner: "water" },
  /** turn off the water's per-vertex sun shadow lookup */
  wnovshadow: { kind: present, owner: "water" },
  /** physical water: full sun glitter, no artistic reflection lifts */
  wphys: { kind: present, owner: "water" },
  /** depth pre-pass for water */
  wprepass: { kind: present, owner: "water" },
  /** demo ripples */
  wripple: { kind: present, owner: "water" },
  /** game server socket URL (ws:// or wss://) instead of the page's own */
  ws: { kind: text, owner: "game", routing: true },
  /** WebTransport: =1 on, =0 off, else the A/B arm */
  wt: { kind: text, owner: "game" },
} as const satisfies Record<string, Flag>;

export type FlagName = keyof typeof FLAGS;
export type FlagValue<K extends FlagName> = (typeof FLAGS)[K]["kind"] extends Kind<infer T> ? T : never;

const STORAGE_KEY = "kr.flags";

function readQuery(): URLSearchParams {
  const url = new URLSearchParams(globalThis.location?.search ?? "");
  if (typeof document === "undefined") return url;
  let stored: string | null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { return url; }
  if (!stored) return url;
  const merged = new URLSearchParams(stored);
  for (const [name, f] of Object.entries(FLAGS as Record<string, Flag>)) if (f.routing) merged.delete(name);
  for (const k of url.keys()) merged.delete(k);
  for (const [k, v] of url) merged.append(k, v);
  return merged;
}

const q = readQuery();

export const flagQuery: Readonly<Record<string, string>> = Object.fromEntries(q);

const values: Record<string, unknown> = {};
{
  for (const [name, { kind }] of Object.entries(FLAGS as Record<string, Flag>)) {
    const v = q.get(name);
    values[name] = v === null ? kind.default : kind.parse(v);
  }
  // the annotator picks on CPU vertices and its wireframe builds edge indices from them, so it keeps them unless asked
  if (values.dev === "annotate" && q.get("geofree") === null) values.geofree = false;
}

export function flag<K extends FlagName>(name: K): FlagValue<K> {
  return values[name] as FlagValue<K>;
}
