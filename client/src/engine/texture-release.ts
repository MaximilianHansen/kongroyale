import type * as THREE from "three";
import { flag } from "../flags";
import { onRestore, unrestorable } from "./res/restore";

type Pixels = { data?: ArrayBufferView | null; width: number; height: number; depth?: number };
type Source = THREE.Texture["source"]["data"];
/** A released texture source that low-mem.ts can empty and fill again: `rebuild` fetches its pixels (the first one
 *  registered wins, since shareTexture clones share the source and their rebuild only reads the parent's data back) and
 *  `arm` is releaseAfterUpload, handed over here so the lazy low-mem chunk needn't import this boot module. */
export type Rebuildable = THREE.Texture["source"] & { rebuild?: () => Source | Promise<Source>; arm?: typeof releaseAfterUpload };

const ENABLED = flag("texfree");

export function releaseAfterUpload<T extends THREE.Texture>(t: T, rebuild?: () => Source | Promise<Source>): T {
  if (!ENABLED) return t;
  t.onUpdate = dropSource;
  const done = rebuild
    ? ((Object.assign(t.source, { arm: releaseAfterUpload }) as Rebuildable).rebuild ??= rebuild, onRestore("source", async () => { t.source.data = await rebuild(); t.onUpdate = dropSource; t.needsUpdate = true; }))
    : unrestorable();
  t.addEventListener("dispose", done);
  return t;
}

export function shareTexture<T extends THREE.Texture>(t: T): T {
  const version = t.source.version;
  const c = releaseAfterUpload(t.clone() as T, () => t.source.data);
  c.source.version = version;
  return c;
}

function dropSource(t: THREE.Texture) {
  const px = t.source.data as Pixels | null;
  if (!px || px.data === null) return;
  t.onUpdate = null;
  t.source.data = { width: px.width, height: px.height, depth: px.depth, data: null };
  for (const m of t.mipmaps as { data: { byteLength: number } }[]) m.data = { byteLength: m.data.byteLength };
  if (px.data === undefined) freeImage(px);
}

export function freeImage(img: unknown) {
  if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
  else if ((typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement) || (typeof OffscreenCanvas !== "undefined" && img instanceof OffscreenCanvas)) img.width = img.height = 1;
}
