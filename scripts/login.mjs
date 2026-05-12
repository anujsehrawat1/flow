import { chromium } from 'playwright';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';

const TOKEN_DIR = join(homedir(), '.flow-proxy');
const USER_DATA_DIR = join(TOKEN_DIR, 'browser_data');
const TOKEN_FILE = join(TOKEN_DIR, 'token.json');

async function login() {
  if (!existsSync(TOKEN_DIR)) {
    mkdirSync(TOKEN_DIR, { recursive: true });
  }

  console.log('Opening browser for login...');
  console.log('Please sign in to your Google account on the opened page.');

  // Use Persistent Context for real user profile
  const bravePath = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    executablePath: existsSync(bravePath) ? bravePath : undefined,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  await page.goto('https://labs.google/fx/tools/flow');

  console.log('Waiting for you to complete sign-in...');

  // Wait for the session cookie to appear
  let sessionCookie = null;
  while (!sessionCookie) {
    const cookies = await context.cookies();
    sessionCookie = cookies.find(c => c.name === '__Secure-next-auth.session-token');
    if (!sessionCookie) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log('Sign-in detected! Saving session...');

  // Update token.json with the session cookie
  let tokenData = {};
  if (existsSync(TOKEN_FILE)) {
    try {
      tokenData = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
    } catch (e) {}
  }

  tokenData.sessionCookie = sessionCookie.value;
  writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));

  console.log('Session saved successfully!');
  await context.close();
}

login().catch(err => {
  console.error('Login failed:', err);
  process.exit(1);
});
