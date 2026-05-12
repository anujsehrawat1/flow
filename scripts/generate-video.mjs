#!/usr/bin/env node
/**
 * Flow Proxy — Video Generator
 * Generate videos via Google Flow (Veo 3.1 Text-to-Video, Image-to-Video)
 * No API key, no npm install — just Node.js 18+ and Chrome
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import { randomUUID } from 'crypto';
import {
  ensureToken,
  getRecaptchaToken,
  startServer,
  cleanup,
  readToken,
  resolveProjectId,
  ensureSessionCookie,
} from './lib/auth.mjs';

const ENDPOINT_BASE = 'https://aisandbox-pa.googleapis.com/v1';

const MODELS = {
  'veo':     { key: 'veo_3_1_t2v_fast',           endpoint: 'video:batchAsyncGenerateVideoText' },
  'veo-r2v': { key: 'veo_3_1_r2v_fast_landscape', endpoint: 'video:batchAsyncGenerateVideoReferenceImages' },
};

const ASPECT_MAP = {
  '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
  '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
  '1:1':  'VIDEO_ASPECT_RATIO_SQUARE',
};

const { values } = parseArgs({
  options: {
    prompt:       { type: 'string',  short: 'p' },
    model:        { type: 'string',  short: 'm', default: 'veo' },
    ratio:        { type: 'string',  short: 'r', default: '16:9' },
    image:        { type: 'string',  short: 'i' },
    output:       { type: 'string',  short: 'o', default: '.' },
    seed:         { type: 'string',  short: 's' },
    'project-id': { type: 'string',  short: 'j' },
    help:         { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || !values.prompt) {
  console.log(`Flow Video Generator

Usage: node generate-video.mjs -p "prompt" [options]

Options:
  -p, --prompt       Video description (English works best)       [required]
  -m, --model        Model: veo, veo-r2v                          [default: veo]
  -r, --ratio        Aspect ratio: 16:9, 9:16, 1:1               [default: 16:9]
  -i, --image        Reference image path (veo-r2v only)
  -o, --output       Output directory                             [default: .]
  -s, --seed         Random seed (for reproducibility)
  -j, --project-id   Google Flow project UUID (saved on first use)
  -h, --help         Show this help

Models:
  veo        Veo 3.1 Text-to-Video (default)
  veo-r2v    Veo 3.1 Image-to-Video (requires --image)`);
  process.exit(values.help ? 0 : 1);
}

if (values.model === 'veo-r2v' && !values.image) {
  console.error('Error: --image (-i) is required for veo-r2v model.');
  process.exit(1);
}

// ─── Image Upload (for veo-r2v) ───────────────────────────────────────────────

async function uploadReferenceImage(imagePath, token, projectId) {
  const imageBytes = readFileSync(imagePath).toString('base64');

  const res = await fetch(`${ENDPOINT_BASE}/flow/uploadImage`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Origin': 'https://labs.google',
    },
    body: JSON.stringify({
      clientContext: { projectId, tool: 'PINHOLE' },
      imageBytes,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Image upload failed ${res.status}: ${err}`);
  }

  const data = await res.json();
  const mediaId = data.media?.name;
  if (!mediaId) throw new Error('No mediaId returned from image upload');
  return mediaId;
}

// ─── Video Generation ─────────────────────────────────────────────────────────

async function generateVideo(prompt, model, ratio, seed, token, projectId, recaptchaToken, referenceMediaId = null) {
  const batchId = randomUUID();
  const sessionId = ';' + Date.now();

  const clientContext = {
    projectId,
    tool: 'PINHOLE',
    userPaygateTier: 'PAYGATE_TIER_ONE',
    sessionId,
    recaptchaContext: {
      token: recaptchaToken,
      applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
    },
  };

  const modelInfo = MODELS[model] || MODELS['veo'];
  const baseRequest = {
    aspectRatio: ASPECT_MAP[ratio] || 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    seed: seed ?? Math.floor(Math.random() * 2147483647),
    textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
    videoModelKey: modelInfo.key,
    metadata: {},
  };

  if (model === 'veo-r2v' && referenceMediaId) {
    baseRequest.referenceImages = [{
      mediaId: referenceMediaId,
      imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
    }];
  }

  const payload = {
    mediaGenerationContext: { batchId },
    clientContext,
    requests: [{ ...baseRequest }],
    useV2ModelConfig: true,
  };

  const res = await fetch(
    `${ENDPOINT_BASE}/${modelInfo.endpoint}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Origin': 'https://labs.google',
      },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API Error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const mediaId = data.media?.[0]?.name ?? null;
  if (!mediaId) {
    console.error('Unexpected response:', JSON.stringify(data, null, 2).slice(0, 800));
    throw new Error('Could not get mediaId from generation response');
  }

  return mediaId;
}

// ─── Polling ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DOWNLOAD_RETRY_DELAYS_MS = [0, 2000, 4000, 7000, 10000];

// WHY three variants: only SUCCESSFUL is confirmed from the API (as of 2026-04).
// COMPLETE and SUCCEEDED are kept defensively in case they appear in other contexts.
const COMPLETE_STATUSES = new Set([
  'MEDIA_GENERATION_STATUS_SUCCESSFUL',
  'MEDIA_GENERATION_STATUS_COMPLETE',
  'MEDIA_GENERATION_STATUS_SUCCEEDED',
]);
const FAILED_STATUSES = new Set([
  'MEDIA_GENERATION_STATUS_FAILED',
  'MEDIA_GENERATION_STATUS_CANCELLED',
]);
const PENDING_STATUS_HINTS = [
  'PENDING',
  'IN_PROGRESS',
  'PROCESSING',
  'RUNNING',
  'WAITING',
  'QUEUED',
  'STARTING',
  'INITIALIZING',
  'FINALIZING',
  'PREPARING',
  'GENERATING',
  'RENDERING',
];
const FAILED_STATUS_HINTS = ['FAILED', 'CANCELLED', 'ERROR', 'EXPIRED'];
const DOWNLOAD_RETRYABLE_STATUSES = new Set([404, 409, 425, 429, 500, 502, 503, 504]);

function extractMediaGenerationStatus(mediaItem) {
  const status = mediaItem?.mediaMetadata?.mediaStatus?.mediaGenerationStatus;
  return typeof status === 'string' ? status : null;
}

function classifyMediaGenerationStatus(status) {
  if (!status) return 'missing';
  if (FAILED_STATUSES.has(status) || FAILED_STATUS_HINTS.some(token => status.includes(token))) {
    return 'failed';
  }
  if (COMPLETE_STATUSES.has(status) || /(^|_)COMPLETE(D)?($|_)/.test(status)) {
    return 'complete';
  }
  if (PENDING_STATUS_HINTS.some(token => status.includes(token))) {
    return 'pending';
  }
  return 'unexpected';
}

function formatMediaStatusDiagnostic(mediaItem) {
  const diagnostic = mediaItem?.mediaMetadata?.mediaStatus ?? mediaItem ?? null;
  return JSON.stringify(diagnostic, null, 2).slice(0, 800);
}

async function pollVideoStatus(mediaId, projectId, token) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = null;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const res = await fetch(
      `${ENDPOINT_BASE}/video:batchCheckAsyncVideoGenerationStatus`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Origin': 'https://labs.google',
        },
        body: JSON.stringify({
          media: [{ name: mediaId, projectId }],
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Poll Error ${res.status}: ${err}`);
    }

    const data = await res.json();
    if (!Array.isArray(data.media) || data.media.length === 0) {
      throw new Error(
        `Poll response missing media[] for pending media: ${mediaId}`
      );
    }

    const mediaItem = data.media.find(item => item?.name === mediaId) ?? data.media[0];
    if (!mediaItem?.name) {
      throw new Error(`Poll response missing target media item: ${mediaId}`);
    }

    const status = extractMediaGenerationStatus(mediaItem);
    const statusClass = classifyMediaGenerationStatus(status);

    if (status !== lastStatus) {
      const label = status ?? 'MISSING_STATUS';
      process.stdout.write(`\n[${mediaItem.name}] ${label}`);
      lastStatus = status;
    }

    if (statusClass === 'failed') {
      throw new Error(
        `Video generation failed for ${mediaItem.name}: ${status}\n${formatMediaStatusDiagnostic(mediaItem)}`
      );
    }
    if (statusClass === 'complete') {
      process.stdout.write('. Done!\n');
      return;
    }
    if (statusClass === 'missing') {
      throw new Error(
        `Video generation status missing for ${mediaItem.name}\n${formatMediaStatusDiagnostic(mediaItem)}`
      );
    }
    if (statusClass === 'unexpected') {
      throw new Error(
        `Unexpected video generation status for ${mediaItem.name}: ${status}\n${formatMediaStatusDiagnostic(mediaItem)}`
      );
    }

    process.stdout.write('.');
  }

  throw new Error('Video generation timed out after 10 minutes.');
}

// ─── Download ─────────────────────────────────────────────────────────────────

async function downloadVideo(mediaId, sessionCookie, outputDir, ts) {
  // WHY labs.google trpc (not aisandbox-pa): the aisandbox endpoint requires
  // mediaUrlType=MEDIA_URL_TYPE_VIDEO but returns 404 for video media.
  // The trpc endpoint redirects to signed GCS URLs and accepts the session cookie.
  const redirectUrl =
    `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect` +
    `?name=${encodeURIComponent(mediaId)}`;

  for (let attempt = 0; attempt < DOWNLOAD_RETRY_DELAYS_MS.length; attempt++) {
    const delayMs = DOWNLOAD_RETRY_DELAYS_MS[attempt];
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }

    const res = await fetch(redirectUrl, {
      headers: {
        'Cookie': `__Secure-next-auth.session-token=${sessionCookie}`,
      },
      redirect: 'follow',
    });

    if (res.ok) {
      const filepath = join(outputDir, `flow_video_${ts}.mp4`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(filepath, buf);
      return filepath;
    }

    const shouldRetry =
      DOWNLOAD_RETRYABLE_STATUSES.has(res.status) &&
      attempt < DOWNLOAD_RETRY_DELAYS_MS.length - 1;
    if (!shouldRetry) {
      throw new Error(
        `Download failed for ${mediaId}: ${res.status} after ${attempt + 1} attempt(s)`
      );
    }

    process.stdout.write(
      `\n[download pending for ${mediaId}: ${res.status}; retry ${attempt + 2}/${DOWNLOAD_RETRY_DELAYS_MS.length}]`
    );
  }

  throw new Error(`Download failed for ${mediaId}: exhausted retries`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await startServer();

  const token = await ensureToken();
  const sessionCookie = await ensureSessionCookie();
  
  const projectId = resolveProjectId(values['project-id'], 'generate-video.mjs');
  const outputDir = values.output;
  const model = values.model;
  const seed = values.seed ? parseInt(values.seed) : undefined;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const modelLabel = model in MODELS ? model : 'veo';
  console.log(`\nGenerating video: "${values.prompt}" [${modelLabel}, ${values.ratio}]`);

  try {
    const recaptchaToken = await getRecaptchaToken('VIDEO_GENERATION');
    console.log(' OK');

    let referenceMediaId = null;
    if (model === 'veo-r2v') {
      console.log(`Uploading reference image: ${values.image}`);
      referenceMediaId = await uploadReferenceImage(values.image, token, projectId);
      console.log(`Reference media ID: ${referenceMediaId}`);
    }

    console.log('Submitting generation request...');
    const mediaId = await generateVideo(
      values.prompt, model, values.ratio, seed,
      token, projectId, recaptchaToken, referenceMediaId
    );
    console.log(`Media ID: ${mediaId}`);
    console.log('Waiting for video generation (this takes 1-3 minutes)');

    await pollVideoStatus(mediaId, projectId, token);
    console.log('Downloading video...');

    const ts = Date.now();
    const filepath = await downloadVideo(mediaId, sessionCookie, outputDir, ts);
    console.log(`Saved: ${filepath}`);
    console.log('\nDone!');
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    cleanup();
    process.exit(1);
  }

  cleanup();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  cleanup();
  process.exit(1);
});
