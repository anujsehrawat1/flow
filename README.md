<!--
---
title: Google Labs Flow Proxy
emoji: 🚀
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
---
-->
# Google Labs Flow CLI & API Proxy

An automated creative suite, terminal tool, and proxy server for **Google Labs Flow** (incorporating Google Veo 3.1 and Imagen models). Generate high-quality images, text-to-video, image-to-video, and combine multiple scenes into a long movie directly from your command line or via hosted API endpoints.

---

## 🚀 Key Features

*   **🎨 Image Generator:** Generate images using modern models (`banana-pro` (default), `banana2`, `imagen4`) across multiple aspect ratios (`1:1`, `16:9`, `9:16`, `4:3`, `3:4`).
*   **🎥 Text-to-Video:** Start Google Veo 3.1 generation using descriptive text prompts.
*   **🔄 Image-to-Video:** Animate static images using them as reference frames for video motion.
*   **🎬 Long Movie Maker:** Parse a JSON file containing sequence scene parameters (camera angle, lighting, character movement), generate clips, and merge them sequentially into a single high-quality `.mp4` movie.
*   **🔑 Automated Auth & reCAPTCHA:** Utilizes Playwright to login and dynamically solve Google's background reCAPTCHA Enterprise v3 tokens without user interaction.
*   **☁️ Headless Cloud Support:** Built-in Docker compatibility allows headless execution on platforms like Hugging Face Spaces.

---

## 🛠️ Prerequisites

1.  **Node.js:** v18 or later.
2.  **Google Chrome / Chromium:** Playwright will automatically initialize this.
3.  **FFmpeg:** Required for merging video clips (Long Movie Maker).
    *   *Windows:* Download from gyan.dev and add to PATH.
    *   *Linux/Ubuntu:* `sudo apt install ffmpeg`

---

## 📥 Installation

Clone this repository and install the dependencies:

```bash
git clone https://github.com/anujsehrawat1/flow.git
cd flow
npm install
npx playwright install chromium
```

---

## 💻 Local CLI Execution (Terminal Tool)

To run the interactive, color-coded terminal interface:

```bash
npm run cli
```

### CLI Menu Options:
1.  **🎨 Generate Image:** Prompts you for prompt, model selection, aspect ratio, image count, and custom seed. Saves to `outputs/`.
2.  **🎥 Generate Video:** Start Text-to-Video generation using Veo.
3.  **🔄 Convert Image to Video:** Provide local reference image path and motion prompt to animate it.
4.  **🎬 Create Long Video from JSON:** Provide path to a JSON script. The CLI generates clips sequentially and merges them using FFmpeg.
5.  **📁 Create a New Project:** Registers a new project workspace on Google Flow.
6.  **📶 Check Connection & Auth Status:** Verify if your session is active.
7.  **🔑 Login:** Launches a visible Chromium window. Simply sign in to your Google Account on the Google Labs page, and it will capture and save your session cookie securely to `.auth-data/`.
8.  **🚪 Exit.**

---

## 🎬 Long Video JSON Script Format

For the **Long Video Maker (Option 4)**, provide a path to a JSON file structured as follows (see `sample_movie.json` template):

```json
[
  {
    "prompt": "A beautiful cinematic shot of a sunset over futuristic cyberpunk mountains",
    "camera_angle": "slow panning shot, wide-angle lens",
    "lighting": "golden hour, deep orange glowing horizon",
    "character_movement": null,
    "ratio": "16:9",
    "model": "veo"
  },
  {
    "prompt": "A glowing holographic cyber-bird flying through the futuristic mountains",
    "camera_angle": "dynamic tracking shot",
    "lighting": "neon cyan bioluminescent wings",
    "character_movement": "wings flapping gracefully, soaring through the sky",
    "ratio": "16:9",
    "model": "veo"
  }
]
```

---

## 🌐 Running the API Proxy Server

You can run this project as a web service to expose HTTP endpoints:

### Run Locally:
```bash
node server.mjs
```
Open **`http://localhost:7860/api-docs`** in your browser to interact with the API endpoints using the Swagger UI documentation.

---

## 🐳 Cloud Deployment & Docker

This project is fully containerized and pre-configured for cloud hosting.

### 1. Hugging Face Spaces (Recommended 🚀)
The project is optimized to run as a **Docker Space** on Hugging Face:
1.  Create a new Space on Hugging Face.
2.  Set the SDK to **Docker** and choose the **Blank** template.
3.  Set the hardware to **CPU Basic (Free)** (ZeroGPU is not supported for Docker SDKs).
4.  Push your code to the Space. 
5.  The included `Dockerfile` will automatically set up Playwright in **Headless mode** (no XVFB required!).
6.  Once built, your API will be live at `https://your-username-space-name.hf.space/api-docs`.

### 2. Render
1.  Deploy your repository on Render as a **Web Service** (not a Static Site).
2.  Set Environment Type to **Docker** (it will read the `Dockerfile`).
3.  Set start command to `node server.mjs`.

### 3. Vercel
Deploying on Vercel is **NOT** recommended. Vercel runs serverless functions which do not support launching full Playwright Chromium browsers and will fail due to execution timeout limits (1-3 minutes required for video polling).

---

## 🔒 Security & Auth Sessions (Important!)

To protect your Google Account:
*   **NEVER commit or push the `.auth-data/` directory to public repositories.** It contains your active Google session cookies (`token.json` and `browser_state.json`).
*   `.auth-data/` is already added to `.gitignore`.
*   **For Private Deployments (e.g. Private Hugging Face Spaces):** You can manually drag and upload the `.auth-data/` folder via the Hugging Face Space "Files" tab in your browser. This keeps the session private to you while allowing the hosted API server to verify connection status.

---

## 📡 API Endpoints Reference

### `POST /generate` (Image Generation)
```bash
curl -X POST https://your-domain.com/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a cyberpunk cat",
    "model": "banana-pro",
    "ratio": "1:1",
    "count": 1
  }'
```

### `POST /generate-video` (Start Video Generation)
```bash
curl -X POST https://your-domain.com/generate-video \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "cat running in rain",
    "ratio": "16:9"
  }'
```
Returns a `mediaId` (e.g. `veo_3_1_t2v_fast_...`).

### `GET /video-status/:mediaId` (Check Video Progress)
```bash
curl https://your-domain.com/video-status/veo_3_1_t2v_fast_xyz
```
Returns status and a `downloadUrl` once completed.

### `POST /generate-long-video` (Movie Concatenation)
Exposes the movie compiler. Send a list of scenes and it will return the complete merged `.mp4` file directly:
```bash
curl -X POST https://your-domain.com/generate-long-video \
  -H "Content-Type: application/json" \
  -d '{"scenes": [{"prompt": "scene 1"}, {"prompt": "scene 2"}]}' \
  --output movie.mp4
```

### `GET /auth-status` (Check Session Connection)
Returns `{"connected": true}` if the token is valid.
