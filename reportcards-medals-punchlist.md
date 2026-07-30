# HMS Resolute — Build Punch List: Weekly Report Cards + Medals
*Hand this directly to Claude Code, in the hms-resolute repo.*

---

## Part 1: Weekly Report Cards

### Scope
- One shared underlying report, viewable in **both** `bridge/index.html` (John) and `dashboard/index.html` (Dawn/Officers' Country) — same data, two surfaces, never drifting apart
- **Auto-generates weekly, viewable Mondays**
- **Also a manual "check in" trigger** — John or Dawn can generate/view a real-time snapshot any day, not just wait for Monday
- Must be **easy to copy as plain text** — John wants to paste it directly into a Claude.ai conversation for weekly review

### Step 1: Data aggregation function ✅ done
**Task for Claude Code:**
- New Cloud Function (or scheduled function) that pulls a full week's data per boy: `stewart/scores`, `stewart/deductions`, `stewart/wishes`, `stewart/strikes` (unfiltered by daily reset — full week visibility, per the moderation punch list's existing requirement), devotional/Courage Dare completion, White Glove results
- Also pulls Dawn-side data: Tink usage patterns, any relevant household notes
- Auto-runs weekly (scheduled for Monday), and is also callable on-demand for the manual check-in
- Output stored at `stewart/reportcards/{weekOf}` — shared, single source of truth for both surfaces

### Step 2: Report generation (the actual write-up)
**Task for Claude Code:**
- Use `claude-sonnet-4-6` (this needs real reasoning/pattern-noticing, not just data formatting) to turn the raw weekly data into an actual written summary per boy — specific, not generic ("completed every morning round, missed evening three times" style, matching what was originally envisioned for Hans's report card concept)
- Include real specifics: chore completion trends, strike incidents (with category and day), wish usage patterns, devotional consistency
- Also generate a plain-text version alongside any styled version — this is the copy-paste-friendly format John wants

### Step 3: Bridge UI
**File:** `bridge/index.html`
**Task for Claude Code:**
- New section displaying the current week's report card, pulling from `stewart/reportcards/{weekOf}`
- Manual "Check In" button that triggers Step 1's on-demand generation and displays the result
- Plain-text copy button (or easily selectable text block) for pasting elsewhere

### Step 4: Officers' Country UI
**File:** `dashboard/index.html`
**Task for Claude Code:**
- Same treatment as Step 3 — same data source, same manual check-in option, same copy-friendly format
- Keep visual style consistent with each file's own existing conventions (don't force identical styling across two different apps, just identical *data*)

---

## Part 2: Medals

### Scope
- Boys earn **medals** (not "badges") for streaks and good behavior
- Criteria (confirmed): 7-day clean streak, 30-day streak, a full week with zero moderation strikes, wish restraint (not spending all 3 wishes every day for a week), devotional consistency streak
- **Earning a medal triggers the existing celebration overlay** (`showCelebration()`, already used for screen-time unlocks) — reuse it, don't build a new popup
- **The boy's profile icon changes to a medal graphic for that week** — temporary visual change, not permanent, reverts after the week
- **A message posts in the family group chat** announcing it — e.g. "Stephen has earned [medal] for [reason] — let's all congratulate him!" — visible to the whole family, not just the boy

### Step 5: Medal criteria checker
**Task for Claude Code:**
- New function (client-side check on app load, or server-side scheduled check) that evaluates each boy against the 5 criteria using existing data (`stewart/scores`, `stewart/strikes`, `stewart/wishes`, devotional completion)
- On qualifying: write to `stewart/medals/{agentId}/{weekOf}` recording which medal(s) were earned
- Avoid re-triggering the same medal repeatedly for an already-ongoing streak — only fire once per qualifying event

### Step 6: Celebration + icon change (private, to the boy)
**Task for Claude Code:**
- On a new medal being recorded, call the existing `showCelebration(emoji, title, msg)` function with medal-appropriate content for that boy's own screen
- Temporarily override the boy's displayed `icon` (wherever `currentAgent.icon` / `s.icon` is rendered) with a medal graphic for the duration of that week, then revert to normal on the following week's reset
- Confirm this applies consistently everywhere the icon shows (`wt-icon`, activity displays, etc.), not just one spot

### Step 7: Family group chat announcement (public, to everyone)
**Task for Claude Code:**
- On the same medal-earning event, post a message to `stewart/groupchat` announcing it to the whole family — e.g. "Stephen has earned [Medal Name] for [reason] — let's all congratulate him!"
- Decide a consistent voice for this announcement (could be system-style/neutral, or routed through Tom's voice for the boys' side — John's call; default to a simple neutral announcement if no strong preference)
- Confirm this plays nicely with the existing chat moderation classifier — it should never itself get flagged as spam/gibberish, so make sure it's either exempt from classification or classifies cleanly

---

## Testing checklist
- [ ] Manually trigger the weekly aggregation — confirm real data pulled accurately for a test boy
- [ ] Confirm report appears identically (same content) in both Bridge and Officers' Country
- [ ] Confirm manual "Check In" works on-demand, separate from the Monday auto-run
- [ ] Copy the plain-text version — confirm it pastes cleanly, no broken formatting
- [ ] Force each of the 5 medal criteria — confirm celebration fires and icon changes for each
- [ ] Confirm icon reverts to normal the following week
- [ ] Confirm a medal doesn't re-fire every day during an ongoing streak — only once
- [ ] Confirm the family chat announcement posts correctly and isn't flagged by the moderation system

## Merge checklist
- [ ] Test on branch (`feature/reportcards-medals`) for a few real days/one real week before merging
- [ ] `firebase deploy --only functions`
- [ ] Merge to `main`, push to GitHub

---

*This closes out the original weekly report card concept from early planning, plus adds medals as a new motivational layer — separate from wishes, separate from moderation strikes, purely a recognition system.*
