// Hemi-octahedral impostors: each species is baked (once its textures are loaded) into an N×N atlas of views over the
// upper hemisphere — graded albedo + alpha, and object-space normals — using the species' own vertex path (billboard
// canopy cards face the bake camera, so a baked canopy is as full as the real one). Beyond the LOD1 distance every
// instance is ONE camera-facing quad that picks the nearest baked view (in object space, so yaw works) and shades the
// baked normal with the SAME foliage lighting as the meshes (wrap, translucency, fill) → no colour pop at the switch.
// This is what lets the master aerial show a continuous lush canopy of ~40k plants for the cost of 40k quads.
import * as THREE from "three";
import type { Species } from "./species/types";
import { VEG_UNIFORMS, VEG_LIGHT, VEG_GLSL, VEG_FADE_T, bakeMaterial, vegUniforms, retireMaterial } from "./foliage-material";
import { crownFootprint } from "../../../../shared/world/veg-scatter";
import { flag } from "../../flags";
import { bake } from "../../engine/res/restore";

/** view blending: each pixel shows one of the 4 baked
 *  views around the true view direction (dithered by weight, a crossfade only across a narrow band at a view cell's edge)
 *  on a quad facing the TRUE view — instead of the nearest view on a quad facing it, which jumped to the next baked view
 *  every ~11° of bearing / ~22° of elevation. ?impblend=0 = the old nearest-view impostors (A/B). */
export const IMP_BLEND = flag("impblend");
/** half-width of the crossfade band at a view cell's edge (fraction of the cell: 0.15 → pure views over the middle 70 %) */
const IMP_BAND = 0.15;

export interface ImpostorAtlas {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  frames: number;
  center: THREE.Vector3;
  radius: number;
  /** per-frame tight 2D bounds of the plant in frame-local 0..1 (x0, y0, x1, y1) — the quad is shrunk to it */
  rects: THREE.DataTexture;
  /** the bake targets (disposed once copied into a bank) */
  targets: THREE.WebGLRenderTarget[];
}

/** tight per-frame bounds: every LOD0 vertex (billboard cards: centre ± their half diagonal) projected per view */
function frameRects(sp: Species, frames: number, C: THREE.Vector3, R: number): THREE.DataTexture {
  const data = new Float32Array(frames * frames * 4);
  const pts: number[] = [], ext: number[] = [];
  for (const part of sp.parts) {
    const g = part.bake ?? part.lod0, p = g.attributes.position as THREE.BufferAttribute | undefined;
    if (!p) continue;
    const bb = vegUniforms(part.mats).uBillboard.value;
    // (fixed 3D crown cards carry aCard for their wind only — their real corners bound them)
    const card = bb > 0 ? g.attributes.aCard as THREE.BufferAttribute | undefined : undefined;
    for (let i = 0; i < p.count; i += card ? 4 : 1) {
      if (card) { pts.push(card.getX(i), card.getY(i), card.getZ(i)); ext.push(card.getW(i) * (0.72 * bb + 0.75 * (1 - bb))); }
      else { pts.push(p.getX(i), p.getY(i), p.getZ(i)); ext.push(0); }
    }
  }
  const x = new THREE.Vector3(), y = new THREE.Vector3(), up = new THREE.Vector3();
  for (let j = 0; j < frames; j++) for (let i = 0; i < frames; i++) {
    const d = hemiDecode((i + 0.5) / frames, (j + 0.5) / frames);
    up.set(0, 1, 0); if (d.y > 0.999) up.set(0, 0, -1);
    x.crossVectors(up, d).normalize(); y.crossVectors(d, x);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let k = 0, n = ext.length; k < n; k++) {
      const px = pts[k * 3] - C.x, py = pts[k * 3 + 1] - C.y, pz = pts[k * 3 + 2] - C.z, e = ext[k];
      const u = px * x.x + py * x.y + pz * x.z, v = px * y.x + py * y.y + pz * y.z;
      if (u - e < x0) x0 = u - e; if (u + e > x1) x1 = u + e; if (v - e < y0) y0 = v - e; if (v + e > y1) y1 = v + e;
    }
    const o = (j * frames + i) * 4, m = 0.015;
    data[o] = Math.max(0, (x0 / R + 1) / 2 - m); data[o + 1] = Math.max(0, (y0 / R + 1) / 2 - m);
    data[o + 2] = Math.min(1, (x1 / R + 1) / 2 + m); data[o + 3] = Math.min(1, (y1 / R + 1) / 2 + m);
  }
  const t = new THREE.DataTexture(data, frames * frames, 1, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true;
  return t;
}

const HEMI_GLSL = /* glsl */ `
vec2 vegHemiEncode( vec3 d ) {
  d /= ( abs( d.x ) + abs( d.y ) + abs( d.z ) );
  return vec2( d.x + d.z, d.x - d.z ) * 0.5 + 0.5;
}
`;

/** decode a hemi-octahedral uv (0..1) into a unit direction (y ≥ 0) — JS mirror of the shader */
export function hemiDecode(u: number, v: number): THREE.Vector3 {
  const px = u * 2 - 1, py = v * 2 - 1;
  const x = (px + py) * 0.5, z = (px - py) * 0.5;
  const y = 1 - Math.abs(x) - Math.abs(z);
  return new THREE.Vector3(x, Math.max(0, y), z).normalize();
}

/**
 * Bake the species' LOD0 into hemi-octahedral atlases. Each frame's ortho camera is fitted to that view's TIGHT bounds
 * (frameRects) — a palm seen from the side fills its frame instead of a third of it (≈1.5–2.5× the texel density of a
 * bounding-sphere frame) — then both atlases are colour-DILATED (dilate()): transparent texels take the nearest leaf's
 * colour / normal, so bilinear + mip filtering at the silhouette never pulls in the clear colour (the dark fringes).
 */
