// The kernels behind shared/sim/dmath.ts. They run every tick (stepPlayer, bots, hit tests), so they live in a .hot.ts
// file where the hot-alloc lint keeps them allocation-free: scratch buffers are module-scope typed arrays.
// Licence notices for the fdlibm / V8 code ported here are in shared/sim/dmath.ts.

const F = new Float64Array(1);
const U = new Uint32Array(F.buffer);
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LE ? 1 : 0, LO = LE ? 0 : 1;

function hiWord(x: number): number { F[0] = x; return U[HI] | 0; }
function loWord(x: number): number { F[0] = x; return U[LO]; }
function fromWords(hi: number, lo: number): number { U[HI] = hi >>> 0; U[LO] = lo >>> 0; return F[0]; }
function withLow(x: number, lo: number): number { F[0] = x; U[LO] = lo >>> 0; return F[0]; }
function withHigh(x: number, hi: number): number { F[0] = x; U[HI] = hi >>> 0; return F[0]; }

const P1023 = fromWords(0x7FE00000, 0), PM1022X53 = fromWords(0x00100000, 0) * fromWords(0x43400000, 0);
function scalbn(x: number, n: number): number {
  let y = x;
  if (n > 1023) {
    y *= P1023; n -= 1023;
    if (n > 1023) { y *= P1023; n -= 1023; if (n > 1023) n = 1023; }
  } else if (n < -1022) {
    y *= PM1022X53; n += 1022 - 53;
    if (n < -1022) { y *= PM1022X53; n += 1022 - 53; if (n < -1022) n = -1022; }
  }
  return y * fromWords((0x3FF + n) << 20, 0);
}

const TWO_OVER_PI = new Int32Array([
  0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62, 0x95993C, 0x439041, 0xFE5163, 0xABDEBB, 0xC561B7,
  0x246E3A, 0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129, 0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C,
  0x7026B4, 0x5F7E41, 0x3991D6, 0x398353, 0x39F49C, 0x845F8B, 0xBDF928, 0x3B1FF8, 0x97FFDE, 0x05980F, 0xEF2F11,
  0x8B5A0A, 0x6D1F6D, 0x367ECF, 0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5, 0xF17B3D, 0x0739F7,
  0x8A5292, 0xEA6BFB, 0x5FB11F, 0x8D5D08, 0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3, 0x91615E,
  0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880, 0x4D7327, 0x310606, 0x1556CA, 0x73A8C9, 0x60E27B, 0xC08C6B,
]);
const NPIO2_HW = new Int32Array([
  0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB, 0x402C463A,
  0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A,
  0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C, 0x404534AC,
  0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
]);
const PIO2 = new Float64Array([
  1.57079625129699707031e+00, 7.54978941586159635335e-08, 5.39030252995776476554e-15, 3.28200341580791294123e-22,
  1.27065575308067607349e-29, 1.22933308981111328932e-36, 2.73370053816464559624e-44, 2.16741683877804819444e-51,
]);
const INVPIO2 = 6.36619772367581382433e-01, PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21, PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32, TWO24 = 1.67772160000000000000e+07, TWON24 = 5.96046447753906250000e-08;

const Y = new Float64Array(2), TX = new Float64Array(3);
const IQ = new Int32Array(20), KF = new Float64Array(20), FQ = new Float64Array(20), Q = new Float64Array(20);

