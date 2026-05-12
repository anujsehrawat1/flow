import express from 'express';
import swaggerUi from 'swagger-ui-express';

console.log('[Startup] --- Starting Flow Proxy Server ---');
console.log('[Startup] Environment:', process.env.SPACE_ID ? 'Hugging Face' : 'Local');
const PORT = process.env.PORT || 3000;
console.log('[Startup] Port Target:', PORT);

import swaggerJsdoc from 'swagger-jsdoc';
console.log('[Startup] Swagger Jsdoc imported');

import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

console.log('[Startup] Loading Auth Module...');
import {
  ensureToken,
  getRecaptchaToken,
  resolveProjectId,
  cleanup,
  readToken,
  saveToken,
  ensureSessionCookie
} from './scripts/lib/auth.mjs';
console.log('[Startup] Auth Module Loaded');

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express({ limit: '50mb' }); 
app.use(express.json({ limit: '50mb' }));

console.log('[Startup] Setting up Swagger...');
// Dynamic server URL for Swagger (Hugging Face support)
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

// ... (rest of configuration) ...

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Startup] 🚀 API v2.5 running at 0.0.0.0:${PORT}`);
  console.log(`[Startup] Swagger: ${getBaseUrl()}/api-docs`);
});

// ... (rest of endpoints) ...