export function bakeImpostor(renderer: THREE.WebGLRenderer, sp: Species, frames = 8, size = 1024, nsize = size): ImpostorAtlas {
  const scene = new THREE.Scene();
  const meshes: Array<{ mesh: THREE.Mesh; albedo: THREE.Material; normal: THREE.Material }> = [];
  // bark / trunk parts are baked darker: seen from afar they stand in the canopy's shade (no pale "lollipop" sticks);
  // a height ramp gives the baked crowns lit tops and shaded undersides (the aerial's lumpy puffs)
  const b0 = new THREE.Box3();
  const geoOf = (part: Species["parts"][number]) => part.bake ?? part.lod0;
  for (const part of sp.parts) { const g = geoOf(part); if (g.attributes.position) { g.computeBoundingBox(); b0.union(g.boundingBox!); } }
  for (const part of sp.parts) {
    const pg = geoOf(part);
    if (!pg.attributes.position || pg.attributes.position.count === 0) continue;
    const leafy = vegUniforms(part.mats).uTrans.value > 0.3;
    // palm crowns bake brighter / yellower: from the air they must read as lime stars against the broadleaf puffs
    const palm = sp.kind === "palm" || sp.kind === "palm-leaning";
    const albedo = bakeMaterial(part.mats, "albedo", { tint: leafy ? (palm ? 1.18 : 1) : 0.5, yRange: [b0.min.y, b0.max.y] });
    const normal = bakeMaterial(part.mats, "normal");
    const mesh = new THREE.Mesh(pg, albedo);
    mesh.frustumCulled = false;
    scene.add(mesh);
    meshes.push({ mesh, albedo, normal });
  }
  const R = sp.boundR * 1.02, C = sp.center;
  const rects = frameRects(sp, frames, C, R);
  const rd = rects.image.data as Float32Array;
  const mk = (sz: number) => {
    const rt = new THREE.WebGLRenderTarget(sz, sz, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, colorSpace: THREE.NoColorSpace });
    return rt;
  };
  const rtA = mk(size), rtN = mk(nsize);
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.01, R * 4);

  const prevRT = renderer.getRenderTarget();
  const prevClear = new THREE.Color(); renderer.getClearColor(prevClear); const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevScissor = renderer.getScissorTest();
  const prevViewport = renderer.getViewport(new THREE.Vector4());
  const prevScissorRect = renderer.getScissor(new THREE.Vector4());
  const prevTone = renderer.toneMapping;
  const wind = VEG_UNIFORMS.uWind.value.y;
  VEG_UNIFORMS.uWind.value.y = 0;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.autoClear = false;
  for (const pass of ["albedo", "normal"] as const) {
    const rt = pass === "albedo" ? rtA : rtN, sz = pass === "albedo" ? size : nsize, cell = sz / frames;
    for (const m of meshes) m.mesh.material = m[pass];
    // albedo clears to a mid green with alpha 0 (mip filtering bleeds green, not black, into the silhouette)
    if (pass === "albedo") renderer.setClearColor(0x3a6a2a, 0); else renderer.setClearColor(0x80ff80, 0);
    renderer.setRenderTarget(rt);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, sz, sz);
    renderer.clear(true, true, false);
    renderer.setScissorTest(true);
    for (let j = 0; j < frames; j++) for (let i = 0; i < frames; i++) {
      const dir = hemiDecode((i + 0.5) / frames, (j + 0.5) / frames);
      cam.position.copy(C).addScaledVector(dir, R * 2);
      cam.up.set(0, 1, 0);
      if (dir.y > 0.999) cam.up.set(0, 0, -1);
      cam.lookAt(C);
      // the frame's tight rect (frame-local 0..1 of the ±R square) is the camera window
      const o = (j * frames + i) * 4;
      cam.left = (rd[o] * 2 - 1) * R; cam.bottom = (rd[o + 1] * 2 - 1) * R; cam.right = (rd[o + 2] * 2 - 1) * R; cam.top = (rd[o + 3] * 2 - 1) * R;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      renderer.setViewport(i * cell, j * cell, cell, cell);
      renderer.setScissor(i * cell, j * cell, cell, cell);
      renderer.clear(true, true, false);
      renderer.render(scene, cam);
    }
  }
  VEG_UNIFORMS.uWind.value.y = wind;
  renderer.setRenderTarget(prevRT);
  renderer.setViewport(prevViewport);
  renderer.setScissor(prevScissorRect);
  renderer.setScissorTest(prevScissor);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAuto;
  renderer.toneMapping = prevTone;
  for (const m of meshes) { retireMaterial(renderer, m.albedo); retireMaterial(renderer, m.normal); }
  const dA = dilate(renderer, rtA, frames), dN = dilate(renderer, rtN, frames);
  rtA.dispose(); rtN.dispose();
  return { albedo: dA.texture, normal: dN.texture, frames, center: C.clone(), radius: R, rects, targets: [dA, dN] };
}

/**
 * Colour dilation inside each frame: 7 jump-flood steps (64 … 1 texels) copy the nearest opaque texel's rgb into every
 * transparent texel (alpha kept), never across a frame border. Mips of the result bleed leaf colour, not the clear colour.
 */
function dilate(renderer: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, frames: number): THREE.WebGLRenderTarget {
  const sz = src.width;
  const mk = () => new THREE.WebGLRenderTarget(sz, sz, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, colorSpace: THREE.NoColorSpace });
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: src.texture }, uStep: { value: 1 }, uSize: { value: sz }, uFrames: { value: frames } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
    fragmentShader: /* glsl */ `
      uniform sampler2D map; uniform float uStep, uSize, uFrames; varying vec2 vUv;
      void main() {
        vec4 c = texture2D( map, vUv );
        if ( c.a > 0.02 ) { gl_FragColor = c; return; }
        vec2 f0 = floor( vUv * uFrames ) / uFrames, lo = f0 + 0.5 / uSize, hi = f0 + 1.0 / uFrames - 0.5 / uSize;
        vec3 acc = vec3( 0.0 ); float w = 0.0;
        for ( int y = -1; y <= 1; y++ ) for ( int x = -1; x <= 1; x++ ) {
          if ( x == 0 && y == 0 ) continue;
          vec2 q = clamp( vUv + vec2( float( x ), float( y ) ) * uStep / uSize, lo, hi );
          vec4 s = texture2D( map, q );
          // a texel that already carries dilated colour (alpha 0, rgb set) counts too: the flag lives in rgb != clear
          float k = s.a > 0.02 ? 1.0 : ( s.r + s.g + s.b > 0.0 ? 0.6 : 0.0 );
          acc += s.rgb * k; w += k;
        }
        gl_FragColor = w > 0.0 ? vec4( acc / w, 0.0 ) : vec4( 0.0 );
      }`,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); q.frustumCulled = false; scene.add(q);
  let a = mk(), b = mk();
  const prev = renderer.getRenderTarget();
  // pass 0 clears the transparent texels' rgb (the bake cleared to a mid colour): only real leaf colour propagates
  mat.uniforms.uStep.value = 0;
  const clearMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: src.texture } },
    vertexShader: mat.vertexShader,
    fragmentShader: "uniform sampler2D map; varying vec2 vUv; void main() { vec4 c = texture2D( map, vUv ); gl_FragColor = c.a > 0.02 ? c : vec4( 0.0 ); }",
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  q.material = clearMat; renderer.setRenderTarget(a); renderer.render(scene, cam);
  q.material = mat;
  for (const step of [64, 32, 16, 8, 4, 2, 1, 1]) {
    mat.uniforms.map.value = a.texture; mat.uniforms.uStep.value = step;
    renderer.setRenderTarget(b); renderer.render(scene, cam);
    const t = a; a = b; b = t;
  }
  renderer.setRenderTarget(prev);
  b.dispose(); retireMaterial(renderer, mat); retireMaterial(renderer, clearMat); q.geometry.dispose();
  return a;
}

