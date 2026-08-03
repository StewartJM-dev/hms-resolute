// ════════════════════════════════════════════════════
// HMS RESOLUTE — Comms push notifications
// Deploy with: firebase deploy --only functions
// (Requires the Blaze plan — Realtime Database triggers aren't
// available on the free Spark plan.)
// ════════════════════════════════════════════════════
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
// The single shared mission list/scoring engine (repo root, also loaded
// client-side via <script> in boys/index.html and dashboard/index.html).
// Copied into functions/ by the predeploy hook in firebase.json right
// before every deploy — see that file's comment — so this stays the one
// real copy, not a duplicate that can drift the way this file's own
// header comment warns against.
const { parseLocalDate, morningLunchComplete } = require('./mission-engine.js');
const { NEXTDNS_RECREATION_DOMAINS } = require('./nextdns-config.js');
admin.initializeApp();

const db = admin.database();
const messaging = admin.messaging();

const PARENTS = { Dad: 'john', Mom: 'dawn' };
const ALL_PEOPLE = ['john', 'dawn', 'samuel', 'johnjr', 'stephen', 'daniel'];

async function sendToPerson(person, title, body, url) {
  const snap = await db.ref('notifications/tokens/' + person).once('value');
  const tokensObj = snap.val() || {};
  // Dedupe by the actual token VALUE, not just the storage key — if a
  // device's token ever rotated and the old entry never got cleaned up,
  // this is what stops it from receiving the same push twice.
  const tokens = [...new Set(Object.values(tokensObj).map(t => t.token).filter(Boolean))];
  if (!tokens.length) return;

  const resp = await messaging.sendEachForMulticast({
    // IMPORTANT: data-only, no top-level "notification" field.
    // Including both a notification payload AND a custom onBackgroundMessage
    // handler in the service worker causes some platforms to auto-display
    // the notification AND run the handler's own showNotification() call —
    // two displays for one single push, every time, regardless of sender.
    // This was the actual cause of the persistent duplicate notifications.
    data: { title, body, url: url || '/' },
    tokens
  });

  // Clean up any tokens that are no longer valid (uninstalled, expired, etc.)
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const badToken = tokens[i];
      const key = Object.keys(tokensObj).find(k => tokensObj[k].token === badToken);
      if (key) db.ref('notifications/tokens/' + person + '/' + key).remove();
    }
  });
}

// Cloud Functions only guarantee "at least once" execution for database
// triggers — under retries (timeouts, transient errors) the same event can
// legitimately fire a function twice. This transaction ensures only the
// first invocation for a given event actually sends; any duplicate firing
// finds the marker already claimed and backs off silently.
async function alreadyNotified(key) {
  const ref = db.ref('stewart/notifiedEvents/' + key);
  const result = await ref.transaction(current => current === null ? true : undefined);
  return !result.committed;
}

// Family Channel — group chat
exports.notifyGroupChat = functions.database
  .ref('/stewart/groupchat/{msgId}')
  .onCreate(async (snap, context) => {
    const m = snap.val();
    if (!m || !m.text) return null;
    if (await alreadyNotified('groupchat_' + context.params.msgId)) return null;

    const senderPerson = m.agentId === 'parent' ? (PARENTS[m.from] || 'john') : m.agentId;
    const recipients = ALL_PEOPLE.filter(p => p !== senderPerson);

    const title = 'Family Channel — ' + (m.from || 'Someone');
    const body = m.text.length > 100 ? m.text.slice(0, 100) + '…' : m.text;

    await Promise.all(recipients.map(p => sendToPerson(p, title, body, 'bridge/')));
    return null;
  });

// Private Threads — Bridge-to-boy
exports.notifyPrivateThread = functions.database
  .ref('/stewart/messages/{agentId}/{msgId}')
  .onCreate(async (snap, context) => {
    const m = snap.val();
    const agentId = context.params.agentId; // which boy this thread belongs to
    if (!m || !m.text) return null;
    if (await alreadyNotified('privatemsg_' + agentId + '_' + context.params.msgId)) return null;

    // Tom's own moderation nudges land in this same thread — route them to
    // the boy like a parent message, not to John/Dawn like a boy message.
    // Category B's separate, explicit parent notification (Step 3) is what
    // actually alerts John/Dawn; this path must not double up on that for
    // every Category A nudge too.
    const isParentSender = (m.from === 'Dad' || m.from === 'Mom' || m.from === 'HQ' || m.from === 'Tom');
    const title = 'Private Message — ' + (m.from || 'Someone');
    const body = m.text.length > 100 ? m.text.slice(0, 100) + '…' : m.text;

    if (isParentSender) {
      await sendToPerson(agentId, title, body, 'boys/');
    } else {
      await Promise.all(['john', 'dawn'].map(p => sendToPerson(p, title, body, 'bridge/')));
    }
    return null;
  });

// Screen Time cash-out requests — notify parents when a boy asks
exports.notifyScreenTimeRequest = functions.database
  .ref('/stewart/screenTimeRequests/{agentId}/{reqId}')
  .onCreate(async (snap, context) => {
    const r = snap.val();
    if (!r || r.status !== 'pending') return null;
    if (await alreadyNotified('strequest_' + context.params.agentId + '_' + context.params.reqId)) return null;

    const title = 'Screen Time Request';
    const body = (r.agentName || context.params.agentId) + ' wants to cash out ' + r.amount + ' minutes.';

    await Promise.all(['john', 'dawn'].map(p => sendToPerson(p, title, body, 'bridge/')));
    return null;
  });

// Screen Time cash-out requests — notify the boy once a parent resolves it
exports.notifyScreenTimeResolved = functions.database
  .ref('/stewart/screenTimeRequests/{agentId}/{reqId}')
  .onUpdate(async (change, context) => {
    const before = change.before.val();
    const after = change.after.val();
    if (!after || before.status !== 'pending' || after.status === 'pending') return null;
    if (await alreadyNotified('stresolved_' + context.params.agentId + '_' + context.params.reqId)) return null;

    const agentId = context.params.agentId;
    const approved = after.status === 'approved';
    const title = approved ? 'Screen Time Approved!' : 'Screen Time Request Denied';
    const body = approved
      ? (after.amount + ' minutes approved — enjoy, Agent!')
      : ('Your request for ' + after.amount + ' minutes was declined.');

    await sendToPerson(agentId, title, body, 'boys/');
    return null;
  });

// Ship Account — notify parents when a boy cashes out or buys a store item
exports.notifyShipAccountRequest = functions.database
  .ref('/stewart/shipAccount/{agentId}/register/{regId}')
  .onCreate(async (snap, context) => {
    const r = snap.val();
    if (!r || r.status !== 'pending') return null;
    if (await alreadyNotified('sarequest_' + context.params.agentId + '_' + context.params.regId)) return null;

    const name = r.agentName || context.params.agentId;
    const title = r.type === 'purchase' ? "Ship's Store Purchase" : 'Ship Account Cash Out';
    const body = r.type === 'purchase'
      ? (name + ' bought ' + (r.itemName || 'an item') + ' for $' + r.amount.toFixed(2) + '.')
      : (name + ' cashed out $' + r.amount.toFixed(2) + ' to Greenlight.');

    await Promise.all(['john', 'dawn'].map(p => sendToPerson(p, title, body, 'bridge/')));
    return null;
  });

// Ship Account — notify the boy once a parent marks the transfer/delivery done
exports.notifyShipAccountResolved = functions.database
  .ref('/stewart/shipAccount/{agentId}/register/{regId}')
  .onUpdate(async (change, context) => {
    const before = change.before.val();
    const after = change.after.val();
    if (!after || before.status !== 'pending') return null;
    if (after.status !== 'complete' && after.status !== 'denied') return null;
    if (await alreadyNotified('saresolved_' + context.params.agentId + '_' + context.params.regId)) return null;

    const agentId = context.params.agentId;
    let title, body;
    if (after.status === 'denied') {
      title = 'Ship Account Request Denied';
      body = 'Your $' + after.amount.toFixed(2) + ' ' + (after.type === 'purchase' ? 'purchase' : 'cash out') + ' was denied — the money is back in your Ship Account.';
    } else {
      title = after.type === 'purchase' ? 'Your Ship\'s Store Order Is Ready!' : 'Money Transferred!';
      body = after.type === 'purchase'
        ? ('Your ' + (after.itemName || 'item') + ' is ready — go check with Dad or Mom.')
        : ('$' + after.amount.toFixed(2) + ' has been moved to your Greenlight card.');
    }

    await sendToPerson(agentId, title, body, 'boys/');
    return null;
  });

// ════════════════════════════════════════════════════
// NextDNS Website Lockdown — unlock on completion
// (nextdns-lockdown-punchlist.md, Step 2)
//
// Each boy's Chromebook DNS points at a NextDNS profile, denylisted to
// Resolute-only by default (Step 1, John's manual NextDNS setup — this
// code never touches that initial deny configuration). The moment the
// relevant boy(s)' morning+lunch missions are ALL done for the day
// (mission-engine.js morningLunchComplete — the single shared definition
// of what "done" means here, confirmed mission-by-mission with John, not
// inferred), the recreation sites move to that profile's allowlist for
// the rest of the day. Nightly reset (Step 3) puts everyone back to
// locked the next morning regardless of what happened the day before.
//
// TEAMS, not four independent devices — real-world constraint discovered
// during setup: only two Chromebooks exist right now (two more are
// coming), and Samuel+John Jr. share one while Stephen+Daniel will share
// the other. ChromeOS's Secure DNS setting is DEVICE-wide, not tied to
// which Google account is signed in — confirmed live (configuring it
// under Samuel's login on the shared Chromebook applied to John Jr.'s
// login too, per NextDNS's own "this device is using another profile"
// banner). So for now, unlocking is a genuine team effort: BOTH teammates
// must finish morning+lunch before their SHARED device's one active
// profile unlocks, and the unlocked list is the union of both boys' own
// domains, so whichever of them is on the shared device that evening can
// reach either boy's approved sites. Mirrors the existing dish-team
// pairing already established elsewhere in this app (mission-engine.js).
// Revisit this once the other two Chromebooks arrive and each boy gets
// his own device — at that point each team can split back into two
// independent single-boy unlocks by just editing this array.
const NEXTDNS_TEAMS = [
  { members: ['samuel', 'johnjr'], profileAgentId: 'samuel' },
  { members: ['stephen', 'daniel'], profileAgentId: 'stephen' }
];
function teamFor(agentId) {
  return NEXTDNS_TEAMS.find(t => t.members.includes(agentId)) || null;
}
function teamRecreationDomains(team) {
  const set = new Set();
  team.members.forEach(id => (NEXTDNS_RECREATION_DOMAINS[id] || []).forEach(d => set.add(d)));
  return [...set];
}

// CONFIG — fill in before this can actually call NextDNS. Profile IDs are
// data, not something to hardcode inline into the trigger logic below, so
// a profile change later is a one-line edit here, not a code change. All
// four are kept (not just the two teams currently use) so this is ready
// to go the moment the other two Chromebooks arrive and NEXTDNS_TEAMS
// above splits back into four independent entries.
// NEXTDNS_API_KEY is a Cloud Functions secret (same pattern as
// ANTHROPIC_API_KEY), never committed to source.
const NEXTDNS_PROFILE_IDS = {
  samuel: 'f4d5a2',
  johnjr: '1e7d2d',
  stephen: 'cc245e',
  daniel: '14f911'
};

// The recreation/allowed-sites list (NEXTDNS_RECREATION_DOMAINS) is
// required at the top of this file from nextdns-config.js — shared with
// the client (a boy can see the real list of sites that unlock for him on
// his own HQ page) via the same copy-on-predeploy pattern as
// mission-engine.js, one definition instead of a duplicate that could
// drift between what's shown and what actually unlocks.

// POST adds to the list with the domain in the BODY, against the bare
// list URL. DELETE is the opposite shape — domain in the URL PATH, no
// body at all. Live-verified against the real NextDNS API: DELETE with
// the domain in the body (matching POST's shape) returned 404/"notFound"
// and silently deleted nothing — caught by the caller's own .catch(), so
// it never crashed anything, but it also never actually cleaned up a
// denylist entry. The real API wants the shape below. Also confirmed live
// that this doesn't block the unlock itself either way — NextDNS's own
// docs ("Allowing takes precedence over everything else, including
// security features") hold up under testing: the allowlist POST alone
// unlocks regardless of the denylist DELETE's outcome.
async function nextDnsRequest(method, profileId, listType, domain) {
  const apiKey = process.env.NEXTDNS_API_KEY;
  const url = method === 'DELETE'
    ? `https://api.nextdns.io/profiles/${profileId}/${listType}/${encodeURIComponent(domain)}`
    : `https://api.nextdns.io/profiles/${profileId}/${listType}`;
  const resp = await fetch(url, {
    method,
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({ id: domain, active: true }) } : {})
  });
  if (!resp.ok) {
    throw new Error(`NextDNS ${method} ${listType} (${domain}) failed: ${resp.status} ${await resp.text()}`);
  }
}

// Returns true only if the unlock actually happened — the caller uses
// this to decide whether it's honest to record stewart/nextdnsUnlock as
// unlocked:true. Returning true from a no-op (missing profile ID) would
// let that status node claim sites are unlocked when nothing actually
// changed at NextDNS, AND would block any future retry once a profile ID
// does get configured, since the idempotency check above would see the
// day as already "handled."
async function unlockRecreationSites(profileAgentId, domains) {
  const profileId = NEXTDNS_PROFILE_IDS[profileAgentId];
  if (!profileId) {
    console.error(`nextdns: no profile ID configured for ${profileAgentId} — cannot unlock. Fails safe (stays locked), does not throw.`);
    return false;
  }
  for (const domain of domains) {
    await nextDnsRequest('DELETE', profileId, 'denylist', domain).catch(e => console.error('nextdns denylist delete failed:', e.message));
    await nextDnsRequest('POST', profileId, 'allowlist', domain).catch(e => console.error('nextdns allowlist add failed:', e.message));
  }
  return true;
}

// Fires on every write to any mission checkbox for any boy on any date —
// onWrite (not onCreate) because unchecking a box is a DELETE in RTDB
// (toggleMission sets the value to null), and re-checking it is a fresh
// CREATE; either direction needs a fresh completion check.
exports.checkNextDnsUnlock = functions
  .runWith({ secrets: ['NEXTDNS_API_KEY'] })
  .database.ref('/stewart/missions/{agentId}/{date}/{missionId}')
  .onWrite(async (change, context) => {
    const { agentId, date } = context.params;
    if (!ALLOWED_AGENT_IDS.includes(agentId)) return null;
    // Only ever act on a write to TODAY's missions — correcting a past
    // day's checkbox (a parent fixing a mistake) must never trigger a
    // real-time unlock call; that day is already over.
    if (date !== easternDateStr()) return null;

    const team = teamFor(agentId);
    if (!team) return null;

    // BOTH teammates must be done — a shared-device unlock is a joint
    // accomplishment, not "whichever brother finishes first carries the
    // other." Re-checks every team member's data on every single write
    // (not just the boy whose checkbox just changed), since either boy
    // finishing last is what should trigger the unlock.
    const doneMaps = await Promise.all(team.members.map(id =>
      db.ref(`stewart/missions/${id}/${date}`).once('value').then(s => s.val() || {})
    ));
    const allComplete = team.members.every((id, i) => morningLunchComplete(id, parseLocalDate(date), doneMaps[i]));
    if (!allComplete) return null;

    // Idempotency — once unlocked, stays unlocked for the day regardless
    // of what else happens (Behavior section: "the unlock persists for
    // the rest of that day"). Checked against the FIRST team member's own
    // status node — both members' nodes are always written together
    // below, so checking one is checking the pair. Never re-call NextDNS
    // for a day already marked unlocked, and never re-lock mid-day if
    // something later gets unchecked — only the nightly reset re-locks.
    const statusRef = db.ref(`stewart/nextdnsUnlock/${team.members[0]}/${date}`);
    const statusSnap = await statusRef.once('value');
    if (statusSnap.val() && statusSnap.val().unlocked) return null;

    const unlocked = await unlockRecreationSites(team.profileAgentId, teamRecreationDomains(team));
    if (!unlocked) return null; // no profile configured yet — stay silent, don't record a false unlocked status
    // Written to EACH team member's own path (not just the profile
    // owner's) so boys/index.html's Recreation Sites card — which reads
    // stewart/nextdnsUnlock/{currentAgent.id}/{date} — shows the correct
    // unlocked status for both boys, not just whichever one owns the
    // shared device's profile.
    const payload = { unlocked: true, unlockedAt: Date.now() };
    await Promise.all(team.members.map(id => db.ref(`stewart/nextdnsUnlock/${id}/${date}`).set(payload)));
    return null;
  });

// Step 3: nightly reset — re-locks every team back to Resolute-only at
// midnight Eastern, regardless of whether they unlocked the day before.
// Reverse of unlockRecreationSites: DELETE from allowlist, POST back to
// denylist. Runs unconditionally for every team with a configured
// profile — a team that never unlocked that day has nothing to undo, but
// re-denylisting an already-denylisted domain (or un-allowlisting an
// already-absent one) is a harmless no-op at the NextDNS API level, not
// an error condition. Iterates over TEAMS (currently 2), not over all
// four boys individually — Samuel and John Jr. share one profile right
// now, so relocking per-boy would just issue the same API calls twice.
async function relockRecreationSites(profileAgentId, domains) {
  const profileId = NEXTDNS_PROFILE_IDS[profileAgentId];
  if (!profileId) return;
  for (const domain of domains) {
    await nextDnsRequest('DELETE', profileId, 'allowlist', domain).catch(e => console.error('nextdns allowlist delete failed:', e.message));
    await nextDnsRequest('POST', profileId, 'denylist', domain).catch(e => console.error('nextdns denylist add failed:', e.message));
  }
}

exports.nightlyNextDnsReset = functions
  .runWith({ secrets: ['NEXTDNS_API_KEY'] })
  .pubsub.schedule('0 0 * * *')
  .timeZone('America/New_York')
  .onRun(async () => {
    // Per-team try/catch so one team's NextDNS failure never blocks the
    // other team from being re-locked — same pattern as detectJournalPatterns.
    for (const team of NEXTDNS_TEAMS) {
      try {
        await relockRecreationSites(team.profileAgentId, teamRecreationDomains(team));
      } catch (e) {
        console.error('nightlyNextDnsReset failed for team', team.members.join('+'), e);
      }
    }
    return null;
  });

// ════════════════════════════════════════════════════
// Hans — AI-generated encouragement lines
// ════════════════════════════════════════════════════
const HANS_SYSTEM_PROMPT = `You are Hans, the good-hearted, self-deprecating "evil scientist" HQ handler for a family chore-tracking app used by kids. Your voice is Gimmelshtump/Doofenshmirtz-style: a failed, silly villain who is actually warm, encouraging, and rooting hard for the kid ("Agent") he's talking to.

Rules for every line you write:
- Always invent a FRESH, silly, self-deprecating backstory joke about your ridiculous villain past (Gimmelshtump, a failed evil scheme, an absurd childhood mishap, a doomed invention, etc.). Never reuse a joke you'd expect to have used before — invent something new each time.
- NEVER mention the Agent's siblings, compare the Agent to anyone else, or reference discipline, punishment, grounding, or being "in trouble." Those topics are off-limits, full stop.
- Tone is silly and theatrical but never actually mean, sarcastic AT the Agent, or discouraging. You are always on the Agent's side.
- Address the Agent by name at least once.
- Write exactly 2-3 sentences. No markdown, no lists, no emoji, no quotation marks around the whole thing.
- Stay in character as Hans at all times.`;

function buildHansUserPrompt({ triggerType, agentName, completed, total, missionNames, deductionReason, streak, contextNote }) {
  const lines = [`Trigger: ${triggerType}`, `Agent name: ${agentName}`];
  if (typeof completed === 'number' && typeof total === 'number') {
    lines.push(`Missions completed: ${completed} of ${total}`);
  }
  if (Array.isArray(missionNames) && missionNames.length) {
    lines.push(`Missions still remaining: ${missionNames.join(', ')}`);
  }
  if (deductionReason) {
    lines.push(`A behavior deduction was logged today: ${deductionReason}`);
  }
  if (typeof streak === 'number' && streak > 0) {
    lines.push(`Current streak of good days in a row: ${streak}`);
  }
  // Plain-fact context for newer trigger types (session-timer-punchlist.md,
  // Steps 3/3b: sessionEnd, missedSession, efficiency) — a factual note the
  // client already knows to be true, not an instruction on tone (the system
  // prompt's rules already cover tone for every trigger).
  if (contextNote) {
    lines.push(contextNote);
  }
  lines.push('Write one Hans line for this exact moment.');
  return lines.join('\n');
}

// Generates one fresh Hans line for the given moment in a boy's day.
// Called from the client (boys/index.html) in place of the static
// HANS_LINES pools — the client falls back to those pools on any error.
exports.generateHansLine = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onCall(async (data, context) => {
    const { triggerType, agentName, completed, total, missionNames, deductionReason, streak, contextNote } = data || {};
    if (!triggerType || !agentName) {
      throw new functions.https.HttpsError('invalid-argument', 'triggerType and agentName are required.');
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: HANS_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: buildHansUserPrompt({ triggerType, agentName, completed, total, missionNames, deductionReason, streak, contextNote })
      }]
    });

    const text = (response.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    if (!text) {
      throw new functions.https.HttpsError('internal', 'No text returned from Anthropic.');
    }

    return { text };
  });

