/**
 * service-worker.js — Background service worker for ChatPeak Clipper.
 *
 * Handles:
 *   - Multi-platform adapter dispatch (Twitch, YouTube)
 *   - Range-aware chat fetching via platform adapters
 *   - Interval-based IndexedDB caching (downloads only missing sub-ranges, keyed by platform:videoId)
 *   - Peak detection execution & timeline generation
 *   - Import handling with range filtering
 *   - Last-used range per VOD & platform persistence
 *   - Keyboard shortcuts & message routing
 *
 * @author Harsh
 */

importScripts(
  '../adapters/twitch.js',
  '../adapters/youtube.js',
  '../adapters/index.js',
  '../lib/peak-detector.js',
  '../lib/storage.js',
  '../lib/importers.js',
  '../lib/export.js'
);

const activeAborts = new Map();

function resolveAdapter(platform, url) {
  if (platform) {
    const a = Adapters.getAdapterByName(platform);
    if (a) return a;
  }
  if (url) {
    const a = Adapters.getAdapterForUrl(url);
    if (a) return a;
  }
  return Adapters.getAdapterByName('twitch');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {

    // ── Fetch video metadata ──
    case 'getVideoMeta': {
      const adapter = resolveAdapter(msg.platform, msg.url);
      adapter.getVideoMeta(msg.videoId)
        .then(meta => sendResponse({ success: true, meta, platform: adapter.name }))
        .catch(err => sendResponse({ success: false, error: err.message, platform: adapter.name }));
      return true;
    }

    // ── Range-aware chat fetch & cache ──
    case 'fetchChat': {
      const adapter = resolveAdapter(msg.platform, msg.url);
      const platform = adapter.name;

      if (!adapter.isSupported) {
        sendResponse({
          success: false,
          error: adapter.unsupportedMessage || `${adapter.displayName} is not supported yet, use Import chat file`,
          code: 'PLATFORM_UNSUPPORTED',
          platform,
        });
        return true;
      }

      const { videoId, vodLengthSeconds } = msg;
      const rangeStart = Math.max(0, msg.rangeStart ?? 0);
      const rangeEnd = Math.min(vodLengthSeconds, msg.rangeEnd ?? vodLengthSeconds);
      const storageKey = Storage.toStorageKey(videoId, platform);

      // Check cache for this range (with 600s lead-in)
      Storage.getCachedChatForRange(videoId, rangeStart, rangeEnd, 600, platform).then(async (cacheStatus) => {
        if (cacheStatus.isFullyCached) {
          sendResponse({
            success: true,
            type: 'complete',
            messages: cacheStatus.messages,
            meta: cacheStatus.meta,
            fromCache: true,
            rangeStart,
            rangeEnd,
            platform,
          });
          return;
        }

        // Missing sub-ranges need to be downloaded
        const missingRanges = cacheStatus.missingRanges;
        const abortController = new AbortController();
        activeAborts.set(storageKey, abortController);

        const tabId = sender.tab?.id;

        try {
          // Fetch video metadata first if not present in cache
          let meta = cacheStatus.meta;
          if (!meta) {
            meta = await adapter.getVideoMeta(videoId, abortController.signal).catch(() => ({
              id: videoId,
              title: '',
              lengthSeconds: vodLengthSeconds,
              channel: '',
              hasChatReplay: true,
            }));
          }

          if (meta.hasChatReplay === false) {
            throw new Error('This video has no chat replay.');
          }

          let totalMissingDuration = 0;
          for (const [s, e] of missingRanges) totalMissingDuration += (e - s);

          let completedDuration = 0;

          // Download each missing interval
          for (const [misStart, misEnd] of missingRanges) {
            if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

            const misDuration = misEnd - misStart;

            const fetchedMessages = await adapter.getChat(
              videoId,
              { startOffset: misStart, endOffset: misEnd },
              (p) => {
                if (tabId) {
                  // Scale progress across all missing intervals
                  const currentIntervalProgress = (p.percent / 100) * misDuration;
                  const totalProgressSec = completedDuration + currentIntervalProgress;
                  const overallPct = totalMissingDuration > 0
                    ? Math.min(99, Math.round((totalProgressSec / totalMissingDuration) * 100))
                    : p.percent;

                  chrome.tabs.sendMessage(tabId, {
                    action: 'chatProgress',
                    videoId,
                    platform,
                    fetched: p.fetched,
                    percent: overallPct,
                    eta: p.eta,
                    rangeStart,
                    rangeEnd,
                  }).catch(() => {});
                }
              },
              abortController.signal
            );

            // Merge fetched sub-range into cache immediately
            await Storage.cacheChatMessagesForRange(videoId, fetchedMessages, [misStart, misEnd], meta, platform);
            completedDuration += misDuration;
          }

          activeAborts.delete(storageKey);

          // Retrieve combined messages for the requested range (including cached lead-in)
          const finalResult = await Storage.getCachedChatForRange(videoId, rangeStart, rangeEnd, 600, platform);

          sendResponse({
            success: true,
            type: 'complete',
            messages: finalResult.messages,
            meta,
            fromCache: false,
            rangeStart,
            rangeEnd,
            platform,
          });
        } catch (err) {
          activeAborts.delete(storageKey);
          if (err.name === 'AbortError') {
            sendResponse({ success: false, error: 'Download cancelled.', code: 'CANCELLED', platform });
          } else {
            sendResponse({ success: false, error: err.message, code: 'FETCH_ERROR', platform });
          }
        }
      }).catch(err => {
        sendResponse({ success: false, error: err.message, code: 'CACHE_ERROR', platform });
      });

      return true;
    }

    // ── Cancel active download ──
    case 'cancelFetch': {
      const platform = msg.platform || 'twitch';
      const storageKey = Storage.toStorageKey(msg.videoId, platform);
      const ctrl = activeAborts.get(storageKey) || activeAborts.get(msg.videoId);
      if (ctrl) {
        ctrl.abort();
        activeAborts.delete(storageKey);
        activeAborts.delete(msg.videoId);
      }
      sendResponse({ success: true });
      return true;
    }

    // ── Run peak detection ──
    case 'detectPeaks': {
      try {
        const peaks = PeakDetector.detectPeaks(msg.messages, msg.vodLengthSeconds, msg.options);
        const timeline = PeakDetector.getTimeline(msg.messages, msg.vodLengthSeconds, msg.options);
        sendResponse({ success: true, peaks, timeline });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    // ── Import chat file with range filter ──
    case 'importChat': {
      try {
        const platform = msg.platform || 'imported';
        const result = Importers.importChatFile(msg.content, msg.filename, msg.rangeStart, msg.rangeEnd);
        const vodLen = result.meta.lengthSeconds;
        const range = [msg.rangeStart ?? 0, msg.rangeEnd ?? vodLen];
        const vidId = msg.videoId || result.meta.id || 'imported_video';
        result.meta.id = vidId;

        Storage.cacheChatMessagesForRange(vidId, result.messages, range, result.meta, platform)
          .then(() => sendResponse({ success: true, ...result, platform }))
          .catch(() => sendResponse({ success: true, ...result, platform }));
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    // ── Cache management ──
    case 'clearCache': {
      Storage.clearChatCache(msg.videoId, msg.platform)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'listCache': {
      Storage.listCachedVideos()
        .then(ids => sendResponse({ success: true, videoIds: ids }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // ── Clip status ──
    case 'getClipStatuses': {
      Storage.getClipStatuses(msg.videoId, msg.platform)
        .then(statuses => sendResponse({ success: true, statuses }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'setClipStatus': {
      Storage.setClipStatus(msg.videoId, msg.peakTime, msg.status, msg.platform)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // ── Last range per VOD ──
    case 'getLastRange': {
      Storage.getLastRange(msg.videoId, msg.platform)
        .then(range => sendResponse({ success: true, range }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'saveLastRange': {
      Storage.saveLastRange(msg.videoId, msg.range, msg.platform)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // ── Settings ──
    case 'getSettings': {
      Storage.getSettings()
        .then(settings => sendResponse({ success: true, settings }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'saveSettings': {
      Storage.saveSettings(msg.settings)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'parseTimestamp': {
      const seconds = PeakDetector.parseTimestamp(msg.input);
      sendResponse({ success: true, seconds });
      return true;
    }

    default:
      sendResponse({ success: false, error: `Unknown action: ${msg.action}` });
      return true;
  }
});

// ─── Keyboard shortcuts ───
chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'command', command }).catch(() => {});
    }
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    Storage.saveSettings({
      sensitivity: 'medium',
      binSize: 10,
      baselineWindow: 60,
      minPeakDistance: 60,
      leadIn: 20,
      clipStartOffset: 20,
      leadOut: 15,
      topN: 20,
      weights: [0.6, 0.2, 0.2],
    }).catch(() => {});
  }
});