const V_IMP = /* glsl */ `
attribute float aSpecies;
// (dx, dz) from the plant base to the nearest dirt-road sample (world m) + the road edge's distance (999 = none)
attribute vec3 aRoad;
uniform vec3 uSunDir;
flat varying float vImpTone;
attribute vec2 aFade;          // x = switch time (s), y = 0 visible | 1 fading in | −1 fading out | 2 hidden (lod.ts)
uniform float uFadeNow;
varying float vImpVis;
uniform sampler2D uSpParams;   // RGBA32F, 5 texels per species row: centre+radius | fade-in start, end, trans, fill | trans colour, wrap | envK, top boost | crown offset x, z, top, radius
uniform sampler2D uRects;      // RGBA32F, frames² texels per species row: tight per-frame bounds
uniform float uFrames;
uniform float uNoFade;
uniform vec2 uImpFar;
uniform vec3 uCamPos;
varying vec3 vImpWorld;
varying mat3 vRotW;
#ifdef VEG_IMP_BLEND
varying vec4 vImpQ01;          // rect-local uv of the 4 neighbouring baked views on this quad (views 0, 1 | 2, 3)
varying vec4 vImpQ23;
flat varying vec4 vImpF;       // their frame index (fy · N + fx)
flat varying vec4 vImpW;       // their blend weights
vec3 vegImpDir( vec2 f ) {
  vec2 fc = ( f + 0.5 ) / uFrames * 2.0 - 1.0;
  float fx = ( fc.x + fc.y ) * 0.5, fz = ( fc.x - fc.y ) * 0.5;
  return normalize( vec3( fx, max( 0.0, 1.0 - abs( fx ) - abs( fz ) ), fz ) );
}
#else
varying vec2 vImpUv;
#endif
varying float vDist;
flat varying float vLayer;
flat varying vec4 vImpA;
flat varying vec3 vImpTC;
` + HEMI_GLSL;

