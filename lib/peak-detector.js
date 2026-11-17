/**
 * peak-detector.js — Pure peak-detection module for ChatPeak Clipper.
 *
 * Analyses an array of chat messages (each with an offset in seconds) and
 * returns a ranked list of "peaks" — moments where chat activity spiked
 * significantly above its local baseline.
 *
 * Supports custom analysis ranges [rangeStart, rangeEnd], baseline lead-in,
 * customizable clip-start offset, and timestamp parsing across formats.
 *
 * Zero browser dependencies — works in Node, a service-worker, or a page.
 *
 * PUBLIC API
 *   detectPeaks(messages, vodLengthSeconds, options?)  →  PeakResult[]
 *   getTimeline(messages, vodLengthSeconds, options?)  →  TimelineResult
 *   parseTimestamp(str)                               →  number | null
 *   formatTime(seconds)                               →  string "HH:MM:SS"
 *
 * @module peak-detector
 */

// ─── Default configuration ──────────────────────────────────────────────────

const DEFAULT_OPTIONS = Object.freeze({
  /** Width of each time bucket in seconds. */
  binSize: 10,

  /** Number of bins used for moving-average smoothing (should be odd). */
  smoothWindow: 3,

  /** Number of bins for the rolling-median baseline (≈ 10 min at 10-s bins). */
  baselineWindow: 60,

  /** Minimum z-score a bin must reach to qualify as a peak. */
  zScoreThreshold: 2.0,

  /** Minimum ratio vs. baseline to qualify as a peak. */
  minMultiplier: 1.8,

  /** Minimum seconds between two distinct peaks (keeps the higher one). */
  minPeakDistance: 60,

  /** Seconds of lead-in before the spike start for the suggested clip. */
  leadIn: 20,

  /** Clip start offset in seconds before peak (synonym/override for leadIn). */
  clipStartOffset: 20,

  /** Seconds of trail after the peak for the suggested clip. */
  leadOut: 15,

  /** How many seconds to look back when computing spike steepness. */
  spikeWindow: 45,

  /** Weights for the composite score [messageRate, uniqueChatters, hypeRatio]. */
  weights: [0.6, 0.2, 0.2],

  /** Maximum number of peaks to return (0 = unlimited). */
  topN: 0,

  /** Start of analysis range in seconds (default 0). */
  rangeStart: 0,

  /** End of analysis range in seconds (default null = end of VOD). */
  rangeEnd: null,

  /**
   * Hype words/emotes — messages containing any of these contribute to the
   * hype metric.  Also: any ALL-CAPS word ≥4 chars counts as hype, and
   * messages where the same emote/word is repeated ≥3 times count as spam-hype.
   */
  hypeWords: [
    'KEKW', 'LUL', 'LULW', 'OMEGALUL', 'POG', 'POGGERS', 'PogU', 'PogChamp',
    'Pog', 'POGGIES', 'W', 'WWW', 'LETSGO', 'LETS GO', 'CLIP IT', 'CLIP',
    'CLIPPED', 'NO WAY', 'HOLY', 'LMAO', 'LMFAO', 'ROFL', 'LOL', 'OMG',
    'WTF', 'BRUH', 'monkaW', 'monkaS', 'PepeHands', 'Sadge', 'EZ', 'Clap',
    'HYPERS', 'catJAM', 'D:', 'ICANT', 'RIPBOZO', 'GIGACHAD',
    '😂', '💀', '🔥', '😭', '🤣', '💯', '🫡',
  ],
});


// ─── Timestamp parsing & formatting ─────────────────────────────────────────

/**
 * Parse a timestamp string into seconds.
 * Supports:
 *   - "HH:MM:SS" (e.g. "01:30:00", "1:30:00")
 *   - "MM:SS" (e.g. "45:00", "05:30")
 *   - Plain seconds (e.g. "5400", "5400.5")
 *   - Twitch style (e.g. "1h30m0s", "1h30m", "45m10s", "2h", "30s", "1h", "10m")
 *
 * @param {string|number} input
 * @returns {number|null} Total seconds (>= 0), or null if invalid.
 */
