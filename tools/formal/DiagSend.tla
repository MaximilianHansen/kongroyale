------------------------------ MODULE DiagSend ------------------------------
(* The player diagnostics' send flow, one tab, as built (client/src/playtest/report.ts): SEND DIAGNOSTICS on
   the results card, REPORT A PROBLEM in the match menu, the crash card on the title, the send sheet (consent text,
   symptom chips, note, "Include my callsign"), and what the player sees after a send. The server accepts an upload
   or refuses it (POST /api/kongbot: rate limit, busy, too large); a send the server never answers is aborted after
   TIMEOUT_MS and shown as refused.

   RefusedShown = TRUE is the code; FALSE is the design as first written (a refused send went back without a word),
   kept for DiagSend.findings.cfg.

   The automatic summary (client/src/playtest/consent.ts, auto.ts, beat.ts summariesOn, the Settings row in
   ui/settings-model.ts) is on by default for every player of a production build and asks nothing: with no stored choice a
   summary may go. What makes that honest is the toast: nothing is sent before the small one-time toast on the title was
   shown (or the player chose in Settings), none after the player turned it off in Settings, and none while the browser's
   privacy signal (Global Privacy Control or Do Not Track) is on, which also keeps the toast from showing. A page under
   automation (navigator.webdriver) sends nothing and shows no toast unless the URL asked for diagnostics (?diag, or a
   VITE_KR_DIAG build), and the default stores no heartbeat record under the privacy signal. Not modelled: which event
   triggers a row, its rate limits and its size, and the production-build and ?diag=0 conditions (a page without them
   never starts the summaries, which is the same as a bot page with no flag). *)
EXTENDS Naturals

CONSTANTS RefusedShown

VARIABLES
  screen,     \* "title" | "crash" (the crash card on the title) | "match" | "menu" (match menu or results card)
              \* | "sheet" (the send sheet) | "sending" | "sent" | "refused"
  consented,  \* a send from the sheet went through once (kr.diag.consent in localStorage)
  sent,       \* what went to the server: a set of records
  via,        \* the send in flight came from the sheet ("sheet") or the results card's one tap ("quick")
  back,       \* where the sheet and the toast return to
  told,       \* the toast was shown, or the player chose in Settings (kr.diag.auto.told in localStorage)
  autoSet,    \* the stored choice: "default" (none yet, which counts as on), "on" or "off" (kr.diag.auto)
  gpc,        \* the browser's privacy signal is on (Global Privacy Control or Do Not Track); fixed for the page
  wish,       \* what the player last asked for in Settings ("off" when they turned it off), whether or not it was stored
  bot,        \* the page runs under automation (navigator.webdriver); fixed for the page
  flagged,    \* the URL or build asked for diagnostics (?diag, or VITE_KR_DIAG=1); fixed for the page
  beat        \* the heartbeat record was written to localStorage (beat.ts startBeat)
auto == <<told, autoSet, gpc, wish, bot, flagged, beat>>
vars == <<screen, consented, sent, via, back, told, autoSet, gpc, wish, bot, flagged, beat>>
\* the automatic summaries start on this page: asked for by the URL or build, or the default outside automation
Runs == flagged \/ ~bot

Init == screen \in {"title", "crash"} /\ consented = FALSE /\ sent = {} /\ via = "sheet" /\ back = "title"
  /\ told \in BOOLEAN /\ autoSet \in {"default", "on", "off"} /\ (autoSet /= "default" => told) /\ gpc \in BOOLEAN /\ wish = autoSet
  /\ bot \in BOOLEAN /\ flagged \in BOOLEAN /\ beat = FALSE

Play == screen = "title" /\ screen' = "match" /\ UNCHANGED <<auto, consented, sent, via, back>>
OpenMenu == screen = "match" /\ screen' = "menu" /\ UNCHANGED <<auto, consented, sent, via, back>>
CloseMenu == screen = "menu" /\ screen' = "match" /\ UNCHANGED <<auto, consented, sent, via, back>>
EndMatch == screen \in {"match", "menu"} /\ screen' = "title" /\ UNCHANGED <<auto, consented, sent, via, back>>

