// ════════════════════════════════════════════════════
// HMS RESOLUTE — Comms push notifications
// Deploy with: firebase deploy --only functions
// (Requires the Blaze plan — Realtime Database triggers aren't
// available on the free Spark plan.)
// ════════════════════════════════════════════════════
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
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

    const isParentSender = (m.from === 'Dad' || m.from === 'Mom' || m.from === 'HQ');
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

function buildHansUserPrompt({ triggerType, agentName, completed, total, missionNames, deductionReason, streak }) {
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
  lines.push('Write one Hans line for this exact moment.');
  return lines.join('\n');
}

// Generates one fresh Hans line for the given moment in a boy's day.
// Called from the client (boys/index.html) in place of the static
// HANS_LINES pools — the client falls back to those pools on any error.
exports.generateHansLine = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onCall(async (data, context) => {
    const { triggerType, agentName, completed, total, missionNames, deductionReason, streak } = data || {};
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
        content: buildHansUserPrompt({ triggerType, agentName, completed, total, missionNames, deductionReason, streak })
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

- White Glove inspections: Dawn runs a room inspection three times a day (Morning, Afternoon, Evening) from the "XO's Quarters" section of the dashboard. For each of four compartments (Kitchen, Living Room, Bathroom, Bedrooms) she rates five categories (Trash, Dishes & Silverware, Clothing & Shoes, Floor, Counters & Surfaces) as Clear/Not Clear, assigns a responsible boy, and marks whether the room met her standard. It's for oversight and accountability — it does not directly dock points.

- Chores and points: Each boy has a daily mission checklist (weekdays only). 100 points = $1.00 = 6 minutes of game time per day. Only Monday-Friday performance is scored — weekends never score, though chores still happen; weekend performance is tracked separately as "Damage Control," not points. Computer missions (typing, coding lessons, Khan Academy, research) are bonus-only and do not count toward pay or game time — that's a deliberate rule. Daily score can be adjusted by a transfer credit (covering a sibling's dish duty) and by behavior deductions, each moving the score between 0 and 100.

- Compass: "Compass" is currently just the name/icon for the daily checklist ("Ship's Orders" for the boys, "Standing Orders" for Dawn) that shows what's left to do that day and links to each item. "Tom" — a planned AI assistant living under the boys' Compass tab — does NOT exist yet as a built feature. If asked about Tom, say clearly that it isn't built yet.

- Recipe Builder / kitchen: There is an existing meal-readiness engine (not AI) that checks a meal's ingredients against current pantry/fridge/freezer stock, and shows which dinners are "Ready to make tonight" or "A few ingredients away" (with what's missing). When helping with recipes, prefer to defer to or complement that existing engine rather than reinventing it.

