// Kong rig + procedural animation. A 16-bone rest skeleton (metres, character faces -Z, +X = its right hand side)
// and a pose system: locomotion cycles (idle / walk / run / sprint / crouch, strafe + backpedal), jump / fall / land,
// freefall (spread), glide (hanging under the peel), zipline, mantle, knee slide, aim pitch, fire recoil, reload (on the
// sim's per-weapon clock), hurt flinch, death, emotes. Planted feet (stance-foot locking + 2-bone leg IK + hip
// drop + ground snap) so no gait slides, and hands on every weapon by IK (tools/actors/anim-test.mts measures both).
// Everything is analytic + spring based so 50 kongs cost ~nothing and nothing ever drifts.
import * as THREE from "three";
import type { KongPose } from "./api";
import type { WeaponId } from "../../../shared/world/map";
import { WEAPON_DEFS } from "../../../shared/sim/const";
import { ZIP_HANG } from "../../../shared/pois/canopy-line";

export type BoneName = "hips" | "spine" | "chest" | "head" | "shoulderR" | "elbowR" | "wristR" | "shoulderL" | "elbowL" | "wristL" | "hipR" | "kneeR" | "ankleR" | "hipL" | "kneeL" | "ankleL";

export const BONES: Record<BoneName, { parent: BoneName | null; offset: [number, number, number] }> = {
  // proportions from the target art: ~2.0 m, hips 0.86, short legs, massive shoulders (1.1 m), head low in the shoulders
  hips: { parent: null, offset: [0, 0.86, 0] },
  spine: { parent: "hips", offset: [0, 0.14, 0] },
  chest: { parent: "spine", offset: [0, 0.20, 0] },
  head: { parent: "chest", offset: [0, 0.32, -0.14] },   // raised + forward out of the shoulder mane (profile reads from behind)
  shoulderR: { parent: "chest", offset: [0.36, 0.24, 0.02] },
  elbowR: { parent: "shoulderR", offset: [0.13, -0.38, 0.03] },
  wristR: { parent: "elbowR", offset: [0.03, -0.35, -0.03] },
  shoulderL: { parent: "chest", offset: [-0.36, 0.24, 0.02] },
  elbowL: { parent: "shoulderL", offset: [-0.13, -0.38, 0.03] },
  wristL: { parent: "elbowL", offset: [-0.03, -0.35, -0.03] },
  hipR: { parent: "hips", offset: [0.185, -0.07, 0] },
  kneeR: { parent: "hipR", offset: [0.02, -0.35, -0.02] },
  ankleR: { parent: "kneeR", offset: [0, -0.29, 0.02] },
  hipL: { parent: "hips", offset: [-0.185, -0.07, 0] },
  kneeL: { parent: "hipL", offset: [-0.02, -0.35, -0.02] },
  ankleL: { parent: "kneeL", offset: [0, -0.29, 0.02] },
};
export const BONE_LIST = Object.keys(BONES) as BoneName[];
export const NB = BONE_LIST.length;
const BI: Record<BoneName, number> = Object.fromEntries(BONE_LIST.map((b, i) => [b, i])) as Record<BoneName, number>;
const PARENT = BONE_LIST.map((b) => (BONES[b].parent ? BI[BONES[b].parent!] : -1));
const OFFSET = BONE_LIST.map((b) => new THREE.Vector3(...BONES[b].offset));

/** pose = per-bone euler XYZ (rad) + hips offset (m) + root pitch/roll (rad) */
const P_HIPS = NB * 3, P_ROOT = NB * 3 + 3, POSE_LEN = NB * 3 + 5;
export type Pose = Float32Array;
export const newPose = (): Pose => new Float32Array(POSE_LEN);
const R = (p: Pose, b: BoneName, x: number, y = 0, z = 0) => { const i = BI[b] * 3; p[i] += x; p[i + 1] += y; p[i + 2] += z; };
const H = (p: Pose, x: number, y: number, z: number) => { p[P_HIPS] += x; p[P_HIPS + 1] += y; p[P_HIPS + 2] += z; };
const ROOT = (p: Pose, pitch: number, roll = 0) => { p[P_ROOT] += pitch; p[P_ROOT + 1] += roll; };
/** mirrored symmetric write: same rx, opposite ry/rz on the L bone */
const RS = (p: Pose, base: "shoulder" | "elbow" | "wrist" | "hip" | "knee" | "ankle", x: number, y = 0, z = 0) => { R(p, `${base}R` as BoneName, x, y, z); R(p, `${base}L` as BoneName, x, -y, -z); };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const sm = (x: number) => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const PI = Math.PI;

// ------------------------------------------------------------------------------------------- pose generators
// Each writes ADDITIVELY into `p` scaled by `w` (so blending = calling several with weights).
function stance(p: Pose, w: number) {
  // hunched gorilla stance: knees soft, spine forward, arms hang slightly forward, elbows out
  R(p, "spine", 0.12 * w); R(p, "chest", 0.08 * w); R(p, "head", -0.18 * w);
  RS(p, "shoulder", 0.26 * w, 0.1 * w, -0.2 * w); RS(p, "elbow", 0.55 * w, 0, 0.1 * w); RS(p, "wrist", -0.15 * w);
  RS(p, "hip", -0.08 * w, 0, -0.06 * w); RS(p, "knee", -0.18 * w); RS(p, "ankle", 0.10 * w);
}
function idle(p: Pose, w: number, t: number) {
  stance(p, w);
  const br = Math.sin(t * 1.6);
  R(p, "chest", 0.03 * br * w); R(p, "head", 0.02 * Math.sin(t * 0.7) * w, 0.06 * Math.sin(t * 0.45) * w);
  RS(p, "shoulder", 0.02 * br * w, 0, -0.03 * br * w);
  H(p, 0, 0.008 * br * w, 0);
}
/** leg + arm cycle, ph in rad; amp scales the gait */
function gait(p: Pose, w: number, ph: number, kind: "walk" | "run") {
  const run = kind === "run";
  const s = Math.sin(ph), c = Math.cos(ph);
  const hipA = run ? 0.95 : 0.62, kneeA = run ? 1.45 : 0.95, armA = run ? 0.9 : 0.5, bob = run ? 0.06 : 0.028;
  // right leg: swing forward at s>0; knee bends during the swing (lift) and slightly on contact
  const swingR = s, swingL = -s;
  const kneeR = Math.max(0, Math.sin(ph + 0.9)) * kneeA + 0.12, kneeL = Math.max(0, Math.sin(ph + PI + 0.9)) * kneeA + 0.12;
  R(p, "hipR", swingR * hipA * w, 0, -0.05 * w); R(p, "hipL", swingL * hipA * w, 0, 0.05 * w);
  R(p, "kneeR", -kneeR * w); R(p, "kneeL", -kneeL * w);
  R(p, "ankleR", (0.35 * kneeR - 0.25 * Math.max(0, -swingR)) * w); R(p, "ankleL", (0.35 * kneeL - 0.25 * Math.max(0, -swingL)) * w);
  // arms opposite, elbows pumped when running
  R(p, "shoulderR", (-swingR * armA + (run ? 0.35 : 0.15)) * w, 0, (run ? -0.25 : -0.12) * w); R(p, "shoulderL", (-swingL * armA + (run ? 0.35 : 0.15)) * w, 0, (run ? 0.25 : 0.12) * w);
  R(p, "elbowR", (run ? 1.3 : 0.45 + 0.2 * Math.max(0, -swingR)) * w); R(p, "elbowL", (run ? 1.3 : 0.45 + 0.2 * Math.max(0, -swingL)) * w);
  // torso: lean, counter-rotation, bob (2 per cycle)
  R(p, "spine", (run ? 0.42 : 0.16) * w, -0.10 * s * w, 0.04 * c * w); R(p, "chest", (run ? 0.08 : 0.04) * w, -0.06 * s * w);
  R(p, "head", (run ? -0.45 : -0.20) * w, 0.05 * s * w);
  R(p, "hips", 0, 0.10 * s * w, -0.05 * c * w);
  H(p, 0, (-bob * 0.5 + bob * 0.5 * Math.cos(2 * ph) + (run ? 0.03 : 0)) * w, 0);
}
function crouch(p: Pose, w: number, t: number) {
  R(p, "spine", 0.22 * w); R(p, "chest", 0.06 * w); R(p, "head", -0.34 * w);
  RS(p, "hip", 0.80 * w, 0, -0.28 * w); RS(p, "knee", -1.45 * w); RS(p, "ankle", 0.50 * w);
  RS(p, "shoulder", 0.25 * w, 0, -0.10 * w); RS(p, "elbow", 0.55 * w);
  H(p, 0, -0.30 * w, 0.02 * w);
  H(p, 0, 0.006 * Math.sin(t * 1.9) * w, 0);
}
function crouchGait(p: Pose, w: number, ph: number) {
  // wide prowling lunge: the leading leg plants bent, the trailing leg extends back with the heel up (sole shows)
  const s = Math.sin(ph), fR = Math.max(0, s), bR = Math.max(0, -s);
  R(p, "hipR", 0.72 * s * w); R(p, "hipL", -0.72 * s * w);
  R(p, "kneeR", (0.95 * bR - 0.15 * fR - 0.35 * Math.max(0, Math.sin(ph + 0.9))) * w); R(p, "kneeL", (0.95 * fR - 0.15 * bR - 0.35 * Math.max(0, Math.sin(ph + PI + 0.9))) * w);
  R(p, "ankleR", (-0.55 * bR + 0.12 * fR) * w); R(p, "ankleL", (-0.55 * fR + 0.12 * bR) * w);
  R(p, "hips", 0, 0.08 * s * w); R(p, "spine", 0.1 * w, -0.05 * s * w);
  H(p, 0, (-0.05 * Math.abs(s) + 0.012 * Math.cos(2 * ph)) * w, 0);
}
/** knee slide (crouch + sprint at speed): trailing leg folded under (knee on the sand), lead leg extended out front,
 *  torso UPRIGHT (a slight lean back only), head level — the target art's action slide, guns up and firing */
