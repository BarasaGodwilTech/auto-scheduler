import { videoStore } from '../storage/videoStore.js';
import { clipGenerator } from '../core/clipGenerator.js';
import { notify } from './notifications.js';

function formatBytes(b) {
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

export const uploadUI = {
  currentFile: null,
  currentUploadId: null,
  isProcessing: false,

  init() {
    const zone = document.getElementById('uploadZone');
    const input = document.getElementById('fileInput');
    if (!zone || !input) return;

    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', (e) => {
      if (e.target.files[0]) this.handleFile(e.target.files[0]);
    });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('video/')) this.handleFile(file);
      else notify.error('Please drop a video file (MP4, MOV, WebM)');
    });

    const processBtn = document.getElementById('processBtn');
    if (processBtn) processBtn.addEventListener('click', () => this.startProcessing());
  },

  handleFile(file) {
    this.currentFile = file;
    const zone = document.getElementById('uploadZone');
    zone.innerHTML = `
      <div class="upload-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div class="upload-title" style="color:var(--success)">${file.name}</div>
      <div class="upload-sub">${formatBytes(file.size)} · ${file.type || 'video'} · Ready to process</div>
      <div class="upload-formats">
        <span class="fmt-tag" style="color:var(--success);border-color:rgba(34,211,160,0.3)">File loaded ✓</span>
        <span class="fmt-tag">Click to change</span>
      </div>`;

    const processBtn = document.getElementById('processBtn');
    if (processBtn) {
      processBtn.disabled = false;
      processBtn.style.opacity = '1';
    }
  },

  async startProcessing() {
    if (!this.currentFile) { notify.warn('Please select a video file first'); return; }
    if (this.isProcessing) return;

    const fairUse = document.getElementById('fairUseCheck');
    if (fairUse && !fairUse.checked) {
      notify.warn('Please confirm fair use compliance before processing');
      return;
    }

    this.isProcessing = true;
    this.showModal();

    try {
      this.setModalStep('Saving video to storage...', 2);
      const upload = await videoStore.saveUpload(this.currentFile);
      this.currentUploadId = upload.id;

      this.setModalStep('Loading FFmpeg (first load may take 30s)...', 5);

      const targetDuration = parseInt(document.getElementById('clipDuration')?.value || '30');
      const maxClips = parseInt(document.getElementById('maxClips')?.value || '6');
      const reEncode = document.getElementById('outputFormat')?.value === 'reencode';
      const seriesMode = document.getElementById('seriesMode')?.checked || false;
      const seriesStartPart = parseInt(document.getElementById('seriesStartPart')?.value || '1');
      const overlayFormat = document.getElementById('overlayFormat')?.value || 'part-text';
      const aspectRatio = document.getElementById('aspectRatio')?.value || '9:16';

      await clipGenerator.processUpload(
        upload.id,
        (progress) => {
          if (progress.phase === 'analyzing') {
            const pct = 5 + progress.pct * 0.55;
            this.setModalProgress(pct, this.getPhaseLabel(progress));
          } else if (progress.phase === 'series-skip') {
            this.setModalProgress(60, 'Series mode: splitting into sequential parts...');
          } else if (progress.phase === 'generating') {
            const pct = 60 + progress.pct * 0.38;
            const partNum = seriesStartPart + (progress.clipIndex || 0);
            const label = seriesMode
              ? `Recording Part ${partNum}/${progress.total || '?'}...`
              : `Extracting clip ${(progress.clipIndex || 0) + 1}...`;
            this.setModalProgress(pct, label);
          } else if (progress.phase === 'done') {
            this.setModalProgress(100, `${progress.clips?.length || 0} clips ready!`);
          }
        },
        { targetDuration, maxClips, reEncode, seriesMode, seriesStartPart, overlayFormat, aspectRatio }
      );

      this.hideModal();
      notify.success('Clips generated successfully!');
      window.app?.navigate('clips');
    } catch (err) {
      console.error('[Upload] Processing failed:', err);
      this.hideModal();
      notify.error(`Processing failed: ${err.message}`);
    } finally {
      this.isProcessing = false;
      const preview = document.getElementById('procLivePreview');
      if (preview) preview.style.display = 'none';
    }
  },

  getPhaseLabel(progress) {
    const labels = {
      audio: 'Analyzing audio peaks...',
      scene: `Detecting scene changes (${Math.round(progress.pct || 0)}%)...`,
      scoring: 'Scoring clip candidates...',
      done: 'Analysis complete',
      analyzing: 'Analyzing video content...',
      generating: 'Generating clips with FFmpeg...',
    };
    return labels[progress.phase] || progress.phase;
  },

  showModal() {
    const modal = document.getElementById('procModal');
    if (modal) modal.classList.add('show');
    this.setModalProgress(0, 'Initializing...');
    this.updateStepsList(['Save to storage', 'Load FFmpeg', 'Analyze audio', 'Detect scenes', 'Score segments', 'Extract clips'], 0);
  },

  hideModal() {
    const modal = document.getElementById('procModal');
    if (modal) {
      setTimeout(() => modal.classList.remove('show'), 1200);
    }
  },

  setModalProgress(pct, label) {
    const bar = document.getElementById('procProgress');
    const pctEl = document.getElementById('procPct');
    const sub = document.getElementById('procSub');
    if (bar) bar.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
    if (sub) sub.textContent = label;

    const currentStep = pct < 5 ? 0 : pct < 30 ? 1 : pct < 50 ? 2 : pct < 57 ? 3 : pct < 60 ? 4 : 5;
    this.updateStepsList(['Save to storage', 'Load FFmpeg', 'Analyze audio', 'Detect scenes', 'Score segments', 'Extract clips'], currentStep);
  },

  setModalStep(label, pct) {
    const sub = document.getElementById('procSub');
    if (sub) sub.textContent = label;
    const bar = document.getElementById('procProgress');
    if (bar) bar.style.width = `${pct}%`;
  },

  updateStepsList(steps, activeIndex) {
    const list = document.getElementById('procSteps');
    if (!list) return;
    list.innerHTML = steps.map((s, i) => {
      const done = i < activeIndex;
      const active = i === activeIndex;
      return `<div class="proc-step-item${done ? ' done' : active ? ' active' : ''}">
        <svg class="step-icon" viewBox="0 0 18 18" fill="none">
          ${done
            ? `<polyline points="4 9 7.5 12.5 14 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
            : active
            ? `<circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="9" r="3" fill="currentColor"/>`
            : `<circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>`
          }
        </svg>
        ${s}
      </div>`;
    }).join('');
  },
};