const V_IMP_BODY = /* glsl */ `
vec3 transformed;
float vegImpWet = 0.0;
{
  int sp = int( aSpecies + 0.5 );
  vec4 p0 = texelFetch( uSpParams, ivec2( 0, sp ), 0 );
  vec4 p1 = texelFetch( uSpParams, ivec2( 1, sp ), 0 );
  vec4 p2 = texelFetch( uSpParams, ivec2( 2, sp ), 0 );
  vec4 p3 = texelFetch( uSpParams, ivec2( 3, sp ), 0 );
  vec4 p4 = texelFetch( uSpParams, ivec2( 4, sp ), 0 );
  vec3 uCenter = p0.xyz;
  float uRadius = p0.w;
  float topBoost = p3.y > 0.0 ? p3.y : 1.0;
  vLayer = float( sp );
  vImpA = vec4( p1.z, p1.w, p2.w, p3.x );
  vImpTC = p2.rgb;
  #ifdef USE_INSTANCING
    mat3 iRot = mat3( instanceMatrix );
    float iScale = length( iRot[ 0 ] );
    iRot = iRot / max( iScale, 1e-5 );
    vec3 iPos = instanceMatrix[ 3 ].xyz;
  #else
    mat3 iRot = mat3( 1.0 );
    float iScale = 1.0;
    vec3 iPos = vec3( 0.0 );
  #endif
  vec3 wc = iPos + iRot * ( uCenter * iScale );
  vec3 vd = transpose( iRot ) * ( cameraPosition - wc );
  vd = normalize( vd );
  vd.y = max( vd.y, 0.0 );
  vd = normalize( vd + vec3( 0.0, 1e-3, 0.0 ) );
  vec2 fuv = vegHemiEncode( vd );
#ifdef VEG_IMP_BLEND
  // the 4 baked views around the view direction, bilinear weights sharpened to a band at the cell
  // edges; the quad faces the TRUE view (continuous: nothing on it snaps) and is bounded by the views' tight rects
  vec2 fp = clamp( fuv * uFrames - 0.5, 0.0, uFrames - 1.0 );
  vec2 fb = min( floor( fp ), uFrames - 2.0 );
  vec2 ft = smoothstep( 0.5 - VEG_IMP_BAND, 0.5 + VEG_IMP_BAND, fp - fb );
  vec4 fw = vec4( ( 1.0 - ft.x ) * ( 1.0 - ft.y ), ft.x * ( 1.0 - ft.y ), ( 1.0 - ft.x ) * ft.y, ft.x * ft.y );
  vImpW = fw;
  vec2 fk[ 4 ];
  fk[ 0 ] = fb; fk[ 1 ] = fb + vec2( 1.0, 0.0 ); fk[ 2 ] = fb + vec2( 0.0, 1.0 ); fk[ 3 ] = fb + vec2( 1.0 );
  vImpF = vec4( fk[ 0 ].y * uFrames + fk[ 0 ].x, fk[ 1 ].y * uFrames + fk[ 1 ].x, fk[ 2 ].y * uFrames + fk[ 2 ].x, fk[ 3 ].y * uFrames + fk[ 3 ].x );
  // the quad's basis: the dominant view's right axis made orthogonal to the true view
  vec2 f = fb + step( 0.5, ft );
  vec3 fd = vegImpDir( f );
  vec3 rgt = normalize( cross( fd.y > 0.999 ? vec3( 0.0, 0.0, -1.0 ) : vec3( 0.0, 1.0, 0.0 ), fd ) );
  rgt = normalize( rgt - vd * dot( rgt, vd ) );
  vec3 upv = cross( vd, rgt );
  // bounds: the union of the weighted views' tight rects (frame-local 0..1) + a margin for their small rotation
  vec4 rk[ 4 ];
  vec4 rc = vec4( 1.0, 1.0, 0.0, 0.0 );
  for ( int k = 0; k < 4; k ++ ) {
    rk[ k ] = texelFetch( uRects, ivec2( int( vImpF[ k ] + 0.5 ), sp ), 0 );
    if ( fw[ k ] > 0.0 ) rc = vec4( min( rc.xy, rk[ k ].xy ), max( rc.zw, rk[ k ].zw ) );
  }
  rc += vec4( -0.04, -0.04, 0.04, 0.04 );
  vec2 q = mix( rc.xy, rc.zw, uv );
  float tb = mix( 1.0, topBoost, smoothstep( 0.55, 0.95, vd.y ) );
  vec3 rel = ( rgt * ( q.x - 0.5 ) + upv * ( q.y - 0.5 ) ) * ( 2.0 * uRadius * tb );
  // each view's rect-local uv of this corner: the corner carried along the view onto that view's plane
  vec2 lq[ 4 ];
  for ( int k = 0; k < 4; k ++ ) {
    vec3 dk = vegImpDir( fk[ k ] );
    vec3 rk3 = normalize( cross( dk.y > 0.999 ? vec3( 0.0, 0.0, -1.0 ) : vec3( 0.0, 1.0, 0.0 ), dk ) ), uk3 = cross( dk, rk3 );
    vec3 onP = rel - vd * ( dot( rel, dk ) / max( dot( vd, dk ), 0.2 ) );
    vec2 qk = vec2( dot( onP, rk3 ), dot( onP, uk3 ) ) / ( 2.0 * uRadius * tb ) + 0.5;
    lq[ k ] = ( qk - rk[ k ].xy ) / max( rk[ k ].zw - rk[ k ].xy, vec2( 1e-4 ) );
  }
  vImpQ01 = vec4( lq[ 0 ], lq[ 1 ] ); vImpQ23 = vec4( lq[ 2 ], lq[ 3 ] );
  transformed = uCenter + rel;
  // push the quad toward the camera so it does not cut into the ground / neighbours (along the view: the image stays put)
  transformed += vd * uRadius * 0.35;
  {
    float yLow = uCenter.y + upv.y * ( rc.y - 0.5 ) * 2.0 * uRadius * tb + vd.y * uRadius * 0.35;
    float wLow = iPos.y + yLow * iScale;
    float need = ( 0.3 - wLow ) / max( vd.y, 0.2 ) / max( iScale, 1e-3 );
    transformed += vd * clamp( need, 0.0, 2.0 * uRadius ) * smoothstep( 0.12, 0.3, vd.y );
  }
#else
  vec2 f = clamp( floor( fuv * uFrames ), 0.0, uFrames - 1.0 );
  // the quad faces the BAKED direction of the chosen frame (not the exact view dir) so the image lines up
  vec2 fc = ( f + 0.5 ) / uFrames * 2.0 - 1.0;
  float fx = ( fc.x + fc.y ) * 0.5, fz = ( fc.x - fc.y ) * 0.5;
  vec3 fd = normalize( vec3( fx, max( 0.0, 1.0 - abs( fx ) - abs( fz ) ), fz ) );
  vec3 upRef = fd.y > 0.999 ? vec3( 0.0, 0.0, -1.0 ) : vec3( 0.0, 1.0, 0.0 );
  vec3 rgt = normalize( cross( upRef, fd ) );
  vec3 upv = cross( fd, rgt );
  // the quad covers only this frame's tight bounds (rect in frame-local 0..1): ~half the fragments of the full frame
  vec4 rc = texelFetch( uRects, ivec2( int( f.y * uFrames + f.x ), sp ), 0 );
  vec2 q = mix( rc.xy, rc.zw, uv );
  // seen from above, palm crowns grow (the aerial's palm stars read at 1–2 px per metre)
  float tb = mix( 1.0, topBoost, smoothstep( 0.55, 0.95, vd.y ) );
  transformed = uCenter + ( rgt * ( q.x - 0.5 ) + upv * ( q.y - 0.5 ) ) * ( 2.0 * uRadius * tb );
  // push the quad toward the camera so it does not cut into the ground / neighbours
  transformed += fd * uRadius * 0.35;
  // (else aerial mangrove crowns look turquoise, as if under water) seen from above, a quad whose lower edge
  // dips below the sea is covered by the water surface (depth-tested) and tinted — slide the whole quad toward the
  // camera (the image stays aligned) until its lowest edge is 0.3 m above sea level
  {
    float yLow = uCenter.y + upv.y * ( rc.y - 0.5 ) * 2.0 * uRadius * tb + fd.y * uRadius * 0.35;
    float wLow = iPos.y + yLow * iScale;
    float need = ( 0.3 - wLow ) / max( fd.y, 0.2 ) / max( iScale, 1e-3 );
    transformed += fd * clamp( need, 0.0, 2.0 * uRadius ) * smoothstep( 0.12, 0.3, fd.y );
  }
  float inset = 1.0 / ( uFrames * 128.0 );
  // the baked frame IS the tight rect (bakeImpostor fits its camera to it): the quad's uv maps straight onto it
  vImpUv = ( f + mix( vec2( inset ), vec2( 1.0 - inset ), uv ) ) / uFrames;
#endif
  vRotW = iRot;
  // plants rooted at the waterline (mangroves, lagoon islets): see the depth bias after project_vertex
  vegImpWet = 1.0 - smoothstep( 1.2, 2.0, iPos.y );
  // (else from the air the canopy buries the dirt-road network) seen from altitude (> 90 m above the
  // plant, all impostors — no mesh tier is drawn that far), a plant whose silhouette would cover a dirt road shrinks
  // toward its base just enough to clear it: its crown reach toward the road (lean offset + the crown radius + the
  // height's ground footprint behind it along the view, H·cot(elevation)) must end before the road's edge. Plants on the
  // far side of a road only pull their crown's near edge back. Deterministic, per instance, no pop: the factor fades in
  // with altitude (90 → 260 m) — at ground level and in the static far-shadow bake nothing changes.
  // The static far-shadow bake (depth pass, uNoFade = 1) runs the same test along the SUN's direction, so the far
  // shadows keep off the roads too (the aerial sees only that map; at ground level the near cascades draw the meshes').
  float roadK = 1.0;
  if ( aRoad.z < 60.0 ) {
    float aw = 0.0, cotE = 1.0;
    vec2 vh = vec2( 0.0, 1.0 );
    #ifdef VEG_IMP_DEPTH
      if ( uNoFade > 0.5 ) {
        vec3 L = normalize( uSunDir );
        vh = -normalize( L.xz + vec2( 1e-4, 0.0 ) ); cotE = length( L.xz ) / max( L.y, 0.05 ); aw = 1.0;
      }
    #else
      float alt = cameraPosition.y - iPos.y;
      aw = smoothstep( 90.0, 260.0, alt );
      vec2 toCam = cameraPosition.xz - iPos.xz;
      float hd = max( length( toCam ), 1.0 );
      vh = -toCam / hd;
      cotE = hd / max( alt, 1.0 );
    #endif
    if ( aw > 0.0 ) {
      vec2 rn = normalize( aRoad.xy + vec2( 1e-4, 0.0 ) );
      vec3 offW = iRot * vec3( p4.x, 0.0, p4.y ) * iScale;
      float reach = dot( offW.xz, rn ) + p4.z * iScale * cotE * max( dot( vh, rn ), 0.0 ) + p4.w * iScale;
      float k = clamp( ( aRoad.z - 0.8 ) / max( reach, 0.5 ), 0.0, 1.0 );
      roadK = mix( 1.0, k * k * ( 3.0 - 2.0 * k ) * 0.35 + k * 0.65, aw );
    }
  }
  // the understory bank ends at a distance for ground-level eyes — shrink out over a 90 m band
  // instead of whole 128 m cells vanishing (lod.ts ImpostorSet.cull keeps every cell nearer than the band's end)
  if ( uImpFar.y > 0.0 && uNoFade < 0.5 ) roadK *= 1.0 - smoothstep( uImpFar.x, uImpFar.y, distance( iPos, uCamPos ) );
  transformed *= roadK;
  if ( roadK < 0.03 ) transformed = vec3( 0.0 );
  // distant canopy variety (not one uniform saturated carpet): a quarter of the crowns read darker far away
  vImpTone = fract( sin( dot( floor( iPos.xz * 4.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) < 0.25 ? 0.8 : 1.0;
  vImpWorld = iPos + iRot * ( transformed * iScale );
  vDist = distance( vImpWorld, uCamPos );
  // LOD crossfade state (the static far-shadow bake draws every quad): instances shown as real meshes are collapsed to
  // a point — no raster, no discarded fragments (their quads are screen-sized up close)
  float vis = 1.0;
  if ( uNoFade < 0.5 && aFade.y != 0.0 ) {
    float k = clamp( ( uFadeNow - aFade.x ) / VEG_FADE_T, 0.0, 1.0 );
    vis = aFade.y > 1.5 ? 0.0 : aFade.y > 0.0 ? k : 1.0 - k;
  }
  vImpVis = aFade.y < 0.0 && uNoFade < 0.5 ? -vis : vis;
  if ( vis <= 0.0 ) transformed = uCenter;
}
`;

