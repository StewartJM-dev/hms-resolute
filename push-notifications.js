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
const PUSH_VAPID_KEY = "BAZvZcHTWYtqiIivjknmnqM4YmktBf4TJjiScLL_sh8mM_oS3i1EsLIlVfb0E7n3-Pvl_U627mKS5T_Y6MkPx_o";

// ════════════════════════════════════════════════════
// Home Screen icon badge count.
// The count has to persist even when the app is fully closed, so it's
// stored in IndexedDB (localStorage isn't available inside a service worker).
// The service worker increments it on every background push; app pages
// clear it back to 0 whenever the person actually reads their messages.
// ════════════════════════════════════════════════════
function openBadgeDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('resolute-badge', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('meta');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getBadgeCount(){
  try{
    const db = await openBadgeDB();
    return await new Promise((resolve) => {
      const tx = db.transaction('meta','readonly').objectStore('meta').get('count');
      tx.onsuccess = () => resolve(tx.result || 0);
      tx.onerror = () => resolve(0);
    });
  }catch(e){ return 0; }
}
async function setBadgeCount(n){
  try{
    const db = await openBadgeDB();
    await new Promise((resolve) => {
      const tx = db.transaction('meta','readwrite').objectStore('meta').put(n, 'count');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }catch(e){}
  try{
    if(n > 0 && 'setAppBadge' in navigator) navigator.setAppBadge(n);
    else if('clearAppBadge' in navigator) navigator.clearAppBadge();
  }catch(e){}
}
// Call this from app pages once the person has actually viewed/read their messages.
async function clearHomeScreenBadge(){
  await setBadgeCount(0);
}

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
