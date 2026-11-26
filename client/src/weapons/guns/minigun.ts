// Banana Shredder Rotary Minigun "BANANA SHREDDER" — heavy 6-barrel BANANA CO. gatling gun with a bright yellow
// motor shroud, top chainsaw carry handle, rear spade grip, underslung curved ammo drum ("mag" pivot), and a
// live spinning 6-barrel cluster ("barrels" pivot rotated by viewmodel.ts from Player.spinT!).
import * as THREE from "three";
import { filletCyl, ringGeo, tf } from "../lib/geo";
import { PartBuilder } from "../lib/builder";
import { C } from "../lib/mats";
import { block, fleshGrip, screw, FWD } from "./common";
import type { GunSpec } from "./types";

const STEEL = "#2c343e";
const STEEL_DARK = "#1a2028";
const BRASS = "#d9a932";

export function buildMinigun(): GunSpec {
  const b = new PartBuilder();
  const Y = 0.02;

  // ---- main yellow BANANA CO. motor housing (cylindrical + chamfered rear housing)
  const housing = filletCyl(0.088, 0.34, 0.016, 28);
  b.addGradient(housing, C.bananaDeep, C.banana, "y", "gloss", tf([0, Y, 0.04], [Math.PI / 2, 0, 0]));
  // dark metal front & rear housing collars + cooling vents
  b.add(ringGeo(0.095, 0.068, 0.036, 0.006, 28), STEEL_DARK, "matte", tf([0, Y, -0.12], [Math.PI / 2, 0, 0]));
  b.add(ringGeo(0.092, 0.052, 0.04, 0.008, 28), C.brownDark, "matte", tf([0, Y, 0.21], [Math.PI / 2, 0, 0]));
  for (const sx of [-1, 1]) {
    block(b, [sx * 0.086, Y + 0.01, 0.04], [0.018, 0.052, 0.2], STEEL, "matte", [0, 0, 0], 0.004);
    screw(b, [sx * 0.096, Y + 0.01, -0.02], [sx, 0, 0], 0.006);
    screw(b, [sx * 0.096, Y + 0.01, 0.1], [sx, 0, 0], 0.006);
  }
  // rarity accent band around the motor body
  const acc = b.sub("accent", [0, Y, 0.05]);
  acc.add(ringGeo(0.094, 0.084, 0.044, 0.004, 28), C.lime, "gloss", tf([0, Y, 0.05], [Math.PI / 2, 0, 0]));

  // ---- top chainsaw-style carry bar (foregrip)
  block(b, [0, Y + 0.135, -0.02], [0.028, 0.024, 0.28], C.brown, "matte", [0, 0, 0], 0.008);
  block(b, [0, Y + 0.098, -0.14], [0.03, 0.082, 0.03], STEEL_DARK, "matte", [0.18, 0, 0], 0.006);
  block(b, [0, Y + 0.098, 0.11], [0.03, 0.082, 0.03], STEEL_DARK, "matte", [-0.15, 0, 0], 0.006);
  // front aiming bead atop carry bar
  b.add(new THREE.SphereGeometry(0.009, 10, 8), C.banana, "gloss", tf([0, Y + 0.155, -0.14]));

  // ---- rear spade grip + trigger block
  block(b, [0, Y - 0.02, 0.26], [0.06, 0.065, 0.08], STEEL_DARK, "matte", [0, 0, 0], 0.01);
  fleshGrip(b, [0, Y - 0.065, 0.25], new THREE.Vector3(0, -1, 0.35).normalize(), 0.14, 0.032, { ribs: 5, back: true, cap: true, taper: 0.9, flat: 0.8 });

  // ---- underslung banana-yellow rotary ammo drum ("mag" pivot for reloads)
  const mag = b.sub("mag", [0, Y - 0.11, 0.02]);
  const drum = filletCyl(0.085, 0.16, 0.014, 24);
  mag.addGradient(drum, C.brownDark, C.brown, "y", "matte", tf([0, Y - 0.145, 0.02], [0, 0, Math.PI / 2]));
  mag.add(ringGeo(0.089, 0.072, 0.022, 0.004, 24), C.banana, "gloss", tf([0, Y - 0.145, 0.02], [0, 0, Math.PI / 2]));
  // brass ammo feed chute linking drum to receiver
  for (let k = 0; k < 5; k++) {
    mag.add(filletCyl(0.008, 0.044, 0.002, 10), BRASS, "gloss", tf([0.078, Y - 0.08 + k * 0.018, 0.02], [Math.PI / 2, 0, 0]));
  }

  // ---- 6-barrel rotating gatling assembly ("barrels" pivot centered on barrel axis [0, Y, -0.14])
  const barrels = b.sub("barrels", [0, Y, -0.14]);
  const bLen = 0.56;
  const bZ = -0.14 - bLen / 2;
  const ringR = 0.046;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const bx = Math.cos(a) * ringR, by = Y + Math.sin(a) * ringR;
    barrels.add(filletCyl(0.0135, bLen, 0.003, 12), STEEL, "matte", tf([bx, by, bZ], [Math.PI / 2, 0, 0]));
    // darkened bore tip
    barrels.add(ringGeo(0.014, 0.007, 0.018, 0.002, 12), STEEL_DARK, "matte", tf([bx, by, bZ - bLen / 2 + 0.004], [Math.PI / 2, 0, 0]));
  }
  // central drive shaft + two yellow BANANA CO. barrel clamp discs
  barrels.add(filletCyl(0.022, bLen - 0.04, 0.004, 16), STEEL_DARK, "matte", tf([0, Y, bZ + 0.01], [Math.PI / 2, 0, 0]));
  for (const cz of [-0.26, -0.52, -0.66]) {
    barrels.add(ringGeo(0.068, 0.022, 0.024, 0.005, 24), cz === -0.66 ? C.banana : STEEL_DARK, cz === -0.66 ? "gloss" : "matte", tf([0, Y, cz], [Math.PI / 2, 0, 0]));
  }

  const built = b.build({ name: "minigun" });
  return {
    ...built,
    id: "minigun",
    muzzle: new THREE.Vector3(0, Y, -0.74),
    length: 1.02,
    gripAnchor: new THREE.Vector3(0, Y - 0.11, 0.27),
    foreAnchor: new THREE.Vector3(0, Y + 0.135, -0.02),
    sightY: Y + 0.17,
    fwd: FWD,
  };
}
