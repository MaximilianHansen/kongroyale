// The display's refresh rate, estimated from requestAnimationFrame timestamps. The engine uses it as the default frame
// cap and the dynamic-resolution target; the video menu and KONGBOT reports show it. A sample is steady or uneven: a
// steady one (the frames kept pace) reads its mean, an uneven one (a game missing vsync) its fast tail, and
// RefreshEstimate holds an uneven reading under the highest steady one on the screen, since Safari's timestamps under
// an uneven load carry a fast tail that is no period at all.

/** Percentile of the intervals read as the period. A frame that misses vsync is presented one or more whole periods
 *  later, never earlier, so the fast tail of the rAF intervals is the period itself however slow the game runs on
 *  average. The 20th percentile used before read a GPU-bound 21 fps match on a 60 Hz screen as 30 Hz. At 5 %,
 *  at least 5 of every 90 frames must make vsync; fewer read as a fraction of the refresh, as no frame making it does. */
export const REFRESH_TAIL_PCT = 5;
/** a sample whose median interval is within this factor of its fast tail, with no vsync skipped in its slowest 5 %
 *  (SKIP_RATIO), is steady: it reads its mean interval between the 5th and 95th percentiles. Safari's rAF timestamp is
 *  when the rendering update started, not the vsync: idle they spread about ±3 ms (a 13-15 ms fast tail on a 60 Hz
 *  screen, which read 67-77 Hz), and under an uneven load an update that starts late is followed by one a few ms after
 *  the next vsync, so the fast tail read 100-144 Hz on a 60 Hz screen (RAY-186, the guard's A/B). Each callback takes
 *  its own vsync, so the mean interval is the period when none is skipped and longer when some are: a steady reading
 *  errs low, never high, whatever shape the jitter has */
export const STEADY_RATIO = 1.4;
/** a sample whose 95th-percentile interval is past this factor of its median skipped vsyncs, so it is uneven */
export const SKIP_RATIO = 1.5;
/** a steady reading under this could be a game held at half rate rather than the display, so it sets no ceiling */
export const CEILING_MIN_HZ = 50;
/** WebKit renders a page near 60 fps by default ("Prefer Page Rendering Updates near 60fps", on unless turned off under
 *  Develop > Feature Flags), so in Safari an uneven sample reads at most this until a steady one shows more. No steady
 *  sample came in a whole Safari practice match at High: the loading and the title are uneven too (RAY-224) */
export const WEBKIT_CEILING_HZ = 60;
const SNAP_HZ = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 175, 180, 200, 240, 280, 300, 360, 480, 500];

/** one sample of rAF intervals (ms): the refresh it reads (Hz, snapped to a common display rate when within 4 %, at
 *  least 3 Hz, of one) and whether it was steady */
export function refreshSample(intervalsMs: readonly number[]): { hz: number; steady: boolean } {
  const s = [...intervalsMs].sort((a, b) => a - b);
  const lo = Math.floor((s.length * REFRESH_TAIL_PCT) / 100), hi = Math.floor(s.length * 0.95);
  const tail = s[lo], med = s[s.length >> 1], steady = med <= tail * STEADY_RATIO && s[hi] <= med * SKIP_RATIO;
  let mean = 0;
  for (let i = lo; i < hi; i++) mean += s[i] / (hi - lo);
  const hz = Math.round(1000 / (steady ? mean : tail));
  const snap = SNAP_HZ.reduce((a, b) => Math.abs(b - hz) < Math.abs(a - hz) ? b : a);
  return { hz: Math.abs(snap - hz) <= Math.max(3, hz * 0.04) ? snap : hz, steady };
}

/** refresh (Hz) from rAF intervals (ms) */
export function refreshFromIntervals(intervalsMs: readonly number[]): number {
  return refreshSample(intervalsMs).hz;
}

/** the engine's running estimate: a steady sample reads as it is, and an uneven one at most the ceiling, the highest
 *  steady reading of CEILING_MIN_HZ or more on the same screen (its size and position among the screens, so a move to a
 *  same-sized screen starts over), or the base ceiling before one. The ceiling only rises on one screen: a faster
 *  refresh mode set in place reads low until a steady sample shows it, and a slower one still reads right on steady
 *  samples */
export class RefreshEstimate {
  private ceilHz = 0;
  private screen = "";
  /** baseCeilHz: the ceiling before any steady sample (WEBKIT_CEILING_HZ in Safari, 0 = none) */
  constructor(private readonly baseCeilHz = 0) {}
  /** take a sample of rAF intervals (ms) on the screen with this key (its size and position); the new estimate (Hz) */
  add(intervalsMs: readonly number[], screen: string): number {
    if (screen !== this.screen) { this.screen = screen; this.ceilHz = 0; }
    const s = refreshSample(intervalsMs);
    if (s.steady && s.hz >= CEILING_MIN_HZ) this.ceilHz = Math.max(this.ceilHz, s.hz);
    const ceil = this.ceilHz || this.baseCeilHz;
    return s.steady || !ceil ? s.hz : Math.min(s.hz, ceil);
  }
}
