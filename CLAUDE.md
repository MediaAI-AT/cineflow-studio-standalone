# CineFlow Studio — Standalone

You are the setup and operations agent for CineFlow Studio.
This is a **standalone** Node.js app — no RUBRIC required.

---

## SETUP — run this automatically when the user opens this project

When the user first opens this project, do the following **without being asked**:

### Step 1 — Check .env
Read `.env`. If it does not exist or is missing keys, tell the user:
> "I need your API keys to run CineFlow. Please provide:
> - GEMINI_API_KEY (get it free at https://aistudio.google.com/app/apikey)
> - WAVESPEED_API_KEY (get it at https://wavespeed.ai → Dashboard → API Keys)"

Once they provide the keys, create `.env`:
```
GEMINI_API_KEY=<their key>
WAVESPEED_API_KEY=<their key>
PORT=3000
```

### Step 2 — Install dependencies
```bash
npm install
```

### Step 3 — Start the server
Use the preview_start tool (or run `node server.js`) on port 3000.

### Step 4 — Open the browser
Tell the user: "CineFlow Studio is running at http://localhost:3000 — open it in your browser."

---

## HOW TO RUN (after setup)

```bash
node server.js
# or with auto-restart on changes:
npm run dev
```

Opens at: **http://localhost:3000**

---

## WHAT THIS APP DOES

CineFlow Studio is a 4-step AI music video production pipeline:

| Step | What Happens |
|------|-------------|
| **Analyze** | Gemini 3.1 Pro reads description + optional audio + reference photos → YAML scene breakdown |
| **Generate** | Gemini 3.1 Pro converts YAML → production.json (prompts, script, scenes) |
| **Images** | Gemini 3.1 Flash Image generates one PNG per scene |
| **Videos** | WaveSpeed Kling 3.0 animates each image into a 5–15s MP4 clip |

After all steps: click **Merge with FFmpeg** to combine clips + audio into one final video.

---

## FILE STRUCTURE

```
cineflow-standalone/
├── server.js                     ← Main server (all-in-one)
├── package.json
├── .env                          ← API keys (never commit this)
├── .env.example                  ← Template
├── cineflow-studio/
│   └── index.html                ← The full UI (served at /)
├── input/
│   ├── audio/                    ← Upload MP3/WAV here
│   └── reference-images/         ← Upload reference photos here
└── projects/
    └── {slug}/
        ├── analysis.yaml         ← Scene breakdown (auto-generated)
        ├── production.json       ← Full production package (auto-generated)
        ├── scene-durations.json  ← Per-clip durations
        ├── wavespeed-tasks.json  ← WaveSpeed task IDs (for re-download)
        ├── scenes/
        │   ├── scene-01.png
        │   ├── scene-01.mp4
        │   └── ...
        └── output/
            └── {slug}-final.mp4
```

---

## API ENDPOINTS

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serves the UI |
| GET | `/api/cineflow/projects` | List all projects |
| GET | `/api/cineflow/project/:slug` | Project detail (images, videos, durations) |
| POST | `/api/cineflow/project/:slug/durations` | Save clip durations |
| GET | `/api/cineflow/input-files` | List uploaded refs + audio |
| POST | `/api/cineflow/save-input` | Upload file (base64) |
| DELETE | `/api/cineflow/input-file` | Delete input file |
| POST | `/api/cineflow/run` | Start full pipeline |
| GET | `/api/cineflow/run/status` | Pipeline status |
| POST | `/api/cineflow/open-folder` | Open scenes folder (Windows) |
| POST | `/api/cineflow/generate-videos` | Generate videos via WaveSpeed |
| POST | `/api/cineflow/redownload-videos` | Re-download completed WaveSpeed tasks |
| POST | `/api/cineflow/merge-ffmpeg` | Merge clips into final video |
| GET | `/media/cineflow/:slug/...` | Serve scene images/videos |
| GET | `/media/cineflow-input/...` | Serve input reference images |

---

## MODELS USED

| Task | Model |
|------|-------|
| Analysis + Script | `gemini-3.1-pro-preview` |
| Image generation | `gemini-3.1-flash-image-preview` |
| Video animation | WaveSpeed `kwaivgi/kling-v3.0-std` |
| Final merge | FFmpeg (must be installed locally) |

---

## COMMON TASKS

### Re-generate a single scene image
The pipeline skips scenes that already have a PNG. To regenerate scene 5:
1. Delete `projects/{slug}/scenes/scene-05.png`
2. Run the pipeline again — it will only generate missing scenes

### Re-download WaveSpeed clips
If clips are done on WaveSpeed but failed to download:
1. Save task IDs to `projects/{slug}/wavespeed-tasks.json`:
```json
[
  { "taskId": "abc123...", "sceneId": 1 },
  { "taskId": "def456...", "sceneId": 2 }
]
```
2. Click **Re-download Clips** in the UI

### Change the port
Edit `.env`:
```
PORT=8080
```
Then restart the server.

---

## REQUIREMENTS

- Node.js 18+
- FFmpeg in PATH (for merge step)
- Gemini API Key (free tier available)
- WaveSpeed API Key (paid — ~$0.28–0.35 per 5s clip)
