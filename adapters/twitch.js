/**
 * adapters/twitch.js — Platform adapter for Twitch VOD chat replay.
 *
 * Implements the ChatPeak Clipper Platform Adapter interface for Twitch:
 *   - matchesUrl(url) -> boolean
 *   - getVideoId(url) -> string | null
 *   - getVideoElement() -> HTMLVideoElement | null
 *   - getCurrentTime() -> number
 *   - getVideoDuration() -> number
 *   - seek(seconds, videoId) -> void
 *   - getVideoMeta(videoId, signal) -> Promise<{ id, title, lengthSeconds, channel, hasChatReplay }>
 *   - getChat(videoId, range, onProgress, signal) -> Promise<Array<{ id, offsetSeconds, user, text }>>
 *
 * @module adapters/twitch
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Adapters = root.Adapters || {};
    root.Adapters.twitch = factory();
    root.TwitchChatSource = root.Adapters.twitch; // backwards-compatibility alias
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const PERSISTED_HASH = 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';

  const RAW_QUERY = `query VideoCommentsByOffsetOrCursor($videoID: ID!, $contentOffsetSeconds: Int, $cursor: String) {
  video(id: $videoID) {
    id
    comments(contentOffsetSeconds: $contentOffsetSeconds, after: $cursor, first: 100) {
      edges {
        cursor
        node {
          id
          contentOffsetSeconds
          commenter {
            displayName
          }
          message {
            fragments {
              text
              emote {
                emoteID
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
}`;

  const VIDEO_META_QUERY = `query GetVideoMetadata($videoId: ID!) {
  video(id: $videoId) {
    id
    title
    lengthSeconds
    createdAt
    owner {
      displayName
    }
  }
}`;

  const MAX_CONCURRENT = 5;
  const BASE_DELAY_MS = 60;
  const MAX_RETRIES = 4;
  const RETRY_BASE_MS = 1000;

  function buildPayload(videoId, contentOffsetSeconds = null, cursor = null, useRaw = false) {
    const variables = { videoID: videoId };
    if (cursor) {
      variables.cursor = cursor;
    } else if (contentOffsetSeconds !== null) {
      variables.contentOffsetSeconds = Math.max(0, Math.floor(contentOffsetSeconds));
    }

    if (useRaw) {
      return [{
        operationName: 'VideoCommentsByOffsetOrCursor',
        variables,
        query: RAW_QUERY,
      }];
    }

    return [{
      operationName: 'VideoCommentsByOffsetOrCursor',
      variables,
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: PERSISTED_HASH,
        },
      },
    }];
  }

  function buildMetaPayload(videoId) {
    return [{
      operationName: 'GetVideoMetadata',
      variables: { videoId },
      query: VIDEO_META_QUERY,
    }];
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function fetchWithRetry(payload, signal, attempt = 0) {
    try {
      const res = await fetch(TWITCH_GQL_URL, {
        method: 'POST',
        headers: {
          'Client-Id': CLIENT_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Twitch returned HTTP ${res.status} after ${MAX_RETRIES} retries.`);
        }
        const wait = RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
        await sleep(wait);
        return fetchWithRetry(payload, signal, attempt + 1);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = await res.json();

      if (Array.isArray(json) && json[0]?.errors) {
        const pqError = json[0].errors.find(e =>
          e.message?.includes('PersistedQueryNotFound'));
        if (pqError && !payload[0].query) {
          const vars = payload[0].variables;
          const rawPayload = buildPayload(
            vars.videoID,
            vars.contentOffsetSeconds ?? null,
            vars.cursor ?? null,
            true
          );
          return fetchWithRetry(rawPayload, signal, 0);
        }
      }

      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (attempt >= MAX_RETRIES) throw err;
      const wait = RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
      await sleep(wait);
      return fetchWithRetry(payload, signal, attempt + 1);
    }
  }

  function parseResponse(json) {
    const data = Array.isArray(json) ? json[0]?.data : json?.data;
    if (!data?.video) {
      return { messages: [], cursor: null, hasNext: false, error: 'no_video' };
    }
    const comments = data.video.comments;
    if (!comments) {
      return { messages: [], cursor: null, hasNext: false, error: 'no_comments' };
    }

    const edges = comments.edges || [];
    const messages = [];
    let lastCursor = null;

    for (const edge of edges) {
      lastCursor = edge.cursor;
      const node = edge.node;
      if (!node) continue;
      const textParts = (node.message?.fragments || []).map(f => f.text || '').join('');
      messages.push({
        id: node.id,
        offsetSeconds: node.contentOffsetSeconds,
        user: node.commenter?.displayName || 'anonymous',
        text: textParts,
      });
    }

    return {
      messages,
      cursor: lastCursor,
      hasNext: Boolean(comments.pageInfo?.hasNextPage && lastCursor),
    };
  }

  return {
    name: 'twitch',
    displayName: 'Twitch',
    isSupported: true,

    matchesUrl(url) {
      if (!url) return false;
      try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '');
        return host === 'twitch.tv' && /^\/videos\/\d+/.test(u.pathname);
      } catch {
        return /twitch\.tv\/videos\/\d+/.test(url);
      }
    },

    getVideoId(url) {
      if (!url) return null;
      const m = url.match(/twitch\.tv\/videos\/(\d+)/) || url.match(/\/videos\/(\d+)/);
      return m ? m[1] : null;
    },

    getVideoElement() {
      if (typeof document === 'undefined') return null;
      return document.querySelector('video');
    },

    getCurrentTime() {
      const v = this.getVideoElement();
      return v && !isNaN(v.currentTime) ? v.currentTime : 0;
    },

    getVideoDuration() {
      const v = this.getVideoElement();
      return v && !isNaN(v.duration) ? v.duration : 0;
    },

    seek(seconds, videoId) {
      const sec = Math.max(0, Math.floor(seconds));
      const v = this.getVideoElement();
      if (v) {
        v.currentTime = sec;
      }
      if (typeof window !== 'undefined' && window.location) {
        try {
          const h = Math.floor(sec / 3600);
          const m = Math.floor((sec % 3600) / 60);
          const s = sec % 60;
          let tStr = '';
          if (h > 0) tStr += `${h}h`;
          if (m > 0 || h > 0) tStr += `${m}m`;
          tStr += `${s}s`;
          const url = new URL(window.location.href);
          url.searchParams.set('t', tStr);
          window.history.pushState(null, '', url.toString());
        } catch {
          // ignore navigation errors
        }
      }
    },

    async getVideoMeta(videoId, signal = null) {
      const payload = buildMetaPayload(videoId);
      const json = await fetchWithRetry(payload, signal);
      const data = Array.isArray(json) ? json[0]?.data : json?.data;
      if (!data?.video) {
        throw new Error('Could not load video metadata. The VOD may not exist or has been deleted.');
      }
      return {
        id: data.video.id,
        title: data.video.title,
        lengthSeconds: data.video.lengthSeconds,
        createdAt: data.video.createdAt,
        channel: data.video.owner?.displayName || 'unknown',
        hasChatReplay: true,
      };
    },

    async getChat(videoId, range = {}, onProgress = null, signal = null) {
      const startOffset = Math.max(0, range.startOffset ?? range.startSeconds ?? 0);
      const endOffset = Math.max(startOffset, range.endOffset ?? range.endSeconds ?? Infinity);

      let vodLength = endOffset;
      if (!isFinite(vodLength) || vodLength <= startOffset) {
        try {
          const meta = await this.getVideoMeta(videoId, signal);
          vodLength = meta.lengthSeconds || 7200;
        } catch {
          vodLength = 7200;
        }
      }
      const effectiveEnd = Math.min(vodLength, endOffset);
      const rangeSpan = Math.max(1, effectiveEnd - startOffset);

      const SEGMENT_DURATION = 1800; // 30-minute segments
      const segments = [];
      for (let s = startOffset; s < effectiveEnd; s += SEGMENT_DURATION) {
        segments.push({
          startSec: s,
          endSec: Math.min(s + SEGMENT_DURATION, effectiveEnd),
          cursor: null,
          done: false,
          furthestOffset: s,
        });
      }

      if (segments.length === 0) {
        return [];
      }

      const allMessages = new Map();
      let totalFetched = 0;
      const startTime = Date.now();

      function reportProgress() {
        let coveredSeconds = 0;
        for (const seg of segments) {
          if (seg.done) {
            coveredSeconds += (seg.endSec - seg.startSec);
          } else {
            coveredSeconds += Math.max(0, seg.furthestOffset - seg.startSec);
          }
        }

        const percent = Math.min(99, Math.round((coveredSeconds / rangeSpan) * 100));
        const elapsed = (Date.now() - startTime) / 1000;
        let eta = 0;
        if (percent > 2 && elapsed > 1) {
          eta = Math.round((elapsed / (percent / 100)) - elapsed);
        }

        onProgress?.({
          fetched: totalFetched,
          percent,
          eta,
          rangeStart: startOffset,
          rangeEnd: effectiveEnd,
        });
      }

      async function fetchSegment(seg) {
        let offsetSec = seg.startSec;
        let cursor = null;
        let isFirst = true;

        while (!seg.done) {
          if (signal?.aborted) throw new DOMException('Chat fetch aborted.', 'AbortError');

          const payload = buildPayload(
            videoId,
            isFirst ? offsetSec : null,
            cursor,
            false
          );

          const json = await fetchWithRetry(payload, signal);
          const result = parseResponse(json);

          if (result.error || result.messages.length === 0) {
            seg.done = true;
            break;
          }

          let anyNew = false;
          let reachedBoundary = false;

          for (const msg of result.messages) {
            if (msg.offsetSeconds > seg.endSec) {
              reachedBoundary = true;
            }
            if (msg.offsetSeconds >= startOffset && msg.offsetSeconds <= effectiveEnd) {
              if (!allMessages.has(msg.id)) {
                allMessages.set(msg.id, msg);
                totalFetched++;
                anyNew = true;
              }
            }
            if (msg.offsetSeconds > seg.furthestOffset) {
              seg.furthestOffset = msg.offsetSeconds;
            }
          }

          reportProgress();

          if (reachedBoundary || !result.hasNext || !result.cursor) {
            seg.done = true;
            break;
          }

          cursor = result.cursor;
          isFirst = false;
          await sleep(BASE_DELAY_MS);
        }

        seg.done = true;
        reportProgress();
      }

      const workers = segments.map(seg => fetchSegment(seg));
      await Promise.all(workers);

      const sorted = Array.from(allMessages.values())
        .filter(m => m.offsetSeconds >= startOffset && m.offsetSeconds <= effectiveEnd)
        .sort((a, b) => a.offsetSeconds - b.offsetSeconds);

      onProgress?.({
        fetched: sorted.length,
        percent: 100,
        eta: 0,
        rangeStart: startOffset,
        rangeEnd: effectiveEnd,
      });

      return sorted;
    },
  };
});
