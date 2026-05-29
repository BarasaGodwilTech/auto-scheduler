import { db, STORES } from '../storage/db.js';
import { videoStore } from '../storage/videoStore.js';
import { videoProcessor } from '../core/videoProcessor.js';
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
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.openEdit(${clip.id})">✏️ Edit</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.openMix(${clip.id})">🎧 Mix Audio</button>
            <button class="btn btn-danger btn-sm" onclick="window.clipsUI.deleteClip(${clip.id})">✕</button>
          </div>
        </div>
      </div>`;
  },

  // Basic editor for start/duration/overlay timing
  openEdit(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    try {
      const modal = document.getElementById('audioMixModal'); // reuse structure styles; create lightweight inline form
      // Build a simple ephemeral editor modal next to Audio Mix modal
      let m = document.getElementById('editClipModal');
      if (!m) {
        const host = document.createElement('div');
        host.className = 'overlay-modal'; host.id = 'editClipModal';
        host.innerHTML = `
          <div class="modal-box" style="max-width:460px">
            <div class="modal-header"><span class="modal-title">Edit Clip</span><button class="modal-close" onclick="document.getElementById('editClipModal').classList.remove('show')">✕</button></div>
            <div class="form-group"><label class="form-label">Start Time (seconds)</label><input class="form-input" id="editStart" type="number" step="0.1" min="0"></div>
            <div class="form-group"><label class="form-label">Duration (seconds)</label><input class="form-input" id="editDuration" type="number" step="0.1" min="1"></div>
            <div class="form-group"><label class="form-label">Overlay Start (seconds)</label><input class="form-input" id="editOverlayStart" type="number" step="0.1" min="0"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
              <button class="btn btn-ghost" onclick="document.getElementById('editClipModal').classList.remove('show')">Close</button>
              <button class="btn btn-primary" onclick="window.clipsUI.saveEdit()">Save</button>
            </div>
          </div>`;
        document.body.appendChild(host);
      }
      document.getElementById('editStart').value = String(clip.startTime.toFixed(1));
      document.getElementById('editDuration').value = String(Number(clip.duration).toFixed(1));
      document.getElementById('editOverlayStart').value = String((clip.overlayStartSec || 0).toFixed(1));
      document.getElementById('editClipModal').dataset.clipId = String(clipId);
      document.getElementById('editClipModal').classList.add('show');
    } catch {}
  },

  async saveEdit() {
    const clipId = parseInt(document.getElementById('editClipModal')?.dataset?.clipId || '-1', 10);
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    try {
      const start = Math.max(0, parseFloat(document.getElementById('editStart')?.value || clip.startTime));
      const duration = Math.max(1, parseFloat(document.getElementById('editDuration')?.value || clip.duration));
      const overlayStartSec = Math.max(0, parseFloat(document.getElementById('editOverlayStart')?.value || 0));

      const upload = await db.get(STORES.UPLOADS, clip.uploadId);
      const originalBlob = await videoStore.getBlob(upload.blobId);

      const overlay = { format: clip.overlayFormat || 'none', partNumber: clip.partNumber, overlayStartSec };
      const aspect = clip.aspectRatio || 'original';

      const newBlob = await videoProcessor._extractClipMediaRecorder(originalBlob, start, duration, null, overlay, aspect);

      const newBlobId = videoStore.generateId('clip');
      await videoStore.saveBlob(newBlobId, newBlob, { clipIndex: clip.partNumber != null ? clip.partNumber - 1 : 0 });

      const updated = { ...clip, blobId: newBlobId, startTime: start, duration, overlayStartSec, updatedAt: new Date().toISOString() };
      await db.put(STORES.CLIPS, updated);
      const ix = this.clips.findIndex(c => c.id === clip.id); if (ix >= 0) this.clips[ix] = updated;
      document.getElementById('editClipModal')?.classList.remove('show');
      this.renderGrid();
      notify.success('Clip updated');
    } catch (e) {
      notify.error('Edit failed: ' + (e?.message || e));
    }
  },

  openMix(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    try {
      document.getElementById('mixClipId').value = String(clip.id);
      const en = document.getElementById('mixBgmEnable');
      const srcRow = document.getElementById('mixBgmSrcRow');
      const volRow = document.getElementById('mixBgmVolRow');
      const restartRow = document.getElementById('mixRestartRow');
      const ovol = document.getElementById('mixOrigVol');
      const bvol = document.getElementById('mixBgmVol');
      if (ovol) ovol.value = String(Math.round((clip.originalVolume != null ? clip.originalVolume : 1) * 100));
      if (bvol) bvol.value = String(Math.round((clip.bgmVolume != null ? clip.bgmVolume : 0.25) * 100));
      if (en) en.checked = !!clip.bgmEnabled;
      const urlEl = document.getElementById('mixBgmUrl');
      if (urlEl && clip.bgmSource && clip.bgmSource.type === 'url' && clip.bgmSource.url) urlEl.value = clip.bgmSource.url;
      // Add a small note to show what BGM source is currently linked (cannot prefill file input)
      const oldNote = document.getElementById('mixBgmNote');
      if (oldNote) oldNote.remove();
      if (srcRow && (clip.bgmSource || en?.checked)) {
        let note = '';
        if (clip.bgmSource?.type === 'url' && clip.bgmSource.url) {
          try { const u = new URL(clip.bgmSource.url); note = `Using URL: ${u.host}`; } catch { note = 'Using URL source'; }
        } else if (clip.bgmSource?.type === 'blob') {
          note = 'Using uploaded audio (stored)';
        }
        if (note) {
          const el = document.createElement('div');
          el.id = 'mixBgmNote';
          el.style.cssText = 'margin-top:6px;font-size:11px;color:var(--muted)';
          el.textContent = note;
          srcRow.appendChild(el);
        }
      }
      
      // Trigger the preview update logic
      const fakeEvent = new Event('input');
      document.getElementById('mixBgmUrl')?.dispatchEvent(fakeEvent);

      if (srcRow) srcRow.style.display = en && en.checked ? 'block' : 'none';
      if (volRow) volRow.style.display = en && en.checked ? 'block' : 'none';
      if (restartRow) restartRow.style.display = en && en.checked ? 'block' : 'none';
      if (en) en.onchange = () => {
        const on = !!en.checked;
        if (srcRow) srcRow.style.display = on ? 'block' : 'none';
        if (volRow) volRow.style.display = on ? 'block' : 'none';
        if (restartRow) restartRow.style.display = on ? 'block' : 'none';
        const note = document.getElementById('mixBgmNote');
        if (note) note.style.display = on ? 'block' : 'none';
      };
      document.getElementById('audioMixModal')?.classList.add('show');
    } catch {}
  },

  async previewMix() {
    // Non-destructive WebAudio preview to speakers
    const id = parseInt(document.getElementById('mixClipId')?.value || '-1', 10);
    const clip = this.clips.find(c => c.id === id);
    if (!clip) return;
    try {
      const origVolPct = parseInt(document.getElementById('mixOrigVol')?.value || '100');
      const originalVolume = Math.max(0, Math.min(1, origVolPct / 100));
      const en = !!document.getElementById('mixBgmEnable')?.checked;
      const url = (document.getElementById('mixBgmUrl')?.value || '').trim();
      const bgmFileEl = document.getElementById('mixBgmFile');
      const bgmFile = bgmFileEl && bgmFileEl.files && bgmFileEl.files[0] ? bgmFileEl.files[0] : null;
      const bgmVolPct = parseInt(document.getElementById('mixBgmVol')?.value || '25');
      const bgmVolume = Math.max(0, Math.min(1, bgmVolPct / 100));

      let processedUrl = url;
      if (processedUrl && processedUrl.match(/tiktok\.com|youtube\.com|youtu\.be/i)) {
        processedUrl = `http://localhost:3000/api/audio?url=${encodeURIComponent(processedUrl)}`;
      }

      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.destination;
      const clipBlob = await videoStore.getBlob(clip.blobId);
      const v = document.createElement('video');
      v.src = URL.createObjectURL(clipBlob);
      v.muted = true; v.playsInline = true;
      await v.play().catch(()=>{});
      const vSrc = ctx.createMediaElementSource(v);
      const vGain = ctx.createGain(); vGain.gain.value = originalVolume; vSrc.connect(vGain).connect(dest);

      if (en) {
        const bGain = ctx.createGain(); bGain.gain.value = bgmVolume; bGain.connect(dest);
        try {
          if (bgmFile) {
            const buf = await ctx.decodeAudioData(await bgmFile.arrayBuffer());
            const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.connect(bGain); n.start(0);
          } else if (processedUrl) {
            try {
              const res = await fetch(processedUrl); const arr = await res.arrayBuffer();
              const buf = await ctx.decodeAudioData(arr); const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.connect(bGain); n.start(0);
            } catch {
              const el = document.createElement('audio'); el.crossOrigin = 'anonymous'; el.src = processedUrl; await el.play().catch(()=>{});
              const m = ctx.createMediaElementSource(el); m.connect(bGain);
            }
          }
        } catch {}
      }
    } catch (e) {
      console.warn('Preview mix failed', e);
      notify.error('Preview failed');
    }
  },

  async saveMix() {
    const id = parseInt(document.getElementById('mixClipId')?.value || '-1', 10);
    const clip = this.clips.find(c => c.id === id);
    if (!clip) return;
    try {
      const upload = await db.get(STORES.UPLOADS, clip.uploadId);
      if (!upload) { notify.error('Upload not found'); return; }
      const originalBlob = await videoStore.getBlob(upload.blobId);
      if (!originalBlob) { notify.error('Original video not found'); return; }

      const bgmEnabled = !!document.getElementById('mixBgmEnable')?.checked;
      const origVolPct = parseInt(document.getElementById('mixOrigVol')?.value || '100');
      const originalVolume = Math.max(0, Math.min(1, origVolPct / 100));
      const bgmVolPct = parseInt(document.getElementById('mixBgmVol')?.value || '25');
      const bgmVolume = Math.max(0, Math.min(1, bgmVolPct / 100));
      const restart = !!document.getElementById('mixBgmRestart')?.checked;
      const url = (document.getElementById('mixBgmUrl')?.value || '').trim();
      const bgmFileEl = document.getElementById('mixBgmFile');
      const bgmFile = bgmFileEl && bgmFileEl.files && bgmFileEl.files[0] ? bgmFileEl.files[0] : null;

      let bgm = null;
      if (bgmEnabled) {
        if (bgmFile) {
          const idb = videoStore.generateId('bgm');
          await videoStore.saveBlob(idb, bgmFile, { name: bgmFile.name, type: bgmFile.type || 'audio' });
          bgm = { type: 'blob', blobId: idb, volume: bgmVolume, loop: true };
        } else if (url) {
          bgm = { type: 'url', url, volume: bgmVolume, loop: true };
        } else if (clip.bgmSource) {
          if (clip.bgmSource.type === 'blob') bgm = { type: 'blob', blobId: clip.bgmSource.blobId, volume: bgmVolume, loop: true };
          else if (clip.bgmSource.type === 'url') bgm = { type: 'url', url: clip.bgmSource.url, volume: bgmVolume, loop: true };
        }
      }

      const overlay = {
        format: clip.overlayFormat || 'none',
        partNumber: clip.partNumber != null ? clip.partNumber : null,
        overlayStartSec: clip.overlayStartSec || 0,
      };
      const aspect = clip.aspectRatio || 'original';

      const newBlob = await (bgm
        ? videoProcessor._extractClipWithAudioMix(originalBlob, clip.startTime, clip.duration, null, overlay, aspect, { bgm, originalVolume, restartAtClipStart: restart })
        : videoProcessor._extractClipMediaRecorder(originalBlob, clip.startTime, clip.duration, null, overlay, aspect));

      const newBlobId = videoStore.generateId('clip');
      await videoStore.saveBlob(newBlobId, newBlob, { clipIndex: clip.partNumber != null ? clip.partNumber - 1 : 0 });

      const updated = {
        ...clip,
        blobId: newBlobId,
        originalVolume,
        bgmVolume,
        bgmEnabled: !!bgm,
        bgmSource: bgm ? (bgm.type === 'blob' ? { type: 'blob', blobId: bgm.blobId } : { type: 'url', url: bgm.url }) : null,
        bgmRestart: restart,
        updatedAt: new Date().toISOString(),
      };
      await db.put(STORES.CLIPS, updated);
      const ix = this.clips.findIndex(c => c.id === clip.id);
      if (ix >= 0) this.clips[ix] = updated;
      try { window.dispatchEvent(new CustomEvent('clip:saved', { detail: updated })); } catch {}
      notify.success('Audio mix saved');
      document.getElementById('audioMixModal')?.classList.remove('show');
      this.renderGrid();

      // Apply scope
      const scope = document.getElementById('mixScope')?.value || 'one';
      if (scope !== 'one') {
        const peers = this.clips.filter(c => c.uploadId === clip.uploadId);
        const targets = scope === 'all' ? peers : peers.filter(c => (c.partNumber || 0) > (clip.partNumber || 0));
        for (const t of targets) {
          if (t.id === clip.id) continue;
          try {
            const tBlob = await (bgm
              ? videoProcessor._extractClipWithAudioMix(originalBlob, t.startTime, t.duration, null, { format: t.overlayFormat || 'none', partNumber: t.partNumber, overlayStartSec: t.overlayStartSec || 0 }, t.aspectRatio || 'original', { bgm, originalVolume, restartAtClipStart: restart })
              : videoProcessor._extractClipMediaRecorder(originalBlob, t.startTime, t.duration, null, { format: t.overlayFormat || 'none', partNumber: t.partNumber, overlayStartSec: t.overlayStartSec || 0 }, t.aspectRatio || 'original'));
            const tBlobId = videoStore.generateId('clip');
            await videoStore.saveBlob(tBlobId, tBlob, { clipIndex: t.partNumber != null ? t.partNumber - 1 : 0 });
            const upd = { ...t, blobId: tBlobId, originalVolume, bgmVolume, bgmEnabled: !!bgm, bgmSource: updated.bgmSource, bgmRestart: restart, updatedAt: new Date().toISOString() };
            await db.put(STORES.CLIPS, upd);
            const j = this.clips.findIndex(c => c.id === t.id); if (j >= 0) this.clips[j] = upd;
            try { window.dispatchEvent(new CustomEvent('clip:saved', { detail: upd })); } catch {}
          } catch (e) { console.warn('Apply mix failed for clip', t.id, e); }
        }
        this.renderGrid();
      }
    } catch (e) {
      console.error('Save mix failed', e);
      notify.error('Save failed: ' + (e?.message || e));
    }
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

// Live refresh + toast when a new clip is persisted
try {
  window.addEventListener('clip:saved', async (e) => {
    const clip = e?.detail;
    try { await clipsUI.refresh(); } catch {}
    try {
      const name = clip?.title || `Clip (${clip?.id || ''})`;
      notify.success(`Saved: ${name}`);
    } catch {}
  });
} catch {}
