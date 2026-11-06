// Pure shared landscape art direction. No camera, renderer or frame-time dependencies.
// (Grouped groves + meadow openings instead of an
// even canopy outside the deep jungle; crowns kept off authored streets / paths. Read by shared/world/veg-scatter.ts —
// the server replays the same scatter for its trunk colliders — and by client/src/world/veg/index.ts for POI leaves.)
import { WORLD, POIS, Biome } from './map';
import { Simplex2, smoothstep } from './noise';
import type { Terrain } from './terrain';
import { STREETS } from '../pois/mango-market';
import { LAYOUT as COVE } from '../pois/coconut-cove';
import { ROADS } from '../pois/the-plantation';
import * as dmath from "../sim/dmath";

const groveNoise = new Simplex2(WORLD.SEED + 8107);
/** Dense enclosed jungle deliberately survives away from settlements and approach roads.
 * (a few deliberate deep-jungle stands — fbm threshold 0.2 and 40 m off the roads, so the
 * stands sit between the rotations instead of lining them) */
export function deepJungleAt(t: Terrain, x: number, z: number, roadDistance: number): boolean {
  if (t.biomeAt(x,z) !== Biome.Jungle || roadDistance < 40) return false;
  if (POIS.some(p => dmath.hypot(x-p.x,z-p.z) < p.r + 45)) return false;
  return groveNoise.fbm(x/190+27,z/190-15,2) > 0.2;
}
/** 0..1: how much a spot sits in the ring that frames a POI (r + 6 … r + 40 m outside its radius) */
function poiFrame(x: number, z: number): number {
  let best = 0;
  for (const p of POIS) {
    const d = dmath.hypot(x-p.x,z-p.z) - p.r;
    if (d < 0 || d > 42) continue;
    best = Math.max(best, smoothstep(2,8,d) * (1 - smoothstep(26,42,d)));
  }
  return best;
}
/** Shared, broad grove field creates coherent canopy masses and meadow openings, rather than uniform thinning.
 * (the areas between POIs stay clean, high visibility: outside the deep-jungle stands the grove cores are fewer, the
 * dirt-road rotations get open verges (trees thin to 12 % within 10 m of a road edge, full grove density from 30 m), and the ring
 * framing each POI keeps the denser first-pass groves — cover pockets on the way in.) */
export function canopyKeepAt(t: Terrain, x: number, z: number, roadDistance: number): number {
  if (deepJungleAt(t,x,z,roadDistance)) return 1;
  const grove = 0.5 + 0.5 * groveNoise.fbm(x/76,z/76,2);
  const previous = 0.02 + 0.92 * smoothstep(0.37,0.65,grove);
  const verge = 0.12 + 0.88 * smoothstep(10,30,roadDistance);
  // Mango Market (430, 20) and its approaches (240 m) keep the gentler first-pass grove field: more solid cover there.
  if (dmath.hypot(x-430,z-20)<240) return previous * (0.3 + 0.45 * verge);
  // Distinct dense grove cores and open meadow, rather than isolated trunks across the entire transition.
  const broadGrove = 0.5 + 0.5 * groveNoise.fbm(x/110,z/110,2);
  const open = (0.01 + 0.98 * smoothstep(0.62,0.68,broadGrove)) * verge;
  // groves framing a POI: the first-pass field (cover pockets on the approach), still open along the road in
  return Math.max(open, previous * 0.5 * poiFrame(x,z) * (0.35 + 0.65 * verge));
}
/** understory (bush / monstera / banana) away from any trunk, outside the deep jungle: the open floor
 *  between groves reads clean — this factor multiplies the design layer's far-from-trunk share */
export const OPEN_FLOOR_KEEP = 0.4;

interface Lane { a: [number,number]; b: [number,number]; halfWidth: number }
let lanes: Lane[] | undefined;
// Build lazily: these authored layouts already call vegetation shape helpers during module initialization.
function authoredLanes(): Lane[] {
  if (lanes) return lanes;
  lanes = [];
  const polyline = (pts: Array<[number,number]>, halfWidth: number) => {
    for(let i=1;i<pts.length;i++) lanes!.push({a:pts[i-1],b:pts[i],halfWidth});
  };
  for(const street of STREETS) polyline(street.pts,street.w/2+2.5);
  for(const [a,b] of COVE.paths) polyline([a,b],3);
  for(const road of ROADS) polyline(road.pts,road.hw+2.5);
  return lanes;
}
/** Crown versus real street/path corridors, including footprints not painted into the terrain biome. */
export function crownOverAuthoredLane(x: number,z: number,radius: number): boolean {
  for(const {a,b,halfWidth} of authoredLanes()) {
    if(x < Math.min(a[0],b[0])-halfWidth-radius || x > Math.max(a[0],b[0])+halfWidth+radius ||
       z < Math.min(a[1],b[1])-halfWidth-radius || z > Math.max(a[1],b[1])+halfWidth+radius) continue;
    const dx=b[0]-a[0],dz=b[1]-a[1],u=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz||1)));
    if(dmath.hypot(x-a[0]-dx*u,z-a[1]-dz*u) < halfWidth+radius) return true;
  }
  return false;
}

/** Primary approach verges carry knee-high decorative leaves; interior thickets retain their authored scale.
 * roadDistance is measured from the painted edge, so even a standing player just outside the dirt can see across it.
 */
export function approachLeafHeight(roadDistance: number): number {
  return 0.75 + 2.25 * smoothstep(12, 24, roadDistance);
}
