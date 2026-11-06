// classifyGpu (client/src/engine/display.ts): the level the Auto video preset starts at for a WebGL renderer string.
// The first boot builds the world at that level and the first-visit bench can only step down from it, so a card read
// too high stays too high. Real strings in the shapes browsers report them: Chrome on Windows (ANGLE Direct3D11, with or
// without the PCI device id), Chrome on Linux (OpenGL and Mesa), Chrome on a Mac (ANGLE Metal) and Firefox's sanitised
// buckets (", or similar"). Every failing row is printed before the check fails.
import assert from "node:assert/strict";
import { classifyGpu, type Level } from "../../client/src/engine/display";

const d3d = (vendor: string, card: string, id?: string) => `ANGLE (${vendor}, ${card}${id ? ` (0x0000${id})` : ""} Direct3D11 vs_5_0 ps_5_0, D3D11)`;
const nv = (card: string, id?: string) => d3d("NVIDIA", `NVIDIA ${card}`, id);
const amd = (card: string, id?: string) => d3d("AMD", card, id);
const intel = (card: string, id?: string) => d3d("Intel", card, id);
const firefox = (vendor: string, card: string) => `ANGLE (${vendor}, ${card} Direct3D11 vs_5_0 ps_5_0), or similar`;
const linuxNv = (card: string) => `ANGLE (NVIDIA Corporation, NVIDIA ${card}/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 535.54.03)`;
const mesa = (card: string, chip: string) => `ANGLE (AMD, ${card} (radeonsi, ${chip}, LLVM 15.0.7, DRM 3.49, 6.1.0-18-amd64), OpenGL 4.6 (Core Profile) Mesa 22.3.6)`;
const metal = (chip: string) => `ANGLE (Apple, ANGLE Metal Renderer: ${chip}, Unspecified Version)`;

