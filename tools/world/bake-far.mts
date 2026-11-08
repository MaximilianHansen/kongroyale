import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { MeshoptSimplifier } from "meshoptimizer";
import { POIS } from "../../shared/world/map";
import { FAR_DIR, FAR_INDEX, binHash, poiSourceHash, type FarIndex } from "./far-hash.mts";

const USAGE = "npx tsx tools/world/bake-far.mts [--url http://127.0.0.1:3120] [--only id,id] [--tris 12000]";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv.includes("--help")) { console.log(USAGE); process.exit(0); }
const base = arg("--url") ?? "http://127.0.0.1:3120";
const target = Number(arg("--tris") ?? 12000);
const only = arg("--only")?.split(",");
const FIELD_MIN = 64, FIELD_SHARE_MAX = 0.4, WELD_PER_M = 1000, ERROR_START = 0.001, ERROR_STEP = 1.25, ERROR_MAX = 0.005, COLOR_WEIGHTS = [0.5, 0.5, 0.5];
const VIEW_DIST_M = 800, VIEW_UP_M = 250, SETTLE_MS = 4000, BUILD_TIMEOUT_MS = 900000;
/** far stand-ins for the POI-planted kinds: crown centre height (m, at scale 1), crown radius (m), sRGB colour */
const PLANT_SPECS: Record<string, [number, number, string]> = {
  "palm": [7, 2.6, "#5d8a2e"], "palm-leaning": [6, 2.6, "#5d8a2e"], "jungle-tree": [9, 4, "#4e7f2a"], "mangrove": [5, 3.5, "#4e7a2c"],
  "bush": [0.9, 1.1, "#6b9a35"], "fern": [0.5, 0.8, "#7aa63c"], "monstera": [0.8, 1, "#4f8a30"], "banana-plant": [2, 1.4, "#8ab040"], "bamboo": [4, 1, "#94b04a"],
};
const PLANTS = Object.fromEntries(Object.entries(PLANT_SPECS).map(([k, [y, r, hex]]) => [k, [y, r, [1, 3, 5].map((i) => Math.pow(parseInt(hex.slice(i, i + 2), 16) / 255, 2.2))]]));
const ids = POIS.map((p) => p.id).filter((id) => id !== "lobby-islet" && (!only || only.includes(id)));

/** idx ranges [start, end) of the instanced fields: many small rocks the error-driven simplifier breaks into shards */
interface Extracted { pos: Float32Array; col: Float32Array; idx: Uint32Array; field: Uint32Array; skipped: Record<string, number> }
/** what the POI planted through the veg API (recorded by a stand-in, the bake page loads no veg module) */
type Planted = Array<[kind: string, matrices: number[][]]>;
interface Soup { pos: number[]; col: number[]; idx: number[]; tris: number; srcTris: number; error: number; skipped: Record<string, number> }

