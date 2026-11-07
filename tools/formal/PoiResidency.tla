--------------------------- MODULE PoiResidency ---------------------------
(* Low-memory POI streaming on the client (client/src/low-mem.ts, client/src/main.ts stream()): which streamed
   locations hold memory, and when one is evicted. On by default in Safari and on devices reporting under 8 GB
   (low-mem-device.ts); this is what keeps a 16 GB Mac's Safari tab alive. Desktop Chrome builds every POI once and
   keeps it (no eviction), so it is not modelled.

   Abstracted: distances are three classes per POI (the camera is inside it, near enough to build, far),
   the camera moves arbitrarily between ticks, and memory cost is a count (lowmemcap) rather than MB (lowmembudget,
   whose estimate starts at 400 MB a POI). Evicted is "queued again" (low-mem.ts trimStreamed). *)
EXTENDS Naturals, FiniteSets

CONSTANTS Pois, Cap,
  MaxInside   \* how many POI circles the camera can stand in at once: 1, or 2 where two circles overlap on the map

VARIABLES
  st,       \* per POI: queued | trimming (picked, eviction pass running) | building | integrating | live
  dist,     \* per POI: "inside" (camera inside it: d <= 0) | "near" | "far"
  inMatch,  \* kr.game.inMatch (nextNearModule picks only in a match)
  loop,     \* the stream loop: "pick" (nextNearModule) | "trim" | "build" | "wait" (inflight back-pressure)
  thrown,   \* (for the rules) a POI was evicted while still building or fading in
  outside,  \* (for the rules) a POI was picked to build outside a match
  late      \* (for the rules) a build started outside a match (picked in one, left before its trim finished)
vars == <<st, dist, inMatch, loop, thrown, outside, late>>

Held == {p \in Pois : st[p] \in {"building", "integrating", "live"}}   \* hold GPU/CPU memory
\* what residents() counts (low-mem.ts trimStreamed): POIs in modOf that are live or still in building; a POI inside
\* its own build() is not in modOf yet (main.ts buildOne sets it when build() returns), so it does not count
Counted == {p \in Pois : st[p] \in {"integrating", "live"}}
\* evictionsFor (low-mem.ts): only live POIs (integrating ones are -Infinity) the camera is not inside
Evictable == {p \in Pois : st[p] = "live" /\ dist[p] # "inside"}
Integrating == {p \in Pois : st[p] = "integrating"}

Init ==
  /\ st = [p \in Pois |-> "queued"]
  /\ dist \in [Pois -> {"inside", "near", "far"}] /\ Cardinality({p \in Pois : dist[p] = "inside"}) <= MaxInside
  /\ inMatch = FALSE
  /\ loop = "pick"
  /\ thrown = FALSE /\ outside = FALSE /\ late = FALSE

(* the camera moves: any POI's distance class changes. A POI the camera stands in is never evicted (evictionsFor keeps
   d <= 0), and some POI circles overlap, so MaxInside = 2 lets the camera stand in two at once *)
