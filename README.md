# ChatPeak Clipper

Hey! I built **ChatPeak Clipper** because I edit and clip livestreams for YouTube Shorts, TikTok, and Instagram Reels. Anyone who clips VODs knows the pain: scrubbing through 6 to 10 hours of video trying to guess when something actually happened takes forever.

The best signal for a clip-worthy moment is almost always the chat. When chat explodes (masses of KEKWs, Pog, LULs, or hype emotes), something crazy, funny, or clutch just happened on screen. 

ChatPeak Clipper is a free, local Microsoft Edge / Chromium browser extension that analyzes the chat replay of **Twitch** and **YouTube** VODs, catches **every major chat spike**, and gives you a ranked list of timestamps so you can jump straight to the action and clip it.

Built by **Harsh**.

---

## Supported Platforms & How It Works

ChatPeak Clipper uses a clean, modular platform adapter architecture (`adapters/`):

| Platform | Status | Direct Replay Fetch | Seek & Player Control | Notes / Known Limits |
| :--- | :---: | :---: | :---: | :--- |
| **Twitch** | ✅ Full Support | Built-in (GQL) | HTML5 `<video>` & `?t=` | Fast parallel segment download. Works on all public VODs (`twitch.tv/videos/*`). |
| **YouTube** | ✅ Full Support | Built-in (InnerTube) | Player API & `&t=` | Works on past live streams & Premieres (`youtube.com/watch?v=...`) that have chat replay enabled. If chat replay was turned off by the creator, the extension clearly displays *"This video has no chat replay."* |

---

## Features

- **Multi-Platform Detection**: Automatically detects whether you're on Twitch or YouTube, adapting player seeking and metadata extraction seamlessly.
- **Ranked Peak Detection**: Doesn't just find the single biggest moment — it ranks every notable burst across the broadcast using rolling median + robust MAD statistics.
- **Custom Time Ranges**: Analyze only the last hour, first 2 hours, or any custom `[Start → End]` window (supports `HH:MM:SS`, `MM:SS`, plain seconds, or `1h30m`).
- **Use Current Video Time**: Pause the player anywhere, hit the 📍 button, and it drops your current timestamp right into the range input.
- **Smart Range Caching**: Uses IndexedDB keyed by `platform:videoId`. If you analyze `00:30:00` to `01:00:00` and later expand to `01:30:00`, it reuses what's already saved and only downloads the missing 30 minutes.
- **Interactive SVG Timeline**: Visualizes the chat activity curve across the whole broadcast. The analyzed range is lit up while unanalyzed parts are dimmed. Click anywhere on the timeline to seek the video.
- **One-Click Seeking**: Click any timestamp or the "▶ Seek Clip" button to jump the player straight to the suggested clip start (complete with configurable lead-in time).
- **Emote & Sample Breakdown**: Shows top emotes used during the spike (LUL, KEKW, skull emojis, etc.) plus real sample messages.
- **Mark Clipped / Skipped**: Keep track of what you've already cut so you don't repeat work.
- **Export Options**: Copy all timestamps to clipboard, or export full data as CSV or JSON.
- **Universal Chat Importer**: Drop in any chat replay export (TwitchDownloader JSON, CSV, or custom chat log from any source) with start/end range filtering. Even on unsupported websites, you can open the toolbar popup, import any chat file, and analyze peaks!
- **100% Free & Private**: No API keys, no accounts, no background servers, zero tracking. Everything runs directly inside your browser.

---

## How to Install (Edge & Chrome)

Installing unpacked in Chromium takes about 30 seconds:

1. Clone or download this repo to your computer (unzip it if you downloaded a zip).
2. Open **Microsoft Edge** and go to:
   ```
   edge://extensions
   ```
   *(If you're on Chrome, go to `chrome://extensions`)*
3. Turn on **Developer mode** (toggle in the left menu or top-right).
4. Click **Load unpacked**.
5. Select the `chatpeak-clipper` folder (the one containing `manifest.json`).
6. You're done! Pin the extension icon to your browser bar for quick access.

---

## How to Use

1. Open any supported VOD:
   - Twitch: `https://www.twitch.tv/videos/<ID>`
   - YouTube: `https://www.youtube.com/watch?v=<ID>` (past live stream or premiere with chat replay)
2. The ChatPeak Clipper panel will pop up automatically as a clean dark overlay showing the platform badge (or click the extension icon in your toolbar).
3. Set your range if you only want to look at a specific part, or leave it as default for the whole VOD.
4. Hit **🔍 Analyze Chat Peaks** (or use **📂 Import** if you have a local chat log).
5. Once complete, review your ranked peaks, click on timestamps to seek the player, and start clipping!

### Keyboard Shortcuts
- `Alt + P` — Toggle / collapse the floating panel
- `Alt + N` — Seek to the next peak
- `Alt + B` — Seek to the previous peak

---

## Platform Technical Details

### Twitch Adapter (`adapters/twitch.js`)
- Uses Twitch's internal GraphQL endpoint (`https://gql.twitch.tv/gql`) with operation `VideoCommentsByOffsetOrCursor` and client ID `kimne78kx3ncx6brgo4mv6wki5h1ko`.
- Downloads 30-minute segments in parallel with rate-limiting and retry backoff.
- Seeks via HTML5 `<video>` element with fallback to URL hash/query `?t=...`.

### YouTube Adapter (`adapters/youtube.js`)
- Extracts initial continuation token from `conversationBar.liveChatRenderer` inside the watch page source.
- Paginates through YouTube's InnerTube endpoint `/youtubei/v1/live_chat/get_live_chat_replay`.
- Converts `videoOffsetTimeMsec` into absolute `offsetSeconds`.
- Checks whether live chat replay exists; if disabled by creator or a non-stream video, clearly alerts *"This video has no chat replay."*
- Seeks via `document.getElementById('movie_player').seekTo(seconds, true)` with fallback to HTML5 video element and URL `&t=...`.

---

## Running Automated Tests

All tests run locally using Node.js without any dependencies:

```bash
# Unit tests (19/19 tests: parsing, intervals, ranges, adapter matching, storage keying)
node tests/range-and-peaks.test.js

# Live multi-platform end-to-end test (Twitch live VOD & YouTube stream replay)
node tests/test-all-platforms-live.js
```

---

## Author

Created by **Harsh**  
Feedback, suggestions, and PRs are always welcome!
