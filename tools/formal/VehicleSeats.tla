---------------------------- MODULE VehicleSeats ----------------------------
(* Vehicle seats in the match simulation: v.seats[k] (shared/sim/vehicle.ts) and each rider's own st = Ride, veh, seat
   (shared/sim/player.ts) store one fact twice. This model checks that every way in and out of a seat keeps the two
   copies equal. Checked with TLC by tools/formal/tlc.mjs (the verify-vehicle-seats skill says how to run and read it).

   One step is one function call that runs to completion inside Match.step (shared/sim/match.ts unless named):
     Enter     useVehicle: freeSeat then enterVehicle (vehicle.ts)
     GetOut    stepRide (player.hot.ts): E pressed, or the vehicle is not on its wheels any more: exitVehicle; a vehicle
               already Gone is passed as null, so its seat is not touched
     Switch    stepRide: crouch (switchSeat) or a seat key (takeSeat), vehicle.ts
     Die       kill: frees the seat if it is still this kong's, then veh = -1, st = Dead
     Tip       a tuk-tuk goes over (vehicle.ts stepVehicle/stepTumble set VS.Tipped and VE.TIP); the riders are thrown
               by tukEvents a moment later, or by their own stepRide first
     Sink      the water takes it (VS.Sunk and VE.SUNK); tukEvents ejects everyone
     Events    tukEvents: ejectAll on TIP or SUNK
     Blow      blowTuk: ejectAll, then a wreck
     Clear     stepVehicles: a wreck or a sunk vehicle is cleared away, or (warm-up) a fresh one spawns on its spot
     Flip      useVehicle on a tipped tuk-tuk: flipVehicle; Righted when stepRighting finishes
     Heal      stepVehicles: a seat whose kong is no longer Ride on this vehicle and seat is freed
     Phase     enterWarmup / enterPlane: spawnTuks (vehs.reset, then fresh vehicles) and resetForMatch on every player
     Respawn   a dead kong comes back on foot (warm-up respawn, redeploy, buy-back)
   Left out: positions, physics, health (any vehicle may tip, sink or blow at any time), helicopters' extra rules, and
   the order of players and vehicles inside one tick (any order is allowed here, which covers the real one). *)
EXTENDS Integers, FiniteSets

CONSTANTS Players, Vehicles, Rivals, None   \* Rivals: the kongs of the second squad; the rest are the first

Team(p) == IF p \in Rivals THEN 1 ELSE 0

Seats == 0 .. 2
VehStates == {"ok", "tipped", "righting", "wreck", "sunk", "gone"}

VARIABLES st, veh, seat, vst, seats, evt
vars == <<st, veh, seat, vst, seats, evt>>

Init ==
  /\ st = [p \in Players |-> "ground"] /\ veh = [p \in Players |-> None] /\ seat = [p \in Players |-> 0]
  /\ vst = [v \in Vehicles |-> "ok"] /\ seats = [v \in Vehicles |-> [k \in Seats |-> None]] /\ evt = [v \in Vehicles |-> FALSE]

Riding(p) == st[p] = "ride"

\* vehicle.ts freeSeat: the first empty seat, only on its wheels and only if no other squad is aboard
FreeSeat(v, p) ==
  IF \/ vst[v] # "ok"
     \/ \E k \in Seats : seats[v][k] # None /\ Team(seats[v][k]) # Team(p)
     \/ \A k \in Seats : seats[v][k] # None
  THEN -1 ELSE CHOOSE k \in Seats : seats[v][k] = None /\ \A j \in Seats : j < k => seats[v][j] # None

\* vehicle.ts exitVehicle(p, v): the seat is freed only if it is still p's; p is on foot
ExitSeats(p, v) == IF seats[v][seat[p]] = p THEN [seats EXCEPT ![v][seat[p]] = None] ELSE seats

\* match.ts ejectAll: every seat freed; each kong still riding this vehicle gets out
EjectAll(v) ==
  /\ seats' = [seats EXCEPT ![v] = [k \in Seats |-> None]]
  /\ st' = [p \in Players |-> IF Riding(p) /\ veh[p] = v /\ \E k \in Seats : seats[v][k] = p THEN "ground" ELSE st[p]]
  /\ veh' = [p \in Players |-> IF Riding(p) /\ veh[p] = v /\ \E k \in Seats : seats[v][k] = p THEN None ELSE veh[p]]
  /\ seat' = [p \in Players |-> IF Riding(p) /\ veh[p] = v /\ \E k \in Seats : seats[v][k] = p THEN 0 ELSE seat[p]]

Enter(p, v) ==
  /\ st[p] = "ground" /\ FreeSeat(v, p) # -1
  /\ seats' = [seats EXCEPT ![v][FreeSeat(v, p)] = p]
  /\ st' = [st EXCEPT ![p] = "ride"] /\ veh' = [veh EXCEPT ![p] = v] /\ seat' = [seat EXCEPT ![p] = FreeSeat(v, p)]
  /\ UNCHANGED <<vst, evt>>

GetOut(p) ==
  /\ Riding(p)
  /\ seats' = IF vst[veh[p]] = "gone" THEN seats ELSE ExitSeats(p, veh[p])
  /\ st' = [st EXCEPT ![p] = "ground"] /\ veh' = [veh EXCEPT ![p] = None] /\ seat' = [seat EXCEPT ![p] = 0]
  /\ UNCHANGED <<vst, evt>>

