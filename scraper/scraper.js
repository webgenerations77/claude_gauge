const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { upsertUsageRow, logScrape, upsertQuota, upsertClaudeUsage, upsertOpenAIUsageRow, completeScrapeRequests } = require('./firebase');

const SESSION_PATH = path.join(__dirname, 'session.json');
const CLAUDE_SESSION_PATH = path.join(__dirname, 'session-claude.json');
const OPENAI_SESSION_PATH = path.join(__dirname, 'session-openai.json');
const USAGE_URL = 'https://platform.claude.com/settings/usage';
const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';
const OPENAI_USAGE_URL = 'https://platform.openai.com/usage';
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
  log(`API console scrape done. ${upserted} rows upserted.`);

  await browser.close();
}

async function scrapeClaude() {
  if (!fs.existsSync(CLAUDE_SESSION_PATH)) {
    log('No session-claude.json — skipping claude.ai scrape. Run "npm run login:claude" to set up.');
    return;
  }

  const cookies = JSON.parse(fs.readFileSync(CLAUDE_SESSION_PATH, 'utf-8'));

  log('=== Scraping claude.ai usage ===');
  const browser = await puppeteer.launch({
    headless: false,
    channel: 'chrome',
    defaultViewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=10000,10000',
    ],
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.setCookie(...cookies);

  log(`Navigating to ${CLAUDE_USAGE_URL}...`);
  await page.goto(CLAUDE_USAGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // Wait for Cloudflare challenge
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const text = await page.evaluate(() => document.body.innerText.substring(0, 300));
    if (!text.includes('security verification') && !text.includes('Cloudflare')) break;
    log('Waiting for Cloudflare...');
  }

  const currentUrl = page.url();
  if (currentUrl.includes('/login')) {
    log('Claude.ai session expired — run "npm run login:claude" to re-authenticate.');
    await browser.close();
    return;
  }

  await new Promise((r) => setTimeout(r, 5000));

  const claudeData = await page.evaluate(() => {
    const text = document.body.innerText;
    const result = {
      plan: null,
      sessionPct: null,
      sessionResets: null,
      weeklyPct: null,
      weeklyResets: null,
      creditsSpent: null,
      creditsResets: null,
      currentBalance: null,
      monthlySpendLimit: null,
    };

    const planMatch = text.match(/Pro|Max|Free/);
    if (planMatch) result.plan = planMatch[0];

    const sessionPctMatch = text.match(/Current session[\s\S]*?(\d+)%\s*used/i);
    if (sessionPctMatch) result.sessionPct = parseInt(sessionPctMatch[1]);

    const sessionResetMatch = text.match(/Resets?\s+in\s+([\d]+\s*hr?\s*[\d]*\s*min?)/i);
    if (sessionResetMatch) result.sessionResets = sessionResetMatch[1].trim();

    const weeklyPctMatch = text.match(/Weekly\s+limits[\s\S]*?(\d+)%\s*used/i);
    if (weeklyPctMatch) result.weeklyPct = parseInt(weeklyPctMatch[1]);

    const weeklyResetMatch = text.match(/Resets?\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[\s\S]*?(\d+:\d+\s*(?:AM|PM))/i);
    if (weeklyResetMatch) result.weeklyResets = `${weeklyResetMatch[1]} ${weeklyResetMatch[2]}`;

    const spentMatch = text.match(/\$([\d.]+)\s*spent/i);
    if (spentMatch) result.creditsSpent = parseFloat(spentMatch[1]);

    const creditsResetMatch = text.match(/Resets?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)/i);
    if (creditsResetMatch) result.creditsResets = `${creditsResetMatch[1]} ${creditsResetMatch[2]}`;

    const balanceMatch = text.match(/\$([\d.]+)\s*\n?\s*Current\s+balance/i);
    if (!balanceMatch) {
      const altMatch = text.match(/Current\s+balance[·\s]*([\s\S]*?\$([\d.]+))/i);
      if (altMatch) result.currentBalance = parseFloat(altMatch[2]);
    } else {
      result.currentBalance = parseFloat(balanceMatch[1]);
    }

    const limitMatch = text.match(/Monthly\s+spend\s+limit[\s\S]*?(Unlimited|\$([\d,.]+))/i);
    if (limitMatch) {
      result.monthlySpendLimit = limitMatch[1] === 'Unlimited' ? 'Unlimited' : parseFloat(limitMatch[2]);
    }

    return result;
  });

  log(`Claude.ai data: plan=${claudeData.plan}, session=${claudeData.sessionPct}%, weekly=${claudeData.weeklyPct}%, spent=$${claudeData.creditsSpent}, balance=$${claudeData.currentBalance}`);

  try {
    await upsertClaudeUsage(claudeData);
    log('Claude.ai usage saved to Firestore.');
  } catch (err) {
    log(`Error saving claude.ai usage: ${err.message}`);
  }

  await browser.close();
}

