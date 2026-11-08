// The page side of the practice host worker (?hostworker=1): an offline practice match's host runs in host.worker.ts
// instead of on this tab's main thread, where its simulation took 5-9 % of busy time. WorkerLink is a Link
// like OfflineLink: the game, the tools and the lifecycle can't tell them apart, except that host tools act a message
// later and hostView is a copy a few ticks old. The worker is started at the title (startHostWorker), owned by the
// "practice-host" resource scope, kept for every practice session of the page, and used only when it built the same
// static world as this page (the hash); otherwise, or once it has failed, practice runs in this tab as before.
//
// Clocks: the worker stamps frames with its own performance.now(), whose origin is the worker's start. WorkerLink moves
// each stamp onto this page's clock (the difference of the two timeOrigins), so the client's jitter buffer sees the
// same ideal tick times as from an in-tab host.
import { resources, type Scope } from "../engine/res/scope";
import { assetUrl } from "../engine/assets";
import { flag } from "../flags";
import { packLog, type ReplayEvent, type ReplayLog, type ReplayOpts } from "../../../shared/net/replay";
import type { BotDifficulty } from "../ui/api";
import type { Link } from "./net";
import type { HostTool, HostView } from "./host-tools";

/** one output of the worker's link, in order: [0, JSON message] or [1, binary frame, host-clock stamp] */
export type OutItem = [0, Record<string, unknown>] | [1, Uint8Array, number | undefined];
/** what the match's replay recorder logged since the last message (opts once, when recording starts); null = stopped */
export type RecPart = { opts?: ReplayOpts; events: ReplayEvent[]; ticks: number; warmupS: number; endAfterResults: boolean } | null;
export type ToHost =
  | { k: "build"; url: string }
  | { k: "open"; sid: number; name: string; botDamageToHumans: number; botAimRange: number; range: boolean; difficulty: BotDifficulty; seed: number; streamed: boolean; record: boolean }
  | { k: "json"; sid: number; o: unknown }
  | { k: "bin"; sid: number; buf: ArrayBuffer }
  | { k: "env"; sid: number; streamed: boolean; record: boolean }
  | { k: "tool"; sid: number; t: HostTool }
  | { k: "watch"; sid: number }
  | { k: "close"; sid: number };
export type FromHost =
  | { k: "ready"; hash: number; origin: number; ms: number }
  | { k: "failed"; error: string }
  /** busyMs: the worker's time in its host pumps so far (all sessions) */
  | { k: "out"; sid: number; items: OutItem[]; rec?: RecPart; view?: HostView; busyMs: number };

/** how often the page tells the worker about its island stream and replay recording (ms) */
const ENV_MS = 100;

type Kr = { recordReplay?: boolean; streamed?: boolean; replayLog?: () => ReplayLog; hostWorker?: Record<string, unknown> };
const kr = () => (globalThis as { __kr?: Kr }).__kr;

class HostWorker {
  current: WorkerLink | null = null;
  private sid = 0;
  constructor(private readonly scope: Scope, private readonly w: Worker, readonly offset: number) {}
  post(m: ToHost, transfer: Transferable[] = []) { this.w.postMessage(m, transfer); }
  link(name: string, range: boolean, difficulty: BotDifficulty): WorkerLink {
    this.current?.close();
    return this.current = new WorkerLink(this, ++this.sid, name, range, difficulty);
  }
  /** the worker died: the session in it ends, and later sessions play in this tab */
  fail(why: string) {
    console.warn("[host-worker] " + why);
    ready = Promise.resolve(null);
    const l = this.current; this.current = null;
    this.scope.dispose();
    l?.lost("practice host failed");
  }
}

let ready: Promise<HostWorker | null> | null = null;

/** start the practice host worker when ?hostworker=1 (idempotent): it builds its world while the title shows */
export function startHostWorker(worldHash: number) {
  if (ready || !flag("hostworker")) return;
  ready = new Promise((resolve) => {
    let hw: HostWorker | null = null;
    const scope = resources.root.child("practice-host");
    const give = (why: string) => { console.warn("[host-worker] " + why + "; practice runs in this tab"); scope.dispose(); resolve(null); };
    let w: Worker;
    try { w = scope.worker(new Worker(new URL("./host.worker.ts", import.meta.url), { type: "module" })); } catch (e) { give(String(e)); return; }
    w.onmessage = (e: MessageEvent<FromHost>) => {
      const d = e.data;
      if (d.k === "out") { hw?.current?.deliver(d); return; }
      if (hw) return;
      if (d.k === "failed") { give("worker failed: " + d.error); return; }
      if (d.hash !== worldHash) { give("worker world " + d.hash + " is not this page's " + worldHash); return; }
      hw = new HostWorker(scope, w, d.origin - performance.timeOrigin);
      const k = kr(); if (k) k.hostWorker = { buildMs: d.ms, get busyMs() { return hw?.current?.busyMs ?? 0; } };
      resolve(hw);
    };
    w.onerror = (e) => { if (hw) hw.fail(String(e.message || e)); else give(String(e.message || e)); };
    const build: ToHost = { k: "build", url: new URL(assetUrl("assets/terrain/island.bin"), location.href).href };
    w.postMessage(build);
  });
}

