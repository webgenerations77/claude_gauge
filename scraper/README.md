# Claude Usage Scraper

Node.js scraper that uses Puppeteer to extract Claude Console usage data and pushes it to Firestore.

## Setup

```bash
cd scraper
npm install
cp .env.example .env
```

Edit `.env` and set the path to your Firebase service account JSON:

```
FIREBASE_SERVICE_ACCOUNT_PATH=./service-account.json
```

## First-Time Login

```bash
npm run login
```

This opens a browser window. Log in to Claude Console manually. Once logged in, cookies are saved to `session.json` (gitignored). All subsequent scrapes run headless.

## Running a Scrape

```bash
npm run scrape
```

## Debugging

If the scraper fails to find usage data, run in debug mode:

```bash
npm run debug
```

This launches a visible browser and saves:
- `debug-last-run.html` — raw page HTML for DOM inspection
- `debug-last-run.png` — full-page screenshot (also saved on errors in normal mode)

## Session Expiry

If you see `Session expired — run "npm run login" to re-authenticate`, your cookies have expired. Run `npm run login` again.

## Logs

Scraper output is appended to `logs/scraper.log` when run via `run.bat` (Task Scheduler).
