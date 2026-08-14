#!/usr/bin/env node
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

// Import auth & helpers
import {
  ensureToken,
  getRecaptchaToken,
  startServer,
  cleanup,
  readToken,
  saveToken,
  ensureSessionCookie,
  resolveProjectId
} from './scripts/lib/auth.mjs';

// Import generation logic
import {
  generate as generateImage,
  uploadReferenceImage,
  detectImageExtension
} from './scripts/generate.mjs';

import {
  generateVideo,
  pollVideoStatus,
  downloadVideo
} from './scripts/generate-video.mjs';

const rl = readline.createInterface({ input, output });

const OUTPUT_DIR = './outputs';

// Helper to ask a question with a default value
async function askWithDefault(questionText, defaultValue) {
  const answer = await rl.question(`${questionText} [${defaultValue}]: `);
  return answer.trim() || defaultValue;
}

// Helper to print a separator
function printSeparator() {
  console.log('\n==================================================');
}

// Show colorful banner
function showBanner() {
  console.clear();
  console.log('  \x1b[36m██████╗  ██████╗  ██████╗  ██████╗ ██╗     ███████╗\x1b[0m');
  console.log('  \x1b[36m██╔════╝ ██╔═══██╗██╔═══██╗██╔════╝ ██║     ██╔════╝\x1b[0m');
  console.log('  \x1b[36m██║  ███╗██║   ██║██║   ██║██║  ███╗██║     █████╗  \x1b[0m');
  console.log('  \x1b[36m██║   ██║██║   ██║██║   ██║██║   ██║██║     ██╔══╝  \x1b[0m');
  console.log('  \x1b[36m╚██████╔╝╚██████╔╝╚██████╔╝╚██████╔╝███████╗███████╗\x1b[0m');
  console.log('   \x1b[36m╚═════╝  ╚═════╝  ╚═════╝  ╚═════╝ ╚══════╝╚══════╝\x1b[0m');
  console.log('             \x1b[35mGoogle Labs Flow - CLI Tool v1.0\x1b[0m');
  console.log('             ---------------------------------');
}

// Main Interactive CLI Loop
async function mainLoop() {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  while (true) {
    showBanner();
    console.log('\nSelect an option to proceed:');
    console.log('  1. 🎨 Generate Image');
    console.log('  2. 🎥 Generate Video (Text-to-Video)');
    console.log('  3. 🔄 Convert Image to Video (Image-to-Video)');
    console.log('  4. 🎬 Create Long Video from JSON');
    console.log('  5. 📁 Create a New Project');
    console.log('  6. 📶 Check Connection & Auth Status');
    console.log('  7. 🔑 Login / Authenticate Google Account');
    console.log('  8. 🚪 Exit');
    
    const choice = (await rl.question('\nEnter option number (1-8): ')).trim();

    try {
      if (choice === '1') {
        await handleImageGeneration();
      } else if (choice === '2') {
        await handleVideoGeneration(false);
      } else if (choice === '3') {
        await handleVideoGeneration(true);
      } else if (choice === '4') {
        await handleLongVideoMaker();
      } else if (choice === '5') {
        await handleCreateProject();
      } else if (choice === '6') {
        await handleAuthStatus();
      } else if (choice === '7') {
        await handleLogin();
      } else if (choice === '8') {
        console.log('\nGoodbye! Have a creative day. 👋');
        break;
      } else {
        console.log('\n❌ Invalid option. Press Enter to try again.');
        await rl.question('');
      }
    } catch (error) {
      console.log(`\n❌ Error occurred: ${error.message}`);
      await cleanup();
      await rl.question('\nPress Enter to return to menu...');
    }
  }

  rl.close();
  await cleanup();
  process.exit(0);
}