Move ==
  /\ \E p \in Pois, d \in {"inside", "near", "far"} :
       /\ dist' = [dist EXCEPT ![p] = d]
       /\ Cardinality({q \in Pois : dist'[q] = "inside"}) <= MaxInside
  /\ UNCHANGED <<st, inMatch, loop, thrown, outside, late>>

EnterMatch == ~inMatch /\ inMatch' = TRUE /\ UNCHANGED <<st, dist, loop, thrown, outside, late>>
\* exitToRoom / leaveAll: nothing in main.ts or low-mem.ts listens (residents stay, builds in flight go on)
LeaveMatch == inMatch /\ inMatch' = FALSE /\ UNCHANGED <<st, dist, loop, thrown, outside, late>>

(* nextNearModule: in a match, a queued POI near the camera; the admission test (low-mem.ts nextNearModule) skips one that,
   counted lowmemhyst farther, would itself be evicted: in this abstraction, one that is not nearer than an evictable
   resident while the list is full *)
Pick ==
  /\ loop = "pick" /\ inMatch
  /\ \E p \in Pois :
       /\ st[p] = "queued" /\ dist[p] \in {"inside", "near"}
       /\ ~(Cardinality(Counted) >= Cap /\ dist[p] = "near" /\ \A q \in Evictable : dist[q] = "near")
       /\ st' = [st EXCEPT ![p] = "trimming"]
  /\ loop' = "trim" /\ outside' = (outside \/ ~inMatch)
  /\ UNCHANGED <<dist, inMatch, thrown, late>>

Incoming == CHOOSE p \in Pois : st[p] = "trimming"

(* trimStreamed(incoming), one pass of the loop: while the list with the incoming POI is over the cap, evict the
   farthest evictable resident (evictionsFor sorts by distance and pops the farthest); then building.add(incoming).
   stream() does not check the match again after the trim *)
Farthest(v) == dist[v] = "far" \/ \A q \in Evictable : dist[q] # "far"
TrimEvict ==
  /\ loop = "trim"
  /\ Cardinality(Counted) + 1 > Cap
  /\ \E v \in Evictable :
       /\ Farthest(v)
       /\ st' = [st EXCEPT ![v] = "queued"] /\ thrown' = (thrown \/ st[v] # "live")
  /\ UNCHANGED <<dist, inMatch, loop, outside, late>>
TrimDone ==
  /\ loop = "trim"
  /\ (Cardinality(Counted) + 1 <= Cap \/ Evictable = {})
  /\ st' = [st EXCEPT ![Incoming] = "building"]
  /\ loop' = "build" /\ late' = (late \/ ~inMatch)
  /\ UNCHANGED <<dist, inMatch, thrown, outside>>

(* buildStreamed: build() returns, then integrateFresh runs in the background; the loop waits only when two
   integrations are in flight (main.ts stream: inflight) *)
Built ==
  /\ loop = "build"
  /\ \E p \in Pois : st[p] = "building" /\ st' = [st EXCEPT ![p] = "integrating"]
  /\ loop' = IF Cardinality(Integrating) + 1 > 1 THEN "wait" ELSE "pick"
  /\ UNCHANGED <<dist, inMatch, thrown, outside, late>>
Integrated ==
  /\ \E p \in Integrating : st' = [st EXCEPT ![p] = "live"]
  /\ loop' = IF loop = "wait" /\ Cardinality(Integrating) - 1 <= 1 THEN "pick" ELSE loop
  /\ UNCHANGED <<dist, inMatch, thrown, outside, late>>

(* the 2 s timer: trim(null), in a match or not (main.ts: setInterval(() => void trim(null), 2000)); serialized with the loop's own trim *)
Timer ==
  /\ loop # "trim"
  /\ Cardinality(Counted) > Cap
  /\ \E v \in Evictable :
       /\ Farthest(v)
       /\ st' = [st EXCEPT ![v] = "queued"] /\ thrown' = (thrown \/ st[v] # "live")
  /\ UNCHANGED <<dist, inMatch, loop, outside, late>>

Next == Move \/ EnterMatch \/ LeaveMatch \/ Pick \/ TrimEvict \/ TrimDone \/ Built \/ Integrated \/ Timer

Spec == Init /\ [][Next]_vars

(* --- the rules --- *)
\* At most lowmemcap streamed POIs hold memory at once, counting the one being built.
AtMostCap == Cardinality(Held) <= Cap
\* The same rule with one POI of slack: the one being built while the others still finish.
AtMostCapPlusOne == Cardinality(Held) <= Cap + 1
\* A location is never thrown away while it is still building or fading in.
NoEvictWhileBuilding == ~thrown
\* Nothing new is picked to build outside a match (title, room, results lobby).
NothingPickedOutsideMatch == ~outside
\* No build starts outside a match.
NothingBuiltOutsideMatch == ~late
=============================================================================