function slidePose(p: Pose, w: number) {
  ROOT(p, -0.1 * w);
  H(p, 0, -0.44 * w, 0.04 * w);
  R(p, "hipR", 1.05 * w, 0, -0.32 * w); R(p, "kneeR", -0.42 * w); R(p, "ankleR", 0.25 * w);      // lead leg out front
  R(p, "hipL", -0.35 * w, 0, 0.26 * w); R(p, "kneeL", -2.15 * w); R(p, "ankleL", -0.45 * w);      // trailing leg folded
  R(p, "spine", 0.02 * w, 0.2 * w); R(p, "chest", -0.02 * w, 0.12 * w); R(p, "head", 0.05 * w, -0.25 * w);
  RS(p, "shoulder", 0.75 * w, 0, -0.5 * w); RS(p, "elbow", 0.35 * w);
}
function jumpPose(p: Pose, w: number) {
  RS(p, "hip", 0.55 * w, 0, -0.18 * w); RS(p, "knee", -1.35 * w); RS(p, "ankle", -0.3 * w);
  RS(p, "shoulder", -0.3 * w, 0, -1.1 * w); RS(p, "elbow", 0.9 * w, 0, 0.3 * w);
  R(p, "spine", -0.08 * w); R(p, "head", 0.05 * w);
}
function fallPose(p: Pose, w: number) {
  RS(p, "hip", 0.2 * w, 0, -0.22 * w); RS(p, "knee", -0.55 * w); RS(p, "ankle", -0.25 * w);
  RS(p, "shoulder", -0.55 * w, 0, -1.35 * w); RS(p, "elbow", 0.5 * w, 0, 0.35 * w);
  R(p, "spine", 0.10 * w); R(p, "head", -0.15 * w);
}
function freefallPose(p: Pose, w: number, t: number) {
  ROOT(p, 1.25 * w, 0.06 * Math.sin(t * 1.3) * w);
  RS(p, "shoulder", -0.55 * w, 0, -1.55 * w); RS(p, "elbow", 0.35 * w, 0, 0.55 * w);
  RS(p, "hip", -0.35 * w, 0, -0.45 * w); RS(p, "knee", -0.55 * w); RS(p, "ankle", -0.4 * w);
  R(p, "spine", -0.35 * w); R(p, "chest", -0.15 * w); R(p, "head", -0.65 * w, 0.08 * Math.sin(t * 0.9) * w);
  H(p, 0, 0.06 * Math.sin(t * 2.1) * w, 0);
}
function glidePose(p: Pose, w: number, t: number) {
  // hanging by both fists from the risers above the head; legs dangling; gentle sway
  ROOT(p, 0.22 * w, 0.04 * Math.sin(t * 1.1) * w);
  RS(p, "shoulder", 2.65 * w, 0, -0.35 * w); RS(p, "elbow", 0.55 * w, 0, 0.1 * w); RS(p, "wrist", 0.3 * w);
  RS(p, "hip", 0.35 * w, 0, -0.22 * w); RS(p, "knee", -0.75 * w); RS(p, "ankle", -0.35 * w);
  R(p, "hipR", 0.08 * Math.sin(t * 2.2) * w); R(p, "hipL", -0.08 * Math.sin(t * 2.2) * w);
  R(p, "spine", -0.15 * w); R(p, "chest", -0.12 * w); R(p, "head", -0.30 * w, 0.06 * Math.sin(t * 0.8) * w);
}
function deadPose(p: Pose, w: number) {
  // flat on the back, limbs splayed
  ROOT(p, -PI / 2 * w);
  // (the back rests ON the sand and the arms lie on it, elbows nearly straight — with the joints at −0.15 m the body
  //  sinks 0.4 m into the sand and the bent elbows push the fists up through it)
  H(p, 0, -0.55 * w, -0.2 * w);
  RS(p, "shoulder", -0.4 * w, 0, -1.1 * w); RS(p, "elbow", 0.22 * w, 0, 0.35 * w);
  RS(p, "hip", 0.1 * w, 0, -0.3 * w); RS(p, "knee", -0.4 * w);
  R(p, "head", 0.3 * w, 0.6 * w); R(p, "spine", 0.05 * w);
}
function emoteDance(p: Pose, w: number, t: number) {
  const b = t * 4.2, s = Math.sin(b), c = Math.cos(b);
  stance(p, w);
  R(p, "hips", 0, 0.25 * s * w, 0.12 * c * w); R(p, "spine", 0.05 * w, -0.2 * s * w, -0.1 * c * w);
  R(p, "head", -0.15 * w, 0.2 * s * w, 0.15 * c * w);
  R(p, "shoulderR", (-1.2 + 0.5 * s) * w, 0, (-1.4 - 0.4 * c) * w); R(p, "shoulderL", (-1.2 - 0.5 * s) * w, 0, (1.4 - 0.4 * c) * w);
  RS(p, "elbow", 1.4 * w, 0, 0);
  R(p, "hipR", 0.15 * s * w, 0, -0.2 * w); R(p, "hipL", -0.15 * s * w, 0, 0.2 * w); RS(p, "knee", -0.35 * w);
  H(p, 0.04 * s * w, (-0.05 + 0.05 * Math.abs(c)) * w, 0);
}
function emoteCheer(p: Pose, w: number, t: number) {
  const b = t * 5, s = Math.sin(b);
  stance(p, w);
  RS(p, "shoulder", (2.3 + 0.2 * s) * w, 0, -0.5 * w); RS(p, "elbow", -0.3 * w); RS(p, "wrist", 0.2 * w);
  R(p, "spine", -0.2 * w); R(p, "head", -0.35 * w);
  RS(p, "knee", -0.25 * w - 0.4 * Math.max(0, s) * w); RS(p, "hip", 0.12 * Math.max(0, s) * w);
  H(p, 0, (-0.02 + 0.10 * Math.max(0, -s)) * w, 0);
}
function emoteFlex(p: Pose, w: number, t: number) {
  stance(p, w);
  RS(p, "shoulder", -0.4 * w, 0, -1.55 * w); RS(p, "elbow", 2.1 * w, 0, 0.2 * w); RS(p, "wrist", 0.3 * w);
  R(p, "chest", -0.12 * w); R(p, "head", -0.2 * w, 0.35 * Math.sin(t * 1.5) * w);
}
/** weapon hold overlay: pistol = one-handed extended; long guns = two-handed at the shoulder. w = blend */
function holdPose(p: Pose, w: number, twoHanded: boolean, pitch: number) {
  if (twoHanded) {
    R(p, "chest", 0, -0.4 * w); R(p, "spine", 0, -0.12 * w); // bladed rifle stance: the left shoulder forward to the fore-end
    R(p, "shoulderR", (0.75 - pitch * 0.85) * w, -0.35 * w, 0.35 * w); R(p, "elbowR", 0.9 * w, 0.2 * w, 0.1 * w); R(p, "wristR", -0.2 * w, 0, 0);
    R(p, "shoulderL", (1.05 - pitch * 0.85) * w, 0.55 * w, -0.25 * w); R(p, "elbowL", 0.6 * w, -0.4 * w, -0.2 * w);
  } else {
    R(p, "shoulderR", (1.08 - pitch * 0.9) * w, -0.12 * w, 0.34 * w); R(p, "elbowR", -0.12 * w, 0, 0.05 * w); R(p, "wristR", (-0.1 - pitch * 0.1) * w, 0, 0.1 * w);
    R(p, "shoulderL", 0.15 * w, 0, -0.2 * w); R(p, "elbowL", 0.55 * w);
  }
  R(p, "head", -pitch * 0.35 * w); R(p, "chest", -pitch * 0.25 * w); R(p, "spine", -pitch * 0.15 * w);
}
function reloadPose(p: Pose, w: number, u: number) {
  // off hand travels to the weapon's magazine well and back (u 0..1)
  const k = Math.sin(u * PI);
  R(p, "shoulderL", 1.15 * k * w, 0.35 * k * w, -0.3 * k * w); R(p, "elbowL", 1.2 * k * w, -0.5 * k * w, -0.3 * k * w);
  R(p, "head", 0.35 * k * w, -0.15 * k * w); R(p, "shoulderR", -0.15 * k * w);
}

/** seated on a stool / chair edge: thighs horizontal, knees bent 90°, hands on the knees, relaxed hunch */
function sitPose(p: Pose, w: number, t: number) {
  H(p, 0, -0.36 * w, 0.12 * w);
  RS(p, "hip", 1.45 * w, 0, -0.22 * w); RS(p, "knee", -1.5 * w); RS(p, "ankle", 0.08 * w);
  // (drop-02 target art: upright against the seat back, fists resting on the thighs — hunched forward with the
  // forearms raised, the peel wraps crossed the faces)
  R(p, "spine", 0.04 * w); R(p, "chest", -0.04 * w + 0.02 * Math.sin(t * 1.4) * w); R(p, "head", -0.1 * w, 0.12 * Math.sin(t * 0.5) * w);
  RS(p, "shoulder", 0.3 * w, 0, -0.12 * w); RS(p, "elbow", 0.95 * w, 0, 0.1 * w); RS(p, "wrist", -0.1 * w);
}
/** reclining in a deck chair: torso leaned back ~50°, legs stretched out, hands behind the head */
function loungePose(p: Pose, w: number, t: number) {
  ROOT(p, -0.85 * w);
  H(p, 0, -0.42 * w, 0.2 * w);
  RS(p, "hip", 1.75 * w, 0, -0.18 * w); RS(p, "knee", -0.35 * w); RS(p, "ankle", 0.25 * w);
  R(p, "spine", 0.1 * w); R(p, "head", 0.35 * w, 0.1 * Math.sin(t * 0.4) * w);
  RS(p, "shoulder", -2.3 * w, 0, -0.9 * w); RS(p, "elbow", 2.0 * w, 0, 0.2 * w);
}
/** leaning on the bar counter: elbows on the top, weight on one leg */
function barPose(p: Pose, w: number, t: number) {
  R(p, "spine", 0.35 * w); R(p, "chest", 0.1 * w); R(p, "head", -0.3 * w, 0.2 * Math.sin(t * 0.6) * w);
  RS(p, "shoulder", 0.95 * w, 0, -0.25 * w); RS(p, "elbow", 1.6 * w, 0, 0.1 * w);
  R(p, "hipR", 0.1 * w, 0, -0.1 * w); R(p, "hipL", -0.05 * w, 0, 0.14 * w); RS(p, "knee", -0.15 * w);
}
export type ShowPose = "sit" | "lounge" | "bar";
/** face expressions (KongAnimator.expression / stepFace) */
export type FaceExpr = "idle" | "aim" | "hurt" | "victory" | "wow" | "dead" | "fierce";
export interface PoseAdd { R(b: BoneName, x: number, y?: number, z?: number): void; H(x: number, y: number, z: number): void; ROOT(pitch: number, roll?: number): void; clear(b: BoneName): void }

/** zipline ride (poi-canopy PS.Zip): hanging from the trolley by both fists (IK puts them on the cable), legs tucked,
 *  the body trailing back a little with speed and swaying */
function zipPose(p: Pose, w: number, t: number, sp: number) {
  const lag = Math.min(0.35, sp * 0.025);
  ROOT(p, (-0.05 - lag) * w, 0.05 * Math.sin(t * 1.7) * w);
  RS(p, "shoulder", 2.85 * w, 0, -0.18 * w); RS(p, "elbow", 0.35 * w);
  RS(p, "hip", (1.15 + 0.1 * Math.sin(t * 2.3)) * w, 0, -0.14 * w); RS(p, "knee", -1.55 * w); RS(p, "ankle", 0.35 * w);
  R(p, "spine", -0.08 * w); R(p, "chest", -0.06 * w); R(p, "head", 0.1 * w, 0.08 * Math.sin(t * 0.7) * w);
  H(p, 0, 0.12 * w, 0);
}
/** ladder / trunk climb (PS.Climb): reaching hand over hand up the rungs, knees stepping, body tight to
 *  the face; `ph` = climb phase (advances with the height climbed), still when hanging */
