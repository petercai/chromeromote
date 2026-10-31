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
    // Page-level (content script, top frame only)
    MOVE: 'move',
    CLICK: 'click',
    SCROLL: 'scroll',
    PAGE_UP: 'pageUp',
    PAGE_DOWN: 'pageDown',
    // Video-level (content script, whichever frame owns the <video>)
    PLAY_PAUSE: 'playPause',
    SEEK_BY: 'seekBy',
    SEEK_TO: 'seekTo',
    VOLUME: 'volume',
    // Diagnostics
    PING: 'ping',
  });

  const BROWSER_CMDS = Object.freeze([CMD.BACK, CMD.FORWARD, CMD.RELOAD, CMD.HOME, CMD.FULLSCREEN, CMD.PING]);
  const PAGE_CMDS = Object.freeze([CMD.MOVE, CMD.CLICK, CMD.SCROLL, CMD.PAGE_UP, CMD.PAGE_DOWN]);
  const VIDEO_CMDS = Object.freeze([CMD.PLAY_PAUSE, CMD.SEEK_BY, CMD.SEEK_TO, CMD.VOLUME]);
  // High-frequency input that is fire-and-forget (no ack) to avoid flooding the channel.
  const FIRE_AND_FORGET = Object.freeze([CMD.MOVE, CMD.SCROLL]);

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
    AUTOPLAY_BLOCKED: 'AUTOPLAY_BLOCKED', // unmuted play() refused without a real gesture; played muted instead
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
    return null;
  };
  const needsAck = (cmd) => !FIRE_AND_FORGET.includes(cmd);

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

  // Per-command argument validators; return null when valid, else an error code.
  const ARG_RULES = Object.freeze({
    [CMD.MOVE]: (a) => (isFiniteNumber(a.dx) && isFiniteNumber(a.dy) ? null : ERR.BAD_MESSAGE),
    [CMD.SCROLL]: (a) => (isFiniteNumber(a.dy) ? null : ERR.BAD_MESSAGE),
    [CMD.SEEK_BY]: (a) => (isFiniteNumber(a.seconds) ? null : ERR.BAD_MESSAGE),
    [CMD.SEEK_TO]: (a) => (isFiniteNumber(a.time) && a.time >= 0 ? null : ERR.BAD_MESSAGE),
    [CMD.VOLUME]: (a) => (isFiniteNumber(a.level) && a.level >= 0 && a.level <= 1 ? null : ERR.BAD_MESSAGE),
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
    newId,
    newKey,
    isKnownCmd,
    executorOf,
    needsAck,
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
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
