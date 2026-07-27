// ════════════════════════════════════════════════════
// HMS RESOLUTE — shared push notification client
// Include on any page after Firebase is initialized (_db must exist)
// and after the session is known. Call: initPush();
//
// VAPID_KEY: paste in the "Web Push certificates" key from
// Firebase Console → Project Settings → Cloud Messaging.
//
// PUSH_SW_PATH: set this on each page BEFORE including this script,
// as a path relative to that page pointing to the root-level service worker.
// Root pages: const PUSH_SW_PATH = 'firebase-messaging-sw.js';
// One-level-deep pages (bridge/, dashboard/, boys/, saga/):
//   const PUSH_SW_PATH = '../firebase-messaging-sw.js';
// ════════════════════════════════════════════════════
const PUSH_VAPID_KEY = "PASTE_YOUR_VAPID_PUBLIC_KEY_HERE";

function getResoluteSession(){
  try{ return JSON.parse(localStorage.getItem('resolute.session')||'null'); }catch(e){ return null; }
}

async function initPush(){
  if(!('serviceWorker' in navigator) || !('Notification' in window)) return;
  const session = getResoluteSession();
  if(!session || !session.person) return; // need to know who's logged in before saving a token

  try{
    const permission = await Notification.requestPermission();
    if(permission !== 'granted') return;

    const swPath = (typeof PUSH_SW_PATH !== 'undefined') ? PUSH_SW_PATH : 'firebase-messaging-sw.js';
    const reg = await navigator.serviceWorker.register(swPath);
    const messaging = firebase.messaging();
    const token = await messaging.getToken({ vapidKey: PUSH_VAPID_KEY, serviceWorkerRegistration: reg });
    if(!token) return;

    // Save/refresh this device's token, keyed by person so the Cloud Function knows who to notify.
    const db = firebase.database();
    await db.ref('notifications/tokens/'+session.person+'/'+token.slice(-24)).set({
      token, updatedAt: Date.now(), ua: navigator.userAgent.slice(0,120)
    });
  }catch(e){
    console.log('Push registration skipped:', e.message);
  }
}