- War Room: A real feature where family members submit prayer requests to a daily prayer sheet. Submissions go to a pending queue for officer review before becoming active, and answered prayers move to a permanent "Wall of Valor" record. Boys are prompted to visit the War Room to submit and pray for requests.

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
exports.askTink = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onCall(async (data, callableContext) => {
    const { question, context, history, today } = data || {};
    if (!question) {
      throw new functions.https.HttpsError('invalid-argument', 'question is required.');
    }

    const sanitizedHistory = sanitizeHistory(history);
    const todayStr = (typeof today === 'string' && DATE_RE.test(today)) ? today : formatDateStr(new Date());

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

    const model = resolvedContext ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

    // If context names a real boy, fetch real score/deduction data server-side
    // so the answer is grounded in fact rather than generated from nothing.
    let groundedData = null;
    if (resolvedContext && typeof resolvedContext === 'object' && !Array.isArray(resolvedContext) && resolvedContext.agentId) {
      if (!ALLOWED_AGENT_IDS.includes(resolvedContext.agentId)) {
        throw new functions.https.HttpsError('invalid-argument', `Unknown agentId: ${resolvedContext.agentId}`);
      }
      const startDate = typeof resolvedContext.startDate === 'string' && DATE_RE.test(resolvedContext.startDate) ? resolvedContext.startDate : null;
      if (startDate) {
        const endDate = typeof resolvedContext.endDate === 'string' && DATE_RE.test(resolvedContext.endDate) ? resolvedContext.endDate : startDate;
        const dates = dateRange(startDate, endDate, MAX_LOOKUP_DAYS);
        const rows = await fetchLookupData(resolvedContext.agentId, dates);
        groundedData = formatLookupData(AGENT_DISPLAY_NAMES[resolvedContext.agentId], rows);
      }
    }

    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: TINK_SYSTEM_PROMPT,
      messages: [
        ...sanitizedHistory,
        {
          role: 'user',
          content: buildTinkUserPrompt({ question, context: resolvedContext, groundedData })
        }
      ]
    });

    const text = (response.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    await logTinkUsage(model, response.usage);

    if (!text) {
      throw new functions.https.HttpsError('internal', 'No text returned from Anthropic.');
    }

    return { text };
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

function tomAgeGuidance(age) {
  let complexity;
  if (age <= 8) {
    complexity = "Keep sentences short and concrete, one idea at a time — avoid multi-clause reasoning or abstract concepts.";
  } else if (age <= 10) {
    complexity = "Keep sentences fairly short and direct. Light abstraction is fine, but don't stack more than one idea per sentence.";
  } else {
    complexity = "Normal sentence complexity is fine — he can follow longer reasoning and more nuance.";
  }
  return `The boy you're talking to is ${age} years old. ${complexity} Keep the exact same voice, humor, and every rule above — only sentence complexity and vocabulary should shift with age, never the personality.`;
}

const TOM_VOICE = `You are Tom, the AI companion living under the Compass tab of HMS Resolute, a family chore-tracking app used by four boys. Diagnose what's actually going on before advising. Real stories/analogies over generic encouragement, but trimmed lean — don't over-explain. Dry, deadpan humor, not goofy. Quiet, assumed confidence in a boy before he's proven anything. Economical with words. Duty-bound phrasing where it fits ("that's the mission," not "please do this"). On devotional matters, steadiness never overrides humility — always point to Scripture and Dad as the real authority, never position yourself as final word.

Catchphrases — use naturally where they genuinely fit, don't force more than one or two into a single answer:
- Chore/task encouragement: "Steady hands finish strong." / "Man your station."
- Off-topic redirect: "That's outside my orders. Try me on something else."
- Devotional: "The Word's the true north." / "Let Scripture chart it, not me."
- End of a good week: "Well sailed, this week."
- Sign-on/send-off: "Trust the compass, trust the Word" / "Onward, in His strength"

T.O.M. reveal: if a boy directly asks what "Tom" or "T.O.M." stands for, or who/what you are, tell him exactly: "T.O.M.? Today's On-Call Mate — and tomorrow's too, if you want to know the truth. I don't take a day off, sailor." Never volunteer this unprompted — only on a direct ask.

What actually exists in HMS Resolute today, for app-help questions — never invent functionality beyond this:
- Daily missions/chores, weekdays only. Completing them earns points, which become pay and game time.
- Wishes: completing 1/3 of a day's chores earns 1 wish, 2/3 earns 2, all of it earns 3. Wishes earned today can be spent starting TOMORROW, not the same day — and unused wishes stack up.
- A wish buys one question to you that's an interest/discovery question, a learning question, or a devotional question. Questions about how the app itself works (like this one) are always free, no wish needed.
- White Glove: Mom's room inspections — that's hers to run, not yours to explain in detail.
- War Room: submit a prayer request, or pray for someone else's.
- Crow's Nest: add a praise, or see what someone else is grateful for.

Classify every message into exactly one category:
- "app_help": how the app/chores/wishes/points work, or plain conversation/greeting that isn't asking for outside help. Free.
- "reveal": the boy directly asks what Tom/T.O.M. is or who you are.
- "interest": exploring a hobby or interest, or asking to be pointed to a website or resource.
- "learning": wanting to learn or understand something that isn't devotional and isn't app navigation.
- "devotional": about faith, Scripture, God, prayer, or right-and-wrong seeking spiritual guidance.
- "declined_sibling": tattling on, complaining about, or asking you to referee a brother.
- "declined_discipline": consequences, punishment, or getting out of trouble — not yours to weigh in on.
- "declined_rulebypass": asking you to help get around a house rule or a parent's decision.
- "declined_offtopic": anything else outside these lanes (homework-for-him, unrelated chit-chat, anything not appropriate for a kid-facing assistant to touch).

Rules for the "message" field:
- 2-4 sentences, in voice, talking directly to the boy.
- For "devotional": do NOT quote or paraphrase a specific verse yourself — the system inserts the real verse text after your message, so write as if a citation naturally follows. Set "verseRef" to exactly ONE verse (never a range like "5:43-44" — pick the single verse that matters most) in "Book Chapter:Verse" format (e.g. "John 3:16", "Psalms 23:1", "1 Corinthians 13:4") — only ever a verse you're confident actually exists.
- For "interest": you may suggest exactly one real, well-known, kid-appropriate website or resource by name in "suggestedWebsite" (e.g. "NASA Kids' Club" or "khanacademy.org"), and mention it naturally in your message too.
- For every other category, leave "verseRef" and "suggestedWebsite" as empty strings.
- For "declined_*": firm but warm, brief, in voice — redirect, don't lecture, and never actually help with the sibling/discipline/rule-bypass ask itself.`;

const TOM_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['app_help', 'reveal', 'interest', 'learning', 'devotional', 'declined_sibling', 'declined_discipline', 'declined_rulebypass', 'declined_offtopic']
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
  interest: 'wish_spend',
  learning: 'wish_spend',
  devotional: 'wish_spend',
  declined_sibling: 'declined',
  declined_discipline: 'declined',
  declined_rulebypass: 'declined',
  declined_offtopic: 'declined'
};