function extract(a: { id: string; plants: Record<string, [y: number, r: number, rgb: number[]]>; fieldMin: number }): Extracted {
  const kr = (window as unknown as { __kr: { moduleRoots(id: string): unknown[] } }).__kr;
  type M = { isMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean; isSkinnedMesh?: boolean; visible: boolean; parent: M | null; children: M[]; layers: { mask: number }; matrixWorld: { elements: number[] }; geometry?: G; material?: Mat | Mat[]; count?: number; instanceMatrix?: { array: Float32Array }; instanceColor?: { array: Float32Array } | null; getGeometryIdAt?(i: number): number; getGeometryRangeAt?(g: number): { vertexStart: number; vertexCount: number; indexStart: number; indexCount: number }; getVisibleAt?(i: number): boolean; _instanceInfo?: Array<{ active: boolean }>; _matricesTexture?: { image: { data: Float32Array } }; _colorsTexture?: { image: { data: Float32Array } } | null; updateMatrixWorld(force: boolean): void };
  type A = { count: number; itemSize: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number; array: ArrayLike<number> | null };
  type G = { attributes: Record<string, A>; index: A | null; drawRange: { start: number; count: number } };
  type Mat = { visible: boolean; transparent: boolean; opacity: number; depthWrite: boolean; colorWrite: boolean; alphaTest: number; color?: { r: number; g: number; b: number }; map?: { uuid: string; image?: unknown } | null; vertexColors?: boolean; isShaderMaterial?: boolean; type: string; userData: { farColor?: number[]; jungleUniforms?: { uMoss: { value: number }; uMossCover: { value: number }; uMossColor: { value: { r: number; g: number; b: number } | number }; uMossMap: { value: { uuid: string; image?: unknown } | null }; uJNoise?: { value?: { image?: { data?: ArrayLike<number> } } } } } };
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const texMean = new Map<string, number[]>();
  // the mean colour of the pixels a material really draws: an alpha-tested texture counts only the texels that pass its
  // cut (a leaf card's clear surround is black, and averaging it in turned the Murk's gold canopy brown), any other
  // texture weights each texel by its alpha
  const meanOf = (t: { uuid: string; image?: unknown }, cut: number): number[] => {
    const key = t.uuid + "|" + cut, known = texMean.get(key); if (known) return known;
    let out = [1, 1, 1];
    const im = t.image as { width?: number; height?: number; data?: ArrayLike<number> } | null | undefined;
    const sum = (d: ArrayLike<number>, n: number, ch: number, step: number, scale: number) => {
      const s = [0, 0, 0]; let w = 0;
      for (let i = 0; i < n; i += step) {
        const al = ch === 4 ? d[i * 4 + 3] / scale : 1, wt = cut > 0 ? (al >= cut ? 1 : 0) : al;
        for (let c = 0; c < 3; c++) s[c] += d[i * ch + Math.min(c, ch - 1)] * wt;
        w += wt;
      }
      return w > 0 ? s.map((v) => Math.pow(v / w / scale, 2.2)) : null;
    };
    try {
      if (im && im.data && im.width && im.height) {
        const d = im.data, n = im.width * im.height;
        out = sum(d, n, d.length / n, Math.max(1, Math.floor(n / 4096)), d instanceof Uint8Array || d instanceof Uint8ClampedArray ? 255 : 1) ?? out;
      } else if (im && im.width && im.height) {
        const cv = document.createElement("canvas"); cv.width = 32; cv.height = 32;
        const g = cv.getContext("2d")!; g.drawImage(im as CanvasImageSource, 0, 0, 32, 32);
        out = sum(g.getImageData(0, 0, 32, 32).data, 1024, 4, 1, 255) ?? out;
      }
    } catch { skip("texture-unreadable"); }
    texMean.set(key, out);
    return out;
  };
  const pos: number[] = [], col: number[] = [], idx: number[] = [], field: number[] = [];
  const mul = (a: ArrayLike<number>, b: ArrayLike<number>, o: number[]) => { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; };
  const shown = (o: M, rootObj: M) => { for (let p: M | null = o; p && p !== rootObj; p = p.parent) if (!p.visible) return false; return (o.layers.mask & 1) !== 0; };
  const MOSS_GAIN = 1.7, WHITE = [1, 1, 1];
  const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  let moss: { top: number; side: number; c: number[] } | null = null;
  const steps = new Map<string, number>();
  const meanStep = (noise: ArrayLike<number>, a: number, b: number) => {
    const key = a + "," + b, known = steps.get(key); if (known !== undefined) return known;
    let s = 0; for (let i = 0; i < noise.length; i += 4) s += smooth(a, b, noise[i] / 255);
    steps.set(key, s / (noise.length / 4)); return s / (noise.length / 4);
  };
  const add = (g: G, m: number[], rgb: number[], tint: ArrayLike<number>, vColor: boolean, vStart: number, vCount: number, iStart: number, iCount: number) => {
    const P = g.attributes.position, C = vColor ? g.attributes.color : undefined, N = moss ? g.attributes.normal : undefined, base = pos.length / 3;
    if (!P || !P.array) { skip("no-position"); return; }
    for (let i = vStart; i < vStart + vCount; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      const c = [rgb[0], rgb[1], rgb[2]];
      if (moss && N) {
        const nx = N.getX(i), ny = N.getY(i), nz = N.getZ(i), wx = m[0] * nx + m[4] * ny + m[8] * nz, wy = m[1] * nx + m[5] * ny + m[9] * nz, wz = m[2] * nx + m[6] * ny + m[10] * nz;
        const up = wy / (Math.hypot(wx, wy, wz) || 1);
        const w = Math.min(1, Math.max(smooth(0.25, 0.85, up) * moss.top, moss.side * (1 - smooth(0.2, 0.6, Math.abs(up)))));
        for (let k = 0; k < 3; k++) c[k] += (moss.c[k] - c[k]) * w;
      }
      if (C) { c[0] *= C.getX(i); c[1] *= C.getY(i); c[2] *= C.getZ(i); }
      col.push(c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]);
    }
    if (g.index) for (let i = iStart; i < iStart + iCount; i++) idx.push(base + g.index.getX(i) - vStart);
    else for (let i = 0; i < vCount; i++) idx.push(base + i);
  };
  let jungleNoise: ArrayLike<number> | undefined;
  const findNoise = (o: M) => { for (const x of [o.material ?? []].flat()) jungleNoise ??= x.userData.jungleUniforms?.uJNoise?.value?.image?.data; o.children.forEach(findNoise); };
  for (const r of kr.moduleRoots("poi:" + a.id) as M[]) findNoise(r);
  const tmp: number[] = new Array(16).fill(0), im16 = { elements: new Array(16).fill(0) };
  const shades = new Map<G, Mat>();
  const findShades = (o: M) => { for (const x of [o.material ?? []].flat()) if (o.geometry && x.colorWrite !== false && !shades.has(o.geometry)) shades.set(o.geometry, x); o.children.forEach(findShades); };
  for (const r of kr.moduleRoots("poi:" + a.id) as M[]) findShades(r);
  for (const r of kr.moduleRoots("poi:" + a.id) as M[]) {
    r.updateMatrixWorld(true);
    const walk = (o: M) => {
      if (o !== r && !o.visible) return;
      for (const c of o.children) walk(c);
      if (!o.isMesh || !o.geometry) return;
      if (o.isSkinnedMesh) { skip("skinned"); return; }
      if (!shown(o, r)) { skip("hidden"); return; }
      const own = (Array.isArray(o.material) ? o.material[0] : o.material) as Mat | undefined;
      if (!own || !own.visible) { skip("no-material"); return; }
      // a depth-only prepass (the Murk's crowns) carves the shape and the pass that shades the same geometry gives the colour
      const mat = own.colorWrite === false ? shades.get(o.geometry!) : own;
      if (!mat) { skip("depth-only"); return; }
      // blended surfaces (water, glass, glows) stay out; an alpha-tested one is a solid cutout even when flagged transparent
      // (the Murk's lagoon water is transparent at opacity 1 and baked as a white sheet)
      if (own.colorWrite !== false && (!own.depthWrite || (own.transparent && !(own.alphaTest > 0)))) { skip("transparent"); return; }
      const far = mat.userData.farColor;
      if (mat.isShaderMaterial && !mat.color && !far) { skip("shader"); return; }
      const rgb = far ? far.slice(0, 3) : [mat.color?.r ?? 0.6, mat.color?.g ?? 0.6, mat.color?.b ?? 0.6];
      if (mat.map && !far) { const t = meanOf(mat.map, own.alphaTest || 0); for (let c = 0; c < 3; c++) rgb[c] *= t[c]; }
      const ju = mat.userData.jungleUniforms;
      if (ju && ju.uMoss.value > 0) {
        const cover = ju.uMossCover.value, mv = ju.uMossColor.value, lin = (v: number) => Math.pow(v / 255, 2.2);
        const mc = typeof mv === "number" ? { r: lin((mv >> 16) & 255), g: lin((mv >> 8) & 255), b: lin(mv & 255) } : mv, mm = ju.uMossMap.value ? meanOf(ju.uMossMap.value, 0) : [1, 1, 1];
        const noise = ju.uJNoise?.value?.image?.data ?? jungleNoise;
        if (!noise) { skip("moss-without-noise"); moss = null; } else
        moss = { top: ju.uMoss.value * meanStep(noise, 0.62 - cover * 0.6, 0.92 - cover * 0.6), side: ju.uMoss.value * 0.35 * meanStep(noise, 0.55, 0.8), c: [mc.r * mm[0] * MOSS_GAIN, mc.g * mm[1] * MOSS_GAIN, mc.b * mm[2] * MOSS_GAIN] };
      } else moss = null;
      const g = o.geometry, P = g.attributes.position;
      if (!P) { skip("no-position"); return; }
      const vColor = !far && !!mat.vertexColors && !!g.attributes.color;
      const mw = o.matrixWorld.elements;
      const vAll = P.count, iAll = g.index ? Math.min(g.index.count, g.drawRange.count) : 0;
      if (o.isBatchedMesh) {
        const info = o._instanceInfo ?? [];
        for (let i = 0; i < info.length; i++) {
          if (!info[i].active || !o.getVisibleAt!(i)) continue;
          const gr = o.getGeometryRangeAt!(o.getGeometryIdAt!(i));
          const md = o._matricesTexture!.image.data;
          for (let k = 0; k < 16; k++) im16.elements[k] = md[i * 16 + k];
          const cd = o._colorsTexture?.image.data;
          add(g, mul(mw, im16.elements, tmp.slice()), rgb, cd ? [cd[i * 4], cd[i * 4 + 1], cd[i * 4 + 2]] : WHITE, vColor, gr.vertexStart, gr.vertexCount, gr.indexStart, gr.indexCount);
        }
        return;
      }
      if (o.isInstancedMesh) {
        const n = o.count ?? 0, arr = o.instanceMatrix!.array, ic = o.instanceColor?.array, start = idx.length;
        for (let i = 0; i < n; i++) {
          add(g, mul(mw, Array.prototype.slice.call(arr, i * 16, i * 16 + 16), tmp.slice()), rgb, ic ? [ic[i * 3], ic[i * 3 + 1], ic[i * 3 + 2]] : WHITE, vColor, 0, vAll, 0, iAll);
        }
        if (n >= a.fieldMin) field.push(start, idx.length);
        return;
      }
      add(g, mw, rgb, WHITE, vColor, 0, vAll, 0, iAll);
    };
    walk(r);
  }
  // the plants the POI put on its grounds (Ripe Peak's terrace growth): one small crown blob each, at the species' crown
  // height and size; the tiny kinds (grass, flowers, ground cover) have no entry and add nothing at a far view
  const OCT = [[1, 0, 0], [-1, 0, 0], [0, 0.8, 0], [0, -0.8, 0], [0, 0, 1], [0, 0, -1]], OCT_I = [0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0, 4, 3, 0, 1, 3, 4, 5, 3, 1, 0, 3, 5];
  for (const [kind, list] of (window as unknown as { __farPlants?: Planted }).__farPlants ?? []) {
    const spec = a.plants[kind];
    if (!spec) { skipped["plant:" + kind] = (skipped["plant:" + kind] ?? 0) + list.length; continue; }
    const [cy, cr, rgb] = spec;
    for (const m of list) {
      const base = pos.length / 3;
      for (const [x, y, z] of OCT) {
        const lx = x * cr, ly = cy + y * cr, lz = z * cr;
        pos.push(m[0] * lx + m[4] * ly + m[8] * lz + m[12], m[1] * lx + m[5] * ly + m[9] * lz + m[13], m[2] * lx + m[6] * ly + m[10] * lz + m[14]);
        col.push(rgb[0], rgb[1], rgb[2]);
      }
      for (const i of OCT_I) idx.push(base + i);
    }
  }
  return { pos: new Float32Array(pos), col: new Float32Array(col), idx: new Uint32Array(idx), field: new Uint32Array(field), skipped };
}

