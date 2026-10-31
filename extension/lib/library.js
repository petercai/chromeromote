/**
 * Watch library: "recent" (last 10 watched, across all synced Chromebooks) and "bookmarks".
 * Pure functions over immutable data; persistence (chrome.storage.sync) lives in the service
 * worker. Loaded as a classic script (service worker importScripts, phone PWA, Node tests) and
 * exposed as `globalThis.CRLib`.
 *
 * Entry shape: {key, url, title, time, duration, updatedAt, device}
 *   key    = URL without the hash (one entry per page/episode)
 *   time   = playback position in seconds
 *   device = name of the Chromebook it was watched / bookmarked on
 *
 * Storage layout (chrome.storage.sync quotas: 8 KB per item, 100 KB total, 512 items):
 *   'recent'          -> array of up to 10 entries (one item, ~3 KB)
 *   'bm_<fnv1a(key)>' -> one item PER bookmark (100 bookmarks would not fit in one 8 KB item)
 */
(function (root) {
  'use strict';

  const RECENT_MAX = 10;
  const BOOKMARK_MAX = 100;
  const MIN_WATCH_SECONDS = 15; // ignore trailers / accidental clicks
  const RESUME_REWIND_SECONDS = 5; // resume a little earlier to pick up the thread
  const TITLE_MAX = 100;
  const DEVICE_MAX = 40;
  const BOOKMARK_PREFIX = 'bm_';

  const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);
  const clip = (s, max) => {
    const t = String(s || '').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };

  /** Stable identity of a watch: the URL without its fragment. Returns null for non-http(s). */
  const entryKey = (url) => {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return null;
      u.hash = '';
      return u.toString();
    } catch (_) {
      return null;
    }
  };

  const makeEntry = ({ url, title, time, duration, device, now = Date.now() }) => {
    const key = entryKey(url);
    if (!key) return null;
    return Object.freeze({
      key,
      url: key,
      title: clip(title, TITLE_MAX) || clip(key, TITLE_MAX),
      time: isFiniteNumber(time) && time > 0 ? Math.floor(time) : 0,
      duration: isFiniteNumber(duration) && duration > 0 ? Math.floor(duration) : null,
      updatedAt: now,
      device: clip(device, DEVICE_MAX) || null,
    });
  };

  /** Is this video state worth remembering as a "recent watch"? */
  const shouldRecord = (state) =>
    Boolean(state && state.hasVideo && isFiniteNumber(state.t) && state.t >= MIN_WATCH_SECONDS);

  /** Where to resume: a few seconds before the saved position, never past the end. */
  const resumePosition = (time, duration) => {
    const back = Math.max(0, (isFiniteNumber(time) ? time : 0) - RESUME_REWIND_SECONDS);
    return isFiniteNumber(duration) && duration > 0 ? Math.min(back, Math.max(0, duration - RESUME_REWIND_SECONDS)) : back;
  };

  const withoutKey = (list, key) => (list || []).filter((e) => e && e.key !== key);

  /** Newest first, deduped by key, capped. */
  const upsertRecent = (list, entry, max = RECENT_MAX) => (entry ? [entry, ...withoutKey(list, entry.key)].slice(0, max) : list || []);

  const removeRecent = (list, key) => withoutKey(list, key);

  /** FNV-1a 32-bit hash -> short, stable storage key for one bookmark. */
  const bookmarkStorageKey = (key) => {
    let h = 0x811c9dc5;
    const s = String(key);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${BOOKMARK_PREFIX}${h.toString(16).padStart(8, '0')}`;
  };

  const isBookmarkStorageKey = (k) => typeof k === 'string' && k.startsWith(BOOKMARK_PREFIX);

  /** All bookmark items of a storage snapshot, newest first. */
  const bookmarksFromStore = (items) =>
    Object.entries(items || {})
      .filter(([k, v]) => isBookmarkStorageKey(k) && v && v.key)
      .map(([, v]) => v)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  root.CRLib = Object.freeze({
    RECENT_MAX,
    BOOKMARK_MAX,
    MIN_WATCH_SECONDS,
    RESUME_REWIND_SECONDS,
    TITLE_MAX,
    entryKey,
    makeEntry,
    shouldRecord,
    resumePosition,
    upsertRecent,
    removeRecent,
    bookmarkStorageKey,
    isBookmarkStorageKey,
    bookmarksFromStore,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