function kernelRemPio2(nx: number, e0: number): number {
  const jk = 4, jp = jk, jx = nx - 1;
  let jv = ((e0 - 3) / 24) | 0;
  if (jv < 0) jv = 0;
  let q0 = e0 - 24 * (jv + 1);
  let i: number, j: number, k: number, fw: number, z: number, n: number, ih: number, carry: number;
  j = jv - jx;
  const m = jx + jk;
  for (i = 0; i <= m; i++, j++) KF[i] = j < 0 ? 0 : TWO_OVER_PI[j];
  for (i = 0; i <= jk; i++) {
    for (j = 0, fw = 0.0; j <= jx; j++) fw += TX[j] * KF[jx + i - j];
    Q[i] = fw;
  }
  let jz = jk;
  for (;;) {
    for (i = 0, j = jz, z = Q[jz]; j > 0; i++, j--) {
      fw = (TWON24 * z) | 0;
      IQ[i] = (z - TWO24 * fw) | 0;
      z = Q[j - 1] + fw;
    }
    z = scalbn(z, q0);
    z -= 8.0 * Math.floor(z * 0.125);
    n = z | 0;
    z -= n;
    ih = 0;
    if (q0 > 0) {
      i = IQ[jz - 1] >> (24 - q0);
      n += i;
      IQ[jz - 1] -= i << (24 - q0);
      ih = IQ[jz - 1] >> (23 - q0);
    } else if (q0 === 0) {
      ih = IQ[jz - 1] >> 23;
    } else if (z >= 0.5) {
      ih = 2;
    }
    if (ih > 0) {
      n += 1;
      carry = 0;
      for (i = 0; i < jz; i++) {
        j = IQ[i];
        if (carry === 0) {
          if (j !== 0) { carry = 1; IQ[i] = 0x1000000 - j; }
        } else {
          IQ[i] = 0xFFFFFF - j;
        }
      }
      if (q0 === 1) IQ[jz - 1] &= 0x7FFFFF;
      else if (q0 === 2) IQ[jz - 1] &= 0x3FFFFF;
      if (ih === 2) {
        z = 1 - z;
        if (carry !== 0) z -= scalbn(1, q0);
      }
    }
    if (z === 0) {
      j = 0;
      for (i = jz - 1; i >= jk; i--) j |= IQ[i];
      if (j === 0) {
        for (k = 1; jk >= k && IQ[jk - k] === 0; k++);
        for (i = jz + 1; i <= jz + k; i++) {
          KF[jx + i] = TWO_OVER_PI[jv + i];
          for (j = 0, fw = 0.0; j <= jx; j++) fw += TX[j] * KF[jx + i - j];
          Q[i] = fw;
        }
        jz += k;
        continue;
      }
    }
    break;
  }
  if (z === 0.0) {
    jz -= 1;
    q0 -= 24;
    while (IQ[jz] === 0) { jz--; q0 -= 24; }
  } else {
    z = scalbn(z, -q0);
    if (z >= TWO24) {
      fw = (TWON24 * z) | 0;
      IQ[jz] = (z - TWO24 * fw) | 0;
      jz += 1;
      q0 += 24;
      IQ[jz] = fw;
    } else {
      IQ[jz] = z | 0;
    }
  }
  fw = scalbn(1, q0);
  for (i = jz; i >= 0; i--) { Q[i] = fw * IQ[i]; fw *= TWON24; }
  for (i = jz; i >= 0; i--) {
    for (fw = 0.0, k = 0; k <= jp && k <= jz - i; k++) fw += PIO2[k] * Q[i + k];
    FQ[jz - i] = fw;
  }
  fw = 0.0;
  for (i = jz; i >= 0; i--) fw += FQ[i];
  Y[0] = ih === 0 ? fw : -fw;
  fw = FQ[0] - fw;
  for (i = 1; i <= jz; i++) fw += FQ[i];
  Y[1] = ih === 0 ? fw : -fw;
  return n & 7;
}

function remPio2(x: number): number {
  const hx = hiWord(x), ix = hx & 0x7FFFFFFF;
  let z: number, w: number, t: number, r: number, fn: number, n: number;
  if (ix <= 0x3FE921FB) { Y[0] = x; Y[1] = 0; return 0; }
  if (ix < 0x4002D97C) {
    if (hx > 0) {
      z = x - PIO2_1;
      if (ix !== 0x3FF921FB) { Y[0] = z - PIO2_1T; Y[1] = (z - Y[0]) - PIO2_1T; }
      else { z -= PIO2_2; Y[0] = z - PIO2_2T; Y[1] = (z - Y[0]) - PIO2_2T; }
      return 1;
    }
    z = x + PIO2_1;
    if (ix !== 0x3FF921FB) { Y[0] = z + PIO2_1T; Y[1] = (z - Y[0]) + PIO2_1T; }
    else { z += PIO2_2; Y[0] = z + PIO2_2T; Y[1] = (z - Y[0]) + PIO2_2T; }
    return -1;
  }
  if (ix <= 0x413921FB) {
    t = Math.abs(x);
    n = (t * INVPIO2 + 0.5) | 0;
    fn = n;
    r = t - fn * PIO2_1;
    w = fn * PIO2_1T;
    if (n < 32 && ix !== NPIO2_HW[n - 1]) {
      Y[0] = r - w;
    } else {
      const j = ix >> 20;
      Y[0] = r - w;
      let i = j - ((hiWord(Y[0]) >>> 20) & 0x7FF);
      if (i > 16) {
        t = r;
        w = fn * PIO2_2;
        r = t - w;
        w = fn * PIO2_2T - ((t - r) - w);
        Y[0] = r - w;
        i = j - ((hiWord(Y[0]) >>> 20) & 0x7FF);
        if (i > 49) {
          t = r;
          w = fn * PIO2_3;
          r = t - w;
          w = fn * PIO2_3T - ((t - r) - w);
          Y[0] = r - w;
        }
      }
    }
    Y[1] = (r - Y[0]) - w;
    if (hx < 0) { Y[0] = -Y[0]; Y[1] = -Y[1]; return -n; }
    return n;
  }
  if (ix >= 0x7FF00000) { Y[0] = Y[1] = x - x; return 0; }
  const e0 = (ix >> 20) - 1046;
  z = fromWords(ix - (e0 << 20), loWord(x));
  for (let i = 0; i < 2; i++) { TX[i] = z | 0; z = (z - TX[i]) * TWO24; }
  TX[2] = z;
  let nx = 3;
  while (TX[nx - 1] === 0) nx--;
  n = kernelRemPio2(nx, e0);
  if (hx < 0) { Y[0] = -Y[0]; Y[1] = -Y[1]; return -n; }
  return n;
}

