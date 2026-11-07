---------------------------- MODULE MatchPhases ----------------------------
(* Match phases: Warmup, Plane, Play, Results, then the match is over (a lobby match) or warms up again (practice).
   A model of Match.step's phase logic (shared/sim/match.ts) and the warm-up hold the host wires
   (MatchHost.holdForStream, shared/net/host.ts). Checked with TLC by tools/formal/tlc.mjs; the verify-match-phases
   skill says how to run and read it.

   Time is counted in steps of the match clock. Constants stand for the real ones at a smaller scale:
     W = WARMUP_S (25 s), Lead = the 3 s before the plane where the hold parks the clock, Cap = holdForStream's maxS
     (40 s, longer than the warm-up as in the code), PlaneLen = PLANE_OPEN_S + PLANE_BAY_S + 1, R = RESULTS_S.
   Squads are abstract: "alive" (a kong of it is alive), "waiting" (all down, a redeploy pending), "out" (eliminated).
   squadsLeft counts every squad in the warm-up, and the alive or waiting ones after it (Match.squadsLeft).
   The storm is three steps: 0 = phases with resurgence, 1 = phases without (PHASE_REF res: false from phase 5),
   2 = the last circle, radius 0, where nobody survives for long (storm.ts stormAt: done, dps 20).
   Left out: positions, health, loot, the economy (its buy-back revives a kong only while a squadmate is alive, so it
   never brings an eliminated squad back), solo redeploy limits (they only make the end come sooner), and the
   'time > 5' in checkEnd (the plane alone takes longer than that). *)
EXTENDS Integers, FiniteSets

CONSTANTS Squads, W, Lead, Cap, PlaneLen, R,
          EndAfterResults,   \* TRUE for a lobby match (server/index.ts Lobby.start), FALSE for practice
          Trios              \* TRUE: a squad wipe is final at once (Match.kill: no redeploy without a living squadmate)

VARIABLES phase, over, t, wall, held, skip, streaming, storm, res, sq
vars == <<phase, over, t, wall, held, skip, streaming, storm, res, sq>>