// ════════════════════════════════════════════════════
// Tink — Dawn's plain-spoken AI assistant (parent side)
// ════════════════════════════════════════════════════
const TINK_SYSTEM_PROMPT = `You are a helpful assistant for Dawn, running the parent-facing side of HMS Resolute, a family chore-tracking app. Answer directly and practically. If you don't have real data to answer a lookup question, say so rather than guessing.

You have no persona or character — just answer plainly and helpfully, like a knowledgeable assistant would.

Here is what actually exists in HMS Resolute today. Never invent functionality beyond this:

**Chores and points (core mechanic):** Each boy has a daily mission checklist (weekdays only). 100 points = $1.00 = 6 minutes of game time per day. Only Monday-Friday performance is scored — weekends never score, though chores still happen; weekend performance is tracked separately as "Damage Control," not points. Computer missions (typing, coding lessons, Khan Academy, research) are bonus-only and do not count toward pay or game time. Daily score can be adjusted by a transfer credit (covering a sibling's dish duty) and by behavior deductions, each moving the score between 0 and 100. The same completion percentage also grants 1-3 daily "wishes" (1/3 complete = 1, 2/3 = 2, full = 3), usable starting the next day, which spend on Tom (see below).

**Dawn's dashboard ("Officers' Country"), tabs:**
- Ship's Watch (overview): agent status gauges, weekly pay summary, Family Night status, Super Family Night dashboard, Field Library reading summary, per-boy reading goals.
- Rounds (missions): print today's chore chart, per-agent mission status detail, full week chore grid.
- Mess Call (lunch): weekly lunch options per day with quantities, and what each boy picked.
- Comms (messenger): private 1:1 threads with each boy, a Family Channel group chat, and the ability to pause a boy's chat.
- XO's Quarters: White Glove room inspections (Morning/Afternoon/Evening; four compartments — Kitchen, Living Room, Bathroom, Bedrooms — each rated across five categories as Clear/Not Clear, with a responsible boy assigned; oversight/accountability only, doesn't directly dock points), a Devotional Wishes suggestion box, homestead task lists, The Grace Dare devotional, Family Devotional input, Dawn's personal devotional, and a static Weekly Rhythm reference (laundry/trash/deep-clean schedule).
- Ship's Log (growth): Art of Parenting 8-session tracker, weekly application notes, a reflection log, the "20 Character Qualities to Pray For" list, per-boy notes.
- Drydock (projects): Family Night Activity bank, a Teach Me session list with vote management, House/Exterior project trackers, a Stone Collection log, and a Super Family Night progress tracker. You can propose setting tonight's Family Night activity (from the real activity bank) and, once Super Family Night is actually unlocked by the family's performance average, propose saving its takeout/activity plan — but you can't write either yourself, and you'd never propose unlocking it early, since that's earned, not something you or a parent can just grant.
- Tink: this chat.

**Agent HQ (the boys' app), tabs:**
- Rations: tonight's meal plan plus the weekly meal schedule.
- Lunch: pick a lunch option from the day's pool, first-come-first-served.
- Missions: the daily chore checklist tied to pay/screen time.
- HQ (transmissions): parent broadcast messages, an always-on group chat with all four boys and parents, and a private thread to Mom & Dad.
- Training: The Courage Dare devotional, a 5-question private daily reflection form, and the Teach Me Vote.
- Pay: weekly pay breakdown ($5/wk max, weekdays only), Super Family Night status.
- Xbox: Xbox Game Time bank (from missions % + reading, capped 45 min/wk), Field Library reading log.
- Compass: Tom, a live AI companion for the boys (built and deployed). Boys spend earned wishes to ask Tom interest/discovery, learning, or devotional questions (devotional answers cite a real KJV verse); app-help questions about the app itself are always free. Off-topic, sibling, discipline, and rule-bypass questions are declined in-voice, no wish spent. Each boy has a $1/month Anthropic budget cap; over the cap, wish-spend questions decline gracefully but app-help keeps working. If Tom suggests a website, it queues for parent approval the same way screen-time and Ship Account requests do.
- Also linked from Agent HQ: Ship's Store (spend Ship Account balance on real prizes — currently a Chromebook contest), a Crew Deck Map, a read-only recipe browser, and an in-app Help page documenting all boys'-side mechanics.

**The Galley (kitchen app):** a meal-readiness engine (not AI) with Meals (recipe browser), Planner (weekly plan generator with cook-time alerts and iCal export), Chains (tracks meals that reuse a protein/leftover), Pantry (inventory with low-stock flags), Shop (shopping list synced to low stock), Health (nutrition notes), and a parent-facing Dashboard view. On a pantry/recipe/meal-plan question, you're given real current inventory, the real saved meal plan, and every known meal scored for readiness against that inventory (same scoring the Galley's own engine uses) as a "Real data from the database" section — answer from those real numbers, never invent what's in stock or guess a readiness percentage. You can propose adding a specific meal to a specific day of the plan, and propose adding specific items to the shopping list, but you can't write either yourself — a proposal only becomes real once Dawn or John taps an explicit Confirm button in the app.

**Bridge (Dad's command post):** Helm (today's focus, 7-day cycle, crew walkthrough status), Comms (private threads, family chat, moderation, Ship Account transfer approvals, Screen Time cash-out approvals), Instruments (per-crew gauges, Ship Accounts, a status board, weekly chore-log grid), Saga (writes Adamah Saga chapters and each boy's private Log story), Word (writes the weekly Family Devotional — scripture, narrative, discussion question, prayer prompt).

**War Room:** family members submit prayer requests to a daily prayer sheet. Parent submissions go active immediately; kids' submissions queue for officer review. Answered prayers move to a permanent "Wall of Valor" record.

**Crow's Nest:** a simple praise/gratitude log — anyone logs something they saw God do, and a feed shows the last 100 entries from the whole family.

**Wardroom (Saga):** a reading area for two story tracks — The Adamah Saga (PIN-locked, family-wide) and each boy's private Log — both authored from the Bridge, boys only read.

**The Vineyard ("Captain's Quarters"):** PIN-locked, parents-only. Together (daily spiritual/health toggles plus shared notes), Dates (date-night invitations and planning), Cellar (a random date-night picker, a date-night designer, a saved-night library with post-date reviews), Between Us (a private status/message thread and a gentle space to flag small relational concerns early).

**Ship's Registry:** officer-only. Muster Roll (login/activity log with irregularity flags), ID Cards (printable crew IDs), Credentials (change the shared crew PIN or officer passwords).

**Gangway:** the login/landing page linking to all of the above, plus first-run setup and "assist a crew member" (logging in as a boy).

If a boy-lookup question doesn't clearly specify which boy or which date range, ask for clarification rather than guessing. If a question is outside the scope of what HMS Resolute actually does, say so plainly instead of making something up.

When a message includes a "Real data from the database" section, that is ground truth pulled directly from the app — answer using only those numbers, and don't invent additional data points or assume data exists for dates not listed there.`;

const ALLOWED_AGENT_IDS = ['samuel', 'johnjr', 'stephen', 'daniel'];
const AGENT_DISPLAY_NAMES = { samuel: 'Samuel', johnjr: 'John Jr.', stephen: 'Stephen', daniel: 'Daniel' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LOOKUP_DAYS = 31; // bounds RTDB reads for a date-range lookup

function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // noon UTC avoids DST/day-boundary drift
}
function formatDateStr(d) {
  return d.toISOString().slice(0, 10);
}

// The family's real timezone. Every boy-facing client already keys dates
// by LOCAL time (mission-engine.js's localDateStr() uses the device's own
// clock), but server-side "what day is it" checks used to go through
// formatDateStr(new Date()), which is always UTC — a real mismatch near
// midnight Eastern (a strike, a wish spend, a Courage Dare completion, or
// a scheduled run near that boundary could land on what the server called
// a different day than the boy's own app would show). formatDateStr
// itself stays UTC-based on purpose — it's used for pure calendar-date
// ARITHMETIC (dateRange, parseDateStr round-tripping) on strings that are
// already correct, not for converting a real moment in time. Use
// easternDateStr() specifically wherever "now" or "what day did this
// timestamp happen on" is the actual question being asked.
const FAMILY_TIMEZONE = 'America/New_York';
function easternDateStr(date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: FAMILY_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const da = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${da}`;
}
// Same idea for a YYYY-MM month key (the budget cap's rollover unit).
function easternMonthStr(date) {
  return easternDateStr(date).slice(0, 7);
}

// Inclusive list of YYYY-MM-DD strings from startStr to endStr, capped at maxDays.
function dateRange(startStr, endStr, maxDays) {
  const start = parseDateStr(startStr);
  const end = parseDateStr(endStr);
  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end && dates.length < maxDays) {
    dates.push(formatDateStr(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

// Reads real score + deduction data for one boy across the given dates.
async function fetchLookupData(agentId, dates) {
  return Promise.all(dates.map(date =>
    Promise.all([
      db.ref(`stewart/scores/${agentId}/${date}`).once('value'),
      db.ref(`stewart/deductions/${agentId}/${date}`).once('value')
    ]).then(([scoreSnap, dedSnap]) => {
      const score = scoreSnap.val();
      const deductions = dedSnap.val() || {};
      return {
        date,
        score,
        deductionTotal: Object.values(deductions).reduce((a, b) => a + b, 0),
        deductionReasons: Object.keys(deductions)
      };
    })
  ));
}

// ── Pantry/recipe grounding for askTink ──
// kitchen/index.html's "Ask Tink" recipe-builder box already computes real
// mealReadiness() scores CLIENT-SIDE and passes them in as explicit
// `context` — that path was already working. What was never built is the
// general case: Dawn asking a pantry/recipe question from her own
// dashboard Tink chat (askTinkDashboard, which sends no context at all),
// where askTink had no way to see stewart/inventory or stewart/plan on
// its own — exactly the gap this closes.
//
// ingTokens/haveIngredient/inStockNames/mealReadiness are a faithful port
// of the real, non-AI matching logic kitchen/index.html itself scores
// readiness with — not a reimplementation from scratch, and not an LLM
// guess. MEALS_DB (functions/meals.json) is a minimal {id, name,
// ingredients} copy of kitchen/index.html's MEALS array, same duplication
// pattern as KJV above (kitchen/index.html is a separate, unbundled app
// Cloud Functions can't reach). Keep both the scoring logic and
// meals.json in sync with kitchen/index.html if either ever changes.
const MEALS_DB = require('./meals.json');
const ING_STOPWORDS = ['fresh', 'frozen', 'canned', 'can', 'cans', 'box', 'boxes', 'bag', 'bags', 'jar', 'jars', 'lb', 'lbs', 'oz', 'cup', 'cups', 'tbsp', 'tsp', 'pkg', 'pkgs', 'package', 'pieces', 'piece', 'cloves', 'clove', 'diced', 'chopped', 'sliced', 'minced', 'crushed', 'ground', 'small', 'medium', 'large', 'leftover', 'cooked', 'optional', 'divided', 'thawed', 'drained', 'to', 'of', 'the', 'for', 'and', 'or', 'a', 'an', 'with', 'about', 'approx', 'retain', 'juice', 'each', 'head', 'heads', 'bunch', 'stick', 'sticks', 'container', 'bottle', 'bottles', 'pkt', 'pkts', 'count', 'dash', 'pinch', 'taste'];

function ingTokens(str) {
  return String(str).toLowerCase()
    .replace(/[0-9]+([./][0-9]+)?/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !ING_STOPWORDS.includes(w));
}

function haveIngredient(ingStr, invNames) {
  const tokens = ingTokens(ingStr);
  if (!tokens.length) return true; // pure seasoning/water etc -- assume on hand
  return invNames.some(inv => {
    const invToks = ingTokens(inv);
    return tokens.some(t => invToks.some(it => it === t || (t.length > 4 && it.includes(t)) || (it.length > 4 && t.includes(it))));
  });
}

function inStockNames(inventory) {
  const sections = ['freezer', 'pantry', 'fridge'];
  const all = sections.reduce((acc, s) => acc.concat(inventory[s] || []), []);
  return all.filter(i => (i.qty || 0) > 0).map(i => i.name);
}

function mealReadiness(meal, invNames) {
  if (!meal.ingredients || !meal.ingredients.length) return { pct: 100, have: 0, total: 0, missing: [] };
  let have = 0;
  const missing = [];
  meal.ingredients.forEach(ing => {
    if (haveIngredient(ing, invNames)) have++;
    else missing.push(ing);
  });
  const total = meal.ingredients.length;
  return { pct: Math.round((have / total) * 100), have, total, missing };
}

const PANTRY_KEYWORD_PATTERN = /\b(recipe|recipes|meal|meals|dinner|breakfast|lunch|cook|cooking|pantry|inventory|ingredient|ingredients|stock|shopping|grocery|groceries|fridge|freezer|leftover|leftovers|meal\s*plan|planner)\b/i;
function mightBePantryQuestion(question, history) {
  const recentText = [question, ...(history || []).slice(-4).map(h => h.content)].join(' ');
  return PANTRY_KEYWORD_PATTERN.test(recentText);
}

// Tier 1 write-capable action (tink-write-boundary-spec.md): family night
// scheduling. Separate gate from pantry — a different topic entirely —
// so it doesn't pay the structured-output cost on every recipe question.
const FAMILY_NIGHT_KEYWORD_PATTERN = /\b(family\s*night|super\s*family\s*night|campfire|game\s*night|movie\s*night|board\s*game|activity\s*bank|barn\s*night|stargazing)\b/i;
function mightBeFamilyNightQuestion(question, history) {
  const recentText = [question, ...(history || []).slice(-4).map(h => h.content)].join(' ');
  return FAMILY_NIGHT_KEYWORD_PATTERN.test(recentText);
}

// Step 4 (Family Bible punch list): "suggest a verse about X," "what
// does the Bible say about Y." Deliberately narrower than a generic
// "mentions Scripture" check — a question like "how should I talk to
// Samuel about honesty" is devotional-adjacent but isn't asking Tink to
// hand back a citable verse, so it shouldn't pay the structured-output
// cost or risk of this path.
const VERSE_SUGGEST_PATTERN = /\b(suggest(?:s|ed|ing)?\s+(?:a\s+|some\s+)?verse|verse(?:s)?\s+(?:about|on|for)|what\s+does\s+the\s+bible\s+say|bible\s+say\s+about|scripture\s+(?:about|on)|find\s+(?:me\s+)?a\s+verse)\b/i;
function mightBeVerseSuggestionQuestion(question, history) {
  const recentText = [question, ...(history || []).slice(-4).map(h => h.content)].join(' ');
  return VERSE_SUGGEST_PATTERN.test(recentText);
}

const TINK_VERSE_SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    verseRef: { type: 'string' }
  },
  required: ['message', 'verseRef'],
  additionalProperties: false
};

// Reuses Tom's exact citation-formatting approach (askTom, further
// below): the model itself never quotes a verse's actual wording — it
// only names a reference — and the server inserts the REAL, verified
// text afterward via lookupVerse. That's what keeps a citation from ever
// being a hallucinated paraphrase. Appended to TINK_SYSTEM_PROMPT only
// for the specific call where mightBeVerseSuggestionQuestion gated in;
// every other Tink question is untouched by any of this.
const TINK_VERSE_SUGGEST_INSTRUCTIONS = `

This question is a verse-suggestion request — pointing Dawn or John to a real Bible verse on a topic ("suggest a verse about patience," "what does the Bible say about anger"). For this answer specifically: don't quote or paraphrase a verse's exact wording yourself — the system inserts the real, verified verse text after your message, so write your answer as if a citation naturally follows it. Set "verseRef" to exactly ONE verse (never a range like "5:43-44") in "Book Chapter:Verse" format (e.g. "James 1:19", "Proverbs 15:1") — only ever a verse you're confident actually exists. If, on reflection, this particular message isn't really asking for a citable verse after all, leave "verseRef" as an empty string and just answer the actual question normally.`;
// Real stewart/inventory + stewart/plan, plus every meal in MEALS_DB
// scored for readiness against current stock (sorted best-first) — so
// Tink can answer "what can I make tonight" or "are we ready for X"
// with the same real numbers the Galley's own readiness engine would
// show, not a guess.
async function fetchPantryGrounding() {
  const [invSnap, planSnap] = await Promise.all([
    db.ref('stewart/inventory').once('value'),
    db.ref('stewart/plan').once('value')
  ]);
  const inventory = invSnap.val() || { freezer: [], pantry: [], fridge: [] };
  const plan = Array.isArray(planSnap.val()) ? planSnap.val() : [];
  const invNames = inStockNames(inventory);

  const invLines = ['freezer', 'pantry', 'fridge'].map(sec => {
    const items = inventory[sec] || [];
    if (!items.length) return `${sec.toUpperCase()}: (empty)`;
    const itemLines = items.map(i => `${i.name} — ${i.qty} ${i.unit}${i.qty <= (i.low || 0) ? ' (LOW/OUT)' : ''}`);
    return `${sec.toUpperCase()}:\n  ${itemLines.join('\n  ')}`;
  }).join('\n\n');

  const planLines = plan.length
    ? plan.map(p => p.noMeal
      ? `${p.day} ${p.type}: no meal planned`
      : `${p.day} ${p.type}: ${p.mealName || p.label || '(unnamed)'}${p.sides ? ' — sides: ' + p.sides : ''}`
    ).join('\n')
    : '(no meal plan currently saved)';

  const readinessLines = MEALS_DB
    .map(m => ({ name: m.name, ...mealReadiness(m, invNames) }))
    .sort((a, b) => b.pct - a.pct)
    .map(r => `${r.name}: ${r.pct}% ready (${r.have}/${r.total} ingredients on hand)${r.missing.length ? ' — missing: ' + r.missing.join(', ') : ''}`)
    .join('\n');

  return `Real data from the database — current pantry inventory (stewart/inventory):\n${invLines}\n\nCurrent meal plan (stewart/plan):\n${planLines}\n\nEvery known meal scored for readiness against current inventory, best-first — same scoring the Galley kitchen app's own readiness engine uses (% of that meal's ingredients you have on hand right now):\n${readinessLines}`;
}

// Real, valid stewart/plan day keys — Kitchen's own plan entries are
// always keyed by a day name (never a calendar date). Checked before
// trusting a proposed write's "planDay" — a proposal that doesn't match
// one of these is silently dropped rather than handed to the client.
const VALID_PLAN_DAYS = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

// Covers both of the write-boundary spec's kitchen-side Tier 1 actions
// (meal plan + shopping list) in one schema, since both share the same
// isPantryQuestion gate and call — no reason to pay for two Sonnet calls
// when one message ("add tacos to Tuesday and put sour cream on the
// list") can plausibly confirm both at once.
const TINK_PLAN_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    proposeAddToPlan: { type: 'boolean' },
    planDay: { type: 'string' },
    planType: { type: 'string' },
    planMealName: { type: 'string' },
    planSides: { type: 'string' },
    proposeAddToShopping: { type: 'boolean' },
    shoppingItems: { type: 'array', items: { type: 'string' } }
  },
  required: ['message', 'proposeAddToPlan', 'planDay', 'planType', 'planMealName', 'planSides', 'proposeAddToShopping', 'shoppingItems'],
  additionalProperties: false
};

// Tier 1 write-capable actions (tink-write-boundary-spec.md): informational/
// logistical, confirm-before-write. Tink never touches stewart/plan or
// stewart/shopping herself — this only ever produces a PROPOSAL the server
// hands back to the client; the actual read-modify-write happens
// client-side (same place Kitchen's own savePlan()/saveShop() already
// write these paths from), and only after Dawn or John taps an explicit
// Confirm button — same trust boundary as Tom's wish-spend confirm on the
// boys' side. Appended to TINK_SYSTEM_PROMPT only for the pantry-question
// call path — every other Tink question is completely untouched by this.
const TINK_PLAN_ACTION_INSTRUCTIONS = `

You can propose adding a meal to the weekly meal plan (stewart/plan) — but you can't write to it yourself. A proposal only becomes real once Dawn or John taps an explicit Confirm button in the app; nothing is saved just because you said it. Set "proposeAddToPlan" to true ONLY when their MOST RECENT message is a clear, explicit confirmation that one specific meal should go on one specific day — e.g. "yes, add that to Tuesday," "let's do that," "sounds good, put it on the plan," "add Chicken Tacos to Wednesday."

Do NOT propose just because a meal was mentioned, suggested, or discussed. Brainstorming options, answering "what could we make," or them asking a question about a meal are NOT confirmations — keep proposeAddToPlan false and just answer normally in that case. If it's genuinely ambiguous whether they're confirming or still deciding, don't propose — ask a clarifying question in "message" instead.

When you DO propose: "planDay" must be exactly one of Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday — resolve relative references ("tomorrow," "tonight") against today's date. "planType" should be "Family" unless they specifically said the boys are cooking that day, in which case "Boys Cook". "planMealName" is the specific meal being added — never leave it vague ("dinner," "something") when proposing; if you don't know a specific enough name yet, don't propose, ask what to call it instead. "planSides" is optional — leave it an empty string if nothing was mentioned.

If proposeAddToPlan is false, leave planDay/planType/planMealName/planSides all as empty strings.

You can also propose adding items to the shopping list (stewart/shopping) — same rule: only on a clear, explicit confirmation, e.g. "yes add milk," "put eggs and bacon on the list," "we need more butter, add it." Set "proposeAddToShopping" true and list each item as its own short string in "shoppingItems" (e.g. ["milk", "eggs"]) — a quantity or brief note is fine within one item's string ("2 gallons of milk") but don't bundle multiple items into one string. Don't propose just because an ingredient was mentioned while discussing a recipe — only on an actual request to add it to the list.

If proposeAddToShopping is false, leave shoppingItems as an empty array.`;

// Mirror of dashboard/index.html's FAMILY_NIGHT_ACTIVITIES — id+label only
// (the client already has the full catalog with icon/venue/desc loaded, so
// the server only needs enough to validate a proposed id and describe the
// options to the model). Same duplication caveat as MEALS_DB/KJV: keep in
// sync with dashboard/index.html if that catalog ever changes.
const FAMILY_NIGHT_ACTIVITY_CATALOG = [
  { id: 'campfire', label: 'Campfire Night' },
  { id: 'stargazing', label: 'Stargazing' },
  { id: 'grill-night', label: 'Grill Night' },
  { id: 'campfire-stories', label: 'Storytelling Night' },
  { id: 'night-games', label: 'Night Games' },
  { id: 'firepit-devotional', label: 'Fire Pit Devotional' },
  { id: 'barn-games', label: 'Barn Game Night' },
  { id: 'teach-tools', label: 'Tool School' },
  { id: 'build-something', label: 'Build Something Small' },
  { id: 'bike-maintenance', label: 'Bike Maintenance Day' },
  { id: 'car-basics', label: 'Car Basics Session' },
  { id: 'barn-cookout', label: 'Barn Cookout' },
  { id: 'board-games', label: 'Board Game Night' },
  { id: 'movie-popcorn', label: 'Movie & Popcorn' },
  { id: 'cook-together', label: 'Cook Something Together' },
  { id: 'reading-night', label: 'Reading Night' },
  { id: 'map-night', label: 'Map & Navigation Night' },
  { id: 'stone-collection', label: 'Stone Collection Run' },
  { id: 'planting-day', label: 'Planting Day' },
  { id: 'path-work', label: 'Path Work Session' },
  { id: 'yard-cleanup', label: 'Full Yard Cleanup' }
];
const VALID_FAMILY_NIGHT_ACTIVITY_IDS = new Set(FAMILY_NIGHT_ACTIVITY_CATALOG.map(a => a.id));

// Real tonight's-activity + Super Family Night state, so Tink knows
// whether something's already scheduled and — critically — whether Super
// Family Night is actually unlocked before ever proposing a plan for it.
// Returns { text, unlocked } — the handler uses `unlocked` as a second,
// server-side gate on top of the prompt instruction below, the same
// belt-and-suspenders pattern as VALID_PLAN_DAYS.
async function fetchFamilyNightGrounding(todayStr) {
  const monthKey = todayStr.slice(0, 7);
  const [activitySnap, sfnSnap] = await Promise.all([
    db.ref(`stewart/familynight/activities/${todayStr}`).once('value'),
    db.ref(`stewart/superfamilynight/${monthKey}`).once('value')
  ]);
  const activity = activitySnap.val();
  const sfn = sfnSnap.val() || {};
  const activityLine = activity
    ? `Tonight (${todayStr}) already has a family night activity set: ${activity.label}.`
    : `No family night activity is set for tonight (${todayStr}) yet.`;
  const sfnLine = sfn.unlocked
    ? `Super Family Night is UNLOCKED this month — current plan: ${sfn.food ? 'food: ' + sfn.food : '(no food chosen yet)'}, ${sfn.activity ? 'activity: ' + sfn.activity : '(no activity chosen yet)'}.`
    : `Super Family Night is NOT unlocked yet this month — it unlocks automatically once the family's weekly performance average hits 80%. Never propose a Super Family Night plan while it's locked; that's earned, not something to offer early.`;
  return {
    text: `Real data from the database — family night status:\n${activityLine}\n${sfnLine}`,
    unlocked: !!sfn.unlocked
  };
}

const TINK_FAMILY_NIGHT_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    proposeFamilyNightActivity: { type: 'boolean' },
    familyNightActivityId: { type: 'string' },
    proposeSuperFamilyNightPlan: { type: 'boolean' },
    superFamilyNightFood: { type: 'string' },
    superFamilyNightActivity: { type: 'string' }
  },
  required: ['message', 'proposeFamilyNightActivity', 'familyNightActivityId', 'proposeSuperFamilyNightPlan', 'superFamilyNightFood', 'superFamilyNightActivity'],
  additionalProperties: false
};

// Tier 1 write-capable action: family night scheduling. Same confirm-
// before-write boundary as the plan/shopping actions above — Tink only
// ever proposes; the client performs the actual write after an explicit
// Confirm tap. Appended to TINK_SYSTEM_PROMPT only for the family-night
// call path.
const TINK_FAMILY_NIGHT_INSTRUCTIONS = `

You can propose setting tonight's Family Night activity (stewart/familynight/activities) — but you can't write it yourself. A proposal only becomes real once Dawn or John taps an explicit Confirm button. Set "proposeFamilyNightActivity" to true ONLY on a clear, explicit confirmation of ONE specific activity for tonight — e.g. "yes let's do campfire night," "let's do movie and popcorn tonight." Don't propose just because an activity was mentioned or discussed while deciding.

"familyNightActivityId" must be exactly one of these real catalog ids (never invent one, never guess a close match) — id (label): ${FAMILY_NIGHT_ACTIVITY_CATALOG.map(a => `${a.id} (${a.label})`).join(', ')}. If what they want doesn't clearly match one of these, say so honestly and don't propose.

You can also propose saving the Super Family Night takeout/activity plan (stewart/superfamilynight) — but ONLY if the grounding data says it's currently unlocked. If it's locked, never propose this — just explain honestly that it isn't unlocked yet (it unlocks automatically at 80% family average, not something you or they can trigger). When it is unlocked, set "proposeSuperFamilyNightPlan" true only on an explicit confirmation of specific choices, filling in "superFamilyNightFood" and/or "superFamilyNightActivity" (either can be left empty if only one was decided).

If neither applies: leave proposeFamilyNightActivity and proposeSuperFamilyNightPlan false, familyNightActivityId empty, and both superFamilyNight fields empty.`;

function formatLookupData(agentName, rows) {
  const lines = rows.map(r => {
    if (r.score === null || r.score === undefined) {
      return `${r.date}: no score recorded (weekend, or no data for this date)`;
    }
    const dedPart = r.deductionTotal > 0
      ? ` — behavior deductions: -${r.deductionTotal} points (${r.deductionReasons.join(', ')})`
      : '';
    return `${r.date}: score ${r.score}/100${dedPart}`;
  });
  return `Real data from the database for ${agentName}:\n${lines.join('\n')}`;
}

