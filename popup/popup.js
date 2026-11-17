/**
 * popup.js — Toolbar popup for ChatPeak Clipper.
 *
 * Supports Twitch VODs and YouTube past live streams with chat replay.
 * Provides custom range controls (start/end timestamps), presets,
 * current video time capture, jump to timestamp, and analysis triggering.
 *
 * @author Harsh
 */

'use strict';

const statusEl = document.getElementById('status');
const startInput = document.getElementById('start-time');
const endInput = document.getElementById('end-time');
const jumpInput = document.getElementById('jump-input');
const fileInput = document.getElementById('file-input');
const platformBadge = document.getElementById('platform-badge');
const analyseBtn = document.getElementById('analyse-btn');

let currentTabId = null;
let currentVideoId = null;
let currentPlatform = 'twitch';
let currentAdapter = null;
let vodLength = 0;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'status error' : 'status';
}

function updatePlatformBadge(name) {
  if (!platformBadge) return;
  platformBadge.className = 'platform-badge';
  if (name === 'youtube') {
    platformBadge.textContent = 'YouTube';
    platformBadge.classList.add('badge-youtube');
  } else if (name === 'twitch') {
    platformBadge.textContent = 'Twitch';
    platformBadge.classList.add('badge-twitch');
  } else {
    platformBadge.textContent = 'Unsupported';
    platformBadge.classList.add('badge-none');
  }
}

function parseTime(str) {
  if (typeof PeakDetector !== 'undefined' && PeakDetector.parseTimestamp) {
    return PeakDetector.parseTimestamp(str);
  }
  if (!str) return null;
  const s = String(str).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const m = s.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i);
  if (m && (m[1] || m[2] || m[3])) {
    return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
  }
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ── Initialize popup with active tab VOD info ──
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0] || !tabs[0].url) {
    setStatus('No active tab.');
    updatePlatformBadge('none');
    return;
  }
  const tab = tabs[0];
  currentTabId = tab.id;

  const adapter = (typeof Adapters !== 'undefined' && Adapters.getAdapterForUrl)
    ? Adapters.getAdapterForUrl(tab.url)
    : null;

  if (!adapter) {
    updatePlatformBadge('none');
    setStatus('Open a Twitch VOD or YouTube past livestream.');
    analyseBtn.disabled = true;
    return;
  }

  currentAdapter = adapter;
  currentPlatform = adapter.name;
  currentVideoId = adapter.getVideoId(tab.url);
  updatePlatformBadge(currentPlatform);

  if (!currentVideoId) {
    setStatus(`Open a video on ${adapter.displayName}.`);
    analyseBtn.disabled = true;
    return;
  }

  // Request playback info and length from content script
  chrome.tabs.sendMessage(currentTabId, { action: 'getPlaybackInfo' }, (resp) => {
    if (resp?.vodLength) {
      vodLength = resp.vodLength;
    }

    // Check for saved last range
    chrome.runtime.sendMessage({
      action: 'getLastRange',
      videoId: currentVideoId,
      platform: currentPlatform,
    }, (rangeResp) => {
      const last = rangeResp?.range;
      if (last?.startStr && last?.endStr) {
        startInput.value = last.startStr;
        endInput.value = last.endStr;
      } else {
        startInput.value = '00:00:00';
        endInput.value = vodLength > 0 ? formatTime(vodLength) : '02:00:00';
      }
      setStatus(`${adapter.displayName} VOD #${currentVideoId} (${formatTime(vodLength)})`);
    });
  });
});

// ── Use Current Video Time buttons ──
document.getElementById('start-curr-btn').addEventListener('click', () => {
  if (!currentTabId) return;
  chrome.tabs.sendMessage(currentTabId, { action: 'getPlaybackInfo' }, (resp) => {
    if (resp?.currentTime != null) {
      startInput.value = formatTime(resp.currentTime);
      saveRange();
    }
  });
});

document.getElementById('end-curr-btn').addEventListener('click', () => {
  if (!currentTabId) return;
  chrome.tabs.sendMessage(currentTabId, { action: 'getPlaybackInfo' }, (resp) => {
    if (resp?.currentTime != null) {
      endInput.value = formatTime(resp.currentTime);
      saveRange();
    }
  });
});

function saveRange() {
  if (!currentVideoId) return;
  chrome.runtime.sendMessage({
    action: 'saveLastRange',
    videoId: currentVideoId,
    platform: currentPlatform,
    range: { startStr: startInput.value, endStr: endInput.value },
  });
}

startInput.addEventListener('change', saveRange);
endInput.addEventListener('change', saveRange);

