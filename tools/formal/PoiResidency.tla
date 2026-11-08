--------------------------- MODULE PoiResidency ---------------------------
(* Low-memory POI streaming on the client (client/src/low-mem.ts, client/src/main.ts stream()): which streamed
   locations hold memory, and when one is evicted. On by default in Safari and on devices reporting under 8 GB
   (low-mem-device.ts); this is what keeps a 16 GB Mac's Safari tab alive. Desktop Chrome builds every POI once and
   keeps it (no eviction), so it is not modelled.

   Abstracted: distances are four classes per POI, in the order the code ranks them (low-mem.ts distM): the camera
   is inside it; it is "ahead", the glide heads for it (within lowmemr of the 5 s lookahead while the player falls or
   glides, not by slant range, so the plane's height does not keep it out); near enough to build; far. The camera moves arbitrarily between ticks, and memory cost is a count (lowmemcap) rather than MB (lowmembudget,
   whose estimate starts at 400 MB a POI). Evicted is "queued again" (low-mem.ts trimStreamed). *)
EXTENDS Naturals, FiniteSets

CONSTANTS Pois, Cap,
  MaxInside   \* how many POI circles the camera can stand in at once: 1, or 2 where two circles overlap on the map

VARIABLES
  st,       \* per POI: queued | trimming (picked, eviction pass running) | building | integrating | live
  dist,     \* per POI: "inside" (camera inside it: d <= 0) | "ahead" (the glide heads for it) | "near" | "far"
  glide,    \* the local player is falling or gliding (low-mem.ts nearModule: cm.pred.st Freefall or Glide)
  inMatch,  \* kr.game.inMatch (nextNearModule picks only in a match)
  loop,     \* the stream loop: "pick" (nextNearModule) | "trim" | "build" | "wait" (inflight back-pressure)
  thrown,   \* (for the rules) a POI was evicted while still building or fading in
  outside,  \* (for the rules) a POI was picked to build outside a match
  late,     \* (for the rules) a build started outside a match (picked in one, left before its trim finished)
  skipped,  \* (for the rules) a pick took a POI behind or to the side while one the glide heads for was queued
  dropped   \* (for the rules) the POI the glide heads for was evicted while one behind or to the side stayed
vars == <<st, dist, glide, inMatch, loop, thrown, outside, late, skipped, dropped>>

Classes == {"inside", "ahead", "near", "far"}
\* distM's order: inside (d <= 0) < ahead of the glide (the 5 s lookahead puts it nearest) < near < far; evictionsFor pops the highest rank first
Rank(p) == CASE dist[p] = "inside" -> 0 [] dist[p] = "ahead" -> 1 [] dist[p] = "near" -> 2 [] OTHER -> 3

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
  /\ glide = FALSE
  /\ inMatch = FALSE
  /\ loop = "pick"
  /\ thrown = FALSE /\ outside = FALSE /\ late = FALSE /\ skipped = FALSE /\ dropped = FALSE

(* the camera moves: any POI's distance class changes. A POI the camera stands in is never evicted (evictionsFor keeps
   d <= 0), and some POI circles overlap, so MaxInside = 2 lets the camera stand in two at once *)