function climbPose(p: Pose, w: number, ph: number) {
  const a = Math.sin(ph), b = Math.sin(ph + PI);
  ROOT(p, 0.12 * w);
  R(p, "shoulderR", (2.55 + 0.45 * a) * w, 0, -0.25 * w); R(p, "elbowR", (0.55 - 0.4 * a) * w);
  R(p, "shoulderL", (2.55 + 0.45 * b) * w, 0, 0.25 * w); R(p, "elbowL", (0.55 - 0.4 * b) * w);
  R(p, "hipR", (1.05 + 0.45 * b) * w, 0, -0.12 * w); R(p, "kneeR", (-1.45 - 0.35 * b) * w); R(p, "ankleR", 0.3 * w);
  R(p, "hipL", (1.05 + 0.45 * a) * w, 0, 0.12 * w); R(p, "kneeL", (-1.45 - 0.35 * a) * w); R(p, "ankleL", 0.3 * w);
  R(p, "spine", -0.05 * w); R(p, "chest", 0.05 * w); R(p, "head", 0.25 * w);
  H(p, 0, 0.05 * w, -0.12 * w);
}
/** mantle (gameplay PS.Mantle, 0.1–0.4 s): both hands planted on the lip pushing the body up, the lead knee up onto the
 *  ledge, then the trailing leg swings over. u = 0..1 through the pull-up */
function mantlePose(p: Pose, w: number, u: number) {
  const a = sm(clamp01(u / 0.45)), b = sm(clamp01((u - 0.4) / 0.6));
  // arms: reach up-forward (a = 0) → push down beside the hips (a = 1)
  RS(p, "shoulder", lerp(2.4, 0.35, a) * w, 0, lerp(-0.35, -0.25, a) * w); RS(p, "elbow", lerp(0.35, 0.25, a) * w + 0.9 * Math.sin(a * PI) * w);
  RS(p, "wrist", -0.4 * a * w);
  // torso folds over the lip
  R(p, "spine", (0.25 + 0.3 * a - 0.35 * b) * w); R(p, "chest", 0.15 * a * w); R(p, "head", (-0.35 * a) * w);
  // lead (right) knee comes up onto the ledge; the trailing leg hangs, then swings over
  R(p, "hipR", (1.1 + 0.5 * a - 1.2 * b) * w, 0, -0.1 * w); R(p, "kneeR", (-1.9 * a + 1.5 * b - 0.3) * w); R(p, "ankleR", 0.3 * w);
  R(p, "hipL", (-0.25 + 1.3 * b) * w, 0, 0.15 * w); R(p, "kneeL", (-0.35 - 1.2 * b + 0.9 * b * b) * w); R(p, "ankleL", -0.3 * (1 - b) * w);
  H(p, 0, -0.1 * a * w, 0.05 * a * w);
}

// ------------------------------------------------------------------------------------------- swimming
// Apes swim a BREASTSTROKE (two-arm sweeps + a frog kick), so the kong does too: head up on the
// surface, stretched out under water. One cycle u = 0..1 (coach data): out-sweep 0–0.25, in-sweep
// to the chest 0.25–0.4 (the power: the head lifts), the hands shoot forward 0.4–0.65 while the legs kick, glide to 1.
// Sprinting on the surface is a front crawl. Treading water (still on the surface, or the gun up) = an eggbeater kick and
// sculling hands. Live-tunable: SWIM_TUNE (dev tools mutate it in place).
export const SWIM_TUNE = {
  /** metres travelled per stroke cycle (≈ 0.75 Hz at the 4.8 m/s swim, 0.7 Hz under water), per crawl cycle (2 pulls) */
  cycleM: 6.4, uwCycleM: 6.0, crawlM: 6.4,
  /** treading: cycles / s of the kick + scull */
  treadHz: 0.85,
  /** body pitch (rad forward, about the feet): treading, surface breaststroke, crawl; under water the pitch follows the
   *  travel direction (π/2 = flat) between uwMin and uwMax; hovering still */
  pTread: 0.1, pSurf: 0.85, pCrawl: 1.32, uwMin: 0.55, uwMax: 2.55, pHover: 0.55,
  /** the surface breaststroke's reach (shoulder swing, body frame): level forward along the water */
  reachSurf: 1.95,
  /** where the hips sit (m, the yaw frame: up from the feet, back from the capsule axis) for each */
  // (the surface ones put the shoulders at the waterline and the head out — what the swimmer's hitbox (the crouched one)
  //  has above the water)
  hTread: [0.62, 0.0], hSurf: [0.7, 0.3], hCrawl: [0.92, 0.5], hUnder: [0.5, 0.3], hHover: [0.62, 0.12],
};
const T_ = SWIM_TUNE;
const fract = (x: number) => x - Math.floor(x);
/** smooth pulse: 0 outside [a, b], 1 at the middle, eased */
const bump = (u: number, a: number, b: number) => (u <= a || u >= b ? 0 : Math.sin(PI * (u - a) / (b - a)));
/** a 0→1 ease over [a, b] */
const ramp = (u: number, a: number, b: number) => sm(clamp01((u - a) / (b - a)));
/** treading water: upright, chin up, the legs in a slow eggbeater (alternate circles, knees wide), the hands sculling a
 *  flat figure-8 under the surface in front of the chest (`arms` = 0 when they hold a gun) */
function treadPose(p: Pose, w: number, t: number, arms: number) {
  const f = T_.treadHz * 2 * PI, a = t * f;
  R(p, "spine", -0.04 * w); R(p, "chest", -0.03 * w); R(p, "head", -0.16 * w, 0.05 * Math.sin(t * 0.6) * w);
  for (const [s, ph] of [[1, 0], [-1, PI]] as const) {
    const c = Math.cos(a + ph), sn = Math.sin(a + ph);
    R(p, s > 0 ? "hipR" : "hipL", (0.42 + 0.22 * sn) * w, 0.25 * s * w, (-0.42 + 0.12 * c) * s * w);
    R(p, s > 0 ? "kneeR" : "kneeL", (-1.15 - 0.42 * Math.max(0, -sn) - 0.1 * sn) * w);
    R(p, s > 0 ? "ankleR" : "ankleL", (0.25 + 0.2 * c) * w);
  }
  if (arms > 0) {
    const k = w * arms, sc = Math.sin(a * 0.5 + 0.4);
    // forearms level, just under the surface, palms sweeping out and in (the figure-8: a little lift on each sweep)
    RS(p, "shoulder", (0.82 + 0.06 * Math.cos(a)) * k, 0.38 * sc * k, (-0.62 - 0.22 * sc) * k);
    RS(p, "elbow", (1.05 - 0.15 * sc) * k, 0, 0.12 * k);
    RS(p, "wrist", 0.15 * k, 0, -0.3 * sc * k);
  }
  H(p, 0, 0.035 * Math.sin(a * 2) * w, 0);
}
/** the breaststroke (u = 0..1 through one cycle), body frame: the arms reach along the body axis (π = over the head =
 *  where the kong swims), sweep out wide, pull in under the chest with the elbows high, then shoot forward together;
 *  the frog kick folds the legs (heels to the seat, knees wide) and snaps them together. `surf`: head-up surface style
 *  (the chin stays out: the chest lifts on every pull, a shorter reach) vs flat under water */
function breastPose(p: Pose, w: number, u: number, surf: boolean) {
  // arms: glide (reach) → out-sweep → in-sweep → recovery
  const out = ramp(u, 0.0, 0.25) * (1 - ramp(u, 0.25, 0.4)), inn = ramp(u, 0.25, 0.4) * (1 - ramp(u, 0.42, 0.62));
  const reach = 1 - Math.max(out, inn) * 0;
  const rec = ramp(u, 0.42, 0.62);
  // shoulder swing (body frame: π/2 + the chest's lean = level forward): reaching → out-sweep (a little down) → in-sweep
  // (the hands under the chest / chin) → reaching. Head-up on the surface the chest is nearly upright, so "forward
  // along the water" is ~1.95, not over the head; under water the body is flat and the reach is over the head
  const R0 = surf ? T_.reachSurf : 2.95, R1 = surf ? R0 - 0.4 : 2.45, R2 = surf ? 0.75 : 1.25;
  let sx = R0;
  if (u < 0.25) sx = lerp(R0, R1, ramp(u, 0, 0.25));
  else if (u < 0.42) sx = lerp(R1, R2, ramp(u, 0.25, 0.42));
  else sx = lerp(R2, R0, rec);
  const abd = -0.08 - 0.95 * out - 0.35 * inn + 0.0 * reach;            // out-sweep wide, in-sweep back toward the chest
  const elb = 0.05 + 0.55 * out + (surf ? 1.95 : 1.75) * inn * (1 - rec) + 0.0 * reach;  // high elbows on the catch, folded in the in-sweep
  RS(p, "shoulder", sx * w, (-0.35 * out + 0.25 * inn) * w, abd * w);
  RS(p, "elbow", elb * w, 0, 0.15 * inn * w);
  RS(p, "wrist", (-0.25 * out + 0.35 * inn) * w, 0, -0.25 * out * w);
  // legs: together in the glide; fold (0.3–0.5: heels up, knees wide), kick (0.5–0.66: back and together)
  const fold = ramp(u, 0.28, 0.5) * (1 - ramp(u, 0.5, 0.66)), kick = bump(u, 0.5, 0.7);
  RS(p, "hip", (0.55 * fold - 0.06 + 0.06 * kick) * w, -0.25 * fold * w, (-0.35 * fold - 0.05 * kick) * w);
  RS(p, "knee", (-0.12 - 1.75 * fold) * w);
  RS(p, "ankle", (-0.55 + 0.75 * fold) * w, 0, 0.35 * fold * w);   // pointed in the glide, flexed + turned out to push
  // the body: the head + chest rise on the in-sweep (breath), dip on the reach; a surge forward on the kick
  const lift = bump(u, 0.22, 0.55);
  R(p, "spine", ((surf ? -0.32 : -0.1) - (surf ? 0.18 : 0.14) * lift) * w);
  R(p, "chest", ((surf ? -0.18 : -0.04) - 0.08 * lift) * w);
  R(p, "head", ((surf ? -0.75 : -0.55) - 0.12 * lift + (surf ? 0 : 0.18) * ramp(u, 0.6, 0.8)) * w);
  H(p, 0, 0.06 * (kick - 0.3 * fold) * w, 0);
}
/** the front crawl (sprint-swimming on the surface), c = cycles (one = a pull of each arm): an arm pulls under the body
 *  while the other recovers over the water elbow-high, the body rolls toward the pulling arm, a fast flutter kick */