const cases: Array<[string, Level]> = [
  // anchors that were right before the older-card rules: these must not move
  [nv("GeForce RTX 3070 Laptop GPU", "249D"), "epic"],
  [nv("GeForce RTX 4090", "2684"), "epic"],
  [amd("AMD Radeon RX 7900 XTX", "744C"), "epic"],
  [nv("TITAN V", "1D81"), "epic"],
  [nv("TITAN RTX", "1E02"), "epic"],
  [nv("GeForce RTX 3060", "2503"), "high"],
  [nv("GeForce GTX 1080 Ti"), "high"],
  [nv("GeForce RTX 2060"), "medium"],
  [nv("GeForce GTX 1660 SUPER"), "medium"],
  [nv("GeForce GTX 1050 Ti", "1C82"), "medium"],
  [nv("GeForce GTX 1050"), "medium"],
  [nv("GeForce RTX 3050 Laptop GPU"), "medium"],
  [amd("AMD Radeon RX 580 2048SP", "6FDF"), "medium"],
  [amd("AMD Radeon RX 6500 XT", "743F"), "medium"],
  [amd("AMD Radeon RX 6400", "743F"), "medium"],
  [amd("AMD Radeon RX 5600 XT", "731F"), "medium"],
  [amd("AMD Radeon RX 5500 XT"), "medium"],
  [metal("Apple M1 Pro"), "medium"],
  [metal("Apple M1"), "low"],
  [intel("Intel(R) UHD Graphics 620", "5917"), "low"],
  [intel("Intel(R) HD Graphics 520"), "low"],
  [intel("Intel(R) HD Graphics 4000"), "low"],
  [intel("Intel(R) Iris(R) Xe Graphics", "9A49"), "low"],
  [amd("AMD Radeon(TM) Vega 8 Graphics", "15DD"), "low"],
  [amd("AMD Radeon(TM) Graphics"), "low"],
  [amd("AMD Radeon 780M Graphics"), "low"],
  ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "low"],

  // GeForce GT, MX and laptop 800M / 900M parts: low
  [nv("GeForce GT 710", "128B"), "low"],
  [nv("GeForce GT 730", "1287"), "low"],
  [nv("GeForce GT 1030", "1D01"), "low"],
  [nv("GeForce GT 750M"), "low"],
  [nv("GeForce MX150", "1D10"), "low"],
  [nv("GeForce MX250"), "low"],
  [nv("GeForce MX450", "1F9D"), "low"],
  [nv("GeForce MX550"), "low"],
  [nv("GeForce 940MX"), "low"],
  [nv("GeForce 920M"), "low"],
  [nv("GeForce 840M"), "low"],
  // GTX 400 to 700 (Fermi, Kepler, first Maxwell) and the GTX 900M parts below the 970M: low
  [nv("GeForce GTX 660", "11C0"), "low"],
  [nv("GeForce GTX 750 Ti", "1380"), "low"],
  [nv("GeForce GTX 780 Ti"), "low"],
  [nv("GeForce GTX 680MX"), "low"],
  [nv("GeForce GTX 860M"), "low"],
  [nv("GeForce GTX 960M"), "low"],
  [nv("GeForce GTX 965M"), "low"],
  // GTX 950 to 980 and 970M / 980M: medium; GTX 980 Ti: high
  [nv("GeForce GTX 950"), "medium"],
  [nv("GeForce GTX 960", "1401"), "medium"],
  [nv("GeForce GTX 970", "13C2"), "medium"],
  [nv("GeForce GTX 980"), "medium"],
  [nv("GeForce GTX 970M"), "medium"],
  [nv("GeForce GTX 980 Ti", "17C8"), "high"],
  // Titans: Kepler (2013) low, Maxwell / Pascal Titan X and Xp high, Volta and Turing epic (above)
  [nv("GeForce GTX TITAN"), "low"],
  [nv("GeForce GTX TITAN Black", "100C"), "low"],
  [nv("GeForce GTX TITAN Z"), "low"],
  [nv("GeForce GTX TITAN X"), "high"],
  [nv("TITAN X (Pascal)", "1B00"), "high"],
  [nv("TITAN Xp"), "high"],
  // workstation cards: Fermi / Kepler / small Maxwell, P400-P1000 and T400-T600 low; mid-range ones medium
  [nv("Quadro K620", "13BB"), "low"],
  [nv("Quadro K2200"), "low"],
  [nv("Quadro M1200"), "low"],
  [nv("Quadro 2000"), "low"],
  [nv("Quadro NVS 295"), "low"],
  [nv("Quadro P400"), "low"],
  [nv("Quadro P1000", "1CB1"), "low"],
  [nv("T400 4GB", "1FF2"), "low"],
  [nv("T600 Laptop GPU"), "low"],
  [nv("Quadro M4000"), "medium"],
  [nv("Quadro P2000"), "medium"],
  [nv("T1000 8GB", "1EB8"), "medium"],
  [nv("Quadro T2000 with Max-Q Design"), "medium"],
  [nv("RTX A2000 12GB", "2531"), "medium"],
  [nv("RTX A1000 6GB Laptop GPU"), "medium"],
  [nv("RTX A4000"), "epic"],
  [nv("Quadro RTX 4000"), "high"],

  // Radeon HD, R5 / R7 (discrete, laptop, A-series APUs), 520-630 laptop parts, 600M iGPUs, RX 540 / 550 / 640: low
  [amd("AMD Radeon HD 7700 Series", "683D"), "low"],
  [amd("AMD Radeon(TM) HD 8610G"), "low"],
  [amd("AMD Radeon R7 200 Series", "6658"), "low"],
  [amd("AMD Radeon (TM) R7 370 Series"), "low"],
  [amd("AMD Radeon R7 M260"), "low"],
  [amd("AMD Radeon R5 M330"), "low"],
  [amd("AMD Radeon(TM) R5 Graphics", "9874"), "low"],
  [amd("AMD Radeon(TM) R7 Graphics"), "low"],
  [amd("AMD Radeon 520"), "low"],
  [amd("AMD Radeon(TM) 535"), "low"],
  [amd("AMD Radeon 540X"), "low"],
  [amd("AMD Radeon 625"), "low"],
  [amd("AMD Radeon(TM) 610M"), "low"],
  [amd("AMD Radeon(TM) 680M", "1681"), "low"],
  [amd("Radeon RX 550 Series", "699F"), "low"],
  [amd("AMD Radeon RX 550X"), "low"],
  [amd("AMD Radeon RX 640"), "low"],
  // RX 460 / 560 match the GTX 1050 / 1050 Ti; R9 and RX 470-590: medium
  [amd("Radeon RX 560 Series", "67FF"), "medium"],
  [amd("AMD Radeon RX 560X"), "medium"],
  [amd("Radeon (TM) RX 460 Graphics"), "medium"],
  [amd("Radeon (TM) RX 470 Graphics"), "medium"],
  [amd("AMD Radeon RX 590"), "medium"],
  [amd("AMD Radeon R9 200 Series"), "medium"],
  [amd("AMD Radeon (TM) R9 380 Series"), "medium"],
  [amd("AMD Radeon R9 Fury Series"), "medium"],

  // Chrome on Linux
  [linuxNv("GeForce GTX 970"), "medium"],
  [linuxNv("GeForce GTX 980 Ti"), "high"],
  [linuxNv("GeForce GTX 750 Ti"), "low"],
  [linuxNv("GeForce GTX TITAN X"), "high"],
  [linuxNv("GeForce RTX 3070"), "epic"],
  [mesa("AMD Radeon RX 580 Series", "polaris10"), "medium"],
  [mesa("AMD Radeon R7 Graphics", "kaveri"), "low"],
  [mesa("AMD Radeon HD 7700 Series", "verde"), "low"],
  ["ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)", "low"],

  // Firefox's sanitised buckets
  [firefox("NVIDIA", "NVIDIA GeForce GTX 980"), "medium"],
  [firefox("NVIDIA", "NVIDIA GeForce GTX 480"), "low"],
  [firefox("NVIDIA", "NVIDIA GeForce 8800 GTX"), "low"],
  [firefox("AMD", "Radeon R9 200 Series"), "medium"],
  [firefox("AMD", "Radeon HD 5850"), "low"],
  [firefox("AMD", "Radeon HD 3200 Graphics"), "low"],
  [firefox("Intel", "Intel(R) HD Graphics 400"), "low"],
  ["NVIDIA GeForce GTX 980, or similar", "medium"],
];

const wrong = cases.filter(([gpu, want]) => classifyGpu(gpu) !== want);
for (const [gpu, want] of wrong) console.error(`  ${gpu}\n    expected ${want}, got ${classifyGpu(gpu)}`);
assert.equal(wrong.length, 0, `${wrong.length} of ${cases.length} renderer strings classified wrong`);
console.log(`${cases.length} renderer strings classified as expected`);
