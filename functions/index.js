// ════════════════════════════════════════════════════
// HMS RESOLUTE — Comms push notifications
// Deploy with: firebase deploy --only functions
// (Requires the Blaze plan — Realtime Database triggers aren't
// available on the free Spark plan.)
// ════════════════════════════════════════════════════
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.database();
const messaging = admin.messaging();

const PARENTS = { Dad: 'john', Mom: 'dawn' };
const ALL_PEOPLE = ['john', 'dawn', 'samuel', 'johnjr', 'stephen', 'daniel'];

async function sendToPerson(person, title, body, url) {
  const snap = await db.ref('notifications/tokens/' + person).once('value');
  const tokensObj = snap.val() || {};
  const tokens = Object.values(tokensObj).map(t => t.token).filter(Boolean);
  if (!tokens.length) return;

  const resp = await messaging.sendEachForMulticast({
    notification: { title, body },
    data: { url: url || '/' },
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

// Family Channel — group chat
exports.notifyGroupChat = functions.database
  .ref('/stewart/groupchat/{msgId}')
  .onCreate(async (snap) => {
    const m = snap.val();
    if (!m || !m.text) return null;

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
