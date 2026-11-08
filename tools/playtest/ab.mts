// The WebTransport A/B in real play (KR_WT_SHARE, HOSTING.md "WebTransport"): playtest and diagnostics bundles split
// by the arm their link was in (ctx.game.net, client/src/game/net.ts LinkReport), with the network measures that tell
// the arms apart: input→ack and the hit markers that waited for the server (the link's report), ping and lag-spike
// seconds (the timeline's play seconds after the link opened only, so a warm-up, a practice match or an earlier
// link is not counted to the arm), and where the arm's links settled and why they fell back. --health FILE|URL adds the
// server's own count from /health (transports.arms): links, fallbacks and input gaps per 1000 inputs, which only the
// server sees. Only "wt" and "ws" are the experiment; forced (?wt=1 / ?wt=0) and off links get their own rows.
// Deterministic, reads the bundle folder and the one /health you point it at (a server you run); no callsign, message
// or screenshot reaches the output.
//   npx tsx tools/playtest/ab.mts [--dir DIR] [--health FILE|URL] [--json]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PHASE_PLAY, analyse, bundleFolders, dig, finite, isRec, loadBundle, q, r1, resolveDir, series, sorted, text, type Rec, type Saved } from "./analysis.mts";

export const ARMS = ["wt", "ws", "forced-wt", "forced-ws", "off"] as const;
export type Arm = (typeof ARMS)[number];

/** what one bundle says about its link: null for a bundle without an online link (a practice match, the title) */
export function linkOf(s: Saved) {
  const net = dig(s.ctx, "game", "net");
  const arm = text(dig(net, "arm"), 12) as Arm | null;
  if (!isRec(net) || !arm || !ARMS.includes(arm)) return null;
  const since = finite(net.since), tl = s.bundle.timeline, ti = tl?.fields.indexOf("t") ?? -1;
  const pi = tl?.fields.indexOf("phase") ?? -1;
  const mine = (r: number[]) => (since === null || ti < 0 || r[ti] >= since) && (pi < 0 || r[pi] === PHASE_PLAY);
  const own: Saved = !tl ? s : { ...s, bundle: { ...s.bundle, timeline: { ...tl, rows: tl.rows.filter(mine) } } };
  const sr = series(own), a = analyse(own, sr);
  return {
    arm, player: s.reporter.clientId, since, receivedAt: s.receivedAt, transport: text(net.transport, 4), fallback: text(net.fallback, 20),
    ackP50: finite(dig(net, "ackMs", "p50")), ackP95: finite(dig(net, "ackMs", "p95")), ackN: finite(dig(net, "ackMs", "n")) ?? 0,
    /** deferred markers and the seconds of play they happened in, both counted by the link over its whole life */
    deferred: finite(net.deferred) ?? 0, playS: finite(net.playS) ?? 0,
    /** seconds of the link's part of the timeline spent in a match's play phase (the lag-spike rate's denominator) */
    timelinePlayS: sr.phase.filter((p) => p === PHASE_PLAY).length,
    pingMs: a.network.pingMedianMs, lagS: a.network.lagSpikeSeconds,
  };
}
type Link = NonNullable<ReturnType<typeof linkOf>>;

/** the latest report of each link (one player's link that opened at `since`): its counters are cumulative, so two
 *  reports of one link would count its start twice. The one with the most play and acks; on a tie (a fallback in the
 *  room between them) the one the server received last, since uploads can finish out of order */
export function latestPerLink(links: Link[]) {
  const by = new Map<string, Link>();
  links.forEach((k, i) => {
    const key = k.since === null ? `bundle ${i}` : `${k.player ?? "?"} ${k.since}`, o = by.get(key);
    const newer = !o || (k.playS !== o.playS ? k.playS > o.playS : k.ackN !== o.ackN ? k.ackN > o.ackN : k.receivedAt >= o.receivedAt);
    if (newer) by.set(key, k);
  });
  return [...by.values()];
}