Move ==
  /\ \E p \in Pois, d \in Classes :
       /\ d = "ahead" => glide
       /\ dist' = [dist EXCEPT ![p] = d]
       /\ Cardinality({q \in Pois : dist'[q] = "inside"}) <= MaxInside
  /\ UNCHANGED <<st, glide, inMatch, loop, thrown, outside, late, skipped, dropped>>

(* the player leaves the plane (or any ledge) and falls or glides; on landing the 5 s foot lookahead takes over, so a
   POI that was ahead of the glide is just near *)
Jump == inMatch /\ ~glide /\ glide' = TRUE /\ UNCHANGED <<st, dist, inMatch, loop, thrown, outside, late, skipped, dropped>>
Land ==
  /\ glide /\ glide' = FALSE
  /\ dist' = [p \in Pois |-> IF dist[p] = "ahead" THEN "near" ELSE dist[p]]
  /\ UNCHANGED <<st, inMatch, loop, thrown, outside, late, skipped, dropped>>

EnterMatch == ~inMatch /\ inMatch' = TRUE /\ UNCHANGED <<st, dist, glide, loop, thrown, outside, late, skipped, dropped>>
\* exitToRoom / leaveAll: nothing in main.ts or low-mem.ts listens (residents stay, builds in flight go on)
LeaveMatch == inMatch /\ inMatch' = FALSE /\ glide' = FALSE /\ dist' = [p \in Pois |-> IF dist[p] = "ahead" THEN "near" ELSE dist[p]]
  /\ UNCHANGED <<st, loop, thrown, outside, late, skipped, dropped>>

(* nextNearModule: in a match, a queued POI within lowmemr; while falling or gliding that is the horizontal 5 s lookahead,
   so the POI ahead qualifies however high the player is. The admission test skips one that, counted lowmemhyst farther,
   would itself be evicted: in this abstraction, one that is not nearer than an evictable resident while the list is
   full. Of the admissible ones it picks the lowest distM (bestD) *)
Admissible(p) ==
  /\ st[p] = "queued" /\ dist[p] \in {"inside", "ahead", "near"}
  /\ ~(Cardinality(Counted) >= Cap /\ dist[p] # "inside" /\ \A q \in Evictable : Rank(q) <= Rank(p))
Pick ==
  /\ loop = "pick" /\ inMatch
  /\ \E p \in Pois :
       /\ Admissible(p)
       /\ \A q \in Pois : Admissible(q) => Rank(p) <= Rank(q)
       /\ st' = [st EXCEPT ![p] = "trimming"]
       /\ skipped' = (skipped \/ (Rank(p) > 1 /\ \E q \in Pois : st[q] = "queued" /\ dist[q] = "ahead"))
  /\ loop' = "trim" /\ outside' = (outside \/ ~inMatch)
  /\ UNCHANGED <<dist, glide, inMatch, thrown, late, dropped>>

Incoming == CHOOSE p \in Pois : st[p] = "trimming"

(* trimStreamed(incoming), one pass of the loop: while the list with the incoming POI is over the cap, evict the
   farthest evictable resident (evictionsFor sorts by distance and pops the farthest); then building.add(incoming).
   stream() does not check the match again after the trim *)
Farthest(v) == \A q \in Evictable : Rank(q) <= Rank(v)
\* evicting v drops the POI the glide heads for while a resident behind it or to the side stays
Drops(v) == dist[v] = "ahead" /\ \E q \in Evictable \ {v} : Rank(q) > Rank(v)
TrimEvict ==
  /\ loop = "trim"
  /\ Cardinality(Counted) + 1 > Cap
  /\ \E v \in Evictable :
       /\ Farthest(v)
       /\ st' = [st EXCEPT ![v] = "queued"] /\ thrown' = (thrown \/ st[v] # "live") /\ dropped' = (dropped \/ Drops(v))
  /\ UNCHANGED <<dist, glide, inMatch, loop, outside, late, skipped>>
TrimDone ==
  /\ loop = "trim"
  /\ (Cardinality(Counted) + 1 <= Cap \/ Evictable = {})
  /\ st' = [st EXCEPT ![Incoming] = "building"]
  /\ loop' = "build" /\ late' = (late \/ ~inMatch)
  /\ UNCHANGED <<dist, glide, inMatch, thrown, outside, skipped, dropped>>

(* buildStreamed: build() returns, then integrateFresh runs in the background; the loop waits only when two
   integrations are in flight (main.ts stream: inflight) *)
Built ==
  /\ loop = "build"
  /\ \E p \in Pois : st[p] = "building" /\ st' = [st EXCEPT ![p] = "integrating"]
  /\ loop' = IF Cardinality(Integrating) + 1 > 1 THEN "wait" ELSE "pick"
  /\ UNCHANGED <<dist, glide, inMatch, thrown, outside, late, skipped, dropped>>
Integrated ==
  /\ \E p \in Integrating : st' = [st EXCEPT ![p] = "live"]
  /\ loop' = IF loop = "wait" /\ Cardinality(Integrating) - 1 <= 1 THEN "pick" ELSE loop
  /\ UNCHANGED <<dist, glide, inMatch, thrown, outside, late, skipped, dropped>>

(* the 2 s timer: trim(null), in a match or not (main.ts: setInterval(() => void trim(null), 2000)); serialized with the loop's own trim *)
Timer ==
  /\ loop # "trim"
  /\ Cardinality(Counted) > Cap
  /\ \E v \in Evictable :
       /\ Farthest(v)
       /\ st' = [st EXCEPT ![v] = "queued"] /\ thrown' = (thrown \/ st[v] # "live") /\ dropped' = (dropped \/ Drops(v))
  /\ UNCHANGED <<dist, glide, inMatch, loop, outside, late, skipped>>

Next == Move \/ Jump \/ Land \/ EnterMatch \/ LeaveMatch \/ Pick \/ TrimEvict \/ TrimDone \/ Built \/ Integrated \/ Timer

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
\* While gliding, the POI the glide heads for builds before any queued POI behind it or to the side.
GlideTargetFirst == ~skipped
\* Making room never throws away the POI the glide heads for while one behind it or to the side stays.
GlideTargetKept == ~dropped
=============================================================================
