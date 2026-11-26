// Bamboo Explosive Bow "BAMBOO BOW" — tropical recurve bow carved from knotted green/gold bamboo limbs with lime
// rope lashings, wooden riser grip, taut cream bowstring, and a notched bamboo arrow tipped with a glowing orange-red
// explosive coconut warhead (the "rocket" pivot, hidden right after firing until nocked again during reload).
import * as THREE from "three";
import { filletCyl, lathe, ringGeo, rbox, tf, alignY } from "../lib/geo";
import { PartBuilder } from "../lib/builder";
import { C } from "../lib/mats";
import { ropeWrap, FWD } from "./common";
import type { GunSpec } from "./types";

const BAMBOO = "#7ea832";
const BAMBOO_LIGHT = "#b5cf52";
const BAMBOO_NODE = "#4f6b1e";
const STRING_COL = "#f2e7c9";
const BLAST_RED = "#ff4e26";

export function buildBow(): GunSpec {
  const b = new PartBuilder();
  const Y = 0.04;
  // ---- carved wooden riser (vertical central handle, tilted slightly forward for an organic recurve profile)
  const riser = filletCyl(0.022, 0.22, 0.008, 20);
  b.addGradient(riser, C.brownDark, C.brown, "y", "matte", tf([0, Y, -0.14], [0.06, 0, 0]));
  // leather grip wrap & arrow rest shelf
  ropeWrap(b, [0, Y - 0.02, -0.14], [0, 1, 0], 0.024, 5, 0.0055, C.brownLight, 1.04);
  b.add(rbox(0.036, 0.014, 0.05, 0.004, 2), C.brownDark, "matte", tf([-0.012, Y + 0.062, -0.14]));
  // sight pin frame (lime-tipped bamboo aiming hoop on the left side of the riser)
  b.add(ringGeo(0.02, 0.015, 0.008, 0.002, 24), C.brownDark, "matte", tf([-0.024, Y + 0.095, -0.165], [Math.PI / 2, 0, 0]));
  b.add(new THREE.SphereGeometry(0.0042, 10, 8), "#a6ff3a", "gloss", tf([-0.024, Y + 0.095, -0.165]));

  // ---- upper & lower recurve bamboo limbs (curving back toward the archer, then sweeping forward at the tips)
  const tipPos: THREE.Vector3[] = [];
  for (const sy of [1, -1]) {
    const pts = [
      new THREE.Vector3(0, Y + sy * 0.095, -0.14),
      new THREE.Vector3(0, Y + sy * 0.22, -0.115),
      new THREE.Vector3(0, Y + sy * 0.36, -0.04),
      new THREE.Vector3(0, Y + sy * 0.46, 0.045),
      new THREE.Vector3(0, Y + sy * 0.51, 0.015),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    const limb = new THREE.TubeGeometry(curve, 28, 0.017, 12, false);
    // taper the bamboo limb smoothly toward the tip
    const pos = limb.attributes.position as THREE.BufferAttribute;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const ring = Math.floor(i / 13);
      const u = ring / 28;
      const c = curve.getPointAt(u);
      const scale = 1 - u * 0.48;
      tmp.fromBufferAttribute(pos, i).sub(c).multiplyScalar(scale).add(c);
      pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
    }
    limb.computeVertexNormals();
    b.addGradient(limb, BAMBOO, BAMBOO_LIGHT, "y", "gloss");
    // bamboo joint rings + tropical lime lashings along each limb
    for (const u of [0.22, 0.52, 0.8]) {
      const c = curve.getPointAt(u);
      const tan = curve.getTangentAt(u);
      const r = 0.017 * (1 - u * 0.45);
      b.add(ringGeo(r * 1.24, r * 0.92, 0.012, 0.003, 18), BAMBOO_NODE, "matte", alignY(c, tan));
    }
    const lashC = curve.getPointAt(0.08), lashT = curve.getTangentAt(0.08);
    b.add(ringGeo(0.022, 0.015, 0.026, 0.004, 18), C.limeDark, "matte", alignY(lashC, lashT));
    // limb tip cap
    const tip = pts[pts.length - 1];
    b.add(new THREE.SphereGeometry(0.011, 10, 8), C.brownDark, "matte", tf([tip.x, tip.y, tip.z]));
    tipPos.push(tip);
  }

  // ---- taut bowstring (upper tip → nock point → lower tip)
  const nock = new THREE.Vector3(0, Y + 0.072, 0.14);
  const strCurve = new THREE.CatmullRomCurve3([tipPos[0], nock, tipPos[1]]);
  b.add(new THREE.TubeGeometry(strCurve, 14, 0.0032, 6, false), STRING_COL, "matte");

  // ---- rarity accent band on the riser
  const acc = b.sub("accent", [0, Y + 0.06, -0.14]);
  acc.add(ringGeo(0.0255, 0.019, 0.02, 0.003, 20), C.banana, "gloss", tf([0, Y + 0.06, -0.14]));

  // ---- notched explosive bamboo arrow ("rocket" pivot so viewmodel hides it after firing until reload!)
  const arrow = b.sub("rocket", [0, Y + 0.072, -0.15]);
  const ay = Y + 0.072;
  // bamboo shaft running from nock (+0.14) through the riser (-0.14) to tip (-0.48)
  const shaft = filletCyl(0.0068, 0.58, 0.002, 12);
  arrow.addGradient(shaft, BAMBOO_LIGHT, BAMBOO, "y", "gloss", tf([0, ay, -0.15], [Math.PI / 2, 0, 0]));
  // three vivid lime/yellow tropical feather fletchings at the tail
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const fin = rbox(0.003, 0.024, 0.085, 0.001, 1);
    const m = new THREE.Matrix4().makeTranslation(0, 0.016, 0).premultiply(new THREE.Matrix4().makeRotationZ(a)).premultiply(new THREE.Matrix4().makeTranslation(0, ay, 0.085));
    arrow.add(fin, i === 0 ? C.banana : C.lime, "matte", m);
  }
  // glowing explosive mini-bomb arrowhead (compact crimson/gold charge at the tip)
  const tipGeo = lathe([[0.006, 0], [0.022, 0.018], [0.024, 0.055], [0.015, 0.088], [0.001, 0.112]], 18);
  arrow.addGradient(tipGeo, BLAST_RED, C.banana, "y", "gloss", tf([0, ay, -0.43], [-Math.PI / 2, 0, 0]));
  arrow.add(ringGeo(0.025, 0.016, 0.012, 0.002, 18), C.brownDark, "matte", tf([0, ay, -0.435], [Math.PI / 2, 0, 0]));

  const built = b.build({ name: "bow" });
  return {
    ...built,
    id: "bow",
    muzzle: new THREE.Vector3(0, ay, -0.54),
    length: 0.72,
    gripAnchor: new THREE.Vector3(0, Y - 0.02, -0.14),
    foreAnchor: new THREE.Vector3(0, ay, 0.12),
    sightY: ay + 0.025,
    fwd: FWD,
  };
}
