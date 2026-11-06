// POI the-murk — THE MURK: a mangrove swamp of tea-coloured water, boardwalks, stilt shacks and one giant hollow
// mangrove. Pure TS (no three.js): the ONE layout the client visuals (client/src/world/pois/the-murk) AND the
// authoritative server colliders derive from. Needs no terrain at import: every collider that meets the ground reaches
// down below the swamp bed (−2.5 m), so the heightfield decides where it disappears.
//
// Plan (world metres, +X east, −Z north; the swamp bed is ~0.3–0.6 m, pools to −1.2, the NE lagoon north of z −255):
//   · THE GREAT MANGROVE (hero landmark) at GM — a 30 m giant, its trunk HOLLOW: a root arch lets you in at water
//     level, a spiral stair climbs the hollow to THE CROW'S NEST platform at 13.35 m with the SMOKEHOUSE on it; a rope
//     bridge drops from the platform to the Stilt House roof.
//   · the boardwalk network (deck top WALK_Y) is the lane system: SOUTH WALK from the Mango Market plateau → THE
//     LANDING (junction deck) → the FISHERMAN'S SHACK porch → JETTY WALK → the lagoon DOCK; spurs to the mangrove's
//     root gate, the BAIT & TACKLE, the HERMIT'S HUT, the STILT HOUSE and the BOATHOUSE. Broken sections and step
//     ramps drop into the wadeable shallows (local water WATER_Y, drawn by the client; the sim only swims below 0).
//   · root tangles, crate stacks, a half-sunk rowboat, fallen trunks = hard cover everywhere.
import type { Box, Surface } from "../world/colliders";
import { poiById } from "../world/map";
import { toWorld, dirYaw, wallPieces, slabPieces, mulberry, type Side, type Opening, type WallPiece } from "./town-kit";
import { interiorColliders, interiorLoot, furnishRoom, itemRect, type InteriorRoom, type RoomOpening, type InteriorStyle, type RoomRole, type RoomFinish } from "./interior-kit";
import * as dmath from "../sim/dmath";

/** three.js yaw (rotation.y: local +X → world (cos, 0, −sin)) → the SIM's Box.yaw (local +X → world (cos, 0, +sin)),
 *  see shared/sim/world.ts pushOut and harbor-kit / jungle-layout `simYaw`. Every collider below goes through this. */
export const simYaw = (threeYaw: number) => -threeYaw;
/** sim box for a rect in a frame's local coords (three.js frame yaw) */
function lbox(f: { x: number; z: number; yaw: number }, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, surf: Surface): Box {
  const [cx, cz] = toWorld(f, (x0 + x1) / 2, (z0 + z1) / 2);
  return { c: [cx, (y0 + y1) / 2, cz], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], yaw: simYaw(f.yaw), surf };
}

const P = poiById("the-murk");
export const CX = P.x, CZ = P.z, R = P.r;
/** the swamp's own water surface inside the POI (visual; the sim's water level stays 0) */
export const WATER_Y = 0.78;
/** boardwalk deck top */
export const WALK_Y = 1.55;
/** colliders that meet the swamp bed reach down to here (the heightfield hides the rest) */
const BED = -2.5;

type V2 = [number, number];
type V3 = [number, number, number];
const TAU = Math.PI * 2;

// ================================================================================================ swamp bed
// @generated ground-begin (terrain hash 3139013544)
const GROUND = { x0: 466, z0: -320, step: 2, nx: 111, nz: 93, cm: "Kv86/0X/Pf8w/zn/NP9A/0b/SP9K/3r/fv93/1j/aP9v/27/bP9k/2r/Pf9G/0X/R/8//zf/PP+Y/6//u//D/9v/0f9ZAGYAfwCTAKEAtQC4AJMAdgBsAGMAZAAHAAgABACq/5f/iv/Q/9v/L/8h/yj/Jv83/97/3P/J/87/yf/P/8T/xf/D/7//Iv8T/8X/y//R/+H/9P/+/2QAYgB6AKUArQDFAMgA0wDmANIA0wDKAMQAswCeAI4AfQB4AGwAYgBbAOD/zP+R/2X/VP9K/0n/Ov8u/y//G/8X/yr/NP86/zn/Kv8t/zH/L/89/0D/P/9J/0//UP9C/zP/Qf9R/1L/R/89/0H/Q/9H/0r/Q/8//zb/Of9B/8z/y//L/9z/0P+//1sAbQBsAHQAkwCWAHoAWABcAGMACAAJAPX/9f/Z/5b/uP/g/zb/KP8n/yn/MP86/zL/Iv8U/w//C/8b/x//Hv8h/yj/If8S/8b/0//Y/9P/3P/4//z/YwBzAHIAjQCbAKEAugDEALYAqQCWAJUAjwBzAG4AXwBWAFYA0f/h/9T/mf9r/1D/Sf9H/z7/Nv8t/yf/Gv8b/yj/Q/86/zT/Kv8x/yf/LP84/z3/O/9B/0T/SP87/zT/O/9G/0r/Qf81/z3/Qv9G/z3/Mf84/zr/Q/9F/8f/1P/P/87/y//K/wQAWABXAF8AcAB3AGIAWgAJAA0AEwD//+z/8v/y/7j/7/8y/zz/NP8x/yj/Mf83/zD/Iv8c/xn/Dv8R/xv/Hf8j/yL/HP8Y/xz/1v/b/9v/2v/t/wcAYQBiAF0AcwBzAH0AlQCaAIkAcQBuAHIAdABsAGEAXQDE/8r/wv+q/6L/fv9Z/07/T/9P/0H/Q/8y/yj/I/8c/yb/Nv8s/zX/Ov80/y3/NP91/3b/eP94/4L/j/+S/z//Sf88/z7/Nv8u/zL/Qf9D/yz/K/8+/z//Sf9O/z//yP/Y/9z/sv+W/9D/BQDM/14AWgBVAFMAGAASAAIABQD7//7////3//P/M/8o/zr/Pv89/zH/Mf8s/yr/Hv8X/x//IP8V/xj/G/8T/xL/Ev8b/x//JP/Y/97/3P/t/wQACgAHAF4AXgBfAG0AfAB2AHMAXwBeAF8AYABYANX/xP+1/5j/j/+H/3n/ZP9Q/0r/PP9L/0j/Rf9A/zL/L/8k/yb/KP8q/zP/Rv9G/zr/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Fv8c/xf/IP8V/wn/EP8H/wv/Dv8W/w//Cv8U/xX/D/8P/xj/B//u/vX+BP/9/gX/Af8G/w7/HP8o/yz/Lf8r/y//Nf86/zn/Pf8u/y7/Lf8v/zf/Qv9N/1D/P/80/zb/GAAdADYAQAAxAC0AMAAxACoAGQAIAAYAFAAQAAYA1/+t/+X/5f/l/9f/E/8R/xb/Z/9i/2X/jv+c/43/jf+c/3L/O/84/zH/P/9B/0r/4f/b/+L/8f/+/wgAAQAEAAAADgBI/zn/OP8y/zH/Lv87/zT/Jf8Z/xL/D/8O/xT/FP8i/yH/Iv8j/w//CP8C/wz/EP8T/xP/Ev8c/xv/If8k/yX/JP8P/wP/CP/+/g3/Gf8X/x3/Kv81/z3/Mf8q/zD/Mf89/z3/RP89/zf/Mf8v/zv/TP9U/0j/OwA5ADEAKAAmADcAOwAzAC4AMwAsACMAFAD///L/3P/w/xAAvv/R/+n/7v/t/+v/2v/I/3n/b/92/3j/fP+v/6b/o//D/5//OP8y/zT/P/89/zr/Q//f/+H/8/8EAAkA/f///wAASv9D/zn/M/8u/zT/Jv8s/yj/Jf8i/xb/Ff8X/xL/Ff8W/w7/Ef8d/xb/Ef8L/wz/F/8h/xj/JP8l/yP/Lf8x/yb/LP8w/xz/Ff8Q/xX/JP8j/x//IP8l/zX/L/8w/zD/LP9B/z//Qv9B/0P/Q/85/zr/pv+s/+z/3//i/yIAMgAvADgAMwAvAC8ANAAoABsAAwDZ/8r/pv/S/xIACAAKAAMA9//L/+z/4v/Z/9P/fP+H/43/hv+9/7//wf/q/+f/JP8l/zP/PP9A/0H/NP84/z3/Qf9G/0r/N/80/zj/PP86/y3/L/82/zX/K/8j/yb/L/8r/yH/JP8c/xj/F/8W/wb/A/8O/xj/Ff8Y/xn/Fv8m/yb/Kf8o/yz/Mv8t/y3/NP82/zT/Hv8X/yH/Kf80/yr/If8o/zf/N/86/zj/N/89/z//Rf9F/0z/Sf+q/6v/nv+i/67/q/+l/77/JgAvADcAKwAyADUALQAjABcA0P+v/8r/qf+2/xAAIgAmANX//f/e/5r/4//V/93/kf+i/6v/rP/k/8H/v/++/+z/Lf8i/y3/Qf89/zn/Mv8w/zn/OP9I/zv/L/80/zj/M/87/zT/Lv84/zz/Nf8s/yb/KP8t/yP/Jf8k/xP/Dv8T/xX/Ef8T/xX/G/8g/yH/Jf8v/zH/Kv8m/yv/M/80/yX/KP8x/zX/Nv8o/yj/K/8y/yj/Iv8t/zn/Pv9C/0X/Q/84/z3/RP9H/ysAs/+n/77/t/+0/7T/qf+w/7j/KQAiACYAHwAkACoAIwASACAAFADH/6f/s/+w/w0A///B/7//wv/J/7f/7//5//3/+v8FAOn/+P/y/wEAAADr//n/Nv8j/yX/Mv83/zb/Ov87/0n/PP8//zb/N/82/zX/Of8//zT/Nv80/zL/OP8z/yP/Jf8t/yT/H/8j/w7/Bv8W/x3/F/8Y/xv/LP8o/yL/Kf8x/zf/LP8k/yn/N/9D/zT/JP8r/zX/Q/8y/zP/LP8i/yL/KP89/zv/Pf86/zv/OP82/z3/JwAiACQA9f+q/7//x//D/83/tv/A/8n/MgArAB0AJAAnACAAJwAZABkAGQCw/6//yf+3/6f/rv+9/87/x//5/xMAAgAJABMAGQAWAC0ANgArACYAJwABAPn/Nf8w/zL/Mf86/0D/Qf9E/0T/Of87/zv/Of85/zv/Nv8v/zH/Lf8Y/xL/IP8n/x7/Hf8r/yj/F/8X/wL/CP8V/yP/Jf8n/yv/Kv8f/yD/Iv8n/zb/Nv80/yz/NP9C/zv/J/8z/zP/Rv9F/zj/MP8v/yr/P/9D/zT/MP8z/zj/Mv8rABUAHQAkACcA8/+n/7X/xP/m/9b/wv+//7r/2f8TABQAGgA4ADQAJQAYABkAHQDB/8b/yf+//63/t//C/8D/vP8kACYAIAAhACoAMgAyADsAPgA5ADMALwAoACIAKf8u/yX/Kv8+/z7/QP9D/zT/Jv8p/zX/Of85/y7/Gv8Y/xv/D/8E/wD//f4B/wT/Fv8j/yL/Fv8J/wT/D/8Y/xT/GP8m/zL/L/8f/xv/Iv8n/zX/Of87/z3/OP81/zf/Lf81/z//TP9H/zH/L/88/0H/Sv9C/zr/Mv80/0H/JQAiACMAKwAxAAcAtv+s/7D/vP8mADUAMwDu/8n/0v+//7f/MwA5AD8AJwAeACYA/f+7/8T/wv/e/8D/0f/E/7f/5f8xADUAKQAjACEAMAA7AD8AOgAzADoAOQAyAC8AFP8Y/xX/Hf80/zb/OP80/yf/HP8g/yz/Mf8n/xL/B/8B/wL/B/8E//z+8v7n/ub++f4J/xf/Ev8F/wr/Gf8Z/xX/Gv8f/yX/HP8Y/x7/Kf8h/zL/Nv88/0P/RP8+/zT/N/86/0D/Rv82/yz/Lf89/0D/Qv9J/z//OP8x/zQAGwAmADEAOQAdAPj/wv+7/7H/rv/v/ykAMgDp/8P/vP+5/wYAIQAuADoAMgArACkA0f/C/7v/5P8rAC0AJADb/8P/u/8qADoAOQArACYALwA1ADkANwA1ADwARgBCADYAEP8a/xL/Ff8n/yr/Lf8v/yb/Jf8m/yP/JP8X/wr/D/8A/wX/DP8L/wH/+P7o/uX+9f4C/xb/D/8B/wv/J/8i/yH/Hv8k/yr/H/8h/y7/P/88/zP/M/88/1D/Uf9C/0T/Tv9E/0L/Pv8//z7/PP84/y7/M/9D/03/Ov8gABsAFQAoAD8APQA3ADgA9f/E/7v/rv+//xwAOAAzAB4Ax/8LAB0AHAAnAC4AMQA7ADsAy//A/7z/xP8PAOv/zv/A/73/vv8pAD8ANwAxADIAMgAsADMAOQA8AEYAUgBNAEoAIf8m/yD/F/8f/zf/N/8w/yn/L/8u/yv/Iv8h/xP/GP8W/xX/D/8Q/wH/A//y/uv+9f4G/xn/JP8M/wr/G/8e/yP/Jf8g/yL/G/8x/zz/Ov85/zT/NP8r/z//R/9G/yIAGQAgADMAMAAlABwAHwAeAD3/Of9K/0//NAAoABoAHAAuAD0ANgA6AOf/9v/6/8X/rv+x//v/PAA8ACcAwP8XACUAJAAiACQAIwAuADUAwv+o/6r/m/+k/6n/t//G/8L/yP8yAD8AOgAxADAAMAAuADgAPwBEAEYAUQBPAFAAKv8q/yn/JP8i/zX/Qf8w/yb/Kv81/zn/M/8k/yL/G/8a/xz/Gv8S/wL/Bv/9/v3+Av8L/xr/Kf8g/xH/Ev8d/yf/KP8l/yT/J/8w/zT/O/81/z3/N/8z/zn/HgAsACMAFQAWADUANQAtACgAKgAkACAAIQArADIAKgAgACAAKQAqADUAQQA6ABoALgAkABgA+P8kACYALAA3AD0APQAxADYANQAwAB0AHQArACkAu/+a/53/rv+5/67/r//C/8n/0v88AEYAPgAzADMANQAFAC8ARQBIAEMARABJAE0ANv8w/yT/HP8m/zX/OP8p/yD/J/8z/zn/Pf8v/yv/Iv8j/yf/Lv8V/wP/B/8O/xD/Ev8M/xj/K/8n/x//GP8i/yj/OP81/zT/L/8q/yr/MP88/z//Ov87/8D/JwAyAC0AJwAfAEEAPgA0ACgAKgApABwAGAApADEALAAhABkAFwAZADEAPQAfACAAGwAdACAAFAAbACsAKgAyADYAOgA7ADwAOgA+ACkAIwAsACUA5/+c/6r/wf/B/7v/uP+z/9X/8f84AEMAQgA9ADYAMQAHAC8AQwBMAEYARQBFAEkANv84/zD/J/8p/zL/Kv8t/yr/Kv8z/zv/OP83/y7/Kv8o/yn/K/8b/xr/G/8c/xD/F/8O/xv/Lf8p/x//IP8t/yr/M/89/zz/M/8w/y7/Of8//0H/Rv+r/63/1/87ADIALQAjADEANwA/AC0AMgAmABcAIAA5ADcALQAoACIAHwAZACcAMQAjAB0AHgATAK//vP/K/9b/IwAtACYALQAxADAAOwA+ADcAMAAtADMAHACy/7T/sP/A/9H/vf+l/7r/JAA5AD8AQwA4ADEAJQDj//b/LABDAE0ATQBPAEsALv8m/yD/IP8g/yL/KP8w/y3/Lf85/z7/Ov85/yL/H/8h/y3/Lf8q/yX/J/8j/xf/F/8W/yH/Kv8x/yf/L/80/zD/K/82/zX/Pf85/zn/O/9G/0UAKAC7/7T/GgA9ADYAOgAzADQAQgBAADEAOQAtABMAGgArADUALQAmAC4AKwAjACsAJwAXAB4AKADQ/7r/u/+4/6//IgAvAB8AIAAsADgAQgA6ADMAOQA0AC4A2f+0/6//o/++/8n/vf+q/7X/EQAyAEEARQA/AD4AMgDj/9r/KQBCAFQATwBMAE4AGv8T/xn/Gf8X/xr/Hf8b/yT/K/83/0f/QP8x/y7/J/8s/zf/Qv87/zX/Lv8d/xP/Ef8Y/yj/LP8o/yr/Mv8w/yT/Gv8p/zT/Ov89/0D/P/8nAEEAKQAIADAAHgAqACQALQA1ADYAQAAxADgASQBGACwAHQAjACMAKwAkADYAPwAyACwAHAAbACcALQANAK3/p/+i/6f/FQAqACkAJQAsADkAQAA2AC8AKgApALv/rf+n/6b/of+t/7r/uv+s/7f//f8nADYARQBKAEcAKADu/93/LwA+AEoATwBPAFEACP8P/xn/IP8d/xz/Gv8W/yT/Lv81/0H/Pf84/z3/NP8t/yz/Lv8w/zX/L/8k/xX/G/8k/x7/KP8j/x//If8i/yH/HP8m/zf/P/9F/0f/JwAfADcA+/8wACQAHQAgACMAKAAgAB8AKAAtADoA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DgD+/wEABwAFABAANQBAAGcAgwCKAJcAmgCPAIYAbgBQAFAADAD+/zwAUgBCADoAOQArABkAx//B/7v/w/+4/8X/+P8TANL/rP+y/7r/xP/H/w4ABAAtADQAOwA2ADMAJgArAC4AKQAvADYAOgA2ACcAEQDK/6X/r/+x/7L/yf/Q/6//sP/T/z0AUgBhAGAAXgBvAIQAaABUAGsApwDKAPIADAEcATYBVAFqAY8BugHkARECLAJYAnkCowLTAgQD/QHjAcgBqwGVAXUBUAErAQcB5ADSALkAnABPADMANQB/AGkAawBXAGcAiAB7AJQAoACvALYAsQCiAJkAjACKAGYAIAAOAC0AWwBUAFQAOwAtAPT/yP/P/8j/yf/G/7v/FwArAAQApf+7/8z/zv8JABsAIAAmAC0AMwA1ADAAIQAfACYAJAAuADcAOAAwACgAAgC9/6f/v/+5/7n/v//G/8L/wf8kAEgAVQBjAGMAbAB/AI8AogCsAL0AxwDmAA0BJAExAU0BZQGBAaoB0wHwARcCSQJqAoUCuwL7AjIDLwIXAvwB4gHFAaYBfQFSATYBFwH/AOsA0wCjAI0AtAC1AJgAVQBnAKEAuwB+ANIA2wDeANcAzAC9ALQArACgAF0ALwAmABcAZgBpAGkAQgAJALr/wP/N/8j/xf/O/7n/LAA+ADEAFQDI/+P///8fABkAHgAeACYALQA5AC0AIgAmACUAHwAqADoAOwAzADEAJgDW/6D/uv/F/83/+v/g/9L/BwBAAF0AagBwAG4AdgCEAJsAtADIANgA5QD+ACMBNgE+AVcBcgGZAb4B3gHiAQ4CXgJ3Ap4CzwILA0wDXgJFAjACFgL1AdIBrQGGAWYBRgEtARsBCQH3AO8A6ADjAMYAiwChAOMABgELAQ0BEwEMAQQB8wDoAOAA2gDHAIQAUQBEAEEAggCCAGkALwDd/8v/xf/I/7//rv+1/7b/EwA/ADUAIAAlACgAIAAQABQAHwAZACIAJwAzADIAJgAoACUAHQAlADwARAA+AD0AOAAsACcAKAAVAEMAQwBLACgAQgBTAGUAfAB5AHkAjACbAKsAvQDOAN8A9QALASkBQgFRAWwBiwGwAdcB9AHyARoCYgKcAsEC8wIjA14DjAJ2AmACRQIkAgAC3QG9AZoBewFkAU8BPQE2ASwBGwEcAREB2wAGATkBRAFBAUABPAE2AS0BHQEXAQ4BAAHkAJsAjgB7ALYAngCeAIcANwDc/8H/vv/A/9r/+P/B//7/KwAtACAAHwAtADAAHgATAB4AGgAEADEAMQAzACwAJwAlAB0AGwAnADcANwA5ADsAQwA9ADMAPQBOAFIAVQBaAFkAXABmAHUAggCCAIMAmwCvAL4AywDkAPIA/AASASsBUAFpAYgBqAHFAeoB7wH+AScCYAKpAvICGANLA30DuwKlAowCcAJRAjMCEwL1AdQBuAGmAY4BgAF1AWcBXAFHAUsBaAF1AXcBdgFyAW0BawFqAV0BUAFLAUMBMgESAeIA2ADMAOAAvgCvAIsAXwAoAMP/yf/e/9L/FADi/w4AJwAhABoAHwA1AD0AMAAmACwADADn/wsAAwAYACwAKwAiACIALgAxAC8AMQA1ADgARAA8ADcARwBSAFsAZgBoAGAAZgBtAH8AigCYAH4AoQC7AM8A4QD5AAUBEAEkATwBZAGDAaEBvwHmAf4BCgITAjECawK1Av4CNwN2A68D5ALPArYCmgJ/AmQCQAIjAg8C9AHiAdEBxAG4Aa8BqQGsAbABswG3AbYBsgGvAaYBoAGdAZcBjgGBAW8BYwE/AekAAAEGAeAA4AC3AJUAfQBdAPL/yf/E/8H/zv+7/8H/IQApACkAIgA1AD8ANQArACAA7v+7/7L/tv/w/wMA4v8hADUAPAA3ADcANAAyAEEASQBEAEIASABTAGUAbwBtAHUAgACIAJEAnwCoAKQApwDJAOIA8QAJAR0BLAE5AU8BbwGQAbUB0AH2ARgCJgJFAkwCgALIAhEDVAOTA9YDBwPqAtICvAKlAosCbwJbAkwCNQIiAhICBgL/AfoB+QH5AfkB9wH2AfQB8QHyAecB3QHSAc0BwAGuAaIBlQF3AR0BLgEuAQYB8QDMAKoAkgB7AE0A2P/I/73/rf+6//7/IgA1ADcAKgAtADEAKAAaABMAsf+u/6z/pP/X////yv8OADAAPQBJAEgALgAqAEEAUwBUAFEATQBfAHIAdwCEAJIAlgCjAK0ApACiAKAAiQDNAOUA1QAKASABOAFEAWABgAGcAcEB4gEFAh8CPAJqAoMCnwLjAigDbwO6AwQE" };
// @generated ground-end
let groundGrid: Int16Array | null = null;
function decodeB64(s: string): Uint8Array {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let o = 0;
  for (let i = 0; i + 3 < s.length; i += 4) {
    const n = (A.indexOf(s[i]) << 18) | (A.indexOf(s[i + 1]) << 12) | ((s[i + 2] === "=" ? 0 : A.indexOf(s[i + 2])) << 6) | (s[i + 3] === "=" ? 0 : A.indexOf(s[i + 3]));
    out[o++] = (n >> 16) & 255; if (s[i + 2] !== "=") out[o++] = (n >> 8) & 255; if (s[i + 3] !== "=") out[o++] = n & 255;
  }
  return out.subarray(0, o);
}
/** the terrain height under the swamp (baked, bilinear, ±2 cm of Terrain.height at the grid posts) */
export function groundAt(x: number, z: number): number {
  if (!groundGrid) { const u8 = decodeB64(GROUND.cm); groundGrid = new Int16Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)); }
  if (!GROUND.nx) return 0.4;
  const fx = Math.max(0, Math.min(GROUND.nx - 1.001, (x - GROUND.x0) / GROUND.step)), fz = Math.max(0, Math.min(GROUND.nz - 1.001, (z - GROUND.z0) / GROUND.step));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, g = groundGrid, n = GROUND.nx;
  const h = (g[j * n + i] * (1 - u) + g[j * n + i + 1] * u) * (1 - v) + (g[(j + 1) * n + i] * (1 - u) + g[(j + 1) * n + i + 1] * u) * v;
  return h / 100;
}

