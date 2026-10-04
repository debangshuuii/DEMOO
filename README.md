# PandalPulse — Durga Puja Pandal Queue Tracker

A HackSpire-style "Spiritual-Tech" queue management app for pandal volunteers:
glassmorphism obsidian UI, cinematic video-loop slots, live telemetry HUD,
printable digital token passes, and rock-solid vanilla-JS queue logic with
`localStorage` persistence.

## Files

| File | Purpose |
|---|---|
| `index.html` | Semantic HTML5: hero video slot, telemetry HUD, volunteer desk + CCTV slot, serpentine queue deck, pass modal, toasts |
| `style.css` | HackSpire obsidian theme, Cinzel / Manrope / JetBrains Mono, grain overlay, 3D card tilts, micro-loops, print styles |
| `app.js` | Queue state array, wait-time engine, filters/search, Web Audio chimes, modal, tilt |
| `ticket-backend.js` | QR ticket "backend": unique Ticket IDs, volunteer auth (hashed), atomic `verifyTicket()` UNUSED→USED gate, scan log, stats/search |
| `ticket-styles.css` | Shared mobile-first styles for the ticket system (result states, scanner, tables) |
| `tickets.html` | Visitor flow: register → unique Ticket ID + real QR → digital ticket display/download |
| `volunteer.html` | Volunteer login + mobile dashboard + camera QR scanner (html5-qrcode) + manual fallback |
| `admin.html` | Admin dashboard: totals, ticket search, volunteer activity, scan-history table, CSV export |
| `assets/` (you add) | `hero_durga_3d.mp4`, `sanctum_cctv.mp4` — optional local 3D loops (CDN fallbacks ship by default) |

## Quick start (no build step)

```bash
git clone <your-repo-url>
cd pandalpulse
# Option A: just open it
start index.html            # Windows
# Option B: serve locally (recommended — avoids video/CORS quirks)
npx serve .                 # then open http://localhost:3000
# or
python -m http.server 8000
```

## Queue logic

- State lives in `queue`: `{ id, name, passType, groupSize, entryTime, status }`.
- Every mutation calls `saveQueue()` → mirrored to `localStorage` (`pandalpulse_queue_v1`), rehydrated on boot.
- Token IDs: `#DP-1042`, `#DP-1043`, … via a persistent counter (`pandalpulse_token_counter_v1`), collision-safe.
- VIP entries `unshift` (front), General entries `push` (back).
- Wait time (spec formula):
  `Estimated Minutes = Math.ceil(((GeneralCount * 2.0) + (VipCount * 1.0)) / 5)`
  where counts are **headcounts** (group sizes summed), not entry counts.

## Custom video loops

1. Render/export your 3D loop as MP4 (H.264, ~1080p, 5–15 s, muted-safe).
2. Drop it in `assets/hero_durga_3d.mp4` (hero) and/or `assets/sanctum_cctv.mp4` (CCTV card).
3. They are already wired as the **first** `<source>` in each `<video>` tag — browsers auto-fall back to the CDN demo clip if the file is missing.

## Team Git workflow (student team)

Branch model:

```
main                  ← always deployable, protected
├── feature/queue-logic
├── feature/3d-ui
└── feature/pass-modal
```

Setup (each member, once):

```bash
git clone <repo-url> && cd pandalpulse
git checkout -b feature/<your-area>   # e.g. feature/queue-logic
```

Daily loop:

```bash
git pull origin main --rebase   # stay fresh before you start
# ... code ...
git add -A && git commit -m "feat(queue): validate group-size clamp 1-10"
git push -u origin feature/<your-area>
```

Ship via Pull Request into `main`:

1. Push branch → **Compare & pull request** on GitHub.
2. Request 1 reviewer; keep PRs small (< 300 lines) and scoped to one area.
3. Require: page loads with no console errors, add/admit/search/filter still work, `localStorage` survives refresh.
4. **Squash and merge**, delete the branch.

Suggested ownership to minimise conflicts:

| Area | Branch | Files |
|---|---|---|
| Queue engine | `feature/queue-logic` | `app.js` |
| Visuals/motion | `feature/3d-ui` | `style.css`, video slots in `index.html` |
| Pass modal/print | `feature/pass-modal` | modal markup in `index.html`, print CSS |

### Conflict resolution (pair-programming tips)

- **Pull + rebase often.** `git pull --rebase origin main` daily; tiny branches = tiny conflicts.
- **One owner per file** where possible (see table). Talk before touching someone else's file.
- When a conflict hits:
  ```bash
  git status              # see which files conflict
  # open each file, resolve between <<<<<<< / ======= / >>>>>>>, keep both sides' intent
  git add <resolved-file>
  git rebase --continue   # or: git commit, if merging
  ```