async function simplify(raw: Extracted, target: number): Promise<Soup> {
  const srcTris = raw.idx.length / 3;
  const keys = new Map<string, number>(), remap = new Uint32Array(raw.pos.length / 3), pos: number[] = [], col: number[] = [];
  for (let i = 0; i < remap.length; i++) {
    const k = Array.from(raw.pos.subarray(i * 3, i * 3 + 3), (v) => Math.round(v * WELD_PER_M)).join(",") + "|" + Array.from(raw.col.subarray(i * 3, i * 3 + 3), (v) => Math.round(v * 255)).join(",");
    let j = keys.get(k);
    if (j === undefined) { j = keys.size; keys.set(k, j); pos.push(raw.pos[i * 3], raw.pos[i * 3 + 1], raw.pos[i * 3 + 2]); col.push(raw.col[i * 3], raw.col[i * 3 + 1], raw.col[i * 3 + 2]); }
    remap[i] = j;
  }
  const P = new Float32Array(pos), C = new Float32Array(col), tri: number[] = [], fieldTri: number[] = [];
  for (let t = 0, f = 0; t < raw.idx.length; t += 3) {
    while (f < raw.field.length && t >= raw.field[f + 1]) f += 2;
    const a = remap[raw.idx[t]], b = remap[raw.idx[t + 1]], c = remap[raw.idx[t + 2]];
    if (a !== b && b !== c && a !== c) (f < raw.field.length && t >= raw.field[f] ? fieldTri : tri).push(a, b, c);
  }
  await MeshoptSimplifier.ready;
  // the instanced rock fields (Ripe Peak's crag tower: thousands of ~50-triangle rocks) cluster on a grid instead: the
  // error-driven pass can only shrink each rock on its own, so a stacked field came out as scattered shards with the sky
  // showing through; clustering welds neighbouring rocks into one shell, which is what the field reads as from far away
  const fieldShare = Math.min(FIELD_SHARE_MAX, fieldTri.length / 3 / srcTris);
  const fieldOut = fieldTri.length ? MeshoptSimplifier.simplifySloppy(new Uint32Array(fieldTri), P, 3, null, Math.round(target * fieldShare) * 3, 1)[0] : new Uint32Array(0);
  const welded = new Uint32Array(tri), rest = target - fieldOut.length / 3;
  const run = (e: number) => MeshoptSimplifier.simplifyWithAttributes(welded, P, 3, C, 3, COLOR_WEIGHTS, null, Math.min(welded.length, rest * 3), e, ["Permissive"])[0];
  let error = ERROR_START, kept = run(error);
  while (kept.length / 3 > rest && error * ERROR_STEP <= ERROR_MAX) { error *= ERROR_STEP; kept = run(error); }
  const out = [...fieldOut, ...kept];
  const used = new Map<number, number>(), p: number[] = [], c: number[] = [], ix: number[] = [];
  for (const v of out) {
    let n = used.get(v);
    if (n === undefined) { n = used.size; used.set(v, n); p.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); c.push(C[v * 3], C[v * 3 + 1], C[v * 3 + 2]); }
    ix.push(n);
  }
  return { pos: p, col: c, idx: ix, tris: ix.length / 3, srcTris, error, skipped: raw.skipped };
}

