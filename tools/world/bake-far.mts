import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { POIS } from "../../shared/world/map";
import { FAR_DIR, FAR_INDEX, poiSourceHash, type FarIndex } from "./far-hash.mts";

const USAGE = "npx tsx tools/world/bake-far.mts [--url http://127.0.0.1:3120] [--only id,id] [--tris 12000]";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv.includes("--help")) { console.log(USAGE); process.exit(0); }
const base = arg("--url") ?? "http://127.0.0.1:3120";
const target = Number(arg("--tris") ?? 12000);
const only = arg("--only")?.split(",");
const VIEW_DIST_M = 800, VIEW_UP_M = 250, SETTLE_MS = 4000, BUILD_TIMEOUT_MS = 900000;
const ids = POIS.map((p) => p.id).filter((id) => id !== "lobby-islet" && (!only || only.includes(id)));

interface Soup { pos: number[]; col: number[]; idx: number[]; tris: number; srcTris: number; cell: number; skipped: Record<string, number> }

function extract(a: { id: string; target: number }): Soup {
  const kr = (window as unknown as { __kr: { moduleRoots(id: string): unknown[] } }).__kr;
  type M = { isMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean; isSkinnedMesh?: boolean; visible: boolean; parent: M | null; children: M[]; layers: { mask: number }; matrixWorld: { elements: number[] }; geometry?: G; material?: Mat | Mat[]; count?: number; instanceMatrix?: { array: Float32Array }; instanceColor?: { array: Float32Array } | null; getGeometryIdAt?(i: number): number; getGeometryRangeAt?(g: number): { vertexStart: number; vertexCount: number; indexStart: number; indexCount: number }; getVisibleAt?(i: number): boolean; _instanceInfo?: Array<{ active: boolean }>; _matricesTexture?: { image: { data: Float32Array } }; _colorsTexture?: { image: { data: Float32Array } } | null; updateMatrixWorld(force: boolean): void };
  type A = { count: number; itemSize: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number; array: ArrayLike<number> | null };
  type G = { attributes: Record<string, A>; index: A | null; drawRange: { start: number; count: number } };
  type Mat = { visible: boolean; transparent: boolean; opacity: number; depthWrite: boolean; color?: { r: number; g: number; b: number }; map?: { uuid: string; image?: unknown } | null; vertexColors?: boolean; isShaderMaterial?: boolean; type: string };
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const texMean = new Map<string, number[]>();
  const meanOf = (t: { uuid: string; image?: unknown }): number[] => {
    const known = texMean.get(t.uuid); if (known) return known;
    let out = [1, 1, 1];
    const im = t.image as { width?: number; height?: number; data?: ArrayLike<number> } | null | undefined;
    try {
      if (im && im.data && im.width && im.height) {
        const d = im.data, n = im.width * im.height, step = Math.max(1, Math.floor(n / 4096)), s = [0, 0, 0]; let k = 0;
        const ch = d.length / n;
        for (let i = 0; i < n; i += step) { for (let c = 0; c < 3; c++) s[c] += d[i * ch + Math.min(c, ch - 1)]; k++; }
        const scale = d instanceof Uint8Array || d instanceof Uint8ClampedArray ? 255 : 1;
        out = s.map((v) => Math.pow(v / k / scale, 2.2));
      } else if (im && im.width && im.height) {
        const cv = document.createElement("canvas"); cv.width = 8; cv.height = 8;
        const g = cv.getContext("2d")!; g.drawImage(im as CanvasImageSource, 0, 0, 8, 8);
        const d = g.getImageData(0, 0, 8, 8).data, s = [0, 0, 0];
        for (let i = 0; i < 64; i++) for (let c = 0; c < 3; c++) s[c] += d[i * 4 + c];
        out = s.map((v) => Math.pow(v / 64 / 255, 2.2));
      }
    } catch { skip("texture-unreadable"); }
    texMean.set(t.uuid, out);
    return out;
  };
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const mul = (a: ArrayLike<number>, b: ArrayLike<number>, o: number[]) => { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; };
  const shown = (o: M, rootObj: M) => { for (let p: M | null = o; p && p !== rootObj; p = p.parent) if (!p.visible) return false; return (o.layers.mask & 1) !== 0; };
  const add = (g: G, m: number[], rgb: number[], vColor: boolean, vStart: number, vCount: number, iStart: number, iCount: number) => {
    const P = g.attributes.position, C = vColor ? g.attributes.color : undefined, base = pos.length / 3;
    if (!P || !P.array) { skip("no-position"); return; }
    for (let i = vStart; i < vStart + vCount; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      if (C) col.push(rgb[0] * C.getX(i), rgb[1] * C.getY(i), rgb[2] * C.getZ(i)); else col.push(rgb[0], rgb[1], rgb[2]);
    }
    if (g.index) for (let i = iStart; i < iStart + iCount; i++) idx.push(base + g.index.getX(i) - vStart);
    else for (let i = 0; i < vCount; i++) idx.push(base + i);
  };
  const tmp: number[] = new Array(16).fill(0), im16 = { elements: new Array(16).fill(0) };
  for (const r of kr.moduleRoots("poi:" + a.id) as M[]) {
    r.updateMatrixWorld(true);
    const walk = (o: M) => {
      if (o !== r && !o.visible) return;
      for (const c of o.children) walk(c);
      if (!o.isMesh || !o.geometry) return;
      if (o.isSkinnedMesh) { skip("skinned"); return; }
      if (!shown(o, r)) { skip("hidden"); return; }
      const mat = (Array.isArray(o.material) ? o.material[0] : o.material) as Mat | undefined;
      if (!mat || !mat.visible) { skip("no-material"); return; }
      if ((mat.transparent && mat.opacity < 0.95) || !mat.depthWrite) { skip("transparent"); return; }
      if (mat.isShaderMaterial && !mat.color) { skip("shader"); return; }
      const rgb = [mat.color?.r ?? 0.6, mat.color?.g ?? 0.6, mat.color?.b ?? 0.6];
      if (mat.map) { const t = meanOf(mat.map); for (let c = 0; c < 3; c++) rgb[c] *= t[c]; }
      const g = o.geometry, P = g.attributes.position;
      if (!P) { skip("no-position"); return; }
      const vColor = !!mat.vertexColors && !!g.attributes.color;
      const mw = o.matrixWorld.elements;
      const vAll = P.count, iAll = g.index ? Math.min(g.index.count, g.drawRange.count) : 0;
      if (o.isBatchedMesh) {
        const info = o._instanceInfo ?? [];
        for (let i = 0; i < info.length; i++) {
          if (!info[i].active || !o.getVisibleAt!(i)) continue;
          const gr = o.getGeometryRangeAt!(o.getGeometryIdAt!(i));
          const md = o._matricesTexture!.image.data;
          for (let k = 0; k < 16; k++) im16.elements[k] = md[i * 16 + k];
          const irgb = rgb.slice();
          const cd = o._colorsTexture?.image.data;
          if (cd) { irgb[0] *= cd[i * 4]; irgb[1] *= cd[i * 4 + 1]; irgb[2] *= cd[i * 4 + 2]; }
          add(g, mul(mw, im16.elements, tmp.slice()), irgb, vColor, gr.vertexStart, gr.vertexCount, gr.indexStart, gr.indexCount);
        }
        return;
      }
      if (o.isInstancedMesh) {
        const n = o.count ?? 0, arr = o.instanceMatrix!.array, ic = o.instanceColor?.array;
        for (let i = 0; i < n; i++) {
          const irgb = ic ? [rgb[0] * ic[i * 3], rgb[1] * ic[i * 3 + 1], rgb[2] * ic[i * 3 + 2]] : rgb;
          add(g, mul(mw, Array.prototype.slice.call(arr, i * 16, i * 16 + 16), tmp.slice()), irgb, vColor, 0, vAll, 0, iAll);
        }
        return;
      }
      add(g, mw, rgb, vColor, 0, vAll, 0, iAll);
    };
    walk(r);
  }
  const srcTris = idx.length / 3, nv = pos.length / 3;
  if (!nv) return { pos: [], col: [], idx: [], tris: 0, srcTris: 0, cell: 0, skipped };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], pos[i * 3 + c]); hi[c] = Math.max(hi[c], pos[i * 3 + c]); }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  let cell = span / 512, out = { pos: [] as number[], col: [] as number[], idx: [] as number[] };
  for (;;) {
    const K = Math.ceil(span / cell) + 2, ids = new Map<number, number>(), map = new Int32Array(nv), sum: number[] = [], cnt: number[] = [];
    for (let i = 0; i < nv; i++) {
      const key = Math.floor((pos[i * 3] - lo[0]) / cell) + K * (Math.floor((pos[i * 3 + 1] - lo[1]) / cell) + K * Math.floor((pos[i * 3 + 2] - lo[2]) / cell));
      let j = ids.get(key);
      if (j === undefined) { j = cnt.length; ids.set(key, j); cnt.push(0); sum.push(0, 0, 0, 0, 0, 0); }
      map[i] = j; cnt[j]++;
      for (let c = 0; c < 3; c++) { sum[j * 6 + c] += pos[i * 3 + c]; sum[j * 6 + 3 + c] += col[i * 3 + c]; }
    }
    const seen = new Set<string>(), tri: number[] = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a0 = map[idx[t]], b0 = map[idx[t + 1]], c0 = map[idx[t + 2]];
      if (a0 === b0 || b0 === c0 || a0 === c0) continue;
      const k = [a0, b0, c0].sort((x, y) => x - y).join(",");
      if (seen.has(k)) continue;
      seen.add(k); tri.push(a0, b0, c0);
    }
    if (tri.length / 3 <= a.target) {
      const used = new Map<number, number>(), p: number[] = [], cl: number[] = [], ix: number[] = [];
      for (const v of tri) {
        let n = used.get(v);
        if (n === undefined) { n = used.size; used.set(v, n); for (let c = 0; c < 3; c++) { p.push(sum[v * 6 + c] / cnt[v]); cl.push(sum[v * 6 + 3 + c] / cnt[v]); } }
        ix.push(n);
      }
      out = { pos: p, col: cl, idx: ix };
      break;
    }
    cell *= 1.25;
  }
  return { ...out, tris: out.idx.length / 3, srcTris, cell, skipped };
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
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const t0 = Date.now();
  try {
    await page.goto(`${base}/?cam=${cam}&modules=atmos,terrain,poi:${id}&noocc&nohlod&texfree=0`);
    await page.waitForFunction((m) => { const k = (window as unknown as { __kr?: { ready?: boolean; modules?: string[]; engine?: { pendingHolds(): string[] } } }).__kr; return !!k?.ready && !!k.modules?.includes(m) && k.engine!.pendingHolds().length === 0; }, "poi:" + id, { timeout: BUILD_TIMEOUT_MS, polling: 1000 });
    const loadErrors = await page.evaluate(() => (window as unknown as { __kr: { errors?: unknown[] } }).__kr.errors ?? []);
    if (loadErrors.length) throw new Error("load errors " + JSON.stringify(loadErrors).slice(0, 400));
    await page.waitForTimeout(SETTLE_MS);
    const soup = await page.evaluate(extract, { id, target });
    if (!soup.tris) throw new Error("no geometry extracted " + JSON.stringify(soup.skipped));
    const bin = encode(soup);
    fs.writeFileSync(path.join(root, FAR_DIR, id + ".bin"), bin);
    index.pois[id] = { hash: poiSourceHash(root, id), tris: soup.tris, bytes: bin.length };
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
    console.log(`${id}: ${soup.srcTris} → ${soup.tris} tris (cell ${soup.cell.toFixed(2)} m), ${(bin.length / 1024).toFixed(0)} KB, ${Math.round((Date.now() - t0) / 1000)} s, skipped ${JSON.stringify(soup.skipped)}${errors.length ? " page errors: " + errors.join(" | ") : ""}`);
  } catch (e) {
    failed++;
    console.error(`${id}: FAILED ${String(e).slice(0, 300)}`);
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
