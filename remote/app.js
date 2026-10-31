/**
 * Phone remote controller (layout B).
 *
 * Modules (top to bottom): constants -> pairing -> connection (PeerJS, reconnect, ack/timeout)
 * -> view rendering (pure from latest state) -> input (touchpad gestures, sliders, buttons).
 * The UI never guesses playback state: it renders only what the extension reports.
 */
(function () {
  'use strict';

  const { CMD, MSG, ERR, makeCmd, needsAck, parsePairHash, repairPairUrl, formatTime, newId, PROTOCOL_VERSION } = CR;
  const log = CRLog.createLogger('pwa');

  // -------------------------------------------------------------------------
  // Immutable settings
  // -------------------------------------------------------------------------
  const ACK_TIMEOUT_MS = 3000;
  const PING_INTERVAL_MS = 5000;
  const STATE_STALE_MS = 3500;
  const RETRY_MIN_MS = 1000;
  const RETRY_MAX_MS = 10000;
  const VOLUME_THROTTLE_MS = 100;
  const TAP_MAX_MS = 250;
  const TAP_MAX_MOVE_PX = 10;
  const SCROLL_GAIN = 3;
  const STORAGE = Object.freeze({ pairing: 'cr.pairing', clientId: 'cr.clientId' });

  const ERROR_TEXT = Object.freeze({
    [ERR.NO_VIDEO]: '页面上没有找到视频',
    [ERR.NO_TAB]: '没有找到 Chrome 标签页',
    [ERR.NO_TARGET]: '指针下没有可点击的内容',
    [ERR.CLICK_IFRAME]: '暂不支持点击嵌入框架内的内容',
    [ERR.AUTOPLAY_BLOCKED]: '浏览器阻止了有声播放,已静音播放;请调高音量',
    [ERR.NOT_PAIRED]: '密钥无效,请重新扫描电视上的二维码',
    [ERR.TIMEOUT]: '电视端没有响应(超时)',
    [ERR.INTERNAL]: '扩展内部错误',
    [ERR.BAD_MESSAGE]: '命令格式错误',
  });

  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------------------------
  // Pairing (hash -> localStorage; hash is stripped so it does not linger in history)
  // -------------------------------------------------------------------------
  const loadPairing = () => {
    // Scanner apps sometimes percent-encode "#": with "?t=" in the link the mangled form
    // (…/remote/?t=x%23peer=…) still loads this page, so repair it here (404.html covers the rest).
    const repaired = repairPairUrl(location.href);
    if (repaired) log.warn('pairing.url_repaired', { from: location.search.slice(0, 20) });
    const fromHash = parsePairHash(repaired ? new URL(repaired).hash : location.hash);
    if (fromHash) {
      localStorage.setItem(STORAGE.pairing, JSON.stringify(fromHash));
      history.replaceState(null, '', location.pathname); // drop secrets (hash) and the one-off ?t= nonce
      log.info('pairing.saved', { peer_id: fromHash.peerId, key: CRLog.redact(fromHash.key) });
      return fromHash;
    }
    try {
      return JSON.parse(localStorage.getItem(STORAGE.pairing) || 'null');
    } catch (_) {
      return null;
    }
  };

  const clientId = (() => {
    const existing = localStorage.getItem(STORAGE.clientId);
    if (existing) return existing;
    const id = `phone-${newId().slice(0, 8)}`;
    localStorage.setItem(STORAGE.clientId, id);
    return id;
  })();

  // -------------------------------------------------------------------------
  // Mutable app state (single object, mutated only through the functions below)
  // -------------------------------------------------------------------------
  const app = {
    pairing: loadPairing(),
    peer: null,
    conn: null,
    status: 'idle', // idle | connecting | connected | denied | error
    statusDetail: '',
    retryMs: RETRY_MIN_MS,
    retryTimer: null,
    pending: new Map(), // cmd_id -> {resolve, timer, sentAt}
    video: { hasVideo: false },
    videoTs: 0,
    title: '',
    url: '',
    latency: null,
    tab: 'browse',
    draggingSeek: false,
    draggingVolume: false,
  };

  // -------------------------------------------------------------------------
  // View rendering
  // -------------------------------------------------------------------------
  const STATUS_TEXT = Object.freeze({
    idle: '未连接',
    connecting: '连接中…',
    connected: '已连接',
    denied: '配对失效',
    error: '连接失败',
  });

  let toastTimer = null;
  const toast = (text) => {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 3000);
  };

  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  };

  const videoAvailable = () => app.status === 'connected' && app.video.hasVideo && Date.now() - app.videoTs < STATE_STALE_MS;

  const renderStatus = () => {
    $('dot').className = `dot ${app.status === 'connected' ? 'connected' : app.status === 'idle' || app.status === 'connecting' ? '' : 'error'}`;
    $('statusText').textContent = app.statusDetail ? `${STATUS_TEXT[app.status]}:${app.statusDetail}` : STATUS_TEXT[app.status];
    $('latency').textContent = app.status === 'connected' && app.latency != null ? `${app.latency} ms` : '';
    $('site').textContent = hostOf(app.url);
    $('unpaired').hidden = Boolean(app.pairing);
    document.querySelectorAll('button[data-cmd]').forEach((b) => {
      b.disabled = app.status !== 'connected' || (b.classList.contains('needs-video') && !videoAvailable());
    });
  };

  const renderVideo = () => {
    const v = app.video;
    const available = videoAvailable();
    $('title').textContent = available ? app.title || '正在播放' : '没有正在播放的视频';
    $('playPause').textContent = available && !v.paused ? '❚❚' : '▶';
    $('seek').disabled = !available || !v.dur;
    $('volume').disabled = !available;
    if (!app.draggingSeek) {
      $('cur').textContent = available ? formatTime(v.t) : '--:--';
      $('dur').textContent = available ? formatTime(v.dur) : '--:--';
      $('seek').value = available && v.dur ? Math.round((v.t / v.dur) * 1000) : 0;
    }
    if (!app.draggingVolume) {
      const level = available ? Math.round((v.muted ? 0 : v.vol) * 100) : 0;
      $('volume').value = level;
      $('volText').textContent = available ? `${level}%` : '--';
    }
  };

  const render = () => {
    renderStatus();
    renderVideo();
  };

  const switchTab = (tab) => {
    app.tab = tab;
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  };

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------
  const setStatus = (status, detail = '') => {
    if (app.status !== status || app.statusDetail !== detail) log.info('status.changed', { status, detail });
    app.status = status;
    app.statusDetail = detail;
    render();
  };

  const failAllPending = (errorCode) => {
    app.pending.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve({ ok: false, error_code: errorCode });
    });
    app.pending.clear();
  };

  const teardown = () => {
    failAllPending(ERR.TIMEOUT);
    // Detach first: close() may fire the 'close' handler synchronously, and that handler
    // must see the connection as superseded (otherwise it would schedule a reconnect).
    const { conn, peer } = app;
    app.conn = null;
    app.peer = null;
    if (conn) conn.close();
    if (peer) peer.destroy();
  };

  const scheduleReconnect = (reason) => {
    if (app.retryTimer || app.status === 'denied') return;
    log.warn('reconnect.scheduled', { reason, retry_ms: app.retryMs });
    app.retryTimer = setTimeout(() => {
      app.retryTimer = null;
      connect();
    }, app.retryMs);
    app.retryMs = Math.min(app.retryMs * 2, RETRY_MAX_MS);
  };

  const onStateMessage = (state) => {
    const prev = app.video;
    app.video = state.hasVideo ? state : { hasVideo: false };
    app.videoTs = Date.now();
    app.title = state.title || app.title;
    app.url = state.url || app.url;
    // Auto-switch to Play when playback starts (paused: true/undefined -> false).
    if (state.hasVideo && state.paused === false && prev.paused !== false && app.tab === 'browse') {
      log.info('tab.auto_switch', { to: 'play' });
      switchTab('play');
    }
    render();
  };

  const onData = (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === MSG.WELCOME) {
      app.retryMs = RETRY_MIN_MS;
      setStatus('connected');
      return;
    }
    if (data.type === MSG.DENIED) {
      setStatus('denied', ERROR_TEXT[data.error_code] || data.error_code);
      localStorage.removeItem(STORAGE.pairing);
      app.pairing = null;
      teardown();
      render();
      return;
    }
    if (data.type === MSG.REPLY) {
      const pending = app.pending.get(data.cmd_id);
      if (!pending) return;
      clearTimeout(pending.timer);
      app.pending.delete(data.cmd_id);
      pending.resolve(data);
      return;
    }
    if (data.type === MSG.STATE) onStateMessage(data.state || {});
  };

  const connect = () => {
    teardown();
    if (!app.pairing) {
      setStatus('idle');
      return;
    }
    setStatus('connecting');
    const peer = new Peer({ debug: 1 });
    app.peer = peer;

    peer.on('open', () => {
      const conn = peer.connect(app.pairing.peerId, { reliable: true });
      app.conn = conn;
      conn.on('open', () => {
        log.info('conn.open', { peer_id: app.pairing.peerId });
        conn.send({ type: MSG.HELLO, key: app.pairing.key, client_id: clientId, v: PROTOCOL_VERSION });
      });
      conn.on('data', onData);
      conn.on('close', () => {
        if (app.conn !== conn) return; // superseded by a newer connection
        setStatus('connecting', '连接断开');
        scheduleReconnect('conn_close');
      });
      conn.on('error', (e) => log.warn('conn.error', { error: String(e) }));
    });

    peer.on('error', (err) => {
      if (app.peer !== peer) return;
      log.error('peer.error', { type: err.type, error: String(err) });
      const detail = err.type === 'peer-unavailable' ? '电视端不在线(Chrome 是否已打开?)' : err.type;
      setStatus('error', detail);
      scheduleReconnect(err.type);
    });
  };

  /** Send a command; resolves with the reply (or a synthetic TIMEOUT reply). Never rejects. */
  const send = (cmd, args = {}) => {
    if (app.status !== 'connected' || !app.conn || !app.conn.open) return Promise.resolve({ ok: false, error_code: 'OFFLINE' });
    const msg = makeCmd({ cmd, args });
    app.conn.send(msg);
    if (!needsAck(cmd)) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        app.pending.delete(msg.cmd_id);
        log.warn('cmd.timeout', { cmd, cmd_id: msg.cmd_id });
        resolve({ ok: false, error_code: ERR.TIMEOUT });
      }, ACK_TIMEOUT_MS);
      app.pending.set(msg.cmd_id, { resolve, timer, sentAt: Date.now() });
    });
  };

  /** Send + surface failures on the toast (used by every user-facing action). */
  const act = async (cmd, args) => {
    const res = await send(cmd, args);
    if (!res.ok && res.error_code !== 'OFFLINE') {
      log.warn('cmd.failed', { cmd, error_code: res.error_code });
      toast(ERROR_TEXT[res.error_code] || `操作失败:${res.error_code}`);
    }
    return res;
  };

  const ping = async () => {
    if (app.status !== 'connected') return;
    const started = performance.now();
    const res = await send(CMD.PING);
    app.latency = res.ok ? Math.round(performance.now() - started) : null;
    renderStatus();
  };

  // -------------------------------------------------------------------------
  // Input: buttons
  // -------------------------------------------------------------------------
  const BUTTON_HOOKS = Object.freeze({
    [CMD.BACK]: () => switchTab('browse'), // returning to a list means browsing again
    [CMD.FULLSCREEN]: (res) => {
      if (res.ok && res.data) $('fullscreen').textContent = res.data.fullscreen ? '⛶ 退出全屏' : '⛶ 全屏';
    },
  });

  const onButton = async (btn) => {
    const cmd = btn.dataset.cmd;
    const args = btn.dataset.seconds ? { seconds: Number(btn.dataset.seconds) } : {};
    if (navigator.vibrate) navigator.vibrate(10);
    const res = await act(cmd, args);
    const hook = BUTTON_HOOKS[cmd];
    if (hook) hook(res);
    if (res.ok && res.data && res.data.hasVideo) onStateMessage({ ...app.video, ...res.data, title: app.title, url: app.url });
  };

  document.querySelectorAll('button[data-cmd]').forEach((btn) => btn.addEventListener('click', () => onButton(btn)));
  document.querySelectorAll('.tabbar button').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  // -------------------------------------------------------------------------
  // Input: sliders
  // -------------------------------------------------------------------------
  const seekEl = $('seek');
  seekEl.addEventListener('input', () => {
    app.draggingSeek = true;
    $('cur').textContent = formatTime((seekEl.value / 1000) * (app.video.dur || 0));
  });
  // Seek is committed on release only (design F16).
  seekEl.addEventListener('change', async () => {
    const time = (seekEl.value / 1000) * (app.video.dur || 0);
    app.draggingSeek = false;
    await act(CMD.SEEK_TO, { time });
  });

  const volEl = $('volume');
  let lastVolumeSent = 0;
  volEl.addEventListener('input', () => {
    app.draggingVolume = true;
    $('volText').textContent = `${volEl.value}%`;
    const now = Date.now();
    if (now - lastVolumeSent < VOLUME_THROTTLE_MS) return;
    lastVolumeSent = now;
    send(CMD.VOLUME, { level: volEl.value / 100 });
  });
  volEl.addEventListener('change', async () => {
    app.draggingVolume = false;
    await act(CMD.VOLUME, { level: volEl.value / 100 });
  });

  // -------------------------------------------------------------------------
  // Input: touchpad (1 finger move / tap, 2 fingers scroll), batched per animation frame
  // -------------------------------------------------------------------------
  const pad = $('touchpad');
  const touches = new Map(); // pointerId -> {x, y, t}
  const gesture = { startT: 0, moved: 0, multi: false };
  const acc = { dx: 0, dy: 0, scroll: 0 };

  // Acceleration: slow moves stay precise, fast flicks cross the TV screen.
  const accel = (d, dt) => {
    const speed = Math.abs(d) / Math.max(dt, 1); // px per ms
    return d * (1.5 + Math.min(speed, 3) * 1.5);
  };

  const flush = () => {
    if (acc.dx || acc.dy) send(CMD.MOVE, { dx: Math.round(acc.dx), dy: Math.round(acc.dy) });
    if (acc.scroll) send(CMD.SCROLL, { dy: Math.round(acc.scroll) });
    acc.dx = acc.dy = acc.scroll = 0;
    if (touches.size > 0) requestAnimationFrame(flush);
  };

  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    if (touches.size === 0) {
      Object.assign(gesture, { startT: performance.now(), moved: 0, multi: false });
      requestAnimationFrame(flush);
    }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
    if (touches.size > 1) gesture.multi = true;
    pad.classList.add('active');
  });

  pad.addEventListener('pointermove', (e) => {
    const prev = touches.get(e.pointerId);
    if (!prev) return;
    const now = performance.now();
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });
    gesture.moved += Math.abs(dx) + Math.abs(dy);
    if (touches.size >= 2) {
      // Two-finger swipe: content follows the fingers (swipe up = scroll down).
      acc.scroll += (-dy / touches.size) * SCROLL_GAIN;
      return;
    }
    if (gesture.multi) return; // ignore the leftover finger after a scroll gesture
    acc.dx += accel(dx, now - prev.t);
    acc.dy += accel(dy, now - prev.t);
  });

  const endTouch = (e) => {
    if (!touches.delete(e.pointerId)) return;
    if (touches.size > 0) return;
    pad.classList.remove('active');
    const isTap = !gesture.multi && performance.now() - gesture.startT < TAP_MAX_MS && gesture.moved < TAP_MAX_MOVE_PX;
    if (isTap) {
      if (navigator.vibrate) navigator.vibrate(10);
      act(CMD.CLICK);
    }
  };
  pad.addEventListener('pointerup', endTouch);
  pad.addEventListener('pointercancel', endTouch);

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (app.status !== 'connected') {
      log.info('visibility.reconnect');
      app.retryMs = RETRY_MIN_MS;
      clearTimeout(app.retryTimer);
      app.retryTimer = null;
      connect();
    }
  });
  window.addEventListener('hashchange', () => {
    const fresh = loadPairing();
    if (!fresh) return;
    app.pairing = fresh;
    app.status = 'idle';
    connect();
  });

  // Version shown on screen so a stale GitHub Pages deploy is obvious (compare with the extension popup).
  const VERSION = globalThis.CR_VERSION || 'unknown';
  $('ver').textContent = `v${VERSION}`;
  $('verOverlay').textContent = VERSION;
  log.info('app.start', { version: VERSION, client_id: clientId, paired: Boolean(app.pairing) });

  setInterval(ping, PING_INTERVAL_MS);
  setInterval(render, 1000); // re-evaluate staleness (buttons + panel) even without new messages
  render();
  connect();
})();
