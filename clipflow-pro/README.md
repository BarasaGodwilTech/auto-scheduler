# ClipFlow Pro

Production-ready creator automation studio. Uploads long-form video, auto-generates short clips using real FFmpeg.wasm processing, and auto-publishes to TikTok, Instagram Reels, and YouTube Shorts on a real schedule backed by IndexedDB.

## Architecture

```
clipflow-pro/
├── index.html                    ← Main app shell (ES module entry)
├── auth/callback.html            ← OAuth redirect handler (postMessage back to opener)
├── css/
│   ├── styles.css                ← Layout, sidebar, grid, typography
│   ├── components.css            ← Buttons, cards, forms, tables, modals
│   └── animations.css            ← Keyframes, transitions
├── js/
│   ├── app.js                    ← App init, routing, OAuth dispatch
│   ├── core/
│   │   ├── audioAnalyzer.js      ← Web Audio API — RMS peak detection
│   │   ├── sceneDetector.js      ← Canvas API — frame-diff scene changes
│   │   ├── videoProcessor.js     ← FFmpeg.wasm — real clip extraction
│   │   └── clipGenerator.js      ← Combines analysis + FFmpeg + DB storage
│   ├── platforms/
│   │   ├── oauthHelper.js        ← PKCE generation, popup opener, postMessage
│   │   ├── tiktok.js             ← TikTok v2 OAuth + video.publish API
│   │   ├── instagram.js          ← Facebook Graph API + Instagram Content Publishing
│   │   └── youtube.js            ← Google OAuth + YouTube Data API v3 resumable upload
│   ├── scheduler/
│   │   ├── jobQueue.js           ← IndexedDB CRUD for scheduled posts
│   │   ├── cronEngine.js         ← setInterval 60s polling + platform dispatch
│   │   └── retryHandler.js       ← Exponential backoff (1m → 2m → 4m, 3 max)
│   ├── storage/
│   │   ├── db.js                 ← IndexedDB wrapper (ClipFlowDB)
│   │   ├── authStore.js          ← XOR-encrypted token storage
│   │   └── videoStore.js         ← Video blob storage + upload records
│   └── ui/
│       ├── notifications.js      ← Toast notification system
│       ├── dashboard.js          ← Real stats from IndexedDB, live calendar
│       ├── upload.js             ← File drop + FFmpeg processing pipeline
│       ├── clips.js              ← Clip grid, preview, download, schedule
│       └── queue.js              ← Live queue table with countdowns
├── service-worker.js             ← COOP/COEP headers + asset caching
└── manifest.json                 ← PWA installable
```

## Setup

### 1. Serve with HTTPS

OAuth flows require HTTPS. Options:

**Option A — Deploy (recommended)**
```bash
# Deploy to Netlify
netlify deploy --dir clipflow-pro --prod
```

**Option B — Local HTTPS with mkcert**
```bash
# Install mkcert
choco install mkcert       # Windows
mkcert -install
mkcert localhost

# Serve with http-server
npx http-server clipflow-pro -S -C localhost.pem -K localhost-key.pem -p 8443
# Open: https://localhost:8443
```

**Option C — VS Code Live Server (HTTP only)**
> FFmpeg.wasm will work via the service worker's COOP/COEP headers after first load.
> OAuth popups will NOT work on plain HTTP (OAuth providers require HTTPS redirect URIs).
> Use this only for testing FFmpeg/clip generation without OAuth.

### 2. Register Platform Apps

#### TikTok
1. Go to [developers.tiktok.com](https://developers.tiktok.com/)
2. Create app → Web type
3. Add scopes: `user.info.basic`, `video.upload`, `video.publish`
4. Add redirect URI: `https://your-domain/auth/callback.html`
5. Copy **Client Key** and **Client Secret**

#### Instagram (via Facebook)
1. Go to [developers.facebook.com](https://developers.facebook.com/)
2. Create app → Consumer type
3. Add products: **Facebook Login**, **Instagram Graph API**
4. Add redirect URI: `https://your-domain/auth/callback.html`
5. Request permissions: `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`
6. Copy **App ID** and **App Secret**
> ⚠️ Requires an Instagram Professional (Business or Creator) account linked to a Facebook Page

#### YouTube
1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. Create project → Enable **YouTube Data API v3**
3. Create OAuth 2.0 credentials → Web application type
4. Add redirect URI: `https://your-domain/auth/callback.html`
5. Copy **Client ID** and **Client Secret**

### 3. Enter API Keys in App

1. Open ClipFlow Pro in browser
2. Go to **Settings → API Keys**
3. Enter all credentials and click **Save API Keys**
4. Go to **Accounts** and click connect for each platform

## Real Features

### Video Processing (FFmpeg.wasm)
- FFmpeg runs entirely client-side via WebAssembly
- `@ffmpeg/ffmpeg@0.12.10` loaded from unpkg CDN on first use (~30MB, then cached)
- Fast copy mode (`-c copy`) for supported formats — no re-encoding, instant extraction
- Re-encode mode for 9:16 vertical format output
- Real progress events from FFmpeg engine

### Intelligent Clip Detection
```
Score = (audioRMS × 0.40) + (sceneDiff × 0.30) + (positionBonus × 0.20) + (durationBonus × 0.10)
```
- **Audio**: Web Audio API decodes video, computes RMS per 1-second window, finds peaks > 65th percentile
- **Scene**: Canvas 160×90 frame comparison every 0.5s, pixel diff threshold 18/255
- **Position**: Slight preference for middle-of-video segments
- **Duration**: 30s clips score highest (platform optimal)

### Scheduling Engine
- `setInterval` polls every **60 seconds** for due posts
- Posts within their scheduled window are immediately dispatched
- Failures retry with exponential backoff: 1min → 2min → 4min (max 3 retries)
- Non-retryable errors (auth failures, quota) fail immediately
- All state persists in IndexedDB — survives browser restart

### OAuth Flow
1. App generates PKCE code verifier + SHA-256 challenge
2. Opens platform auth URL in popup
3. User authenticates on platform's real servers
4. Platform redirects to `/auth/callback.html?code=...&state=...`
5. Callback page validates state, calls `window.opener.postMessage({type:'oauth_callback', code, state})`
6. App exchanges code for access + refresh tokens
7. Tokens stored XOR-encrypted in IndexedDB

## IndexedDB Schema

| Store | Description |
|-------|-------------|
| `uploads` | Upload metadata (name, size, duration, status) |
| `clips` | Generated clip metadata + analysis scores |
| `video_blobs` | Actual video Blob objects |
| `scheduled_posts` | Job queue with status, retry count, scheduled time |
| `posted_history` | Archive of successfully published posts |
| `settings` | API keys (encrypted), user preferences |

## COOP/COEP Headers (FFmpeg.wasm Requirement)

FFmpeg.wasm's multi-threaded mode requires `SharedArrayBuffer`, which needs:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The service worker (`service-worker.js`) intercepts all responses and injects these headers automatically after first registration + page reload.

## Browser Support

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| FFmpeg.wasm | ✓ 88+ | ✓ 89+ | ✓ 15.2+ | ✓ 88+ |
| IndexedDB | ✓ | ✓ | ✓ | ✓ |
| Web Audio API | ✓ | ✓ | ✓ | ✓ |
| Service Worker | ✓ | ✓ | ✓ | ✓ |
| SharedArrayBuffer | ✓ (HTTPS) | ✓ (HTTPS) | ✓ (HTTPS) | ✓ (HTTPS) |