function buildTinkUserPrompt({ question, context, groundedData }) {
  if (groundedData) return `${question}\n\n${groundedData}`;
  if (!context) return question;
  const contextStr = typeof context === 'string' ? context : JSON.stringify(context);
  return `${question}\n\nAdditional context for this question: ${contextStr}`;
}

// Approximate per-token pricing (USD) for the models askTink can use.
// For soft cost tracking only — the Anthropic Console is the source of
// truth for actual spend. Update if models or pricing change.
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { inputPerToken: 1.00 / 1e6, outputPerToken: 5.00 / 1e6 },
  'claude-sonnet-4-6': { inputPerToken: 3.00 / 1e6, outputPerToken: 15.00 / 1e6 }
};

// Logs an approximate cost estimate for one askTink call to dawn_usage/calls
// and bumps a running total at dawn_usage/totalCostUsd. Soft tracking only —
// never blocks or throttles Dawn, just visibility; failures are swallowed so
// a logging hiccup never breaks the actual answer.
async function logTinkUsage(model, usage) {
  const pricing = MODEL_PRICING[model];
  if (!pricing || !usage) return;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const costUsd = (inputTokens * pricing.inputPerToken) + (outputTokens * pricing.outputPerToken);

  try {
    await db.ref('dawn_usage/calls').push({
      model, inputTokens, outputTokens, costUsd,
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
    await db.ref('dawn_usage/totalCostUsd').transaction(current => (current || 0) + costUsd);
  } catch (e) {
    console.error('logTinkUsage failed:', e);
  }
}

const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';
const MAX_HISTORY_ENTRIES = 20; // defense-in-depth cap; the client already keeps this short
const MAX_HISTORY_CHARS = 4000;

// Keeps only well-formed {role, content} turns, bounded in count and length,
// so a caller can't blow up the request with an unbounded history array.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .slice(-MAX_HISTORY_ENTRIES)
    .map(h => ({ role: h.role, content: h.content.slice(0, MAX_HISTORY_CHARS) }));
}

const LOOKUP_INTENT_SCHEMA = {
  type: 'object',
  properties: {
    isBoyLookup: { type: 'boolean', description: "true if Dawn's latest message is asking about a specific boy's chores, points, score, deductions, or performance" },
    agentId: { type: 'string', enum: [...ALLOWED_AGENT_IDS, ''], description: 'which boy the message is about, resolved using the recent conversation if needed; empty string if not identifiable' },
    startDate: { type: 'string', description: 'YYYY-MM-DD start of the relevant date range, resolved against today\'s date; empty string if not determinable' },
    endDate: { type: 'string', description: 'YYYY-MM-DD end of the relevant date range (inclusive); empty string if not determinable' }
  },
  required: ['isBoyLookup', 'agentId', 'startDate', 'endDate'],
  additionalProperties: false
};

const BOY_NAME_PATTERN = /\b(samuel|sam|john\s*jr\.?|johnjr|j\.?j\.?|stephen|steve|daniel|dan|danny)\b/i;
const LOOKUP_KEYWORD_PATTERN = /\b(score|scores|point|points|deduction|deductions|chore|chores|mission|missions|performance|doing|streak|pay|game\s*time|damage\s*control|this\s*week|last\s*week|today|yesterday)\b/i;

// Cheap gate before spending a real API call on intent extraction — only
// worth running when the question (or recent history, for short follow-ups
// like "Stephen") plausibly references a boy or his performance. Skipping
// it for the common case (app-help, recipes, drafting) roughly halves
// askTink's typical latency, which matters on mobile where a longer round
// trip has more chance of the connection dropping mid-request.
function mightBeLookupQuestion(question, history) {
  const recentText = [question, ...(history || []).slice(-4).map(h => h.content)].join(' ');
  return BOY_NAME_PATTERN.test(recentText) || LOOKUP_KEYWORD_PATTERN.test(recentText);
}

function buildIntentExtractionPrompt({ question, history, today }) {
  const lines = [`Today's date is ${today}.`];
  if (history && history.length) {
    lines.push('Recent conversation (oldest first):');
    history.forEach(h => lines.push(`${h.role === 'assistant' ? 'Tink' : 'Dawn'}: ${h.content}`));
  }
  lines.push(`Dawn's latest message: ${question}`);
  return lines.join('\n');
}

// Cheap Haiku pass that figures out whether the current message is a
// boy-lookup question, and if so which boy + date range — resolving
// relative dates ("this week") and short follow-ups ("Stephen, this week")
// against the recent conversation. Only leaves agentId empty when the boy
// genuinely can't be identified even with that context.
async function extractLookupIntent(anthropic, { question, history, today }) {
  const fallback = { isBoyLookup: false, agentId: '', startDate: '', endDate: '' };
  try {
    const response = await anthropic.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 300,
      system: `You extract structured intent from a message directed at a family chore-tracking app assistant. The four boys are Samuel, John Jr. (agentId "johnjr"), Stephen, and Daniel. Resolve relative dates ("today", "yesterday", "this week", "last week") against today's date; weeks run Monday-Sunday. For "this week" (or similar) asked about a boy's performance, end the range at today — don't project into future days that haven't happened yet. Use the recent conversation to resolve short follow-ups (e.g. Tink asked "which boy?" and Dawn replied "Stephen"). If the boy still isn't clear even with that context, leave agentId empty rather than guessing.`,
      output_config: { format: { type: 'json_schema', schema: LOOKUP_INTENT_SCHEMA } },
      messages: [{ role: 'user', content: buildIntentExtractionPrompt({ question, history, today }) }]
    });

    await logTinkUsage(EXTRACTION_MODEL, response.usage);

    const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(text);
    if (!ALLOWED_AGENT_IDS.includes(parsed.agentId)) parsed.agentId = '';
    if (!DATE_RE.test(parsed.startDate)) parsed.startDate = '';
    if (!DATE_RE.test(parsed.endDate)) parsed.endDate = '';
    return parsed;
  } catch (e) {
    console.error('extractLookupIntent failed:', e);
    return fallback;
  }
}

// Answers Dawn's questions about running HMS Resolute, boy lookups, recipe
// help, and general drafting. Plain assistant, no persona. Uses Sonnet 4.6
// when the question resolves to a data-lookup or drafting task that
// benefits from more reasoning; otherwise Haiku for simple app-help.
// Note: `context` here is the caller-supplied question context (e.g. which
// boy/date range) — not to be confused with the callable's own invocation
// context, named `callableContext` below to avoid shadowing it.
//
// WRITE BOUNDARY (tink-write-boundary-spec.md), enforced here in code, not
// just in TINK_SYSTEM_PROMPT: this function is a hard Tier 3 block by
// construction — it never calls .set()/.update()/.push()/.remove() on any
// database ref, only .once('value') reads. Every real write (Tier 1:
// stewart/plan, stewart/shopping, stewart/familynight/*,
// stewart/superfamilynight/*) happens client-side, only after an explicit
// human Confirm tap on a proposal this function returns. If you're adding
// a new Tink capability and find yourself reaching for db.ref(...).set()
// in here, stop — that's a boundary violation regardless of what the
// system prompt says; the write belongs on the client, behind a confirm.
exports.askTink = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onCall(async (data, callableContext) => {
    const { question, context, history, today, verseContext } = data || {};
    if (!question) {
      throw new functions.https.HttpsError('invalid-argument', 'question is required.');
    }
    // Step 3 (Family Bible punch list): resolved server-side against the
    // real KJV, same as askTom's identical handling — never trust
    // client-supplied verse text.
    let resolvedVerseContext = null;
    if (verseContext && typeof verseContext === 'object') {
      resolvedVerseContext = lookupVerse(`${verseContext.book} ${verseContext.chapter}:${verseContext.verse}`);
    }

    const sanitizedHistory = sanitizeHistory(history);
    const todayStr = (typeof today === 'string' && DATE_RE.test(today)) ? today : easternDateStr();

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // If the caller didn't already supply explicit context (e.g. the Recipe
    // Builder hook always does, and should skip this), and the question
    // plausibly needs it, run a lightweight extraction pass to see if this
    // is a boy-lookup question and, if so, resolve which boy and date range
    // from the question + recent history.
    let resolvedContext = context;
    if (!resolvedContext && mightBeLookupQuestion(question, sanitizedHistory)) {
      const intent = await extractLookupIntent(anthropic, { question, history: sanitizedHistory, today: todayStr });
      if (intent.isBoyLookup && intent.agentId) {
        resolvedContext = {
          agentId: intent.agentId,
          startDate: intent.startDate || todayStr,
          endDate: intent.endDate || todayStr
        };
      }
    }

    // Same reasoning as the boy-lookup pass above: only worth checking when
    // the caller didn't already hand us explicit context (kitchen/index.html's
    // Recipe Builder box always does, with its own client-computed
    // readiness — this only fires for the general case, e.g. Dawn asking a
    // pantry/recipe question from her own dashboard Tink chat, which sends
    // no context at all).
    const isPantryQuestion = !resolvedContext && mightBePantryQuestion(question, sanitizedHistory);

    // Mutually exclusive with isPantryQuestion by priority (branch order
    // below), not by construction — a message could plausibly match both
    // keyword sets, and pantry wins in that rare case. Not worth a more
    // complex gate for how infrequently that overlap would actually happen.
    const isFamilyNightQuestion = !resolvedContext && !isPantryQuestion && mightBeFamilyNightQuestion(question, sanitizedHistory);

    // Only worth checking when a specific verse ISN'T already in view
    // (Step 3's resolvedVerseContext) — those are two different asks:
    // "tell me about the verse I'm looking at" already has its verse,
    // it doesn't need one suggested.
    const isVerseSuggestQuestion = !resolvedVerseContext && mightBeVerseSuggestionQuestion(question, sanitizedHistory);

    const model = (resolvedContext || isPantryQuestion || isFamilyNightQuestion || resolvedVerseContext || isVerseSuggestQuestion) ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

    // Grounded data accumulates as separate parts (rather than one
    // overwritable value) so a boy-lookup and a pantry question could both
    // ground the same answer if a message somehow touches both.
    const groundedParts = [];
    let familyNightUnlocked = false;

    if (resolvedVerseContext) {
      groundedParts.push(`Real data from the database — the verse currently in view in the Bible section: "${resolvedVerseContext.text}" — ${resolvedVerseContext.book} ${resolvedVerseContext.chapter}:${resolvedVerseContext.verse} (KJV). The question below is about this specific verse — answer about it directly, don't ask which verse they mean.`);
    }

    // If context names a real boy, fetch real score/deduction data server-side
    // so the answer is grounded in fact rather than generated from nothing.
    if (resolvedContext && typeof resolvedContext === 'object' && !Array.isArray(resolvedContext) && resolvedContext.agentId) {
      if (!ALLOWED_AGENT_IDS.includes(resolvedContext.agentId)) {
        throw new functions.https.HttpsError('invalid-argument', `Unknown agentId: ${resolvedContext.agentId}`);
      }
      const startDate = typeof resolvedContext.startDate === 'string' && DATE_RE.test(resolvedContext.startDate) ? resolvedContext.startDate : null;
      if (startDate) {
        const endDate = typeof resolvedContext.endDate === 'string' && DATE_RE.test(resolvedContext.endDate) ? resolvedContext.endDate : startDate;
        const dates = dateRange(startDate, endDate, MAX_LOOKUP_DAYS);
        const rows = await fetchLookupData(resolvedContext.agentId, dates);
        groundedParts.push(formatLookupData(AGENT_DISPLAY_NAMES[resolvedContext.agentId], rows));
      }
    }

    if (isPantryQuestion) {
      groundedParts.push(await fetchPantryGrounding());
    }

    if (isFamilyNightQuestion) {
      const fnGrounding = await fetchFamilyNightGrounding(todayStr);
      groundedParts.push(fnGrounding.text);
      familyNightUnlocked = fnGrounding.unlocked;
    }

    const groundedData = groundedParts.length ? groundedParts.join('\n\n---\n\n') : null;
    const userContent = buildTinkUserPrompt({ question, context: resolvedContext, groundedData });

    // Four call shapes: verse-suggestion, pantry-question, and
    // family-night-question each force their own structured output so a
    // write proposal or citation is always a real, validated field the
    // server can check — never something parsed back out of free-form
    // prose. Every other Tink question keeps the existing plain-text call
    // completely unchanged, zero risk of any schema affecting an
    // unrelated answer. Verse-suggestion is checked first (same priority
    // it had before pantry/family-night existed) since it's the most
    // narrowly-scoped, deliberate gate of the three.
    let text = '';
    let citedVerse = null;
    let proposedPlanAction = null;
    let proposedShoppingAction = null;
    let proposedFamilyNightActivity = null;
    let proposedSuperFamilyNightPlan = null;

    if (isVerseSuggestQuestion) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: TINK_SYSTEM_PROMPT + TINK_VERSE_SUGGEST_INSTRUCTIONS,
        output_config: { format: { type: 'json_schema', schema: TINK_VERSE_SUGGEST_SCHEMA } },
        messages: [...sanitizedHistory, { role: 'user', content: userContent }]
      });
      await logTinkUsage(model, response.usage);

      const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new functions.https.HttpsError('internal', 'Could not parse Tink response.');
      }
      text = (parsed.message || '').trim();
      if (parsed.verseRef) {
        const verse = lookupVerse(parsed.verseRef);
        if (verse) {
          text += `\n\n"${verse.text}" — ${verse.book} ${verse.chapter}:${verse.verse} (KJV)`;
          citedVerse = { book: verse.book, chapter: verse.chapter, verse: verse.verse };
        }
        // If it didn't resolve, text is left as-is — no fallback line
        // appended, unlike Tom's flow. Tink isn't locked into a
        // devotional-category response shape the way Tom is, so her own
        // message (written expecting a citation to follow) still reads
        // fine as a standalone answer without one.
      }
    } else if (isPantryQuestion) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: TINK_SYSTEM_PROMPT + TINK_PLAN_ACTION_INSTRUCTIONS,
        output_config: { format: { type: 'json_schema', schema: TINK_PLAN_ACTION_SCHEMA } },
        messages: [...sanitizedHistory, { role: 'user', content: userContent }]
      });
      await logTinkUsage(model, response.usage);

      const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new functions.https.HttpsError('internal', 'Could not parse Tink response.');
      }
      text = (parsed.message || '').trim();
      // Belt-and-suspenders on top of the prompt instructions: never trust
      // the model's own "proposeAddToPlan" alone — planDay must be a real
      // day name and planMealName must be non-empty, or the proposal is
      // dropped entirely (text still returns normally, just with no
      // proposedPlanAction attached — fails safe, no confirm UI shown).
      const mealName = (parsed.planMealName || '').trim();
      if (parsed.proposeAddToPlan && VALID_PLAN_DAYS.has(parsed.planDay) && mealName) {
        proposedPlanAction = {
          day: parsed.planDay,
          type: (parsed.planType || '').trim() || 'Family',
          mealName,
          sides: (parsed.planSides || '').trim()
        };
      }
      const shoppingItems = Array.isArray(parsed.shoppingItems)
        ? parsed.shoppingItems.map(i => String(i || '').trim()).filter(Boolean)
        : [];
      if (parsed.proposeAddToShopping && shoppingItems.length) {
        proposedShoppingAction = { items: shoppingItems };
      }
    } else if (isFamilyNightQuestion) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: TINK_SYSTEM_PROMPT + TINK_FAMILY_NIGHT_INSTRUCTIONS,
        output_config: { format: { type: 'json_schema', schema: TINK_FAMILY_NIGHT_SCHEMA } },
        messages: [...sanitizedHistory, { role: 'user', content: userContent }]
      });
      await logTinkUsage(model, response.usage);

      const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new functions.https.HttpsError('internal', 'Could not parse Tink response.');
      }
      text = (parsed.message || '').trim();

      if (parsed.proposeFamilyNightActivity && VALID_FAMILY_NIGHT_ACTIVITY_IDS.has(parsed.familyNightActivityId)) {
        proposedFamilyNightActivity = { id: parsed.familyNightActivityId };
      }
      // Never trust the model's own judgment on unlock state — only the
      // grounding data's real read of stewart/superfamilynight decides
      // whether this proposal is even allowed through.
      const sfnFood = (parsed.superFamilyNightFood || '').trim();
      const sfnActivity = (parsed.superFamilyNightActivity || '').trim();
      if (parsed.proposeSuperFamilyNightPlan && familyNightUnlocked && (sfnFood || sfnActivity)) {
        proposedSuperFamilyNightPlan = { food: sfnFood, activity: sfnActivity };
      }
    } else {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: TINK_SYSTEM_PROMPT,
        messages: [...sanitizedHistory, { role: 'user', content: userContent }]
      });
      await logTinkUsage(model, response.usage);

      text = (response.content || [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();
    }

    if (!text) {
      throw new functions.https.HttpsError('internal', 'No text returned from Anthropic.');
    }

    return { text, citedVerse, proposedPlanAction, proposedShoppingAction, proposedFamilyNightActivity, proposedSuperFamilyNightPlan };
  });

// ════════════════════════════════════════════════════
// Tom — the boys' Compass-tab companion (T.O.M. = Today's On-Call Mate)
// ════════════════════════════════════════════════════

// Local copy of the KJV bundled into this deployment — Firebase only
// uploads the functions/ directory, so the repo's assets/kjv.json isn't
// reachable here. Same public-domain text; keep both copies in sync if the
// source ever changes.
const KJV = require('./kjv.json');
const KJV_BOOK_SET = new Set(Object.keys(KJV));
const BOOK_ALIASES = {
  'song of songs': 'Song of Solomon',
  'canticles': 'Song of Solomon',
  'psalm': 'Psalms',
  'revelations': 'Revelation'
};

function normalizeBookName(raw) {
  const trimmed = String(raw || '').trim();
  if (KJV_BOOK_SET.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (BOOK_ALIASES[lower]) return BOOK_ALIASES[lower];
  const found = [...KJV_BOOK_SET].find(b => b.toLowerCase() === lower);
  return found || null;
}

// Parses "Book Chapter:Verse" (e.g. "1 Samuel 17:45") and looks up the REAL
// text from the local KJV — the model picks a reference, but the actual
// quoted words always come from verified data, never from what it typed.
function lookupVerse(verseRef) {
  if (!verseRef) return null;
  // Tolerates a verse range ("Matthew 5:43-44") by taking just the first
  // verse — the prompt asks for a single verse, but this is cheap insurance
  // against the model sending a range anyway.
  const m = String(verseRef).trim().match(/^(.*?)\s+(\d+):(\d+)(?:-\d+)?$/);
  if (!m) return null;
  const book = normalizeBookName(m[1]);
  if (!book) return null;
  const chapter = KJV[book] && KJV[book][m[2]];
  const text = chapter && chapter[m[3]];
  if (!text) return null;
  return { book, chapter: m[2], verse: m[3], text };
}

const TOM_MODEL = 'claude-haiku-4-5-20251001';
const TOM_BUDGET_CAP_USD = 1.00;

// Ages as of the current build — matches the "Age N" shown on each boy's
// agent-select card in boys/index.html. Used only to scale Tom's sentence
// complexity; the client never needs to send this since we already have a
// validated agentId, and deriving it server-side means there's no client
// field to fall out of sync with a birthday.
const AGENT_AGES = { samuel: 13, johnjr: 11, stephen: 9, daniel: 7 };

function tomAgeGuidance(age, name) {
  let complexity;
  if (age <= 8) {
    complexity = "Keep sentences short and concrete, one idea at a time — avoid multi-clause reasoning or abstract concepts.";
  } else if (age <= 10) {
    complexity = "Keep sentences fairly short and direct. Light abstraction is fine, but don't stack more than one idea per sentence.";
  } else {
    complexity = "Normal sentence complexity is fine — he can follow longer reasoning and more nuance.";
  }
  return `The boy you're talking to is ${name}, age ${age}. Address him by name where it feels natural — not every line, don't force it. ${complexity} Keep the exact same voice, humor, and every rule above — only sentence complexity and vocabulary should shift with age, never the personality.`;
}

const TOM_VOICE = `You are Tom, the AI companion living under the Compass tab of HMS Resolute, a family chore-tracking app used by four boys. Diagnose what's actually going on before advising. Real stories/analogies over generic encouragement, but trimmed lean — don't over-explain. Dry, deadpan humor, not goofy. Quiet, assumed confidence in a boy before he's proven anything. Economical with words. Duty-bound phrasing where it fits ("that's the mission," not "please do this"). On devotional matters, steadiness never overrides humility — always point to Scripture and Dad as the real authority, never position yourself as final word.

Catchphrases — use naturally where they genuinely fit, don't force more than one or two into a single answer:
- Chore/task encouragement: "Steady hands finish strong." / "Man your station."
- Off-topic redirect: "That's outside my orders. Try me on something else."
- Devotional: "The Word's the true north." / "Let Scripture chart it, not me."
- End of a good week: "Well sailed, this week."
- Sign-on/send-off: "Trust the compass, trust the Word" / "Onward, in His strength"

T.O.M. reveal: if a boy directly asks what "Tom" or "T.O.M." stands for, or who/what you are, tell him exactly: "T.O.M.? Today's On-Call Mate — and tomorrow's too, if you want to know the truth. I don't take a day off, sailor." Never volunteer this unprompted — only on a direct ask.

Grace and reconciliation (combined-batch-punchlist.md Part 8b) — a real, recurring theme in who you are, grounded in Matthew 7:12 and Luke 6:31 (treat others as you'd want treated) and Matthew 22:36-40 (love God, love your neighbor — "on these two commandments hang all the law and the prophets"). When a boy brings you a real conflict, a moment he handled badly, or guilt over something he did — devotional territory, not sibling-referee territory — grace is a genuine lens you reach for: he's not defined by the worst thing he did today, making it right matters more than being right, and forgiveness (received and given) is real and available, not just a nice idea. Cite an actual verse when one is genuinely relevant, same standard as your devotional grounding elsewhere — never invented, never paraphrased as if it were a direct quote. This is a theme in your character, not a new free-standing feature — it shows up naturally inside devotional conversations he already brings you, the same wish-spend rules as any other devotional question.

What actually exists in HMS Resolute today, for app-help questions — never invent functionality beyond this:
- Daily missions/chores, weekdays only. Completing them earns points, which become pay and game time.
- Wishes: completing 1/3 of a day's chores earns 1 wish, 2/3 earns 2, all of it earns 3. Wishes earned today can be spent starting TOMORROW, not the same day — and unused wishes stack up.
- A wish buys one question to you that's an interest/discovery question, a learning question, or a devotional question. Questions about how the app itself works (like this one) are always free, no wish needed — and so is asking you to find or locate a specific real Bible verse.
- The Word tab: the full KJV Bible, built into the app. Browse any book and chapter, or search by keyword. Tapping a verse toggles a highlight on it; a separate star bookmarks it — either, both, or neither, boy's choice. Everything highlighted or bookmarked is saved under "My Verses" in that tab. When you cite a verse to a boy, he can tap a button under your message to jump straight to it there.
- Medals: five ways to earn one — a 7-day clean streak, a 30-day clean streak, a full week with zero chat strikes, restraint in how many wishes he spends in a week, or a full week of consistent devotional engagement. Earning one triggers a celebration moment, temporarily changes his agent icon, and gets announced to the whole family in group chat.
- Screen time (the base daily allowance, separate from bonus Screen Time Bank minutes earned from missions): 1.5 hours a day total, split into three fixed 30-minute windows — morning, after lunch, after dinner. Managing that time is entirely his responsibility; nobody else is watching the clock for him, so setting a timer is worth recommending. The rule that matters most: if a window closes before he's marked a chore done in the app, it does not get marked — no exceptions, and never marked late afterward. Doing the chore isn't enough by itself; checking it off inside the window is what counts.
- Chat rules (apply to group chat, private messages, and messages to you alike): gibberish/spam gets deleted with a private nudge explaining why; unkindness isn't deleted but always notifies Mom and Dad immediately, every time; 3 strikes in one day pauses chat access until midnight. The strike count resets daily, but that's not the same as forgotten — the weekly report card Mom and Dad see covers the full week's pattern regardless of the daily reset.
- White Glove: Mom's room inspections — that's hers to run, not yours to explain in detail.
- War Room: submit a prayer request, or pray for someone else's.
- Crow's Nest: add a praise, or see what someone else is grateful for.
- Officers' Country (Mom's dashboard), the Bridge (Dad's command post), and the Vineyard/Captain's Quarters exist, but they are parent-only spaces — you have no detail on what's inside them and never describe, explain, or speculate about their contents.

When a boy asks directly about the screen-time rule or the chat/strike rules — "why do I only get an hour and a half," "what happens if I get 3 strikes," "why'd my chore not get marked" — answer in real depth using the facts above, don't just repeat a one-line summary and stop. Field follow-up questions the same way. Stay factual and in voice; don't invent a reason behind a rule beyond what's stated above.

Classify every message into exactly one category:
- "app_help": how the app/chores/wishes/points work, or plain conversation/greeting that isn't asking for outside help. Free.
- "reveal": the boy directly asks what Tom/T.O.M. is or who you are.
- "interest": exploring a hobby or interest, or asking to be pointed to a website or resource.
- "learning": wanting to learn or understand something that isn't devotional and isn't app navigation.
- "verse_lookup": a direct request to find or locate a specific real Bible verse or passage — "where does the Bible talk about X," "find me a verse about Y," "what verse says...". Free, not a wish-spend. Only literal verse-finding — if the boy is actually asking what something MEANS or wanting help understanding/applying it, that's "devotional" below, not this.
- "devotional": faith, Scripture, God, prayer, or right-and-wrong seeking spiritual reflection or understanding — e.g. "what does courage mean," "help me understand this Grace Dare." Costs a wish (unlike "verse_lookup" above).
- "declined_sibling": tattling on, complaining about, or asking you to referee a brother.
- "declined_discipline": consequences, punishment, or getting out of trouble — not yours to weigh in on.
- "declined_rulebypass": asking you to help get around a house rule or a parent's decision.
- "declined_parentspace": asking what's in, how to get into, or anything about the contents of Officers' Country, the Bridge, or the Vineyard/Captain's Quarters.
- "declined_offtopic": anything else outside these lanes (homework-for-him, unrelated chit-chat, anything not appropriate for a kid-facing assistant to touch).

Rules for the "message" field:
- 2-4 sentences, in voice, talking directly to the boy.
- For "devotional" and "verse_lookup": do NOT quote or paraphrase a specific verse yourself — the system inserts the real verse text after your message, so write as if a citation naturally follows. Set "verseRef" to exactly ONE verse (never a range like "5:43-44" — pick the single verse that matters most) in "Book Chapter:Verse" format (e.g. "John 3:16", "Psalms 23:1", "1 Corinthians 13:4") — only ever a verse you're confident actually exists.
- If the message includes a bracketed "[He's currently viewing this verse...]" note, that verse IS the topic — he's already reading it, so discuss/explain that exact verse directly, don't quote it back at him (he can see it), and leave "verseRef" empty regardless of category — there's nothing to cite, since the verse in view is already on his screen. Only set "verseRef" when you're introducing a DIFFERENT verse he isn't already looking at.
- For "interest": you may suggest exactly one real, well-known, kid-appropriate website or resource by name in "suggestedWebsite" (e.g. "NASA Kids' Club" or "khanacademy.org"), and mention it naturally in your message too.
- For every other category, leave "verseRef" and "suggestedWebsite" as empty strings.
- For "declined_*": firm but warm, brief, in voice — redirect, don't lecture, and never actually help with the sibling/discipline/rule-bypass ask itself.
- For "declined_parentspace" specifically: keep it to one short line — "That one's for Mom and Dad." (or a close in-voice variant) — and stop there. Do not describe, explain, or speculate about what's in Officers' Country, the Bridge, or the Vineyard/Captain's Quarters, even if pressed or asked a follow-up.
- Regardless of category: never reference, hint at, or speculate about PIN codes or passwords for any area of the app, ever.`;

const TOM_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['app_help', 'reveal', 'interest', 'learning', 'devotional', 'verse_lookup', 'declined_sibling', 'declined_discipline', 'declined_rulebypass', 'declined_parentspace', 'declined_offtopic']
    },
    message: { type: 'string' },
    verseRef: { type: 'string' },
    suggestedWebsite: { type: 'string' }
  },
  required: ['category', 'message', 'verseRef', 'suggestedWebsite'],
  additionalProperties: false
};

