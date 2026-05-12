import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const TOKEN_DIR = join(PROJECT_ROOT, '.auth-data');
const STORAGE_STATE_FILE = join(TOKEN_DIR, 'browser_state.json');
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

// In-memory storage state to prevent filesystem writes
let _memoryStorageState = null;

function readStorageState() {
  if (_memoryStorageState) return _memoryStorageState;
  if (existsSync(STORAGE_STATE_FILE)) {
    try {
      _memoryStorageState = JSON.parse(readFileSync(STORAGE_STATE_FILE, 'utf-8'));
      return _memoryStorageState;
    } catch {
      return null;
    }
  }
  return null;
}

export async function getAutomatedAuth(headless = false) {
  const bravePath = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  
  console.log(`[Automation] Launching browser (headless: ${headless})...`);

  const browser = await chromium.launch({
    headless, // Set to false to use XVFB (headed mode in Docker)
    executablePath: existsSync(bravePath) ? bravePath : undefined,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--mute-audio'
    ],
  });

  const state = readStorageState();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    storageState: state || undefined,
  });

  try {
    const page = await context.newPage();
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for the session cookie to be present
    let sessionCookie = null;
    let bearerToken = null;
    
    // Poll for the session
    const startTime = Date.now();
    while (Date.now() - startTime < 60000) {
      const cookies = await context.cookies();
      sessionCookie = cookies.find(c => c.name === '__Secure-next-auth.session-token');
      
      if (sessionCookie) {
        // Try to get the bearer token from the page context if possible
        bearerToken = await page.evaluate(async () => {
          try {
            const res = await fetch('/fx/api/auth/session');
            const data = await res.json();
            return data.access_token || data.accessToken;
          } catch { return null; }
        });
        
        if (bearerToken) break;
      }
      
      if (!headless) {
        // If not headless, give user time to login manually if needed
        await new Promise(r => setTimeout(r, 2000));
      } else {
        // If headless and no cookie, it might need manual login once
        if (!sessionCookie) break; 
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (sessionCookie && bearerToken) {
      _memoryStorageState = await context.storageState();
      return { sessionCookie: sessionCookie.value, accessToken: bearerToken };
    }
    
    return null;
  } catch (err) {
    console.error('[Automation] Auth error:', err.message);
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function getLiveSessionCookie() {
  const auth = await getAutomatedAuth(true);
  return auth?.sessionCookie || null;
}

export async function getAutomatedRecaptchaToken(action = 'IMAGE_GENERATION') {
  const bravePath = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  
  console.log(`\n[Automation] Launching browser for ${action}...`);

  const browser = await chromium.launch({
    headless: false, // Set to false to use XVFB (headed mode in Docker)
    executablePath: existsSync(bravePath) ? bravePath : undefined,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--mute-audio',
      '--window-size=1280,720'
    ],
  });

  // Load state if it exists
  const state = readStorageState();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    storageState: state || undefined,
  });

  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    // Set a realistic timeout
    page.setDefaultTimeout(60000);

    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle' });

    // Human-like behavior: more movements and clicks
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(Math.random() * 1000, Math.random() * 800);
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
    }

    // Scroll a bit
    await page.evaluate(() => window.scrollBy(0, 100));
    await new Promise(r => setTimeout(r, 2000));

    // Wait for grecaptcha to be ready with retries inside evaluate
    const token = await page.evaluate(async (args) => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      
      for (let i = 0; i < 20; i++) {
        if (typeof grecaptcha !== 'undefined' && grecaptcha.enterprise && grecaptcha.enterprise.execute) {
          try {
            return await grecaptcha.enterprise.execute(args.siteKey, { action: args.action });
          } catch (e) {
            console.error('reCAPTCHA execute error:', e.message);
          }
        }
        await wait(1000);
      }
      throw new Error('reCAPTCHA (grecaptcha.enterprise) failed to load or execute after 20s');
    }, { siteKey: SITE_KEY, action });

    // Update in-memory state
    _memoryStorageState = await context.storageState();
    console.log(`[Automation] Token acquired successfully.`);
    
    return token;
  } catch (err) {
    console.error('[Automation] Error during reCAPTCHA extraction:', err.message);
    throw new Error(`reCAPTCHA automation failed: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function closeBrowser() {
  // No-op
}
