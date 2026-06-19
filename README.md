# Claude Gauge

Automated scraper + dashboard for tracking Claude Console API usage and costs.

```
 ┌─────────────────┐         ┌──────────────┐         ┌────────────────────┐
 │  Windows Task   │         │   Firestore  │         │   GitHub Pages     │
 │   Scheduler     │────────▶│   Database   │◀────────│    Dashboard       │
 │  (every 4 hrs)  │ write   │              │  read   │                    │
 └────────┬────────┘         └──────────────┘         └────────────────────┘
          │
          ▼
 ┌─────────────────┐
 │   Puppeteer     │
 │  Headless       │──▶ console.anthropic.com/settings/billing
 │  Browser        │
 └─────────────────┘
```

**Zero Claude LLM credits used** — Puppeteer only hits the Console UI. Firestore reads are within the free tier.

---

## 1. Firebase Setup

### Create Project
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project (e.g., `claude-usage-monitor`)
3. Enable **Cloud Firestore** (start in production mode)

### Create Service Account (for scraper)
1. Go to **Project Settings → Service accounts**
2. Click **Generate new private key**
3. Save the JSON file as `scraper/service-account.json` (gitignored)

### Copy Web Config (for dashboard)
1. Go to **Project Settings → General → Your apps**
2. Click **Add app → Web** (name it "dashboard")
3. Copy the `firebaseConfig` object
4. Paste into `dashboard/firebase-config.js`

### Firestore Security Rules

Paste these rules in **Firebase Console → Firestore → Rules**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Dashboard reads — no auth required
    match /usage/{document=**} {
      allow read: if true;
      allow write: if false;
    }
    match /scrape_log/{document=**} {
      allow read: if true;
      allow write: if false;
    }
    match /quota/{document=**} {
      allow read: if true;
      allow write: if false;
    }
    match /claude_usage/{document=**} {
      allow read: if true;
      allow write: if false;
    }
    match /claude_usage_history/{document=**} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```

> **Note:** The scraper uses `firebase-admin` with a service account, which bypasses security rules. These rules only affect the dashboard's browser-based reads.

---

## 2. Scraper Setup

```bash
cd scraper
npm install
cp .env.example .env
```

Edit `.env`:
```
FIREBASE_SERVICE_ACCOUNT_PATH=./service-account.json
```

### First-Time Login

```bash
npm run login
```

A browser window opens. Log in to [platform.claude.com](https://platform.claude.com) manually. Cookies are saved to `session.json` (gitignored). All subsequent scrapes run headless.

### Test a Scrape

```bash
npm run scrape
```

---

## 3. Windows Task Scheduler

1. Open **Task Scheduler** (search "Task Scheduler" in Start)
2. Click **Create Task** (not "Basic Task" — need the full dialog)
3. **General** tab:
   - Name: `Claude Usage Scraper`
   - Check **"Run whether user is logged on or not"**
   - Check **"Run with highest privileges"**
4. **Triggers** tab → **New**:
   - Begin the task: **On a schedule**
   - Settings: **Daily**
   - Under **Advanced settings**: check **"Repeat task every 5 minutes"** for a duration of **Indefinitely**
5. **Actions** tab → **New**:
   - Action: **Start a program**
   - Program/script: Browse to `scraper\run.bat`
   - Start in: Full path to `scraper\` directory (e.g., `C:\Users\you\projects\claude-usage-monitor\scraper`)
6. **Settings** tab:
   - Check **"If the task is already running, do not start a new instance"**
   - Check **"If the task fails, restart every 1 minute"** up to 3 times

### Verify
Check `scraper/logs/scraper.log` after the first scheduled run.

---

## 4. Dashboard Setup

### Fill in Firebase Config

Edit `dashboard/firebase-config.js` with your Firebase project's web config:

```js
const firebaseConfig = {
  apiKey: 'AIza...',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project-id',
  storageBucket: 'your-project.firebasestorage.app',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:abc123',
};
```

### Deploy to GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Source: **GitHub Actions**
4. The workflow at `.github/workflows/deploy-dashboard.yml` auto-deploys `dashboard/` on every push to `main`

### Local Preview

Just open `dashboard/index.html` in a browser — it reads directly from Firestore.

---

## 5. Debugging

| Problem | Action |
|---------|--------|
| Scraper finds no data | Run `npm run debug` — inspect `debug-last-run.html` for DOM changes |
| Session expired | Run `npm run login` to re-authenticate |
| Scraper errors | Check `scraper/logs/scraper.log` |
| Screenshot on failure | Check `scraper/debug-last-run.png` |
| Dashboard shows no data | Verify `firebase-config.js` has correct project config |
| Dashboard shows "Error" | Check browser console for Firestore permission errors; verify security rules allow reads |

---

## Project Structure

```
claude-usage-monitor/
  scraper/
    auth.js              Login flow — saves cookies to session.json
    scraper.js           Headless scrape → Firestore
    firebase.js          Firebase Admin SDK init + helpers
    run.bat              Task Scheduler entry point
    package.json         Dependencies: puppeteer, firebase-admin, dotenv
    .env.example         Environment variable template
    .gitignore           Excludes .env, session.json, service-account.json
    logs/                Scraper log output
    README.md            Scraper-specific docs
  dashboard/
    index.html           Static dashboard page
    dashboard.js         Firestore queries + Chart.js rendering
    styles.css           Dark theme, responsive layout
    firebase-config.js   Public Firebase web config
  .github/
    workflows/
      deploy-dashboard.yml   Auto-deploy dashboard to GitHub Pages
```

## Firestore Collections

### `usage/{date}_{model}`
| Field | Type | Example |
|-------|------|---------|
| date | string | `2026-06-19` |
| model | string | `claude-sonnet-4-6` |
| inputTokens | number | `12000` |
| outputTokens | number | `3000` |
| cacheCreationTokens | number | `500` |
| cacheReadTokens | number | `200` |
| costUsd | number | `0.05` |
| updatedAt | timestamp | (auto) |

### `scrape_log/{auto-id}`
| Field | Type | Example |
|-------|------|---------|
| scrapedAt | timestamp | (auto) |
| status | string | `success` / `error` |
| rowsUpserted | number | `14` |
| errorMessage | string/null | `null` |
>>>>>>> 7e7f3ec (Initial commit: Claude Console usage monitor)
