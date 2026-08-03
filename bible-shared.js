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
// As of Step 2 of the Family Bible punch list, this file also owns the
// KJV loading/verse-resolution code originally built inline in
// boys/index.html for the personal Word tab (loadKJV, resolveVerseRef,
// etc.) — moved here so Bridge and Officers' Country can browse/search/
// resolve verses identically instead of reimplementing it. boys/index.html
// now loads this file and no longer keeps its own copies.
// ════════════════════════════════════════════════════

// Loads the same assets/kjv.json Tom's server-side lookupVerse already
// uses for devotional grounding (functions/index.js) — one trusted
// source, browsed here instead of duplicated. Structure is confirmed as
// {book: {chapter: {verse: text}}}, string-keyed chapters/verses — direct
// O(1) lookup for browsing and deep-linking, and flat enough that a
// client-side keyword search can just linear-scan it; no restructuring
// needed. Every page loading this file is one directory below the repo
// root (boys/, bridge/, dashboard/), so the relative path is the same
// for all three.
let _kjvData = null;
let _kjvLoadPromise = null;
function loadKJV(){
  if(_kjvData) return Promise.resolve(_kjvData);
  if(_kjvLoadPromise) return _kjvLoadPromise;
  _kjvLoadPromise = fetch('../assets/kjv.json').then(r => r.json()).then(data => {
    _kjvData = data;
    return data;
  });
  return _kjvLoadPromise;
}

// Second selectable translation (1599 Geneva Bible) — same {book:
// {chapter: {verse: text}}} shape as KJV, same 66 book keys in the same
// order, sourced and verified separately (see assets/geneva.json's own
// provenance notes). Kept as a fully independent load/cache from KJV so
// a page can show either without forcing both to load.
let _genevaData = null;
let _genevaLoadPromise = null;
function loadGeneva(){
  if(_genevaData) return Promise.resolve(_genevaData);
  if(_genevaLoadPromise) return _genevaLoadPromise;
  _genevaLoadPromise = fetch('../assets/geneva.json').then(r => r.json()).then(data => {
    _genevaData = data;
    return data;
  });
  return _genevaLoadPromise;
}

// ─── Strong's Concordance tap-to-define ───
// Word-level Strong's-number tagging only exists for the KJV's exact
// wording (see assets/strongs-tags/), not Geneva — so tap-to-define is
// KJV-only; callers should simply not attempt it when Geneva is the
// active translation.
//
// Two data sources, used as-is per family decision, license notices
// kept attached rather than stripped or regenerated:
//  - Word→Strong's-number tagging: CrossWire Bible Society's "KJV"
//    SWORD module (the KJV2003 Project). Embedded grant: "CrossWire
//    Bible Society hereby grants a general public license to use this
//    text for any purpose."
//  - Strong's-number→definition dictionary: openscriptures/strongs,
//    "Unified Strong's Dictionaries of Greek and Hebrew in XML,
//    Copyright (c) 2008, Open Scriptures. Freely released under GPL 3.0
//    license." Both notices are surfaced in the definition popover
//    itself (strongsPopoverContentHtml, below) — the credit stays
//    attached to the feature that actually uses the data, not just
//    buried in this comment.
let _strongsDefs = null;
let _strongsDefsPromise = null;
function loadStrongsDefs(){
  if(_strongsDefs) return Promise.resolve(_strongsDefs);
  if(_strongsDefsPromise) return _strongsDefsPromise;
  _strongsDefsPromise = fetch('../assets/strongs-defs.json').then(r => r.json()).then(data => {
    _strongsDefs = data;
    return data;
  });
  return _strongsDefsPromise;
}

function strongsBookSlug(book){
  return book.toLowerCase().replace(/\s+/g, '-');
}

// One JSON file per book (23MB total split 66 ways, largest ~1.1MB)
// rather than a single monolithic file — a chapter view only ever needs
// its own book's data, and shipping the whole Bible's word-tagging on
// every page load would be a real mobile-data/performance cost for no
// benefit. Cached per book once fetched; a failed/missing fetch is
// cached as `null` too so a book with no tag data doesn't get re-requested
// every time its chapters are viewed.
const _strongsTagsCache = {};
const _strongsTagsPromises = {};
function loadStrongsTagsForBook(book){
  if(book in _strongsTagsCache) return Promise.resolve(_strongsTagsCache[book]);
  if(_strongsTagsPromises[book]) return _strongsTagsPromises[book];
  const slug = strongsBookSlug(book);
  _strongsTagsPromises[book] = fetch(`../assets/strongs-tags/${slug}.json`).then(r => {
    if(!r.ok) throw new Error('no strongs data for ' + book);
    return r.json();
  }).then(data => {
    _strongsTagsCache[book] = data;
    return data;
  }).catch(() => {
    _strongsTagsCache[book] = null;
    return null;
  });
  return _strongsTagsPromises[book];
}