function crawlPose(p: Pose, w: number, c: number) {
  for (const [s, off] of [[1, 0], [-1, 0.5]] as const) {
    const u = fract(c + off);
    // 0–0.5 the pull (reach → hip, under the body), 0.5–1 the recovery (over the water, the elbow high, back to the reach)
    let sx: number, abd: number, elb: number, tw = 0;
    if (u < 0.5) { const k = sm(u / 0.5); sx = lerp(2.95, 0.15, k); abd = -0.15 - 0.15 * Math.sin(PI * k); elb = 0.25 + 1.05 * Math.sin(PI * k); }
    // the recovery: the elbow lifts out behind the shoulder first (out of the water), then the arm swings forward over the
    // surface, wide and elbow-high, and spears back in at the reach
    else if (u < 0.65) { const k = sm((u - 0.5) / 0.15); sx = lerp(0.15, -0.35, k); abd = lerp(-0.25, -1.15, k); elb = lerp(0.35, 1.5, k); tw = -0.4 * k; }
    else { const k = sm((u - 0.65) / 0.35); sx = lerp(-0.35, 2.95, k); abd = lerp(-1.15, -0.15, k); elb = lerp(1.5, 0.25, k) + 0.2 * Math.sin(PI * k); tw = -0.4 * (1 - k); }
    R(p, s > 0 ? "shoulderR" : "shoulderL", sx * w, tw * s * w, abd * s * w);
    R(p, s > 0 ? "elbowR" : "elbowL", elb * w);
    R(p, s > 0 ? "wristR" : "wristL", -0.15 * w);
  }
  // roll toward the pulling arm (the right pulls in the first half)
  const roll = Math.sin(2 * PI * c) * 0.55;
  ROOT(p, 0, -roll * w);
  R(p, "head", (-0.62 + 0.0) * w, roll * 0.55 * w); R(p, "spine", -0.12 * w); R(p, "chest", -0.06 * w, -roll * 0.25 * w);
  // flutter: 3 kicks per arm pull, small from the hips, loose knees, pointed toes
  const k6 = Math.sin(2 * PI * c * 3);
  R(p, "hipR", (0.05 + 0.28 * k6) * w, 0, -0.06 * w); R(p, "hipL", (0.05 - 0.28 * k6) * w, 0, 0.06 * w);
  R(p, "kneeR", (-0.22 - 0.22 * Math.max(0, k6)) * w); R(p, "kneeL", (-0.22 - 0.22 * Math.max(0, -k6)) * w);
  RS(p, "ankle", -0.6 * w);
}
/** hovering still under water: a slow scull, the legs in a lazy frog kick, the body leaning forward */
function hoverPose(p: Pose, w: number, t: number) {
  const a = t * 2 * PI * 0.45, s = Math.sin(a);
  RS(p, "shoulder", (1.35 + 0.18 * s) * w, 0.3 * s * w, (-0.75 - 0.2 * s) * w);
  RS(p, "elbow", (0.75 - 0.2 * s) * w);
  RS(p, "wrist", 0.2 * s * w);
  const f = 0.5 + 0.5 * Math.sin(a - 1.2);
  RS(p, "hip", (0.35 + 0.35 * f) * w, -0.15 * f * w, (-0.3 - 0.15 * f) * w);
  RS(p, "knee", (-0.6 - 0.9 * f) * w);
  RS(p, "ankle", (-0.3 + 0.4 * f) * w);
  R(p, "spine", -0.05 * w); R(p, "head", (-0.35 + 0.05 * Math.sin(t * 0.7)) * w, 0.12 * Math.sin(t * 0.43) * w);
}

// ------------------------------------------------------------------------------------------- animator
export interface Spring { x: number; v: number }
const springStep = (s: Spring, dt: number, k = 120, d = 12) => { const a = -k * s.x - d * s.v; s.v += a * dt; s.x += s.v * dt; };
/** longest spring integration step (s): a frame at 30 fps or better is one step, as before */
const SPRING_DT_S = 1 / 30;
const approach = (x: number, to: number, step: number) => (x < to ? Math.min(to, x + step) : Math.max(to, x - step));

/** rest height of the ankle JOINT above the sole (the planted-foot target: sole on the ground) */
export const ANKLE_H = BONES.hips.offset[1] + BONES.hipR.offset[1] + BONES.kneeR.offset[1] + BONES.ankleR.offset[1];
const LEG_L = OFFSET[BI.kneeR].length() + OFFSET[BI.ankleR].length();
/** 3P reload length = the sim's reloadS (the shotgun reloads one shell per reloadS and loops while the flag stays up) */
export function reloadSeconds(w: WeaponId | null): number { return w ? WEAPON_DEFS[w]?.reloadS ?? 1.5 : 1.5; }

/** gait tuning by speed (m/s) + crouch: full-cycle stride (m), stance duty (0..1), swing lift (m).
 *  Stance travel = duty × stride ≤ ~0.75 m so the short kong legs reach every planted foot (no over-extension slide). */
function gaitParams(speed: number, crouch: number) {
  const k = clamp01((speed - 1.6) / 4.4);
  let stride = Math.min(lerp(1.0, 2.3, k), 0.45 + 0.35 * speed), duty = lerp(0.62, 0.34, clamp01((speed - 1.6) / 3.5)), lift = lerp(0.1, 0.2, k);
  stride = lerp(stride, Math.min(0.85, 0.35 + 0.4 * speed), crouch); duty = lerp(duty, 0.64, crouch); lift = lerp(lift, 0.075, crouch);
  return { stride, duty, lift };
}

interface Foot { plant: THREE.Vector3; pos: THREE.Vector3; from: THREE.Vector3; swing: boolean; u: number; dur: number; cyc: number; toe: number; lift: number; loco: boolean }
const newFoot = (): Foot => ({ plant: new THREE.Vector3(), pos: new THREE.Vector3(), from: new THREE.Vector3(), swing: false, u: 0, dur: 0.2, cyc: -1, toe: 0, lift: 0.1, loco: false });

export class KongAnimator {
  readonly pose = newPose();
  readonly quats: THREE.Quaternion[] = Array.from({ length: NB }, () => new THREE.Quaternion());
  /** bone world matrices (character → world) after update() */
  readonly world: THREE.Matrix4[] = Array.from({ length: NB }, () => new THREE.Matrix4());
  readonly root = new THREE.Matrix4();
  phase = 0; time = 0;
  speed = 0; crouch = 0; airT = 0; landT = 9; jumpT = 9; deadT = 0; emote = 0; emoteT = 0;
  /** 3P reload: starts on the RISING edge of pose.reloading, length = the sim's reloadS for the held weapon (per shell
   *  for the shotgun, looping), cancelled (0.12 s blend) on the falling edge or a weapon change */
  reloadT = 0; reloadDur = 2; reloadE = 0; reloadW = 0; reloadOn = false;
  private wasReloading = false; private reloadWeapon: WeaponId | null = null; private reloadLoop = false;
  legYaw = 0; dirSign = 1; slide = 0;
  recoil: Spring = { x: 0, v: 0 }; hurt: Spring = { x: 0, v: 0 }; land: Spring = { x: 0, v: 0 };
  aim = 0; prevState: KongPose["state"] = "idle"; stateT = 0;
  twoHanded = false;
  seed: number;
  /** staging / emote hook: extra additive bone rotations applied after every generator (same conventions as the
   *  generators: +X on spine/chest/head/root = pitch forward, limb −Z = abduct). `w` = blend weight you own. */
  overlay: ((add: PoseAdd, t: number) => void) | null = null;
  /** staged pose replacing the base pose (lobby crowd: seated / lounging) */
  showPose: ShowPose | null = null;
  /** two-bone arm IK (world space, applied after the pose): put the fist centre on `target`, elbow bent toward `pole`
   *  (a world direction). Staging only (hero aim across the body, fists on the glider risers, hands on the bar). */
  ik: { R?: ArmIK; L?: ArmIK } | ((a: KongAnimator) => { R?: ArmIK; L?: ArmIK }) | null = null;
  /** staging: the caller post-processes the bone matrices after every apply() (glider.ts's hang pose), so the kong
   *  re-poses every frame — kong.ts's animation budget would otherwise post-process a followed pose a second time */
  postPose = false;
  /** socket-local foregrip point of the held gun (two-handed guns; kong.ts sets it from the weapon's GunSpec), null =
   *  one-handed: the default hold IK puts the LEFT fist on it so every rifle is held by both hands */
  foreGrip: THREE.Vector3 | null = null;
  /** pitch the held gun points at: the aim, dropped to a low-ready while sprinting (kong.ts orients the socket by it) */
  gunPitch = 0;
  /** staging: the gun aims this far left(+)/right(−) of the body yaw and up(+) (kong.setAimOffset) — the socket and the
   *  default hold IK both follow it */
  aimYawOff = 0; aimPitchOff = 0;
  private lowReady = 0;
  /** default weapon hold by IK (right fist in front of the right shoulder along the aim line, left fist on the
   *  foregrip): the barrel, the forearm and the aim always agree and the gun never crosses the face. Staging `ik`
   *  replaces it; false = the pure pose-generator arms. */
  holdIK = true;
  /** planted-foot locking: stance feet stay fixed in the world (2-bone leg IK + hip drop), swing feet arc to the next
   *  footfall predicted from the velocity — zero foot sliding in every gait. Off automatically under staging overlays /
   *  show poses; set false to force the pure pose-generator legs. */
  footIK = true;
  /** ground height under a foot (kong.ts: the terrain when the kong stands on it, else the pose's y) */
  groundAt: ((x: number, z: number, y: number) => number) | null = null;
  readonly feet: [Foot, Foot] = [newFoot(), newFoot()];
  footW = 0;
  /** gun-dip of the reload (0..1): kong.ts rolls + lowers the hand socket by it */
  reloadDip = 0;
  /** face: [blink, gazeX, gazeY, squint, browUp, browAngry, jaw, smile] — kong.ts uploads it per kong (two
   *  bone-texture texels): the eye shader draws lids / gaze from the first four, the head vertices move brows / jaw /
   *  mouth corners by the last four. squint > 0 = happy (lower lid up), < 0 = eyes wide. smile < 0 = corners down. */
  readonly face = new Float32Array(8);
  /** eye-space point to look at (kong.ts: the camera when it is in front of the face, ep units ±0.4), null = saccades */
  gazeAt: { x: number; y: number } | null = null;
  /** staging: force an expression ("victory" | "aim" | "hurt" | "idle" | "wow"), null = from the state */
  expression: FaceExpr | null = null;
  private faceT = new Float32Array(8);
  private blinkNext = 1.5; private blinkT = 9; private blinkDouble = false; private sacNext = 0.5; private sacX = 0; private sacY = 0; private rnd = 0; private lidHold = 0;
  private euler = new THREE.Euler();
  private tmpM = new THREE.Matrix4(); private tmpQ = new THREE.Quaternion(); private tmpV = new THREE.Vector3();
  /** swimming: breaststroke / crawl cycles, the body pitch spring, the hips placement, the stroke / sprint blends */
  private swimPh = 0; private crawlPh = 0; private treadPh = 0; private swimPitch = 0; private swimPitchV = 0; private swimHy = 0.86; private swimHz = 0;
  private swimMove = 0; private swimSprint = 0;
  /** 0 → 1 over 0.35 s after entering the water from another state (swim ↔ dive keeps it: no pop at a dive) */
  private swimIn = 0;
  /** swimming: a counter that steps on every stroke's power moment (render.ts plays the stroke sound + the splash on it)
   *  and what it was: 0 surface breaststroke, 1 crawl pull, 2 treading kick, 3 under water */
  swimEvt = 0; swimEvtKind = 0;

  constructor(seed = 0) { this.seed = seed; this.time = (seed % 97) * 0.37; this.rnd = seed >>> 0; this.blinkNext = 0.4 + (seed % 13) * 0.29; }

