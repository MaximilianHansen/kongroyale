// DEV VIEW: walk or fly around, click on anything in the world and leave a note on it. Loaded ONLY with ?dev=annotate
// (or ?dev + F8) — main.ts dynamic-imports this file; without the flag none of it is fetched, built or run.
//
//   F8   panel on / off            F10  fly camera on / off (free cursor: right-drag look, WASD, Space/E up, C/Q down,
//   F9   pick what the crosshair         Shift fast, wheel = speed; left click picks what is under the cursor)
//        (walk mode) is on
//   panel: WIREFRAME · OVERLAPS (z-fight finder) · NOTES list (go to / resolve) · the note box for the current pick
//
// A pick reports the mesh (name + parent chain), the world module that built it (main.ts rootsOf → __kr.moduleRoots),
// the POI, the world point, the material, the geometry, and the collider box the sim hits on that ray (StaticWorld) —
// both outlined in the world. SAVE posts the note to the game server (/api/annotations → .kongbot/annotations JSONL,
// + Mongo kongbot_annotations when up) and drops a pin in the world; pins + the list load from the server.
import * as THREE from "three";
import type { Engine } from "../engine/engine";
import type { StaticWorld } from "../../../shared/sim/world";
import { makeHit, surfaceById } from "../../../shared/sim/world";
import { POIS } from "../../../shared/world/map";

interface Note {
  id: string; at: string; author: string; text: string; status: "open" | "resolved";
  pos: [number, number, number]; cam: { x: number; y: number; z: number; yaw: number; pitch: number } | null;
  target: Record<string, unknown> | null;
}
interface Kr { engine: Engine; game?: { input?: GameInputLike; world?: StaticWorld; render?: { kits?: { viewModel?: { object: THREE.Object3D } } } | null; inMatch?: boolean }; moduleIds?: () => string[]; moduleRoots?: (id: string) => THREE.Object3D[]; devView?: unknown }
interface GameInputLike { gameplayAllowed: () => boolean; onLockChange: (l: boolean) => void; locked: boolean; yaw: number; pitch: number }