const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
function kernelCos(x: number, y: number): number {
  const ix = hiWord(x) & 0x7FFFFFFF;
  if (ix < 0x3E400000) { if ((x | 0) === 0) return 1; }
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3FD33333) return 1 - (0.5 * z - (z * r - x * y));
  const qx = ix > 0x3FE90000 ? 0.28125 : fromWords(ix - 0x00200000, 0);
  const iz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (iz - (z * r - x * y));
}

const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
function kernelSin(x: number, y: number, iy: number): number {
  const ix = hiWord(x) & 0x7FFFFFFF;
  if (ix < 0x3E400000) { if ((x | 0) === 0) return x; }
  const z = x * x, v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const T = new Float64Array([
  3.33333333333334091986e-01, 1.33333333333201242699e-01, 5.39682539762260521377e-02, 2.18694882948595424599e-02,
  8.86323982359930005737e-03, 3.59207910759131235356e-03, 1.45620945432529025516e-03, 5.88041240820264096874e-04,
  2.46463134818469906812e-04, 7.81794442939557092300e-05, 7.14072491382608190305e-05, -1.85586374855275456654e-05,
  2.59073051863633712884e-05,
]);
const PIO4 = 7.85398163397448278999e-01, PIO4LO = 3.06161699786838301793e-17;
function kernelTan(x: number, y: number, iy: number): number {
  let z: number, r: number, v: number, w: number, s: number;
  const hx = hiWord(x), ix = hx & 0x7FFFFFFF;
  if (ix < 0x3E300000) {
    if ((x | 0) === 0) {
      if (((ix | loWord(x)) | (iy + 1)) === 0) return 1 / Math.abs(x);
      if (iy === 1) return x;
      w = x + y;
      z = withLow(w, 0);
      v = y - (z - x);
      const a = -1 / w;
      const t = withLow(a, 0);
      s = 1 + t * z;
      return t + a * (s + t * v);
    }
  }
  if (ix >= 0x3FE59428) {
    if (hx < 0) { x = -x; y = -y; }
    z = PIO4 - x;
    w = PIO4LO - y;
    x = z + w;
    y = 0.0;
  }
  z = x * x;
  w = z * z;
  r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
  v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
  s = z * x;
  r = y + z * (s * (r + v) + y);
  r += T[0] * s;
  w = x + r;
  if (ix >= 0x3FE59428) {
    v = iy;
    return (1 - ((hx >> 30) & 2)) * (v - 2.0 * (x - (w * w / (w + v) - r)));
  }
  if (iy === 1) return w;
  z = withLow(w, 0);
  v = r - (z - x);
  const a = -1.0 / w;
  const t = withLow(a, 0);
  s = 1.0 + t * z;
  return t + a * (s + t * v);
}

export function sin(x: number): number {
  const ix = hiWord(x) & 0x7FFFFFFF;
  if (ix <= 0x3FE921FB) return kernelSin(x, 0, 0);
  if (ix >= 0x7FF00000) return x - x;
  const n = remPio2(x);
  switch (n & 3) {
    case 0: return kernelSin(Y[0], Y[1], 1);
    case 1: return kernelCos(Y[0], Y[1]);
    case 2: return -kernelSin(Y[0], Y[1], 1);
    default: return -kernelCos(Y[0], Y[1]);
  }
}

export function cos(x: number): number {
  const ix = hiWord(x) & 0x7FFFFFFF;
  if (ix <= 0x3FE921FB) return kernelCos(x, 0);
  if (ix >= 0x7FF00000) return x - x;
  const n = remPio2(x);
  switch (n & 3) {
    case 0: return kernelCos(Y[0], Y[1]);
    case 1: return -kernelSin(Y[0], Y[1], 1);
    case 2: return -kernelCos(Y[0], Y[1]);
    default: return kernelSin(Y[0], Y[1], 1);
  }
}

export function tan(x: number): number {
  const ix = hiWord(x) & 0x7FFFFFFF;
  if (ix <= 0x3FE921FB) return kernelTan(x, 0, 1);
  if (ix >= 0x7FF00000) return x - x;
  const n = remPio2(x);
  return kernelTan(Y[0], Y[1], 1 - ((n & 1) << 1));
}

const PI = 3.14159265358979311600e+00, PIO2_HI = 1.57079632679489655800e+00, PIO2_LO = 6.12323399573676603587e-17;
const PIO4_HI = 7.85398163397448278999e-01;
const PS0 = 1.66666666666666657415e-01, PS1 = -3.25565818622400915405e-01, PS2 = 2.01212532134862925881e-01;
const PS3 = -4.00555345006794114027e-02, PS4 = 7.91534994289814532176e-04, PS5 = 3.47933107596021167570e-05;
const QS1 = -2.40339491173441421878e+00, QS2 = 2.02094576023350569471e+00, QS3 = -6.88283971605453293030e-01;
const QS4 = 7.70381505559019352791e-02;

export function acos(x: number): number {
  let z: number, p: number, q: number, r: number, w: number, s: number;
  const hx = hiWord(x), ix = hx & 0x7FFFFFFF;
  if (ix >= 0x3FF00000) {
    if (((ix - 0x3FF00000) | loWord(x)) === 0) return hx > 0 ? 0.0 : PI + 2.0 * PIO2_LO;
    return NaN;
  }
  if (ix < 0x3FE00000) {
    if (ix <= 0x3C600000) return PIO2_HI + PIO2_LO;
    z = x * x;
    p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
    q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
    r = p / q;
    return PIO2_HI - (x - (PIO2_LO - x * r));
  }
  if (hx < 0) {
    z = (1 + x) * 0.5;
    p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
    q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
    s = Math.sqrt(z);
    r = p / q;
    w = r * s - PIO2_LO;
    return PI - 2.0 * (s + w);
  }
  z = (1 - x) * 0.5;
  s = Math.sqrt(z);
  const df = withLow(s, 0);
  const c = (z - df * df) / (s + df);
  p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
  q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
  r = p / q;
  w = r * s + c;
  return 2.0 * (df + w);
}

export function asin(x: number): number {
  let t = 0, w: number, p: number, q: number, s: number;
  const hx = hiWord(x), ix = hx & 0x7FFFFFFF;
  if (ix >= 0x3FF00000) {
    if (((ix - 0x3FF00000) | loWord(x)) === 0) return x * PIO2_HI + x * PIO2_LO;
    return NaN;
  } else if (ix < 0x3FE00000) {
    if (ix < 0x3E400000) {
      if (1.0e300 + x > 1) return x;
    } else {
      t = x * x;
    }
    p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
    q = 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
    w = p / q;
    return x + x * w;
  }
  w = 1 - Math.abs(x);
  t = w * 0.5;
  p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
  q = 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
  s = Math.sqrt(t);
  if (ix >= 0x3FEF3333) {
    w = p / q;
    t = PIO2_HI - (2.0 * (s + s * w) - PIO2_LO);
  } else {
    w = withLow(s, 0);
    const c = (t - w * w) / (s + w);
    const r = p / q;
    p = 2.0 * s * r - (PIO2_LO - 2.0 * c);
    q = PIO4_HI - 2.0 * w;
    t = PIO4_HI - (p - q);
  }
  return hx > 0 ? t : -t;
}

const ATANHI = new Float64Array([4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00]);
const ATANLO = new Float64Array([2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]);
const AT = new Float64Array([
  3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02,
]);

export function atan(x: number): number {
  let id: number;
  const hx = hiWord(x), ix = hx & 0x7FFFFFFF;
  if (ix >= 0x44100000) {
    if (ix > 0x7FF00000 || (ix === 0x7FF00000 && loWord(x) !== 0)) return x + x;
    return hx > 0 ? ATANHI[3] + ATANLO[3] : -ATANHI[3] - ATANLO[3];
  }
  if (ix < 0x3FDC0000) {
    if (ix < 0x3E400000) { if (1.0e300 + x > 1) return x; }
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3FF30000) {
      if (ix < 0x3FE60000) { id = 0; x = (2.0 * x - 1) / (2.0 + x); }
      else { id = 1; x = (x - 1) / (x + 1); }
    } else if (ix < 0x40038000) {
      id = 2; x = (x - 1.5) / (1 + 1.5 * x);
    } else {
      id = 3; x = -1.0 / x;
    }
  }
  let z = x * x;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  z = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
  return hx < 0 ? -z : z;
}

