import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const TOKEN_DIR = join(PROJECT_ROOT, '.auth-data');
const STORAGE_STATE_FILE = join(TOKEN_DIR, 'browser_state.json');
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

export async function getAutomatedRecaptchaToken(action = 'IMAGE_GENERATION') {
  const bravePath = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  
  console.log(`\n[Automation] Launching browser for ${action}...`);

  const browser = await chromium.launch({
    headless: false,
    executablePath: existsSync(bravePath) ? bravePath : undefined,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--mute-audio'
    ],
  });

  // Load state if it exists
  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  };
  
  if (existsSync(STORAGE_STATE_FILE)) {
    contextOptions.storageState = STORAGE_STATE_FILE;
  }

  const context = await browser.newContext(contextOptions);

  try {
    await context.addInitScript(() => {
      delete navigator.webdriver;
    });

    const page = await context.newPage();
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle', timeout: 30000 });
    
    await page.mouse.move(Math.random() * 400, Math.random() * 400);
    await new Promise(r => setTimeout(r, 2000));

    const token = await page.evaluate(async (args) => {
      if (typeof grecaptcha === 'undefined' || !grecaptcha.enterprise) {
        throw new Error('reCAPTCHA not loaded');
      }
      return await grecaptcha.enterprise.execute(args.siteKey, { action: args.action });
    }, { siteKey: SITE_KEY, action });

    // Save state back to JSON file
    await context.storageState({ path: STORAGE_STATE_FILE });
    console.log(`[Automation] Token acquired and session state saved.`);
    
    return token;
  } catch (err) {
    console.error('[Automation] Error during token extraction:', err.message);
    throw err;
  } finally {
    await browser.close().catch(() => {});
    console.log('[Automation] Browser closed.');
  }
}

export async function closeBrowser() {
  // No-op
}