- `app.js` + `index.html` conflicts are usually duplicate IDs or double-added listeners — keep one copy, reload and click-test.
- Never force-push `main`. If a rebase goes wrong: `git rebase --abort` and ask your pair.
- For live pairing, one person drives + narrates, the other navigates + watches for spec drift (wait-time formula, token format, IDs).

## Deployment (1-click)

### GitHub Pages (static, free)

```bash
git checkout main && git push origin main
```

Then: repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main` / `/ (root)` → Save.
Live at `https://<user>.github.io/<repo>/` in ~1 min. Re-deploy = push to `main`.

### Vercel (free, auto-previews per PR)

1. Import the repo at `vercel.com` → Framework Preset: **Other**.
2. Build command: *(empty)*, Output directory: `./`.
3. Every PR gets a preview URL; merging to `main` promotes to production.

## QR ticket + volunteer verification system

Visitor flow: `tickets.html` → register → unique `TKT-XXXXXX` ID → real QR (encodes
**only the Ticket ID**, no PII) → digital ticket shows ID, holder, pandal, date,
category + QR → show at gate.

Volunteer flow: `volunteer.html` → login (demo: `rahul` / `priya` / `amit` with
password `volunteer123`) → dashboard (Scan QR, counters, recent scans) → camera
scanner (html5-qrcode, `facingMode: environment`, mobile-friendly) → backend
`TicketBackend.verifyTicket()` → 🟢 VALID / 🟠 ALREADY USED / 🔴 INVALID →
"Scan Next Ticket". A manual Ticket-ID entry fallback ships for desktops / denied
camera permission.

Duplicate prevention: `verifyTicket()` does an atomic read-modify-write
(compare-and-swap: fresh re-read → check `UNUSED` → flip to `USED` + write).
A second scan of the same QR always returns `ALREADY_USED` with first-scan time
+ volunteer. Invalid IDs are logged but never marked used. Every scan stores
ticket ID, volunteer ID/name, status, timestamp, event, device + session ID.

Admin: `admin.html` → login (`admin` / `admin123`) → totals (generated / used /
remaining / invalid / volunteers / scans today), ticket search (ID, visitor,
volunteer), volunteer-activity cards, scan-history table, CSV export.

## Admin Portal (separate privileged module)

`admin.html` is a dedicated portal, not a tab of the volunteer app:

- **Admin-only login** — SHA-256 hashed passwords; volunteer accounts are rejected
  even by direct URL. Every protected call re-validates the session server-side
  pattern via `TicketBackend.authorize('admin')` (never trusts role from page state).
- **30-min inactivity timeout** — `lastActive` is touched on every action; expired
  sessions are cleared and the UI redirects to login with a watchdog + per-request check.
- **Scan Devotee Pass** (primary, mobile-first, `Html5Qrcode` + manual `TKT-`/`DEV-`
  entry) → `lookupPass()` returns the full authorized devotee record (name,
  `DEV-XXXXXX`, pass ID, type, confirmed registration date, event, phone if
  collected) as 🟢 VALID, 🟠 ALREADY SCANNED (with previous time + scanner), or
  🔴 INVALID. Lookups are read-only — they never consume entry; only volunteer
  `verifyTicket()` flips `UNUSED→USED`. Every lookup is logged with admin identity,
  device and session, plus a **Scan Another Pass** loop.
- **Search Devotee** by Devotee ID / Pass ID / name / phone; **Scan History** with
  text + status + date filters showing pass, devotee, scanner (admin/volunteer tag),
  status and timestamp; volunteer activity; admin profile + secure logout.

> Note: persistence is `localStorage` (static-site friendly, survives refresh).
> For multi-device production, swap the `readLS`/`writeLS` layer in
> `ticket-backend.js` for Firebase/Supabase calls — the `verifyTicket()` gate
> must then run as a server transaction (e.g. Firestore transaction).

## Testing checklist

- [ ] Add VIP + General passes → HUD counts + wait time update.
- [ ] Refresh browser → queue intact (`localStorage`).
- [ ] Search by name and by `#DP-…` token → filters instantly.
- [ ] Tabs All / VIP / General → counts in parentheses match.
- [ ] Click card → gold-trimmed modal with ID, QR mockup, timestamp, group size.
- [ ] **Print / Save Token** → print preview shows only the pass.
- [ ] **Admit to Sanctum** (card + modal) → chime + toast + counters drop.
- [ ] **Reset Queue** asks for confirmation; **Load Sample Devotees** adds 5 without duplicates.
- [ ] Name > 45 chars clamped; group size clamped 1–10; empty name rejected.
