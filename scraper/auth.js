const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = path.join(__dirname, 'session.json');
const CLAUDE_SESSION_PATH = path.join(__dirname, 'session-claude.json');
const OPENAI_SESSION_PATH = path.join(__dirname, 'session-openai.json');
const CONSOLE_URL = 'https://platform.claude.com';
const CLAUDE_URL = 'https://claude.ai';
const OPENAI_URL = 'https://platform.openai.com';

const LOGIN_URLS = ['/login', '/oauth', '/auth', 'accounts.google', 'clerk.'];

async function launchBrowser() {
  return puppeteer.launch({
    headless: false,
    channel: 'chrome',
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

async function waitForLogin(page, targetDomain) {
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));

    let url;
    try {
      url = page.url();
    } catch {
      break;
    }

    console.log(`Current URL: ${url}`);

    const onLoginPage = LOGIN_URLS.some((s) => url.includes(s));
    if (!onLoginPage && url.includes(targetDomain)) {
      await new Promise((r) => setTimeout(r, 3000));
      return await page.cookies();
    }
  }
  return null;
}

async function authOpenAI() {
  console.log('=== OpenAI Platform Authentication ===');
  console.log(`Navigate to: ${OPENAI_URL}`);
  console.log('Log in manually. The browser will close once login is detected.\n');

  const browser = await launchBrowser();
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.goto(OPENAI_URL + '/login', { waitUntil: 'networkidle2' });

  const cookies = await waitForLogin(page, 'platform.openai.com');
  if (cookies) {
    fs.writeFileSync(OPENAI_SESSION_PATH, JSON.stringify(cookies, null, 2));
    console.log(`\nOpenAI session saved (${cookies.length} cookies)`);
  }

  await browser.close();
  console.log('Done. You can now run: npm run scrape');
}

async function authenticate() {
  const target = process.argv[2];

  if (target === 'claude') {
    await authClaude();
  } else if (target === 'console') {
    await authConsole();
  } else if (target === 'openai') {
    await authOpenAI();
  } else {
    await authConsole();
    console.log('\n--- Now authenticating claude.ai ---\n');
    await authClaude();
    console.log('\n--- Now authenticating OpenAI ---\n');
    await authOpenAI();
  }
}

async function authConsole() {
  console.log('=== API Console Authentication ===');
  console.log(`Navigate to: ${CONSOLE_URL}`);
  console.log('Log in manually. The browser will close once login is detected.\n');

  const browser = await launchBrowser();
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.goto(CONSOLE_URL, { waitUntil: 'networkidle2' });

  const cookies = await waitForLogin(page, 'platform.claude.com');
  if (cookies) {
    fs.writeFileSync(SESSION_PATH, JSON.stringify(cookies, null, 2));
    console.log(`\nConsole session saved (${cookies.length} cookies)`);
  }

  await browser.close();
}

async function authClaude() {
  console.log('=== Claude.ai Authentication ===');
  console.log(`Navigate to: ${CLAUDE_URL}`);
  console.log('Log in manually. The browser will close once login is detected.\n');

  const browser = await launchBrowser();
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.goto(CLAUDE_URL + '/login', { waitUntil: 'networkidle2' });

  const cookies = await waitForLogin(page, 'claude.ai');
  if (cookies) {
    fs.writeFileSync(CLAUDE_SESSION_PATH, JSON.stringify(cookies, null, 2));
    console.log(`\nClaude.ai session saved (${cookies.length} cookies)`);
  }

  await browser.close();
  console.log('Done. You can now run: npm run scrape');
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
