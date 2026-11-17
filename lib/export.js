/**
 * export.js — Export peak results in various formats.
 *
 * @module export
 */

/**
 * Format peaks as a CSV string.
 */
function peaksToCSV(peaks, videoId = '') {
  const header = 'Rank,Peak Time,Clip Start,Clip End,Score,Msgs/min,Multiplier,Tier,Top Words,Sample Message';
  const rows = peaks.map(p => {
    const topWords = p.topWords.map(w => w.word).join('; ');
    const sample = (p.sampleMsgs[0]?.text || '').replace(/"/g, '""');
    return [
      p.rank,
      p.peakTimestamp,
      p.clipStartTS,
      p.clipEndTS,
      p.score,
      p.messagesPerMin,
      p.multiplier + 'x',
      p.tier,
      `"${topWords}"`,
      `"${sample}"`,
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

/**
 * Format peaks as a JSON string.
 */
function peaksToJSON(peaks, meta = {}) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    video: meta,
    peaks,
  }, null, 2);
}

/**
 * Format peaks as a plain-text timestamp list for clipboard.
 */
function peaksToTimestamps(peaks) {
  return peaks.map(p =>
    `#${p.rank} ${p.peakTimestamp} (${p.multiplier}x, ${p.tier}) — ${p.topWords.map(w => w.word).join(', ')}`
  ).join('\n');
}

/**
 * Trigger a file download in the browser.
 */
function downloadFile(content, filename, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Copy text to clipboard.  Returns a Promise.
 */
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for older browsers / restricted contexts
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  globalThis.Exporter = { peaksToCSV, peaksToJSON, peaksToTimestamps, downloadFile, copyToClipboard };
}
