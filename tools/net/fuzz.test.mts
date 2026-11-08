// PROTOCOL FUZZ: seeded malformed client→server traffic against the code that reads it. Client packets are read by
// MatchHost.receive (shared/net/host.ts) for binary frames, behind onBinary and onJSON (server/index.ts) on the socket.
// Every packet comes from Rng (shared/sim/rng.ts) with a fixed seed: mostly real encodings (writeInput, writeInputs,
// writeInvOp, a ping) that are then truncated, extended past the largest frame, bit-flipped or given another type
// byte, plus pure noise, so most packets get past the type byte.
//   npx tsx tools/net/fuzz.test.mts                                every layer with its default seeds (about 20 s)
//   npx tsx tools/net/fuzz.test.mts --layer host --seed 7          one layer, one seed: the same packets again
//   npx tsx tools/net/fuzz.test.mts --layer host --seed 7 --ticks 600
// Layers (--layer takes a comma list):
//   decode  readInput / readInputBody / writeInputs (shared/net/proto.ts) and the WebTransport stream's Deframer
//           (shared/net/frames.ts) on their own: any body decodes to sanitised ranges that quantizeInput leaves as they
//           are, a client's input crosses the wire exactly as quantizeInput predicts it, and any chunking of a stream
//           gives back exactly its frames (none longer than the cap, none after a bad length).
//   host    MatchHost.receive on a real Match built like Lobby.start (server/index.ts) builds it, stepped tick by tick, with 3 seated peers,
//           one in the room without a seat and a caster seat sending. Per packet: nothing throws, a frame is accepted
//           exactly when it is well formed, a pong echoes its ping, a frame moves only its own seat's input seq, an
//           inventory op applies once per seq and only to its own seat. Per tick: no NaN or Infinity in any player,
//           vehicle or match number; at most INPUT_MAX_PER_TICK inputs a tick and never more than one a tick plus the
//           drift credits overall; queues within INPUT_QUEUE_MAX; rewound shots within MAX_REWIND_TICKS; slots, ammo,
//           cash, hp and shield within their ranges; a human's pitch within PITCH_MAX and buttons within BUTTON_MASK.
//   server  the real game server (server/index.ts) on a free loopback port, over WebSockets: two seated players, a
//           caster seat, an aux socket and a client that starts in no lobby send fuzzed binary frames and fuzzed JSON
//           (every message type onJSON knows, odd values of t, garbage text, deep nesting) while a third seated player
//           plays normally; then a ping flood past the rate limit, malformed frames within the rate past the strike limit
//           (in no lobby and in a match), a frame past MAX_PAYLOAD and bad aux attaches. Passes when the process stays up
//           with no handler or tick error in its log, every self state in every snapshot is finite, the sockets that kept
//           within the limits stay open, the normal player's inputs keep arriving, the ping flood is closed (1008) after at
//           most RATE_BURST + RATE_PER_S answers a second, the malformed frames are closed (1008 "bad frame"), the big
//           frame is closed (1009) and /health still answers.
// A failure prints the layer, the seed, the packet (hex, or the JSON text) and the command that replays it, and exits 1.
// The decode and host layers replay exactly; the server layer sends the same frames again (with that run's lobby code)
// at wall-clock pace, so its timing differs from run to run.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, type RawData } from "ws";
import {
  BUTTON_MASK, INPUT_BODY_BYTES, INPUT_BYTES, INPUT_WINDOW, INPUTS_HEAD_BYTES, INVOP_BYTES, LERP_SPAN_MAX, M, PITCH_MAX, Reader,
  Writer, makeSelfState, quantizeInput, readInput, readInputBody, readSelf, readSnapHeader, writeInput, writeInputs, writeInvOp,
  type INV, type SelfState, type SnapHeader,
} from "../../shared/net/proto";
import type { HostPeer } from "../../shared/net/host";
import { Deframer, frame } from "../../shared/net/frames";
import { Rng } from "../../shared/sim/rng";
import type { Match } from "../../shared/sim/match";
import { AMMO_TYPES, B, PS, SK, copyInput, giveAmmo, makeInput, type Input, type Player } from "../../shared/sim/player";
import { AMMO_CAP, ECON, INPUT_MAX_PER_TICK, INPUT_QUEUE_MAX, MAX_HP, MAX_REWIND_TICKS, MAX_SHIELD, WEAPON_DEFS, WEAPON_SLOTS } from "../../shared/sim/const";
import { WEAPONS } from "../../shared/world/map";
import { MAX_STRIKES, RATE_BURST, RATE_PER_S } from "../../server/limits";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LAYERS = ["decode", "host", "server"] as const;
type Layer = typeof LAYERS[number];
const DEFAULT_SEEDS: Record<Layer, number[]> = { decode: [1], host: [1, 2, 3], server: [1] };
const DEFAULT_TICKS = 1200;
/** the largest frame MatchHost.receive takes: a full input window */
const MAX_FRAME_BYTES = INPUTS_HEAD_BYTES + INPUT_WINDOW * INPUT_BODY_BYTES;
/** server/index.ts MAX_PAYLOAD: ws closes a socket that sends more in one message */
const MAX_PAYLOAD_BYTES = 16384;
const SERVER_FUZZ_MS = 2000, SEND_EVERY_MS = 10, SERVER_START_MS = 90_000;
/** a seq this close to 2^32 leaves a client nothing higher to send: the host layer seats that player again */
const SEQ_STUCK = 0xffffffff - 4096;

// ---- arguments
const usage = (why: string): never => {
  console.error(`${why}\nusage: npx tsx tools/net/fuzz.test.mts [--layer ${LAYERS.join(",")}] [--seed N] [--ticks N]`);
  process.exit(2);
};
let layers: Layer[] = [...LAYERS], seedArg: number | null = null, ticks = DEFAULT_TICKS;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], v = process.argv[i + 1];
  if (a === "--layer") { layers = (v ?? "").split(",").filter(Boolean) as Layer[]; i++; if (!layers.length || layers.some((l) => !LAYERS.includes(l))) usage(`bad --layer ${v}`); }
  else if (a === "--seed") { seedArg = Number(v); i++; if (!Number.isInteger(seedArg) || seedArg < 0 || seedArg > 0xffffffff) usage(`bad --seed ${v}`); }
  else if (a === "--ticks") { ticks = Number(v); i++; if (!Number.isInteger(ticks) || ticks < 1) usage(`bad --ticks ${v}`); }
  else usage(`unknown argument ${a}`);
}
const seedsOf = (l: Layer) => (seedArg === null ? DEFAULT_SEEDS[l] : [seedArg]);
const replay = (l: Layer, seed: number) => `npx tsx tools/net/fuzz.test.mts --layer ${l} --seed ${seed}${l === "host" && ticks !== DEFAULT_TICKS ? ` --ticks ${ticks}` : ""}`;

class FuzzFail extends Error {}
const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join(" ") || "(empty)";
function fail(layer: Layer, seed: number, what: string, packet?: { bytes: Uint8Array; label: string }): never {
  const lines = [`FUZZ FAILED (${layer}, seed ${seed}): ${what}`];
  if (packet) lines.push(`  packet: ${packet.label}`, `  bytes (${packet.bytes.length}): ${hex(packet.bytes)}`);
  lines.push(`  replay: ${replay(layer, seed)}`);
  throw new FuzzFail(lines.join("\n"));
}

