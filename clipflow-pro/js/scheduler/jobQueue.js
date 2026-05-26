import { db, STORES } from '../storage/db.js';

export const JOB_STATUS = {
  SCHEDULED: 'scheduled',
  RUNNING: 'running',
  POSTED: 'posted',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const jobQueue = {
  async add(jobData) {
    const job = {
      clipId: jobData.clipId,
      blobId: jobData.blobId,
      platform: jobData.platform,
      caption: jobData.caption || '',
      scheduledAt: new Date(jobData.scheduledAt).toISOString(),
      status: JOB_STATUS.SCHEDULED,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      options: jobData.options || {},
    };
    const id = await db.put(STORES.SCHEDULED_POSTS, job);
    return { id, ...job };
  },

  async getAll() {
    return db.getAll(STORES.SCHEDULED_POSTS);
  },

  async getById(id) {
    return db.get(STORES.SCHEDULED_POSTS, id);
  },

  async getDue(now = new Date()) {
    return db.getScheduledPostsDue(now);
  },

  async getByStatus(status) {
    return db.getAllByIndex(STORES.SCHEDULED_POSTS, 'status', status);
  },

  async markRunning(id) {
    return db.updatePostStatus(id, JOB_STATUS.RUNNING);
  },

  async markPosted(id, result = {}) {
    await db.updatePostStatus(id, JOB_STATUS.POSTED, {
      postedAt: new Date().toISOString(),
      result: JSON.stringify(result),
    });

    const job = await db.get(STORES.SCHEDULED_POSTS, id);
    await db.put(STORES.POSTED_HISTORY, {
      jobId: id,
      clipId: job.clipId,
      platform: job.platform,
      caption: job.caption,
      scheduledAt: job.scheduledAt,
      postedAt: new Date().toISOString(),
      result: JSON.stringify(result),
    });
  },

  async markFailed(id, errorMsg, nextRetryAt = null) {
    const job = await db.get(STORES.SCHEDULED_POSTS, id);
    if (!job) return;

    const update = {
      ...job,
      status: nextRetryAt ? JOB_STATUS.SCHEDULED : JOB_STATUS.FAILED,
      retryCount: (job.retryCount || 0) + 1,
      lastError: errorMsg,
      updatedAt: new Date().toISOString(),
    };

    if (nextRetryAt) update.scheduledAt = nextRetryAt;
    return db.put(STORES.SCHEDULED_POSTS, update);
  },

  async cancel(id) {
    return db.updatePostStatus(id, JOB_STATUS.CANCELLED);
  },

  async reschedule(id, newTime) {
    const job = await db.get(STORES.SCHEDULED_POSTS, id);
    if (!job) throw new Error(`Job ${id} not found`);
    return db.put(STORES.SCHEDULED_POSTS, {
      ...job,
      scheduledAt: new Date(newTime).toISOString(),
      status: JOB_STATUS.SCHEDULED,
      updatedAt: new Date().toISOString(),
    });
  },

  async remove(id) {
    return db.delete(STORES.SCHEDULED_POSTS, id);
  },

  async getUpcomingCount() {
    const all = await this.getByStatus(JOB_STATUS.SCHEDULED);
    return all.length;
  },

  getTimeUntilNext(jobs) {
    const now = Date.now();
    const upcoming = jobs
      .filter((j) => j.status === JOB_STATUS.SCHEDULED)
      .map((j) => new Date(j.scheduledAt).getTime())
      .filter((t) => t > now)
      .sort((a, b) => a - b);

    if (!upcoming.length) return null;
    return upcoming[0] - now;
  },
};
