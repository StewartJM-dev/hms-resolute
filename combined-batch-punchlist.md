# HMS Resolute — Build Punch List: Full Combined Batch (post-Galley)
*Hand this directly to Claude Code, in the hms-resolute repo. Combines the daily-report change, exception days, and the 8-part batch discussed after the Galley Report shipped, plus Dawn's own personal daily report.*

---

## Part 1: Weekly report card → auto-updating daily

### Scope
Currently manual-generate-only via "Check In — Generate Now." Should auto-refresh daily so it's always current without a manual trigger.

### Step 1
**Task for Claude Code:**
- Add a scheduled function that regenerates the report card automatically once a day (overnight), so opening Bridge or Officers' Country any day shows current data through today
- Keep the existing button, reframed as "Regenerate" — for the specific case where John or Dawn fixed a data issue and wants immediate recalculation rather than waiting for the next automatic refresh

---

## Part 2: Exception Days (planned deviations from the norm)

### Scope
A way for John or Dawn to flag a date (or range) in advance as an exception day — a campout, travel, sickness, a doctor's visit, holiday, or anything else that means normal chore/mission expectations don't realistically apply. Ripples through missions, pay, White Glove, and — critically — how the report card *talks about* that day, so a planned deviation never reads as a discipline problem.

**Design principle:** build generically, not narrowly — this is likely the foundation for future homeschool integration (school days, field trips, sick days affecting schoolwork). Keep `type` open/extensible and the data shape generic.

### Step 2a: Quick single-boy Sick Day toggle
- Fast one-tap "Mark [boy] sick today" separate from the full planner, on each boy's card wherever visible at a glance (Bridge or Officers' Country overview)
- Same underlying data, just a same-day low-friction path

### Step 2b: Data layer
- New path: `stewart/exceptions/{date}` — `{type, note, affectedAgents: ['all'] or specific list, setBy, timestamp}`
- `type` options: "Travel/Campout," "Sick Day," "Doctor's Visit," "Holiday," "Other" (open list, not fixed enum)
- Support setting a date range at once for multi-day trips

### Step 2c: Setting an exception
- UI in `bridge/index.html` (Helm) — pick date/range, type, optional note, affected agents (default "all"); settable in advance or same-day

### Step 2d: Mission engine, pay, White Glove adjustments
- `mission-engine.js`: skip or reduce mission generation for affected agents on exception dates, explicitly (not just showing as an unexplained 0/0)
- Pay calc: exception days don't count toward the week's max-possible calculation as a $0 day — they're excluded from the calculation entirely
- White Glove: skip/mark N/A for exception days rather than counting as missed/failed

### Step 2e: Report card awareness
- Report generation must reference exception days explicitly and accurately (e.g. "Friday was a planned campout, no chores were expected") instead of reading it as a behavior dip — this is the most important piece
- *Apply this retroactively to the week already reported, once built — Stephen and Daniel's Friday collapse was the campout, not a discipline issue.*

---

## Part 3: Teach Me Vote → website suggestions + family day + report card

