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
type Flag = { readonly kind: Kind<unknown>; readonly owner: Owner; readonly purpose: string; readonly routing?: true };

const FLAGS = {
  announce: { kind: present, owner: "boot", purpose: "show the display-preset toasts to automated browsers too" },
  arms: { kind: text, owner: "weapons", purpose: "first-person arms: =2 the v2 arms, =1 the current ones; absent = localStorage kr.arms" },
  armsab: { kind: present, owner: "weapons", purpose: "keep every hand mesh so a bench can swap v1 and v2 arms live" },
  atmos: { kind: list, owner: "atmos", purpose: "atmosphere debug switches: noao, nogr, nobloom, nosmaa, nosharpen, noshadow, noclouds, nopost, nofog, nocloudshadow, cloudmarch" },
  atmosp: { kind: text, owner: "atmos", purpose: "override preset fields as key:value,key:value (hex colours as c0ffee)" },
  audioevict: { kind: one, owner: "audio", purpose: "free the decoded sound of on-demand groups when a match ends (memory)" },
  aux: { kind: on, owner: "game", purpose: "open the auxiliary socket next to the match socket" },
  bananatint: { kind: on, owner: "veg", purpose: "per-plant tint variation on banana leaves" },
  cam: { kind: text, owner: "boot", purpose: "ad-hoc camera x,y,z,tx,ty,tz[,fov] instead of the game" },
  canopyOff: { kind: list, owner: "pois", purpose: "Canopy Line perf probe: hide crowns, det, main or cast" },
  cast: { kind: text, owner: "caster", routing: true, purpose: "open as a caster seat on this lobby code" },
  caster: { kind: text, owner: "caster", routing: true, purpose: "open as a caster seat (=exhibit starts an exhibition)" },
  cavesAmb: { kind: finite(0.36), owner: "pois", purpose: "Coco Caves remaining sky ambient deep inside" },
  cavesHide: { kind: list, owner: "pois", purpose: "Coco Caves ablation: hide parts whose names contain these" },
  cavesLamp: { kind: finite(0.7), owner: "pois", purpose: "Coco Caves lamp irradiance gain" },
  cavesSky: { kind: finite(0.32), owner: "pois", purpose: "Coco Caves sky visibility at which the outside look is fully back" },
  codebug: { kind: present, owner: "pois", purpose: "log the coplanar-face fixes the town and coast kits make" },
  coworker: { kind: on, owner: "pois", purpose: "resolve the town kit's coplanar faces in a Web Worker; =0 resolves them on the main thread, time-sliced" },
  craneproxy: { kind: present, owner: "pois", purpose: "Peel Harbor cranes swap to their proxy at 150 m (the old behaviour)" },
  ctLod: { kind: num(18), owner: "pois", purpose: "Peel Harbor container LOD distance (m)" },
  ctMid: { kind: num(0), owner: "pois", purpose: "Peel Harbor container mid LOD distance (m); 0 = none" },
  cullfov: { kind: on, owner: "engine", purpose: "detail cull distances scale with the camera's field of view" },
  debug: { kind: present, owner: "boot", purpose: "show boot errors on screen" },
  dev: { kind: text, owner: "boot", purpose: "dev tools after ready, and the full title (=annotate opens the world annotator)" },
  dither: { kind: on, owner: "engine", purpose: "LOD fades dither; =0 scales instead (always off under Node)" },
  dpr: { kind: num(0), owner: "engine", purpose: "device pixel ratio instead of the screen's (capped at 2); 0 = the screen's" },
  dside: { kind: present, owner: "pois", purpose: "Mist Falls materials render double-sided" },
  dynres: { kind: text, owner: "engine", purpose: "dynamic resolution: =1 on, =0 forced off, absent = the setting" },
  [EVENT_PARAM]: { kind: text, owner: "game", routing: true, purpose: "event lobby code from an admin's player link" },
  elevlod: { kind: on, owner: "pois", purpose: "elevation-aware LOD distances in the POIs; =0 = the old switches" },
  fly: { kind: present, owner: "boot", purpose: "free-fly camera on top of a view" },
  fp3: { kind: on, owner: "weapons", purpose: "tucked first-person arms and item hold; =0 = the older outstretched arms" },
  fullcam: { kind: present, owner: "engine", purpose: "full scene-graph camera updates instead of the camera-only walk" },
  fxlive: { kind: present, owner: "weapons", purpose: "weapon stages play effects live instead of frozen" },
  fxt: { kind: text, owner: "weapons", purpose: "time (s) the fx stage freezes at; default 0.2" },
  geofree: { kind: one, owner: "engine", purpose: "=1 drops the CPU vertex arrays of static town-kit batches once they are on the GPU" },
  geoshare: { kind: on, owner: "engine", purpose: "copies of one asset share their identical vertex arrays (crates per rarity, the two planes); =0 keeps a copy each" },
  gpu: { kind: text, owner: "engine", purpose: "renderer string to classify instead of the real GPU's" },
  guard: { kind: present, owner: "boot", purpose: "run the display frame-rate guard in automated browsers too" },
  gunat: { kind: text, owner: "weapons", purpose: "chest stage hero gun position x,y,z" },
  gunid: { kind: text, owner: "weapons", purpose: "chest stage hero gun weapon id; default rocket" },
  gunpose: { kind: text, owner: "weapons", purpose: "chest stage hero gun scale,pitch,roll" },
  gunrev: { kind: text, owner: "weapons", purpose: "chest stage hero gun muzzle side: =1 up-right, else down-left; absent = up-right" },
  harborhyst: { kind: on, owner: "pois", purpose: "hysteresis on Peel Harbor LOD switches" },
  harborNoCull: { kind: present, owner: "pois", purpose: "turn off Peel Harbor's LOD culling" },
  harborOnly: { kind: subset, owner: "pois", purpose: "build only these Peel Harbor parts (plus the apron)" },
  headless: { kind: present, owner: "audio", purpose: "audition page without its buttons (scripted runs)" },
  heavyms: { kind: num(Infinity), owner: "boot", purpose: "modules that take longer than this (ms) build behind the match card" },
  helilazy: { kind: text, owner: "actors", purpose: "=1 loads the helicopter model at its first use in a match, =0 when the title is ready (the prefab warm-up); absent = first use on Safari and on devices reporting under 8 GB, else when the title is ready" },
  ice: { kind: text, owner: "voice", purpose: "dev builds: ICE server URLs for voice, comma list" },
  impblend: { kind: on, owner: "veg", purpose: "impostors crossfade between their baked views" },
  impcull: { kind: on, owner: "veg", purpose: "cull impostor cells outside the view; =0 draws every impostor every frame" },
  impgrade: { kind: numbers, owner: "veg", purpose: "four numbers that replace the impostor colour grade uImpGrade" },
  impshadow: { kind: on, owner: "veg", purpose: "impostor quads cast the island-wide canopy shadows into the static far map" },
  impsplit: { kind: numbers, owner: "veg", purpose: "four numbers that replace the impostor shade/sun split uImpSplit" },
  jdbgNoRocks: { kind: present, owner: "pois", purpose: "Mist Falls water without its rocks" },
  join: { kind: text, owner: "game", routing: true, purpose: "join this private lobby code" },
  jungleCheck: { kind: present, owner: "pois", purpose: "check the baked jungle layout still matches the terrain" },
  jungleNoVeg: { kind: present, owner: "pois", purpose: "jungle POIs plant no vegetation" },
  kong: { kind: text, owner: "actors", purpose: "kong asset: v1, v2 or alt; absent = v2" },
  konghalf: { kind: on, owner: "actors", purpose: "near-tier kong normal, clothing and sneaker maps load at 1024², 2048² for your victory shot and view pages; =0 keeps 2048²" },
  kongproxy: { kind: maybeNum, owner: "actors", purpose: "kong shadow proxy shrink (cm); 0 = no kong shadows" },
  kongtier: { kind: text, owner: "actors", purpose: "force every kong into LOD tier 0, 1 or 2" },
  kongv: { kind: one, owner: "actors", purpose: "the procedural kong instead of the asset" },
  ktx2: { kind: text, owner: "engine", purpose: "=1 loads POI textures from .ktx2 copies, =etc1s with ETC1S normal maps" },
  kysat: { kind: num(1.12), owner: "actors", purpose: "v2 kong ripe-yellow chroma" },
  kyval: { kind: num(0.97), owner: "actors", purpose: "v2 kong ripe-yellow value" },
  labhide: { kind: list, owner: "pois", purpose: "CNVS Lab perf A/B: hide shell, near, interior, glass, rocks, vines, falls, gravel, rooms" },
  lodv: { kind: on, owner: "engine", purpose: "the anti-pop LOD path: terrain geomorph, rock and HLOD crossfades, view-dependent detail culling" },
  lootlater: { kind: on, owner: "weapons", purpose: "bake the floor-loot far LODs after the title is ready, before the prefab warm-up a match waits for, instead of during boot; =0 bakes them during boot" },
  lowmem: { kind: text, owner: "boot", purpose: "build POIs only near the player: =1 on, =0 off, absent = auto" },
  lowmemr: { kind: num(450), owner: "boot", purpose: "lowmem build distance (m, horizontal; in the warm-up and the plane it counts height above the pad too, and in the plane up to lowmemview POIs in view build as well, ahead of nearby ones out of view)" },
  lowmemview: { kind: num(2), owner: "boot", purpose: "lowmem: at most this many far POIs build because they are in view during the plane; the rest stay terrain until landing" },
  lowmemcap: { kind: num(3), owner: "boot", purpose: "lowmem: at most this many streamed POIs stay built; past it the farthest is evicted, never the nearest or the one the player is in" },
  lowmembudget: { kind: num(1500), owner: "boot", purpose: "lowmem: estimated MB (vertex arrays + textures) the streamed POIs may hold; past it the farthest is evicted like lowmemcap" },
  farimp: { kind: present, owner: "boot", purpose: "lowmem: draw a baked far impostor (public/assets/far) for every streamed POI that is not built" },
  lowmemhyst: { kind: num(100), owner: "boot", purpose: "lowmem: at the cap or budget, a pending POI builds only if it is this much nearer (m) than the POI it would evict" },
  manual: { kind: present, owner: "caster", purpose: "caster camera starts in manual instead of autopilot" },
  map: { kind: one, owner: "ui", purpose: "open the full-screen map (view-camera captures)" },
  mode: { kind: text, owner: "caster", routing: true, purpose: "mode of the lobby a caster creates: trios, else solo" },
  modules: { kind: subset, owner: "boot", purpose: "build only these modules (ids or prefixes)" },
  murkdbg: { kind: num(0), owner: "pois", purpose: "The Murk water debug mode" },
  murknoscene: { kind: present, owner: "pois", purpose: "The Murk water without its scene grab" },
  murkoff: { kind: list, owner: "pois", purpose: "The Murk: skip building decks, huts or int" },
  noannounce: { kind: present, owner: "boot", purpose: "never show the display-preset toasts" },
  nobuildgate: { kind: present, owner: "boot", purpose: "streamed POIs draw before their build gate releases" },
  nochests: { kind: present, owner: "weapons", purpose: "chest stress stage without chests" },
  nocull: { kind: present, owner: "engine", purpose: "turn off detail, POI and harbor culling: draw everything at full detail" },
  nofreeze: { kind: present, owner: "engine", purpose: "turn off the static matrix cache" },
  nohlod: { kind: present, owner: "engine", purpose: "turn off the far HLOD merge" },
  nolight: { kind: present, owner: "weapons", purpose: "chest studio without the chest's own light" },
  noloot: { kind: present, owner: "weapons", purpose: "chest stress stage without loot" },
  nolootworker: { kind: present, owner: "engine", purpose: "compute loot spots on the main thread instead of a worker" },
  noocc: { kind: present, owner: "engine", purpose: "turn off POI occlusion culling" },
  noopen: { kind: present, owner: "weapons", purpose: "chest stage chests stay closed" },
  nostream: { kind: present, owner: "boot", purpose: "build every module before the title instead of streaming" },
  nostress: { kind: present, owner: "weapons", purpose: "chest stage without the stress field" },
  notimer: { kind: present, owner: "engine", purpose: "act as a browser without GPU timer queries" },
  nowarmshadow: { kind: present, owner: "engine", purpose: "warm draws skip the roots' shadow-depth programs" },
  offinstant: { kind: on, owner: "engine", purpose: "culled detail switches off at once instead of fading out" },
  outfits: { kind: text, owner: "actors", purpose: "kong outfit dev view (=N picks the count; empty = 1)" },
  painttex: { kind: present, owner: "pois", purpose: "paint coast textures at load instead of loading the baked ones" },
  pixcap: { kind: one, owner: "atmos", purpose: "=1 sizes the post chain's screen-sized targets (TAA history, velocity, viewmodel, scene buffers) from the quality tier's pixel cap instead of the canvas, and stretches the result to the canvas in the final blit" },
  planefree: { kind: on, owner: "actors", purpose: "the plane's painted canvases and their GPU copies are freed after the drop and repainted when the match ends; =0 keeps them" },
  poicap: { kind: maybeNum, owner: "engine", purpose: "longest edge (px) of POI texture files and harbor-kit paint, downscaled before upload; absent = 1024, 512 on low-memory devices; 0 = no cap" },
  playtest: { kind: text, owner: "ui", purpose: "playtest title with one Play button: present or =1 on, =0 off" },
  prepare: { kind: text, owner: "boot", purpose: "=full builds everything behind the match card instead of streaming" },
  prewarm: { kind: text, owner: "game", purpose: "=full prewarms every prefab before ready instead of after" },
  program: { kind: present, owner: "caster", routing: true, purpose: "this caster window is the program output (OBS feed)" },
  q: { kind: text, owner: "boot", purpose: "build quality ultra, high, medium or low instead of the video preset's" },
  readyby: { kind: num(25000), owner: "boot", purpose: "target time (ms) for the title to be ready; the stream planner works back from it" },
  readyest: { kind: on, owner: "boot", purpose: "pre-ready planner uses the measured post-build estimate (stored per device) and never plans past readyby; =0 plans with the fixed estimate" },
  rockMerge: { kind: on, owner: "pois", purpose: "Mist Falls merges its near rock sets into meshes; =0 = the old instanced sets" },
  rocks: { kind: on, owner: "terrain", purpose: "draw the terrain rocks" },
  resaudit: { kind: present, owner: "engine", purpose: "__kr.resAudit(): what the renderer holds outside a scope" },
  scale: { kind: num(0), owner: "engine", purpose: "pin the 3D resolution scale; 0 = not pinned" },
  sculpt: { kind: present, owner: "pois", purpose: "town statue sculpts live instead of loading its baked mesh" },
  seed: { kind: num(0), owner: "game", purpose: "practice match seed (plane line, storm, loot); 0 = random" },
  shadercheck: { kind: present, owner: "game", purpose: "keep three's shader error checks on" },
  shot: { kind: present, owner: "boot", purpose: "capture mode: frozen time, pixel ratio 1, HUD hidden" },
  splasync: { kind: one, owner: "veg", purpose: "read splat captures back from the GPU asynchronously" },
  splcache: { kind: on, owner: "veg", purpose: "keep baked splats in the browser cache; =0 bakes on every load" },
  splcut: { kind: num(1), owner: "veg", purpose: "splat opacity cut-off gain" },
  spldbg: { kind: list, owner: "veg", purpose: "splat shader switches: noatm, nofog, nofar" },
  spldens: { kind: num(0.3), owner: "veg", purpose: "splat density that picks a level from a plant's projected radius" },
  splhue: { kind: num(-0.12), owner: "veg", purpose: "near-splat hue shift" },
  splhull: { kind: one, owner: "veg", purpose: "bake splats from the crown hull capture (always on under Node)" },
  splkeep: { kind: num(0.35), owner: "veg", purpose: "splat keep fraction" },
  splnear: { kind: num(1024), owner: "veg", purpose: "levels with at least this many splats are captured from LOD1" },
  splocc: { kind: num(1), owner: "veg", purpose: "splat ambient occlusion gain" },
  splocfar: { kind: num(0.5), owner: "veg", purpose: "splat ambient occlusion gain far away" },
  splop: { kind: num(1.35), owner: "veg", purpose: "splat opacity gain" },
  splres: { kind: num(256), owner: "veg", purpose: "splat capture resolution (px)" },
  splsat: { kind: num(1.1), owner: "veg", purpose: "near-splat saturation" },
  splshadow: { kind: num(1), owner: "veg", purpose: "splat shadow gain" },
  splshfar: { kind: num(0.6), owner: "veg", purpose: "splat shadow gain far away" },
  splshoff: { kind: num(1), owner: "veg", purpose: "splat shadow offset" },
  splspread: { kind: num(1.25), owner: "veg", purpose: "splat capture spread" },
  splsz: { kind: num(1), owner: "veg", purpose: "splat size gain" },
  splthick: { kind: num(0.22), owner: "veg", purpose: "splat capture thickness" },
  steam: { kind: on, owner: "terrain", purpose: "lava steam vents in the badlands" },
  stormdebug: { kind: finite(0), owner: "game", purpose: "storm volume debug mode" },
  stormhide: { kind: text, owner: "game", purpose: "hide these storm parts (comma list)" },
  streamgrace: { kind: num(2500), owner: "boot", purpose: "grace (ms) after ready before streaming resumes, for a quick Play click" },
  streamslice: { kind: numbers, owner: "engine", purpose: "stream budget per frame in ms: title,warm,match" },
  studio: { kind: text, owner: "weapons", purpose: "weapon studio light overrides as key:value,key:value" },
  sun: { kind: numbers, owner: "atmos", purpose: "sun elevation,azimuth in degrees instead of the preset's" },
  t: { kind: num(12), owner: "boot", purpose: "time of day (hours) for views and captures" },
  texfree: { kind: on, owner: "engine", purpose: "drop a texture's CPU copy once it is on the GPU, where its owner opted in" },
  texprof: { kind: present, owner: "engine", purpose: "profile texture uploads" },
  tfar: { kind: on, owner: "terrain", purpose: "far terrain material beyond 350 m" },
  townxfade: { kind: on, owner: "pois", purpose: "town materials crossfade between LOD tiers" },
  vegcol: { kind: one, owner: "veg", purpose: "debug colours for the veg colliders" },
  vegdbg: { kind: list, owner: "veg", purpose: "veg perf attribution switches: noshadow, noimp, nolod0, nolod1, nodetail" },
  vegpre: { kind: one, owner: "veg", purpose: "depth pre-pass for alpha-tested foliage (measured slower, so off)" },
  vegq: { kind: text, owner: "veg", purpose: "veg quality tier (low, medium, high, epic) instead of the engine's" },
  vegshadow1: { kind: on, owner: "veg", purpose: "LOD1 of the casting species casts into the dynamic shadow cascades" },
  vegsolidfade: { kind: on, owner: "veg", purpose: "opaque LOD0 parts crossfade with their tier" },
  vegsplat: { kind: on, owner: "veg", purpose: "gaussian-splat far trees" },
  vegsplatsmall: { kind: on, owner: "veg", purpose: "gaussian-splat far understory" },
  vegsyncscatter: { kind: present, owner: "veg", purpose: "scatter the vegetation on the main thread instead of a worker" },
  vegwarm: { kind: on, owner: "veg", purpose: "compile every veg shadow program at load" },
  vegxfade: { kind: on, owner: "veg", purpose: "foliage LOD tiers crossfade" },
  veneerSplit: { kind: on, owner: "pois", purpose: "Mist Falls rock veneer splits into near and far parts" },
  view: { kind: text, owner: "boot", purpose: "boot into a fixed dev view (a POI, biome or studio) instead of the game" },
  visfade: { kind: on, owner: "engine", purpose: "detail fades in and out at the cull edge (always off under Node)" },
  vmu: { kind: text, owner: "weapons", purpose: "viewmodel stage reload frozen at this fraction; default 0.33" },
  waniso: { kind: num(0), owner: "water", purpose: "anisotropy of the water normal and ripple textures; 0 = the default (4, ripples 8)" },
  wbase: { kind: num(0), owner: "water", purpose: "water clipmap base cell size (m); 0 = 1 m" },
  wcells: { kind: num(0), owner: "water", purpose: "water clipmap cells per level; 0 = by quality (48 low, else 64)" },
  wfoampass: { kind: present, owner: "water", purpose: "draw foam in its own pass instead of the main water pass" },
  wfoamtest: { kind: present, owner: "water", purpose: "paint demo foam shapes" },
  wlevels: { kind: num(0), owner: "water", purpose: "water clipmap levels; 0 = 8" },
  wnodual: { kind: present, owner: "water", purpose: "turn off dual-source blending for water" },
  wnoscene: { kind: present, owner: "water", purpose: "turn off the scene grab behind water (refraction)" },
  wnovshadow: { kind: present, owner: "water", purpose: "turn off the water's per-vertex sun shadow lookup" },
  wphys: { kind: present, owner: "water", purpose: "physical water: full sun glitter, no artistic reflection lifts" },
  wprepass: { kind: present, owner: "water", purpose: "depth pre-pass for water" },
  wripple: { kind: present, owner: "water", purpose: "demo ripples" },
  ws: { kind: text, owner: "game", routing: true, purpose: "game server socket URL (ws:// or wss://) instead of the page's own" },
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
}

export function flag<K extends FlagName>(name: K): FlagValue<K> {
  return values[name] as FlagValue<K>;
}
