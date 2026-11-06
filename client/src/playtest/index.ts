import type { Engine } from "../engine/engine";
import { flag, flagQuery } from "../flags";

const MARK_GAP_MS = 5000, MAX_REPLAY_CHARS = 6_000_000, FLAG_NAME = /^[A-Za-z0-9_-]{1,40}$/;

interface Kr {
  playtest?: { timeline: () => unknown };
  replayLog?: () => { opts: Record<string, unknown> };
  playtestBundle?: () => unknown;
  kongbot?: { mark: (message: string) => boolean };
  game?: { inMatch?: boolean; cm?: { time: number } | null };
}
const kr = () => (window as unknown as { __kr: Kr }).__kr;

const marking = { on: false };

function bundle() {
  const K = kr(), replay = K.replayLog?.() ?? null, mark = marking.on;
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
  if (!game || !flag("perfhud")) return;
  void import("./perf-hud").then((m) => m.installPerfHud(engine));
  kr().playtestBundle = bundle;
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
