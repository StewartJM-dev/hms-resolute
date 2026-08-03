// ════════════════════════════════════════════════════
// HMS RESOLUTE — shared mission & scoring engine
//
// This is THE single source of truth for "what missions does a boy have
// today, and how much has he earned." Both the boys' Agent HQ page and
// Officers' Country (Dashboard) load this same file, so they can never
// compute different numbers for the same boy on the same day again.
//
// DO NOT copy/paste these functions into an individual page. If the
// mission list or point values need to change, change them here only —
// that was exactly the mistake that caused the pay/score mismatches
// (a second, slowly-drifting copy of this logic used to live in
// dashboard/index.html, and a third abandoned copy lived inside
// boys/index.html itself as buildMissionsForDate()).
// ════════════════════════════════════════════════════

function localDateStr(date){
  const d = date ? new Date(date) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// IMPORTANT: new Date("YYYY-MM-DD") parses as UTC midnight, which silently
// shifts to the PREVIOUS calendar day in any US timezone (behind UTC) —
// causing missions, pay, and schedules to land on the wrong day. Always use
// this instead of new Date(dateStr) when dateStr is a "YYYY-MM-DD" string.
function parseLocalDate(dateStr){
  if(dateStr instanceof Date) return dateStr;
  const parts = String(dateStr).split('-').map(Number);
  return new Date(parts[0], parts[1]-1, parts[2]);
}

// Strips the time-of-day off a Date, keeping only the local calendar date.
// The day-count rotations below (dish team, bathroom, Officer of the Watch,
// dinner side) all divide a raw millisecond difference by 24h — without this
// normalization, the SAME calendar day produces a DIFFERENT rotation result
// depending on whether the caller's Date object happened to be built at
// midnight vs. noon (or any other time), because the extra hours shift which
// integer day the floor() division lands on. This caused buildMissions() to
// disagree with itself across call sites (e.g. parseLocalDate's midnight vs.
// the week-grid's noon), silently drifting mission lists, scores, pay, and
// eligible-counts apart for the exact same boy/day.
function toMidnight(d){
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// DECIDED (2026-07-31): historical stewart/scores is NOT being retroactively
// corrected for whatever this bug affected before the fix above landed.
// This closes the "audit in progress" note left in the fix's own commit
// message (47a6b79) — that audit was opened, then explicitly decided
// against rather than actually run. Reasons: the rotation bug could only
// ever shift WHICH chores a boy was assigned that day, never how many he
// completed of what he was actually shown — and stewart/scores also
// directly drives Ship Account's real, already-partially-spent balance
// (see the pay-calculation note in functions/index.js/boys/index.html from
// e77e489), so silently rewriting it would rewrite real family financial
// history for a discrepancy nobody could distinguish from normal day-to-day
// variance. If this ever needs revisiting, it's a deliberate reopening of a
// closed decision, not a forgotten TODO.

// ══════════════════════════════════════════════════════
// EXCEPTION DAYS (combined-batch-punchlist.md Part 2)
// stewart/exceptions/{date}/{pushId} = {type, note, affectedAgents, setBy,
// timestamp, rangeId}. Keyed by pushId per date (not a single object per
// date) deliberately — a family holiday affecting everyone and one boy
// separately flagged sick the same day are two independent exceptions, not
// a conflict to resolve. affectedAgents is either ['all'] or a specific
// list of agentIds. type is open text (not a fixed enum) on purpose — this
// is meant to be the foundation for later homeschool-day tracking too, per
// the punch list's own design principle: build generically, not narrowly.
//
// RETROACTIVE CORRECTION APPLIED (2026-08-02): the week already reported
// before this feature existed (weekOf 2026-07-27) was corrected per the
// punch list's own explicit instruction ("Apply this retroactively to the
// week already reported... Stephen and Daniel's Friday collapse was the
// campout, not a discipline issue"), confirmed with John before writing to
// production history. A Travel/Campout exception was added at
// stewart/exceptions/2026-07-31 covering Stephen and Daniel specifically
// (not Samuel or John Jr., who scored normally that real day — the family
// campout evidently didn't pull them away from chores the same way). Their
// stewart/scores, stewart/pay, and stewart/eligible for 2026-07-31 were
// then nulled by hand to match exactly what recalculateScore's exception
// branch above would have written had this feature existed that week —
// same treatment as a weekend, excluded from the calculation entirely,
// not counted as a $0/zero-score day. weekOf 2026-07-27's report card was
// regenerated afterward and confirmed to read "Friday was a planned family
// campout, no chores were expected" for both boys instead of describing an
// unexplained collapse. This is a one-time, already-completed correction —
// it does not need to run again and there is no ongoing mechanism tied to
// it; noted here only so the July 31 numbers are never mistaken for a bug
// if someone goes looking for why they look different from a raw log.
// ══════════════════════════════════════════════════════

// Pure — given the exceptions object already fetched at
// stewart/exceptions/{date} (a map of pushId -> exception, or null/{} if
// none), returns the first exception covering this agent, or null. Shared
// by every surface that needs to answer "is today an exception day for
// this boy" — recalculateScore below, White Glove, the report card, and
// each page's own missions-view rendering.
function findExceptionForAgent(exceptionsForDate, agentId){
  if(!exceptionsForDate) return null;
  const entries = Object.values(exceptionsForDate);
  return entries.find(e => e && Array.isArray(e.affectedAgents) &&
    (e.affectedAgents.includes('all') || e.affectedAgents.includes(agentId))) || null;
}

function isLaundryDayFor(agentId, dayOfWeek){
  if((agentId==='samuel'||agentId==='johnjr') && dayOfWeek===1) return true;
  if((agentId==='stephen'||agentId==='daniel') && dayOfWeek===4) return true;
  return false;
}
function isLaundryDay(agentId, _d){
  return isLaundryDayFor(agentId, (_d?new Date(_d):new Date()).getDay());
}

// Continuous daily alternation from a fixed epoch — guarantees the dish
// team NEVER repeats two days in a row. (The old version used a per-weekday
// lookup table that duplicated Sunday and Monday onto the same team every
// single week — e.g. Stephen & Daniel doing dishes Sun AND Mon back to back.
// Do not go back to a day-of-week table; that's what caused the bug.)
function getDishTeam(_d){
  const now = toMidnight(_d ? new Date(_d) : new Date());
  const epoch = new Date(2024, 0, 1); // fixed reference point, arbitrary but stable
  const daysSinceEpoch = Math.round((now - epoch) / (24*60*60*1000));
  // Flipped 2026-07-28 per Dawn/John's request — Samuel & John Jr. on dishes today.
  return (daysSinceEpoch % 2 === 0) ? 'sd' : 'sj';
}
function isWeekend(_d){
  const d = (_d?new Date(_d):new Date()).getDay();
  return d === 0 || d === 6;
}
function getDayName(_d){
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return days[(_d?new Date(_d):new Date()).getDay()];
}
function isWednesday(_d){
  return (_d?new Date(_d):new Date()).getDay() === 3;
}
function getBathroomAgent(_d){
  const order = ['samuel','johnjr','stephen','daniel'];
  const now = toMidnight(_d ? new Date(_d) : new Date());
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.round((now - startOfYear) / (7*24*60*60*1000));
  return order[weekNum % 4];
}
function getOfficerOfWatch(_d){
  const order = ['samuel','johnjr','stephen','daniel'];
  const now = toMidnight(_d ? new Date(_d) : new Date());
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const dayNum = Math.round((now - startOfYear) / (24*60*60*1000));
  return order[dayNum % 4];
}

const PAIRS = {
  'samuel':  { partner: 'johnjr',  pairId: 'virtus',   label: 'Team Virtus',   names: 'Samuel & John Jr.' },
  'johnjr':  { partner: 'samuel',  pairId: 'virtus',   label: 'Team Virtus',   names: 'Samuel & John Jr.' },
  'stephen': { partner: 'daniel',  pairId: 'vulnere',  label: 'Team Vulnere',  names: 'Stephen & Daniel' },
  'daniel':  { partner: 'stephen', pairId: 'vulnere',  label: 'Team Vulnere',  names: 'Stephen & Daniel' },
};

const DINNER_SIDE_DAYS = [1, 3, 4];
function isDinnerSideDay(_d){
  return DINNER_SIDE_DAYS.includes((_d?new Date(_d):new Date()).getDay());
}
function getDinnerSideAssignment(dateOverride){
  const rawDate = dateOverride ? new Date(dateOverride) : new Date();
  const dow = rawDate.getDay();
  if(!DINNER_SIDE_DAYS.includes(dow)) return null;
  const date = toMidnight(rawDate);
  const epoch = new Date(2024, 0, 1);
  const daysSinceEpoch = Math.round((date - epoch) / (24*60*60*1000));
  const fullWeeks = Math.floor(daysSinceEpoch / 7);
  const remainderDays = daysSinceEpoch % 7;
  let cookingDayIndex = fullWeeks * 3;
  for(let i=0;i<remainderDays;i++){
    if(DINNER_SIDE_DAYS.includes(i)) cookingDayIndex++;
  }
  const virtusGetsStarch = (cookingDayIndex % 2 === 0);
  return {
    virtus: virtusGetsStarch ? 'starch' : 'veggie',
    vulnere: virtusGetsStarch ? 'veggie' : 'starch'
  };
}
function getMyDinnerSide(agentId, _d){
  const pair = PAIRS[agentId];
  if(!pair) return null;
  const assignment = getDinnerSideAssignment(_d);
  if(!assignment) return null;
  return assignment[pair.pairId];
}

// ══════════════════════════════════════════════════════
// POINTS SYSTEM — 100 points = 6 minutes of game time per day (weekdays only)
// ══════════════════════════════════════════════════════
// Computer Missions (typing, Scratch, Khan Academy, research) are bonus —
// they're checkable and trackable but do NOT count toward the score or game
// time. That's a deliberate family rule, not an oversight — don't "fix"
// this by including them again.
//
// IMPORTANT: points100/pct here is the permanent, unchanged basis for game
// time, wishes, medals, AND every historical Ship Account balance (which
// sums score/100 across real, already-partially-spent dollars going back
// to SHIP_ACCOUNT_START_DATE in boys/index.html). Never change what this
// represents or how it's computed — a change here retroactively alters
// real money already on the books.
//
// `dollars` below is a SEPARATE, independently-computed figure — actual
// cash pay follows its own rule (see below), not a derivative of the score.
// White Glove -> pay accountability (combined-batch-punchlist.md Part 5).
// Maps a mission to the White Glove room it represents, if any — used
// below to zero a mission's PAY (not its score/game-time) when that room
// fails inspection. Category-based for the fixed always-present chores
// (every boy's own bedroom, whoever's on kitchen/bathroom duty), plus
// explicit ids for the room-specific floor missions where the 'floors'
// category alone spans more rooms than just one.
function wgRoomForMission(mission){
  if(mission.category === 'bedroom') return 'berths';
  if(mission.category === 'kitchen') return 'galley';
  if(mission.category === 'bathroom') return 'head';
  if(mission.id === 'floor-living') return 'commondeck';
  if(mission.id === 'floor-kitchen') return 'galley';
  return null;
}
const WG_CATEGORY_KEYS = ['trash','dishes','clothing','floor','counters'];
// Pure — given one day's raw stewart/whiteglove/{date} value (all three
// inspection windows) and an agentId, returns the Set of WG room ids that
// FAILED for this agent, using each room's LATEST inspected window that
// day (not "any failure ever that day") — a boy who fixes a room and
// passes a later re-inspection isn't still penalized for the earlier one.
// A room assigned to 'all' (All Hands) counts against every agent equally
// — nobody individually owns it, but nobody's exempt from it either.
function wgFailedRoomsForAgent(whiteGloveDay, agentId){
  const failed = new Set();
  if(!whiteGloveDay) return failed;
  const windows = ['morning','afternoon','evening'].filter(w => whiteGloveDay[w]);
  const roomIds = new Set();
  windows.forEach(w => { const rooms = whiteGloveDay[w].rooms || {}; Object.keys(rooms).forEach(r => roomIds.add(r)); });
  roomIds.forEach(roomId => {
    // Latest window (by array order above) that actually rated this room.
    let latest = null;
    windows.forEach(w => { const r = whiteGloveDay[w].rooms && whiteGloveDay[w].rooms[roomId]; if(r) latest = r; });
    if(!latest || latest.na) return;
    if(latest.officer !== agentId && latest.officer !== 'all') return;
    const passed = WG_CATEGORY_KEYS.every(k => latest[k] === true);
    if(!passed) failed.add(roomId);
  });
  return failed;
}

// opts.failedWgMissionIds (optional Set/array of mission ids) zeroes
// those specific missions out of PAY only — eligibleCompleted/dollars —
// never earned/possible/pct/points100. Matches this file's own
// established points100-vs-dollars decoupling: game time and wishes stay
// based on raw completion, exactly as already decided when `dollars` was
// first split out as its own independently-computed figure. A room that
// failed White Glove doesn't erase that the chore was actually attempted;
// it just means it wasn't done to standard, which is a pay question, not
// a "did he try" question.
function calculateDayScore(agentId, missions, doneMap, opts){
  const failedWgMissionIds = (opts && opts.failedWgMissionIds) ? new Set(opts.failedWgMissionIds) : null;
  const payMissions = missions.filter(m => m.category !== 'computer');
  const possible = payMissions.reduce((sum,m) => sum + (m.points||0), 0);
  const earned = payMissions.reduce((sum,m) => sum + (doneMap[m.id] ? (m.points||0) : 0), 0);
  const pct = possible > 0 ? (earned / possible) : 0;

  // CASH PAY — $1.00 total per weekday, split EVENLY (not point-weighted)
  // across that day's payable missions, which excludes both Computer
  // Missions and Officer of the Watch checks (points:0, oversight-only,
  // never paid — they still count toward completion for other purposes,
  // just not toward this split). Each completed payable mission is worth
  // exactly $1.00 / (payable missions that day). Deliberately independent
  // of transfer credits/behavior deductions, which only ever adjust the
  // points100 score above, not this figure — matches the exact rule as
  // given, with no adjustment factored in unless asked for separately.
  // "Eligible" is the same payable-mission definition used for pay, and now
  // the single shared definition for any raw completed/total count shown
  // anywhere in the app (report card, both weekly chore-log grids) — one
  // definition, not a third one invented per surface.
  const eligibleMissions = missions.filter(m => m.category !== 'computer' && m.category !== 'officer-of-the-watch');
  // A WG-failed mission stays IN the denominator (it was still a real,
  // assigned, payable mission that day) but drops OUT of the completed
  // count even if checked off — that's what actually reduces the day's
  // pay. Removing it from both would leave his percentage (and so his
  // pay) completely unchanged whenever he'd finished everything, which
  // would make this whole feature a no-op for the exact case it exists
  // to catch: paid for work not actually done to standard.
  const eligibleCompleted = eligibleMissions.filter(m => doneMap[m.id] && !(failedWgMissionIds && failedWgMissionIds.has(m.id))).length;
  const eligibleTotal = eligibleMissions.length;
  const dollars = eligibleTotal > 0 ? (eligibleCompleted / eligibleTotal) : 0;

  return {
    earned, possible, pct,
    eligibleCompleted, eligibleTotal,
    points100: Math.round(pct * 100),
    dollars,
    minutes: pct * 6
  };
}
function applyTransferAdjustment(score100, transferAdjust){
  let adjusted = score100 + (transferAdjust||0);
  adjusted = Math.max(0, Math.min(100, adjusted));
  return { points100: adjusted, dollars: adjusted/100, minutes: (adjusted/100)*6 };
}
function applyBehaviorDeductions(score100, deductionPoints){
  let adjusted = score100 - (deductionPoints||0);
  adjusted = Math.max(0, Math.min(100, adjusted));
  return { points100: adjusted, dollars: adjusted/100, minutes: (adjusted/100)*6 };
}
const DISH_MISSION_IDS = ['dishwasher-load-1','dishwasher-unload-1','dishwasher-load-2','dishwasher-unload-2','dishwasher-load-3','dishwasher-unload-3','table-clear','table-wipe'];
function detectDishTransfer(myDoneToday, partnerDoneToday, myExpectedToday){
  const onDishesToday = myExpectedToday.some(m => DISH_MISSION_IDS.includes(m.id));
  if(!onDishesToday) return false;
  const dishMissionsToday = myExpectedToday.filter(m => DISH_MISSION_IDS.includes(m.id));
  return dishMissionsToday.every(m => myDoneToday[m.id]);
}

// ══════════════════════════════════════════════════════
// WISHES — Tom's wish economy (stewart/wishes/{agentId}/{date}).
// A wish is earned from a day's raw chore-completion % (calculateDayScore's
// `pct`, before transfer adjustments or behavior deductions) — same tiers
// as the family's original design: 1/3 complete = 1 wish, 2/3 = 2, full = 3.
// Like scoring, wishes only accrue on weekdays; weekend chores are tracked
// separately as Damage Control and don't earn wishes either.
//
// Earning is written here (see recalculateScore below); SPENDING a wish is
// deliberately NOT done here — that's a trust boundary enforced server-side
// by askTom (functions/index.js), same reasoning as why the boys' client
// code never writes its own score.
//
// Balance model (John's decision, one-time correction + ongoing cap): the
// spendable balance is a real STORED, capped running total at
// stewart/wishesBalance/{agentId} — same concept as the Screen Time Bank's
// stewart/screenTimeBalance, not a derived sum-of-all-history like this used
// to be. That distinction actually matters here, not just stylistically: once
// a cap is involved, the balance can't be correctly reconstructed from raw
// history alone whenever spending and earning interleave (spending opens up
// headroom below the cap for future earning to fill; a pure "sum everything
// then clamp once" loses that headroom and undercounts). So earning is
// folded into the stored balance exactly once per day, in order, via
// foldWishesBalance() below, and spending decrements that same stored value
// directly (functions/index.js's spendTomWish). getAvailableWishes() is
// still read-only from a caller's perspective for UI display — it just also
// lazily catches the stored balance up first if any past days haven't been
// folded in yet, which is always safe/idempotent to do redundantly.
// ══════════════════════════════════════════════════════
function wishesForPct(pct){
  if(pct >= 1) return 3;
  if(pct >= 2/3) return 2;
  if(pct >= 1/3) return 1;
  return 0;
}

const WISHES_MAX_BALANCE = 3;

// Pure — given the currently-stored balance, the last date already folded
// into it (or null if never folded), today's date, and {date: earnedAmount}
// for the full stewart/wishes/{agentId} history, returns the up-to-date
// balance and the new foldedThrough cursor. Today's own earned is always
// excluded (wishes earned today unlock tomorrow, unchanged from the
// original design); already-folded dates are skipped so repeat calls don't
// double-count. Summing the whole unfolded gap and capping once (rather
// than capping day-by-day) is safe specifically because nothing ever spends
// mid-gap — any spend attempt during an uncaught-up gap folds first, so by
// the time a decrement actually applies, the fold is already caught up to
// the present moment.
function foldWishesBalance(storedBalance, foldedThrough, today, earnedByDate){
  let sum = 0;
  let newThrough = foldedThrough || null;
  Object.keys(earnedByDate).sort().forEach(dateStr => {
    if(dateStr >= today) return;
    if(foldedThrough && dateStr <= foldedThrough) return;
    sum += (earnedByDate[dateStr] || 0);
    newThrough = dateStr;
  });
  return {
    balance: Math.min(WISHES_MAX_BALANCE, (storedBalance || 0) + sum),
    foldedThrough: newThrough
  };
}

// Current spendable wish balance — folds any newly-unlocked past days into
// the stored balance first (writing back only if anything actually changed),
// then returns it.
function getAvailableWishes(agentId){
  if(!_db) return Promise.resolve(0);
  const today = localDateStr();
  return Promise.all([
    _db.ref(`stewart/wishesBalance/${agentId}`).once('value'),
    _db.ref(`stewart/wishesBalanceThrough/${agentId}`).once('value'),
    _db.ref(`stewart/wishes/${agentId}`).once('value')
  ]).then(([balSnap, throughSnap, wishesSnap]) => {
    const days = wishesSnap.val() || {};
    const earnedByDate = {};
    Object.keys(days).forEach(dateStr => { earnedByDate[dateStr] = (days[dateStr] || {}).earned || 0; });
    const storedThrough = throughSnap.val();
    const { balance, foldedThrough } = foldWishesBalance(balSnap.val(), storedThrough, today, earnedByDate);
    if(foldedThrough !== storedThrough){
      _db.ref(`stewart/wishesBalance/${agentId}`).set(balance);
      _db.ref(`stewart/wishesBalanceThrough/${agentId}`).set(foldedThrough);
    }
    return balance;
  });
}

// Recalculate and store a boy's score AND wishes-earned for a given date in
// one pass — they're both derived from the same mission-completion data, so
// computing them together keeps them from ever drifting out of sync. Weekends
// never score or earn wishes (chores still happen Sat/Sun, they just don't
// count toward pay, game time, or wishes — tracked separately as "Damage
// Control"). Relies on a global `_db` (Firebase ref) already existing on the
// page — same as the original, so existing call sites don't need to change.
//
// Exception Days (combined-batch-punchlist.md Part 2) are treated exactly
// like a weekend here — null score/pay/eligible/wishes, excluded from the
// calculation entirely rather than counted as a $0 day. Deliberately NOT a
// change to buildMissions()'s own signature: every read-only display call
// site across boys/dashboard/bridge (20+ of them) already has to handle a
// null score gracefully because weekends produce one twice a week — so
// making exception days null too means they inherit that same handling for
// free, with zero risk to call sites this pass doesn't touch. The one
// surface that needs to say WHY explicitly (not just show blank) is the
// boy's own missions view, which checks stewart/exceptions itself.
function recalculateScore(agentId, dateStr){
  if(!_db) return Promise.resolve();
  return Promise.all([
    _db.ref(`stewart/missions/${agentId}/${dateStr}`).once('value'),
    _db.ref(`stewart/transferAdjust/${agentId}/${dateStr}`).once('value'),
    _db.ref(`stewart/deductions/${agentId}/${dateStr}`).once('value'),
    _db.ref(`stewart/exceptions/${dateStr}`).once('value'),
    _db.ref(`stewart/whiteglove/${dateStr}`).once('value')
  ]).then(([mSnap, tSnap, dSnap, eSnap, wgSnap]) => {
    const done = mSnap.val() || {};
    const transferAdjust = tSnap.val() || 0;
    const deductions = dSnap.val() || {};
    const exceptions = eSnap.val() || {};

    const dayDate = parseLocalDate(dateStr);
    const dayOfWeek = dayDate.getDay();
    const exception = findExceptionForAgent(exceptions, agentId);
    if(dayOfWeek===0||dayOfWeek===6||exception){
      return Promise.all([
        _db.ref(`stewart/scores/${agentId}/${dateStr}`).set(null),
        _db.ref(`stewart/wishes/${agentId}/${dateStr}/earned`).set(0),
        _db.ref(`stewart/pay/${agentId}/${dateStr}`).set(null),
        _db.ref(`stewart/eligible/${agentId}/${dateStr}`).set(null)
      ]);
    }

    const missions = buildMissions(agentId, dayDate);
    // White Glove -> pay accountability (Part 5): missions whose room
    // failed inspection lose their pay share even if checked off.
    const failedRooms = wgFailedRoomsForAgent(wgSnap.val(), agentId);
    const failedWgMissionIds = missions.filter(m => failedRooms.has(wgRoomForMission(m))).map(m => m.id);
    const base = calculateDayScore(agentId, missions, done, { failedWgMissionIds });

    let score = base.points100;
    score += transferAdjust;
    const totalDeductions = Object.values(deductions).reduce((a,b)=>a+b,0);
    score -= totalDeductions;
    score = Math.max(0, Math.min(100, score));

    return Promise.all([
      _db.ref(`stewart/scores/${agentId}/${dateStr}`).set(score),
      _db.ref(`stewart/wishes/${agentId}/${dateStr}/earned`).set(wishesForPct(base.pct)),
      // Stored unrounded (a raw fraction of $1.00) so weekly totals summed
      // from this path don't accumulate rounding error — round only at
      // display time. Deliberately NOT adjusted by transferAdjust/
      // deductions, matching calculateDayScore's own dollars — those only
      // ever move the points100 score above.
      _db.ref(`stewart/pay/${agentId}/${dateStr}`).set(base.dollars),
      // Raw completed/total eligible-mission count, same definition as pay
      // — lets any surface (report card, chore-log grids) show real counts
      // alongside the percentage score without needing its own copy of
      // buildMissions to compute one (the report card in particular runs
      // server-side, where mission-engine.js isn't loaded at all).
      _db.ref(`stewart/eligible/${agentId}/${dateStr}`).set({ completed: base.eligibleCompleted, total: base.eligibleTotal }),
      // Visibility (Part 5's "not silent" requirement) — which of his own
      // missions lost pay to a failed room today, if any, so his own Pay
      // tab can say why instead of a number just quietly coming up short.
      // null (not just empty) when nothing failed, so a page can tell
      // "checked, nothing failed" apart from "hasn't loaded yet."
      _db.ref(`stewart/wgPayImpact/${agentId}/${dateStr}`).set(failedWgMissionIds.length ? failedWgMissionIds : null)
    ]);
  });
}

// ══════════════════════════════════════════════════════
// THE MISSION LIST — the single canonical checklist.
// This is what boys see and check off, AND what scoring reads from.
// ══════════════════════════════════════════════════════
function buildMissions(agentId, _d){
  const dishTeam = getDishTeam(_d);
  const weekend = isWeekend(_d);
  const wed = isWednesday(_d);
  const day = getDayName(_d);
  const isBathroomWeek = (agentId === getBathroomAgent(_d));
  const isOfficerOfWatch = (agentId === getOfficerOfWatch(_d));

  // Is this agent on dishes today?
  const onDishes = (agentId === 'samuel' || agentId === 'johnjr')
    ? dishTeam === 'sj'
    : dishTeam === 'sd';

  const onSetup = !onDishes; // opposite team does setup

  const missions = [];

  // ── SHARED DAILY (all 7 days) ──────────────────────
  // period ('morning'/'lunch'/'evening') is used ONLY by the NextDNS
  // lockdown unlock check (nextdns-lockdown-punchlist.md, Step 2) — every
  // morning+lunch-period mission across a boy's ENTIRE day must be done
  // before his recreation sites unlock. Missions with no period (weekly
  // rotators, dinner-prep tasks, computer/officer-of-the-watch — the same
  // two categories already excluded from "eligible" above) never gate the
  // unlock; that's deliberate, confirmed with John, not an oversight.
  missions.push({
    id: 'bed',
    text: 'Make your bed',
    detail: 'Every morning before anything else.',
    points: 5,
    category: 'bedroom',
    always: true,
    period: 'morning'
  });
  missions.push({
    id: 'bedroom',
    text: 'Tidy your bedroom space',
    detail: 'Your area clean and clothes put away — floor included.',
    points: 5,
    category: 'bedroom',
    always: true,
    period: 'morning'
  });
  missions.push({
    id: 'rabbit-own',
    text: 'Care for your rabbit',
    detail: 'Feed and water your own rabbit before bed.',
    points: 5,
    category: 'animals',
    always: true,
    period: 'evening'
  });

  // ── COMPUTER MISSIONS (bonus — earn points, and screen time is earned through the family's own rule) ──
  missions.push({
    id: 'typing-practice',
    text: 'Typing practice — 10 minutes',
    detail: 'Work on speed and accuracy.',
    points: 5,
    category: 'computer',
    always: true
  });
  missions.push({
    id: 'scratch-lesson',
    text: 'Scratch coding lesson',
    detail: 'Complete one Scratch tutorial or work on your own project.',
    points: 8,
    category: 'computer',
    always: true
  });
  missions.push({
    id: 'khan-academy',
    text: 'Khan Academy — one lesson',
    detail: 'Complete one lesson in math, reading, or science.',
    points: 8,
    category: 'computer',
    always: true
  });
  missions.push({
    id: 'research-report',
    text: 'Research & report',
    detail: 'Pick a topic, research it, and write down three facts you learned.',
    points: 6,
    category: 'computer',
    always: true
  });

  // ── DISHES TEAM DAILY ──────────────────────────────
  if(onDishes){
    // Dish team is either Sam+John or Stephen+Daniel
    // Sam+John: both alternate load and unload between themselves
    // Stephen+Daniel: Stephen UNLOADS, Daniel LOADS — always, no exceptions
    // Dishwasher runs up to 3 times a day — load, run, and put away after each run.

    // Round 1/2/3 don't actually reset through the day (a boy checks each
    // one exactly once) — deliberately NOT made repeatable/resettable even
    // though the dishwasher can genuinely run more than 3 times some days;
    // a checkbox that un-checks itself and reappears reads as broken, not
    // as "go run it again." For the unlock gate, Round 1/2/3 map to
    // morning/lunch/evening respectively — confirmed with John.
    const ROUNDS = [
      {n: 1, label: 'Round 1', period: 'morning'},
      {n: 2, label: 'Round 2', period: 'lunch'},
      {n: 3, label: 'Round 3', period: 'evening'}
    ];

    if(agentId === 'samuel' || agentId === 'johnjr'){
      const partner = agentId === 'samuel' ? 'John Jr.' : 'Samuel';
      ROUNDS.forEach(r => {
        missions.push({
          id: `dishwasher-load-${r.n}`,
          text: `Load the dishwasher — ${r.label} — with ${partner}`,
          detail: `You and ${partner} handle dishes today. Load it up whenever it's full — up to 3 times a day.`,
          points: 10,
          category: 'kitchen',
          always: true,
          period: r.period
        });
        missions.push({
          id: `dishwasher-unload-${r.n}`,
          text: `Unload & put away — ${r.label} — with ${partner}`,
          detail: `As soon as this run finishes, empty it and put everything away before the next load goes in.`,
          points: 10,
          category: 'kitchen',
          always: true,
          period: r.period
        });
      });
    }

    if(agentId === 'stephen'){
      // Stephen ONLY unloads — Daniel loads
      ROUNDS.forEach(r => {
        missions.push({
          id: `dishwasher-unload-${r.n}`,
          text: `Unload & put away — ${r.label} — with Daniel`,
          detail: `As soon as this run finishes, empty it and put everything away. Daniel will load the next one.`,
          points: 10,
          category: 'kitchen',
          always: true,
          period: r.period
        });
      });
    }

    if(agentId === 'daniel'){
      // Daniel ONLY loads — Stephen unloads
      ROUNDS.forEach(r => {
        missions.push({
          id: `dishwasher-load-${r.n}`,
          text: `Load the dishwasher — ${r.label} — with Stephen`,
          detail: `Load it up whenever it's full — up to 3 times a day. Stephen will unload and put away after each run.`,
          points: 10,
          category: 'kitchen',
          always: true,
          period: r.period
        });
      });
    }

    missions.push({
      id: 'table-clear',
      text: 'Clear the table after dinner',
      detail: 'Bring all dishes, glasses, and food to the kitchen.',
      points: 5,
      category: 'kitchen',
      always: true,
      period: 'evening'
    });
    // Split into three (nextdns-lockdown-punchlist.md follow-up) — the old
    // single 'table-wipe' checkbox claimed "after every meal" in its own
    // detail text but could only ever be checked once a day, which made
    // that description untrue by lunchtime (dinner hadn't happened yet).
    // Three separate missions make "after every meal" literally checkable,
    // and let breakfast+lunch gate the unlock without waiting on dinner.
    // Point total kept at 5 (2+2+1, matching the original single mission's
    // value) rather than 5 each — flagged for John to adjust if he'd
    // rather this be worth more now that it's three real check-ins.
    missions.push({
      id: 'table-wipe-breakfast',
      text: 'Wipe down the table — after breakfast',
      detail: 'Wipe the whole table after breakfast.',
      points: 2,
      category: 'kitchen',
      always: true,
      period: 'morning'
    });
    missions.push({
      id: 'table-wipe-lunch',
      text: 'Wipe down the table — after lunch',
      detail: 'Wipe the whole table after lunch.',
      points: 2,
      category: 'kitchen',
      always: true,
      period: 'lunch'
    });
    missions.push({
      id: 'table-wipe-dinner',
      text: 'Wipe down the table — after dinner',
      detail: 'Wipe the whole table after dinner.',
      points: 1,
      category: 'kitchen',
      always: true,
      period: 'evening'
    });
  }

// ── SETUP TEAM DAILY ──────────────────────────────
  if(onSetup){
    missions.push({
      id: 'pots-pans-wash',
      text: 'Wash breakfast & lunch pots and pans',
      detail: 'The dish team\'s got the dishwasher today — if any pots or pans got used for breakfast or lunch, you wash those by hand. Keep the sink and counter clear. (Dinner pots and pans are Mom\'s.)',
      points: 10,
      category: 'kitchen',
      always: true,
      period: 'lunch'
    });
    missions.push({
      id: 'table-set',
      text: 'Set the table before dinner',
      detail: 'Plates, silverware, and napkins — set 10 minutes before we sit down.',
      points: 5,
      category: 'kitchen',
      always: true,
      period: 'evening'
    });
    // Drinks — only older boys
    if(agentId === 'samuel' || agentId === 'johnjr'){
      const partner = agentId === 'samuel' ? 'John Jr.' : 'Samuel';
      missions.push({
        id: 'drinks',
        text: `Pour drinks before dinner — with ${partner}`,
        detail: `Pour everyone's drinks 10 minutes before dinner. You and ${partner} handle setup today.`,
        points: 5,
        category: 'kitchen',
        always: true,
        period: 'evening'
      });
    }
    // Appliance wipes — Sam, John, Stephen only, dropped on their laundry day
    if(agentId !== 'daniel' && !isLaundryDay(agentId, _d)){
      missions.push({
        id: 'stovetop',
        text: 'Wipe down the stovetop',
        detail: 'Wipe down all burners and the stovetop surface after cooking.',
        points: 5,
        category: 'kitchen',
        always: true,
        period: 'lunch'
      });
      missions.push({
        id: 'microwave',
        text: 'Wipe down the microwave',
        detail: 'Inside and outside. Check for splatter.',
        points: 5,
        category: 'kitchen',
        always: true,
        period: 'lunch'
      });
    }
  }

  // ── AGENT-SPECIFIC DAILY ─────────────────────────
  // Room-straighten/trash-pickup missions added alongside the existing
  // floor sweeps (nextdns-lockdown-punchlist.md follow-up) — the floor
  // sweep alone doesn't catch a cluttered couch, gear left on the
  // washer/dryer, or dishes drifting out of the kitchen, which is what was
  // actually falling through the cracks. Kept as separate mission IDs from
  // their sibling floor sweep on purpose (a boy can sweep and still leave
  // the couch a mess, or vice versa) and placed right next to it. All at
  // period:'morning' — same weekday-only cadence as the floor sweeps they
  // sit beside, EXCEPT kitchen-counter, which John specifically called out
  // as needing to run every day, weekends included.
  if(agentId === 'samuel'){
    missions.push({
      id: 'floor-laundry',
      text: 'Sweep the laundry room floor',
      detail: 'Sweep and tidy the laundry room.',
      points: 5,
      category: 'floors',
      weekday: true,
      period: 'morning'
    });
    missions.push({
      id: 'laundry-room-clear',
      text: 'Clear off the washer and dryer',
      detail: 'Nothing left sitting on top of the washer or dryer — clear it all off.',
      points: 5,
      category: 'floors',
      weekday: true,
      period: 'morning'
    });
    missions.push({
      id: 'bathroom-counter',
      text: 'Clean & wipe the bathroom counter',
      detail: 'Counter wiped down and cleared off — everything put away, nothing left sitting out.',
      points: 5,
      category: 'bathroom',
      weekday: true,
      period: 'lunch'
    });
  }

  if(agentId === 'johnjr'){
    missions.push({
      id: 'floor-living',
      text: 'Sweep the living room floor',
      detail: 'Sweep the full living room floor.',
      points: 5,
      category: 'floors',
      weekday: true,
      period: 'morning'
    });
    missions.push({
      id: 'living-room-straighten',
      text: 'Straighten the living room',
      detail: 'Couch cleared off, and any shoes put away in the shoe bin.',
      points: 5,
      category: 'floors',
      weekday: true,
      period: 'morning'
    });
  }

  if(agentId === 'stephen'){
    missions.push({
      id: 'kitchen-counter',
      text: 'Clean & wipe kitchen counters',
      detail: 'Wipe down all counter surfaces. Clear anything that doesn\'t belong. Every day, weekends included.',
      points: 10,
      category: 'kitchen',
      always: true,
      period: 'morning'
    });
    missions.push({
      id: 'floor-kitchen',
      text: 'Sweep the kitchen floor',
      detail: 'Sweep the full kitchen floor including under the table.',
      points: 5,
      category: 'floors',
      weekday: true,
      period: 'morning'
    });
  }

  if(agentId === 'daniel'){
    missions.push({
      id: 'floor-hallway',
      text: 'Sweep the hallway',
      detail: 'Sweep the hallway floor.',
      points: 5,
      category: 'floors',
      weekday: true,
      period: 'morning'
    });
    missions.push({
      id: 'floor-rabbit',
      text: 'Sweep the rabbit cage area',
      detail: 'Sweep around and under the rabbit cages.',
      points: 5,
      category: 'animals',
      weekday: true,
      period: 'morning'
    });
    missions.push({
      id: 'house-dish-sweep',
      text: 'Check every room for dishes & silverware',
      detail: 'Walk through the whole house and bring back any dishes, cups, or silverware to the kitchen.',
      points: 5,
      category: 'kitchen',
      weekday: true,
      period: 'morning'
    });
  }

  // ── WEEKLY MISSIONS ────────────────────────────────
  // Only show on weekdays, one per week — app marks when done

  if(agentId === 'samuel'){
    if(isLaundryDay('samuel', _d)){
      missions.push({
        id: 'laundry-sam',
        text: 'Laundry Day — with John Jr.',
        detail: 'Wash, dry, and put away your laundry together. This is your main mission today.',
        points: 15,
        category: 'laundry',
        always: true,
        period: 'lunch'
      });
    }
    missions.push({
      id: 'fridge',
      text: 'Wipe down the fridge',
      detail: 'Inside and outside. Sam, John, and Stephen rotate this weekly.',
      points: 10,
      category: 'kitchen',
      weekly: true,
      rotate: 'sj-stephen',
      period: 'evening'
    });
    if(isBathroomWeek){
      missions.push({
        id: 'bathroom-clean',
        text: 'Clean the bathroom',
        detail: 'Full clean — toilet, sink, mirror, wipe down surfaces. Your turn this week.',
        points: 15,
        category: 'bathroom',
        weekly: true,
        period: 'evening'
      });
    }
  }

  if(agentId === 'johnjr'){
    if(isLaundryDay('johnjr', _d)){
      missions.push({
        id: 'laundry-john',
        text: 'Laundry Day — with Samuel',
        detail: 'Wash, dry, and put away your laundry together. This is your main mission today.',
        points: 15,
        category: 'laundry',
        always: true,
        period: 'lunch'
      });
    }
    missions.push({
      id: 'fridge',
      text: 'Wipe down the fridge',
      detail: 'Inside and outside. Sam, John, and Stephen rotate this weekly.',
      points: 10,
      category: 'kitchen',
      weekly: true,
      rotate: 'sj-stephen',
      period: 'evening'
    });
    if(isBathroomWeek){
      missions.push({
        id: 'bathroom-clean',
        text: 'Clean the bathroom',
        detail: 'Full clean — toilet, sink, mirror, wipe down surfaces. Your turn this week.',
        points: 15,
        category: 'bathroom',
        weekly: true,
        period: 'evening'
      });
    }
  }

  if(agentId === 'stephen'){
    if(isLaundryDay('stephen', _d)){
      missions.push({
        id: 'laundry-stephen',
        text: 'Laundry Day — with Daniel',
        detail: 'Wash, dry, and put away your laundry together. This is your main mission today.',
        points: 15,
        category: 'laundry',
        always: true,
        period: 'lunch'
      });
    }
    missions.push({
      id: 'hutch',
      text: 'Straighten & organize the hutch',
      detail: 'Straighten and organize the food hutch — boxes neat, nothing expired, everything in its place.',
      points: 10,
      category: 'kitchen',
      weekly: true,
      period: 'evening'
    });
    missions.push({
      id: 'fridge',
      text: 'Wipe down the fridge',
      detail: 'Inside and outside. Sam, John, and Stephen rotate this weekly.',
      points: 10,
      category: 'kitchen',
      weekly: true,
      rotate: 'sj-stephen',
      period: 'evening'
    });
    if(isBathroomWeek){
      missions.push({
        id: 'bathroom-clean',
        text: 'Clean the bathroom',
        detail: 'Full clean — toilet, sink, mirror, wipe down surfaces. Your turn this week.',
        points: 15,
        category: 'bathroom',
        weekly: true,
        period: 'evening'
      });
    }
  }

  if(agentId === 'daniel'){
    if(isLaundryDay('daniel', _d)){
      missions.push({
        id: 'laundry-daniel',
        text: 'Laundry Day — with Stephen',
        detail: 'Wash, dry, and put away your laundry together. This is your main mission today.',
        points: 10,
        category: 'laundry',
        always: true,
        period: 'lunch'
      });
    }
    missions.push({
      id: 'bathroom-trash',
      text: 'Empty bathroom trash',
      detail: 'Wednesday morning — empty the bathroom trash can and bring it to the road with Sam and John.',
      points: 10,
      category: 'bathroom',
      weekly: true,
      wednesday: true,
      period: 'morning'
    });
    if(isBathroomWeek){
      missions.push({
        id: 'bathroom-clean',
        text: 'Clean the bathroom',
        detail: 'Full clean — toilet, sink, mirror, wipe down surfaces. Your turn this week.',
        points: 15,
        category: 'bathroom',
        weekly: true,
        period: 'evening'
      });
    }
  }

  // ── WEDNESDAY TRASH ────────────────────────────────
  if(wed && (agentId === 'samuel' || agentId === 'johnjr')){
    const partner = agentId === 'samuel' ? 'John Jr.' : 'Samuel';
    missions.push({
      id: 'trash',
      text: `Take trash to the road — with ${partner}`,
      detail: `Wednesday mission — you and ${partner} go together. Long driveway, out before 9am. Daniel brings the bathroom trash to you.`,
      points: 10,
      category: 'trash',
      always: true,
      urgent: true,
      period: 'morning'
    });
  }

  // ── WEEKLY RABBIT CAGE CLEAN ─────────────────────
  missions.push({
    id: 'rabbit-cage',
    text: 'Clean rabbit cages',
    detail: 'All four boys clean the cages together once this week.',
    points: 15,
    category: 'animals',
    weekly: true,
    period: 'evening'
  });

  // ── DINNER SIDE DISH (Mon/Wed/Thu) ────────────────
  if(isDinnerSideDay(_d)){
    const side = getMyDinnerSide(agentId, _d);
    const pair = PAIRS[agentId];
    if(side && pair){
      const partner = pair.partner === 'johnjr' ? 'John Jr.' : pair.partner.charAt(0).toUpperCase() + pair.partner.slice(1);
      if(side === 'starch'){
        missions.push({
          id: 'dinner-side-starch',
          text: `Make the starch side — with ${partner}`,
          detail: `Potatoes, rice, pasta, or similar. Work with ${partner} to get it ready for dinner.`,
          points: 10,
          category: 'kitchen',
          always: true,
          period: 'evening'
        });
      } else {
        missions.push({
          id: 'dinner-side-veggie',
          text: `Make the vegetable — with ${partner}`,
          detail: `Heat the vegetable on the stove or microwave with ${partner} for dinner tonight.`,
          points: 5,
          category: 'kitchen',
          always: true,
          period: 'evening'
        });
      }
    }
  }

  // ── OFFICER OF THE WATCH (daily rotating inspection role, no points) ──
  if(isOfficerOfWatch){
    const watchRounds = [
      {key: 'morning', label: 'Morning Round'},
      {key: 'midday', label: 'Midday Round'},
      {key: 'evening', label: 'Evening Round'}
    ];
    const watchChecks = [
      {key: 'bread', text: 'Bread sealed on the hutch', detail: 'Every loaf bagged shut — none left open.'},
      {key: 'fridge', text: 'Fridge covered, shelf by shelf', detail: 'Lids on, bags sealed, nothing left uncovered.'},
      {key: 'lights', text: 'All lights off', detail: 'Bathroom included — every light doused before moving on.'},
      {key: 'sink', text: 'Sink & counter clear', detail: 'No dishes sitting in the sink or on the counter.'}
    ];
    watchRounds.forEach(r => {
      watchChecks.forEach(c => {
        missions.push({
          id: `oow-${r.key}-${c.key}`,
          text: `Officer of the Watch (${r.label}): ${c.text}`,
          detail: c.detail,
          points: 0,
          category: 'officer-of-the-watch',
          always: true
        });
      });
    });
  }

  // Filter by day type
  return missions.filter(m => {
    if(m.always) return true;
    if(m.weekday && !weekend) return true;
    if(m.weekly && !weekend) return true;
    if(m.wednesday && wed) return true;
    return false;
  });
}

// ══════════════════════════════════════════════════════
// NextDNS lockdown unlock gate (nextdns-lockdown-punchlist.md, Step 2)
// The single definition of "what has to be done before a boy's recreation
// sites unlock" — every mission actually on his list TODAY (weekday-only,
// laundry-day, rotation-dependent, etc. all already resolved by
// buildMissions above) tagged period:'morning' or period:'lunch'. Evening/
// dinner-prep missions, weekly rotators John decided don't gate the
// unlock (fridge, hutch, weekly bathroom clean, rabbit cage), and the two
// non-required categories (computer, officer-of-the-watch) are never
// included — confirmed with John mission-by-mission, not inferred.
//
// Shared by the Cloud Function that checks completion (functions/index.js,
// requires this file directly — see the module.exports guard at the
// bottom) and available client-side too for a future "locked/unlocked"
// status display (Step 4's "worth considering" note), so both can never
// disagree about what "done" means the way the pay/score duplicate-copy
// bug once let two pages disagree about the mission list itself.
function morningLunchMissions(agentId, _d){
  return buildMissions(agentId, _d).filter(m => m.period === 'morning' || m.period === 'lunch');
}

// True once every morning+lunch mission on a boy's list for this specific
// day is marked done in doneMap ({missionId: true}). An empty required
// list (shouldn't happen in practice, but not impossible on some future
// exception-day config) returns false, not true — fails safe, never
// unlocks from "there was nothing to check."
function morningLunchComplete(agentId, _d, doneMap){
  const required = morningLunchMissions(agentId, _d);
  if(!required.length) return false;
  return required.every(m => doneMap && doneMap[m.id]);
}

// Loaded two different ways: a plain <script> tag in the browser (boys/
// dashboard), where these become ordinary globals, and require() from
// Cloud Functions (functions/index.js), which is CommonJS and needs an
// actual module.exports. `module` only exists in the latter environment,
// so this never runs client-side — no behavior change there.
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    localDateStr, parseLocalDate,
    buildMissions,
    morningLunchMissions, morningLunchComplete,
    WISHES_MAX_BALANCE, foldWishesBalance
  };
}
