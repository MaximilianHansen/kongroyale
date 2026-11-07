// The display's refresh rate, estimated from requestAnimationFrame timestamps. The engine uses it as the default frame
// cap and the dynamic-resolution target; the video menu and KONGBOT reports show it.

/** Percentile of the intervals read as the period. A frame that misses vsync is presented one or more whole periods
 *  later, never earlier, so the fast tail of the rAF intervals is the period itself however slow the game runs on
 *  average. The 20th percentile used before read a GPU-bound 21 fps match on a 60 Hz screen as 30 Hz. At 5 %,
 *  at least 5 of every 90 frames must make vsync; fewer read as a fraction of the refresh, as no frame making it does. */
export const REFRESH_TAIL_PCT = 5;
const SNAP_HZ = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 175, 180, 200, 240, 280, 300, 360, 480, 500];

/** refresh (Hz) from rAF intervals (ms), snapped to a common display rate when within 4 % (at least 3 Hz) of one */
export function refreshFromIntervals(intervalsMs: readonly number[]): number {
  const s = [...intervalsMs].sort((a, b) => a - b);
  const hz = Math.round(1000 / s[Math.floor((s.length * REFRESH_TAIL_PCT) / 100)]);
  const snap = SNAP_HZ.reduce((a, b) => Math.abs(b - hz) < Math.abs(a - hz) ? b : a);
  return Math.abs(snap - hz) <= Math.max(3, hz * 0.04) ? snap : hz;
}
