import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POIS } from "../../shared/world/map";
import { FAR_DIR, FAR_INDEX, binHash, poiSourceHash, type FarIndex } from "./far-hash.mts";

const HEADER_B = 40;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const index = JSON.parse(fs.readFileSync(path.join(root, FAR_INDEX), "utf8")) as FarIndex;
const stale: string[] = [], missing: string[] = [], broken: string[] = [];
for (const id of POIS.map((p) => p.id).filter((id) => id !== "lobby-islet")) {
  const e = index.pois[id], file = path.join(root, FAR_DIR, id + ".bin");
  if (!e || !fs.existsSync(file)) { missing.push(id); continue; }
  const buf = fs.readFileSync(file);
  const n = buf.length >= HEADER_B ? buf.readUInt32LE(8) : 0, ni = buf.length >= HEADER_B ? buf.readUInt32LE(12) : 0;
  const want = HEADER_B + Math.ceil((n * 6) / 4) * 4 + n * 4 + ni * (n > 65535 ? 4 : 2);
  if (buf.length !== e.bytes || binHash(buf) !== e.bin || buf.toString("ascii", 0, 4) !== "KRFI" || buf.length !== want || ni !== e.tris * 3) broken.push(id);
  else if (poiSourceHash(root, id) !== e.hash) stale.push(id);
}
const n = Object.keys(index.pois).length;
for (const id of broken) console.error(`far impostor ${id}: ${FAR_DIR}/${id}.bin does not match its header or its index entry (size, hash, triangles)`);
for (const id of missing) console.error(`far impostor ${id}: not baked (${FAR_DIR}/${id}.bin or its index entry is missing)`);
for (const id of stale) console.log(`far impostor ${id}: its POI sources, the POI kit or the bake tool changed since the bake`);
if (stale.length || missing.length || broken.length) console.log(`rebake on a running prod build: npx tsx tools/world/bake-far.mts --only ${[...stale, ...missing, ...broken].join(",")}`);
// lowmem draws these files by default, so a missing or damaged one fails. A stale one is reported only: it still draws
// the POI as it was at the bake, and any POI edit would otherwise need a full rebake on a prod server first.
console.log(`far impostors: ${n} baked, ${stale.length} stale, ${missing.length} not baked, ${broken.length} damaged`);
process.exit(broken.length || missing.length ? 1 : 0);