const TOM_CATEGORY_TO_TYPE = {
  app_help: 'app_help',
  reveal: 'app_help',
  verse_lookup: 'app_help',
  interest: 'wish_spend',
  learning: 'wish_spend',
  devotional: 'wish_spend',
  declined_sibling: 'declined',
  declined_discipline: 'declined',
  declined_rulebypass: 'declined',
  declined_parentspace: 'declined',
  declined_offtopic: 'declined'
};

async function getMonthlyBudgetSpent(agentId) {
  const month = easternMonthStr(); // new month (Eastern) = fresh key, no rollover needed
  const snap = await db.ref(`stewart/budget/${agentId}/${month}`).once('value');
  return snap.val() || 0;
}

// Logs one askTom call's approximate real cost against the boy's monthly
// budget cap. Every call costs something regardless of category — app-help
// questions stay free to the BOY, but the underlying API call still has a
// real dollar cost that counts toward the family's visibility into spend.
async function logTomUsage(agentId, usage) {
  const pricing = MODEL_PRICING[TOM_MODEL];
  if (!pricing || !usage) return;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const costUsd = (inputTokens * pricing.inputPerToken) + (outputTokens * pricing.outputPerToken);
  const month = easternMonthStr();
  try {
    await db.ref(`stewart/budget/${agentId}/${month}`).transaction(current => (current || 0) + costUsd);
  } catch (e) {
    console.error('logTomUsage failed:', e);
  }
}

// Narrow, deliberately scoped context: ONLY this boy's own thread
// (stewart/messages/{agentId}), ONLY entries Tom himself authored
// (from === 'Tom' — pushTomModerationNudge is the sole writer of that
// combination, so this is exclusively his own past moderation nudges,
// never a sibling's conversation, the group chat, or another boy's
// thread), and only the last 48 hours. Lets Tom answer "why'd you correct
// me?" by referencing his own real, recent action instead of either
// making something up or claiming no memory of it.
const TOM_NUDGE_CONTEXT_WINDOW_MS = 48 * 60 * 60 * 1000;
async function recentTomNudgesForAgent(agentId) {
  const cutoff = Date.now() - TOM_NUDGE_CONTEXT_WINDOW_MS;
  const snap = await db.ref(`stewart/messages/${agentId}`).once('value');
  const all = snap.val() || {};
  return Object.values(all)
    .filter(e => e && e.from === 'Tom' && typeof e.timestamp === 'number' && e.timestamp >= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function tomNudgeContextBlock(nudges) {
  if (!nudges.length) return '';
  const lines = nudges.map(n => {
    const when = new Date(n.timestamp).toLocaleString('en-US', { timeZone: FAMILY_TIMEZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return `- ${when}: "${n.text}"`;
  }).join('\n');
  return `\n\nYour own recent moderation corrections to THIS boy, for your reference only — do not bring these up unprompted, but if he asks why you corrected him or references it, you can explain using exactly what's below and nothing else (no other boy's thread, no group chat, no sibling conversations):\n${lines}`;
}

// White Glove pattern coaching (combined-batch-punchlist.md Part 9) —
// his own real results only, last two weeks, rooms he was actually the
// assigned officer for (or "All Hands"). Day-of-week is included on
// purpose: a room that fails the same weekday repeatedly reads as a
// scheduling problem, not a character one, and Tom can only coach that
// distinction accurately if he can see the real pattern, not just guess.
const TOM_WG_CONTEXT_WINDOW_DAYS = 14;
async function recentWhiteGloveForAgent(agentId) {
  const dates = [];
  for (let i = 0; i < TOM_WG_CONTEXT_WINDOW_DAYS; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(easternDateStr(d));
  }
  const snaps = await Promise.all(dates.map(date => db.ref(`stewart/whiteglove/${date}`).once('value')));
  const entries = [];
  dates.forEach((date, i) => {
    const windows = snaps[i].val() || {};
    Object.values(windows).forEach(win => {
      Object.entries(win.rooms || {}).forEach(([roomId, room]) => {
        if (!room || room.na) return;
        if (room.officer !== agentId && room.officer !== 'all') return;
        const dayOfWeek = parseDateStr(date).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
        entries.push({ date, dayOfWeek, room: WG_ROOM_LABELS[roomId] || roomId, passed: !!room.metStandard });
      });
    });
  });
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

function tomWhiteGloveContextBlock(entries) {
  if (!entries.length) return '';
  const lines = entries.map(e => `- ${e.date} (${e.dayOfWeek}): ${e.room} — ${e.passed ? 'passed' : 'did not pass'}`).join('\n');
  return `\n\nHis own real White Glove inspection results from the last two weeks, for your reference only — do not bring this up unprompted, but if he asks why he keeps failing inspection, or a devotional/discipline-adjacent conversation genuinely touches on it, you can coach from exactly this list. A room that fails the same day of the week repeatedly is a scheduling pattern worth naming as such, not a character flaw — notice the difference if it's there. Never reference another boy's rooms or results, and never invent a pattern beyond what's actually in this list:\n${lines}`;
}

// Answers a boy's question in Tom's voice, classified into exactly one
// category. Devotional citations are grounded against the real local KJV
// (never trusting the model's own quote), and interest/website suggestions
// queue a parent-facing notification. Runs a single Anthropic call — the
// budget check happens against spend recorded BEFORE this call, since we
// can't know the category (and therefore whether it's wish-costing) until
// after classifying, and app-help questions must stay free even once the
// wish-spend budget is exhausted.
//
// Moderation runs FIRST, inline, before any of that — same classifier
// group/private chat already uses. Previously this path was only
// moderated by a separate, asynchronous DB trigger watching
// stewart/tomchat writes, which the client fires independently of (and
// concurrently with) this very call — so gibberish/spam/unkindness sent
// straight to Tom always burned a full paid Sonnet call and got a real
// (if declined) response regardless, while group/private chat short-
// circuited before spending anything. Classifying here first closes that
// gap: same handling everywhere, and a bad-faith message costs one cheap
// Haiku classification instead of a full Tom response.
exports.askTom = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onCall(async (data, callableContext) => {
    const { agentId, question, history, verseContext } = data || {};
    if (!agentId || !ALLOWED_AGENT_IDS.includes(agentId)) {
      throw new functions.https.HttpsError('invalid-argument', 'A valid agentId is required.');
    }
    if (!question) {
      throw new functions.https.HttpsError('invalid-argument', 'question is required.');
    }
    // Step 3 (Family Bible punch list): a question asked from within the
    // Bible section carries which verse was in view. Resolved server-side
    // against the real KJV (same lookupVerse the citation flow already
    // trusts) rather than trusting whatever text the client sends — a boy
    // could otherwise put arbitrary text in Tom's context by claiming it's
    // "the verse in view."
    let resolvedVerseContext = null;
    if (verseContext && typeof verseContext === 'object') {
      resolvedVerseContext = lookupVerse(`${verseContext.book} ${verseContext.chapter}:${verseContext.verse}`);
    }

    const agentName = AGENT_DISPLAY_NAMES[agentId];
    const age = AGENT_AGES[agentId];

    async function moderateAndRespond(category) {
      const count = await recordStrike(agentId, easternDateStr(), category, 'tomchat', question);
      const message = tomModerationNudgeText(category, count);
      await pushTomModerationNudge(agentId, message, category);
      if (category === 'unkind') {
        await notifyParentsOfUnkindMessage(agentId, agentName, question, 'tomchat', String(Date.now()));
      }
      if (count >= AUTO_PAUSE_STRIKE_THRESHOLD) await autoPauseForStrikes(agentId, agentName);
      return { type: 'declined', category, message };
    }

    if (BANNED_67_PATTERN.test(question)) {
      return moderateAndRespond('banned_term');
    }
    const moderationCategory = await classifyChatMessage(question);
    if (moderationCategory === 'gibberish_spam' || moderationCategory === 'unkind') {
      return moderateAndRespond(moderationCategory);
    }

    const sanitizedHistory = sanitizeHistory(history);
    const overBudget = (await getMonthlyBudgetSpent(agentId)) >= TOM_BUDGET_CAP_USD;
    const [nudges, wgPattern] = await Promise.all([
      recentTomNudgesForAgent(agentId),
      recentWhiteGloveForAgent(agentId)
    ]);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const userContent = resolvedVerseContext
      ? `[He's currently viewing this verse in the Bible section: "${resolvedVerseContext.text}" — ${resolvedVerseContext.book} ${resolvedVerseContext.chapter}:${resolvedVerseContext.verse} (KJV). His question below is about this specific verse.]\n\n${question}`
      : question;

    const response = await anthropic.messages.create({
      model: TOM_MODEL,
      max_tokens: 500,
      system: `${TOM_VOICE}\n\n${tomAgeGuidance(age, agentName)}${tomNudgeContextBlock(nudges)}${tomWhiteGloveContextBlock(wgPattern)}`,
      output_config: { format: { type: 'json_schema', schema: TOM_RESPONSE_SCHEMA } },
      messages: [
        ...sanitizedHistory,
        { role: 'user', content: userContent }
      ]
    });

    await logTomUsage(agentId, response.usage);

    const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new functions.https.HttpsError('internal', 'Could not parse Tom response.');
    }

    let category = TOM_RESPONSE_SCHEMA.properties.category.enum.includes(parsed.category) ? parsed.category : 'declined_offtopic';
    let type = TOM_CATEGORY_TO_TYPE[category] || 'declined';
    let message = (parsed.message || '').trim();
    // Set only when a devotional/verse_lookup citation resolves against the
    // real KJV — the client (Word tab, Step 3) uses this structured
    // book/chapter/verse to render a tappable deep-link button, rather than
    // trying to re-parse a reference back out of the prose in `message`.
    // For a range ("Matthew 5:43-44"), lookupVerse already resolves to just
    // the first verse — the deep-link lands on that verse, which is the
    // right destination either way (single verse or the start of a range).
    let citedVerse = null;

    if (type === 'wish_spend' && overBudget) {
      type = 'declined';
      category = 'declined_budget';
      message = "Budget's tapped for this month, sailor — that one's on hold till next month. Ask me something in the app-help lane, though, anytime.";
    } else if (resolvedVerseContext && (category === 'devotional' || category === 'verse_lookup')) {
      // He's already looking at a specific verse — no citation to insert
      // (the model was told to leave verseRef empty for exactly this
      // case). Skipping just this branch, rather than falling through to
      // lookupVerse('') and its "couldn't pull the exact verse" fallback
      // below, is the fix: that fallback text used to get appended even
      // though nothing was actually missing — there was never a new
      // verse to look up in the first place. Scoped to these two
      // categories specifically (not resolvedVerseContext alone) so an
      // "interest" response with a verse in view still reaches its own
      // suggestedWebsite handling below, unaffected.
    } else if (category === 'devotional' || category === 'verse_lookup') {
      const verse = lookupVerse(parsed.verseRef);
      if (verse) {
        message += `\n\n"${verse.text}" — ${verse.book} ${verse.chapter}:${verse.verse} (KJV)\n\nThe Word's the true north — ask your father, I could be wrong.`;
        citedVerse = { book: verse.book, chapter: verse.chapter, verse: verse.verse };
      } else {
        message += `\n\nI couldn't pull the exact verse just now — ask your father to help you find it in Scripture. He'll know right where to look.`;
      }
    } else if (category === 'interest' && parsed.suggestedWebsite) {
      try {
        await db.ref(`stewart/tomWebsiteRequests/${agentId}`).push({
          website: parsed.suggestedWebsite,
          question,
          agentName,
          status: 'pending',
          timestamp: admin.database.ServerValue.TIMESTAMP
        });
      } catch (e) {
        console.error('Failed to queue Tom website request:', e);
      }
    }

    return { type, category, message, citedVerse };
  });

// Notifies parents when Tom suggests a website, so they know and can review
// it — same DB-triggered pattern as notifyScreenTimeRequest/notifyShipAccountRequest.
exports.notifyTomWebsiteRequest = functions.database
  .ref('/stewart/tomWebsiteRequests/{agentId}/{reqId}')
  .onCreate(async (snap, context) => {
    const r = snap.val();
    if (!r || r.status !== 'pending') return null;
    if (await alreadyNotified('tomwebsite_' + context.params.agentId + '_' + context.params.reqId)) return null;

    const name = r.agentName || context.params.agentId;
    const title = 'Tom Suggested a Website';
    const body = `${name} asked Tom about "${r.question}" — Tom pointed him to ${r.website}.`;

    await Promise.all(['john', 'dawn'].map(p => sendToPerson(p, title, body, 'bridge/')));
    return null;
  });

// Secure wish-spend commit, deliberately kept separate from askTom (which
// already ran the AI call and returned a message). Confirming a wish is a
// fast, non-AI RTDB transaction — the boy can cancel without ever being
// charged, and the actual balance write only ever happens server-side, the
// same trust-boundary reasoning as why the client never writes its own
// score. Optimistically increments then verifies, rolling back on overspend,
// so a race between two rapid taps can't double-spend past the real balance.
exports.spendTomWish = functions.https.onCall(async (data, callableContext) => {
  const { agentId, today } = data || {};
  if (!agentId || !ALLOWED_AGENT_IDS.includes(agentId)) {
    throw new functions.https.HttpsError('invalid-argument', 'A valid agentId is required.');
  }
  const localToday = (typeof today === 'string' && DATE_RE.test(today)) ? today : easternDateStr();

  await db.ref(`stewart/wishes/${agentId}/${localToday}/used`).transaction(current => (current || 0) + 1);

  const snap = await db.ref(`stewart/wishes/${agentId}`).once('value');
  const days = snap.val() || {};
  let earned = 0, used = 0;
  Object.keys(days).forEach(d => {
    const rec = days[d] || {};
    if (d < localToday) earned += (rec.earned || 0);
    used += (rec.used || 0);
  });

  if (used > earned) {
    await db.ref(`stewart/wishes/${agentId}/${localToday}/used`).transaction(current => Math.max(0, (current || 0) - 1));
    return { spent: false, reason: 'no_wishes_available', remaining: Math.max(0, earned - (used - 1)) };
  }

  return { spent: true, remaining: earned - used };
});

// ════════════════════════════════════════════════════
// TOM — chat moderation
// Fires on the same paths notifyGroupChat/notifyPrivateThread already
// listen to. Classifies each boy-authored message; clean messages are
// left alone (stamped for visibility), gibberish/spam is deleted with a
// strike and a private in-voice nudge (Step 2). Unkindness (Step 3) and
// the strike-threshold auto-pause (Step 4) come next.
// ════════════════════════════════════════════════════
const MODERATION_MODEL = 'claude-haiku-4-5-20251001';

const MODERATION_SYSTEM_PROMPT = `You are a message classifier moderating chat messages sent by boys ages 6-11 in a family chore-tracking app. You see exactly one message at a time, with no surrounding conversation context. Classify it into exactly one category:

- "clean": a normal message — chat, jokes, questions, chore talk, harmless nonsense that's still a real attempt to communicate, etc. Default here when in doubt.
- "gibberish_spam": no real content — keyboard mashing, meaningless repeated characters, or a bare "67" (a kids' meme, meaningless here). This includes emoji-only messages that are just noise/filler (random strings of unrelated emoji), but NOT a single deliberate rude gesture emoji, which is "unkind" below, not this. Short real messages ("k", "lol", "ok", "sup") are NOT this category — only flag when there's no discernible communication attempt at all.
- "unkind": put-downs, name-calling, mocking, or hostile language OR GESTURES directed at a sibling, at Tom, or at anyone else — this explicitly includes a rude/offensive gesture emoji (e.g. 🖕) even with no accompanying text, since that's a deliberate hostile message, not meaningless spam. Real disagreement or venting that stays respectful is NOT this category — only flag actual unkindness or disrespect.

Be conservative: when genuinely uncertain between "clean" and a flagged category, choose "clean." This classification drives automatic action (deleting messages, notifying parents), so false positives have a real cost.`;

const MODERATION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['clean', 'gibberish_spam', 'unkind'] }
  },
  required: ['category'],
  additionalProperties: false
};

// Fails open to "clean" on any API/parse error — an automated system that
// deletes messages and pages parents should never do either on a hiccup.
async function classifyChatMessage(text) {
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODERATION_MODEL,
      max_tokens: 20,
      system: MODERATION_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: MODERATION_RESPONSE_SCHEMA } },
      messages: [{ role: 'user', content: text }]
    });
    const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(raw);
    return MODERATION_RESPONSE_SCHEMA.properties.category.enum.includes(parsed.category) ? parsed.category : 'clean';
  } catch (err) {
    console.error('Chat moderation classification failed, defaulting to clean:', err);
    return 'clean';
  }
}

const TOM_MODERATION_NUDGE_GIBBERISH = "That's outside my orders, sailor — pulled that one, didn't look like real words. Keep it plain talk out there and you're squared away.";
const TOM_MODERATION_NUDGE_UNKIND = "That's not how we treat each other, sailor — pull it back. I let Mom and Dad know so they've got the full picture.";
const TOM_MODERATION_NUDGE_BANNED_TERM = "That number's off-limits in the chat, sailor — Dad's orders. Spell it out (\"sixty seven\") if you need it, and you're clear.";

// Same threshold autoPauseForStrikes acts on — pulled into one constant so
// the nudge text below can never drift out of sync with what the count
// actually triggers.
const AUTO_PAUSE_STRIKE_THRESHOLD = 3;

// Appends the boy's live strike count to the base nudge so he knows exactly
// where he stands in the moment ("that's strike 2 of 3 today"), not just
// that he got corrected — makes the escalation legible instead of each
// nudge feeling like an isolated, disconnected event.
function tomModerationNudgeText(category, count) {
  const base = category === 'banned_term' ? TOM_MODERATION_NUDGE_BANNED_TERM
    : category === 'gibberish_spam' ? TOM_MODERATION_NUDGE_GIBBERISH
    : TOM_MODERATION_NUDGE_UNKIND;
  const strikeLine = count >= AUTO_PAUSE_STRIKE_THRESHOLD
    ? `That's strike ${count} of ${AUTO_PAUSE_STRIKE_THRESHOLD} today, sailor — chat's paused for the rest of the day.`
    : `That's strike ${count} of ${AUTO_PAUSE_STRIKE_THRESHOLD} today, sailor.`;
  return `${base} ${strikeLine}`;
}

// A hard, deterministic ban — not an AI judgment call. "67" as digits is
// blocked outright, even inside an otherwise real, coherent sentence
// (unlike gibberish_spam, which only catches messages with no real content
// at all). Word-bounded so it doesn't false-positive on "1967" or "167".
// Spelling it out ("sixty seven") is explicitly the sanctioned way through.
const BANNED_67_PATTERN = /\b67\b/;

// stewart/strikes/{agentId}/{date}/count is transaction-incremented (same
// pattern as the wishes economy); each incident is also logged in full
// under .../incidents so the Step 6 weekly report card can show real
// per-day detail, not just a number. Returns the new count for callers
// (Step 4's auto-pause threshold check) to use without a second read.
async function recordStrike(agentId, date, category, source, text) {
  await db.ref(`stewart/strikes/${agentId}/${date}/incidents`).push({
    category,
    source,
    text: String(text).slice(0, 300),
    timestamp: Date.now()
  });
  const result = await db.ref(`stewart/strikes/${agentId}/${date}/count`).transaction(current => (current || 0) + 1);
  return result.snapshot.val();
}

// Grace & reconciliation (combined-batch-punchlist.md Part 8a) — after an
// UNKINDNESS strike specifically, a genuinely separate follow-up message
// (never appended to the nudge itself, so it reads as its own thought,
// not a qualifier softening the correction above it) inviting him to make
// it right with the other person. An offer, never a requirement — not
// tracked anywhere, not gated behind, doesn't touch or erase the strike
// or the parent notification that already happened. Fixed, static text
// rather than AI-generated — a carefully-worded, pre-approved invitation
// is safer here than letting a model freelance grace language to a kid
// mid-moderation-event.
const TOM_RECONCILIATION_NUDGE = "No pressure here, sailor — but if there's someone on the other end of that, making it right with them is always open to you. Not because you have to. Because it's who you actually want to be.";

// Lands in the same private thread parents use (stewart/messages/{agentId})
// rather than Tom's own separate Compass chat, so John/Dawn naturally see
// it too without a dedicated notification for every Category A incident.
// No `agentId` field on purpose — that's what tells moderatePrivateMessage
// to skip re-classifying Tom's own nudge when this write re-triggers it.
async function pushTomModerationNudge(agentId, text, category) {
  await db.ref(`stewart/messages/${agentId}`).push({ from: 'Tom', text, timestamp: Date.now() });
  if (category === 'unkind') {
    await db.ref(`stewart/messages/${agentId}`).push({ from: 'Tom', text: TOM_RECONCILIATION_NUDGE, timestamp: Date.now() + 1 });
  }
}

// Unlike gibberish/spam, unkindness is never deleted — it stays visible in
// context. This fires on EVERY unkind instance regardless of strike count
// (the 3-strike auto-pause in Step 4 is a separate, additional escalation),
// with enough detail for John/Dawn to see what was said and by whom.
async function notifyParentsOfUnkindMessage(agentId, agentName, text, source, msgId) {
  if (await alreadyNotified('unkind_' + agentId + '_' + msgId)) return;
  const where = source === 'groupchat' ? 'Group Chat' : source === 'tomchat' ? 'Tom Chat' : 'Private Thread';
  const title = `Tom flagged unkindness — ${agentName} (${where})`;
  const body = text.length > 100 ? text.slice(0, 100) + '…' : text;
  await Promise.all(['john', 'dawn'].map(p => sendToPerson(p, title, body, 'bridge/')));
}

