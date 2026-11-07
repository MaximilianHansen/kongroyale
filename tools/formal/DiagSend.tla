------------------------------ MODULE DiagSend ------------------------------
(* The player diagnostics' send flow, one tab, as built (client/src/playtest/report.ts): SEND DIAGNOSTICS on
   the results card, REPORT A PROBLEM in the match menu, the crash card on the title, the send sheet (consent text,
   symptom chips, note, "Include my callsign"), and what the player sees after a send. The server accepts an upload
   or refuses it (POST /api/kongbot: rate limit, busy, too large); a send the server never answers is aborted after
   TIMEOUT_MS and shown as refused.

   RefusedShown = TRUE is the code; FALSE is the design as first written (a refused send went back without a word),
   kept for DiagSend.findings.cfg. Not modelled: the automatic summary, which is not built (when it is, add an
   automatic send, its setting, and a rule that it sends only while the setting is on). *)
EXTENDS Naturals

CONSTANTS RefusedShown

VARIABLES
  screen,     \* "title" | "crash" (the crash card on the title) | "match" | "menu" (match menu or results card)
              \* | "sheet" (the send sheet) | "sending" | "sent" | "refused"
  consented,  \* a send from the sheet went through once (kr.diag.consent in localStorage)
  sent,       \* what went to the server: a set of records
  via,        \* the send in flight came from the sheet ("sheet") or the results card's one tap ("quick")
  back        \* where the sheet and the toast return to
vars == <<screen, consented, sent, via, back>>

Init == screen \in {"title", "crash"} /\ consented = FALSE /\ sent = {} /\ via = "sheet" /\ back = "title"

Play == screen = "title" /\ screen' = "match" /\ UNCHANGED <<consented, sent, via, back>>
OpenMenu == screen = "match" /\ screen' = "menu" /\ UNCHANGED <<consented, sent, via, back>>
CloseMenu == screen = "menu" /\ screen' = "match" /\ UNCHANGED <<consented, sent, via, back>>
EndMatch == screen \in {"match", "menu"} /\ screen' = "title" /\ UNCHANGED <<consented, sent, via, back>>

(* SEND DIAGNOSTICS on the results card (report.ts quickSend): once the player has agreed it sends at once, without the
   callsign; the first time it opens the sheet *)
QuickSend ==
  /\ screen = "menu" /\ back' = "menu"
  /\ IF consented
       THEN screen' = "sending" /\ via' = "quick" /\ sent' = sent \cup {[callsign |-> FALSE, ticked |-> FALSE, consented |-> consented]}
       ELSE screen' = "sheet" /\ UNCHANGED <<via, sent>>
  /\ UNCHANGED consented
(* REPORT A PROBLEM (installReport takes over __kr.kongbot.open) and the crash card's SEND (crashCard) always open the
   sheet *)
OpenSheet ==
  /\ screen \in {"menu", "crash"}
  /\ screen' = "sheet" /\ back' = IF screen = "crash" THEN "title" ELSE "menu"
  /\ UNCHANGED <<consented, sent, via>>
(* the sheet's SEND (createSheet): the player has read the consent text on it; the callsign goes when ticked
   (report.ts body: reporter.name, ctx.game.callsign and the replay's names) *)
SheetSend == screen = "sheet" /\ \E t \in BOOLEAN :
  /\ screen' = "sending" /\ via' = "sheet"
  /\ sent' = sent \cup {[callsign |-> t, ticked |-> t, consented |-> TRUE]}
  /\ UNCHANGED <<consented, back>>
SheetCancel == screen = "sheet" /\ screen' = back /\ UNCHANGED <<consented, sent, via, back>>
DismissCrash == screen = "crash" /\ screen' = "title" /\ UNCHANGED <<consented, sent, via, back>>

(* the server answers (report.ts send). Accepted: "SENT, THANKS · <id>", and a send from the sheet stores the consent.
   Refused (a non-OK answer, no connection, or the TIMEOUT_MS abort): the sheet stays open with "Not sent: <why>", and
   a one-tap send shows a "NOT SENT" toast *)
Accepted ==
  /\ screen = "sending" /\ screen' = "sent"
  /\ consented' = (consented \/ via = "sheet")
  /\ UNCHANGED <<sent, via, back>>
Refused ==
  /\ screen = "sending"
  /\ screen' = IF RefusedShown THEN "refused" ELSE IF via = "sheet" THEN "sheet" ELSE back
  /\ UNCHANGED <<consented, sent, via, back>>
\* the toast goes away; a refused sheet send leaves the sheet open, where the player can send again or cancel
ToastGone ==
  /\ screen \in {"sent", "refused"}
  /\ screen' = IF screen = "refused" /\ via = "sheet" THEN "sheet" ELSE back
  /\ UNCHANGED <<consented, sent, via, back>>

Next == Play \/ OpenMenu \/ CloseMenu \/ EndMatch \/ QuickSend \/ OpenSheet \/ SheetSend \/ SheetCancel \/ DismissCrash
  \/ Accepted \/ Refused \/ ToastGone
\* every upload is answered in the end: the server replies, or report.ts send aborts it after TIMEOUT_MS
Spec == Init /\ [][Next]_vars /\ WF_vars(Accepted \/ Refused)

(* --- the rules --- *)
\* Nothing a player sends by hand leaves the browser before they have seen the consent text on the sheet.
NoManualSendWithoutConsent == \A r \in sent : r.consented
\* The callsign goes only in a send where "Include my callsign" was ticked.
CallsignOnlyWhenTicked == \A r \in sent : r.callsign => r.ticked
\* Every send ends with something on screen: the thank-you with the report id, or a message that it did not go.
EverySendAnswered == [][screen = "sending" => screen' \in {"sent", "refused"}]_vars
\* ... and a send never hangs: the player always sees one of the two in the end.
SendEnds == screen = "sending" ~> screen \in {"sent", "refused"}
=============================================================================
