// FIRING RANGE client extras (layout: shared/sim/range.ts). Everything that matters — damage, falloff, spread, fire rate,
// reloads, hit registration — is the real match code running in the offline host; this file only draws the range
// furniture (distance boards + runway paint, firing line, rack labels, heal pad), a health / shield bar over every
// target, and a stats panel: the held weapon's numbers at its tier, the aimed target + range, the last hit and the last
// kill (hits, shots, time) next to what the formula says it should take at that distance.
import * as THREE from "three";
import type { Engine } from "../engine/engine";
import type { ClientMatch } from "./client";
import { CONSUMABLES, RARITIES, RARITY_COLOR, WEAPONS } from "../../../shared/world/map";
import { CONSUMABLE_DEFS, WEAPON_DEFS, PLAYER_H, CROUCH_H, type WeaponDef } from "../../../shared/sim/const";
import { PS, SK, eyeY, pelletDamage, rarityOf } from "../../../shared/sim/player";
import { rayCapsule } from "../../../shared/sim/hitscan";
import { sw } from "../../../shared/pois/peel-strip";
import {
  HEAL_PAD, RACK_COL, RANGE_DISTANCES, RANGE_LINE_X, RANGE_YAW_DOWNRANGE, healPadPos, rackRowX,
} from "../../../shared/sim/range";
import { HUD_MIN_W, UI } from "../ui/styles";
import { bindingText, onLabelsChange, pauseText } from "../settings/labels";
import { keycap } from "../ui/toon";
import { injectHudToon } from "../ui/hud-css";

const NAMES: Record<string, string> = Object.fromEntries(WEAPONS.map((w) => [w, WEAPON_DEFS[w].name]));

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!; draw(g);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const flatMat = (map: THREE.Texture, opacity = 1) => new THREE.MeshBasicMaterial({ map, transparent: true, opacity, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 });

interface Track { start: number; hits: number; dmg: number; seq0: number; head: number }
interface Bar { sprite: THREE.Sprite; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; key: string }

export class RangeView {
  private readonly root = new THREE.Group();
  private readonly bars = new Map<number, Bar>();
  private readonly track = new Map<number, Track>();
  private readonly panel: HTMLDivElement;
  private readonly els: Record<string, HTMLElement> = {};
  /** (Toon) the practice hints as keycap rows: done once you have taken from the rack / opened the analytics */
  private readonly hintRows: Record<"rack" | "stats", HTMLElement> = {} as never;
  private hintDone = { rack: false, stats: false }; private offLabels: () => void = () => {};
  private lastHit: { dmg: number; zone: number; dist: number; name: string; at: number } | null = null;
  private lastKill: { name: string; hits: number; head: number; shots: number; time: number; weapon: string; dist: number; expShots: number; expTime: number; dmg: number } | null = null;
  private panelKey = "";
  private readonly ray = new THREE.Vector3();
  /** the distance boards (the nearer lanes' boards filled the upper third of the 6× scope at
   * 100 m — while scoped, the boards within 80 m of the camera are hidden) */
  private readonly boards: THREE.Mesh[] = [];

