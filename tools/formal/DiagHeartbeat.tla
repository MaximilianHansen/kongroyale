---------------------------- MODULE DiagHeartbeat ----------------------------
(* The player diagnostics' crash heartbeat, two tabs of one browser profile (they share localStorage and Web Locks).
   Design = "locks" is the code (client/src/playtest/beat.ts, diag.ts, report.ts, built after this model found the bugs
   of the plan, with the first beat written at boot); Design = "plan" is the design as first written (one shared record,
   beaten every 5 s, marked clean on pagehide), kept for DiagHeartbeat.findings.cfg, where all three rules break.

   Tabs are browser tabs; Sessions is a pool of page lifetimes: a tab that opens takes a fresh one, so "the crash of
   session 1" and "the page now open in tab a" are told apart.

   Not modelled: time (a 5 s beat is a step that may or may not happen before a kill), the 7-day expiry of old records
   (KEEP_MS), browsers without Web Locks (they keep no heartbeat), and the automatic summary, which is not built (when it
   is, add it back as an action that reports a dead session, under OneReportPerCrash). *)
EXTENDS Naturals, FiniteSets

CONSTANTS Tabs, Sessions, Design

None == 0
VARIABLES
  cur,      \* the session open in each tab, None = no page
  bf,       \* the page is in the back/forward cache (pagehide persisted), not running
  used,     \* sessions already started
  started,  \* locks: sessions whose first beat is written (beat.ts startBeat, in the boot chunk); plan: every opened session
  held,     \* locks: sessions whose page holds its Web Lock (taken by startBeat, released when the page dies)
  checked,  \* locks: sessions whose page looked for dead sessions (the lazy chunk ran findDeadSession)
  dead,     \* sessions that ended by a kill or crash, not by a clean pagehide
  seen,     \* dead sessions a load has picked up
  prompt,   \* the dead session the crash prompt on this tab's title is about, None = no prompt
  reports,  \* crash reports sent about each session
  hb,       \* plan: the one heartbeat record in localStorage
  hbs       \* locks: one heartbeat record per session, "none" | "running" | "clean" (kr.diag.hb.<sid>)
vars == <<cur, bf, used, started, held, checked, dead, seen, prompt, reports, hb, hbs>>

Live(t) == cur[t] # None
\* a page holds its session's Web Lock from startBeat until the page dies, the back/forward cache included
Running(s) == s \in held

Init ==
  /\ cur = [t \in Tabs |-> None] /\ bf = [t \in Tabs |-> FALSE]
  /\ used = {} /\ started = {} /\ held = {} /\ checked = {} /\ dead = {} /\ seen = {}
  /\ prompt = [t \in Tabs |-> None] /\ reports = [s \in Sessions |-> 0]
  /\ hb = [owner |-> None, clean |-> TRUE]
  /\ hbs = [s \in Sessions |-> "none"]

(* plan: what a load sees, the session it will report as crashed, or None *)
PlanSuspect == IF hb.owner # None /\ ~hb.clean THEN hb.owner ELSE None
\* locks (findDeadSession): a record not marked clean whose session holds no Web Lock is dead
LockSuspects == {s \in Sessions : hbs[s] = "running" /\ ~Running(s)}

Report(s) == [reports EXCEPT ![s] = @ + 1]

(* the page loads. plan: it looks for a dead session at once. locks: nothing yet; main.ts starts the heartbeat once the
   boot JS has run (BootBeat), before the world loads *)
Open(t) ==
  /\ ~Live(t)
  /\ \E s \in Sessions \ used :
       /\ cur' = [cur EXCEPT ![t] = s] /\ used' = used \cup {s}
       /\ IF Design = "plan"
            THEN /\ started' = started \cup {s}
                 /\ prompt' = [prompt EXCEPT ![t] = PlanSuspect]
                 /\ seen' = IF PlanSuspect = None THEN seen ELSE seen \cup {PlanSuspect}
            ELSE UNCHANGED <<started, prompt, seen>>
  /\ UNCHANGED <<bf, held, checked, dead, reports, hb, hbs>>

(* locks: main.ts -> beat.ts startBeat. It takes this session's Web Lock and writes the first record ("running") inside
   the lock, so the record never exists without the lock. A boot may take any number of steps of the other tab first *)
BootBeat(t) ==
  /\ Design = "locks" /\ Live(t) /\ ~bf[t] /\ cur[t] \notin started
  /\ held' = held \cup {cur[t]}
  /\ started' = started \cup {cur[t]}
  /\ hbs' = [hbs EXCEPT ![cur[t]] = "running"]
  /\ UNCHANGED <<cur, bf, used, checked, dead, seen, prompt, reports, hb>>

(* locks: the lazy playtest chunk, diag.ts installDiag -> findDeadSession once startBeat's lock is held (live.done).
   Under the one kr.diag.claim lock it deletes every suspect record and keeps the newest as prev; report.ts
   installReport shows the crash card about it (crashCard) *)
Check(t) ==
  /\ Design = "locks" /\ Live(t) /\ ~bf[t] /\ cur[t] \in started /\ cur[t] \notin checked
  /\ checked' = checked \cup {cur[t]}
  /\ \E p \in IF LockSuspects = {} THEN {None} ELSE LockSuspects :
       /\ prompt' = [prompt EXCEPT ![t] = p]
       /\ seen' = seen \cup LockSuspects
       /\ hbs' = [x \in Sessions |-> IF x \in LockSuspects THEN "none" ELSE hbs[x]]
  /\ UNCHANGED <<cur, bf, used, started, held, dead, reports, hb>>

