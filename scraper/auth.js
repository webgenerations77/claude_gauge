const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = path.join(__dirname, 'session.json');
const CONSOLE_URL = 'https://platform.claude.com';

const LOGIN_URLS = ['/login', '/oauth', '/auth', 'accounts.google', 'clerk.'];

async function authenticate() {
  console.log('Launching browser for manual login...');
  console.log(`Navigate to: ${CONSOLE_URL}`);
  console.log('Log in manually. The browser will close automatically once login is detected.');
  console.log('If it does not close, navigate to any platform.claude.com page after logging in.\n');

  const browser = await puppeteer.launch({
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

  const page = (await browser.pages())[0] || await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  await page.goto(CONSOLE_URL, { waitUntil: 'networkidle2' });

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
    const onConsole =
      url.startsWith('https://platform.claude.com') ||
      url.startsWith('https://console.anthropic.com');

    if (!onLoginPage && onConsole) {
      await new Promise((r) => setTimeout(r, 3000));

      const cookies = await page.cookies();
      fs.writeFileSync(SESSION_PATH, JSON.stringify(cookies, null, 2));
      console.log(`\nSession saved to ${SESSION_PATH}`);
      console.log(`Cookies captured: ${cookies.length}`);
      break;
    }
  }

  await browser.close();
  console.log('Browser closed. You can now run: npm run scrape');
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
