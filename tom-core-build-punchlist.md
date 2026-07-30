# HMS Resolute — Build Punch List: Tom Core (Compass Tab)
*Hand this directly to Claude Code, in the hms-resolute repo. File: `boys/index.html`. Chat moderation is a SEPARATE punch list (tom-moderation-punchlist.md) — build Core first, moderation after.*

---

## Scope reminder
- Tom lives under a new **Compass** tab, added to the existing bottom nav (`.bnb` buttons + `showTab()` pattern already used for rations/lunch/missions/transmissions/training/pay/xbox)
- One consistent voice across all four boys, phrasing complexity scaled to age
- **Voice:** diagnose-before-advise, lean/economical (Master Chief influence), dry deadpan humor, quiet assumed confidence, always defers to Scripture/Dad on devotional matters — full reference below
- **T.O.M. = Today's On-Call Mate** (and tomorrow's) — reveal this only if a boy asks directly, with a little humor, not upfront

## Voice reference (paste into system prompt)
> Diagnose what's actually going on before advising. Real stories/analogies over generic encouragement, but trimmed lean — don't over-explain. Dry, deadpan humor, not goofy. Quiet, assumed confidence in a boy before he's proven anything. Economical with words. Duty-bound phrasing where it fits ("that's the mission," not "please do this"). On devotional matters, steadiness never overrides humility — always point to Scripture and Dad as the real authority, never position yourself as final word.

**Catchphrases (from prior planning — reuse exactly):**
- Greeting: "How can I help you, sailor?"
- Chore/task encouragement: "Steady hands finish strong." / "Man your station."
- Wish confirmation: "Spend it wisely, sailor."
- Off-topic redirect: "That's outside my orders. Try me on something else."
- Devotional/Scripture: "The Word's the true north." / "Let Scripture chart it, not me."
- End of a good week: "Well sailed, this week."
- Sign-on/send-off: "Trust the compass, trust the Word" / "Onward, in His strength"
- "What are you?": "T.O.M.? Today's On-Call Mate — and tomorrow's too, if you want to know the truth. I don't take a day off, sailor."

---

## Step 1: KJV text source ✅ done
**Task for Claude Code:**
- The full KJV is public domain. Source a complete, verse-indexed KJV text file (JSON or similar, book/chapter/verse keyed) and add it as a static asset — don't rely on fetching from an external API at runtime (reliability, and keeps this fully self-contained like the rest of the app)
- If no existing project convention for a data asset this size exists, propose a location (e.g. `assets/kjv.json`) and confirm before adding

## Step 2: Wish tracking data structure ✅ done
**Task for Claude Code:**
- New Realtime Database path: `stewart/wishes/{agentId}/{date}` — tracks wishes earned (from chore completion %, per existing 1/3→1, 2/3→2, full→3 formula) and wishes used today
- Wishes earned today unlock for **tomorrow** (per original design — earned today, usable next day), fresh reset daily, stackable if unused, capped by the $1/boy monthly budget
- New path: `stewart/budget/{agentId}/{month}` — running dollar total, resets monthly, no rollover

## Step 3: Cloud Function — `askTom` ✅ done
**File:** `functions/index.js`

**Task for Claude Code:**
- `exports.askTom = functions.https.onCall(...)`
- Accepts: `agentId`, `question`, conversation history (last several messages, same pattern used to fix Tink's follow-up memory gap)
- Classifies into exactly one of: `app_help` (free, unlimited), `wish_spend` (interest/discovery, learning, devotional — costs 1 wish, requires confirmation), `declined` (siblings, discipline, rule-bypass, unrelated — no wish spent, firm-but-warm redirect)
- **Devotional questions:** must cite real KJV text pulled from the Step 1 asset (book/chapter/verse), then explicitly frame as "here's what I found — ask your father, I could be wrong"
- **Interest/website questions:** may suggest one real website; flag for parent approval using the same notification pattern already used for `notifyScreenTimeRequest`/`notifyShipAccountRequest`
- Model: `claude-haiku-4-5-20251001`
- Check budget (`stewart/budget/{agentId}/{month}`) before any wish-costing call; if at $1 cap, decline gracefully in-voice rather than erroring
- Returns structured `{ type, category, message }`, same JSON pattern proven out in the Tom prototype

## Step 4: Compass tab UI ✅ done
**File:** `boys/index.html`

**Task for Claude Code:**
- Add a new `.bnb` nav button: `showTab('compass', this)`, following the exact pattern of the other six tabs
- Chat interface: reuse existing message-bubble styling conventions from this file where possible, rather than inventing new UI
- Wish counter display (earned/remaining today), matching the visual language already established elsewhere in the app (badges/points displays)
- Confirmation UI for wish-spend questions: "Spend it wisely, sailor — use a wish?" with confirm/cancel, matching the pattern from the working prototype
- Fallback: on any API failure, show a static in-voice line and retry — Tom never goes silent, same standard as Hans and Tink

## Step 5: Age-scaled phrasing ✅ done
**Task for Claude Code:**
- Pass each boy's actual age (from existing agent data) into the system prompt so Tom's sentence complexity scales appropriately, while keeping the core voice identical across all four

---

## Testing checklist
- [ ] App-help question — free, no wish confirmation, accurate answer
- [ ] Interest/discovery question — triggers wish confirmation, generates a website suggestion, queues parent approval notification
- [ ] Learning question — triggers wish confirmation, reasonable answer
- [ ] Devotional question — triggers wish confirmation, cites a real KJV verse, includes "ask your father" framing
- [ ] Off-topic/sibling/rule-bypass question — declined, no wish spent, in-voice redirect
- [ ] Follow-up question referencing prior message — confirms conversation memory works (same fix pattern as Tink)
- [ ] Zero wishes remaining — graceful in-voice decline, no error
- [ ] Ask Tom "what are you" — confirms the T.O.M. reveal line
- [ ] Force an API failure — confirms fallback line, never silent
- [ ] Check budget tracking after a day of testing — confirm real cost tracks near estimate

## Merge checklist
- [ ] Test on branch (`feature/tom-core`) for a few real days before merging
- [ ] `firebase deploy --only functions`
- [ ] Merge to `main`, push to GitHub
- [ ] Only after Core is confirmed stable: hand off `tom-moderation-punchlist.md` as the next build

---

*Once Core + Moderation are both live, Tom's full scope is complete: app-help, wishes, devotional grounding, chat moderation — one consistent voice.*
