export class SceneDetector {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.canvas.width = 160;
    this.canvas.height = 90;
  }

  computeFrameDiff(frameA, frameB) {
    const len = frameA.length;
    let totalDiff = 0;
    for (let i = 0; i < len; i += 4) {
      const dr = Math.abs(frameA[i] - frameB[i]);
      const dg = Math.abs(frameA[i + 1] - frameB[i + 1]);
      const db = Math.abs(frameA[i + 2] - frameB[i + 2]);
      totalDiff += (dr + dg + db) / 3;
    }
    return totalDiff / (len / 4);
  }

  captureFrame(videoElement) {
    this.ctx.drawImage(videoElement, 0, 0, this.canvas.width, this.canvas.height);
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
  }

  async seekTo(videoElement, time) {
    return new Promise((resolve) => {
      const handler = () => { videoElement.removeEventListener('seeked', handler); resolve(); };
      videoElement.addEventListener('seeked', handler);
      videoElement.currentTime = time;
    });
  }

  async detectSceneChanges(videoBlob, options = {}) {
    const {
      sampleInterval = 0.5,
      diffThreshold = 20,
      onProgress = null,
    } = options;

    const url = URL.createObjectURL(videoBlob);
    const video = document.createElement('video');
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
      video.src = url;
    });

    const duration = video.duration;
    const sceneChanges = [];
    let previousFrame = null;
    const totalSamples = Math.floor(duration / sampleInterval);

    for (let i = 0; i <= totalSamples; i++) {
      const time = i * sampleInterval;
      if (time >= duration) break;

      await this.seekTo(video, time);
      const currentFrame = this.captureFrame(video);

      if (previousFrame) {
        const diff = this.computeFrameDiff(currentFrame, previousFrame);
        if (diff > diffThreshold) {
          sceneChanges.push({
            timestamp: time,
            diff,
            normalizedDiff: Math.min(diff / 100, 1),
          });
        }
      }

      previousFrame = currentFrame;
      if (onProgress) onProgress(i / totalSamples);
    }

    video.src = '';
    URL.revokeObjectURL(url);

    return { sceneChanges, duration };
  }

  async getMotionProfile(videoBlob, buckets = 50) {
    const url = URL.createObjectURL(videoBlob);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
      video.src = url;
    });

    const duration = video.duration;
    const profile = [];
    let prevFrame = null;

    for (let i = 0; i < buckets; i++) {
      const time = (i / buckets) * duration;
      await this.seekTo(video, time);
      const frame = this.captureFrame(video);
      const diff = prevFrame ? this.computeFrameDiff(frame, prevFrame) : 0;
      profile.push({ bucket: i, timestamp: time, motionScore: diff });
      prevFrame = frame;
    }

    video.src = '';
    URL.revokeObjectURL(url);

    return profile;
  }
}

export const sceneDetector = new SceneDetector();