// ================================================================================================ swamp surface + silt shelf
// ONE definition for the client's drawn tea surface (water.ts samples it at its grid posts) and the sim's floor: the
// surface is WATER_Y over the swamp, easing down to the sea where the swamp meets the deep NE lagoon; wherever the
// terrain bed lies deeper than MAX_DEPTH under it, a SILT SHELF (drawn by water.ts, collided here) fills the pool, so a
// wading kong always shows ≥ 1.18 m standing / ≥ 0.58 m crouched above the tea (no hidden-under-the-water exploit).
/** the drawn surface's grid (client water.ts) */
export const SURF = { x0: 468, x1: 684, z0: -292, z1: -134, step: 2 };
/** the deepest wading depth under the plateau surface (the shelf top = WATER_Y − MAX_DEPTH, above the sea plane at 0) */
export const MAX_DEPTH = 0.72;
export const FILL_Y = WATER_Y - MAX_DEPTH;
let surfGrid: Float32Array | null = null;
const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function surfaceGrid(): Float32Array {
  if (surfGrid) return surfGrid;
  const { x0, x1, z0, z1, step } = SURF, nx = Math.round((x1 - x0) / step) + 1, nz = Math.round((z1 - z0) / step) + 1;
  // distance (m) to deep lagoon water (bed < −1.3): two-pass chamfer transform
  const D = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) D[j * nx + i] = groundAt(x0 + i * step, z0 + j * step) < -1.3 ? 0 : 1e6;
  const d1 = step, d2 = step * Math.SQRT2;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (i > 0) D[k] = Math.min(D[k], D[k - 1] + d1);
    if (j > 0) { D[k] = Math.min(D[k], D[k - nx] + d1); if (i > 0) D[k] = Math.min(D[k], D[k - nx - 1] + d2); if (i < nx - 1) D[k] = Math.min(D[k], D[k - nx + 1] + d2); }
  }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    if (i < nx - 1) D[k] = Math.min(D[k], D[k + 1] + d1);
    if (j < nz - 1) { D[k] = Math.min(D[k], D[k + nx] + d1); if (i < nx - 1) D[k] = Math.min(D[k], D[k + nx + 1] + d2); if (i > 0) D[k] = Math.min(D[k], D[k + nx - 1] + d2); }
  }
  // WATER_Y in the swamp; down to ~0.04 at the lagoon edge; lower toward the grid border (the outer swamp dries into
  // mud flats instead of ending on a straight line)
  const L = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, edge = Math.min(i, j, nx - 1 - i, nz - 1 - j) * step, lag = sstep(3, 26, D[k]);
    L[k] = 0.04 + (WATER_Y - 0.04) * lag - 0.3 * (1 - sstep(0, 26, edge)) * lag;
  }
  return (surfGrid = L);
}
/** the drawn swamp surface height at (x, z) (bilinear over SURF's posts; exact at the posts) */
export function murkSurface(x: number, z: number): number {
  const L = surfaceGrid(), { x0, z0, step } = SURF, nx = Math.round((SURF.x1 - x0) / step) + 1, nz = Math.round((SURF.z1 - z0) / step) + 1;
  const fi = Math.max(0, Math.min(nx - 1.001, (x - x0) / step)), fj = Math.max(0, Math.min(nz - 1.001, (z - z0) / step));
  const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
  return (L[j * nx + i] * (1 - u) + L[j * nx + i + 1] * u) * (1 - v) + (L[(j + 1) * nx + i] * (1 - u) + L[(j + 1) * nx + i + 1] * u) * v;
}
/** the silt shelf's top at (x, z) — −Infinity outside the drawn swamp (the lagoon keeps its real bed) */
export function shelfTop(x: number, z: number): number {
  if (x < SURF.x0 || x > SURF.x1 || z < SURF.z0 || z > SURF.z1) return -Infinity;
  const s = murkSurface(x, z);
  // (flat FILL_Y under the plateau surface; toward the lagoon it eases down with the surface, continuously)
  // where the tea hands over to the lagoon (surface ≈ the sea), the shelf keeps the wading depth ≤ ~0.7 m under the
  // sea's murky water too, until the bed drops into swimming depth (a swimmer is at the surface — never hidden)
  if (s < 0.1) return groundAt(x, z) > -1.75 ? Math.max(s, 0) - MAX_DEPTH : -Infinity;
  return s - MAX_DEPTH + (FILL_Y - s + MAX_DEPTH) * Math.min(1, Math.max(0, (s - 0.1) / 0.5));
}
/** the walkable swamp floor: the terrain bed or the silt shelf over it */
export const bedAt = (x: number, z: number) => Math.max(groundAt(x, z), shelfTop(x, z));

// ================================================================================================ types
/** a plank deck / walkway (local +z along its length, local +x = its left when walking +z) */
export interface MDeck {
  x: number; z: number; yaw: number; w: number; d: number; y: number;
  /** rope rails on local −x / +x sides and on the −z / +z ends; each a list of [u0, u1] spans (m along the side, from
   *  its −z / −x end) or true = the whole side */
  rails?: { nx?: boolean | V2[]; px?: boolean | V2[]; nz?: boolean | V2[]; pz?: boolean | V2[] };
  /** planks run along local z (walkways) or x */
  planksZ?: boolean;
  /** broken: visual missing planks / sag (no collision change) */
  worn?: number;
  /** pile spacing override (visual) */
  pile?: number;
  /** no piles (sits on something else) */
  noPiles?: boolean;
  kind?: "walk" | "deck" | "dock" | "porch";
}
/** a straight flight of steps going DOWN from (x, z) at yTop along (dx, dz) to yBot; `solid` treads reach the bed */
export interface Flight { x: number; z: number; dx: number; dz: number; w: number; yTop: number; yBot: number; n: number; tread: number; solid: boolean; rails?: boolean }
export interface HutOpening { side: Side; u: number; w: number; y: number; h: number; floor: number; kind: "door" | "window" | "hatch" | "wide" }
export interface Furn { keep?: boolean; kind: "table" | "stool" | "bed" | "shelf" | "counter" | "stove" | "crate" | "barrel" | "netpile" | "chest" | "rack" | "tank" | "workbench" | "bunk" | "locker" | "firepit" | "sacks" | "boat"; x: number; z: number; y: number; yaw: number; w: number; h: number; d: number; col?: boolean }
export interface Hut {
  id: string; label: string;
  x: number; z: number; yaw: number; y: number;
  /** outer footprint (local x = w, local z = d; front = +z) */
  w: number; d: number;
  floors: number; floorH: number; t: number;
  roof: "gable" | "flat" | "shed";
  /** rise per metre of run; gable ridge along local x */
  pitch: number; overhang: number;
  openings: HutOpening[];
  /** interior flights (local): start (x, z) at floor f, running along +x (dir 1) or −x (dir −1) against the back wall */
  stairs: Array<{ x: number; z: number; dir: 1 | -1; floor: number; w: number; toRoof?: boolean }>;
  /** partial upper floor (boathouse loft): local z range, height above y */
  loft?: { z0: number; z1: number; h: number };
  /** a shed roof over the front porch on posts (flat-roof huts): depth out from the front wall, width along it */
  porchRoof?: { depth: number; w: number; shift?: number };
  /** hole in the ground floor (boathouse slip), local rect */
  slip?: { x0: number; z0: number; x1: number; z1: number };
  furniture: Furn[];
  /** tints */
  wall: string; trim: string; roofCol: string; door: string;
  surf?: Surface;
  seed: number;
}
export interface HutParts {
  h: Hut; H: number;
  walls: Array<{ side: Side; A: V2; B: V2; len: number; dir: V2; n: V2; pieces: WallPiece[][]; openings: Opening[][] }>;
  slabs: Array<{ rects: Array<[number, number, number, number]>; y: number; t: number; floor: number; roof?: boolean }>;
  flights: Array<{ x: number; z: number; dir: 1 | -1; w: number; y0: number; rise: number; n: number; tread: number }>;
  /** roof: y at the wall line (eave plane), ridge y, tip y (overhang edge) */
  roofY: number; ridgeY: number; tipY: number;
}
/** a root / trunk-limb tube: polyline + radius at its start / end */
export interface Root { pts: V3[]; r0: number; r1: number; kind: "prop" | "buttress" | "tangle" | "knee" | "limb" | "log" | "aerial" | "trunk" }
export interface MProp { kind: "stack" | "cupola" | "crates" | "barrel" | "drum" | "trap" | "netrack" | "lantern" | "post" | "sign" | "rowboat" | "canoe" | "logpile" | "buoy" | "lilies" | "reeds" | "stump" | "chest" | "chimney"; x: number; y: number; z: number; yaw: number; s?: number; v?: number; h?: number }
export interface Plant { kind: "jungle-tree" | "mangrove" | "monstera" | "fern" | "banana-plant" | "bush" | "vine" | "palm-leaning"; x: number; z: number; yaw: number; s: number; y?: number }

// ================================================================================================ helpers
const walkDeck = (a: V2, b: V2, w = 2.4, y = WALK_Y, extra: Partial<MDeck> = {}): MDeck => {
  const dx = b[0] - a[0], dz = b[1] - a[1], d = dmath.hypot(dx, dz);
  return { x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, yaw: dmath.atan2(dx, dz), w, d, y, planksZ: false, rails: { nx: true, px: true }, kind: "walk", ...extra };
};
/** point on a deck in its local frame */
const deckPt = (k: { x: number; z: number; yaw: number }, lx: number, lz: number): V2 => toWorld(k, lx, lz);

