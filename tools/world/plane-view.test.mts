import assert from "node:assert/strict";
import * as THREE from "three";
import { POIS, type Poi } from "../../shared/world/map";
import { Phase } from "../../shared/sim/match";
import { PLANE_ALT, PLANE_CHORD_R } from "../../shared/sim/const";
import { PLANE_FOV } from "../../shared/sim/plane";
import type * as LowMem from "../../client/src/low-mem";

const g = globalThis as Record<string, unknown>;
g.location = { search: "?lowmem=1" };
g.__kr = { game: { inMatch: true, cm: { phase: Phase.Plane } } };

const PICK_WAIT_MS = 500, VIEW_CAP = 2, AHEAD_M = 600, LOOK_HALF_H_M = 150;
const CHASE_YAW_RAD = -0.62, CHASE_PITCH_RAD = -0.2, CHASE_BEHIND_M = [900, 300];
const streamed = POIS.filter((p) => p.id !== "lobby-islet");
let run = 0;

function planeCamera(heading: number, offM: number, lookAt: (from: THREE.Vector3) => THREE.Vector3) {
  const dx = Math.cos(heading), dz = Math.sin(heading);
  const cam = new THREE.PerspectiveCamera(PLANE_FOV, 16 / 9, 0.5, 2 * PLANE_CHORD_R + 2000);
  cam.position.set(-dz * offM - dx * AHEAD_M, PLANE_ALT, dx * offM - dz * AHEAD_M);
  cam.lookAt(lookAt(cam.position));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

function chaseCamera(heading: number, offM: number, behindM: number) {
  const dx = Math.cos(heading), dz = Math.sin(heading);
  const cam = new THREE.PerspectiveCamera(PLANE_FOV, 16 / 9, 0.5, 2 * PLANE_CHORD_R + 2000);
  cam.position.set(-dz * offM - dx * behindM, PLANE_ALT, dx * offM - dz * behindM);
  cam.quaternion.setFromEuler(new THREE.Euler(CHASE_PITCH_RAD, Math.atan2(-dx, -dz) + CHASE_YAW_RAD, 0, "YXZ"));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

function inView(cam: THREE.Camera, p: Poi) {
  const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  return f.intersectsSphere(new THREE.Sphere(new THREE.Vector3(p.x, (p.padY ?? 0) + LOOK_HALF_H_M, p.z), Math.hypot(p.r, LOOK_HALF_H_M)));
}

async function picks(cam: THREE.Camera, n: number) {
  const lowMem = (await import(`../../client/src/low-mem.ts?run=${run++}`)) as typeof LowMem;
  const pending = streamed.map((p) => `poi:${p.id}`), out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await Promise.race([lowMem.nextNearModule(pending, cam, POIS, 450, VIEW_CAP), new Promise<null>((r) => setTimeout(r, PICK_WAIT_MS, null))]);
    if (!id) break;
    out.push(id);
  }
  return out;
}

const island = () => new THREE.Vector3(0, 0, 0);
const seaward = (from: THREE.Vector3) => from.clone().multiplyScalar(2).setY(0);
let paths = 0, chased = 0, chasedSeeing = 0;
for (let k = 0; k < 8; k++) for (const off of [-380, 0, 380]) {
  const heading = (k * Math.PI) / 4, where = `heading ${k * 45}°, offset ${off} m`;
  const toIsland = planeCamera(heading, off, island);
  const seen = streamed.filter((p) => inView(toIsland, p)).map((p) => `poi:${p.id}`);
  assert.ok(seen.length > 0, `${where}: the island is in view from the plane`);
  const got = await picks(toIsland, VIEW_CAP + 1);
  assert.equal(got.length, Math.min(VIEW_CAP, seen.length), `${where}: the plane queues ${Math.min(VIEW_CAP, seen.length)} POIs in view (lowmemview), got ${got.join(", ") || "none"}`);
  for (const id of got) assert.ok(seen.includes(id), `${where}: ${id} was queued but is not in view`);
  const away = planeCamera(heading, off, seaward);
  const strays = (await picks(away, 1)).filter((id) => !streamed.some((p) => `poi:${p.id}` === id && inView(away, p)));
  assert.deepEqual(strays, [], `${where}: looking out to sea queues nothing out of view`);
  paths++;
  for (const behind of CHASE_BEHIND_M) {
    const chase = chaseCamera(heading, off, behind), at = `${where}, ${behind} m before the island, gameplay chase camera`;
    const inChase = streamed.filter((p) => inView(chase, p)).map((p) => `poi:${p.id}`);
    const queued = await picks(chase, VIEW_CAP + 1);
    assert.equal(queued.length, Math.min(VIEW_CAP, inChase.length), `${at}: queues ${Math.min(VIEW_CAP, inChase.length)} POIs in view, got ${queued.join(", ") || "none"}`);
    for (const id of queued) assert.ok(inChase.includes(id), `${at}: ${id} was queued but is not in view`);
    chased++;
    if (inChase.length) chasedSeeing++;
  }
}
assert.ok(chasedSeeing * 2 > chased, `the gameplay chase camera sees POIs on most paths (${chasedSeeing} of ${chased})`);
console.log(`plane view (lowmem): ${paths} flight paths aimed at the island and ${chased} chase-camera views (${chasedSeeing} seeing POIs) queue the POIs in view, at most ${VIEW_CAP}, and nothing out of view`);
process.exit(0);
