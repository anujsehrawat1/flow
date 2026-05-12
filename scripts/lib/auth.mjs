/**
 * Flow Proxy — Auth module
 * Token management + persistent HTTP server for auth and reCAPTCHA
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { getAutomatedRecaptchaToken, closeBrowser as closeAutomatedBrowser, getLiveSessionCookie, getAutomatedAuth } from './browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const TOKEN_DIR = join(PROJECT_ROOT, '.auth-data');
const TOKEN_FILE = join(TOKEN_DIR, 'token.json');
const STORAGE_STATE_FILE = join(TOKEN_DIR, 'browser_state.json');
const PORT = 3847;

// Server state
let _server = null;
let _authResolve = null;

// reCAPTCHA state
let _recaptchaNeeded = false;
let _recaptchaAction = 'IMAGE_GENERATION';
let _recaptchaResolve = null;
let _recaptchaReject = null;
let _recaptchaPromise = null; // cached pending promise

// ─── Token file helpers ────────────────────────────────────────────────────

// In-memory cache to prevent filesystem writes that trigger rebuilds on Hugging Face
let _memoryTokenData = null;

export function readToken() {
  if (_memoryTokenData) return _memoryTokenData;
  
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    _memoryTokenData = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
    return _memoryTokenData;
  } catch {
    return null;
  }
}

export function saveToken(data) {
  // Update in-memory cache
  _memoryTokenData = { ...(_memoryTokenData || {}), ...data };
  console.log('[Auth] Token data updated in memory.');
}

/**
 * Ensures we have a valid session cookie.
 * If the current one is missing or likely expired, it scrapes a new one from a headless browser.
 */
export async function ensureSessionCookie() {
  const data = readToken() || {};
  
  // Try to use existing cookie first
  if (data.sessionCookie) {
    const token = await refreshToken(data.sessionCookie);
    if (token) return data.sessionCookie;
  }

  // If missing or invalid, scrape live
  console.log('Session cookie expired or missing. Fetching live from browser...');
  const auth = await getAutomatedAuth(true);
  if (auth) {
    saveToken({ 
      ...data, 
      sessionCookie: auth.sessionCookie, 
      accessToken: auth.accessToken, 
      expiresAt: Date.now() + 3600000 
    });
    return auth.sessionCookie;
  }

  return null;
}

export function resolveProjectId(cliProjectId, commandName) {
  if (cliProjectId) {
    const data = readToken() || {};
    if (data.projectId !== cliProjectId) {
      saveToken({ ...data, projectId: cliProjectId });
    }
    return cliProjectId;
  }

  const data = readToken();
  if (data?.projectId) return data.projectId;

  console.error(`
Error: Project ID not found.

Find your project ID:
  1. Open https://labs.google/fx/tools/flow in Chrome
  2. Open any project — the URL will look like:
     https://labs.google/fx/tools/flow/project/YOUR_UUID
  3. Copy the UUID from the URL

Then run with: node ${commandName} -p "..." --project-id YOUR_UUID
(Saved automatically for future runs)
`);
  process.exit(1);
}

// ─── Token validation & refresh ───────────────────────────────────────────