  /** reload clock (see reloadT): call once per update */
  private stepReload(p: KongPose, dt: number) {
    const rel = !!p.reloading && !!p.weapon;
    if (rel && (!this.wasReloading || p.weapon !== this.reloadWeapon)) {
      this.reloadOn = true; this.reloadE = 0; this.reloadWeapon = p.weapon; this.reloadDur = reloadSeconds(p.weapon); this.reloadLoop = p.weapon === "shotgun";
    } else if (this.reloadOn && (!rel || p.weapon !== this.reloadWeapon)) this.reloadOn = false;
    this.wasReloading = rel;
    if (this.reloadOn) {
      this.reloadE += dt;
      if (this.reloadE >= this.reloadDur && !this.reloadLoop) { this.reloadE = this.reloadDur; this.reloadOn = false; this.reloadW = 0; }
    }
    // weight: in at once (the motion's own envelope eases it); a cancel eases out exponentially (τ 35 ms: half-way in
    // ~25 ms, gone in ~0.12 s) so the hand never lingers on a reload that the sim has already dropped
    this.reloadW = this.reloadOn ? 1 : this.reloadW < 0.02 ? 0 : this.reloadW * Math.exp(-dt / 0.035);
    const u = this.reloadU();
    // back-compat: reloadT counts down the remaining animation
    this.reloadT = this.reloadOn ? Math.max(1e-4, this.reloadDur - (this.reloadLoop ? this.reloadE % this.reloadDur : this.reloadE)) : 0;
    // gun dip envelope: tilt in over the first 15 %, back over the last 15 % (a shotgun shell: a small dip per shell)
    const env = this.reloadLoop ? 0.45 + 0.25 * Math.sin(u * PI) : sm(clamp01(u / 0.15)) * sm(clamp01((1 - u) / 0.15));
    this.reloadDip = this.reloadW * env;
  }
  /** capture determinism: no mid-blink freeze in a staged still (kong.ts calls it after every apply in shot mode) */
  settleFace() { this.blinkT = 9; this.face[0] = this.lidHold; }
  private frand() { this.rnd = (this.rnd * 1664525 + 1013904223 + this.seed * 7919) >>> 0; return this.rnd / 4294967296; }
  /** the face: expression targets from the state (or the staged `expression`), eased; random blinks (+ doubles) and
   *  saccades, or eye contact with `gazeAt` */
  private stepFace(p: KongPose, dt: number, armed: boolean) {
    const T = this.faceT; T.fill(0);
    const hurt = Math.min(1, Math.abs(this.hurt.x) * 2.5), fire = Math.min(1, Math.abs(this.recoil.x) * 3);
    const st = p.state;
    const ex: FaceExpr = this.expression ?? (st === "dead" ? "dead" : st === "emote" ? "victory" : hurt > 0.15 ? "hurt" : st === "freefall" || st === "glide" || st === "zip" || st === "jump" && this.stateT < 0.3 ? "wow" : armed && (fire > 0.05 || Math.abs(this.aim) > 0.02 || p.crouch) ? "aim" : "idle");
    // [blink, gx, gy, squint, browUp, browAngry, jaw, smile]
    switch (ex) {
      // five faces anyone can name without labels — the mouth is painted from jaw + smile
      // (kong.ts kongMouth), browAngry < 0 = worried / pained inner brows, lidHold = focus / wince
      case "idle": T[4] = 0.2; T[7] = 0.6; break;
      case "aim": T[0] = 0.2 + 0.1 * fire; T[5] = 0.6 + 0.25 * fire; T[7] = -0.05; break;
      case "hurt": T[0] = 0.85; T[4] = 0.35; T[5] = -0.9; T[6] = 0.45; T[7] = -0.9; break;
      case "victory": T[3] = 0.6; T[4] = 0.9; T[6] = 0.82 + 0.1 * Math.sin(this.time * 7); T[7] = 1; break;
      case "wow": T[3] = -0.6; T[4] = 1; T[6] = 0.75; T[7] = 0; break;
      // staging (char-03 firefight): a fierce battle grin — furrowed brows, focused lids, wide open grin
      case "fierce": T[0] = 0.12; T[5] = 0.7; T[6] = 0.55; T[7] = 0.9; break;
      case "dead": T[0] = 1; T[6] = 0.3; T[7] = -0.3; break;
    }
    // under water: holding the breath — lips pressed shut, eyes narrowed against the water, brows tight
    if (st === "dive" && ex === "idle") { T[0] = 0.35; T[3] = 0.25; T[4] = 0.1; T[5] = 0.25; T[6] = 0; T[7] = -0.15; }
    if (st === "move" && p.sprint && ex === "idle") { T[6] = Math.max(T[6], 0.22 + 0.06 * Math.sin(this.time * 9)); T[5] = Math.max(T[5], 0.2); }
    // blinks: every 1.8–5 s (a double blink 1 in 6), 60 ms close / 30 hold / 90 open
    this.blinkT += dt; this.blinkNext -= dt;
    if (this.blinkNext <= 0) { this.blinkT = 0; this.blinkDouble = this.frand() < 0.17; this.blinkNext = 1.8 + this.frand() * 3.2; }
    const bt = this.blinkT, bk = (u: number) => u < 0.06 ? u / 0.06 : u < 0.09 ? 1 : u < 0.18 ? 1 - (u - 0.09) / 0.09 : 0;
    const blink = Math.max(bk(bt), this.blinkDouble ? bk(bt - 0.22) : 0);
    // saccades: a new fixation every 0.4–2.2 s (small), or eye contact
    this.sacNext -= dt;
    if (this.sacNext <= 0) { this.sacNext = 0.4 + this.frand() * 1.8; this.sacX = (this.frand() - 0.5) * 0.34; this.sacY = (this.frand() - 0.5) * 0.16; }
    const g = this.gazeAt;
    T[1] = g ? g.x + this.sacX * 0.15 : ex === "aim" ? 0 : this.sacX; T[2] = g ? g.y + this.sacY * 0.15 : ex === "aim" ? 0 : this.sacY;
    const F = this.face, kE = 1 - Math.exp(-dt * 12), kG = 1 - Math.exp(-dt * 30);
    for (let i = 3; i < 8; i++) F[i] += (T[i] - F[i]) * kE;
    F[1] += (T[1] - F[1]) * kG; F[2] += (T[2] - F[2]) * kG;
    this.lidHold += (T[0] - this.lidHold) * (1 - Math.exp(-dt * 25));
    F[0] = Math.max(blink, this.lidHold);
  }
  /** 0..1 through the current reload (per shell for the shotgun) */
  reloadU() { const d = Math.max(0.05, this.reloadDur); return this.reloadLoop ? (this.reloadE % d) / d : clamp01(this.reloadE / d); }