function _strongsEscHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Renders one verse's body as tappable word spans + plain text, using
// Strong's segment data already loaded for this exact book (via
// loadStrongsTagsForBook) — falls back to plain escaped text when no
// tag data is available (any non-KJV translation, or the rare verse
// this particular module didn't tag). onWordTapFn names a page-local
// function — each surface renders its own popover with its own
// styling/positioning, so the tap just hands the data off:
// onWordTapFn(event, strongsCsv, wordText).
function renderVerseSegmentsHtml(book, chapter, verse, fallbackText, onWordTapFn){
  const bookData = _strongsTagsCache[book];
  const segs = bookData && bookData[String(chapter)] && bookData[String(chapter)][String(verse)];
  if(!segs) return _strongsEscHtml(fallbackText);
  return segs.map(seg => {
    if(seg.t === 'word' && seg.s && seg.s.length){
      return `<span class="bib-word" onclick="${onWordTapFn}(event,'${seg.s.join(',')}','${_strongsEscHtml(seg.x)}')">${_strongsEscHtml(seg.x)}</span>`;
    }
    return _strongsEscHtml(seg.x);
  }).join('');
}

// Shared popover CONTENT (each surface renders this into its own
// page-local popover element, since chrome/positioning differs per
// app's theme). A single tapped word can carry more than one Strong's
// number — an English phrase translating one compound original word —
// so every code gets its own definition block, in order.
function strongsPopoverContentHtml(strongsCsv, wordText){
  const codes = strongsCsv.split(',').filter(Boolean);
  const defsHtml = codes.map(code => {
    const entry = (_strongsDefs && _strongsDefs[code]) || null;
    if(!entry){
      return `<div class="strongs-entry"><div class="strongs-num">${code}</div><div class="strongs-def">No definition on file.</div></div>`;
    }
    const origHtml = entry.word ? ` — <span class="strongs-orig">${_strongsEscHtml(entry.word)}</span>` : '';
    const translitHtml = entry.translit ? ` <span class="strongs-translit">(${_strongsEscHtml(entry.translit)})</span>` : '';
    return `<div class="strongs-entry">
      <div class="strongs-num">${code}${origHtml}${translitHtml}</div>
      <div class="strongs-def">${_strongsEscHtml(entry.def || '')}</div>
    </div>`;
  }).join('');
  return `<div class="strongs-word-hdr">${_strongsEscHtml(wordText)}</div>${defsHtml}` +
    `<div class="strongs-credit">Word tagging: CrossWire Bible Society (KJV2003 Project), used for any purpose. Definitions: openscriptures.org, GPL 3.0.</div>`;
}