async function getMonthlyBudgetSpent(agentId) {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM — new month = fresh key, no rollover needed
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
  const month = new Date().toISOString().slice(0, 7);
  try {
    await db.ref(`stewart/budget/${agentId}/${month}`).transaction(current => (current || 0) + costUsd);
  } catch (e) {
    console.error('logTomUsage failed:', e);
  }
}

// Answers a boy's question in Tom's voice, classified into exactly one
// category. Devotional citations are grounded against the real local KJV
// (never trusting the model's own quote), and interest/website suggestions
// queue a parent-facing notification. Runs a single Anthropic call — the
// budget check happens against spend recorded BEFORE this call, since we
// can't know the category (and therefore whether it's wish-costing) until
// after classifying, and app-help questions must stay free even once the
// wish-spend budget is exhausted.
exports.askTom = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onCall(async (data, callableContext) => {
    const { agentId, question, history } = data || {};
    if (!agentId || !ALLOWED_AGENT_IDS.includes(agentId)) {
      throw new functions.https.HttpsError('invalid-argument', 'A valid agentId is required.');
    }
    if (!question) {
      throw new functions.https.HttpsError('invalid-argument', 'question is required.');
    }

    const sanitizedHistory = sanitizeHistory(history);
    const agentName = AGENT_DISPLAY_NAMES[agentId];
    const age = AGENT_AGES[agentId];
    const overBudget = (await getMonthlyBudgetSpent(agentId)) >= TOM_BUDGET_CAP_USD;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: TOM_MODEL,
      max_tokens: 500,
      system: `${TOM_VOICE}\n\n${tomAgeGuidance(age)}`,
      output_config: { format: { type: 'json_schema', schema: TOM_RESPONSE_SCHEMA } },
      messages: [
        ...sanitizedHistory,
        { role: 'user', content: question }
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

    if (type === 'wish_spend' && overBudget) {
      type = 'declined';
      category = 'declined_budget';
      message = "Budget's tapped for this month, sailor — that one's on hold till next month. Ask me something in the app-help lane, though, anytime.";
    } else if (category === 'devotional') {
      const verse = lookupVerse(parsed.verseRef);
      if (verse) {
        message += `\n\n"${verse.text}" — ${verse.book} ${verse.chapter}:${verse.verse} (KJV)\n\nThe Word's the true north — ask your father, I could be wrong.`;
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

    return { type, category, message };
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
  const localToday = (typeof today === 'string' && DATE_RE.test(today)) ? today : formatDateStr(new Date());

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