/** the worker once it holds this page's world, else null (flag off, still failed, another world): play in this tab */
export function hostWorker(): Promise<HostWorker | null> { return ready ?? Promise.resolve(null); }

/** an offline practice session whose host is the worker */
export class WorkerLink implements Link {
  readonly offline = true;
  onJSON: (m: Record<string, unknown>) => void = () => {};
  onBinary: (u8: Uint8Array, at?: number) => void = () => {};
  onClose: (reason: string) => void = () => {};
  /** the worker's time in its host pumps, ms (all sessions so far): the simulation this tab no longer runs */
  busyMs = 0;
  private closed = false;
  private view: HostView = { players: [], vehs: [] }; private watching = false;
  private streamed: boolean; private record: boolean;
  private readonly envTimer: number;
  private rec: Omit<ReplayLog, "version"> | null = null;
  constructor(private readonly hw: HostWorker, private readonly sid: number, name: string, range: boolean, difficulty: BotDifficulty) {
    const k = kr();
    this.streamed = k?.streamed !== false; this.record = !!k?.recordReplay;
    hw.post({ k: "open", sid, name, botDamageToHumans: 1, botAimRange: Infinity, range, difficulty, seed: flag("seed"), streamed: this.streamed, record: this.record });
    this.envTimer = window.setInterval(() => {
      const k = kr(), streamed = k?.streamed !== false, record = !!k?.recordReplay;
      if (streamed === this.streamed && record === this.record) return;
      this.streamed = streamed; this.record = record;
      hw.post({ k: "env", sid, streamed, record });
    }, ENV_MS);
  }
  /** one message of the worker's output (gpu-match times this as the practice host's main-thread cost) */
  deliver(d: Extract<FromHost, { k: "out" }>) {
    if (this.closed || d.sid !== this.sid) return;
    this.busyMs = d.busyMs;
    if (d.view) this.view = d.view;
    if (d.rec !== undefined) this.takeRec(d.rec);
    const off = this.hw.offset;
    for (const it of d.items) {
      if (this.closed) return;
      if (it[0] === 0) this.onJSON(it[1]);
      else this.onBinary(it[1], it[2] ? it[2] + off : it[2]);
    }
  }
  sendJSON(o: unknown) {
    if (this.closed) return;
    if ((o as { t?: string }).t === "leave") { this.close(); return; }
    this.hw.post({ k: "json", sid: this.sid, o });
  }
  sendBinary(u8: Uint8Array) {
    if (this.closed) return;
    const buf = u8.slice().buffer;
    this.hw.post({ k: "bin", sid: this.sid, buf }, [buf]);
  }
  hostTool(t: HostTool) { if (!this.closed) this.hw.post({ k: "tool", sid: this.sid, t }); }
  hostView(): HostView {
    if (!this.watching && !this.closed) { this.watching = true; this.hw.post({ k: "watch", sid: this.sid }); }
    return this.view;
  }
  close() {
    if (this.closed) return;
    this.end();
    this.hw.post({ k: "close", sid: this.sid });
    this.onClose("left");
  }
  /** the worker is gone (HostWorker.fail) */
  lost(reason: string) { if (this.closed) return; this.end(); this.onClose(reason); }
  private end() {
    this.closed = true;
    clearInterval(this.envTimer);
    if (this.hw.current === this) this.hw.current = null;
    if (this.rec) this.takeRec(null);
  }
  private takeRec(p: RecPart) {
    const k = kr();
    if (!p) { this.rec = null; if (k) k.replayLog = undefined; return; }
    if (p.opts) {
      const rec = this.rec = { opts: p.opts, warmupS: 0, endAfterResults: false, ticks: 0, events: [] as ReplayEvent[] };
      if (k) k.replayLog = () => packLog({ version: 1, ...rec });
    }
    const r = this.rec; if (!r) return;
    for (const e of p.events) r.events.push(e);
    r.ticks = p.ticks; r.warmupS = p.warmupS; r.endAfterResults = p.endAfterResults;
  }
}