// Action: Create Long Video from JSON
async function handleLongVideoMaker() {
  printSeparator();
  console.log('🎬 --- Create a Long Video from JSON Script ---');

  let jsonPath = await rl.question('\nEnter path to your JSON script file: ');
  jsonPath = jsonPath.trim().replace(/^["']|["']$/g, ''); // strip quotes
  if (!existsSync(jsonPath)) {
    console.log('❌ Error: JSON file does not exist.');
    await rl.question('\nPress Enter to return to menu...');
    return;
  }

  let scenes = [];
  try {
    const rawData = readFileSync(jsonPath, 'utf8');
    scenes = JSON.parse(rawData);
    if (!Array.isArray(scenes)) {
      throw new Error('JSON structure must be an array of scenes.');
    }
  } catch (e) {
    console.log(`\n❌ Error reading/parsing JSON: ${e.message}`);
    await rl.question('\nPress Enter to return to menu...');
    return;
  }

  console.log(`\n🎬 Loaded script with ${scenes.length} scenes.`);

  const tokenData = readToken() || {};
  const lastSavedProjectId = tokenData.projectId || '';
  const projectPrompt = lastSavedProjectId 
    ? `Enter Project ID (optional, press Enter to create new project, or type 'last' to use [${lastSavedProjectId}]): `
    : 'Enter Project ID (optional, press Enter to create a new project): ';
  
  let inputProjectId = (await rl.question(projectPrompt)).trim();
  if (inputProjectId.toLowerCase() === 'last') {
    inputProjectId = lastSavedProjectId;
  }

  console.log('\n⏳ Initializing API Server...');
  await startServer();

  console.log('⏳ Ensuring authentication...');
  const token = await ensureToken();
  const sessionCookie = await ensureSessionCookie();
  
  let projectId = inputProjectId;
  if (!projectId) {
    console.log('⏳ Creating a new project...');
    projectId = await createProject(`Long Movie Project`, token, tokenData.sessionCookie);
    console.log(`✅ New Project Created: ${projectId}`);
    saveToken({ ...tokenData, projectId });
  } else {
    saveToken({ ...tokenData, projectId });
  }

  const generatedClips = [];
  const ts = Date.now();

  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log(`\n--------------------------------------------------`);
      console.log(`🎬 Processing Scene ${i + 1}/${scenes.length}...`);
      
      let finalPrompt = scene.prompt || '';
      if (!finalPrompt.trim()) {
        console.log(`⚠️ Scene ${i + 1} has no prompt. Skipping.`);
        continue;
      }
      
      if (scene.camera_angle) finalPrompt += `, camera angle: ${scene.camera_angle}`;
      if (scene.lighting) finalPrompt += `, lighting: ${scene.lighting}`;
      if (scene.character_movement) finalPrompt += `, character movement: ${scene.character_movement}`;

      const model = scene.model || 'veo';
      const ratio = scene.ratio || '16:9';

      console.log(`Prompt: "${finalPrompt}"`);
      console.log(`Model: ${model} | Ratio: ${ratio}`);

      console.log('⏳ Solving reCAPTCHA challenge...');
      const recaptchaToken = await getRecaptchaToken('VIDEO_GENERATION');

      console.log(`🚀 Submitting scene request to Project [${projectId}]...`);
      const mediaId = await generateVideo(finalPrompt, model, ratio, undefined, token, projectId, recaptchaToken);
      console.log(`✅ Scene request submitted! Media ID: ${mediaId}`);
      console.log('⏳ Waiting for scene video clip to generate...');

      await pollVideoStatus(mediaId, projectId, token);

      console.log('📥 Downloading scene video clip...');
      const clipFilepath = await downloadVideo(mediaId, sessionCookie, OUTPUT_DIR, `${ts}_scene_${i}`);
      console.log(`💾 Saved scene clip: ${clipFilepath}`);
      
      generatedClips.push(clipFilepath);
    }

    if (generatedClips.length === 0) {
      throw new Error('No scenes were successfully generated.');
    }

    console.log(`\n--------------------------------------------------`);
    console.log('🎬 All scenes generated successfully! Merging into a single long movie...');

    // Create the concat list file for FFmpeg
    const listFilepath = join(OUTPUT_DIR, `concat_list_${ts}.txt`);
    // Format paths correctly for FFmpeg concat using absolute paths and forward slashes
    const listContent = generatedClips
      .map(clip => `file '${resolve(clip).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    writeFileSync(listFilepath, listContent, 'utf8');

    const finalMoviePath = join(OUTPUT_DIR, `movie_${ts}.mp4`);
    console.log(`⏳ Merging clips using FFmpeg...`);
    
    // Concat files using ffmpeg copy mode (extremely fast & lossless)
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFilepath}" -c copy "${finalMoviePath}"`, { stdio: 'inherit' });

    console.log(`\n✅ Movie merged successfully!`);
    console.log(`💾 Final Movie Location: ${finalMoviePath}`);

    // Clean up the temporary list file
    try {
      unlinkSync(listFilepath);
    } catch {}

  } catch (error) {
    console.log(`\n❌ Error during Movie generation/merge: ${error.message}`);
  }

  await cleanup();
  await rl.question('\nPress Enter to return to menu...');
}

