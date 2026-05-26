import { jobQueue, JOB_STATUS } from './jobQueue.js';
import { retryHandler } from './retryHandler.js';
import { videoStore } from '../storage/videoStore.js';

const CHECK_INTERVAL_MS = 60 * 1000;

export class CronEngine {
  constructor() {
    this.intervalId = null;
    this.running = false;
    this.platformAPIs = {};
    this.onJobComplete = null;
    this.onJobFailed = null;
    this.onTick = null;
  }

  registerPlatform(name, api) {
    this.platformAPIs[name.toLowerCase()] = api;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._tick();
    this.intervalId = setInterval(() => this._tick(), CHECK_INTERVAL_MS);
    console.log('[CronEngine] Scheduler started, checking every 60 seconds');
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
    console.log('[CronEngine] Scheduler stopped');
  }

  async _tick() {
    if (this.onTick) this.onTick();
    try {
      const duePosts = await jobQueue.getDue(new Date());
      if (duePosts.length === 0) return;
      console.log(`[CronEngine] ${duePosts.length} post(s) due`);
      for (const post of duePosts) {
        await this.executePost(post);
      }
    } catch (err) {
      console.error('[CronEngine] Tick error:', err);
    }
  }

  async executePost(post) {
    console.log(`[CronEngine] Executing post ${post.id} on ${post.platform}`);
    await jobQueue.markRunning(post.id);

    try {
      const api = this.platformAPIs[post.platform.toLowerCase()];
      if (!api) throw new Error(`No API registered for platform: ${post.platform}`);

      const videoBlob = await videoStore.getBlob(post.blobId);
      if (!videoBlob) throw new Error(`Video blob not found: ${post.blobId}`);

      const result = await retryHandler.withRetry(
        () => this._publishToplatform(api, post.platform, videoBlob, post),
        post.id,
        (attempt, delay, err) => {
          console.warn(`[CronEngine] Retry ${attempt} for job ${post.id} in ${delay}ms:`, err.message);
        }
      );

      await jobQueue.markPosted(post.id, result);
      console.log(`[CronEngine] Post ${post.id} succeeded`);
      if (this.onJobComplete) this.onJobComplete(post, result);
    } catch (err) {
      console.error(`[CronEngine] Post ${post.id} failed:`, err.message);

      const freshPost = await jobQueue.getById(post.id);
      if (freshPost && retryHandler.shouldRetry(freshPost) && retryHandler.isRetryableError(err)) {
        const nextTime = retryHandler.getNextRetryTime(freshPost.retryCount || 0);
        await jobQueue.markFailed(post.id, err.message, nextTime);
        console.log(`[CronEngine] Scheduled retry for job ${post.id} at ${nextTime}`);
      } else {
        await jobQueue.markFailed(post.id, err.message, null);
      }

      if (this.onJobFailed) this.onJobFailed(post, err);
    }
  }

  async _publishToplatform(api, platform, videoBlob, post) {
    const p = platform.toLowerCase();
    if (p === 'tiktok') {
      return api.publishVideo(videoBlob, post.caption, post.options);
    }
    if (p === 'instagram') {
      return api.publishReel(videoBlob, post.caption, post.options);
    }
    if (p === 'youtube') {
      return api.uploadShort(videoBlob, {
        title: post.caption?.slice(0, 100) || 'Short',
        description: post.caption || '',
        tags: post.options?.tags || [],
        privacy: post.options?.privacy || 'public',
      });
    }
    throw new Error(`Unsupported platform: ${platform}`);
  }

  async forceExecute(jobId) {
    const post = await jobQueue.getById(jobId);
    if (!post) throw new Error(`Job ${jobId} not found`);
    return this.executePost(post);
  }
}

export const cronEngine = new CronEngine();