export async function refreshToken(sessionCookie) {
  const res = await fetch('https://labs.google/fx/api/auth/session', {
    headers: { 'Cookie': `__Secure-next-auth.session-token=${sessionCookie}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token || data.accessToken || null;
}

export async function getValidToken() {
  const data = readToken() || {};

  // Token still valid (5 min buffer)
  if (data.accessToken && data.expiresAt && data.expiresAt > Date.now() + 300000) {
    return data.accessToken;
  }

  // Auto-refresh via session cookie or scraping
  console.log('[Auth] Token expired or missing. Attempting refresh...');
  const sessionCookie = await ensureSessionCookie();
  if (sessionCookie) {
    const newToken = await refreshToken(sessionCookie);
    if (newToken) {
      saveToken({ ...data, sessionCookie, accessToken: newToken, expiresAt: Date.now() + 3600000 });
      console.log('[Auth] Token auto-refreshed via session cookie.');
      return newToken;
    }
  }

  return null;
}

// ─── HTTP server ───────────────────────────────────────────────────────────

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // Status
  if (req.method === 'GET' && req.url === '/status') {
    const token = readToken();
    const connected = !!(token?.accessToken && token.expiresAt > Date.now());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ connected, message: connected ? 'Token valid' : 'Waiting for connection' }));
    return;
  }

  // OAuth token from extension (Fallback support)
  if (req.method === 'POST' && req.url === '/auth') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { accessToken, sessionCookie } = JSON.parse(body);
        if (!accessToken || !accessToken.startsWith('ya29')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid token' }));
          return;
        }
        saveToken({ accessToken, sessionCookie: sessionCookie || null, expiresAt: Date.now() + 3600000 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Connected!' }));
        if (_authResolve) {
          console.log('Token received! Proceeding...\n');
          const resolve = _authResolve;
          _authResolve = null;
          resolve(accessToken);
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // reCAPTCHA need check (polled by the extension content script on labs.google)
  if (req.method === 'GET' && req.url === '/need-recaptcha') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ needed: _recaptchaNeeded, action: _recaptchaAction }));
    return;
  }

  // reCAPTCHA token from extension
  if (req.method === 'POST' && req.url === '/recaptcha-token') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { token, error } = JSON.parse(body);
        _recaptchaNeeded = false;
        const resolve = _recaptchaResolve;
        const reject = _recaptchaReject;
        _recaptchaResolve = null;
        _recaptchaReject = null;

        if (error && reject) {
          reject(new Error(error));
        } else if (token && resolve) {
          resolve(token);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400); res.end('Bad request');
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
}

/**
 * Start the persistent HTTP server.
 */
export function startServer() {
  return new Promise((resolve) => {
    const srv = createServer(handleRequest);

    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(null);
      } else {
        console.error('Server error:', err.message);
        resolve(null);
      }
    });

    srv.listen(PORT, '127.0.0.1', () => {
      _server = srv;
      resolve(srv);
    });
  });
}

export function stopServer() {
  if (_server) {
    _server.close();
    _server = null;
  }
}

// ─── Auth flow ─────────────────────────────────────────────────────────────

/**
 * Ensure a valid OAuth token exists.
 * Automatically triggers browser-based login if needed.
 */
export async function ensureToken() {
  const token = await getValidToken();
  if (token) return token;

  const isHF = !!process.env.SPACE_ID;
  console.log(`\n[Auth] Session expired or missing. Launching automated login (Headless: ${isHF})...`);
  
  // On HF, we MUST use headless mode. Locally we can use windowed for first-time login.
  const auth = await getAutomatedAuth(isHF);
  
  if (auth) {
    saveToken({ 
      sessionCookie: auth.sessionCookie, 
      accessToken: auth.accessToken, 
      expiresAt: Date.now() + 3600000 
    });
    console.log('[Auth] Automated login successful!');
    return auth.accessToken;
  }

  throw new Error('Automated login failed. Please ensure your browser_state.json is valid or run "npm run login" locally.');
}

// ─── reCAPTCHA ─────────────────────────────────────────────────────────────

/**
 * Request a reCAPTCHA token from the Chrome extension or via Playwright automation.
 */
export async function getRecaptchaToken(action = 'IMAGE_GENERATION') {
  // If we have a saved browser profile, use Playwright for full automation
  if (existsSync(STORAGE_STATE_FILE)) {
    try {
      process.stdout.write('Getting reCAPTCHA token (automated)...');
      const token = await getAutomatedRecaptchaToken(action);
      return token;
    } catch (err) {
      console.warn(`\nAutomated reCAPTCHA failed: ${err.message}. Falling back to extension...`);
    }
  }

  if (_recaptchaPromise) return _recaptchaPromise;

  _recaptchaPromise = new Promise((resolve, reject) => {
    _recaptchaNeeded = true;
    _recaptchaAction = action;
    _recaptchaResolve = resolve;
    _recaptchaReject = reject;

    process.stdout.write('Getting reCAPTCHA token from extension...');

    setTimeout(() => {
      if (_recaptchaNeeded) {
        _recaptchaNeeded = false;
        _recaptchaResolve = null;
        _recaptchaReject = null;
        reject(new Error(
          '\nreCAPTCHA timeout. Make sure Chrome is open with the labs.google/fx/tools/flow tab, or run "npm run login" for full automation.'
        ));
      }
    }, 30000);
  }).finally(() => {
    _recaptchaPromise = null;
  });

  return _recaptchaPromise;
}

export async function cleanup() {
  stopServer();
  await closeAutomatedBrowser();
}
