import type * as THREE from "three";
import { flag } from "../flags";

const GEO_SHARE = flag("geoshare");
const GEOFREE = flag("geofree");
const pools = new Map<string, Map<string, THREE.BufferAttribute[]>>();
/** ?geofree drops a pooled attribute's array after upload, so it is fingerprinted while it still has one: a later copy of
 * the same data (the match's plane after the lobby's) then still shares its GPU buffer */
const prints = new WeakMap<THREE.BufferAttribute, string>();

function fingerprint(a: THREE.TypedArray): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 0x01000193); h2 = Math.imul(h2 ^ b[i], 0x5bd1e995); }
  return `${a.constructor.name}:${a.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

function sameArray(a: THREE.TypedArray, b: THREE.TypedArray): boolean {
  if (a === b) return true;
  if (a.length !== b.length || a.constructor !== b.constructor) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function intern(pool: Map<string, THREE.BufferAttribute[]>, a: THREE.BufferAttribute): THREE.BufferAttribute {
  const key = `${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.length}`;
  let seen = pool.get(key);
  if (!seen) pool.set(key, (seen = []));
  let print: string | undefined;
  const same = seen.find((s) => s.array ? sameArray(s.array, a.array) : prints.get(s) === (print ??= fingerprint(a.array)));
  if (same) return same;
  seen.push(a);
  if (GEOFREE) prints.set(a, print ?? fingerprint(a.array));
  return a;
}

export function shareAttributes(poolId: string, g: THREE.BufferGeometry): void {
  if (!GEO_SHARE) return;
  let pool = pools.get(poolId);
  if (!pool) pools.set(poolId, (pool = new Map()));
  // (the bounds first, from this geometry's own arrays: an attribute swapped in may already be released)
  if (GEOFREE) { if (!g.boundingBox) g.computeBoundingBox(); if (!g.boundingSphere) g.computeBoundingSphere(); }
  for (const [name, a] of Object.entries(g.attributes)) {
    if (!(a as THREE.BufferAttribute).isBufferAttribute) continue;
    const s = intern(pool, a as THREE.BufferAttribute);
    if (s !== a) g.setAttribute(name, s);
  }
  if (g.index) {
    const s = intern(pool, g.index);
    if (s !== g.index) g.setIndex(s);
  }
}

export function shareGeometries(poolId: string, root: THREE.Object3D): void {
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g?.isBufferGeometry) shareAttributes(poolId, g);
  });
}
