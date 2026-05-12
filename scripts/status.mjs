#!/usr/bin/env node
/**
 * Flow Proxy — Token Status
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TOKEN_FILE = join(homedir(), '.flow-proxy', 'token.json');

async function main() {
  if (!existsSync(TOKEN_FILE)) {
    console.log('Token not found');
    console.log(`Expected at: ${TOKEN_FILE}`);
    console.log('\nInstall the Flow Proxy Chrome extension,');
    console.log('open https://labs.google/fx/tools/flow and click Connect.');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));

  // Check access token expiry
  if (data.expiresAt) {
    const remaining = data.expiresAt - Date.now();
    if (remaining <= 0) {
      console.log('Access token expired');
    } else {
      const mins = Math.floor(remaining / 60000);
      console.log(`Access token valid. Expires in: ${mins} minutes`);
    }
  }

  // Check session cookie presence
  if (data.sessionCookie) {
    console.log('Session cookie: present (auto-refresh enabled, ~30 days)');
  } else {
    console.log('Session cookie: not saved (no auto-refresh)');
  }

  // Validate with Google
  if (data.accessToken) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${data.accessToken}`
      );
      if (res.ok) {
        const info = await res.json();
        console.log(`Google confirms: valid for ${info.expires_in}s`);
      } else {
        console.log('Google validation failed — token may be expired');
        if (data.sessionCookie) {
          console.log('Auto-refresh will attempt on next generation.');
        }
      }
    } catch {
      console.log('Could not validate with Google (network error)');
    }
  }
}

main();