/**
 * Aerial mangrove crowns over the NE lagoon read turquoise-tinted, as if under water, without this: the water's
 * colour passes carry polygonOffsetUnits −6 (water material.ts OFS_COLOUR) — a constant WINDOW-space depth pull that
 * is ~17 m toward the camera at the aerial's 2.2 km, so the lagoon surface was drawn over crowns standing 3–6 m above
 * it. Impostors of plants rooted at the waterline take a matching constant pull (10 units ≈ 1.2e-6 NDC): negligible up
 * close (0.3 m at 200 m), exactly the water's reach from the air. (A cleaner fix: the water scaling its far offset by distance.)
 */
const V_IMP_WET = /* glsl */ `
gl_Position.z -= vegImpWet * 1.2e-6 * gl_Position.w;
`;

const F_IMP = /* glsl */ `
flat varying float vImpTone;
uniform highp sampler2DArray uAlbedoArr;
uniform highp sampler2DArray uNormalArr;
flat varying float vLayer;
#ifdef VEG_IMP_BLEND
uniform float uFrames;
varying vec4 vImpQ01;
varying vec4 vImpQ23;
flat varying vec4 vImpF;
flat varying vec4 vImpW;
// the weighted blend of the (up to 4) baked views around the view direction: albedo (by coverage),
// coverage and the object-space normal. A view whose weight is 0 is not sampled — an impostor between transition bands
// (most of the time) costs one albedo + one normal fetch. Gradients come from each view's own continuous uv.
// mixK = 1 − the largest weight (0 = one view). bias scales the gradients (2^−0.35 ≈ a −0.35 mip bias).
float vegImpIn( vec2 l ) { return l.x >= 0.0 && l.y >= 0.0 && l.x <= 1.0 && l.y <= 1.0 ? 1.0 : 0.0; }
vec4 vegImpBlend( out vec3 nrm, out float mixK, float bias, bool normals ) {
  vec4 ax = dFdx( vImpQ01 ), ay = dFdy( vImpQ01 ), bx = dFdx( vImpQ23 ), by = dFdy( vImpQ23 );
  float inset = 1.0 / ( uFrames * 128.0 ), k = ( 1.0 - 2.0 * inset ) / uFrames;
  vec2 ts = vec2( textureSize( uAlbedoArr, 0 ).xy );
  vec4 acc = vec4( 0.0 ); vec3 nacc = vec3( 0.0 ); float wmax = 0.0;
  for ( int i = 0; i < 4; i ++ ) {
    float w = vImpW[ i ];
    if ( w <= 0.002 ) continue;
    vec2 l = i == 0 ? vImpQ01.xy : i == 1 ? vImpQ01.zw : i == 2 ? vImpQ23.xy : vImpQ23.zw;
    vec2 gx = ( i == 0 ? ax.xy : i == 1 ? ax.zw : i == 2 ? bx.xy : bx.zw ) * k;
    vec2 gy = ( i == 0 ? ay.xy : i == 1 ? ay.zw : i == 2 ? by.xy : by.zw ) * k;
    float id = vImpF[ i ];
    vec2 cell = vec2( mod( id, uFrames ), floor( id / uFrames + 0.01 ) );
    vec2 uv = ( cell + inset + clamp( l, 0.0, 1.0 ) * ( 1.0 - 2.0 * inset ) ) / uFrames;
    vec4 c = textureGrad( uAlbedoArr, vec3( uv, vLayer ), gx * bias, gy * bias );
    // (coverage kept at distance: alpha × (1 + 0.25 · mip level))
    vec2 dx = gx * ts, dy = gy * ts;
    c.a *= vegImpIn( l ) * ( 1.0 + max( 0.5 * log2( max( max( dot( dx, dx ), dot( dy, dy ) ), 1e-8 ) ), 0.0 ) * 0.25 );
    acc += vec4( c.rgb * min( c.a, 1.0 ), min( c.a, 1.0 ) ) * w;
    if ( normals ) nacc += ( textureGrad( uNormalArr, vec3( uv, vLayer ), gx, gy ).xyz * 2.0 - 1.0 ) * ( min( c.a, 1.0 ) * w + 1e-4 );
    wmax = max( wmax, w );
  }
  nrm = nacc;
  mixK = 1.0 - wmax;
  return vec4( acc.rgb / max( acc.a, 1e-4 ), acc.a );
}
// the alpha-test threshold while views blend: where their silhouettes disagree (blended coverage between 0 and 1) a
// dithered threshold dissolves one outline into the other (moving every frame under TAA); where they agree, or with one
// view, it is the plain 0.5 test (uVegTemporal: declared with vegDither in VEG_GLSL.F_PARS)
float vegImpThreshold( float mixK ) {
  vec2 dp = gl_FragCoord.xy + vec2( 17.0, 29.0 ) + ( uVegTemporal.x > 0.5 ? 5.588238 * mod( uVegTemporal.y, 64.0 ) : 0.0 );
  float d = fract( 52.9829189 * fract( 0.06711056 * dp.x + 0.00583715 * dp.y ) );
  return mix( 0.5, 0.06 + 0.88 * d, min( 1.0, 2.0 * mixK ) );
}
#else
varying vec2 vImpUv;
#endif
flat varying vec4 vImpA;
flat varying vec3 vImpTC;
varying float vImpVis;
`;