  update(p: KongPose, dt: number) {
    const P = this.pose; P.fill(0);
    this.time += dt;
    const t = this.time;
    if (p.state !== this.prevState) { this.stateT = 0; if (p.state === "land") this.land.v = -3.5; if (p.state === "jump") this.jumpT = 0; if (p.state === "emote") this.emote = (this.emote + 1) % 3; this.prevState = p.state; }
    this.stateT += dt;
    // triggers
    this.firedN += p.fired ? 1 : 0; this.hurtN += p.hurt ? 1 : 0;
    this.recoil.v += this.firedN * (this.twoHanded ? 9 : 14); this.hurt.v += this.hurtN * 7;
    this.firedN = this.hurtN = 0;
    this.stepReload(p, dt);
    // (a budgeted far kong's update spans several frames, kong.ts ANIM_SMALL_S / ANIM_HIDDEN_S: the springs take it in
    // steps of at most SPRING_DT_S, so a long step neither overshoots nor diverges)
    for (let n = Math.ceil(dt / SPRING_DT_S - 1e-6), k = 0; k < n; k++) { const h = dt / n; springStep(this.recoil, h, 220, 18); springStep(this.hurt, h, 90, 9); springStep(this.land, h, 140, 12); }
    this.twoHanded = p.weapon !== null && p.weapon !== "pistol";

    // locomotion parameters
    const fwd = -p.vx * Math.sin(p.yaw) - p.vz * Math.cos(p.yaw), side = p.vx * Math.cos(p.yaw) - p.vz * Math.sin(p.yaw);
    const sp = Math.hypot(fwd, side);
    this.speed = lerp(this.speed, sp, 1 - Math.exp(-dt * 10));
    this.crouch = lerp(this.crouch, p.crouch ? 1 : 0, 1 - Math.exp(-dt * 9));
    this.aim = lerp(this.aim, p.pitch, 1 - Math.exp(-dt * 14));
    const st = p.state;
    const grounded = st === "idle" || st === "move" || st === "land" || st === "emote" || st === "slide";
    if (sp > 0.2) {
      let ly = Math.atan2(side, fwd); let sign = 1;
      if (Math.abs(ly) > PI / 2) { ly = ly > 0 ? ly - PI : ly + PI; sign = -1; }
      this.legYaw = lerp(this.legYaw, THREE.MathUtils.clamp(ly, -1.0, 1.0), 1 - Math.exp(-dt * 8)); this.dirSign = sign;
    } else this.legYaw = lerp(this.legYaw, 0, 1 - Math.exp(-dt * 6));
    const gp = gaitParams(this.speed, this.crouch);
    if (grounded) this.phase += (this.speed / gp.stride) * 2 * PI * dt;
    const ph = this.phase;

    // ---- base blend
    const wMove = sm(clamp01((this.speed - 0.15) / 0.9));
    const wRun = sm(clamp01((this.speed - 2.6) / 2.2));
    // knee slide: the explicit state, or (remotes / older callers) crouch at slide speed
    const slide = st === "slide" || (p.crouch && grounded && st !== "emote" && (this.speed > 5 || (p.sprint && this.speed > 3.5))) ? 1 : 0;
    this.slide = lerp(this.slide, slide, 1 - Math.exp(-dt * 12));
    const c = this.crouch * (1 - this.slide), up = 1 - c - this.slide;
    let wBase = 1;
    const dead = st === "dead", freefall = st === "freefall", glide = st === "glide" || st === "plane", zip = st === "zip", mantle = st === "mantle", climb = st === "climb";
    const air = st === "jump" || st === "fall";
    // tuk-tuk: seated — the driver's fists go to the bars by IK, a passenger holds its gun as on foot
    const drive = st === "drive", seated = drive || st === "ride";
    const swim = st === "swim", dive = st === "dive";
    if (dead || freefall || glide || air || zip || mantle || climb || seated || swim || dive || st === "emote" || this.showPose) wBase = 0;
    if (wBase > 0) {
      idle(P, wBase * up * (1 - wMove), t);
      gait(P, wBase * up * wMove * (1 - wRun), ph, "walk");
      gait(P, wBase * up * wMove * wRun, ph, "run");
      crouch(P, wBase * c, t);
      crouchGait(P, wBase * c * wMove, ph);
      if (this.slide > 0.001) slidePose(P, wBase * this.slide);
      // strafe: legs face the travel direction, upper body faces the aim
      R(P, "hips", 0, this.legYaw * wBase * wMove); R(P, "spine", 0, -this.legYaw * 0.55 * wBase * wMove); R(P, "chest", 0, -this.legYaw * 0.45 * wBase * wMove);
      if (p.sprint && this.speed > 3) { R(P, "spine", 0.12 * wBase); R(P, "head", -0.1 * wBase); }
    }
    if (air) { const k = sm(clamp01(this.stateT / 0.18)); const vy = p.vy; const wj = clamp01(vy / 6 + 0.5); jumpPose(P, k * wj); fallPose(P, k * (1 - wj)); if (k < 1) idle(P, 1 - k, t); }
    if (freefall) { const k = sm(clamp01(this.stateT / 0.5)); freefallPose(P, k, t); if (k < 1) fallPose(P, 1 - k); }
    if (glide) { const k = sm(clamp01(this.stateT / 0.45)); glidePose(P, k, t); if (k < 1) freefallPose(P, 1 - k, t); }
    if (zip) { const k = sm(clamp01(this.stateT / 0.2)); zipPose(P, k, t, Math.hypot(p.vx, p.vy, p.vz)); if (k < 1) fallPose(P, 1 - k); }
    if (mantle) { const k = sm(clamp01(this.stateT / 0.06)); mantlePose(P, k, clamp01(this.stateT / 0.38)); if (k < 1) jumpPose(P, 1 - k); }
    if (climb) { const k = sm(clamp01(this.stateT / 0.15)); climbPose(P, k, p.y * 4.8); if (k < 1) idle(P, 1 - k, t); }
    if (seated) {
      const k = sm(clamp01(this.stateT / 0.18));
      sitPose(P, k, t); if (k < 1) idle(P, 1 - k, t);
      // the seat's tilt (the tuk-tuk on a slope, leaning through a corner, going over), the body swaying against it
      ROOT(P, -(p.seatPitch ?? 0) * k, (p.seatRoll ?? 0) * k);
      R(P, "spine", 0, 0, -(p.seatRoll ?? 0) * 0.35 * k); R(P, "head", 0, 0, -(p.seatRoll ?? 0) * 0.3 * k);
      if (drive) { R(P, "spine", 0.16 * k); R(P, "head", -0.12 * k); }   // hunched over the bars, chin up
    }
    if (swim || dive) this.swimBody(P, p, dt, t, swim, swim && !!p.weapon);
    else { this.swimPitch = 0; this.swimPitchV = 0; this.swimMove = 0; this.swimSprint = 0; this.swimIn = 0; }
    if (dead) { this.deadT += dt; const k = sm(clamp01(this.deadT / 0.55)); deadPose(P, k); if (k < 1) { idle(P, 1 - k, t); R(P, "spine", 0.6 * (1 - k)); } }
    else this.deadT = 0;
    if (st === "emote") { const k = sm(clamp01(this.stateT / 0.25)); if (k < 1) idle(P, 1 - k, t); this.emoteT += dt; [emoteDance, emoteCheer, emoteFlex][this.emote](P, k, this.emoteT); }
    else this.emoteT = 0;
    // landing squash
    if (grounded && this.land.x !== 0) { const s = -Math.min(0.45, Math.max(-0.1, this.land.x)); RS(P, "knee", -1.2 * s); RS(P, "hip", 0.5 * s); RS(P, "ankle", 0.4 * s); R(P, "spine", 0.5 * s); H(P, 0, -0.35 * s, 0); RS(P, "shoulder", 0.3 * s, 0, -0.3 * s); }

    // ---- weapon hold + aim (grounded / air only)
    const armed = !!p.weapon && !dead && !freefall && !glide && !zip && !mantle && !climb && !drive && !dive && st !== "emote";
    this.stepFace(p, dt, armed);
    if (armed) {
      const wh = 1 - (air ? 0.35 : 0);
      holdPose(P, wh, this.twoHanded, this.aim);
      if (this.reloadDip > 0) reloadPose(P, this.reloadW, this.reloadU());
      // recoil: arm(s) kick up, chest back
      const rc = this.recoil.x;
      R(P, "shoulderR", -rc * 0.12, 0, 0); R(P, "elbowR", rc * 0.08); R(P, "chest", -rc * 0.03); if (this.twoHanded) R(P, "shoulderL", -rc * 0.1);
    }
    // staged poses (lobby crowd) + staging overlay
    if (this.showPose) { const s2 = this.showPose; if (s2 === "sit") sitPose(P, 1, t); else if (s2 === "lounge") loungePose(P, 1, t); else if (s2 === "bar") barPose(P, 1, t); }
    if (this.overlay) this.overlay({ R: (b, x, y = 0, z = 0) => R(P, b, x, y, z), H: (x, y, z) => H(P, x, y, z), ROOT: (pi, ro = 0) => ROOT(P, pi, ro), clear: (b) => { const i = BI[b] * 3; P[i] = P[i + 1] = P[i + 2] = 0; } }, t);
    // a slight constant nod — the sculpted face plane tips up (muzzle forward), so at rest the kong looked
    // down its nose at you (smug / menacing); 0.1 rad brings the eyes level with the viewer
    if (!dead) R(P, "head", 0.1);
    // hurt flinch
    const h = this.hurt.x; if (h) { R(P, "spine", -h * 0.08); R(P, "chest", -h * 0.06, h * 0.05); R(P, "head", h * 0.12, -h * 0.08); RS(P, "shoulder", -h * 0.06, 0, -h * 0.04); }

    // ---- to quaternions + matrices
    // authored conventions (every pose generator above): +X on the up-pointing bones (spine/chest/head) and the root =
    // pitch FORWARD; on the limbs +X = swing forward and -Z = ABDUCT (right limb out to +x, left mirrored by RS()).
    // Raw euler +X tips an up-pointing bone backward and raw -Z swings a hanging right limb inward, so flip those here.
    for (let i = 0; i < NB; i++) { this.euler.set(UP_BONE[i] ? -P[i * 3] : P[i * 3], P[i * 3 + 1], LIMB[i] ? -P[i * 3 + 2] : P[i * 3 + 2], "XYZ"); this.quats[i].setFromEuler(this.euler); }
    this.root.makeRotationY(p.yaw);
    if (P[P_ROOT] || P[P_ROOT + 1]) { this.euler.set(-P[P_ROOT], 0, P[P_ROOT + 1], "XYZ"); this.tmpM.makeRotationFromEuler(this.euler); this.root.multiply(this.tmpM); }
    this.root.setPosition(p.x, p.y, p.z);
    this.fk();
    // ---- planted feet (leg IK + hip drop)
    const wantFeet = this.footIK && grounded && st !== "emote" && !this.showPose && !this.overlay && this.slide < 0.5 && !dead;
    this.stepFeet(p, dt, wantFeet, gp);
    // gun pitch: aim, lowered to a low-ready while sprinting (not while sliding: the slide fires)
    this.lowReady = lerp(this.lowReady, p.sprint && this.speed > 3.2 && this.slide < 0.5 ? 1 : 0, 1 - Math.exp(-dt * 8));
    this.gunPitch = this.aim - 0.55 * this.lowReady;
    if (this.ik) { const k = typeof this.ik === "function" ? this.ik(this) : this.ik; if (k.R) this.solveArm("R", k.R); if (k.L) this.solveArm("L", k.L); }
    else if (zip) this.solveZip(p);
    else if (drive && p.grips) this.solveBars(p);
    else if (this.holdIK && armed && !this.showPose) this.solveHold(p);
    this.atX = p.x; this.atY = p.y; this.atZ = p.z; this.atYaw = p.yaw;
  }

  /** where the last update() / follow() put the kong (its pose's position + yaw) */
  private atX = 0; private atY = 0; private atZ = 0; private atYaw = 0;
  private followM = new THREE.Matrix4();
  /** shots and hits (the pose's edge-triggered fired / hurt) seen by follow() since the last update(), which plays them */
  private firedN = 0; private hurtN = 0;
  /** between two budgeted updates (kong.ts): carry the last pose rigidly to the kong's new position + yaw — every bone,
   *  the root and so the hand sockets move with the body, no re-pose (no clock, springs, IK or face); shots and hits wait
   *  for the next update() */
  follow(p: KongPose) {
    this.firedN += p.fired ? 1 : 0; this.hurtN += p.hurt ? 1 : 0;
    const dy = p.yaw - this.atYaw, c = Math.cos(dy), s = Math.sin(dy);
    if (dy === 0 && p.x === this.atX && p.y === this.atY && p.z === this.atZ) return;
    // T(new) · Ry(dy) · T(−old)
    const M = this.followM.makeRotationY(dy);
    M.setPosition(p.x - (c * this.atX + s * this.atZ), p.y - this.atY, p.z - (-s * this.atX + c * this.atZ));
    for (const w of this.world) w.premultiply(M);
    this.root.premultiply(M);
    this.atX = p.x; this.atY = p.y; this.atZ = p.z; this.atYaw = p.yaw;
  }