/** one row per arm that has bundles: medians across its links, rates per minute of play */
export function summarise(links: Link[]) {
  return ARMS.map((arm) => {
    const all = links.filter((k) => k.arm === arm), l = latestPerLink(all);
    if (!l.length) return null;
    const med = (xs: (number | null)[]) => r1(q(sorted(xs.filter((x): x is number => x !== null)), 0.5));
    const playMin = l.reduce((n, k) => n + k.playS, 0) / 60, timelineMin = l.reduce((n, k) => n + k.timelinePlayS, 0) / 60;
    const fallbacks: Record<string, number> = {};
    for (const k of l) if (k.fallback) fallbacks[k.fallback] = (fallbacks[k.fallback] ?? 0) + 1;
    return {
      arm, bundles: all.length, links: l.length, players: new Set(l.map((k) => k.player ?? "?")).size,
      onWt: l.filter((k) => k.transport === "wt").length, fallbacks,
      ackP50Ms: med(l.filter((k) => k.ackN > 0).map((k) => k.ackP50)), ackP95Ms: med(l.filter((k) => k.ackN > 0).map((k) => k.ackP95)),
      deferredPerMin: playMin > 0 ? r1(l.reduce((n, k) => n + k.deferred, 0) / playMin) : null,
      pingMs: med(l.map((k) => k.pingMs)), lagSPer10Min: timelineMin > 0 ? r1((l.reduce((n, k) => n + k.lagS, 0) / timelineMin) * 10) : null,
      playMin: r1(playMin),
    };
  }).filter((r) => r !== null);
}

/** the server's side, from a /health: per arm, links, how many settled on wt, fallbacks, and input gaps */
export function serverSide(health: unknown) {
  const arms = dig(health, "transports", "arms");
  if (!isRec(arms)) return [];
  return ARMS.filter((a) => isRec(arms[a])).map((arm) => {
    const a = arms[arm] as Rec, seqs = finite(dig(a, "inputs", "seqs")) ?? 0;
    const ws = dig(a, "settled", "ws"), fallbacks: Record<string, number> = {};
    if (isRec(ws)) for (const [k, v] of Object.entries(ws)) if (typeof v === "number" && v > 0) fallbacks[k] = v;
    const per1000 = (v: unknown) => (seqs > 0 ? r1(((finite(v) ?? 0) / seqs) * 1000) : null);
    return { arm, links: finite(a.links) ?? 0, settledWt: finite(dig(a, "settled", "wt")) ?? 0, fallbacks, inputs: seqs, lostPer1000: per1000(dig(a, "inputs", "lost")), recoveredPer1000: per1000(dig(a, "inputs", "recovered")) };
  }).filter((r) => r.links > 0 || r.inputs > 0);
}

const list = (o: Record<string, number>) => Object.entries(o).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "–";
const cell = (v: unknown) => (v === null || v === undefined ? "–" : String(v));
export function markdown(rows: ReturnType<typeof summarise>, server: ReturnType<typeof serverSide>) {
  const L = ["# WebTransport A/B", "", "Links by arm, each from its latest bundle (the experiment is wt against ws; forced and off links are not in it).", ""];
  L.push("| arm | bundles | links | players | on wt | fallbacks | input→ack p50 ms | input→ack p95 ms | deferred markers / min | ping ms | lag s / 10 min | play min |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) L.push(`| ${r.arm} | ${r.bundles} | ${r.links} | ${r.players} | ${r.onWt} | ${list(r.fallbacks)} | ${cell(r.ackP50Ms)} | ${cell(r.ackP95Ms)} | ${cell(r.deferredPerMin)} | ${cell(r.pingMs)} | ${cell(r.lagSPer10Min)} | ${cell(r.playMin)} |`);
  if (!rows.length) L.push("| (no bundle with an online link) ||||||||||||");
  if (server.length) {
    L.push("", "The server's count (/health transports.arms): every link, not only the ones that sent a bundle.", "");
    L.push("| arm | links | settled on wt | fallbacks | inputs | lost / 1000 | recovered / 1000 |", "|---|---|---|---|---|---|---|");
    for (const r of server) L.push(`| ${r.arm} | ${r.links} | ${r.settledWt} | ${list(r.fallbacks)} | ${r.inputs} | ${cell(r.lostPer1000)} | ${cell(r.recoveredPer1000)} |`);
  }
  return L.join("\n");
}

export function runAb(dir: string, warn: (m: string) => void = (m) => console.error(m)) {
  const links: Link[] = [];
  for (const folder of bundleFolders(dir)) {
    const r = loadBundle(dir, folder);
    if (!r.ok) { warn(`warning: skipping ${folder}: ${r.reason}`); continue; }
    const l = linkOf(r.value); if (l) links.push(l);
  }
  return summarise(links);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
  const dir = resolveDir(opt("--dir")), src = opt("--health");
  const rows = fs.existsSync(dir) ? runAb(dir) : [];
  const health = !src ? null : /^https?:\/\//.test(src) ? await (await fetch(src)).json() : JSON.parse(fs.readFileSync(src, "utf8"));
  const server = serverSide(health);
  console.log(argv.includes("--json") ? JSON.stringify({ bundles: rows, server }, null, 2) : markdown(rows, server));
}
