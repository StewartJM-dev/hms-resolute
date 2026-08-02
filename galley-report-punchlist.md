# HMS Resolute — Build Punch List: Galley Report (meal-plan adherence + weekly insight)
*Hand this directly to Claude Code, in the hms-resolute repo.*

---

## Scope
Two connected pieces:
1. **Planning visibility** — did Dawn (or John) actually plan the week's meals, when, and how much has changed since
2. **Adherence verification** — for each night's planned dinner, confirm whether it was actually what got cooked; if not, capture why (dropdown reason or a note)
3. Verification lives in **Kitchen/Galley**, but the prompt to complete it surfaces in **Dawn's Ship's Orders** the next day
4. All of this feeds the **weekly report card** as a real "Galley Report" section — not just a log, but something that surfaces patterns over time (how consistently the plan gets followed, common reasons for deviation) to help future meal planning

---

## Step 1: Data layer
**Task for Claude Code:**
- Extend `stewart/plan` (or add alongside it) to track metadata: when the week's plan was created/last modified, and a change history (what was originally planned per night vs. any edits made before the night arrives)
- New path: `stewart/mealverification/{date}` — `{plannedMeal, actualMeal, followed: true/false, reason, note, verifiedBy, timestamp}`
- Reason should be a fixed dropdown list (not free text as the primary field) — suggest options like: "Ran out of time," "Missing ingredient," "Family preference that night," "Leftovers instead," "Ate out," "Other" (with an optional note field for "Other" or added context)

## Step 2: Verification UI in Galley
**File:** `kitchen/index.html`
**Task for Claude Code:**
- After a dinner's date has passed, show a simple prompt: "Did you make [planned meal] last night?" — Yes (marks followed, done) / No (opens the reason dropdown + optional note)
- Should be low-friction — this needs to actually get used daily, not feel like a chore itself

## Step 3: Surface the prompt in Dawn's Ship's Orders
**File:** `dashboard/index.html`
**Task for Claude Code:**
- Add "Verify last night's dinner" to Dawn's existing Ship's Orders list (same pattern as other standing-order items already there) whenever an unverified `stewart/mealverification` entry exists for the previous day
- Tapping it should take her directly into the Galley verification UI from Step 2, not a separate disconnected flow

## Step 4: Galley Report in the weekly report card
**Task for Claude Code:**
- Add a "Galley Report" section to the weekly report card generation, alongside the existing per-boy sections
- Include: was the week planned, and when (on time vs. last-minute vs. not planned at all); how many nights were followed vs. changed; the actual reasons cited for deviations, aggregated (not just a count — real specifics, e.g. "3 of 7 nights changed, most often citing missing ingredients")
- This should be written with the same real-pattern-noticing standard as the boys' sections, not just a stats dump — the point is genuine insight for planning better weeks ahead, including gently surfacing patterns relevant to eating healthier if the data supports it (e.g., if "ate out" or a specific substitution pattern recurs)

---

## Testing checklist
- [ ] Create a week's plan, confirm the planned-date/changed-since metadata is captured accurately
- [ ] Change a planned meal mid-week, confirm the change history reflects it
- [ ] Mark a dinner as followed — confirm it doesn't prompt again
- [ ] Mark a dinner as NOT followed with a reason — confirm it's captured and doesn't re-prompt
- [ ] Confirm the verification prompt actually appears in Dawn's Ship's Orders the next day, and tapping it goes to the right place
- [ ] Generate a report card after a week with a mix of followed/changed nights — confirm the Galley Report section is accurate and genuinely useful, not just a raw count

## Merge checklist
- [ ] Test on a branch for a few real days before merging
- [ ] `firebase deploy --only functions`
- [ ] Merge to `main`, push to GitHub

---

*This is the first weekly report card addition aimed at long-range household planning rather than child accountability — worth watching over a few real weeks to see what it actually reveals before deciding if it needs refinement.*
