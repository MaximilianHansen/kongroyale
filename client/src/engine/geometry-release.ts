// By default (?geofree=0 turns it off), drops the CPU copy of vertex and index arrays once three.js has uploaded them, the geometry half of
// releasing CPU copies after upload (texture-release.ts is the texture half). A geometry that can rebuild its arrays refills them
// in a context restore's `source` phase, before the first draw on the new context; one that can't (a town-kit batch)
// marks itself unrestorable, so the restore rebuilds its module or reloads the page.
import type * as THREE from "three";
import { flag } from "../flags";
import { onRestore, unrestorable } from "./res/restore";

const ENABLED = flag("geofree");

function dropArray(this: THREE.BufferAttribute): void {
  const a = this as unknown as { array: THREE.TypedArray | null; releasedBytes?: number };
  a.releasedBytes = a.array!.byteLength;
  a.array = null;
}

export function releaseBatchAfterUpload(bm: THREE.BatchedMesh): void {
  if (!ENABLED) return;
  const g = bm.geometry;
  if (bm.boundingSphere) g.boundingSphere = bm.boundingSphere.clone();
  if (bm.boundingBox) g.boundingBox = bm.boundingBox.clone();
  for (const a of Object.values(g.attributes)) if ((a as THREE.BufferAttribute).isBufferAttribute) (a as THREE.BufferAttribute).onUpload(dropArray);
  g.addEventListener("dispose", unrestorable());
}

/** Drops `g`'s attribute and index arrays after upload. `rebuild` returns fresh arrays by attribute name (`index` for the
 * index), the same lengths as the originals; a restore uploads them and drops them again. Bounds are computed first. */
export function releaseGeometryAfterUpload(g: THREE.BufferGeometry, rebuild: () => Record<string, THREE.TypedArray>): void {
  if (!ENABLED) return;
  if (!g.boundingBox) g.computeBoundingBox();
  if (!g.boundingSphere) g.computeBoundingSphere();
  const arm = () => { for (const a of [...Object.values(g.attributes), g.index]) if (a && (a as THREE.BufferAttribute).isBufferAttribute) (a as THREE.BufferAttribute).onUpload(dropArray); };
  arm();
  g.addEventListener("dispose", onRestore("source", () => {
    const arrays = rebuild();
    for (const [name, array] of Object.entries(arrays)) {
      const a = (name === "index" ? g.index : g.attributes[name]) as THREE.BufferAttribute | null;
      if (!a) continue;
      a.array = array;
      a.needsUpdate = true;
    }
    arm();
  }));
}
