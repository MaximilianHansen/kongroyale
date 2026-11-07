// Fixture for the shared-math rule: each marked line must be flagged, and only those.
export const a = (x: number) => Math.sin(x); // lint-expect
export const b = (x: number) => Math.cos(x) + Math.sqrt(x); // lint-expect
export const c = (y: number, x: number) => Math.atan2(y, x); // lint-expect
export const d = (x: number, y: number) => Math.hypot(x, y); // lint-expect
export const e = (x: number, y: number) => Math.pow(x, y); // lint-expect
export const f = (x: number) => Math.exp(x) * Math.log(x); // lint-expect
export const g = (x: number) => globalThis.Math.tan(x); // lint-expect
export const h = (x: number) => Math["asin"](x); // lint-expect
export const i = (k: "sin" | "cos", x: number) => Math[k](x); // lint-expect
const { acos } = Math; // lint-expect
export const j = (x: number) => acos(x);
export const k = (xs: number[]) => xs.map(Math.cbrt); // lint-expect
export const l = (x: number) => x ** 3; // lint-expect
export function m(x: number) { x **= 2; return x; } // lint-expect
