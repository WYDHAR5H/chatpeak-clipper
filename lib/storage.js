/**
 * storage.js — IndexedDB cache for downloaded chat + chrome.storage helpers.
 *
 * Stores chat messages per video ID in IndexedDB with interval tracking:
 *   - Tracks which time ranges [start, end] have been downloaded.
 *   - Supports range-based queries and computes missing intervals.
 *   - Merges newly fetched intervals with existing cached messages.
 *   - Remembers the user's last chosen range per VOD.
 *
 * @module storage
 */

const DB_NAME = 'ChatPeakClipperDB';
const DB_VERSION = 2; // Incremented for range tracking
const STORE_CHAT = 'chatCache';
const STORE_CLIPS = 'clipStatus';

// ─── Key normalization helper ────────────────────────────────────────────────

/**
 * Normalizes a video ID with platform prefix (e.g., 'youtube:Zu2z5M4gmno').
 * Preserves backwards compatibility if already compound or platform omitted.
 *
 * @param {string} videoId
 * @param {string} [platform]
 * @returns {string}
 */
function toStorageKey(videoId, platform) {
  if (!videoId) return '';
  const str = String(videoId);
  if (str.includes(':')) return str;
  return platform ? `${platform}:${str}` : str;
}

// ─── Interval arithmetic helpers ─────────────────────────────────────────────

/**
 * Normalize and merge overlapping or adjacent intervals.
 * @param {Array<[number, number]>} ranges
 * @returns {Array<[number, number]>}
 */
function normalizeRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return [];
  const sorted = ranges
    .map(([s, e]) => [Math.min(s, e), Math.max(s, e)])
    .sort((a, b) => a[0] - b[0]);

  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    // If overlapping or adjacent (within 2s tolerance for continuous chat)
    if (curr[0] <= prev[1] + 2) {
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

/**
 * Compute the missing sub-intervals of [reqStart, reqEnd] not covered by cachedRanges.
 * @param {Array<[number, number]>} cachedRanges
 * @param {number} reqStart
 * @param {number} reqEnd
 * @returns {Array<[number, number]>}
 */
function getMissingIntervals(cachedRanges, reqStart, reqEnd) {
  if (!cachedRanges || cachedRanges.length === 0) {
    return [[reqStart, reqEnd]];
  }
  const norm = normalizeRanges(cachedRanges);
  let uncovered = [[reqStart, reqEnd]];

  for (const [cStart, cEnd] of norm) {
    const nextUncovered = [];
    for (const [uStart, uEnd] of uncovered) {
      if (cEnd <= uStart || cStart >= uEnd) {
        // No overlap
        nextUncovered.push([uStart, uEnd]);
      } else {
        // Overlap: keep portions before and after the cached block
        if (uStart < cStart) {
          nextUncovered.push([uStart, cStart]);
        }
        if (uEnd > cEnd) {
          nextUncovered.push([cEnd, uEnd]);
        }
      }
    }
    uncovered = nextUncovered;
  }

  // Filter out any negligible intervals (< 1s)
  return uncovered.filter(([s, e]) => (e - s) >= 1);
}

// ─── IndexedDB setup ─────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHAT)) {
        db.createObjectStore(STORE_CHAT, { keyPath: 'videoId' });
      }
      if (!db.objectStoreNames.contains(STORE_CLIPS)) {
        db.createObjectStore(STORE_CLIPS, { keyPath: 'videoId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── Range-aware cache operations ────────────────────────────────────────────

/**
 * Load cached entry for a video.
 */
async function getCachedChat(videoId, platform) {
  const key = toStorageKey(videoId, platform);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT, 'readonly');
    const req = tx.objectStore(STORE_CHAT).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Check cache coverage for a specific time range.
 *
 * @param {string} videoId
 * @param {number} reqStart
 * @param {number} reqEnd
 * @param {number} [leadInSeconds=600]
 * @param {string} [platform]
 * @returns {Promise<{
 *   isFullyCached: boolean,
 *   missingRanges: Array<[number, number]>,
 *   messages: Array,
 *   meta: object|null
 * }>}
 */
async function getCachedChatForRange(videoId, reqStart, reqEnd, leadInSeconds = 0, platform) {
  const key = toStorageKey(videoId, platform);
  const entry = await getCachedChat(key);
  if (!entry) {
    return {
      isFullyCached: false,
      missingRanges: [[reqStart, reqEnd]],
      messages: [],
      meta: null,
    };
  }

  // Backwards compatibility if old cache entry without ranges field
  const ranges = entry.ranges || (entry.messages?.length > 0
    ? [[0, entry.meta?.lengthSeconds || entry.messages[entry.messages.length - 1].offsetSeconds + 10]]
    : []);

  const missingRanges = getMissingIntervals(ranges, reqStart, reqEnd);
  const isFullyCached = missingRanges.length === 0;

  // Extract messages within the requested range + leadIn if available
  const effectiveStart = Math.max(0, reqStart - leadInSeconds);
  const relevantMessages = (entry.messages || []).filter(
    m => m.offsetSeconds >= effectiveStart && m.offsetSeconds <= reqEnd + 1
  );

  return {
    isFullyCached,
    missingRanges,
    messages: relevantMessages,
    allCachedMessages: entry.messages || [],
    meta: entry.meta || null,
  };
}

/**
 * Save / merge newly fetched messages for a specific range into the cache.
 *
 * @param {string} videoId
 * @param {Array} newMessages
 * @param {[number, number]} fetchedRange
 * @param {object} [meta={}]
 * @param {string} [platform]
 */
async function cacheChatMessagesForRange(videoId, newMessages, fetchedRange, meta = {}, platform) {
  const key = toStorageKey(videoId, platform);
  const db = await openDB();
  const existing = await getCachedChat(key);

  let mergedMessages;
  let mergedRanges;
  let combinedMeta = { ...(existing?.meta || {}), ...meta };

  if (existing && Array.isArray(existing.messages)) {
    // Merge messages de-duplicating by ID
    const msgMap = new Map();
    for (const m of existing.messages) {
      msgMap.set(m.id, m);
    }
    for (const m of newMessages) {
      msgMap.set(m.id, m);
    }
    mergedMessages = Array.from(msgMap.values()).sort((a, b) => a.offsetSeconds - b.offsetSeconds);

    const existingRanges = existing.ranges || [[0, existing.meta?.lengthSeconds || 0]];
    mergedRanges = normalizeRanges([...existingRanges, fetchedRange]);
  } else {
    const msgMap = new Map();
    for (const m of newMessages) {
      msgMap.set(m.id, m);
    }
    mergedMessages = Array.from(msgMap.values()).sort((a, b) => a.offsetSeconds - b.offsetSeconds);
    mergedRanges = normalizeRanges([fetchedRange]);
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT, 'readwrite');
    tx.objectStore(STORE_CHAT).put({
      videoId: key,
      messages: mergedMessages,
      ranges: mergedRanges,
      meta: combinedMeta,
      cachedAt: Date.now(),
    });
    tx.oncomplete = () => resolve({ messages: mergedMessages, ranges: mergedRanges });
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Legacy full-cache save (marks the full 0..length as cached).
 */
async function cacheChatMessages(videoId, messages, meta = {}, platform) {
  const key = toStorageKey(videoId, platform);
  const vodLen = meta.lengthSeconds || (messages.length > 0 ? messages[messages.length - 1].offsetSeconds + 10 : 3600);
  return cacheChatMessagesForRange(key, messages, [0, vodLen], meta);
}

/**
 * Delete cached chat for a specific video or all.
 */
async function clearChatCache(videoId, platform) {
  const key = videoId ? toStorageKey(videoId, platform) : null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT, 'readwrite');
    if (key) {
      tx.objectStore(STORE_CHAT).delete(key);
    } else {
      tx.objectStore(STORE_CHAT).clear();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * List all cached video IDs.
 */
async function listCachedVideos() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT, 'readonly');
    const req = tx.objectStore(STORE_CHAT).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ─── Clip status (clipped/skipped per peak per video) ────────────────────────

async function getClipStatuses(videoId, platform) {
  const key = toStorageKey(videoId, platform);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CLIPS, 'readonly');
    const req = tx.objectStore(STORE_CLIPS).get(key);
    req.onsuccess = () => resolve(req.result?.statuses || {});
    req.onerror = () => reject(req.error);
  });
}

async function setClipStatus(videoId, peakTime, status, platform) {
  const key = toStorageKey(videoId, platform);
  const db = await openDB();
  const existing = await getClipStatuses(key);
  existing[peakTime] = status; // 'clipped' | 'skipped' | null
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CLIPS, 'readwrite');
    tx.objectStore(STORE_CLIPS).put({ videoId: key, statuses: existing });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Last used range per VOD (chrome.storage.local) ──────────────────────────

function getLastRange(videoId, platform) {
  const key = toStorageKey(videoId, platform);
  return new Promise(resolve => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return resolve(null);
    chrome.storage.local.get('lastRanges', result => {
      const allRanges = result.lastRanges || {};
      resolve(allRanges[key] || allRanges[videoId] || null);
    });
  });
}

