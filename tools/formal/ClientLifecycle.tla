--------------------------- MODULE ClientLifecycle ---------------------------
(* The game client's life from page load to the next match (client/src/main.ts boot, client/src/game/index.ts
   sessions, client/src/game/render.ts GameRender and its "match" resource scope, client/src/engine/res/restore.ts
   context loss), with the server's side reduced to the messages the client gets (the Lobby in server/index.ts). One player, one
   tab. Abstracted: the match's phases are one step each; positions, loot and timers are left out; the reload timers
   are a step that can happen while the context is lost.

   Online: CREATE/JOIN, the room, host START. Offline: PLAY vs bots (a practice match on an OfflineLink, or under
   ?hostworker=1 a WorkerLink whose host can die: PracticeHostLost). Left out: an online link that drops mid-match and
   the reconnect card (index.ts linkLost, reconnectTry), which end in the same exitToRoom rewire as MatchOver. *)
EXTENDS Naturals

CONSTANTS Online   \* TRUE: include the online room paths; FALSE: practice only (a smaller chart)

VARIABLES
  boot,      \* "loading" | "ready" (window.__kr.ready)
  prefabs,   \* kits.viewModel exists (built after ready by kr.prefabWarmP, index.ts:89,838)
  view,      \* what the player sees: "title" | "room" | "match" | "results"
  phase,     \* the match phase the client shows: "warmup" | "plane" | "play" | "results"
  link,      \* "none" | "offline" | "online"
  scope,     \* live "match" resource scopes (resources.root.child("match"), render.ts:163): 0 or 1
  render,    \* a GameRender is wired (render !== null in index.ts)
  seated,    \* online: the server still has this client in the running match
  err,       \* an error text is on screen (lobbyState.error)
  why,       \* the server ended this client's match with a reason the player has not seen dismissed yet
  silent,    \* the player pressed a button and nothing happened (no busy state, no error, no screen)
  ctx,       \* WebGL: "ok" | "lost" | "restoring"
  restores   \* restoreAll() runs in flight (restore-run.ts:13-20)
vars == <<boot, prefabs, view, phase, link, scope, render, seated, err, why, silent, ctx, restores>>

Init ==
  /\ boot = "loading" /\ prefabs = FALSE /\ view = "title" /\ phase = "warmup" /\ link = "none"
  /\ scope = 0 /\ render = FALSE /\ seated = FALSE /\ err = FALSE /\ why = FALSE /\ silent = FALSE
  /\ ctx = "ok" /\ restores = 0

Ready == boot = "loading" /\ boot' = "ready" /\ UNCHANGED <<prefabs, view, phase, link, scope, render, seated, err, why, silent, ctx, restores>>
Prefabs == boot = "ready" /\ ~prefabs /\ prefabs' = TRUE /\ UNCHANGED <<boot, view, phase, link, scope, render, seated, err, why, silent, ctx, restores>>

(* wire(l) (index.ts:276-291): dispose the old GameRender, then new GameRender: its field initializer opens the
   "match" scope (throws if one is still live, scope.ts:131), then its constructor needs kits.viewModel (render.ts:233) *)
WireScope == IF render THEN 0 ELSE scope            \* after render?.dispose()
WireOk == WireScope = 0 /\ prefabs
WireScopeAfter == IF WireScope = 0 THEN 1 ELSE WireScope

(* PLAY vs bots: offline() (index.ts:258-273): leaveAll, new OfflineLink, wire, start in 50 ms. A PLAY pressed before
   ready (Enter, a controller, a focused button) waits in prepareIsland for dataset.ready, so it is a PLAY after ready *)
Play ==
  /\ view = "title"   \* a lost context does not disable the title's buttons (restore.ts watchContext)
  /\ prefabs   \* after ready, kr.prepare() waits for the prefabs (main.ts:508-554)
  /\ scope' = WireScopeAfter /\ render' = WireOk
  /\ link' = "offline"
  /\ view' = (IF WireOk THEN "match" ELSE "title") /\ phase' = "warmup"
  /\ silent' = ~WireOk
  /\ UNCHANGED <<boot, prefabs, seated, err, why, ctx, restores>>