// ================================================================================================ the great mangrove
/** hero trunk: centre, base ground, hollow interior, spiral stair, platform */
export const GM = {
  x: 582, z: -218,
  /** interior plank floor inside the hollow (= the root-gate deck) */
  floorY: 1.32,
  /** THE CROW'S NEST platform deck top */
  platY: 13.35,
  /** platform half extents (world-axis square) */
  platH: 6.6,
  /** trunk hollow up to here (a plank ceiling closes it just under the platform exit's lintel) */
  hollowTop: 16.2,
  wallT: 0.72,
  /** entrance arch: world angle (atan2 dz, dx), half-width (rad), height above floorY */
  inA: dmath.atan2(-0.32, -0.95), inHalf: 0.36, inH: 3.3,
  /** platform exit door in the trunk wall (angle, half-width) */
  outA: dmath.atan2(0.15, 0.99), outHalf: 0.42,
  /** knot-hole window (angle, y range) — a sniper nook on the spiral */
  winA: dmath.atan2(0.9, -0.43), winHalf: 0.3, winY0: 7.6, winY1: 8.8,
  /** spiral: steps per turn (12 → 2.8 m per turn: head room under the turn above) */
  perTurn: 12,
};
// the spiral starts right beside the entrance and climbs counter-clockwise (+angle); the platform exit door and the
// knot window are placed where the flight actually arrives / passes (derived, not guessed)
const SP_N = Math.round((GM.platY - GM.floorY) / 0.235), SP_DA = TAU / GM.perTurn, SP_A1 = GM.inA + GM.inHalf + SP_DA * 0.55;
{
  const wrap = (a: number) => dmath.atan2(dmath.sin(a), dmath.cos(a));
  GM.outA = wrap(SP_A1 + (SP_N - 1) * SP_DA + SP_DA * 0.62);
  const dy = (GM.platY - GM.floorY) / SP_N, iw = Math.round((8.2 - GM.floorY) / dy);
  GM.winA = wrap(SP_A1 + (iw - 1) * SP_DA + SP_DA * 0.5);
}
/** outer trunk radius at height y (base flare → waist → fork) */
export function gmRadius(y: number): number {
  // (a massive flared foot — the buttress mass is solid trunk, no pockets between buttresses — then the waist, the fork)
  const k = [[-1.5, 8.4], [0.3, 7.0], [1.2, 5.8], [2.5, 4.6], [4, 3.85], [6, 3.35], [9, 3.05], [13, 2.85], [16.5, 2.7], [19, 2.35], [22, 1.8]];
  if (y <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (y <= k[i][0]) { const t = (y - k[i - 1][0]) / (k[i][0] - k[i - 1][0]); return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * (t * t * (3 - 2 * t)); }
  return k[k.length - 1][1];
}
/** hollow radius: the wall is ≥ wallT thick, the hollow never wider than ~3 m (the flare is solid) */
export const gmInner = (y: number) => Math.min(gmRadius(y) - GM.wallT, 2.95 - 0.02 * Math.max(0, y - GM.floorY));
const angDiff = (a: number, b: number) => { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };
/** is the trunk wall open at (angle a, height y)? — entrance arch, platform exit door, knot window */
export function gmOpen(a: number, y: number): boolean {
  if (Math.abs(angDiff(a, GM.inA)) < GM.inHalf && y < GM.floorY + GM.inH) return true;
  if (Math.abs(angDiff(a, GM.outA)) < GM.outHalf && y > GM.platY - 0.05 && y < GM.platY + 2.5) return true;
  if (Math.abs(angDiff(a, GM.winA)) < GM.winHalf && y > GM.winY0 && y < GM.winY1) return true;
  return false;
}
/** spiral steps: tread top y, angle (centre), inner / outer radius */
export interface SpiralStep { y: number; a: number; r0: number; r1: number; da: number }
export function gmSpiral(): SpiralStep[] {
  const out: SpiralStep[] = [];
  const n = SP_N, dy = (GM.platY - GM.floorY) / n, da = SP_DA;
  for (let i = 1; i <= n; i++) {
    const y = GM.floorY + i * dy;
    out.push({ y, a: SP_A1 + (i - 1) * da, r0: 0.5, r1: gmInner(y) - 0.08, da });
  }
  return out;
}

// ================================================================================================ huts
function hut(o: Omit<Hut, "t" | "openings" | "stairs" | "furniture" | "seed"> & Partial<Hut>): Hut {
  return { t: 0.2, openings: [], stairs: [], furniture: [], seed: Math.round(o.x * 13 + o.z * 7), ...o } as Hut;
}
const door = (side: Side, u: number, floor = 0, w = 1.6, h = 2.55): HutOpening => ({ side, u, w, y: 0, h, floor, kind: "door" });
const win = (side: Side, u: number, floor = 0, w = 1.25, h = 1.15, y = 1.05): HutOpening => ({ side, u, w, y, h, floor, kind: "window" });

/** the slab holes over a hut's interior flights (hut-local): from where the head would hit (rise > ~0.9 m) to the top
 *  + 0.25 (the hole starts 10 % up the run and is 0.35 m wider than the flight on each side) */
export function stairHoles(h: Hut): Array<{ floor: number; x0: number; z0: number; x1: number; z1: number }> {
  return h.stairs.map((s) => {
    const rise = h.loft && h.floors === 1 ? h.loft.h : h.floorH, run = Math.round(rise / 0.2) * 0.27;
    const xa = s.x - s.dir * 0.1, xb = s.x + s.dir * (run + 0.25);
    return { floor: s.floor + 1, x0: Math.min(xa, xb), z0: s.z - s.w / 2 - 0.35, x1: Math.max(xa, xb), z1: s.z + s.w / 2 + 0.35 };
  });
}
export function resolveHut(h: Hut): HutParts {
  const { w, d, t, floorH } = h;
  const H = h.floors * floorH;
  const SIDES: Array<{ A: V2; B: V2; dir: V2; n: V2; len: number }> = [
    { A: [-w / 2, d / 2], B: [w / 2, d / 2], dir: [1, 0], n: [0, 1], len: w },
    { A: [w / 2, d / 2], B: [w / 2, -d / 2], dir: [0, -1], n: [1, 0], len: d },
    { A: [w / 2, -d / 2], B: [-w / 2, -d / 2], dir: [-1, 0], n: [0, -1], len: w },
    { A: [-w / 2, -d / 2], B: [-w / 2, d / 2], dir: [0, 1], n: [-1, 0], len: d },
  ];
  const walls: HutParts["walls"] = SIDES.map((S, si) => {
    const pieces: WallPiece[][] = [], openings: Opening[][] = [];
    for (let f = 0; f < h.floors; f++) {
      const ops: Opening[] = h.openings.filter((o) => o.side === si && o.floor === f).map((o) => ({ u: o.u, w: o.w, y: o.y, h: o.h, kind: o.kind === "door" || o.kind === "wide" ? "door" : "window" }));
      openings.push(ops);
      pieces.push(wallPieces(S.len, floorH, ops));
    }
    return { side: si as Side, A: S.A, B: S.B, len: S.len, dir: S.dir, n: S.n, pieces, openings };
  });
  // interior flights: 0.2 m risers, 0.27 m treads
  const flights: HutParts["flights"] = [];
  for (const s of h.stairs) {
    const rise = h.loft && h.floors === 1 ? h.loft.h : floorH, n = Math.round(rise / 0.2), tread = 0.27;
    const y0 = h.y + s.floor * floorH;
    flights.push({ x: s.x, z: s.z, dir: s.dir, w: s.w, y0, rise, n, tread });
  }
  const holes = stairHoles(h);
  const slabs: HutParts["slabs"] = [];
  for (let f = 0; f <= h.floors; f++) {
    if (f === h.floors && h.roof !== "flat") break;
    const y = h.y + f * floorH;
    let rects = slabPieces(-w / 2, -d / 2, w / 2, d / 2, holes.filter((q) => q.floor === f));
    if (f === 0 && h.slip) rects = rects.flatMap((r) => slabPieces(r[0], r[1], r[2], r[3], [h.slip!]));
    slabs.push({ rects, y, t: f === 0 ? 0.25 : 0.24, floor: f, roof: f === h.floors });
  }
  if (h.loft) {
    const yl = h.y + h.loft.h;
    const lh = holes.filter((q) => q.floor === 1);
    slabs.push({ rects: slabPieces(-w / 2 + t, h.loft.z0, w / 2 - t, h.loft.z1, lh), y: yl, t: 0.22, floor: 1 });
  }
  const roofY = h.y + H + 0.08;
  const run = h.roof === "gable" ? d / 2 : d;
  const ridgeY = h.roof === "flat" ? roofY : roofY + h.pitch * run;
  const tipY = h.roof === "flat" ? roofY : roofY - h.pitch * h.overhang;
  return { h, H, walls, slabs, flights, roofY, ridgeY, tipY };
}

/** porch roof: local frame numbers — wall-side top y, outer edge y, post positions (local x, z) */
export function porchRoofParts(p: HutParts) {
  const h = p.h, pr = h.porchRoof!;
  const y0 = h.y + 2.5, y1 = h.y + 2.2, z0 = h.d / 2, z1 = h.d / 2 + pr.depth, sh = pr.shift ?? 0;
  const posts: V2[] = [];
  const n = Math.max(2, Math.round(pr.w / 2.6));
  for (let i = 0; i <= n; i++) posts.push([sh - pr.w / 2 + 0.15 + (pr.w - 0.3) * i / n, z1 - 0.15]);
  return { y0, y1, z0, z1, sh, w: pr.w, posts };
}

/** roof plane height at local z (gable: symmetric about z 0; shed: high at the back −z) */
export function roofAt(p: HutParts, lz: number): number {
  const h = p.h;
  if (h.roof === "flat") return p.roofY;
  if (h.roof === "gable") return p.roofY + h.pitch * (h.d / 2 - Math.abs(lz));
  return p.roofY + h.pitch * (h.d / 2 - lz);
}

// ================================================================================================ layout
export interface MurkLayout {
  decks: MDeck[];
  flights: Flight[];
  huts: Hut[];
  parts: HutParts[];
  roots: Root[];
  props: MProp[];
  plants: Plant[];
  bridge: { a: V3; b: V3; w: number; sag: number; n: number };
  spiral: SpiralStep[];
  /** mooring lines / hanging ropes (visual) */
  ropes: Array<{ a: V3; b: V3; sag: number }>;
  /** fireflies / moss / mist anchors (visual) */
  moss: Array<{ x: number; y: number; z: number; len: number; w: number }>;
  /** canopy trees (their trunks / roots / limbs are in `roots`) and the leaf-mass lobes the client draws */
  trees: Array<{ x: number; z: number; top: V3; s: number }>;
  /** root-cage fillers (noShoot): nobody wedges between the arches of a root cage; bullets pass the gaps */
  cages: Array<{ x: number; z: number; r: number; y0: number; y1: number; rt?: number }>;
  canopies: Array<{ c: V3; r: number }>;
}

function genLayout(): MurkLayout {
  const rng = mulberry(0x6d75726b);
  const decks: MDeck[] = [], flights: Flight[] = [], huts: Hut[] = [], roots: Root[] = [], props: MProp[] = [], plants: Plant[] = [];
  const ropes: MurkLayout["ropes"] = [], moss: MurkLayout["moss"] = [];
  /** crown lobes placed before the canopy pass (the buttress giant) */
  const canopiesPre: MurkLayout["canopies"] = [];
  const cagesPre: MurkLayout["cages"] = [];

  // ---------------------------------------------------------------- buildings
  // 1. THE FISHERMAN'S SHACK: one room open to the rafters, a deep front porch, walkable plank roof
  //    reached by a timber stair at the back. Front faces SE toward the Landing / the mangrove.
  const F = hut({
    id: "shack", label: "FISHERMAN'S SHACK", x: 556.5, z: -222.5, yaw: 0.98, y: 1.8, w: 7.6, d: 5.4, floors: 1, floorH: 3.05,
    roof: "gable", pitch: 0.52, overhang: 0.8, wall: "#9a5a3c", trim: "#6a4a30", roofCol: "#8a6446", door: "#b0452e",
  });
  F.openings.push(door(0, 4.6), win(0, 1.2), win(1, 2.1), win(2, 1.6, 0, 1.4), win(2, 4.8), win(3, 2.2, 0, 1.0, 1.0));
  F.openings.push(door(3, 3.6, 0, 1.5));
  F.furniture.push(
    { kind: "table", x: -0.5, z: -0.3, y: 0, yaw: 0.1, w: 1.5, h: 0.78, d: 0.9 },
    { kind: "stool", x: -0.7, z: 0.6, y: 0, yaw: 0, w: 0.4, h: 0.48, d: 0.4, col: false },
    { kind: "bed", x: 2.4, z: -1.6, y: 0, yaw: 0, w: 2.1, h: 0.55, d: 1.2 },
    { kind: "shelf", x: -3.3, z: -1.2, y: 0, yaw: Math.PI / 2, w: 1.6, h: 1.9, d: 0.45 },
    { kind: "stove", x: 0.4, z: -2.1, y: 0, yaw: 0, w: 0.8, h: 0.95, d: 0.7 },
    { kind: "netpile", x: 3.3, z: 0.25, y: 0, yaw: 0.4, w: 1.2, h: 0.6, d: 1.1 },
    { kind: "crate", x: -2.3, z: -2.1, y: 0, yaw: 0.2, w: 0.8, h: 0.8, d: 0.8 },
    { kind: "chest", x: -0.9, z: -2.0, y: 0, yaw: 0, w: 1.0, h: 0.62, d: 0.62, col: false },
  );
  huts.push(F);

  // 2. BAIT & TACKLE: two storeys + a railed roof deck (interior stairs all the way), shop counter below, the
  //    keeper's rooms above. On short stilts east of the Landing, front toward the south walk.
  const B = hut({
    id: "bait", label: "BAIT & TACKLE", x: 604.5, z: -193.5, yaw: -2.55, y: 1.85, w: 8.4, d: 6.6, floors: 2, floorH: 3.0,
    roof: "flat", pitch: 0, overhang: 0, wall: "#5f7a6a", trim: "#e8d9b0", roofCol: "#6e5a44", door: "#d9a33a",
  });
  B.openings.push({ side: 0, u: 1.0, w: 2.8, y: 0.95, h: 1.3, floor: 0, kind: "window" }, door(0, 5.2), win(1, 2.6), win(3, 3.4), win(2, 6.2),
    win(0, 1.2, 1), win(0, 3.6, 1), win(0, 6.0, 1), win(1, 3.4, 1), win(3, 1.2, 1), win(3, 4.2, 1), win(1, 0.8, 1));
  // a SWITCHBACK: the roof flight starts right beside where the ground flight arrives, in the next lane, clear of the
  // well (starting at the far wall would leave its foot hanging over that flight's well)
  B.stairs.push({ x: -2.9, z: -2.55, dir: 1, floor: 0, w: 1.2 }, { x: 1.6, z: -0.85, dir: -1, floor: 1, w: 1.2, toRoof: true });
  B.porchRoof = { depth: 2.4, w: B.w + 2.0, shift: 1.0 };
  B.furniture.push(
    { kind: "counter", x: -1.9, z: 0.9, y: 0, yaw: 0, w: 2.6, h: 1.05, d: 0.7 },
    { kind: "tank", x: 3.3, z: -2.3, y: 0, yaw: 0, w: 1.2, h: 0.9, d: 0.9 },
    { kind: "shelf", x: 3.6, z: 0.2, y: 0, yaw: -Math.PI / 2, w: 1.5, h: 2.0, d: 0.45 },
    { kind: "barrel", x: -3.3, z: 1.9, y: 0, yaw: 0, w: 0.65, h: 0.9, d: 0.65 },
    { kind: "rack", x: -3.8, z: 1.0, y: 0, yaw: Math.PI / 2, w: 1.4, h: 1.8, d: 0.35 },
    { kind: "chest", x: 3.3, z: -0.9, y: 0, yaw: -Math.PI / 2, w: 1.0, h: 0.62, d: 0.62, col: false },
    // upstairs: bed, lockers, a table
    { kind: "bed", x: -2.4, z: 1.6, y: 3.0, yaw: 0, w: 2.1, h: 0.55, d: 1.2 },
    { kind: "locker", x: 1.2, z: 2.8, y: 3.0, yaw: Math.PI, w: 1.1, h: 1.9, d: 0.55 },
    { kind: "table", x: 0.8, z: 0.8, y: 3.0, yaw: 0.2, w: 1.3, h: 0.78, d: 0.85 },
    { kind: "chest", x: -3.5, z: -0.4, y: 3.0, yaw: Math.PI / 2, w: 1.0, h: 0.62, d: 0.62, col: false },
    // roof deck: a water tank + crates (cover up top) + a chest
    { kind: "tank", x: 2.6, z: 1.6, y: 6.0, yaw: 0, w: 1.6, h: 1.6, d: 1.6 },
    { kind: "crate", x: -2.8, z: 2.0, y: 6.0, yaw: 0.3, w: 0.9, h: 0.9, d: 0.9 },
    { kind: "crate", x: -1.9, z: 2.3, y: 6.0, yaw: -0.2, w: 0.8, h: 0.8, d: 0.8 },
    { kind: "chest", x: 0.2, z: 2.3, y: 6.0, yaw: 0, w: 1.0, h: 0.62, d: 0.62, col: false },
  );
  huts.push(B);

  // 3. THE STILT HOUSE: tall stilts, two storeys + a roof deck, the rope bridge from the Crow's Nest lands on its roof
  const S = hut({
    id: "stilt", label: "STILT HOUSE", x: 617, z: -247.5, yaw: -0.62, y: 2.25, w: 8.0, d: 6.4, floors: 2, floorH: 3.0,
    roof: "flat", pitch: 0, overhang: 0, wall: "#7b6a4a", trim: "#d8c9a0", roofCol: "#6e5a44", door: "#2f7f7a",
  });
  S.openings.push(door(0, 3.2), win(0, 1.0), win(0, 5.6), win(1, 2.6), win(3, 2.6), win(2, 5.4, 0, 1.4),
    win(0, 1.2, 1), win(0, 3.5, 1, 1.25, 1.15), win(0, 5.8, 1), win(1, 1.8, 1), win(3, 3.4, 1), win(2, 1.6, 1));
  // (the same switchback as the Bait & Tackle — the roof flight starts beside the ground flight's arrival)
  S.stairs.push({ x: 2.95, z: -2.45, dir: -1, floor: 0, w: 1.2 }, { x: -1.55, z: -0.8, dir: 1, floor: 1, w: 1.2, toRoof: true });
  S.porchRoof = { depth: 2.6, w: S.w + 1.6 };
  S.furniture.push(
    { kind: "table", x: -2.0, z: -0.6, y: 0, yaw: 0, w: 1.6, h: 0.78, d: 0.95 },
    { kind: "shelf", x: -3.55, z: 1.2, y: 0, yaw: Math.PI / 2, w: 1.6, h: 1.9, d: 0.45 },
    { kind: "stove", x: 2.8, z: 2.1, y: 0, yaw: Math.PI, w: 0.8, h: 0.95, d: 0.7 },
    { kind: "chest", x: 3.2, z: 0.4, y: 0, yaw: -Math.PI / 2, w: 1.0, h: 0.62, d: 0.62, col: false },
    { kind: "bunk", x: 2.6, z: 1.9, y: 3.0, yaw: 0, w: 2.1, h: 1.8, d: 1.0 },
    { kind: "locker", x: -3.55, z: 2.0, y: 3.0, yaw: Math.PI / 2, w: 1.1, h: 1.9, d: 0.55 },
    { kind: "crate", x: 0.2, z: 2.3, y: 3.0, yaw: 0.2, w: 0.8, h: 0.8, d: 0.8 },
    { kind: "chest", x: -0.8, z: 2.4, y: 3.0, yaw: Math.PI, w: 1.0, h: 0.62, d: 0.62, col: false },
    { kind: "crate", x: 2.4, z: 1.8, y: 6.0, yaw: 0.2, w: 0.9, h: 0.9, d: 0.9 },
    { kind: "barrel", x: 3.2, z: 0.6, y: 6.0, yaw: 0, w: 0.65, h: 0.9, d: 0.65 },
    { kind: "chest", x: -2.2, z: 2.3, y: 6.0, yaw: 0, w: 1.0, h: 0.62, d: 0.62, col: false },
  );
  huts.push(S);

  // 4. THE BOATHOUSE: a tall shed over the western shallows; a boat in its slip, a loft at the back (stair), walkable
  //    shallow roof by the stair on its east side
  const Hb = hut({
    id: "boathouse", label: "BOATHOUSE", x: 527, z: -226, yaw: 0.35, y: 1.7, w: 9.0, d: 11.0, floors: 1, floorH: 4.6,
    roof: "gable", pitch: 0.4, overhang: 0.7, wall: "#6b5a44", trim: "#4a3a2a", roofCol: "#7a5f45", door: "#8a3a2a",
  });
  Hb.openings.push({ side: 2, u: 2.4, w: 4.2, y: 0, h: 3.6, floor: 0, kind: "wide" }, door(0, 3.7), door(1, 7.0), door(3, 2.6),
    win(1, 2.4), win(1, 4.6), win(3, 5.6), win(3, 8.2), win(0, 1.2), win(0, 6.4));
  Hb.slip = { x0: -2.0, z0: -5.55, x1: 2.0, z1: 0.8 };
  Hb.loft = { z0: 1.6, z1: 5.3, h: 2.5 };
  Hb.stairs.push({ x: -3.3, z: 0.95, dir: 1, floor: 0, w: 1.1 });
  Hb.furniture.push(
    { kind: "boat", x: 0, z: -2.4, y: -1.0, yaw: Math.PI / 2, w: 5.0, h: 0.8, d: 1.5, col: false },
    // crates stacked at the slip's edges (cover over the slip; kept clear of by the kit)
    { kind: "crate", x: 2.62, z: -1.4, y: 0, yaw: 0.15, w: 0.9, h: 1.2, d: 0.9, keep: true },
    { kind: "crate", x: -2.62, z: -3.6, y: 0, yaw: -0.2, w: 0.9, h: 1.2, d: 0.9, keep: true },
    { kind: "workbench", x: 3.5, z: 2.4, y: 0, yaw: -Math.PI / 2, w: 2.0, h: 0.95, d: 0.8 },
    
    { kind: "crate", x: 3.6, z: -4.3, y: 0, yaw: 0.3, w: 0.9, h: 0.9, d: 0.9 },
    { kind: "crate", x: 3.5, z: 0.7, y: 0, yaw: -0.2, w: 0.8, h: 0.8, d: 0.8 },
    { kind: "netpile", x: -3.3, z: -4.3, y: 0, yaw: 0.2, w: 1.2, h: 0.6, d: 1.4 },
    { kind: "chest", x: 3.5, z: -0.5, y: 0, yaw: -Math.PI / 2, w: 1.0, h: 0.62, d: 0.62, col: false },
    { kind: "chest", x: 1.4, z: 4.6, y: 2.5, yaw: Math.PI, w: 1.0, h: 0.62, d: 0.62, col: false },
    { kind: "crate", x: -1.8, z: 4.4, y: 2.5, yaw: 0.1, w: 0.9, h: 0.9, d: 0.9 },
    { kind: "sacks", x: 2.9, z: 3.2, y: 2.5, yaw: 0.3, w: 1.1, h: 0.55, d: 0.8 },
  );
  huts.push(Hb);

  // 5. THE HERMIT'S HUT: small, cluttered, on the eastern hummocks; shed roof, stair at the side
  const E = hut({
    id: "hermit", label: "HERMIT'S HUT", x: 640.5, z: -214, yaw: -1.75, y: 1.75, w: 6.0, d: 5.0, floors: 1, floorH: 2.9,
    roof: "flat", pitch: 0, overhang: 0, wall: "#6e5a3e", trim: "#3f5a3a", roofCol: "#6a5a48", door: "#3f6a4a",
  });
  E.stairs.push({ x: -2.0, z: -1.7, dir: 1, floor: 0, w: 1.1, toRoof: true });
  E.porchRoof = { depth: 2.2, w: E.w + 1.2, shift: -0.6 };
  E.openings.push(door(0, 2.2), win(0, 4.3, 0, 1.0), win(1, 2.2), win(3, 1.4), win(2, 3.4, 0, 1.4));
  E.furniture.push(
    { kind: "bed", x: -2.3, z: 0.6, y: 0, yaw: Math.PI / 2, w: 2.0, h: 0.55, d: 1.1 },
    { kind: "table", x: 1.9, z: 0.3, y: 0, yaw: 0.3, w: 1.2, h: 0.78, d: 0.8 },
    { kind: "sacks", x: 2.3, z: 1.7, y: 0, yaw: 0.2, w: 1.0, h: 0.55, d: 0.8 },
    { kind: "chest", x: 1.8, z: -0.9, y: 0, yaw: -Math.PI / 2, w: 1.0, h: 0.62, d: 0.62, col: false },
    { kind: "crate", x: -1.8, z: 1.9, y: 2.9, yaw: 0.2, w: 0.9, h: 0.9, d: 0.9 },
    { kind: "chest", x: 1.4, z: 1.6, y: 2.9, yaw: 0, w: 1.0, h: 0.62, d: 0.62, col: false },
  );
  huts.push(E);

  // 6. THE SMOKEHOUSE on the Crow's Nest (13.35 m): racks of fish over a fire pit, crate steps up to its low roof
  const K = hut({
    id: "smokehouse", label: "SMOKEHOUSE", x: GM.x + 3.7, z: GM.z + 3.9, yaw: 0, y: GM.platY, w: 5.0, d: 3.9, floors: 1, floorH: 2.75,
    roof: "gable", pitch: 0.46, overhang: 0.55, wall: "#5a4432", trim: "#3a2a1e", roofCol: "#6a5242", door: "#7a3a24",
  });
  K.openings.push(door(2, 1.2, 0, 1.5), win(0, 1.6, 0, 1.6, 0.9, 1.1), win(1, 1.2, 0, 1.0, 0.8, 1.2), win(3, 1.4, 0, 1.0, 0.8, 1.2));
  K.furniture.push(
    { kind: "firepit", x: -1.2, z: 0.6, y: 0, yaw: 0, w: 1.1, h: 0.4, d: 1.1 },
    { kind: "rack", x: -0.6, z: 0.6, y: 1.6, yaw: 0, w: 2.2, h: 0.1, d: 1.4, col: false },
    { kind: "chest", x: 1.7, z: 0.95, y: 0, yaw: Math.PI, w: 1.0, h: 0.62, d: 0.62, col: false },
    { kind: "sacks", x: -1.9, z: -1.1, y: 0, yaw: 0.2, w: 0.9, h: 0.55, d: 0.7 },
  );
  huts.push(K);
  // the storeys are furnished by the shared interiors kit (INTERIOR_ROOMS below); keep only what the kit does not
  // own: the boat in the slip, the boathouse loft, the smokehouse (fire pit + fish racks) and the roof-deck cover
  for (const h of huts) if (ROOM_PLAN[h.id]) h.furniture = h.furniture.filter((f) => f.keep || f.kind === "boat" || f.y >= h.floors * h.floorH - 0.1 || (h.loft && f.y >= h.loft.h - 0.1));
  const parts = huts.map(resolveHut);
  const PF = parts[0], PB = parts[1], PS = parts[2], PH = parts[3], PE = parts[4], PK = parts[5];

  // ---------------------------------------------------------------- decks + walks
  const L = (h: Hut, lx: number, lz: number) => toWorld(h, lx, lz);
  // porches: a deck around the front of every hut (its floor level), rails where no walk joins
  const porch = (h: Hut, side: Side, depth: number, extraW = 0, shift = 0, rails: MDeck["rails"] = {}, y = h.y) => {
    // side 0 front (+z), 1 right, 2 back, 3 left — porch deck centred on that side
    const along = side % 2 === 0 ? h.w + extraW : h.d + extraW;
    const off = (side % 2 === 0 ? h.d : h.w) / 2 + depth / 2;
    const [lx, lz] = side === 0 ? [shift, off] : side === 2 ? [-shift, -off] : side === 1 ? [off, -shift] : [-off, shift];
    const [x, z] = L(h, lx, lz);
    const yaw = h.yaw + (side === 0 ? 0 : side === 1 ? Math.PI / 2 : side === 2 ? Math.PI : -Math.PI / 2);
    // a porch deck's local +z points AWAY from the hut; w along the wall, d = depth
    const k: MDeck = { x, z, yaw, w: along, d: depth, y, planksZ: false, rails, kind: "porch" };
    decks.push(k);
    return k;
  };
  // shack: deep front porch (extends 2.4 m past the right corner toward the jetty walk), a side deck on the left (west)
  const Fp = porch(F, 0, 3.2, 3.6, 1.2, { pz: [[0, 3.2], [5.2, 11.2]], nx: [[0, 3.2]] });
  porch(F, 3, 2.4, 0, 0, { pz: true, px: [[0, 0.6], [2.2, 5.4]] });
  // bait & tackle: wrap-around porch (front + right) at its floor; stilt house: front porch; hermit: front porch
  const Bp = porch(B, 0, 2.6, 2.4, 1.2, { pz: [[0, 2.6], [5.2, 10.8]], nx: true });
  porch(B, 1, 2.2, 0, 0, { pz: true, px: [[0, 1.8]] });
  const Sp = porch(S, 0, 2.8, 2.0, 0, { pz: [[0, 3.8], [6.2, 10.0]], nx: true, px: [[0, 2.8]] });
  const Ep = porch(E, 0, 2.4, 1.6, -0.8, { pz: [[0, 1.2], [3.2, 7.6]], px: true });
  // boathouse: side decks at its floor (east + west), a front landing
  const Hp = porch(Hb, 0, 2.4, 2.0, 0, { pz: [[0, 2.0], [4.4, 11.0]], nx: true, px: true });
  porch(Hb, 1, 1.8, -2.0, 1.0, { pz: [[0, 5.0], [7.0, 9.0]] });
  porch(Hb, 3, 1.8, -2.0, -1.0, { pz: true });

  // the Landing (junction), the Dock
  const landing: MDeck = { x: 561, z: -196, yaw: 0.12, w: 10, d: 8, y: WALK_Y, rails: { nx: [[0, 2.4], [5.6, 8]], px: [[0, 3], [5.6, 8]] }, kind: "deck" };
  decks.push(landing);
  const dock: MDeck = { x: 566.5, z: -263.5, yaw: 0.05, w: 6.5, d: 12, y: WALK_Y, rails: { nx: [[3, 9]] }, kind: "dock", pile: 2.6 };
  decks.push(dock);
  // root gate deck: from the jetty walk into the mangrove's arch (floor 1.15 = one small step down)
  const gateDir: V2 = [dmath.cos(GM.inA), dmath.sin(GM.inA)];
  const gateR = gmRadius(GM.floorY) - 0.2;
  const gateA: V2 = [GM.x + gateDir[0] * gateR, GM.z + gateDir[1] * gateR];
  const gateB: V2 = [GM.x + gateDir[0] * (gateR + 6.4), GM.z + gateDir[1] * (gateR + 6.4)];
  const gate = walkDeck(gateB, gateA, 2.4, GM.floorY, { kind: "walk" });
  decks.push(gate);

  // walks (a → b), rails both sides unless noted; end gaps are where they meet
  const W = (a: V2, b: V2, o: Partial<MDeck> = {}) => { const k = walkDeck(a, b, 2.4, WALK_Y, o); decks.push(k); return k; };
  // SOUTH WALK: from the plateau edge (the Mango Market path) down to the Landing, one broken span over a pool
  const s0: V2 = [541.5, -143.5], s1: V2 = [552.6, -169.5], s2: V2 = [555.2, -176.5], s3: V2 = [559.8, -192.2];
  W(s0, s1, { worn: 0.2 });
  W(s2, s3);
  // JETTY WALK: shack porch → the dock
  const fpEnd = deckPt(Fp, Fp.w / 2 - 1.2, 0); // right end of the shack porch
  const j1: V2 = [fpEnd[0] + 1.0, fpEnd[1] - 1.0], j2: V2 = [565.2, -236.5], j3: V2 = [566.2, -257.4];
  W([fpEnd[0] - 0.4, fpEnd[1]], j1);
  W(j1, j2);
  W(j2, j3, { worn: 0.35 });
  // LANDING → shack porch
  const lp = deckPt(landing, -2.6, -4.0);
  const fpS = deckPt(Fp, -1.4, 1.4);
  W(lp, fpS);
  // jetty walk → root gate (a spur east, meeting the gate deck's outer end)
  const jg: V2 = [j2[0] - 0.6, j2[1] + 6.0];
  W(jg, [gateB[0] - 0.9, gateB[1] - 0.3]);
  // LANDING → bait & tackle porch (east, behind the poi-13-the-murk view's camera)
  const le = deckPt(landing, 5.0, 1.5);
  const bpWest = deckPt(Bp, Bp.w / 2 - 1.0, 0.3);
  W([le[0] - 0.5, le[1]], bpWest);
  // bait & tackle → hermit's hut → the east shore
  const bpEast = deckPt(Bp, -Bp.w / 2 + 1.0, 0.3);
  const ew: V2 = [627.5, -207.5];
  W(bpEast, ew);
  const epN = deckPt(Ep, Ep.w / 2 - 1.0, 0.2);
  W(ew, epN);
  // around the hut's north side to the east shore
  W(deckPt(Ep, Ep.w / 2 - 0.6, 0.6), [646.5, -205.0]);
  W([646.5, -205.0], [668.5, -200.5], { worn: 0.2 });
  // mangrove north side → stilt house porch
  const sn: V2 = [596.5, -230.5];
  W([j2[0] + 1.0, j2[1] - 0.2], [583.5, -235.2]);
  W([583.5, -235.2], sn);
  const spW = deckPt(Sp, -Sp.w / 2 + 1.0, 0.4);
  W(sn, spW, { y: WALK_Y });
  // stilt house → east (hermit) link over the channel
  const spE = deckPt(Sp, Sp.w / 2 - 1.0, 0.4);
  W(spE, [633.5, -225.5], { worn: 0.3 });
  W([633.5, -225.5], deckPt(Ep, -Ep.w / 2 + 1.0, 0.2));
  // shack west deck → boathouse front landing → the west shore
  const fw = deckPt(decks[1], 0, 0.9);
  const hpE = deckPt(Hp, Hp.w / 2 - 1.2, 0.3);
  W(fw, [541.5, -216.5]);
  W([541.5, -216.5], hpE);
  const hpW = deckPt(Hp, -Hp.w / 2 + 1.2, 0.3);
  W(hpW, [508.5, -214.5], { worn: 0.25 });
  W([508.5, -214.5], [484.5, -212.5]);

  // ---------------------------------------------------------------- flights (stairs)
  /** a flight DOWN from a deck edge point along a direction to the swamp bed (solid treads) */
  const down = (x: number, z: number, dx: number, dz: number, yTop: number, _yBot = 0.35, w = 1.6) => {
    const L2 = dmath.hypot(dx, dz), ux = dx / L2, uz = dz / L2, tread = 0.32;
    // the foot lands on the swamp bed (baked ground; never deeper than −1.2 — a swimmer can walk up out of the lagoon)
    let yBot = 0.35, n = 4;
    for (let it = 0; it < 3; it++) {
      const run = n * tread, g = Math.max(-1.2, Math.min(yTop - 0.3, bedAt(x + ux * (run + 0.2), z + uz * (run + 0.2))));
      yBot = g + 0.04; n = Math.max(2, Math.ceil((yTop - yBot) / 0.24));
    }
    flights.push({ x, z, dx: ux, dz: uz, w, yTop, yBot, n, tread, solid: true });
  };
  /** a flight on a deck's side at local u (m from the −z end), going away from the deck; opens that side's rail */
  const sideDown = (k: MDeck, side: "nx" | "px" | "pz" | "nz", u: number, yBot = 0.35, w = 1.6) => {
    const c = dmath.cos(k.yaw), s = dmath.sin(k.yaw);
    let lx = 0, lz = 0, dxl = 0, dzl = 0;
    if (side === "nx") { lx = -k.w / 2; lz = -k.d / 2 + u; dxl = -1; }
    if (side === "px") { lx = k.w / 2; lz = -k.d / 2 + u; dxl = 1; }
    if (side === "pz") { lz = k.d / 2; lx = -k.w / 2 + u; dzl = 1; }
    if (side === "nz") { lz = -k.d / 2; lx = -k.w / 2 + u; dzl = -1; }
    const [x, z] = toWorld(k, lx, lz);
    down(x, z, dxl * c + dzl * s, -dxl * s + dzl * c, k.y, yBot, w);
    // cut the rail
    const r = (k.rails ??= {});
    const cut = (spans: boolean | V2[] | undefined, len: number): V2[] => {
      const src: V2[] = spans === true ? [[0, len]] : spans ? spans : [];
      const out: V2[] = [];
      for (const [a, b] of src) { if (u - w / 2 - 0.1 > a) out.push([a, Math.min(b, u - w / 2 - 0.1)]); if (u + w / 2 + 0.1 < b) out.push([Math.max(a, u + w / 2 + 0.1), b]); }
      return out;
    };
    const len = side === "nx" || side === "px" ? k.d : k.w;
    r[side] = cut(r[side], len);
  };
  // ramps into the shallows along the walks (the "gaps with ramps down into wadeable water")
  const walks = decks.filter((k) => k.kind === "walk" && k.y === WALK_Y);
  const sd = (i: number, side: "nx" | "px", t: number) => { const k = walks[i]; if (k) sideDown(k, side, k.d * t); };
  sd(0, "px", 0.7); sd(1, "nx", 0.5); sd(3, "px", 0.45); sd(4, "nx", 0.55); sd(5, "px", 0.6);
  sd(7, "px", 0.5); sd(8, "nx", 0.4); sd(9, "px", 0.55); sd(10, "nx", 0.6); sd(11, "px", 0.5); sd(12, "nx", 0.35); sd(13, "px", 0.5);
  sd(14, "nx", 0.5); sd(15, "px", 0.6); sd(16, "nx", 0.5); sd(17, "px", 0.45); sd(18, "nx", 0.4); sd(19, "px", 0.5);
  // the Landing: broad steps down on both sides; the dock: a flight on its west side
  sideDown(landing, "nz", 7.2, 0.35, 2.2); sideDown(landing, "px", 4.2, 0.35, 2.0);
  sideDown(dock, "px", 3.0, 0.35, 1.6);
  // walk ends on the shores: east + west (short solid flights)
  down(668.5 + 0.4, -200.5 + 0.05, 1, 0.02, WALK_Y, 0.9, 2.4);
  down(484.5 - 0.4, -212.5, -1, -0.08, WALK_Y, 0.9, 2.4);
  for (const w of decks.filter((k) => k.kind === "walk")) {
    const c = dmath.cos(w.yaw), sn = dmath.sin(w.yaw);
    for (const end of [1, -1]) {
      const ex = w.x + sn * end * w.d / 2, ez = w.z + c * end * w.d / 2;
      for (const k of decks) {
        if (k === w || k.y - w.y < 0.12) continue;
        // walk end inside k (local rect, small margin)?
        const kc = dmath.cos(k.yaw), ks = dmath.sin(k.yaw), dx = ex - k.x, dz = ez - k.z;
        const lx = dx * kc - dz * ks, lz = dx * ks + dz * kc;
        if (Math.abs(lx) > k.w / 2 + 0.2 || Math.abs(lz) > k.d / 2 + 0.2) continue;
        // march back along the walk from its end until we leave k: that is k's edge on the walk's centreline
        let t = 0;
        for (; t < w.d; t += 0.05) {
          const px = ex - sn * end * t, pz = ez - c * end * t, qx = px - k.x, qz = pz - k.z;
          const ux = qx * kc - qz * ks, uz = qx * ks + qz * kc;
          if (Math.abs(ux) > k.w / 2 || Math.abs(uz) > k.d / 2) break;
        }
        const fx = ex - sn * end * (t - 0.02), fz = ez - c * end * (t - 0.02), n = Math.ceil((k.y - w.y) / 0.2);
        flights.push({ x: fx, z: fz, dx: -sn * end, dz: -c * end, w: Math.min(w.w, 2.2), yTop: k.y, yBot: w.y, n, tread: 0.3, solid: true });
      }
    }
  }
  down(s0[0] + 0.3, s0[1] + 0.2, s0[0] - s1[0], s0[1] - s1[1], WALK_Y, 1.2, 2.4);

  // exterior ROOF STAIRS (gable / shed huts): from the porch / side deck up to the eave
  const roofStair = (p: HutParts, lx: number, lz: number, dirLx: number, dirLz: number, yBot: number, w = 1.2) => {
    const h = p.h, [x, z] = toWorld(h, lx, lz), c = dmath.cos(h.yaw), s = dmath.sin(h.yaw);
    // the flight's TOP is at (lx, lz), stepping DOWN along dir
    const dx = dirLx * c + dirLz * s, dz = -dirLx * s + dirLz * c;
    const yTop = p.tipY + 0.12, n = Math.ceil((yTop - yBot) / 0.22);
    flights.push({ x, z, dx, dz, w, yTop, yBot, n, tread: 0.27, solid: false, rails: true });
  };
  // shack: at the back (−z), beside the west side deck — the flight climbs along the back wall toward the eave tip
  roofStair(PF, -2.6, -F.d / 2 - F.overhang - 0.05, 0, -1, F.y);
  // back landing for the shack's roof stair: a deck along the back wall from the west side deck to the stair foot
  {
    const n = Math.ceil((PF.tipY + 0.12 - F.y) / 0.22), zFoot = -F.d / 2 - F.overhang - 0.05 - n * 0.27;
    const x0 = -F.w / 2 - 2.4, x1 = -1.2, z0 = zFoot - 1.6, z1 = -F.d / 2 - 0.05;
    const [x, z] = L(F, (x0 + x1) / 2, (z0 + z1) / 2);
    decks.push({ x, z, yaw: F.yaw, w: x1 - x0, d: z1 - z0, y: F.y, rails: { nz: true, px: true }, kind: "deck" });
  }
  // boathouse: its 127 m² gable roof would be glider-only without it — an open roof stair from the front eave tip down over the
  // front porch (through the porch rail gap at lx −3.5…−1.1) onto a landing deck in the shallows in front of it; the
  // landing's walkway runs beside the flight (1.3 m) and under its high end back to the porch
  {
    const h = Hb, fx = -2.3, fw = 1.2, zTop = h.d / 2 + h.overhang + 0.05;
    roofStair(PH, fx, zTop, 0, 1, h.y, fw);
    const n = Math.ceil((PH.tipY + 0.12 - h.y) / 0.22), zFoot = zTop + n * 0.27;
    const x0 = fx - fw / 2 - 1.3, x1 = fx + fw / 2, z0 = h.d / 2 + 2.4 - 0.05, z1 = zFoot + 1.25;
    const [x, z] = L(h, (x0 + x1) / 2, (z0 + z1) / 2);
    decks.push({ x, z, yaw: h.yaw, w: x1 - x0, d: z1 - z0, y: h.y, rails: { nx: true, pz: true, px: [[zFoot - z0 + 0.1, z1 - z0]] }, kind: "deck" });
  }
  void PB; void PS; void PK; void PH; void PE;

  // ---------------------------------------------------------------- the great mangrove: roots, limbs
  const spiral = gmSpiral();
  const gr = mulberry(0x9a11);
  const nProp = 18;
  for (let i = 0; i < nProp; i++) {
    const a = (i / nProp) * TAU + (gr() - 0.5) * 0.22;
    // keep the gate approach clear: no prop root within ±26° of the entrance axis
    if (Math.abs(angDiff(a, GM.inA)) < 0.45) continue;
    const y0 = 3.0 + gr() * 3.6, reach = 5.0 + gr() * 5.0, rTop = gmRadius(y0) - 0.3;
    const tw = (gr() - 0.5) * 0.5, kink = (gr() - 0.5) * 0.8;
    const pts: V3[] = [];
    // leave the trunk, bow UP and out (a tall arch), then dive steeply into the water
    const P6: Array<[number, number]> = [[rTop, y0], [rTop + reach * 0.2, y0 + 0.7 + gr() * 0.6], [rTop + reach * 0.45, y0 * 0.85 + 0.5], [rTop + reach * 0.7, y0 * 0.45 + 0.4], [rTop + reach * 0.9, 0.5], [rTop + reach * 0.96, -1.0]];
    P6.forEach(([r, y], k) => { const aa = a + tw * (k / 5) + (k === 3 ? kink * 0.12 : 0); pts.push([GM.x + dmath.cos(aa) * r, y, GM.z + dmath.sin(aa) * r]); });
    roots.push({ pts, r0: 0.5 + gr() * 0.28, r1: 0.2, kind: "prop" });
    // secondary roots branching off the arch, down to either side; some with a tertiary
    const nb2 = gr() < 0.75 ? 1 + (gr() < 0.4 ? 1 : 0) : 0;
    for (let q = 0; q < nb2; q++) {
      const k = 3 + q, b = pts[k], sgn = (q ? -1 : 1) * (gr() < 0.5 ? -1 : 1), aa = a + sgn * (0.22 + gr() * 0.3), r2 = dmath.hypot(b[0] - GM.x, b[2] - GM.z) + 1.6 + gr() * 2.5;
      const mid: V3 = [GM.x + dmath.cos(aa) * (r2 * 0.85), b[1] * 0.6 + 0.3, GM.z + dmath.sin(aa) * (r2 * 0.85)];
      roots.push({ pts: [b, mid, [GM.x + dmath.cos(aa) * r2, 0.3, GM.z + dmath.sin(aa) * r2], [GM.x + dmath.cos(aa) * r2 * 1.02, -1.2, GM.z + dmath.sin(aa) * r2 * 1.02]], r0: 0.26, r1: 0.12, kind: "prop" });
    }
  }
  // buttress roots: the trunk's foot flows out into 11 massive roots sweeping down into the water (a giant
  // root mass — the base reads as one sculpted flare, not legs)
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * TAU + 0.15 + (gr() - 0.5) * 0.15;
    if (Math.abs(angDiff(a, GM.inA)) < 0.5) continue;
    const r0 = gmRadius(3) - 0.5, len = 4.2 + gr() * 3.2, sw = (gr() - 0.5) * 0.35, y0 = 3.6 + gr() * 1.6;
    const P = (t: number, y: number): V3 => { const aa = a + sw * t; const r = r0 + len * t; return [GM.x + dmath.cos(aa) * r, y, GM.z + dmath.sin(aa) * r]; };
    // (the flare IS the buttress mass now — its ribs are the trunk's flutes; only the knees beyond it remain)
    void P(0, y0);
    // a knee (pneumatophore) or two poking out of the water beyond it
    for (let k = 0; k < 2; k++) { const q = P(1.3 + gr() * 0.8, 0); const hk = 0.5 + gr() * 0.6; roots.push({ pts: [[q[0], -0.5, q[2]], [q[0] + (gr() - 0.5) * 0.2, hk * 0.6, q[2] + (gr() - 0.5) * 0.2], [q[0] + (gr() - 0.5) * 0.3, hk, q[2] + (gr() - 0.5) * 0.3]], r0: 0.13, r1: 0.06, kind: "knee" }); }
  }
  // limbs: the crown fork at ~19 m, five great limbs reaching out 10–16 m (canopies are planted at their ends)
  const limbEnds: V3[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.6 + (gr() - 0.5) * 0.4, reach = 11 + gr() * 6, top = 25 + gr() * 4;
    const c = dmath.cos(a), s = dmath.sin(a);
    const pts: V3[] = [[GM.x + c * 0.6, 18.2, GM.z + s * 0.6], [GM.x + c * reach * 0.3, 21 + gr(), GM.z + s * reach * 0.3], [GM.x + c * reach * 0.65, top - 0.6, GM.z + s * reach * 0.65], [GM.x + c * reach, top, GM.z + s * reach]];
    roots.push({ pts, r0: 1.25, r1: 0.35, kind: "limb" });
    limbEnds.push(pts[3]);
    // lower side limb over the platform (moss hangs from it) — ≥ 1.9 m clear over the smokehouse ridge (walkable roof)
    if (i % 2 === 0) {
      const a2 = a + 0.5, r2 = 7 + gr() * 3;
      roots.push({ pts: [[GM.x + dmath.cos(a2) * 1.6, 19.4, GM.z + dmath.sin(a2) * 1.6], [GM.x + dmath.cos(a2) * r2 * 0.5, 20.0, GM.z + dmath.sin(a2) * r2 * 0.5], [GM.x + dmath.cos(a2) * r2, 19.3 + gr(), GM.z + dmath.sin(a2) * r2]], r0: 0.6, r1: 0.22, kind: "limb" });
    }
  }
  // (they stay ≥ 1.9 m under the platform slab while beneath it, so the perch under the nest is a walkable, covered
  // spot — reached by dropping through the rail gap above the limb, see nestRails)
  // two LOW limbs leave the trunk under the Crow's Nest and sweep out over the channel (toward the shack and the
  // poi-13-the-murk view's camera): a giant limb arching over the water with moss curtains
  for (const [a, reach, yEnd] of [[dmath.atan2(12.5, -15.5), 15, 13.5], [dmath.atan2(-2.5, -1), 13, 14.5]] as Array<[number, number, number]>) {
    const c = dmath.cos(a), sn = dmath.sin(a), r0 = gmRadius(9) - 0.4;
    const pts: V3[] = [[GM.x + c * r0, 9.2, GM.z + sn * r0], [GM.x + c * (r0 + reach * 0.3), 9.5, GM.z + sn * (r0 + reach * 0.3)], [GM.x + c * (r0 + reach * 0.62), 10.9, GM.z + sn * (r0 + reach * 0.62)], [GM.x + c * (r0 + reach), yEnd, GM.z + sn * (r0 + reach)]];
    roots.push({ pts, r0: 0.95, r1: 0.4, kind: "limb" });
    for (let k = 0; k < 16; k++) { const t = 0.25 + gr() * 0.75, q = pts[Math.min(3, Math.round(t * 3))]; moss.push({ x: q[0] + (gr() - 0.5) * 2, y: q[1] - 0.3, z: q[2] + (gr() - 0.5) * 2, len: 1.6 + gr() * 2.8, w: 0.5 + gr() * 0.5 }); }
  }
  // aerial roots: short drops under the platform edge and the lowest limbs (no long "wires" from the crown)
  for (let k = 0; k < 14; k++) {
    const a = gr() * TAU, r = GM.platH * (0.75 + gr() * 0.3), x = GM.x + dmath.cos(a) * r, z = GM.z + dmath.sin(a) * r, y = GM.platY - 0.4;
    roots.push({ pts: [[x, y, z], [x + (gr() - 0.5) * 0.3, y - 1.2 - gr(), z + (gr() - 0.5) * 0.3], [x + (gr() - 0.5) * 0.5, y - 2.2 - gr() * 2.2, z + (gr() - 0.5) * 0.5]], r0: 0.06, r1: 0.035, kind: "aerial" });
  }
  void limbEnds;

  // ---------------------------------------------------------------- root tangles (hard cover in the water)
  const tangle = (x: number, z: number, s: number, seed: number, n = 5) => {
    const tr = mulberry(seed);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + tr() * 0.8, reach = s * (1.2 + tr() * 0.9), h = s * (1.2 + tr() * 0.9);
      const c = dmath.cos(a), sn = dmath.sin(a), bx = x + (tr() - 0.5) * 0.6, bz = z + (tr() - 0.5) * 0.6;
      roots.push({ pts: [[bx, h, bz], [bx + c * reach * 0.35, h + 0.25, bz + sn * reach * 0.35], [bx + c * reach * 0.75, h * 0.55, bz + sn * reach * 0.75], [bx + c * reach, -0.3, bz + sn * reach], [bx + c * reach * 1.05, -1.3, bz + sn * reach * 1.05]], r0: 0.2 * s + 0.08, r1: 0.1, kind: "tangle" });
    }
    // the stem the arches spring from (+ a mangrove crown planted on it by the client)
    roots.push({ pts: [[x, -1.2, z], [x, 0.5, z], [x + (tr() - 0.5) * 0.4, s * 1.5 + 0.8, z + (tr() - 0.5) * 0.4]], r0: 0.28 * s + 0.12, r1: 0.2 * s + 0.08, kind: "tangle" });
  };
  const TANGLES: Array<[number, number, number]> = [
    [577.5, -203.5, 1.0], [549.5, -207.5, 1.2], [574.0, -245.0, 1.2], [557.0, -246.5, 1.0],
    [597.0, -208.0, 1.1], [606.5, -224.0, 1.3], [593.0, -247.0, 1.0], [623.0, -233.0, 1.1], [611.0, -212.5, 0.9], [650.0, -228.0, 1.2],
    [538.0, -236.5, 1.0], [516.0, -208.5, 1.1], [531.0, -201.0, 0.9], [586.0, -186.5, 1.0], [572.0, -170.5, 1.1], [540.0, -180.0, 1.0],
    [628.0, -190.5, 1.0], [653.5, -246.0, 1.1], [602.5, -262.0, 1.0], [545.0, -255.0, 0.9], [624.0, -268.0, 1.1], [500.5, -228.0, 1.0],
  ];
  TANGLES.forEach(([x, z, s], i) => tangle(x, z, s, 0x7a00 + i));
  // THE BUTTRESS GIANT — the right third of the poi-13-the-murk view: a massive old trunk on the
  // channel bank between the rowboat and the Great Mangrove, leaning toward the giant, its buttress roots flaring out
  // into the tea on the channel side (cover + a climbable root perch at 1–2 m).
  {
    const bx = 571.8, bz = -213.2, tr = mulberry(0xb077);
    const lx = (GM.x - bx) * 0.16, lz = (GM.z - bz) * 0.16;
    roots.push({ pts: [[bx, -1.2, bz], [bx + lx * 0.1, 2.2, bz + lz * 0.1], [bx + lx * 0.45, 6.5, bz + lz * 0.45], [bx + lx, 12.0, bz + lz]], r0: 1.3, r1: 0.62, kind: "trunk" });
    // buttresses: springing from the trunk at 1.8–4 m, arching out and diving into the bed; denser toward the channel
    // (−x / +z, the camera side) where the roots spill toward the water
    // (smooth rope-like roots that FLOW down the trunk surface, then out and into the tea: bends ≥ 3× the root radius so
    // the tube never folds into creases; the thickest leave lowest)
    const N = 8;
    for (let i = 0; i < N; i++) {
      const a = dmath.atan2(0.55, -1) + (i / N - 0.5) * 5.0 + (tr() - 0.5) * 0.3;
      const toCh = Math.max(0, dmath.cos(a - dmath.atan2(0.55, -1)));
      const reach = 3.4 + toCh * 1.0 + tr() * 0.8, h0 = 1.7 + tr() * 1.1, c = dmath.cos(a), sn = dmath.sin(a);
      const r0 = 0.38 + tr() * 0.14, rt = 1.15;
      roots.push({ pts: [[bx + lx * 0.1, h0 + 1.2, bz + lz * 0.1], [bx + c * 0.5, h0 + 0.1, bz + sn * 0.5], [bx + c * rt, h0 * 0.55, bz + sn * rt], [bx + c * (rt + (reach - rt) * 0.45), 0.95 + tr() * 0.2, bz + sn * (rt + (reach - rt) * 0.45)], [bx + c * reach, 0.1, bz + sn * reach], [bx + c * (reach + 0.6), -1.3, bz + sn * (reach + 0.6)]], r0, r1: 0.16, kind: "buttress" });
    }
    // its SCULPTED ROOT MASS: the fused buttress foot the roots spring from (rootMasses: drawn + solid)
    cagesPre.push({ x: bx, z: bz, r: 3.7, y0: BED, y1: groundAt(bx, bz) + 2.9, rt: 1.55 });
    // the crown it carries (meets the Great Mangrove's low limb over the channel)
    canopiesPre.push({ c: [bx + lx + 0.5, 15.0, bz + lz - 0.5], r: 5.5 }, { c: [bx + lx - 3.0, 13.5, bz + lz + 2.0], r: 4.2 });
    for (let k = 0; k < 7; k++) moss.push({ x: bx + lx * 0.8 + (tr() - 0.5) * 4, y: 10.5 + tr() * 2.5, z: bz + lz * 0.8 + (tr() - 0.5) * 4, len: 1.8 + tr() * 2.6, w: 0.5 + tr() * 0.5 });
  }
  // fallen trunks (cover you can hop onto): lying across the shallows
  const LOGS: Array<[V3, V3, number]> = [
    [[563.5, 0.85, -178.5], [573.0, 1.2, -184.0], 0.55], [[590.0, 0.9, -240.5], [600.0, 0.8, -236.0], 0.6], [[534.5, 0.8, -196.5], [544.0, 1.05, -191.0], 0.5],
    [[636.0, 0.85, -240.5], [644.5, 1.1, -234.0], 0.55], [[613.0, 0.85, -178.0], [619.5, 0.75, -186.5], 0.5],
  ];
  for (const [a, b, r] of LOGS) roots.push({ pts: [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.05, (a[2] + b[2]) / 2], b], r0: r, r1: r * 0.8, kind: "log" });

  // ---------------------------------------------------------------- props (cover + dressing)
  const pr = (kind: MProp["kind"], x: number, y: number, z: number, yaw = 0, o: Partial<MProp> = {}) => props.push({ kind, x, y, z, yaw, ...o });
  const onDeck = (k: MDeck, lx: number, lz: number, kind: MProp["kind"], o: Partial<MProp> = {}) => { const [x, z] = toWorld(k, lx, lz); pr(kind, x, k.y, z, k.yaw + (o.yaw ?? 0), o); };
  // cover on THE LANDING: a crate stack + a barrel at its north-east edge (otherwise the deck is open for 8 m)
  onDeck(landing, -2.1, -3.2, "crates", { v: 0, yaw: 0.25 });
  onDeck(landing, -0.75, -3.35, "barrel", { v: 1 });
  // shack porch (crates + barrels stacked at the porch's left end, lanterns, a net curtain, floats)
  onDeck(Fp, -Fp.w / 2 + 0.9 - 1.2, -0.6, "crates", { v: 3, s: 1.0 });
  onDeck(Fp, -Fp.w / 2 + 2.0 - 1.2, 0.6, "barrel", { v: 1 });
  onDeck(Fp, 2.4, 1.1, "trap", { yaw: 0.4 });
  onDeck(Fp, -2.2, 1.35, "lantern", { h: 2.6 });
  onDeck(Fp, 3.4, 1.35, "lantern", { h: 2.4 });
  onDeck(Fp, 0.4, -1.3, "netrack", {});
  // landing: crate stacks, a sign post (BANANA CO.), drums
  onDeck(landing, -3.4, 2.6, "crates", { v: 2 });
  onDeck(landing, 3.5, -2.4, "crates", { v: 1, yaw: 0.3 });
  onDeck(landing, 3.8, 2.9, "drum", {});
  onDeck(landing, 3.0, 3.1, "drum", { v: 1 });
  onDeck(landing, -4.2, -3.1, "sign", { yaw: Math.PI });
  onDeck(landing, -4.3, 3.4, "lantern", { h: 2.8 });
  // dock: crates, barrels, traps, a bollard pair; the moored skiff
  onDeck(dock, -2.2, 4.0, "crates", { v: 2 });
  onDeck(dock, 2.3, 1.2, "barrel", {});
  onDeck(dock, 2.0, 2.0, "barrel", { v: 1 });
  onDeck(dock, -2.0, -2.5, "trap", {});
  onDeck(dock, -2.4, -1.2, "trap", { yaw: 0.8 });
  onDeck(dock, 1.8, -4.6, "logpile", {});
  onDeck(dock, -2.9, 5.6, "lantern", { h: 2.6 });
  // walks: crate stacks / barrels every so often on alternating sides (cover along the lanes)
  walks.forEach((k, i) => {
    const n = Math.floor(k.d / 6);
    for (let j = 0; j < n; j++) {
      const t = -k.d / 2 + 3.2 + j * 6 + (rng() - 0.5) * 1.5, side = (i + j) % 2 ? 1 : -1;
      const q = rng();
      // crate stacks tall enough to crouch behind (≥ 1.25 m), a barrel or a trap beside some
      onDeck(k, side * (k.w / 2 - 0.62), t, "crates", { v: [0, 2, 3][Math.floor(q * 3) % 3], yaw: rng() * 0.5 });
      if (q < 0.5) onDeck(k, side * (k.w / 2 - 0.45), t + 1.05, q < 0.25 ? "barrel" : "trap", { v: Math.floor(rng() * 2), yaw: rng() * 0.6 });
    }
  });
  // porch dressing for the other huts
  onDeck(Bp, -3.6, -0.3, "barrel", { v: 2 }); onDeck(Bp, -2.8, -0.72, "crates", { v: 1 }); onDeck(Bp, 4.4, 0.6, "trap", {}); onDeck(Bp, 0.2, 1.0, "sign", { yaw: 0 });
  onDeck(Sp, 3.2, 0.3, "crates", { v: 0 }); onDeck(Sp, -3.4, 0.6, "barrel", {}); onDeck(Sp, 0.8, 1.2, "lantern", { h: 2.4 });
  onDeck(Ep, -2.6, 0.2, "crates", { v: 3 }); onDeck(Ep, 0.9, 0.7, "trap", { yaw: 1.2 });
  onDeck(Hp, 3.4, 0.2, "barrel", {}); onDeck(Hp, -3.3, 0.5, "crates", { v: 2 });
  // the Crow's Nest: crate steps up to the smokehouse roof (west gable end), sacks, a lantern
  {
    // 5 stacks rising 0.52 m each, from the north up to the smokehouse's north eave (tip at PK.tipY), east of the trunk
    const x = K.x + 1.25, zTip = K.z - K.d / 2 - K.overhang;
    for (let i = 0; i < 5; i++) pr("crates", x, GM.platY, zTip - 0.1 - (4 - i) * 1.0, 0, { v: 10 + i, h: (PK.tipY + 0.1 - GM.platY) * (i + 1) / 5 });
  }
  // roof cover: stove chimneys through the gable roofs (the kit furnishes wood stoves inside) — hard cover on the
  // otherwise bare walkable roofs (the Boathouse roof is reachable by its stair), + a crate stack on the Stilt roof
  {
    const chim = (p: HutParts, lx: number, lz: number) => {
      const [x, z] = toWorld(p.h, lx, lz), y = roofAt(p, lz) - 0.35;
      pr("chimney", x, y, z, p.h.yaw, { h: Math.max(1.9, p.ridgeY - y + 1.2) });
    };
    chim(PH, -2.4, -1.4); chim(PH, 2.6, 1.6); chim(PF, 1.6, -1.1);
    { const [x, z] = toWorld(S, 2.3, -1.7); pr("crates", x, PS.roofY, z, S.yaw + 0.3, { v: 2 }); }
    // cover: the Hermit's roof deck: a crate stack + a barrel clear of the hatch; the Boathouse ridge: a louvred
    // cupola with a fish weather-vane (hard cover on the long roof)
    { const [x, z] = toWorld(E, 1.5, 1.2); pr("crates", x, PE.roofY, z, E.yaw - 0.2, { v: 3 }); }
    { const [x, z] = toWorld(E, -0.3, 1.6); pr("barrel", x, PE.roofY, z, 0, { v: 0 }); }
    { const [x, z] = toWorld(Hb, 0.0, 1.0); pr("cupola", x, PH.ridgeY - 0.45, z, Hb.yaw, { h: 1.75 }); }
    // + a tin vent stack low on the east slope (cover for the lower roof terraces)
    { const lz = 3.6, [x, z] = toWorld(Hb, -2.6, lz); pr("stack", x, roofAt(PH, lz) - 0.3, z, Hb.yaw, { h: 1.75 }); }
    { const [x, z] = toWorld(S, -1.2, 1.9); pr("barrel", x, PS.roofY, z, 0, { v: 1 }); }
  }
  // the smokehouse chimney (stone-and-clay stack through the roof; the smoke plume marks the hero from the plane)
  { const [x, z] = toWorld(K, 1.4, -0.6); pr("chimney", x, PK.roofY - 0.6, z, K.yaw, { h: PK.ridgeY - PK.roofY + 1.9 }); }
  // half-sunk rowboat (the view's foreground), canoes, buoys, lilies, reeds
  pr("rowboat", 565.1, WATER_Y - 0.22, -211.9, 2.55, {});
  pr("canoe", 562.5, WATER_Y - 0.05, -266.5, 1.4, {});
  pr("canoe", 523.5, 0.35, -232.0, 0.35 + Math.PI / 2, {});
  pr("buoy", 566.9, WATER_Y, -210.6, 0, {});
  pr("buoy", 569.5, 0.02, -268.0, 0, { v: 1 });

  // ---------------------------------------------------------------- plants (veg species, planted by the client)
  // canopy ring: tall jungle trees around and between (the cathedral the sun shafts fall through)
  const CANOPY: Array<[number, number, number]> = [
    [540.5, -232.5, 1.35], [546.0, -205.0, 1.25], [566.0, -183.0, 1.3], [588.0, -201.0, 1.2], [599.5, -234.0, 1.35], [622.0, -226.0, 1.25],
    [631.0, -196.0, 1.3], [612.0, -265.0, 1.2], [578.5, -258.5, 1.3], [552.0, -265.0, 1.25], [521.0, -210.0, 1.3], [505.0, -236.0, 1.35],
    [534.0, -172.0, 1.2], [585.0, -168.0, 1.3], [645.0, -186.0, 1.25], [656.0, -236.0, 1.3], [637.5, -258.5, 1.25], [590.0, -275.0, 1.2],
    [512.0, -190.0, 1.2], [617.5, -176.5, 1.25], [660.0, -214.0, 1.2], [497.0, -214.0, 1.3], [553.5, -190.0, 1.1],
  ];
  for (const [x, z, s] of CANOPY) plants.push({ kind: "mangrove", x, z, yaw: rng() * TAU, s: s * 1.35 });
  // mangroves in the shallows (bushy domes on root cages), bigger than the island's
  const MANG: Array<[number, number, number]> = [
    [575.5, -229.5, 1.7], [548.0, -240.5, 1.6], [562.0, -214.5, 1.3], [590.5, -192.0, 1.5], [608.5, -217.0, 1.6], [597.5, -255.0, 1.7],
    [629.0, -243.0, 1.5], [619.0, -205.0, 1.4], [645.5, -225.0, 1.6], [536.5, -222.5, 1.5], [556.0, -175.5, 1.5], [574.0, -190.5, 1.3],
    [517.5, -240.5, 1.6], [527.0, -205.0, 1.5], [598.0, -176.0, 1.4], [634.0, -209.0, 1.3], [585.0, -248.0, 1.5], [611.0, -238.0, 1.3],
    [650.5, -198.5, 1.6], [560.0, -252.0, 1.4], [543.5, -193.5, 1.4], [505.5, -222.0, 1.5], [663.0, -240.0, 1.5], [572.0, -268.5, 1.5],
  ];
  for (const [x, z, s] of MANG) plants.push({ kind: "mangrove", x, z, yaw: rng() * TAU, s });
  // tangle stems carry small mangrove crowns
  TANGLES.forEach(([x, z, s], i) => { if (i % 2 === 0) plants.push({ kind: "mangrove", x, z, yaw: rng() * TAU, s: 0.8 * s }); });
  // understory at the foot of the hero, on the hummocks, in porch corners
  const UND: Array<[Plant["kind"], number, number, number]> = [
    ["monstera", 571.2, -207.4, 1.6], ["fern", 569.9, -205.9, 1.5], ["monstera", 572.8, -210.4, 1.3], ["fern", 571.5, -203.9, 1.3], ["monstera", 569.8, -209.8, 1.2],
    ["monstera", 568.5, -218.2, 1.1], ["banana-plant", 549.0, -217.0, 1.0], ["monstera", 547.5, -226.5, 1.2], ["fern", 552.5, -212.5, 1.2],
    ["monstera", 598.0, -199.0, 1.2], ["fern", 612.5, -199.5, 1.3], ["banana-plant", 646.5, -208.5, 1.0], ["monstera", 636.5, -219.5, 1.1],
    ["fern", 622.5, -252.0, 1.2], ["monstera", 609.0, -255.5, 1.1], ["fern", 533.0, -219.0, 1.3], ["monstera", 521.0, -222.0, 1.1],
    ["fern", 560.5, -233.0, 1.3], ["monstera", 571.5, -238.0, 1.2], ["fern", 590.5, -229.0, 1.4], ["monstera", 594.0, -214.5, 1.3],
    ["fern", 586.5, -206.5, 1.2], ["monstera", 566.0, -247.0, 1.1], ["fern", 553.5, -200.0, 1.3], ["bush", 543.0, -186.5, 1.1],
  ];
  for (const [kind, x, z, s] of UND) plants.push({ kind, x, z, yaw: rng() * TAU, s });
  // keep every plant clear of the decks, huts, stairs and the hero (mangrove root cages spread ~2.9 × scale)
  const foot: Array<{ x: number; z: number; yaw: number; hx: number; hz: number }> = [
    ...decks.map((k) => ({ x: k.x, z: k.z, yaw: k.yaw, hx: k.w / 2, hz: k.d / 2 })),
    ...huts.map((h) => ({ x: h.x, z: h.z, yaw: h.yaw, hx: h.w / 2 + h.overhang, hz: h.d / 2 + h.overhang })),
    ...flights.map((f) => ({ x: f.x + f.dx * f.n * f.tread / 2, z: f.z + f.dz * f.n * f.tread / 2, yaw: dmath.atan2(f.dx, f.dz), hx: f.w / 2, hz: f.n * f.tread / 2 })),
  ];
  const clearance = (x: number, z: number) => {
    let d = dmath.hypot(x - GM.x, z - GM.z) - 12;
    for (const q of foot) {
      const c = dmath.cos(q.yaw), sn = dmath.sin(q.yaw), dx = x - q.x, dz = z - q.z;
      const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
      d = Math.min(d, dmath.hypot(Math.max(0, Math.abs(lx) - q.hx), Math.max(0, Math.abs(lz) - q.hz)));
    }
    return d;
  };
  for (let i = plants.length - 1; i >= 0; i--) {
    const p = plants[i], need = p.kind === "mangrove" ? 1.6 * p.s + 0.6 : 0.5 * p.s;
    if (clearance(p.x, p.z) < need) plants.splice(i, 1);
    else p.y = bedAt(p.x, p.z);
  }

  // ---------------------------------------------------------------- canopy trees (the cathedral over the channels)
  const canopies: MurkLayout["canopies"] = [...canopiesPre];
  const TREES: Array<[number, number, number, number]> = [
    // [x, z, height, crown scale] — around the poi-13-the-murk view's frame first (behind the shack, over the channel, the far bank)
    [548.5, -229.5, 13, 1.25], [546.5, -212.0, 12, 1.1], [571.5, -236.5, 14, 1.3], [556.5, -247.0, 13, 1.15], [578.0, -252.0, 14, 1.2],
    [575.5, -200.5, 12, 1.2], [551.5, -208.0, 11, 1.05], [562.5, -241.5, 12, 1.1], [553.0, -186.0, 13, 1.0], [592.5, -232.0, 14, 1.0], [600.0, -212.5, 15, 1.1], [613.0, -229.5, 14, 1.0],
    [626.0, -215.5, 16, 1.0], [631.5, -251.0, 17, 1.1], [610.0, -186.5, 15, 1.0], [586.0, -186.0, 16, 1.05], [538.5, -205.5, 16, 1.0],
    [520.0, -218.0, 15, 1.0], [534.0, -244.0, 17, 1.1], [652.0, -218.5, 16, 1.0], [596.5, -262.5, 16, 1.0], [575.0, -178.0, 15, 1.0],
  ];
  // THE OUTER RING: tall swamp trees around the core whose crowns frame the walks; they stand in the shallows / on the
  // shores, never in the deep lagoon or on the town plateau
  {
    const rr = mulberry(0x0e1b);
    // (low tree coverage, high visibility: two rings, a tree every ~26 m — denser rings put most of the swamp under
    // leaf cards from the air, so no walk, hut or channel reads from the drop)
    for (const ring of [70, 92]) {
      const n = Math.round(TAU * ring / 26);
      for (let i = 0; i < n; i++) {
        const a = (i + (ring === 92 ? 0.5 : 0) + (rr() - 0.5) * 0.4) / n * TAU, rad = ring + (rr() - 0.5) * 6;
        const x = 577 + dmath.cos(a) * rad * 1.05, z = -213 + dmath.sin(a) * rad * 0.82;
        const g = groundAt(x, z);
        // (mangroves stand in the lagoon's edge too — up to ~2.4 m of water: the dock's view north is not open sea)
        if (g < -2.4 || g > 2.6) continue;
        if (TREES.some(([tx, tz]) => dmath.hypot(tx - x, tz - z) < 9)) continue;
        TREES.push([x, z, 19 + rr() * 6, 1.15 + rr() * 0.25]);
      }
    }
  }
  // between the outer-ring trees (on a 15 m rhythm), the swamp keeps HARD COVER instead of more trees (a root
  // tangle, a fallen trunk or a dead snag — the cover pass below picks by depth / room): the cover rhythm of the walks
  // and shallows without the leaf ceiling
  const RING_COVER: Array<[number, number]> = [];
  {
    const rr = mulberry(0x0e1b);
    for (const ring of [62, 78, 92]) {
      const n = Math.round(TAU * ring / 15);
      for (let i = 0; i < n; i++) {
        const a = (i + (ring === 78 ? 0.5 : 0) + (rr() - 0.5) * 0.4) / n * TAU, rad = ring + (rr() - 0.5) * 6;
        const x = 577 + dmath.cos(a) * rad * 1.05, z = -213 + dmath.sin(a) * rad * 0.82;
        const g = groundAt(x, z);
        if (g < -1.0 || g > 2.6) continue;
        if (TREES.some(([tx, tz]) => dmath.hypot(tx - x, tz - z) < 9)) continue;
        RING_COVER.push([x, z]);
      }
    }
  }
  const trees: MurkLayout["trees"] = [];
  const cages: MurkLayout["cages"] = [...cagesPre];
  const tr = mulberry(0x7ee5);
  for (const [x, z, h, s] of TREES) {
    if (clearance(x, z) < 3.2) continue;
    const g0 = groundAt(x, z), lean = [(tr() - 0.5) * 2.2, (tr() - 0.5) * 2.2];
    const top: V3 = [x + lean[0], g0 + h * 0.66, z + lean[1]];
    roots.push({ pts: [[x, g0 - 1.2, z], [x + lean[0] * 0.15, g0 + 2, z + lean[1] * 0.15], [x + lean[0] * 0.55, g0 + h * 0.36, z + lean[1] * 0.55], top], r0: 0.55 * s + 0.1, r1: 0.3 * s, kind: "trunk" });
    trees.push({ x, z, top, s });
    cages.push({ x, z, r: 2.1 * s + 0.4, y0: BED, y1: g0 + 1.7 });
    const nr = 6 + Math.floor(tr() * 3);
    for (let i = 0; i < nr; i++) {
      // a LONG prop root springs higher: its arch passes over the root mass's edge at ≥ ~2.3 m (a low arch there
      // leaves a crawl-height pocket between it and the buttress foot that traps players)
      const reach = 2.6 + tr() * 2.4, a0 = (i / nr) * TAU + tr() * 0.6;
      let y0 = g0 + 1.4 + tr() * 1.8; if (reach > 3.8) y0 = Math.max(y0, g0 + 2.0);
      // (a tree standing in the deep lagoon has its prop roots under the sea — not modelled: their crown makes sealed,
      // unreachable root-top pockets at the waterline; its root mass still flares)
      if (g0 < -1.0) continue;
      const a = a0, bx = x + lean[0] * 0.1, bz = z + lean[1] * 0.1;
      roots.push({ pts: [[bx + dmath.cos(a) * 0.35, y0, bz + dmath.sin(a) * 0.35], [bx + dmath.cos(a) * reach * 0.4, y0 + 0.35, bz + dmath.sin(a) * reach * 0.4], [bx + dmath.cos(a) * reach * 0.8, g0 + 0.6, bz + dmath.sin(a) * reach * 0.8], [bx + dmath.cos(a) * reach, g0 - 1.0, bz + dmath.sin(a) * reach]], r0: 0.2 * s + 0.06, r1: 0.08, kind: "prop" });
    }
    // (tight crowns — 5.0 s, four limbs reaching 4.5–7 s: gaps of sky between
    // the trees, the channels and walks read from the air and the sun reaches the tea)
    canopies.push({ c: [top[0], top[1] + 3.0 * s, top[2]], r: 5.0 * s });
    const nl = 4;
    for (let i = 0; i < nl; i++) {
      const a = (i / nl) * TAU + tr() * 1.0, reach = (4.5 + tr() * 2.5) * s, y = top[1] - 1.2 + tr() * 2.2;
      const e: V3 = [top[0] + dmath.cos(a) * reach, y + 1.6, top[2] + dmath.sin(a) * reach];
      roots.push({ pts: [[top[0], top[1] - 2.5, top[2]], [top[0] + dmath.cos(a) * reach * 0.5, y + 0.8, top[2] + dmath.sin(a) * reach * 0.5], e], r0: 0.24 * s, r1: 0.1, kind: "limb" });
      canopies.push({ c: [e[0], e[1] + 1.1, e[2]], r: (3.5 + tr() * 1.1) * s });
      if (tr() < 0.7) moss.push({ x: top[0] + dmath.cos(a) * reach * 0.6, y: y + 0.9, z: top[2] + dmath.sin(a) * reach * 0.6, len: 1.4 + tr() * 2.2, w: 0.5 + tr() * 0.4 });
    }
  }

  // ---------------------------------------------------------------- cover pass: hard cover within ~7 m everywhere
  {
    const pts: Array<[number, number]> = [];
    for (const [x, z] of TANGLES) pts.push([x, z]);
    // the buttress giant (its roots reach ~5 m) and the poi-13-the-murk camera's water spot (an open foreground)
    pts.push([571.8, -213.2], [566.5, -205.5]);
    for (const t of trees) pts.push([t.x, t.z]);
    // (veg mangroves are SOFT — their root cages are noShoot — so they do not count as cover; only the big
    // canopy-ring mangroves (scale ≥ 1.5, a trunk you can hide behind) do)
    for (const p of plants) if (p.kind === "mangrove" && p.s >= 1.5) pts.push([p.x, p.z]);
    for (const [a] of LOGS) pts.push([a[0], a[2]]);
    for (const h of huts) pts.push([h.x, h.z]);
    for (const p of props) if (p.kind === "crates" || p.kind === "barrel" || p.kind === "drum" || p.kind === "trap" || p.kind === "logpile") pts.push([p.x, p.z]);
    const hutR = (x: number, z: number) => huts.some((h) => dmath.hypot(h.x - x, h.z - z) < Math.max(h.w, h.d) / 2 + 7);
    const cr = mulberry(0xc0e7);
    const y0Of = (g: number) => Math.max(g, -0.8);
    const near = (x: number, z: number, r: number) => pts.some(([px, pz]) => dmath.hypot(px - x, pz - z) < r) || dmath.hypot(GM.x - x, GM.z - z) < 14 || hutR(x, z);
    // forced spots: cover gaps a real-sim walk scan finds at wading level —
    // the south walk's shallows, the west / east shores, the SW and E channels
    const FORCED: Array<[number, number]> = [[546.5, -156.0], [516.0, -222.0], [569.0, -255.5], [648.5, -209.0], [638.5, -240.0], [582.0, -239.0], [631.0, -227.0], [550.5, -303.5],
      // (greedy picks for the remaining gaps: the south walk's shallows, the shack's
      // west shallows, the SW + south lagoon flats (wading over the silt shelf), the west shore)
      [542.5, -152.5], [551.5, -229.5], [501.5, -290.5], [548.5, -307.5], [536.8, -306.5], [558.5, -311.5], [476.5, -182.5], [542.5, -214.5], [619.5, -208.5], [621.5, -249.5], [603.5, -233.5], [630.5, -223.5],
      [501.5, -212.3], [541.5, -148.5], [612.5, -275.5], [504.5, -216.5], [498.0, -207.5], [544.5, -146.0], [538.5, -151.0], [536.5, -141.0], [487.5, -275.5]];
    // beside the walks where a deck run has no cover within 8 m: a tall dead snag 2.2 m off the walk's side (the side
    // with more room), it shields a kong standing on the planks
    for (const [wx, wz] of [[568.5, -225.5], [539.5, -217.5], [632.5, -225.6], [628.3, -242.3], [550.5, -167.5]] as Array<[number, number]>) {
      const k = decks.find((q) => inRect(q, wx, wz, 0.3)); if (!k) continue;
      const c = dmath.cos(k.yaw), sn = dmath.sin(k.yaw), lz = (wx - k.x) * sn + (wz - k.z) * c;
      const cand = [1, -1].map((sd) => toWorld(k, sd * (k.w / 2 + 2.2), lz)).sort((a, b) => clearance(b[0], b[1]) - clearance(a[0], a[1]));
      FORCED.push(cand[0] as [number, number]);
    }
    const place = (x: number, z: number, forced: boolean): void => {
      if (dmath.hypot(x - CX, z - CZ) > 92 && !forced) return;
        // (forced points stand on the wadeable bed: the silt shelf over the deep lagoon flats counts)
        const g = forced ? Math.max(groundAt(x, z), shelfTop(x, z)) : groundAt(x, z);
        if (g < -1.0 || g > (forced ? 4.2 : 3.2)) return;           // deep lagoon / the plateau (the town's edge) — not swamp
        if (!forced && near(x, z, 7)) return;
        const cl = clearance(x, z);
        if (cl < 1.6) return;
        // on the DRY shore (bed above 1 m) the swamp kit's water-level tangles / logs would be buried in the bank
        // (invisible colliders, no cover): a fallen trunk lying ON the ground, its root plate up-ended, or a dead snag
        if (g > 1.0) {
          const a = cr() * TAU, L = 4 + cr() * 2.5, r = 0.58 + cr() * 0.14;
          const ax = x - dmath.cos(a) * L / 2, az = z - dmath.sin(a) * L / 2, bx = x + dmath.cos(a) * L / 2, bz = z + dmath.sin(a) * L / 2;
          const ga = groundAt(ax, az), gb = groundAt(bx, bz);
          if (Math.abs(ga - gb) < 1.0 && Math.abs(ga - g) < 0.8 && clearance(ax, az) > 2 && clearance(bx, bz) > 2) {
            roots.push({ pts: [[ax, ga + r * 0.8, az], [x, g + r * 0.85, z], [bx, gb + r * 0.75, bz]], r0: r, r1: r * 0.85, kind: "log" });
            roots.push({ pts: [[ax, ga - 0.5, az], [ax - dmath.cos(a) * 0.3, ga + 1.3, az - dmath.sin(a) * 0.3], [ax - dmath.cos(a) * 0.5, ga + 2.0, az - dmath.sin(a) * 0.5]], r0: 0.48, r1: 0.26, kind: "trunk" });
          } else {
            const hgt = 3 + cr() * 2;
            roots.push({ pts: [[x, g - 0.8, z], [x + (cr() - 0.5) * 0.3, g + hgt * 0.5, z + (cr() - 0.5) * 0.3], [x + (cr() - 0.5) * 0.6, g + hgt, z + (cr() - 0.5) * 0.6]], r0: 0.55, r1: 0.3, kind: "trunk" });
          }
          pts.push([x, z]);
          return;
        }
        if (cl < 3.2) {
          // tight spot beside a walk: a dead snag only (thin, no root cage)
          const hgt = 2.6 + cr() * 2;
          roots.push({ pts: [[x, y0Of(g) - 0.8, z], [x + (cr() - 0.5) * 0.2, WATER_Y + hgt * 0.5, z + (cr() - 0.5) * 0.2], [x + (cr() - 0.5) * 0.4, WATER_Y + hgt, z + (cr() - 0.5) * 0.4]], r0: 0.5, r1: 0.28, kind: "trunk" });
          pts.push([x, z]);
          return;
        }
        const q = forced && g < -0.2 ? 0.9 : cr(), y0 = Math.max(g, -0.8);
        if (q < 0.45) {
          const sc = 0.85 + cr() * 0.3;
          tangle(x, z, sc, 0xd000 + pts.length);
          cages.push({ x, z, r: 1.5 * sc + 0.35, y0: BED, y1: sc * 1.6 + 0.9 });
        } else if (q < 0.8) {
          // a fallen trunk (1.0–1.3 m tall), its root plate up-ended at one end
          const a = cr() * TAU, L = 4 + cr() * 3, r = 0.5 + cr() * 0.2;
          const ax = x - dmath.cos(a) * L / 2, az = z - dmath.sin(a) * L / 2, bx = x + dmath.cos(a) * L / 2, bz = z + dmath.sin(a) * L / 2;
          if (groundAt(ax, az) < -0.9 || groundAt(bx, bz) < -0.9 || clearance(ax, az) < 2 || clearance(bx, bz) < 2) return;
          roots.push({ pts: [[ax, WATER_Y + 0.3, az], [x, WATER_Y + 0.42, z], [bx, WATER_Y + 0.28, bz]], r0: r, r1: r * 0.85, kind: "log" });
          roots.push({ pts: [[ax, y0 - 0.5, az], [ax - dmath.cos(a) * 0.3, WATER_Y + 1.2, az - dmath.sin(a) * 0.3], [ax - dmath.cos(a) * 0.5, WATER_Y + 1.9, az - dmath.sin(a) * 0.5]], r0: 0.45, r1: 0.25, kind: "trunk" });
        } else {
          // a dead snag: a broken grey trunk 3–5 m tall
          const hgt = 3 + cr() * 2;
          roots.push({ pts: [[x, y0 - 0.8, z], [x + (cr() - 0.5) * 0.3, WATER_Y + hgt * 0.5, z + (cr() - 0.5) * 0.3], [x + (cr() - 0.5) * 0.6, WATER_Y + hgt, z + (cr() - 0.5) * 0.6]], r0: 0.55, r1: 0.3, kind: "trunk" });
        }
        pts.push([x, z]);
    };
    // (planned cover picks for the thinned canopy — the SW shore outside the outer ring, the
    // south walk's shallows, the boathouse channel, the stilt house's south shallows)
    const PLAN: Array<[number, number]> = [[528.5, -138.5], [515.5, -144.5], [537.5, -135.5], [505.5, -146.5], [539.5, -223.5], [508.5, -239.5], [543.5, -130.5],
      [546.5, -167.5], [523.5, -231.5], [621.5, -249.5], [535.5, -133.5], [553.5, -128.5], [519.0, -139.5], [524.5, -140.5], [513.5, -143.5], [549.5, -177.5]];
    for (const [x, z] of [...FORCED, ...PLAN, ...RING_COVER]) place(x, z, true);
    for (let gz = CZ - 92; gz <= CZ + 92; gz += 4.5) for (let gx = CX - 92; gx <= CX + 92; gx += 4.5) place(gx + (cr() - 0.5) * 3, gz + (cr() - 0.5) * 3, false);
  }

  // ---------------------------------------------------------------- the rope bridge: Crow's Nest → Stilt House roof
  const bA: V3 = [GM.x + GM.platH - 0.1, GM.platY, GM.z - 3.8];
  const sRoof = toWorld(S, -S.w / 2 + 0.6, 0.4);
  const bB: V3 = [sRoof[0], PS.roofY + 0.0, sRoof[1]];
  const bl = dmath.hypot(bB[0] - bA[0], bB[2] - bA[2]);
  const bridge = { a: bA, b: bB, w: 1.5, sag: 0.9, n: Math.ceil(bl / 0.34) };

  // ---------------------------------------------------------------- mooring lines + moss anchors
  ropes.push({ a: [563.4, WATER_Y + 0.25, -210.4], b: [561.6, WALK_Y - 0.1, -208.5], sag: 0.35 });
  // moss curtains off the Crow's Nest's south + west fascia (hanging moss over the upper right of the view; they
  // also break the platform's straight underside line seen from the channel)
  for (let i = 0; i < 26; i++) {
    const u = -GM.platH + 0.3 + gr() * (GM.platH * 2 - 0.6), west = i % 2 === 0;
    moss.push({ x: GM.x + (west ? -GM.platH - 0.08 : u), y: GM.platY - 0.3, z: GM.z + (west ? u : GM.platH + 0.08), len: 1.6 + gr() * 3.2, w: 0.55 + gr() * 0.5 });
  }
  for (let i = 0; i < 44; i++) {
    const a = gr() * TAU, r = 4 + gr() * 10, y = 16 + gr() * 5;
    moss.push({ x: GM.x + dmath.cos(a) * r, y, z: GM.z + dmath.sin(a) * r, len: 1.4 + gr() * 2.4, w: 0.5 + gr() * 0.5 });
  }

  // walkable roofs keep a clear sky: crown lobes over a hut's roof sit ≥ ~3.4 m above it (no leaf cards in a player's face)
  for (const c of canopies) for (const p of parts) {
    const h = p.h, top = h.roof === "flat" ? p.roofY : p.ridgeY;
    if (dmath.hypot(c.c[0] - h.x, c.c[2] - h.z) > c.r + dmath.hypot(h.w, h.d) / 2) continue;
    c.c[1] = Math.max(c.c[1], top + 3.4 + c.r * 0.55);
  }
  fixRails(decks, flights);
  // keep stair heads + door approaches clear of cover props
  {
    const zones: Array<{ x: number; z: number; yaw: number; w: number; d: number }> = [];
    for (const f of flights) { const run = f.n * f.tread; zones.push({ x: f.x + f.dx * (run / 2 - 0.6), z: f.z + f.dz * (run / 2 - 0.6), yaw: dmath.atan2(f.dx, f.dz), w: f.w + 1.2, d: run + 2.4 }); }
    for (const h of huts) for (const o of h.openings) {
      if (o.kind !== "door" && o.kind !== "wide") continue;
      const S = [[0, 1, h.w], [1, 0, h.d], [0, -1, h.w], [-1, 0, h.d]][o.side];
      const len = S[2], u = o.u + o.w / 2 - len / 2;
      const along: V2 = o.side === 0 ? [u, h.d / 2] : o.side === 1 ? [h.w / 2, -u] : o.side === 2 ? [-u, -h.d / 2] : [-h.w / 2, u];
      for (const out of [1.1, -1.1]) {
        const [x, z] = toWorld(h, along[0] + S[0] * out, along[1] + S[1] * out);
        zones.push({ x, z, yaw: h.yaw, w: o.side % 2 === 0 ? o.w + 0.8 : 2.2, d: o.side % 2 === 0 ? 2.2 : o.w + 0.8 });
      }
    }
    for (let i = props.length - 1; i >= 0; i--) {
      const p = props[i];
      // (roof-deck props stand ≥ 2.5 m over every door's threshold: not in its way)
      if (!["crates", "barrel", "drum", "trap", "logpile", "sign", "netrack", "lantern"].includes(p.kind) || p.h !== undefined && p.kind === "crates" && p.y > 10 || p.y > 4.2) continue;
      if (zones.some((q) => inRect(q, p.x, p.z, 0.55))) props.splice(i, 1);
    }
    // interior furniture must not block a doorway (1.8 m inside each door) — dropped + reported in DROPPED
    for (const h of huts) h.furniture = h.furniture.filter((f) => {
      if (f.col === false || f.kind === "boat") return true;
      for (const o of h.openings) {
        if ((o.kind !== "door" && o.kind !== "wide") || Math.abs(o.floor * h.floorH - f.y) > 0.5) continue;
        const len = o.side % 2 === 0 ? h.w : h.d, u = o.u + o.w / 2 - len / 2;
        // door zone in local coords: across the opening (w + 0.5), 1.8 m deep inward from the wall
        const [cx, cz, hx, hz] = o.side === 0 ? [u, h.d / 2 - 0.9, o.w / 2 + 0.25, 0.9] : o.side === 2 ? [-u, -h.d / 2 + 0.9, o.w / 2 + 0.25, 0.9] : o.side === 1 ? [h.w / 2 - 0.9, -u, 0.9, o.w / 2 + 0.25] : [-h.w / 2 + 0.9, u, 0.9, o.w / 2 + 0.25];
        const fr = Math.max(f.w, f.d) / 2;
        if (Math.abs(f.x - cx) < hx + fr && Math.abs(f.z - cz) < hz + fr) { DROPPED.push(`${h.id}: ${f.kind} @(${f.x},${f.z}) blocks door side ${o.side}`); return false; }
      }
      return true;
    });
    // interior furniture must not sit on a flight's footprint either
    for (const h of huts) h.furniture = h.furniture.filter((f) => f.col === false || !h.stairs.some((st) => { const run = Math.round((h.loft && h.floors === 1 ? h.loft.h : h.floorH) / 0.2) * 0.27; const x0 = Math.min(st.x, st.x + st.dir * run) - 0.5, x1 = Math.max(st.x, st.x + st.dir * run) + 0.9; const hit = Math.abs(f.y - st.floor * h.floorH) < 0.5 && f.x + f.w / 2 > x0 && f.x - f.w / 2 < x1 && Math.abs(f.z - st.z) < st.w / 2 + f.d / 2 + 0.3; if (hit) DROPPED.push(`${h.id}: ${f.kind} @(${f.x},${f.z}) on a stair`); return hit; }));
  }
  for (const [x, z, sc] of TANGLES) cages.push({ x, z, r: 1.5 * sc + 0.35, y0: BED, y1: sc * 1.6 + 0.9 });
  // drop crown lobes buried inside a bigger lobe (centre within 0.5 r of it): they add stacked leaf-card layers
  // (the crown's overdraw = its GPU cost) without changing the canopy's silhouette or cover
  const kept = canopies.filter((a) => !canopies.some((b) => b !== a && b.r > a.r + 0.01 && dmath.hypot3(a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2]) < b.r * 0.5));
  canopies.length = 0; canopies.push(...kept);
  return { decks, flights, huts, parts, roots, props, plants, bridge, spiral, ropes, moss, trees, canopies, cages };
}

