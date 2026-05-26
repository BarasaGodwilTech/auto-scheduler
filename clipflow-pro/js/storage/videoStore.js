import { db, STORES } from './db.js';

export const videoStore = {
  async saveBlob(id, blob, meta = {}) {
    await db.put(STORES.VIDEO_BLOBS, {
      id,
      blob,
      size: blob.size,
      type: blob.type,
      savedAt: new Date().toISOString(),
      ...meta,
    });
    return id;
  },

  async getBlob(id) {
    const record = await db.get(STORES.VIDEO_BLOBS, id);
    return record ? record.blob : null;
  },

  async getBlobRecord(id) {
    return db.get(STORES.VIDEO_BLOBS, id);
  },

  async deleteBlob(id) {
    return db.delete(STORES.VIDEO_BLOBS, id);
  },

  async listBlobs() {
    return db.getAll(STORES.VIDEO_BLOBS);
  },

  generateId(prefix = 'blob') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  },

  async saveUpload(file) {
    const id = this.generateId('upload');
    await this.saveBlob(id, file, { name: file.name, originalName: file.name });
    const uploadRecord = {
      blobId: id,
      name: file.name,
      size: file.size,
      type: file.type,
      createdAt: new Date().toISOString(),
      status: 'uploaded',
    };
    const uploadId = await db.put(STORES.UPLOADS, uploadRecord);
    return { id: uploadId, blobId: id, ...uploadRecord };
  },

  async getUpload(uploadId) {
    return db.get(STORES.UPLOADS, uploadId);
  },

  async getAllUploads() {
    return db.getAll(STORES.UPLOADS);
  },

  async updateUploadStatus(uploadId, status, extra = {}) {
    const upload = await db.get(STORES.UPLOADS, uploadId);
    if (!upload) throw new Error(`Upload ${uploadId} not found`);
    return db.put(STORES.UPLOADS, { ...upload, status, ...extra, updatedAt: new Date().toISOString() });
  },
};