const TINY = 1.0e-300, PI_O_4 = 7.8539816339744827900E-01, PI_O_2 = 1.5707963267948965580E+00;
const PI_LO = 1.2246467991473531772E-16;

export function atan2(y: number, x: number): number {
  F[0] = x;
  const hx = U[HI] | 0, lx = U[LO], ix = hx & 0x7FFFFFFF;
  F[0] = y;
  const hy = U[HI] | 0, ly = U[LO], iy = hy & 0x7FFFFFFF;
  if ((ix | ((lx | -lx) >>> 31)) > 0x7FF00000 || (iy | ((ly | -ly) >>> 31)) > 0x7FF00000) return x + y;
  if (((hx - 0x3FF00000) | lx) === 0) return atan(y);
  let m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
  if ((iy | ly) === 0) {
    switch (m) {
      case 0: case 1: return y;
      case 2: return PI + TINY;
      default: return -PI - TINY;
    }
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;
  if (ix === 0x7FF00000) {
    if (iy === 0x7FF00000) {
      switch (m) {
        case 0: return PI_O_4 + TINY;
        case 1: return -PI_O_4 - TINY;
        case 2: return 3.0 * PI_O_4 + TINY;
        default: return -3.0 * PI_O_4 - TINY;
      }
    }
    switch (m) {
      case 0: return 0;
      case 1: return -0;
      case 2: return PI + TINY;
      default: return -PI - TINY;
    }
  }
  if (iy === 0x7FF00000) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;
  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) { z = PI_O_2 + 0.5 * PI_LO; m &= 1; }
  else if (hx < 0 && k < -60) z = 0.0;
  else z = atan(Math.abs(y / x));
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return PI - (z - PI_LO);
    default: return (z - PI_LO) - PI;
  }
}

