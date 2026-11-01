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

  // -------------------------------------------------------------------------
  // Episode list (design 3.11, option C). Top frame only; selectors come from the site adapter
  // table in lib/playlist.js, all list logic is pure there (CRPlay).
  // -------------------------------------------------------------------------
  const RANGE_SWITCH_TIMEOUT_MS = 2500;
  const RANGE_POLL_MS = 100;
  const adapter = isTop ? CRPlay.adapterFor(location.hostname) : null;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const itemLinks = () => [...document.querySelectorAll(adapter.item)];
  const linkId = (a) => CRPlay.itemId(a.getAttribute('href'), adapter.idParam);
  const rangeButtons = () => [...document.querySelectorAll(adapter.rangeButton)];
  const listSignature = () => itemLinks().map((a) => a.getAttribute('href')).join('|');

  const readPlaylist = () => {
    const items = itemLinks().map((a) => ({ label: a.textContent.trim(), id: linkId(a), href: a.getAttribute('href') }));
    const ranges = CRPlay.buildRanges(
      rangeButtons().map((b) => ({ label: b.textContent, active: b.classList.contains('active'), playing: b.classList.contains('playing') }))
    );
    const heading = document.querySelector(adapter.title);
    const currentId = new URL(location.href).searchParams.get(adapter.idParam);
    return { items, ranges, title: heading ? heading.textContent.trim() : document.title, p: CRPlay.parsePlaylist(items, currentId) };
  };

  /** Show another range (the site renders one at a time); resolves true once the list has changed. */
  const switchRange = async (index) => {
    const btn = rangeButtons()[index];
    if (!btn) return false;
    if (btn.classList.contains('active')) return true;
    const before = listSignature();
    const started = Date.now();
    btn.click();
    while (Date.now() - started < RANGE_SWITCH_TIMEOUT_MS) {
      await sleep(RANGE_POLL_MS);
      if (listSignature() !== before) {
        log.debug('playlist.range_switched', { index, latency_ms: Date.now() - started });
        return true;
      }
    }
    log.warn('playlist.range_timeout', { index, timeout_ms: RANGE_SWITCH_TIMEOUT_MS });
    return false;
  };

  /** Click the episode link (keeps the site's SPA navigation and player); same-site href as fallback. */
  const openEpisode = async ({ id, href, range }, via) => {
    const find = () => itemLinks().find((a) => linkId(a) === id);
    let link = find();
    if (!link && range !== undefined && (await switchRange(range))) link = find();
    if (link) {
      const label = link.textContent.trim();
      link.click();
      log.info('playlist.open', { id, label, via, method: 'click', ok: true });
      return ok({ label });
    }
    if (href) {
      log.info('playlist.open', { id, via, method: 'navigate', ok: true });
      location.assign(href);
      return ok({ label: null });
    }
    log.warn('playlist.open', { id, via, method: 'none', ok: false });
    return fail(ERR.NO_TARGET);
  };

  const playlistGet = async ({ range }) => {
    const started = Date.now();
    const shown = readPlaylist();
    if (shown.items.length === 0) {
      log.warn('playlist.not_found', { site: adapter.site, selector: adapter.item });
      return fail(ERR.NO_PLAYLIST);
    }
    const wantOther = range !== undefined && Boolean(shown.ranges[range]) && !shown.ranges[range].active;
    if (wantOther && !(await switchRange(range))) return fail(ERR.TIMEOUT);
    const view = wantOther ? readPlaylist() : shown;
    // Put the TV page back on the range it showed, so its own list (and our summary) stays put.
    const back = shown.ranges.findIndex((r) => r.active);
    if (wantOther && back >= 0) await switchRange(back);
    const viewRange = wantOther ? range : back;
    log.info('playlist.read', {
      site: adapter.site,
      count: view.p.episodes.length,
      specials: view.p.specials.length,
      ranges: shown.ranges.length,
      view_range: viewRange,
      current_label: shown.p.current && shown.p.current.label,
      latency_ms: Date.now() - started,
    });
    return ok({
      title: shown.title,
      total: CRPlay.totalEpisodes(shown.p, shown.ranges),
      current: shown.p.current,
      episodes: view.p.episodes,
      specials: view.p.specials,
      ranges: shown.ranges,
      viewRange,
    });
  };

  // Previous / next numbered episode (Q35: specials are skipped); crosses into the adjacent range.
  const playlistStep = async ({ dir }) => {
    const shown = readPlaylist();
    if (shown.items.length === 0) return fail(ERR.NO_PLAYLIST);
    const plan = CRPlay.stepPlan(shown.p, shown.ranges, dir);
    const via = dir < 0 ? 'prev' : 'next';
    log.info('playlist.step', { dir, plan: plan.kind, from: shown.p.current && shown.p.current.label });
    if (plan.kind === 'none') return fail(ERR.NO_EPISODE);
    if (plan.kind === 'episode') return openEpisode(plan.target, via);
    if (!(await switchRange(plan.rangeIndex))) return fail(ERR.TIMEOUT);
    const eps = readPlaylist().p.episodes;
    const target = plan.pick === 'last' ? eps[eps.length - 1] : eps[0];
    return target ? openEpisode(target, via) : fail(ERR.NO_EPISODE);
  };

  const withAdapter = (fn) => (a) => (adapter ? fn(a) : fail(ERR.NO_PLAYLIST));

  // -------------------------------------------------------------------------
  // YouTube Music player (design 3.13.14): raw page data -> CRMusic.musicState; player-bar clicks
  // -------------------------------------------------------------------------
  const musicSite = isTop && CRMusic.isMusicHost(location.hostname);
  const MUSIC_SETTLE_MS = 400; // the page needs a moment to reflect a click before the next summary

  const readMusicRaw = () => {
    const S = CRMusic.SITE;
    const text = (root, sel) => {
      const el = root.querySelector(sel);
      return el ? el.textContent : '';
    };
    const items = [...document.querySelectorAll(S.queueItem)].map((it) => {
      const img = it.querySelector('img');
      return { title: text(it, S.itemTitle), artist: text(it, S.itemArtist), duration: text(it, S.itemDuration), thumb: img && img.src ? img.src : null, selected: it.hasAttribute('selected'), automix: it.hasAttribute('is-automix') };
    });
    const bar = document.querySelector(S.bar);
    const like = document.querySelector(S.likeRenderer);
    const player = document.querySelector(S.adPlayer);
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    return {
      items,
      barTitle: text(document, S.barTitle),
      barByline: text(document, S.barByline),
      session: md ? { title: md.title, artist: md.artist, album: md.album, artwork: [...(md.artwork || [])].map((a) => ({ src: a.src, sizes: a.sizes })) } : null,
      ad: Boolean(player && player.classList.contains(S.adClass)),
      likeStatus: like ? like.getAttribute('like-status') : null,
      repeatMode: bar ? bar.getAttribute('repeat-mode') : null,
    };
  };

  const clickMusic = (el, what, fields) => {
    if (!el) {
      log.warn('music.not_found', { what, ...fields }); // selector no longer matches: YouTube Music changed
      return fail(ERR.NO_MUSIC);
    }
    el.click();
    setTimeout(pushSummaries, MUSIC_SETTLE_MS);
    return ok();
  };
  const musicControl = ({ action }) => {
    const res = clickMusic(document.querySelector(CRMusic.CONTROL_SELECTORS[action]), action, { action });
    log.info('music.control', { action, ok: res.ok });
    return res;
  };
  const musicQueuePlay = ({ index }) => {
    const item = document.querySelectorAll(CRMusic.SITE.queueItem)[index];
    const res = clickMusic(item && item.querySelector(CRMusic.SITE.itemPlay), 'queue_play', { index });
    log.info('music.queue_play', { index, ok: res.ok, title: item ? (item.querySelector(CRMusic.SITE.itemTitle) || {}).textContent : null });
    return res;
  };
  const withMusic = (fn) => (a) => (musicSite ? fn(a) : fail(ERR.NO_MUSIC));

  // -------------------------------------------------------------------------
  // Page summaries for the phone, sent only when they change (one channel, keyed by kind).
  // A source returns undefined when it does not apply to this site, null for "nothing now".
  // -------------------------------------------------------------------------
  const SUMMARY_SOURCES = Object.freeze({
    playlist: () => {
      if (!adapter) return undefined;
      const { items, p, ranges, title } = readPlaylist();
      return items.length ? CRPlay.summarize(p, ranges, title) : null;
    },
    music: () => (musicSite ? CRMusic.musicState(readMusicRaw()) : undefined),
  });
  const lastSummarySig = {};
  const pushSummaries = () =>
    Object.keys(SUMMARY_SOURCES).forEach((kind) => {
      const summary = SUMMARY_SOURCES[kind]();
      if (summary === undefined) return;
      const sig = JSON.stringify(summary);
      if (sig === lastSummarySig[kind]) return;
      lastSummarySig[kind] = sig;
      log.debug(`${kind}.summary`, kind === 'music'
        ? { current: summary && summary.current, total: summary && summary.total, ad: summary && summary.ad }
        : { current: summary && summary.current, total: summary && summary.total, has_prev: summary && summary.hasPrev, has_next: summary && summary.hasNext });
      chrome.runtime.sendMessage({ type: 'pageSummary', kind, summary }).catch(() => {});
    });

  const PAGE_ACTIONS = Object.freeze({
    [CMD.PLAYLIST_GET]: withAdapter(playlistGet),
    [CMD.PLAYLIST_OPEN]: withAdapter((a) => openEpisode(a, 'list')),
    [CMD.PLAYLIST_STEP]: withAdapter(playlistStep),
    [CMD.MUSIC_CONTROL]: withMusic(musicControl),
    [CMD.MUSIC_QUEUE_PLAY]: withMusic(musicQueuePlay),
    [CMD.MOVE]: (a) => movePointer(a),
    [CMD.CLICK]: () => clickAtPointer(),
    [CMD.SCROLL]: (a) => scrollBy(a.dy),
    [CMD.PAGE_UP]: () => scrollBy(-window.innerHeight * PAGE_SCROLL_RATIO),
    [CMD.PAGE_DOWN]: () => scrollBy(window.innerHeight * PAGE_SCROLL_RATIO),
  });

  // -------------------------------------------------------------------------
  // In-page fill ("web fullscreen") — paired with window fullscreen in the worker
  // -------------------------------------------------------------------------
  // position:fixed + max z-index only wins if NO ancestor forms a stacking context or containing block:
  // otherwise the video only outranks its own player, and page siblings with a higher z-index (e.g.
  // YouTube's sticky sidebar chips over #movie_player) paint on top of it. So every ancestor is tagged,
  // stripped of the properties that create those contexts, and raised to the max as well.
  const FILL_ANCESTOR = `${FILL_CLASS}-ancestor`;
  const FILL_CSS = `
    .${FILL_CLASS} {
      position: fixed !important; inset: 0 !important;
      width: 100vw !important; height: 100vh !important;
      max-width: none !important; max-height: none !important;
      margin: 0 !important; z-index: ${Z_MAX} !important;
      background: #000 !important; object-fit: contain !important;
    }
    .${FILL_ANCESTOR} {
      transform: none !important; filter: none !important; perspective: none !important;
      contain: none !important; will-change: auto !important; isolation: auto !important;
      opacity: 1 !important; clip-path: none !important; mask: none !important; -webkit-mask: none !important;
      z-index: ${Z_MAX} !important;
    }
    html.${FILL_CLASS}-root, html.${FILL_CLASS}-root body { overflow: hidden !important; }
  `;

  // Ancestors up to <html>, crossing shadow roots (custom-element players).
  const ancestorsOf = (el) => {
    const out = [];
    let cur = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    while (cur && cur !== document.documentElement) {
      out.push(cur);
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
    }
    return out;
  };

  /** Would this element (before neutralizing) trap a fixed / z-indexed descendant? For the fill log only. */
  const formsContext = (el) => {
    const s = getComputedStyle(el);
    return s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none' || (s.contain && s.contain !== 'none') ||
      (s.position !== 'static' && s.zIndex !== 'auto') || Number(s.opacity) < 1 || s.isolation === 'isolate' ||
      /transform|opacity|filter/.test(s.willChange || '');
  };

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
    document.querySelectorAll(`.${FILL_CLASS}, .${FILL_ANCESTOR}`).forEach((el) => el.classList.remove(FILL_CLASS, FILL_ANCESTOR));
    document.documentElement.classList.toggle(`${FILL_CLASS}-root`, on);
    if (!on) return;
    const target = fillTarget();
    if (!target) return;
    const ancestors = ancestorsOf(target);
    const neutralized = ancestors.filter(formsContext).slice(0, 5).map(describe);
    ancestors.forEach((a) => a.classList.add(FILL_ANCESTOR));
    target.classList.add(FILL_CLASS);
    log.info('fill.applied', { target: describe(target), ancestors: ancestors.length, neutralized });
  };

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------
  const handleExec = (msg, sendResponse) => {
    const kind = executorOf(msg.cmd);
    if (kind === 'page') {
      if (!isTop) return false;
      // Some page actions are async (episode list); the sync ones resolve immediately.
      Promise.resolve()
        .then(() => PAGE_ACTIONS[msg.cmd](msg.args || {}))
        .then(sendResponse)
        .catch((e) => {
          log.error('page.cmd_failed', { cmd: msg.cmd, error: String(e) });
          sendResponse(fail(ERR.INTERNAL));
        });
      return true;
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
    // Page-level history (top frame only): a no-op when there is nothing to go to — never closes the tab.
    if (message.type === 'history') {
      if (!isTop) return false;
      if (message.direction < 0) history.back();
      else history.forward();
      sendResponse(ok());
      return false;
    }
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
    try {
      pushSummaries();
      const v = findVideo();
      if (!v && !hadVideo) return;
      hadVideo = Boolean(v);
      chrome.runtime.sendMessage({ type: 'videoState', state: v ? snapshot(v) : { hasVideo: false } }).catch(() => {});
    } catch (e) {
      // Extension was reloaded: this orphaned script must stop.
      clearInterval(stateTimer);
    }
  }, STATE_INTERVAL_MS);
})();