/** point in an oriented rect (three.js frame yaw), grown by m */
function inRect(k: { x: number; z: number; yaw: number; w: number; d: number }, x: number, z: number, m = 0): boolean {
  const c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), dx = x - k.x, dz = z - k.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) <= k.w / 2 + m && Math.abs(lz) <= k.d / 2 + m;
}
/** rails follow the network, never block it: every rail sample that lies on another deck / walk / flight footprint (or
 *  on a deck the walk overlaps) is removed, so walks open onto the decks they join and decks open where walks and
 *  stairs meet them. Spans shorter than 0.6 m are dropped. */
function fixRails(decks: MDeck[], flights: Flight[]) {
  const fr = flights.map((f) => { const run = f.n * f.tread; return { x: f.x + f.dx * run / 2, z: f.z + f.dz * run / 2, yaw: dmath.atan2(f.dx, f.dz), w: f.w + 0.2, d: run + 0.3, y: f.yTop }; });
  const bR = new Map(decks.map((o) => [o, dmath.pow(o.w + o.d, 2) / 4 + 0.5]));
  for (const k of decks) {
    const r = k.rails; if (!r) continue;
    for (const key of ["nx", "px", "nz", "pz"] as const) {
      const spans = r[key]; if (!spans) continue;
      const len = key === "nx" || key === "px" ? k.d : k.w;
      const list: V2[] = spans === true ? [[0, len]] : spans;
      const out: V2[] = [];
      for (const [a, b] of list) {
        let cur: number | null = null;
        for (let u = a; u <= b + 1e-6; u += 0.1) {
          const q = Math.min(u, b) - len / 2;
          const [lx, lz] = key === "nx" ? [-k.w / 2, q] : key === "px" ? [k.w / 2, q] : key === "nz" ? [q, -k.d / 2] : [q, k.d / 2];
          const [x, z] = toWorld(k, lx, lz);
          let blocked = false;
          // (bounding-circle reject first: this ran 27 ms of the module's import on the client's main thread)
          for (const o of decks) if (o !== k && Math.abs(o.y - k.y) < 0.75 && dmath.pow(x - o.x, 2) + dmath.pow(z - o.z, 2) < bR.get(o)! && inRect(o, x, z, 0.12)) { blocked = true; break; }
          if (!blocked) for (const f of fr) if (Math.abs(f.y - k.y) < 0.3 && dmath.pow(x - f.x, 2) + dmath.pow(z - f.z, 2) < dmath.pow(f.w + f.d, 2) / 4 + 0.5 && inRect(f, x, z, 0.1)) { blocked = true; break; }
          if (!blocked && cur === null) cur = Math.min(u, b);
          if ((blocked || u >= b - 1e-6) && cur !== null) { const e = blocked ? u - 0.1 : b; if (e - cur > 0.6) out.push([cur, e]); cur = null; }
        }
      }
      r[key] = out;
    }
  }
}

