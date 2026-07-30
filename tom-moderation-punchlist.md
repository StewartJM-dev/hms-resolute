# HMS Resolute — Build Punch List: Tom Chat Moderation
*Hand this directly to Claude Code, in the hms-resolute repo. Adds a new duty to the existing Tom (Compass), no new character.*

---

## Scope
Tom gains a second job: moderating the boys' group chat (`stewart/groupchat`) and private threads (`stewart/messages/{agentId}`) for two categories of behavior. This is fully separate from Tom's wish economy — moderation never costs or touches wishes.

**Category A — Spam/gibberish/67/emoji strings:**
- Message auto-deleted from the chat
- Boy gets a private nudge from Tom in his own thread (`stewart/messages/{agentId}`), explaining what happened, in Tom's existing voice
- Counts as 1 strike

**Category B — Unkindness (put-downs, name-calling, sibling conflict):**
- Same private Tom nudge, same 1 strike
- **Additionally**, immediately notifies John and Dawn — every time, regardless of strike count. Reuse the existing `notifyGroupChat`/`notifyPrivateThread` pattern in `functions/index.js` for how parent notifications already fire.

**Strikes:**
- 3 strikes in a day (either category, or mixed) → that boy's group chat is auto-paused for the rest of the day
- Reuse the **existing manual pause toggle** already built in `dashboard/index.html` (~line 3903, "CHAT MODERATION" section, `unmuteBoy()` function) — don't build a new pause mechanism, trigger the existing one programmatically
- Parent notification fires when auto-pause triggers, explaining why (same as when John manually pauses today)
- **Resets to zero every midnight** — no carryover, no memory of yesterday in the daily counter
- **The weekly report card is NOT limited by the daily reset** — it should pull the full, unfiltered history of strikes/incidents across the whole week, so patterns are visible even though each day starts clean for the boy

---

## Step 1: Message classification ✅ done
**Task for Claude Code:**
- Add a Cloud Function trigger that fires on new writes to `stewart/groupchat` and `stewart/messages/{agentId}` (mirroring how `notifyGroupChat`/`notifyPrivateThread` already trigger on those paths)
- Classify each new message into: `clean`, `gibberish_spam` (includes "67," emoji-only strings, keyboard mashing), or `unkind`
- Use `claude-haiku-4-5-20251001` — this is a fast, cheap classification task, not a creative one
- Age-appropriate context: these are boys 6–11, messages are short

## Step 2: Handle Category A (gibberish/spam) ✅ done
**Task for Claude Code:**
- On `gibberish_spam` classification: delete the message from `stewart/groupchat` (or the private thread), increment that boy's daily strike counter (`stewart/strikes/{agentId}/{date}`), and push a private Tom-voiced nudge to `stewart/messages/{agentId}` explaining the deletion
- Tom's nudge should stay in his existing voice — firm but warm, matching his established catchphrase style (e.g., something like "That's outside my orders, sailor — let's keep it real words in here.")

## Step 3: Handle Category B (unkindness) ✅ done
**Task for Claude Code:**
- On `unkind` classification: same private Tom nudge + strike increment as Category A
- **Additionally**, immediately trigger a parent notification (reuse existing notification infrastructure) with enough detail for John/Dawn to see what was said and by whom
- Do NOT wait for strike count — this notification fires on every single instance

## Step 4: Strike threshold → auto-pause ✅ done
**Task for Claude Code:**
- When a boy's daily strike count hits 3, programmatically trigger the same pause logic already used by the manual toggle in `dashboard/index.html`
- Fire a parent notification explaining the auto-pause happened and why (reuse existing notification pattern)
- Confirm `unmuteBoy()` still works normally on an auto-paused boy, same as a manually paused one — no special-casing needed there

## Step 5: Midnight reset ✅ done (verification only, no code changes)
**Task for Claude Code:**
- Daily strike counter at `stewart/strikes/{agentId}/{date}` naturally resets by virtue of being date-keyed — confirm no code anywhere carries a running total across dates
- Confirm the auto-pause itself doesn't persist past the day it was set (should lift automatically at midnight, same as if manually set for "today only" — check how the existing pause stores its duration)

## Step 6: Weekly report card — full visibility ✅ done
**Task for Claude Code:**
- The weekly report card generation should pull the full `stewart/strikes/{agentId}/*` history across all 7 days, unfiltered by the daily reset logic
- Include real specifics: which days had strikes, what category, whether unkindness occurred (not just a count) — so John and Dawn can actually see patterns, not just a number

---

## Testing checklist
- [x] Send an emoji-spam message — confirm it's deleted, strike increments, Tom nudges privately
- [x] Send a "67" message — same as above
- [x] Send an unkind message between test accounts — confirm strike increments AND parent notification fires immediately
- [x] Trigger 3 strikes in one day — confirm auto-pause fires, notification explains why, `unmuteBoy()` still works
- [x] Confirm a clean, normal message is never flagged or deleted
- [x] Wait past midnight (or manually adjust date for testing) — confirm strike counter resets to 0
- [x] Generate a weekly report card after a week with mixed strike days — confirm it shows real per-day detail, not just a total

## Merge checklist
- [ ] Test on a branch (`feature/tom-moderation`) for a few real days before merging
- [ ] `firebase deploy --only functions`
- [ ] Merge to `main`, push to GitHub

---

*This completes Tom's full scope: app-help, wishes (interest/learning/devotional), KJV-grounded devotional guidance, and now chat moderation — all in one consistent voice, no new characters.*