  /** swimming (see the generators above): treading ↔ breaststroke ↔ crawl on the surface, hovering ↔ breaststroke under
   *  water; the body pitch follows the stroke (under water: the travel direction, so a dive goes in head first) on a
   *  critically damped spring, and the hips are placed so the head stays out on the surface / the body is centred on the
   *  capsule under water. `gun`: treading upright with the gun up (holdPose does the arms) */
  private swimBody(P: Pose, p: KongPose, dt: number, t: number, surf: boolean, gun: boolean) {
    const hs = Math.hypot(p.vx, p.vz), sp = surf ? hs : Math.hypot(hs, p.vy);
    this.swimIn = Math.min(1, this.swimIn + dt / 0.35);
    const k = sm(this.swimIn);
    if (k < 1) idle(P, 1 - k, t);
    this.swimMove = lerp(this.swimMove, gun ? 0 : sm(clamp01((sp - 0.4) / 1.6)), 1 - Math.exp(-dt * 5));
    this.swimSprint = lerp(this.swimSprint, surf && p.sprint && hs > 4 && !gun ? 1 : 0, 1 - Math.exp(-dt * 4));
    const m = this.swimMove, cr = this.swimSprint * m, br = m - cr;
    const ph0 = this.swimPh, cr0 = this.crawlPh, tr0 = this.treadPh;
    this.swimPh += (Math.max(sp, 0.8 * m) / (surf ? T_.cycleM : T_.uwCycleM)) * dt;
    this.crawlPh += (Math.max(hs, 0.8 * m) / T_.crawlM) * dt;
    this.treadPh += T_.treadHz * dt;
    let pitch: number, hy: number, hz: number;
    if (surf) {
      const tw = 1 - m;
      treadPose(P, tw * k, this.treadPh / T_.treadHz, gun ? 0 : 1);
      if (br > 0.001) breastPose(P, br * k, fract(this.swimPh), true);
      if (cr > 0.001) crawlPose(P, cr * k, this.crawlPh);
      pitch = T_.pTread * tw + T_.pSurf * br + T_.pCrawl * cr;
      hy = T_.hTread[0] * tw + T_.hSurf[0] * br + T_.hCrawl[0] * cr; hz = T_.hTread[1] * tw + T_.hSurf[1] * br + T_.hCrawl[1] * cr;
    } else {
      hoverPose(P, (1 - m) * k, t);
      if (m > 0.001) breastPose(P, m * k, fract(this.swimPh), false);
      const dir = PI / 2 + Math.atan2(-p.vy, Math.max(hs, 0.05));
      pitch = lerp(T_.pHover, THREE.MathUtils.clamp(dir, T_.uwMin, T_.uwMax), m);
      hy = lerp(T_.hHover[0], T_.hUnder[0], m); hz = lerp(T_.hHover[1], T_.hUnder[1], m);
    }
    // the stroke events (sound + splash): the breaststroke's in-sweep, each crawl hand entry, each treading kick
    if (surf && br > 0.5 && Math.floor(this.swimPh - 0.3) > Math.floor(ph0 - 0.3)) { this.swimEvt++; this.swimEvtKind = 0; }
    else if (surf && cr > 0.5 && Math.floor(this.crawlPh * 2) > Math.floor(cr0 * 2)) { this.swimEvt++; this.swimEvtKind = 1; }
    else if (surf && m < 0.3 && Math.floor(this.treadPh) > Math.floor(tr0)) { this.swimEvt++; this.swimEvtKind = 2; }
    else if (!surf && m > 0.5 && Math.floor(this.swimPh - 0.3) > Math.floor(ph0 - 0.3)) { this.swimEvt++; this.swimEvtKind = 3; }
    // pitch: critically damped (ω 7: a dive tips in within ~0.3 s, no overshoot); entering from land starts upright
    if (this.swimIn <= dt / 0.35 + 1e-6) { this.swimPitch = T_.pTread; this.swimPitchV = 0; this.swimHy = T_.hTread[0]; this.swimHz = T_.hTread[1]; }
    { const w = 7, e = this.swimPitch - pitch, x = Math.exp(-w * dt), c = this.swimPitchV + w * e;
      this.swimPitch = pitch + (e + c * dt) * x; this.swimPitchV = (this.swimPitchV - w * c * dt) * x; }
    const kh = 1 - Math.exp(-dt * 6);
    this.swimHy += (hy - this.swimHy) * kh; this.swimHz += (hz - this.swimHz) * kh;
    // root pitch about the feet point, then the hips where they belong (H is in the pitched root frame: local Y →
    // (up cos θ, fwd sin θ), local Z → (up sin θ, fwd −cos θ); hips = (0.86 + Hy)·Y + Hz·Z must land on (up hy, back hz))
    const th = this.swimPitch * k, c = Math.cos(th), s = Math.sin(th), ty = this.swimHy, tf = -this.swimHz;
    ROOT(P, th);
    H(P, 0, (c * ty + s * tf - 0.86) * k, (s * ty - c * tf) * k);
  }

  /** forward kinematics of every bone from quats + root + hips offset */
  private fk() {
    const P = this.pose;
    for (let i = 0; i < NB; i++) {
      const par = PARENT[i];
      this.tmpV.copy(OFFSET[i]); if (i === 0) { this.tmpV.x += P[P_HIPS]; this.tmpV.y += P[P_HIPS + 1]; this.tmpV.z += P[P_HIPS + 2]; }
      this.tmpM.compose(this.tmpV, this.quats[i], ONE);
      this.world[i].multiplyMatrices(par < 0 ? this.root : this.world[par], this.tmpM);
    }
  }

