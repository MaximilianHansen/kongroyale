// Regression tests for deterministic regional weather sim, gameplay parity (wind, wet traction, lightning), and TropicalWeather renderer.
import assert from "node:assert/strict";
import * as THREE from "three";
import { AtmosState } from "../../client/src/world/atmos/state";
import { makeAtmosUniforms } from "../../client/src/world/atmos/glsl";
import { TropicalWeather } from "../../client/src/world/atmos/weather";
import {
  WeatherKind,
  makeWeatherSample,
  makeWeatherState,
  planWeather,
  sampleWeatherAt,
  weatherAt,
} from "../../shared/sim/weather";
import { PS, makeInput, makePlayer, stepPlayer } from "../../shared/sim/player";
import { Terrain } from "../../shared/world/terrain";
import { StaticWorld } from "../../shared/sim/world";
import { DT } from "../../shared/sim/const";
import { VKind, makeVehicle, spawnVehicle, stepVehicle } from "../../shared/sim/vehicle";
import { stepHeli } from "../../shared/sim/heli";

// ---- 1. Deterministic weather generation & reconnection parity
const p1 = planWeather(42);
const p2 = planWeather(42);
const p3 = planWeather(99);
assert.deepEqual(p1, p2, "same seed must produce identical weather plan");
assert.notDeepEqual(p1.cells[0], p3.cells[0], "different seeds must produce different plans");

// ---- 2. Match lifecycle (Warmup clear, Plane active/no-hazard, Play active, Final Circles toned down, Results clear)
const wsA = makeWeatherState();
const wsB = makeWeatherState();
weatherAt(p1, 10, 0, 0, wsA);
assert.equal(wsA.count, 0, "Warmup (phase 0) must have 0 active cells");

weatherAt(p1, 120, 0, 1, wsA);
assert.ok(wsA.count > 0, "Plane (phase 1) must evaluate active weather cells");
assert.equal(wsA.strike.active, false, "Plane phase must not activate lightning hazards");

weatherAt(p1, 300, 0, 2, wsA);
weatherAt(p1, 300, 0, 2, wsB);
assert.deepEqual(wsA, wsB, "Reconnecting/late-joining at t=300 must produce identical state");
assert.ok(wsA.count > 0, "Active match must have active cells");

// Final circles reduce severe wind & disable hazards in phase 5 while keeping rain/fog
const wsMid = makeWeatherState();
const wsEnd = makeWeatherState();
weatherAt(p1, 260, 1, 2, wsMid);
weatherAt(p1, 260, 5, 2, wsEnd);
assert.equal(wsEnd.strike.active, false, "Final circle (stormPhase 5) must disable lightning hazards");
for (let i = 0; i < Math.min(wsMid.count, wsEnd.count); i++) {
  assert.ok(Math.abs(wsEnd.cells[i].windX) <= Math.abs(wsMid.cells[i].windX) + 1e-6, "Final circle wind must be reduced");
}

weatherAt(p1, 400, 3, 3, wsA);
assert.equal(wsA.count, 0, "Results (phase 3) must clear all cells");

// ---- 3. Regional cell movement, split/merge evolution, and smooth spatial sampling
const wsT0 = makeWeatherState();
const wsT1 = makeWeatherState();
weatherAt(p1, 40, 0, 2, wsT0);
weatherAt(p1, 160, 0, 2, wsT1);
assert.ok(wsT0.count > 0 && wsT1.count > 0);
assert.notEqual(wsT0.cells[0].x, wsT1.cells[0].x, "Weather cells must move over time");

// Verify split cell (spec index 2 has behavior === 1) produces 2 child cells mid-life
const splitSpec = p1.cells.find((c) => c.behavior === 1)!;
assert.ok(splitSpec, "planWeather must include split cells");
const wsSplit = makeWeatherState();
weatherAt(p1, splitSpec.bornT + splitSpec.lifeT * 0.55, 0, 2, wsSplit);
const children = wsSplit.cells.slice(0, wsSplit.count).filter((c) => Math.floor(c.id / 10) === splitSpec.id);
assert.equal(children.length, 2, "Split cell must diverge into 2 child cells mid-life");

const sampCenter = makeWeatherSample();
const sampEdge = makeWeatherSample();
const sampFar = makeWeatherSample();
const wsIso = makeWeatherState();
wsIso.count = 1;
wsIso.cells[0] = { ...wsT1.cells[0], rain: 0.85, radius: 400 };
sampleWeatherAt(wsIso, wsIso.cells[0].x, wsIso.cells[0].z, sampCenter);
sampleWeatherAt(wsIso, wsIso.cells[0].x + 320, wsIso.cells[0].z, sampEdge);
sampleWeatherAt(wsIso, wsIso.cells[0].x + 2500, wsIso.cells[0].z + 2500, sampFar);
assert.ok(sampCenter.rain > sampEdge.rain, "Rain intensity must fall off smoothly toward cell edge");
assert.equal(sampFar.kind, WeatherKind.Clear, "Far outside all cells must be clear");

// ---- 4. Wind & wet-terrain gameplay parity (shared/sim)
const terrain = new Terrain(new Float32Array(256 * 256), new Uint8Array(256 * 256));
const world = new StaticWorld(terrain, []);

const synthStorm = makeWeatherState();
synthStorm.matchPhase = 2;
synthStorm.count = 1;
synthStorm.cells[0] = { id: 1, kind: WeatherKind.Storm, x: 0, z: 0, vx: 0, vz: 0, radius: 500, rain: 1, fog: 0.5, storm: 0.9, windX: 12, windZ: 0 };