// per-species lighting parameters arrive as flat varyings (after F_PARS declared the same names as uniforms)
const F_IMP_DEFS = /* glsl */ `
#define uTrans vImpA.x
#define uFill vImpA.y
#define uWrap vImpA.z
#define uEnvK vImpA.w
#define uTransColor vImpTC
`;

const F_IMP_MAP = /* glsl */ `
// a small negative mip bias: the baked views are down-filtered once already (crisper tree lines, no shimmer)
#ifdef VEG_IMP_BLEND
vec3 vImpN; float vImpMix;
vec4 sampledDiffuseColor = vegImpBlend( vImpN, vImpMix, 0.785, true );
// (alphatest_fragment discards a < 0.5: shift the coverage so the test runs against the blend threshold instead)
sampledDiffuseColor.a += 0.5 - vegImpThreshold( vImpMix );
#else
vec4 sampledDiffuseColor = texture( uAlbedoArr, vec3( vImpUv, vLayer ), -0.35 );
{
  vec2 ts = vec2( textureSize( uAlbedoArr, 0 ).xy );
  vec2 dx = dFdx( vImpUv * ts ), dy = dFdy( vImpUv * ts );
  float lod = 0.5 * log2( max( max( dot( dx, dx ), dot( dy, dy ) ), 1e-8 ) );
  sampledDiffuseColor.a *= 1.0 + max( lod, 0.0 ) * 0.25;
}
#endif
diffuseColor *= sampledDiffuseColor;
// (measured: aerial green share 84 % vs the target art's 51 %, saturation .72 vs .49; harbour hills V .61 / S .66 vs
// .46 / .40): far away a quarter of the crowns go 20 % darker and the canopy loses ~15 % of its saturation — beyond the
// LOD1 → impostor switch (75–85 m), so nothing pops
// (measured: aerial canopy S .69 / hue 76° vs the target art's .48 / 83°; harbour hills at 300–600 m
// S .66 vs .40): −38 % saturation by 600 m (the canopy albedo carries the under-canopy saturation boost of F_GRADE),
// −45 % from 1.6 km, and far crowns rotate ~7° back from the under-canopy
// yellow push (F_GRADE) toward the target art's cooler aerial green
// (the saturation cut is applied to the LIT colour in F_IMP_LIGHT: the lime translucency / fill tints re-saturated a
// desaturated albedo)
diffuseColor.rgb *= mix( 1.0, vImpTone, smoothstep( 220.0, 420.0, vDist ) );
`;

// the same complementary crossfade masks as the meshes (foliage-material F_FADE): impostor and LOD1 partition the pixels
const F_IMP_FADE = /* glsl */ `
{
  float a = abs( vImpVis );
  if ( a < 1.0 ) { float d = vegDither(); if ( vImpVis < 0.0 ) d = 1.0 - d; if ( a <= d ) discard; }
}
`;

/**
 * Impostor lighting inputs (shared by every impostor): linear sun radiance and the scene IBL's diffuse response for
 * up / side / down normals, measured once from a white MeshStandardMaterial (calibrateImpostorLight) — the impostors
 * are unlit MeshBasic quads that light their baked normals by hand: no shadow-map / IBL fetches per fragment (they
 * cover much of the screen in every distant view), but the same wrap + translucency + fill terms as the meshes, and
 * atmos' cloud shadow + aerial perspective.
 */
export const IMP_LIGHT = VEG_LIGHT;
/** far canopy grade (live-tunable: __kr.veg.impGrade): x = saturation cut by 600 m, y = extra cut from 1.6 km,
 * z = hue rotation (rad, − = toward yellow) at mid distance, w = hue rotation added by the aerial distance */
export const IMP_GRADE = {
  uImpGrade: { value: new THREE.Vector4(0.62, 0.1, -0.1, 0.2) },
  /** lit / shade split of the far canopy (live-tunable: __kr.veg.impSplit) — the aerial target art,
   * measured by value tercile: shade hue 122° S .44, mid 83° / .48, sunlit crown tops 66° / .57 (ours were a flat 82°
   * with the lit tops DEsaturated to .35 — a sage / mint carpet): x = hue rotation of the shade side (rad, + toward
   * blue-green), y = of the sunlit side (− toward yellow-lime), z = shade lift (× ambient + fill), w = how much of the
   * saturation cut the sunlit side is spared (0..1) */
  uImpSplit: { value: new THREE.Vector4(0.7, -0.28, 0.45, 0.45) },
  /** the brightness band (fraction of a white card in full sun) over which a texel goes from "shade" to "sunlit" */
  uImpLit: { value: new THREE.Vector2(0.05, 0.15) },
};
{
  const q = flag("impgrade"); if (q && q.length === 4 && q.every(Number.isFinite)) IMP_GRADE.uImpGrade.value.set(q[0], q[1], q[2], q[3]);
  const k = flag("impsplit"); if (k && k.length === 4 && k.every(Number.isFinite)) IMP_GRADE.uImpSplit.value.set(k[0], k[1], k[2], k[3]);
}

/** measure the scene environment's diffuse response (white Standard material, normals up / side / down) */
export function calibrateImpostorLight(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sun?: THREE.DirectionalLight) {
  if (sun) IMP_LIGHT.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
  if (!scene.environment) return;
  const rt = new THREE.WebGLRenderTarget(3, 1, { type: THREE.FloatType, depthBuffer: false });
  const s = new THREE.Scene(); s.environment = scene.environment; s.environmentIntensity = scene.environmentIntensity;
  const cam = new THREE.OrthographicCamera(-1.5, 1.5, 0.5, -0.5, 0.1, 10); cam.position.z = 5; cam.updateMatrixWorld();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const normals = [[0, 1, 0], [0.7071, 0, 0.7071], [0, -1, 0]];
  normals.forEach((n, i) => {
    const g = new THREE.PlaneGeometry(1, 1);
    const na = g.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < na.count; k++) na.setXYZ(k, n[0], n[1], n[2]);
    const m = new THREE.Mesh(g, mat); m.position.x = i - 1; s.add(m);
  });
  const prev = renderer.getRenderTarget();
  const px = new Float32Array(12);
  try {
    renderer.setRenderTarget(rt); renderer.render(s, cam); renderer.readRenderTargetPixels(rt, 0, 0, 3, 1, px);
    const ok = px.every((v) => Number.isFinite(v)) && px[1] > 0;
    if (ok) { IMP_LIGHT.uAmbUp.value.setRGB(px[0], px[1], px[2]); IMP_LIGHT.uAmbSide.value.setRGB(px[4], px[5], px[6]); IMP_LIGHT.uAmbDown.value.setRGB(px[8], px[9], px[10]); }
  } catch (e) { console.warn("veg: impostor light calibration failed", e); }
  renderer.setRenderTarget(prev);
  rt.dispose(); mat.dispose(); s.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
}