function parseTimestamp(input) {
  if (input == null) return null;
  const str = String(input).trim();
  if (!str) return null;

  // 1. Plain number / numeric string (e.g. "5400", "5400.5")
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const val = parseFloat(str);
    return isNaN(val) || val < 0 ? null : val;
  }

  // 2. Twitch format e.g. "1h30m0s", "1h30m", "45m10s", "2h", "45s", "1h 30m"
  const twitchRegex = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/i;
  const twitchMatch = str.match(twitchRegex);
  if (twitchMatch && (twitchMatch[1] != null || twitchMatch[2] != null || twitchMatch[3] != null)) {
    const h = parseInt(twitchMatch[1] || '0', 10);
    const m = parseInt(twitchMatch[2] || '0', 10);
    const s = parseFloat(twitchMatch[3] || '0');
    const total = h * 3600 + m * 60 + s;
    return isNaN(total) || total < 0 ? null : total;
  }

  // 3. Colon format: HH:MM:SS or MM:SS
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

/**
 * Format total seconds to "HH:MM:SS".
 */
function formatTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a Set of lowercased hype words for fast lookup.
 */
function buildHypeSet(words) {
  return new Set(words.map(w => w.toLowerCase()));
}

/**
 * Check whether a single message text is "hype".
 */
function isHypeMessage(text, hypeSet) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Rule 1 — keyword match
  for (const word of lower.split(/\s+/)) {
    if (hypeSet.has(word)) return true;
  }
  // Rule 2 — ALL-CAPS word >= 4 chars
  const capsRe = /\b[A-Z]{4,}\b/;
  if (capsRe.test(text)) return true;
  // Rule 3 — repeated word/emote >= 3 times
  const counts = {};
  for (const w of text.split(/\s+/)) {
    counts[w] = (counts[w] || 0) + 1;
    if (counts[w] >= 3) return true;
  }
  return false;
}

/**
 * Bucket messages into fixed-width time bins starting from originOffset.
 */
function bucketMessages(messages, binSize, totalBins, originOffset = 0) {
  const bins = new Array(totalBins);
  for (let i = 0; i < totalBins; i++) {
    bins[i] = { messages: [], chatters: new Set(), hypeCount: 0 };
  }
  for (const msg of messages) {
    const relOffset = msg.offsetSeconds - originOffset;
    if (relOffset < 0) continue;
    const idx = Math.floor(relOffset / binSize);
    if (idx >= 0 && idx < totalBins) {
      bins[idx].messages.push(msg);
      bins[idx].chatters.add(msg.user);
    }
  }
  return bins;
}

/**
 * Compute per-bin metrics from raw bins.
 */
function computeMetrics(bins, hypeSet) {
  return bins.map(bin => {
    let hypeCount = 0;
    for (const msg of bin.messages) {
      if (isHypeMessage(msg.text, hypeSet)) hypeCount++;
    }
    const msgCount = bin.messages.length;
    return {
      msgCount,
      uniqueChatters: bin.chatters.size,
      hypeCount,
      hypeRatio: msgCount > 0 ? hypeCount / msgCount : 0,
      messages: bin.messages,
    };
  });
}

/**
 * Simple moving-average smoother.
 */
function smooth(values, windowSize) {
  const half = Math.floor(windowSize / 2);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

/**
 * Rolling median using a sorted-window approach.
 */
function rollingMedian(values, windowSize) {
  const half = Math.floor(windowSize / 2);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    const slice = [];
    for (let j = lo; j <= hi; j++) slice.push(values[j]);
    slice.sort((a, b) => a - b);
    out[i] = slice[Math.floor(slice.length / 2)];
  }
  return out;
}

/**
 * Rolling MAD (Median Absolute Deviation) for robust z-scores.
 */
function rollingMAD(values, medians, windowSize) {
  const half = Math.floor(windowSize / 2);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    const deviations = [];
    for (let j = lo; j <= hi; j++) deviations.push(Math.abs(values[j] - medians[i]));
    deviations.sort((a, b) => a - b);
    // 1.4826 makes MAD consistent with std-dev for normal distributions
    out[i] = 1.4826 * deviations[Math.floor(deviations.length / 2)];
  }
  return out;
}

/**
 * Find the index where a rising spike started, looking backwards from peakIdx.
 */
function findSpikeStart(smoothed, peakIdx, spikeWindowBins) {
  let idx = peakIdx;
  const minIdx = Math.max(0, peakIdx - spikeWindowBins);
  while (idx > minIdx && smoothed[idx - 1] < smoothed[idx]) {
    idx--;
  }
  return idx;
}

