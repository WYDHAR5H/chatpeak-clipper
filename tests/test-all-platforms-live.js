/**
 * test-all-platforms-live.js — Verifies each platform adapter against live endpoints.
 *
 * Runs end-to-end live tests for:
 *   1. Twitch: Live VOD chat replay fetch, range slicing, and peak detection.
 *   2. YouTube: Live stream chat replay fetch, range slicing, and peak detection.
 *   3. YouTube: Regular video without chat replay -> verifies "This video has no chat replay."
 */

const assert = require('assert');
const TwitchAdapter = require('../adapters/twitch.js');
const YouTubeAdapter = require('../adapters/youtube.js');
const PeakDetector = require('../lib/peak-detector.js');

async function runLiveTests() {
  console.log('\n======================================================');
  console.log('🌐 RUNNING MULTI-PLATFORM LIVE VOD TESTS');
  console.log('======================================================\n');

  const report = {};

  // ─────────────────────────────────────────────────────────────
  // 1. Twitch Live Test
  // ─────────────────────────────────────────────────────────────
  console.log('📺 [1/3] Testing Twitch Adapter on live VOD #2930818942 (Shroud)...');
  try {
    const videoId = '2930818942';
    console.log('  Fetching metadata...');
    const meta = await TwitchAdapter.getVideoMeta(videoId);
    console.log(`  Title: "${meta.title}" | Duration: ${meta.lengthSeconds}s | Streamer: ${meta.channel}`);

    // Fetch 5-minute range: [600s, 900s] (10m -> 15m)
    const range = { startOffset: 600, endOffset: 900 };
    console.log(`  Downloading chat for range [${range.startOffset}s -> ${range.endOffset}s]...`);
    const progressUpdates = [];
    const messages = await TwitchAdapter.getChat(
      videoId,
      range,
      (p) => progressUpdates.push(p.percent)
    );

    console.log(`  Fetched ${messages.length} chat messages in chosen range.`);
    assert(messages.length > 0, 'Should have fetched messages');
    for (const m of messages) {
      assert(m.offsetSeconds >= 600 && m.offsetSeconds <= 900,
        `Message offset ${m.offsetSeconds} outside range`);
    }

    // Run peak detector
    const peaks = PeakDetector.detectPeaks(messages, meta.lengthSeconds, {
      rangeStart: 600,
      rangeEnd: 900,
      clipStartOffset: 20,
    });
    console.log(`  Detected ${peaks.length} chat peaks in range.`);
    if (peaks.length > 0) {
      const top = peaks[0];
      console.log(`  Top Peak: ${top.peakTimestamp} | Multiplier: ${top.multiplier}x | Msgs/min: ${top.messagesPerMin}`);
      console.log(`  Clip: [${top.clipStartTS} -> ${top.clipEndTS}]`);
    }

    report.twitch = { status: 'WORKING', messagesFetched: messages.length, peaksFound: peaks.length };
    console.log('  ✅ Twitch: PASSED\n');
  } catch (err) {
    console.error('  ❌ Twitch failed:', err.message);
    report.twitch = { status: 'FAILED', error: err.message };
  }

  // ─────────────────────────────────────────────────────────────
  // 2. YouTube Live Stream with Chat Replay
  // ─────────────────────────────────────────────────────────────
  console.log('📺 [2/3] Testing YouTube Adapter on live stream replay (The Game Awards 2023: Zu2z5M4gmno)...');
  try {
    const videoId = 'Zu2z5M4gmno';
    console.log('  Fetching metadata & replay continuation...');
    const meta = await YouTubeAdapter.getVideoMeta(videoId);
    console.log(`  Title: "${meta.title}" | Chat Replay: ${meta.hasChatReplay}`);
    assert.strictEqual(meta.hasChatReplay, true, 'Replay must be present');

    // Fetch first 60 seconds of chat replay
    const range = { startOffset: 0, endOffset: 60 };
    console.log(`  Downloading chat replay for range [${range.startOffset}s -> ${range.endOffset}s]...`);
    let latestPct = 0;
    const messages = await YouTubeAdapter.getChat(
      videoId,
      range,
      (p) => { latestPct = p.percent; }
    );

    console.log(`  Fetched ${messages.length} chat messages in range [0s -> 60s].`);
    assert(messages.length > 0, 'Should have parsed replay messages');
    assert(messages[0].offsetSeconds != null, 'Messages must have offsetSeconds');

    const sample = messages[0];
    console.log(`  Sample message @${sample.offsetSeconds}s: ${sample.user}: "${sample.text}"`);

    // Run peak detector
    const peaks = PeakDetector.detectPeaks(messages, meta.lengthSeconds, {
      rangeStart: 0,
      rangeEnd: 60,
    });
    console.log(`  Peak detector completed successfully (${peaks.length} peaks identified in 60s window).`);

    report.youtube = { status: 'WORKING', messagesFetched: messages.length, peaksFound: peaks.length };
    console.log('  ✅ YouTube: PASSED\n');
  } catch (err) {
    console.error('  ❌ YouTube failed:', err.message);
    report.youtube = { status: 'FAILED', error: err.message };
  }

  // ─────────────────────────────────────────────────────────────
  // 3. YouTube Video WITHOUT Chat Replay
  // ─────────────────────────────────────────────────────────────
  console.log('📺 [3/3] Testing YouTube Adapter on video without chat replay (Apple Event: PYnfJl2OSic)...');
  try {
    const videoId = 'PYnfJl2OSic';
    const meta = await YouTubeAdapter.getVideoMeta(videoId);
    console.log(`  Title: "${meta.title}" | Chat Replay: ${meta.hasChatReplay}`);
    assert.strictEqual(meta.hasChatReplay, false, 'Should correctly detect no chat replay');

    let threwExpected = false;
    try {
      await YouTubeAdapter.getChat(videoId, { startOffset: 0, endOffset: 120 });
    } catch (e) {
      if (e.message.includes('This video has no chat replay.')) {
        threwExpected = true;
        console.log(`  Received expected message: "${e.message}"`);
      }
    }
    assert.strictEqual(threwExpected, true, 'Must throw "This video has no chat replay."');

    report.youtubeNoReplay = { status: 'WORKING', messageVerified: true };
    console.log('  ✅ YouTube (No Chat Replay): PASSED\n');
  } catch (err) {
    console.error('  ❌ YouTube (No Chat Replay) failed:', err.message);
    report.youtubeNoReplay = { status: 'FAILED', error: err.message };
  }

  // ─────────────────────────────────────────────────────────────
  // SUMMARY REPORT
  // ─────────────────────────────────────────────────────────────
  console.log('======================================================');
  console.log('📊 MULTI-PLATFORM TEST SUMMARY REPORT:');
  console.log('======================================================');
  console.log(JSON.stringify(report, null, 2));
  console.log('======================================================\n');
}

runLiveTests().catch(console.error);