// ---- the packet generator: every choice comes from the Rng it is given
type Kind = "input" | "inputs" | "invop" | "ping" | "noise";
type How = "valid" | "trunc" | "extend" | "flip" | "retype" | "noise";
interface Packet { kind: Kind; how: How; bytes: Uint8Array }
const W = new Writer(new ArrayBuffer(8192));
const u32 = (r: Rng) => Math.floor(r.next() * 4294967296);
/** numbers a broken client may put in a field before the writer encodes it */
const EDGE = [0, -0, 1, -1, 0.5, Math.PI, -Math.PI, 2 * Math.PI, PITCH_MAX, -PITCH_MAX, 1.6, 1e9, -1e9, 1e308, -1e308, 5e-324, 2 ** 31, 2 ** 32, 2 ** 32 - 1, NaN, Infinity, -Infinity];
const PLAY_BUTTONS = [B.FIRE, B.FIRE, B.JUMP, B.CROUCH, B.SPRINT, B.RELOAD, B.USE, B.SCOPE, B.GLIDER, B.THROW];
const num = (r: Rng, lo: number, hi: number) => (r.int(5) === 0 ? EDGE[r.int(EDGE.length)] : r.range(lo, hi));
function fuzzInput(r: Rng, seq: number, into = makeInput()): Input {
  into.seq = seq; into.mx = num(r, -1, 1); into.mz = num(r, -1, 1); into.yaw = num(r, -Math.PI, Math.PI); into.pitch = num(r, -PITCH_MAX, PITCH_MAX);
  // buttons as a player holds them (fire, move keys, use) half the time, else any bits; the slot mostly stays put
  const k = r.int(4);
  into.buttons = k === 0 ? r.int(65536) : k === 1 ? 1 << r.int(16) : PLAY_BUTTONS.reduce((b, bit) => (r.int(10) < 3 ? b | bit : b), 0);
  into.slot = r.int(32) === 0 ? r.int(256) : r.int(64) === 0 ? r.int(WEAPON_SLOTS) : 0;
  into.lerpA = r.int(4) === 0 ? u32(r) : r.int(100_000); into.lerpSpan = r.int(4) === 0 ? r.int(256) : r.int(LERP_SPAN_MAX + 1); into.lerpF = num(r, 0, 1);
  return into;
}
/** a seq near the client's next one, now and then far off */
function seqNear(r: Rng, next: number): number {
  const k = r.int(200);
  if (k < 170) return next;
  if (k < 199) return Math.max(0, next + r.int(61) - 30);
  return [0, 1, 0xffffffff, u32(r)][r.int(4)];
}
const RING: Input[] = Array.from({ length: 255 }, () => makeInput());
/** a real encoding of `kind` written with the proto.ts writers */
function encode(r: Rng, kind: Kind, nextSeq: number, nextOp: number): Uint8Array {
  W.reset();
  if (kind === "input") writeInput(W, fuzzInput(r, seqNear(r, nextSeq)));
  else if (kind === "inputs") {
    const count = r.int(10) === 0 ? [0, INPUT_WINDOW + 1, 64, 255][r.int(4)] : 1 + r.int(INPUT_WINDOW);
    const last = seqNear(r, nextSeq), first = Math.max(0, last - count + 1);
    for (let k = 0; k < count; k++) fuzzInput(r, 0, RING[k]);
    writeInputs(W, RING.slice(0, Math.max(1, count)), first, count);
  } else if (kind === "invop") {
    const seq = r.int(10) === 0 ? r.int(65536) : r.int(10) === 0 ? nextOp - 1 : nextOp;
    writeInvOp(W, seq, (r.int(8) === 0 ? r.int(256) : 1 + r.int(4)) as INV, r.int(4) === 0 ? r.int(256) : r.int(WEAPON_SLOTS + 1), r.int(4) === 0 ? r.int(256) : r.int(WEAPON_SLOTS + 1));
  } else if (kind === "ping") W.u8(M.Ping).f64(r.int(3) === 0 ? EDGE[r.int(EDGE.length)] : r.range(0, 1e7));
  return W.bytes();
}
/** one packet: a real encoding as it is or broken one way (an extension sometimes past the largest frame), or noise */
function makePacket(r: Rng, kind: Kind, nextSeq: number, nextOp: number): Packet {
  if (kind === "noise") {
    const b = new Uint8Array(r.int(8) === 0 ? 0 : 1 + r.int(48));
    for (let i = 0; i < b.length; i++) b[i] = r.int(256);
    if (b.length && r.int(2) === 0) b[0] = 1 + r.int(4);
    return { kind, how: "noise", bytes: b };
  }
  const v = encode(r, kind, nextSeq, nextOp), k = r.int(100);
  if (k < 40) return { kind, how: "valid", bytes: v };
  if (k < 52) return { kind, how: "trunc", bytes: v.slice(0, r.int(v.length)) };
  if (k < 64) {
    const extra = r.int(4) === 0 ? Math.max(1, MAX_FRAME_BYTES + 1 - v.length + r.int(64)) : 1 + r.int(32);
    const b = new Uint8Array(v.length + extra); b.set(v);
    for (let i = v.length; i < b.length; i++) b[i] = r.int(256);
    return { kind, how: "extend", bytes: b };
  }
  if (k < 90) {
    const b = v.slice(), n = 1 + r.int(6);
    for (let i = 0; i < n; i++) { const at = r.int(b.length); b[at] ^= 1 << r.int(8); }
    return { kind, how: "flip", bytes: b };
  }
  const b = v.slice(); b[0] = [M.Input, M.Ping, M.InvOp, M.Inputs, 0, 5, M.Snapshot, M.Events, M.Inventory, M.Pong, M.CastSnap, M.CastStats, 255, r.int(256)][r.int(14)];
  return { kind, how: "retype", bytes: b };
}
const pickKind = (r: Rng): Kind => { const k = r.int(20); return k < 7 ? "input" : k < 12 ? "inputs" : k < 16 ? "invop" : k < 18 ? "ping" : "noise"; };

/** per layer: packets per kind, and how many the code under test accepted */
const tallies = new Map<string, { n: number; ok: number; how: Record<string, number> }>();
function tally(layer: string, kind: string, how: string, ok: boolean) {
  const key = `${layer}:${kind}`; let t = tallies.get(key);
  if (!t) { t = { n: 0, ok: 0, how: {} }; tallies.set(key, t); }
  t.n++; if (ok) t.ok++; t.how[how] = (t.how[how] ?? 0) + 1;
}