const API = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}api/annotations`;
const C = { ui: "#ffd400", pick: "#ff3df2", col: "#35e0ff", pin: "#ffd400", done: "#7d8a93" };

export function startDevView(kr: Kr) {
  if (kr.devView) return kr.devView;
  const engine = kr.engine, scene = engine.scene, cam = engine.camera as THREE.PerspectiveCamera, renderer = engine.renderer;
  const world = kr.game?.world ?? null;
  const input = kr.game?.input ?? null;
  // ---- state
  let panelOn = true, fly = false, wire = false, overlap = false;
  const flyPos = new THREE.Vector3(), flyRot = { yaw: 0, pitch: 0 };
  let speed = 18, rmb = false, lastX = 0, lastY = 0;
  const keys = new Set<string>();
  let pick: Pick | null = null;
  let notes: Note[] = [];
  const author = (() => { try { return localStorage.getItem("kr-dev-author") || "dev"; } catch { return "dev"; } })();

  // the game: no gameplay while flying (the kong stands still, the game ignores keys / mouse), no pause menu when the
  // dev view frees the cursor
  if (input) {
    const allowed = input.gameplayAllowed.bind(input), onLock = input.onLockChange.bind(input);
    input.gameplayAllowed = () => !fly && !typing() && allowed();
    input.onLockChange = (l) => { if (!fly && !typing()) onLock(l); };
  }
  const typing = () => document.activeElement === noteBox || document.activeElement === authorBox;

  // ---- world helpers: picked mesh box, collider box, note pins
  const helpers = new THREE.Group(); helpers.name = "dev-view"; helpers.renderOrder = 20; scene.add(helpers);
  const pickBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(C.pick)); pickBox.visible = false; (pickBox.material as THREE.LineBasicMaterial).depthTest = false; pickBox.renderOrder = 21;
  const colBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: C.col, depthTest: false, transparent: true, opacity: 0.95 }));
  colBox.visible = false; colBox.renderOrder = 22;
  const hitDot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: C.pick, depthTest: false })); hitDot.visible = false; hitDot.renderOrder = 23;
  const hitRing = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 32), new THREE.MeshBasicMaterial({ color: C.pick, depthTest: false, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
  hitRing.visible = false; hitRing.renderOrder = 23;
  helpers.add(pickBox, colBox, hitDot, hitRing);
  const pins = new THREE.Group(); pins.name = "dev-pins"; helpers.add(pins);

  // ---- UI
  const css = document.createElement("style");
  css.textContent = `
  .kr-dev { position: fixed; z-index: 60; font: 600 13px/1.35 Roboto, system-ui, sans-serif; color: #f4f1e4; }
  .kr-dev * { box-sizing: border-box; }
  .kr-dev-panel { right: 14px; top: 14px; width: 400px; max-height: calc(100vh - 28px); overflow: auto; background: rgba(8,14,22,.9); border: 2px solid ${C.ui}; border-radius: 10px; padding: 12px 14px; pointer-events: auto; }
  .kr-dev-panel h3 { margin: 0 0 8px; font: 800 18px 'Barlow Condensed', sans-serif; letter-spacing: 2px; color: ${C.ui}; }
  .kr-dev-panel h4 { margin: 12px 0 6px; font: 800 14px 'Barlow Condensed', sans-serif; letter-spacing: 1.5px; color: ${C.ui}; }
  .kr-dev-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .kr-dev button { font: 700 12px Roboto, sans-serif; letter-spacing: .5px; padding: 5px 9px; border-radius: 6px; border: 1px solid #5d6b75; background: #17232e; color: #f4f1e4; cursor: pointer; }
  .kr-dev button.on { background: ${C.ui}; color: #111; border-color: ${C.ui}; }
  .kr-dev .kv { display: grid; grid-template-columns: 92px 1fr; gap: 2px 8px; font: 500 12px ui-monospace, Menlo, monospace; word-break: break-all; }
  .kr-dev .kv b { color: #9fb2bf; font-weight: 600; }
  .kr-dev textarea, .kr-dev input { width: 100%; background: #0d151d; color: #fff; border: 1px solid #5d6b75; border-radius: 6px; padding: 6px; font: 500 13px Roboto, sans-serif; }
  .kr-dev textarea { height: 64px; resize: vertical; }
  .kr-dev .note { border-top: 1px solid #2b3a45; padding: 6px 0; display: grid; grid-template-columns: 1fr auto; gap: 4px; }
  .kr-dev .note.resolved { opacity: .5; }
  .kr-dev .note small { color: #9fb2bf; font-weight: 500; }
  .kr-dev .hint { color: #9fb2bf; font-weight: 500; font-size: 12px; }
  .kr-dev-ret { left: 50%; top: 50%; width: 26px; height: 26px; margin: -13px 0 0 -13px; border: 2px solid ${C.pick}; border-radius: 50%; pointer-events: none; box-shadow: 0 0 0 1px rgba(0,0,0,.5); }
  .kr-dev-ret::after { content: ""; position: absolute; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px; background: ${C.pick}; border-radius: 50%; }
  body.kr-dev-fly .kr-lobby { display: none !important; }
  .kr-dev-tag { left: 14px; bottom: 14px; padding: 6px 10px; background: rgba(8,14,22,.85); border: 1px solid ${C.ui}; border-radius: 6px; font: 800 13px 'Barlow Condensed', sans-serif; letter-spacing: 1.5px; color: ${C.ui}; pointer-events: none; }`;
  document.head.appendChild(css);
  const panel = div("kr-dev kr-dev-panel");
  const ret = div("kr-dev kr-dev-ret");
  const tag = div("kr-dev kr-dev-tag");
  panel.innerHTML = `
    <h3>DEV VIEW · ANNOTATE</h3>
    <div class="kr-dev-row"><button data-a="fly">FLY (F10)</button><button data-a="wire">WIREFRAME</button><button data-a="overlap">OVERLAPS</button><button data-a="hide">HIDE (F8)</button></div>
    <div class="hint" style="margin-top:6px">Walk: play as usual, <b>F9</b> picks what the crosshair is on. Fly: right-drag to look, WASD · Space/E up · C/Q down · Shift fast · wheel speed, <b>click</b> picks.</div>
    <h4>PICK</h4><div data-r="pick" class="hint">nothing picked yet</div>
    <h4>NOTE</h4>
    <textarea data-r="note" placeholder="what needs to change here…"></textarea>
    <div class="kr-dev-row" style="margin-top:6px; align-items:center"><input data-r="author" style="width:120px" placeholder="your name"><button data-a="save">SAVE NOTE</button><span data-r="status" class="hint"></span></div>
    <h4>NOTES <span data-r="count" class="hint"></span></h4><div class="kr-dev-row" style="margin-bottom:4px"><button data-a="reload">RELOAD</button><button data-a="showdone">SHOW RESOLVED</button></div>
    <div data-r="list"></div>`;
  const $ = (r: string) => panel.querySelector(`[data-r="${r}"]`) as HTMLElement;
  const noteBox = $("note") as HTMLTextAreaElement, authorBox = $("author") as HTMLInputElement;
  authorBox.value = author;
  let showDone = false;
  const btn = (a: string) => panel.querySelector(`[data-a="${a}"]`) as HTMLButtonElement;
  panel.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("[data-a]")?.getAttribute("data-a"); if (!a) return;
    if (a === "fly") setFly(!fly);
    else if (a === "wire") setWire(!wire);
    else if (a === "overlap") setOverlap(!overlap);
    else if (a === "hide") setPanel(false);
    else if (a === "save") void save();
    else if (a === "reload") void load();
    else if (a === "showdone") { showDone = !showDone; btn("showdone").classList.toggle("on", showDone); renderList(); }
    else if (a.startsWith("go:")) goTo(a.slice(3));
    else if (a.startsWith("res:")) void op(a.slice(4), "resolve");
    else if (a.startsWith("open:")) void op(a.slice(5), "reopen");
  });
  // the panel never feeds the game (clicks, wheel, keys inside it stay in it)
  for (const ev of ["mousedown", "wheel", "keydown", "keyup"] as const) panel.addEventListener(ev, (e) => e.stopPropagation());
  authorBox.addEventListener("change", () => { try { localStorage.setItem("kr-dev-author", authorBox.value.trim()); } catch { /* private */ } });

  function setPanel(on: boolean) { panelOn = on; panel.style.display = on ? "" : "none"; tag.textContent = on ? "" : "DEV VIEW · F8"; tag.style.display = on ? "none" : ""; }
  function setFly(on: boolean) {
    if (on === fly) return;
    fly = on; btn("fly").classList.toggle("on", fly); document.body.classList.toggle("kr-dev-fly", fly);
    if (fly) {
      flyPos.copy(cam.position); const e = new THREE.Euler().setFromQuaternion(cam.quaternion, "YXZ"); flyRot.yaw = e.y; flyRot.pitch = e.x;
      if (document.pointerLockElement) document.exitPointerLock();
    } else keys.clear();
    const vm = kr.game?.render?.kits?.viewModel?.object; if (vm) vm.visible = !fly;
    ret.style.display = fly ? "none" : "";
    tag.textContent = fly ? "FLY" : "";
  }

  // ---- fly camera (runs after the game's own camera each frame: registered later)
  engine.onUpdate((dt) => {
    if (fly) {
      const f = new THREE.Vector3(-Math.sin(flyRot.yaw) * Math.cos(flyRot.pitch), Math.sin(flyRot.pitch), -Math.cos(flyRot.yaw) * Math.cos(flyRot.pitch));
      const r = new THREE.Vector3(Math.cos(flyRot.yaw), 0, -Math.sin(flyRot.yaw));
      const v = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 4 : 1) * speed * dt;
      if (keys.has("KeyW") || keys.has("ArrowUp")) flyPos.addScaledVector(f, v);
      if (keys.has("KeyS") || keys.has("ArrowDown")) flyPos.addScaledVector(f, -v);
      if (keys.has("KeyD") || keys.has("ArrowRight")) flyPos.addScaledVector(r, v);
      if (keys.has("KeyA") || keys.has("ArrowLeft")) flyPos.addScaledVector(r, -v);
      if (keys.has("Space") || keys.has("KeyE")) flyPos.y += v;
      if (keys.has("KeyC") || keys.has("KeyQ")) flyPos.y -= v;
      cam.position.copy(flyPos); cam.quaternion.setFromEuler(new THREE.Euler(flyRot.pitch, flyRot.yaw, 0, "YXZ")); cam.updateMatrixWorld();
    }
    if (wire && (wireT += dt) > 1) { wireT = 0; applyWire(true); }
  });
  let wireT = 0;
  addEventListener("keydown", (e) => {
    if (typing()) { if (e.code === "Escape") (document.activeElement as HTMLElement).blur(); return; }
    if (e.code === "F8") { setPanel(!panelOn); e.preventDefault(); return; }
    if (e.code === "F10") { setFly(!fly); e.preventDefault(); return; }
    if (e.code === "F9") { pickAt(0, 0); e.preventDefault(); return; }
    if (fly) { keys.add(e.code); if (e.code === "Space" || e.code === "Tab") e.preventDefault(); }
  }, true);
  addEventListener("keyup", (e) => keys.delete(e.code), true);
  const canvas = renderer.domElement;
  canvas.addEventListener("mousedown", (e) => {
    if (!fly) return;
    if (e.button === 2) { rmb = true; lastX = e.clientX; lastY = e.clientY; }
    else if (e.button === 0) { const r = canvas.getBoundingClientRect(); pickAt(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)); }
  });
  addEventListener("mouseup", (e) => { if (e.button === 2) rmb = false; });
  addEventListener("mousemove", (e) => {
    if (!fly || !rmb) return;
    flyRot.yaw -= (e.clientX - lastX) * 0.004; flyRot.pitch = Math.max(-1.55, Math.min(1.55, flyRot.pitch - (e.clientY - lastY) * 0.004));
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener("wheel", (e) => { if (!fly) return; speed = Math.max(2, Math.min(400, speed * (e.deltaY > 0 ? 0.8 : 1.25))); tag.textContent = `FLY · ${Math.round(speed)} m/s`; e.preventDefault(); }, { passive: false });

  // ---- picking
  interface Pick { point: THREE.Vector3; normal: THREE.Vector3 | null; mesh: THREE.Object3D | null; instance: number | undefined; info: Record<string, unknown>; collider: number }
  const rc = new THREE.Raycaster(), HIT = makeHit(), sphere = new THREE.Sphere(), M4 = new THREE.Matrix4();
  let moduleOf: Map<THREE.Object3D, string> | null = null;
  function moduleFor(o: THREE.Object3D): string {
    if (!moduleOf) { moduleOf = new Map(); for (const id of kr.moduleIds?.() ?? []) for (const r of kr.moduleRoots?.(id) ?? []) moduleOf.set(r, id); }
    for (let q: THREE.Object3D | null = o; q; q = q.parent) { const m = moduleOf.get(q); if (m) return m; }
    return "(gameplay / engine)";
  }
  function pickAt(nx: number, ny: number) {
    const t0 = performance.now();
    rc.setFromCamera(new THREE.Vector2(nx, ny), cam);
    const o = rc.ray.origin, d = rc.ray.direction;
    // the sim's view of this ray: the collider box (or terrain) it stops on
    let simT = 3000, collider = -1;
    if (world) { world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 3000, HIT, false); if (HIT.hit) { simT = HIT.t; collider = HIT.box; } }
    // meshes: only those whose bounds the ray passes (foliage / glow cards / the dev helpers skipped)
    rc.far = Math.min(3000, simT + 6);
    const cands: THREE.Object3D[] = [];
    scene.traverseVisible((ob) => {
      const m = ob as THREE.Mesh;
      if (!m.isMesh || ob === helpers || isDev(ob)) return;
      // ?geofree=1 drops the CPU arrays of uploaded meshes; with no vertices left there is nothing to pick on them
      if (!m.geometry.attributes.position?.array) return;
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material | undefined;
      if (!mat || (mat.transparent && mat.blending === THREE.AdditiveBlending) || !mat.visible) return;
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      if ((m as THREE.InstancedMesh).isInstancedMesh) { const im = m as THREE.InstancedMesh; if (!im.boundingSphere) im.computeBoundingSphere(); sphere.copy(im.boundingSphere!).applyMatrix4(im.matrixWorld); }
      else sphere.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
      if (rc.ray.intersectsSphere(sphere) && rc.ray.distanceToPoint(sphere.center) < sphere.radius + 0.01) cands.push(ob);
    });
    let best: THREE.Intersection | null = null;
    const slow: Array<[string, number]> = [];
    for (const c of cands) { const c0 = performance.now(); const hits = rc.intersectObject(c, false); const dc = performance.now() - c0; if (dc > 15) slow.push([c.name || c.type, +dc.toFixed(0)]); if (hits.length && (!best || hits[0].distance < best.distance)) best = hits[0]; }
    (kr as unknown as { devSlow?: unknown }).devSlow = { n: cands.length, slow };
    const point = best ? best.point.clone() : new THREE.Vector3().copy(o).addScaledVector(d, simT);
    const info: Record<string, unknown> = {};
    if (best) {
      const m = best.object as THREE.Mesh, mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
      const chain: string[] = []; for (let q: THREE.Object3D | null = m; q && q !== scene; q = q.parent) chain.push(q.name || q.type);
      info.mesh = m.name || m.type; info.path = chain.reverse().join(" › "); info.module = moduleFor(m);
      info.material = `${mat?.name || "(unnamed)"} · ${mat?.type}${mat && "color" in mat && mat.color ? " · #" + mat.color.getHexString() : ""}${mat?.map ? " · map" : ""}${mat?.wireframe ? "" : ""}`;
      const g = m.geometry; info.geometry = `${g.index ? g.index.count / 3 : (g.getAttribute("position")?.count ?? 0) / 3} tris${(m as THREE.InstancedMesh).isInstancedMesh ? ` · instance ${best.instanceId} of ${(m as THREE.InstancedMesh).count}` : ""}`;
    } else { info.mesh = simT < 3000 ? "(terrain — no mesh hit)" : "(sky)"; info.module = simT < 3000 ? "terrain" : "-"; }
    info.poi = poiAt(point.x, point.z);
    info.position = `${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}`;
    info.distance = `${point.distanceTo(o).toFixed(1)} m`;
    if (collider >= 0 && world) {
      const W = world as unknown as { cx: Float32Array; cy: Float32Array; cz: Float32Array; hx: Float32Array; hy: Float32Array; hz: Float32Array; cos: Float32Array; sin: Float32Array; surf: Uint8Array; noWalk: Uint8Array };
      const k = collider;
      info.collider = `box #${k} · centre ${W.cx[k].toFixed(2)}, ${W.cy[k].toFixed(2)}, ${W.cz[k].toFixed(2)} · half ${W.hx[k].toFixed(2)} × ${W.hy[k].toFixed(2)} × ${W.hz[k].toFixed(2)} · yaw ${(Math.atan2(W.sin[k], W.cos[k]) * 180 / Math.PI).toFixed(0)}° · ${surfaceById(W.surf[k])}${W.noWalk[k] ? " · no-walk" : ""}`;
      colBox.position.set(W.cx[k], W.cy[k], W.cz[k]); colBox.rotation.set(0, Math.atan2(W.sin[k], W.cos[k]), 0); colBox.scale.set(W.hx[k] * 2, W.hy[k] * 2, W.hz[k] * 2); colBox.visible = true;
    } else { info.collider = simT < 3000 ? "terrain" : "none"; colBox.visible = false; }
    info.pickMs = +(performance.now() - t0).toFixed(1);
    // outline the picked mesh (or its instance)
    if (best) {
      const m = best.object as THREE.Mesh, bb = pickBox.box;
      if ((m as THREE.InstancedMesh).isInstancedMesh && best.instanceId !== undefined) { (m as THREE.InstancedMesh).getMatrixAt(best.instanceId, M4); M4.premultiply(m.matrixWorld); if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); bb.copy(m.geometry.boundingBox!).applyMatrix4(M4); }
      else bb.setFromObject(m, true);
      pickBox.visible = true;
    } else pickBox.visible = false;
    const dist = point.distanceTo(o), rs = Math.max(0.15, dist * 0.012);
    hitDot.position.copy(point); hitDot.scale.setScalar(rs / 0.15); hitDot.visible = true;
    hitRing.position.copy(point); hitRing.scale.setScalar(rs * 2.2); hitRing.visible = true;
    const nrm = best?.face ? best.face.normal.clone().transformDirection(best.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    hitRing.lookAt(point.clone().add(nrm));
    pick = { point, normal: best?.face?.normal ?? null, mesh: best?.object ?? null, instance: best?.instanceId, info, collider };
    $("pick").innerHTML = `<div class="kv">${Object.entries(info).map(([k, v]) => `<b>${k}</b><span>${esc(String(v))}</span>`).join("")}</div>`;
    $("status").textContent = "";
    return pick;
  }
  const isDev = (o: THREE.Object3D) => { for (let q: THREE.Object3D | null = o; q; q = q.parent) if (q === helpers) return true; return false; };

  // ---- notes: server I/O, pins, list
  async function load() {
    try { const r = await fetch(API); const j = await r.json(); if (j.ok) { notes = j.notes; renderList(); renderPins(); $("status").textContent = ""; } else $("status").textContent = j.error ?? "server said no"; }
    catch { $("status").textContent = "no game server (/api/annotations)"; }
  }
  async function save() {
    const text = noteBox.value.trim();
    if (!pick) { $("status").textContent = "pick something first (F9 / click)"; return; }
    if (text.length < 2) { $("status").textContent = "type a note"; return; }
    const e = new THREE.Euler().setFromQuaternion(cam.quaternion, "YXZ");
    const body = { text, author: authorBox.value.trim() || "dev", pos: [pick.point.x, pick.point.y, pick.point.z], cam: { x: cam.position.x, y: cam.position.y, z: cam.position.z, yaw: e.y, pitch: e.x }, target: pick.info };
    $("status").textContent = "saving…";
    try {
      const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json();
      if (!j.ok) { $("status").textContent = j.error ?? "not saved"; return; }
      notes.push(j.note); noteBox.value = ""; $("status").textContent = `saved ${j.note.id}`; renderList(); renderPins();
    } catch { $("status").textContent = "no game server — not saved"; }
  }
  async function op(id: string, o: "resolve" | "reopen") {
    try { const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: o, id }) }); if ((await r.json()).ok) { const n = notes.find((q) => q.id === id); if (n) n.status = o === "resolve" ? "resolved" : "open"; renderList(); renderPins(); } } catch { /* offline */ }
  }
  function goTo(id: string) {
    const n = notes.find((q) => q.id === id); if (!n) return;
    setFly(true);
    if (n.cam) { flyPos.set(n.cam.x, n.cam.y, n.cam.z); flyRot.yaw = n.cam.yaw; flyRot.pitch = n.cam.pitch; }
    else { flyPos.set(n.pos[0] + 4, n.pos[1] + 3, n.pos[2] + 4); flyRot.yaw = Math.atan2(4, 4); flyRot.pitch = -0.5; }
  }
  function renderList() {
    const list = notes.filter((n) => showDone || n.status === "open").slice().reverse();
    $("count").textContent = `${notes.filter((n) => n.status === "open").length} open · ${notes.length} total`;
    $("list").innerHTML = list.map((n) => {
      const t = (n.target ?? {}) as Record<string, unknown>;
      return `<div class="note ${n.status}"><div>${esc(n.text)}<br><small>${esc(n.id)} · ${esc(n.author)} · ${esc(String(t.poi ?? ""))} · ${esc(String(t.module ?? ""))} · ${new Date(n.at).toLocaleString()}</small></div>
        <div class="kr-dev-row" style="flex-direction:column"><button data-a="go:${n.id}">GO TO</button>${n.status === "open" ? `<button data-a="res:${n.id}">RESOLVE</button>` : `<button data-a="open:${n.id}">REOPEN</button>`}</div></div>`;
    }).join("") || `<div class="hint">no notes yet</div>`;
  }
  function renderPins() {
    for (const c of [...pins.children]) { pins.remove(c); c.traverse((x) => { const m = x as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.SpriteMaterial | undefined; mat?.map?.dispose(); mat?.dispose(); }); }
    notes.filter((n) => n.status === "open").forEach((n, i) => pins.add(makePin(n, i + 1)));
  }
  function makePin(n: Note, k: number) {
    const g = new THREE.Group(); g.position.set(n.pos[0], n.pos[1], n.pos[2]);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.2, 6).translate(0, 1.1, 0), new THREE.MeshBasicMaterial({ color: C.pin, depthTest: false, transparent: true, opacity: 0.9 }));
    stem.renderOrder = 24;
    const cv = document.createElement("canvas"); cv.width = 512; cv.height = 96; const x = cv.getContext("2d")!;
    x.fillStyle = "rgba(8,14,22,.92)"; x.strokeStyle = C.pin; x.lineWidth = 5; x.beginPath(); x.roundRect(4, 4, 504, 88, 16); x.fill(); x.stroke();
    x.fillStyle = C.pin; x.beginPath(); x.arc(52, 48, 30, 0, 7); x.fill(); x.fillStyle = "#111"; x.font = "900 34px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(String(k), 52, 50);
    x.fillStyle = "#fff"; x.textAlign = "left"; x.font = "700 30px sans-serif"; const t = n.text.length > 26 ? n.text.slice(0, 25) + "…" : n.text; x.fillText(t, 96, 50);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, toneMapped: false }));
    sp.scale.set(0.2, 0.0375, 1); sp.center.set(0.1, 0); sp.position.y = 2.25; sp.renderOrder = 25;
    g.add(stem, sp); g.userData.sprite = sp; g.userData.note = n.id;
    return g;
  }

  // ---- wireframe: every material in the scene (re-applied each second while on — streamed modules arrive later)
  const wired = new Set<THREE.Material>();
  function applyWire(on: boolean) {
    if (!on) { for (const m of wired) (m as THREE.MeshBasicMaterial).wireframe = false; wired.clear(); return; }
    scene.traverse((o) => {
      if (isDev(o)) return;
      const mm = (o as THREE.Mesh).material; if (!mm) return;
      for (const m of Array.isArray(mm) ? mm : [mm]) if ("wireframe" in m && !(m as THREE.MeshBasicMaterial).wireframe) { (m as THREE.MeshBasicMaterial).wireframe = true; wired.add(m); }
    });
  }
  function setWire(on: boolean) { wire = on; btn("wire").classList.toggle("on", on); applyWire(on); }

  // ---- overlaps (z-fighting finder): after the frame, (1) the scene's linear depth into a float target, (2) every
  // surface again, additively counted where it lies within a hair of that depth (no depth test), (3) a red overlay
  // wherever 2+ surfaces share the visible depth — coincident / coplanar geometry. Only while the toggle is on.
  let ovl: { depthRT: THREE.WebGLRenderTarget; countRT: THREE.WebGLRenderTarget; depthMat: THREE.ShaderMaterial; countMat: THREE.ShaderMaterial; quad: THREE.Mesh; qs: THREE.Scene; qc: THREE.OrthographicCamera } | null = null;
  const VZ = `#include <common>
    #include <batching_pars_vertex>
    #include <morphtarget_pars_vertex>
    #include <skinning_pars_vertex>
    varying float vZ;
    void main() {
      #include <batching_vertex>
      #include <skinbase_vertex>
      #include <morphinstance_vertex>
      #include <begin_vertex>
      #include <morphtarget_vertex>
      #include <skinning_vertex>
      #include <project_vertex>
      vZ = -mvPosition.z;
    }`;
  function overlapPass() {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!ovl) {
      const depthRT = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
      const countRT = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.UnsignedByteType, depthBuffer: false });
      const depthMat = new THREE.ShaderMaterial({ vertexShader: VZ, fragmentShader: `varying float vZ; void main() { gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }`, side: THREE.DoubleSide });
      const countMat = new THREE.ShaderMaterial({
        vertexShader: VZ, uniforms: { tD: { value: depthRT.texture }, uRes: { value: new THREE.Vector2() } },
        fragmentShader: `uniform sampler2D tD; uniform vec2 uRes; varying float vZ;
          void main() { float ref = texture2D(tD, gl_FragCoord.xy / uRes).r; if (abs(vZ - ref) > max(0.002, ref * 0.0002)) discard; gl_FragColor = vec4(0.25, 0.0, 0.0, 1.0); }`,
        side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: { tC: { value: countRT.texture }, uT: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `uniform sampler2D tC; uniform float uT; varying vec2 vUv;
          void main() { float c = texture2D(tC, vUv).r; float hot = step(0.45, c); gl_FragColor = vec4(1.0, 0.1, 0.25, hot * (0.55 + 0.25 * sin(uT * 6.0))); }`,
        transparent: true, depthTest: false, depthWrite: false,
      }));
      const qs = new THREE.Scene(); qs.add(quad);
      ovl = { depthRT, countRT, depthMat, countMat, quad, qs, qc: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
    }
    const O = ovl;
    if (O.depthRT.width !== size.x || O.depthRT.height !== size.y) { O.depthRT.setSize(size.x, size.y); O.countRT.setSize(size.x, size.y); }
    (O.countMat.uniforms.uRes.value as THREE.Vector2).copy(size);
    (O.quad.material as THREE.ShaderMaterial).uniforms.uT.value = performance.now() / 1000;
    const prevOv = scene.overrideMaterial, prevBg = scene.background, prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
    const prevCol = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha();
    helpers.visible = false; scene.background = null;
    scene.overrideMaterial = O.depthMat; renderer.setRenderTarget(O.depthRT); renderer.setClearColor(new THREE.Color(1e6, 0, 0), 1); renderer.clear(); renderer.render(scene, cam);
    scene.overrideMaterial = O.countMat; renderer.setRenderTarget(O.countRT); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, cam);
    scene.overrideMaterial = prevOv; scene.background = prevBg; helpers.visible = true;
    renderer.setClearColor(prevCol, prevA);
    renderer.setRenderTarget(prevRT); renderer.autoClear = false; renderer.render(O.qs, O.qc); renderer.autoClear = prevAuto;
  }
  const eng = engine as unknown as { post: { render: (dt: number) => void } | null };
  let wrapped = false;
  function setOverlap(on: boolean) {
    overlap = on; btn("overlap").classList.toggle("on", on);
    if (on && !wrapped && eng.post) {
      wrapped = true; const post = eng.post, orig = post.render.bind(post);
      post.render = (dt: number) => { orig(dt); if (overlap) { try { overlapPass(); } catch (e) { console.error("[dev overlap]", e); overlap = false; } } };
    }
  }

  function div(cls: string) { const d = document.createElement("div"); d.className = cls; document.body.appendChild(d); return d; }
  setPanel(true); setFly(!kr.game?.inMatch);
  void load();
  const api = { pickAt, setFly, setWire, setOverlap, setPanel, load, save, goTo, get notes() { return notes; }, get pick() { return pick; }, fly: { pos: flyPos, rot: flyRot } };
  kr.devView = api;
  return api;
}

function poiAt(x: number, z: number) { let best = "open island", bd = Infinity; for (const p of POIS) { const d = Math.hypot(x - p.x, z - p.z); if (d < p.r * 1.1 && d / p.r < bd) { bd = d / p.r; best = p.name; } } return best; }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
