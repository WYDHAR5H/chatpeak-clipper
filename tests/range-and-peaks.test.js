/**
 * range-and-peaks.test.js — Node.js test suite for Range Analysis, Timestamp Parsing,
 * Interval Caching, and Peak Detection.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Load peak-detector.js
const peakDetectorCode = fs.readFileSync(path.join(__dirname, '../lib/peak-detector.js'), 'utf8');
const vm = require('vm');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(peakDetectorCode, ctx);
const { detectPeaks, getTimeline, parseTimestamp, formatTime, SENSITIVITY_PRESETS } = ctx.PeakDetector;

// Load storage.js interval logic
const storageCode = fs.readFileSync(path.join(__dirname, '../lib/storage.js'), 'utf8');
const storageCtx = { console, indexedDB: {}, chrome: { storage: { local: {} } } };
vm.createContext(storageCtx);
vm.runInContext(storageCode, storageCtx);
const { normalizeRanges, getMissingIntervals, toStorageKey } = storageCtx.Storage;

// Load platform adapters
const TwitchAdapter = require('../adapters/twitch.js');
const YouTubeAdapter = require('../adapters/youtube.js');
const Adapters = require('../adapters/index.js');

function toPlain(obj) {
  return JSON.parse(JSON.stringify(obj));
}

let totalTests = 0;
let passed = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    console.error(err.stack);
  }
}

console.log('\n🧪 Running ChatPeak Clipper Range & Peak Detection Tests...\n');

// ─── 1. Timestamp Parsing Tests ───
console.log('--- Timestamp Parsing ---');

test('parseTimestamp: HH:MM:SS format', () => {
  assert.strictEqual(parseTimestamp('01:30:00'), 5400);
  assert.strictEqual(parseTimestamp('00:00:00'), 0);
  assert.strictEqual(parseTimestamp('02:15:30'), 8130);
  assert.strictEqual(parseTimestamp('10:00:00'), 36000);
});

test('parseTimestamp: MM:SS format', () => {
  assert.strictEqual(parseTimestamp('45:00'), 2700);
  assert.strictEqual(parseTimestamp('05:30'), 330);
  assert.strictEqual(parseTimestamp('00:45'), 45);
});

test('parseTimestamp: Plain numeric seconds', () => {
  assert.strictEqual(parseTimestamp('5400'), 5400);
  assert.strictEqual(parseTimestamp('0'), 0);
  assert.strictEqual(parseTimestamp('123.45'), 123.45);
  assert.strictEqual(parseTimestamp(3600), 3600);
});

test('parseTimestamp: Twitch styles (1h30m0s, 45m10s, 2h, 30s)', () => {
  assert.strictEqual(parseTimestamp('1h30m0s'), 5400);
  assert.strictEqual(parseTimestamp('1h30m'), 5400);
  assert.strictEqual(parseTimestamp('45m10s'), 2710);
  assert.strictEqual(parseTimestamp('2h'), 7200);
  assert.strictEqual(parseTimestamp('30s'), 30);
  assert.strictEqual(parseTimestamp('1h 30m 15s'), 5415);
  assert.strictEqual(parseTimestamp('10m'), 600);
});

test('parseTimestamp: Invalid inputs return null', () => {
  assert.strictEqual(parseTimestamp(''), null);
  assert.strictEqual(parseTimestamp(null), null);
  assert.strictEqual(parseTimestamp('abc'), null);
  assert.strictEqual(parseTimestamp('invalid:time:format'), null);
  assert.strictEqual(parseTimestamp('-500'), null);
});

test('formatTime: seconds to HH:MM:SS', () => {
  assert.strictEqual(formatTime(0), '00:00:00');
  assert.strictEqual(formatTime(5400), '01:30:00');
  assert.strictEqual(formatTime(3661), '01:01:01');
  assert.strictEqual(formatTime(36000), '10:00:00');
});

// ─── 2. Interval Caching & Missing Ranges ───
console.log('\n--- Interval Caching & Missing Ranges ---');

test('normalizeRanges: merges overlapping and adjacent intervals', () => {
  const input = [[100, 200], [150, 300], [400, 500], [500, 600]];
  const merged = normalizeRanges(input);
  assert.deepStrictEqual(toPlain(merged), [[100, 300], [400, 600]]);
});

test('getMissingIntervals: empty cache -> whole range missing', () => {
  const missing = getMissingIntervals([], 1000, 4000);
  assert.deepStrictEqual(toPlain(missing), [[1000, 4000]]);
});

test('getMissingIntervals: full cache -> nothing missing', () => {
  const missing = getMissingIntervals([[0, 5000]], 1000, 4000);
  assert.deepStrictEqual(toPlain(missing), []);
});

test('getMissingIntervals: partial overlap at beginning', () => {
  const missing = getMissingIntervals([[0, 2000]], 1000, 4000);
  assert.deepStrictEqual(toPlain(missing), [[2000, 4000]]);
});

test('getMissingIntervals: partial overlap at end', () => {
  const missing = getMissingIntervals([[3000, 5000]], 1000, 4000);
  assert.deepStrictEqual(toPlain(missing), [[1000, 3000]]);
});

test('getMissingIntervals: cache has hole in middle', () => {
  const missing = getMissingIntervals([[1000, 2000], [3000, 4000]], 0, 5000);
  assert.deepStrictEqual(toPlain(missing), [[0, 1000], [2000, 3000], [4000, 5000]]);
});

// ─── 3. Range-Based Peak Detection Tests ───
console.log('\n--- Range-Based Peak Detection ---');

function generateMessages(segments, baseRate, vodLength) {
  const msgs = [];
  let id = 0;
  for (let t = 0; t < vodLength; t += 10) {
    for (let i = 0; i < baseRate; i++) {
      msgs.push({
        offsetSeconds: t + Math.random() * 10,
        user: `user${id % 150}`,
        text: `normal message ${id}`,
        id: `m-${id++}`,
      });
    }
  }
  for (const seg of segments) {
    for (let t = seg.start; t < seg.end; t += 10) {
      for (let i = 0; i < seg.rate; i++) {
        msgs.push({
          offsetSeconds: t + Math.random() * 10,
          user: `spike_user_${id % 30}`,
          text: seg.hype ? 'KEKW KEKW KEKW LULW 🔥🔥🔥' : `spike message ${id}`,
          id: `m-${id++}`,
        });
      }
    }
  }
  msgs.sort((a, b) => a.offsetSeconds - b.offsetSeconds);
  return msgs;
}

test('detectPeaks: Custom range [1500, 3500] detects only spikes within that range', () => {
  const vodLen = 7200; // 2 hours
  const spikes = [
    { start: 600,  end: 650,  rate: 60, hype: true },  // Outside (before)
    { start: 1800, end: 1840, rate: 45, hype: true },  // INSIDE
    { start: 3000, end: 3040, rate: 40, hype: true },  // INSIDE
    { start: 4500, end: 4540, rate: 60, hype: true },  // Outside (after)
    { start: 6000, end: 6040, rate: 50, hype: true },  // Outside (after)
  ];

  const msgs = generateMessages(spikes, 3, vodLen);

  const peaks = detectPeaks(msgs, vodLen, {
    rangeStart: 1500,
    rangeEnd: 3500,
  });

  assert(peaks.length >= 2, `Expected at least 2 peaks in range, found ${peaks.length}`);

  for (const p of peaks) {
    assert(p.peakTime >= 1500 && p.peakTime <= 3500,
      `Peak time ${p.peakTime} (${p.peakTimestamp}) must be inside range [1500, 3500]`);
  }

  const found1800 = peaks.some(p => Math.abs(p.peakTime - 1820) <= 60);
  const found3000 = peaks.some(p => Math.abs(p.peakTime - 3020) <= 60);
  assert(found1800, 'Spike near 1820s detected');
  assert(found3000, 'Spike near 3020s detected');

  const p1800 = peaks.find(p => Math.abs(p.peakTime - 1820) <= 60);
  assert(p1800.peakTimestamp.startsWith('00:30'),
    `Timestamp should be absolute (~00:30:20), got ${p1800.peakTimestamp}`);
});

test('detectPeaks: Custom clipStartOffset configuration', () => {
  const vodLen = 3600;
  const spikes = [{ start: 1000, end: 1040, rate: 50, hype: true }];
  const msgs = generateMessages(spikes, 2, vodLen);

  const peaksDefault = detectPeaks(msgs, vodLen, { clipStartOffset: 20 });
  const peaksCustom = detectPeaks(msgs, vodLen, { clipStartOffset: 45 });

  assert(peaksDefault.length > 0 && peaksCustom.length > 0);
  assert(peaksCustom[0].clipStart <= peaksDefault[0].clipStart,
    `clipStart with 45s offset (${peaksCustom[0].clipStart}) should be <= default 20s offset (${peaksDefault[0].clipStart})`);
});

test('getTimeline: returns rangeStart and rangeEnd metadata', () => {
  const vodLen = 3600;
  const msgs = generateMessages([{ start: 500, end: 530, rate: 30, hype: true }], 2, vodLen);
  const tl = getTimeline(msgs, vodLen, { rangeStart: 600, rangeEnd: 2400 });

  assert.strictEqual(tl.rangeStart, 600);
  assert.strictEqual(tl.rangeEnd, 2400);
  assert.strictEqual(tl.vodLength, 3600);
  assert(tl.times.length > 0);
});

// ─── 4. Multi-Platform Adapters & Keying Tests ───
console.log('\n--- Multi-Platform Adapters & Storage Keying ---');

test('TwitchAdapter: URL matching and videoId extraction', () => {
  assert.strictEqual(TwitchAdapter.matchesUrl('https://www.twitch.tv/videos/2930818942'), true);
  assert.strictEqual(TwitchAdapter.matchesUrl('https://twitch.tv/videos/12345'), true);
  assert.strictEqual(TwitchAdapter.matchesUrl('https://www.twitch.tv/shroud'), false);
  assert.strictEqual(TwitchAdapter.getVideoId('https://www.twitch.tv/videos/2930818942'), '2930818942');
  assert.strictEqual(TwitchAdapter.isSupported, true);
  assert.strictEqual(TwitchAdapter.name, 'twitch');
});

test('YouTubeAdapter: URL matching and videoId extraction', () => {
  assert.strictEqual(YouTubeAdapter.matchesUrl('https://www.youtube.com/watch?v=Zu2z5M4gmno'), true);
  assert.strictEqual(YouTubeAdapter.matchesUrl('https://m.youtube.com/watch?v=Zu2z5M4gmno&t=100s'), true);
  assert.strictEqual(YouTubeAdapter.matchesUrl('https://youtu.be/Zu2z5M4gmno'), true);
  assert.strictEqual(YouTubeAdapter.matchesUrl('https://www.youtube.com/feed/subscriptions'), false);
  assert.strictEqual(YouTubeAdapter.getVideoId('https://www.youtube.com/watch?v=Zu2z5M4gmno'), 'Zu2z5M4gmno');
  assert.strictEqual(YouTubeAdapter.getVideoId('https://youtu.be/Zu2z5M4gmno?t=5'), 'Zu2z5M4gmno');
  assert.strictEqual(YouTubeAdapter.isSupported, true);
  assert.strictEqual(YouTubeAdapter.name, 'youtube');
});

test('Adapters Registry: Resolves correct adapter by URL and name', () => {
  const tw = Adapters.getAdapterForUrl('https://www.twitch.tv/videos/987654');
  assert.strictEqual(tw?.name, 'twitch');

  const yt = Adapters.getAdapterForUrl('https://www.youtube.com/watch?v=Zu2z5M4gmno');
  assert.strictEqual(yt?.name, 'youtube');

  const unknown = Adapters.getAdapterForUrl('https://vimeo.com/123456');
  assert.strictEqual(unknown, null);

  assert.strictEqual(Adapters.getAdapterByName('youtube')?.displayName, 'YouTube');
  assert.strictEqual(Adapters.getAdapterByName('twitch')?.displayName, 'Twitch');
});

test('toStorageKey: Compound platform keying prevents collisions', () => {
  assert.strictEqual(toStorageKey('2930818942', 'twitch'), 'twitch:2930818942');
  assert.strictEqual(toStorageKey('Zu2z5M4gmno', 'youtube'), 'youtube:Zu2z5M4gmno');
  // Does not double prefix if already compound
  assert.strictEqual(toStorageKey('youtube:Zu2z5M4gmno', 'youtube'), 'youtube:Zu2z5M4gmno');
  // Backwards compatibility when platform omitted
  assert.strictEqual(toStorageKey('2930818942'), '2930818942');
});

console.log(`\n========================================`);
console.log(`Results: ${passed} / ${totalTests} tests passed`);
if (passed === totalTests) {
  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!\n');
} else {
  console.log('⚠️ SOME TESTS FAILED.\n');
  process.exit(1);
}