// ---- decode layer
const f64At = (u8: Uint8Array, at: number) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getFloat64(at, true);
const u32At = (u8: Uint8Array, at: number) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(at, true);
const INPUT_FIELDS = ["seq", "mx", "mz", "yaw", "pitch", "buttons", "slot", "lerpA", "lerpSpan", "lerpF"] as const;
/** what readInputBody promises the server: every field finite and in its range */
function bodyProblem(i: Input): string | null {
  for (const k of INPUT_FIELDS) if (!Number.isFinite(i[k])) return `${k} = ${i[k]}`;
  if (i.mx < -1 || i.mx > 1 || i.mz < -1 || i.mz > 1) return `stick (${i.mx}, ${i.mz}) outside -1..1`;
  if (i.yaw < -Math.PI || i.yaw > Math.PI) return `yaw ${i.yaw} outside -π..π`;
  if (Math.abs(i.pitch) > PITCH_MAX) return `pitch ${i.pitch} past PITCH_MAX`;
  if (!Number.isInteger(i.buttons) || i.buttons < 0 || (i.buttons & ~BUTTON_MASK) !== 0) return `buttons ${i.buttons} outside BUTTON_MASK`;
  if (!Number.isInteger(i.slot) || i.slot < 0 || i.slot > 255) return `slot ${i.slot}`;
  if (!Number.isInteger(i.lerpA) || i.lerpA < 0 || i.lerpA > 0xffffffff) return `lerpA ${i.lerpA}`;
  if (!Number.isInteger(i.lerpSpan) || i.lerpSpan < 0 || i.lerpSpan > LERP_SPAN_MAX) return `lerpSpan ${i.lerpSpan}`;
  if (i.lerpF < 0 || i.lerpF > 1) return `lerpF ${i.lerpF}`;
  return null;
}
/** the field two inputs differ in. === on purpose: the wire carries no −0 (an i8 / i16 field), so a −0 (which no client
 *  input holds) comes back +0, the same number to every comparison the sim makes */
const sameInput = (a: Input, b: Input) => INPUT_FIELDS.find((k) => a[k] !== b[k]) ?? null;
/** a client never holds a non-finite number or a lerpA past u32 (its snapshot tick) */
function clientDomain(i: Input) { for (const k of INPUT_FIELDS) if (!Number.isFinite(i[k])) i[k] = 0; i.lerpA = Math.min(i.lerpA, 0xffffffff); }

function runDecode(seed: number) {
  const r = new Rng(seed), got = makeInput(), q = makeInput(), src = makeInput();
  // 1. any 21-byte M.Input (noise, or a real one bit-flipped) decodes to sanitised fields that are already quantised
  for (let n = 0; n < 40_000; n++) {
    let bytes: Uint8Array, how: How;
    if (n % 2 === 0) { bytes = new Uint8Array(INPUT_BYTES); for (let i = 0; i < bytes.length; i++) bytes[i] = r.int(256); bytes[0] = M.Input; how = "noise"; }
    else { bytes = encode(r, "input", r.int(1000), 0); for (let k = 1 + r.int(6); k > 0; k--) bytes[1 + r.int(INPUT_BYTES - 1)] ^= 1 << r.int(8); how = "flip"; }
    const rd = new Reader(bytes); rd.o = 1; readInput(rd, got);
    const bad = bodyProblem(got);
    if (bad) fail("decode", seed, `readInput let through ${bad}`, { bytes, label: `input/${how} #${n}` });
    copyInput(q, got); quantizeInput(q);
    const k = sameInput(q, got);
    if (k) fail("decode", seed, `a decoded input is not what quantizeInput predicts: ${k} ${got[k]} → ${q[k]}`, { bytes, label: `input/${how} #${n}` });
    tally("decode", "input", how, true);
  }
  // 2. what a client predicts (quantizeInput) is bit for bit what the server decodes, for one input and for a window
  for (let n = 0; n < 20_000; n++) {
    fuzzInput(r, u32(r), src); clientDomain(src);
    copyInput(q, src); quantizeInput(q);
    writeInput(W.reset(), src);
    const bytes = W.bytes(), rd = new Reader(bytes); rd.o = 1; readInput(rd, got);
    const k = sameInput(q, got);
    if (k) fail("decode", seed, `quantizeInput predicts ${k} = ${q[k]}, the server decodes ${got[k]} (input ${JSON.stringify(src)})`, { bytes, label: `input/valid #${n}` });
    tally("decode", "input", "valid", true);
  }
  for (let n = 0; n < 2000; n++) {
    const count = 1 + r.int(INPUT_WINDOW), first = u32(r), ring = RING.slice(0, count);
    for (const i of ring) { fuzzInput(r, 0, i); clientDomain(i); }
    writeInputs(W.reset(), ring, first, count);
    const bytes = W.bytes(), rd = new Reader(bytes);
    if (bytes.length !== INPUTS_HEAD_BYTES + count * INPUT_BODY_BYTES || rd.u8() !== M.Inputs || rd.u8() !== count || rd.u32() !== first) fail("decode", seed, "writeInputs wrote a bad head", { bytes, label: `inputs/valid #${n}` });
    // a body carries no seq (readInputBody leaves it as it was): MatchHost numbers entry k first + k, and the host layer
    // checks that through each seat's lastSeq
    for (let k = 0; k < count; k++) {
      readInputBody(rd, got); copyInput(q, ring[(first + k) % count]); quantizeInput(q); got.seq = q.seq;
      const f = sameInput(q, got);
      if (f) fail("decode", seed, `window entry ${k}: quantizeInput predicts ${f} = ${q[f]}, the server decodes ${got[f]}`, { bytes, label: `inputs/valid #${n}` });
    }
    tally("decode", "inputs", "valid", true);
  }
  // 3. the WebTransport stream: frames cut back out of any chunking, nothing after a bad length, nothing over the cap
  const MAX_BYTES = 512;
  for (let n = 0; n < 3000; n++) {
    const noise = n % 3 === 0, payloads: Uint8Array[] = [], parts: Uint8Array[] = [];
    let bad = false;
    if (noise) { const b = new Uint8Array(r.int(2000)); for (let i = 0; i < b.length; i++) b[i] = r.int(256); parts.push(b); }
    else {
      for (let k = r.int(12); k >= 0; k--) {
        if (!bad && r.int(10) === 0) { bad = true; const len = r.int(2) === 0 ? 0 : Math.min(0xffff, MAX_BYTES + 1 + r.int(60000)); parts.push(new Uint8Array([len & 0xff, len >>> 8, 1, 2, 3])); continue; }
        const p = new Uint8Array(r.int(8) === 0 ? MAX_BYTES : 1 + r.int(300)); for (let i = 0; i < p.length; i++) p[i] = r.int(256);
        if (!bad) payloads.push(p);
        parts.push(frame(p));
      }
    }
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    const frames: Uint8Array[] = []; let afterBad = false;
    const def = new Deframer(MAX_BYTES, (u8) => { if (def.bad) afterBad = true; frames.push(u8.slice()); });
    try { for (let at = 0; at < all.length;) { const len = r.int(4) === 0 ? all.length - at : 1 + r.int(64); def.push(all.subarray(at, at + len)); at += len; } }
    catch (e) { fail("decode", seed, `Deframer threw ${(e as Error).message}`, { bytes: all, label: `stream #${n}` }); }
    if (afterBad || frames.some((f) => f.length < 1 || f.length > MAX_BYTES)) fail("decode", seed, "Deframer emitted a frame after a bad length, or one of a bad length", { bytes: all, label: `stream #${n}` });
    if (!noise) {
      const same = frames.length === payloads.length && frames.every((f, i) => f.length === payloads[i].length && f.every((b, j) => b === payloads[i][j]));
      if (!same || def.bad !== bad) fail("decode", seed, `Deframer gave ${frames.length} frames (bad ${def.bad}), the stream held ${payloads.length} (bad ${bad})`, { bytes: all, label: `stream #${n}` });
    }
    tally("decode", "stream", noise ? "noise" : bad ? "bad length" : "valid", !def.bad);
  }
}