Live == phase \in {"plane", "play"}   \* the match clock runs: the storm moves, kongs die and redeploy
SquadsLeft == IF phase = "warmup" THEN Cardinality(Squads) ELSE Cardinality({q \in Squads : sq[q] # "out"})

\* enterWarmup (Lobby.start makes the Match, whose constructor calls it)
Init ==
  /\ phase = "warmup" /\ over = FALSE /\ t = 0 /\ wall = 0 /\ held = 0 /\ skip = FALSE
  /\ streaming \in BOOLEAN /\ storm = 0 /\ res = TRUE /\ sq = [q \in Squads |-> "alive"]

Fresh == storm' = 0 /\ res' = TRUE /\ sq' = [q \in Squads |-> "alive"]

\* ---- Match.step in the warm-up: the clocks move, then the hold, else the plane
HoldOn == held < Cap /\ streaming   \* holdForStream: warmHeldS < maxS and a seated peer still streaming
WarmTick ==
  /\ phase = "warmup" /\ ~over
  /\ LET pt == t + 1 IN LET ww == wall + 1 IN
     IF (pt >= W - Lead \/ skip) /\ ww < W /\ HoldOn
     THEN /\ held' = held + 1 /\ t' = (IF pt > W - Lead THEN W - Lead ELSE pt) /\ wall' = ww
          /\ UNCHANGED <<phase, skip>>
     ELSE IF pt >= W \/ skip \/ ww >= W
     THEN /\ phase' = "plane" /\ t' = 0 /\ skip' = FALSE /\ wall' = ww /\ UNCHANGED held   \* enterPlane
     ELSE /\ t' = pt /\ wall' = ww /\ UNCHANGED <<phase, held, skip>>
  /\ UNCHANGED <<over, streaming, storm, res, sq>>

\* the owner's START during a running match: Match.startNow (warm-up only)
StartNow == phase = "warmup" /\ ~skip /\ skip' = TRUE /\ UNCHANGED <<phase, over, t, wall, held, streaming, storm, res, sq>>

\* a client reports its island stream (onJSON "stream"), or a late joiner arrives still streaming
Stream == phase = "warmup" /\ streaming' = ~streaming /\ UNCHANGED <<phase, over, t, wall, held, skip, storm, res, sq>>

\* stepPlane: the plane flies; the bay closes and enterPlay
PlaneTick ==
  /\ phase = "plane"
  /\ IF t + 1 >= PlaneLen THEN phase' = "play" /\ t' = 0 ELSE (t' = t + 1 /\ UNCHANGED phase)
  /\ UNCHANGED <<over, wall, held, skip, streaming, storm, res, sq>>

\* stormAt: the storm runs on the match clock (its first circle closes long after the plane: PHASE_REF waits 80 s)
Storm == phase = "play" /\ storm < 2 /\ storm' = storm + 1 /\ UNCHANGED <<phase, over, t, wall, held, skip, streaming, res, sq>>

\* resurgence ends: the storm phase says so (or few squads are left; that only makes it sooner). Everyone waiting is out.
ResOff ==
  /\ Live /\ res /\ storm >= 1 /\ res' = FALSE
  /\ sq' = [q \in Squads |-> IF sq[q] = "waiting" THEN "out" ELSE sq[q]]
  /\ UNCHANGED <<phase, over, t, wall, held, skip, streaming, storm>>

\* Match.kill of a squad's last living kong: it waits to redeploy only while resurgence is on (and, in trios, never)
Wipe(q) ==
  /\ Live /\ sq[q] = "alive"
  /\ sq' = [sq EXCEPT ![q] = IF res /\ ~Trios THEN "waiting" ELSE "out"]
  /\ UNCHANGED <<phase, over, t, wall, held, skip, streaming, storm, res>>

\* stepRespawns: a waiting kong redeploys
Redeploy(q) == Live /\ res /\ sq[q] = "waiting" /\ sq' = [sq EXCEPT ![q] = "alive"] /\ UNCHANGED <<phase, over, t, wall, held, skip, streaming, storm, res>>

\* checkEnd: one squad (or none) left in Play: enterResults
End == phase = "play" /\ SquadsLeft <= 1 /\ phase' = "results" /\ t' = 0 /\ UNCHANGED <<over, wall, held, skip, streaming, storm, res, sq>>

\* the results screen, then over (Lobby.pump sees m.over and calls endMatch) or a new warm-up (practice)
ResultsTick ==
  /\ phase = "results" /\ ~over
  /\ IF t + 1 > R
     THEN IF EndAfterResults
          THEN (over' = TRUE /\ UNCHANGED <<phase, t, wall, held, skip, streaming, storm, res, sq>>)
          ELSE (phase' = "warmup" /\ t' = 0 /\ wall' = 0 /\ held' = 0 /\ skip' = FALSE /\ Fresh /\ UNCHANGED <<over, streaming>>)
     ELSE (t' = t + 1 /\ UNCHANGED <<phase, over, wall, held, skip, streaming, storm, res, sq>>)

\* the match is over and the lobby is back in its room: nothing moves any more
Done == over /\ UNCHANGED vars

Next ==
  \/ WarmTick \/ StartNow \/ Stream \/ PlaneTick \/ Storm \/ ResOff \/ End \/ ResultsTick \/ Done
  \/ \E q \in Squads : Wipe(q) \/ Redeploy(q)

\* The clocks always move; the storm's last circle wipes every squad still in it (strong fairness: it may be dodged for a
\* while, never forever); checkEnd runs every step.
Fairness ==
  /\ WF_vars(WarmTick) /\ WF_vars(PlaneTick) /\ WF_vars(ResultsTick) /\ WF_vars(Storm) /\ WF_vars(ResOff) /\ WF_vars(End)
  /\ \A q \in Squads : SF_vars(storm = 2 /\ phase = "play" /\ Wipe(q))

Spec == Init /\ [][Next]_vars /\ Fairness

\* ---- the rules

\* the only phase changes are Warmup -> Plane -> Play -> Results, and Results -> Warmup in practice
Edges == {<<"warmup", "plane">>, <<"plane", "play">>, <<"play", "results">>, <<"results", "warmup">>}
PhaseOrder == [][phase' # phase => <<phase, phase'>> \in Edges]_vars

\* the warm-up never lasts longer than a full warm-up, however long a client streams (Match.warmWall)
WarmupBounded == phase = "warmup" => wall <= W

\* the results screen has one winning squad, or none (all wiped at once)
OneWinner == phase = "results" => SquadsLeft <= 1

\* a match is over only from its results screen
OverFromResults == over => phase = "results"

\* a started lobby match ends: its loop stops and the players are back in the room (practice loops by design)
MatchEnds == EndAfterResults => <>over

\* every Play reaches its results (practice included)
PlayEnds == phase = "play" ~> phase = "results"
=============================================================================
