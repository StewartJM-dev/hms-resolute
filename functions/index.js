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