### Scope
Real existing feature (`stewart/teachvote/{weekKey}`). Extend it:
- When a topic wins the week, generate 1-2 real website suggestions (reuse Tom's existing interest-suggestion + parent-approval pattern)
- Surface a lightweight family day activity suggestion tied to the topic (a suggestion John/Dawn see, not auto-booked)
- Fold Teach Me activity (suggested/won topic, participation) into the report card

---

## Part 4: Devotional reflection → report card

### Scope
Real existing feature (`stewart/selfassessment/{agentId}/{date}`, "Today's Reflection"), distinct from the 40-day Courage Dare and currently NOT in the report card.

### Step
- Add daily reflection completion (and relevant content) to the report card's aggregation and per-boy write-up, alongside existing Courage Dare tracking

---

## Part 5: White Glove failure → real pay accountability

### Scope
**Core problem:** a boy checks off "make bed"/"tidy room," gets paid, then Dawn's separate White Glove inspection fails that same room — nothing currently connects the two, so he's paid for work not actually done to standard.

### Step
- When a room fails White Glove, automatically reduce/zero the pay value of that boy's corresponding room-standard mission(s) for that day, even if already checked off
- Recalculate that day's pay total and eligible-mission denominator accordingly
- Make this visible to the boy (his own record or a brief nudge), not silent

---

## Part 6: Fold behavior tracker into White Glove flow

### Scope
Dawn likes the Attitude/Disobedience/Fighting/Dishonesty buttons but forgets to use them since they're a separate action from her routine.

### Step
- Surface these buttons directly within the White Glove inspection UI for each boy being inspected, right in the flow she's already reliably doing — additive, don't remove the standalone access

---

## Part 7: Red Sky at Morning / Red Sky at Night (personal daily reports, sibling-free)

### Scope
Named from Matthew 16:2-3 (sailors reading the sky — Jesus's own reference). Two distinct daily reports per boy:
- **Red Sky at Morning** — reviews yesterday's rough patches. Forward-looking, gentle: "new day, let's not repeat yesterday's mistakes," not a scolding.
- **Red Sky at Night** — today's good report. **Unlocks only after all of today's chores are completed** — an earned moment.

**Both, always:** zero sibling data (no names, no narrating the other side of a shared incident), pull from the full system as it applies to that boy individually (scores, own White Glove room, strikes/deductions as his own consequence only, wishes, devotional), delivered in Tom's voice, live in Compass.

### Step
- Build both generations scoped to a single agentId, gate Red Sky at Night on chore-completion status
- Tom can reference Matthew 16:2-3 when a boy first encounters either report
- Reuse the parent-facing report card's underlying generation logic where sensible — same engine, different scope/voice/framing

---

## Part 8: Tom's grace & reconciliation guidance

### Scope
Grounded in Matthew 7:12, Luke 6:31 (Golden Rule), Matthew 22:36-40 (Great Commandment).

### Step 8a: Reconciliation nudge
- After Tom logs an unkindness strike (private nudge, as now), follow with a separate, gentle invitation to make it right with the other person — an offer, not a requirement, not tracked as compliance
- Fully separate from strike-logging mechanics — grace doesn't erase the strike or the parent notification

### Step 8b: General grace framing
- Grace/forgiveness as a real theme in Tom's character, referenced with real Scripture when relevant — same citation standard as his devotional grounding (real verse, never invented)

---

## Part 9: White Glove pattern coaching from Tom

### Scope
Extend the report card's room-failure data to also show day-of-week clustering (scheduling problem looks different from a character problem). Tom can proactively coach: "I know you've been failing White Glove on your bedroom — what can you do to pass?"

### Step
- Add day-of-week breakdown to household White Glove data feeding the report card
- Give Tom access to a boy's own recent White Glove pattern so he can coach accurately — his own data only, same boundary as everything else

---

## Part 10: Family Day — plan, verify, reflect

### Scope
Mirrors the Galley Report pattern for the Part 3 family day suggestion — did it happen, how did it go.

### Step
- Simple follow-up prompt for John/Dawn after a suggested family day
- Fold into the report card alongside Teach Me data, so the full loop (topic → suggestion → family day → reflection) is visible over time

---

## Part 11: Dawn's own personal daily report

### Scope
In addition to the shared household report, Dawn gets her own daily report — her actions, her tasks, encouragement to complete them. Delivered through **Tink**, in Tink's existing plain, warm, practical voice (no persona/catchphrases, consistent with how Tink is already built).

**What it should include:**
- **Her own pending daily tasks** — Grace Dare devotional status, White Glove inspections due today, any pending Galley meal verification, Teach Me vote administration if applicable — framed as encouragement to complete them, not a guilt list
- **Her own completion patterns** — Grace Dare consistency, White Glove inspection follow-through — a light mirror of her own habits, similar in spirit to the boys' Red Sky reports but practical/task-oriented rather than emotional peaks-and-valleys, matching her role
- **Sibling confrontations, surfaced as actionable prompts** — when a strike, White Glove failure pattern, or other data point suggests conflict between boys, prompt her toward it directly (e.g. "Samuel and John Jr. had a conflict Thursday — worth a follow-up conversation") rather than making her dig through separate logs to notice
- **Her own interactions with each boy** — light reflection prompts on her own engagement pattern with each of them (has she checked in with a specific boy recently, any pattern in how she's responding to a particular boy) — this is about her relational awareness, not grading her
- **A short "needs your attention" surface** — genuinely time-sensitive items only (an unacknowledged strike notification, an overdue meal verification), not a full dump of every boy's data — the household report and the boys' own Red Sky reports already cover full detail
- **Explicitly NOT included:** detailed boy-by-boy behavioral analysis of everything that happened (that's the shared weekly report's job) — this stays focused on *her* day, *her* follow-through, and *actionable relational prompts*, not a second copy of the full household report

### Step
- Build a daily generation scoped to Dawn, reusing the same underlying report engine as everything else in this batch
- Tie encouragement language to her own real completion data (streaks, consistency) rather than generic cheerleading
- Surface it somewhere natural in Officers' Country, via Tink

---

## Testing checklist
- [ ] Report card auto-updates daily without manual trigger; manual "Regenerate" still works for the fix-and-recalculate case
- [ ] Set an exception day (planned and same-day); confirm missions, pay, White Glove, and report card language all respect it correctly
- [ ] Confirm single-boy Sick Day toggle works independently of the full planner
- [ ] Confirm Teach Me vote closing generates real website suggestions and a family day idea, both requiring approval where relevant
- [ ] Confirm devotional reflection and Teach Me data both appear in a generated report card
- [ ] Fail a White Glove inspection; confirm that day's room-standard mission pay is actually reduced, not just flagged, and the boy has some visibility into why
- [ ] Confirm behavior-deduction buttons appear naturally within the White Glove flow
- [ ] Confirm Red Sky at Morning/Night both work correctly, are sibling-free, and Night is properly gated on chore completion
- [ ] Confirm Tom's reconciliation nudge fires after a strike, separately from and without softening the strike itself
- [ ] Confirm Tom can reference a boy's own White Glove pattern without ever surfacing another boy's data
- [ ] Confirm the family day follow-up prompt and its reflection fold into the report card
- [ ] Confirm Dawn's personal report reflects her own real data and stays focused on her tasks, not a full boys'-data dump
- [ ] Confirm Dawn's report surfaces a real sibling confrontation as an actionable prompt when one occurred, and includes a light reflection on her own interaction pattern with each boy

## Merge checklist
- [ ] Test each part on a branch for a few real days before merging — this is a large batch; consider whether it needs breaking into multiple branches/PRs rather than one giant merge, Claude Code's call based on how interdependent the pieces turn out to be
- [ ] `firebase deploy --only functions` for report-card and Tom/Tink prompt changes
- [ ] Merge to `main`, push to GitHub

---

*Part 2e should be applied retroactively to the week already reported once built. Security/database-rules audit, colorblind accessibility on Bible highlights, notification volume, and a "what's new" surface are intentionally NOT in this batch — parked for a separate build.*
