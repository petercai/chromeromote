/**
 * Shared wire protocol for the media remote.
 *
 * Loaded as a classic script in every context (service worker via importScripts-style
 * side-effect import, offscreen page, content scripts, phone PWA) and exposes a frozen
 * namespace on `globalThis.CR`. Everything here is pure / immutable so both ends of the
 * data channel share one definition and can never drift apart.
 */
(function (root) {
  'use strict';

  const PROTOCOL_VERSION = 1;

  // Command names sent by the phone. Grouped by the executor that handles them.
  const CMD = Object.freeze({
    // Browser-level (service worker, chrome.tabs / chrome.windows)
    BACK: 'back',
    FORWARD: 'forward',
    RELOAD: 'reload',
    HOME: 'home',
    FULLSCREEN: 'fullscreen',
    // Watch library (service worker, chrome.storage.local)
    LIBRARY_LIST: 'libraryList',
    BOOKMARK_ADD: 'bookmarkAdd',
    BOOKMARK_REMOVE: 'bookmarkRemove',
    RECENT_REMOVE: 'recentRemove',
    OPEN_ENTRY: 'openEntry',
    // Page-level (content script, top frame only)
    MOVE: 'move',
    CLICK: 'click',
    SCROLL: 'scroll',
    PAGE_UP: 'pageUp',
    PAGE_DOWN: 'pageDown',
    // Episode list (content script, top frame only; design 3.11)
    PLAYLIST_GET: 'playlistGet',
    PLAYLIST_OPEN: 'playlistOpen',
    PLAYLIST_STEP: 'playlistStep',
    // Video-level (content script, whichever frame owns the <video>)
    PLAY_PAUSE: 'playPause',
    SEEK_BY: 'seekBy',
    SEEK_TO: 'seekTo',
    VOLUME: 'volume',
    // YouTube catalog (service worker via a youtube.com tab; design 3.13 option A)
    YT_BROWSE: 'ytBrowse',
    YT_UP_NEXT: 'ytUpNext',
    YT_OPEN: 'ytOpen',
    YT_WATCH_LATER: 'ytWatchLater',
    // Diagnostics
    PING: 'ping',
  });

  const BROWSER_CMDS = Object.freeze([
    CMD.BACK, CMD.FORWARD, CMD.RELOAD, CMD.HOME, CMD.FULLSCREEN, CMD.PING,
    CMD.LIBRARY_LIST, CMD.BOOKMARK_ADD, CMD.BOOKMARK_REMOVE, CMD.RECENT_REMOVE, CMD.OPEN_ENTRY,
  ]);
  const PAGE_CMDS = Object.freeze([
    CMD.MOVE, CMD.CLICK, CMD.SCROLL, CMD.PAGE_UP, CMD.PAGE_DOWN,
    CMD.PLAYLIST_GET, CMD.PLAYLIST_OPEN, CMD.PLAYLIST_STEP,
  ]);
  const VIDEO_CMDS = Object.freeze([CMD.PLAY_PAUSE, CMD.SEEK_BY, CMD.SEEK_TO, CMD.VOLUME]);
  const YOUTUBE_CMDS = Object.freeze([CMD.YT_BROWSE, CMD.YT_UP_NEXT, CMD.YT_OPEN, CMD.YT_WATCH_LATER]);

  // Sections of the phone's YouTube tab (playlist / channel take an id).
  const YT_SECTION = Object.freeze({
    HOME: 'home',
    SUBSCRIPTIONS: 'subscriptions',
    PLAYLISTS: 'playlists',
    WATCH_LATER: 'watchLater',
    PLAYLIST: 'playlist',
    CHANNEL: 'channel',
  });
  // High-frequency input that is fire-and-forget (no ack) to avoid flooding the channel.
  const FIRE_AND_FORGET = Object.freeze([CMD.MOVE, CMD.SCROLL]);

  // What a command needs from the target tab. On ChromeOS the extension (and the phone link) outlives
  // the last closed browser window, so commands that navigate anyway may open a fresh window.
  const TAB_NEED = Object.freeze({ NONE: 'none', LAUNCH: 'launch', REQUIRED: 'required' });
  // YouTube reads run in a youtube.com data tab of their own: they never need (or touch) the TV's tab.
  const TAB_FREE_CMDS = Object.freeze([
    CMD.PING, CMD.LIBRARY_LIST, CMD.BOOKMARK_REMOVE, CMD.RECENT_REMOVE, CMD.YT_BROWSE, CMD.YT_UP_NEXT, CMD.YT_WATCH_LATER,
  ]);
  const TAB_LAUNCH_CMDS = Object.freeze([CMD.HOME, CMD.OPEN_ENTRY, CMD.YT_OPEN]);

  // Stable error codes, surfaced in logs and on the phone's error toast.
  const ERR = Object.freeze({
    BAD_MESSAGE: 'BAD_MESSAGE',
    UNKNOWN_CMD: 'UNKNOWN_CMD',
    NOT_PAIRED: 'NOT_PAIRED',
    NO_TAB: 'TAB_NOT_FOUND',
    NO_VIDEO: 'NO_VIDEO',
    NO_TARGET: 'NO_TARGET',
    CLICK_IFRAME: 'CLICK_IFRAME',
    FULLSCREEN_FAILED: 'FULLSCREEN_FAILED',
    NO_HISTORY: 'NO_HISTORY', // back/forward had nothing to go to: we stayed on the current page
    SYNC_FAILED: 'SYNC_FAILED', // chrome.storage.sync write refused (quota / offline sync service)
    AUTOPLAY_BLOCKED: 'AUTOPLAY_BLOCKED', // unmuted play() refused without a real gesture; played muted instead
    NO_PLAYLIST: 'NO_PLAYLIST', // this page has no episode list (or the site is not supported)
    NO_EPISODE: 'NO_EPISODE', // no previous / next numbered episode
    YT_SIGNED_OUT: 'YT_SIGNED_OUT', // a signed-in YouTube section answered as anonymous: sign in on the Chromebook
    YT_FAILED: 'YT_FAILED', // YouTube request failed or its data was not understood (data.reason says why)
    PEER_UNAVAILABLE: 'PEER_UNAVAILABLE',
    TIMEOUT: 'TIMEOUT',
    INTERNAL: 'INTERNAL',
  });

  // Message envelope types on the data channel.
  const MSG = Object.freeze({
    HELLO: 'hello', // phone -> ext {key, client_id, v}
    WELCOME: 'welcome', // ext -> phone {v}
    DENIED: 'denied', // ext -> phone {error_code}
    CMD: 'cmd', // phone -> ext {cmd_id, cmd, args}
    REPLY: 'reply', // ext -> phone {cmd_id, ok, error_code, data}
    STATE: 'state', // ext -> phone {state}
  });

  const DEFAULT_HOME_URL = 'https://www.iyf.tv/';

  const newId = () =>
    (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

  /** Random hex secret used as the pairing key (128 bit). */
  const newKey = () => {
    const bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  const isKnownCmd = (cmd) => Object.values(CMD).includes(cmd);
  const executorOf = (cmd) => {
    if (BROWSER_CMDS.includes(cmd)) return 'browser';
    if (PAGE_CMDS.includes(cmd)) return 'page';
    if (VIDEO_CMDS.includes(cmd)) return 'video';
    if (YOUTUBE_CMDS.includes(cmd)) return 'youtube';
    return null;
  };
  const needsAck = (cmd) => !FIRE_AND_FORGET.includes(cmd);
  const tabNeedOf = (cmd) => {
    if (TAB_FREE_CMDS.includes(cmd)) return TAB_NEED.NONE;
    if (TAB_LAUNCH_CMDS.includes(cmd)) return TAB_NEED.LAUNCH;
    return TAB_NEED.REQUIRED;
  };

  const makeCmd = ({ cmd, args = {}, cmdId = newId() }) => ({ type: MSG.CMD, cmd_id: cmdId, cmd, args, ts: Date.now() });
  const makeReply = ({ cmdId, ok, errorCode = null, data = null }) => ({
    type: MSG.REPLY,
    cmd_id: cmdId,
    ok: Boolean(ok),
    error_code: errorCode,
    data,
  });
  const ok = (data = null) => ({ ok: true, errorCode: null, data });
  const fail = (errorCode, data = null) => ({ ok: false, errorCode, data });

  const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);
  // YouTube ids: video ids are 11 chars; playlist / channel ids are longer, same alphabet.
  const isVideoId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v);
  const isYtListId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(v);
  const YT_ID_SECTIONS = Object.freeze([YT_SECTION.PLAYLIST, YT_SECTION.CHANNEL]);
  const YT_CURSOR_MAX = 4096;

  // Per-command argument validators; return null when valid, else an error code.
  const ARG_RULES = Object.freeze({
    [CMD.MOVE]: (a) => (isFiniteNumber(a.dx) && isFiniteNumber(a.dy) ? null : ERR.BAD_MESSAGE),
    [CMD.SCROLL]: (a) => (isFiniteNumber(a.dy) ? null : ERR.BAD_MESSAGE),
    [CMD.SEEK_BY]: (a) => (isFiniteNumber(a.seconds) ? null : ERR.BAD_MESSAGE),
    [CMD.SEEK_TO]: (a) => (isFiniteNumber(a.time) && a.time >= 0 ? null : ERR.BAD_MESSAGE),
    [CMD.VOLUME]: (a) => (isFiniteNumber(a.level) && a.level >= 0 && a.level <= 1 ? null : ERR.BAD_MESSAGE),
    [CMD.BOOKMARK_REMOVE]: (a) => (typeof a.key === 'string' && a.key.length > 0 ? null : ERR.BAD_MESSAGE),
    [CMD.RECENT_REMOVE]: (a) => (typeof a.key === 'string' && a.key.length > 0 ? null : ERR.BAD_MESSAGE),
    [CMD.PLAYLIST_GET]: (a) => (a.range === undefined || (Number.isInteger(a.range) && a.range >= 0) ? null : ERR.BAD_MESSAGE),
    // href is optional and same-site only (a path, never a protocol-relative or absolute URL).
    [CMD.PLAYLIST_OPEN]: (a) =>
      typeof a.id === 'string' && a.id.length > 0 &&
      (a.href === undefined || (typeof a.href === 'string' && /^\/(?!\/)/.test(a.href))) &&
      (a.range === undefined || (Number.isInteger(a.range) && a.range >= 0))
        ? null
        : ERR.BAD_MESSAGE,
    [CMD.PLAYLIST_STEP]: (a) => (a.dir === 1 || a.dir === -1 ? null : ERR.BAD_MESSAGE),
    [CMD.YT_BROWSE]: (a) =>
      Object.values(YT_SECTION).includes(a.section) &&
      (YT_ID_SECTIONS.includes(a.section) ? isYtListId(a.id) : a.id === undefined) &&
      (a.cursor === undefined || (typeof a.cursor === 'string' && a.cursor.length > 0 && a.cursor.length <= YT_CURSOR_MAX))
        ? null
        : ERR.BAD_MESSAGE,
    [CMD.YT_UP_NEXT]: (a) => (isVideoId(a.videoId) ? null : ERR.BAD_MESSAGE),
    [CMD.YT_WATCH_LATER]: (a) => (isVideoId(a.videoId) ? null : ERR.BAD_MESSAGE),
    // At least one of videoId / playlistId (a playlist alone starts at its first video).
    [CMD.YT_OPEN]: (a) =>
      (a.videoId !== undefined || a.playlistId !== undefined) &&
      (a.videoId === undefined || isVideoId(a.videoId)) &&
      (a.playlistId === undefined || isYtListId(a.playlistId))
        ? null
        : ERR.BAD_MESSAGE,
    // Only http(s) pages may be opened from the phone; time (resume position) is optional.
    [CMD.OPEN_ENTRY]: (a) =>
      typeof a.url === 'string' && /^https?:\/\//i.test(a.url) && (a.time === undefined || (isFiniteNumber(a.time) && a.time >= 0))
        ? null
        : ERR.BAD_MESSAGE,
  });

  /** Validate an inbound command envelope. Returns {ok:true} or {ok:false, errorCode}. */
  const validateCmd = (msg) => {
    if (!msg || typeof msg !== 'object') return fail(ERR.BAD_MESSAGE);
    if (msg.type !== MSG.CMD || typeof msg.cmd_id !== 'string') return fail(ERR.BAD_MESSAGE);
    if (!isKnownCmd(msg.cmd)) return fail(ERR.UNKNOWN_CMD);
    const rule = ARG_RULES[msg.cmd];
    const argError = rule ? rule(msg.args || {}) : null;
    if (argError) return fail(argError);
    return ok();
  };

  /**
   * Build the phone pairing URL. Secrets travel in the hash so they never reach a server log.
   * The optional `nonce` goes into `?t=` (not secret): it makes every scanned link unique, so the
   * phone always performs a real page load instead of a same-document hash jump onto a stale tab.
   */
  const buildPairUrl = ({ baseUrl, peerId, key, nonce = '' }) => {
    const base = baseUrl.replace(/[?#].*$/, '');
    const query = nonce ? `?t=${encodeURIComponent(nonce)}` : '';
    return `${base}${query}#peer=${encodeURIComponent(peerId)}&key=${encodeURIComponent(key)}`;
  };

  /**
   * Recover {peerId, key} from ANY shape of a pairing link, however a scanner app mangled it:
   * `#` kept, encoded once (`%23`), twice (`%2523`), moved into the query or the path.
   * The URL is decoded up to 3 times, then `peer=` / `key=` (32 hex chars) are searched anywhere.
   * Returns null when no valid pairing is present.
   */
  const MAX_DECODE_PASSES = 3;
  const PAIR_IN_TEXT_RE = /peer=([A-Za-z0-9_-]+)[\s\S]*?key=([0-9a-f]{32})(?![0-9a-f])/i;

  const decodeRepeatedly = (text) => {
    let current = String(text || '');
    for (let i = 0; i < MAX_DECODE_PASSES; i += 1) {
      let next;
      try {
        next = decodeURIComponent(current);
      } catch (_) {
        return current; // malformed escape: keep what we have
      }
      if (next === current) return current;
      current = next;
    }
    return current;
  };

  const extractPairing = (href) => {
    const m = decodeRepeatedly(href).match(PAIR_IN_TEXT_RE);
    if (!m) return null;
    return { peerId: m[1], key: m[2].toLowerCase() };
  };

  /** Parse `#peer=..&key=..` from a URL hash; returns null when incomplete. */
  const parsePairHash = (hash) => {
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const peerId = params.get('peer');
    const key = params.get('key');
    if (!peerId || !key) return null;
    return { peerId, key };
  };

  /** Compare dotted numeric versions: -1 if a<b, 0 if equal, 1 if a>b. Missing parts count as 0. */
  const compareVersions = (a, b) => {
    const pa = String(a || '0').split('.').map(Number);
    const pb = String(b || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
  };

  // ICE servers for BOTH ends. PeerJS 1.5 defaults add turn:{eu,us}-0.turn.peerjs.com, whose hostnames
  // no longer resolve (verified 2026-10-31), so they only add failing lookups. STUN finds public
  // addresses; a working TURN relay (needed when no direct path exists) must come from an account.
  const ICE_SERVERS = Object.freeze([
    Object.freeze({ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }),
    Object.freeze({ urls: 'stun:stun.cloudflare.com:3478' }),
  ]);

  // Asset name published by .github/workflows/release-extension.yml (and written by npm run pack).
  const RELEASE_ASSET = 'chrome-remote-extension.zip';

  /**
   * Latest-release ZIP address for a GitHub Pages remote URL (https://<owner>.github.io/<repo>/…):
   * https://github.com/<owner>/<repo>/releases/latest/download/chrome-remote-extension.zip.
   * null for any other host (custom domain, localhost) or an unparsable URL.
   */
  const releaseZipUrl = (remoteUrl) => {
    let url;
    try {
      url = new URL(remoteUrl);
    } catch (_) {
      return null;
    }
    const owner = (url.hostname.match(/^([a-z0-9-]+).github.io$/i) || [])[1];
    const repo = url.pathname.split('/').filter(Boolean)[0];
    return owner && repo ? `https://github.com/${owner}/${repo}/releases/latest/download/${RELEASE_ASSET}` : null;
  };

  /** Format seconds as h:mm:ss / m:ss for the phone UI. */
  const formatTime = (sec) => {
    if (!isFiniteNumber(sec) || sec < 0) return '--:--';
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  };

  root.CR = Object.freeze({
    PROTOCOL_VERSION,
    CMD,
    ERR,
    MSG,
    DEFAULT_HOME_URL,
    ICE_SERVERS,
    newId,
    newKey,
    isKnownCmd,
    executorOf,
    needsAck,
    TAB_NEED,
    YT_SECTION,
    tabNeedOf,
    makeCmd,
    makeReply,
    ok,
    fail,
    validateCmd,
    buildPairUrl,
    extractPairing,
    parsePairHash,
    formatTime,
    compareVersions,
    releaseZipUrl,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