// Glider wind drift
const pDry = makePlayer(0, 0, "Dry");
const pWind = makePlayer(1, 0, "Wind");
pDry.st = pWind.st = PS.Glide;
pDry.y = pWind.y = 120;
const inpGlide = makeInput();
for (let i = 0; i < 60; i++) {
  stepPlayer(pDry, inpGlide, world, DT);
  stepPlayer(pWind, inpGlide, world, DT, synthStorm);
}
assert.ok(pWind.x > pDry.x + 1.0, `Glider must drift downwind (dry=${pDry.x}, wind=${pWind.x})`);

// Helicopter wind drift
const hDry = makeVehicle(0, VKind.Heli, 0, 50, 0);
const hWind = makeVehicle(1, VKind.Heli, 0, 50, 0);
spawnVehicle(hDry, world, 0, 0, 0, VKind.Heli);
spawnVehicle(hWind, world, 0, 0, 0, VKind.Heli);
hDry.y = hWind.y = 50;
hDry.air = hWind.air = true; hDry.steer = hWind.steer = 1;
for (let i = 0; i < 60; i++) {
  stepHeli(hDry, world, 0, 0, false, false, 0, true, DT);
  stepHeli(hWind, world, 0, 0, false, false, 0, true, DT, synthStorm);
}
assert.ok(hWind.x > hDry.x + 0.5, "Airborne helicopter must experience capped wind drift");

// Wet-ground stopping distance (player) & tuk-tuk lateral grip
const gDry = makePlayer(2, 0, "GDry");
const gWet = makePlayer(3, 0, "GWet");
gDry.st = gWet.st = PS.Ground; gDry.grounded = gWet.grounded = true;
gDry.vx = gWet.vx = 8;
const inpStop = makeInput();
for (let i = 0; i < 15; i++) {
  stepPlayer(gDry, inpStop, world, DT);
  stepPlayer(gWet, inpStop, world, DT, synthStorm);
}
assert.ok(gWet.vx > gDry.vx, `Wet ground must subtly increase stopping distance (dryVx=${gDry.vx}, wetVx=${gWet.vx})`);

const vDry = makeVehicle(2, VKind.Tuk, 0, 0, 0);
const vWet = makeVehicle(3, VKind.Tuk, 0, 0, 0);
spawnVehicle(vDry, world, 0, 0, 0, VKind.Tuk);
spawnVehicle(vWet, world, 0, 0, 0, VKind.Tuk);
vDry.vx = vWet.vx = 6; // pure lateral slide (facing -Z)
stepVehicle(vDry, world, 0, 0, false, DT);
stepVehicle(vWet, world, 0, 0, false, DT, false, synthStorm);
assert.ok(vWet.vx > vDry.vx, "Wet ground must reduce tuk-tuk lateral tyre grip");

// ---- 5. Lightning strike telegraph precedes discharge
let sawTelegraph = false, sawDischarge = false;
const stormSpec = p1.cells.find((c) => c.stormPeak > 0.45)!;
assert.ok(stormSpec, "planWeather must include storm cells");
const wsStrike = makeWeatherState();
for (let dt = 0; dt < stormSpec.strikeEveryS + 5; dt += 0.25) {
  weatherAt(p1, stormSpec.bornT + stormSpec.lifeT * 0.35 + dt, 0, 2, wsStrike);
  if (wsStrike.strike.active && !wsStrike.strike.discharging) sawTelegraph = true;
  if (wsStrike.strike.active && wsStrike.strike.discharging) sawDischarge = true;
}
assert.ok(sawTelegraph && sawDischarge, "Storm cells must produce telegraphed environmental lightning strikes");

// ---- 6. TropicalWeather renderer API, smooth fade, quality budgets, and zero preset rebake
const state = new AtmosState();
const uniforms = makeAtmosUniforms();
const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
cam.position.set(10, 5, 10);
let lastStreaks = -1, lastPuddles = -1;
const weather = new TropicalWeather(state, uniforms, (s, p) => { lastStreaks = s; lastPuddles = p; });

assert.equal(weather.getRainIntensity(), 0);
assert.equal(weather.object.visible, false);
weather.setConditions(1, 0.5, 0.8, 8, -4, 1);
for (let i = 0; i < 10; i++) weather.update(cam, 0.1, 1.0 + i * 0.1, null);
assert.ok(weather.getRainIntensity() > 0.6 && weather.getRainIntensity() < 0.85);
assert.equal(weather.object.visible, true);
assert.ok(uniforms.uAtmWet.value > 0 && lastStreaks > 0);

weather.setPuddlesEnabled(false);
weather.setRainIntensity(1.0, true);
weather.update(cam, 0.016, 2.0, null);
assert.equal(lastPuddles, 0, "puddles must stay 0 on low post");
weather.setPuddlesEnabled(true);
weather.update(cam, 0.016, 2.1, null);
assert.ok(lastPuddles > 0, "puddles must ramp when enabled");

weather.setEffectsQuality("low");
assert.deepEqual(weather.object.geometry.drawRange, { start: 0, count: 420 * 2 });
weather.setEffectsQuality("epic");
assert.deepEqual(weather.object.geometry.drawRange, { start: 0, count: 1400 * 2 });

let presetChanges = 0;
state.onChange(() => { presetChanges++; });
weather.setRainIntensity(0, true);
weather.update(cam, 0.016, 3.0, null);
assert.equal(presetChanges, 0, "weather must not trigger AtmosState preset rebakes");
assert.equal(weather.object.visible, false);

weather.dispose();
console.log("weather complete regression tests: ok");
