/**
 * importers.js — Import chat data from external sources.
 *
 * Supports:
 *   1. TwitchDownloader JSON export format.
 *   2. Simple CSV with columns: time_seconds, user, message
 *   3. Custom range filtering [rangeStart, rangeEnd].
 *
 * @module importers
 */

/**
 * Import from TwitchDownloader JSON format.
 */
function importTwitchDownloaderJSON(jsonString, rangeStart = null, rangeEnd = null) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch (e) {
    throw new Error('Invalid JSON file. Could not parse the file contents.');
  }

  const comments = data.comments || data.Comments || [];
  if (!Array.isArray(comments) || comments.length === 0) {
    throw new Error('No comments found in the JSON file. Make sure this is a TwitchDownloader chat export.');
  }

  const messages = [];
  for (const c of comments) {
    const offset = c.content_offset_seconds ?? c.ContentOffsetSeconds ?? c.contentOffsetSeconds;
    if (offset == null || isNaN(offset)) continue;

    // Apply range filter if provided (with up to 600s leadIn before rangeStart)
    const leadIn = rangeStart != null ? Math.max(0, rangeStart - 600) : 0;
    if (rangeStart != null && offset < leadIn) continue;
    if (rangeEnd != null && offset > rangeEnd) continue;

    const user = c.commenter?.display_name
      || c.commenter?.DisplayName
      || c.Commenter?.display_name
      || c.Commenter?.DisplayName
      || 'anonymous';

    const text = c.message?.body
      || c.message?.Body
      || c.Message?.body
      || c.Message?.Body
      || (c.message?.fragments || c.Message?.Fragments || []).map(f => f.text || f.Text || '').join('')
      || '';

    const id = c._id || c.Id || c.id || `import-${offset}-${messages.length}`;

    messages.push({
      id,
      offsetSeconds: Math.round(offset * 10) / 10,
      user,
      text,
    });
  }

  messages.sort((a, b) => a.offsetSeconds - b.offsetSeconds);

  const video = data.video || data.Video || {};
  const vodLength = video.length || video.Length || video.end || video.End
    || (messages.length > 0 ? messages[messages.length - 1].offsetSeconds + 60 : 0);
  const title = video.title || video.Title || data.streamer?.name || data.Streamer?.Name || 'Imported VOD';
  const channel = data.streamer?.name || data.Streamer?.Name || '';

  return {
    messages,
    meta: {
      id: video.id || video.Id || 'imported',
      title,
      lengthSeconds: Math.ceil(vodLength),
      channel,
    },
  };
}

/**
 * Import from CSV format.
 * Expected columns: time_seconds, user, message
 */
function importCSV(csvString, rangeStart = null, rangeEnd = null) {
  const lines = csvString.trim().split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error('CSV file must have a header row and at least one data row.');
  }

  const header = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const timeIdx = header.findIndex(h => h.includes('time') || h.includes('offset') || h.includes('seconds'));
  const userIdx = header.findIndex(h => h.includes('user') || h.includes('name') || h.includes('commenter'));
  const msgIdx = header.findIndex(h => h.includes('message') || h.includes('text') || h.includes('body'));

  if (timeIdx === -1) throw new Error('CSV must have a time/offset column (e.g. "time_seconds").');
  if (msgIdx === -1) throw new Error('CSV must have a message/text column.');

  const messages = [];
  const leadIn = rangeStart != null ? Math.max(0, rangeStart - 600) : 0;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);
    const offset = parseFloat(cols[timeIdx]);
    if (isNaN(offset)) continue;

    if (rangeStart != null && offset < leadIn) continue;
    if (rangeEnd != null && offset > rangeEnd) continue;

    messages.push({
      id: `csv-${i}`,
      offsetSeconds: offset,
      user: userIdx >= 0 ? (cols[userIdx] || 'unknown') : 'unknown',
      text: cols[msgIdx] || '',
    });
  }

  messages.sort((a, b) => a.offsetSeconds - b.offsetSeconds);

  if (messages.length === 0) {
    throw new Error('No valid messages found in the CSV file for the chosen range.');
  }

  const vodLength = messages[messages.length - 1].offsetSeconds + 60;

  return {
    messages,
    meta: {
      id: 'csv-import',
      title: 'Imported from CSV',
      lengthSeconds: Math.ceil(vodLength),
      channel,
    },
  };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/**
 * Auto-detect format and import with range filter.
 */
function importChatFile(content, filename, rangeStart = null, rangeEnd = null) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (ext === 'json' || content.trim().startsWith('{') || content.trim().startsWith('[')) {
    return importTwitchDownloaderJSON(content, rangeStart, rangeEnd);
  } else {
    return importCSV(content, rangeStart, rangeEnd);
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  globalThis.Importers = { importTwitchDownloaderJSON, importCSV, importChatFile };
}