function encode(s: Soup): Buffer {
  const n = s.pos.length / 3, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], s.pos[i * 3 + c]); hi[c] = Math.max(hi[c], s.pos[i * 3 + c]); }
  const size = lo.map((v, c) => Math.max(hi[c] - v, 1e-3));
  const wide = n > 65535, head = 40, posB = n * 6, colOff = head + Math.ceil(posB / 4) * 4, idxOff = colOff + n * 4;
  const buf = Buffer.alloc(idxOff + s.idx.length * (wide ? 4 : 2));
  buf.write("KRFI", 0, "ascii"); buf.writeUInt32LE(1, 4); buf.writeUInt32LE(n, 8); buf.writeUInt32LE(s.idx.length, 12);
  for (let c = 0; c < 3; c++) { buf.writeFloatLE(lo[c], 16 + c * 4); buf.writeFloatLE(size[c], 28 + c * 4); }
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) buf.writeUInt16LE(Math.round(((s.pos[i * 3 + c] - lo[c]) / size[c]) * 65535), head + (i * 3 + c) * 2);
  const srgb = (v: number) => Math.round(Math.min(1, Math.max(0, Math.pow(Math.max(0, v), 1 / 2.2))) * 255);
  for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) buf.writeUInt8(srgb(s.col[i * 3 + c]), colOff + i * 4 + c); buf.writeUInt8(255, colOff + i * 4 + 3); }
  for (let i = 0; i < s.idx.length; i++) { if (wide) buf.writeUInt32LE(s.idx[i], idxOff + i * 4); else buf.writeUInt16LE(s.idx[i], idxOff + i * 2); }
  return buf;
}

