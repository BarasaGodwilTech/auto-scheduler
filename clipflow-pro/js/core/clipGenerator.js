import { audioAnalyzer } from './audioAnalyzer.js';
import { sceneDetector } from './sceneDetector.js';
import { videoProcessor } from './videoProcessor.js';
import { videoStore } from '../storage/videoStore.js';
import { db, STORES } from '../storage/db.js';

export class ClipGenerator {
  constructor() {
    this.CLIP_DURATIONS = [15, 30, 45, 60];
    this.MAX_CLIPS = 8;
  }

  async analyze(videoBlob, onProgress = null) {
    if (onProgress) onProgress({ phase: 'audio', pct: 0 });

    const [audioResult, sceneResult] = await Promise.all([
      audioAnalyzer.detectAudioPeaks(videoBlob, { windowSizeSec: 1.0, peakThreshold: 0.6 }).catch(() => ({ peaks: [], duration: 0 })),
      sceneDetector.detectSceneChanges(videoBlob, {
        sampleInterval: 0.5,
        diffThreshold: 18,
        onProgress: (p) => { if (onProgress) onProgress({ phase: 'scene', pct: p * 100 }); },
      }).catch(() => ({ sceneChanges: [], duration: 0 })),
    ]);

    if (onProgress) onProgress({ phase: 'scoring', pct: 90 });

    const duration = audioResult.duration || sceneResult.duration || 0;
    const candidates = this.generateCandidates(duration, audioResult, sceneResult);
    const scored = this.scoreCandidates(candidates, audioResult, sceneResult, duration);

    if (onProgress) onProgress({ phase: 'done', pct: 100 });
    return { candidates: scored, duration };
  }

  generateCandidates(duration, audioResult, sceneResult) {
    const candidates = new Map();
    const add = (start, dur, source) => {
      const key = `${Math.round(start * 2) / 2}_${dur}`;
      if (!candidates.has(key)) {
        candidates.set(key, { start, duration: dur, sources: new Set() });
      }
      candidates.get(key).sources.add(source);
    };

    for (const peak of audioResult.peaks) {
      for (const dur of this.CLIP_DURATIONS) {
        const start = Math.max(0, peak.timestamp - dur * 0.25);
        if (start + dur <= duration) add(start, dur, 'audio');
      }
    }

    for (const scene of sceneResult.sceneChanges) {
      for (const dur of this.CLIP_DURATIONS) {
        const start = Math.max(0, scene.timestamp - 1.5);
        if (start + dur <= duration) add(start, dur, 'scene');
      }
    }

    const step = Math.max(30, duration / (this.MAX_CLIPS * 2));
    for (let t = 0; t + 30 <= duration; t += step) {
      add(t, 30, 'uniform');
    }

    return Array.from(candidates.values());
  }

  scoreCandidates(candidates, audioResult, sceneResult, duration) {
    const scored = candidates.map((c) => {
      let audioScore = 0;
      let sceneScore = 0;

      for (const peak of audioResult.peaks) {
        if (peak.timestamp >= c.start && peak.timestamp <= c.start + c.duration) {
          audioScore = Math.max(audioScore, peak.normalizedScore);
        }
      }

      for (const sc of sceneResult.sceneChanges) {
        if (sc.timestamp >= c.start && sc.timestamp <= c.start + c.duration) {
          sceneScore = Math.min(sceneScore + sc.normalizedDiff * 0.3, 1);
        }
      }

      const posScore = 1 - Math.abs((c.start + c.duration / 2) / duration - 0.5) * 0.3;
      const durationScore = c.duration === 30 ? 1 : c.duration === 60 ? 0.85 : 0.75;

      const totalScore = Math.round(
        (audioScore * 0.4 + sceneScore * 0.3 + posScore * 0.2 + durationScore * 0.1) * 100
      );

      return { ...c, audioScore, sceneScore, posScore, totalScore, sources: Array.from(c.sources) };
    });

    scored.sort((a, b) => b.totalScore - a.totalScore);

    const deduped = [];
    for (const c of scored) {
      const overlaps = deduped.some(
        (d) => Math.abs(d.start - c.start) < 10 && d.duration === c.duration
      );
      if (!overlaps) deduped.push(c);
      if (deduped.length >= this.MAX_CLIPS) break;
    }

    return deduped;
  }