/** THE MURK's swamp water surface at (x, z) for gameplay / audio (wading footsteps, splashes): WATER_Y over the swamp
 *  bed inside the POI core, null elsewhere (the client's drawn surface eases down to the sea at the NE lagoon — this is
 *  the plateau value, exact wherever a kong can wade). */
export function swampWaterAt(x: number, z: number): number | null {
  if (Math.abs(x - 577) > 100 || Math.abs(z + 213) > 72) return null;
  const g = groundAt(x, z);
  return g < WATER_Y && g > -1.2 ? WATER_Y : null;
}

// ================================================================================================ interiors (kit)
/** per hut: the style / role / finish of each storey (floor 0 up); huts not listed keep their own furniture */
// every murk room keeps the hut's own vertical BOARD lining (wall: null — the kit's "panel" skin is its floor-board
// texture stood on end reads as big tiles), with the kit's baseboards + window / door casings
const HUT_FINISH: Partial<RoomFinish> = { glass: false, curtains: false, wall: null, baseboard: true, frames: true };
const ROOM_PLAN: Record<string, Array<{ style: InteriorStyle; role: RoomRole; finish?: Partial<RoomFinish>; openTop?: boolean; density?: number }>> = {
  shack: [{ style: "hut", role: "fisher", openTop: true }],
  bait: [{ style: "shop", role: "general", finish: { floor: "boards", dado: "#4f6b5a", ceiling: "beams", shell: false } }, { style: "hut", role: "bunk" }],
  stilt: [{ style: "house", role: "kitchen", finish: { floor: "boards", ceiling: "beams", shell: false } }, { style: "hut", role: "bunk" }],
  boathouse: [{ style: "warehouse", role: "workshop", openTop: true, finish: { floor: "boards", ceiling: "none", shell: false }, density: 1 }],
  hermit: [{ style: "hut", role: "fisher" }],
};
function hutRooms(p: HutParts): InteriorRoom[] {
  const h = p.h, plan = ROOM_PLAN[h.id];
  if (!plan) return [];
  const iw = h.w - 2 * h.t, id = h.d - 2 * h.t, out: InteriorRoom[] = [];
  for (let f = 0; f < h.floors; f++) {
    const pl = plan[Math.min(f, plan.length - 1)];
    const openings: RoomOpening[] = [];
    for (const o of h.openings) {
      if (o.floor !== f || o.kind === "hatch") continue;
      const len = o.side % 2 === 0 ? h.w : h.d, u = o.u + o.w / 2 - len / 2;
      const at = o.side === 0 ? u : o.side === 1 ? -u : o.side === 2 ? -u : u;
      openings.push(o.kind === "window" ? { side: o.side as 0 | 1 | 2 | 3, at, w: o.w, kind: "window", y0: o.y, h: o.h } : { side: o.side as 0 | 1 | 2 | 3, at, w: o.w, kind: "door", h: Math.min(o.h, 2.3) });
    }
    const keepOut: NonNullable<InteriorRoom["keepOut"]> = [];
    for (const s of h.stairs) {
      const run = Math.round((h.loft && h.floors === 1 ? h.loft.h : h.floorH) / 0.2) * 0.27, x0 = s.x, x1 = s.x + s.dir * run;
      const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)], z0 = s.z - s.w / 2 - 0.15, z1 = s.z + s.w / 2 + 0.15;
      // flights run along a wall: the foot / the arrival are reached from the room side (toward the room's centre in z),
      // everything clamped into the room
      const cl = (r: [number, number, number, number]): [number, number, number, number] => [Math.max(-iw / 2, r[0]), Math.max(-id / 2, r[1]), Math.min(iw / 2, r[2]), Math.min(id / 2, r[3])];
      const inward = s.z < 0 ? 1 : -1, zi0 = inward > 0 ? z0 : z0 - 1.3, zi1 = inward > 0 ? z1 + 1.3 : z1;
      const foot = x0, head = x1;
      if (s.floor === f) {
        keepOut.push(cl([a - 0.1, z0, b + 0.1, z1]));
        // the approach to the foot of the flight stays walkable
        keepOut.push({ r: cl([foot - 0.75 - (s.dir > 0 ? 0.6 : 0), zi0, foot + 0.75 + (s.dir < 0 ? 0.6 : 0), zi1]), walk: true });
      }
      if (s.floor + 1 === f) {
        // the stair hole + the arrival beyond its top (reached from the room side)
        keepOut.push(cl([a - 0.3, z0 - 0.2, b + 0.3, z1 + 0.2]));
        keepOut.push({ r: cl([head - 0.75 - (s.dir < 0 ? 0.5 : 0), zi0, head + 0.75 + (s.dir > 0 ? 0.5 : 0), zi1]), walk: true });
      }
    }
    if (f === 0 && h.slip) keepOut.push([h.slip.x0 - 0.3, h.slip.z0 - 0.3, h.slip.x1 + 0.3, h.slip.z1 + 0.3]);
    // the hut's own kept furniture on this storey (solid: the kit treats it as a wall)
    for (const fu of h.furniture) if (fu.keep && Math.abs(fu.y - f * h.floorH) < 0.5) { const hw = Math.max(fu.w, fu.d) / 2 + 0.1; keepOut.push({ r: [fu.x - hw, fu.z - hw, fu.x + hw, fu.z + hw], solid: true }); }
    if (f === 0 && h.loft) keepOut.push([-iw / 2, h.loft.z0 - 0.4, iw / 2, h.loft.z1]);
    const y = h.y + f * h.floorH, top = f === h.floors - 1 && h.roof !== "flat" ? p.roofY - y : h.floorH - 0.24;
    // the stair wells are cut out of the kit's ceiling + beams above and its floor boards below (otherwise the flight
    // vanishes into a plain ceiling / floor)
    const wells = (fl: number) => stairHoles(h).filter((q) => q.floor === fl).map((q) => [q.x0, q.z0, q.x1, q.z1] as [number, number, number, number]);
    out.push({ id: `murk-${h.id}-${f}`, x: h.x, y, z: h.z, yaw: h.yaw, w: iw, d: id, h: Math.min(top, 3.4), style: pl.style, role: pl.role, seed: h.seed * 7 + f,
      openings, keepOut, density: pl.density, wallT: h.t, openTop: pl.openTop && f === h.floors - 1, finish: { ...HUT_FINISH, ...pl.finish },
      ceilHoles: wells(f + 1), floorHoles: wells(f) });
  }
  return out;
}

