# HMS RESOLUTE — Deployment Notes (Session 1 Build)

## What was built tonight
1. **index.html** — replaces the root hub. The Gangway: QR card login (camera scan), officer passwords (John/Dawn), crew PIN fallback, first-run commissioning, parent deck chooser with assist mode, muster logging on every attempt.
2. **warroom/index.html** — NEW folder. Full prayer system: daily sheet (auto-pull, printable), request intake (parents direct, boys → pending queue), officer approval, Wall of Valor with "set the stone" flow.
3. **registry.html** — NEW root file. Officers-only: Muster Roll (last 200 entries, filters, auto-flags for 3+ fails/30min, quiet-hours logins, unknown cards) and printable QR ID cards (standard ID size, reissue voids old card).

## To deploy
1. In the stewart-family repo: **rename the current index.html to index-old.html** (keep it until the new gateway is proven).
2. Add the three files: `index.html` (root), `warroom/index.html` (new folder), `registry.html` (root).
3. Commit, wait for GitHub Pages to deploy (green check in Actions).

## First run — order matters
1. Open the site root. You'll see **COMMISSIONING** (because `resolute/auth` doesn't exist in Firebase yet).
2. Set John's password, Dawn's password, and the crew fallback PIN. This writes hashed credentials + generates 4 card tokens.
3. Log in as an officer → open **Ship's Registry** → **ID Cards** tab → Print All Cards. Cardstock, cut, laminate.
4. Test a boy's card on a laptop camera at the gateway.

## Firebase paths introduced (all new, no collisions with existing data)
- `resolute/auth/parents/{john|dawn}` — SHA-256 password hashes
- `resolute/auth/crewPin` — SHA-256 of fallback PIN
- `resolute/auth/cards/{RSLT-token}` → {person, issued}
- `resolute/muster/{pushId}` → {t, who, method, ok, device, assist?, note?}
- `resolute/prayer/requests/{id}` → {by, forWho, txt, created, status: active|answered|retired}
- `resolute/prayer/pending/{id}` — boys' submissions awaiting approval
- `resolute/prayer/valor/{id}` → {forWho, txt, by, asked, how, answered}

## Session identity contract (for future integration)
`localStorage['resolute.session']` = `{person, role:'parent'|'boy', assist:{parent,as}|null, ts}`
- The War Room already reads it (shows pending tab to parents, defaults the submitter).
- Agent HQ can read `?assist=` params + this session later to show the assist banner — **not yet wired into boys/index.html** (deliberate: didn't touch existing apps tonight).

## Honest caveats
- Camera QR scanning requires HTTPS — GitHub Pages provides it, so fine in production, but it will NOT work opening the file locally via file://.
- Security is family-grade, not bank-grade: hashes and tokens live in a Firebase DB with open rules (same as your existing apps). Fine for the in-house threat model discussed.
- The QR scanner uses the front (user-facing) camera since kids hold cards up to a laptop. If a device picks the wrong camera, change `facingMode:'user'` to `'environment'` in index.html.
- Nothing in bridge/, dashboard/, kitchen/, boys/, saga/, vineyard/ was modified. Zero risk to existing systems.

## Next session queue (from the restructure spec)
1. Homestead restructure (Galley absorbs kitchen — big refactor, own session)
2. Wardroom annotation system in saga/ (mockup approved, spec in restructure doc)
3. Assist banner + session awareness inside boys/index.html
4. Bridge link to Ship's Registry + Muster Roll
5. Crow's Nest
6. Rank/position layer + promotion eligibility tracking
7. Quarterdeck (needs its own design session first)
8. Visual retheme of existing apps to HMS Resolute