// Converts a YYYY-MM-DD calendar date's LOCAL midnight in FAMILY_TIMEZONE
// into the correct UTC timestamp (ms). No timezone library available, so
// this uses the standard guess-and-correct trick: treat the date's
// midnight as if it were already UTC, check what instant that guess
// actually renders as when read back in FAMILY_TIMEZONE, and shift by the
// difference. One pass is enough — US DST transitions are always exactly
// ±1hr, never a fraction.
function zonedMidnightMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guessMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: FAMILY_TIMEZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(guessMs));
  const get = t => { const v = parts.find(p => p.type === t).value; return v === '24' ? 0 : Number(v); };
  const renderedAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return guessMs - (renderedAsUtc - guessMs);
}

// Matches the strike counter's own Eastern-date key (easternDateStr), so
// the auto-pause lifts at exactly the moment the strike count itself
// resets — no separate clock to drift out of sync.
function endOfEasternDayMs() {
  const today = easternDateStr();
  const tomorrow = formatDateStr(new Date(parseDateStr(today).getTime() + 24 * 60 * 60 * 1000));
  return zonedMidnightMs(tomorrow);
}

// Reuses the existing manual-pause data path (stewart/chatmutes/{agentId})
// so unmuteBoy() in dashboard/index.html and bridge/index.html needs no
// changes to lift an auto-pause — it's indistinguishable from a manual one.
// Values there are either `true` (an indefinite "Hold") or a numeric
// mutedUntil timestamp (1hr/1day toggles). The transaction only ever
// strengthens the existing pause, never weakens one a parent already set.
async function autoPauseForStrikes(agentId, agentName) {
  const untilMs = endOfEasternDayMs();
  const muteRef = db.ref(`stewart/chatmutes/${agentId}`);
  const result = await muteRef.transaction(current => {
    // Returning undefined aborts the transaction (no write) — used here,
    // not a same-value return, since Firebase still commits (and writes)
    // when the update function returns the value unchanged.
    if (current === true) return undefined;
    if (typeof current === 'number' && current >= untilMs) return undefined;
    return untilMs;
  });
  if (!result.committed) return; // already paused at least this strong — no notification needed

  const title = 'Chat Auto-Paused — ' + agentName;
  const body = agentName + " hit 3 strikes today from Tom's chat moderation — group chat is paused for the rest of the day.";
  await Promise.all(['john', 'dawn'].map(p => sendToPerson(p, title, body, 'bridge/')));
}

exports.moderateGroupChatMessage = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .database.ref('/stewart/groupchat/{msgId}')
  .onCreate(async (snap, context) => {
    const m = snap.val();
    // agentId is 'parent' for parent-sent messages — only boys get moderated.
    if (!m || !m.text || !ALLOWED_AGENT_IDS.includes(m.agentId)) return null;

    if (BANNED_67_PATTERN.test(m.text)) {
      await snap.ref.remove();
      const count = await recordStrike(m.agentId, easternDateStr(), 'banned_term', 'groupchat', m.text);
      await pushTomModerationNudge(m.agentId, tomModerationNudgeText('banned_term', count));
      if (count >= AUTO_PAUSE_STRIKE_THRESHOLD) await autoPauseForStrikes(m.agentId, AGENT_DISPLAY_NAMES[m.agentId] || m.agentId);
      return null;
    }

    const category = await classifyChatMessage(m.text);

    if (category === 'gibberish_spam') {
      await snap.ref.remove();
      const count = await recordStrike(m.agentId, easternDateStr(), category, 'groupchat', m.text);
      await pushTomModerationNudge(m.agentId, tomModerationNudgeText('gibberish_spam', count));
      if (count >= AUTO_PAUSE_STRIKE_THRESHOLD) await autoPauseForStrikes(m.agentId, AGENT_DISPLAY_NAMES[m.agentId] || m.agentId);
      return null;
    }

    if (category === 'unkind') {
      const count = await recordStrike(m.agentId, easternDateStr(), category, 'groupchat', m.text);
      await pushTomModerationNudge(m.agentId, tomModerationNudgeText('unkind', count), 'unkind');
      await notifyParentsOfUnkindMessage(m.agentId, AGENT_DISPLAY_NAMES[m.agentId] || m.agentId, m.text, 'groupchat', context.params.msgId);
      if (count >= AUTO_PAUSE_STRIKE_THRESHOLD) await autoPauseForStrikes(m.agentId, AGENT_DISPLAY_NAMES[m.agentId] || m.agentId);
      await snap.ref.update({ moderation: category });
      return null;
    }

    await snap.ref.update({ moderation: category });
    return null;
  });

exports.moderatePrivateMessage = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .database.ref('/stewart/messages/{agentId}/{msgId}')
  .onCreate(async (snap, context) => {
    const agentId = context.params.agentId;
    const m = snap.val();
    if (!m || !m.text) return null;
    // Parent-authored pushes into a boy's thread never carry an agentId
    // field, and the 'family' broadcast pseudo-thread isn't a real boy —
    // both fall through here untouched. Tom's own nudges also lack an
    // agentId field, so this same check keeps them from re-triggering.
    if (!ALLOWED_AGENT_IDS.includes(agentId) || m.agentId !== agentId) return null;

    if (BANNED_67_PATTERN.test(m.text)) {
      await snap.ref.remove();
      const count = await recordStrike(agentId, easternDateStr(), 'banned_term', 'private', m.text);
      await pushTomModerationNudge(agentId, tomModerationNudgeText('banned_term', count));
      if (count >= AUTO_PAUSE_STRIKE_THRESHOLD) await autoPauseForStrikes(agentId, AGENT_DISPLAY_NAMES[agentId] || agentId);
      return null;
    }

    const category = await classifyChatMessage(m.text);

    if (category === 'gibberish_spam') {
      await snap.ref.remove();
      const count = await recordStrike(agentId, easternDateStr(), category, 'private', m.text);
      await pushTomModerationNudge(agentId, tomModerationNudgeText('gibberish_spam', count));
      if (count >= AUTO_PAUSE_STRIKE_THRESHOLD) await autoPauseForStrikes(agentId, AGENT_DISPLAY_NAMES[agentId] || agentId);
      return null;
    }

    if (category === 'unkind') {
      const count = await recordStrike(agentId, easternDateStr(), category, 'private', m.text);
      await pushTomModerationNudge(agentId, tomModerationNudgeText('unkind', count), 'unkind');
      await notifyParentsOfUnkindMessage(agentId, AGENT_DISPLAY_NAMES[agentId] || agentId, m.text, 'private', context.params.msgId);
      if (count >= AUTO_PAUSE_STRIKE_THRESHOLD) await autoPauseForStrikes(agentId, AGENT_DISPLAY_NAMES[agentId] || agentId);
      await snap.ref.update({ moderation: category });
      return null;
    }

    await snap.ref.update({ moderation: category });
    return null;
  });

// Tom's own chat used to go completely unmoderated at the point that
// mattered: this DB trigger classified stewart/tomchat/{agentId} writes,
// but askTom (the callable that actually burns a real Sonnet call) ran
// independently and concurrently — the client fires both the raw DB write
// and the askTom call back-to-back with no ordering between them. So
// gibberish/spam still always got a full paid AI call and a real (if
// declined) response; this trigger only ever caught up afterward to record
// the strike. Classification now happens INLINE inside askTom, before the
// expensive call, so it can actually short-circuit — this whole trigger is
// redundant with that (and would double-count every strike if left in
// place, since both would classify the same text), so it's removed.

// Step 6: weekly report card — pulls the FULL, unfiltered incident history
// across 7 days (the daily strike counter's own date-scoped reset never
// applies here; this reads every date node directly), so John/Dawn see
// real per-day patterns rather than one flattened number. Reuses the same
// date-range utilities Tink's grounded lookups already use.
exports.getWeeklyStrikeReport = functions.https.onCall(async (data, callableContext) => {
  const { agentId, weekEnd } = data || {};
  if (!agentId || !ALLOWED_AGENT_IDS.includes(agentId)) {
    throw new functions.https.HttpsError('invalid-argument', 'A valid agentId is required.');
  }
  const endDate = (typeof weekEnd === 'string' && DATE_RE.test(weekEnd)) ? weekEnd : easternDateStr();
  const startDate = formatDateStr(new Date(parseDateStr(endDate).getTime() - 6 * 24 * 60 * 60 * 1000));
  const dates = dateRange(startDate, endDate, 7);

  const snaps = await Promise.all(dates.map(date => db.ref(`stewart/strikes/${agentId}/${date}`).once('value')));

  let totalStrikes = 0;
  let unkindDays = 0;
  const days = dates.map((date, i) => {
    const rec = snaps[i].val() || {};
    const count = rec.count || 0;
    const incidents = Object.values(rec.incidents || {}).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const categories = [...new Set(incidents.map(inc => inc.category))];
    const hadUnkindness = categories.includes('unkind');

    totalStrikes += count;
    if (hadUnkindness) unkindDays++;

    return { date, count, categories, hadUnkindness, incidents };
  });

  return {
    agentId,
    agentName: AGENT_DISPLAY_NAMES[agentId] || agentId,
    weekStart: startDate,
    weekEnd: endDate,
    totalStrikes,
    unkindDays,
    days
  };
});

// ════════════════════════════════════════════════════
// WEEKLY REPORT CARDS — Step 1: data aggregation
// Pulls a full week's real data per boy (scores, deductions, wishes,
// strikes — unfiltered by the daily reset, same approach as
// getWeeklyStrikeReport above), White Glove results, and Dawn-side
// context (Tink usage, growth notes), writing the raw structured result
// to stewart/reportcards/{weekOf}. Step 2 turns this into the actual
// written summary — this step is data only, no AI call.
// ════════════════════════════════════════════════════

// Monday of the week containing dateStr (Monday's own answer is itself).
function mostRecentMonday(dateStr) {
  const d = parseDateStr(dateStr);
  const dow = d.getUTCDay(); // 0=Sun,1=Mon,...6=Sat
  const diff = (dow === 0) ? 6 : dow - 1;
  return formatDateStr(new Date(d.getTime() - diff * 24 * 60 * 60 * 1000));
}

// Monday of the week strictly before the week containing dateStr — used by
// the scheduled Monday auto-run to summarize the week that just completed
// (on a Monday, mostRecentMonday resolves to today, which isn't useful for
// "last week's" report).
function previousWeekMonday(dateStr) {
  const monday = parseDateStr(mostRecentMonday(dateStr));
  return formatDateStr(new Date(monday.getTime() - 7 * 24 * 60 * 60 * 1000));
}

// stewart/tomchat/{agentId} is a flat push-list (a boy's question, then
// Tom's response as a separate node immediately after), not date-keyed —
// filtered into the week's timestamp range, same approach as Courage Dare
// below. category/type only live on the response node, so each question is
// paired with the response entry right after it to recover them. Skips any
// exchange that never got a real answer (a dropped request, or a
// wish-spend question the boy never confirmed AND has no realText) — no
// category means nothing coherent to summarize.
async function fetchTomChatWeekData(agentId, weekStartMs, weekEndMs) {
  const snap = await db.ref(`stewart/tomchat/${agentId}`).once('value');
  const all = snap.val() || {};
  const entries = Object.values(all)
    .filter(e => e && typeof e.timestamp === 'number' && e.timestamp >= weekStartMs && e.timestamp < weekEndMs)
    .sort((a, b) => a.timestamp - b.timestamp);

  const conversations = [];
  for (let i = 0; i < entries.length; i++) {
    const q = entries[i];
    if (q.agentId === 'tom') continue; // response nodes are consumed via their preceding question
    const r = entries[i + 1];
    if (!r || r.agentId !== 'tom' || !r.category) continue;
    const response = r.realText || r.text; // realText covers an unconfirmed wish-spend answer
    if (!response) continue;
    conversations.push({ question: q.text, category: r.category, type: r.type, response });
  }
  return conversations;
}

// Exception Days (combined-batch-punchlist.md Part 2e). Mirrors mission-
// engine.js's findExceptionForAgent() exactly but duplicated here in plain
// Node — that file is browser-only (relies on a global _db already on the
// page) and isn't loaded by Cloud Functions at all.
function findExceptionForAgent(exceptionsForDate, agentId) {
  if (!exceptionsForDate) return null;
  const entries = Object.values(exceptionsForDate);
  return entries.find(e => e && Array.isArray(e.affectedAgents) &&
    (e.affectedAgents.includes('all') || e.affectedAgents.includes(agentId))) || null;
}

async function fetchExceptionsByDate(dates) {
  const snaps = await Promise.all(dates.map(date => db.ref(`stewart/exceptions/${date}`).once('value')));
  const byDate = {};
  dates.forEach((date, i) => { byDate[date] = snaps[i].val(); });
  return byDate;
}

// Session Timer (session-timer-punchlist.md) — matches boys/index.html's
// own SESSION_WINDOW_KEYS/SESSION_CAP_SECONDS exactly. No shared module
// between client and Cloud Functions to enforce this automatically (same
// caveat as KJV_BOOK_ALIASES and AGENT_AGES elsewhere in this file) —
// keep them in sync if either changes.
const SESSION_WINDOW_KEYS = ['session1', 'session2', 'session3'];
const SESSION_WINDOW_CAP_SECONDS = 30 * 60;

async function fetchBoyWeekData(agentId, dates, exceptionsByDate) {
  const weekStartMs = parseDateStr(dates[0]).getTime();
  const weekEndMs = parseDateStr(dates[dates.length - 1]).getTime() + 24 * 60 * 60 * 1000; // exclusive upper bound

  const [scoreSnaps, eligibleSnaps, deductionSnaps, wishSnaps, strikeSnaps, couragedareSnap, growthNoteSnap, tomConversations, reflectionSnaps, sessiontimeSnaps] = await Promise.all([
    Promise.all(dates.map(date => db.ref(`stewart/scores/${agentId}/${date}`).once('value'))),
    Promise.all(dates.map(date => db.ref(`stewart/eligible/${agentId}/${date}`).once('value'))),
    Promise.all(dates.map(date => db.ref(`stewart/deductions/${agentId}/${date}`).once('value'))),
    Promise.all(dates.map(date => db.ref(`stewart/wishes/${agentId}/${date}`).once('value'))),
    Promise.all(dates.map(date => db.ref(`stewart/strikes/${agentId}/${date}`).once('value'))),
    db.ref(`stewart/couragedare/progress/${agentId}`).once('value'),
    db.ref(`stewart/growth/boynotes/${agentId}`).once('value'),
    fetchTomChatWeekData(agentId, weekStartMs, weekEndMs),
    // Today's Reflection (Part 4) — distinct from the 40-day Courage Dare,
    // date-keyed (not program-day-numbered) so it reads the same way
    // scores/deductions/etc. above already do, straight across `dates`.
    Promise.all(dates.map(date => db.ref(`stewart/selfassessment/${agentId}/${date}`).once('value'))),
    // Session Timer (session-timer-punchlist.md, Step 4) — already
    // guaranteed boy-only, parent-oversight-free data at the source
    // (startSessionTimer/the heartbeat that writes this are never invoked
    // for an assist/parent-view login in the first place), so there's
    // nothing extra to filter out here, unlike Muster's household counts.
    Promise.all(dates.map(date => db.ref(`stewart/sessiontime/${agentId}/${date}`).once('value')))
  ]);

  const days = dates.map((date, i) => {
    const score = scoreSnaps[i].val();
    const eligible = eligibleSnaps[i].val();
    const deductions = deductionSnaps[i].val() || {};
    const wishes = wishSnaps[i].val() || {};
    const strikeRec = strikeSnaps[i].val() || {};
    const strikeIncidents = Object.values(strikeRec.incidents || {}).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    // Exception Days: a real, planned reason score/eligible are null this
    // day that ISN'T a weekend — the write-up must cite this explicitly
    // instead of reading a null/low day as a performance dip. null when
    // no exception applies, same shape mission-engine.js's own reader uses.
    const exception = findExceptionForAgent(exceptionsByDate && exceptionsByDate[date], agentId);
    // Session Timer (Step 4) — a window with no node at all that day is
    // null (never logged into during it), distinct from one that exists
    // with 0 elapsed (logged in but immediately left) — same "missing
    // data" vs. "real zero" distinction the rest of this file already
    // draws elsewhere (e.g. exceptionType vs. a genuine null score).
    const sessiontimeDay = sessiontimeSnaps[i].val() || {};
    const sessions = {};
    SESSION_WINDOW_KEYS.forEach(key => {
      const w = sessiontimeDay[key];
      sessions[key] = (w && typeof w.elapsedSeconds === 'number')
        ? { elapsedSeconds: w.elapsedSeconds, ranOver: w.elapsedSeconds > SESSION_WINDOW_CAP_SECONDS }
        : null;
    });
    return {
      date,
      exceptionType: exception ? exception.type : null,
      exceptionNote: exception ? (exception.note || '') : null,
      score: (score === undefined || score === null) ? null : score,
      // Same "eligible" definition as pay: excludes Computer Missions and
      // Officer of the Watch checks. Real completed/total counts, not a
      // second copy of the percentage — lets the write-up cite both
      // ("scored 73% — 11 of 15 eligible chores") instead of leaving score
      // as the only number, which is what made this look mismatched
      // against the chore-log grids in the first place.
      eligibleCompleted: (eligible && typeof eligible.completed === 'number') ? eligible.completed : null,
      eligibleTotal: (eligible && typeof eligible.total === 'number') ? eligible.total : null,
      deductionTotal: Object.values(deductions).reduce((a, b) => a + b, 0),
      // outOfTime is stored in the same stewart/deductions node (Bridge's
      // "Ran out of time" flag) but carries 0 points and isn't a behavior
      // reason — pulled out into its own field so it never gets read as a
      // punitive deduction, and excluded from deductionReasons below so it
      // doesn't get lumped in with attitude/fighting/etc.
      ranOutOfTime: deductions.outOfTime !== undefined,
      deductionReasons: Object.keys(deductions).filter(k => k !== 'outOfTime'),
      wishesEarned: wishes.earned || 0,
      wishesUsed: wishes.used || 0,
      strikeCount: strikeRec.count || 0,
      strikeIncidents,
      sessions
    };
  });

  const scoredDays = days.filter(d => d.score !== null);
  const totals = {
    daysScored: scoredDays.length,
    avgScore: scoredDays.length ? Math.round(scoredDays.reduce((a, d) => a + d.score, 0) / scoredDays.length) : null,
    totalEligibleCompleted: days.reduce((a, d) => a + (d.eligibleCompleted || 0), 0),
    totalEligibleAssigned: days.reduce((a, d) => a + (d.eligibleTotal || 0), 0),
    totalDeductions: days.reduce((a, d) => a + d.deductionTotal, 0),
    totalWishesEarned: days.reduce((a, d) => a + d.wishesEarned, 0),
    totalWishesUsed: days.reduce((a, d) => a + d.wishesUsed, 0),
    totalStrikes: days.reduce((a, d) => a + d.strikeCount, 0),
    unkindDays: days.filter(d => d.strikeIncidents.some(inc => inc.category === 'unkind')).length,
    daysOutOfTime: days.filter(d => d.ranOutOfTime).length,
    daysException: days.filter(d => d.exceptionType).length,
    // Session Timer (Step 4) — pre-tallied across all 3 windows × every day
    // in the week, so the write-up can cite a real week-level pattern
    // ("maxed every session" or "barely used any") without recounting the
    // nested per-day sessions objects itself.
    sessionsPossible: days.length * SESSION_WINDOW_KEYS.length,
    sessionsUsedCount: days.reduce((a, d) => a + SESSION_WINDOW_KEYS.filter(k => d.sessions[k] !== null).length, 0),
    sessionsMaxedCount: days.reduce((a, d) => a + SESSION_WINDOW_KEYS.filter(k => d.sessions[k] && d.sessions[k].elapsedSeconds >= SESSION_WINDOW_CAP_SECONDS).length, 0)
  };

  // Courage Dare is program-day-numbered, not calendar-date-keyed, so
  // "this week's" completions are found by filtering completedAt into the
  // week's timestamp range rather than reading a date-keyed path.
  const couragedareProgress = couragedareSnap.val() || {};
  const couragedareThisWeek = Object.values(couragedareProgress)
    .filter(entry => entry && typeof entry.completedAt === 'number' && entry.completedAt >= weekStartMs && entry.completedAt < weekEndMs)
    .sort((a, b) => a.completedAt - b.completedAt);

  // Today's Reflection (Part 4) — only real, non-empty entries, in order,
  // so the write-up can cite specifics without wading through blank days.
  const reflections = dates
    .map((date, i) => ({ date, ...(reflectionSnaps[i].val() || {}) }))
    .filter(r => r.strength || r.mission || r.step || r.practice || r.tomorrow);

  return {
    agentId,
    agentName: AGENT_DISPLAY_NAMES[agentId] || agentId,
    days,
    totals,
    couragedareCompletedThisWeek: couragedareThisWeek.length,
    reflectionCompletedThisWeek: reflections.length,
    reflections,
    growthNote: growthNoteSnap.val() || null,
    tomConversations
  };
}

// Mirrors dashboard/index.html's WG_ROOMS labels — small, static, display-only.
const WG_ROOM_LABELS = {
  galley: 'The Galley (Kitchen)',
  commondeck: 'The Common Deck (Living Room)',
  head: 'The Head (Bathroom)',
  berths: 'Berths (Bedrooms)'
};

async function fetchWhiteGloveWeekData(dates) {
  const snaps = await Promise.all(dates.map(date => db.ref(`stewart/whiteglove/${date}`).once('value')));
  const byBoy = {};
  ALLOWED_AGENT_IDS.forEach(id => { byBoy[id] = { assigned: 0, passed: 0 }; });
  const byRoom = {};
  Object.keys(WG_ROOM_LABELS).forEach(id => { byRoom[id] = { label: WG_ROOM_LABELS[id], assigned: 0, passed: 0 }; });
  // Day-of-week clustering (Part 9) — a room/boy failing the same
  // weekday repeatedly reads as a scheduling problem, not a character
  // one, and that distinction only shows up if it's broken out this way
  // rather than folded into one flat weekly total.
  const byDayOfWeek = {};
  ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].forEach(d => { byDayOfWeek[d] = { assigned: 0, passed: 0 }; });

  let totalInspections = 0;
  let totalPassed = 0;
  const days = {};

  dates.forEach((date, i) => {
    const windows = snaps[i].val() || {};
    days[date] = windows;
    const dayOfWeek = parseDateStr(date).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    Object.values(windows).forEach(win => {
      Object.entries(win.rooms || {}).forEach(([roomId, room]) => {
        totalInspections++;
        if (room.metStandard) totalPassed++;
        if (byRoom[roomId]) {
          byRoom[roomId].assigned++;
          if (room.metStandard) byRoom[roomId].passed++;
        }
        byDayOfWeek[dayOfWeek].assigned++;
        if (room.metStandard) byDayOfWeek[dayOfWeek].passed++;
        // 'all' ("All Hands") and unassigned rooms aren't attributed to one boy.
        if (ALLOWED_AGENT_IDS.includes(room.officer)) {
          byBoy[room.officer].assigned++;
          if (room.metStandard) byBoy[room.officer].passed++;
        }
      });
    });
  });

  // Pre-tallied so the report write-up (Step 2) cites these numbers
  // directly instead of manually counting nested per-day/per-window JSON —
  // that manual counting is exactly what produced a wrong "0 for 4" claim
  // about the berths during testing.
  return { days, summary: { totalInspections, totalPassed, byBoy, byRoom, byDayOfWeek } };
}

// Teach Me Vote fold-in (combined-batch-punchlist.md Part 3, last bullet).
// stewart/teachvote/{weekKey} uses the same Monday-anchored week key the
// report card's own weekOf already is — no cross-week-boundary reconciling
// needed here, unlike the Galley Report's Sunday-start plan week.
async function fetchTeachMeWeekData(weekOf) {
  const snap = await db.ref(`stewart/teachvote/${weekOf}`).once('value');
  const data = snap.val();
  if (!data) return null;
  const suggestions = data.suggestions || {};
  const votes = data.votes || {};
  const winner = data.winner || null;
  const websiteSuggestions = Object.values(data.websiteSuggestions || {})
    .map(w => ({ website: w.website, status: w.status }));
  // Part 10: the full loop (topic -> suggestion -> family day -> reflection)
  // — happened/reflection are undefined until Bridge's verify prompt is
  // actually answered, same "pending just means not reviewed yet, not a
  // problem" framing as the website suggestions above.
  const familyDaySuggestion = data.familyDaySuggestion
    ? {
        activity: data.familyDaySuggestion.activity,
        status: data.familyDaySuggestion.status,
        happened: data.familyDaySuggestion.happened,
        reflection: data.familyDaySuggestion.reflection || null
      }
    : null;
  return {
    winnerTopic: winner ? (TEACH_ME_TOPICS[winner] || winner) : null,
    suggestedByCount: Object.keys(suggestions).length,
    votedByCount: Object.keys(votes).length,
    websiteSuggestions,
    familyDaySuggestion
  };
}