const indexPath = path.join(root, FAR_INDEX);
const index: FarIndex = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : { version: 1, pois: {} };
fs.mkdirSync(path.join(root, FAR_DIR), { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failed = 0;
for (const id of ids) {
  const p = POIS.find((q) => q.id === id)!;
  const len = Math.hypot(p.x, p.z) || 1, dx = p.x / len, dz = p.z / len, y = p.padY ?? 0;
  const cam = [p.x + dx * VIEW_DIST_M, y + VIEW_UP_M, p.z + dz * VIEW_DIST_M, p.x, y + 20, p.z].map((v) => v.toFixed(1)).join(",");
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  await page.addInitScript("window.__name = (f) => f;");
  // the bake page loads no veg module: a stand-in records what the POI plants (read by extract)
  await page.addInitScript(`{ const rec = window.__farPlants = []; const t = setInterval(() => { const sh = window.__kr && window.__kr.engine && window.__kr.engine.shared; if (!sh) return; clearInterval(t); if (!sh.has("veg")) sh.set("veg", { plant(kind, ms) { rec.push([kind, ms.map((m) => Array.from(m.elements))]); } }); }, 1); }`);
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const t0 = Date.now();
  try {
    await page.goto(`${base}/?cam=${cam}&modules=atmos,terrain,poi:${id}&noocc&nohlod&texfree=0`);
    await page.waitForFunction((m) => { const k = (window as unknown as { __kr?: { ready?: boolean; modules?: string[]; engine?: { pendingHolds(): string[] } } }).__kr; return !!k?.ready && !!k.modules?.includes(m) && k.engine!.pendingHolds().length === 0; }, "poi:" + id, { timeout: BUILD_TIMEOUT_MS, polling: 1000 });
    const loadErrors = await page.evaluate(() => (window as unknown as { __kr: { errors?: unknown[] } }).__kr.errors ?? []);
    if (loadErrors.length) throw new Error("load errors " + JSON.stringify(loadErrors).slice(0, 400));
    await page.waitForTimeout(SETTLE_MS);
    const soup = await simplify(await page.evaluate(extract, { id, plants: PLANTS, fieldMin: FIELD_MIN }), target);
    if (!soup.tris) throw new Error("no geometry extracted " + JSON.stringify(soup.skipped));
    const bin = encode(soup);
    fs.writeFileSync(path.join(root, FAR_DIR, id + ".bin"), bin);
    index.pois[id] = { hash: poiSourceHash(root, id), bin: binHash(bin), tris: soup.tris, bytes: bin.length };
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
    console.log(`${id}: ${soup.srcTris} → ${soup.tris} tris (error ${soup.error.toFixed(4)}), ${(bin.length / 1024).toFixed(0)} KB, ${Math.round((Date.now() - t0) / 1000)} s, skipped ${JSON.stringify(soup.skipped)}${errors.length ? " page errors: " + errors.join(" | ") : ""}`);
  } catch (e) {
    failed++;
    console.error(`${id}: FAILED ${String(e).slice(0, 300)}`);
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
