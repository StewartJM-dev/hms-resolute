// ════════════════════════════════════════════════════
// NextDNS recreation site list — shared source of truth
// (nextdns-lockdown-punchlist.md)
//
// Loaded TWO ways, same pattern as mission-engine.js: a plain <script>
// tag in boys/index.html (so a boy can see the real list of sites that
// unlock for him) and require()'d by functions/index.js, copied into
// functions/ by firebase.json's predeploy hook right before every deploy
// (never hand-duplicated — see that file's comment). One list, so what a
// boy is shown can never drift from what actually gets unlocked.
//
// Per boy, not a shared list — confirmed with John these genuinely
// differ (Daniel gets numuki.com instead of the older boys' biking/
// carving sites; Stephen alone gets the kids-cooking store subdomain).
// Deliberately just data, so adding real homeschool sites in September
// is an edit here, never a logic change.
// ════════════════════════════════════════════════════
const NEXTDNS_RECREATION_DOMAINS = {
  samuel: [
    'havefunbiking.com',
    'scratch.mit.edu',
    'google.com',
    'carvingisfun.com',
    'letthekidscook.com',
    'kids-cooking-activities.com',
    'typing.com'
  ],
  johnjr: [
    'havefunbiking.com',
    'scratch.mit.edu',
    'google.com',
    'carvingisfun.com',
    'letthekidscook.com',
    'kids-cooking-activities.com',
    'typing.com'
  ],
  stephen: [
    'kids-cooking-activities.com',
    'store.kids-cooking-activities.com',
    'carvingisfun.com',
    'scratch.mit.edu',
    'letthekidscook.com',
    'typing.com',
    'google.com'
  ],
  daniel: [
    'kids-cooking-activities.com',
    'scratch.mit.edu',
    'numuki.com',
    'letthekidscook.com',
    'typing.com',
    'google.com'
  ]
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NEXTDNS_RECREATION_DOMAINS };
}