// Action: Login
async function handleLogin() {
  printSeparator();
  console.log('🔑 Starting Google authentication flow...');
  console.log('This will launch a browser window. Please log into Google Labs Flow on it.');
  console.log('Path to execute login: node scripts/login.mjs');
  
  try {
    execSync('node scripts/login.mjs', { stdio: 'inherit' });
    console.log('\n✅ Login finished successfully!');
  } catch (err) {
    console.log(`\n❌ Login failed: ${err.message}`);
  }
  await rl.question('\nPress Enter to return to menu...');
}

// Action: Check Status
async function handleAuthStatus() {
  printSeparator();
  console.log('📶 Checking Auth Connection Status...');
  const token = readToken();
  if (!token || !token.sessionCookie) {
    console.log('\n❌ Connection Status: Disconnected');
    console.log('Please run Option 5 to Login first.');
  } else {
    console.log('\n✅ Connection Status: Connected (Session Cookie found)');
    
    if (token.expiresAt) {
      const remaining = token.expiresAt - Date.now();
      if (remaining <= 0) {
        console.log('Access Token Status: Expired (Will auto-refresh during next task)');
      } else {
        console.log(`Access Token Status: Active (Expires in ${Math.floor(remaining / 60000)} minutes)`);
      }
    }
    
    if (token.projectId) {
      console.log(`Project ID: ${token.projectId}`);
    } else {
      console.log('Project ID: Not initialized yet (Will create on next run)');
    }
  }
  await rl.question('\nPress Enter to return to menu...');
}

// Action: Create New Project
async function handleCreateProject() {
  printSeparator();
  console.log('📁 --- Create a New Google Labs Flow Project ---');

  const title = await askWithDefault('Enter Project Title', `CLI Project ${new Date().toLocaleDateString()}`);

  console.log('\n⏳ Initializing API Server...');
  await startServer();

  console.log('⏳ Ensuring authentication...');
  const token = await ensureToken();
  const tokenData = readToken() || {};

  console.log('⏳ Registering new project on Google Flow...');
  const newPid = await createProject(title, token, tokenData.sessionCookie);

  if (newPid && newPid !== 'a5dbda4c-d615-4f5c-8cd3-c9462fb1ef39') {
    console.log(`\n✅ Project Created Successfully!`);
    console.log(`🆔 Project ID: ${newPid}`);
    saveToken({ ...tokenData, projectId: newPid });
    console.log(`Saved as active project.`);
  } else {
    console.log(`\n❌ Failed to create project or fell back to default.`);
    console.log(`Current Project ID: ${tokenData.projectId || 'None'}`);
  }

  await cleanup();
  await rl.question('\nPress Enter to return to menu...');
}

// Action: Generate Image
async function handleImageGeneration() {
  printSeparator();
  console.log('🎨 --- Flow Image Generator ---');
  
  const prompt = await rl.question('\nEnter prompt (English): ');
  if (!prompt.trim()) {
    console.log('❌ Prompt cannot be empty.');
    await rl.question('\nPress Enter to return to menu...');
    return;
  }

  const model = await askWithDefault('Select Model (banana-pro, banana2, imagen4)', 'banana-pro');
  const ratio = await askWithDefault('Aspect Ratio (1:1, 16:9, 9:16, 4:3, 3:4)', '1:1');
  const countStr = await askWithDefault('Number of images (1-4)', '1');
  const count = Math.min(Math.max(parseInt(countStr) || 1, 1), 4);
  const useSeed = await rl.question('Enter custom seed (optional, press Enter for random): ');
  const seed = useSeed.trim() ? parseInt(useSeed) : undefined;

  const tokenData = readToken() || {};
  const lastSavedProjectId = tokenData.projectId || '';
  const projectPrompt = lastSavedProjectId 
    ? `Enter Project ID (optional, press Enter to create new project, or type 'last' to use [${lastSavedProjectId}]): `
    : 'Enter Project ID (optional, press Enter to create a new project): ';
  
  let inputProjectId = (await rl.question(projectPrompt)).trim();
  if (inputProjectId.toLowerCase() === 'last') {
    inputProjectId = lastSavedProjectId;
  }

  console.log('\n⏳ Initializing API Server...');
  await startServer();

  console.log('⏳ Ensuring authentication...');
  const token = await ensureToken();
  
  let projectId = inputProjectId;
  if (!projectId) {
    console.log('⏳ Creating a new project...');
    projectId = await createProject(`CLI Image Project`, token, tokenData.sessionCookie);
    console.log(`✅ New Project Created: ${projectId}`);
    saveToken({ ...tokenData, projectId });
  } else {
    saveToken({ ...tokenData, projectId });
  }

  console.log('⏳ Solving reCAPTCHA challenge...');
  const recaptchaToken = await getRecaptchaToken('IMAGE_GENERATION');

  console.log(`🚀 Sending generation request to Project [${projectId}]: "${prompt}"...`);
  const images = await generateImage(prompt, model, ratio, count, seed, token, projectId, recaptchaToken);

  console.log(`\n📥 Downloading ${images.length} generated image(s)...`);
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

    const filepath = join(OUTPUT_DIR, `flow_image_${ts}_${i}.${ext}`);
    writeFileSync(filepath, buf);
    console.log(`💾 Saved: ${filepath}`);
  }

  console.log('\n✅ All images generated and downloaded successfully!');
  await cleanup();
  await rl.question('\nPress Enter to return to menu...');
}