const F_IMP_LIGHT = /* glsl */ `
vec3 outgoingLight;
{
#ifdef VEG_IMP_BLEND
  vec3 nObj = vImpN;
#else
  vec3 nObj = texture( uNormalArr, vec3( vImpUv, vLayer ) ).xyz * 2.0 - 1.0;
#endif
  vec3 N = normalize( vRotW * nObj );
  vec3 alb = diffuseColor.rgb;
  float nl = dot( N, uSunDir );
  float diff = max( ( nl + uWrap ) / ( ( 1.0 + uWrap ) * ( 1.0 + uWrap ) ), 0.0 );
  vec3 V = normalize( uCamPos - vImpWorld );
  float back = pow( clamp( dot( V, -uSunDir ), 0.0, 1.0 ), 3.0 );
  float thru = clamp( -nl, 0.0, 1.0 );
  float vis = 1.0;
  #ifdef ATMOS
    vis = atmosCloudShadow( vImpWorld );
  #endif
  vec3 direct = uSunCol * vis * ( diff * uSunTint * alb * RECIPROCAL_PI + uTransColor * alb * 2.2 * uTrans * uGrade.y * ( back * 0.9 + thru * 0.35 ) );
  vec3 amb = ( N.y > 0.0 ? mix( uAmbSide, uAmbUp, N.y ) : mix( uAmbSide, uAmbDown, -N.y ) ) * alb * vec3( 0.8, 0.96, 0.7 ) * uEnvK;
  vec3 fill = alb * mix( vec3( 1.0 ), uTransColor, 0.3 ) * uShadeTint * uFill * uGrade.x * ( 0.72 + 0.28 * N.y );
  float mid = smoothstep( 150.0, 600.0, vDist );
  // (how sunlit this texel is — the target art's far canopy splits into yellow-lime sunlit tops and blue-green shade)
  outgoingLight = direct + ( amb + fill ) * ( 1.0 + uImpSplit.z * mid );
  // (by the texel's final brightness against a white card in full sun — the target art's split is by VALUE: bright
  // crown tops and palm stars lime-yellow, the darker masses and gaps blue-green; n·l alone misses the leaf-lit palms)
  float lit = smoothstep( uImpLit.x, uImpLit.y, dot( outgoingLight, vec3( 0.299, 0.587, 0.114 ) ) / max( dot( uSunCol, vec3( 0.299, 0.587, 0.114 ) ) * RECIPROCAL_PI, 1e-4 ) );
  {
    float vfar = smoothstep( 800.0, 1600.0, vDist );
    float l = dot( outgoingLight, vec3( 0.299, 0.587, 0.114 ) );
    outgoingLight = mix( vec3( l ), outgoingLight, 1.0 - ( uImpGrade.x * mid + uImpGrade.y * vfar ) * ( 1.0 - uImpSplit.w * lit ) );
    // (the sky haze atmos adds on top is blue: a desaturated canopy turned cyan (hue 98° vs the target art's 79°) —
    // lean the mid-distance canopy a little yellow; the aerial (> 1.6 km) ends greener than the under-canopy push)
    float th = uImpGrade.z * mid + uImpGrade.w * vfar + mix( uImpSplit.x, uImpSplit.y, lit ) * mid;
    vec3 k = vec3( 0.57735 );
    outgoingLight = max( outgoingLight * cos( th ) + cross( k, outgoingLight ) * sin( th ) + k * dot( k, outgoingLight ) * ( 1.0 - cos( th ) ), 0.0 );
  }
}
`;

const BLEND_DEFS = IMP_BLEND ? `#define VEG_IMP_BLEND\n#define VEG_IMP_BAND ${IMP_BAND.toFixed(3)}\n` : "";

export interface ImpostorMaterials { mat: THREE.MeshBasicMaterial; depth: THREE.MeshDepthMaterial }

/**
 * Every impostor species of one atlas size in ONE draw: the baked atlases are copied into two texture arrays (albedo,
 * normal — one layer per species), per-species framing / fade / lighting parameters and per-frame rects live in two
 * float textures indexed by the per-instance `aSpecies` attribute (one draw per species would be 21 draws + 36 empty
 * shadow draws every frame).
 */
