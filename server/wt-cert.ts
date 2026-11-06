// A self-signed certificate for the WebTransport endpoint when no real one is configured (KR_WT_CERT / KR_WT_KEY unset):
// ECDSA P-256, valid 13 days, so browsers accept it by its SHA-256 through `serverCertificateHashes` (the rule: at most 14
// days of validity, no name check). server/wt.ts sends the hash in "welcome" and makes a new one before this one ends.
// Built with node:crypto and a few lines of DER, so it needs no OpenSSL binary and no extra dependency.
import crypto from "node:crypto";

const DAY_MS = 86_400_000;
/** validity of a self-signed certificate (browsers refuse a hash for one valid longer than 14 days) */
export const SELF_SIGNED_DAYS = 13;

const len = (n: number) => n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
const tlv = (tag: number, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag, ...len(body.length)]), body]); };
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
function oid(s: string) {
  const [a, b, ...rest] = s.split(".").map(Number), out = [a * 40 + b];
  for (const v of rest) { const enc = [v & 0x7f]; for (let x = v >>> 7; x; x >>>= 7) enc.unshift(0x80 | (x & 0x7f)); out.push(...enc); }
  return tlv(0x06, Buffer.from(out));
}
const utc = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const name = (cn: string) => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));

export interface SelfSigned { cert: string; key: string; sha256: Buffer; notAfter: number }
export function selfSigned(cn = "kongroyale", now = Date.now()): SelfSigned {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const serial = crypto.randomBytes(8); serial[0] &= 0x7f;
  const notBefore = now - 3_600_000, notAfter = notBefore + SELF_SIGNED_DAYS * DAY_MS;
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), ECDSA_SHA256, name(cn),
    seq(utc(new Date(notBefore)), utc(new Date(notAfter))), name(cn), publicKey.export({ type: "spki", format: "der" }),
    // extensions: subjectAltName = DNS:<cn> (QUIC stacks refuse a leaf certificate without one)
    tlv(0xa3, seq(seq(oid("2.5.29.17"), tlv(0x04, seq(tlv(0x82, Buffer.from(cn))))))),
  );
  const sig = crypto.sign("sha256", tbs, privateKey);
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sig));
  const pem = (label: string, b: Buffer) => `-----BEGIN ${label}-----\n${b.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END ${label}-----\n`;
  return { cert: pem("CERTIFICATE", der), key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, sha256: crypto.createHash("sha256").update(der).digest(), notAfter };
}
