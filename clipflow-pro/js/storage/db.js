const DB_NAME = 'ClipFlowDB';
const DB_VERSION = 1;

const STORES = {
  UPLOADS: 'uploads',
  CLIPS: 'clips',
  SCHEDULED_POSTS: 'scheduled_posts',
  POSTED_HISTORY: 'posted_history',
  VIDEO_BLOBS: 'video_blobs',
  SETTINGS: 'settings',
};

class ClipFlowDatabase {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORES.UPLOADS)) {
          const uploads = db.createObjectStore(STORES.UPLOADS, { keyPath: 'id', autoIncrement: true });
          uploads.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.CLIPS)) {
          const clips = db.createObjectStore(STORES.CLIPS, { keyPath: 'id', autoIncrement: true });
          clips.createIndex('uploadId', 'uploadId', { unique: false });
          clips.createIndex('score', 'score', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.SCHEDULED_POSTS)) {
          const posts = db.createObjectStore(STORES.SCHEDULED_POSTS, { keyPath: 'id', autoIncrement: true });
          posts.createIndex('scheduledAt', 'scheduledAt', { unique: false });
          posts.createIndex('status', 'status', { unique: false });
          posts.createIndex('platform', 'platform', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.POSTED_HISTORY)) {
          const hist = db.createObjectStore(STORES.POSTED_HISTORY, { keyPath: 'id', autoIncrement: true });
          hist.createIndex('postedAt', 'postedAt', { unique: false });
          hist.createIndex('platform', 'platform', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.VIDEO_BLOBS)) {
          db.createObjectStore(STORES.VIDEO_BLOBS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async transaction(storeName, mode = 'readonly') {
    const db = await this.open();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  async put(storeName, data) {
    const store = await this.transaction(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async get(storeName, key) {
    const store = await this.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAll(storeName) {
    const store = await this.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAllByIndex(storeName, indexName, value) {
    const store = await this.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const idx = store.index(indexName);
      const req = idx.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async delete(storeName, key) {
    const store = await this.transaction(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async count(storeName) {
    const store = await this.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getSetting(key) {
    const record = await this.get(STORES.SETTINGS, key);
    return record ? record.value : null;
  }

  async setSetting(key, value) {
    return this.put(STORES.SETTINGS, { key, value });
  }

  async getScheduledPostsDue(now = new Date()) {
    const all = await this.getAll(STORES.SCHEDULED_POSTS);
    return all.filter(p => p.status === 'scheduled' && new Date(p.scheduledAt) <= now);
  }

  async updatePostStatus(id, status, extra = {}) {
    const post = await this.get(STORES.SCHEDULED_POSTS, id);
    if (!post) throw new Error(`Post ${id} not found`);
    return this.put(STORES.SCHEDULED_POSTS, { ...post, status, ...extra, updatedAt: new Date().toISOString() });
  }
}

export const db = new ClipFlowDatabase();
export { STORES };
