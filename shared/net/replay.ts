// Replay logs for a Match (off by default: a match records only when a tool or host sets match.rec). A log holds the
// match options and every call from outside that changes how the match plays: human inputs as pushed, inventory ops,
// seats changing hands, START NOW, and each answer the warm-up hold gave. Each entry is stamped with the tick it came at.
// replayMatch re-issues them at the same ticks on a fresh Match, which plays the match again bit for bit on the same JS
// engine. Bots need no log: they follow from the seed and the state. The wire format (proto.ts) is not involved, but
// packLog borrows its input quantizers to write a log about a third the size for a playtest bundle (RE.Packed).
import { Match, type MatchOpts } from "../sim/match";
import { pitchDec, pitchEnc, yawDec, yawEnc } from "./proto";
import { makeInput, type Input } from "../sim/player";
import type { StaticWorld } from "../sim/world";

export const enum RE { Input = 1, Inv = 2, Claim = 3, Release = 4, Reclaim = 5, StartNow = 6, Hold = 7, Packed = 8 }
/** [tick, RE, ...arguments]: Input [id, seq, mx, mz, yaw, pitch, buttons, slot, lerpA, lerpSpan, lerpF], Inv [pid, op, a, b],
 * Claim [name, team], Release [id], Reclaim [id, name], StartNow [], Hold [held 0 / 1], Packed [id, mask, ...codes] (packLog) */
export type ReplayEvent = Array<number | string>;
export type ReplayOpts = Omit<MatchOpts, "world">;
export interface ReplayLog { version: 1; opts: ReplayOpts; warmupS: number; endAfterResults: boolean; ticks: number; events: ReplayEvent[] }

export class ReplayRecorder {
  readonly events: ReplayEvent[] = [];
  constructor(readonly opts: ReplayOpts) {}
  input(tick: number, id: number, i: Input) { this.events.push([tick, RE.Input, id, i.seq, i.mx, i.mz, i.yaw, i.pitch, i.buttons, i.slot, i.lerpA, i.lerpSpan, i.lerpF]); }
  inv(tick: number, pid: number, op: number, a: number, b: number) { this.events.push([tick, RE.Inv, pid, op, a, b]); }
  claim(tick: number, name: string, team: number) { this.events.push([tick, RE.Claim, name, team]); }
  release(tick: number, id: number) { this.events.push([tick, RE.Release, id]); }
  reclaim(tick: number, id: number, name: string) { this.events.push([tick, RE.Reclaim, id, name]); }
  startNow(tick: number) { this.events.push([tick, RE.StartNow]); }
  hold(tick: number, held: boolean) { this.events.push([tick, RE.Hold, held ? 1 : 0]); }
  /** a copy of the log so far: the match at its current tick, outside calls made since its last step included */
  log(m: Match): ReplayLog {
    return { version: 1, opts: this.opts, warmupS: m.warmupS, endAfterResults: m.endAfterResults, ticks: m.tick, events: this.events.slice() };
  }
}

const same = (v: number) => v;
/** each Input field from seq to lerpF as the integer proto.ts quantizes it to, and back */
const CODES: ReadonlyArray<readonly [(v: number) => number, (k: number) => number]> = [
  [same, same], [(v) => Math.round(v * 127), (k) => k / 127], [(v) => Math.round(v * 127), (k) => k / 127], [yawEnc, yawDec], [pitchEnc, pitchDec],
  [same, same], [same, same], [same, same], [same, same], [(v) => Math.round(v * 65535), (k) => k / 65535],
];
/** the code field i takes when a packed input leaves it out: seq counts on, lerpA moves on with the ticks, the rest hold.
 *  prev is the same player's previous input as [tick, ...codes] */
const implied = (prev: number[], i: number, tick: number) => (i === 0 ? prev[1] + 1 : i === 7 ? prev[8] + tick - prev[0] : prev[1 + i]);

/** the log for a playtest bundle: each Input whose fields all decode back from their codes to the same numbers becomes
 *  [tick, RE.Packed, id, mask, ...codes], where bit i of mask says code i is written and a clear bit takes implied().
 *  An Input that doesn't round-trip stays as it is. unpackEvents gives back the same numbers, so the replay is unchanged */