(* SEND DIAGNOSTICS on the results card (report.ts quickSend): once the player has agreed it sends at once, without the
   callsign; the first time it opens the sheet *)
QuickSend ==
  /\ screen = "menu" /\ back' = "menu"
  /\ IF consented
       THEN screen' = "sending" /\ via' = "quick" /\ sent' = sent \cup {[kind |-> "manual", callsign |-> FALSE, ticked |-> FALSE, consented |-> consented]}
       ELSE screen' = "sheet" /\ UNCHANGED <<auto, via, sent>>
  /\ UNCHANGED <<auto, consented>>
(* REPORT A PROBLEM (installReport takes over __kr.kongbot.open) and the crash card's SEND (crashCard) always open the
   sheet *)
OpenSheet ==
  /\ screen \in {"menu", "crash"}
  /\ screen' = "sheet" /\ back' = IF screen = "crash" THEN "title" ELSE "menu"
  /\ UNCHANGED <<auto, consented, sent, via>>
(* the sheet's SEND (createSheet): the player has read the consent text on it; the callsign goes when ticked
   (report.ts body: reporter.name, ctx.game.callsign and the replay's names) *)
SheetSend == screen = "sheet" /\ \E t \in BOOLEAN :
  /\ screen' = "sending" /\ via' = "sheet"
  /\ sent' = sent \cup {[kind |-> "manual", callsign |-> t, ticked |-> t, consented |-> TRUE]}
  /\ UNCHANGED <<auto, consented, back>>
SheetCancel == screen = "sheet" /\ screen' = back /\ UNCHANGED <<auto, consented, sent, via, back>>
DismissCrash == screen = "crash" /\ screen' = "title" /\ UNCHANGED <<auto, consented, sent, via, back>>

(* the server answers (report.ts send). Accepted: "SENT, THANKS · <id>", and a send from the sheet stores the consent.
   A 200 JSON answer whose body the TIMEOUT_MS abort cut off is accepted too (without the id): the server only answers
   that way once the report is stored.
   Refused (a non-OK answer, no connection, or the TIMEOUT_MS abort): the sheet stays open with "Not sent: <why>", and
   a one-tap send shows a "NOT SENT" toast *)
Accepted ==
  /\ screen = "sending" /\ screen' = "sent"
  /\ consented' = (consented \/ via = "sheet")
  /\ UNCHANGED <<auto, sent, via, back>>
Refused ==
  /\ screen = "sending"
  /\ screen' = IF RefusedShown THEN "refused" ELSE IF via = "sheet" THEN "sheet" ELSE back
  /\ UNCHANGED <<auto, consented, sent, via, back>>
\* the toast goes away; a refused sheet send leaves the sheet open, where the player can send again or cancel
ToastGone ==
  /\ screen \in {"sent", "refused"}
  /\ screen' = IF screen = "refused" /\ via = "sheet" THEN "sheet" ELSE back
  /\ UNCHANGED <<auto, consented, sent, via, back>>

(* the one-time toast (auto.ts showNotice): on the title once it is ready, never under the privacy signal, and it marks
   the player as told when it appears. It asks nothing. The Settings row (disabled under the signal) stores the choice
   and counts as being told *)
ShowNotice == screen \in {"title", "crash"} /\ Runs /\ ~gpc /\ ~told /\ told' = TRUE /\ UNCHANGED <<screen, consented, sent, via, back, autoSet, gpc, wish, bot, flagged, beat>>
SettingsToggle == \E v \in {"on", "off"} :
  /\ screen \in {"title", "menu"} /\ ~gpc /\ autoSet' = v /\ wish' = v /\ told' = TRUE
  /\ UNCHANGED <<screen, consented, sent, via, back, gpc, bot, flagged, beat>>
(* the heartbeat's next write (beat.ts writeBeat, every 5 s and on pagehide or visibility): outside an explicit ?diag, with
   the summaries off, it deletes the record instead of writing it. (Not modelled while a send is in flight: a write there changes
   nothing a send reads, and EverySendAnswered watches every step of vars. The 5 s timer keeps running, so Spec makes it strongly fair.) *)
BeatTick == screen /= "sending" /\ beat /\ ~flagged /\ autoSet = "off" /\ beat' = FALSE /\ UNCHANGED <<screen, consented, sent, via, back, told, autoSet, gpc, wish, bot, flagged>>
(* a summary leaves (auto.ts emit and beacon): only when the player was told and has not turned it off and the privacy
   signal is off; never with the callsign *)
AutoSend ==
  /\ screen \in {"title", "menu", "match"}
  /\ Runs /\ told /\ autoSet /= "off" /\ ~gpc
  /\ sent' = sent \cup {[kind |-> "auto", callsign |-> FALSE, ticked |-> FALSE, consented |-> consented, told |-> told, off |-> (wish = "off"), gpc |-> gpc, bot |-> bot, flagged |-> flagged]}
  /\ UNCHANGED <<screen, consented, via, back, told, autoSet, gpc, wish, bot, flagged, beat>>
(* the heartbeat's first record (main.ts startBeat, once the boot JS has run): written when the page runs summaries and,
   outside an explicit ?diag, only when the browser's privacy signal is off and the player has not turned them off *)
BootBeat == screen \in {"title", "crash"} /\ ~beat /\ Runs /\ (flagged \/ (~gpc /\ autoSet /= "off")) /\ beat' = TRUE /\ UNCHANGED <<screen, consented, sent, via, back, told, autoSet, gpc, wish, bot, flagged>>

Next == Play \/ OpenMenu \/ CloseMenu \/ EndMatch \/ QuickSend \/ OpenSheet \/ SheetSend \/ SheetCancel \/ DismissCrash
  \/ Accepted \/ Refused \/ ToastGone \/ ShowNotice \/ SettingsToggle \/ AutoSend \/ BootBeat \/ BeatTick
\* every upload is answered in the end: the server replies, or report.ts send aborts it after TIMEOUT_MS
Spec == Init /\ [][Next]_vars /\ WF_vars(Accepted \/ Refused) /\ SF_vars(BeatTick)

(* --- the rules --- *)
\* Nothing a player sends by hand leaves the browser before they have seen the consent text on the sheet.
NoManualSendWithoutConsent == \A r \in sent : r.kind = "manual" => r.consented
\* The callsign goes only in a send where "Include my callsign" was ticked.
CallsignOnlyWhenTicked == \A r \in sent : r.callsign => r.ticked
\* An automatic summary leaves only after the toast was shown (or the player chose in Settings).
AutoOnlyAfterNotice == \A r \in sent : r.kind = "auto" => r.told
\* ... and never after the player turned it off in Settings or while the browser's privacy signal is on.
AutoRespectsOff == \A r \in sent : r.kind = "auto" => (~r.off /\ ~r.gpc)
\* A page under automation sends nothing unless the URL or build asked for diagnostics.
AutoNeverInAutomation == \A r \in sent : r.kind = "auto" => (~r.bot \/ r.flagged)
\* The default stores no heartbeat under the browser's privacy signal; only an explicit ?diag does.
NoBeatUnderSignal == beat => (flagged \/ ~gpc)
\* ... and a record that outlives a switch-off in Settings is deleted by the next write (within one 5 s beat), unless the player
\* switched back on first.
NoBeatAfterOff == (beat /\ ~flagged /\ autoSet = "off") ~> (~beat \/ autoSet /= "off")
\* Every send ends with something on screen: the thank-you with the report id, or a message that it did not go.
EverySendAnswered == [][screen = "sending" => screen' \in {"sent", "refused"}]_vars
\* ... and a send never hangs: the player always sees one of the two in the end.
SendEnds == screen = "sending" ~> screen \in {"sent", "refused"}
=============================================================================
