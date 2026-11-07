// ============================================================================ dimensions (metres, plane-local)
// nose → -Z, +X = starboard (right wing), origin = belly centre on the ground with the gear down.
export const TAU = Math.PI * 2;
export const ZN = -14, Z_NOSE = -8.9, Z_UP = 4.4, Z_RAMP = 9.4, Z_OPEN = 12, ZE = 14, ZCAP = 14.55;
export const BELLY = 1.3, TOP = 5.6, HW = 2.12, NOSE_Y = 3.0, SE = 2.15;
export const TAIL_TOP = 5.12, TAIL_BOT = 4.62, TAIL_W = 0.36;
export const FLOOR_Y = BELLY + 0.52, SKIN = 0.12;
// opening half-angle (from the belly) at the hinge / at the aft end: the opening is the UNDER-tail ramp only (the sides
// stay closed)
export const TH0 = 0.5, TH1 = 0.62;
export const WING_Y = 5.84, WING_LE = -4.4, WING_C0 = 4.0, WING_C1 = 2.1, WING_HALF = 17, WING_CENTRE = 6.2, WING_TIP_BROWN = 15.35;
export const ENG_X = 5.8, ENG_Y = 5.02, ENG_Z = -7.0, COWL_R = 1.04;
export const PROP_R = 2.1, PROP_Z = ENG_Z - 0.3;
export const GEAR_TRAVEL = 0.45, WHEEL_R = 0.52, NOSE_WHEEL_R = 0.36, NOSE_GEAR_Z = -11.2, NOSE_TRAVEL = 0.98;
export const STAB_Y = 5.3, STAB_LE = 11.0, STAB_HALF = 6.3;
export const FIN_Y0 = 4.9, FIN_Y1 = 12.35, FIN_ZMIN = 6.2, FIN_ZMAX = 14.45;

// palette (sampled from the drop-01 + char-02 target art, pushed back to albedo)
export const YEL = "#f7d418", BROWN = "#4a2a17", BROWN_TIP = "#3a2319", CREAM = "#f4e6bf";
export const LEAF_D = "#2d6a2b", LEAF_L = "#4f9a39", LEAF_RIB = "#b9d36b";

// ============================================================================ small maths
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** superellipse quarter: (1 - t^p)^(1/p) */
export const ell = (t: number, p: number) => Math.pow(Math.max(0, 1 - Math.pow(clamp01(t), p)), 1 / p);
export const sp = (t: number, e: number) => Math.sign(t) * Math.pow(Math.abs(t), e);
export function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
export const E2 = 2 / SE;
/** angle (starboard side) at which the CABIN section reaches world height y */
export function aOfY(y: number) {
  const cy = (TOP + BELLY) / 2, h = (TOP - BELLY) / 2;
  return Math.acos(Math.max(-1, Math.min(1, sp((cy - y) / h, SE / 2))));
}
export const BAND_Y0 = 3.27, BAND_Y1 = 4.13, CREAM_W = 0.085;
export const WIN_Y = (BAND_Y0 + BAND_Y1) / 2;
export const PORTHOLES = [-8.2, -6.8, -5.4, -4.0, -2.6, -1.2, 0.2, 1.6];
export const FIN_TOP0 = 11.75;
export function finLE(y: number) {
  const straight = 8.9 + (y - 6.2) * 0.46;
  const f = y < 6.3 ? Math.pow((6.3 - y) / 1.4, 2) : 0;
  return straight - 2.5 * f;
}
export function finTE(y: number) { return 14.4 - (y - FIN_Y0) * 0.07; }
