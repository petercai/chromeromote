/**
 * Content script (runs in every frame).
 *
 * Top frame: virtual pointer overlay, synthetic click, scroll, page up/down.
 * Any frame: video control for the <video> it owns, in-page "fill" fullscreen, and a 1 Hz
 * state report to the service worker. Frames without a video stay silent so that the
 * frame that owns the player is the one answering video commands.
 */
(function () {
  'use strict';

  // Guard against double injection (manifest + programmatic re-injection).
  if (globalThis.__crContentLoaded) return;
  globalThis.__crContentLoaded = true;

  const { CMD, ERR, ok, fail, executorOf } = CR;
  const isTop = window === window.top;
  const log = CRLog.createLogger(isTop ? 'ext-cs' : 'ext-cs-frame');

  // Immutable tuning
  const STATE_INTERVAL_MS = 1000;
  const POINTER_HIDE_MS = 4000;
  const PAGE_SCROLL_RATIO = 0.85;
  const FILL_CLASS = '__cr-fill';
  const POINTER_ID = '__cr-pointer';
  const Z_MAX = '2147483647';

  // -------------------------------------------------------------------------
  // Video discovery: prefer a playing video, then the largest visible one.
  // -------------------------------------------------------------------------
  const visibleArea = (el) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  };

  const findVideo = () => {
    const videos = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0 || v.currentSrc);
    if (videos.length === 0) return null;
    const playing = videos.filter((v) => !v.paused);
    const pool = playing.length > 0 ? playing : videos;
    return pool.reduce((best, v) => (visibleArea(v) > visibleArea(best) ? v : best), pool[0]);
  };

  const snapshot = (v) => ({
    hasVideo: true,
    t: v.currentTime,
    dur: Number.isFinite(v.duration) ? v.duration : null,
    vol: v.volume,
    muted: v.muted,
    paused: v.paused,
  });

  // -------------------------------------------------------------------------
  // Video commands (async because play() returns a promise)
  // -------------------------------------------------------------------------
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  const playPause = async (v) => {
    if (!v.paused) {
      v.pause();
      return ok(snapshot(v));
    }
    try {
      await v.play();
      return ok(snapshot(v));
    } catch (e) {
      // Autoplay policy may block unmuted play without a real user gesture: fall back to muted.
      log.warn('video.play_blocked', { error: String(e && e.name) });
      v.muted = true;
      await v.play().catch(() => {});
      return fail(ERR.AUTOPLAY_BLOCKED, snapshot(v));
    }
  };

  const seekTo = (v, time) => {
    const max = Number.isFinite(v.duration) ? v.duration : time;
    v.currentTime = clamp(time, 0, max);
    return ok(snapshot(v));
  };

  const setVolume = (v, level) => {
    v.volume = clamp(level, 0, 1);
    if (level > 0 && v.muted) v.muted = false;
    return ok(snapshot(v));
  };

  const VIDEO_ACTIONS = Object.freeze({
    [CMD.PLAY_PAUSE]: (v) => playPause(v),
    [CMD.SEEK_BY]: (v, a) => seekTo(v, v.currentTime + a.seconds),
    [CMD.SEEK_TO]: (v, a) => seekTo(v, a.time),
    [CMD.VOLUME]: (v, a) => setVolume(v, a.level),
  });

  // -------------------------------------------------------------------------
  // Virtual pointer (top frame only)
  // -------------------------------------------------------------------------
  const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2, el: null, hideTimer: null };

  const ensurePointerEl = () => {
    if (pointer.el && document.documentElement.contains(pointer.el)) return pointer.el;
    const el = document.createElement('div');
    el.id = POINTER_ID;
    Object.assign(el.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '28px',
      height: '28px',
      marginLeft: '-14px',
      marginTop: '-14px',
      borderRadius: '50%',
      border: '3px solid #FF7A00',
      background: 'rgba(255,122,0,0.25)',
      boxShadow: '0 0 0 2px rgba(0,0,0,0.6)',
      pointerEvents: 'none', // never intercept elementFromPoint / real input
      zIndex: Z_MAX,
      transition: 'opacity 200ms, transform 60ms linear',
      opacity: '0',
    });
    document.documentElement.appendChild(el);
    pointer.el = el;
    return el;
  };

  const renderPointer = () => {
    const el = ensurePointerEl();
    el.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;
    el.style.opacity = '1';
    clearTimeout(pointer.hideTimer);
    pointer.hideTimer = setTimeout(() => {
      el.style.opacity = '0';
    }, POINTER_HIDE_MS);
  };

  const flashPointer = () => {
    const el = ensurePointerEl();
    el.style.background = 'rgba(255,122,0,0.8)';
    setTimeout(() => {
      el.style.background = 'rgba(255,122,0,0.25)';
    }, 150);
  };

  const movePointer = ({ dx, dy }) => {
    pointer.x = clamp(pointer.x + dx, 0, window.innerWidth - 1);
    pointer.y = clamp(pointer.y + dy, 0, window.innerHeight - 1);
    renderPointer();
    return ok();
  };

  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;

  const dispatchClickSequence = (el, x, y) => {
    const common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', common));
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', common));
    el.dispatchEvent(new MouseEvent('click', common));
  };

  const clickAtPointer = () => {
    renderPointer();
    const el = document.elementFromPoint(pointer.x, pointer.y);
    if (!el) return fail(ERR.NO_TARGET);
    // Cross-frame clicks are not supported in v1: the iframe would need its own offset.
    if (el.tagName === 'IFRAME') {
      log.warn('click.iframe', { target: describe(el) });
      return fail(ERR.CLICK_IFRAME);
    }
    flashPointer();
    dispatchClickSequence(el, pointer.x, pointer.y);
    log.debug('click.dispatched', { target: describe(el), x: Math.round(pointer.x), y: Math.round(pointer.y) });
    return ok({ target: describe(el) });
  };

  const isScrollable = (el) => {
    const style = getComputedStyle(el);
    return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
  };

  const scrollTargetAtPointer = () => {
    let el = document.elementFromPoint(pointer.x, pointer.y);
    while (el && el !== document.body && el !== document.documentElement) {
      if (isScrollable(el)) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };

  const scrollBy = (dy) => {
    scrollTargetAtPointer().scrollBy({ top: dy, behavior: 'auto' });
    return ok();
  };

  const PAGE_ACTIONS = Object.freeze({
    [CMD.MOVE]: (a) => movePointer(a),
    [CMD.CLICK]: () => clickAtPointer(),
    [CMD.SCROLL]: (a) => scrollBy(a.dy),
    [CMD.PAGE_UP]: () => scrollBy(-window.innerHeight * PAGE_SCROLL_RATIO),
    [CMD.PAGE_DOWN]: () => scrollBy(window.innerHeight * PAGE_SCROLL_RATIO),
  });

  // -------------------------------------------------------------------------
  // In-page fill ("web fullscreen") — paired with window fullscreen in the worker
  // -------------------------------------------------------------------------
  const FILL_CSS = `
    .${FILL_CLASS} {
      position: fixed !important; inset: 0 !important;
      width: 100vw !important; height: 100vh !important;
      max-width: none !important; max-height: none !important;
      margin: 0 !important; z-index: ${Z_MAX} !important;
      background: #000 !important; object-fit: contain !important;
    }
    html.${FILL_CLASS}-root, html.${FILL_CLASS}-root body { overflow: hidden !important; }
  `;

  const ensureFillStyle = () => {
    if (document.getElementById(`${FILL_CLASS}-style`)) return;
    const style = document.createElement('style');
    style.id = `${FILL_CLASS}-style`;
    style.textContent = FILL_CSS;
    document.documentElement.appendChild(style);
  };

  // Without a local video, the top frame fills the largest iframe (the player is likely inside).
  const fillTarget = () => {
    const v = findVideo();
    if (v) return v;
    if (!isTop) return null;
    const frames = [...document.querySelectorAll('iframe')];
    return frames.reduce((best, f) => (!best || visibleArea(f) > visibleArea(best) ? f : best), null);
  };

  const setFill = (on) => {
    ensureFillStyle();
    document.querySelectorAll(`.${FILL_CLASS}`).forEach((el) => el.classList.remove(FILL_CLASS));
    document.documentElement.classList.toggle(`${FILL_CLASS}-root`, on);
    if (!on) return;
    const target = fillTarget();
    if (!target) return;
    target.classList.add(FILL_CLASS);
    log.info('fill.applied', { target: describe(target) });
  };

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------
  const handleExec = (msg, sendResponse) => {
    const kind = executorOf(msg.cmd);
    if (kind === 'page') {
      if (!isTop) return false;
      sendResponse(PAGE_ACTIONS[msg.cmd](msg.args || {}));
      return false;
    }
    if (kind === 'video') {
      const v = findVideo();
      if (!v) return false; // stay silent; another frame may own the player
      Promise.resolve(VIDEO_ACTIONS[msg.cmd](v, msg.args || {}))
        .then(sendResponse)
        .catch((e) => {
          log.error('video.cmd_failed', { cmd: msg.cmd, error: String(e) });
          sendResponse(fail(ERR.INTERNAL));
        });
      return true;
    }
    return false;
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === 'exec' && message.msg) return handleExec(message.msg, sendResponse);
    if (message.type === 'fill') {
      setFill(Boolean(message.on));
      if (isTop) sendResponse(ok());
      return false;
    }
    return false;
  });

  // -------------------------------------------------------------------------
  // State reporting (1 Hz while a video exists, one final "no video" when it disappears)
  // -------------------------------------------------------------------------
  let hadVideo = false;
  const stateTimer = setInterval(() => {
    const v = findVideo();
    if (!v && !hadVideo) return;
    hadVideo = Boolean(v);
    try {
      chrome.runtime.sendMessage({ type: 'videoState', state: v ? snapshot(v) : { hasVideo: false } }).catch(() => {});
    } catch (e) {
      // Extension was reloaded: this orphaned script must stop.
      clearInterval(stateTimer);
    }
  }, STATE_INTERVAL_MS);
})();