export function packLog(log: ReplayLog): ReplayLog {
  const last = new Map<number, number[]>(), events: ReplayEvent[] = [];
  for (const e of log.events) {
    if (e[1] !== RE.Input) { events.push(e); continue; }
    const tick = e[0] as number, id = e[2] as number, codes: number[] = [];
    for (let i = 0; i < CODES.length; i++) { const v = e[3 + i] as number, k = CODES[i][0](v); if (CODES[i][1](k) !== v) break; codes.push(k); }
    if (codes.length < CODES.length) { events.push(e); last.delete(id); continue; }
    const prev = last.get(id), out: ReplayEvent = [tick, RE.Packed, id, 0];
    let mask = 0;
    for (let i = 0; i < codes.length; i++) if (!prev || codes[i] !== implied(prev, i, tick)) { mask |= 1 << i; out.push(codes[i]); }
    out[3] = mask;
    last.set(id, [tick, ...codes]);
    events.push(out);
  }
  return { ...log, events };
}

/** a log's events with each RE.Packed written out again as the RE.Input it was packed from */
export function unpackEvents(events: readonly ReplayEvent[]): ReplayEvent[] {
  const last = new Map<number, number[]>(), out: ReplayEvent[] = [];
  for (const e of events) {
    if (e[1] === RE.Input) last.delete(e[2] as number);
    if (e[1] !== RE.Packed) { out.push(e); continue; }
    const tick = e[0] as number, id = e[2] as number, mask = e[3] as number, prev = last.get(id), codes: number[] = [];
    for (let i = 0, j = 4; i < CODES.length; i++) {
      if (mask & (1 << i)) codes.push(e[j++] as number);
      else if (prev) codes.push(implied(prev, i, tick));
      else throw new Error(`replay log: packed input ${JSON.stringify(e)} leaves out a field with no earlier input to take it from`);
    }
    last.set(id, [tick, ...codes]);
    out.push([tick, RE.Input, id, ...codes.map((k, i) => CODES[i][1](k))]);
  }
  return out;
}

/** play a log again on a fresh Match and return it at the log's last tick, with the calls made after that tick's step
 * applied (as when the log was taken). onTick sees each tick's events before they
 * are cleared. Throws where the replay stops matching the
 * log (a warm-up hold asked for at another tick), which means the sim or the log changed. */
export function replayMatch(log: ReplayLog, world: StaticWorld, onTick?: (m: Match) => void): Match {
  if (log.version !== 1) throw new Error(`replay log version ${log.version}, this build reads version 1`);
  const m = new Match({ ...log.opts, world });
  m.warmupS = log.warmupS; m.endAfterResults = log.endAfterResults;
  const ev = unpackEvents(log.events), inp = makeInput(), n = (e: ReplayEvent, k: number) => e[k] as number;
  let k = 0;
  m.holdWarmup = () => {
    const e = ev[k];
    if (!e || e[1] !== RE.Hold || e[0] !== m.tick) throw new Error(`replay diverged at tick ${m.tick}: the warm-up hold was asked, the log has ${e ? JSON.stringify(e) : "nothing"} next`);
    k++;
    return e[2] === 1;
  };
  const playCalls = () => {
    for (; k < ev.length && ev[k][0] === m.tick && ev[k][1] !== RE.Hold; k++) {
      const e = ev[k];
      switch (e[1]) {
        case RE.Input:
          inp.seq = n(e, 3); inp.mx = n(e, 4); inp.mz = n(e, 5); inp.yaw = n(e, 6); inp.pitch = n(e, 7); inp.buttons = n(e, 8); inp.slot = n(e, 9); inp.lerpA = n(e, 10); inp.lerpSpan = n(e, 11); inp.lerpF = n(e, 12);
          m.pushInput(n(e, 2), inp); break;
        case RE.Inv: m.inventoryOp(n(e, 2), n(e, 3), n(e, 4), n(e, 5)); break;
        case RE.Claim: m.claimBot(e[2] as string, n(e, 3)); break;
        case RE.Release: m.releaseHuman(n(e, 2)); break;
        case RE.Reclaim: m.reclaimHuman(n(e, 2), e[3] as string); break;
        case RE.StartNow: m.startNow(); break;
        default: throw new Error(`replay log: unknown event ${JSON.stringify(e)}`);
      }
    }
  };
  while (m.tick < log.ticks) {
    playCalls();
    if (k < ev.length && (ev[k][0] as number) < m.tick) throw new Error(`replay diverged at tick ${m.tick}: ${JSON.stringify(ev[k])} was not played`);
    m.step();
    onTick?.(m);
    m.ev.reset();
  }
  playCalls();
  if (k !== ev.length) throw new Error(`replay ended at tick ${m.tick} with ${ev.length - k} log events not played`);
  return m;
}