  constructor(private readonly engine: Engine, private readonly cm: ClientMatch, private readonly nameOf: (id: number) => string) {
    this.root.name = "firing-range";
    const ground = (x: number, z: number) => Math.max(0, engine.terrain.height(x, z));
    // ---- runway paint: the firing line + a big distance number in the middle lane at every target distance
    {
      const [x, , z] = sw(RANGE_LINE_X + 0.4, 0);
      const line = new THREE.Mesh(new THREE.PlaneGeometry(22, 0.35), new THREE.MeshBasicMaterial({ color: "#ffd400", toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      line.position.set(x, ground(x, z) + 0.09, z); line.rotateY(RANGE_YAW_DOWNRANGE); line.rotateX(-Math.PI / 2);
      this.root.add(line);
    }
    for (const d of RANGE_DISTANCES) {
      const tex = canvasTex(256, 512, (g) => {
        g.fillStyle = "rgba(255,255,255,0.92)"; g.font = `800 250px ${UI.block}`; g.textAlign = "center"; g.textBaseline = "middle";
        g.save(); g.translate(128, 256); g.scale(1, 1.9); g.fillText(String(d), 0, 0); g.restore();
      });
      const [x, , z] = sw(RANGE_LINE_X + d - 3.5, 0);
      const len = Math.min(16, 3 + d * 0.06);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.6 + d * 0.008, len), flatMat(tex, 0.85));
      m.position.set(x, ground(x, z) + 0.09, z); m.rotateY(RANGE_YAW_DOWNRANGE); m.rotateX(-Math.PI / 2);
      m.renderOrder = 2; this.root.add(m);
      // boards on posts outside each pair (never inside a lane of fire), scaled up with distance so they stay legible
      const lz = 2 + 0.025 * d + 1.6, k = 1 + d / 70;
      const boardTex = canvasTex(256, 128, (g) => {
        g.fillStyle = "#0e2a3e"; g.fillRect(0, 0, 256, 128); g.strokeStyle = "#ffd400"; g.lineWidth = 10; g.strokeRect(5, 5, 246, 118);
        g.fillStyle = "#ffd400"; g.font = `800 78px ${UI.block}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(`${d} M`, 128, 68);
      });
      for (const side of [-1, 1]) {
        const [bx, , bz] = sw(RANGE_LINE_X + d, side * lz), by = ground(bx, bz);
        const board = new THREE.Mesh(new THREE.PlaneGeometry(1.1 * k, 0.55 * k), new THREE.MeshBasicMaterial({ map: boardTex, toneMapped: false }));
        board.position.set(bx, by + 1.0 * k + 0.35, bz); board.rotation.y = RANGE_YAW_DOWNRANGE;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.08 * k, 1.0 * k + 0.35, 0.08 * k), new THREE.MeshStandardMaterial({ color: "#5a3b22", roughness: 0.9 }));
        post.position.set(bx, by + (1.0 * k + 0.35) / 2, bz);
        this.root.add(board, post); this.boards.push(board);
      }
    }
    // ---- rack labels: gun per row (left of the row), rarity per column (over the first row); heals + ammo rows
    const label = (text: string, color: string, x: number, y: number, z: number, w = 1.6) => {
      const tex = canvasTex(512, 128, (g) => {
        g.fillStyle = "rgba(14,42,62,0.82)"; g.beginPath(); g.roundRect(4, 14, 504, 100, 22); g.fill();
        g.fillStyle = color; g.font = `800 64px ${UI.cond}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 256, 66);
      });
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, toneMapped: false, depthWrite: false }));
      s.scale.set(w, w / 4, 1); s.position.set(x, y, z); this.root.add(s);
    };
    const rows = [...WEAPONS.map((w) => NAMES[w]), "HEALS", "AMMO"];
    rows.forEach((n, row) => { const [x, , z] = sw(rackRowX(row), -2 * RACK_COL - 1.6); label(n, "#ffd400", x, ground(x, z) + 0.8, z, 1.25); });
    RARITIES.forEach((r, i) => { const [x, , z] = sw(rackRowX(0) + 1.05, (i - 2) * RACK_COL); label(r.toUpperCase(), RARITY_COLOR[r], x, ground(x, z) + 0.4, z, 0.9); });
    { const [x, , z] = sw(rackRowX(WEAPONS.length + 1) - 2.2, 0); label("THE RACK · E TO TAKE", "#f6efc6", x, ground(x, z) + 2.2, z, 3.6); }
    // ---- heal test pad
    {
      const [x, , z] = healPadPos(), y = ground(x, z) + 0.08;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(HEAL_PAD.r, 48), new THREE.MeshBasicMaterial({ color: "#ff3b30", transparent: true, opacity: 0.35, toneMapped: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      disc.rotation.x = -Math.PI / 2; disc.position.set(x, y, z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(HEAL_PAD.r - 0.12, HEAL_PAD.r, 64), new THREE.MeshBasicMaterial({ color: "#ff5f57", toneMapped: false, polygonOffset: true, polygonOffsetFactor: -5 }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(x, y + 0.005, z);
      this.root.add(disc, ring);
      label("HEAL TEST PAD · DRAINS HP", "#ff8a80", x, y + 1.3, z, 1.9);
    }
    engine.scene.add(this.root);

    // ---- the PRACTICE panel under the minimap (Toon: the HUD's mode label — eyebrow + rule, "Infinite ammo" — then the
    // practice hints as keycap rows from the real bindings, fading once done); the analytics (gun stats, range to the
    // aimed target, last hit, last kill) open from the pause card (PRACTICE ANALYTICS). Sized in the HUD's unit
    // (ui/hud-css.ts .tn-hud-practice), so HUD size scales it.
    injectHudToon();
    const p = this.panel = document.createElement("div");
    p.className = "tn-hud-practice kr-tu";
    p.style.setProperty("--u", `min(calc(100vh / 1440 * var(--hud-scale, 1)), calc(100vw / ${HUD_MIN_W}))`);
    p.style.setProperty("--tu", "calc(var(--u) * 1440 / 1080)");
    p.innerHTML = `<div class="eb">Practice</div><div class="sub">Infinite ammo</div>
      <div class="rows"><div class="tn-hud-row" data-r="rack"><span>Take from the rack</span></div><div class="tn-hud-row" data-r="stats"><span>Menu · analytics</span></div></div>
      <div class="range-details" hidden><div class="gun" data-k="gun"></div><div data-k="stats"></div><div data-k="aim"></div><div data-k="hit"></div><div data-k="kill"></div><small>${bindingText("use", 0)} takes from the rack · targets respawn · left lane shielded · right lane health only · red pad drains HP</small></div>`;
    for (const el of p.querySelectorAll<HTMLElement>("[data-k]")) this.els[el.dataset.k!] = el;
    for (const el of p.querySelectorAll<HTMLElement>("[data-r]")) this.hintRows[el.dataset.r as "rack" | "stats"] = el;
    // the keycaps follow a rebind / the device in hand
    this.offLabels = onLabelsChange(() => {
      for (const [r, key] of [["rack", bindingText("use", 0)], ["stats", pauseText()]] as const) {
        const row = this.hintRows[r]; row.querySelector("kbd")?.remove(); row.prepend(keycap(key));
      }
    });
    (document.getElementById("ui") ?? document.body).appendChild(p);
  }

  /** the pause card's PRACTICE ANALYTICS: show / hide the details; true = now shown */
  toggleStats() { const details = this.panel.querySelector<HTMLElement>(".range-details")!; details.hidden = !details.hidden; return !details.hidden; }
  get statsShown() { return !this.panel.querySelector<HTMLElement>(".range-details")!.hidden; }
  // ---------------------------------------------------------------- events
  onHit(shooter: number, victim: number, zone: number, dmg: number, x: number, y: number, z: number, kill: boolean) {
    const cm = this.cm, me = cm.me;
    if (shooter !== me || victim === me) return;
    const p = cm.pred, now = performance.now();
    const dist = Math.hypot(x - p.x, y - eyeY(p), z - p.z);
    const name = this.nameOf(victim);
    this.lastHit = { dmg, zone, dist, name, at: now };
    let t = this.track.get(victim);
    if (!t) { t = { start: now, hits: 0, dmg: 0, seq0: p.shotSeq - 1, head: 0 }; this.track.set(victim, t); }
    t.hits++; t.dmg += dmg; if (zone === 1) t.head++;
    if (kill) {
      const s = p.slots[p.active];
      const w = s.kind === SK.Weapon ? WEAPON_DEFS[WEAPONS[s.id]] : null;
      const full = /SHIELD/.test(name) ? 200 : 100;
      const exp = w ? expected(w, s.rarity, dist, full) : { shots: 0, time: 0 };
      this.lastKill = { name, hits: t.hits, head: t.head, shots: Math.max(1, p.shotSeq - t.seq0), time: (now - t.start) / 1000, weapon: w ? `${w.name} · ${rarityOf(s.rarity).toUpperCase()}` : "", dist, expShots: exp.shots, expTime: exp.time, dmg: t.dmg };
      this.track.delete(victim);
    }
  }
  onKill(_killer: number, victim: number) { if (victim !== this.cm.me) this.track.delete(victim); }

  // ---------------------------------------------------------------- frame
  update(_dt: number) {
    const cm = this.cm, cam = this.engine.camera;
    this.panel.style.visibility = cm.pred.scoped || cm.pred.ads ? "hidden" : "visible";   // out of the way while aiming
    { const scoped = cm.pred.scoped; for (const b of this.boards) { const v = !scoped || b.position.distanceToSquared(cam.position) > 80 * 80; if (b.visible !== v) b.visible = v; } }
    // target bars
    for (const r of cm.remotes) {
      if (r.id === cm.me) continue;
      let b = this.bars.get(r.id);
      const show = r.present && r.n > 0 && r.st !== PS.Dead && r.st !== PS.Spectate;
      if (!show) { if (b) b.sprite.visible = false; continue; }
      if (!b) b = this.makeBar(r.id);
      b.sprite.visible = true;
      b.sprite.position.set(r.x, r.y + (r.crouch ? CROUCH_H : PLAYER_H) + 0.45, r.z);
      const key = `${Math.ceil(r.hp)}|${Math.ceil(r.shield)}`;
      if (key !== b.key) { b.key = key; this.drawBar(b, this.nameOf(r.id), r.hp, r.shield); }
    }
    // aimed target (the same capsule test the server uses) + distance
    const p = cm.pred;
    cam.getWorldDirection(this.ray);
    let aimName = "", aimD = Infinity;
    for (const r of cm.remotes) {
      if (r.id === cm.me || !r.present || r.n === 0 || r.st === PS.Dead) continue;
      const t = rayCapsule(cam.position.x, cam.position.y, cam.position.z, this.ray.x, this.ray.y, this.ray.z, r.x, r.y, r.z, r.crouch ? CROUCH_H : PLAYER_H, 400, r.yaw);
      if (t >= 0 && t < aimD) { aimD = t; aimName = this.nameOf(r.id); }
    }
    // practice hints: done once something is in your hands / once the analytics have been opened (they fade)
    const rack = this.hintDone.rack || p.slots.some((q) => q.kind !== SK.Empty), stats = this.hintDone.stats || this.statsShown;
    if (rack !== this.hintDone.rack || stats !== this.hintDone.stats) {
      this.hintDone = { rack, stats };
      this.hintRows.rack.classList.toggle("done", rack); this.hintRows.stats.classList.toggle("done", stats);
      this.hintRows.rack.parentElement!.classList.toggle("all-done", rack && stats);
    }
    // panel (rebuilt only when something shown changes)
    const s = p.slots[p.active];
    const w = s.kind === SK.Weapon ? WEAPON_DEFS[WEAPONS[s.id]] : null;
    const rar = rarityOf(s.rarity);
    const aimKey = aimName ? `${aimName}|${aimD.toFixed(1)}` : "";
    const key = `${s.kind}:${s.id}:${s.rarity}|${aimKey}|${this.lastHit?.at ?? 0}|${this.lastKill?.time ?? 0}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    const E = this.els;
    const col = RARITY_COLOR[rar];
    if (w) {
      E.gun.innerHTML = `${w.name} <span style="color:${col}">· ${rar.toUpperCase()}</span>`;
      const body = pelletDamage(w, s.rarity, 0, 0), head = pelletDamage(w, s.rarity, 0, 1);
      const per = w.pellets > 1 ? ` ×${w.pellets}` : "";
      const splash = w.projectile ? ` + ${(w.projectile.splashDmg * body / w.dmg).toFixed(1)} splash (${w.projectile.splashR} m)` : "";
      E.stats.innerHTML = `${body.toFixed(1)}${per} body${w.projectile ? "" : ` · ${head.toFixed(1)}${per} head`}${splash}<br>${w.rpm} RPM · ${w.mag} mag · ${w.reloadS} s reload · ${w.auto ? "auto" : "semi"}<br>`
        + (w.projectile ? `${w.id === "bow" ? "silent explosive arrow" : "rocket"} ${w.projectile.speed} m/s, no falloff` : `full damage to ${w.falloff[0]} m · ${Math.round(w.falloff[2] * 100)}% from ${w.falloff[1]} m`)
        + (aimName ? `<br><span style="color:var(--kong-accent)">at ${aimD.toFixed(0)} m: ${pelletDamage(w, s.rarity, aimD, 0).toFixed(1)}${per} body · ${expected(w, s.rarity, aimD, 100).shots} to kill 100 · ${expected(w, s.rarity, aimD, 200).shots} to kill 200</span>` : "");
    } else if (s.kind === SK.Consumable) {
      const c = CONSUMABLE_DEFS[CONSUMABLES[s.id]];
      E.gun.innerHTML = `${c.name} <span style="color:${col}">· ${rar.toUpperCase()}</span>`;
      E.stats.innerHTML = c.id === "vine-grapple"
        ? `38 m jungle hook · sling onto roofs & cliffs · stacks to ${c.stack}<br>aim at a surface and press fire to launch`
        : c.id === "airstrike"
          ? `6-bomb barrage · 125 dmg per blast · 180 m range<br>aim at ground and press fire to call bomber`
          : `${c.hp ? `+${c.hp} HP ` : ""}${c.shield ? `+${c.shield} SHIELD ` : ""}· ${c.useS} s to use · stacks to ${c.stack}<br>fire to use (only when it would restore something)`;
    } else { E.gun.textContent = "EMPTY HANDS"; E.stats.textContent = `grab something from the rack behind you (${bindingText("use", 0)})`; }
    E.aim.innerHTML = aimName ? `AIMING AT <b style="color:var(--kong-accent)">${aimName}</b> · ${aimD.toFixed(1)} m` : `<span style="opacity:.6">aim at a target for its range</span>`;
    const h = this.lastHit;
    E.hit.innerHTML = h ? `LAST HIT <b style="color:${h.zone === 1 ? "var(--kong-danger)" : h.zone === 2 ? "var(--kong-shield)" : "var(--kong-text)"}">${h.dmg.toFixed(1)} ${h.zone === 1 ? "HEAD" : h.zone === 2 ? "SHIELD" : "BODY"}</b> · ${h.dist.toFixed(1)} m · ${h.name}` : "";
    const k = this.lastKill;
    E.kill.innerHTML = k ? `LAST KILL <b style="color:var(--kong-accent)">${k.name}</b> at ${k.dist.toFixed(0)} m · ${k.weapon}<br>${k.hits} hit${k.hits === 1 ? "" : "s"}${k.head ? ` (${k.head} head)` : ""} · ${k.shots} shot${k.shots === 1 ? "" : "s"} fired · ${k.time.toFixed(2)} s`
      + (k.expShots ? `<br><span style="opacity:.75">formula, all body shots: ${k.expShots} to kill · ${k.expTime.toFixed(2)} s</span>` : "") : "";
  }

  private makeBar(id: number): Bar {
    const c = document.createElement("canvas"); c.width = 256; c.height = 72;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, toneMapped: false, depthWrite: false, sizeAttenuation: false }));
    sprite.scale.set(0.11, 0.031, 1); sprite.renderOrder = 8;
    this.root.add(sprite);
    const b: Bar = { sprite, ctx: c.getContext("2d")!, tex, key: "" };
    this.bars.set(id, b);
    return b;
  }
  private drawBar(b: Bar, name: string, hp: number, shield: number) {
    const g = b.ctx; g.clearRect(0, 0, 256, 72);
    g.fillStyle = "rgba(10,24,36,0.78)"; g.beginPath(); g.roundRect(0, 0, 256, 72, 10); g.fill();
    g.fillStyle = "#f6efc6"; g.font = `700 22px ${UI.cond}`; g.textBaseline = "middle"; g.textAlign = "left"; g.fillText(name, 10, 16);
    g.textAlign = "right"; g.fillText(`${Math.ceil(hp)}${shield > 0 || /SHIELD/.test(name) ? ` | ${Math.ceil(shield)}` : ""}`, 246, 16);
    const bar = (y: number, h: number, f: number, col: string) => { g.fillStyle = "rgba(255,255,255,0.12)"; g.fillRect(10, y, 236, h); g.fillStyle = col; g.fillRect(10, y, 236 * Math.max(0, Math.min(1, f)), h); };
    if (/SHIELD/.test(name)) { bar(32, 12, shield / 100, "#6fd0ff"); bar(50, 14, hp / 100, hp > 30 ? "#ffd805" : "#ff5f57"); }
    else bar(36, 22, hp / 100, hp > 30 ? "#ffd805" : "#ff5f57");
    b.tex.needsUpdate = true;
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh; m.geometry?.dispose?.();
      const mat = m.material as THREE.Material & { map?: THREE.Texture } | undefined; if (mat) { mat.map?.dispose(); mat.dispose(); }
    });
    this.panel.remove(); this.offLabels();
  }
}

/** shots + time the formula says a kill takes at distance d on a target with `full` hp + shield, every shot on the body
 * with every pellet landing (rockets: a direct hit = impact + full splash); time = (shots − 1) / fire rate, plus a reload
 * for every emptied magazine */
function expected(w: WeaponDef, rarity: number, d: number, full: number): { shots: number; time: number } {
  const per = w.projectile ? pelletDamage(w, rarity, 0, 0) + w.projectile.splashDmg * (pelletDamage(w, rarity, 0, 0) / w.dmg) : pelletDamage(w, rarity, d, 0) * w.pellets;
  const shots = Math.ceil((full - 1e-6) / per);
  const reloads = Math.floor((shots - 1) / w.mag);
  return { shots, time: (shots - 1 - reloads) * (60 / w.rpm) + reloads * w.reloadS };
}
