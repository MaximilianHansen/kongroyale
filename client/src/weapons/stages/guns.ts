// gear-03-weapons: the six banana guns on the white studio sheet (+ single-gun dev views wpn-gun-<id>).
// Each gun is posed (yaw / tilt / pitch read off the target art) and then FITTED to the target art's measured on-screen box
// (gear-03-weapons blob boxes mapped into the 16:9 frame the compare sheet uses: art y 630…2250 ↔ 0…1).
import * as THREE from "three";
import type { WorldCtx } from "../../engine/engine";
import type { WeaponId } from "../../../../shared/world/map";
import { gunInstance, GUN_ORDER } from "../guns/index";
import { fitToBox, squareBox, stageCam, type StageDef, type StageFile } from "../studio";

export const SHEET_BOX: Record<WeaponId, [number, number, number, number]> = {
  pistol: squareBox(48, 660, 668, 1240), smg: squareBox(736, 656, 1528, 1232), ar: squareBox(1588, 640, 2852, 1236),
  shotgun: squareBox(32, 1708, 772, 2136), sniper: squareBox(764, 1624, 1860, 2156), rocket: squareBox(1792, 1604, 2852, 2208),
  bow: squareBox(764, 1624, 1860, 2156), minigun: squareBox(1792, 1604, 2852, 2208),
};
/** yaw (muzzle toward camera), tilt (top toward camera), pitch (muzzle up) per gun, read off the target art */
// the shotgun + rocket side-on (the rocket read short: L/D ≈ 3.5 on screen with BANANA CO. + the
// emblem facing the camera; the shotgun's barrels + side show), the sniper nearly side-on like the target art
const POSE: Record<WeaponId, [number, number, number]> = {
  pistol: [0.36, 0.42, 0.04], smg: [0.42, 0.3, 0.04], ar: [0.16, 0.16, 0.16],
  shotgun: [0.55, 0.2, 0.1], sniper: [0.36, 0.14, 0.06], rocket: [0.1, 0.2, 0.03],
  bow: [0.22, 0.18, 0.04], minigun: [0.18, 0.2, 0.04],
};

/** product-shot pose: muzzle → −X (left), turned toward the camera by `yaw`, top rolled toward the camera by `tilt`,
 *  muzzle raised by `pitch` */
function poseGun(root: THREE.Object3D, x: number, y: number, z: number, yaw: number, tilt: number, pitch = 0) {
  root.position.set(x, y, z);
  root.rotation.set(0, Math.PI / 2 + yaw, 0, "YXZ");
  root.rotateX(pitch);
  root.rotateZ(tilt);
}

function stageGun(ctx: WorldCtx, root: THREE.Group, id: WeaponId, box: [number, number, number, number]): THREE.Group {
  const g = gunInstance(id);
  // the rarity accent gem is a gameplay tint (the kit colours it per rarity) — not part of the product sheet
  if (g.pivots.accent) g.pivots.accent.visible = false;
  const bb = new THREE.Box3().setFromObject(g.root); const c = bb.getCenter(new THREE.Vector3());
  const holder = new THREE.Group(); holder.name = `sheet:${id}`;
  g.root.position.copy(c).negate();
  holder.add(g.root);
  const [yaw, tilt, pitch] = POSE[id];
  poseGun(holder, 0, 1.0, 0, yaw, tilt, pitch);
  holder.traverse((o) => { o.userData.receiveShadow = false; if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).receiveShadow = false; });
  root.add(holder);
  ctx.camera.updateMatrixWorld(true);
  fitToBox(holder, ctx.camera, box);
  return holder;
}

/** one look: the stage shows the real in-game PBR guns under the studio key — no toon / outline pass */
const finish = (_root: THREE.Group) => { /* nothing */ };

const stages: Record<string, StageDef> = {
  weapons: { origin: "studio", build(ctx, root) { for (const id of GUN_ORDER) stageGun(ctx, root, id, SHEET_BOX[id]); finish(root); } },
};
for (const id of GUN_ORDER) {
  stages[`gun-${id}`] = {
    origin: "studio",
    build(ctx, root) {
      const [u0, v0, u1, v1] = SHEET_BOX[id];
      const w = u1 - u0, h = v1 - v0;
      const k = Math.min(0.9 / w, 0.86 / h);
      stageGun(ctx, root, id, [0.5 - (w * k) / 2, 0.5 - (h * k) / 2, 0.5 + (w * k) / 2, 0.5 + (h * k) / 2]);
      finish(root);
    },
  };
}

/** a 22° lens from ~4.6 m (×8 studio scale): the 8° long lens made the post pipeline's world-space AO kernel span
 *  huge screen areas (28 ms frames); at 22° the frame is ~7 ms and the edge guns are only ~11° off-axis */
const FOV = 22, DIST = 1.79 / (2 * Math.tan((FOV / 2) * Math.PI / 180));
const CAM: [number, number, number] = [0, 1.0 + DIST * (0.45 / 3.876), DIST * (3.85 / 3.876)];

const file: StageFile = {
  stages,
  views: {
    "gear-03-weapons": stageCam(CAM, [0, 1.0, 0], FOV, "weapons"),
    ...Object.fromEntries(GUN_ORDER.map((id) => [`wpn-gun-${id}`, stageCam(CAM, [0, 1.0, 0], FOV, `gun-${id}`)])),
  },
};
export default file;
