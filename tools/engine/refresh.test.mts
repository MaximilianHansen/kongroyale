// The display refresh estimate (client/src/engine/refresh.ts): a slow, GPU-bound game must not read as a slow display.
import assert from "node:assert/strict";
import { RefreshEstimate, WEBKIT_CEILING_HZ, refreshFromIntervals, refreshSample } from "../../client/src/engine/refresh";

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
// Safari 27 on a 60 Hz screen (the Mac mini, RAY-186 guard A/B): rAF timestamps are when each update started, so they
// spread about ±3 ms. The engine suspended (the harness's rAF probe): steady samples, read by their mean, not their
// 13-14 ms fast tail (71-77 Hz)
const safariIdle = [16, 17, 17, 17, 19, 14, 17, 19, 15, 17, 16, 16, 18, 16, 15, 18, 17, 19, 14, 17, 15, 18, 19, 14, 17, 18, 15, 17, 15, 18, 19, 15, 16, 17, 17, 18, 15, 17, 18, 16, 20, 12, 17, 17, 16, 17, 17, 16, 19, 15, 17, 15, 18, 17, 15, 16, 19, 14, 17, 17, 18, 18, 15, 17, 17, 16, 19, 15, 17, 16, 17, 17, 16, 17, 18, 16, 19, 12, 18, 17, 15, 18, 17, 16, 18, 16, 15, 18, 17, 17];
assert.deepEqual(refreshSample(safariIdle), { hz: 60, steady: true }, "Safari idle");
const safariIdle2 = [17, 19, 13, 18, 17, 16, 19, 13, 18, 17, 16, 16, 18, 17, 18, 15, 17, 15, 18, 17, 16, 17, 17, 16, 19, 15, 17, 16, 17, 18, 13, 19, 18, 15, 16, 17, 16, 20, 14, 18, 16, 15, 19, 16, 17, 18, 16, 17, 15, 16, 19, 15, 17, 15, 16, 19, 16, 17, 17, 16, 19, 15, 17, 16, 16, 20, 14, 17, 17, 15, 18, 16, 17, 19, 13, 18, 17, 16, 20, 14, 17, 18, 14, 21, 13, 16, 20, 13, 16, 19];
assert.deepEqual(refreshSample(safariIdle2), { hz: 60, steady: true }, "Safari idle, a 13 ms tail");
// a match at about 47 fps under the half-rate guard: a late update is followed by one a few ms after the next vsync,
// so a third of the intervals are 7-12 ms and the fast tail reads over 100 Hz
const safariUneven = [15, 30, 8, 31, 14, 29, 9, 29, 16, 28, 12, 27, 17, 27, 9, 30, 17, 28, 8, 31, 17, 26, 7, 35, 15, 29, 9, 31, 14, 30, 7, 30, 16, 29, 9, 29, 17, 29, 9, 29, 16, 29, 7, 31, 16, 27, 11, 29, 17, 28, 8, 31, 16, 27, 13, 27, 16, 28, 8, 33, 15, 28, 7, 31, 17, 28, 8, 31, 17, 16, 19, 15, 19, 31, 16, 17, 17, 28, 7, 31, 17, 29, 12, 26, 16, 29, 8, 30, 16, 29];
const uneven = refreshSample(safariUneven);
assert.ok(!uneven.steady && uneven.hz > 100, "Safari uneven: " + JSON.stringify(uneven));
// the same match at half rate (main, no guard): uneven, and its tail is the period
const safariHalf = [21, 31, 33, 19, 31, 34, 33, 16, 32, 37, 16, 32, 36, 17, 31, 33, 31, 19, 33, 32, 19, 33, 33, 20, 33, 30, 33, 19, 32, 33, 20, 30, 32, 36, 16, 33, 31, 22, 30, 33, 33, 17, 34, 33, 18, 32, 33, 20, 30, 34, 33, 17, 33, 33, 18, 32, 33, 21, 30, 34, 33, 17, 33, 34, 17, 33, 33, 19, 31, 34, 23, 26, 34, 33, 18, 32, 31, 22, 30, 34, 34, 17, 30, 35, 21, 30, 31, 37, 16, 32];
assert.deepEqual(refreshSample(safariHalf), { hz: 60, steady: false }, "Safari half rate");
// 50 fps on a 60 Hz screen, one vsync skipped in five: uneven, and its tail is the period
assert.deepEqual(refreshSample(vsync(60, repeat([1, 1, 1, 1, 2], 90))), { hz: 60, steady: false }, "50 fps on 60 Hz");
// jitter skewed to one side (a few early timestamps, the rest a little late) still reads its mean, the period
assert.deepEqual(refreshSample([...repeat([14], 6), ...repeat([16.9], 84)]), { hz: 60, steady: true }, "skewed jitter");
assert.deepEqual(refreshSample([...repeat([14], 5), ...repeat([17], 85)]), { hz: 60, steady: true }, "whole-ms jitter");
// a tight 20 ms cluster with a few 16.7 ms intervals is a 50 Hz screen's jitter: on a 60 Hz one, 84 callbacks 20 ms
// apart with no vsync skipped would end 280 ms after their vsync. It reads its mean, 50, and not its 60 Hz tail
assert.deepEqual(refreshSample([...repeat([1000 / 60], 6), ...repeat([20], 84)]), { hz: 50, steady: true }, "50 Hz jitter");