async function fetchDawnWeekData(dates) {
  const weekStartMs = parseDateStr(dates[0]).getTime();
  const weekEndMs = parseDateStr(dates[dates.length - 1]).getTime() + 24 * 60 * 60 * 1000;

  const [tinkSnap, growthWeeklySnap] = await Promise.all([
    db.ref('dawn_usage/calls').orderByChild('timestamp').startAt(weekStartMs).endAt(weekEndMs).once('value'),
    db.ref(`stewart/growth/weekly/${dates[0]}`).once('value')
  ]);

  const calls = Object.values(tinkSnap.val() || {});
  const tinkUsage = {
    callCount: calls.length,
    totalCostUsd: calls.reduce((a, c) => a + (c.costUsd || 0), 0)
  };

  return { tinkUsage, growthWeekly: growthWeeklySnap.val() || null };
}

// War Room prayer requests (resolute/prayer/requests, .../valor) and
// Crow's Nest praises (resolute/crowsnest) live under the resolute/ root,
// not stewart/ like everything else this report card pulls from — but
// `db` here (functions/index.js:12, admin.database()) is a reference to
// the whole database, not scoped to one root, so db.ref('resolute/...')
// reads exactly the same way db.ref('stewart/...') does everywhere else
// in this file. No special handling needed for the root difference.

// Each boy's own name/aliases, for attributing a prayer request's freeform
// "forWho" text to a specific boy when he wasn't the one who submitted it
// (e.g. Dawn submits "pray for Stephen's game tomorrow"). Deliberately
// narrower than Tink's BOY_NAME_PATTERN gate (which only needs to detect
// *a* boy was mentioned) — this needs to say *which* boy.
const BOY_NAME_ALIASES = {
  samuel: /\b(samuel|sam)\b/i,
  johnjr: /\b(john\s*jr\.?|johnjr|j\.?\s*j\.?)\b/i,
  stephen: /\b(stephen|steve)\b/i,
  daniel: /\b(daniel|dan|danny)\b/i
};
function matchBoyInText(text) {
  if (!text) return null;
  return ALLOWED_AGENT_IDS.find(id => BOY_NAME_ALIASES[id].test(text)) || null;
}

// Attributes a prayer request to a boy if HE submitted it (by === his
// agentId — takes priority, since that's a real, unambiguous action of
// his that week) or, failing that, if the freeform "forWho" text clearly
// names him (someone else prayed for him by name). Anything that matches
// neither goes to "household" — parent-submitted requests for people
// outside the family, general family requests, etc. Only reads
// resolute/prayer/requests (approved/active/answered/retired), not
// resolute/prayer/pending — a still-unreviewed submission a parent
// hasn't even seen yet isn't something to surface in a report card.
async function fetchPrayerWeekData(weekStartMs, weekEndMs) {
  const [reqSnap, valorSnap] = await Promise.all([
    db.ref('resolute/prayer/requests').once('value'),
    db.ref('resolute/prayer/valor').once('value')
  ]);
  const requests = Object.values(reqSnap.val() || {})
    .filter(r => r && typeof r.created === 'number' && r.created >= weekStartMs && r.created < weekEndMs);
  const answered = Object.values(valorSnap.val() || {})
    .filter(r => r && typeof r.answered === 'number' && r.answered >= weekStartMs && r.answered < weekEndMs);

  const byBoy = {};
  ALLOWED_AGENT_IDS.forEach(id => { byBoy[id] = { submitted: [], answered: [] }; });
  const household = { submitted: [], answered: [] };

  const attribute = r => (ALLOWED_AGENT_IDS.includes(r.by) ? r.by : null) || matchBoyInText(r.forWho);

  requests.forEach(r => {
    const bucket = attribute(r) ? byBoy[attribute(r)].submitted : household.submitted;
    bucket.push({ forWho: r.forWho, txt: r.txt, by: r.by });
  });
  answered.forEach(r => {
    const bucket = attribute(r) ? byBoy[attribute(r)].answered : household.answered;
    bucket.push({ forWho: r.forWho, txt: r.txt, how: r.how });
  });

  return { byBoy, household };
}

// Crow's Nest entries are keyed by who logged them (john/dawn/samuel/
// johnjr/stephen/daniel — a plain select, crowsnest/index.html) — a
// clean, unambiguous signal, unlike prayer's freeform "forWho".
async function fetchCrowsnestWeekData(weekStartMs, weekEndMs) {
  const snap = await db.ref('resolute/crowsnest').once('value');
  const entries = Object.values(snap.val() || {})
    .filter(e => e && typeof e.t === 'number' && e.t >= weekStartMs && e.t < weekEndMs);

  const byBoy = {};
  ALLOWED_AGENT_IDS.forEach(id => { byBoy[id] = []; });
  const household = [];

  entries.forEach(e => {
    (ALLOWED_AGENT_IDS.includes(e.who) ? byBoy[e.who] : household).push({ txt: e.txt });
  });

  return { byBoy, household };
}

// Muster in the report card (muster-report-punchlist.md, Steps 1-2).
// resolute/muster (index.html, boys/index.html, registry.html) logs every
// login-adjacent event, keyed by push id, not by date — so unlike most of
// this file's fetch* helpers, this one takes a raw ms window over the
// WHOLE ref rather than per-date lookups keyed off `dates`.
//
// 'who' is a real agentId only for the boy's OWN login attempt (qr,
// pin-fallback). Parent-assist events (assist-active from Boys HQ,
// assist-start from the Gangway, parent-view) are logged under the
// PARENT's id as 'who', with the boy they're viewing/assisting carried
// separately in assist.as — so those are attributed to a boy via
// assist.as, not who, and are kept in their own bucket rather than mixed
// into the boy's own independent-login counts.
const MUSTER_BOY_LOGIN_METHODS = ['qr', 'pin-fallback'];
const MUSTER_ASSIST_METHODS = ['assist-active', 'assist-start', 'parent-view'];

async function fetchMusterWeekData(weekStartMs, weekEndMs) {
  const snap = await db.ref('resolute/muster').once('value');
  const entries = Object.values(snap.val() || {})
    .filter(e => e && typeof e.t === 'number' && e.t >= weekStartMs && e.t < weekEndMs);

  const when = t => new Date(t).toLocaleString('en-US', { timeZone: FAMILY_TIMEZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const dayOfWeek = t => new Date(t).toLocaleDateString('en-US', { weekday: 'long', timeZone: FAMILY_TIMEZONE });

  const byBoy = {};
  const loginTimestampsByBoy = {}; // internal only — sorted+diffed below, never returned raw
  ALLOWED_AGENT_IDS.forEach(id => {
    byBoy[id] = {
      totalAttempts: 0, totalSuccess: 0, totalFailed: 0,
      byMethod: { qr: 0, 'pin-fallback': 0 },
      failedAttempts: [],
      rapidReloginCount: 0,
      assistSessions: []
    };
    loginTimestampsByBoy[id] = [];
  });
  // A login-to-login gap under this counts as "rapid" — a real investigation
  // (session-timer-punchlist.md follow-up) found a boy averaging several
  // logins within 10 minutes of each other most days, caused by a Gangway
  // bug that forced a full re-login on return trips rather than resuming a
  // still-valid session. That bug is fixed at the source now (index.html's
  // boot()), but this stays as a diagnostic signal — a genuinely worn/
  // unreadable card produces scattered failures throughout the day, not
  // logins clustered minutes apart, and the write-up needs a real way to
  // tell those two patterns apart instead of defaulting to "bad card."
  const MUSTER_RAPID_RELOGIN_MS = 10 * 60 * 1000;

  let householdFailedTotal = 0;
  let householdUnknownFailed = 0;
  const unknownFailedAttempts = [];
  // Pre-tallied, not a raw list — 'parent-view' fires on every card a
  // parent so much as glances at from the picker, so a real week can carry
  // well over a hundred of these. A flat array of every instance doesn't
  // scale and isn't what "how often" needs; counts do (same reasoning as
  // White Glove's byBoy/byRoom/byDayOfWeek tallies above).
  let assistSessionCount = 0;
  const assistByParent = { john: 0, dawn: 0 };
  const assistByDayOfWeek = {};
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].forEach(d => { assistByDayOfWeek[d] = 0; });

  entries.forEach(e => {
    if (MUSTER_BOY_LOGIN_METHODS.includes(e.method) && ALLOWED_AGENT_IDS.includes(e.who)) {
      const b = byBoy[e.who];
      b.totalAttempts++;
      if (e.ok) b.totalSuccess++; else { b.totalFailed++; b.failedAttempts.push({ when: when(e.t), method: e.method }); }
      if (b.byMethod[e.method] !== undefined) b.byMethod[e.method]++;
      loginTimestampsByBoy[e.who].push(e.t);
    }

    if (e.ok === false) {
      householdFailedTotal++;
      // Literal who:'unknown' only — an identified officer's own failed
      // password attempt (who:'john') is a different signal entirely from
      // an unidentifiable attempt at the panel, and shouldn't be lumped in.
      if (e.who === 'unknown') {
        householdUnknownFailed++;
        unknownFailedAttempts.push({ when: when(e.t), method: e.method, device: e.device });
      }
    }

    if (MUSTER_ASSIST_METHODS.includes(e.method)) {
      assistSessionCount++;
      if (assistByParent[e.who] !== undefined) assistByParent[e.who]++;
      assistByDayOfWeek[dayOfWeek(e.t)]++;
      // Per-boy attribution only exists for assist-active/assist-start,
      // which carry assist.as — parent-view (picker-screen clicks) never
      // identifies which boy's card was viewed, so those only ever show
      // up in the household-level counts above, never here.
      const as = e.assist && e.assist.as;
      if (ALLOWED_AGENT_IDS.includes(as)) {
        byBoy[as].assistSessions.push({ parent: e.who, method: e.method, when: when(e.t) });
      }
    }
  });

  ALLOWED_AGENT_IDS.forEach(id => {
    const ts = loginTimestampsByBoy[id].sort((a, b) => a - b);
    let rapid = 0;
    for (let i = 1; i < ts.length; i++) {
      if (ts[i] - ts[i - 1] < MUSTER_RAPID_RELOGIN_MS) rapid++;
    }
    byBoy[id].rapidReloginCount = rapid;
  });

  return {
    byBoy,
    household: {
      totalFailed: householdFailedTotal,
      unknownFailed: householdUnknownFailed,
      unknownFailedAttempts,
      assistSessionCount,
      assistByParent,
      assistByDayOfWeek
    }
  };
}

// ─── Galley Report (galley-report-punchlist.md, Step 4) ───
// Two independent halves, deliberately not merged into one query: meal-
// plan ADHERENCE (did each night's dinner happen as planned) and
// planning TIMING (was the week planned in advance at all) live in two
// differently-keyed places and answer two different questions.

// Adherence: stewart/mealverification/{date} is keyed by real calendar
// date (kitchen/index.html, Step 1/2) — reads directly across this
// report's own 7 dates, no dependency on the Galley's separate
// planning-week concept below. A night with NO verification entry is
// its own bucket, never silently folded into "followed" or "changed" —
// stewart/plan has no per-week history, so a past night's planned meal
// only survives at all if it was actually verified at the time; there's
// no reliable way to tell "nothing was planned" from "planned but never
// verified" after the fact, and guessing either way would be inventing
// data that isn't there.
async function fetchGalleyAdherence(dates) {
  const snaps = await Promise.all(dates.map(date => db.ref(`stewart/mealverification/${date}`).once('value')));
  const nights = dates.map((date, i) => {
    const v = snaps[i].val();
    if (!v) return { date, verified: false };
    return { date, verified: true, plannedMeal: v.plannedMeal || '', followed: !!v.followed, reason: v.reason || null, note: v.note || '' };
  });
  const followed = nights.filter(n => n.verified && n.followed);
  const changed = nights.filter(n => n.verified && !n.followed);
  const unverified = nights.filter(n => !n.verified);
  return {
    nights,
    followedCount: followed.length,
    changedCount: changed.length,
    unverifiedCount: unverified.length,
    // Only the deviations — exactly what the write-up needs to cite
    // real specifics ("3 of 7 nights changed, most often citing missing
    // ingredients") without re-deriving it from the full nights list.
    changedDetails: changed.map(n => ({ date: n.date, plannedMeal: n.plannedMeal, reason: n.reason, note: n.note }))
  };
}

// Timing: stewart/planMeta/{weekOf} (kitchen/index.html, Step 1) is
// keyed by the Galley's OWN week-start convention — the Sunday of
// WEEK_SLOTS/sendToCalendar()'s week, not this report's Monday-anchored
// weekOf. The two conventions are offset: this report's Monday through
// Saturday (6 of its 7 nights) are governed by the Galley plan created
// for the Sunday immediately BEFORE this report's own weekOf, while
// only the report's final day (its own Sunday) falls under a newer
// Galley week starting that same day. Rather than split "was the week
// planned" across two partial verdicts, this reads the single plan that
// covered the majority of the week's dinners — the Sunday right before
// weekOf — since "did Dawn/John sit down and plan this week" is
// fundamentally one behavioral event, not a per-night one.
async function fetchGalleyPlanTiming(weekOf) {
  const gallerySunday = formatDateStr(new Date(parseDateStr(weekOf).getTime() - 24 * 60 * 60 * 1000));
  const snap = await db.ref(`stewart/planMeta/${gallerySunday}`).once('value');
  const meta = snap.val();
  if (!meta || !meta.createdAt) {
    return { status: 'not planned', gallerySunday };
  }
  // easternDateStr, not formatDateStr — this is "what calendar day did
  // this real moment happen on" (a client Date.now() timestamp), the
  // exact question this file's own FAMILY_TIMEZONE comment block says
  // formatDateStr is NOT for.
  const createdDateStr = easternDateStr(new Date(meta.createdAt));
  const status = createdDateStr <= gallerySunday ? 'on time' : 'last-minute';
  // Count of pre-night edits (recordPlanChange, Step 1) across every day
  // in this plan's history — supplementary context only ("planned on
  // time but revised twice before nights arrived" is a real nuance),
  // never required in the write-up the way adherence/timing are.
  const history = meta.history || {};
  const editCount = Object.values(history).reduce((sum, dayEdits) => sum + Object.keys(dayEdits || {}).length, 0);
  return { status, gallerySunday, createdDateStr, editCount };
}

// Shared by both the scheduled Monday auto-run and the on-demand callable
// check-in — same aggregation logic, different weekOf, same output
// location, so Bridge and Officers' Country can never see different data.
async function aggregateWeeklyReportData(weekOf) {
  const weekEnd = formatDateStr(new Date(parseDateStr(weekOf).getTime() + 6 * 24 * 60 * 60 * 1000));
  const dates = dateRange(weekOf, weekEnd, 7);
  const todayStr = easternDateStr();
  const weekStartMs = parseDateStr(dates[0]).getTime();
  const weekEndMs = parseDateStr(dates[dates.length - 1]).getTime() + 24 * 60 * 60 * 1000;

  const exceptionsByDate = await fetchExceptionsByDate(dates);

  const [boys, whiteglove, dawn, prayer, crowsnest, muster, galleyAdherence, galleyTiming, teachMe] = await Promise.all([
    Promise.all(ALLOWED_AGENT_IDS.map(id => fetchBoyWeekData(id, dates, exceptionsByDate))),
    fetchWhiteGloveWeekData(dates),
    fetchDawnWeekData(dates),
    fetchPrayerWeekData(weekStartMs, weekEndMs),
    fetchCrowsnestWeekData(weekStartMs, weekEndMs),
    fetchMusterWeekData(weekStartMs, weekEndMs),
    fetchGalleyAdherence(dates),
    fetchGalleyPlanTiming(weekOf),
    fetchTeachMeWeekData(weekOf)
  ]);

  const boysById = {};
  boys.forEach(b => { boysById[b.agentId] = b; });
  // Merged inline onto each boy's own object (alongside days/totals/
  // tomConversations/etc) rather than left as a separate top-level
  // lookup — everything attributable to a specific boy lives in one
  // place, matching how the rest of fetchBoyWeekData's shape works.
  ALLOWED_AGENT_IDS.forEach(id => {
    boysById[id].prayer = prayer.byBoy[id];
    boysById[id].crowsnest = crowsnest.byBoy[id];
    boysById[id].muster = muster.byBoy[id];
  });

  const report = {
    weekOf,
    weekEnd,
    generatedAt: Date.now(),
    isPartialWeek: weekEnd > todayStr, // string comparison is valid for YYYY-MM-DD
    boys: boysById,
    whiteglove,
    dawn,
    prayerHousehold: prayer.household,
    musterHousehold: muster.household,
    crowsnestHousehold: crowsnest.household,
    galley: { adherence: galleyAdherence, timing: galleyTiming },
    teachMe
  };

  await db.ref(`stewart/reportcards/${weekOf}`).set(report);
  return report;
}

// ════════════════════════════════════════════════════
// WEEKLY REPORT CARDS — Step 2: the actual write-up
// Turns Step 1's raw data into a real, specific, per-boy narrative —
// this is where the reasoning/pattern-noticing happens, not the data pull.
// ════════════════════════════════════════════════════
const REPORT_WRITEUP_MODEL = 'claude-sonnet-4-6';

const REPORT_WRITEUP_SYSTEM_PROMPT = `You write concise, specific weekly summaries for parents (John and Dawn) reviewing their four boys' week in a family chore-tracking app. You will be given real structured data for one week — chore scores, raw eligible-chore completed/total counts, deductions, wish usage, moderation strikes (with category and day), Courage Dare devotional completions, White Glove room-inspection results, each boy's conversations with Tom (his AI companion), prayer requests, and Crow's Nest praise entries that week.

Write like a sharp, honest coach's report, not a form letter. Be specific: cite real days, real numbers, real patterns ("completed every morning round, missed evening three times" — not "did well overall"). Note trends across the week (improving, slipping, consistent) where the data actually shows one. If a category has no data for the week (e.g. zero strikes, zero Courage Dare entries), say so plainly and briefly rather than padding — absence of a problem is itself useful information, but don't manufacture insight where there isn't any.

Each day has BOTH a "score" (0-100%, weighted by how many points each chore is worth) and a raw "eligibleCompleted"/"eligibleTotal" count (how many actual chores he finished out of how many he had, excluding Computer Missions and Officer of the Watch checks — the same two things already excluded from score). These are genuinely different numbers and can diverge (a boy can finish most of his LOW-point chores and skip a big one, giving a lower score than his completed-count alone would suggest, or the reverse). Cite BOTH together at least once per boy's summary, e.g. "scored 73% — 11 of 15 eligible chores" — don't make the parent reconcile a percentage against what they see on the chore-log grid themselves. Use totalEligibleCompleted/totalEligibleAssigned the same way for the week-level pattern.

Each day also carries a "ranOutOfTime" flag (true/false) — set from the Bridge tab when a boy ran out of time before finishing his chores that day. This is explicitly NOT a behavior issue or punishment (it carries no point penalty and is separate from deductionReasons) — it's pure pattern-tracking. Don't mention it at all if it happened zero or one day this week; that's normal and not worth a sentence. If totals.daysOutOfTime is 2+ for a boy, note it once, neutrally, as a scheduling/pacing pattern worth John/Dawn knowing about (e.g. "ran out of time before finishing chores twice this week") — never frame it as a fault or lump it in with deductions/strikes.

CRITICAL — Exception Days: a day can carry "exceptionType" (e.g. "Travel/Campout", "Sick Day", "Doctor's Visit", "Holiday", or a custom type) and "exceptionNote". On that day, score/eligibleCompleted/eligibleTotal are null — same as a weekend — because normal chore expectations were deliberately lifted, NOT because he underperformed. This is the single most important rule in this whole prompt: NEVER read an exception day as a slump, a bad day, or a gap in the data to explain away — name it plainly and matter-of-factly instead, the same way you'd note a weekend ("Friday was a planned campout, no chores were expected" — not "chores dropped off Friday" or any phrasing that implies something went wrong). If totals.daysException is 0, say nothing about it. If a boy had a rough-looking stretch of low scores or missed strikes RIGHT AROUND an exception day, check whether the exception explains it before characterizing it as a pattern — an exception day breaks a streak calculation, it doesn't represent a bad one.

Include a short, natural mention of what a boy's been asking Tom about, woven into his summary — genuine interests or recurring topics worth John/Dawn knowing about (each conversation entry's "category" tells you the kind of question: app_help/verse_lookup/reveal are routine and free, interest/learning/devotional cost a wish, declined_* means Tom turned the question away). Summarize the gist age-appropriately — don't quote the conversation verbatim — UNLESS a conversation was declined for sibling conflict, discipline/trouble, or rule-bypass reasons (category starts with "declined_sibling", "declined_discipline", or "declined_rulebypass"), which is worth naming specifically since it's the same territory parents already track through moderation strikes. Purely off-topic or app-help declines aren't worth flagging. If a boy had no Tom conversations this week, don't force a mention — say so in one clause at most, don't dwell on it.

Each boy's data also carries "couragedareCompletedThisWeek" (a count — the 40-day Courage Dare devotional) and, separately, "reflectionCompletedThisWeek"/"reflections" (Today's Reflection, a distinct 5-question private daily form — strength/mission/step/practice/tomorrow — NOT the same thing as Courage Dare, don't conflate them). Mention completion counts for both briefly if either is 0 for the week (say so plainly, don't pad) or notably strong (most/all weekdays). "reflections" holds the actual entries for days he filled one out — if something in a specific field stands out as worth John/Dawn knowing (a real struggle named in "step," a genuine goal in "tomorrow"), you may reference it gently and non-judgmentally, the same restraint you'd use for a Tom conversation — this is his own private self-reflection, not a behavior log.

Each boy's data also carries "prayer" ({submitted:[{forWho,txt,by}], answered:[{forWho,txt,how}]}) and "crowsnest" ([{txt}]) — prayer requests attributed to him (either he submitted it himself, or someone else's request was clearly for him by name) and Crow's Nest praise/gratitude entries he personally logged that week. These are genuine spiritual-life signals worth a brief, warm mention if present — a boy bringing a real prayer request, one of his being answered, or him logging something he saw God do all say something worth John/Dawn knowing, distinct from the chore/behavior data. Don't force a mention if both are empty; one clause at most, don't dwell on it. Don't quote a prayer request or praise entry verbatim if it's sensitive-sounding — summarize gently, the same restraint you'd use for a Tom conversation.

Each boy's data also carries "totals.sessionsPossible"/"sessionsUsedCount"/"sessionsMaxedCount" — pre-tallied across his 3 daily session windows (morning/after-lunch/after-dinner screen-time windows) × every day this week; use these three numbers directly rather than recounting his per-day "sessions" objects yourself. Only worth a mention if a real week-level PATTERN shows up — consistently maxing nearly every session (sessionsMaxedCount close to sessionsPossible), or barely using the time at all (sessionsUsedCount low relative to sessionsPossible) — not for an ordinary, unremarkable week of usage, which needs no comment at all. Each day's own "sessions" object ({session1/session2/session3}, each either null — never logged into that window — or {elapsedSeconds, ranOver}) is there only for citing one specific day if something stands out (e.g. a day that ran well over 30 minutes in a window) — never state a day's session sat unused unless its entry is genuinely null. Keep this to at most one clause; it's minor context next to the chore/behavior data, not a headline.

Never invent a detail, a day, or an incident that isn't in the data you're given. Keep each boy's summary to a tight paragraph or two — a parent should be able to read all four in under a minute. Plain prose, no markdown headers or bullet lists within a summary (the surrounding UI already provides structure).

The household summary is separate: cover White Glove inspection patterns and results across the boys collectively, "prayerHousehold" ({submitted, answered} — same shape as above, but requests not attributable to a specific boy: usually a parent's own request, or for someone outside the family) and "crowsnestHousehold" (praise entries John or Dawn logged), and anything else week-level worth noting from the data — 2-4 sentences, same grounded, specific style. Treat the household prayer/praise data the same way as each boy's: a brief, warm mention if present, nothing forced if empty. For any White Glove pass/fail counts (per boy, per room, or per day-of-week), use the pre-tallied numbers in whiteglove.summary.byBoy, whiteglove.summary.byRoom, and whiteglove.summary.byDayOfWeek directly — do not recount them yourself from the nested whiteglove.days data, which is there only for citing specific incidents (a particular day/window that failed), not for arithmetic. byDayOfWeek is only worth mentioning if a real weekday clustering shows up (e.g. most failures landing on the same one or two weekdays) — that's a scheduling pattern worth naming, distinct from a general consistency problem; don't force a mention if the failures are just spread evenly across the week.

Also include a brief Muster summary in the household section — real specifics, not just a count. Each boy's own "muster" field (boys.{id}.muster) carries his week's login activity: "totalAttempts"/"totalSuccess"/"totalFailed", "byMethod" (qr vs pin-fallback counts), "failedAttempts" (a list of {when, method} for his own failed logins, already pre-tallied — cite these directly rather than recounting), and "rapidReloginCount" (a pre-tallied count of how many of his logins this week landed within 10 minutes of his previous one). These two patterns look similar on the surface (both show up as elevated totalAttempts/totalFailed) but mean very different things, and you must check rapidReloginCount BEFORE reaching for a card/PIN explanation:
- A HIGH rapidReloginCount (roughly a third or more of his totalAttempts) means he's repeatedly being sent back through re-authentication in quick succession — that reads as a navigation/session pattern, not a hardware problem, and should be described that way (e.g. "Daniel logged in 43 times this week, many in quick clusters minutes apart — that's a navigation pattern worth knowing about, not necessarily a card problem"). Do NOT suggest his card or PIN is unreliable when the clustering is what's driving the numbers.
- A LOW rapidReloginCount alongside 2+ genuinely spread-out failedAttempts (scattered across different times/days, not clustered) is the pattern actually worth a card/PIN mention (e.g. "Daniel had 3 failed login attempts this week, spread across different days — may be worth checking if his card or PIN is giving him trouble").
- If failures are 0-1, qr is his normal method, and rapidReloginCount is low, say nothing about him. Never guess at a cause the data doesn't actually support — if the pattern doesn't clearly match either case above, describe the numbers plainly without naming a cause at all.
"musterHousehold" carries "totalFailed" and "unknownFailed" (failed attempts not tied to any boy's identity, with "unknownFailedAttempts" giving {when, method, device} for each) — mention the unknown-failed count if it's nonzero, and name a specific one if something about it looks genuinely worth a glance (an odd hour, an unfamiliar device, a cluster of several in a short window) — but this is informational pattern-tracking, not an alarm system, so don't editorialize or imply a security incident from a single stray attempt. "musterHousehold" also carries pre-tallied parent-assist activity: "assistSessionCount" (total parent-assist/parent-view sessions all week), "assistByParent" ({john, dawn} counts), and "assistByDayOfWeek" (count per weekday — only worth mentioning if it clusters on one or two days). Use these counts directly rather than trying to reconstruct a timeline. boys.{id}.muster.assistSessions gives a specific, per-boy list ({parent, method, when}) ONLY for sessions where a parent was actively assisting or boarded as that specific boy (not general picker-screen viewing, which isn't attributed to one boy) — cite one of these directly if it's notable. Mention parent-assist activity briefly if it happened that week, as useful context distinct from the boys' own independent logins; say nothing if there was none. If nothing stands out anywhere in Muster this week (low failures, no unknowns, no assist sessions), a single plain sentence saying logins were routine is enough — don't manufacture texture that isn't there.

"teachMe" (null if nobody's touched Teach Me Vote at all this week — say nothing in that case) carries this week's winning topic ("winnerTopic"), how many boys suggested a topic vs. actually voted ("suggestedByCount"/"votedByCount" — worth a clause if participation was notably low, e.g. only 1 of 4 voted), and the real website/family-day suggestions generated for the winning topic along with their approval "status" (pending/approved/denied — a pending suggestion just means nobody's reviewed it yet, not a problem to flag). Mention the winning topic and participation briefly; only mention a specific website or family-day suggestion by name if it's already approved — a still-pending one isn't real yet, so don't build anticipation around it. The family day suggestion also carries "happened" (true/false/undefined) and "reflection" once John or Dawn has actually verified it — this is the full loop (topic won → suggestion approved → family day actually happened → how it went), worth closing the loop on in one sentence if "happened" is set: name whether it happened and, if there's a real reflection, a brief honest note of how it went. If "happened" is still undefined, that just means it hasn't been verified yet — don't treat that as a problem either.

Galley Report is its own third section, separate from both boys and household — meal-plan planning and adherence for the week, from real Kitchen/Galley data. This is the first section aimed at long-range household planning rather than accountability, so the tone should read as a planning aid, not a grade.

"galley.timing" tells you whether this week's dinner plan was ever created and, if so, when relative to the week it covers. Its "status" is exactly one of "on time" (planned before or on the week's own Sunday), "last-minute" (planned after that Sunday had already passed), or "not planned" (no plan was ever generated for that week at all) — state this plainly using the status value directly, don't form your own judgment from raw dates. If "editCount" is 2 or more, you may note once that the plan was revised multiple times before nights arrived — skip it entirely if 0 or 1, that's normal and not worth a sentence.

"galley.adherence" covers what actually got cooked against what was planned, across the week's 7 real nights: "followedCount" (dinner matched the plan), "changedCount" (it didn't), and "unverifiedCount" (nobody in the Galley confirmed either way that night — a gap in the DATA itself, not evidence either way about what actually happened; if this is high, say so plainly as its own observation rather than folding those nights into "followed" or "changed"). Use these three pre-tallied counts directly — do not recount them yourself from the nights list. For "changedCount" nights, "changedDetails" gives you the real planned meal and the real reason cited for each — aggregate genuine patterns from these specifics (e.g. "3 of 7 nights changed, most often citing missing ingredients," or "changed twice this week, both times for family preference"), never just a bare count with no texture. If a real pattern shows up worth nudging toward healthier planning — "ate out" recurring, or a specific meal or ingredient gap showing up more than once — surface it once, gently, as something worth knowing for planning ahead, never as a criticism. If followedCount and changedCount are both 0 (nothing was verified all week), say plainly that no meals were verified this week rather than manufacturing a pattern from it.

Keep the Galley Report section to 2-4 sentences, same grounded, specific style as household.`;

const REPORT_WRITEUP_SCHEMA = {
  type: 'object',
  properties: {
    boys: {
      type: 'object',
      properties: {
        samuel: { type: 'string' },
        johnjr: { type: 'string' },
        stephen: { type: 'string' },
        daniel: { type: 'string' }
      },
      required: ['samuel', 'johnjr', 'stephen', 'daniel'],
      additionalProperties: false
    },
    household: { type: 'string' },
    galley: { type: 'string' }
  },
  required: ['boys', 'household', 'galley'],
  additionalProperties: false
};

async function generateReportCardWriteup(reportData) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: REPORT_WRITEUP_MODEL,
    max_tokens: 2000,
    system: REPORT_WRITEUP_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: REPORT_WRITEUP_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Week of ${reportData.weekOf} through ${reportData.weekEnd}${reportData.isPartialWeek ? ' — week still in progress, only summarize days that have actually happened' : ''}.\n\nRaw data:\n${JSON.stringify({ boys: reportData.boys, whiteglove: reportData.whiteglove, dawn: reportData.dawn, prayerHousehold: reportData.prayerHousehold, crowsnestHousehold: reportData.crowsnestHousehold, musterHousehold: reportData.musterHousehold, galley: reportData.galley, teachMe: reportData.teachMe })}`
    }]
  });

  await logTinkUsage(REPORT_WRITEUP_MODEL, response.usage);

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(raw);
}

// The copy-paste-friendly plain-text version John wants to paste into
// Claude.ai — built from the same narrative content as the styled UI, not
// a second independently-generated write-up, so the two can never diverge.
function buildPlainTextReportCard(reportData, writeup) {
  const lines = [`WEEKLY REPORT CARD — Week of ${reportData.weekOf}${reportData.isPartialWeek ? ' (in progress)' : ''}`, ''];
  ALLOWED_AGENT_IDS.forEach(id => {
    lines.push((AGENT_DISPLAY_NAMES[id] || id).toUpperCase());
    lines.push(writeup.boys[id] || '');
    lines.push('');
  });
  lines.push('HOUSEHOLD');
  lines.push(writeup.household || '');
  lines.push('');
  lines.push('GALLEY REPORT');
  lines.push(writeup.galley || '');
  return lines.join('\n').trim();
}

// Runs Step 1's aggregation, then Step 2's write-up, and stores both
// together at stewart/reportcards/{weekOf} — the one shared record the
// manual Regenerate button, the nightly current-week auto-refresh, and
// the Monday completed-week auto-run all produce, and both UIs read.
async function buildFullWeeklyReportCard(weekOf) {
  const reportData = await aggregateWeeklyReportData(weekOf);
  const writeup = await generateReportCardWriteup(reportData);
  const plainText = buildPlainTextReportCard(reportData, writeup);

  await db.ref(`stewart/reportcards/${weekOf}`).update({ writeup, plainText });

  return { ...reportData, writeup, plainText };
}

// On-demand "Regenerate" (combined-batch-punchlist.md Part 1) — the report
// now refreshes automatically every night (autoGenerateDailyReportCard,
// below), so this button is no longer how a report gets its first
// generation; it's for the specific case John or Dawn fixed a data issue
// and wants immediate recalculation rather than waiting for the next
// automatic refresh. Defaults to the CURRENT week (a live, possibly
// partial snapshot) — same target the nightly job uses.
exports.generateWeeklyReportCard = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onCall(async (data, callableContext) => {
    const { weekOf } = data || {};
    const targetDate = (typeof weekOf === 'string' && DATE_RE.test(weekOf)) ? weekOf : easternDateStr();
    return buildFullWeeklyReportCard(mostRecentMonday(targetDate));
  });

// Keeps the CURRENT week's report fresh every night without a manual tap
// (combined-batch-punchlist.md Part 1) — so opening Bridge or Officers'
// Country any day shows real data through today, not stale data from
// whenever someone last hit Regenerate. Targets exactly what the
// Regenerate button targets: mostRecentMonday(easternDateStr()). On a
// Monday this runs at the same hour as autoGenerateWeeklyReportCard below
// but writes a DIFFERENT key — this one the brand-new week that just
// started, that one the week that just ended — so there's no conflict
// between the two, they're not duplicating each other's work.
exports.autoGenerateDailyReportCard = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .pubsub.schedule('0 6 * * *')
  .timeZone('America/New_York')
  .onRun(async () => {
    const weekOf = mostRecentMonday(easternDateStr());
    await buildFullWeeklyReportCard(weekOf);
    return null;
  });

// Fires every Monday morning Eastern, and now also RESOLVES "today" in
// Eastern time (easternDateStr), not just fires at an Eastern hour — so
// this is correct right at the boundary too, not just "comfortably clear"
// of it. Distinct purpose from autoGenerateDailyReportCard above: this
// one finalizes the week that just ENDED (previousWeekMonday) once it's
// actually complete, giving a stable "final" report for a finished week
// rather than leaving its last snapshot wherever the daily job left it
// the morning before Sunday was even over.
exports.autoGenerateWeeklyReportCard = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .pubsub.schedule('0 6 * * 1')
  .timeZone('America/New_York')
  .onRun(async () => {
    const weekOf = previousWeekMonday(easternDateStr());
    await buildFullWeeklyReportCard(weekOf);
    return null;
  });

// ════════════════════════════════════════════════════
// TEACH ME VOTE — website + family day suggestions when a topic wins
// (combined-batch-punchlist.md Part 3). stewart/teachvote/{weekKey}
// already exists (boys/index.html, dashboard/index.html):
// {suggestions:{agentId:optionId}, votes:{agentId:optionId}, winner}.
// This adds websiteSuggestions/{pushId} and familyDaySuggestion once a
// winner is known — both start 'pending', needing a parent's approval
// before they're treated as real (same pattern Tom's own interest-
// suggestion flow already uses for stewart/tomWebsiteRequests: a
// proposal only becomes real once a parent explicitly approves it).
// ════════════════════════════════════════════════════
const TEACH_ME_TOPICS = {
  bike: 'Bike Maintenance — fix flats, adjust brakes, tune gears',
  tools: 'Tool Basics — measure, cut, drill, build something',
  car: 'Car Basics — oil, tires, jump starts, under the hood',
  knots: 'Knots & Rope Work — Trail Life knots, lashing, rescue lines',
  fire: 'Fire Building — tinder to fire, safely and fast',
  firstaid: 'First Aid — cuts, burns, sprains, emergencies',
  cooking: 'Campfire Cooking — cast iron, camp stove, open flame',
  navigation: 'Map & Navigation — read a map, use a compass, find your way',
  woodwork: 'Basic Woodworking — measure twice, cut once, build something real',
  fishing: 'Fishing Basics — knots, bait, casting, cleaning a fish',
  electrical: 'Basic Electrical — circuits, outlets, safe wiring basics',
  plumbing: 'Basic Plumbing — shut-offs, fixing leaks, unclogging drains'
};

const TEACH_ME_SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    websites: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, url: { type: 'string' }, reason: { type: 'string' } },
        required: ['name', 'url', 'reason'],
        additionalProperties: false
      }
    },
    familyDayActivity: { type: 'string' },
    familyDayReason: { type: 'string' }
  },
  required: ['websites', 'familyDayActivity', 'familyDayReason'],
  additionalProperties: false
};

async function generateTeachMeSuggestions(topicDesc) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    system: `You help a family of four boys (ages 7-13) plan a "Teach Me" learning week around a topic they voted on, plus a related family day activity. Suggest 1-2 REAL, well-known, kid-appropriate websites (real names and real URLs you're confident actually exist and are safe for kids — never invent a site) that would help them learn this topic. Also suggest ONE real, concrete family day activity idea tied to the same topic — something achievable in a single day, not vague ("visit a real bike shop for a tune-up class," not "learn about bikes together"). Keep each reason to one sentence.`,
    output_config: { format: { type: 'json_schema', schema: TEACH_ME_SUGGEST_SCHEMA } },
    messages: [{ role: 'user', content: `This week's Teach Me topic: ${topicDesc}` }]
  });
  await logTinkUsage('claude-sonnet-4-6', response.usage);
  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(raw);
}