\* switchSeat / takeSeat: only while the vehicle is on its wheels (stepRide gets out first otherwise)
Switch(p, k) ==
  /\ Riding(p) /\ vst[veh[p]] = "ok" /\ k # seat[p] /\ seats[veh[p]][k] = None
  /\ seats' = [ExitSeats(p, veh[p]) EXCEPT ![veh[p]][k] = p]
  /\ seat' = [seat EXCEPT ![p] = k]
  /\ UNCHANGED <<st, veh, vst, evt>>

Die(p) ==
  /\ st[p] \in {"ground", "ride"}
  /\ seats' = IF Riding(p) THEN ExitSeats(p, veh[p]) ELSE seats
  /\ st' = [st EXCEPT ![p] = "dead"] /\ veh' = [veh EXCEPT ![p] = None]
  /\ UNCHANGED <<seat, vst, evt>>

Respawn(p) ==
  /\ st[p] = "dead"
  /\ st' = [st EXCEPT ![p] = "ground"] /\ veh' = [veh EXCEPT ![p] = None] /\ seat' = [seat EXCEPT ![p] = 0]
  /\ UNCHANGED <<vst, seats, evt>>

Tip(v) == vst[v] = "ok" /\ vst' = [vst EXCEPT ![v] = "tipped"] /\ evt' = [evt EXCEPT ![v] = TRUE] /\ UNCHANGED <<st, veh, seat, seats>>
Sink(v) == vst[v] \in {"ok", "tipped", "righting"} /\ vst' = [vst EXCEPT ![v] = "sunk"] /\ evt' = [evt EXCEPT ![v] = TRUE] /\ UNCHANGED <<st, veh, seat, seats>>
Events(v) == evt[v] /\ vst[v] # "gone" /\ EjectAll(v) /\ evt' = [evt EXCEPT ![v] = FALSE] /\ UNCHANGED vst
Blow(v) == vst[v] \in {"ok", "tipped", "righting"} /\ EjectAll(v) /\ vst' = [vst EXCEPT ![v] = "wreck"] /\ UNCHANGED evt
Clear(v) ==
  /\ vst[v] \in {"wreck", "sunk"} /\ ~evt[v]
  /\ \E to \in {"gone", "ok"} : vst' = [vst EXCEPT ![v] = to]
  /\ seats' = [seats EXCEPT ![v] = IF vst'[v] = "ok" THEN [k \in Seats |-> None] ELSE @]   \* spawnVehicle empties the seats
  /\ UNCHANGED <<st, veh, seat, evt>>
Flip(v) == vst[v] = "tipped" /\ vst' = [vst EXCEPT ![v] = "righting"] /\ UNCHANGED <<st, veh, seat, seats, evt>>
Righted(v) == vst[v] = "righting" /\ vst' = [vst EXCEPT ![v] = "ok"] /\ UNCHANGED <<st, veh, seat, seats, evt>>

\* stepVehicles (skips Gone, and wrecks and sunk ones before this loop)
Heal(v) ==
  /\ vst[v] \notin {"gone", "wreck", "sunk"}
  /\ \E k \in Seats : seats[v][k] # None /\ ~(Riding(seats[v][k]) /\ veh[seats[v][k]] = v /\ seat[seats[v][k]] = k)
  /\ seats' = [seats EXCEPT ![v] = [k \in Seats |-> IF @[k] # None /\ Riding(@[k]) /\ veh[@[k]] = v /\ seat[@[k]] = k THEN @[k] ELSE None]]
  /\ UNCHANGED <<st, veh, seat, vst, evt>>

\* spawnTuks + resetForMatch on everyone: a new fleet, every kong on foot (or on the plane)
Phase ==
  /\ seats' = [v \in Vehicles |-> [k \in Seats |-> None]] /\ vst' = [v \in Vehicles |-> "ok"] /\ evt' = [v \in Vehicles |-> FALSE]
  /\ st' = [p \in Players |-> "ground"] /\ veh' = [p \in Players |-> None] /\ seat' = [p \in Players |-> 0]

Next ==
  \/ \E p \in Players : GetOut(p) \/ Die(p) \/ Respawn(p) \/ \E v \in Vehicles : Enter(p, v)
  \/ \E p \in Players, k \in Seats : Switch(p, k)
  \/ \E v \in Vehicles : Tip(v) \/ Sink(v) \/ Events(v) \/ Blow(v) \/ Clear(v) \/ Flip(v) \/ Righted(v) \/ Heal(v)
  \/ Phase

Spec == Init /\ [][Next]_vars

\* ---- the rules

\* a seat names a kong exactly when that kong rides this vehicle in this seat (the two copies agree)
SeatsAgree == \A v \in Vehicles, k \in Seats, p \in Players :
  (seats[v][k] = p) <=> (Riding(p) /\ veh[p] = v /\ seat[p] = k)

\* no dead kong holds a seat
NoDeadRider == \A v \in Vehicles, k \in Seats : seats[v][k] # None => st[seats[v][k]] # "dead"

\* one squad per vehicle
OneSquad == \A v \in Vehicles, j, k \in Seats :
  (seats[v][j] # None /\ seats[v][k] # None) => Team(seats[v][j]) = Team(seats[v][k])

\* a kong rides only a vehicle on its wheels, or one that has just gone over or under and is about to throw it out
RideOnWheels == \A p \in Players : Riding(p) => (vst[veh[p]] = "ok" \/ evt[veh[p]])
=============================================================================
