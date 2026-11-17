const https = require('https');
const path = require('path');
const fs = require('fs');

// Load twitch-chat-source.js and peak-detector.js
const sourceCode = fs.readFileSync(path.join(__dirname, '../lib/twitch-chat-source.js'), 'utf8');
const peakCode = fs.readFileSync(path.join(__dirname, '../lib/peak-detector.js'), 'utf8');

const vm = require('vm');
const sandbox = {
  console,
  fetch: (url, opts) => {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        port: 443,
        path: u.pathname,
        method: opts.method || 'POST',
        headers: opts.headers || {},
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      });
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  },
  setTimeout,
  clearTimeout,
  DOMException: class DOMException extends Error {},
};

vm.createContext(sandbox);
vm.runInContext(sourceCode, sandbox);
vm.runInContext(peakCode, sandbox);

const { getChat, getVideoMeta } = sandbox.TwitchChatSource;
const { detectPeaks, formatTime } = sandbox.PeakDetector;

async function findRecentVod() {
  const payload = JSON.stringify([{
    operationName: 'FilterableVideoTower_Videos',
    variables: {
      limit: 5,
      channelOwnerLogin: 'shroud',
      broadcastType: 'ARCHIVE',
      videoSort: 'TIME'
    },
    query: `query FilterableVideoTower_Videos($limit: Int!, $channelOwnerLogin: String!, $broadcastType: BroadcastType, $videoSort: VideoSort) {
      user(login: $channelOwnerLogin) {
        videos(first: $limit, types: [$broadcastType], sort: $videoSort) {
          edges {
            node {
              id
              title
              lengthSeconds
              owner {
                displayName
              }
            }
          }
        }
      }
    }`
  }]);

  const res = await sandbox.fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      'Content-Type': 'application/json',
    },
    body: payload,
  });

  const json = await res.json();
  const edges = json[0]?.data?.user?.videos?.edges || [];
  return edges.map(e => e.node);
}

async function run() {
  console.log('🔍 Looking up real public VODs on Twitch...');
  let videos = [];
  try {
    videos = await findRecentVod();
  } catch (err) {
    console.log('Lookup error:', err.message);
  }

  // If shroud has no public VODs, try riotgames or eslcs
  if (!videos || videos.length === 0) {
    console.log('Trying alternative channel...');
    const payload = JSON.stringify([{
      operationName: 'FilterableVideoTower_Videos',
      variables: {
        limit: 5,
        channelOwnerLogin: 'eslcs',
        broadcastType: 'ARCHIVE',
        videoSort: 'TIME'
      },
      query: `query FilterableVideoTower_Videos($limit: Int!, $channelOwnerLogin: String!, $broadcastType: BroadcastType, $videoSort: VideoSort) {
        user(login: $channelOwnerLogin) {
          videos(first: $limit, types: [$broadcastType], sort: $videoSort) {
            edges {
              node {
                id
                title
                lengthSeconds
                owner {
                  displayName
                }
              }
            }
          }
        }
      }`
    }]);
    const res = await sandbox.fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    const json = await res.json();
    videos = (json[0]?.data?.user?.videos?.edges || []).map(e => e.node);
  }

  console.log(`Found ${videos.length} videos:`);
  for (const v of videos) {
    console.log(` - VOD ID: ${v.id} | Title: "${v.title}" | Duration: ${formatTime(v.lengthSeconds)}`);
  }

  if (videos.length === 0) {
    console.log('No public VODs found on target channels. Testing with fallback test ID.');
    return;
  }

  const testVod = videos[0];
  console.log(`\n🎯 Testing Custom Range Analysis on VOD #${testVod.id}`);
  console.log(`Title: ${testVod.title}`);
  console.log(`Channel: ${testVod.owner?.displayName}`);
  console.log(`Total Length: ${formatTime(testVod.lengthSeconds)} (${testVod.lengthSeconds}s)`);

  // Target: analyze ONLY a 30-minute range (e.g. 1800s to 3600s, or 0s to 1800s)
  const rangeStart = 1800; // 30m
  const rangeEnd = 3600;   // 60m (30 minutes total)
  console.log(`\n⏳ Fetching chat replay ONLY for range [${formatTime(rangeStart)} → ${formatTime(rangeEnd)}] (30 minutes)...`);

  let lastProgress = 0;
  const messages = await getChat(
    testVod.id,
    rangeStart,
    rangeEnd,
    (p) => {
      if (p.percent !== lastProgress && p.percent % 25 === 0) {
        console.log(`   Progress: ${p.percent}% (${p.fetched} msgs fetched)`);
        lastProgress = p.percent;
      }
    },
    null
  );

  console.log(`\n✅ Download complete! Total messages in range: ${messages.length}`);
  if (messages.length > 0) {
    console.log(`   First message offset: ${formatTime(messages[0].offsetSeconds)} (${messages[0].offsetSeconds}s)`);
    console.log(`   Last message offset:  ${formatTime(messages[messages.length - 1].offsetSeconds)} (${messages[messages.length - 1].offsetSeconds}s)`);
    
    // Verify all messages are inside [rangeStart, rangeEnd]
    const outOfBounds = messages.some(m => m.offsetSeconds < rangeStart || m.offsetSeconds > rangeEnd);
    console.log(`   Range confinement check: ${outOfBounds ? '❌ FAILED' : '✅ PASSED (all messages strictly in range)'}`);

    // Run peak detection on the 30-minute range
    console.log(`\n🔬 Running Peak Detection on 30-minute range...`);
    const peaks = detectPeaks(messages, testVod.lengthSeconds, {
      rangeStart,
      rangeEnd,
      clipStartOffset: 20,
    });

    console.log(`Found ${peaks.length} peaks in the 30-minute window:`);
    for (const p of peaks.slice(0, 5)) {
      console.log(`   #${p.rank} Peak at ${p.peakTimestamp} | Clip: ${p.clipStartTS} → ${p.clipEndTS} | Score: ${p.score} | ${p.multiplier}x normal | Tier: ${p.tier.toUpperCase()}`);
      if (p.topWords.length > 0) {
        console.log(`      Top words: ${p.topWords.map(w => `${w.word}(${w.count})`).join(', ')}`);
      }
      if (p.sampleMsgs.length > 0) {
        console.log(`      Sample: "${p.sampleMsgs[0].user}: ${p.sampleMsgs[0].text.slice(0, 60)}"`);
      }
    }
  } else {
    console.log('No chat messages returned for this segment (chat replay may be empty or disabled).');
  }
}

run().catch(err => {
  console.error('Test error:', err);
});
