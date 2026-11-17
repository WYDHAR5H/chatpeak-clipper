/**
 * adapters/youtube.js — Platform adapter for YouTube past live streams / premieres chat replay.
 *
 * Implements the ChatPeak Clipper Platform Adapter interface for YouTube:
 *   - matchesUrl(url) -> boolean
 *   - getVideoId(url) -> string | null
 *   - getVideoElement() -> HTMLVideoElement | null
 *   - getCurrentTime() -> number
 *   - getVideoDuration() -> number
 *   - seek(seconds, videoId) -> void
 *   - getVideoMeta(videoId, signal) -> Promise<{ id, title, lengthSeconds, channel, hasChatReplay, continuation, apiKey }>
 *   - getChat(videoId, range, onProgress, signal) -> Promise<Array<{ id, offsetSeconds, user, text }>>
 *
 * @module adapters/youtube
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Adapters = root.Adapters || {};
    root.Adapters.youtube = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  const INNERTUBE_CLIENT_VERSION = '2.20240101.00.00';
  const REPLAY_ENDPOINT = 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay';

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Helper to parse watch page HTML and extract metadata & initial chat continuation.
   */
  function parseWatchPageHtml(html, videoId) {
    let apiKey = DEFAULT_API_KEY;
    const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (keyMatch) apiKey = keyMatch[1];

    let title = '';
    let lengthSeconds = 0;
    let channel = '';
    let continuation = null;
    let hasChatReplay = false;

    // Try parsing ytInitialData
    const ytInitMatch = html.match(/ytInitialData\s*=\s*({.+?});<\/script>/);
    if (ytInitMatch) {
      try {
        const data = JSON.parse(ytInitMatch[1]);

        // Chat continuation
        const liveChatRenderer = data.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
        if (liveChatRenderer) {
          hasChatReplay = true;
          const contObj = liveChatRenderer.continuations?.[0];
          continuation = contObj?.reloadContinuationData?.continuation ||
                         contObj?.liveChatReplayContinuationData?.continuation || null;
        }

        // Title & metadata from videoPrimaryInfoRenderer
        function findVideoDetails(obj) {
          if (!obj || typeof obj !== 'object') return null;
          if (obj.videoPrimaryInfoRenderer) return obj.videoPrimaryInfoRenderer;
          for (const v of Object.values(obj)) {
            const r = findVideoDetails(v);
            if (r) return r;
          }
          return null;
        }

        const pri = findVideoDetails(data);
        if (pri) {
          title = pri.title?.runs?.map(r => r.text).join('') || '';
        }

        // Microformat metadata
        const micro = data.microformat?.playerMicroformatRenderer;
        if (micro) {
          if (!title) title = micro.title?.simpleText || '';
          lengthSeconds = Number(micro.lengthSeconds || 0);
          channel = micro.ownerChannelName || '';
        }
      } catch {
        // Fallbacks below
      }
    }

    // HTML regex fallbacks
    if (!title) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) {
        title = titleMatch[1].replace(/ - YouTube$/, '').trim();
      }
    }

    if (!continuation) {
      const contMatch = html.match(/"(?:reloadContinuationData|liveChatReplayContinuationData)"\s*:\s*\{"continuation":"([^"]+)"/);
      if (contMatch) {
        continuation = contMatch[1];
        hasChatReplay = true;
      }
    }

    return {
      id: videoId,
      title: title || `YouTube Video ${videoId}`,
      lengthSeconds: lengthSeconds || 7200,
      channel: channel || 'YouTube Creator',
      hasChatReplay,
      continuation,
      apiKey,
    };
  }

  return {
    name: 'youtube',
    displayName: 'YouTube',
    isSupported: true,

    matchesUrl(url) {
      if (!url) return false;
      try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
        if (host !== 'youtube.com' && host !== 'youtu.be') return false;
        if (host === 'youtu.be') return Boolean(u.pathname.replace(/^\//, ''));
        return u.pathname === '/watch' && Boolean(u.searchParams.get('v'));
      } catch {
        return /(?:youtube\.com\/watch\?v=|youtu\.be\/)/.test(url);
      }
    },

    getVideoId(url) {
      if (!url) return null;
      try {
        const u = new URL(url);
        if (u.hostname.includes('youtu.be')) {
          return u.pathname.replace(/^\//, '').split('/')[0] || null;
        }
        return u.searchParams.get('v');
      } catch {
        const m = url.match(/[?&]v=([^&#]+)/) || url.match(/youtu\.be\/([^?&#]+)/);
        return m ? m[1] : null;
      }
    },

    getVideoElement() {
      if (typeof document === 'undefined') return null;
      return document.querySelector('video.html5-main-video') || document.querySelector('video');
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
      if (typeof document !== 'undefined') {
        const moviePlayer = document.getElementById('movie_player');
        if (moviePlayer && typeof moviePlayer.seekTo === 'function') {
          moviePlayer.seekTo(sec, true);
        } else {
          const v = this.getVideoElement();
          if (v) v.currentTime = sec;
        }
      }
      if (typeof window !== 'undefined' && window.location) {
        try {
          const url = new URL(window.location.href);
          url.searchParams.set('t', `${sec}s`);
          window.history.pushState(null, '', url.toString());
        } catch {
          // ignore
        }
      }
    },

    async getVideoMeta(videoId, signal = null) {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal,
      });

      if (!res.ok) {
        throw new Error(`Failed to load YouTube watch page: HTTP ${res.status}`);
      }

      const html = await res.text();
      return parseWatchPageHtml(html, videoId);
    },

    async getChat(videoId, range = {}, onProgress = null, signal = null) {
      const startOffset = Math.max(0, range.startOffset ?? range.startSeconds ?? 0);
      const endOffset = Math.max(startOffset, range.endOffset ?? range.endSeconds ?? Infinity);

      // Fetch watch page to obtain continuation token and metadata
      const meta = await this.getVideoMeta(videoId, signal);
      if (!meta.hasChatReplay || !meta.continuation) {
        throw new Error('This video has no chat replay.');
      }

      const apiKey = meta.apiKey || DEFAULT_API_KEY;
      const vodLength = meta.lengthSeconds || 7200;
      const effectiveEnd = Math.min(vodLength, endOffset);
      const rangeSpan = Math.max(1, effectiveEnd - startOffset);

      const allMessages = [];
      const seenIds = new Set();
      let continuation = meta.continuation;
      let lastReportedSec = startOffset;
      const startTime = Date.now();

      while (continuation) {
        if (signal?.aborted) throw new DOMException('Chat fetch aborted.', 'AbortError');

        const replayRes = await fetch(`${REPLAY_ENDPOINT}?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: 'WEB',
                clientVersion: INNERTUBE_CLIENT_VERSION,
              },
            },
            continuation,
          }),
          signal,
        });

        if (!replayRes.ok) {
          throw new Error(`YouTube chat replay request failed: HTTP ${replayRes.status}`);
        }

        const replayJson = await replayRes.json();
        const liveChat = replayJson.continuationContents?.liveChatContinuation;
        if (!liveChat) {
          break;
        }

        const actions = liveChat.actions || [];
        let reachedEnd = false;

        for (const act of actions) {
          const replayAction = act.replayChatItemAction;
          if (!replayAction) continue;

          const offsetMsec = Number(replayAction.videoOffsetTimeMsec || 0);
          const offsetSeconds = Math.round(offsetMsec / 1000);
          lastReportedSec = Math.max(lastReportedSec, offsetSeconds);

          if (offsetSeconds > effectiveEnd) {
            reachedEnd = true;
            break;
          }

          const subActions = replayAction.actions || [];
          for (const sa of subActions) {
            const item = sa.addChatItemAction?.item;
            if (!item) continue;

            const renderer = item.liveChatTextMessageRenderer ||
                             item.liveChatPaidMessageRenderer;
            if (renderer) {
              const msgId = renderer.id || `yt_${offsetMsec}_${allMessages.length}`;
              if (!seenIds.has(msgId)) {
                seenIds.add(msgId);
                const user = renderer.authorName?.simpleText || 'anonymous';
                const text = (renderer.message?.runs || []).map(r => r.text || '').join('');

                if (offsetSeconds >= startOffset && offsetSeconds <= effectiveEnd) {
                  allMessages.push({
                    id: msgId,
                    offsetSeconds,
                    user,
                    text,
                  });
                }
              }
            }
          }
        }

        // Compute and report progress
        const currentProgressSec = Math.max(startOffset, Math.min(effectiveEnd, lastReportedSec));
        const percent = Math.min(99, Math.round(((currentProgressSec - startOffset) / rangeSpan) * 100));
        const elapsed = (Date.now() - startTime) / 1000;
        let eta = 0;
        if (percent > 2 && elapsed > 1) {
          eta = Math.round((elapsed / (percent / 100)) - elapsed);
        }

        onProgress?.({
          fetched: allMessages.length,
          percent,
          eta,
          rangeStart: startOffset,
          rangeEnd: effectiveEnd,
        });

        if (reachedEnd) {
          break;
        }

        // Extract next continuation
        const continuationsList = liveChat.continuations || [];
        let nextToken = null;
        for (const c of continuationsList) {
          if (c.liveChatReplayContinuationData?.continuation) {
            nextToken = c.liveChatReplayContinuationData.continuation;
            break;
          }
          if (c.playerSeekContinuationData?.continuation) {
            nextToken = c.playerSeekContinuationData.continuation;
            break;
          }
        }

        if (!nextToken || nextToken === continuation) {
          break;
        }

        continuation = nextToken;
        await sleep(40); // Gentle pacing between requests
      }

      allMessages.sort((a, b) => a.offsetSeconds - b.offsetSeconds);

      onProgress?.({
        fetched: allMessages.length,
        percent: 100,
        eta: 0,
        rangeStart: startOffset,
        rangeEnd: effectiveEnd,
      });

      return allMessages;
    },
  };
});