// ---- host layer
/** what MatchHost.receive must accept: the frame rules its doc comment and proto.ts state */
function wellFormed(u8: Uint8Array): boolean {
  const n = u8.length;
  if (n < 1 || n > MAX_FRAME_BYTES) return false;
  switch (u8[0]) {
    case M.Input: return n === INPUT_BYTES;
    case M.Inputs: return u8[1] >= 1 && u8[1] <= INPUT_WINDOW && n === INPUTS_HEAD_BYTES + u8[1] * INPUT_BODY_BYTES;
    case M.InvOp: return n === INVOP_BYTES;
    case M.Ping: return n === 9 && Number.isFinite(f64At(u8, 1));
  }
  return false;
}
/** match fields that are not finite by design: resurgence has no end time until it is switched off */
const MATCH_NONFINITE_OK = new Set(["resEndAt"]);
function nonFinite(o: object, name: string): string | null {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "number") { if (!Number.isFinite(v)) return `${name}.${k} = ${v}`; }
    else if (ArrayBuffer.isView(v) && !(v instanceof DataView)) { const a = v as unknown as ArrayLike<number>; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return `${name}.${k}[${i}] = ${a[i]}`; }
    else if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) if (typeof v[i] === "number" && !Number.isFinite(v[i])) return `${name}.${k}[${i}] = ${v[i]}`; }
  }
  return null;
}
/** `all`: every player, vehicle and match number (else the humans only) */
function stateProblem(m: Match, all: boolean): string | null {
  for (const p of m.players) {
    if (!all && p.bot) continue;
    const bad = nonFinite(p, `player ${p.id}`); if (bad) return bad;
    for (let i = 0; i < p.slots.length; i++) {
      const s = p.slots[i], sb = nonFinite(s, `player ${p.id}.slots[${i}]`); if (sb) return sb;
      if (s.kind < 0 || s.kind > 2 || s.count < 0 || s.mag < 0) return `player ${p.id}.slots[${i}] = ${JSON.stringify(s)}`;
    }
    if (p.slots.length !== WEAPON_SLOTS || !Number.isInteger(p.active) || p.active < 0 || p.active >= WEAPON_SLOTS) return `player ${p.id}: active ${p.active} of ${p.slots.length} slots`;
    for (let i = 0; i < 4; i++) if (p.ammo[i] < 0 || p.ammo[i] > AMMO_CAP[AMMO_TYPES[i]]) return `player ${p.id}.ammo[${i}] = ${p.ammo[i]} (cap ${AMMO_CAP[AMMO_TYPES[i]]})`;
    if (p.hp < 0 || p.hp > MAX_HP || p.shield < 0 || p.shield > MAX_SHIELD) return `player ${p.id}: hp ${p.hp} shield ${p.shield}`;
    if (p.cash < 0 || p.cash > ECON.cap) return `player ${p.id}: cash ${p.cash}`;
    if (p.bot) continue;
    if (Math.abs(p.pitch) > PITCH_MAX) return `human ${p.id}: pitch ${p.pitch} past PITCH_MAX`;
    if ((p.prevButtons & ~BUTTON_MASK) !== 0) return `human ${p.id}: buttons ${p.prevButtons} outside BUTTON_MASK`;
    if (m.queued(p.id) > INPUT_QUEUE_MAX) return `human ${p.id}: ${m.queued(p.id)} inputs queued (INPUT_QUEUE_MAX ${INPUT_QUEUE_MAX})`;
  }
  if (!all) return null;
  for (const v of m.vehs.list) { const bad = nonFinite(v, `vehicle ${v.id}`); if (bad) return bad; }
  for (const [k, v] of Object.entries(m)) {
    if (MATCH_NONFINITE_OK.has(k)) continue;
    if (typeof v === "number" && !Number.isFinite(v)) return `match.${k} = ${v}`;
    if (ArrayBuffer.isView(v)) { const bad = nonFinite({ [k]: v }, "match"); if (bad) return bad; }
    else if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) { const bad = nonFinite(v, `match.${k}`); if (bad) return bad; }
  }
  return null;
}
/** what an inventory op may change: one player's whole inventory and health */
const invKey = (p: Player) => `${p.slots.map((s) => `${s.kind},${s.id},${s.rarity},${s.count},${s.mag}`).join(";")}|${p.ammo.join(",")}|${p.active}|${p.hp}|${p.shield}|${p.st}`;

/** the match code and the island take seconds to load and build: only the host layer pays for them (the other layers
 *  start the server at once) */
async function loadHost() {
  const [{ Match, Phase }, { MatchHost }, { trackInputGaps }, { VKind }, { Terrain }, { decodeTerrainFile, generateTerrain }, { buildStaticWorld }] = await Promise.all([
    import("../../shared/sim/match"), import("../../shared/net/host"), import("../../shared/net/input-gaps"), import("../../shared/sim/vehicle"),
    import("../../shared/world/terrain"), import("../../shared/world/terrain-gen"), import("../../shared/sim/static-world"),
  ]);
  const td = (() => { try { const b = fs.readFileSync(path.join(root, "public/assets/terrain/island.bin")); return decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { return generateTerrain(); } })();
  const { world } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);
  return { Match, Phase, MatchHost, trackInputGaps, VKind, world };
}

