// ════════════════════════════════════════════════════
// HMS RESOLUTE — shared Family Bible data layer
//
// Loaded by boys/index.html, bridge/index.html, and dashboard/index.html
// (via <script src="../bible-shared.js">) so all three surfaces read and
// write the exact same shared highlights/notes in the exact same shape —
// one source of truth, not three implementations that can quietly drift
// apart. Relies on a global `_db` (Firebase ref) already existing on the
// page, same convention mission-engine.js uses.
//
// SCOPE NOTE (as of Step 1 of the Family Bible punch list): this file
// currently covers only the NEW shared-family pieces — colors, verseKey,
// highlights, notes. boys/index.html's own KJV-loading/verse-resolution
// code (loadKJV, resolveVerseRef, etc., built for the earlier personal
// Word tab) and its PERSONAL highlight mechanism
// (stewart/highlights/{agentId}/{verseKey}) still live inline in that
// file as of this commit. Step 2 (the actual Bible UI for Bridge and
// Officers' Country) is where those get consolidated into this file too,
// and boys/index.html gets migrated from personal highlights onto the
// shared model below. Until that migration happens, verseKey() here MUST
// stay byte-for-byte identical to boys/index.html's own copy — both
// independently compute the same RTDB keys, and a personal Word-tab
// highlight written under the old path won't show up under the new
// shared one (or vice versa) if the two ever disagree on key format.
// ════════════════════════════════════════════════════

// Every family member's fixed, permanent color — reused everywhere a
// highlight or attribution needs to visually identify who it belongs to.
// Boys reuse the exact colors bridge/index.html's own AGENT_COLORS
// already assigns them for chart/gauge coloring elsewhere in the app, so
// "Samuel" is the same blue everywhere, not a fourth arbitrary color
// scheme for this one feature. John and Dawn get two new colors chosen
// to stay visually distinct from both the boys' four AND the app's own
// pervasive gold/teal accent colors, so a highlight never gets confused
// for generic UI chrome.
const FAMILY_COLORS = {
  john:    '#a78bfa', // violet
  dawn:    '#e0615c', // coral red
  samuel:  '#4d9fff', // blue
  johnjr:  '#34d399', // green
  stephen: '#f5a623', // orange
  daniel:  '#ec4899'  // pink
};

const FAMILY_DISPLAY_NAMES = {
  john: 'John',
  dawn: 'Dawn',
  samuel: 'Samuel',
  johnjr: 'John Jr.',
  stephen: 'Stephen',
  daniel: 'Daniel'
};

const FAMILY_PERSON_IDS = Object.keys(FAMILY_COLORS);

// Reversible, RTDB-safe verse key — spaces in a book name become
// underscores (e.g. "1 Samuel" 17:45 -> "1_Samuel_17_45"). MUST match
// boys/index.html's own verseKey() exactly — see file header.
function verseKey(book, chapter, verse){
  return String(book).replace(/\s+/g,'_') + '_' + chapter + '_' + verse;
}

// The startAt/endAt('') pair is the standard Firebase technique for
// a "starts with" range query over lexicographically-sorted keys. Every
// verse key for a given book+chapter starts with exactly this prefix, and
// nothing outside that chapter does — the trailing underscore is what
// stops "John_3_" from also matching a hypothetical "John_30_..." key.
function bibleChapterPrefix(book, chapter){
  return String(book).replace(/\s+/g,'_') + '_' + chapter + '_';
}

// ─── Shared highlights: stewart/biblehighlights/{verseKey}/{personId} ───
// One entry per person per verse (a toggle, not an accumulating list) —
// anyone's highlight is visible to the whole family, each rendered in
// that person's own fixed color from FAMILY_COLORS. Deliberately a
// separate path from personal bookmarks (stewart/bookmarks/{personId}),
// which stay individual on purpose.

// Returns the new state (true = now highlighted, false = now removed) so
// a caller can update a button/verse's appearance without a second read.
function toggleSharedHighlight(personId, book, chapter, verse){
  if(!_db) return Promise.resolve(false);
  const color = FAMILY_COLORS[personId];
  if(!color) return Promise.resolve(false);
  const ref = _db.ref(`stewart/biblehighlights/${verseKey(book,chapter,verse)}/${personId}`);
  return ref.once('value').then(snap => {
    if(snap.exists()) return ref.remove().then(() => false);
    return ref.set({ color, timestamp: Date.now() }).then(() => true);
  });
}

// [{personId, color, timestamp}, ...] for one verse.
function getVerseHighlights(book, chapter, verse){
  if(!_db) return Promise.resolve([]);
  return _db.ref(`stewart/biblehighlights/${verseKey(book,chapter,verse)}`).once('value').then(snap => {
    const all = snap.val() || {};
    return Object.entries(all).map(([personId, v]) => ({ personId, ...v }));
  });
}

// Bulk fetch for rendering a whole chapter in one round trip, using the
// prefix-range trick above rather than one read per verse. Returns
// {[verseKey]: [{personId, color, timestamp}, ...]}.
function getChapterHighlights(book, chapter){
  if(!_db) return Promise.resolve({});
  const prefix = bibleChapterPrefix(book, chapter);
  return _db.ref('stewart/biblehighlights').orderByKey().startAt(prefix).endAt(prefix + '').once('value').then(snap => {
    const result = {};
    snap.forEach(child => {
      result[child.key] = Object.entries(child.val() || {}).map(([personId, v]) => ({ personId, ...v }));
    });
    return result;
  });
}

// ─── Shared notes: stewart/biblenotes/{verseKey}/{pushId} ───
// Append-only — unlike highlights, more than one note (even from the same
// person) on the same verse is expected, so this is a real push list, not
// a toggle keyed by personId.

function addBibleNote(personId, book, chapter, verse, text){
  if(!_db) return Promise.resolve(null);
  const trimmed = String(text||'').trim();
  if(!trimmed) return Promise.resolve(null);
  const author = FAMILY_DISPLAY_NAMES[personId] || personId;
  return _db.ref(`stewart/biblenotes/${verseKey(book,chapter,verse)}`).push({
    author, authorId: personId, text: trimmed, timestamp: Date.now()
  });
}

function removeBibleNote(book, chapter, verse, noteKey){
  if(!_db) return Promise.resolve();
  return _db.ref(`stewart/biblenotes/${verseKey(book,chapter,verse)}/${noteKey}`).remove();
}

// [{key, author, authorId, text, timestamp}, ...] for one verse, oldest first.
function getVerseNotes(book, chapter, verse){
  if(!_db) return Promise.resolve([]);
  return _db.ref(`stewart/biblenotes/${verseKey(book,chapter,verse)}`).once('value').then(snap => {
    const all = snap.val() || {};
    return Object.entries(all)
      .map(([key, v]) => ({ key, ...v }))
      .sort((a,b) => (a.timestamp||0) - (b.timestamp||0));
  });
}

// Bulk fetch for rendering a whole chapter in one round trip. Returns
// {[verseKey]: [{key, author, authorId, text, timestamp}, ...]}.
function getChapterNotes(book, chapter){
  if(!_db) return Promise.resolve({});
  const prefix = bibleChapterPrefix(book, chapter);
  return _db.ref('stewart/biblenotes').orderByKey().startAt(prefix).endAt(prefix + '').once('value').then(snap => {
    const result = {};
    snap.forEach(child => {
      result[child.key] = Object.entries(child.val() || {})
        .map(([key, v]) => ({ key, ...v }))
        .sort((a,b) => (a.timestamp||0) - (b.timestamp||0));
    });
    return result;
  });
}