/**
 * Extract top-N frequent words/emotes from messages in a window.
 */
function topWordsInWindow(messages, n = 5) {
  const freq = {};
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'it', 'to', 'in', 'and', 'of', 'for', 'on',
    'at', 'i', 'he', 'she', 'we', 'you', 'they', 'this', 'that', 'was',
    'are', 'be', 'has', 'have', 'had', 'do', 'did', 'but', 'not', 'so',
    'if', 'or', 'my', 'me', 'his', 'her', 'with', 'just', 'its',
  ]);
  for (const msg of messages) {
    for (const w of msg.text.split(/\s+/)) {
      const clean = w.replace(/[.,!?;:'"]/g, '');
      if (clean.length < 2) continue;
      if (stopWords.has(clean.toLowerCase())) continue;
      freq[clean] = (freq[clean] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word, count]) => ({ word, count }));
}

/**
 * Pick N representative messages from an array.
 */
function pickRepresentativeMessages(messages, n = 3) {
  if (messages.length <= n) return messages.map(m => ({ user: m.user, text: m.text }));
  const seenUsers = new Set();
  const scored = messages
    .filter(m => m.text.length >= 3 && m.text.length <= 200)
    .map(m => {
      const unique = !seenUsers.has(m.user);
      if (unique) seenUsers.add(m.user);
      const lengthScore = Math.min(m.text.length, 80) / 80;
      return { msg: m, score: (unique ? 2 : 0) + lengthScore };
    })
    .sort((a, b) => b.score - a.score);
  const picked = [];
  const usedUsers = new Set();
  for (const s of scored) {
    if (picked.length >= n) break;
    if (usedUsers.has(s.msg.user) && scored.length > n) continue;
    usedUsers.add(s.msg.user);
    picked.push({ user: s.msg.user, text: s.msg.text });
  }
  return picked;
}


// ─── Main algorithm ──────────────────────────────────────────────────────────

/**
 * Detect all meaningful chat peaks in a VOD's chat replay.
 * Supports custom analysis range [rangeStart, rangeEnd] with baseline lead-in.
 * All reported timestamps remain absolute VOD time.
 *
 * @param {Array<{offsetSeconds: number, user: string, text: string, id?: string}>} messages
 * @param {number} vodLengthSeconds
 * @param {object} [options]
 * @returns {PeakResult[]}
 */
function detectPeaks(messages, vodLengthSeconds, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  // Allow clipStartOffset to override leadIn
  const clipStartOffset = options.clipStartOffset != null ? options.clipStartOffset : (opts.clipStartOffset ?? opts.leadIn);

  if (!messages || messages.length === 0 || vodLengthSeconds <= 0) {
    return [];
  }

  const rangeStart = Math.max(0, opts.rangeStart ?? 0);
  const rangeEnd = Math.min(vodLengthSeconds, (opts.rangeEnd != null ? opts.rangeEnd : vodLengthSeconds));

  if (rangeStart >= rangeEnd) {
    return [];
  }

  // Lead-in check: If we have messages cached before rangeStart, use up to 10 minutes (600s)
  // as lead-in to compute a warm rolling baseline, but only accept peaks within [rangeStart, rangeEnd].
  let earliestMsgOffset = messages[0].offsetSeconds;
  let startForBaseline = rangeStart;
  if (earliestMsgOffset < rangeStart) {
    const leadInTime = Math.min(600, rangeStart);
    startForBaseline = Math.max(0, Math.max(earliestMsgOffset, rangeStart - leadInTime));
  }

  const hypeSet = buildHypeSet(opts.hypeWords);
  const windowDuration = rangeEnd - startForBaseline;
  const totalBins = Math.max(1, Math.ceil(windowDuration / opts.binSize));

  // 1. Bucket messages within [startForBaseline, rangeEnd]
  const relevantMessages = messages.filter(m => m.offsetSeconds >= startForBaseline && m.offsetSeconds <= rangeEnd + opts.binSize);
  const bins = bucketMessages(relevantMessages, opts.binSize, totalBins, startForBaseline);

  // 2. Per-bin metrics
  const metrics = computeMetrics(bins, hypeSet);
  const rawMsgCounts = new Float64Array(metrics.map(m => m.msgCount));
  const rawUnique = new Float64Array(metrics.map(m => m.uniqueChatters));
  const rawHype = new Float64Array(metrics.map(m => m.hypeRatio));

  // 3. Smooth message-count signal
  const smoothed = smooth(rawMsgCounts, opts.smoothWindow);

  // 4. Adaptive baseline & spread
  const baseline = rollingMedian(smoothed, opts.baselineWindow);
  const mad = rollingMAD(smoothed, baseline, opts.baselineWindow);

  const baselineUnique = rollingMedian(rawUnique, opts.baselineWindow);
  const madUnique = rollingMAD(rawUnique, baselineUnique, opts.baselineWindow);
  const baselineHype = rollingMedian(rawHype, opts.baselineWindow);
  const madHype = rollingMAD(rawHype, baselineHype, opts.baselineWindow);

  // 5. Composite score per bin
  const scores = new Float64Array(totalBins);
  const zScores = new Float64Array(totalBins);
  const multipliers = new Float64Array(totalBins);

  const spikeWindowBins = Math.max(1, Math.round(opts.spikeWindow / opts.binSize));
  const [wMsg, wUniq, wHype] = opts.weights;

  for (let i = 0; i < totalBins; i++) {
    // Scale guard against zero MAD (robust fallback for quiet chats or uniform baseline)
    const scaleMsg = Math.max(mad[i], 1.0);
    const zMsg = (smoothed[i] - baseline[i]) / scaleMsg;

    const scaleUniq = Math.max(madUnique[i], 0.5);
    const zUniq = (rawUnique[i] - baselineUnique[i]) / scaleUniq;

    const scaleHype = Math.max(madHype[i], 0.1);
    const zHype = (rawHype[i] - baselineHype[i]) / scaleHype;

    zScores[i] = zMsg;
    multipliers[i] = baseline[i] > 0.01 ? smoothed[i] / baseline[i] : (smoothed[i] > 0 ? 999 : 0);

    const refIdx = Math.max(0, i - spikeWindowBins);
    const rise = smoothed[i] - smoothed[refIdx];
    const spikeStrength = baseline[i] > 0.01 ? rise / baseline[i] : (rise > 0 ? 10 : 0);

    scores[i] = wMsg * Math.max(0, zMsg) + wUniq * Math.max(0, zUniq) + wHype * Math.max(0, zHype)
      + 0.15 * Math.min(spikeStrength, 10);
  }

  // 6. Find local maxima above threshold (handles sharp peaks & plateau centers).
  // ONLY accept peaks whose peakTime falls inside [rangeStart, rangeEnd]!
  const candidates = [];
  for (let i = 0; i < totalBins; i++) {
    const peakTime = startForBaseline + (i + 0.5) * opts.binSize;
    if (peakTime < rangeStart || peakTime > rangeEnd) continue;

    const isLeftMax = (i === 0) || (scores[i] >= scores[i - 1]);
    const isRightMax = (i === totalBins - 1) || (scores[i] > scores[i + 1]);

    if (isLeftMax && isRightMax && zScores[i] >= opts.zScoreThreshold && multipliers[i] >= opts.minMultiplier) {
      candidates.push(i);
    }
  }

  // Sort candidates by score descending
  candidates.sort((a, b) => scores[b] - scores[a]);

  // Enforce minimum distance between peaks
  const minDistBins = Math.max(1, Math.round(opts.minPeakDistance / opts.binSize));
  const accepted = [];
  for (const idx of candidates) {
    let tooClose = false;
    for (const prevIdx of accepted) {
      if (Math.abs(idx - prevIdx) < minDistBins) { tooClose = true; break; }
    }
    if (!tooClose) {
      accepted.push(idx);
    }
  }

  // 7. Build peak result objects with absolute VOD timestamps
  const results = accepted.map(idx => {
    const peakTime = startForBaseline + (idx + 0.5) * opts.binSize; // absolute VOD time
    const spikeStartIdx = findSpikeStart(smoothed, idx, spikeWindowBins);
    const spikeStartTime = startForBaseline + spikeStartIdx * opts.binSize;

    // Use clipStartOffset (seconds before spike start)
    const clipStart = Math.max(0, spikeStartTime - clipStartOffset);
    const clipEnd = Math.min(vodLengthSeconds, peakTime + opts.leadOut);

    // Collect messages in the peak window
    const windowMsgs = messages.filter(m => m.offsetSeconds >= clipStart && m.offsetSeconds <= clipEnd);

    const msgPerMin = (metrics[idx].msgCount / opts.binSize) * 60;
    const mult = Math.round(multipliers[idx] * 10) / 10;

    const refIdx = Math.max(0, idx - spikeWindowBins);
    const rise = smoothed[idx] - smoothed[refIdx];
    const spikeStr = baseline[idx] > 0.01 ? Math.round((rise / baseline[idx]) * 10) / 10 : 0;

    let tier;
    if (scores[idx] >= 6) tier = 'hot';
    else if (scores[idx] >= 3.5) tier = 'good';
    else tier = 'okay';

    return {
      rank: 0,
      peakTime: Math.round(peakTime),
      peakTimestamp: formatTime(peakTime),
      clipStart: Math.round(clipStart),
      clipEnd: Math.round(clipEnd),
      clipStartTS: formatTime(clipStart),
      clipEndTS: formatTime(clipEnd),
      score: Math.round(scores[idx] * 100) / 100,
      messagesPerMin: Math.round(msgPerMin * 10) / 10,
      multiplier: mult,
      zScore: Math.round(zScores[idx] * 100) / 100,
      spikeStrength: spikeStr,
      topWords: topWordsInWindow(windowMsgs, 5),
      sampleMsgs: pickRepresentativeMessages(windowMsgs, 3),
      tier,
    };
  });

  results.sort((a, b) => b.score - a.score);
  results.forEach((r, i) => { r.rank = i + 1; });

  if (opts.topN > 0 && results.length > opts.topN) {
    return results.slice(0, opts.topN);
  }

  return results;
}

/**
 * Get the activity timeline for chart rendering.
 * Includes rangeStart and rangeEnd metadata.
 */
function getTimeline(messages, vodLengthSeconds, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const rangeStart = Math.max(0, opts.rangeStart ?? 0);
  const rangeEnd = Math.min(vodLengthSeconds, (opts.rangeEnd != null ? opts.rangeEnd : vodLengthSeconds));

  if (!messages || messages.length === 0 || vodLengthSeconds <= 0) {
    return { times: [], smoothedCounts: [], baseline: [], rangeStart, rangeEnd, vodLength: vodLengthSeconds };
  }

  // Cover the whole VOD if messages span it, or the analyzed window
  const totalBins = Math.max(1, Math.ceil(vodLengthSeconds / opts.binSize));
  const bins = bucketMessages(messages, opts.binSize, totalBins, 0);
  const rawCounts = new Float64Array(bins.map(b => b.messages.length));
  const smoothedArr = smooth(rawCounts, opts.smoothWindow);
  const baselineArr = rollingMedian(smoothedArr, opts.baselineWindow);

  const times = [];
  const smoothedCounts = [];
  const baselineCounts = [];
  for (let i = 0; i < totalBins; i++) {
    times.push(i * opts.binSize);
    smoothedCounts.push(Math.round(smoothedArr[i] * 100) / 100);
    baselineCounts.push(Math.round(baselineArr[i] * 100) / 100);
  }
  return {
    times,
    smoothedCounts,
    baseline: baselineCounts,
    rangeStart,
    rangeEnd,
    vodLength: vodLengthSeconds,
  };
}


// ─── Sensitivity Presets ─────────────────────────────────────────────────────

const SENSITIVITY_PRESETS = {
  low:    { zScoreThreshold: 3.0, minMultiplier: 2.5 },
  medium: { zScoreThreshold: 2.0, minMultiplier: 1.8 },
  high:   { zScoreThreshold: 1.3, minMultiplier: 1.4 },
};


// ─── Exports ─────────────────────────────────────────────────────────────────

const PeakDetectorExport = {
  detectPeaks,
  getTimeline,
  parseTimestamp,
  formatTime,
  SENSITIVITY_PRESETS,
  DEFAULT_OPTIONS,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PeakDetectorExport;
}
if (typeof globalThis !== 'undefined') {
  globalThis.PeakDetector = PeakDetectorExport;
}
