import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FAR_DIR = "public/assets/far";
export const FAR_INDEX = path.join(FAR_DIR, "index.json");

export interface FarIndex { version: number; pois: Record<string, { hash: string; tris: number; bytes: number }> }

const SOURCE_ROOTS = ["client/src/world/pois/", "shared/pois/"];
const BAKE_TOOL = "tools/world/bake-far.mts";

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function resolveImport(root: string, from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(path.join(root, from)), spec);
  for (const f of [base, base + ".ts", path.join(base, "index.ts")]) if (fs.existsSync(f) && fs.statSync(f).isFile()) return path.relative(root, f).split(path.sep).join("/");
  return null;
}

export function poiSources(root: string, id: string): string[] {
  const own = files(path.join(root, "client/src/world/pois", id)).map((f) => path.relative(root, f).split(path.sep).join("/"));
  const seen = new Set<string>(), todo = [...own];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.(m?ts|js)$/.test(f)) continue;
    for (const m of fs.readFileSync(path.join(root, f), "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const dep = resolveImport(root, f, m[1]);
      if (dep && SOURCE_ROOTS.some((r) => dep.startsWith(r))) todo.push(dep);
    }
  }
  return [...seen, BAKE_TOOL].sort();
}

export function poiSourceHash(root: string, id: string): string {
  const h = crypto.createHash("sha256");
  for (const f of poiSources(root, id)) h.update(f + "\0").update(fs.readFileSync(path.join(root, f))).update("\0");
  const map = fs.readFileSync(path.join(root, "shared/world/map.ts"), "utf8").split("\n").find((l) => l.includes(`id: "${id}"`)) ?? "";
  return h.update(map.trim()).digest("hex").slice(0, 16);
}
