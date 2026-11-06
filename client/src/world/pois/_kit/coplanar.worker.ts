import { solveCoplanar } from "./coplanar-solve";

self.onmessage = (e: MessageEvent<Float64Array>) => {
  const r = solveCoplanar(e.data);
  (self as unknown as Worker).postMessage(r, [r.moves.buffer]);
};
