/**
 * content-script.js — Injected into Twitch pages.
 *
 * Creates a floating panel (Shadow DOM) on /videos/* pages for analysing
 * VOD chat peaks. Supports custom time ranges [start, end], presets,
 * current playback time capture, interval caching, jump to timestamp,
 * clip start offset adjustment, interactive timeline chart, and export.
 *
 * @module content-script
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  //  State
  // ═══════════════════════════════════════════════════════════════════════════

  let currentVideoId = null;
  let currentAdapter = null;
  let currentPlatform = 'twitch';
  let panelRoot = null;
  let shadow = null;
  let messages = [];
  let peaks = [];
  let timeline = null;
  let videoMeta = null;
  let clipStatuses = {};
  let currentSettings = {};
  let isAnalysing = false;
  let selectedPeakIdx = -1;
  let activeRange = { start: 0, end: 0 };

  // ═══════════════════════════════════════════════════════════════════════════
  //  URL / navigation & adapter detection
  // ═══════════════════════════════════════════════════════════════════════════

  function detectCurrentAdapter() {
    if (typeof Adapters !== 'undefined' && Adapters.getAdapterForUrl) {
      return Adapters.getAdapterForUrl(location.href);
    }
    // Fallback if global Adapters object is loading
    if (/twitch\.tv\/videos\/\d+/.test(location.href)) {
      return {
        name: 'twitch',
        displayName: 'Twitch',
        isSupported: true,
        getVideoId: (u) => (u.match(/\/videos\/(\d+)/) || [])[1],
        getCurrentTime: () => { const v = document.querySelector('video'); return v ? v.currentTime : 0; },
        getVideoDuration: () => { const v = document.querySelector('video'); return v ? v.duration : 0; },
        seek: (s) => { const v = document.querySelector('video'); if (v) v.currentTime = s; }
      };
    }
    return null;
  }

  function onNavigate() {
    const adapter = detectCurrentAdapter();
    if (!adapter) {
      currentVideoId = null;
      currentAdapter = null;
      hidePanel();
      return;
    }

    const vid = adapter.getVideoId(location.href);
    if (vid) {
      const isDifferent = (vid !== currentVideoId || currentPlatform !== adapter.name);
      currentAdapter = adapter;
      currentPlatform = adapter.name;
      currentVideoId = vid;

      if (isDifferent) {
        messages = [];
        peaks = [];
        timeline = null;
        videoMeta = null;
        selectedPeakIdx = -1;
        ensurePanel();
        updatePlatformBadge();
        resetUI();
        initializeVodMetaAndRange();
      }
    } else {
      currentVideoId = null;
      currentAdapter = null;
      hidePanel();
    }
  }

  function getVodTimestampUrl(platform, videoId, seconds) {
    const sec = Math.max(0, Math.floor(seconds));
    if (platform === 'youtube') {
      return `https://www.youtube.com/watch?v=${videoId}&t=${sec}s`;
    }
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    let t = '';
    if (h > 0) t += `${h}h`;
    if (m > 0 || h > 0) t += `${m}m`;
    t += `${s}s`;
    return `https://www.twitch.tv/videos/${videoId}?t=${t}`;
  }

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', onNavigate);

  // ═══════════════════════════════════════════════════════════════════════════
  //  Panel creation (Shadow DOM)
  // ═══════════════════════════════════════════════════════════════════════════

  function ensurePanel() {
    if (panelRoot) {
      panelRoot.style.display = 'block';
      return;
    }
    panelRoot = document.createElement('div');
    panelRoot.id = 'chatpeak-clipper-root';
    panelRoot.style.cssText = 'all:initial; position:fixed; z-index:999999; display:block;';
    document.body.appendChild(panelRoot);
    shadow = panelRoot.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    shadow.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'cpc-panel';
    panel.innerHTML = PANEL_HTML;
    shadow.appendChild(panel);

    // Restore position & state
    chrome.storage.local.get('panelState', (r) => {
      const ps = r.panelState || {};
      if (ps.x != null) panel.style.left = ps.x + 'px';
      if (ps.y != null) panel.style.top = ps.y + 'px';
      if (ps.collapsed) toggleCollapse(true);
    });

    attachEventListeners(panel);
    loadSettings();
    updatePlatformBadge();
  }

  function updatePlatformBadge() {
    const badge = $('#cpc-platform-badge');
    if (!badge) return;
    badge.className = 'cpc-platform-badge';
    if (currentPlatform === 'youtube') {
      badge.textContent = 'YouTube';
      badge.classList.add('cpc-badge-youtube');
    } else {
      badge.textContent = 'Twitch';
      badge.classList.add('cpc-badge-twitch');
    }
  }

  function hidePanel() {
    if (panelRoot) panelRoot.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Event listeners
  // ═══════════════════════════════════════════════════════════════════════════

  function $(sel) { return shadow.querySelector(sel); }
  function $$(sel) { return shadow.querySelectorAll(sel); }

  function attachEventListeners(panel) {
    // Dragging
    const header = $('#cpc-header');
    let dragOffX = 0, dragOffY = 0, dragging = false;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      dragOffX = e.clientX - panel.offsetLeft;
      dragOffY = e.clientY - panel.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, e.clientX - dragOffX) + 'px';
      panel.style.top = Math.max(0, e.clientY - dragOffY) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        chrome.storage.local.set({
          panelState: {
            x: panel.offsetLeft,
            y: panel.offsetTop,
            collapsed: panel.classList.contains('collapsed'),
          }
        });
      }
    });

    // Collapse
    $('#cpc-collapse-btn').addEventListener('click', () => toggleCollapse());

    // Analyse
    $('#cpc-analyse-btn').addEventListener('click', startAnalysis);

    // Cancel
    $('#cpc-cancel-btn').addEventListener('click', cancelAnalysis);

    // Import
    $('#cpc-import-btn').addEventListener('click', () => {
      $('#cpc-file-input').click();
    });
    $('#cpc-file-input').addEventListener('change', handleImport);

    // Clear cache
    $('#cpc-clear-cache-btn').addEventListener('click', clearCache);

    // Export buttons
    $('#cpc-copy-btn').addEventListener('click', copyTimestamps);
    $('#cpc-csv-btn').addEventListener('click', downloadCSV);
    $('#cpc-json-btn').addEventListener('click', downloadJSON);

    // Sensitivity slider
    $('#cpc-sensitivity').addEventListener('input', onSensitivityChange);

    // Settings toggle
    $('#cpc-settings-toggle').addEventListener('click', () => {
      $('#cpc-settings-panel').classList.toggle('open');
    });

    // Advanced settings inputs
    for (const input of $$('.cpc-adv-input')) {
      input.addEventListener('change', onAdvancedSettingChange);
    }

    // TopN input & Show all button
    $('#cpc-show-all-btn')?.addEventListener('click', () => {
      currentSettings.topN = 0;
      renderResults();
    });
    $('#cpc-topn-input')?.addEventListener('change', (e) => {
      currentSettings.topN = parseInt(e.target.value) || 0;
      renderResults();
    });

    // ── Custom Analysis Range: Use Current Time buttons ──
    $('#cpc-start-curr-btn')?.addEventListener('click', () => {
      const cur = getCurrentVideoTime();
      $('#cpc-start-time').value = formatTime(cur);
      saveCurrentRangeInputs();
    });
    $('#cpc-end-curr-btn')?.addEventListener('click', () => {
      const cur = getCurrentVideoTime();
      $('#cpc-end-time').value = formatTime(cur);
      saveCurrentRangeInputs();
    });

    // Range input change listeners
    $('#cpc-start-time')?.addEventListener('change', saveCurrentRangeInputs);
    $('#cpc-end-time')?.addEventListener('change', saveCurrentRangeInputs);

    // Presets
    for (const btn of $$('.cpc-preset-btn')) {
      btn.addEventListener('click', (e) => {
        const preset = e.currentTarget.dataset.preset;
        applyPreset(preset);
      });
    }

    // Jump to timestamp
    $('#cpc-jump-btn')?.addEventListener('click', handleJumpToTimestamp);
    $('#cpc-jump-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleJumpToTimestamp();
    });
  }

  function toggleCollapse(forceCollapse) {
    const panel = $('#cpc-panel');
    const isCollapsed = forceCollapse ?? !panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed', isCollapsed);
    $('#cpc-collapse-btn').textContent = isCollapsed ? '▲' : '▼';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  VOD Metadata & Range Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  function initializeVodMetaAndRange() {
    if (!currentVideoId) return;

    chrome.runtime.sendMessage({
      action: 'getVideoMeta',
      videoId: currentVideoId,
      platform: currentPlatform,
      url: location.href,
    }, (resp) => {
      if (resp?.success && resp.meta?.lengthSeconds) {
        videoMeta = resp.meta;
      } else {
        const scraped = scrapeVodLength();
        videoMeta = {
          id: currentVideoId,
          title: document.title.replace(' - Twitch', '').replace(' - YouTube', ''),
          lengthSeconds: scraped || 3600,
          channel: '',
        };
      }

      const totalLen = videoMeta.lengthSeconds;

      // Check for saved last range
      chrome.runtime.sendMessage({
        action: 'getLastRange',
        videoId: currentVideoId,
        platform: currentPlatform,
      }, (rangeResp) => {
        const last = rangeResp?.range;
        if (last && last.startStr && last.endStr) {
          if ($('#cpc-start-time')) $('#cpc-start-time').value = last.startStr;
          if ($('#cpc-end-time')) $('#cpc-end-time').value = last.endStr;
        } else {
          if ($('#cpc-start-time')) $('#cpc-start-time').value = '00:00:00';
          if ($('#cpc-end-time')) $('#cpc-end-time').value = formatTime(totalLen);
        }
      });
    });
  }

  function getCurrentVideoTime() {
    if (currentAdapter && typeof currentAdapter.getCurrentTime === 'function') {
      return Math.floor(currentAdapter.getCurrentTime());
    }
    const video = document.querySelector('video');
    return video ? Math.floor(video.currentTime) : 0;
  }

  function saveCurrentRangeInputs() {
    if (!currentVideoId) return;
    const sStr = $('#cpc-start-time')?.value || '00:00:00';
    const eStr = $('#cpc-end-time')?.value || '00:00:00';
    chrome.runtime.sendMessage({
      action: 'saveLastRange',
      videoId: currentVideoId,
      platform: currentPlatform,
      range: { startStr: sStr, endStr: eStr },
    });
  }

  function applyPreset(preset) {
    const vodLen = videoMeta?.lengthSeconds || scrapeVodLength() || 7200;
    let s = 0, e = vodLen;

    switch (preset) {
      case 'last-1h':
        s = Math.max(0, vodLen - 3600);
        e = vodLen;
        break;
      case 'last-2h':
        s = Math.max(0, vodLen - 7200);
        e = vodLen;
        break;
      case 'first-2h':
        s = 0;
        e = Math.min(vodLen, 7200);
        break;
      case 'full':
      default:
        s = 0;
        e = vodLen;
        break;
    }

    if ($('#cpc-start-time')) $('#cpc-start-time').value = formatTime(s);
    if ($('#cpc-end-time')) $('#cpc-end-time').value = formatTime(e);
    saveCurrentRangeInputs();
  }

  function getAndValidateRange() {
    const startRaw = $('#cpc-start-time')?.value;
    const endRaw = $('#cpc-end-time')?.value;

    const startSec = parseTimestamp(startRaw);
    const endSec = parseTimestamp(endRaw);

    if (startSec === null) {
      return { valid: false, error: `Invalid start time "${startRaw}". Use HH:MM:SS, MM:SS, seconds, or 1h30m.` };
    }
    if (endSec === null) {
      return { valid: false, error: `Invalid end time "${endRaw}". Use HH:MM:SS, MM:SS, seconds, or 1h30m.` };
    }

    if (startSec < 0) {
      return { valid: false, error: 'Start time cannot be negative.' };
    }
    if (startSec >= endSec) {
      return { valid: false, error: `Start time (${formatTime(startSec)}) must be before end time (${formatTime(endSec)}).` };
    }

    const vodLen = videoMeta?.lengthSeconds || scrapeVodLength();
    if (vodLen && startSec > vodLen) {
      return { valid: false, error: `Start time exceeds VOD length (${formatTime(vodLen)}).` };
    }

    return { valid: true, startSec, endSec, startRaw, endRaw };
  }

  function handleJumpToTimestamp() {
    const input = $('#cpc-jump-input');
    if (!input || !input.value.trim()) return;
    const secs = parseTimestamp(input.value);
    if (secs === null) {
      alert(`Invalid timestamp: "${input.value}". Acceptable formats: HH:MM:SS, MM:SS, seconds, or 1h30m.`);
      return;
    }
    seekVideo(secs);
    setStatus(`Seeked to ${formatTime(secs)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Settings
  // ═══════════════════════════════════════════════════════════════════════════

  function loadSettings() {
    chrome.runtime.sendMessage({ action: 'getSettings' }, (resp) => {
      if (resp?.success) {
        currentSettings = { ...getDefaultSettings(), ...resp.settings };
        applySettingsToUI();
      } else {
        currentSettings = getDefaultSettings();
      }
    });
  }

  function getDefaultSettings() {
    return {
      sensitivity: 'medium',
      binSize: 10,
      baselineWindow: 60,
      minPeakDistance: 60,
      leadIn: 20,
      clipStartOffset: 20,
      leadOut: 15,
      topN: 20,
      weights: [0.6, 0.2, 0.2],
      spikeWindow: 45,
      hypeWords: null,
    };
  }

  function applySettingsToUI() {
    const sens = $('#cpc-sensitivity');
    if (sens) {
      const val = { low: 0, medium: 1, high: 2 }[currentSettings.sensitivity] ?? 1;
      sens.value = val;
      updateSensitivityLabel(val);
    }
    setVal('#cpc-adv-bin', currentSettings.binSize);
    setVal('#cpc-adv-baseline', currentSettings.baselineWindow);
    setVal('#cpc-adv-distance', currentSettings.minPeakDistance);
    setVal('#cpc-adv-leadin', currentSettings.leadIn);
    setVal('#cpc-adv-clip-offset', currentSettings.clipStartOffset ?? currentSettings.leadIn ?? 20);
    setVal('#cpc-adv-leadout', currentSettings.leadOut);
    setVal('#cpc-topn-input', currentSettings.topN || 20);
  }

  function setVal(sel, val) {
    const el = $(sel);
    if (el) el.value = val;
  }

  function onSensitivityChange(e) {
    const labels = ['low', 'medium', 'high'];
    const val = parseInt(e.target.value);
    currentSettings.sensitivity = labels[val] || 'medium';
    updateSensitivityLabel(val);
    saveAndRerun();
  }

  function updateSensitivityLabel(val) {
    const labels = ['🔇 Low', '🔊 Medium', '📢 High'];
    const el = $('#cpc-sensitivity-label');
    if (el) el.textContent = labels[val] || labels[1];
  }

  function onAdvancedSettingChange() {
    currentSettings.binSize = parseInt($('#cpc-adv-bin')?.value) || 10;
    currentSettings.baselineWindow = parseInt($('#cpc-adv-baseline')?.value) || 60;
    currentSettings.minPeakDistance = parseInt($('#cpc-adv-distance')?.value) || 60;
    currentSettings.leadIn = parseInt($('#cpc-adv-leadin')?.value) || 20;
    currentSettings.clipStartOffset = parseInt($('#cpc-adv-clip-offset')?.value) || currentSettings.leadIn;
    currentSettings.leadOut = parseInt($('#cpc-adv-leadout')?.value) || 15;
    saveAndRerun();
  }

  function saveAndRerun() {
    chrome.runtime.sendMessage({ action: 'saveSettings', settings: currentSettings });
    if (messages.length > 0 && videoMeta) {
      runDetection();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Analysis flow with custom range
  // ═══════════════════════════════════════════════════════════════════════════

  async function startAnalysis() {
    if (isAnalysing || !currentVideoId) return;

    if (currentAdapter && !currentAdapter.isSupported) {
      finishWithError(currentAdapter.unsupportedMessage || 'This platform is not supported yet, use Import chat file.');
      return;
    }

    // Validate chosen range
    const rangeCheck = getAndValidateRange();
    if (!rangeCheck.valid) {
      finishWithError(rangeCheck.error);
      return;
    }

    activeRange = { start: rangeCheck.startSec, end: rangeCheck.endSec };
    saveCurrentRangeInputs();

    isAnalysing = true;
    showSection('progress');
    updateProgress({ fetched: 0, percent: 0, eta: 0, rangeStart: activeRange.start, rangeEnd: activeRange.end });
    $('#cpc-cancel-btn').style.display = 'inline-block';
    $('#cpc-analyse-btn').disabled = true;

    // Ensure video metadata
    if (!videoMeta || !videoMeta.lengthSeconds) {
      const metaResp = await new Promise(r => chrome.runtime.sendMessage({
        action: 'getVideoMeta',
        videoId: currentVideoId,
        platform: currentPlatform,
        url: location.href,
      }, r));

      if (metaResp?.success && metaResp.meta?.lengthSeconds) {
        videoMeta = metaResp.meta;
      } else {
        videoMeta = {
          id: currentVideoId,
          title: document.title.replace(' - Twitch', '').replace(' - YouTube', ''),
          lengthSeconds: scrapeVodLength() || activeRange.end,
          channel: '',
        };
      }
    }

    if (videoMeta?.hasChatReplay === false) {
      finishWithError('This video has no chat replay.');
      return;
    }

    // Fetch chat for chosen range
    chrome.runtime.sendMessage({
      action: 'fetchChat',
      videoId: currentVideoId,
      platform: currentPlatform,
      url: location.href,
      vodLengthSeconds: videoMeta.lengthSeconds,
      rangeStart: activeRange.start,
      rangeEnd: activeRange.end,
    }, (resp) => {
      if (!resp) {
        finishWithError('No response from background service worker. Try reloading the extension.');
        return;
      }
      if (!resp.success) {
        finishWithError(resp.error || 'Failed to download chat replay.', resp.code);
        return;
      }

      messages = resp.messages;
      if (resp.meta) videoMeta = { ...videoMeta, ...resp.meta };

      if (!messages || messages.length === 0) {
        finishWithError('No chat messages found in the selected range.');
        return;
      }

      runDetection();
    });
  }

  function runDetection() {
    const sensPresets = {
      low:    { zScoreThreshold: 3.0, minMultiplier: 2.5 },
      medium: { zScoreThreshold: 2.0, minMultiplier: 1.8 },
      high:   { zScoreThreshold: 1.3, minMultiplier: 1.4 },
    };

    const opts = {
      ...sensPresets[currentSettings.sensitivity] || sensPresets.medium,
      binSize: currentSettings.binSize || 10,
      baselineWindow: currentSettings.baselineWindow || 60,
      minPeakDistance: currentSettings.minPeakDistance || 60,
      leadIn: currentSettings.leadIn || 20,
      clipStartOffset: currentSettings.clipStartOffset ?? currentSettings.leadIn ?? 20,
      leadOut: currentSettings.leadOut || 15,
      spikeWindow: currentSettings.spikeWindow || 45,
      weights: currentSettings.weights || [0.6, 0.2, 0.2],
      rangeStart: activeRange.start,
      rangeEnd: activeRange.end,
    };

    chrome.runtime.sendMessage({
      action: 'detectPeaks',
      messages,
      vodLengthSeconds: videoMeta.lengthSeconds,
      options: opts,
    }, (resp) => {
      isAnalysing = false;
      $('#cpc-cancel-btn').style.display = 'none';
      $('#cpc-analyse-btn').disabled = false;

      if (!resp?.success) {
        finishWithError(resp?.error || 'Peak detection failed.');
        return;
      }

      peaks = resp.peaks;
      timeline = resp.timeline;

      chrome.runtime.sendMessage({
        action: 'getClipStatuses',
        videoId: currentVideoId,
        platform: currentPlatform,
      }, (cs) => {
        clipStatuses = cs?.statuses || {};
        showSection('results');
        renderSummary();
        renderResults();
        renderTimeline();
      });
    });
  }

  function cancelAnalysis() {
    chrome.runtime.sendMessage({
      action: 'cancelFetch',
      videoId: currentVideoId,
      platform: currentPlatform,
    });
    isAnalysing = false;
    $('#cpc-cancel-btn').style.display = 'none';
    $('#cpc-analyse-btn').disabled = false;
    showSection('idle');
    setStatus('Download cancelled.');
  }

  function finishWithError(msg, code) {
    isAnalysing = false;
    $('#cpc-cancel-btn').style.display = 'none';
    $('#cpc-analyse-btn').disabled = false;
    showSection('error');
    $('#cpc-error-msg').textContent = msg;
    if (code === 'FETCH_ERROR' || code === 'CANCELLED') {
      $('#cpc-error-msg').textContent += ' You can also use the Import option (📂 button above).';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Import handling with range support
  // ═══════════════════════════════════════════════════════════════════════════

  function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    const rangeCheck = getAndValidateRange();
    const rangeStart = rangeCheck.valid ? rangeCheck.startSec : 0;
    const rangeEnd = rangeCheck.valid ? rangeCheck.endSec : null;

    const reader = new FileReader();
    reader.onload = () => {
      chrome.runtime.sendMessage({
        action: 'importChat',
        content: reader.result,
        filename: file.name,
        platform: currentPlatform || 'imported',
        videoId: currentVideoId,
        rangeStart,
        rangeEnd,
      }, (resp) => {
        if (!resp?.success) {
          finishWithError(resp?.error || 'Import failed.');
          return;
        }
        messages = resp.messages;
        videoMeta = resp.meta;
        currentVideoId = videoMeta.id || currentVideoId || 'imported';
        activeRange = {
          start: rangeStart,
          end: rangeEnd || videoMeta.lengthSeconds,
        };
        runDetection();
      });
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Cache
  // ═══════════════════════════════════════════════════════════════════════════

  function clearCache() {
    if (!confirm('Clear cached chat data for this VOD (or all)?')) return;
    chrome.runtime.sendMessage({
      action: 'clearCache',
      videoId: currentVideoId,
      platform: currentPlatform,
    }, () => {
      setStatus('Cache cleared.');
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Progress updates
  // ═══════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'chatProgress' && msg.videoId === currentVideoId) {
      updateProgress(msg);
    }
    if (msg.action === 'command') {
      handleCommand(msg.command);
    }
    if (msg.action === 'getPlaybackInfo') {
      sendResponse({
        currentTime: getCurrentVideoTime(),
        vodLength: videoMeta?.lengthSeconds || scrapeVodLength(),
        platform: currentPlatform,
        videoId: currentVideoId,
      });
      return true;
    }
  });

  function updateProgress(p) {
    const pctBar = $('#cpc-progress-bar');
    const pctText = $('#cpc-progress-text');
    if (pctBar) pctBar.style.width = p.percent + '%';
    if (pctText) {
      const etaStr = p.eta > 0 ? ` · ~${p.eta}s left` : '';
      const rangeStr = (p.rangeStart != null && p.rangeEnd != null)
        ? ` [${formatTime(p.rangeStart)} → ${formatTime(p.rangeEnd)}]`
        : '';
      pctText.textContent = `${p.fetched.toLocaleString()} messages · ${p.percent}% of range${etaStr}${rangeStr}`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Render
  // ═══════════════════════════════════════════════════════════════════════════

  function showSection(name) {
    for (const el of $$('.cpc-section')) {
      el.style.display = el.dataset.section === name ? 'block' : 'none';
    }
  }

  function setStatus(text) {
    const el = $('#cpc-status');
    if (el) el.textContent = text;
  }

  function resetUI() {
    showSection('idle');
    setStatus('');
    const list = $('#cpc-results-list');
    if (list) list.innerHTML = '';
    const chart = $('#cpc-chart');
    if (chart) chart.innerHTML = '';
    const summary = $('#cpc-summary');
    if (summary) summary.textContent = '';
    $('#cpc-analyse-btn').disabled = false;
    $('#cpc-cancel-btn').style.display = 'none';
  }

  function renderSummary() {
    const rangeSpan = formatDuration(activeRange.end - activeRange.start);
    const rangeStr = `${formatTime(activeRange.start)} → ${formatTime(activeRange.end)}`;
    const el = $('#cpc-summary');
    if (el) {
      el.textContent = `Found ${peaks.length} peak${peaks.length !== 1 ? 's' : ''} in ${rangeSpan} (${rangeStr}) · ${messages.length.toLocaleString()} messages analysed`;
    }
  }

  function renderResults() {
    const list = $('#cpc-results-list');
    if (!list) return;
    list.innerHTML = '';

    const topN = currentSettings.topN || 0;
    const display = topN > 0 ? peaks.slice(0, topN) : peaks;

    if (display.length === 0) {
      list.innerHTML = `<div style="text-align:center;padding:16px;color:#888;">No qualifying peaks detected in this range. Try increasing sensitivity or widening the range.</div>`;
      return;
    }

    for (const peak of display) {
      const status = clipStatuses[peak.peakTime] || '';
      const row = document.createElement('div');
      row.className = `cpc-peak-row tier-${peak.tier}${status ? ' status-' + status : ''}`;
      row.dataset.peakTime = peak.peakTime;
      row.innerHTML = `
        <div class="cpc-peak-header">
          <span class="cpc-rank">#${peak.rank}</span>
          <span class="cpc-timestamp" title="Click to seek to peak">${peak.peakTimestamp}</span>
          <span class="cpc-score">${peak.score}</span>
          <span class="cpc-tier-badge">${peak.tier.toUpperCase()}</span>
        </div>
        <div class="cpc-peak-details">
          <div class="cpc-metrics">
            <span>📊 ${peak.messagesPerMin} msg/min</span>
            <span>📈 ${peak.multiplier}x above normal</span>
            <span>⚡ z=${peak.zScore}</span>
          </div>
          <div class="cpc-clip-window">
            🎬 Suggested Clip: <strong>${peak.clipStartTS}</strong> → <strong>${peak.clipEndTS}</strong>
          </div>
          <div class="cpc-top-words">
            ${peak.topWords.map(w => `<span class="cpc-word">${escapeHtml(w.word)} <small>(${w.count})</small></span>`).join(' ')}
          </div>
          <div class="cpc-samples">
            ${peak.sampleMsgs.map(m => `<div class="cpc-sample"><strong>${escapeHtml(m.user)}:</strong> ${escapeHtml(m.text)}</div>`).join('')}
          </div>
          <div class="cpc-actions">
            <button class="cpc-btn cpc-seek-btn" data-time="${peak.clipStart}" title="Seek video to suggested clip start">▶ Seek Clip (${peak.clipStartTS})</button>
            <button class="cpc-btn cpc-copy-ts-btn" data-ts="${peak.peakTimestamp}" title="Copy peak timestamp">📋</button>
            <button class="cpc-btn cpc-open-btn" data-time="${peak.clipStart}" title="Open VOD at this moment in new tab">🔗</button>
            <button class="cpc-btn cpc-status-btn" data-pt="${peak.peakTime}" data-status="clipped" title="Mark as clipped">${status === 'clipped' ? '✅' : '🎬'}</button>
            <button class="cpc-btn cpc-status-btn" data-pt="${peak.peakTime}" data-status="skipped" title="Mark as skipped">${status === 'skipped' ? '⏭️' : '⏩'}</button>
          </div>
        </div>
      `;
      list.appendChild(row);
    }

    list.onclick = (e) => {
      const btn = e.target.closest('button');
      if (!btn) {
        const ts = e.target.closest('.cpc-timestamp');
        if (ts) {
          const row = ts.closest('.cpc-peak-row');
          seekVideo(parseFloat(row.dataset.peakTime));
        }
        return;
      }

      if (btn.classList.contains('cpc-seek-btn')) {
        seekVideo(parseFloat(btn.dataset.time));
      } else if (btn.classList.contains('cpc-copy-ts-btn')) {
        navigator.clipboard.writeText(btn.dataset.ts).then(() => {
          btn.textContent = '✓';
          setTimeout(() => btn.textContent = '📋', 1500);
        });
      } else if (btn.classList.contains('cpc-open-btn')) {
        const secs = parseFloat(btn.dataset.time);
        window.open(getVodTimestampUrl(currentPlatform, currentVideoId, secs), '_blank');
      } else if (btn.classList.contains('cpc-status-btn')) {
        const pt = parseInt(btn.dataset.pt);
        const newStatus = btn.dataset.status;
        const current = clipStatuses[pt];
        const finalStatus = current === newStatus ? null : newStatus;
        clipStatuses[pt] = finalStatus;
        chrome.runtime.sendMessage({
          action: 'setClipStatus',
          videoId: currentVideoId,
          platform: currentPlatform,
          peakTime: pt,
          status: finalStatus,
        });
        renderResults();
      }
    };

    const showAllBtn = $('#cpc-show-all-btn');
    if (showAllBtn) {
      showAllBtn.style.display = (topN > 0 && peaks.length > topN) ? 'inline-block' : 'none';
      if (peaks.length > topN) {
        showAllBtn.textContent = `Show all ${peaks.length} peaks`;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Timeline chart (SVG with range highlighting & greyed out unanalyzed)
  // ═══════════════════════════════════════════════════════════════════════════

  function renderTimeline() {
    const container = $('#cpc-chart');
    if (!container || !timeline) return;
    container.innerHTML = '';

    const W = 480, H = 105, PAD_L = 0, PAD_R = 0, PAD_T = 6, PAD_B = 16;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    const maxVal = Math.max(1, ...(timeline.smoothedCounts || [1]));
    const totalTime = videoMeta.lengthSeconds || (timeline.times.length > 0 ? timeline.times[timeline.times.length - 1] : 3600);

    const toX = (t) => Math.min(W, Math.max(0, PAD_L + (t / totalTime) * plotW));
    const toY = (v) => PAD_T + plotH - (v / maxVal) * plotH;

    // Activity line & fill
    let activityPath = '';
    for (let i = 0; i < timeline.times.length; i++) {
      const x = toX(timeline.times[i]);
      const y = toY(timeline.smoothedCounts[i]);
      activityPath += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    }

    let baselinePath = '';
    for (let i = 0; i < timeline.times.length; i++) {
      const x = toX(timeline.times[i]);
      const y = toY(timeline.baseline[i]);
      baselinePath += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    }

    const fillPath = activityPath && timeline.times.length > 0 ? (
      activityPath +
      `L${toX(timeline.times[timeline.times.length - 1]).toFixed(1)},${(PAD_T + plotH).toFixed(1)}` +
      `L${toX(timeline.times[0]).toFixed(1)},${(PAD_T + plotH).toFixed(1)}Z`
    ) : '';

    // Grey-out overlays for unanalyzed range
    let greyOuts = '';
    const rStart = activeRange.start;
    const rEnd = activeRange.end;

    if (rStart > 0) {
      const x1 = toX(0);
      const x2 = toX(rStart);
      greyOuts += `
        <rect x="${x1.toFixed(1)}" y="${PAD_T}" width="${(x2 - x1).toFixed(1)}" height="${plotH}" fill="rgba(10,10,14,0.72)"/>
        <line x1="${x2.toFixed(1)}" y1="${PAD_T}" x2="${x2.toFixed(1)}" y2="${PAD_T + plotH}" stroke="#888" stroke-dasharray="3,2" stroke-width="1.2"/>
        <text x="${(x2 - 3).toFixed(1)}" y="${PAD_T + 11}" fill="#888" font-size="8" text-anchor="end">Start</text>
      `;
    }

    if (rEnd < totalTime) {
      const x1 = toX(rEnd);
      const x2 = toX(totalTime);
      greyOuts += `
        <rect x="${x1.toFixed(1)}" y="${PAD_T}" width="${(x2 - x1).toFixed(1)}" height="${plotH}" fill="rgba(10,10,14,0.72)"/>
        <line x1="${x1.toFixed(1)}" y1="${PAD_T}" x2="${x1.toFixed(1)}" y2="${PAD_T + plotH}" stroke="#888" stroke-dasharray="3,2" stroke-width="1.2"/>
        <text x="${(x1 + 3).toFixed(1)}" y="${PAD_T + 11}" fill="#888" font-size="8" text-anchor="start">End</text>
      `;
    }

    // Peak markers
    let peakMarkers = '';
    for (const p of peaks) {
      const x = toX(p.peakTime);
      const color = p.tier === 'hot' ? '#ff4444' : p.tier === 'good' ? '#ffaa00' : '#9147ff';
      peakMarkers += `<line x1="${x.toFixed(1)}" y1="${PAD_T}" x2="${x.toFixed(1)}" y2="${PAD_T + plotH}" stroke="${color}" stroke-width="1.5" opacity="0.8"/>`;
      peakMarkers += `<circle cx="${x.toFixed(1)}" cy="${PAD_T + 2}" r="3.5" fill="${color}" class="cpc-peak-marker" data-time="${p.clipStart}"/>`;
    }

    // Time axis ticks
    const labelInterval = totalTime > 14400 ? 3600 : totalTime > 3600 ? 1800 : 600;
    let labels = '';
    for (let t = 0; t <= totalTime; t += labelInterval) {
      const x = toX(t);
      labels += `<text x="${x.toFixed(1)}" y="${H - 2}" fill="#777" font-size="9" text-anchor="middle">${formatDuration(t)}</text>`;
    }

    const svg = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="cursor:crosshair">
        ${fillPath ? `<path d="${fillPath}" fill="rgba(145,71,255,0.2)"/>` : ''}
        ${activityPath ? `<path d="${activityPath}" fill="none" stroke="#9147ff" stroke-width="1.3"/>` : ''}
        ${baselinePath ? `<path d="${baselinePath}" fill="none" stroke="#444" stroke-width="0.8" stroke-dasharray="3,3"/>` : ''}
        ${greyOuts}
        ${peakMarkers}
        ${labels}
      </svg>
    `;
    container.innerHTML = svg;

    container.querySelector('svg').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, relX / rect.width));
      const seekTime = pct * totalTime;
      seekVideo(Math.round(seekTime));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Video seeking
  // ═══════════════════════════════════════════════════════════════════════════

  function seekVideo(seconds) {
    if (currentAdapter && typeof currentAdapter.seek === 'function') {
      currentAdapter.seek(seconds, currentVideoId);
      return;
    }
    const video = document.querySelector('video');
    if (video) {
      try {
        video.currentTime = seconds;
        video.play().catch(() => {});
        return;
      } catch (e) {}
    }
    window.location.href = getVodTimestampUrl(currentPlatform, currentVideoId, seconds);
  }

  function formatTwitchTime(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.round(secs % 60);
    let parts = [];
    if (h > 0) parts.push(h + 'h');
    if (m > 0) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join('');
  }

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function formatDuration(secs) {
    const s = Math.max(0, Math.round(secs));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function parseTimestamp(input) {
    if (input == null) return null;
    const str = String(input).trim();
    if (!str) return null;

    if (/^\d+(?:\.\d+)?$/.test(str)) {
      const val = parseFloat(str);
      return isNaN(val) || val < 0 ? null : val;
    }

    const twitchRegex = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/i;
    const twitchMatch = str.match(twitchRegex);
    if (twitchMatch && (twitchMatch[1] != null || twitchMatch[2] != null || twitchMatch[3] != null)) {
      const h = parseInt(twitchMatch[1] || '0', 10);
      const m = parseInt(twitchMatch[2] || '0', 10);
      const s = parseFloat(twitchMatch[3] || '0');
      const total = h * 3600 + m * 60 + s;
      return isNaN(total) || total < 0 ? null : total;
    }

    if (/^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.test(str)) {
      const parts = str.split(':').map(Number);
      if (parts.some(p => isNaN(p) || p < 0)) return null;
      if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
      } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
      }
    }

    return null;
  }

  function scrapeVodLength() {
    if (currentAdapter && typeof currentAdapter.getVideoDuration === 'function') {
      const d = currentAdapter.getVideoDuration();
      if (d > 0) return Math.floor(d);
    }
    const el = document.querySelector('[data-a-target="player-seekbar-duration"]');
    if (el) {
      const parts = el.textContent.trim().split(':').map(Number);
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
    }
    const video = document.querySelector('video');
    if (video && video.duration && !isNaN(video.duration) && isFinite(video.duration)) {
      return Math.round(video.duration);
    }
    return 0;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Export functions
  // ═══════════════════════════════════════════════════════════════════════════

  function copyTimestamps() {
    if (peaks.length === 0) return;
    const text = peaks.map(p =>
      `#${p.rank} ${p.peakTimestamp} (${p.multiplier}x, ${p.tier}) — ${p.topWords.map(w => w.word).join(', ')}`
    ).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      const btn = $('#cpc-copy-btn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => btn.textContent = '📋 Copy All', 2000);
    });
  }

  function downloadCSV() {
    if (peaks.length === 0) return;
    const header = 'Rank,Peak Time,Clip Start,Clip End,Score,Msgs/min,Multiplier,Tier,Top Words,Sample Message';
    const rows = peaks.map(p => {
      const topWords = p.topWords.map(w => w.word).join('; ');
      const sample = (p.sampleMsgs[0]?.text || '').replace(/"/g, '""');
      return [p.rank, p.peakTimestamp, p.clipStartTS, p.clipEndTS, p.score, p.messagesPerMin,
        p.multiplier + 'x', p.tier, `"${topWords}"`, `"${sample}"`].join(',');
    });
    const csv = [header, ...rows].join('\n');
    downloadBlob(csv, `chatpeak-${currentVideoId}-${activeRange.start}-${activeRange.end}.csv`, 'text/csv');
  }

  function downloadJSON() {
    if (peaks.length === 0) return;
    const json = JSON.stringify({
      exportedAt: new Date().toISOString(),
      video: videoMeta,
      range: activeRange,
      peaks,
    }, null, 2);
    downloadBlob(json, `chatpeak-${currentVideoId}-${activeRange.start}-${activeRange.end}.json`, 'application/json');
  }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Keyboard commands
  // ═══════════════════════════════════════════════════════════════════════════

  function handleCommand(cmd) {
    if (cmd === 'toggle-panel') {
      if (panelRoot) toggleCollapse();
    } else if (cmd === 'next-peak') {
      if (peaks.length > 0) {
        selectedPeakIdx = Math.min(selectedPeakIdx + 1, peaks.length - 1);
        seekVideo(peaks[selectedPeakIdx].clipStart);
        highlightPeakRow(selectedPeakIdx);
      }
    } else if (cmd === 'prev-peak') {
      if (peaks.length > 0) {
        selectedPeakIdx = Math.max(selectedPeakIdx - 1, 0);
        seekVideo(peaks[selectedPeakIdx].clipStart);
        highlightPeakRow(selectedPeakIdx);
      }
    }
  }

  function highlightPeakRow(idx) {
    for (const r of $$('.cpc-peak-row')) r.classList.remove('selected');
    const rows = $$('.cpc-peak-row');
    if (rows[idx]) {
      rows[idx].classList.add('selected');
      rows[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CSS (injected into Shadow DOM)
  // ═══════════════════════════════════════════════════════════════════════════

  const CSS_TEXT = `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    #cpc-panel {
      position: fixed;
      top: 80px;
      left: 20px;
      width: 530px;
      max-height: 88vh;
      background: #0e0e10;
      border: 1px solid #2f2f35;
      border-radius: 10px;
      font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 13px;
      color: #efeff1;
      overflow: hidden;
      box-shadow: 0 10px 36px rgba(0,0,0,0.7);
      display: flex;
      flex-direction: column;
      z-index: 999999;
    }

    #cpc-panel.collapsed #cpc-body { display: none; }
    #cpc-panel.collapsed { max-height: 42px; }

    #cpc-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: #18181b;
      border-bottom: 1px solid #2f2f35;
      cursor: grab;
      user-select: none;
      border-radius: 10px 10px 0 0;
    }
    #cpc-header:active { cursor: grabbing; }
    .cpc-logo { font-size: 16px; }
    .cpc-title { flex: 1; font-weight: 600; font-size: 14px; color: #bf94ff; }
    .cpc-platform-badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 7px;
      border-radius: 10px;
      margin-left: 6px;
      display: inline-block;
      vertical-align: middle;
    }
    .cpc-badge-twitch {
      background: #9146ff;
      color: #ffffff;
    }
    .cpc-badge-youtube {
      background: #ff0000;
      color: #ffffff;
    }
    .cpc-badge-imported {
      background: #3b82f6;
      color: #ffffff;
    }

    #cpc-header button {
      background: none; border: none; color: #adadb8; cursor: pointer;
      font-size: 14px; padding: 2px 6px; border-radius: 4px;
    }
    #cpc-header button:hover { background: #2f2f35; color: #efeff1; }

    #cpc-body {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      max-height: calc(88vh - 42px);
      padding: 10px 12px;
      gap: 10px;
    }

    /* ── Range Box ── */
    .cpc-range-box {
      background: #18181b;
      border: 1px solid #26262c;
      border-radius: 8px;
      padding: 9px 11px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .cpc-range-row {
      display: flex;
      gap: 10px;
    }
    .cpc-range-field {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .cpc-range-field label {
      font-size: 11px;
      color: #adadb8;
      font-weight: 500;
    }
    .cpc-input-btn-group {
      display: flex;
      gap: 4px;
    }
    .cpc-input-btn-group input {
      flex: 1;
      background: #0e0e10;
      border: 1px solid #333339;
      color: #efeff1;
      padding: 5px 8px;
      border-radius: 5px;
      font-size: 12px;
      font-family: 'Consolas', monospace;
      min-width: 0;
    }
    .cpc-input-btn-group input:focus {
      outline: none;
      border-color: #9147ff;
    }

    .cpc-presets-row {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
    }
    .cpc-preset-lbl {
      font-size: 11px;
      color: #888;
      margin-right: 2px;
    }

    /* ── Jump row ── */
    .cpc-jump-row {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #141417;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 11px;
      color: #adadb8;
    }
    .cpc-jump-row input {
      flex: 1;
      background: #0e0e10;
      border: 1px solid #2f2f35;
      color: #efeff1;
      padding: 4px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-family: 'Consolas', monospace;
    }
    .cpc-jump-row input:focus {
      outline: none;
      border-color: #9147ff;
    }

    /* ── Toolbar ── */
    .cpc-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }

    /* ── Buttons ── */
    .cpc-btn {
      padding: 6px 12px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.15s;
      color: #fff;
    }
    .cpc-btn:hover { filter: brightness(1.15); }
    .cpc-btn:active { transform: scale(0.97); }
    .cpc-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .cpc-btn-primary { background: #9147ff; font-weight: 600; }
    .cpc-btn-primary:hover { background: #a970ff; }
    .cpc-btn-secondary { background: #2f2f35; color: #adadb8; }
    .cpc-btn-secondary:hover { background: #3f3f45; color: #efeff1; }
    .cpc-btn-danger { background: #c83232; }

    .cpc-btn-sm { padding: 4px 8px; font-size: 11px; }
    .cpc-btn-xs { padding: 2px 7px; font-size: 10px; border-radius: 4px; background: #24242a; color: #bf94ff; }
    .cpc-btn-xs:hover { background: #34343d; color: #fff; }
    .cpc-btn-icon { padding: 4px 8px; font-size: 12px; }

    .cpc-section { display: none; }

    /* ── Progress ── */
    .cpc-progress-wrap {
      background: #18181b;
      border-radius: 8px;
      padding: 10px;
    }
    .cpc-progress-track {
      width: 100%;
      height: 6px;
      background: #2f2f35;
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 6px;
    }
    .cpc-progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #9147ff, #bf94ff);
      border-radius: 3px;
      transition: width 0.3s;
      width: 0%;
    }
    .cpc-progress-text {
      font-size: 11px;
      color: #adadb8;
    }

    #cpc-summary {
      font-size: 12px;
      color: #adadb8;
      padding: 4px 0;
      line-height: 1.4;
    }

    /* ── Sensitivity ── */
    .cpc-sensitivity-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    .cpc-sensitivity-row input[type=range] {
      flex: 1;
      accent-color: #9147ff;
    }
    #cpc-sensitivity-label {
      min-width: 80px;
      text-align: right;
      color: #bf94ff;
    }

    /* ── Chart ── */
    #cpc-chart {
      background: #18181b;
      border-radius: 8px;
      padding: 6px;
      cursor: crosshair;
    }
    #cpc-chart svg { display: block; }

    /* ── Results list ── */
    #cpc-results-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 380px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .cpc-peak-row {
      background: #18181b;
      border-radius: 8px;
      padding: 8px 10px;
      border-left: 3px solid #555;
      transition: all 0.15s;
    }
    .cpc-peak-row:hover { background: #1f1f23; }
    .cpc-peak-row.selected { outline: 2px solid #9147ff; }

    .cpc-peak-row.tier-hot { border-left-color: #ff4444; }
    .cpc-peak-row.tier-good { border-left-color: #ffaa00; }
    .cpc-peak-row.tier-okay { border-left-color: #9147ff; }

    .cpc-peak-row.status-clipped { opacity: 0.5; }
    .cpc-peak-row.status-skipped { opacity: 0.35; }

    .cpc-peak-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .cpc-rank {
      font-weight: 700;
      color: #bf94ff;
      min-width: 28px;
    }
    .cpc-timestamp {
      font-family: 'Consolas', 'Menlo', monospace;
      font-size: 14px;
      font-weight: 600;
      color: #efeff1;
      cursor: pointer;
      text-decoration: underline dotted #555;
    }
    .cpc-timestamp:hover { color: #bf94ff; }
    .cpc-score { margin-left: auto; font-size: 11px; color: #adadb8; }
    .cpc-tier-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 700;
    }
    .tier-hot .cpc-tier-badge { background: #ff444433; color: #ff6666; }
    .tier-good .cpc-tier-badge { background: #ffaa0033; color: #ffcc44; }
    .tier-okay .cpc-tier-badge { background: #9147ff33; color: #bf94ff; }

    .cpc-peak-details { font-size: 11px; color: #adadb8; }
    .cpc-metrics { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 3px; }
    .cpc-clip-window { margin-bottom: 4px; color: #aaa; }
    .cpc-clip-window strong { color: #efeff1; }
    .cpc-top-words { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
    .cpc-word {
      background: #2f2f35;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 11px;
    }
    .cpc-samples {
      margin-bottom: 4px;
      border-left: 2px solid #2f2f35;
      padding-left: 8px;
    }
    .cpc-sample {
      font-size: 11px;
      color: #888;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 450px;
      margin-bottom: 2px;
    }
    .cpc-actions {
      display: flex;
      gap: 4px;
      margin-top: 4px;
      flex-wrap: wrap;
    }
    .cpc-actions .cpc-btn {
      padding: 3px 8px;
      font-size: 11px;
      background: #2f2f35;
      color: #adadb8;
    }
    .cpc-actions .cpc-btn:hover { background: #3f3f45; color: #efeff1; }

    /* ── Settings panel ── */
    #cpc-settings-panel {
      display: none;
      background: #18181b;
      border-radius: 8px;
      padding: 10px;
    }
    #cpc-settings-panel.open { display: block; }
    .cpc-settings-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px 12px;
      font-size: 11px;
    }
    .cpc-settings-grid label { color: #adadb8; display: flex; flex-direction: column; gap: 2px; }
    .cpc-settings-grid input {
      background: #0e0e10;
      border: 1px solid #2f2f35;
      color: #efeff1;
      padding: 4px 6px;
      border-radius: 4px;
      font-size: 12px;
      width: 100%;
    }

    #cpc-error-msg {
      color: #ff6666;
      font-size: 12px;
      padding: 10px;
      background: #2a1515;
      border-radius: 8px;
      line-height: 1.4;
    }

    #cpc-status {
      font-size: 11px;
      color: #888;
    }

    .cpc-export-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    #cpc-file-input { display: none; }

    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #3f3f45; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #555; }
  `;

  // ═══════════════════════════════════════════════════════════════════════════
  //  Panel HTML
  // ═══════════════════════════════════════════════════════════════════════════

  const PANEL_HTML = `
    <div id="cpc-header">
      <span class="cpc-logo">📈</span>
      <span class="cpc-title">ChatPeak Clipper</span>
      <span id="cpc-platform-badge" class="cpc-platform-badge cpc-badge-twitch">Twitch</span>
      <button id="cpc-settings-toggle" title="Settings">⚙️</button>
      <button id="cpc-collapse-btn" title="Collapse/Expand">▼</button>
    </div>

    <div id="cpc-body">
      <!-- Custom Analysis Range -->
      <div class="cpc-range-box">
        <div class="cpc-range-row">
          <div class="cpc-range-field">
            <label for="cpc-start-time">Start Time</label>
            <div class="cpc-input-btn-group">
              <input type="text" id="cpc-start-time" placeholder="00:00:00" value="00:00:00" title="Formats: HH:MM:SS, MM:SS, seconds, or 1h30m">
              <button id="cpc-start-curr-btn" class="cpc-btn cpc-btn-secondary cpc-btn-icon" title="Use current video time">📍</button>
            </div>
          </div>
          <div class="cpc-range-field">
            <label for="cpc-end-time">End Time</label>
            <div class="cpc-input-btn-group">
              <input type="text" id="cpc-end-time" placeholder="00:00:00" value="00:00:00" title="Formats: HH:MM:SS, MM:SS, seconds, or 1h30m">
              <button id="cpc-end-curr-btn" class="cpc-btn cpc-btn-secondary cpc-btn-icon" title="Use current video time">📍</button>
            </div>
          </div>
        </div>

        <div class="cpc-presets-row">
          <span class="cpc-preset-lbl">Presets:</span>
          <button class="cpc-btn cpc-preset-btn" data-preset="last-1h">Last 1 hour</button>
          <button class="cpc-btn cpc-preset-btn" data-preset="last-2h">Last 2 hours</button>
          <button class="cpc-btn cpc-preset-btn" data-preset="first-2h">First 2 hours</button>
          <button class="cpc-btn cpc-preset-btn" data-preset="full">Full VOD</button>
        </div>
      </div>

      <!-- Jump to Timestamp -->
      <div class="cpc-jump-row">
        <span>Jump to time:</span>
        <input type="text" id="cpc-jump-input" placeholder="e.g. 1h20m / 45:00 / 5400">
        <button id="cpc-jump-btn" class="cpc-btn cpc-btn-secondary cpc-btn-sm">Seek</button>
      </div>

      <!-- Toolbar -->
      <div class="cpc-toolbar">
        <button id="cpc-analyse-btn" class="cpc-btn cpc-btn-primary">🔍 Analyze Chat</button>
        <button id="cpc-cancel-btn" class="cpc-btn cpc-btn-danger cpc-btn-sm" style="display:none">✕ Cancel</button>
        <button id="cpc-import-btn" class="cpc-btn cpc-btn-secondary cpc-btn-sm" title="Import chat file (JSON/CSV) for this range">📂 Import</button>
        <button id="cpc-clear-cache-btn" class="cpc-btn cpc-btn-secondary cpc-btn-sm" title="Clear cached chat data">🗑️ Cache</button>
        <input type="file" id="cpc-file-input" accept=".json,.csv,.txt">
      </div>

      <!-- Sensitivity -->
      <div class="cpc-sensitivity-row">
        <span>Sensitivity:</span>
        <input type="range" id="cpc-sensitivity" min="0" max="2" step="1" value="1">
        <span id="cpc-sensitivity-label">🔊 Medium</span>
      </div>

      <!-- Settings (collapsible) -->
      <div id="cpc-settings-panel">
        <div class="cpc-settings-grid">
          <label>Clip start offset (s) <input type="number" id="cpc-adv-clip-offset" class="cpc-adv-input" value="20" min="0" max="120"></label>
          <label>Bin size (s) <input type="number" id="cpc-adv-bin" class="cpc-adv-input" value="10" min="5" max="60"></label>
          <label>Baseline window (bins) <input type="number" id="cpc-adv-baseline" class="cpc-adv-input" value="60" min="10" max="200"></label>
          <label>Min peak distance (s) <input type="number" id="cpc-adv-distance" class="cpc-adv-input" value="60" min="10" max="300"></label>
          <label>Lead-in (s) <input type="number" id="cpc-adv-leadin" class="cpc-adv-input" value="20" min="5" max="60"></label>
          <label>Lead-out (s) <input type="number" id="cpc-adv-leadout" class="cpc-adv-input" value="15" min="5" max="60"></label>
          <label>Show top N <input type="number" id="cpc-topn-input" value="20" min="0" max="500"></label>
        </div>
      </div>

      <!-- Progress section -->
      <div class="cpc-section" data-section="progress">
        <div class="cpc-progress-wrap">
          <div class="cpc-progress-track">
            <div class="cpc-progress-fill" id="cpc-progress-bar"></div>
          </div>
          <div class="cpc-progress-text" id="cpc-progress-text">Preparing...</div>
        </div>
      </div>

      <!-- Error section -->
      <div class="cpc-section" data-section="error">
        <div id="cpc-error-msg"></div>
      </div>

      <!-- Results section -->
      <div class="cpc-section" data-section="results">
        <div id="cpc-summary"></div>
        <div id="cpc-chart"></div>
        <div class="cpc-export-row">
          <button id="cpc-copy-btn" class="cpc-btn cpc-btn-secondary cpc-btn-sm">📋 Copy All</button>
          <button id="cpc-csv-btn" class="cpc-btn cpc-btn-secondary cpc-btn-sm">📄 CSV</button>
          <button id="cpc-json-btn" class="cpc-btn cpc-btn-secondary cpc-btn-sm">📦 JSON</button>
          <button id="cpc-show-all-btn" class="cpc-btn cpc-btn-secondary cpc-btn-sm" style="display:none">Show all</button>
        </div>
        <div id="cpc-results-list"></div>
      </div>

      <!-- Idle section -->
      <div class="cpc-section" data-section="idle" style="display:block">
        <div id="cpc-status" style="text-align:center;padding:12px;color:#888;">
          Select a time range above and click "Analyze Chat" to find viral peaks.
        </div>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════════════
  //  Popup integration
  // ═══════════════════════════════════════════════════════════════════════════

  window.addEventListener('chatpeak-analyse', (e) => {
    if (!currentVideoId) {
      onNavigate();
    }
    if (currentVideoId) {
      ensurePanel();
      if (e?.detail?.startStr) {
        if ($('#cpc-start-time')) $('#cpc-start-time').value = e.detail.startStr;
      }
      if (e?.detail?.endStr) {
        if ($('#cpc-end-time')) $('#cpc-end-time').value = e.detail.endStr;
      }
      startAnalysis();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Bootstrap
  // ═══════════════════════════════════════════════════════════════════════════

  onNavigate();

})();
