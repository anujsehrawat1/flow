import express from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
  ensureToken,
  getRecaptchaToken,
  resolveProjectId,
  cleanup,
  readToken,
  saveToken,
  ensureSessionCookie
} from './scripts/lib/auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express({ limit: '50mb' }); // Increased limit for base64 images
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// ─── SWAGGER SETUP ─────────────────────────────────────────────────────────

// Dynamic server URL for Swagger (Hugging Face support)
const getBaseUrl = () => {
  if (process.env.SPACE_ID) {
    // Format: user-space.hf.space
    const [user, space] = process.env.SPACE_ID.split('/');
    return `https://${user}-${space.replace(/_/g, '-')}.hf.space`;
  }
  return `http://localhost:${PORT}`;
};

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Flow Proxy API',
      version: '2.5.0',
      description: 'Advanced Image & Video generation proxy for Google Flow. Supports auto-project creation and detailed status tracking.',
    },
    servers: [{ url: getBaseUrl() }],
  },
  apis: ['./server.mjs'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// API Config
const ENDPOINT_BASE = 'https://aisandbox-pa.googleapis.com/v1';

const MODELS_IMAGE = {
  'imagen4': 'IMAGEN_3_5',
  'banana':  'NARWHAL',
  'banana2': 'NARWHAL',
  'banana-pro': 'GEM_PIX_2',
};

const MODELS_VIDEO = {
  'veo':     { key: 'veo_3_1_t2v_fast',           endpoint: 'video:batchAsyncGenerateVideoText' },
  'veo-r2v': { key: 'veo_3_1_r2v_fast_landscape', endpoint: 'video:batchAsyncGenerateVideoReferenceImages' },
};

const ASPECT_MAP_IMAGE = {
  '1:1':  'IMAGE_ASPECT_RATIO_SQUARE',
  '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
  '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
  '4:3':  'IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE',
  '3:4':  'IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR',
};

const ASPECT_MAP_VIDEO = {
  '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
  '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
  '1:1':  'VIDEO_ASPECT_RATIO_SQUARE',
};

// ─── HELPERS ───────────────────────────────────────────────────────────────

async function createProject(title, token, sessionCookie) {
  const res = await fetch(`https://labs.google/fx/api/trpc/project.createProject`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Secure-next-auth.session-token=${sessionCookie}`,
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/fx/tools/flow',
    },
    body: JSON.stringify({
      json: { projectTitle: title || `API Project ${new Date().toLocaleString()}`, toolName: 'PINHOLE' }
    }),
  });
  if (!res.ok) throw new Error(`Project creation failed ${res.status}`);
  const data = await res.json();
  return data.result?.data?.json?.result?.projectId;
}

async function generateImage(prompt, model, ratio, count, token, projectId, recaptchaToken) {
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
    requests: Array.from({ length: Math.min(Math.max(count || 1, 1), 4) }, () => ({
      clientContext: clientCtx,
      imageModelName: MODELS_IMAGE[model] || MODELS_IMAGE['imagen4'],
      imageAspectRatio: ASPECT_MAP_IMAGE[ratio] || ASPECT_MAP_IMAGE['1:1'],
      structuredPrompt: { parts: [{ text: prompt }] },
      seed: Math.floor(Math.random() * 2147483647),
    })),
  };

  const res = await fetch(`${ENDPOINT_BASE}/projects/${projectId}/flowMedia:batchGenerateImages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/fx/tools/flow',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`[API Error Response]:`, text);
    let errorMessage = text;
  ... (rest of logic) ...

      const errorJson = JSON.parse(text);
      if (errorJson.error?.details?.[0]?.reason === 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED') {
        errorMessage = 'Safety Filter: Prominent people (like celebrities or politicians) are blocked by Google for this model/ratio.';
      } else if (errorJson.error?.message) {
        errorMessage = errorJson.error.message;
      }
    } catch {}
    throw new Error(errorMessage);
  }
  return JSON.parse(text);
}