// the engine's running estimate, on one screen ("width,height,availLeft,availTop")
const SCREEN = "1920,1080,0,0";
{
  const e = new RefreshEstimate();
  assert.equal(e.add(safariUneven, SCREEN), uneven.hz, "no steady reading yet: the tail, as before");
  assert.equal(e.add(safariIdle, SCREEN), 60);
  assert.equal(e.add(safariUneven, SCREEN), 60, "held under the steady 60");
  assert.equal(e.add(safariHalf, SCREEN), 60);
  assert.equal(e.add(vsync(30, repeat([1], 90)), SCREEN), 30, "a steady 30 reads 30");
  assert.equal(e.add(vsync(60, repeat([1, 2, 3, 3, 2, 3, 4, 3, 2, 3], 90)), SCREEN), 60, "and a slow game after it, its tail");
  assert.equal(e.add(vsync(144, repeat([1, 2, 3, 2], 90)), "1920,1080,1920,0"), 144, "a same-sized screen beside it starts over");
}
// Safari, where no steady sample may ever come (the A/B on the Mac mini: loading, title and a match at High all uneven):
// an uneven sample reads at most WebKit's 60 from the start, and a steady 120 (the 60 fps preference turned off) lifts it
{
  const e = new RefreshEstimate(WEBKIT_CEILING_HZ);
  assert.equal(e.add(safariUneven, SCREEN), 60, "Safari uneven from the start");
  assert.equal(e.add(safariHalf, SCREEN), 60);
  assert.equal(e.add(vsync(120, repeat([1], 90)), SCREEN), 120);
  assert.equal(e.add(vsync(120, repeat([1, 2, 3, 2], 90)), SCREEN), 120, "a slow game at 120 Hz once a steady 120 came");
  assert.equal(e.add(safariUneven, "2560,1440,1920,0"), 60, "another screen starts from WebKit's 60 again");
}
// Safari on a 50 Hz screen: once a steady 50 comes, it is the ceiling, not WebKit's 60
{
  const e = new RefreshEstimate(WEBKIT_CEILING_HZ);
  assert.equal(e.add(vsync(50, repeat([1], 90)), SCREEN), 50);
  assert.equal(e.add(repeat([16, 24, 20, 20, 40], 90), SCREEN), 50, "an uneven sample after it reads at most 50");
}
// a match held at half rate from the first sample: a steady 30 sets no ceiling, so the later tail still reads 60
{
  const e = new RefreshEstimate();
  assert.equal(e.add(vsync(60, repeat([2], 90)), SCREEN), 30);
  assert.equal(e.add(vsync(60, repeat([1, 2, 3, 3, 2, 3, 4, 3, 2, 3], 90)), SCREEN), 60, "recovers from a half-rate start");
}
console.log("refresh: ok");
