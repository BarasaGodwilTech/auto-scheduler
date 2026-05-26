export class AudioAnalyzer {
  constructor() {
    this.audioContext = null;
  }

  getContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.audioContext;
  }

  async decodeAudio(videoBlob) {
    const ctx = this.getContext();
    const arrayBuffer = await videoBlob.arrayBuffer();
    return ctx.decodeAudioData(arrayBuffer);
  }

  async detectAudioPeaks(videoBlob, options = {}) {
    const {
      windowSizeSec = 1.0,
      peakThreshold = 0.65,
      smoothingWindow = 3,
    } = options;

    const audioBuffer = await this.decodeAudio(videoBlob);
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = Math.floor(windowSizeSec * sampleRate);
    const duration = audioBuffer.duration;

    const channelCount = audioBuffer.numberOfChannels;
    const windows = Math.floor(audioBuffer.length / windowSize);
    const rmsValues = new Float32Array(windows);

    for (let w = 0; w < windows; w++) {
      let sumSq = 0;
      for (let ch = 0; ch < channelCount; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = w * windowSize; i < (w + 1) * windowSize; i++) {
          sumSq += data[i] * data[i];
        }
      }
      rmsValues[w] = Math.sqrt(sumSq / (windowSize * channelCount));
    }

    const smoothed = new Float32Array(windows);
    for (let i = 0; i < windows; i++) {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - smoothingWindow); j <= Math.min(windows - 1, i + smoothingWindow); j++) {
        sum += rmsValues[j];
        count++;
      }
      smoothed[i] = sum / count;
    }

    const maxRMS = Math.max(...smoothed);
    const normalizedThreshold = peakThreshold * maxRMS;

    const peaks = [];
    let inPeak = false;
    for (let w = 0; w < windows; w++) {
      const timestamp = w * windowSizeSec;
      if (smoothed[w] >= normalizedThreshold) {
        if (!inPeak) {
          peaks.push({
            timestamp,
            rms: smoothed[w],
            normalizedScore: maxRMS > 0 ? smoothed[w] / maxRMS : 0,
          });
          inPeak = true;
        }
      } else {
        inPeak = false;
      }
    }

    return {
      peaks,
      duration,
      sampleRate,
      rmsValues: Array.from(smoothed),
    };
  }

  async getVolumeProfile(videoBlob, buckets = 100) {
    const audioBuffer = await this.decodeAudio(videoBlob);
    const channelData = audioBuffer.getChannelData(0);
    const bucketSize = Math.floor(channelData.length / buckets);
    const profile = [];

    for (let b = 0; b < buckets; b++) {
      let max = 0;
      for (let i = b * bucketSize; i < (b + 1) * bucketSize && i < channelData.length; i++) {
        max = Math.max(max, Math.abs(channelData[i]));
      }
      profile.push({
        bucket: b,
        timestamp: (b / buckets) * audioBuffer.duration,
        amplitude: max,
      });
    }

    return profile;
  }

  async close() {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }
  }
}

export const audioAnalyzer = new AudioAnalyzer();
