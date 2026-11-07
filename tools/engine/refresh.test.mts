// The display refresh estimate (client/src/engine/refresh.ts): a slow, GPU-bound game must not read as a slow display.
import assert from "node:assert/strict";
import { refreshFromIntervals } from "../../client/src/engine/refresh";

const vsync = (hz: number, periods: number[]) => periods.map((k, i) => (k * 1000) / hz + (i % 3 === 0 ? 0.05 : i % 3 === 1 ? -0.05 : 0));
const repeat = (pattern: number[], n: number) => Array.from({ length: n }, (_, i) => pattern[i % pattern.length]);

// a steady display at each common rate
for (const hz of [60, 75, 120, 144, 165, 240]) assert.equal(refreshFromIntervals(vsync(hz, repeat([1], 90))), hz, hz + " Hz steady");
// a display that really paces rAF at 30 Hz (Low Power Mode, a 30 Hz panel) still reads 30
assert.equal(refreshFromIntervals(vsync(30, repeat([1, 1, 2], 90))), 30, "30 Hz pacing");
// a GPU-bound match at ~21 fps on a 60 Hz screen, where 1 frame in 10 makes vsync and the rest take 2-4 periods
assert.equal(refreshFromIntervals(vsync(60, repeat([1, 2, 3, 3, 2, 3, 4, 3, 2, 3], 90))), 60, "slow game on 60 Hz");
// the same on a 120 Hz ProMotion screen
assert.equal(refreshFromIntervals(vsync(120, repeat([1, 4, 6, 5, 6, 4, 6, 5, 6, 5], 90))), 120, "slow game on 120 Hz");
// a real 21 fps playtest on a 60 Hz screen: the last 2 s of frame intervals (callback times, so not vsync-aligned) still read 60, not 30
const playtest = [62, 17, 67, 35, 41, 42, 50, 39, 61, 50, 50, 50, 75, 80, 48, 37, 20, 17, 17, 28, 17, 32, 32, 34, 20, 33, 25, 40, 20, 37, 29, 27, 25, 31, 36, 16, 46, 19, 32, 32, 33, 33, 34, 32];
assert.equal(refreshFromIntervals(repeat(playtest, 90)), 60, "playtest frames");
// an unusual rate passes through unsnapped
assert.equal(refreshFromIntervals(repeat([1000 / 85], 90)), 85, "85 Hz");
console.log("refresh: ok");