function runHost({ Match, Phase, MatchHost, trackInputGaps, VKind, world }: Awaited<ReturnType<typeof loadHost>>, seed: number) {
  const r = new Rng(seed);
  const names = ["FUZZ A", "FUZZ B", "FUZZ C"];
  // as Lobby.start (server/index.ts) builds a match: trios, easy bots, the input-gap telemetry, the stream hold
  const m = new Match({ seed, mode: "trios", world, humans: names.map((name, id) => ({ id, name, team: id < 2 ? 0 : 1 })), botDifficulty: "easy" });
  m.endAfterResults = true;
  trackInputGaps(m);
  const host = new MatchHost(m); host.holdForStream();
  const seated: HostPeer[] = names.map((_, pid) => ({ pid, invSeq: 0, opSeq: -1, send() {} }));
  const room: HostPeer = { pid: -1, invSeq: 0, send() {} }, caster: HostPeer = { pid: -1, invSeq: 0, caster: true, send() {} };
  host.peers.push(...seated, caster);
  const senders = [...seated, room, caster], senderName = ["seat 0", "seat 1", "seat 2", "a room member without a seat", "a caster seat"];
  const nextSeq = senders.map(() => 1), nextOp = senders.map(() => 0);
  let tick = 0, packetNo = 0, ran = 0, humanTicks = 0, humanShots = 0, reseats = 0;
  const phases = new Set<number>(), states: Record<string, number> = {};
  const label = (pk: Packet, si: number) => `#${packetNo} at tick ${tick}, ${pk.kind}/${pk.how} from ${senderName[si]}`;
  const gaps = m.inputProbe;
  m.inputProbe = (id, n, starve, queued) => {
    gaps?.(id, n, starve, queued);
    humanTicks++; ran += n;
    if (n > INPUT_MAX_PER_TICK) fail("host", seed, `human ${id} ran ${n} inputs in one tick (INPUT_MAX_PER_TICK ${INPUT_MAX_PER_TICK}) at tick ${tick}`);
  };
  m.shotProbe = (p, _inp, _pellet, evalTick) => {
    if (p.bot) return;
    humanShots++;
    if (!(evalTick >= m.tick - MAX_REWIND_TICKS && evalTick <= m.tick - 1)) fail("host", seed, `human ${p.id}'s shot was rewound to tick ${evalTick} at tick ${m.tick} (MAX_REWIND_TICKS ${MAX_REWIND_TICKS})`);
  };
  // seed 1, 4, …: the warm-up on the islet (tuk-tuks, the helicopter); 2, 5, …: START at once, the plane and the drop;
  // 3, 6, …: the match played on until the seats have landed (each jumps once half the bots have, over the island, and
  // sends nothing else). In the warm-up and on the ground each human holds an AR in slot 0, as if it had picked one up,
  // so its fuzzed inputs shoot
  const scene = seed % 3;
  if (scene !== 1) m.startNow();
  if (scene === 0) {
    const up = (st: PS) => st === PS.Plane || st === PS.Freefall || st === PS.Glide, jump = makeInput();
    jump.buttons = B.JUMP;
    for (let k = 0; k < 20_000 && !m.over && (m.phase !== Phase.Play || [0, 1, 2].some((id) => up(m.players[id].st))); k++) {
      if (m.phase === Phase.Plane && m.players.filter((p) => p.bot && p.st === PS.Plane).length < m.players.length / 2) {
        for (let id = 0; id < 3; id++) if (m.players[id].st === PS.Plane) { jump.seq = nextSeq[id]++; writeInput(W.reset(), jump); host.receive(seated[id], W.view(), () => {}); }
      }
      host.tick();
    }
  }
  const arm = () => {
    const def = WEAPON_DEFS.ar;
    for (let id = 0; id < 3; id++) {
      const p = m.players[id], s = p.slots[0];
      if (s.kind === SK.Weapon || p.st !== PS.Ground) continue;
      s.kind = SK.Weapon; s.id = WEAPONS.indexOf("ar"); s.rarity = 1; s.mag = def.mag; s.count = 1; giveAmmo(p, def.ammo, AMMO_CAP[def.ammo]);
    }
  };
  // on the islet two humans start beside a vehicle each (a tuk-tuk, a helicopter if there is one): a fuzzed USE gets in
  if (scene === 1) {
    const live = m.vehs.list.filter((v) => v.live);
    for (const [id, v] of [[1, live.find((q) => q.kind === VKind.Tuk)], [2, live.find((q) => q.kind === VKind.Heli)]] as const) {
      if (!v) continue;
      const p = m.players[id]; p.x = v.x + 1.2; p.y = v.y + 0.2; p.z = v.z; p.vx = p.vy = p.vz = 0;
    }
  }
  const replies: Uint8Array[] = [];
  for (tick = 0; tick < ticks && !m.over; tick++) {
    if (scene !== 2 && tick % 60 === 0) arm();
    for (let n = r.int(6); n > 0; n--) {
      const k = r.int(10), si = k < 8 ? k % 3 : k === 8 ? 3 : 4, peer = senders[si];
      const pk = makePacket(r, pickKind(r), nextSeq[si], nextOp[si]);
      packetNo++;
      const seqBefore = [0, 1, 2].map((id) => m.lastSeq(id)), opBefore = peer.opSeq ?? -1;
      const isOp = pk.bytes.length === INVOP_BYTES && pk.bytes[0] === M.InvOp;
      const invBefore = isOp ? m.players.map(invKey) : null, cashBefore = isOp && peer.pid >= 0 ? m.players[peer.pid].cash : 0;
      replies.length = 0;
      let ok = false;
      try { ok = host.receive(peer, pk.bytes, (u8) => replies.push(u8.slice())); }
      catch (e) { fail("host", seed, `MatchHost.receive threw: ${(e as Error).stack}`, { bytes: pk.bytes, label: label(pk, si) }); }
      tally("host", pk.kind, pk.how, ok);
      const want = wellFormed(pk.bytes);
      if (ok !== want) fail("host", seed, `MatchHost.receive ${ok ? "accepted" : "rejected"} a ${want ? "well-formed" : "malformed"} frame`, { bytes: pk.bytes, label: label(pk, si) });
      // the input seqs: only the sender's own seat may move, and to the newest seq the frame carried
      const type = pk.bytes[0];
      for (let id = 0; id < 3; id++) {
        let expect = seqBefore[id];
        if (ok && peer.pid === id && !m.players[id].bot && (type === M.Input || type === M.Inputs)) {
          const newest = type === M.Input ? u32At(pk.bytes, 1) : u32At(pk.bytes, 2) + pk.bytes[1] - 1;
          if (newest > expect) expect = newest;
        }
        if (m.lastSeq(id) !== expect) fail("host", seed, `seat ${id}'s input seq went ${seqBefore[id]} → ${m.lastSeq(id)}, expected ${expect}`, { bytes: pk.bytes, label: label(pk, si) });
      }
      // a ping gets exactly one pong with its own timestamp; nothing else is answered
      if (ok && type === M.Ping) {
        const p = replies[0];
        if (replies.length !== 1 || p.length !== 17 || p[0] !== M.Pong || !Object.is(f64At(p, 1), f64At(pk.bytes, 1)) || !Number.isFinite(f64At(p, 9))) fail("host", seed, `the pong does not echo the ping: ${replies.map(hex).join(" | ")}`, { bytes: pk.bytes, label: label(pk, si) });
      } else if (replies.length) fail("host", seed, `a frame other than a ping was answered: ${replies.map(hex).join(" | ")}`, { bytes: pk.bytes, label: label(pk, si) });
      // an inventory op: once per seq (a late copy from the other socket never), and only on its own seat (a purchase
      // may revive a squadmate, Offer.BuyBack, so it may change its own squad but never another)
      if (isOp && invBefore) {
        const seq = pk.bytes[1] | (pk.bytes[2] << 8), d = (seq - opBefore) & 0xffff, dup = opBefore >= 0 && (d === 0 || d > 0x8000);
        if (peer.opSeq !== (dup ? opBefore : seq)) fail("host", seed, `op seq went ${opBefore} → ${peer.opSeq} for an op with seq ${seq}`, { bytes: pk.bytes, label: label(pk, si) });
        const actor = dup || peer.pid < 0 ? -1 : peer.pid, bought = actor >= 0 && m.players[actor].cash < cashBefore;
        for (const p of m.players) {
          if (p.id === actor || (bought && p.team === m.players[actor].team)) continue;
          if (invKey(p) !== invBefore[p.id]) fail("host", seed, `an inventory op from ${senderName[si]} changed player ${p.id}: ${invBefore[p.id]} → ${invKey(p)}`, { bytes: pk.bytes, label: label(pk, si) });
        }
      }
      if (peer.pid >= 0) { if (ok) nextSeq[si] = Math.max(nextSeq[si], m.lastSeq(peer.pid) + 1); }
      else nextSeq[si]++;
      if (isOp && ok) nextOp[si] = ((peer.opSeq ?? 0) + 1) & 0xffff;
    }
    try { host.tick(); }
    catch (e) { fail("host", seed, `the tick after packet #${packetNo} threw: ${(e as Error).stack}`); }
    phases.add(m.phase);
    for (let id = 0; id < 3; id++) { const st = PS[m.players[id].st]; states[st] = (states[st] ?? 0) + 1; }
    const bad = stateProblem(m, tick % 4 === 0);
    if (bad) fail("host", seed, `after tick ${tick} (packet #${packetNo} last): ${bad}`);
    if (ran > humanTicks + m.netStats.driftCredits) fail("host", seed, `humans ran ${ran} inputs in ${humanTicks} human ticks with ${m.netStats.driftCredits} drift credits: faster than one a tick`);
    // a client whose seq reached 2^32 has nothing higher to send: it takes its seat again, as a reconnect would
    for (let id = 0; id < 3; id++) {
      if (m.lastSeq(id) < SEQ_STUCK || seated[id].pid !== id) continue;
      reseats++; m.releaseHuman(id);
      if (m.reclaimHuman(id, names[id])) { seated[id].opSeq = -1; nextSeq[id] = 1; nextOp[id] = 0; }
      else seated[id].pid = -1;
    }
  }
  return { scene: ["play", "islet", "drop"][scene], packets: packetNo, ticks: tick, phases: [...phases].sort().map((p) => Phase[p]).join(","), humanStates: states, humanInputs: ran, humanShots, reseats, drift: m.netStats.driftCredits };
}