  // ------------------------------------------------------------------------------------------ planted feet
  private _fV = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private _fQ = new THREE.Quaternion(); private _fQ2 = new THREE.Quaternion(); private _fE = new THREE.Euler(0, 0, 0, "YXZ");
  private ground(x: number, z: number, y: number) { return this.groundAt ? this.groundAt(x, z, y) : y; }
  /** where foot i rests under the hips (world, ankle joint) */
  private restFoot(i: number, p: KongPose, out: THREE.Vector3) {
    const hd = p.yaw + this.legYaw, w = lerp(0.2, 0.27, this.crouch) * (i === 0 ? 1 : -1);
    const x = p.x + Math.cos(hd) * w - Math.sin(hd) * 0.02, z = p.z - Math.sin(hd) * w - Math.cos(hd) * 0.02;
    return out.set(x, this.ground(x, z, p.y) + ANKLE_H, z);
  }
  private stepFeet(p: KongPose, dt: number, want: boolean, gp: { stride: number; duty: number; lift: number }) {
    const prevW = this.footW;
    this.footW = approach(this.footW, want ? 1 : 0, dt / 0.12);
    const [rest, to, fk, tmp] = this._fV;
    if (this.footW <= 0) { for (const f of this.feet) f.swing = false; return; }
    const ankles = [BI.ankleR, BI.ankleL];
    if (prevW <= 0) {
      // (re)engage: plant each foot where the pose has it, on the ground
      for (let i = 0; i < 2; i++) { const f = this.feet[i]; fk.setFromMatrixPosition(this.world[ankles[i]]); f.plant.set(fk.x, this.ground(fk.x, fk.z, p.y) + ANKLE_H, fk.z); f.pos.copy(f.plant); f.swing = false; f.cyc = -1; f.toe = 0; }
    }
    const loco = this.speed > 0.3 && Math.hypot(p.vx, p.vz) > 0.25;
    const period = gp.stride / Math.max(0.05, this.speed), S = 1 - gp.duty;
    const ci = [0, 0], cy = [0, 0];
    for (let i = 0; i < 2; i++) { const q = this.phase / (2 * PI) + 0.25 + (i ? 0.5 : 0); cy[i] = Math.floor(q); ci[i] = q - cy[i]; }
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      this.restFoot(i, p, rest);
      // teleport / respawn: a plant far from the body snaps home
      const cur = f.swing ? f.pos : f.plant;
      if (Math.hypot(cur.x - rest.x, cur.z - rest.z) > 2.5 || Math.abs(cur.y - rest.y) > 1.0) { f.plant.copy(rest); f.pos.copy(rest); f.swing = false; }
      if (!f.swing) {
        if (loco) {
          // a stance foot the leg can no longer reach (a sudden speed-up / turn) lifts early instead of dragging
          const over = Math.hypot(f.plant.x - rest.x, f.plant.z - rest.z) > 0.62 && !this.feet[1 - i].swing;
          if ((ci[i] < S && f.cyc !== cy[i]) || over) { f.swing = true; f.u = 0; f.dur = Math.max(0.07, (S - ci[i]) * period); f.cyc = cy[i]; f.loco = true; f.lift = gp.lift; f.from.copy(f.plant); }
        } else {
          // settle: step the foot farthest from its rest spot (one at a time)
          const o = this.feet[1 - i];
          const e = Math.hypot(f.plant.x - rest.x, f.plant.z - rest.z), eo = this.restFoot(1 - i, p, tmp) && Math.hypot(o.plant.x - tmp.x, o.plant.z - tmp.z);
          if (!o.swing && e > 0.09 && e >= eo) { f.swing = true; f.u = 0; f.dur = 0.2; f.loco = false; f.lift = 0.07; f.from.copy(f.plant); f.cyc = cy[i]; }
        }
      }
      if (f.swing) {
        f.u = Math.min(1, f.u + dt / f.dur);
        // footfall: under the hips when the swing ends + half the next stance ahead (so the foot passes under the hip mid-stance)
        to.copy(rest);
        if (loco && f.loco) { const lead = (1 - f.u) * f.dur + gp.duty * period * 0.5; to.x += p.vx * lead; to.z += p.vz * lead; to.y = this.ground(to.x, to.z, p.y) + ANKLE_H; }
        // lift straight up first, travel, then set straight down (no sliding contact at either end)
        const hz = sm(clamp01((f.u - 0.18) / 0.64)), hz2 = hz * hz * (3 - 2 * hz) * 0.5 + hz * 0.5;
        f.pos.lerpVectors(f.from, to, hz2);
        f.pos.y += f.lift * Math.pow(Math.sin(PI * f.u), 0.5);
        f.toe = -0.5 * Math.sin(PI * clamp01(f.u / 0.45)) + 0.28 * Math.sin(PI * clamp01((f.u - 0.55) / 0.45));
        if (f.u >= 1) { f.swing = false; f.plant.copy(to); f.pos.copy(to); f.toe = 0; }
      } else { f.pos.copy(f.plant); f.toe = 0; }
    }
    // hip drop: lower the whole body until both legs reach their targets (97 % of full extension)
    const W = this.footW;
    let drop = 0;
    const hipsI = [BI.hipR, BI.hipL];
    for (let i = 0; i < 2; i++) {
      fk.setFromMatrixPosition(this.world[ankles[i]]);
      to.lerpVectors(fk, this.feet[i].pos, W);
      tmp.setFromMatrixPosition(this.world[hipsI[i]]);
      const hx = Math.hypot(to.x - tmp.x, to.z - tmp.z), L = LEG_L * 0.97;
      const v = tmp.y - to.y, need = hx < L ? v - Math.sqrt(L * L - hx * hx) : v;
      if (need > drop) drop = need;
    }
    drop = Math.min(drop, 0.24);
    if (drop > 0) { const e = this.root.elements; e[13] -= drop; this.fk(); }
    // leg IK + flat feet
    const hd = p.yaw + this.legYaw, poleF = this._fV[5].set(-Math.sin(hd), -0.25, -Math.cos(hd));
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      fk.setFromMatrixPosition(this.world[ankles[i]]);
      to.lerpVectors(fk, f.pos, W);
      tmp.copy(poleF).addScaledVector(this._fV[4].set(Math.cos(hd), 0, -Math.sin(hd)), i === 0 ? 0.25 : -0.25);
      this.solveChain(hipsI[i], BI[i === 0 ? "kneeR" : "kneeL"], ankles[i], to, tmp, 0);
      // ankle: sole level with the ground along the hips heading, toe roll through the swing (blended with the pose)
      const iA = ankles[i], iK = PARENT[iA];
      this._fQ.setFromEuler(this._fE.set(f.toe, hd, 0));
      this._fQ2.setFromRotationMatrix(this.tmpM.extractRotation(this.world[iK])).invert().multiply(this._fQ);
      this.quats[iA].slerp(this._fQ2, W);
      // the high-top only lets the ankle bend so far: past ANKLE_SOFT the shin-to-foot angle eases toward ANKLE_MAX (the
      // v2 sneaker's shaft follows the shin — the run's 78° back-swing flick tore its heel into a fin; a runner's foot
      // trails the shin there anyway)
      const qa = this.quats[iA], ang = 2 * Math.acos(Math.min(1, Math.abs(qa.w)));
      if (ang > ANKLE_SOFT) qa.slerp(IDQ, 1 - (ANKLE_SOFT + (ANKLE_MAX - ANKLE_SOFT) * Math.tanh((ang - ANKLE_SOFT) / (ANKLE_MAX - ANKLE_SOFT))) / ang);
      this.tmpM.compose(OFFSET[iA], this.quats[iA], ONE); this.world[iA].multiplyMatrices(this.world[iK], this.tmpM);
    }
  }

  // ------------------------------------------------------------------------------------------ hold IK
  private _hV = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private _hE = new THREE.Euler(0, 0, 0, "YXZ"); private _hQ = new THREE.Quaternion();
  private _hIK = { R: { target: new THREE.Vector3(), pole: new THREE.Vector3() } as ArmIK, L: { target: new THREE.Vector3(), pole: new THREE.Vector3() } as ArmIK };
  /** the default weapon hold (see holdIK): fists placed relative to the right shoulder along the aim; the left fist on
   *  the foregrip (two-handed) or cupping the right fist (pistol); the reload moves the off hand magazine well → belt
   *  pouch → magazine well (shotgun: pouch → loading port per shell) on the sim's reload clock */
  private solveHold(p: KongPose) {
    const [f, r, d, S, tR, tL, tmp, well, pouch] = this._hV;
    const ay = p.yaw + this.aimYawOff, cy = Math.cos(ay), sy = Math.sin(ay), gp = this.gunPitch + this.aimPitchOff, two = this.twoHanded;
    f.set(-sy, 0, -cy); r.set(cy, 0, -sy);
    d.copy(f).multiplyScalar(Math.cos(gp)).setY(Math.sin(gp));
    S.setFromMatrixPosition(this.world[BI.shoulderR]);
    const rc = this.recoil.x, rl = this.reloadDip;
    // pistol: arm out along the aim at shoulder height; long guns: fist at the right pec, the gun forward of it
    // (the kong's head sits IN the shoulders: the fists ride 0.2–0.3 m below the shoulder joint so the gun is at chest
    // height, under the chin, like the target art)
    if (two) tR.copy(S).addScaledVector(d, 0.42).addScaledVector(r, -0.12).add(tmp.set(0, -0.3, 0));
    else tR.copy(S).addScaledVector(d, 0.6).addScaledVector(r, -0.1).add(tmp.set(0, -0.22, 0));
    tR.addScaledVector(d, -0.05 * rc).add(tmp.set(0, 0.02 * rc - 0.09 * rl, 0)).addScaledVector(f, -0.05 * rl);
    const IK = this._hIK;
    IK.R.target.copy(tR); IK.R.pole.copy(r).add(tmp.set(0, -0.8, 0)).addScaledVector(f, -0.3);
    this.solveArm("R", IK.R);
    // the socket's frame (kong.ts: yaw, gun pitch − reload dip, roll): carries the foregrip / magazine well
    this._hQ.setFromEuler(this._hE.set(gp + this.recoil.x * 0.05 - rl * 0.5, ay + (two ? 0 : 0.04), -rl * 0.9 + (two ? 0 : -0.12)));
    if (two && this.foreGrip) {
      tL.copy(this.foreGrip).applyQuaternion(this._hQ).add(tR);
      // the kong's short arms cannot always span to a long gun's fore-end: slide the off hand back along the handguard
      // (grip → foregrip line) to the farthest point the left arm reaches — the fist stays ON the gun, never in the air
      const SL = well.setFromMatrixPosition(this.world[BI.shoulderL]), reach = (OFFSET[BI.elbowL].length() + OFFSET[BI.wristL].length() + 0.122) * 0.97;
      if (tL.distanceTo(SL) > reach) {
        const ax = pouch.subVectors(tL, tR), oc = tmp.subVectors(tR, SL);
        const A = ax.dot(ax), B = 2 * oc.dot(ax), C = oc.dot(oc) - reach * reach, disc = B * B - 4 * A * C;
        const sMax = disc >= 0 ? (-B + Math.sqrt(disc)) / (2 * A) : 0.35;
        tL.copy(tR).addScaledVector(ax, THREE.MathUtils.clamp(sMax, 0.35, 1));
      }
    } else tL.copy(tR).addScaledVector(r, -0.1).addScaledVector(d, -0.03).add(tmp.set(0, -0.06, 0));   // pistol: cup the grip
    if (this.reloadW > 0.001) {
      const u = this.reloadU(), w = this.reloadW;
      // magazine well: under the gun between the grip and the fore end
      well.set(0, -0.13, two && this.foreGrip ? this.foreGrip.z * 0.45 : 0.02).applyQuaternion(this._hQ).add(tR);
      // belt pouch: left hip, forward
      pouch.setFromMatrixPosition(this.world[BI.hips]).addScaledVector(r, -0.3).addScaledVector(f, 0.12).add(tmp.set(0, -0.02, 0));
      let k: number;   // 0 = grip hold, then path keys
      const grip = tmp.copy(tL);
      if (this.reloadLoop) {
        // shell: fore-end → pouch (0–0.45) → loading port under the receiver (0.45–0.8) → fore-end
        if (u < 0.45) { k = sm(u / 0.45); tL.lerpVectors(grip, pouch, k); }
        else if (u < 0.8) { k = sm((u - 0.45) / 0.35); tL.lerpVectors(pouch, well, k); }
        else { k = sm((u - 0.8) / 0.2); tL.lerpVectors(well, grip, k); }
      } else {
        // mag: grip → well (pull the mag, 0.12–0.3) → pouch (0.3–0.5) → well (0.5–0.72, insert + slap) → grip (0.85–1)
        if (u < 0.12) tL.lerpVectors(grip, well, sm(u / 0.12));
        else if (u < 0.3) tL.copy(well).add(this._hV[3].set(0, -0.06 * sm((u - 0.12) / 0.18), 0));
        else if (u < 0.5) tL.lerpVectors(this._hV[3].copy(well).add(this._hV[4].set(0, -0.06, 0)), pouch, sm((u - 0.3) / 0.2));
        else if (u < 0.72) tL.lerpVectors(pouch, well, sm((u - 0.5) / 0.22));
        else if (u < 0.85) tL.copy(well).add(this._hV[3].set(0, 0.03 * Math.sin(PI * (u - 0.72) / 0.13), 0));
        else tL.lerpVectors(well, grip, sm((u - 0.85) / 0.15));
      }
      tL.lerp(grip, 1 - w);
    }
    IK.L.target.copy(tL); IK.L.pole.copy(r).multiplyScalar(-1).add(tmp.set(0, -0.9, 0));
    this.solveArm("L", IK.L);
  }
  /** zipline: both fists on the trolley at the cable (ZIP_HANG above the feet), just ahead of the head */
  private _zIK = { R: { target: new THREE.Vector3(), pole: new THREE.Vector3() } as ArmIK, L: { target: new THREE.Vector3(), pole: new THREE.Vector3() } as ArmIK };
  private solveZip(p: KongPose) {
    const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw), Z = this._zIK;
    for (const [s, k] of [["R", 1], ["L", -1]] as const) {
      Z[s].target.set(p.x + cy * 0.07 * k - sy * 0.12, p.y + ZIP_HANG, p.z - sy * 0.07 * k - cy * 0.12);
      Z[s].pole.set(cy * k * 0.6 + sy * 0.8, -0.2, -sy * k * 0.6 + cy * 0.8);
      this.solveArm(s, Z[s]);
    }
  }
  /** tuk-tuk driver: both fists on the handlebar grips (world), elbows out and down */
  private _bIK = { R: { target: new THREE.Vector3(), pole: new THREE.Vector3() } as ArmIK, L: { target: new THREE.Vector3(), pole: new THREE.Vector3() } as ArmIK };
  private solveBars(p: KongPose) {
    const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw), Bk = this._bIK, g = p.grips!;
    Bk.R.target.copy(g[0]); Bk.R.pole.set(cy * 0.8 + sy * 0.3, -0.7, -sy * 0.8 + cy * 0.3); this.solveArm("R", Bk.R);
    Bk.L.target.copy(g[1]); Bk.L.pole.set(-cy * 0.8 + sy * 0.3, -0.7, sy * 0.8 + cy * 0.3); this.solveArm("L", Bk.L);
  }
  bone(name: BoneName) { return this.world[BI[name]]; }

  private _ikV = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private _ikQ = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
  private _ikM = new THREE.Matrix4();
  /** solve one arm onto its IK target (called at the end of update) */
  solveArm(side: "R" | "L", o: ArmIK) {
    const iS = BI[`shoulder${side}` as BoneName], iE = BI[`elbow${side}` as BoneName], iW = BI[`wrist${side}` as BoneName];
    this.solveChain(iS, iE, iW, o.target, o.pole, o.reach ?? 0.122, o.twist ?? 0);   // wrist → fist centre ≈ 0.12 m
  }
  /** two-bone IK: upper bone iS, mid iE, end iW (its joint + `reach` along the lower bone lands on `target`), bend
   *  toward `pole`; writes the local quats + world matrices of the three bones. The end keeps the lower bone's frame
   *  (+ an optional twist) — legs overwrite it afterwards with a level foot. */
  solveChain(iS: number, iE: number, iW: number, target: THREE.Vector3, polev: THREE.Vector3, reach: number, twist = 0) {
    const iC = PARENT[iS];
    const [S, E, T, a, b, pole] = this._ikV, [qC, qWs, qWe] = this._ikQ;
    S.setFromMatrixPosition(this.world[iS]);
    const L1 = OFFSET[iE].length(), L2 = OFFSET[iW].length() + reach;
    T.copy(target);
    const d = Math.max(1e-4, Math.min(T.distanceTo(S), (L1 + L2) * 0.999)), dir = a.subVectors(T, S).normalize();
    T.copy(S).addScaledVector(dir, d);
    // elbow on the circle of the two-bone solution, toward the pole
    const cosA = THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    pole.copy(polev).addScaledVector(dir, -polev.dot(dir));
    if (pole.lengthSq() < 1e-6) pole.set(0, -1, 0).addScaledVector(dir, dir.y); pole.normalize();
    E.copy(S).addScaledVector(dir, cosA * L1).addScaledVector(pole, sinA * L1);
    // upper bone world rotation: rest direction (parent frame) → S→E
    qC.setFromRotationMatrix(this._ikM.extractRotation(this.world[iC]));
    b.copy(OFFSET[iE]).normalize().applyQuaternion(qC);
    qWs.setFromUnitVectors(b, a.subVectors(E, S).normalize()).multiply(qC);
    // mid bone world rotation: rest lower direction (upper frame) → E→T
    b.copy(OFFSET[iW]).normalize().applyQuaternion(qWs);
    qWe.setFromUnitVectors(b, a.subVectors(T, E).normalize()).multiply(qWs);
    this.quats[iS].copy(qC).invert().multiply(qWs);
    this.quats[iE].copy(qWs).invert().multiply(qWe);
    this.quats[iW].setFromAxisAngle(a.set(0, 1, 0), twist);
    const upd = (i: number) => { const par = PARENT[i]; this._ikM.compose(OFFSET[i], this.quats[i], ONE); this.world[i].multiplyMatrices(this.world[par], this._ikM); };
    upd(iS); upd(iE); upd(iW);
  }
}
export interface ArmIK { target: THREE.Vector3; pole: THREE.Vector3; reach?: number; twist?: number }
const ONE = new THREE.Vector3(1, 1, 1);
const IDQ = new THREE.Quaternion();
/** the planted / swinging foot's bend against the shin (rad): free up to ANKLE_SOFT, eased toward ANKLE_MAX beyond */
const ANKLE_SOFT = 0.52, ANKLE_MAX = 0.8;
const UP_BONE = BONE_LIST.map((b) => b === "spine" || b === "chest" || b === "head");
const LIMB = BONE_LIST.map((b) => /^(shoulder|elbow|wrist|hip|knee|ankle)[RL]$/.test(b));
export const boneIndex = (b: BoneName) => BI[b];