(* plan: the 5 s heartbeat of a running page (locks: the 5 s beat rewrites a record that is already "running") *)
Beat(t) ==
  /\ Live(t) /\ ~bf[t] /\ Design = "plan"
  /\ hb' = [owner |-> cur[t], clean |-> FALSE]
  /\ UNCHANGED <<cur, bf, used, started, held, checked, dead, seen, prompt, reports, hbs>>

(* the player closes the tab or navigates away: pagehide, not persisted (startBeat's pagehide listener); the lock goes *)
Close(t) ==
  /\ Live(t) /\ ~bf[t]
  /\ hb' = IF Design = "plan" THEN [owner |-> cur[t], clean |-> TRUE] ELSE hb
  /\ hbs' = IF Design = "plan" \/ cur[t] \notin started THEN hbs ELSE [hbs EXCEPT ![cur[t]] = "clean"]
  /\ cur' = [cur EXCEPT ![t] = None] /\ prompt' = [prompt EXCEPT ![t] = None] /\ held' = held \ {cur[t]}
  /\ UNCHANGED <<bf, used, started, checked, dead, seen, reports>>

(* the browser kills the tab (Safari out of memory, a crash): no pagehide, and its Web Lock is released *)
Kill(t) ==
  /\ Live(t) /\ ~bf[t]
  /\ dead' = dead \cup {cur[t]}
  /\ cur' = [cur EXCEPT ![t] = None] /\ prompt' = [prompt EXCEPT ![t] = None] /\ held' = held \ {cur[t]}
  /\ UNCHANGED <<bf, used, started, checked, seen, reports, hb, hbs>>

(* pagehide, persisted: the page goes into the back/forward cache (startBeat's pagehide listener marks it clean), and
   pageshow brings it back (startBeat's pageshow listener: persisted, so it marks the record running at once) *)
Freeze(t) ==
  /\ Live(t) /\ ~bf[t] /\ bf' = [bf EXCEPT ![t] = TRUE]
  /\ hb' = IF Design = "plan" THEN [owner |-> cur[t], clean |-> TRUE] ELSE hb
  /\ hbs' = IF Design = "plan" \/ cur[t] \notin started THEN hbs ELSE [hbs EXCEPT ![cur[t]] = "clean"]
  /\ UNCHANGED <<cur, used, started, held, checked, dead, seen, prompt, reports>>
Thaw(t) ==
  /\ Live(t) /\ bf[t] /\ bf' = [bf EXCEPT ![t] = FALSE]
  /\ hbs' = IF Design = "plan" \/ cur[t] \notin started THEN hbs ELSE [hbs EXCEPT ![cur[t]] = "running"]
  /\ UNCHANGED <<cur, used, started, held, checked, dead, seen, prompt, reports, hb>>
\* a cached page the browser drops is a normal end, not a crash
Drop(t) ==
  /\ Live(t) /\ bf[t] /\ bf' = [bf EXCEPT ![t] = FALSE]
  /\ cur' = [cur EXCEPT ![t] = None] /\ prompt' = [prompt EXCEPT ![t] = None] /\ held' = held \ {cur[t]}
  /\ UNCHANGED <<used, started, checked, dead, seen, reports, hb, hbs>>

(* the player answers the crash card (report.ts crashCard): SEND opens the sheet and sends a crash report carrying
   prev with its sid (report.ts body); NO THANKS, or a match starting, removes the card *)
Answer(t) ==
  /\ Live(t) /\ ~bf[t] /\ prompt[t] # None
  /\ \E send \in BOOLEAN : reports' = IF send THEN Report(prompt[t]) ELSE reports
  /\ prompt' = [prompt EXCEPT ![t] = None]
  /\ UNCHANGED <<cur, bf, used, started, held, checked, dead, seen, hb, hbs>>

Done == used = Sessions /\ (\A t \in Tabs : ~Live(t)) /\ UNCHANGED vars

Next == \E t \in Tabs : Open(t) \/ BootBeat(t) \/ Check(t) \/ Beat(t) \/ Close(t) \/ Kill(t) \/ Freeze(t) \/ Thaw(t) \/ Drop(t)
  \/ Answer(t)
  \/ Done

Spec == Init /\ [][Next]_vars

(* --- the rules, in the player's words --- *)
\* The title never says "your last session closed unexpectedly" about a session that is still open, or that ended cleanly.
NoFalseCrash == \A t \in Tabs : prompt[t] # None => prompt[t] \in dead
\* A session that dies after its first beat is picked up by a later load: until then the evidence is still in
\* localStorage. A tab killed before main.ts runs (while the boot JS downloads and parses) leaves no record (see the skill).
NoLostCrash == \A s \in (dead \cap started) \ seen :
  IF Design = "plan" THEN hb.owner = s /\ ~hb.clean ELSE hbs[s] = "running"
\* One crash is reported at most once, however many tabs load and whatever the player taps.
OneReportPerCrash == \A s \in Sessions : reports[s] <= 1
=============================================================================