function saveLastRange(videoId, range, platform) {
  const key = toStorageKey(videoId, platform);
  return new Promise(resolve => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return resolve();
    chrome.storage.local.get('lastRanges', result => {
      const allRanges = result.lastRanges || {};
      allRanges[key] = range; // { startStr, endStr, startSec, endSec }
      chrome.storage.local.set({ lastRanges: allRanges }, resolve);
    });
  });
}

// ─── chrome.storage.local settings helpers ────────────────────────────────────

function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get('settings', result => {
      resolve(result.settings || {});
    });
  });
}

function saveSettings(settings) {
  return new Promise(resolve => {
    chrome.storage.local.set({ settings }, resolve);
  });
}

function getPanelState() {
  return new Promise(resolve => {
    chrome.storage.local.get('panelState', result => {
      resolve(result.panelState || { collapsed: false, x: 20, y: 80 });
    });
  });
}

function savePanelState(state) {
  return new Promise(resolve => {
    chrome.storage.local.set({ panelState: state }, resolve);
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

const StorageExports = {
  toStorageKey,
  cacheChatMessages,
  cacheChatMessagesForRange,
  getCachedChat,
  getCachedChatForRange,
  clearChatCache,
  listCachedVideos,
  getClipStatuses,
  setClipStatus,
  getLastRange,
  saveLastRange,
  normalizeRanges,
  getMissingIntervals,
  getSettings,
  saveSettings,
  getPanelState,
  savePanelState,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StorageExports;
}
if (typeof globalThis !== 'undefined') {
  globalThis.Storage = StorageExports;
}
