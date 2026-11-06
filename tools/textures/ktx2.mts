// Bakes GPU-compressed .ktx2 copies of attributed POI textures for the dark ?ktx2=1 path in engine/assets.ts.
// Normal maps go to UASTC + zstd (plus an all-ETC1S .etc1s.ktx2 alternate for ?ktx2=etc1s) and everything else to ETC1S;
// public/assets/ktx2.json lists every converted source and which ones have an ETC1S alternate.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = [
  "npx tsx tools/textures/ktx2.mts <public/assets folder>... [--check]",
  "Encodes every attributed .webp/.jpg/.png in the folders to a .ktx2 next to it (same name, .ktx2), pre-flipped for flipY and with a full mip chain:",
  "normal maps (-n, _n) as UASTC + zstd, everything else (colour, ARM, roughness) as ETC1S (basis-lz), which downloads at about webp size,",
  "normal maps also get an ETC1S <name>.etc1s.ktx2 for the ?ktx2=etc1s comparison,",
  "and records the source paths in public/assets/ktx2.json, which the client reads behind ?ktx2.",
  "Needs KTX-Software 4.x (the ktx CLI, https://github.com/KhronosGroup/KTX-Software/releases) on PATH or in $KTX, and ffmpeg.",
  "Data maps (normal, -arm, _r, -r) are encoded linear, the rest sRGB. Unattributed sources are skipped so verify-assets stays green.",
  "--check fails when a listed .ktx2 is missing or older than its source.",
].join("\n");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = path.join(root, "public/assets/ktx2.json");
const KTX = process.env.KTX ?? "ktx";
const IMAGE = /\.(webp|jpe?g|png)$/i;
const DATA = /([-_](n|arm|r|nor|normal|rough))\.(webp|jpe?g|png)$/i;
const NORMAL = /[-_](n|nor|normal)\.(webp|jpe?g|png)$/i;
const UASTC_QUALITY = 2, ZSTD_LEVEL = 18, ETC1S_CLEVEL = 2, ETC1S_QLEVEL = 128;

const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) { console.log(USAGE); process.exit(args.length ? 0 : 1); }
const check = args.includes("--check");
const prev: { encoder?: string; sources: string[]; etc1s?: string[] } = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : { sources: [] };
const ktxOf = (rel: string) => rel.replace(IMAGE, ".ktx2");
const etc1sOf = (rel: string) => rel.replace(IMAGE, ".etc1s.ktx2");
const UASTC = ["--encode", "uastc", "--uastc-quality", String(UASTC_QUALITY), "--zstd", String(ZSTD_LEVEL)];
const ETC1S = ["--encode", "basis-lz", "--clevel", String(ETC1S_CLEVEL), "--qlevel", String(ETC1S_QLEVEL)];

if (check) {
  const stale = (s: string, out: string) => { const k = path.join(root, "public", out); return !fs.existsSync(k) || fs.statSync(k).mtimeMs < fs.statSync(path.join(root, "public", s)).mtimeMs; };
  const bad = [...prev.sources.filter((s) => stale(s, ktxOf(s))).map(ktxOf), ...(prev.etc1s ?? []).filter((s) => stale(s, etc1sOf(s))).map(etc1sOf)];
  for (const b of bad) console.error("stale or missing: " + b);
  process.exit(bad.length ? 1 : 0);
}

const unattributed = new Set<string>(JSON.parse(spawnSync("node", ["--import", "tsx", "tools/verify-assets.mts", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 }).stdout).unattributed);
const encoder = execFileSync(KTX, ["--version"], { encoding: "utf8" }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ktx2-"));
const sources = new Set(prev.sources), etc1s = new Set(prev.etc1s ?? []);
const skipped: string[] = [];

const files: string[] = [];
const walk = (d: string) => { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (IMAGE.test(f)) files.push(p); } };
for (const a of args) walk(path.resolve(root, a));

for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const pub = rel.replace(/^public\//, "");
  if (unattributed.has(rel)) { skipped.push(rel + " (unattributed)"); continue; }
  const twins = files.filter((f) => f !== file && ktxOf(f) === ktxOf(file));
  if (twins.length) { skipped.push(rel + " (another source maps to the same .ktx2)"); continue; }
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).trim().split(",").map(Number);
  if (w % 4 || h % 4) { skipped.push(rel + ` (${w}x${h} is not a multiple of 4)`); continue; }
  const png = path.join(tmp, "in.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", "vflip", "-pix_fmt", "rgba", png]);
  const data = DATA.test(file), normal = NORMAL.test(file);
  const encode = (codec: string[], out: string) => execFileSync(KTX, ["create", "--format", data ? "R8G8B8A8_UNORM" : "R8G8B8A8_SRGB", "--assign-tf", data ? "linear" : "srgb", ...codec, "--generate-mipmap", png, out]);
  encode(normal ? UASTC : ETC1S, ktxOf(file));
  sources.add(pub);
  if (normal) { encode(ETC1S, etc1sOf(file)); etc1s.add(pub); }
  console.log(`${rel} -> ${path.basename(ktxOf(file))} (${normal ? "UASTC" : "ETC1S"} ${data ? "linear" : "sRGB"}, ${(fs.statSync(file).size / 1024).toFixed(0)} -> ${(fs.statSync(ktxOf(file)).size / 1024).toFixed(0)} KiB)`);
}
fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(MANIFEST, JSON.stringify({ encoder: `${encoder}: normal maps UASTC quality ${UASTC_QUALITY} + zstd ${ZSTD_LEVEL}, the rest ETC1S clevel ${ETC1S_CLEVEL} qlevel ${ETC1S_QLEVEL}, generated mipmaps, flipped Y; etc1s lists normal maps that also have an ETC1S .etc1s.ktx2`, sources: [...sources].sort(), etc1s: [...etc1s].sort() }, null, 2) + "\n");
for (const s of skipped) console.warn("skipped " + s);
