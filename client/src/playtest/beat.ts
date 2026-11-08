// The start of the diagnostics heartbeat (?diag, and by default the automatic summaries), in the boot chunk: main.ts calls startBeat() as soon as the
// boot JS has run, before the world loads and before the lazy diag chunk arrives (later on a slow link, where it queues
// behind the world's downloads), so a tab killed during load (an out-of-memory kill on Safari) leaves a record that a
// later load reports. The page takes its session's Web Lock first and writes its first beat inside the lock, so a
// slow boot never looks dead to another tab. The pagehide and pageshow listeners mark the record clean and running
// again from here on. diag.ts (lazy) keeps the beat current every 5 s and finds the dead sessions; diagOn() (the send
// sheet and crash card too) and summariesOn() (recorder, heartbeat, automatic summaries) are the switches both chunks read. Model: tools/formal/DiagHeartbeat.tla.
import { flag } from "../flags";
import { autoOn } from "./consent";

export const BEAT_KEY = "kr.diag.hb.";

export interface Beat { v: 1; sid: string; at: number; upS: number; phase: number; x: number | null; z: number | null; poi: string | null; heapMB: number; textures: number; geometries: number; fps: number; hidden: boolean; clean: boolean }
export interface Locks { request(name: string, task: () => Promise<unknown>): Promise<unknown>; query(): Promise<{ held?: Array<{ name?: string }> }> }
export const locks = (navigator as unknown as { locks?: Locks }).locks;

export const sid = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
/** this session's record; diag.ts updates its fields and writes it */
export const beat: Beat = { v: 1, sid, at: Date.now(), upS: 0, phase: -1, x: null, z: null, poi: null, heapMB: -1, textures: 0, geometries: 0, fps: 0, hidden: false, clean: false };
/** settles once this page holds its session's lock and its first beat is written */
export const live = { done: Promise.resolve() };

/** ?diag or ?diag=1 on, ?diag=0 off, absent = the build's VITE_KR_DIAG */
export function diagOn(): boolean {
  const v = flag("diag");
  if (v !== null) return v !== "0";
  return (import.meta as unknown as { env?: { VITE_KR_DIAG?: string } }).env?.VITE_KR_DIAG === "1";
}

/** the automatic summaries' default: a production build with no ?diag in the URL, outside automation
 *  (navigator.webdriver, so no harness, bench or CI job ever sends). The Settings row shows wherever this holds. */
export const summariesDefault = (): boolean =>
  flag("diag") === null && (import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD === true && !navigator.webdriver;

/** the page records and sends summaries: full diagnostics (diagOn), or the default for a player who has not turned them
 *  off and whose browser sends no privacy signal. Under the signal, or after Settings off, nothing starts or is stored. */
export const summariesOn = (): boolean => diagOn() || (summariesDefault() && autoOn());

export function writeBeat(b: Beat): void {
  if (!locks) return;
  try {
    if (!diagOn() && !autoOn()) { localStorage.removeItem(BEAT_KEY + b.sid); return; }
    localStorage.setItem(BEAT_KEY + b.sid, JSON.stringify(b));
  } catch { /* storage full or blocked: no crash evidence */ }
}

/** hold this session's Web Lock for the page's whole life, then write its first beat: a session whose page holds no
 *  lock is not running. Browsers without Web Locks keep no heartbeat. */
export function startBeat(): void {
  if (!locks) return;
  const held = locks;
  live.done = new Promise((done) => { void held.request(BEAT_KEY + sid, () => { writeBeat(beat); done(); return new Promise(() => {}); }); });
  addEventListener("pagehide", () => { beat.clean = true; beat.at = Date.now(); writeBeat(beat); });
  addEventListener("pageshow", (e) => { if (e.persisted) { beat.clean = false; writeBeat(beat); } });
}
