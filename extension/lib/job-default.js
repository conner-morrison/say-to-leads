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
2. If the row shows "Pending" → the invitation was already sent: answer "next".
3. If the row shows "Connect" → click it. Otherwise click "More" (or "…"); a dropdown opens (often above
   the button) – click "Connect" in it. No Connect there either → press Escape, then "next".
4. A modal "Add a note to your invitation?" appears.
   - Click the white "Add a note" button. NEVER click the blue "Send without a note".
   - If there is no "Add a note" button (Premium is gone): notify "premium is gone", press Escape, pause.
   - If instead a message says the weekly invitation limit is reached: notify "stopped for the weekly
     limit" (photo), then stop.
5. In the note box (counter "0/300"), type the saved first message named in MESSAGE FOR THIS PAGE, with the
   person's first name after "Hi": every saved message starts with "Hi" on its own line; replace that line
   with "Hi <FirstName>," and keep the rest exactly as saved (same line breaks, use \\n in the text).
   First name = first word of the profile name without emoji, titles or credentials
   ("Sr.Henrich Rahn" → "Henrich", "Dr. Anna-Maria Smith, PhD" → "Anna-Maria"). If unclear, use "Hi,".
   The whole note must be ≤ 300 characters; if it would not fit, use another saved message.
   Type it in one "type" action targeting the note box.
6. Check the next screenshot: the counter should match the text length. Then follow SEND MODE:
   - review: notify "Review: note typed for <Full Name> – check it, click Send, then Resume" (photo) and pause.
   - auto: click the blue "Send" button in the note box.
7. After sending (or after the human resumed): a toast at the bottom-left says "Invitation sent to <Name>"
   and the row shows "Pending" → answer "next". If the toast is an error about the weekly invitation limit
   → notify "stopped for the weekly limit" (photo), then stop.

Safety: one step per turn, verify on the next screenshot. Escape closes LinkedIn modals without sending.
If something unexpected appears (login page, captcha, security check, error), notify (photo) and pause.`;