function parseOpenAICSV(text) {
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

    const dateVal = obj.date || obj.timestamp || Object.values(obj)[0] || '';
    const dateMatch = dateVal.match(/\d{4}-\d{2}-\d{2}/);
    const model = (obj.model || obj.snapshot_id || obj.model_version || 'unknown').trim().toLowerCase();

    rows.push({
      date: dateMatch ? dateMatch[0] : new Date().toISOString().split('T')[0],
      model,
      inputTokens: safeNum(obj.n_context_tokens_total || obj.input_tokens || obj.context_tokens || '0'),
      outputTokens: safeNum(obj.n_generated_tokens_total || obj.output_tokens || obj.generated_tokens || '0'),
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: safeCost(obj.cost_in_major || obj.cost || obj.cost_usd || ''),
      requests: safeNum(obj.num_model_requests || obj.requests || '0'),
    });
  }

  return rows;
}

async function scrapeOpenAI() {
  if (!fs.existsSync(OPENAI_SESSION_PATH)) {
    log('No session-openai.json — skipping OpenAI scrape. Run "npm run login:openai" to set up.');
    return;
  }

  const cookies = JSON.parse(fs.readFileSync(OPENAI_SESSION_PATH, 'utf-8'));

  log('=== Scraping OpenAI usage ===');
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

  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR,
  });

  log(`Navigating to ${OPENAI_USAGE_URL}...`);
  await page.goto(OPENAI_USAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('/auth')) {
    log('OpenAI session expired — run "npm run login:openai" to re-authenticate.');
    await browser.close();
    return;
  }

  await new Promise((r) => setTimeout(r, 5000));

  if (isDebug) {
    await page.screenshot({ path: path.join(__dirname, 'debug-openai.png'), fullPage: true });
    log('Debug screenshot saved to debug-openai.png');
  }

  // Clear downloads
  for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
    fs.unlinkSync(path.join(DOWNLOAD_DIR, f));
  }

  // Find and click export/download button
  log('Looking for export button...');
  let downloadClicked = false;
  const buttons = await page.$$('button, a');
  for (const btn of buttons) {
    const text = await btn.evaluate((el) => el.textContent.trim().toLowerCase());
    const ariaLabel = await btn.evaluate((el) => (el.getAttribute('aria-label') || '').toLowerCase());
    const title = await btn.evaluate((el) => (el.getAttribute('title') || '').toLowerCase());
    if (
      text.includes('export') ||
      text.includes('download') ||
      ariaLabel.includes('export') ||
      ariaLabel.includes('download') ||
      title.includes('export') ||
      title.includes('download')
    ) {
      await btn.click();
      await new Promise((r) => setTimeout(r, 3000));
      downloadClicked = true;
      log('Clicked export button');
      break;
    }
  }

  const usageRows = [];

  if (downloadClicked) {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const csvFile = files.find((f) => f.endsWith('.csv'));
    if (csvFile) {
      const csvText = fs.readFileSync(path.join(DOWNLOAD_DIR, csvFile), 'utf-8');
      const rows = parseOpenAICSV(csvText);
      usageRows.push(...rows);
      log(`Parsed ${rows.length} rows from OpenAI CSV`);
    } else {
      log('No CSV file found after clicking export.');
    }
  } else {
    log('Could not find export button on OpenAI usage page.');
  }

  let upserted = 0;
  for (const row of usageRows) {
    try {
      await upsertOpenAIUsageRow(row);
      upserted++;
    } catch (err) {
      log(`Error upserting OpenAI row: ${err.message}`);
    }
  }

  log(`OpenAI scrape done. ${upserted} rows upserted.`);
  await browser.close();
}

async function main() {
  try {
    await scrape();
  } catch (err) {
    log(`API console scrape error: ${err.message}`);
    try {
      await logScrape({ status: 'error', rowsUpserted: 0, errorMessage: err.message });
    } catch {}
  }

  try {
    await scrapeClaude();
  } catch (err) {
    log(`Claude.ai scrape error: ${err.message}`);
  }

  try {
    await scrapeOpenAI();
  } catch (err) {
    log(`OpenAI scrape error: ${err.message}`);
  }

  try {
    const completed = await completeScrapeRequests();
    if (completed > 0) log(`Completed ${completed} pending scrape request(s).`);
  } catch (err) {
    log(`Error completing scrape requests: ${err.message}`);
  }
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