/** layout-time warnings (dropped furniture etc.) */
export const DROPPED: string[] = [];
export const LAYOUT: MurkLayout = genLayout();
const LAYOUT_DECKS = LAYOUT.decks;
/** THE MURK's furnished storeys (interiors kit): one room per hut storey — colliders + loot candidates + the client's drawing */
export const INTERIOR_ROOMS: InteriorRoom[] = LAYOUT.parts.flatMap(hutRooms);

// ================================================================================================ room dressing
/** THE MURK's storytelling props ON TOP of the interiors kit's furniture (the kit furnishes; these make the room a
 *  fisherman's / boat-wright's place): wall-hung gear (oars, rods, a mounted catfish, a gator skull, charts, tool board …),
 *  low floor clutter (buckets, tackle boxes, boots, firewood by the stove …; ≤ 0.5 m, stepped over like the kit's clutter)
 *  and a few solid pieces with colliders (sawhorse, outboard stand, trap stack). Placed deterministically along the
 *  room's walls clear of openings, door approaches, keep-outs and every kit item (furnishRoom is deterministic). */
export type DressKind = "stove" | "flue" | "oars" | "rods" | "trophy" | "ropecoil" | "chart" | "fishline" | "skull" | "handnet" | "lantern-wall" | "floats" | "toolboard" | "propeller" | "sign"
  | "bucket" | "tacklebox" | "boots" | "firewood" | "bottles" | "cooler" | "jerrycan" | "paintcans" | "planks" | "anchor" | "traps" | "sawhorse" | "outboard" | "tabletop";
export interface Dress { room: string; kind: DressKind; x: number; z: number; y: number; yaw: number; w: number; d: number; h: number; col: boolean; v: number }
const DRESS_SIZE: Record<DressKind, [number, number, number, number]> = {
  // w (along the wall), d (out of the wall), h, centre height (wall-hung) or 0 (floor)
  oars: [1.5, 0.12, 0.5, 1.85], rods: [1.3, 0.12, 0.7, 1.75], trophy: [0.9, 0.18, 0.42, 1.95], ropecoil: [0.5, 0.14, 0.55, 1.6], chart: [0.9, 0.04, 0.65, 1.7],
  fishline: [1.1, 0.12, 0.6, 1.75], skull: [0.7, 0.2, 0.32, 2.05], handnet: [0.55, 0.12, 1.1, 1.55], "lantern-wall": [0.3, 0.3, 0.45, 2.0], floats: [1.2, 0.18, 0.5, 2.0],
  toolboard: [1.4, 0.12, 0.95, 1.6], propeller: [0.6, 0.14, 0.6, 2.0], sign: [1.3, 0.05, 0.42, 2.35],
  bucket: [0.34, 0.34, 0.36, 0], tacklebox: [0.5, 0.3, 0.26, 0], boots: [0.4, 0.32, 0.38, 0], firewood: [0.7, 0.42, 0.42, 0], bottles: [0.36, 0.26, 0.34, 0],
  cooler: [0.62, 0.4, 0.44, 0], jerrycan: [0.36, 0.2, 0.46, 0], paintcans: [0.55, 0.3, 0.28, 0], planks: [1.9, 0.5, 0.32, 0], anchor: [0.6, 0.35, 0.45, 0],
  traps: [0.9, 0.62, 1.05, 0], sawhorse: [1.6, 0.6, 0.82, 0], outboard: [0.7, 0.6, 1.25, 0], tabletop: [0, 0, 0, 0],
  stove: [0.75, 0.65, 0.95, 0], flue: [0, 0, 0, 0],
};
const DRESS_PLAN: Record<string, DressKind[]> = {
  "murk-shack-0": ["firewood", "trophy", "oars", "rods", "skull", "chart", "fishline", "handnet", "ropecoil", "lantern-wall", "bucket", "tacklebox", "boots", "cooler", "bottles", "jerrycan", "tabletop"],
  "murk-boathouse-0": ["stove", "sawhorse", "outboard", "traps", "toolboard", "sign", "propeller", "oars", "floats", "ropecoil", "handnet", "lantern-wall", "lantern-wall", "chart", "planks", "paintcans", "anchor", "jerrycan", "bucket", "tacklebox", "cooler"],
  "murk-hermit-0": ["skull", "trophy", "fishline", "lantern-wall", "rods", "bucket", "boots", "bottles", "firewood", "tabletop"],
  "murk-bait-0": ["trophy", "rods", "floats", "handnet", "sign", "bucket", "tacklebox", "cooler", "traps"],
  "murk-bait-1": ["oars", "fishline", "chart", "lantern-wall", "boots", "jerrycan", "tabletop"],
  "murk-stilt-1": ["rods", "skull", "ropecoil", "lantern-wall", "bucket", "boots", "tabletop"],
};
function dressRoom(room: InteriorRoom): Dress[] {
  const plan = DRESS_PLAN[room.id ?? ""]; if (!plan) return [];
  const L = furnishRoom(room), out: Dress[] = [];
  const W = room.w, D = room.d, rng = mulberry((room.seed ?? 1) * 7919 + 17);
  type R = { x0: number; z0: number; x1: number; z1: number; y0: number; y1: number };
  const taken: R[] = L.items.map((it) => { const r = itemRect(it); return { ...r, y0: it.y, y1: it.y + it.h }; });
  // (keep-outs — stairs, the loft's underside, the boat slip — are kept clear at floor level; gear may hang on the walls above)
  for (const k of room.keepOut ?? []) { const r = Array.isArray(k) ? k : k.r; taken.push({ x0: r[0], z0: r[1], x1: r[2], z1: r[3], y0: 0, y1: 1.25 }); }
  // door approaches (1.0 m deep, the door width + 0.3)
  const sideRect = (s: number, a0: number, a1: number, off0: number, off1: number): { x0: number; z0: number; x1: number; z1: number } =>
    s === 0 ? { x0: a0, x1: a1, z0: D / 2 - off1, z1: D / 2 - off0 } : s === 1 ? { x0: W / 2 - off1, x1: W / 2 - off0, z0: a0, z1: a1 } : s === 2 ? { x0: a0, x1: a1, z0: -D / 2 + off0, z1: -D / 2 + off1 } : { x0: -W / 2 + off0, x1: -W / 2 + off1, z0: a0, z1: a1 };
  for (const o of room.openings) if (o.kind !== "window") taken.push({ ...sideRect(o.side, o.at - o.w / 2 - 0.3, o.at + o.w / 2 + 0.3, 0, 1.1), y0: 0, y1: 9 });
  const hit = (a: R) => taken.some((b) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0 && a.y0 < b.y1 && a.y1 > b.y0);
  const sideYawOf = (s: number) => (s === 0 ? Math.PI : s === 1 ? -Math.PI / 2 : s === 2 ? 0 : Math.PI / 2);
  const stove = L.items.find((i) => i.kind === "wood-stove");
  for (const kind of plan) {
    const [w, d, h, cy] = DRESS_SIZE[kind];
    if (kind === "tabletop") {
      const t = L.items.find((i) => i.kind === "table");
      if (t) out.push({ room: room.id!, kind, x: t.x, z: t.z, y: t.h, yaw: t.yaw, w: t.w, d: t.d, h: 0.3, col: false, v: rng() });
      continue;
    }
    const wallHung = cy > 0;
    // candidate (side, along) slots: firewood hugs the stove; otherwise every wall in 0.15 m steps, seeded order
    const cands: Array<[number, number]> = [];
    for (let s = 0; s < 4; s++) { const Lw = s % 2 === 0 ? W : D; for (let a = -Lw / 2 + w / 2 + 0.1; a <= Lw / 2 - w / 2 - 0.1; a += 0.15) cands.push([s, a]); }
    for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
    if (kind === "firewood" && stove) cands.sort((p, q) => { const P = sideRect(p[0], p[1] - w / 2, p[1] + w / 2, 0, d), Q = sideRect(q[0], q[1] - w / 2, q[1] + w / 2, 0, d); return dmath.hypot((P.x0 + P.x1) / 2 - stove.x, (P.z0 + P.z1) / 2 - stove.z) - dmath.hypot((Q.x0 + Q.x1) / 2 - stove.x, (Q.z0 + Q.z1) / 2 - stove.z); });
    // wall gear: at its usual height, else hung higher (over the window heads) where the room is tall enough
    let placed = false;
    for (const lift of wallHung ? [0, 0.7] : [0]) for (const [s, a] of placed ? [] : cands) {
      const y0 = wallHung ? cy + lift - h / 2 : 0, y1 = wallHung ? cy + lift + h / 2 : h;
      if (y1 > room.h - 0.12) continue;
      const ops = room.openings.filter((o) => o.side === s);
      // never across an opening (wall-hung: a window's full height band; floor: doors only, windows are above 1 m)
      if (ops.some((o) => a + w / 2 + 0.08 > o.at - o.w / 2 && a - w / 2 - 0.08 < o.at + o.w / 2 && (o.kind !== "window" || y1 > (o.y0 ?? 1) - 0.05))) continue;
      const r = { ...sideRect(s, a - w / 2, a + w / 2, 0.02, d + 0.06), y0, y1 };
      if (hit(r)) continue;
      taken.push(r);
      const off = d / 2 + 0.02;
      const cx = s === 0 ? a : s === 1 ? W / 2 - off : s === 2 ? a : -W / 2 + off, cz = s === 0 ? D / 2 - off : s === 1 ? a : s === 2 ? -D / 2 + off : a;
      const solid = kind === "traps" || kind === "sawhorse" || kind === "outboard" || kind === "stove";
      out.push({ room: room.id!, kind, x: cx, z: cz, y: y0, yaw: sideYawOf(s), w, d, h, col: solid, v: rng() });
      placed = true;
      break;
    }
  }
  return out;
}
export const ROOM_DRESS: Dress[] = INTERIOR_ROOMS.flatMap(dressRoom);
// every stove (the kit's wood stoves, the boathouse's dressing stove) gets its flue pipe, and the hut's roof chimney is
// moved to stand right over it (a stove that lines up with the chimney)
{
  const chims = LAYOUT.props.filter((p) => p.kind === "chimney");
  for (const room of INTERIOR_ROOMS) {
    const part = LAYOUT.parts.find((p) => room.id === `murk-${p.h.id}-${p.h.floors - 1}` && p.h.roof !== "flat");
    if (!part) continue;
    const st = [...furnishRoom(room).items.filter((i) => i.kind === "wood-stove").map((i) => ({ x: i.x, z: i.z, top: i.h })), ...ROOM_DRESS.filter((d) => d.room === room.id && d.kind === "stove").map((d) => ({ x: d.x, z: d.z, top: d.h }))];
    for (const s of st) {
      const h = part.h, lz = Math.max(-h.d / 2 + 0.55, Math.min(h.d / 2 - 0.55, s.z)), lx = Math.max(-h.w / 2 + 0.55, Math.min(h.w / 2 - 0.55, s.x));
      const roofY = roofAt(part, lz), [wx, wz] = toWorld(h, lx, lz);
      // the hut's nearest chimney moves over the stove
      let best: MProp | null = null, bd = 1e9;
      for (const c of chims) { const d = dmath.hypot(c.x - h.x, c.z - h.z); if (d < Math.max(h.w, h.d) && d < bd + 1e9) { const dd = dmath.hypot(c.x - wx, c.z - wz); if (dd < bd) { bd = dd; best = c; } } }
      if (best) { best.x = wx; best.z = wz; best.y = roofY - 0.35; best.h = Math.max(1.9, part.ridgeY - best.y + 1.2); chims.splice(chims.indexOf(best), 1); }
      ROOM_DRESS.push({ room: room.id!, kind: "flue", x: s.x, z: s.z, y: s.top, yaw: 0, w: 0.16, d: 0.16, h: roofY - room.y - s.top, col: false, v: 0 });
    }
  }
  // a chimney left without a stove (its hut has fewer stoves than chimneys) is removed
  for (const c of chims) if (LAYOUT.parts.some((p) => p.h.roof !== "flat" && p.h.id !== "smokehouse" && dmath.hypot(c.x - p.h.x, c.z - p.h.z) < Math.max(p.h.w, p.h.d))) LAYOUT.props.splice(LAYOUT.props.indexOf(c), 1);
}
/** colliders of the solid dressing pieces (axis-aligned in the room frame: every piece faces a wall) */
function dressBoxes(): Box[] {
  const out: Box[] = [];
  for (const dr of ROOM_DRESS) {
    if (!dr.col) continue;
    const room = INTERIOR_ROOMS.find((r) => r.id === dr.room)!, along = Math.abs(dmath.sin(dr.yaw)) > 0.5;
    const hx = (along ? dr.d : dr.w) / 2, hz = (along ? dr.w : dr.d) / 2;
    out.push(lbox(room, dr.x - hx, dr.z - hz, dr.x + hx, dr.z + hz, room.y + dr.y, room.y + dr.y + dr.h, "wood"));
  }
  return out;
}