async function startVideoGeneration(prompt, model, ratio, token, projectId, recaptchaToken) {
  const batchId = randomUUID();
  const sessionId = ';' + Date.now();
  
  const modelInfo = MODELS_VIDEO[model] || MODELS_VIDEO['veo'];

  const payload = {
    mediaGenerationContext: { batchId },
    clientContext: {
      projectId,
      tool: 'PINHOLE',
      userPaygateTier: 'PAYGATE_TIER_ONE',
      sessionId,
      recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
    },
    requests: [{
      aspectRatio: ASPECT_MAP_VIDEO[ratio] || ASPECT_MAP_VIDEO['16:9'],
      seed: Math.floor(Math.random() * 2147483647),
      textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
      videoModelKey: modelInfo.key,
      metadata: {},
    }],
    useV2ModelConfig: true,
  };

  const res = await fetch(`${ENDPOINT_BASE}/${modelInfo.endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Origin': 'https://labs.google',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`API Error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.media?.[0]?.name;
}

// ─── ENDPOINTS ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /generate:
 *   post:
 *     summary: Generate Image
 *     description: Generate one or more images using Imagen or Nano Banana models.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [prompt]
 *             properties:
 *               prompt:
 *                 type: string
 *                 description: Text description of the image.
 *               model:
 *                 type: string
 *                 enum: [imagen4, banana, banana2, banana-pro]
 *                 default: imagen4
 *               ratio:
 *                 type: string
 *                 enum: ["1:1", "16:9", "9:16", "4:3", "3:4"]
 *                 default: "1:1"
 *               count:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 4
 *                 default: 1
 *               projectId:
 *                 type: string
 *                 description: Optional Google Flow project ID. If empty, a new project is automatically created.
 *     responses:
 *       200:
 *         description: Success
 */
app.post('/generate', async (req, res, next) => {
  let { prompt, model = 'imagen4', ratio = '1:1', count = 1, projectId } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  try {
    const token = await ensureToken();
    const tokenData = await readToken() || {};
    if (!projectId) {
      const sessionCookie = await ensureSessionCookie();
      projectId = tokenData?.projectId || await createProject(`Auto Image Project`, token, sessionCookie);
      if (!tokenData.projectId) saveToken({ ...tokenData, projectId });
    }

    const recaptchaToken = await getRecaptchaToken('IMAGE_GENERATION');
    const data = await generateImage(prompt, model, ratio, count, token, projectId, recaptchaToken);

    const images = (data.media || []).map(item => {
      const g = item.image?.generatedImage;
      return g?.encodedImage ? { base64: g.encodedImage } : { url: g?.fifeUrl };
    });

    res.json({ success: true, projectId, images });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /generate-video:
 *   post:
 *     summary: Generate Video
 *     description: Start video generation.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [prompt]
 *             properties:
 *               prompt:
 *                 type: string
 *               model:
 *                 type: string
 *                 enum: [veo, veo-r2v]
 *                 default: veo
 *               ratio:
 *                 type: string
 *                 enum: ["16:9", "9:16", "1:1"]
 *                 default: "16:9"
 *               projectId:
 *                 type: string
 *                 description: Optional. Auto-generated if not provided.
 *     responses:
 *       200:
 *         description: Success. Returns mediaId to poll status.
 */
app.post('/generate-video', async (req, res, next) => {
  let { prompt, model = 'veo', ratio = '16:9', projectId } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  try {
    const token = await ensureToken();
    const tokenData = await readToken() || {};
    if (!projectId) {
      const sessionCookie = await ensureSessionCookie();
      projectId = tokenData?.projectId || await createProject(`Auto Video Project`, token, sessionCookie);
      if (!tokenData.projectId) saveToken({ ...tokenData, projectId });
    }

    const recaptchaToken = await getRecaptchaToken('VIDEO_GENERATION');
    const videoMediaId = await startVideoGeneration(prompt, model, ratio, token, projectId, recaptchaToken);
    res.json({ success: true, projectId, mediaId: videoMediaId });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /video-status/{mediaId}:
 *   get:
 *     summary: Check Video Status
 *     parameters:
 *       - in: path
 *         name: mediaId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Current status and download URL if successful.
 */
app.get('/video-status/:mediaId', async (req, res, next) => {
  const { mediaId } = req.params;
  try {
    const token = await ensureToken();
    const projectId = resolveProjectId();
    const resStatus = await fetch(`${ENDPOINT_BASE}/video:batchCheckAsyncVideoGenerationStatus`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Origin': 'https://labs.google' },
      body: JSON.stringify({ media: [{ name: mediaId, projectId }] }),
    });
    const data = await resStatus.json();
    const status = data.media?.[0]?.mediaMetadata?.mediaStatus?.mediaGenerationStatus;
    const downloadUrl = status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' ? `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${encodeURIComponent(mediaId)}` : null;
    res.json({ success: true, status, downloadUrl });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /auth-status:
 *   get:
 *     summary: Check Connection Status
 *     responses:
 *       200:
 *         description: Whether the CLI is connected to Google.
 */
app.get('/auth-status', async (req, res, next) => {
  try {
    const sessionCookie = await ensureSessionCookie();
    const tokenData = await readToken() || {};
    res.json({ connected: !!(sessionCookie), projectId: tokenData?.projectId });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /create-project:
 *   post:
 *     summary: Create New Project
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *     responses:
 *       200:
 *         description: Returns new projectId.
 */
app.post('/create-project', async (req, res, next) => {
  const { title } = req.body;
  try {
    const token = await ensureToken();
    const sessionCookie = await ensureSessionCookie();
    const projectId = await createProject(title, token, sessionCookie);
    res.json({ success: true, projectId });
  } catch (error) {
    next(error);
  }
});

app.get('/', (req, res) => res.redirect('/api-docs'));

// Global error handler
app.use((err, req, res, next) => {
  console.error('[App Error]:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

process.on('SIGINT', async () => { await cleanup(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`🚀 API v2.5 (Advanced) running at http://localhost:${PORT}\nSwagger: http://localhost:${PORT}/api-docs`);
});