(* CREATE/JOIN: online() (index.ts:234-247) reuses the online link it has (235); one that closed at the title is
   already gone (SocketClosesAtTitle). Like PLAY,
   create and join await prepareIsland(), which waits for the prefabs after ready and resolves at once before it;
   before ready they wait there for dataset.ready, invite links included *)
Connect ==
  /\ Online /\ view = "title"
  /\ prefabs
  \* wire() runs inside online()'s try: when GameRender throws, the catch drops the link (the socket stays open,
  \* unreferenced) and shows "NO SERVER", a visible but wrong reason
  /\ link' = (IF WireOk THEN "online" ELSE "none") /\ scope' = WireScopeAfter /\ render' = WireOk
  /\ view' = (IF WireOk THEN "room" ELSE "title") /\ silent' = FALSE /\ err' = ~WireOk
  /\ UNCHANGED <<boot, prefabs, phase, seated, why, ctx, restores>>
\* a JOIN that fails ("NO SUCH LOBBY") leaves the socket open at the title; the JOIN went out after the renderer was wired
JoinFails ==
  /\ Online /\ boot = "ready" /\ prefabs /\ view = "title" /\ link \in {"none", "offline"}
  /\ link' = "online" /\ err' = TRUE
  /\ scope' = WireScopeAfter /\ render' = WireOk
  /\ UNCHANGED <<boot, prefabs, view, phase, seated, why, silent, ctx, restores>>
\* the socket closes at the title (server idle close, network drop): wire()'s onClose drops the link there, so the next
\* CREATE / JOIN connects again (in a match or a room it runs linkLost instead, which the model leaves out)
SocketClosesAtTitle ==
  /\ link = "online" /\ view = "title"
  /\ link' = "none"
  /\ UNCHANGED <<boot, prefabs, view, phase, scope, render, seated, err, why, silent, ctx, restores>>

\* the host presses START: the "match" message, enterMatch
Start == Online /\ view = "room" /\ link = "online" /\ view' = "match" /\ phase' = "warmup" /\ seated' = TRUE
  /\ UNCHANGED <<boot, prefabs, link, scope, render, err, why, silent, ctx, restores>>

\* the server's match moves on: phase messages
NextPhase ==
  /\ view = "match" /\ phase # "results" /\ (link = "offline" \/ seated)
  /\ phase' = CASE phase = "warmup" -> "plane" [] phase = "plane" -> "play" [] OTHER -> "results"
  /\ view' = (IF phase = "play" THEN "results" ELSE view)
  /\ UNCHANGED <<boot, prefabs, link, scope, render, seated, err, why, silent, ctx, restores>>

(* the match is over: online, the room frame inMatch:false runs exitToRoom (dispose, wire: a new idle GameRender);
   offline, the results card stays until the player leaves *)
MatchOver ==
  /\ view = "results" /\ link = "online" /\ seated
  /\ view' = "room" /\ seated' = FALSE /\ err' = FALSE
  /\ scope' = WireScopeAfter /\ render' = WireOk
  /\ UNCHANGED <<boot, prefabs, phase, link, why, silent, ctx, restores>>

\* leaveAll(): back to the title from anywhere (pause menu Leave, BACK TO LOBBY offline, LEAVE in the room)
Leave ==
  /\ view \in {"room", "match", "results"}
  /\ view' = "title" /\ link' = "none" /\ seated' = FALSE /\ err' = FALSE /\ why' = FALSE /\ silent' = FALSE
  /\ scope' = (IF render THEN 0 ELSE scope) /\ render' = FALSE
  /\ UNCHANGED <<boot, prefabs, phase, ctx, restores>>

(* the practice host worker dies mid-match (host-worker.ts HostWorker.fail): the WorkerLink closes, wire()'s onClose runs
   linkLost, which for an offline link is leaveAll plus the reason on the title (setBusy) *)
PracticeHostLost ==
  /\ view \in {"match", "results"} /\ link = "offline"
  /\ link' = "none" /\ view' = "title" /\ err' = TRUE /\ seated' = FALSE /\ why' = FALSE /\ silent' = FALSE
  /\ scope' = (IF render THEN 0 ELSE scope) /\ render' = FALSE
  /\ UNCHANGED <<boot, prefabs, phase, ctx, restores>>