// ── Presets ──
const presetButtons = document.querySelectorAll('.btn-preset[data-preset]');
for (const btn of presetButtons) {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.preset;
    const len = vodLength > 0 ? vodLength : 7200;
    let s = 0, e = len;

    switch (preset) {
      case 'last-1h':
        s = Math.max(0, len - 3600);
        e = len;
        break;
      case 'last-2h':
        s = Math.max(0, len - 7200);
        e = len;
        break;
      case 'first-2h':
        s = 0;
        e = Math.min(len, 7200);
        break;
      case 'full':
      default:
        s = 0;
        e = len;
        break;
    }

    startInput.value = formatTime(s);
    endInput.value = formatTime(e);
    saveRange();
  });
}

// ── Jump to Timestamp ──
document.getElementById('jump-btn').addEventListener('click', doJump);
jumpInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doJump();
});

function doJump() {
  const val = jumpInput.value.trim();
  if (!val) return;
  const secs = parseTime(val);
  if (secs === null) {
    setStatus(`Invalid time: "${val}"`, true);
    return;
  }
  if (!currentTabId) {
    setStatus('No active tab.', true);
    return;
  }
  chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    func: (targetSecs) => {
      const moviePlayer = document.getElementById('movie_player');
      if (moviePlayer && typeof moviePlayer.seekTo === 'function') {
        moviePlayer.seekTo(targetSecs, true);
        return;
      }
      const v = document.querySelector('video');
      if (v) {
        v.currentTime = targetSecs;
        v.play().catch(() => {});
      }
    },
    args: [secs],
  }).then(() => {
    setStatus(`Seeked to ${formatTime(secs)}`);
  }).catch(err => {
    setStatus('Could not seek video: ' + err.message, true);
  });
}

// ── Range Validation ──
function validateRange() {
  const sStr = startInput.value.trim();
  const eStr = endInput.value.trim();

  const sSec = parseTime(sStr);
  const eSec = parseTime(eStr);

  if (sSec === null) {
    return { valid: false, error: `Invalid start time: "${sStr}". Use HH:MM:SS, MM:SS, seconds, or 1h30m.` };
  }
  if (eSec === null) {
    return { valid: false, error: `Invalid end time: "${eStr}". Use HH:MM:SS, MM:SS, seconds, or 1h30m.` };
  }
  if (sSec < 0) {
    return { valid: false, error: 'Start time cannot be negative.' };
  }
  if (sSec >= eSec) {
    return { valid: false, error: `Start time (${formatTime(sSec)}) must be before end time (${formatTime(eSec)}).` };
  }
  if (vodLength > 0 && sSec > vodLength) {
    return { valid: false, error: `Start time exceeds VOD length (${formatTime(vodLength)}).` };
  }

  return { valid: true, startSec: sSec, endSec: eSec, startStr: sStr, endStr: eStr };
}

// ── Analyse button ──
analyseBtn.addEventListener('click', () => {
  if (!currentTabId || !currentVideoId) {
    setStatus('Navigate to a supported VOD first.', true);
    return;
  }

  const check = validateRange();
  if (!check.valid) {
    setStatus(check.error, true);
    return;
  }

  saveRange();
  setStatus('Starting range analysis...');

  chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    func: (range) => {
      window.dispatchEvent(new CustomEvent('chatpeak-analyse', { detail: range }));
    },
    args: [check],
  }).then(() => {
    setStatus(`Analyzing range: ${formatTime(check.startSec)} → ${formatTime(check.endSec)}! Check page panel.`);
  }).catch(() => {
    setStatus('Could not reach the page. Try reloading it.', true);
  });
});

// ── Import button ──
document.getElementById('import-btn').addEventListener('click', () => {
  fileInput.click();
});
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const check = validateRange();
  const rangeStart = check.valid ? check.startSec : 0;
  const rangeEnd = check.valid ? check.endSec : null;

  setStatus('Importing...');
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
      if (resp?.success) {
        setStatus(`Imported ${resp.messages.length.toLocaleString()} messages in range. Open panel on VOD page.`);
      } else {
        setStatus(`Import failed: ${resp?.error || 'Unknown error'}`, true);
      }
    });
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ── Clear cache ──
document.getElementById('clear-cache-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    action: 'clearCache',
    videoId: currentVideoId,
    platform: currentPlatform,
  }, (resp) => {
    if (resp?.success) {
      setStatus('Cache cleared.');
    } else {
      setStatus('Failed to clear cache.', true);
    }
  });
});
