# Job: LinkedIn – connect with a personalized note

Feed URLs are LinkedIn profile pages (`linkedin.com/in/...`), all in the same layout.
Do this on each page, then answer `next`.

## Steps

0. **Browse first, like a human.** On a newly opened profile, answer a single `{"type": "browse"}`
   (the extension scrolls to random depths of the whole page, pauses, and returns to the top on its
   own – no screenshots, so it costs nothing). Don't steer browsing with scroll/wait turns.
   The next screenshot shows the profile back at the top → step 1.
   Skip browsing only when resuming on a profile that was already browsed (history shows it).
1. Find the profile's action row under the headline: **Message**, **+ Follow**, **More**
   (only the row in the profile header – not the "More profiles for you" column on the right).
   Every `next` carries an `outcome` for the weekly summary: `sent`, `pending`, or `error`.
2. If that row shows **Pending** → the invitation was already sent: do nothing, `next` (`outcome: pending`).
   Not a working profile (page not found, unavailable, wrong URL) → `next` (`outcome: error`).
3. If that row shows **Connect** → click it.
   Otherwise click **More** (or "…") and look for **Connect** in the dropdown → click it.
   No Connect there either → close the dropdown (Escape) and `next` (`outcome: error`).
4. A modal "Add a note to your invitation?" appears:
   - It has an **Add a note** button → click it.
   - No **Add a note** button (Premium gone) → close the modal (Escape / ✕, never "Send without
     a note"), then `notify` "premium is gone" with `"alert": "linkedin_error"` (stops the run).
5. In the note box, type ONE of the saved first messages, chosen at random, like a human.
   Every message starts with "Hi": put the person's first name (from the profile header) after it:
   `Hi <FirstName>,\n\n<rest of the message>`.
6. Then follow SEND MODE from the prompt:
   - `review`: don't click Send – `notify` (with photo) and `pause`. After the human sends and resumes,
     confirm the row shows Pending, then `next`.
   - `auto`: click **Send**, confirm the row shows Pending, then `next`.
7. After an invitation is sent, check the bottom-left of the screen for LinkedIn's toast:
   - "Invitation sent…" or similar success → `next` with `outcome: sent` (Pending in the row confirms it too).
   - An error about the **weekly invitation limit** (toast or modal, e.g. "You've reached the
     weekly invitation limit") → `notify` "stopped for the weekly limit" with `"alert": "weekly_limit"`
     (with photo); the run stops.
     Don't try further profiles.
   The toast fades after a few seconds, so look on the first screenshot after Send/Resume; if it is
   gone, rely on the row (Pending = sent). A limit error may also appear as a modal right after
   clicking Connect – treat it the same way.

## First name

When the run works with server leads, the prompt has `LEAD FOR THIS PAGE: <name>` – take the first
name from it instead of the page.


Use the first word of the profile name, without emoji, credentials or titles
("Dr. Anna-Maria Smith, PhD" → "Anna-Maria"). If the name is unclear, use the
message without a name ("Hi,") rather than guessing.

The saved messages are long: #2 and #4 are 292 chars raw, so with "Hi <Name>," they only fit
300 for first names of ≤ 7 letters. For longer names pick #1, #3 or #5 (≤ 282 raw).

## Layout notes (learned from screenshots)

Learned on Jason French's profile, 2026-10-26, viewport 1680×770, 1/2 screenshot (784×359).
Positions are normalized [x1, y1, x2, y2].

- Profile header column x ≈ 0.16–0.64. Action row is below "500+ connections", around
  y ≈ 0.63–0.67 (moves with headline length): **Message** (blue) [0.18,0.635,0.245,0.67],
  **+ Follow** [0.245,0.635,0.30,0.67], **More** [0.302,0.637,0.336,0.669].
  3rd-degree profiles show no Connect in the row – it is in More.
- 2nd-degree profiles (e.g. Quinsen Joel) show **Connect** (blue) first in the row:
  Connect ≈ [0.182,0.637,0.236,0.668] · Message · More.
- The row's y position depends on how many lines the headline wraps to: Rene Pascua (3-line headline)
  had Connect at ≈ [0.184,0.733,0.234,0.76]. Always read it off the screenshot.
- After scrolling past the header, a sticky bar at the top shows More · Message · Connect
  (≈ y 0.08–0.12, right side of the main column). Scroll back to the top anyway before connecting.
- **Add a note** moves up when the modal text is shorter: ≈ [0.472,0.3,0.528,0.327] on Rene Pascua.
- **More dropdown** opens *above* the button (x ≈ 0.30–0.45, y ≈ 0.23–0.63), items top to bottom:
  Send profile in a message · Save to PDF · **Connect** (≈ [0.31,0.382,0.44,0.415]) · Report ·
  Block · About this member.
- **Invitation modal** (centered, top: x ≈ 0.34–0.66, y ≈ 0.04–0.38): title
  "Add a note to your invitation?", "💎 You have unlimited notes with Premium", buttons
  **Add a note** (white, ≈ [0.468,0.33,0.53,0.362]) and **Send without a note** (blue, right of it –
  never click). Close ✕ top-right of the modal.
- **Note box** (same place): title "Add a note to your invitation", textarea
  ≈ [0.355,0.225,0.648,0.32] with placeholder "Ex: We know each other from…", counter
  `0/300` (max 300 characters), buttons **Cancel** ≈ [0.563,0.402,0.598,0.432] and **Send**
  (grey until text is typed) ≈ [0.607,0.402,0.65,0.432].
- Cancel in the note box goes back to the first modal; **Escape** closes the modal without
  sending (safest way out).
- Docked Messaging panel covers the right edge (x ≈ 0.81–1.0); don't click inside it.
- After a click the extension may take minutes to come back (random breaks) – that's normal.
