// The server's input-pacing report: how often a live human's input queue ran dry, so that player froze on
// the server for a tick, and how big the catch-up bursts after it were (the warp everyone else sees). One shape for
// /health, netlab and bench:server. It counts through Match.inputProbe, so the client bundle, which runs Match
// offline, carries one call site and none of this.
import { INPUT_STARVE_TICKS, MAX_PLAYERS } from "../sim/const";
import type { Match } from "../sim/match";

/** what trackInputGaps reports: liveTicks = human ticks whose link was live (the seat's human has sent an input, and its
 *  queue has been empty for at most INPUT_STARVE_TICKS); inputGapTicks = live ticks with an empty queue, as a share over
 *  every human and for the worst seat; catchupBursts / catchupBurstMax = ticks right after an empty one that ran more
 *  than one queued input, and the most (a drift credit's extra input on a backlogged queue is not a catch-up) */
export interface InputGapReport { liveTicks: number; inputGapTicks: number; inputGapTicksPct: number; worstPlayerGapPct: number; catchupBursts: number; catchupBurstMax: number }

/** count input gaps on match `m` from now on; report() reads the totals so far */
export function trackInputGaps(m: Match): { report(): InputGapReport } {
  const live = new Int32Array(MAX_PLAYERS), gap = new Int32Array(MAX_PLAYERS), dry = new Uint8Array(MAX_PLAYERS);
  let liveTicks = 0, inputGapTicks = 0, catchupBursts = 0, catchupBurstMax = 0;
  m.inputProbe = (id, n, starve, queued) => {
    if (n > 1 && dry[id]) { catchupBursts++; if (n > catchupBurstMax) catchupBurstMax = n; }
    dry[id] = n === 0 ? 1 : 0;
    if (queued <= 0 || starve > INPUT_STARVE_TICKS) return;
    liveTicks++; live[id]++;
    if (n === 0) { inputGapTicks++; gap[id]++; }
  };
  return {
    report() {
      let worstPlayerGapPct = 0;
      for (let id = 0; id < MAX_PLAYERS; id++) if (live[id] > 0) worstPlayerGapPct = Math.max(worstPlayerGapPct, (100 * gap[id]) / live[id]);
      return { liveTicks, inputGapTicks, inputGapTicksPct: liveTicks ? (100 * inputGapTicks) / liveTicks : 0, worstPlayerGapPct, catchupBursts, catchupBurstMax };
    },
  };
}