// ================================================================================================ colliders
const railBoxes = (k: MDeck, out: Box[]) => {
  const r = k.rails ?? {};
  const side = (spans: boolean | V2[] | undefined, key: "nx" | "px" | "nz" | "pz") => {
    if (!spans) return;
    const len = key === "nx" || key === "px" ? k.d : k.w;
    const list: V2[] = spans === true ? [[0, len]] : spans;
    for (const [a0, b0] of list) {
      if (b0 - a0 < 0.3) continue;
      // the rope rails are SOFT (rope sags between log posts over wading-deep tea — a kong may hop the ropes into
      // the shallows); only the drawn posts collide — exactly deck.ts addRail's posts (every ~2.2 m, r 0.075, −0.25…+1.12)
      const a = a0 + 0.05, b = b0 - 0.05, n = Math.max(1, Math.round((b - a) / 2.2));
      for (let i = 0; i <= n; i++) {
        const m = a + (b - a) * i / n - len / 2;
        const [lx, lz] = key === "nx" ? [-k.w / 2 + 0.06, m] : key === "px" ? [k.w / 2 - 0.06, m] : key === "nz" ? [m, -k.d / 2 + 0.06] : [m, k.d / 2 - 0.06];
        const [cx, cz] = toWorld(k, lx, lz);
        out.push({ c: [cx, k.y + 0.435, cz], h: [0.07, 0.685, 0.07], surf: "wood" });
      }
    }
  };
  side(r.nx, "nx"); side(r.px, "px"); side(r.nz, "nz"); side(r.pz, "pz");
};
export function deckBoxes(k: MDeck): Box[] {
  const out: Box[] = [lbox(k, -k.w / 2, -k.d / 2, k.w / 2, k.d / 2, k.y - 0.24, k.y, "wood")];
  railBoxes(k, out);
  return out;
}
/** trestle posts under an OPEN flight (so the Boathouse roof stair does not read as an unsupported ladder): pairs every
 *  ≤ 1.9 m along the run under both stringers, from the stringer down to the deck / porch below or into the bed;
 *  [x, z, top, bottom] */
export function flightPosts(f: Flight): Array<[number, number, number, number]> {
  if (f.solid) return [];
  const out: Array<[number, number, number, number]> = [], run = f.n * f.tread, N = Math.max(1, Math.ceil(run / 1.9));
  for (let k = 1; k < N + (run > 1.2 ? 0 : 0); k++) {
    const u = run * k / N, y = f.yTop - (f.yTop - f.yBot) * (u / run) - 0.22;
    for (const s of [-1, 1]) {
      const x = f.x + f.dx * u + f.dz * s * (f.w / 2 + 0.04), z = f.z + f.dz * u - f.dx * s * (f.w / 2 + 0.04);
      let under = bedAt(x, z) - 0.3;
      for (const k2 of LAYOUT_DECKS) if (k2.y < y - 0.3 && inRect(k2, x, z, 0.05)) under = Math.max(under, k2.y);
      if (y - under > 0.9) out.push([x, z, y, under]);
    }
  }
  return out;
}
export function flightBoxes(f: Flight): Box[] {
  const out: Box[] = [];
  const yaw = simYaw(dmath.atan2(f.dx, f.dz)), rise = (f.yTop - f.yBot) / f.n;
  for (let i = 0; i < f.n; i++) {
    const top = f.yTop - (i + 1) * rise;
    if (top < f.yBot - 1e-3) break;
    const u = (i + 0.5) * f.tread, x = f.x + f.dx * u, z = f.z + f.dz * u;
    const bot = f.solid ? BED : top - 0.12;
    out.push({ c: [x, (top + bot) / 2, z], h: [f.w / 2, (top - bot) / 2, f.tread / 2 + 0.006], yaw, surf: "wood" });
  }
  // an open flight stands on trestle posts (flightPosts: drawn by deck.ts with the same list)
  for (const [x, z, top, bot] of flightPosts(f)) out.push({ c: [x, (top + bot) / 2, z], h: [0.07, (top - bot) / 2, 0.07], surf: "wood" });
  if (f.rails) {
    // stair rails (rope + posts): noShoot boxes along both sides following the slope (stepped: one per 4 treads)
    for (let i = 0; i < f.n; i += 4) {
      const k = Math.min(4, f.n - i), u = (i + k / 2) * f.tread, x = f.x + f.dx * u, z = f.z + f.dz * u;
      const y = f.yTop - (i + k / 2) * rise;
      for (const s of [-1, 1]) {
        const ox = f.dz * s * (f.w / 2 + 0.05), oz = -f.dx * s * (f.w / 2 + 0.05);
        out.push({ c: [x + ox, y + 0.5, z + oz], h: [0.05, 0.5, (k * f.tread) / 2], yaw, surf: "wood", noShoot: true });
      }
    }
  }
  return out;
}
export function hutBoxes(p: HutParts): Box[] {
  const h = p.h, surf: Surface = h.surf ?? "wood", out: Box[] = [];
  for (const w of p.walls) {
    const yaw = simYaw(dirYaw(h, w.dir));
    for (let f = 0; f < h.floors; f++) for (const pc of w.pieces[f]) {
      const lx = w.A[0] + w.dir[0] * (pc.u + pc.w / 2) - w.n[0] * h.t / 2, lz = w.A[1] + w.dir[1] * (pc.u + pc.w / 2) - w.n[1] * h.t / 2;
      const [cx, cz] = toWorld(h, lx, lz);
      out.push({ c: [cx, h.y + f * h.floorH + pc.y + pc.h / 2, cz], h: [pc.w / 2, pc.h / 2, h.t / 2], yaw, surf });
    }
  }
  // the shutter leaves + door leaves folded flat against the outside of the walls (hut.ts): thin solid boards
  for (const w of p.walls) {
    const yaw = simYaw(dirYaw(h, w.dir));
    const at = (u: number, off: number): [number, number] => toWorld(h, w.A[0] + w.dir[0] * u - w.n[0] * off, w.A[1] + w.dir[1] * u - w.n[1] * off);
    for (let f = 0; f < h.floors; f++) for (const op of w.openings[f]) {
      const oy = h.y + f * h.floorH + op.y, cu = op.u + op.w / 2;
      if (op.kind === "window") {
        const lw = op.w / 2 - 0.02;
        for (const sg of [-1, 1]) { const [cx, cz] = at(cu + sg * (op.w / 2 + 0.1 + lw / 2), -0.06); out.push({ c: [cx, oy + op.h / 2, cz], h: [lw / 2, (op.h - 0.06) / 2, 0.05], yaw, surf: "wood" }); }
      } else if (op.kind === "door") {
        const lw = Math.min(1.1, op.w - 0.1), [cx, cz] = at(op.u - 0.02 - lw / 2, -0.1);
        out.push({ c: [cx, oy + (op.h - 0.1) / 2 + 0.02, cz], h: [lw / 2, (op.h - 0.12) / 2, 0.07], yaw, surf: "wood" });
      }
    }
  }
  for (const s of p.slabs) for (const r of s.rects) out.push(lbox(h, r[0] - 0.01, r[1] - 0.01, r[2] + 0.01, r[3] + 0.01, s.y - s.t, s.y, surf));
  // the boat slip's board lining (hut.ts draws the same skirts): both sides + the inner end, floor → bed
  if (h.slip) {
    const S = h.slip, top = h.y - 0.24;
    out.push(lbox(h, S.x0 - 0.08, S.z0, S.x0 - 0.02, S.z1 + 0.08, BED, top, "wood"), lbox(h, S.x1 + 0.02, S.z0, S.x1 + 0.08, S.z1 + 0.08, BED, top, "wood"), lbox(h, S.x0 - 0.08, S.z1 + 0.02, S.x1 + 0.08, S.z1 + 0.08, BED, top, "wood"));
  }
  // interior flights: solid step blocks on the ground floor, thin treads above (no invisible mass over the room below)
  for (const f of p.flights) {
    const run = f.n * f.tread;
    for (let i = 0; i < f.n; i++) {
      const u = (i + 0.5) * f.tread, top = f.y0 + (i + 1) * f.rise / f.n;
      const [sx, sz] = toWorld(h, f.x + f.dir * u, f.z);
      const bot = Math.max(f.y0, top - 0.3);
      out.push({ c: [sx, (top + bot) / 2, sz], h: [f.tread / 2 + 0.006, (top - bot) / 2, f.w / 2], yaw: simYaw(h.yaw), surf: "wood" });
    }
    // guard rail along the open side of the flight on the floor above (the hole edge)
    // (from 30 % up the run to 1.1 m short of the top: the arrival is open sideways onto the floor above)
    const g0 = run * 0.3, g1 = run - 1.1;
    if (g1 - g0 > 0.4) {
      const [gx, gz] = toWorld(h, f.x + f.dir * (g0 + g1) / 2, f.z + f.w / 2 + 0.4);
      out.push({ c: [gx, f.y0 + f.rise + 0.5, gz], h: [(g1 - g0) / 2, 0.5, 0.05], yaw: simYaw(h.yaw), surf: "wood", noShoot: true });
    }
  }
  if (h.loft) {
    // loft balustrade along its open edge (except where the stair arrives)
    // (open over the stair's arrival on the left; railed from just past the stair top to the right wall)
    const st = h.stairs[0], a = st ? st.x + st.dir * Math.round(h.loft.h / 0.2) * 0.27 + 0.5 : -0.2, b = h.w / 2 - h.t;
    const [gx, gz] = toWorld(h, (a + b) / 2, h.loft.z0 + 0.05);
    out.push({ c: [gx, h.y + h.loft.h + 0.5, gz], h: [(b - a) / 2, 0.5, 0.05], yaw: simYaw(h.yaw), surf: "wood", noShoot: true });
  }
  // roof
  if (h.roof === "flat") {
    // timber parapet: a solid 0.55 m kick board (cover) + a noShoot rail above it
    for (const w of p.walls) {
      const lx = (w.A[0] + w.B[0]) / 2 - w.n[0] * 0.08, lz = (w.A[1] + w.B[1]) / 2 - w.n[1] * 0.08;
      const [cx, cz] = toWorld(h, lx, lz), yaw = simYaw(dirYaw(h, w.dir));
      out.push({ c: [cx, p.roofY - 0.08 + 0.275, cz], h: [w.len / 2, 0.275, 0.08], yaw, surf });
      out.push({ c: [cx, p.roofY - 0.08 + 0.55 + 0.25, cz], h: [w.len / 2, 0.25, 0.06], yaw, surf, noShoot: true });
    }
  } else {
    // pitched: terraces ≤ 0.24 m tall following the plane (walkable; the visual roof lies within ±0.12 m of them)
    const span = h.roof === "gable" ? h.d / 2 + h.overhang : h.d + 2 * h.overhang;
    const drop = h.pitch * span, N = Math.max(2, Math.ceil(drop / 0.24)), L = h.w + 2 * h.overhang;
    const sides = h.roof === "gable" ? [1, -1] : [1];
    for (const sg of sides) for (let k = 0; k < N; k++) {
      // gable: k = 0 at the ridge, outwards; shed: from the high back edge (−z) to the low front
      let z0: number, z1: number;
      if (h.roof === "gable") { z0 = sg * (k * span / N); z1 = sg * ((k + 1) * span / N); }
      else { z0 = -h.d / 2 - h.overhang + k * span / N; z1 = z0 + span / N; }
      const mid = (z0 + z1) / 2, top = roofAt(p, mid) + 0.14;
      out.push(lbox(h, -L / 2, Math.min(z0, z1), L / 2, Math.max(z0, z1), top - 0.22, top, "wood"));
    }
  }
  // gable / shed end infill above the side walls (±x): stepped boxes inside the drawn triangle / trapezoid
  if (h.roof !== "flat") {
    const top = h.y + p.H, N = 4;
    for (const sx of [-1, 1]) for (let k = 0; k < N; k++) {
      const y0 = top + (p.ridgeY - top) * k / N, y1 = top + (p.ridgeY - top) * (k + 1) / N, ym = (y0 + y1) / 2;
      let z0: number, z1: number;
      // (width at the band's TOP: the box never pokes out above the roof surface the kong walks on)
      if (h.roof === "gable") { const hw = (h.d / 2) * (1 - (y1 - top) / Math.max(0.01, p.ridgeY - top)); z0 = -hw; z1 = hw; }
      else { z0 = -h.d / 2; z1 = Math.min(h.d / 2, h.d / 2 - (y1 - p.roofY) / Math.max(0.01, h.pitch)); }
      void ym;
      if (z1 - z0 < 0.2) continue;
      out.push(lbox(h, sx * (h.w / 2) - (sx > 0 ? h.t : 0), z0, sx * (h.w / 2) + (sx < 0 ? h.t : 0), z1, y0, y1, surf));
    }
  }
  // porch roof: two walkable terraces (within ±0.11 m of the drawn slope) + its posts
  if (h.porchRoof) {
    const q = porchRoofParts(p);
    for (let k = 0; k < 2; k++) {
      const za = q.z0 + (q.z1 + 0.2 - q.z0) * k / 2, zb = q.z0 + (q.z1 + 0.2 - q.z0) * (k + 1) / 2, top = q.y0 + (q.y1 - q.y0) * (k + 0.5) / 2 + 0.1;
      out.push(lbox(h, q.sh - q.w / 2 - 0.1, za, q.sh + q.w / 2 + 0.1, zb, top - 0.16, top, "wood"));
    }
    for (const [px, pz] of q.posts) out.push(lbox(h, px - 0.08, pz - 0.08, px + 0.08, pz + 0.08, h.y, q.y1, "wood"));
    // (no invisible noShoot guard along the wall above the porch roof: the porch roof is a ledge under the upper-floor
    // windows, the windows are a way in)
  }
  // furniture (solid pieces only)
  for (const f of h.furniture) {
    // the boat in the slip: hull colliders on its drawn lines (hut.ts: len 5.0, ×0.85, rolled 0.03) — cover in the slip
    if (f.kind === "boat") { const [bx, bz] = toWorld(h, f.x, f.z); out.push(...boatBoxes({ kind: "canoe", x: bx, y: WATER_Y - 0.02, z: bz, yaw: h.yaw + f.yaw }, 5.0, 0.85, 0.85, 0.03)); continue; }
    if (f.col === false) continue;
    const [cx, cz] = toWorld(h, f.x, f.z);
    out.push({ c: [cx, h.y + f.y + f.h / 2, cz], h: [f.w / 2, f.h / 2, f.d / 2], yaw: simYaw(h.yaw + f.yaw), surf: f.kind === "tank" || f.kind === "stove" || f.kind === "locker" ? "metal" : f.kind === "bed" || f.kind === "sacks" || f.kind === "netpile" ? "fabric" : "wood" });
  }
  return out;
}
/** the curve the client draws through a root's points: three.js CatmullRomCurve3 ("catmullrom", tension 0.4) —
 *  same end extrapolation, same cubic — sampled uniformly in each segment's parameter */
export function rootCurve(pts: V3[], perM = 1.6): V3[] {
  const n = pts.length, out: V3[] = [];
  const P = (i: number): V3 => {
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1], 2 * pts[0][2] - pts[1][2]];
    if (i > n - 1) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1], 2 * pts[n - 1][2] - pts[n - 2][2]];
    return pts[i];
  };
  const T = 0.4;
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const L = dmath.hypot3(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]), k = Math.max(2, Math.ceil(L * perM));
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const h = (a: number, b: number, c: number, d: number) => { const m0 = T * (c - a), m1 = T * (d - b); return (2 * t3 - 3 * t2 + 1) * b + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * c + (t3 - t2) * m1; };
      out.push([h(p0[0], p1[0], p2[0], p3[0]), h(p0[1], p1[1], p2[1], p3[1]), h(p0[2], p1[2], p2[2], p3[2])]);
    }
  }
  out.push(pts[n - 1]);
  return out;
}
/** tube → boxes (one per sample segment; ≤ ~0.6 m, inside the drawn bark by ~15 %) */
export function rootBoxes(r: Root): Box[] {
  const out: Box[] = [];
  if (r.kind === "aerial") return out;
  // (0.33 m segments (limbs 0.45, trunks 0.6): flat box tops follow the drawn bark within ~0.1 m and a sloped root
  // segment's box corners stick out of the drawn tube by ≤ ~0.12 m — no invisible walls at prop roots)
  const pts = rootCurve(r.pts, r.kind === "limb" ? 2.2 : r.kind === "trunk" ? 1.6 : 3);
  const total = pts.length - 1;
  // arc-length fraction per sample (the client tapers by arc length)
  const cum = [0];
  for (let i = 0; i < total; i++) cum.push(cum[i] + dmath.hypot3(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]));
  const Ltot = cum[total] || 1;
  for (let i = 0; i < total; i++) {
    const a = pts[i], b = pts[i + 1];
    if (Math.max(a[1], b[1]) < -0.4) continue;
    const t = (cum[i] + cum[i + 1]) / 2 / Ltot, rad = (r.r0 + (r.r1 - r.r0) * dmath.pow(t, 0.8)) * (1 + 0.35 * Math.max(0, 1 - t * 6));
    const dx = b[0] - a[0], dz = b[2] - a[2], hl = dmath.hypot(dx, dz) / 2;
    // a shallow segment's walkable top sits at the drawn bark's top at its middle (the max end would overshoot the
    // drawn surface by half the segment's rise: floor mismatches on limbs / prop roots)
    const dy = Math.abs(a[1] - b[1]), shallow = dy < hl * 1.4;
    const y0 = Math.min(a[1], b[1]) - rad * 0.85, y1 = shallow ? (a[1] + b[1]) / 2 + rad * 0.95 : Math.max(a[1], b[1]) + rad * 0.85;
    // (a steep segment keeps a square cross-section — otherwise a vertical trunk is only 0.25 r thick along one axis,
    // so bullets and kongs pass through the sides of drawn trunks)
    // (a shallow END segment stops at the drawn (capped) end — otherwise it overshoots a log's end face by up to 0.4 m)
    const end = i === 0 || i === total - 1, along = shallow ? hl + (end ? 0 : rad * 0.25) : Math.max(hl + rad * 0.25, rad * 0.85);
    out.push({ c: [(a[0] + b[0]) / 2, (y0 + y1) / 2, (a[2] + b[2]) / 2], h: [rad * 0.85, (y1 - y0) / 2, along], yaw: simYaw(dmath.atan2(dx, dz)), surf: "wood" });
  }
  return out;
}
/** the hollow trunk: wall ring (split by the openings), the heartwood column, spiral treads, floor + ceiling, platform */
export function gmBoxes(): Box[] {
  const out: Box[] = [];
  const N = 22, dy = 0.9;
  for (let y = -1.5; y < GM.hollowTop + 0.01; y += dy) {
    const ym = y + dy / 2;
    const ro = gmRadius(ym) - 0.05, ri = Math.min(ro - GM.wallT, gmInner(ym));
    // thick flare walls: radial layers ≤ 1.2 m, each as wide as ITS outer arc (no notches between segments)
    const nl = Math.max(1, Math.ceil((ro - ri) / 1.2));
    for (let l = 0; l < nl; l++) {
      const r0 = ri + (ro - ri) * l / nl, r1 = ri + (ro - ri) * (l + 1) / nl, rc = (r0 + r1) / 2;
      const Nl = Math.max(N, Math.ceil(TAU * r1 / 1.3));
      for (let i = 0; i < Nl; i++) {
        const a = (i + 0.5) / Nl * TAU;
        if (gmOpen(a, ym)) continue;
        const half = Math.PI * r1 / Nl * 1.04;
        out.push({ c: [GM.x + dmath.cos(a) * rc, ym, GM.z + dmath.sin(a) * rc], h: [half, dy / 2 + 0.02, (r1 - r0) / 2], yaw: a + Math.PI / 2, surf: "wood" });
      }
    }
  }
  // solid trunk above the hollow up to the fork (a few octagon slabs)
  for (let y = GM.hollowTop; y < 20; y += 1.2) {
    const r = gmRadius(y + 0.6) * 0.92;
    for (let k = 0; k < 2; k++) out.push({ c: [GM.x, y + 0.6, GM.z], h: [r, 0.6, r * 0.42], yaw: k * Math.PI / 2 + Math.PI / 8, surf: "wood" });
    out.push({ c: [GM.x, y + 0.6, GM.z], h: [r * 0.71, 0.6, r * 0.71], yaw: Math.PI / 8 + Math.PI / 4, surf: "wood" });
  }
  // interior floor (a plank disc: two crossed boxes cover the hollow) + the heartwood column
  const rf = gmInner(GM.floorY);
  out.push({ c: [GM.x, GM.floorY - 0.15, GM.z], h: [rf, 0.15, rf], yaw: 0, surf: "wood" });
  // (the column's boxes follow the DRAWN heartwood tube — tree.ts draws taperTube through these points, r 0.5 → 0.44)
  out.push(...rootBoxes({ pts: [[GM.x, GM.floorY - 0.3, GM.z], [GM.x + 0.08, GM.floorY + 5, GM.z - 0.06], [GM.x - 0.06, GM.floorY + 10, GM.z + 0.05], [GM.x, GM.platY + 2.8, GM.z]], r0: 0.5, r1: 0.44, kind: "trunk" }));
  // thresholds through the wall thickness at the gate (floorY) and the platform exit (platY)
  for (const [a, y] of [[GM.inA, GM.floorY], [GM.outA, GM.platY]] as Array<[number, number]>) {
    const r0 = gmInner(y) - 0.35, r1 = gmRadius(y) + 0.1, rm = (r0 + r1) / 2;
    out.push({ c: [GM.x + dmath.cos(a) * rm, y - 0.12, GM.z + dmath.sin(a) * rm], h: [(r1 - r0) / 2, 0.12, 1.1], yaw: a, surf: "wood" });
  }
  // hollow ceiling (just above the exit lintel)
  out.push({ c: [GM.x, GM.platY + 2.7, GM.z], h: [gmInner(GM.platY + 2.7), 0.12, gmInner(GM.platY + 2.7)], yaw: 0, surf: "wood" });
  // spiral treads: thin radial boards
  for (const s of LAYOUT.spiral) {
    const rm = (s.r0 + s.r1) / 2, hl = (s.r1 - s.r0) / 2, ht = dmath.tan(s.da / 2) * s.r1 * 1.05;
    out.push({ c: [GM.x + dmath.cos(s.a) * rm, s.y - 0.08, GM.z + dmath.sin(s.a) * rm], h: [hl, 0.08, ht], yaw: s.a, surf: "wood" });
  }
  // the Crow's Nest platform: four slabs around the trunk (world-axis square), rails (a gap for the bridge)
  const ph = GM.platH, rt = gmRadius(GM.platY) - 0.35, y = GM.platY;
  const slab = (x0: number, z0: number, x1: number, z1: number) => out.push({ c: [GM.x + (x0 + x1) / 2, y - 0.14, GM.z + (z0 + z1) / 2], h: [(x1 - x0) / 2, 0.14, (z1 - z0) / 2], yaw: 0, surf: "wood" });
  slab(-ph, -ph, ph, -rt); slab(-ph, rt, ph, ph); slab(-ph, -rt, -rt, rt); slab(rt, -rt, ph, rt);
  const rail = (x0: number, z0: number, x1: number, z1: number) => out.push({ c: [GM.x + (x0 + x1) / 2, y + 0.55, GM.z + (z0 + z1) / 2], h: [Math.max(0.05, (x1 - x0) / 2), 0.55, Math.max(0.05, (z1 - z0) / 2)], yaw: 0, surf: "wood", noShoot: true });
  for (const [ax, az, bx, bz] of nestRails()) rail(Math.min(ax, bx) - (ax === bx ? 0.05 : 0), Math.min(az, bz) - (az === bz ? 0.05 : 0), Math.max(ax, bx) + (ax === bx ? 0.05 : 0), Math.max(az, bz) + (az === bz ? 0.05 : 0));
  return out;
}
/** the Crow's Nest rail runs (GM-local [ax, az, bx, bz] along the platform edges, 5 cm in): gaps for the bridge head and
 *  where each LOW limb passes under the edge (a ~2 m drop onto the limb — the perches are walk-reachable, no jump) */
