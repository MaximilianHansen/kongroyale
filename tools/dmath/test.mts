// shared/sim/dmath.ts gives the same bits on every platform: each function against vectors.json, recorded from V8's
// fdlibm built without fused multiply-add (Node on linux-x64), including the large-argument and special-value paths.
//   npx tsx tools/dmath/test.mts
import fs from "node:fs";
import * as dmath from "../../shared/sim/dmath";

type Fn = (...a: number[]) => number;
const FNS: Record<string, Fn> = { sin: dmath.sin, cos: dmath.cos, tan: dmath.tan, asin: dmath.asin, acos: dmath.acos, atan: dmath.atan, exp: dmath.exp, atan2: dmath.atan2, pow: dmath.pow, hypot: dmath.hypot, hypot3: dmath.hypot3 };
const vectors = JSON.parse(fs.readFileSync(new URL("./vectors.json", import.meta.url), "utf8")) as Record<string, string[][] | string>;
const dv = new DataView(new ArrayBuffer(8));
const num = (h: string) => { dv.setBigUint64(0, BigInt("0x" + h)); return dv.getFloat64(0); };
const hex = (v: number) => { dv.setFloat64(0, v); return dv.getBigUint64(0).toString(16).padStart(16, "0"); };
const sameNaN = (a: string, b: string) => Number.isNaN(num(a)) && Number.isNaN(num(b));

const fails: string[] = [];
let total = 0;
for (const [name, fn] of Object.entries(FNS)) {
  const rows = vectors[name];
  if (!Array.isArray(rows) || rows.length === 0) { fails.push(`${name}: no vectors in vectors.json`); continue; }
  for (const row of rows) {
    const args = row.slice(0, -1).map(num), want = row[row.length - 1], got = hex(fn(...args));
    total++;
    if (got !== want && !sameNaN(got, want)) fails.push(`${name}(${args.join(", ")}) = ${num(got)} (${got}), want ${num(want)} (${want})`);
  }
}
console.log(`dmath: ${total} vectors from ${vectors.source}`);
if (fails.length) {
  console.error(`DMATH FAILED: ${fails.length} result(s) differ\n  ` + fails.slice(0, 20).join("\n  "));
  process.exit(1);
}
console.log("DMATH PASSED: every result bit-identical");
