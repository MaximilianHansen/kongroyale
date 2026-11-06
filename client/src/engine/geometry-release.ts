// GEOMETRY RELEASE — static town-kit batches (one BatchedMesh per material, never edited after the build) drop each
// vertex attribute's CPU array once three has uploaded it (?geofree; on by default on low-memory devices,
// low-mem-device.ts). The index stays: BatchedMesh.onBeforeRender reads it when an instance's visibility changes.
// Whatever reads a released array afterwards (a Raycaster against the batch) finds null; the resource ledger counts the
// bytes still held on the GPU from `releasedBytes`.
import type * as THREE from "three";
import { flag } from "../flags";
import { lowMemSaver } from "../low-mem-device";

const ENABLED = lowMemSaver(flag("geofree"));

function dropArray(this: THREE.BufferAttribute): void {
  (this as unknown as { releasedBytes: number }).releasedBytes = this.array.byteLength;
  (this as unknown as { array: null }).array = null;
}

export function releaseBatchAfterUpload(bm: THREE.BatchedMesh): void {
  if (!ENABLED) return;
  const g = bm.geometry;
  if (bm.boundingSphere) g.boundingSphere = bm.boundingSphere.clone();
  if (bm.boundingBox) g.boundingBox = bm.boundingBox.clone();
  for (const a of Object.values(g.attributes)) if ((a as THREE.BufferAttribute).isBufferAttribute) (a as THREE.BufferAttribute).onUpload(dropArray);
}