export function nestRails(): Array<[number, number, number, number]> {
  const ph = GM.platH, e = ph - 0.05;
  // gaps per edge: 0 = −z, 1 = +z, 2 = −x, 3 = +x — [centre along the edge, half width]
  const gaps: Array<Array<[number, number]>> = [[], [], [], [[LAYOUT.bridge.a[2] - GM.z, 0.95]]];
  for (const r of LAYOUT.roots) {
    if (r.kind !== "limb" || Math.abs(r.pts[0][1] - 9.2) > 0.01) continue;
    for (const q of rootCurve(r.pts, 4)) {
      const dx = q[0] - GM.x, dz = q[2] - GM.z;
      if (Math.max(Math.abs(dx), Math.abs(dz)) < ph - 0.3) continue;
      if (Math.abs(dz) >= Math.abs(dx)) gaps[dz < 0 ? 0 : 1].push([dx, 0.8]); else gaps[dx < 0 ? 2 : 3].push([dz, 0.8]);
      break;
    }
  }
  const out: Array<[number, number, number, number]> = [];
  gaps.forEach((g, side) => {
    let a = -e;
    for (const [c, hw] of [...g].sort((p, q) => p[0] - q[0])) { if (c - hw > a + 0.2) seg(side, a, c - hw); a = Math.max(a, c + hw); }
    if (e > a + 0.2) seg(side, a, e);
  });
  function seg(side: number, u0: number, u1: number) {
    if (side === 0) out.push([u0, -e, u1, -e]); else if (side === 1) out.push([u0, e, u1, e]);
    else if (side === 2) out.push([-e, u0, -e, u1]); else out.push([e, u0, e, u1]);
  }
  return out;
}
export function bridgeBoxes(): Box[] {
  const b = LAYOUT.bridge, out: Box[] = [];
  const dx = b.b[0] - b.a[0], dz = b.b[2] - b.a[2], L = dmath.hypot(dx, dz), yaw = simYaw(dmath.atan2(dx, dz));
  for (let i = 0; i < b.n; i++) {
    const t = (i + 0.5) / b.n, y = bridgeY(t);
    out.push({ c: [b.a[0] + dx * t, y - 0.06, b.a[2] + dz * t], h: [b.w / 2, 0.06, L / b.n / 2 + 0.01], yaw, surf: "wood" });
  }
  // plank PARAPETS on both sides (cover over the 40 m bridge run): a solid board wall 1.1 m tall per plank
  // segment, following the sag (drawn by deck.ts addBridge with the same segments) — hard cover, bullets stop
  for (let i = 0; i < b.n; i++) {
    const t = (i + 0.5) / b.n, y = bridgeY(t);
    for (const s of [-1, 1]) out.push({ c: [b.a[0] + dx * t + (dz / L) * s * (b.w / 2 + 0.03), y + 0.55, b.a[2] + dz * t - (dx / L) * s * (b.w / 2 + 0.03)], h: [0.035, 0.6, L / b.n / 2 + 0.01], yaw, surf: "wood" });
  }
  return out;
}
/** walking surface of the rope bridge at t ∈ [0, 1] */
export function bridgeY(t: number): number {
  const b = LAYOUT.bridge;
  return b.a[1] + (b.b[1] - b.a[1]) * t - b.sag * 4 * t * (1 - t);
}
/** deck piles (world x, z, radius) — the client draws exactly these; colliders below */
export function deckPiles(k: MDeck): Array<[number, number, number]> {
  if (k.noPiles) return [];
  const nb = Math.max(2, Math.round(k.d / 1.6)), step = k.pile ?? (k.kind === "walk" ? 2 : 1), out: Array<[number, number, number]> = [];
  // (never inside a stair's footprint: the flights leave the decks exactly where piles would stand)
  const fl = LAYOUT.flights.map((f) => { const run = f.n * f.tread; return { x: f.x + f.dx * run / 2, z: f.z + f.dz * run / 2, yaw: dmath.atan2(f.dx, f.dz), w: f.w + 0.5, d: run + 0.5 }; });
  for (let i = 0; i <= nb; i += step) for (const s of [-1, 1]) {
    const [x, z] = toWorld(k, s * (k.w / 2 + 0.05), -k.d / 2 + 0.1 + (k.d - 0.2) * i / nb);
    if (fl.some((q) => inRect(q, x, z, 0.2))) continue;
    out.push([x, z, 0.15]);
  }
  return out;
}
/** hut stilts (world x, z, radius) */
export function hutStilts(h: Hut): Array<[number, number, number]> {
  const nx = Math.max(2, Math.round(h.w / 2.4)), nz = Math.max(2, Math.round(h.d / 2.4)), out: Array<[number, number, number]> = [];
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
    if (i > 0 && i < nx && j > 0 && j < nz && (i + j) % 2) continue;
    const [x, z] = toWorld(h, -h.w / 2 + 0.2 + (h.w - 0.4) * i / nx, -h.d / 2 + 0.2 + (h.d - 0.4) * j / nz);
    out.push([x, z, 0.17]);
  }
  return out;
}
const postBox = (x: number, z: number, r: number, top: number): Box => ({ c: [x, (top + BED) / 2, z], h: [r * 0.88, (top - BED) / 2, r * 0.88], surf: "wood" });

/** solid props (cover) */
/** a longboat hull's colliders (len = the kit's `len`, sxz / sy = the drawn scale): mirrors town-boat.ts hullLines */
function boatBoxes(p: MProp, len: number, sxz: number, sy: number, roll: number): Box[] {
  const f = { x: p.x, z: p.z, yaw: p.yaw }, HB = 0.82, RAKE = 0.62, XS = -len / 2 + 0.08, XB = len / 2 - RAKE;
  const hb = (u: number) => (u <= 0.42 ? HB * (1 - 0.22 * dmath.pow((0.42 - u) / 0.42, 2)) : HB * dmath.pow(Math.max(0, 1 - dmath.pow((u - 0.42) / 0.58, 1.9)), 0.72));
  const ys = (u: number) => (u < 0.4 ? 0.58 + 0.2 * dmath.pow((0.4 - u) / 0.4, 2) : 0.58 + 0.52 * dmath.pow((u - 0.4) / 0.6, 2.2));
  const out: Box[] = [], T = 0.07, floorY = p.y + (-0.25 + 0.09) * sy, x0 = XS * sxz, x1 = (XB + RAKE * 0.6) * sxz;
  const n = Math.max(4, Math.ceil((x1 - x0) / 0.45));
  for (let i = 0; i < n; i++) {
    const a = x0 + (x1 - x0) * i / n, b = x0 + (x1 - x0) * (i + 1) / n, um = Math.min(1, ((a + b) / 2 / sxz - XS) / (XB - XS));
    // (the drawn hull is rolled bow-up by `roll`: every station rises by x·roll)
    const w = Math.max(0.12, hb(um) * 0.92 * sxz), lift = (a + b) / 2 * roll, top = p.y + ys(um) * sy + lift, fy = floorY + lift;
    out.push(lbox(f, a, w - T, b, w + T * 0.6, fy, top, "wood"), lbox(f, a, -w - T * 0.6, b, -w + T, fy, top, "wood"));
    // the floor (planking + bilge) under this station
    out.push(lbox(f, a, -w, b, w, fy - 0.5, fy, "wood"));
  }
  // transom + stem
  out.push(lbox(f, x0 - 0.04, -hb(0) * sxz * 0.9, x0 + 0.08, hb(0) * sxz * 0.9, floorY + x0 * roll, p.y + ys(0) * sy + x0 * roll, "wood"));
  out.push(lbox(f, x1 - 0.3, -0.18, x1 + 0.05, 0.18, floorY + x1 * roll, p.y + ys(1) * sy + x1 * roll, "wood"));
  return out;
}
export function propBoxes(p: MProp): Box[] {
  const box = (hx: number, hy: number, hz: number, oy = 0, surf: Surface = "wood"): Box => ({ c: [p.x, p.y + oy + hy, p.z], h: [hx, hy, hz], yaw: simYaw(p.yaw), surf });
  switch (p.kind) {
    case "crates": {
      if (p.h) return [box(0.5, p.h / 2, 0.5)];
      const v = p.v ?? 0, hgt = [1.3, 0.9, 1.6, 1.25][v % 4];
      return [box(0.62, hgt / 2, 0.5)];
    }
    case "barrel": return [box(0.33, 0.46, 0.33, 0, "wood")];
    case "drum": return [box(0.31, 0.45, 0.31, 0, "metal")];
    case "trap": return [box(0.45, 0.3, 0.32)];
    case "logpile": return [box(0.9, 0.45, 0.6)];
    // hulls follow the DRAWN longboat lines (client _kit/town-boat.ts hullLines, scaled like index.ts addProp):
    // per 0.45 m station a side wall at the sheer's half-beam, the transom, the stem, and the hull floor — you stand IN
    // the boat on its floor, never inside the drawn planking
    case "rowboat": return boatBoxes(p, 4.6, 0.78, 0.78, 0.09);
    case "canoe": return boatBoxes(p, 5.2, 0.62, 0.7, 0.03);
    case "sign": return [box(0.1, 1.2, 0.1)];
    case "lantern": { const [px, pz] = toWorld({ x: p.x, z: p.z, yaw: p.yaw }, 0, 0); return [{ c: [px, p.y + (p.h ?? 2.4) / 2, pz], h: [0.07, (p.h ?? 2.4) / 2, 0.07], surf: "wood" }]; }
    case "netrack": return [lbox({ x: p.x, z: p.z, yaw: p.yaw }, -1.17, -0.07, -1.03, 0.07, p.y, p.y + 2.1, "wood"), lbox({ x: p.x, z: p.z, yaw: p.yaw }, 1.03, -0.07, 1.17, 0.07, p.y, p.y + 2.1, "wood")];
    case "chimney": return [box(0.36, (p.h ?? 3) / 2, 0.36, 0, "stone")];
    case "stack": return [box(0.42, (p.h ?? 1.75) / 2, 0.42, 0, "metal")];
    case "cupola": return [box(0.62, (p.h ?? 1.75) * 0.36, 0.62, 0, "wood"), box(0.5, (p.h ?? 1.75) * 0.14, 0.5, (p.h ?? 1.75) * 0.72, "wood")];
    default: return [];
  }
}

// ================================================================================================ root masses
/** ROOT MASS: the sculpted buttress foot of every swamp tree, root tangle and planted mangrove — instead of an
 *  INVISIBLE noShoot root cage (invisible walls), a drawn (client tree.ts addRootMasses) and solid mass:
 *  a steep (55–70°) fused-root cone from the bed (yb) to yt, rb → rt. Colliders: n octagon tiers (2 boxes, 0° + 45°),
 *  each ≥ 0.6 m tall (no auto-step) and inset ≤ 0.38 m (a ledge narrower than the kong capsule: never a foothold), its
 *  apothem = the drawn mean radius at the tier's middle (±0.19 m). Hard cover. */
export interface RootMass { x: number; z: number; yb: number; yt: number; rb: number; rt: number; n: number; seed: number; trunk: boolean }
function mass(x: number, z: number, yb: number, yt: number, rb: number, rt: number, trunk: boolean): RootMass {
  const n = Math.max(2, Math.floor((yt - yb) / 0.6));
  rt = Math.max(rt, rb - n * 0.38);
  return { x, z, yb, yt, rb, rt, n, seed: Math.abs(Math.round(x * 7.31 + z * 3.17)) % 997, trunk };
}
export function massOfPlant(p: Plant): RootMass {
  const S = p.s, y = p.y ?? 0.35;
  return mass(p.x, p.z, Math.min(y, groundAt(p.x, p.z)) - 0.4, y + 1.2 * S, 1.1 * S, 0.3 * S, true);
}
let massCache: RootMass[] | null = null;
/** the tree + tangle masses (from LAYOUT.cages) */
export function rootMasses(): RootMass[] {
  if (massCache) return massCache;
  massCache = LAYOUT.cages.map((c) => {
    const g = groundAt(c.x, c.z), tree = LAYOUT.trees.some((t) => dmath.hypot(t.x - c.x, t.z - c.z) < 0.5);
    const t = tree ? LAYOUT.trees.find((q) => dmath.hypot(q.x - c.x, q.z - c.z) < 0.5)! : null;
    return mass(c.x, c.z, g - 0.4, c.y1, c.r * 0.72, c.rt ?? (t ? (0.55 * t.s + 0.1) * 1.15 : 0.3), !!t || !!c.rt);
  });
  return massCache;
}
/** drawn mean radius of a mass at height y (the client adds ridges ±7 % and lumps) */
export function massRadius(m: RootMass, y: number): number {
  const t = Math.min(1, Math.max(0, (y - m.yb) / (m.yt - m.yb)));
  return m.rb + (m.rt - m.rb) * t;
}
export function massBoxes(m: RootMass): Box[] {
  const out: Box[] = [], dh = (m.yt - m.yb) / m.n;
  for (let k = 0; k < m.n; k++) {
    // (the apothem at 60 % of the tier's height: the flat tier top overhangs the drawn cone by ≤ 0.4 dh, its face sits
    // ≤ 0.6 dr inside the drawn surface at the tier's foot)
    const y0 = m.yb + k * dh, a = massRadius(m, y0 + dh * 0.6);
    // a regular octagon = the union of 4 bars (a × a·tan 22.5°) at 0 / 45 / 90 / 135° (two squares would make an
    // 8-pointed STAR whose points stick out 0.41 a past the drawn surface — invisible walls)
    for (let j = 0; j < 4; j++) out.push({ c: [m.x, y0 + dh / 2, m.z], h: [a, dh / 2, a * 0.4142], yaw: j * Math.PI / 4, surf: "wood" });
  }
  return out;
}

/** planted veg mangroves: EXACTLY the boxes veg-scatter's vegTrunkColliders gives a mangrove (variant-free) — a trunk
 *  post + the root cage (noShoot). Kept in sync by hand: shared/world/veg-scatter.ts case "mangrove". */
export function plantBoxes(p: Plant): Box[] {
  if (p.kind !== "mangrove") return [];
  const S = p.s, y = p.y ?? 0.35;
  // the root cage is the DRAWN root mass at the mangrove's foot (massOfPlant) — solid, shootable, the same
  // tiers the client draws; the trunk post above it as veg-scatter gives it
  return [{ c: [p.x, y + 2.6 * S, p.z], h: [0.22 * S, 2.4 * S, 0.22 * S], surf: "wood" }, ...massBoxes(massOfPlant(p))];
}
function buildColliders(): Box[] {
  const out: Box[] = [];
  for (const p of LAYOUT.plants) out.push(...plantBoxes(p));
  for (const k of LAYOUT.decks) { out.push(...deckBoxes(k)); for (const [x, z, r] of deckPiles(k)) out.push(postBox(x, z, r, k.y - 0.24)); }
  for (const h of LAYOUT.huts) if (h.y < 5) for (const [x, z, r] of hutStilts(h)) out.push(postBox(x, z, r, h.y - 0.25));
  for (const f of LAYOUT.flights) out.push(...flightBoxes(f));
  for (const p of LAYOUT.parts) out.push(...hutBoxes(p));
  for (const r of LAYOUT.roots) out.push(...rootBoxes(r));
  for (const p of LAYOUT.props) out.push(...propBoxes(p));
  out.push(...gmBoxes(), ...bridgeBoxes(), ...shelfBoxes(), ...interiorColliders(INTERIOR_ROOMS), ...dressBoxes());
  for (const m of rootMasses()) out.push(...massBoxes(m));
  return out;
}
/** the silt shelf's 2 m cells (x0, z0 = the cell's min corner, top): every cell where the shelf lies above the bed at any
 *  of its corners / centre; top = the highest shelf sample (flat — the collider and the drawn silt agree exactly) */
let shelfCache: Array<[number, number, number]> | null = null;
export function shelfCells(): Array<[number, number, number]> {
  if (shelfCache) return shelfCache;
  const out: Array<[number, number, number]> = shelfCache = [], { x0, x1, z0, z1, step } = SURF;
  for (let z = z0; z < z1 - 0.01; z += step) for (let x = x0; x < x1 - 0.01; x += step) {
    let top = -Infinity, need = false;
    for (const [sx, sz] of [[0, 0], [step, 0], [0, step], [step, step], [step / 2, step / 2]]) {
      const t = shelfTop(x + sx, z + sz);
      if (!Number.isFinite(t)) continue;
      top = Math.max(top, t);
      if (t > groundAt(x + sx, z + sz) + 0.02) need = true;
    }
    // (a steep drop-off inside the cell: the bed between the samples dips far under the shelf — fill it too)
    if (!need && Number.isFinite(top)) for (let i = 0; i <= 4 && !need; i++) for (let j = 0; j <= 4 && !need; j++) if (groundAt(x + i * step / 4, z + j * step / 4) < top - 0.3) need = true;
    if (need) out.push([x, z, Math.round(top * 100) / 100]);
  }
  return out;
}
/** the silt shelf's colliders: one flat box per run of cells along x with the same top */
export function shelfBoxes(): Box[] {
  const out: Box[] = [], step = SURF.step;
  let run: { xa: number; xb: number; z: number; top: number; bot: number } | null = null;
  const flush = () => { if (run) out.push({ c: [(run.xa + run.xb) / 2, (run.top + run.bot) / 2, run.z + step / 2], h: [(run.xb - run.xa) / 2, (run.top - run.bot) / 2, step / 2], surf: "water" }); run = null; };
  for (const [x, z, top] of shelfCells()) {
    const gmin = Math.min(groundAt(x, z), groundAt(x + step, z), groundAt(x, z + step), groundAt(x + step, z + step), groundAt(x + step / 2, z + step / 2));
    const bot = Math.min(gmin, top - 0.3) - 0.3;
    if (run && run.z === z && Math.abs(run.xb - x) < 0.01 && Math.abs(run.top - top) < 0.005) { run.xb = x + step; run.bot = Math.min(run.bot, bot); continue; }
    flush(); run = { xa: x, xb: x + step, z, top, bot };
  }
  flush();
  return out;
}
export const colliders: Box[] = buildColliders();

// ================================================================================================ clearings (veg keep-out)
function buildClearings(): Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> {
  const out: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> = [];
  for (const k of LAYOUT.decks) out.push({ x: k.x, z: k.z, hx: k.w / 2 + 2.2, hz: k.d / 2 + 2.2, yaw: simYaw(k.yaw) });
  for (const h of LAYOUT.huts) out.push({ x: h.x, z: h.z, hx: h.w / 2 + 3.5, hz: h.d / 2 + 3.5, yaw: simYaw(h.yaw) });
  out.push({ x: GM.x, z: GM.z, r: 15 });
  for (const f of LAYOUT.flights) out.push({ x: f.x + f.dx * f.n * f.tread / 2, z: f.z + f.dz * f.n * f.tread / 2, r: f.n * f.tread / 2 + 2 });
  // the whole swamp core: the POI plants its own trees (with colliders) — veg scatter stays on the rim
  out.push({ x: 577, z: -207, hx: 95, hz: 66, yaw: 0 });
  return out;
}
export const clearings = buildClearings();

// ================================================================================================ loot
function buildLoot(): { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]> } {
  const chests: Array<[number, number, number, number]> = [], floor: Array<[number, number, number]> = [];
  // (the payoff first — the loot generator's HERO chests (always on) are the first designed chests outside a
  // room: the Crow's Nest at the top of the Great Mangrove's spiral is THE risky climb of the swamp, so it always pays;
  // the hollow's chest at the stair foot is listed second)
  chests.push([GM.x - GM.platH + 1.3, GM.platY, GM.z + GM.platH - 1.3, Math.PI / 4]);
  chests.push([GM.x + dmath.cos(GM.inA - 0.95) * 1.7, GM.floorY, GM.z + dmath.sin(GM.inA - 0.95) * 1.7, GM.inA]);
  for (const h of LAYOUT.huts) for (const f of h.furniture) if (f.kind === "chest") {
    const [x, z] = toWorld(h, f.x, f.z);
    chests.push([x, h.y + f.y, z, h.yaw + f.yaw]);
  }
  // the furnished storeys: the kit's chest + floor slots (reachable, away from door corridors)
  const il = interiorLoot(INTERIOR_ROOMS);
  chests.push(...il.chests); floor.push(...il.floor);
  // floor loot: porches, walks, the dock, the landing, the root gate, the hollow's knot-hole nook, the bridge ends
  const onDeck = (k: MDeck, lx: number, lz: number) => { const [x, z] = toWorld(k, lx, lz); floor.push([x, k.y, z]); };
  const D = LAYOUT.decks;
  for (const k of D) {
    if (k.kind === "porch") onDeck(k, 0.3, 0);
    if (k.kind === "deck" && k.w > 5) { onDeck(k, 1.2, 0.5); onDeck(k, -1.6, -1.2); }
    if (k.kind === "dock") { onDeck(k, 0, 2); onDeck(k, 0.5, -3.5); }
  }
  // a loot trail along the boardwalks: a floor spot every ~9 m of every walk — the lanes pay, and a landing in the channels has a gun a few strides away up the nearest steps
  for (const k of D) if (k.kind === "walk" && k.d > 7) { const n = Math.max(1, Math.round(k.d / 9)); for (let i = 0; i < n; i++) onDeck(k, 0, -k.d / 2 + (i + 0.5) * k.d / n); }
  // hut spots: the first candidate on solid floor, clear of furniture, stairs, stair holes and the boat slip
  const CAND: V2[] = [[0.6, 0.2], [-0.8, 1.2], [1.2, -1.0], [-1.6, -0.4], [1.8, 1.4], [-2.4, 1.8], [2.6, -0.2], [0, 1.9]];
  const ok = (p: HutParts, f: number, lx: number, lz: number) => {
    const h = p.h, m = 0.45;
    if (Math.abs(lx) > h.w / 2 - h.t - m || Math.abs(lz) > h.d / 2 - h.t - m) return false;
    for (const q of h.furniture) if (Math.abs(q.y - f * h.floorH) < 0.5 && Math.abs(lx - q.x) < q.w / 2 + m && Math.abs(lz - q.z) < q.d / 2 + m) return false;
    for (const fl of p.flights) { const x0 = Math.min(fl.x, fl.x + fl.dir * fl.n * fl.tread) - 0.3, x1 = Math.max(fl.x, fl.x + fl.dir * fl.n * fl.tread) + 0.5; if (lx > x0 && lx < x1 && Math.abs(lz - fl.z) < fl.w / 2 + 0.75) return false; }
    if (f === 0 && h.slip && lx > h.slip.x0 - m && lx < h.slip.x1 + m && lz > h.slip.z0 - m && lz < h.slip.z1 + m) return false;
    return true;
  };
  for (const p of LAYOUT.parts) {
    const h = p.h, levels: Array<[number, number]> = [];
    if (!ROOM_PLAN[h.id]) for (let f = 0; f < h.floors; f++) levels.push([f, h.y + f * h.floorH]);
    if (h.roof === "flat") levels.push([h.floors, p.roofY]);
    for (const [f, y] of levels) {
      const c = CAND.find(([lx, lz]) => ok(p, f, lx, lz));
      if (!c) continue;
      const [x, z] = toWorld(h, c[0], c[1]);
      floor.push([x, y, z]);
    }
  }
  // the south-east bank toward Mango Market has no wading loot (the no-loot-under-the-tea rule): two
  // floor spots on the dry bank (the nearest point ≥ 0.15 m above the tea within 7 m of each mark)
  for (const [mx, mz] of [[608, -134]] as V2[]) {
    let best: V2 | null = null, bd = 1e9;
    for (let dz = -7; dz <= 7; dz += 0.5) for (let dx = -7; dx <= 7; dx += 0.5) { const x = mx + dx, z = mz + dz, d = dmath.hypot(dx, dz); if (d < bd && groundAt(x, z) > WATER_Y + 0.15) { bd = d; best = [x, z]; } }
    if (best) floor.push([best[0], groundAt(best[0], best[1]), best[1]]);
  }
  // spiral nook at the knot window
  const sw = LAYOUT.spiral.reduce((b, s) => Math.abs(s.y - GM.winY0) < Math.abs(b.y - GM.winY0) ? s : b, LAYOUT.spiral[0]);
  floor.push([GM.x + dmath.cos(sw.a) * 1.3, sw.y, GM.z + dmath.sin(sw.a) * 1.3]);
  return { chests, floor };
}
export const LOOT_SPOTS = buildLoot();
