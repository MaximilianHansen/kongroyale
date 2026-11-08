// The "address" every per-address limit, kick and allowlist uses (ipOf below, for the game server, the front of a
// multi-process server and server/admin/auth.ts): IPv4 as is (also when IPv6-mapped), IPv6 by its /64. One home or VPS
// gets a whole /64, so counting single IPv6 addresses would hand an attacker billions of fresh "addresses".
import type http from "node:http";

export function addrKey(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(":") || ip === "::1") return ip;
  const [head, tail = ""] = ip.split("%")[0].toLowerCase().split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export const TRUST_PROXY = process.env.KR_TRUST_PROXY === "1";
// the proxies allowed to set the client-address headers: loopback (nginx on this machine) plus KR_PROXY_IPS (comma list)
const PROXY_IPS = new Set((process.env.KR_PROXY_IPS || "").split(",").map((s) => s.trim()).filter(Boolean));
export const isLoop = (a: string) => a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
// (admin lobby) behind the proxy, never the LEFT-most X-Forwarded-For entry: the client writes that
// one itself (rotating it would mint a fresh "address" per request and defeat every per-address limit). Cloudflare's
// CF-Connecting-IP, else nginx's X-Real-IP, else the right-most X-Forwarded-For entry (the one our proxy appended).
// Those headers are believed only when the connection itself comes from a trusted proxy (this machine, or KR_PROXY_IPS):
// a client reaching the port directly can't claim to be someone else (or 127.0.0.1).
export const ipOf = (req: http.IncomingMessage) => {
  const peer = req.socket.remoteAddress || "?";
  if (TRUST_PROXY && (isLoop(peer) || PROXY_IPS.has(peer.replace(/^::ffff:/i, "")))) {
    const one = (h: string) => { const v = req.headers[h]; return typeof v === "string" ? v.trim() : ""; };
    const xff = one("x-forwarded-for").split(",").map((s) => s.trim()).filter(Boolean);
    const ip = one("cf-connecting-ip") || one("x-real-ip") || xff[xff.length - 1];
    if (ip && ip.length <= 64) return addrKey(ip);
  }
  return addrKey(peer);
};
