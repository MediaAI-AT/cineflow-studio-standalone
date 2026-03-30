import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT = __dirname; // everything lives next to server.js

// ── Node version check ──
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`CineFlow requires Node.js 18+. You are running ${process.version}.`);
  process.exit(1);
}

// ── Read .env file ──
function readEnvFile() {
  const envPath = path.join(ROOT, '.env');
  const result = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      result[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch {}
  return result;
}

// ── HTTPS POST / GET helper ──
function apiRequest(url, bodyObj, extraHeaders = {}, method = null) {
  return new Promise((resolve, reject) => {
    const useMethod = method || (bodyObj === null ? 'GET' : 'POST');
    const bodyStr = bodyObj !== null ? JSON.stringify(bodyObj) : null;
    const parsed = new URL(url);
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method: useMethod,
      headers,
      maxHeaderSize: 32768,
    }, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Request timed out')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Download file (follows redirects, supports http + https) ──
function downloadFile(url, destPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
    const protocol = url.startsWith('http://') ? http : https;
    const file = fs.createWriteStream(destPath);
    protocol.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlink(destPath, () => {});
        downloadFile(res.headers.location, destPath, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        file.close(); fs.unlink(destPath, () => {});
        reject(new Error(`HTTP ${res.statusCode}`)); return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
  });
}

// ── Pipeline state ──
let pipelineState = null;

// ── WebSocket broadcast ──
let wss = null;
function broadcast(data) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ============================================================
// PIPELINE FUNCTIONS
// ============================================================

async function cineflowAnalyze(slug, description, scenes, lang, refs, audioFile) {
  const { GEMINI_API_KEY } = readEnvFile();
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in .env');

  const parts = [];
  parts.push({ text: `You are an expert cinematographer and music video director.
Your task: analyze the provided audio and reference photos, then generate a detailed scene breakdown for a music video.

Description: ${description}
Number of scenes to generate: ${scenes}
Output language: ${lang === 'DE' ? 'German' : 'English'}

Analyze:
1. Audio tempo, mood, energy, key moments, BPM changes
2. Reference photos: character appearance, costume details, physical features for consistency

Generate exactly ${scenes} scenes in this YAML format:
---
scenes:
  - title: "Scene Title"
    description: "Brief scene description"
    S: "Setting/environment description"
    E: "Emotion/mood"
    A: "Action happening"
    L: "Lighting description"
    Ca: "Camera angle and movement"
    M: "Musical moment this syncs to"
    image_prompt: "Detailed safe image prompt - epic lighting, dramatic poses, no violence or blood"
    video_prompt: "Detailed video motion prompt"

Output ONLY the YAML block, nothing else.` });

  if (audioFile) {
    const p = path.join(ROOT, 'input', 'audio', audioFile);
    if (fs.existsSync(p)) {
      const ext = path.extname(audioFile).toLowerCase();
      parts.push({ inlineData: { mimeType: ext === '.wav' ? 'audio/wav' : 'audio/mpeg', data: fs.readFileSync(p).toString('base64') } });
    }
  }
  for (const ref of (refs || [])) {
    const p = path.join(ROOT, 'input', 'reference-images', ref);
    if (fs.existsSync(p)) {
      const ext = path.extname(ref).toLowerCase();
      parts.push({ inlineData: { mimeType: (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png', data: fs.readFileSync(p).toString('base64') } });
    }
  }

  const resp = await apiRequest(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${GEMINI_API_KEY}`,
    { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.7, maxOutputTokens: 8192 } }
  );
  const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini analyze returned no text: ' + JSON.stringify(resp).slice(0, 200));

  const projDir = path.join(ROOT, 'projects', slug);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'analysis.yaml'), text, 'utf8');
  return text;
}

async function cineflowGenerate(slug, lang) {
  const { GEMINI_API_KEY } = readEnvFile();
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in .env');

  const analysisYaml = fs.readFileSync(path.join(ROOT, 'projects', slug, 'analysis.yaml'), 'utf8');

  let text = (await apiRequest(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ role: 'user', parts: [{ text: `You are a professional music video producer.
Based on this scene analysis YAML, generate a complete production package as a single JSON object.

ANALYSIS:
${analysisYaml}

Generate a JSON object with this exact structure:
{
  "title": "Production title",
  "description": "Brief production description",
  "script": "Narrative script/voiceover text",
  "music_prompt": "Music generation prompt",
  "scenes": [
    { "id": 1, "title": "Scene title", "image_prompt": "Detailed safe image prompt - NO violence, blood, or gore.", "video_prompt": "Video motion description" }
  ]
}

Output language: ${lang === 'DE' ? 'German' : 'English'}
Output ONLY valid JSON, no markdown, no explanation.` }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: 8192, responseMimeType: 'application/json' }
    }
  ))?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  if (!text) throw new Error('Gemini generate returned no text');
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const production = JSON.parse(text);
  fs.writeFileSync(path.join(ROOT, 'projects', slug, 'production.json'), JSON.stringify(production, null, 2), 'utf8');
  return production;
}

async function cineflowImages(slug, refs) {
  const { GEMINI_API_KEY } = readEnvFile();
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in .env');

  const prodPath = path.join(ROOT, 'projects', slug, 'production.json');
  const production = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
  const scenes = production.scenes || [];
  const scenesDir = path.join(ROOT, 'projects', slug, 'scenes');
  fs.mkdirSync(scenesDir, { recursive: true });

  const refParts = [];
  for (const ref of (refs || [])) {
    const p = path.join(ROOT, 'input', 'reference-images', ref);
    if (fs.existsSync(p)) {
      const ext = path.extname(ref).toLowerCase();
      refParts.push({ inlineData: { mimeType: (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png', data: fs.readFileSync(p).toString('base64') } });
    }
  }

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const num = String(i + 1).padStart(2, '0');
    const outPath = path.join(scenesDir, `scene-${num}.png`);

    if (fs.existsSync(outPath)) {
      pipelineState.current = i + 1; pipelineState.total = scenes.length;
      broadcast({ type: 'pipeline:progress', ...pipelineState }); continue;
    }

    const parts = [...refParts, { text: scene.image_prompt || scene.title || `Scene ${i + 1}` }];
    let success = false;
    for (let attempt = 0; attempt < 10 && !success; attempt++) {
      try {
        const resp = await apiRequest(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_API_KEY}`,
          { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }
        );
        const imgPart = resp?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
        if (imgPart?.inlineData?.data) {
          fs.writeFileSync(outPath, Buffer.from(imgPart.inlineData.data, 'base64'));
          scenes[i].image_status = 'ok';
          fs.writeFileSync(prodPath, JSON.stringify(production, null, 2));
          success = true;
        } else {
          const r = resp?.candidates?.[0]?.finishReason;
          if (r === 'SAFETY' || r === 'RECITATION') parts[parts.length - 1] = { text: `${parts[parts.length - 1].text} Safe, cinematic, epic fantasy art style, no violence.` };
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch { await new Promise(r => setTimeout(r, 3000)); }
    }
    if (!success) { scenes[i].image_status = 'failed'; fs.writeFileSync(prodPath, JSON.stringify(production, null, 2)); }

    pipelineState.step = 'images'; pipelineState.current = i + 1; pipelineState.total = scenes.length;
    broadcast({ type: 'pipeline:progress', ...pipelineState });
  }
}

async function runPipeline(slug, description, scenes, lang, refs, audioFile) {
  try {
    pipelineState.step = 'analyze'; pipelineState.progress = 10;
    broadcast({ type: 'pipeline:progress', ...pipelineState });
    await cineflowAnalyze(slug, description, scenes, lang, refs, audioFile);

    pipelineState.step = 'generate'; pipelineState.progress = 35;
    broadcast({ type: 'pipeline:progress', ...pipelineState });
    const prod = await cineflowGenerate(slug, lang);

    pipelineState.step = 'images'; pipelineState.progress = 50;
    pipelineState.total = prod.scenes?.length || 0;
    broadcast({ type: 'pipeline:progress', ...pipelineState });
    await cineflowImages(slug, refs);

    pipelineState.status = 'done'; pipelineState.progress = 100;
    broadcast({ type: 'pipeline:progress', ...pipelineState });
  } catch (err) {
    pipelineState.status = 'error'; pipelineState.error = err.message;
    broadcast({ type: 'pipeline:progress', ...pipelineState });
  }
}

// ============================================================
// HTTP SERVER
// ============================================================

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml',
};

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Serve cineflow-studio UI ──
  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'cineflow-studio', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html); return;
  }

  // ── Media: projects (scenes, output) ──
  if (pathname.startsWith('/media/cineflow/')) {
    const rel = pathname.replace('/media/cineflow/', '');
    const parts = rel.split('/');
    const slug = parts[0]; const sub = parts.slice(1).join('/');
    if (!slug || slug.includes('..') || sub.includes('..')) { res.writeHead(400); res.end(); return; }
    const filePath = path.join(ROOT, 'projects', slug, sub);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    try {
      const stat = fs.statSync(filePath);
      const range = req.headers.range;
      if (range && mime === 'video/mp4') {
        const [s, e] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(s, 10);
        const end = e ? parseInt(e, 10) : stat.size - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch { res.writeHead(404); res.end('Not found'); }
    return;
  }

  // ── Media: input files (reference images preview) ──
  if (pathname.startsWith('/media/cineflow-input/')) {
    const rel = pathname.replace('/media/cineflow-input/', '');
    if (rel.includes('..')) { res.writeHead(400); res.end(); return; }
    const filePath = path.join(ROOT, 'input', rel);
    const ext = path.extname(filePath).toLowerCase();
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size });
      fs.createReadStream(filePath).pipe(res);
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  // ── API: projects list ──
  if (pathname === '/api/cineflow/projects' && req.method === 'GET') {
    try {
      const projDir = path.join(ROOT, 'projects');
      if (!fs.existsSync(projDir)) { sendJSON(res, []); return; }
      const slugs = fs.readdirSync(projDir).filter(d => fs.statSync(path.join(projDir, d)).isDirectory());
      const projects = slugs.map(slug => {
        const scenesDir = path.join(projDir, slug, 'scenes');
        const outputDir = path.join(projDir, slug, 'output');
        const prodPath = path.join(projDir, slug, 'production.json');
        let title = slug, sceneCount = 0, description = '';
        const images = fs.existsSync(scenesDir) ? fs.readdirSync(scenesDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f)).sort() : [];
        const videos = fs.existsSync(scenesDir) ? fs.readdirSync(scenesDir).filter(f => /\.mp4$/i.test(f)).sort() : [];
        const outputs = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).filter(f => /\.mp4$/i.test(f)).sort() : [];
        if (fs.existsSync(prodPath)) {
          try { const p = JSON.parse(fs.readFileSync(prodPath, 'utf8')); title = p.title || slug; description = p.description || ''; sceneCount = p.scenes?.length || 0; } catch {}
        }
        const stat = fs.statSync(path.join(projDir, slug));
        return { slug, title, description, sceneCount, imageCount: images.length, videoCount: videos.length, thumbnail: images[0] ? `/media/cineflow/${slug}/scenes/${images[0]}` : null, finalVideo: outputs[0] ? `/media/cineflow/${slug}/output/${outputs[0]}` : null, createdAt: stat.birthtimeMs || stat.mtimeMs };
      });
      sendJSON(res, projects.sort((a, b) => b.createdAt - a.createdAt));
    } catch (e) { sendJSON(res, { error: e.message }, 500); }
    return;
  }

  // ── API: project detail ──
  if (pathname.startsWith('/api/cineflow/project/') && !pathname.endsWith('/durations') && req.method === 'GET') {
    const slug = pathname.replace('/api/cineflow/project/', '').split('/')[0];
    if (!slug || slug.includes('..')) { sendJSON(res, { error: 'Invalid' }, 400); return; }
    const projDir = path.join(ROOT, 'projects', slug);
    if (!fs.existsSync(projDir)) { sendJSON(res, { error: 'Not found' }, 404); return; }
    try {
      const scenesDir = path.join(projDir, 'scenes');
      const outputDir = path.join(projDir, 'output');
      let production = null, durations = null;
      const prodPath = path.join(projDir, 'production.json');
      const durPath = path.join(projDir, 'scene-durations.json');
      if (fs.existsSync(prodPath)) { try { production = JSON.parse(fs.readFileSync(prodPath, 'utf8')); } catch {} }
      if (fs.existsSync(durPath)) { try { durations = JSON.parse(fs.readFileSync(durPath, 'utf8')); } catch {} }
      const images = fs.existsSync(scenesDir) ? fs.readdirSync(scenesDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f)).sort() : [];
      const videos = fs.existsSync(scenesDir) ? fs.readdirSync(scenesDir).filter(f => /\.mp4$/i.test(f)).sort() : [];
      const outputs = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).filter(f => /\.mp4$/i.test(f)).sort() : [];
      sendJSON(res, { slug, production, durations, images: images.map(f => `/media/cineflow/${slug}/scenes/${f}`), videos: videos.map(f => `/media/cineflow/${slug}/scenes/${f}`), outputs: outputs.map(f => `/media/cineflow/${slug}/output/${f}`) });
    } catch (e) { sendJSON(res, { error: e.message }, 500); }
    return;
  }

  // ── API: save durations ──
  if (pathname.startsWith('/api/cineflow/project/') && pathname.endsWith('/durations') && req.method === 'POST') {
    const slug = pathname.replace('/api/cineflow/project/', '').replace('/durations', '');
    if (!slug || slug.includes('..')) { sendJSON(res, { error: 'Invalid' }, 400); return; }
    try {
      fs.writeFileSync(path.join(ROOT, 'projects', slug, 'scene-durations.json'), await readBody(req));
      sendJSON(res, { ok: true });
    } catch (e) { sendJSON(res, { error: e.message }, 500); }
    return;
  }

  // ── API: save input file ──
  if (pathname === '/api/cineflow/save-input' && req.method === 'POST') {
    try {
      const { type, filename, data } = JSON.parse(await readBody(req));
      if (!type || !filename || !data) { sendJSON(res, { error: 'Missing fields' }, 400); return; }
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) { sendJSON(res, { error: 'Invalid filename' }, 400); return; }
      const subDir = type === 'audio' ? 'audio' : 'reference-images';
      const destDir = path.join(ROOT, 'input', subDir);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, filename), Buffer.from(data, 'base64'));
      sendJSON(res, { ok: true });
    } catch (e) { sendJSON(res, { error: e.message }, 500); }
    return;
  }

  // ── API: list input files ──
  if (pathname === '/api/cineflow/input-files' && req.method === 'GET') {
    try {
      const refsDir = path.join(ROOT, 'input', 'reference-images');
      const audioDir = path.join(ROOT, 'input', 'audio');
      sendJSON(res, {
        refs: fs.existsSync(refsDir) ? fs.readdirSync(refsDir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort() : [],
        audio: fs.existsSync(audioDir) ? fs.readdirSync(audioDir).filter(f => /\.(mp3|wav|m4a|aac)$/i.test(f)).sort() : [],
      });
    } catch (e) { sendJSON(res, { error: e.message }, 500); }
    return;
  }

  // ── API: delete input file ──
  if (pathname === '/api/cineflow/input-file' && req.method === 'DELETE') {
    try {
      const { type, filename } = JSON.parse(await readBody(req));
      if (!filename || filename.includes('..')) { sendJSON(res, { error: 'Invalid' }, 400); return; }
      const filePath = path.join(ROOT, 'input', type === 'audio' ? 'audio' : 'reference-images', filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      sendJSON(res, { ok: true });
    } catch (e) { sendJSON(res, { error: e.message }, 500); }
    return;
  }

  // ── API: run pipeline ──
  if (pathname === '/api/cineflow/run' && req.method === 'POST') {
    try {
      const { slug, description, scenes, lang, refs, audioFile } = JSON.parse(await readBody(req));
      if (!slug || !description) { sendJSON(res, { error: 'slug and description required' }, 400); return; }
      if (pipelineState?.status === 'running') { sendJSON(res, { error: 'Pipeline already running' }, 409); return; }
      pipelineState = { status: 'running', slug, step: 'analyze', progress: 0, current: 0, total: 0, logs: [], error: null, startedAt: Date.now() };
      runPipeline(slug, description, scenes || 10, lang || 'EN', refs || [], audioFile || null).catch(() => {});
      sendJSON(res, { ok: true, slug });
    } catch (e) { sendJSON(res, { error: e.message }, 500); }
    return;
  }

  // ── API: pipeline status ──
  if (pathname === '/api/cineflow/run/status' && req.method === 'GET') {
    sendJSON(res, pipelineState || { status: 'idle' }); return;
  }

  // ── API: open folder (Windows) ──
  if (pathname === '/api/cineflow/open-folder' && req.method === 'POST') {
    const { slug } = JSON.parse(await readBody(req));
    const folderPath = path.join(ROOT, 'projects', (slug || '').replace(/\.\./g, ''), 'scenes').replace(/\//g, '\\');
    const { exec } = await import('node:child_process');
    exec(`explorer "${folderPath}"`);
    sendJSON(res, { ok: true }); return;
  }

  // ── API: generate videos (WaveSpeed) ──
  if (pathname === '/api/cineflow/generate-videos' && req.method === 'POST') {
    const { slug } = JSON.parse(await readBody(req));
    const safeSlug = (slug || '').replace(/\.\./g, '');
    (async () => {
      try {
        const { WAVESPEED_API_KEY } = readEnvFile();
        const scenesDir = path.join(ROOT, 'projects', safeSlug, 'scenes');
        const prod = JSON.parse(fs.readFileSync(path.join(ROOT, 'projects', safeSlug, 'production.json'), 'utf8'));
        let durations = {};
        const durPath = path.join(ROOT, 'projects', safeSlug, 'scene-durations.json');
        if (fs.existsSync(durPath)) durations = JSON.parse(fs.readFileSync(durPath, 'utf8'));

        const tasks = [];
        for (const scene of prod.scenes) {
          const imgFile = path.join(scenesDir, `scene-${String(scene.id).padStart(2, '0')}.png`);
          if (!fs.existsSync(imgFile)) continue;
          const dur = durations[`scene-${String(scene.id).padStart(2, '0')}.png`] || 5;
          try {
            const result = await apiRequest(
              'https://api.wavespeed.ai/api/v3/kwaivgi/kling-v3.0-std/image-to-video',
              { image: `data:image/png;base64,${fs.readFileSync(imgFile).toString('base64')}`, prompt: scene.video_prompt || 'Cinematic motion, slow push-in', duration: dur, aspect_ratio: '16:9' },
              { 'Authorization': `Bearer ${WAVESPEED_API_KEY}` }
            );
            const taskId = result?.data?.id;
            if (taskId) { tasks.push({ taskId, sceneId: scene.id }); broadcast({ type: 'pipeline:progress', step: 'videos', action: 'submitted', sceneId: scene.id, taskId }); }
          } catch (e) { broadcast({ type: 'pipeline:progress', step: 'videos', action: 'submit_error', sceneId: scene.id, error: e.message }); }
          await new Promise(r => setTimeout(r, 500));
        }

        fs.writeFileSync(path.join(ROOT, 'projects', safeSlug, 'wavespeed-tasks.json'), JSON.stringify(tasks, null, 2));

        const pending = [...tasks];
        while (pending.length > 0) {
          await new Promise(r => setTimeout(r, 10000));
          for (let i = pending.length - 1; i >= 0; i--) {
            const t = pending[i];
            try {
              const status = await apiRequest(`https://api.wavespeed.ai/api/v3/predictions/${t.taskId}/result`, null, { 'Authorization': `Bearer ${WAVESPEED_API_KEY}` }, 'GET');
              const url = status?.data?.outputs?.[0];
              if (url) {
                const outFile = path.join(scenesDir, `scene-${String(t.sceneId).padStart(2, '0')}.mp4`);
                try { await downloadFile(url, outFile); pending.splice(i, 1); broadcast({ type: 'pipeline:progress', step: 'videos', action: 'done', sceneId: t.sceneId }); }
                catch (e) { broadcast({ type: 'pipeline:progress', step: 'videos', action: 'download_error', sceneId: t.sceneId, error: e.message }); }
              }
            } catch (e) { broadcast({ type: 'pipeline:progress', step: 'videos', action: 'poll_error', sceneId: t.sceneId, error: e.message }); }
          }
        }
        broadcast({ type: 'pipeline:progress', step: 'videos', action: 'complete' });
      } catch (e) { broadcast({ type: 'pipeline:progress', step: 'videos', action: 'error', error: e.message }); }
    })();
    sendJSON(res, { ok: true }); return;
  }

  // ── API: re-download videos ──
  if (pathname === '/api/cineflow/redownload-videos' && req.method === 'POST') {
    const { slug, taskIds } = JSON.parse(await readBody(req));
    const safeSlug = (slug || '').replace(/\.\./g, '');
    (async () => {
      try {
        const { WAVESPEED_API_KEY } = readEnvFile();
        const scenesDir = path.join(ROOT, 'projects', safeSlug, 'scenes');
        const tasksFile = path.join(ROOT, 'projects', safeSlug, 'wavespeed-tasks.json');
        let tasks = taskIds || [];
        if (!tasks.length && fs.existsSync(tasksFile)) tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
        if (!tasks.length) { broadcast({ type: 'pipeline:progress', step: 'redownload', action: 'error', error: 'No task IDs found' }); return; }

        broadcast({ type: 'pipeline:progress', step: 'redownload', action: 'start', total: tasks.length });
        let downloaded = 0, skipped = 0, failed = 0;
        for (const t of tasks) {
          const outFile = path.join(scenesDir, `scene-${String(t.sceneId).padStart(2, '0')}.mp4`);
          if (fs.existsSync(outFile)) { skipped++; broadcast({ type: 'pipeline:progress', step: 'redownload', action: 'skip', sceneId: t.sceneId }); continue; }
          try {
            const status = await apiRequest(`https://api.wavespeed.ai/api/v3/predictions/${t.taskId}/result`, null, { 'Authorization': `Bearer ${WAVESPEED_API_KEY}` }, 'GET');
            const url = status?.data?.outputs?.[0];
            if (url) { await downloadFile(url, outFile); downloaded++; broadcast({ type: 'pipeline:progress', step: 'redownload', action: 'done', sceneId: t.sceneId }); }
            else { failed++; broadcast({ type: 'pipeline:progress', step: 'redownload', action: 'not_ready', sceneId: t.sceneId }); }
          } catch (e) { failed++; broadcast({ type: 'pipeline:progress', step: 'redownload', action: 'error', sceneId: t.sceneId, error: e.message }); }
          await new Promise(r => setTimeout(r, 300));
        }
        broadcast({ type: 'pipeline:progress', step: 'redownload', action: 'complete', downloaded, skipped, failed });
      } catch (e) { broadcast({ type: 'pipeline:progress', step: 'redownload', action: 'error', error: e.message }); }
    })();
    sendJSON(res, { ok: true }); return;
  }

  // ── API: merge with FFmpeg ──
  if (pathname === '/api/cineflow/merge-ffmpeg' && req.method === 'POST') {
    const { slug } = JSON.parse(await readBody(req));
    const safeSlug = (slug || '').replace(/\.\./g, '');
    (async () => {
      try {
        const scenesDir = path.join(ROOT, 'projects', safeSlug, 'scenes');
        const outputDir = path.join(ROOT, 'projects', safeSlug, 'output');
        const audioDir = path.join(ROOT, 'input', 'audio');
        fs.mkdirSync(outputDir, { recursive: true });

        const clips = fs.readdirSync(scenesDir).filter(f => /\.mp4$/i.test(f)).sort();
        if (!clips.length) { broadcast({ type: 'pipeline:progress', step: 'merge', action: 'error', error: 'No MP4 clips found' }); return; }

        const concatPath = path.join(outputDir, 'concat.txt');
        fs.writeFileSync(concatPath, clips.map(c => `file '${path.join(scenesDir, c).replace(/\\/g, '/')}'`).join('\n'));

        const audioFiles = fs.existsSync(audioDir) ? fs.readdirSync(audioDir).filter(f => /\.(mp3|wav|aac)$/i.test(f)) : [];
        const audioFile = audioFiles[0] ? path.join(audioDir, audioFiles[0]) : null;
        const outputFile = path.join(outputDir, `${safeSlug}-final.mp4`);
        const { spawn } = await import('node:child_process');
        const args = audioFile
          ? ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-i', audioFile, '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputFile]
          : ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', outputFile];

        broadcast({ type: 'pipeline:progress', step: 'merge', action: 'started', clips: clips.length });
        spawn('ffmpeg', args).on('close', code => {
          if (code === 0) broadcast({ type: 'pipeline:progress', step: 'merge', action: 'complete', outputFile: `${safeSlug}-final.mp4` });
          else broadcast({ type: 'pipeline:progress', step: 'merge', action: 'error', error: `ffmpeg exited ${code}` });
        });
      } catch (e) { broadcast({ type: 'pipeline:progress', step: 'merge', action: 'error', error: e.message }); }
    })();
    sendJSON(res, { ok: true }); return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket ──
try {
  const { WebSocketServer } = await import('ws');
  wss = new WebSocketServer({ server });
  console.log('  WebSocket enabled');
} catch {
  console.log('  WebSocket unavailable (run: npm install)');
}

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════╗`);
  console.log(`  ║   CineFlow Studio                ║`);
  console.log(`  ║   http://localhost:${PORT}          ║`);
  console.log(`  ╚══════════════════════════════════╝\n`);
});
