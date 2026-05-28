import { db, STORES } from '../storage/db.js';
import { videoStore } from '../storage/videoStore.js';
import { jobQueue } from '../scheduler/jobQueue.js';
import { notify } from './notifications.js';

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export const clipsUI = {
  clips: [],
  previewUrls: {},

  async refresh() {
    this.clips = await db.getAll(STORES.CLIPS);
    this.renderGrid();
  },

  async renderGrid() {
    const grid = document.getElementById('clipGrid');
    if (!grid) return;

    if (this.clips.length === 0) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--muted)">
          <div style="font-size:48px;margin-bottom:12px">🎬</div>
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">No clips yet</div>
          <div style="font-size:14px">Upload a video to generate clips automatically</div>
        </div>`;
      return;
    }

    const sorted = [...this.clips].sort((a, b) => b.score - a.score);
    grid.innerHTML = sorted.map(clip => this.renderClipCard(clip)).join('');

    for (const clip of sorted) {
      this.generateThumbnail(clip);
    }
  },

  renderClipCard(clip) {
    const scoreColor = clip.score > 80 ? 'var(--success)' : clip.score > 60 ? 'var(--warn)' : 'var(--muted)';
    return `
      <div class="clip-card" id="clip-card-${clip.id}">
        <div class="clip-preview" id="clip-preview-${clip.id}">
          <div style="font-size:28px">🎬</div>
          <div class="clip-timeline">
            <div class="clip-time">${formatTime(clip.startTime)} → ${formatTime(clip.startTime + clip.duration)} · ${clip.duration}s</div>
          </div>
        </div>
        <div class="clip-meta">
          <div class="clip-title">${clip.title || `Clip (${formatTime(clip.startTime)})`}</div>
          <div class="clip-score">
            <span style="font-size:11px;color:var(--muted)">Score</span>
            <div class="score-bar"><div class="score-fill" style="width:${clip.score}%"></div></div>
            <span style="font-weight:600;color:${scoreColor}">${clip.score}</span>
          </div>
          <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
            <button class="btn btn-success btn-sm" onclick="window.clipsUI.scheduleClip(${clip.id})">📅 Schedule</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.previewClip(${clip.id})">▶ Preview</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.downloadClip(${clip.id})">⬇ Download</button>
            <button class="btn btn-danger btn-sm" onclick="window.clipsUI.deleteClip(${clip.id})">✕</button>
          </div>
        </div>
      </div>`;
  },

  async generateThumbnail(clip) {
    if (this.previewUrls[clip.blobId]) return;
    try {
      const blob = await videoStore.getBlob(clip.blobId);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      this.previewUrls[clip.blobId] = url;
      const preview = document.getElementById(`clip-preview-${clip.id}`);
      if (preview) {
        const video = document.createElement('video');
        video.src = url;
        video.muted = true;
        video.currentTime = 0.5;
        video.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;top:0;left:0;';
        preview.style.position = 'relative';
        preview.insertBefore(video, preview.firstChild);
        preview.querySelector('div[style*="font-size:28px"]')?.remove();
      }
    } catch {
    }
  },

  async previewClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    const blob = await videoStore.getBlob(clip.blobId);
    if (!blob) { notify.error('Clip blob not found'); return; }

    let url = this.previewUrls[clip.blobId];
    if (!url) { url = URL.createObjectURL(blob); this.previewUrls[clip.blobId] = url; }

    const modal = document.getElementById('previewModal');
    const vidEl = document.getElementById('previewVideo');
    if (modal && vidEl) {
      vidEl.src = url;
      modal.classList.add('show');
      vidEl.play().catch(() => {});
    }
  },

  async downloadClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    const blob = await videoStore.getBlob(clip.blobId);
    if (!blob) { notify.error('Clip file not found'); return; }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : 'mp4';
    a.download = `clip_${clip.id}_${formatTime(clip.startTime).replace(':', 'm')}s.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  async scheduleClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    window.app?.openScheduleModal(clip);
  },

  async deleteClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    if (!confirm('Delete this clip? This cannot be undone.')) return;

    await db.delete(STORES.CLIPS, clipId);
    await videoStore.deleteBlob(clip.blobId);
    if (this.previewUrls[clip.blobId]) {
      URL.revokeObjectURL(this.previewUrls[clip.blobId]);
      delete this.previewUrls[clip.blobId];
    }

    this.clips = this.clips.filter(c => c.id !== clipId);
    document.getElementById(`clip-card-${clipId}`)?.remove();
    notify.success('Clip deleted');
  },
};

window.clipsUI = clipsUI;
