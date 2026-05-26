const BASE_DELAY_MS = 60 * 1000;
const MAX_RETRIES = 3;

export const retryHandler = {
  shouldRetry(job) {
    return (job.retryCount || 0) < (job.maxRetries ?? MAX_RETRIES);
  },

  getNextRetryTime(retryCount) {
    const delayMs = BASE_DELAY_MS * Math.pow(2, retryCount);
    const jitter = Math.random() * 10000;
    return new Date(Date.now() + delayMs + jitter).toISOString();
  },

  isRetryableError(error) {
    const msg = error?.message?.toLowerCase() || '';
    const nonRetryable = [
      'not connected',
      'not configured',
      'unauthorized',
      'forbidden',
      'invalid token',
      'quota exceeded',
      'no instagram business',
    ];
    return !nonRetryable.some((phrase) => msg.includes(phrase));
  },

  async withRetry(fn, jobId, onRetry = null) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt >= MAX_RETRIES || !this.isRetryableError(err)) break;
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 5000;
        if (onRetry) onRetry(attempt + 1, delay, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  },
};
