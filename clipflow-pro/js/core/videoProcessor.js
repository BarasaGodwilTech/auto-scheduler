const FFMPEG_ESM_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
const CORE_JS_URL   = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js';
const CORE_WASM_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm';

async function toBlobURL(url, mimeType) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const blob = new Blob([await res.arrayBuffer()], { type: mimeType });
  return URL.createObjectURL(blob);
}

function setStatus(msg) {
  const el = document.getElementById('ffmpegStatus');
  if (el) el.textContent = msg;
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
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (this.loaded) { clearInterval(check); resolve(); }
        }, 200);
      });
      return;
    }

    this.loading = true;

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

    setStatus('Fetching FFmpeg core JS (~1MB)...');
    const coreURL = await toBlobURL(CORE_JS_URL, 'text/javascript');
    this._blobURLs.push(coreURL);

    setStatus('Fetching FFmpeg core WASM (~31MB)...');
    const wasmURL = await toBlobURL(CORE_WASM_URL, 'application/wasm');
    this._blobURLs.push(wasmURL);

    setStatus('Initializing FFmpeg engine...');
    await this.ffmpeg.load({ coreURL, wasmURL });

    this.loaded = true;
    this.loading = false;
    setStatus('FFmpeg ready ✓');
    console.log('[FFmpeg] Loaded successfully');
  }

  async extractClip(inputBlob, startTime, duration, options = {}) {
    await this.ensureFFmpegLoaded(options.onLog);

    const inputName = `input_${Date.now()}.mp4`;
    const outputName = `output_${Date.now()}.mp4`;

    const data = new Uint8Array(await inputBlob.arrayBuffer());
    await this.ffmpeg.writeFile(inputName, data);

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

    await this.ffmpeg.exec(cmd);
    if (this.onProgress) this.onProgress(100, null);

    const outputData = await this.ffmpeg.readFile(outputName);
    const outputBlob = new Blob([outputData.buffer], { type: 'video/mp4' });

    await this.ffmpeg.deleteFile(inputName);
    await this.ffmpeg.deleteFile(outputName);

    return outputBlob;
  }

  async extractClipsBatch(inputBlob, segments, onClipDone = null) {
    await this.ensureFFmpegLoaded();

    const ts = Date.now();
    const inputName = `input_${ts}.mp4`;
    const data = new Uint8Array(await inputBlob.arrayBuffer());
    await this.ffmpeg.writeFile(inputName, data);

    const results = [];
    for (let i = 0; i < segments.length; i++) {
      const { start, duration } = segments[i];
      const outputName = `out_${ts}_${i}.mp4`;

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

      await this.ffmpeg.exec(cmd);

      const outputData = await this.ffmpeg.readFile(outputName);
      const blob = new Blob([outputData.buffer], { type: 'video/mp4' });
      await this.ffmpeg.deleteFile(outputName);

      results.push(blob);
      if (onClipDone) onClipDone(i, blob);
      if (this.onProgress) this.onProgress(Math.round(((i + 1) / segments.length) * 100));
    }

    await this.ffmpeg.deleteFile(inputName);
    return results;
  }

  async extractClipWithReencode(inputBlob, startTime, duration, options = {}) {
    const { targetWidth = 1080, targetHeight = 1920, onLog } = options;
    await this.ensureFFmpegLoaded(onLog);

    const inputName = `input_${Date.now()}.mp4`;
    const outputName = `output_${Date.now()}.mp4`;

    const data = new Uint8Array(await inputBlob.arrayBuffer());
    await this.ffmpeg.writeFile(inputName, data);

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

    await this.ffmpeg.exec(cmd);
    if (this.onProgress) this.onProgress(100, null);

    const outputData = await this.ffmpeg.readFile(outputName);
    const outputBlob = new Blob([outputData.buffer], { type: 'video/mp4' });

    await this.ffmpeg.deleteFile(inputName);
    await this.ffmpeg.deleteFile(outputName);

    return outputBlob;
  }

  async getVideoInfo(blob) {
    await this.ensureFFmpegLoaded();
    const name = `probe_${Date.now()}.mp4`;
    const data = new Uint8Array(await blob.arrayBuffer());
    await this.ffmpeg.writeFile(name, data);

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