  async generateClips(uploadId, videoBlob, candidates, options = {}) {
    const { onProgress = null, reEncode = false } = options;
    const results = [];
    const total = candidates.length;

    if (reEncode) {
      for (let i = 0; i < total; i++) {
        const c = candidates[i];
        if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct: 0 });
        videoProcessor.onProgress = (pct) => {
          if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct });
        };
        const clipBlob = await videoProcessor.extractClipWithReencode(videoBlob, c.start, c.duration);
        await this._saveClip(uploadId, clipBlob, c, i, results);
        if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct: 100 });
      }
      videoProcessor.onProgress = null;
    } else {
      if (onProgress) onProgress({ phase: 'extracting', clipIndex: 0, total, pct: 0 });

      videoProcessor.onProgress = (pct) => {
        const done = Math.floor(pct / 100 * total);
        if (onProgress) onProgress({ phase: 'extracting', clipIndex: done, total, pct });
      };

      const blobs = await videoProcessor.extractClipsBatch(
        videoBlob,
        candidates.map(c => ({ start: c.start, duration: c.duration })),
        (i) => {
          if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct: 100 });
        }
      );
      videoProcessor.onProgress = null;

      for (let i = 0; i < blobs.length; i++) {
        await this._saveClip(uploadId, blobs[i], candidates[i], i, results);
      }
    }

    return results;
  }

  async _saveClip(uploadId, clipBlob, c, i, results) {
    const blobId = videoStore.generateId('clip');
    await videoStore.saveBlob(blobId, clipBlob, { clipIndex: i });

    const record = {
      uploadId,
      blobId,
      startTime: c.start,
      duration: c.duration,
      score: c.totalScore,
      audioScore: c.audioScore,
      sceneScore: c.sceneScore,
      sources: c.sources,
      status: 'ready',
      createdAt: new Date().toISOString(),
      title: `Clip ${i + 1} (${formatTime(c.start)} \u2013 ${formatTime(c.start + c.duration)})`,
    };

    const clipId = await db.put(STORES.CLIPS, record);
    results.push({ id: clipId, blobId, ...record });
  }

  async processUpload(uploadId, onProgress = null, options = {}) {
    const {
      maxClips = 8,
      targetDuration = 30,
      reEncode = false,
    } = options;

    this.MAX_CLIPS = maxClips;
    if (targetDuration && !this.CLIP_DURATIONS.includes(targetDuration)) {
      this.CLIP_DURATIONS = [targetDuration, ...this.CLIP_DURATIONS.filter(d => Math.abs(d - targetDuration) > 5)].slice(0, 4);
    }

    const upload = await db.get(STORES.UPLOADS, uploadId);
    if (!upload) throw new Error(`Upload ${uploadId} not found`);

    const videoBlob = await videoStore.getBlob(upload.blobId);
    if (!videoBlob) throw new Error(`Video blob not found for upload ${uploadId}`);

    await db.put(STORES.UPLOADS, { ...upload, status: 'processing', updatedAt: new Date().toISOString() });

    if (onProgress) onProgress({ phase: 'analyzing', pct: 0 });
    const { candidates, duration } = await this.analyze(videoBlob, (p) => {
      if (onProgress) onProgress({ phase: 'analyzing', pct: p.pct * 0.6 });
    });

    if (onProgress) onProgress({ phase: 'generating', pct: 60 });
    const clips = await this.generateClips(uploadId, videoBlob, candidates, {
      reEncode,
      onProgress: (p) => {
        const total = candidates.length || 1;
        const base = 60 + ((p.clipIndex || 0) / total) * 35;
        if (onProgress) onProgress({ phase: 'generating', pct: base });
      },
    });

    await db.put(STORES.UPLOADS, {
      ...upload,
      status: 'done',
      clipCount: clips.length,
      duration,
      updatedAt: new Date().toISOString(),
    });

    if (onProgress) onProgress({ phase: 'done', pct: 100, clips });
    return clips;
  }
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export const clipGenerator = new ClipGenerator();
