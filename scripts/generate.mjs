#!/usr/bin/env node
/**
 * Flow Proxy — Image Generator
 * Generate images via Google Flow (Imagen 4, Nano Banana 2 / Pro)
 * No API key, no npm install — just Node.js 18+ and Chrome
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import {
  ensureToken,
  getRecaptchaToken,
  startServer,
  cleanup,
  resolveProjectId,
} from './lib/auth.mjs';

const ENDPOINT_BASE = 'https://aisandbox-pa.googleapis.com/v1';

const MODELS = {
  'imagen4':     'IMAGEN_3_5',
  'banana':      'NARWHAL',
  'banana2':     'NARWHAL',
  'banana-pro':  'GEM_PIX_2',
};

const ASPECT_MAP = {
  '1:1':  'IMAGE_ASPECT_RATIO_SQUARE',
  '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
  '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
  '4:3':  'IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE',
  '3:4':  'IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR',
};

const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('generate.mjs'));
let values = {};

if (isMain) {
  const parsed = parseArgs({
    options: {
      prompt:     { type: 'string',  short: 'p' },
      model:      { type: 'string',  short: 'm', default: 'imagen4' },
      ratio:      { type: 'string',  short: 'r', default: '16:9' },
      image:      { type: 'string',  short: 'i' },
      output:     { type: 'string',  short: 'o', default: '.' },
      count:      { type: 'string',  short: 'c', default: '1' },
      seed:       { type: 'string',  short: 's' },
      'project-id': { type: 'string', short: 'j' },
      help:       { type: 'boolean', short: 'h', default: false },
    },
  });
  values = parsed.values;

  if (values.help || !values.prompt) {
    console.log(`Flow Image Generator

Usage: node generate.mjs -p "prompt" [options]

Options:
  -p, --prompt       Image description (English works best)      [required]
  -m, --model        Model: imagen4, banana2, banana-pro          [default: imagen4]
  -r, --ratio        Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4   [default: 16:9]
  -i, --image        Reference image path (optional)
  -o, --output       Output directory                            [default: .]
  -c, --count        Number of images per request (1-4)          [default: 1]
  -s, --seed         Random seed (for reproducibility)
  -j, --project-id   Google Flow project ID (saved on first use)
  -h, --help         Show this help

Models:
  imagen4      Imagen 4 (highest quality, default)
  banana2      Nano Banana 2
  banana-pro   Nano Banana Pro`);
    process.exit(values.help ? 0 : 1);
  }
}

export function detectImageExtension(buffer, contentType = '') {
  const normalizedType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (normalizedType === 'image/jpeg') return 'jpg';
  if (normalizedType === 'image/png') return 'png';
  if (normalizedType === 'image/webp') return 'webp';

  if (buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff) {
    return 'jpg';
  }
  if (buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47) {
    return 'png';
  }
  if (buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }

  return 'bin';
}

export async function uploadReferenceImage(imagePath, token, projectId) {
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

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Image upload failed ${res.status}: ${JSON.stringify(data)}`);
  }

  const mediaId = data.media?.name;
  if (!mediaId) throw new Error('No mediaId returned from image upload');
  return mediaId;
}

export async function generate(prompt, model, ratio, count, seed, token, projectId, recaptchaToken, imageInputs = []) {
  const sessionId = ';' + Date.now();
  const batchId = randomUUID();
  const clientCtx = {
    recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
    projectId,
    tool: 'PINHOLE',
    sessionId,
  };

  const payload = {
    clientContext: clientCtx,
    mediaGenerationContext: { batchId },
    useNewMedia: true,
    requests: Array.from({ length: count }, () => ({
      clientContext: clientCtx,
      imageModelName: MODELS[model] || 'IMAGEN_3_5',
      imageAspectRatio: ASPECT_MAP[ratio] || 'IMAGE_ASPECT_RATIO_SQUARE',
      structuredPrompt: { parts: [{ text: prompt }] },
      seed: seed ?? Math.floor(Math.random() * 2147483647),
      imageInputs,
    })),
  };

  const res = await fetch(
    `${ENDPOINT_BASE}/projects/${projectId}/flowMedia:batchGenerateImages`,
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
  return extractImages(data);
}

/**
 * Extract base64 images from the response.
 * Handles Flow (media[]) and legacy ImageFX (imagePanels) formats.
 */
export function extractImages(data) {
  // Flow format: { media: [{ image: { generatedImage: { fifeUrl | encodedImage } } }] }
  if (Array.isArray(data.media) && data.media.length > 0) {
    const results = [];
    for (const item of data.media) {
      const g = item.image?.generatedImage;
      if (!g) continue;
      if (g.fifeUrl) {
        results.push({ type: 'url', url: g.fifeUrl });
      } else {
        const b64 = g.encodedImage || g.imageBytes;
        if (b64) results.push({ type: 'base64', data: b64 });
      }
    }
    if (results.length > 0) return results;

    console.error('\nCould not find image data. Response structure:');
    console.error(JSON.stringify(data.media[0], null, 2));
    throw new Error('Image data not found in response');
  }

  // Legacy ImageFX format: { imagePanels: [{ generatedImages: [{ encodedImage }] }] }
  if (data.imagePanels) {
    const panels = data.imagePanels;
    if (panels.length > 0 && panels[0].generatedImages?.length > 0) {
      return panels[0].generatedImages.map(img => ({ type: 'base64', data: img.encodedImage }));
    }
  }

  // Unknown format
  console.error('\nUnexpected response structure:');
  console.error(JSON.stringify(data, null, 2).slice(0, 800));
  throw new Error('Could not extract images from response');
}

async function main() {
  await startServer();

  const token = await ensureToken();
  const projectId = resolveProjectId(values['project-id'], 'generate.mjs');
  const outputDir = values.output;
  const count = Math.min(Math.max(parseInt(values.count) || 1, 1), 4);
  const model = values.model;
  const seed = values.seed ? parseInt(values.seed) : undefined;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const modelLabel = model in MODELS ? model : 'imagen4';
  console.log(`\nGenerating ${count} image(s): "${values.prompt}" [${modelLabel}, ${values.ratio}]`);

  try {
    const recaptchaToken = await getRecaptchaToken();
    console.log(' OK');

    let imageInputs = [];
    if (values.image) {
      console.log(`Uploading reference image: ${values.image}`);
      const mediaId = await uploadReferenceImage(values.image, token, projectId);
      console.log(`Reference media ID: ${mediaId}`);
      imageInputs = [{ name: mediaId }];
    }

    const images = await generate(
      values.prompt, model, values.ratio, count, seed,
      token, projectId, recaptchaToken, imageInputs
    );

    const ts = Date.now();
    for (let i = 0; i < images.length; i++) {
      const item = images[i];
      let buf;
      let ext;
      if (item.type === 'url') {
        const imgRes = await fetch(item.url);
        if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);
        buf = Buffer.from(await imgRes.arrayBuffer());
        ext = detectImageExtension(buf, imgRes.headers.get('content-type') || '');
      } else {
        buf = Buffer.from(item.data, 'base64');
        ext = detectImageExtension(buf);
      }

      const filepath = join(outputDir, `flow_${ts}_${i}.${ext}`);
      writeFileSync(filepath, buf);
      console.log(`Saved: ${filepath}`);
    }

    console.log(`\nDone! ${images.length} image(s) saved.`);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    cleanup();
    process.exit(1);
  }

  cleanup();
}

if (isMain) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    cleanup();
    process.exit(1);
  });
}
