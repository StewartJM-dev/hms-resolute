# HMS Resolute — Build Punch List (Step 1: Setup + Hans)
*Hand this directly to Claude Code on the laptop, in the hms-resolute repo.*

---

## Before any code: setup checklist (do manually, not via Claude Code)
- [ ] Anthropic Console account created, billing/card on file
- [ ] Console spend limit set to ~$8–10/month (hard backstop)
- [ ] API key generated in Console
- [x] Key added as a Firebase Functions secret (NOT in any client-side file):
  ```
  firebase functions:secrets:set ANTHROPIC_API_KEY
  ```
- [x] `@anthropic-ai/sdk` added to `functions/package.json` dependencies
- [x] New branch created off `main` before any changes:
  ```
  git checkout -b feature/hans-ai-upgrade
  ```

---

## Step 1a: Real streak tracking (needed before Hans can reference it honestly) ✅ done
**Why first:** `HANS_LINES.streak` already exists as a line pool in `boys/index.html` but is never actually triggered — no streak calculation exists in the codebase today. Build this before wiring AI to reference a number that doesn't exist yet.

**Task for Claude Code:**
- Add a function (client-side, near `runHansEngine()` in `boys/index.html`, or as a small helper) that walks backward day-by-day through `stewart/scores/{agentId}/{date}` in the Realtime Database, counting consecutive days where the score meets a "good day" threshold (match whatever threshold `hadBadDay` already uses as the inverse — currently `score >= 60` and no deductions)
- Return the streak count as an integer
- Stop counting at the first day that breaks the streak, or after a reasonable lookback cap (e.g. 30 days) to avoid unbounded reads

---

## Step 1b: Cloud Function — `generateHansLine` ✅ done
**File:** `functions/index.js` (append, following the existing style in that file)

**Task for Claude Code:**
- Add `exports.generateHansLine = functions.https.onCall(...)` following the pattern of the existing `notify*` functions in style/structure
- Accepts: `triggerType`, `agentName`, `completed`, `total`, `missionNames` (array), `deductionReason` (string or null), `streak` (integer or null)
- System prompt: Hans's persona locked in (self-deprecating Gimmelshtump/Doofenshmirtz-style villain-with-a-heart-of-gold, fresh backstory joke each time, never repeats, never touches siblings/comparisons/discipline, 2–3 sentences, silly but never actually mean)
- Model: `claude-haiku-4-5-20251001`, `max_tokens: 150`
- Returns `{ text: "..." }`
- API key read from the Functions secret, never hardcoded

---

## Step 1c: Wire the client to call it, with fallback ✅ done
**File:** `boys/index.html`, inside `runHansEngine()`

**Task for Claude Code:**
- Add an async `getHansLine(triggerType, name, completed, total, extra)` helper that:
  - Calls the `generateHansLine` callable function via `firebase.functions().httpsCallable('generateHansLine')`
  - Passes real data: remaining mission names (`missions.filter(m => !done[m.id]).map(m => m.text)`), deduction reason (`Object.keys(deductions)[0] || null`), streak (from step 1a)
  - On ANY failure (network, timeout, error response): falls back to the existing `hansFill(hansPick(HANS_LINES[triggerType]), name, completed, total)` — Hans must never go silent or error out visibly
- Replace each existing `hansPick(HANS_LINES.xxx)` call in `runHansEngine()` with a call to `getHansLine(...)`, keeping all existing trigger logic (morning/evening/allDone/deductions/behind/general/bounceback) exactly as-is — only the line-generation step changes, not when Hans fires

---

## Testing checklist before merging
- [x] Force each trigger condition manually (adjust localStorage `hans-{agentId}-{date}` state or mission completion) and confirm Hans posts a real, sensible AI-generated line for morning, evening, allDone, deductions, behind, and general — all 10 triggers passed
- [x] Temporarily break the API call (bad key, offline) and confirm it falls back to a static line instead of erroring — all 5 fallback modes passed
- [ ] Check actual API usage/cost in the Anthropic Console after a day of testing to confirm it's tracking near the ~$0.50/month estimate, not spiraling
- [ ] Confirm streak count is accurate against a few known real days of data for at least one boy

## Merge checklist
- [ ] Test on the branch for a few real days before merging to `main`
- [ ] Once confident, merge and deploy: `firebase deploy --only functions,hosting`

---

*Once Hans is live and stable, move to Step 2 (website-approval notification) and Step 3 (Tom/Compass) from the main features doc.*
