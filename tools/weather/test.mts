// Unit tests for TropicalWeather rain intensity API, smooth transitions, quality budgets, and disposal.
import assert from "node:assert/strict";
import * as THREE from "three";
import { AtmosState } from "../../client/src/world/atmos/state";
import { makeAtmosUniforms } from "../../client/src/world/atmos/glsl";
import { TropicalWeather } from "../../client/src/world/atmos/weather";

const state = new AtmosState();
const uniforms = makeAtmosUniforms();
const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
cam.position.set(10, 5, 10);

let lastStreaks = -1;
let lastPuddles = -1;
const weather = new TropicalWeather(state, uniforms, (s, p) => {
  lastStreaks = s;
  lastPuddles = p;
});

// 1. Starts clear with rain object hidden
assert.equal(weather.getRainIntensity(), 0);
assert.equal(weather.getRainTarget(), 0);
assert.equal(weather.isActive(), false);
assert.equal(weather.object.visible, false);

// 2. Clamping and smooth fade (does not snap without immediate=true)
weather.setRainIntensity(1.8);
assert.equal(weather.getRainTarget(), 1);
assert.equal(weather.getRainIntensity(), 0);
assert.equal(weather.isActive(), true);

weather.update(cam, 0.1, 1.0, null);
const step1 = weather.getRainIntensity();
assert.ok(step1 > 0.05 && step1 < 0.25, `expected smooth initial step, got ${step1}`);
for (let i = 0; i < 9; i++) weather.update(cam, 0.1, 1.1 + i * 0.1, null);
const after1s = weather.getRainIntensity();
assert.ok(after1s > 0.6 && after1s < 0.85, `expected smooth fade after 1s, got ${after1s}`);
assert.equal(weather.object.visible, true);
assert.ok(uniforms.uAtmWet.value > 0, "uAtmWet should scale with rain intensity");
assert.ok(lastStreaks > 0, "post streaks should scale with rain intensity");

// 3. Puddles gated off on low post quality
weather.setPuddlesEnabled(false);
weather.setRainIntensity(1.0, true);
weather.update(cam, 0.016, 2.0, null);
assert.equal(lastPuddles, 0, "puddles must stay 0 when disabled on low post");

weather.setPuddlesEnabled(true);
weather.update(cam, 0.016, 2.1, null);
assert.ok(lastPuddles > 0, "puddles should ramp when enabled at high intensity");

// 4. Quality draw-range budgets
weather.setEffectsQuality("low");
assert.deepEqual(weather.object.geometry.drawRange, { start: 0, count: 420 * 2 });
weather.setEffectsQuality("medium");
assert.deepEqual(weather.object.geometry.drawRange, { start: 0, count: 840 * 2 });
weather.setEffectsQuality("high");
assert.deepEqual(weather.object.geometry.drawRange, { start: 0, count: 1190 * 2 });
weather.setEffectsQuality("epic");
assert.deepEqual(weather.object.geometry.drawRange, { start: 0, count: 1400 * 2 });

// 5. Immediate reset to 0 hides object and zeroes effects
weather.setRainIntensity(-0.5, true);
assert.equal(weather.getRainTarget(), 0);
assert.equal(weather.getRainIntensity(), 0);
weather.update(cam, 0.016, 3.0, null);
assert.equal(weather.object.visible, false);
assert.equal(uniforms.uAtmWet.value, 0);
assert.equal(lastStreaks, 0);
assert.equal(lastPuddles, 0);

// 6. Does not trigger AtmosState preset listeners (no sky/env rebake)
let presetChanges = 0;
state.onChange(() => { presetChanges++; });
weather.setRainIntensity(0.8, true);
weather.update(cam, 0.016, 4.0, null);
weather.setRainIntensity(0, true);
weather.update(cam, 0.016, 4.1, null);
assert.equal(presetChanges, 0, "rain intensity must not trigger AtmosState preset rebakes");

weather.dispose();
console.log("weather unit tests: ok");