// ---- server layer
const BAD_LOG = /uncaught|unhandled rejection|json handler error|tick error|MATCH CRASHED|webtransport session error/i;
const freePort = () => new Promise<number>((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until(f: () => boolean, ms: number) { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) return false; await sleep(15); } return true; }
interface Server { port: number; proc: ChildProcess; log: () => string; exited: () => number | null }
async function startServer(): Promise<Server> {
  const port = await freePort(); let out = "", code: number | null = null;
  const proc = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, KR_HOST: "127.0.0.1", KR_PORT: String(port), KR_EVENT_MODE: "0", KR_PLAYTEST_BUNDLES: "0", KR_DIAG_AUTO: "0", KR_WT: "0" },
  });
  proc.stdout!.on("data", (d) => { out += d; }); proc.stderr!.on("data", (d) => { out += d; });
  proc.on("exit", (c, sig) => { code = c ?? (sig ? 128 : 1); });
  return { port, proc, log: () => out, exited: () => code };
}

interface Rec { [k: string]: unknown }
interface Cl { name: string; ws: WebSocket; uid: number; token: string; code: string; pid: number; snaps: number; lastSeq: number; pongs: number; closed: { code: number; reason: string } | null; sent: string[]; badSelf: string | null }
const SELF_NUMS = ["x", "y", "z", "vx", "vy", "vz", "coyote", "jumpBuf", "airT", "fallV", "mvT", "mvY", "buffT", "breath", "swGun"] as const;
function selfProblem(s: SelfState): string | null {
  for (const k of SELF_NUMS) if (!Number.isFinite(s[k])) return `${k} = ${s[k]}`;
  if (s.drive) for (const [k, v] of Object.entries(s.v)) if (typeof v === "number" && !Number.isFinite(v)) return `v.${k} = ${v}`;
  if (s.gun) for (const [k, v] of Object.entries(s.g)) if (typeof v === "number" && !Number.isFinite(v)) return `g.${k} = ${v}`;
  return null;
}
function connect(port: number, name: string, query = ""): Cl {
  const c: Cl = { name, ws: new WebSocket(`ws://127.0.0.1:${port}/ws${query}`), uid: 0, token: "", code: "", pid: -1, snaps: 0, lastSeq: 0, pongs: 0, closed: null, sent: [], badSelf: null };
  const head: SnapHeader = { tick: 0, time: 0, phase: 0, alive: 0, squads: 0, flags: 0, lastSeq: 0, count: 0 }, self = makeSelfState();
  c.ws.on("message", (data: RawData, binary: boolean) => {
    const buf = data as Buffer;
    if (binary) {
      if (buf[0] === M.Pong) c.pongs++;
      if (buf[0] !== M.Snapshot) return;
      const rd = new Reader(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)); rd.o = 1;
      readSnapHeader(rd, head); readSelf(rd, self); c.snaps++; c.lastSeq = head.lastSeq;
      const bad = selfProblem(self); if (bad && !c.badSelf) c.badSelf = `snapshot at tick ${head.tick}: self ${bad}`;
      return;
    }
    const j = JSON.parse(String(buf)) as Rec;
    if (j.t === "welcome") { c.uid = j.uid as number; c.token = j.aux as string; }
    if (j.t === "lobby") c.code = j.code as string;
    if (j.t === "match") c.pid = (j.pids as Record<string, number>)[c.uid] ?? -1;
  });
  c.ws.on("close", (code, reason) => { c.closed = { code, reason: String(reason) }; });
  c.ws.on("error", () => { /* the close follows */ });
  return c;
}
/** send one frame, keeping the last few for the failure report */
function send(c: Cl, data: Uint8Array | string) {
  if (c.ws.readyState !== WebSocket.OPEN) return;
  c.ws.send(data);
  c.sent.push(typeof data === "string" ? `json ${data.length > 300 ? data.slice(0, 300) + " …" : data}` : `bin ${hex(data)}`);
  if (c.sent.length > 12) c.sent.shift();
}

