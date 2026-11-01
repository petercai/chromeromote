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
  const { YT_SECTION } = CR;
  const log = CRLog.createLogger('pwa');

  // -------------------------------------------------------------------------
  // Immutable settings
  // -------------------------------------------------------------------------
  const ACK_TIMEOUT_MS = 3000;
  // Episode-list commands may switch the site's range tabs (up to ~2.5 s each) before answering.
  const SLOW_ACK_TIMEOUT_MS = 8000;
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
  // YouTube reads may first open the background data tab and wait for youtube.com to load (design 3.13.9).
  const YT_ACK_TIMEOUT_MS = 20000;
  const YT_MORE_SCREENS = 3; // load the next page when fewer than this many screens remain below
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_PX = 10;
  const MAX_MISSED_PINGS = 2;
  const STORAGE = Object.freeze({
    pairings: 'cr.pairings',
    current: 'cr.current',
    legacyPairing: 'cr.pairing',
    clientId: 'cr.clientId',
    launchLink: 'cr.launchLink', // iOS home-screen app: pairing link already imported (peerId:key)
    installHintOff: 'cr.installHintOff', // iOS Safari: "Add to Home Screen" hint dismissed
  });

  // Runtime environment (iteration 20). iPad on iOS 12: no Pointer Events, and a home-screen app
  // has its own storage (not Safari's) and possibly no WebRTC.
  const ENV = Object.freeze({
    ios: 'standalone' in navigator, // only iOS / iPadOS Safari defines navigator.standalone
    homeScreenApp: navigator.standalone === true || Boolean(window.matchMedia && matchMedia('(display-mode: standalone)').matches),
    pointerEvents: Boolean(window.PointerEvent),
    webrtc: typeof RTCPeerConnection !== 'undefined',
  });
  // iOS Safari tab (not the home-screen app): the address bar must carry the pairing for "Add to Home Screen".
  const IOS_SAFARI_TAB = ENV.ios && !ENV.homeScreenApp;
  const pairingId = (p) => `${p.peerId}:${p.key}`;

  const ERROR_TEXT = Object.freeze({
    [ERR.NO_VIDEO]: '页面上没有找到视频',
    [ERR.NO_PLAYLIST]: '这个页面没有选集',
    [ERR.NO_EPISODE]: '没有上一集 / 下一集了',
    [ERR.NO_TAB]: 'Chrome 没有打开的窗口,点「首页」打开',
    [ERR.NO_TARGET]: '指针下没有可点击的内容',
    [ERR.NO_HISTORY]: '已经是第一页了,没有上一页(停在当前页)',
    [ERR.CLICK_IFRAME]: '暂不支持点击嵌入框架内的内容',
    [ERR.AUTOPLAY_BLOCKED]: '浏览器阻止了有声播放,已静音播放;请调高音量',
    [ERR.NOT_PAIRED]: '密钥无效,请重新扫描电视上的二维码',
    [ERR.TIMEOUT]: '电视端没有响应(超时)',
    [ERR.INTERNAL]: '扩展内部错误',
    [ERR.BAD_MESSAGE]: '命令格式错误',
    [ERR.SYNC_FAILED]: '片单同步失败(Google 账号同步不可用或超出容量)',
    [ERR.YT_SIGNED_OUT]: '请先在 Chromebook 的 Chrome 里登录 YouTube',
    [ERR.YT_FAILED]: 'YouTube 读取失败',
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
    // iOS home-screen app: every launch opens the link saved at "Add to Home Screen". Import it once,
    // so a pairing deleted (or denied) later is not re-added on the next launch.
    if (ENV.ios && ENV.homeScreenApp) {
      const seen = localStorage.getItem(STORAGE.launchLink) === pairingId(fromUrl);
      log.info('pairing.launch_link', { peer_id: fromUrl.peerId, imported: !seen });
      if (seen) return null;
      localStorage.setItem(STORAGE.launchLink, pairingId(fromUrl));
    }
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
    playlist: null, // episode-list summary pushed with the video state (design 3.11), null = none
    // YouTube tab (design 3.13): a stack of views; each keeps its own cards, cursor and scroll position,
    // so "back" restores the previous list instantly. Root views are the four sections.
    yt: [],
    ytSeq: 0, // request generation: replies for a view that is no longer shown are dropped
    ytMenu: null, // card whose long-press menu is open
    ytAutoSwitched: false, // the TV-on-YouTube auto switch happens once per connection (Q41)
    upNext: { videoId: null, items: [] },
    plSheet: null, // {loading, data, error} while the episode sheet is open
    switcherOpen: false,
    showHelp: false, // "add Chromebook" instructions over a paired session
    noWebrtc: null, // reason string when this browser / home-screen app cannot open WebRTC connections
    installLink: null, // iOS Safari tab: pairing id currently written into the address bar
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

  // Previous / next episode buttons follow the pushed summary (data-dir -1 / 1).
  const playlistAllows = (b) => Boolean(app.playlist) && (Number(b.dataset.dir) < 0 ? app.playlist.hasPrev : app.playlist.hasNext);

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
      b.disabled =
        app.status !== 'connected' ||
        (b.classList.contains('needs-video') && !videoAvailable()) ||
        (b.classList.contains('needs-playlist') && !playlistAllows(b));
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

  /** Link that opens this page with the current pairing (home-screen start URL / Safari fallback). */
  const pairingLink = (p) => (p ? CR.buildPairUrl({ baseUrl: location.origin + location.pathname, peerId: p.peerId, key: p.key }) : location.pathname);

  // iOS home screen (iteration 20): Safari and the home-screen app do not share storage, so the
  // Safari tab keeps the current pairing in its address bar; "Add to Home Screen" saves that link.
  const renderInstall = () => {
    if (IOS_SAFARI_TAB) {
      const id = app.pairing ? pairingId(app.pairing) : null;
      if (id !== app.installLink) {
        app.installLink = id;
        history.replaceState(null, '', pairingLink(app.pairing)); // replaceState: no hashchange event
      }
    }
    const hint = IOS_SAFARI_TAB && Boolean(app.pairing) && !app.noWebrtc && !localStorage.getItem(STORAGE.installHintOff);
    if (hint && $('installHint').hidden) log.info('pairing.install_hint', { peer_id: app.pairing.peerId });
    $('installHint').hidden = !hint;
    $('noWebrtc').hidden = !app.noWebrtc;
    if (app.noWebrtc) $('openSafari').href = pairingLink(app.pairing);
  };

  const render = () => {
    renderInstall();
    renderStatus();
    renderVideo();
    renderPlaylist();
    renderBookmarkBtn();
    renderOffline();
    renderSwitcher();
    renderYtNow();
  };

  const switchTab = (tab) => {
    app.tab = tab;
    // Library may have changed elsewhere (another phone, another synced Chromebook): refresh on view.
    if (tab === 'library' || tab === 'play') refreshLibrary();
    if (tab === 'youtube') ensureYtLoaded();
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
    app.playlist = state.playlist || null;
    app.url = state.url || app.url;
    // New page on the TV: refresh the library once so the ★ reflects this page.
    const key = entryKey(app.url);
    if (key && key !== app.libKey) refreshLibrary();
    // Auto-switch to Play when playback starts (paused: true/undefined -> false).
    if (state.hasVideo && state.paused === false && prev.paused !== false && app.tab === 'browse') {
      log.info('tab.auto_switch', { to: 'play' });
      switchTab('play');
    }
    ytOnState();
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
      app.ytAutoSwitched = false;
      setStatus('connected');
      refreshLibrary();
      if (app.tab === 'youtube') ensureYtLoaded();
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

  /** No WebRTC here (seen in iOS 12 home-screen apps): stop retrying, offer the page in Safari. */
  const webrtcUnavailable = (reason) => {
    log.error('webrtc.unavailable', { reason, ios: ENV.ios, home_screen_app: ENV.homeScreenApp });
    teardown();
    app.noWebrtc = reason;
    setStatus('error', '这个浏览器不支持 WebRTC');
  };

  const connect = () => {
    teardown();
    if (!app.pairing) {
      setStatus('idle');
      return;
    }
    if (!ENV.webrtc) return webrtcUnavailable('no_rtcpeerconnection');
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
      if (err.type === 'browser-incompatible') return webrtcUnavailable(err.type); // retrying cannot help
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

  const SLOW_CMDS = Object.freeze([CMD.PLAYLIST_GET, CMD.PLAYLIST_OPEN, CMD.PLAYLIST_STEP]);
  const YT_CMDS = Object.freeze([CMD.YT_BROWSE, CMD.YT_UP_NEXT, CMD.YT_OPEN, CMD.YT_WATCH_LATER]);
  const ackTimeoutOf = (cmd) => (YT_CMDS.includes(cmd) ? YT_ACK_TIMEOUT_MS : SLOW_CMDS.includes(cmd) ? SLOW_ACK_TIMEOUT_MS : ACK_TIMEOUT_MS);

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
      }, ackTimeoutOf(cmd));
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

  // Element.replaceChildren needs Safari 14; iOS 12 (iPad) is a target, so clear + append.
  const setChildren = (parent, nodes) => {
    parent.textContent = '';
    parent.append(...nodes);
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
    setChildren($('libList'), items.map((e) => libraryRow(e, kind)));
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
  // Episode list (design 3.11, option C): entry row + previous / next from the pushed summary,
  // full list in a bottom sheet fetched on open. The phone keeps no copy beyond the open sheet.
  // -------------------------------------------------------------------------
  const playlistInfoText = (pl) => {
    const extra = pl.specials ? ` + ${pl.specials} 个特别篇` : '';
    if (!pl.current) return `共 ${pl.total} 集${extra}`;
    return pl.currentSpecial ? `特别篇:${pl.current} · 共 ${pl.total} 集` : `第 ${pl.current} 集 / 共 ${pl.total} 集${extra}`;
  };

  const renderPlaylist = () => {
    const pl = app.status === 'connected' ? app.playlist : null;
    $('playlistRow').hidden = !pl;
    if (pl) $('playlistInfo').textContent = playlistInfoText(pl);
    renderPlaylistSheet();
  };

  const episodeChip = (ep, current, viewRange) => {
    const b = el('button', `pl-chip${current ? ' current' : ''}`, ep.label);
    if (current) b.setAttribute('aria-current', 'true');
    b.setAttribute('aria-label', `第 ${ep.label} 集`);
    b.addEventListener('click', () => openEpisodeFromSheet(ep, viewRange));
    return b;
  };

  const specialRow = (sp, current, viewRange) => {
    const b = el('button', `pl-special${current ? ' current' : ''}`, sp.label);
    b.append(el('small', null, sp.after ? `在 ${sp.after} 之后` : '在最前面'));
    b.addEventListener('click', () => openEpisodeFromSheet(sp, viewRange));
    return b;
  };

  const renderPlaylistSheet = () => {
    const sheet = app.plSheet;
    $('playlistSheet').hidden = !sheet;
    if (!sheet) return;
    const d = sheet.data;
    const currentId = d && d.current ? d.current.id : null;
    $('plTitle').textContent = d && d.title ? `选集 · ${d.title}` : '选集';
    $('plSub').textContent = d ? `${d.current ? (d.current.special ? `正在播放特别篇:${d.current.label}` : `正在播放第 ${d.current.label} 集`) : '没有正在播放的一集'} · 点一集在电视上播放` : '';
    $('plStatus').hidden = !sheet.loading && !sheet.error;
    $('plStatus').textContent = sheet.loading ? '正在读取选集…' : sheet.error || '';
    const ranges = d ? d.ranges : [];
    $('plRanges').hidden = ranges.length < 2;
    setChildren(
      $('plRanges'),
      ranges.map((r) => {
        const b = el('button', r.index === d.viewRange ? 'active' : '', r.label);
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(r.index === d.viewRange));
        b.addEventListener('click', () => loadPlaylist(r.index));
        return b;
      })
    );
    const eps = d && !sheet.loading ? d.episodes : [];
    const sps = d && !sheet.loading ? d.specials : [];
    $('plEpisodesHead').hidden = eps.length === 0;
    $('plEpisodesHead').textContent = `正片 ${eps.length} 集`;
    setChildren($('plGrid'), eps.map((ep) => episodeChip(ep, ep.id === currentId, d.viewRange)));
    $('plSpecialsHead').hidden = sps.length === 0;
    $('plSpecialsHead').textContent = `特别篇 ${sps.length}`;
    setChildren($('plSpecials'), sps.map((sp) => specialRow(sp, sp.id === currentId, d.viewRange)));
  };

  /** Fetch the list (optionally another range); keeps the previous data visible while loading. */
  const loadPlaylist = async (range) => {
    if (!app.plSheet) return;
    app.plSheet = { ...app.plSheet, loading: true, error: null };
    renderPlaylistSheet();
    const res = await send(CMD.PLAYLIST_GET, range === undefined ? {} : { range });
    if (!app.plSheet) return; // closed meanwhile
    app.plSheet = res.ok
      ? { loading: false, data: res.data, error: null }
      : { ...app.plSheet, loading: false, error: ERROR_TEXT[res.error_code] || `读取失败:${res.error_code}` };
    log.info('ui.playlist_loaded', { ok: res.ok, error_code: res.error_code, range, count: res.ok ? res.data.episodes.length : 0 });
    renderPlaylistSheet();
  };

  const openPlaylistSheet = () => {
    log.info('ui.playlist_sheet', { action: 'open', current: app.playlist && app.playlist.current });
    app.plSheet = { loading: true, data: null, error: null };
    loadPlaylist();
  };

  const closePlaylistSheet = (reason) => {
    if (!app.plSheet) return;
    log.info('ui.playlist_sheet', { action: 'close', reason });
    app.plSheet = null;
    renderPlaylistSheet();
  };

  const openEpisodeFromSheet = async (item, viewRange) => {
    log.info('ui.playlist_pick', { id: item.id, label: item.label, range: viewRange });
    const args = { id: item.id, ...(item.href && item.href.startsWith('/') && !item.href.startsWith('//') ? { href: item.href } : {}) };
    const res = await act(CMD.PLAYLIST_OPEN, viewRange >= 0 ? { ...args, range: viewRange } : args);
    if (!res.ok) return;
    closePlaylistSheet('picked');
    toast(`正在打开 ${isEpisodeLabel(item.label) ? `第 ${item.label} 集` : item.label}`, 'ok');
  };

  // Same rule as CRPlay.isEpisodeLabel in the extension (the phone does not load lib/playlist.js).
  const isEpisodeLabel = (label) => /^\d+$/.test(String(label || '').trim());

  // -------------------------------------------------------------------------
  // YouTube tab (design 3.13, option A): browse on the phone, the TV changes only when a card is
  // tapped (Q40). Cards come from the extension (ytBrowse); thumbnails load straight from i.ytimg.com.
  // -------------------------------------------------------------------------
  const YT_ROOT_TITLES = Object.freeze({
    [YT_SECTION.HOME]: '首页',
    [YT_SECTION.SUBSCRIPTIONS]: '订阅',
    [YT_SECTION.PLAYLISTS]: '播放列表',
    [YT_SECTION.WATCH_LATER]: '稍后观看',
  });
  const YT_EMPTY_TEXT = Object.freeze({
    [YT_SECTION.WATCH_LATER]: '稍后观看是空的(长按视频可以加入)',
    [YT_SECTION.PLAYLISTS]: '还没有播放列表',
  });

  const ytView = (section, id = null, title = null) => ({ section, id, title, items: [], cursor: null, loading: false, error: null, loaded: false, scrollTop: 0 });
  const ytCurrent = () => app.yt[app.yt.length - 1] || null;

  /** Load the first page of the current view (more = the next page). Never runs two loads for one view. */
  const loadYt = async ({ more = false } = {}) => {
    const view = ytCurrent();
    if (!view || view.loading || app.status !== 'connected' || (more && !view.cursor)) return;
    const seq = (app.ytSeq += 1);
    view.loading = true;
    view.error = null;
    renderYt();
    log.info(more ? 'ui.yt_more' : 'ui.yt_section', { section: view.section, id: view.id, loaded: view.items.length });
    const args = { section: view.section, ...(view.id ? { id: view.id } : {}), ...(more ? { cursor: view.cursor } : {}) };
    const res = await send(CMD.YT_BROWSE, args);
    view.loading = false;
    if (res.ok) {
      view.items = more ? view.items.concat(res.data.items) : res.data.items;
      view.cursor = res.data.cursor || null;
      view.title = view.title || res.data.title || null;
      view.loaded = true;
    } else {
      view.error = res.error_code;
      log.warn('ui.yt_failed', { section: view.section, error_code: res.error_code, reason: res.data && res.data.reason });
    }
    if (seq === app.ytSeq || ytCurrent() === view) renderYt();
  };

  const ensureYtLoaded = () => {
    if (!app.yt.length) app.yt = [ytView(YT_SECTION.HOME)];
    const view = ytCurrent();
    if (!view.loaded && !view.loading) loadYt();
    else renderYt();
  };

  const openYtRoot = (section) => {
    app.yt = [ytView(section)];
    $('ytList').scrollTop = 0;
    loadYt();
  };

  const pushYtView = (section, id, title) => {
    const cur = ytCurrent();
    if (cur) cur.scrollTop = $('ytList').scrollTop;
    app.yt = app.yt.concat([ytView(section, id, title)]);
    $('ytList').scrollTop = 0;
    loadYt();
  };

  const popYtView = () => {
    if (app.yt.length < 2) return;
    app.yt = app.yt.slice(0, -1);
    renderYt();
    $('ytList').scrollTop = ytCurrent().scrollTop; // back = where you were
  };

  /** Tap a card: a video plays on the TV (inside a playlist: continuing through it); a playlist opens on the phone. */
  const openYtCard = async (c, view) => {
    if (c.kind === 'playlist') return pushYtView(YT_SECTION.PLAYLIST, c.id, c.title);
    log.info('ui.yt_open', { video_id: c.id, from: view ? view.section : 'upNext' });
    const res = await act(CMD.YT_OPEN, { videoId: c.id, ...(view && view.section === YT_SECTION.PLAYLIST ? { playlistId: view.id } : {}) });
    if (!res.ok) return;
    toast(`正在电视上打开:${c.title}`, 'ok');
    switchTab('play');
  };

  /** Long press (touch) or context menu (Android long press / mouse right click) without a click afterwards. */
  const onLongPress = (el, fn) => {
    let timer = null;
    let start = null;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };
    el.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      cancel();
      timer = setTimeout(() => {
        timer = null;
        el.dataset.longPressed = '1';
        fn();
      }, LONG_PRESS_MS);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (start && Math.abs(t.clientX - start.x) + Math.abs(t.clientY - start.y) > LONG_PRESS_MOVE_PX) cancel();
    }, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchcancel', cancel);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (el.dataset.longPressed === '1') return; // the touch timer already fired
      el.dataset.longPressed = '1';
      fn();
    });
  };

  const ytCard = (c, view) => {
    const li = el('li');
    const b = el('button', 'yt-card');
    const thumb = el('span', 'yt-thumb');
    if (c.thumb) {
      const img = el('img');
      img.src = c.thumb;
      img.alt = '';
      img.loading = 'lazy';
      thumb.append(img);
    }
    const badge = c.kind === 'playlist' ? c.count : c.duration;
    if (badge) thumb.append(el('span', 'yt-badge', badge));
    if (c.progress) {
      const bar = el('span', 'yt-progress');
      bar.style.width = `${c.progress}%`;
      thumb.append(bar);
    }
    const text = el('span', 'yt-text');
    text.append(el('span', 't', c.title));
    const sub = c.kind === 'playlist' ? ['播放列表', c.channel, c.meta] : [c.channel, c.meta];
    text.append(el('span', 's', sub.filter(Boolean).join(' · ')));
    b.append(thumb, text);
    b.addEventListener('click', () => {
      if (b.dataset.longPressed === '1') {
        b.dataset.longPressed = '';
        return;
      }
      openYtCard(c, view);
    });
    if (c.kind === 'video') onLongPress(b, () => openYtMenu(c));
    li.append(b);
    return li;
  };

  const ytStatusText = (view) => {
    if (view.loading && !view.items.length) return '正在读取…';
    if (view.loading) return '正在读取更多…';
    if (view.error) return ERROR_TEXT[view.error] || `读取失败:${view.error}`;
    if (view.loaded && !view.items.length) return YT_EMPTY_TEXT[view.section] || '这里还没有视频';
    return '';
  };

  const renderYt = () => {
    const view = ytCurrent();
    const root = app.yt[0];
    const nested = app.yt.length > 1;
    document.querySelectorAll('#ytChips button').forEach((b) => {
      const on = Boolean(root) && !nested && b.dataset.ytSection === root.section;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    $('ytChips').hidden = nested;
    $('ytHead').hidden = !nested;
    if (!view) {
      setChildren($('ytList'), []);
      $('ytState').hidden = true;
      return;
    }
    $('ytTitle').textContent = view.title || YT_ROOT_TITLES[view.section] || '';
    $('ytPlayAll').hidden = !(view.section === YT_SECTION.PLAYLIST && view.items.some((c) => c.kind === 'video'));
    setChildren($('ytList'), view.items.map((c) => ytCard(c, view)));
    const status = ytStatusText(view);
    $('ytState').hidden = !status;
    $('ytStatus').textContent = status;
    $('ytRetry').hidden = !view.error;
  };

  // "Playing on the TV" bar: a shortcut back to the Play tab while browsing.
  const renderYtNow = () => {
    const show = videoAvailable();
    $('ytNow').hidden = !show;
    if (show) $('ytNowTitle').textContent = app.title || '正在播放';
  };

  const openYtMenu = (c) => {
    log.info('ui.yt_longpress', { video_id: c.id });
    app.ytMenu = c;
    $('ytMenuTitle').textContent = c.title;
    $('ytMenuChannel').disabled = !c.channelId;
    $('ytMenu').hidden = false;
  };
  const closeYtMenu = () => {
    app.ytMenu = null;
    $('ytMenu').hidden = true;
  };

  // Play tab "Up next": refreshed when the TV's YouTube video changes, never on every state push.
  const renderUpNext = () => {
    const items = app.status === 'connected' && CRYt.videoIdOf(app.url) ? app.upNext.items : [];
    $('upNext').hidden = items.length === 0;
    setChildren($('upNextList'), items.map((c) => ytCard(c, null)));
  };

  const ytOnState = () => {
    // Q41: the TV shows YouTube -> open the YouTube tab, once per connection, only from the touchpad tab.
    if (!app.ytAutoSwitched && CRYt.isYoutubeUrl(app.url)) {
      app.ytAutoSwitched = true;
      if (app.tab === 'browse') {
        log.info('tab.auto_switch', { to: 'youtube' });
        switchTab('youtube');
      }
    }
    const videoId = CRYt.videoIdOf(app.url);
    if (videoId === app.upNext.videoId) return;
    app.upNext = { videoId, items: [] };
    renderUpNext();
    if (!videoId) return;
    send(CMD.YT_UP_NEXT, { videoId }).then((res) => {
      if (app.upNext.videoId !== videoId) return; // the TV moved on meanwhile
      if (res.ok) app.upNext = { videoId, items: res.data.items };
      renderUpNext();
    });
  };

  document.querySelectorAll('#ytChips button').forEach((b) => b.addEventListener('click', () => openYtRoot(b.dataset.ytSection)));
  $('ytBack').addEventListener('click', popYtView);
  $('ytRetry').addEventListener('click', () => loadYt({ more: Boolean(ytCurrent() && ytCurrent().items.length) }));
  $('ytPlayAll').addEventListener('click', () => {
    const view = ytCurrent();
    if (view && view.section === YT_SECTION.PLAYLIST) act(CMD.YT_OPEN, { playlistId: view.id }).then((res) => res.ok && switchTab('play'));
  });
  $('ytNow').addEventListener('click', () => switchTab('play'));
  // Infinite scroll: fetch the next page well before the end (YT_MORE_SCREENS screens ahead).
  $('ytList').addEventListener('scroll', () => {
    const list = $('ytList');
    if (list.scrollHeight - list.scrollTop - list.clientHeight < list.clientHeight * YT_MORE_SCREENS) loadYt({ more: true });
  }, { passive: true });
  $('ytMenu').addEventListener('click', (e) => {
    if (e.target === $('ytMenu')) closeYtMenu();
  });
  $('ytMenuCancel').addEventListener('click', closeYtMenu);
  $('ytMenuLater').addEventListener('click', async () => {
    const c = app.ytMenu;
    closeYtMenu();
    if (!c) return;
    const res = await act(CMD.YT_WATCH_LATER, { videoId: c.id });
    if (res.ok) toast('已加入稍后观看', 'ok');
  });
  $('ytMenuChannel').addEventListener('click', () => {
    const c = app.ytMenu;
    closeYtMenu();
    if (!c || !c.channelId) return;
    switchTab('youtube');
    if (!app.yt.length) app.yt = [ytView(YT_SECTION.HOME)];
    pushYtView(YT_SECTION.CHANNEL, c.channelId, c.channel);
  });

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
    app.yt = []; // another Chromebook may be signed in to another YouTube account
    app.upNext = { videoId: null, items: [] };
    renderYt();
    renderUpNext();
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
    setChildren($('deviceList'), app.pairings.map((p) => deviceRow(p, { withDelete: true })));
  };

  const renderOffline = () => {
    const show = app.status === 'offline';
    $('offline').hidden = !show;
    if (!show) return;
    $('offlineTitle').textContent = `${deviceLabel(app.pairing)} 不在线`;
    const others = app.pairings.filter((p) => !app.pairing || p.peerId !== app.pairing.peerId);
    $('offlineOthersLabel').hidden = others.length === 0;
    setChildren($('offlineOthers'), others.map((p) => deviceRow(p, { withDelete: false })));
  };

  // -------------------------------------------------------------------------
  // Input: buttons
  // -------------------------------------------------------------------------
  const BUTTON_HOOKS = Object.freeze({
    [CMD.PLAYLIST_STEP]: (res) => {
      if (res.ok && res.data && res.data.label) toast(`正在打开第 ${res.data.label} 集`, 'ok');
    },
    [CMD.BACK]: () => switchTab('browse'), // returning to a list means browsing again
    [CMD.FULLSCREEN]: (res) => {
      if (res.ok && res.data) $('fullscreen').textContent = res.data.fullscreen ? '⛶ 退出全屏' : '⛶ 全屏';
    },
  });

  const onButton = async (btn) => {
    const cmd = btn.dataset.cmd;
    const args = btn.dataset.seconds ? { seconds: Number(btn.dataset.seconds) } : btn.dataset.dir ? { dir: Number(btn.dataset.dir) } : {};
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
  $('playlistRow').addEventListener('click', openPlaylistSheet);
  $('plClose').addEventListener('click', () => closePlaylistSheet('close_button'));
  $('playlistSheet').addEventListener('click', (e) => {
    if (e.target === $('playlistSheet')) closePlaylistSheet('backdrop');
  });
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

  // Gesture logic is source-agnostic: (id, x, y) per finger, fed by Pointer or Touch Events below.
  const padStart = (id, x, y) => {
    if (touches.size === 0) {
      Object.assign(gesture, { startT: performance.now(), moved: 0, multi: false });
      requestAnimationFrame(flush);
    }
    touches.set(id, { x, y, t: performance.now() });
    if (touches.size > 1) gesture.multi = true;
    pad.classList.add('active');
  };

  const padMove = (id, x, y) => {
    const prev = touches.get(id);
    if (!prev) return;
    const now = performance.now();
    const dx = x - prev.x;
    const dy = y - prev.y;
    touches.set(id, { x, y, t: now });
    gesture.moved += Math.abs(dx) + Math.abs(dy);
    if (touches.size >= 2) {
      // Two-finger swipe: content follows the fingers (swipe up = scroll down).
      acc.scroll += (-dy / touches.size) * SCROLL_GAIN;
      return;
    }
    if (gesture.multi) return; // ignore the leftover finger after a scroll gesture
    acc.dx += accel(dx, now - prev.t);
    acc.dy += accel(dy, now - prev.t);
  };

  const padEnd = (id) => {
    if (!touches.delete(id)) return;
    if (touches.size > 0) return;
    pad.classList.remove('active');
    const isTap = !gesture.multi && performance.now() - gesture.startT < TAP_MAX_MS && gesture.moved < TAP_MAX_MOVE_PX;
    if (isTap) {
      if (navigator.vibrate) navigator.vibrate(10);
      act(CMD.CLICK);
    }
  };
  if (ENV.pointerEvents) {
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      padStart(e.pointerId, e.clientX, e.clientY);
    });
    pad.addEventListener('pointermove', (e) => padMove(e.pointerId, e.clientX, e.clientY));
    pad.addEventListener('pointerup', (e) => padEnd(e.pointerId));
    pad.addEventListener('pointercancel', (e) => padEnd(e.pointerId));
  } else {
    // iOS 12: no Pointer Events and no `touch-action`. Touch events stay on the pad once started
    // (implicit capture); preventDefault stops page scroll / zoom (needs a non-passive listener).
    const eachTouch = (fn) => (e) => {
      e.preventDefault();
      Array.prototype.forEach.call(e.changedTouches, (t) => fn(t.identifier, t.clientX, t.clientY));
    };
    const active = { passive: false };
    pad.addEventListener('touchstart', eachTouch(padStart), active);
    pad.addEventListener('touchmove', eachTouch(padMove), active);
    pad.addEventListener('touchend', eachTouch(padEnd), active);
    pad.addEventListener('touchcancel', eachTouch(padEnd), active);
  }

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

  // Flex `gap` arrived in Safari 14.1 and cannot be tested with @supports: measure it once;
  // style.css falls back to margins under .no-flex-gap.
  const flexGap = (() => {
    const box = el('div');
    box.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    box.append(el('div'), el('div'));
    document.body.append(box);
    const ok = box.scrollHeight === 1;
    box.remove();
    return ok;
  })();
  document.documentElement.classList.toggle('no-flex-gap', !flexGap);
  log.info('env.detected', { ...ENV, flex_gap: flexGap, ua: navigator.userAgent.slice(0, 120) });

  // iOS: pairing steps differ (camera -> Safari -> Add to Home Screen).
  $('stepsAndroid').hidden = ENV.ios;
  $('stepsIos').hidden = !ENV.ios;
  $('installHintClose').addEventListener('click', () => {
    localStorage.setItem(STORAGE.installHintOff, '1');
    log.info('pairing.install_hint_closed');
    renderInstall();
  });

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