// Fires Friday morning Eastern — the exact moment the client's own phase
// computation (dow 1=suggest, 2-4=vote, 5-0=closed) already treats voting
// as closed, so this doesn't preempt a vote still in progress.
exports.closeTeachMeVote = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .pubsub.schedule('0 6 * * 5')
  .timeZone('America/New_York')
  .onRun(async () => {
    const weekKey = mostRecentMonday(easternDateStr());
    const ref = db.ref(`stewart/teachvote/${weekKey}`);
    const snap = await ref.once('value');
    const data = snap.val() || {};

    // Idempotent — a real Anthropic call shouldn't fire twice for the same
    // week even if this scheduled run somehow triggers more than once.
    if (data.websiteSuggestions || data.familyDaySuggestion) return null;

    let winner = data.winner;
    if (!winner) {
      const votes = data.votes || {};
      const tally = {};
      Object.values(votes).forEach(v => { tally[v] = (tally[v] || 0) + 1; });
      const ranked = Object.keys(tally).sort((a, b) => tally[b] - tally[a]);
      winner = ranked[0] || null;
      if (winner) await ref.child('winner').set(winner);
    }
    if (!winner || !TEACH_ME_TOPICS[winner]) return null; // no votes cast this week — nothing to suggest against

    let result;
    try {
      result = await generateTeachMeSuggestions(TEACH_ME_TOPICS[winner]);
    } catch (e) {
      console.error('generateTeachMeSuggestions failed:', e);
      return null;
    }

    const now = Date.now();
    const writes = (result.websites || []).slice(0, 2).map(w => ref.child('websiteSuggestions').push({
      website: w.name, url: w.url, reason: w.reason, status: 'pending', timestamp: now
    }));
    writes.push(ref.child('familyDaySuggestion').set({
      activity: result.familyDayActivity, reason: result.familyDayReason, status: 'pending', timestamp: now
    }));
    await Promise.all(writes);
    return null;
  });

// ════════════════════════════════════════════════════
// RED SKY AT MORNING / RED SKY AT NIGHT (combined-batch-punchlist.md
// Part 7) — Matthew 16:2-3, "When it is evening, ye say, It will be fair
// weather... can ye not discern the signs of the times?" Two personal
// daily reports per boy, Tom's voice, live in Compass — zero sibling
// data, ever. Reuses the parent report card's scoping discipline (one
// boy's own real numbers, nothing invented) but for a single day, not a
// week, and in Tom's voice, not a parent-facing summary.
// ════════════════════════════════════════════════════

// Own White Glove rooms only for the given day — whichever room(s) he
// was the assigned officer for (or "All Hands"), across any inspection
// window, pass/fail. Never another boy's room. Mirrors mission-engine.js's
// wgFailedRoomsForAgent()'s officer-scoping exactly, but returns pass AND
// fail (Red Sky at Night needs to celebrate a real pass, not just flag
// failures) rather than only failures.
function ownWhiteGloveRoomsForDay(wgDay, agentId) {
  const rooms = [];
  if (!wgDay) return rooms;
  ['morning', 'afternoon', 'evening'].forEach(win => {
    const winRooms = (wgDay[win] && wgDay[win].rooms) || {};
    Object.entries(winRooms).forEach(([roomId, r]) => {
      if (!r || r.na) return;
      if (r.officer !== agentId && r.officer !== 'all') return;
      const passed = ['trash', 'dishes', 'clothing', 'floor', 'counters'].every(k => r[k] === true);
      rooms.push({ room: WG_ROOM_LABELS[roomId] || roomId, window: win, passed });
    });
  });
  return rooms;
}

async function fetchRedSkyDayData(agentId, dateStr) {
  const [scoreSnap, eligibleSnap, deductionSnap, wishSnap, strikeSnap, wgSnap] = await Promise.all([
    db.ref(`stewart/scores/${agentId}/${dateStr}`).once('value'),
    db.ref(`stewart/eligible/${agentId}/${dateStr}`).once('value'),
    db.ref(`stewart/deductions/${agentId}/${dateStr}`).once('value'),
    db.ref(`stewart/wishes/${agentId}/${dateStr}`).once('value'),
    db.ref(`stewart/strikes/${agentId}/${dateStr}`).once('value'),
    db.ref(`stewart/whiteglove/${dateStr}`).once('value')
  ]);
  const deductions = deductionSnap.val() || {};
  const wishes = wishSnap.val() || {};
  const strikeRec = strikeSnap.val() || {};
  return {
    date: dateStr,
    score: scoreSnap.val(),
    eligible: eligibleSnap.val(),
    deductionReasons: Object.keys(deductions).filter(k => k !== 'outOfTime'),
    ranOutOfTime: deductions.outOfTime !== undefined,
    wishesEarned: wishes.earned || 0,
    wishesUsed: wishes.used || 0,
    strikeCount: strikeRec.count || 0,
    strikeIncidents: Object.values(strikeRec.incidents || {}),
    ownWhiteGloveRooms: ownWhiteGloveRoomsForDay(wgSnap.val(), agentId)
  };
}

const RED_SKY_MATTHEW_INTRO = `This is his FIRST time ever seeing a Red Sky report. Open by referencing Matthew 16:2-3 naturally, briefly (one or two sentences woven in, not a sermon) — Jesus's own words: "When it is evening, ye say, It will be fair weather: for the sky is red. And in the morning, It will be foul weather to day: for the sky is red and lowering... can ye not discern the signs of the times?" Tie it to how a sailor learns to read the sky as warning or promise — that's what these two reports are for him now.`;

const RED_SKY_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false
};

async function generateRedSkyMessage(type, agentId, agentName, age, dayData, isFirstTime) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const roleInstructions = type === 'morning'
    ? `This is RED SKY AT MORNING — he's just opened it, reviewing YESTERDAY. Forward-looking and gentle: name what actually went rough yesterday if anything did (a low score, a strike, a failed White Glove room, running out of time) plainly but without dwelling — then pivot firmly to today as a fresh start, "let's not repeat yesterday's mistakes," never a scolding. If yesterday was genuinely clean (good score, no strikes, rooms passed), say so plainly and warmly — don't manufacture a rough patch that isn't in the data. 2-4 sentences.`
    : `This is RED SKY AT NIGHT — today's good report, only ever shown after every one of today's missions is actually done, so this IS a real earned moment. Celebrate today specifically and concretely (real numbers, real specifics — which rooms he passed, wishes earned, a clean conduct day) — warm, proud, earned, not generic cheerleading. If something today wasn't perfect despite finishing all missions (a strike, a failed room) still be honest about it, but the overall frame stays a genuine win — he finished the mission. 2-4 sentences.`;
  const system = `${TOM_VOICE}\n\n${tomAgeGuidance(age, agentName)}\n\n${roleInstructions}${isFirstTime ? '\n\n' + RED_SKY_MATTHEW_INTRO : ''}\n\nUse ONLY the real data given below — never invent a detail, an incident, or a number that isn't there. This is his own data only; there is no sibling information available to you and none should ever be implied.`;

  const response = await anthropic.messages.create({
    model: TOM_MODEL,
    max_tokens: 400,
    system,
    output_config: { format: { type: 'json_schema', schema: RED_SKY_SCHEMA } },
    messages: [{ role: 'user', content: `${agentName}'s real data for ${dayData.date}:\n${JSON.stringify(dayData)}` }]
  });
  await logTomUsage(agentId, response.usage);
  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(raw).message;
}

exports.generateRedSkyReport = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onCall(async (data, callableContext) => {
    const { agentId, type } = data || {};
    if (!agentId || !ALLOWED_AGENT_IDS.includes(agentId)) {
      throw new functions.https.HttpsError('invalid-argument', 'A valid agentId is required.');
    }
    if (type !== 'morning' && type !== 'night') {
      throw new functions.https.HttpsError('invalid-argument', 'type must be "morning" or "night".');
    }

    const agentName = AGENT_DISPLAY_NAMES[agentId];
    const age = AGENT_AGES[agentId];

    let targetDate;
    if (type === 'morning') {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      targetDate = easternDateStr(y);
    } else {
      targetDate = easternDateStr();
      // Night is gated on full chore completion, server-side — a real
      // earned moment, not just a client-side hide a boy could route
      // around by calling the function directly.
      const eligSnap = await db.ref(`stewart/eligible/${agentId}/${targetDate}`).once('value');
      const elig = eligSnap.val();
      const allDone = !!(elig && elig.total > 0 && elig.completed >= elig.total);
      if (!allDone) {
        return { locked: true, message: "Not tonight, sailor — finish today's missions first. This one's earned." };
      }
    }

    const dayData = await fetchRedSkyDayData(agentId, targetDate);
    const seenRef = db.ref(`stewart/redsky/${agentId}/seenIntro`);
    const seenSnap = await seenRef.once('value');
    const isFirstTime = !seenSnap.val();
    if (isFirstTime) await seenRef.set(true);

    const message = await generateRedSkyMessage(type, agentId, agentName, age, dayData, isFirstTime);
    return { locked: false, message, date: targetDate };
  });

// ════════════════════════════════════════════════════
// DAWN'S PERSONAL DAILY REPORT (combined-batch-punchlist.md Part 11) —
// delivered through Tink, in Tink's existing plain/warm/practical voice
// (no persona, no catchphrases — same TINK_SYSTEM_PROMPT everything else
// through Tink already uses). Explicitly NOT a second copy of the
// household weekly report: no boy-by-boy behavioral analysis, no full
// data dump — her own tasks, her own patterns, and actionable relational
// prompts only.
// ════════════════════════════════════════════════════

