// The playtest chunk, loaded after boot on every game page. When the perf HUD (?perfhud) or player diagnostics (?diag,
// or a build made with VITE_KR_DIAG=1) is on, it starts the metrics recorder, has the match record its input replay
// (__kr.recordReplay, read by game/net.ts, which hands it over packed) and gives KONGBOT reports a bundle. Under
// diagnostics, report.ts adds the player's send sheet and auto.ts the automatic summaries. F8 marks a moment under ?perfhud.
import type { Engine } from "../engine/engine";
import { flag, flagQuery } from "../flags";
import { diagOn } from "./beat";
import type { ReplayLog } from "../../../shared/net/replay";

/** MAX_REPLAY_EVENTS: server/playtest-bundles.ts refuses a whole bundle whose replay holds more events */
const MARK_GAP_MS = 5000, MAX_REPLAY_CHARS = 6_000_000, MAX_REPLAY_EVENTS = 200_000, FLAG_NAME = /^[A-Za-z0-9_-]{1,40}$/;

interface Kr {
  playtest?: { timeline: () => unknown };
  replayLog?: () => ReplayLog;
  playtestBundle?: () => unknown;
  recordReplay?: boolean;
  diag?: { snapshot: () => unknown };
  kongbot?: { mark: (message: string) => boolean };
  game?: { inMatch?: boolean; cm?: { time: number } | null };
}
const kr = () => (window as unknown as { __kr: Kr }).__kr;

const marking = { on: false };

function bundle() {
  const K = kr(), log = K.replayLog?.(), replay = log && log.events.length <= MAX_REPLAY_EVENTS ? log : null, mark = marking.on;
  marking.on = false;
  const flags = Object.fromEntries(Object.entries(flagQuery).filter(([k, v]) => FLAG_NAME.test(k) && v.length <= 500).slice(0, 200));
  const json = replay ? JSON.stringify(replay, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v)) : null;
  return { mark, timeline: K.playtest?.timeline() ?? null, flags, replay: json && json.length <= MAX_REPLAY_CHARS ? JSON.parse(json) : null };
}

function markMessage(): string {
  const cm = kr().game?.inMatch ? kr().game?.cm : null;
  const where = cm ? `in match at ${Math.floor(cm.time / 60)}:${String(Math.floor(cm.time % 60)).padStart(2, "0")}` : "outside a match";
  return `F8 mark ${where} (page ${Math.round(performance.now() / 1000)} s)`;
}

export function installPlaytest(engine: Engine, game: boolean): void {
  const hud = flag("perfhud"), diag = diagOn();
  if (!game || (!hud && !diag)) return;
  if (!flag("notimer")) engine.timeGpu();
  kr().recordReplay = true;
  kr().playtestBundle = bundle;
  void Promise.all([import("./recorder"), hud ? import("./perf-hud") : null, diag ? import("./diag") : null, diag ? import("./report") : null, diag ? import("./auto") : null]).then(([rec, hudMod, diagMod, reportMod, autoMod]) => {
    const draw = hudMod?.installPerfHud(rec.ring), sample = diagMod?.installDiag(engine, rec.ring), auto = autoMod?.installAuto(engine, rec.ring);
    if (diagMod) kr().diag = { snapshot: diagMod.snapshot };
    rec.startRecorder(engine, (at) => { draw?.(at); sample?.(at); auto?.(at); });
    reportMod?.installReport();
  });
  if (!hud) return;
  let lastMark = -Infinity;
  addEventListener("keydown", (e) => {
    if (e.code !== "F8") return;
    e.preventDefault();
    const now = performance.now();
    if (e.repeat || now - lastMark < MARK_GAP_MS) return;
    lastMark = now;
    marking.on = true;
    if (!kr().kongbot?.mark(markMessage())) marking.on = false;
  }, true);
}
