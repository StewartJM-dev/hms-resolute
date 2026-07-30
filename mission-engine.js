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
  const now = _d ? new Date(_d) : new Date();
  const epoch = new Date(2024, 0, 1); // fixed reference point, arbitrary but stable
  const daysSinceEpoch = Math.floor((now - epoch) / (24*60*60*1000));
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
  const now = _d ? new Date(_d) : new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.floor((now - startOfYear) / (7*24*60*60*1000));
  return order[weekNum % 4];
}
function getOfficerOfWatch(_d){
  const order = ['samuel','johnjr','stephen','daniel'];
  const now = _d ? new Date(_d) : new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const dayNum = Math.floor((now - startOfYear) / (24*60*60*1000));
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
  const date = dateOverride ? new Date(dateOverride) : new Date();
  const dow = date.getDay();
  if(!DINNER_SIDE_DAYS.includes(dow)) return null;
  const epoch = new Date(2024, 0, 1);
  const daysSinceEpoch = Math.floor((date - epoch) / (24*60*60*1000));
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
// POINTS SYSTEM — 100 points = $1.00 = 6 minutes per day (weekdays only)
// ══════════════════════════════════════════════════════
// Computer Missions (typing, Scratch, Khan Academy, research) are bonus —
// they're checkable and trackable but do NOT count toward pay or game time.
// That's a deliberate family rule, not an oversight — don't "fix" this by
// including them again.
function calculateDayScore(agentId, missions, doneMap){
  const payMissions = missions.filter(m => m.category !== 'computer');
  const possible = payMissions.reduce((sum,m) => sum + (m.points||0), 0);
  const earned = payMissions.reduce((sum,m) => sum + (doneMap[m.id] ? (m.points||0) : 0), 0);
  const pct = possible > 0 ? (earned / possible) : 0;
  return {
    earned, possible, pct,
    points100: Math.round(pct * 100),
    dollars: Math.round(pct * 100) / 100,
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
// code never writes its own score. getAvailableWishes() below is read-only,
// for UI display.
// ══════════════════════════════════════════════════════
function wishesForPct(pct){
  if(pct >= 1) return 3;
  if(pct >= 2/3) return 2;
  if(pct >= 1/3) return 1;
  return 0;
}

// Current spendable wish balance: every PRIOR day's earned wishes, minus
// everything used (including today's own usage), floored at 0. Today's own
// earned wishes are excluded on purpose — per the original design, wishes
// earned today don't unlock until tomorrow.
function getAvailableWishes(agentId){
  if(!_db) return Promise.resolve(0);
  const today = localDateStr();
  return _db.ref(`stewart/wishes/${agentId}`).once('value').then(snap => {
    const days = snap.val() || {};
    let earned = 0, used = 0;
    Object.keys(days).forEach(dateStr => {
      const rec = days[dateStr] || {};
      if(dateStr < today) earned += (rec.earned || 0);
      used += (rec.used || 0);
    });
    return Math.max(0, earned - used);
  });
}

// Recalculate and store a boy's score AND wishes-earned for a given date in
// one pass — they're both derived from the same mission-completion data, so
// computing them together keeps them from ever drifting out of sync. Weekends
// never score or earn wishes (chores still happen Sat/Sun, they just don't
// count toward pay, game time, or wishes — tracked separately as "Damage
// Control"). Relies on a global `_db` (Firebase ref) already existing on the
// page — same as the original, so existing call sites don't need to change.
function recalculateScore(agentId, dateStr){
  if(!_db) return Promise.resolve();
  return Promise.all([
    _db.ref(`stewart/missions/${agentId}/${dateStr}`).once('value'),
    _db.ref(`stewart/transferAdjust/${agentId}/${dateStr}`).once('value'),
    _db.ref(`stewart/deductions/${agentId}/${dateStr}`).once('value')
  ]).then(([mSnap, tSnap, dSnap]) => {
    const done = mSnap.val() || {};
    const transferAdjust = tSnap.val() || 0;
    const deductions = dSnap.val() || {};

    const dayDate = parseLocalDate(dateStr);
    const dayOfWeek = dayDate.getDay();
    if(dayOfWeek===0||dayOfWeek===6){
      return Promise.all([
        _db.ref(`stewart/scores/${agentId}/${dateStr}`).set(null),
        _db.ref(`stewart/wishes/${agentId}/${dateStr}/earned`).set(0)
      ]);
    }

    const missions = buildMissions(agentId, dayDate);
    const base = calculateDayScore(agentId, missions, done);

    let score = base.points100;
    score += transferAdjust;
    const totalDeductions = Object.values(deductions).reduce((a,b)=>a+b,0);
    score -= totalDeductions;
    score = Math.max(0, Math.min(100, score));

    return Promise.all([
      _db.ref(`stewart/scores/${agentId}/${dateStr}`).set(score),
      _db.ref(`stewart/wishes/${agentId}/${dateStr}/earned`).set(wishesForPct(base.pct))
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
  missions.push({
    id: 'bed',
    text: 'Make your bed',
    detail: 'Every morning before anything else.',
    points: 5,
    category: 'bedroom',
    always: true
  });
  missions.push({
    id: 'bedroom',
    text: 'Tidy your bedroom space',
    detail: 'Your area clean and clothes put away.',
    points: 5,
    category: 'bedroom',
    always: true
  });
  missions.push({
    id: 'rabbit-own',
    text: 'Care for your rabbit',
    detail: 'Feed and water your own rabbit before bed.',
    points: 5,
    category: 'animals',
    always: true
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

    const ROUNDS = [
      {n: 1, label: 'Round 1'},
      {n: 2, label: 'Round 2'},
      {n: 3, label: 'Round 3'}
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
          always: true
        });
        missions.push({
          id: `dishwasher-unload-${r.n}`,
          text: `Unload & put away — ${r.label} — with ${partner}`,
          detail: `As soon as this run finishes, empty it and put everything away before the next load goes in.`,
          points: 10,
          category: 'kitchen',
          always: true
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
          always: true
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
          always: true
        });
      });
    }

    missions.push({
      id: 'table-clear',
      text: 'Clear the table after dinner',
      detail: 'Bring all dishes, glasses, and food to the kitchen.',
      points: 5,
      category: 'kitchen',
      always: true
    });
    missions.push({
      id: 'table-wipe',
      text: 'Wipe down the table after meals',
      detail: 'Wipe the whole table after every meal — breakfast, lunch, and dinner.',
      points: 5,
      category: 'kitchen',
      always: true
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
      always: true
    });
    missions.push({
      id: 'table-set',
      text: 'Set the table before dinner',
      detail: 'Plates, silverware, and napkins — set 10 minutes before we sit down.',
      points: 5,
      category: 'kitchen',
      always: true
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
        always: true
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
        always: true
      });
      missions.push({
        id: 'microwave',
        text: 'Wipe down the microwave',
        detail: 'Inside and outside. Check for splatter.',
        points: 5,
        category: 'kitchen',
        always: true
      });
    }
  }

  // ── AGENT-SPECIFIC DAILY ─────────────────────────
  if(agentId === 'samuel'){
    missions.push({
      id: 'floor-laundry',
      text: 'Sweep the laundry room floor',
      detail: 'Sweep and tidy the laundry room.',
      points: 5,
      category: 'floors',
      weekday: true
    });
  }

  if(agentId === 'johnjr'){
    missions.push({
      id: 'floor-living',
      text: 'Sweep the living room floor',
      detail: 'Sweep the full living room floor.',
      points: 5,
      category: 'floors',
      weekday: true
    });
  }

  if(agentId === 'stephen'){
    missions.push({
      id: 'kitchen-counter',
      text: 'Clean & wipe kitchen counters',
      detail: 'Wipe down all counter surfaces. Clear anything that doesn\'t belong.',
      points: 10,
      category: 'kitchen',
      weekday: true
    });
    missions.push({
      id: 'floor-kitchen',
      text: 'Sweep the kitchen floor',
      detail: 'Sweep the full kitchen floor including under the table.',
      points: 5,
      category: 'floors',
      weekday: true
    });
  }

  if(agentId === 'daniel'){
    missions.push({
      id: 'floor-hallway',
      text: 'Sweep the hallway',
      detail: 'Sweep the hallway floor.',
      points: 5,
      category: 'floors',
      weekday: true
    });
    missions.push({
      id: 'floor-rabbit',
      text: 'Sweep the rabbit cage area',
      detail: 'Sweep around and under the rabbit cages.',
      points: 5,
      category: 'animals',
      weekday: true
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
        always: true
      });
    }
    missions.push({
      id: 'fridge',
      text: 'Wipe down the fridge',
      detail: 'Inside and outside. Sam, John, and Stephen rotate this weekly.',
      points: 10,
      category: 'kitchen',
      weekly: true,
      rotate: 'sj-stephen'
    });
    if(isBathroomWeek){
      missions.push({
        id: 'bathroom-clean',
        text: 'Clean the bathroom',
        detail: 'Full clean — toilet, sink, mirror, wipe down surfaces. Your turn this week.',
        points: 15,
        category: 'bathroom',
        weekly: true
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
        always: true
      });
    }
    missions.push({
      id: 'fridge',
      text: 'Wipe down the fridge',
      detail: 'Inside and outside. Sam, John, and Stephen rotate this weekly.',
      points: 10,
      category: 'kitchen',
      weekly: true,
      rotate: 'sj-stephen'
    });
    if(isBathroomWeek){
      missions.push({
        id: 'bathroom-clean',
        text: 'Clean the bathroom',
        detail: 'Full clean — toilet, sink, mirror, wipe down surfaces. Your turn this week.',
        points: 15,
        category: 'bathroom',
        weekly: true
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
        always: true
      });
    }
    missions.push({
      id: 'hutch',
      text: 'Organize the hutch',
      detail: 'Keep the food hutch organized — boxes neat, nothing expired, everything in its place.',
      points: 10,
      category: 'kitchen',
      weekly: true
    });
    missions.push({
      id: 'fridge',
      text: 'Wipe down the fridge',
      detail: 'Inside and outside. Sam, John, and Stephen rotate this weekly.',
      points: 10,
      category: 'kitchen',
      weekly: true,
      rotate: 'sj-stephen'
    });
    if(isBathroomWeek){
      missions.push({
        id: 'bathroom-clean',
        text: 'Clean the bathroom',
        detail: 'Full clean — toilet, sink, mirror, wipe down surfaces. Your turn this week.',
        points: 15,
        category: 'bathroom',
        weekly: true
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
        always: true
      });
    }
    missions.push({
      id: 'bathroom-trash',
      text: 'Empty bathroom trash',
      detail: 'Wednesday morning — empty the bathroom trash can and bring it to the road with Sam and John.',
      points: 10,
      category: 'bathroom',
      weekly: true,
      wednesday: true
    });
    if(isBathroomWeek){
      missions.push({
        id: 'bathroom-clean',
        text: 'Clean the bathroom',
        detail: 'Full clean — toilet, sink, mirror, wipe down surfaces. Your turn this week.',
        points: 15,
        category: 'bathroom',
        weekly: true
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
      urgent: true
    });
  }

  // ── WEEKLY RABBIT CAGE CLEAN ─────────────────────
  missions.push({
    id: 'rabbit-cage',
    text: 'Clean rabbit cages',
    detail: 'All four boys clean the cages together once this week.',
    points: 15,
    category: 'animals',
    weekly: true
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
          always: true
        });
      } else {
        missions.push({
          id: 'dinner-side-veggie',
          text: `Make the vegetable — with ${partner}`,
          detail: `Heat the vegetable on the stove or microwave with ${partner} for dinner tonight.`,
          points: 5,
          category: 'kitchen',
          always: true
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