// JSON frames: the message types onJSON (server/index.ts) and onVoiceJSON (server/voice.ts) handle, the aux and
// WebTransport hellos and odd values of t
const PLAYER_TYPES = ["hello", "mode", "start", "net", "stream", "mark", "rtc", "voice", "listen", "castopt", "castprog", "castping", "castcam", "aux", "wt"];
const CASTER_TYPES = ["castcam", "castping", "castprog", "castopt", "listen", "rtc", "voice", "hello", "net", "stream", "mark"];
const ROOM_TYPES = ["create", "join", "leave", "cast", "exhibit", "team"];
const ODD_T: unknown[] = ["", "__proto__", "constructor", "toString", "hasOwnProperty", "HELLO", "hello ", 0, 1, null, true, [], {}];
const KEYS = ["name", "mode", "code", "tok", "team", "program", "auto", "seat", "cam", "note", "why", "transport", "arm", "done", "x", "z", "clear", "mic", "on", "to", "d", "token"];
const WORDS = ["trios", "solo", "wt", "ws", "off", "flag-off", "auth", "p0", "p1", "p2", "s0", "s1", "s99", "p999", "KONG", "x".repeat(70)];
function jsonValue(r: Rng, depth: number, code: string): unknown {
  switch (r.int(depth > 2 ? 8 : 11)) {
    case 0: return r.int(200) - 100;
    case 1: return EDGE[r.int(EDGE.length)];
    case 2: return Array.from({ length: r.int(12) }, () => String.fromCharCode(32 + r.int(95))).join("");
    case 3: return code;
    case 4: return WORDS[r.int(WORDS.length)];
    case 5: return r.int(2) === 0;
    case 6: return null;
    case 7: return ["\u0000", "\ud800", "😀".repeat(1 + r.int(4)), "Ａ Ｄ Ｍ Ｉ Ｎ", "a".repeat(r.int(3000))][r.int(5)];
    case 8: return Array.from({ length: r.int(5) }, () => jsonValue(r, depth + 1, code));
    case 9: return Object.fromEntries(Array.from({ length: r.int(5) }, () => [KEYS[r.int(KEYS.length)], jsonValue(r, depth + 1, code)]));
    default: return { x: r.range(-5000, 5000), y: r.range(0, 500), z: r.range(-5000, 5000), yaw: r.range(-4, 4) };
  }
}
function jsonFrame(r: Rng, types: readonly string[], code: string): string {
  const k = r.int(40);
  if (k === 0) return ["", "{", "null", "1", "[]", "\"x\"", "{\"t\":", "\u0000", "{\"t\":\"hello\",\"name\":\"\\ud800\"}", "[[[[[[[["][r.int(10)];
  if (k === 1) {
    // deep nesting, within MAX_PAYLOAD: 2 bytes a level for arrays, 6 for objects
    const arr = r.int(2) === 0, d = 500 + r.int(arr ? 7000 : 2000), key = KEYS[r.int(KEYS.length)];
    return `{"t":"${types[r.int(types.length)]}","${key}":${arr ? "[".repeat(d) + "]".repeat(d) : "{\"a\":".repeat(d) + "1" + "}".repeat(d)}}`;
  }
  const msg: Rec = { t: k === 2 ? ODD_T[r.int(ODD_T.length)] : types[r.int(types.length)] };
  for (let n = r.int(5); n > 0; n--) msg[KEYS[r.int(KEYS.length)]] = jsonValue(r, 0, code);
  const s = JSON.stringify(msg);
  return Buffer.byteLength(s) > MAX_PAYLOAD_BYTES - 64 ? s.slice(0, 2000) : s;
}

async function runServer(srv: Server, seed: number) {
  const port = srv.port, problems: string[] = [], clients: Cl[] = [];
  const cl = (name: string, query = "") => { const c = connect(port, name, query); clients.push(c); return c; };
  const json = (c: Cl, o: Rec) => send(c, JSON.stringify(o));
  if (!(await until(() => /KONG ROYALE server on/.test(srv.log()) || srv.exited() !== null, SERVER_START_MS))) fail("server", seed, `the server did not start in ${SERVER_START_MS / 1000} s:\n${srv.log().slice(-2000)}`);
  if (srv.exited() !== null) fail("server", seed, `the server exited at start:\n${srv.log().slice(-2000)}`);
  // the room: P0 hosts and fuzzes, P1 fuzzes, P2 plays normally, S casts, X starts in no lobby, A is P1's aux socket
  const [P0, P1, P2, S, X] = ["P0", "P1", "P2", "S", "X"].map((n) => cl(n));
  if (!(await until(() => [P0, P1, P2, S, X].every((c) => c.uid > 0), 5000))) fail("server", seed, "no welcome");
  json(P0, { t: "hello", name: "FUZZ P0" }); json(P0, { t: "create", mode: "trios" });
  if (!(await until(() => !!P0.code, 5000))) fail("server", seed, "no lobby");
  for (const c of [P1, P2]) json(c, { t: "join", code: P0.code });
  json(S, { t: "cast", code: P0.code });
  if (!(await until(() => P1.code === P0.code && P2.code === P0.code && S.code === P0.code, 5000))) fail("server", seed, "the room did not fill");
  json(P0, { t: "start" });
  if (!(await until(() => P0.pid >= 0 && P1.pid >= 0 && P2.pid >= 0, 5000))) fail("server", seed, "nobody was seated");
  const A = cl("A", "?attach=1");
  await until(() => A.ws.readyState === WebSocket.OPEN, 3000);
  json(A, { t: "aux", token: P1.token });
  await sleep(100);

  // fuzz: each fuzzing client sends a frame every SEND_EVERY_MS (100 a second; RATE_PER_S is 150), P2 one valid input
  const fuzzers: Array<{ c: Cl; types: readonly string[]; textShare: number }> = [
    { c: P0, types: PLAYER_TYPES, textShare: 0.4 }, { c: P1, types: PLAYER_TYPES, textShare: 0.4 }, { c: S, types: CASTER_TYPES, textShare: 0.6 },
    { c: A, types: PLAYER_TYPES, textShare: 0.1 }, { c: X, types: [...PLAYER_TYPES, ...ROOM_TYPES], textShare: 0.5 },
  ];
  const rngs = fuzzers.map((_, i) => new Rng((seed * 7919 + i * 104729) >>> 0)), nextSeq = fuzzers.map(() => 1), nextOp = fuzzers.map(() => 0);
  const p2 = makeInput(), p2W = new Writer(new ArrayBuffer(64)); let p2Seq = 0;
  const playP2 = () => { p2.seq = ++p2Seq; p2.mz = 1; p2.yaw = (p2Seq % 600) / 100; p2.buttons = p2Seq % 90 === 0 ? 1 : 0; writeInput(p2W.reset(), p2); send(P2, p2W.view()); };
  let sentFrames = 0;
  const p2Timer = setInterval(playP2, 1000 / 60);
  const timer = setInterval(() => {
    fuzzers.forEach((f, i) => {
      const r = rngs[i];
      if (r.next() < f.textShare) { send(f.c, jsonFrame(r, f.types, P0.code)); tally("server", "json", "fuzz", true); }
      else {
        nextSeq[i] = Math.max(nextSeq[i], f.c.lastSeq + 1);
        const pk = makePacket(r, pickKind(r), nextSeq[i], nextOp[i]++);
        send(f.c, pk.bytes); tally("server", pk.kind, pk.how, true);
      }
      sentFrames++;
    });
  }, SEND_EVERY_MS);
  await sleep(SERVER_FUZZ_MS);
  clearInterval(timer); clearInterval(p2Timer);
  await sleep(300);
  for (const c of [P0, P1, P2, S, A]) if (c.closed) problems.push(`${c.name} kept within the rate and strike limits but was closed: ${c.closed.code} ${c.closed.reason}`);
  if (P2.lastSeq !== p2Seq) problems.push(`P2 played normally beside the fuzz: it sent input ${p2Seq}, its snapshots say ${P2.lastSeq}`);

  // the limits: a ping flood in the match is answered at most RATE_BURST + RATE_PER_S a second, then closed; malformed
  // frames are struck until the socket closes, both outside a lobby (B) and in a match (BM); a frame past MAX_PAYLOAD
  // closes it; bad aux attaches are refused
  const F = cl("F"), B = cl("B"), BM = cl("BM"), O = cl("O"), AQ = cl("AQ", "?aux=1"), AG = cl("AG", "?attach=1"), A2 = cl("A2", "?attach=1");
  if (!(await until(() => F.uid > 0 && B.uid > 0 && BM.uid > 0 && O.uid > 0 && AG.ws.readyState === WebSocket.OPEN && A2.ws.readyState === WebSocket.OPEN, 5000))) fail("server", seed, "the limit clients did not connect");
  json(F, { t: "join", code: P0.code }); json(BM, { t: "join", code: P0.code });
  await until(() => F.code === P0.code && BM.code === P0.code, 3000);
  const ping = new Writer(new ArrayBuffer(16)).u8(M.Ping).f64(1).bytes();
  const floodAt = performance.now();
  for (let i = 0; i < 1200; i++) F.ws.send(ping);
  // the malformed frames stay within the rate (RATE_BURST at once, the rest once the bucket refilled) so that only
  // "bad frame" strikes can close the socket, never "rate" ones
  const malformed = (n: number) => { for (let i = 0; i < n; i++) { B.ws.send(new Uint8Array([0xee])); BM.ws.send(new Uint8Array([M.Input])); } };
  malformed(RATE_BURST - 10);
  O.ws.send(new Uint8Array(MAX_PAYLOAD_BYTES + 1));
  send(AG, "{\"t\":\"aux\",\"token\":\"not a token\"}"); send(A2, JSON.stringify({ t: "aux", token: P1.token }));
  await sleep(Math.ceil((60 / RATE_PER_S) * 1000));
  malformed(MAX_STRIKES - RATE_BURST + 30);
  await until(() => !!(F.closed && B.closed && BM.closed && O.closed && AQ.closed && AG.closed && A2.closed), 5000);
  const floodS = (performance.now() - floodAt) / 1000, pongCap = RATE_BURST + Math.ceil(RATE_PER_S * floodS);
  if (F.closed?.code !== 1008) problems.push(`a ping flood past the rate limit was not closed with 1008 (${JSON.stringify(F.closed)})`);
  if (F.pongs > pongCap) problems.push(`a ping flood got ${F.pongs} pongs in ${floodS.toFixed(2)} s, over the ${pongCap} the rate limit allows`);
  for (const c of [B, BM]) if (c.closed?.code !== 1008 || c.closed.reason !== "bad frame") problems.push(`${c.name}'s malformed frames, sent within the rate, were not closed with 1008 "bad frame" (${JSON.stringify(c.closed)})`);
  if (O.closed?.code !== 1009) problems.push(`a frame past MAX_PAYLOAD was not closed with 1009 (${JSON.stringify(O.closed)})`);
  for (const c of [AQ, AG, A2]) if (c.closed?.code !== 1008) problems.push(`bad aux attach ${c.name} was not refused with 1008 (${JSON.stringify(c.closed)})`);

  // the server after all of it: up, nothing thrown, every snapshot finite, the normal player still playing
  const p2Before = P2.snaps;
  const keep = setInterval(playP2, 1000 / 60);
  await sleep(600);
  clearInterval(keep);
  await sleep(300);
  if (P2.snaps <= p2Before || P2.lastSeq !== p2Seq) problems.push(`after the floods P2 got ${P2.snaps - p2Before} snapshots, lastSeq ${P2.lastSeq} for input ${p2Seq}`);
  for (const c of clients) if (c.badSelf) problems.push(`${c.name}: ${c.badSelf}`);
  let health: { ok?: boolean } = {};
  try { health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { ok?: boolean }; } catch (e) { problems.push(`/health failed: ${(e as Error).message}`); }
  if (health.ok !== true) problems.push(`/health said ${JSON.stringify(health).slice(0, 200)}`);
  if (srv.exited() !== null) problems.push(`the server exited (${srv.exited()})`);
  const badLines = srv.log().split("\n").filter((l) => BAD_LOG.test(l));
  if (badLines.length) problems.push(`the server log has ${badLines.length} handler / tick error line(s):\n    ${badLines.slice(0, 5).join("\n    ")}`);
  for (const c of clients) c.ws.terminate();
  if (problems.length) {
    const last = fuzzers.map((f) => `  ${f.c.name} last frames:\n    ${f.c.sent.join("\n    ")}`).join("\n");
    fail("server", seed, `${problems.join("\n  ")}\n${last}\n  server log (tail):\n    ${srv.log().split("\n").slice(-25).join("\n    ")}`);
  }
  return { frames: sentFrames, p2Inputs: p2Seq, floodPongs: F.pongs, floodS: +floodS.toFixed(2), closes: { flood: F.closed?.code, malformed: B.closed?.code, malformedInMatch: BM.closed?.code, oversize: O.closed?.code } };
}