// Mirrors functions/index.js's normalizeBookName/BOOK_ALIASES exactly, so
// a reference Tom or Tink cites server-side resolves to the same book
// here that it did there. Keep these two in sync if either changes —
// there's no shared module between client and Cloud Functions to enforce
// it automatically.
const KJV_BOOK_ALIASES = {
  'song of songs': 'Song of Solomon',
  'canticles': 'Song of Solomon',
  'psalm': 'Psalms',
  'revelations': 'Revelation'
};
function normalizeBookName(raw, bookSet){
  const trimmed = String(raw||'').trim();
  if(bookSet.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if(KJV_BOOK_ALIASES[lower]) return KJV_BOOK_ALIASES[lower];
  const found = [...bookSet].find(b => b.toLowerCase() === lower);
  return found || null;
}

// "Book Chapter:Verse" (e.g. "1 Samuel 17:45"), tolerating a range
// ("Matthew 5:43-44") by resolving just the first verse — same tolerance
// as the server-side parser this mirrors.
function parseVerseRef(ref){
  const m = String(ref||'').trim().match(/^(.*?)\s+(\d+):(\d+)(?:-\d+)?$/);
  if(!m) return null;
  return { bookRaw: m[1], chapter: m[2], verse: m[3] };
}

// Reversible, RTDB-safe verse key — spaces in a book name become
// underscores (e.g. "1 Samuel" 17:45 -> "1_Samuel_17_45"). The single
// source of truth for this format everywhere in the app — highlights,
// notes, bookmarks, and citation deep-links all key off this.
function verseKey(book, chapter, verse){
  return String(book).replace(/\s+/g,'_') + '_' + chapter + '_' + verse;
}

// Resolves a "Book Chapter:Verse" reference against the loaded KJV data —
// returns {book, chapter, verse, text, key} or null if the reference
// doesn't parse or the verse doesn't exist. One resolver used by
// browsing, bookmarking, highlighting, notes, and citation deep-links, so
// all of them always agree on what a given reference means. Callers must
// await loadKJV() first — returns null rather than loading on demand, so
// a resolve-in-a-loop (e.g. rendering a chapter) never triggers redundant
// fetches.
function resolveVerseRef(ref){
  if(!_kjvData) return null;
  const parsed = parseVerseRef(ref);
  if(!parsed) return null;
  const book = normalizeBookName(parsed.bookRaw, new Set(Object.keys(_kjvData)));
  if(!book) return null;
  const chapterData = _kjvData[book] && _kjvData[book][parsed.chapter];
  const text = chapterData && chapterData[parsed.verse];
  if(!text) return null;
  return { book, chapter: parsed.chapter, verse: parsed.verse, text, key: verseKey(book, parsed.chapter, parsed.verse) };
}

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

// ─── Family reading position: stewart/biblereading/{personId} ───
// {book, chapter, updatedAt} -- the CHAPTER a person most recently opened,
// overwritten on every chapter open (not an accumulating list, not a
// verse-level bookmark -- bookmarks already exist separately for "save
// this verse"). This is "what's everyone currently reading," meant to be
// visible family-wide, same trust model as highlights/notes above (no
// privacy boundary here, unlike the boys' private journal) -- the whole
// point of a shared family Bible is seeing where everyone else is.

function recordBibleReading(personId, book, chapter){
  if(!_db || !personId) return;
  _db.ref(`stewart/biblereading/${personId}`).set({
    book, chapter: Number(chapter), updatedAt: Date.now()
  });
}

// [{personId, name, color, book, chapter, updatedAt}, ...] for all six
// family members, in FAMILY_PERSON_IDS order -- book/chapter/updatedAt
// are null for anyone who's never opened a chapter yet.
function getFamilyReading(){
  if(!_db) return Promise.resolve(FAMILY_PERSON_IDS.map(id => ({
    personId: id, name: FAMILY_DISPLAY_NAMES[id], color: FAMILY_COLORS[id],
    book: null, chapter: null, updatedAt: null
  })));
  return _db.ref('stewart/biblereading').once('value').then(snap => {
    const data = snap.val() || {};
    return FAMILY_PERSON_IDS.map(id => {
      const rec = data[id] || {};
      return {
        personId: id, name: FAMILY_DISPLAY_NAMES[id], color: FAMILY_COLORS[id],
        book: rec.book || null, chapter: rec.chapter || null, updatedAt: rec.updatedAt || null
      };
    });
  });
}

function bibleRelativeTimeAgo(ms){
  const diffMin = Math.floor((Date.now() - ms) / 60000);
  if(diffMin < 1) return 'just now';
  if(diffMin < 60) return diffMin + 'm ago';
  const diffHr = Math.floor(diffMin / 60);
  if(diffHr < 24) return diffHr + 'h ago';
  const diffDay = Math.floor(diffHr / 24);
  if(diffDay === 1) return 'yesterday';
  if(diffDay < 7) return diffDay + 'd ago';
  return Math.floor(diffDay / 7) + 'w ago';
}

// Fully inline-styled (no dependency on any one surface's own CSS classes)
// so this renders identically whether it's dropped into Bridge, Officers'
// Country, or the boys' Word tab -- same reasoning as everything else in
// this file being the one shared copy instead of three drifting ones.
// openChapterFn is the caller's own chapter-navigation function name
// (Bridge/Officers' Country: 'openBibleChapter'; boys: 'openWordChapter')
// so tapping a family member's row jumps straight to their current spot.
function familyReadingPanelHtml(reading, openChapterFn){
  const rows = reading.map(r => {
    const hasPosition = !!r.book;
    const posText = hasPosition ? (r.book + ' ' + r.chapter) : 'Hasn’t started reading yet';
    const timeText = hasPosition ? bibleRelativeTimeAgo(r.updatedAt) : '';
    const clickAttr = hasPosition ? ` onclick="${openChapterFn}('${r.book.replace(/'/g,"\\'")}',${r.chapter})" style="cursor:pointer;"` : '';
    return `<div${clickAttr} style="display:flex;justify-content:space-between;align-items:center;padding:8px 2px;border-bottom:1px solid rgba(255,255,255,.08);">
      <span style="font-family:'Lato',sans-serif;font-size:12.5px;font-weight:700;letter-spacing:.3px;color:${r.color};">${r.name}</span>
      <span style="font-family:'Crimson Pro',Georgia,serif;font-size:13px;color:${hasPosition?'rgba(255,255,255,.85)':'rgba(255,255,255,.4)'};font-style:${hasPosition?'normal':'italic'};">${posText}${timeText?' &middot; '+timeText:''}</span>
    </div>`;
  }).join('');
  return `<div style="background:rgba(255,255,255,.03);border:1px solid rgba(200,146,42,.25);border-radius:10px;padding:10px 12px;margin-bottom:14px;">
    <div style="font-family:'Orbitron','Cinzel',sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--gold2,#e8b84a);opacity:.85;margin-bottom:4px;">Family Reading</div>
    ${rows}
  </div>`;
}
