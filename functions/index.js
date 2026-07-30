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