(* the server takes this client out of a running match for inactivity (Lobby.housekeeping in server/index.ts, any lobby): unseat (a bot
   plays the seat, the room frame still lists us), then error "REMOVED FOR INACTIVITY" with afk:true. The client shows
   the text, keeps it as the room's reason (roomReason) and runs backToRoom: exitToRoom (dispose, wire: a new idle
   GameRender) and the room until the next match (index.ts onJSON "error") *)
RemovedAfk ==
  /\ Online /\ view \in {"match", "results"} /\ link = "online" /\ seated
  /\ seated' = FALSE /\ err' = TRUE /\ why' = TRUE /\ view' = "room"
  /\ scope' = WireScopeAfter /\ render' = WireOk
  /\ UNCHANGED <<boot, prefabs, phase, link, silent, ctx, restores>>
(* the match crashes on the server (Lobby.pump, server/index.ts:231): error "MATCH CRASHED", then the room frame, whose handler
   clears lobbyState.error (index.ts:325) and runs exitToRoom *)
Crashed ==
  /\ Online /\ view \in {"match", "results"} /\ link = "online" /\ seated
  /\ seated' = FALSE /\ why' = TRUE /\ view' = "room" /\ err' = FALSE
  /\ scope' = WireScopeAfter /\ render' = WireOk
  /\ UNCHANGED <<boot, prefabs, phase, link, silent, ctx, restores>>

\* the player reads the message and goes on: any button dismisses it
Dismiss == why /\ why' = FALSE /\ err' = FALSE /\ UNCHANGED <<boot, prefabs, view, phase, link, scope, render, seated, silent, ctx, restores>>

(* WebGL context loss (restore.ts:44-62): lost stops the frame loop; restored runs restoreAll; nothing stops a second
   loss and restore while restoreAll is still running (only its final bookkeeping checks loss === losses) *)
Lose == ctx # "lost" /\ boot = "ready" /\ ctx' = "lost" /\ UNCHANGED <<boot, prefabs, view, phase, link, scope, render, seated, err, why, silent, restores>>
Restored == ctx = "lost" /\ ctx' = "restoring" /\ restores' = restores + 1 /\ UNCHANGED <<boot, prefabs, view, phase, link, scope, render, seated, err, why, silent>>
RestoreDone == restores > 0 /\ restores' = restores - 1 /\ ctx' = (IF ctx = "restoring" /\ restores = 1 THEN "ok" ELSE ctx)
  /\ UNCHANGED <<boot, prefabs, view, phase, link, scope, render, seated, err, why, silent>>
\* no restore within 10 s of the loss (30 s after the restored event): location.reload(), a fresh page
Reload ==
  /\ ctx \in {"lost", "restoring"}
  /\ boot' = "loading" /\ prefabs' = FALSE /\ view' = "title" /\ phase' = "warmup" /\ link' = "none"
  /\ scope' = 0 /\ render' = FALSE /\ seated' = FALSE /\ err' = FALSE /\ why' = FALSE /\ silent' = FALSE
  /\ ctx' = "ok" /\ restores' = 0

Next == Ready \/ Prefabs \/ Play \/ Connect \/ JoinFails \/ SocketClosesAtTitle \/ Start \/ NextPhase \/ MatchOver
  \/ Leave \/ PracticeHostLost \/ RemovedAfk \/ Crashed \/ Dismiss \/ Lose \/ Restored \/ RestoreDone \/ Reload

Spec == Init /\ [][Next]_vars

Bound == restores <= 2

(* --- the rules, in the player's words --- *)
\* The match's resource scope is open only while a match view (GameRender) owns it, so the next PLAY can open its own.
ScopeHasOwner == scope = 1 => render
\* Pressing PLAY, CREATE or JOIN always does something the player can see.
ButtonsAnswer == ~silent
\* A match on screen is one the server still plays for this player (offline matches always are).
NoFrozenMatch == view \in {"match", "results"} /\ link = "online" => seated
\* When the server ends the player's match with a reason, the reason stays on screen until the player moves on.
ReasonStays == why => err
\* One context restore at a time.
OneRestore == restores <= 1
\* A match on screen always has its renderer.
NoMatchWithoutRenderer == view \in {"match", "results"} => render
\* Once you are back on the title, the server no longer holds a seat in a match for you.
LeaveFreesTheSeat == view = "title" => ~seated
=============================================================================
