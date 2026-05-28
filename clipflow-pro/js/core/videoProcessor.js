const FFMPEG_ESM_URL    = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
const FFMPEG_WORKER_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js';
const CORE_JS_URL       = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js';
const CORE_WASM_URL     = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm';

async function toBlobURL(url, mimeType) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const blob = new Blob([await res.arrayBuffer()], { type: mimeType });
  return URL.createObjectURL(blob);
}

function setStatus(msg) {
  const el = document.getElementById('ffmpegStatus');
  if (el) el.textContent = msg;
  if (msg.startsWith('Recording clip')) {
    const sub = document.getElementById('procSub');
    if (sub) sub.textContent = '🔴 ' + msg;
  }
  console.log('[FFmpeg]', msg);
}

export class VideoProcessor {
  constructor() {
    this.ffmpeg = null;
    this.loaded = false;
    this.loading = false;
    this.onProgress = null;
    this._blobURLs = [];
  }

  async ensureFFmpegLoaded(onLog = null) {
    if (this.loaded) return;
    if (this.loading) {
      await new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (this.loaded) { clearInterval(check); resolve(); }
          else if (!this.loading) { clearInterval(check); reject(new Error('FFmpeg failed to load')); }
        }, 200);
      });
      return;
    }

    this.loading = true;

    try {
      if (!self.crossOriginIsolated) {
        setStatus('⚠ Reload required for SharedArrayBuffer (COOP/COEP headers)');
        console.warn('[FFmpeg] crossOriginIsolated is false. Reload the page after service worker installs.');
      }

      setStatus('Loading FFmpeg.wasm module...');

      const { FFmpeg } = await import(/* @vite-ignore */ FFMPEG_ESM_URL);
      if (!FFmpeg) throw new Error('FFmpeg class not found in ESM bundle');

      this.ffmpeg = new FFmpeg();

      this.ffmpeg.on('log', ({ message }) => {
        if (onLog) onLog(message);
      });

      this.ffmpeg.on('progress', ({ progress }) => {
        if (this.onProgress) this.onProgress(Math.min(progress * 100, 99));
      });

      setStatus('Fetching FFmpeg worker script...');
      const classWorkerURL = await toBlobURL(FFMPEG_WORKER_URL, 'text/javascript');
      this._blobURLs.push(classWorkerURL);

      setStatus('Fetching FFmpeg core JS (~1MB)...');
      const coreURL = await toBlobURL(CORE_JS_URL, 'text/javascript');
      this._blobURLs.push(coreURL);

      setStatus('Fetching FFmpeg core WASM (~31MB)...');
      const wasmURL = await toBlobURL(CORE_WASM_URL, 'application/wasm');
      this._blobURLs.push(wasmURL);

      setStatus('Initializing FFmpeg engine...');
      await this.ffmpeg.load({ classWorkerURL, coreURL, wasmURL });

      this.loaded = true;
      setStatus('FFmpeg ready ✓');
      console.log('[FFmpeg] Loaded successfully');
    } finally {
      this.loading = false;
    }
  }

  async _execWithTimeout(cmd, timeoutMs = 120000) {
    return Promise.race([
      this.ffmpeg.exec(cmd),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`FFmpeg timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      ),
    ]);
  }

  async extractClip(inputBlob, startTime, duration, options = {}) {
    await this.ensureFFmpegLoaded(options.onLog);

    const inputName = `input_${Date.now()}.mp4`;
    const outputName = `output_${Date.now()}.mp4`;

    try {
      const data = new Uint8Array(await inputBlob.arrayBuffer());
      await this.ffmpeg.writeFile(inputName, data);
    } catch (err) {
      throw new Error(`Failed to write input to VFS (file may be too large): ${err.message}`);
    }

    const cmd = [
      '-ss', String(startTime),
      '-i', inputName,
      '-t', String(duration),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y',
      outputName,
    ];

    await this._execWithTimeout(cmd);
    if (this.onProgress) this.onProgress(100, null);

    const outputData = await this.ffmpeg.readFile(outputName);
    const outputBlob = new Blob([outputData.buffer], { type: 'video/mp4' });

    await this.ffmpeg.deleteFile(inputName).catch(() => {});
    await this.ffmpeg.deleteFile(outputName).catch(() => {});

    return outputBlob;
  }

  _getSupportedMimeType() {
    const types = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  _extractClipMediaRecorder(videoBlob, startSec, durationSec, onCanvasReady = null, overlayOptions = {}, aspectRatio = 'original') {
    return new Promise((resolve, reject) => {
      const mimeType = this._getSupportedMimeType();
      const blobURL = URL.createObjectURL(videoBlob);
      const video = document.createElement('video');
      video.preload = 'auto';
      video.volume = 0;
      video.muted = false;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.src = blobURL;

      let settled = false;
      let recorder = null;
      let animFrame = null;
      let canvas = null;

      const finish = (resultOrError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (animFrame) cancelAnimationFrame(animFrame);
        if (recorder && recorder.state !== 'inactive') {
          try { recorder.stop(); } catch {}
        }
        if (canvas && canvas.parentElement?.id === 'procLivePreview') {
          canvas.parentElement.removeChild(canvas);
        }
        video.pause();
        video.src = '';
        video.load();
        URL.revokeObjectURL(blobURL);
        if (resultOrError instanceof Error) reject(resultOrError);
        else resolve(resultOrError);
      };

      const timer = setTimeout(
        () => finish(new Error(`MediaRecorder timed out (clip @${startSec}s)`)),
        (durationSec + 60) * 1000
      );

      video.onerror = () => finish(new Error(`Video element error: ${video.error?.message}`));
      video.addEventListener('canplay', () => { video.currentTime = startSec; }, { once: true });

      video.addEventListener('seeked', () => {
        // ── Compute output dimensions ──────────────────────────────────
        const [aw, ah] = aspectRatio === 'original'
          ? [video.videoWidth || 1280, video.videoHeight || 720]
          : aspectRatio.split(':').map(Number);
        const targetAR = aw / ah;
        let canvasW, canvasH;
        if (aspectRatio === 'original') {
          canvasW = video.videoWidth || 1280;
          canvasH = video.videoHeight || 720;
        } else if (targetAR <= 1) {
          canvasH = Math.min(video.videoHeight || 1920, 1920);
          canvasW = Math.round(canvasH * aw / ah);
        } else {
          canvasW = Math.min(video.videoWidth || 1920, 1920);
          canvasH = Math.round(canvasW * ah / aw);
        }

        canvas = document.createElement('canvas');
        canvas.width = canvasW;
        canvas.height = canvasH;
        const ctx = canvas.getContext('2d');

        // ── Draw loop ─────────────────────────────────────────────────
        const drawFrame = () => {
          if (settled) return;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvasW, canvasH);

          if (video.readyState >= 2) {
            const vw = video.videoWidth || canvasW;
            const vh = video.videoHeight || canvasH;
            const videoAR = vw / vh;
            let sx = 0, sy = 0, sw = vw, sh = vh;
            if (aspectRatio !== 'original') {
              if (videoAR > targetAR) {
                const newW = sh * targetAR;
                sx = (sw - newW) / 2;
                sw = newW;
              } else {
                const newH = sw / targetAR;
                sy = (sh - newH) / 2;
                sh = newH;
              }
            }
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
          }

          // ── Part number overlay ───────────────────────────────────
          const { format, partNumber } = overlayOptions;
          if (format === 'part-text' && partNumber != null) {
            const fs = Math.round(canvasW * 0.11);
            ctx.save();
            ctx.font = `bold ${fs}px 'Arial Black', Impact, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.lineWidth = fs * 0.12;
            ctx.strokeStyle = 'rgba(0,0,0,0.85)';
            ctx.strokeText(`PART ${partNumber}`, canvasW / 2, canvasH * 0.08);
            ctx.fillStyle = '#cc0000';
            ctx.fillText(`PART ${partNumber}`, canvasW / 2, canvasH * 0.08);
            ctx.restore();
          } else if (format === 'styled-number' && partNumber != null) {
            const ns = Math.round(canvasW * 0.38);
            ctx.save();
            ctx.font = `bold ${ns}px 'Arial Black', Impact, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = ns * 0.12;
            ctx.shadowOffsetX = ns * 0.06;
            ctx.shadowOffsetY = ns * 0.06;
            ctx.strokeStyle = '#b85c00';
            ctx.lineWidth = ns * 0.09;
            ctx.strokeText(String(partNumber), canvasW / 2, canvasH * 0.42);
            const grad = ctx.createLinearGradient(0, canvasH * 0.42 - ns / 2, 0, canvasH * 0.42 + ns / 2);
            grad.addColorStop(0, '#ffffff');
            grad.addColorStop(0.45, '#e0e0e0');
            grad.addColorStop(1, '#909090');
            ctx.fillStyle = grad;
            ctx.fillText(String(partNumber), canvasW / 2, canvasH * 0.42);
            ctx.restore();
          }

          animFrame = requestAnimationFrame(drawFrame);
        };
        drawFrame();

        if (onCanvasReady) onCanvasReady(canvas);

        // ── Combine canvas video + original audio ─────────────────────
        const canvasStream = canvas.captureStream(30);
        const captureFn = video.captureStream?.bind(video) || video.mozCaptureStream?.bind(video);
        if (!captureFn) { finish(new Error('captureStream API not available in this browser')); return; }
        const videoRawStream = captureFn();
        const combined = new MediaStream([
          ...canvasStream.getVideoTracks(),
          ...videoRawStream.getAudioTracks(),
        ]);

        const chunks = [];
        try {
          recorder = new MediaRecorder(combined, mimeType ? { mimeType } : {});
        } catch {
          try { recorder = new MediaRecorder(combined); }
          catch (e2) { finish(new Error(`MediaRecorder init failed: ${e2.message}`)); return; }
        }

        recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };
        recorder.onstop = () => finish(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
        recorder.onerror = (e) => finish(new Error(`MediaRecorder error: ${e.error?.message}`));

        recorder.start(200);
        const playPromise = video.play();
        if (playPromise) {
          playPromise.catch((e) => {
            if (e.name === 'NotAllowedError') {
              console.warn('[MediaRecorder] Autoplay blocked — user interaction may be needed');
            }
            finish(new Error(`play() failed: ${e.message}`));
          });
        }

        setTimeout(() => {
          if (!settled && recorder.state !== 'inactive') recorder.stop();
        }, durationSec * 1000 + 300);

        video.addEventListener('ended', () => {
          if (!settled && recorder.state !== 'inactive') recorder.stop();
        }, { once: true });
      }, { once: true });
    });
  }

  async extractClipsBatch(inputBlob, segments, onClipDone = null) {
    const FFMPEG_SIZE_LIMIT = 0; // Always use MediaRecorder for live preview + no WASM memory limits

    if (inputBlob.size > FFMPEG_SIZE_LIMIT) {
      console.log(`[VideoProcessor] File is ${(inputBlob.size / 1048576).toFixed(0)} MB — using MediaRecorder (bypasses WASM memory limit)`);
      const results = [];
      for (let i = 0; i < segments.length; i++) {
        const { start, duration } = segments[i];
        console.log(`[MediaRecorder] Clip ${i + 1}/${segments.length}: ${start}s + ${duration}s`);
        setStatus(`Recording clip ${i + 1}/${segments.length} — ${Math.ceil(duration)}s remaining...`);
        let blob = null;

        let elapsed = 0;
        const countdownTimer = setInterval(() => {
          elapsed++;
          const remaining = Math.max(0, Math.ceil(duration - elapsed));
          if (this.onProgress) this.onProgress(Math.round(Math.min((elapsed / duration) * 100, 95)));
          setStatus(`Recording clip ${i + 1}/${segments.length} — ${remaining}s remaining...`);
        }, 1000);

        try {
          const { overlayOptions = {}, aspectRatio = 'original' } = segments[i];
          blob = await this._extractClipMediaRecorder(inputBlob, start, duration, (canvasEl) => {
            const preview = document.getElementById('procLivePreview');
            if (preview) {
              const prev = preview.querySelector('canvas,video');
              if (prev) prev.remove();
              canvasEl.style.cssText = 'width:100%;max-height:160px;object-fit:contain;display:block';
              preview.appendChild(canvasEl);
              preview.style.display = 'block';
            }
          }, overlayOptions, aspectRatio);
          if (blob.size < 1000) {
            console.warn(`[MediaRecorder] Clip ${i + 1} too small (${blob.size} bytes), skipping`);
            blob = null;
          } else {
            console.log(`[MediaRecorder] Clip ${i + 1} done: ${(blob.size / 1024).toFixed(1)} KB`);
          }
        } catch (err) {
          console.error(`[MediaRecorder] Clip ${i + 1} failed:`, err.message);
        } finally {
          clearInterval(countdownTimer);
        }

        if (this.onProgress) this.onProgress(100);
        results.push(blob);
        if (onClipDone) onClipDone(i, blob);
      }
      return results;
    }

    // FFmpeg path for files ≤ 100 MB
    await this.ensureFFmpegLoaded();

    const ts = Date.now();
    const inputName = `input_${ts}.mp4`;

    console.log(`[FFmpeg] Writing ${(inputBlob.size / 1048576).toFixed(1)} MB to VFS...`);
    const data = new Uint8Array(await inputBlob.arrayBuffer());
    await this.ffmpeg.writeFile(inputName, data);
    console.log('[FFmpeg] Input file written to VFS');

    const results = [];
    for (let i = 0; i < segments.length; i++) {
      const { start, duration } = segments[i];
      const outputName = `out_${ts}_${i}.mp4`;
      console.log(`[FFmpeg] Clip ${i + 1}/${segments.length}: ss=${start} t=${duration}`);

      let blob = null;
      try {
        const cmd = [
          '-ss', String(start),
          '-i', inputName,
          '-t', String(duration),
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          '-movflags', '+faststart',
          '-y',
          outputName,
        ];

        await this._execWithTimeout(cmd, 120000);

        const outputData = await this.ffmpeg.readFile(outputName);
        await this.ffmpeg.deleteFile(outputName).catch(() => {});

        if (outputData.length < 1000) {
          console.warn(`[FFmpeg] Clip ${i + 1} output too small (${outputData.length} bytes), skipping`);
        } else {
          blob = new Blob([outputData.buffer], { type: 'video/mp4' });
          console.log(`[FFmpeg] Clip ${i + 1} done: ${(blob.size / 1024).toFixed(1)} KB`);
        }
      } catch (err) {
        console.error(`[FFmpeg] Clip ${i + 1} failed:`, err.message);
        await this.ffmpeg.deleteFile(outputName).catch(() => {});
      }

      results.push(blob);
      if (onClipDone) onClipDone(i, blob);
      if (this.onProgress) this.onProgress(Math.round(((i + 1) / segments.length) * 100));
    }

    await this.ffmpeg.deleteFile(inputName).catch(() => {});
    return results;
  }

  async extractClipWithReencode(inputBlob, startTime, duration, options = {}) {
    const { targetWidth = 1080, targetHeight = 1920, onLog } = options;
    await this.ensureFFmpegLoaded(onLog);

    const inputName = `input_${Date.now()}.mp4`;
    const outputName = `output_${Date.now()}.mp4`;

    try {
      const data = new Uint8Array(await inputBlob.arrayBuffer());
      await this.ffmpeg.writeFile(inputName, data);
    } catch (err) {
      throw new Error(`Failed to write input to VFS (file may be too large for re-encode): ${err.message}`);
    }

    const vfFilter = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black`;

    const cmd = [
      '-ss', String(startTime),
      '-i', inputName,
      '-t', String(duration),
      '-vf', vfFilter,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputName,
    ];

    await this._execWithTimeout(cmd, 300000);
    if (this.onProgress) this.onProgress(100, null);

    const outputData = await this.ffmpeg.readFile(outputName);
    const outputBlob = new Blob([outputData.buffer], { type: 'video/mp4' });

    await this.ffmpeg.deleteFile(inputName).catch(() => {});
    await this.ffmpeg.deleteFile(outputName).catch(() => {});

    return outputBlob;
  }

  async getVideoInfo(blob) {
    await this.ensureFFmpegLoaded();
    const name = `probe_${Date.now()}.mp4`;
    try {
      const data = new Uint8Array(await blob.arrayBuffer());
      await this.ffmpeg.writeFile(name, data);
    } catch (err) {
      throw new Error(`Failed to write probe to VFS (file may be too large): ${err.message}`);
    }

    const logs = [];
    const logHandler = ({ message }) => logs.push(message);
    this.ffmpeg.on('log', logHandler);

    try {
      await this.ffmpeg.exec(['-i', name, '-f', 'null', '-']);
    } catch {
    } finally {
      this.ffmpeg.off('log', logHandler);
    }

    await this.ffmpeg.deleteFile(name).catch(() => {});

    const durationMatch = logs.join('\n').match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (durationMatch) {
      const h = parseInt(durationMatch[1]);
      const m = parseInt(durationMatch[2]);
      const s = parseFloat(durationMatch[3]);
      return { duration: h * 3600 + m * 60 + s, logs };
    }
    return { duration: 0, logs };
  }

  terminate() {
    if (this.ffmpeg) {
      this.ffmpeg.terminate();
      this.ffmpeg = null;
      this.loaded = false;
    }
    for (const url of this._blobURLs) URL.revokeObjectURL(url);
    this._blobURLs = [];
  }
}

export const videoProcessor = new VideoProcessor();
