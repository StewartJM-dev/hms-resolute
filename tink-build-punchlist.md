# HMS Resolute — Build Punch List: Tink (Dawn's Assistant)
*Hand this directly to Claude Code, in the hms-resolute repo. Correct file: `dashboard/index.html` (Officers' Country) — NOT `bridge/index.html`.*

---

## Scope reminder
- **No persona** — plain Claude, not a character like Tom
- **No wish/token system** — unlimited, $2/month soft budget (tracked, not hard-blocked at app level; Console spend cap is the real backstop)
- Grounded in a written reference of Resolute's actual features, so it can't invent functionality that doesn't exist

## Capabilities to build
1. **App help** — parent/admin angle: running White Glove inspections, adjusting chore assignments, troubleshooting
2. **Recipe Builder (Dawn's version)** — unlimited, dinner-focused, pantry-aware — calls the *existing* `mealReadiness()` / `renderMealSuggestions()` logic in `kitchen/index.html` rather than reinventing it; AI only steps in to explain/modify/generate when the existing engine comes up empty
3. **Boy lookup** — Dawn asks direct questions ("what's Stephen's chore completion this week") and gets a real answer pulled from `stewart/scores/{agentId}/{date}` and `stewart/deductions/{agentId}/{date}`
4. **Tom conversation visibility** — Dawn can ask what the boys have discussed with Tom/Compass (once Tom exists — this piece can be stubbed now, wired later)
5. **Drafting help** — announcements, notes, general written communication

---

## Step 1: Cloud Function — `askTink` ✅ done
**File:** `functions/index.js` (append, following existing style)

**Task for Claude Code:**
- `exports.askTink = functions.https.onCall(...)`
- Accepts: `question` (string), `context` (optional — which boy/date range if a lookup question)
- System prompt: plain, helpful, no persona. Explicitly told: "You are a helpful assistant for Dawn, running the parent-facing side of HMS Resolute. Answer directly and practically. If you don't have real data to answer a lookup question, say so rather than guessing."
- Include a written reference block in the system prompt describing the app's actual features (White Glove, chores, points, Compass/Tom, Recipe Builder, prayer requests via War Room) so it never invents functionality
- Model: `claude-haiku-4-5-20251001` for simple app-help; consider `claude-sonnet-4-6` if `context` indicates a data-lookup or drafting task requiring more reasoning (Claude Code's call on complexity threshold)
- Returns `{ text: "..." }`

## Step 2: Data-lookup capability ✅ done
**Task for Claude Code:**
- Before calling the model for a lookup-type question, fetch real data server-side: `stewart/scores/{agentId}/{date}` and `stewart/deductions/{agentId}/{date}` for the relevant boy/date range
- Pass that real data into the prompt as context so the answer is grounded in fact, not generated from nothing
- If Dawn's question doesn't clearly specify which boy, ask for clarification rather than guessing

## Step 3: Recipe Builder hook-in ✅ done
**Task for Claude Code:**
- Reuse `mealReadiness()` and the existing meal database from `kitchen/index.html` — call this logic first
- Only invoke the AI function when: (a) nothing scores well as "ready" or "close," or (b) Dawn asks for a modification/substitution to an existing suggested meal
- Keep this unlimited/no-token, per what's already decided

## Step 4: UI — new tab or section in Officers' Country ✅ done
**File:** `dashboard/index.html`

**Task for Claude Code:**
- Reuse the existing `.dash-chat-thread` / `.dash-chat-messages` / `.dash-chat-compose` styling pattern (already built for Comms) for visual consistency — don't reinvent the chat UI
- New section/tab: "Tink"
- Simple text input, call `askTink`, display response in the existing chat-bubble style
- No wish counter, no confirmation step — just ask and answer

## Step 5: Cost tracking (soft, not hard-blocking) ✅ done
**Task for Claude Code:**
- Log each call's approximate cost to a `dawn_usage` path in Realtime Database, similar in spirit to what we'll eventually build for the boys, but Dawn's version doesn't need to block her at $2 — just track for visibility
- This is lower priority than Steps 1–4; can be a fast-follow

---

## Testing checklist
- [x] Ask a basic app-help question ("how do I run White Glove") — confirm accurate, grounded answer
- [x] Ask a boy-lookup question ("how did Stephen do this week") — server-side extraction now resolves boy + date range from the question itself (with conversation history for follow-ups like "Stephen" alone), confirmed pulling real data with no fabrication
- [x] Ask a recipe question when pantry has a ready match — confirm it either defers to the existing engine's answer or complements it sensibly
- [x] Ask a recipe question when nothing matches — confirm AI generates something reasonable using real pantry contents
- [x] Ask something outside scope — confirm it says so rather than guessing or hallucinating a feature
- [ ] Check Console usage/cost after a day of real use

## Merge checklist
- [~] Test on a branch for a few real days before merging — skipped in favor of thorough synthetic testing against the live deployed function (all 5 testing-checklist scenarios + both post-testing gap fixes verified with real RTDB data); merged same-day, deliberately, per explicit call
- [x] `firebase deploy --only functions` once confident
- [x] Merge to `main`, push to GitHub (GitHub Pages rebuilds automatically, same as Hans)

---

*Once this is stable, Tom (Compass tab, boys' side) is the next and biggest remaining piece.*