const O_THRESHOLD = 7.09782712893383973096e+02, U_THRESHOLD = -7.45133219101941108420e+02;
const LN2HI = 6.93147180369123816490e-01, LN2LO = 1.90821492927058770002e-10, INVLN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05;
const P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;
const HUGE = 1.0e+300, TWOM1000 = 9.33263618503218878990e-302, TWO1023 = 8.988465674311579539e307;

export function exp(x: number): number {
  let y: number, hi = 0.0, lo = 0.0, k = 0, t: number;
  let hx = hiWord(x) >>> 0;
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7FFFFFFF;
  if (hx >= 0x40862E42) {
    if (hx >= 0x7FF00000) {
      if (((hx & 0xFFFFF) | loWord(x)) !== 0) return x + x;
      return xsb === 0 ? x : 0.0;
    }
    if (x > O_THRESHOLD) return HUGE * HUGE;
    if (x < U_THRESHOLD) return TWOM1000 * TWOM1000;
  }
  if (hx > 0x3FD62E42) {
    if (hx < 0x3FF0A2B2) {
      if (x === 1.0) return 2.718281828459045;
      hi = x - (xsb === 0 ? LN2HI : -LN2HI);
      lo = xsb === 0 ? LN2LO : -LN2LO;
      k = 1 - xsb - xsb;
    } else {
      k = (INVLN2 * x + (xsb === 0 ? 0.5 : -0.5)) | 0;
      t = k;
      hi = x - t * LN2HI;
      lo = t * LN2LO;
    }
    x = hi - lo;
  } else if (hx < 0x3E300000) {
    if (HUGE + x > 1) return 1 + x;
  } else {
    k = 0;
  }
  t = x * x;
  const twopk = k >= -1021 ? fromWords(0x3FF00000 + (k << 20), 0) : fromWords(0x3FF00000 + ((k + 1000) << 20), 0);
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2.0) - x);
  y = 1 - ((lo - (x * c) / (2.0 - c)) - hi);
  if (k >= -1021) {
    if (k === 1024) return y * 2.0 * TWO1023;
    return y * twopk;
  }
  return y * twopk * TWOM1000;
}