export class ImpostorBank {
  readonly albedo: THREE.WebGLArrayRenderTarget;
  readonly normal: THREE.WebGLArrayRenderTarget;
  readonly params: THREE.DataTexture;
  readonly rects: THREE.DataTexture;
  readonly mats: ImpostorMaterials;
  /** uImpFar: (start, end) of the bank's far shrink-out (0 = none) — the understory bank at ground level (lod.ts cull) */
  readonly uniforms: { uNoFade: { value: number }; uImpFar: { value: THREE.Vector2 } };
  layers = 0;
  private copyScene = new THREE.Scene();
  private copyCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private copyMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: null as THREE.Texture | null } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
    fragmentShader: "uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D( map, vUv ); }",
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });

  constructor(readonly size: number, readonly maxLayers: number, readonly frames = 8, readonly nsize = size) {
    const mk = (size: number) => {
      const rt = new THREE.WebGLArrayRenderTarget(size, size, maxLayers, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, colorSpace: THREE.NoColorSpace });
      rt.texture.anisotropy = 4;
      return rt;
    };
    this.albedo = mk(size); this.normal = mk(nsize);
    this.params = new THREE.DataTexture(new Float32Array(5 * maxLayers * 4), 5, maxLayers, THREE.RGBAFormat, THREE.FloatType);
    this.rects = new THREE.DataTexture(new Float32Array(frames * frames * maxLayers * 4), frames * frames, maxLayers, THREE.RGBAFormat, THREE.FloatType);
    for (const t of [this.params, this.rects]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; }
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMat); q.frustumCulled = false;
    this.copyScene.add(q);
    this.uniforms = { uNoFade: { value: 0 }, uImpFar: { value: new THREE.Vector2(0, 0) } };
    this.mats = this.makeMaterials();
  }

  /** bake a species (LOD0 of every part) into the next layer; returns its layer index (the `aSpecies` value) */
  add(renderer: THREE.WebGLRenderer, sp: Species): number {
    if (this.layers >= this.maxLayers) throw new Error("veg: impostor bank full");
    const layer = this.layers++;
    let atlas!: ImpostorAtlas;
    bake(() => {
      atlas = bakeImpostor(renderer, sp, this.frames, this.size, this.nsize);
      // copy the 2D atlases into this layer of the arrays (raw texel copy: no tone mapping / colour conversion)
      const prevRT = renderer.getRenderTarget(), prevTone = renderer.toneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      for (const [src, dst] of [[atlas.albedo, this.albedo], [atlas.normal, this.normal]] as const) {
        this.copyMat.uniforms.map.value = src;
        renderer.setRenderTarget(dst, layer);
        renderer.render(this.copyScene, this.copyCam);
      }
      renderer.setRenderTarget(prevRT); renderer.toneMapping = prevTone;
      for (const t of atlas.targets) t.dispose();
      atlas.rects.dispose();
    });
    // per-species parameters (leafiest part's lighting)
    let leafPart = sp.parts[0];
    for (const p of sp.parts) if (vegUniforms(p.mats).uTrans.value > vegUniforms(leafPart.mats).uTrans.value) leafPart = p;
    const leaf = vegUniforms(leafPart.mats);
    const P = this.params.image.data as Float32Array, o = layer * 20;
    // (texel 4: the crown footprint the road clearance shrinks — shared veg-scatter crownFootprint, else the plant's radius)
    const cf = crownFootprint(sp.kind, sp.variant) ?? { x: 0, z: 0, r: sp.radius };
    P.set([atlas.center.x, atlas.center.y, atlas.center.z, atlas.radius, 0, 0, leaf.uTrans.value * 0.8, leaf.uFill.value,
      leaf.uTransColor.value.r, leaf.uTransColor.value.g, leaf.uTransColor.value.b, leaf.uWrap.value, leafPart.mats.mat.envMapIntensity, sp.kind === "palm" || sp.kind === "palm-leaning" ? 1.35 : 1.06, 0, 0,
      cf.x, cf.z, sp.height, cf.r], o);
    this.params.needsUpdate = true;
    const R = this.rects.image.data as Float32Array, rs = atlas.rects.image.data as Float32Array;
    R.set(rs, layer * this.frames * this.frames * 4);
    this.rects.needsUpdate = true;
    return layer;
  }

  private makeMaterials(): ImpostorMaterials {
    const own = {
      uAlbedoArr: { value: this.albedo.texture }, uNormalArr: { value: this.normal.texture },
      uSpParams: { value: this.params }, uRects: { value: this.rects }, uFrames: { value: this.frames },
      uAlphaMip: { value: 0.25 }, uFade: { value: new THREE.Vector4() },
      uTrans: { value: 0 }, uFill: { value: 0 }, uWrap: { value: 0 }, uTransColor: { value: new THREE.Color() }, uEnvK: { value: 1 },
    };
    const shared = { uCamPos: VEG_UNIFORMS.uCamPos, uSunDir: VEG_UNIFORMS.uSunDir, uGrade: VEG_UNIFORMS.uGrade, uSunTint: VEG_UNIFORMS.uSunTint, uShadeTint: VEG_UNIFORMS.uShadeTint, uFadeNow: VEG_UNIFORMS.uFadeNow, uVegTemporal: VEG_UNIFORMS.uVegTemporal, ...IMP_LIGHT, ...IMP_GRADE, ...this.uniforms };
    const mat = new THREE.MeshBasicMaterial({ alphaTest: 0.5, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, own, shared);
      sh.vertexShader = `#define VEG_FADE_T ${VEG_FADE_T.toFixed(3)}\n${BLEND_DEFS}` + sh.vertexShader
        .replace("#include <common>", "#include <common>\n" + V_IMP)
        .replace("#include <begin_vertex>", V_IMP_BODY)
        .replace("#include <project_vertex>", "#include <project_vertex>\n" + V_IMP_WET);
      sh.fragmentShader = BLEND_DEFS + sh.fragmentShader
        .replace("#include <common>", "#include <common>\n" + VEG_GLSL.F_PARS + F_IMP + "varying vec3 vImpWorld;\nvarying mat3 vRotW;\nuniform vec3 uSunCol;\nuniform float uEnvK;\nuniform vec3 uCamPos;\nuniform vec4 uImpGrade;\nuniform vec4 uImpSplit;\nuniform vec2 uImpLit;\n" + F_IMP_DEFS)
        .replace("#include <map_fragment>", F_IMP_MAP)
        .replace("#include <alphatest_fragment>", "#include <alphatest_fragment>\n" + F_IMP_FADE)
        .replace("vec3 outgoingLight = reflectedLight.indirectDiffuse;", F_IMP_LIGHT);
    };
    mat.customProgramCacheKey = () => "veg-impostor-bank3" + (IMP_BLEND ? "b" : "");
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: 0.5, side: THREE.DoubleSide });
    depth.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, own, shared);
      sh.vertexShader = `#define VEG_FADE_T ${VEG_FADE_T.toFixed(3)}\n#define VEG_IMP_DEPTH\n${BLEND_DEFS}` + sh.vertexShader
        .replace("#include <common>", "#include <common>\n" + V_IMP)
        .replace("#include <begin_vertex>", V_IMP_BODY);
      sh.fragmentShader = BLEND_DEFS + sh.fragmentShader
        .replace("#include <common>", "#include <common>\n" + VEG_GLSL.F_PARS + F_IMP)
        .replace("#include <map_fragment>", IMP_BLEND
          ? "vec3 vImpN; float vImpMix;\n vec4 sampledDiffuseColor = vegImpBlend( vImpN, vImpMix, 1.0, false );\n sampledDiffuseColor.a += 0.5 - vegImpThreshold( vImpMix );\n diffuseColor *= sampledDiffuseColor;"
          : "vec4 sampledDiffuseColor = texture( uAlbedoArr, vec3( vImpUv, vLayer ) );\n diffuseColor *= sampledDiffuseColor;")
        .replace("#include <alphatest_fragment>", "#include <alphatest_fragment>\n" + F_IMP_FADE);
    };
    depth.customProgramCacheKey = () => "veg-impostor-bank3-depth" + (IMP_BLEND ? "b" : "");
    return { mat, depth };
  }
}

/** unit quad for impostors (centre pivot, uv 0..1) */
export function impostorQuad(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(1, 1, 1, 1);
}
