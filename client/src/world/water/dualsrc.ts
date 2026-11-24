// Dual-source blending (WEBGL_blend_func_extended): the water's main pass writes a SECOND colour output — the factor
// the scene behind it is multiplied by (per-channel transmission of the water column × reef × wet sand × (1 − fresnel))
// — so ONE draw does `dst = src0 + dst·src1` instead of a separate multiply pass over every water pixel (the pass cost
// ~0.3–0.5 ms at eye level: its own vertex work, raster and a second copy of the column maths).
//
// three.js knows neither the extension nor the SRC1 blend factors, so two narrow hooks on the WebGL context:
//  - shader source: a program that `#define`s WTR_DUAL_SRC gets `#extension GL_EXT_blend_func_extended : require` right
//    after its `#version` line and a second output `layout(location = 0, index = 1) out highp vec4 wtrSrc1;` next to
//    three's own `pc_fragColor` (nothing else is touched)
//  - blend factors: a material asks for SRC1_COLOR with the SENTINEL blendDst = THREE.SrcAlphaSaturateFactor (never a
//    destination factor anywhere else in the game); the hooks translate it. three's own state cache stays exact (it
//    only ever sees its own constants).
// If the extension is missing or the test program fails to compile/link, nothing is hooked and the water keeps its
// separate multiply pass (material.ts / index.ts fall back automatically).
import * as THREE from "three";
import { flag } from "../../flags";

export const DUAL_DST_SENTINEL = THREE.SrcAlphaSaturateFactor;

const MARK = "WTR_DUAL_SRC";
const PC_OUT = "layout(location = 0) out highp vec4 pc_fragColor;";

type GL = WebGL2RenderingContext & { __wtrDualSrc?: boolean };

/** hooks the renderer's context once; true = dual-source water is available */
export function installDualSource(renderer: THREE.WebGLRenderer): boolean {
  const gl = renderer.getContext() as GL;
  if (gl.__wtrDualSrc !== undefined) return gl.__wtrDualSrc;
  gl.__wtrDualSrc = false;
  if (flag("wnodual")) return false;       // (profiling / fallback check)
  if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) return false;
  const ext = gl.getExtension("WEBGL_blend_func_extended") as { SRC1_COLOR_WEBGL: number } | null;
  if (!ext) return false;
  // prove the driver takes the shader form we will generate
  const vs = gl.createShader(gl.VERTEX_SHADER)!, fs = gl.createShader(gl.FRAGMENT_SHADER)!, prog = gl.createProgram()!;
  gl.shaderSource(vs, "#version 300 es\nvoid main(){ gl_Position = vec4(0.0); }");
  gl.shaderSource(fs, `#version 300 es\n#extension GL_EXT_blend_func_extended : require\nprecision highp float;\n${PC_OUT}\nlayout(location = 0, index = 1) out highp vec4 wtrSrc1;\nvoid main(){ pc_fragColor = vec4(1.0); wtrSrc1 = vec4(0.5); }`);
  gl.compileShader(vs); gl.compileShader(fs);
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  const ok = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
  if (!ok) console.warn("[water] dual-source blending unavailable:", gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(prog));
  gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
  if (!ok) return false;

  const SRC1 = ext.SRC1_COLOR_WEBGL, SAT = gl.SRC_ALPHA_SATURATE, BLEND = gl.BLEND;
  const shaderSource = gl.shaderSource.bind(gl);
  gl.shaderSource = (sh: WebGLShader, src: string) => {
    // (fragment shaders only: three's pc_fragColor output line is the marker of one)
    if (src.includes("#define " + MARK) && src.includes(PC_OUT) && src.startsWith("#version 300 es\n")) {
      src = src.replace("#version 300 es\n", "#version 300 es\n#extension GL_EXT_blend_func_extended : require\n")
        .replace(PC_OUT, PC_OUT + "\nlayout(location = 0, index = 1) out highp vec4 wtrSrc1;");
    }
    shaderSource(sh, src);
  };
  const bfs = gl.blendFuncSeparate.bind(gl), bf = gl.blendFunc.bind(gl), en = gl.enable.bind(gl), dis = gl.disable.bind(gl);
  let src1 = false, sSr = 1, sSa = 1, sDa = 1;
  gl.blendFuncSeparate = (sr: number, dr: number, sa: number, da: number) => {
    src1 = dr === SAT; sSr = sr; sSa = sa; sDa = da === SAT ? SRC1 : da;
    bfs(sr, src1 ? SRC1 : dr, sa, da);
  };
  gl.blendFunc = (s: number, d: number) => { src1 = d === SAT; sSr = s; sSa = s; sDa = src1 ? SRC1 : d; bf(s, src1 ? SRC1 : d); };
  // ANGLE rejects subsequent non-blended FBO draws with GL_INVALID_OPERATION if BLEND_DST_RGB stays SRC1_COLOR_WEBGL.
  gl.disable = (c: number) => { dis(c); if (c === BLEND && src1) bfs(1, 0, 1, 0); };
  gl.enable = (c: number) => { if (c === BLEND && src1) bfs(sSr, SRC1, sSa, sDa); en(c); };
  gl.__wtrDualSrc = true;
  return true;
}
