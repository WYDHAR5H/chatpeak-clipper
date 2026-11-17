/**
 * adapters/index.js — Registry and loader for ChatPeak Clipper platform adapters.
 *
 * Exposes:
 *   - getAdapterForUrl(url) -> Adapter | null
 *   - getAdapterByName(name) -> Adapter | null
 *   - getAllAdapters() -> Adapter[]
 *
 * @module adapters/index
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const twitch = require('./twitch.js');
    const youtube = require('./youtube.js');
    module.exports = factory({ twitch, youtube });
  } else {
    root.Adapters = root.Adapters || {};
    const registry = factory(root.Adapters);
    Object.assign(root.Adapters, registry);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (loadedAdapters) {
  'use strict';

  const adapterList = [
    loadedAdapters.twitch,
    loadedAdapters.youtube,
  ].filter(Boolean);

  function getAdapterForUrl(url) {
    if (!url) return null;
    for (const a of adapterList) {
      if (a && typeof a.matchesUrl === 'function' && a.matchesUrl(url)) {
        return a;
      }
    }
    return null;
  }

  function getAdapterByName(name) {
    if (!name) return null;
    const lower = String(name).toLowerCase();
    for (const a of adapterList) {
      if (a && a.name.toLowerCase() === lower) {
        return a;
      }
    }
    return null;
  }

  function getAllAdapters() {
    return [...adapterList];
  }

  return {
    list: adapterList,
    getAdapterForUrl,
    getAdapterByName,
    getAllAdapters,
  };
});