// Action: Generate Video / Image-to-Video
async function handleVideoGeneration(isImageToVideo) {
  printSeparator();
  console.log(isImageToVideo ? '🔄 --- Flow Image-to-Video Converter ---' : '🎥 --- Flow Text-to-Video Generator ---');

  let imagePath = '';
  if (isImageToVideo) {
    imagePath = await rl.question('\nEnter local path of reference image: ');
    imagePath = imagePath.trim().replace(/^["']|["']$/g, ''); // strip quotes
    if (!existsSync(imagePath)) {
      console.log('❌ Error: Image file does not exist at this path.');
      await rl.question('\nPress Enter to return to menu...');
      return;
    }
  }

  const prompt = await rl.question('\nEnter video prompt (Describe the motion): ');
  if (!prompt.trim()) {
    console.log('❌ Prompt cannot be empty.');
    await rl.question('\nPress Enter to return to menu...');
    return;
  }

  const model = isImageToVideo ? 'veo-r2v' : 'veo';
  const ratio = await askWithDefault('Aspect Ratio (16:9, 9:16, 1:1)', '16:9');
  
  const useSeed = await rl.question('Enter custom seed (optional, press Enter for random): ');
  const seed = useSeed.trim() ? parseInt(useSeed) : undefined;

  const tokenData = readToken() || {};
  const lastSavedProjectId = tokenData.projectId || '';
  const projectPrompt = lastSavedProjectId 
    ? `Enter Project ID (optional, press Enter to create new project, or type 'last' to use [${lastSavedProjectId}]): `
    : 'Enter Project ID (optional, press Enter to create a new project): ';
  
  let inputProjectId = (await rl.question(projectPrompt)).trim();
  if (inputProjectId.toLowerCase() === 'last') {
    inputProjectId = lastSavedProjectId;
  }

  console.log('\n⏳ Initializing API Server...');
  await startServer();

  console.log('⏳ Ensuring authentication...');
  const token = await ensureToken();
  const sessionCookie = await ensureSessionCookie();
  
  let projectId = inputProjectId;
  if (!projectId) {
    console.log('⏳ Creating a new project...');
    projectId = await createProject(`CLI Video Project`, token, tokenData.sessionCookie);
    console.log(`✅ New Project Created: ${projectId}`);
    saveToken({ ...tokenData, projectId });
  } else {
    saveToken({ ...tokenData, projectId });
  }

  console.log('⏳ Solving reCAPTCHA challenge...');
  const recaptchaToken = await getRecaptchaToken('VIDEO_GENERATION');

  let referenceMediaId = null;
  if (isImageToVideo) {
    console.log(`⏳ Uploading reference image: ${imagePath}...`);
    referenceMediaId = await uploadReferenceImage(imagePath, token, projectId);
    console.log(`✅ Uploaded reference image (Media ID: ${referenceMediaId})`);
  }

  console.log(`🚀 Submitting video generation request to Project [${projectId}]...`);
  const mediaId = await generateVideo(prompt, model, ratio, seed, token, projectId, recaptchaToken, referenceMediaId);
  console.log(`✅ Video request submitted! Media ID: ${mediaId}`);
  console.log('⏳ Waiting for video to generate (usually takes 1-3 minutes)...');

  await pollVideoStatus(mediaId, projectId, token);

  console.log('📥 Downloading video...');
  const ts = Date.now();
  const finalFilepath = await downloadVideo(mediaId, sessionCookie, OUTPUT_DIR, ts);

  console.log(`\n💾 Saved video successfully to: ${finalFilepath}`);
  await cleanup();
  await rl.question('\nPress Enter to return to menu...');
}

// Mock project creation in case api session token allows it
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
        json: { projectTitle: title, toolName: 'PINHOLE' }
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

mainLoop().catch(err => {
  console.error('Fatal Error:', err);
  cleanup();
  process.exit(1);
});
