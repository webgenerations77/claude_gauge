const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { upsertUsageRow, logScrape, upsertQuota } = require('./firebase');

const SESSION_PATH = path.join(__dirname, 'session.json');
const USAGE_URL = 'https://platform.claude.com/settings/usage';
const DEBUG_SCREENSHOT = path.join(__dirname, 'debug-last-run.png');
const DEBUG_HTML = path.join(__dirname, 'debug-last-run.html');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const isDebug = process.argv.includes('--debug');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function loadSession() {
  if (!fs.existsSync(SESSION_PATH)) {
    console.error(
      'No session.json found. Run "npm run login" to authenticate first.'
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map((v) => v.trim());
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] || '';
    });
    rows.push(obj);
  }

  return rows;
}

function normalizeModel(raw) {
  if (!raw) return 'unknown';
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

function safeNum(val) {
  if (!val) return 0;
  const n = parseFloat(val.replace(/,/g, ''));
  return isNaN(n) ? 0 : Math.round(n);
}

function safeCost(val) {
  if (!val) return null;
  const n = parseFloat(val.replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

async function scrape() {
  const cookies = await loadSession();

  log(`Launching browser (${isDebug ? 'headed' : 'headless'} mode)...`);

  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

  const browser = await puppeteer.launch({
    headless: isDebug ? false : 'new',
    channel: 'chrome',
    defaultViewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  await page.setCookie(...cookies);

  // Set download behavior
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR,
  });

  log(`Navigating to ${USAGE_URL}...`);
  await page.goto(USAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Check for login redirect
  const currentUrl = page.url();
  if (
    currentUrl.includes('/login') ||
    currentUrl.includes('/oauth') ||
    currentUrl.includes('/auth') ||
    currentUrl.includes('accounts.google')
  ) {
    await browser.close();
    console.error(
      'Session expired — run "npm run login" (node auth.js) to re-authenticate'
    );
    process.exit(1);
  }

  log('Waiting for usage page to render...');

  // Wait for the page content to load
  try {
    await page.waitForSelector('[class*="usage"], [class*="Usage"], h1, h2', {
      timeout: 15000,
    });
  } catch {
    log('Primary selectors not found, continuing...');
  }

  // Wait for data to populate
  await new Promise((r) => setTimeout(r, 5000));

  // Scrape quota/credits from the page
  log('Extracting quota info...');
  const quota = await page.evaluate(() => {
    const body = document.body.innerText;
    const result = {
      creditsUsd: null,
      unpaidBalanceUsd: null,
      rateLimitTier: null,
    };

    const creditMatch = body.match(/Credits\s*[-–]?\$?([\d,.]+)/i);
    if (creditMatch) {
      result.creditsUsd = parseFloat(creditMatch[1].replace(/,/g, ''));
    }

    const negCreditMatch = body.match(/Credits\s*-\s*\$?([\d,.]+)/i);
    if (negCreditMatch) {
      result.creditsUsd = -parseFloat(negCreditMatch[1].replace(/,/g, ''));
    }

    const balanceMatch = body.match(/unpaid\s+balance\s+of\s+\$?([\d,.]+)/i);
    if (balanceMatch) {
      result.unpaidBalanceUsd = parseFloat(balanceMatch[1].replace(/,/g, ''));
    }

    const tierMatch = body.match(/(?:tier|rate\s*limit)[:\s]*([\w\d]+)/i);
    if (tierMatch) {
      result.rateLimitTier = tierMatch[1];
    }

    return result;
  });

  if (quota.creditsUsd !== null || quota.unpaidBalanceUsd !== null) {
    log(`Quota: credits=${quota.creditsUsd}, unpaid=${quota.unpaidBalanceUsd}`);
    try {
      await upsertQuota(quota);
      log('Quota saved to Firestore.');
    } catch (err) {
      log(`Error saving quota: ${err.message}`);
    }
  } else {
    log('No quota info found on page.');
  }

  // Ensure "View by" is set to "Month" (gives per-model totals per month)
  log('Checking view mode...');
  try {
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await btn.evaluate((el) => el.textContent.trim());
      if (/view\s+by/i.test(text)) {
        log(`Current view: "${text}"`);
        if (/month/i.test(text)) {
          log('Already on Month view');
          break;
        }
        await btn.click();
        await new Promise((r) => setTimeout(r, 1000));
        const options = await page.$$('[role="option"], [role="menuitem"], [role="menuitemradio"], li, button');
        for (const opt of options) {
          const optText = await opt.evaluate((el) => el.textContent.trim());
          if (/^month$/i.test(optText)) {
            await opt.click();
            log('Switched to Month view');
            await new Promise((r) => setTimeout(r, 3000));
            break;
          }
        }
        break;
      }
    }
  } catch (err) {
    log(`Could not set Month view: ${err.message}`);
  }

  // Navigate back through recent months to scrape historical data
  async function navigatePrevMonth() {
    const prevButtons = await page.$$('button');
    for (const btn of prevButtons) {
      const ariaLabel = await btn.evaluate((el) => (el.getAttribute('aria-label') || '').toLowerCase());
      const text = await btn.evaluate((el) => el.textContent.trim());
      if (ariaLabel.includes('previous') || text === '<' || text === '‹' || ariaLabel.includes('back')) {
        await btn.click();
        await new Promise((r) => setTimeout(r, 3000));
        return true;
      }
    }
    // Try the left arrow "‹" button near the month label
    const arrows = await page.$$('button');
    for (const btn of arrows) {
      const innerHTML = await btn.evaluate((el) => el.innerHTML);
      if (innerHTML.includes('chevron') || innerHTML.includes('left') || innerHTML.includes('&#8249;')) {
        const rect = await btn.boundingBox();
        if (rect && rect.width < 60) {
          await btn.click();
          await new Promise((r) => setTimeout(r, 3000));
          return true;
        }
      }
    }
    return false;
  }

  if (isDebug) {
    const html = await page.content();
    fs.writeFileSync(DEBUG_HTML, html);
    log(`Debug HTML saved to ${DEBUG_HTML}`);
  }

  // Download CSV for current month + previous months
  async function clearDownloads() {
    for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
      fs.unlinkSync(path.join(DOWNLOAD_DIR, f));
    }
  }

  async function clickDownloadButton() {
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const html = await btn.evaluate((el) => el.innerHTML.toLowerCase());
      const ariaLabel = await btn.evaluate((el) => (el.getAttribute('aria-label') || '').toLowerCase());
      const title = await btn.evaluate((el) => (el.getAttribute('title') || '').toLowerCase());
      if (
        html.includes('download') ||
        ariaLabel.includes('download') ||
        ariaLabel.includes('export') ||
        title.includes('download') ||
        title.includes('export')
      ) {
        await btn.click();
        await new Promise((r) => setTimeout(r, 3000));
        return true;
      }
    }
    return false;
  }

  async function readDownloadedCSV() {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const csvFile = files.find((f) => f.endsWith('.csv'));
    if (csvFile) {
      const data = fs.readFileSync(path.join(DOWNLOAD_DIR, csvFile), 'utf-8');
      return data;
    }
    return null;
  }

  const allCsvData = [];
  const MONTHS_TO_SCRAPE = 3;

  for (let m = 0; m < MONTHS_TO_SCRAPE; m++) {
    if (m > 0) {
      log(`Navigating to previous month (${m})...`);
      const went = await navigatePrevMonth();
      if (!went) {
        log('Could not navigate to previous month, stopping.');
        break;
      }
    }

    await clearDownloads();
    log(`Downloading CSV for month ${m === 0 ? '(current)' : `(-${m})`}...`);
    const clicked = await clickDownloadButton();

    if (clicked) {
      const csv = await readDownloadedCSV();
      if (csv && csv.trim().split('\n').length > 1) {
        allCsvData.push(csv);
        log(`Got CSV: ${csv.trim().split('\n').length - 1} rows`);
      } else {
        log('CSV was empty or not found for this month.');
      }
    }
  }

  // Parse all collected CSVs
  const usageRows = [];
  const today = new Date().toISOString().split('T')[0];

  for (const csvData of allCsvData) {
    const csvRows = parseCSV(csvData);

    for (const row of csvRows) {
      const dateVal =
        row.usage_date_utc || row.date || row.day || Object.values(row)[0] || '';
      const dateMatch = dateVal.match(/\d{4}-\d{2}-\d{2}/);

      const inputBase = safeNum(row.usage_input_tokens_no_cache || row.input_tokens || '0');
      const cacheWrite5m = safeNum(row.usage_input_tokens_cache_write_5m || '0');
      const cacheWrite1h = safeNum(row.usage_input_tokens_cache_write_1h || '0');
      const cacheRead = safeNum(row.usage_input_tokens_cache_read || row.cache_read_tokens || '0');
      const outputTokens = safeNum(row.usage_output_tokens || row.output_tokens || '0');

      usageRows.push({
        date: dateMatch ? dateMatch[0] : today,
        model: normalizeModel(row.model_version || row.model || Object.values(row)[1]),
        inputTokens: inputBase + cacheWrite5m + cacheWrite1h + cacheRead,
        outputTokens,
        cacheCreationTokens: cacheWrite5m + cacheWrite1h,
        cacheReadTokens: cacheRead,
        costUsd: safeCost(row.cost || row.cost_usd || ''),
        webSearchCount: safeNum(row.web_search_count || '0'),
        apiKey: (row.api_key || '').trim() || null,
        workspace: (row.workspace || '').trim() || null,
      });
    }
  }

  log(`Total rows parsed across all months: ${usageRows.length}`);

  if (usageRows.length === 0) {
    await page.screenshot({ path: DEBUG_SCREENSHOT, fullPage: true });
    log('No usage rows found in CSVs (account may have zero usage this period).');
    await logScrape({
      status: quota.creditsUsd !== null ? 'success' : 'error',
      rowsUpserted: 0,
      errorMessage: usageRows.length === 0 ? 'No usage rows in CSV (possibly no usage this period)' : null,
    });
    await browser.close();
    return;
  }

  // Push to Firestore
  let upserted = 0;
  for (const row of usageRows) {
    try {
      const docId = await upsertUsageRow(row);
      log(`Upserted: ${docId}`);
      upserted++;
    } catch (err) {
      log(`Error upserting row: ${err.message}`);
    }
  }

  await logScrape({ status: 'success', rowsUpserted: upserted });
  log(`Done. ${upserted} rows upserted to Firestore.`);

  await browser.close();
}

scrape().catch(async (err) => {
  log(`Fatal error: ${err.message}`);
  try {
    await logScrape({
      status: 'error',
      rowsUpserted: 0,
      errorMessage: err.message,
    });
  } catch {
    // Firebase may not be initialized
  }
  process.exit(1);
});
