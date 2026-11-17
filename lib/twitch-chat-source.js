/**
 * lib/twitch-chat-source.js — Compatibility wrapper for Twitch adapter.
 *
 * Forwards calls to adapters/twitch.js.
 */

(function (root) {
  if (typeof module === 'object' && module.exports) {
    module.exports = require('../adapters/twitch.js');
  } else if (root.Adapters && root.Adapters.twitch) {
    root.TwitchChatSource = root.Adapters.twitch;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