const DP_H1 = 5.84962487220764160156e-01, DP_L1 = 1.35003920212974897128e-08, TWO53 = 9007199254740992.0;
const L1 = 5.99999999999994648725e-01, L2 = 4.28571428578550184252e-01, L3 = 3.33333329818377432918e-01;
const L4 = 2.72728123808534006489e-01, L5 = 2.30660745775561754067e-01, L6 = 2.06975017800338417784e-01;
const LG2 = 6.93147180559945286227e-01, LG2_H = 6.93147182464599609375e-01, LG2_L = -1.90465429995776804525e-09;
const OVT = 8.0085662595372944372e-0017, CP = 9.61796693925975554329e-01, CP_H = 9.61796700954437255859e-01;
const CP_L = -7.02846165095275826516e-09, IVLN2 = 1.44269504088896338700e+00, IVLN2_H = 1.44269502162933349609e+00;
const IVLN2_L = 1.92596299112661746887e-08, POW_TINY = 1.0e-300;

export function pow(x: number, y: number): number {
  let z: number, ax: number, zH: number, zL: number, pH: number, pL: number;
  let y1: number, t1: number, t2: number, r: number, s: number, t: number, u: number, v: number, w: number;
  let i: number, j: number, k: number, n: number;
  F[0] = x;
  const hx = U[HI] | 0, lx = U[LO];
  F[0] = y;
  const hy = U[HI] | 0, ly = U[LO];
  let ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;
  if ((iy | ly) === 0) return 1;
  if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) || iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) return x + y;
  let yisint = 0;
  if (hx < 0) {
    if (iy >= 0x43400000) {
      yisint = 2;
    } else if (iy >= 0x3ff00000) {
      k = (iy >> 20) - 0x3ff;
      if (k > 20) {
        j = (ly >>> (52 - k)) | 0;
        if ((j << (52 - k)) === (ly | 0)) yisint = 2 - (j & 1);
      } else if (ly === 0) {
        j = iy >> (20 - k);
        if ((j << (20 - k)) === iy) yisint = 2 - (j & 1);
      }
    }
  }
  if (ly === 0) {
    if (iy === 0x7ff00000) {
      if (((ix - 0x3ff00000) | lx) === 0) return y - y;
      if (ix >= 0x3ff00000) return hy >= 0 ? y : 0;
      return hy < 0 ? -y : 0;
    }
    if (iy === 0x3ff00000) return hy < 0 ? 1 / x : x;
    if (hy === 0x40000000) return x * x;
    if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x);
  }
  ax = Math.abs(x);
  if (lx === 0) {
    if (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000) {
      z = ax;
      if (hy < 0) z = 1 / z;
      if (hx < 0) {
        if (((ix - 0x3ff00000) | yisint) === 0) z = NaN;
        else if (yisint === 1) z = -z;
      }
      return z;
    }
  }
  n = (hx >> 31) + 1;
  if ((n | yisint) === 0) return NaN;
  s = 1;
  if ((n | (yisint - 1)) === 0) s = -1;
  if (iy > 0x41e00000) {
    if (iy > 0x43f00000) {
      if (ix <= 0x3fefffff) return hy < 0 ? HUGE * HUGE : POW_TINY * POW_TINY;
      if (ix >= 0x3ff00000) return hy > 0 ? HUGE * HUGE : POW_TINY * POW_TINY;
    }
    if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * POW_TINY * POW_TINY;
    if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * POW_TINY * POW_TINY;
    t = ax - 1;
    w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
    u = IVLN2_H * t;
    v = t * IVLN2_L - w * IVLN2;
    t1 = withLow(u + v, 0);
    t2 = v - (t1 - u);
  } else {
    n = 0;
    if (ix < 0x00100000) {
      ax *= TWO53;
      n -= 53;
      ix = hiWord(ax);
    }
    n += (ix >> 20) - 0x3ff;
    j = ix & 0x000fffff;
    ix = j | 0x3ff00000;
    if (j <= 0x3988E) k = 0;
    else if (j < 0xBB67A) k = 1;
    else { k = 0; n += 1; ix -= 0x00100000; }
    ax = withHigh(ax, ix);
    const bp = k === 0 ? 1.0 : 1.5, dpH = k === 0 ? 0.0 : DP_H1, dpL = k === 0 ? 0.0 : DP_L1;
    u = ax - bp;
    v = 1 / (ax + bp);
    const ss = u * v;
    const sH = withLow(ss, 0);
    let tH = fromWords(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
    let tL = ax - (tH - bp);
    const sL = v * ((u - sH * tH) - sH * tL);
    let s2 = ss * ss;
    r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += sL * (sH + ss);
    s2 = sH * sH;
    tH = withLow(3.0 + s2 + r, 0);
    tL = r - ((tH - 3.0) - s2);
    u = sH * tH;
    v = sL * tH + tL * ss;
    pH = withLow(u + v, 0);
    pL = v - (pH - u);
    zH = CP_H * pH;
    zL = CP_L * pH + pL * CP + dpL;
    t = n;
    t1 = withLow(((zH + zL) + dpH) + t, 0);
    t2 = zL - (((t1 - t) - dpH) - zH);
  }
  y1 = withLow(y, 0);
  pL = (y - y1) * t1 + y * t2;
  pH = y1 * t1;
  z = pL + pH;
  F[0] = z;
  j = U[HI] | 0;
  i = U[LO] | 0;
  if (j >= 0x40900000) {
    if (((j - 0x40900000) | i) !== 0) return s * HUGE * HUGE;
    if (pL + OVT > z - pH) return s * HUGE * HUGE;
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    if (((j - 0xc090cc00) | i) !== 0) return s * POW_TINY * POW_TINY;
    if (pL <= z - pH) return s * POW_TINY * POW_TINY;
  }
  i = j & 0x7fffffff;
  k = (i >> 20) - 0x3ff;
  n = 0;
  if (i > 0x3fe00000) {
    n = j + (0x00100000 >> (k + 1));
    k = ((n & 0x7fffffff) >> 20) - 0x3ff;
    t = fromWords(n & ~(0x000fffff >> k), 0);
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) n = -n;
    pH -= t;
  }
  t = withLow(pL + pH, 0);
  u = t * LG2_H;
  v = (pL - (t - pH)) * LG2 + t * LG2_L;
  z = u + v;
  w = v - (z - u);
  t = z * z;
  t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  r = (z * t1) / ((t1 - 2) - (w + z * w));
  z = 1 - (r - z);
  j = hiWord(z);
  j = (j + (n << 20)) | 0;
  if ((j >> 20) <= 0) z = scalbn(z, n);
  else z = withHigh(z, (hiWord(z) + (n << 20)) | 0);
  return s * z;
}

