const VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
uniform float uSeed;
out vec4 color;
void main() {
  vec2 q = gl_FragCoord.xy * 0.001 + uSeed;
  float a = 0.0;
  for (int i = 0; i < 128; i++) { q = vec2(q.x * q.y + 0.13, sin(q.x + q.y)); a += q.x; }
  color = vec4(fract(a), q, 1.0);
}`;
const SIDE_PX = 1024, TRIAL_MS = 30, TRIALS_N = 5, MAX_DRAWS_N = 4096;

export interface GpuScore { score: number; draws: number; trialMs: number[]; capped: boolean }

export function gpuScore(): GpuScore | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIDE_PX;
  const gl = canvas.getContext("webgl2", { powerPreference: "high-performance", antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  try {
    const shader = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.bindVertexArray(gl.createVertexArray());
    gl.viewport(0, 0, SIDE_PX, SIDE_PX);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const seed = gl.getUniformLocation(prog, "uSeed");
    const px = new Uint8Array(4);
    const trial = (draws: number) => {
      const t0 = performance.now();
      for (let i = 0; i < draws; i++) { gl.uniform1f(seed, i * 0.01); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return performance.now() - t0;
    };
    trial(1);
    let draws = 2;
    while (draws < MAX_DRAWS_N && trial(draws) < TRIAL_MS) draws *= 2;
    const trialMs: number[] = [];
    for (let i = 0; i < TRIALS_N; i++) trialMs.push(trial(draws));
    const sorted = [...trialMs].sort((a, b) => a - b);
    const median = sorted[TRIALS_N >> 1];
    return { score: Math.round(draws / Math.max(median, 0.1) * 1000), draws, trialMs: trialMs.map((t) => Math.round(t * 10) / 10), capped: draws >= MAX_DRAWS_N };
  } finally { gl.getExtension("WEBGL_lose_context")?.loseContext(); }
}
