import type * as THREE from "three";
import { flag } from "../flags";
import { unrestorable } from "./res/restore";

const ENABLED = flag("geofree");

function dropArray(this: THREE.BufferAttribute): void {
  (this as unknown as { array: null }).array = null;
}

export function releaseBatchAfterUpload(bm: THREE.BatchedMesh): void {
  if (!ENABLED) return;
  const g = bm.geometry;
  if (bm.boundingSphere) g.boundingSphere = bm.boundingSphere.clone();
  if (bm.boundingBox) g.boundingBox = bm.boundingBox.clone();
  for (const a of Object.values(g.attributes)) if ((a as THREE.BufferAttribute).isBufferAttribute) (a as THREE.BufferAttribute).onUpload(dropArray);
  g.addEventListener("dispose", unrestorable());
}