export function hypot(x: number, y: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax === Infinity || ay === Infinity) return Infinity;
  if (ax !== ax || ay !== ay) return NaN;
  const max = ax > ay ? ax : ay;
  if (max === 0) return 0;
  let sum = 0, comp = 0, n = ax / max, summand = n * n - comp, pre = sum + summand;
  comp = (pre - sum) - summand; sum = pre;
  n = ay / max; summand = n * n - comp; pre = sum + summand;
  comp = (pre - sum) - summand; sum = pre;
  return Math.sqrt(sum) * max;
}

export function hypot3(x: number, y: number, z: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax === Infinity || ay === Infinity || az === Infinity) return Infinity;
  if (ax !== ax || ay !== ay || az !== az) return NaN;
  let max = ax > ay ? ax : ay;
  if (az > max) max = az;
  if (max === 0) return 0;
  let sum = 0, comp = 0, n = ax / max, summand = n * n - comp, pre = sum + summand;
  comp = (pre - sum) - summand; sum = pre;
  n = ay / max; summand = n * n - comp; pre = sum + summand;
  comp = (pre - sum) - summand; sum = pre;
  n = az / max; summand = n * n - comp; pre = sum + summand;
  comp = (pre - sum) - summand; sum = pre;
  return Math.sqrt(sum) * max;
}
