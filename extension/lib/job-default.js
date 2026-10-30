// Default job (Settings → Feed & job). Written for the analyzer model; mirrors jobs/linkedin-connect.md.

export const DEFAULT_JOB = `LinkedIn – send a connection request with a personal note on each feed page.

Each feed page is a LinkedIn profile (linkedin.com/in/...). Do these steps in order. Use RECENT HISTORY
to know which steps are already done on this page.

Work ONLY on feed pages. If FEED says "not opened yet", answer only {"type":"next"} – whatever the tab
shows now is not part of the job, even if it is a profile. Never connect with anyone outside the feed.

0. Browse first. On a newly opened profile (no history yet on this page) answer only {"type":"browse"}.
   The extension reads the page by itself and comes back to the top. Never steer browsing with scroll/wait.
1. Find the action row in the profile header (left main column, under the name/headline/connections):
   e.g. "Connect · Message · More" (2nd degree) or "Message · + Follow · More" (3rd degree).
   Ignore buttons in the right-hand "More profiles for you" column, ads, and the Messaging panel.
Every "next" carries an outcome: "sent" (the invitation went out on this page), "pending" (it showed
Pending already), or "error" (anything else that kept the invitation from being sent).

2. If the row shows "Pending" → the invitation was already sent: answer {"type":"next","outcome":"pending"}.
   If the page is not a working profile (page not found, "This page doesn't exist", unavailable profile,
   wrong URL) → {"type":"next","outcome":"error"}.
3. Answer only {"type":"connect"}. Never click Connect or More by box yourself: the extension finds the header's
   Connect button in the page – directly, or by opening More (…) and picking Connect in its menu – and clicks it.
   The next prompt's RESULT OF YOUR LAST ACTIONS says what happened:
   - "ok – clicked Connect…" → the invitation modal should be on the screenshot → step 4.
   - "ok – … Pending …" → already invited: {"type":"next","outcome":"pending"}.
   - "FAILED …" (no Connect, the menu has none) → the menu is already closed. But if the screenshot shows a
     Connect button in the profile's own header row (left column, under the name – e.g. "Connect · Save in Sales
     Navigator · …"; not the right-hand column), click that Connect by box once; the click result names what it hit
     (ok – clicked "Connect"…). Otherwise next with outcome "error".
   If the screenshot contradicts the result (no modal after "clicked Connect"), try {"type":"connect"} once more,
   then next with outcome "error".
4. A modal "Add a note to your invitation?" appears.
   - Answer {"type":"add_note"}: the extension clicks the white "Add a note" itself and never the blue
     "Send without a note" right next to it. Never click buttons in this modal by box.
   - If the result is "FAILED – no "Add a note" button" (Premium is gone): press Escape, then notify
     "premium is gone" with alert "linkedin_error" (photo).
   - If the modal asks for the member's email ("To verify this member knows you, please enter their email to
     connect"): we don't have it, so this profile can't be invited. Press Escape, then
     {"type":"next","outcome":"error"} – NOT an alert (it is this one profile, not a LinkedIn problem).
   - If instead a message says the weekly invitation limit is reached: press Escape, then notify
     "stopped for the weekly limit" with alert "weekly_limit" (photo).
   Fallback for steps 4-6: if add_note, note or send_invite FAILED with "no invitation modal found" although
   the modal is on the screenshot, the extension cannot read it – do that step yourself by box instead:
   add_note → click the white/outlined "Add a note" (LEFT of the blue "Send without a note" – box only that
   button, never the blue one); note → {"type":"type","box":<the note text area>,"text":...,"clear":true};
   send_invite → click the blue "Send" at the bottom-right of the note modal (never "Cancel"). Verify each on
   the next screenshot (note: the counter under the box, e.g. "287/300", must be greater than 0 before Send).
   A click's result names what it hit (ok – clicked "Add a note"); if it names anything else, Escape is NOT
   needed – re-check the screenshot and correct the box. "refused – the box is on …" means your box was on a
   forbidden button (Send without a note, Save in Sales Navigator): nothing was clicked, fix the box.
5. In the note box (counter "0/300"), type the saved first message named in MESSAGE FOR THIS PAGE, with the
   person's first name after "Hi": every saved message starts with "Hi" on its own line; replace that line
   with "Hi <FirstName>," and keep the rest exactly as saved (same line breaks, use \\n in the text).
   If the prompt has LEAD FOR THIS PAGE, take the first name from that name, not from the page.
   First name = first word of the profile name without emoji, titles or credentials
   ("Sr.Henrich Rahn" → "Henrich", "Dr. Anna-Maria Smith, PhD" → "Anna-Maria"). If unclear, use "Hi,".
   The whole note must be ≤ 300 characters; if it would not fit, use another saved message.
   Type it with one {"type":"note","text":"..."} action: the extension finds the note box itself.
6. The result says how many characters the box holds and whether that matches the text; if it does not,
   send {"type":"note"} again with the same text (it replaces what is there). Then follow SEND MODE:
   - review: notify "Review: note typed for <Full Name> – check it, click Send, then Resume" (photo) and pause.
   - auto: answer {"type":"send_invite"} – the extension clicks the modal's blue "Send".
7. After sending (or after the human resumed): a toast at the bottom-left says "Invitation sent to <Name>"
   and the row shows "Pending" → answer next with outcome "sent". If the toast is an error about the weekly invitation limit
   → notify "stopped for the weekly limit" with alert "weekly_limit" (photo).

Safety: one step per turn, verify on the next screenshot. Escape closes LinkedIn modals without sending.
If something unexpected appears (login page, captcha, security check, error), notify what you see with
alert "linkedin_error" (photo). Alert notifies stop the run, so put them last.`;
