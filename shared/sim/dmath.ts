/*
 * Deterministic Math for shared/: the same bits on every CPU, OS and JS engine.
 * A port of V8's src/base/ieee754.cc (fdlibm) and its Torque Math.hypot, using only + - * /, Math.sqrt and exact bit
 * moves, which IEEE 754 fixes everywhere. Built-ins differ by an ulp between engines and between compilers (V8 on
 * arm64 is built with fused multiply-add), which split the headless match between Macs and Linux.
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 *
 * The original source code covered by the above license has been
 * modified significantly by Google Inc.
 * Copyright 2016 the V8 project authors. All rights reserved.
 * Use of the V8 code is governed by a BSD-style license (https://github.com/v8/v8/blob/main/LICENSE).
 */

export * from "./dmath.hot";
