// Fixture for the shared-math rule: exact Math, dmath, locals named like Math functions and comments pass.
import * as dmath from "../../../../shared/sim/dmath";
// Math.sin(x) and Math.pow(a, b) in a comment are fine
export const exact = (x: number) => Math.sqrt(Math.abs(x)) + Math.floor(x) + Math.round(x) + Math.max(x, 1) + Math.fround(x) + Math.PI;
export const viaDmath = (x: number, y: number) => dmath.sin(x) + dmath.atan2(y, x) + dmath.hypot(x, y) + dmath.hypot3(x, y, 1) + dmath.pow(x, y);
export const names = ["Math.sin", "pow", "hypot"];
export const opts = { sin: 1, pow: 2 };
export const read = (o: typeof opts) => o.sin + o.pow;
export function local(Math: { sin: (x: number) => number }) { return Math.sin(1); }
export const { max } = Math;
export const square = (x: number) => x * x;
