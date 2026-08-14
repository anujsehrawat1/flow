import express from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import {
  ensureToken,
  getRecaptchaToken,
  resolveProjectId,
  cleanup,
  readToken,
  saveToken,
  ensureSessionCookie
} from './scripts/lib/auth.mjs';
import { generateVideo, pollVideoStatus, downloadVideo } from './scripts/generate-video.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express({ limit: '50mb' });
const PORT = process.env.PORT || 7860;

console.log('[Startup] --- Starting Flow Proxy Server ---');
console.log('[Startup] Environment:', process.env.SPACE_ID ? 'Hugging Face' : 'Local');
console.log('[Startup] Port Target:', PORT);

app.use(express.json({ limit: '50mb' }));

// ─── SWAGGER SETUP ─────────────────────────────────────────────────────────

const getBaseUrl = () => {
  if (process.env.SPACE_ID) {
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
console.log('[Startup] Swagger UI initialized');

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
  try {
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
    if (res.ok) {
      const data = await res.json();
      const pid = data.result?.data?.json?.result?.projectId;
      if (pid) return pid;
    }
  } catch {}
  return 'a5dbda4c-d615-4f5c-8cd3-c9462fb1ef39'; // Default fallback
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
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    let errorMessage = text;
    try {
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
app.post('/generate', async (req, res) => {
  let { prompt, model = 'banana-pro', ratio = '1:1', count = 1, projectId, recaptchaToken } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  try {
    const token = await ensureToken();
    const tokenData = await readToken();
    if (!projectId) {
      projectId = tokenData?.projectId || await createProject(`Auto Image Project`, token, tokenData.sessionCookie);
      if (!tokenData.projectId) saveToken({ ...tokenData, projectId });
    }

    console.log('[API /generate] Using Project ID:', projectId);
    console.log('[API /generate] Using Token:', token ? token.substring(0, 15) + '...' : 'none');
    console.log('[API /generate] Using Recaptcha:', recaptchaToken ? recaptchaToken.substring(0, 15) + '...' : 'none');

    const finalRecaptchaToken = recaptchaToken || await getRecaptchaToken('IMAGE_GENERATION');
    const data = await generateImage(prompt, model, ratio, count, token, projectId, finalRecaptchaToken);

    const images = (data.media || []).map(item => {
      const g = item.image?.generatedImage;
      return g?.encodedImage ? { base64: g.encodedImage } : { url: g?.fifeUrl };
    });

    res.json({ success: true, projectId, images });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
app.post('/generate-video', async (req, res) => {
  let { prompt, model = 'veo', ratio = '16:9', projectId, recaptchaToken } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  try {
    const token = await ensureToken();
    const tokenData = await readToken();
    if (!projectId) {
      projectId = tokenData?.projectId || await createProject(`Auto Video Project`, token, tokenData.sessionCookie);
      if (!tokenData.projectId) saveToken({ ...tokenData, projectId });
    }

    const finalRecaptchaToken = recaptchaToken || await getRecaptchaToken('VIDEO_GENERATION');
    const videoMediaId = await startVideoGeneration(prompt, model, ratio, token, projectId, finalRecaptchaToken);
    res.json({ success: true, projectId, mediaId: videoMediaId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
app.get('/video-status/:mediaId', async (req, res) => {
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
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /generate-long-video:
 *   post:
 *     summary: Create Long Video from JSON
 *     description: Generate multiple video scenes and concatenate them into a single movie.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [scenes]
 *             properties:
 *               scenes:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [prompt]
 *                   properties:
 *                     prompt: { type: string }
 *                     camera_angle: { type: string }
 *                     lighting: { type: string }
 *                     character_movement: { type: string }
 *                     ratio: { type: string }
 *                     model: { type: string }
 *               projectId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Merged movie file.
 */
app.post('/generate-long-video', async (req, res) => {
  const { scenes, projectId: reqProjectId } = req.body;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'Scenes array is required and cannot be empty' });
  }

  try {
    const token = await ensureToken();
    const sessionCookie = await ensureSessionCookie();
    const tokenData = await readToken();
    let projectId = reqProjectId || tokenData?.projectId || await createProject(`API Movie Project`, token, tokenData.sessionCookie);

    const generatedClips = [];
    const ts = Date.now();
    const tempDir = join(__dirname, 'outputs');

    // Create outputs directory if not exists
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      let finalPrompt = scene.prompt || '';
      if (!finalPrompt.trim()) continue;

      if (scene.camera_angle) finalPrompt += `, camera angle: ${scene.camera_angle}`;
      if (scene.lighting) finalPrompt += `, lighting: ${scene.lighting}`;
      if (scene.character_movement) finalPrompt += `, character movement: ${scene.character_movement}`;

      const model = scene.model || 'veo';
      const ratio = scene.ratio || '16:9';

      const recaptchaToken = await getRecaptchaToken('VIDEO_GENERATION');
      const mediaId = await generateVideo(finalPrompt, model, ratio, undefined, token, projectId, recaptchaToken);

      await pollVideoStatus(mediaId, projectId, token);
      const clipFilepath = await downloadVideo(mediaId, sessionCookie, tempDir, `${ts}_scene_${i}`);
      generatedClips.push(clipFilepath);
    }

    if (generatedClips.length === 0) {
      throw new Error('No scenes were successfully generated.');
    }

    const listFilepath = join(tempDir, `concat_list_${ts}.txt`);
    const listContent = generatedClips
      .map(clip => `file '${resolve(clip).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    writeFileSync(listFilepath, listContent, 'utf8');

    const finalMoviePath = join(tempDir, `movie_${ts}.mp4`);
    
    // Concat files using ffmpeg copy mode
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFilepath}" -c copy "${finalMoviePath}"`, { stdio: 'inherit' });

    // Clean up temporary list file and clips
    try { unlinkSync(listFilepath); } catch {}
    for (const clip of generatedClips) {
      try { unlinkSync(clip); } catch {}
    }

    // Send final movie file to the client
    res.sendFile(resolve(finalMoviePath), (err) => {
      // Clean up final movie file after sending
      try { unlinkSync(finalMoviePath); } catch {}
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
app.get('/auth-status', async (req, res) => {
  const tokenData = await readToken();
  res.json({ connected: !!(tokenData?.sessionCookie), projectId: tokenData?.projectId });
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
app.post('/create-project', async (req, res) => {
  const { title } = req.body;
  try {
    const token = await ensureToken();
    const tokenData = await readToken();
    const projectId = await createProject(title, token, tokenData.sessionCookie);
    res.json({ success: true, projectId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.status(200).send('Google Labs Flow Proxy Server is Running!'));

process.on('SIGINT', async () => { await cleanup(); process.exit(0); });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Startup] 🚀 API v2.5 (Advanced) running at 0.0.0.0:${PORT}`);
  console.log(`[Startup] Swagger: ${getBaseUrl()}/api-docs`);
});
