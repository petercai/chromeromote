/**
 * Phone remote controller (layout B + Library tab).
 *
 * Modules (top to bottom): constants -> pairings (several Chromebooks) -> connection (PeerJS,
 * reconnect, ack/timeout, device probes) -> view rendering (pure from latest state) -> library
 * (recent / bookmarks) -> device switcher -> input (touchpad gestures, sliders, buttons).
 * The UI never guesses playback state: it renders only what the extension reports.
 */
(function () {
  'use strict';

  const { CMD, MSG, ERR, makeCmd, needsAck, parsePairHash, extractPairing, formatTime, newId, PROTOCOL_VERSION } = CR;
  const { entryKey } = CRLib;
  const log = CRLog.createLogger('pwa');

  // -------------------------------------------------------------------------
  // Immutable settings
  // -------------------------------------------------------------------------
  const ACK_TIMEOUT_MS = 3000;
  // Signaling + ICE + hello/welcome must finish within this. ICE alone can exceed 10 s when the direct
  // LAN path fails and a TURN relay is used (seen on Chromebooks); the extension allows 30 s for it.
  const CONNECT_TIMEOUT_MS = 35000;
  const PING_INTERVAL_MS = 5000;
  const STATE_STALE_MS = 3500;
  const RETRY_MIN_MS = 1000;
  const RETRY_MAX_MS = 10000;
  const VOLUME_THROTTLE_MS = 100;
  const TAP_MAX_MS = 250;
  const TAP_MAX_MOVE_PX = 10;
  const SCROLL_GAIN = 3;
  const PROBE_TIMEOUT_MS = 6000;
  const MAX_MISSED_PINGS = 2;
  const STORAGE = Object.freeze({ pairings: 'cr.pairings', current: 'cr.current', legacyPairing: 'cr.pairing', clientId: 'cr.clientId' });

  const ERROR_TEXT = Object.freeze({
    [ERR.NO_VIDEO]: '页面上没有找到视频',
    [ERR.NO_TAB]: '没有找到 Chrome 标签页',
    [ERR.NO_TARGET]: '指针下没有可点击的内容',
    [ERR.NO_HISTORY]: '已经是第一页了,没有上一页(停在当前页)',
    [ERR.CLICK_IFRAME]: '暂不支持点击嵌入框架内的内容',
    [ERR.AUTOPLAY_BLOCKED]: '浏览器阻止了有声播放,已静音播放;请调高音量',
    [ERR.NOT_PAIRED]: '密钥无效,请重新扫描电视上的二维码',
    [ERR.TIMEOUT]: '电视端没有响应(超时)',
    [ERR.INTERNAL]: '扩展内部错误',
    [ERR.BAD_MESSAGE]: '命令格式错误',
    [ERR.SYNC_FAILED]: '片单同步失败(Google 账号同步不可用或超出容量)',
  });

  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------------------------
  // Pairings: one phone, several Chromebooks. localStorage holds the list ('cr.pairings':
  // [{peerId, key, name, version, lastConnectedAt}]) and the device used last ('cr.current').
  // -------------------------------------------------------------------------
  const readJson = (k, fallback) => {
    try {
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      return v === null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  };
  const savePairings = (list) => localStorage.setItem(STORAGE.pairings, JSON.stringify(list));
  const setCurrentId = (peerId) => (peerId ? localStorage.setItem(STORAGE.current, peerId) : localStorage.removeItem(STORAGE.current));

  /** Load the list; migrate the pre-1.0.11 single pairing ('cr.pairing') once. */
  const loadPairings = () => {
    const list = readJson(STORAGE.pairings, null);
    if (Array.isArray(list)) return list;
    const legacy = readJson(STORAGE.legacyPairing, null);
    const migrated = legacy && legacy.peerId ? [{ peerId: legacy.peerId, key: legacy.key, name: null, version: null, lastConnectedAt: null }] : [];
    savePairings(migrated);
    if (migrated.length) setCurrentId(migrated[0].peerId);
    localStorage.removeItem(STORAGE.legacyPairing);
    if (migrated.length) log.info('pairing.migrated', { peer_id: migrated[0].peerId });
    return migrated;
  };

  /** Same peerId -> updated in place (keeps list order); new -> appended. Pure. */
  const upsertPairing = (list, p) =>
    list.some((x) => x.peerId === p.peerId) ? list.map((x) => (x.peerId === p.peerId ? { ...x, ...p } : x)) : [...list, p];

  /** A pairing link in the URL (hash, or any mangled form) is added and becomes current. */
  const ingestPairingFromUrl = () => {
    // Normal case: pairing in the hash. Fallback: scanner apps may mangle "#" (%23, %2523, …)
    // while the page still loads (e.g. inside "?t="), so search the whole URL (404.html covers the rest).
    const direct = parsePairHash(location.hash);
    const recovered = direct ? null : extractPairing(location.href);
    if (recovered) log.warn('pairing.url_repaired', { search: location.search.slice(0, 24), path: location.pathname });
    const fromUrl = direct || recovered;
    if (!fromUrl) return null;
    history.replaceState(null, '', location.pathname); // drop secrets (hash) and the one-off ?t= nonce
    savePairings(upsertPairing(loadPairings(), { peerId: fromUrl.peerId, key: fromUrl.key }));
    setCurrentId(fromUrl.peerId);
    log.info('pairing.saved', { peer_id: fromUrl.peerId, key: CRLog.redact(fromUrl.key) });
    return fromUrl;
  };

  /** The device used last (F29: never auto-jump to another device). */
  const currentPairing = (list) => list.find((p) => p.peerId === localStorage.getItem(STORAGE.current)) || list[0] || null;
  const deviceLabel = (p) => (p ? p.name || `Chromebook (${p.peerId.replace(/-/g, '').slice(-4).toUpperCase()})` : '未配对');

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
  ingestPairingFromUrl();
  const initialPairings = loadPairings();
  const app = {
    pairings: initialPairings,
    pairing: currentPairing(initialPairings),
    library: { recent: [], bookmarks: [] },
    libSeg: 'recent',
    libKey: null, // entryKey of the page the library was last refreshed for
    confirm: null, // {title, body, run} while the delete sheet is open
    switcherOpen: false,
    showHelp: false, // "add Chromebook" instructions over a paired session
    probes: new Map(), // peerId -> resolver of an in-flight online probe
    probeResults: new Map(), // peerId -> 'online' | 'offline' | 'checking'
    peer: null,
    conn: null,
    status: 'idle', // idle | connecting | connected | offline | denied | error
    statusDetail: '',
    retryMs: RETRY_MIN_MS,
    retryTimer: null,
    connectTimer: null,
    missedPings: 0,
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
    offline: '不在线',
  });

  let toastTimer = null;
  const toast = (text, kind = 'error') => {
    const el = $('toast');
    el.textContent = text;
    el.className = `toast${kind === 'ok' ? ' ok' : ''}`;
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
    $('deviceName').textContent = deviceLabel(app.pairing);
    $('deviceChip').setAttribute('aria-label', `当前设备:${deviceLabel(app.pairing)},点击切换`);
    $('statusText').textContent = app.statusDetail ? `${STATUS_TEXT[app.status]}:${app.statusDetail}` : STATUS_TEXT[app.status];
    $('statusText').hidden = app.status === 'connected'; // the green dot says it; keeps room for the device name
    $('latency').textContent = app.status === 'connected' && app.latency != null ? `${app.latency} ms` : '';
    $('site').textContent = hostOf(app.url);
    $('unpaired').hidden = Boolean(app.pairing) && !app.showHelp;
    $('unpairedTitle').textContent = app.pairing ? '添加一台 Chromebook' : '还没有配对';
    $('closeHelp').hidden = !app.pairing;
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
    renderBookmarkBtn();
    renderOffline();
    renderSwitcher();
  };

  const switchTab = (tab) => {
    app.tab = tab;
    // Library may have changed elsewhere (another phone, another synced Chromebook): refresh on view.
    if (tab === 'library' || tab === 'play') refreshLibrary();
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
    // New page on the TV: refresh the library once so the ★ reflects this page.
    const key = entryKey(app.url);
    if (key && key !== app.libKey) refreshLibrary();
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
      clearTimeout(app.connectTimer);
      app.retryMs = RETRY_MIN_MS;
      // Remember the Chromebook's name/version: the status bar and switcher show WHICH device this is.
      const updated = { peerId: app.pairing.peerId, name: data.name || app.pairing.name || null, version: data.version || null, lastConnectedAt: Date.now() };
      app.pairings = upsertPairing(app.pairings, updated);
      app.pairing = app.pairings.find((p) => p.peerId === updated.peerId);
      savePairings(app.pairings);
      log.info('device.welcome', { peer_id: updated.peerId, name: updated.name, version: updated.version });
      setStatus('connected');
      refreshLibrary();
      return;
    }
    if (data.type === MSG.DENIED) {
      // Only THIS pairing is invalid (key regenerated); other Chromebooks stay paired.
      const deniedId = app.pairing && app.pairing.peerId;
      setStatus('denied', ERROR_TEXT[data.error_code] || data.error_code);
      app.pairings = app.pairings.filter((p) => p.peerId !== deniedId);
      savePairings(app.pairings);
      setCurrentId(null);
      app.pairing = null;
      teardown();
      if (app.pairings.length) app.switcherOpen = true; // let the user pick another device
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
    const peer = new Peer({ debug: 1, config: { iceServers: CR.ICE_SERVERS } });
    app.peer = peer;

    // Watchdog: signaling, ICE or the hello/welcome handshake can stall without any error event.
    // Without this the UI would sit on "连接中…" forever; instead tear down and retry with backoff.
    let ice = { state: () => 'not_started', report: () => Promise.resolve() }; // replaced once the data connection exists
    clearTimeout(app.connectTimer);
    app.connectTimer = setTimeout(() => {
      if (app.peer !== peer || app.status === 'connected') return;
      log.warn('connect.timeout', {
        timeout_ms: CONNECT_TIMEOUT_MS,
        peer_open: peer.open,
        conn_open: Boolean(app.conn && app.conn.open),
        ice_state: ice.state(),
      });
      ice.report('connect_timeout');
      setStatus('connecting', '电视端没有响应,正在重试');
      scheduleReconnect('connect_timeout');
    }, CONNECT_TIMEOUT_MS);

    peer.on('open', () => {
      const conn = peer.connect(app.pairing.peerId, { reliable: true });
      app.conn = conn;
      ice = CRLog.watchIce(conn.peerConnection, log, { peer_id: app.pairing.peerId });
      conn.on('open', () => {
        log.info('conn.open', { peer_id: app.pairing.peerId, ice_state: ice.state() });
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
      // 'peer-unavailable' also answers online probes of OTHER devices: route those to the prober.
      const target = err.type === 'peer-unavailable' ? (String(err.message).match(/peer\s+(\S+)/i) || [])[1] : null;
      if (target && app.probes.has(target)) {
        app.probes.get(target)('offline');
        return;
      }
      log.error('peer.error', { type: err.type, error: String(err) });
      if (err.type === 'peer-unavailable') {
        // Current device offline (F29): show the offline screen, keep retrying, never auto-switch.
        setStatus('offline', deviceLabel(app.pairing));
        probeOthers();
      } else {
        setStatus('error', err.type);
      }
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

  // Heartbeat: a WebRTC data channel does NOT report a vanished Chromebook (power off, lid closed);
  // measured: still "connected" after 90 s. Two missed pings (~13 s) = connection lost -> reconnect,
  // which then surfaces 'peer-unavailable' and the offline screen.
  const ping = async () => {
    if (app.status !== 'connected') return;
    const started = performance.now();
    const res = await send(CMD.PING);
    if (app.status !== 'connected') return;
    app.latency = res.ok ? Math.round(performance.now() - started) : null;
    app.missedPings = res.ok ? 0 : app.missedPings + 1;
    if (app.missedPings >= MAX_MISSED_PINGS) {
      log.warn('heartbeat.lost', { missed: app.missedPings, peer_id: app.pairing && app.pairing.peerId });
      app.missedPings = 0;
      teardown();
      setStatus('connecting', '连接中断,正在重新连接');
      scheduleReconnect('heartbeat_lost');
      return;
    }
    renderStatus();
  };

  // -------------------------------------------------------------------------
  // Library: recent (synced, last 10) + bookmarks. Data lives in the extension (chrome.storage.sync);
  // the phone only holds the last fetched copy for rendering.
  // -------------------------------------------------------------------------
  const ago = (ts) => {
    if (!ts) return '';
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.round(h / 24);
    return d === 1 ? '昨天' : `${d} 天前`;
  };

  const refreshLibrary = async () => {
    if (app.status !== 'connected') return;
    const res = await send(CMD.LIBRARY_LIST);
    if (!res.ok) return;
    app.library = res.data;
    app.libKey = entryKey(app.url);
    renderLibrary();
    renderBookmarkBtn();
  };

  const isBookmarked = () => {
    const key = entryKey(app.url);
    return Boolean(key) && app.library.bookmarks.some((b) => b.key === key);
  };

  const renderBookmarkBtn = () => {
    const btn = $('bookmarkBtn');
    const on = isBookmarked();
    btn.disabled = app.status !== 'connected' || !entryKey(app.url);
    btn.classList.toggle('on', on);
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? '已收藏,点击取消收藏' : '收藏当前视频');
  };

  const toggleBookmark = async () => {
    const key = entryKey(app.url);
    if (!key) return;
    await refreshLibrary(); // decide on fresh data, never on a stale copy
    const on = isBookmarked();
    const res = await act(on ? CMD.BOOKMARK_REMOVE : CMD.BOOKMARK_ADD, on ? { key } : {});
    if (!res.ok) return;
    log.info('library.bookmark_toggled', { key, on: !on });
    toast(on ? '已取消收藏' : `已收藏 ${formatTime(res.data.entry.time)} · 已同步`, 'ok');
    await refreshLibrary();
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const libraryRow = (entry, kind) => {
    const li = el('li', 'lib-row');
    const open = el('button', 'lib-open');
    open.append(el('span', 't', entry.title));
    const parts = kind === 'recent'
      ? [`看到 ${formatTime(entry.time)}${entry.duration ? ` / ${formatTime(entry.duration)}` : ''}`, ago(entry.updatedAt)]
      : [`收藏于 ${formatTime(entry.time)}`, ago(entry.updatedAt)];
    if (entry.device && entry.device !== (app.pairing && app.pairing.name)) parts.push(entry.device);
    open.append(el('span', 's', parts.filter(Boolean).join(' · ')));
    if (kind === 'recent' && entry.duration) {
      const bar = el('span', 'bar');
      const fill = el('span');
      fill.style.width = `${Math.min(100, Math.round((entry.time / entry.duration) * 100))}%`;
      bar.append(fill);
      open.append(bar);
    }
    open.addEventListener('click', () => openEntry(entry));
    const del = el('button', 'lib-del', '🗑');
    del.setAttribute('aria-label', kind === 'recent' ? '删除这条记录' : '删除收藏');
    del.addEventListener('click', () => askDelete(entry, kind));
    li.append(open, del);
    return li;
  };

  const renderLibrary = () => {
    const kind = app.libSeg;
    const items = kind === 'recent' ? app.library.recent : app.library.bookmarks;
    $('segRecent').classList.toggle('active', kind === 'recent');
    $('segBookmarks').classList.toggle('active', kind === 'bookmarks');
    $('segRecent').textContent = `最近 ${app.library.recent.length}`;
    $('segBookmarks').textContent = `收藏 ${app.library.bookmarks.length}`;
    $('libList').replaceChildren(...items.map((e) => libraryRow(e, kind)));
    $('libEmpty').hidden = items.length > 0;
    $('libEmpty').textContent = kind === 'recent' ? '还没有观看记录(看 15 秒以上会自动记录)' : '还没有收藏,在播放页点 ☆ 收藏';
  };

  const openEntry = async (entry) => {
    log.info('library.open_clicked', { key: entry.key, time: entry.time });
    const res = await act(CMD.OPEN_ENTRY, { url: entry.url, time: entry.time });
    if (res.ok) switchTab('play');
  };

  const askDelete = (entry, kind) => {
    app.confirm = {
      title: kind === 'recent' ? '删除这条观看记录?' : '删除这个收藏?',
      body: `${entry.title}\n删除后会同步到所有登录同一账号的 Chromebook。`,
      run: () => act(kind === 'recent' ? CMD.RECENT_REMOVE : CMD.BOOKMARK_REMOVE, { key: entry.key }),
    };
    renderConfirm();
  };

  const renderConfirm = () => {
    $('confirm').hidden = !app.confirm;
    if (!app.confirm) return;
    $('confirmTitle').textContent = app.confirm.title;
    $('confirmBody').textContent = app.confirm.body;
    $('confirmBody').style.whiteSpace = 'pre-line';
  };

  // -------------------------------------------------------------------------
  // Devices: switcher, online probes, offline screen
  // -------------------------------------------------------------------------
  /** Is another Chromebook online? Opens (then closes) a data connection on the current peer. */
  const probeDevice = (peerId) =>
    new Promise((resolve) => {
      if (app.pairing && peerId === app.pairing.peerId && app.status === 'connected') return resolve('online');
      if (!app.peer || !app.peer.open) return resolve('unknown');
      let c = null;
      const done = (result) => {
        clearTimeout(timer);
        app.probes.delete(peerId);
        if (c) c.close();
        resolve(result);
      };
      const timer = setTimeout(() => done('offline'), PROBE_TIMEOUT_MS);
      app.probes.set(peerId, done);
      c = app.peer.connect(peerId, { reliable: true });
      c.on('open', () => done('online'));
    });

  const probeOthers = () => {
    app.pairings.forEach((p) => {
      app.probeResults.set(p.peerId, 'checking');
      probeDevice(p.peerId).then((r) => {
        app.probeResults.set(p.peerId, r);
        log.debug('device.probe', { peer_id: p.peerId, result: r });
        renderSwitcher();
        renderOffline();
      });
    });
  };

  const switchDevice = (peerId) => {
    if (app.pairing && peerId === app.pairing.peerId && app.status === 'connected') {
      app.switcherOpen = false;
      return render();
    }
    log.info('device.switch', { from: app.pairing && app.pairing.peerId, to: peerId });
    setCurrentId(peerId);
    app.pairing = app.pairings.find((p) => p.peerId === peerId) || null;
    app.switcherOpen = false;
    app.library = { recent: [], bookmarks: [] };
    app.video = { hasVideo: false };
    app.url = '';
    app.retryMs = RETRY_MIN_MS;
    clearTimeout(app.retryTimer);
    app.retryTimer = null;
    connect();
  };

  const removeDevice = (peerId) => {
    log.info('device.removed', { peer_id: peerId });
    app.pairings = app.pairings.filter((p) => p.peerId !== peerId);
    savePairings(app.pairings);
    if (app.pairing && app.pairing.peerId === peerId) {
      setCurrentId(null);
      app.pairing = null;
      teardown();
      setStatus('idle');
    }
    render();
  };

  const deviceStatusText = (p) => {
    const isCurrent = app.pairing && p.peerId === app.pairing.peerId;
    if (isCurrent && app.status === 'connected') return { on: true, text: `● 在线 · 正在控制${p.version ? ` · v${p.version}` : ''}` };
    const r = app.probeResults.get(p.peerId);
    if (r === 'online') return { on: true, text: '● 在线 · 点一下切换' };
    if (r === 'checking') return { on: false, text: '检查中…' };
    return { on: false, text: `○ 不在线${p.lastConnectedAt ? ` · 上次连接 ${ago(p.lastConnectedAt)}` : ''}` };
  };

  const deviceRow = (p, { withDelete }) => {
    const isCurrent = app.pairing && p.peerId === app.pairing.peerId;
    const li = el('li', `device-row${isCurrent ? ' current' : ''}`);
    const pick = el('button', 'device-pick');
    const st = deviceStatusText(p);
    pick.append(el('span', 'n', deviceLabel(p)), el('span', `s${st.on ? ' on' : ''}`, st.text));
    if (isCurrent) pick.setAttribute('aria-current', 'true');
    pick.addEventListener('click', () => switchDevice(p.peerId));
    li.append(pick);
    if (withDelete) {
      const del = el('button', 'lib-del', '🗑');
      del.setAttribute('aria-label', `删除 ${deviceLabel(p)} 的配对`);
      del.addEventListener('click', () => {
        app.confirm = {
          title: `删除 ${deviceLabel(p)} 的配对?`,
          body: '删除后需要重新扫描这台 Chromebook 弹窗里的二维码才能再控制它。',
          run: async () => {
            removeDevice(p.peerId);
            return { ok: true };
          },
        };
        renderConfirm();
      });
      li.append(del);
    }
    return li;
  };

  const renderSwitcher = () => {
    $('switcher').hidden = !app.switcherOpen;
    $('deviceChip').setAttribute('aria-expanded', String(app.switcherOpen));
    if (!app.switcherOpen) return;
    $('deviceList').replaceChildren(...app.pairings.map((p) => deviceRow(p, { withDelete: true })));
  };

  const renderOffline = () => {
    const show = app.status === 'offline';
    $('offline').hidden = !show;
    if (!show) return;
    $('offlineTitle').textContent = `${deviceLabel(app.pairing)} 不在线`;
    const others = app.pairings.filter((p) => !app.pairing || p.peerId !== app.pairing.peerId);
    $('offlineOthersLabel').hidden = others.length === 0;
    $('offlineOthers').replaceChildren(...others.map((p) => deviceRow(p, { withDelete: false })));
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
  document.querySelectorAll('.segment button').forEach((btn) =>
    btn.addEventListener('click', () => {
      app.libSeg = btn.dataset.seg;
      renderLibrary();
    })
  );
  $('bookmarkBtn').addEventListener('click', toggleBookmark);
  $('deviceChip').addEventListener('click', () => {
    app.switcherOpen = !app.switcherOpen;
    if (app.switcherOpen) probeOthers();
    render();
  });
  $('switcher').addEventListener('click', (e) => {
    if (e.target === $('switcher')) {
      app.switcherOpen = false;
      render();
    }
  });
  $('addDevice').addEventListener('click', () => {
    app.switcherOpen = false;
    app.showHelp = true;
    render();
  });
  $('closeHelp').addEventListener('click', () => {
    app.showHelp = false;
    render();
  });
  $('confirmCancel').addEventListener('click', () => {
    app.confirm = null;
    renderConfirm();
  });
  $('confirmOk').addEventListener('click', async () => {
    const job = app.confirm;
    app.confirm = null;
    renderConfirm();
    if (!job) return;
    const res = await job.run();
    if (res && res.ok) await refreshLibrary();
  });

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
    const fresh = ingestPairingFromUrl();
    if (!fresh) return;
    app.pairings = loadPairings();
    app.pairing = currentPairing(app.pairings);
    app.showHelp = false;
    app.status = 'idle';
    connect();
  });

  // Version shown on screen so a stale GitHub Pages deploy is obvious (compare with the extension popup).
  const VERSION = globalThis.CR_VERSION || 'unknown';
  $('ver').textContent = `v${VERSION}`;
  $('verOverlay').textContent = VERSION;
  log.info('app.start', { version: VERSION, client_id: clientId, paired: Boolean(app.pairing), devices: app.pairings.length });

  // Diagnostics / automation seam: lets DevTools (and the e2e test) issue raw protocol commands,
  // e.g. CRRemote.send('libraryList'). Same path as the buttons, so replies and logs are identical.
  globalThis.CRRemote = Object.freeze({
    send,
    status: () => app.status,
    version: VERSION,
    devices: () => app.pairings.map((p) => ({ peerId: p.peerId, name: p.name, current: Boolean(app.pairing && p.peerId === app.pairing.peerId) })),
  });

  setInterval(ping, PING_INTERVAL_MS);
  setInterval(render, 1000); // re-evaluate staleness (buttons + panel) even without new messages
  render();
  connect();
})();