// ---- run
/** the host layer in a process of its own while this one drives the server: each builds its island on its own core */
function runChild(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout!.on("data", (d) => { out += d; }); p.stderr!.on("data", (d) => { out += d; });
    p.on("exit", (c) => res({ code: c ?? 1, out }));
  });
}
const t0 = performance.now(), failures: string[] = [];
const guard = async (f: () => unknown) => { try { await f(); } catch (e) { failures.push(e instanceof FuzzFail ? e.message : `FUZZ FAILED: ${(e as Error).stack}`); } };
// the server and the host layer's child build their islands while this process runs the decode layer
const server = layers.includes("server") ? await startServer() : null;
const hostApart = layers.includes("host") && layers.length > 1;
const hostChild = hostApart ? runChild(["--layer", "host", ...(seedArg === null ? [] : ["--seed", String(seedArg)]), ...(ticks === DEFAULT_TICKS ? [] : ["--ticks", String(ticks)])]) : null;
console.log(`seeds: ${layers.map((l) => `${l} ${seedsOf(l).join(",")}`).join(" · ")}${layers.includes("host") ? ` · ${ticks} fuzzed ticks a host seed` : ""}`);
if (layers.includes("decode")) await guard(() => { for (const seed of seedsOf("decode")) { runDecode(seed); console.log(`decode seed ${seed}: ok`); } });
if (layers.includes("host") && !hostApart) await guard(async () => {
  const deps = await loadHost();
  console.log(`host: the island built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  for (const seed of seedsOf("host")) { const t = performance.now(), res = runHost(deps, seed); console.log(`host seed ${seed}: ok in ${((performance.now() - t) / 1000).toFixed(1)} s ${JSON.stringify(res)}`); }
});
if (server) await guard(async () => { for (const seed of seedsOf("server")) console.log(`server seed ${seed}: ok ${JSON.stringify(await runServer(server, seed))}`); });
server?.proc.kill("SIGTERM");
if (tallies.size) {
  console.log("\npackets per type (accepted: the decoder or MatchHost.receive took it; server frames are counted as sent):");
  for (const [key, t] of [...tallies].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${key.padEnd(15)} ${String(t.n).padStart(7)}  accepted ${String(t.ok).padStart(7)}  ${Object.entries(t.how).map(([h, n]) => `${h} ${n}`).join(" · ")}`);
  }
}
if (hostChild) {
  const h = await hostChild;
  console.log(`\n--- host layer (its own process) ---\n${h.out.trim()}`);
  if (h.code !== 0) failures.push("the host layer failed (above)");
}
if (failures.length) { console.error(`\n${failures.join("\n\n")}`); process.exit(1); }
console.log(`\nPROTOCOL FUZZ PASSED (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(0);