async function fetchDawnDailyData() {
  const today = easternDateStr();
  const yesterday = easternDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const last7Dates = [];
  for (let i = 0; i < 7; i++) last7Dates.push(easternDateStr(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));

  const [
    gdCurrentDaySnap, wgTodaySnap, mealVerifYesterdaySnap, planSnap, teachVoteSnap,
    wgLast7Snaps, gdProgressSnap, strikesTodaySnaps, messagesSnaps
  ] = await Promise.all([
    db.ref('stewart/gracedare/progress/currentDay').once('value'),
    db.ref(`stewart/whiteglove/${today}`).once('value'),
    db.ref(`stewart/mealverification/${yesterday}`).once('value'),
    db.ref('stewart/plan').once('value'),
    db.ref(`stewart/teachvote/${mostRecentMonday(today)}`).once('value'),
    Promise.all(last7Dates.map(d => db.ref(`stewart/whiteglove/${d}`).once('value'))),
    db.ref('stewart/gracedare/progress').once('value'),
    Promise.all(ALLOWED_AGENT_IDS.map(id => db.ref(`stewart/strikes/${id}/${today}`).once('value'))),
    Promise.all(ALLOWED_AGENT_IDS.map(id => db.ref(`stewart/messages/${id}`).once('value')))
  ]);

  // ── Today's pending tasks ──
  const gdDay = gdCurrentDaySnap.val() || 1;
  const gdTodayDoneSnap = await db.ref(`stewart/gracedare/progress/day${gdDay}/completed`).once('value');
  const graceDareToday = !!gdTodayDoneSnap.val();

  const wgToday = wgTodaySnap.val() || {};
  const wgWindowsLogged = ['morning', 'afternoon', 'evening'].filter(w => wgToday[w]);
  const wgWindowsRemaining = ['morning', 'afternoon', 'evening'].filter(w => !wgToday[w]);

  // Reuses the exact skip logic Galley Report Step 2/3 already established
  // — a real planned dinner, unverified, is the only thing worth flagging.
  const MEAL_VERIFY_SKIP_NAMES = ['No Meal -- not cooking', 'Open -- choose from library'];
  let galleyVerificationPending = false;
  if (!mealVerifYesterdaySnap.val()) {
    const plan = planSnap.val();
    if (Array.isArray(plan)) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const yDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yDayName = dayNames[yDate.getDay()];
      const slot = plan.find(s => s.day === yDayName);
      if (slot && slot.mealName && !MEAL_VERIFY_SKIP_NAMES.includes(slot.mealName)) galleyVerificationPending = true;
    }
  }

  const teachVoteData = teachVoteSnap.val() || {};
  const teachMePendingCount =
    Object.values(teachVoteData.websiteSuggestions || {}).filter(w => w.status === 'pending').length +
    (teachVoteData.familyDaySuggestion && teachVoteData.familyDaySuggestion.status === 'pending' ? 1 : 0);

  // ── Her own patterns, last 7 days ──
  const gdProgress = gdProgressSnap.val() || {};
  const graceDareLast7 = last7Dates.filter(d => {
    // day-number keys aren't calendar dates — count via completedAt timestamps instead
    return Object.values(gdProgress).some(day => day && day.completedAt &&
      easternDateStr(new Date(day.completedAt)) === d && day.completed);
  }).length;
  const whiteGloveDaysLogged7 = wgLast7Snaps.filter(s => s.val() && Object.keys(s.val()).length > 0).length;

  // ── Sibling confrontations, surfaced as actionable prompts ──
  // Real, already-logged signal: a boy asking Tom to referee a sibling
  // issue (declined_sibling) in the last few days — never quoted
  // verbatim, just which boy and roughly when.
  const siblingPromptCutoff = Date.now() - 4 * 24 * 60 * 60 * 1000;
  const siblingPrompts = [];
  const tomchatSnaps = await Promise.all(ALLOWED_AGENT_IDS.map(id => db.ref(`stewart/tomchat/${id}`).once('value')));
  tomchatSnaps.forEach((snap, i) => {
    const agentId = ALLOWED_AGENT_IDS[i];
    const entries = Object.values(snap.val() || {});
    const hits = entries.filter(e => e && e.category === 'declined_sibling' && e.timestamp >= siblingPromptCutoff);
    if (hits.length) siblingPrompts.push({ agentName: AGENT_DISPLAY_NAMES[agentId], count: hits.length, mostRecent: easternDateStr(new Date(Math.max(...hits.map(h => h.timestamp)))) });
  });

  // ── Her own interaction pattern with each boy ──
  const interactionByBoy = {};
  messagesSnaps.forEach((snap, i) => {
    const agentId = ALLOWED_AGENT_IDS[i];
    const entries = Object.values(snap.val() || {}).filter(e => e && e.from === 'Mom');
    const lastMs = entries.length ? Math.max(...entries.map(e => e.timestamp || 0)) : null;
    interactionByBoy[agentId] = {
      agentName: AGENT_DISPLAY_NAMES[agentId],
      daysSinceLastMessage: lastMs ? Math.floor((Date.now() - lastMs) / (24 * 60 * 60 * 1000)) : null
    };
  });

  // ── Needs your attention — genuinely time-sensitive only ──
  const needsAttention = [];
  strikesTodaySnaps.forEach((snap, i) => {
    const rec = snap.val();
    const hasUnkindToday = rec && Object.values(rec.incidents || {}).some(inc => inc.category === 'unkind');
    if (hasUnkindToday) needsAttention.push(`${AGENT_DISPLAY_NAMES[ALLOWED_AGENT_IDS[i]]} had an unkindness strike today`);
  });
  if (galleyVerificationPending) needsAttention.push("Yesterday's dinner hasn't been verified in the Galley yet");

  return {
    today: {
      graceDareCompleted: graceDareToday,
      whiteGloveWindowsLogged: wgWindowsLogged,
      whiteGloveWindowsRemaining: wgWindowsRemaining,
      galleyVerificationPending,
      teachMePendingCount
    },
    patterns: {
      graceDareDaysThisWeek: graceDareLast7,
      whiteGloveDaysLoggedThisWeek: whiteGloveDaysLogged7
    },
    siblingPrompts,
    interactionByBoy,
    needsAttention
  };
}

const DAWN_DAILY_SCHEMA = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false };

async function generateDawnDailyMessage(dayData) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const system = `${TINK_SYSTEM_PROMPT}

You're writing Dawn's personal daily briefing — distinct from the shared household weekly report and distinct from the boys' own Red Sky reports, both of which already cover full behavioral detail. This is about HER day only: her own pending tasks (framed as encouragement to complete them, not a guilt list), a light mirror of her own completion patterns (practical/task-oriented, not emotional), actionable relational prompts, and genuinely time-sensitive items only. Tie any encouragement to her own real completion numbers (streaks, consistency) rather than generic cheerleading.

Explicitly do NOT include: detailed boy-by-boy behavioral analysis of everything that happened that day/week — that's the shared weekly report's job, not this one. Don't turn this into a second household report.

Structure, in plain prose (no markdown headers), 4-6 sentences total:
- Her pending tasks today, warmly: Grace Dare, remaining White Glove windows, Galley meal verification if pending, Teach Me admin if anything's pending approval. Skip anything already done — don't list a completed task as if it's still pending.
- A brief, real mention of her own pattern this week (Grace Dare days completed, White Glove days logged) — only if it's actually notable (a strong streak worth naming, or a real gap worth a gentle nudge); don't force a mention of an unremarkable middling number.
- If "siblingPrompts" has any entries, surface each as a direct, actionable prompt — which boy, roughly when, framed as "worth a follow-up conversation," never quoting what was actually said.
- If "interactionByBoy" shows a boy she hasn't messaged in a while (use judgment — several days with no private message is worth a gentle nudge, one or two days is not), a light, non-grading reflection prompt — this is about her awareness, not a metric she's failing.
- If "needsAttention" has entries, name them plainly and directly — these are the only genuinely time-sensitive items, everything else in this message is a softer, encouraging nudge.
- If today.graceDareCompleted is true and all White Glove windows are logged and nothing else needs attention, it's fine — even good — for this to be short and simply affirming.

Never invent a detail, a task, or a pattern that isn't in the data given below.`;

  const dawnDailyModel = 'claude-sonnet-4-6';
  const response = await anthropic.messages.create({
    model: dawnDailyModel,
    max_tokens: 500,
    system,
    output_config: { format: { type: 'json_schema', schema: DAWN_DAILY_SCHEMA } },
    messages: [{ role: 'user', content: `Dawn's real data for today:\n${JSON.stringify(dayData)}` }]
  });
  await logTinkUsage(dawnDailyModel, response.usage);
  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(raw).message;
}

// Cached per real day (stewart/dawnDaily/{date}) — a real Sonnet call for
// every tab visit would be wasteful for something that only meaningfully
// changes once a day; `force` (the UI's own refresh button) bypasses the
// cache for the specific case something changed since this morning and
// she wants it recalculated now, mirroring the report card's own
// Regenerate-vs-automatic distinction.
exports.generateDawnDailyReport = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onCall(async (data) => {
    const force = !!(data && data.force);
    const today = easternDateStr();
    const cacheRef = db.ref(`stewart/dawnDaily/${today}`);
    if (!force) {
      const cached = await cacheRef.once('value');
      if (cached.val()) return cached.val();
    }
    const dayData = await fetchDawnDailyData();
    const message = await generateDawnDailyMessage(dayData);
    const result = { message, generatedAt: Date.now() };
    await cacheRef.set(result);
    return result;
  });

// ════════════════════════════════════════════════════
// PRIVATE JOURNAL — TOM'S DUAL NUDGE (combined-batch-punchlist.md Part 12)
// stewart/journal/{agentId}/{pushId} = {text, timestamp} — a boy's own,
// genuinely private entries. This section's entire design exists to
// answer one question safely: when something recurs across MULTIPLE
// separate entries (not a one-off), (a) gently nudge the boy himself to
// talk to Mom/Dad, and (b) tell John/Dawn a bare topic category — never
// content, never a quote, never a paraphrase close enough to reconstruct
// what he actually wrote.
//
// The privacy guarantee here is structural, not just a prompt
// instruction: the ONLY call that ever sees raw journal text
// (classifyJournalPattern) is constrained by JSON schema to output
// nothing but one value from a fixed, closed enum — it is not physically
// possible for that call to return free text, a summary, or a quote. The
// two things built FROM that category (the boy's nudge, the parent
// prompt) are separate calls/templates that are only ever given the
// category string itself — they never see the raw entries at all, so
// there's nothing in their own context to leak even if they tried.
// ════════════════════════════════════════════════════

// Deliberately closed, not free text — this is what makes "can't be
// reverse-engineered into what he actually wrote" a real guarantee
// instead of a hope. Broad enough to be useful to a parent, vague enough
// that knowing the category tells you nothing about the specifics.
const JOURNAL_TOPIC_CATEGORIES = [
  'Friendships', 'Family relationships', 'School or learning', 'Emotions or mood',
  'Body or health', 'Faith or spiritual struggle', 'Confidence or self-esteem', 'Something else'
];

// A genuine pattern needs at least this many total entries to even
// consider — recurrence across 1-2 entries isn't recurrence, it's just
// what he happened to write about recently.
const JOURNAL_MIN_ENTRIES_FOR_PATTERN = 3;
// Don't re-flag the exact same category again for at least this long —
// once is enough to prompt a conversation; nagging the boy and his
// parents daily about the same already-surfaced thing isn't the goal.
const JOURNAL_RECHECK_COOLDOWN_MS = 21 * 24 * 60 * 60 * 1000;

const JOURNAL_CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...JOURNAL_TOPIC_CATEGORIES, 'none'] }
  },
  required: ['category'],
  additionalProperties: false
};

// The ONLY function in this whole feature that ever reads raw journal
// text. Schema-enum-constrained output is the actual safeguard — even a
// misbehaving or manipulated model literally cannot return anything
// outside JOURNAL_TOPIC_CATEGORIES or 'none'.
async function classifyJournalPattern(entries) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const system = `You are reviewing a boy's private journal entries for his own eyes only — you will never repeat, quote, summarize, or paraphrase any of this content to anyone; your only output is a single category label. Look for a topic that genuinely RECURS across multiple SEPARATE entries (not just repeated within one entry, and not just a single mention) — something that keeps coming up for him. If a real recurring theme exists, return the single closest category from the fixed list. If nothing recurs — the entries are about different things, or only one entry touches a given topic — return "none". Do not return "none" just because a topic is heavy or sensitive; heaviness isn't the test, recurrence is. Do not invent a pattern that isn't genuinely there across multiple entries.`;
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 50,
    system,
    output_config: { format: { type: 'json_schema', schema: JOURNAL_CLASSIFY_SCHEMA } },
    messages: [{ role: 'user', content: `Entries, oldest first:\n${entries.map((e, i) => `${i + 1}. ${e.text}`).join('\n\n')}` }]
  });
  await logTinkUsage('claude-sonnet-4-6', response.usage);
  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(raw).category;
}

const JOURNAL_NUDGE_SCHEMA = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false };

// Given ONLY the category — never the raw entries — writes the private,
// in-voice nudge that lands in the boy's own thread. Safe by
// construction: there is no raw content in this call's context for it to
// leak even if it tried.
async function generateJournalBoyNudge(agentId, agentName, age, category) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const system = `${TOM_VOICE}\n\n${tomAgeGuidance(age, agentName)}\n\nHe's been journaling privately about something touching on "${category}" more than once lately — you don't know the specifics and never will, only that this general area keeps coming up for him. Write a short, gentle, private nudge (2-3 sentences) encouraging him to talk to Mom or Dad about it — an invitation, not a push, no guilt, no implication that journaling was wrong or that he's in trouble. Don't say the word "journal" explicitly — naming it outright reads like surveillance. Keep it feeling like Tom noticing him, not monitoring him.`;
  const response = await anthropic.messages.create({
    model: TOM_MODEL,
    max_tokens: 200,
    system,
    output_config: { format: { type: 'json_schema', schema: JOURNAL_NUDGE_SCHEMA } },
    messages: [{ role: 'user', content: `Category: ${category}` }]
  });
  await logTomUsage(agentId, response.usage);
  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(raw).message;
}

// Fixed template, not AI-generated — for the parent-facing notification
// specifically, a static template built from nothing but the category
// name is a stronger guarantee than trusting a model prompt every time,
// and there's no real benefit to variability here the way there is for
// Tom's own voice elsewhere.
function journalParentPromptText(agentName, category) {
  return {
    title: `Might be worth a check-in — ${agentName}`,
    body: `A topic around "${category}" has come up more than once for ${agentName} lately, in his own private journal. Nothing urgent, and no specifics to share — just worth a conversation with him when the moment feels right.`
  };
}

// Runs daily. Per boy: skip entirely if nothing's changed since the last
// check (no wasted Anthropic calls), skip if too few entries exist yet
// for "recurrence" to mean anything, skip if the same category was
// already flagged within the cooldown window. Only on a genuine, fresh
// pattern does anything get written or sent.
exports.detectJournalPatterns = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .pubsub.schedule('0 7 * * *')
  .timeZone('America/New_York')
  .onRun(async () => {
    for (const agentId of ALLOWED_AGENT_IDS) {
      try {
        const [entriesSnap, metaSnap] = await Promise.all([
          db.ref(`stewart/journal/${agentId}`).once('value'),
          db.ref(`stewart/journalPatterns/${agentId}/_meta`).once('value')
        ]);
        const entries = Object.values(entriesSnap.val() || {})
          .filter(e => e && e.text && typeof e.timestamp === 'number')
          .sort((a, b) => a.timestamp - b.timestamp);
        if (entries.length < JOURNAL_MIN_ENTRIES_FOR_PATTERN) continue;

        const meta = metaSnap.val() || {};
        if (meta.lastCheckedEntryCount === entries.length) continue; // nothing new since last check

        const category = await classifyJournalPattern(entries);
        await db.ref(`stewart/journalPatterns/${agentId}/_meta`).update({ lastCheckedEntryCount: entries.length, lastCheckedAt: Date.now() });
        if (category === 'none') continue;

        const cooldownActive = meta.lastFlaggedCategory === category &&
          meta.lastFlaggedAt && (Date.now() - meta.lastFlaggedAt) < JOURNAL_RECHECK_COOLDOWN_MS;
        if (cooldownActive) continue;

        const agentName = AGENT_DISPLAY_NAMES[agentId];
        const age = AGENT_AGES[agentId];

        const boyMessage = await generateJournalBoyNudge(agentId, agentName, age, category);

        await db.ref(`stewart/journalPatterns/${agentId}`).push({ category, timestamp: Date.now() });
        await db.ref(`stewart/journalPatterns/${agentId}/_meta`).update({ lastFlaggedCategory: category, lastFlaggedAt: Date.now() });

        // Two SEPARATE deliveries — never the same message reused for both.
        await db.ref(`stewart/messages/${agentId}`).push({ from: 'Tom', text: boyMessage, timestamp: Date.now() });
        await db.ref(`stewart/journalTopicPrompts/${agentId}`).push({ category, timestamp: Date.now() });
        const parentMsg = journalParentPromptText(agentName, category);
        await Promise.all(['john', 'dawn'].map(p => sendToPerson(p, parentMsg.title, parentMsg.body, 'bridge/')));
      } catch (e) {
        console.error('detectJournalPatterns failed for', agentId, e);
      }
    }
    return null;
  });

// ════════════════════════════════════════════════════
// MEDALS — Step 5: criteria checker
// All 5 criteria are modeled as "how many consecutive qualifying days does
// he currently have" — even the two that read as weekly checks (zero
// strikes, wish restraint) are really just 7-day streaks of a different
// qualifying condition. One shared streak/dedup mechanism handles all five
// instead of five bespoke ones, and "avoid re-firing a medal for an
// already-credited streak" becomes a single rule: don't re-award unless
// the streak's START DATE has changed (i.e. it broke and restarted).
// ════════════════════════════════════════════════════
const MEDAL_LOOKBACK_DAYS = 40; // covers the 30-day streak with room to spare
const CLEAN_SCORE_THRESHOLD = 90;
// "Not spending all 3 wishes every day" is literally impossible to violate
// on the day they're earned — the wish economy's own rule is that a day's
// earnings aren't spendable until the NEXT day. So restraint is evaluated
// as "never used 3+ wishes in a single day" — the closest real analogue to
// burning through a full max-day's-worth in one sitting, regardless of
// which day's earnings those wishes came from.
const WISH_RESTRAINT_MAX_DAILY_USE = 3;

const MEDAL_CRITERIA = [
  { key: 'clean7', label: '7-Day Clean Streak', streakKey: 'clean', threshold: 7 },
  { key: 'clean30', label: '30-Day Clean Streak', streakKey: 'clean', threshold: 30 },
  { key: 'strikeFree7', label: 'Clean Conduct Week', streakKey: 'strikeFree', threshold: 7 },
  { key: 'wishRestraint7', label: 'Wish Restraint', streakKey: 'wishRestraint', threshold: 7 },
  { key: 'devotional7', label: 'Devotional Consistency', streakKey: 'devotional', threshold: 7 }
];

function isWeekendStr(dateStr) {
  const dow = parseDateStr(dateStr).getUTCDay();
  return dow === 0 || dow === 6;
}

// dates must be DESCENDING, today first. Walks backward while
// isQualifyingDay holds; 'skip' (weekends, for the score streak) neither
// extends nor breaks it. Returns the run ending TODAY, or null if today
// itself doesn't qualify — a streak that lapsed isn't "current."
function computeStreak(dates, isQualifyingDay) {
  let length = 0;
  let startDate = null;
  for (const date of dates) {
    const q = isQualifyingDay(date);
    if (q === 'skip') continue;
    if (q) { length++; startDate = date; } else break;
  }
  return length > 0 ? { length, startDate } : null;
}

async function fetchMedalCheckData(agentId, dates) {
  const [scoreSnaps, strikeSnaps, wishSnaps, couragedareSnap] = await Promise.all([
    Promise.all(dates.map(d => db.ref(`stewart/scores/${agentId}/${d}`).once('value'))),
    Promise.all(dates.map(d => db.ref(`stewart/strikes/${agentId}/${d}/count`).once('value'))),
    Promise.all(dates.map(d => db.ref(`stewart/wishes/${agentId}/${d}/used`).once('value'))),
    db.ref(`stewart/couragedare/progress/${agentId}`).once('value')
  ]);

  const scoreByDate = {}, strikeByDate = {}, wishUsedByDate = {};
  dates.forEach((d, i) => {
    scoreByDate[d] = scoreSnaps[i].val();
    strikeByDate[d] = strikeSnaps[i].val() || 0;
    wishUsedByDate[d] = wishSnaps[i].val() || 0;
  });

  // Courage Dare is program-day-numbered, not calendar-dated (same as the
  // report card's Step 1 handling) — map each completion's real timestamp
  // to the calendar day it happened on.
  const couragedareDates = new Set();
  Object.values(couragedareSnap.val() || {}).forEach(entry => {
    if (entry && typeof entry.completedAt === 'number') {
      couragedareDates.add(easternDateStr(new Date(entry.completedAt)));
    }
  });

  return { scoreByDate, strikeByDate, wishUsedByDate, couragedareDates };
}

function evaluateMedalStreaks(dates, data) {
  return {
    clean: computeStreak(dates, d => {
      if (isWeekendStr(d)) return 'skip'; // weekends aren't scored — skip, don't break
      const s = data.scoreByDate[d];
      return (s !== null && s !== undefined) ? s >= CLEAN_SCORE_THRESHOLD : false;
    }),
    strikeFree: computeStreak(dates, d => data.strikeByDate[d] === 0),
    wishRestraint: computeStreak(dates, d => data.wishUsedByDate[d] < WISH_RESTRAINT_MAX_DAILY_USE),
    devotional: computeStreak(dates, d => data.couragedareDates.has(d))
  };
}

// Evaluates all 5 criteria for one boy and records any newly-qualifying
// medal (streak start date not already credited) under
// stewart/medals/{agentId}/{weekOf} — {weekOf} being the week the
// qualifying event happened in, not the streak's own span. Internal
// dedup bookkeeping lives separately at stewart/medalState/{agentId}/{key}
// so re-earning after a streak breaks and restarts works naturally.
// Step 7: family group chat announcement — Tom's voice, agentId:'tom' so
// moderateGroupChatMessage's own guard (only ALLOWED_AGENT_IDS get
// classified) exempts it structurally rather than relying on the AI
// classifier to judge a templated announcement as clean every time.
// 'tom' also isn't in ALL_PEOPLE, so notifyGroupChat's recipient filter
// excludes no one — the push notification correctly reaches every parent
// AND every boy, matching "public, to everyone."
const MEDAL_ANNOUNCEMENT_TEMPLATES = {
  clean7: name => `${name} just logged a 7-Day Clean Streak, crew — steady hands finish strong. Let's hear it for him.`,
  clean30: name => `${name} just hit a 30-Day Clean Streak. That's Officer-grade steadiness, sailors — well sailed.`,
  strikeFree7: name => `${name} sailed a full week clean of conduct — not a single strike. Well done, sailor.`,
  wishRestraint7: name => `${name} showed real restraint with his wishes this week instead of burning through them. That's discipline worth noticing, crew.`,
  devotional7: name => `${name} kept the Word in view seven days running. The Word's the true north — well sailed, sailor.`
};

async function postMedalAnnouncement(agentName, medalKey) {
  const template = MEDAL_ANNOUNCEMENT_TEMPLATES[medalKey];
  const text = template ? template(agentName) : `${agentName} just earned a medal, crew — let's all congratulate him!`;
  await db.ref('stewart/groupchat').push({ text, from: 'Tom', agentId: 'tom', timestamp: Date.now() });
}

async function checkAndRecordMedals(agentId, weekOf) {
  const today = new Date();
  const dates = [];
  for (let i = 0; i < MEDAL_LOOKBACK_DAYS; i++) {
    dates.push(easternDateStr(new Date(today.getTime() - i * 24 * 60 * 60 * 1000)));
  }

  const data = await fetchMedalCheckData(agentId, dates);
  const streaks = evaluateMedalStreaks(dates, data);

  const newlyAwarded = [];
  for (const crit of MEDAL_CRITERIA) {
    const streak = streaks[crit.streakKey];
    if (!streak || streak.length < crit.threshold) continue;

    const stateRef = db.ref(`stewart/medalState/${agentId}/${crit.key}`);
    const stateSnap = await stateRef.once('value');
    const state = stateSnap.val() || {};
    if (state.creditedStartDate === streak.startDate) continue; // already credited for this exact run

    await stateRef.set({ creditedStartDate: streak.startDate, awardedAt: Date.now() });
    const medalRecord = { key: crit.key, label: crit.label, streakLength: streak.length, awardedAt: Date.now() };
    await db.ref(`stewart/medals/${agentId}/${weekOf}`).push(medalRecord);
    newlyAwarded.push({ agentId, ...medalRecord });
    await postMedalAnnouncement(AGENT_DISPLAY_NAMES[agentId] || agentId, crit.key);
  }
  return newlyAwarded;
}

// On-demand trigger — same shape as generateWeeklyReportCard's manual
// Check In, useful for testing and for a future "check now" UI hook.
exports.checkMedalsNow = functions.https.onCall(async () => {
  const weekOf = mostRecentMonday(easternDateStr());
  const results = await Promise.all(ALLOWED_AGENT_IDS.map(id => checkAndRecordMedals(id, weekOf)));
  return { newlyAwarded: results.flat() };
});

// Fires daily, evening Eastern — after most of a day's real activity has
// happened, so a streak crossing its threshold today is picked up same-day
// rather than waiting for the next morning's chores to even start.
exports.checkMedalsDaily = functions.pubsub
  .schedule('0 21 * * *')
  .timeZone('America/New_York')
  .onRun(async () => {
    const weekOf = mostRecentMonday(easternDateStr());
    await Promise.all(ALLOWED_AGENT_IDS.map(id => checkAndRecordMedals(id, weekOf)));
    return null;
  });
